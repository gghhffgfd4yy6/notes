'use strict'

// 注册表元校验（C5）：根目录每个 test_*.js 都必须在 test_suites.js 的 SUITES 中注册。
// 背景：run_tests.js / run_unit_tests.js 都只遍历 SUITES —— 新增一个 test_*.js 却忘记注册，
// CI 永远不会执行它，且没有任何东西会报警（#131 的 test_tag_validator.js 就这样「测了等于没测」，
// 直到下一个提交 #132 才补进 SUITES）。本套件把「新文件必须注册」变成 CI 会执行、失败会红的门禁。
// 运行方式：node test_suite_registry.js（exit 0 = 通过；断言抛出即非 0 退出）。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { SUITES } = require('./test_suites')

// 仓库根 = 本文件所在目录（__dirname）：不依赖 cwd，CI 直跑、run_unit_tests.js 子进程、
// run_mutation.js 的 copyProject 沙箱（会把全部 test_*.js 与 test_suites.js 复制到沙箱根）三种场景都成立。
const ROOT = path.resolve(__dirname)
// 与 copyProject（run_mutation.js:101 `/^test_.*\.js$/`）同一口径的「根目录测试文件」判定
const TEST_FILE_RE = /^test_.*\.js$/

// 白名单：有意不注册进 SUITES 的根目录 test_*.js。当前只需要这 2 个，请保持最小。
// ⚠️ 新增白名单条目必须在本数组内用注释写明理由（为什么它由别处覆盖 / 为什么它不属于本门禁）；
//    白名单不是「静默忽略」——「新增文件但忘了注册」一定红，只有显式加名才放行；条目一旦陈旧
//    （文件不存在，或该文件已注册进 SUITES）本套件会报错要求删除，防止留下永久盲区。
const REGISTRY_EXEMPTIONS = [
  // test_app.js：由 CI 显式步骤覆盖 —— .github/workflows/test.yml 的「集成测试（串行完整版，
  // 仅并行失败时兜底运行）」步骤跑 `npm run test:app:serial`（package.json 中该脚本 = node test_app.js）；
  // SUITES 里的 test_app_p.js 是它的并行调度版（integration: true），见 test_suites.js 该条目上方注释。
  'test_app.js',
  // test_suites.js：注册表自身，不是测试套件（只导出 SUITES，无断言可跑），要求它注册自己属于自指。
  'test_suites.js'
]

// 双向对账（纯函数：exists 由调用方注入，真实运行查磁盘，自测注入合成结果，避免两份口径漂移）
function reconcile (diskTestFiles, registeredFiles, exemptions, exists) {
  const registeredSet = new Set(registeredFiles)
  const exemptSet = new Set(exemptions)
  return {
    // ① 磁盘上有、SUITES 里没有、也不在白名单 → 漏注册（本门禁的核心，必须红）
    unregistered: diskTestFiles.filter(f => !registeredSet.has(f) && !exemptSet.has(f)),
    // ② SUITES 里有、磁盘上找不到 → 幽灵条目（执行时必然 ENOENT，而报错不会指明是清单漂移）
    ghosts: registeredFiles.filter(f => !exists(f)),
    // ③ 白名单条目已失效（文件不存在，或已注册进 SUITES）→ 陈旧白名单，白名单必须保持最小
    staleExemptions: exemptions.filter(f => !diskTestFiles.includes(f) || registeredSet.has(f))
  }
}

// 漏注册的失败信息：列出文件名 + 可直接照抄的条目 + 「请把 X 加入 test_suites.js」提示
function unregisteredHint (files) {
  return '以下根目录测试文件未在 test_suites.js 的 SUITES 中注册，CI 永远不会执行（测了等于没测）：\n' +
    files.map(f => `  - ${f}：请把 { name: '…', file: '${f}', desc: '…' } 加入 test_suites.js 的 SUITES`).join('\n') +
    '\n（若确实有意不注册，必须在本文件 REGISTRY_EXEMPTIONS 显式加名并写明理由，不得静默放行）'
}

