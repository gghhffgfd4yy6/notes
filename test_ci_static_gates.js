'use strict'

// v3.280 静态扫描闸门（scripts/check-ci-static.js）的「三处接线」内容断言。
//
// 为什么由一个套件来锁：闸门本体若从 check 链 / pre-commit / test.yml 任一处被摘除，扫描器
// 就静默失效——而「摘步骤」本身不会让任何东西变红。本套件未标记 integration/mutationSkip、也
// 不在 SKIP_SUITES（它不是 test.yml 显式步骤），因此由「全量单元测试（run_unit_tests.js）」
// 兜底步骤直接执行：**CI 上删掉静态扫描步骤，下一次 CI 必红在这里**。
//
// 纯字符串/fs 断言，不 spawn 子进程：刻意绕开 AGENTS「本机验证盲区」登记的限制
// （本机 process.execPath 指向 linker64，execFileSync/spawnSync 必炸），本机与变异沙箱均可跑。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
let checks = 0
function check (label, fn) {
  fn()
  checks++
  console.log('✅ ' + label)
}

check('package.json：check 链含静态扫描，且排在 npm test 之前（先快后慢）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.strictEqual(pkg.scripts['check:ci-static'], 'node scripts/check-ci-static.js',
    'check:ci-static 脚本名必须指向 scripts/check-ci-static.js')
  assert.ok(pkg.scripts.check.includes('npm run check:ci-static'),
    'npm run check 链必须包含 check:ci-static——从链上摘除 = 门禁静默失效')
  assert.ok(pkg.scripts.check.indexOf('check:ci-static') < pkg.scripts.check.indexOf('npm test'),
    '静态扫描必须排在 npm test 之前（秒级门禁先失败）')
})

check('pre-commit：第 4 道 run_gate 接线存在，计数文案不漂移', () => {
  const hook = read('.githooks/pre-commit')
  assert.match(hook, /run_gate "静态扫描闸门"[^\n]*npm run check:ci-static/,
    'pre-commit 缺静态扫描 run_gate 行 = 提交时刻不再拦截钩子/YAML 的新问题')
  assert.ok(hook.includes('4 道快检') && hook.includes('四道快检'),
    'pre-commit 头部与文末的道数计数必须与实际一致（旧「三道」口径回潮即红）')
})

check('test.yml：CI 步骤存在、shellcheck 有兜底安装、zizmor 钉版本、走同一条 npm 链', () => {
  const yml = read('.github/workflows/test.yml')
  assert.ok(yml.includes('- name: 静态扫描闸门（shellcheck + zizmor）'),
    'test.yml 静态扫描步骤被删 = CI 上没人跑扫描器（本套件将在兜底步骤里变红）')
  assert.match(yml, /command -v shellcheck >\/dev\/null \|\| sudo apt-get install -y -qq shellcheck/,
    'CI 需给 shellcheck 留兜底安装（runner 镜像漂移时不静默失踪）')
  assert.match(yml, /pipx install zizmor==[0-9]+\.[0-9]+\.[0-9]+/,
    'zizmor 必须钉版本（升级须与本机基线同步，不许浮动 latest）')
  assert.ok(yml.includes('npm run check:ci-static'),
    'CI 步骤必须走与本地同一条 npm 链，禁止 CI 侧自拼扫描命令造成口径分叉')
})

check('首轮扫描修复不回退（release.yml 显式关缓存 + pre-push SC2034 指令）', () => {
  const rel = read('.github/workflows/release.yml')
  assert.match(rel, /package-manager-cache: *false/,
    'release.yml setup-node 必须保持显式关闭包管理器缓存——zizmor cache-poisoning（high）的机器强制项，注释不算')
  const pp = read('.githooks/pre-push')
  assert.ok(pp.includes('shellcheck disable=SC2034'),
    'pre-push 的 remote_sha 协议占位行必须带 disable 指令，否则闸门常驻一条噪音红')
})

console.log(`✅ test_ci_static_gates 全部通过（${checks} 检查）`)
