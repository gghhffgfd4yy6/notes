'use strict'

// xbk_filter_store.js 单元测试（S1-store）
// 覆盖：字段白名单/schema/revision/长度/控制字符、### 行语法、嵌套量词、RE2 不可用、
//       编译结果对账、合并优先级、覆盖文件缺失/损坏/last-known-good、生效快照往返、
//       路径 helper（含备份名防路径穿越）、resetStoreStateForTests。
//
// 隔离口径：全部通过临时 cacheDir 驱动，**不 require xbk_function_v3**、不触碰 Config.filter；
// 文件末尾与 exit 钩子双重清理临时目录（断言失败提前 exit 也不留残骸）。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRuleEngine } = require('./xbk_rules')
const { FILTER_FIELDS } = require('./xbk_utils')
const {
  FILTER_RULE_FIELDS,
  FILTER_RULES_SCHEMA,
  filterRulesPaths,
  validateFilterRules,
  mergeActiveFilter,
  loadFilterRules,
  writeAppliedSnapshot,
  readAppliedSnapshot,
  resetStoreStateForTests
} = require('./xbk_filter_store')

// 循环依赖防线：本模块不得在加载链上 require 主入口（xbk_function_v3 → xbk_app → FilterStore）。
assert.strictEqual(
  Object.keys(require.cache).some(file => /xbk_function_v3\.js$/.test(file)),
  false,
  'xbk_filter_store.js 的加载链不得 require xbk_function_v3（会形成循环依赖）'
)

const compileUserRegex = (source, flags) => {
  try { return new RegExp(source, flags) } catch (e) { return null }
}
const RuleEngine = createRuleEngine({
  Utils: {
    safeGet: (obj, key) => (obj === null || obj === undefined ? undefined : obj[key]),
    safeErrorText: (error, fallback = '') => (error && error.message ? String(error.message) : fallback),
    parseTime: () => null,
    daysFrom: () => 0
  },
  FILTER_FIELDS: FILTER_RULE_FIELDS,
  compileUserRegex,
  isRe2Available: () => true
})
const deps = { RuleEngine, compileUserRegex, re2Available: true }
const noRe2Deps = { ...deps, re2Available: false }

// 代码默认层夹具：含非字符串值（pingbilouzhu: 123）与额外非白名单键，用于验证「只取 11 字段 + String 安全化」。
const DEFAULTS = {
  pingbifenlei: '默认分类',
  pingbibiaoti: '默认标题',
  zhanxianbiaoti: '',
  pingbibiaotiplus: '',
  pingbineirong: '默认内容',
  zhanxianneirong: '',
  pingbineirongplus: '',
  pingbilouzhu: 123,
  zhanxianlouzhu: '',
  pingbilouzhuplus: '',
  pingbitime: '5',
  bogus: '不是白名单字段'
}

