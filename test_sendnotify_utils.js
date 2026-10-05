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

// ===== 静默截断防线（PR #202 评审发现）=====
// 本套件是一条 await 链：任何一次 await 不结算时，promise 永不 settle、事件循环排空，
// node 会以**退出码 0** 结束——断言一条没跑、`test_sendnotify_utils OK` 也没打，却全绿。
// 实测触发面：把 xbk_sendNotify_slim.js 的 `if (signal.aborted) onAbort()`（进入等待时已取消
// 那一支）打掉，SNA-06…SNA-10 会被整段跳过而套件仍 exit 0；而 scripts/tap-shim.js 的判定正是
// `code === 0` ⇒ 这类改坏在变异门禁里会静默存活。两道兜底：
//   ① settleWithin：每次 await 带预算，超预算时点名是哪条用例卡住（应对「仍在转但永不结算」）；
//   ② beforeExit 哨兵：没跑到结尾就退出 ⇒ 一律判红（应对「事件循环排空、进程自然退出」）。
// 预算计时器必须用**加载期抓到的真 setTimeout**：SNA 簇会临时替换 global.setTimeout，
// 若沿用被替换后的版本，>=20ms 的预算计时器会被用例自己的桩吞掉（返回永不触发的假句柄）。
const REAL_SET_TIMEOUT = global.setTimeout
const AWAIT_BUDGET_MS = Number(process.env.XBK_AWAIT_BUDGET_MS) || 5000
let suiteFinished = false
process.on('beforeExit', () => {
  if (suiteFinished) return
  console.error('❌ 套件未跑到结尾就退出：await 链被静默截断（后续用例没跑），按失败处理')
  process.exitCode = 1
})

// 结算观测：在预算内 settle ⇒ {stalled:false, value|error}；超预算 ⇒ {stalled:true}。
// 预算计时器**不 unref**：卡住的 await 若没有任何其它句柄，unref 会让进程直接排空退出、只剩
// beforeExit 那句笼统提示；留着它才能等到预算到点、把**具体是哪条用例**报出来（诊断优先于快）。
// 正常路径在 settle 时立刻 clearTimeout，不会把进程多吊一秒。
function settleWithin (label, promise) {
  return new Promise((resolve) => {
    let settled = false
    const budget = REAL_SET_TIMEOUT(() => {
      if (settled) return
      settled = true
      resolve({ stalled: true, label })
    }, AWAIT_BUDGET_MS)
    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(budget); resolve({ stalled: false, value }) } },
      (error) => { if (!settled) { settled = true; clearTimeout(budget); resolve({ stalled: false, error }) } }
    )
  })
}

