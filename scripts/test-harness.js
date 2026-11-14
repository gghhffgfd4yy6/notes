'use strict'
// ============================================================
// 测试入口公共层：run_tests.js（串行全量）与 run_unit_tests.js（并发单元）共用。
//
// 为什么单独成文件：两个入口此前各自复制了同一批底层实现（主机干净度 guard 加载、套件子进程
// env 准备、终端显示宽度、正整数环境变量解析、进程组杀伤）。这些口径漂移过一次就够——某一边补了
// require.resolve 预判而另一边没补，主机干净度门禁就会在一条路径上被静默关掉（C10-028）。
//
// 边界：本文件只放**与编排无关**的原语。串行 vs 并发、SKIP_SUITES、CI summary、MAX_BUFFER、
// 每套件超时语义、退出码与汇总行格式全部留在各自入口（它们的差异是有意的，见两个入口的文件头）。
//
// 行为保持：下面每条实现都是从入口原样搬过来的（正则、文案、返回形状、容错分支逐字一致）。
// ============================================================
const { createRequire } = require('node:module')
const path = require('node:path')

// ---------- 终端显示宽度 ----------
// 汇总表按终端显示宽度对齐：String.prototype.padEnd 按 UTF-16 码元计数，中文每字占 2 列、
// 文件名长度不一，直接 padEnd 会让列错位；此处按实测最大显示宽度补齐。
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
function displayWidth (str) {
  let width = 0
  for (const ch of str) width += WIDE_RE.test(ch) ? 2 : 1
  return width
}
function padEndWidth (str, width) {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)))
}

// ---------- 正整数环境变量 ----------
// 与 run_mutation.js 的 positiveIntEnv 同口径（不 require 该文件，避免把变异入口及其依赖拉进
// 测试进程）：非法值（NaN / 负数 / 非整数 / 空串 / 0）一律告警并回退默认，绝不静默按非法值运行。
// env / log 可注入（测试用）：生产调用只传前两个参数，语义与默认值逐字不变。
function positiveIntEnv (name, fallback, env = process.env, log = console.warn) {
  const source = env || {}
  const raw = source[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    log(`⚠️  环境变量 ${name}=${raw} 非法（应为正整数），已回退默认值 ${fallback}`)
    return fallback
  }
  return value
}

// ---------- 套件子进程 env（backlog C3-002） ----------
// 套件子进程一律用**剥离了 XBK_CACHE_DIR 的 env**。为什么必须显式传 env：spawn 不传 env 时子进程
// 继承 shell 环境，而生产 cacheDir getter 让 XBK_CACHE_DIR 无条件压过 Config.cache.dir（SYSTEM_CONTRACT
// 契约，语义正确），于是「在 export 过该变量的机器上跑测试」会把夹具写进**部署缓存目录**、覆盖真实
// push.json 判重主存。只改测试侧：生产 getter 一字不动，环境变量在你自己的 shell 里照旧生效。
//
// ⚠️ 最小工作树夹具（test_ci_skip_suites.js / test_host_clean_gates.js 的沙箱只复制入口与少量依赖）里
// 没有 scripts/test-env-isolation.js：与 scripts/check-host-clean.js 同口径——缺模块时**响亮**跳过并
// 退回同一实现的内联版本（绝不静默放行，否则夹具里的隔离语义与真实入口不一致）。
const FALLBACK_STRIP_CACHE_DIR_ENV = (env = process.env) => {
  const next = { ...(env || {}) }
  const raw = typeof next.XBK_CACHE_DIR === 'string' ? next.XBK_CACHE_DIR : ''
  delete next.XBK_CACHE_DIR
  return { env: next, cleared: raw }
}
let stripCacheDirEnv = FALLBACK_STRIP_CACHE_DIR_ENV
try {
  stripCacheDirEnv = require('./test-env-isolation').stripCacheDirEnv || FALLBACK_STRIP_CACHE_DIR_ENV
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e
  console.log('⚠️ 未找到 scripts/test-env-isolation.js，入口按同一口径内联剥离 XBK_CACHE_DIR（最小工作树夹具）')
}

