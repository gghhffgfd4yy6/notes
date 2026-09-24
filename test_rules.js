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

// 5. hasNestedQuantifier 语义矩阵（PlanA 121 靶）：只取布尔值，绝不真正编译/执行 (a+)+ 这类危险模式
{
  // 每项都写明期望值——assert.ok 杀不掉 true/false 互换的变异体
  const nested = (pattern, expected, why) => assert.strictEqual(engine.hasNestedQuantifier(pattern), expected, `${why}：${pattern}`)

  // 无限量词识别：+ * {n,} 是无限；{n} {n,m} 有界
  nested('(a+)+', true, '组内以 + 结尾 + 组后 + → 灾难性回溯')
  nested('(a*)*', true, '组内以 * 结尾 + 组后 * → 灾难性回溯')
  nested('(a+){2,}', true, '组后 {n,} 无上限=无限量词，与组内 + 构成嵌套')
  nested('(a|aa){2,}', true, '组内交替 + 组后无限 {n,}')
  nested('(a+)?', false, '组后 ? 不参与 infQuantLen（有界/零次） → 安全')
  nested('(a+){2}', false, '组后 {n} 有界 → 安全')
  nested('(a+){2,3}', false, '组后 {n,m} 有界 → 安全')
  nested('a+b*', false, '无分组，量词并列不构成嵌套')
  nested('a+(b*)', false, '组内有无限量词但组后无无限量词 → 安全')
  nested('(a+)', false, '未量化的分组不构成嵌套')

  // 嵌套分组向上传播 inf（((a+))+ 曾漏检）
  nested('((a+))+', true, '中间组 (a+) 闭合后「含无限量词」必须传播给外层')
  nested('(?:a+)+', true, '非捕获分组按普通分组处理')
  nested('(\\d+)+', true, '转义 \\d 后接 + 仍是无限量词结尾')
  nested('(a?)+', true, '组内以 ? 结尾可匹配空串，组后 + 同样灾难性')

  // 交替歧义：组内含 | 且组后无限量词
  nested('(a|aa)+', true, '歧义交替 + 无限量词（曾漏检，30a 已 156ms）')
  nested('((a|aa))+', true, '嵌套分组的交替歧义同样向上传播')
  nested('(a|aa)', false, '只有交替、组后无无限量词 → 安全')
  nested('(a|aa)?', false, '交替 + 可选量词 → 安全')
  nested('(x|y)', false, '普通交替组不判危险')

  // 有界重复 + 组内歧义：阈值 10 的 n-1 / n / n+1
  nested('(a+){9}', false, '阈值下界 n-1：9 < 10 不拦')
  nested('(a+){10}', true, '阈值边界 n=10 必须拦（>= 判定）')
  nested('(a+){11}', true, '阈值上界 n+1：11 必须拦')
  nested('(a|aa){9}', false, '交替重复 9 次 < 10 不拦')
  nested('(a|aa){10}', true, '交替重复 10 次必须拦')
  nested('(a|aa){30}', true, '交替重复 30 次（实测 8-12s 卡死）必须拦')
  nested('(a+){8,9}', false, '上下界都 < 10 不拦')
  nested('(a+){9,10}', true, '上界 hi=10 达阈值即拦（hi 分支）')
  nested('(a+){2,9}', false, 'hi=9 < 10 不拦')
  nested('(a+){1,20}', true, 'lo=1 但 hi=20 达阈值即拦')
  nested('(a){10}', false, '组内无无限量词/交替时，有界重复不得误拦')
  nested('(ab){50}', false, '同一守卫：普通组大批量重复安全')
  nested('(a){2,3}', false, '普通组小批量重复安全')
  nested('(a)+', false, '组内末尾无无限量词，组后 + 不构成嵌套')

  // 字符类必须整体当普通 token
  nested('[+*]', false, '类内 + * 是类成员，不是量词')
  nested('[)]', false, '类内 ) 不闭合分组')
  nested('[^(a+)+]x', false, '取反类整体是字符类，类体 (a+)+ 不得被当分组（曾误拦）')
  nested('[^(a+)+]', false, '同上，单独出现也不判危险')
  nested('[]]', false, '空类 ] 开头写法必须整体跳过')
  nested('[]', false, '空字符类')
  nested('[^]', false, '[^] 是非空字符类，不是嵌套量词')
  nested('[^a+]+', false, '取反类内量词 + 类后量词不构成嵌套分组')
  nested('(x[^)]+)+', true, '类体必须扫到 ]：否则 ) 被吞进类体导致漏检，这里必须命中')
  nested('[^](a+)+', true, '[^] 后的 (a+)+ 不得被吞进类体')
  nested('[^]](a+)+', true, '[^]] 场景：类结束于第二个 ]，其后嵌套量词仍须检出')
  nested('[\\]](a+)+', true, '类体内被转义的 ] 不结束字符类，其后嵌套量词仍须检出')

  // 转义：一律视为普通 token
  nested('\\(a\\+\\)\\+', false, '整体被转义，没有真实分组与量词')
  nested('\\\\(', false, '转义反斜杠后的 ( 不算分组起点')
  nested('\\d+', false, '转义序列 \\d 后接 + 不构成嵌套')
  nested('(a\\+)+', false, '组内末尾是被转义的 + → 组内没有无限量词结尾（杀转义分支 cur.inf=true）')
  nested('(a\\+)*', false, '同上，* 版本')

  // 多余右括号 / 不闭合左括号 / 空串
  nested(')', false, '多余右括号直接忽略')
  nested('a)b', false, '普通文本里的右括号不构成分组')
  nested('(a+', false, '左括号未闭合 → 不判危险')
  nested('', false, '空串')
  nested('abc', false, '无分组无量词')

  // 非常规输入：String() 兜底与 try/catch 守卫
  assert.strictEqual(engine.hasNestedQuantifier(undefined), false, 'undefined → false（不得抛穿）')
  assert.strictEqual(engine.hasNestedQuantifier(null), false, 'null → false（不得落到 /null/ 字面量语义）')
  assert.strictEqual(engine.hasNestedQuantifier(Symbol('nested')), false, 'Symbol 守卫：不得抛 TypeError')
  assert.strictEqual(engine.hasNestedQuantifier([Symbol('x')]), false, '嵌套 Symbol 数组 String() 会抛，必须被 try/catch 兜住')
  assert.strictEqual(engine.hasNestedQuantifier(0), false, '数字经 String() 兜底')
  assert.strictEqual(engine.hasNestedQuantifier(123), false, '数字经 String() 兜底')
  assert.strictEqual(engine.hasNestedQuantifier([1, 2]), false, '数组经 String() 兜底')
  assert.strictEqual(engine.hasNestedQuantifier({}), false, '对象 → [object Object]，字符类扫描后可正常结束')
  assert.strictEqual(engine.hasNestedQuantifier(true), false, '布尔经 String() 兜底')
  assert.strictEqual(engine.hasNestedQuantifier({ toString: () => '(a+)+' }), true, 'String() 兜底必须真调用（否则对象输入恒判安全、漏检）')
}

