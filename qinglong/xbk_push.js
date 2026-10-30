'use strict'

// 青龙面板直接执行入口：不依赖当前工作目录，配置/缓存仍统一放在项目根目录。
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { runLoop, sleep } = require('../xbk_loop')
const { resolveCacheDirInRoot } = require('../xbk_message_store')
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

// 与 package.json / re2 的 engines.node（^22.22.2 || ^24.15.0 || >=26.0.0）对齐：--check 和常驻告警
// 必须拒绝 23.x、25.x 及 24.0–24.14，不能只检查一个最低版本。
// C10-037：package.json 的 engines 此前只写 `>=22.22.2`，比 re2 的实际支持范围宽——23.x / 25.x /
// 24.0–24.14 能装上但 re2 必然构建失败。三处（package.json、package-lock.json、本常量）现已同一口径，
// 由 test_qinglong_utils.js 的 engines 一致性断言锁住，不允许再各写各的。
const SUPPORTED_NODE_RANGES = '^22.22.2 || ^24.15.0 || >=26.0.0'
const NODE_RANGE_MINIMA = [[22, 22, 2], [24, 15, 0]]
const STABLE_NODE_VERSION_RE = /^v?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseNodeVersion (version) {
  const match = STABLE_NODE_VERSION_RE.exec(String(version).trim())
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

function compareNodeVersion (left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

function isSupportedNodeVersion (version = process.versions.node) {
  const parts = parseNodeVersion(version)
  if (!parts) return false
  if (parts[0] >= 26) return true
  return NODE_RANGE_MINIMA.some(min => parts[0] === min[0] && compareNodeVersion(parts, min) >= 0)
}

// QX-06：常驻主路径与 --check 使用同一套完整 engines 版本范围；低于或不在范围内时只告警，
// 保持既有常驻入口不硬拒启动的行为。只接受稳定三段版本；prerelease 不能冒充受支持的稳定 Node。
function nodeVersionWarning (version = process.versions.node) {
  if (isSupportedNodeVersion(version)) return null
  return `⚠️ 当前 Node ${version} 不满足 re2/package.json engines 要求（${SUPPORTED_NODE_RANGES}），原生依赖可能不可用`
}

function runCheck (app) {
  const checks = []
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  }
  // QX-06：闸门与 re2 engines 的完整范围（^22.22.2 || ^24.15.0 || >=26.0.0）同口径。
  const nodeOk = isSupportedNodeVersion()
  add('Node.js 版本', nodeOk, nodeOk
    ? process.version
    : `${process.version}（不满足 re2/package.json engines 要求：${SUPPORTED_NODE_RANGES}）`)
  try {
    require('got')
    add('got 依赖', true, '可加载')
  } catch (e) { add('got 依赖', false, `不可加载：${e && e.message ? e.message : String(e)}`) }
  try {
    const RE2 = require('re2')
    const probe = new RE2('^ok$')
    add('re2 原生模块', probe.test('ok'), '可加载且匹配正常')
  } catch (e) { add('re2 原生模块', false, `不可加载，过滤正则不会安全执行：${e && e.message ? e.message : String(e)}`) }
  // 过滤规则：与 App.run 同源读覆盖文件（<cacheDir>/filter-rules.json），而不是只看代码默认——
  // 否则控制台改过的规则会让 --check 报「合法」/「非法」与真实运行不一致。
  // loadFilterRules 契约不抛错：损坏时降级（last-known-good 或代码默认）并给一条警告，检查继续。
  let activeFilter = app.Config.filter
  let activeKeyword = app.Config.keyword
  // MessageStore 缺失只可能出现在测试桩里（生产组合根必然注入）；此时按代码默认校验即可，
  // 不必把「桩不完整」当成规则文件损坏来告警。
  if (app.MessageStore) {
    try {
      const cacheDir = app.MessageStore.cacheDir
      if (typeof cacheDir === 'string') {
        const FilterStore = require('../xbk_filter_store')
        // 与 App.run 同口径传 deps：--check 也要能发现「规则编译不了」的覆盖文件，
        // 否则控制台红条/启动校验都报合法、真正跑起来却降级。
        const ruleEngine = typeof app.compileRules === 'function' && typeof app.hasNestedQuantifier === 'function'
          ? { hasNestedQuantifier: app.hasNestedQuantifier, compileRules: app.compileRules }
          : null
        let re2Ready = false
        try { re2Ready = Boolean(require('re2')) } catch (e) { re2Ready = false }
        const filterDeps = ruleEngine && typeof app.compileUserRegex === 'function'
          ? { RuleEngine: ruleEngine, compileUserRegex: app.compileUserRegex, re2Available: re2Ready, isRe2Available: () => re2Ready }
          : undefined
        const active = FilterStore.loadFilterRules({
          cacheDir,
          defaults: app.Config.filter,
          keyword: app.Config.keyword,
          deps: filterDeps
        })
        activeFilter = active.filter
        activeKeyword = active.keyword
        if (active.degraded) {
          const reason = (active.error && active.error.message) || '未知原因'
          console.warn(`⚠️ 过滤规则覆盖文件损坏（source=corrupt），启动校验改用${active.lastGoodUsed ? '上次合法规则' : '代码默认规则'}；运行时本轮不清 _f、不推进 filter.hash：${reason}`)
        }
      }
    } catch (e) {
      console.warn(`⚠️ 过滤规则覆盖文件读取异常，启动校验改用代码默认规则：${e && e.message ? e.message : String(e)}`)
    }
  }
  const warnings = app.validateConfig({ ...activeFilter, zkt_gjc: activeKeyword.zkt_gjc })
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

// 依赖名白名单清洗（QG2）：fixedPath 的 name 在生产调用链上只有 'got' / 're2' 两个字面量
// （见 ensureDependencies 内 load('got') / load('re2') 三处调用），但函数形参在静态分析里被视为
// 可能的输入（Codacy/Semgrep「Detected possible user input going into a path.join or path.resolve」）。
// 这里按 npm 包名字符集做白名单判定：放行的值只含字母/数字/`. _ -`、不以 `.` 或 `-` 开头、且不含
// `..` 上跳段——因此它不含任何路径分隔符，拼进 path.join 后必然是 ROOT/node_modules 下的直接子项，
// 构造不出 ROOT 之外的路径。非法输入直接抛错（fail-closed），不静默降级成目录本身。
const MODULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
function sanitizeModuleName (name) {
  const raw = String(name === undefined || name === null ? '' : name)
  if (!MODULE_NAME_RE.test(raw) || raw.includes('..')) {
    throw new Error(`依赖名不在白名单内，拒绝拼入固定依赖路径：${JSON.stringify(name)}`)
  }
  return raw
}

// got 是主 HTTP 依赖；re2 则是用户过滤规则的安全执行引擎。
// 安装命令刻意使用 --ignore-scripts 防供应链风险，但这也会跳过 re2 原生模块构建；
// 因此必须显式构建并加载校验，不能只因 got 可用就带着“所有正则规则被跳过”的状态启动。
//
// C10-017：两个 npm 子进程的超时上限（此前两处都硬编码 120000）。
//   · 安装（npm ci / npm install）120s：下载 + 解包，超时通常意味着网络/镜像卡住，快失败更好；
//   · 重建（npm rebuild re2）走 re2 的官方 install 脚本：取不到预编译包时会现场 node-gyp 编译，
//     慢机器/ARM 上远超 120s——硬编码会在编译中途杀掉子进程，只报「退出码 null」，看不出是超时。
// 两个上限都可由环境变量覆盖（长构建、离线镜像、受限带宽等场景），默认值保持向后兼容。
const NPM_INSTALL_TIMEOUT_MS = 120000
const NPM_REBUILD_TIMEOUT_MS = 600000

// 只接受「正的安全整数」；未设置/空串/非数字/非正数/小数/超界值一律回退默认值（配置写错不得让子进程无超时）。
// CR-07：spawnSync 的 timeout 只接受整数（Node 的 validateTimeout 按 uint32 校验），0.5 这类小数会在
// **启动 npm 之前**抛 ERR_OUT_OF_RANGE —— 于是「配置写错」变成「依赖恢复直接失败」，而不是按注释回退默认值。
// 上界同样按 spawnSync 的 uint32 取 0xFFFFFFFF：更大的「安全整数」照样抛 ERR_OUT_OF_RANGE。
const SPAWN_TIMEOUT_MAX_MS = 0xFFFFFFFF
function positiveTimeout (env, name, fallback) {
  const raw = env && env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > SPAWN_TIMEOUT_MAX_MS) return fallback
  return value
}

// spawnSync 超时的形状是 status=null + signal（Node 另给 error.code='ETIMEDOUT'）。必须与
// 「非零退出」「spawn 自身失败」分开报，否则现场只看到「退出码 null」，既不知是超时也不知能调什么。
// CR-10：只有 error.code==='ETIMEDOUT' 才是超时——被系统信号杀掉时 status 同样是 null，旧实现把
// 「signal 非空」一律当超时，OOM killer / 外部 kill 于是被误报成「超时到了，去调大上限」（调大无用）。
function spawnTimedOut (result) {
  if (!result || result.status !== null) return false
  return Boolean(result.error && result.error.code === 'ETIMEDOUT')
}

function ensureDependencies ({ requireFn = require, spawnSyncFn = spawnSync, env = process.env, lockExists = () => fs.existsSync(path.join(ROOT, 'package-lock.json')) } = {}) {
  // 固定依赖路径只作为兜底：入口不会将外部输入拼入模块或构建路径（两个模块名都是本文件字面量，
  // 且经 sanitizeModuleName 白名单复核——见该函数注释）。
  const fixedPath = (name) => path.join(ROOT, 'node_modules', sanitizeModuleName(name))
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
    throw new Error(`检测到 ${failed} 依赖或原生模块未完整安装；请在部署阶段依次执行：npm ci --omit=dev --ignore-scripts && npm rebuild re2。如确需在本次运行时安装，请显式设置 XBK_AUTO_INSTALL_DEPS=1。（本入口刻意把 re2 定为必需依赖：缺 re2 时不会带着“过滤正则被跳过”的状态进入常驻；主应用的缺 re2 降级 + 每日提醒通道不适用于本常驻入口，需要时请改用单轮入口。）`)
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
  const installTimeout = positiveTimeout(env, 'XBK_NPM_TIMEOUT_MS', NPM_INSTALL_TIMEOUT_MS)
  const install = spawnSyncFn(npm, installArgs, { cwd: ROOT, stdio: 'inherit', timeout: installTimeout })
  // 超时先判：Node 会把 status 置 null 并顺带给出 error(ETIMEDOUT)，若先走 `install.error`
  // 就只剩「spawnSync npm ETIMEDOUT」，看不出该调哪个上限。
  if (spawnTimedOut(install)) throw new Error(`npm ${installVerb} 超过 ${installTimeout}ms 未完成，已终止（网络/镜像卡住时先排查；确属慢环境可调大 XBK_NPM_TIMEOUT_MS 后重试）`)
  if (install.error) throw install.error
  // CR-10：status=null 但没有 ETIMEDOUT ⇒ 被系统信号终止（OOM killer / 外部 kill），不是超时——调大上限无用，得先查内存与并发。
  if (install.signal) throw new Error(`npm ${installVerb} 被系统信号 ${install.signal} 终止（不是超时；多为内存不足被 OOM killer 杀掉或外部 kill，先查可用内存与并发进程后重试）`)
  if (install.status !== 0) throw new Error(`npm ${installVerb} 失败，退出码 ${install.status}`)

  // 仅当安装后 re2 仍无法加载才恢复：单纯 got 缺失但 re2 正常时，不要求无关的 C++ 构建环境。
  const re2AfterInstall = load('re2')
  if (re2AfterInstall) {
    if (!isRecoverable(re2AfterInstall)) throw re2AfterInstall
    // `npm rebuild re2` 执行包的官方 install 脚本：优先取带 SHA-256 校验的预编译包，失败才源码构建。
    const rebuildTimeout = positiveTimeout(env, 'XBK_NPM_REBUILD_TIMEOUT_MS', NPM_REBUILD_TIMEOUT_MS)
    const rebuild = spawnSyncFn(npm, [
      'rebuild', 're2'
    ], { cwd: ROOT, stdio: 'inherit', timeout: rebuildTimeout })
    if (spawnTimedOut(rebuild)) throw new Error(`npm rebuild re2 超过 ${rebuildTimeout}ms 未完成，已终止（源码编译较慢；可调大 XBK_NPM_REBUILD_TIMEOUT_MS 后重试，或按 README 预装 re2）`)
    if (rebuild.error) throw rebuild.error
    // CR-10：同安装路径——信号终止（常见于源码编译时内存耗尽被 OOM killer 杀掉）单独报，不得谎报成超时。
    if (rebuild.signal) throw new Error(`npm rebuild re2 被系统信号 ${rebuild.signal} 终止（不是超时；源码编译很吃内存，多为 OOM killer 或外部 kill，先查可用内存/交换分区后重试）`)
    if (rebuild.status !== 0) throw new Error(`re2 原生模块恢复失败，退出码 ${rebuild.status}`)
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

// PR #362（CodeRabbit Major · Stability & Availability）：部分消息失败（pushed>0 且 failed>0）由
// runOnce 以 failureReason='PARTIAL_MESSAGE_FAILURE' 抛出。它属于「本轮降级」而不是「本轮失败」：
// 本轮已经拉取并送达了其它消息，循环本身健康，未送达的消息靠下一轮 app.run() 重新拉取重试。
function isPartialMessageFailure (error) {
  return Boolean(error && error.failureReason === 'PARTIAL_MESSAGE_FAILURE')
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
    // PR #362（CodeRabbit Major · Stability & Availability）：部分消息失败不得占用常驻循环的指数退避。
    // 旧实现把它当整轮可重试失败叠加退避（默认封顶 30 分钟）：等待期间连**新消息**都拉不下来，
    // 一条长期送不出去的消息会把无关投递一起拖住最多 30 分钟/轮。这里与轮询解耦——照旧告警
    // （保留 PARTIAL_MESSAGE_FAILURE 可 grep），但不动循环级连续失败计数、不叠加退避：下一轮按
    // 正常轮询间隔拉取，未送达的消息随该轮重试（本轮有消息送达 ⇒ 循环已恢复，计数同步清零）。
    //
    // 必须**先于** permanent 判定：classifyFailure 见到嵌套子错误（failureInfo.failures 非空）就丢掉
    // 父级预填标签转 classifyOne，子项全永久时得到 permanent/ALL_CHANNELS_PERMANENT——于是「成功 1 条
    // + 唯一失败是 token 无效(401)」这种部分失败会被判成整轮永久。若按 decision.kind 先判 permanent，
    // 一条 token 失效的消息就 abort 掉常驻循环、停掉全部后续新消息，比 30 分钟退避更糟。本轮已有成功
    // 投递（pushed>0）说明循环本身健康，故以重抛时预填的 failureReason 为准，先行分流、永不 abort。
    if (isPartialMessageFailure(error)) {
      consecutiveRetryableFailures = 0
      console.error(`本轮部分消息未送达（PARTIAL_MESSAGE_FAILURE），随后续轮询重试（不叠加循环退避）：${detail}`)
      return
    }

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

// QX-08：未设置 XBK_CACHE_DIR 时不再硬编码 path.join(ROOT,'xianbaoku_cache')，而是复用生产的
// 同源解析（xbk_message_store.resolveCacheDirInRoot，两侧同一实现，不再各写一份）。生产会拒绝并
// 回退的目录（被普通文件占位、realpath 逃出根目录、已存在层级不是目录）--status 不再照读——否则
// 状态其实写在 .xbk_cache_safe 时，--status 会静默报「缺失」。xbk_message_store 不 require 任何
// 模块（依赖由组合根注入），因此该复用不违反「--status 缺 got/re2 也要可用」的设计。
// 仍未覆盖的一点：Config.cache.dir 被改成其它根内目录时 --status 无从得知（不加载应用配置），
// 由 runStatus 显式打印生效目录并指向已登记的覆盖手段 XBK_CACHE_DIR，不再静默。
const DEFAULT_CACHE_DIR = 'xianbaoku_cache'

function statusCacheDir ({ env = process.env, fs: fsImpl = fs, path: pathImpl = path, root = ROOT } = {}) {
  // 与 MessageStore 同源（D2-S7 复核）：xbk_message_store 对 XBK_CACHE_DIR 做 trim 后才判
  // 绝对路径，这里不 trim 会让「尾随空格」的配置在读写两侧解析成不同目录（--status 读 A、
  // 运行写 B，一边空一边有）。非字符串（undefined 等）按未设置处理。
  const configured = typeof env.XBK_CACHE_DIR === 'string' ? env.XBK_CACHE_DIR.trim() : ''
  // 文档契约（README「若状态文件写在别处」）：XBK_CACHE_DIR 允许是项目目录之外的任意绝对路径。
  if (configured && pathImpl.isAbsolute(configured)) return configured
  const resolved = resolveCacheDirInRoot({
    fs: fsImpl,
    path: pathImpl,
    root,
    raw: DEFAULT_CACHE_DIR,
    fallback: DEFAULT_CACHE_DIR
  })
  if (configured) {
    // 相对路径此前被静默忽略并回退默认目录，可能让 --status 读到与预期不同的目录（QX-08）。
    console.warn(`⚠️ XBK_CACHE_DIR 不是绝对路径（${configured}），已忽略并回退默认缓存目录：${resolved}`)
  }
  return resolved
}

function runStatus () {
  const dir = statusCacheDir()
  // QX-08：--status 刻意不加载应用配置（缺 got/re2 时仍要可用），始终显式暴露实际读取目录。
  // 未采纳 XBK_CACHE_DIR 时额外说明：若已自定义 Config.cache.dir，需用同一绝对路径覆盖读取。
  // 展示口径必须与 statusCacheDir 同源（同一 trim）：否则「带尾随空格」的配置会打印
  // 「未使用 XBK_CACHE_DIR」而实际已采用，排障时自相矛盾（D2-S7 复核）。
  const configured = typeof process.env.XBK_CACHE_DIR === 'string' ? process.env.XBK_CACHE_DIR.trim() : ''
  const source = configured && path.isAbsolute(configured)
    ? '使用 XBK_CACHE_DIR'
    : '未使用 XBK_CACHE_DIR；--status 不加载应用配置，若已自定义 Config.cache.dir，请用 XBK_CACHE_DIR 指向该绝对路径'
  console.log(`缓存目录：${dir}（${source}）`)
  const status = readStatus(dir)
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
    // 审查 D2-M2（#232）：未知参数不再「只告警」——`--notify-test` 拼错成别的写法时，
    // 旧行为会一路落进常驻循环（生产上等于静默开始真实运行）。入口参数必须 fail-closed。
    console.error(`❌ 未识别参数：${unknownArgs.join(' ')}（可用参数：--status / --check / --dry-run），拒绝执行（fail-closed）`)
    process.exitCode = 1
    return
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

module.exports = { classifyFailure, classifySummary, runResident, runDryRunOnce, refreshConnections, intervalMs, shouldAutoInstallDependencies, ensureDependencies, retryBackoffMs, runCheck, hasArg, nodeVersionWarning, statusCacheDir, SUPPORTED_NODE_RANGES }
