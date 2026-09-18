'use strict'

const os = require('os')

const requestedConcurrency = Number(process.env.STRYKER_CONCURRENCY || 2)
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, Math.max(1, os.cpus().length))
  : 2

module.exports = {
  testRunner: 'command',
  commandRunner: {
    // 变异测试使用全量单元测试入口（run_unit_tests.js，覆盖全部未标记 integration/mutationSkip
    // 的单元测试套件），而非仅 test_filter.js。
    // 此前只跑 test_filter.js 导致 PR #100/#101 新增的 238 项测试对变异分数完全无效（issue #106）。
    // PERF_MS=3000：放宽 test_filter.js 性能断言阈值（默认 500ms）。Stryker 沙箱内的插桩与变异
    // 开销会拖慢执行，不放宽则性能断言会因沙箱开销误失败（并可能触发 commandRunner 超时），
    // 使初始/变异运行无法建立基线。注意：它规避的是沙箱内的误失败/超时，与变异体 Killed 判定无关
    // （Killed 取决于断言能否捕获行为差异，而非性能计时）。
    // XBK_MUTATION_CHILD=1 / SKIP_SUITES=：必须与 CI（mutation.yml 的 step env）及 run_mutation.js 的
    // spawn 同口径，否则本地 `npm run test:mutation` 与 CI 变异路径不等价：
    //   - SKIP_SUITES 被 shell 继承时，run_unit_tests.js 会静默少跑套件（分数与 CI/日报不可比）；
    //   - 缺 XBK_MUTATION_CHILD=1 时 run_unit_tests.js 的防重入守卫失效，test_run_mutation_cli.js /
    //     test_run_mutation_race.js 会在每个变异体里再执行一整轮嵌套单元测试（120s 超时）与 2.2s 时序断言。
    // 跨平台（PR 评审 #140）：不用 POSIX 内联赋值（Windows cmd 下会把 XBK_MUTATION_CHILD=1 当成可执行名），
    // 改由 scripts/mutation-child.js 在 process.env 上设置同样三个变量后加载 run_unit_tests.js。
    command: 'node scripts/mutation-child.js'
  },
  mutate: [
    'xbk_function_v3.js',
    'xbk_app.js',
    'xbk_filter.js',
    'xbk_formatter.js',
    'xbk_message_store.js',
    'xbk_network.js',
    'xbk_pusher.js',
    'xbk_rules.js',
    'xbk_utils.js',
    'xbk_agents.js',
    'xbk_http.js',
    'xbk_sendNotify_slim.js',
    'xbk_storage.js',
    'xbk_loop.js',
    'xbk_failure_policy.js',
    'qinglong/xbk_push.js',
    'scripts/check-deps.js',
    // scripts/status.js 是运行时生产模块：被 qinglong/xbk_push.js 顶层无条件 require
    // （--status 诊断与常驻入口的加载链上都会执行）。此前漏列 → 该文件零变异覆盖，且与
    // scripts/check-mutation-ranges.js 的 productionFiles 缺口同源（审查 F-01）。
    'scripts/status.js'
  ],
  coverageAnalysis: 'off',
  // 纯 JS 项目无需类型检查注入。CI run #120 根因：ranges 行数元校验
  // （test_mutation_ranges / check-mutation-ranges）在 Stryker 沙箱内误报——同一次运行里
  // 两类行数扰动叠加：
  //   ① 被 --mutate 的目标文件被插桩注入，行数大幅膨胀（如 426→704，主因，见 mutationSkip）；
  //   ② Stryker 默认往沙箱文件首行插 "// @ts-nocheck"，使每个文件多 +1/+2 行（如 426→427）。
  // 本项关闭 ②（消除头部注入）；① 由 run_unit_tests.js 的 mutationSkip（跳过两个元校验套件）
  // 处理。二者是双保险：主修复是 mutationSkip，disableTypeChecks:false 为补充保险。
  disableTypeChecks: false,
  concurrency,
  // timeoutMS 语义（Stryker 官方口径）：单个变异体单次测试运行的真实超时时间为
  //   netTimeMs * timeoutFactor + timeoutMS + overheadMs
  // （timeoutFactor 默认 1.5，timeoutMS 默认 5000）。timeoutMS 是该公式里的【加法偏移项】，
  // 作用于每个变异体的每次测试运行——它既不是「每条命令的硬上限」，也不是「整轮
  // run_unit_tests.js 的上限」。
  // 加大该项，是为在 run_unit_tests.js（全量单元套件表、含 463KB 的 test_filter.js）叠加
  // Stryker 沙箱插桩/变异开销的场景下，给每次运行留出足够的加法偏移，避免慢套件过早超时。
  // 注意：mutation-report.js 把 Timeout 计入 score 分子（见 scripts/mutation-report.js:103、
  // :179 的 (killed + timeout) / total），因此过早超时并非“假存活被排除”，反而会把慢速
  // 存活变异体也计入 detected、虚增报告分数（掩盖真实存活）。
  // 值维持 300000ms（300s）：作为加法偏移给多套件 + 插桩场景留足余量，无需下调。
  // 历史：90s → 180s（v3.273 切全量单元入口）→ 300s。
  timeoutMS: 300000,
  // thresholds：显式写出取值，避免读者误以为「没有该项 = 有门禁」。break=65 是**真门禁**（不再是观察项）。
  // 判定与退出码路径（已安装的 @stryker-mutator/core@10.0.0 实证）：
  //   reporters/mutation-test-report-helper.js 的 determineExitCode()——break 为数字且
  //   mutationScore < break 时调用 objectUtils.setExitCode(1)（该 helper 只写 process.exitCode = 1，
  //   stryker 进程随后以 1 退出；判定是**严格小于**，恰好等于阈值放行）。
  // 判定范围是**按段**的：mutation.yml 每个矩阵 job 各自跑 `npx stryker run --mutate "<段>"`
  //   （--mutate 见 stryker-cli.js 的 `-m, --mutate`，覆盖本文件的 mutate 数组），而上面那个 metrics
  //   来自本次运行的报告 files——只含该段被变异的文件 ⇒ 分数低于 65 的是**那一个段的 job**
  //   （fail-fast: false ⇒ 其余段照跑；artifact 上传与 report job 都是 if: always() ⇒ 日报照发）。
  // 取值依据（实测日报 gh issue 130/135/139/148/150/153，2026-09-13…09-18 六天）：
  //   09-18 基线：合计 81.27%（13355 变异体 / 2502 存活），最低段 message-store 69.38%，
  //   其后 status 70.77%、utils 72.36%、app 75.43%。
  //   取 65 = 当前最低段之下再留 4.38 个百分点 ⇒ 按 09-18 基线**没有任何一段会误红**。
  //   这六天里各段分数只随代码/测试变化，没有逐轮抖动：最弱段 message-store 全程 69.10%–69.42%
  //   （极差 0.32pp），故 65 不会被单次运行的波动打穿。窗口内唯一一次低于 65 的是 status 的**首轮**
  //   报告 62.14%（09-16：243 变异体 / 149 被杀 / 92 存活，该段当天才进入矩阵）——那是真弱不是抖动，
  //   次日补测后已到 70.77%。即：本阈值会真红（门禁该有的样子），但红的是真实退化或新段的未覆盖代码。
  //   不取更低（如 60）的理由：message-store 要再掉 9.1pp 才触发，门禁接近失效；且 60 已是 high/low 里的
  //   low（配色语义），把 break 与它对齐会让两个语义混为一谈。
  //   不贴着 69.38 取 69 的理由：该分数的计分口径把超时计入已检出（见上方 timeoutMS），贴边只会误红。
  // 与日报脚本分数的关系：上述六份日报里每段都满足 total == killed+timeout+survived+noCoverage
  //   （即没有 RuntimeError/CompileError/Ignored/Pending 变异体）⇒ 实跑中两个口径的分数相等；
  //   一般情形下日报分数是 stryker 分数的**下界**（日报分母 total 含上述四类，stryker 的 totalValid 不含），
  //   故按日报基线取的阈值在 stryker 侧只会更安全。
  // 回退：把 break 改回 null 即取消分数门禁，不涉及任何其它文件。
  // 与「测试被弱化」的关系（PR #156 返工，Qodo High / Correctness）：本门禁曾有一个真实缺口——
  //   增量缓存 key 不含测试侧指纹，而 command runner 只支持 coverageAnalysis:'off'、incremental-differ
  //   在拿不到覆盖信息时直接复用全部旧结果，于是「只删/弱化测试」会带着**按旧测试算出的** killed/survived
  //   过门禁。该缺口已由 mutation.yml 的「恢复增量缓存」step 关闭：测试侧指纹（scripts/mutation-child.js /
  //   run_unit_tests.js / test_suites.js / test_suite_registry.js / 全部 test_*.js）同时进 key 与
  //   restore-keys 前缀（前缀语义决定了测试段必须排在源段之前）⇒ 测试一变就没有旧基线可复用，
  //   必须全量重跑并按新测试重新计分。
  //   残余边界（与缓存无关，属任何「分数门禁」的固有性质，勿据此认为门禁无效）：门禁判定的是**分数**，
  //   若弱化测试后新跑一轮的分数仍 ≥ 65，门禁照样绿——它拦的是「分数真的掉下来」，不是「测试被人改过」。
  //   另见上方 timeoutMS 注释：(killed + timeout) 把超时计入分子，慢到超时的存活体在分数上算「已检出」，
  //   故该分数不是严格的漏检率——这也是把阈值放在最低段之下 4.38 个百分点、而不是贴着 69.38 的原因。
  thresholds: { high: 80, low: 60, break: 65 },
  // reporters：'json' 是报告链的硬依赖，不可随手删——scripts/mutation-report.js 经 scripts/mutation-json.js
  // 读 reports/mutation/mutation.json。本文件刻意不写 jsonReporter.fileName/htmlReporter.fileName，靠
  // Stryker 默认值（reports/mutation/mutation.json、reports/mutation/mutation.html）与 mutation.yml 的 artifact
  // 路径、scripts/mutation-report.js 的查找口径隐式对齐；'clear-text' 供 CI 日志阅读。
  // 体积（审查 F-04；PR #156 已落地处理）：command runner 把每个变异体的整段测试输出写进 statusReason，
  // 单个 mutation.json 可达 500MB+（见 scripts/mutation-json.js:2-6 的自述）。该体积已在
  // .github/workflows/mutation.yml 里收敛：上传前对 reports/mutation/mutation.json 落盘剥离
  // statusReason（全仓消费方经 readReportJson 本就把该字段读成空串 ⇒ 门禁语义零变化），artifact 只带
  // reports/mutation/（机器报告 + 给人看的 html），增量基线 reports/inc-*.json **刻意不剥离**、仍随
  // actions/cache 保存——剥掉它会让被增量复用的变异体在后续运行的 JSON/HTML 里永远解释不了当初为什么
  // 存活/报错（Qodo Medium / Observability，PR #156 返工）。此处只把「json reporter 不可删」的耦合与
  // 体积口径写明，避免后人误删 reporter，或误以为体积问题与 reporter 选择无关。
  reporters: ['clear-text', 'html', 'json'],
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
  // 这些目录不是源码/测试输入；尤其 .tools 中的 Python venv 含 lib64 符号链接，
  // 不排除会导致 Stryker 沙箱复制时报 EISDIR。
  ignorePatterns: [
    '.tools',
    'xianbaoku_cache*',
    'reports',
    '*.bundle'
  ]
}
