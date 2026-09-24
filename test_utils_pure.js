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

// ===== _htmlTagSpans：标签区间 / 属性值引号状态机（HTML5 数据态）精确断言 =====
// 反例（改动前）：该函数只被 sanitizeDecodedHtml 等高层用例间接覆盖，返回的 spans（每个标签的
// [起始, 结束) 区间，**0-based**）与 valueQuotes（**属性值开启引号**所在下标集合）从未被直接断言——
// 于是 27 个 ConditionalExpression、12 个 BlockStatement（空块，状态机副作用消失）、
// 28 个 StringLiteral（状态名/引号字面量替换）全部存活。此处对中间状态做精确断言，
// 并附「valueQuotes 语义」显式用例，避免快照被误读为恒等桩。
const spansOf = (html) => {
  const r = Utils._htmlTagSpans(html)
  return { spans: r.spans, valueQuotes: [...r.valueQuotes] }
}
check('_htmlTagSpans: valueQuotes 只记属性值**开启**引号（不含闭合引号）', () => {
  // <div class="a"> 的双引号在 0-based 下标 11；闭合引号在 14，不得记入
  assert.deepStrictEqual(spansOf('<div class="a">'), { spans: [[1, 15]], valueQuotes: [11] })
})
check('_htmlTagSpans: 结束标签同样进属性状态机（</div class="a">）', () => {
  // 若把 '</' + 字母 判成 bogusComment（不解析属性），valueQuotes 会丢
  assert.deepStrictEqual(spansOf('</div class="a">'), { spans: [[2, 16]], valueQuotes: [12] })
})
check('_htmlTagSpans: 未加引号值内的空格结束值（不记 valueQuotes）', () => {
  assert.deepStrictEqual(spansOf('<div class=a b>'), { spans: [[1, 15]], valueQuotes: [] })
})
check('_htmlTagSpans: 无标签/孤立 < 不产生区间', () => {
  assert.deepStrictEqual(spansOf('plain < text'), { spans: [], valueQuotes: [] })
  assert.deepStrictEqual(spansOf('ab<'), { spans: [], valueQuotes: [] }) // 末尾 '<'：下一字符 undefined 不得被当成标签起始
})
const spanCases = [
  ['', { spans: [], valueQuotes: [] }],
  ['plain text', { spans: [], valueQuotes: [] }],
  ['a < b', { spans: [], valueQuotes: [] }],
  ['ab<', { spans: [], valueQuotes: [] }],
  ['<div>', { spans: [[1, 5]], valueQuotes: [] }],
  ['<div class="a">', { spans: [[1, 15]], valueQuotes: [11] }],
  ["<div class='a'>", { spans: [[1, 15]], valueQuotes: [11] }],
  ['<div class=a>', { spans: [[1, 13]], valueQuotes: [] }],
  ['<div class="a b">', { spans: [[1, 17]], valueQuotes: [11] }],
  ['</div>', { spans: [[2, 6]], valueQuotes: [] }],
  ['</div class="a">', { spans: [[2, 16]], valueQuotes: [12] }],
  ['</a/b="c">', { spans: [[2, 10]], valueQuotes: [6] }],
  ['</!x y>z<a>', { spans: [[2, 7], [9, 11]], valueQuotes: [] }],
  ['</?x y>z<a>', { spans: [[2, 7], [9, 11]], valueQuotes: [] }],
  ['<a b="c"d="e">', { spans: [[1, 14]], valueQuotes: [5, 10] }],
  ['<a b="c d=e" f>', { spans: [[1, 15]], valueQuotes: [5] }],
  ['<a b="x" c>', { spans: [[1, 11]], valueQuotes: [5] }],
  ['<div/>', { spans: [[1, 6]], valueQuotes: [] }],
  ['<div a=b/>', { spans: [[1, 10]], valueQuotes: [] }],
  ['<div a="b', { spans: [[1, 9]], valueQuotes: [7] }],
  ["<div a='b", { spans: [[1, 9]], valueQuotes: [7] }],
  ['<div a=b c>', { spans: [[1, 11]], valueQuotes: [] }],
  ['<div a===b>', { spans: [[1, 11]], valueQuotes: [] }],
  ['<a b=', { spans: [[1, 5]], valueQuotes: [] }],
  ['<a b= >', { spans: [[1, 7]], valueQuotes: [] }],
  ['<a b c="d" e>', { spans: [[1, 13]], valueQuotes: [7] }],
  ['<a b="c"><d>', { spans: [[1, 9], [10, 12]], valueQuotes: [5] }],
  ['<a b=c d=e f>', { spans: [[1, 13]], valueQuotes: [] }],
  ['<div class', { spans: [[1, 10]], valueQuotes: [] }],
  ['<a/b="c" d>', { spans: [[1, 11]], valueQuotes: [5] }],
  ['<a b="c" /d="e">', { spans: [[1, 16]], valueQuotes: [5, 12] }],
  ['<a   b="c">', { spans: [[1, 11]], valueQuotes: [7] }],
  ['<a b=  "c">', { spans: [[1, 11]], valueQuotes: [7] }],
  ['<a b="c>d">', { spans: [[1, 11]], valueQuotes: [5] }],
  ['</x y=z>', { spans: [[2, 8]], valueQuotes: [] }],
  ['< >', { spans: [], valueQuotes: [] }],
  ['<1abc>', { spans: [], valueQuotes: [] }],
  ['<a b=1 c=2>', { spans: [[1, 11]], valueQuotes: [] }],
  ['<a b="x y" z="w">', { spans: [[1, 17]], valueQuotes: [5, 13] }],
  ['<a b="x>', { spans: [[1, 8]], valueQuotes: [5] }],
  ['<a b="x', { spans: [[1, 7]], valueQuotes: [5] }],
  ["<a b=\"c\" d='e'>", { spans: [[1, 15]], valueQuotes: [5, 11] }],
  ['<a b="c" >', { spans: [[1, 10]], valueQuotes: [5] }],
  ['<a b>', { spans: [[1, 5]], valueQuotes: [] }],
  ['<a b/ >', { spans: [[1, 7]], valueQuotes: [] }],
  ['</a>', { spans: [[2, 4]], valueQuotes: [] }],
  ['<a><b><c>', { spans: [[1, 3], [4, 6], [7, 9]], valueQuotes: [] }],
  ['<a b="c"d="e"f="g">', { spans: [[1, 19]], valueQuotes: [5, 10, 15] }],
  ['<a b="c\n d">', { spans: [[1, 12]], valueQuotes: [5] }],
  ['<a\tb="c">', { spans: [[1, 9]], valueQuotes: [5] }]
]
spanCases.forEach(([html, want]) => {
  check(`_htmlTagSpans: HTML5 数据态快照 ${JSON.stringify(html)}`, () => {
    assert.deepStrictEqual(spansOf(html), want)
  })
})

