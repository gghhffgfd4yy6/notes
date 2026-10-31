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
// 声明数（C5-004）：每注册一条用例（同步 check / 异步 checkAsync）就 +1，与「结算数 passed+failed」
// 对账。asyncChecks 曾靠「for…of 读活数组」顺带跑到 drain 之后注册的用例，一旦 drain 前移或
// 注册前出现真正的异步等待，那些用例会静默不跑且没有任何计数能看出来。
let declared = 0
const failures = []

function check (name, fn) {
  declared += 1
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

function makeApp (over = {}) {
  stub.exists = false
  stub.readResult = { status: 'missing', text: '' }
  stub.readCalls = 0
  stub.lastMax = null
  return createApp({
    Config: Object.assign({}, over.Config),
    Utils: Object.assign({ safeErrorText: (e, d) => String((e && e.message) || d) }, over.Utils),
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: Object.assign({}, over.MessageStore),
    // 过滤规则存储层：默认桩只覆盖 run() 用到的两个入口，避免既有单测因缺依赖而抛错。
    // 真正的「两轮生效 / 损坏降级」回归用例用专用 harness 注入真实 FilterStore（见文件末尾）。
    FilterStore: over.FilterStore || {
      loadFilterRules: () => ({ filter: {}, keyword: { zkt_gjc: '' }, source: 'default', revision: 0, degraded: false, lastGoodUsed: false }),
      writeAppliedSnapshot: () => true,
      readAppliedSnapshot: () => ({ status: 'missing' })
    },
    Network: {},
    Pusher: {},
    fs: Object.assign({ existsSync: () => stub.exists }, over.fs),
    path,
    crypto,
    readSafeTextResult: (p, max) => { stub.readCalls++; stub.lastMax = max; return stub.readResult },
    writeAtomic: over.writeAtomic || (() => true),
    isRegularOrMissing: over.isRegularOrMissing || (() => true),
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
  assert.strictEqual(app._safeCounter(Number.NaN), 0)
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
    date: '2024-01-01',
    runs: 5,
    total: 0,
    dedup: 0,
    filtered: 0,
    pushed: 0,
    failed: 0,
    truncated: Number.MAX_SAFE_INTEGER
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

// ============================================================
// 追加：日志/状态写入簇（_writeRunLog / _warnLowDisk / _writeState /
// _persistReportState / _writeTextAtomic / _isRegularOrMissing / _localStamp）
// 全部经注入桩控制 fs / Utils / Config / MessageStore：不碰真实磁盘、真实余量、
// 真实文件系统布局；时钟口径用固定时刻或相对偏移。
// ============================================================
const CACHE_DIR = '/vcache'
const LOG_PATH = path.join(CACHE_DIR, 'run.log')
const LOCK_PATH = LOG_PATH + '.lock'
const KEEP = 512 * 1024
const LIMIT = 1024 * 1024

function makeLogFs (over = {}) {
  const rec = { append: [], open: [], write: [], read: [], close: [], unlink: [], stat: [] }
  const stub = {
    existsSync: () => true,
    openSync (p, flag) {
      rec.open.push([p, flag])
      if (over.openSync) return over.openSync(p, flag)
      return flag === 'r+' ? 8 : 7
    },
    writeSync (fd, data) { rec.write.push([fd, String(data)]) },
    appendFileSync (p, data, enc) {
      if (over.appendThrows) throw new Error('append 失败')
      rec.append.push([p, String(data), enc])
    },
    statSync (p) {
      rec.stat.push(p)
      if (over.statThrows) throw new Error('stat 失败')
      return { size: over.size === undefined ? 0 : over.size, mtimeMs: over.mtimeMs === undefined ? Date.now() : over.mtimeMs }
    },
    readSync (fd, buf, off, len, pos) {
      rec.read.push([fd, len, pos, buf.length])
      if (over.tail !== undefined) Buffer.from(over.tail, 'utf8').copy(buf, off)
      return len
    },
    closeSync (fd) { rec.close.push(fd) },
    unlinkSync (p) { rec.unlink.push(p) }
  }
  return { rec, stub }
}

function makeUtils (over = {}) {
  return Object.assign({
    safeErrorText: (e, d) => String((e && e.message) || d),
    num: (v, d) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d),
    diskSpace: () => null,
    truncateUtf16: (s, n) => s.slice(0, n)
  }, over)
}

function makeLogApp (opts = {}) {
  const cap = []
  const app = makeApp({
    Config: opts.Config,
    MessageStore: opts.MessageStore || {
      cacheDir: CACHE_DIR,
      _getTombstoneProcessStart: () => 42,
      _isTombstoneLockProcessAlive: () => false
    },
    fs: opts.rec ? opts.rec.stub : undefined,
    writeAtomic: opts.writeAtomic || ((p, t) => { cap.push([p, t]); return opts.writeOk === undefined ? true : opts.writeOk }),
    isRegularOrMissing: opts.isRegularOrMissing,
    Utils: makeUtils(opts.Utils)
  })
  return { app, cap, rec: opts.rec ? opts.rec.rec : null }
}

function withFixedNow (now, fn) {
  const RN = Date.now
  Date.now = () => now
  try { return fn() } finally { Date.now = RN }
}

// ----- _isRegularOrMissing / _writeTextAtomic：薄封装透传 -----
check('_isRegularOrMissing 透传注入实现（true/false 两侧）', () => {
  let flag = true
  const { app } = makeLogApp({ isRegularOrMissing: () => flag })
  assert.strictEqual(app._isRegularOrMissing('/x'), true)
  flag = false
  assert.strictEqual(app._isRegularOrMissing('/x'), false)
})

check('_writeTextAtomic 透传 (path,text,"缓存文件") 并原样返回 writeAtomic 结果', () => {
  const args = []
  let ret = true
  const { app } = makeLogApp({ writeAtomic: (p, t, label) => { args.push([p, t, label]); return ret } })
  assert.strictEqual(app._writeTextAtomic('/f.json', 'TXT'), true)
  assert.deepStrictEqual(args, [['/f.json', 'TXT', '缓存文件']])
  ret = false
  assert.strictEqual(app._writeTextAtomic('/f.json', 'TXT'), false)
})

check('_writeTextAtomic writeAtomic 抛错 ⇒ 返回 false 不冒泡', () => {
  const { app } = makeLogApp({ writeAtomic: () => { throw new Error('boom') } })
  assert.strictEqual(app._writeTextAtomic('/f.json', 'TXT'), false)
})

// ----- _writeState：类型守卫 / 序列化异常 / 透传 -----
check('_writeState 非对象入参 ⇒ 精确告警 + 拒绝写入（kind 口径）', () => {
  for (const [v, kind] of [[undefined, 'undefined'], [null, 'null'], [42, 'number'], ['s', 'string']]) {
    const { app, cap } = makeLogApp()
    const r = withCapture('warn', () => app._writeState('/p/state.json', v))
    assert.strictEqual(r.value, false, `${kind} 必须拒绝`)
    assert.deepStrictEqual(r.msgs, [`_writeState: state 必须是非空对象, 实际为 ${kind}, 拒绝写入 /p/state.json`])
    assert.strictEqual(cap.length, 0, `${kind} 不得落盘`)
  }
})

check('_writeState 数组（typeof object）⇒ 同样拒绝，kind=array', () => {
  const { app, cap } = makeLogApp()
  const r = withCapture('warn', () => app._writeState('/p/state.json', [1, 2]))
  assert.strictEqual(r.value, false)
  assert.deepStrictEqual(r.msgs, ['_writeState: state 必须是非空对象, 实际为 array, 拒绝写入 /p/state.json'])
  assert.strictEqual(cap.length, 0)
})

check('_writeState 序列化异常（循环引用）⇒ error 告警 + false，不调用 writeAtomic', () => {
  const { app, cap } = makeLogApp()
  const cyc = {}; cyc.self = cyc
  const r = withCapture('error', () => app._writeState('/p/state.json', cyc))
  assert.strictEqual(r.value, false)
  assert.strictEqual(r.msgs.length, 1)
  assert.ok(r.msgs[0].startsWith('状态序列化失败 /p/state.json:'), r.msgs[0])
  assert.strictEqual(cap.length, 0)
})

check('_writeState 正常 ⇒ 落盘 JSON.stringify(state) 文本，返回值透传', () => {
  const { app, cap } = makeLogApp({ writeOk: false })
  assert.strictEqual(app._writeState('/p/s.json', { a: 1 }), false)
  assert.deepStrictEqual(cap, [['/p/s.json', '{"a":1}']])
})

// ----- _localStamp：固定 Asia/Shanghai 口径 -----
check('_localStamp 固定 UTC 时刻 ⇒ Asia/Shanghai 文本（不是 UTC/进程本地口径）', () => {
  const RealDate = Date
  const FIXED = RealDate.UTC(2024, 2, 15, 20, 0, 0)
  class FakeDate extends RealDate {
    constructor (...a) { if (a.length === 0) super(FIXED); else super(...a) }
    static now () { return FIXED }
  }
  let got
  global.Date = FakeDate
  try { got = makeLogApp({ Config: {} }).app._localStamp() } finally { global.Date = RealDate }
  assert.strictEqual(got, '2024-03-16 04:00:00')
  assert.notStrictEqual(got, '2024-03-15 20:00:00')
})

// ----- _writeRunLog：拒绝非普通文件 / 文件名净化 -----
check('_writeRunLog 非普通文件 ⇒ error 告警、拒绝追加、不抛（主流程不受影响）', () => {
  const rec = makeLogFs()
  const { app } = makeLogApp({ rec, isRegularOrMissing: () => false })
  const r = withCapture('error', () => app._writeRunLog('x\n'))
  assert.strictEqual(r.value, undefined)
  assert.deepStrictEqual(r.msgs, [`拒绝写入非普通运行日志文件 ${LOG_PATH}`])
  assert.strictEqual(rec.rec.append.length, 0)
  assert.strictEqual(rec.rec.open.length, 0)
})

check('_writeRunLog filename 含路径分隔 ⇒ 回退 run.log（防 ../ 逃逸）', () => {
  const rec = makeLogFs()
  const seen = []
  const { app } = makeLogApp({ rec, isRegularOrMissing: (p) => { seen.push(p); return true } })
  app._writeRunLog('l\n', '../evil.log')
  assert.deepStrictEqual(seen, [LOG_PATH])
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, 'l\n', 'utf8']])
})

check('_writeRunLog 合法基名保留：filter-diagnostics.ndjson', () => {
  const rec = makeLogFs()
  const { app } = makeLogApp({ rec })
  app._writeRunLog('l\n', 'filter-diagnostics.ndjson')
  assert.deepStrictEqual(rec.rec.append, [[path.join(CACHE_DIR, 'filter-diagnostics.ndjson'), 'l\n', 'utf8']])
})

// ----- _writeRunLog：锁语义 / 清理 / 失败静默 -----
check('_writeRunLog 正常追加：默认 run.log、utf8、锁令牌 pid:start、锁清理', () => {
  const rec = makeLogFs()
  const { app } = makeLogApp({ rec })
  app._writeRunLog('hello\n')
  assert.deepStrictEqual(rec.rec.open, [[LOCK_PATH, 'wx']])
  assert.deepStrictEqual(rec.rec.write, [[7, `${process.pid}:42`]])
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, 'hello\n', 'utf8']])
  assert.deepStrictEqual(rec.rec.close, [7])
  assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH])
})

check('_writeRunLog 锁异常（EACCES）⇒ fail-open 仅追加；超限也不截尾（不得误当持锁）', () => {
  const e = new Error('x'); e.code = 'EACCES'
  const rec = makeLogFs({ openSync: (p, flag) => { if (flag === 'wx') throw e; return 8 }, size: 2 * LIMIT, tail: 'IGNORED' })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('data\n')
  assert.deepStrictEqual(rec.rec.append.map((a) => a[1]), ['data\n'])
  assert.deepStrictEqual(rec.rec.open.map((o) => o[1]), ['wx']) // 不得在无锁时开 r+
  assert.strictEqual(rec.rec.read.length, 0)
  assert.strictEqual(cap.length, 0)
  assert.strictEqual(rec.rec.unlink.length, 0)
  assert.strictEqual(rec.rec.close.length, 0)
})

check('_writeRunLog 陈旧锁且持有进程已退出 ⇒ 抢占 unlink 后重试成功', () => {
  let n = 0
  const rec = makeLogFs({
    openSync: () => { if (n++ === 0) { const e = new Error('busy'); e.code = 'EEXIST'; throw e } return 7 },
    mtimeMs: Date.now() - 20000
  })
  const { app } = makeLogApp({ rec })
  app._writeRunLog('a\n')
  assert.strictEqual(rec.rec.unlink.length, 2)
  assert.strictEqual(rec.rec.unlink[0], LOCK_PATH)
  assert.strictEqual(rec.rec.open.length, 2)
  assert.strictEqual(rec.rec.append.length, 1)
})

check('_writeRunLog 陈旧锁但持有进程仍存活 ⇒ 不抢占，退避重试成功', () => {
  let n = 0
  const rec = makeLogFs({
    openSync: () => { if (n++ === 0) { const e = new Error('busy'); e.code = 'EEXIST'; throw e } return 7 },
    mtimeMs: Date.now() - 20000
  })
  const { app } = makeLogApp({ rec, MessageStore: { cacheDir: CACHE_DIR, _getTombstoneProcessStart: () => 42, _isTombstoneLockProcessAlive: () => true } })
  app._writeRunLog('a\n')
  assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH])
  assert.strictEqual(rec.rec.append.length, 1)
})

check('_writeRunLog 新鲜锁（mtime 未超龄）⇒ 查 mtime 后退避重试，不抢占', () => {
  let n = 0
  const rec = makeLogFs({
    openSync: () => { if (n++ === 0) { const e = new Error('busy'); e.code = 'EEXIST'; throw e } return 7 },
    mtimeMs: Date.now()
  })
  const { app } = makeLogApp({ rec })
  app._writeRunLog('a\n')
  assert.strictEqual(rec.rec.unlink.length, 1)
  assert.strictEqual(rec.rec.stat.length, 2)
  assert.strictEqual(rec.rec.append.length, 1)
})

check('_writeRunLog 追加失败 ⇒ 静默吞掉、不截尾，锁仍被清理', () => {
  const rec = makeLogFs({ appendThrows: true, size: 2 * LIMIT })
  const { app, cap } = makeLogApp({ rec })
  assert.strictEqual(app._writeRunLog('x\n'), undefined)
  assert.strictEqual(cap.length, 0)
  assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH])
  assert.deepStrictEqual(rec.rec.close, [7])
})

check('_writeRunLog 追加后 statSync 失败 ⇒ 静默，锁清理不跳过', () => {
  const rec = makeLogFs({ statThrows: true })
  const { app } = makeLogApp({ rec })
  app._writeRunLog('x\n')
  assert.strictEqual(rec.rec.append.length, 1)
  assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH])
})

// N1 回归（与 _updateChannelHealth 的 mutRuntimeError 同源）：锁 fd 落在 stdio 区（0/1/2）时绝不 close。
// 旧实现把「未取得锁」编码成 -1，哨兵被 UnaryOperator 改成 +1 后 finally 的 closeSync(1) 会直接关掉
// stdout，测试进程崩成 RuntimeError；且 stdio 已被外部关闭时 openSync 本就会返回 0/1/2 这样的真 fd。
// 这里用 closeSync 观察器把「关 stdio」变成可断言的失败，正常追加与追加抛错（异常路径）两条都要守住。
check('_writeRunLog 锁 fd 落在 stdio（0/1/2）⇒ 不 close，锁文件仍清理（含异常路径）', () => {
  for (const fd of [0, 1, 2]) {
    for (const appendThrows of [false, true]) {
      const rec = makeLogFs({ openSync: (p, flag) => (flag === 'wx' ? fd : 8), appendThrows })
      const { app } = makeLogApp({ rec })
      app._writeRunLog('x\n')
      const tag = `fd=${fd} appendThrows=${appendThrows}`
      assert.deepStrictEqual(rec.rec.close, [], `${tag}: 不得 close stdio，实际 close：${rec.rec.close.join(',')}`)
      assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH], `${tag}: 锁文件必须清理（漏删会让后续轮次一直被旧锁挡住）`)
    }
  }
})

// ----- _writeRunLog：ERROR 行只截 errMsg 段 -----
check('_writeRunLog ERROR 行超 512 ⇒ 仅 errMsg 段截到 512，前缀与尾换行保留', () => {
  const rec = makeLogFs()
  const seen = []
  const { app } = makeLogApp({ rec, Utils: { truncateUtf16: (s, n) => { seen.push([s, n]); return s.slice(0, n) } } })
  app._writeRunLog('2024-01-01 00:00:00 ERROR ' + 'E'.repeat(600) + '\n')
  assert.deepStrictEqual(seen, [['E'.repeat(600), 512]])
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, '2024-01-01 00:00:00 ERROR ' + 'E'.repeat(512) + '\n', 'utf8']])
})

check('_writeRunLog ERROR 行恰好 512 字符 ⇒ 不截断（> 而非 >=）', () => {
  const rec = makeLogFs()
  let calls = 0
  const { app } = makeLogApp({ rec, Utils: { truncateUtf16: (s) => { calls++; return s } } })
  const line = ' ERROR ' + 'M'.repeat(505)
  assert.strictEqual(line.length, 512)
  app._writeRunLog(line)
  assert.strictEqual(calls, 0)
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, line, 'utf8']])
})

check('_writeRunLog ERROR 在行首 ⇒ 前缀仍取完整 7 字符分隔符（errSep>=0）', () => {
  const rec = makeLogFs()
  const { app } = makeLogApp({ rec })
  app._writeRunLog(' ERROR ' + 'N'.repeat(600))
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, ' ERROR ' + 'N'.repeat(512), 'utf8']])
})

check('_writeRunLog 多个 " ERROR " ⇒ 按首个分隔（indexOf 而非 lastIndexOf）', () => {
  const rec = makeLogFs()
  const { app } = makeLogApp({ rec })
  app._writeRunLog('A ERROR ' + 'X'.repeat(600) + ' ERROR ' + 'Y'.repeat(10))
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, 'A ERROR ' + 'X'.repeat(512), 'utf8']])
})

check('_writeRunLog 非 ERROR 长行 ⇒ 完全不截断', () => {
  const rec = makeLogFs()
  let calls = 0
  const { app } = makeLogApp({ rec, Utils: { truncateUtf16: (s) => { calls++; return s } } })
  const line = '2024-01-01 00:00:00 WARN ' + 'W'.repeat(600)
  app._writeRunLog(line)
  assert.strictEqual(calls, 0)
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, line, 'utf8']])
})

// ----- C1-006 回归：整批 NDJSON 必须逐条整行写入，不得被「ERROR 行截断」启发式截出半行 -----
check('_writeFilterDiagnostics 一批 13 条（含含 " ERROR " 的记录）⇒ 13 行完整 JSON，末行不得截断成非法 JSON', () => {
  const rec = makeLogFs()
  const { app } = makeLogApp({ rec, Config: { diagnostics: { filterLog: { enabled: true } } } })
  const records = [{
    type: 'run',
    at: '2026-10-28 10:00:00',
    total: 13,
    dedup: 0,
    filtered: 3,
    passed: 10,
    byReason: { 'keyword.pingbibiaoti': 3 },
    detailCount: 12
  }]
  for (let i = 1; i <= 12; i++) {
    records.push({
      type: 'item',
      id: `diag-${i}`,
      title: i === 3 ? `第3条线报 ERROR ${'E'.repeat(80)}` : `第${i}条线报标题${'标'.repeat(20)}`,
      decision: 'filtered',
      reason: { stage: 'keyword', kind: 'block', configKey: 'pingbibiaoti' }
    })
  }
  app._writeFilterDiagnostics(records)
  assert.strictEqual(rec.rec.append.length, 1, '整批诊断应一次追加')
  const text = rec.rec.append[0][1]
  assert.ok(text.endsWith('\n'), '整批必须以换行结尾（NDJSON 逐行）')
  const lines = text.split('\n').slice(0, -1)
  assert.strictEqual(lines.length, records.length,
    `${records.length} 条记录必须写出 ${records.length} 行（实际 ${lines.length} 行，末行长度 ${(lines[lines.length - 1] || '').length}）`)
  lines.forEach((line, index) => {
    assert.doesNotThrow(() => JSON.parse(line), `第 ${index + 1} 行必须是完整合法 JSON，实际尾部：${line.slice(-40)}`)
  })
  assert.deepStrictEqual(JSON.parse(lines[2]), records[2], '含 " ERROR " 的记录必须原样整条写入（不得截掉 errMsg 之后的 JSON 结构）')
})

// ----- _writeRunLog：超 1MiB 截尾到 512KiB 且按换行对齐 -----
check('_writeRunLog size === 1MiB ⇒ 不截尾（严格大于）', () => {
  const rec = makeLogFs({ size: LIMIT, tail: 'IGNORED' })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.strictEqual(rec.rec.read.length, 0)
  assert.strictEqual(cap.length, 0)
})

check('_writeRunLog size > 1MiB ⇒ 只读尾部 512KiB，按首个换行对齐后原子写回', () => {
  const head = 'H'.repeat(1000) + '\n'
  const rest = 'T'.repeat(KEEP - head.length)
  const rec = makeLogFs({ size: 2 * LIMIT, tail: head + rest })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.deepStrictEqual(rec.rec.read, [[8, KEEP, 2 * LIMIT - KEEP, KEEP]])
  assert.deepStrictEqual(rec.rec.open.map((o) => o[1]), ['wx', 'r+'])
  assert.deepStrictEqual(cap, [[LOG_PATH, rest]])
})

check('_writeRunLog 尾部无换行 ⇒ 整体写回（不得写空）', () => {
  const tail = 'N'.repeat(100)
  const rec = makeLogFs({ size: 2 * LIMIT, tail })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.deepStrictEqual(cap, [[LOG_PATH, tail + '\0'.repeat(KEEP - 100)]])
})

check('_writeRunLog 尾部多个换行 ⇒ 以首个换行为界（slice(nl+1)）', () => {
  const rest = 'B'.repeat(100) + '\n' + 'C'.repeat(KEEP - 102)
  const rec = makeLogFs({ size: 2 * LIMIT, tail: '\n' + rest })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.deepStrictEqual(cap, [[LOG_PATH, rest]])
})

check('_writeRunLog filename 非字符串 ⇒ 回退 run.log（typeof 守卫不可省）', () => {
  const rec = makeLogFs()
  const seen = []
  const { app } = makeLogApp({ rec, isRegularOrMissing: (p) => { seen.push(p); return true } })
  app._writeRunLog('l\n', 42)
  assert.deepStrictEqual(seen, [LOG_PATH])
  assert.deepStrictEqual(rec.rec.append, [[LOG_PATH, 'l\n', 'utf8']])
})

check('_writeRunLog 锁 fd 为 0 仍是有效锁：超限时照样截尾（>=0 而非 >0）', () => {
  const head = 'H'.repeat(10) + '\n'
  const rest = 'T'.repeat(KEEP - head.length)
  const rec = makeLogFs({ openSync: (p, flag) => (flag === 'wx' ? 0 : 9), size: 2 * LIMIT, tail: head + rest })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.deepStrictEqual(rec.rec.open.map((o) => o[1]), ['wx', 'r+'])
  assert.strictEqual(rec.rec.read.length, 1)
  assert.deepStrictEqual(cap, [[LOG_PATH, rest]])
})

