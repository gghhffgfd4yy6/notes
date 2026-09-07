'use strict'

const assert = require('node:assert')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = __dirname
const workflow = path.join(root, '.github/workflows/mutation.yml')
const checker = path.join(root, 'scripts/check-mutation-ranges.js')

function runChecker (workflowPath) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MUTATION_WORKFLOW_PATH: workflowPath }
  })
}

const current = runChecker(workflow)
assert.strictEqual(current.status, 0, current.stderr || current.stdout)

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-ranges-test-'))
try {
  const incomplete = path.join(tmpdir, 'mutation.yml')
  const yml = fs.readFileSync(workflow, 'utf8')
    .replace(/\n\s*- name: utils\n\s*mutate: "xbk_utils\.js"/, '')
  fs.writeFileSync(incomplete, yml)

  const result = runChecker(incomplete)
  assert.notStrictEqual(result.status, 0, '遗漏生产模块的矩阵必须失败')
  assert.match(result.stderr, /xbk_utils\.js/, '错误应点名遗漏模块')
  console.log('✅ 遗漏生产模块会使 mutation 范围校验失败')
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true })
}

execFileSync(process.execPath, [checker], { cwd: root, stdio: 'inherit' })
console.log('✅ 当前 mutation 矩阵覆盖全部生产模块')
