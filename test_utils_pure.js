'use strict'

// xbk_utils.js 纯函数方法扩展测试（提升变异分数）
// 覆盖：add0/daysFrom/daysComputed/num/safeText/safeGet/truncateUtf16/sanitizeSurrogates/
//       isDangerousUrl/validUrl/normUrl/_decodeCssEscapes/hasValidId/anonKey/safeErrorText
const assert = require('node:assert')
const { createUtils } = require('./xbk_utils')

const safeRe = (src, flags) => new RegExp(src, flags)
const Utils = createUtils({ safeRe })

let pass = 0
let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

console.log('=== xbk_utils.js 纯函数扩展测试 ===')

// ===== add0：补零 =====
check('add0: 个位数补零', () => {
  assert.strictEqual(Utils.add0(5), '05')
})
check('add0: 两位数不补零', () => {
  assert.strictEqual(Utils.add0(12), '12')
})
check('add0: 0 补零', () => {
  assert.strictEqual(Utils.add0(0), '00')
})

// ===== daysFrom：从毫秒到今天的天数差 =====
check('daysFrom: 昨天 = 1 天', () => {
  const yesterday = Date.now() - 24 * 60 * 60 * 1000
  assert.strictEqual(Utils.daysFrom(yesterday), 1)
})
check('daysFrom: 今天 = 0 天', () => {
  assert.strictEqual(Utils.daysFrom(Date.now()), 0)
})
check('daysFrom: 未来 = 0 天（不返回负数）', () => {
  const future = Date.now() + 24 * 60 * 60 * 1000
  assert.strictEqual(Utils.daysFrom(future), 0)
})
check('daysFrom: 7天前 = 7 天', () => {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  assert.strictEqual(Utils.daysFrom(weekAgo), 7)
})

// ===== daysComputed：计算天数 =====
check('daysComputed: 昨天秒时间戳 = 1 天', () => {
  const t = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)
  assert.strictEqual(Utils.daysComputed(t), 1)
})
check('daysComputed: 今天毫秒时间戳 = 0 天', () => {
  assert.strictEqual(Utils.daysComputed(Date.now()), 0)
})
check('daysComputed: 无效时间返回 0（不是 null）', () => {
  assert.strictEqual(Utils.daysComputed('invalid'), 0)
})
check('daysComputed: 负数时间戳返回 0', () => {
  assert.strictEqual(Utils.daysComputed(-1), 0)
})

// ===== num：数字解析 =====
check('num: 数字原样返回', () => {
  assert.strictEqual(Utils.num(42, 0), 42)
})
check('num: 数字字符串解析', () => {
  assert.strictEqual(Utils.num('42', 0), 42)
})
check('num: 无效值返回默认', () => {
  assert.strictEqual(Utils.num('abc', 10), 10)
})
check('num: undefined 返回默认', () => {
  assert.strictEqual(Utils.num(undefined, 10), 10)
})
check('num: null 返回默认', () => {
  assert.strictEqual(Utils.num(null, 10), 10)
})
check('num: NaN 返回默认', () => {
  assert.strictEqual(Utils.num(Number.NaN, 10), 10)
})

// ===== safeText：安全文本 =====
check('safeText: 字符串原样返回', () => {
  assert.strictEqual(Utils.safeText('hello'), 'hello')
})
check('safeText: 数字转字符串', () => {
  assert.strictEqual(Utils.safeText(42), '42')
})
check('safeText: undefined 返回空串', () => {
  assert.strictEqual(Utils.safeText(undefined), '')
})
check('safeText: null 返回空串', () => {
  assert.strictEqual(Utils.safeText(null), '')
})

// ===== safeGet：安全获取 =====
check('safeGet: 正常获取', () => {
  assert.strictEqual(Utils.safeGet({ a: 1 }, 'a'), 1)
})
check('safeGet: 不存在的键返回 undefined', () => {
  assert.strictEqual(Utils.safeGet({ a: 1 }, 'b'), undefined)
})
check('safeGet: null 对象返回 undefined', () => {
  assert.strictEqual(Utils.safeGet(null, 'a'), undefined)
})
check('safeGet: undefined 对象返回 undefined', () => {
  assert.strictEqual(Utils.safeGet(undefined, 'a'), undefined)
})

