'use strict'

const fs = require('node:fs')
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

// 失败行的强信号判定（审查 SS-01 / D2-M3）：只认独立 ERROR 或「运行异常」，普通 ALERT
// （低磁盘/线报酷截断/缺 re2/日报更新失败）不参与——它们的正文同样含「⚠️ xbk-push 运行异常」，
// 按正文命中会把成功轮误报成中断。轮起止归属见下方 classifyRoundFailures（与 readRunHistory
// 共用同一口径，避免「同一面板两处结论相反」）。
function looksLikeRoundFailure (line) {
  // 「控制台停止：任务 #… 于运行中被停止（SIGTERM）」是控制台侧的取消留痕，不是某一轮的
  // 运行失败：它没有自己的摘要行，把最近的摘要回填成 interrupted 会让每次重启/取消都把
  // 上一轮标成「中断」（评审：手机端整页黄色警告）。取消轮次由 readRunHistory 按 CANCEL
  // 前缀单独成条（cancelled=true），这里一律不算失败。
  if (line.includes('控制台停止：任务 #')) return false
  // 审查 D2-M3：ALERT 的正文固定含「运行异常」（xbk_app.js:324 的告警模板），但线报酷截断、
  // 缺 re2 等**非失败**告警都用同一句正文 ⇒ 不能按正文命中，否则成功轮被标「中断」。
  // ALERT 行里可能内嵌带 ERROR 字样的原因串，先整行排除；独立的中文「运行异常」（无 ALERT
  // 前缀）仍按失败处理，保留状态报告既有口径。
  if (/(?:^|\s)ALERT(?:\s|$)/.test(line)) return false
  return /(?:^|\s)ERROR(?:\s|$)|运行异常/.test(line)
}

// run.log 摘要行正则（parseLastRun 只看最后一条；readTrends / readRunHistory / parseRunStats
// 都按同一逐行形态解析）。dry-run 行（含 dry-run未推送=）计入轮次与获取数，但 pushed 恒为 0，
// 与真实口径一致；noidentity/cachesaved 等附加字段不参与聚合。
const RUN_SUMMARY_LINE_RE = /^(?:(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}:\d{2}\S* )?total=(\d+) dedup=(\d+) filtered=(\d+) truncated=(\d+) pushed=(\d+) failed=(\d+) elapsed=(\S+)/

// ── 轮界归属（parseLastRun / readRunHistory 共用）────────────────────────────
// 生产写序（xbk_app.js）：失败行写在所属轮的摘要行**之前**——「推送全部失败」ERROR 后紧跟
// 同秒摘要（:1684 → :1688），「缓存读取失败」ERROR 后本轮仍走完收尾写摘要（:1191）；进程在
// 写摘要前退出则只剩失败行（崩溃轮）。归属判据：
//   ① 近距：与摘要相距 ≤2 行且 |Δt| ≤2s（同一秒写出，防跨轮误挂）；
//   ② 轮内远距：其后第一条摘要在 10 分钟内、且两行之间没有别的摘要（同轮先记错误再写摘要，
//      中间隔着若干行普通日志——旧实现只在 2 行内找，于是同一物理轮多出一条幽灵崩溃行）；
//   ③ 其余 = 无摘要可归属的独立崩溃轮（占位条目），绝不回填「最近一条摘要」（那会把上一轮
//      误标 interrupted，而崩溃轮自己从历史里消失）。
// 10 分钟与 console.js 的单轮超时（PROC_TIMEOUT_MS）同量级：一轮不可能更久；崩溃后下一次
// 调度通常远超此窗，因此不会把上一轮的崩溃行挂到下一轮。
const ROUND_FAILURE_NEAR_LINES = 2
const ROUND_FAILURE_NEAR_MS = 2000
const ROUND_FAILURE_INROUND_MS = 10 * 60 * 1000

function tsOf (line) {
  const m = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(line)
  return m ? m[1] : ''
}
function tsMs (line) {
  const ts = tsOf(line)
  const v = ts ? Date.parse(ts.replace(' ', 'T') + 'Z') : NaN
  return Number.isFinite(v) ? v : null
}

