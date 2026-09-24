'use strict'

// xbk_rules.js 扩展测试（提升变异分数）
// 覆盖：compileRules 边界 + matchesCompiled + checkTimeCompiled + validateConfig 更多场景
const assert = require('node:assert')
const { createRuleEngine } = require('./xbk_rules')

const mockUtils = {
  safeStr: (v) => (v === undefined || v === null || typeof v === 'symbol') ? '' : String(v),
  safeGet: (o, k) => o ? o[k] : undefined,
  // CodeRabbit PR #147：xbk_rules 的 readField 恢复路径改用 Utils.safeErrorText 取值
  // （避免读会抛的 e.message getter 在 catch 里再抛），故替身必须提供同等能力——
  // 且这里必须自己吞掉读取异常（本 mock 的 safeGet 不做 try/catch）。
  safeErrorText: (error, fallback = '') => {
    try {
      if (typeof error === 'string' && error.trim() !== '') return error
      if (typeof error === 'number' || typeof error === 'boolean') return String(error)
      if (typeof error === 'symbol') return Symbol.prototype.toString.call(error)
      if (!error || typeof error !== 'object') return fallback
      for (const key of ['message', 'code']) {
        let v
        try { v = error[key] } catch (e) { v = undefined }
        if (v !== undefined && v !== null && v !== '') return String(v)
      }
      return fallback
    } catch (e) { return fallback }
  },
  parseTime: (t) => {
    if (typeof t === 'number' && t > 0) return t < 1e12 ? t * 1000 : t
    const d = new Date(t)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  },
  daysFrom: (ms) => {
    const now = new Date()
    const dNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const t = new Date(ms)
    const dMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
    return dNow > dMs ? Math.floor((dNow - dMs) / (24 * 60 * 60 * 1000)) : 0
  }
}

// compileUserRegex：返回编译成功的正则对象（模拟真实编译）
const compileUserRegex = (src, flags) => {
  try { return new RegExp(src, flags) } catch (e) { return null }
}

const engine = createRuleEngine({
  Utils: mockUtils,
  FILTER_FIELDS: ['keyword', 'title'],
  compileUserRegex,
  isRe2Available: () => false
})

let pass = 0
let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

console.log('=== xbk_rules.js 扩展测试 ===')

// ===== compileRules =====
check('compileRules: 空配置返回空编译结果', () => {
  const r = engine.compileRules({})
  assert.ok(r && typeof r === 'object', '应返回对象')
})

check('compileRules: 非字符串值跳过并告警', () => {
  const r = engine.compileRules({ keyword: 123 })
  assert.ok(r, '应返回结果（非字符串值被跳过）')
})

check('compileRules: 正常规则编译成功', () => {
  const r = engine.compileRules({ keyword: 'cat###abc' })
  assert.ok(r, '应返回编译结果')
})

check('compileRules: 非法正则跳过', () => {
  const r = engine.compileRules({ keyword: 'cat###[invalid' })
  assert.ok(r, '非法正则应被跳过，不崩溃')
})

check('compileRules: 多行规则', () => {
  const r = engine.compileRules({ keyword: 'cat1###abc\ncat2###def' })
  assert.ok(r, '多行规则应编译成功')
})

check('compileRules: 行包含多个 ### 仅前两段生效', () => {
  const r = engine.compileRules({ keyword: 'cat###val###extra' })
  assert.ok(r, '多个 ### 应仅前两段生效')
})

check('compileRules: 值为空跳过（避免永真规则）', () => {
  const r = engine.compileRules({ keyword: 'cat###' })
  assert.ok(r, '空值应被跳过')
})

// ===== compileRules: pingbitime 上限 / 抛错 getter（qodo #147-3）=====
check('compileRules: pingbitime 简单形态超上限置 null 并告警（规则被忽略）', () => {
  const origWarn = console.warn
  const warns = []
  let r
  try {
    console.warn = (...args) => warns.push(args.join(' '))
    r = engine.compileRules({ pingbitime: '3650001' })
  } finally { console.warn = origWarn }
  assert.strictEqual(r.pingbitime, null, '超上限应置 null（不编译该规则）')
  assert.ok(warns.some(w => w.includes('超过上限')), '应 console.warn 提示超上限')
})

