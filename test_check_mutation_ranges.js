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
const SPLIT_DEFAULT_RANGES = { 'xbk_sendNotify_slim.js': ['1-750', '751-1473'] }

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
    const fallback = SPLIT_DEFAULT_RANGES[f] || [`1-${lines}`]
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

  console.log('test_check_mutation_ranges OK')
})().catch((e) => { console.error(e); process.exit(1) })
