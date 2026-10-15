'use strict'

const path = require('node:path')
const { readSafeTextResult } = require('../xbk_storage')

const FILES = {
  run: 'run.log',
  report: 'report.state',
  channels: 'channel-health.state',
  diagnostics: 'filter-diagnostics.ndjson',
  messages: 'push.json'
}

function result (status, value) {
  return { status, ...(value === undefined ? {} : { value }) }
}

// 上海日历日（YYYY-MM-DD）：run.log 的时间戳由生产侧 _localStamp 固定按 Asia/Shanghai 写，
// 趋势窗口/输出键必须用同一日历日，否则宿主为 UTC（本机就是）时每天 00:00–08:00 的轮次
// 会被算进前一天/后一天（审查 Sourcery PR#227）。fixed offset +8：上海无夏令时，恒定偏移安全。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
function shanghaiDayKey (ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

// 日志类部件（run.log / filter-diagnostics.ndjson）的读取上限与取尾部选项（审查 SS-03）。
// 上限与写入侧 xbk_app 的截尾阈值同为 1 MiB，但写入侧在拿不到日志锁时是 fail-open（只追加、
// 不截尾），文件可以真正超过 1 MiB；旧行为对超限文件一律返回 tooLarge，于是「最近一轮」「过滤诊断」
// 整体变成「不可读（tooLarge）」。日志消费方只关心最近的记录，故超限时读尾部 1 MiB。
const LOG_MAX_BYTES = 1024 * 1024
const LOG_READ_OPTIONS = { tail: true }

function readText (dir, name, maxBytes = LOG_MAX_BYTES, options) {
  const safe = readSafeTextResult(path.join(dir, name), maxBytes, options)
  return safe.status === 'ok' ? result('ok', safe.text) : result(safe.status)
}

function validCounter (value) {
  return Number.isSafeInteger(value) && value >= 0
}

// 日报日期口径：与生产侧 xbk_app._isValidReportDate **语义一致**（审查 SS-04）。生产读路径
// （_loadReportState）对存在且非法的 date 直接判「状态损坏、跳过本次日报更新」，而 --status 此前
// 只校验类型，于是 '2026-13-45' 会被当成正常日报展示——同一份文件两处口径相反。此处补齐：
//   - undefined / '' 合法（生产侧同样接受缺失与空串，_normalizeReportState 归一化为 ''）；
//   - 存在的值必须是 YYYY-MM-DD 且月/日真实存在（含闰年天数）。
// 口径以 xbk_app.js 的同名方法为准；两处是镜像实现（scripts/status.js 不引 xbk_app，避免只读命令
// 拉起整个 App 依赖），修改任一处必须同步另一处。
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

// 日报状态里的七项计数（与生产侧 xbk_app._loadReportState / _normalizeReportState 的字段清单逐一对应；
// 两处是镜像实现，改任一处必须同步另一处）。
const REPORT_COUNTERS = ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']

// 日报「本轮待累计」段（pending）的口径：与生产侧 _loadReportState 的 `raw.pending` 分支**逐条对齐**
// （xbk_app.js 的「日报状态 pending 字段无效」/「日报 pending 字段 … 无效」两处 throw）。生产侧遇到
// 非法 pending 会判「状态损坏」并跳过本次日报更新，而 --status 此前完全不看 pending——同一份
// report.state，生产判损坏、这里却显示「日报：正常」，两处口径相反（审查 SS-05）。此处补齐：
//   - 缺失（undefined）合法：生产侧 _normalizeReportState 归一化为全 0 的 pending；
//   - 存在时必须是普通对象（非 null、非数组），否则非法；
//   - 七项计数存在时均为非负安全整数（缺失视为未累计，与 raw 顶层计数同口径）。
function validPendingReport (value) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return REPORT_COUNTERS.every(key => value[key] === undefined || validCounter(value[key]))
}

