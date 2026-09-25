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

// ===================== planB 追加（变异靶：_splitLines / compileRules / validateConfig）=====================
// 注入的 compileUserRegex / isRe2Available 用可变旗标，同一引擎覆盖「re2 可用 / 不可用」两侧；
// 每次调用记录实参，锁死契约要求的固定 'i' 标志与 String() 化（re2 缺失时禁止回退 V8）。
// 断言全部走精确值（strictEqual / deepStrictEqual），且尽可能真假两侧成对。
const r2Re2 = { on: false }
const r2Calls = []
const r2Compile = (src, flags) => {
  r2Calls.push([String(src), flags])
  return /BAD/.test(String(src)) ? null : new RegExp(String(src), flags)
}
const r2Utils = {
  safeGet: (o, k) => (o === null || o === undefined ? undefined : o[k]),
  safeErrorText: (err, dflt) => String((err && err.message) || dflt || '')
}
const r2Make = (fields) => createRuleEngine({
  Utils: r2Utils,
  FILTER_FIELDS: fields,
  compileUserRegex: r2Compile,
  isRe2Available: () => r2Re2.on
})
const r2Warn = (fn) => {
  const warns = []
  const orig = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try { fn() } finally { console.warn = orig }
  return warns
}

// 杀 _splitLines L153/L155：undefined/null/Symbol 必须早退为空数组；String() 抛错走 catch 返回空数组（不得返回占位数组）；多行切分含 <br/>
{
  const r2e = r2Make(['keyword'])
  assert.deepStrictEqual(r2e._splitLines(undefined), [])
  assert.deepStrictEqual(r2e._splitLines(null), [])
  assert.deepStrictEqual(r2e._splitLines(Symbol('r2')), [])
  assert.deepStrictEqual(r2e._splitLines(''), [])
  assert.deepStrictEqual(r2e._splitLines({ toString () { throw new Error('boom') } }), [])
  assert.deepStrictEqual(r2e._splitLines('a###b<br/>c###d\r\ne###f'), ['a###b', 'c###d', 'e###f'])
  assert.strictEqual(r2e._splitLines('no-delim'), null)
}

// 杀 compileRules L179/L183/L186/L191：非字符串（数字/布尔/函数/Symbol）与空串一律置 null，告警文本精确
{
  const r2e = r2Make(['keyword'])
  assert.strictEqual(r2e.compileRules({ keyword: undefined }).keyword, null)
  assert.strictEqual(r2e.compileRules({ keyword: null }).keyword, null)
  assert.strictEqual(r2e.compileRules({ keyword: Symbol('r2') }).keyword, null)
  assert.strictEqual(r2e.compileRules({ keyword: '' }).keyword, null)
  assert.strictEqual(r2e.compileRules({ keyword: 123 }).keyword, null)
  assert.strictEqual(r2e.compileRules({ keyword: true }).keyword, null)
  assert.strictEqual(r2e.compileRules({ keyword: () => {} }).keyword, null)
  const w = r2Warn(() => r2e.compileRules({ keyword: 123 }))
  assert.deepStrictEqual(w, ['⚠️ 规则「keyword」的值必须为字符串（当前为 number），已跳过'])
  assert.strictEqual(r2e.compileRules({}).__compiled, true)
}

// 杀 compileRules L207/L209/L211/L212/L226：仅多于两段才告警、空值行跳过、source 必须为 trim 后的行
{
  const r2e = r2Make(['keyword'])
  const w1 = r2Warn(() => {
    const c = r2e.compileRules({ keyword: 'a###b###c' })
    assert.strictEqual(c.keyword._type, 'multi')
    assert.strictEqual(c.keyword.rules.length, 1)
    assert.strictEqual(c.keyword.rules[0].source, 'a###b###c')
  })
  assert.deepStrictEqual(w1, ['⚠️ 配置「keyword」行包含多个 ###，仅前两段生效：「a###b###c」'])
  const w2 = r2Warn(() => {
    assert.strictEqual(r2e.compileRules({ keyword: 'a###b<br>c###d' }).keyword.rules.length, 2)
    assert.strictEqual(r2e.compileRules({ keyword: 'a###b<br>nodelim' }).keyword.rules.length, 1)
  })
  assert.deepStrictEqual(w2, [])
  assert.deepStrictEqual(r2e.compileRules({ keyword: 'cat###' }).keyword.rules, [])
  assert.strictEqual(r2e.compileRules({ keyword: ' cat ### val ' }).keyword.rules[0].source, 'cat ### val')
}