check('compileRules: pingbitime 多行形态超上限行被忽略（仅保留合法行）', () => {
  const origWarn = console.warn
  let r
  try {
    console.warn = () => {}
    r = engine.compileRules({ pingbitime: 'cat###3650001\ncat###5' })
  } finally { console.warn = origWarn }
  assert.ok(r.pingbitime && r.pingbitime._type === 'timeMulti', '应编译为多行时间规则')
  assert.strictEqual(r.pingbitime.rules.length, 1, '超上限行应被忽略，仅保留合法行')
  assert.strictEqual(r.pingbitime.rules[0].value, 5, '保留的应为合法行 5')
})

check('compileRules: pingbitime 抛错 getter 不抛穿且规则置空', () => {
  const cfg = {}
  Object.defineProperty(cfg, 'pingbitime', { get () { throw new Error('boom-pingbitime') } })
  let r
  assert.doesNotThrow(() => { r = engine.compileRules(cfg) }, '抛错 getter 不得抛穿 compileRules')
  assert.strictEqual(r.pingbitime, null, 'getter 抛错应视为无该字段')
})

// ===== matchesCompiled =====
check('matchesCompiled: 匹配成功返回 true', () => {
  const compiled = engine.compileRules({ keyword: 'cat###abc' })
  const r = engine.matchesCompiled(compiled.keyword, 'abc', 'cat')
  assert.strictEqual(r, true, '应匹配成功')
})

check('matchesCompiled: 值不匹配返回 false', () => {
  const compiled = engine.compileRules({ keyword: 'cat###abc' })
  const r = engine.matchesCompiled(compiled.keyword, 'xyz', 'cat')
  assert.strictEqual(r, false, '值不匹配应返回 false')
})

check('matchesCompiled: 分类不匹配返回 false', () => {
  const compiled = engine.compileRules({ keyword: 'cat###abc' })
  const r = engine.matchesCompiled(compiled.keyword, 'abc', 'other')
  assert.strictEqual(r, false, '分类不匹配应返回 false')
})

check('matchesCompiled: 空编译结果返回 false', () => {
  const r = engine.matchesCompiled({}, 'abc', 'cat')
  assert.strictEqual(r, false, '空编译结果应返回 false')
})

check('matchesCompiled: 正则不区分大小写', () => {
  const compiled = engine.compileRules({ keyword: 'cat###ABC' })
  const r = engine.matchesCompiled(compiled.keyword, 'abc', 'cat')
  assert.strictEqual(r, true, '正则应不区分大小写')
})

// ===== checkTimeCompiled =====
check('checkTimeCompiled: 时间在范围内返回 true（拦截）', () => {
  const compiled = engine.compileRules({ pingbitime: 'cat###5' })
  const group = { catename: 'cat', louzhuregtime: Date.now() - 3 * 24 * 60 * 60 * 1000 }
  const r = engine.checkTimeCompiled(compiled.pingbitime, group)
  assert.strictEqual(r, true, '3天前注册在5天范围内应拦截')
})

check('checkTimeCompiled: 时间超出范围返回 false（不拦截）', () => {
  const compiled = engine.compileRules({ pingbitime: 'cat###1' })
  const group = { catename: 'cat', louzhuregtime: Date.now() - 5 * 24 * 60 * 60 * 1000 }
  const r = engine.checkTimeCompiled(compiled.pingbitime, group)
  assert.strictEqual(r, false, '5天前注册超出1天范围不拦截')
})

check('checkTimeCompiled: 分类不匹配返回 false（不拦截）', () => {
  const compiled = engine.compileRules({ pingbitime: 'cat###5' })
  const group = { catename: 'other', louzhuregtime: Date.now() }
  const r = engine.checkTimeCompiled(compiled.pingbitime, group)
  assert.strictEqual(r, false, '分类不匹配不拦截')
})

check('checkTimeCompiled: 空编译结果返回 null（不拦截）', () => {
  const r = engine.checkTimeCompiled(null, { catename: 'cat', louzhuregtime: Date.now() })
  assert.strictEqual(r, null, '空编译结果应返回 null')
})