const byName = (a, b) => a.localeCompare(b) // 显式比较函数：默认 sort 的字符串序不保证稳定可预期
const diskTestFiles = fs.readdirSync(ROOT).filter(f => TEST_FILE_RE.test(f)).sort(byName)
const registeredFiles = [...new Set(SUITES.map(s => s.file))]
assert.ok(registeredFiles.length > 0, 'SUITES 不应为空（test_suites.js 需导出已注册套件清单）')

const { unregistered, ghosts, staleExemptions } =
  reconcile(diskTestFiles, registeredFiles, REGISTRY_EXEMPTIONS, f => fs.existsSync(path.join(ROOT, f)))

// ① 漏注册：新文件忘记注册时在这里红，并给出文件名与「请加入 test_suites.js」提示
assert.deepStrictEqual(unregistered, [], unregisteredHint(unregistered))

// ② 幽灵条目：清单指向不存在的文件（拼错/重命名/删除后忘了改清单）
assert.deepStrictEqual(ghosts, [],
  `test_suites.js 注册了不存在的文件（幽灵条目，执行时必然 ENOENT）：${ghosts.join(', ')}\n` +
  '请修正这些条目：改回真实文件名，或从 SUITES 删除')

// ③ 陈旧白名单：重命名/已注册后必须删除对应条目，否则白名单会越攒越大而失去意义
assert.deepStrictEqual(staleExemptions, [],
  `REGISTRY_EXEMPTIONS 含陈旧条目（文件不存在，或该文件已注册进 SUITES）：${staleExemptions.join(', ')}\n` +
  '白名单必须尽可能小，请删除这些条目')

// 校验逻辑自测：用合成数据把三个失败方向固定在门禁里（本机无法实跑，等价于对真实场景的推演固化）。
// ⚠️ exists 桩的语义必须与用例语境一致，否则 ghosts 会被桩本身污染（曾经用 () => false 笼统表示
//    「无文件」，结果所有已注册文件都被判成幽灵——本块桩全部显式命名语义，判断式桩只用于制造幽灵的用例）。
{
  const allExists = () => true // 桩：注册文件都在磁盘上（用于「不报幽灵」的语境）
  // 情形①：假设新增 test_foo.js 未注册 → 必须报漏注册；文件都存在时不得误报幽灵
  const missing = reconcile(['test_suites.js', 'test_foo.js'], ['test_suites.js'], ['test_suites.js'], allExists)
  assert.deepStrictEqual(missing.unregistered, ['test_foo.js'], '未注册的新增 test_*.js 必须报漏注册')
  assert.deepStrictEqual(missing.ghosts, [], '文件都存在时不应报幽灵条目')

  // 情形②：假设 SUITES 有一条指向不存在的文件 → 必须报幽灵条目
  // （判断式桩：只有 test_suites.js 真实存在，test_gone.js 不存在 → 该条目必被判幽灵）
  const ghost = reconcile(['test_suites.js'], ['test_suites.js', 'test_gone.js'], ['test_suites.js'],
    f => f === 'test_suites.js')
  assert.deepStrictEqual(ghost.ghosts, ['test_gone.js'], '指向不存在文件的条目必须报幽灵')
  assert.deepStrictEqual(ghost.unregistered, [], '磁盘文件都已注册时不应报漏注册')

  // 通过路径：全部已注册（磁盘上的测试文件都在清单内，其余走显式白名单）→ 三项均空 = 通过
  const allOk = reconcile(['test_app.js', 'test_suites.js', 'test_x.js'], ['test_x.js'],
    ['test_app.js', 'test_suites.js'], allExists)
  assert.deepStrictEqual(allOk.unregistered, [], '全部已注册（白名单外的文件都在清单里）时不应报漏注册')
  assert.deepStrictEqual(allOk.ghosts, [], '全部已注册且文件都存在时不应报幽灵')
  assert.deepStrictEqual(allOk.staleExemptions, [], '有效的白名单条目不应报陈旧')

  // 白名单语义：只对显式加名放行，且必须保持最小 —— 文件被注册进 SUITES 后条目即刻陈旧，
  // 文件被重命名/删除后条目同样陈旧（两种都要报错要求删除）。
  const exempted = reconcile(['test_app.js'], [], ['test_app.js'], allExists)
  assert.deepStrictEqual(exempted.unregistered, [], '显式白名单的文件不报漏注册')
  assert.deepStrictEqual(reconcile(['test_app.js'], ['test_app.js'], ['test_app.js'], allExists).staleExemptions,
    ['test_app.js'], '已注册进 SUITES 的白名单条目必须报陈旧（白名单保持最小）')
  // 白名单里的文件已不存在（重命名/删除）：diskTestFiles 里没有它 → 必须报陈旧
  assert.deepStrictEqual(reconcile(['test_suites.js'], [], ['test_renamed.js'], allExists).staleExemptions,
    ['test_renamed.js'], '白名单里的文件不存在（重命名/删除）必须报陈旧')

  // 桩语义自检：判断式桩返回 false 时该注册条目必须被判为幽灵 ——
  // 固化「ghosts 由注入的 exists 决定」，防止再写出桩与期望自相矛盾的用例
  assert.deepStrictEqual(reconcile(['test_x.js'], ['test_x.js'], [], () => false).ghosts, ['test_x.js'],
    'exists 桩返回 false 时该注册条目必须被判为幽灵（桩语义自检）')
  console.log('✅ 校验逻辑自测通过（漏注册 / 幽灵条目 / 白名单陈旧 三个失败方向）')
}

