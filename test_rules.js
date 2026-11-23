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
// 取原生 RegExp 构造器别名：r2Compile 是**测试替身**，需按运行期模式编译，
// 而 Codacy 的「RegExp 构造器收到非字面量」告警针对的是生产代码的不可信输入（此处为误报）。
const NativeRegExp = RegExp
const r2Re2 = { on: false }
const r2Calls = []
const r2Compile = (src, flags) => {
  r2Calls.push([String(src), flags])
  return /BAD/.test(String(src)) ? null : new NativeRegExp(String(src), flags)
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
  assert.deepStrictEqual(w2, ['⚠️ 规则「keyword」包含非法正则「BAD」，已跳过（RE2 可用但编译失败；validateConfig 已告警）'])
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
    ['⚠️ 配置「keyword」值正则含灾难性回溯结构（嵌套量词，或组内交替/无限量词 + 组后重复，如 (a+)+、(a|aa)+），该行将被忽略：「(b+)+」'])
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
    ['⚠️ 配置「keyword」的正则含灾难性回溯结构（嵌套量词，或组内交替/无限量词 + 组后重复，如 (a+)+、(a|aa)+），该规则将被忽略：「(a+)+」'])
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
  assert.deepStrictEqual([...new Set(r2Calls.map(x => x[0]))].sort((a, b) => a.localeCompare(b)), ['a', 'abc', 'b', 'pi', 'z'])
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

// ===================== v3.529（O2）：简单模式切块 =====================
// 整条 alternation 在 RE2 里约 1,300 个顶层分支就掉出 DFA 快路（改走 NFA，成本 ∝ 分支数 × 文本长度），
// 故按行切成 ≤600 分支的小块、命中即短路；判定与整段正则完全等价（存在性语义）。
// 下面每条都是「把切块关掉/改坏就变红」的结构断言：块数、每块上限、巨行隔离、块数上限退化、
// 命中短路、防回退安全网、单行零改写的等价性。
const o2Cases = []
const o2Check = (name, fn) => {
  try { const detail = fn(); o2Cases.push('✅ ' + name + (detail ? '：' + detail : '')) } catch (e) { o2Cases.push('❌ ' + name + '：' + e.message); process.exitCode = 1 }
}
const o2MakeEngine = (compileUserRegex) => createRuleEngine({
  Utils: r2Utils,
  FILTER_FIELDS: ['keyword'],
  compileUserRegex,
  isRe2Available: () => true
})
// 夹具里不含转义 `|`，故「source 里的 | 个数 + 1」= 该块的分支数（与实现同一公式的独立复算）
const o2BranchesOf = (source) => source.split('|').length

o2Check('O2/W4 结构：>600 分支按行切块（700 分支 ⇒ 2 块、每块 ≤600）、切块字段不再编整段', () => {
  const lines = []
  for (let i = 0; i < 350; i++) lines.push('aa' + i + '|bb' + i) // 每行 2 分支 ⇒ 700 分支
  const r = o2MakeEngine(r2Compile).compileRules({ keyword: lines.join('\n') })
  assert.strictEqual(r.keyword._type, 're', '简单模式仍必须是 _type=re（blocks 不改 _type）')
  // W4：切成多块 ⇒ 不再构造整段 RE2（整条在热路径 0 调用，只白占原生内存）；re 为 null 是契约
  assert.strictEqual(r.keyword.re, null, '切成多块后 re 必须是 null（不得再编整段），实际 ' + String(r.keyword.re))
  assert.strictEqual(r.keyword.blocks.length, 2, '700 分支必须切成 2 块（600 + 100），实际 ' + r.keyword.blocks.length)
  for (const b of r.keyword.blocks) {
    assert.ok(b.branches <= 600, '每块分支数必须 ≤600，实际 ' + b.branches)
    assert.strictEqual(o2BranchesOf(b.source), b.branches, '块的 branches 必须与 source 里的分支数一致（' + b.source.slice(0, 20) + '…）')
    assert.ok(b.re && typeof b.re.test === 'function', '每块必须真的编译出可执行正则（re 为 null 的只有整段那条）')
  }
  // 块边界必须与 joinSimpleRegexLines 的 join 边界完全一致：块 source 拼回去 == 整段
  assert.strictEqual(r.keyword.blocks.map((b) => b.source).join('|'), r.keyword.source, '块拼接必须逐字等于整段源码（不拆行、不漏行）')
  assert.strictEqual(r.keyword.blocks[0].branches, 600, '第一块必须恰好 600 分支（累计超 600 才切）')
  // source 必须仍是整段原文（filter.hash / 诊断 ruleHash 口径不变）
  assert.strictEqual(r.keyword.source, lines.join('|'), 'source 必须仍是整段原文（改 re 不改 source）')
  assert.ok(o2MakeEngine(r2Compile).compileStateOf(r).includes('keyword=re'), 'compileStateOf 必须仍输出 keyword=re（它只看 _type）')
  return 'blocks=' + r.keyword.blocks.map((b) => b.branches).join('+') + '，re=null'
})

