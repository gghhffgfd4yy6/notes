'use strict'

// xbk_utils.js 纯函数方法扩展测试（提升变异分数）
// 覆盖：add0/daysFrom/daysComputed/num/safeText/safeGet/truncateUtf16/sanitizeSurrogates/
//       isDangerousUrl/validUrl/normUrl/_decodeCssEscapes/hasValidId/anonKey/safeErrorText
const assert = require('node:assert')
const { createUtils } = require('./xbk_utils')

const safeRe = (src, flags) => new RegExp(src, flags)
const Utils = createUtils({ safeRe })

let pass = 0, fail = 0
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
  assert.strictEqual(Utils.num(NaN, 10), 10)
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
check('anonKey: 全空参数返回固定退化键', () => {
  const k = Utils.anonKey(undefined, null, '')
  assert.strictEqual(k, 'anon:1505cde7', '全空参数应返回退化键 anon:1505cde7')
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

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_utils_pure.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
