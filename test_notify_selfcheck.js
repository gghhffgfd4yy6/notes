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
const { loadModel } = require('./test_support/source_model')
const {
  findAll, findFirst, ifChain, memberPath, callSites, hasCallWithLiteral, hasCallWithIdentifier, parseText
} = require('./test_support/ast_query')

// Stryker 插桩判定（与 test_state_schema.js 的 instrumentedModel 同口径）：AST 里出现 `stryMutAct_*`
// 标识符即说明这份源码已被插桩。判据只看**标识符节点**，不读源码文本——本文件刚把文本断言换成 AST，
// 再用 indexOf('stryMutAct_') 读原文等于开倒车（闸门也会记一条源码文本断言）。
function instrumentedModel (model) {
  return findAll(model, (node) => node.type === 'Identifier' && node.name.startsWith('stryMutAct_')).length > 0
}

// ── S1 前置：入口分发结构断言（AST 结构，S3 替换源码文本序断言）──
// 旧写法在 xbk_function_v3.js 的源码文本里 indexOf('require.main === module') /
// "'--notify-test'" / 'runNotifyTest(cliArgs)' / 'runSingleEntry().catch'，再比这些下标的相对大小。
// 两个问题：① 结论取决于文本顺序，与「早退分支不被吞掉」只是碰巧同构——注释里抄一遍这些片段，
// 或把分发提成函数换个写法，断言给的答案就和真实结构无关；② 格式化/插桩改变下标，假红。
// 现在直接读 if (require.main === module) 的 AST，分发链必须依次是
//   ① if (notifyArg) { runNotifyTest(cliArgs).catch(…) }                       ← 自检最先分发
//   ② else if (cliArgs.some(a => …)) { console.error(未识别参数…); exitCode = 1 } ← fail-closed
//   ③ else { runSingleEntry().catch(…) }                                        ← 完整入口只在最后一支
// 「runSingleEntry 只在最后一支、且该调用挂 .catch」就是旧断言（`indexOf('runSingleEntry().catch')` 的
// 相对位置）守的两件事，现在由分支结构 + 调用链形态表达，而不是比下标。

