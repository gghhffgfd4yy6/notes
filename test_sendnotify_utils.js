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
  configuredChannelCount,
  configuredChannelNames
} = slim
const cfg = slim.push_config

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
  assert.strictEqual(maskUrl('file://host/x'), 'file***/x', '非 http(s) 按 key 脱敏（保留首 4 尾 2）')
  assert.strictEqual(maskUrl('not a url'), 'not ***rl', 'URL 解析失败按 key 脱敏')

  // ===== safeSlice：安全截断（不拆散 emoji/代理对） =====
  assert.strictEqual(safeSlice('hello', 3), 'hel')
  assert.strictEqual(safeSlice('hello', 10), 'hello', '不超长原样返回')
  assert.strictEqual(safeSlice(undefined, 5), '', 'undefined → 空串')
  assert.strictEqual(safeSlice(null, 5), '', 'null → 空串')
  assert.strictEqual(safeSlice('😀😀', 3), '😀', '不得拆散代理对')
  // max=2 落在家庭 emoji 序列内：要么保留完整 grapheme，要么整体移除（不得留下半截序列）
  assert.strictEqual(safeSlice('a👨‍👩‍👧‍👦b', 2), 'a', 'ZWJ 家庭 emoji 不得被拆散，应整体移除被截断的序列')

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
  for (const k of Object.keys(cfg)) saved[k] = cfg[k]
  try {
    for (const k of Object.keys(cfg)) delete cfg[k]
    assert.strictEqual(configuredChannelCount(), 0, '空配置计数 0')
    assert.deepStrictEqual(configuredChannelNames(), [], '空配置无通道名')

    cfg.PUSH_PLUS_TOKEN = 'tok'
    assert.strictEqual(configuredChannelCount(), 1, '单个通道计数 1')
    assert.deepStrictEqual(configuredChannelNames(), ['pushplus'])

    cfg.PUSH_KEY = 'key'
    assert.strictEqual(configuredChannelCount(), 2)
    assert.deepStrictEqual(configuredChannelNames(), ['pushplus', 'server酱'])

    // TG 必须 token 与 user id 同时存在才计入
    cfg.TG_BOT_TOKEN = 'bot'
    assert.strictEqual(configuredChannelCount(), 2, '仅 TG token 不计入')
    cfg.TG_USER_ID = 'uid'
    assert.strictEqual(configuredChannelCount(), 3, 'TG 双字段齐全才计入')
    assert.deepStrictEqual(configuredChannelNames().includes('telegram'), true)

    // BARK 分隔型配置：全空白分隔符在 names 中被排除
    cfg.BARK_PUSH = '##'
    assert.strictEqual(configuredChannelNames().includes('bark'), false, '全空白分隔值不算已配置通道')

    // v3.273（S7/F3 回归）：count/names 与 sendNotify 的 nonEmpty 同口径——
    // 全空白/0/false 都不得计为「可用通道」，否则 QingLong 自检假绿而主流程抛 NO_CHANNEL_CONFIG
    for (const k of Object.keys(cfg)) delete cfg[k]
    cfg.BARK_PUSH = '   '
    assert.strictEqual(configuredChannelCount(), 0, '全空白 Bark 不应计为可用通道（原 count 按 truthy 误计 1）')
    assert.deepStrictEqual(configuredChannelNames(), [], '全空白 Bark 不应出现在通道名')
    cfg.BARK_PUSH = ' # '
    assert.strictEqual(configuredChannelCount(), 0, '只含分隔符/空白不应计为通道')
    cfg.BARK_PUSH = ''
    cfg.PUSHME_KEY = 0
    cfg.PUSH_PLUS_TOKEN = false
    assert.strictEqual(configuredChannelCount(), 0, '0/false 不应计为已配置')
    assert.deepStrictEqual(configuredChannelNames(), [], '0/false 不应出现在通道名（原 names 会误报）')
    cfg.PUSH_PLUS_TOKEN = '0' // 非空字符串仍算已配置（历史行为不变）
    assert.deepStrictEqual(configuredChannelNames(), ['pushplus'], '非空字符串值保持既有语义')
  } finally {
    for (const k of Object.keys(cfg)) delete cfg[k]
    for (const [k, v] of Object.entries(saved)) cfg[k] = v
  }

  // ===== F4：WX_pusher_channels 配置被丢弃时必须告警（旧口径完全静默）=====
  // 多应用数组里任一项缺 appToken/topicIds、或整串不是合法 JSON 时，旧实现直接回退旧字段且零日志——
  // 用户看到「推送成功」，其余应用一条没收到。逐场景断言 console.warn 的出现/缺席。
  {
    const savedWx = {
      channels: cfg.WX_pusher_channels,
      appToken: cfg.WX_pusher_appToken,
      topicIds: cfg.WX_pusher_topicIds
    }
    const originalWarn = console.warn
    const warns = []
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      // ① 非法 JSON：告警 + 仍回退旧字段（行为不变）
      cfg.WX_pusher_channels = '{not json'
      cfg.WX_pusher_appToken = 'legacy-token'
      cfg.WX_pusher_topicIds = '1'
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '非法 JSON 时应回退旧字段（行为不变）')
      assert.strictEqual(warns.length, 1, '非法 JSON 应恰好告警 1 次')
      assert.ok(warns[0].includes('不是合法 JSON'), `告警应说明解析失败，实际：${warns[0]}`)
      // ② 数组项全缺 topicIds：告警 + 回退旧字段
      cfg.WX_pusher_channels = JSON.stringify([{ appToken: 'a' }, { app_token: 'b' }])
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '全丢弃时应回退旧字段（行为不变）')
      assert.strictEqual(warns.length, 1, '数组项全丢弃应恰好告警 1 次')
      assert.ok(warns[0].includes('2 项均缺 appToken 或 topicIds'), `告警应带丢弃条数，实际：${warns[0]}`)
      // ③ 配置值不是数组（对象）：告警
      cfg.WX_pusher_channels = JSON.stringify({ appToken: 'a', topicIds: '1' })
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '非数组配置应回退旧字段')
      assert.strictEqual(warns.length, 1, '非数组配置应告警 1 次')
      assert.ok(warns[0].includes('不是数组'), `告警应说明形状错误，实际：${warns[0]}`)
      // ④ 混合数组（部分丢弃）：被丢弃项必须留痕——修复前「只要还剩一项就提前返回」，丢弃项完全静默
      // （V4 实测：warn=0 且 2 次推送只联系 APP_A；对照组两个合法应用会被分别联系）。
      cfg.WX_pusher_channels = JSON.stringify([{ appToken: 'a', topicIds: '1' }, { app_token: 'b' }])
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '部分丢弃时应启用其余合法项（行为不变）')
      assert.strictEqual(warns.length, 1, '混合数组必须恰好告警 1 次（修复前 warn=0）')
      assert.ok(warns[0].includes('1 项') && warns[0].includes('已丢弃'), `告警应带丢弃条数，实际：${warns[0]}`)
      // ④b 同族反例（自造）：非对象项（null/字符串）被过滤时同样属于「部分丢弃」，
      // 不能只在「缺 appToken/topicIds 字段」这一种形态上告警。
      cfg.WX_pusher_channels = JSON.stringify([{ appToken: 'a', topicIds: '1' }, null, 'x'])
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '非对象项应被过滤且保留合法项')
      assert.strictEqual(warns.length, 1, '非对象项部分丢弃也必须告警 1 次')
      assert.ok(warns[0].includes('2 项') && warns[0].includes('已丢弃'), `告警应带被丢弃条数 2，实际：${warns[0]}`)
      // ⑤ 合法数组：采用多应用、不得告警
      cfg.WX_pusher_channels = JSON.stringify([{ appToken: 'a', topicIds: '1,2' }])
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '合法数组应启用多应用')
      assert.strictEqual(warns.length, 0, '合法数组不得告警')
      // ⑥ 未配置/显式空数组：回退旧字段，不得告警（既有无配置语义）
      cfg.WX_pusher_channels = '[]'
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '空数组应回退旧字段')
      assert.strictEqual(warns.length, 0, '显式空数组不得告警')
      cfg.WX_pusher_channels = ''
      warns.length = 0
      assert.strictEqual(slim.hasWxPusherConfigured(), true, '空串应回退旧字段')
      assert.strictEqual(warns.length, 0, '未配置不得告警')
    } finally {
      console.warn = originalWarn
      cfg.WX_pusher_channels = savedWx.channels
      cfg.WX_pusher_appToken = savedWx.appToken
      cfg.WX_pusher_topicIds = savedWx.topicIds
    }
    console.log('✅ F4：WX_pusher_channels 丢弃时告警（非法 JSON/全丢弃/非数组/部分丢弃），合法与空配置不告警')
  }

  console.log('test_sendnotify_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
