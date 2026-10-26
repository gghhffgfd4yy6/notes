// scripts/console-assets/pure.mjs —— 控制台纯函数（无 DOM、无第三方依赖）。
//
// 单独成 ESM 模块的目的：前端 app.js 直接 import；Node 侧测试用 dynamic import 做行为断言，
// 不必从 app.js 源码里截字符串再 eval（SonarCloud S1523 视动态执行代码为 Critical Vulnerability）。
// 这里只放可注入时钟/纯输入的判定，任何 DOM 或 fetch 逻辑都不要进来。

export const DAY_MS = 1000 * 60 * 60 * 24

// 回到顶部的滚动方式（v3.321）：开了「减少动效」或宿主没有 scrollBehavior（老 Safari）时
// 返回 null，调用方走 window.scrollTo(0, 0) 瞬时回顶；否则返回 'smooth'。
// 动效开关的纯判定（v3.360）：系统开了「减少动效」就一律不动。
// 单独抽出来是为了能被 Node 直接测（motion.js 依赖 DOM，测不了行为）。
export function motionAllowed (matches) {
  return matches !== true
}

export function backToTopBehavior (reduceMotion, supportsSmooth) {
  return reduceMotion || !supportsSmooth ? null : 'smooth'
}

// 切页用浏览器原生 View Transitions 的能力判定（淡入淡出，零依赖）。
// 三个条件缺一不可：宿主真的实现了 startViewTransition、动效开关为真、根元素在
// （root 快照要挂到 documentElement 上，没有它调用会直接抛）。同名的非函数值也算没有：
// 有些 polyfill/壳浏览器会塞个占位属性，`in` 判断会被骗过去。
// 判定收在这一个出口，调用方只有「原生过渡 / 直接换页」两条路，不必到处 try/catch 或嗅探 UA。
export function canViewTransition (doc, motionOK) {
  return Boolean(doc) && typeof doc.startViewTransition === 'function' &&
    motionOK === true && Boolean(doc.documentElement)
}

