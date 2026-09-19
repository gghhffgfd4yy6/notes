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
  // thresholds：显式写出取值，避免读者误以为「没有该项 = 有门禁」。
  // break = null（**当前没有分数门禁**，这是诚实的现状，不是「忘了配」）：该值曾取 65，其依据已被实测证伪，
  //   故撤回（2026-09-19）。下面写清「为什么撤回 / 什么时候可以重新标定 / 撤回后故障信号由谁承担」。
  //
  // 为什么撤回（三条独立证据）：
  //   ① 分数在当前测试噪声下**不可复现**：同配置、同 commit、同段（storage，tap 口径）三轮实测
  //      79.08% / 82.92% / 71.02%，极差 **11.90pp**；三轮的 noCoverage 均为 34、coveredBy 均为 285/285
  //      一致 ⇒ 抖动不来自变异覆盖面变化，而来自测试自身（同一批变异体的判死/判活口径本身不稳定）。
  //      11.9pp 的抖动大于任何「阈值与基线之间的余量」，固定阈值只会随噪声误红/误绿——那不是门禁。
  //   ② 历史基线本身是虚高的：「六天窗口最低段 message-store 69.38%」以及「取 65 = 最低段之下再留
  //      4.38 个百分点」这套等式**已证伪，勿再引用**。那些日报分数混入了三种污染：**陈旧增量复用**
  //      （源码/测试未变时直接复用旧 killed/survived）、**无关套件误杀**、**共享缓存串扰**，并非同轮全量结果。
  //      去掉污染后的真实全量为 v3-entry **47.81%**、storage **59.30%**——即按 65 判，这些段（很可能还有更多段）
  //      本就会红；但红的原因是**分数口径不干净**，不是代码退化。故 65 既不是「安全下限」，也不是「真门禁」。
  //   ③ 严格 `<` + NaN 假绿通道（见下）说明「分数门禁」在缺守卫时是**单向失效**的：既会误红，也会假绿。
  //
  // 什么时候可以重新标定（不要现在猜一个数补上去）：先治掉测试抖动（同一 commit、同段、多轮复现同一分数），
  //   并完成 TAP runner 迁移——command runner 只支持 coverageAnalysis:'off'，会**静默退化**为「每个变异体
  //   跑整套 32 个套件」；换 TAP runner 才能拿到 perTest 覆盖信息（实测快 34–37×，属下一个 PR）。届时按
  //   **TAP 口径**重测一轮诚实基线，再据此取 break；在那之前 break 保持 null。
  //
  // 判定与退出码路径（已安装的 @stryker-mutator/core@10.0.0 实证；与取值无关，仍然成立）：
  //   reporters/mutation-test-report-helper.js 的 determineExitCode()——break 为**数字**且
  //   mutationScore < break 时调用 objectUtils.setExitCode(1)（该 helper 只写 process.exitCode = 1，
  //   stryker 进程随后以 1 退出；判定是**严格小于**，恰好等于阈值放行）。break = null 时走 else 分支：
  //   只记一条 debug 日志，**不因分数置退出码**（stryker 仍会因内部错误/崩溃非 0 退出）。
  //   NaN 假绿通道（这正是必须补守卫的原因）：metrics 的 mutationScore 在 totalValid === 0 时是 **NaN**
  //   （mutation-testing-metrics 的 calculateMetrics.js：`const DEFAULT_SCORE = NaN`、
  //   `mutationScore: totalValid > 0 ? (totalDetected / totalValid) * 100 : DEFAULT_SCORE`，
  //   其中 totalValid = killed + timeout + survived + noCoverage）。而门禁判据是
  //   `if (mutationScore < breaking)` ⇒ `NaN < 65 === false` ⇒ **不置退出码 ⇒ job 假绿**。
  //   触发条件：整段全 RuntimeError、整段全 CompileError、或报告里没有任何有效变异体（空报告）。
  //   break = null 之后这条通道本身不再能造成假绿（已无分数门禁），但「全 RuntimeError / 空报告」仍是
  //   必须响的故障信号 ⇒ 由 mutation.yml 的 fail-closed 守卫步骤承担（scripts/mutation-guard.js：
  //   runtimeErrors > 0 或 totalValid === 0 即 exit 1；报告缺失/不可读同样 exit 1）。将来重新标定 break 时，
  //   该守卫是分数门禁的**前置条件**，不得移除。
  //
  // 判定范围是**按段**的（结构事实，与取值无关）：mutation.yml 每个矩阵 job 各自跑
  //   `npx stryker run --mutate "<段>"`（--mutate 见 stryker-cli.js 的 `-m, --mutate`，覆盖本文件的
  //   mutate 数组），而上面那个 metrics 来自本次运行的报告 files——只含该段被变异的文件 ⇒ 将来恢复分数门禁时，
  //   跌破的也只是**那一个段的 job**（fail-fast: false ⇒ 其余段照跑；artifact 上传与 report job 都是
  //   if: always() ⇒ 日报照发）。
  //   high/low（80/60）保留不动：它们只影响 reporter 的配色/日志分级，**不参与退出码**
  //   （determineExitCode 只读 break），没有「随噪声误红」的问题。
  //
  // 与日报脚本分数的关系（口径差异仍然成立）：日报（scripts/mutation-report.js）的分母 total 含
  //   RuntimeError/CompileError/Ignored/Pending，而 stryker 的 totalValid 不含 ⇒ 一般情形下日报分数是
  //   stryker 分数的**下界**。注意这只说明两个口径的**相对**关系，不构成「日报基线可信」的理由——上面 ②
  //   证伪的正是「拿日报基线当阈值依据」这件事。
  // 另见上方 timeoutMS 注释：(killed + timeout) 把超时计入分子，慢到超时的存活体在分数上算「已检出」，
  //   故该分数不是严格的漏检率——这是将来重新标定时必须复算的又一个理由（不因 break = null 而消失）。
  //
  // 与「测试被弱化」的关系（PR #156 返工 → **本 PR 已回退其缓存侧改动**，必须区分开看）：
  //   PR #156 曾给增量缓存 key（及 restore-keys 前缀）加测试侧指纹，意图是「测试一变就无旧基线可复用」。
  //   本 PR **回退了那处改动**（理由见 mutation.yml 的「恢复增量缓存」注释）：它拦不住真根因（假 Killed 来自
  //   共享缓存的并发串扰，发生在**变异体运行期**、基线全程是绿的），且在真正全量下 app/utils/message-store
  //   在 --concurrency 8 下仍需 ~7h/~6.5h/~4.5h、必撞「变异测试」step 的 330min，而失败段不保存缓存进度
  //   ⇒ 那几段永久红。
  //   因此下面这条缺口**重新敞开，且是有意接受的取舍**：coverageAnalysis:'off' 下 incremental-differ 拿不到
  //   覆盖信息时会无条件复用全部旧结果（killed/survived 原样照搬）⇒「只删/弱化测试」可能带着按旧测试算出的
  //   结果继续被复用。之所以接受：**当前没有分数门禁**（break = null）⇒ 复用不构成任何门禁风险，只影响日报数字。
  //   将来重新标定 break 时**必须同时重新评估这一点**：要么恢复测试侧指纹（并先解决「真全量跑不完」），
  //   要么等下一个 PR 的 TAP runner 迁移（届时全量只需几分钟，强制全量不再不可负担）。
  //   另注意（与上面 ② 不是同一件事）：本段说的是「旧结果被复用」，② 说的是「分数口径本身不干净」——
  //   两者都不能靠 break = null 之外的手段掩盖，本轮的处理是：撤回分数门禁 + 用 fail-closed 守卫兜住报告不可信。
  //
  // 与 scripts/mutation-report.js 的分工（保持原样，不得放宽）：分数门禁**不在**日报脚本里——它的 main() 是
  //   先 validateSegments/validateFreshness 再发 Issue，加分数 throw 会在最需要看分数时把日报一起吞掉；
  //   它对「缺段/多余段/重复段/陈旧报告」的 throw（完整性真门禁）保持不变。
  // 回退/恢复路径：本项当前就处于「已回退」状态（break = null）。若要重新启用分数门禁，按上面「什么时候可以
  //   重新标定」走完测试抖动治理 + TAP 迁移，再用 TAP 口径的诚实基线取值；不涉及其它文件的结构改动。
  thresholds: { high: 80, low: 60, break: null },
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
