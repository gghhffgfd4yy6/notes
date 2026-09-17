'use strict'

// 补 xbk_rules.js 覆盖率：嵌套量词检测 + pingbitime 首尾空白 + 缺少分隔符
const assert = require('node:assert')
const { createRuleEngine } = require('./xbk_rules')

// mock 依赖：validateConfig 内部使用闭包 safeStr（xbk_rules.js:367），从不调用 Utils.safeStr；
// Utils 仅在 match/_anyRule 的 checkTimeCompiled 路径经 Utils.safeGet/parseTime/daysFrom 使用。
// 本文件只覆盖 validateConfig，故 Utils 传空占位对象即可（此前提供的 safeStr stub 是死代码，已删除）。
// compileUserRegex 返回 true（模拟正则编译成功，跳过无效正则检查），isRe2Available 返回 false（跳过 re2 检查）
const engine = createRuleEngine({
  Utils: {},
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

// 4. RULES-01：取反字符类 [^...] 必须扫描到未转义的类结束符，类体不得被当普通模式解析
{
  const expectNested = (pattern, expected, message) => assert.strictEqual(engine.hasNestedQuantifier(pattern), expected, message)
  // 误拦修复：整个 [^(a+)+] 是字符类，(a+)+ 只是类成员（旧实现只判 ^ 后一个字符，把类体
  // 当模式解析 → 误判 true）
  expectNested('[^(a+)+]x', false, '[^(a+)+] 是字符类，类内 (a+)+ 不是嵌套量词')
  expectNested('[^(a+)+]', false, '[^(a+)+] 单独也是字符类')
  // 漏检修复：'(x[^)]+)+' 的 ) 曾被吞进 [^)] 的类体 → 分组永不闭合（旧实现误判 false）；
  // 类体扫描到 ] 后，「组内以无限量词结尾 + 组后无限量词」的既有判定应命中
  expectNested('(x[^)]+)+', true, '(x[^)]+)+ 应判危险（组内无限量词 + 组后无限量词）')
  // 既有语义不变
  expectNested('[^](a+)+', true, '[^]（^ 后的 ] 是类成员）后的嵌套量词仍应检出')
  expectNested('[^]', false, '[^] 本身是字符类，不判危险')
  expectNested('[^a+]+', false, '取反类内量词 + 类后量词不构成嵌套分组')
}

console.log('test_rules OK')
