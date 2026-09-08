'use strict'

// xbk_formatter.js 补测：HTML→Markdown 转换 + 模板替换
// 目标：提升变异测试分数，重点覆盖边界条件和反向断言
const assert = require('node:assert')
const { createFormatter } = require('./xbk_formatter')

// Mock Utils：只实现 formatter 用到的方法，行为与 xbk_utils.js 一致
const mockUtils = {
  safeObjectCopy: (obj) => JSON.parse(JSON.stringify(obj)),
  truncateUtf16: (str, len) => str.slice(0, len),
  safeUrl: (url) => {
    if (typeof url !== 'string' || url.length === 0) return ''
    if (/^(javascript:|data:|vbscript:)/i.test(url)) return ''
    return url.replace(/[\r\n]+/g, '').trim()
  },
  sanitizeDecodedHtml: (str) => str,
  decodeHtmlEntities: (str) => str.replace(/&(lt|gt|amp|quot|#39);/g, (m, name) => ({
    lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'"
  }[name] || m)),
  safeText: (val) => {
    if (val === undefined || val === null) return ''
    return String(val)
  },
  safeGet: (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined
    return obj[key]
  },
  sanitizeSurrogates: (str) => str,
  parseTime: (t) => {
    if (typeof t === 'number' && t > 0) return t
    const d = new Date(t)
    return isNaN(d.getTime()) ? null : d.getTime()
  }
}

const safeRe = (src, flags) => new RegExp(src, flags)
const formatter = createFormatter({ Utils: mockUtils, safeRe })

let pass = 0, fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

console.log('=== xbk_formatter.js 测试 ===')

// ===== 1. 基础：空输入和非字符串输入 =====
check('空对象 → 空字符串', () => {
  assert.strictEqual(formatter.htmlToMarkdown({}), '')
})

check('content_html 为空串 → 空字符串', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '' }), '')
})

check('content_html 非字符串 → 空字符串（不返回 [object Object]）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 123 }), '')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: null }), '')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: undefined }), '')
})

check('shuju 为 null → 空字符串（不抛错）', () => {
  assert.strictEqual(formatter.htmlToMarkdown(null), '')
})

check('shuju 为 undefined → 空字符串（不抛错）', () => {
  assert.strictEqual(formatter.htmlToMarkdown(undefined), '')
})

// ===== 2. 纯文本（无 HTML 标签）=====
check('纯文本 → 原样返回（解码实体）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'Hello World' }), 'Hello World')
})

check('纯文本含 HTML 实体 → 解码', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'A &amp; B' }), 'A & B')
})

check('纯文本含 &lt; &gt; → 解码为 < >', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a &lt; b &gt; c' }), 'a < b > c')
})

// ===== 3. 标题 <h1>-<h6> =====
check('<h1> → # 标题', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<h1>标题</h1>' }), '# 标题')
})

check('<h2> → ## 标题', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<h2>副标题</h2>' }), '## 副标题')
})

check('<h6> → ###### 标题', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<h6>最小标题</h6>' }), '###### 最小标题')
})

check('<h7> 不识别 → 剥离标签保留文本', () => {
  const r = formatter.htmlToMarkdown({ content_html: '<h7>文本</h7>' })
  assert.ok(r.includes('文本'), '应保留文本')
})

// ===== 4. 链接 <a href> =====
check('<a href="url">text</a> → [text](url)', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://example.com">链接</a>' }),
    '[链接](https://example.com)'
  )
})

check('<a> 无 href → 只保留文本', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a>纯文本</a>' }), '纯文本')
})

check('<a href="javascript:alert(1)">x</a> → 危险协议剥离，只保留文本', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="javascript:alert(1)">危险</a>' }),
    '危险'
  )
})

check('<a href="data:text/html,...">x</a> → data 协议剥离', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="data:text/html,abc">数据</a>' }),
    '数据'
  )
})

// ===== 5. 粗体 <b>/<strong> =====
check('<b>text</b> → **text**', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<b>粗体</b>' }), '**粗体**')
})

check('<strong>text</strong> → **text**', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<strong>粗体</strong>' }), '**粗体**')
})

// ===== 6. 换行 <br> =====
check('<br> → 换行', () => {
  const r = formatter.htmlToMarkdown({ content_html: 'a<br>b' })
  assert.ok(r.includes('a') && r.includes('b'), '应保留两行文本')
})

// ===== 7. 段落 <p> =====
check('<p>text</p> → 文本（标签剥离）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<p>段落</p>' }), '段落')
})

// ===== 8. script/style 移除 =====
check('<script>code</script> → 移除脚本', () => {
  const r = formatter.htmlToMarkdown({ content_html: 'before<script>alert(1)</script>after' })
  assert.ok(!r.includes('alert(1)'), '脚本内容应被移除')
  assert.ok(r.includes('before') && r.includes('after'), '前后文本应保留')
})

check('<style>css</style> → 移除样式', () => {
  const r = formatter.htmlToMarkdown({ content_html: 'before<style>body{}</style>after' })
  assert.ok(!r.includes('body{}'), '样式内容应被移除')
})

// ===== 9. 带 url 的原文链接 =====
check('带 url → 追加原文链接', () => {
  const r = formatter.htmlToMarkdown({ content_html: '内容', url: 'https://example.com/article' })
  assert.strictEqual(r, '内容\n\n原文链接：[https://example.com/article](https://example.com/article)')
})