// fd 为 0 是 falsy：旧实现用 `if (lockFd)` 判定「是否取到锁」时会把 fd 0 当成「没取到」而整段跳过
// 释放（锁文件残留）。这里守住「0 是有效 fd、必须走释放」；但 0 也是 stdin，close 必须被 >2 守卫拒绝。
check('_writeRunLog 锁 fd 为 0（falsy）时 finally 仍释放：unlink 照做、不得 close stdio', () => {
  const rec = makeLogFs({ openSync: (p, flag) => (flag === 'wx' ? 0 : 9) })
  const { app } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.deepStrictEqual(rec.rec.write, [[0, `${process.pid}:42`]])
  assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH], 'fd 0 不得被当成「未取锁」而跳过释放（锁文件会残留）')
  assert.deepStrictEqual(rec.rec.close, [], 'fd 0 是 stdin，>2 守卫必须拒绝 close')
})

// ----- _warnLowDisk：阈值 / 只告警不阻断 / 限频 -----
check('_warnLowDisk free < minFree ⇒ 精确告警一行（toFixed(1) 口径 + 阈值取 Config.storage.minFreeBytes）', () => {
  const { app } = makeLogApp({ Config: { storage: { minFreeBytes: 32 * 1024 * 1024 } }, Utils: { diskSpace: () => ({ freeBytes: 1572864 }) } })
  const now = 1700000000000
  const r = withFixedNow(now, () => withCapture('warn', () => app._warnLowDisk()))
  assert.strictEqual(r.value, undefined)
  assert.deepStrictEqual(r.msgs, ['⚠️ 缓存所在磁盘余量不足：1.5 MiB（告警阈值 32.0 MiB），写入状态/缓存可能失败'])
  assert.strictEqual(app._diskWarningAt, now)
})

check('_warnLowDisk free === minFree ⇒ 不告警（>= 而非 >），且不更新限频', () => {
  const minFree = 33554432
  let calls = 0
  const { app } = makeLogApp({ Config: { storage: { minFreeBytes: minFree } }, Utils: { diskSpace: () => { calls++; return { freeBytes: minFree } } } })
  const now = 1700000000000
  const r = withFixedNow(now, () => withCapture('warn', () => app._warnLowDisk()))
  assert.deepStrictEqual(r.msgs, [])
  assert.strictEqual(calls, 1)
  assert.strictEqual(app._diskWarningAt, 0)
})

check('_warnLowDisk freeBytes 非有限 / info 缺失 ⇒ 不告警也不记录限频', () => {
  const cfg = { storage: { minFreeBytes: 1024 } }
  for (const info of [null, { freeBytes: Number.NaN }, { freeBytes: Infinity }]) {
    const { app } = makeLogApp({ Config: cfg, Utils: { diskSpace: () => info } })
    const r = withCapture('warn', () => app._warnLowDisk())
    assert.deepStrictEqual(r.msgs, [])
    assert.strictEqual(app._diskWarningAt, 0)
  }
})

check('_warnLowDisk 限频边界 3600000ms：恰好到期告警、差 1ms 跳过', () => {
  let calls = 0
  const { app } = makeLogApp({ Config: { storage: { minFreeBytes: 33554432 } }, Utils: { diskSpace: () => { calls++; return { freeBytes: 1 } } } })
  const now = 1700000000000
  withFixedNow(now, () => {
    app._diskWarningAt = now - 3600000
    assert.strictEqual(withCapture('warn', () => app._warnLowDisk()).msgs.length, 1)
    assert.strictEqual(app._diskWarningAt, now)
    app._diskWarningAt = now - 3599999
    const before = calls
    assert.deepStrictEqual(withCapture('warn', () => app._warnLowDisk()).msgs, [])
    assert.strictEqual(calls, before)
    assert.strictEqual(app._diskWarningAt, now - 3599999)
  })
})

check('_warnLowDisk/_diskMinFree：阈值非正 ⇒ 视为未配置，不查磁盘（minFree>0 守卫）', () => {
  let calls = 0
  const utils = { diskSpace: () => { calls++; return { freeBytes: 0 } } }
  for (const v of [0, -1]) {
    const { app } = makeLogApp({ Config: { storage: { minFreeBytes: v } }, Utils: utils })
    assert.strictEqual(app._diskMinFree({ storage: { minFreeBytes: v } }), null, `${v} 应视为未配置`)
    assert.deepStrictEqual(withCapture('warn', () => app._warnLowDisk()).msgs, [])
  }
  assert.strictEqual(calls, 0)
})

check('_warnLowDisk 默认阈值 50MiB（Config.storage 缺失）：上下两侧各一例', () => {
  const base = 50 * 1024 * 1024
  const a1 = makeLogApp({ Config: {}, Utils: { diskSpace: () => ({ freeBytes: base }) } }).app
  assert.strictEqual(a1._diskMinFree({}), base)
  assert.deepStrictEqual(withCapture('warn', () => a1._warnLowDisk()).msgs, [])
  const a2 = makeLogApp({ Config: {}, Utils: { diskSpace: () => ({ freeBytes: base - 1 }) } }).app
  assert.deepStrictEqual(withCapture('warn', () => a2._warnLowDisk()).msgs,
    ['⚠️ 缓存所在磁盘余量不足：50.0 MiB（告警阈值 50.0 MiB），写入状态/缓存可能失败'])
})

check('_diskMinFree 阈值来自字符串配置（Utils.num 口径）', () => {
  const { app } = makeLogApp({ Config: { storage: { minFreeBytes: '1048576' } } })
  assert.strictEqual(app._diskMinFree({ storage: { minFreeBytes: '1048576' } }), 1048576)
})

// ----- _persistReportState：写成功才更新内存快照；失败保留内存 + 低磁盘告警 -----
check('_persistReportState 写成功 ⇒ 落盘 normalize 后文本、内存快照 persisted:true、不告警', () => {
  const { app, cap } = makeLogApp({ Config: {} })
  const expected = Object.assign({}, blank, { date: '2024-01-05', runs: 9 })
  const r = withCapture('warn', () => app._persistReportState('/p/r.json', { date: '2024-01-05', runs: 9 }))
  assert.strictEqual(r.value, true)
  assert.deepStrictEqual(r.msgs, [])
  assert.deepStrictEqual(cap, [['/p/r.json', JSON.stringify(expected)]])
  assert.deepStrictEqual(app._reportMemoryStateByPath.get('/p/r.json'), { state: expected, persisted: true })
})

check('_persistReportState 写失败 ⇒ 内存状态保留为 persisted:false、发低磁盘告警、返回 false', () => {
  const { app } = makeLogApp({ Config: {} })
  let lowDisk = 0
  app._warnLowDisk = () => { lowDisk++ }
  app._writeState = () => false
  const expected = Object.assign({}, blank, { runs: 3 })
  const r = withCapture('warn', () => app._persistReportState('/p/r.json', { runs: 3 }))
  assert.strictEqual(r.value, false)
  assert.strictEqual(lowDisk, 1)
  assert.deepStrictEqual(r.msgs, ['⚠️ 日报发送/累计状态持久化失败；本进程将继续使用内存状态'])
  assert.deepStrictEqual(app._reportMemoryStateByPath.get('/p/r.json'), { state: expected, persisted: false })
})

check('_persistReportState 落盘前先 normalize（字符串计数转数字、缺失字段补 0）', () => {
  const { app, cap } = makeLogApp({ Config: {} })
  app._persistReportState('/p/r.json', { runs: '9', total: 'abc' })
  assert.deepStrictEqual(JSON.parse(cap[0][1]), Object.assign({}, blank, { runs: 9 }))
})

// ============================================================================
// 报告 / 告警 / 模板校验簇（本段新增，全部对着 SYSTEM_CONTRACT.md「日报日界固定
// Asia/Shanghai；告警/日报失败不得影响主流程」与 README「运行日报与通道健康」）
// 断言纪律：strictEqual / deepStrictEqual 精确值，开关与边界真假两侧各一例。
// 时间一律注入固定时钟（withFixedNowAsync / _localStamp 覆写），从不比较真实时钟。
// ============================================================================

const asyncChecks = []
function checkAsync (name, fn) { declared += 1; asyncChecks.push([name, fn]) }

async function withCaptureAsync (level, fn) {
  const orig = console[level]
  const msgs = []
  console[level] = (...a) => msgs.push(a.map(String).join(' '))
  try {
    return { value: await fn(), msgs }
  } finally {
    console[level] = orig
  }
}

// 注入 Pusher 通知通道（记录每次 title/body）+ 注入 fs/writeAtomic/readSafeTextResult
// 的可控 app；makeApp 不支持 over.Pusher，故此处直接调 createApp。
function makeNotifyApp (opts = {}) {
  const sent = []
  const stateWrites = []
  const runLogs = []
  const app = createApp({
    Config: opts.Config || {},
    // safeErrorText 打桩对齐 xbk_utils.js 口径：字符串 error 直接返回内容（此前用简版桩
    // 会把 '原因：boom' 误判成回退值「未知错误」，属于桩失真）
    Utils: makeUtils(Object.assign({ safeErrorText: faithfulSafeErrorText }, opts.Utils)),
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: Object.assign({ cacheDir: CACHE_DIR }, opts.MessageStore),
    Network: {},
    Pusher: {
      send: (text, desp) => {
        sent.push([text, desp])
        if (opts.sendThrows) throw opts.sendThrows
        if (opts.sendError) return Promise.reject(opts.sendError)
        return Promise.resolve(true)
      }
    },
    fs: Object.assign({ existsSync: () => true, statfsSync: () => ({ bavail: 1 << 20, bsize: 4096 }) }, opts.fs),
    path,
    crypto,
    readSafeTextResult: opts.readSafeTextResult || (() => ({ status: 'missing', text: '' })),
    writeAtomic: (p, t) => { stateWrites.push([p, t]); return opts.writeOk === undefined ? true : opts.writeOk },
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
    getNotify: () => Promise.resolve({}),
    PKG_VERSION: '1.2.3',
    trimTrailingSlashes: (s) => s,
    compileUserRegex: () => {}
  })
  // run.log 留痕：覆写为数组收集（_writeRunLog 不是本段被测目标，避免真实磁盘写入）
  app._writeRunLog = (line) => { runLogs.push(line) }
  app._localStamp = () => 'STAMP'
  return { app, sent, stateWrites, runLogs }
}

function faithfulSafeErrorText (e, d) {
  if (typeof e === 'string' && e.trim() !== '') return e
  const m = e && e.message
  return (m !== undefined && m !== null && m !== '') ? String(m) : d
}

// 不需要观测 console 的告警用例：吞掉 _sendAlert 的正向日志，保持套件输出干净
async function silentAlert (app, errMsg) {
  const r = await withCaptureAsync('log', () => app._sendAlert(errMsg))
  return r.value
}

async function withFixedNowAsync (now, fn) {
  const RN = Date.now
  Date.now = () => now
  try { return await fn() } finally { Date.now = RN }
}

const ALERT_PATH = path.join(CACHE_DIR, 'alert.state')
const REPORT_PATH = path.join(CACHE_DIR, 'report.state')
const TPL_SUPPORTED_TAIL = '{分类名} {分类ID} {标题} {链接} {日期} {时间} {楼主} {类目} {内容} {价格} {商城} {品牌} {图片} {Html内容} {Markdown内容}'
const SUMMARY1 = { total: 1, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6 }

// ---------------------------------------------------------------- _enabledFlag
check('_enabledFlag 真值表：原始 falsy/空白/false/0 变体一律关闭', () => {
  // 杀 if (!cfg) 条件取反：缺失/假值配置必须返回 false
  assert.strictEqual(app._enabledFlag(undefined), false)
  assert.strictEqual(app._enabledFlag(null), false)
  assert.strictEqual(app._enabledFlag(0), false)
  assert.strictEqual(app._enabledFlag(''), false)
  // 杀 Boolean(en) 合取项被删除：0/false/''/NaN 必须关闭
  assert.strictEqual(app._enabledFlag({ enabled: 0 }), false)
  assert.strictEqual(app._enabledFlag({ enabled: false }), false)
  assert.strictEqual(app._enabledFlag({ enabled: '' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: Number.NaN }), false)
  assert.strictEqual(app._enabledFlag({ enabled: null }), false)
  // 杀 s !== ''（纯空白）/ trim / toLowerCase 被删；也杀 && 被换成 ||（首项真、其余假）
  assert.strictEqual(app._enabledFlag({ enabled: ' ' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: '\t\n' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: 'false' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: 'FALSE' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: ' False ' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: '0' }), false)
  assert.strictEqual(app._enabledFlag({ enabled: ' 0 ' }), false)
  // 真值侧：任何非关闭值的原始真值都启用
  assert.strictEqual(app._enabledFlag({ enabled: 1 }), true)
  assert.strictEqual(app._enabledFlag({ enabled: true }), true)
  assert.strictEqual(app._enabledFlag({ enabled: '1' }), true)
  assert.strictEqual(app._enabledFlag({ enabled: 'true' }), true)
  assert.strictEqual(app._enabledFlag({ enabled: 'yes' }), true)
  assert.strictEqual(app._enabledFlag({ enabled: ' on ' }), true)
})

// ------------------------------------------------------------ _validateTplConfig
check('_validateTplConfig 两个模板字段的非字符串各自独立告警（|| 而非 &&）', () => {
  // 杀 || → &&：只坏一个字段时仍必须告警
  const onlyTitle = makeApp({ Config: { template: { title: 123, content: '{标题}' } } })
  assert.deepStrictEqual(onlyTitle._validateTplConfig(), ['⚠️ 配置「template.title/content」应为字符串，已回退默认模板'])
  const onlyContent = makeApp({ Config: { template: { title: '{标题}', content: null } } })
  assert.deepStrictEqual(onlyContent._validateTplConfig(), ['⚠️ 配置「template.title/content」应为字符串，已回退默认模板'])
  const bothBad = makeApp({ Config: { template: { title: 1, content: 2 } } })
  assert.deepStrictEqual(bothBad._validateTplConfig(), ['⚠️ 配置「template.title/content」应为字符串，已回退默认模板'])
  // 真值侧：两侧都是字符串 ⇒ 零告警（杀 typeof !== 'string' 取反）
  const bothOk = makeApp({ Config: { template: { title: '{标题}', content: '{内容}' } } })
  assert.deepStrictEqual(bothOk._validateTplConfig(), [])
})

check('_validateTplConfig 支持清单完整、重复占位符去重、title/content 分别定位', () => {
  // 同时锁：支持清单文本、template.{tplName} 名字、Set 去重、includes 方向、\{[^{}]+\} 正则
  const a = makeApp({ Config: { template: { title: '{标题}{未知}{未知}', content: TPL_SUPPORTED_TAIL } } })
  assert.deepStrictEqual(a._validateTplConfig(), [
    `⚠️ 模板「template.title」含占位符「{未知}」——接口真实字段不提供该数据，将输出为空。支持占位符：${TPL_SUPPORTED_TAIL}`
  ])
  const c = makeApp({ Config: { template: { title: '{标题}', content: '{未知}' } } })
  assert.deepStrictEqual(c._validateTplConfig(), [
    `⚠️ 模板「template.content」含占位符「{未知}」——接口真实字段不提供该数据，将输出为空。支持占位符：${TPL_SUPPORTED_TAIL}`
  ])
  // 空占位符 {} 不匹配 [^{}]+（杀 + → * 的 Regex 变异体）
  const empty = makeApp({ Config: { template: { title: '{}', content: '{标题}' } } })
  assert.deepStrictEqual(empty._validateTplConfig(), [])
  // 全部支持占位符 ⇒ 无告警（杀 includes → !includes）
  const ok = makeApp({ Config: { template: { title: '{分类名}', content: '{Markdown内容}' } } })
  assert.deepStrictEqual(ok._validateTplConfig(), [])
})