// ===== truncateUtf16：UTF-16 截断 =====
check('truncateUtf16: 短字符串不截断', () => {
  assert.strictEqual(Utils.truncateUtf16('hello', 10), 'hello')
})
check('truncateUtf16: 长字符串截断到指定长度', () => {
  assert.strictEqual(Utils.truncateUtf16('hello world', 5), 'hello')
})
check('truncateUtf16: 空字符串返回空串', () => {
  assert.strictEqual(Utils.truncateUtf16('', 5), '')
})
check('truncateUtf16: max=0 不截断返回原串', () => {
  assert.strictEqual(Utils.truncateUtf16('hello', 0), 'hello')
})
check('truncateUtf16: 含 emoji 的字符串按 UTF-16 截断', () => {
  const s = 'a😀b'
  const r = Utils.truncateUtf16(s, 2)
  assert.ok(r.length <= 2, '截断后长度应 <= 2')
})

// ===== sanitizeSurrogates：代理对清洗 =====
check('sanitizeSurrogates: 正常字符串原样返回', () => {
  assert.strictEqual(Utils.sanitizeSurrogates('hello'), 'hello')
})
check('sanitizeSurrogates: 孤立高代理被移除', () => {
  const s = 'a\uD800b' // 孤立高代理
  const r = Utils.sanitizeSurrogates(s)
  assert.ok(!r.includes('\uD800'), '孤立高代理应被移除')
})
check('sanitizeSurrogates: 正常代理对保留', () => {
  const s = 'a😀b' // 正常代理对
  const r = Utils.sanitizeSurrogates(s)
  assert.ok(r.includes('😀'), '正常代理对应保留')
})
check('sanitizeSurrogates: 空字符串返回空串', () => {
  assert.strictEqual(Utils.sanitizeSurrogates(''), '')
})

// ===== isDangerousUrl：危险 URL 检测 =====
check('isDangerousUrl: javascript: 是危险', () => {
  assert.strictEqual(Utils.isDangerousUrl('javascript:alert(1)'), true)
})
check('isDangerousUrl: data: 是危险', () => {
  assert.strictEqual(Utils.isDangerousUrl('data:text/html,abc'), true)
})
check('isDangerousUrl: vbscript: 是危险', () => {
  assert.strictEqual(Utils.isDangerousUrl('vbscript:msgbox(1)'), true)
})
check('isDangerousUrl: https: 不是危险', () => {
  assert.strictEqual(Utils.isDangerousUrl('https://example.com'), false)
})
check('isDangerousUrl: http: 不是危险', () => {
  assert.strictEqual(Utils.isDangerousUrl('http://example.com'), false)
})
check('isDangerousUrl: 实体编码的 javascript: 是危险', () => {
  assert.strictEqual(Utils.isDangerousUrl('&#106;avascript:alert(1)'), true)
})

// ===== validUrl：URL 验证 =====
check('validUrl: https URL 有效', () => {
  assert.ok(Utils.validUrl('https://example.com/path'), 'https URL 应有效')
})
check('validUrl: http URL 有效', () => {
  assert.ok(Utils.validUrl('http://example.com'), 'http URL 应有效')
})
check('validUrl: javascript: 无效', () => {
  assert.strictEqual(Utils.validUrl('javascript:alert(1)'), '')
})
check('validUrl: 空串无效', () => {
  assert.strictEqual(Utils.validUrl(''), '')
})
check('validUrl: 非字符串无效', () => {
  assert.strictEqual(Utils.validUrl(123), '')
})

// ===== normUrl：URL 归一化 =====
check('normUrl: https URL 归一化', () => {
  const r = Utils.normUrl('https://Example.com/path/')
  assert.ok(typeof r === 'string' && r.length > 0, '应返回归一化后的 URL')
})
check('normUrl: 去除跟踪参数', () => {
  const r = Utils.normUrl('https://example.com/page?fbclid=abc&name=value')
  assert.ok(!r.includes('fbclid'), '应去除 fbclid 跟踪参数')
  assert.ok(r.includes('name=value'), '应保留非跟踪参数')
})
check('normUrl: 空串返回空串', () => {
  assert.strictEqual(Utils.normUrl(''), '')
})
check('normUrl: 非字符串返回空串', () => {
  assert.strictEqual(Utils.normUrl(null), '')
})

