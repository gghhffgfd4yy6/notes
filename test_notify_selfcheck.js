'use strict'
// 通知自检（批次④ 4.1）进程内用例：--notify-test 直跑入口的互斥/HITOKOTO 抑制/
// 单次广播/退出码/汇总脱敏形态。全部 fake 注入，零真实网络、零真实推送。
//
// 框架说明（与 test_notify.js 同款）：test() 必须 async 并 await fn()，否则 async 断言
// 的失败会变成 unhandled rejection 而不被统计。console 输出临时替换捕获、finally 恢复；
// process.exitCode 保存/恢复（runNotifyTest 通过设置 process.exitCode 表达退出码）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// ── S1 前置：源码序断言（结构铁律唯一防线，先于任何行为用例）──
// 手法仿 test_qinglong_utils.js 接线断言：indexOf 定位 + 顺序比较。
// 插桩安全注意（Stryker 沙箱实测教训）：
//   ① if (require.main === module) 的 if( 前缀会被改写成 stryMutAct 三元（字面串消失），
//      但 require.main === module 表达式文本始终保留 ⇒ 定位用表达式本身；
//   ② 插桩使代码膨胀 ~2x 且产生大量 '} else {' ⇒ 禁用窗口切片和花括号锚点；
//   ③ 锚点必须全文唯一：'--notify-test' 旗标（1 处）、runNotifyTest(cliArgs)（1 处）、
//      runSingleEntry().catch（完整入口唯一调用，1 处）。
// 铁律语义 = runNotifyTest 分发在 runSingleEntry 完整入口之前（早退分支不被吞掉）。
const entrySrc = fs.readFileSync(path.join(__dirname, 'xbk_function_v3.js'), 'utf8')
{
  const guardIdx = entrySrc.indexOf('require.main === module')
  assert.ok(guardIdx > 0, 'main guard 必须存在')
  const iFlag = entrySrc.indexOf("'--notify-test'", guardIdx)
  const iCall = entrySrc.indexOf('runNotifyTest(cliArgs)', guardIdx)
  const iRun = entrySrc.indexOf('runSingleEntry().catch', guardIdx)
  assert.ok(iFlag > guardIdx, 'guard 内必须有 --notify-test 分发')
  assert.ok(iCall > iFlag, 'guard 内必须调用 runNotifyTest')
  assert.ok(iRun > iCall, 'runSingleEntry 完整入口必须在 notify-test 分支之后（早退语义）')
  // 审查 D2-M2（#232）：近似写法必须走自检，未知 -- 参数必须 fail-closed（不得静默跑一轮）。
  assert.ok(entrySrc.includes("a.startsWith('--notify-test=')"), '--notify-test=1 必须前缀分发到自检')
  assert.ok(entrySrc.includes('未识别参数'), '未知 -- 参数必须显式报错而不是进入 runSingleEntry')
}

// ── C5-038：源码结构断言的取段与负断言工具 ─────────────────────────────────
// 旧实现用 `slice(guardIdx, guardIdx + 4000)`：4000 是试出来的魔数，处理器再加长 200 字符
// summarizeError 就滑出窗口（假红），而窗口外新增的 `console.log(e)` 又完全不被检查（假绿）。
// 这里按花括号配对取 .catch 处理器体，并在同一趟扫描里剥掉注释（守则注释里本来就写着
// 「禁止 console.log(e)」，不剥会让负断言被注释满足）。
function guardHandlerBodyOf (source, anchor) {
  const at = source.indexOf(anchor)
  assert.ok(at > -1, `锚点缺失：${anchor}`)
  const open = source.indexOf('{', at)
  assert.ok(open > at, `锚点后必须有块起始：${anchor}`)
  let depth = 0
  let out = ''
  let i = open
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) break
      out += '\n'
      i = nl + 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      assert.ok(end > 0, `块注释未闭合：${anchor}`)
      out += ' '
      i = end + 2
      continue
    }
    // 字符串/模板串整体跳过：里面的花括号与 // 不参与配对（模板里的 ${} 自成平衡）
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i
      i++
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === ch) { i++; break }
        i++
      }
      out += source.slice(start, i)
      continue
    }
    if (ch === '{') {
      depth++
      if (depth === 1) { i++; continue } // 外层花括号不进返回值
    } else if (ch === '}') {
      depth--
      if (depth === 0) return out
    }
    out += ch
    i++
  }
  assert.fail(`块未闭合：${anchor}`)
}
// 「把原始 error 直接交给打印/序列化」的参数名无关判据：console.error(e) / console.warn(e) /
// JSON.stringify(e) / String(e) / util.inspect(e) 全部命中——旧断言只认字面量 `e` 与
// `console.log(e)`，改成 `err` + `console.warn` 就绕过去了。
function rawErrorUsePattern (name) {
  return new RegExp(`(?:console\\.\\w+|JSON\\.stringify|String|util\\.inspect|inspect)\\s*\\(\\s*${name}\\s*[,)]`)
}
const GUARD_CATCH_ANCHOR = 'runNotifyTest(cliArgs).catch('

