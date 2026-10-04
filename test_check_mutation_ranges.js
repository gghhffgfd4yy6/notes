'use strict'

// check-mutation-ranges.js 导出 globToRegExp / listRepoJsFiles 供直接 require 复用，失败收场收敛到
// exitIfDirectRun（直跑 process.exit、被 require 则 throw）；夹具 yml 通过 MUTATION_WORKFLOW_TEXT 注入。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname)
const SCRIPT = path.join(ROOT, 'scripts', 'check-mutation-ranges.js')

// 测试用目标文件：动态选取第一个 xbk_*.js 生产文件，避免硬编码重命名后崩
const TEST_FILE = fs.readdirSync(ROOT).find(f => /^xbk_.*\.js$/.test(f)) || 'xbk_utils.js'
const TEST_FILE_LINES = (() => {
  const raw = fs.readFileSync(path.join(ROOT, TEST_FILE), 'utf8')
  return raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
})()

// 段名必须与 mutation-report 的 EXPECTED_SEGMENTS 一致（check-mutation-ranges 会校验），
// 故默认夹具使用真实段名；被 overrides 拆分/合并的用例段名可能不再对应（那些用例只断言 exit 1 + 具体报错）。
const SPECIAL_SEGMENTS = {
  'xbk_function_v3.js': ['v3-entry'],
  'xbk_sendNotify_slim.js': ['sendnotify-part1', 'sendnotify-part2'],
  'qinglong/xbk_push.js': ['qinglong-push'],
  'scripts/check-deps.js': ['check-deps'],
  'scripts/status.js': ['status']
}
const SPLIT_BOUNDARY_RANGES = { 'xbk_sendNotify_slim.js': 750 } // 拆段边界固定，终点随文件增长自动跟随

// 构造包含所有生产文件的 yml，行段可按文件覆盖
function buildYml (overrides = {}) {
  const productionFiles = [
    ...fs.readdirSync(ROOT).filter(f => /^xbk_.*\.js$/.test(f)),
    'qinglong/xbk_push.js',
    'scripts/check-deps.js',
    'scripts/status.js'
  ]
  const matrix = productionFiles.map(f => {
    const full = path.join(ROOT, f)
    const raw = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : 'x\n'
    const lines = raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
    const names = SPECIAL_SEGMENTS[f] || [f.replace(/^xbk_/, '').replace(/\.js$/, '').replace(/_/g, '-')]
    const fallback = SPLIT_BOUNDARY_RANGES[f]
      ? [`1-${SPLIT_BOUNDARY_RANGES[f]}`, `${SPLIT_BOUNDARY_RANGES[f] + 1}-${lines}`]
      : [`1-${lines}`]
    const ranges = Array.isArray(overrides[f]) ? overrides[f] : (overrides[f] ? [overrides[f]] : fallback.map(() => null))
    return ranges.map((range, i) => {
      const name = names[i] || `${names[0]}-${i}`
      return `          - name: ${name}\n            src: "${f}"\n            mutate: "${f}:${range || fallback[i] || fallback[0]}"`
    }).join('\n')
  }).join('\n')
  return `name: mutation\non: push\njobs:\n  mutation:\n    strategy:\n      matrix:\n        include:\n${matrix}\n`
}

// 全文件变异矩阵夹具（#138 review）：每条 mutate 都不带 `:start-end`，是本 PR 确立的合法写法。
// 与 buildYml 同源——同一份生产文件清单、同一套真实段名（段名仍须满足 EXPECTED_SEGMENTS，故
// xbk_sendNotify_slim.js 会按 sendnotify-part1/part2 出两条、两条都是全文件），仅 mutate 值不带行段。
// omit 用于删掉某个文件的所有条目，验证早退守卫之后的 productionFiles 校验仍在跑。
function buildFullFileYml (omit = null) {
  const productionFiles = [
    ...fs.readdirSync(ROOT).filter(f => /^xbk_.*\.js$/.test(f)),
    'qinglong/xbk_push.js',
    'scripts/check-deps.js',
    'scripts/status.js'
  ].filter(f => f !== omit)
  const matrix = productionFiles.map(f => {
    const names = SPECIAL_SEGMENTS[f] || [f.replace(/^xbk_/, '').replace(/\.js$/, '').replace(/_/g, '-')]
    return names.map(name => `          - name: ${name}\n            src: "${f}"\n            mutate: "${f}"`).join('\n')
  }).join('\n')
  return `name: mutation\non: push\njobs:\n  mutation:\n    strategy:\n      matrix:\n        include:\n${matrix}\n`
}