// ===== _decodeCssEscapes：CSS 转义解码 =====
check('_decodeCssEscapes: 普通字符原样返回', () => {
  assert.strictEqual(Utils._decodeCssEscapes('hello'), 'hello')
})
check('_decodeCssEscapes: \\uXXXX 转义解码', () => {
  assert.strictEqual(Utils._decodeCssEscapes('\\u0041'), 'A')
})
check('_decodeCssEscapes: \\X 单字符转义', () => {
  assert.strictEqual(Utils._decodeCssEscapes('\\n'), 'n')
})
check('_decodeCssEscapes: 空串返回空串', () => {
  assert.strictEqual(Utils._decodeCssEscapes(''), '')
})

// ===== hasValidId：有效 ID 检测 =====
check('hasValidId: 有 id 字段有效', () => {
  assert.strictEqual(Utils.hasValidId({ id: 123 }), true)
})
check('hasValidId: 无 id 字段无效', () => {
  assert.strictEqual(Utils.hasValidId({}), false)
})
check('hasValidId: id 为空串无效', () => {
  assert.strictEqual(Utils.hasValidId({ id: '' }), false)
})
check('hasValidId: null 对象无效', () => {
  assert.strictEqual(Utils.hasValidId(null), false)
})
check('hasValidId: 继承得到的 id 不算有效 id（XBK-UTILS-P2-04，与 getMessageIdentity 同口径）', () => {
  // 反例（改动前）：hasValidId 直接 safeGet(m,'id') 无 hasOwnProperty 前提，
  // Object.create({id:'abc'}) → true；而 getMessageIdentity 要求自有属性 → invalid。
  // 同一对象上两个判重入口结论相反，据 hasValidId 走 id 路径的调用方会与身份索引对不上。
  const inherited = Object.create({ id: 'abc' })
  assert.strictEqual(Utils.hasValidId(inherited), false, '原型链上的 id 不得被 hasValidId 判为有 id')
  assert.strictEqual(Utils.getMessageIdentity(inherited).valid, false, '前置：getMessageIdentity 对继承 id 判无效')
  // 自有属性路径不得被一并收紧
  assert.strictEqual(Utils.hasValidId({ id: 123 }), true, '自有数字 id 仍有效')
  assert.strictEqual(Utils.hasValidId({ id: 'abc' }), true, '自有字符串 id 仍有效')
  assert.strictEqual(Utils.hasValidId(Object.assign(Object.create({ id: 'x' }), { id: 0 })), true, '自有数字 id 0 仍有效')
  // 两个入口对同一对象的结论必须一致（防再次分裂）
  for (const m of [{ id: 'a' }, { id: 0 }, { id: '' }, { id: null }, {}, inherited, Object.create({ id: 'z' })]) {
    assert.strictEqual(Utils.hasValidId(m), Utils.getMessageIdentity(m).valid,
      `hasValidId 与 getMessageIdentity 必须同判（keys=${JSON.stringify(Object.keys(m))}）`)
  }
})

