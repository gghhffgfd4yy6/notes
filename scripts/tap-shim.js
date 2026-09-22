'use strict'
// ============================================================
// TAP 适配层（**CI 生产档**：mutation.yml 的 TAP 段由 stryker.tap.config.js 的 tap.nodeArgs 预加载）
//
// 目的：让本仓**零改动**的自定义 harness（run_unit_tests.js 那一族套件）在
// @stryker-mutator/tap-runner 下产出合法 TAP，从而拿到 perTest 的「只跑覆盖被变异文件的测试文件」。
//
// 由 tap-runner 的 nodeArgs 通过 `-r <绝对路径>/scripts/tap-shim.js` 预加载到每个被测文件之前：
//   node -r <stryker 自己的 coverage hook> -r <绝对路径>/scripts/tap-shim.js <testFile>
// 注意顺序：stryker 的 hook.cjs 先注册 process.on('exit', finalCleanup)，本文件后注册，退出时
// finalCleanup 先写 coverage JSON，随后本文件再打 TAP，两者互不干扰。
// （该顺序与「shim 路径必须是绝对路径」均在 exp/pr156-tap-spike 实测通过后原样移植，
//   见 .local/g1-smoke/REPORT.md 坑 2 与 §7 本地 smoke 记录。）
//
// 三项职责：
//   1) stdout 全部让给 TAP：被测正文的 console.log/process.stdout.write 一律改走 stderr。
//      必要性：TAP 解析器把正文里出现的 ok / not ok / 1..N 当成额外测试点，plan 不匹配，
//      dry-run 假失败（tap-runner 的 captureTapResult 会把它当 exit code 异常）。
//   2) 按 run_unit_tests.js 同口径判定本文件是否该在本入口运行：
//      integration / mutationSkip / SKIP_SUITES / 未注册进 test_suites.js 的一律 # SKIP 后 exit 0。
//      必要性：perTest 只按覆盖取子集，但 dry run 会遍历 tapRunner.testFiles 的全部清单文件；
//      且「跳过集合」必须与 command 档严格一致，否则两档分数不可比（例如 test_app.js 不在 SUITES 里，
//      command 档不跑它，tap 档也必须不跑）。正常情况下 stryker.tap.config.js 在加载时已断言
//      「显式清单 = 注册表推导清单」，这里是运行期兜底（纵深防御）。
//   3) 退出时打一个与退出码一致的 TAP 点。tap-runner 有一条硬规则（tap-helper.ts）：
//      进程退出码非 0 且没有解析到任何失败测试，会抛错并记 RuntimeError。
//      所以「非 0 退出」必须伴随 not ok，否则 tap 档会凭空多出 runtimeErrors（假红）。
// ============================================================
const fs = require('node:fs')
const path = require('node:path')

// TAP 写出口：**需要一个** fd 1 之外的私有出口——原因（实测，非推测）：xbk_storage.js 里有
// let fd = -1 这类哨兵，UnaryOperator 变异体把它改成 +1 后，finally 里的 closeSync(fd) 就变成
// closeSync(1) —— 直接关掉 stdout。此时 shim 若只会写 fd 1 会抛 EBADF: bad file descriptor, write
// （在 process 'exit' 钩子里抛出，进程异常终止，TAP 点全丢），于是 tap-runner 按 tap-helper.ts 的规则
// 判「退出码非 0 且无失败测试」，记 RuntimeError。
//
// ⚠️ 但**下面这段复制私有 fd 的实现是 no-op，从未生效**（2026-09-21 实测证伪，见
//   .local/storage-tap-RE-findings.md §3.4 与 §2.3）：
//   * tap-runner 用 **socketpair** spawn 被测进程（`readlink /proc/self/fd/1` = `socket:[…]`），
//     `fs.openSync('/proc/self/fd/1', 'a')` 直接 **ENXIO**（不是「本机终端才 ENXIO」——CI 下同样如此）
//     ⇒ catch 分支恒定命中，TAP_FD **恒为 1**，即这段 try/catch 是死代码；
//   * 独立旁证（CI 侧）：#134 的 TAP 点出现在 statusReason 的 `Stderr output:` 段里——若 dup 真生效，
//     TAP 点必然出现在 stdout；两条证据一致。
//   * 旧注释「dup 修复把 4 个降到 2 个」**不是** dup 生效的证据，该归因**未被证实**：canary 是 47 个
//     测试文件、baseline 是 32 个，L124 在两者之间由 RE 变 Survived，差异至少有一部分来自测试集收窄
//     + tap-parser 空流语义（见下）。
//   * 因此 `say()` 的三级兜底 `[TAP_FD, 1, 2]` **实际只有 fd 1 → fd 2 两级**：fd 1 被 closeSync(1)
//     关掉后写它会抛 EBADF，于是 TAP 点落到 **stderr**，而 tap-runner 只解析 stdout ⇒ 仍判 RuntimeError。
//     （这正是 storage 段在 TAP 档记 RuntimeError、在 command 档记 Killed 的机制之一；见 AGENTS.md
//     的「TAP 档已知限制」与 .local/storage-tap-RE-findings.md §3.2/§3.5。）
//
// 真正的修法是 shim 侧「中继子进程」（加载期 spawn 一个持有同一 stdout 管道的中继，退出时同步写其
// stdin），**本轮不实现**（超出 PR-1 范围，且中继必须在 stdin EOF 后立即退出并带超时，否则 parseTap
// 会挂死——比现在的 RE 更糟）。已登记为 PR-2 候选。
let TAP_FD = 1
try {
  TAP_FD = fs.openSync('/proc/self/fd/1', 'a')
} catch {
  TAP_FD = 1
}