// ── 进程内装配：got mock → 真 slim（带 mock）→ 主模块（getNotify 命中缓存）──
const gotPath = require.resolve('got')
require(gotPath)
let gotCalls = []
// pushplus 业务成功码 = code 200（v3.160 口径）；mock body 直接给 {code:200}
require.cache[gotPath].exports = (url, options) => {
  gotCalls.push({ url, options })
  return Promise.resolve({ body: JSON.stringify({ code: 200, msg: '' }), statusCode: 200, headers: {} })
}
require.cache[gotPath].exports.get = require.cache[gotPath].exports
require.cache[gotPath].exports.post = (url, options) => {
  gotCalls.push({ url, options })
  return Promise.resolve({ body: JSON.stringify({ code: 200, msg: '' }), statusCode: 200, headers: {} })
}

const slim = require('./xbk_sendNotify_slim.js')
const cfg = slim.push_config
const m = require('./xbk_function_v3.js')
assert.strictEqual(typeof m.runNotifyTest, 'function', 'runNotifyTest 必须从主模块导出')

// fake sendNotify 形态控制（替换 slim 模块内的 sendNotify 不可行——它未被导出为可写属性；
// 改为走 Pusher.send 的真实链：sendNotify 是 slim 内部函数。这里用「真实 sendNotify +
// got mock + withChannels」形态：S5 走全真链路验证零一言请求；单次广播/退出码用
// S3 的 Pusher 直替（主模块 Pusher.send 可被 require.cache 替换 v3 的 Pusher 导出？不可——
// v3 内部闭包引用。故 S3/S6 走 spawn 级（test_cli.js）覆盖，本文件专注真链路形态。）

// 通道相关配置 key：每用例前清空 → 只配被测通道；结束(含失败)后恢复
const CHANNEL_KEYS = ['PUSH_PLUS_TOKEN', 'PUSH_PLUS_USER', 'PUSH_KEY',
  'BARK_PUSH', 'BARK_ARCHIVE', 'BARK_GROUP', 'BARK_SOUND', 'BARK_ICON', 'BARK_LEVEL', 'BARK_URL',
  'QYWX_KEY', 'WX_pusher_appToken', 'WX_pusher_topicIds', 'WX_pusher_channels', 'WX_XIZHI_KEY',
  'DEER_KEY', 'DEER_URL', 'PUSHME_KEY', 'PUSHME_URL', 'HITOKOTO',
  'TG_BOT_TOKEN', 'TG_USER_ID', 'TG_API_HOST',
  'TG_PROXY_HOST', 'TG_PROXY_PORT', 'TG_PROXY_AUTH']
const saved = {}
for (const k of CHANNEL_KEYS) saved[k] = cfg[k]

async function withChannels (fn) {
  for (const k of CHANNEL_KEYS) cfg[k] = ''
  cfg.HITOKOTO = 'false'
  gotCalls = []
  try {
    return await fn()
  } finally {
    for (const k of CHANNEL_KEYS) cfg[k] = saved[k]
  }
}

