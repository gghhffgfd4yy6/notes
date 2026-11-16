'use strict'

// v3.280 静态扫描闸门（scripts/check-ci-static.js）的「三处接线」内容断言。
//
// 为什么由一个套件来锁：闸门本体若从 check 链 / pre-commit / test.yml 任一处被摘除，扫描器
// 就静默失效——而「摘步骤」本身不会让任何东西变红。
//
// 接线事实（与 test_suites.js 的注册项一致）：本套件标了 `mutationSkip: true`（变异沙箱不复制
// `.githooks/`，沙箱内必 ENOENT 假红）⇒ run_unit_tests.js 的 `!s.mutationSkip` 过滤会把它排除在
// 「全量单元测试」兜底之外，CI 覆盖**只**来自 test.yml **quality job** 的显式步骤
// `npm run test:ci-static-gates`（v3.447 从 policy 挪过来：本套件 import test_support/source_model.js，
// 顶层 require('acorn') + loadYaml 需 js-yaml，而 policy 是刻意零依赖 job ⇒ 挂那边必 MODULE_NOT_FOUND）。
// 这层对账由 test_ci_skip_suites.js 的 assertPolicyStepsUnconditional 正向锁守着——quality 里恰好
// 一次、policy 里恰好零次，两个方向各有一条反例夹具；**摘掉那个显式步骤，下一次 CI 必红在这里**。
//
// 纯字符串/fs 断言，不 spawn 子进程：本机与变异沙箱都能跑，也不受宿主 process.execPath 形态影响。
// C5-013 起额外 require 判据模块（scripts/check-ci-static.js）本身：只读、无副作用、不 spawn，
// 但把「判据函数零自动化断言」这个缺口补上（详见下方同名用例）。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const gate = require('./scripts/check-ci-static.js')
// 结构视图：hook 走 parseShell 的 tokens、workflow 走 loadYaml 解析后的 job/step 字段
// （r4-5：接线断言不再比对源码行文本，改由 test_support/source_model.js 提供的结构视图判定）。
const { parseShell, loadYaml } = require('./test_support/source_model.js')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
// 行匹配一律「拆成行 + 去缩进后精确判定」，不用 /^\s*…$/m：静态分析把「\s* + 行尾锚 + 可能很长的行」
// 判成潜在超线性回溯（S5852），而这里的语义本来就只是「某一行的内容等于 / 以 X 起头」。
const lineThat = (text, re) => text.split('\n').map((l) => l.trim()).find((l) => re.test(l))
const linesThat = (text, re) => text.split('\n').map((l) => l.trim()).filter((l) => re.test(l))
// 显式码元序比较器（Sonar S2879）：两处扫描面比对共用一份，口径 = UTF-16 码元字典序。
// **不得**换成 localeCompare：它按宿主语言环境做大小写/重音不敏感排序，'pre-push' 与 'Pre-push'
// 这类混排的相对位置会翻转 ⇒ `.githooks` 扫描面比对随机器 locale 漂移（下面有靶向断言钉这一点）。
const byCodeUnit = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

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

