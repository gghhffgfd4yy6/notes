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

// 按行删除指定内容：不用多行正则（`\s*…\s*` 相邻量词会被静态分析判为可回溯超线性，Sonar S8786）
function dropLines (text, targets) {
  return text.split('\n').filter(line => !targets.includes(line.trim())).join('\n')
}

const current = runChecker(yml)
assert.strictEqual(current.status, 0, current.stderr || current.stdout)

const missingTarget = runChecker(dropLines(yml, ['- name: utils', 'src: "xbk_utils.js"', 'mutate: "xbk_utils.js"']))
assert.notStrictEqual(missingTarget.status, 0, '遗漏生产模块的矩阵必须失败')
assert.match(missingTarget.stderr, /xbk_utils\.js/, '错误应点名遗漏模块')

const invalidRange = runChecker(yml.replace('xbk_function_v3.js:1-426', 'xbk_function_v3.js:1-427'))
assert.notStrictEqual(invalidRange.status, 0, '超过文件长度的行段必须失败')
assert.match(invalidRange.stderr, /超过文件实际行数 426/, '错误应说明实际文件行数')

// matrix 的 src 字段（actions/cache 指纹用）必须与 mutate 目标同文件：写错或缺行都不会让 CI 报错，
// 只会悄悄让该段的缓存指纹失真
const badSrc = runChecker(yml.replace('src: "xbk_utils.js"', 'src: "xbk_util.js"'))
assert.notStrictEqual(badSrc.status, 0, 'src 与 mutate 目标不一致必须失败')
assert.match(badSrc.stderr, /src\(xbk_util\.js\)/, '错误应点名不一致的 src')

const missingSrc = runChecker(dropLines(yml, ['src: "xbk_utils.js"']))
assert.notStrictEqual(missingSrc.status, 0, 'matrix 缺 src 字段必须失败')
assert.match(missingSrc.stderr, /缺 src 字段/, '错误应说明缺 src')

// 引号内的 # 是值的一部分，不是行内注释：若解析在 # 处截断，src 会被误读成 "xbk_utils.js" 从而“看起来一致”
const hashInQuote = runChecker(yml.replace('src: "xbk_utils.js"', 'src: "xbk_utils.js#frag"'))
assert.notStrictEqual(hashInQuote.status, 0, '带 # 的引号值必须与 mutate 目标判为不一致，不得在 # 处截断')
assert.match(hashInQuote.stderr, /src\(xbk_utils\.js#frag\)/, '报错应回显完整值（证明未截断）')

console.log('✅ 遗漏生产模块或行段越界会使 mutation 范围校验失败')
console.log('✅ 当前 mutation 矩阵覆盖全部生产模块')