check('checkTimeCompiled: louzhuregtime 在范围内返回 true（拦截）', () => {
  const compiled = engine.compileRules({ pingbitime: 'cat###5' })
  const group = { catename: 'cat', louzhuregtime: Date.now() - 3 * 24 * 60 * 60 * 1000 }
  const r = engine.checkTimeCompiled(compiled.pingbitime, group)
  assert.strictEqual(r, true, '3天前注册在5天范围内应拦截')
})
check('checkTimeCompiled: louzhuregtime 超出范围返回 false（不拦截）', () => {
  const compiled = engine.compileRules({ pingbitime: 'cat###1' })
  const group = { catename: 'cat', louzhuregtime: Date.now() - 5 * 24 * 60 * 60 * 1000 }
  const r = engine.checkTimeCompiled(compiled.pingbitime, group)
  assert.strictEqual(r, false, '5天前注册超出1天范围不拦截')
})
check('checkTimeCompiled: 无 louzhuregtime 返回 null（不拦截）', () => {
  const compiled = engine.compileRules({ pingbitime: 'cat###5' })
  const r = engine.checkTimeCompiled(compiled.pingbitime, { catename: 'cat' })
  assert.strictEqual(r, null, '无 louzhuregtime 应返回 null')
})

// ===== validateConfig =====
check('validateConfig: 空配置无警告', () => {
  const warnings = engine.validateConfig({})
  assert.strictEqual(warnings.length, 0, '空配置应无警告')
})

check('validateConfig: 非字符串值告警', () => {
  const warnings = engine.validateConfig({ keyword: 123 })
  assert.ok(warnings.some(w => w.includes('应为字符串')), '非字符串值应告警')
})

check('validateConfig: 多行模式下某行缺少 ### 分隔符告警', () => {
  const warnings = engine.validateConfig({ keyword: 'cat###abc\nbadline' })
  assert.ok(warnings.some(w => w.includes('缺少') && w.includes('分隔符')), '缺少分隔符应告警')
  assert.ok(warnings.some(w => w.includes('badline')), '警告应包含缺少分隔符的行')
})

check('validateConfig: 多个 ### 告警', () => {
  const warnings = engine.validateConfig({ keyword: 'a###b###c' })
  assert.ok(warnings.some(w => w.includes('多个')), '多个 ### 应告警')
})

check('validateConfig: 值正则为空告警', () => {
  const warnings = engine.validateConfig({ keyword: 'cat###' })
  assert.ok(warnings.some(w => w.includes('为空')), '空值应告警')
})

check('validateConfig: 嵌套量词告警', () => {
  const warnings = engine.validateConfig({ keyword: 'cat###(a+)+' })
  assert.ok(warnings.some(w => w.includes('嵌套量词')), '嵌套量词应告警')
})

check('validateConfig: 非法正则在 re2 可用时告警', () => {
  const engineRe2 = createRuleEngine({
    Utils: mockUtils,
    FILTER_FIELDS: ['keyword'],
    compileUserRegex: (src) => { try { return new RegExp(src) } catch (e) { return null } },
    isRe2Available: () => true
  })
  const warnings = engineRe2.validateConfig({ keyword: 'cat###[invalid' })
  assert.ok(warnings.some(w => w.includes('无效') || w.includes('不支持')), 're2 可用时非法正则应告警')
})

check('validateConfig: pingbitime 首尾空白告警', () => {
  const warnings = engine.validateConfig({ pingbitime: '  5  ' })
  assert.ok(warnings.some(w => w.includes('首尾空白')), '首尾空白应告警')
})

check('validateConfig: pingbitime 非数字告警', () => {
  const warnings = engine.validateConfig({ pingbitime: 'abc' })
  assert.ok(warnings.length > 0, '非数字 pingbitime 应有告警')
})

check('validateConfig: 正常配置无警告', () => {
  const warnings = engine.validateConfig({ keyword: 'cat###abc' })
  assert.strictEqual(warnings.length, 0, '正常配置应无警告')
})

