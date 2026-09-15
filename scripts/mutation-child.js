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

// 字面量 require：路径按模块解析规则相对本文件确定（scripts/ → 仓库根），
// 既跨平台，也避开「非字面量 require / 动态拼接路径」两类静态误报（Codacy #140 告警项）。
require('../run_unit_tests.js')
