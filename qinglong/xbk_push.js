'use strict'

// 青龙面板直接执行入口：不依赖当前工作目录，配置/缓存仍统一放在项目根目录。
const path = require('path')
const { spawnSync } = require('child_process')
const { runLoop, sleep } = require('../xbk_loop')
const { classifyFailure, classifySummary, summarizeError } = require('../xbk_failure_policy')

const ROOT = path.resolve(__dirname, '..')
const ARGS = new Set(process.argv.slice(2))

function hasArg (name) {
  return ARGS.has(name)
}

function loadApp () {
  try { return require('../xbk_function_v3') } catch (error) {
    const dependency = error && error.code === 'MODULE_NOT_FOUND' && /got/.test(error.message)
    if (dependency) throw new Error(`got 依赖不可加载；请先执行 npm ci --omit=dev --ignore-scripts（原始错误：${error.message}）`)
    throw error
  }
}

function runCheck (app) {
  const checks = []
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  }
  add('Node.js 版本', Number(process.versions.node.split('.')[0]) >= 22, process.version)
  try {
    require('got')
    add('got 依赖', true, '可加载')
  } catch (e) { add('got 依赖', false, '不可加载') }
  try {
    const RE2 = require('re2')
    const probe = new RE2('^ok$')
    add('re2 原生模块', probe.test('ok'), '可加载且匹配正常')
  } catch (e) { add('re2 原生模块', false, '不可加载，过滤正则不会安全执行') }
  const warnings = app.validateConfig({ ...app.Config.filter, zkt_gjc: app.Config.keyword.zkt_gjc })
  add('过滤配置', warnings.length === 0, warnings.length ? `${warnings.length} 条警告` : '合法')
  try {
    app.init()
    add('缓存目录', true, app.Config.cache.dir)
  } catch (e) { add('缓存目录', false, e.message) }
  const notify = require(path.join(ROOT, 'xbk_sendNotify_slim'))
  const count = typeof notify.configuredChannelCount === 'function' ? notify.configuredChannelCount() : 0
  add('通知通道', count > 0, count > 0 ? `${count} 个可用通道` : '未检测到完整通道配置')
  return checks.every(item => item.ok) ? 0 : 1
}

function shouldAutoInstallDependencies (env = process.env) {
  return env && env.XBK_AUTO_INSTALL_DEPS === '1'
}

