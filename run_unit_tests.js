'use strict'
// ============================================================
// 单元测试入口：只跑快速单元测试，排除集成测试（慢/可能有网络）
// 用法：node run_unit_tests.js   （或 npm run test:unit）
// 用途：CI 门禁 + 变异测试 runner，确保新增测试文件不会漏网
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { SUITES } = require('./test_suites')

// 中文名按显示宽度对齐：String.prototype.padEnd 按 UTF-16 码元计数，中文每字占 2 列，
// 直接 padEnd 会导致汇总行错位；此处按终端显示宽度补齐。
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
function displayWidth (str) {
  let width = 0
  for (const ch of str) width += WIDE_RE.test(ch) ? 2 : 1
  return width
}
function padEndWidth (str, width) {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)))
}

const UNIT_SUITES = SUITES.filter(s => !s.integration && !s.mutationSkip)
// mutationSkip：ranges 行数元校验在 Stryker 沙箱内误报（CI run #120 根因）——同一次运行里
// 两类行数扰动叠加：
//   ① 被 --mutate 的目标文件被插桩注入，行数大幅膨胀（如 426→704，主因）；
//   ② Stryker 默认注入的 "// @ts-nocheck" 头部使每个文件多 +1/+2 行（如 426→427）。
//   故在沙箱内跳过这两个元校验套件（① 的主修复）；它们仍由 npm test（run_tests.js 全量清单）
//   逐个执行，CI 门禁不降级。② 另在 stryker.config.js 用 disableTypeChecks:false 关闭（双保险）。

const results = []
console.log('══════════════════════════════════════════════')
console.log('  xbk-push 单元测试入口（排除集成测试）')
console.log(`  共 ${UNIT_SUITES.length} 个套件`)
console.log('══════════════════════════════════════════════\n')

for (const s of UNIT_SUITES) {
  const file = path.join(__dirname, s.file)
  const t0 = Date.now()
  try {
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
const nameWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.name)), 6)
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  console.log(`  ${mark} ${padEndWidth(r.name, nameWidth)} ${r.file.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`)
  if (!r.ok) allOk = false
}
const totalMs = results.reduce((a, r) => a + r.ms, 0)
console.log(`\n  总耗时: ${(totalMs / 1000).toFixed(1)}s`)
console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}`)
console.log('══════════════════════════════════════════════')

process.exit(allOk ? 0 : 1)
