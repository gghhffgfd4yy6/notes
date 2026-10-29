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
// 行匹配一律「拆成行 + 去缩进后精确判定」，不用 /^\s*…$/m：静态分析把「\s* + 行尾锚 + 可能很长的行」
// 判成潜在超线性回溯（S5852），而这里的语义本来就只是「某一行的内容等于 / 以 X 起头」。
const lineThat = (text, re) => text.split('\n').map((l) => l.trim()).find((l) => re.test(l))
const linesThat = (text, re) => text.split('\n').map((l) => l.trim()).filter((l) => re.test(l))

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

check('pre-commit：第 4 道 run_gate 接线存在，道数计数不漂移', () => {
  const hook = read('.githooks/pre-commit')
  // 行首锚定「命令行形态」（CodeRabbit #207 · Minor :36）：注释里提到命令不算接线——
  // 不锚定的匹配会被自家注释文本满足。
  assert.ok(linesThat(hook, /^run_gate "静态扫描闸门/).some((l) => l.includes('npm run check:ci-static')),
    'pre-commit 缺静态扫描 run_gate 行 = 提交时刻不再拦截钩子/YAML 的新问题')
  // 道数改为**按实际 run_gate 调用数动态核对**（v3.281）：原先写死「4 道」，每加一道门禁就得同时
  // 改这个断言——忘了改就是「断言替文档锁着旧口径」。现在只要求：头部与文末的道数文案（阿拉伯数字
  // 与中文数字两种写法）都与真实调用数一致，任何一侧漂移即红。
  const gates = linesThat(hook, /^run_gate "/).length
  assert.ok(gates >= 4, 'pre-commit 至少应有 4 道 run_gate，实得 ' + gates)
  const CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  assert.ok(hook.includes(`${gates} 道快检`),
    `pre-commit 头部/文末的阿拉伯数字道数必须是「${gates} 道快检」（与真实 run_gate 调用数一致）`)
  assert.ok(hook.includes(`${CN[gates]}道快检`),
    `pre-commit 的中文道数必须是「${CN[gates]}道快检」（旧口径回潮即红）`)
})

check('test.yml：CI 步骤存在、shellcheck 有兜底安装、zizmor 钉版本、走同一条 npm 链', () => {
  const yml = read('.github/workflows/test.yml')
  // 全部行首锚定命令/声明形态（CodeRabbit #207 · Minor :36）：步骤上方的注释同样含
  // 「npm run check:ci-static」字样——不锚定的 includes 在「run 行被删、注释还在」时会假绿。
  assert.ok(lineThat(yml, /^- name: 静态扫描闸门（shellcheck \+ zizmor）$/),
    'test.yml 静态扫描步骤被删 = CI 上没人跑扫描器（本套件将在兜底步骤里变红）')
  assert.ok(lineThat(yml, /^command -v shellcheck >\/dev\/null \|\| sudo apt-get install -y -qq shellcheck$/),
    'CI 需给 shellcheck 留兜底安装（runner 镜像漂移时不静默失踪）')
  assert.ok(lineThat(yml, /^pipx install zizmor==[0-9]+\.[0-9]+\.[0-9]+$/),
    'zizmor 必须钉版本（升级须与本机基线同步，不许浮动 latest）')
  assert.ok(lineThat(yml, /^npm run check:ci-static$/),
    'CI 步骤必须走与本地同一条 npm 链，禁止 CI 侧自拼扫描命令造成口径分叉')
})

check('首轮扫描修复不回退（release.yml 显式关缓存 + pre-push SC2034 指令）', () => {
  const rel = read('.github/workflows/release.yml')
  assert.ok(lineThat(rel, /^package-manager-cache: false$/),
    'release.yml setup-node 必须保持显式关闭包管理器缓存——zizmor cache-poisoning（high）的机器强制项，注释不算')
  const pp = read('.githooks/pre-push')
  assert.ok(pp.includes('shellcheck disable=SC2034'),
    'pre-push 的 remote_sha 协议占位行必须带 disable 指令，否则闸门常驻一条噪音红')
})

check('shellcheck 扫描面为 0 必须判红（0 个文件 ≠ 0 发现，C10-004）', () => {
  const gate = require('./scripts/check-ci-static.js')
  assert.strictEqual(typeof gate.decideEmptyScan, 'function', '必须有「扫描面是否为空」的判定纯函数')
  assert.strictEqual(gate.decideEmptyScan(3), 'pass', '有文件才是 pass')
  assert.strictEqual(gate.decideEmptyScan(1), 'pass')
  assert.strictEqual(gate.decideEmptyScan(0), 'fail', '扫描面为 0 必须判红——旧实现打印「0 个钩子文件，0 发现」并 exit 0')
  assert.strictEqual(gate.decideEmptyScan(-1), 'fail', '负数不可能来自真实扫描，按不可判定判红')
  assert.strictEqual(gate.decideEmptyScan(undefined), 'fail', '拿不到扫描面时按不可判定判红（宁红勿绿）')
  // 接线：main 必须在「failures 为空 → ✅」之前拦下空扫描面，并点名「扫描面为空」。
  const src = read('scripts/check-ci-static.js')
  const emptyAt = src.indexOf("decideEmptyScan(sc.scanned) === 'fail'")
  const okAt = src.indexOf("'✅ shellcheck：' + sc.scanned + ' 个钩子文件，0 发现'")
  assert.ok(emptyAt > -1, 'main 必须用 decideEmptyScan 拦空扫描面（否则这条判定只是死代码）')
  assert.ok(okAt > -1, '成功模板必须保留（有文件、无发现时照常打印计数）')
  assert.ok(emptyAt < okAt, '空扫描面判定必须排在成功模板之前，否则空扫描面先被 ✅ 吃掉')
  assert.ok(src.includes('\'❌ shellcheck：扫描面为空'),
    '判红时必须点名「扫描面为空」，不能复用「0 个文件，0 发现」那套成功文案')
  // zizmor 的 fail-closed 语义（缺工具/非 0 退出/输出不可解析）不得被这条改动带偏。
  assert.ok(src.includes('if (why) return { ok: false, reason: why, findings: [] }'),
    'zizmor 不可判定仍必须判红（本修复只补 shellcheck 的空扫描面，不动 zizmor）')
})

console.log(`✅ test_ci_static_gates 全部通过（${checks} 检查）`)
