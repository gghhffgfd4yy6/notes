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
}

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
const err = new Error('所有推送通道失败: HTTP 502 回显 token=${SECRET}')
err.code = 'ALL_CHANNELS_FAILED'
err.statusCode = 502
err.response = { body: '{"token":"${SECRET}"}', statusCode: 502 }
err.failures = [{ channel: '桩渠道A', message: 'pushplus 响应: token=${SECRET}', statusCode: 502 }]
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
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true })
    }
  })

  // S6b 退出码口径：无渠道 → NO_CHANNEL_CONFIG reject → guard 出 1（进程内复刻 guard 形态）
  await test('无渠道: NO_CHANNEL_CONFIG → 脱敏失败出口（含渠道清单文案）', () => withChannels(async () => {
    const { out } = await withCapture(async () => {
      await m.runNotifyTest(['--notify-test']).catch((e) => {
        const { summarizeError } = require('./xbk_failure_policy')
        const info = summarizeError(e)
        console.error(`通知自检失败：${info.message || '未知错误'}`)
      })
    })
    const text = outText(out)
    assertRc(text.includes('通知自检失败'), '应输出失败结论')
    assertRc(text.includes('未配置任何推送通道'), '应含 NO_CHANNEL_CONFIG 文案')
  }))

  // S8 脱敏红线：guard catch 块源码级断言（summarizeError 在、裸 stringify 不在——
  // 剥行注释后断言：注释里的「禁止 JSON.stringify(e)」守则文案本身含该字样）。
  // 插桩安全：同 S1——定位用 'require.main === module' 表达式；插桩膨胀 ~2x ⇒ 窗口 4000
  // （沙箱实测 1400 会漏掉 summarizeError(e) 调用点）。
  await test('脱敏红线: guard catch 走 summarizeError、catch 块无裸 stringify/log(e)', () => {
    const guardIdx = entrySrc.indexOf('require.main === module')
    const guardCode = entrySrc.slice(guardIdx, guardIdx + 4000).replace(/\/\/[^\n]*/g, '')
    assertRc(guardCode.includes('summarizeError(e)'), 'guard catch 必须过 summarizeError')
    assertRc(!guardCode.includes('JSON.stringify(e)'), 'guard catch 禁止 JSON.stringify(e)')
    assertRc(!/console\.log\(e\)/.test(guardCode), 'guard catch 禁止 console.log(e)')
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
