'use strict'

const os = require('os')

const requestedConcurrency = Number(process.env.STRYKER_CONCURRENCY || 2)
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, Math.max(1, os.cpus().length))
  : 2

module.exports = {
  testRunner: 'command',
  commandRunner: {
    // 变异测试使用全量单元测试入口（run_unit_tests.js，26+套件），而非仅 test_filter.js。
    // 此前只跑 test_filter.js 导致 PR #100/#101 新增的 238 项测试对变异分数完全无效（issue #106）。
    // PERF_MS=3000：变异测试开销下放宽 test_filter.js 性能断言阈值（默认500ms），避免误判 Killed。
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
  // 纯 JS 项目无需类型检查注入；Stryker 默认往沙箱文件首行插 "// @ts-nocheck"，
  // 会使 test_mutation_ranges 在沙箱里数出的行数 +1/+2（426→427），初始测试必红（CI run #120 根因）。
  disableTypeChecks: false,
  concurrency,
  // timeoutMS 是每次 commandRunner（即整轮 run_unit_tests.js）的上限。
  // 每轮要跑 25 个单元套件（含 463KB 的 test_filter.js），180s 余量不足 2×：
  // 一旦单轮耗时逼近上限，Stryker 会把变异体判为 Timeout（假存活），
  // 反而不计入 Killed，污染变异分数与门禁结论。
  // 故提高到 300000ms（300s），留出 ≥2× 余量以吸收性能抖动导致的误判。
  // 历史：90s（v3.273 前）→ 180s（v3.273 切全量单元入口后）→ 300s。
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
