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
const { spawnSync } = require('node:child_process')
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
// C10-019：直调收紧入口的用例需要拿到函数本身（走 loadFilterRules 的集成路径看不到收紧分支）。
const { enforceOwnerOnlyMode } = require('./scripts/owner-only-mode')

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
// 缺 re2 的真实形态：compileUserRegex 恒返回 null——xbk_function_v3 在无 re2 时**不回退 V8**
// （见其 :52 注释），用户过滤正则一律编译失败。旧夹具用的是真 `new RegExp`，于是「无 re2」路径
// 其实从来没被走到：任何 compileOk 都成功，C9-010 那类「唯一可用规则被误拒」的缺陷在测试里不可见。
const noRe2Deps = { ...deps, re2Available: false, compileUserRegex: () => null }

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
  let result
  try {
    result = fn()
  } catch (e) {
    fail++
    process.exitCode = 1
    console.error(`  ❌ ${name}: ${e.message}`)
    return
  }
  // C5-023：本 harness 是同步的。返回 Promise 的用例此前会被直接记成通过——pass++ 与 ✅ 先执行，
  // 断言失败/异常在微任务里才抛（可能发生在「结果：N 通过 / 0 失败」打印之后），于是出现「先记绿、
  // 随后在微任务里炸」的假绿。异步用例的结果本 harness 无法判定，故当场判红而不是乐观记过。
  if (result && typeof result.then === 'function') {
    fail++
    process.exitCode = 1
    if (typeof result.catch === 'function') result.catch(() => {}) // 挂个 handler，避免 unhandledRejection 打崩进程掩盖这条结论
    console.error(`  ❌ ${name}: 用例返回 Promise——同步 harness 无法判定异步结果（请改成同步用例）`)
    return
  }
  pass++
  console.log(`  ✅ ${name}`)
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
// 排序比较器一律走显式 code-unit（与 run_mutation.js:247 / test_mutation_ranges.js 的 byCodeUnit 同口径）：
// 不依赖 locale，也不触发 Array#sort 默认的「字符串化后比较」。
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

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

