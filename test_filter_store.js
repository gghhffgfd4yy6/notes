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
  LASTGOOD_MAX_BYTES,
  filterRulesPaths,
  validateFilterRules,
  mergeActiveFilter,
  loadFilterRules,
  writeLastGoodFile,
  readLastGood,
  writeAppliedSnapshot,
  appliedLastGoodUsed,
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
test('v3.391 保存时按行自动去重（大小写/首尾空格差异算同一条，保留首次原样）', () => {
  const filter = {
    pingbibiaoti: '牙膏\n车厘子\n牙膏\n\n 牙膏 \nZDM\nzdm',
    pingbineirong: 'a###分类A\na###分类A\nb###分类B'
  }
  const result = validateFilterRules({ schema: 1, revision: 0, filter }, deps)
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
  assert.strictEqual(result.value.pingbibiaoti, '牙膏\n车厘子\nZDM', '重复行只留首次出现的原样文本，空行丢弃')
  assert.strictEqual(result.value.pingbineirong, 'a###分类A\nb###分类B', '### 多行规则同样按行去重')
  assert.deepStrictEqual(result.deduped, { pingbibiaoti: 3, pingbineirong: 1 }, '按字段回报去掉的条数')
})

test('v3.391 无重复时 deduped 为空对象，value 与入参逐字一致', () => {
  const filter = { pingbibiaoti: '牙膏\n牙刷', pingbitime: '8' }
  const result = validateFilterRules({ schema: 1, revision: 0, filter }, deps)
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
  assert.deepStrictEqual(result.deduped, {})
  assert.strictEqual(result.value.pingbibiaoti, '牙膏\n牙刷')
  assert.strictEqual(result.value.pingbitime, '8')
})

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

test('C9-012 整份规则文件超过读端 256 KiB 上限必须拒绝（单字段 16000 上限挡不住多字段累积）', () => {
  // 11 个字段各 16000 个中文字（UTF-8 3 字节/字）⇒ 约 528 KB，远超读端 FILTER_RULES_MAX_BYTES。
  // 旧实现只限单字段：保存返回 200，下一轮读盘整份判 tooLarge 被丢弃（用户看到「保存成功但不生效」）。
  const filter = {}
  for (const field of FILTER_RULE_FIELDS) {
    if (field === 'pingbitime') continue
    filter[field] = '中'.repeat(16000)
  }
  const result = validateFilterRules({ schema: 1, revision: 0, filter }, deps)
  assert.strictEqual(result.ok, false, '整份超过 256 KiB 必须拒绝保存')
  const err = result.errors.find(e => e.code === 'too_large')
  assert.ok(err, `应给出 too_large 错误码：${JSON.stringify(result.errors)}`)
  assert.strictEqual(err.field, 'filter', '字段归属必须是 filter（整份而非某一字段超限）')
  // 文案形态「<数字> 字节」用逐字符扫描判定：Sonar javascript:S8786 把 `\d+ 字节` 判成可回溯
  // （量词 + 字面量），而这条判据需要的只是「' 字节' 前面紧邻一位数字」；扫描与 /\d+ 字节/ 等价
  // （多个 ' 字节' 出现处逐个看），无回溯面，代价 O(文案长度)。
  // 循环条件是纯终止条件（`at >= 0`）：offset 0 是**有效命中位置**，兼作终止条件会让
  // ' 字节 70000 字节' 这种「首个命中在开头」的文案直接退出、漏掉后面的数字。
  const hasByteCount = (text) => {
    const unit = ' 字节'
    for (let at = text.indexOf(unit); at >= 0; at = text.indexOf(unit, at + unit.length)) {
      const prev = text[at - 1]
      if (prev >= '0' && prev <= '9') return true
    }
    return false
  }
  assert.ok(hasByteCount(err.message) && err.message.includes(String(256 * 1024)),
    `错误文案必须给出实际字节数与上限：${err.message}`)
  // 与 /\d+ 字节/ 的对拍：两条正向（含 offset 0 的边界）+ 一条反向控制，逐面与正则对齐。
  // ① offset 0：旧实现 `at > 0` 把 0 当「没找到」退出，' 字节 70000 字节' 被判 false。
  assert.strictEqual(hasByteCount(' 字节 70000 字节'), true,
    '首个「 字节」在 offset 0 时必须继续看后面的命中（at > 0 会漏成 false，而 /\\d+ 字节/ 为 true）')
  assert.strictEqual(hasByteCount('整份 70000 字节，上限 65536 字节'), true,
    '普通文案（数字紧邻「 字节」）必须命中')
  assert.strictEqual(hasByteCount('没有数字的 字节 文案'), false,
    '「 字节」前面没有数字时不得误判（防「一律 true」让上面两条失去鉴别力）')
  // 对照：把字段砍到总量在预算内就必须通过（防「一律拒绝」让上面失去鉴别力）
  const small = { pingbibiaoti: '中'.repeat(16000), pingbineirong: '中'.repeat(16000) }
  const okSmall = validateFilterRules({ schema: 1, revision: 0, filter: small }, deps)
  assert.strictEqual(okSmall.ok, true, JSON.stringify(okSmall.errors))
})

test('C9-012 读路径不得把「已可读」的合法覆盖文件按闸门 5 判 corrupt（(256 KiB-32, 256 KiB] 区间）', () => {
  // 旧版控制台 body 上限 256 KiB、落盘形状只多约 13 字节包装 ⇒ 该区间的覆盖文件是真实存量。
  // 闸门 5 落在 validateFilterRules 里，读路径的 deepValidationError 复用同一函数后：
  // 65505..65535 这些「readSafeTextResult 读得到、结构也合法」的文件被重新序列化量字节 ⇒ too_large
  // ⇒ corrupt，生产每轮降级、规则静默不生效。这里按落盘字节数逐个断言 source 必须为 override。
  resetStoreStateForTests()
  const buildAtBytes = (target) => {
    const filter = {}
    const fields = FILTER_RULE_FIELDS.filter(f => f !== 'pingbitime')
    for (const f of fields) filter[f] = ''
    const size = () => Buffer.byteLength(JSON.stringify({ schema: 1, revision: 0, filter }), 'utf8')
    let remaining = target - size()
    for (const f of fields) {
      const cn = Math.min(16000, Math.floor(remaining / 3))
      filter[f] = '线'.repeat(cn)
      remaining -= cn * 3
      const ascii = Math.min(16000 - cn, remaining)
      filter[f] += 'a'.repeat(ascii)
      remaining -= ascii
      if (remaining === 0) break
    }
    assert.strictEqual(size(), target, `夹具必须恰为 ${target} 字节`)
    return filter
  }
  for (const target of [262113, 262130, 262144]) {
    const dir = makeDir()
    const file = filterRulesPaths(dir).file
    const filter = buildAtBytes(target)
    writeJson(file, { schema: 1, revision: 3, filter })
    assert.strictEqual(fs.statSync(file).size, target, `夹具文件字节数必须恰为 ${target}`)
    const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, deps })
    assert.strictEqual(loaded.source, 'override',
      `${target} 字节的可读合法覆盖文件必须照常生效：${JSON.stringify(loaded.error || {})}`)
    assert.strictEqual(loaded.degraded, false)
    assert.strictEqual(loaded.revision, 3)
  }
  // 对照 1：同一份内容走**保存**路径仍必须被闸门 5 拒绝（不得借读路径放行「保存后下轮必被丢弃」的内容）
  const tooBig = validateFilterRules({ schema: 1, revision: 3, filter: buildAtBytes(262130) }, deps)
  assert.strictEqual(tooBig.ok, false)
  assert.ok(tooBig.errors.some(e => e.code === 'too_large'), `保存路径必须仍拒绝：${JSON.stringify(tooBig.errors)}`)
  // 对照 2：真正超过读端 256 KiB 的覆盖文件仍按 tooLarge 判 corrupt（读路径不放松读端上限）
  const overDir = makeDir()
  writeRaw(filterRulesPaths(overDir).file, JSON.stringify({ schema: 1, revision: 4, filter: buildAtBytes(262145) }))
  const over = loadFilterRules({ cacheDir: overDir, defaults: DEFAULTS, keyword: {}, deps })
  assert.strictEqual(over.source, 'corrupt', '超过 256 KiB 的覆盖文件必须仍判损坏（读端上限不变）')
  assert.match(over.error.message, /不可读（tooLarge）/)
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

