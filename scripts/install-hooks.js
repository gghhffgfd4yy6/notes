'use strict'

// 注册仓库本地 git hooks（.githooks）。
// 设计原则（回应 code review）：
//   - 仅当 core.hooksPath 未配置时才设置；**非空**的已有配置（无论指向何处）一律不覆盖；
//     空串（core.hooksPath=""）不算「已配置」——git 此时退回默认 hooks 目录、本仓库门禁不生效，
//     语义等同未配置，故按未配置处理并写入 .githooks（只补一条说明性告警）；
//   - 「未配置」只认 git config --get 的退出码 1（键不存在）；其它失败视为「读取失败」，
//     无法确认是否已有配置时按「不覆盖」处理并以非零退出码报错（fail-closed）；
//   - git 不可用 / 非 git 工作树时给出告警并正常退出，不阻断安装；
//   - 配置写入失败时以非零退出码报错（不静默吞掉）；
//   - 不只写配置：安装前后核验钩子真实可用（存在 + 可执行）。目录/文件缺失时
//     git 会静默忽略全部钩子，必须非零退出；仅缺可执行位时尝试 chmod 0o700 修复，
//     修复不了（如 noexec 挂载）则醒目告警，绝不把「配置已写入」说成「门禁已生效」。
//   - --verify（审查 F6）：只读自检入口——回答「提交/推送门禁此刻是否真的生效」，不写配置、不 chmod。
//     生效则 exit 0，否则 exit 1 并说明原因；默认（无参数）路径中「跳过/未覆盖」按设计仍 exit 0
//     （非工作树、已存在其它 hooksPath 等无需安装），自动化因此只能靠解析 stdout 区分「装上」与
//     「跳过」，--verify 就是给自动化/CI 的显式查询入口。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HOOKS_DIR = '.githooks'
// 受版本控制的提交/推送门禁；新增钩子文件时同步此列表以便核验。
// 三者缺一即门禁不完整：pre-commit（lint/版本闸门/变异行段）、commit-msg（提交信息格式）、
// pre-push（npm run test:filter，v3.276 起从 pre-commit 迁来）。
const HOOK_FILES = ['pre-commit', 'commit-msg', 'pre-push']

// 只认 --verify 一个参数。未知参数一律**拒绝执行**（C10-031）：旧实现用 includes('--verify')
// 判定模式，`--verfiy` 这类笔误会被静默忽略并落到安装路径、真的写入 core.hooksPath——
// 调用方以为在做只读自检，实际改了仓库配置。参数白名单 + fail-closed 才能让笔误暴露出来。
const KNOWN_ARGS = new Set(['--verify'])

function parseArgs (argv) {
  const unknown = argv.filter(arg => !KNOWN_ARGS.has(arg))
  if (unknown.length > 0) {
    console.error(`[hooks] ❌ 未识别参数：${unknown.join(' ')}（可用参数：--verify；不带参数＝安装 core.hooksPath）`)
    console.error('[hooks]    已拒绝执行（fail-closed）：拼错的 --verify 会落到安装路径并写入 core.hooksPath。')
    process.exit(2)
  }
  return argv.includes('--verify')
}

// 只读自检模式（--verify）：不写 core.hooksPath、不 chmod、不创建/删除任何文件。
const VERIFY_ONLY = parseArgs(process.argv.slice(2))

// git config --get 的退出码语义：0 = 键存在（值可能是空串）、1 = 键不存在、其它 = 读取失败。
const GIT_CONFIG_KEY_MISSING = 1

function git (args) {
  // 跨平台工具脚本需按名调用系统 git（依赖 PATH），非命令注入面 —— 对 SonarCloud S4036 免检
  // stderr 必须 pipe 而不是 ignore：否则 git 的 fatal/error 行不会进入 e.stderr，报错只剩
  // 「Command failed: ...」，看不到真实原因（PR 评审 F5）。
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() // NOSONAR
}

// 取 execFileSync 错误里的 stderr（execFileSync 默认 encoding 为 buffer，可能是 Buffer）。
function gitStderr (e) {
  const raw = e && e.stderr
  if (!raw) return ''
  return (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)).trim()
}

// 打印失败原因：git 自己的诊断（stderr）比 Node 的 e.message 更有信息量。
function reportGitFailure (prefix, e) {
  const message = String((e && e.message) || e)
  const detail = gitStderr(e)
  console.error(`${prefix}${message}`)
  // 较新的 Node 已把 stderr 拼进 e.message；仅在其缺失时补打，避免重复刷屏
  if (detail && !message.includes(detail)) console.error(`[hooks]    git: ${detail}`)
}

