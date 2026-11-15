'use strict'

// xbk_state_schema.js 套件（S2）：状态 schema 与派生口径**单源化**的靶向回归
//
// 背景：同一份状态/日志此前有两套读法（生产写入 xbk_app.js / 读侧 scripts/status.js），
// 两处注释都写着「镜像实现，改任一处必须同步另一处」。本套件锁三件事：
//   ① 四组边界（report.state 校验/归一化、channel-health 逐条容错、摘要行解析/格式化、派生统计）；
//   ② 写入格式与解析正则**逐字对得上**（format → parse 回环，含全部可选片段）；
//   ③ 生产文件里不得再长出第二份定义（源码形状断言：这正是 S2 要消灭的漂移源）。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const S = require('./xbk_state_schema')

let passed = 0
let failed = 0
// 跳过单独计数（评审 M1）：此前 check() 不看返回值，guard 返回 'SKIP …' 时一条断言都没跑却照样
// passed += 1 —— 在 Stryker 插桩沙箱里 B2 因此长期假绿。跳过必须单列、打印、并与声明数对账。
let skipped = 0
const failures = []
const skips = []
// 声明用例数：新增/删除用例时必须同步（结算数不符 ⇒ 直接红，避免「不执行的用例被记成通过」）。
// 42 条原有用例 + 2 条自检（恒 SKIP 探针 + 跳过记账自检，见文件末尾）。
const DECLARED_CASES = 44

function check (name, fn) {
  try {
    const r = fn()
    if (typeof r === 'string' && r.startsWith('SKIP')) {
      skipped += 1
      skips.push(r)
      return
    }
    passed += 1
  } catch (e) {
    failed += 1
    failures.push(`${name} :: ${e.message}`)
  }
}

// Stryker 沙箱内源码已插桩（stryMutAct_ 标记），源码形状断言不适用——与 test_app_unit.js 同口径。
function sourceShapeGuard (src, name) {
  return src.indexOf('stryMutAct_') !== -1 ? `SKIP ${name}（Stryker 沙箱内源码已插桩）` : null
}

const stripLineComments = (src) => src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')

