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

// 日志异常口径：ERROR/ALERT/WARN、中文「失败」与 failed>0 摘要行都算异常。
export function isIssueLogLine (line) {
  if (typeof line !== 'string') return false
  return /(^|\s)(ERROR|ALERT|WARN)\b/.test(line) || line.includes('失败') || /failed=[1-9]/.test(line)
}

// 日志筛选：mode='issue' 只看异常；query 大小写不敏感地做子串匹配。
// 返回切好的行数组，组件与测试共用同一套「尾部文本 → 行」口径（去末尾空行）。
export function filterLogLines (text, mode, query) {
  const lines = typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
  const kw = typeof query === 'string' ? query.trim().toLowerCase() : ''
  return lines.filter((l) => (mode !== 'issue' || isIssueLogLine(l)) && (kw === '' || l.toLowerCase().includes(kw)))
}
