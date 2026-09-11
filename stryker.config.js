'use strict'

const os = require('os')

const requestedConcurrency = Number(process.env.STRYKER_CONCURRENCY || 2)
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, Math.max(1, os.cpus().length))
  : 2

module.exports = {
  testRunner: 'command',
  commandRunner: {
    // 变异测试使用全量单元测试入口（run_unit_tests.js，25 个单元套件），而非仅 test_filter.js。
    // 此前只跑 test_filter.js 导致 PR #100/#101 新增的 238 项测试对变异分数完全无效（issue #106）。
    // PERF_MS=3000：放宽 test_filter.js 性能断言阈值（默认 500ms）。Stryker 沙箱内的插桩与变异
    // 开销会拖慢执行，不放宽则性能断言会因沙箱开销误失败（并可能触发 commandRunner 超时），
    // 使初始/变异运行无法建立基线。注意：它规避的是沙箱内的误失败/超时，与变异体 Killed 判定无关
    // （Killed 取决于断言能否捕获行为差异，而非性能计时）。
    command: 'PERF_MS=3000 node run_unit_tests.js'
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
    'qinglong/xbk_push.js'
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
  // 加大该项，是为在 run_unit_tests.js（25 个单元套件、含 463KB 的 test_filter.js）叠加
  // Stryker 沙箱插桩/变异开销的场景下，给每次运行留出足够的加法偏移，避免慢套件过早超时。
  // 注意：mutation-report.js 把 Timeout 计入 score 分子（见 scripts/mutation-report.js:103、
  // :179 的 (killed + timeout) / total），因此过早超时并非“假存活被排除”，反而会把慢速
  // 存活变异体也计入 detected、虚增报告分数（掩盖真实存活）。
  // 值维持 300000ms（300s）：作为加法偏移给多套件 + 插桩场景留足余量，无需下调。
  // 历史：90s → 180s（v3.273 切全量单元入口）→ 300s。
  timeoutMS: 300000,
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