o2Check('O2 结构：单行 >600 分支的巨行独占一块且只含这一行', () => {
  const giant = Array.from({ length: 713 }, (_, i) => '城' + i).join('|') // 712 个 | ⇒ 713 分支
  const r = o2MakeEngine(r2Compile).compileRules({ keyword: ['甲', '乙|丙', giant, '丁'].join('\n') })
  assert.strictEqual(r.keyword.re, null, '切成 3 块后整段 re 必须是 null（不得再编整段）')
  assert.strictEqual(r.keyword.blocks.length, 3, '巨行必须夹在两块之间独占一块，实际块数 ' + r.keyword.blocks.length)
  assert.strictEqual(r.keyword.blocks[1].branches, 713, '巨行块的分支数必须是 713')
  assert.strictEqual(r.keyword.blocks[1].source, giant, '巨行块必须逐字等于那一行（不得与相邻行拼在一起）')
  assert.strictEqual(r.keyword.blocks[0].source, '甲|乙|丙', '巨行前的行仍按 ≤600 分支成块')
  assert.strictEqual(r.keyword.blocks[2].source, '丁', '巨行后的行单独成块')
  const eng = o2MakeEngine(r2Compile)
  assert.strictEqual(eng.matchesCompiled(r.keyword, '城712'), true, '巨行块必须命中其末位城市')
  assert.strictEqual(eng.matchesCompiled(r.keyword, '丙'), true, '巨行前的块仍须命中')
  assert.strictEqual(eng.matchesCompiled(r.keyword, '戊'), false, '未列出的词仍不命中')
  return 'blocks=' + r.keyword.blocks.map((b) => b.branches).join('+')
})

o2Check('O2 结构：块数超 512 退化为每 1000 分支一块，且只告警一次', () => {
  // 320,000 分支：600 档会切出 534 块（>512）⇒ 退化到 1000 档（320 块）。
  // 编译用替身（返回假 re）——真编译 32 万分支的整条正则既慢又会被引擎规模上限拒掉，
  // 本用例只校验结构，不校验匹配。
  const lines = []
  for (let i = 0; i < 160000; i++) lines.push('k' + i + '|v' + i) // 每行 2 分支
  const eng = o2MakeEngine((src) => ({ test: () => false, source: String(src) }))
  let r = null
  const warns = r2Warn(() => { r = eng.compileRules({ keyword: lines.join('\n') }) })
  assert.strictEqual(warns.length, 1, '块数上限退化必须只告警一次，实际 ' + warns.length + ' 次')
  assert.ok(warns[0].includes('512'), '告警必须点名上限 512，实际：' + warns[0])
  assert.ok(warns[0].includes('keyword'), '告警必须点名字段（便于定位是哪条规则），实际：' + warns[0])
  assert.ok(r.keyword.blocks.length <= 512, '退化后块数必须 ≤512，实际 ' + r.keyword.blocks.length)
  for (const b of r.keyword.blocks) assert.ok(b.branches <= 1000, '退化后每块必须 ≤1000 分支，实际 ' + b.branches)
  assert.strictEqual(r.keyword.blocks.map((b) => b.source).join('|'), r.keyword.source, '退化切块后仍必须覆盖整段原文')
  return 'blocks=' + r.keyword.blocks.length + '，maxBranches=' + Math.max(...r.keyword.blocks.map((b) => b.branches))
})

