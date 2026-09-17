'use strict'

// scripts/status.js 单元测试：
//   - parseLastRun invalid 分支（run.log 无匹配行）
//   - parseLastRun 多行取最后一行匹配
//   - parseLastRun 行首锚定：真实摘要行仍可解析、行中间内嵌 total= 不再误命中
//   - parseDiagnostics 跳过损坏行找到有效记录
//   - validReport 容忍缺失计数字段（存在的字段仍须校验）
//   - validReport 容忍缺失 date 字段（date 存在时仍须为字符串，CodeRabbit PR #147）
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

  // ===== parseLastRun 行首锚定：真实写入格式（时间戳前缀 + 尾部附加字段）仍可解析 =====
  test('S5 run.log 真实摘要行（时间戳+尾部 dry-run/noidentity）+ 其后 ERROR 行内嵌 total= 子串 → 取真实摘要行', () => {
    fs.writeFileSync(path.join(tmp, 'run.log'), [
      '2026-09-08 10:00:00 total=42 dedup=5 filtered=7 truncated=2 pushed=28 failed=2 elapsed=3.4s dry-run未推送=3 noidentity=1',
      '2026-09-08 10:05:00 ERROR [v3.999.0] ⚠️ xbk-push 运行异常 原因：HTTP 500 total=99 dedup=99 filtered=99 truncated=99 pushed=99 failed=99 elapsed=9.9s'
    ].join('\n') + '\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.run.status, 'ok', '真实写入格式（时间戳前缀 total=… elapsed=…s）应被解析')
    assert.strictEqual(status.run.value.total, 42, '应取真实摘要行的 total=42，而非其后 ERROR 行内嵌的 total=99')
    assert.strictEqual(status.run.value.truncated, 2, 'truncated=2 应原样解析')
    assert.strictEqual(status.run.value.pushed, 28, 'pushed=28 应原样解析')
    assert.strictEqual(status.run.value.elapsed, '3.4s', 'elapsed 应原样保留（含尾部 s）')
  })

  // ===== parseLastRun 行首锚定：行中间内嵌的 total=… 不再被误命中 =====
  test('S6 run.log 仅 ERROR 行内嵌 total=… 子串（行首为其它文字）→ invalid', () => {
    fs.writeFileSync(path.join(tmp, 'run.log'), [
      '2026-09-08 12:00:00 [ERROR] 运行异常 原因：bad response total=5 dedup=1 filtered=2 truncated=0 pushed=2 failed=0 elapsed=0.5s',
      'ERROR 流水线中断 total=7 dedup=1 filtered=1 truncated=0 pushed=1 failed=1 elapsed=0.1s'
    ].join('\n') + '\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.run.status, 'invalid', '行中间的 total= 不应被当作摘要行')
    assert.strictEqual(status.run.value, undefined, 'invalid 时不应有 value')
  })

  // ===== validReport：缺失计数字段不再是整表 invalid，但已存在的字段仍须校验 =====
  test('S7 report.state 缺失计数字段 → ok（date 必需）；已存在但非法的计数 → 仍 invalid', () => {
    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ date: '2026-09-08' }) + '\n')
    let status = readStatus(tmp)
    assert.strictEqual(status.report.status, 'ok', '仅有 date、七项计数全缺失的 report.state 应视为 ok')
    assert.strictEqual(status.report.value.date, '2026-09-08', 'value 应原样保留')

    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ date: '2026-09-08', runs: 3, pushed: 9 }) + '\n')
    status = readStatus(tmp)
    assert.strictEqual(status.report.status, 'ok', '部分计数字段缺失时仍应视为 ok')
    assert.strictEqual(status.report.value.pushed, 9, '已存在的计数字段应保留')

    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ date: '2026-09-08', total: -1 }) + '\n')
    assert.strictEqual(readStatus(tmp).report.status, 'invalid', '已存在的计数字段仍须校验：负数应 invalid')

    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ date: '2026-09-08', pushed: 'x' }) + '\n')
    assert.strictEqual(readStatus(tmp).report.status, 'invalid', '已存在的计数字段仍须校验：非整数应 invalid')
  })

  // ===== validReport：date 缺失同样合法（CodeRabbit PR #147），但 date 存在时必须仍是字符串 =====
  // 生产侧 _loadReportState 接受 raw.date === undefined、_normalizeReportState 归一化为 ''，
  // 故合法的 {"runs":1} 不得被显示成「日报：不可读（invalid）」；修前该用例为 invalid。
  test('S8 report.state 缺 date 字段 → ok（date 存在但非字符串仍 invalid）', () => {
    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ runs: 1 }) + '\n')
    const first = readStatus(tmp)
    assert.strictEqual(first.report.status, 'ok', '仅有 runs、date 缺失的 report.state 应视为 ok（修前为 invalid）')
    assert.strictEqual(first.report.value.runs, 1, 'value 应原样保留')

    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({}) + '\n')
    assert.strictEqual(readStatus(tmp).report.status, 'ok', '空对象（date 与七项计数全缺失）同样应视为 ok')

    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ runs: 1, date: 123 }) + '\n')
    assert.strictEqual(readStatus(tmp).report.status, 'invalid', 'date 存在但为数字仍须 invalid（校验不能整体放开）')

    fs.writeFileSync(path.join(tmp, 'report.state'), JSON.stringify({ runs: 1, date: null }) + '\n')
    assert.strictEqual(readStatus(tmp).report.status, 'invalid', 'date=null 不是 undefined、也不是字符串 → 仍 invalid')
  })

  // ===== SS-02：channel-health 单条损坏不得整表 invalid（健康通道信息必须保留）=====
  // 旧实现 validChannels 是 Object.values(...).every(...) 全表口径：一条坏记录即整表 invalid，
  // formatStatus 于是走 describe → 只显示「不可读（invalid）」，所有健康通道一并消失。
  test('S9 channel-health 单条损坏 → 整表仍 ok，健康通道照常展示且明示被忽略条数', () => {
    fs.writeFileSync(path.join(tmp, 'channel-health.state'), JSON.stringify({
      good: { consecutiveFailures: 0, lastFailureAt: 0, lastAlertAt: 0 },
      pushplus: { consecutiveFailures: 3, lastFailureAt: 1000, lastAlertAt: 0 },
      bad: { consecutiveFailures: 'x', lastFailureAt: 0, lastAlertAt: 0 }
    }) + '\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.channels.status, 'ok', '存在健康条目时不得因一条损坏判整表 invalid（修前为 invalid）')
    const output = formatStatus(status)
    assert.match(output, /good：连续失败 0 次/, '健康通道 good 必须照常展示（修前整行丢失）')
    assert.match(output, /pushplus：连续失败 3 次/, '健康通道 pushplus 必须照常展示')
    assert.doesNotMatch(output, /bad/, '损坏条目本身不得被当作健康记录展示')
    assert.match(output, /另有 1 条记录损坏已忽略/, '被忽略的损坏条数必须明示，不得静默丢弃')
    assert.doesNotMatch(output, /通道健康：不可读/, '有健康条目时不得整体报不可读')
  })

  test('S10 channel-health 全部损坏 → 整表 invalid；空表 → ok 且显示暂无记录', () => {
    fs.writeFileSync(path.join(tmp, 'channel-health.state'), JSON.stringify({
      only: { consecutiveFailures: 'x' }
    }) + '\n')
    assert.strictEqual(readStatus(tmp).channels.status, 'invalid', '有记录且无一合格时整表判 invalid（不假装「暂无记录」）')

    fs.writeFileSync(path.join(tmp, 'channel-health.state'), '{}\n')
    const empty = readStatus(tmp)
    assert.strictEqual(empty.channels.status, 'ok', '空表仍是合法状态（保持旧行为）')
    assert.match(formatStatus(empty), /通道健康：暂无记录/, '空表应显示暂无记录')
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
