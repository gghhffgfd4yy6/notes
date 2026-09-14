'use strict'
// ============================================================
// 变异测试跨平台子入口（PR 评审 #140）
//
// stryker.config.js 原先用 POSIX 内联赋值（XBK_MUTATION_CHILD=1 SKIP_SUITES= PERF_MS=3000 node
// run_unit_tests.js），在 Windows cmd 下会把 XBK_MUTATION_CHILD=1 当成可执行文件名而直接失败。
// 改为由本脚本在 process.env 上设置同样的变量、再加载 run_unit_tests.js，跨平台一致。
//
// 用法：node scripts/mutation-child.js   （由 stryker 的 commandRunner 调用；也可手工运行）
// ============================================================
process.env.XBK_MUTATION_CHILD = '1'
process.env.SKIP_SUITES = ''
process.env.PERF_MS = '3000'

require(require('path').join(__dirname, '..', 'run_unit_tests.js'))
