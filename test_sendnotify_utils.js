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

  // ===== 模块加载期配置契约：默认值 + 青龙环境变量覆盖（ENV_ALIASES，v3.234/v3.273）=====
  // 这两条只在**模块加载期**成立（env 覆盖循环在顶层执行），因此必须重新加载模块才能观察：
  // 这里在独立实例上断言，跑完把 require.cache 还原，后续用例看到的仍是本文件顶部的 slim/cfg 实例。
  // 覆盖目标：默认配置被改坏（空串→"Stryker was here!"）、别名表被掏空（[]）、
  // 「存在但为空的 env 不得覆盖本地配置」被写反（QingLong 面板留空/误删值 → 真实 token 被清空 → 漏推）。
  {
    const fs = require('fs')
    const path = require('path')
    const resolved = require.resolve('./xbk_sendNotify_slim')
    const cached = require.cache[resolved]
    // 与源码 ENV_ALIASES 逐键对应（顺序同源码）；每项 = [配置键, [env 名...]]
    const ALIASES = [
      ['PUSH_PLUS_TOKEN', ['PUSH_PLUS_TOKEN']],
      ['PUSH_PLUS_USER', ['PUSH_PLUS_USER']],
      ['PUSH_KEY', ['PUSH_KEY']],
      ['BARK_PUSH', ['BARK_PUSH']],
      ['BARK_ARCHIVE', ['BARK_ARCHIVE']],
      ['BARK_GROUP', ['BARK_GROUP']],
      ['BARK_SOUND', ['BARK_SOUND']],
      ['BARK_ICON', ['BARK_ICON']],
      ['BARK_LEVEL', ['BARK_LEVEL']],
      ['BARK_URL', ['BARK_URL']],
      ['QYWX_KEY', ['QYWX_KEY']],
      ['QYWX_ORIGIN', ['QYWX_ORIGIN']],
      ['WX_pusher_appToken', ['WX_pusher_appToken', 'WX_PUSHER_APP_TOKEN']],
      ['WX_pusher_topicIds', ['WX_pusher_topicIds', 'WX_PUSHER_TOPIC_IDS']],
      ['WX_pusher_channels', ['WX_pusher_channels', 'WX_PUSHER_CHANNELS']],
      ['WX_XIZHI_KEY', ['WX_XIZHI_KEY']],
      ['DEER_KEY', ['DEER_KEY']],
      ['DEER_URL', ['DEER_URL']],
      ['PUSHME_KEY', ['PUSHME_KEY']],
      ['PUSHME_URL', ['PUSHME_URL']],
      ['TG_BOT_TOKEN', ['TG_BOT_TOKEN']],
      ['TG_USER_ID', ['TG_USER_ID']],
      ['TG_API_HOST', ['TG_API_HOST']],
      ['HITOKOTO', ['HITOKOTO']]
    ]
    const ALL_ENV = ALIASES.reduce((acc, [, names]) => acc.concat(names), [])
    const savedEnv = {}
    for (const n of ALL_ENV) savedEnv[n] = process.env[n]
    const clearEnv = () => { for (const n of ALL_ENV) delete process.env[n] }
    const reload = () => { delete require.cache[resolved]; return require('./xbk_sendNotify_slim') }
    // 未配置时的默认值（青龙用户不写任何配置就依赖这些值；默认被改坏 = 静默改行为）
    const DEFAULTS = {
      HITOKOTO: 'false',
      BARK_PUSH: '',
      BARK_ARCHIVE: '',
      BARK_GROUP: '',
      BARK_SOUND: '',
      BARK_ICON: '',
      BARK_LEVEL: '',
      BARK_URL: '',
      PUSH_KEY: '',
      DEER_KEY: '',
      DEER_URL: '',
      PUSH_PLUS_TOKEN: '',
      PUSH_PLUS_USER: '',
      WX_pusher_appToken: '',
      WX_pusher_topicIds: '',
      WX_XIZHI_KEY: '',
      PUSHME_URL: 'https://push.i-i.me',
      PUSHME_KEY: '',
      QYWX_ORIGIN: 'https://qyapi.weixin.qq.com',
      QYWX_KEY: '',
      TG_BOT_TOKEN: '',
      TG_USER_ID: '',
      TG_API_HOST: 'https://api.telegram.org',
      TG_PROXY_AUTH: '',
      TG_PROXY_HOST: '',
      TG_PROXY_PORT: ''
    }
    try {
      // ① 默认值契约（清空全部别名 env 后重新加载）
      clearEnv()
      const fresh = reload()
      // push_config.local.js 存在时按设计覆盖默认值（真实密钥），此时默认值本就不可观测
      const hasLocal = fs.existsSync(path.join(__dirname, 'push_config.local.js'))
      if (!hasLocal) {
        for (const [k, v] of Object.entries(DEFAULTS)) {
          assert.strictEqual(fresh.push_config[k], v, `未配置时 push_config.${k} 必须是默认值 ${JSON.stringify(v)}`)
        }
        assert.deepStrictEqual(fresh.push_config.WX_pusher_channels, [], '默认 WX_pusher_channels 必须是空数组（留空才回退单应用字段）')
      }
      // ② env 覆盖：逐个别名（含双名条目的每一个名字）都必须生效
      for (const [key, names] of ALIASES) {
        for (let i = 0; i < names.length; i++) {
          clearEnv()
          const value = `env-${key}-${i}`
          process.env[names[i]] = value
          const inst = reload()
          assert.strictEqual(inst.push_config[key], value, `env ${names[i]} 必须覆盖 push_config.${key}`)
        }
      }
      // ③ 存在但为空/纯空白的 env 不得覆盖（v3.234：面板留空不得清掉已有配置）
      clearEnv()
      process.env.BARK_SOUND = '   '
      process.env.PUSH_KEY = ''
      process.env.QYWX_ORIGIN = '\t\n'
      const blank = reload()
      assert.strictEqual(blank.push_config.BARK_SOUND, '', '纯空白 env 不得覆盖默认值')
      assert.strictEqual(blank.push_config.PUSH_KEY, '', '空串 env 不得覆盖默认值')
      assert.strictEqual(blank.push_config.QYWX_ORIGIN, 'https://qyapi.weixin.qq.com', '只含空白的 env 不得覆盖默认值')
      // 对照组：同一批 env 里加一个非空值 → 只有它生效
      process.env.BARK_SOUND = ' ding '
      const withSound = reload()
      assert.strictEqual(withSound.push_config.BARK_SOUND, ' ding ', '非空 env（含首尾空白）必须原样覆盖')
      assert.strictEqual(withSound.push_config.PUSH_KEY, '', '未设置的非空 env 键仍保持默认')
      console.log('✅ 模块加载期配置契约：默认值逐键 + ENV_ALIASES 全别名覆盖 + 空白 env 不覆盖')
    } finally {
      for (const n of ALL_ENV) {
        if (savedEnv[n] === undefined) delete process.env[n]
        else process.env[n] = savedEnv[n]
      }
      delete require.cache[resolved]
      require.cache[resolved] = cached
    }
  }

  // ===== configuredChannelCount / configuredChannelNames：九通道齐备时的精确清单 =====
  // 逐字/逐序断言（数组元素个数与顺序都算契约）：谓词被写死 false、名称串被掏空、
  // 数组声明被换成 []、TG 的 `&&` 被换成 `||` 都会在这里变红。
  {
    const saved = {}
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    try {
      for (const k of Object.keys(cfg)) delete cfg[k]
      cfg.PUSH_PLUS_TOKEN = 'pp-token'
      cfg.PUSH_KEY = 'sk-key'
      cfg.BARK_PUSH = 'bark-device-key'
      cfg.QYWX_KEY = 'qy-key'
      cfg.WX_pusher_appToken = 'wx-app-token'
      cfg.WX_XIZHI_KEY = 'xz-key'
      cfg.DEER_KEY = 'dd-key'
      cfg.PUSHME_KEY = 'pm-key'
      cfg.TG_BOT_TOKEN = 'bot-token'
      cfg.TG_USER_ID = 'uid'
      assert.strictEqual(configuredChannelCount(), 9, '九个通道全部配置时计数必须为 9')
      assert.deepStrictEqual(
        configuredChannelNames(),
        ['pushplus', 'server酱', 'bark', '企业微信', 'wxpusher', '息知', 'pushdeer', 'pushme', 'telegram'],
        '通道名清单与顺序必须逐字稳定'
      )
      // 分隔型通道只有分隔符/空白时既不计数也不出现（与 nonEmpty/delimitedNonEmpty 同口径）
      cfg.BARK_PUSH = '###'
      cfg.PUSHME_KEY = ' # '
      assert.strictEqual(configuredChannelCount(), 7, '全分隔符 Bark/PushMe 必须从计数中剔除')
      assert.strictEqual(configuredChannelNames().includes('bark'), false, '全分隔符 Bark 不得出现在通道名')
      assert.strictEqual(configuredChannelNames().includes('pushme'), false, '全分隔符 PushMe 不得出现在通道名')
      cfg.BARK_PUSH = 'bark-device-key'
      cfg.PUSHME_KEY = 'pm-key'
      // TG 必须 token 与 user id 同时非空：只有一项时不得出现 telegram（`&&` 被换成 `||` 会在此变红）
      cfg.TG_USER_ID = ''
      assert.strictEqual(configuredChannelNames().includes('telegram'), false, 'TG 只有 token 时不得出现 telegram')
      assert.strictEqual(configuredChannelCount(), 8, 'TG 只有 token 时计数必须少 1')
      cfg.TG_BOT_TOKEN = ''
      cfg.TG_USER_ID = 'uid'
      assert.strictEqual(configuredChannelNames().includes('telegram'), false, 'TG 只有 user id 时不得出现 telegram')
      assert.strictEqual(configuredChannelCount(), 8, 'TG 只有 user id 时计数必须少 1')
      cfg.TG_BOT_TOKEN = 'bot-token'
      // 纯空白值必须算未配置（nonEmpty 的 String(v).trim() 口径）
      cfg.WX_XIZHI_KEY = '   '
      assert.strictEqual(configuredChannelCount(), 8, '全空白 WX_XIZHI_KEY 不得计为已配置')
      assert.strictEqual(configuredChannelNames().includes('息知'), false, '全空白 WX_XIZHI_KEY 不得出现在通道名')
      cfg.WX_XIZHI_KEY = 'xz-key'
      // 真值非字符串按既有语义计为已配置（String(v).trim() 口径；0/false 仍被 !v 挡掉）
      cfg.DEER_KEY = 7
      assert.strictEqual(configuredChannelCount(), 9, '真值非字符串配置必须按 String(v) 口径计为已配置')
      assert.strictEqual(configuredChannelNames().includes('pushdeer'), true)
      cfg.DEER_KEY = 'dd-key'
      // 分隔型配置带空段（首/尾分隔符）仍算已配置——判定是「任一非空段」，不是「所有段非空」
      cfg.BARK_PUSH = 'bark-device-key#'
      cfg.PUSHME_KEY = '#pm-key'
      assert.strictEqual(configuredChannelCount(), 9, '分隔型配置含空段时仍必须计为已配置')
      assert.strictEqual(configuredChannelNames().includes('bark'), true)
      assert.strictEqual(configuredChannelNames().includes('pushme'), true)
      console.log('✅ 通道统计：九通道齐备逐字清单 + 分隔型/空白/真值非字符串口径 + TG 双字段口径')
    } finally {
      for (const k of Object.keys(cfg)) delete cfg[k]
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ===== sendNotify：没有任何通道时必须响亮失败，不得「静默成功」=====
  // 静默成功会让主流程以为推送完成并写缓存（消息永久丢失）。这里只走配置检查/短路分支，
  // 不触碰任何网络：① 全空配置 → NO_CHANNEL_CONFIG；② 只配 TG_BOT_TOKEN（缺 TG_USER_ID）
  // → configuredFlags 的 `&&` 必须判否，tgNotify 因缺 user id 直接 resolve，全程零请求。
  {
    const saved = {}
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    try {
      for (const k of Object.keys(cfg)) delete cfg[k]
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文'),
        (e) => e.code === 'NO_CHANNEL_CONFIG' &&
          e.message === '未配置任何推送通道（Push+/Server酱/Bark/企业微信/wxpusher/息知/PushDeer/PushMe/Telegram）',
        '未配置任何通道必须抛 NO_CHANNEL_CONFIG 且消息逐字一致'
      )
      cfg.TG_BOT_TOKEN = 'fake-bot-token-for-config-check' // 缺 TG_USER_ID
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文'),
        (e) => e.code === 'NO_CHANNEL_CONFIG',
        'TG 只有 token 时必须按未配置处理（`&&` 不得放宽成 `||`）'
      )
      console.log('✅ sendNotify：无通道/只配 TG token 时抛 NO_CHANNEL_CONFIG（不静默成功，零网络）')
    } finally {
      for (const k of Object.keys(cfg)) delete cfg[k]
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  console.log('test_sendnotify_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
