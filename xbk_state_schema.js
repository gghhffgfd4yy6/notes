'use strict'

// ── 状态 schema 与派生口径的**唯一真源**（S2）───────────────────────────────
// 同一份状态/日志此前有两套读法：生产写入（xbk_app.js 的 _normalizeReportState /
// _loadReportState / run() 末尾的 run.log 摘要行）与读侧（scripts/status.js 的 validReport /
// isValidReportDate / REPORT_COUNTERS / RUN_SUMMARY_LINE_RE / parseRunStats / readTrends）。
// 两处注释都写着「镜像实现，改任一处必须同步另一处」——那正是漂移源：口径一旦分叉，同一份
// report.state 会在生产侧判「损坏」、在 --status 里显示「正常」。
//
// 本模块把四组定义收成一份：
//   ① report.state 的七项计数名单 / date 合法性 / pending 段校验 / blank + normalize；
//   ② channel-health.state 单条记录的校验与逐条容错语义；
//   ③ run.log 摘要行的**同一份**正则、解析与格式化（写入格式与解析口径不许各写一套）；
//   ④ 基于同一解析器的派生统计（今日/近 7 天）。
//
// 纪律（违反即回到双份实现）：
//   - 纯函数、无副作用、不做文件 I/O、不 require xbk_app / scripts/status / scripts/console
//     （只向下依赖 xbk_utils 的纯函数 shanghaiDayKey）；否则 status.js 的只读命令会被迫拉起
//     整个 App 依赖，而 xbk_app 与本模块之间会形成反向依赖。
//   - 磁盘格式/输出文案**逐字不变**：这里是重构，不是改口径。任何字段名、默认值、可选片段
//     的拼接顺序都照抄原实现（见各处注释里的原始出处）。

const { shanghaiDayKey } = require('./xbk_utils')

// 日报/累计计数器的**唯一**名单（原 xbk_app.js C1-014 常量与 scripts/status.js 的
// REPORT_COUNTERS 镜像合并）。新增计数器只改这里——清零、归一化、状态校验、跨天结转全部由它派生。
// 原实现把同一串 7 个名字在 9 处各写一遍（_blankReportState 的字面量、_normalizeReportState /
// _loadReportState 的校验循环、_updateReport 的 reportKeys、两处 nextState 字面量与 Object.assign
// 映射…），加字段必漏一处：漏掉 _normalizeReportState 的那处会静默丢计数（它只搬名单内的键，
// 写盘时新字段直接消失）。
const REPORT_COUNTERS = Object.freeze(['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated'])

// 非负安全整数判定：读侧（schema 校验）用严格口径——数字字符串/布尔一律算非法，
// 与生产侧 _loadReportState 的 `Number.isSafeInteger(raw[k]) && raw[k] >= 0` 逐字一致。
function isValidCounter (value) {
  return Number.isSafeInteger(value) && value >= 0
}

// 写侧归一化口径（原 xbk_app._safeCounter）：缺失/非数/负数/超界/布尔一律归 0，
// 数字字符串按数值接受。与 isValidCounter 是**两种**口径，不要合并——前者是「文件非法」，
// 后者是「内存里尽力取值」，混用会让旧文件里能读的计数被清零。
function safeCounter (value) {
  if (typeof value === 'symbol') return 0 // Number(Symbol) 抛 TypeError（子代理审查 commit-12）
  const n = Number(value)
  return typeof value !== 'boolean' && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0
}