function validReport (value) {
  // 与生产侧 xbk_app 读取口径对齐：七项计数只在字段存在时校验非负安全整数，
  // 缺失视为未累计（生产侧 _normalizeReportState 会归一化为 0），不再整份判 invalid。
  // CodeRabbit PR #147：date 同样要允许缺失——生产侧 _loadReportState 接受 raw.date === undefined，
  // _normalizeReportState 归一化为 ''，_updateReport 视其为首轮并补当前日期。此处原先要求
  // typeof date === 'string'，会把合法的 {"runs":1} 显示成「日报：不可读（invalid）」。
  // 审查 SS-04：存在的 date 不只校验类型，还按 _isValidReportDate 语义校验真实日期。
  // 审查 SS-05：pending 段与生产侧同口径校验（见 validPendingReport）——不校验时，生产判损坏的
  // report.state 会在 --status 里显示成「日报：正常」。
  return value && (value.date === undefined || isValidReportDate(value.date)) &&
    REPORT_COUNTERS.every(key => value[key] === undefined || validCounter(value[key])) &&
    validPendingReport(value.pending)
}

// 单条通道记录的口径：必须是普通对象且三个计数均为非负安全整数（缺失/类型错即该条损坏）。
function validChannelEntry (entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) &&
    validCounter(entry.consecutiveFailures) && validCounter(entry.lastFailureAt) && validCounter(entry.lastAlertAt)
}

// 逐条容错（审查 SS-02）：旧实现 Object.values(value).every(...) 是「任一条目损坏即整表 invalid」，
// 一条坏记录会让所有健康通道信息一并消失（--status 只显示「不可读（invalid）」）。现口径：
//   - 空表（{}）→ ok，展示「暂无记录」；
//   - 至少有一条合格记录 → ok，formatStatus 逐条过滤并报告被忽略的损坏条数；
//   - 有记录且无一合格 → invalid（整表确实不可读，不假装「暂无记录」）。
function validChannels (value) {
  const entries = Object.values(value)
  return entries.length === 0 || entries.some(validChannelEntry)
}

function parseJson (read, validate) {
  if (read.status !== 'ok') return { status: read.status }
  try {
    const value = JSON.parse(read.value)
    return value && typeof value === 'object' && !Array.isArray(value) && validate(value)
      ? result('ok', value)
      : result('invalid')
  } catch (error) { return result('invalid') }
}

// 摘要行之后的日志行是否说明「这一轮没正常走完」（审查 SS-01）。生产侧写日志的顺序是
// 「先写 total=… 摘要、再在异常分支写 ERROR / ALERT 运行异常」（xbk_app.js:1498 → :1526/:314），
// 所以摘要行之后出现 ERROR 或「运行异常」即代表该轮在其后中断。只认这两种强信号，
// 普通 ALERT（低磁盘/日报更新失败等）不参与判定，避免把成功的轮次误报成异常。
function looksLikeRoundFailure (line) {
  return /(?:^|\s)ERROR(?:\s|$)|运行异常/.test(line)
}

function parseLastRun (read) {
  if (read.status !== 'ok') return { status: read.status }
  const lines = read.value.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    // 行首锚定：摘要行只可能是「时间戳（本地 YYYY-MM-DD HH:MM:SS 或历史 ISO）+ total=」或裸 total=，
    // 避免 ERROR/ALERT 行文本里恰好含 total=… 子串时被误取。
    // 审查 SS-01：时间戳由非捕获组改为捕获组（旧实现只用来锚定，结果里没有任何时间字段，
    // 输出无法判断这一轮是何时跑的、也看不出日志已经很久没更新）。
    const match = /^((?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*) )?total=(\d+) dedup=(\d+) filtered=(\d+) truncated=(\d+) pushed=(\d+) failed=(\d+) elapsed=([^\s]+)/.exec(lines[i])
    if (!match) continue
    // 与 parseDiagnostics 同口径：六项计数必须是非负安全整数（超长数字经 Number 得 Infinity/超界，直接跳过该行）
    const counters = match.slice(2, 8).map(Number)
    if (!counters.every(validCounter)) continue
    const interrupted = lines.slice(i + 1).some(looksLikeRoundFailure)
    return result('ok', {
      at: match[1] ? match[1].trim() : '',
      total: counters[0],
      dedup: counters[1],
      filtered: counters[2],
      truncated: counters[3],
      pushed: counters[4],
      failed: counters[5],
      elapsed: match[8],
      interrupted
    })
  }
  return result('invalid')
}