// ── check:assert-style（v3.444）三处接线判定 ───────────────────────────────────────────
// 与 check:ci-static / check:doc-lines 同族：闸门本体从 `npm run check` 链、pre-commit、test.yml 任一处
// 被摘掉，都不会让任何东西变红——「删一行接线」本身不是失败。故这里把「三处都在」做成可被反例驱动的
// 纯函数（不在函数里读盘），再用合成输入逐个删一处证明它真的会红。
//
// 判据是**结构断言**（不是源码文本）：`.githooks/pre-commit` 走 source_model.parseShell 的 tokens
// （引号感知切词，注释/缩进/行序调整都不误红），`test.yml` 走 loadYaml 解析后断言 job / step 字段，
// 并锁住「在 quality job、policy 里没有」——policy 零依赖，粘过去必 MODULE_NOT_FOUND。
function assertAssertStyleWiring (pkg, hookLines, workflow) {
  assert.strictEqual(pkg.scripts['check:assert-style'], 'node scripts/check-source-text-asserts.js',
    'check:assert-style 脚本名必须指向 scripts/check-source-text-asserts.js')
  assert.ok(pkg.scripts.check.includes('npm run check:assert-style'),
    'npm run check 链必须包含 check:assert-style——从链上摘除 = 本地门禁静默失效')
  assert.ok(pkg.scripts.check.indexOf('check:assert-style') < pkg.scripts.check.indexOf('npm test'),
    '源码文本断言闸门必须排在 npm test 之前（秒级门禁先失败）')
  // pre-commit：按 tokens 判（`run_gate` + 标签 + `npm run check:assert-style`），有且只有一道。
  const hookGates = hookLines.filter((l) => l.tokens[0] === 'run_gate' && l.tokens.includes('check:assert-style'))
  assert.strictEqual(hookGates.length, 1,
    'pre-commit 必须有且只有一道「源码文本断言闸门」run_gate——缺它 = 提交时刻不再拦截新增的源码文本断言')
  assert.deepStrictEqual(hookGates[0].tokens.slice(0, 2), ['run_gate', '源码文本断言闸门'],
    'pre-commit 该道 run_gate 的标签必须是「源码文本断言闸门」')
  assert.deepStrictEqual(hookGates[0].tokens.slice(-3), ['npm', 'run', 'check:assert-style'],
    'pre-commit 该道 run_gate 必须走与本地同一条 npm 链（npm run check:assert-style）')
  // test.yml：步骤必须在 quality job，且只有一步；policy（零依赖、从不 npm ci）里不得有。
  const steps = workflow && workflow.jobs && workflow.jobs.quality && workflow.jobs.quality.steps
  assert.ok(Array.isArray(steps), 'test.yml 必须有一个带 steps 的 quality job（v3.445 起闸门挂在这里）')
  const gateSteps = steps.filter((s) => s && s.name === '源码文本断言闸门（禁止新增读源码文本断言）')
  assert.strictEqual(gateSteps.length, 1,
    'test.yml 的 quality job 必须有且只有一步「源码文本断言闸门」——缺它 = PR 流水线不再跑它')
  assert.strictEqual(gateSteps[0].run, 'npm run check:assert-style',
    'test.yml 的该步骤必须走与本地同一条 npm 链（npm run check:assert-style）')
  // 步骤存在 ≠ 会执行（r17-B）：step 级 `if:` 让它只在特定事件跑（`if: false` 则永不跑），
  // `continue-on-error: true` 则让失败不阻断 job——两种写法下「删步骤 / 摘链」的反例全绿，本闸静默失效。
  // 兄弟闸 check:ci-static / check:doc-lines 在 policy job 里由 assertPolicyStepsUnconditional 免费得到
  // 这层保护；v3.445 把本闸挪到 quality 时没一起搬过来，故这里显式补齐（与 test:unit 兜底同口径）。
  assert.strictEqual(gateSteps[0].if, undefined,
    'test.yml 的源码文本断言闸门不得带 step 级 if: 条件——只在某些事件/恒假条件下跑等于该步骤从未存在')
  assert.strictEqual(gateSteps[0]['continue-on-error'], undefined,
    'test.yml 的源码文本断言闸门不得设 continue-on-error: true——失败不阻断 job = 闸门永不拦人')
  // 增长参照接线（r23-B2）：步骤存在 ≠ 能核对。基线「只减不增」要把当前基线与**参照提交里的基线**逐文件
  // 比一遍，而 quality job 默认是浅克隆（depth=1）——参照（base 分支提交 / HEAD 之前那个提交）取不到时
  // 闸门在 CI（CI=true）上 fail-closed（exit 2）或退回「无法核对增长」，两种都不是「已核对」。缺任一项，
  // 被拦的「手改 by_file 与 total 等量抬高」就重新变成假绿，故这里把两项一起锁死：
  //   · checkout 必须 fetch-depth: 0（整取历史）；
  //   · 该步骤必须经 env 注入 SOURCE_TEXT_ASSERT_BASELINE_REF = origin/${{ github.base_ref || 'main' }}
  //     （PR 上是 base 分支，push 到 main 时由闸门改用它之前的提交），不得内联进 run（run 串要与本地
  //     同一条 npm 链），也不得写成 HEAD（那就是被判定提交本身 ⇒ 基线自比自恒绿）。
  const checkout = steps.find((s) => s && typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'))
  assert.ok(checkout, 'quality job 必须有 actions/checkout 步骤（增长核对要读参照提交里的基线）')
  assert.strictEqual(checkout.with && checkout.with['fetch-depth'], 0,
    'quality job 的 checkout 必须 fetch-depth: 0——浅克隆取不到 base 分支 / 父提交，闸门在 CI 上 fail-closed（exit 2）')
  // 逐段拼接：期望值含 GitHub 表达式语法（`${{`），直接写字面量会触发 standard 的 no-template-curly-in-string。
  const BASELINE_REF_EXPECTED = 'origin/$' + '{{ github.base_ref || ' + "'main' }}"
  assert.strictEqual(gateSteps[0].env && gateSteps[0].env.SOURCE_TEXT_ASSERT_BASELINE_REF, BASELINE_REF_EXPECTED,
    `该步骤必须经 env 注入增长参照 SOURCE_TEXT_ASSERT_BASELINE_REF=${BASELINE_REF_EXPECTED}（PR 上是 base 分支）`)
  assert.ok(!String(gateSteps[0].run).includes('baseline-ref'),
    'REF 不得内联进 run：步骤 run 串必须与本地同一条 npm 链（npm run check:assert-style）')
  const policySteps = (workflow.jobs.policy && workflow.jobs.policy.steps) || []
  assert.strictEqual(policySteps.filter((s) => s && s.run === 'npm run check:assert-style').length, 0,
    'policy job 不得再挂该闸门：policy 刻意零依赖（不 npm ci），require(\'acorn\') 必 MODULE_NOT_FOUND')
}

check('check:assert-style 三处接线：check 链 / pre-commit / test.yml 缺任一处即红（v3.444）', () => {
  const pkg = JSON.parse(read('package.json'))
  // 结构视图：hook 走 parseShell 的 tokens，workflow 走 loadYaml 的 job/step 字段（不比对源码行文本）。
  const hook = parseShell('.githooks/pre-commit')
  const wf = loadYaml('.github/workflows/test.yml')
  assertAssertStyleWiring(pkg, hook, wf)
  // 反例（三处各删一处，必须逐个红）：只断言「文件里出现过这个词」的写法在删掉接线后仍然绿，
  // 这几个反例就是这条用例不是那种写法的证据。
  const chainBroken = JSON.parse(read('package.json'))
  chainBroken.scripts.check = chainBroken.scripts.check.split(' && ').filter((step) => step !== 'npm run check:assert-style').join(' && ')
  assert.throws(() => assertAssertStyleWiring(chainBroken, hook, wf), /check 链必须包含 check:assert-style/,
    'check 链摘掉 check:assert-style 后必须判红')
  const hookBroken = hook.filter((l) => !(l.tokens[0] === 'run_gate' && l.tokens.includes('check:assert-style')))
  assert.throws(() => assertAssertStyleWiring(pkg, hookBroken, wf), /pre-commit 必须有且只有一道/,
    'pre-commit 摘掉该 run_gate 后必须判红')
  const wfBroken = JSON.parse(JSON.stringify(wf))
  wfBroken.jobs.quality.steps = wfBroken.jobs.quality.steps.filter((s) => s.run !== 'npm run check:assert-style')
  assert.throws(() => assertAssertStyleWiring(pkg, hook, wfBroken), /quality job 必须有且只有一步/,
    'test.yml 摘掉该步骤后必须判红')
  // job 反例（C 的 should_fix）：只判「接上了没有」时，把步骤挪到零依赖的 policy 仍然绿——这里必须红。
  // 两个方向各一条：① 同一道闸门同时挂到 policy ⇒ policy 守卫红；② 从 quality 挪走 ⇒ quality 守卫红。
  const wfDup = JSON.parse(JSON.stringify(wf))
  const gateStep = wfDup.jobs.quality.steps.filter((s) => s.run === 'npm run check:assert-style')
  wfDup.jobs.policy.steps = [...(wfDup.jobs.policy.steps || []), ...gateStep]
  assert.throws(() => assertAssertStyleWiring(pkg, hook, wfDup), /policy job 不得再挂该闸门/,
    '把闸门同时挂到 policy job 必须判红（零依赖 job 里 require(acorn) 会 MODULE_NOT_FOUND）')
  const wfMoved = JSON.parse(JSON.stringify(wfDup))
  wfMoved.jobs.quality.steps = wfMoved.jobs.quality.steps.filter((s) => s.run !== 'npm run check:assert-style')
  assert.throws(() => assertAssertStyleWiring(pkg, hook, wfMoved), /quality job 必须有且只有一步/,
    '把闸门从 quality 挪走（挪到 policy 也不能算接上）必须判红')
  // 顺序反例：闸门排到 npm test 之后就失去了「先失败」的意义（矩阵作业要先跑一遍全量测试才红）。
  const orderBroken = JSON.parse(read('package.json'))
  orderBroken.scripts.check = 'npm test && npm run check:assert-style'
  assert.throws(() => assertAssertStyleWiring(orderBroken, hook, wf), /排在 npm test 之前/,
    '把闸门排到 npm test 之后必须判红')
  // 条件化反例（r17-B）：只判「存在 / 名字 / run 串」时，给该步骤注入 step 级条件或
  // continue-on-error 后三种写法全部照绿（CI 上这道闸永不执行或永不阻断）。逐个必须红。
  const conditionalStep = (mutate) => {
    const broken = JSON.parse(JSON.stringify(wf))
    const step = broken.jobs.quality.steps.find((s) => s && s.run === 'npm run check:assert-style')
    mutate(step)
    return broken
  }
  assert.throws(() => assertAssertStyleWiring(pkg, hook, conditionalStep((s) => {
    // 逐段拼接：该字符串含 GitHub 表达式语法（`${`），直接写字面量会触发 standard 的
    // no-template-curly-in-string（这不是模板字符串）。
    s.if = '$' + '{{ github.event_name == ' + "'push'" + ' }}'
  })), /不得带 step 级 if/,
  '给该步骤加 step 级 if 条件必须判红（PR 事件上就整道闸不跑）')
  assert.throws(() => assertAssertStyleWiring(pkg, hook, conditionalStep((s) => {
    s.if = false
  })), /不得带 step 级 if/,
  '给该步骤加 if: false 必须判红（恒假 = 该步骤从未存在）')
  assert.throws(() => assertAssertStyleWiring(pkg, hook, conditionalStep((s) => {
    s['continue-on-error'] = true
  })), /不得设 continue-on-error/,
  '给该步骤加 continue-on-error: true 必须判红（失败不阻断 job = 闸门永不拦人）')
  // 增长参照的两条靶向反例（r23-B2）：这两项各自被摘掉时，增长核对都会退回「没参照」——
  // 前者在 CI 上 exit 2（闸门常红），后者让「手改 by_file 与 total 等量抬高」重新假绿。逐个必须红。
  const dropCheckoutKey = (key) => {
    const broken = JSON.parse(JSON.stringify(wf))
    const co = broken.jobs.quality.steps.find((s) => s && typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'))
    delete co.with[key]
    return broken
  }
  assert.throws(() => assertAssertStyleWiring(pkg, hook, dropCheckoutKey('fetch-depth')), /fetch-depth: 0/,
    '摘掉 checkout 的 fetch-depth: 0 必须判红（浅克隆取不到参照 ⇒ CI 上 fail-closed）')
  const dropRefEnv = (mutate) => {
    const broken = JSON.parse(JSON.stringify(wf))
    const step = broken.jobs.quality.steps.find((s) => s && s.run === 'npm run check:assert-style')
    if (mutate) mutate(step)
    else delete step.env
    return broken
  }
  assert.throws(() => assertAssertStyleWiring(pkg, hook, dropRefEnv()), /必须经 env 注入增长参照/,
    '摘掉 env 的 SOURCE_TEXT_ASSERT_BASELINE_REF 必须判红（没有参照 = 增长核对静默失效）')
  assert.throws(() => assertAssertStyleWiring(pkg, hook, dropRefEnv((s) => {
    s.env.SOURCE_TEXT_ASSERT_BASELINE_REF = 'HEAD'
  })), /必须经 env 注入增长参照/,
  '把参照写成 HEAD 必须判红（HEAD 就是被判定提交本身，基线自比自恒绿——r23-A1/B1/C1 的原缺陷）')
  assert.throws(() => assertAssertStyleWiring(pkg, hook, dropRefEnv((s) => {
    s.run = 'npm run check:assert-style --baseline-ref origin/main'
  })), /必须走与本地同一条 npm 链/,
  '把参照内联进 run 必须判红（run 串与本地链分叉，参照接线再也不会被同一套断言看见）')
})

check('scorecard.yml：analysis job 的 job 级 permissions 必须显式保留 contents: read（C10-047）', () => {
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
  assert.deepStrictEqual([...targets].sort(byCodeUnit), [...onDisk].sort(byCodeUnit),
    '.githooks 下的常规文件必须全部在扫描面内（新增钩子漏扫 = 门禁缺一块）')
  // 比较器口径必须是码元序：'B'（0x42）排在 'a'（0x61）之前，而 localeCompare 按语言环境做
  // 大小写不敏感比较会给出相反顺序 ⇒ 换成 localeCompare 时这条红（扫描面比对不许随宿主 locale 漂移）。
  assert.deepStrictEqual(['a', 'B'].sort(byCodeUnit), ['B', 'a'],
    '扫描面比对必须按 UTF-16 码元序（localeCompare 会把 a 排到 B 之前）')
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
