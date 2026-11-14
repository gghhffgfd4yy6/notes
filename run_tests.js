'use strict'
// ============================================================
// 统一测试入口：按 test_suites.js 注册表执行全部套件（含 integration，非「三套」）+ 汇总报告 + 退出码
// 用法：node run_tests.js   （或 npm test）
// 退出码：0 = 全部通过，非 0 = 有失败（CI/调度可感知）
// 每套件硬超时：默认 600s（可经 XBK_TEST_TIMEOUT 覆盖），超时按失败处理并整组 SIGKILL 强杀——
// 套件挂死时入口仍能收敛出结论与退出码，不会永久阻塞（RT-03）；套件派生的后代由整组杀伤一并清掉（F6）。
// 公共层（v3.435）：主机干净度 guard 加载 / 套件子进程 env 准备 / 终端显示宽度 / 正整数环境变量 /
// 进程组杀伤统一在 scripts/test-harness.js 一处实现。本文件只保留**串行全量**编排（并发单元入口见
// run_unit_tests.js），两边不再各维护一份底层实现（口径漂移曾让一条路径上的门禁被静默关掉）。
// ============================================================
const { spawn } = require('child_process')
const path = require('path')
const {
  displayWidth,
  padEndWidth,
  positiveIntEnv,
  prepareSuiteEnv,
  loadHostCleanGuard,
  killSuiteGroup
} = require('./scripts/test-harness')

// v3.283 主机干净度前置检查：孤儿测试桩 / 被 reparent 到 1 的孤儿套件 / 过期 /tmp/xbk-* 沙箱会把墙钟
// 基准拖红（实测 300ms 跑出 878ms），脏机器不启动。缺脚本时**响亮跳过**——最小工作树（如
// test_ci_skip_suites.js 的 RT-08 夹具只复制入口）不得因此崩；其它异常照常抛出，不吞。
// C10-028 的容错口径（只放过「本模块自身不存在」、先 resolve 预判再 require）随实现一起收敛到
// scripts/test-harness.js 的 loadHostCleanGuard（该处注释给出完整理由）。
const { hostClean } = loadHostCleanGuard()
if (hostClean && hostClean.shouldAbortForDirtyHost(process.env)) process.exit(1)

const { checkDependencies } = require('./scripts/check-deps')

const { SUITES } = require('./test_suites')

// C3-002（backlog）：套件子进程一律用**剥离了 XBK_CACHE_DIR 的 env**（实现见 scripts/test-harness.js
// 的 prepareSuiteEnv）。为什么必须显式传 env：spawn 不传 env 时子进程继承 shell 环境，而生产 cacheDir
// getter 让 XBK_CACHE_DIR 无条件压过 Config.cache.dir（SYSTEM_CONTRACT 契约，语义正确），于是「在
// export 过该变量的机器上跑测试」会把夹具写进**部署缓存目录**、覆盖真实 push.json 判重主存。
// 只改测试侧：生产 getter 一字不动，环境变量在你自己的 shell 里照旧生效。
const SUITE_ENV = prepareSuiteEnv(process.env).env

// 汇总表按终端显示宽度对齐（displayWidth / padEndWidth 在 scripts/test-harness.js）：String.prototype.padEnd
// 按 UTF-16 码元计数，中文每字占 2 列、文件名长度不一，直接 padEnd 会让列错位；此处按实测最大显示宽度补齐。

// 当前在跑的套件进程组 id（C10-044）：套件运行在 detached 新进程组里，Ctrl-C / CI 取消只会打到本入口，
// 没有任何 handler 时孤儿套件继续跑（实测：心跳文件在入口退出后仍增长）。
// **为什么不只加 handler 而保留 execFileSync**：同步阻塞期间事件循环不转，JS 信号 handler 根本执行不到
// （Node 一旦装了 JS listener 就会接管默认的「收到信号即退」）——那样 Ctrl-C 会变成「毫无反应」，比孤儿更糟。
// 故套件执行改为 async spawn（见 runSuite），handler 才有机会跑；activeSuitePid 由它维护。
let activeSuitePid = null
let shuttingDown = false

// 收掉当前套件进程组。先清记录再杀：避免 process.exit 触发的 exit handler 对可能已被复用的 pgid 再补一刀。
function abortActiveSuite () {
  const pid = activeSuitePid
  if (!Number.isInteger(pid)) return false
  activeSuitePid = null
  return killSuiteGroup(pid)
}