function parseDiagnostics (read) {
  if (read.status !== 'ok') return { status: read.status }
  const lines = read.value.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i])
      if (value && value.type === 'run' && validCounter(value.total) && validCounter(value.dedup) &&
        validCounter(value.filtered) && validCounter(value.passed) && validCounter(value.detailCount) &&
        value.byReason && typeof value.byReason === 'object' && !Array.isArray(value.byReason) &&
        Object.values(value.byReason).every(validCounter)) return result('ok', value)
    } catch (error) { /* 忽略单条损坏记录，继续查找最近完整汇总 */ }
  }
  return result('invalid')
}

function readStatus (dir, { now = Date.now() } = {}) {
  const report = parseJson(readText(dir, FILES.report, 64 * 1024), validReport)
  const channels = parseJson(readText(dir, FILES.channels, 64 * 1024), validChannels)
  // report.state / channel-health 是「整份 JSON」，必须整读：超限仍判 tooLarge（读尾部只会得到
  // 半个 JSON，假装可读更危险）。run.log / filter-diagnostics 是追加式日志，取尾部 1 MiB
  // （审查 SS-03）：超限时旧行为让这两个部件整体不可见，而解析本来就是「从最后一行往前找」。
  const run = parseLastRun(readText(dir, FILES.run, LOG_MAX_BYTES, LOG_READ_OPTIONS))
  const diagnostics = parseDiagnostics(readText(dir, FILES.diagnostics, LOG_MAX_BYTES, LOG_READ_OPTIONS))
  return { generatedAt: now, report, channels, run, diagnostics }
}

// 判重缓存条数（v3.298 附加部件，与 readStatus 同目录同防御）：控制台缓存健康面板的
// 「条目数 / 上限」预警需要它，但 readStatus 形状被 --status 与既有前端锁定（不能改），
// 故独立导出。只回计数不回显条目（调用方要详情另有 readMessages）；超限的缓存数条数
// 要整读 32MiB——tooLarge 时如实返回 tooLarge（null），前端显示「—」而不是编个数。
function readMessageCount (dir, { filename = FILES.messages } = {}) {
  const read = readMessages(dir, { filename })
  if (read.status !== 'ok') return { status: read.status, count: null }
  return { status: 'ok', count: read.value.total }
}

function describe (part) {
  return part.status === 'missing' ? '缺失' : part.status === 'ok' ? '正常' : `不可读（${part.status}）`
}

function formatStatus (status) {
  const lines = [`📊 xbk-push 运行状态（${new Date(status.generatedAt).toISOString()}）`]
  const report = status.report.value
  lines.push(`日报：${describe(status.report)}${report ? ` | ${report.date || '无日期'} | ${report.runs || 0} 轮 | 推送成功：${report.pushed || 0} 条 | 失败：${report.failed || 0} 条 | 待推送（截断）：${report.truncated || 0} 条` : ''}`)
  const run = status.run.value
  // 审查 SS-01：① 展示摘要行时间戳（旧实现把时间戳丢弃，输出里看不出这一轮是何时跑的、是否已陈旧）；
  // ② 「文件可读」不等于「这一轮正常」——摘要行之后还有 ERROR/运行异常行时说明该轮中断退出，
  //    不再一律渲染成「正常」（崩溃轮此前与正常轮显示完全一致）。
  const runState = run && run.interrupted ? '⚠️ 上一轮未正常结束' : describe(status.run)
  lines.push(`最近一轮：${runState}${run ? ` | 时间 ${run.at || '无时间戳'} | 获取 ${run.total} | 去重 ${run.dedup} | 过滤 ${run.filtered} | 推送 ${run.pushed} | 失败 ${run.failed} | 截断 ${run.truncated}${run.truncated > 0 ? ' ⚠️' : ''} | 耗时 ${run.elapsed}` : ''}`)
  const channels = status.channels.value
  if (channels) {
    // 与 validChannels 同口径逐条过滤（审查 SS-02）：损坏条目单独计数并明示，健康通道照常展示。
    const all = Object.entries(channels)
    const entries = all.filter(([, value]) => validChannelEntry(value))
    const dropped = all.length - entries.length
    const body = entries.length
      ? entries.map(([name, value]) => `${name}：连续失败 ${value.consecutiveFailures} 次`).join('；')
      : '暂无记录'
    lines.push(`通道健康：${body}${dropped > 0 ? `（另有 ${dropped} 条记录损坏已忽略）` : ''}`)
  } else lines.push(`通道健康：${describe(status.channels)}`)
  const diagnostics = status.diagnostics.value
  lines.push(`过滤诊断：${describe(status.diagnostics)}${diagnostics ? ` | 最近 ${diagnostics.at || '未知'} | 原因：${Object.entries(diagnostics.byReason || {}).map(([key, value]) => `${key}=${value}`).join('，') || '无'}` : ''}`)
  return lines.join('\n')
}

