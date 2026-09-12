'use strict'

// CI 跳过清单一致性 + run_unit_tests.js 的 SKIP_SUITES / GITHUB_STEP_SUMMARY 行为回归。
// 背景：test.yml 的 SKIP_SUITES 与「显式步骤」是两份必须手工同步的清单——
//   漏写 = 重复跑（浪费），多写 = 漏跑（门禁盲区），拼错 = 静默失效（等于没跳过）。
//   本套件把「清单 ↔ 显式步骤」的双向对账与入口行为固定在门禁里，防止再次回归。
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SUITES } = require('./test_suites')

// 仓库内固定路径（__dirname + 常量），非外部输入
const testYml = fs.readFileSync(path.join(__dirname, '.github/workflows/test.yml'), 'utf8') // nosemgrep: 仓库内固定路径，非用户输入
const mutationYml = fs.readFileSync(path.join(__dirname, '.github/workflows/mutation.yml'), 'utf8') // nosemgrep: 仓库内固定路径，非用户输入
const pkg = require('./package.json')

// ── 1. 清单自身必须干净 ─────────────────────────────────────
const skipMatch = testYml.match(/^\s*SKIP_SUITES:\s*(\S.*)$/m)
assert.ok(skipMatch, 'test.yml 应声明 SKIP_SUITES')
const skips = skipMatch[1].split(',').map(s => s.trim()).filter(Boolean)
assert.ok(skips.length > 0, 'SKIP_SUITES 不应为空')

const byFile = new Map(SUITES.map(s => [s.file, s]))
for (const file of skips) {
  // 拼错的条目在 run_unit_tests.js 里已改为直接失败，这里再固化一次（错误更早暴露）
  assert.ok(byFile.has(file), `SKIP_SUITES 含不存在的套件 ${file}（拼错即静默失效）`)
  const suite = byFile.get(file)
  assert.ok(!suite.integration && !suite.mutationSkip,
    `SKIP_SUITES 的 ${file} 本就不进单元入口（integration/mutationSkip），该条无效`)
}

// ── 2. 与显式步骤双向对账 ───────────────────────────────────
const unitFiles = SUITES.filter(s => !s.integration && !s.mutationSkip).map(s => s.file)
const explicitFiles = new Set()
for (const match of testYml.matchAll(/^\s*run:\s*npm run (\S+)\s*$/gm)) {
  const cmd = pkg.scripts[match[1]]
  const file = cmd && cmd.match(/node (\S+\.js)/)
  if (file) explicitFiles.add(path.basename(file[1]))
}
assert.ok(explicitFiles.size > 0, '应从 test.yml 解析出显式测试步骤')
assert.deepStrictEqual(skips.slice().sort(), unitFiles.filter(f => explicitFiles.has(f)).sort(),
  'SKIP_SUITES 必须等于「显式步骤已覆盖的单元套件」：漏写会重复跑，多写会漏跑（门禁盲区）')

// 2b. integration/mutationSkip 套件被 run_unit_tests.js 排除，只能靠显式步骤进门禁 ——
//     漏一个就是门禁盲区（test_suites.js 注释写明「历史上多次发生」）
const excluded = SUITES.filter(s => s.integration || s.mutationSkip).map(s => s.file)
const uncovered = excluded.filter(f => !explicitFiles.has(f))
assert.deepStrictEqual(uncovered, [],
  `以下 integration/mutationSkip 套件没有 CI 显式步骤，脱离门禁：${uncovered.join(', ')}`)

// ── 3. 入口行为（子进程 + 跳过全部套件，秒级） ───────────────
const baseEnv = { ...process.env }
delete baseEnv.SKIP_SUITES
delete baseEnv.XBK_MUTATION_CHILD
function runEntry (env) {
  return spawnSync(process.execPath, [path.join(__dirname, 'run_unit_tests.js')],
    { encoding: 'utf8', cwd: __dirname, env: { ...baseEnv, ...env } })
}
const skipAll = unitFiles.join(',') // 跳过全部单元套件 → 不真正执行套件，几秒内跑完

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-skip-suites-'))
try {
  // 3a 拼错的条目必须炸（修复前是静默照跑全量）
  const unknown = runEntry({ SKIP_SUITES: 'test_not_exist.js' })
  assert.notStrictEqual(unknown.status, 0, 'SKIP_SUITES 含未知套件必须非 0 退出')
  assert.match(unknown.stderr, /test_not_exist\.js/, '错误应点名未知套件')

  // 3b CI 下写 summary（顺带验证过滤生效：跳过全部 → 0 套件）
  const sumFile = path.join(tmp, 'summary.md')
  const filtered = runEntry({ SKIP_SUITES: skipAll, GITHUB_STEP_SUMMARY: sumFile })
  assert.strictEqual(filtered.status, 0, filtered.stderr || filtered.stdout)
  assert.match(filtered.stdout, /共 0 个套件/, '跳过全部套件时应报告 0 个')
  const summary = fs.readFileSync(sumFile, 'utf8') // nosemgrep: tmp 目录由 mkdtempSync 生成，非外部输入
  assert.match(summary, /^## 单元测试结果/m, 'CI 下应写入 job summary')
  assert.match(summary, /共 0 套件/, 'summary 套件数应与实际执行数一致')

  // 3c 变异子进程必须不写 summary（否则每个变异体追加一次整表）
  const sumFile2 = path.join(tmp, 'summary-child.md')
  const child = runEntry({ SKIP_SUITES: skipAll, GITHUB_STEP_SUMMARY: sumFile2, XBK_MUTATION_CHILD: '1' })
  assert.strictEqual(child.status, 0, child.stderr || child.stdout)
  assert.ok(!fs.existsSync(sumFile2), 'XBK_MUTATION_CHILD=1 时不得写 job summary') // nosemgrep: tmp 目录由 mkdtempSync 生成，非外部输入

  // 3e 输出超限（ENOBUFS）必须标注为「输出超限」而不是普通测试失败：
  //    XBK_UNIT_MAX_BUFFER 仅测试注入；留一个必输出内容的套件、把上限压到 1 字节
  const oneLeft = unitFiles.filter(f => f !== 'test_check_deps.js').join(',')
  const overflow = runEntry({ SKIP_SUITES: oneLeft, GITHUB_STEP_SUMMARY: path.join(tmp, 'summary-overflow.md'), XBK_UNIT_MAX_BUFFER: '1' })
  assert.notStrictEqual(overflow.status, 0, '输出超过 maxBuffer 的套件应判定失败')
  assert.match(overflow.stdout, /::error title=输出超限/, '失败原因必须标注为输出超限（非测试失败）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// 3d CI 变异任务走 stryker（不经 run_mutation.js 的 spawn），必须由 step env 抑制 summary 追加
const strykerIdx = mutationYml.indexOf('npx stryker run')
assert.ok(strykerIdx > 0, 'mutation.yml 应包含 stryker 运行步骤')
assert.match(mutationYml.slice(strykerIdx, strykerIdx + 1500), /XBK_MUTATION_CHILD:\s*'1'/,
  'mutation.yml 的变异测试 step 必须设 XBK_MUTATION_CHILD=1（否则重复整表 append，几百次即撞 1MiB 上限）')

console.log(`✅ SKIP_SUITES（${skips.length} 项）与 test.yml 显式步骤双向一致，且未知条目会失败`)
console.log('✅ 变异路径（run_mutation.js 子进程 + CI stryker step）均抑制 summary 重复追加')