// SIGINT/SIGTERM 收尾（C10-044）：整组杀伤当前套件后以非零退出码收场（130/143）。
// 「被打断」不等于「通过」——退出码必须让 CI / 调度方看得见中断。
function handleTerminationSignal (signal) {
  if (shuttingDown) return
  shuttingDown = true
  const killed = abortActiveSuite()
  console.error(`\n⚠️  收到 ${signal}：${killed ? '已整组 SIGKILL 当前套件进程组' : '当前没有在跑的套件'}，入口以非零退出（不把中断当通过）`)
  process.exit(signal === 'SIGINT' ? 130 : 143)
}
process.on('SIGINT', () => handleTerminationSignal('SIGINT'))
process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'))
// 兜底：任何路径的 process.exit（未捕获异常、下游显式 exit）也必须先收掉当前套件进程组，否则同样的
// 孤儿会留下。exit handler 里只能做同步操作——进程组杀伤恰好是同步的。
process.on('exit', () => abortActiveSuite())

// 每套件硬超时（RT-03）：子进程默认无 timeout，套件挂死（死循环 / 等待不会到来的输入 /
// 遗留句柄）时父进程永久阻塞——既不汇总也不退出，「CI/调度可感知的退出码」承诺失效，CI 只能等
// 作业级超时，且没有任何红测定位。姊妹入口 run_unit_tests.js:95 已有同款兜底（UNIT_TIMEOUT +
// killSignal SIGKILL），此处按同一口径补齐。
// 默认 600s：全量入口最慢的集成套件（test_app_p.js / test_notify.js）实测均在分钟级，留足余量
// 以免误杀；超过 10 分钟无进展只可能是挂死。XBK_TEST_TIMEOUT 仅用于测试注入/本机调参，生产不设。
const TEST_TIMEOUT = positiveIntEnv('XBK_TEST_TIMEOUT', 10 * 60 * 1000)

// 单套件执行（C10-044：从同步 execFileSync 改为 async spawn，语义逐项对齐）
//   * stdio:'inherit' 不变——各套件自己的 ✅/❌ 输出直接透传；
//   * detached:true 不变——套件自成进程组（setsid），超时/中断可整组杀伤（见 killSuiteGroup）；
//   * cwd 固定 __dirname 不变（理由见调用点注释）；
//   * 超时语义不变：到点整组 SIGKILL，按失败结算并在输出里点名「超过每套件上限」（RT-03）；
//   * 失败诊断字段不变：code/status/signal 三件套照样打印（静默 exit 7 与被信号杀死仍可区分）。
// 改成 async 的唯一动因是信号 handler 能跑：execFileSync 阻塞期间事件循环不转，SIGINT/SIGTERM 的 JS
// handler 永远执行不到（而装了 handler 又会接管默认退出语义 ⇒ Ctrl-C 无反应），详见 activeSuitePid 注释。
function runSuite (file) {
  return new Promise(resolve => {
    let settled = false
    let timedOut = false
    let timer = null
    // C3-002：显式传剥离了 XBK_CACHE_DIR 的 env（见文件顶部 SUITE_ENV 的说明）——
    // 不传 env 会让子进程继承 shell 里的部署开关，把夹具写进真实缓存目录。
    const child = spawn(process.execPath, [file], { cwd: __dirname, env: SUITE_ENV, stdio: 'inherit', detached: true })
    const pid = child.pid
    // 记录当前套件进程组：信号 handler 与 process.on('exit') 据此整组杀伤
    activeSuitePid = Number.isInteger(pid) ? pid : null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (activeSuitePid === pid) activeSuitePid = null
      resolve(result)
    }
    if (TEST_TIMEOUT > 0) {
      timer = setTimeout(() => {
        timedOut = true
        // 直接杀整个进程组：既收掉套件本身，也收掉它派生的后代（F6）
        killSuiteGroup(pid)
      }, TEST_TIMEOUT)
    }
    // spawn 本身失败（ENOENT / EACCES …）只有 error、没有 exit，必须单独收敛
    child.on('error', (e) => finish({ code: e && e.code, status: null, signal: null, timedOut, message: e && e.message }))
    child.on('exit', (status, signal) => finish({ status, signal, timedOut }))
  })
}

const results = []
console.log('══════════════════════════════════════════════')
console.log('  xbk-push 统一测试入口')
console.log('══════════════════════════════════════════════\n')

