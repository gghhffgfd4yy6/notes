'use strict'

// check-mutation-ranges.js 导出 globMatcher / listRepoJsFiles 供直接 require 复用，失败收场收敛到
// exitIfDirectRun（直跑 process.exit、被 require 则 throw）；夹具 yml 通过 MUTATION_WORKFLOW_TEXT 注入。
const assert = require('assert')
const fs = require('fs')
const os = require('os')
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
  'scripts/status.js': ['status'],
  'scripts/console.js': ['console-part1', 'console-part2', 'console-part3', 'console-part4', 'console-part5', 'console-part6', 'console-part7', 'console-part8', 'console-part9', 'console-part10', 'console-part11', 'console-part12'],
  'xbk_filter_store.js': ['filter-store']
}
// 拆段边界固定（与 mutation.yml 真实矩阵一致），终点随文件增长自动跟随。
// 值为边界数组：N 个边界 ⇒ N+1 段（单边界即两段拆法）。
const SPLIT_BOUNDARY_RANGES = { 'xbk_sendNotify_slim.js': [750], 'scripts/console.js': [563, 1126, 1689, 2252, 2815, 3675, 4370, 4800, 5200, 5800, 6500] }

// 构造包含所有生产文件的 yml，行段可按文件覆盖
function buildYml (overrides = {}) {
  const productionFiles = [
    ...fs.readdirSync(ROOT).filter(f => /^xbk_.*\.js$/.test(f)),
    'qinglong/xbk_push.js',
    'scripts/check-deps.js',
    'scripts/status.js',
    'scripts/console.js'
  ]
  const matrix = productionFiles.map(f => {
    const full = path.join(ROOT, f)
    const raw = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : 'x\n'
    const lines = raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
    const names = SPECIAL_SEGMENTS[f] || [f.replace(/^xbk_/, '').replace(/\.js$/, '').replace(/_/g, '-')]
    const bounds = SPLIT_BOUNDARY_RANGES[f]
    const edges = bounds ? [0, ...bounds, lines] : null
    const fallback = edges
      ? edges.slice(0, -1).map((start, i) => `${start + 1}-${edges[i + 1]}`)
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
    'scripts/status.js',
    'scripts/console.js'
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
  // C10-009 接线证明：同一个「摘掉一个运行链模块」的夹具必须**同时**被新的双向判据点名——只导出
  // 一个没人调用的判定函数不算修好，这条断言锁的是「判据接进了门禁主流程」。
  const omittedRuntimeModule = fs.readdirSync(ROOT).find(f => /^xbk_.*\.js$/.test(f))
  assert.ok(omitFile.stderr.includes(`运行链模块 ${omittedRuntimeModule} 既不是 mutation.yml 的 mutate 目标`),
    `摘掉一个运行链模块必须被双向判据点名（C10-009 接线），实际 stderr 前 400 字：${omitFile.stderr.slice(0, 400)}`)

  // ===== 路径越出仓库根目录 → exit 1（拒绝 ../ 越界）=====
  const pathTraversal = buildYml() + '          - name: outside\n            mutate: "../outside.js:1-10"\n'
  const pt = run(pathTraversal)
  assert.strictEqual(pt.status, 1, '路径越出仓库根目录应 exit 1')
  assert.ok(pt.stderr.includes('路径越出仓库根目录'), '应报路径越界（stderr）')

  // ===== 引用以 .js 结尾的目录 → 读取失败 exit 1（EISDIR，正则要求 .js 后缀）=====
  // 夹具目录名必须按进程唯一：本套件在 Stryker / 并发入口下会被 8 份同时拉起，
  // 固定名会让先结束的进程删掉后一份正在读的目录 ⇒ 误报「引用的文件不存在」而不是「读取失败」。
  const readFailName = `tmp-readfail-dir-${process.pid}.js`
  const readFailDir = path.join(ROOT, readFailName)
  fs.mkdirSync(readFailDir, { recursive: true })
  try {
    const readFailYml = buildYml() + `          - name: readfail\n            mutate: "${readFailName}:1-10"\n`
    const rf = run(readFailYml)
    assert.strictEqual(rf.status, 1, '引用以 .js 结尾的目录应读取失败 exit 1')
    assert.ok(rf.stderr.includes('读取失败'), '应报读取失败（stderr）')
  } finally {
    fs.rmSync(readFailDir, { recursive: true, force: true })
  }

  // ===== glob 相关断言（缺陷C/缺陷B 的回归，qodo #4/#5）=====
  // globMatcher / listRepoJsFiles 现已被 check-mutation-ranges.js 导出；本文件被 require 时
  // 该脚本不会用 process.exit 结束本测试进程——失败收场收敛到 exitIfDirectRun：直接运行 exit、
  // 被 require 则 throw（健康仓库下不抛）。直接驱动谓词断言：
  //   - 合法 glob（含 *、?、{a,b} 交替、[字符类]、[!取反]、双星 **）覆盖判定不误报
  //   - `**`（globstar）必须能跨目录分隔符（根级 0 层 / 单层 / 多层嵌套均判为覆盖），不误报 configMissing
  //   - malformed（含 [[、乱序范围 [z-a]、未闭合 [）按字面处理、不抛异常
  // 实现是 `path.matchesGlob` 的薄壳（匹配语义交给 Node 内置的 minimatch 口径）：下列全部是**行为**
  // 断言，不依赖「生成的正则源码」，将来再换实现也锁得住语义。表里的行与 B-class-diffs.md B3 的实测
  // 对照一一对应，已有的等价断言直接复用、不另写一份。
  const { globMatcher, listRepoJsFiles } = require('./scripts/check-mutation-ranges.js')
  {
    const globCases = [
      // [pattern, 输入路径, 期望] —— 前 9 条即 B3 实测对照（B3 第 10-12 行是 malformed，见下面的循环）
      ['**/xbk_*.js', 'xbk_utils.js', true], // B3-1 根级 0 层：`**/` 匹配零个目录段
      ['**/xbk_*.js', 'scripts/xbk_x.js', true], // B3-2 单层
      ['**/xbk_*.js', 'src/deep/nested/xbk_c.js', true], // 多层嵌套
      ['**/xbk_*.js', 'xbk_app/bin.js', false], // 只跨目录：末段必须真是 xbk_*.js
      ['**/xbk_*.js', 'other.js', false],
      ['xbk_*', 'xbk_utils.js', true], // B3-3
      ['xbk_*', 'scripts/xbk_utils.js', false], // 单星不跨 /
      ['xbk_*.js', 'scripts/a.js', false], // B3-4
      ['src/**', 'src/a.js', true],
      ['src/**', 'src/a/b.js', true], // B3-5 末尾 `**` 递归
      ['src/**', 'src.js', false],
      ['{a,b}.js', 'a.js', true], // B3-6 交替
      ['{a,b}.js', 'b.js', true],
      ['{a,b}.js', 'c.js', false],
      ['[a-c]x.js', 'bx.js', true], // B3-7 字符类
      ['[a-c]x.js', 'dx.js', false],
      ['[!a-z]x.js', '1x.js', true], // B3-8 取反类
      ['[!a-z]x.js', 'ax.js', false], // B3-9
      ['?bk.js', 'xbk.js', true] // `?` 只吃一个字符
    ]
    for (const [pattern, file, expected] of globCases) {
      assert.strictEqual(globMatcher(pattern).test(file), expected,
        `glob '${pattern}' 对 ${file} 应判 ${expected}（判错会让 configMissing/configExtra 误报）`)
    }

    // malformed：非法/不安全的 glob 既不抛异常、也不因参与匹配而抛（B3 第 10-12 行给的就是这组：
    // [[ / [z-a] / [a- / {a, / a**b / *.）
    for (const bad of ['[[', '[z-a]', '[a-', '{a,', 'a**b', '*.']) {
      assert.doesNotThrow(() => globMatcher(bad), `malformed glob '${bad}' 不抛异常`)
      assert.doesNotThrow(() => globMatcher(bad).test('xbk_utils.js'), `malformed glob '${bad}' 参与匹配也不抛异常`)
    }

    // 展开出的仓库文件（listRepoJsFiles）：忽略 test_*.js / node_modules / .git
    const files = listRepoJsFiles()
    assert.ok(files.length > 0, '应能枚举出生产 js 文件')
    assert.ok(files.some(f => /^xbk_.*\.js$/.test(path.basename(f))), '展开清单应含 xbk_* 生产源')
    assert.ok(files.every(f => !/^test_/.test(path.basename(f))), '展开清单不应含 test_*.js')
    assert.ok(files.every(f => !f.includes('node_modules')), '展开清单不应含 node_modules')

    // 缺陷B回归：glob 展开应与 globMatcher 口径一致——被 glob 覆盖的仓库文件都在展开结果里。
    // 两个口径差异在此钉死，避免把「口径不同」误判成缺陷、也避免把「选错文件」放过去：
    //   ① path.matchesGlob 的 `*`/`**` **不跨以 `.` 开头的路径段**（与 minimatch dot:false 同口径），
    //      故 `.github/xbk_*.js` 这类隐藏目录文件不在 glob 覆盖范围内——基线必须同样排除 dot 段，
    //      否则仓库里真出现隐藏目录下的 xbk_*.js 时，本断言会变成假红。
    //   ② 断言比较**集合**而不是数量：数量相同但选错文件（多选一个、少选一个）同样必须红。
    assert.strictEqual(globMatcher('**/xbk_*.js').test('.github/xbk_hidden.js'), false,
      '**/xbk_*.js 不得匹配隐藏目录（dot:false 口径；基线据此排除 dot 段）')
    const visibleFiles = files.filter(f => !f.split('/').some(seg => seg.startsWith('.')))
    // 显式比较器：默认 sort() 按 UTF-16 码元排，Sonar S2871 要求显式口径（此处与默认一致，只为可读）
    const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    const byGlob = visibleFiles.filter(f => globMatcher('**/xbk_*.js').test(f)).sort(byPath)
    const byBaseline = visibleFiles.filter(f => /(?:^|\/)xbk_.*\.js$/.test(f)).sort(byPath)
    assert.deepStrictEqual(byGlob, byBaseline,
      `glob 展开结果必须与正则基线逐条一致（集合比较，防「数量相同但选错文件」）；glob 侧 ${byGlob.length} 条、基线 ${byBaseline.length} 条`)
    console.log('✅ globMatcher / listRepoJsFiles 断言通过（* ? {a,b} [类] [!取反] ** 与 malformed）')
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

  // ===== C10-025：matrix 解析器一致性对账（auditMatrixParsers）=====
  // 本门禁把「本文件自己的 include 解析结果」与日报侧两个**独立实现**（mutation-report 的
  // parseMatrixRunnerConfigs / parseMatrixTimeouts）逐段对账：任一侧少看/多看一眼段，日报的 runner
  // 档位与「超时上限」列就会静默回落缺省值，而 CI 只看退出码、看不出来。此前本文件对该函数零用例
  // ——把 errors.push 全改成空操作（恒返回零错误）本套件照样全绿。故先锁「健康夹具零错误」
  // （否则下面四条坏输入可以靠「恒报错」蒙过），再逐条喂坏输入。
  {
    const { auditMatrixParsers } = require('./scripts/check-mutation-ranges.js')
    const { parseMatrixRunnerConfigs, parseMatrixTimeouts } = require('./scripts/mutation-report.js')
    const reporters = { parseMatrixRunnerConfigs, parseMatrixTimeouts }
    // 只造 include 块：对账输入是 (yml 文本, 本文件解析出的条目, 两个外部解析器)
    const includeYml = (rows) => 'jobs:\n  mutation:\n    strategy:\n      matrix:\n        include:\n' +
      rows.map(r => `          - name: ${r.name}\n` +
        (r.config === undefined ? '' : `            config: "${r.config}"\n`) +
        (r.timeout === undefined ? '' : `            timeout_ms: ${r.timeout}\n`) +
        `            src: "${r.name}.js"\n            mutate: "${r.name}.js:1-10"\n`).join('')
    const entriesOf = (rows) => rows.map(r => ({ name: r.name, config: r.config, timeout_ms: r.timeout }))
    const healthy = [
      { name: 'seg-a', config: 'stryker.config.js', timeout: 60000 },
      { name: 'seg-b', config: 'stryker.tap.config.js', timeout: 300000 },
      { name: 'seg-c', config: 'stryker.config.js' }
    ]
    // 正向对照：三段两侧完全一致 ⇒ 零错误（下面的坏输入断言才有意义）
    {
      const ok = auditMatrixParsers(includeYml(healthy), entriesOf(healthy), reporters)
      assert.deepStrictEqual(ok.errors, [], `健康夹具不得报错：${JSON.stringify(ok.errors)}`)
      assert.deepStrictEqual(ok.stats, { entries: 3, configs: 3, timeouts: 3 },
        `对账统计必须覆盖三段（缺一段等于没对上）：${JSON.stringify(ok.stats)}`)
    }
    // ① 半套 config：yml 只给一段写了 config，另一段本文件看得见、parseMatrixRunnerConfigs 看不见
    {
      const rows = [{ name: 'seg-a', config: 'stryker.config.js' }, { name: 'seg-b' }]
      const entries = [{ name: 'seg-a', config: 'stryker.config.js' }, { name: 'seg-b', config: 'stryker.config.js' }]
      const r = auditMatrixParsers(includeYml(rows), entries, reporters)
      assert.ok(r.errors.some(e => e.includes('parseMatrixRunnerConfigs 没看到')),
        `半套 config 必须报「② 没看到该段」（否则该段的 runner 档位在日报里静默缺失）：${JSON.stringify(r.errors)}`)
      assert.strictEqual(r.stats.configs, 1, `② 只应看到 1 段 config，实际 ${r.stats.configs}`)
    }
    // ② 取值分叉：两侧都看到该段，但 config 取值不同（② 读到的不是本文件写的那一档）
    {
      const rows = [{ name: 'seg-a', config: 'stryker.tap.config.js' }]
      const entries = [{ name: 'seg-a', config: 'stryker.config.js' }]
      const r = auditMatrixParsers(includeYml(rows), entries, reporters)
      assert.ok(r.errors.some(e => e.includes('取值分叉') && e.includes('seg-a')),
        `两侧 config 取值不一致必须报取值分叉：${JSON.stringify(r.errors)}`)
    }
    // ③ 多出段：yml（进而 ②/③ 两个解析器）多出一段，本文件的条目里没有它
    {
      const rows = [{ name: 'seg-a', config: 'stryker.config.js' }, { name: 'seg-extra', config: 'stryker.config.js' }]
      const entries = [{ name: 'seg-a', config: 'stryker.config.js' }]
      const r = auditMatrixParsers(includeYml(rows), entries, reporters)
      assert.ok(r.errors.some(e => e.includes('多出段') && e.includes('seg-extra')),
        `解析器多出的段必须点名（日报会为不存在的段标注档位）：${JSON.stringify(r.errors)}`)
      assert.strictEqual(r.stats.configs, 2, `② 读到 2 段 config，实际 ${r.stats.configs}`)
    }
    // ④ timeout 取值对账：段名对得上只说明「两条解析器都看见了这个段」，不说明「读到的秒数一样」。
    //    此前本块只锁了 config 侧取值分叉，timeout 侧取值比较（if (parsed !== undefined && parsed !==
    //    expected)）改成恒假、甚至整段删掉，本套件照样全绿：日报的「超时上限」列会按错的值渲染，
    //    而 CI 只看退出码。故这里既喂真实解析器能一眼看出分叉的写法（timeout_ms: 60_000：本文件读到
    //    字符串 "60_000"（Number ⇒ NaN），parseMatrixTimeouts 判非正整数后回落 300000），也用 stub
    //    直接喂不等值的 Map（不依赖任一侧对怪写法的容忍度）。
    {
      const diagRows = [{ name: 'seg-a', config: 'stryker.config.js', timeout: '60_000' }]
      const diag = auditMatrixParsers(includeYml(diagRows), entriesOf(diagRows), reporters)
      const diagMsg = diag.errors.find(e => e.includes('取值分叉') && e.includes('seg-a'))
      assert.ok(diagMsg,
        `timeout_ms 两侧取值不一致必须报取值分叉并点名该段：${JSON.stringify(diag.errors)}`)
      assert.ok(diagMsg.includes('timeout_ms'), `取值分叉必须点名字段 timeout_ms：${diagMsg}`)
      assert.ok(diagMsg.includes('60_000') && diagMsg.includes('300000'),
        `取值分叉必须同时报出两侧读到的值（本文件 60_000 / parseMatrixTimeouts 300000）：${diagMsg}`)
      assert.strictEqual(diag.errors.length, 1,
        `该夹具只应报这一条（其余错误会掩盖取值分叉）：${JSON.stringify(diag.errors)}`)
      // 同一判据的 stub 版：段名两侧都在、取值不等（300000 vs 60000），且不经过任何奇异写法
      const stubRows = [{ name: 'seg-a', config: 'stryker.config.js', timeout: 60000 }]
      const stubTimeouts = () => new Map([['seg-a', 300000]])
      const stub = auditMatrixParsers(includeYml(stubRows), entriesOf(stubRows),
        { parseMatrixRunnerConfigs, parseMatrixTimeouts: stubTimeouts })
      assert.ok(stub.errors.some(e => e.includes('取值分叉') && e.includes('seg-a') &&
        e.includes('60000') && e.includes('300000')),
        `两侧 timeout_ms 数值不等必须报取值分叉（不依赖 yml 写法）：${JSON.stringify(stub.errors)}`)
      assert.strictEqual(stub.stats.timeouts, 1, `stub 只看到 1 段 timeout，实际 ${stub.stats.timeouts}`)
    }
    // ⑤ timeout 段名对账：stub 返回少一段的 Map（真实解析器对某些写法会静默丢段，这里直接构造该形态）。
    //    此前若把「没看到该段」的判定改成恒假，本套件全绿：日报会为被丢掉的段回落缺省 300s，读者
    //    却以为那就是矩阵声明的上限。必须点名 parseMatrixTimeouts 与被丢掉的段名。
    {
      const rows = [
        { name: 'seg-a', config: 'stryker.config.js', timeout: 60000 },
        { name: 'seg-b', config: 'stryker.config.js', timeout: 60000 }
      ]
      const shortTimeouts = () => new Map([['seg-a', 60000]])
      const r = auditMatrixParsers(includeYml(rows), entriesOf(rows),
        { parseMatrixRunnerConfigs, parseMatrixTimeouts: shortTimeouts })
      assert.ok(r.errors.some(e => e.includes('parseMatrixTimeouts 没看到') && e.includes('seg-b')),
        `parseMatrixTimeouts 少看一段必须点名解析器与该段：${JSON.stringify(r.errors)}`)
      assert.ok(r.errors.some(e => e.includes('parseMatrixTimeouts 没看到') && e.includes('超时上限')),
        `少看段的错误必须说明后果（超时上限列回落缺省）：${JSON.stringify(r.errors)}`)
      assert.strictEqual(r.errors.length, 1,
        `该夹具只应报「没看到该段」这一条：${JSON.stringify(r.errors)}`)
      assert.strictEqual(r.stats.timeouts, 1, `stub 只看到 1 段 timeout，实际 ${r.stats.timeouts}`)
    }
    // ⑥ 缺注入：没有对照解析器时必须 fail-closed——「没对照就没有判据」不等于「一致」
    {
      const rows = [{ name: 'seg-a', config: 'stryker.config.js' }]
      const none = auditMatrixParsers(includeYml(rows), entriesOf(rows))
      assert.strictEqual(none.errors.length, 1, `未注入解析器必须报 1 条错误，实际 ${JSON.stringify(none.errors)}`)
      assert.ok(none.errors[0].includes('缺少注入的'), `必须点名缺注入：${none.errors[0]}`)
      assert.deepStrictEqual(none.stats, { entries: 0, configs: 0, timeouts: 0 }, '缺注入时不得假装对过账')
      const half = auditMatrixParsers(includeYml(rows), entriesOf(rows), { parseMatrixRunnerConfigs })
      assert.ok(half.errors[0] && half.errors[0].includes('缺少注入的'),
        `只注入一个解析器同样必须 fail-closed：${JSON.stringify(half.errors)}`)
    }
    console.log('✅ C10-025 matrix 解析器一致性对账断言通过（健康零错误 / 半套 config / config 取值分叉 / 多出段 / timeout 取值分叉 / timeout 少看段 / 缺注入 均报错）')
  }

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
    // CMR-09 字符类里连字符的边界（语义以实测为准，不凭猜写断言）：
    //   · 类首/类尾的 `-` 是字面量成员：`[-a]`、`[a-]` 都匹配 `-` 与 `a`；字符类只吃**一个**字符，
    //     所以 `[-a]x.js` 这类写法永远匹配不到具名文件。
    //   · `[a--b]` 这类连续 `-` 的歧义类：薄壳前的实现把整个方括号降级为字面文本，`path.matchesGlob`
    //     按 minimatch 解析（具体解析细节属 upstream，未在本仓锁定）。这里只锁「不抛异常」——本仓
    //     stryker.config.js 没有任何 glob 条目，歧义类在调用面不可达；锁 upstream 细节只会在 Node
    //     升级时误报。
    //   · 断言一律走行为（`.test()`），不再断言生成的正则源码：薄壳没有正则可断言。
    {
      const { globMatcher } = require('./scripts/check-mutation-ranges.js')
      const lead = globMatcher('[-a].js')
      const tail = globMatcher('[a-].js')
      assert.ok(lead.test('-.js') && lead.test('a.js'), '[-a] 必须同时匹配 -.js 与 a.js')
      assert.ok(tail.test('-.js') && tail.test('a.js'), '[a-] 必须同时匹配 -.js 与 a.js')
      assert.ok(!lead.test('x.js') && !tail.test('x.js'), '类内未列出的字符不得被匹配')
      assert.ok(!lead.test('-x.js'), '字符类只吃一个字符：[-a]x.js 不得被匹配（写成长名即失配）')

      assert.doesNotThrow(() => globMatcher('[a--b].js').test('[a--b].js'),
        '歧义字符类（连续 -）不得抛异常')

      assert.ok(globMatcher('[a-c].js').test('b.js') && !globMatcher('[a-c].js').test('d.js'),
        '对照：合法的 a-c 范围必须仍然生效（不得因为歧义类的处理把范围分支写成默认行为）')
    }
  }

  // ===== 真实矩阵的 console 拆段必须合规（Sourcery #304：夹具自造 yml ⇒ 只测夹具等于没测真实配置）=====
  // 反例：真实 part6 写成 3251-4098、part7 只有 4099-4099 时，夹具路径全绿——真实工作流没人看。
  {
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'mutation.yml'), 'utf8')
    const ranges = [...wf.matchAll(/name:\s*(console-part\d+)[\s\S]{0,300}?mutate:\s*"scripts\/console\.js:(\d+)-(\d+)"/g)]
      .map(m => ({ name: m[1], start: Number(m[2]), end: Number(m[3]) }))
    assert.strictEqual(ranges.length, 12, `真实矩阵必须拆 12 段 console，实际 ${ranges.length}`)
    const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'console.js'), 'utf8').split('\n').length - 1
    assert.strictEqual(ranges[0].start, 1, '真实矩阵首段必须从第 1 行开始')
    assert.strictEqual(ranges[ranges.length - 1].end, lines, '真实矩阵末段必须止于文件最后一行')
    for (let i = 1; i < ranges.length; i++) {
      assert.strictEqual(ranges[i].start, ranges[i - 1].end + 1,
        `真实矩阵 ${ranges[i].name} 必须紧接上一段（不得留缝/重叠），实际 ${ranges[i].start} vs ${ranges[i - 1].end + 1}`)
    }
    // 单片预算：849 行（旧 part6）实测撞穿 step 330min 被杀；末两段各 ~425 行是为此对半拆的。
    const MAX_PART_LINES = 700
    for (const r of ranges) {
      assert.ok(r.end - r.start + 1 <= MAX_PART_LINES,
        `真实矩阵 ${r.name} 覆盖 ${r.end - r.start + 1} 行，超过单片预算 ${MAX_PART_LINES} 行（会撞 step 上限）`)
    }
    const part6 = ranges.find(r => r.name === 'console-part6')
    const part7 = ranges.find(r => r.name === 'console-part7')
    const part8 = ranges.find(r => r.name === 'console-part8')
    const part9 = ranges.find(r => r.name === 'console-part9')
    const part10 = ranges.find(r => r.name === 'console-part10')
    const part11 = ranges.find(r => r.name === 'console-part11')
    const part12 = ranges.find(r => r.name === 'console-part12')
    assert.ok(part6 && part6.start === 3251 && part6.end === 3675,
      `真实 console-part6 必须是 3251-3675，实际 ${part6 && part6.start}-${part6 && part6.end}`)
    assert.ok(part7 && part7.start === 3676 && part7.end === 4370,
      `真实 console-part7 必须是 3676-4370，实际 ${part7 && part7.start}-${part7 && part7.end}`)
    assert.ok(part8 && part8.start === 4371 && part8.end === 4800,
      `真实 console-part8 必须是 4371-4800，实际 ${part8 && part8.start}-${part8 && part8.end}`)
    assert.ok(part9 && part9.start === 4801 && part9.end === 5200,
      `真实 console-part9 必须是 4801-5200，实际 ${part9 && part9.start}-${part9 && part9.end}`)
    assert.ok(part10 && part10.start === 5201 && part10.end === 5800,
      `真实 console-part10 必须是 5201-5800，实际 ${part10 && part10.start}-${part10 && part10.end}`)
    assert.ok(part11 && part11.start === 5801 && part11.end === 6500,
      `真实 console-part11 必须是 5801-6500，实际 ${part11 && part11.start}-${part11 && part11.end}`)
    assert.ok(part12 && part12.start === 6501 && part12.end === lines,
      `真实 console-part12 必须是 6501-${lines}，实际 ${part12 && part12.start}-${part12 && part12.end}`)
  }

  // ===== C10-009 运行链候选集 ↔ mutate 清单双向核对（靶向反例）=====
  // 背景：productionFiles 是手写清单、与 mutate 只做单向比对，运行链上被顶层 require 的模块（本次实测
  // 3 个：filter-rules-paths / owner-only-mode / message-signature）既不在清单也不在 mutate 目标 ⇒
  // 永久绿灯、零变异覆盖。下面直接驱动导出的判定函数（合成输入，不改仓库文件），并在最后用真实注入
  // yml 证明新判据确实接进了门禁（不是「只导出了一个没人调用的函数」）。
  {
    const {
      auditRuntimeChain, deriveRuntimeChain, MUTATION_EXEMPT, NON_RUNTIME_MUTATE_TARGETS
    } = require('./scripts/check-mutation-ranges.js')
    const relPath = 'scripts/filter-rules-paths.js'

    // ① 正向：运行链模块既不是 mutate 目标、也没有豁免 ⇒ 必须报错并点名
    const missing = auditRuntimeChain({
      chain: ['xbk_utils.js', relPath], mutateTargets: new Set(['xbk_utils.js']), exempt: new Map(), nonRuntime: new Map()
    })
    assert.strictEqual(missing.errors.length, 1, `运行链模块无覆盖时必须恰好报 1 条错，实际 ${JSON.stringify(missing.errors)}`)
    assert.ok(missing.errors[0].includes(relPath) && missing.errors[0].includes('既不是 mutation.yml 的 mutate 目标'),
      `必须点名该模块并说明两条出路：${missing.errors[0]}`)

    // ② 带理由的显式豁免 ⇒ 通过（豁免是「登记缺口」，不是「静默忽略」）
    const exempted = auditRuntimeChain({
      chain: ['xbk_utils.js', relPath],
      mutateTargets: new Set(['xbk_utils.js']),
      exempt: new Map([[relPath, '纯路径构造助手，行为由 filter-store 套件经调用方覆盖']]),
      nonRuntime: new Map()
    })
    assert.deepStrictEqual(exempted.errors, [], `带理由的豁免应通过，实际 ${JSON.stringify(exempted.errors)}`)

    // ③ 空理由的豁免 ⇒ 红（否则「豁免」退化成「删掉判据」）
    const blank = auditRuntimeChain({
      chain: [relPath], mutateTargets: new Set(), exempt: new Map([[relPath, '   ']]), nonRuntime: new Map()
    })
    assert.strictEqual(blank.errors.length, 1, '豁免理由为空必须判红')
    assert.ok(blank.errors[0].includes('豁免理由为空'), `必须点名「理由为空」：${blank.errors[0]}`)

    // ④ 反向：mutate 目标不在运行链上、也没有「非运行时」标注 ⇒ 必须报错
    const reverse = auditRuntimeChain({
      chain: ['xbk_utils.js'],
      mutateTargets: new Set(['xbk_utils.js', 'scripts/console.js']),
      exempt: new Map(),
      nonRuntime: new Map()
    })
    assert.strictEqual(reverse.errors.length, 1, `反向漏标注必须恰好报 1 条错，实际 ${JSON.stringify(reverse.errors)}`)
    assert.ok(reverse.errors[0].includes('scripts/console.js') && reverse.errors[0].includes('既不在运行链上'),
      `必须点名该 mutate 目标并说明缺标注：${reverse.errors[0]}`)

    // ⑤ 补上「非运行时」标注 ⇒ 通过；理由为空 ⇒ 红
    const annotated = auditRuntimeChain({
      chain: ['xbk_utils.js'],
      mutateTargets: new Set(['xbk_utils.js', 'scripts/console.js']),
      exempt: new Map(),
      nonRuntime: new Map([['scripts/console.js', '独立 CLI，不经运行入口 require']])
    })
    assert.deepStrictEqual(annotated.errors, [], `带理由的非运行时标注应通过，实际 ${JSON.stringify(annotated.errors)}`)
    const blankNonRuntime = auditRuntimeChain({
      chain: ['xbk_utils.js'],
      mutateTargets: new Set(['xbk_utils.js', 'scripts/console.js']),
      exempt: new Map(),
      nonRuntime: new Map([['scripts/console.js', '']])
    })
    assert.strictEqual(blankNonRuntime.errors.length, 1, '「非运行时」标注理由为空必须判红')
    assert.ok(blankNonRuntime.errors[0].includes('标注理由为空'), `必须点名理由为空：${blankNonRuntime.errors[0]}`)

    // ⑥ 过期条目：两张表都必须随代码演进自动失效（否则表本身成为新盲区）
    const staleExempt = auditRuntimeChain({
      chain: ['xbk_utils.js'],
      mutateTargets: new Set(['xbk_utils.js']),
      exempt: new Map([['scripts/gone-away.js', '早已删除的模块']]),
      nonRuntime: new Map()
    })
    assert.strictEqual(staleExempt.errors.length, 1, '豁免表里的过期条目必须判红')
    assert.ok(staleExempt.errors[0].includes('豁免已过期'), `必须点名豁免过期：${staleExempt.errors[0]}`)
    const staleNonRuntime = auditRuntimeChain({
      chain: ['xbk_utils.js'],
      mutateTargets: new Set(['xbk_utils.js']),
      exempt: new Map(),
      nonRuntime: new Map([['scripts/console.js', '已在矩阵里删掉的目标']])
    })
    assert.strictEqual(staleNonRuntime.errors.length, 1, '「非运行时」表里的过期条目必须判红')
    assert.ok(staleNonRuntime.errors[0].includes('标注已过期'), `必须点名标注过期：${staleNonRuntime.errors[0]}`)

    // ⑦ 同一模块同时出现在两张表 ⇒ 口径互斥，必须红
    const both = auditRuntimeChain({
      chain: [relPath],
      mutateTargets: new Set(),
      exempt: new Map([[relPath, '理由 A']]),
      nonRuntime: new Map([[relPath, '理由 B']])
    })
    assert.ok(both.errors.some(e => e.includes('两个口径互斥')), `同模块出现在两张表必须判红：${JSON.stringify(both.errors)}`)

    // ⑧ 真实仓库：派生集必须真的包含这三个模块（本次修复的对象本身，缺一条说明派生逻辑退化了）
    const real = deriveRuntimeChain()
    for (const file of ['scripts/filter-rules-paths.js', 'scripts/owner-only-mode.js', 'scripts/message-signature.js']) {
      assert.ok(real.chain.includes(file), `运行链派生必须包含 ${file}（它被运行入口无条件 require）`)
      assert.ok(MUTATION_EXEMPT.has(file), `${file} 必须在 MUTATION_EXEMPT 里有显式豁免（否则真实门禁必红）`)
    }
    assert.ok(real.chain.includes('xbk_utils.js') && real.chain.includes('qinglong/xbk_push.js'),
      '运行链派生必须包含运行入口与它 require 的生产模块（派生逻辑退化成空集时上面的断言才有意义）')
    assert.ok(NON_RUNTIME_MUTATE_TARGETS.has('scripts/console.js') && NON_RUNTIME_MUTATE_TARGETS.has('scripts/check-deps.js'),
      '「非运行时」标注必须覆盖矩阵里那两个不在 require 闭包内的脚本（否则真实门禁必红）')
    console.log(`✅ 运行链双向核对断言通过（派生 ${real.chain.length} 个模块；豁免 ${MUTATION_EXEMPT.size} 条、非运行时标注 ${NON_RUNTIME_MUTATE_TARGETS.size} 条）`)
  }

  // ===== 运行链解析：目录形式 `require('./dir')` 必须解析到 dir/index.js（CodeRabbit #362-g2）=====
  // 旧实现把候选拼成 `base + path.join('index.js')`（等价 `base + 'index.js'`），对 `require('./lib')`
  // 得到的是 <root>/libindex.js ⇒ 目录 require 永远解析不到，该分支是死代码：运行链少一个模块，
  // 门禁照绿、模块零变异覆盖。这里用**仓库外临时夹具**（跑完即删，不进 git）把四条解析规则一起钉死：
  // 目录 index.js、裸名按仓库根、无扩展名补 .js、以及 .js > .cjs > .mjs 的优先级。
  {
    const { deriveRuntimeChain } = require('./scripts/check-mutation-ranges.js')
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtime-chain-'))
    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(fixtureRoot, rel)), { recursive: true })
      fs.writeFileSync(path.join(fixtureRoot, rel), body)
    }
    try {
      write('entry.js', [
        "require('./lib')", // 目录 ⇒ lib/index.js（旧实现漏掉的正样本）
        "require('./plain')", // 无扩展名 ⇒ plain.js
        "require('./cjs-mod')", // 无扩展名 ⇒ cjs-mod.cjs
        "require('./mjs-mod')", // 无扩展名 ⇒ mjs-mod.mjs
        "require('./dup')", // 同名多后缀 ⇒ .js 优先
        "require('shared')" // 裸名 ⇒ 按仓库根解析
      ].join('\n'))
      write('lib/index.js', 'module.exports = {}\n')
      write('plain.js', 'module.exports = {}\n')
      write('cjs-mod.cjs', 'module.exports = {}\n')
      write('mjs-mod.mjs', 'module.exports = {}\n')
      write('dup.js', 'module.exports = {}\n')
      write('dup.cjs', 'module.exports = {}\n')
      write('shared.js', 'module.exports = {}\n')

      const { chain } = deriveRuntimeChain(['entry.js'], fixtureRoot)
      const expect = ['entry.js', 'lib/index.js', 'plain.js', 'cjs-mod.cjs', 'mjs-mod.mjs', 'dup.js', 'shared.js']
      for (const file of expect) {
        assert.ok(chain.includes(file),
          `运行链必须包含 ${file}，实际 ${JSON.stringify(chain)}`)
      }
      assert.deepStrictEqual([...chain].sort((a, b) => a.localeCompare(b)), [...expect].sort((a, b) => a.localeCompare(b)),
        `运行链不得多解析出仓库里不存在的候选，实际 ${JSON.stringify(chain)}`)
      assert.ok(!chain.some(f => f.includes('index.jsindex.js') || /libindex\.js$/.test(f)),
        `不得把目录 require 拼成 <dir>index.js 这种畸形候选，实际 ${JSON.stringify(chain)}`)

      // 反向：解析不到的相对路径不得凭猜测进链（否则上面「包含 index.js」会退化成万能通过）
      const miss = deriveRuntimeChain(['missing-entry.js'], fixtureRoot)
      assert.deepStrictEqual(miss.chain, [],
        `不存在的入口不得进链，实际 ${JSON.stringify(miss.chain)}`)
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    }
    console.log('✅ 运行链解析断言通过（目录 index.js / 裸名 / .js·.cjs·.mjs 优先级）')
  }

  console.log('test_check_mutation_ranges OK')
})().catch((e) => { console.error(e); process.exit(1) })