// ── 控制台扩展数据（v3.297）：趋势 / 推送记录 ────────────────────────────────
// 与 readStatus 同源同目录、同样只读（readSafeTextResult，符号链接/非常规文件防御继承），
// 不改变 readStatus 返回形状——现有 --status / formatStatus / 前端看板零影响。

// run.log 摘要行正则（与 parseLastRun 同一口径的**逐行**形态）：trends 把全部摘要行按日聚合，
// 而不是只取最近一轮。dry-run 行（含 dry-run未推送=）计入轮次与获取数，但 pushed 恒为 0，
// 与真实口径一致；noidentity/cachesaved 等附加字段不参与聚合。
const RUN_SUMMARY_LINE_RE = /^(?:(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}:\d{2}\S* )?total=(\d+) dedup=(\d+) filtered=(\d+) truncated=(\d+) pushed=(\d+) failed=(\d+) elapsed=(\S+)/

function validInt (v) { return Number.isSafeInteger(v) && v >= 0 }

// 近 N 日运行趋势：摘要行按本地日期（YYYY-MM-DD）聚合。文件缺失/不可读返回 { status }，
// 与 readStatus 部件三态（missing/ok/invalid）一致，前端沿用 partTone 归类。
function readTrends (dir, { now = Date.now(), days = 14 } = {}) {
  // [7] 日志超限读尾部时如实标注：readSafeTextResult 对 tail 读不报截断，这里以「文件实际大于
  // 读取上限」判定。窗口内的更早摘要若被截掉，趋势只反映尾部日志——前端副标题会注明。
  let truncated = false
  try {
    const st = require('node:fs').statSync(path.join(dir, FILES.run))
    if (st.isFile() && st.size > LOG_MAX_BYTES) truncated = true
  } catch (e) { /* stat 失败按未截断处理：readText 随后会给出真实状态 */ }
  const read = readText(dir, FILES.run, LOG_MAX_BYTES, LOG_READ_OPTIONS)
  if (read.status !== 'ok') return { status: read.status }
  const horizonKey = shanghaiDayKey(now - (days - 1) * 86400000)
  const byDay = new Map()
  const lines = read.value.split('\n')
  for (const line of lines) {
    const m = RUN_SUMMARY_LINE_RE.exec(line)
    if (!m) continue
    const counters = [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number)
    if (!counters.every(validInt)) continue
    // 无时间戳的历史行（极旧格式）没有日期键，归不进任何一天——跳过（诚实于「不知道」）。
    const day = m[1]
    if (!day) continue
    // 只聚合近 N 天：旧日志行不进窗口（避免「总计」被陈旧数据污染）。
    if (day < horizonKey) continue
    const agg = byDay.get(day) || { date: day, rounds: 0, total: 0, dedup: 0, filtered: 0, truncated: 0, pushed: 0, failed: 0 }
    agg.rounds += 1
    agg.total += counters[0]
    agg.dedup += counters[1]
    agg.filtered += counters[2]
    agg.truncated += counters[3]
    agg.pushed += counters[4]
    agg.failed += counters[5]
    byDay.set(day, agg)
  }
  // 输出按日期升序补零：没有记录的日期也给全 0 行，前端画图不用补洞。
  const out = []
  for (let i = 0; i < days; i++) {
    const key = shanghaiDayKey(now - (days - 1 - i) * 86400000)
    out.push(byDay.get(key) || { date: key, rounds: 0, total: 0, dedup: 0, filtered: 0, truncated: 0, pushed: 0, failed: 0 })
  }
  return result('ok', { days, byDay: out, truncated, today: shanghaiDayKey(now) })
}

