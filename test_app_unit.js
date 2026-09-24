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

check('_writeRunLog 锁 fd 为 0 时 finally 仍释放（close/unlink），不得漏清理', () => {
  const rec = makeLogFs({ openSync: (p, flag) => (flag === 'wx' ? 0 : 9) })
  const { app } = makeLogApp({ rec })
  app._writeRunLog('l\n')
  assert.deepStrictEqual(rec.rec.write, [[0, `${process.pid}:42`]])
  assert.deepStrictEqual(rec.rec.close, [0])
  assert.deepStrictEqual(rec.rec.unlink, [LOCK_PATH])
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
  for (const info of [null, { freeBytes: NaN }, { freeBytes: Infinity }]) {
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

console.log(`通过 ${passed} / 失败 ${failed}`)
if (failed > 0) {
  for (const f of failures) console.log(`  ❌ ${f}`)
  process.exit(1)
}
process.exit(0)