// ------------------------------------------------------------ _accumulateReport
check('_accumulateReport 逐字段累加精确值（杀 += → -= 与各字段漏加/写错字段）', () => {
  const st = { date: '2024-01-01', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  app._accumulateReport(st, { total: 1, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6 })
  assert.deepStrictEqual(st, { date: '2024-01-01', runs: 1, total: 1, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6 })
  // 第二次累加：杀 runs += 1 → runs = 1、以及各字段被覆盖写（= 而非 +=）的变异体
  app._accumulateReport(st, { total: 10, dedup: 20, filtered: 30, pushed: 40, failed: 50, truncated: 60 })
  assert.deepStrictEqual(st, { date: '2024-01-01', runs: 2, total: 11, dedup: 22, filtered: 33, pushed: 44, failed: 55, truncated: 66 })
})

check('_accumulateReport 负数钳为 0、数字字符串入账、非有限值钳为 0', () => {
  const st = { date: '', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  app._accumulateReport(st, { total: -5, dedup: '7', filtered: Number.NaN, pushed: Infinity, failed: undefined, truncated: null })
  // 杀 n >= 0 → n <= 0 与 && → ||：-5 必须被钳成 0 而不是原样写入
  assert.strictEqual(st.total, 0)
  // 杀 Number(v) 被删：'7' 走 Number 后为 7
  assert.strictEqual(st.dedup, 7)
  assert.strictEqual(st.filtered, 0)
  assert.strictEqual(st.pushed, 0)
  assert.strictEqual(st.failed, 0)
  assert.strictEqual(st.truncated, 0)
  assert.deepStrictEqual(st, { date: '', runs: 1, total: 0, dedup: 7, filtered: 0, pushed: 0, failed: 0, truncated: 0 })
  // 空 summary：杀 `? n : 0` 条件取反（会把 0/undefined 变成 NaN）
  const st2 = { date: '', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  app._accumulateReport(st2, {})
  assert.deepStrictEqual(st2, { date: '', runs: 1, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 })
})

// -------------------------------------------------------- _sendCrossDayReport
checkAsync('_sendCrossDayReport 完整路径：标题/正文逐字符精确 + 两次持久化顺序 + 成功日志', async () => {
  const { app, sent, stateWrites, runLogs } = makeNotifyApp({ Config: {} })
  const pending = { runs: 1, total: 2, dedup: 3, filtered: 4, pushed: 5, failed: 6, truncated: 7 }
  const state = { date: '2024-01-01', runs: 3, total: 10, dedup: 2, filtered: 1, pushed: 5, failed: 1, truncated: 4, pending }
  const summary = { total: 10, dedup: 20, filtered: 30, pushed: 40, failed: 50, truncated: 60 }
  const { value, msgs } = await withCaptureAsync('log', () => app._sendCrossDayReport(REPORT_PATH, state, summary, '2024-01-02'))
  assert.strictEqual(value, undefined)
  // 杀标题/正文里全部字符串字面量与两个 ? : 分支（truncated 两侧都为真）
  assert.deepStrictEqual(sent, [[
    '📊 xbk-push 日报（2024-01-01）',
    '运行 3 轮 | 推送 5 条 | 失败 1 条\n\n获取 10 | 去重 2 | 过滤 1 | 待推送 4\n\n今日待结转：运行 2 轮 | 推送 45 条 | 失败 56 条\n获取 12 | 去重 23 | 过滤 34 | 待推送 67'
  ]])
  // 先持久化 pendingState（累计到 pending），再持久化 nextState（结转 + today）
  assert.deepStrictEqual(stateWrites.map(w => w[0]), [REPORT_PATH, REPORT_PATH])
  assert.deepStrictEqual(JSON.parse(stateWrites[0][1]), {
    date: '2024-01-01',
    runs: 3,
    total: 10,
    dedup: 2,
    filtered: 1,
    pushed: 5,
    failed: 1,
    truncated: 4,
    pending: { date: '', runs: 2, total: 12, dedup: 23, filtered: 34, pushed: 45, failed: 56, truncated: 67 }
  })
  assert.deepStrictEqual(JSON.parse(stateWrites[1][1]), {
    date: '2024-01-02',
    runs: 2,
    total: 12,
    dedup: 23,
    filtered: 34,
    pushed: 45,
    failed: 56,
    truncated: 67
  })
  // 杀 `{...state, pending: {...pending}}` 的浅拷贝被删：原 state 的 pending 不得被累计修改
  assert.deepStrictEqual(state.pending, pending)
  assert.deepStrictEqual(msgs, ['已发送昨日运行日报'])
  assert.deepStrictEqual(runLogs, [])
})

checkAsync('_sendCrossDayReport truncated=0 侧：状态与 pending 都不带「待推送」段', async () => {
  const { app, sent, stateWrites } = makeNotifyApp({ Config: {} })
  const state = {
    date: '2024-02-29',
    runs: 0,
    total: 0,
    dedup: 0,
    filtered: 0,
    pushed: 0,
    failed: 0,
    truncated: 0,
    pending: { runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  }
  await withCaptureAsync('log', () => app._sendCrossDayReport(REPORT_PATH, state, {}, '2024-03-01'))
  // pending.runs 经累计必为 1 ⇒ 结转块出现；两个 truncated 都为 0 ⇒ 两处「待推送」段都不出现。
  // 同时杀第一个 || 被换成 &&（1 && 0 ⇒ 结转块整块消失）
  assert.deepStrictEqual(sent, [[
    '📊 xbk-push 日报（2024-02-29）',
    '运行 0 轮 | 推送 0 条 | 失败 0 条\n\n获取 0 | 去重 0 | 过滤 0\n\n今日待结转：运行 1 轮 | 推送 0 条 | 失败 0 条\n获取 0 | 去重 0 | 过滤 0'
  ]])
  assert.deepStrictEqual(JSON.parse(stateWrites[1][1]), {
    date: '2024-03-01',
    runs: 1,
    total: 0,
    dedup: 0,
    filtered: 0,
    pushed: 0,
    failed: 0,
    truncated: 0
  })
})

checkAsync('_sendCrossDayReport 缺 pending ⇒ 以空累计起算（state.pending || blank）', async () => {
  const { app, sent, stateWrites } = makeNotifyApp({ Config: {} })
  const state = { date: '2024-01-01', runs: 1, total: 2, dedup: 0, filtered: 0, pushed: 3, failed: 0, truncated: 0 }
  await withCaptureAsync('log', () => app._sendCrossDayReport(REPORT_PATH, state, { total: 4, pushed: 5 }, '2024-01-02'))
  assert.deepStrictEqual(sent, [[
    '📊 xbk-push 日报（2024-01-01）',
    '运行 1 轮 | 推送 3 条 | 失败 0 条\n\n获取 2 | 去重 0 | 过滤 0\n\n今日待结转：运行 1 轮 | 推送 5 条 | 失败 0 条\n获取 4 | 去重 0 | 过滤 0'
  ]])
  assert.strictEqual(state.pending, undefined, '原 state 不得被凭空补上 pending')
  assert.deepStrictEqual(JSON.parse(stateWrites[1][1]), {
    date: '2024-01-02',
    runs: 1,
    total: 4,
    dedup: 0,
    filtered: 0,
    pushed: 5,
    failed: 0,
    truncated: 0
  })
})

checkAsync('_sendCrossDayReport 持久化失败两侧：pending/next 各自告警，发送照旧', async () => {
  const { app, sent, stateWrites } = makeNotifyApp({ Config: {}, writeOk: false })
  const state = { date: '2024-01-01', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0, pending: { runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 } }
  const { msgs } = await withCaptureAsync('warn', () => app._sendCrossDayReport(REPORT_PATH, state, {}, '2024-01-02'))
  // 杀 if (!pendingSaved) 与 if (nextSaved) 的条件取反/else 归属错乱
  assert.deepStrictEqual(msgs, [
    '⚠️ 日报发送/累计状态持久化失败；本进程将继续使用内存状态',
    '⚠️ 日报待发送状态未持久化，继续发送但失败时将保留旧状态',
    '⚠️ 日报发送/累计状态持久化失败；本进程将继续使用内存状态',
    '⚠️ 昨日日报已发送，但最终状态未持久化，重启后可能重复发送'
  ])
  assert.strictEqual(sent.length, 1, '持久化失败不得阻止日报发送')
  assert.deepStrictEqual(stateWrites.map(w => w[0]), [REPORT_PATH, REPORT_PATH])
})

checkAsync('_sendCrossDayReport 发送失败：只留 pendingState、写 error 行、不抛不回滚状态', async () => {
  const { app, sent, stateWrites } = makeNotifyApp({ Config: {}, sendError: new Error('HTTP 500 通道挂了') })
  const state = { date: '2024-01-01', runs: 1, total: 1, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0, pending: { runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 } }
  const { msgs } = await withCaptureAsync('error', () => app._sendCrossDayReport(REPORT_PATH, state, {}, '2024-01-02'))
  // 杀 catch 块被整体删除 / 错误口径改变：失败保留旧日期与 pending 以便重试
  assert.deepStrictEqual(msgs, ['发送昨日运行日报失败: HTTP 500 通道挂了'])
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(stateWrites.length, 1, '发送失败时不得结转 nextState')
  assert.strictEqual(JSON.parse(stateWrites[0][1]).date, '2024-01-01')
})

// --------------------------------------------------------------- _updateReport
function makeReportApp (opts = {}) {
  const calls = { load: 0, persist: [], cross: [] }
  const base = makeNotifyApp(opts)
  const app = base.app
  app._reportToday = () => opts.today === undefined ? '2024-01-02' : opts.today
  app._loadReportState = () => {
    calls.load++
    if (opts.loadThrows) throw opts.loadThrows
    return opts.loadState
  }
  app._persistReportState = (p, s) => {
    calls.persist.push([p, JSON.parse(JSON.stringify(s))])
    return opts.persistOk === undefined ? true : opts.persistOk
  }
  app._sendCrossDayReport = async (...args) => { calls.cross.push(args) }
  return { app, calls, sent: base.sent, stateWrites: base.stateWrites, runLogs: base.runLogs }
}

checkAsync('_updateReport 开关关闭 ⇒ 不读状态、不累计、不持久化（!enabledFlag 两侧）', async () => {
  const off = makeReportApp({ Config: { report: { enabled: false } }, loadState: { date: '', runs: 0 } })
  assert.strictEqual(await off.app._updateReport(SUMMARY1), undefined)
  assert.strictEqual(off.calls.load, 0)
  assert.deepStrictEqual(off.calls.persist, [])
  assert.deepStrictEqual(off.calls.cross, [])
  const on = makeReportApp({ Config: { report: { enabled: true } }, loadState: null })
  await on.app._updateReport(SUMMARY1)
  assert.strictEqual(on.calls.load, 1, '开关打开必须真的读状态')
})

checkAsync('_updateReport 状态读取失败（null）⇒ 跳过本轮，不覆盖原文件', async () => {
  const { app, calls, runLogs } = makeReportApp({ Config: { report: { enabled: true } }, loadState: null })
  assert.strictEqual(await app._updateReport(SUMMARY1), undefined)
  assert.strictEqual(calls.load, 1)
  assert.deepStrictEqual(calls.persist, [])
  assert.deepStrictEqual(calls.cross, [])
  assert.deepStrictEqual(runLogs, [])
})

checkAsync('_updateReport 同日 ⇒ 就地累加并持久化，日期不变（state.date !== today 取反）', async () => {
  const start = { date: '2024-01-02', runs: 2, total: 10, dedup: 20, filtered: 30, pushed: 40, failed: 50, truncated: 60 }
  const { app, calls } = makeReportApp({ Config: { report: { enabled: true } }, loadState: Object.assign({}, start) })
  await app._updateReport(SUMMARY1)
  assert.deepStrictEqual(calls.cross, [])
  assert.deepStrictEqual(calls.persist, [[REPORT_PATH, {
    date: '2024-01-02',
    runs: 3,
    total: 11,
    dedup: 22,
    filtered: 33,
    pushed: 44,
    failed: 55,
    truncated: 66
  }]])
})

checkAsync('_updateReport date 为空 ⇒ 补上今日再累计（!state.date 取反）', async () => {
  const { app, calls } = makeReportApp({
    Config: { report: { enabled: true } },
    loadState: { date: '', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  })
  await app._updateReport(SUMMARY1)
  assert.deepStrictEqual(calls.cross, [])
  assert.deepStrictEqual(calls.persist, [[REPORT_PATH, {
    date: '2024-01-02',
    runs: 1,
    total: 1,
    dedup: 2,
    filtered: 3,
    pushed: 4,
    failed: 5,
    truncated: 6
  }]])
})

checkAsync('_updateReport 跨天且有计数 ⇒ 调 _sendCrossDayReport(路径,state,summary,today) 后 return', async () => {
  const state = { date: '2024-01-01', runs: 7, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  const { app, calls } = makeReportApp({ Config: { report: { enabled: true } }, loadState: state })
  await app._updateReport(SUMMARY1)
  // 杀 hasCounters 判定与「发送后 return」缺失（否则会重复累计/持久化）
  assert.deepStrictEqual(calls.persist, [], '跨天日报分支不得再走就地累计持久化')
  assert.strictEqual(calls.cross.length, 1)
  assert.strictEqual(calls.cross[0].length, 4)
  assert.strictEqual(calls.cross[0][0], REPORT_PATH)
  assert.deepStrictEqual(calls.cross[0][1], state)
  assert.deepStrictEqual(calls.cross[0][2], SUMMARY1)
  assert.strictEqual(calls.cross[0][3], '2024-01-02')
})

checkAsync('_updateReport 跨天但计数全 0 ⇒ 不发明报，结转后累计（value[k] > 0 而非 >= 0）', async () => {
  const { app, calls } = makeReportApp({
    Config: { report: { enabled: true } },
    loadState: { date: '2024-01-01', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  })
  await app._updateReport(SUMMARY1)
  // 杀 > 0 → >= 0：全 0 会被误判「有计数」而错发空日报
  assert.deepStrictEqual(calls.cross, [])
  assert.deepStrictEqual(calls.persist, [[REPORT_PATH, {
    date: '2024-01-02',
    runs: 1,
    total: 1,
    dedup: 2,
    filtered: 3,
    pushed: 4,
    failed: 5,
    truncated: 6
  }]])
})

checkAsync('_updateReport 跨天 state 无计数但 pending 有 ⇒ 仍发明报（hasCounters(state)||hasCounters(pending)）', async () => {
  const { app, calls } = makeReportApp({
    Config: { report: { enabled: true } },
    loadState: {
      date: '2024-01-01',
      runs: 0,
      total: 0,
      dedup: 0,
      filtered: 0,
      pushed: 0,
      failed: 0,
      truncated: 0,
      pending: { runs: 0, total: 9, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
    }
  })
  await app._updateReport(SUMMARY1)
  // 杀 || → &&（两个 hasCounters 都是一个真一个假）
  assert.strictEqual(calls.cross.length, 1)
  assert.deepStrictEqual(calls.persist, [])
})

checkAsync('_updateReport 跨天结转 pending 各字段用 || 0 兜底（pending 假值不得串进计数器）', async () => {
  // pending 为未归一化的假值 ''（'' || 0 === 0；若 || 被换成 && 则留下 ''，
  // 随后 += 变成字符串拼接 ⇒ 精确断言立刻变红）
  const { app, calls } = makeReportApp({
    Config: { report: { enabled: true } },
    loadState: {
      date: '2024-01-01',
      runs: 0,
      total: 0,
      dedup: 0,
      filtered: 0,
      pushed: 0,
      failed: 0,
      truncated: 0,
      pending: { runs: '', total: '', dedup: '', filtered: '', pushed: '', failed: '', truncated: '' }
    }
  })
  await app._updateReport(SUMMARY1)
  assert.deepStrictEqual(calls.cross, [])
  assert.deepStrictEqual(calls.persist, [[REPORT_PATH, {
    date: '2024-01-02',
    runs: 1,
    total: 1,
    dedup: 2,
    filtered: 3,
    pushed: 4,
    failed: 5,
    truncated: 6
  }]])
})

checkAsync('_updateReport 跨天有 pending 时把它当结转基数（Object.assign 七字段）', async () => {
  const { app, calls } = makeReportApp({
    Config: { report: { enabled: true } },
    loadState: {
      date: '2024-01-01',
      runs: 0,
      total: 0,
      dedup: 0,
      filtered: 0,
      pushed: 0,
      failed: 0,
      truncated: 0,
      pending: { runs: 5, total: 6, dedup: 7, filtered: 8, pushed: 9, failed: 10, truncated: 11 }
    }
  })
  await app._updateReport(SUMMARY1)
  // pending 有计数 ⇒ 走日报分支（不结转），确认分支选择没被 hasCounters 变异体颠倒
  assert.strictEqual(calls.cross.length, 1)
  assert.deepStrictEqual(calls.persist, [])
})

checkAsync('_updateReport 内部异常 ⇒ 写 WARN 留痕且不向主流程冒泡', async () => {
  const { app, runLogs, calls } = makeReportApp({
    Config: { report: { enabled: true } },
    loadThrows: new Error('读取溃败\n第二行')
  })
  // 杀整体 try/catch 被删（会冒泡中断主流程）与 WARN 行格式/换行清洗变异体
  assert.strictEqual(await app._updateReport(SUMMARY1), undefined)
  assert.deepStrictEqual(runLogs, ['STAMP WARN 日报更新异常: 读取溃败 第二行\n'])
  assert.deepStrictEqual(calls.persist, [])
})

// ------------------------------------------------------------------ _sendAlert
checkAsync('_sendAlert 开关/配置缺失 ⇒ 直接跳过：无发送、无留痕、无状态写入', async () => {
  const off = makeNotifyApp({ Config: { alert: { enabled: false } } })
  assert.strictEqual(await off.app._sendAlert('boom'), undefined)
  assert.deepStrictEqual(off.sent, [])
  assert.deepStrictEqual(off.runLogs, [])
  assert.deepStrictEqual(off.stateWrites, [])
  const none = makeNotifyApp({ Config: {} })
  assert.strictEqual(await none.app._sendAlert('boom'), undefined)
  assert.deepStrictEqual(none.sent, [])
})

checkAsync('_sendAlert 成功路径：标题/正文分段/run.log 留痕/alert.state/返回值 true', async () => {
  const now = 1700000000000
  const { app, sent, stateWrites, runLogs } = makeNotifyApp({
    Config: { alert: { enabled: true, intervalMs: 90000 } }
  })
  const { value, msgs } = await withFixedNowAsync(now, async () => {
    return withCaptureAsync('log', () => app._sendAlert('boom'))
  })
  assert.strictEqual(value, true)
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0][0], '⚠️ xbk-push 运行异常')
  const parts = sent[0][1].split('\n\n')
  // 杀 \n\n 段落分隔、正文前缀、「时间：」「原因：」字面量与原因拼接口径
  assert.strictEqual(parts.length, 3)
  assert.strictEqual(parts[0], '接口/推送异常，请检查。')
  assert.strictEqual(parts[1].slice(0, 3), '时间：')
  assert.strictEqual(parts[2], '原因：boom')
  assert.deepStrictEqual(runLogs, ['STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：boom\n'])
  // C1-004：状态文件有意扩展为 {lastAt, classes.<key>}（仍精确 deepEqual，未放宽）；lastAt 语义不变
  assert.deepStrictEqual(stateWrites, [[ALERT_PATH, '{"lastAt":1700000000000,"classes":{"alert":1700000000000}}']])
  assert.deepStrictEqual(app._alertLastAtByPath.get(ALERT_PATH), { lastAt: now, classes: { alert: now }, persisted: true })
  // 杀 Math.ceil 与 /60000 口径：90000ms ⇒ 2 分钟
  assert.deepStrictEqual(msgs, ['已发送运行异常告警（限频 2 分钟）'])
})

checkAsync('_sendAlert 原因截断 500 与 safeErrorText 缺省（slice/回退字面量）', async () => {
  const now = 1700000000000
  const long = 'x'.repeat(600)
  const { app, sent } = makeNotifyApp({ Config: { alert: { enabled: true } } })
  await withFixedNowAsync(now, () => silentAlert(app, long))
  assert.strictEqual(sent[0][1].split('\n\n')[2], '原因：' + 'x'.repeat(500))
  const dflt = makeNotifyApp({ Config: { alert: { enabled: true } } })
  await withFixedNowAsync(now, () => silentAlert(dflt.app, null))
  assert.strictEqual(dflt.sent[0][1].split('\n\n')[2], '原因：未知错误')
})

async function alertWithLastAt (lastAt, intervalMs, now, extra = {}) {
  const made = makeNotifyApp(Object.assign({
    Config: { alert: { enabled: true, intervalMs } },
    readSafeTextResult: () => ({ status: 'ok', text: JSON.stringify({ lastAt }) })
  }, extra))
  const value = await withFixedNowAsync(now, () => silentAlert(made.app, 'boom'))
  return Object.assign({ value }, made)
}

checkAsync('_sendAlert 限频窗口：lastAt 恰好等于 now 判为未过期（<= 而非 <）', async () => {
  const now = 1700000000000
  const r = await alertWithLastAt(now, 5000, now)
  // 杀 lastAt <= Date.now() → <：未来/相等时间戳不得被当成 0 而无限频重发
  assert.strictEqual(r.value, undefined)
  assert.deepStrictEqual(r.sent, [])
  const stale = await alertWithLastAt(now - 5000, 5000, now)
  // 杀 Date.now() - lastAt < interval → <=：恰好到期必须发送
  assert.strictEqual(stale.value, true)
  assert.strictEqual(stale.sent.length, 1)
})

checkAsync('_sendAlert 限频条件真假两侧（interval>0 && 未到期）', async () => {
  const now = 1700000000000
  const recent = await alertWithLastAt(now - 1000, 5000, now)
  // 真侧：窗口内不重发
  assert.strictEqual(recent.value, undefined)
  assert.deepStrictEqual(recent.sent, [])
  const old = await alertWithLastAt(now - 10000, 5000, now)
  // 杀 && → ||：已过窗口必须发送
  assert.strictEqual(old.value, true)
  assert.strictEqual(old.sent.length, 1)
  const future = await alertWithLastAt(now + 1000000, 5000, now)
  // 杀 lastAt 校验里 && → ||：未来时间戳必须被归零后照常发送
  assert.strictEqual(future.value, true)
  assert.strictEqual(future.sent.length, 1)
  const unlimited = await alertWithLastAt(now - 1000, 0, now)
  // interval <= 0 = 不限频：杀区间判定取反
  assert.strictEqual(unlimited.value, true)
  assert.strictEqual(unlimited.sent.length, 1)
})

checkAsync('_sendAlert intervalMs 非法字符串回落默认 3600000（Utils.num 口径）', async () => {
  const now = 1700000000000
  const r = await alertWithLastAt(now - 1000, 'abc', now)
  // 杀删除 Utils.num 回退：'abc' 会变成 NaN/0 ⇒ 不限频误发
  assert.strictEqual(r.value, undefined)
  assert.deepStrictEqual(r.sent, [])
})

checkAsync('_sendAlert 限频取内存与文件 lastAt 的较大值（Math.max 而非 min）', async () => {
  const now = 1700000000000
  const { app, sent } = makeNotifyApp({
    Config: { alert: { enabled: true, intervalMs: 3600000 } },
    readSafeTextResult: () => ({ status: 'ok', text: JSON.stringify({ lastAt: 0 }) })
  })
  app._alertLastAtByPath.set(ALERT_PATH, { lastAt: now, persisted: true })
  const r = await withFixedNowAsync(now, () => silentAlert(app, 'boom'))
  // 内存里更近的 lastAt 必须胜出；Math.min 会取 0 ⇒ 误发
  assert.strictEqual(r, undefined)
  assert.deepStrictEqual(sent, [])
})

checkAsync('_sendAlert 已持久化内存状态但文件被删 ⇒ 丢弃内存限频并重发', async () => {
  const now = 1700000000000
  const { app, sent } = makeNotifyApp({
    Config: { alert: { enabled: true, intervalMs: 3600000 } },
    fs: { existsSync: () => false }
  })
  app._alertLastAtByPath.set(ALERT_PATH, { lastAt: now - 1000, persisted: true })
  const r = await withFixedNowAsync(now, () => silentAlert(app, 'boom'))
  // 杀 `persisted && !fs.existsSync` 的条件取反：文件没了仍按内存限频 = 静默丢告警
  assert.strictEqual(r, true)
  assert.strictEqual(sent.length, 1)
  assert.deepStrictEqual(app._alertLastAtByPath.get(ALERT_PATH), { lastAt: now, classes: { alert: now }, persisted: true })
})

checkAsync('_sendAlert 未持久化的内存状态不因文件存在与否重置（persisted 合取项）', async () => {
  const now = 1700000000000
  const { app, sent } = makeNotifyApp({
    Config: { alert: { enabled: true, intervalMs: 3600000 } },
    fs: { existsSync: () => false }
  })
  app._alertLastAtByPath.set(ALERT_PATH, { lastAt: now - 1000, persisted: false })
  const r = await withFixedNowAsync(now, () => silentAlert(app, 'boom'))
  // 杀删除 persisted && ：仅写失败的内存状态不因文件缺失而被清零
  assert.strictEqual(r, undefined)
  assert.deepStrictEqual(sent, [])
})

checkAsync('_sendAlert 状态文件 ok 但 JSON 损坏 ⇒ 忽略（catch 不得消失）', async () => {
  const now = 1700000000000
  const { app, sent } = makeNotifyApp({
    Config: { alert: { enabled: true } },
    readSafeTextResult: () => ({ status: 'ok', text: 'not-json' })
  })
  // 杀 JSON.parse 的 try/catch 被删（会冒泡 ⇒ 返回 false 且不发送）
  assert.strictEqual(await withFixedNowAsync(now, () => silentAlert(app, 'boom')), true)
  assert.strictEqual(sent.length, 1)
})

checkAsync('_sendAlert 限频状态读取失败（ioError）⇒ 保守跳过并明示，不发送', async () => {
  const now = 1700000000000
  const { app, sent, runLogs, stateWrites } = makeNotifyApp({
    Config: { alert: { enabled: true } },
    readSafeTextResult: () => ({ status: 'ioError', text: '' })
  })
  const { value, msgs } = await withFixedNowAsync(now, async () => {
    return withCaptureAsync('error', () => silentAlert(app, 'boom'))
  })
  // 杀 `status !== 'missing'` 取反与 console.error 文案：读失败不得当成「无状态」而重置限频
  assert.strictEqual(value, undefined)
  assert.deepStrictEqual(msgs, [`告警限频状态读取失败(ioError)，跳过本次告警以免限频被重置导致重复推送 ${ALERT_PATH}`])
  assert.deepStrictEqual(sent, [])
  assert.deepStrictEqual(runLogs, [])
  assert.deepStrictEqual(stateWrites, [])
})

checkAsync('_sendAlert 发送失败 ⇒ 返回 false、补失败留痕、不写限频状态', async () => {
  const now = 1700000000000
  const { app, sent, stateWrites, runLogs } = makeNotifyApp({
    Config: { alert: { enabled: true } },
    sendError: new Error('通道 500\n第二行')
  })
  const r = await withFixedNowAsync(now, () => silentAlert(app, 'boom'))
  // 杀 catch 分支被删 / 返回 true / 失败也写 lastAt（会导致 60s 内静默丢告警）
  assert.strictEqual(r, false)
  assert.strictEqual(sent.length, 1)
  assert.deepStrictEqual(stateWrites, [])
  assert.strictEqual(app._alertLastAtByPath.size, 0)
  assert.deepStrictEqual(runLogs, [
    'STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：boom\n',
    'STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：通道 500 第二行\n'
  ])
})

checkAsync('_sendAlert 持久化失败 ⇒ 仍返回 true 并告警，内存限频 persisted:false', async () => {
  const now = 1700000000000
  const { app, stateWrites } = makeNotifyApp({ Config: { alert: { enabled: true, intervalMs: 120000 } }, writeOk: false })
  const { value, msgs } = await withFixedNowAsync(now, async () => {
    return withCaptureAsync('warn', () => silentAlert(app, 'boom'))
  })
  // 杀 if (!persisted) 取反与 persisted 标记写错
  assert.strictEqual(value, true)
  assert.deepStrictEqual(msgs, ['⚠️ 运行异常告警已发送，但 alert.state 持久化失败；本进程将继续使用内存限频'])
  assert.deepStrictEqual(stateWrites, [[ALERT_PATH, '{"lastAt":1700000000000,"classes":{"alert":1700000000000}}']])
  assert.deepStrictEqual(app._alertLastAtByPath.get(ALERT_PATH), { lastAt: now, classes: { alert: now }, persisted: false })
})

checkAsync('_sendAlert 同步异常（Pusher.send 抛出）⇒ 返回 false 且不冒泡', async () => {
  const now = 1700000000000
  const { app, runLogs, stateWrites } = makeNotifyApp({
    Config: { alert: { enabled: true } },
    sendThrows: new Error('syncboom')
  })
  // 杀外层 try/catch 被删（同步异常会中断主流程）与 F1 留痕文案
  assert.strictEqual(await withFixedNowAsync(now, () => silentAlert(app, 'boom')), false)
  assert.deepStrictEqual(runLogs, [
    'STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：boom\n',
    'STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：syncboom\n'
  ])
  assert.deepStrictEqual(stateWrites, [])
})

checkAsync('_sendAlert 留痕自身抛错 ⇒ 仍返回 false，不外泄（J1 内层 try/catch）', async () => {
  const now = 1700000000000
  const { app } = makeNotifyApp({ Config: { alert: { enabled: true } }, sendThrows: new Error('syncboom') })
  app._writeRunLog = () => { throw new Error('disk full') }
  // 杀 J1 内层 try/catch 被删：留痕失败会使调用方 await 中断
  assert.strictEqual(await withFixedNowAsync(now, () => silentAlert(app, 'boom')), false)
})

// ============================================================================
// 修复轮：针对第一轮 replay 的 20 个存活变异体逐条补杀（14 条可杀 + 6 条等价）
// ============================================================================

check('_validateTplConfig 非字符串模板不做占位符扫描（typeof 守卫的 continue 不可省）', () => {
  // 324 ConditionalExpression：typeof tpl !== 'string' → false。守卫一旦短路，
  // 下面 /\{([^{}]+)\}/g.exec(tpl) 会把对象/数组强转成字符串并误报占位符。
  const a = makeApp({ Config: { template: { title: { toString: () => '{未知}' }, content: '{标题}' } } })
  assert.deepStrictEqual(a._validateTplConfig(), ['⚠️ 配置「template.title/content」应为字符串，已回退默认模板'])
  const b = makeApp({ Config: { template: { title: ['{未知}'], content: '{标题}' } } })
  assert.deepStrictEqual(b._validateTplConfig(), ['⚠️ 配置「template.title/content」应为字符串，已回退默认模板'])
})

check('_accumulateReport 边界 ±0：n >= 0 对 -0 判真（>= 而非 >）', () => {
  // 968 EqualityOperator：n >= 0 → n > 0。两者只在 n 为 ±0 时分叉：
  // 原式 -0 >= 0 为真 ⇒ 原样返回 -0，-0 + -0 = -0；变异后 -0 > 0 为假 ⇒ 回退 0，-0 + 0 = +0。
  // strictEqual 走 Object.is 口径，±0 可区分。
  const st = { date: '', runs: 0, total: -0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
  app._accumulateReport(st, { total: -0 })
  assert.strictEqual(st.total, -0)
  assert.strictEqual(st.runs, 1)
})

checkAsync('_sendCrossDayReport 持久化成功时不得出现「未持久化」告警（!pendingSaved 取反）', async () => {
  // 1006 ConditionalExpression：!pendingSaved → true。写成功时不得凭空告警。
  const { app, sent } = makeNotifyApp({ Config: {} })
  const state = { date: '2024-01-01', runs: 1, total: 1, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0, pending: { runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 } }
  const cap = await withCaptureAsync('log', () => withCaptureAsync('warn', () => app._sendCrossDayReport(REPORT_PATH, state, {}, '2024-01-02')))
  assert.deepStrictEqual(cap.value.msgs, [])
  assert.strictEqual(sent.length, 1)
})

checkAsync('_sendCrossDayReport pending 计数全假值时不出「今日待结转」块（长 || 链不可换成 true）', async () => {
  // 988 ConditionalExpression：整条 pendingState.pending.* || ... 链 → true。
  // pending.runs 传入 -1，累计后为 0，七个字段全假 ⇒ 原实现不渲染结转块。
  const { app, sent } = makeNotifyApp({ Config: {} })
  const state = { date: '2024-01-01', runs: 1, total: 2, dedup: 0, filtered: 0, pushed: 3, failed: 0, truncated: 0, pending: { runs: -1, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 } }
  await withCaptureAsync('log', () => app._sendCrossDayReport(REPORT_PATH, state, {}, '2024-01-02'))
  assert.deepStrictEqual(sent, [[
    '📊 xbk-push 日报（2024-01-01）',
    '运行 1 轮 | 推送 3 条 | 失败 0 条\n\n获取 2 | 去重 0 | 过滤 0'
  ]])
})

checkAsync('_updateReport 跨天 hasCounters 覆盖 reportKeys 余下 5 个字段（数组字面量逐项不可省）', async () => {
  // 1061-1065 StringLiteral：'dedup'/'filtered'/'pushed'/'failed'/'truncated' → ""。
  // 逐个字段单独置 1，任何一项被替换成空串都会漏判「有计数」而错走结转分支。
  for (const key of ['dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
    const state = { date: '2024-01-01', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
    state[key] = 1
    const { app, calls } = makeReportApp({ Config: { report: { enabled: true } }, loadState: state })
    await app._updateReport(SUMMARY1)
    assert.strictEqual(calls.cross.length, 1, `仅 ${key} > 0 时也必须走跨天日报分支`)
    assert.deepStrictEqual(calls.persist, [], `仅 ${key} > 0 时不得走就地累计`)
  }
})

checkAsync('_sendAlert 负 intervalMs 视为不限频且日志按 0 分钟口径（区间三元不可省）', async () => {
  // 401 ConditionalExpression：intervalMs > 0 → true，interval 变成 -60000，
  // 日志口径 Math.ceil(-60000/60000) = -1 ⇒ 「限频 -1 分钟」。
  const now = 1700000000000
  const { app, sent } = makeNotifyApp({ Config: { alert: { enabled: true, intervalMs: -60000 } } })
  const { value, msgs } = await withFixedNowAsync(now, async () => {
    return withCaptureAsync('log', () => app._sendAlert(new Error('boom')))
  })
  assert.strictEqual(value, true)
  assert.strictEqual(sent.length, 1)
  assert.deepStrictEqual(msgs, ['已发送运行异常告警（限频 0 分钟）'])
})

checkAsync('_sendAlert 正文时间固定 Asia/Shanghai（toLocaleString 的 timeZone 选项不可省）', async () => {
  // 419 ObjectLiteral：{ timeZone: 'Asia/Shanghai' } → {}。冻结时钟后，丢失 timeZone
  // 在 TZ=UTC 下会渲染成前一天的 22:13:20。
  const now = 1700000000000
  const RealDate = Date
  class FixedDate extends RealDate {
    constructor (...args) { if (args.length === 0) super(now); else super(...args) }
    static now () { return now }
  }
  const { app, sent } = makeNotifyApp({ Config: { alert: { enabled: true } } })
  let value
  try {
    global.Date = FixedDate
    const cap = await withCaptureAsync('log', () => app._sendAlert(new Error('boom')))
    value = cap.value
  } finally {
    global.Date = RealDate
  }
  assert.strictEqual(value, true)
  // 1700000000000 = UTC 2023-11-14T22:13:20Z ⇒ 上海 2023/11/15 06:13:20
  assert.strictEqual(sent[0][1].split('\n\n')[1], '时间：2023/11/15 06:13:20')
})

checkAsync('_sendAlert run.log 原因截断 200（slice 不可省）', async () => {
  // 425 MethodExpression：safeReason.replace(...).slice(0, 200) → 去掉 .slice(0, 200)。
  const now = 1700000000000
  const { app, runLogs } = makeNotifyApp({ Config: { alert: { enabled: true } } })
  await withFixedNowAsync(now, () => silentAlert(app, new Error('A'.repeat(250))))
  assert.deepStrictEqual(runLogs, ['STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：' + 'A'.repeat(200) + '\n'])
})

checkAsync('_sendAlert 留痕把连续换行折叠成一个空格（+ 量词与替换串两侧）', async () => {
  // 426 Regex：/[\r\n]+/g → /[\r\n]/g（每个换行各折叠一次 ⇒ 两个空格）；
  // 428 StringLiteral：替换串 ' ' → ""（换行被删除而非折叠）。
  const now = 1700000000000
  const { app, runLogs } = makeNotifyApp({ Config: { alert: { enabled: true } } })
  await withFixedNowAsync(now, () => silentAlert(app, new Error('前段\n\n后段')))
  assert.deepStrictEqual(runLogs, ['STAMP ALERT [v1.2.3] ⚠️ xbk-push 运行异常 原因：前段 后段\n'])
})

// ===== RE2 缺失警告簇（RE2 警告标记生命周期：pending→completed/回收/7天清理）=====
// 全部经 makeApp 注入的内存 fs 桩运行，不触碰真实缓存目录。
// 锁契约：openSync 'wx' 独占创建；EEXIST 且陈旧且持有进程已退出才抢占。
// 标记契约：pending+已退出进程=残留可回收；completed 永不回收；解析失败保守保留。

// 内存 fs 桩：支持本簇用到的 API（existsSync/openSync/writeSync/closeSync/statSync/
// unlinkSync/readFileSync/readdirSync/writeFileSync），按路径键存内容与 mtime。
function makeMemFs () {
  const files = new Map() // path -> { content, mtime, fd }
  let nextFd = 10
  const now = () => Date.now()
  const fs = {
    existsSync: (p) => files.has(String(p)),
    openSync: (p, flags) => {
      p = String(p)
      if (flags === 'wx') {
        if (files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
        const fd = nextFd++
        files.set(p, { content: '', mtime: now(), fd })
        return fd
      }
      if (flags === 'r' || flags === undefined) {
        if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
        files.get(p).fd = nextFd++
        return files.get(p).fd
      }
      const e = new Error('unsupported flags ' + flags); e.code = 'EINVAL'; throw e
    },
    writeSync: (fd, text) => {
      for (const [, f] of files) if (f.fd === fd) { f.content += String(text); return String(text).length }
      throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
    },
    closeSync: (fd) => { /* fd 保留在 files 中（锁文件内容可读） */ },
    statSync: (p) => {
      p = String(p)
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { mtimeMs: files.get(p).mtime }
    },
    unlinkSync: (p) => {
      p = String(p)
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      files.delete(p)
    },
    readFileSync: (p) => {
      p = String(p)
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(p).content
    },
    readdirSync: (dir) => {
      const names = []
      let dp = String(dir)
      while (dp.length > 1 && dp.endsWith('/')) dp = dp.slice(0, -1)
      const dirPrefix = dp + '/'
      for (const p of files.keys()) {
        if (!p.startsWith(dirPrefix)) continue
        const base = p.slice(dirPrefix.length)
        if (base.includes('/')) continue
        names.push(base)
      }
      return names
    },
    writeFileSync: (p, text) => { files.set(String(p), { content: String(text), mtime: now(), fd: nextFd++ }) },
    renameSync: (a, b) => { if (!files.has(String(a))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); files.set(String(b), files.get(String(a))); files.delete(String(a)) },
    _files: files,
    _touch: (p, mtimeMs) => { if (files.has(String(p))) files.get(String(p)).mtime = mtimeMs }
  }
  return fs
}

// 构造带内存 fs 的 app：MessageStore 提供 cacheDir 与 _getTombstoneProcessStart/_isTombstoneLockProcessAlive 桩
const os = require('os')

checkAsync('RE2 警告: RE2C 可用时 _warnMissingRe2 早退只清理残留标记、不发警告', async () => {
  const mfs = makeMemFs()
  const dir = os.tmpdir()
  mfs.writeFileSync(dir + '/re2warn.state.2026-01-01', '{"status":"pending","pid":1}')
  let alerted = 0
  const app2 = createApp({
    Config: {},
    Utils: { safeErrorText: (e, d) => String((e && e.message) || d) },
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: { cacheDir: dir, _getTombstoneProcessStart: () => '', _isTombstoneLockProcessAlive: () => false },
    Network: {},
    Pusher: { send: async () => { alerted++; return true } },
    fs: mfs,
    path: require('path'),
    crypto: require('crypto'),
    readSafeTextResult: () => ({ status: 'missing', text: '' }),
    writeAtomic: () => true,
    isRegularOrMissing: () => true,
    STATE_TEXT_MAX_BYTES: 262144,
    DEFAULT_MAX_SIZE: 1048576,
    RE2C: { ok: true },
    RE2_WARN_STATE_FILE: 're2warn.state',
    RE2_MISSING_WARNING: '[re2 缺失提醒]',
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
  // RE2C 可用时 _warnMissingRe2 早退只清理不发警告——走真实入口而非直接调内部方法（CodeRabbit）
  await app2._warnMissingRe2()
  assert.strictEqual(mfs._files.has(dir + '/re2warn.state.2026-01-01'), false, '陈旧残留必须被清理')
  assert.strictEqual(alerted, 0, 'RE2C 可用时不得发送任何警告')
})

// --- RE2 警告标记生命周期用例组 ---
// 桩约定：app._localStamp() 用真实上海日界（createApp 内部实现），标记名 YYYY-MM-DD。

function makeRe2WarnApp ({ fs, cacheDir, alive = () => false, start = 'abc', sendAlert }) {
  return createApp({
    Config: { alert: { enabled: true } },
    Utils: { safeErrorText: (e, d) => String((e && e.message) || d), num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d } },
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: { cacheDir, _getTombstoneProcessStart: () => start, _isTombstoneLockProcessAlive: () => alive() },
    Network: {},
    Pusher: sendAlert ? { send: async () => { const r = await sendAlert(); if (r === false) throw new Error('send failed'); return r } } : {},
    fs,
    path: require('path'),
    crypto: require('crypto'),
    readSafeTextResult: (p, maxBytes) => {
      if (!fs.existsSync(p)) return { status: 'missing', text: '' }
      const text = fs.readFileSync(p)
      if (Buffer.byteLength(text) > maxBytes) return { status: 'oversize', text: '' }
      return { status: 'ok', text: String(text) }
    },
    writeAtomic: (p, text) => { fs.writeFileSync(p, text); return true },
    isRegularOrMissing: () => true,
    STATE_TEXT_MAX_BYTES: 262144,
    DEFAULT_MAX_SIZE: 1048576,
    RE2C: null,
    RE2_WARN_STATE_FILE: 're2warn.state',
    RE2_MISSING_WARNING: '[re2 缺失提醒]',
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

const dir = os.tmpdir()
const stamp = (() => {
  // 与生产同口径取上海日界（localStamp 未导出，直接读一个已生成标记来取，或用 Intl）
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
})()
const statePath = dir + '/re2warn.state.' + stamp

checkAsync('RE2 警告: 标记缺失时 _warnMissingRe2 创建 pending 标记并触发警告', async () => {
  const mfs = makeMemFs()
  let alerted = 0
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, sendAlert: async () => { alerted++; return true } })
  // createApp 把 _sendAlert 也解构了吗？检查调用形态：直接调内部簇——_warnMissingRe2 未导出为可异步调用入口？
  // 它在 createApp 对象里是 _warnMissingRe2；直接调用。
  await app._warnMissingRe2()
  assert.ok(mfs._files.has(statePath), '必须创建当天的标记文件')
  const parsed = JSON.parse(mfs.readFileSync(statePath))
  assert.strictEqual(parsed.status, 'completed', '发送成功后标记必须置 completed（防同天重复提醒）')
  assert.strictEqual(parsed.pid, process.pid, '标记必须记录 pid')
  assert.strictEqual(alerted, 1, '必须发送一次提醒')
})

checkAsync('RE2 警告: 当天已有 completed 标记时不重复提醒', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(statePath, JSON.stringify({ warnedAt: Date.now(), pid: process.pid, start: 'abc', status: 'completed' }))
  let alerted = 0
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => true, sendAlert: async () => { alerted++; return true } })
  await app._warnMissingRe2()
  assert.strictEqual(alerted, 0, 'completed 标记必须压制提醒')
})

checkAsync('RE2 警告: 发送失败(false)时标记被删除、下次可重试', async () => {
  const mfs = makeMemFs()
  let calls = 0
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, sendAlert: async () => { calls++; return false } })
  await app._warnMissingRe2()
  assert.strictEqual(mfs._files.has(statePath), false, '发送失败必须删除 pending 标记（下次运行可重试）')
  assert.strictEqual(calls, 1)
})

checkAsync('RE2 警告: pending 标记+持有进程已退出=残留，删除重建并警告', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(statePath, JSON.stringify({ warnedAt: Date.now(), pid: 999999, start: 'dead', status: 'pending' }))
  let alerted = 0
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => false, sendAlert: async () => { alerted++; return true } })
  await app._warnMissingRe2()
  assert.strictEqual(alerted, 1, '残留 pending 必须回收并重新警告')
  const parsed = JSON.parse(mfs.readFileSync(statePath))
  assert.strictEqual(parsed.status, 'completed', '重发成功后新标记应为 completed')
})

checkAsync('RE2 警告: 解析失败的标记保守保留、不回收不警告', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(statePath, 'not-json{{')
  let alerted = 0
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => false, sendAlert: async () => { alerted++; return true } })
  await app._warnMissingRe2()
  assert.strictEqual(alerted, 0, '损坏标记必须保守跳过（不回收不重发）')
  assert.strictEqual(mfs._files.has(statePath), true, '损坏标记文件不得被删除')
})

checkAsync('RE2 警告: 7 天前的标记被清理，当天的保留', async () => {
  const mfs = makeMemFs()
  const oldStamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 9 * 86400000))
  mfs.writeFileSync(dir + '/re2warn.state.' + oldStamp, '{"status":"completed"}')
  mfs.writeFileSync(dir + '/re2warn.state.2099-01-01', '{"status":"completed"}') // 未来日期：不得删
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => true })
  app._cleanupStaleRe2WarnMarkers()
  assert.strictEqual(mfs._files.has(dir + '/re2warn.state.' + oldStamp), false, '9 天前的标记必须清理')
  assert.strictEqual(mfs._files.has(dir + '/re2warn.state.2099-01-01'), true, '未来日期标记不得误删')
})

