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

// ============================================================================
// 报告 / 告警 / 模板校验簇（本段新增，全部对着 SYSTEM_CONTRACT.md「日报日界固定
// Asia/Shanghai；告警/日报失败不得影响主流程」与 README「运行日报与通道健康」）
// 断言纪律：strictEqual / deepStrictEqual 精确值，开关与边界真假两侧各一例。
// 时间一律注入固定时钟（withFixedNowAsync / _localStamp 覆写），从不比较真实时钟。
// ============================================================================

const asyncChecks = []
function checkAsync (name, fn) { asyncChecks.push([name, fn]) }

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
  assert.strictEqual(app._enabledFlag({ enabled: NaN }), false)
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
  app._accumulateReport(st, { total: -5, dedup: '7', filtered: NaN, pushed: Infinity, failed: undefined, truncated: null })
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
    date: '2024-01-02', runs: 2, total: 12, dedup: 23, filtered: 34, pushed: 45, failed: 56, truncated: 67
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
    date: '2024-03-01', runs: 1, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0
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
    date: '2024-01-02', runs: 1, total: 4, dedup: 0, filtered: 0, pushed: 5, failed: 0, truncated: 0
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
    date: '2024-01-02', runs: 3, total: 11, dedup: 22, filtered: 33, pushed: 44, failed: 55, truncated: 66
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
    date: '2024-01-02', runs: 1, total: 1, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6
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
    date: '2024-01-02', runs: 1, total: 1, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6
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
    date: '2024-01-02', runs: 1, total: 1, dedup: 2, filtered: 3, pushed: 4, failed: 5, truncated: 6
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
  assert.deepStrictEqual(stateWrites, [[ALERT_PATH, '{"lastAt":1700000000000}']])
  assert.deepStrictEqual(app._alertLastAtByPath.get(ALERT_PATH), { lastAt: now, persisted: true })
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
  assert.deepStrictEqual(app._alertLastAtByPath.get(ALERT_PATH), { lastAt: now, persisted: true })
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
  assert.deepStrictEqual(stateWrites, [[ALERT_PATH, '{"lastAt":1700000000000}']])
  assert.deepStrictEqual(app._alertLastAtByPath.get(ALERT_PATH), { lastAt: now, persisted: false })
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

// ===== 异步用例执行（同步用例已在上方跑完）=====
;(async () => {
  for (const [name, fn] of asyncChecks) {
    try {
      await fn()
      passed++
    } catch (e) {
      failed++
      failures.push(`${name} :: ${e.message}`)
    }
  }
  console.log(`通过 ${passed} / 失败 ${failed}`)
  if (failed > 0) {
    for (const f of failures) console.log(`  ❌ ${f}`)
    process.exit(1)
  }
  process.exit(0)
})()
