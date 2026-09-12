'use strict'

const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const workflow = '.github/workflows/mutation.yml'
const checker = 'scripts/check-mutation-ranges.js'
const yml = fs.readFileSync(workflow, 'utf8')

function runChecker (workflowText) {
  return spawnSync(process.execPath, [checker], {
    encoding: 'utf8',
    env: { ...process.env, MUTATION_WORKFLOW_TEXT: workflowText }
  })
}

const current = runChecker(yml)
assert.strictEqual(current.status, 0, current.stderr || current.stdout)

const missingTarget = runChecker(yml.replace(/\r?\n\s*- name: utils\r?\n(?:\s*src: "[^"]+"\r?\n)?\s*mutate: "xbk_utils\.js"/, ''))
assert.notStrictEqual(missingTarget.status, 0, '遗漏生产模块的矩阵必须失败')
assert.match(missingTarget.stderr, /xbk_utils\.js/, '错误应点名遗漏模块')

const invalidRange = runChecker(yml.replace('xbk_function_v3.js:1-426', 'xbk_function_v3.js:1-427'))
assert.notStrictEqual(invalidRange.status, 0, '超过文件长度的行段必须失败')
assert.match(invalidRange.stderr, /超过文件实际行数 426/, '错误应说明实际文件行数')

console.log('✅ 遗漏生产模块或行段越界会使 mutation 范围校验失败')
console.log('✅ 当前 mutation 矩阵覆盖全部生产模块')