let pass = 0
let fail = 0
function test (name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    process.exitCode = 1
    console.error(`  ❌ ${name}: ${e.message}`)
  }
}
function expectError (result, field, code, label) {
  assert.strictEqual(result.ok, false, `${label}：应校验失败`)
  assert.ok(
    result.errors.some(item => item.field === field && item.code === code),
    `${label}：期望 ${field}/${code}，实际 ${JSON.stringify(result.errors)}`
  )
}
function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function writeJson (file, value) {
  fs.writeFileSync(file, JSON.stringify(value))
}
function writeRaw (file, text) {
  fs.writeFileSync(file, text)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-filter-store-'))
process.once('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } })
let dirSeq = 0
const makeDir = () => {
  const dir = path.join(tmp, `case-${++dirSeq}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

console.log('=== xbk_filter_store.js 单元测试 ===')

// ===== 常量与字段契约 =====
test('FILTER_RULE_FIELDS 与 xbk_utils.FILTER_FIELDS 同源（10 字段 + pingbitime）', () => {
  assert.deepStrictEqual(FILTER_RULE_FIELDS.slice(0, 10), FILTER_FIELDS)
  assert.strictEqual(FILTER_RULE_FIELDS[10], 'pingbitime')
  assert.strictEqual(FILTER_RULE_FIELDS.length, 11)
  assert.ok(Object.isFrozen(FILTER_RULE_FIELDS), '字段清单必须冻结，防止调用方就地改写')
  assert.strictEqual(FILTER_RULES_SCHEMA, 1)
})

// ===== 闸门 1：schema / revision / 白名单 / 类型 / 长度 / 控制字符 =====
test('合法规则通过校验并原样返回已提交字段（不做 trim 改写）', () => {
  const filter = {
    pingbibiaoti: ' 屏蔽词 ',
    pingbineirong: 'a###分类A\nb###分类B',
    pingbitime: '5'
  }
  const result = validateFilterRules({ schema: 1, revision: 0, filter }, deps)
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
  assert.deepStrictEqual(result.value, filter)
  assert.deepStrictEqual(result.wideMatch, [])
  assert.deepStrictEqual(filter, {
    pingbibiaoti: ' 屏蔽词 ',
    pingbineirong: 'a###分类A\nb###分类B',
    pingbitime: '5'
  }, '校验不得就地改写入参')
})

test('revision 缺省按 0 通过（/validate 可只带 filter）', () => {
  const result = validateFilterRules({ filter: { pingbibiaoti: 'x' } }, deps)
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
})

test('未知字段被拒绝', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'x', evil: 'y' } }, deps), 'evil', 'unknown_field', '未知字段')
})

test('非字符串值被拒绝', () => {
  for (const bad of [123, true, {}, ['x'], null]) {
    expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: bad } }, deps), 'pingbibiaoti', 'not_string', `非字符串 ${String(bad)}`)
  }
})

test('超长字段被拒绝（4000 边界通过 / 4001 拒绝）', () => {
  const okBoundary = validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a'.repeat(4000) } }, deps)
  assert.strictEqual(okBoundary.ok, true, JSON.stringify(okBoundary.errors))
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a'.repeat(4001) } }, deps), 'pingbibiaoti', 'too_long', '超长')
})

test('控制字符被拒绝，\\n \\r \\t 允许', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a\u0000b' } }, deps), 'pingbibiaoti', 'control_char', 'NUL')
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a\u001Fb' } }, deps), 'pingbibiaoti', 'control_char', 'US')
  const allowed = validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a\tb\r\nc' } }, deps)
  assert.strictEqual(allowed.ok, true, JSON.stringify(allowed.errors))
})

test('schema 错误被拒绝（数字/字符串都严格比对）', () => {
  expectError(validateFilterRules({ schema: 2, revision: 0, filter: {} }, deps), 'schema', 'schema_mismatch', 'schema=2')
  expectError(validateFilterRules({ schema: '1', revision: 0, filter: {} }, deps), 'schema', 'schema_mismatch', "schema='1'")
})

test('空/非法 revision 被拒绝（null/空串/负数/小数/数字字符串）', () => {
  for (const bad of [null, '', -1, 1.5, '3', Number.NaN]) {
    expectError(validateFilterRules({ revision: bad, filter: {} }, deps), 'revision', 'invalid_revision', `revision=${String(bad)}`)
  }
})

test('输入形状非法时返回结构化错误而不是抛错', () => {
  expectError(validateFilterRules(null, deps), 'filter', 'invalid_input', 'null 输入')
  expectError(validateFilterRules({ revision: 0, filter: null }, deps), 'filter', 'invalid_filter', 'filter=null')
  expectError(validateFilterRules({ revision: 0, filter: [] }, deps), 'filter', 'invalid_filter', 'filter=数组')
  expectError(validateFilterRules({ revision: 0, filter: {} }, null), 'filter', 'deps_invalid', '缺 deps')
})

// ===== 闸门 2：### 行语法 =====
test('### 超过两段被拒绝', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a###b###c' } }, deps), 'pingbibiaoti', 'too_many_segments', '三###')
})

test('多行中缺少 ### 分隔符的行被拒绝', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a###b\n只是文本' } }, deps), 'pingbibiaoti', 'missing_separator', '缺分隔符')
})

test('### 行值为空被拒绝', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a###   ' } }, deps), 'pingbibiaoti', 'empty_value', '空值')
})

test('纯空白简单规则等同空值', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: '   ' } }, deps), 'pingbibiaoti', 'empty_value', '空白')
})

test('pingbifenlei 不允许 ### 多行语法', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbifenlei: 'a###b' } }, deps), 'pingbifenlei', 'multiline_not_supported', 'pingbifenlei ###')
})

test('pingbitime 天数必须是合法有限数', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbitime: 'abc' } }, deps), 'pingbitime', 'invalid_number', 'abc')
  expectError(validateFilterRules({ revision: 0, filter: { pingbitime: '-1' } }, deps), 'pingbitime', 'invalid_number', '负数')
  expectError(validateFilterRules({ revision: 0, filter: { pingbitime: '3650001' } }, deps), 'pingbitime', 'invalid_number', '超上限')
})

// ===== 闸门 3：嵌套量词 / RE2 不可用 / 正则语法 =====
test('嵌套量词被拒绝（值与分类两条路径）', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: '(a+)+' } }, deps), 'pingbibiaoti', 'nested_quantifier', '值嵌套量词')
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: '(a+)+###x' } }, deps), 'pingbibiaoti', 'nested_quantifier', '分类嵌套量词')
})

test('RE2 不可用时返回 engine_unavailable，且不因无规则而误报', () => {
  expectError(
    validateFilterRules({ revision: 0, filter: { pingbibiaoti: '屏蔽' } }, noRe2Deps),
    'filter', 'engine_unavailable', 're2Available=false'
  )
  expectError(
    validateFilterRules({ revision: 0, filter: { pingbibiaoti: '屏蔽' } }, { ...deps, re2Available: undefined, isRe2Available: () => false }),
    'filter', 'engine_unavailable', 'isRe2Available=false'
  )
  const empty = validateFilterRules({ revision: 0, filter: { pingbibiaoti: '', pingbitime: '5' } }, noRe2Deps)
  assert.strictEqual(empty.ok, true, `无正则规则时不应要求 RE2：${JSON.stringify(empty.errors)}`)
})

test('非法正则被拒绝', () => {
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: '(' } }, deps), 'pingbibiaoti', 'invalid_value_regex', '非法值')
})

// ===== 闸门 4：编译结果对账 =====
test('简单字段编译结果必须是 re（对账失败即拒绝）', () => {
  const fakeEngine = {
    hasNestedQuantifier: () => false,
    compileRules: () => ({ pingbibiaoti: { _type: 'multi', rules: [{}, {}] } })
  }
  expectError(
    validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'x' } }, { ...deps, RuleEngine: fakeEngine }),
    'pingbibiaoti', 'compile_mismatch', '简单字段编成 multi'
  )
})

test('多行规则编译条数必须等于有效行数', () => {
  const fakeEngine = {
    hasNestedQuantifier: () => false,
    compileRules: () => ({ pingbibiaoti: { _type: 'multi', rules: [{}] } })
  }
  expectError(
    validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a###x\nb###y' } }, { ...deps, RuleEngine: fakeEngine }),
    'pingbibiaoti', 'compile_mismatch', '多行条数不符'
  )
})

test('多行规则与真实 compileRules 对账通过（2 行 → rules=2）', () => {
  const result = validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a###x\nb###y' } }, deps)
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
})

test('宽匹配 .* / ^.*$（trim 后）记入 wideMatch', () => {
  const result = validateFilterRules({ revision: 0, filter: { pingbibiaoti: ' .* ', pingbineirong: '^.*$', zhanxianbiaoti: 'a###.*' } }, deps)
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
  assert.deepStrictEqual(result.wideMatch.sort(), ['pingbibiaoti', 'pingbineirong', 'zhanxianbiaoti'])
})

// ===== mergeActiveFilter：合并优先级 =====
test('覆盖字段优先，缺字段回代码默认（非字符串默认安全化）', () => {
  const merged = mergeActiveFilter({ defaults: DEFAULTS, keyword: { zkt_gjc: 'kw' }, override: { pingbibiaoti: '覆盖' } })
  assert.deepStrictEqual(Object.keys(merged.filter), [...FILTER_RULE_FIELDS])
  assert.strictEqual(merged.filter.pingbibiaoti, '覆盖')
  assert.strictEqual(merged.filter.pingbineirong, '默认内容')
  assert.strictEqual(merged.filter.pingbitime, '5')
  assert.strictEqual(merged.filter.pingbilouzhu, '123', '非字符串默认必须 String 安全化')
  assert.strictEqual('bogus' in merged.filter, false, '只保留 11 个白名单字段')
  assert.deepStrictEqual(merged.keyword, { zkt_gjc: 'kw' })
})

test('显式空串表示用户清空该规则（不回默认）', () => {
  const merged = mergeActiveFilter({ defaults: DEFAULTS, keyword: {}, override: { pingbineirong: '' } })
  assert.strictEqual(merged.filter.pingbineirong, '')
})

test('非字符串覆盖值被忽略（回默认），keyword 缺省为空串', () => {
  const merged = mergeActiveFilter({ defaults: DEFAULTS, keyword: null, override: { pingbibiaoti: 123 } })
  assert.strictEqual(merged.filter.pingbibiaoti, '默认标题')
  assert.deepStrictEqual(merged.keyword, { zkt_gjc: '' })
})

test('mergeActiveFilter 每次返回新对象，不共享引用', () => {
  const first = mergeActiveFilter({ defaults: DEFAULTS, keyword: { zkt_gjc: 'a' } })
  first.filter.pingbibiaoti = '被改写'
  first.keyword.zkt_gjc = '被改写'
  const second = mergeActiveFilter({ defaults: DEFAULTS, keyword: { zkt_gjc: 'a' } })
  assert.strictEqual(second.filter.pingbibiaoti, '默认标题')
  assert.strictEqual(second.keyword.zkt_gjc, 'a')
  assert.strictEqual(DEFAULTS.pingbibiaoti, '默认标题')
})

// ===== loadFilterRules：缺失 / 合法 / 损坏 / last-known-good =====
test('覆盖文件不存在：source=default、revision=0、filter 为默认深拷贝', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: { zkt_gjc: 'k' } })
  assert.strictEqual(loaded.source, 'default')
  assert.strictEqual(loaded.revision, 0)
  assert.strictEqual(loaded.degraded, false)
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.deepStrictEqual(Object.keys(loaded.filter), [...FILTER_RULE_FIELDS])
  assert.strictEqual(loaded.filter.pingbifenlei, '默认分类')
  assert.strictEqual(loaded.filter.pingbitime, '5')
  assert.strictEqual('bogus' in loaded.filter, false)
  assert.deepStrictEqual(loaded.keyword, { zkt_gjc: 'k' })
  loaded.filter.pingbibiaoti = '就地改写'
  assert.strictEqual(DEFAULTS.pingbibiaoti, '默认标题', '返回值不得与代码默认共享引用')
})

test('合法覆盖文件：source=override 且缺字段回默认', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 7, filter: { pingbibiaoti: '覆盖标题' } })
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: { zkt_gjc: '' } })
  assert.strictEqual(loaded.source, 'override')
  assert.strictEqual(loaded.revision, 7)
  assert.strictEqual(loaded.degraded, false)
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.strictEqual(loaded.filter.pingbibiaoti, '覆盖标题')
  assert.strictEqual(loaded.filter.pingbineirong, '默认内容')
})

test('每次 load 重新读盘（不缓存 activeFilter，只缓存 last-known-good）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 1, filter: { pingbibiaoti: '第一版' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).filter.pingbibiaoti, '第一版')
  writeJson(file, { schema: 1, revision: 2, filter: { pingbibiaoti: '第二版' } })
  const second = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(second.source, 'override')
  assert.strictEqual(second.revision, 2)
  assert.strictEqual(second.filter.pingbibiaoti, '第二版', '第二轮必须读到新文件内容（不得复用上一轮对象）')
})

test('损坏 → 优先 last-known-good（revision 沿用，degraded/lastGoodUsed 标记）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 7, filter: { pingbibiaoti: '好规则' } })
  const good = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(good.source, 'override')
  writeRaw(file, '{ 这不是 JSON')
  const bad = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(bad.source, 'corrupt')
  assert.strictEqual(bad.degraded, true)
  assert.strictEqual(bad.lastGoodUsed, true)
  assert.strictEqual(bad.revision, 7)
  assert.strictEqual(bad.filter.pingbibiaoti, '好规则')
  assert.strictEqual(bad.error.code, 'store_corrupt')
})

test('首次加载即损坏 → 代码默认 + degraded（lastGoodUsed=false）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeRaw(filterRulesPaths(dir).file, '{"schema":2,"revision":1,"filter":{}}')
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.source, 'corrupt')
  assert.strictEqual(loaded.degraded, true)
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.strictEqual(loaded.revision, 0)
  assert.strictEqual(loaded.filter.pingbibiaoti, '默认标题')
  assert.strictEqual(loaded.error.code, 'store_corrupt')
})

test('损坏形态覆盖：坏 JSON / 数组根 / 未知字段 / 非字符串字段 / 控制字符', () => {
  const cases = [
    ['不是 JSON', 'not-json'],
    [JSON.stringify([1, 2]), 'array'],
    [JSON.stringify({ schema: 1, revision: 0, filter: { evil: 'x' } }), 'unknown'],
    [JSON.stringify({ schema: 1, revision: 0, filter: { pingbibiaoti: 5 } }), 'not-string'],
    [JSON.stringify({ schema: 1, revision: 0, filter: { pingbibiaoti: 'a\u0000b' } }), 'control']
  ]
  for (const [text, label] of cases) {
    resetStoreStateForTests()
    const dir = makeDir()
    writeRaw(filterRulesPaths(dir).file, text)
    const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
    assert.strictEqual(loaded.source, 'corrupt', `${label} 应判损坏`)
    assert.strictEqual(loaded.lastGoodUsed, false, `${label} 不应有 lastGood`)
  }
})

test('resetStoreStateForTests 清空 last-known-good', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 3, filter: { pingbibiaoti: '好规则' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source, 'override')
  resetStoreStateForTests()
  writeRaw(file, 'broken')
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.strictEqual(loaded.revision, 0)
  assert.strictEqual(loaded.filter.pingbibiaoti, '默认标题')
})

test('非普通文件（目录）不抛穿，按损坏降级', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  fs.mkdirSync(filterRulesPaths(dir).file)
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.source, 'corrupt')
  assert.strictEqual(loaded.degraded, true)
})

// ===== 生效快照写读往返 =====
test('writeAppliedSnapshot 写入 0600 快照，readAppliedSnapshot 可读回', () => {
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  const wrote = writeAppliedSnapshot({
    cacheDir: dir,
    filter: { pingbibiaoti: 'x', pingbineirong: 'y', bogus: 'no' },
    keyword: { zkt_gjc: 'k' },
    revision: 3,
    source: 'override',
    hash: 'abc123'
  })
  assert.strictEqual(wrote, true)
  assert.strictEqual(fs.statSync(paths.applied).mode & 0o777, 0o600, '生效快照必须是 0600')
  const read = readAppliedSnapshot(dir)
  assert.strictEqual(read.status, 'ok')
  assert.strictEqual(read.snapshot.schema, FILTER_RULES_SCHEMA)
  assert.strictEqual(read.snapshot.revision, 3)
  assert.strictEqual(read.snapshot.source, 'override')
  assert.strictEqual(read.snapshot.hash, 'abc123')
  assert.match(read.snapshot.appliedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepStrictEqual(Object.keys(read.snapshot.filter), [...FILTER_RULE_FIELDS])
  assert.strictEqual(read.snapshot.filter.pingbibiaoti, 'x')
  assert.strictEqual('bogus' in read.snapshot.filter, false)
  assert.deepStrictEqual(read.snapshot.keyword, { zkt_gjc: 'k' })
  // 落盘内容与返回值一致（避免「读回的是缓存」假通过）
  assert.deepStrictEqual(readJson(paths.applied), read.snapshot)
})

test('readAppliedSnapshot：missing / invalid / ioError 三态', () => {
  const dir = makeDir()
  assert.strictEqual(readAppliedSnapshot(dir).status, 'missing')
  const paths = filterRulesPaths(dir)
  writeRaw(paths.applied, 'not-json')
  assert.strictEqual(readAppliedSnapshot(dir).status, 'invalid')
  writeRaw(paths.applied, JSON.stringify({ schema: 2, revision: 0, appliedAt: 'x', filter: {}, keyword: {} }))
  assert.strictEqual(readAppliedSnapshot(dir).status, 'invalid')
  fs.rmSync(paths.applied)
  fs.mkdirSync(paths.applied)
  assert.strictEqual(readAppliedSnapshot(dir).status, 'ioError')
})

// ===== 路径 helper =====
test('filterRulesPaths 固定文件名与备份名，备份 revision 防路径穿越', () => {
  const base = path.join(tmp, 'paths-base')
  const paths = filterRulesPaths(base)
  assert.strictEqual(paths.file, path.join(base, 'filter-rules.json'))
  assert.strictEqual(paths.applied, path.join(base, 'filter-rules.applied.json'))
  assert.strictEqual(paths.audit, path.join(base, 'filter-rules.audit.ndjson'))
  assert.strictEqual(paths.lock, path.join(base, 'filter-rules.lock'))
  assert.strictEqual(paths.backupFor(7), path.join(base, 'filter-rules.bak.7.json'))
  assert.strictEqual(paths.backupFor(0), path.join(base, 'filter-rules.bak.0.json'))
  for (const bad of ['../../evil', -3, 1.5, null, '7']) {
    const backup = paths.backupFor(bad)
    assert.strictEqual(backup, path.join(base, 'filter-rules.bak.0.json'), `非法 revision ${String(bad)} 必须归 0`)
    assert.strictEqual(path.dirname(backup), base, '备份路径不得逃出 cacheDir')
  }
})

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