// ===== 日期解析子函数：显式分支直接断言 =====
// 反例（改动前）：parseTime 的高层用例只覆盖少数格式，且 _parseDateTimeNoTz/_parseSlashDate/
// _parseIsoZ 是「先返回 undefined=未匹配 / null=非法 / 数字=毫秒」的三态协议——只断言
// parseTime 的最终值会被后续分支（_parseFallback 的补 Z / 宿主宽松解析）掩盖，
// 于是锚点、量词、范围校验与回读校验的大量变异体存活。此处直接调用子函数并按三态断言。
// 全部期望值以 Date.UTC 计算，不依赖本机时区（CI 变异测试跑在 UTC）。
const utcMs = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h, mi, s, ms)
check('_parseDateTimeNoTz: 基本格式按 UTC 解析（空格/T 分隔等价）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:30:00'), utcMs(2026, 9, 8, 10, 30, 0))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08T10:30:00'), utcMs(2026, 9, 8, 10, 30, 0))
})
check('_parseDateTimeNoTz: 单数字月/日（1~2 位量词）与 / 分隔符', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-9-8 10:30:00'), utcMs(2026, 9, 8, 10, 30, 0))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026/9/8 10:30:00'), utcMs(2026, 9, 8, 10, 30, 0))
})
check('_parseDateTimeNoTz: 秒可选（省略秒 → 0）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08T10:30'), utcMs(2026, 9, 8, 10, 30, 0))
})
check('_parseDateTimeNoTz: 秒必须是两位数字（05 ≠ 5，60 秒非法）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:30:05'), utcMs(2026, 9, 8, 10, 30, 5))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:30:5'), undefined)
})
check('_parseDateTimeNoTz: 毫秒 1~3 位并按左对齐补零（.5=500ms，.123=123ms）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08T10:30:00.5'), utcMs(2026, 9, 8, 10, 30, 0, 500))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08T10:30:00.123'), utcMs(2026, 9, 8, 10, 30, 0, 123))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08T10:30:00.999'), utcMs(2026, 9, 8, 10, 30, 0, 999))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08T10:30:00.1234'), undefined)
})
check('_parseDateTimeNoTz: ^ 锚点（拒绝前缀脏字符）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('x2026-09-08 10:30:00'), undefined)
})
check('_parseDateTimeNoTz: $ 锚点（拒绝后缀脏字符）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:30:00x'), undefined)
})
check('_parseDateTimeNoTz: 边界合法值（1 月/12 月/23 时/59 分/59 秒）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-01-08 10:30:00'), utcMs(2026, 1, 8, 10, 30, 0))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-12-08 10:30:00'), utcMs(2026, 12, 8, 10, 30, 0))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 23:30:00'), utcMs(2026, 9, 8, 23, 30, 0))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:59:00'), utcMs(2026, 9, 8, 10, 59, 0))
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:30:59'), utcMs(2026, 9, 8, 10, 30, 59))
})
check('_parseDateTimeNoTz: 回读校验拒绝宿主滚动（2026-02-30 / 2026-04-31）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-02-30 10:30:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-04-31 10:30:00'), null)
})
check('_parseDateTimeNoTz: 越界字段返回 null（月 0/13、日 0/32、时 24、分 60、秒 60）', () => {
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-00-08 10:30:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-13-08 10:30:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-00 10:30:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-32 10:30:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 24:30:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:60:00'), null)
  assert.strictEqual(Utils._parseDateTimeNoTz('2026-09-08 10:30:60'), null)
})
check('_parseSlashDate: 基本格式与单数字月日', () => {
  assert.strictEqual(Utils._parseSlashDate('2026/09/08'), utcMs(2026, 9, 8))
  assert.strictEqual(Utils._parseSlashDate('2026/9/8'), utcMs(2026, 9, 8))
})
check('_parseSlashDate: ^/$ 锚点与非法格式回落 undefined', () => {
  assert.strictEqual(Utils._parseSlashDate('x2026/09/08'), undefined)
  assert.strictEqual(Utils._parseSlashDate('2026/09/08x'), undefined)
  assert.strictEqual(Utils._parseSlashDate('2026/9/8 10:30'), undefined)
  assert.strictEqual(Utils._parseSlashDate('2026-09-08'), undefined)
})
check('_parseSlashDate: 边界合法值 1 月/12 月/31 日', () => {
  assert.strictEqual(Utils._parseSlashDate('2026/01/08'), utcMs(2026, 1, 8))
  assert.strictEqual(Utils._parseSlashDate('2026/12/08'), utcMs(2026, 12, 8))
  assert.strictEqual(Utils._parseSlashDate('2026/08/31'), utcMs(2026, 8, 31))
})
check('_parseSlashDate: 回读校验拒绝滚动（2026/02/30、2026/04/31）与闰日', () => {
  assert.strictEqual(Utils._parseSlashDate('2026/02/30'), null)
  assert.strictEqual(Utils._parseSlashDate('2026/04/31'), null)
  assert.strictEqual(Utils._parseSlashDate('2026/2/29'), null) // 2026 非闰年
  assert.strictEqual(Utils._parseSlashDate('2024/2/29'), utcMs(2024, 2, 29))
})
check('_parseSlashDate: 越界字段返回 null', () => {
  assert.strictEqual(Utils._parseSlashDate('2026/13/08'), null)
  assert.strictEqual(Utils._parseSlashDate('2026/00/08'), null)
  assert.strictEqual(Utils._parseSlashDate('2026/09/00'), null)
  assert.strictEqual(Utils._parseSlashDate('2026/09/32'), null)
})
check('_parseIsoZ: Z / 毫秒 / 省略秒 / 数字偏移', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00Z'), utcMs(2026, 9, 8, 10, 30, 0))
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00.123Z'), utcMs(2026, 9, 8, 10, 30, 0, 123))
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30Z'), utcMs(2026, 9, 8, 10, 30, 0))
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00+08:00'), utcMs(2026, 9, 8, 2, 30, 0))
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00-05:00'), utcMs(2026, 9, 8, 15, 30, 0))
})
check('_parseIsoZ: 偏移缺省冒号（+0800）与小写 z（i 标志）', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00+0800'), utcMs(2026, 9, 8, 2, 30, 0))
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00z'), utcMs(2026, 9, 8, 10, 30, 0))
})
check('_parseIsoZ: 量词/字符类边界（毫秒 1~3 位、偏移两位数字）', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00.12Z'), utcMs(2026, 9, 8, 10, 30, 0, 120))
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00.1234Z'), undefined)
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00+8:00'), undefined)
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00+08:0'), undefined)
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00+08:aa'), undefined)
})
check('_parseIsoZ: ^/$ 锚点与 T 分隔要求', () => {
  assert.strictEqual(Utils._parseIsoZ('x2026-09-08T10:30:00Z'), undefined)
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00Zx'), undefined)
  assert.strictEqual(Utils._parseIsoZ('2026-09-08 10:30:00Z'), undefined)
})
check('_parseIsoZ: 非补零 ISO 的补零回退（宿主 Invalid 时）', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-12-1T00:00:00Z'), utcMs(2026, 12, 1))
  assert.strictEqual(Utils._parseIsoZ('2026-8-12T00:00:00Z'), utcMs(2026, 8, 12))
  assert.strictEqual(Utils._parseIsoZ('2026-9-8T00:00:00Z'), utcMs(2026, 9, 8))
})
check('_parseIsoZ: 宿主无法解析的合法年月日 → null（不得返回 NaN）', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T99:99:00Z'), null)
})
check('_parseIsoZ: 边界合法值 1 月/12 月', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-01-08T00:00:00Z'), utcMs(2026, 1, 8))
  assert.strictEqual(Utils._parseIsoZ('2026-12-08T00:00:00Z'), utcMs(2026, 12, 8))
})
check('_parseIsoZ: 回读校验拒绝滚动日期', () => {
  assert.strictEqual(Utils._parseIsoZ('2026-02-30T00:00:00Z'), null)
  assert.strictEqual(Utils._parseIsoZ('2026-04-31T00:00:00Z'), null)
  assert.strictEqual(Utils._parseIsoZ('2026-13-08T00:00:00Z'), null)
  assert.strictEqual(Utils._parseIsoZ('2026-09-32T00:00:00Z'), null)
})
check('日期子函数: 年份取正值（+isoZ[1]）', () => {
  // 取负年份后回读仍自洽（-2026 的 UTC 回读仍是 -2026），只有精确值能抓住
  assert.strictEqual(Utils._parseIsoZ('2026-09-08T10:30:00Z'), utcMs(2026, 9, 8, 10, 30, 0))
  assert.ok(Utils._parseIsoZ('2026-09-08T10:30:00Z') > 0, '2026 年解析结果必须为正时间戳')
  assert.ok(Utils._parseSlashDate('2026/09/08') > 0, '2026 年解析结果必须为正时间戳')
  assert.ok(Utils._parseDateTimeNoTz('2026-09-08 10:30:00') > 0, '2026 年解析结果必须为正时间戳')
})