// ----- C1-002 回归：清理只删自身精确形状，同形的合法判重缓存/墓碑必须保留 -----
check('RE2 警告: 清理只删标记自身形状（标记/.lock/.reclaim/.tmp），同形的 .json 判重缓存与其墓碑必须保留', () => {
  const mfs = makeMemFs()
  const oldStamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 9 * 86400000))
  const base = dir + '/re2warn.state.' + oldStamp
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => true })
  // .tmp 残留必须按**生产真实命名**造：直接调 _writeRe2WarnMarkerAtomic，让它停在
  // writeFileSync 之后、rename 之前（rename 抛错 + 兜底 unlink 也失败，等价于进程在此处崩溃）。
  // 该函数命名是 `${statePath}.${process.pid}.${Date.now()}.tmp`——纯数字段、**无 hex 段**；
  // 旧白名单写死 12 位 hex（那是 xbk_storage.writeAtomic 的形态，re2 标记从不走它），会漏清真实残留。
  const origRename = mfs.renameSync
  const origUnlink = mfs.unlinkSync
  mfs.renameSync = () => { const e = new Error('EIO: rename failed'); e.code = 'EIO'; throw e }
  mfs.unlinkSync = (p) => {
    if (String(p).endsWith('.tmp')) { const e = new Error('EPERM: unlink failed'); e.code = 'EPERM'; throw e }
    return origUnlink(p)
  }
  const wrote = app._writeRe2WarnMarkerAtomic(base, '{"status":"pending"}')
  mfs.renameSync = origRename
  mfs.unlinkSync = origUnlink
  const tmpResidues = [...mfs._files.keys()].filter(p => p.startsWith(base + '.') && p.endsWith('.tmp'))
  assert.strictEqual(wrote, false, '模拟写入中途崩溃：_writeRe2WarnMarkerAtomic 必须返回 false')
  assert.strictEqual(tmpResidues.length, 1, `崩溃必须留下一个 .tmp 残留（实际 ${JSON.stringify(tmpResidues)}）`)
  const tmpResidue = tmpResidues[0]
  assert.match(tmpResidue.slice(base.length), /^\.\d+\.\d+\.tmp$/,
    `re2 标记 tmp 的真实形状是 <statePath>.<pid>.<ts>.tmp（无 hex 段），实际 ${tmpResidue}`)
  mfs.writeFileSync(base, '{"status":"completed"}')
  mfs.writeFileSync(base + '.lock', '999999:x')
  mfs.writeFileSync(base + '.1234.1700000000000.reclaim', '')
  // 自定义 pushUrl 末段恰为 re2warn.state.<date> 时，getFileName 得到的合法判重缓存及其墓碑
  // （含其 writeAtomic 临时文件：`<名字>.json.<pid>.<ts>.<hex12>.tmp`——带 .json 段，不属于本模块命名，不得删）
  mfs.writeFileSync(base + '.json', '{"items":[]}')
  mfs.writeFileSync(base + '.json.seen.json', '{"tombstones":[]}')
  mfs.writeFileSync(base + '.json.1234.1700000000000.abcdef123456.tmp', '')
  app._cleanupStaleRe2WarnMarkers()
  for (const suffix of ['', '.lock', '.1234.1700000000000.reclaim']) {
    assert.strictEqual(mfs._files.has(base + suffix), false, `过期残留「${suffix || '(标记)'}」必须清理`)
  }
  assert.strictEqual(mfs._files.has(tmpResidue), false, '崩溃残留的 re2 标记 .tmp 必须按真实形状清理（否则永久累积）')
  assert.strictEqual(mfs._files.has(base + '.json'), true, '同形合法判重缓存不得被启动清理删除（删了下轮全量重推）')
  assert.strictEqual(mfs._files.has(base + '.json.seen.json'), true, '判重缓存的 .seen.json 墓碑不得被删除（删了裁剪墓碑失效）')
  assert.strictEqual(mfs._files.has(base + '.json.1234.1700000000000.abcdef123456.tmp'), true,
    '判重缓存自己的 writeAtomic 临时文件（带 .json 段）不得被当成标记残留删除')
})

check('RE2 警告锁: 独占创建（wx），锁被占用且持锁进程存活时不抢占、超时放弃', () => {
  const mfs = makeMemFs()
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => true })
  mfs.writeFileSync(statePath + '.lock', '999999:xyz')
  mfs._touch(statePath + '.lock', Date.now()) // 新鲜锁
  const acquired = app._acquireRe2WarnLock(statePath)
  assert.strictEqual(acquired, null, '新鲜锁+持有进程存活必须放弃（返回 null）')
})

check('RE2 警告锁: 陈旧锁+持有进程已退出时抢占成功', () => {
  const mfs = makeMemFs()
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir, alive: () => false })
  mfs.writeFileSync(statePath + '.lock', '999999:dead')
  mfs._touch(statePath + '.lock', Date.now() - 20000) // 20s 前的陈旧锁（>10s LOCK_STALE_MS）
  const acquired = app._acquireRe2WarnLock(statePath)
  assert.ok(acquired, '陈旧锁+进程已退出必须抢占成功')
  app._releaseRe2WarnLock(statePath, acquired)
  assert.strictEqual(mfs._files.has(statePath + '.lock'), false, '释放后锁文件必须删除')
})

check('RE2 警告锁: 释放时关闭 fd 并删除锁文件；未获取时释放为 no-op', () => {
  const mfs = makeMemFs()
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir })
  const acquired = app._acquireRe2WarnLock(statePath)
  assert.ok(acquired, '无锁时应获取成功')
  app._releaseRe2WarnLock(statePath, acquired)
  assert.strictEqual(mfs._files.has(statePath + '.lock'), false, '锁文件应删除')
  // no-op：null 安全
  app._releaseRe2WarnLock(statePath, null)
})

check('RE2 警告: token 不匹配时 _completeRe2WarnMarker 不得改写他人 pending 标记', () => {
  const mfs = makeMemFs()
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir })
  const otherToken = JSON.stringify({ warnedAt: 123, pid: 424242, start: 'def', status: 'pending' })
  mfs.writeFileSync(statePath, otherToken)
  app._completeRe2WarnMarker(statePath, JSON.stringify({ warnedAt: 999, pid: process.pid, start: 'abc', status: 'pending' }))
  assert.strictEqual(mfs.readFileSync(statePath), otherToken, 'token 不匹配必须原样保留他人标记（防误改并发进程标记）')
  assert.strictEqual(JSON.parse(mfs.readFileSync(statePath)).status, 'pending', '他人标记 status 必须仍是 pending')
})

check('RE2 警告: token 不匹配时 _removeRe2WarnMarker 不得删除他人 pending 标记', () => {
  const mfs = makeMemFs()
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir })
  const otherToken = JSON.stringify({ warnedAt: 123, pid: 424242, start: 'def', status: 'pending' })
  mfs.writeFileSync(statePath, otherToken)
  app._removeRe2WarnMarker(statePath, JSON.stringify({ warnedAt: 999, pid: process.pid, start: 'abc', status: 'pending' }))
  assert.strictEqual(mfs._files.has(statePath), true, 'token 不匹配必须保留他人标记文件（防误删并发进程标记）')
  assert.strictEqual(mfs.readFileSync(statePath), otherToken, '保留的标记内容必须原样不变')
})

// --- 通道健康锁与恢复认领簇（FX3/APP-02：健康状态、认领租约、释放语义）---
// 桩约定同 RE2 簇：makeMemFs + makeRe2App（RE2C=null 但不影响本簇；走 makeRe2WarnApp 同参构造）。
// _updateChannelHealth 依赖 Config.channelHealth + Utils.num + summarizeError —— 用注入参数定制。

