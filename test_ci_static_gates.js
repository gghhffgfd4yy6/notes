'use strict'

// v3.280 静态扫描闸门（scripts/check-ci-static.js）的「三处接线」内容断言。
//
// 为什么由一个套件来锁：闸门本体若从 check 链 / pre-commit / test.yml 任一处被摘除，扫描器
// 就静默失效——而「摘步骤」本身不会让任何东西变红。
//
// 接线事实（与 test_suites.js 的注册项一致）：本套件标了 `mutationSkip: true`（变异沙箱不复制
// `.githooks/`，沙箱内必 ENOENT 假红）⇒ run_unit_tests.js 的 `!s.mutationSkip` 过滤会把它排除在
// 「全量单元测试」兜底之外，CI 覆盖**只**来自 test.yml policy job 的显式步骤
// `npm run test:ci-static-gates`（这层对账由 test_ci_skip_suites.js 的「SKIP_SUITES ↔ 显式步骤」
// 守着）；**摘掉那个显式步骤，下一次 CI 必红在这里**。
//
// 纯字符串/fs 断言，不 spawn 子进程：本机与变异沙箱都能跑，也不受宿主 process.execPath 形态影响。
// C5-013 起额外 require 判据模块（scripts/check-ci-static.js）本身：只读、无副作用、不 spawn，
// 但把「判据函数零自动化断言」这个缺口补上（详见下方同名用例）。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const gate = require('./scripts/check-ci-static.js')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
// 行匹配一律「拆成行 + 去缩进后精确判定」，不用 /^\s*…$/m：静态分析把「\s* + 行尾锚 + 可能很长的行」
// 判成潜在超线性回溯（S5852），而这里的语义本来就只是「某一行的内容等于 / 以 X 起头」。
const lineThat = (text, re) => text.split('\n').map((l) => l.trim()).find((l) => re.test(l))
const linesThat = (text, re) => text.split('\n').map((l) => l.trim()).filter((l) => re.test(l))

// C5-022：harness 不能在一条检查抛错时就中断整个文件。旧实现 `fn()` 直接穿出顶层：不打印 label、
// 不计数、无汇总，后面的检查一条都不跑（与 test_doc_line_gates.js 同一套工厂形态）。每条检查独立
// 捕获，passed/failed 双计数，末尾统一汇总并置非零退出码——工厂形态同时让 harness 自身可被断言
// （见文件末尾「harness 自身」那条用例），否则这段控制流改动同样零覆盖。
function createChecker (out) {
  const log = (out && out.log) || ((s) => console.log(s))
  let passed = 0
  const failures = []
  function check (label, fn) {
    try {
      fn()
      passed++
      log('✅ ' + label)
    } catch (e) {
      const message = (e && e.message) || String(e)
      failures.push({ label, message })
      log('❌ ' + label + '：' + message)
    }
  }
  return {
    check,
    get passed () { return passed },
    get failures () { return failures.slice() },
    summary () {
      if (failures.length === 0) {
        log(`✅ test_ci_static_gates 全部通过（${passed} 检查）`)
        return 0
      }
      log(`❌ test_ci_static_gates：${passed} 通过 / ${failures.length} 失败（共 ${passed + failures.length} 检查）`)
      for (const f of failures) log('   ❌ ' + f.label + '：' + f.message)
      return 1
    }
  }
}

const harness = createChecker()
const check = harness.check

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
  // 行首锚定「命令行形态」（CodeRabbit #207 · Minor，原意见的 :36 行号早已随改动漂移，改按语义锚定）：
  // 注释里提到命令不算接线——
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
  // 全部行首锚定命令/声明形态（CodeRabbit #207 · Minor，同上：按语义而非漂移的行号）：
  // 步骤上方的注释同样含
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