// ===== anonKey：匿名键 =====
check('anonKey: 单参数生成匿名键', () => {
  const k = Utils.anonKey('test content')
  assert.ok(typeof k === 'string' && k.startsWith('anon:'), '应返回 anon: 开头的字符串')
})
check('anonKey: 相同参数生成相同键', () => {
  const k1 = Utils.anonKey('test')
  const k2 = Utils.anonKey('test')
  assert.strictEqual(k1, k2, '相同参数应生成相同键')
})
check('anonKey: 不同参数生成不同键', () => {
  const k1 = Utils.anonKey('test1')
  const k2 = Utils.anonKey('test2')
  assert.notStrictEqual(k1, k2, '不同参数应生成不同键')
})
check('anonKey: 多参数连接符不转义，单参数中 | 会转义', () => {
  const k1 = Utils.anonKey('a', 'b') // 连接后 a|b（| 不转义）
  const k2 = Utils.anonKey('a|b') // | 被转义为 %7C → a%7Cb
  assert.notStrictEqual(k1, k2, '多参数连接符与单参数中的 | 处理不同')
})
check('anonKey: 参数顺序影响结果', () => {
  const k1 = Utils.anonKey('a', 'b')
  const k2 = Utils.anonKey('b', 'a')
  assert.notStrictEqual(k1, k2, '参数顺序不同应生成不同键')
})
check('anonKey: 空值被过滤', () => {
  const k1 = Utils.anonKey('a', undefined, null, '', 'b')
  const k2 = Utils.anonKey('a', 'b')
  assert.strictEqual(k1, k2, '空值应被过滤')
})
check('anonKey: 全空参数返回稳定的退化键', () => {
  const k = Utils.anonKey(undefined, null, '')
  // 只断言语义（前缀/格式/确定性/与无参退化键一致），不锁定具体哈希魔数——避免哈希实现变更即红
  assert.match(k, /^anon:[0-9a-f]+$/, '应返回 anon:<hex> 格式的退化键')
  assert.strictEqual(k, Utils.anonKey(), '全空参数应与无参数调用返回同一退化键')
  assert.strictEqual(k, Utils.anonKey(undefined, null, ''), '重复调用应确定性返回相同键')
})
check('anonKey: Symbol 参数被过滤', () => {
  const k1 = Utils.anonKey('a', Symbol('x'), 'b')
  const k2 = Utils.anonKey('a', 'b')
  assert.strictEqual(k1, k2, 'Symbol 应被过滤')
})
check('anonKey: % 被转义为 %25（二次转义不等价）', () => {
  const k1 = Utils.anonKey('a%b') // % → %25 → a%25b
  const k2 = Utils.anonKey('a%25b') // % → %25 → a%2525b
  assert.notStrictEqual(k1, k2, '已转义输入会二次转义，不应等价')
})
check('anonKey: 多参数中的 % 被转义', () => {
  const k1 = Utils.anonKey('a', '%', 'b') // % → %25，连接后 a|%25|b
  const k2 = Utils.anonKey('a|%25|b') // | 转义为 %7C，% 转义为 %25
  assert.notStrictEqual(k1, k2, '多参数连接符不转义，单参数中 | 会转义')
})

// ===== safeErrorText：安全错误文本 =====
check('safeErrorText: 有 message 返回 message', () => {
  assert.strictEqual(Utils.safeErrorText({ message: 'error msg' }), 'error msg')
})
check('safeErrorText: 有 code 无 message 返回 code', () => {
  assert.strictEqual(Utils.safeErrorText({ code: 'ETIMEDOUT' }), 'ETIMEDOUT')
})
check('safeErrorText: 无 message 无 code 返回 fallback', () => {
  assert.strictEqual(Utils.safeErrorText({}, 'fallback'), 'fallback')
})
check('safeErrorText: null 返回 fallback', () => {
  assert.strictEqual(Utils.safeErrorText(null, 'fb'), 'fb')
})
check('safeErrorText: message 非字符串转字符串', () => {
  assert.strictEqual(Utils.safeErrorText({ message: 123 }), '123')
})