const BLANK = { date: '', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
// 派生统计的固定时钟：上海 2026-09-05 10:00 ⇒ 今日键 2026-09-05、7 天窗口起点 2026-08-30。
const NOW = Date.UTC(2026, 8, 5, 2, 0, 0) // 上海 2026-09-05 10:00

// ===== isValidReportDate：闰年 / 非法月日 / 空串 / undefined / 类型守卫 =====
check('isValidReportDate 接受真实存在的日期（含闰年）', () => {
  for (const v of ['2024-02-29', '2000-02-29', '2026-01-01', '2026-12-31', '2026-04-30']) {
    assert.strictEqual(S.isValidReportDate(v), true, `${v} 应合法`)
  }
})

check('isValidReportDate 拒绝平年/百年 2 月 29 与非法月日', () => {
  for (const v of ['2023-02-29', '1900-02-29', '2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-01-00', '0000-01-01']) {
    assert.strictEqual(S.isValidReportDate(v), false, `${v} 应非法`)
  }
})

check('isValidReportDate：空串合法（缺失口径），undefined 与其它类型非法', () => {
  assert.strictEqual(S.isValidReportDate(''), true, '空串 = 未写入日期，生产侧同样接受')
  for (const v of [undefined, null, 0, 20260101, {}, [], true]) {
    assert.strictEqual(S.isValidReportDate(v), false, `${String(v)} 不是合法日期串`)
  }
})

check('isValidReportDate 拒绝 String 对象 / 带 toString 的对象（typeof 守卫不可省）', () => {
  assert.strictEqual(S.isValidReportDate(Object('2024-01-01')), false)
  assert.strictEqual(S.isValidReportDate({ toString: () => '2024-01-01' }), false)
  assert.strictEqual(S.isValidReportDate('2024-1-01'), false, '位数不足不算日期')
  assert.strictEqual(S.isValidReportDate(' 2024-01-01'), false, '前后空白不算日期')
})

// ===== validateReportState：顶层 / date / 七项计数 / pending =====
check('validateReportState：缺失或非对象一律判损坏（错误文案与生产侧 throw 逐字一致）', () => {
  for (const raw of [undefined, null, 5, 'x', true, [], [1]]) {
    const r = S.validateReportState(raw)
    assert.deepStrictEqual(r, { ok: false, error: '日报状态顶层必须是对象' }, `${String(raw)} 应判损坏`)
  }
})

check('validateReportState：空对象 ok（缺失字段视为未累计，由归一化补 0）', () => {
  assert.deepStrictEqual(S.validateReportState({}), { ok: true })
  assert.deepStrictEqual(S.validateReportState({ runs: 0, date: '' }), { ok: true })
})

check('validateReportState：非法计数逐字段点名（负数/小数/字符串/超安全整数/布尔）', () => {
  const bads = [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, true, null]
  for (const key of S.REPORT_COUNTERS) {
    for (const bad of bads) {
      const r = S.validateReportState({ [key]: bad })
      assert.deepStrictEqual(r, { ok: false, error: `日报状态字段 ${key} 无效` }, `${key}=${String(bad)} 应判非法`)
    }
    assert.deepStrictEqual(S.validateReportState({ [key]: 0 }), { ok: true }, `${key}=0 合法`)
  }
})

check('validateReportState：date 只校验「存在时合法」，非法日期点名 date 字段', () => {
  assert.deepStrictEqual(S.validateReportState({ date: '2026-02-30' }), { ok: false, error: '日报状态 date 字段无效' })
  // 用 Number('20260101') 而非数字字面量：语义同样是 number（测的仍是「date 不是字符串就判非法」），
  // 同时避开 Codacy/PMD 对 8 位数字字面量的「运行期取值不同」误报；改成非字面量表达式，断言一条没放宽。
  assert.deepStrictEqual(S.validateReportState({ date: Number('20260101') }), { ok: false, error: '日报状态 date 字段无效' })
  assert.deepStrictEqual(S.validateReportState({ date: undefined }), { ok: true }, '缺失日期合法')
})

check('validateReportState：pending 非对象判损坏（null/字符串/数字/数组），空对象合法', () => {
  for (const bad of [null, 'x', 5, true, [1]]) {
    assert.deepStrictEqual(S.validateReportState({ pending: bad }), { ok: false, error: '日报状态 pending 字段无效' },
      `pending=${String(bad)} 应判非法`)
  }
  assert.deepStrictEqual(S.validateReportState({ pending: {} }), { ok: true })
})

check('validateReportState：pending 内部计数逐字段点名（文案是「日报 pending 字段 X 无效」）', () => {
  for (const key of S.REPORT_COUNTERS) {
    const r = S.validateReportState({ pending: { [key]: -1 } })
    assert.deepStrictEqual(r, { ok: false, error: `日报 pending 字段 ${key} 无效` }, `pending.${key} 应判非法`)
  }
})

check('validateReportState：完整合法状态 + 未知键放行（未知键由归一化丢弃，不判损坏）', () => {
  const raw = { date: '2026-09-05', runs: 4, total: 20, dedup: 5, filtered: 7, pushed: 6, failed: 1, truncated: 2, junk: 'x' }
  assert.deepStrictEqual(S.validateReportState(raw), { ok: true })
  assert.deepStrictEqual(S.validateReportState({ ...raw, pending: { runs: 1 }, junk: 1 }), { ok: true })
})

// ===== normalizeReportState：默认值 / pending 重置 / 告警条件 / 独立对象 =====
check('normalizeReportState：空累计形状（8 个键、顺序与磁盘格式一致）', () => {
  const blank = S.blankReportState()
  assert.deepStrictEqual(blank, BLANK)
  assert.deepStrictEqual(Object.keys(blank), ['date', 'runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated'],
    '键顺序进 JSON.stringify，是磁盘格式的一部分')
  for (const raw of [undefined, null, 5, 'x', [], [1]]) {
    assert.deepStrictEqual(S.normalizeReportState(raw), BLANK, `${String(raw)} 归一为空累计`)
  }
})

check('normalizeReportState：逐字段走 safeCounter、未知键丢弃、date 非字符串归空串', () => {
  const got = S.normalizeReportState({
    date: '2026-03-15',
    runs: '2',
    total: -5,
    dedup: 1.5,
    filtered: true,
    pushed: 7,
    failed: Number.MAX_SAFE_INTEGER + 1,
    truncated: 0,
    junk: 9
  })
  assert.strictEqual(got.date, '2026-03-15')
  assert.strictEqual(got.runs, 2, '数字字符串按数值接受')
  assert.strictEqual(got.total, 0, '负数归 0')
  assert.strictEqual(got.dedup, 0, '小数归 0')
  assert.strictEqual(got.filtered, 0, '布尔归 0')
  assert.strictEqual(got.pushed, 7)
  assert.strictEqual(got.failed, 0, '超安全整数归 0')
  assert.strictEqual(got.junk, undefined, '名单外的键必须丢弃')
  assert.strictEqual(S.normalizeReportState({ date: 5 }).date, '')
})

check('normalizeReportState：pending 为对象时逐字段归一（含 date 占位）', () => {
  const got = S.normalizeReportState({ date: '2024-01-02', pending: { runs: '2', total: -5, pushed: 3, junk: 1 } })
  assert.deepStrictEqual(got.pending, { date: '', runs: 2, total: 0, dedup: 0, filtered: 0, pushed: 3, failed: 0, truncated: 0 })
  assert.strictEqual(got.pending.junk, undefined, 'pending 里名单外的键同样丢弃')
})

check('normalizeReportState：无 pending 键不凭空造（falsy 时不告警、不设键）', () => {
  assert.strictEqual('pending' in S.normalizeReportState({ runs: 1 }), false)
  for (const p of [null, undefined]) {
    assert.strictEqual('pending' in S.normalizeReportState({ pending: p }), false, 'falsy pending 不设键')
    assert.strictEqual(S.reportPendingNeedsReset({ pending: p }), false, 'falsy pending 不告警')
  }
})

check('normalizeReportState：pending 为其它真值时重置为空累计，且谓词要求告警', () => {
  for (const p of ['x', 5, true, [1]]) {
    const raw = { pending: p }
    assert.deepStrictEqual(S.normalizeReportState(raw).pending, BLANK, `pending=${String(p)} 应重置为空累计`)
    assert.strictEqual(S.reportPendingNeedsReset(raw), true, `pending=${String(p)} 必须告警`)
  }
  // 告警谓词与归一化同条件：顶层非对象 / pending 是普通对象 / 缺失 都不告警
  for (const raw of [undefined, null, 'x', [], {}, { pending: {} }, { pending: { runs: 0 } }]) {
    assert.strictEqual(S.reportPendingNeedsReset(raw), false, `${JSON.stringify(raw)} 不应告警`)
  }
})

check('normalizeReportState 每次返回独立对象（不共享 blank 引用）', () => {
  const a = S.normalizeReportState(null)
  const b = S.normalizeReportState(null)
  assert.notStrictEqual(a, b)
  a.runs = 99
  assert.strictEqual(b.runs, 0)
  const withPending = S.normalizeReportState({ pending: { runs: 1 } })
  assert.notStrictEqual(withPending.pending, S.blankReportState(), 'pending 也是独立对象')
})

// ===== validateChannelHealth：空表 / 一条好一条坏 / 全坏 =====
check('validateChannelHealth：空表 ok、一条好一条坏 ok（逐条容错）', () => {
  assert.strictEqual(S.validateChannelHealth({}), true, '空表 = 暂无记录，不是损坏')
  const mixed = {
    good: { consecutiveFailures: 2, lastFailureAt: 1000, lastAlertAt: 0 },
    bad: { consecutiveFailures: 1 },
    worse: 'x',
    nullish: null
  }
  assert.strictEqual(S.validateChannelHealth(mixed), true, '至少一条合格记录即整表可读')
})

check('validateChannelHealth：全坏 invalid（不假装「暂无记录」）', () => {
  assert.strictEqual(S.validateChannelHealth({ a: { consecutiveFailures: '1' }, b: {} }), false)
  assert.strictEqual(S.validateChannelHealth({ a: null }), false)
  assert.strictEqual(S.validateChannelHealth({ a: { consecutiveFailures: -1, lastFailureAt: 0, lastAlertAt: 0 } }), false)
})

check('validateChannelHealth：非对象/数组一律 invalid；单条记录判据逐字段严格', () => {
  for (const v of [null, undefined, 5, 'x', true, []]) {
    assert.strictEqual(S.validateChannelHealth(v), false, `${String(v)} 不是通道表`)
  }
  const ok = { consecutiveFailures: 0, lastFailureAt: 0, lastAlertAt: 0 }
  assert.strictEqual(S.isValidChannelHealthEntry(ok), true)
  for (const key of ['consecutiveFailures', 'lastFailureAt', 'lastAlertAt']) {
    assert.strictEqual(S.isValidChannelHealthEntry({ ...ok, [key]: undefined }), false, `${key} 缺失即该条损坏`)
    assert.strictEqual(S.isValidChannelHealthEntry({ ...ok, [key]: 1.5 }), false, `${key} 非整数即损坏`)
  }
  assert.strictEqual(S.isValidChannelHealthEntry(null), false)
  assert.strictEqual(S.isValidChannelHealthEntry([]), false)
})

// ===== RUN_SUMMARY_LINE_RE / parseRunSummaryLine =====
const SAMPLE = '2026-09-05 10:00:00 total=8 dedup=2 filtered=3 truncated=1 pushed=2 failed=1 elapsed=1.2s'

check('RUN_SUMMARY_LINE_RE 分组语义：1=整段时间戳、2..7=六项计数、8=elapsed', () => {
  const m = S.RUN_SUMMARY_LINE_RE.exec(SAMPLE)
  assert.ok(m, '样例必须命中')
  assert.strictEqual(m[1], '2026-09-05 10:00:00 ', '分组 1 是整段时间戳（含分隔空格）')
  assert.deepStrictEqual(m.slice(2, 8), ['8', '2', '3', '1', '2', '1'])
  assert.strictEqual(m[8], '1.2s')
  assert.strictEqual(m.length, 9, '分组数量固定：改分组即改所有调用方')
})

check('parseRunSummaryLine 带时间戳：at/day/counters/elapsed 全部就位', () => {
  const p = S.parseRunSummaryLine(SAMPLE)
  assert.strictEqual(p.at, '2026-09-05 10:00:00')
  assert.strictEqual(p.day, '2026-09-05', '日历日 = 时间戳前 10 位（不看宿主时区）')
  assert.deepStrictEqual(p.counters, { total: 8, dedup: 2, filtered: 3, truncated: 1, pushed: 2, failed: 1 })
  assert.strictEqual(p.elapsed, '1.2s')
})

check('parseRunSummaryLine 不带时间戳：at/day 为空串（极旧格式仍可解析计数）', () => {
  const p = S.parseRunSummaryLine('total=3 dedup=0 filtered=0 truncated=0 pushed=3 failed=0 elapsed=0.5s')
  assert.strictEqual(p.at, '')
  assert.strictEqual(p.day, '')
  assert.strictEqual(p.counters.total, 3)
  const stats = S.deriveRunStats(['total=3 dedup=0 filtered=0 truncated=0 pushed=3 failed=0 elapsed=0.5s'], NOW)
  assert.strictEqual(stats.week.rounds, 0, '无时间戳的行归不进任何一天（诚实于「不知道」）')
  assert.strictEqual(stats.today.rounds, 0)
})

check('parseRunSummaryLine 历史 ISO 时间戳：日历日仍取前 10 位', () => {
  const p = S.parseRunSummaryLine('2026-09-05T10:00:00.123Z total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=2s')
  assert.strictEqual(p.day, '2026-09-05')
  assert.strictEqual(p.at, '2026-09-05T10:00:00.123Z')
})

check('parseRunSummaryLine 可选字段：dry-run未推送 / noidentity / bad / cachesaved / similar 系列', () => {
  const dry = S.parseRunSummaryLine(SAMPLE + ' dry-run未推送=3 noidentity=2')
  assert.strictEqual(dry.extras.dryRun, 3)
  assert.strictEqual(dry.extras.noidentity, 2)
  assert.strictEqual(dry.extras.cachesaved, null, 'dry-run 行没有 cachesaved')
  // 长行里的可选字段只解析「末 64 字符」窗口内的那些（既有读侧口径：这些字段只用于运行历史展示，
  // 不参与任何聚合；窗口外的一律 null，不要在这里悄悄放宽而改变历史输出）。
  const full = S.parseRunSummaryLine(SAMPLE + ' noidentity=2 bad=1 cachesaved=1 similar=5 similarlogged=2 similardrop=1')
  assert.strictEqual(full.extras.noidentity, null, '被 similar 系列挤出 64 字符窗口的字段解析不到（既有口径）')
  assert.strictEqual(full.extras.cachesaved, 1)
  assert.strictEqual(full.extras.bad, 1)
  assert.strictEqual(full.extras.similar, 5)
  assert.strictEqual(full.extras.similarlogged, 2)
  assert.strictEqual(full.extras.similardrop, 1)
  assert.strictEqual(full.extras.dryRun, null)
  // 短行（无时间戳）时全部可选字段都在窗口内
  const compact = S.parseRunSummaryLine('total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1 noidentity=2')
  assert.deepStrictEqual(
    { cachesaved: compact.extras.cachesaved, noidentity: compact.extras.noidentity },
    { cachesaved: 1, noidentity: 2 })
})

check('parseRunSummaryLine 拒绝非法计数（非安全非负整数）整行判 null', () => {
  for (const bad of ['99999999999999999999', '99999999999999999999999']) {
    const line = `${SAMPLE.split(' total=')[0]} total=${bad} dedup=0 filtered=0 truncated=0 pushed=0 failed=0 elapsed=1s`
    assert.strictEqual(S.parseRunSummaryLine(line), null, `total=${bad} 超安全整数必须判 null（Infinity/超界）`)
  }
  assert.strictEqual(S.parseRunSummaryLine('total=-1 dedup=0 filtered=0 truncated=0 pushed=0 failed=0 elapsed=1s'), null,
    '负数不匹配 \\d+ 也不该被当成计数')
  assert.strictEqual(S.parseRunSummaryLine('total=1.5 dedup=0 filtered=0 truncated=0 pushed=0 failed=0 elapsed=1s'), null)
})

check('parseRunSummaryLine 行首锚定：ERROR/ALERT 行里含 total= 不得误命中', () => {
  const errorLine = '2026-09-05 10:00:00 ERROR 推送失败 total=8 dedup=2 filtered=3 truncated=1 pushed=2 failed=1 elapsed=1.2s'
  assert.strictEqual(S.parseRunSummaryLine(errorLine), null, '时间戳后不是 total= 即不算摘要行')
  assert.strictEqual(S.parseRunSummaryLine('  ' + SAMPLE), null, '行首有空白不算摘要行')
  assert.strictEqual(S.parseRunSummaryLine('前缀 ' + SAMPLE), null)
  assert.strictEqual(S.parseRunSummaryLine(''), null)
  assert.strictEqual(S.parseRunSummaryLine(undefined), null)
  assert.strictEqual(S.parseRunSummaryLine(123), null)
})

// ===== formatRunSummaryLine：与生产写入行逐字一致 =====
const STAMP = '2026-11-14 09:25:53'
const COUNTERS = { total: 12, dedup: 3, filtered: 4, truncated: 1, pushed: 5, failed: 2 }

check('formatRunSummaryLine 普通摘要：与 run() 旧模板字符串逐字一致（含 cachesaved）', () => {
  const got = S.formatRunSummaryLine({
    stamp: STAMP,
    counters: COUNTERS,
    elapsed: '12.3s',
    extras: { dryRun: false, noidentity: 0, bad: 0, cachesaved: true, similar: 0, similarlogged: 0, similardrop: 0 }
  })
  assert.strictEqual(got,
    '2026-11-14 09:25:53 total=12 dedup=3 filtered=4 truncated=1 pushed=5 failed=2 elapsed=12.3s cachesaved=1')
})

check('formatRunSummaryLine cachesaved=false → 0；cachesaved 缺失同样按 0 输出', () => {
  const base = { stamp: STAMP, counters: COUNTERS, elapsed: '1s' }
  assert.strictEqual(S.formatRunSummaryLine({ ...base, extras: { cachesaved: false } }),
    '2026-11-14 09:25:53 total=12 dedup=3 filtered=4 truncated=1 pushed=5 failed=2 elapsed=1s cachesaved=0')
  assert.strictEqual(S.formatRunSummaryLine({ ...base, extras: {} }),
    '2026-11-14 09:25:53 total=12 dedup=3 filtered=4 truncated=1 pushed=5 failed=2 elapsed=1s cachesaved=0')
})

check('formatRunSummaryLine dry-run：写 dry-run未推送 且**不写** cachesaved', () => {
  const got = S.formatRunSummaryLine({
    stamp: STAMP,
    counters: { total: 12, dedup: 3, filtered: 4, truncated: 1, pushed: 5, failed: 0 },
    elapsed: '4.2s',
    extras: { dryRun: true, dryRunUnpushed: 7, noidentity: 0, bad: 0, cachesaved: false, similar: 0 }
  })
  assert.strictEqual(got,
    '2026-11-14 09:25:53 total=12 dedup=3 filtered=4 truncated=1 pushed=5 failed=0 elapsed=4.2s dry-run未推送=7')
  assert.strictEqual(got.includes('cachesaved'), false, 'dry-run 行不得出现 cachesaved（旧模板 dryRun ? "" : …）')
})

check('formatRunSummaryLine noidentity+bad+cachesaved+similar 全字段：拼接顺序与旧模板一致', () => {
  const got = S.formatRunSummaryLine({
    stamp: STAMP,
    counters: COUNTERS,
    elapsed: '9.9s',
    extras: { dryRun: false, noidentity: 2, bad: 1, cachesaved: 0, similar: 5, similarlogged: 2, similardrop: 1 }
  })
  assert.strictEqual(got,
    '2026-11-14 09:25:53 total=12 dedup=3 filtered=4 truncated=1 pushed=5 failed=2 elapsed=9.9s' +
    ' noidentity=2 bad=1 cachesaved=0 similar=5 similarlogged=2 similardrop=1')
})

check('formatRunSummaryLine 零值可选片段一律不输出（旧模板的 > 0 条件）', () => {
  const got = S.formatRunSummaryLine({
    stamp: STAMP,
    counters: COUNTERS,
    elapsed: '1s',
    extras: { dryRun: true, dryRunUnpushed: 0, noidentity: 0, bad: 0, similar: 0, similarlogged: 0, similardrop: 0 }
  })
  assert.strictEqual(got, '2026-11-14 09:25:53 total=12 dedup=3 filtered=4 truncated=1 pushed=5 failed=2 elapsed=1s')
})

check('format → parse 回环：写入格式与解析正则对得上（加字段只改一边会红）', () => {
  const cases = [
    { counters: COUNTERS, elapsed: '12.3s', extras: { dryRun: false, cachesaved: 1 } },
    { counters: { ...COUNTERS, failed: 0 }, elapsed: '4.2s', extras: { dryRun: true, dryRunUnpushed: 7 } },
    { counters: COUNTERS, elapsed: '9.9s', extras: { dryRun: false, noidentity: 2, bad: 1, cachesaved: 0 } }
  ]
  for (const c of cases) {
    const line = S.formatRunSummaryLine({ stamp: STAMP, counters: c.counters, elapsed: c.elapsed, extras: c.extras })
    const parsed = S.parseRunSummaryLine(line)
    assert.ok(parsed, `格式化输出必须能被解析回来：${line}`)
    assert.deepStrictEqual(parsed.counters, c.counters, `计数回环不一致：${line}`)
    assert.strictEqual(parsed.elapsed, c.elapsed, 'elapsed 原样回环')
    assert.strictEqual(parsed.day, '2026-11-14')
  }
})

// ===== deriveRunStats：今日/近 7 天边界、未来日期、lastFailure、truncated =====
const line = (day, counters) => `${day} 09:00:00 total=${counters.total} dedup=0 filtered=0 truncated=${counters.truncated || 0} pushed=${counters.pushed} failed=${counters.failed} elapsed=${counters.elapsed || '1s'}`

check('deriveRunStats：今日/近 7 天窗口与成功率（pushed/(pushed+failed)）', () => {
  const stats = S.deriveRunStats([
    line('2026-09-05', { total: 10, pushed: 4, failed: 1 }),
    line('2026-09-05', { total: 5, pushed: 5, failed: 0 }),
    line('2026-09-04', { total: 7, pushed: 2, failed: 2 })
  ], NOW)
  assert.deepStrictEqual(stats.week, { from: '2026-08-30', to: '2026-09-05', rounds: 3, total: 22, pushed: 11, failed: 3, successRate: 11 / 14 })
  assert.deepStrictEqual(stats.today, { date: '2026-09-05', rounds: 2, total: 15, pushed: 9, failed: 1, successRate: 0.9 })
  assert.strictEqual(stats.truncated, false, '默认不截断')
})

check('deriveRunStats：窗口边界（起点当天计入、前一天不计；今日零点后计入）', () => {
  const stats = S.deriveRunStats([
    line('2026-08-30', { total: 1, pushed: 1, failed: 0 }), // 窗口第一天：计入
    line('2026-08-29', { total: 100, pushed: 100, failed: 0 }), // 窗口外：不计
    line('2026-09-05', { total: 2, pushed: 2, failed: 0 }),
    line('2026-09-06', { total: 50, pushed: 50, failed: 0 }) // 未来：不计
  ], NOW)
  assert.strictEqual(stats.week.rounds, 2)
  assert.strictEqual(stats.week.total, 3)
  assert.strictEqual(stats.today.rounds, 1)
  assert.strictEqual(stats.today.total, 2)
})

check('deriveRunStats：未来日期不污染 lastFailure；窗口内最近一条 failed>0 被记录', () => {
  const stats = S.deriveRunStats([
    line('2026-09-03', { total: 3, pushed: 1, failed: 2 }),
    line('2026-09-05', { total: 4, pushed: 3, failed: 1 }),
    line('2026-09-09', { total: 9, pushed: 0, failed: 9 }) // 未来：不得成为 lastFailure
  ], NOW)
  assert.deepStrictEqual(stats.lastFailure, { at: '2026-09-05 09:00:00', date: '2026-09-05', failed: 1 })
  const none = S.deriveRunStats([line('2026-09-05', { total: 4, pushed: 4, failed: 0 })], NOW)
  assert.strictEqual(none.lastFailure, null, '无失败时 lastFailure 为 null')
  assert.strictEqual(none.today.successRate, 1)
})

check('deriveRunStats：无尝试时 successRate 为 null（前端显示「—」）；空日志全 0', () => {
  const empty = S.deriveRunStats([], NOW)
  assert.deepStrictEqual(empty.today, { date: '2026-09-05', rounds: 0, total: 0, pushed: 0, failed: 0, successRate: null })
  assert.deepStrictEqual(empty.week, { from: '2026-08-30', to: '2026-09-05', rounds: 0, total: 0, pushed: 0, failed: 0, successRate: null })
  assert.strictEqual(empty.lastFailure, null)
})

check('deriveRunStats：truncated 标记如实透传（尾部窗口外可能还有本日/本周摘要）', () => {
  assert.strictEqual(S.deriveRunStats([], NOW, { truncated: true }).truncated, true)
  assert.strictEqual(S.deriveRunStats([], NOW, {}).truncated, false)
})

check('deriveRunStats：非法计数行与无时间戳历史行不计入聚合', () => {
  const stats = S.deriveRunStats([
    'total=99999999999999999999 dedup=0 filtered=0 truncated=0 pushed=0 failed=0 elapsed=1s',
    '2026-09-05 09:00:00 ERROR 运行异常 total=5 dedup=0 filtered=0 truncated=0 pushed=5 failed=0 elapsed=1s',
    'total=5 dedup=0 filtered=0 truncated=0 pushed=5 failed=0 elapsed=1s'
  ], NOW)
  assert.strictEqual(stats.week.rounds, 0, '不合法的行不得混进统计')
})

// ===== 源码形状：生产文件里不得再长出第二份定义（S2 的验收口径）=====
check('源码形状：生产侧不再有第二份 schema / 摘要行定义，只允许薄 wrapper', () => {
  // 测试夹具：以下三处目标都是 __dirname + 本仓库内的字面量文件名（xbk_app.js / scripts/status.js /
  // xbk_state_schema.js），不来自环境、CLI、网络或文件内容，非外部输入。形状断言本来就必须读源码
  // 文本，故按本仓既有口径加行内裸 nosemgrep（同 xbk_storage.js:222 的写法）。
  const appSrc = fs.readFileSync(path.join(__dirname, 'xbk_app.js'), 'utf8') // nosemgrep（路径 = 模块常量 __dirname + 本文件字面量文件名，不来自环境/CLI/网络/文件内容；形状断言必须读源码文本，真实防线是断言本身）
  const statusSrc = fs.readFileSync(path.join(__dirname, 'scripts/status.js'), 'utf8') // nosemgrep（路径 = 模块常量 __dirname + 本文件字面量文件名，不来自环境/CLI/网络/文件内容；形状断言必须读源码文本，真实防线是断言本身）
  const schemaSrc = fs.readFileSync(path.join(__dirname, 'xbk_state_schema.js'), 'utf8') // nosemgrep（路径 = 模块常量 __dirname + 本文件字面量文件名，不来自环境/CLI/网络/文件内容；形状断言必须读源码文本，真实防线是断言本身）
  const skip = sourceShapeGuard(appSrc + statusSrc + schemaSrc, '源码形状')
  if (skip) return skip
  const appCode = stripLineComments(appSrc)
  const statusCode = stripLineComments(statusSrc)
  const schemaCode = stripLineComments(schemaSrc)
  // 名单：字面量只在共享模块出现一次
  assert.strictEqual((schemaCode.match(/'runs', 'total'/g) || []).length, 1, '计数名单字面量只能在 xbk_state_schema')
  for (const [name, code] of [['xbk_app.js', appCode], ['scripts/status.js', statusCode]]) {
    assert.strictEqual((code.match(/'runs', 'total'/g) || []).length, 0, `${name} 不得再写字面量计数名单`)
    assert.strictEqual(/const\s+REPORT_COUNTERS\s*=/.test(code), false, `${name} 不得再定义 REPORT_COUNTERS`)
    assert.strictEqual(/const\s+RUN_SUMMARY_LINE_RE\s*=/.test(code), false, `${name} 不得再定义 RUN_SUMMARY_LINE_RE`)
    // 日期正则（year-month-day + 闰年天数表）只允许在共享模块：它是 isValidReportDate 的实现体
    assert.strictEqual(/-\(\\d\{2\}\)-\(\\d\{2\}\)/.test(code), false, `${name} 不得再内联日期正则`)
    assert.strictEqual(/const days = \[31, leap/.test(code), false, `${name} 不得再内联闰年天数表`)
    assert.strictEqual(/function\s+validReport\s*\(/.test(code), false, `${name} 不得再定义 validReport`)
    assert.strictEqual(/function\s+validPendingReport\s*\(/.test(code), false, `${name} 不得再定义 validPendingReport`)
    assert.strictEqual(/function\s+validChannels\s*\(/.test(code), false, `${name} 不得再定义 validChannels`)
  }
  // 薄 wrapper 仍存（单测/历史调用点直接打它），但必须转调共享函数
  assert.ok(/_isValidReportDate \(value\) \{\s*return isValidReportDate\(value\)/.test(appCode), 'xbk_app._isValidReportDate 必须是转调共享函数的薄 wrapper')
  assert.ok(/require\('\.\/xbk_state_schema'\)/.test(appSrc), 'xbk_app 必须从共享模块引入')
  assert.ok(/require\('\.\.\/xbk_state_schema'\)/.test(statusSrc), 'scripts/status 必须从共享模块引入')
})

check('共享模块导出齐全（缺一个就会让某个调用方退回本地实现）', () => {
  for (const name of ['REPORT_COUNTERS', 'blankReportState', 'isValidReportDate', 'validateReportState', 'normalizeReportState',
    'validateChannelHealth', 'RUN_SUMMARY_LINE_RE', 'parseRunSummaryLine', 'formatRunSummaryLine', 'deriveRunStats']) {
    assert.ok(name in S, `xbk_state_schema 必须导出 ${name}`)
  }
  assert.strictEqual(Object.isFrozen(S.REPORT_COUNTERS), true, '名单必须冻结（防止调用方原地改写）')
})

// ===== B2（S-018 / S-031）：run.log 摘要行**单源**的正反双向断言 =====
// 只做正向（源码里有 formatRunSummaryLine）挡不住真回归：旁边再长出一份内联模板时，正向照样绿，
// 而写侧两份格式串一旦漂移，读侧（RUN_SUMMARY_LINE_RE / parseRunSummaryLine）就解析不到新字段——
// 表现是「控制台趋势少一天/少一轮」，没有任何报错。故负断言与正断言必须成对存在。
check('源码形状：run.log 摘要行只能由 formatRunSummaryLine({…}) 生成（内联模板回潮必须变红）', () => {
  // 路径 = 模块常量 __dirname + 本文件字面量文件名，不来自环境/CLI/网络/文件内容（同上方源码形状用例口径）。
  const appSrc = fs.readFileSync(path.join(__dirname, 'xbk_app.js'), 'utf8') // nosemgrep（形状断言必须读源码文本；路径为字面量，非外部输入）
  const skip = sourceShapeGuard(appSrc, 'run.log 摘要行单源')
  if (skip) return skip
  assert.ok(appSrc.includes('formatRunSummaryLine({'),
    'xbk_app.js 必须调用共享的 formatRunSummaryLine({…}) 生成摘要行（换回内联模板即变红：写/读会出现两份格式串）')
  // 正向锚点再加一道：实参块必须真的把 `counters` 交进去（`formatRunSummaryLine({})` 空参也算「有调用」，
  // 那样写侧根本没把计数传给格式化函数，摘要会静默退化）。
  assert.ok(/formatRunSummaryLine\(\{\s*stamp:[^}]*counters:/.test(appSrc),
    'formatRunSummaryLine 的实参必须同时给 stamp 与 counters（空参/漏 counters 会让摘要计数静默丢失）')
  // 旧内联模板的**唯一字面量锚点**：同一个模板串里同时出现 `total=${` 与 `dedup=${`。
  // 已 grep 确认该形态在 xbk_app.js 里为 0 处（`dedup=${` 单独出现在一条 checkpoint 诊断行，不含 total=，
  // 故不会被误伤），合法出现点只有 xbk_state_schema.formatRunSummaryLine。
  const INLINE_SUMMARY = /`[^`\n]*total=\$\{[^`\n]*dedup=\$\{/
  // 样本必须**逐字**等于旧模板：`${` 在这里是字面量而非插值。
  // eslint-disable-next-line no-template-curly-in-string -- 负断言的前置样本就是旧内联模板的字面量文本
  const oldInlineSample = '`${stamp} total=${counters.total} dedup=${counters.dedup} filtered=${counters.filtered}`'
  assert.ok(INLINE_SUMMARY.test(oldInlineSample),
    '前置：负断言锚点必须能抓住旧内联模板（否则负断言恒真、等于没有）')
  assert.strictEqual(INLINE_SUMMARY.test(appSrc), false,
    'xbk_app.js 不得再内联 run.log 摘要模板（换回内联模板必须变红：写侧两份格式串会让读侧静默解析不到）')
  // 更宽的第二道（评审 nit）：不依赖「同一模板串内同现」。`total=` 在 xbk_app.js 里必须 0 处——
  // 把模板拆成两行、或用字符串拼接写 `' total=' + total`，上面那条正则都抓不到，这条能抓住。
  const totalAssignments = (appSrc.match(/(?:^|[^A-Za-z0-9_])total=/g) || []).length
  assert.strictEqual(totalAssignments, 0,
    `xbk_app.js 里不得出现任何 total= 字面（当前 ${totalAssignments} 处）：摘要的 total 只能由 formatRunSummaryLine 渲染`)
  // 反向对照：共享模块自己当然必须保留那个模板（防止有人为了过上面两条把格式化整段删掉）。
  const schemaSrc = fs.readFileSync(path.join(__dirname, 'xbk_state_schema.js'), 'utf8') // nosemgrep（同上：字面量路径 + 形状断言）
  assert.ok(INLINE_SUMMARY.test(schemaSrc),
    'xbk_state_schema.formatRunSummaryLine 必须仍保有摘要模板（删掉它等于让 run.log 摘要消失）')
})

// ===== 自检（评审二轮 F3）：check() 的 SKIP 分支必须被用例锁住 =====
// 现状（本轮修）：`check()` 认出 `SKIP …` 只是改了实现——没有任何断言锁住「跳过 ⇒ passed 不增、
// skipped+1」，而 DECLARED_CASES 对账也抓不到：跳过被计成通过时 skipped 恒 0、结算数依然对得上。
// 下面用一个**恒返回 SKIP** 的探针 + 一条读计数的自检把记账钉死：把 check() 回退成 `fn(); passed++`，
// 自检立刻红（passed 多 1、skipped 少 1），探针原文也不在 skips 里。
const skipProbeMsg = 'SKIP 自检探针（本条按设计恒跳过）：用于锁住 check() 的跳过记账'
const beforeProbe = { passed, failed, skipped }
check('自检探针（恒 SKIP）', () => skipProbeMsg)
check('自检：check() 的 SKIP 分支——跳过不计 passed、skipped 恰好 +1、原文留档、结算与声明数对账', () => {
  assert.strictEqual(passed, beforeProbe.passed,
    `跳过不得计入 passed（探针前 ${beforeProbe.passed}，现在 ${passed}）`)
  assert.strictEqual(failed, beforeProbe.failed, '跳过不得计入 failed')
  assert.strictEqual(skipped, beforeProbe.skipped + 1,
    `跳过必须计入 skipped 且恰好 +1（探针前 ${beforeProbe.skipped}，现在 ${skipped}）`)
  assert.strictEqual(skips[skips.length - 1], skipProbeMsg, '跳过必须把 SKIP 原文留档（逐条打印与定位都靠它）')
  // 本条自检尚在运行（函数返回后才计数），故结算数 +1 必须正好等于声明数——把「不执行的用例被当成
  // 通过」这一类漏算一并钉在 DECLARED_CASES 上。
  assert.strictEqual(passed + failed + skipped + 1, DECLARED_CASES,
    `结算对账：声明 ${DECLARED_CASES} 例，实际结算 ${passed + failed + skipped} 例 + 本条 = ${passed + failed + skipped + 1}`)
})

const settled = passed + failed + skipped
if (settled !== DECLARED_CASES) {
  failures.push(`用例结算对账失败：声明 ${DECLARED_CASES} 例，实际结算 ${settled} 例（通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}）`)
  failed += 1
}
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''}（声明 ${DECLARED_CASES} 例） ===`)
for (const s of skips) console.log(`  ⏭️  ${s}`)
if (failed > 0) {
  for (const f of failures) console.log(`  ❌ ${f}`)
}
process.exit(failed > 0 ? 1 : 0)