// 统一的「必须结算」断言：文案里写清这条通道为什么可能卡死，免得后人只看到一句超时。
function assertSettled (outcome, label, why) {
  assert.ok(!outcome.stalled,
    `${label} 在 ${AWAIT_BUDGET_MS}ms 内未结算 ⇒ await 链被静默截断。${why || ''}`)
}

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
      // 用 require.resolve（相对本模块解析，等价于 __dirname 拼接）判断存在性，
      // 避免 Codacy 的「动态路径构造」误报（此处无任何用户输入参与）。
      let hasLocal = true
      try { require.resolve('./push_config.local.js') } catch (e) { hasLocal = false }
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
      // 相对断言（**不用**绝对默认值）：部署侧存在 push_config.local.js 时生效值来自本地配置，
      // 绝对断言会在该环境下假红；这里先取「无任何 env 时」的生效值作基线，再断言空 env 不改动它。
      clearEnv()
      const base = reload().push_config
      const baseVals = { BARK_SOUND: base.BARK_SOUND, PUSH_KEY: base.PUSH_KEY, QYWX_ORIGIN: base.QYWX_ORIGIN }
      process.env.BARK_SOUND = '   '
      process.env.PUSH_KEY = ''
      process.env.QYWX_ORIGIN = '\t\n'
      const blank = reload()
      assert.strictEqual(blank.push_config.BARK_SOUND, baseVals.BARK_SOUND, '纯空白 env 不得覆盖生效值')
      assert.strictEqual(blank.push_config.PUSH_KEY, baseVals.PUSH_KEY, '空串 env 不得覆盖生效值')
      assert.strictEqual(blank.push_config.QYWX_ORIGIN, baseVals.QYWX_ORIGIN, '只含空白的 env 不得覆盖生效值（默认域名或本地配置都不许被清）')
      // 对照组：同一批 env 里加一个非空值 → 只有它生效
      process.env.BARK_SOUND = ' ding '
      const withSound = reload()
      assert.strictEqual(withSound.push_config.BARK_SOUND, ' ding ', '非空 env（含首尾空白）必须原样覆盖')
      assert.strictEqual(withSound.push_config.PUSH_KEY, baseVals.PUSH_KEY, '空 env 键不得改动生效值')
      // ✅ 文案按「真跑了默认值断言 / 因本地配置存在而跳过」分支化：跳过时不得宣称已验证。
      console.log(hasLocal
        ? '✅ 模块加载期配置契约：ENV_ALIASES 全别名覆盖 + 空白 env 不覆盖（默认值逐键断言因存在 push_config.local.js 而跳过）'
        : '✅ 模块加载期配置契约：默认值逐键 + ENV_ALIASES 全别名覆盖 + 空白 env 不覆盖')
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

  // ===== sendNotify 包装函数：无通道配置必须响亮失败（错误码/消息逐字）=====
  // 契约（SYSTEM_CONTRACT.md「推送」条）：无通道配置不得静默成功（否则主流程以为推送完成并写缓存）。
  {
    const saved = {}
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    try {
      for (const k of Object.keys(cfg)) delete cfg[k]
      // 错误码字面量与消息字面量都必须逐字（StringLiteral→"" 会在这里变红）
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文'),
        (e) => {
          assert.strictEqual(e.code, 'NO_CHANNEL_CONFIG', "error.code 必须逐字为 'NO_CHANNEL_CONFIG'")
          assert.strictEqual(
            e.message,
            '未配置任何推送通道（Push+/Server酱/Bark/企业微信/wxpusher/息知/PushDeer/PushMe/Telegram）',
            '错误消息必须逐字一致'
          )
          return true
        }
      )
      // TG 是「token && user id」双字段：只配 user id 时不得算已配置
      // （`&&` 被换成 `||` 会让 telegram 假成立：tgNotify 早退成 resolve ⇒ 不抛错）
      cfg.TG_USER_ID = 'uid-only'
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文'),
        (e) => e.code === 'NO_CHANNEL_CONFIG',
        'TG 只有 user id 时必须按未配置处理（`&&` 不得放宽成 `||`）'
      )
      console.log('✅ sendNotify：无通道/只配 TG user id 时抛 NO_CHANNEL_CONFIG（码与消息逐字，零网络）')
    } finally {
      for (const k of Object.keys(cfg)) delete cfg[k]
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ===== sendNotify 包装函数：一言开关（HITOKOTO）逐格 =====
  // 分支只在 hitokotoEnabled 为真时调用模块内 one()，而 one() 的唯一出口是 got.get('https://v1.hitokoto.cn/').
  // 本轮禁止真实网络请求，故用仓库既有 got 替身口径（源码 L345 注释 / test_notify.js 已有先例）把共享 got 的
  // get 换成「记账并即刻抛错」的探针：不建连、零 IO，却能逐字回答「这一格是否真的去取一言」。
  // 判定口径（源码注释 v3.273）：仅显式 true 或字符串（忽略大小写）'true' 开启；false/0/'0'/undefined/1/'true ' 关闭。
  {
    const gotMod = require('got')
    const origGet = gotMod.get
    const seen = []
    const saved = {}
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    const clearCfg = () => { for (const k of Object.keys(cfg)) delete cfg[k] }
    const hits = () => seen.filter(u => u === 'https://v1.hitokoto.cn/').length
    gotMod.get = (url) => { seen.push(String(url)); throw new Error('hitokoto-probe-no-io') }
    try {
      const cases = [
        [true, true, 'HITOKOTO===true 必须取一言（===true 被改成 false / !== / 整体换成 false 会在此变红）'],
        ['TRUE', true, "字符串 'TRUE' 必须取一言（大小写不敏感 + 'true' 字面量逐字 + typeof 判定）"],
        ['True', true, "字符串 'True' 必须取一言"],
        ['true', true, "字符串 'true' 必须取一言"],
        ['true ', false, "带尾随空白的 'true ' 不得取一言（判定不做 trim）"],
        ['false', false, "字符串 'false' 不得取一言"],
        [false, false, '布尔 false 不得取一言'],
        [0, false, '数字 0 不得取一言'],
        ['0', false, "字符串 '0' 不得取一言"],
        [undefined, false, 'undefined 不得取一言'],
        [1, false, '数字 1 不得取一言（非 true、非字符串）']
      ]
      for (const [value, shouldFetch, why] of cases) {
        clearCfg()
        cfg.WX_XIZHI_KEY = '::::' // 唯一配置通道：非法 URL ⇒ got 在 new URL() 阶段抛错（不建连）
        cfg.HITOKOTO = value
        seen.length = 0
        await slim.sendNotify('测试文本', '测试正文').catch(() => {})
        assert.strictEqual(hits(), shouldFetch ? 1 : 0, why)
      }
      console.log('✅ sendNotify：一言开关逐格（true/TRUE/True/true → 取一次；true /false/0/0/undefined/1 → 不取）')
    } finally {
      gotMod.get = origGet
      for (const k of Object.keys(cfg)) delete cfg[k]
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ===== sendNotify 包装函数：channelTasks 逐通道取用与失败归因 =====
  // 源码 channelTasks 每项为 [configuredFlags[i], '通道名', () => xxxNotify(...)]，只有「已配置」项会被启动。
  // 契约：部分成功即本轮成功；全部通道失败必须响亮抛 ALL_CHANNELS_FAILED 并逐通道归因。
  // 零网络观测法（不装桩、不造网）：①通道地址配置指向非法 URL ⇒ got 在 new URL() 阶段抛错、不建连；
  // ②pushplus/server酱/wxpusher 的地址写死，改用调用方自带 params.signal（已 abort）——源码 requestExtras
  // 把它透传给 got，请求在建立前即被取消。逐项断言「启动前同步写入的 tracker.pending 恰好是这一项且
  // 通道名逐字」+「failure.channel 逐字」⇒ 数组→[]、名字串→""、箭头函数→() => undefined 三类全部变红。
  {
    const saved = {}
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    const clearCfg = () => { for (const k of Object.keys(cfg)) delete cfg[k] }
    try {
      const channelCases = []
      if (typeof AbortSignal === 'function' && typeof AbortSignal.abort === 'function') {
        const aborted = AbortSignal.abort()
        channelCases.push(
          ['pushplus', { PUSH_PLUS_TOKEN: 'probe-token' }, aborted],
          ['server酱', { PUSH_KEY: 'probe-key' }, aborted],
          ['wxpusher', { WX_pusher_channels: '[{"appToken":"AT_probe","topicIds":[1]}]' }, aborted]
        )
      }
      channelCases.push(
        ['息知', { WX_XIZHI_KEY: '::::' }, null],
        ['pushdeer', { DEER_KEY: 'deer-key', DEER_URL: '::::' }, null],
        ['pushme', { PUSHME_KEY: 'pushme-key', PUSHME_URL: '::::' }, null],
        ['telegram', { TG_BOT_TOKEN: 'bot-token', TG_USER_ID: 'uid', TG_API_HOST: '::::' }, null]
      )
      for (const [name, conf, signal] of channelCases) {
        clearCfg()
        Object.assign(cfg, conf)
        const tracker = {}
        const params = signal ? { inFlightTracker: tracker, signal } : { inFlightTracker: tracker }
        const pending = slim.sendNotify('测试文本', '测试正文', params)
        // 同步观测：pending 在启动任务前写入 ⇒ 逐字证明该项存在、名字正确、且被判为「已启用」
        assert.deepStrictEqual(tracker.pending, [name], `${name}：唯一配置的通道必须被取用且通道名逐字（数组→[] / 名字串→"" 会在此变红）`)
        await assert.rejects(() => pending, (e) => {
          assert.strictEqual(e.code, 'ALL_CHANNELS_FAILED', `${name}：全部通道失败必须响亮抛 ALL_CHANNELS_FAILED（箭头函数→undefined 会假成功、不抛）`)
          assert.deepStrictEqual(e.successfulChannels, [], `${name}：不得出现虚假成功通道`)
          assert.strictEqual(e.failures.length, 1, `${name}：失败清单必须恰好一项`)
          assert.strictEqual(e.failures[0].channel, name, `${name}：failure.channel 必须逐字为通道名`)
          return true
        })
      }
      console.log('✅ sendNotify：channelTasks 逐通道取用 + 失败归因（7 通道，非法 URL / 已 abort 信号，零出网）')
    } finally {
      for (const k of Object.keys(cfg)) delete cfg[k]
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ===== sendNotify 包装函数：params.inFlightTracker 契约 =====
  // 契约：可选 params.inFlightTracker（对象）——启动任务前同步写入 pending（未结算通道名），
  // 每通道 settle 时移除；不传时不产生任何副作用（既有调用方行为逐字不变）。观测通道固定为
  // 「息知 + 非法 URL」（零出网）。
  {
    const saved = {}
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    const onlyXiZhi = () => { for (const k of Object.keys(cfg)) delete cfg[k]; cfg.WX_XIZHI_KEY = '::::' }
    try {
      // ① 传对象 tracker：pending 在启动任务前同步写入本次将尝试的通道
      onlyXiZhi()
      const tracker = {}
      const pending = slim.sendNotify('测试文本', '测试正文', { inFlightTracker: tracker })
      assert.deepStrictEqual(tracker.pending, ['息知'], '传 tracker 时必须写入 pending（条件整体被换成 false 会在此变红）')
      await assert.rejects(() => pending, (e) => e.code === 'ALL_CHANNELS_FAILED')
      // ② 不传 tracker：对调用方 params 零副作用，也不得抛错（严格模式下条件被换成 true 会抛 TypeError）
      onlyXiZhi()
      const params = {}
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文', params),
        (e) => e.code === 'ALL_CHANNELS_FAILED',
        '不传 tracker 时行为必须与既有一致'
      )
      assert.deepStrictEqual(Object.keys(params), [], '不传 tracker 时不得给 params 添加任何字段')
      // ③ params 为 null：`params && …` 必须短路成「无 tracker」，而不是去读 null.inFlightTracker（`&&`→`||`）
      onlyXiZhi()
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文', null),
        (e) => e.code === 'ALL_CHANNELS_FAILED' && e.failures[0].channel === '息知',
        'params=null 必须短路为「无 tracker」而不是 TypeError'
      )
      // ④ 非对象 tracker（函数）：typeof 校验必须把它当作「无 tracker」，不得往它上面写 .pending
      onlyXiZhi()
      const probeFn = function () {}
      await assert.rejects(
        () => slim.sendNotify('测试文本', '测试正文', { inFlightTracker: probeFn }),
        (e) => e.code === 'ALL_CHANNELS_FAILED'
      )
      assert.strictEqual(probeFn.pending, undefined, 'typeof 不是 object 的 tracker 不得被当作 tracker 写入')
      console.log('✅ sendNotify：inFlightTracker 契约（同步写入 pending / 不传零副作用 / typeof 校验）')
    } finally {
      for (const k of Object.keys(cfg)) delete cfg[k]
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ===== 补测 PlanD：truncateBytes（经「企业微信」通道的 4096 字节截断观测）=====
  // 反例（改动前）：truncateBytes 未导出，其 13 个靶子一直被登记为「不可达」——**该判断是错的**：
  // 它经 qywxBotNotify 的 content 调用点可达，而企微通道已被本套件驱动（QYWX_KEY + got 替身）。
  // 做法：把 got.stream.post 换成「记账即刻抛错」的最小 EventEmitter 探针捕获请求体（真实 got 带 stream ⇒ 通道走 streamRequest，不看 got.post），零 IO；再断言 markdown.content 的**字节级**形态。
  {
    const gotMod = require('got')
    const captured = []
    const saved = {}
    const clearCfg = () => { for (const k of Object.keys(cfg)) delete cfg[k] }
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    // 真实 got 带 stream ⇒ 通道走 streamRequest（不看 got.post）。故替身必须装在 got.stream.post 上，
    // 返回一个最小 EventEmitter：立刻 error，既捕获请求体、又保证零 IO 且不阻塞。
    const { EventEmitter } = require('node:events')
    const origStreamPost = gotMod.stream && gotMod.stream.post
    gotMod.stream = gotMod.stream || {}
    gotMod.stream.post = (url, opts) => {
      captured.push({ url: String(url), body: opts && opts.json })
      const em = new EventEmitter()
      em.destroy = () => {}
      setImmediate(() => em.emit('error', new Error('qywx-probe-no-io')))
      return em
    }
    try {
      // 只配企微通道，避免其它通道参与
      clearCfg()
      cfg.QYWX_KEY = 'probe-qywx-key'
      // ① 短正文（中文 3 字节/字）：不得被截断，且必须原样出现在 content 里
      captured.length = 0
      await slim.sendNotify('短标题', '中文正文').catch(() => {})
      assert.strictEqual(captured.length, 1, '只配企微时必须恰好发出一次请求（探针零 IO）')
      assert.strictEqual(captured[0].body.msgtype, 'markdown', '企微必须走 markdown 形态')
      assert.strictEqual(captured[0].body.markdown.content, '短标题\n\n中文正文', '短正文必须原样，不得被截断（≤4096 分支）')
      // ② 超长正文（中文 4000 字 = 12000 字节 > 4096）：必须按**字节**截断到 ≤4096 且是合法 UTF-8
      captured.length = 0
      const longBody = '中'.repeat(4000)
      await slim.sendNotify('T', longBody).catch(() => {})
      const content = captured[0].body.markdown.content
      const bytes = Buffer.byteLength(content, 'utf8')
      assert.ok(bytes <= 4096, `超长正文必须截到 ≤4096 字节（实际 ${bytes}）——按「字符」或「不截断」的实现会在此变红`)
      assert.ok(bytes > 3900, `截断必须尽量用满预算（实际 ${bytes}）——提前退出/预算算错会在此变红`)
      assert.strictEqual(content, Buffer.from(content, 'utf8').toString('utf8'), '截断结果必须是合法 UTF-8（不得截出半个多字节字符）')
      assert.strictEqual(/\uFFFD/.test(content), false, '不得出现替换字符（截在多字节字符中间会留下 U+FFFD）')
      // ③ 代理对：末尾若正好落在 emoji 中间，必须整体退位（保留完整字符或彻底去掉，不得留孤立代理）
      captured.length = 0
      const emojiTail = 'a'.repeat(4090) + '\u{1F600}\u{1F600}'
      await slim.sendNotify('T', emojiTail).catch(() => {})
      const c3 = captured[0].body.markdown.content
      assert.strictEqual(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c3), false,
        '截断不得留下孤立代理（代理对必须整体保留或整体丢弃）')
      assert.ok(Buffer.byteLength(c3, 'utf8') <= 4096, '代理对场景同样不得超预算')
      console.log('✅ PlanD truncateBytes：经企微通道观测字节级截断（短正文原样 / 超长 ≤4096 且合法 UTF-8 / 代理对不孤立）')
    } finally {
      if (origStreamPost) gotMod.stream.post = origStreamPost
      clearCfg()
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ===== 补测 PlanF：normalizeFailure 与失败聚合（经 sendNotify 的 failures 观测）=====
  // 反例（改动前）：normalizeFailure 20 个靶子被登记为「不可达」——**该判断同样是错的**：
  // 它在 channelResults 里被调用（L1612），而 sendNotify 在**全部通道失败**时把 failures 一路抛出。
  // 做法：got.stream.post 替身让通道 reject 一个**带 code/statusCode/providerCode 的错误**，
  // 零 IO 捕获 sendNotify 抛出的 error.failures，逐字段断言归一化结果。
  {
    const gotMod = require('got')
    const { EventEmitter } = require('node:events')
    const origStreamPost = gotMod.stream && gotMod.stream.post
    const saved = {}
    const clearCfg = () => { for (const k of Object.keys(cfg)) delete cfg[k] }
    for (const k of Object.keys(cfg)) saved[k] = cfg[k]
    // 让通道以「自定义错误」失败：可注入 code/statusCode/providerCode
    let mkErr = () => { const e = new Error('boom'); e.code = 'E_PROBE'; e.statusCode = 500; e.providerCode = 'PROV'; return e }
    gotMod.stream = gotMod.stream || {}
    gotMod.stream.post = () => {
      const em = new EventEmitter()
      em.destroy = () => {}
      setImmediate(() => em.emit('error', mkErr()))
      return em
    }
    try {
      clearCfg()
      cfg.QYWX_KEY = 'probe-key'
      // ① channel 字段必须被归一化进来，且三个可选字段原样透传（'undefined' 判定被改坏会丢字段）
      let err = null
      try { await slim.sendNotify('T', 'D') } catch (e) { err = e }
      assert.strictEqual(err && err.message, '所有推送通道失败: boom', '全部失败时的聚合消息必须逐字')
      // 注意：failures 的元素是**归一化后的 Error 实例**（不是普通对象）——deepStrictEqual 对普通对象会因原型不同而红。
      const f0 = err.failures[0]
      assert.ok(f0 instanceof Error, '归一化结果必须是 Error 实例（不是普通对象字面量）')
      assert.strictEqual(f0.message, 'boom', 'message 必须来自 safeErr 摘要')
      assert.strictEqual(f0.code, 'E_PROBE', 'code 必须原样透传')
      assert.strictEqual(f0.statusCode, 500, 'statusCode 必须原样透传')
      assert.strictEqual(f0.providerCode, 'PROV', 'providerCode 必须原样透传')
      assert.strictEqual(f0.channel, '企业微信', 'channel 必须回填')
      // ② 错误对象**缺**可选字段时，不得凭空造出这些键（`!== undefined` 判定被放宽成恒真会在此变红）
      mkErr = () => { const e = new Error('plain'); return e }
      err = null
      try { await slim.sendNotify('T', 'D') } catch (e) { err = e }
      const b0 = err.failures[0]
      assert.strictEqual(b0.channel, '企业微信', 'channel 必须回填')
      assert.strictEqual('code' in b0, false, '无 code 时不得凭空造出 code 键（!== undefined 判定被放宽成恒真会在此变红）')
      assert.strictEqual('statusCode' in b0, false, '无 statusCode 时不得造键')
      assert.strictEqual('providerCode' in b0, false, '无 providerCode 时不得造键')
      // ③ 非对象 reason（字符串抛出）必须退化为 `${channel} 发送失败` 或原消息，且不得抛
      mkErr = () => 'plain-string-reason'
      err = null
      try { await slim.sendNotify('T', 'D') } catch (e) { err = e }
      // 实测：字符串 reason 走 `reason && typeof reason === 'object'` 的假分支 ⇒ 只回填 channel（不造 code/statusCode 等键）
      const c0 = err.failures[0]
      assert.strictEqual(c0.channel, '企业微信', 'channel 必须回填')
      assert.strictEqual('code' in c0, false, '字符串 reason 不得进入字段透传分支')
      assert.strictEqual('providerCode' in c0, false, '字符串 reason 不得进入字段透传分支')
      assert.strictEqual(err.message, '所有推送通道失败: plain-string-reason', '聚合消息必须原样保留字符串 reason 的文本')
      console.log('✅ PlanF normalizeFailure：code/statusCode/providerCode 透传、缺失不造键、非对象 reason 退化')
    } finally {
      if (origStreamPost) gotMod.stream.post = origStreamPost
      clearCfg()
      for (const [k, v] of Object.entries(saved)) cfg[k] = v
    }
  }

  // ============================================================
  // ===== 补测 SNA 簇（g12 第二批，按本机探针口径修正过形态）=====
  // 覆盖：失败聚合形状 / channelError 的 statusCode 来源优先级 / 一设备成功即通道成功 /
  //       多通道失败摘要截断与逐字拼接 / WxPusher 退避算术与时间窗边界 / abort 监听器卫生 /
  //       限频业务码的数字与字符串两种序列化。
  //
  // 形态纪律（探针实测，别演成生产不可能出现的形状）：
  //   · 桩必须装在 got.stream.post|get —— 本机 got 带 stream ⇒ canStreamRequest(:350) 恒真 ⇒
  //     `$.post` 真实走 streamRequest(:354)，**根本不碰 got.post**。只桩 got.post/get 会真触网。
  //   · 非 2xx 在真实 got 下是 **error 事件**（err.response.statusCode），不是「response(4xx)+data」。
  //     所以业务失败一律演成 HTTP 200 + 业务码（真实代理确实这么回），传输失败一律演成 error 事件。
  //   · `$.logErr` 在加载期就绑定 console.log(:447)，事后桩拦不到 ⇒ 本簇只断 err.failures 形状，
  //     不拿日志捕获当 catch 分支的判据。
  // 计时纪律：一律「记账 setTimeout 的延迟入参」，零墙钟阈值（PERF_MS 沙箱下不会假红）。
  {
    const gotMod = require('got')
    const { EventEmitter: SNAEE } = require('node:events')
    const savedSna = {}
    for (const k of Object.keys(cfg)) savedSna[k] = cfg[k]
    const clearCfg = () => { for (const k of Object.keys(cfg)) delete cfg[k] }
    const origStream = { post: gotMod.stream && gotMod.stream.post, get: gotMod.stream && gotMod.stream.get }
    // 初始值与后续赋的 handler **同签名**（收 url/opts）：写成零参箭头会让 Sonar 判
    // javascript:S930「函数声明不收参数却传了 2 个」——它抓的是这个变量的签名不一致，
    // 与我上一轮删掉的 `|| {}` 无关（那次归因是错的，规则号我凭印象写成 S2589，也未查证）。
    let snaHandler = (url, opts) => ({})
    let snaCalls = []
    const snaMake = (url, opts) => {
      // 契约：snaHandler 一律返回 spec 对象（body / error 两种形态）。
      // timings 直接给固定值，不做 `spec.timings || 默认` 的可配置开关：本文件的用例都不读
      // timings，那个左操作数恒假，是一道没人经过的门（删掉空转配置项即可，不必为它补断言）。
      // 将来若有用例真的要观测 timings，请连同断言一起把这条开关加回来。
      const spec = snaHandler(String(url), opts)
      snaCalls.push({ url: String(url), opts })
      const em = new SNAEE()
      em.timings = { phases: {} }
      em.destroy = () => {} // 超限分支会调它；缺了会在 emit 里同步抛 TypeError 把进程干掉
      setImmediate(() => {
        if (spec.error !== undefined) { em.emit('error', spec.error); return }
        em.emit('response', { statusCode: 200, headers: { 'content-type': 'application/json' }, ...spec.response })
        const body = spec.body === undefined ? '{}' : (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body))
        em.emit('data', Buffer.from(body))
        em.emit('end')
      })
      return em
    }
    gotMod.stream.post = snaMake
    gotMod.stream.get = snaMake
    // 记账型「假 AbortSignal」：真实 signal 只保证 aborted/addEventListener/removeEventListener 三件事，
    // 这里额外记录注册与摘除，用来观测 :1000-1007 的 cleanup 卫生（真 AbortSignal 读不到内部监听器）。
    const duckSignal = () => {
      const rec = { added: [], removed: [], aborted: false }
      return {
        rec,
        get aborted () { return rec.aborted },
        addEventListener (name, fn, opts) { rec.added.push([name, fn, opts]) },
        removeEventListener (name, fn) { rec.removed.push([name, fn]) },
        fire () { rec.aborted = true }
      }
    }
    const runExpectThrow = async (text, params) => {
      // 走 settleWithin：这类 await 的收场依赖生产里的取消分支，分支被改坏时它不是「慢」而是
      // **永不结算** ⇒ 旧写法会让整条链停住、事件循环排空、进程以 0 退出（静默跳过后续用例）。
      const outcome = await settleWithin(text, slim.sendNotify(text, '正文', params))
      assertSettled(outcome, text, '取消收场只走 waitWithAbort 里「进入等待时 signal 已 aborted」那一支。')
      const err = outcome.error
      assert.ok(err, `${text} 必须上抛`)
      return err
    }
    // 判「必须成功返回」的同一口径：先确保结算，再由各用例自己断言 error/value。
    const runExpectResolve = async (text, params) => {
      const outcome = await settleWithin(text, slim.sendNotify(text, '正文', params))
      assertSettled(outcome, text, '本条不依赖取消支路，但仍守住「不结算就不许绿」的口径。')
      return outcome
    }

    try {
      // --- SNA-01：Bark 全部设备失败的聚合形状（:693 → aggregateChannelError :179-183）---
      clearCfg(); snaCalls = []
      cfg.BARK_PUSH = 'https://api.day.app/snaDevA#https://api.day.app/snaDevB'
      snaHandler = () => ({ body: { code: 500, message: 'device key invalid' } }) // HTTP 200 + 业务失败码（真实形态）
      let err = await runExpectThrow('SNA-01')
      assert.strictEqual(err.code, 'ALL_CHANNELS_FAILED', '唯一通道全设备失败必须整体上抛')
      assert.strictEqual(err.failures.length, 1, '只有 bark 一个通道参与')
      const agg = err.failures[0]
      assert.strictEqual(agg.channel, 'bark', '聚合失败必须点名 bark')
      assert.strictEqual(agg.message, 'Bark 全部设备发送失败', '聚合文案必须逐字')
      assert.strictEqual(agg.code, 'CHANNEL_BARK_FAILED', '聚合错误码 = CHANNEL_ + 通道名大写 + _FAILED')
      assert.strictEqual(agg.failures.length, 2, '两个设备必须各留一条失败详情（filter/map 形态改坏会少项）')
      assert.strictEqual(agg.failures[0].statusCode, 200, '逐设备失败必须带 HTTP 状态码（来自 response 形参）')
      assert.strictEqual(agg.failures[0].providerCode, 500, '逐设备失败必须带业务码')
      assert.strictEqual('statusCode' in agg, false, '聚合层自己没有响应，不得凭空造 statusCode')
      console.log('✅ SNA-01 Bark 全设备失败：CHANNEL_BARK_FAILED + 逐设备 statusCode/providerCode 留痕')

      // --- SNA-02：PushMe 全 key 失败聚合（:771，part2 段独立一行）+ 纯文本响应不得造 providerCode ---
      clearCfg(); snaCalls = []
      cfg.PUSHME_KEY = 'snaK1#snaK2#snaK3'
      snaHandler = () => ({ body: 'error' }) // PushMe 的成功判据是 body === 'success'
      err = await runExpectThrow('SNA-02')
      const pAgg = err.failures[0]
      assert.strictEqual(pAgg.code, 'CHANNEL_PUSHME_FAILED', 'part2 段的 PushMe 聚合码必须同样由通道名大写拼成')
      assert.strictEqual(pAgg.message, 'PushMe 全部 key 发送失败', 'PushMe 聚合文案必须逐字')
      assert.strictEqual(pAgg.failures.length, 3, '三个 key 必须各留一条失败')
      assert.strictEqual('providerCode' in pAgg.failures[0], false, '响应是纯文本时不得凭空造 providerCode 键')
      console.log('✅ SNA-02 PushMe 全 key 失败：CHANNEL_PUSHME_FAILED + 三 key 留痕 + 不造空键')

      // --- SNA-03：channelError 的 statusCode 来源优先级（:167-173）---
      // 传输错误形：streamRequest 的 error 分支传 resp=null，故只能从 err.response.statusCode 取（真实 got 的形状）。
      clearCfg(); snaCalls = []
      cfg.BARK_PUSH = 'https://api.day.app/snaDevC'
      const transportErr = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET', response: { statusCode: 502 } })
      snaHandler = () => ({ error: transportErr })
      err = await runExpectThrow('SNA-03 传输错误形')
      const inner = err.failures[0].failures[0]
      assert.strictEqual(inner.statusCode, 502, 'resp 形参为 null 时必须退到 err.response.statusCode')
      assert.strictEqual(inner.code, 'ECONNRESET', '传输错误码必须原样透传')
      // 合成对照：err.statusCode 与 err.response.statusCode 同时存在时**必须取后者**。
      // 诚实说明：真实 got 不同时给这两个字段，这一子形钉的是「取值优先级本身」，不是 got 的形态。
      clearCfg(); snaCalls = []
      cfg.BARK_PUSH = 'https://api.day.app/snaDevD'
      const bothErr = Object.assign(new Error('bad gateway'), { code: 'ERR_NON_2XX_3XX_RESPONSE', statusCode: 504, response: { statusCode: 503 } })
      snaHandler = () => ({ error: bothErr })
      err = await runExpectThrow('SNA-03 优先级对照')
      const inner2 = err.failures[0].failures[0]
      assert.strictEqual(inner2.statusCode, 503, 'err.response.statusCode 必须优先于 err.statusCode（三元顺序对调在此变红）')
      console.log('✅ SNA-03 channelError：response 形参 > err.response.statusCode > err.statusCode')

      // --- SNA-04：一设备成功即通道成功（:692 results.some）——自 test_notify.js:248 移植 ---
      // 移植理由：那条集成用例的用例体只有「await 不抛」、零断言；且 test_notify.js 标 integration:true，
      // 被 scripts/tap-shim.js:111 排除在变异测试集外 ⇒ `some→every`、`r && r.ok→r.ok` 对变异门禁完全隐形。
      clearCfg(); snaCalls = []
      cfg.BARK_PUSH = 'https://api.day.app/snaOk#https://api.day.app/snaBad'
      snaHandler = (url) => ({ body: url.includes('snaOk') ? { code: 200 } : { code: 500, message: 'bad' } })
      let res = null
      let threw = null
      const r04 = await runExpectResolve('SNA-04')
      res = r04.value; threw = r04.error
      assert.ok(!threw, `一成一败必须算通道成功（v3.166），实际 ${threw && threw.message}`)
      assert.deepStrictEqual(res.successfulChannels, ['bark'], '成功通道应为 bark')
      assert.deepStrictEqual(res.failures, [], '部分成功不得记失败')
      assert.strictEqual(snaCalls.length, 2, '两个设备各发一次，不得重试失败设备（改成失败即重试会变 3）')
      console.log('✅ SNA-04 Bark 一成一败：通道判成功且不重试失败设备（自集成档移植进变异集）')

      // --- SNA-05：多通道失败摘要的 200 字符截断与「; 」逐字拼接（:1624-1628）---
      clearCfg(); snaCalls = []
      cfg.WX_XIZHI_KEY = 'https://xizhi.fake/sna05'
      cfg.DEER_KEY = 'PDK_sna05'
      snaHandler = (url) => url.includes('xizhi')
        ? ({ body: { code: 500, msg: 'XZFAIL' + 'q'.repeat(400) } })
        : ({ body: { content: { result: [] } } })
      err = await runExpectThrow('SNA-05 长摘要')
      assert.ok(err.message.startsWith('所有推送通道失败: '), '摘要前缀必须逐字')
      assert.strictEqual(err.message.length, '所有推送通道失败: '.length + 200, `摘要必须截到 200 字符，实际 ${err.message.length}`)
      clearCfg(); snaCalls = []
      cfg.WX_XIZHI_KEY = 'https://xizhi.fake/sna05b'
      cfg.DEER_KEY = 'PDK_sna05b'
      snaHandler = (url) => url.includes('xizhi')
        ? ({ body: { code: 500, msg: 'A_TXT' } })
        : ({ body: { content: { result: [] } } })
      err = await runExpectThrow('SNA-05 短摘要')
      assert.strictEqual(err.message, '所有推送通道失败: A_TXT; PushDeer 发送失败', '多失败必须用「; 」按通道顺序拼接')
      assert.deepStrictEqual(err.failures.map(f => f.channel), ['息知', 'pushdeer'], 'failures 顺序必须与 channelTasks 一致')
      console.log('✅ SNA-05 失败摘要：200 字符上限 + 「; 」逐字拼接 + 通道注册顺序')

      // --- SNA-06/07/08：WxPusher 退避等待的算术、取消时机与监听器卫生（:1000-1023 / :1047）---
      // 假时钟冻结 ⇒ 19 次成功把窗口打满；第 20 次的等待用「记账 setTimeout 延迟入参」观测，
      // 再决定在哪个时刻取消：调度时即已取消 ⇒ 命中 :1019 真支；派发后才取消 ⇒ 观测监听器摘除。
      const realNow = Date.now
      const realST = global.setTimeout
      const fillWindow = async (token) => {
        clearCfg(); snaCalls = []
        cfg.WX_pusher_appToken = token
        cfg.WX_pusher_topicIds = 'T1'
        snaHandler = () => ({ body: { code: 1000 } })
        for (let i = 0; i < 19; i++) {
          const filled = await settleWithin(`预填-${i}`, slim.sendNotify('预填-' + i, '正文'))
          assertSettled(filled, `预填-${i}（token ${token}）`, '预填走的是窗口名额分配，若窗口算术被改坏它可能永不结算。')
          assert.ok(!filled.error, `预填-${i} 不得失败，实际 ${filled.error && filled.error.message}`)
        }
        assert.strictEqual(snaCalls.length, 19, `窗口内 19 次必须全部发出，实际 ${snaCalls.length}`)
      }
      // 确定性等待桩：**只按「第几次看到 >=20ms 的等待」决策**，绝不依赖 setImmediate 与 0ms timer
      // 的相对顺序。反例（CI 实测 quality 22.22.2，run 37330406755）：先前写成「记账后放行
      // realST(fn,0) + setImmediate 取消」，本机空闲时取消先发生 ⇒ waits 恰一个；CI 上那个 0ms
      // timer 先跑 ⇒ 同一次等待被采集两遍（waits=[10010,10010]）⇒ 用例随机红。
      // 现在 'abort' 分支返回**永不触发**的假句柄：生产只能靠 aborted 收场，采集次数与调度顺序无关；
      // cleanup 里的 clearTimeout(假句柄) 在 Node 下无害。
      const DUMMY_TIMER = { snaDummyHandle: true }
      const hookWaits = (decide) => {
        const waits = []
        global.setTimeout = (fn, ms, ...rest) => {
          if (typeof ms === 'number' && ms >= 20) {
            const verdict = decide(waits.length, ms)
            waits.push(ms)
            if (verdict === 'run') return realST(fn, ms, ...rest)
            return DUMMY_TIMER
          }
          return realST(fn, ms, ...rest)
        }
        return waits
      }
      // (a) 时钟冻结 ⇒ 裸值 = 10000+10。只钉退避算术与取消语义。
      //     ⚠️ 不宣称覆盖 :1019 的「进入等待时已 aborted」真支：生产在同一个同步段里读两次
      //     `signal.aborted`（循环顶 :1027 与 :1018），中间没有 await ⇒ 真实运行时到不了那一支。
      //     本条的收场确实从那一支走过，但判据只有「延迟值 + ABORT_ERR + 零请求」这三件与
      //     取消路径无关的事实，因此不存在「靠合成时序刷覆盖」的问题。
      {
        const t0 = realNow()
        const sig = duckSignal()
        let waits
        Date.now = () => t0
        try {
          await fillWindow('APT_sna06a')
          snaCalls = []
          waits = hookWaits(() => { sig.fire(); return 'abort' })
          err = await runExpectThrow('SNA-06 退避中被取消', { signal: sig })
          assert.deepStrictEqual(waits, [10010], '退避延迟必须等于 nextRelease-now+10=10010（Math.max→Math.min、+10→-10 都在此变红）')
          assert.strictEqual(err.failures[0].code, 'ABORT_ERR', '取消必须按 ABORT_ERR 上抛')
          assert.strictEqual(err.failures[0].message, 'WxPusher 限频等待已取消', '取消文案必须逐字')
          assert.strictEqual(snaCalls.length, 0, '取消后一次都不发')
        } finally { global.setTimeout = realST; Date.now = realNow }
        console.log('✅ SNA-06/07 退避算术 10010 + 取消按 ABORT_ERR 上抛且零请求')
      }
      // (b) 监听器卫生：让第一次等待**真的到期**（假时钟把延迟压到 20ms），走 timer 自然收场那条路，
      //     才能观测 cleanup 摘监听器；第二次等待再取消收尾（不留真实 10s 定时器）。
      {
        const t0 = realNow()
        const sig = duckSignal()
        let waits
        try {
          Date.now = () => t0
          await fillWindow('APT_sna08b')
          snaCalls = []
          // 预填**之后**才把时钟推进 9995ms：裸值 = (t0+10000) - (t0+9995) + 10 = 15 ⇒ 被夹到 20ms
          Date.now = () => t0 + 9995
          waits = hookWaits((n) => {
            if (n === 0) return 'run'
            sig.fire()
            return 'abort'
          })
          err = await runExpectThrow('SNA-08 退避到点后取消', { signal: sig })
          assert.strictEqual(waits[0], 20, `第一次等待必须被夹到 20ms 下限（裸值 15；改成 Math.min 就变 15），实际 ${waits[0]}`)
          assert.ok(waits.length >= 2, '20ms 到期后窗口仍满 ⇒ 必须再排一次（一次都没续排说明 resolve 路径坏了）')
          assert.strictEqual(sig.rec.added[0][0], 'abort', '未取消时必须注册 abort 监听器')
          assert.strictEqual(sig.rec.added[0][2].once, true, '必须以 { once: true } 注册（删掉该选项在此变红）')
          assert.ok(sig.rec.removed.length >= 1, '结算后必须摘掉监听器（否则长跑进程每轮退避泄漏一个闭包）')
          assert.strictEqual(sig.rec.removed[0][0], 'abort', '摘的必须是 abort 事件')
          assert.strictEqual(sig.rec.removed[0][1], sig.rec.added[0][1], '摘的必须是同一个函数引用（换成新建函数在此变红）')
          assert.strictEqual(err.failures[0].code, 'ABORT_ERR', '取消最终仍按 ABORT_ERR 上抛')
        } finally { global.setTimeout = realST; Date.now = realNow }
        console.log('✅ SNA-08 abort 监听器卫生：once 注册、到期结算摘除、引用一致')
      }
      // (c)(d) 时间窗边界**必须成对**：恰好 10000ms ⇒ 零等待直接续发；差 1ms ⇒ 必须等待。
      //        `<=`→`<` 只有 (c) 能杀，`<=`→`>=` 只有 (d) 能杀，单独落一条都会留死角。
      {
        const t0 = realNow()
        const sig = duckSignal()
        Date.now = () => t0
        try {
          await fillWindow('APT_sna09c')
          snaCalls = []
          Date.now = () => t0 + 10000 // 命中 `timestamps[0] <= now - WINDOW` 的等号边界
          snaHandler = () => ({ body: { code: 1000 } })
          const waits = hookWaits(() => { sig.fire(); return 'abort' }) // 万一没淘汰：立刻取消 ⇒ 干净判红而不是卡死
          threw = null; res = null
          const r09c = await runExpectResolve('SNA-09c 恰好过期', { signal: sig })
          res = r09c.value; threw = r09c.error
          assert.ok(!threw, `边界命中必须直接排到名额，实际 ${threw && threw.message}`)
          assert.deepStrictEqual(waits, [], '命中等号边界不得进入等待（淘汰被删就会在此变红，且不靠挂死判红）')
          assert.deepStrictEqual(res.successfulChannels, ['wxpusher'], '过期清理后第 20 次必须成功')
          assert.strictEqual(snaCalls.length, 1, '必须真的发出第 20 次请求')
        } finally { global.setTimeout = realST; Date.now = realNow }
        const t1 = realNow()
        Date.now = () => t1
        try {
          await fillWindow('APT_sna09d')
          snaCalls = []
          Date.now = () => t1 + 9999 // 差 1ms 未过期 ⇒ 必须等待
          const sig = duckSignal()
          const waits = hookWaits(() => { sig.fire(); return 'abort' })
          try {
            err = await runExpectThrow('SNA-09d 差 1ms 未过期', { signal: sig })
            assert.deepStrictEqual(waits, [20], '未过期必须等待且夹到 20ms 下限（裸值 11；改成 Math.min 就变 11）')
            assert.strictEqual(snaCalls.length, 0, `未过期不得发出第 20 次（误判成已过期会在此变 1），实际 ${snaCalls.length}`)
            assert.strictEqual(err.failures[0].code, 'ABORT_ERR', '收尾用取消，不留真实 10s 定时器')
          } finally { global.setTimeout = realST }
        } finally { Date.now = realNow }
        console.log('✅ SNA-09 时间窗边界成对：恰好过期即零等待续发 / 差 1ms 必须等待并夹到 20')
      }

      // --- SNA-10：限频业务码的数字与字符串两种序列化 + 单应用限频即结束重试 ---
      clearCfg(); snaCalls = []
      cfg.WX_pusher_appToken = 'APT_sna10a'
      cfg.WX_pusher_topicIds = 'T1'
      snaHandler = () => ({ body: { code: 1001, msg: '速度太快' } })
      err = await runExpectThrow('SNA-10 单应用限频')
      assert.strictEqual(snaCalls.length, 1, '只有一个应用时限频必须结束重试，不得无限空转')
      assert.strictEqual(err.failures[0].channel, 'wxpusher', '失败必须点名 wxpusher')
      assert.strictEqual(err.failures[0].code, 1001, '业务码必须原样保留数字形态')
      assert.strictEqual(err.failures[0].providerCode, '1001', 'providerCode 必须是字符串形态（failure_policy 按字符串判）')
      clearCfg(); snaCalls = []
      cfg.WX_pusher_channels = [{ appToken: 'APT_sna10b1', topicIds: ['T1'] }, { appToken: 'APT_sna10b2', topicIds: ['T2'] }]
      let seen = 0
      snaHandler = () => ({ body: ++seen === 1 ? { code: '1001' } : { code: 1000 } })
      threw = null; res = null
      const r10 = await runExpectResolve('SNA-10 字符串限频码')
      res = r10.value; threw = r10.error
      assert.ok(!threw, `字符串 '1001' 也必须判限频并切备用应用，实际 ${threw && threw.message}`)
      assert.strictEqual(snaCalls.length, 2, '首个应用被判限频 ⇒ 必须换第二个')
      assert.deepStrictEqual(res.successfulChannels, ['wxpusher'], '备用应用应成功')
      console.log('✅ SNA-10 限频码：数字 1001 原样透传 + 字符串 1001 仍判限频切备用应用')
    } finally {
      if (origStream.post) gotMod.stream.post = origStream.post
      if (origStream.get) gotMod.stream.get = origStream.get
      clearCfg()
      for (const k of Object.keys(savedSna)) cfg[k] = savedSna[k]
      snaHandler = () => ({})
      snaCalls = []
    }
  }

  suiteFinished = true // 只有真的跑到结尾，beforeExit 哨兵才闭嘴（否则一律判红）
  console.log('test_sendnotify_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
