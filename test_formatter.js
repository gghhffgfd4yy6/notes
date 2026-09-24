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
  // 与生产 Utils.add0 同语义（xbk_utils.js:255 `m < 10 ? '0' + m : '' + m`）：
  // 时间分支此前完全没有被覆盖（桩缺 add0 会直接抛错），补桩后 {日期}/{时间} 才可断言。
  add0: (m) => (m < 10 ? '0' + m : '' + m),
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

// ===== 10b. 审查 2026-09-14 F-03：属性值引号语义 =====
check('F-03：未加引号的属性值里的撇号不再吞掉后续 <a>/<h1>', () => {
  // 未加引号的属性值（class=don't）里的撇号曾被当引号起点，把其后到串内下一个引号
  // 之间的所有开标签都标成「属性值内」→ 链接/标题被跳过（对照 <div data-x=1> 同形态）。
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: "<div class=don't><a href=https://ok.com/1>t</a>" }),
    '[t](https://ok.com/1)')
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: "<div class=don't><h1>H</h1>" }),
    '# H')
  assert.strictEqual(
    formatter.htmlToMarkdown({ content_html: "it's <a href=https://ok.com/2>t</a>" }),
    "it's [t](https://ok.com/2)")
})

check('F-03：= 之后的引号仍是属性值区间（对照：不回归 v3.263 属性值保护）', () => {
  const spans = formatter._quotedAttrSpans('<div a="b">')
  assert.ok(spans.has(8) && spans.size === 1, `= 后的引号应标记属性值区间，实际 ${JSON.stringify([...spans])}`)
  assert.strictEqual(formatter._quotedAttrSpans("<div class=don't>").size, 0, '未加引号的属性值不产生区间')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<font title="</font>">a</font>' }), 'a')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<div data-x="<a href="https://x">text</a>' }), 'text')
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

// ===== anchorText：锚点文本（标签段原样保留、其余段解码并转义、嵌套 <a...>/</a> 整段剥除）=====
// 该函数只能经 <a> 转换路径间接覆盖；用例按「注释即契约」构造，覆盖 name/wordAfter/pos/切片/转义各分支。

// 杀 ConditionalExpression（isA 恒 false）与 StringLiteral（'a'→""）：嵌套 <a> 必须整段剥除
check('anchorText：嵌套 <a> 整段剥除，其内容并入链接文本', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">x<a href="v">y</a>z</a>' }), '[xy](u)z')
})

// 杀 ConditionalExpression（isA 恒 true）与 MethodExpression（txt.slice(lt, gt+1)→txt）：非 a 标签原样保留
check('anchorText：锚点文本内非 a 标签原样保留（交由后续标签转换）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">a<b>c</b>d</a>' }), '[a**c**d](u)')
})

// 杀 BooleanLiteral（!wordAfter 恒真）：<a1> 词后有数字，不属于嵌套 <a>，按普通文本保留
check('anchorText：标签名后接数字（<a1>）不算嵌套 <a>，按普通文本保留', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">x<a1>y</a>' }), '[x<a1>y](u)')
})

// 杀 StringLiteral（'a'→""）：name 为空串（< 后非字母）时不得把该段当嵌套 <a> 剥除
check('anchorText：< 后非字母且后随真实标签时不得剥除该段', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">x< <b>y</a>' }), '[x< **y](u)')
})

// 杀 StringLiteral（'<'→""，indexOf 起点退化为 pos）：< 后非字母时前方方括号仍须转义
check('anchorText：< 后非字母时方括号仍须转义（indexOf 起点不得退化）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">a[1]<b>x</b></a>' }), '[a\\[1\\]**x**](u)')
})

// 杀 AssignmentOperator（out -=）与 MethodExpression（txt.slice(pos)→txt）：未闭合 < 只转义余下片段
check('anchorText：未闭合 < 后剩余文本按文本转义（不吞并、不丢字符）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">pq<r</a>' }), '[pq<r](u)')
})

// 杀 ArithmeticOperator（lt+1→lt-1）/BlockStatement：已处理标签后再遇未闭合 <，pos 必须前移
check('anchorText：已处理标签后再遇未闭合 < 时只转义余下片段', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u"><b>x<y</a>' }), '[**x<y](u)')
})