// 6. _compileCatRe：分类正则编译入口（空值早退 / ReDoS 守卫 / 正常编译）
{
  const seen = []
  const e2 = createRuleEngine({
    Utils: {},
    FILTER_FIELDS: ['keyword'],
    compileUserRegex: (p, f) => { seen.push([p, f]); return 'COMPILED' },
    isRe2Available: () => false
  })
  assert.strictEqual(e2._compileCatRe('abc'), 'COMPILED', '正常分类正则必须原样返回 compileUserRegex 的结果')
  assert.deepStrictEqual(seen[0], ['abc', 'i'], '必须以 String(cat) 与固定 i 标志调用 compileUserRegex')
  assert.strictEqual(e2._compileCatRe(123), 'COMPILED', '数字分类应经 String() 兜底后编译')
  assert.strictEqual(seen[1][0], '123', '数字必须转成字符串（防 RegExp(123) 隐式语义漂移）')
  assert.strictEqual(e2._compileCatRe(null), null, 'null 必须显式返回 null（不得编译成 /null/i 字面量）')
  assert.strictEqual(e2._compileCatRe(undefined), null, 'undefined 必须显式返回 null')
  assert.strictEqual(e2._compileCatRe('(a+)+'), null, '嵌套无限量词（ReDoS 高危）必须返回 null 不编译')
  assert.strictEqual(e2._compileCatRe('(a|aa)+'), null, '交替歧义同样被 ReDoS 守卫拦下')
  assert.strictEqual(seen.length, 2, '空值与被守卫拦下的模式都不得进入 compileUserRegex')
}

// 5b. 传播/推进路径的补充对：杀「inf/alt 向上传播」与「字面量恒真/恒假」类变异体
{
  const nested = (pattern, expected, why) => assert.strictEqual(engine.hasNestedQuantifier(pattern), expected, `${why}：${pattern}`)
  // 组内没有无限量词、外层组后才有无限量词 → 安全；只有「传播条件被强制为真」才会误判危险
  nested('((a))+', false, '普通嵌套分组后置 + 不得仅凭 parent.inf 就判危险')
  nested('(((a)))+', false, '同上，两层嵌套')
  // 组内的「组后无限量词」必须经 parent.inf 推进到外层（((a)+)+ 靠这条路径才危险）
  nested('((a)+)+', true, '中间组 (a)+ 的组后 + 必须推进为外层组的无限量词结尾')
  // 字符类整体跳过后其后的嵌套量词仍须检出（杀字符类扫描分支被短路）
  nested('[+*](a+)+', true, '普通字符类跳过后仍须检出后续嵌套量词')
  nested('[)]+(a+)+', true, '类后量词 + 后续嵌套量词')
  nested('[]](a+)+', true, '空类 ] 开头写法跳过后仍须检出后续嵌套量词')
}

console.log('test_rules OK')
