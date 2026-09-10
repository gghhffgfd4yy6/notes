'use strict'

// scripts/status.js 单元测试：
//   - parseLastRun invalid 分支（run.log 无匹配行）
//   - parseLastRun 多行取最后一行匹配
//   - parseDiagnostics 跳过损坏行找到有效记录
//   - formatStatus channels.value 为 null 时的降级分支
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readStatus, formatStatus } = require('./scripts/status')

let failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✅ ${name}`) } catch (e) { failed += 1; console.error(`  ❌ ${name}: ${e.message}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-'))
try {
  console.log('test_status_report')

  // ===== parseLastRun invalid 分支：run.log 存在但无匹配行 =====
  test('S1 run.log 无匹配 total=... 行 → invalid', () => {
    fs.writeFileSync(path.join(tmp, 'run.log'), '2026-09-08 12:00:00 [INFO] 启动\n2026-09-08 12:00:01 [INFO] 加载配置完成\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.run.status, 'invalid', '无匹配行应返回 invalid')
    assert.strictEqual(status.run.value, undefined, 'invalid 时不应有 value')
  })

  // ===== parseLastRun 多行取最后一行匹配 =====
  test('S2 run.log 多行匹配 → 取最后一行的值', () => {
    fs.writeFileSync(path.join(tmp, 'run.log'), [
      '2026-09-08 10:00:00 total=5 dedup=1 filtered=2 truncated=0 pushed=2 failed=0 elapsed=0.5s',
      '2026-09-08 11:00:00 total=10 dedup=3 filtered=4 truncated=1 pushed=5 failed=1 elapsed=1.2s',
      'some unrelated log line'
    ].join('\n') + '\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.run.status, 'ok', '有匹配行应返回 ok')
    assert.strictEqual(status.run.value.total, 10, '应取最后一行的 total=10，而非第一行的 5')
    assert.strictEqual(status.run.value.pushed, 5, '应取最后一行的 pushed=5')
    assert.strictEqual(status.run.value.failed, 1, '应取最后一行的 failed=1')
    assert.strictEqual(status.run.value.elapsed, '1.2s', 'elapsed 应原样保留')
  })

  // ===== parseDiagnostics 跳过损坏行找到有效记录 =====
  test('S3 diagnostics 混合损坏行 + 有效行 → 跳过损坏取最后有效', () => {
    fs.writeFileSync(path.join(tmp, 'filter-diagnostics.ndjson'), [
      '{broken json',
      JSON.stringify({ type: 'item', id: 'x' }),
      JSON.stringify({ type: 'run', at: '2026-09-08 11:00:00', total: 10, dedup: 3, filtered: 4, passed: 5, byReason: { title: 3, category: 1 }, detailCount: 4 }),
      JSON.stringify({ type: 'run', at: '2026-09-08 12:00:00', total: 20, dedup: 6, filtered: 8, passed: 10, byReason: { title: 6, category: 2 }, detailCount: 8 }),
      JSON.stringify({ type: 'run', total: 'bad' })
    ].join('\n') + '\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.diagnostics.status, 'ok', '应跳过损坏行找到有效记录')
    assert.strictEqual(status.diagnostics.value.total, 20, '应返回最后有效记录的 total=20，而非第一条的 10')
    assert.deepStrictEqual(status.diagnostics.value.byReason, { title: 6, category: 2 }, '最后有效记录的 byReason 应完整保留')
  })

  // ===== formatStatus：channels.value 为 null（status ok 但 value null）时降级 =====
  test('S4 formatStatus channels.value 为 null → 走 describe 降级分支', () => {
    const status = {
      generatedAt: 2000,
      report: { status: 'missing' },
      channels: { status: 'ok', value: null },
      run: { status: 'missing' },
      diagnostics: { status: 'missing' }
    }
    const output = formatStatus(status)
    assert.match(output, /通道健康：正常/, 'channels status=ok 但 value=null 时应显示"正常"而非崩溃')
  })

  console.log(`test_status_report OK (${failed === 0 ? '全部通过' : failed + ' 项失败'})`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
process.exit(failed > 0 ? 1 : 0)
