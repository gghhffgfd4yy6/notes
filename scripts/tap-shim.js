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
//   4) 把「本进程**成功投递**的 TAP 点数」留成可核对的证据（C10-008），两条通道：
//      a. 写进 stryker coverage hook 已落盘的 coverage JSON（stryker-output-<pid>.json，多一个
//         `tapPoints` 键；tap-runner 只读 hitCount/mutantCoverage，未知键被忽略）；
//      b. 追加一行到 `XBK_TAP_POINTS_LOG`（mutation.yml 的摘要步按 `tapPoints===0` 判空流）。
//      为什么必须另有 (b)：tap-runner 的 runFile() 读完 coverage JSON **立刻 fs.rm 掉**
//      （dist/src/tap-test-runner.js 的 `await fs.rm(fileName)`），而 mutation.json 的
//      testFiles[].tests[] 只有 {id,name}（无覆盖、无 TAP 点）⇒ 报告侧拿不到任何「投递了几个点」
//      的信息，(b) 是唯一能活到 job 末尾的通道。
// ============================================================
const fs = require('node:fs')
const path = require('node:path')

// TAP 写出口：历史上**想**要一个 fd 1 之外的私有出口——动机（实测，非推测）：xbk_storage.js 里有
// let fd = -1 这类哨兵，UnaryOperator 变异体把它改成 +1 后，finally 里的 closeSync(fd) 就变成
// closeSync(1) —— 直接关掉 stdout。此时 shim 若只会写 fd 1 会抛 EBADF: bad file descriptor, write
// （在 process 'exit' 钩子里抛出，进程异常终止，TAP 点全丢），于是 tap-runner 按 tap-helper.ts 的规则
// 判「退出码非 0 且无失败测试」，记 RuntimeError。
//
// ⚠️ 但**复制私有 fd 的实现是 no-op，从未生效**（C10-040 已按实测删掉这段死代码，见
//   .local/storage-tap-RE-findings.md §3.4 与 §2.3）：
//   * tap-runner 用 **socketpair** spawn 被测进程（`readlink /proc/self/fd/1` = `socket:[…]`），
//     `fs.openSync('/proc/self/fd/1', 'a')` 直接 **ENXIO**（不是「本机终端才 ENXIO」——CI 下同样如此）
//     ⇒ catch 分支恒定命中，TAP_FD **恒为 1**，即这段 try/catch 是死代码；
//   * 独立旁证（CI 侧）：#134 的 TAP 点出现在 statusReason 的 `Stderr output:` 段里——若 dup 真生效，
//     TAP 点必然出现在 stdout；两条证据一致。
//   * 旧注释「dup 修复把 4 个降到 2 个」**不是** dup 生效的证据，该归因**未被证实**：canary 是 47 个
//     测试文件、baseline 是 32 个，L124 在两者之间由 RE 变 Survived，差异至少有一部分来自测试集收窄
//     + tap-parser 空流语义（见下）。
//   * 因此 `say()` 的兜底通道**实际只有 fd 1**（TAP_FD 恒为 1）：fd 1 被 closeSync(1) 关掉后写它会抛 EBADF。
//     修复前「任一 fd 写成功即算成功」会把 TAP 点**静默改投 stderr**：被测文件退出码为 0 时 stdout 为空，
//     tap-parser 对空流判 {ok:true, skipReason:'no tests found'} ⇒ 该变异体静默 Survived（假绿）。
//     现已改为「**只有 fd 1 投递成功才算成功**，否则 stderr 留证 + 退出码非零」（C10-007）：tap-runner
//     的硬规则会把「非零退出且解析不到失败测试」记成 RuntimeError ⇒ 响亮，不再是空流假绿。
//     （这也是 storage 段在 TAP 档记 RuntimeError、在 command 档记 Killed 的机制之一；见 AGENTS.md
//     的「TAP 档已知限制」与 .local/storage-tap-RE-findings.md §3.2/§3.5。）
//
// 真正的修法是 shim 侧「中继子进程」（加载期 spawn 一个持有同一 stdout 管道的中继，退出时同步写其
// stdin），**本轮不实现**（超出 PR-1 范围，且中继必须在 stdin EOF 后立即退出并带超时，否则 parseTap
// 会挂死——比现在的 RE 更糟）。已登记为 PR-2 候选。
// 因此实现里不再尝试 dup：**TAP_FD 就是 fd 1**（C10-040）。保留名字是为了让「哪条通道算 TAP」
// 这件事只有一个出处，也方便将来换中继方案时只改这一处。
const TAP_FD = 1