// 用一次原生 View Transition 包住「引起主内容重渲染」的那一下（同步触发渲染在回调里跑）。
// 拿不到能力（或用户关了动效）就直接 apply(false) 同步渲染：同一条出口，调用方不必分支。
//
// 为什么回调是 async + 微任务，而不是 rAF：preact 的 setState 在**微任务**里 flush
// （standalone 包的 defer = Promise.prototype.then.bind(Promise.resolve())），所以
// setState 之后 await 一次微任务，续体一定排在这次 flush 后面，DOM 已是新页；浏览器随后
// 抓「新页」快照才对。千万别换成 `await new Promise(r => requestAnimationFrame(r))`：
// 过渡的 DOM update 阶段渲染管线在等这个回调，rAF 被饿死、永远不来，Chrome 4s 后直接
// 「Transition was aborted because of timeout in DOM update」——过渡整段没了，页面还卡 4s
// （已在真实 Chrome 里实测复现）。等待里不碰帧、不碰定时器，就不会有这种死锁。
//
// 约定：
// - apply 只会被调用一次（浏览器中途 abort 或回调被重复触发都不补渲染），入参 true 表示
//   这次渲染由过渡驱动（页面级入场动画据此让位，避免两套淡入叠在一起）。
// - transition.finished 只挂一个吞掉的 catch，**不 await**：连点会 abort 上一段过渡，
//   那是预期路径，等它会把点击卡住，也不该在控制台刷「未处理拒绝」。
// - 更新回调里的异常不吞：updateCallbackDone 不做任何 catch，让它照常冒到
//   console / 错误上报；startViewTransition 自己同步抛错时才补一次普通渲染（切页不能因为
//   过渡起不来而停在旧页）。
export function runViewTransition (doc, motionOK, apply) {
  if (typeof apply !== 'function') return null
  if (!canViewTransition(doc, motionOK)) {
    apply(false)
    return null
  }
  let rendered = false
  const renderOnce = (viaTransition) => {
    if (rendered) return
    rendered = true
    apply(viaTransition)
  }
  let transition = null
  try {
    transition = doc.startViewTransition(async () => {
      renderOnce(true)
      // 两次微任务：第一个让 preact 的 flush 先跑；第二个兜住「渲染里又 setState
      // 再排一次 flush」（切页后 layout effect 补状态就是这种形态）。
      await Promise.resolve()
      await Promise.resolve()
    })
  } catch (e) {
    renderOnce(false)
    return null
  }
  if (transition) {
    // 不阻塞：连点时旧的那段会被 skip / abort，ready 与 finished 都会拒绝——都属预期路径，
    // 只挂空 catch。绝不能 await（会把点击卡住），也不能让它们变成未处理拒绝刷满控制台。
    // 更新回调自己抛的异常走 updateCallbackDone，这里刻意不碰，照常冒到 console / 错误上报。
    for (const key of ['ready', 'finished']) {
      const p = transition[key]
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  }
  return transition || null
}

// 配置页「过滤规则」块的数据口径（v3.312）：显示**实际生效值**，而不是只读代码默认。
// 背景：过滤规则页写的是覆盖文件 filter-rules.json，配置页原先只读 Config.filter ⇒
// 保存成功后两页对不上（用户看到「已保存」，配置页仍全空）。
// 口径与 FilterStore.mergeActiveFilter 一致：覆盖文件优先、缺字段回代码默认（不是置空）。
// overridden 的语义是「该字段由覆盖文件显式提供」——即便值与代码默认相同也算（覆盖文件把它
// 钉住了，后续版本改默认时该实例不会跟随）；只有「文件里没这个键」才回落到默认且不挂徽章。
// 过滤规则保存候选（v3.359）：服务端保存是「整份替换」，所以候选 = 覆盖文件里**已有**的
// 字段 + 本次**改动**的字段（同名字段以本次输入为准）；两者都不是的字段仍不提交——缺字段的
// 语义是「回代码默认」，把当前生效值整份写进去会把代码默认钉死，后续版本改默认时收不到。
// 只提交改动字段则会删掉覆盖文件里原有的其他字段（这就是被修掉的 bug），故两段都不能省。
export function filterOverrideFields (override, fieldNames) {
  const src = override && typeof override === 'object' && !Array.isArray(override) ? override : {}
  const out = {}
  for (const name of Array.isArray(fieldNames) ? fieldNames : []) {
    if (typeof src[name] === 'string') out[name] = src[name]
  }
  return out
}

export function buildSaveCandidate (override, dirtyFields, draft, fieldNames) {
  const candidate = filterOverrideFields(override, fieldNames)
  const src = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {}
  for (const name of Array.isArray(dirtyFields) ? dirtyFields : []) {
    if (src[name] === undefined) continue
    candidate[name] = String(src[name])
  }
  return candidate
}

export function effectiveFilterRows (configFilter, activeFilter) {
  const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  const base = isPlain(configFilter) ? configFilter : {}
  const active = isPlain(activeFilter) ? activeFilter : null
  const norm = (v) => (v === undefined || v === null ? '' : String(v))
  const has = (k) => Boolean(active) && Object.prototype.hasOwnProperty.call(active, k)
  const keys = Object.keys(base)
  if (active) for (const k of Object.keys(active)) if (!keys.includes(k)) keys.push(k)
  return keys.map((key) => ({
    key,
    value: norm(has(key) ? active[key] : base[key]),
    overridden: has(key),
    differs: has(key) && norm(active[key]) !== norm(base[key])
  }))
}

// 配置页过滤规则块的副标题（v3.312）。把「已保存」与「已生效」分开：
// 覆盖文件可能在上一轮跑完之后才保存 ⇒ 页面显示保存的规则（下一轮生效），但不得
// 把文件 revision 说成「已生效」——那会让用户以为本轮已经换规则。
// changedCount 只数「与代码默认不同」的字段（覆盖文件常把未改字段也一并钉住，
// 把「文件里有这个键」当成「改过」会让 11 项全算覆盖，反而看不出真正改了什么）。
export function filterSourceNote (effData, rowCount, changedCount) {
  if (!effData || !Number.isSafeInteger(rowCount)) return ''
  if (effData.source === 'corrupt') return `${rowCount} 项 · 覆盖文件损坏，显示降级值`
  if (effData.source !== 'override') return `${rowCount} 项 · 来自代码默认（未建覆盖文件）`
  const rev = Number.isSafeInteger(effData.revision) ? effData.revision : 0
  const appliedRev = effData.applied && Number.isSafeInteger(effData.applied.revision) ? effData.applied.revision : null
  if (appliedRev !== rev) {
    const tail = appliedRev === null ? '尚未跑过' : `本轮仍用 rev ${appliedRev}`
    return `${rowCount} 项 · 已保存 rev ${rev}（下一轮生效，${tail}）`
  }
  return `${rowCount} 项 · 生效 rev ${rev}（覆盖文件）${changedCount > 0 ? ` · ${changedCount} 项与默认不同` : ''}`
}

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

// 行级着色（v3.317）：ERROR 红、ALERT/WARN 琥珀，其余不着色（'bad' | 'warn' | ''）。
// 控制台生命周期行虽是 ERROR 前缀，但语义是「任务被停掉」，与「异常」口径一致不着色
// （否则每次重启满屏红，正是 v3.307 降噪要去掉的那类噪声）。
export function logLineTone (line) {
  const kind = logLineKind(line)
  if (kind === 'error') return 'bad'
  if (kind === 'alert' || kind === 'warn') return 'warn'
  return ''
}

// 把一段文本按关键字切成 [文本, 是否命中] 片段，交给 <mark> 渲染（v3.317 日志行、v3.328 推送记录标题/正文共用）。
// 大小写不敏感，但绝不拼 innerHTML——用户输入只作为文本节点插入（XSS 面为零）。
// v3.328 两处边界：
// ① maxHits：超长正文里同一个词可能出现上千次，每个命中一个 <mark> 会把「展开」卡住几秒；
//    只切前 maxHits 处，之后的文本整段按普通片段返回（渲染上限，不影响命中总数）。
// ② 小写后长度会变（如 'İ' → 'i̇'）时不再整段放弃高亮：服务端是按小写文本筛的，
//    放弃会让卡片「匹配却没有一个黄块」。改为给小写码元记原文下标，命中区间映射回原文。
export function splitHits (line, kw, maxHits = Infinity) {
  if (typeof line !== 'string' || line.length === 0 || kw === '') return [[line, false]]
  let lower = line.toLowerCase()
  let map = null
  if (lower.length !== line.length) {
    map = []
    let rebuilt = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i].toLowerCase()
      for (let k = 0; k < ch.length; k++) map.push(i)
      rebuilt += ch
    }
    lower = rebuilt
  }
  // 先收命中区间（原文下标），相邻/重叠的合并：一个原文字符可能摊成多个小写码元。
  // maxHits 按「命中次数」计，不按合并后的区间数——否则连续命中会并成一段、永远到不了上限。
  const ranges = []
  let from = 0
  let hits = 0
  let at = lower.indexOf(kw, from)
  while (at !== -1 && hits < maxHits) {
    const start = map ? map[at] : at
    const end = map ? map[at + kw.length - 1] + 1 : at + kw.length
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
    hits += 1
    from = at + kw.length
    at = lower.indexOf(kw, from)
  }
  if (ranges.length === 0) return [[line, false]]
  const out = []
  let pos = 0
  for (const [start, end] of ranges) {
    if (start > pos) out.push([line.slice(pos, start), false])
    out.push([line.slice(start, end), true])
    pos = end
  }
  if (pos < line.length) out.push([line.slice(pos), false])
  return out
}

