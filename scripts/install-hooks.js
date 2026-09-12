'use strict'

// 注册仓库本地 git hooks（.githooks）。
// 设计原则（回应 code review）：
//   - 仅当 core.hooksPath 未配置时才设置；已有配置（无论指向何处）一律不覆盖；
//   - git 不可用 / 非 git 工作树时给出告警并正常退出，不阻断安装；
//   - 配置写入失败时以非零退出码报错（不静默吞掉）。
const { execFileSync } = require('node:child_process')

const HOOKS_DIR = '.githooks'

function git (args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

let insideRepo = false
try {
  insideRepo = git(['rev-parse', '--is-inside-work-tree']) === 'true'
} catch (e) {
  insideRepo = false
}

if (!insideRepo) {
  console.warn('[hooks] 跳过：当前不在 git 工作树内（或 git 不可用）')
  process.exit(0)
}

let current = ''
try {
  current = git(['config', '--get', 'core.hooksPath'])
} catch (e) {
  current = ''
}

if (current === HOOKS_DIR) {
  console.log(`[hooks] 已就绪：core.hooksPath=${HOOKS_DIR}`)
  process.exit(0)
}
if (current) {
  console.warn(`[hooks] 已存在 core.hooksPath=${current}，未覆盖。如需改用本仓库钩子：git config core.hooksPath ${HOOKS_DIR}`)
  process.exit(0)
}

try {
  git(['config', 'core.hooksPath', HOOKS_DIR])
  console.log(`[hooks] 已注册：core.hooksPath=${HOOKS_DIR}`)
} catch (e) {
  console.error(`[hooks] 注册失败：${e.message}`)
  process.exit(1)
}