o2Check('O2 结构：命中即短路（第一块命中时后续块一次都不调用）', () => {
  const lines = []
  for (let i = 0; i < 350; i++) lines.push('aa' + i + '|bb' + i) // 2 块
  const eng = o2MakeEngine(r2Compile)
  const r = eng.compileRules({ keyword: lines.join('\n') })
  let laterCalls = 0
  r.keyword.blocks[1] = { re: { test: () => { laterCalls++; return false } }, source: 'stub', branches: 1 }
  assert.strictEqual(eng.matchesCompiled(r.keyword, 'bb7'), true, '第一块命中必须判 true')
  assert.strictEqual(laterCalls, 0, '第一块命中后不得再调用后续块（命中短路），实际调用 ' + laterCalls + ' 次')
  assert.strictEqual(eng.matchesCompiled(r.keyword, '都没有'), false, '全块不命中必须判 false')
  assert.strictEqual(laterCalls, 1, '不命中时必须逐块扫完（第二块被调用 1 次），实际 ' + laterCalls + ' 次')
  return 'laterCalls(命中)=0 / (不命中)=1'
})

o2Check('O2 等价性：单行/小规则仍 1 块，且 blocks 与整条 re 判定一致', () => {
  const eng = o2MakeEngine(r2Compile)
  const single = eng.compileRules({ keyword: '京东|淘宝' })
  assert.strictEqual(single.keyword.blocks.length, 1, '单行规则必须只有 1 块（不做多余改写）')
  assert.strictEqual(single.keyword.blocks[0].source, '京东|淘宝', '单行规则的块源码必须逐字等于整段')
  assert.strictEqual(single.keyword.blocks[0].branches, 2, '单行规则的块分支数必须是 2')
  const multi = eng.compileRules({ keyword: '  京东  \r\n\r\n 淘宝 ' })
  assert.strictEqual(multi.keyword.blocks.length, 1, '多行小规则（2 行 2 分支）必须是 1 块')
  assert.strictEqual(multi.keyword.source, '京东|淘宝', '小规则仍按 joinSimpleRegexLines 归一（空白行/缩进都归一）')
  for (const value of ['京东', '淘宝', '天猫', '京', '淘宝京东']) {
    assert.strictEqual(eng.matchesCompiled(single.keyword, value), single.keyword.re.test(value), 'blocks 与 re 判定必须一致：' + value)
  }
  return 'single.blocks=1(2 分支)，判定逐条一致'
})

