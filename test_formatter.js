'use strict'

// xbk_formatter.js 补测：HTML→Markdown 转换 + 模板替换
// 目标：提升变异测试分数，重点覆盖边界条件和反向断言
const assert = require('node:assert')
const { createFormatter } = require('./xbk_formatter')

// Mock Utils：只实现 formatter 用到的方法，为简化桩（非真实 Utils 完整行为）
// 注意：truncateUtf16/sanitizeDecodedHtml/sanitizeSurrogates 等为恒等/简化实现，
// 与 xbk_utils.js 真实行为存在差异，仅用于隔离 formatter 自身逻辑。
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
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
}

const safeRe = (src, flags) => new RegExp(src, flags)
const formatter = createFormatter({ Utils: mockUtils, safeRe })

let pass = 0
let fail = 0
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

// 审查 2026-09-14 F-04：闭合标签名后允许空白（HTML5 合法），此前 </a > 不被识别导致链接静默丢失
check('<a> 闭合标签带空格（</a >）→ 仍转换为链接', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://ok.com/1">t</a > tail' }),
    '[t](https://ok.com/1) tail'
  )
})

check('<a> 闭合标签含换行（</a\\n>）→ 仍转换为链接', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://ok.com/1">t</a\n> tail' }),
    '[t](https://ok.com/1) tail'
  )
})

check('<h1>x</h1 > → # 标题（标题闭合标签带空白）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<h1>x</h1 >tail' }), '# x\n\ntail')
})

// 审查 2026-09-14 F-05：锚点 href 与同函数 mdUrl 统一口径——含空白/括号用 <> 包裹
check('<a> href 含空格 → 目标用 <> 包裹（与原文链接口径一致）', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://ok.com/x y">t</a>' }),
    '[t](<https://ok.com/x y>)'
  )
})

check('<a> href 含左括号 → 目标用 <> 包裹', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://ok.com/a(b">t</a>' }),
    '[t](<https://ok.com/a(b>)'
  )
})

check('<a> href 无特殊字符 → 不加 <>（对照）', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://ok.com/e">t</a>' }),
    '[t](https://ok.com/e)'
  )
})

// PR 评审 #143-1：safeUrl 放行角括号，而角括号形式的 Markdown 目标内不允许未转义的 < / >——
// 不编码时 `https://x/a(b)>c` 会产出 `[t](<https://x/a(b)>c>)`，内嵌 > 提前终止目标、链接失效。
check('<a> href 含括号且含 > → 角括号编码，目标不被提前截断（#143）', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://x/a(b)>c">t</a>' }),
    '[t](<https://x/a(b)%3Ec>)'
  )
})

check('<a> href 含空格且含 < → 角括号编码（#143）', () => {
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: '<a href="https://x/a<b c">t</a>' }),
    '[t](<https://x/a%3Cb c>)'
  )
})

