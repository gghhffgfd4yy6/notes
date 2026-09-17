'use strict'
// ============================================================
// 统一测试入口：按 test_suites.js 注册表执行全部套件（含 integration，非「三套」）+ 汇总报告 + 退出码
// 用法：node run_tests.js   （或 npm test）
// 退出码：0 = 全部通过，非 0 = 有失败（CI/调度可感知）
// 每套件硬超时：默认 600s（可经 XBK_TEST_TIMEOUT 覆盖），超时按失败处理并以 SIGKILL 强杀——
// 套件挂死时入口仍能收敛出结论与退出码，不会永久阻塞（RT-03）。
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { checkDependencies } = require('./scripts/check-deps')

const { SUITES } = require('./test_suites')

// 汇总表按终端显示宽度对齐（与 run_unit_tests.js 同口径）：String.prototype.padEnd 按 UTF-16 码元计数，
// 中文每字占 2 列、文件名长度不一，直接 padEnd 会让列错位；此处按实测最大显示宽度补齐。
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
function displayWidth (str) {
  let width = 0
  for (const ch of str) width += WIDE_RE.test(ch) ? 2 : 1
  return width
}
function padEndWidth (str, width) {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)))
}

// 环境变量正整数解析（与 run_unit_tests.js / run_mutation.js 的 positiveIntEnv 同口径）：
// 非法值（NaN / 负数 / 非整数 / 空串）一律告警并回退默认，绝不静默按非法值运行。
function positiveIntEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`⚠️  环境变量 ${name}=${raw} 非法（应为正整数），已回退默认值 ${fallback}`)
    return fallback
  }
  return value
}

// 每套件硬超时（RT-03）：execFileSync 默认无 timeout，套件挂死（死循环 / 等待不会到来的输入 /
// 遗留句柄）时父进程永久阻塞——既不汇总也不退出，「CI/调度可感知的退出码」承诺失效，CI 只能等
// 作业级超时，且没有任何红测定位。姊妹入口 run_unit_tests.js:95 已有同款兜底（UNIT_TIMEOUT +
// killSignal SIGKILL），此处按同一口径补齐。
// 默认 600s：全量入口最慢的集成套件（test_app_p.js / test_notify.js）实测均在分钟级，留足余量
// 以免误杀；超过 10 分钟无进展只可能是挂死。XBK_TEST_TIMEOUT 仅用于测试注入/本机调参，生产不设。
const TEST_TIMEOUT = positiveIntEnv('XBK_TEST_TIMEOUT', 10 * 60 * 1000)

const results = []
console.log('══════════════════════════════════════════════')
console.log('  xbk-push 统一测试入口')
console.log('══════════════════════════════════════════════\n')

if (!checkDependencies()) process.exit(1)

// 零套件不等于通过：注册表为空（或将来被过滤成空）时循环体一次都不执行，results 为空 → allOk 初值 true
// → 打印「全部通过 🎉」并 exit 0，门禁整步假绿。注意 test_suite_registry.js 的「SUITES 不应为空」断言
// 本身就在 SUITES 的一个成员里，空注册表时根本不会执行（自指盲区），救不了这个场景。
if (!SUITES.length) {
  console.error('❌ SUITES 为空：test_suites.js 注册表损坏，拒绝以「全部通过」收场')
  process.exit(1)
}

for (const s of SUITES) {
  const file = path.join(__dirname, s.file)
  const t0 = Date.now()
  try {
    // 继承 stdout/stderr（各套件自己的 ✅/❌ 输出直接透传），捕获退出码；
    // timeout + killSignal 见 TEST_TIMEOUT（RT-03）：挂死套件强杀后走下方失败分支，不再永久阻塞。
    execFileSync(process.execPath, [file], { stdio: 'inherit', timeout: TEST_TIMEOUT, killSignal: 'SIGKILL' })
    const ms = Date.now() - t0
    results.push({ ...s, ok: true, ms })
    console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`)
  } catch (e) {
    const ms = Date.now() - t0
    results.push({ ...s, ok: false, ms })
    // 超时（execFileSync 抛 ETIMEDOUT，套件已按 killSignal=SIGKILL 强杀）必须与断言红区分开：
    // 否则排查者只看到一行「失败」，不知道套件是被每套件上限掐掉的（RT-03）。
    const timedOut = e.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(e.message || ''))
    // 静默非零退出/被信号杀死的套件在子进程侧可能零输出——父进程必须补上退出原因，
    // 否则 exit 7 与「被 OOM 杀掉」在输出上完全不可区分（e.status/e.signal/e.code/e.message）。
    const why = `code=${e.code ?? '-'} status=${e.status ?? '-'} signal=${e.signal ?? '-'}`
    console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s${timedOut ? `｜超过每套件上限 ${TEST_TIMEOUT}ms 已强杀` : ''}｜${why}）`)
    if (e.message) console.log(`     ${String(e.message).split('\n')[0]}`)
    console.log('')
  }
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