function makeHealthApp ({ fs, cacheDir = dir, alive = () => false, start = 'abc', sendAlert, threshold = 3, intervalMs = 3600000 }) {
  return createApp({
    Config: { channelHealth: { enabled: true, consecutiveFailures: threshold, intervalMs } },
    Utils: {
      safeErrorText: (e, d) => String((e && e.message) || d),
      num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
    },
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: { cacheDir, _getTombstoneProcessStart: () => start, _isTombstoneLockProcessAlive: () => alive() },
    Network: {},
    Pusher: {},
    fs,
    path: require('path'),
    crypto: require('crypto'),
    readSafeTextResult: (p, maxBytes) => {
      if (!fs.existsSync(p)) return { status: 'missing', text: '' }
      const text = fs.readFileSync(p)
      if (Buffer.byteLength(text) > maxBytes) return { status: 'oversize', text: '' }
      return { status: 'ok', text: String(text) }
    },
    writeAtomic: (p, text) => { fs.writeFileSync(p, text); return true },
    isRegularOrMissing: () => true,
    STATE_TEXT_MAX_BYTES: 262144,
    DEFAULT_MAX_SIZE: 1048576,
    RE2C: null,
    RE2_WARN_STATE_FILE: 're2warn.state',
    RE2_MISSING_WARNING: '[re2]',
    summarizeError: (e) => (e && e.message) || 'err',
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

const healthPath = dir + '/channel-health.state'

// C1-008：同时抓 warn/error，供「errno 透出 vs 谎报另一轮」两侧断言
async function runHealthWithCapturedConsole (app) {
  const origWarn = console.warn
  const origError = console.error
  const warns = []
  const errs = []
  console.warn = (...a) => warns.push(a.map(String).join(' '))
  console.error = (...a) => errs.push(a.map(String).join(' '))
  try {
    await app._updateChannelHealth({ successfulChannels: ['pushplus'], failures: [] })
  } finally {
    console.warn = origWarn
    console.error = origError
  }
  return { warns, errs }
}

// 变异回归（app mutation RuntimeError）：channelHealth 关闭时 _updateChannelHealth 早退，
// finally 仍会走 _releaseChannelHealthLock。哨兵早已是 null（UnaryOperator 对 null 无从下手），
// 真正挡住「把 stdio 当锁 fd 关掉」的是该方法的 `>2` 守卫：旧实现 -1 → +1 的变异体会在这里
// close(1) 直接关掉 stdout，把测试进程崩成 RuntimeError。
// 这里用 closeSync 观察器把「关 stdio」变成可断言的失败，而不是让进程崩掉。
checkAsync('通道健康锁: 关闭健康观测时不得关闭 stdio fd（>2 守卫回归）', async () => {
  const realFs = require('fs')
  const closed = []
  const spyFs = new Proxy(realFs, {
    get (target, prop) {
      if (prop === 'closeSync') {
        return (fd) => {
          closed.push(fd)
          if (fd > 2) target.closeSync(fd)
        }
      }
      return target[prop]
    }
  })
  const app = makeHealthApp2({ fs: spyFs, enabled: false })
  await app._updateChannelHealth({ successfulChannels: [], failures: [] })
  assert.deepStrictEqual(closed.filter(fd => fd >= 0 && fd <= 2), [],
    `关闭健康观测时清理不得 close stdio fd，实际关闭：${closed.join(',')}`)
})

check('通道健康锁: 释放时拒绝 close stdio fd（0/1/2）', () => {
  const closed = []
  const app = makeHealthApp({
    fs: {
      closeSync: (fd) => closed.push(fd),
      unlinkSync: () => {}
    }
  })
  for (const fd of [0, 1, 2]) app._releaseChannelHealthLock('', fd)
  assert.deepStrictEqual(closed, [], `不得关闭 stdio fd，实际关闭：${closed.join(',')}`)
})

// N2 回归：>2 守卫只管 close，不能把 unlink 一起跳过——fd 落在 stdio 区时锁文件仍必须删除。
// 旧实现把 close 与 unlink 放在同一个 `lockFd > 2` 分支里，0/1/2 时锁文件残留，后续轮次
// 一直被陈旧锁挡在门外（要等 mtime 超龄 + 存活复核才回收，健康状态整段漏更新）。
check('通道健康锁: 释放时 fd 落在 stdio（0/1/2）仍清理锁文件，不得漏 unlink', () => {
  for (const fd of [0, 1, 2]) {
    const closed = []
    const unlinked = []
    const app = makeHealthApp({
      fs: {
        closeSync: (x) => closed.push(x),
        unlinkSync: (p) => unlinked.push(p)
      }
    })
    app._releaseChannelHealthLock(healthPath + '.lock', fd)
    assert.deepStrictEqual(closed, [], `fd=${fd}: 不得关闭 stdio`)
    assert.deepStrictEqual(unlinked, [healthPath + '.lock'], `fd=${fd}: 锁文件必须删除，否则后续轮次一直被挡`)
  }
  // 未取到锁（null / -1）时不得删别人的锁文件
  const unlinked = []
  const app = makeHealthApp({ fs: { closeSync: () => {}, unlinkSync: (p) => unlinked.push(p) } })
  app._releaseChannelHealthLock(healthPath + '.lock', null)
  app._releaseChannelHealthLock(healthPath + '.lock', -1)
  assert.deepStrictEqual(unlinked, [], '未取到锁（null/-1）不得 unlink 他人的锁文件')
})

// N2 回归：>2 分支本身要有牙——此前把 `if (lockFd > 2) closeSync` 整段删掉，套件仍 242/242 全绿。
check('通道健康锁: 释放时 fd>2 必须 close（close 分支不被静默删除）', () => {
  const realFs = require('fs')
  const closed = []
  const app = makeHealthApp({
    fs: {
      closeSync: (fd) => { closed.push(fd); realFs.closeSync(fd) },
      unlinkSync: () => {}
    }
  })
  // 探针必须落在**不可预测**的私有目录里：旧写法 `os.tmpdir() + '/channel-health.state.fdprobe'`
  // 名字可预测、写盘也不带 O_EXCL，同机任何进程都能抢先占位——先建同名目录 ⇒ 这里 `openSync` EISDIR
  // 直接炸（用例在断言前崩），先建同名符号链接 ⇒ `'w'` 打开会把别人的目标文件截成 0 字节而套件照旧
  // 全绿（实测 243/243、受害文件 31 → 0 字节）。CodeQL 视作「Insecure creation of file in the os temp dir」。
  // 前缀按本文件 C5-025 口径用 `xbkunit-`（不是 `xbk-`：后者落进 check-host-clean 的「过期沙箱」命名
  // 空间，被 SIGKILL 后的残留会误拦下一轮 check）；本用例是早期注册的，mkTmpFixture 的 const 尚未初始化，
  // 故就地建目录并在 finally 里整目录删除。
  const tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'xbkunit-fdprobe-'))
  const probePath = path.join(tmpDir, 'probe')
  const probe = realFs.openSync(probePath, 'w')
  try {
    // 前置断言：探针必须真是本用例独占的普通文件（私有目录被同名目录/符号链接顶替时当场点名，
    // 而不是让下面的 EBADF 断言在无关失败形态上给出误导文本）
    assert.ok(realFs.statSync(probePath).isFile(), '探针必须落在 mkdtemp 私有目录里的普通文件上')
    assert.ok(probe > 2, `探针 fd 必须 >2，实际 ${probe}`)
    app._releaseChannelHealthLock(healthPath + '.lock', probe)
    assert.deepStrictEqual(closed, [probe], `fd>2 时必须 close 锁 fd，实际关闭：${closed.join(',') || '无'}`)
    assert.throws(() => realFs.fstatSync(probe), /EBADF/, 'close 之后该 fd 必须已失效')
  } finally {
    try { realFs.closeSync(probe) } catch { /* 已关闭 */ }
    realFs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

check('通道健康锁: 无锁时独占获取成功并写入 pid 令牌；释放删除锁文件', () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs })
  const fd = app._tryAcquireChannelHealthLock(healthPath + '.lock')
  assert.ok(fd >= 0, '无竞争时必须获取成功')
  assert.ok(mfs.readFileSync(healthPath + '.lock').includes(String(process.pid)), '锁文件必须写入 pid 令牌（存活复核/PID 复用判别）')
  app._releaseChannelHealthLock(healthPath + '.lock', fd)
  assert.strictEqual(mfs._files.has(healthPath + '.lock'), false, '释放后锁文件必须删除')
})

check('通道健康锁: 锁被占用且持有进程存活时返回 -1（跳过本轮，不覆盖他人状态）', () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs, alive: () => true })
  mfs.writeFileSync(healthPath + '.lock', '999999:x')
  mfs._touch(healthPath + '.lock', Date.now()) // 新鲜
  assert.strictEqual(app._tryAcquireChannelHealthLock(healthPath + '.lock'), -1, '新鲜锁+存活必须返回 -1')
})

check('通道健康锁: 陈旧锁+持有进程退出时抢占重获', () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs, alive: () => false })
  mfs.writeFileSync(healthPath + '.lock', '999999:dead')
  mfs._touch(healthPath + '.lock', Date.now() - 20000)
  const fd = app._tryAcquireChannelHealthLock(healthPath + '.lock')
  assert.ok(fd >= 0, '陈旧锁必须可抢占')
  app._releaseChannelHealthLock(healthPath + '.lock', fd)
})

check('通道健康锁: 非 EEXIST 异常（如权限）直接返回 -1 不得死循环', () => {
  const mfs = makeMemFs()
  mfs.openSync = (p, flags) => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }
  const app = makeHealthApp({ fs: mfs })
  assert.strictEqual(app._tryAcquireChannelHealthLock(healthPath + '.lock'), -1, 'EACCES 必须立即放弃')
})

// ----- C1-008 回归：锁失败必须按 errno 分类透出，不得一律谎报「正由另一轮更新」-----
checkAsync('通道健康锁: 非 EEXIST（EACCES）锁失败须打印 errno，不得谎报「正由另一轮更新」', async () => {
  const mfs = makeMemFs()
  mfs.openSync = () => { const e = new Error('EACCES: permission denied, open ...'); e.code = 'EACCES'; throw e }
  const app = makeHealthApp({ fs: mfs })
  const { warns, errs } = await runHealthWithCapturedConsole(app)
  assert.ok(errs.some(m => m.includes('EACCES')), `锁获取失败必须在错误日志里带 errno：errs=${JSON.stringify(errs)}`)
  assert.strictEqual(warns.some(m => m.includes('正由另一轮更新')), false,
    `非 EEXIST 失败不得谎报另一轮占用：warns=${JSON.stringify(warns)}`)
})

checkAsync('通道健康锁: 陈旧锁 unlink 失败（EROFS）须打印 errno，不得谎报「正由另一轮更新」', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(healthPath + '.lock', '999999:dead')
  mfs._touch(healthPath + '.lock', Date.now() - 20000)
  mfs.unlinkSync = () => { const e = new Error('EROFS: read-only file system'); e.code = 'EROFS'; throw e }
  const app = makeHealthApp({ fs: mfs, alive: () => false })
  const { warns, errs } = await runHealthWithCapturedConsole(app)
  assert.ok(errs.some(m => m.includes('EROFS')), `unlink 失败必须在错误日志里带 errno：errs=${JSON.stringify(errs)}`)
  assert.strictEqual(warns.some(m => m.includes('正由另一轮更新')), false,
    `unlink 失败不得谎报另一轮占用：warns=${JSON.stringify(warns)}`)
})

checkAsync('通道健康锁: 抢占后二次 open 失败（EACCES）须打印 errno，不得谎报「正由另一轮更新」', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(healthPath + '.lock', '999999:dead')
  mfs._touch(healthPath + '.lock', Date.now() - 20000)
  const realOpen = mfs.openSync
  let wxCalls = 0
  mfs.openSync = (p, flags) => {
    if (flags === 'wx') {
      wxCalls++
      if (wxCalls === 2) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e }
    }
    return realOpen(p, flags)
  }
  const app = makeHealthApp({ fs: mfs, alive: () => false })
  const { warns, errs } = await runHealthWithCapturedConsole(app)
  assert.strictEqual(wxCalls, 2, '陈旧锁回收后必须再试一次 open')
  assert.ok(errs.some(m => m.includes('EACCES')), `二次 open 失败必须在错误日志里带 errno：errs=${JSON.stringify(errs)}`)
  assert.strictEqual(warns.some(m => m.includes('正由另一轮更新')), false,
    `二次 open 失败不得谎报另一轮占用：warns=${JSON.stringify(warns)}`)
})

checkAsync('通道健康锁: EEXIST+持有者存活仍打印「正由另一轮更新」（真实并发不得被说成故障）', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(healthPath + '.lock', '999999:x')
  mfs._touch(healthPath + '.lock', Date.now())
  const app = makeHealthApp({ fs: mfs, alive: () => true })
  const { warns, errs } = await runHealthWithCapturedConsole(app)
  assert.ok(warns.some(m => m.includes('正由另一轮更新')), `持有者存活必须按并发处理：warns=${JSON.stringify(warns)}`)
  assert.strictEqual(errs.length, 0, `真实并发不应进错误日志：errs=${JSON.stringify(errs)}`)
})

check('恢复认领: _newChannelRecoverClaim 两次生成不重复（含 pid 前缀）', () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs })
  const a = app._newChannelRecoverClaim()
  const b = app._newChannelRecoverClaim()
  assert.notStrictEqual(a, b, '两次认领令牌不得相同')
  assert.ok(a.startsWith(String(process.pid) + '-'), '令牌应以 pid 开头')
})

check('恢复认领: 租约内(60s)的 pending+claim 视为存活', () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs })
  const now = Date.now()
  assert.strictEqual(app._isChannelRecoverClaimAlive({ recoverAlertClaim: 'c1', recoverAlertClaimAt: now - 1000 }, now), true, '1s 前的认领必须在 60s 租约内')
  assert.strictEqual(app._isChannelRecoverClaimAlive({ recoverAlertClaim: 'c1', recoverAlertClaimAt: now - 61000 }, now), false, '61s 前的认领必须已过期')
  assert.strictEqual(app._isChannelRecoverClaimAlive(null, now), false, 'null entry 必须视为失效')
  assert.strictEqual(app._isChannelRecoverClaimAlive({ recoverAlertClaim: '', recoverAlertClaimAt: now }, now), false, '空 claim 必须失效')
  assert.strictEqual(app._isChannelRecoverClaimAlive({ recoverAlertClaim: 'c', recoverAlertClaimAt: 'NaN' }, now), false, '非法 claimedAt 必须失效（宁可重发不卡死）')
})

checkAsync('恢复认领释放: 令牌匹配才清 pending；不匹配不动作', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs })
  mfs.writeFileSync(healthPath, JSON.stringify({
    wxpusher: { consecutiveFailures: 3, lastFailureAt: 1, lastAlertAt: 2, lastRecoveredAt: 0, recoverAlertPending: true, recoverAlertClaim: 'tok-1', recoverAlertClaimAt: Date.now() }
  }))
  // 不匹配的 claim：不得清 pending
  await app._releaseChannelRecoverClaim(healthPath, 'wxpusher', 'other-token')
  let state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.wxpusher.recoverAlertPending, true, 'claim 不匹配不得动作')
  // 匹配：释放认领（FX3 语义=删 claim、保留 pending 与失败计数，下一轮无需等租约即可重发）
  await app._releaseChannelRecoverClaim(healthPath, 'wxpusher', 'tok-1')
  state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.wxpusher.recoverAlertPending, true, '匹配 claim 释放后 pending 必须保留（下一轮重发）')
  assert.strictEqual(state.wxpusher.recoverAlertClaim, undefined, '匹配 claim 释放后 claim 必须删除（允许重发）')
  assert.strictEqual(state.wxpusher.consecutiveFailures, 3, '释放认领必须保留失败计数（下一轮仍可触发恢复）')
})

checkAsync('恢复认领清零: 通道恢复成功后计数清零、lastRecoveredAt 更新', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp({ fs: mfs })
  const claim = 'tok-9'
  mfs.writeFileSync(healthPath, JSON.stringify({
    wxpusher: { consecutiveFailures: 3, lastFailureAt: 1, lastAlertAt: 2, lastRecoveredAt: 0, recoverAlertPending: true, recoverAlertClaim: claim, recoverAlertClaimAt: Date.now() }
  }))
  await app._clearChannelRecoverPending(healthPath, 'wxpusher', claim)
  const state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.wxpusher.consecutiveFailures, 0, '恢复确认后失败计数必须清零')
  assert.ok(state.wxpusher.lastRecoveredAt > 0, 'lastRecoveredAt 必须更新')
  assert.strictEqual(state.wxpusher.recoverAlertPending, undefined, 'pending 必须清除')
})

// --- _updateChannelHealth 主流程用例（失败计数 / 告警入队 / 恢复认领 / 状态损坏防御）---
// _sendAlert 经 makeHealthApp 无注入——检查其实现依赖 getNotify/Pusher。用 sendAlert 注入参数版本。
function makeHealthApp2 ({ fs, cacheDir = dir, alive = () => false, sendAlert, threshold = 2, intervalMs = 3600000, pusher, writeOk = true, enabled = true }) {
  return createApp({
    Config: { channelHealth: { enabled, consecutiveFailures: threshold, intervalMs } },
    Utils: {
      safeErrorText: (e, d) => String((e && e.message) || d),
      num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
    },
    Formatter: {},
    RuleEngine: {},
    FilterEngine: {},
    MessageStore: { cacheDir, _getTombstoneProcessStart: () => 's', _isTombstoneLockProcessAlive: () => alive() },
    Network: {},
    Pusher: pusher || {},
    fs,
    path: require('path'),
    crypto: require('crypto'),
    readSafeTextResult: (p, maxBytes) => {
      if (!fs.existsSync(p)) return { status: 'missing', text: '' }
      const text = fs.readFileSync(p)
      if (Buffer.byteLength(text) > maxBytes) return { status: 'oversize', text: '' }
      return { status: 'ok', text: String(text) }
    },
    // writeOk（参照 makeLogApp 的 opts.writeOk 先例）：false 模拟 writeAtomic 失败，覆盖 _writeState 短路分支
    writeAtomic: (p, text) => { fs.writeFileSync(p, text); return writeOk },
    isRegularOrMissing: () => true,
    STATE_TEXT_MAX_BYTES: 262144,
    DEFAULT_MAX_SIZE: 1048576,
    RE2C: null,
    RE2_WARN_STATE_FILE: 're2warn.state',
    RE2_MISSING_WARNING: '[re2]',
    summarizeError: (e) => (e && e.message) || 'err',
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

checkAsync('健康更新: 单次失败计 1、未达阈值不入告警', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp2({ fs: mfs, threshold: 3 })
  await app._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'boom' }] })
  const state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.pushdeer.consecutiveFailures, 1, '一次失败必须计 1')
  assert.strictEqual(state.pushdeer.lastFailureAt > 0, true, 'lastFailureAt 必须落盘')
})

checkAsync('健康更新: 连续失败达阈值入告警 + lastAlertAt 即时落盘（APP2-01 限频按尝试计时）', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp2({ fs: mfs, threshold: 2 })
  // 预置已失败 1 次
  mfs.writeFileSync(healthPath, JSON.stringify({ pushdeer: { consecutiveFailures: 1, lastFailureAt: 1, lastAlertAt: 0, lastRecoveredAt: 0 } }))
  await app._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'again' }] })
  const state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.pushdeer.consecutiveFailures, 2, '计数应累到阈值 2')
  assert.ok(state.pushdeer.lastAlertAt > 0, '达到阈值必须即时落盘 lastAlertAt（APP2-01，防告警通道挂掉时限频失效每轮重发）')
})

checkAsync('健康更新: 恢复告警送达确认后清零（APP2-02 闭环：pending/claim/计数全清）', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp2({ fs: mfs, threshold: 2, pusher: { send: async () => {} } })
  mfs.writeFileSync(healthPath, JSON.stringify({ pushdeer: { consecutiveFailures: 2, lastFailureAt: 1, lastAlertAt: 5, lastRecoveredAt: 0, recoverAlertPending: true } }))
  await app._updateChannelHealth({ successfulChannels: ['pushdeer'], failures: [] })
  const state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.pushdeer.consecutiveFailures, 0, '恢复确认送达后失败计数必须清零（APP2-02）')
  assert.ok(state.pushdeer.recoverAlertPending === undefined, '确认送达后 pending 必须清除')
  assert.ok(state.pushdeer.recoverAlertClaim === undefined, '确认送达后 claim 必须清除')
  assert.ok(state.pushdeer.lastRecoveredAt > 0, 'lastRecoveredAt 必须更新')
})

checkAsync('健康更新: 恢复告警发送失败释放认领、保留 pending 与计数（FX3 重发语义）', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp2({ fs: mfs, threshold: 2, pusher: { send: async () => { throw new Error('down') } } })
  mfs.writeFileSync(healthPath, JSON.stringify({ pushdeer: { consecutiveFailures: 2, lastFailureAt: 1, lastAlertAt: 5, lastRecoveredAt: 0, recoverAlertPending: true } }))
  await app._updateChannelHealth({ successfulChannels: ['pushdeer'], failures: [] })
  const state = JSON.parse(mfs.readFileSync(healthPath))
  assert.strictEqual(state.pushdeer.consecutiveFailures, 2, '发送失败时失败计数必须保留（APP2-02 不丢）')
  assert.strictEqual(state.pushdeer.recoverAlertPending, true, '发送失败时 pending 必须保留（下一轮重发）')
  assert.ok(state.pushdeer.recoverAlertClaim === undefined, '发送失败必须释放本次认领（FX3：无需等租约即可重发）')
})

checkAsync('健康更新: 状态文件损坏时跳过本轮以保留原文件', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp2({ fs: mfs })
  mfs.writeFileSync(healthPath, 'not-json{{')
  await app._updateChannelHealth({ successfulChannels: ['x'], failures: [] })
  assert.strictEqual(mfs.readFileSync(healthPath), 'not-json{{', '损坏状态必须原样保留（不得覆盖）')
})

checkAsync('健康更新: 锁被他人持有时跳过本轮且不动状态文件', async () => {
  const mfs = makeMemFs()
  const app = makeHealthApp2({ fs: mfs, alive: () => true })
  mfs.writeFileSync(healthPath + '.lock', '999999:x')
  mfs._touch(healthPath + '.lock', Date.now())
  mfs.writeFileSync(healthPath, JSON.stringify({ pushdeer: { consecutiveFailures: 1, lastFailureAt: 1, lastAlertAt: 0, lastRecoveredAt: 0 } }))
  const before = mfs.readFileSync(healthPath)
  await app._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'x' }] })
  assert.strictEqual(mfs.readFileSync(healthPath), before, '拿不到锁必须整轮跳过（不能覆盖另一轮状态）')
})

checkAsync('通道健康: 状态写入失败时提前返回（不入队告警、释放锁）', async () => {
  const mfs = makeMemFs()
  const sent = []
  const app = makeHealthApp2({ fs: mfs, threshold: 1, pusher: { send: async (t) => { sent.push(t) } }, writeOk: false })
  await app._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'boom' }] })
  assert.strictEqual(sent.length, 0, '状态写入失败必须提前返回，告警不得入队发送')
  assert.strictEqual(mfs._files.has(healthPath + '.lock'), false, '提前返回路径必须释放锁（finally 语义）')
  // 反向对照：writeOk 恢复 true 后同轮可正常入队（证明短路来自写入失败而非阈值/桩配置）
  const app2 = makeHealthApp2({ fs: makeMemFs(), threshold: 1, pusher: { send: async (t) => { sent.push(t) } } })
  await app2._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'boom' }] })
  assert.strictEqual(sent.length, 1, 'writeOk 正常时同配置应入队告警')
})