// ===== validateConfig: RULES-02/03/04（qodo #147-3）=====
check('validateConfig: 过滤字段抛错 getter 只告警不抛穿（RULES-04）', () => {
  const cfg = {}
  Object.defineProperty(cfg, 'keyword', { enumerable: true, get () { throw new Error('boom-keyword') } })
  let warnings
  assert.doesNotThrow(() => { warnings = engine.validateConfig(cfg) }, '抛错 getter 不得抛穿 validateConfig')
  assert.ok(warnings.some(w => w.includes('读取失败') && w.includes('keyword')), '应告警该字段读取失败')
  assert.ok(warnings.some(w => w.includes('已忽略该字段过滤')), '应按「无该字段」处理（跳过而非中断）')
})

check('validateConfig: zkt_gjc 抛错 getter 只告警不抛穿（RULES-04）', () => {
  const cfg = {}
  Object.defineProperty(cfg, 'zkt_gjc', { get () { throw new Error('boom-zkt') } })
  let warnings
  assert.doesNotThrow(() => { warnings = engine.validateConfig(cfg) }, '抛错 getter 不得抛穿 validateConfig')
  assert.ok(warnings.some(w => w.includes('读取失败') && w.includes('zkt_gjc')), '应告警 zkt_gjc 读取失败')
})

check('validateConfig: pingbifenlei 抛错 getter 只告警不抛穿（RULES-04）', () => {
  const cfg = {}
  Object.defineProperty(cfg, 'pingbifenlei', { get () { throw new Error('boom-pbfl') } })
  let warnings
  assert.doesNotThrow(() => { warnings = engine.validateConfig(cfg) }, '抛错 getter 不得抛穿 validateConfig')
  assert.ok(warnings.some(w => w.includes('读取失败') && w.includes('pingbifenlei')), '应告警 pingbifenlei 读取失败')
})

check('validateConfig: pingbitime 抛错 getter 只告警不抛穿', () => {
  const cfg = {}
  Object.defineProperty(cfg, 'pingbitime', { get () { throw new Error('boom-pb') } })
  let warnings
  assert.doesNotThrow(() => { warnings = engine.validateConfig(cfg) }, '抛错 getter 不得抛穿 validateConfig')
  assert.ok(warnings.some(w => w.includes('无法转换为字符串')), '应告警 pingbitime 无法转换为字符串')
})

check('validateConfig: 模式含零宽字符（U+200B-200D/U+FEFF）告警（RULES-02）', () => {
  for (const c of ['\u200B', '\u200C', '\u200D', '\uFEFF']) {
    const code = 'U+' + c.codePointAt(0).toString(16).toUpperCase()
    const warnings = engine.validateConfig({ keyword: `cat###a${c}b` })
    assert.ok(warnings.some(w => w.includes('零宽字符')), `模式含零宽 ${code} 应告警`)
  }
  const simple = engine.validateConfig({ keyword: 'a\u200Bb' })
  assert.ok(simple.some(w => w.includes('零宽字符')), '简单模式（无 ###）零宽也应告警')
})

check('validateConfig: pingbitime 简单形态超上限告警（RULES-03）', () => {
  const warnings = engine.validateConfig({ pingbitime: '3650001' })
  assert.ok(warnings.some(w => w.includes('超过上限') && w.includes('已忽略')), '简单形态超上限应告警')
})

check('validateConfig: pingbitime 恰为上限 3650000 不告警（边界）', () => {
  const warnings = engine.validateConfig({ pingbitime: '3650000' })
  assert.strictEqual(warnings.length, 0, '恰为上限不应告警')
})

check('validateConfig: pingbitime 多行形态超上限告警', () => {
  const warnings = engine.validateConfig({ pingbitime: 'cat###3650001' })
  assert.ok(warnings.some(w => w.includes('超过上限') && w.includes('天数值')), '多行形态超上限应告警')
})

// 夹具契约：mockUtils.parseTime 必须与生产 Utils.parseTime 同语义。
// 这条非法日期分支此前没有被任何断言覆盖——注毒实验（把 return 改成 d.getTime()）后套件仍绿，故补上。
check('mockUtils.parseTime：非法日期返回 null', () => {
  assert.strictEqual(mockUtils.parseTime('不是日期'), null)
})

