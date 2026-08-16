'use strict'

// 青龙面板直接执行入口：不依赖当前工作目录，配置/缓存仍统一放在项目根目录。
const path = require('path')
const { spawnSync } = require('child_process')
const { runLoop, sleep } = require(path.join(__dirname, '..', 'xbk_loop'))
const { classifyFailure, classifySummary, summarizeError } = require(path.join(__dirname, '..', 'xbk_failure_policy'))

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'xbk_function_v3.js')

function ensureDependencies () {
  try {
    // 不只检查 require.resolve：got 的传递依赖缺失时，真正 require 才能发现。
    require(path.join(ROOT, 'node_modules', 'got'))
    return
  } catch (e) {
    console.warn('检测到 Node.js 依赖未完整安装，正在安装 got 依赖...')
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, [
    'install',
    '--production',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix', ROOT
  ], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm install 失败，退出码 ${result.status}`)
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
const MAX_CONSECUTIVE_RETRYABLE_FAILURES = 3

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
    console.error(`本轮遇到可重试错误（${decision.reason}），连续失败 ${consecutiveRetryableFailures}/${MAX_CONSECUTIVE_RETRYABLE_FAILURES}：${detail}`)
    if (consecutiveRetryableFailures >= MAX_CONSECUTIVE_RETRYABLE_FAILURES) {
      residentExitCode = 1
      console.error(`连续 ${MAX_CONSECUTIVE_RETRYABLE_FAILURES} 轮可重试错误仍未恢复，停止常驻`)
      controller.abort()
      return
    }
    // 即使轮询间隔被设置为 0，失败重试也必须留出退避时间，避免快速空转打爆接口。
    const backoffMs = Math.min(30000, 1000 * (2 ** (consecutiveRetryableFailures - 1)))
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

async function main () {
  ensureDependencies()
  const app = require(MAIN)
  const controller = new AbortController()
  const stop = () => controller.abort()
  // v3.262：用 process.on 而非 once——once 在首次信号后移除监听，第二次信号会走 Node
  // 默认行为直接杀进程，可能打断进行中的推送；abort 幂等，多次信号只触发一次优雅停止。
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  console.log(`青龙常驻模式启动，单轮完成后等待 ${intervalMs(app.num)}ms 再拉取`)
  await runResident(app, controller)
  process.removeListener('SIGTERM', stop)
  process.removeListener('SIGINT', stop)
  if (residentExitCode !== 0) process.exitCode = residentExitCode
  console.log(residentExitCode === 0 ? '青龙常驻模式已停止' : '青龙常驻模式因连续/不可恢复错误停止')
}

if (require.main === module) {
  main().catch((e) => {
    console.error('青龙任务执行失败:', e && e.message ? e.message : String(e))
    process.exitCode = 1
  })
}

module.exports = { classifyFailure, classifySummary, runResident, refreshConnections, intervalMs }