// 摘要行索引表：0-based 行号 → 摘要时间戳(ms) / null（无时间戳）。
// 计数器非法/缺失的摘要行不参与归属（否则失败轮会凭空消失）。
function summaryIndexOf (lines) {
  const summaryAt = new Map()
  for (let i = 0; i < lines.length; i++) {
    if (!RUN_SUMMARY_LINE_RE.test(lines[i])) continue
    const m = RUN_SUMMARY_LINE_RE.exec(lines[i])
    if (![m[2], m[3], m[4], m[5], m[6], m[7]].map(Number).every(validCounter)) continue
    summaryAt.set(i, tsMs(lines[i]))
  }
  return summaryAt
}

// 失败行 → 所属摘要行（interruptedIdx）或无主崩溃行（crashIdx）。
function classifyRoundFailures (lines, summaryAt) {
  const summaryIdx = [...summaryAt.keys()].sort((a, b) => a - b)
  const interruptedIdx = new Set()
  const crashIdx = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (summaryAt.has(i) || !looksLikeRoundFailure(lines[i])) continue
    const t = tsMs(lines[i])
    let best = null
    if (t === null) {
      // 无时间戳：只认文件序其后的摘要（1–2 行内），不把更早一轮的堆栈行回填给它
      for (let d = 1; d <= ROUND_FAILURE_NEAR_LINES && !best; d++) {
        if (summaryAt.has(i + d)) best = { j: i + d, gap: 0 }
      }
    } else {
      for (let d = 1; d <= ROUND_FAILURE_NEAR_LINES && !best; d++) {
        for (const j of [i - d, i + d]) {
          if (!summaryAt.has(j)) continue
          const st = summaryAt.get(j)
          if (st === null) continue
          const gap = Math.abs(st - t)
          if (gap > ROUND_FAILURE_NEAR_MS) continue
          if (!best || gap < best.gap) best = { j, gap } // 同距离取时间差更小者
        }
      }
      if (!best) {
        // 轮内远距：其后第一条摘要（之间无其他摘要）且时间差在单轮上限内
        const next = summaryIdx.find((j) => j > i)
        if (next !== undefined) {
          const st = summaryAt.get(next)
          const gap = st === null ? null : st - t
          if (gap !== null && gap >= 0 && gap <= ROUND_FAILURE_INROUND_MS) best = { j: next, gap }
        }
      }
    }
    if (best) interruptedIdx.add(best.j)
    else crashIdx.add(i) // 无摘要可归属 ⇒ 独立崩溃轮占位
  }
  return { interruptedIdx, crashIdx }
}

function parseLastRun (read) {
  if (read.status !== 'ok') return { status: read.status }
  const lines = read.value.trim().split('\n').filter(Boolean)
  let summaryAt = null
  let classified = null
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
    if (!summaryAt) {
      summaryAt = summaryIndexOf(lines)
      classified = classifyRoundFailures(lines, summaryAt)
    }
    // 与 readRunHistory 同一归属口径：只标「本条摘要自己的轮」是否中断；其后的无主失败行
    // 单独计数上报（旧实现把尾部任意 ERROR 回填给本条摘要 ⇒ 与运行历史结论相反）。
    let orphanFailures = 0
    let orphanFailureAt = ''
    for (const j of classified.crashIdx) {
      if (j <= i) continue
      orphanFailures += 1
      const at = tsOf(lines[j])
      if (at) orphanFailureAt = at
    }
    return result('ok', {
      at: match[1] ? match[1].trim() : '',
      total: counters[0],
      dedup: counters[1],
      filtered: counters[2],
      truncated: counters[3],
      pushed: counters[4],
      failed: counters[5],
      elapsed: match[8],
      interrupted: classified.interruptedIdx.has(i),
      orphanFailures,
      orphanFailureAt
    })
  }
  return result('invalid')
}