check('带 url 且 url 含空格 → 原文链接用 <> 包裹', () => {
  const r = formatter.htmlToMarkdown({ content_html: '内容', url: 'https://example.com/a b' })
  assert.ok(r.includes('<https://example.com/a b>'), 'url 含空格应用 <> 包裹')
})

check('url 为 javascript: → 不追加原文链接', () => {
  const r = formatter.htmlToMarkdown({ content_html: '内容', url: 'javascript:alert(1)' })
  assert.ok(!r.includes('原文链接'), '危险 url 不应追加原文链接')
})

check('url 为空串 → 不追加原文链接', () => {
  const r = formatter.htmlToMarkdown({ content_html: '内容', url: '' })
  assert.ok(!r.includes('原文链接'), '空 url 不应追加原文链接')
})

// ===== 10. 复杂混合 HTML =====
check('混合 HTML：标题 + 链接 + 粗体', () => {
  const html = '<h1>标题</h1><p>这是<b>粗体</b>和<a href="https://x.com">链接</a></p>'
  const r = formatter.htmlToMarkdown({ content_html: html })
  assert.ok(r.includes('# 标题'), '应包含标题')
  assert.ok(r.includes('**粗体**'), '应包含粗体')
  assert.ok(r.includes('[链接](https://x.com)'), '应包含链接')
})

// ===== 11. formatTemplate 模板替换 =====
check('formatTemplate: {标题} 替换', () => {
  const r = formatter.tuisong_replace('标题：{标题}', { title: '测试标题' })
  assert.strictEqual(r, '标题：测试标题')
})

check('formatTemplate: {内容} 替换', () => {
  const r = formatter.tuisong_replace('内容：{内容}', { content: '测试内容' })
  assert.strictEqual(r, '内容：测试内容')
})

check('formatTemplate: {链接} 替换', () => {
  const r = formatter.tuisong_replace('链接：{链接}', { url: 'https://example.com' })
  assert.strictEqual(r, '链接：https://example.com')
})

check('formatTemplate: {链接} url 含空格 → <> 包裹', () => {
  const r = formatter.tuisong_replace('{链接}', { url: 'https://example.com/a b' })
  assert.strictEqual(r, '<https://example.com/a b>')
})

check('formatTemplate: {链接} 危险 url → 空', () => {
  const r = formatter.tuisong_replace('{链接}', { url: 'javascript:alert(1)' })
  assert.strictEqual(r, '')
})

check('formatTemplate: 多个占位符同时替换', () => {
  const text = '{标题} - {日期} - {楼主}'
  const r = formatter.tuisong_replace(text, { title: '标题', datetime: '2026-09-08', louzhu: '楼主' })
  assert.strictEqual(r, '标题 - 2026-09-08 - 楼主')
})

check('formatTemplate: 占位符值为 undefined → 空串', () => {
  const r = formatter.tuisong_replace('{价格}', {})
  assert.strictEqual(r, '')
})

check('formatTemplate: 无占位符 → 原样返回', () => {
  const r = formatter.tuisong_replace('纯文本无占位符', { title: 'x' })
  assert.strictEqual(r, '纯文本无占位符')
})

// ===== 12. 内部方法边界测试（提升变异分数）=====
check('_finalizeMd: undefined → 空串', () => {
  assert.strictEqual(formatter._finalizeMd(undefined), '')
})

check('_finalizeMd: null → 空串', () => {
  assert.strictEqual(formatter._finalizeMd(null), '')
})

check('_finalizeMd: 空串 → 空串', () => {
  assert.strictEqual(formatter._finalizeMd(''), '')
})

check('_finalizeMd: 合并3个以上连续换行为2个', () => {
  assert.strictEqual(formatter._finalizeMd('a\n\n\n\nb'), 'a\n\nb')
})

check('_finalizeMd: 去首尾空白', () => {
  assert.strictEqual(formatter._finalizeMd('  text  '), 'text')
})

check('_findTagEnd: 找到 > 返回下标', () => {
  assert.strictEqual(formatter._findTagEnd('abc>def', 0), 3)
})

check('_findTagEnd: 未找到 > 返回 -1', () => {
  assert.strictEqual(formatter._findTagEnd('abcdef', 0), -1)
})

check('_findTagEnd: 引号内 > 不算结束', () => {
  assert.strictEqual(formatter._findTagEnd('a="x>y">b', 0), 7)
})

check('_findTagEnd: 未闭合引号退化为首个 >', () => {
  assert.strictEqual(formatter._findTagEnd('a="x>y', 0), 4)
})

// ===== 13. createFormatter 参数校验 =====
check('createFormatter: 缺 Utils → 抛 TypeError', () => {
  assert.throws(() => createFormatter({ safeRe }), TypeError)
})

check('createFormatter: 缺 safeRe → 抛 TypeError', () => {
  assert.throws(() => createFormatter({ Utils: mockUtils }), TypeError)
})

check('createFormatter: safeRe 非函数 → 抛 TypeError', () => {
  assert.throws(() => createFormatter({ Utils: mockUtils, safeRe: 'notafunction' }), TypeError)
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_formatter.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