test('pingbitime 天数必须是整数（A5：小数会被运行期 floor，不得静默接受）', () => {
  for (const bad of ['1.9', '0.5', '1e-1', '分类A###1.9']) {
    expectError(validateFilterRules({ revision: 0, filter: { pingbitime: bad } }, deps), 'pingbitime', 'invalid_number', `小数 ${bad}`)
  }
  for (const okValue of ['5', '0', '3650000', '分类A###5']) {
    const result = validateFilterRules({ revision: 0, filter: { pingbitime: okValue } }, deps)
    assert.strictEqual(result.ok, true, `整数 ${okValue} 应通过：${JSON.stringify(result.errors)}`)
  }
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

test('缺 re2：仅 pingbitime 规则必须放行（闸门 3 的豁免不得被 simpleRules 编译循环推翻）', () => {
  // 运行期 pingbitime 用 Number 解析天数、不需要正则引擎，是缺 re2 环境里唯一还能用的规则。
  // 闸门 3 的 hasRegexTarget 已为「仅时间规则」放行，但紧随其后的 simpleRules 编译循环漏了同一
  // 守卫（ruleLines 的循环有 `rule.field !== 'pingbitime'`）⇒ 恒 null 的 compileOk 把它误判成
  // invalid_value_regex，用户唯一能用的规则被拒。
  const result = validateFilterRules({ revision: 0, filter: { pingbitime: '5' } }, noRe2Deps)
  assert.strictEqual(result.ok, true, `仅时间规则在缺 re2 环境必须放行，实际 ${JSON.stringify(result.errors)}`)
  // 其它字段留空时同属「仅时间规则」（旧断言在真 null 编译器下变红的那条形态）
  assert.strictEqual(validateFilterRules({ revision: 0, filter: { pingbibiaoti: '', pingbitime: '5' } }, noRe2Deps).ok, true,
    '空字段不参与编译，仅时间规则仍必须放行')
  // 反向断言：一旦带上任何真正要编译的字段，缺 re2 仍必须 engine_unavailable（豁免不得外溢）
  expectError(validateFilterRules({ revision: 0, filter: { pingbitime: '5', pingbibiaoti: '屏蔽' } }, noRe2Deps),
    'filter', 'engine_unavailable', '含正则字段时仍要求 RE2')
  // 分类###天数 形态里的「分类」本身就是正则，缺 re2 时仍必须要求引擎（豁免只覆盖纯天数规则）
  expectError(validateFilterRules({ revision: 0, filter: { pingbitime: '5###7' } }, noRe2Deps),
    'filter', 'engine_unavailable', 'pingbitime 带分类正则时仍要求 RE2')
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
  // C5-072：比较必须用副本 + 显式 code-unit 比较器。原实现 `result.wideMatch.sort()` 有两个问题：
  // ① 就地排序改写 SUT 返回的数组（下次有人在这条用例后面断言真实顺序就会看到被排过的值）；
  // ② Array#sort 默认把元素字符串化比较，对非字符串元素是隐式的 toString 契约。
  // 顺序断言仍按真实值做：wideMatch 的插入序（[biaoti, zhanxianbiaoti, neirong]）不得被测试改写。
  assert.deepStrictEqual([...result.wideMatch].sort(byCodeUnit), ['pingbibiaoti', 'pingbineirong', 'zhanxianbiaoti'])
  assert.deepStrictEqual(result.wideMatch, ['pingbibiaoti', 'zhanxianbiaoti', 'pingbineirong'],
    'SUT 返回的 wideMatch 不得被测试就地排序改写')
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

test('覆盖文件 revision=0 合法：不得判成损坏（revision 0 是写侧默认值）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 0, filter: { pingbibiaoti: '零号覆盖' } })
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.source, 'override', `revision=0 的覆盖文件必须生效，实际 source=${loaded.source}`)
  assert.strictEqual(loaded.revision, 0)
  assert.strictEqual(loaded.degraded, false)
  assert.strictEqual(loaded.filter.pingbibiaoti, '零号覆盖')
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

// ===== Sourcery #256 评审修复：A1 读路径深度校验 / A2 lastGood 分目录 / A3 权限收紧 / A4 删除即作废 =====
test('A1 手工编辑的非法正则 → 深度校验判损坏，且不污染 last-known-good', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 11, filter: { pingbibiaoti: '好规则' } })
  const good = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps })
  assert.strictEqual(good.source, 'override')
  assert.strictEqual(good.revision, 11)

  // 结构完全合法、正则非法——手工编辑覆盖文件最容易产生的形态
  writeJson(file, { schema: 1, revision: 12, filter: { pingbibiaoti: '(' } })
  const bad = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps })
  assert.strictEqual(bad.source, 'corrupt', '非法正则必须判损坏，不能当 override 生效')
  assert.strictEqual(bad.degraded, true)
  assert.strictEqual(bad.lastGoodUsed, true)
  assert.strictEqual(bad.revision, 11, '损坏轮沿用上一次合法 revision')
  assert.strictEqual(bad.filter.pingbibiaoti, '好规则', '损坏轮必须沿用上一次合法规则')
  assert.match(bad.error.message, /pingbibiaoti/, `message 必须带首条错误的 field：${bad.error.message}`)
  assert.match(bad.error.message, /正则无法编译|深度校验/)

  // 嵌套量词同样拦下，且证明 lastGood 仍是 revision 11（坏文件没有覆盖它）
  writeJson(file, { schema: 1, revision: 13, filter: { pingbibiaoti: '(a+)+' } })
  const bad2 = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps })
  assert.strictEqual(bad2.source, 'corrupt')
  assert.strictEqual(bad2.revision, 11, '坏文件不得成为新的 last-known-good')
  assert.strictEqual(bad2.filter.pingbibiaoti, '好规则')

  // 修好文件后恢复正常（lastGood 不被污染，也不会卡在降级态）
  writeJson(file, { schema: 1, revision: 14, filter: { pingbibiaoti: '修好了' } })
  const fixed = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps })
  assert.strictEqual(fixed.source, 'override')
  assert.strictEqual(fixed.revision, 14)
})

