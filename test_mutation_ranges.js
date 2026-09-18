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

// 越界行段必须被拒：从矩阵里直接取出 v3 的段尾再 +1，不硬编码行数——
// 硬编码会在文件增长后让本用例自身失效（v3.270/v3.275 两次都是文件增长先发生的）。
const v3Range = /xbk_function_v3\.js:1-(\d+)/.exec(yml)
assert.ok(v3Range, '矩阵里应存在 xbk_function_v3.js 的行段')
const outOfBoundsTo = String(Number(v3Range[1]) + 1)
const invalidRange = runChecker(yml.replace(`xbk_function_v3.js:1-${v3Range[1]}`, `xbk_function_v3.js:1-${outOfBoundsTo}`))
assert.notStrictEqual(invalidRange.status, 0, '超过文件长度的行段必须失败')
// 错误文案里的「实际行数」同样从当前文件读取，不硬编码（文件增长时本用例不该失效）
const v3Raw = fs.readFileSync('xbk_function_v3.js', 'utf8')
// 与 scripts/check-mutation-ranges.js 的 actualLines 同口径（末行换行不计一行）
const v3Lines = v3Raw.endsWith('\n') ? v3Raw.split('\n').length - 1 : v3Raw.split('\n').length
// 用字符串包含断言替代 new RegExp(`…`)：插值只有十进制行数、不含正则元字符，语义等价；
// 动态构造 RegExp 会被静态分析判为「非字面量 RegExp」（Codacy/ESLint security 族）。
assert.ok(invalidRange.stderr.includes(`超过文件实际行数 ${v3Lines}`), '错误应说明实际文件行数')

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

// 段名漂移：report 阶段才 throw 会白跑一整轮矩阵，必须在范围校验阶段就拦住
const renamed = runChecker(yml.replace('- name: utils', '- name: utils-renamed'))
assert.notStrictEqual(renamed.status, 0, '矩阵段名与 mutation-report 的 EXPECTED_SEGMENTS 不一致必须失败')
assert.match(renamed.stderr, /期望的分段未出现在矩阵/, '应指出 mutation-report 期望的段缺失')
assert.match(renamed.stderr, /不认识的段名/, '应指出矩阵多出 report 不认识的段名')

// stryker.config.js 的 mutate 与矩阵文件集漂移（矩阵少一个目标 → config 多一个）
const configDrift = runChecker(dropLines(yml, ['- name: check-deps', 'src: "scripts/check-deps.js"', 'mutate: "scripts/check-deps.js"']))
assert.notStrictEqual(configDrift.status, 0, 'stryker.config.js 与矩阵文件集不一致必须失败')
assert.match(configDrift.stderr, /stryker\.config\.js 的 mutate 含矩阵未覆盖的文件/, '应指出 config 多跑的文件')

// run_mutation.js 的 DEFAULT_FILES ↔ stryker.config.js 的 mutate 必须完全一致（run_mutation F7）：
// 本地调度器此前只覆盖 8/17 个 CI 目标且无任何对账——新增 mutate 目标后本地默认跑法静默漏掉它，
// 形成「本地跑过 = CI 也覆盖」的错觉。矩阵 ↔ stryker.config.js 的一致性已由 check-mutation-ranges
// 把守；这里补上 stryker.config.js ↔ DEFAULT_FILES 这条边，使三者形成闭环。
const { mutate } = require('./stryker.config.js')
const { DEFAULT_FILES } = require('./run_mutation')
// 显式比较器（Sonar S2871 要求 sort 传比较函数）。这里刻意**不用** localeCompare：
// ICU 排序会忽略 `.`/`/` 等变权重标点（"xbk_utils.js" vs "scripts/check-deps.js" 的相对次序
// 与默认排序可能不同），而本断言只要求两侧以同一口径排序；按 UTF-16 码位比较与
// Array.prototype.sort() 的默认行为逐字符等价，可保持既有比较语义不变。
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
assert.deepStrictEqual([...DEFAULT_FILES].sort(byCodeUnit), [...mutate].sort(byCodeUnit),
  'run_mutation.js 的 DEFAULT_FILES 必须与 stryker.config.js 的 mutate 目标完全一致（增删 mutate 目标时同步）')
assert.strictEqual(new Set(DEFAULT_FILES).size, DEFAULT_FILES.length, 'DEFAULT_FILES 不得含重复项')
for (const file of DEFAULT_FILES) {
  assert.ok(fs.existsSync(file), `DEFAULT_FILES 里的 ${file} 不存在（变异目标必须可读）`)
}

console.log('✅ 遗漏生产模块或行段越界会使 mutation 范围校验失败')
console.log('✅ 当前 mutation 矩阵覆盖全部生产模块')
console.log('✅ run_mutation.js 的 DEFAULT_FILES 与 stryker.config.js 的 mutate 目标一致')