// 本簇的状态文件路径全部取自**私有 mkdtemp 目录**，不写可预测的 /tmp 文件名
// （Sonar「Make sure publicly writable directories are used safely here」/ CWE-377：公共可写目录里的
// 固定名可被他人抢占/预建；本仓 6369482 已把记账文件统一改成 mkdtemp 私有目录，此处照同一口径）。
// 注意：下面 AP-1…AP-3 用的是**注入的假 fs**，这些路径只是字符串、不落真磁盘，但命名口径仍按真实环境执行。
//
// C5-025：本文件的临时夹具一律走 `xbkunit-` 前缀 + 进程退出兜底清理，不再用 `xbk-`。
// 为什么：scripts/check-host-clean.js 把 <tmp>/xbk-* 当作「套件/变异沙箱」，残留超过 30min 就判
// 主机脏并给出 rm -rf 建议（实测 inspect()：61min 的 xbk-app-unit-* → ok=false、dirs 点名）。本文件
// 的夹具不是那种沙箱，被 SIGKILL 后残留会被下一轮 `npm run check` 误拦。改名后该门禁不再替我们清场，
// 所以用 exit 钩子自己清（与 AP_ROOT 原有兜底同口径）——两条都不丢。
const TMP_FIXTURES = []
function mkTmpFixture (tag) {
  const realFs = require('fs')
  const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'xbkunit-' + tag))
  TMP_FIXTURES.push(d)
  return d
}
process.once('exit', () => {
  const realFs = require('fs')
  for (const d of TMP_FIXTURES) {
    try { realFs.rmSync(d, { recursive: true, force: true }) } catch (e) { /* 退出路径忽略清理失败 */ }
  }
})
const AP_ROOT = (() => {
  const realFs = require('fs')
  const d = mkTmpFixture('app-unit-')
  try { realFs.chmodSync(d, 0o700) } catch (e) { /* 某些 FUSE 挂载不允许 chmod：目录名仍不可预测 */ } // nosemgrep（d 是 mkdtempSync 独占产物，无外部输入）
  return d
})()
// 唯一的动态来源是 mkdtemp 私有目录 + 本文件内硬编码的文件名常量，不接受任何外部输入
// ⇒ Codacy 的 pathtraversal-non-literal-fs-filename 在此是结构性误报（口径同 xbk_storage.js:17 与 .codacy.yml 里 test_storage.js 的说明）
const apPath = (name) => path.join(AP_ROOT, name) // nosemgrep

// C5-025 守卫：本文件的临时夹具（哪怕 61 分钟没动）不得被 check-host-clean 当成过期沙箱。
// 反例：夹具用 xbk- 前缀时，findStaleSandboxes 会把 61min 的目录点名成「过期沙箱」并判主机脏——
// 一次 SIGKILL 残留就能让下一轮 `npm run check` 以「主机脏」拒跑（本机已端到端复现）。
check('C5-025 夹具命名：本文件的临时目录不落进 check-host-clean 的沙箱命名空间', () => {
  const realFs = require('fs')
  const { findStaleSandboxes, activityMtimeMs } = require('./scripts/check-host-clean')
  // ① 行为侧：真建一个夹具、把 mtime 拨到 61 分钟前，门禁的判据不得把它当残留
  const d = mkTmpFixture('namespace-probe-')
  try {
    const past = new Date(Date.now() - 61 * 60000)
    realFs.utimesSync(d, past, past)
    assert.deepStrictEqual(
      findStaleSandboxes([{ p: d, mtimeMs: activityMtimeMs(d) }], Date.now(), 30 * 60000), [],
      `夹具目录 ${d} 落进了 check-host-clean 的沙箱命名空间：残留 >30min 会被判主机脏并误拦 check`)
  } finally {
    realFs.rmSync(d, { recursive: true, force: true })
  }
  // ② 源码侧：不允许再有绕过 mkTmpFixture 的裸 xbk- mkdtemp（注释里的示例不会命中，需带 mkdtempSync(）
  const raw = realFs.readFileSync(__filename, 'utf8').match(/mkdtempSync\(path\.join\(os\.tmpdir\(\), 'xbk-/g) || []
  assert.strictEqual(raw.length, 0, `本文件不得再有裸 xbk- 前缀的 mkdtempSync（应走 mkTmpFixture）：实际 ${raw.length} 处`)
})

// ===== G11-AP：RE2 标记原子写 / PID 复用识别 / 通道健康降级（c8 实测 xbk_app.js 分支 86.06%，
// L341-350 与 L524-530 与 L843-845 与 L917-918 均未达）=====
// 这四条全是「跨平台与故障降级」分支：Linux 上 rename 天然覆盖，Windows 的 EPERM 重试永不执行；
// PID 复用、状态读取非 ok/missing、健康更新整体抛错在正常环境也走不到。它们一旦写坏（例如重试退化成
// 直接写目标），本机全绿、生产的半写状态文件被后续判为损坏 → 当天 re2 提醒被永久压制。
check('AP-1 _writeRe2WarnMarkerAtomic：Windows rename 失败必须先删目标再重试 rename（不得退化为直接写目标）', () => {
  const files = new Map()
  const seq = []
  let renameFails = 1 // 第一次 rename 模拟 Windows「目标已存在」失败
  const fakels = {
    writeFileSync: (p, text, opts) => {
      seq.push('write')
      if (opts && opts.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
      files.set(String(p), String(text))
    },
    renameSync: (a, b) => {
      seq.push('rename')
      if (renameFails > 0) {
        renameFails -= 1
        const e = new Error('EPERM: operation not permitted, rename')
        e.code = 'EPERM'
        throw e
      }
      if (!files.has(String(a))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      files.set(String(b), files.get(String(a)))
      files.delete(String(a))
    },
    unlinkSync: (p) => {
      seq.push('unlink:' + (String(p).endsWith('.tmp') ? 'tmp' : 'target'))
      if (!files.has(String(p))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      files.delete(String(p))
    }
  }
  const a = makeApp({ fs: fakels })
  const statePath = apPath('re2-marker.state')
  files.set(statePath, '旧标记') // 目标已存在 ⇒ Windows 上 rename 必失败
  assert.strictEqual(a._writeRe2WarnMarkerAtomic(statePath, '新标记'), true, '重试成功后必须返回 true')
  assert.strictEqual(files.get(statePath), '新标记', '目标内容必须是本次写入的')
  assert.deepStrictEqual(seq, ['write', 'rename', 'unlink:target', 'rename'],
    `顺序必须是 tmp 独占创建 → rename 失败 → 删目标 → 重试 rename（实际 ${JSON.stringify(seq)}）`)
  assert.ok(![...files.keys()].some(k => k.endsWith('.tmp')), '不得残留 .tmp')
})

check('AP-2 _writeRe2WarnMarkerAtomic：目标删除失败必须被吞掉后仍重试；两次 rename 都失败 ⇒ 清 tmp 返回 false 且不抛穿', () => {
  // 分支①：unlink 抛 ENOENT（目标恰好已被别人删）⇒ 忽略后重试 rename 应成功
  const files = new Map([[apPath('ap2.state'), '旧']])
  let renameFails = 1
  const fsA = {
    writeFileSync: (p, text, opts) => {
      if (opts && opts.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
      files.set(String(p), String(text))
    },
    renameSync: (a, b) => {
      if (renameFails > 0) { renameFails -= 1; const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
      files.set(String(b), files.get(String(a)))
      files.delete(String(a))
    },
    unlinkSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
  }
  const aA = makeApp({ fs: fsA })
  assert.strictEqual(aA._writeRe2WarnMarkerAtomic(apPath('ap2.state'), 'x'), true,
    '目标已被他人删除时 unlink 抛 ENOENT 必须被吞掉，重试 rename 仍应成功')
  // 分支②：两次 rename 都失败 ⇒ 外层 catch 尽力清 tmp、返回 false，且 unlink 自身抛错不得外泄
  const unlinkTargets = []
  let threwOutward = null
  const fsB = {
    writeFileSync: (p, text) => { files.set(String(p), String(text)) },
    renameSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e },
    unlinkSync: (p) => { unlinkTargets.push(String(p)); const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
  }
  const aB = makeApp({ fs: fsB })
  try {
    assert.strictEqual(aB._writeRe2WarnMarkerAtomic(apPath('ap2-fail.state'), 'x'), false, '重试仍失败必须返回 false')
  } catch (e) { threwOutward = e }
  assert.strictEqual(threwOutward, null,
    `清理链上的抛错绝不能外泄（调用方在提醒主链上）：${threwOutward && threwOutward.message}`)
  assert.strictEqual(unlinkTargets.length, 2,
    `两次 rename 都失败时必须先试删目标、再清 .tmp（实际 ${JSON.stringify(unlinkTargets)}）`)
  assert.ok(unlinkTargets[1].endsWith('.tmp'), `最后一次清理必须针对本次的 .tmp：${JSON.stringify(unlinkTargets)}`)
  assert.ok(files.has(apPath('ap2-fail.state')) === false, '目标文件绝不得被直接写入（半写状态会让当天提醒被永久压制）')
})

for (const c of [
  { start: '111', actualStart: '222', kill: 'ok', expect: true, why: '同 PID 不同启动时钟 ⇒ PID 已被复用，必须判残留' },
  { start: '111', actualStart: '111', kill: 'ok', expect: false, why: '时钟一致 ⇒ 同一进程，绝不得回收（否则当天重复提醒）' },
  { start: '111', actualStart: null, kill: 'ok', expect: false, why: '读不到进程启动时钟 ⇒ 证据不足，保守保留' },
  { start: 'abc', actualStart: '222', kill: 'ok', expect: false, why: 'start 非纯数字 ⇒ 不做 incarnation 判定' },
  { start: undefined, actualStart: '222', kill: 'ok', expect: false, why: '缺 start 字段 ⇒ 保守保留' },
  { start: '111', actualStart: '222', kill: 'ESRCH', expect: true, why: '进程不存在 ⇒ pending 即崩溃残留' },
  { start: '111', actualStart: '111', kill: 'EPERM', expect: false, why: 'EPERM=存在但无权限 ⇒ 仍按存活处理' }
]) {
  check(`AP-3 _isRe2WarnMarkerStale（start=${String(c.start)} / 实测时钟=${String(c.actualStart)} / kill=${c.kill}）：${c.why}`, () => {
    const marker = JSON.stringify({ warnedAt: 1, status: 'pending', pid: process.pid, start: c.start })
    const a = makeApp({
      fs: { readFileSync: () => marker },
      MessageStore: { _getTombstoneProcessStart: () => c.actualStart }
    })
    const origKill = process.kill
    process.kill = c.kill === 'ok'
      ? origKill
      : () => { const e = new Error('kill'); e.code = c.kill; throw e }
    try {
      assert.strictEqual(a._isRe2WarnMarkerStale(apPath('ap3.state')), c.expect)
    } finally {
      process.kill = origKill
    }
  })
}

checkAsync('AP-4 通道健康：状态读取非 ok/missing（超限）⇒ 跳过本轮并留诊断，绝不当作「无历史」重置', async () => {
  const mfs = makeMemFs()
  mfs.writeFileSync(healthPath, 'x'.repeat(300000)) // 超 STATE_TEXT_MAX_BYTES(262144) ⇒ oversize
  const before = mfs.readFileSync(healthPath)
  const sent = []
  const a = makeHealthApp2({ fs: mfs, threshold: 1, pusher: { send: async (t) => { sent.push(t) } } })
  const errs = []
  const origErr = console.error
  console.error = (...x) => errs.push(x.map(String).join(' '))
  try {
    await a._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'boom' }] })
  } finally {
    console.error = origErr
  }
  assert.ok(errs.some(l => l.includes('通道健康状态读取失败') && l.includes('跳过本轮健康更新')),
    `必须点名读取失败与「跳过本轮」：${JSON.stringify(errs)}`)
  assert.ok(errs.some(l => l.includes('(oversize)')), '诊断必须带真实状态码，便于区分超限/损坏/IO')
  assert.strictEqual(sent.length, 0, '状态读不到时不得入队告警（阈值失去依据，误报比沉默更糟）')
  assert.strictEqual(mfs.readFileSync(healthPath), before, '读失败时绝不得覆写状态文件（否则连续失败计数被清零）')
})

checkAsync('AP-5 通道健康：更新过程整体抛错 ⇒ 补一行 WARN 留痕且仍释放锁（“仅作观测”不等于隐身）', async () => {
  const mfs = makeMemFs()
  const a = makeHealthApp2({ fs: mfs, threshold: 1, pusher: { send: async () => {} } })
  const logged = []
  a._writeRunLog = (line) => { logged.push(line); return true }
  a._readSafeState = () => { throw new Error('state read boom') }
  await a._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'pushdeer', message: 'boom' }] })
  assert.ok(logged.some(l => l.includes('WARN 通道健康更新异常')),
    `异常必须留一行 WARN（旧实现完全静默，通道健康可能永久不更新而无人知）：${JSON.stringify(logged)}`)
  assert.ok(logged.some(l => l.includes('state read boom')), '留痕必须带上根因文本')
  assert.strictEqual(mfs._files.has(healthPath + '.lock'), false, '异常路径也必须释放健康更新锁（finally 语义）')
})

// ============================================================
// 过滤规则覆盖文件（xbk_filter_store）→ App.run 生效 / 损坏降级回归
//
// 与上方纯方法用例不同，这一段**真调 App.run**（同一进程连续多轮）：
//   · 依赖装配走与生产同一批工厂（createUtils/Formatter/RuleEngine/FilterEngine/MessageStore），
//     只有 Network.fetchData 与 Pusher.send 是桩——不触网、不推送；
//   · cacheDir 是 os.tmpdir() 下的临时目录（Config 副本与 XBK_CACHE_DIR 同指向：MessageStore
//     的 getter 只接受根内 cache.dir，临时目录必须走部署开关才真正生效），断言后递归删除；
//   · 覆盖文件按轮改写，证明「保存后下一轮生效」，且代码默认层 Config.filter 全程不被污染。
// ============================================================
function buildFilterRunHarness (cacheDir, over = {}) {
  const realFs = require('fs')
  const nodeCrypto = require('crypto')
  const {
    createUtils, FILTER_FIELDS, DEFAULT_MAX_SIZE, STATE_TEXT_MAX_BYTES, MESSAGE_CACHE_MAX_BYTES,
    TOMBSTONE_MAX_KEYS, TOMBSTONE_MAX_BYTES, TOMBSTONE_LOCK_STALE_MS, normalize, trimTrailingSlashes
  } = require('./xbk_utils')
  const { createFormatter } = require('./xbk_formatter')
  const { createRuleEngine } = require('./xbk_rules')
  const { createFilterEngine } = require('./xbk_filter')
  const { createMessageStore } = require('./xbk_message_store')
  const { readSafeTextResult, writeAtomic, writeAtomicIfAbsent, isRegularOrMissing } = require('./xbk_storage')
  const { summarizeError } = require('./xbk_failure_policy')
  const FilterStore = require('./xbk_filter_store')
  const baseConfig = require('./xbk_function_v3').Config
  // 代码默认层只读：这里深拷贝一份给被测 App，生产 Config 全程不被修改（下方有深比较断言）。
  const Config = JSON.parse(JSON.stringify(baseConfig))
  Config.cache.dir = cacheDir
  Config.domain = 'https://example.invalid'
  Config.api.pushUrl = 'https://example.invalid/plus/json/push.json'
  Config.api.retry = 0
  Config.alert = { enabled: false, intervalMs: 0 }
  Config.report = { enabled: false }
  Config.channelHealth = { enabled: false }
  Config.diagnostics = { filterLog: { enabled: false, maxDetailsPerRun: 100, includePassed: false } }
  Config.push.mode = 'sequential'
  Config.timing.pushInterval = 0
  Config.timing.finalWait = 0

  // 与生产同口径：RE2 优先（用户正则缺 RE2 时一律跳过，测试不应掩盖这一点）
  let RE2C = null
  try { RE2C = require('re2') } catch (e) { RE2C = null }
  const reCache = new Map()
  const safeRe = (src, flags) => {
    const key = src + '\u0000' + flags
    const cached = reCache.get(key)
    if (cached) return cached
    const re = RE2C ? new RE2C(src, flags) : new RegExp(src, flags)
    reCache.set(key, re)
    return re
  }
  const compileUserRegex = (source, flags = 'i') => {
    if (typeof source !== 'string' || !RE2C) return null
    try { return new RE2C(source, flags) } catch (e) { return null }
  }

  const Utils = createUtils({ fs: realFs, safeRe })
  const Formatter = createFormatter({ Utils, safeRe })
  const RuleEngine = createRuleEngine({ Utils, FILTER_FIELDS, compileUserRegex, isRe2Available: () => Boolean(RE2C) })
  const FilterEngine = createFilterEngine({ Utils, RuleEngine, FILTER_FIELDS, compileUserRegex })
  const MessageStore = createMessageStore({
    Config,
    Utils,
    fs: realFs,
    path,
    crypto: nodeCrypto,
    normalize,
    storage: { readSafeTextResult, writeAtomic, writeAtomicIfAbsent, isRegularOrMissing },
    constants: {
      DEFAULT_MAX_SIZE,
      MESSAGE_CACHE_MAX_BYTES,
      TOMBSTONE_MAX_KEYS,
      TOMBSTONE_MAX_BYTES,
      TOMBSTONE_LOCK_STALE_MS
    }
  })
  let items = []
  const sends = []
  const Network = { fetchData: async () => items }
  const Pusher = over.Pusher || {
    send: async (text, desp) => {
      sends.push({ text, desp })
      return { successfulChannels: ['stub'], failures: [] }
    }
  }
  const App = createApp({
    Config,
    Utils,
    Formatter,
    RuleEngine,
    FilterEngine,
    MessageStore,
    FilterStore,
    Network,
    Pusher,
    fs: realFs,
    path,
    crypto: nodeCrypto,
    readSafeTextResult,
    writeAtomic,
    isRegularOrMissing,
    STATE_TEXT_MAX_BYTES,
    DEFAULT_MAX_SIZE,
    RE2C,
    RE2_WARN_STATE_FILE: 're2warn.state',
    RE2_MISSING_WARNING: 'missing re2',
    summarizeError,
    PROFILE3: false,
    PROFILE3_BOOT_MARKS: [],
    prewarmDns: () => ({ ok: true, skipped: true }),
    prewarmTls: () => ({ ok: true, skipped: true, okCount: 0, count: 0 }),
    getNotify: () => Promise.resolve(null),
    PKG_VERSION: '0.0.0-test',
    trimTrailingSlashes,
    compileUserRegex
  })
  return {
    App,
    Config,
    MessageStore,
    FilterStore,
    Pusher,
    sends,
    baseConfig,
    setItems (next) { items = next },
    cacheName () { return MessageStore.getFileName(Config.api.pushUrl) },
    cacheMessages () { return MessageStore.readMessages(MessageStore.getFilePath(MessageStore.getFileName(Config.api.pushUrl))) }
  }
}

function makeRunItem (id, title) {
  return { id, title, catename: '测试分类', content: '', shijianchuo: 1760000000 }
}

async function runWithWarnings (app) {
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
  try {
    const summary = await app.run()
    return { summary, warns }
  } finally {
    console.warn = origWarn
  }
}

checkAsync('FR-1 覆盖文件按轮生效：同一进程两次 App.run 读到不同规则，applied 快照与第二轮一致，Config.filter 不被污染', async () => {
  const realFs = require('fs')
  const FilterStore = require('./xbk_filter_store')
  FilterStore.resetStoreStateForTests()
  const cacheDir = mkTmpFixture('filter-run-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  const rulesFile = FilterStore.filterRulesPaths(cacheDir).file
  const defaultsBefore = JSON.parse(JSON.stringify(h.baseConfig.filter))
  const keywordBefore = JSON.parse(JSON.stringify(h.baseConfig.keyword))
  const writeRules = (revision, filter) => realFs.writeFileSync(rulesFile, JSON.stringify({ schema: 1, revision, filter }), { mode: 0o600 })
  try {
    // 第一轮：屏蔽标题含「屏蔽词」的 1 条
    writeRules(1, { pingbibiaoti: '屏蔽词', pingbitime: '' })
    h.setItems([makeRunItem('fr1-a', '屏蔽词甲'), makeRunItem('fr1-b', '正常乙')])
    const round1 = await runWithWarnings(h.App)
    assert.deepStrictEqual(
      { total: round1.summary.total, dedup: round1.summary.dedup, filtered: round1.summary.filtered, pushed: round1.summary.pushed },
      { total: 2, dedup: 0, filtered: 1, pushed: 1 },
      `第一轮应只屏蔽 1 条并推送 1 条：${JSON.stringify(round1.summary)}`)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.Config.filter)), defaultsBefore,
      'App.run 不得原地修改注入的 Config.filter（覆盖文件只影响局部 active）')

    // 第二轮：换成另一条规则（revision 2），验证「下一轮生效」，而不是本轮热替换
    writeRules(2, { pingbibiaoti: '另一屏蔽', pingbitime: '' })
    h.setItems([makeRunItem('fr2-a', '另一屏蔽丙'), makeRunItem('fr2-b', '正常丁')])
    const round2 = await runWithWarnings(h.App)
    assert.deepStrictEqual(
      { total: round2.summary.total, dedup: round2.summary.dedup, filtered: round2.summary.filtered, pushed: round2.summary.pushed },
      { total: 2, dedup: 0, filtered: 1, pushed: 1 },
      `第二轮必须用 revision 2 的新规则（旧规则会 0 屏蔽、默认规则也会 0 屏蔽）：${JSON.stringify(round2.summary)}`)

    // 生效快照：revision=2、filter 与第二轮实际生效规则逐字段一致
    const applied = FilterStore.readAppliedSnapshot(cacheDir)
    assert.strictEqual(applied.status, 'ok', `applied 快照应可读：${JSON.stringify(applied)}`)
    const expectedFilter = Object.assign({}, defaultsBefore, { pingbibiaoti: '另一屏蔽', pingbitime: '' })
    assert.strictEqual(applied.snapshot.revision, 2, 'applied 快照必须记录第二轮 revision')
    assert.strictEqual(applied.snapshot.source, 'override', 'applied 快照 source 应为 override')
    assert.deepStrictEqual(applied.snapshot.filter, expectedFilter, 'applied 快照 filter 必须等于第二轮生效规则')
    assert.deepStrictEqual(applied.snapshot.keyword, { zkt_gjc: '' }, 'applied 快照必须带只读 keyword')
    assert.ok(typeof applied.snapshot.hash === 'string' && applied.snapshot.hash.length > 0, 'applied 快照必须记录生效哈希')

    // 代码默认层（生产 Config）与注入副本都必须保持原值
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.baseConfig.filter)), defaultsBefore,
      '两轮之后代码默认层 Config.filter 必须逐字段不变（测试/运行都不得把它当持久化）')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.baseConfig.keyword)), keywordBefore,
      '两轮之后代码默认层 Config.keyword 必须不变')
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

