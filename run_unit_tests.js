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

// SKIP_SUITES：显式列出需跳过的套件文件名（逗号分隔，可选）。
// 用途：CI 中显式步骤已单独跑过的套件，全量兜底时跳过避免重复（失败仍由显式步骤独立报错）。
// 清单与 test.yml 的显式步骤必须双向一致（漏写=重复跑，多写=漏跑）——不一致由 test_ci_skip_suites.js 拦截。
// 变异评估场景（run_mutation.js 子进程）必须保持全量 —— run_mutation.js spawn 时会清除该变量；
// CI 变异任务走 stryker（不经 run_mutation.js），由 mutation.yml 的 step env 设 XBK_MUTATION_CHILD=1。
const skipSuites = new Set((process.env.SKIP_SUITES || '').split(',').map(s => s.trim()).filter(Boolean))
// 拼错的条目会「静默不生效」（等于没跳过，重复跑且无人知道），因此必须在入口处炸出来。
const unknownSkips = [...skipSuites].filter(file => !SUITES.some(s => s.file === file))
if (unknownSkips.length) {
  console.error(`❌ SKIP_SUITES 含不存在的套件：${unknownSkips.join(', ')}（请对照 test_suites.js 修正）`)
  process.exit(1)
}
// 无效条目（套件本就不进本入口，如 integration/mutationSkip）不致命，但意味着清单与显式步骤口径漂移。
for (const file of skipSuites) {
  const suite = SUITES.find(s => s.file === file)
  if (suite && (suite.integration || suite.mutationSkip)) {
    console.warn(`⚠️ SKIP_SUITES 的 ${file} 本就不在本入口（integration/mutationSkip），该条无效`)
  }
}
const UNIT_SUITES = SUITES.filter(s => !s.integration && !s.mutationSkip && !skipSuites.has(s.file))
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

const IN_CI = Boolean(process.env.GITHUB_STEP_SUMMARY)
const summaryLines = ['| 套件 | 文件 | 结果 | 耗时 |', '|---|---|---|---|']
// CI 下 stdout 走 pipe 收进内存（失败时打包重显），故必须显式放大上限：execFileSync 默认 maxBuffer=1MiB，
// 超限会抛 ENOBUFS —— 一个「通过」的套件会被误判为失败。实测最大套件 test_filter.js 约 75KB，余量充足。
// XBK_UNIT_MAX_BUFFER 仅用于测试注入（构造超限场景），生产不设。
const MAX_BUFFER = Number(process.env.XBK_UNIT_MAX_BUFFER) || 8 * 1024 * 1024

for (const s of UNIT_SUITES) {
  const file = path.join(__dirname, s.file)
  const t0 = Date.now()
  // CI 下用 ::group:: 折叠各套件输出（463KB 的 test_filter 不再刷爆日志页）；stderr 直通组内（成功套件
  // 的警告也保留），pipe 仅收 stdout 用于失败时打包重显；本地保持 inherit 逐行直出
  if (IN_CI) console.log(`::group::${s.name}（${s.file}）`)
  try {
    const childOut = execFileSync(process.execPath, [file], { stdio: IN_CI ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: MAX_BUFFER })
    if (IN_CI) {
      console.log(childOut.toString())
      console.log('::endgroup::')
    }
    const ms = Date.now() - t0
    results.push({ ...s, ok: true, ms })
    summaryLines.push(`| ${s.name} | \`${s.file}\` | ✅ | ${(ms / 1000).toFixed(1)}s |`)
    console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`)
  } catch (e) {
    // 输出超限（ENOBUFS）不是测试失败，必须显式区分，否则「通过但话多」的套件会被当成红测排查。
    const overflow = e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message || ''))
    if (IN_CI) {
      // 失败必须全量炸出（默认组），拿回具体红测上下文（stderr 已直通，此处补 stdout）
      console.log('::endgroup::')
      console.log(overflow
        ? `::error title=输出超限：${s.name}::${s.file} 的 stdout 超过 ${MAX_BUFFER} 字节上限（非测试失败）`
        : `::error title=失败套件：${s.name}::${s.file}`)
      console.log((e.stdout || '').toString())
    }
    const ms = Date.now() - t0
    results.push({ ...s, ok: false, ms })
    summaryLines.push(`| ${s.name} | \`${s.file}\` | ❌ | ${(ms / 1000).toFixed(1)}s |`)
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
console.log(`  总耗时: ${(totalMs / 1000).toFixed(1)}s`)
console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}`)
console.log('══════════════════════════════════════════════')

// CI 下把套件结果表写入 $GITHUB_STEP_SUMMARY（run 页可直接看，失败一眼定位）
// 只在「本入口的调用方不是变异评估子进程」时写：run_mutation.js 的 spawn 会带 XBK_MUTATION_CHILD=1
// （它会在临时目录里反复运行本入口，若允许追加会产生重复块，且子进程套件数与顶层不同）。
// CI 变异任务走 stryker 的 commandRunner（不经过 run_mutation.js），由 mutation.yml 的 step env 设同一位
// ——否则「初始运行 + 每个变异体」各 append 一次整表，几百次就撞 GitHub 1MiB/step 上限被截断。
if (IN_CI && process.env.XBK_MUTATION_CHILD !== '1') {
  require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## 单元测试结果（${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}，共 ${results.length} 套件，${(totalMs / 1000).toFixed(1)}s）\n\n${summaryLines.join('\n')}\n`)
}

process.exit(allOk ? 0 : 1)