test('A1 深度校验只在 deps 完整且引擎可用时执行（缺依赖仍能读合法文件）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 1, filter: { pingbibiaoti: '(' } })

  // 不传 deps（console/qinglong 现状）：保持只做结构校验的既有契约
  assert.strictEqual(
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source,
    'override',
    '未注入 deps 时不得新增深度校验（否则老调用方全量降级）'
  )
  // 传了 deps 但 RE2 不可用：compileUserRegex 恒 null，深校验会把合法文件全判坏 ⇒ 必须跳过
  assert.strictEqual(
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps: noRe2Deps }).source,
    'override',
    '无 RE2 时必须跳过深度校验'
  )
  assert.strictEqual(
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps: { ...deps, re2Available: undefined, isRe2Available: () => false } }).source,
    'override',
    'isRe2Available()=false 时同样跳过'
  )

  // 首次加载即含非法正则（无 lastGood）→ 回代码默认，不得把坏规则当唯一规则
  resetStoreStateForTests()
  const fresh = makeDir()
  writeJson(filterRulesPaths(fresh).file, { schema: 1, revision: 2, filter: { pingbibiaoti: '(' } })
  const loaded = loadFilterRules({ cacheDir: fresh, defaults: DEFAULTS, keyword: {}, deps })
  assert.strictEqual(loaded.source, 'corrupt')
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.strictEqual(loaded.revision, 0)
  assert.strictEqual(loaded.filter.pingbibiaoti, '默认标题')
})

test('A2 last-known-good 按 cacheDir 分槽：dirB 损坏不得套用 dirA 的规则', () => {
  resetStoreStateForTests()
  const dirA = makeDir()
  const dirB = makeDir()
  writeJson(filterRulesPaths(dirA).file, { schema: 1, revision: 4, filter: { pingbibiaoti: 'A目录规则' } })
  const loadedA = loadFilterRules({ cacheDir: dirA, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loadedA.source, 'override')
  assert.strictEqual(loadedA.filter.pingbibiaoti, 'A目录规则')

  writeRaw(filterRulesPaths(dirB).file, '{ 坏 JSON')
  const loadedB = loadFilterRules({ cacheDir: dirB, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loadedB.source, 'corrupt')
  assert.strictEqual(loadedB.lastGoodUsed, false, 'dirB 从未读过合法文件，不得借用 dirA 的 lastGood')
  assert.strictEqual(loadedB.revision, 0, 'revision 也不得借用 dirA 的 4')
  assert.strictEqual(loadedB.filter.pingbibiaoti, '默认标题', 'dirB 必须回代码默认，不能出现 dirA 的过滤面')

  // 分槽不等于取消 lastGood：dirA 自己的降级仍然生效
  writeRaw(filterRulesPaths(dirA).file, 'broken')
  const degradedA = loadFilterRules({ cacheDir: dirA, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(degradedA.source, 'corrupt')
  assert.strictEqual(degradedA.lastGoodUsed, true)
  assert.strictEqual(degradedA.filter.pingbibiaoti, 'A目录规则')
})

test('A3 覆盖文件权限过宽（0644）→ 读后收紧为 0600 并正常生效', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 2, filter: { pingbibiaoti: '宽权限规则' } })
  // 由 0600 叠加组/其他读位构造「历史遗留的过宽权限」：不写字面量 0644（Sonar S2612）。
  const widened = (fs.statSync(file).mode & 0o777) | 0o044
  fs.chmodSync(file, widened)
  assert.notStrictEqual(widened & 0o077, 0, '前置：文件当前确实带 group/other 位')

  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.source, 'override')
  assert.strictEqual(loaded.filter.pingbibiaoti, '宽权限规则')
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'group/other 位必须在读取后收紧掉')
})

test('A3 权限过宽且无法收紧 → 按损坏处理并说明原因（不改用权限不可控的规则）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 5, filter: { pingbibiaoti: '权限坏' } })
  const widened = (fs.statSync(file).mode & 0o777) | 0o044
  fs.chmodSync(file, widened)
  // 模块持有的是同一个 fs 模块对象，方法查找发生在调用时 ⇒ 临时替换即可覆盖收紧失败分支。
  // 注入点必须是 fchmodSync：C10-019 返工后收紧按已校验的 fd 走 fchmod，按路径的 chmodSync
  // 已经不再被调用——继续拦 chmodSync 会让这条用例变成「什么都没拦到也照绿」。
  const realFchmod = fs.fchmodSync
  fs.fchmodSync = () => {
    const err = new Error('EPERM: operation not permitted')
    err.code = 'EPERM'
    throw err
  }
  let loaded
  try {
    loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  } finally {
    fs.fchmodSync = realFchmod
  }
  assert.strictEqual(loaded.source, 'corrupt')
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.match(loaded.error.message, /权限过宽/, `message 必须说明权限过宽：${loaded.error.message}`)
  assert.match(loaded.error.message, /EPERM|无法收紧/, `message 必须说明收紧失败：${loaded.error.message}`)
  assert.strictEqual(fs.statSync(file).mode & 0o777, widened, '收紧失败时文件权限保持原样（本模块不假装成功）')
})