// ===== getMessageIdentity：统一身份（id > url > 匿名合成键）=====
// 反例（改动前）：既有用例只断言 hasValidId 与 getMessageIdentity 的「一致性」与 valid 布尔，
// 从不断言返回对象的精确形状/键值，也从不构造「历史匿名 id 降级」的判重边界 ——
// 于是 32 个 StringLiteral（字段名 '' / 键前缀 ''）与 11 个 ConditionalExpression 存活。
const anonOf = (m) => Utils.anonKey(
  m.title, m.content, m.posttime, m.shijianchuo, m.pic, m.mall_name, m.price, m.brand, m.catename, m.louzhu
)
check('getMessageIdentity: 非法条目返回精确的 invalid 形状', () => {
  const want = { valid: false, kind: 'invalid', key: '', idKey: '', url: '' }
  for (const bad of [null, undefined, 'x', 1, [], [1]]) {
    assert.deepStrictEqual(Utils.getMessageIdentity(bad), want, `非法条目 ${JSON.stringify(bad)} 必须是 invalid 形状`)
  }
})
check('getMessageIdentity: 数组不算有效条目（即使带 title 等字段）', () => {
  // isValidItem 明确排除数组；若放开，带 title 的数组会被判成有效匿名身份而混进判重索引
  const arr = Object.assign([1], { title: 't', content: 'c' })
  assert.strictEqual(Utils.getMessageIdentity(arr).valid, false, '数组必须不是有效条目')
})
check('getMessageIdentity: id 身份返回精确形状与 id: 前缀', () => {
  assert.deepStrictEqual(Utils.getMessageIdentity({ id: 123 }), { valid: true, kind: 'id', key: 'id:123', idKey: '123', url: '' })
  assert.deepStrictEqual(Utils.getMessageIdentity({ id: 'abc' }), { valid: true, kind: 'id', key: 'id:abc', idKey: 'abc', url: '' })
})
check('getMessageIdentity: 字符串 id 两侧空白被 trim（trim 语义与空串判非）', () => {
  assert.strictEqual(Utils.getMessageIdentity({ id: ' a ' }).idKey, 'a')
  assert.strictEqual(Utils.getMessageIdentity({ id: ' a ' }).key, 'id:a')
  assert.strictEqual(Utils.getMessageIdentity({ id: '  ' }).valid, false, '纯空白 id 不是有效 id')
})
check('getMessageIdentity: 仅 number 且有限才算 id（NaN/Infinity 无效）', () => {
  assert.strictEqual(Utils.getMessageIdentity({ id: Number.NaN }).valid, false)
  assert.strictEqual(Utils.getMessageIdentity({ id: Infinity }).valid, false)
  assert.strictEqual(Utils.getMessageIdentity({ id: 0 }).valid, true, 'id=0 是有效数值 id')
  assert.strictEqual(Utils.getMessageIdentity({ id: 0 }).key, 'id:0')
})
check('getMessageIdentity: 字符串 id 不走数值分支（typeof 判定类型）', () => {
  assert.strictEqual(Utils.getMessageIdentity({ id: 'abc' }).kind, 'id')
  assert.strictEqual(Utils.getMessageIdentity({ id: 'abc' }).key, 'id:abc')
})
check('getMessageIdentity: 继承来的 id 不算本条消息的 id', () => {
  const inherited = Object.create({ id: 'abc' })
  assert.strictEqual(Utils.getMessageIdentity(inherited).valid, false, '原型链 id 必须被忽略')
  assert.strictEqual(Utils.getMessageIdentity(Object.assign(Object.create({ id: 'x' }), { id: 0 })).valid, true, '自有 id 仍有效')
})
check('getMessageIdentity: 继承来的 url 不算本条消息的 url', () => {
  const inherited = Object.create({ url: 'https://example.com/a' })
  assert.strictEqual(Utils.getMessageIdentity(inherited).valid, false, '原型链 url 必须被忽略')
  assert.strictEqual(Utils.getMessageIdentity(inherited).kind, 'invalid')
})
check('getMessageIdentity: url 身份返回精确形状与 url: 前缀', () => {
  const id = Utils.getMessageIdentity({ url: 'https://example.com/a' })
  assert.deepStrictEqual(id, { valid: true, kind: 'url', key: 'url:https://example.com/a', idKey: '', url: 'https://example.com/a' })
})
check('getMessageIdentity: 危险协议 url 不构成 url 身份', () => {
  assert.strictEqual(Utils.getMessageIdentity({ url: 'javascript:alert(1)' }).kind, 'invalid')
})
check('getMessageIdentity: 匿名身份返回精确形状（anonKey 同源）', () => {
  const m = { title: 't', content: 'c' }
  const key = anonOf(m)
  assert.deepStrictEqual(Utils.getMessageIdentity(m), { valid: true, kind: 'anon', key, idKey: '', url: '', anonKey: key })
})
check('getMessageIdentity: 每个字段都参与匿名身份（改一个字段必须换键）', () => {
  const base = { title: 't', content: 'c', posttime: 'p', shijianchuo: 's', pic: 'pic', mall_name: 'mn', price: 'pr', brand: 'br', catename: 'cn', louzhu: 'lz' }
  const baseKey = Utils.getMessageIdentity(base).key
  assert.strictEqual(baseKey, anonOf(base), '匿名键必须与同字段序的 anonKey 完全一致')
  for (const f of ['title', 'content', 'posttime', 'shijianchuo', 'pic', 'mall_name', 'price', 'brand', 'catename', 'louzhu']) {
    const other = Object.assign({}, base, { [f]: base[f] + 'X' })
    assert.notStrictEqual(Utils.getMessageIdentity(other).key, baseKey, `字段 ${f} 必须参与匿名身份`)
  }
})
check('getMessageIdentity: 全字段为空退化为 invalid（不与其它空消息互相吞掉）', () => {
  assert.deepStrictEqual(Utils.getMessageIdentity({}), { valid: false, kind: 'invalid', key: '', idKey: '', url: '' })
})
check('getMessageIdentity: 历史匿名 id + 无 url → 降级为匿名身份（须含全部 10 个字段）', () => {
  const fields = { title: 't', content: 'c', posttime: 'p', shijianchuo: 's', pic: 'pic', mall_name: 'mn', price: 'pr', brand: 'br', catename: 'cn', louzhu: 'lz' }
  const selfKey = anonOf(fields)
  const m = Object.assign({ id: selfKey }, fields)
  assert.deepStrictEqual(Utils.getMessageIdentity(m), { valid: true, kind: 'anon', key: selfKey, idKey: '', url: '', anonKey: selfKey })
})
check('getMessageIdentity: 历史匿名 id + 有 url → 保持 id/url 权威（不得降级）', () => {
  const fields = { title: 't', content: 'c', posttime: 'p', shijianchuo: 's', pic: 'pic', mall_name: 'mn', price: 'pr', brand: 'br', catename: 'cn', louzhu: 'lz' }
  const selfKey = anonOf(fields)
  const m = Object.assign({ id: selfKey, url: 'https://example.com/a' }, fields)
  const got = Utils.getMessageIdentity(m)
  assert.strictEqual(got.kind, 'id', '有 url 时历史匿名 id 不降级（url 在场仍走 id/url 判重）')
  assert.strictEqual(got.key, 'id:' + selfKey)
})
check('getMessageIdentity: 退化键 anon:1505cde7 不享受降级（保持 id 权威）', () => {
  const got = Utils.getMessageIdentity({ id: 'anon:1505cde7' })
  assert.strictEqual(got.kind, 'id', '全空字段退化键不得被当成历史身份哈希')
  assert.strictEqual(got.key, 'id:anon:1505cde7')
})
check('getMessageIdentity: 自身哈希与 id 不符的真实 id 保持 id 权威', () => {
  const got = Utils.getMessageIdentity({ id: 'anon:abc123', title: 't', content: 'c' })
  assert.strictEqual(got.kind, 'id')
  assert.strictEqual(got.key, 'id:anon:abc123')
})

// ===== shallowEqualIgnoringTimestamp：零分配浅层相等快速短路 =====
// 反例（改动前）：只测了少数对象对，null/原始值/数组/数组↔对象/缺键等边界从未覆盖，
// 于是 16 个 ConditionalExpression（含整段条件）、7 个 EqualityOperator、2 个 CallExpression
// （push 被删）与 BlockStatement 空块全部存活。
const shallow = (a, b) => Utils.shallowEqualIgnoringTimestamp(a, b)
check('shallowEqualIgnoringTimestamp: 同引用/同原始值 → true', () => {
  const o = { a: 1 }
  assert.strictEqual(shallow(o, o), true, '同引用对象必须短路为相等')
  assert.strictEqual(shallow(1, 1), true, '同原始值必须短路为相等')
  assert.strictEqual(shallow('a', 'a'), true)
})
check('shallowEqualIgnoringTimestamp: 非对象一侧 → false（不得断言相等）', () => {
  assert.strictEqual(shallow({}, 1), false)
  assert.strictEqual(shallow(1, {}), false)
  assert.strictEqual(shallow(1, 2), false)
  assert.strictEqual(shallow(null, null), true, '同引用短路优先：null === null 直接判等')
  assert.strictEqual(shallow(undefined, undefined), true, '同引用短路优先：undefined === undefined')
  assert.strictEqual(shallow(null, { a: 1 }), false)
  assert.strictEqual(shallow(null, undefined), false)
})
check('shallowEqualIgnoringTimestamp: 字符串 vs 同内容索引对象（键集合相等时不得误判）', () => {
  // typeof 'x' !== 'object'：字符串必须走非对象分支返回 false，不能被 Object.keys 的索引键骗过
  assert.strictEqual(shallow('x', { 0: 'x' }), false)
  assert.strictEqual(shallow({ 0: 'x' }, 'x'), false)
})
check('shallowEqualIgnoringTimestamp: 数组↔普通对象不得判等', () => {
  assert.strictEqual(shallow([1], { 0: 1 }), false)
  assert.strictEqual(shallow([1], [1]), true, '两个同内容数组应短路径相等')
})
check('shallowEqualIgnoringTimestamp: 键集合不同 → false', () => {
  assert.strictEqual(shallow({ a: undefined }, { b: 1 }), false, 'b 缺键时不得因两侧取值都是 undefined 而判等')
  assert.strictEqual(shallow({ a: 1 }, { a: 1, b: 2 }), false)
})
check('shallowEqualIgnoringTimestamp: 同内容对象 → true，值不同 → false', () => {
  assert.strictEqual(shallow({ a: 1, b: 2 }, { a: 1, b: 2 }), true)
  assert.strictEqual(shallow({ a: 1 }, { a: 2 }), false)
  assert.strictEqual(shallow({ a: 1 }, { a: 1 }), true)
})
check('shallowEqualIgnoringTimestamp: 忽略顶层 timestamp 字段', () => {
  assert.strictEqual(shallow({ a: 1, timestamp: 5 }, { a: 1 }), true)
  assert.strictEqual(shallow({ a: 1, timestamp: 1 }, { a: 1, timestamp: 2 }), true)
  assert.strictEqual(shallow({ timestamp: 1 }, { timestamp: 2 }), true, '两侧只剩 timestamp → 忽略后都为空 → 相等')
  assert.strictEqual(shallow({ timestamp: 1 }, {}), true)
})
check('shallowEqualIgnoringTimestamp: 嵌套对象同引用 → true，异引用 → false（交回深排）', () => {
  const inner = { x: 1 }
  assert.strictEqual(shallow({ a: inner }, { a: inner }), true, '同引用嵌套对象必须短路为相等')
  assert.strictEqual(shallow({ a: { x: 1 } }, { a: { x: 1 } }), false, '异引用对象一律交回深排')
})
check('shallowEqualIgnoringTimestamp: 取值抛错的 getter → false（不得崩）', () => {
  const bad = {}
  Object.defineProperty(bad, 'a', { enumerable: true, get () { throw new Error('getter') } })
  assert.strictEqual(shallow(bad, { a: 1 }), false)
  assert.strictEqual(shallow({ a: 1 }, bad), false)
})