// console 捕获 + exitCode 保存恢复（runNotifyTest 只设 exitCode 不 process.exit）。
// 返回 exitCode 在「finally 恢复前」的快照——断言要用的就是 runNotifyTest 实际设置的值。
async function withCapture (fn) {
  const savedLog = console.log
  const savedErr = console.error
  const savedCode = process.exitCode
  process.exitCode = 0
  const out = []
  console.log = (...a) => out.push(['log', a.join(' ')])
  console.error = (...a) => out.push(['err', a.join(' ')])
  try {
    const result = await fn()
    return { out, result, exitCode: process.exitCode }
  } finally {
    console.log = savedLog
    console.error = savedErr
    process.exitCode = savedCode
  }
}

function outText (out) { return out.map(([k, s]) => `${k}: ${s}`).join('\n') }

let passed = 0
let failed = 0
const errors = []
async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log('  ✅ ' + name)
  } catch (e) {
    failed++
    errors.push(`${name}: ${e.message}`)
    console.log('  ❌ ' + name + ' (' + e.message + ')')
  }
}
function assertRc (cond, msg) { if (!cond) throw new Error(msg || '断言失败') }

console.log('\n========================================')
console.log('  🧪 通知自检 --notify-test（进程内，fake/mock 注入）')
console.log('========================================\n')