// got 是主 HTTP 依赖；re2 则是用户过滤规则的安全执行引擎。
// 安装命令刻意使用 --ignore-scripts 防供应链风险，但这也会跳过 re2 原生模块构建；
// 因此必须显式构建并加载校验，不能只因 got 可用就带着“所有正则规则被跳过”的状态启动。
function ensureDependencies ({ requireFn = require, spawnSyncFn = spawnSync, env = process.env } = {}) {
  // 固定依赖路径：入口不会将外部输入拼入模块或构建路径。
  const gotPath = path.join(ROOT, 'node_modules', 'got')
  const re2Path = path.join(ROOT, 'node_modules', 're2')
  const load = (name, modulePath) => {
    try {
      // 不只检查 require.resolve：got 的传递依赖、re2 的原生 .node 缺失时，真正 require 才能发现。
      requireFn(modulePath)
      return null
    } catch (error) {
      return error
    }
  }
  const isRecoverable = (error) => error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_DLOPEN_FAILED')
  const initial = { got: load('got', gotPath), re2: load('re2', re2Path) }
  if (!initial.got && !initial.re2) return
  const initialError = initial.got || initial.re2
  // 缺模块与原生 ABI/平台不匹配都可通过重新安装/构建恢复；其余运行时错误不掩盖。
  if (!isRecoverable(initialError)) throw initialError
  if (!shouldAutoInstallDependencies(env)) {
    const failed = initial.got ? 'got' : 're2'
    throw new Error(`检测到 ${failed} 依赖或原生模块未完整安装；请在部署阶段依次执行：npm ci --omit=dev --ignore-scripts && npm run rebuild --prefix node_modules/re2。如确需在本次运行时安装，请显式设置 XBK_AUTO_INSTALL_DEPS=1`)
  }
  console.warn('检测到 Node.js 依赖或 re2 原生模块未完整安装，已按 XBK_AUTO_INSTALL_DEPS=1 执行恢复...')

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const install = spawnSyncFn(npm, [
    'install',
    '--production',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix', ROOT
  ], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`npm install 失败，退出码 ${install.status}`)

  // 仅当安装后 re2 仍无法加载才构建：单纯 got 缺失但 re2 正常时，不要求无关的 C++ 构建环境。
  const re2AfterInstall = load('re2', re2Path)
  if (re2AfterInstall) {
    if (!isRecoverable(re2AfterInstall)) throw re2AfterInstall
    const rebuild = spawnSyncFn(npm, [
      'run', 'rebuild', '--prefix', re2Path
    ], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
    if (rebuild.error) throw rebuild.error
    if (rebuild.status !== 0) throw new Error(`re2 原生模块构建失败，退出码 ${rebuild.status}`)
  }

  const recovered = { got: load('got', gotPath), re2: load('re2', re2Path) }
  if (recovered.got || recovered.re2) {
    const failed = recovered.got ? 'got' : 're2'
    const error = recovered[failed]
    throw new Error(`依赖恢复后 ${failed} 仍不可用：${error && error.message ? error.message : String(error)}`)
  }
}

function intervalMs (num) {
  const value = num(process.env.XBK_INTERVAL_MS, 10000)
  return Number.isFinite(value) && value >= 0 ? value : 10000
}

function refreshCount (app) {
  const limit = app.num(app.Config && app.Config.push && app.Config.push.parallelLimit, -1)
  const maxPerRun = app.num(app.Config && app.Config.push && app.Config.push.maxPerRun, -1)
  const window = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 10
  const batch = Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : 100
  return Math.max(1, Math.min(window, batch, 3))
}

async function refreshConnections (app, signal) {
  if (signal && signal.aborted) return
  const agents = require(path.join(ROOT, 'xbk_agents'))
  const notify = require(path.join(ROOT, 'xbk_sendNotify_slim'))
  const hasWxPusher = Boolean(notify && typeof notify.hasWxPusherConfigured === 'function' &&
        notify.hasWxPusherConfigured())
  const apiHost = (() => {
    try { return new URL(app.Config.api.pushUrl).hostname } catch (e) { return '' }
  })()
  const wxHost = 'wxpusher.zjiecode.com'
  const tasks = []
  if (apiHost) tasks.push(agents.prewarmDns(apiHost, signal))
  if (hasWxPusher) {
    tasks.push(agents.prewarmDns(wxHost, signal))
    tasks.push(agents.prewarmTls(wxHost, 5000, refreshCount(app), signal))
  }
  const results = await Promise.all(tasks)
  if (!(signal && signal.aborted)) {
    const dnsResults = results.filter(r => r && Object.prototype.hasOwnProperty.call(r, 'hostname'))
    const tls = results.find(r => r && Object.prototype.hasOwnProperty.call(r, 'okCount'))
    console.log(`常驻连接刷新完成：DNS ${dnsResults.filter(r => r.ok).length}/${dnsResults.length}，TLS ${tls ? `${tls.okCount}/${tls.count}` : '跳过'}`)
  }
}

let residentExitCode = 0
let consecutiveRetryableFailures = 0
// v3.270：可重试失败退避上限。旧「连续 3 轮可重试错误即退出常驻」在 DNS/网络/上游 5xx 等
// 可恢复故障下依赖外部重启器兜底，青龙未配置失败自动重启时会永久停摆、后续全部漏推。
// 现改为进程内指数退避持续重试（默认 30 分钟封顶），仅不可恢复（permanent）错误退出。
const DEFAULT_RETRY_BACKOFF_CAP_MS = 30 * 60 * 1000

function retryBackoffMs (count, env = process.env) {
  const capRaw = Number(env && env.XBK_RETRY_BACKOFF_CAP_MS)
  const cap = Number.isFinite(capRaw) && capRaw >= 1 ? capRaw : DEFAULT_RETRY_BACKOFF_CAP_MS
  return Math.min(cap, 1000 * (2 ** (Math.min(count, 31) - 1)))
}

async function runResident (app, controller) {
  residentExitCode = 0
  consecutiveRetryableFailures = 0
  const runOnce = async () => {
    const summary = await app.run()
    const resultFailure = classifySummary(summary)
    if (resultFailure) {
      const error = new Error(resultFailure.info && resultFailure.info.message
        ? resultFailure.info.message
        : resultFailure.reason)
      error.failureKind = resultFailure.kind
      error.failureReason = resultFailure.reason
      error.failureInfo = resultFailure.info
      error.summary = summary
      throw error
    }
    consecutiveRetryableFailures = 0
    return summary
  }

  const handleFailure = async (error) => {
    const decision = classifyFailure(error)
    const info = decision.info || summarizeError(error)
    const detail = info.message || (error && error.message) || String(error)
    if (decision.kind === 'permanent') {
      residentExitCode = 1
      console.error(`本轮遇到不可恢复错误（${decision.reason}），停止常驻：${detail}`)
      controller.abort()
      return
    }

    consecutiveRetryableFailures += 1
    // v3.270：即使轮询间隔被设置为 0，失败重试也必须留出退避时间，避免快速空转打爆接口。
    // 不再「连续 3 轮退出」：指数退避持续重试，恢复成功后由 runOnce 清零，仅 permanent 错误退出。
    const backoffMs = retryBackoffMs(consecutiveRetryableFailures)
    console.error(`本轮遇到可重试错误（${decision.reason}），连续失败 ${consecutiveRetryableFailures} 次，${Math.round(backoffMs / 1000)}s 后重试：${detail}`)
    await sleep(backoffMs, controller.signal)
  }

  await runLoop(runOnce, {
    intervalMs: intervalMs(app.num),
    refreshEvery: 10,
    signal: controller.signal,
    onInterval: ({ signal }) => refreshConnections(app, signal),
    onError: handleFailure,
    // DNS/TLS 预热只是性能优化；预热失败不能被当成业务连续失败。
    onIntervalError: async (e) => {
      console.error('常驻连接刷新失败，继续下一轮:', e && e.message ? e.message : String(e))
    }
  })
}

const { readStatus, formatStatus } = require('../scripts/status')

function statusCacheDir () {
  // --status 不加载主应用，避免缺少 got/re2 时诊断命令反而不可用。
  // 仅允许绝对路径覆盖，避免环境变量把状态读取重定向到项目目录外的任意相对位置。
  const configured = process.env.XBK_CACHE_DIR
  return configured && path.isAbsolute(configured) ? configured : path.join(ROOT, 'xianbaoku_cache')
}

function runStatus () {
  const status = readStatus(statusCacheDir())
  console.log(formatStatus(status))
  return 0
}

async function main () {
  if (hasArg('--status')) {
    try { process.exitCode = runStatus() } catch (error) {
      console.error(`❌ 状态读取失败：${error.message}`)
      process.exitCode = 1
    }
    return
  }
  if (hasArg('--check')) {
    try { require('got') } catch (error) {
      console.error(`❌ got 依赖：不可加载（${error.message}）`)
      process.exitCode = 1
      return
    }
    let app
    try { app = loadApp() } catch (error) {
      console.error(`❌ 应用模块：${error.message}`)
      process.exitCode = 1
      return
    }
    process.exitCode = runCheck(app)
    return
  }
  const app = loadApp()
  if (hasArg('--dry-run')) process.env.XBK_DRY_RUN = '1'
  ensureDependencies()
  const controller = new AbortController()
  const stop = () => controller.abort()
  // v3.262：用 process.on 而非 once——once 在首次信号后移除监听，第二次信号会走 Node
  // 默认行为直接杀进程，可能打断进行中的推送；abort 幂等，多次信号只触发一次优雅停止。
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  console.log(`青龙常驻模式启动，单轮完成后等待 ${intervalMs(app.num)}ms 再拉取`)
  try {
    await runResident(app, controller)
  } finally {
    // CodeAnt 审查建议：异常路径（ensureDependencies/require/runResident 抛错）也清理监听器，
    // 不遗留信号钩子（常驻进程随后退出，实际影响有限，但 finally 语义更稳）。
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
  if (residentExitCode !== 0) process.exitCode = residentExitCode
  console.log(residentExitCode === 0 ? '青龙常驻模式已停止' : '青龙常驻模式因不可恢复错误停止')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('青龙任务执行失败:', e && e.message ? e.message : String(e))
    process.exitCode = 1
  })
}

module.exports = { classifyFailure, classifySummary, runResident, refreshConnections, intervalMs, shouldAutoInstallDependencies, ensureDependencies, retryBackoffMs, runCheck, hasArg }
