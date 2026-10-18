// scripts/console-assets/pure.mjs —— 控制台纯函数（无 DOM、无第三方依赖）。
//
// 单独成 ESM 模块的目的：前端 app.js 直接 import；Node 侧测试用 dynamic import 做行为断言，
// 不必从 app.js 源码里截字符串再 eval（SonarCloud S1523 视动态执行代码为 Critical Vulnerability）。
// 这里只放可注入时钟/纯输入的判定，任何 DOM 或 fetch 逻辑都不要进来。

export const DAY_MS = 1000 * 60 * 60 * 24

// 「多久以前」：负数（时钟漂移/文件时间在未来）按 0 处理，显示「刚刚」。
export function fmtAge (ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const min = Math.floor(Math.max(0, ms) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

// 日报日期相对今天：日报状态只在跑过一轮后更新，凌晨打开时「今日日报 10-17」会误导
// （今天已经是 10-18）。统一按 Asia/Shanghai 日历日算，与服务端 today/run.log 同口径。
export function relDay (dateStr, nowMs = Date.now()) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  const target = Date.UTC(y, m - 1, d)
  const now = new Date(Number(nowMs) + 8 * 3600 * 1000)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const gap = Math.round((today - target) / DAY_MS)
  if (!Number.isFinite(gap) || gap < 0) return ''
  if (gap === 0) return '今天'
  if (gap === 1) return '昨天'
  return `${gap} 天前`
}

// 缓存写入状态：ageText 用于展示，stale 只在超过 24h 时为真。
// 语义边界：push.json 在每轮保存时都会写入（含全量去重轮），但它不是推送心跳的替代品——
// 文案只陈述「超过 24 小时未写入缓存」，不推断链路断没断（调度暂停同样会造成该状态）。
export function cacheWriteInfo (mtimeMs, nowMs = Date.now()) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return { ageMs: null, ageText: '', stale: false }
  }
  const ageMs = Math.max(0, Number(nowMs) - mtimeMs)
  return { ageMs, ageText: fmtAge(ageMs), stale: ageMs > DAY_MS }
}

// 控制台生命周期行（v3.307）：重启/切分支时控制台自己写的「控制台停止：任务 …」不是
// 推送轮次失败。旧口径把它算进「异常」，实测 178 行日志里 123 条异常有 119 条是它，
// 真异常只剩 4 条——默认异常视图必须去掉这类噪声，另设「控制台」筛选保留可查。
export function isConsoleLifecycleLine (line) {
  return typeof line === 'string' && line.includes('控制台停止：任务 #')
}

// 日志异常口径：ERROR/ALERT/WARN、中文「失败」与 failed>0 摘要行都算异常。
// 控制台生命周期行不算（它只是一个任务被停止，不是这一轮运行失败）。
export function isIssueLogLine (line) {
  if (typeof line !== 'string') return false
  if (isConsoleLifecycleLine(line)) return false
  return /(^|\s)(ERROR|ALERT|WARN)\b/.test(line) || line.includes('失败') || /failed=[1-9]/.test(line)
}

// 单行分类（v3.307 日志级别筛选）：console 优先于 error——「控制台停止」行虽然带 ERROR
// 前缀，但语义是控制台生命周期，不能混进「错误」视图（否则异常降噪白做）。
export function logLineKind (line) {
  if (typeof line !== 'string') return 'info'
  if (isConsoleLifecycleLine(line)) return 'console'
  if (/(^|\s)ALERT\b/.test(line)) return 'alert'
  if (/(^|\s)ERROR\b/.test(line)) return 'error'
  if (/(^|\s)WARN\b/.test(line)) return 'warn'
  if (/total=\d+ dedup=\d+/.test(line)) return 'summary'
  return 'info'
}

// 各筛选模式的计数（v3.307）：前端 chips 显示数字，纯函数避免每次渲染把 6 个模式各扫一遍。
// issue = isIssueLogLine（不含控制台生命周期）；error/alert 按原始级别统计（error 含生命周期，
// 因为「错误」就是按级别看）；summary = 运行摘要行；console = 控制台生命周期。
export function logLineCounts (text) {
  const lines = typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
  const out = { all: lines.length, issue: 0, error: 0, alert: 0, warn: 0, summary: 0, console: 0 }
  for (const l of lines) {
    if (isIssueLogLine(l)) out.issue += 1
    if (isConsoleLifecycleLine(l)) out.console += 1
    if (/(^|\s)ERROR\b/.test(l)) out.error += 1
    if (/(^|\s)ALERT\b/.test(l)) out.alert += 1
    if (/(^|\s)WARN\b/.test(l)) out.warn += 1
    if (/total=\d+ dedup=\d+/.test(l)) out.summary += 1
  }
  return out
}

// 日志筛选：mode='issue' 只看异常（不含控制台生命周期）；其余级别模式按行首级别匹配；
// query 大小写不敏感地做子串匹配。未知 mode 按 all 处理（宽松，不静默吞行）。
// 返回切好的行数组，组件与测试共用同一套「尾部文本 → 行」口径（去末尾空行）。
export function filterLogLines (text, mode, query) {
  const lines = typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
  const kw = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const pick = mode === 'issue'
    ? isIssueLogLine
    : mode === 'error'
      ? (l) => /(^|\s)ERROR\b/.test(l)
      : mode === 'alert'
        ? (l) => /(^|\s)ALERT\b/.test(l)
        : mode === 'summary'
          ? (l) => /total=\d+ dedup=\d+/.test(l)
          : mode === 'console'
            ? isConsoleLifecycleLine
            : () => true
  return lines.filter((l) => pick(l) && (kw === '' || l.toLowerCase().includes(kw)))
}

// 运行时间戳（run.log 的「YYYY-MM-DD HH:MM:SS」，Asia/Shanghai）→ 相对现在多久。
// 解析失败返回 ''（不编「刚刚」）；未来时间按 0 处理（fmtAge 自身口径）。
export function ageFromStamp (stamp, nowMs = Date.now()) {
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)) return ''
  const ms = Date.parse(stamp.replace(' ', 'T') + '+08:00')
  if (!Number.isFinite(ms)) return ''
  return fmtAge(Number(nowMs) - ms)
}

// 标签页哈希（v3.307）：刷新/后退不丢当前页。只认白名单，非法 hash 回概览。
export const TAB_KEYS = ['overview', 'messages', 'logs', 'config', 'sys']
export function tabFromHash (hash) {
  const m = /^#\/([a-z]+)$/.exec(typeof hash === 'string' ? hash : '')
  return m && TAB_KEYS.includes(m[1]) ? m[1] : 'overview'
}

// 逐轮历史筛选（v3.307）：mode='issue' 只看失败/中断；day='YYYY-MM-DD' 只看当天。
// 两个条件是交集；空值不过滤。at 为 '' 的崩溃占位在按天筛选时不展示（无法证明日期）。
export function filterRunItems (items, { mode = 'all', day = '' } = {}) {
  const list = Array.isArray(items) ? items : []
  return list.filter((r) => {
    if (mode === 'issue' && !(r.interrupted === true || r.cancelled === true || (typeof r.failed === 'number' && r.failed > 0))) return false
    if (typeof day === 'string' && day.length === 10) {
      if (typeof r.at !== 'string' || r.at.slice(0, 10) !== day) return false
    }
    return true
  })
}