// ===== diskSpace：容量上报的全部守卫（注入假 fs）=====
// 反例（改动前）：无任何用例注入 fs，diskSpace 的 33 个存活变异体（13 ConditionalExpression、
// 7 EqualityOperator、BlockStatement 空块、ObjectLiteral 空对象）从未被执行到。
const diskWith = (fsImpl) => createUtils({ safeRe, fs: fsImpl })
const diskStat = (st) => diskWith({ statfsSync: () => st }).diskSpace('/x')
check('diskSpace: 正常统计返回精确容量（bsize 优先于 frsize）', () => {
  assert.deepStrictEqual(diskStat({ bsize: 4096, frsize: 1024, bavail: 10, blocks: 100 }), { freeBytes: 40960, totalBytes: 409600 })
})
check('diskSpace: bsize 缺失或为 0 时回落 frsize', () => {
  assert.deepStrictEqual(diskStat({ frsize: 1024, bavail: 5, blocks: 100 }), { freeBytes: 5120, totalBytes: 102400 })
  assert.deepStrictEqual(diskStat({ bsize: 0, frsize: 2048, bavail: 2, blocks: 10 }), { freeBytes: 4096, totalBytes: 20480 })
})
check('diskSpace: statfsSync 缺失/非函数 → null', () => {
  assert.strictEqual(diskWith({}).diskSpace('/x'), null)
  assert.strictEqual(diskWith({ statfsSync: 'notfn' }).diskSpace('/x'), null)
})
check('diskSpace: statfsSync 抛错 → null（不中断主流程）', () => {
  assert.strictEqual(diskWith({ statfsSync: () => { throw new Error('boom') } }).diskSpace('/x'), null)
})
check('diskSpace: bsize 非有限或 <= 0 → null（0/负/NaN/非数字都拒绝）', () => {
  for (const bsize of [0, -1, Number.NaN, undefined, 'x']) {
    assert.strictEqual(diskStat({ bsize, frsize: 0, bavail: 10, blocks: 10 }), null, `bsize=${String(bsize)} 必须拒绝`)
  }
})
check('diskSpace: bavail 负数 → null；0 合法', () => {
  assert.strictEqual(diskStat({ bsize: 4096, bavail: -1, blocks: 10 }), null)
  assert.deepStrictEqual(diskStat({ bsize: 4096, bavail: 0, blocks: 0 }), { freeBytes: 0, totalBytes: 0 })
})
check('diskSpace: bavail 非有限 → null', () => {
  assert.strictEqual(diskStat({ bsize: 4096, bavail: Number.NaN, blocks: 10 }), null)
  assert.strictEqual(diskStat({ bsize: 4096, bavail: undefined, blocks: 10 }), null)
})
check('diskSpace: blocks 非有限 → totalBytes 为 null，freeBytes 仍上报', () => {
  assert.deepStrictEqual(diskStat({ bsize: 4096, bavail: 10 }), { freeBytes: 40960, totalBytes: null })
  assert.deepStrictEqual(diskStat({ bsize: 4096, bavail: 10, blocks: Number.NaN }), { freeBytes: 40960, totalBytes: null })
})
check('diskSpace: blocks 为 0 合法（totalBytes=0），负数 → null', () => {
  assert.deepStrictEqual(diskStat({ bsize: 4096, bavail: 10, blocks: 0 }), { freeBytes: 40960, totalBytes: 0 })
  assert.deepStrictEqual(diskStat({ bsize: 4096, bavail: 10, blocks: -5 }), { freeBytes: 40960, totalBytes: null })
})
check('diskSpace: totalBytes 是 bsize*blocks（乘法而非除法）', () => {
  assert.strictEqual(diskStat({ bsize: 4096, bavail: 1, blocks: 100 }).totalBytes, 409600)
  assert.strictEqual(diskStat({ bsize: 1000, bavail: 1, blocks: 3 }).totalBytes, 3000)
})

// ===== truncateUtf16 / isModifier：修饰符区间端点 =====
// 反例（改动前）：只测了长度上界与个别 emoji，修饰符判定 isModifier 的 9 个字符类区间
// （ZWJ/VS/组合音标/组合符号/修饰符字母/半角组合符/肤色/VS 补充）的 >= / <= 端点从未被覆盖，
// 14 个 EqualityOperator 与 3 个 ConditionalExpression 因此存活。
check('truncateUtf16: 截断点后的修饰符必须退位（9 个区间的 16 个端点全覆盖）', () => {
  // 0x200D(ZWJ) 由 line 1283/1287 的专用分支处理，不走 isModifier 退位（单独断言）
  for (const cp of [0xFE00, 0xFE0F, 0x0300, 0x036F, 0x1AB0, 0x1AFF, 0x1DC0, 0x1DFF, 0x20D0, 0x20FF, 0xFE20, 0xFE2F, 0x1F3FB, 0x1F3FF, 0xE0100, 0xE01EF]) {
    const ch = String.fromCodePoint(cp)
    assert.strictEqual(Utils.truncateUtf16('A' + ch + 'B', 1), '', `U+${cp.toString(16).toUpperCase()} 是修饰符，截断到 1 必须退位`)
  }
})
check('truncateUtf16: 非修饰符字符不退位（区间外侧与 ZWJ 专用分支）', () => {
  for (const cp of [0x200C, 0x200D, 0x200E, 0xFE10, 0x0370, 0x1B00, 0x1E00, 0x2100, 0xFE30, 0x1F400, 0xE0200, 0x58]) {
    const ch = String.fromCodePoint(cp)
    assert.strictEqual(Utils.truncateUtf16('A' + ch + 'B', 1), 'A', `U+${cp.toString(16).toUpperCase()} 不是（退位用）修饰符`)
  }
})
check('truncateUtf16: 代理对不被切断（高代理后截断退位、完整对保留）', () => {
  assert.strictEqual(Utils.truncateUtf16('👍x', 1), '', '截断点落在高代理后必须退位')
  assert.strictEqual(Utils.truncateUtf16('👍x', 2), '👍', '完整代理对应保留')
  assert.strictEqual(Utils.truncateUtf16('a😀b', 2), 'a', '😀 被切在中间 → 退位到 a')
  assert.strictEqual(Utils.truncateUtf16('a😀b', 3), 'a😀')
})
check('truncateUtf16: 补充平面修饰符紧随基底时退位（👍🏽 不拆散）', () => {
  assert.strictEqual(Utils.truncateUtf16('👍🏽x', 2), '', '👍 后紧跟肤色修饰符 → 退位')
  assert.strictEqual(Utils.truncateUtf16('👍🏽x', 3), '', '仍受修饰符影响 → 继续退位')
  assert.strictEqual(Utils.truncateUtf16('👍🏽', 4), '👍🏽', '完整序列保留')
})
check('truncateUtf16: 变体选择符/组合音标/ZWNJ 组合序列不被拆散', () => {
  assert.strictEqual(Utils.truncateUtf16('❤️x', 1), '', '❤ 后紧跟 VS16 → 退位')
  assert.strictEqual(Utils.truncateUtf16('❤️x', 2), '❤️')
  assert.strictEqual(Utils.truncateUtf16('e\u0301x', 1), '', 'e 后紧跟组合重音 → 退位')
  assert.strictEqual(Utils.truncateUtf16('e\u0301x', 2), 'e\u0301')
})
check('truncateUtf16: ZWJ 序列在末尾 ZWJ 处退位，区域指示符不按修饰符退位', () => {
  assert.strictEqual(Utils.truncateUtf16('👨‍👩‍👧‍👦', 5), '👨‍👩', '末尾 ZWJ 退位，不拆家庭 emoji')
  assert.strictEqual(Utils.truncateUtf16('👨‍👩‍👧‍👦', 8), '👨‍👩‍👧')
  assert.strictEqual(Utils.truncateUtf16('A🇨🇳', 2), 'A', '区域指示符不作为前一字符的修饰符退位（A 必须保留）')
  assert.strictEqual(Utils.truncateUtf16('A🇨🇳', 3), 'A🇨')
})
check('truncateUtf16: max 非正/非有限不截断', () => {
  assert.strictEqual(Utils.truncateUtf16('hello', 0), 'hello')
  assert.strictEqual(Utils.truncateUtf16('hello', -1), 'hello')
  assert.strictEqual(Utils.truncateUtf16('hello', Number.NaN), 'hello')
  assert.strictEqual(Utils.truncateUtf16('hello', undefined), 'hello')
})