// ── 逐轮运行历史（v3.299 批次②）：run.log 摘要行 → 时间倒序逐轮条目 ─────────────
// 与 readTrends 同源同纪律：只读（readText = readSafeTextResult 尾读 1MiB 口径）、
// 逐行容错、行首锚定正则（无用户输入进正则）。控制台 /api/run-history 消费。
// 数据完整性边界（有意取舍，README 披露）：崩溃轮无摘要行只能标 interrupted；
// 超 1MiB 后更早轮次已物理轮转丢失（truncated:true 如实标注）。

// 摘要行附加尾组：cachesaved=(0|1) / noidentity=N / dry-run未推送=N（写入侧 xbk_app.js
// 按条件输出，读取侧全部可选捕获——纯读扩展，写入侧零改动）。
// Sonar S8786：可选组链 `(?: …)?(?: …)?` 有超线性回溯形态，改用零正则的线性尾部扫描
// （runParseExtras）：只锚定「最后一个数值 token 边界」，与原正则捕获语义逐分支等价，
// 且对任意行输入保证 O(行尾段) 单遍。
function runParseExtras (line) {
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
  return { cachesaved, noidentity, dryRun }
}

function readRunHistory (dir, { limit = 50, before = 0 } = {}) {
  const lim = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
  const skip = Number.isSafeInteger(before) && before > 0 ? before : 0
  // [7] 超窗如实标注（readTrends 同款）：文件实际 >1MiB 时更早轮次已被轮转截掉。
  let truncated = false
  try {
    const st = require('node:fs').statSync(path.join(dir, FILES.run))
    if (st.isFile() && st.size > LOG_MAX_BYTES) truncated = true
  } catch (e) { /* stat 失败按未截断处理：readText 随后会给出真实状态 */ }
  const read = readText(dir, FILES.run, LOG_MAX_BYTES, LOG_READ_OPTIONS)
  if (read.status !== 'ok') return { status: read.status, items: [], hasMore: false, truncated: false }
  // 从尾向前扫（时间倒序天然成立）：摘要行 = 事实轮界；轮内「摘要行之后」的行按
  // looksLikeRoundFailure 判 interrupted（与 parseLastRun 同口径：ERROR/运行异常）。
  const lines = read.value.split('\n')
  const items = []
  let skipped = 0
  for (let i = lines.length - 1; i >= 0 && items.length < lim; i--) {
    const m = RUN_SUMMARY_LINE_RE.exec(lines[i])
    if (!m) continue
    if (skipped < skip) { skipped++; continue }
    const counters = [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number)
    if (!counters.every(validInt)) continue
    const extras = runParseExtras(lines[i])
    // 摘要行之后的 ERROR/运行异常行属于该轮（生产写序：先摘要后异常，xbk_app.js :1498/:1526）。
    // 崩溃轮无摘要行：文件尾存在强失败行且其后无摘要 → 追加 interrupted 占位条目。
    const tail = lines.slice(i + 1)
    const interrupted = tail.some(looksLikeRoundFailure)
    if (!interrupted && tail.length > 0) {
      // 摘要行后有非失败行（ERROR 才算失败，普通 WARN/ALERT 不算）——仍然属于该轮，
      // 不影响 interrupted 判定，无需特殊处理；这里不 break，继续向更早扫描。
    }
    items.push({
      at: m[1] ? lines[i].slice(0, 19).trim() : '',
      total: counters[0],
      dedup: counters[1],
      filtered: counters[2],
      truncated: counters[3],
      pushed: counters[4],
      failed: counters[5],
      elapsed: m[8],
      cachesaved: extras.cachesaved !== null ? extras.cachesaved : null,
      noidentity: extras.noidentity !== null ? extras.noidentity : null,
      dryRun: extras.dryRun !== null ? extras.dryRun : null,
      interrupted
    })
  }
  // 崩溃轮占位：文件尾部存在强失败行、且其位置之后没有任何摘要行（items 为空或首条
  // 摘要行在失败行之前）→ 该轮没有任何计数数据，用 null 条目如实呈现而非静默丢弃。
  if (items.length < lim) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (RUN_SUMMARY_LINE_RE.exec(lines[i])) break
      if (looksLikeRoundFailure(lines[i])) {
        items.push({ at: '', total: null, dedup: null, filtered: null, truncated: null, pushed: null, failed: null, elapsed: '', cachesaved: null, noidentity: null, dryRun: null, interrupted: true })
        break
      }
    }
  }
  // hasMore：尾窗内还有更早摘要未下发（before 游标还有下一页）。
  let hasMore = false
  if (items.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      if (RUN_SUMMARY_LINE_RE.exec(lines[i])) { hasMore = skip + items.length < countSummaryLines(lines); break }
    }
  }
  return { status: 'ok', items, hasMore, truncated }
}

