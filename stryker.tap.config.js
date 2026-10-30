'use strict'
require('./scripts/mutation-run-guard.js').assertLocalMutationAllowed()

// ── C10-010：TAP 档的跳过集合**由本文件强制清空**，不再依赖「CI 的 step env 没设 SKIP_SUITES」这条假设。
//   command 档的同源做法在 scripts/mutation-child.js：require run_unit_tests.js 之前写死
//   `process.env.SKIP_SUITES = ''`。TAP 档不经该脚本（tap-runner 逐文件 spawn 测试文件），而 tap-runner 的
//   runFile() 给子进程的环境是 `{ ...process.env, <STRYKER_* 标志> }`（tap-runner 的
//   dist/src/tap-test-runner.js，runFile 里 `childProcess.spawn('node', args, { env })`），且 tap-runner 由
//   Stryker 主进程在**配置加载之后**逐文件 spawn ⇒ 在这里清空 process.env 就等于清空整个 TAP 档。
//   修前本文件只在注释里声明「SKIP_SUITES 在变异场景恒为空串……CI 的 step env 亦未设置该变量」：那是
//   **环境假设**，而这个变量就活在仓库自己的 test.yml 单元步骤里（job/step 层继承即可带进来）。一旦带进来，
//   TAP 档会静默少跑套件：下方显式 testFiles 清单与 perTest 覆盖归因随 command 档分叉，两档分数不可比，
//   而且没有任何信号（tap-shim 会把被跳过的文件如实记成 `ok # SKIP`，满屏皆绿）。
//   判据只看清空后的值：继承到非空值 → 清空 + stderr 留一行证据（带原值，便于定位是谁设的），不清空即红
//   （test_ci_skip_suites.js 的 3k 用真子进程跑真配置锁定本条）。
//   纵深防御：mutation.yml 的「变异测试」step 显式写 `SKIP_SUITES: ''`（step 级 env 覆盖上层继承值）。
const inheritedSkipSuites = process.env.SKIP_SUITES
if (inheritedSkipSuites) {
  process.env.SKIP_SUITES = ''
  try {
    process.stderr.write(`stryker.tap.config.js: 忽略继承的 SKIP_SUITES=${inheritedSkipSuites}（TAP 档恒不跳过任何套件，与 command 档一致）\n`)
  } catch { /* stderr 不可写：清空已生效，留证降级不影响判据 */ }
}
// ============================================================
// TAP 档 Stryker 配置（**CI 生产档**）
//
// 由 .github/workflows/mutation.yml 的「变异测试」step 以位置参数加载
// （Stryker 10 的 configFile 是**位置参数**，没有 --configFile 选项——实测见 .local/g1-smoke/REPORT.md 坑 1）：
//   npx stryker run stryker.tap.config.js --mutate "<段>" --incremental \
//     --incrementalFile reports/inc-<段>.json --concurrency 8 --fileLogLevel info
//
// 分叉（**有意为之，不是遗漏**）：本地 `npm run test:mutation` 仍走 command 档 `stryker.config.js`；
//   本文件只给 CI 用。两档的**测试集必须一致**（由下方加载期断言保证），差异只在 runner 与覆盖分析：
//   testRunner: 'tap' + coverageAnalysis: 'perTest'。perTest 是 TAP 提速的前提（实测 34-37 倍）；
//   反之 command runner 只支持 coverageAnalysis:'off'，会**静默退化**成「每个变异体跑整套件」。
//
// 与 stryker.config.js 的差异只有四项（thresholds/break:null、timeoutMS、concurrency、ignorePatterns、
//   mutate、reporters、tempDirName 等全部继承现值）：
//   1) testRunner: 'tap'、coverageAnalysis: 'perTest'；
//   2) tap: { testFiles, nodeArgs, forceBail } —— 键名必须是 `tap`，不是 `tapRunner`（见下）；
//   3) delete commandRunner —— 它只对 command runner 生效，留着会让读者误以为 tap 档还会跑
//      scripts/mutation-child.js（tap 档由 tap-runner 逐文件 spawn node，环境变量来自 step env）；
//   4) jsonReporter/htmlReporter **显式写出 stryker 的默认路径**（取值与 schema 默认逐字相同，
//      写出来只为让「报告必须落默认路径」这条硬约束在配置里可见、可断言）。
//
// 报告路径**必须保持 Stryker 默认值**：reports/mutation/mutation.json、reports/mutation/mutation.html。
//   本文件**显式写出这两个默认值**（而不是省略、依赖 schema 默认）：取值与
//   @stryker-mutator/core/schema/stryker-schema.json:766 的 jsonReporterOptions.fileName.default 逐字相同，
//   写出来只为让这条路径约束在配置里可见、可断言（require 本文件后可直接核对 fileName）。
//   ⚠️ 不得改成子目录（例如 reports/mutation/tap/）。mutation.yml 的 fail-closed 守卫、紧随缓存恢复的
//   `rm -rf reports/mutation`、「记录本段增量复用状态」的 reuse.json 落盘闸门、artifact
//   （path: reports/mutation/ + if-no-files-found: error）与 .github/workflows/analyze-artifacts.yml
//   全部按默认路径对齐，路径一变整条链路断（守卫读不到报告 ⇒ 段 job 假红/假绿，artifact 变空 ⇒ 汇总缺段）。
//
// 增量/复用链路**原样保留**（保守路径的锁定决策）：本配置不设 `incremental` / `incrementalFile` 键，
//   由工作流传 `--incremental --incrementalFile reports/inc-<段>.json`；缓存 key、reuse.json、日报
//   「♻️ 复用状态」小节全部不动。注意 perTest 下 incremental-differ 能拿到覆盖信息（不再走
//   `!testCoverage.hasCoverage ⇒ 无条件复用` 那条分支）。该交互**已在 CI 实测**（`d34cf5b` / run 35639202819：
//   恢复 inc 后 TAP 段 133/133、2651/2651、2402/2402、391/391 全部复用）——此前「未在 CI 上实测过」的表述不实，本轮更正；
//   本轮仍不据此改分数口径。
// ============================================================
const path = require('node:path')
const { SUITES } = require('./test_suites')

