'use strict'
// ============================================================
// 统一测试入口：一键执行三套测试 + 汇总报告 + 退出码
// 用法：node run_tests.js   （或 npm test）
// 退出码：0 = 全部通过，非 0 = 有失败（CI/调度可感知）
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { checkDependencies } = require('./scripts/check-deps')

const SUITES = [
  { name: '依赖预检', file: 'test_check_deps.js', desc: 'checkDependencies 缺失/损坏分支' },
  { name: '常驻循环', file: 'test_loop.js', desc: '长驻调度、单轮异常隔离、停止信号' },
  { name: '循环工具函数', file: 'test_loop_utils.js', desc: 'sleep 信号/超时边界 + runLoop TypeError/错误隔离' },
  { name: '安全文件存储', file: 'test_storage.js', desc: '原子写入/独占创建/安全读取/符号链接拦截' },
  { name: '常驻失败策略', file: 'test_failure_policy.js', desc: '网络/永久错误分类、持续退避重试、摘要失败和恢复' },
  { name: 'DNS失效回归', file: 'test_dns_cache.js', desc: '连接错误后清除主机 DNS 缓存并重新解析' },
  { name: 'TLS预热回归', file: 'test_tls_prewarm.js', desc: 'TLS 预热 aggregate ok 与连接成功数保持一致' },
  { name: '延迟加载回归', file: 'test_lazy_notify.js', desc: '验证接口请求先于推送模块加载' },
  { name: 'Agent辅助函数', file: 'test_agents.js', desc: 'DNS 失效判定/profile 计时/请求选项/缓存清理' },
  { name: '网络重试', file: 'test_network.js', desc: 'fetchData 重试/4xx 例外/retry 非法值兜底' },
  { name: 'HTTP封装', file: 'test_http.js', desc: 'fetchJson 响应体限流/HTTP 错误/JSON 解析' },
  { name: '推送工具函数', file: 'test_sendnotify_utils.js', desc: 'mdToPlain/脱敏/安全截断/通道统计' },
  { name: '青龙命令行', file: 'test_cli.js', desc: '--check/--dry-run/--status 参数和诊断逻辑' },
  { name: '青龙工具函数', file: 'test_qinglong_utils.js', desc: '退避/刷新计数/间隔/依赖恢复边界/缓存目录' },
  { name: '青龙常驻', file: 'test_qinglong_resident.js', desc: 'refreshConnections DNS/TLS 预热 mock + runResident 正常/permanent/可重试退避' },
  { name: '青龙诊断', file: 'test_qinglong_runcheck.js', desc: 'runCheck 全部通过/过滤警告/init失败/无通道/无方法 五种返回码' },
  { name: '状态面板', file: 'test_status.js', desc: '--status 只读聚合运行状态' },
  { name: '单元测试', file: 'test_filter.js', desc: '主代码导出函数逐函数逻辑' },
  { name: '变异报告读取', file: 'test_mutation_json.js', desc: '超大 mutation.json 剥离 statusReason 解析（v3.264）' },
  { name: '变异报告渲染', file: 'test_mutation_report.js', desc: 'render 函数 markdown 输出快照（v3.266 重构验证）' },
  { name: '变异调度器', file: 'test_run_mutation.js', desc: 'generateMutants 词法扫描/注释字符串跳过 + extractTestSummary 输出解析' },
  { name: '变异内部函数', file: 'test_run_mutation_internal.js', desc: 'lineColumn/isIdent/lineTriple/numberBefore/numberAfter/mapLimit/saveCheckpoint/loadCheckpoint/copyProject/applyMutants 11个内部函数' },
  { name: '变异范围校验', file: 'test_check_mutation_ranges.js', desc: 'check-mutation-ranges.js 子进程：全覆盖/漏测/不连续/越界 exit code' },
  { name: '变异范围', file: 'test_mutation_ranges.js', desc: '生产模块及行段必须完整纳入 mutation 矩阵' },
  // v3.172：集成测试走并行调度器（worker 独立缓存目录 + 失败片串行重跑）。
  // 需要完整串行验证时直接 node test_app.js（CI 即如此）
  { name: '集成测试', file: 'test_app_p.js', desc: 'App.run 完整主流程(并行调度,失败自动重跑)' },
  { name: '通道测试', file: 'test_notify.js', desc: '推送通道请求构造+脱敏' }
]

const results = []
console.log('══════════════════════════════════════════════')
console.log('  xbk-push 统一测试入口')
console.log('══════════════════════════════════════════════\n')

if (!checkDependencies()) process.exit(1)

for (const s of SUITES) {
  const file = path.join(__dirname, s.file)
  const t0 = Date.now()
  try {
    // 继承 stdout/stderr（各套件自己的 ✅/❌ 输出直接透传），捕获退出码
    execFileSync(process.execPath, [file], { stdio: 'inherit' })
    const ms = Date.now() - t0
    results.push({ ...s, ok: true, ms })
    console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`)
  } catch (e) {
    const ms = Date.now() - t0
    results.push({ ...s, ok: false, ms })
    console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s）\n`)
  }
}

console.log('══════════════════════════════════════════════')
console.log('  汇总报告')
console.log('══════════════════════════════════════════════')
let allOk = true
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  console.log(`  ${mark} ${r.name.padEnd(6)} ${r.file.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`)
  if (!r.ok) allOk = false
}
const totalMs = results.reduce((a, r) => a + r.ms, 0)
console.log(`\n  总耗时: ${(totalMs / 1000).toFixed(1)}s`)
console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}`)
console.log('══════════════════════════════════════════════')

process.exit(allOk ? 0 : 1)