function isDirectory (target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch (e) {
    return false
  }
}

// ── 执行位核验（C10-032）───────────────────────────────────────────────────────
// 为什么要三条信号：chmod 只能改 mode 位，改不了挂载选项；而 git 执行钩子走的是 execve。
// 旧实现只问 accessSync(X_OK)，把两件不同的事混成一个布尔值：
//   · mode 位缺失 → chmod 能修好；
//   · 挂载点 noexec → chmod 立即成功、位也变成 0700，但 execve 照样 EACCES；
//     而 access() 的判定在某些文件系统/实现上不反映挂载选项（本机实测 tmpfs noexec 会返回
//     EACCES，但不能假定所有平台都如此），于是「核验通过」的钩子仍可能被 git 静默跳过。
// 这里先读 mode 与挂载选项（纯元数据，不执行任何东西），再用 access 兜底，并给出可区分的诊断。
const OWNER_EXEC_BIT = 0o100
const PROC_MOUNTS = '/proc/self/mounts'
// Windows 没有 POSIX 执行位（评审 CR-06）：chmod 只切只读标志，mode 位永远不置位，而 access(X_OK)
// 在 Windows 上只等价于「存在」。按 POSIX 口径判 owner 执行位会把**可正常执行**的钩子判成
// missing-mode，且 verifyHooks 的自动修复（chmod 0o700）清不掉 ⇒ 安装与 --verify 一起假红。
const IS_WINDOWS = process.platform === 'win32'