test('超长字段被拒绝（16000 边界通过 / 16001 拒绝）', () => {
  const okBoundary = validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a'.repeat(16000) } }, deps)
  assert.strictEqual(okBoundary.ok, true, JSON.stringify(okBoundary.errors))
  expectError(validateFilterRules({ revision: 0, filter: { pingbibiaoti: 'a'.repeat(16001) } }, deps), 'pingbibiaoti', 'too_long', '超长')
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

test('C9-019 生效快照 filter/keyword 字段按覆盖文件同口径收紧（非字符串/未知字段即 invalid）', () => {
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  const base = { schema: 1, revision: 1, source: 'override', hash: 'h', appliedAt: '2026-10-18T00:00:00.000Z' }
  const cases = [
    { filter: { pingbibiaoti: 123 }, keyword: {}, why: 'filter 字段是数字' },
    { filter: { pingbibiaoti: { a: 1 } }, keyword: {}, why: 'filter 字段是对象' },
    { filter: { evil: 'x' }, keyword: {}, why: 'filter 含白名单外字段' },
    { filter: { pingbibiaoti: 'x' }, keyword: { zkt_gjc: 42 }, why: 'keyword.zkt_gjc 是数字' },
    { filter: { pingbibiaoti: 'x' }, keyword: { zkt_gjc: ['a'] }, why: 'keyword.zkt_gjc 是数组' }
  ]
  for (const c of cases) {
    writeRaw(paths.applied, JSON.stringify({ ...base, filter: c.filter, keyword: c.keyword }))
    const read = readAppliedSnapshot(dir)
    assert.strictEqual(read.status, 'invalid', `${c.why} 必须判 invalid（不能当合法快照读回）`)
    assert.strictEqual(read.error.code, 'invalid_schema', `${c.why} 的错误码应为 invalid_schema`)
  }
  // 对照：未提供的字段视同空（与 parseStoredRules 一致，不强制补齐 11 个），合法快照照旧 ok
  writeRaw(paths.applied, JSON.stringify({ ...base, filter: { pingbibiaoti: 'x' }, keyword: {} }))
  assert.strictEqual(readAppliedSnapshot(dir).status, 'ok', '缺省字段不得被误判为损坏')
})

// ===== FIFO 探针夹具（F4-2 与 F4-1 的 LKG 读取共用）=====
// 为什么必须借子进程 + timeout：同步 open 阻塞的是整个事件循环，同进程内没有任何超时能打断它；
// 只有外部 `timeout 3` 能证明「进程在 2 秒内自己结束了」——exit=124 就是挂死的证据。
const MKFIFO_CANDIDATES = ['/usr/bin/mkfifo', '/bin/mkfifo', '/usr/local/bin/mkfifo']
const findOnDisk = (candidates) => {
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate } catch (e) { /* 探测失败按不存在 */ }
  }
  return ''
}
const MKFIFO = findOnDisk(MKFIFO_CANDIDATES)
const TIMEOUT_BIN = findOnDisk(['/usr/bin/timeout', '/bin/timeout'])
const FIFO_SKIP = MKFIFO && TIMEOUT_BIN
  ? null
  : `缺少 ${MKFIFO ? '' : 'mkfifo'}${MKFIFO && !TIMEOUT_BIN ? 'timeout' : ''}（Linux 宿主必须真跑，不得静默当作已验证）`

// 探针统一约定：stdout 一行 JSON；父进程断言 exit≠124 且耗时 < 2s。
function runProbeUnderTimeout (script, dir) {
  const probe = spawnSync(TIMEOUT_BIN, ['3', process.execPath, '-e', script], {
    encoding: 'utf8',
    cwd: __dirname,
    env: { ...process.env, XBK_FIFO_DIR: dir }
  })
  const out = `${probe.stdout || ''}${probe.stderr || ''}`
  assert.notStrictEqual(probe.status, 124,
    `读取在 FIFO 上挂死（timeout 3 强杀、exit=124）：裸 O_RDONLY / readFileSync 阻塞等写者——${out.slice(-600)}`)
  assert.strictEqual(probe.status, 0, `探针必须以 0 正常结束：status=${probe.status} signal=${probe.signal} ${out.slice(-600)}`)
  return JSON.parse(String(probe.stdout).trim().split('\n').pop())
}

function makeFifoDir (name) {
  const dir = makeDir()
  const file = path.join(dir, name)
  require('node:child_process').execFileSync(MKFIFO, [file])
  return { dir, file }
}

// ===== 控制台口径对齐：lastGoodUsed 只认运行侧 applied.json =====
test('applied 快照 lastGoodUsed：写入布尔化、读回保持（旧快照缺省按 false 兼容）', () => {
  const dir = makeDir()
  assert.strictEqual(writeAppliedSnapshot({
    cacheDir: dir, filter: { pingbibiaoti: 'x' }, keyword: {}, revision: 2, source: 'corrupt', hash: 'h', lastGoodUsed: true
  }), true)
  const read = readAppliedSnapshot(dir)
  assert.strictEqual(read.status, 'ok')
  assert.strictEqual(read.snapshot.lastGoodUsed, true, '降级轮必须把 lastGoodUsed=true 落进快照')
  assert.strictEqual(appliedLastGoodUsed(read.snapshot), true)

  // 不传 lastGoodUsed 的调用方（旧代码/其他入口）落盘为 false，不得写成 undefined
  assert.strictEqual(writeAppliedSnapshot({ cacheDir: dir, filter: {}, keyword: {}, revision: 1, source: 'override', hash: 'h' }), true)
  const second = readAppliedSnapshot(dir)
  assert.strictEqual(second.snapshot.lastGoodUsed, false)
  assert.deepStrictEqual(readJson(filterRulesPaths(dir).applied), second.snapshot, '落盘内容与读回一致')

  // 旧快照（v3.405 及以前没有该字段）必须照旧 ok、按 false 处理
  const paths = filterRulesPaths(dir)
  writeRaw(paths.applied, JSON.stringify({
    schema: 1, revision: 3, source: 'corrupt', hash: 'h', appliedAt: '2026-11-09T00:00:00.000Z', filter: {}, keyword: {}
  }))
  const legacy = readAppliedSnapshot(dir)
  assert.strictEqual(legacy.status, 'ok', '缺少 lastGoodUsed 的旧快照不得被判损坏')
  assert.strictEqual(appliedLastGoodUsed(legacy.snapshot), false, '旧快照无该字段 ⇒ 不得声称沿用了 LKG')
})

test('appliedLastGoodUsed 口径：只有 source=corrupt 且 lastGoodUsed=true 才算沿用 LKG', () => {
  assert.strictEqual(appliedLastGoodUsed({ source: 'corrupt', lastGoodUsed: true }), true)
  assert.strictEqual(appliedLastGoodUsed({ source: 'corrupt', lastGoodUsed: false }), false)
  assert.strictEqual(appliedLastGoodUsed({ source: 'override', lastGoodUsed: true }), false,
    'override 轮的 lastGoodUsed 无意义（规则已正常加载），不得据此显示「沿用上次」')
  assert.strictEqual(appliedLastGoodUsed({ source: 'default', lastGoodUsed: true }), false)
  assert.strictEqual(appliedLastGoodUsed({ source: 'corrupt' }), false, '缺字段按 false')
  assert.strictEqual(appliedLastGoodUsed(null), false, '没有快照（missing/不可读）按 false')
  assert.strictEqual(appliedLastGoodUsed([1]), false, '数组不是快照')
})