// **变异沙箱兼容（S3 round2）**：Stryker 会把 `if (require.main === module)` 的 test 整条包成
// ConditionalExpression（实测 `} else if (stryMutAct_9fa48("570") ? require.main !== module :
// stryMutAct_… ? true : (stryCov_…, require.main === module)) {`），下面的 findFirst 要求
// `test.type === 'BinaryExpression'` ⇒ mainGuard === null、首条 assert.ok 直接抛错 ⇒ 本文件 9 条
// 行为用例一条都跑不到（沙箱 initial test run 红、整段中止）。这是「源码形状判据 vs 插桩形态」的
// 固有冲突，不是生产逻辑问题：插桩时整块跳过并打印一行 SKIP，普通运行的判据逐条不变（一行未改）。
// 入口语义的行为面由同文件 S6/S6b 的真 main-guard spawn 用例与 test_cli.js 兜底。
const entryModel = loadModel('xbk_function_v3.js')
if (instrumentedModel(entryModel)) {
  // 只跳过这一块源码形状断言：下面 9 条行为用例照常跑（它们在插桩前本就跑得到）。
  console.log('SKIP 入口分发结构断言（Stryker 沙箱内源码已插桩）')
} else {
  const mainGuard = findFirst(entryModel, (node) =>
    node.type === 'IfStatement' && node.test.type === 'BinaryExpression' && node.test.operator === '===' &&
    memberPath(node.test.left) === 'require.main' && node.test.right.type === 'Identifier' && node.test.right.name === 'module')
  assert.ok(mainGuard, 'xbk_function_v3.js 必须有 if (require.main === module) 直跑入口')
  {
    // 分发链 = guard 块的最后一条语句（前面是 cliArgs / notifyArg 的准备语句）。
    const guardedBlock = mainGuard.consequent
    const dispatch = guardedBlock.body[guardedBlock.body.length - 1]
    assert.strictEqual(dispatch.type, 'IfStatement', 'guard 内必须有 if/else 分发链（否则直跑入口没有分流）')
    const arms = ifChain(dispatch)
    assert.ok(arms.length >= 3, `分发链至少三支（notify-test / 未识别参数 / 完整入口），实际 ${arms.length}`)

    // ① 自检分支：第一支、条件读 notifyArg、体内 runNotifyTest(cliArgs) 的返回必须挂 .catch
    assert.strictEqual(arms[0].test.type, 'Identifier', '第一支必须以 notifyArg 为条件（notify-test 必须最先分发）')
    assert.strictEqual(arms[0].test.name, 'notifyArg')
    const notifyCall = callSites(arms[0].consequent, 'runNotifyTest')[0]
    assert.ok(notifyCall, 'notify-test 分支必须调用 runNotifyTest（不得静默进完整入口）')
    assert.ok(notifyCall.arguments.length === 1 && notifyCall.arguments[0].type === 'Identifier' && notifyCall.arguments[0].name === 'cliArgs',
      'runNotifyTest 必须收到 cliArgs（原样转发未消费的参数）')
    const chainedNotify = findAll(arms[0].consequent, (node) =>
      node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' && node.callee.property.name === 'catch' &&
      node.callee.object.type === 'CallExpression' && memberPath(node.callee.object.callee) === 'runNotifyTest')
    assert.strictEqual(chainedNotify.length, 1, 'runNotifyTest 的返回必须挂 .catch（否则自检失败会变成 unhandled rejection）')

    // ② 未知 -- 参数：fail-closed（报错 + exitCode=1），且绝不得踏进任何入口
    const unknownArm = arms.find((arm) => arm.test && callSites(arm.test, 'cliArgs.some').length > 0)
    assert.ok(unknownArm, '分发链必须有「未知 -- 参数」分支（否则拼错的参数会静默跑一轮）')
    const setsFailure = unknownArm.consequent.body.some((stmt) =>
      stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression' &&
      memberPath(stmt.expression.left) === 'process.exitCode' && stmt.expression.right.type === 'Literal' && stmt.expression.right.value === 1)
    assert.ok(setsFailure, '未识别参数分支必须把 process.exitCode 设为 1（fail-closed）')
    assert.strictEqual(callSites(unknownArm.consequent, 'runSingleEntry').length, 0, '未识别参数分支绝不得进完整入口')
    assert.strictEqual(callSites(unknownArm.consequent, 'runNotifyTest').length, 0, '未识别参数分支不得被当成自检')
    // 用户可见文案：从该分支的 console.error 取模板串（不是全文件文本匹配——注释里的同名字样不算证据）
    const errCall = callSites(unknownArm.consequent, 'console.error')[0]
    assert.ok(errCall, '未识别参数分支必须经 console.error 报错（不得静默退 1）')
    const errText = errCall.arguments[0] && errCall.arguments[0].type === 'TemplateLiteral'
      ? errCall.arguments[0].quasis.map((q) => q.value.cooked).join('…')
      : ''
    assert.match(errText, /未识别参数/, `错误文案必须点名「未识别参数」（实际：${errText}）`)

    // ③ 完整入口只在最后 else 支，且该调用必须挂 .catch
    // 旧断言是 `indexOf('runSingleEntry().catch') > indexOf('runNotifyTest(cliArgs)')`——它同时守住两件事：
    // 「完整入口落在最后 else 支」与「调用挂 .catch」。只数「guard 里有 1 次 runSingleEntry」会同时丢掉这两条：
    // 改成裸 `runSingleEntry()`（错误变 unhandled rejection、绕开 summarizeError 脱敏出口）仍绿；
    // 把它挪进 notify 分支、最后 else 留空也仍绿。故这里逐条表达：else 支内恰 1 次、整条 guard 恰 1 次
    // （= 别处没有第二份入口）、且那次调用正是某个 `.catch(…)` 的被调对象（与上面 chainedNotify 判法对称）。
    const entryArm = arms[arms.length - 1]
    assert.strictEqual(entryArm.test, null, '分发链最后必须是 else（完整入口）')
    const entryCalls = callSites(entryArm.consequent, 'runSingleEntry')
    assert.strictEqual(entryCalls.length, 1,
      'runSingleEntry 完整入口必须在最后 else 支恰调用一次（早退语义：其它分支一律不得进完整入口）')
    assert.strictEqual(callSites(guardedBlock, 'runSingleEntry').length, 1,
      'runSingleEntry 在整条 guard 里只能出现一次（挪进 notify 分支 / 复制第二份都算破坏早退语义）')
    const chainedEntry = findAll(entryArm.consequent, (node) =>
      node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' && node.callee.property.name === 'catch' &&
      node.callee.object === entryCalls[0])
    assert.strictEqual(chainedEntry.length, 1,
      'runSingleEntry(...) 的返回必须挂 .catch(...)（否则入口失败会变成 unhandled rejection、绕开 summarizeError 脱敏出口）')
    const entryHandler = chainedEntry[0].arguments[0]
    assert.ok(entryHandler && (entryHandler.type === 'ArrowFunctionExpression' || entryHandler.type === 'FunctionExpression'),
      '.catch 的实参必须是函数（失败处理逻辑不得被内联丢弃）')

    // --notify-test=1 这类近似写法必须前缀分发到自检（审查 D2-M2 / #232）
    const notifyArgDecl = findAll(guardedBlock, (node) => node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'notifyArg')
    assert.strictEqual(notifyArgDecl.length, 1, '分发链必须先把 notify-test 参数挑出来（notifyArg）')
    const picker = notifyArgDecl[0].init
    assert.strictEqual(picker.type, 'CallExpression', 'notifyArg 必须由一次查找得到')
    assert.strictEqual(memberPath(picker.callee), 'cliArgs.find', 'notifyArg 必须从 cliArgs 里挑（find）')
    assert.ok(hasCallWithLiteral(picker, 'a.startsWith', 0, '--notify-test='),
      '--notify-test=1 必须前缀分发到自检（否则近似写法会静默落进完整入口）')
    assert.ok(findAll(picker, (node) => node.type === 'Literal' && node.value === '--notify-test').length >= 1,
      '精确写法 --notify-test 也必须由同一处挑出来')
  }
}