function say (line) {
  const text = line + '\n'
  // 逐个尝试：[TAP_FD, 1, 2]。注意 TAP_FD **恒为 1**（上面的 dup 是 no-op，实测见文件顶部注释）
  // ⇒ 实际只有 fd 1 → fd 2 两级；fd 1 被 closeSync(1) 关掉后，TAP 点会落到 stderr，TAP 解析器看不到，
  // 仍被判 RuntimeError。最后一级只是「不抛异常」的兜底：至少不会因抛异常而改变退出码/掩盖真实失败原因。
  for (const fd of [TAP_FD, 1, 2]) {
    try {
      fs.writeSync(fd, text)
      return
    } catch { /* 试下一个 */ }
  }
}

const testFileArg = process.argv[1] || ''
const testFileName = path.basename(testFileArg)

// 只统计、不改行为：正文里如果真出现 TAP 形状的行，退出时在 stderr 上留证据（供 canary 报告核对）。
let foreignTapLines = 0

// 1) stdout 让给 TAP
const TAP_SHAPED = /^(?:not ok|ok)\b|^1\.\.\d+\s*$|^Bail out!/m
process.stdout.write = function (chunk, encoding, callback) {
  try {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (TAP_SHAPED.test(text)) foreignTapLines++
  } catch { /* 统计失败不影响转发 */ }
  return process.stderr.write(chunk, encoding, callback)
}

// 2) 跳过判定：与 run_unit_tests.js 的 UNIT_SUITES 过滤严格同源
function resolveSkipReason (file) {
  if (!file) return null
  let suites
  try {
    // 沙箱里本文件位于 <sandbox>/scripts/tap-shim.js，注册表在 <sandbox>/test_suites.js。
    // 用**字面量相对路径**（相对本模块文件解析 ⇒ <root>/test_suites.js）：既避免 './test_suites'
    // 误解析到 scripts/ 下（不存在）而静默失败，也避免 `require(<变量>)` 触发静态分析告警
    // （Codacy「dynamically import a module by calling require using a non-literal string」）。
    suites = require('../test_suites.js').SUITES
  } catch (err) {
    // 读不到注册表就无法保证「跳过集合与 command 档一致」——fail-closed，不允许静默放行。
    return `无法读取 test_suites.js（${err.message}）；跳过集合无法与 command 档对齐`
  }
  if (!Array.isArray(suites)) return 'test_suites.js 未导出 SUITES 数组（跳过集合无法与 command 档对齐）'
  const suite = suites.find(s => s.file === file)
  if (!suite) return '未注册进 test_suites.js（run_unit_tests.js 同口径：不在 SUITES 即不运行）'
  const skipSuites = new Set((process.env.SKIP_SUITES || '').split(',').map(s => s.trim()).filter(Boolean))
  if (skipSuites.has(file)) return `SKIP_SUITES 显式跳过（SKIP_SUITES=${process.env.SKIP_SUITES}）`
  if (suite.integration) return 'integration（run_unit_tests.js 同口径排除）'
  if (suite.mutationSkip) return 'mutationSkip（Stryker 沙箱内不可运行：行数元校验误报）'
  return null
}

function emitPoint (ok, note) {
  say('TAP version 13')
  say(`${ok ? 'ok' : 'not ok'} 1 - ${testFileName || 'unknown'}${note ? ` # ${note}` : ''}`)
  say('1..1')
}

const skipReason = resolveSkipReason(testFileName)

if (!testFileName) {
  // argv[1] 缺失，适配层没被 tap-runner 正确调用，必须响亮失败（否则静默变成「全绿」）。
  emitPoint(false, 'tap-shim 无法从 argv[1] 取到被测文件')
  process.exitCode = 1
} else if (skipReason) {
  emitPoint(true, `SKIP ${skipReason}`)
  process.exit(0)
} else {
  process.on('exit', (code) => {
    const ok = code === 0
    emitPoint(ok, ok ? undefined : `exit code ${code}`)
    if (foreignTapLines > 0) {
      // 已经转发到 stderr，TAP 流里看不到；这里只是如实留证，供 canary 判断风险面。
      fs.writeSync(2, `tap-shim: 正文里出现过 ${foreignTapLines} 行 TAP 形状输出（已转发到 stderr，未污染 TAP 流）\n`)
    }
  })
}