// RT-08：前置门必须同时覆盖 devDependencies——注册套件 test_filter.js 裸 require('fast-check')
// （devDependency），只探运行时清单时缺它要等套件运行时才炸（且报错点离根因很远）。includeDevDependencies
// 只对测试入口打开（运行时调用方的语义不变）；devDependency 为 ESM-only 时只做 resolve 探测，不误报。
if (!checkDependencies({ includeDevDependencies: true })) process.exit(1)

// 零套件不等于通过：注册表为空（或将来被过滤成空）时循环体一次都不执行，results 为空 → allOk 初值 true
// → 打印「全部通过 🎉」并 exit 0，门禁整步假绿。注意 test_suite_registry.js 的「SUITES 不应为空」断言
// 本身就在 SUITES 的一个成员里，空注册表时根本不会执行（自指盲区），救不了这个场景。
if (!SUITES.length) {
  console.error('❌ SUITES 为空：test_suites.js 注册表损坏，拒绝以「全部通过」收场')
  process.exit(1)
}

async function main () {
  for (const s of SUITES) {
    const file = path.join(__dirname, s.file)
    const t0 = Date.now()
    // cwd 固定为 __dirname（与 run_unit_tests.js:121 同口径，该处注释给出全部理由）：
    // test_ci_skip_suites.js / test_tag_validator.js 按 cwd 读 .github/workflows/test.yml /
    // package.json / CHANGELOG.md，前者更是直接断言「请在仓库根目录运行本套件」——不固定 cwd 时
    // 从子目录调用本入口会假红；cwd 落在同构副本目录时则会「对账到别的仓库」而假绿。
    // 以仓库根为 cwd 的调用（npm test / CI）行为不变。
    const r = await runSuite(file)
    const ms = Date.now() - t0
    if (!r.timedOut && r.status === 0 && r.signal === null) {
      results.push({ ...s, ok: true, ms })
      console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`)
      continue
    }
    results.push({ ...s, ok: false, ms })
    // 超时必须与断言红区分开：否则排查者只看到一行「失败」，不知道套件是被每套件上限掐掉的（RT-03）。
    // 静默非零退出/被信号杀死的套件在子进程侧可能零输出——父进程必须补上退出原因，
    // 否则 exit 7 与「被 OOM 杀掉」在输出上完全不可区分（code/status/signal 三件套）。
    const code = r.timedOut ? 'ETIMEDOUT' : (r.code ?? '-')
    const why = `code=${code} status=${r.status ?? '-'} signal=${r.signal ?? '-'}`
    console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s${r.timedOut ? `｜超过每套件上限 ${TEST_TIMEOUT}ms 已强杀` : ''}｜${why}）`)
    // 与 execFileSync 的失败输出保持一致（排查者习惯看到 Command failed: <node> <file>）
    const detail = r.message ? String(r.message) : `Command failed: ${process.execPath} ${file}`
    console.log(`     ${detail.split('\n')[0]}`)
    console.log('')
  }

  // 防御「全部条目被跳过」的未来形态：结果为空同样不得以「全部通过」收场。
  if (!results.length) {
    console.error('❌ 未执行任何测试套件，拒绝以「全部通过」收场')
    process.exit(1)
  }

  console.log('══════════════════════════════════════════════')
  console.log('  汇总报告')
  console.log('══════════════════════════════════════════════')
  let allOk = true
  const nameWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.name)), 6)
  const fileWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.file)), 18)
  for (const r of results) {
    const mark = r.ok ? '✅' : '❌'
    console.log(`  ${mark} ${padEndWidth(r.name, nameWidth)} ${padEndWidth(r.file, fileWidth)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`)
    if (!r.ok) allOk = false
  }
  const totalMs = results.reduce((a, r) => a + r.ms, 0)
  const passCount = results.filter(r => r.ok).length
  const failCount = results.length - passCount
  console.log(`\n  总耗时: ${(totalMs / 1000).toFixed(1)}s`)
  // 汇总行格式与 run_unit_tests.js 同一跨文件契约（UT-07）：带「K 通过, M 失败, 共 N」三数字，
  // 才能被 run_mutation.js 的 extractTestSummary 识别为本入口的汇总（内层套件 stdout 直通时
  // 不被更早的同名行抢答）。改格式需同步 run_unit_tests.js 与 run_mutation.js 的解析口径。
  console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}｜${passCount} 通过, ${failCount} 失败, 共 ${results.length}`)
  console.log('══════════════════════════════════════════════')

  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