check('{链接} 占位符同口径：含角括号也编码（#143）', () => {
  assert.strictEqual(
    formatter.tuisong_replace('{链接}', { url: 'https://x/a(b)>c' }),
    '<https://x/a(b)%3Ec>'
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

// ===== 9b. {Html内容} 原文链接分支（审查 2026-09-14 F-07）=====
// 回归：safeUrl 过滤掉 url 后，原实现仍无条件拼接尾部「原文链接：」——
// 无 url 时输出悬空的提示，与 Markdown 路径（mdUrl 为假则整段不追加）口径不一致。
// 判定必须区分「本来就没有 url」（整段不追加）与「有 url 但被安全过滤」（保留纯文本提示、不生成 href）。
check('{Html内容} 无 url 字段 → 整段不追加原文链接（不再悬空）', () => {
  const r = formatter.tuisong_replace('{Html内容}', { content_html: '<p>正文</p>' })
  assert.strictEqual(r, '<p>正文</p>')
  assert.ok(!r.includes('原文链接'), `无 url 不应出现原文链接提示，实际: ${JSON.stringify(r)}`)
})

check('{Html内容} url 为空串 → 整段不追加原文链接', () => {
  assert.strictEqual(formatter.tuisong_replace('{Html内容}', { content_html: '正文', url: '' }), '正文')
})

check('{Html内容} url 为非字符串（数字/null/对象）→ 整段不追加原文链接', () => {
  assert.strictEqual(formatter.tuisong_replace('{Html内容}', { content_html: '正文', url: 123 }), '正文')
  assert.strictEqual(formatter.tuisong_replace('{Html内容}', { content_html: '正文', url: null }), '正文')
  assert.strictEqual(formatter.tuisong_replace('{Html内容}', { content_html: '正文', url: { href: 'https://x' } }), '正文')
})

check('{Html内容} 危险协议 url → 保留纯文本提示但不生成 href（对照无 url 分支）', () => {
  const r = formatter.tuisong_replace('{Html内容}', { content_html: '<p>x</p>', url: 'javascript:alert(1)' })
  assert.ok(r.includes('原文链接：'), `危险 url（原始值非空）仍应保留纯文本提示，实际: ${JSON.stringify(r)}`)
  assert.ok(!/href\s*=/.test(r), '危险 url 不应生成 href')
  assert.ok(!r.includes('javascript:'), '危险协议原文不应出现在输出里')
})

check('{Html内容} 合法 url → 仍生成可点击原文链接（对照，首分支不变）', () => {
  const r = formatter.tuisong_replace('{Html内容}', { content_html: '正文', url: 'https://example.com/a' })
  assert.strictEqual(r,
    '正文<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="https://example.com/a" target="_blank">https://example.com/a</a><br>&nbsp;<br>&nbsp;<br>')
})

// ===== 10. 复杂混合 HTML =====
check('混合 HTML：标题 + 链接 + 粗体', () => {
  const html = '<h1>标题</h1><p>这是<b>粗体</b>和<a href="https://x.com">链接</a></p>'
  const r = formatter.htmlToMarkdown({ content_html: html })
  assert.ok(r.includes('# 标题'), '应包含标题')
  assert.ok(r.includes('**粗体**'), '应包含粗体')
  assert.ok(r.includes('[链接](https://x.com)'), '应包含链接')
})

// ===== 10b. 未知标签闭合探测：二次方防护与语义保持（审查 2026-09-14 F-02）=====
check('未知标签堆叠：10 万个 <x> 的耗时上界（原实现单串全扫实测 ~9.9s）', () => {
  const t0 = Date.now()
  formatter.htmlToMarkdown({ content_html: '<x>'.repeat(100000) })
  const dt = Date.now() - t0
  // 入口 100k 截断后仍有 33333 个未知开标签：建表 + 二分查询应远快于旧的逐标签全串 indexOf
  assert.ok(dt < 2000, `耗时 ${dt}ms 应在 2000ms 内`)
})

check('未知标签配对：同名闭合整体剥离，错配/未闭合仍原样保留', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</x>' }), 'a')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</y>b</x>' }), 'a</y>b')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a </world> b' }), 'a </world> b')
})

check('未知标签闭合：属性值内的 </font 不算配对闭合', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<font title="</font>">a</font>' }), 'a')
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

// 审查 2026-09-14 F-01：单趟替换——插入的数据值不再被后续占位符二次扫描
check('formatTemplate: 数据值里的字面占位符 → 原样保留（不静默删字）', () => {
  assert.strictEqual(formatter.tuisong_replace('[{内容}]', { content: 'a{Html内容}b' }), '[a{Html内容}b]')
})

check('formatTemplate: 正文含后续占位符 → 不被其它字段值替换', () => {
  const r = formatter.tuisong_replace('[{内容}]|{链接}', { content: 'a{链接}b', url: 'https://ok.com/1' })
  assert.strictEqual(r, '[a{链接}b]|https://ok.com/1')
})

check('formatTemplate: {标题} 值含 {内容} → 不平铺进正文', () => {
  const r = formatter.tuisong_replace('[{标题}]|[{内容}]', { title: 'T{内容}', content: 'C' })
  assert.strictEqual(r, '[T{内容}]|[C]')
})

check('formatTemplate: 正文占位符序列不被清空（模板未用 {Html内容} 时原样保留）', () => {
  const content = '{Html内容}'.repeat(2000)
  const r = formatter.tuisong_replace('{内容}', { content, content_html: 'H'.repeat(100000) })
  assert.strictEqual(r, content)
})

check('formatTemplate: {内容}+{Html内容} 同时使用 → 输出长度受控不放大', () => {
  const content = '{Html内容}'.repeat(2000)
  const r = formatter.tuisong_replace('{内容}|{Html内容}', { content, content_html: 'H'.repeat(100000) })
  // 旧实现先插入 content、再让 2000 处字面 {Html内容} 各展开 10 万字符 → 2 亿字符并可能抛 RangeError
  assert.ok(r.length < 150000, `输出长度应受控，实际 ${r.length}`)
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

// 夹具契约：mockUtils.parseTime 必须与生产 Utils.parseTime 同语义。
// 这条非法日期分支此前没有被任何断言覆盖——注毒实验（把 return 改成 d.getTime()）后套件仍绿，故补上。
check('mockUtils.parseTime：非法日期返回 null', () => {
  assert.strictEqual(mockUtils.parseTime('不是日期'), null)
})

check('mockUtils.parseTime：合法日期返回毫秒时间戳', () => {
  assert.strictEqual(mockUtils.parseTime('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'))
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_formatter.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