;(async () => {
  // S2 互斥：--dry-run 同时出现 → fail-closed，零发送、零 got 调用
  await test('互斥: argv 带 --dry-run → exitCode 1、零调用', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'stub-token'
    const { out, exitCode } = await withCapture(() => m.runNotifyTest(['--notify-test', '--dry-run']))
    assertRc(exitCode === 1, `退出码应为 1，实际 ${exitCode}`)
    assertRc(outText(out).includes('互斥'), '应输出互斥文案')
    assertRc(gotCalls.length === 0, '互斥路径不得有任何 HTTP 调用')
  }))

  await test('互斥: env XBK_DRY_RUN=1 → exitCode 1、零调用', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'stub-token'
    process.env.XBK_DRY_RUN = '1'
    try {
      const { out, exitCode } = await withCapture(() => m.runNotifyTest(['--notify-test']))
      assertRc(exitCode === 1, `退出码应为 1，实际 ${exitCode}`)
      assertRc(outText(out).includes('互斥'), '应输出互斥文案')
      assertRc(gotCalls.length === 0, '互斥路径不得有任何 HTTP 调用')
    } finally {
      delete process.env.XBK_DRY_RUN
    }
  }))

  // D2-S15：环境变量判据与真实运行同口径（xbk_app.js 只在 === '1' 时进 dry-run）。
  // XBK_DRY_RUN=0/false 是「显式关闭」，自检不得被误拒——旧实现任何非空串都当 dry-run。
  await test('互斥: env XBK_DRY_RUN=0（显式关闭）→ 不拦、正常自检', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'stub-token'
    process.env.XBK_DRY_RUN = '0'
    try {
      const { out, exitCode } = await withCapture(() => m.runNotifyTest(['--notify-test']))
      assertRc(exitCode === 0, `退出码应为 0（=0 不是 dry-run），实际 ${exitCode}`)
      assertRc(!outText(out).includes('互斥'), '=0 不得触发 dry-run 互斥')
      assertRc(gotCalls.length === 1, `应正常发送 1 次，实际 ${gotCalls.length}`)
    } finally {
      delete process.env.XBK_DRY_RUN
    }
  }))

  // S5 HITOKOTO 抑制（真 slim 全链路）：开启一言时自检零一言外部请求
  await test('HITOKOTO 开启: 自检零一言请求 + 消息不含一言 + finally 恢复', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'stub-token'
    cfg.HITOKOTO = 'true'
    const { out, exitCode } = await withCapture(() => m.runNotifyTest(['--notify-test']))
    assertRc(exitCode === 0, `退出码应为 0，实际 ${exitCode}`)
    assertRc(gotCalls.length === 1, `应恰有 1 次 HTTP（pushplus），实际 ${gotCalls.length}`)
    assertRc(!gotCalls.some(c => String(c.url).includes('hitokoto')), '不得请求一言 API')
    const sent = outText(out)
    assertRc(sent.includes('通知自检完成'), '应输出汇总行')
    assertRc(!sent.includes('测试一言'), '消息/输出不得含一言内容')
  }))

  // S7 消息固定形态 + S3 单次广播（真链路：一次 sendNotify → 一条 pushplus post）
  await test('消息形态: 标题/版本/上海戳/主机名固定 + 单通道恰一请求', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'stub-token'
    const { exitCode } = await withCapture(() => m.runNotifyTest(['--notify-test']))
    assertRc(exitCode === 0, `退出码应为 0，实际 ${exitCode}`)
    assertRc(gotCalls.length === 1, 'pushplus 恰一条请求（单次广播、非逐渠道循环）')
    const payload = JSON.stringify(gotCalls[0].options || {})
    assertRc(payload.includes('xbk-push 通知自检'), '标题应为固定「xbk-push 通知自检」')
    assertRc(payload.includes('Asia/Shanghai'), '正文应含上海时区戳')
    assertRc(payload.includes('v3.'), '正文应含版本号')
    assertRc(payload.includes('主机：'), '正文应含主机名')
  }))

  // S6 退出码：全失败（通道 API 层失败 → sendNotify 走 okCount===0 reject）→ 顶层 catch 出 1
  // Sourcery Medium（Credential leaks bypass guard test）：S6 旧形态在进程内 catch 后自行
  // 复刻 guard 的 summarizeError 处理，从不执行真实 main-guard catch——若真 guard 里加了
  // 裸 console.error(e)，本测试依然绿而凭证照样泄漏。改为 spawn 型：真子进程真 guard，
  // fake 渠道 API 回显含假凭证的响应体，断言合并输出中凭证零出现。
  await test('全失败: 真 main-guard spawn → exitCode 1 + 凭证零泄漏 + 脱敏原因', () => {
    const os = require('os')
    const { spawnSync } = require('child_process')
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-selfcheck-stub-'))
    const stubPath = path.join(stubDir, 'stub.js')
    // 桩：require.cache 替身替换 slim；sendNotify 抛 ALL_CHANNELS_FAILED，错误对象与
    // response.body 均埋假凭证哨兵。真 slim 永不加载 → 零真实网络/推送（D10）。
    // 哨兵用 redact 可识别的 KV 形态（token=…）——redact 契约是模式脱敏（KV/Bearer），
    // 非配置值字典；provider 回显凭证的真实形态就是响应体/消息里的 KV。
    const SECRET = 'LEAK-CANARY-pK3dQ9'
    fs.writeFileSync(stubPath, `'use strict'
const slimPath = require('path').join(process.cwd(), 'xbk_sendNotify_slim.js')
// D2-S14：错误文本里混入 ANSI/OSC（provider 可回显）——真 guard 的失败路径必须剥掉，
// 否则自检在终端运行时 provider 能清屏/改标题。\u001B 在输出中零出现即为达标。
const err = new Error('所有推送通道失败: HTTP 502 回显 token=${SECRET} \u001B]0;pwned\u0007')
err.code = 'ALL_CHANNELS_FAILED'
err.statusCode = 502
err.response = { body: '{"token":"${SECRET}"}', statusCode: 502 }
err.failures = [{ channel: '桩渠道A', message: 'pushplus 响应: token=${SECRET} \u001B[31mRED\u001B[0m', statusCode: 502 }]
err.successfulChannels = []
require.cache[slimPath] = { id: slimPath, filename: slimPath, loaded: true, exports: { push_config: { HITOKOTO: 'false' }, configuredChannelNames: () => ['桩渠道A'], configuredChannelCount: () => 1, sendNotify: async () => { throw err } } }
// 注意：桩内绝不 require 入口文件——--require 阶段 require 它会让 Node 22 把入口标记为
// 已加载，真 main 不再执行（require.main !== module）→ guard 不触发、进程零输出退出 0。
`)
    try {
      const nodeOptions = [process.env.NODE_OPTIONS, `--require=${stubPath}`].filter(Boolean).join(' ')
      const run = spawnSync(process.execPath, [path.join(__dirname, 'xbk_function_v3.js'), '--notify-test'], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, NODE_OPTIONS: nodeOptions }
      })
      const text = `${run.stdout || ''}${run.stderr || ''}`
      assertRc(run.status === 1, `退出码应为 1，实际 ${run.status}`)
      assertRc(text.includes('通知自检失败'), '真 guard 应输出失败结论')
      assertRc(!text.includes(SECRET), '凭证哨兵不得出现在真 guard 输出（脱敏红线）')
      assertRc(!text.includes('[object Object]'), '不得有对象 stringify 痕迹')
      assertRc(!text.includes('\u001B'), 'D2-S14：失败路径不得把 ANSI/OSC 控制序列打到终端')
      assertRc(!text.includes('pwned'), 'OSC 整段剥除（含正文）')
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true })
    }
  })

  // S6b 退出码口径（C5-037）：旧形态在测试自己的 catch 里复刻 guard 的出口、再断言自己
  // 拼出来的「通知自检失败：」——既没读 process.exitCode，也从没经过真 guard。于是
  // 「无渠道不算失败，exit 0」这类改动（真实事故形态：自检假绿）在本套件里完全不可见。
  // 现在走真 main-guard：真子进程 + slim 换成「抛 NO_CHANNEL_CONFIG」的桩，
  // 退出码与文案都由 guard 的 catch 决定；文案断言锚在 summarizeError 的 message 上
  // （同一条脱敏出口），不是测试自己拼的字符串。
  //
  // C5-037 返工（审查 A）：旧夹具只把环境变量里的渠道 key 置空，清不掉配置文件——
  // slim 在 xbk_sendNotify_slim.js:303 按 __dirname 加载 push_config.local.js，且 :348-356
  // 明确「存在但为空的 env 不覆盖本地配置」。凡克隆里存在该文件（本机 ~/notes、~/notes-live
  // 都带真凭证），子进程会进入真实推送路径：既真发一条自检消息，又因推送成功 exit 0 而与
  // 「无渠道必须 exit 1」的断言冲突变红——违背「绝不裸跑真推」。改法照 S6：NODE_OPTIONS=
  // --require=<stub> 在装载期用 require.cache 替掉 slim，假模块直接抛 NO_CHANNEL_CONFIG。
  // 真 main-guard / 真 runNotifyTest / 真 Pusher 链一律不动，但 slim 永不加载 ⇒
  // push_config.local.js 永不被读、任何渠道都发不出去。
  await test('无渠道: 真 main-guard spawn → exitCode 1 + NO_CHANNEL_CONFIG 脱敏原因', () => {
    const os = require('os')
    const { spawnSync } = require('child_process')
    const { summarizeError } = require('./xbk_failure_policy')
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-selfcheck-nochan-'))
    const stubPath = path.join(stubDir, 'stub.js')
    const probePath = path.join(stubDir, 'probe.json')
    // 桩：替身 slim 的 sendNotify 抛 NO_CHANNEL_CONFIG；同时在装载期把全部出网入口计数
    // （http/https request|get、net.connect、tls.connect、dns.lookup）并直接抛错阻断。
    // 计数经 exit 钩子落到 probe.json —— 父进程断言「装载了桩 / sendNotify 恰一次 / 出网 0 次」，
    // 「零网络」由桩自证，而不是靠父进程猜子进程发了没发。
    fs.writeFileSync(stubPath, `'use strict'
const probe = { stubLoaded: true, sendNotifyCalls: 0, netAttempts: 0, blocked: [] }
const block = (name) => function () { probe.netAttempts++; probe.blocked.push(name); throw new Error('BLOCKED_NET:' + name) }
const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const dns = require('dns')
for (const [mod, keys] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']], [dns, ['lookup']]]) {
  for (const key of keys) if (typeof mod[key] === 'function') mod[key] = block(key)
}
process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.XBK_NOCHAN_PROBE, JSON.stringify(probe)) } catch (e) {}
})
const slimPath = require('path').join(process.cwd(), 'xbk_sendNotify_slim.js')
// 注意：桩内绝不 require 入口文件——--require 阶段 require 它会让 Node 22 把入口标记为
// 已加载，真 main 不再执行（require.main !== module）→ guard 不触发、进程零输出退出 0。
require.cache[slimPath] = { id: slimPath, filename: slimPath, loaded: true, exports: {
  push_config: { HITOKOTO: 'false' },
  configuredChannelNames: () => [],
  configuredChannelCount: () => 0,
  sendNotify: async () => {
    probe.sendNotifyCalls++
    const err = new Error('未配置任何推送通道（Push+/Server酱/Bark/企业微信/wxpusher/息知/PushDeer/PushMe/Telegram）')
    err.code = 'NO_CHANNEL_CONFIG'
    throw err
  }
} }
`)
    try {
      // env 清空只是二道防线（对 push_config.local.js 无效，见上），真正的保证是 slim 被替掉。
      const nodeOptions = [process.env.NODE_OPTIONS, `--require=${stubPath}`].filter(Boolean).join(' ')
      const env = { ...process.env, TZ: 'UTC', HITOKOTO: 'false', NODE_OPTIONS: nodeOptions, XBK_NOCHAN_PROBE: probePath }
      for (const k of CHANNEL_KEYS) env[k] = ''
      const run = spawnSync(process.execPath, [path.join(__dirname, 'xbk_function_v3.js'), '--notify-test'], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 30000,
        env
      })
      const text = `${run.stdout || ''}${run.stderr || ''}`
      assertRc(run.status === 1, `真 guard 退出码必须为 1（无渠道 = 失败），实际 ${run.status}（signal=${run.signal || '无'}）`)
      const summarized = summarizeError(Object.assign(new Error('未配置任何推送通道'), { code: 'NO_CHANNEL_CONFIG' }))
      assertRc(summarized.code === 'NO_CHANNEL_CONFIG', '夹具必须走 NO_CHANNEL_CONFIG 口径')
      assertRc(text.includes(`通知自检失败：${summarized.message}`),
        `失败结论必须由 guard 经 summarizeError 出口（期望含 ${JSON.stringify('通知自检失败：' + summarized.message)}，实际 ${JSON.stringify(text.slice(0, 400))}）`)
      assertRc(text.includes('未配置任何推送通道'), '应含 NO_CHANNEL_CONFIG 文案（渠道清单）')
      assertRc(!text.includes('[object Object]'), '不得有对象 stringify 痕迹')
      // C5-037：桩自证 —— 桩真的装进了子进程、真 guard 真的经 Pusher 调了一次 sendNotify、
      // 且全程零出网调用（否则说明 slim/真实通道被加载，本用例会真推送）。
      let probe
      try {
        probe = JSON.parse(fs.readFileSync(probePath, 'utf8'))
      } catch (e) {
        throw new Error(`桩未在子进程装载（probe 缺失：${e.code || e.message}）——拒绝在未替身状态下用真 slim 跑自检`)
      }
      assertRc(probe.stubLoaded === true, '桩必须在子进程装载（否则 slim 仍是真模块，本用例会真推送）')
      assertRc(probe.sendNotifyCalls === 1, `真 guard 必须恰好调一次 sendNotify（单次广播），实际 ${probe.sendNotifyCalls}`)
      assertRc(probe.netAttempts === 0, `零网络红线：子进程不得发起任何出网调用，实际 ${probe.netAttempts} 次（${(probe.blocked || []).join(',')}）`)
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true })
    }
  })

  // S8 脱敏红线：guard catch 块结构断言（summarizeError 在、原始 error 不得进打印/序列化）。
  // C5-038：取段改花括号配对（不再用试出来的 4000 字符窗口），负断言按处理器实参名判定，
  // 不再只认字面量 `e` / `console.log(e)`。行为侧的脱敏红线由 S6 的真 guard spawn 兜底
  // （凭证/ANSI/OSC 零出现）——两条一起才能同时挡住「改文案」与「换个函数名打印」。
  await test('脱敏红线: guard catch 走 summarizeError、原始 error 不得进打印/序列化', () => {
    const body = guardHandlerBodyOf(entrySrc, GUARD_CATCH_ANCHOR)
    assert.ok(body.length > 200, `必须真的取到 guard catch 处理器体（实际 ${body.length} 字节）`)
    // 实参名从锚点之后取：文件更早的地方还有别的 .catch(...)，不能全文件找第一个。
    // 形态：`.catch(e =>` / `.catch( (err =>`（多余空白可省）。旧写法 `\s*\(?\s*` 中间夹一个可省的 `(`，
    // 两侧量词在纯空白串上可以任意切分 ⇒ 超线性回切（S5852）。把 `(` 与它后面的空白捆成一组的可选前缀
    // 后，每个空白的归属唯一（`(` 不可能是空白），匹配语言与旧写法完全相同（探针里穷举短串比对过）。
    const caught = /\.catch\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*=>/.exec(entrySrc.slice(entrySrc.indexOf(GUARD_CATCH_ANCHOR)))
    assert.ok(caught, 'guard catch 必须带具名实参（取段与负断言都依赖它）')
    assert.ok(body.includes(`summarizeError(${caught[1]})`),
      `guard catch 必须过 summarizeError(${caught[1]})`)
    assert.ok(!/JSON\.stringify\s*\(/.test(body), 'guard catch 禁止任何 JSON.stringify（error.options/response 带凭证）')
    assert.ok(!/console\.(log|warn|info|debug)\s*\(/.test(body),
      'guard catch 只能走 console.error（错误流）——console.log 会把 stdout 当成正常输出，且没有对象打印的正当理由')
    const raw = rawErrorUsePattern(caught[1])
    assert.ok(!raw.test(body), `guard catch 不得把原始 error 直接交给打印/序列化（命中 ${raw}）`)
  })

  // 守住上面那条断言自己：它的取段与负断言必须对「真实维护动作」成立，否则红线随时静默失效。
  // 两个夹具都是不对仓库做任何改动的合成源码（照原实现抄的骨架）。
  await test('脱敏红线: 结构断言自身——花括号配对不吃窗口、负断言不认参数名', () => {
    const base = [
      'if (require.main === module) {',
      '  runNotifyTest(cliArgs).catch(e => {',
      '    const info = summarizeError(e)',
      '    console.error(`通知自检失败：$' + '{info.message}`)',
      '    process.exitCode = 1',
      '  })',
      '}'
    ].join('\n')
    // ① 处理器加长（200 行诊断输出）：调用点被推到旧实现的 4000 字符窗口之外。
    //    旧断言在这里会假红「找不到 summarizeError(e)」，新取段不受影响。
    const padding = Array.from({ length: 200 }, (_, i) => `    console.error('  · 诊断 ${i}')`).join('\n')
    const padded = base.replace('    const info = summarizeError(e)', `${padding}\n    const info = summarizeError(e)`)
    const offset = padded.indexOf('summarizeError(e)') - padded.indexOf('require.main === module')
    assert.ok(offset > 4000, `夹具必须真的把调用点推到 4000 之外（实际 ${offset}）`)
    assert.ok(guardHandlerBodyOf(padded, GUARD_CATCH_ANCHOR).includes('summarizeError(e)'),
      '处理器变长后仍必须取到 summarizeError —— 旧实现的魔数窗口在这里假红')
    // ② 参数改名 + 换打印函数：旧的两条词法负断言（JSON.stringify(e) / console.log(e)）都放行。
    const renamed = base
      .replace('.catch(e => {', '.catch(err => {')
      .replace('summarizeError(e)', 'summarizeError(err)')
      .replace('    console.error(`通知自检失败', '    console.warn(JSON.stringify(err))\n    console.error(`通知自检失败')
    const renamedBody = guardHandlerBodyOf(renamed, GUARD_CATCH_ANCHOR)
    assert.ok(!renamedBody.includes('JSON.stringify(e)') && !/console\.log\(e\)/.test(renamedBody),
      '夹具必须绕过旧的两条词法负断言（否则这条自查没有意义）')
    assert.ok(rawErrorUsePattern('err').test(renamedBody),
      '参数改名 + console.warn(JSON.stringify(err)) 必须被参数名无关的负断言抓住')
  })

  console.log('\n----------------------------------------')
  if (failed === 0) {
    console.log(`  🎉 通知自检通过 ${passed}/${passed}`)
  } else {
    console.log(`  ⚠️ ${passed} 通过, ${failed} 失败`)
    errors.forEach(e => console.log('  ❌ ' + e))
  }
  console.log('----------------------------------------\n')
  process.exit(failed > 0 ? 1 : 0)
})().catch(e => { console.error(e); process.exitCode = 1 })
