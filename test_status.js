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

  writeReport('{}')
  writeChannels(JSON.stringify({ pushplus: { consecutiveFailures: 'two' } }))
  writeDiagnostics(JSON.stringify({ type: 'run' }) + '\n')
  const malformed = readStatus('.')
  assert.strictEqual(malformed.report.status, 'invalid', '缺字段 report.state 不应显示正常')
  assert.strictEqual(malformed.channels.status, 'invalid', '通道失败次数必须是非负整数')
  assert.strictEqual(malformed.diagnostics.status, 'invalid', '过滤汇总必须带计数对象')

  fs.unlinkSync('run.log')
  fs.symlinkSync('/etc/passwd', 'run.log')
  assert.strictEqual(readStatus('.').run.status, 'unsafe', '符号链接必须拒绝读取')

  console.log('✅ --status 聚合并展示运行状态，损坏/缺失/符号链接文件安全降级')
} finally {
  process.chdir(previousCwd)
  fs.rmSync(dir, { recursive: true, force: true })
}