check('scorecard.yml：analysis job 的 job 级 permissions 必须显式保留 contents: read（C10-047）', () => {
  // job 级 `permissions:` 会**整体覆盖** workflow 级：未列出的作用域一律置 none。scorecard.yml 的
  // workflow 级那句 contents: read 对 analysis job 不起作用——job 级只写了 security-events / id-token，
  // 于是 contents=none，actions/checkout 拿不到仓库、Scorecard 分析跑在空目录上（绿色假象）。
  // 断言因此必须落在 job 块内的 permissions 段，而不是只看文件里出现过 contents: read。
  const lines = read('.github/workflows/scorecard.yml').split('\n')
  const at = lines.indexOf('    permissions:')
  assert.ok(at > -1, 'analysis job 必须保留 job 级 permissions 块（缩进 4 空格的 permissions:）')
  const scopes = []
  for (let i = at + 1; i < lines.length; i++) {
    // job 级作用域行的缩进固定 6 空格；遇到别的行（steps / 下一个键）即本段结束。
    // 行内注释不算作用域内容（`contents: read  # …` 仍是 contents: read）。
    if (!/^ {6}\S/.test(lines[i])) break
    scopes.push(lines[i].trim().split('#')[0].trim())
  }
  assert.ok(scopes.includes('contents: read'),
    `job 级 permissions 覆盖 workflow 级 ⇒ 缺 contents: read 时 checkout 无权读仓库（实得作用域：${scopes.join(' / ')}）`)
})

check('首轮扫描修复不回退（release.yml 显式关缓存 + pre-push SC2034 指令）', () => {
  const rel = read('.github/workflows/release.yml')
  assert.ok(lineThat(rel, /^package-manager-cache: false$/),
    'release.yml setup-node 必须保持显式关闭包管理器缓存——zizmor cache-poisoning（high）的机器强制项，注释不算')
  const pp = read('.githooks/pre-push')
  assert.ok(pp.includes('shellcheck disable=SC2034'),
    'pre-push 的 remote_sha 协议占位行必须带 disable 指令，否则闸门常驻一条噪音红')
})

// ============================================================
// C5-013：判据函数与扫描面必须被**自动化**断言接住
// 本套件此前只断言 package.json / .githooks / YAML 里的接线字符串，一个判据函数都不 require：
// 把 main() 改成 `return 0`（或删掉扫描循环）、或让模块加载即 throw，本套件与 CI 全绿。
// scripts/check-ci-static.js 里当时的 15 条 --selftest 断言又全仓无人调用（package.json / test.yml /
// .githooks / run_* 全无引用）⇒ 判据函数实际上零自动化断言，是死代码。下面的用例把它接进套件
// （条数随后续修复增至 28，具体数字由「--selftest 已接线」那条守卫核对，不在这里写死）。
// ============================================================

check('C5-013 判据模块可加载，全部判定函数都是可调用函数', () => {
  // 名单要与 scripts/check-ci-static.js 的 module.exports 里**每一个判据**对齐：漏一个就等于那个判据
  // 没有自动化断言（decideEmptyScan / decideCiEnv 就是后续修复补进来的，此前被 5 个的硬计数漏掉）。
  const judges = ['summarizeZizmor', 'decideToolMissing', 'decideEmptyScan', 'decideCiEnv', 'toolAvailable', 'resolveTool', 'decideZizmorProc']
  for (const name of judges) {
    assert.strictEqual(typeof gate[name], 'function',
      `${name} 必须从 scripts/check-ci-static.js 导出——判据零自动化断言 = 门禁可被静默改坏`)
  }
  // 直接打一发真实判据：require 到的不是空壳（非 JSON 必须判「不可判定」）
  assert.strictEqual(gate.summarizeZizmor('not json').ok, false, '非 JSON 输出必须不可判定（宁红勿绿）')
  assert.strictEqual(gate.decideToolMissing(true, false), 'fail', 'CI 缺工具必须 fail-closed')
})

check('C5-013 --selftest 已接线：28 条判据断言在套件内执行', () => {
  // 此前 --selftest 全仓无人调用，是死代码；现在由本套件执行（run_tests 与 test.yml 都跑本套件）。
  // b7 的 C10-004 追加 5 条 decideEmptyScan 断言（15 → 20）；C10-067 追加 8 条 decideCiEnv 断言
  // （20 → 28）。条数漂移仍须同步本守卫。
  const n = gate.selftest()
  assert.strictEqual(n, 28, `--selftest 必须执行 28 条断言（实际 ${n}）；增减须同步本守卫`)
})

