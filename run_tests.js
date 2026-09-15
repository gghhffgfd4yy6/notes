'use strict'
// ============================================================
// 统一测试入口：一键执行三套测试 + 汇总报告 + 退出码
// 用法：node run_tests.js   （或 npm test）
// 退出码：0 = 全部通过，非 0 = 有失败（CI/调度可感知）
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { checkDependencies } = require('./scripts/check-deps')

const { SUITES } = require('./test_suites')

const results = []
console.log('══════════════════════════════════════════════')
console.log('  xbk-push 统一测试入口')
console.log('══════════════════════════════════════════════\n')

if (!checkDependencies()) process.exit(1)

// 零套件不等于通过：注册表为空（或将来被过滤成空）时循环体一次都不执行，results 为空 → allOk 初值 true
// → 打印「全部通过 🎉」并 exit 0，门禁整步假绿。注意 test_suite_registry.js 的「SUITES 不应为空」断言
// 本身就在 SUITES 的一个成员里，空注册表时根本不会执行（自指盲区），救不了这个场景。
if (!SUITES.length) {
  console.error('❌ SUITES 为空：test_suites.js 注册表损坏，拒绝以「全部通过」收场')
  process.exit(1)
}

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
    // 静默非零退出/被信号杀死的套件在子进程侧可能零输出——父进程必须补上退出原因，
    // 否则 exit 7 与「被 OOM 杀掉」在输出上完全不可区分（e.status/e.signal/e.code/e.message）。
    const why = `code=${e.code ?? '-'} status=${e.status ?? '-'} signal=${e.signal ?? '-'}`
    console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s｜${why}）`)
    if (e.message) console.log(`     ${String(e.message).split('\n')[0]}`)
    console.log('')
  }
}

// 防御「全部条目被跳过」的未来形态：结果为空同样不得以「全部通过」收场。
if (!results.length) {
  console.error('❌ 未执行任何测试套件，拒绝以「全部通过」收场')
  process.exit(1)
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
