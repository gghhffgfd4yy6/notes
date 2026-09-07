'use strict'

// 补 xbk_rules.js 覆盖率：嵌套量词检测 + pingbitime 首尾空白 + 缺少分隔符
const assert = require('node:assert')
const { createRuleEngine } = require('./xbk_rules')

// mock 依赖：compileUserRegex 返回 true（模拟正则编译成功，跳过无效正则检查），isRe2Available 返回 false（跳过 re2 检查）
const mockUtils = {
  safeStr: (v) => (v === undefined || v === null || typeof v === 'symbol') ? '' : String(v)
}
const engine = createRuleEngine({
  Utils: mockUtils,
  FILTER_FIELDS: ['keyword'],
  compileUserRegex: () => true,
  isRe2Available: () => false
})

// 1. 嵌套量词检测：keyword 多行模式下某行值含嵌套量词 (a+)+
{
  const warnings = engine.validateConfig({ keyword: 'cat###(a+)+' })
  assert.ok(warnings.some(w => w.includes('嵌套量词')), '应检测到嵌套量词 (a+)+')
  assert.ok(warnings.some(w => w.includes('(a+)+')), '警告应包含嵌套量词值')
}

// 2. pingbitime 含首尾空白警告（非 ### 模式）
{
  const warnings = engine.validateConfig({ pingbitime: '  5  ' })
  assert.ok(warnings.some(w => w.includes('首尾空白')), '应警告 pingbitime 含首尾空白')
}

// 3. pingbitime ### 模式下某行缺少 ### 分隔符
{
  const warnings = engine.validateConfig({ pingbitime: 'foo###bar\nbadline' })
  assert.ok(warnings.some(w => w.includes('缺少') && w.includes('分隔符')), '应警告行缺少 ### 分隔符')
  assert.ok(warnings.some(w => w.includes('badline')), '警告应包含缺少分隔符的行')
}

console.log('test_rules OK')