// ===== P1-04：清洗链内部正则必须是 RE2 兼容形态（不含反向引用）=====
// 反例（改动前）：href/src、_cleanNavAttrs、_cleanSrcsetAttrs、_cleanStyleAttrs 的成对引号正则
// 写成 `(["'])…\1`/`\2`（href/src 那条还是原生字面量，根本不经过 RE2）。Google RE2 不支持反向引用，
// 含它的模式会被 safeRe 静默 catch 并回落 V8 RegExp，清洗链赖以自保的「线性时间」防护对这 4 条模式
// 形同不存在。观测方式：注入记录全部 pattern 源码的 safeRe，跑一遍覆盖四类属性的清洗，断言没有任何
// 被编译的内部模式含反向引用。本机 re2 是 V8 替身（不拒反向引用），所以断言写成源码级判定——
// 它对「反向引用被重新写回」可本地证伪；CI 装真 re2 时这些模式会真正走 RE2 编译，本断言即其前置条件。
check('P1-04: 清洗链内部正则不含反向引用（RE2 兼容）', () => {
  const captured = []
  const SpyUtils = createUtils({ safeRe: (src, flags) => { captured.push([src, flags]); return new RegExp(src, flags) } })
  SpyUtils.sanitizeDecodedHtml('<a href="x" xlink:href="y" srcset="a" style="b" src="c" title="t">t</a>')
  // 反向引用 = 奇数个反斜杠后紧跟 1-9；`\\1`（两个字面反斜杠 + '1'）与 `\u0001`/`\d` 都不算
  const hasBackref = (src) => {
    for (let i = src.indexOf('\\'); i !== -1;) {
      let run = 0
      while (src[i + run] === '\\') run++
      const next = src[i + run]
      if (run % 2 === 1 && next >= '1' && next <= '9') return true
      i = src.indexOf('\\', i + run)
    }
    return false
  }
  assert.ok(captured.length > 0, '前置条件：清洗链必须经注入的 safeRe 编译内部正则')
  assert.ok(captured.some(([src]) => src.includes('href|src')), '前置条件：href/src 成对引号模式必须已经过 safeRe 编译')
  const offenders = captured.filter(([src]) => hasBackref(src)).map(([src]) => src)
  assert.deepStrictEqual(offenders, [], `清洗链内部正则不得含反向引用（RE2 不支持 → 静默回落 V8，失去线性防护）: ${offenders.join(' | ')}`)
  // 行为等价：拆成「双引号支 | 单引号支」后，两支仍各自清空危险协议、保留合法值
  const cases = [
    ['sanitizeHtmlUrls', '<a href="javascript:alert(1)">x</a>', /javascript/, false],
    ['sanitizeHtmlUrls', "<a href='javascript:alert(1)'>x</a>", /javascript/, false],
    // CodeQL js/regex/missing-regexp-anchor：URL 形态的正则若不加锚点可匹配任意主机的前后缀；
    // 这两条断言的是「合法值被原样保留」，改为锚定整串（^…$）后语义更强且不再有该告警。
    ['sanitizeHtmlUrls', '<a href="https://u.jd.com/a">x</a>', /^<a href="https:\/\/u\.jd\.com\/a">x<\/a>$/, true],
    ['sanitizeHtmlUrls', "<a href='https://u.jd.com/a'>x</a>", /^<a href='https:\/\/u\.jd\.com\/a'>x<\/a>$/, true],
    ['_cleanNavAttrs', '<div xlink:href="javascript:alert(1)">d</div>', /javascript/, false],
    ['_cleanNavAttrs', "<div xlink:href='javascript:alert(1)'>d</div>", /javascript/, false],
    ['_cleanNavAttrs', '<div poster="https://x/1.jpg">d</div>', /https:\/\/x\/1\.jpg/, true],
    ['_cleanSrcsetAttrs', '<img srcset="a.png, javascript:alert(1)">', /javascript/, false],
    ['_cleanSrcsetAttrs', "<img srcset='a.png, javascript:alert(1)'>", /javascript/, false],
    ['_cleanSrcsetAttrs', '<img srcset="https://x/1.png 1x">', /https:\/\/x\/1\.png 1x/, true],
    ['_cleanStyleAttrs', '<div style="background:url(javascript:x)">a</div>', /javascript/, false],
    ['_cleanStyleAttrs', "<div style='background:url(javascript:x)'>a</div>", /javascript/, false],
    ['_cleanStyleAttrs', '<div style="color:red">a</div>', /color:red/, true]
  ]
  for (const [fn, input, re, expected] of cases) {
    assert.strictEqual(re.test(SpyUtils[fn](input)), expected, `${fn}(${input}) 的期望匹配状态应为 ${expected}`)
  }
  // 单双引号值内出现「另一种引号」时不得跨引号配对（拆分两支后的等价性边界）
  assert.strictEqual(SpyUtils.sanitizeHtmlUrls('<a href="a\'b">x</a>').includes('a\'b'), true, '双引号值内的单引号应原样保留')
  assert.strictEqual(SpyUtils.sanitizeHtmlUrls("<a href='a\"b'>x</a>").includes('a"b'), true, '单引号值内的双引号应原样保留')
  assert.strictEqual(SpyUtils._cleanStyleAttrs('<div style="a\'b">x</div>').includes("a'b"), true, 'style 双引号值内的单引号应原样保留')
  // 未闭合引号不得被跨行/跨标签配对消费（原 \1/\2 语义：无同型闭合引号即不匹配）
  assert.strictEqual(SpyUtils.sanitizeHtmlUrls('<a href="javascript:x><b><a href="javascript:y>').includes('href="javascript:y"'), false,
    '未闭合引号不得与后续属性引号跨标签配对')
})