test('控制台口径：GET /api/config/filter 的 lastGoodUsed 取自 applied，不用控制台进程自己的 LKG', () => {
  // 本 item 只允许跑 test_filter_store/test_filter 两个定向套件（console 套件不在其中），
  // 故这处接线用源码断言锁定：回退成 loaded.lastGoodUsed（控制台进程读文件时的 LKG）即变红。
  const src = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
  const line = src.split('\n').find(l => l.includes('lastGoodUsed:'))
  assert.ok(line, 'GET /api/config/filter 的 payload 必须带 lastGoodUsed 字段（控制台要能展示运行侧降级状态）')
  assert.ok(line.includes('FilterStore.appliedLastGoodUsed(applied)'),
    `lastGoodUsed 必须由 applied 快照推导（运行侧口径）：${line.trim()}`)
  assert.ok(!line.includes('loaded.lastGoodUsed'),
    `不得用控制台进程自己读文件的 lastGoodUsed 冒充运行侧：${line.trim()}`)
})

// ===== F4-3：瞬时读失败（replaced/ioError）重读一次，不折叠成永久降级 =====
// 用替换 storage.readSafeTextResult 的方式注入——真实竞态（另一进程在 fstat 后 rename）不可
// 确定复现；每次注入都记录调用次数，用来区分「重读一次」与「直接降级 / 无脑重试多次」。
function withInjectedReads (statuses, fn) {
  const storageMod = require('./xbk_storage')
  const realRead = storageMod.readSafeTextResult
  const calls = []
  try {
    storageMod.readSafeTextResult = (p, maxBytes, options) => {
      const index = calls.length
      calls.push({ p: String(p), options })
      if (index < statuses.length) {
        const status = statuses[index]
        return status === 'OK_DELEGATE'
          ? realRead(p, maxBytes, options)
          : { status, text: null, error: new Error(`注入 ${status}`) }
      }
      return realRead(p, maxBytes, options)
    }
    const result = fn()
    return { result, calls }
  } finally {
    storageMod.readSafeTextResult = realRead
  }
}

test('F4-3 验收 3：注入 status=replaced → 重读一次成功，degraded=false（50ms 退避）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 3, filter: { pingbibiaoti: '瞬时替换' } })
  const t0 = Date.now()
  const { result, calls } = withInjectedReads(['replaced', 'OK_DELEGATE'], () =>
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }))
  const elapsed = Date.now() - t0
  const ruleReads = calls.filter(c => c.p === filterRulesPaths(dir).file)
  assert.strictEqual(ruleReads.length, 2, `replaced 必须恰好重读一次（实际 ${ruleReads.length} 次）`)
  assert.strictEqual(result.source, 'override', '重读成功后必须正常生效（不得把瞬时失败折叠成降级）')
  assert.strictEqual(result.degraded, false, '重读成功必须 degraded=false（旧实现这里恒为 true）')
  assert.strictEqual(result.lastGoodUsed, false, '本轮是正常加载，不得标记 lastGoodUsed')
  assert.strictEqual(result.filter.pingbibiaoti, '瞬时替换')
  assert.ok(elapsed >= 45, `重读前必须有 50ms 退避（实测 ${elapsed}ms；无退避会让瞬时写者来不及完成）`)
  assert.strictEqual(ruleReads[0].options && ruleReads[0].options.openNonBlocking, true, '重读也必须带 openNonBlocking')
})

test('F4-3 ioError 同口径：重读一次成功即正常生效', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 4, filter: { pingbibiaoti: '瞬时 EIO' } })
  const { result, calls } = withInjectedReads(['ioError', 'OK_DELEGATE'], () =>
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }))
  const ruleReads = calls.filter(c => c.p === filterRulesPaths(dir).file)
  assert.strictEqual(ruleReads.length, 2, `ioError 必须恰好重读一次（实际 ${ruleReads.length} 次）`)
  assert.strictEqual(result.source, 'override')
  assert.strictEqual(result.degraded, false, 'ioError 恢复后不得判降级')
})

test('F4-3 重读仍失败 → 降级且只重试一次（不无限重读、不隔离文件）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 5, filter: { pingbibiaoti: '永远换不到' } })
  const before = fs.readdirSync(dir).sort(byCodeUnit)
  const { result, calls } = withInjectedReads(['replaced', 'replaced'], () =>
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }))
  const ruleReads = calls.filter(c => c.p === filterRulesPaths(dir).file)
  assert.strictEqual(ruleReads.length, 2, `只允许重读一次（实际 ${ruleReads.length} 次）：重试风暴会让挂死的文件系统把整轮拖长`)
  assert.strictEqual(result.source, 'corrupt')
  assert.strictEqual(result.degraded, true)
  assert.strictEqual(result.lastGoodUsed, false, '没有 LKG 时回代码默认')
  assert.match(String(result.error.message), /replaced/, '降级原因必须保留读状态（排障要看得到 replaced/ioError）')
  assert.deepStrictEqual(fs.readdirSync(dir).sort(byCodeUnit), before, '降级不得隔离/改名/新建任何文件（本模块从不移动用户文件）')
})

test('F4-3 unsafe / tooLarge 是确定性判据：直接降级、不做重读', () => {
  for (const status of ['unsafe', 'tooLarge']) {
    resetStoreStateForTests()
    const dir = makeDir()
    writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 6, filter: { pingbibiaoti: 'x' } })
    const { result, calls } = withInjectedReads([status], () =>
      loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }))
    const ruleReads = calls.filter(c => c.p === filterRulesPaths(dir).file)
    assert.strictEqual(ruleReads.length, 1, `${status} 不得重读（确定性判据，重读只会白等 50ms）：实际 ${ruleReads.length} 次`)
    assert.strictEqual(result.source, 'corrupt', `${status} 必须降级`)
    assert.strictEqual(result.lastGoodUsed, false, `${status} 无 LKG 时回代码默认`)
  }
})

// ===== F4-1：持久 LKG（新进程降级时沿用上次合法 override）=====
// 为什么必须开子进程：本套件的 loadFilterRules 调用都在同一进程里，进程内 lastGood 会掩盖
// 「新进程拿到的是代码默认」这个缺陷本体——控制台 auto-run 每 5 秒 spawn 的正是新进程。
const LKG_PROBE = `
const { loadFilterRules, writeAppliedSnapshot, readAppliedSnapshot } = require('./xbk_filter_store')
const dir = process.env.XBK_LKG_DIR
const defaults = JSON.parse(process.env.XBK_LKG_DEFAULTS)
const r = loadFilterRules({ cacheDir: dir, defaults, keyword: {} })
writeAppliedSnapshot({ cacheDir: dir, filter: r.filter, keyword: r.keyword, revision: r.revision, source: r.source, hash: 'probe-hash', lastGoodUsed: r.lastGoodUsed })
const applied = readAppliedSnapshot(dir)
process.stdout.write(JSON.stringify({
  source: r.source,
  degraded: r.degraded,
  lastGoodUsed: r.lastGoodUsed,
  revision: r.revision,
  filter: r.filter,
  applied: applied.status === 'ok' ? { status: 'ok', source: applied.snapshot.source, lastGoodUsed: applied.snapshot.lastGoodUsed, filter: applied.snapshot.filter } : { status: applied.status }
}))
`
function runLkgProbe (dir) {
  const probe = spawnSync(process.execPath, ['-e', LKG_PROBE], {
    encoding: 'utf8',
    cwd: __dirname,
    env: { ...process.env, XBK_LKG_DIR: dir, XBK_LKG_DEFAULTS: JSON.stringify(DEFAULTS) }
  })
  const out = `${probe.stdout || ''}${probe.stderr || ''}`
  assert.strictEqual(probe.status, 0, `LKG 探针必须正常结束：${out.slice(-600)}`)
  return JSON.parse(String(probe.stdout).trim().split('\n').pop())
}

