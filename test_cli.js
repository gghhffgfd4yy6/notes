'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')
const path = require('path')

const entry = path.join(__dirname, 'qinglong', 'xbk_push.js')

// 旧口径断言「--check 必然失败」，只在缺 re2/通知配置的环境成立（CI 绿、配置齐全的开发机必红）。
// 改为环境无关的契约断言：①诊断输出必须包含三类检查项；②退出码与实际失败项数一致（有 ❌ ⇒ 1，全 ✅ ⇒ 0）。
// re2 缺失拒绝启动的路径已由 test_loop.js 的 ensureDependencies 注入用例确定性地覆盖。
const checkRun = spawnSync(process.execPath, [entry, '--check'], {
  cwd: __dirname,
  encoding: 'utf8',
  env: { ...process.env, XBK_AUTO_INSTALL_DEPS: '' },
  timeout: 10000,
  stdio: ['ignore', 'pipe', 'pipe']
})
const checkOutput = `${checkRun.stdout || ''}${checkRun.stderr || ''}`
for (const label of ['Node.js 版本', 're2 原生模块', '通知通道']) {
  assert.ok(checkOutput.includes(label), `--check 诊断输出应包含「${label}」检查项（实际输出：${JSON.stringify(checkOutput)}）`)
}
const failedItems = checkOutput.split('\n').filter(line => line.includes('❌'))
assert.strictEqual(
  checkRun.status,
  failedItems.length > 0 ? 1 : 0,
  `--check 退出码必须与诊断结论一致（${failedItems.length} 项失败），实际 status=${checkRun.status}`
)

