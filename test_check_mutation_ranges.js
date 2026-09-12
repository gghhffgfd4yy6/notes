'use strict'

// check-mutation-ranges.js 无导出（顶层执行 + process.exit），通过子进程注入 MUTATION_WORKFLOW_TEXT 测试
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
  'scripts/check-deps.js': ['check-deps']
}
const SPLIT_BOUNDARY_RANGES = { 'xbk_sendNotify_slim.js': 750 } // 拆段边界固定，终点随文件增长自动跟随

// 构造包含所有生产文件的 yml，行段可按文件覆盖
function buildYml (overrides = {}) {
  const productionFiles = [
    ...fs.readdirSync(ROOT).filter(f => /^xbk_.*\.js$/.test(f)),
    'qinglong/xbk_push.js',
    'scripts/check-deps.js'
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
  // 该脚本已用 require.main === module 包住主流程，不会提前 process.exit。直接驱动纯函数断言：
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

  console.log('test_check_mutation_ranges OK')
})().catch((e) => { console.error(e); process.exit(1) })