// 杀 Regex/StringLiteral（转义字符集）：] 与 \ 加反斜杠，圆括号不转义
check('anchorText：] 与 \\ 转义、圆括号不转义（文本侧转义口径）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">a]b(c\\d</a>' }), '[a\\]b(c\\\\d](u)')
})

// 杀 CallExpression/MethodExpression：实体解码与文本侧同口径（&lt; 解码为 <）
check('anchorText：实体解码后再转义（&lt;/&gt; 解码为 </>）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">a&lt;b&gt;c</a>' }), '[a<b>c](u)')
})

// 杀 ConditionalExpression（gt === lt+1 恒 false）：<> 按字面文本保留，不当标签剥除
check('anchorText：<> 空尖括号按字面文本保留', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">x<>y</a>' }), '[x<>y](u)')
})

// 杀 ConditionalExpression（wordAfter 恒 false）：无 href 的 <a> 仍须剥除嵌套标签
check('anchorText：无 href 的 <a> 只保留锚点文本（嵌套剥除仍生效）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a>a<b>c</b></a>' }), 'a**c**')
})

// ===== 阶段一已知标签转换（tagOps）=====
// 各标签的替换文本在源码注释中即为契约；断言整体 Markdown 输出（含前后换行折叠）而非内部返回值。

// 杀 StringLiteral（br/p/div 的 '\n\n'→""）：块级标签之间必须产生空行
check('tagOps：<br>/<p>/<div> 夹在文本中间均产生空行', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a<br>b' }), 'a\n\nb')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a<p>b' }), 'a\n\nb')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a<div>b' }), 'a\n\nb')
})

// 杀 StringLiteral（li 开/闭分支的 '\n- ' 与 '\n'）与 ul/ol 的 '\n'
check('tagOps：<ul><li> 开闭标签 → 列表项与项间空行', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<ul><li>a</li><li>b</li></ul>' }), '- a\n\n- b')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<ol><li>a</li></ol>' }), '- a')
})

// 杀 ArrowFunction（() => undefined）与 StringLiteral：b/strong → **，i/em → *
check('tagOps：<b>/<strong> → ** 包裹、<i>/<em> → * 包裹', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<b>x</b>' }), '**x**')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<strong>x</strong>' }), '**x**')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<i>x</i>' }), '*x*')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<em>x</em>' }), '*x*')
})

// 杀 td/th/tr/table 各替换文本变异：表格只转换开标签，闭合由通用剥离移除
check('tagOps：<table><tr><td>/<th> → 单元格分隔符', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<table><tr><td>a</td><th>b</th></tr></table>' }), '| a | b')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a</td>b' }), 'ab')
})

// 杀 ConditionalExpression（if (!srcValue) 恒 true）与 img 无 src 的丢弃分支
check('tagOps：<img src> → 图片语法，无 src → 整段剥除', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img src="u" alt="a">' }), '![a](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img alt="a">x' }), 'x')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img src="javascript:alert(1)" alt="a">x' }), 'x')
})

// ===== 阶段一 script/style 区域移除 =====
// 杀 ObjectLiteral（{out,stop}→{} 会产出 undefined）、MethodExpression（slice(pos,lt)→str）、
// ConditionalExpression（321 条件恒 true 会把所有标签当 script/style 处理）
check('script/style：区域整体移除；无闭合则丢弃至末尾', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'x<script>a</script>y' }), 'xy')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'x<style>a</style>y' }), 'xy')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'x<script>abc' }), 'x')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'x<div>abc' }), 'x\n\nabc')
})

// 杀 StringLiteral（safeRe 的 'gi' 标志→""）：闭合标签须大小写不敏感
check('script/style：闭合标签大小写不敏感', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<SCRIPT>a</SCRIPT>b' }), 'b')
})

// ===== 阶段二通用剥离（scanStrip）=====
// 杀 ConditionalExpression/EqualityOperator/CallExpression：未知标签配对索引必须建立，
// 否则 `<x>a</x>` 会被当成普通文本保留
check('scanStrip：前后空白闭合标签 </x > 仍算配对，未知标签整对剥除', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</x>' }), 'a')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</x >' }), 'a')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x></x>' }), '')
})

// 杀 Regex（/^[a-z][a-z0-9-]*/i 的 i 标志与字符类）：大写名、数字名须识别
check('scanStrip：标签名识别大小写不敏感且允许数字与连字符', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<X>a</X>' }), 'a')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x1>a</x1>' }), 'a')
})