check('C5-013 扫描面守卫：门禁真的会扫到 N 个 .githooks 文件（N>=2 且与磁盘一致）', () => {
  const targets = gate.shellcheckTargets()
  assert.ok(Array.isArray(targets), 'shellcheckTargets 必须返回文件名数组')
  assert.ok(targets.length >= 2, `扫描面不得塌成 0：实际 ${targets.length} 个（扫描循环被删/目录读空即红）`)
  const onDisk = fs.readdirSync(path.join(__dirname, '.githooks'))
    .filter((f) => fs.lstatSync(path.join(__dirname, '.githooks', f)).isFile())
  assert.deepStrictEqual([...targets].sort(), [...onDisk].sort(),
    '.githooks 下的常规文件必须全部在扫描面内（新增钩子漏扫 = 门禁缺一块）')
  for (const must of ['pre-commit', 'pre-push']) {
    assert.ok(targets.includes(must), `${must} 必须在扫描面内`)
  }
})

check('C5-013 main() 必须真的调用两台扫描器（防 main 空转后门禁静默失效）', () => {
  const src = read('scripts/check-ci-static.js').split('\n').map((l) => l.trim())
  assert.ok(src.includes("if (toolAvailable('shellcheck')) {"), 'main 必须按 shellcheck 可用性分支扫描（分支被删 = 空转）')
  assert.ok(src.includes('const sc = runShellcheck()'), 'main 必须真的调用 runShellcheck（改成 main(){ return 0 } 会在这里红）')
  assert.ok(src.includes("if (toolAvailable('zizmor')) {"), 'main 必须按 zizmor 可用性分支扫描')
  assert.ok(src.includes('const z = runZizmor()'), 'main 必须真的调用 runZizmor')
  assert.ok(src.includes('return red ? 1 : 0'), 'main 必须把 red 汇成退出码（恒 0 = 门禁永远绿）')
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

// C5-022 门禁：harness 自身的控制流必须有断言，否则「一条检查抛错就整份文件中断」这种改动零覆盖
// （改动前实测：插入一条 throw，输出停在最后一个 ✅ 之后直接 Node 堆栈退出，后续检查与汇总一条都不出现）。
// 这里同时锁**接线**：只锁 createChecker 工厂时，把 `const check = harness.check` 换回裸 fn() 自测仍会绿，
// 而真实注册路径照旧一抛就整份中断——故先断言全局 check 与本 harness 的 check 是同一个函数。
check('harness 自身：一条检查抛错只记失败，后续照跑、汇总为 1（C5-022）', () => {
  assert.strictEqual(check, harness.check,
    '全局 check 必须直接取自 harness.check——换回裸 fn() 时本断言先红，而不是等运行时整份文件崩掉')
  const lines = []
  const probe = createChecker({ log: (s) => lines.push(s) })
  probe.check('通过的检查', () => {})
  probe.check('抛错的检查', () => { throw new Error('boom') })
  probe.check('抛错之后的检查', () => { lines.push('AFTER-RAN') })
  assert.deepStrictEqual(probe.failures.map((f) => f.label), ['抛错的检查'],
    '抛错的检查必须被记为失败（带 label），而不是把异常穿出 harness')
  assert.strictEqual(probe.failures[0].message, 'boom', '失败明细必须带原始错误信息，否则定位不到根因')
  assert.ok(lines.includes('AFTER-RAN'), '抛错之后的检查必须照跑——旧实现在这里整份文件中止')
  assert.ok(lines.some((l) => l.startsWith('❌ 抛错的检查')),
    '失败检查必须打印 ❌ 与 label（旧实现连 label 都不打）')
  assert.strictEqual(probe.passed, 2, 'passed 只算真正跑完的检查')
  const code = probe.summary()
  assert.strictEqual(code, 1, '有失败时汇总必须返回 1（这个返回值就是进程退出码），不得把「跑了一半」当全绿')
  assert.ok(lines.some((l) => l.includes('2 通过 / 1 失败')),
    '汇总必须同时报通过与失败数：' + JSON.stringify(lines))
  // 退出码接线：summary() 的返回值必须真的落到 process.exitCode（只 return 不接 = 失败被吞成 exit 0）
  assert.ok(lineThat(read('test_ci_static_gates.js'), /^process\.exitCode = harness\.summary\(\)$/),
    '文件末尾必须把 summary() 的返回码接到 process.exitCode')
})

process.exitCode = harness.summary()
