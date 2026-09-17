'use strict'

// 青龙面板直接执行入口：不依赖当前工作目录，配置/缓存仍统一放在项目根目录。
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { runLoop, sleep } = require('../xbk_loop')
const { classifyFailure, classifySummary, summarizeError } = require('../xbk_failure_policy')

const ROOT = path.resolve(__dirname, '..')
const ARGS = new Set(process.argv.slice(2))
// 入口只识别这三个参数；其余参数（例如拼错的 --dryrun）此前会被静默忽略并直接进入真实推送的
// 常驻模式，故先补显式告警（QX-09）；是否改为拒绝启动属产品决策（需同步未来参数口径），见 defer。
const KNOWN_ARGS = new Set(['--status', '--check', '--dry-run'])

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

// 与 package.json engines.node（>=22.22.2）对齐的版本下界：--check 的硬闸门按它判定（QX-06），
// 常驻主路径只据此告警——不硬拒启动，避免把「Node 略旧但 got/re2 都可用」的既有部署直接打断。
const MIN_NODE_VERSION = [22, 22, 2]

function isBelowMinNodeVersion (version = process.versions.node, min = MIN_NODE_VERSION) {
  const parts = String(version).split('.').map(part => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  for (let i = 0; i < min.length; i += 1) {
    const value = parts[i] || 0
    if (value !== min[i]) return value < min[i]
  }
  return false
}

// QX-06：常驻主路径此前完全不看 Node 版本，低于 engines 的环境静默运行；这里给出与 --check
// 同源的告警文案（返回 null 表示无需告警），由 main() 在进入常驻循环前打印。
function nodeVersionWarning (version = process.versions.node) {
  if (!isBelowMinNodeVersion(version)) return null
  return `⚠️ 当前 Node ${version} 低于 package.json engines 要求（>=${MIN_NODE_VERSION.join('.')}），re2 等原生依赖可能不可用`
}

function runCheck (app) {
  const checks = []
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  }
  // QX-06：闸门与 package.json engines（>=22.22.2）及 CI 矩阵（22.22.2 / 24）同口径。
  // 旧实现只看主版本（major>=22），于是 Node 22.0.0 这类低于 engines 的环境会被 --check 放行。
  const nodeOk = !isBelowMinNodeVersion()
  add('Node.js 版本', nodeOk, nodeOk
    ? process.version
    : `${process.version}（低于 package.json engines 要求的 >=${MIN_NODE_VERSION.join('.')}）`)
  try {
    require('got')
    add('got 依赖', true, '可加载')
  } catch (e) { add('got 依赖', false, `不可加载：${e && e.message ? e.message : String(e)}`) }
  try {
    const RE2 = require('re2')
    const probe = new RE2('^ok$')
    add('re2 原生模块', probe.test('ok'), '可加载且匹配正常')
  } catch (e) { add('re2 原生模块', false, `不可加载，过滤正则不会安全执行：${e && e.message ? e.message : String(e)}`) }
  const warnings = app.validateConfig({ ...app.Config.filter, zkt_gjc: app.Config.keyword.zkt_gjc })
  add('过滤配置', warnings.length === 0, warnings.length ? `${warnings.length} 条警告：${warnings.join('；')}` : '合法')
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
function ensureDependencies ({ requireFn = require, spawnSyncFn = spawnSync, env = process.env, lockExists = () => fs.existsSync(path.join(ROOT, 'package-lock.json')) } = {}) {
  // 固定依赖路径只作为兜底：入口不会将外部输入拼入模块或构建路径（两个模块名都是本文件字面量）。
  const fixedPath = (name) => path.join(ROOT, 'node_modules', name)
  const re2Path = fixedPath('re2')
  // QX-01：先按 Node 常规解析（与 --check 的 require('got')、xbk_agents.js 的 require('got') 同口径），
  // 只有解析不到时才回退固定路径。旧实现只用固定路径探测，会出现「--check 通过但应用侧解析失败」
  // 或「解析本可命中却重复安装」两套口径分裂。
  const load = (name) => {
    try {
      // 不只检查 require.resolve：got 的传递依赖、re2 的原生 .node 缺失时，真正 require 才能发现。
      requireFn(name)
      return null
    } catch (error) {
      // 仅「模块本身找不到」才回退固定路径；ERR_DLOPEN_FAILED 等说明模块已定位，回退只会得到同样结果。
      if (!error || error.code !== 'MODULE_NOT_FOUND') return error
      try {
        requireFn(fixedPath(name))
        return null
      } catch (fallbackError) {
        return fallbackError
      }
    }
  }
  const isRecoverable = (error) => error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_DLOPEN_FAILED')
  const initial = { got: load('got'), re2: load('re2') }
  if (!initial.got && !initial.re2) return
  const initialError = initial.got || initial.re2
  // 缺模块与原生 ABI/平台不匹配都可通过重新安装/构建恢复；其余运行时错误不掩盖。
  if (!isRecoverable(initialError)) throw initialError
  if (!shouldAutoInstallDependencies(env)) {
    const failed = initial.got ? 'got' : 're2'
    throw new Error(`检测到 ${failed} 依赖或原生模块未完整安装；请在部署阶段依次执行：npm ci --omit=dev --ignore-scripts && npm run rebuild --prefix node_modules/re2。如确需在本次运行时安装，请显式设置 XBK_AUTO_INSTALL_DEPS=1。（本入口刻意把 re2 定为必需依赖：缺 re2 时不会带着“过滤正则被跳过”的状态进入常驻；主应用的缺 re2 降级 + 每日提醒通道不适用于本常驻入口，需要时请改用单轮入口。）`)
  }
  console.warn('检测到 Node.js 依赖或 re2 原生模块未完整安装，已按 XBK_AUTO_INSTALL_DEPS=1 执行恢复...')

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // QX-04：恢复命令与 :104 的提示及 README:70 的部署口径统一——有 package-lock.json 时用冻结安装
  // （npm ci，不再生成/改写 package-lock.json，也不会把部署目录的依赖版本漂移到锁文件之外）；
  // 缺锁文件的部署（非 npm ci 流程拷贝出来的目录）退回 install，但显式 --no-package-lock，
  // 不再顺手在部署目录里写出一份新锁文件。
  const useCi = Boolean(lockExists())
  const installVerb = useCi ? 'ci' : 'install'
  if (!useCi) {
    console.warn('未找到 package-lock.json，退化为 npm install --no-package-lock（建议按 README 用 npm ci 部署以冻结依赖版本）')
  }
  const installArgs = [
    installVerb,
    '--omit=dev', // --production 的现行等价写法（已弃用别名，语义不变）
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix', ROOT
  ]
  if (!useCi) installArgs.push('--no-package-lock')
  const install = spawnSyncFn(npm, installArgs, { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`npm ${installVerb} 失败，退出码 ${install.status}`)

  // 仅当安装后 re2 仍无法加载才构建：单纯 got 缺失但 re2 正常时，不要求无关的 C++ 构建环境。
  const re2AfterInstall = load('re2')
  if (re2AfterInstall) {
    if (!isRecoverable(re2AfterInstall)) throw re2AfterInstall
    const rebuild = spawnSyncFn(npm, [
      'run', 'rebuild', '--prefix', re2Path
    ], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
    if (rebuild.error) throw rebuild.error
    if (rebuild.status !== 0) throw new Error(`re2 原生模块构建失败，退出码 ${rebuild.status}`)
  }

  const recovered = { got: load('got'), re2: load('re2') }
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
  // 任务类型必须与 promise 显式绑定：prewarmTls 的返回值同样带 hostname（见 xbk_agents.prewarmTls），
  // 若按 hostname 猜测类型会把 TLS 结果误计入 DNS 分子/分母（QX-03）。promise 仍在 push 处即时发起，
  // 与原先同时启动、并发等待的时序一致。
  if (apiHost) tasks.push({ kind: 'dns', result: agents.prewarmDns(apiHost, signal) })
  if (hasWxPusher) {
    tasks.push({ kind: 'dns', result: agents.prewarmDns(wxHost, signal) })
    tasks.push({ kind: 'tls', result: agents.prewarmTls(wxHost, 5000, refreshCount(app), signal) })
  }
  const results = await Promise.all(tasks.map(task => task.result))
  if (!(signal && signal.aborted)) {
    const dnsResults = results.filter((r, i) => r && tasks[i].kind === 'dns')
    const tls = results.find((r, i) => r && tasks[i].kind === 'tls')
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

// classifySummary/classifyFailure 的聚合 info 形如 { failures: [子 info] } 且没有 message 字段；
// 只取 info.message/error.message 会把通道/供应商级原因（code、statusCode、channel）整块丢弃（QX-05）。
function describeFailure (info, error) {
  const parts = []
  if (info && info.message) parts.push(String(info.message))
  if (info && Array.isArray(info.failures)) {
    for (const item of info.failures) {
      if (!item) continue
      const reason = item.message || item.code || item.providerCode
      if (!reason) continue
      const channel = item.channel ? `${item.channel}：` : ''
      const status = item.statusCode ? `（HTTP ${item.statusCode}）` : ''
      parts.push(`${channel}${reason}${status}`)
    }
  }
  if (parts.length === 0 && error && error.message) parts.push(String(error.message))
  if (parts.length === 0) parts.push(String(error))
  return parts.join('；')
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
      throw error
    }
    consecutiveRetryableFailures = 0
    return summary
  }

  const handleFailure = async (error) => {
    const decision = classifyFailure(error)
    const info = decision.info || summarizeError(error)
    const detail = describeFailure(info, error)
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
  const fallback = path.join(ROOT, 'xianbaoku_cache')
  if (configured && !path.isAbsolute(configured)) {
    // 相对路径此前被静默忽略并回退默认目录，可能让 --status 读到与预期不同的目录（QX-08）。
    console.warn(`⚠️ XBK_CACHE_DIR 不是绝对路径（${configured}），已忽略并回退默认缓存目录：${fallback}`)
  }
  return configured && path.isAbsolute(configured) ? configured : fallback
}

function runStatus () {
  const status = readStatus(statusCacheDir())
  console.log(formatStatus(status))
  return 0
}

// QX-02：--dry-run 是「跑一轮看过滤效果」的一次性诊断（README 的调参用法），返回退出码：
// 0 = 单轮成功；1 = 单轮失败。与常驻路径不同，一次性执行不做退避重试——诊断用法需要立刻拿到
// 结果与退出码，而不是落进永不退出的循环里。
async function runDryRunOnce (app) {
  const summary = await app.run()
  const resultFailure = classifySummary(summary)
  if (!resultFailure) {
    const total = Number(summary && summary.total) || 0
    const filtered = Number(summary && summary.filtered) || 0
    console.log(`dry-run 单轮完成：共 ${total} 条，过滤 ${filtered} 条，未推送、未写成功缓存`)
    return 0
  }
  const info = resultFailure.info || {}
  const detail = describeFailure(info, new Error(resultFailure.reason || 'dry-run 单轮失败'))
  console.error(`dry-run 单轮失败（${resultFailure.reason}）：${detail}`)
  return 1
}

async function main () {
  const unknownArgs = [...ARGS].filter(arg => !KNOWN_ARGS.has(arg))
  if (unknownArgs.length > 0) {
    // 只告警不改行为：拒绝未知参数会改变既有命令行契约，需产品决策（QX-09 的 defer 部分）。
    console.warn(`⚠️ 未识别参数已忽略：${unknownArgs.join(' ')}（可用参数：--status / --check / --dry-run）`)
  }
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
  if (hasArg('--dry-run')) process.env.XBK_DRY_RUN = '1'
  ensureDependencies()
  const app = loadApp()
  // QX-02：带 --dry-run 时只跑一轮即退出（一次性诊断）。旧实现只是设置 XBK_DRY_RUN 后就落到
  // 常驻循环（进程永不退出、看起来像卡死）。需要「常驻但不推送」时改用环境变量 XBK_DRY_RUN=1
  // （不带本参数），该路径的常驻语义保持不变。
  if (hasArg('--dry-run')) {
    try {
      process.exitCode = await runDryRunOnce(app)
    } catch (error) {
      console.error('dry-run 单轮执行失败:', error && error.message ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }
  const versionWarning = nodeVersionWarning()
  if (versionWarning) console.warn(versionWarning)
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

module.exports = { classifyFailure, classifySummary, runResident, runDryRunOnce, refreshConnections, intervalMs, shouldAutoInstallDependencies, ensureDependencies, retryBackoffMs, runCheck, hasArg, nodeVersionWarning }