// tap-runner 的 testFiles 不支持取反 glob（glob 不支持 ! 排除），因此用**显式清单**。
// 清单必须与 command 链（stryker.config.js 的 commandRunner -> scripts/mutation-child.js ->
// run_unit_tests.js 的 UNIT_SUITES）完全一致：SUITES 过滤掉 integration / mutationSkip；
// SKIP_SUITES 在变异场景恒为空串，且**由本文件顶部那段代码强制**，不是靠「CI 的 step env 没设它」这条
// 环境假设（C10-010）：配置加载期就把继承到的非空值清空，tap-runner 逐文件 spawn 时按 {...process.env}
// 继承 ⇒ 整档的跳过集合恒为空。故这里按「无显式跳过」推导。
const commandChainTestFiles = SUITES
  .filter(s => !s.integration && !s.mutationSkip)
  .map(s => s.file)

// 显式清单：与上方推导**逐元素**（含顺序）一致。顺序即 SUITES 注册顺序，
// 与 run_unit_tests.js 的执行顺序一致（tap 档 dry-run 按 testFiles 顺序逐文件 spawn）。
// 「清单硬编码 + 加载时断言 + 不一致即 throw」是有意的双重防线：将来 test_suites.js
// 增删套件而忘记同步本清单时，配置加载立刻响亮失败，而不是静默少跑/多跑套件
// （少跑 ⇒ 分数虚高且与 command 档不可比；多跑 ⇒ 跑起 command 档不跑的套件）。
const explicitTestFiles = [
  'test_check_deps.js',
  'test_loop_utils.js',
  'test_storage.js',
  'test_failure_policy.js',
  'test_agents.js',
  'test_network.js',
  'test_http.js',
  'test_sendnotify_utils.js',
  'test_pusher.js',
  'test_qinglong_utils.js',
  'test_status_report.js',
  'test_rules.js',
  'test_utils.js',
  'test_utils_pure.js',
  'test_formatter.js',
  'test_rules_extended.js',
  'test_message_store_utils.js',
  'test_sendnotify_pure.js',
  'test_sendnotify_bodylimit.js',
  'test_filter.js',
  'test_mutation_json.js',
  'test_mutation_report.js',
  'test_local_mutation_guard.js',
  'test_mutation_report_cli.js',
  'test_analyze_artifacts.js',
  'test_run_mutation.js',
  'test_run_mutation_internal.js',
  'test_run_mutation_cli.js',
  'test_run_mutation_race.js',
  'test_ci_skip_suites.js',
  'test_suite_registry.js',
  'test_host_clean_gates.js',
  'test_tag_validator.js',
  'test_check_version.js',
  'test_app_unit.js',
  // G11：与 test_suites.js 的注册顺序一致 —— 追加在末尾（本套件非 integration/mutationSkip）。
  'test_audit_gate.js',
  // v3.284：与 test_suites.js 注册顺序一致 —— 追加在末尾（本套件非 integration/mutationSkip）。
  'test_console.js',
  // v3.301：与 test_suites.js 注册顺序一致 —— 追加在末尾（本套件非 integration/mutationSkip）。
  'test_notify_selfcheck.js',
  // S1-store：与 test_suites.js 注册顺序一致 —— 追加在末尾（本套件非 integration/mutationSkip）。
  'test_filter_store.js'
]