let deliveryFailureReported = false
function say (line) {
  const text = line + '\n'
  // 投递契约（C10-007）：**只有 fd 1 写成功才算投递**。
  // TAP_FD 就是 fd 1（C10-040：dup 尝试在 tap-runner 的 socketpair 下恒 ENXIO，已删），
  // 故 [TAP_FD, 1] 是**同一个** stdout 通道。
  // **stderr 不是投递通道**——tap-parser 只解析 stdout。
  // 修复前这里是「任一 fd 写成功即算成功」：fd 1 被 closeSync(1) 关掉后 TAP 点静默改投 fd 2，于是
  // stdout 为空、退出码仍是 0，tap-parser 对空流判 {ok:true, skipReason:'no tests found'} ⇒ 变异体
  // 静默 Survived（假绿）。现在投递失败就**响亮**：stderr 留证（仅为可诊断，不算投递）+ 退出码非零
  // —— tap-runner 的硬规则是「非零退出且解析不到失败测试 ⇒ RuntimeError」，比空流假绿诚实。
  // 三个 fd 全失败（stderr 也写不进去）同样保持非零退出码：这条契约不依赖任何一次写成功。
  let lastError = null
  for (const fd of [TAP_FD, 1]) {
    try {
      fs.writeSync(fd, text)
      return true
    } catch (err) {
      lastError = err
    }
  }
  process.exitCode = 1
  // 一个点三行都写不进去，证据只留一条（三行重复只会把 stderr 刷成噪音）
  if (!deliveryFailureReported) {
    deliveryFailureReported = true
    try {
      fs.writeSync(2, `tap-shim: TAP 点无法投递到 stdout（fd 1 不可写：${lastError && lastError.code ? lastError.code : 'unknown'}）` +
        '——空 stdout 会被 tap-parser 判 ok:true，故按投递失败置非零退出码\n')
    } catch { /* stderr 也不可写：退出码已非零，不需要再留证 */ }
  }
  return false
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

// 2) 跳过判定：与 run_unit_tests.js 的 UNIT_SUITES 过滤严格同源。
//    返回 { skip, fatal } 两个**互斥**结果，语义不能混用：
//      skip  = 「本文件不该在本入口运行」（与 command 档同源的正常语义）⇒ ok # SKIP + exit 0
//      fatal = 适配层自身失效（读不到注册表）⇒ not ok + exit 1
//    C10-038：旧实现把 fatal 也当 skip 返回，于是「读不到注册表」变成 `ok # SKIP` + exit 0，
//    与这里的注释（fail-closed）正相反——tap-parser 会把那条记成**通过**，适配层失效在 TAP 档里
//    与全绿无法区分。
function resolveSkip (file) {
  const SKIP = (reason) => ({ skip: reason, fatal: null })
  const FATAL = (reason) => ({ skip: null, fatal: reason })
  if (!file) return { skip: null, fatal: null }
  let suites
  try {
    // C10-039：CI 生产档里 tap-runner 的 nodeArgs 是**真实仓库**的绝对路径（stryker.tap.config.js），
    // 所以这里解析到的也是真实仓库的 test_suites.js——不是「沙箱那份」。只有本套件的探针/夹具把
    // shim 复制进 <sandbox>/scripts/ 时，相对路径才会落到 <sandbox>/test_suites.js（夹具注册表）；
    // 沙箱副本与真实仓库同 commit、同内容，两条路径在 CI 下不改行为。
    // 用**字面量相对路径**（相对本模块文件解析 ⇒ <shim 所在根>/test_suites.js）：既避免 './test_suites'
    // 误解析到 scripts/ 下（不存在）而静默失败，也避免 `require(<变量>)` 触发静态分析告警
    // （Codacy「dynamically import a module by calling require using a non-literal string」）。
    suites = require('../test_suites.js').SUITES
  } catch (err) {
    // 读不到注册表就无法保证「跳过集合与 command 档一致」——fail-closed：判红（not ok + 非 0 退出），
    // 绝不静默放行成「跳过」。
    return FATAL(`无法读取 test_suites.js（${err.message}）；跳过集合无法与 command 档对齐`)
  }
  if (!Array.isArray(suites)) return FATAL('test_suites.js 未导出 SUITES 数组（跳过集合无法与 command 档对齐）')
  const suite = suites.find(s => s.file === file)
  if (!suite) return SKIP('未注册进 test_suites.js（run_unit_tests.js 同口径：不在 SUITES 即不运行）')
  const skipSuites = new Set((process.env.SKIP_SUITES || '').split(',').map(s => s.trim()).filter(Boolean))
  if (skipSuites.has(file)) return SKIP(`SKIP_SUITES 显式跳过（SKIP_SUITES=${process.env.SKIP_SUITES}）`)
  if (suite.integration) return SKIP('integration（run_unit_tests.js 同口径排除）')
  if (suite.mutationSkip) return SKIP('mutationSkip（Stryker 沙箱内不可运行：行数元校验误报）')
  return { skip: null, fatal: null }
}

// 三个 TAP 行必须**全部**投递成功才算这一个测试点被投递（部分投递 = 残缺 TAP 流，同样不可信）。
let deliveredPoints = 0
let pointEmitted = false
function emitPoint (ok, note) {
  // note 必须压成**单行**：它可能来自 err.message（带 "Require stack:" 与多行栈），直接拼进 TAP 点
  // 会把一个测试点撕成多行、plan(1..1) 与 extra 行错位（C10-038 实测：旧实现在该沙箱里正是如此）。
  const suffix = note === undefined || note === null ? '' : ` # ${String(note).replace(/\s+/g, ' ').trim()}`
  const delivered = [
    say('TAP version 13'),
    say(`${ok ? 'ok' : 'not ok'} 1 - ${testFileName || 'unknown'}${suffix}`),
    say('1..1')
  ]
  pointEmitted = true
  const allDelivered = delivered.every(Boolean)
  // C10-008：空 TAP 流的真实判据就是这个计数——tap-runner 对每个测试文件**无条件**合成 1 条
  // TestResult（tapResultToTestResult，id/name 都是文件名），所以报告里的 tests 条数 = 文件数，
  // 空流时照样是 66。「投递了几个点」只有 shim 知道。
  if (allDelivered) deliveredPoints++
  return allDelivered
}

// dry run 判定（C10-008）：tap-runner 的 runFile() 用 `STRYKER_DRY_RUN` 区分 dry run 与变异体跑
// （dist/src/setup/env.cjs: strykerDryRun = 'STRYKER_DRY_RUN'，hook.cjs 按它决定是否删 mutantCoverage）。
// 只有 dry run 写逐文件记录：变异体跑是「文件 × 变异体」重复 spawn 同一批文件，记进去只会淹没证据、
// 也会让「点数」失去「这段测试集产出了几个点」的含义。
// fail-closed：该标志一旦改名 ⇒ 一条记录都不写 ⇒ 摘要按 tapPoints=0 判红并点名「无记录」，
// 宁可响亮误红，也不要静默放行成「测试跑过」（这正是 C10-008 要堵的假绿通道）。
const isDryRun = process.env.STRYKER_DRY_RUN === 'true'

// stryker coverage hook 的产出文件名：与 dist/src/setup/env.cjs 的 tempTapOutputFileName(pid) 同口径
// （`stryker-output-${pid}.json`，写在 spawn 出来的被测进程 cwd）。
const coverageJsonName = `stryker-output-${process.pid}.json`

// (a) 把 tapPoints 写进**已产出**的 coverage JSON。hook.cjs 的 process.on('exit', finalCleanup) 比本
//    文件先注册 ⇒ 退出时它先写、这里后读，读到的就是它刚落的文件（文件头 10-13 行记了这个顺序）。
//    任何失败都只留 stderr 证据、**不动退出码**：tap-runner 拿这个文件当唯一输入（JSON.parse），
//    注解只是附加键，注解本身出问题不该把整段判成 RuntimeError。
function annotateCoverageJson (points) {
  try {
    // 存在性由**这一次读**自己判定，不再先 `existsSync` 探一次：那是 check-then-use——检查与使用之间
    // 路径可被替换（换 inode / 换类型），于是「检查看到的」与「实际读写的」可以不是同一个对象
    // （CodeQL js/file-system-race；本仓同一条规则的先例：scripts/console.js 读锁帧、
    // scripts/mutation-json.js 的 readGuardedBytes）。
    // 语义不变：ENOENT = hook 没产出这个文件（非 tap-runner 环境、或 hook 未被预加载）本是正常路径之一，
    // 旧实现由 `existsSync` 静默返回；现在只看这次读自己的 errno。其它错误照旧交给外层 catch：
    // stderr 留证、**不动退出码**。
    let raw
    try {
      raw = fs.readFileSync(coverageJsonName, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      throw err
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    parsed.tapPoints = points
    fs.writeFileSync(coverageJsonName, JSON.stringify(parsed))
  } catch (err) {
    try {
      fs.writeSync(2, `tap-shim: tapPoints 未能写进 coverage JSON（${err && err.code ? err.code : 'unknown'}）——摘要将只依赖 TAP 点记录\n`)
    } catch { /* stderr 也不可写：注解不是判据，不升级为退出码 */ }
  }
}

// (b) 逐文件追加一行记录，供 mutation.yml 的「记录 statusReason 摘要与 TAP 空流表征」步聚合。
//     路径由工作流注入（runner.temp：逐 job 独立、不进缓存也不进 artifact）；未注入时不写——
//     本地直接跑 shim 不落任何文件，也不会在仓库里留下脏文件。
function appendTapPointRecord (points, exitCode) {
  const target = process.env.XBK_TAP_POINTS_LOG
  if (!target || !isDryRun) return
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // 单行小 JSON（< PIPE_BUF）：并发 append 不会互相截断
    fs.appendFileSync(target, JSON.stringify({ file: testFileName || '', points, exit: exitCode }) + '\n')
  } catch (err) {
    try {
      fs.writeSync(2, `tap-shim: TAP 点记录未能写入 ${target}（${err && err.code ? err.code : 'unknown'}）——摘要将看到 0 条记录\n`)
    } catch { /* stderr 也不可写：摘要侧会因「0 条记录」判红，仍然响亮 */ }
  }
}

// 单一出口（C10-008）：投点与落记录必须在**同一处**，且 handler 在模块加载期就注册——
// skip/fatal/无参三个分支会 process.exit 硬退出（阻止被测文件继续执行），分支里注册的 handler
// 根本不会存在；而每条路径都必须留记录，散着注册必然漏一两个分支。
process.on('exit', (code) => {
  if (!pointEmitted) {
    // 正常路径：被测文件已跑完（main module），按退出码投唯一那个 TAP 点。
    emitPoint(code === 0, code === 0 ? undefined : `exit code ${code}`)
    if (foreignTapLines > 0) {
      // 已经转发到 stderr，TAP 流里看不到；这里只是如实留证，供 canary 判断风险面。
      try {
        fs.writeSync(2, `tap-shim: 正文里出现过 ${foreignTapLines} 行 TAP 形状输出（已转发到 stderr，未污染 TAP 流）\n`)
      } catch { /* stderr 不可写：留证降级，不影响退出码 */ }
    }
  }
  annotateCoverageJson(deliveredPoints)
  // 退出码用 process.exitCode 优先：投点失败时 say() 会在本 handler 里把它置 1，而 'exit' 事件带的
  // code 是 process.exit() 的入参（硬退出那条路径上仍是 0）——记录里必须写**真实**退出码，
  // 否则「投递失败」在记录里会伪装成「正常退出、只是 0 个点」。
  appendTapPointRecord(deliveredPoints, process.exitCode == null ? code : process.exitCode)
})

const decision = resolveSkip(testFileName)

if (!testFileName) {
  // argv[1] 缺失，适配层没被 tap-runner 正确调用，必须响亮失败（否则静默变成「全绿」）。
  emitPoint(false, 'tap-shim 无法从 argv[1] 取到被测文件')
  process.exitCode = 1
} else if (decision.fatal) {
  // 适配层失效：not ok + 非 0 退出（tap-runner 记 RuntimeError ⇒ 响亮），且**不执行**被测文件——
  // 跳过集合无法与 command 档对齐时照跑，等于让 TAP 档的测试集与 command 档悄悄分叉。
  emitPoint(false, decision.fatal)
  process.exit(1)
} else if (decision.skip) {
  // 跳过点也必须真的投递出去：投递失败时不能用 process.exit(0) 把 say() 置的非零退出码盖掉
  // （C10-007：空 stdout + exit 0 会被 tap-parser 判 ok:true）。
  const delivered = emitPoint(true, `SKIP ${decision.skip}`)
  process.exit(delivered ? 0 : 1)
}
// 正常路径无需注册任何东西：上方模块加载期注册的单一 exit handler 会在被测文件跑完后投点 + 落记录。
