'use strict'

// 本地变异禁令（用户明确指示 2026-10-16/17）：变异评估的判据只在 CI。
// 本套件锁死三件事：npm 脚本走 fail-closed 守卫、两个入口在无显式放行时都拒绝、
// 守卫保留 XBK_ALLOW_LOCAL_MUTATION=1 的显式放行口（供单段/沙箱调试）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = __dirname
const GUARD = path.join(ROOT, 'scripts', 'local-mutation-guard.js')
const RUNNER = path.join(ROOT, 'run_mutation.js')
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

check('守卫保留显式放行口（XBK_ALLOW_LOCAL_MUTATION）', () => {
  const src = fs.readFileSync(GUARD, 'utf8')
  assert.ok(src.includes('XBK_ALLOW_LOCAL_MUTATION'), '守卫必须识别放行变量')
  assert.ok(/process\.exit\(1\)/.test(src), '未放行分支必须 exit 1')
})

check('AGENTS.md 记录本地禁令（防文档回潮）', () => {
  const docPath = path.join(ROOT, 'AGENTS.md')
  // 变异沙箱（copyProject）只复制测试所需的代码文件，不含 AGENTS.md；沙箱内跳过该断言。
  if (!fs.existsSync(docPath)) return
  const doc = fs.readFileSync(docPath, 'utf8')
  assert.match(doc, /本机禁止跑变异评估/, 'AGENTS.md 必须写明禁令')
  assert.ok(!/npm run test:mutation\s*\n/.test(doc.split('## 常用命令')[1]?.split('```')[1] || ''),
    '常用命令代码块不得再列 npm run test:mutation')
})

console.log(`\n本地变异禁令套件：通过 ${passed} / 失败 ${failed}`)
process.exit(failed > 0 ? 1 : 0)