check('mockUtils.parseTime：合法日期返回毫秒时间戳', () => {
  assert.strictEqual(mockUtils.parseTime('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'))
})

// ===== FILTER-01 / RULES-05：规则「实际编译生效」指纹 =====
// 反例（改动前）：filterHash 只由配置字节驱动。同一份配置在 re2 缺失（compileUserRegex 恒返回 null，
// 见 xbk_function_v3.js 的 `if (!RE2C) return null`）或规则被 ReDoS 守卫丢弃时，过滤面变宽但哈希不变，
// 缓存里已打 _f 的条目永不重评。compileStateOf 是折进 filterHash 的那个维度，本条断言它对
// 「同一配置 × 不同编译结果」必须产出**不同且稳定**的指纹。
check('compileStateOf: 同一配置在 re2 缺失/规则编译失败时指纹不同（驱动 _f 失效）', () => {
  const noRe2 = createRuleEngine({
    Utils: mockUtils,
    FILTER_FIELDS: ['keyword'],
    compileUserRegex: () => null, // 真环境 RE2 缺失时 compileUserRegex 恒 null
    isRe2Available: () => false
  })
  const withRe2 = createRuleEngine({
    Utils: mockUtils,
    FILTER_FIELDS: ['keyword'],
    compileUserRegex: (src, flags) => new RegExp(src, flags),
    isRe2Available: () => true
  })
  const cfg = { keyword: 'abc' } // 配置字节完全相同
  const sNo = noRe2.compileStateOf(noRe2.compileRules(cfg))
  const sYes = withRe2.compileStateOf(withRe2.compileRules(cfg))
  assert.notStrictEqual(sNo, sYes, '同一配置在 re2 不可用时的编译生效指纹必须不同（否则 filterHash 不变、_f 永不失效）')
  assert.ok(sNo.includes('re2=0') && sNo.includes('keyword=null'), `re2 缺失应记 re2=0 且字段未编译: ${sNo}`)
  assert.ok(sYes.includes('re2=1') && sYes.includes('keyword=re'), `re2 可用应记 re2=1 且字段已编译: ${sYes}`)
  // 稳定性：同一环境内必须逐字节一致，否则 App 每轮都清 _f、每轮全量重评
  assert.strictEqual(sNo, noRe2.compileStateOf(noRe2.compileRules(cfg)), '同一环境内指纹必须稳定')
  assert.strictEqual(sYes, withRe2.compileStateOf(withRe2.compileRules(cfg)), '同一环境内指纹必须稳定')
  // 多行规则条数纳入指纹（规则被逐行丢弃时条数变化 → 指纹变化）
  assert.ok(withRe2.compileStateOf(withRe2.compileRules({ keyword: 'cat###a\ncat###b' })).includes('keyword=multi:2'),
    '多行规则条数应纳入指纹')
  // ReDoS 守卫丢弃（hasNestedQuantifier）与正常编译必须可区分
  const guarded = withRe2.compileStateOf(withRe2.compileRules({ keyword: '(a+)+' }))
  assert.ok(guarded.includes('keyword=null'), `被 ReDoS 守卫丢弃的规则应记为未编译: ${guarded}`)
  assert.notStrictEqual(guarded, sYes, '丢弃与生效的指纹必须可区分（守卫口径变化也能驱动 _f 失效）')
  // 脏输入不得抛穿
  assert.strictEqual(withRe2.compileStateOf(null), withRe2.compileStateOf(undefined), '空编译结果应返回同一退化指纹')
  assert.ok(withRe2.compileStateOf(null).includes('keyword=null'), '空编译结果的字段一律记为未编译')
})