test('A3/C10-019 覆盖文件是符号链接 → 拒绝收紧，绝不改链接目标（旧实现按路径 chmod 会落到 victim 上）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const victim = path.join(dir, 'victim.json')
  writeJson(victim, { schema: 1, revision: 3, filter: { pingbibiaoti: '链接目标规则' } })
  // 构造「victim 权限过宽」：收紧若跟随链接，就会把 victim 改到 0600（= 改了别人的文件）。
  const widened = (fs.statSync(victim).mode & 0o777) | 0o044
  fs.chmodSync(victim, widened)
  const file = filterRulesPaths(dir).file
  fs.symlinkSync(victim, file)

  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.source, 'corrupt', '符号链接不是可用的覆盖文件（读路径 O_NOFOLLOW 判 unsafe）')
  assert.strictEqual(loaded.lastGoodUsed, false)
  assert.match(String(loaded.error && loaded.error.message), /不可读|符号链接|非普通文件/,
    `必须说明覆盖文件不可用：${loaded.error && loaded.error.message}`)
  assert.strictEqual(fs.statSync(victim).mode & 0o777, widened,
    '链接目标的权限必须原样保留——旧实现 stat/chmod 都跟随链接，会把 victim 收紧成 0600')
})

// 上面那条走的是 loadFilterRules：静态链接在 readSafeTextResult 就判 unsafe 并直接 corrupt，
// enforceOwnerOnlyMode 从未被调用 —— 它守的是「读」这一侧，把收紧改回 chmodSync(file) 也照样全绿。
// 下面两条直调收紧入口，才真正钉住「改的是链接目标还是已校验的 inode」。
test('C10-019 直调 enforceOwnerOnlyMode：路径本身是符号链接 → ok:false，链接目标权限不变', () => {
  const dir = makeDir()
  const victim = path.join(dir, 'victim.json')
  writeJson(victim, { schema: 1, revision: 3, filter: { pingbibiaoti: '链接目标规则' } })
  const widened = (fs.statSync(victim).mode & 0o777) | 0o044
  fs.chmodSync(victim, widened)
  const link = path.join(dir, 'link.json')
  fs.symlinkSync(victim, link)

  const result = enforceOwnerOnlyMode(link)
  assert.strictEqual(result.ok, false, '末级是符号链接：不是可收紧的对象，必须拒绝')
  assert.match(result.message, /符号链接|非普通文件/, `必须说明拒绝原因：${result.message}`)
  assert.strictEqual(fs.statSync(victim).mode & 0o777, widened,
    '链接目标的权限必须原样保留——按路径 chmod 在这一路上会把 victim 改成 0600')
})

test('C10-019 直调 enforceOwnerOnlyMode：校验通过后路径被换成符号链接 → 收紧只落在已校验的 inode 上，链接目标不动', () => {
  const dir = makeDir()
  const file = path.join(dir, 'filter-rules.json')
  const victim = path.join(dir, 'victim.json')
  const parked = path.join(dir, 'parked.json')
  writeJson(file, { schema: 1, revision: 1, filter: { pingbibiaoti: '待收紧' } })
  writeJson(victim, { schema: 1, revision: 2, filter: { pingbibiaoti: '别人的文件' } })
  const fileMode = (fs.statSync(file).mode & 0o777) | 0o044
  fs.chmodSync(file, fileMode)
  const victimMode = (fs.statSync(victim).mode & 0o777) | 0o044
  fs.chmodSync(victim, victimMode)

  // 精确复现「校验通过之后、写入之前」这个窗口：真实的 lstat 结果照原样交回（校验看到的仍是
  // 刚打开的那个普通文件，dev/ino 都对得上），交回之前把路径换成指向 victim 的链接。
  const realLstat = fs.lstatSync
  let swapped = false
  fs.lstatSync = function (target, options) {
    if (swapped || target !== file) return realLstat.call(fs, target, options)
    swapped = true
    const stat = realLstat.call(fs, target, options)
    fs.renameSync(file, parked)
    fs.symlinkSync(victim, file)
    return stat
  }
  let result
  try {
    result = enforceOwnerOnlyMode(file)
  } finally {
    fs.lstatSync = realLstat
  }
  assert.strictEqual(swapped, true, '前置：替换窗口必须真的被执行到（否则这条用例什么都没测）')
  assert.strictEqual(fs.statSync(victim).mode & 0o777, victimMode,
    '链接目标（victim）权限必须原样保留——按路径 chmod 会跟随链接把 victim 改成 0600，还只报「复检仍为 0664」')
  assert.strictEqual(fs.statSync(parked).mode & 0o777, 0o600,
    '收紧必须落在已经校验过的那份 inode 上（路径被搬走后它仍在同一 inode）')
  assert.deepStrictEqual(result, { ok: true, tightened: true },
    '收紧对象是已校验的 fd，写入必然作用在它上面 ⇒ 成功；按路径改的实现会返回「复检仍为 0664」')
})