// ===== _removeActiveTags：主动标签移除 =====
// 反例（改动前）：只经由 sanitizeDecodedHtml 间接覆盖，外层守卫/逐标签预检/独立替换的
// 标志位（'i'/'gi'）与 embed 不在外层守卫的有意不对称从未被断言，15 个变异体存活。
check('_removeActiveTags: 成对主动标签整体移除（含标签内容）', () => {
  assert.strictEqual(Utils._removeActiveTags('before<script>alert(1)</script>after'), 'beforeafter')
  for (const tag of ['style', 'iframe', 'object', 'svg', 'math', 'script']) {
    assert.strictEqual(Utils._removeActiveTags(`<${tag}>INNER</${tag}>`), '', `${tag} 成对标签应整体移除`)
  }
})
check('_removeActiveTags: 大小写不敏感（守卫与逐标签预检都要 i 标志）', () => {
  assert.strictEqual(Utils._removeActiveTags('<SCRIPT>alert(1)</SCRIPT>'), '', '全大写 script 必须整体移除')
  assert.strictEqual(Utils._removeActiveTags('<STYLE>a{}</STYLE>'), '')
  assert.strictEqual(Utils._removeActiveTags('<SCRIPT src=x></SCRIPT >'), '')
})
check('_removeActiveTags: 未闭合主动标签移除（含只有 embed 才有的未闭合分支）', () => {
  assert.strictEqual(Utils._removeActiveTags('<svg onload=alert(1)>'), '')
  assert.strictEqual(Utils._removeActiveTags('<SVG onload=alert(1)>'), '')
  assert.strictEqual(Utils._removeActiveTags('<embed src=x>'), '')
  assert.strictEqual(Utils._removeActiveTags('<base href=x><link rel=x><meta charset=x>'), '')
  assert.strictEqual(Utils._removeActiveTags('<BASE href=x>'), '')
})
check('_removeActiveTags: embed 不在外层守卫中是有意不对称（成对时闭合标签保留）', () => {
  // 外层守卫只列 script|style|iframe|object|svg|math；embed 仅出现在未闭合替换里，
  // 故 <embed></embed> 只被去掉开标签，</embed> 保留（后续事件属性清洗兜底）
  assert.strictEqual(Utils._removeActiveTags('<embed src=x></embed>'), '</embed>')
})
check('_removeActiveTags: 孤立闭合主动标签移除（gi 标志不可省）', () => {
  assert.strictEqual(Utils._removeActiveTags('</SCRIPT>'), '')
  assert.strictEqual(Utils._removeActiveTags('</script>'), '')
  assert.strictEqual(Utils._removeActiveTags('</style>'), '')
})
check('_removeActiveTags: 普通标签与文本不得误删', () => {
  assert.strictEqual(Utils._removeActiveTags('<div>x</div>'), '<div>x</div>')
  assert.strictEqual(Utils._removeActiveTags('a<b>c'), 'a<b>c')
  assert.strictEqual(Utils._removeActiveTags(''), '')
})
check('_removeActiveTags: 开/闭标签名错配时不跨标签配对删除中间内容', () => {
  // <script>...(错配)</iframe>：不得把中间内容整段删除（旧实现的开/闭交替会），
  // 只由下方「孤立闭合标签」规则去掉 </iframe>，内容 'keep' 必须保留
  assert.strictEqual(Utils._removeActiveTags('<script>keep</iframe>tail'), 'keeptail')
})