// 杀 ConditionalExpression（looksLikeClosedUnknown 恒 true）：无配对的未知标签按普通文本保留
check('scanStrip：无配对的未知标签保留为正文（不当标签剥除）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<world>x' }), '<world>x')
})

// 杀 ConditionalExpression（isTrackedUnknownClose 恒 true）：无开标签的孤立闭合标签保留
check('scanStrip：孤立闭合标签 </x> 保留为正文', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '</x>a' }), '</x>a')
})

// 杀 ConditionalExpression false / CallExpression（pop→;）：错配闭合保留、配对闭合要出栈
check('scanStrip：错配闭合保留为正文，配对闭合出栈（不重复消费）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</y>b</x>' }), 'a</y>b')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</x></x>' }), 'a</x>')
})

// 杀 ArithmeticOperator（<< 分支 str[lt+1]→str[lt-1]）：首个尖括号按历史语义丢弃
check('scanStrip：<<>> 按历史语义丢弃首个尖括号', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'x<<>>y' }), 'x<>>y')
})

// 杀 knownTags 全部 StringLiteral 变异（div/ol/strong/em/h1-h5/script/style/link/blockquote）：
// 已知标签即使出现在未知标签的引号属性值内，也必须被通用剥离移除（外层未知标签按正文保留）。
check('scanStrip：knownTags 名单内的标签一律剥离（属性值内亦然）', () => {
  const inner = ['div', 'ol', 'strong', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'script', 'style', 'link', 'blockquote']
    .map((n) => `<${n}>`).join('')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: `<x a="${inner}">y` }), '<x a="">y')
})

// ===== 补充：替换文本必须出现在文本「中间」才可观测（首尾换行会被折叠）=====
// 杀 ul/ol/tr/table 的 StringLiteral（'\n' / '\n\n' → ""）——末尾无文字的用例会被 trim 掩盖
check('tagOps：列表/表格闭合后的换行不得丢失（末尾无文字时被 trim 掩盖）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<ul><li>a</li><li>b</li></ul>x' }), '- a\n\n- b\n\nx')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<ol><li>a</li></ol>x' }), '- a\n\nx')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a<tr>b' }), 'a\nb')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a<table>b' }), 'a\n\nb')
})

// ===== 补充：script/style 定位细节 =====
// 杀 ConditionalExpression（!wordAfter 恒 true）：<script1> 词后有数字，不是 script 标签，按正文保留
check('script/style：<script1> 不是 script 标签（词边界），按正文保留', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<script1>xyz' }), '<script1>xyz')
})

// 杀 StringLiteral（闭合正则里的 '>' 被抹成 ""）：</scriptx> 不是合法闭合，仍按「无闭合丢弃至末尾」
check('script/style：</scriptx> 不算闭合标签（闭合须精确匹配）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<script>x</scriptx>y' }), '')
})

// ===== 补充：scanStrip 的配对/剥离细节 =====
// 杀 ObjectLiteral（{out,stop}→{} 产出 undefined）与 MethodExpression（str.slice(pos)→str）：
// 无 '>' 的未闭合前缀必须原样保留，且不得把已扫描过的前缀重复拼进输出
check('scanStrip：无 > 的未闭合标签前缀原样保留（不得产出 undefined/重复前缀）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</x' }), '<x>a</x')
})

// 杀 CallExpression（positions.push(at)→;）：同一未知标签名出现两次时必须逐个建索引
check('scanStrip：同名未知标签出现两次时两次都能配对剥除', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x>a</x><x>b</x>' }), 'ab')
})

// 杀 EqualityOperator（二分查找 lo < hi → lo >= hi）：早于当前开标签的闭合不得被当成配对
check('scanStrip：位于开标签之前的同名闭合不算配对（保留为正文）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '</x><x>a' }), '</x><x>a')
})

// 杀 Regex（/^[a-z][a-z0-9-]*/i 去掉 ^ 锚点）：`< x>` 这类尖括号后带空白的片段不是标签
check('scanStrip：< 后带空白（< x>）不构成标签，且其后的 </x> 也不配对', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'a< x>b</x>c' }), 'a< x>b</x>c')
})

