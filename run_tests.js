'use strict'
// ============================================================
// 统一测试入口：按 test_suites.js 注册表执行全部套件（含 integration，非「三套」）+ 汇总报告 + 退出码
// 用法：node run_tests.js   （或 npm test）
// 退出码：0 = 全部通过，非 0 = 有失败（CI/调度可感知）
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { checkDependencies } = require('./scripts/check-deps')

const { SUITES } = require('./test_suites')

// 汇总表按终端显示宽度对齐（与 run_unit_tests.js 同口径）：String.prototype.padEnd 按 UTF-16 码元计数，
// 中文每字占 2 列、文件名长度不一，直接 padEnd 会让列错位；此处按实测最大显示宽度补齐。
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
function displayWidth (str) {
  let width = 0
  for (const ch of str) width += WIDE_RE.test(ch) ? 2 : 1
  return width
}
function padEndWidth (str, width) {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)))
}

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
const nameWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.name)), 6)
const fileWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.file)), 18)
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  console.log(`  ${mark} ${padEndWidth(r.name, nameWidth)} ${padEndWidth(r.file, fileWidth)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`)
  if (!r.ok) allOk = false
}
const totalMs = results.reduce((a, r) => a + r.ms, 0)
console.log(`\n  总耗时: ${(totalMs / 1000).toFixed(1)}s`)
console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}`)
console.log('══════════════════════════════════════════════')

process.exit(allOk ? 0 : 1)
