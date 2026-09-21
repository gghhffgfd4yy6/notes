'use strict'
// ============================================================
// TAP 适配层（canary 分支 spike/tap-canary-http 专用，实验品，不进 main）
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

// TAP 写出口：必须在加载时把 stdout 复制到一个私有 fd。
// 原因（实测，非推测）：xbk_storage.js 里有 let fd = -1 这类哨兵，UnaryOperator 变异体把它改成 +1
// 后，finally 里的 closeSync(fd) 就变成 closeSync(1) —— 直接关掉 stdout。此时 shim 若写 fd 1 会抛
// EBADF: bad file descriptor, write（在 process 'exit' 钩子里抛出，进程异常终止，TAP 点全丢），
// 于是 tap-runner 按 tap-helper.ts 的规则判「退出码非 0 且无失败测试」，记 RuntimeError。
// 实测：这就是 tap-storage 段 RuntimeError 的主要来源（dup 修复把 4 个降到 2 个）。
// 复制出私有 fd 后，即使被测代码关掉 fd 1，TAP 点仍能正常写出（CI 下 stdout 是管道，
// /proc/self/fd/1 可打开；本机直跑终端时可能 ENXIO，此时回落 fd 1）。
let TAP_FD = 1
try {
  TAP_FD = fs.openSync('/proc/self/fd/1', 'a')
} catch {
  TAP_FD = 1
}

function say (line) {
  const text = line + '\n'
  // 逐个尝试：私有 dup、fd 1、fd 2。最后一个只是「不抛异常」的兜底（写到 stderr 时 TAP 解析器看不到，
  // 仍会被判 RuntimeError，但至少不会因抛异常而改变退出码/掩盖真实失败原因）。
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
    // 必须用绝对路径 require：'./test_suites' 会解析到 scripts/ 下（不存在）而静默失败。
    suites = require(path.join(__dirname, '..', 'test_suites.js')).SUITES
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
