'use strict'

// 本地变异禁令（用户明确指示 2026-10-16/17）：变异评估的判据只在 CI。
// 本套件锁死：npm 脚本走 fail-closed 守卫、两个入口（CLI/import）都拒绝、
// stryker 直跑被配置期闸门拦截、显式放行口可用、AGENTS 文档不回潮。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = __dirname
const GUARD = path.join(ROOT, 'scripts', 'local-mutation-guard.js')
const RUNNER = path.join(ROOT, 'run_mutation.js')
const RUN_GUARD = path.join(ROOT, 'scripts', 'mutation-run-guard.js')
let passed = 0
let failed = 0

function check (name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`)
    failed++
  }
}

// 子进程环境：清空放行变量（空串 ≠ '1'，与未设置同义）
const blockedEnv = { ...process.env, XBK_ALLOW_LOCAL_MUTATION: '' }

function commonCommandBlock (doc) {
  const marker = '## 常用命令'
  const at = doc.indexOf(marker)
  assert.ok(at >= 0, 'AGENTS.md 必须有「## 常用命令」一节')
  const after = doc.slice(at + marker.length)
  const open = after.indexOf('```')
  assert.ok(open >= 0, '「常用命令」下必须有代码块')
  const close = after.indexOf('```', open + 3)
  assert.ok(close > open, '「常用命令」代码块必须闭合')
  return after.slice(open + 3, close)
}

