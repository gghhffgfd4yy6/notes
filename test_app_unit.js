'use strict'

// xbk_app.js 单元套件（报告/状态簇）：进程内调用 createApp() 返回对象上的
// _isValidReportDate / _normalizeReportState / _loadReportState /
// _blankReportState / _safeCounter / _reportToday 纯函数与方法。
// 断言对着契约与源码意图（SYSTEM_CONTRACT.md「缓存/时间」、README「运行日报」），
// 不硬编码内部快照、不依赖真实文件系统布局与时区、不依赖 new Date() 取真实时间。

const assert = require('assert')
const path = require('path')
const crypto = require('crypto')

const { createApp } = require('./xbk_app.js')

let passed = 0
let failed = 0
const failures = []

function check (name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    failures.push(`${name} :: ${e.message}`)
  }
}

// 桩：fs / readSafeTextResult 全部由本文件控制，不触碰真实缓存目录
const stub = { exists: false, readResult: { status: 'missing', text: '' }, readCalls: 0, lastMax: null }

function makeApp () {
  stub.exists = false
  stub.readResult = { status: 'missing', text: '' }
  stub.readCalls = 0
  stub.lastMax = null
  return createApp({
    Config: {},
    Utils: { safeErrorText: (e, d) => String((e && e.message) || d) },
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: {},
    Network: {},
    Pusher: {},
    fs: { existsSync: () => stub.exists },
    path,
    crypto,
    readSafeTextResult: (p, max) => { stub.readCalls++; stub.lastMax = max; return stub.readResult },
    writeAtomic: () => true,
    isRegularOrMissing: () => true,
    STATE_TEXT_MAX_BYTES: 262144,
    DEFAULT_MAX_SIZE: 1048576,
    RE2C: null,
    RE2_WARN_STATE_FILE: '',
    RE2_MISSING_WARNING: '',
    summarizeError: () => '',
    PROFILE3: false,
    PROFILE3_BOOT_MARKS: [],
    prewarmDns: () => {},
    prewarmTls: () => {},
    getNotify: () => null,
    PKG_VERSION: '0.0.0',
    trimTrailingSlashes: (s) => s,
    compileUserRegex: () => {}
  })
}

const app = makeApp()
const blank = { date: '', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }

function withCapture (level, fn) {
  const orig = console[level]
  const msgs = []
  console[level] = (...a) => msgs.push(a.map(String).join(' '))
  try {
    return { value: fn(), msgs }
  } finally {
    console[level] = orig
  }
}

// ===== _isValidReportDate：正则形状 / 界内 / 闰年 / 月天数表 =====
const validDates = [
  '',
  '2024-01-01',
  '2024-01-31',
  '2024-12-31',
  '2024-02-29',
  '2000-02-29',
  '1900-02-28',
  '2023-02-28',
  '0001-01-01',
  '9999-12-31',
  '2024-04-30',
  '2024-06-30',
  '2024-09-30',
  '2024-11-30'
]
for (const v of validDates) {
  check(`_isValidReportDate(${JSON.stringify(v)}) === true`, () => {
    assert.strictEqual(app._isValidReportDate(v), true, `${JSON.stringify(v)} 应合法`)
  })
}

const invalidDates = [
  [null, '非字符串 null 必须为假'],
  [undefined, '非字符串 undefined 必须为假'],
  [20240101, '数字必须为假（typeof 守卫）'],
  [{}, '对象必须为假'],
  ['2024-1-01', '月份必须两位（\\d{2} 形状）'],
  ['2024-01-1', '日必须两位（\\d{2} 形状）'],
  ['24-01-01', '年份必须四位（\\d{4} 形状）'],
  ['2024/01/01', '分隔符必须为 -'],
  ['2024-01-01 ', '尾部空格必须为假'],
  ['x2024-01-01', '首部垃圾必须为假'],
  ['2024-13-01', 'month 13 越界'],
  ['2024-00-01', 'month 0 越界'],
  ['2024-01-00', 'day 0 越界'],
  ['2024-01-32', 'day 32 越界'],
  ['2024-04-31', '4 月只有 30 天'],
  ['2024-06-31', '6 月只有 30 天'],
  ['2024-09-31', '9 月只有 30 天'],
  ['2024-11-31', '11 月只有 30 天'],
  ['2023-02-29', '平年无 2/29'],
  ['1900-02-29', '1900 非闰年（100 倍数且非 400 倍数）'],
  ['2100-02-29', '2100 非闰年'],
  ['2024-02-30', '2 月不存在 30 日'],
  ['0000-01-01', 'year 0 越界']
]
for (const [v, why] of invalidDates) {
  check(`_isValidReportDate(${JSON.stringify(v)}) === false（${why}）`, () => {
    assert.strictEqual(app._isValidReportDate(v), false, `${JSON.stringify(v)} 应非法`)
  })
}