// 杀 ArithmeticOperator（str[lt + 1]→str[lt - 1]）：`<<` 按历史语义只丢弃首个尖括号
check('scanStrip：<< 只丢弃首个尖括号（< 后非字母的畸形输入）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<<r>' }), '<r>')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: 'x<<>>y' }), 'x<>>y')
})

// ===== 补充：img 的「空/危险 src 不生成图片」分支（引号与无引号两形态）=====
// 杀 ConditionalExpression（if (!srcValue) 恒 false）/ EqualityOperator（op !== tagOps.img）/
// Regex（src 属性剥离正则）与 StringLiteral（替换串）：危险 src 必须整段不产出图片语法，
// 且剥离后不得把 img 标签片段漏回正文（含 `<<` 前缀既要丢首个 <、又不得留下标签残片）。
check('img：空/危险 src 不生成图片，剥离后不得漏回标签残片', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<<img>' }), '<')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<<img src=javascript:>' }), '')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<<img src=javascript:x>' }), '')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img src="javascript:>">' }), '')
})

// ===== 时间占位符（{日期}/{时间}）：秒/毫秒/日期串统一解析，显示口径固定 UTC =====
// 契约（SYSTEM_CONTRACT「时间」+ v3.115 注释）：无时区日期按 UTC 解析，getUTC* 显示保证跨时区一致。
const T_UTC = Date.UTC(2026, 0, 2, 3, 4) // 2026-01-02T03:04:00Z

// 杀 StringLiteral（posttime/shijianchuo 的 '' 哨兵被抹成其它串）：优先级与哨兵判定
check('时间：posttime 优先于 shijianchuo；空串/undefined/null 视为无值而回退', () => {
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: T_UTC }), '日期=2026-01-02 时间=03:04')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { shijianchuo: T_UTC }), '日期=2026-01-02 时间=03:04')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: '', shijianchuo: T_UTC }), '日期=2026-01-02 时间=03:04')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: null, shijianchuo: T_UTC }), '日期=2026-01-02 时间=03:04')
})

// 杀 LogicalOperator（&& → ||）：null/'' 不得被当成有效时间源（否则 null → 1970-01-01）
check('时间：shijianchuo 为 null/空串时不得生成日期（避免 1970 误导）', () => {
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { shijianchuo: null }), '日期= 时间=')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { shijianchuo: '' }), '日期= 时间=')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', {}), '日期= 时间=')
})

// 杀 ConditionalExpression（t === null || t < 0 → false）：非法/负时间戳一律留空，不得回退当前时间或 1969
check('时间：非法与负时间戳留空，0 按 epoch 处理（不生成 1969/当前时间）', () => {
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: '不是日期' }), '日期= 时间=')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: -1000 }), '日期= 时间=')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: 0 }), '日期=1970-01-01 时间=00:00')
})

// 杀 ConditionalExpression（449 行 timeSource !== undefined && !data.datetime → true）：显式 datetime 优先
check('时间：数据自带 datetime 时不得被 posttime 覆盖', () => {
  assert.strictEqual(formatter.tuisong_replace('日期={日期}', { datetime: '2026-09-08', posttime: T_UTC }), '日期=2026-09-08')
})

// 杀 StringLiteral（add0 相关）与 UTC 口径：日期串按 UTC 解析；个位小时/分钟补 0，>=10 不补
check('时间：无时区日期串按 UTC 解析；时分补 0 边界（03:04 / 10:05）', () => {
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: '2026-01-02' }), '日期=2026-01-02 时间=00:00')
  assert.strictEqual(formatter.tuisong_replace('日期={日期} 时间={时间}', { posttime: Date.UTC(2026, 11, 31, 10, 5) }), '日期=2026-12-31 时间=10:05')
})

// ===== {Html内容}：URL HTML 转义 + 非字符串 content_html 视为空 =====
// 杀 476 行四个 StringLiteral（&/"/</> 的实体替换串）：原样输出会破坏 <a href="..."> 结构
check('{Html内容}：URL 的 & " < > 必须实体转义（href 与链接文本两处）', () => {
  const esc = 'https://e.com/?a=1&amp;b=&quot;x&quot;&lt;y&gt;'
  assert.strictEqual(
    formatter.tuisong_replace('{Html内容}', { content_html: 'z', url: 'https://e.com/?a=1&b="x"<y>' }),
    `z<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="${esc}" target="_blank">${esc}</a><br>&nbsp;<br>&nbsp;<br>`
  )
})