test('F4-1 成功加载 override 后落盘持久 LKG（0600、{schema,revision,hash,override}）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  writeJson(paths.file, { schema: 1, revision: 7, filter: { pingbibiaoti: '覆盖标题', pingbineirong: '覆盖内容' } })
  const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(loaded.source, 'override', '前置：覆盖文件必须被正常加载')
  assert.strictEqual(fs.existsSync(paths.lastgood), true, '成功加载 override 必须写 filter-rules.lastgood.json（否则新进程没有降级兜底）')
  assert.strictEqual(fs.statSync(paths.lastgood).mode & 0o777, 0o600, 'LKG 必须是 0600（含用户规则正文）')
  const lkg = readJson(paths.lastgood)
  assert.deepStrictEqual(Object.keys(lkg).sort(byCodeUnit), ['hash', 'override', 'revision', 'schema'], `LKG 形状必须恰为 {schema,revision,hash,override}：${JSON.stringify(Object.keys(lkg))}`)
  assert.strictEqual(lkg.schema, 1)
  assert.strictEqual(lkg.revision, 7)
  assert.match(lkg.hash, /^[0-9a-f]{64}$/, 'hash 必须是内容摘要（sha256 十六进制）')
  assert.deepStrictEqual(lkg.override, { pingbibiaoti: '覆盖标题', pingbineirong: '覆盖内容' },
    'override 只含覆盖文件里实际存在的字段原文（不得是「默认 + 覆盖」的合并结果，否则缺字段会被钉死成旧默认）')
})

test('F4-1 验收 1：写坏覆盖文件后**新进程**沿用上次合法 override（applied.lastGoodUsed=true，逐字段等于上次合并结果）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const file = filterRulesPaths(dir).file
  writeJson(file, { schema: 1, revision: 7, filter: { pingbibiaoti: '覆盖标题', pingbineirong: '覆盖内容' } })
  const good = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(good.source, 'override')
  const expected = mergeActiveFilter({ defaults: DEFAULTS, keyword: {}, override: { pingbibiaoti: '覆盖标题', pingbineirong: '覆盖内容' } })
  writeRaw(file, '{ 坏掉的 JSON')

  const fresh = runLkgProbe(dir)
  assert.strictEqual(fresh.source, 'corrupt', '坏文件必须判 corrupt/degraded（不是静默 override）')
  assert.strictEqual(fresh.degraded, true)
  assert.strictEqual(fresh.lastGoodUsed, true, '新进程必须用持久 LKG（旧实现这里恒为 false：进程内 Map 对新进程不存在）')
  assert.strictEqual(fresh.revision, 7, 'revision 必须沿用上次合法值')
  for (const field of FILTER_RULE_FIELDS) {
    assert.strictEqual(fresh.filter[field], expected.filter[field], `字段 ${field} 必须等于「上次合法 override + 代码默认」的合并结果`)
  }
  assert.notStrictEqual(fresh.filter.pingbibiaoti, DEFAULTS.pingbibiaoti, '绝不能回代码默认（那会悄悄放宽/改变规则）')
  assert.strictEqual(fresh.applied.status, 'ok', '探针必须写进 applied 快照')
  assert.strictEqual(fresh.applied.source, 'corrupt', 'applied 快照必须如实记录本轮来源是降级')
  assert.strictEqual(fresh.applied.lastGoodUsed, true, 'applied.json 必须带 lastGoodUsed=true（控制台口径据此展示）')
  assert.strictEqual(fresh.applied.filter.pingbibiaoti, expected.filter.pingbibiaoti, 'applied 快照的 filter 必须是本轮真实生效的合并结果')
})

test('F4-1 验收 2：删除覆盖文件 → LKG 一并失效，畸形文件不得复活旧规则（新进程同样回默认）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  writeJson(paths.file, { schema: 1, revision: 9, filter: { pingbibiaoti: '旧规则' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source, 'override')
  assert.strictEqual(fs.existsSync(paths.lastgood), true, '前置：LKG 已写')

  fs.rmSync(paths.file)
  const defaulted = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(defaulted.source, 'default', '删文件 = 恢复代码默认')
  assert.strictEqual(fs.existsSync(paths.lastgood), false, '删正式覆盖文件必须同步删除 LKG（否则「删文件=恢复默认」不成立）')

  writeRaw(paths.file, '不是 JSON')
  const fresh = runLkgProbe(dir)
  assert.strictEqual(fresh.source, 'corrupt')
  assert.strictEqual(fresh.lastGoodUsed, false, 'LKG 已随删除作废，畸形文件不得把旧规则复活')
  assert.strictEqual(fresh.filter.pingbibiaoti, DEFAULTS.pingbibiaoti)
  assert.strictEqual(fresh.applied.lastGoodUsed, false, 'applied 快照必须如实记录 lastGoodUsed=false')
})

test('F4-1 applied.json 不能当 LKG：只有 applied 没有 lastgood 时必须回代码默认', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  // applied 每轮无条件覆盖（连降级轮都写），这里模拟「上一次是 override 轮」留下的快照。
  writeJson(paths.applied, {
    schema: 1,
    revision: 5,
    source: 'override',
    hash: 'h',
    appliedAt: '2026-11-09T00:00:00.000Z',
    filter: { pingbibiaoti: '从 applied 误用', pingbineirong: '从 applied 误用' },
    keyword: { zkt_gjc: '' }
  })
  writeRaw(paths.file, '{ 坏掉的 JSON')
  const fresh = runLkgProbe(dir)
  assert.strictEqual(fresh.source, 'corrupt')
  assert.strictEqual(fresh.lastGoodUsed, false, '没有 lastgood.json 时不得把 applied.json 当 LKG')
  assert.strictEqual(fresh.filter.pingbibiaoti, DEFAULTS.pingbibiaoti, 'applied 里的规则不得被代入降级轮')
  assert.strictEqual(fresh.revision, 0, '没有 LKG 时 revision 必须是 0')
})

test('F4-1 LKG 被改写/损坏（hash 不符、未知字段、非普通文件）一律当没有 LKG', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  writeJson(paths.file, { schema: 1, revision: 4, filter: { pingbibiaoti: '好规则' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source, 'override')
  const original = readJson(paths.lastgood)
  writeRaw(paths.file, '{ 坏掉的 JSON')

  const cases = [
    ['hash 不符（内容被改过）', { ...original, hash: 'deadbeef' }],
    ['override 含未知字段', { ...original, override: { ...original.override, evil: 'x' } }],
    ['override 值非字符串', { ...original, override: { pingbibiaoti: 42 } }],
    ['schema 不符', { ...original, schema: 2 }],
    ['revision 非法', { ...original, revision: -1 }],
    ['不是对象', [1, 2]]
  ]
  for (const [label, payload] of cases) {
    writeJson(paths.lastgood, payload)
    const fresh = runLkgProbe(dir)
    assert.strictEqual(fresh.lastGoodUsed, false, `${label}：不合格的 LKG 必须被拒绝（不得部分采用）`)
    assert.strictEqual(fresh.filter.pingbibiaoti, DEFAULTS.pingbibiaoti, `${label}：必须回代码默认`)
  }
})

test('F4-1 LKG 是 FIFO 时降级轮不得挂死（读取同样 O_NONBLOCK）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO LKG 探针：${FIFO_SKIP}`)
    return
  }
  resetStoreStateForTests()
  const dir = makeDir()
  writeRaw(filterRulesPaths(dir).file, '{ 坏掉的 JSON')
  require('node:child_process').execFileSync(MKFIFO, [filterRulesPaths(dir).lastgood])
  const r = runProbeUnderTimeout(`
const { loadFilterRules } = require('./xbk_filter_store')
const t0 = Date.now()
const r = loadFilterRules({ cacheDir: process.env.XBK_FIFO_DIR, defaults: {}, keyword: {} })
process.stdout.write(JSON.stringify({ source: r.source, lastGoodUsed: r.lastGoodUsed, ms: Date.now() - t0 }))
`, dir)
  assert.ok(r.ms < 2000, `FIFO LKG 读取必须 2 秒内返回（实耗 ${r.ms}ms）`)
  assert.strictEqual(r.source, 'corrupt')
  assert.strictEqual(r.lastGoodUsed, false, 'FIFO 不是普通文件，必须当「没有 LKG」')
})