// 普通对象判定（非 null / 非数组）：report.state 顶层、pending 段、通道记录共用同一口径。
function isPlainRecord (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 空累计（原 xbk_app._blankReportState）：date 在前、七项计数按 REPORT_COUNTERS 顺序补 0。
// 键顺序进 JSON.stringify ⇒ 顺序本身是磁盘格式的一部分，不要「顺手」重排。
function blankReportState () {
  const state = { date: '' }
  for (const key of REPORT_COUNTERS) state[key] = 0
  return state
}

// 跨天结转用的名单搬运（原 xbk_app.pickCounters）：`(source && source[key]) || 0` 与旧实现
// 逐字一致（非数/缺字段/0 都归 0；负数不在这里修——调用方的来源已被 normalizeReportState 归一）。
function pickReportCounters (source) {
  const counters = {}
  for (const key of REPORT_COUNTERS) counters[key] = (source && source[key]) || 0
  return counters
}

// 日报日期口径（原 xbk_app._isValidReportDate 与 scripts/status.js.isValidReportDate 的镜像合并）：
//   - undefined / '' 合法（生产侧同样接受缺失与空串，normalizeReportState 归一化为 ''）；
//   - 存在的值必须是 YYYY-MM-DD 且月/日真实存在（含闰年天数）。
// 不校验「是否未来日期」：那是派生统计的窗口过滤职责（见 deriveRunStats）。
function isValidReportDate (value) {
  if (value === '') return true
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

// report.state 整份校验（原 xbk_app._loadReportState 的逐条 throw 与其读侧镜像 validReport /
// validPendingReport 合并）。返回 { ok: true } | { ok: false, error }：
//   - error 文案照抄生产侧旧 throw 的消息（--status 与生产日志都靠它定位，逐字不变）；
//   - 七项计数只在字段存在时校验（缺失视为未累计，normalizeReportState 会补 0）；
//   - pending 缺失合法；存在时必须是普通对象，且其内部计数同口径校验。
function validateReportState (raw) {
  if (!isPlainRecord(raw)) return { ok: false, error: '日报状态顶层必须是对象' }
  if (raw.date !== undefined && !isValidReportDate(raw.date)) {
    return { ok: false, error: '日报状态 date 字段无效' }
  }
  for (const key of REPORT_COUNTERS) {
    if (raw[key] !== undefined && !isValidCounter(raw[key])) {
      return { ok: false, error: `日报状态字段 ${key} 无效` }
    }
  }
  if (raw.pending !== undefined) {
    if (!isPlainRecord(raw.pending)) return { ok: false, error: '日报状态 pending 字段无效' }
    for (const key of REPORT_COUNTERS) {
      if (raw.pending[key] !== undefined && !isValidCounter(raw.pending[key])) {
        return { ok: false, error: `日报 pending 字段 ${key} 无效` }
      }
    }
  }
  return { ok: true }
}

// pending 段是否需要「已重置为空累计」告警：与 validateReportState 的 pending 分支同条件，
// 但只回答「归一化会不会丢弃跨天累计」。抽成纯谓词是为了让告警留在生产侧 wrapper（本模块无副作用），
// 归一化结果与告警条件仍出自同一处定义。
function reportPendingNeedsReset (raw) {
  return isPlainRecord(raw) && Boolean(raw.pending) && !isPlainRecord(raw.pending)
}

// 状态归一化（原 xbk_app._normalizeReportState，逐字段一致）：
//   - 非对象/数组 → 空累计；
//   - date 非字符串 → ''；
//   - 七项计数走 safeCounter；
//   - pending 为普通对象 → 逐字段归一；为其它**真值** → 空累计占位（调用方据此大声告警）；
//     为 falsy/缺失 → 不设 pending 键（旧实现同样不凭空造这个键，_updateReport 靠 'pending' in /
//     pickReportCounters 的 undefined 兜底）。
function normalizeReportState (raw) {
  if (!isPlainRecord(raw)) return blankReportState()
  const state = blankReportState()
  state.date = typeof raw.date === 'string' ? raw.date : ''
  for (const key of REPORT_COUNTERS) state[key] = safeCounter(raw[key])
  if (isPlainRecord(raw.pending)) {
    state.pending = blankReportState()
    for (const key of REPORT_COUNTERS) state.pending[key] = safeCounter(raw.pending[key])
  } else if (raw.pending) {
    // pending 存在但非普通对象（状态文件损坏/结构异常）：不能静默丢弃跨天累计，
    // 保留其占位并（由生产侧 wrapper）大声告警，让下游按 blankState 处理而不崩溃。
    state.pending = blankReportState()
  }
  return state
}

// 单条通道记录的口径（原 scripts/status.js.validChannelEntry）：必须是普通对象且三个计数均为
// 非负安全整数（缺失/类型错即该条损坏）。
function isValidChannelHealthEntry (entry) {
  return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) &&
    isValidCounter(entry.consecutiveFailures) && isValidCounter(entry.lastFailureAt) && isValidCounter(entry.lastAlertAt)
}

// channel-health.state 整表校验（原 scripts/status.js.validChannels，逐条容错语义不变）：
//   - 空表（{}）→ ok，展示「暂无记录」；
//   - 至少有一条合格记录 → ok，展示侧逐条过滤并报告被忽略的损坏条数；
//   - 有记录且无一合格 → invalid（整表确实不可读，不假装「暂无记录」）。
// 旧实现 Object.values(value).every(...) 是「任一条目损坏即整表 invalid」，一条坏记录会让所有
// 健康通道信息一并消失（--status 只显示「不可读（invalid）」）——不要退回那个口径。
function validateChannelHealth (value) {
  if (!isPlainRecord(value)) return false
  const entries = Object.values(value)
  return entries.length === 0 || entries.some(isValidChannelHealthEntry)
}

// run.log 摘要行正则——**唯一**一份（原 scripts/status.js 的 RUN_SUMMARY_LINE_RE；写入侧的格式
// 字符串与本正则的分组语义必须同时对得上，否则「写得进去、读不出来」）。
// 分组 1 = 行首完整时间戳（本地 `YYYY-MM-DD HH:MM:SS` 或历史 ISO，含其后可能的分段后缀），
// 2..7 = 六项计数（total/dedup/filtered/truncated/pushed/failed），8 = elapsed。
// 需要「日历日」的调用方一律用 `m[1].slice(0, 10)` 派生（parse 结果的 day 字段已按此算好）。
// 行首锚定：ERROR/ALERT 行文本里恰好含 ` total=` 子串时不得误命中。
const RUN_SUMMARY_LINE_RE = /^((?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*) )?total=(\d+) dedup=(\d+) filtered=(\d+) truncated=(\d+) pushed=(\d+) failed=(\d+) elapsed=(\S+)/

// 摘要行尾部的可选附加字段（写入侧 xbk_app.js 按条件输出）：cachesaved=(0|1) /
// noidentity=N / dry-run未推送=N / bad=N / similar=N / similarlogged=N / similardrop=N。
// 零正则的线性尾部扫描（原 scripts/status.js.runParseExtras）：只锚定「最后一个数值 token 边界」，
// 与原正则捕获语义逐分支等价，且对任意行输入保证 O(行尾段) 单遍（Sonar S8786：可选组链
// `(?: …)?(?: …)?` 有超线性回溯形态）。窗口固定为末 64 字符——历史行里 similar 系列排在
// cachesaved 之后时会落在窗口外，这是既有口径（读侧只做展示，不参与聚合），不要「顺手」放宽。
function parseRunSummaryExtras (line) {
  const tail = line.length > 64 ? line.slice(-64) : line
  const grab = (tag) => {
    const at = tail.lastIndexOf(' ' + tag + '=')
    if (at < 0) return null
    const start = at + tag.length + 2
    let end = start
    while (end < tail.length && tail.charCodeAt(end) >= 48 && tail.charCodeAt(end) <= 57) end++
    if (end === start) return null
    return Number(tail.slice(start, end))
  }
  const cachesaved = grab('cachesaved')
  const noidentity = grab('noidentity')
  const dryRun = tail.indexOf('dry-run未推送=') >= 0 ? grab('dry-run未推送') : null
  const bad = grab('bad')
  const similar = grab('similar')
  const similarlogged = grab('similarlogged')
  const similardrop = grab('similardrop')
  return { cachesaved, noidentity, dryRun, bad, similar, similarlogged, similardrop }
}

// 摘要行解析（原 scripts/status.js.parseLastRun / readTrends / readRunHistory / parseRunStats
// 各自 exec 同一正则的四份内联逻辑合并）。返回 null 表示「这一行不是合格摘要行」：
// 行首不匹配，或六项计数经 Number 后不是非负安全整数（超长数字 → Infinity/超界，整行跳过，
// 与 parseDiagnostics 同口径）。
function parseRunSummaryLine (line) {
  if (typeof line !== 'string') return null
  const m = RUN_SUMMARY_LINE_RE.exec(line)
  if (!m) return null
  const values = [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number)
  if (!values.every(isValidCounter)) return null
  return {
    // 分组 1 含尾部空格（正则把分隔空格算进捕获组），读数一律 trim，与原 parseLastRun 一致。
    at: m[1] ? m[1].trim() : '',
    // 日历日：整段戳取前 10 位（C10-057 口径，不得改用本地 Date 解析）。
    day: m[1] ? m[1].slice(0, 10) : '',
    counters: {
      total: values[0],
      dedup: values[1],
      filtered: values[2],
      truncated: values[3],
      pushed: values[4],
      failed: values[5]
    },
    elapsed: m[8],
    extras: parseRunSummaryExtras(line)
  }
}

// 摘要行格式化（原 xbk_app.js run() 末尾那条模板字符串，逐字等价）：
// `${stamp} total=… dedup=… filtered=… truncated=… pushed=… failed=… elapsed=…` 后按固定顺序
// 拼可选片段。stamp 由调用方传入（_localStamp() 是 Asia/Shanghai 的进程时钟，不进纯模块）；
// elapsed 传**原样 token**（生产侧传 `${elapsed}s`，含单位）。
// 可选片段顺序与条件逐条照抄生产：
//   ① dry-run 且未推送 > 0 才写 dry-run未推送；② noidentity/bad/similar/similarlogged/similardrop
//   只在 > 0 时写；③ cachesaved 仅在非 dry-run 时写，取 truthy→1/else→0。
function formatRunSummaryLine ({ stamp = '', counters = {}, elapsed = '', extras = {} } = {}) {
  const dryRun = extras.dryRun === true
  const tail = [
    dryRun && extras.dryRunUnpushed > 0 ? ` dry-run未推送=${extras.dryRunUnpushed}` : '',
    extras.noidentity > 0 ? ` noidentity=${extras.noidentity}` : '',
    extras.bad > 0 ? ` bad=${extras.bad}` : '',
    dryRun ? '' : ` cachesaved=${extras.cachesaved ? 1 : 0}`,
    extras.similar > 0 ? ` similar=${extras.similar}` : '',
    extras.similarlogged > 0 ? ` similarlogged=${extras.similarlogged}` : '',
    extras.similardrop > 0 ? ` similardrop=${extras.similardrop}` : ''
  ].join('')
  return `${stamp} total=${counters.total} dedup=${counters.dedup} filtered=${counters.filtered} ` +
    `truncated=${counters.truncated} pushed=${counters.pushed} failed=${counters.failed} elapsed=${elapsed}${tail}`
}

// 首屏「今日 / 近 7 天」聚合（原 scripts/status.js.parseRunStats，同源同口径）：
//   - 与趋势同源（摘要行 + Asia/Shanghai 日历日，run.log 的戳由生产侧固定按上海写）；
//   - today/week 的 successRate = pushed/(pushed+failed)，无尝试时 null（前端显示「—」）；
//   - lastFailure 是近 7 天窗口内最近一条 failed>0 的摘要（首屏异常横幅的「看日志」跳转）；
//   - 未来日期（时钟回拨/手写 fixture/坏摘要）一律排除，否则周汇总与 lastFailure 会被推高；
//   - truncated 由调用方按日志读取窗口传入（尾部 1 MiB 窗口外可能还有本日/本周摘要，此时前端
//     必须标注「仅统计日志尾部」，不得把少算的总数当完整数据展示）。
function deriveRunStats (lines, now = Date.now(), { truncated = false } = {}) {
  const todayKey = shanghaiDayKey(now)
  const weekStartKey = shanghaiDayKey(now - 6 * 86400000)
  const blank = (date) => ({ date, rounds: 0, total: 0, pushed: 0, failed: 0 })
  const today = blank(todayKey)
  const week = { from: weekStartKey, to: todayKey, rounds: 0, total: 0, pushed: 0, failed: 0 }
  let lastFailure = null
  for (const line of lines) {
    const parsed = parseRunSummaryLine(line)
    if (!parsed) continue
    const day = parsed.day
    if (!day || day < weekStartKey || day > todayKey) continue
    const counters = parsed.counters
    week.rounds += 1
    week.total += counters.total
    week.pushed += counters.pushed
    week.failed += counters.failed
    if (day === todayKey) {
      today.rounds += 1
      today.total += counters.total
      today.pushed += counters.pushed
      today.failed += counters.failed
    }
    if (counters.failed > 0) {
      // at 取行首 19 字符（与旧实现逐字一致）：无时间戳的行得到空串，前端按「未知」展示。
      lastFailure = { at: line.slice(0, 19).trim(), date: day, failed: counters.failed }
    }
  }
  const rate = (pushed, failed) => (pushed + failed > 0 ? pushed / (pushed + failed) : null)
  return {
    today: { ...today, successRate: rate(today.pushed, today.failed) },
    week: { ...week, successRate: rate(week.pushed, week.failed) },
    lastFailure,
    truncated: truncated === true
  }
}

module.exports = {
  REPORT_COUNTERS,
  isValidCounter,
  safeCounter,
  blankReportState,
  pickReportCounters,
  isValidReportDate,
  validateReportState,
  reportPendingNeedsReset,
  normalizeReportState,
  isValidChannelHealthEntry,
  validateChannelHealth,
  RUN_SUMMARY_LINE_RE,
  parseRunSummaryExtras,
  parseRunSummaryLine,
  formatRunSummaryLine,
  deriveRunStats
}