// 注释写法（# / //）也要算「列出」：旧实现只 startsWith 原始行，`# npm run test:mutation`
// 能静默通过；本函数是判据本体，下面的 fixture 先证明它能红。
function listsLocalMutationCommand (block) {
  return block.split('\n').some((line) => {
    const t = line.trimStart().replace(/^(?:#+|\/\/)\s*/, '').trimStart()
    return /^npm run test:mutation(?:\s|$)/.test(t)
  })
}

check('package.json 的 test:mutation 指向 fail-closed 守卫', () => {
  const pkg = require('./package.json')
  assert.strictEqual(pkg.scripts['test:mutation'], 'node scripts/local-mutation-guard.js',
    'npm run test:mutation 不得直连 stryker（会绕过本地禁令）')
})

check('守卫脚本在未放行时 exit 1 且打印禁令', () => {
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', timeout: 20000, env: blockedEnv })
  assert.strictEqual(r.status, 1, `应 exit 1，实际 ${r.status}（stderr: ${r.stderr}）`)
  assert.match(r.stderr, /禁止跑变异评估/, '必须打印明确禁令文案')
  assert.match(r.stderr, /XBK_ALLOW_LOCAL_MUTATION=1/, '必须提示显式放行方式')
})

check('run_mutation.js 直跑同样拒绝（不只看 npm 脚本）', () => {
  const r = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', timeout: 20000, env: blockedEnv })
  assert.strictEqual(r.status, 1, `应 exit 1，实际 ${r.status}（stderr: ${r.stderr}）`)
  assert.match(r.stderr, /禁止跑变异评估/)
})

check('import main() 同样拒绝（防绕过 CLI 闸）', () => {
  const code = "require('./run_mutation.js').main({}).then(() => process.exit(process.exitCode || 0))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 20000, env: blockedEnv })
  assert.strictEqual(r.status, 1, `应 exit 1，实际 ${r.status}`)
  assert.match(r.stderr, /禁止跑变异评估/)
})

check('显式放行口真实可用（isAllowed 纯函数）', () => {
  const { isAllowed } = require(GUARD)
  assert.strictEqual(isAllowed({}), false, '未设置时必须拒绝')
  assert.strictEqual(isAllowed({ XBK_ALLOW_LOCAL_MUTATION: '0' }), false, '非 1 值必须拒绝')
  assert.strictEqual(isAllowed({ XBK_ALLOW_LOCAL_MUTATION: '1' }), true, '=1 时必须放行')
})

check('stryker 直跑被配置期闸门拦截（含 CI/放行豁免）', () => {
  const { shouldBlock } = require(RUN_GUARD)
  const strykerBin = '/repo/node_modules/@stryker-mutator/core/bin/stryker.js'
  assert.strictEqual(shouldBlock(strykerBin, {}), true, '本机 stryker 直跑必须拦')
  assert.strictEqual(shouldBlock('/repo/node_modules/.bin/stryker', {}), true, 'npx 的 .bin 入口必须拦')
  assert.strictEqual(shouldBlock(strykerBin, { GITHUB_ACTIONS: 'true' }), false, 'CI 必须放行')
  // 审查 #234：旧实现用真值判断，GITHUB_ACTIONS=0/false 也会放行本机变异。
  assert.strictEqual(shouldBlock(strykerBin, { GITHUB_ACTIONS: '0' }), true, 'GITHUB_ACTIONS=0 不得放行')
  assert.strictEqual(shouldBlock(strykerBin, { GITHUB_ACTIONS: 'false' }), true, 'GITHUB_ACTIONS=false 不得放行')
  assert.strictEqual(shouldBlock(strykerBin, { GITHUB_ACTIONS: 'TRUE' }), true, '只认严格小写 true')
  assert.strictEqual(shouldBlock(strykerBin, { XBK_ALLOW_LOCAL_MUTATION: '1' }), false, '显式放行必须可用')
  // 路径判据：不得用「入口路径含 stryker 子串」——检出目录名含 stryker 会误伤 npm test。
  assert.strictEqual(shouldBlock('/home/me/stryker-notes/test_console.js', {}), false,
    '检出目录名含 stryker 不得误伤自家测试')
  // node -e / 自命名 wrapper：require.cache 里已有 core 时必须拦（旧实现两种都绕过）。
  const core = '/repo/node_modules/@stryker-mutator/core/dist/index.js'
  assert.strictEqual(shouldBlock('', {}, [core]), true, 'node -e 加载 core 必须拦')
  assert.strictEqual(shouldBlock('/home/me/my-runner.js', {}, [core]), true, '自命名 wrapper 加载 core 必须拦')
  assert.strictEqual(shouldBlock('/home/me/my-runner.js', {}, []), false, '只 require 配置、未加载 core 不误伤')
  assert.strictEqual(shouldBlock('/repo/scripts/check-mutation-ranges.js', {}), false,
    '自家脚本 require 配置不得误伤')
})

check('守卫打印的放行姿势带段选择（不退化成 19 个文件全量）', () => {
  const runGuard = fs.readFileSync(RUN_GUARD, 'utf8')
  assert.ok(runGuard.includes('--mutate'), '配置期闸门的放行示例必须带 --mutate 段选择')
  assert.ok(!/XBK_ALLOW_LOCAL_MUTATION=1 npx stryker run/.test(runGuard),
    '不得给出无段选择的全量放行示例')
  const localGuard = fs.readFileSync(GUARD, 'utf8')
  assert.ok(localGuard.includes('--mutate'), '本地入口的放行示例必须带 --mutate 段选择')
})

check('两个 stryker 配置都挂载了闸门', () => {
  for (const f of ['stryker.config.js', 'stryker.tap.config.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.ok(src.includes('mutation-run-guard'), `${f} 必须在加载期调用闸门`)
  }
})

check('守卫转发 --mutate 等参数（单段调试不退化成全量）', () => {
  const src = fs.readFileSync(GUARD, 'utf8')
  assert.ok(/process\.argv\.slice\(2\)/.test(src), '守卫必须转发额外参数')
})

check('AGENTS.md 记录本地禁令，且常用命令不再列 test:mutation（含注释写法）', () => {
  // 判据本体先过 fixture：旧实现只 startsWith 原始行，注释写法与「代码块缺失」都会静默绿。
  assert.strictEqual(listsLocalMutationCommand('npm run test:mutation'), true, '裸命令必须算列出')
  assert.strictEqual(listsLocalMutationCommand('# npm run test:mutation'), true, '# 注释写法必须算列出')
  assert.strictEqual(listsLocalMutationCommand('// npm run test:mutation'), true, '// 注释写法必须算列出')
  assert.strictEqual(listsLocalMutationCommand('npm run test:mutation -- --mutate "x.js:1-2"'), true,
    '带参数写法必须算列出')
  assert.strictEqual(listsLocalMutationCommand('npm run test:mutation-ranges'), false,
    'test:mutation-ranges 是行段校验，不得误伤')
  assert.strictEqual(listsLocalMutationCommand('npm test'), false)
  assert.throws(() => commonCommandBlock('# 无常用命令章节'), /必须有「## 常用命令」/,
    '定位不到章节必须红，不得 fail-open')
  assert.throws(() => commonCommandBlock('## 常用命令\n\n没有代码块'), /必须有代码块/,
    '定位不到代码块必须红，不得 fail-open')

  const docPath = path.join(ROOT, 'AGENTS.md')
  // 变异沙箱（copyProject）只复制测试所需的代码文件，不含 AGENTS.md；沙箱内跳过该断言。
  if (!fs.existsSync(docPath)) return
  const doc = fs.readFileSync(docPath, 'utf8')
  assert.match(doc, /本机禁止跑变异评估/, 'AGENTS.md 必须写明禁令')
  const block = commonCommandBlock(doc)
  assert.ok(block.trim().length > 0, '「常用命令」代码块不得为空（定位失败必须红）')
  assert.ok(!listsLocalMutationCommand(block), '常用命令代码块不得列 npm run test:mutation（含注释写法）')
})

console.log(`\n本地变异禁令套件：通过 ${passed} / 失败 ${failed}`)
process.exit(failed > 0 ? 1 : 0)