test('F4-1 resetStoreStateForTests 同步清掉持久 LKG（测试隔离前提）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  writeJson(paths.file, { schema: 1, revision: 1, filter: { pingbibiaoti: 'x' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source, 'override')
  assert.strictEqual(fs.existsSync(paths.lastgood), true)
  resetStoreStateForTests()
  assert.strictEqual(fs.existsSync(paths.lastgood), false, '清空 LKG 必须同时删除落盘文件，否则「全新进程」用例会互相污染')
})

// ===== F4-1 返工 R3：LKG 包装层的读写口径必须一致（写成功 ≠ 读得回）=====
// LKG 是覆盖文件的**再包装**：比覆盖文件多出 `"hash":"<64 位十六进制>",`（74 字节）与
// `"override"`/`"filter"` 的键名差（+2），实测 +76 字节。旧实现读写共用 256 KiB ⇒ 覆盖文件落在
// (256 KiB-76, 256 KiB] 这段（保存闸门允许 ≤ MAX-32，手改可到 MAX）时，写出的 LKG 必然 > 读上限，
// readLastGood 判 tooLarge 返回 null，新进程照样回代码默认，而 writeLastGoodFile 还返回 true。
const RULES_READ_MAX_BYTES = 256 * 1024 // 与 xbk_filter_store.FILTER_RULES_MAX_BYTES 同值（未导出）
// 把 11 个字段堆到接近上限（单字段上限 16000 码元，中文 3 字节/字；pingbitime 是数字型字段）
function nearLimitFilter (targetBytes) {
  const filter = {}
  for (const field of FILTER_RULE_FIELDS) filter[field] = field === 'pingbitime' ? '7' : '中'.repeat(16000)
  const sizeOf = () => Buffer.byteLength(JSON.stringify({ schema: FILTER_RULES_SCHEMA, revision: 1, filter }), 'utf8')
  let size = sizeOf()
  for (let i = FILTER_RULE_FIELDS.length - 2; i >= 0 && size > targetBytes; i--) {
    const field = FILTER_RULE_FIELDS[i]
    const chars = filter[field].length
    const cut = Math.min(chars - 1, Math.ceil((size - targetBytes) / 3))
    filter[field] = '中'.repeat(chars - cut)
    size = sizeOf()
  }
  return { filter, size }
}

test('F4-1 R3 覆盖文件贴读上限时持久 LKG 仍必须被**新进程**读回（包装 +76 不得越过读上限）', () => {
  resetStoreStateForTests()
  // 两档：①控制台保存闸门允许的最大形状（≤ MAX-32）②手改能到的 MAX。旧实现在两档都写不出可读的 LKG。
  for (const target of [RULES_READ_MAX_BYTES - 44, RULES_READ_MAX_BYTES]) {
    const { filter, size } = nearLimitFilter(target)
    assert.ok(size > RULES_READ_MAX_BYTES - 76 && size <= RULES_READ_MAX_BYTES,
      `夹具必须落在缺陷窗口 (${RULES_READ_MAX_BYTES - 76}, ${RULES_READ_MAX_BYTES}]：实得 ${size}`)
    if (size <= RULES_READ_MAX_BYTES - 32) {
      const gate = validateFilterRules({ schema: FILTER_RULES_SCHEMA, revision: 1, filter }, deps)
      assert.strictEqual(gate.ok, true,
        `前置：${size} 字节的覆盖文件必须能过保存闸门（否则只是「本来就存不进去」）：${JSON.stringify(gate.errors)}`)
    }
    const dir = makeDir()
    const paths = filterRulesPaths(dir)
    writeJson(paths.file, { schema: 1, revision: 1, filter })
    const loaded = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
    assert.strictEqual(loaded.source, 'override', `${size} 字节的覆盖文件必须被正常加载`)
    const lkgBytes = fs.statSync(paths.lastgood).size
    assert.ok(lkgBytes > RULES_READ_MAX_BYTES,
      `夹具必须让 LKG 越过覆盖文件读上限（LKG ${lkgBytes} 字节，包装 +${lkgBytes - size}）`)

    writeRaw(paths.file, '{ 坏掉的 JSON')
    const fresh = runLkgProbe(dir)
    assert.strictEqual(fresh.source, 'corrupt')
    assert.strictEqual(fresh.lastGoodUsed, true,
      `${size} 字节覆盖文件的 LKG（${lkgBytes} 字节）必须能被新进程读回——旧实现按 ${RULES_READ_MAX_BYTES} 读判 tooLarge，静默回代码默认`)
    assert.ok(lkgBytes <= LASTGOOD_MAX_BYTES, `写出的 LKG 必须落在自己的读上限内：${lkgBytes} > ${LASTGOOD_MAX_BYTES}`)
    assert.strictEqual(fresh.revision, 1, 'revision 必须沿用上次合法值')
    for (const field of FILTER_RULE_FIELDS) {
      assert.strictEqual(fresh.filter[field], filter[field], `LKG 恢复的字段 ${field} 必须与上次合法 override 逐字相等`)
    }
  }
})

test('F4-1 R3 写侧同口径：序列化后超过 LKG 读上限 ⇒ 不落盘 + 告警（不得返回 true 骗调用方）', () => {
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  const huge = {}
  for (const field of FILTER_RULE_FIELDS) huge[field] = field === 'pingbitime' ? '7' : '中'.repeat(16000)
  const bytes = Buffer.byteLength(JSON.stringify({ schema: FILTER_RULES_SCHEMA, revision: 0, filter: huge }), 'utf8')
  assert.ok(bytes > LASTGOOD_MAX_BYTES, `前置：夹具必须超过 LKG 读上限（${bytes} vs ${LASTGOOD_MAX_BYTES}）`)
  const warned = []
  const origWarn = console.warn
  console.warn = (...args) => { warned.push(args.join(' ')) }
  let ok
  try {
    ok = writeLastGoodFile(paths.lastgood, huge, 3)
  } finally {
    console.warn = origWarn
  }
  assert.strictEqual(ok, false, '写不进去必须返回 false（否则调用方以为降级兜底已就位）')
  assert.strictEqual(fs.existsSync(paths.lastgood), false, '超过读上限的 LKG 不得落盘（落盘即「写成功但读不回」）')
  assert.match(warned.join('\n'), /超过 LKG 读上限/, `写侧必须留一条告警，实际：${JSON.stringify(warned)}`)
})

test('F4-1 R3 读侧仍是有界读：LKG 超过 LASTGOOD_MAX_BYTES ⇒ 当「没有 LKG」（不部分采用）', () => {
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  // 合法 JSON、形状也合法，只是体积超过 LKG 读上限（模拟包装膨胀或被外部塞了大文件）
  const override = {}
  for (const field of FILTER_RULE_FIELDS) override[field] = field === 'pingbitime' ? '7' : '中'.repeat(16000)
  writeRaw(paths.lastgood, JSON.stringify({ schema: FILTER_RULES_SCHEMA, revision: 1, hash: 'x', override }))
  assert.ok(fs.statSync(paths.lastgood).size > LASTGOOD_MAX_BYTES)
  assert.strictEqual(readLastGood(paths.lastgood), null, '超过上限的 LKG 必须当没有（有界读，不得无界整读）')
})