function run (ymlText) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, MUTATION_WORKFLOW_TEXT: ymlText },
    encoding: 'utf8',
    timeout: 15000
  })
  if (result.error) throw new Error(`spawnSync 失败：${result.error.message}`)
  return result
}

;(async () => {
  // ===== 正常 yml：所有生产文件全覆盖 → exit 0 =====
  const ok = run(buildYml())
  assert.strictEqual(ok.status, 0, `正常全覆盖应 exit 0，实际 ${ok.status}\nstdout: ${ok.stdout}\nstderr: ${ok.stderr}`)

  // ===== 尾部漏测：行段止于实际行数之前 → exit 1 =====
  // #25 修复：错误输出只在 stderr（check-mutation-ranges.js 用 console.error），stdout 是死分支；
  // 去掉 `stderr || stdout` 的 OR 宽容，精确断言 stderr。
  const leak = run(buildYml({ [TEST_FILE]: '1-10' }))
  assert.strictEqual(leak.status, 1, '尾部漏测应 exit 1')
  assert.ok(leak.stderr.includes('未被变异测试覆盖'), '应报尾部未覆盖（stderr）')

  // ===== 行段不连续（缝隙）→ exit 1 =====
  const gap = run(buildYml({ [TEST_FILE]: ['1-10', '20-30'] }))
  assert.strictEqual(gap.status, 1, '行段不连续应 exit 1')
  assert.ok(gap.stderr.includes('不连续'), '应报行段不连续（stderr）')

  // ===== 首段不从第 1 行开始 → exit 1（隔离：行段覆盖到文件末尾，仅首段起始错位）=====
  const head = run(buildYml({ [TEST_FILE]: `5-${TEST_FILE_LINES}` }))
  assert.strictEqual(head.status, 1, '首段不从第 1 行开始应 exit 1')
  assert.ok(head.stderr.includes('首段从第'), '应报首段起始错位（stderr）')

  // ===== 行段超过实际行数 → exit 1 =====
  const over = run(buildYml({ [TEST_FILE]: '1-999999' }))
  assert.strictEqual(over.status, 1, '行段超过实际行数应 exit 1')
  assert.ok(over.stderr.includes('超过文件实际行数'), '应报行段超过实际行数（stderr）')

  // ===== 引用不存在的文件 → exit 1 =====
  const notExist = buildYml() + '          - name: ghost\n            mutate: "nonexistent.js:1-10"\n'
  const ne = run(notExist)
  assert.strictEqual(ne.status, 1, '引用不存在的文件应 exit 1')
  assert.ok(ne.stderr.includes('引用的文件不存在'), '应报文件不存在（stderr）')

  // ===== yml 中无行段 → exit 1 =====
  const noRange = run('name: mutation\non: push\njobs:\n  mutation:\n    runs-on: ubuntu-latest\n')
  assert.strictEqual(noRange.status, 1, '无行段应 exit 1')
  assert.ok(noRange.stderr.includes('未在 mutation.yml 中解析到任何 mutate 行段'), '应报未解析到行段（stderr）')

  // ===== 全文件变异矩阵（#138 review F1）：每条 mutate 都不带行段 = 合法 → exit 0 =====
  // 修复前：fileRanges 必然为空 → 早退守卫把它误判成「未解析到任何 mutate 行段」并 exit 1，
  // 与本 PR 新确立的「全文件变异合法」写法自相矛盾。
  const fullFile = run(buildFullFileYml())
  assert.strictEqual(fullFile.status, 0,
    `全文件变异矩阵应 exit 0（修复前被误报为「未解析到任何 mutate 行段」），实际 ${fullFile.status}\nstdout: ${fullFile.stdout}\nstderr: ${fullFile.stderr}`)
  assert.ok(fullFile.stderr.includes('未带行段'), `应保留全文件条目的 ⚠️ 提示（stderr），实际 stderr: ${fullFile.stderr}`)
  assert.ok(!fullFile.stderr.includes('未在 mutation.yml 中解析到任何 mutate 行段'),
    '全文件矩阵不应再报「未解析到任何 mutate 行段」')

  // ===== 反向断言：守卫没有被削弱 —— 有条目但 mutate 全缺失 → 仍 exit 1 =====
  // fullFileTargets 与 fileRanges 同时为空，早退守卫必须照旧 fail-loud（这是本修复最关键的反向约束）。
  const noMutate = run(buildFullFileYml().split('\n').filter(line => !line.includes('mutate:')).join('\n'))
  assert.strictEqual(noMutate.status, 1, '所有条目都缺 mutate 字段时应 exit 1（守卫放宽后不得变成假绿）')
  assert.ok(noMutate.stderr.includes('未在 mutation.yml 中解析到任何 mutate 行段'),
    `应报未解析到任何 mutate 目标（stderr），实际 stderr: ${noMutate.stderr}`)

  // ===== 守卫只放宽「零目标」判定：早退之后的 productionFiles 校验照旧执行 → exit 1 =====
  // 全文件矩阵删掉一个生产文件（动态取第一个 xbk_*.js）后必须仍 exit 1，且报的是「未列入 mutate 目标」而不是
  // 那条早退错误——证明守卫被通过、后续校验没有被一起绕过。
  const omitFile = run(buildFullFileYml(fs.readdirSync(ROOT).find(f => /^xbk_.*\.js$/.test(f))))
  assert.strictEqual(omitFile.status, 1, '全文件矩阵漏掉一个生产文件应 exit 1（生产文件覆盖校验必须照旧执行）')
  assert.ok(omitFile.stderr.includes('未列入 mutation.yml 的 mutate 目标'),
    `应报生产文件未列入 mutate 目标（stderr），实际 stderr: ${omitFile.stderr}`)
  assert.ok(!omitFile.stderr.includes('未在 mutation.yml 中解析到任何 mutate 行段'),
    '漏条目场景不应命中早退守卫（说明后续校验确实执行了）')

  // ===== 路径越出仓库根目录 → exit 1（拒绝 ../ 越界）=====
  const pathTraversal = buildYml() + '          - name: outside\n            mutate: "../outside.js:1-10"\n'
  const pt = run(pathTraversal)
  assert.strictEqual(pt.status, 1, '路径越出仓库根目录应 exit 1')
  assert.ok(pt.stderr.includes('路径越出仓库根目录'), '应报路径越界（stderr）')

  // ===== 引用以 .js 结尾的目录 → 读取失败 exit 1（EISDIR，正则要求 .js 后缀）=====
  const readFailDir = path.join(ROOT, 'tmp-readfail-dir.js')
  fs.mkdirSync(readFailDir, { recursive: true })
  try {
    const readFailYml = buildYml() + '          - name: readfail\n            mutate: "tmp-readfail-dir.js:1-10"\n'
    const rf = run(readFailYml)
    assert.strictEqual(rf.status, 1, '引用以 .js 结尾的目录应读取失败 exit 1')
    assert.ok(rf.stderr.includes('读取失败'), '应报读取失败（stderr）')
  } finally {
    fs.rmSync(readFailDir, { recursive: true, force: true })
  }

  // ===== glob 相关断言（缺陷C/缺陷B 的回归，qodo #4/#5）=====
  // globToRegExp / listRepoJsFiles 现已被 check-mutation-ranges.js 导出；本文件被 require 时
  // 该脚本不会用 process.exit 结束本测试进程——失败收场收敛到 exitIfDirectRun：直接运行 exit、
  // 被 require 则 throw（健康仓库下不抛）。直接驱动纯函数断言：
  //   - 合法 glob（含 *、?、{a,b} 交替、[字符类]、[!取反]、双星 **）覆盖判定不误报
  //   - `**`（globstar）必须能跨目录分隔符（根级 0 层 / 单层 / 多层嵌套均判为覆盖），不误报 configMissing
  //   - malformed（含 [[、乱序范围 [z-a]、未闭合 [）按字面处理、不抛异常
  const { globToRegExp, listRepoJsFiles } = require('./scripts/check-mutation-ranges.js')
  {
    // globstar 跨目录：'**/xbk_*.js' 必须匹配根级与任意层嵌套
    const xbkRe = globToRegExp('**/xbk_*.js')
    for (const f of ['xbk_a.js', 'src/xbk_b.js', 'src/deep/nested/xbk_c.js']) {
      assert.ok(xbkRe.test(f), `'**/xbk_*.js' 应匹配 ${f}（根级 0 层/单层/多层嵌套），不误报 configMissing`)
    }
    assert.ok(!xbkRe.test('xbk_app/bin.js'), "'**/xbk_*.js' 不应匹配 xbk_app/bin.js")
    assert.ok(!xbkRe.test('other.js'), "'**/xbk_*.js' 不应匹配 other.js")

    // 普通 `*` 不跨目录分隔符
    const starRe = globToRegExp('xbk_*')
    assert.ok(starRe.test('xbk_utils.js'), "'xbk_*' 应匹配根级文件")
    assert.ok(!starRe.test('src/xbk_utils.js'), "'xbk_*' 不应跨 / 匹配子目录（单星语义）")

    // 末尾 `**` 递归匹配其后所有层（scripts/**）
    const dirRe = globToRegExp('src/**')
    assert.ok(dirRe.test('src/a.js'), "'src/**' 应匹配 src/a.js")
    assert.ok(dirRe.test('src/d/b.js'), "'src/**' 应递归匹配深层文件")
    assert.ok(!dirRe.test('src.js'), "'src/**' 不应匹配 src.js")

    // 交替 / 字符类 / 取反类
    assert.ok(globToRegExp('{a,b}.js').test('a.js'), "'{a,b}.js' 应匹配 a.js")
    assert.ok(globToRegExp('{a,b}.js').test('b.js'), "'{a,b}.js' 应匹配 b.js")
    assert.ok(!globToRegExp('{a,b}.js').test('c.js'), "'{a,b}.js' 不应匹配 c.js")
    assert.ok(globToRegExp('[a-c]x.js').test('bx.js'), "字符类 '[a-c]x.js' 应匹配 bx.js")
    assert.ok(!globToRegExp('[a-c]x.js').test('dx.js'), "字符类 '[a-c]x.js' 不应匹配 dx.js")
    assert.ok(globToRegExp('[!a-z]x.js').test('1x.js'), "取反类 '[!a-z]x.js' 应匹配 1x.js")
    assert.ok(!globToRegExp('[!a-z]x.js').test('ax.js'), "取反类 '[!a-z]x.js' 不应匹配 ax.js")

    // malformed：非法/不安全 glob 按字面处理且不抛异常
    for (const bad of ['[[', '[z-a]', '[a-', '{a,', 'a**b', '*.']) {
      assert.doesNotThrow(() => globToRegExp(bad), `malformed glob '${bad}' 不抛异常`)
    }

    // 展开出的仓库文件（listRepoJsFiles）：忽略 test_*.js / node_modules / .git
    const files = listRepoJsFiles()
    assert.ok(files.length > 0, '应能枚举出生产 js 文件')
    assert.ok(files.some(f => /^xbk_.*\.js$/.test(path.basename(f))), '展开清单应含 xbk_* 生产源')
    assert.ok(files.every(f => !/^test_/.test(path.basename(f))), '展开清单不应含 test_*.js')
    assert.ok(files.every(f => !f.includes('node_modules')), '展开清单不应含 node_modules')

    // 缺陷B回归：glob 展开应与 globToRegExp 口径一致——被 glob 覆盖的仓库文件都在展开结果里
    const expanded = files.filter(f => globToRegExp('**/xbk_*.js').test(f))
    assert.ok(expanded.length === files.filter(f => /(?:^|\/)xbk_.*\.js$/.test(f)).length,
      '展开结果应与 globToRegExp 覆盖口径一致')
    console.log('✅ globToRegExp / listRepoJsFiles 断言通过（* ? {a,b} [类] [!取反] ** 与 malformed）')
  }

  // ===== 非法 mutate 行段必须 fail-loud（#136 review F1）：旧实现静默跳过该文件的整段校验 =====
  const malformed = run(buildYml({ [TEST_FILE]: '1-42x' }))
  assert.strictEqual(malformed.status, 1, '非法行段应 exit 1（修复前静默 exit 0，该文件的行数/连续性/尾部校验被整段跳过）')
  assert.ok(malformed.stderr.includes('行段格式非法'), `应报「行段格式非法」，实际 stderr: ${malformed.stderr}`)
  console.log('✅ 非法行段 fail-loud 断言通过')

  // 多余冒号段同样必须拦下（#136 CodeRabbit）：旧实现解构只取前两段，:1-10:extra 会被放行并丢弃尾段
  const surplus = run(buildYml({ [TEST_FILE]: '1-10:extra' }))
  assert.strictEqual(surplus.status, 1, '多余冒号段应 exit 1（旧实现静默丢弃尾段后放行）')
  assert.ok(surplus.stderr.includes('行段格式非法'), `应报「行段格式非法」，实际 stderr: ${surplus.stderr}`)
  console.log('✅ 多余冒号段 fail-loud 断言通过')

  // 起止颠倒（校验 0）：「1-2000, 2001-1470」能被拼成连续且末段终点合法——旧实现（无 start>end
  // 校验）对这类夹具只报末段/非末段的行数错甚至可能漏报，start>end 这一条必须自己点名。
  const reversed = run(buildYml({ [TEST_FILE]: ['1-2000', '2001-1470'] }))
  assert.strictEqual(reversed.status, 1, '起止颠倒的行段应 exit 1')
  assert.ok(reversed.stderr.includes('起止颠倒'), `应报行段起止颠倒（stderr），实际 stderr: ${reversed.stderr}`)

  // 非末段越界（校验 3 的前置兜底）：非末段终点超过实际行数必须被单独点名，而不是只被末段
  // 那条“超过文件实际行数”模糊带过——错误应指出到底是哪一段越界。
  const nonLastOver = run(buildYml({ [TEST_FILE]: ['1-999999', '1000000-1000000'] }))
  assert.strictEqual(nonLastOver.status, 1, '非末段超过实际行数应 exit 1')
  assert.ok(nonLastOver.stderr.includes('非末段'), `应报非末段越界（stderr），实际 stderr: ${nonLastOver.stderr}`)

  console.log('✅ 起止颠倒 / 非末段越界 fail-loud 断言通过')

  // ===== require 路径的失败必须 throw（#136 review A3）：此前删掉 throw 回到「静默返回」本套件仍全绿 =====
  // 直跑路径由上面的 run() 子进程覆盖；require 路径此前无任何断言。用 -e 使 require.main 为
  // undefined（即真实的「被 require」语义），注入空矩阵 yml 后必须抛错而非静默返回。
  const requireProbe = (ymlText) => spawnSync(process.execPath, ['-e', `try { require(${JSON.stringify(SCRIPT)}); console.log('NO-THROW') } catch (e) { console.log('THROW:' + e.message) }`], {
    env: { ...process.env, MUTATION_WORKFLOW_TEXT: ymlText },
    encoding: 'utf8',
    timeout: 15000
  })
  const threw = requireProbe('jobs: {}')
  assert.ok(!threw.error, `require 探针不应 spawn 失败：${threw.error && threw.error.message}`)
  assert.ok(threw.stdout.includes('THROW:'),
    `被 require 且校验失败时应抛错（否则失败被静默吞掉），实际 stdout: ${threw.stdout} stderr: ${threw.stderr}`)
  const noThrow = requireProbe(buildYml())
  assert.ok(noThrow.stdout.includes('NO-THROW'),
    `健康仓库下 require 不应抛错（否则复用该模块的测试会被误杀），实际 stdout: ${noThrow.stdout} stderr: ${noThrow.stderr}`)
  console.log('✅ require 路径契约断言通过（失败抛错 / 健康不抛）')

  // ===== G11-CMR：环境变量入口与 matrix 形状守卫（c8 实测本文件 26 条分支未达）=====
  // 这些分支是「行段门禁自己的 fail-closed 出口」：注入方式写错、matrix 条目缺字段、段名打错、
  // 段名重复——旧实现里任何一条被改成静默跳过，本套件的既有用例（都走「完整合法夹具 + 只改行段」）
  // 一律照绿，而 CI 的矩阵会静默少测整个文件。故逐条断言退出码**与**具体文案。
  {
    const runEnv = (env) => {
      const e = { ...process.env }
      delete e.MUTATION_WORKFLOW_TEXT
      delete e.MUTATION_WORKFLOW_PATH
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete e[k]
        else e[k] = v
      }
      return spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: e, timeout: 20000 })
    }
    // 取 buildYml() 的第一条 matrix 条目做形态手术（其余条目保持合法，确保失败原因唯一）
    const ENTRY_RE = /( {10}- name: (\S+)\n {12}src: "([^"]+)"\n {12}mutate: "([^"]+)"\n)/
    const first = buildYml().match(ENTRY_RE)
    assert.ok(first, '夹具必须能解析出 matrix 条目形态，否则本节用例无法构造')
    const [, entry, eName, eSrc, eMutate] = first
    const withEntry = (replacement) => buildYml().replace(entry, replacement)

    // CMR-01 显式置空 MUTATION_WORKFLOW_PATH ⇒ 必须拒绝，而不是悄悄回退读默认路径
    {
      const r = runEnv({ MUTATION_WORKFLOW_PATH: '' })
      assert.strictEqual(r.status, 1, 'MUTATION_WORKFLOW_PATH 为空串必须非 0（空值不等于“未设置”）')
      assert.ok((r.stderr + r.stdout).includes('MUTATION_WORKFLOW_PATH 不能为空'), `必须点名该环境变量用错：${r.stderr.slice(0, 160)}`)
    }
    // CMR-02 指向不存在的文件 ⇒ 读取失败必须响亮，不得当成“零条目”通过
    {
      const r = runEnv({ MUTATION_WORKFLOW_PATH: path.join(ROOT, 'no-such-workflow-' + process.pid + '.yml') })
      assert.strictEqual(r.status, 1, '指定的工作流文件不存在必须非 0')
      assert.ok((r.stderr + r.stdout).includes('无法读取 mutation.yml'), `必须说明读取失败：${r.stderr.slice(0, 160)}`)
    }
    // CMR-03 文本注入模式下必须显形“没有读真实 yml”（否则本地绿≠CI 绿，与 #156 假绿灯同类）
    {
      const r = run({ })
      const injected = runEnv({ MUTATION_WORKFLOW_TEXT: buildYml() })
      assert.strictEqual(injected.status, 0, `合法文本注入应 exit 0：${injected.stderr.slice(0, 200)}`)
      assert.ok((injected.stderr + injected.stdout + injected.stdout).includes('MUTATION_WORKFLOW_TEXT 注入文本校验'),
        `注入模式必须打出「未读取真实 mutation.yml」提示：stdout=${injected.stdout.slice(0, 200)}`)
      assert.ok(typeof r.status === 'number', '默认路径（读真实 mutation.yml）也必须有确定退出码')
    }
    // CMR-04 matrix 零条目 ⇒ 必须非 0。
    // ⚠️ 实测口径（不伪造命中）：`include:` 为空时先命中 L206 的「未解析到任何 mutate 行段」守卫，
    // 因此 L221 的「未解析到任何 matrix 条目」是**被前一道守卫接管的防御性冗余分支**（c8 显示不可达）。
    // 这里断言实际出口，并留下“两条守卫任一必须拦住”的不变式：将来若有人删掉 L206 早退，
    // 断言仍由 fail-closed 的退出码兜住，而不会被改成“静默通过”。
    {
      const r = run('name: mutation\non: push\njobs:\n  mutation:\n    strategy:\n      matrix:\n        include:\n')
      assert.strictEqual(r.status, 1, 'matrix 零条目必须非 0（不得当成“无需校验”放行）')
      const out = r.stderr + r.stdout
      assert.ok(out.includes('未在 mutation.yml 中解析到任何 mutate 行段') || out.includes('未在 mutation.yml 的 matrix include 中解析到任何条目'),
        `必须由两道守卫中的任一条点名零目标：${out.slice(0, 200)}`)
    }
    // CMR-05 条目缺 name ⇒ 非 0（缓存 key 会退化成 stryker-undefined-*，多段互相覆盖）
    {
      const stripped = `          - src: "${eSrc}"\n            mutate: "${eMutate}"\n`
      const r = run(withEntry(stripped))
      assert.strictEqual(r.status, 1, '缺 name 的条目必须非 0（旧实现会静忽略该条，使该文件整段跳过行段校验）')
      assert.ok((r.stderr + r.stdout).includes('matrix 条目缺 name 字段'), `必须点名缺 name：${r.stderr.slice(0, 200)}`)
    }
    // CMR-06 条目缺 mutate ⇒ 非 0，且诊断必须能定位到条目（缺 name 时用 (无 name) 兜底标签）
    {
      const r = run(withEntry(`          - name: ${eName}\n            src: "${eSrc}"\n`))
      assert.strictEqual(r.status, 1, '缺 mutate 的条目必须非 0')
      assert.ok((r.stderr + r.stdout).includes(eName) && (r.stderr + r.stdout).includes('mutate'),
        `诊断必须带上条目身份与缺失字段：${r.stderr.slice(0, 220)}`)
    }
    // CMR-07 段名重复 ⇒ 非 0（同名的两条会共用同一个增量缓存文件，后者覆盖前者的结果）
    {
      const r = run(withEntry(entry + entry))
      assert.strictEqual(r.status, 1, '重复段名必须非 0')
      assert.ok((r.stderr + r.stdout).includes('matrix name 重复'), `必须点名重复：${r.stderr.slice(0, 200)}`)
      assert.ok((r.stderr + r.stdout).includes(eName), `重复告警必须指名是哪个段名：${r.stderr.slice(0, 200)}`)
    }
    // CMR-08 段名与 mutation-report 的 EXPECTED_SEGMENTS 不一致 ⇒ 非 0（双向对账的另一侧）
    {
      const renamed = entry.replace(`- name: ${eName}`, '- name: zzz-not-a-real-segment')
      const r = run(withEntry(renamed))
      assert.strictEqual(r.status, 1, '矩阵含不认识的段名必须非 0')
      assert.ok((r.stderr + r.stdout).includes('zzz-not-a-real-segment'), `必须点名陌生的段名：${r.stderr.slice(0, 220)}`)
    }
    // CMR-09 globToRegExp 字符类里连字符的两种边界（语义以实测为准，不凭猜写断言）：
    //   · 类首/类尾的 `-` 是字面量成员（L302 的 k===0 / k===cls.length-1 分支）：`[-a]`、`[a-]`
    //     都匹配 `-` 与 `a`；字符类只吃**一个**字符，所以 `[-a]x.js` 这类写法永远匹配不到。
    //   · 连续 `--` 无法确定范围语义（L305）⇒ 实现把整个方括号**降级为字面文本**，而不是
    //     “退化成含 - 的字符类”。若有人改成后者，`[a--b].js` 会开始匹配 a.js/b.js（误杀文件）。
    {
      const { globToRegExp } = require('./scripts/check-mutation-ranges.js')
      const lead = globToRegExp('[-a].js')
      const tail = globToRegExp('[a-].js')
      assert.strictEqual(String(lead), '/^[-a]\\.js$/', '类首的 - 必须原样保留为字面量成员')
      assert.strictEqual(String(tail), '/^[a-]\\.js$/', '类尾的 - 必须原样保留为字面量成员')
      assert.ok(lead.test('-.js') && lead.test('a.js'), '[-a] 必须同时匹配 -.js 与 a.js')
      assert.ok(tail.test('-.js') && tail.test('a.js'), '[a-] 必须同时匹配 -.js 与 a.js')
      assert.ok(!lead.test('x.js') && !tail.test('x.js'), '类内未列出的字符不得被匹配')
      assert.ok(!lead.test('-x.js'), '字符类只吃一个字符：[-a]x.js 不得被匹配（写成长名即失配）')

      const deg = globToRegExp('[a--b].js')
      assert.ok(String(deg).includes('\\['), `连续 - 时方括号必须整体降级为字面文本，实际 ${String(deg)}`)
      assert.ok(deg.test('[a--b].js'), '降级后必须只匹配该字面文件名')
      for (const other of ['a.js', 'b.js', '-.js', 'c.js']) {
        assert.ok(!deg.test(other), `降级为字面后不得匹配 ${other}（若被当成字符类处理就会误杀这些文件）`)
      }
      assert.ok(globToRegExp('[a-c].js').test('b.js') && !globToRegExp('[a-c].js').test('d.js'),
        '对照：合法的 a-c 范围必须仍然生效（不得把降级分支写成默认行为）')
    }
  }

  console.log('test_check_mutation_ranges OK')
})().catch((e) => { console.error(e); process.exit(1) })
