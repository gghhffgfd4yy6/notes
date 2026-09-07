'use strict'

// check-mutation-ranges.js 无导出（顶层执行 + process.exit），通过子进程注入 MUTATION_WORKFLOW_TEXT 测试
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname)
const SCRIPT = path.join(ROOT, 'scripts', 'check-mutation-ranges.js')

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
    const ranges = Array.isArray(overrides[f]) ? overrides[f] : [overrides[f] || `1-${lines}`]
    const safeName = f.replace(/[/.]/g, '-')
    return ranges.map((range, i) => `          - name: ${safeName}-${i}\n            mutate: "${f}:${range}"`).join('\n')
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
  const leak = run(buildYml({ 'xbk_utils.js': '1-10' }))
  assert.strictEqual(leak.status, 1, '尾部漏测应 exit 1')
  assert.ok(leak.stderr.includes('未被变异测试覆盖') || leak.stdout.includes('未被变异测试覆盖'), '应报尾部未覆盖')

  // ===== 行段不连续（缝隙）→ exit 1 =====
  const gap = run(buildYml({ 'xbk_utils.js': ['1-10', '20-30'] }))
  assert.strictEqual(gap.status, 1, '行段不连续应 exit 1')
  assert.ok(gap.stderr.includes('不连续') || gap.stdout.includes('不连续'), '应报行段不连续')

  // ===== 首段不从第 1 行开始 → exit 1 =====
  const head = run(buildYml({ 'xbk_utils.js': '5-100' }))
  assert.strictEqual(head.status, 1, '首段不从第 1 行开始应 exit 1')

  // ===== 行段超过实际行数 → exit 1 =====
  const over = run(buildYml({ 'xbk_utils.js': '1-999999' }))
  assert.strictEqual(over.status, 1, '行段超过实际行数应 exit 1')

  // ===== 引用不存在的文件 → exit 1 =====
  const notExist = buildYml() + '          - name: ghost\n            mutate: "nonexistent.js:1-10"\n'
  const ne = run(notExist)
  assert.strictEqual(ne.status, 1, '引用不存在的文件应 exit 1')

  // ===== yml 中无行段 → exit 1 =====
  const noRange = run('name: mutation\non: push\njobs:\n  mutation:\n    runs-on: ubuntu-latest\n')
  assert.strictEqual(noRange.status, 1, '无行段应 exit 1')
  assert.ok(noRange.stderr.includes('未在 mutation.yml 中解析到任何 mutate 行段') || noRange.stdout.includes('未在 mutation.yml 中解析到任何 mutate 行段'), '应报未解析到行段')

  console.log('test_check_mutation_ranges OK')
})().catch((e) => { console.error(e); process.exit(1) })