// ===== F4-2：FIFO/非普通文件不得挂死（读取必须 O_NONBLOCK + 普通文件校验）=====
test('F4-2 参数层：覆盖文件与生效快照的读取必须传 openNonBlocking（裸 O_RDONLY 会挂死）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const storageMod = require('./xbk_storage')
  const realRead = storageMod.readSafeTextResult
  const calls = []
  try {
    storageMod.readSafeTextResult = (p, maxBytes, options) => {
      calls.push({ p: String(p), options })
      return { status: 'missing', text: null, error: null }
    }
    loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
    readAppliedSnapshot(dir)
  } finally {
    storageMod.readSafeTextResult = realRead
  }
  const rulesRead = calls.filter(c => c.p === filterRulesPaths(dir).file)
  const appliedRead = calls.filter(c => c.p === filterRulesPaths(dir).applied)
  assert.strictEqual(rulesRead.length, 1, `覆盖文件读入口必须被走到 1 次：${JSON.stringify(calls.map(c => c.p))}`)
  assert.strictEqual(appliedRead.length, 1, `生效快照读入口必须被走到 1 次：${JSON.stringify(calls.map(c => c.p))}`)
  for (const c of [rulesRead[0], appliedRead[0]]) {
    assert.strictEqual(c.options && c.options.openNonBlocking, true,
      `readSafeTextResult 必须传 openNonBlocking:true（FIFO 上裸 O_RDONLY 永久阻塞）${c.p}: ${JSON.stringify(c.options)}`)
  }
})

test('F4-2 FIFO 覆盖文件：新进程 2 秒内降级为 corrupt（timeout 3 实测 exit≠124）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 覆盖文件探针：${FIFO_SKIP}`)
    return
  }
  resetStoreStateForTests()
  const { dir } = makeFifoDir('filter-rules.json')
  const r = runProbeUnderTimeout(`
const { loadFilterRules } = require('./xbk_filter_store')
const t0 = Date.now()
const r = loadFilterRules({ cacheDir: process.env.XBK_FIFO_DIR, defaults: {}, keyword: {} })
process.stdout.write(JSON.stringify({ source: r.source, degraded: r.degraded, lastGoodUsed: r.lastGoodUsed, message: r.error && r.error.message, ms: Date.now() - t0 }))
`, dir)
  assert.ok(r.ms < 2000, `FIFO 覆盖文件读取必须 2 秒内返回（实耗 ${r.ms}ms）`)
  assert.strictEqual(r.source, 'corrupt', `FIFO 必须按不可用降级（实际 source=${r.source}）：GIF/管道不得当规则文件读`)
  assert.strictEqual(r.degraded, true, '降级必须置 degraded=true（运行侧据此不清 _f、不推进 hash）')
  assert.strictEqual(r.lastGoodUsed, false, '新进程没有 LKG 时必须回代码默认（本案无历史合法文件）')
  assert.match(String(r.message), /unsafe/, `降级原因必须点名 unsafe（普通文件校验），实际：${r.message}`)
})

test('F4-2 FIFO 生效快照：readAppliedSnapshot 2 秒内返回 ioError（不挂死控制台读面）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 生效快照探针：${FIFO_SKIP}`)
    return
  }
  const { dir } = makeFifoDir('filter-rules.applied.json')
  const r = runProbeUnderTimeout(`
const { readAppliedSnapshot } = require('./xbk_filter_store')
const t0 = Date.now()
const read = readAppliedSnapshot(process.env.XBK_FIFO_DIR)
process.stdout.write(JSON.stringify({ status: read.status, code: read.error && read.error.code, ms: Date.now() - t0 }))
`, dir)
  assert.ok(r.ms < 2000, `FIFO 生效快照读取必须 2 秒内返回（实耗 ${r.ms}ms）`)
  assert.strictEqual(r.status, 'ioError', `FIFO 生效快照必须如实判不可读（实际 ${r.status}）`)
  assert.strictEqual(r.code, 'unsafe', `错误码必须点名 unsafe，实际 ${r.code}`)
})

test('F4-2 FIFO 周标记 <log>.week：readMarker 2 秒内返回空串（run.log 写入路径不得挂死）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 周标记探针：${FIFO_SKIP}`)
    return
  }
  const { dir } = makeFifoDir('run.log.week')
  const r = runProbeUnderTimeout(`
const path = require('node:path')
const { readMarker } = require('./scripts/log-archive')
const t0 = Date.now()
const marker = readMarker(path.join(process.env.XBK_FIFO_DIR, 'run.log'))
process.stdout.write(JSON.stringify({ marker, ms: Date.now() - t0 }))
`, dir)
  assert.ok(r.ms < 2000, `FIFO 周标记读取必须 2 秒内返回（实耗 ${r.ms}ms）`)
  assert.strictEqual(r.marker, '', 'FIFO 周标记必须按「无标记」处理（不得把它当周键）')
})

// R1-1：读侧改 O_NONBLOCK 只覆盖了 readMarker；同一分支紧接着的**写**标记才是真正的挂死点
// （裸 fs.writeFileSync 在无写者 FIFO 上同步 open(O_WRONLY) 永久阻塞）。旧用例只调 readMarker，
// 完全没走到写分支，所以这条缺陷没有任何覆盖。
test('F4-2 FIFO 周标记写入：run.log.week 注入 FIFO 后 _writeRunLog 不挂死（写侧，R1-1）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 周标记写入探针：${FIFO_SKIP}`)
    return
  }
  const { dir } = makeFifoDir('run.log.week')
  const r = runProbeUnderTimeout(`
const fs = require('node:fs')
const path = require('node:path')
const { App } = require('./xbk_function_v3')
const dir = process.env.XBK_FIFO_DIR
App._cacheDir = () => dir
let warned = ''
const origWarn = console.warn
console.warn = (...args) => { warned += args.join(' ') + '\\n' }
const t0 = Date.now()
App._writeRunLog('2026-11-10 12:00:00 probe line\\n')
const ms = Date.now() - t0
console.warn = origWarn
const markerPath = path.join(dir, 'run.log.week')
let markerType = 'missing'
try { const st = fs.lstatSync(markerPath); markerType = st.isFIFO() ? 'fifo' : (st.isFile() ? 'file' : 'other') } catch (e) {}
const logPath = path.join(dir, 'run.log')
const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
process.stdout.write(JSON.stringify({ ms, markerType, logHasLine: logText.includes('probe line'), warnedHasMarker: /日志周标记/.test(warned) }))
`, dir)
  assert.ok(r.ms < 2000, `FIFO 周标记写入必须 2 秒内返回（实耗 ${r.ms}ms）：裸 writeFileSync 会永久阻塞整轮`)
  assert.strictEqual(r.markerType, 'fifo', `周标记必须仍是那个 FIFO（不得被写穿/改名/替换），实际 ${r.markerType}`)
  assert.strictEqual(r.logHasLine, true, 'run.log 本体必须照常写入（标记写不了不影响留痕）')
  assert.strictEqual(r.warnedHasMarker, true, '拒绝写非普通文件周标记必须留一条 console.warn（故障可见，不静默）')
})