// ===== filterHash：过滤规则稳定哈希（含 safeStr / rawStr / typedRawStr / 64 位折叠）=====
// 反例（改动前）：只断言「非空/不相等」，于是 safeStr 的类型前缀与 trim、typedRawStr 的
// 类型前缀与不 trim、字段连接符、两路 djb2 的算术、pingbitime 归一化与「跨天失效」全无覆盖
// （78 个存活变异体集中在 1133-1201）。
// 精确哈希是**跨运行契约**：该值参与 App 的「过滤写入」缓存失效判定，静默变化会让全体用户
// 的 _f 缓存一次性失效/复用错位，故此处锁定字面量（非实现内部细节）。
check('filterHash: 精确哈希锁定（空配置/字符串字段/类型前缀/连接符）', () => {
  assert.strictEqual(Utils.filterHash({}, ''), '1167134403-539606814')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: '京东' }, ''), '2135914867-3402940783')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: 'x' }, ''), '1192575579-3838949264')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: 0 }, ''), '4236287210-1949960067')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: '0' }, ''), '1356396179-1500339416')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: true }, ''), '967152683-1692115204')
  assert.strictEqual(Utils.filterHash({}, 'x'), '4254808315-931165534')
  assert.strictEqual(Utils.filterHash({}, 0), '1741276522-2144425411')
  assert.strictEqual(Utils.filterHash({}, '0'), '17733683-2195236006')
  assert.strictEqual(Utils.filterHash({}, true), '1284460587-2928681860')
  assert.strictEqual(Utils.filterHash({}, 'true'), '2386670197-3538803538')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: 'a', pingbitime: 'abc' }, ''), '3245783266-2197108487')
})
check('filterHash: 空值/符号一律按空维度（不得抛穿）', () => {
  const empty = Utils.filterHash({}, '')
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: null }, ''), empty)
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: undefined }, ''), empty)
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: Symbol('s') }, ''), empty)
  assert.strictEqual(Utils.filterHash({}, undefined), empty)
  assert.strictEqual(Utils.filterHash({}, null), empty)
  assert.strictEqual(Utils.filterHash({}, Symbol('s')), empty)
})
check('filterHash: safeStr 对字符串 trim、对非字符串加 typeof 前缀', () => {
  assert.strictEqual(Utils.filterHash({ pingbibiaoti: 'x ' }, ''), Utils.filterHash({ pingbibiaoti: 'x' }, ''), '字符串先 trim')
  assert.notStrictEqual(Utils.filterHash({ pingbibiaoti: 0 }, ''), Utils.filterHash({ pingbibiaoti: '0' }, ''), '0 与 "0" 必须可区分（typeof 前缀）')
  assert.notStrictEqual(Utils.filterHash({ pingbibiaoti: true }, ''), Utils.filterHash({ pingbibiaoti: 'true' }, ''), 'true 与 "true" 必须可区分')
})
check('filterHash: zkt_gjc 加 typeof 前缀但不 trim（空白语义有意义）', () => {
  assert.notStrictEqual(Utils.filterHash({}, 'x'), Utils.filterHash({}, ' x'), 'zkt_gjc 不得 trim')
  assert.notStrictEqual(Utils.filterHash({}, 'x'), Utils.filterHash({}, 0))
  assert.notStrictEqual(Utils.filterHash({}, '0'), Utils.filterHash({}, 0))
  assert.notStrictEqual(Utils.filterHash({}, 'true'), Utils.filterHash({}, true))
})
check('filterHash: compileState 维度只接受可 String 化的有限形态', () => {
  assert.strictEqual(Utils.filterHash({}, '', 're2=1'), '3663033226-3280688469')
  assert.strictEqual(Utils.filterHash({}, '', 0), '4155696915-3842909584')
  assert.strictEqual(Utils.filterHash({}, '', ''), Utils.filterHash({}, ''), '空字符串与缺省同义')
  assert.notStrictEqual(Utils.filterHash({}, '', 're2=0'), Utils.filterHash({}, '', 're2=1'))
})
check('filterHash: pingbitime 数值归一（5/05/5.0/ 5 同值）', () => {
  const five = Utils.filterHash({ pingbitime: '5' }, '')
  assert.strictEqual(Utils.filterHash({ pingbitime: '05' }, ''), five)
  assert.strictEqual(Utils.filterHash({ pingbitime: '5.0' }, ''), five)
  assert.strictEqual(Utils.filterHash({ pingbitime: ' 5 ' }, ''), five)
})
check('filterHash: 非法 pingbitime 归一为空（无时间过滤维度）', () => {
  const empty = Utils.filterHash({}, '')
  assert.strictEqual(Utils.filterHash({ pingbitime: 'abc' }, ''), empty)
  assert.strictEqual(Utils.filterHash({ pingbitime: '-1' }, ''), empty)
  assert.strictEqual(Utils.filterHash({ pingbitime: '0' }, ''), Utils.filterHash({ pingbitime: '0' }, ''))
  assert.notStrictEqual(Utils.filterHash({ pingbitime: '0' }, ''), empty, '"0" 归一为 "0"（0 天永不拦截），但不等于空')
})
check('filterHash: pingbitime 数值形式锁定精确哈希', () => {
  assert.strictEqual(Utils.filterHash({ pingbitime: 'abc' }, ''), '1167134403-539606814')
  assert.strictEqual(Utils.filterHash({ pingbitime: '0' }, ''), '3036873395-1678839634')
})
check('filterHash: 多行 ### 规则与数值规则都折入当前 UTC 日期（跨天失效 _f 缓存）', () => {
  const withFixedNow = (iso, fn) => {
    const RealDate = Date
    const fixed = new RealDate(iso).getTime()
    class FakeDate extends RealDate {
      constructor (...args) { if (args.length === 0) super(fixed); else super(...args) }
      static now () { return fixed }
    }
    global.Date = FakeDate
    try { return fn() } finally { global.Date = RealDate }
  }
  const day1 = withFixedNow('2026-09-08T00:00:00Z', () => Utils.filterHash({ pingbitime: '5' }, ''))
  const day2 = withFixedNow('2026-09-09T00:00:00Z', () => Utils.filterHash({ pingbitime: '5' }, ''))
  assert.notStrictEqual(day1, day2, 'pingbitime 数值规则启用时哈希必须随 UTC 日期变化')
  const m1 = withFixedNow('2026-09-08T00:00:00Z', () => Utils.filterHash({ pingbitime: 'cat###5' }, ''))
  const m2 = withFixedNow('2026-09-09T00:00:00Z', () => Utils.filterHash({ pingbitime: 'cat###5' }, ''))
  assert.notStrictEqual(m1, m2, '### 多行规则启用时哈希必须随 UTC 日期变化')
  assert.strictEqual(day1, '454089977-241288782', '固定 2026-09-08 时数值规则的精确哈希')
  assert.strictEqual(m1, '3001522188-1783751140', '固定 2026-09-08 时 ### 规则的精确哈希')
  assert.strictEqual(withFixedNow('2026-01-02T05:06:07Z', () => Utils.filterHash({ pingbitime: '5' }, '')), '453819899-241050448', '日期部分按 UTC 年月日两位补零')
  const noTime1 = withFixedNow('2026-09-08T00:00:00Z', () => Utils.filterHash({ pingbibiaoti: '京东' }, ''))
  const noTime2 = withFixedNow('2026-09-09T00:00:00Z', () => Utils.filterHash({ pingbibiaoti: '京东' }, ''))
  assert.strictEqual(noTime1, noTime2, '未启用时间过滤时不得折入日期（避免每日全量重评）')
  assert.strictEqual(noTime1, '2135914867-3402940783', '未启用时间过滤时与日期无关')
})
check('filterHash: ### 形式保留行内格式（不 Number 归一）', () => {
  assert.notStrictEqual(Utils.filterHash({ pingbitime: 'cat###5' }, ''), Utils.filterHash({}, ''))
  assert.notStrictEqual(Utils.filterHash({ pingbitime: 'cat###5' }, ''), Utils.filterHash({ pingbitime: 'cat###6' }, ''))
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_utils_pure.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)

// ===== parseTime：入口三态与字符串 trim 语义 =====
// 反例（改动前）：L119/L125 的空值与 trim 守卫从未被直接断言（既有无时区用例都传合法格式），
// 8+5 个 ConditionalExpression/LogicalOperator/StringLiteral/BlockStatement 存活。
check('parseTime: 空值三态（undefined/null/空串）→ null', () => {
  assert.strictEqual(Utils.parseTime(undefined), null)
  assert.strictEqual(Utils.parseTime(null), null)
  assert.strictEqual(Utils.parseTime(''), null)
})
check('parseTime: 字符串两侧空白先 trim（纯空白按空串无效）', () => {
  assert.strictEqual(Utils.parseTime(' 2026-09-08 10:30:00 '), utcMs(2026, 9, 8, 10, 30, 0), '带空白必须 trim 后按 UTC 解析')
  assert.strictEqual(Utils.parseTime('   '), null, '纯空白 trim 后为空串 → null')
  assert.strictEqual(Utils.parseTime('\t\n'), null)
})
check('parseTime: 非字符串不受 trim 影响（数字仍走数字分支）', () => {
  assert.strictEqual(Utils.parseTime(1788863400000), 1788863400000)
})

// ===== _parseNumericTime：8 位日期的 月/日 边界 =====
// 反例（改动前）：8 位 YYYYMMDD 的 4 个边界比较（月 >=1 / <=12、日 >=1 / <=31）无覆盖。
check('_parseNumericTime: 8 位日期边界（月 01/12 合法，00/13 非法）', () => {
  assert.strictEqual(Utils.parseTime('20260108'), utcMs(2026, 1, 8))
  assert.strictEqual(Utils.parseTime('20261208'), utcMs(2026, 12, 8))
  assert.strictEqual(Utils.parseTime('20261308'), null)
  assert.strictEqual(Utils.parseTime('20260008'), null)
})
check('_parseNumericTime: 8 位日期日边界（01/31 合法，00/32 非法）', () => {
  assert.strictEqual(Utils.parseTime('20260901'), utcMs(2026, 9, 1))
  assert.strictEqual(Utils.parseTime('20260930'), utcMs(2026, 9, 30))
  assert.strictEqual(Utils.parseTime('20260900'), null)
  assert.strictEqual(Utils.parseTime('20260932'), null)
})
check('_parseNumericTime: 8 位非法日期回读拒绝（20260230 不得滚动为 03-02）', () => {
  assert.strictEqual(Utils.parseTime('20260230'), null)
  assert.strictEqual(Utils.parseTime('20260231'), null)
})

// ===== isDangerousUrl：空值守卫 =====
check('isDangerousUrl: undefined/null → false（空值守卫）', () => {
  assert.strictEqual(Utils.isDangerousUrl(undefined), false)
  assert.strictEqual(Utils.isDangerousUrl(null), false)
  assert.strictEqual(Utils.isDangerousUrl(''), false)
})

// ===== sanitizeHtmlUrls：空值守卫 + 未加引号 href/src 值清洗 =====
check('sanitizeDecodedHtml: undefined/null → 空串（空值守卫）', () => {
  assert.strictEqual(Utils.sanitizeDecodedHtml(undefined), '')
  assert.strictEqual(Utils.sanitizeDecodedHtml(null), '')
  assert.strictEqual(Utils.sanitizeDecodedHtml(''), '')
})
check('sanitizeHtmlUrls: 未加引号危险协议整体清空为 name=""（\\s* 两侧可选空白）', () => {
  assert.strictEqual(Utils.sanitizeHtmlUrls('<a href=javascript:alert(1)>x</a>'), '<a href="">x</a>')
  assert.strictEqual(Utils.sanitizeHtmlUrls('<img src=vbscript:x>'), '<img src="">')
  assert.strictEqual(Utils.sanitizeHtmlUrls('<a href = javascript:alert(1)>x</a>'), '<a href="">x</a>', '等号两侧空白仍须命中')
  assert.strictEqual(Utils.sanitizeHtmlUrls('<img src =vbscript:x>'), '<img src="">')
})
check('sanitizeHtmlUrls: 合法未加引号 URL 原样保留，属性名精确匹配 href/src', () => {
  assert.strictEqual(Utils.sanitizeHtmlUrls('<a href=https://u.jd.com/a>x</a>'), '<a href=https://u.jd.com/a>x</a>')
  assert.strictEqual(Utils.sanitizeHtmlUrls('<img src=https://x/1.png>'), '<img src=https://x/1.png>')
  // \b(href|src) 只在属性名处命中：`data-href` 的词边界后是 h，仍会命中；用 xhref 验证必须不命中
  assert.strictEqual(Utils.sanitizeHtmlUrls('<a xhref=javascript:alert(1)>x</a>'), '<a xhref=javascript:alert(1)>x</a>', '非属性名（xhref）不得被清洗')
})

// ===== _removeActiveTags 各分支已覆盖；此处补 css 转义与数值实体 =====
check('_decodeCssEscapes: 数值实体边界（cp=0 与 0x10FFFF 合法，超界保留原文）', () => {
  assert.strictEqual(Utils._decodeNumeric(65, '&#65;'), 'A')
  assert.strictEqual(Utils._decodeNumeric(0, '&#0;'), '', 'cp=0 被 String.fromCodePoint(0) 转为 NUL 后由入口统一剥离 → 空串')
  assert.strictEqual(Utils._decodeNumeric(0x10FFFF, '&#x10FFFF;'), String.fromCodePoint(0x10FFFF), 'cp=0x10FFFF 合法')
  assert.strictEqual(Utils._decodeNumeric(0x110000, '&#x110000;'), '&#x110000;', '超界保留原文')
  assert.strictEqual(Utils._decodeNumeric(-1, '&#-1;'), '&#-1;', '负数保留原文')
})

// ===== safeErrorText / safeText：字符串与多类型分支 =====
check('safeErrorText: 字符串/数字/布尔/符号错误原样转文本', () => {
  assert.strictEqual(Utils.safeErrorText('err text'), 'err text')
  assert.strictEqual(Utils.safeErrorText('   '), '', '纯空白字符串不算有效文本 → fallback（默认空串）')
  assert.strictEqual(Utils.safeErrorText(42), '42')
  assert.strictEqual(Utils.safeErrorText(true), 'true')
  assert.strictEqual(Utils.safeErrorText(Symbol('s')), 'Symbol(s)')
})
check('safeErrorText: code 三态（undefined/null/空串都不算有效 code）', () => {
  assert.strictEqual(Utils.safeErrorText({ code: 'ENOENT' }), 'ENOENT')
  assert.strictEqual(Utils.safeErrorText({ code: '' }, 'fb'), 'fb')
  assert.strictEqual(Utils.safeErrorText({ code: null }, 'fb'), 'fb')
  assert.strictEqual(Utils.safeErrorText({ code: undefined }, 'fb'), 'fb')
  assert.strictEqual(Utils.safeErrorText({ code: 0 }, 'fb'), '0', 'code=0 非空值 → safeText(0) = "0"')
})

// ===== truncateUtf16：String() 兜底与 max 守卫 =====
check('truncateUtf16: undefined/null 按空串处理（String 兜底）', () => {
  assert.strictEqual(Utils.truncateUtf16(undefined, 5), '')
  assert.strictEqual(Utils.truncateUtf16(null, 5), '')
  assert.strictEqual(Utils.truncateUtf16(undefined, 5), Utils.truncateUtf16('', 5))
})

// ===== isValidItem / hasValidId：数组与空值边界 =====
check('isValidItem: 对象才算有效条目（数组/null/原始值都否）', () => {
  assert.strictEqual(Utils.isValidItem({}), true)
  assert.strictEqual(Utils.isValidItem([]), false, '数组不是有效条目')
  assert.strictEqual(Utils.isValidItem([1]), false)
  assert.strictEqual(Utils.isValidItem(null), false)
  assert.strictEqual(Utils.isValidItem(undefined), false)
  assert.strictEqual(Utils.isValidItem(1), false)
  assert.strictEqual(Utils.isValidItem('x'), false)
  assert.strictEqual(Utils.isValidItem(0), false)
})
check('hasValidId: id 为 undefined/null 都判无效', () => {
  assert.strictEqual(Utils.hasValidId({ id: undefined }), false)
  assert.strictEqual(Utils.hasValidId({ id: null }), false)
  assert.strictEqual(Utils.hasValidId({ id: 0 }), true, 'id=0 有效（数字）')
  assert.strictEqual(Utils.hasValidId({ id: false }), false, '布尔 id 无效')
})

// ===== num：布尔/空值守卫 =====
check('num: 布尔值一律回退默认（true/false 都不是有效数值配置）', () => {
  assert.strictEqual(Utils.num(true, 'DEF'), 'DEF')
  assert.strictEqual(Utils.num(false, 'DEF'), 'DEF')
})
check('num: undefined/null 回退默认', () => {
  assert.strictEqual(Utils.num(undefined, 'DEF'), 'DEF')
  assert.strictEqual(Utils.num(null, 'DEF'), 'DEF')
  assert.strictEqual(Utils.num(0, 'DEF'), 0, '0 是有效数值')
  assert.strictEqual(Utils.num('0', 'DEF'), 0)
})

// ===== anonKey：转义序列（% / \ / |）=====
// 反例（改动前）：L1093 的 3 组转义字面量（'%25' / '%5C' / '%7C'）只有「不加转义」的弱断言。
check('anonKey: % → %25、\\ → %5C、| → %7C（精确键值）', () => {
  assert.notStrictEqual(Utils.anonKey('a%b'), Utils.anonKey('a%25b'), '% 已转义 ⇒ 二次转义不等价')
  assert.notStrictEqual(Utils.anonKey('a\\b'), Utils.anonKey('a%5Cb'), '\\ 转义为 %5C')
  assert.notStrictEqual(Utils.anonKey('a|b'), Utils.anonKey('a%7Cb'), '| 转义为 %7C')
  // \ 与 | 互不等价（验证是三组不同替换）
  assert.notStrictEqual(Utils.anonKey('a%b'), Utils.anonKey('a\\b'))
  assert.notStrictEqual(Utils.anonKey('a\\b'), Utils.anonKey('a|b'))
})

// ===== filterHash：rawStr 空值三态（L1128）=====
check('filterHash: rawStr 对 undefined/null/Symbol 一律空维度', () => {
  const empty = Utils.filterHash({}, '')
  assert.strictEqual(Utils.filterHash({ pingbitime: undefined }, ''), empty)
  assert.strictEqual(Utils.filterHash({ pingbitime: null }, ''), empty)
  assert.strictEqual(Utils.filterHash({ pingbitime: Symbol('s') }, ''), empty)
})

// ===== safeGet / 通用：throw 的 toString 不抛穿 =====
check('filterHash: 字段 getter 抛错不崩（safeGet 兜底）', () => {
  const bad = {}
  Object.defineProperty(bad, 'pingbibiaoti', { enumerable: true, get () { throw new Error('getter') } })
  assert.strictEqual(typeof Utils.filterHash(bad, ''), 'string', 'getter 抛错必须被 safeGet 吃掉')
})

// ===== anonKey 精确键值：折叠哈希的两路 djb2 与分隔符（L1095-1105）=====
// 反例（改动前）：只断言「前缀/确定性/不相等」，h1/h2 的乘子（33/31）与内层加法/下标项、
// 多参数连接符与 trim 语义全部无覆盖，9 个靶子存活。
check('anonKey: 单参数与多参数的精确键值（h1/h2 双路 djb2）', () => {
  assert.strictEqual(Utils.anonKey('a'), 'anon:2b5c418ef5a')
  assert.strictEqual(Utils.anonKey('ab'), 'anon:596e26304fc49')
  assert.strictEqual(Utils.anonKey('a', 'b'), 'anon:b87355a5d9a9061')
})
check('anonKey: 多参数用 | 连接（非 | 单参数会被转义，两者不等价）', () => {
  // 多参数 a|b 是「连接符」；单参数 'a|b' 的 | 会转义为 %7C ⇒ 键不同
  assert.notStrictEqual(Utils.anonKey('a', 'b'), Utils.anonKey('a|b'))
  assert.strictEqual(Utils.anonKey('a', 'b'), Utils.anonKey('a', 'b'), '确定性')
})
check('anonKey: 参数两侧空白不 trim（trim 语义）', () => {
  assert.notStrictEqual(Utils.anonKey(' a'), Utils.anonKey('a'), '前导空白必须参与键')
  assert.notStrictEqual(Utils.anonKey('a '), Utils.anonKey('a'), '尾随空白必须参与键')
  assert.notStrictEqual(Utils.anonKey('a', ' b'), Utils.anonKey('a', 'b'))
})
check('anonKey: 参数下标必须参与哈希（i 项进了 h2）', () => {
  // 'ab' 与 'ba' 内容相同但顺序不同 ⇒ 必须不同（下标项与连接顺序共同作用）
  assert.notStrictEqual(Utils.anonKey('ab'), Utils.anonKey('ba'))
  assert.notStrictEqual(Utils.anonKey('a', 'b'), Utils.anonKey('b', 'a'))
  assert.notStrictEqual(Utils.anonKey('x', 'y', 'z'), Utils.anonKey('z', 'y', 'x'))
})
check('anonKey: 首参数为空串时不得残留前导 | （s 初值空串分支）', () => {
  // s 初始 ''，首个非空参数直接作为 s（不加 '|'）；空串参数被 t.trim()!=='' 过滤
  assert.strictEqual(Utils.anonKey('', 'a'), Utils.anonKey('a'), '空串参数应被过滤，不产生前导 |')
  assert.strictEqual(Utils.anonKey('', ''), Utils.anonKey(), '全空退化为无参退化键')
  assert.strictEqual(Utils.anonKey('', '', 'a'), Utils.anonKey('a'), '多个空串参数同样只过滤、不产生分隔符')
})
check('anonKey: 哈希对不同输入有区分力（乘子 33/31 若被改成除法会撞车）', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'ab', 'ba', 'abc', 'aa', 'aaa'].map(s => Utils.anonKey(s))
  assert.strictEqual(new Set(keys).size, keys.length, '这 12 个输入必须两两不同键')
})