// === _validateCatRe（PlanA）：空值 / 嵌套量词 / re2 有效性三条分支 ===
check('_validateCatRe：空分类（null/undefined）只产出一条空值警告并早退', () => {
  const e = createRuleEngine({ Utils: {}, FILTER_FIELDS: ['keyword'], compileUserRegex: () => true, isRe2Available: () => false })
  const w = []
  assert.strictEqual(e._validateCatRe(null, 'keyword', w), undefined, '空分类不得返回非 undefined')
  assert.strictEqual(w.length, 1, 'null 只产出一条警告')
  assert.ok(w[0].endsWith('配置「keyword」分类正则为空，该行将被忽略'), `空值警告文本必须精确：${w[0]}`)
  const w2 = []
  e._validateCatRe(undefined, 'pingbitime', w2)
  assert.strictEqual(w2.length, 1, 'undefined 与 null 走同一分支')
  assert.ok(w2[0].endsWith('配置「pingbitime」分类正则为空，该行将被忽略'), `field 必须出现在警告里：${w2[0]}`)
})

check('_validateCatRe：嵌套量词/交替歧义分支优先于 re2 有效性检查', () => {
  const e = createRuleEngine({ Utils: {}, FILTER_FIELDS: ['keyword'], compileUserRegex: () => true, isRe2Available: () => true })
  const w = []
  e._validateCatRe('(a+)+', 'keyword', w)
  assert.strictEqual(w.length, 1, '嵌套量词必须恰好产出一条警告')
  assert.ok(w[0].endsWith('配置「keyword」分类正则含嵌套量词，可能导致灾难性回溯，该行将被忽略：「(a+)+」'), `嵌套量词警告文本必须精确：${w[0]}`)
  const w2 = []
  e._validateCatRe('(a|aa)+', 'pingbitime', w2)
  assert.strictEqual(w2.length, 1, '交替歧义同样命中嵌套量词分支')
  assert.ok(w2[0].includes('「(a|aa)+」'), '警告必须回显被拦下的模式')
  const w3 = []
  e._validateCatRe('abc', 'keyword', w3)
  assert.strictEqual(w3.length, 0, '合法分类正则不得产生任何警告（杀条件被强制为 true）')
})

check('_validateCatRe：仅当 re2 可用时才做正则有效性检查', () => {
  const noRe2 = createRuleEngine({ Utils: {}, FILTER_FIELDS: ['keyword'], compileUserRegex: () => false, isRe2Available: () => false })
  const w = []
  noRe2._validateCatRe('BAD', 'keyword', w)
  assert.strictEqual(w.length, 0, 're2 不可用时不得做有效性检查（否则不可编译模式被误报）')
  const re2e = createRuleEngine({ Utils: {}, FILTER_FIELDS: ['keyword'], compileUserRegex: (p) => p !== 'BAD', isRe2Available: () => true })
  const w2 = []
  re2e._validateCatRe('GOOD', 'keyword', w2)
  assert.strictEqual(w2.length, 0, 're2 可用且模式有效时不得告警')
  const w3 = []
  re2e._validateCatRe('BAD', 'pingbitime', w3)
  assert.strictEqual(w3.length, 1, 're2 可用且模式无效时必须告警')
  assert.ok(w3[0].endsWith('配置「pingbitime」分类正则无效：「BAD」'), `无效正则警告文本必须精确：${w3[0]}`)
})

check('_validateCatRe：有效性检查必须以 String(cat) 与固定 i 标志调用 compileUserRegex', () => {
  // 反例（改动前）：三条分支用例只断言「有没有告警」，从没捕获 compileUserRegex 的实参——
  // 于是 L145 的固定标志 'i'（StringLiteral）与 String(cat) 化都可被改掉而无人发现。
  const seen = []
  const e = createRuleEngine({
    Utils: {},
    FILTER_FIELDS: ['keyword'],
    compileUserRegex: (p, f) => { seen.push([p, f]); return 'COMPILED' },
    isRe2Available: () => true
  })
  e._validateCatRe('abc', 'keyword', [])
  assert.deepStrictEqual(seen, [['abc', 'i']], '必须恰好以 (模式, 固定 i 标志) 调一次 compileUserRegex')
  seen.length = 0
  e._validateCatRe(42, 'keyword', [])
  assert.deepStrictEqual(seen, [['42', 'i']], '非字符串分类必须先 String() 化再进编译（与 _compileCatRe 同口径）')
  seen.length = 0
  e._validateCatRe('(a+)+', 'keyword', [])
  assert.deepStrictEqual(seen, [], '嵌套量词分支必须早退，不得进入编译')
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_rules_extended.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