test('A4 文件删除即作废本目录 lastGood：后续畸形文件不得复活旧规则', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 9, filter: { pingbibiaoti: '旧规则' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source, 'override')

  fs.rmSync(file)
  const defaulted = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(defaulted.source, 'default', '删文件 = 用户恢复代码默认')
  assert.strictEqual(defaulted.filter.pingbibiaoti, '默认标题')

  // 之后又出现畸形文件：必须回代码默认，不得把删除前那份规则复活
  writeRaw(file, '不是 JSON')
  const bad = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(bad.source, 'corrupt')
  assert.strictEqual(bad.lastGoodUsed, false, '删除已作废 lastGood，畸形文件不得把它复活')
  assert.strictEqual(bad.revision, 0)
  assert.strictEqual(bad.filter.pingbibiaoti, '默认标题')
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

// C5-047：writeAppliedSnapshot 的返回值是「快照到底有没有写成」的唯一信号（xbk_app 用它打 warn + run log），
// 但此前全文件只有一条 `strictEqual(wrote, true)` 正向断言 —— 把实现改成恒 true，整套仍然全绿
// （本条已用变异探针实测）。下面两条把失败分支钉死：返回 false、不抛、不留半成品。
test('writeAppliedSnapshot 失败分支：applied 路径被目录占位 → 返回 false、不抛、不改占位', () => {
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  fs.mkdirSync(paths.applied) // 目标路径是目录：writeAtomic 的 isRegularOrMissing 拒绝写入
  let wrote
  assert.doesNotThrow(() => {
    wrote = writeAppliedSnapshot({ cacheDir: dir, filter: { pingbibiaoti: 'x' }, keyword: {}, revision: 1, source: 'override', hash: 'h' })
  }, '写不进去属于可预期失败，必须返回 false 而不是抛错（调用方按布尔处理）')
  assert.strictEqual(wrote, false, '快照没写成必须返回 false（恒 true 的实现会让调用方以为已落盘）')
  assert.strictEqual(fs.statSync(paths.applied).isDirectory(), true, '失败时不得删除/替换占位目录')
  assert.strictEqual(readAppliedSnapshot(dir).status, 'ioError', '读回必须如实报告 ioError，不得假装有一份快照')
})

test('writeAppliedSnapshot 失败分支：建临时文件报 EACCES → 返回 false 且不留半成品快照', () => {
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  // 用注入的 EACCES 而不是 chmod 0500：以 root 跑门禁时目录权限拦不住写入，夹具会假绿（甚至断言失败）。
  // writeAtomic 的临时文件名形如 `<applied>.<pid>.<ts>.<rand>.tmp`，只拦这一条路径，其余 fs 调用照旧。
  const realOpen = fs.openSync
  fs.openSync = function (target, ...args) {
    const name = String(target)
    if (name.startsWith(paths.applied + '.') && name.endsWith('.tmp')) {
      const err = new Error('EACCES: permission denied, open ' + name)
      err.code = 'EACCES'
      throw err
    }
    return realOpen.call(this, target, ...args)
  }
  let wrote
  try {
    wrote = writeAppliedSnapshot({ cacheDir: dir, filter: { pingbibiaoti: 'x' }, keyword: {}, revision: 2, source: 'override', hash: 'h' })
  } finally {
    fs.openSync = realOpen
  }
  assert.strictEqual(wrote, false, 'EACCES 下必须返回 false（不得把失败报成成功）')
  assert.deepStrictEqual(fs.readdirSync(dir), [], '写入失败不得留下快照或临时文件')
  assert.strictEqual(readAppliedSnapshot(dir).status, 'missing', '失败后状态仍应是 missing，而不是一份可疑的快照')
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
  assert.strictEqual(paths.draft, path.join(base, 'filter-rules.draft.json'))
  assert.strictEqual(paths.lock, path.join(base, 'filter-rules.lock'))
  assert.strictEqual(paths.backupFor(7), path.join(base, 'filter-rules.bak.7.json'))
  assert.strictEqual(paths.backupFor(0), path.join(base, 'filter-rules.bak.0.json'))
  for (const bad of ['../../evil', -3, 1.5, null, '7']) {
    const backup = paths.backupFor(bad)
    assert.strictEqual(backup, path.join(base, 'filter-rules.bak.0.json'), `非法 revision ${String(bad)} 必须归 0`)
    assert.strictEqual(path.dirname(backup), base, '备份路径不得逃出 cacheDir')
  }
})

// C5-023 自测接缝：harness 的「异步用例必须判红」只能在子进程里证明（本进程里注入一条失败用例会
// 直接把整套变红）。探针子进程用 XBK_FILTER_STORE_ASYNC_PROBE=1 注入两条用例，见下方注入块。
if (process.env.XBK_FILTER_STORE_ASYNC_PROBE !== '1') {
  test('harness：返回 Promise 的用例必须当场判红，不得先记通过再在微任务里抛（C5-023，子进程实跑）', () => {
    const probe = spawnSync(process.execPath, [__filename], {
      encoding: 'utf8',
      cwd: __dirname,
      env: { ...process.env, XBK_FILTER_STORE_ASYNC_PROBE: '1' }
    })
    const both = (probe.stdout || '') + (probe.stderr || '')
    assert.strictEqual(probe.status, 1,
      `异步用例必须让探针以 1 退出（实际 ${probe.status}）：` + both.slice(-600))
    assert.match(both, /❌ 💥 探针：异步用例（返回 rejected Promise）/,
      '异步用例必须被 harness 当场记失败并打印 ❌：' + both.slice(-600))
    assert.ok(!both.includes('✅ 💥 探针：异步用例'),
      '异步用例不得被记成通过（旧 harness 先 pass++ 再让 Promise 在微任务里抛）：' + both.slice(-600))
    assert.ok(probe.stdout.includes('PROBE-AFTER-RAN'),
      '异步用例之后的同步用例必须照跑（判红不得靠把进程打崩来吞掉后续用例）：' + both.slice(-600))
    assert.ok(!/ERR_UNHANDLED_REJECTION|UnhandledPromiseRejection/.test(both),
      'harness 必须自己接管这个 Promise（否则 unhandledRejection 会先打崩进程、掩盖真实结论）：' + both.slice(-600))
    // 汇总行形如 `=== 结果：50 通过 / 1 失败 ===`。数字收敛成 1..9 位并锚在「数字串起点」
    // （`(?:^|\D)`）：无界 `\d+` 的回退步数随数字串长度增长（S5852），有界后每个起点最多 9 次；
    // 加了起点锚，十位计数不会从第 2 位起被切出 9 位（那会静默读成小数字），而是整条不命中 ⇒
    // 下一行 assert.ok(summary) 当场判红。两条口径断言（失败≥1 / 通过≥49）一字未动。
    const summary = probe.stdout.match(/(?:^|\D)(\d{1,9}) 通过 \/ (\d{1,9}) 失败/)
    assert.ok(summary, '探针必须有汇总行：' + both.slice(-600))
    const [, passed, failed] = summary.map(Number)
    assert.ok(failed >= 1, `汇总必须记下这条失败（实得 ${failed}）`)
    assert.ok(passed >= 49, `其余同步用例必须照常通过（实得 ${passed}）`)
  })
}
if (process.env.XBK_FILTER_STORE_ASYNC_PROBE === '1') {
  test('💥 探针：异步用例（返回 rejected Promise）', () => Promise.reject(new Error('probe-async')))
  test('探针：异步用例之后的同步用例', () => { console.log('PROBE-AFTER-RAN') })
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