const source = require('fs').readFileSync(entry, 'utf8')
assert.match(source, /--dry-run/)
assert.match(source, /--check/)
assert.match(source, /--status/)
assert.ok(/if\s*\(\s*hasArg\(\s*['"]--dry-run['"]\s*\)\s*\)[\s\S]*ensureDependencies\s*\(\s*\)[\s\S]*const\s+app\s*=\s*loadApp\s*\(\s*\)/.test(source), '常驻入口必须先检查依赖，再加载会引入 got 的应用')

const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-cli-'))
const previousCwd = process.cwd()
try {
  process.chdir(statusDir)
  fs.writeFileSync('report.state', JSON.stringify({ date: '2026-09-05', runs: 1, total: 2, dedup: 0, filtered: 0, pushed: 2, failed: 0, truncated: 0 }))
  const before = fs.statSync('report.state').mtimeMs
  const statusRun = spawnSync(process.execPath, [entry, '--status'], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: statusDir } })
  assert.strictEqual(statusRun.status, 0, '--status 应独立于 got/re2 成功退出')
  assert.match(statusRun.stdout, /xbk-push 运行状态/)
  assert.match(statusRun.stdout, /推送成功：2 条/)
  assert.strictEqual(fs.statSync('report.state').mtimeMs, before, '--status 不得写状态文件')
} finally {
  process.chdir(previousCwd)
  fs.rmSync(statusDir, { recursive: true, force: true })
}

const dryRun = spawnSync(process.execPath, ['-e', `process.env.XBK_DRY_RUN = '1'; const app = require(${JSON.stringify(path.join(__dirname, 'xbk_function_v3.js'))}); const result = app.App; if (!result || typeof result.run !== 'function') process.exit(2)`], { cwd: __dirname, encoding: 'utf8' })
assert.strictEqual(dryRun.status, 0, 'dry-run 环境变量应能加载主模块')

// ── 批次④ 4.1：--notify-test spawn 型用例（全部带桩，绝不裸跑真推——D10）──
// 桩形态：NODE_OPTIONS --require 预加载（test_utils_pure.js preload 变体）：hook fs 全部写
// 方法（收集清单，零白名单放行）+ require.cache 替身替换 slim（真 slim 永不加载 → 零真实推送）。
// fake sendNotify 按 XBK_TEST_NOTIFY_FAKE_MODE 返回 ok / 抛 ALL_CHANNELS_FAILED / 抛
// NO_CHANNEL_CONFIG；结果经 exit 钩子以 __NOTIFY_PROBE__ JSON 打到 stderr。
const notifyStubPath = (() => {
  const stub = `'use strict'
const path = require('path')
const WRITE_METHODS = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'copyFileSync', 'rmSync', 'unlinkSync', 'writeSync', 'ftruncateSync', 'chmodSync', 'lchownSync', 'chownSync', 'utimesSync', 'writevSync']
const writes = []
const fsMod = require('fs')
for (const m of WRITE_METHODS) {
  const orig = fsMod[m]
  fsMod[m] = function (...a) { writes.push(m); return orig.apply(fsMod, a) }
}
const openSyncOrig = fsMod.openSync
fsMod.openSync = function (p, flags, ...rest) {
  if (typeof flags === 'string' && /[wa]/.test(flags[0])) writes.push('openSync(' + flags + ')')
  return openSyncOrig.call(fsMod, p, flags, ...rest)
}
const mode = process.env.XBK_TEST_NOTIFY_FAKE_MODE || 'ok'
const sendCalls = []
const sendArgs = []
const fakePushConfig = { HITOKOTO: process.env.XBK_TEST_HITOKOTO_SAVED || 'true' }
const fakeSlim = {
  push_config: fakePushConfig,
  configuredChannelNames: () => ['桩渠道A', '桩渠道B'],
  configuredChannelCount: () => 2,
  sendNotify: async (text, desp, params) => {
    sendCalls.push(1)
    sendArgs.push({ text, desp, hitokotoAtCall: fakePushConfig.HITOKOTO, hasParams: params && typeof params === 'object' })
    if (mode === 'ok') return { successfulChannels: ['桩渠道A', '桩渠道B'], failures: [] }
    if (mode === 'partial') return { successfulChannels: ['桩渠道A'], failures: [{ channel: '桩渠道B', message: 'redacted-原因（已脱敏）', statusCode: 500 }] }
    if (mode === 'allfail') {
      const err = new Error('所有推送通道失败: redacted-原因')
      err.code = 'ALL_CHANNELS_FAILED'
      err.failures = [{ channel: '桩渠道A', message: 'redacted-原因', statusCode: 502 }]
      err.successfulChannels = []
      throw err
    }
    const err = new Error('未配置任何推送通道（Push+/Server酱/Bark/企业微信/wxpusher/息知/PushDeer/PushMe/Telegram）')
    err.code = 'NO_CHANNEL_CONFIG'
    throw err
  }
}
const slimPath = path.join(process.cwd(), 'xbk_sendNotify_slim.js')
require.cache[slimPath] = { id: slimPath, filename: slimPath, loaded: true, exports: fakeSlim }
process.on('exit', () => {
  process.stderr.write('__NOTIFY_PROBE__' + JSON.stringify({ writes, sendCalls: sendCalls.length, sendArgs }) + '\\n')
})
`
  const p = path.join(os.tmpdir(), `xbk-notify-stub-${process.pid}.js`)
  fs.writeFileSync(p, stub)
  return p
})()

function runNotifyTestSpawn (extraArgs, fakeMode) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${notifyStubPath}`].filter(Boolean).join(' ')
  return spawnSync(process.execPath, [path.join(__dirname, 'xbk_function_v3.js'), '--notify-test', ...(extraArgs || [])], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, XBK_TEST_NOTIFY_FAKE_MODE: fakeMode || 'ok', NODE_OPTIONS: nodeOptions },
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function probeOf (run) {
  const merged = `${run.stdout || ''}${run.stderr || ''}`
  const m = /__NOTIFY_PROBE__(\{.*\})/.exec(merged)
  assert.ok(m, '子进程应输出 __NOTIFY_PROBE__ 探针')
  return JSON.parse(m[1])
}

// C1 零写 + 单次广播 + 成功形态
{
  const run = runNotifyTestSpawn([], 'ok')
  assert.strictEqual(run.status, 0, `mode=ok 应退出 0（实际输出：${run.stdout}${run.stderr}）`)
  const probe = probeOf(run)
  assert.strictEqual(probe.writes.length, 0, `自检路径必须严格零写（实际：${probe.writes.join(',')}）`)
  assert.strictEqual(probe.sendCalls, 1, 'sendNotify 必须恰好调用一次（单次广播）')
  assert.strictEqual(probe.sendArgs[0].text, 'xbk-push 通知自检', '标题固定')
  assert.ok(probe.sendArgs[0].hasParams, 'sendNotify 应收到 Pusher 传入的 params（真 Pusher 包装层）')
  assert.ok((run.stdout || '').includes('通知自检完成：成功 2 个渠道'), '应输出汇总行')
  assert.ok((run.stdout || '').includes('✅ 桩渠道A'), '应列出成功渠道')
}
// C2 互斥（spawn 级）
{
  const run = runNotifyTestSpawn(['--dry-run'], 'ok')
  assert.strictEqual(run.status, 1, '互斥应退出 1')
  const probe = probeOf(run)
  assert.strictEqual(probe.sendCalls, 0, '互斥路径零发送')
  assert.ok(`${run.stdout || ''}${run.stderr || ''}`.includes('互斥'), '应输出互斥文案')
}
// C3 全失败 → 1，失败路径也零写
{
  const run = runNotifyTestSpawn([], 'allfail')
  assert.strictEqual(run.status, 1, '全失败应退出 1')
  const probe = probeOf(run)
  assert.strictEqual(probe.writes.length, 0, '失败路径也必须零写')
  const merged = `${run.stdout || ''}${run.stderr || ''}`
  assert.ok(merged.includes('通知自检失败'), '应输出失败结论')
  assert.ok(merged.includes('redacted-原因'), '应含脱敏原因')
  assert.ok(merged.includes('❌ 桩渠道A'), '应列出失败渠道')
  assert.ok(!merged.includes('[object Object]'), '不得有对象 stringify 痕迹')
}
// C4 无渠道 → 1
{
  const run = runNotifyTestSpawn([], 'nochan')
  assert.strictEqual(run.status, 1, '无渠道应退出 1')
  assert.ok(`${run.stdout || ''}${run.stderr || ''}`.includes('未配置任何推送通道'), '应含 NO_CHANNEL_CONFIG 文案')
}
// C5 退出码 0 时无抓取痕迹（佐证早退未走 runSingleEntry）
{
  const run = runNotifyTestSpawn([], 'ok')
  const merged = `${run.stdout || ''}${run.stderr || ''}`
  assert.ok(!merged.includes('dry-run 单轮'), '不得出现 dry-run 单轮摘要')
  assert.ok(!/共 \d+ 条/.test(merged), '不得出现抓取统计（runSingleEntry 痕迹）')
}
fs.rmSync(notifyStubPath, { force: true })

console.log('✅ 青龙命令行：--check 诊断与 --dry-run 参数已接入')
