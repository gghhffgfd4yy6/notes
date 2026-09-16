'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readStatus, formatStatus } = require('./scripts/status')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-'))
const previousCwd = process.cwd()

function writeRunLog (value) { fs.writeFileSync('run.log', value) }
function writeReport (value) { fs.writeFileSync('report.state', value) }
function writeChannels (value) { fs.writeFileSync('channel-health.state', value) }
function writeDiagnostics (value) { fs.writeFileSync('filter-diagnostics.ndjson', value) }

try {
  process.chdir(dir)
  writeRunLog('2026-09-05 10:00:00 total=8 dedup=2 filtered=3 truncated=1 pushed=2 failed=1 elapsed=1.2s\n')
  writeReport(JSON.stringify({ date: '2026-09-05', runs: 4, total: 20, dedup: 5, filtered: 7, pushed: 6, failed: 1, truncated: 2 }))
  writeChannels(JSON.stringify({ pushplus: { consecutiveFailures: 2, lastFailureAt: 1000, lastAlertAt: 0 }, bark: { consecutiveFailures: 0, lastFailureAt: 0, lastAlertAt: 0 } }))
  writeDiagnostics([
    JSON.stringify({ type: 'run', at: '2026-09-05 10:00:00', total: 8, dedup: 2, filtered: 3, passed: 2, byReason: { title: 2, category: 1 }, detailCount: 3 }),
    JSON.stringify({ type: 'item', id: 'x' })
  ].join('\n') + '\n')

  const status = readStatus('.', { now: 2000 })
  assert.strictEqual(status.report.value.runs, 4)
  assert.strictEqual(status.report.value.pushed, 6)
  assert.strictEqual(status.channels.value.pushplus.consecutiveFailures, 2)
  assert.deepStrictEqual(status.diagnostics.value.byReason, { title: 2, category: 1 })
  assert.strictEqual(status.run.value.total, 8)
  assert.strictEqual(status.run.value.failed, 1)
  const output = formatStatus(status)
  assert.match(output, /运行状态/)
  assert.match(output, /推送成功：6 条/)
  assert.match(output, /pushplus：连续失败 2 次/)
  assert.match(output, /title=2/)

  writeReport('{broken')
  fs.unlinkSync('channel-health.state')
  const degraded = readStatus('.', { now: 2000 })
  assert.strictEqual(degraded.report.status, 'invalid')
  assert.strictEqual(degraded.channels.status, 'missing')
  assert.match(formatStatus(degraded), /不可读|缺失/)

  // `{}`（无 date、无计数）在生产侧 _loadReportState 里是**合法**的空累计状态（_normalizeReportState
  // 归一化为 blank：date→''、计数→0），故 --status 也必须显示正常。此前这里断言 invalid，
  // 与生产口径冲突（CodeRabbit PR #147 指出 date 缺失同样应被接受）——修的是断言，不是放宽整个校验。
  writeReport('{}')
  writeChannels(JSON.stringify({ pushplus: { consecutiveFailures: 'two' } }))
  writeDiagnostics(JSON.stringify({ type: 'run' }) + '\n')
  const blankState = readStatus('.')
  assert.strictEqual(blankState.report.status, 'ok', '{} 是合法空累计状态，应与生产 _loadReportState 同口径')
  assert.strictEqual(blankState.channels.status, 'invalid', '通道失败次数必须是非负整数')
  assert.strictEqual(blankState.diagnostics.status, 'invalid', '过滤汇总必须带计数对象')

  // 真正非法的 report.state 仍必须判 invalid（证明不是把校验整段放开）：
  // ① 计数为负 —— 生产侧同样判非法；② date 存在但类型错误。
  writeReport(JSON.stringify({ runs: -1 }))
  assert.strictEqual(readStatus('.').report.status, 'invalid', '负计数 report.state 必须判非法')
  writeReport(JSON.stringify({ date: 123, runs: 1 }))
  assert.strictEqual(readStatus('.').report.status, 'invalid', 'date 存在但非字符串必须判非法')

  fs.unlinkSync('run.log')
  fs.symlinkSync('/etc/passwd', 'run.log')
  assert.strictEqual(readStatus('.').run.status, 'unsafe', '符号链接必须拒绝读取')

  console.log('✅ --status 聚合并展示运行状态，损坏/缺失/符号链接文件安全降级')
} finally {
  process.chdir(previousCwd)
  fs.rmSync(dir, { recursive: true, force: true })
}
