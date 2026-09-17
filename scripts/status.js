'use strict'

const path = require('node:path')
const { readSafeTextResult } = require('../xbk_storage')

const FILES = {
  run: 'run.log',
  report: 'report.state',
  channels: 'channel-health.state',
  diagnostics: 'filter-diagnostics.ndjson'
}

function result (status, value) {
  return { status, ...(value === undefined ? {} : { value }) }
}

function readText (dir, name, maxBytes = 1024 * 1024) {
  const safe = readSafeTextResult(path.join(dir, name), maxBytes)
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

function validReport (value) {
  // 与生产侧 xbk_app 读取口径对齐：七项计数只在字段存在时校验非负安全整数，
  // 缺失视为未累计（生产侧 _normalizeReportState 会归一化为 0），不再整份判 invalid。
  // CodeRabbit PR #147：date 同样要允许缺失——生产侧 _loadReportState 接受 raw.date === undefined，
  // _normalizeReportState 归一化为 ''，_updateReport 视其为首轮并补当前日期。此处原先要求
  // typeof date === 'string'，会把合法的 {"runs":1} 显示成「日报：不可读（invalid）」。
  // 审查 SS-04：存在的 date 不只校验类型，还按 _isValidReportDate 语义校验真实日期。
  return value && (value.date === undefined || isValidReportDate(value.date)) &&
    ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated'].every(key => value[key] === undefined || validCounter(value[key]))
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

function parseLastRun (read) {
  if (read.status !== 'ok') return { status: read.status }
  const lines = read.value.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    // 行首锚定：摘要行只可能是「时间戳（本地 YYYY-MM-DD HH:MM:SS 或历史 ISO）+ total=」或裸 total=，
    // 避免 ERROR/ALERT 行文本里恰好含 total=… 子串时被误取。
    const match = /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S* )?total=(\d+) dedup=(\d+) filtered=(\d+) truncated=(\d+) pushed=(\d+) failed=(\d+) elapsed=([^\s]+)/.exec(lines[i])
    if (!match) continue
    // 与 parseDiagnostics 同口径：六项计数必须是非负安全整数（超长数字经 Number 得 Infinity/超界，直接跳过该行）
    const counters = match.slice(1, 7).map(Number)
    if (!counters.every(validCounter)) continue
    return result('ok', { total: counters[0], dedup: counters[1], filtered: counters[2], truncated: counters[3], pushed: counters[4], failed: counters[5], elapsed: match[7] })
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
  // run.log / filter-diagnostics 走默认 1MB 上限（与写入侧 xbk_app 的 LIMIT 同为 1MB）：
  // 超限时 xbk_storage 只返回 tooLarge、不读尾部，fail-open 场景下这两个部件会整体不可见。
  const run = parseLastRun(readText(dir, FILES.run))
  const diagnostics = parseDiagnostics(readText(dir, FILES.diagnostics))
  return { generatedAt: now, report, channels, run, diagnostics }
}

function describe (part) {
  return part.status === 'missing' ? '缺失' : part.status === 'ok' ? '正常' : `不可读（${part.status}）`
}

function formatStatus (status) {
  const lines = [`📊 xbk-push 运行状态（${new Date(status.generatedAt).toISOString()}）`]
  const report = status.report.value
  lines.push(`日报：${describe(status.report)}${report ? ` | ${report.date || '无日期'} | ${report.runs || 0} 轮 | 推送成功：${report.pushed || 0} 条 | 失败：${report.failed || 0} 条 | 待推送（截断）：${report.truncated || 0} 条` : ''}`)
  const run = status.run.value
  lines.push(`最近一轮：${describe(status.run)}${run ? ` | 获取 ${run.total} | 去重 ${run.dedup} | 过滤 ${run.filtered} | 推送 ${run.pushed} | 失败 ${run.failed} | 截断 ${run.truncated}${run.truncated > 0 ? ' ⚠️' : ''} | 耗时 ${run.elapsed}` : ''}`)
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

module.exports = { readStatus, formatStatus }