// 首屏「今日 / 近 7 天」聚合（v3.307）：与趋势同源同口径（run.log 摘要行 + Asia/Shanghai
// 日历日），但只下发计数，不在前端重算。today/week 的 successRate = pushed/(pushed+failed)，
// 无尝试时 null（前端显示「—」而不是编一个 100%）。
// lastFailure 是近 7 天窗口内最近一条 failed>0 的摘要（用于首屏异常横幅的「看日志」跳转）；
// 窗口外失败不进入 stats，避免首屏长期挂红。
function parseRunStats (read, now = Date.now()) {
  if (read.status !== 'ok') return { status: read.status }
  const todayKey = shanghaiDayKey(now)
  const weekStartKey = shanghaiDayKey(now - 6 * 86400000)
  const blank = (date) => ({ date, rounds: 0, total: 0, pushed: 0, failed: 0 })
  const today = blank(todayKey)
  const week = { from: weekStartKey, to: todayKey, rounds: 0, total: 0, pushed: 0, failed: 0 }
  let lastFailure = null
  for (const line of read.value.split('\n')) {
    const m = RUN_SUMMARY_LINE_RE.exec(line)
    if (!m) continue
    const counters = [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number)
    if (!counters.every(validCounter)) continue
    const day = m[1]
    if (!day || day < weekStartKey) continue
    week.rounds += 1
    week.total += counters[0]
    week.pushed += counters[4]
    week.failed += counters[5]
    if (day === todayKey) {
      today.rounds += 1
      today.total += counters[0]
      today.pushed += counters[4]
      today.failed += counters[5]
    }
    if (counters[5] > 0) {
      lastFailure = { at: line.slice(0, 19).trim(), date: day, failed: counters[5] }
    }
  }
  const rate = (pushed, failed) => (pushed + failed > 0 ? pushed / (pushed + failed) : null)
  return result('ok', {
    today: { ...today, successRate: rate(today.pushed, today.failed) },
    week: { ...week, successRate: rate(week.pushed, week.failed) },
    lastFailure
  })
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
  const runRead = readText(dir, FILES.run, LOG_MAX_BYTES, LOG_READ_OPTIONS)
  const run = parseLastRun(runRead)
  const diagnostics = parseDiagnostics(readText(dir, FILES.diagnostics, LOG_MAX_BYTES, LOG_READ_OPTIONS))
  return { generatedAt: now, report, channels, run, diagnostics, stats: parseRunStats(runRead, now) }
}