checkAsync('FR-2 覆盖文件损坏：沿用进程内 last-known-good，保留 _f 与 filter.hash，告警含 source/lastGoodUsed', async () => {
  const realFs = require('fs')
  const FilterStore = require('./xbk_filter_store')
  FilterStore.resetStoreStateForTests()
  const cacheDir = mkTmpFixture('filter-run-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  const rulesFile = FilterStore.filterRulesPaths(cacheDir).file
  const hashPath = path.join(cacheDir, 'filter.hash')
  const cacheFIds = () => h.cacheMessages().filter(m => m && m._f === true).map(m => m.id).sort()
  try {
    // 先合法加载一次，建立 last-known-good，并让缓存里出现 _f 记录
    realFs.writeFileSync(rulesFile, JSON.stringify({ schema: 1, revision: 2, filter: { pingbibiaoti: '另一屏蔽', pingbitime: '' } }), { mode: 0o600 })
    h.setItems([makeRunItem('fr2-a', '另一屏蔽丙'), makeRunItem('fr2-b', '正常丁')])
    const warm = await runWithWarnings(h.App)
    assert.strictEqual(warm.summary.filtered, 1, '预热轮必须先写出 1 条 _f 记录')
    const hashBefore = realFs.readFileSync(hashPath, 'utf8')
    assert.deepStrictEqual(cacheFIds(), ['fr2-a'], `预热轮后缓存应含 _f 记录：${JSON.stringify(cacheFIds())}`)

    // 损坏覆盖文件：JSON 都解析不了
    realFs.writeFileSync(rulesFile, '{ 这不是 JSON', { mode: 0o600 })
    h.setItems([makeRunItem('fr3-a', '另一屏蔽戊'), makeRunItem('fr3-b', '正常己')])
    const round3 = await runWithWarnings(h.App)
    assert.deepStrictEqual(
      { filtered: round3.summary.filtered, pushed: round3.summary.pushed },
      { filtered: 1, pushed: 1 },
      `损坏时必须继续用 last-known-good 过滤（不得置空/跳过过滤）：${JSON.stringify(round3.summary)}`)
    assert.ok(round3.warns.some(l => l.includes('过滤规则覆盖文件损坏') && l.includes('source=corrupt') && l.includes('lastGoodUsed=true')),
      `console.warn 必须含 source=corrupt 与 lastGoodUsed=true：${JSON.stringify(round3.warns)}`)
    assert.strictEqual(realFs.readFileSync(hashPath, 'utf8'), hashBefore,
      '损坏降级不得推进 filter.hash（否则下一轮规则变更检测被跳过，_f 永久失效）')
    assert.ok(cacheFIds().includes('fr2-a'),
      `损坏降级不得清 _f：上一轮被过滤的 fr2-a 必须仍在缓存中（实际 ${JSON.stringify(cacheFIds())}）`)
    const runLog = realFs.readFileSync(path.join(cacheDir, 'run.log'), 'utf8')
    assert.ok(/WARN 过滤规则覆盖文件损坏/.test(runLog) && /lastGoodUsed=true/.test(runLog),
      `run.log 必须留 WARN 行并带 lastGoodUsed：${runLog.slice(-400)}`)
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

checkAsync('FR-3 首次加载即损坏（无 last-known-good）：回代码默认、告警 lastGoodUsed=false，仍不清 _f/不推进 hash', async () => {
  const realFs = require('fs')
  const FilterStore = require('./xbk_filter_store')
  FilterStore.resetStoreStateForTests() // 关键：清掉进程内 last-known-good，模拟「本进程从未读到合法文件」
  const cacheDir = mkTmpFixture('filter-run-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  const rulesFile = FilterStore.filterRulesPaths(cacheDir).file
  const hashPath = path.join(cacheDir, 'filter.hash')
  const cacheFIds = () => h.cacheMessages().filter(m => m && m._f === true).map(m => m.id).sort()
  const defaultsFilter = JSON.parse(JSON.stringify(h.baseConfig.filter))
  try {
    // 先合法跑一轮：留下 _f 记录与 filter.hash，作为「损坏后不得清理」的基线
    realFs.writeFileSync(rulesFile, JSON.stringify({ schema: 1, revision: 2, filter: { pingbibiaoti: '另一屏蔽', pingbitime: '' } }), { mode: 0o600 })
    h.setItems([makeRunItem('fr2-a', '另一屏蔽丙'), makeRunItem('fr2-b', '正常丁')])
    await runWithWarnings(h.App)
    const hashBefore = realFs.readFileSync(hashPath, 'utf8')
    const fBefore = cacheFIds()
    assert.deepStrictEqual(fBefore, ['fr2-a'], `基线应含 1 条 _f 记录：${JSON.stringify(fBefore)}`)

    // 清 last-known-good 后再损坏：只能回代码默认（pingbitime='5' 因接口无注册时间字段而跳过 → 0 屏蔽）
    FilterStore.resetStoreStateForTests()
    realFs.writeFileSync(rulesFile, '{ 仍然不是 JSON', { mode: 0o600 })
    h.setItems([makeRunItem('fr4-a', '另一屏蔽庚'), makeRunItem('fr4-b', '正常辛')])
    const round4 = await runWithWarnings(h.App)
    assert.deepStrictEqual(
      { filtered: round4.summary.filtered, pushed: round4.summary.pushed },
      { filtered: 0, pushed: 2 },
      `首次损坏应回代码默认（默认 pingbibiaoti 为空 ⇒ 不过滤）：${JSON.stringify(round4.summary)}`)
    assert.ok(round4.warns.some(l => l.includes('过滤规则覆盖文件损坏') && l.includes('source=corrupt') && l.includes('lastGoodUsed=false')),
      `首次损坏必须告警 lastGoodUsed=false：${JSON.stringify(round4.warns)}`)
    assert.strictEqual(realFs.readFileSync(hashPath, 'utf8'), hashBefore,
      '首次损坏同样不得推进 filter.hash')
    assert.deepStrictEqual(cacheFIds(), fBefore,
      `首次损坏同样不得清 _f（实际 ${JSON.stringify(cacheFIds())} vs 基线 ${JSON.stringify(fBefore)}）`)
    const applied = FilterStore.readAppliedSnapshot(cacheDir)
    assert.strictEqual(applied.status, 'ok', `applied 快照应可读：${JSON.stringify(applied)}`)
    assert.strictEqual(applied.snapshot.revision, 0, '首次损坏的 applied 快照 revision 应为 0')
    assert.strictEqual(applied.snapshot.source, 'corrupt', '首次损坏的 applied 快照 source 应为 corrupt')
    assert.deepStrictEqual(applied.snapshot.filter, defaultsFilter, '首次损坏的 applied 快照应记录代码默认规则')
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

// ============================================================
// 运行级回归（App.run 主链）：dry-run / 截断 / 告警分流 / 全脏数据可观测
//
// 为什么放在本文件（C1-001 / C1-003 的根因）：xbk_app.js 的 run() 主链此前只有
// test_app.js（集成套件）覆盖，而 test_app.js 不进变异集（test_suite_registry.js 白名单 +
// integration 过滤 ⇒ run_unit_tests.js / TAP 都不跑它）⇒ dry-run 判据、truncatedKeys 合取项
// 这些「只在 run() 里生效」的分支在变异集内零执行、零断言，改坏也无人红。
// 本段复用 buildFilterRunHarness 的真实装配（真 createApp + 真 MessageStore + 临时 cacheDir），
// 只桩 Network.fetchData / Pusher.send ⇒ 落在单元入口 ⇒ 进 TAP 变异集。
// ============================================================

checkAsync('DR-1 dry-run：预览短路不调 Pusher、toCache 为空、跳过日报（前后两个对照轮证明断言有判别力）', async () => {
  const realFs = require('fs')
  const cacheDir = mkTmpFixture('dryrun-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  // 日报必须真的「可写」——report 关着时「dry-run 不写日报」恒真、无判别力
  h.Config.report = { enabled: true }
  const reportPath = path.join(cacheDir, 'report.state')
  const urlControl = 'https://example.invalid/dry-run-control.json'
  const urlDry = 'https://example.invalid/dry-run-preview.json'
  const cacheFileOf = (url) => path.join(cacheDir, h.MessageStore.getFileName(url))
  try {
    // ① 对照轮（非 dry-run）：必须真推送 + 写缓存 + 写日报
    h.Config.api.pushUrl = urlControl
    h.setItems([makeRunItem('dr-ctl-1', '对照甲')])
    const ctl = await runWithWarnings(h.App)
    assert.deepStrictEqual({ pushed: ctl.summary.pushed, failed: ctl.summary.failed }, { pushed: 1, failed: 0 },
      `对照轮摘要异常：${JSON.stringify(ctl.summary)}`)
    assert.strictEqual(h.sends.length, 1, '对照轮必须真调用 Pusher.send（否则「dry-run 不推送」恒真）')
    assert.strictEqual(h.cacheMessages().length, 1, '对照轮必须把成功条目写入缓存')
    assert.ok(realFs.existsSync(reportPath), '对照轮必须写日报状态（否则「dry-run 不写日报」恒真）')

    // ② dry-run：同一夹具、只多一个 XBK_DRY_RUN=1，换 URL 隔离缓存
    realFs.rmSync(reportPath, { force: true })
    const sentBefore = h.sends.length
    h.Config.api.pushUrl = urlDry
    h.setItems([makeRunItem('dr-1', '预览甲'), makeRunItem('dr-2', '预览乙')])
    process.env.XBK_DRY_RUN = '1'
    const logs = []
    const origLog = console.log
    const origWarn = console.warn
    let dry
    try {
      console.log = (...a) => { logs.push(a.map(String).join(' ')) }
      console.warn = () => {}
      dry = await h.App.run()
    } finally {
      console.log = origLog
      console.warn = origWarn
    }
    assert.deepStrictEqual({ total: dry.total, pushed: dry.pushed, failed: dry.failed },
      { total: 2, pushed: 0, failed: 0 }, `dry-run 摘要不得伪造推送/失败：${JSON.stringify(dry)}`)
    assert.strictEqual(h.sends.length, sentBefore,
      'dry-run 不得调用 Pusher.send（preview() 必须在 Pusher.send 之前返回 true）')
    // saveBatch([]) 允许创建空缓存文件（契约未禁止）；断言的是「没有任何条目被写进缓存」
    const cachedInDryRun = realFs.existsSync(cacheFileOf(urlDry)) ? h.cacheMessages().length : 0
    assert.strictEqual(cachedInDryRun, 0,
      'dry-run 的 toCache 必须是空数组（写进缓存 = 下轮判重跳过，等于静默丢消息）')
    assert.ok(!realFs.existsSync(reportPath), 'dry-run 必须整段跳过 _updateReport（不得写日报状态）')
    assert.ok(logs.some(l => l.includes('🧪 预览：')), `dry-run 必须逐条打印预览内容：${JSON.stringify(logs.slice(-8))}`)
    assert.ok(logs.some(l => l.includes('预览甲')), '预览内容必须含待推送条目的正文/标题')

    // ③ 再对照：同一 URL 去掉 dry-run ⇒ 必须推送 2 条、写缓存 2 条、写日报
    delete process.env.XBK_DRY_RUN
    h.setItems([makeRunItem('dr-1', '预览甲'), makeRunItem('dr-2', '预览乙')])
    const after = await runWithWarnings(h.App)
    assert.strictEqual(after.summary.pushed, 2, `去掉 dry-run 后必须真推 2 条：${JSON.stringify(after.summary)}`)
    assert.strictEqual(h.cacheMessages().length, 2,
      '同一 URL 去掉 dry-run 后必须写缓存（证明 ② 的零来自 dryRun 判据，不是夹具不工作）')
    assert.ok(realFs.existsSync(reportPath), '同一 URL 去掉 dry-run 后必须写日报（同上）')

    // ④ dry-run + 1 条被规则拦下的条目：独立子段，专门钉「dry-run 一条都不写缓存」
    //    ② 的条目全部通过过滤 ⇒ newMessages 与 items 同集、pushedKeys 恒空 ⇒ 即使去掉
    //    xbk_app.js:1719 的 `dryRun ? [] : …` 短路，toCache 依然是空（断言无判别力）。
    //    被规则过滤的条目不同：它进 newMessages（:1401）却不进 items/itemsKeys/truncatedKeys，
    //    短路一旦消失就会被写进缓存 ⇒ 下轮判重跳过 ⇒ 被过滤条目永久漏推。
    //    这里换独立 pushUrl（独立缓存文件），不动 ①②③ 的任何断言。
    const urlDryFiltered = 'https://example.invalid/dry-run-filtered.json'
    const rulesFile = h.FilterStore.filterRulesPaths(cacheDir).file
    realFs.writeFileSync(rulesFile,
      JSON.stringify({ schema: 1, revision: 1, filter: { pingbibiaoti: '预览乙', pingbitime: '' } }), { mode: 0o600 })
    realFs.rmSync(reportPath, { force: true }) // ③ 已写过日报：先清掉，「dry-run 不写日报」才有判别力
    h.Config.api.pushUrl = urlDryFiltered
    h.setItems([makeRunItem('pb-1', '预览乙：被规则拦下的条目'), makeRunItem('pb-2', '预览丙：正常条目')])
    process.env.XBK_DRY_RUN = '1'
    const sentBeforeFiltered = h.sends.length
    let dryFiltered
    try {
      console.log = (...a) => { logs.push(a.map(String).join(' ')) }
      console.warn = () => {}
      dryFiltered = await h.App.run()
    } finally {
      console.log = origLog
      console.warn = origWarn
    }
    assert.deepStrictEqual(
      { total: dryFiltered.total, filtered: dryFiltered.filtered, pushed: dryFiltered.pushed, failed: dryFiltered.failed },
      { total: 2, filtered: 1, pushed: 0, failed: 0 },
      `dry-run（含 1 条被过滤条目）摘要异常：${JSON.stringify(dryFiltered)}`)
    assert.strictEqual(h.sends.length, sentBeforeFiltered,
      'dry-run 不得调用 Pusher.send（这一轮同样含待推送条目）')
    const cacheMsgsFiltered = realFs.existsSync(cacheFileOf(urlDryFiltered)) ? h.cacheMessages() : []
    assert.strictEqual(cacheMsgsFiltered.length, 0,
      `dry-run 不得把任何条目写进缓存——包括只进 newMessages、不进 items 的被过滤条目（实际写入：${JSON.stringify(cacheMsgsFiltered.map(m => m && m.id))}）`)
    assert.ok(!realFs.existsSync(reportPath), 'dry-run 这一轮同样不得写日报状态（_updateReport 整段跳过）')
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

checkAsync('TR-1 maxPerRun 截断：被截断条目不得写入缓存（下轮补推不丢不重），摘要 truncated 如实计数', async () => {
  const realFs = require('fs')
  const cacheDir = mkTmpFixture('trunc-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  const fiveItems = () => [1, 2, 3, 4, 5].map(i => makeRunItem('tr-' + i, '截断' + i))
  try {
    // 第一轮：上限 2、来 5 条 ⇒ 只推前 2 条，后 3 条既不推也不缓存
    h.Config.push.maxPerRun = 2
    h.setItems(fiveItems())
    const r1 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ total: r1.summary.total, pushed: r1.summary.pushed, truncated: r1.summary.truncated },
      { total: 5, pushed: 2, truncated: 3 }, `第一轮摘要异常：${JSON.stringify(r1.summary)}`)
    assert.ok(r1.warns.some(l => l.includes('超过上限')), `截断必须有 console.warn 提示：${JSON.stringify(r1.warns)}`)
    assert.deepStrictEqual(h.cacheMessages().map(m => m.id).sort(), ['tr-1', 'tr-2'],
      '只有真正推送成功的 2 条可入缓存；被截断的 3 条写入缓存 = 下轮判重跳过 = 永久漏推')
    // run.log 摘要必须如实计数（cron/status 的可观测入口）
    const runLog1 = realFs.readFileSync(path.join(cacheDir, 'run.log'), 'utf8')
    assert.ok(/truncated=3 pushed=2 failed=0/.test(runLog1), `run.log 摘要应记 truncated=3 pushed=2：${runLog1.slice(-400)}`)

    // 第二轮：上限放宽，接口重放同样 5 条 ⇒ 缓存去重 2、补推 3（不丢不重）
    h.Config.push.maxPerRun = 100
    h.setItems(fiveItems())
    const r2 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ pushed: r2.summary.pushed, dedup: r2.summary.dedup, truncated: r2.summary.truncated },
      { pushed: 3, dedup: 2, truncated: 0 }, `第二轮必须补推被截断的 3 条：${JSON.stringify(r2.summary)}`)
    assert.strictEqual(h.cacheMessages().length, 5, '两轮结束后 5 条应全部入缓存（无重复、无遗漏）')
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

checkAsync('TR-2 待推送数恰好等于 maxPerRun：不得判为截断（严格大于），不得多推也不得写截断告警', async () => {
  const realFs = require('fs')
  const cacheDir = mkTmpFixture('trunc-eq-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  try {
    h.Config.push.maxPerRun = 2
    h.setItems([makeRunItem('eq-1', '边界甲'), makeRunItem('eq-2', '边界乙')])
    const r = await runWithWarnings(h.App)
    assert.deepStrictEqual({ pushed: r.summary.pushed, truncated: r.summary.truncated },
      { pushed: 2, truncated: 0 }, `恰好等于上限时不得截断：${JSON.stringify(r.summary)}`)
    assert.ok(!r.warns.some(l => l.includes('超过上限')),
      `恰好等于上限不得输出截断告警（>= 会多发一条 0 条截断的告警）：${JSON.stringify(r.warns)}`)
    assert.deepStrictEqual(h.cacheMessages().map(m => m.id).sort(), ['eq-1', 'eq-2'], '两条都必须入缓存')
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

// 共享夹具：临时 cacheDir + 真装配 harness + 环境变量还原（异常路径也还原，避免污染后续用例）
async function withRunHarness (over, fn) {
  const realFs = require('fs')
  const cacheDir = mkTmpFixture('runh-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir, over)
  try {
    return await fn(h, cacheDir, realFs)
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
}

checkAsync('ALERT-1 异类告警不得互相压制：截断告警限频窗口内的「推送全部失败」必须送达，同类仍限频', async () => {
  const now = 1700000000000
  const { app, sent } = makeNotifyApp({ Config: { alert: { enabled: true, intervalMs: 3600000 } } })
  const r1 = await withFixedNowAsync(now, () => app._sendAlert('截断 3 条', 'truncate'))
  assert.strictEqual(r1, true, '首条截断告警应发送成功')
  assert.strictEqual(sent.length, 1)
  // 5 分钟后换一类：共用单一 lastAt 时这里会被整段压掉（返回 undefined、实发数仍为 1）
  const r2 = await withFixedNowAsync(now + 300000, () => app._sendAlert('推送全部失败（2 条）', 'push-fail'))
  assert.strictEqual(r2, true, '异类告警必须送达（曾被 alert.state 的单一 lastAt 压制）')
  assert.strictEqual(sent.length, 2, `异类告警实发数应为 2，实际 ${sent.length}`)
  // 同类仍在窗口内 ⇒ 必须继续压制（防轰炸是既定设计，不得为了「不压制」把它拆掉）
  const r3 = await withFixedNowAsync(now + 600000, () => app._sendAlert('又一次全失败', 'push-fail'))
  assert.strictEqual(r3, undefined, '同类告警在限频窗口内必须继续压制（防轰炸）')
  assert.strictEqual(sent.length, 2, '同类压制生效，不得多发')
  // 第三类同样不被前两类压制
  const r4 = await withFixedNowAsync(now + 700000, () => app._sendAlert('接口 404', 'run-error'))
  assert.strictEqual(r4, true, '第三类告警同样不得被其他类别压制')
  assert.strictEqual(sent.length, 3)
})

checkAsync('ALERT-2 旧版 alert.state（只有 lastAt、无 classes）升级后仍限频：不得因格式变更放过轰炸', async () => {
  const now = 1700000000000
  const legacy = JSON.stringify({ lastAt: now - 60000 }) // 1 分钟前写过，无 classes 字段
  const { app, sent } = makeNotifyApp({
    Config: { alert: { enabled: true, intervalMs: 3600000 } },
    readSafeTextResult: () => ({ status: 'ok', text: legacy })
  })
  await withFixedNowAsync(now, async () => {
    for (const cls of ['truncate', 'push-fail', 'run-error']) {
      const r = await app._sendAlert('boom', cls)
      assert.strictEqual(r, undefined, `旧状态文件的 lastAt 必须继续压制 ${cls}（升级后第一个窗口不得放宽）`)
    }
  })
  assert.strictEqual(sent.length, 0, '旧状态在窗口内不得触发任何告警')
})

checkAsync('ALERT-3 告警状态向后兼容：顶层 lastAt=最近一次（旧读者口径不变），并逐类记 classes', async () => {
  const now = 1700000000000
  const { app, stateWrites } = makeNotifyApp({ Config: { alert: { enabled: true, intervalMs: 3600000 } } })
  await withFixedNowAsync(now, () => app._sendAlert('截断', 'truncate'))
  await withFixedNowAsync(now + 300000, () => app._sendAlert('全失败', 'push-fail'))
  assert.ok(stateWrites.length >= 2, `两次告警都应持久化状态：${JSON.stringify(stateWrites)}`)
  const last = JSON.parse(stateWrites[stateWrites.length - 1][1])
  assert.strictEqual(last.lastAt, now + 300000, '顶层 lastAt 必须是最近一次告警时间（status/旧版本读取口径不变）')
  assert.deepStrictEqual(last.classes, { truncate: now, 'push-fail': now + 300000 },
    'classes 必须逐类记录最后发送时间（异类分流的数据基础）')
  // 显式码元序比较器：默认 sort() 也是 UTF-16 码元序，但依赖隐式行为在跨 locale/实现时不可确定
  // （且读代码的人得自己推断），localeCompare 反过来会随 ICU/locale 变序 ⇒ 这里写死码元序。
  assert.deepStrictEqual(Object.keys(last).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ['classes', 'lastAt'], '状态字段只增不改（不得丢 lastAt）')
})

checkAsync('ALERT-4 同一轮「截断 + 推送全部失败」两类告警都必须送达（调用点必须各带类别）', async () => {
  const alertSends = []
  const Pusher = {
    send: async (text, desp) => {
      if (text.includes('运行异常')) {
        alertSends.push({ text, desp })
        return { successfulChannels: ['stub'], failures: [] }
      }
      throw new Error('模拟推送通道全失败')
    }
  }
  await withRunHarness({ Pusher }, async (h) => {
    h.Config.alert = { enabled: true, intervalMs: 3600000 }
    h.Config.push.maxPerRun = 2
    h.setItems([1, 2, 3, 4, 5].map(i => makeRunItem('al-' + i, '告警' + i)))
    const r = await runWithWarnings(h.App)
    assert.deepStrictEqual({ pushed: r.summary.pushed, failed: r.summary.failed, truncated: r.summary.truncated },
      { pushed: 0, failed: 2, truncated: 3 }, `夹具前提异常：${JSON.stringify(r.summary)}`)
    assert.strictEqual(alertSends.length, 2,
      `截断（truncate）与全失败（push-fail）是两类告警，都必须送达；共用单一 lastAt 时第二条被压掉（实际 ${alertSends.length}）`)
    assert.ok(alertSends[0].desp.includes('截断'), `第一条应是截断告警：${alertSends[0].desp}`)
    assert.ok(alertSends[1].desp.includes('推送全部失败'), `第二条应是全失败告警：${alertSends[1].desp}`)
  })
})

checkAsync('ALERT-5 同类告警被限频压制时仍必须留痕：run.log 有 truncated= 与 ERROR 推送全部失败', async () => {
  const alertSends = []
  const Pusher = {
    send: async (text) => {
      if (text.includes('运行异常')) {
        alertSends.push(text)
        return { successfulChannels: ['stub'], failures: [] }
      }
      throw new Error('模拟推送通道全失败')
    }
  }
  await withRunHarness({ Pusher }, async (h, cacheDir, realFs) => {
    h.Config.alert = { enabled: true, intervalMs: 3600000 }
    h.Config.push.maxPerRun = 2
    const now = Date.now()
    // 预置「两类都刚发过」的状态 ⇒ 本轮两条告警都被限频吞掉（压制是设计，但不得零留痕）
    realFs.writeFileSync(path.join(cacheDir, 'alert.state'),
      JSON.stringify({ lastAt: now, classes: { truncate: now, 'push-fail': now } }))
    h.setItems([1, 2, 3, 4, 5].map(i => makeRunItem('qs-' + i, '压制' + i)))
    const r = await runWithWarnings(h.App)
    assert.strictEqual(r.summary.truncated, 3, '夹具前提：本轮确实截断 3 条')
    assert.strictEqual(alertSends.length, 0, '限频窗口内同类告警必须被压制（本用例的前提）')
    const log = realFs.readFileSync(path.join(cacheDir, 'run.log'), 'utf8')
    assert.ok(/truncated=3/.test(log), `截断必须在 run.log 摘要行留痕（“被压制=零留痕”不成立）：${log.slice(-400)}`)
    assert.ok(/ERROR 推送全部失败 2 条/.test(log), `全失败必须有 ERROR 行（cron 翻日志可见）：${log.slice(-400)}`)
  })
})

checkAsync('DAT-1 100% 脏数据必须可观测：run.log WARN + bad= 字段 + 告警，而空数组/全量去重不告警', async () => {
  const alertSends = []
  const Pusher = {
    send: async (text, desp) => {
      if (text.includes('运行异常')) {
        alertSends.push({ text, desp })
        return { successfulChannels: ['stub'], failures: [] }
      }
      return { successfulChannels: ['stub'], failures: [] }
    }
  }
  await withRunHarness({ Pusher }, async (h, cacheDir, realFs) => {
    h.Config.alert = { enabled: true, intervalMs: 0 } // 不限频：关注「有没有告警」而不是限频
    const logPath = path.join(cacheDir, 'run.log')
    const readLog = () => (realFs.existsSync(logPath) ? realFs.readFileSync(logPath, 'utf8') : '')
    // 只数 WARN 行：ALERT 行的原因文本里也会出现「全部为脏数据」，按整句计数会把告警自身算进来
    const dirtyLines = () => readLog().split('\n').filter(l => /WARN 本轮抓取 \d+ 条全部为脏数据/.test(l)).length

    // ① 全部非法元素：契约不变（failed 只统计已进入推送的条目 ⇒ 0、退出码 0），但必须留痕 + 告警
    h.setItems([null, 'oops', 123, [], true])
    const r1 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ total: r1.summary.total, pushed: r1.summary.pushed, failed: r1.summary.failed },
      { total: 5, pushed: 0, failed: 0 },
      `既定契约：failed 只统计已进入推送的条目（100% 脏数据时恒为 0），不得改动：${JSON.stringify(r1.summary)}`)
    assert.strictEqual(dirtyLines(), 1, `run.log 必须留一行「全部为脏数据」WARN：${readLog().slice(-500)}`)
    assert.ok(/bad=5/.test(readLog()), `run.log 摘要行必须带 bad=5（非对象元素数）：${readLog().slice(-300)}`)
    assert.strictEqual(alertSends.length, 1,
      `100% 脏数据必须告警（旧实现零告警零留痕，脚本整天「绿色成功」却一条没推）：${JSON.stringify(alertSends)}`)
    assert.ok(alertSends[0].desp.includes('脏数据'), `告警原因必须点名脏数据：${alertSends[0].desp}`)

    // ② 全部无有效身份：同样可观测，并带 noidentity 明细
    h.Config.api.pushUrl = 'https://example.invalid/dirty-noidentity.json'
    h.setItems([{}, {}, { title: '' }])
    const r2 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ total: r2.summary.total, pushed: r2.summary.pushed, failed: r2.summary.failed },
      { total: 3, pushed: 0, failed: 0 }, `全无身份同样不得改 failed 口径：${JSON.stringify(r2.summary)}`)
    assert.strictEqual(dirtyLines(), 2, '全无身份也必须留「全部为脏数据」WARN')
    assert.ok(/noidentity=3/.test(readLog()), `摘要行必须带 noidentity=3：${readLog().slice(-300)}`)
    assert.strictEqual(alertSends.length, 2, '全无身份同样必须告警')

    // ③ 空数组：既定契约「空数据不告警」——不得因本修复被打破
    h.Config.api.pushUrl = 'https://example.invalid/dirty-empty.json'
    h.setItems([])
    const r3 = await runWithWarnings(h.App)
    assert.strictEqual(r3.summary.total, 0, `空数组 total 应为 0：${JSON.stringify(r3.summary)}`)
    assert.strictEqual(dirtyLines(), 2, '空数组不得新增「全部为脏数据」WARN')
    assert.strictEqual(alertSends.length, 2, '空数组不得告警（既定契约，test_app.js「空数据 → 不推送不崩溃」钉住）')

    // ④ 全量去重（items 为空但一条不脏）：不得误报脏数据
    h.Config.api.pushUrl = 'https://example.invalid/dirty-dedup.json'
    h.setItems([makeRunItem('dd-1', '去重甲'), makeRunItem('dd-2', '去重乙')])
    const warm = await runWithWarnings(h.App)
    assert.strictEqual(warm.summary.pushed, 2, `预热轮应推 2 条：${JSON.stringify(warm.summary)}`)
    h.setItems([makeRunItem('dd-1', '去重甲'), makeRunItem('dd-2', '去重乙')])
    const r4 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ dedup: r4.summary.dedup, pushed: r4.summary.pushed },
      { dedup: 2, pushed: 0 }, `预热轮后应全量去重：${JSON.stringify(r4.summary)}`)
    assert.strictEqual(dirtyLines(), 2, '全量去重（非脏数据）不得误报「全部为脏数据」')
    assert.strictEqual(alertSends.length, 2, '全量去重不得告警')
  })
})

// ===== C5-016：「推送失败不写缓存」契约（变异集内唯一覆盖点）=====
// run() 的失败路径此前在 test_app_unit.js 里零覆盖：三处 App.run 全用恒成功桩（Pusher.send
// 永不抛）。该契约只有不进变异集的 test_app.js 守着，于是「推送失败仍写缓存」的变异体
// （xbk_app.js 的 `ok: false` → `ok: true`、toCache 的 `|| pushedKeys.has(keyOf(m))` → `|| true`）
// 在变异矩阵里可存活——后果是失败消息被写进缓存，下轮当「已推送」去重 ⇒ 永久漏推。
// 断言必须落到**缓存文件内容**：只看 summary.failed 杀不掉 toCache 那个变异体。
checkAsync('RUN-1 推送失败不写缓存：失败条目不得进缓存（含文件字节），下一轮必须重推', async () => {
  const realFs = require('fs')
  const FilterStore = require('./xbk_filter_store')
  FilterStore.resetStoreStateForTests()
  const cacheDir = mkTmpFixture('filter-run-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)
  const FAIL_TITLE = '通道失败乙'
  const origSend = h.Pusher.send
  let failTitle = FAIL_TITLE // null = 通道恢复
  h.Pusher.send = async (text, desp) => {
    if (failTitle && text.includes(failTitle)) throw new Error('push boom（模拟通道失败）')
    return origSend(text, desp)
  }
  const cachePath = h.MessageStore.getFilePath(h.cacheName())
  try {
    h.setItems([makeRunItem('run1-a', '正常甲'), makeRunItem('run1-b', FAIL_TITLE)])
    const round1 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ pushed: round1.summary.pushed, failed: round1.summary.failed }, { pushed: 1, failed: 1 },
      `第一轮应是「1 推成功 + 1 推失败」：${JSON.stringify(round1.summary)}`)
    const idsAfterFail = h.cacheMessages().map(m => m && m.id)
    assert.deepStrictEqual(idsAfterFail, ['run1-a'],
      `推送失败的条目绝不能被写进缓存（写进去 ⇒ 下轮被当已推送去重 ⇒ 永久漏推）：实际 ${JSON.stringify(idsAfterFail)}`)
    // 字节级复核：读取层可能因形状/键名差异掩盖问题，缓存文件里也不得出现失败条目。
    assert.ok(!realFs.readFileSync(cachePath, 'utf8').includes('run1-b'),
      '缓存文件字节里不得出现失败条目 id（推送失败不写缓存）')

    // 第二轮：通道恢复。失败条目必须被重推（若上轮被误写进缓存，这里会因去重而 pushed=0）。
    failTitle = null
    const round2 = await runWithWarnings(h.App)
    assert.deepStrictEqual({ pushed: round2.summary.pushed, failed: round2.summary.failed }, { pushed: 1, failed: 0 },
      `第二轮必须重推上轮失败的那条：${JSON.stringify(round2.summary)}`)
    assert.deepStrictEqual(h.cacheMessages().map(m => m && m.id).sort(), ['run1-a', 'run1-b'],
      '重推成功后两条都应进缓存')
  } finally {
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

// ============================================================
// CD-1（CR-03）：cacheDir 必须「每次访问都校验」
//
// 背景：本 PR 的 C1-027 曾把 MessageStore.cacheDir 的 getter 求值优化成 run() 里解析一次并钉到
// _cacheDirForRun，其后同一轮的 run.log / 状态文件写入全部复用这条未经校验的路径。若运行期间
// 缓存目录的父目录被换成指向项目外的符号链接，写入会跟着链接走（符号链接防御从「每次写入」降级
// 成「只看启动那一刻」）。本用例在**运行中**（Pusher.send 时刻，init 之后、本轮日志/状态写入之前）
// 把目录替换成外部符号链接，断言：① 每次访问都真的重新求值 getter；② 替换后当次访问即失败；
// ③ 同一时刻的日志写入不跟随链接、外部目标文件一个字节都不变。
// ============================================================
checkAsync('CD-1 cacheDir 每次访问都重新校验：运行中目录被换成外部符号链接 ⇒ 当次访问失败、写入不跟随链接', async () => {
  const realFs = require('fs')
  const FilterStore = require('./xbk_filter_store')
  FilterStore.resetStoreStateForTests()
  const cacheDir = mkTmpFixture('cachedir-swap-')
  const outsideDir = mkTmpFixture('cachedir-outside-')
  const prevEnvDir = process.env.XBK_CACHE_DIR
  const prevDryRun = process.env.XBK_DRY_RUN
  process.env.XBK_CACHE_DIR = cacheDir
  delete process.env.XBK_DRY_RUN
  const h = buildFilterRunHarness(cacheDir)

  // getter 换成「每次求值都 lstat + 计数」的校验版：生产 getter 本身是 existsSync 逐级回溯 + lstat +
  // realpathSync，这里只补上「求值次数」与「目标被换成符号链接即抛错」两个可观测点（XBK_CACHE_DIR
  // 的显式覆盖在真实 getter 里只做 resolve，不参与根内 realpath 校验，故这一维必须由用例自己钉）。
  const realGet = Object.getOwnPropertyDescriptor(h.MessageStore, 'cacheDir').get
  let cacheDirReads = 0
  Object.defineProperty(h.MessageStore, 'cacheDir', {
    configurable: true,
    get () {
      cacheDirReads += 1
      const dir = realGet.call(this)
      if (realFs.lstatSync(dir).isSymbolicLink()) throw new Error('缓存目录安全检查失败：目录已被替换为符号链接')
      return dir
    }
  })

  const outsideLog = path.join(outsideDir, 'run.log')
  realFs.writeFileSync(outsideLog, 'ORIGINAL\n', { mode: 0o600 })
  const outsideListing = realFs.readdirSync(outsideDir).sort()
  const stash = cacheDir + '.stash'
  const observed = { threw: null, outsideLogDuringSwap: null, listingDuringSwap: null }
  const origSend = h.Pusher.send
  let swapped = false
  h.Pusher.send = async (text, desp) => {
    if (!swapped) {
      swapped = true
      // ① 每次访问都必须重新走 getter：run() 已执行过 init，此处若复用「开头解析的路径」则计数不变。
      const before = cacheDirReads
      assert.strictEqual(h.App._cacheDir(), cacheDir, '未替换前应返回缓存目录')
      assert.strictEqual(cacheDirReads, before + 1,
        '运行期每次访问都必须重新求值 MessageStore.cacheDir（不得复用 run() 开头解析的路径）')

      // ② 运行中把缓存目录换成指向项目外的符号链接（父目录有写权限的进程即可做到）。
      realFs.renameSync(cacheDir, stash)
      realFs.symlinkSync(outsideDir, cacheDir, 'dir')
      try {
        try {
          h.App._cacheDir()
        } catch (e) {
          observed.threw = e
        }
        // ③ 同一时刻的日志写入：目录已被替换 ⇒ 必须当场失败，绝不跟随链接写到 outsideDir。
        h.App._writeRunLog('cd1-probe\n')
        observed.outsideLogDuringSwap = realFs.readFileSync(outsideLog, 'utf8')
        observed.listingDuringSwap = realFs.readdirSync(outsideDir).sort()
      } finally {
        realFs.unlinkSync(cacheDir)
        realFs.renameSync(stash, cacheDir)
      }
    }
    return origSend(text, desp)
  }

  try {
    h.setItems([makeRunItem('cd1-a', '正常甲')])
    const round = await runWithWarnings(h.App)
    assert.ok(observed.threw, '目录被替换成符号链接后，当次 cacheDir 访问必须失败（返回旧路径 = 校验被缓存掉了）')
    assert.match(String(observed.threw && observed.threw.message), /安全检查失败/,
      `替换后的访问必须报「安全检查失败」，实际：${observed.threw && observed.threw.message}`)
    assert.strictEqual(observed.outsideLogDuringSwap, 'ORIGINAL\n',
      '目录被替换后，run.log 写入不得跟随符号链接改写项目外文件')
    assert.deepStrictEqual(observed.listingDuringSwap, outsideListing,
      '目录被替换后，不得在项目外目录里留下任何新文件（run.log.lock / 截尾临时文件）')
    assert.strictEqual(realFs.readFileSync(outsideLog, 'utf8'), 'ORIGINAL\n',
      '本轮结束后项目外目标文件仍必须逐字节不变')
    assert.deepStrictEqual({ pushed: round.summary.pushed, failed: round.summary.failed }, { pushed: 1, failed: 0 },
      `目录归位后本轮应正常推送：${JSON.stringify(round.summary)}`)
  } finally {
    if (realFs.existsSync(stash)) realFs.rmSync(stash, { recursive: true, force: true })
    realFs.rmSync(cacheDir, { recursive: true, force: true })
    realFs.rmSync(outsideDir, { recursive: true, force: true })
    if (prevEnvDir === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevEnvDir
    if (prevDryRun === undefined) delete process.env.XBK_DRY_RUN
    else process.env.XBK_DRY_RUN = prevDryRun
  }
})

// ===== C1-014：日报计数器名单必须是单一来源 =====
// 审计条目：7 个计数器名在 9 处各写一遍，加字段必漏。这里用**源码形状**断言把「只剩一份名单」
// 钉住：回退修复（把名单拆回 _blankReportState 字面量 / 各校验循环 / nextState 字面量）会让
// 下面的计数立刻变红，避免下次重构又悄悄长出第二份。
check('C1-014 计数器名单单一来源：字面量仅常量一处，其余一律引用 REPORT_COUNTERS', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, 'xbk_app.js'), 'utf8')
  // 去掉整行注释（注释里复述名单不算实现重复；行内注释保留，行内复述即视为漂移）
  const code = src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
  const literalLists = code.match(/'runs', 'total'/g) || []
  assert.strictEqual(literalLists.length, 1,
    `计数器名单字面量必须只剩常量这一处，实际 ${literalLists.length} 处（加字段必漏的根因就是它多份）`)
  const refs = code.match(/REPORT_COUNTERS/g) || []
  assert.ok(refs.length >= 5, `清零/归一化/校验/日报结转都必须引用 REPORT_COUNTERS，实际引用 ${refs.length} 处`)
  assert.strictEqual(/runs:\s*0,\s*total:\s*0/.test(code), false,
    '不得再出现手写七字段零值字面量（新增计数器时它会漏掉）')
})

check('C1-014 _blankReportState 与名单同源：所有计数器为 0、date 为空、无多余键', () => {
  const app = makeApp()
  const blank = app._blankReportState()
  assert.deepStrictEqual(Object.keys(blank), ['date', 'runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated'])
  for (const k of ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
    assert.strictEqual(blank[k], 0, `${k} 必须清零`)
  }
})

check('C1-014 归一化与跨天结转都按同一名单搬运：丢掉名单外键、保留名单内计数', () => {
  const app = makeApp()
  const st = app._normalizeReportState({ date: '2024-03-15', runs: 2, pending: { pushed: 3, junk: 9 }, junk: 1 })
  assert.strictEqual(st.junk, undefined, '名单外的顶键必须丢弃')
  assert.strictEqual(st.pending.junk, undefined, 'pending 里名单外的键同样丢弃')
  assert.strictEqual(st.pending.pushed, 3, 'pending 的名单内计数必须原样保留')
  assert.strictEqual(st.runs, 2)
})

// ===== C1-009：re2 缺失提醒链的三个静默口 =====
// 审计条目：(a) dry-run 完全不提；(b) _sendAlert 返回 undefined（限频/禁用）被当已处理；(c) 规则侧
// 逐字段告警只在全局提醒链里被覆盖——全局链一静默，规则全量跳过就零痕迹。
// 这里分别钉住 (a)(b)；(c) 由这两条共同覆盖（compileRules 在 re2 缺失时不逐字段告警，见 xbk_rules.js
// 的 `if (!isRe2Available()) { compiled[field] = null; continue }`）。
checkAsync('C1-009 dry-run 时 re2 缺失必须本地留痕（console.warn + run.log），但不发告警、不写标记', async () => {
  const mfs = makeMemFs()
  const dir2 = os.tmpdir()
  let alerted = 0
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir2, sendAlert: async () => { alerted++; return true } })
  const logs = []
  app._writeRunLog = (line) => { logs.push(String(line)) }
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.map(String).join(' '))
  try {
    await app._warnMissingRe2({ dryRun: true })
  } finally {
    console.warn = origWarn
  }
  assert.strictEqual(alerted, 0, 'dry-run 不得发送告警（无通知副作用）')
  assert.strictEqual(mfs._files.size, 0, 'dry-run 不得写标记文件（否则会把当天的真实告警吞掉）')
  assert.ok(warns.some(m => m.includes('[re2 缺失提醒]')), `dry-run 必须打印 re2 缺失提醒，实际：${JSON.stringify(warns)}`)
  assert.ok(logs.some(l => l.includes('WARN') && l.includes('[re2 缺失提醒]')), `dry-run 必须在 run.log 留一行 WARN，实际：${JSON.stringify(logs)}`)
})

checkAsync('C1-009 告警启用但本轮被限频（_sendAlert 返回 undefined）⇒ 标记保留 pending，不得当已处理', async () => {
  const mfs = makeMemFs()
  const dir3 = os.tmpdir()
  const sp = dir3 + '/re2warn.state.' + stamp
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir3, sendAlert: async () => true })
  app._writeRunLog = () => {}
  // 模拟「告警启用但本轮被限频跳过」：_sendAlert 返回 undefined（限频/状态不可读的唯一出口）
  app._sendAlert = async () => undefined
  await app._warnMissingRe2()
  assert.strictEqual(mfs._files.has(sp), true, '跳过（undefined）时不得删除 pending 标记')
  const parsed = JSON.parse(mfs.readFileSync(sp))
  assert.strictEqual(parsed.status, 'pending', '未送达的提醒必须保持 pending，下一轮才能在限频窗口过后重发')
})

checkAsync('C1-009 用户主动关闭告警（_sendAlert 返回 undefined 且 alert.enabled=false）⇒ 置 completed，不每轮重试', async () => {
  const mfs = makeMemFs()
  const dir4 = os.tmpdir()
  const sp = dir4 + '/re2warn.state.' + stamp
  const app = makeRe2WarnApp({ fs: mfs, cacheDir: dir4, sendAlert: async () => true })
  app._writeRunLog = () => {}
  app._sendAlert = async () => undefined
  // 关闭告警：Config.alert 由 makeRe2WarnApp 固定为 { enabled: true }，这里直接让开关判定为关
  app._enabledFlag = (cfg) => { if (cfg === undefined) return false; return cfg && cfg.enabled !== true }
  await app._warnMissingRe2()
  const parsed = JSON.parse(mfs.readFileSync(sp))
  assert.strictEqual(parsed.status, 'completed', '用户关闭告警时本地已留痕，标记置 completed 防每轮重跑')
})

// ===== C1-017：并行/顺序两条推送循环的共用口径 =====
// 审计条目：两条循环各自实现日志、成功计数、补位间隔。这里锁住「只剩一份实现」——回退修复后
// 成功日志文案与 pushInterval 解析会各自回到两份，计数立刻变红。
check('C1-017 推送循环共用口径：成功日志文案与 pushInterval 解析各只有一份', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, 'xbk_app.js'), 'utf8')
  const code = src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
  const logHits = code.match(/发现到新数据：/g) || []
  assert.strictEqual(logHits.length, 1, `成功日志文案必须只有一处（logPushed），实际 ${logHits.length} 处`)
  const intervalHits = code.match(/Utils\.num\(Config\.timing\.pushInterval, 0\)/g) || []
  assert.strictEqual(intervalHits.length, 1, `pushInterval 解析必须只有一处，实际 ${intervalHits.length} 处`)
  const countHits = code.match(/successCount \+= logPushed\(r\)/g) || []
  assert.strictEqual(countHits.length, 2, `并行/顺序都必须经同一 logPushed 计数，实际 ${countHits.length} 处`)
})

// ===== C1-011：run.log 的 fail-open 分支必须有次级上限 =====
// 审计条目：≤1MiB + 行完整只在拿到锁时成立；拿不到锁（锁文件 EACCES/属主异常）就无限追加。
// 既有用例（「锁异常（EACCES）⇒ fail-open 仅追加；超限也不截尾」）锁的是 2×1MiB 仍要追加，
// 所以次级上限必须高于它；这里验证超过硬上限后不再写盘、行回显 stdout、且仍不做无锁读改写。
check('C1-011 fail-open 且超过次级上限 ⇒ 不再写盘、行回显 stdout、不做无锁读改写', () => {
  const e = new Error('x'); e.code = 'EACCES'
  const rec = makeLogFs({ openSync: (p, flag) => { if (flag === 'wx') throw e; return 8 }, size: 9 * LIMIT })
  const { app } = makeLogApp({ rec })
  const logs = []
  const origLog = console.log
  console.log = (...a) => logs.push(a.map(String).join(' '))
  try {
    app._writeRunLog('overflow-line\n')
  } finally {
    console.log = origLog
  }
  assert.deepStrictEqual(rec.rec.append, [], '超过次级上限后不得继续追加（无界增长的根因）')
  assert.deepStrictEqual(logs, ['overflow-line'], '行不得丢：必须回显到 stdout（青龙任务日志可见）')
  assert.strictEqual(rec.rec.read.length, 0, '无锁路径不得做读改写（会冲掉并发追加的行）')
  assert.deepStrictEqual(rec.rec.open.map(o => o[1]), ['wx'], '不得在无锁时开 r+')
  assert.strictEqual(rec.rec.unlink.length, 0)
})

check('C1-011 次级上限是 fail-open 专属：拿到锁时超 1MiB 仍按锁内截尾（8×1MiB 上限不得误伤）', () => {
  const rec = makeLogFs({ size: 2 * LIMIT, tail: '\nTAIL' })
  const { app, cap } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.strictEqual(rec.rec.append.length, 1, '持锁时照常追加')
  assert.strictEqual(cap.length, 1, '持锁时超 1MiB 必须走原子写回（截尾）')
})

// ===== 异步用例执行（必须留在文件末尾）=====
// C5-004：drain 原先夹在文件中间，靠「for…of 读活数组 + 循环体 await 让出」才顺带跑到后面注册的
// 用例——drain 一旦前移、或注册前出现真正的异步等待，那些用例会静默不跑且没有计数对账。
// 现在：① 移到文件末尾；② 先快照 asyncChecks 再跑；③ 对账「声明数 === 结算数」。
;(async () => {
  const pending = asyncChecks.slice()
  for (const [name, fn] of pending) {
    try {
      await fn()
      passed++
    } catch (e) {
      failed++
      failures.push(`${name} :: ${e.message}`)
    }
  }
  console.log(`通过 ${passed} / 失败 ${failed}（声明 ${declared} 例）`)
  if (failed > 0) {
    for (const f of failures) console.log(`  ❌ ${f}`)
  }
  if (passed + failed !== declared) {
    console.log(`  ❌ 用例计数对账失败：声明 ${declared} 例，实际结算 ${passed + failed} 例（${declared - passed - failed} 例永远不会被执行）`)
    process.exit(1)
  }
  process.exit(failed > 0 ? 1 : 0)
})().catch(e => { console.error(e); process.exitCode = 1 })