// ===== P1-04（同族）：清洗/规范化热路径内部正则不得含 lookaround（RE2 兼容）=====
// 反例（改动前）：xbk_utils.js sanitizeSurrogates 把
// `[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]` 交给 safeRe——
// 含 lookahead `(?!` 与 lookbehind `(?<!`，真 RE2 均不支持，编译失败后会被 safeRe 静默 catch
// 回落 V8 RegExp，线性时间防护丢失。该方法在**生产热路径**上（safeText；xbk_app 每条推送的
// 标题/正文都经它），与上方 4 条反向引用是同一「静默回落」通道。观测方式：注入记录全部 pattern
// 源码的 safeRe，跑一遍 safeText/sanitizeSurrogates/sanitizeDecodedHtml，断言没有任何被编译的
// 内部模式含 lookaround。本机 re2 是 V8 替身（不拒 lookaround），故断言写成源码级判定——
// 它对「lookaround 被重新写回」可本地证伪；CI 装真 re2 时本断言即其前置条件。
check('P1-04 同族: sanitizeSurrogates/safeText 内部正则不含 lookaround（RE2 兼容）', () => {
  const captured = []
  const SpyUtils = createUtils({ safeRe: (src, flags) => { captured.push([src, flags]); return new RegExp(src, flags) } })
  SpyUtils.safeText('a\uD800b\uDC00c\uD83D\uDE00') // 孤立高/低代理 + 完整代理对
  SpyUtils.sanitizeSurrogates('\uD800')
  SpyUtils.sanitizeDecodedHtml('<a href="x" title="t">t</a>')
  assert.ok(captured.length > 0, '前置条件：规范化/清洗链必须经注入的 safeRe 编译内部正则')
  const isLookaround = (src) => ['(?=', '(?!', '(?<=', '(?<!'].some(t => src.includes(t))
  const offenders = captured.map(([src]) => src).filter(isLookaround)
  assert.deepStrictEqual(offenders, [], `内部正则不得含 lookaround（RE2 不支持 → 静默回落 V8，失去线性防护）: ${offenders.join(' | ')}`)
  // 行为等价：孤立代理 → U+FFFD，完整代理对整体保留，无代理字符逐字节不变
  assert.strictEqual(SpyUtils.sanitizeSurrogates('a\uD800b'), 'a\uFFFDb', '孤立高代理应替换为 U+FFFD')
  assert.strictEqual(SpyUtils.sanitizeSurrogates('a\uDC00b'), 'a\uFFFDb', '孤立低代理应替换为 U+FFFD')
  assert.strictEqual(SpyUtils.sanitizeSurrogates('a\uD83D\uDE00b'), 'a\uD83D\uDE00b', '完整代理对必须原样保留')
  assert.strictEqual(SpyUtils.sanitizeSurrogates('\uD800\uDC00\uD800'), '\uD800\uDC00\uFFFD', '配对保对、尾部孤立高代理替换')
  assert.strictEqual(SpyUtils.sanitizeSurrogates('\uDC00\uD800'), '\uFFFD\uFFFD', '连续孤立低+高代理各自替换')
  assert.strictEqual(SpyUtils.sanitizeSurrogates('plain'), 'plain', '无代理字符时逐字节不变')
})