// 判重缓存条数（v3.298 附加部件，与 readStatus 同目录同防御）：控制台缓存健康面板的
// 「条目数 / 上限」预警需要它，但 readStatus 形状被 --status 与既有前端锁定（不能改），
// 故独立导出。只回计数不回显条目（调用方要详情另有 readMessages）；超限的缓存数条数
// 要整读 32MiB——tooLarge 时如实返回 tooLarge（null），前端显示「—」而不是编个数。
function readMessageCount (dir, { filename = FILES.messages, maxBytes = 32 * 1024 * 1024 } = {}) {
  const read = readMessages(dir, { filename, maxBytes })
  if (read.status !== 'ok') return { status: read.status, count: null, filteredCount: null }
  // count 用 rawTotal（含 _f 条目）：条数上限约束的是缓存条目总数，而 _f（被过滤、从未推送）
  // 一样占额度。旧实现报 items.length（排除 _f），9000 条 _f + 1500 条正常时报 1500/10000，
  // 实际 10500 已超上限却预警不响（D2-S11）。filteredCount 单列，页面仍可显示「已推送」条数。
  return { status: 'ok', count: read.value.rawTotal, filteredCount: read.value.filteredCount }
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
  // 摘要之后的无主失败行（崩溃轮）：不把这轮标成中断（它确实正常写完了摘要），但也不能让
  // 崩溃信号在首屏消失——单独一行如实上报，指向运行历史里的占位条目。
  if (run && run.orphanFailures > 0) {
    lines.push(`⚠️ 其后另有 ${run.orphanFailures} 条失败行未归属任何摘要（独立崩溃轮${run.orphanFailureAt ? `，最近 ${run.orphanFailureAt}` : ''}；见运行历史）`)
  }
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

// 尾窗指纹（评审 #243-1 / 审查 D1-N6）：before 行号相对「当前 1MiB 尾窗」编号，文件超窗后
// 新写入会让整个窗口平移，旧游标会指到别的轮次。窗口指纹随响应下发，客户端翻页时带回；
// 指纹不符 → stale，前端回第 1 页（宁可重看，不跳/不重复）。
// 旧实现直接哈希首行前 200 字符：空行/空串恒得 811c9dc5（不同的空窗口无法区分），首行第
// 200 字符之后不同也判不出来。现口径：跳过空行取首个非空行，把「行序 + 长度 + 完整内容」
// 并入哈希。行数与总长度刻意不入哈希——append-only 日志每追加一行都会变，那会让翻页永远
// stale（追加安全的游标见 entryKeyOf）。
function windowKeyOf (windowLines) {
  const lines = Array.isArray(windowLines) ? windowLines : [windowLines]
  let n = 0
  while (n < lines.length && String(lines[n] === undefined || lines[n] === null ? '' : lines[n]).trim() === '') n++
  const anchor = n < lines.length ? String(lines[n] === undefined || lines[n] === null ? '' : lines[n]) : ''
  const seed = `${n}:${anchor.length}:${anchor}`
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// 条目稳定身份（审查 D1-S3）：尾窗按字节平移，行号（窗口相对）在追加时必变，只有行内容
// 不变。key = 行内容 8 位哈希；客户端翻页回传上一页最旧条目的 key，服务端按 key 定位锚点、
// 取文件序更早的条目——追加新行不再让游标失效；仅当锚点轮已滚出 1MiB 尾窗（物理丢失）
// 时才返回 stale。
function entryKeyOf (line) {
  const text = String(line === undefined || line === null ? '' : line)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// 取消留痕（审查 #229 S7 / D1-N3）：控制台停止任务时写 `CANCEL 控制台停止：任务 #…`。
// 它不是运行失败（不参与 interrupted），但也不能让这轮从历史里消失——readRunHistory 给它
// 生成 cancelled 占位条目；相邻轮次不受影响。
function isCancelTrace (line) {
  return /(?:^|\s)CANCEL(?:\s|$)/.test(line) && line.includes('控制台停止：任务 #')
}

function readRunHistory (dir, { limit = 50, before = 0, windowKey = '' } = {}) {
  const lim = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
  // before 两种形态（审查 D1-S3）：数字 = 行号游标（兼容旧前端；尾窗平移后需窗口指纹校验），
  // 8 位十六进制 = 条目 key 游标（追加安全，新前端使用）。
  // key 游标：裸 8 位（首次出现）或 `<8位>-<序号>`（同内容重复行，见下方 occurrence 去重）
  const beforeKey = typeof before === 'string' && /^[0-9a-f]{8}(?:-\d{1,4})?$/.test(before) ? before : ''
  const beforeLine = Number.isSafeInteger(before) && before > 0
    ? before
    : (typeof before === 'string' && /^\d{1,9}$/.test(before) ? Number(before) : 0)
  // [5] 超窗/轮转如实标注（Sourcery #229-5）：readSafeTextResult 尾读触发即 truncated
  // （首行可能是半行）；另有写入侧历史上发生过截尾的情形——文件已 ≤1MiB，stat 大小判不出，
  // 但窗口首行不是「时间戳锚定」形态（首行切在行中，退位算法总保完整字符、半行保不住锚），
  // 同样判轮转。两者合并报 truncated，前端如实提示「更早轮次已丢失」。
  const read = readText(dir, FILES.run, LOG_MAX_BYTES, LOG_READ_OPTIONS)
  if (read.status !== 'ok') return { status: read.status, items: [], hasMore: false, truncated: false }
  let truncated = read.truncated === true
  const lines = read.value.split('\n')
  const first = lines[0] || ''
  if (!truncated && first.trim() !== '' && !RUN_SUMMARY_LINE_RE.test(first) &&
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(first)) {
    truncated = true
  }
  const key = windowKeyOf(lines)
  // 行号游标必须配窗口指纹（窗口平移后同一行号指向别的轮次）；key 游标自带身份，不需要。
  if (beforeKey === '' && typeof windowKey === 'string' && windowKey !== '' && windowKey !== key) {
    return { status: 'stale', items: [], hasMore: false, truncated, windowKey: key }
  }

  // 轮界模型（审查 #241 M2 / #242 M3+S2 / #243 / D2-N5，按生产写序 xbk_app.js :1684→:1688）：
  // 一轮的摘要行在**轮末**写出，失败行写在其所属摘要行**之前**。归属判据与 parseLastRun
  // 共用 classifyRoundFailures（近距 ≤2 行且 ≤2s / 轮内远距 ≤10min / 其余为崩溃占位），
  // 同一文件在「上一轮 / 运行历史」两处必须给出同一结论。
  const summaryAt = summaryIndexOf(lines)
  const { interruptedIdx, crashIdx } = classifyRoundFailures(lines, summaryAt)

  const roundKey = new Map() // 0-based 行号 → 条目稳定 key（重复内容追加 -N 序号）
  const rounds = []
  for (const i of summaryAt.keys()) {
    const line = lines[i]
    const m = RUN_SUMMARY_LINE_RE.exec(line)
    const counters = [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number)
    const extras = runParseExtras(line)
    rounds.push({
      i,
      at: m[1] ? line.slice(0, 19).trim() : '',
      total: counters[0],
      dedup: counters[1],
      filtered: counters[2],
      truncated: counters[3],
      pushed: counters[4],
      failed: counters[5],
      elapsed: m[8],
      cachesaved: extras.cachesaved,
      noidentity: extras.noidentity,
      dryRun: extras.dryRun,
      interrupted: interruptedIdx.has(i), // 同秒/相邻失败行已在预扫描归属到本轮
      cancelled: false,
      isPlaceholder: false
    })
  }
  for (const i of crashIdx) {
    rounds.push({
      i,
      at: tsOf(lines[i]),
      total: null,
      dedup: null,
      filtered: null,
      truncated: null,
      pushed: null,
      failed: null,
      elapsed: '',
      cachesaved: null,
      noidentity: null,
      dryRun: null,
      interrupted: true,
      cancelled: false,
      isPlaceholder: true
    })
  }
  // 文件序倒置即时间倒序（摘要行在其失败行之后写出；占位行号取失败行自身）。
  // 取消留痕单独成条（cancelled=true），既不标相邻轮中断、也不让这轮消失。
  for (let i = 0; i < lines.length; i++) {
    if (summaryAt.has(i) || crashIdx.has(i) || !isCancelTrace(lines[i])) continue
    rounds.push({
      i,
      at: tsOf(lines[i]),
      total: null,
      dedup: null,
      filtered: null,
      truncated: null,
      pushed: null,
      failed: null,
      elapsed: '',
      cachesaved: null,
      noidentity: null,
      dryRun: null,
      interrupted: false,
      cancelled: true,
      isPlaceholder: true
    })
  }
  // 游标身份去重（D2-S4 复核）：两条内容完全相同的摘要行 entryKeyOf 相同，`before=<key>`
  // 用 findIndex 只会命中最新的那条 ⇒ 翻页反复返回同一页（[5,4] → [3,2] → [3,2] …）。
  // 同一 key 的第 2..n 次出现追加 `-<序号>`（序号按窗口内文件序，追加新行不改变既有序号）；
  // 首次出现保留裸 8 位 key，旧游标/旧书签仍可定位到第一条。
  const occurrence = new Map()
  for (const r of [...rounds].sort((a, b) => a.i - b.i)) {
    const h = entryKeyOf(lines[r.i])
    const n = (occurrence.get(h) || 0) + 1
    occurrence.set(h, n)
    roundKey.set(r.i, n === 1 ? h : `${h}-${n}`)
  }
  rounds.sort((a, b) => b.i - a.i)
  let pool = rounds
  if (beforeKey !== '') {
    const anchor = rounds.findIndex((r) => roundKey.get(r.i) === beforeKey)
    // 锚点轮已滚出尾窗（或 key 从未存在）：游标无法定位，宁可重看第 1 页
    if (anchor < 0) return { status: 'stale', items: [], hasMore: false, truncated, windowKey: key }
    pool = rounds.slice(anchor + 1)
  } else if (beforeLine > 0) {
    pool = rounds.filter((r) => r.i + 1 <= beforeLine)
  }
  const items = pool.slice(0, lim).map((r) => ({
    at: r.at,
    total: r.total,
    dedup: r.dedup,
    filtered: r.filtered,
    truncated: r.truncated,
    pushed: r.pushed,
    failed: r.failed,
    elapsed: r.elapsed,
    cachesaved: r.cachesaved,
    noidentity: r.noidentity,
    dryRun: r.dryRun,
    interrupted: r.interrupted,
    cancelled: r.cancelled,
    isPlaceholder: r.isPlaceholder,
    lineNo: r.i + 1,
    key: roundKey.get(r.i)
  }))
  return { status: 'ok', items, hasMore: pool.length > items.length, truncated, windowKey: key }
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
// ── push.json 解析缓存（D2-S18）─────────────────────────────────────────────
// 25.6MB/6 万条实测：每次请求整读 + parse + 全量排序 250–325ms，全压在 HTTP 事件循环上。
// push.json 只在单轮结束时整份原子替换（MessageStore saveBatch → tmp + rename），
// (ino, size, mtimeMs) 三元组足以识别「同一份文件」（inode 变化能抓到同毫秒同大小的换文件）。
// 叠 60s TTL 兜底；mtime 太新（<100ms）的文件不进缓存——写后立刻读必须看到新内容。
// 缓存的是只读结果对象：调用方全部用 filter/map 派生新数组，不做原地改写。
const MESSAGES_CACHE_TTL_MS = 60 * 1000
const MESSAGES_CACHE_MIN_AGE_MS = 100
const MESSAGES_CACHE_MAX = 4
const messagesCache = new Map()

function messagesSignature (dir, filename, maxBytes) {
  try {
    const st = fs.statSync(path.join(dir, filename))
    if (!st.isFile() || st.size > maxBytes) return null
    if (Date.now() - st.mtimeMs < MESSAGES_CACHE_MIN_AGE_MS) return null
    return `${st.ino}:${st.size}:${Math.round(st.mtimeMs)}`
  } catch (e) { return null }
}

function readMessages (dir, { maxBytes = 32 * 1024 * 1024, filename = FILES.messages, cache = true } = {}) {
  // filename 可覆盖：运行侧缓存名由 MessageStore.getFileName(Config.api.pushUrl) 决定（pushUrl 末段
  // 去查询串后 + .json）。控制台默认读 push.json（默认配置的产物）；自定义了 pushUrl basename 的部署
  // 显式传 filename（console main 里从同名口径推导），不让「文件改名」静默变成「记录消失」。
  // cache=false：需要「此刻磁盘内容」的调用方（测试/诊断）显式绕过缓存。
  const cacheKey = `${dir}\u0000${filename}\u0000${maxBytes}`
  const sig = cache ? messagesSignature(dir, filename, maxBytes) : null
  if (sig) {
    const hit = messagesCache.get(cacheKey)
    if (hit && hit.sig === sig && Date.now() - hit.at < MESSAGES_CACHE_TTL_MS) return hit.value
  }
  const read = readText(dir, filename, maxBytes)
  if (read.status !== 'ok') return { status: read.status }
  let parsed
  try { parsed = JSON.parse(read.value) } catch (error) { return result('invalid') }
  if (!Array.isArray(parsed)) return result('invalid')
  const pairs = [] // [entry, rowKey] 绑定排序：键取「原始 parsed 下标」（push.json 只追加不重排，
  // 追加序才是稳定身份；用排序后下标会在新条目插入时整体推移，前端展开状态随之错位）
  let skipped = 0
  let filteredCount = 0
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    // _f 条目是「被过滤、从未推送」的记录（MessageStore 约定），不是推送历史的一部分——
    // 控制台页面是「已推送记录」，混入会让分类计数与历史失真（审查 Sourcery PR#227）。
    if (entry && typeof entry === 'object' && entry._f === true) { filteredCount += 1; continue }
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
  // rawTotal = 文件里的条目总数（含 _f）：缓存健康页的「条目数 / 上限」必须按它算，
  // 否则 _f 条目把缓存撑到超限也报不出来（D2-S11）。total 仍是「已推送记录」条数。
  const value = result('ok', { total: items.length, rawTotal: parsed.length, filteredCount, items, keys, categories, skipped })
  if (sig) {
    messagesCache.delete(cacheKey)
    messagesCache.set(cacheKey, { sig, at: Date.now(), value })
    while (messagesCache.size > MESSAGES_CACHE_MAX) messagesCache.delete(messagesCache.keys().next().value)
  }
  return value
}

module.exports = { readStatus, formatStatus, readTrends, readMessages, readMessageCount, readRunHistory, RUN_SUMMARY_LINE_RE }