// 各筛选模式的计数（v3.307）：前端 chips 显示数字，纯函数避免每次渲染把 6 个模式各扫一遍。
// issue = isIssueLogLine；error 只看真正的业务 ERROR，控制台生命周期单独归 console——
// 否则每次启停的「ERROR 控制台停止」会把错误数抬到上百，排障时反而找不到真错误。
// summary = 运行摘要行；console = 控制台生命周期。
export function logLineCounts (text) {
  const lines = typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
  const out = { all: lines.length, issue: 0, error: 0, alert: 0, warn: 0, summary: 0, console: 0 }
  for (const l of lines) {
    if (isIssueLogLine(l)) out.issue += 1
    if (isConsoleLifecycleLine(l)) out.console += 1
    if (!isConsoleLifecycleLine(l) && /(^|\s)ERROR\b/.test(l)) out.error += 1
    if (/(^|\s)ALERT\b/.test(l)) out.alert += 1
    if (/(^|\s)WARN\b/.test(l)) out.warn += 1
    if (/total=\d+ dedup=\d+/.test(l)) out.summary += 1
  }
  return out
}

// 日志筛选：mode='issue' 只看异常（不含控制台生命周期）；error 同样排除生命周期——
// 「错误」是业务错误，不是每次启停的停止记录；query 大小写不敏感地做子串匹配。
// 未知 mode 按 all 处理（宽松，不静默吞行）。
// 返回切好的行数组，组件与测试共用同一套「尾部文本 → 行」口径（去末尾空行）。
export function filterLogLines (text, mode, query) {
  const lines = typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
  const kw = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const isError = (l) => !isConsoleLifecycleLine(l) && /(^|\s)ERROR\b/.test(l)
  const pick = mode === 'issue'
    ? isIssueLogLine
    : mode === 'error'
      ? isError
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
// v3.370 加 search（线报搜索）；filter 仍由 ui.js 的 resolveTab 单独认（历史原因）。
export const TAB_KEYS = ['overview', 'messages', 'search', 'logs', 'config', 'sys']
export function tabFromHash (hash) {
  const m = /^#\/([a-z]+)$/.exec(typeof hash === 'string' ? hash : '')
  return m && TAB_KEYS.includes(m[1]) ? m[1] : 'overview'
}

// 逐轮历史筛选（v3.307）：mode='runs' 只看真实轮次（排除取消留痕）；
// mode='issue' 只看失败/中断/取消；day='YYYY-MM-DD' 只看当天。
// 两个条件是交集；空值不过滤。at 为 '' 的崩溃占位在按天筛选时不展示（无法证明日期）。
export function filterRunItems (items, { mode = 'all', day = '' } = {}) {
  const list = Array.isArray(items) ? items : []
  return list.filter((r) => {
    if (mode === 'runs' && r.cancelled === true) return false
    if (mode === 'issue' && !(r.interrupted === true || r.cancelled === true || (typeof r.failed === 'number' && r.failed > 0))) return false
    if (typeof day === 'string' && day.length === 10) {
      if (typeof r.at !== 'string' || r.at.slice(0, 10) !== day) return false
    }
    return true
  })
}

// 日期区间按钮文案（v3.326）：跨年必须写全两端年份，否则 "12-28 ~ 01-03" 会被读成
// 同一年（甚至同一天）——用户实测在日志页把 2025-10-01 ~ 2026-10-01 看成了一天。
// 同一年且就是今年才省略年份（"10-19 ~ 10-20"），非今年保留起点年份。
export function dateRangeLabel (from, to, todayKey = '') {
  const dayRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
  if (typeof from !== 'string' || typeof to !== 'string') return ''
  if (!dayRe.test(from) || !dayRe.test(to) || from > to) return ''
  const fy = from.slice(0, 4)
  const ty = to.slice(0, 4)
  if (fy !== ty) return `${from} ~ ${to}`
  const thisYear = typeof todayKey === 'string' && todayKey.length >= 4 ? todayKey.slice(0, 4) : ''
  if (thisYear !== '' && fy !== thisYear) return `${from} ~ ${to.slice(5)}`
  return `${from.slice(5)} ~ ${to.slice(5)}`
}

// ── 数据备份加密（v3.356）──────────────────────────────────────────────────
// 目的地：导出文件在浏览器里加密后再下载；导入时也在浏览器里解密后再发服务器。
// 密码只存在于当前页面内存，不进入 URL、日志或请求体。算法固定为 AES-256-GCM，
// 口令派生用 PBKDF2-SHA256（迭代次数写进文件，导入时做上下限校验，防恶意文件拖死浏览器）。
export const BACKUP_ENC_KIND = 'xbk-console-backup-encrypted'
export const BACKUP_ENC_SCHEMA = 1
export const BACKUP_ENC_ITERATIONS = 600000
export const BACKUP_PASSWORD_MIN = 12
const BACKUP_ENC_ITER_MIN = 100000
const BACKUP_ENC_ITER_MAX = 1000000
const BACKUP_ENC_SALT_BYTES = 16
const BACKUP_ENC_IV_BYTES = 12

function backupCrypto () {
  const c = globalThis.crypto
  if (!c || !c.subtle || typeof c.subtle.importKey !== 'function' || typeof c.getRandomValues !== 'function') {
    throw new Error('当前页面不是 HTTPS，浏览器不支持加密；请用 https:// 打开控制台')
  }
  return c
}

function backupPasswordText (password) {
  if (typeof password !== 'string') throw new Error('请输入备份密码')
  if (password.length < BACKUP_PASSWORD_MIN) throw new Error(`密码至少 ${BACKUP_PASSWORD_MIN} 位`)
  if (password.length > 1024) throw new Error('密码太长')
  return password
}

function backupBytesToB64 (bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function backupB64ToBytes (text) {
  if (typeof text !== 'string' || text === '') throw new Error('备份文件的加密字段不完整')
  let binary
  try {
    binary = atob(text)
  } catch (e) {
    throw new Error('备份文件的加密字段损坏')
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function backupEncHeader (iterations, createdAt) {
  return {
    kind: BACKUP_ENC_KIND,
    schema: BACKUP_ENC_SCHEMA,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations },
    cipher: 'AES-GCM',
    createdAt
  }
}

function backupEnvelopeHeader (data) {
  if (!data || typeof data !== 'object' || data.kind !== BACKUP_ENC_KIND) {
    throw new Error('这不是加密的控制台备份文件')
  }
  if (data.schema !== BACKUP_ENC_SCHEMA) throw new Error('备份文件的加密版本不支持')
  const kdf = data.kdf
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') throw new Error('备份文件的口令派生参数不支持')
  const iterations = kdf.iterations
  if (!Number.isInteger(iterations) || iterations < BACKUP_ENC_ITER_MIN || iterations > BACKUP_ENC_ITER_MAX) {
    throw new Error('备份文件的口令派生强度不合法')
  }
  if (data.cipher !== 'AES-GCM') throw new Error('备份文件的加密算法不支持')
  if (typeof data.createdAt !== 'string' || data.createdAt.length < 10 || data.createdAt.length > 64) {
    throw new Error('备份文件的创建时间字段不合法')
  }
  return backupEncHeader(iterations, data.createdAt)
}

function backupAad (header) {
  return new TextEncoder().encode(JSON.stringify(header))
}

async function backupDeriveKey (password, salt, iterations) {
  const c = backupCrypto()
  const material = await c.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return c.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export function isEncryptedBackup (data) {
  return Boolean(data) && typeof data === 'object' && data.kind === BACKUP_ENC_KIND
}

export function backupPasswordProblem (password, confirmation) {
  if (typeof password !== 'string' || password.length < BACKUP_PASSWORD_MIN) {
    return `密码至少 ${BACKUP_PASSWORD_MIN} 位`
  }
  if (password.length > 1024) return '密码太长'
  if (typeof confirmation === 'string' && password !== confirmation) return '两次输入的密码不一致'
  return ''
}

export async function encryptBackup (bundle, password) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('没有可加密的备份内容')
  const pass = backupPasswordText(password)
  const c = backupCrypto()
  const salt = c.getRandomValues(new Uint8Array(BACKUP_ENC_SALT_BYTES))
  const iv = c.getRandomValues(new Uint8Array(BACKUP_ENC_IV_BYTES))
  const header = backupEncHeader(BACKUP_ENC_ITERATIONS, new Date().toISOString())
  let plain
  try {
    plain = new TextEncoder().encode(JSON.stringify(bundle))
  } catch (e) {
    throw new Error('备份内容无法序列化')
  }
  let ciphertext
  try {
    const key = await backupDeriveKey(pass, salt, BACKUP_ENC_ITERATIONS)
    ciphertext = new Uint8Array(await c.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: backupAad(header) },
      key,
      plain
    ))
  } catch (e) {
    throw new Error('浏览器加密失败，请换最新版 Chrome/Safari 再试')
  }
  return {
    ...header,
    salt: backupBytesToB64(salt),
    iv: backupBytesToB64(iv),
    ciphertext: backupBytesToB64(ciphertext)
  }
}

export async function decryptBackup (data, password) {
  const pass = backupPasswordText(password)
  const header = backupEnvelopeHeader(data)
  const salt = backupB64ToBytes(data.salt)
  const iv = backupB64ToBytes(data.iv)
  const ciphertext = backupB64ToBytes(data.ciphertext)
  if (salt.length !== BACKUP_ENC_SALT_BYTES || iv.length !== BACKUP_ENC_IV_BYTES || ciphertext.length < 16) {
    throw new Error('备份文件的加密字段长度不对')
  }
  const c = backupCrypto()
  let plain
  try {
    const key = await backupDeriveKey(pass, salt, header.kdf.iterations)
    plain = await c.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: backupAad(header) },
      key,
      ciphertext
    )
  } catch (e) {
    throw new Error('密码不对，或者备份文件被改过')
  }
  let bundle
  try {
    bundle = JSON.parse(new TextDecoder().decode(plain))
  } catch (e) {
    throw new Error('解密后的内容不是有效备份')
  }
  if (!bundle || bundle.kind !== 'xbk-console-backup' || bundle.schema !== 1 || !bundle.data || typeof bundle.data !== 'object') {
    throw new Error('解密后的内容不是控制台备份')
  }
  return bundle
}