// ===== P1-04（收尾）：RE2 编译失败回落 V8 原生 RegExp 时必须留一次告警 =====
// 反例（改动前）：safeRe 的 catch 是空的 `catch (e) { /* 反向引用等不支持特性回落 */ }`，RE2 因反向
// 引用/lookbehind 等不支持的构造编译失败后静默回落 V8——「RE2 的线性时间防护对这条模式不成立」
// 在运行日志里无声无息（未修复清单 P1-04 的第二句建议）。本机 re2 是 V8 替身（不拒任何语法），
// 真 RE2 的编译结果本机不可验，故观测方式为子进程内把 require('re2') 换成「对清洗链内部模式抛错」
// 的替身，驱动清洗链让多条内部模式依次落地到 catch，断言：
//   ① 模块加载期不告警——回落告警只属于真正的编译失败路径；
//   ② 首次回落恰好告警一次，其后（含新模式）不再刷屏——热路径每条内部正则都要过 safeRe；
//   ③ 告警含回落模式源码与失败原因，且原因里的凭据已被既有脱敏通道遮蔽；
//   ④ 回落行为不变：危险协议仍被清空、合法值仍保留。
// 撤掉告警实现（catch 恢复为空）→ ② 立即变红。
const execFileSync = require('node:child_process').execFileSync
const fallbackProbe = String.raw`
'use strict'
const re2Path = require.resolve('re2')
const warns = []
const rejected = []
console.warn = (...args) => { warns.push(args.map(v => String(v)).join(' ')) }
// 替身 RE2：对清洗链内部模式（成对引号 href|src、srcset、style 与主动标签守卫）抛错，模拟真 RE2
// 不支持这些构造；其余模式照常编译，保证模块加载期不误触发回落告警。
const UNSUPPORTED = ['href|src', 'srcset', 'style']
function FakeRe2 (src, flags) {
  if (typeof src === 'string' && UNSUPPORTED.some(marker => src.includes(marker))) {
    rejected.push(src)
    throw new Error('invalid perl operator: unsupported construct (token=SUPERSECRETVALUE123456)')
  }
  return new RegExp(src, flags)
}
require.cache[re2Path] = { id: re2Path, filename: re2Path, loaded: true, exports: FakeRe2 }
const xbk = require('./xbk_function_v3')
const warnsAfterLoad = warns.length
const outFirst = xbk.sanitizeDecodedHtml('<a href="javascript:alert(1)" srcset="a 1x" style="color:red" title="t">t</a>')
const warnsAfterFirst = warns.length
const outSecond = xbk.sanitizeDecodedHtml('<a href="https://u.jd.com/a">x</a>')
const outThird = xbk.sanitizeDecodedHtml('<img src="javascript:x" srcset="b 2x, javascript:alert(1)">')
process.stdout.write(JSON.stringify({
  warnsAfterLoad,
  warnsAfterFirst,
  warnsAfterAll: warns.length,
  warns,
  rejectedCount: rejected.length,
  outFirst,
  outSecond,
  outThird
}))
`

check('P1-04 收尾: RE2 编译失败回落 V8 只告警一次（含模式与原因，凭据已脱敏）', () => {
  const raw = execFileSync(process.execPath, ['-e', fallbackProbe], { cwd: __dirname, encoding: 'utf8' })
  const out = JSON.parse(raw.trim().split(/\r?\n/).pop())
  assert.strictEqual(out.warnsAfterLoad, 0, '模块加载期的内部模式不得触发回落告警')
  assert.ok(out.rejectedCount >= 3, `前置条件：本轮清洗必须让 ≥3 条内部模式编译失败（实际 ${out.rejectedCount}）——否则「只告警一次」只是被 _reCache 挡住，测不到一次性标记`)
  assert.strictEqual(out.warnsAfterFirst, 1, `首次回落必须告警且只告警一次（实际 ${out.warnsAfterFirst} 次）`)
  assert.strictEqual(out.warnsAfterAll, 1, `后续调用（含新的失败模式）不得再告警刷屏（实际 ${out.warnsAfterAll} 次）`)
  const warn = out.warns.join(' | ')
  assert.ok(warn.includes('RE2'), `告警须点明 RE2 编译失败：${warn}`)
  assert.ok(warn.includes('线性时间防护'), `告警须说明该模式失去 RE2 线性防护：${warn}`)
  assert.ok(warn.includes('href|src'), `告警须含回落模式源码：${warn}`)
  assert.ok(warn.includes('invalid perl operator'), `告警须含失败原因（e.message）：${warn}`)
  assert.ok(!warn.includes('SUPERSECRETVALUE123456'), `告警须经既有脱敏通道遮蔽凭据：${warn}`)
  assert.ok(warn.includes('token=***'), `凭据应按既有 redact 形态遮蔽为 ***：${warn}`)
  assert.ok(!/javascript/i.test(out.outFirst) && out.outFirst.includes('href=""'), `回落行为不变：危险协议仍须清空（${out.outFirst}）`)
  // CodeQL js/incomplete-url-substring-sanitization：对输出做 URL 子串判定不安全（任意主机可前后拼接），
  // 改为解析出 href 属性值后整体比较——正是「合法 href 仍须保留」的精确形式，不再是 URL 子串检查。
  const keptHref = /href="([^"]*)"/.exec(out.outSecond)
  assert.ok(keptHref && keptHref[1] === 'https://u.jd.com/a', `回落行为不变：合法 href 仍须保留（${out.outSecond}）`)
  assert.ok(!/javascript/i.test(out.outThird), `回落行为不变：src/srcset 清洗仍生效（${out.outThird}）`)
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_utils_pure.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