test('F4-2 普通周标记仍照常写入：无标记时第一轮写当前周键（R1-1 回归，不得为修 FIFO 拒写正常文件）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过普通周标记探针：${FIFO_SKIP}`)
    return
  }
  const dir = makeDir()
  const r = runProbeUnderTimeout(`
const fs = require('node:fs')
const path = require('node:path')
const { App } = require('./xbk_function_v3')
const { readMarker } = require('./scripts/log-archive')
const dir = process.env.XBK_FIFO_DIR
App._cacheDir = () => dir
App._writeRunLog('2026-11-10 12:00:00 probe line\\n')
const markerPath = path.join(dir, 'run.log.week')
const mode = fs.existsSync(markerPath) ? (fs.statSync(markerPath).mode & 0o777) : -1
process.stdout.write(JSON.stringify({ marker: readMarker(path.join(dir, 'run.log')), mode }))
`, dir)
  const { weekRange } = require('./scripts/log-archive')
  assert.strictEqual(r.marker, weekRange(Date.now()).key, `无标记的首次写入必须落当前周键（实际 ${r.marker}）`)
  assert.strictEqual(r.mode, 0o600, `周标记必须是 0600（与其它状态文件同口径），实际 ${r.mode.toString(8)}`)
})

// R1-2：readStatus 里的 report.state / channel-health.state 此前调 readText 时没传 options，
// 走的是裸 O_RDONLY——FIFO 上没有写者就永久阻塞。控制台 GET /、GET /api/status 与青龙 --status
// 全走这条路径，一处漏传就是「整个单线程 http server 被钉死」。
test('F4-2 FIFO 状态文件：report.state / channel-health.state 注入 FIFO 后 readStatus 2 秒内返回 unsafe（R1-2）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 状态文件探针：${FIFO_SKIP}`)
    return
  }
  for (const [name, key] of [['report.state', 'report'], ['channel-health.state', 'channels']]) {
    const { dir } = makeFifoDir(name)
    const r = runProbeUnderTimeout(`
const { readStatus } = require('./scripts/status')
const t0 = Date.now()
const out = readStatus(process.env.XBK_FIFO_DIR)
process.stdout.write(JSON.stringify({ report: out.report.status, channels: out.channels.status, run: out.run.status, ms: Date.now() - t0 }))
`, dir)
    assert.ok(r.ms < 2000, `${name} 的 readStatus 必须 2 秒内返回（实耗 ${r.ms}ms）：裸 O_RDONLY 会阻塞等写者`)
    assert.strictEqual(r[key], 'unsafe', `${name} 必须按非普通文件判 unsafe（实际 ${r[key]}）——不得挂死也不得当空文件读`)
    assert.strictEqual(r.run, 'missing', '其余部件不受影响（同一目录下没有 run.log）')
  }
})

test('F4-2 FIFO 状态文件 + 控制台读面：GET /api/status 与 GET / 都不得挂死（R1-2）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 控制台读面探针：${FIFO_SKIP}`)
    return
  }
  const { dir } = makeFifoDir('report.state')
  const r = runProbeUnderTimeout(`
const http = require('node:http')
const { createConsole } = require('./scripts/console')
const token = 'probe-token-0123456789'
const { server } = createConsole({ token, stateDir: process.env.XBK_FIFO_DIR, log: () => {} })
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Authorization: 'Bearer ' + token } }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, bytes: body.length }))
  })
  req.on('error', reject)
})
server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port
    const t0 = Date.now()
    const api = await get(port, '/api/status')
    const page = await get(port, '/')
    process.stdout.write(JSON.stringify({ api, page, ms: Date.now() - t0 }))
  } finally {
    server.close(() => process.exit(0))
  }
})
`, dir)
  assert.ok(r.ms < 2000, `控制台读面必须 2 秒内响应（实耗 ${r.ms}ms）：单线程 server 一挂就是整只控制台不可用`)
  assert.strictEqual(r.api.status, 200, `GET /api/status 必须正常返回（实际 ${r.api.status}）：读不到不等于挂死`)
  assert.strictEqual(r.page.status, 200, `GET / 必须正常返回（实际 ${r.page.status}）`)
})

test('F4-2 FIFO 状态文件 + --status：青龙 --status 2 秒内正常退出并如实报 unsafe（R1-2）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO --status 探针：${FIFO_SKIP}`)
    return
  }
  const { dir } = makeFifoDir('channel-health.state')
  const r = runProbeUnderTimeout(`
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const t0 = Date.now()
const probe = spawnSync(process.execPath, [path.resolve('qinglong/xbk_push.js'), '--status'], {
  encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: process.env.XBK_FIFO_DIR }, timeout: 2500
})
process.stdout.write(JSON.stringify({ code: probe.status, signal: probe.signal, ms: Date.now() - t0, out: String(probe.stdout || '') + String(probe.stderr || '') }))
`, dir)
  assert.ok(r.ms < 2000, `--status 必须 2 秒内结束（实耗 ${r.ms}ms）`)
  assert.strictEqual(r.signal, null, `--status 不得被超时强杀（signal=${r.signal}）`)
  assert.strictEqual(r.code, 0, `--status 必须正常退出（实际 code=${r.code}）：状态不可读是展示内容，不是命令失败`)
  assert.match(r.out, /通道健康：不可读（unsafe）/, `--status 必须如实点名 unsafe，实际输出：${String(r.out).slice(-300)}`)
})

// R1-3：commitFilterOverride 备份「当前一代」时读的正是 filter-rules.json（spec 点名必须非阻塞的文件）。
// 进入条件是 loaded.source==='override'|'corrupt'，而 FIFO 恰好被判 corrupt ⇒ 保存/回滚/导入三条
// 写入口会一起在裸 O_RDONLY 上永久阻塞，单线程 http server 整只挂死且没有任何日志。
test('F4-2 FIFO 覆盖文件 + 写入口：保存 / 回滚 / 备份导入三条入口都不得挂死（R1-3）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 写入口探针：${FIFO_SKIP}`)
    return
  }
  const { dir } = makeFifoDir('filter-rules.json')
  const r = runProbeUnderTimeout(`
const http = require('node:http')
const { createConsole } = require('./scripts/console')
const token = 'probe-token-0123456789'
const { server } = createConsole({ token, stateDir: process.env.XBK_FIFO_DIR, log: () => {} })
const request = (port, method, p, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  } }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, error: JSON.parse(text).error }))
  })
  req.on('error', reject)
  req.end(payload)
})
server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port
    const started = Date.now()
    const save = await request(port, 'POST', '/api/config/filter', { filter: {}, baseRevision: 0, confirmReplaceCorrupt: true })
    const saveMs = Date.now() - started
    const restore = await request(port, 'POST', '/api/config/filter/restore', { confirm: true, to: 'default', baseRevision: 0 })
    const imported = await request(port, 'POST', '/api/backup/import', { kind: 'xbk-console-backup', schema: 1, data: { filter: { text: JSON.stringify({ schema: 1, revision: 1, filter: { pingbibiaoti: 'x' } }) } } })
    process.stdout.write(JSON.stringify({ save, saveMs, restore, imported, ms: Date.now() - started }))
  } finally {
    server.close(() => process.exit(0))
  }
})
`, dir)
  assert.ok(r.saveMs < 2000, `POST 保存必须 2 秒内响应（实耗 ${r.saveMs}ms）：FIFO 上裸 O_RDONLY 会永久阻塞整只控制台`)
  assert.strictEqual(r.save.status, 500, `FIFO 覆盖文件写入必须如实失败（实际 ${r.save.status}）`)
  assert.strictEqual(r.save.error, 'write_failed', `保存失败码必须是 write_failed（实际 ${r.save.error}）`)
  assert.strictEqual(r.restore.status, 500, `回滚同样不得挂死，且必须如实失败（实际 ${r.restore.status}）`)
  assert.strictEqual(r.restore.error, 'write_failed', `回滚失败码必须是 write_failed（实际 ${r.restore.error}）`)
  assert.ok(r.imported.status >= 400, `备份导入不得报成功（实际 ${r.imported.status}）：filter-rules.json 写不进去`)
  assert.ok(r.ms < 3000, `三条入口合计必须 3 秒内结束（实耗 ${r.ms}ms）`)
})

