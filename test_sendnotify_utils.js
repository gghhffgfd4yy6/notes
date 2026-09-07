'use strict'

const assert = require('assert')
const slim = require('./xbk_sendNotify_slim')
const {
  mdToPlain,
  mdLinksToPlain,
  mdImagesToPlain,
  stripAngleTags,
  looksHtml,
  maskKey,
  maskUrl,
  safeSlice,
  safeErr,
  push_config,
  configuredChannelCount,
  configuredChannelNames
} = slim

;(async () => {
  // ===== mdToPlain：Markdown → 纯文本（推送正文可读性） =====
  assert.strictEqual(mdToPlain('**粗体**'), '粗体', '粗体应剥离')
  assert.strictEqual(mdToPlain('*斜体*'), '斜体', '斜体应剥离')
  assert.strictEqual(mdToPlain('5*3*2cm'), '5*3*2cm', '数字前后 * 不应剥除（v3.150）')
  assert.strictEqual(mdToPlain('# 标题'), '标题', '标题井号应剥离')
  assert.strictEqual(mdToPlain('`code`'), 'code', '行内代码反引号应剥离')
  assert.strictEqual(mdToPlain('![alt](https://x/y.png)'), 'alt', '图片语法应替换为 alt')
  assert.strictEqual(mdToPlain('[text](https://x)'), 'text (https://x)', '链接应保留文本与 URL')
  assert.strictEqual(mdToPlain('[https://x](https://x)'), 'https://x', 'text===url 原文链接只显示一次（v3.153）')
  assert.strictEqual(mdToPlain('<b>hi</b>'), 'hi', 'HTML 标签应剥离')
  assert.strictEqual(mdToPlain('<https://x>'), 'https://x', 'http autolink 保留内容')
  assert.strictEqual(mdToPlain('a&nbsp;b'), 'a b', '&nbsp; 应解码为空格')
  assert.strictEqual(mdToPlain('&amp;lt;'), '&lt;', '&amp; 不得二次解码成 <（CodeQL double-escaping）')
  assert.strictEqual(mdToPlain('<b>hi</b>', false), '<b>hi</b>', 'stripAngle=false 整体保留标签')
  assert.strictEqual(mdToPlain(undefined), '', 'undefined → 空串')
  assert.strictEqual(mdToPlain(null), '', 'null → 空串')
  assert.strictEqual(mdToPlain(123), '123', '数字应 String 化')

  // ===== mdLinksToPlain：线性链接剥离 =====
  assert.strictEqual(mdLinksToPlain('[a](https://x)'), 'a (https://x)')
  assert.strictEqual(mdLinksToPlain('前置[a](https://x)后'), '前置a (https://x)后')
  assert.strictEqual(mdLinksToPlain('[a] 未闭合'), '[a] 未闭合', '无 () 不应误判链接')
  assert.strictEqual(mdLinksToPlain('[a]('), '[a](', '未闭合 ( 原样保留')
  assert.strictEqual(mdLinksToPlain('[]()'), '[]()', '空 text 原样保留')
  assert.strictEqual(mdLinksToPlain('[a]()'), '[a]()', '空 url 原样保留')

  // ===== mdImagesToPlain：线性图片语法剥离 =====
  assert.strictEqual(mdImagesToPlain('![alt](https://x/y.png)'), 'alt')
  assert.strictEqual(mdImagesToPlain('![](https://x/y.png)'), '', '空 alt 默认替换为空串')
  assert.strictEqual(mdImagesToPlain('![](https://x/y.png)', '(图片)'), '(图片)', '空 alt 用 emptyAlt 替换')
  assert.strictEqual(mdImagesToPlain('![未闭合'), '![未闭合', '未闭合保留')

  // ===== stripAngleTags：线性 HTML 标签剥离 =====
  assert.strictEqual(stripAngleTags('<b>hi</b>', true), 'hi')
  assert.strictEqual(stripAngleTags('<https://x>', true), 'https://x', 'autolink 保留')
  assert.strictEqual(stripAngleTags('<b>hi', true), 'hi', '完整 <b> 标签剥离，剩余文本保留')
  assert.strictEqual(stripAngleTags('<b hi', true), '<b hi', '无 > 的串整体保留')
  assert.strictEqual(stripAngleTags('<b>hi</b>', false), '<b>hi</b>', 'stripAngle=false 保留')
  assert.strictEqual(stripAngleTags('<>', true), '<>', '空 inner 保留')

  // ===== looksHtml =====
  assert.strictEqual(looksHtml('<b>x</b>'), true)
  assert.strictEqual(looksHtml('plain text'), false)

  // ===== maskKey / maskUrl：凭据与设备码脱敏 =====
  assert.strictEqual(maskKey('abc'), '***', '≤6 位全脱敏')
  assert.strictEqual(maskKey('abcdefgh'), 'abcd***gh', '保留首 4 尾 2')
  assert.strictEqual(maskUrl('https://api.day.app/deviceKey12345'), 'https://api.day.app/devi***45', 'host 保留、路径脱敏')
  assert.strictEqual(maskUrl('ftp://host/x'), 'ftp:***/x', '非 http(s) 按 key 脱敏（保留首 4 尾 2）')
  assert.strictEqual(maskUrl('not a url'), 'not ***rl', 'URL 解析失败按 key 脱敏')

  // ===== safeSlice：安全截断（不拆散 emoji/代理对） =====
  assert.strictEqual(safeSlice('hello', 3), 'hel')
  assert.strictEqual(safeSlice('hello', 10), 'hello', '不超长原样返回')
  assert.strictEqual(safeSlice(undefined, 5), '', 'undefined → 空串')
  assert.strictEqual(safeSlice(null, 5), '', 'null → 空串')
  assert.strictEqual(safeSlice('😀😀', 3), '😀', '不得拆散代理对')
  const slicedEmoji = safeSlice('a👨‍👩‍👧‍👦b', 4)
  assert.strictEqual(slicedEmoji, 'a👨', 'ZWJ 家庭 emoji 不得被拆散（尾部 ZWJ 退位）')
  assert.ok(!slicedEmoji.endsWith('\u200D'), '末尾不得是孤立 ZWJ')

  // ===== safeErr：错误摘要（含脱敏与截断） =====
  assert.strictEqual(safeErr(null), '', 'null → 空串')
  assert.strictEqual(safeErr(undefined), '', 'undefined → 空串')
  assert.strictEqual(safeErr(new Error('boom')), 'boom', 'Error 取 message')
  assert.strictEqual(safeErr('err str'), 'err str', '字符串原样')
  assert.strictEqual(safeErr({ message: 'obj msg' }), 'obj msg', '对象取 message 字段')
  assert.strictEqual(safeErr('x'.repeat(300)).length, 201, '超 200 截断并追加 …')
  assert.strictEqual(safeErr('abc'), 'abc', '短消息不截断')

  // ===== configuredChannelCount / configuredChannelNames：通道配置统计 =====
  const saved = {}
  for (const k of Object.keys(push_config)) saved[k] = push_config[k]
  try {
    for (const k of Object.keys(push_config)) delete push_config[k]
    assert.strictEqual(configuredChannelCount(), 0, '空配置计数 0')
    assert.deepStrictEqual(configuredChannelNames(), [], '空配置无通道名')

    push_config.PUSH_PLUS_TOKEN = 'tok'
    assert.strictEqual(configuredChannelCount(), 1, '单个通道计数 1')
    assert.deepStrictEqual(configuredChannelNames(), ['pushplus'])

    push_config.PUSH_KEY = 'key'
    assert.strictEqual(configuredChannelCount(), 2)
    assert.deepStrictEqual(configuredChannelNames(), ['pushplus', 'server酱'])

    // TG 必须 token 与 user id 同时存在才计入
    push_config.TG_BOT_TOKEN = 'bot'
    assert.strictEqual(configuredChannelCount(), 2, '仅 TG token 不计入')
    push_config.TG_USER_ID = 'uid'
    assert.strictEqual(configuredChannelCount(), 3, 'TG 双字段齐全才计入')
    assert.deepStrictEqual(configuredChannelNames().includes('telegram'), true)

    // BARK 分隔型配置：全空白分隔符在 names 中被排除（count 按 truthy 计）
    push_config.BARK_PUSH = '##'
    assert.strictEqual(configuredChannelNames().includes('bark'), false, '全空白分隔值不算已配置通道')
  } finally {
    for (const k of Object.keys(push_config)) delete push_config[k]
    for (const [k, v] of Object.entries(saved)) push_config[k] = v
  }

  console.log('test_sendnotify_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
