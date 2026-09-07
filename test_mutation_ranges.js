'use strict'

/* codacy-disable-file: 测试 sandbox 使用固定仓库文件和 fs.mkdtempSync 创建的临时目录，路径非用户输入。 */

const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = __dirname
const workflow = path.resolve(root, '.github/workflows/mutation.yml')
const checker = path.resolve(root, 'scripts/check-mutation-ranges.js')

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
    .replace(/\r?\n\s*- name: utils\r?\n\s*mutate: "xbk_utils\.js"/, '')
  fs.writeFileSync(incomplete, yml)

  const missingTarget = runChecker(incomplete)
  assert.notStrictEqual(missingTarget.status, 0, '遗漏生产模块的矩阵必须失败')
  assert.match(missingTarget.stderr, /xbk_utils\.js/, '错误应点名遗漏模块')

  const outOfBounds = path.join(tmpdir, 'out-of-bounds.yml')
  fs.writeFileSync(outOfBounds, yml.replace('xbk_function_v3.js:1-426', 'xbk_function_v3.js:1-427'))
  const invalidRange = runChecker(outOfBounds)
  assert.notStrictEqual(invalidRange.status, 0, '超过文件长度的行段必须失败')
  assert.match(invalidRange.stderr, /超过文件实际行数 426/, '错误应说明实际文件行数')
  console.log('✅ 遗漏生产模块或行段越界会使 mutation 范围校验失败')
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true })
}

console.log('✅ 当前 mutation 矩阵覆盖全部生产模块')