// 杀 compileRules L221/L222/L225/L240/L244：re2 可用时非法正则告警并跳过；re2 缺失时静默置 null 且不回退 V8
{
  const r2e = r2Make(['keyword'])
  r2Re2.on = true
  const w1 = r2Warn(() => {
    assert.deepStrictEqual(r2e.compileRules({ keyword: 'cat###BAD' }).keyword.rules, [])
  })
  assert.deepStrictEqual(w1, ['⚠️ 规则「keyword」包含非法正则「BAD」，已跳过（v3.239 口径统一：validateConfig 与 compileRules 均告警）'])
  const w2 = r2Warn(() => {
    assert.strictEqual(r2e.compileRules({ keyword: 'BAD' }).keyword, null)
  })
  assert.deepStrictEqual(w2, ['⚠️ 规则「keyword」无法使用安全正则引擎，已跳过'])
  r2Re2.on = false
  const w3 = r2Warn(() => {
    assert.deepStrictEqual(r2e.compileRules({ keyword: 'cat###BAD' }).keyword.rules, [])
    assert.strictEqual(r2e.compileRules({ keyword: 'BAD' }).keyword, null)
  })
  assert.deepStrictEqual(w3, [])
  assert.strictEqual(r2e.compileRules({ keyword: '  abc  ' }).keyword.source, 'abc')
  assert.strictEqual(r2e.compileRules({ keyword: '   ' }).keyword, null)
  const before = r2Calls.length
  assert.strictEqual(r2e.compileRules({ keyword: '(a+)+' }).keyword, null)
  assert.deepStrictEqual(r2Calls.slice(before), [], '嵌套量词必须在调用 compileUserRegex 之前早退')
}

// 杀 compileRules L255/L256/L263/L264/L271/L272/L273/L274/L283/L286：pingbitime 上下界含等号、超限告警文本精确、空值行跳过、source trim
{
  const r2e = r2Make(['keyword'])
  assert.strictEqual(r2e.compileRules({}).pingbitime, null)
  assert.strictEqual(r2e.compileRules({ pingbitime: '' }).pingbitime, null)
  assert.deepStrictEqual(r2e.compileRules({ pingbitime: '5' }).pingbitime, { _type: 'time', value: 5, source: '5' })
  assert.strictEqual(r2e.compileRules({ pingbitime: '0' }).pingbitime.value, 0)
  assert.strictEqual(r2e.compileRules({ pingbitime: '3650000' }).pingbitime.value, 3650000)
  const w1 = r2Warn(() => {
    assert.strictEqual(r2e.compileRules({ pingbitime: '3650001' }).pingbitime, null)
  })
  assert.deepStrictEqual(w1, ['⚠️ 配置「pingbitime」的值「3650001」超过上限 3650000 天，已忽略'])
  assert.deepStrictEqual(r2Warn(() => r2e.compileRules({ pingbitime: 'abc' })), [])
  const pb = r2e.compileRules({ pingbitime: 'pi ### 5 ' }).pingbitime
  assert.strictEqual(pb._type, 'timeMulti')
  assert.deepStrictEqual(pb.rules, [{ cat: pb.rules[0].cat, value: 5, source: 'pi ### 5' }])
  assert.deepStrictEqual(r2e.compileRules({ pingbitime: 'cat###' }).pingbitime.rules, [])
  assert.deepStrictEqual(r2e.compileRules({ pingbitime: 'cat###-5' }).pingbitime.rules, [])
  assert.strictEqual(r2e.compileRules({ pingbitime: 'cat###0' }).pingbitime.rules[0].value, 0)
  assert.strictEqual(r2e.compileRules({ pingbitime: 'cat###3650000' }).pingbitime.rules[0].value, 3650000)
  const w3 = r2Warn(() => {
    assert.deepStrictEqual(r2e.compileRules({ pingbitime: 'cat###3650001' }).pingbitime.rules, [])
  })
  assert.deepStrictEqual(w3, ['⚠️ 配置「pingbitime」的天数值「3650001」超过上限 3650000 天，已忽略'])
  assert.deepStrictEqual(r2Warn(() => r2e.compileRules({ pingbitime: 'cat###abc' })), [])
}

// 杀 validateConfig L412/L421/L422/L428/L435/L436/L449/L499：空/合法配置零告警、读取失败告警不抛穿、pingbifenlei ### 单一告警、zkt_gjc 非字符串告警
{
  const r2e = r2Make(['keyword', 'pingbifenlei'])
  assert.deepStrictEqual(r2e.validateConfig({}), [])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'abc' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: undefined, pingbifenlei: null }), [])
  assert.deepStrictEqual(r2e.validateConfig({ zkt_gjc: 'abc' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 123 }),
    ['⚠️ 配置「keyword」应为字符串，当前为 number，已忽略该字段过滤'])
  const boom = { get keyword () { throw new Error('boom') } }
  assert.deepStrictEqual(r2e.validateConfig(boom), ['⚠️ 配置「keyword」读取失败（boom），已忽略该字段过滤'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbifenlei: 'a###b' }),
    ['⚠️ 配置「pingbifenlei」不支持 ### 多行分类语法，该规则将被忽略\n   如需按分类屏蔽，请直接写分类名正则，例如：微博|赚客吧'])
  assert.deepStrictEqual(r2e.validateConfig({ zkt_gjc: 123 }),
    ['⚠️ 配置「zkt_gjc」应为字符串，当前为 number，已忽略只看它过滤'])
  assert.deepStrictEqual(r2e.validateConfig({ zkt_gjc: '  ' }), ['⚠️ 配置「zkt_gjc」为空白字符，已忽略只看它过滤'])
}

