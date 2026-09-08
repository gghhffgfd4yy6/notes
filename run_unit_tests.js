'use strict'
// ============================================================
// 单元测试入口：只跑快速单元测试，排除集成测试（慢/可能有网络）
// 用法：node run_unit_tests.js   （或 npm run test:unit）
// 用途：CI 门禁 + 变异测试 runner，确保新增测试文件不会漏网
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { SUITES } = require('./test_suites')

const UNIT_SUITES = SUITES.filter(s => !s.integration)

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