o2Check('O2 安全网：跨行拼接的病态规则退回整条正则（不切块、判定不变）', () => {
  const eng = o2MakeEngine(r2Compile)
  // ① 行尾悬挂反斜杠：整段 a\|b 是字面量「a|b」，逐块编译会失败 ⇒ 必须退回、且判定与整段一致
  const backslash = eng.compileRules({ keyword: '京东\\\n淘宝' })
  assert.strictEqual(backslash.keyword.blocks, undefined, '行尾悬挂反斜杠必须退回不分块')
  assert.strictEqual(backslash.keyword.re.test('京东|淘宝'), true, '退回后仍是整段的字面量语义')
  assert.strictEqual(eng.matchesCompiled(backslash.keyword, '京东|淘宝'), true, '退回后的判定必须与整段一致')
  assert.strictEqual(eng.matchesCompiled(backslash.keyword, '京东'), false, '退回后不得把两行当成两个分支')
  // ② 跨行未闭合分组：整段 (?:京东|淘宝) 合法，第一块 (?:京东 编不出来 ⇒ 退回
  const group = eng.compileRules({ keyword: '(?:京东\n淘宝)' })
  assert.strictEqual(group.keyword.blocks, undefined, '跨行未闭合分组必须退回不分块')
  assert.strictEqual(eng.matchesCompiled(group.keyword, '淘宝'), true, '退回后仍按整段匹配')
  // ③ 未闭合花括号：整段 a{|b 里的 `{` 是字面量，逐块 a{ 却会跨行断义 ⇒ 退回（保守不切）
  const brace = eng.compileRules({ keyword: 'a{\nb' })
  assert.strictEqual(brace.keyword.blocks, undefined, '未闭合花括号必须退回不分块（误判方向只能是「不切」）')
  assert.strictEqual(eng.matchesCompiled(brace.keyword, 'a{|b'), brace.keyword.re.test('a{|b'), '退回后的判定必须与整段逐条一致')
  // ④ 无作用域内联标志 (?i)：RE2 里它改的是「其后整段」的标志，切块后只影响本块 ⇒ 退回。
  //    用替身编译（V8 不保证支持 (?i) 这类修饰符），只验「不切块 + 只编译整段一次」。
  const flagSources = []
  const flagEng = o2MakeEngine((src) => { flagSources.push(String(src)); return { test: () => false, source: String(src) } })
  const flag = flagEng.compileRules({ keyword: '(?i)abc\ndef' })
  assert.strictEqual(flag.keyword.blocks, undefined, '带 (?i) 的行必须退回不分块（标志会跨行泄漏）')
  assert.deepStrictEqual(flagSources, ['(?i)abc|def'], '退回后只编译整段一次，不得再逐块编译')
  // ⑤ `\Q…\E` 引用块跨行：`\Qabc` + `def` 整段是字面量「abc|def」；实测 RE2 下两块各自都能编译
  //    （块 1 命中 abc、块 2 命中 def），语义与整段不同，且括号配平查不出来 ⇒ 带 \Q/\E 的行一律退回。
  const quoteSources = []
  const quoteEng = o2MakeEngine((src) => { quoteSources.push(String(src)); return { test: () => false, source: String(src) } })
  const quote = quoteEng.compileRules({ keyword: '\\Qabc\ndef' })
  assert.strictEqual(quote.keyword.blocks, undefined, '带 \\Q 的行必须退回不分块（引用块会跨行）')
  assert.deepStrictEqual(quoteSources, ['\\Qabc|def'], '退回后只编译整段一次，不得逐块编译')
  return '4 例均 blocks=undefined 且判定与整段一致（另 (?i)/(\\Q) 两例只编译整段）'
})

o2Check('W4 契约：多块字段只编块、整段源码一次都不编译（计数型编译替身）', () => {
  const lines = []
  for (let i = 0; i < 350; i++) lines.push('aa' + i + '|bb' + i) // 700 分支 ⇒ 2 块
  const full = lines.join('|')
  const seen = []
  const eng = o2MakeEngine((src) => { seen.push(String(src)); return { test: () => false, source: String(src) } })
  const r = eng.compileRules({ keyword: lines.join('\n') })
  assert.strictEqual(r.keyword.re, null, '多块字段 re 必须是 null')
  assert.deepStrictEqual(seen, r.keyword.blocks.map((b) => b.source), '编译过的源码必须恰好是各块源码（顺序一致）')
  assert.ok(!seen.includes(full), '整段源码（700 分支）不得出现在编译记录里')
  // simpleSourceCompiles 走同一份切块判定：也不得编译整段
  const seen2 = []
  const eng2 = o2MakeEngine((src) => { seen2.push(String(src)); return { test: () => false, source: String(src) } })
  assert.strictEqual(eng2.simpleSourceCompiles(lines.join('\n'), 'keyword'), true, '可切块 ⇒ 整段视为有效')
  assert.ok(!seen2.includes(full), '校验路径同样不得编译整段源码，实际编译了 ' + seen2.length + ' 条（含整段：' + seen2.includes(full) + '）')
  return '编译记录 2 条块源码、0 条整段（compileRules 与 simpleSourceCompiles 各一遍）'
})