// 返回 { env, cleared }：env 是入参浅拷贝（不原地修改），cleared 是被清除的原值（未设置为 ''）。
// cleared 非空时打印一次性告警——测试用的缓存目录与 shell 里设的不一样，排障时必须一眼可见。
function prepareSuiteEnv (env = process.env) {
  const info = stripCacheDirEnv(env)
  if (info.cleared) {
    console.warn(`⚠️ 已从本入口派生的测试子进程环境中清除 XBK_CACHE_DIR（${info.cleared}）：测试只用 Config.cache.dir 的私有目录，避免写入部署缓存（backlog C3-002）`)
  }
  return info
}

// ---------- 主机干净度 guard 加载（v3.283 / C10-028） ----------
// 孤儿测试桩 / 被 reparent 到 1 的孤儿套件 / 过期 tmp 沙箱会把墙钟基准拖红（实测 300ms 跑出 878ms），
// 脏机器不启动。缺脚本时**响亮跳过**——最小工作树（沙箱夹具只复制入口）不得因此崩；其它异常照常抛出。
//
// C10-028：容错只覆盖「**本模块自身**不存在」。旧实现直接 require 并只判 e.code === 'MODULE_NOT_FOUND'，
// 于是 scripts/check-host-clean.js 存在、但它内部的某个依赖缺失（树损坏 / 将来给它加相对依赖）也被读成
// 「未找到 check-host-clean.js，跳过」→ 主机干净度门禁被静默关掉。现在先用 resolve 预判本模块能否解析：
// 解析不到才算最小工作树（响亮跳过）；解析成功后的加载异常（含其内部 MODULE_NOT_FOUND）一律照常抛出，
// 绝不再伪装成「脚本不存在」。
//
// modulePath / log 可注入（测试用）：门禁文件名固定（specifier 必须是字面量，静态扫描不接受非字面量
// require），注入只改变**解析基准目录**——默认基准即本文件所在目录 scripts/。
const HOST_CLEAN_FILE = 'check-host-clean.js'

function loadHostCleanGuard (opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : console.log
  const modulePath = typeof opts.modulePath === 'string' && opts.modulePath
    ? opts.modulePath
    : path.join(__dirname, HOST_CLEAN_FILE)
  if (path.basename(modulePath) !== HOST_CLEAN_FILE) {
    throw new Error(`loadHostCleanGuard: modulePath 必须指向名为 ${HOST_CLEAN_FILE} 的模块（实际 ${modulePath}）`)
  }
  const req = createRequire(path.join(path.dirname(modulePath), 'load-guard-probe.js'))
  try {
    req.resolve('./check-host-clean.js')
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e
    log('⚠️ 未找到 scripts/check-host-clean.js，跳过主机干净度前置检查（不影响本次运行）')
    return { hostClean: null, missing: true }
  }
  return { hostClean: req('./check-host-clean.js'), missing: false }
}

// ---------- 进程组杀伤（F6 / C10-044 / C10-003） ----------
// 套件以 detached:true 启动（setsid），pid 即进程组 id → kill(-pid) 连同套件派生的后代一起清掉。
// 为什么必须有这一步：只 kill 直接子进程时，套件 fork 出的孙进程存活并继续持有继承的 stdout/stderr，
// 入口自身被管道捕获时（CI runner 收输出、spawnSync('pipe')）管道的 close 会被推迟到孤儿后代退出才
// 发生——实测父进程要等 30s 兜底才返回；且孤儿继续跑（占 CPU / 端口 / 临时目录，污染后续套件）。
// 组不存在（子进程未及 setsid / 已被回收 → ESRCH）或无权限（EPERM）时静默返回 false：不抛错、不改
// 结算口径（超时仍按失败处理、退出码仍非 0、汇总三数字不变，fail-closed 语义）。
function killSuiteGroup (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  displayWidth,
  padEndWidth,
  positiveIntEnv,
  FALLBACK_STRIP_CACHE_DIR_ENV,
  prepareSuiteEnv,
  loadHostCleanGuard,
  killSuiteGroup
}