check('_isValidReportDate 拒绝 String 对象/带 toString 的对象（typeof 守卫不可省）', () => {
  // 杀 typeof value !== 'string' 守卫被整体短路掉的变异体（正则 exec 会 ToString 强转）
  assert.strictEqual(app._isValidReportDate(Object('2024-01-01')), false, 'String 对象不是字符串')
  assert.strictEqual(app._isValidReportDate({ toString: () => '2024-01-01' }), false, 'toString 可伪造日期也必须为假')
})

// ===== _blankReportState：8 个字段与 0 初值的精确形状 =====
check('_blankReportState 返回 7 个计数器全 0 且 date 为空的精确对象', () => {
  assert.deepStrictEqual(app._blankReportState(), blank)
})

// ===== _safeCounter：非负安全整数白名单，其余一律 0 =====
check('_safeCounter 接受 0 / 正整数 / 数字字符串 / MAX_SAFE_INTEGER', () => {
  assert.strictEqual(app._safeCounter(0), 0)
  assert.strictEqual(app._safeCounter(5), 5)
  assert.strictEqual(app._safeCounter('7'), 7)
  assert.strictEqual(app._safeCounter(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
})
check('_safeCounter 拒绝负数 / 小数 / 超安全整数 / 布尔 / 非数字', () => {
  assert.strictEqual(app._safeCounter(-1), 0)
  assert.strictEqual(app._safeCounter(1.5), 0)
  assert.strictEqual(app._safeCounter(Number.MAX_SAFE_INTEGER + 1), 0)
  assert.strictEqual(app._safeCounter(true), 0)
  assert.strictEqual(app._safeCounter(false), 0)
  assert.strictEqual(app._safeCounter('abc'), 0)
  assert.strictEqual(app._safeCounter(null), 0)
  assert.strictEqual(app._safeCounter(undefined), 0)
  assert.strictEqual(app._safeCounter(Infinity), 0)
  assert.strictEqual(app._safeCounter(NaN), 0)
})
check('_safeCounter(Symbol) 返回 0 而不抛 TypeError', () => {
  assert.strictEqual(app._safeCounter(Symbol('x')), 0)
})

// ===== _normalizeReportState：形状归一 =====
for (const bad of [null, undefined, 42, 'text', true]) {
  check(`_normalizeReportState(${String(bad)}) 归一为空累计`, () => {
    assert.deepStrictEqual(app._normalizeReportState(bad), blank)
  })
}
check('_normalizeReportState 数组（含自建属性）归一为空累计', () => {
  const arr = [1, 2]
  arr.date = '2024-01-01'
  arr.runs = 9
  assert.deepStrictEqual(app._normalizeReportState(arr), blank)
})
check('_normalizeReportState 逐字段走 _safeCounter 且未知键被丢弃', () => {
  const got = app._normalizeReportState({
    date: '2024-01-01',
    runs: '5',
    total: -1,
    dedup: 1.5,
    filtered: true,
    pushed: Infinity,
    failed: 'x',
    truncated: Number.MAX_SAFE_INTEGER,
    extra: 'ignored'
  })
  assert.deepStrictEqual(got, {
    date: '2024-01-01', runs: 5, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: Number.MAX_SAFE_INTEGER
  })
})
check('_normalizeReportState date 非字符串归为空串', () => {
  assert.strictEqual(app._normalizeReportState({ date: 5 }).date, '')
  assert.strictEqual(app._normalizeReportState({ date: '2024-01-01' }).date, '2024-01-01')
})
check('_normalizeReportState 缺失计数器补 0（不保留 undefined）', () => {
  assert.deepStrictEqual(app._normalizeReportState({}), blank)
})
check('_normalizeReportState 无 pending 键时不凭空造 pending', () => {
  assert.strictEqual('pending' in app._normalizeReportState({ runs: 1 }), false)
})
check('_normalizeReportState pending 为对象时逐字段归一', () => {
  const got = app._normalizeReportState({ date: '2024-01-02', pending: { runs: '2', total: -5, pushed: 3 } })
  assert.deepStrictEqual(got.pending, { date: '', runs: 2, total: 0, dedup: 0, filtered: 0, pushed: 3, failed: 0, truncated: 0 })
  assert.strictEqual(got.date, '2024-01-02')
})
check('_normalizeReportState pending 为其它真值时保留占位并 console.warn 告警', () => {
  for (const p of ['x', 5, true, [1]]) {
    const rows = withCapture('warn', () => app._normalizeReportState({ pending: p }))
    assert.strictEqual(rows.msgs.length, 1, `pending=${JSON.stringify(p)} 必须大声告警一次`)
    assert.ok(/pending/.test(rows.msgs[0]), '告警正文必须点名 pending 字段')
    assert.deepStrictEqual(rows.value.pending, blank, 'pending 占位应为空累计')
  }
})
check('_normalizeReportState pending 为 null/缺失时不告警且不设 pending', () => {
  for (const p of [null, undefined]) {
    const rows = withCapture('warn', () => app._normalizeReportState({ pending: p }))
    assert.strictEqual(rows.msgs.length, 0, 'falsy pending 不应告警')
    assert.strictEqual('pending' in rows.value, false)
  }
})
check('_normalizeReportState 每次返回独立对象（不共享 blank 引用）', () => {
  const a = app._normalizeReportState(null)
  const b = app._normalizeReportState(null)
  assert.notStrictEqual(a, b)
  a.runs = 99
  assert.strictEqual(b.runs, 0)
})

// ===== _loadReportState：读状态文件各分支 =====
const P = '/stub/report.state'

check('_loadReportState 文件缺失 ⇒ 空累计，且以 STATE_TEXT_MAX_BYTES 读文件', () => {
  const a = makeApp()
  stub.readResult = { status: 'missing', text: '' }
  assert.deepStrictEqual(a._loadReportState(P), blank)
  assert.strictEqual(stub.readCalls, 1)
  assert.strictEqual(stub.lastMax, 262144)
})

check('_loadReportState 合法文件 ⇒ 归一后的状态', () => {
  const a = makeApp()
  stub.readResult = { status: 'ok', text: JSON.stringify({ date: '2024-01-02', runs: 1, total: 10, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6 }) }
  assert.deepStrictEqual(a._loadReportState(P), { date: '2024-01-02', runs: 1, total: 10, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6 })
})

check('_loadReportState 合法文件 + 合法 pending ⇒ pending 只归一 7 个计数器（date 不继承）', () => {
  const a = makeApp()
  stub.readResult = { status: 'ok', text: JSON.stringify({ date: '2024-01-02', runs: 0, pending: { date: '2024-01-01', total: 7 } }) }
  const got = a._loadReportState(P)
  assert.deepStrictEqual(got.pending, { date: '', runs: 0, total: 7, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 })
})

check('_loadReportState 合法文件且 date 缺省/为空串 ⇒ 照常返回（不跳过）', () => {
  const a = makeApp()
  stub.readResult = { status: 'ok', text: JSON.stringify({ runs: 1 }) }
  assert.strictEqual(a._loadReportState(P).runs, 1)
  stub.readResult = { status: 'ok', text: JSON.stringify({ date: '', runs: 2 }) }
  assert.strictEqual(a._loadReportState(P).runs, 2)
})

// 损坏/形状异常 ⇒ null（跳过本轮以保留原文件），并 loud 告警
const corruptTexts = [
  ['not json', 'JSON 解析失败'],
  ['{', '不完整 JSON'],
  ['[]', '顶层数组'],
  ['null', '顶层 null'],
  ['5', '顶层数字'],
  ['"x"', '顶层字符串'],
  ['{"date":"2024-13-01"}', 'date 非法（月 13）'],
  ['{"date":"2024-02-30"}', 'date 非法（2/30）'],
  ['{"date":5}', 'date 非字符串'],
  ['{"runs":-1}', 'runs 为负'],
  ['{"runs":1.5}', 'runs 非整数'],
  ['{"runs":"3"}', 'runs 为字符串'],
  ['{"total":null}', 'total 为 null'],
  ['{"pending":"x"}', 'pending 非对象'],
  ['{"pending":[]}', 'pending 为数组'],
  ['{"pending":{"runs":-1}}', 'pending 计数器为负'],
  ['{"pending":{"dedup":1.5}}', 'pending 计数器非整数']
]
for (const [text, why] of corruptTexts) {
  check(`_loadReportState 损坏状态（${why}）⇒ null 且跳过本轮、告警`, () => {
    const a = makeApp()
    stub.readResult = { status: 'ok', text }
    const rows = withCapture('error', () => a._loadReportState(P))
    assert.strictEqual(rows.value, null, '损坏时必须跳过更新以保留原文件')
    assert.ok(rows.msgs.length >= 1, '必须 console.error 告警')
    assert.ok(rows.msgs.join(' ').includes('跳过本次日报更新'), '告警须说明跳过本轮更新')
  })
}

// 每个字段名都必须被逐字段校验（杀掉把字段名字面量换成 '' / 别的名字的 StringLiteral 变异体）
for (const k of ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
  check(`_loadReportState 顶层字段 ${k} 为负 ⇒ null（字段名硬校验）`, () => {
    const a = makeApp()
    stub.readResult = { status: 'ok', text: JSON.stringify({ [k]: -1 }) }
    const rows = withCapture('error', () => a._loadReportState(P))
    assert.strictEqual(rows.value, null, `${k} 为负必须判损坏`)
  })
  check(`_loadReportState pending.${k} 为负 ⇒ null（字段名硬校验）`, () => {
    const a = makeApp()
    stub.readResult = { status: 'ok', text: JSON.stringify({ pending: { [k]: -1 } }) }
    const rows = withCapture('error', () => a._loadReportState(P))
    assert.strictEqual(rows.value, null, `pending.${k} 为负必须判损坏`)
  })
}

check('_loadReportState 读取非 missing 失败（超限/错误）⇒ null 且不重置累计', () => {
  for (const status of ['too-large', 'error', 'denied']) {
    const a = makeApp()
    stub.readResult = { status, text: '' }
    const rows = withCapture('error', () => a._loadReportState(P))
    assert.strictEqual(rows.value, null, `${status} 时不得返回空累计（会静默清账）`)
    assert.ok(rows.msgs.join(' ').includes('跳过本次日报更新'), '告警须说明跳过本轮更新')
  }
})

check('_loadReportState 内存状态已持久化但文件消失 ⇒ 丢弃内存并重新读（空累计）', () => {
  const a = makeApp()
  a._reportMemoryStateByPath.set(P, { state: { date: '2024-01-05', runs: 9 }, persisted: true })
  stub.exists = false
  stub.readResult = { status: 'missing', text: '' }
  assert.deepStrictEqual(a._loadReportState(P), blank)
  assert.strictEqual(a._reportMemoryStateByPath.has(P), false)
  assert.strictEqual(stub.readCalls, 1)
})

check('_loadReportState 内存状态已持久化且文件在 ⇒ 直接用内存状态（不读文件）', () => {
  const a = makeApp()
  a._reportMemoryStateByPath.set(P, { state: { date: '2024-01-05', runs: '9' }, persisted: true })
  stub.exists = true
  assert.strictEqual(a._loadReportState(P).runs, 9)
  assert.strictEqual(stub.readCalls, 0)
})

check('_loadReportState 内存状态未持久化且文件缺失 ⇒ 保留内存状态', () => {
  const a = makeApp()
  a._reportMemoryStateByPath.set(P, { state: { date: '2024-01-05', runs: 9 }, persisted: false })
  stub.exists = false
  assert.strictEqual(a._loadReportState(P).runs, 9)
  assert.strictEqual(a._reportMemoryStateByPath.has(P), true)
  assert.strictEqual(stub.readCalls, 0)
})

// ===== _reportToday：日报日界固定 Asia/Shanghai（与进程 TZ 无关） =====
check('_reportToday 用 Asia/Shanghai 日界，UTC 20:00 已跨到次日', () => {
  const RealDate = Date
  const FIXED = RealDate.UTC(2024, 2, 15, 20, 0, 0) // 2024-03-15T20:00Z = 上海 2024-03-16 04:00
  class FakeDate extends RealDate {
    constructor (...a) { if (a.length === 0) super(FIXED); else super(...a) }
    static now () { return FIXED }
  }
  let got
  global.Date = FakeDate
  try {
    got = makeApp()._reportToday()
  } finally {
    global.Date = RealDate
  }
  assert.strictEqual(got, '2024-03-16', '日界必须是 Asia/Shanghai（UTC 20:00 已进入上海次日）')
  assert.notStrictEqual(got, '2024-03-15', '不得使用 UTC/本地日界')
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(got), '格式必须为 sv-SE 的 YYYY-MM-DD')
})

console.log(`通过 ${passed} / 失败 ${failed}`)
if (failed > 0) {
  for (const f of failures) console.log(`  ❌ ${f}`)
  process.exit(1)
}
process.exit(0)