// ④ 注册表条目形状 / 重复注册（test_suites.js 加载期校验的回归锁定）：
//    本套件的双向对账只比 file 集合——条目缺 name/desc、重复注册同一文件/同名套件都「看不见」，
//    必须由 test_suites.js 的加载期 throw 兜住。用临时沙箱改写注册表副本 require，三种坏形态各自必须失败。
{
  const base = fs.readFileSync(path.join(__dirname, 'test_suites.js'), 'utf8')
  const guardMarker = '// 注册表自身的加载期形状校验'
  const guardAt = base.indexOf(guardMarker)
  assert.ok(guardAt > 0, 'test_suites.js 应含加载期形状校验块（夹具需把坏条目插在校验之前）')
  const tail = base.slice(base.lastIndexOf('module.exports'))
  // 坏条目必须插在**校验块之前**（push 在校验之后 = 绕过校验，形同虚设）：
  // preGuard（SUITES 数组为止）+ push 坏条目 + 完整校验块 + module.exports
  const preGuard = base.slice(0, base.lastIndexOf('\n', guardAt) + 1)
  const guardBlock = base.slice(base.lastIndexOf('\n', guardAt) + 1, base.lastIndexOf('module.exports'))
  const variantSrc = (push) => preGuard + push + guardBlock + tail
  const variants = [
    { name: '条目缺 name', expect: '缺字段', src: variantSrc("SUITES.push({ file: 'test_foo.js', desc: '缺 name 的条目' })\n") },
    { name: '重复注册同一文件', expect: '重复注册同一文件', src: variantSrc("SUITES.push({ name: '重复文件', file: SUITES[0].file, desc: '重复注册' })\n") },
    { name: '重复套件名', expect: '重复的套件名', src: variantSrc("SUITES.push({ name: SUITES[0].name, file: 'test_bar.js', desc: '重名条目' })\n") }
  ]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-registry-shape-'))
  try {
    for (const v of variants) {
      fs.writeFileSync(path.join(dir, 'test_suites.js'), v.src)
      // 沙箱里只 require 注册表本身（其加载期校验不读磁盘清单），无需复制其它文件
      const r = spawnSync(process.execPath, ['-e', "require('" + path.join(dir, 'test_suites.js') + "')"], { encoding: 'utf8' })
      assert.notStrictEqual(r.status, 0, `${v.name}：test_suites.js 加载期校验必须失败（否则坏条目静默进入执行清单）`)
      assert.ok(r.stderr.includes(v.expect),
        `${v.name}：失败应是注册表自身的 throw 而非意外崩溃\n${r.stderr}`)
    }
    // 正向：真实注册表必须可加载且通过校验（防止上方反例把「永远失败」当成通过）
    assert.ok(SUITES.length > 0, '真实 test_suites.js 应可加载（加载期校验通过）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('✅ 注册表形状门禁：缺 name / 重复文件 / 重复套件名 三种坏条目均被 test_suites.js 加载期校验拦截')
}

// ============================================================
// C10-027：scripts/tap-shim.js 的**运行期契约**必须有执行级用例。
//
// 此前该文件只在 CI 变异缓存 key 的字符串断言里出现（`hashFiles(… 'scripts/tap-shim.js')`）——
// 改坏 shim 的判定/转发逻辑不会有任何东西变红。唯一已有的执行探针是 test_ci_skip_suites.js 的 3g5
// （正常退出 0 / 非 0 退出 / fd 1 被 closeSync 三条**投递**路径），本段补它没覆盖的三块：
//   ① stdout 全部让给 TAP：正文的 console.log 与 TAP 形状行必须改走 stderr，否则 tap-parser 会多解析
//      出测试点、plan 不匹配（dry-run 假失败）；
//   ② 跳过判定与 command 档同源：未注册 / integration / mutationSkip / SKIP_SUITES 一律 `ok # SKIP` +
//      exit 0，**且正文不得执行**（判定必须发生在被测文件加载之前，否则「跳过」只是嘴上说说）；
//   ③ argv[1] 缺失（tap-runner 没把被测文件传进来）必须响亮失败：not ok + 非 0 退出码。
//
// 为什么挂在本套件、不新建 test_tap_shim.js：shim 的第 2 项职责就是消费**注册表**（SUITES 的
// integration/mutationSkip 与 SKIP_SUITES），本套件已经是注册表策略的对账方；而新建套件必须同步
// test_suites.js 与 stryker.tap.config.js 的**顺序锁定**显式清单（后者在加载期按序对账两档测试集），
// 为一个适配层扩大两处配置的改动面不划算。
//
// 夹具口径：**只复制 shim + 自带注册表**的临时沙箱。shim 用字面量相对路径 require
// '../test_suites.js'（按 shim 自身解析），沙箱里换成夹具注册表，才能构造「未注册 / integration /
// mutationSkip」三种形态而不动真注册表；被测文件正文写一个 sentinel 文件，用来证明「正文到底跑没跑」。
// ============================================================
{
  const SANDBOX_REGISTRY =
    'module.exports = { SUITES: [' +
    "{ name: '普通', file: 'test_stub_plain.js', desc: '普通套件（应运行）' }," +
    "{ name: '集成', file: 'test_stub_integration.js', desc: '集成套件', integration: true }," +
    "{ name: '变异跳过', file: 'test_stub_mutationskip.js', desc: '沙箱内不可运行', mutationSkip: true }" +
    '] }\n'

  // registry: false ⇒ 沙箱里故意不放 test_suites.js（构造「注册表读不到」）
  const makeShimSandbox = (withRegistry) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-tap-shim-'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.copyFileSync(path.join(ROOT, 'scripts', 'tap-shim.js'), path.join(dir, 'scripts', 'tap-shim.js'))
    if (withRegistry) fs.writeFileSync(path.join(dir, 'test_suites.js'), SANDBOX_REGISTRY)
    return dir
  }

  // 被测文件正文：写 sentinel（证明真的执行了）+ 往 stdout 打普通正文与一行 TAP 形状输出
  const bodyFor = (sentinel) =>
    "require('node:fs').writeFileSync(" + JSON.stringify(sentinel) + ", 'ran')\n" +
    "console.log('ok 99 - 正文里的假测试点')\n" +
    "console.log('普通正文行')\n" +
    'process.exit(0)\n'

  const runShimIn = (dir, args, envOverride) => {
    const env = { ...process.env }
    // 调用方环境（CI 的单元步骤设了 SKIP_SUITES）会改写本次探针的判定，默认清空
    delete env.SKIP_SUITES
    Object.assign(env, envOverride || {})
    const r = spawnSync(process.execPath, ['-r', path.join(dir, 'scripts', 'tap-shim.js'), ...args],
      { cwd: dir, encoding: 'utf8', env, timeout: 20000, killSignal: 'SIGKILL' })
    assert.ok(!r.error && !r.signal,
      `shim 探针未正常收场（error=${r.error && r.error.code} signal=${r.signal}）：挂死/被强杀必须明确失败，不得等外层超时`)
    return r
  }

  // ① stdout 让给 TAP
  const dir = makeShimSandbox(true)
  try {
    const sentinel = path.join(dir, 'body-ran')
    const plain = path.join(dir, 'test_stub_plain.js')
    fs.writeFileSync(plain, bodyFor(sentinel))
    const r = runShimIn(dir, [plain])
    assert.strictEqual(r.status, 0, `正常退出必须 exit 0（stderr: ${r.stderr.trim()}）`)
    assert.strictEqual(fs.existsSync(sentinel), true, '前提：正常路径必须真的执行了被测文件正文（否则下面的断言都没意义）')
    assert.strictEqual(r.stdout, 'TAP version 13\nok 1 - test_stub_plain.js\n1..1\n',
      'stdout 必须只剩 TAP 三行：正文的 console.log 与 TAP 形状行一旦进入 TAP 流，tap-parser 会多解析出测试点、plan 不匹配')
    assert.ok(r.stderr.includes('ok 99 - 正文里的假测试点'),
      '正文的 TAP 形状行必须原样改走 stderr（改走可以，吞掉不行——那会改变被测文件的可观测行为）')
    assert.ok(r.stderr.includes('普通正文行'), '正文的普通输出同样必须走 stderr')
    assert.ok(r.stderr.includes('正文里出现过 1 行 TAP 形状输出'),
      `shim 必须在退出时如实留证：正文里出现过几行 TAP 形状输出（实际 stderr：${JSON.stringify(r.stderr)}）`)

    // ② 跳过判定与 command 档同源（四类），且必须在被测文件加载前生效
    const skipCases = [
      { file: 'test_stub_unregistered.js', env: {}, note: /未注册进 test_suites\.js/ },
      { file: 'test_stub_integration.js', env: {}, note: /integration/ },
      { file: 'test_stub_mutationskip.js', env: {}, note: /mutationSkip/ },
      { file: 'test_stub_plain.js', env: { SKIP_SUITES: 'test_stub_plain.js' }, note: /SKIP_SUITES=/ }
    ]
    for (const c of skipCases) {
      const p = path.join(dir, c.file)
      fs.writeFileSync(p, bodyFor(sentinel))
      fs.rmSync(sentinel, { force: true })
      const s = runShimIn(dir, [p], c.env)
      assert.strictEqual(s.status, 0, `${c.file}：跳过必须 exit 0（stderr: ${s.stderr.trim()}）`)
      const skipLine = s.stdout.split('\n').find((l) => l.startsWith('ok 1 - ' + c.file + ' # SKIP '))
      assert.ok(skipLine, `${c.file}：必须投出「ok 1 - <文件> # SKIP …」的跳过点（实际 stdout：${JSON.stringify(s.stdout)}）`)
      assert.ok(c.note.test(skipLine), `${c.file}：跳过原因必须点明判定依据（实际：${skipLine}）`)
      assert.ok(s.stdout.split('\n').includes('1..1'), `${c.file}：跳过点也必须带 plan 行 1..1`)
      assert.strictEqual(fs.existsSync(sentinel), false,
        `${c.file}：跳过必须在被测文件加载前生效（正文写了 sentinel = 仍在执行本应跳过的文件）`)
    }

    // ③ argv[1] 缺失：适配层没被 tap-runner 正确调用，必须响亮失败
    const noArg = runShimIn(dir, ['-e', '0'])
    assert.strictEqual(noArg.status, 1, 'argv[1] 缺失必须非 0 退出（否则适配层失效会静默变成全绿）')
    assert.strictEqual(noArg.stdout, 'TAP version 13\nnot ok 1 - unknown # tap-shim 无法从 argv[1] 取到被测文件\n1..1\n',
      'argv[1] 缺失必须投 not ok 点（非 0 退出无失败测试会被 tap-runner 记 RuntimeError，两种都响亮，但不能静默）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ④ C10-038：注册表读不到是**适配层自身失效**，不是「本文件该跳过」。
  //    旧实现把它当成 skipReason ⇒ `ok 1 - … # SKIP` + exit 0，与注释声称的 fail-closed 相反：
  //    tap-parser 会把这一条记成**通过**，于是「跳过集合无法与 command 档对齐」这件事在 TAP 档里
  //    长得跟全绿一样（perTest 下零测试文件的段也不会有任何失败信号）。
  //    正确语义：not ok + 非 0 退出（tap-runner 记 RuntimeError ⇒ 响亮），且不得执行被测文件。
  //    附带契约：note 必须压成**单行** —— err.message 带 "Require stack:" 多行栈，直接拼进 TAP 点会把
  //    一个测试点撕成多行，plan(1..1) 与 extra 行错位（旧实现在本用例的沙箱里就是这么坏的）。
  const noRegDir = makeShimSandbox(false)
  try {
    const sentinel = path.join(noRegDir, 'body-ran')
    const p = path.join(noRegDir, 'test_stub_plain.js')
    fs.writeFileSync(p, bodyFor(sentinel))
    const r = runShimIn(noRegDir, [p])
    assert.strictEqual(r.status, 1, '注册表读不到必须非 0 退出（fail-closed：不能像「该跳过」那样 exit 0）')
    const lines = r.stdout.split('\n')
    assert.strictEqual(lines.length, 4, `TAP 点必须是单行 note（实际 stdout：${JSON.stringify(r.stdout)}）`)
    assert.strictEqual(lines[0], 'TAP version 13', 'TAP 首行固定')
    assert.ok(lines[1].startsWith('not ok 1 - test_stub_plain.js # 无法读取 test_suites.js'),
      `注册表不可读必须投 not ok 点（实际：${lines[1]}）`)
    assert.strictEqual(lines[2], '1..1', 'plan 行必须紧随测试点（note 含换行会把它挤到 extra 之后）')
    assert.ok(!/^Require stack:/m.test(r.stdout), 'note 里的多行栈必须被压平在同一行，不得自己占一行（那会把 TAP 点撕开）')
    assert.ok(r.stdout.includes('跳过集合无法与 command 档对齐'), '失败原因必须可读（点明跳过集合无法对齐）')
    assert.strictEqual(fs.existsSync(sentinel), false, '适配层失效时不得执行被测文件（此时无法保证跳过集合与 command 档一致）')
  } finally {
    fs.rmSync(noRegDir, { recursive: true, force: true })
  }
  console.log('✅ tap-shim 运行期契约：stdout 只留 TAP / 四类跳过判定（含正文不得执行）/ argv 缺失响亮失败 / 注册表不可读 fail-closed')
}

console.log(`✅ 根目录 ${diskTestFiles.length} 个 test_*.js 与 SUITES ${registeredFiles.length} 条注册双向一致（白名单 ${REGISTRY_EXEMPTIONS.length} 个：${REGISTRY_EXEMPTIONS.join(', ')}）`)