// 杀 StringLiteral（typeof raw !== 'string' 时的空串兜底被抹成其它串）：非字符串 content_html 视为空
check('{Html内容}：非字符串 content_html 视为空（不得泄漏 [object Object] 或哨兵串）', () => {
  assert.strictEqual(formatter.tuisong_replace('{Html内容}', { content_html: 123 }), '')
  assert.strictEqual(
    formatter.tuisong_replace('{Html内容}', { content_html: 123, url: 'u' }),
    '<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="u" target="_blank">u</a><br>&nbsp;<br>&nbsp;<br>'
  )
})

// ===== 标签属性读取（_readTagAttrValue / _getTagAttr / _quotedAttrSpans）=====
// 三者都只能经 <a href>/<img src|alt> 与「引号属性值内的标签不转换」间接观测。

// 杀 _readTagAttrValue 的边界/循环变异（index < end、index >= end、index + 1 等）：
// 双引号/单引号/无引号三种取值形态都必须能取到值；引号未闭合时取不到值（不得取到半截）
check('属性值：双引号/单引号/无引号/空白包裹四种形态取值一致，未闭合引号取不到值', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u">t</a>' }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "<a href='u'>t</a>" }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href=u>t</a>' }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href = "u">t</a>' }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u>t</a>' }), 't')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "<img src='u' alt='a'>" }), '![a](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img src=u alt=a>' }), '![a](u)')
})

// 杀 _getTagAttr 的属性名/扫描起点变异：属性顺序无关；引号值内的 href= 文本不得被当成真实属性；
// data-href 不是 href；无 = 的属性名要跳过而不能吃掉落后的属性
check('_getTagAttr：按属性名精确取值（顺序无关、跳过引号值、data-href 不算 href）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a class="c" href="u">t</a>' }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a title="href=v" href="u">t</a>' }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a href="u" title="t">x</a>' }), '[x](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<a data-href="v">t</a>' }), 't')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img alt="a" disabled src="u">' }), '![a](u)')
})

// 杀 _getTagAttr 的 alt 取值与转义：alt 实体解码后转义 ] （C008 口径）
check('_getTagAttr：img 的 alt 取值正确并转义方括号', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<img alt="a]b" src="u">' }), '![a\\]b](u)')
})

// 杀 _getTagAttr 的 `<ahref` 特例变异（正则 ^ 锚点 / \s* 标志）：<ahref="u">、<ahref ="u"> 均须转换
check('_getTagAttr：<ahref= 无空格形态仍按锚点取值（含 = 前空白）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<ahref="u">t</a>' }), '[t](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<ahref ="u">t</a>' }), '[t](u)')
})

// 杀 _quotedAttrSpans 的「引号只在 = 之后定界」逻辑（F-03）：引号属性值内的 <a>/<h1> 不得转换，
// 未加引号的属性值里的撇号（class=don't）不得被当成引号起点吞掉后面的锚点，未闭合引号延伸到串尾
check('_quotedAttrSpans：引号只在 = 之后定界（属性值内标签不转换、未加引号属性值里的撇号不吞锚点、未闭合延伸到串尾）', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x title="<a href=\'u\'>">t</x>' }), 't')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "<x title='<h1>q</h1>'>t</x>" }), 't')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "<p class=don't>x<a href=\"u\">y</a>" }), 'x[y](u)')
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: '<x title="a<a href="u">y</a>' }), '<x title="ay')
})

// 杀 _quotedAttrSpans 的标签态/引号态判定变异：引号必须是「标签内、紧跟在 = 之后」才算属性值起点——
// 标签外的 `='` 不得开启跨度（否则其后的标签对不再配对剥除、标签内的 <h1> 也不再转换）；
// `>` 必须退出标签态（否则标签后的引号会被误判成属性值起点、吞掉其后的闭合标签）
check('_quotedAttrSpans：标签外/标签后的 = 与引号不得开启属性值跨度', () => {
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "='<x></x>" }), "='")
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "<x>='</x>" }), "='")
  assert.strictEqual(formatter.htmlToMarkdown({ content_html: "='<h1></h1>" }), "='#")
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_formatter.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