// ── S8：guard catch 处理器的结构视图（S3 替换源码文本取段）──────────────────
// 旧实现从源码文本里按锚点 + 花括号配对切一段字符串，再用正则判「有没有 summarizeError(e) /
// 有没有 console.log(e)」：锚点 `runNotifyTest(cliArgs).catch(` 在纯格式重排后变成
// `runNotifyTest (cliArgs).catch (` ⇒ 整条用例假红（probe-format-coupling 实测），而往注释里抄一遍
// 锚点与禁用样例又能让它假绿（剥注释那套逻辑只对切出来的段生效，锚点本身仍可被注释命中）。
// 现在整段改成 AST：定位 `.catch(...)` 调用点、取处理器节点、在**处理器子树**里查调用与实参，
// 注释与排版一律不参与判定；判据仍然按形参名字走（与形参叫 e 还是 err 无关）。
const RAW_ERROR_SINKS = /^(?:console\.\w+|JSON\.stringify|String|util\.inspect|inspect)$/

// 取 `runNotifyTest(…).catch(<handler>)` 的处理器节点（全文件必须恰一处）。
function notifyCatchHandlerOf (source) {
  const chained = findAll(source, (node) =>
    node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
    node.callee.property.type === 'Identifier' && node.callee.property.name === 'catch' &&
    node.callee.object.type === 'CallExpression' && memberPath(node.callee.object.callee) === 'runNotifyTest')
  assert.strictEqual(chained.length, 1, `guard 必须恰有一处 runNotifyTest(…).catch(…)（实际 ${chained.length} 处）`)
  const handler = chained[0].arguments[0]
  assert.ok(handler && (handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression'),
    'catch 的实参必须是函数（失败处理逻辑不得被内联丢弃）')
  assert.strictEqual(handler.params.length, 1, 'catch 处理器必须带一个具名实参（下面的判据按它的名字走）')
  assert.strictEqual(handler.params[0].type, 'Identifier', 'catch 处理器的实参必须是裸标识符')
  return { handler, param: handler.params[0].name }
}

// 「把原始 error 直接交给打印/序列化」：console.X(e) / JSON.stringify(e) / String(e) /
// util.inspect(e) / inspect(e)。判据看**调用实参是不是处理器形参**，与形参叫什么无关。
function rawErrorUsesIn (handler, param) {
  return findAll(handler, (node) =>
    node.type === 'CallExpression' && RAW_ERROR_SINKS.test(String(memberPath(node.callee))) &&
    node.arguments.some((arg) => arg.type === 'Identifier' && arg.name === param))
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

  // S8 脱敏红线：guard catch 的**结构断言**（summarizeError 在、原始 error 不得进打印/序列化）。
  // 行为侧的脱敏红线由 S6 的真 guard spawn 兜底（凭证/ANSI/OSC 零出现）——
  // 两条一起才能同时挡住「改文案」与「换个函数名打印」。
  await test('脱敏红线: guard catch 走 summarizeError、原始 error 不得进打印/序列化', () => {
    const { handler, param } = notifyCatchHandlerOf(entryModel)
    const body = handler.body
    const statements = body.type === 'BlockStatement' ? body.body : [body]
    // 「真的取到处理器体」的完整性自检。Stryker 插桩会把整个处理器体包成一条
    // `if (stryMutAct_…) {} else { …原始语句… }`（实测语句数 1）⇒ 「语句数 > 1」在沙箱内按定义不成立。
    // 解包这一层只在**确认插桩时**生效（AST 标识符判定，见 instrumentedModel），解包后仍要求原始语句 > 1；
    // 普通运行 statements 原样使用，判据逐字节不变。三条负断言照旧在整棵 body 上跑（包装层不引入
    // console.*/JSON.stringify，实参也不是形参本身）。
    const instrumentedWrapper = instrumentedModel(entryModel) && statements.length === 1 &&
      statements[0].type === 'IfStatement' && statements[0].alternate && statements[0].alternate.type === 'BlockStatement'
    const handlerStatements = instrumentedWrapper ? statements[0].alternate.body : statements
    assert.ok(handlerStatements.length > 1, `必须真的取到 guard catch 处理器体（实际 ${handlerStatements.length} 条语句）`)
    assert.ok(hasCallWithIdentifier(body, 'summarizeError', 0, param),
      `guard catch 必须过 summarizeError(${param})`)
    // 负断言一：catch 里只允许 console.error（错误流）。console.log/warn/info/debug 会把 stdout
    // 当成正常输出，且没有对象打印的正当理由——按**被调名集合**判，不按文本片段判。
    const consoleSinks = [...new Set(findAll(body, (node) =>
      node.type === 'CallExpression' && /^console\.\w+$/.test(String(memberPath(node.callee))))
      .map((call) => memberPath(call.callee)))]
    assert.deepStrictEqual(consoleSinks.filter((name) => name !== 'console.error'), [],
      'guard catch 只能走 console.error（错误流）——console.log 会把 stdout 当成正常输出')
    // 负断言二：任何 JSON.stringify 都不许进 catch（error.options/response 可能带 URL query 凭证）。
    assert.strictEqual(callSites(body, 'JSON.stringify').length, 0,
      'guard catch 禁止任何 JSON.stringify（error.options/response 带凭证）')
    // 负断言三：原始 error 不得直接交给打印/序列化入口（形参改名绕不过去）。
    assert.deepStrictEqual(rawErrorUsesIn(body, param).map((call) => memberPath(call.callee)), [],
      `guard catch 不得把原始 error 直接交给打印/序列化（形参 ${param}）`)
  })

  // 守住上面那条断言自己：判据必须对「真实维护动作」成立，否则红线随时静默失效。
  // 两个夹具都是不对仓库做任何改动的合成源码（照原实现抄的骨架），用同一套 acorn 解析器喂给
  // 同一组判定函数——测的是判据本身，不是夹具的排版。
  await test('脱敏红线: 结构断言自身——处理器变长不吃窗口、负断言不认参数名', () => {
    const base = [
      'if (require.main === module) {',
      '  runNotifyTest(cliArgs).catch(e => {',
      '    const info = summarizeError(e)',
      '    console.error(`通知自检失败：$' + '{info.message}`)',
      '    process.exitCode = 1',
      '  })',
      '}'
    ].join('\n')
    const baseCase = notifyCatchHandlerOf(parseText(base, '夹具/base'))
    assert.strictEqual(baseCase.param, 'e', '夹具：形参名必须来自 AST（不是猜的）')
    assert.ok(hasCallWithIdentifier(baseCase.handler.body, 'summarizeError', 0, 'e'),
      '夹具：合法处理器必须能取到 summarizeError(e)')
    assert.deepStrictEqual(rawErrorUsesIn(baseCase.handler.body, 'e'), [], '夹具：合法出口不得被误判成原始 error 泄漏')
    // ① 处理器加长 200 行诊断输出：旧实现按 4000 字符窗口取段会假红「找不到 summarizeError」。
    const padding = Array.from({ length: 200 }, (_, i) => `    console.error('  · 诊断 ${i}')`).join('\n')
    const padded = base.replace('    const info = summarizeError(e)', `${padding}\n    const info = summarizeError(e)`)
    assert.ok(padded.length - base.length > 4000,
      `夹具必须真的把处理器撑长 4000 字符以上（实际 +${padded.length - base.length}）`)
    const paddedCase = notifyCatchHandlerOf(parseText(padded, '夹具/padded'))
    assert.ok(hasCallWithIdentifier(paddedCase.handler.body, 'summarizeError', 0, 'e'),
      '处理器变长后仍必须取到 summarizeError —— 旧实现的魔数窗口在这里假红')
    // ② 参数改名 + 换打印函数：旧的两条词法负断言（JSON.stringify(e) / console.log(e)）都放行。
    const renamed = base
      .replace('.catch(e => {', '.catch(err => {')
      .replace('summarizeError(e)', 'summarizeError(err)')
      .replace('    console.error(`通知自检失败', '    console.warn(JSON.stringify(err))\n    console.error(`通知自检失败')
    const renamedCase = notifyCatchHandlerOf(parseText(renamed, '夹具/renamed'))
    assert.strictEqual(renamedCase.param, 'err', '夹具：形参改名后判据必须跟着形参名走')
    assert.deepStrictEqual(rawErrorUsesIn(renamedCase.handler.body, 'err').map((call) => memberPath(call.callee)),
      ['JSON.stringify'],
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
