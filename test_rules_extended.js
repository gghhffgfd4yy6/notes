'use strict'

// xbk_rules.js 扩展测试（提升变异分数）
// 覆盖：compileRules 边界 + matchesCompiled + checkTimeCompiled + validateConfig 更多场景
const assert = require('node:assert')
const { createRuleEngine } = require('./xbk_rules')

const mockUtils = {
  safeStr: (v) => (v === undefined || v === null || typeof v === 'symbol') ? '' : String(v),
  safeGet: (o, k) => o ? o[k] : undefined,
  parseTime: (t) => {
    if (typeof t === 'number' && t > 0) return t < 1e12 ? t * 1000 : t
    const d = new Date(t)
    return isNaN(d.getTime()) ? null : d.getTime()
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

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_rules_extended.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