o2Check('W4 契约：单块字段 re 存在且 blocks[0].re 与它是同一实例', () => {
  const eng = o2MakeEngine(r2Compile)
  const single = eng.compileRules({ keyword: '京东|淘宝' })
  assert.ok(single.keyword.re && typeof single.keyword.re.test === 'function', '单块字段 re 必须存在')
  assert.strictEqual(single.keyword.blocks.length, 1, '单行小规则必须只有 1 块')
  assert.strictEqual(single.keyword.blocks[0].re, single.keyword.re, '单块时 blocks[0].re 必须与 re 是同一实例（不重复编译）')
  assert.strictEqual(single.keyword.re.source, single.keyword.source, '单块时 re.source 必须逐字等于整段 source')
  const small = eng.compileRules({ keyword: ' 甲 \r\n\r\n 乙 ' })
  assert.strictEqual(small.keyword.source, '甲|乙', '换行按或归一（v3.390）')
  assert.strictEqual(small.keyword.blocks[0].re, small.keyword.re, '多行单块同样复用同一实例')
  return 'single/multi-line 单块均 re===blocks[0].re'
})

o2Check('W4 命名组安全网：跨块重名一律不切块，整段编得出来与否都与独立整段编译一致（判定面不得变宽）', () => {
  // 与生产 compileUserRegex 同口径的替身：编译失败返回 null（r2Compile 直接抛，不能用来测「非法」）
  const safeCompile = (src, flags) => { try { return new NativeRegExp(String(src), flags) } catch (e) { return null } }
  const eng = o2MakeEngine(safeCompile)
  // ① **与引擎版本无关**的非法样本：同一 alternative 内重名，且是单行（归一后仍逐字是 `(?<x>a)(?<x>b)`）。
  //    ES2025（V8 13 / Node 24）只放宽「不同 alternative 允许同名组」，同一 alternative 内重名仍非法；
  //    V8 22 与 RE2 同样非法（本机实证 `node -e "new RegExp('(?<x>a)(?<x>b)','i')"` ⇒ ERR）。
  //    用它锁「非法 ⇒ 编译产物 null + 告警」，判定不随引擎版本漂移。
  let dup = null
  const warns = r2Warn(() => { dup = eng.compileRules({ keyword: '(?<x>a)(?<x>b)' }) })
  assert.strictEqual(dup.keyword, null, '同一 alternative 内重复命名组必须仍被判非法并跳过（编译产物为 null），实际 ' + JSON.stringify(dup.keyword && Object.keys(dup.keyword)))
  assert.strictEqual(warns.some((w) => w.includes('非法正则') && w.includes('keyword')), true, '必须产生含「非法正则」与字段名的告警，实际：' + warns.join(' / '))
  // ② **真正的回归场景**：两条重名行落在不同块里，逐块各自都能编——没有守卫就会产出
  //    `{re:null, blocks:[2]}`（规则从「被跳过」变成「生效」= 判定面变宽）。
  //    但「整段编不编得出来」本身随引擎漂移：RE2 与 V8 ≤22 判整段非法，V8 13 起（ES2025）放宽到
  //    「不同 alternative 允许同名」⇒ 整段合法。故本用例**不假设整段必失败**，只锁三件引擎无关的事：
  //    不切块（blocks 恒缺席）、只编整段一次、判定与「独立整段编译」逐条一致（成功/失败两条分支都要成立）。
  //    构造 700 分支、两块（599 + 101），重名分别在首行与末行。
  const lines = ['(?<x>a)']
  for (let i = 0; i < 299; i++) lines.push('kwA' + i + '|kwB' + i)
  for (let i = 0; i < 50; i++) lines.push('kwC' + i + '|kwD' + i)
  lines.push('(?<x>b)')
  const whole = lines.join('|') // 守卫命中时 compileRules 实际编译的整段源码（joinSimpleRegexLines 的归一结果）
  // 探针：命中（'a'/'b'/任意 kw 分支；'ab' 含 a 子串）与不命中（'c'、空串）两侧都有
  const probes = ['a', 'b', 'ab', 'c', '', 'kwA0', 'kwB7', 'kwC3', 'kwD49', 'zzz']
  // 整段判非法时编译产物是 null，取 blocks 前必须先过 null（否则 TypeError 会盖住真正的断言）
  const blocksOf = (entry) => (entry ? entry.blocks : undefined)

  // 跨块重名的共同断言（引擎无关）：整段非法 ⇒ 跳过 + 告警；整段可编 ⇒ 生效且判定与独立整段编译逐条一致。
  // 走哪条分支由 indep（独立整段编译）的实际结果决定，不预设 —— 同一条代码路径在 V8 22 走前者、
  // 在 CI 的 V8 13 走后者，断言都必须成立。
  const checkCross = (label, compile) => {
    const seen = []
    const recEng = o2MakeEngine((src) => { seen.push(String(src)); return compile(src, 'i') })
    let cross = null
    const crossWarns = r2Warn(() => { cross = recEng.compileRules({ keyword: lines.join('\n') }) })
    const observed = blocksOf(cross.keyword)
    // 用 assert.ok（而非 strictEqual）只为让失败信息紧凑：blocks 里含整块源码，strictEqual 会把几 KB 的 actual 全打印出来
    assert.ok(observed === undefined, label + '：跨块重名必须不切块（blocks 必须缺席），实际 ' + (observed ? observed.length + ' 块 [' + observed.map((b) => b.branches).join('+') + ']' : String(observed)))
    assert.deepStrictEqual(seen, [whole], label + '：守卫必须让编译只发生在整段一次，不得逐块编译')
    const indep = compile(whole, 'i')
    if (indep === null) {
      assert.strictEqual(cross.keyword, null, label + '：整段编不出来 ⇒ 规则必须仍被跳过（不得带 blocks 变活）')
      assert.strictEqual(crossWarns.some((w) => w.includes('非法正则') && w.includes('keyword')), true, label + '：整段非法必须产生含字段名的「非法正则」告警')
      assert.strictEqual(recEng.matchesCompiled(cross.keyword, 'a'), false, label + '：规则被跳过 ⇒ 任何输入都不得拦截')
      return '整段非法 ⇒ 跳过'
    }
    assert.ok(cross.keyword, label + '：整段可编 ⇒ 规则必须生效（编译产物不得为 null）')
    assert.ok(blocksOf(cross.keyword) === undefined, label + '：整段可编也不得切块（blocks 必须缺席）')
    assert.strictEqual(cross.keyword.source, whole, label + '：source 必须仍是整段原文')
    for (const v of probes) {
      assert.strictEqual(recEng.matchesCompiled(cross.keyword, v), indep.test(v),
        label + '：判定必须与独立整段编译逐条一致：' + JSON.stringify(v))
    }
    return '整段可编 ⇒ 生效 + 判定一致'
  }
  checkCross('原生 safeCompile', safeCompile)

  // V8 13（ES2025）允许**不同 alternative** 内同名捕获组，本机 Node 22（V8 12）不允许。为让「整段可编」
  // 那条分支在本机也**真实跑到**，用注入替身模拟 V8 13：先把第 2 个及以后的同名组在源码文本里改成唯一名，
  // 再交给原生 RegExp——只改源码拼写、不改语言（各分支仍是原来的并集），探针也不读捕获，
  // 故可安全用作「独立整段编译」的对照面（下游只用 .test 判 true/false）。
  const renameDupGroups = (src) => {
    const used = new Set()
    return String(src).replace(/\(\?<([A-Za-z_$][\w$]*)>/g, (m, name) => {
      if (!used.has(name)) { used.add(name); return m }
      let n = 1
      while (used.has(name + '__' + n)) n++
      used.add(name + '__' + n)
      return '(?<' + name + '__' + n + '>'
    })
  }
  const safeCompileCi = (src, flags) => { try { return new NativeRegExp(renameDupGroups(src), flags) } catch (e) { return null } }
  const viaCi = checkCross('safeCompileCi（模拟 V8 13 跨 alternative 重名）', safeCompileCi)
  assert.strictEqual(viaCi, '整段可编 ⇒ 生效 + 判定一致', 'safeCompileCi 必须构造出「整段可编」的对照面，否则该分支在本机没被测到，实际 ' + viaCi)
  // ③ `(?P<x>…)`（Python 风格，V8 不支持、RE2 支持）：同一守卫按源码文本生效 ⇒ 不切块
  const pEng = o2MakeEngine((src) => ({ test: () => true, source: String(src) }))
  const py = pEng.compileRules({ keyword: '(?P<x>a)\n(?P<y>b)' })
  assert.ok(py.keyword, '`(?P<>` 整段编译成功（替身恒成功）⇒ 规则必须生效，不得为 null')
  assert.strictEqual(py.keyword.blocks, undefined, '`(?P<>` 行同样不切块（守卫是行级、不分语法）')
  // ④ 不同名、无跨块冲突：整段本来就能编，规则照旧生效（守卫是行级的，故同样不切块——保守方向只影响速度）
  const ok = eng.compileRules({ keyword: '(?<x>a)\n(?<y>b)' })
  assert.strictEqual(ok.keyword.blocks, undefined, '命名组行一律不切块（行级保守守卫）')
  assert.ok(ok.keyword.re, '不同名命名组的整段正则必须存在（与 W4 之前一致）')
  assert.strictEqual(eng.matchesCompiled(ok.keyword, 'a'), true, '命名组规则仍须命中 a')
  assert.strictEqual(eng.matchesCompiled(ok.keyword, 'b'), true, '命名组规则仍须命中 b')
  // 判定与「独立整段编译」逐条一致（对照面独立构造，不读 compiled.re 之外的任何字段）
  const indepOk = safeCompile(ok.keyword.source, 'i')
  for (const v of ['a', 'b', 'ab', 'c', '']) assert.strictEqual(eng.matchesCompiled(ok.keyword, v), indepOk.test(v), '命名组判定必须与独立整段编译一致：' + v)
  return '同一 alternative 重名 ⇒ 跳过 + 告警；跨块重名两条分支均只编整段一次且判定与独立整段编译一致；不同名 ⇒ 不切块但判定一致'
})

o2Check('W4 simpleSourceCompiles：多块只编块、非法/重名返回 false、单块编整段', () => {
  const seen = []
  const stub = (src) => { seen.push(String(src)); return { test: () => false, source: String(src) } }
  const eng = o2MakeEngine(stub)
  const lines = []
  for (let i = 0; i < 350; i++) lines.push('aa' + i + '|bb' + i)
  assert.strictEqual(eng.simpleSourceCompiles(lines.join('\n'), 'keyword'), true, '700 分支可切块 ⇒ true')
  assert.deepStrictEqual(seen, [lines.slice(0, 300).join('|'), lines.slice(300).join('|')], '只编两块（600 + 100），顺序与切块一致')
  // 非法：单行不切块（1 块）⇒ 退回整段编译 ⇒ false（替身按生产口径「失败返回 null」）
  const safeCompile = (src, flags) => { try { return new NativeRegExp(String(src), flags) } catch (e) { return null } }
  const eng2 = o2MakeEngine(safeCompile)
  assert.strictEqual(eng2.simpleSourceCompiles('(', 'keyword'), false, '非法正则必须 false（退整段编译）')
  assert.strictEqual(eng2.simpleSourceCompiles('苏州|杭州', 'keyword'), true, '合法单行必须 true（单块编整段）')
  // 空白：compileRules 视为无规则，不属于「非法」
  assert.strictEqual(eng2.simpleSourceCompiles('   ', 'keyword'), true, '空白（无规则）不算非法')
  // 脏配置（toString 抛错）不得抛穿
  assert.strictEqual(eng2.simpleSourceCompiles({ toString () { throw new Error('boom') } }, 'keyword'), false, '抛错 toString ⇒ false，不得抛穿')
  return '真实切块 + 4 类边界'
})

for (const line of o2Cases) console.log('  ' + line)
console.log(`O2 切块结构断言 ${o2Cases.filter((l) => l.startsWith('✅')).length}/${o2Cases.length} 通过`)

console.log('test_rules OK')
