'use strict'

// 注册仓库本地 git hooks（.githooks）。
// 设计原则（回应 code review）：
//   - 仅当 core.hooksPath 未配置时才设置；已有配置（无论指向何处）一律不覆盖；
//   - git 不可用 / 非 git 工作树时给出告警并正常退出，不阻断安装；
//   - 配置写入失败时以非零退出码报错（不静默吞掉）；
//   - 不只写配置：安装前后核验钩子真实可用（存在 + 可执行）。目录/文件缺失时
//     git 会静默忽略全部钩子，必须非零退出；仅缺可执行位时尝试 chmod 0o755 修复，
//     修复不了（如 noexec 挂载）则醒目告警，绝不把「配置已写入」说成「门禁已生效」。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HOOKS_DIR = '.githooks'
// 受版本控制的提交门禁；新增钩子文件时同步此列表以便核验
const HOOK_FILES = ['pre-commit', 'commit-msg']

function git (args) {
  // 跨平台工具脚本需按名调用系统 git（依赖 PATH），非命令注入面 —— 对 SonarCloud S4036 免检
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() // NOSONAR
}

function isDirectory (target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch (e) {
    return false
  }
}

function isExecutable (file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch (e) {
    return false
  }
}

// 核验 .githooks 下受版本控制的钩子是否真的能被 git 调用。
// 返回 false 表示钩子不可执行（门禁未生效）；目录或钩子文件缺失时直接非零退出。
// 本机 /storage/emulated 是 noexec FUSE：chmod 静默无效且不报错，只能靠复检判定。
function verifyHooks (dir) {
  if (!isDirectory(dir)) {
    console.error(`[hooks] ❌ 钩子目录不存在或不是目录：${dir}`)
    console.error(`[hooks]    期望受版本控制的 ${HOOKS_DIR}/ 下含：${HOOK_FILES.join('、')}；目录缺失时 git 会静默忽略全部钩子。`)
    process.exit(1)
  }
  const missing = HOOK_FILES.filter(name => !fs.existsSync(path.join(dir, name)))
  if (missing.length > 0) {
    console.error(`[hooks] ❌ 缺少钩子文件：${missing.map(name => `${HOOKS_DIR}/${name}`).join('、')}`)
    console.error('[hooks]    当前分支/导出可能不含这些钩子；只写配置不会让缺失的钩子生效。')
    process.exit(1)
  }
  const notExecutable = HOOK_FILES.filter(name => {
    const file = path.join(dir, name)
    if (isExecutable(file)) return false
    try {
      // 0o700：钩子只需属主可读可执行（git 以属主身份运行钩子）。不用 0o755——
      // 组/其他用户可读可执行对本仓库钩子没有必要，且会被 Sonar S2612 判为过宽权限。
      fs.chmodSync(file, 0o700)
    } catch (e) {
      // chmod 失败不单独报错，交由下方复检统一给出结论与指引
    }
    return !isExecutable(file)
  })
  if (notExecutable.length > 0) {
    const list = notExecutable.map(name => `${HOOKS_DIR}/${name}`).join('、')
    console.warn(`[hooks] ⚠️  以下钩子不可执行，git 会静默跳过，提交门禁实际未生效：${list}`)
    console.warn('[hooks]    已尝试 chmod 755 但仍无执行位，常见于 noexec 挂载（如 /storage/emulated）或 core.filemode=false 的检出。')
    console.warn(`[hooks]    请手动执行后重跑本脚本自检：chmod +x ${list.replace(/、/g, ' ')}`)
    return false
  }
  return true
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

// core.hooksPath 的相对路径由 git 按工作树根解析，核验也须锚定到根目录，
// 否则从子目录执行会把 .githooks 解析到错误位置。
let repoRoot = process.cwd()
try {
  repoRoot = git(['rev-parse', '--show-toplevel']) || repoRoot
} catch (e) {
  // 退回 cwd：verifyHooks 会如实报告钩子目录缺失
}
const resolvedHooksDir = path.join(repoRoot, HOOKS_DIR)

let current = ''
try {
  current = git(['config', '--get', 'core.hooksPath'])
} catch (e) {
  current = ''
}

if (current === HOOKS_DIR) {
  if (!verifyHooks(resolvedHooksDir)) {
    // PR 评审 #140：门禁实际未生效时不得以 0 退出（否则 CI/自动化会把「配置已存在」当成成功）
    console.error(`[hooks] ❌ core.hooksPath 已指向 ${HOOKS_DIR}，但门禁未生效（见上方告警）；修复后重跑本脚本可自检。`)
    process.exit(1)
  }
  console.log(`[hooks] 已就绪：core.hooksPath=${HOOKS_DIR}`)
  process.exit(0)
}
if (current) {
  console.warn(`[hooks] 已存在 core.hooksPath=${current}，未覆盖。如需改用本仓库钩子：git config core.hooksPath ${HOOKS_DIR}`)
  process.exit(0)
}

// PR 评审 #140：钩子不可执行时（如 noexec 文件系统上 chmod 静默无效）不写配置、也不以 0 退出——
// 先在写之前核验，失败即退出 1，避免「门禁不生效却报告安装成功」。
if (!verifyHooks(resolvedHooksDir)) {
  console.error('[hooks] ❌ 钩子不可执行，未写入 core.hooksPath（提交门禁不会生效）。')
  process.exit(1)
}

try {
  git(['config', 'core.hooksPath', HOOKS_DIR])
} catch (e) {
  console.error(`[hooks] 注册失败：${e.message}`)
  process.exit(1)
}

console.log(`[hooks] 已注册：core.hooksPath=${HOOKS_DIR}`)