// /proc/self/mounts 用 \040 \011 \012 \134 转义空白与反斜杠；挂载点路径含空格时不解码就匹配不上。
function decodeMountField (field) {
  return field.replace(/\\([0-7]{3})/g, (m, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
}

// 返回 {point, noexec}，或 null 表示无法判定（非 Linux 平台没有 /proc/self/mounts）。
// 按最长前缀匹配：嵌套挂载（如 /home 与 /home/x 各挂一份）必须取更里层那个的选项。
function mountOf (file) {
  let mounts
  try {
    mounts = fs.readFileSync(PROC_MOUNTS, 'utf8')
  } catch (e) {
    return null
  }
  let dir
  try {
    dir = fs.realpathSync(path.dirname(file))
  } catch (e) {
    dir = path.resolve(path.dirname(file))
  }
  let best = null
  for (const line of mounts.split('\n')) {
    if (line === '') continue
    const fields = line.split(' ')
    if (fields.length < 4) continue
    const point = decodeMountField(fields[1])
    const covers = dir === point || dir.startsWith(point.endsWith('/') ? point : point + '/')
    if (!covers) continue
    if (best === null || point.length > best.point.length) {
      best = { point, noexec: fields[3].split(',').includes('noexec') }
    }
  }
  return best
}

function describeError (e) {
  return (e && (e.code || e.message)) || '未知错误'
}

// 单文件执行性诊断：{ok, fixable, code, reason}。
// code 让调用方能区分处置方式：missing-mode（chmod 可修）/ noexec（换挂载点）/ access（ACL、策略）/ stat。
function execDiagnosis (file) {
  const mount = mountOf(file)
  let mode
  try {
    mode = fs.lstatSync(file).mode & 0o777
  } catch (e) {
    return { ok: false, fixable: false, code: 'stat', reason: `无法读取权限位（${describeError(e)}）` }
  }
  if (mount && mount.noexec) {
    return { ok: false, fixable: false, code: 'noexec', reason: `所在挂载点 ${mount.point} 带 noexec，执行位改了也 execve 不了` }
  }
  // Windows 跳过 owner 执行位判定（见 IS_WINDOWS 注释）：这里的 mode 位没有执行语义。
  if (!IS_WINDOWS && (mode & OWNER_EXEC_BIT) === 0) {
    return { ok: false, fixable: true, code: 'missing-mode', reason: `缺少属主执行位（0${mode.toString(8)}）` }
  }
  try {
    fs.accessSync(file, fs.constants.X_OK)
  } catch (e) {
    return { ok: false, fixable: false, code: 'access', reason: `权限位齐备，但 access(X_OK) 判定不可执行（${describeError(e)}；可能来自 ACL/文件系统策略）` }
  }
  return { ok: true, fixable: false, code: 'ok', reason: '' }
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
  const blocked = []
  for (const name of HOOK_FILES) {
    const file = path.join(dir, name)
    let diag = execDiagnosis(file)
    // 只对「chmod 有机会修好」的情形尝试修复；noexec 挂载上 chmod 只会假装成功。
    if (!diag.ok && diag.fixable) {
      let chmodError = null
      try {
        // 0o700：钩子只需属主可读可执行（git 以属主身份运行钩子）。不用 0o755——
        // 组/其他用户可读可执行对本仓库钩子没有必要，且会被 Sonar S2612 判为过宽权限。
        fs.chmodSync(file, 0o700)
      } catch (e) {
        // chmod 失败不单独报错，交由下方复检统一给出结论与指引
        chmodError = e
      }
      diag = chmodError
        ? { ok: false, fixable: false, code: 'chmod', reason: `chmod 0o700 失败（${describeError(chmodError)}）` }
        : execDiagnosis(file)
    }
    if (!diag.ok) blocked.push({ name, diag })
  }
  if (blocked.length > 0) {
    const list = blocked.map(item => `${HOOKS_DIR}/${item.name}`).join('、')
    console.warn(`[hooks] ⚠️  以下钩子不可执行，git 会静默跳过，提交门禁实际未生效：${list}`)
    for (const item of blocked) console.warn(`[hooks]    ${HOOKS_DIR}/${item.name}：${item.diag.reason}`)
    // 指引必须按原因给：noexec 上 chmod 一定「成功」却毫无作用，再叫人 chmod +x 等于把人送进死循环。
    if (blocked.some(item => item.diag.code === 'noexec')) {
      console.warn('[hooks]    所在文件系统带 noexec：chmod 无效，只能把仓库换到可执行的文件系统，或由管理员去掉挂载选项。')
    }
    if (blocked.some(item => item.diag.code !== 'noexec')) {
      console.warn(`[hooks]    其余情况请手动修复后重跑本脚本自检：chmod +x ${list.replace(/、/g, ' ')}`)
    }
    return false
  }
  return true
}

// --verify 的只读核验：报告门禁此刻是否生效，不尝试 chmod（安装路径的 verifyHooks 会尝试修复）。
// 返回 true = 钩子目录、文件、可执行位三者齐备。
function reportHookGate (dir) {
  if (!isDirectory(dir)) {
    console.error(`[hooks] ❌ 门禁未生效：钩子目录不存在或不是目录：${dir}`)
    return false
  }
  const missing = HOOK_FILES.filter(name => !fs.existsSync(path.join(dir, name)))
  if (missing.length > 0) {
    console.error(`[hooks] ❌ 门禁未生效：缺少钩子文件 ${missing.map(name => `${HOOKS_DIR}/${name}`).join('、')}`)
    return false
  }
  const blocked = HOOK_FILES
    .map(name => ({ name, diag: execDiagnosis(path.join(dir, name)) }))
    .filter(item => !item.diag.ok)
  if (blocked.length > 0) {
    console.error(`[hooks] ❌ 门禁未生效：钩子不可执行（git 会静默跳过）${blocked.map(item => `${HOOKS_DIR}/${item.name}`).join('、')}`)
    for (const item of blocked) console.error(`[hooks]    ${HOOKS_DIR}/${item.name}：${item.diag.reason}`)
    // --verify 只读：不 chmod，但也不能把 noexec 场景指向「chmod +x」这条死路。
    if (blocked.every(item => item.diag.code === 'noexec')) {
      console.error('[hooks]    --verify 只读：所在文件系统带 noexec，chmod 无效；请换到可执行的文件系统或由管理员去掉挂载选项。')
    } else {
      console.error('[hooks]    --verify 只读，不尝试 chmod；缺执行位请手动执行：chmod +x ' + blocked.map(item => `${HOOKS_DIR}/${item.name}`).join(' '))
    }
    return false
  }
  console.log(`[hooks] ✅ 门禁已生效：core.hooksPath=${HOOKS_DIR}，${HOOKS_DIR}/ 下 ${HOOK_FILES.join('、')} 存在且可执行`)
  return true
}

let insideRepo = false
let repoCheckError = null
try {
  insideRepo = git(['rev-parse', '--is-inside-work-tree']) === 'true'
} catch (e) {
  insideRepo = false
  repoCheckError = e
}

if (!insideRepo) {
  // 跳过 ≠ 门禁已生效：本路径按设计以 0 退出（非工作树无需安装），自动化不得据此判定已装好。
  // --verify 是显式查询「门禁是否生效」的入口，此时答案必然是否 → 非零退出（fail-closed）。
  if (VERIFY_ONLY) {
    console.error('[hooks] ❌ 门禁未生效：当前不在 git 工作树内（或 git 不可用）')
    if (repoCheckError) {
      const detail = gitStderr(repoCheckError)
      console.error(`[hooks]    诊断：${detail || repoCheckError.message}`)
    }
    process.exit(1)
  }
  console.warn('[hooks] 跳过：当前不在 git 工作树内（或 git 不可用）；按设计以 0 退出，不代表提交门禁已生效。')
  if (repoCheckError) {
    const detail = gitStderr(repoCheckError)
    console.warn(`[hooks]    诊断：${detail || repoCheckError.message}`)
  }
  process.exit(0)
}

// core.hooksPath 的相对路径由 git 按工作树根解析，核验也须锚定到根目录，
// 否则从子目录执行会把 .githooks 解析到错误位置。
let repoRoot = process.cwd()
try {
  repoRoot = git(['rev-parse', '--show-toplevel']) || repoRoot
} catch (e) {
  // 退回 cwd：verifyHooks 会如实报告钩子目录缺失
  const detail = gitStderr(e)
  console.warn(`[hooks] ⚠️  无法解析工作树根目录，退回当前目录 ${repoRoot}：${detail || e.message}`)
}
const resolvedHooksDir = path.join(repoRoot, HOOKS_DIR)

// PR 评审 F4：只有退出码 1（键不存在）才算「未配置」。其它失败（配置损坏、git 异常等）
// 不能当成「未配置」——那会在已有配置的情况下把它覆盖掉，违反 :5 的硬保证。
// C10-069：`current === ''` 是两个不同事实的合流——(a) 键**不存在**（unset，新克隆即此状态）、
// (b) 键存在但值**是空串**（core.hooksPath=""）。二者对门禁的后果相同（git 都退回默认 hooks
// 目录 ⇒ 本仓库门禁不生效），但对用户是两件事：把 (a) 说成「检测到空串」是假话。故另记 state，
// 输出按真实语义区分（unset / empty / set；值仅含空白时 git() 已 trim，按 empty 归类）。
let current = ''
let hooksPathState = 'unset'
let hooksPathConfigured = false
try {
  current = git(['config', '--get', 'core.hooksPath'])
  // 退出码 0 即键存在；但**值为空串**（core.hooksPath=""）时 git 会退回默认 hooks 目录，
  // 本仓库门禁并不生效——语义上等同「未配置」，仍走下方安装分支。
  // qodo #147-1：此前把空串也算「已配置」→ 只告警并 exit 0，自动化会误判「安装成功」，
  // 而门禁其实从未生效（本文件 :5 的硬保证要求不得出现这种假成功）。
  hooksPathState = current === '' ? 'empty' : 'set'
  hooksPathConfigured = current !== ''
} catch (e) {
  if (e.status === GIT_CONFIG_KEY_MISSING) {
    hooksPathConfigured = false
  } else {
    console.error('[hooks] ❌ 读取 core.hooksPath 失败，无法确认是否已有配置。')
    reportGitFailure('[hooks]    原因：', e)
    console.error('[hooks]    为避免覆盖既有配置，未写入任何配置；请先修复 git 配置后重跑本脚本。')
    process.exit(1)
  }
}

// --verify：只读自检，必须在任何写配置/chmod 之前返回（本分支不落到下面的安装逻辑）。
if (VERIFY_ONLY) {
  if (current !== HOOKS_DIR) {
    console.error(`[hooks] ❌ 门禁未生效：core.hooksPath=${current === '' ? (hooksPathState === 'empty' ? '(空串：显式设为空)' : '(未设置：键不存在)') : current}，期望 ${HOOKS_DIR}`)
    process.exit(1)
  }
  if (!reportHookGate(resolvedHooksDir)) process.exit(1)
  process.exit(0)
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
if (hooksPathConfigured) {
  console.warn(`[hooks] 已存在 core.hooksPath=${current}，未覆盖；本仓库提交门禁不会生效。如需改用本仓库钩子：git config core.hooksPath ${HOOKS_DIR}`)
  process.exit(0)
}
if (hooksPathState === 'empty') {
  console.warn('[hooks] 检测到 core.hooksPath 已被显式设为空串（键存在、值为 ""；git 退回默认 hooks 目录，本仓库门禁不生效），按未配置处理并写入本仓库钩子。')
} else if (hooksPathState === 'unset') {
  console.warn('[hooks] 未检测到 core.hooksPath 配置（键不存在 = 从未设置，新克隆的默认状态；git 用默认 hooks 目录，本仓库门禁不生效），按未配置处理并写入本仓库钩子。')
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
  // PR 评审 F5：带上 git 自己的 stderr（fatal/error 行），否则只剩「Command failed: ...」
  reportGitFailure('[hooks] 注册失败：', e)
  process.exit(1)
}

console.log(`[hooks] 已注册：core.hooksPath=${HOOKS_DIR}`)