// ===== truncateUtf16：s.length <= max 边界（L1252）=====
check('truncateUtf16: s.length === max 原样返回（<= 边界，不是 <）', () => {
  assert.strictEqual(Utils.truncateUtf16('hello', 5), 'hello', '长度恰等于 max 必须原样返回')
  assert.strictEqual(Utils.truncateUtf16('hello', 4), 'hell', '长度超过 1 位才截断')
  assert.strictEqual(Utils.truncateUtf16('hello', 6), 'hello')
})
check('truncateUtf16: 末尾 ZWJ 退位（0x200D 分支的 slice(0,-1)）', () => {
  // 👨 + ZWJ ⇒ 截到 2 位时末位是 ZWJ，必须退位；若 -1 变 +1 会得到长度 3 的错误串
  const man = '\uD83D\uDC68'
  assert.strictEqual(Utils.truncateUtf16(man + '\u200D' + 'x', 2), man, '末尾 ZWJ 退位，基底 emoji 保留')
  assert.strictEqual(Utils.truncateUtf16(man + '\u200D' + 'x', 3), man, 'ZWJ 仍在截断点上 ⇒ 继续退位')
  assert.strictEqual(Utils.truncateUtf16(man + '\u200D' + 'x', 4), man + '\u200D' + 'x', '完整序列原样保留')
  assert.strictEqual(Utils.truncateUtf16('a\u200Db', 2), 'a', '末尾 ZWJ 直接退位（非代理对路径）')
})