// 弹窗从触发点长出来时用的几何：把面板矩形映射到触发元素中心。
// 等比缩放（宽度比，夹在 0.16~1）——非等比会把文字压扁；面板量不到尺寸时返回 null，
// 调用方退回中心缩放。纯函数，便于直接断言。
export function morphFrom (src, box) {
  if (!src || !box) return null
  if (!(box.width > 0) || !(box.height > 0) || !(src.width > 0) || !(src.height > 0)) return null
  const s = Math.max(0.16, Math.min(1, src.width / box.width))
  return {
    dx: Math.round(src.left + src.width / 2 - (box.left + box.width / 2)),
    dy: Math.round(src.top + src.height / 2 - (box.top + box.height / 2)),
    s
  }
}

// ── 全站 SSE 通知（v3.374）───────────────────────────────────────────────────
// 轮询间隔的纯判定：SSE 连上（sseUp）时 15s 轮询没有意义，降成 60s 安全轮询——它只兜
// 「漏帧 / 长时间无变化」，实时性由 tick 承担；任务在跑仍按 POLL_BUSY_MS 快轮询（日志要跟手）。
export function pollIntervalFor ({ sseUp, busy, pollMs, busyMs, safetyMs }) {
  if (busy) return busyMs
  return sseUp ? safetyMs : pollMs
}