function listDiff (expected, actual) {
  const missing = expected.filter(f => !actual.includes(f))
  const extra = actual.filter(f => !expected.includes(f))
  const mismatch = expected.some((f, i) => actual[i] !== f)
  const parts = []
  if (missing.length) parts.push(`显式清单缺少（注册表有）：${missing.join(', ')}`)
  if (extra.length) parts.push(`显式清单多余（注册表没有）：${extra.join(', ')}`)
  if (mismatch && !missing.length && !extra.length) parts.push('元素相同但顺序与 SUITES 注册顺序不一致')
  return parts.join('；')
}

const diff = listDiff(commandChainTestFiles, explicitTestFiles)
if (diff) {
  throw new Error(
    'stryker.tap.config.js 的 tap.testFiles 显式清单与 test_suites.js 推导清单不一致，' +
    `两档测试集将不可比。差异：${diff}。请同步修正显式清单或 test_suites.js（integration/mutationSkip 标记）。`
  )
}

const base = require('./stryker.config.js')

const tapConfig = {
  ...base,
  testRunner: 'tap',
  coverageAnalysis: 'perTest',
  // 键名必须是 `tap`：tap-runner@10.0.0 的 init()/runFile() 读的是 options.tap.testFiles/nodeArgs/forceBail
  // （dist/src/tap-test-runner.js，已从 unpkg 发布版核对）；写 `tapRunner` 会被 stryker 当未知选项静默忽略
  // ⇒ testFiles 落回默认 glob（匹配不到 test_*.js）⇒ dry run 0 文件 ⇒ "No tests were executed"
  // （canary 首轮实测，run 35589171019；与 .local/g1-smoke/REPORT.md 坑 6 的已验证口径 tap.testFiles 一致）。
  // 这是本文件最容易踩的坑：`tapRunner` ≠ `tap`，拼错**没有任何报错**，只是静默不跑测试。
  tap: {
    testFiles: explicitTestFiles,
    // shim 必须用**配置加载时的绝对路径**（path.resolve 于仓库根 scripts/）：
    // tap-runner 以 node -r <hook> -r <shim> <testFile> 逐文件 spawn，被测进程 cwd 是 stryker
    // 沙箱，相对路径 './scripts/tap-shim.js' 会按沙箱 cwd 解析而找不到（实测，REPORT 坑 2）。
    // 绝对路径指向**真实仓库**的 shim，对「scripts/ 是否进沙箱」这一沙箱复制策略免疫。
    nodeArgs: ['-r', path.resolve(__dirname, 'scripts', 'tap-shim.js')],
    // forceBail 只传进**单个测试文件**的 tap-parser config.bail（unpkg dist/src/tap-helper.js 的
    //   parseTap(tapProcess, forceBail) ⇒ new TapParser.Parser({ bail: forceBail }, …)）；**跨测试文件**
    //   是否因首个失败提前收工由 Stryker 顶层的 disableBail 决定（默认 false ⇒ 不提前收工）。这里显式
    //   写 false 是为了让「单文件内也不因首个失败而 bail」与 command 档「跑完全部相关套件、拿完整结果」
    //   的语义对齐（守卫按 runtimeErrors 判、日报按每段全量统计，都需要完整结果）。
    forceBail: false
  }
}

// 报告路径：显式写出 stryker 的**默认**值（不是改路径）。mutation.yml 的 fail-closed 守卫、清理步、
// reuse.json 落盘闸门、artifact 与 analyze-artifacts 全部按这两个路径对齐，改这里等于断链。
tapConfig.jsonReporter = { fileName: 'reports/mutation/mutation.json' }
tapConfig.htmlReporter = { fileName: 'reports/mutation/mutation.html' }

// commandRunner 只对 command runner 生效；tap 档显式删掉，避免读者误以为 tap 档还会跑
// scripts/mutation-child.js（tap 档由 tap-runner 逐文件 spawn node，环境变量来自 step env）。
delete tapConfig.commandRunner

module.exports = tapConfig