// ===== createUtils：fs 注入守卫（L100）=====
check('createUtils: 未注入 fs 时回落 node:fs（不抛）', () => {
  const U2 = createUtils({ safeRe })
  assert.strictEqual(typeof U2.diskSpace, 'function')
  assert.strictEqual(typeof U2.diskSpace('/x'), 'object', '真实 fs 下 /x 应可 statfs（非支持平台则 null）')
})
check('createUtils: 注入 fs 优先于 node:fs', () => {
  const fake = { statfsSync: 'notfn' }
  const U2 = createUtils({ safeRe, fs: fake })
  assert.strictEqual(U2.diskSpace('/x'), null, '注入的 fs 必须被优先使用（statfsSync 非函数 → null）')
})
check('createUtils: 缺 safeRe 时抛 TypeError', () => {
  assert.throws(() => createUtils({}), /safeRe/)
  assert.throws(() => createUtils({ safeRe: null }), /safeRe/)
})

// ===== filterHash 首参数组（L1126 parts 初值）=====
check('filterHash: 空配置与非空配置哈希不同（parts 初值必须为空数组）', () => {
  const empty = Utils.filterHash({}, '')
  assert.strictEqual(empty, '1167134403-539606814', '空 parts 的精确哈希')
  assert.notStrictEqual(Utils.filterHash({ pingbibiaoti: 'x' }, ''), empty)
})

// ===== _stripEventAttrs：单/双引号分支对称（L546-547、L588）=====
// 反例（改动前）：只测了双引号与部分形态，单引号状态分支（valueSQ）与三元
// （ch === '"' ? 'valueDQ' : 'valueSQ'）从未被单独断言 ⇒ 相关分支的 9 个靶子存活。
check('_stripEventAttrs: 单引号值与双引号值都被整体删除（两分支对称）', () => {
  assert.strictEqual(Utils.sanitizeDecodedHtml("<div onclick='alert(1)'>x</div>"), '<div >x</div>')
  assert.strictEqual(Utils.sanitizeDecodedHtml('<div onclick="alert(1)">x</div>'), '<div >x</div>')
  assert.strictEqual(Utils.sanitizeDecodedHtml("<div onerror='a'>x</div>"), '<div >x</div>')
})
check('_stripEventAttrs: 相邻单+双引号事件属性各删一个，分隔符保留为空格', () => {
  assert.strictEqual(Utils.sanitizeDecodedHtml('<div onerror=\'a\' onload="b">x</div>'), '<div  >x</div>')
})
check('_stripEventAttrs: 未加引号事件属性同样删除', () => {
  assert.strictEqual(Utils.sanitizeDecodedHtml('<img src=x onerror=y>'), '<img src=x >')
  assert.strictEqual(Utils.sanitizeDecodedHtml('<div onerrorend=x>'), '<div >')
})
check('_stripEventAttrs: 事件属性名大小写不敏感（gi 标志）', () => {
  assert.strictEqual(Utils.sanitizeDecodedHtml('<div ONCLICK="a">x</div>'), '<div >x</div>')
  assert.strictEqual(Utils.sanitizeDecodedHtml("<div OnError='a'>x</div>"), '<div >x</div>')
})

// ===== truncateUtf16：代理对边界比较（L1270/1271/1273）=====
// 反例（改动前）：>= vs > 的端点在 SURROGATE_LO/HI 与 0xDC00 上从未被边界值打中。
check('truncateUtf16: 孤立高代理在截断点 → 退位（last >= 0xD800 端点）', () => {
  assert.strictEqual(Utils.truncateUtf16('\uD800A', 2), '\uD800A', '长度恰为 max 走提前返回，不进退位循环')
  assert.strictEqual(Utils.truncateUtf16('\uD800A', 1), '', '高代理在截断点 ⇒ 退位到空')
  assert.strictEqual(Utils.truncateUtf16('a\uD800', 2), 'a\uD800', '长度恰为 max 提前返回')
  assert.strictEqual(Utils.truncateUtf16('a\uD800b', 2), 'a', '末尾孤立高代理在截断点退位')
})
check('truncateUtf16: 完整代理对恰在 max 处保留（last >= 0xDC00 端点）', () => {
  assert.strictEqual(Utils.truncateUtf16('\uD83D\uDE00', 2), '\uD83D\uDE00', '完整对长度恰为 max ⇒ 原样返回')
  assert.strictEqual(Utils.truncateUtf16('\uD83D\uDE00A', 2), '\uD83D\uDE00', '低代理后接非修饰符 ⇒ 保留配对')
  assert.strictEqual(Utils.truncateUtf16('\uDC00A', 2), '\uDC00A', '长度恰为 max 提前返回')
  assert.strictEqual(Utils.truncateUtf16('a\uDC00b', 2), 'a', '孤立低代理在截断点退位（前位非高代理）')
})
check('truncateUtf16: 低代理前一位必须是高代理才保留配对（prev >= 0xD800 端点）', () => {
  assert.strictEqual(Utils.truncateUtf16('\uD83D\uDE00A', 2), '\uD83D\uDE00', '前位是高代理 ⇒ 保留配对')
  assert.strictEqual(Utils.truncateUtf16('\uDBFF\uDC00A', 2), '\uDBFF\uDC00', '高代理上界 SURROGATE_HI 处仍配对')
})

// ===== anonKey：折叠哈希的两路 djb2 数值细节（L1095-1105）=====
// 反例（改动前）：h1/h2 的乘子（33/31）、内层 +c、下标项 i、循环上界 i<s.length 都没被边界打中，
// 精确键值断言缺失 ⇒ 9 个靶子存活。以下锁定多组精确键值：任何一处算术变更都会改键。
check('anonKey: 精确键值锁定两路 djb2（乘子/加法/下标项/循环上界）', () => {
  assert.strictEqual(Utils.anonKey('a'), 'anon:2b5c418ef5a')
  assert.strictEqual(Utils.anonKey('ab'), 'anon:596e26304fc49')
  assert.strictEqual(Utils.anonKey('ba'), 'anon:596ec6304fc67', '下标项 i 参与 h2 ⇒ ab 与 ba 不同')
  assert.strictEqual(Utils.anonKey('abc'), 'anon:b8732855d9a8d3c')
  assert.strictEqual(Utils.anonKey('aa'), 'anon:596e25304fc48')
  assert.strictEqual(Utils.anonKey('aaa'), 'anon:b8732a45d9a8d1b')
})
check('anonKey: 长度不同的同前缀键必须不同（循环上界 i<s.length）', () => {
  assert.notStrictEqual(Utils.anonKey('a'), Utils.anonKey('aa'))
  assert.notStrictEqual(Utils.anonKey('aa'), Utils.anonKey('aaa'))
  assert.notStrictEqual(Utils.anonKey('ab'), Utils.anonKey('aba'))
})
check('anonKey: 首字符参与哈希（h1 初值 5381 与首字符混入）', () => {
  assert.notStrictEqual(Utils.anonKey('a'), Utils.anonKey('b'))
  assert.notStrictEqual(Utils.anonKey('x'), Utils.anonKey('y'))
  assert.notStrictEqual(Utils.anonKey(''), Utils.anonKey('a'), '退化键与单字符键不同')
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_utils_pure.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