// 杀 validateConfig L452/L454/L468/L473/L478/L483/L488/L514：多行切分口径、告警值必须 trim、无效/嵌套量词告警文本精确
{
  const r2e = r2Make(['keyword'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'a###b<br/>c###d\r\ne###f' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'a###b<br>  nodelim  ' }),
    ['⚠️ 配置「keyword」行缺少 ### 分隔符，该行将被忽略：「nodelim」'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'a###b###c' }),
    ['⚠️ 配置「keyword」行包含多个 ###，仅前两段生效：「a###b###c」'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'a###' }),
    ['⚠️ 配置「keyword」值正则为空，该行将被忽略（避免永真规则）：「a###」'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'a###(b+)+' }),
    ['⚠️ 配置「keyword」值正则含嵌套量词，可能导致灾难性回溯，该行将被忽略：「(b+)+」'])
  r2Re2.on = true
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'cat###BAD' }),
    ['⚠️ 配置「keyword」值正则无效或当前环境不支持：「BAD」'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: '  BAD  ' }),
    ['⚠️ 配置「keyword」包含无效或当前环境不支持的正则表达式：「BAD」'])
  assert.deepStrictEqual(r2e.validateConfig({ zkt_gjc: 'BAD' }),
    ['⚠️ 配置「zkt_gjc」包含无效或当前环境不支持的正则表达式：「BAD」'])
  r2Re2.on = false
  assert.deepStrictEqual(r2e.validateConfig({ keyword: '   ' }),
    ['⚠️ 配置「keyword」为空白字符，将被忽略'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: '  (a+)+  ' }),
    ['⚠️ 配置「keyword」的正则含嵌套量词，可能导致灾难性回溯，该规则将被忽略：「(a+)+」'])
}

// 杀各处固定 'i' 标志（StringLiteral→""）与 String() 化口径：所有用户正则编译必须带 'i'，且模式集合精确
{
  r2Re2.on = true
  r2Calls.length = 0
  const r2e = r2Make(['keyword', 'pingbifenlei'])
  assert.deepStrictEqual(r2e.validateConfig({ keyword: 'a###b', zkt_gjc: 'z' }), [])
  const c = r2e.compileRules({ keyword: 'abc', pingbitime: 'pi###1' })
  assert.strictEqual(c.pingbitime.rules[0].value, 1)
  assert.deepStrictEqual([...new Set(r2Calls.map(x => x[1]))], ['i'], '所有用户正则编译必须带固定 i 标志（禁止 V8 回退）')
  assert.deepStrictEqual([...new Set(r2Calls.map(x => x[0]))].sort(), ['a', 'abc', 'b', 'pi', 'z'])
  r2Re2.on = false
}

// 杀 validateConfig L522/L523/L527/L530/L539/L541/L545/L548/L549/L550/L552/L553/L559：pingbitime 数值校验的精确边界与告警文本
{
  const r2e = r2Make(['keyword'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: undefined }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: null }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '5' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '0' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '3650000' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: ' 5 ' }),
    ['⚠️ 配置「pingbitime」含首尾空白，已按去空格后的值处理'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '   ' }),
    ['⚠️ 配置「pingbitime」为空白字符，将被忽略'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'abc' }),
    ['⚠️ 配置「pingbitime」的值「abc」不是有效数字（需 ≥0 的有限数）'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '-1' }),
    ['⚠️ 配置「pingbitime」的值「-1」不是有效数字（需 ≥0 的有限数）'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '1.5' }),
    ['⚠️ 配置「pingbitime」的值「1.5」是小数，已按整数处理（建议使用整数天数）'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: '3650001' }),
    ['⚠️ 配置「pingbitime」的值「3650001」超过上限 3650000 天，已忽略'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: { toString () { throw new Error('x') } } }),
    ['⚠️ 配置「pingbitime」无法转换为字符串，已忽略'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###5' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###0' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###3650000' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###5<br>   ' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'abc###5' }), [])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###' }),
    ['⚠️ 配置「pingbitime」的行「a###」天数值为空，已忽略该行'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###-1' }),
    ['⚠️ 配置「pingbitime」的天数值「-1」不是有效数字（需 ≥0 的有限数）'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###1.5' }),
    ['⚠️ 配置「pingbitime」的天数值「1.5」是小数，已按整数处理（建议使用整数天数）'])
  assert.deepStrictEqual(r2e.validateConfig({ pingbitime: 'a###3650001' }),
    ['⚠️ 配置「pingbitime」的天数值「3650001」超过上限 3650000 天，已忽略'])
}

console.log('test_rules OK')