// 通知流的状态机：连流 / 收 tick / 断线降级 / 隐藏断开 / 可见重连。DOM 与构造器全部注入，
// 所以本模块仍然是「无 DOM、无 fetch」——Node 测试塞假 EventSource + 假 document 就能
// 跑真实行为断言（不必 eval 源码，S1523）。
// 纪律（与 /api/runs/stream 的详情流同口径）：
//   · 同一时刻只有一个 EventSource——open() 幂等，重复调用不会再建一条；
//   · onerror 不立刻 close：原生 EventSource 正在自动重连（readyState=CONNECTING）且未超
//     次数时先交给浏览器（它有退避与续传），超过 maxRetry 才降级；
//   · 降级/隐藏/卸载都必经 close()：清引用 + 关闭连接 + 通知调用方（轮询回到 15s）。
export function createLiveChannel (options = {}) {
  const {
    EventSourceCtor,
    doc,
    url = '/api/stream',
    maxRetry = 3,
    onTick = () => {},
    onChange = () => {}
  } = options
  let es = null
  let retries = 0
  let up = false
  let disposed = false
  const set = (next) => {
    if (next === up) return
    up = next
    onChange(up)
  }
  const visible = () => !doc || doc.visibilityState !== 'hidden'
  // EventSource.CONNECTING === 0（规范常量）。宿主没给构造器常量时按 0 兜底——它与
  // 「正在自动重连」同义，宁可多给浏览器一次机会，也不在重连窗口里提前降级。
  const connectingState = () => {
    const c = EventSourceCtor && EventSourceCtor.CONNECTING
    return typeof c === 'number' ? c : 0
  }
  const close = () => {
    const cur = es
    es = null
    retries = 0
    if (cur !== null) {
      try { cur.close() } catch (e) { /* 已断开 */ }
    }
    set(false)
  }
  const open = () => {
    if (disposed || es !== null) return false
    if (typeof EventSourceCtor !== 'function' || !visible()) return false
    let src
    try { src = new EventSourceCtor(url) } catch (e) { return false }
    es = src
    src.onopen = () => { retries = 0; set(true) }
    // 服务端 tick 是具名事件（event: tick），onmessage 收不到——与详情流 reset/done 同一条纪律。
    src.addEventListener('tick', () => { retries = 0; set(true); onTick() })
    src.onerror = () => {
      if (src !== es) return // 已被关闭/替换的旧连接：迟到的 error 不得影响当前状态
      retries += 1
      if (retries <= maxRetry && src.readyState === connectingState()) return
      close()
    }
    return true
  }
  const onVisibility = () => {
    if (disposed) return
    if (!visible()) { close(); return }
    // 回到前台立刻重连并补拉一次：隐藏期间漏的帧不会补发（这条流不带游标）。
    if (open()) onTick()
  }
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility)
  const dispose = () => {
    disposed = true
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility)
    close()
  }
  return { open, close, dispose, isOpen: () => es !== null, isUp: () => up }
}
