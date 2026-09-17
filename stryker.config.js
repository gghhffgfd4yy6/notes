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
  // thresholds：显式写出取值，避免读者误以为「没有该项 = 有门禁」。break 刻意保持 null——本仓库
  // `npm run test:mutation` 定位为本地观察项而非门禁，且 (killed + timeout) 的计分口径会虚增分数
  // （见上方 timeoutMS 注释），阈值边界上只会误红；CI 侧同样只出日报（mutation.yml 的 report job
  // 不设阈值）。若要改为真正的门禁，请先按当前真实基线取 break 值再开。
  thresholds: { high: 80, low: 60, break: null },
  // reporters：'json' 是报告链的硬依赖，不可随手删——scripts/mutation-report.js 经 scripts/mutation-json.js
  // 读 reports/mutation/mutation.json。本文件刻意不写 jsonReporter.fileName/htmlReporter.fileName，靠
  // Stryker 默认值（reports/mutation/mutation.json、reports/mutation/mutation.html）与 mutation.yml 的 artifact
  // 路径、scripts/mutation-report.js 的查找口径隐式对齐；'clear-text' 供 CI 日志阅读。
  // 代价（审查 F-04，low）：command runner 把每个变异体的整段测试输出写进 statusReason，单个
  // mutation.json 可达 500MB+（见 scripts/mutation-json.js:2-6 的自述），而 .github/workflows/mutation.yml
  // 仍把整个 reports/ 当缓存（「恢复增量缓存」step 的 path: reports）与 artifact（「上传变异报告」step 的
  // path: reports/）的载体——18 段各自 restore/save/上传数百 MB，拖慢归档并挤压同仓库其它缓存。
  // 真正的体积收敛必须改 workflow（缓存只留 reports/inc-*.json，或在缓存/上传前先接入
  // scripts/mutation-json.js 的现成剥离实现），属跨文件改动，本次未落地；此处只把「json reporter 不可删」
  // 的耦合与已知代价写明，避免后人误删 reporter，或误以为体积问题与 reporter 选择无关。
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