test('R1-3 静态接线：备份当前一代的读必须显式 openNonBlocking（回退成裸读即红）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scripts/console.js'), 'utf8')
  const line = src.split('\n').find(l => l.includes('readSafeTextResult(paths.file, FILTER_BODY_MAX_BYTES'))
  assert.ok(line, 'console.js 必须仍有一处读取当前覆盖文件原文（审计失败回滚用）')
  assert.match(line, /openNonBlocking: true/,
    `备份当前一代的读必须带 openNonBlocking:true（FIFO 会永久阻塞）：${line.trim()}`)
})

// R1-5：持久 LKG 写入挂在 loadFilterRules 的成功路径上，而控制台 GET /api/config/filter（4830）与
// GET /api/config/filter/draft（4221）都调它 ⇒ 纯读请求会新建/重写 filter-rules.lastgood.json，
// 违反 SYSTEM_CONTRACT:56「控制台读取面零写盘」（:27 明确该 GET 属读面）。inode 变化是最硬的证据：
// writeAtomic 走 tmp+rename，每写一次 inode 必换（同一 mtime 毫秒内也能区分）。
test('I2/R1-5 控制台读面零写盘：persistLastGood:false 的纯读不新建/不改写 LKG（运行侧仍写）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  writeJson(paths.file, { schema: 1, revision: 3, filter: { pingbibiaoti: '读面规则' } })
  const listing = () => fs.readdirSync(dir).sort(byCodeUnit)

  const first = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, persistLastGood: false })
  assert.strictEqual(first.source, 'override', '前置：覆盖文件必须被正常加载')
  assert.deepStrictEqual(listing(), ['filter-rules.json'],
    `纯读不得新建 filter-rules.lastgood.json（实际目录：${JSON.stringify(listing())}）`)
  const rulesBefore = fs.statSync(paths.file)
  const second = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, persistLastGood: false })
  assert.strictEqual(second.source, 'override')
  assert.strictEqual(fs.statSync(paths.file).ino, rulesBefore.ino, '纯读不得重写覆盖文件本身')
  assert.deepStrictEqual(listing(), ['filter-rules.json'], '第二次纯读同样不得落盘')

  // 运行侧（缺省 persistLastGood=true）必须照旧写：否则新进程降级时没有 LKG 可用（F4-1 回归）
  const runSide = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(runSide.source, 'override')
  assert.strictEqual(fs.existsSync(paths.lastgood), true, '运行侧成功加载 override 必须落盘持久 LKG')
  const lkgBefore = fs.statSync(paths.lastgood)
  const readOnlyAgain = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, persistLastGood: false })
  assert.strictEqual(readOnlyAgain.source, 'override')
  const lkgAfter = fs.statSync(paths.lastgood)
  assert.strictEqual(lkgAfter.ino, lkgBefore.ino, '纯读不得改写已有 LKG（inode 换了就说明又写了一次）')
  assert.strictEqual(lkgAfter.mtimeMs, lkgBefore.mtimeMs, '纯读不得改写已有 LKG（mtime 必须原样）')
})

test('I2/R1-5 读面不代删 LKG：覆盖文件缺失时纯读不删 LKG，运行侧默认口径仍删（删文件=恢复默认）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  const paths = filterRulesPaths(dir)
  writeJson(paths.file, { schema: 1, revision: 5, filter: { pingbibiaoti: '旧规则' } })
  assert.strictEqual(loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} }).source, 'override')
  assert.strictEqual(fs.existsSync(paths.lastgood), true, '前置：运行侧已写 LKG')

  fs.rmSync(paths.file)
  const readOnly = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {}, persistLastGood: false })
  assert.strictEqual(readOnly.source, 'default', '覆盖文件缺失 = 代码默认')
  assert.strictEqual(fs.existsSync(paths.lastgood), true,
    '控制台读面不得代为删除 LKG（删除也是写盘；「删文件=恢复默认」由运行侧负责）')

  const runSide = loadFilterRules({ cacheDir: dir, defaults: DEFAULTS, keyword: {} })
  assert.strictEqual(runSide.source, 'default')
  assert.strictEqual(fs.existsSync(paths.lastgood), false, '运行侧加载到 missing 必须同步删除 LKG')
})

test('I2/R1-5 真实控制台 GET /api/config/filter：两次纯读后目录 inode/mtime 全不变、无 lastgood（读面零写盘）', () => {
  resetStoreStateForTests()
  const dir = makeDir()
  writeJson(filterRulesPaths(dir).file, { schema: 1, revision: 3, filter: { pingbibiaoti: '读面规则' } })
  const r = runProbeUnderTimeout(`
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createConsole } = require('./scripts/console')
const dir = process.env.XBK_FIFO_DIR
const token = 'probe-token-0123456789'
const snap = () => fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => {
  const st = fs.lstatSync(path.join(dir, name))
  return name + ':' + st.ino + ':' + st.mtimeMs
})
const { server } = createConsole({ token, stateDir: dir, log: () => {} })
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Authorization: 'Bearer ' + token } }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body }))
  })
  req.on('error', reject)
})
server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port
    const before = snap()
    const first = await get(port, '/api/config/filter')
    const mid = snap()
    const second = await get(port, '/api/config/filter?nonce=2')
    const after = snap()
    process.stdout.write(JSON.stringify({
      statuses: [first.status, second.status],
      lastGoodUsed: [JSON.parse(first.body).lastGoodUsed, JSON.parse(second.body).lastGoodUsed],
      before, mid, after
    }))
  } finally {
    server.close(() => process.exit(0))
  }
})
`, dir)
  assert.deepStrictEqual(r.statuses, [200, 200], `两次 GET 都必须成功（实际 ${JSON.stringify(r.statuses)}）`)
  assert.deepStrictEqual(r.lastGoodUsed, [false, false], '正常加载轮 lastGoodUsed 必须为 false（运行侧快照缺省）')
  assert.deepStrictEqual(r.mid, r.before, `第一次纯读不得写盘（前：${JSON.stringify(r.before)} 后：${JSON.stringify(r.mid)}）`)
  assert.deepStrictEqual(r.after, r.mid, `第二次纯读不得写盘（前：${JSON.stringify(r.mid)} 后：${JSON.stringify(r.after)}）`)
  assert.ok(!r.after.some(entry => entry.startsWith('filter-rules.lastgood.json:')),
    `控制台读面不得生成 filter-rules.lastgood.json（实际目录：${JSON.stringify(r.after)}）`)
})

// R1-4：README 是**唯一**面向部署者的降级口径说明，没有内容门禁（check-doc-lines 只管行长），
// 漂移只能靠评审。本题材料里 README 仍写「优先沿用进程内上一次合法规则」——新进程里根本不存在，
// 正是 F4-1 修掉的缺陷本体。这里把口径钉住：回退成旧措辞即红。
test('R1-4 文档同步：README 必须写持久 LKG（不得再写「进程内上一次合法规则」）', () => {
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8')
  assert.ok(!readme.includes('优先沿用进程内上一次合法规则'),
    'README 不得再写「进程内 LKG」：控制台 auto-run 每轮都是新进程，进程内 Map 等于不存在（F4-1）')
  assert.match(readme, /filter-rules\.lastgood\.json/,
    'README 必须点名持久 LKG 文件 <缓存目录>/filter-rules.lastgood.json')
  assert.match(readme, /删掉正式覆盖文件时 LKG 一并删除|删除正式覆盖文件时同步删除 LKG/,
    'README 必须写清「删覆盖文件 ⇒ LKG 作废」（否则「删文件=恢复默认」会被降级轮复活旧规则破坏）')
  const appliedLine = readme.split('\n').find(l => l.includes('filter-rules.applied.json` 快照'))
  assert.ok(appliedLine, 'README 必须仍描述 filter-rules.applied.json 生效快照')
  assert.ok(appliedLine.includes('lastGoodUsed'),
    `applied 快照的字段清单必须含 lastGoodUsed（控制台「沿用上次合法规则」唯一口径）：${appliedLine}`)
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