// 尾窗内摘要行总数（readRunHistory 的 hasMore 判定辅助；逐行 count，无正则回溯面）。
function countSummaryLines (lines) {
  let n = 0
  for (const line of lines) if (RUN_SUMMARY_LINE_RE.exec(line)) n++
  return n
}

// push.json（判重缓存主存 = 已推送消息记录）的轻量读取校验：条目必须是带 id/title 的对象。
// 这里不做 readStatus 级别的严格 schema 校验——控制台只读展示，畸形条目跳过并计数即可
// （与 validChannels「逐条容错」同哲学：一条坏记录不能让整份记录不可见）。
function validMessageEntry (m) {
  return m && typeof m === 'object' && !Array.isArray(m) &&
    (typeof m.title === 'string' || typeof m.content === 'string')
}

// 读取已推送消息列表：push.json 是 MessageStore 判重缓存（最旧在前、最新在后）。
// 返回 { status, items(时间倒序), total, categories } —— 过滤/分页由调用方（HTTP 层）做，
// 本函数只负责「安全读取 + 容错解析 + 排序 + 分类汇总」，保持无查询参数的纯函数可测性。
function readMessages (dir, { maxBytes = 32 * 1024 * 1024, filename = FILES.messages } = {}) {
  // filename 可覆盖：运行侧缓存名由 MessageStore.getFileName(Config.api.pushUrl) 决定（pushUrl 末段
  // 去查询串后 + .json）。控制台默认读 push.json（默认配置的产物）；自定义了 pushUrl basename 的部署
  // 显式传 filename（console main 里从同名口径推导），不让「文件改名」静默变成「记录消失」。
  const read = readText(dir, filename, maxBytes)
  if (read.status !== 'ok') return { status: read.status }
  let parsed
  try { parsed = JSON.parse(read.value) } catch (error) { return result('invalid') }
  if (!Array.isArray(parsed)) return result('invalid')
  const pairs = [] // [entry, rowKey] 绑定排序：键取「原始 parsed 下标」（push.json 只追加不重排，
  // 追加序才是稳定身份；用排序后下标会在新条目插入时整体推移，前端展开状态随之错位）
  let skipped = 0
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    // _f 条目是「被过滤、从未推送」的记录（MessageStore 约定），不是推送历史的一部分——
    // 控制台页面是「已推送记录」，混入会让分类计数与历史失真（审查 Sourcery PR#227）。
    if (entry && typeof entry === 'object' && entry._f === true) continue
    if (validMessageEntry(entry)) {
      pairs.push([entry, (typeof entry.id === 'string' && entry.id.length > 0) || typeof entry.id === 'number'
        ? String(entry.id)
        : `idx-${i}`])
    } else {
      skipped += 1
    }
  }
  // 时间倒序：shijianchuo（秒）优先，缺失/非法的排最后并按原顺序稳定保留。
  const tsOf = (pair) => (validInt(pair[0].shijianchuo) ? pair[0].shijianchuo : -1)
  pairs.sort((a, b) => tsOf(b) - tsOf(a))
  const items = pairs.map((p) => p[0])
  const keys = pairs.map((p) => p[1])
  // 分类汇总（按条数倒序）：前端筛选下拉直接用。
  const cateCount = new Map()
  for (const m of items) {
    const name = typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)'
    cateCount.set(name, (cateCount.get(name) || 0) + 1)
  }
  const categories = [...cateCount.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  return result('ok', { total: items.length, items, keys, categories, skipped })
}

module.exports = { readStatus, formatStatus, readTrends, readMessages, readMessageCount, readRunHistory, RUN_SUMMARY_LINE_RE }
