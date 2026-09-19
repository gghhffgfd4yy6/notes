'use strict'

// scripts/install-hooks.js 的 --verify 只读自检回归（审查 F6）：
// 默认路径里「跳过/未覆盖」（非 git 工作树、已有其它 core.hooksPath）一律 exit 0——自动化只能
// 靠解析 stdout 区分「装上了」与「跳过了」，无法用退出码判定门禁是否生效。--verify 提供显式的
// 只读查询：门禁此刻生效 → exit 0；否则 exit 1 并说明原因，且绝不写 core.hooksPath、绝不 chmod。
// 全部用例在 os.tmpdir() 里自建 git 仓库（隔离 HOME/全局与系统 gitconfig），不依赖本仓库的钩子状态
// （本机 /storage/emulated 是 noexec 挂载，本仓库的钩子本就没有执行位，不能作为夹具）。
// v3.276 起 HOOK_FILES 增加 pre-push（test:filter 从 pre-commit 迁来）：用例 8/9 专门锁定
// 「旧清单（缺 pre-push）必须红」「pre-push 无执行位必须红」——把 pre-push 从清单里去掉，
// 这两条断言立刻失败（靶向回退已在报告里实测）。
// v3.276+（Qodo 评审 PR #156）起另加 pre-push 的端到端用例 A–F（见文件末尾）：锁定「门禁必须对
// **被推提交的内容**跑」——快路径（sha==HEAD 且已跟踪文件干净）/ 隔离 worktree（非当前 HEAD 或工作树脏）
// / fail-closed（隔离建不起来绝不用工作树冒充）。用例 B 是本次修复的靶向反例：旧实现必红。
// 用例 F（PR #156 评审返工）锁定「一 sha 一清理」：一次推送两个**不同**的非 HEAD sha 时，两个临时
// worktree 都必须被清掉——旧实现只清最后一个、第一个泄漏（WT_TMP 是单变量，成功路径不清理），
// 而钩子照样 exit 0。旧实现下用例 F 必红（靶向回退已实测）。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const INSTALL_HOOKS = path.join(__dirname, 'scripts', 'install-hooks.js')

// 与 scripts/install-hooks.js 的 HOOK_FILES 对齐：--verify 要求这三者全部存在且可执行。
// 其中 pre-push 是 v3.276 新增（承载迁出 pre-commit 的 npm run test:filter 门禁）。
const EXPECTED_HOOKS = ['pre-commit', 'commit-msg', 'pre-push']

// git 一律以**绝对路径**调用：按名调用（spawnSync('git', …)）会让子进程经 PATH 解析可执行文件，
// 静态分析按「命令解析依赖 PATH」判为 Sonar S4036（"PATH" 变量只应含固定目录；生产侧
// scripts/install-hooks.js:37 的同类告警只能挂 NOSONAR，因为工具脚本必须跨平台按名调用）。
// 这里用纯 JS 扫 PATH 解析（不额外 spawn 进程），绝对路径下无需 PATH 参与命令解析。
// 解析不到 git 直接抛错：本套件依赖真实 git 建临时仓库，找不到必须 fail-closed 而不是静默跳过。
const GIT = (process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean)
  .map(dir => path.join(dir, 'git'))
  .find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true } catch { return false }
  })
assert.ok(GIT, '未能在 PATH 中找到可执行的 git（本套件依赖真实 git 建临时仓库）')

// 用哪个可执行文件跑子进程：本机（DSH/Termux 命名空间）的 node 由 Android 系统 linker 装载，
// process.execPath 会报成 /apex/com.android.runtime/bin/linker64——spawn 它等于让 linker 把 .js 当 ELF
// 执行（`bad ELF magic`），于是本该检查门禁状态的用例在本机全红。process.argv0 才是真正的 node 路径
// （CI/ubuntu 上两者一致），故取 argv0、缺失时回退 execPath：只改「用什么跑子进程」，不改任何断言语义。
const NODE_EXEC = process.argv0 && fs.existsSync(process.argv0) ? process.argv0 : process.execPath

// 沙箱化 git 环境：HOME/XDG 指向临时目录，禁用全局与系统 gitconfig——否则开发机上的
// core.hooksPath 会泄漏进用例，让「未配置」用例假绿/假红。
function sandboxEnv (home) {
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
}

function runVerify (cwd, home) {
  return spawnSync(NODE_EXEC, [INSTALL_HOOKS, '--verify'], { cwd, encoding: 'utf8', env: sandboxEnv(home) })
}

function runPlugin (cwd, home, args) {
  return spawnSync(NODE_EXEC, [INSTALL_HOOKS, ...args], { cwd, encoding: 'utf8', env: sandboxEnv(home) })
}

function gitConfig (cwd, home, key) {
  return spawnSync(GIT, ['config', '--get', key], { cwd, encoding: 'utf8', env: sandboxEnv(home) })
}

function initRepo (dir, home) {
  const init = spawnSync(GIT, ['init', '-q'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
  assert.strictEqual(init.status, 0, `git init 失败：${init.stderr}`)
}

function writeHooks (dir, names = EXPECTED_HOOKS, mode = 0o700) {
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true })
  for (const name of names) {
    const file = path.join(dir, '.githooks', name)
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(file, mode)
  }
}

// 每个用例一个独立的临时仓库 + 独立 HOME；返回 { dir, home }
let caseNo = 0
function makeCase () {
  caseNo += 1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xbk-hooks-${caseNo}-`))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  return { dir, home }
}

// 1) 非 git 工作树：默认路径 exit 0（跳过），--verify 必须 fail-closed
{
  const { dir, home } = makeCase()
  try {
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, '非 git 工作树：--verify 必须非 0（默认路径仍按设计 exit 0）')
    assert.match(r.stderr, /门禁未生效/, '应明确报告门禁未生效')
    assert.match(r.stderr, /不在 git 工作树/, '应说明原因（非工作树/git 不可用）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 2) 仓库内但 core.hooksPath 未配置 + 钩子齐备可执行：--verify 非 0（门禁未生效），且必须只读
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir)
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, 'core.hooksPath 未配置时门禁不生效，--verify 必须非 0')
    assert.match(r.stderr, /core\.hooksPath=\(未设置或空串\)/, '应回显当前配置值')
    const cfg = gitConfig(dir, home, 'core.hooksPath')
    assert.notStrictEqual(cfg.status, 0, '--verify 是只读的：不得顺手写入 core.hooksPath')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 3) 已配置且钩子齐备可执行：--verify exit 0
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir)
    const set = spawnSync(GIT, ['config', 'core.hooksPath', '.githooks'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
    assert.strictEqual(set.status, 0, `git config 失败：${set.stderr}`)
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 0, `门禁齐备时 --verify 应 exit 0：${r.stderr || r.stdout}`)
    assert.match(r.stdout, /门禁已生效/, '应输出「门禁已生效」')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 4) 已存在其它 core.hooksPath：默认路径 exit 0（不覆盖），--verify 必须非 0 且不改配置
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir)
    spawnSync(GIT, ['config', 'core.hooksPath', '.other-hooks'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, 'hooksPath 指向别处时本仓库门禁不生效，--verify 必须非 0')
    assert.match(r.stderr, /core\.hooksPath=\.other-hooks/, '应回显指向别处的实际值')
    assert.strictEqual(gitConfig(dir, home, 'core.hooksPath').stdout.trim(), '.other-hooks', '不得覆盖既有配置')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 5) 钩子文件缺失：--verify 非 0 并点名缺哪个
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir, ['pre-commit'])
    spawnSync(GIT, ['config', 'core.hooksPath', '.githooks'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, '缺钩子文件时门禁不生效，--verify 必须非 0')
    assert.match(r.stderr, /缺少钩子文件/, '应报告缺少钩子文件')
    assert.match(r.stderr, /commit-msg/, '应点名缺失的具体钩子')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 6) 钩子无执行位：--verify 非 0 且保持只读（不 chmod——修复是安装路径的职责）
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir, EXPECTED_HOOKS, 0o600)
    spawnSync(GIT, ['config', 'core.hooksPath', '.githooks'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
    const hook = path.join(dir, '.githooks', 'pre-commit')
    const before = fs.statSync(hook).mode & 0o777
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, '钩子不可执行时门禁不生效，--verify 必须非 0')
    assert.match(r.stderr, /钩子不可执行/, '应报告不可执行（git 会静默跳过）')
    assert.strictEqual(fs.statSync(hook).mode & 0o777, before, '--verify 只读：不得 chmod 修复')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 7) 无参数默认路径仍按设计 exit 0（非工作树跳过）——--verify 是新增入口，不改变既有语义
{
  const { dir, home } = makeCase()
  try {
    const r = runPlugin(dir, home, [])
    assert.strictEqual(r.status, 0, `默认路径在非工作树内仍应 exit 0：${r.stderr || r.stdout}`)
    assert.match(r.stderr, /跳过/, '应显式声明是「跳过」而非「已生效」')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 8) 【v3.276 靶向断言】旧清单（只有 pre-commit + commit-msg，缺 pre-push）：--verify 必须非 0 并点名
//    pre-push。把 HOOK_FILES 回退成迁移前的 ['pre-commit','commit-msg']，本用例必红：那版实现认为
//    门禁齐备 → exit 0，而承载 test:filter 的 pre-push 实际不存在（提交/推送门禁被静默削弱）。
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir, ['pre-commit', 'commit-msg'])
    spawnSync(GIT, ['config', 'core.hooksPath', '.githooks'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, '缺 pre-push 时 test:filter 门禁不在链上，--verify 必须非 0')
    assert.match(r.stderr, /缺少钩子文件/, '应报告缺少钩子文件')
    assert.match(r.stderr, /pre-push/, '应点名缺失的 pre-push（旧实现的 HOOK_FILES 里没有它）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 9) 【v3.276 靶向断言】仅 pre-push 无执行位（另两个钩子可执行）：--verify 必须非 0、点名 pre-push，
//    且保持只读（不 chmod）。pre-push 不在清单里的旧实现会漏检 → exit 0，本用例即红。
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir, ['pre-commit', 'commit-msg'], 0o700)
    writeHooks(dir, ['pre-push'], 0o600)
    spawnSync(GIT, ['config', 'core.hooksPath', '.githooks'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
    const hook = path.join(dir, '.githooks', 'pre-push')
    const before = fs.statSync(hook).mode & 0o777
    const r = runVerify(dir, home)
    assert.strictEqual(r.status, 1, 'pre-push 不可执行时 git 会静默跳过 test:filter，--verify 必须非 0')
    assert.match(r.stderr, /钩子不可执行/, '应报告不可执行（git 会静默跳过）')
    assert.match(r.stderr, /pre-push/, '应点名不可执行的 pre-push')
    assert.strictEqual(fs.statSync(hook).mode & 0o777, before, '--verify 只读：不得 chmod 修复')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 10) 【v3.276 靶向断言】安装路径（无 --verify）同样把 pre-push 列进清单：缺 pre-push 时必须
//     fail-closed——非 0 退出、点名缺哪个、且**不得**顺手写入 core.hooksPath（否则「配置已写入」
//     会被当成「门禁已生效」）。旧实现（清单无 pre-push）在这里 exit 0 且写入配置 → 本用例红。
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir, ['pre-commit', 'commit-msg'])
    const r = runPlugin(dir, home, [])
    assert.strictEqual(r.status, 1, '安装路径必须核验全部钩子：缺 pre-push 不得以 0 退出')
    assert.match(r.stderr, /缺少钩子文件/, '应报告缺少钩子文件')
    assert.match(r.stderr, /pre-push/, '应点名缺失的 pre-push')
    assert.notStrictEqual(gitConfig(dir, home, 'core.hooksPath').status, 0, '核验失败时不得写入 core.hooksPath')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 11) 安装路径正向：三个钩子齐备且可执行 → exit 0 并真的写入 core.hooksPath（pre-push 在清单内的
//     正向证据；与用例 10 一起锁定「列入清单」而不是「忽略多余文件」）。
{
  const { dir, home } = makeCase()
  try {
    initRepo(dir, home)
    writeHooks(dir, EXPECTED_HOOKS)
    const r = runPlugin(dir, home, [])
    assert.strictEqual(r.status, 0, `钩子齐备时安装应 exit 0：${r.stderr || r.stdout}`)
    assert.match(r.stdout, /已注册/, '应报告已注册 core.hooksPath')
    assert.strictEqual(gitConfig(dir, home, 'core.hooksPath').stdout.trim(), '.githooks', '应写入 .githooks')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// pre-push 门禁「必须对**被推提交的内容**跑」的端到端回归（Qodo 评审 PR #156 的真问题）。
//
// 旧实现把 stdin 里的 refs 读完只用于打印，然后无条件对**当前工作树**跑 `npm run test:filter`：
// ① `git push origin 别的分支` 时验证的是另一个提交；② 工作树有未提交修改时，未提交的修复可能掩盖
// 被推提交里的失败。两类都是「看起来跑了、其实没跑」的假绿灯。下面的用例锁定新语义。
//
// 夹具（os.tmpdir() 下的 hermetic 临时仓库，跑完删干净，绝不碰真实仓库）：一个假「远端」bare 仓库 +
// 一个工作仓库；工作仓库的 package.json `test:filter` 跑 gate.js——按**自己所在检出**的 gate.txt
// 内容 pass/fail，并把 {cwd, top, flag} 追加到 XBK_GATE_LOG，于是「门禁到底在哪跑、按谁的内容判定」
// 可观测。core.hooksPath 指向本仓库真实 .githooks/pre-push 的**逐字节副本**（用例先断言字节一致，
// 所以测的就是真钩子文件；副本在 TMPDIR 里可执行，而 /storage/emulated 是 fuse noexec + 钩子无执行位，
// 无法让 git 直接 exec 那边的真文件）。
//
// ⚠️ 为什么不用真 `git push` 来驱动钩子（环境缺陷，非本次改动引入）：本机 git 的 local transport 用
//   编译期写死的 /data/data/com.termux/files/usr/bin/sh 起 receive-pack，该路径在本机（DSH app 命名
//   空间）不存在，任何指向**本地路径**远端的 push 都在「连远端」阶段就 ENOENT 失败，走不到 pre-push。
//   GIT_TRACE 实证：`start_command: /data/data/com.termux/files/usr/bin/sh -c 'git-receive-pack <path>'`
//   → `fatal: cannot exec 'git-receive-pack <path>': No such file or directory`（/data/data 下无 com.termux，
//   且非 root 不可创建）。故这里按 git 的调用契约驱动真钩子：cwd = 工作仓库根、stdin = refs 流、
//   并设置 git 钩子会导出的 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE（这三者恰是被测代码必须清理的对象）。

const REAL_PRE_PUSH = path.join(__dirname, '.githooks', 'pre-push')

// bash 同样以**绝对路径**调用（理由同 GIT：别让命令解析依赖 PATH）。
const BASH = (process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean)
  .map(dir => path.join(dir, 'bash'))
  .find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true } catch { return false }
  })
assert.ok(BASH, '未能在 PATH 中找到可执行的 bash（本套件要直接驱动 .githooks/pre-push）')

// script(1) 仅用于「stdin 是终端」的 tty 分支（可选：缺失则显式跳过并说明，不静默假装跑了）。
const SCRIPT = (process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean)
  .map(dir => path.join(dir, 'script'))
  .find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true } catch { return false }
  })

const ZERO_SHA = '0'.repeat(40)

// 夹具门禁：__dirname 而非 cwd 读 gate.txt——隔离 worktree 里读到的一定是**被推提交**那份内容。
const FIXTURE_GATE_JS = [
  "'use strict'",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const { execFileSync } = require('node:child_process')",
  "let top = '(git 解析失败)'",
  "try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() } catch { top = '(git 解析失败)' }",
  "const flag = fs.readFileSync(path.join(__dirname, 'gate.txt'), 'utf8').trim()",
  'if (process.env.XBK_GATE_LOG) {',
  "  fs.appendFileSync(process.env.XBK_GATE_LOG, JSON.stringify({ cwd: process.cwd(), top, flag }) + '\\n')",
  '}',
  "process.stdout.write('GATE-FIXTURE[' + flag + '] cwd=' + process.cwd() + '\\n')",
  "process.exit(flag === 'pass' ? 0 : 1)",
  ''
].join('\n')

// 绝对路径调用真实 git；失败即断言失败（夹具建不起来不能静默跳过）。
function mustGit (args, opts, what) {
  const r = spawnSync(GIT, args, { encoding: 'utf8', ...opts })
  assert.strictEqual(r.status, 0, `${what || ('git ' + args.join(' '))} 失败（退出码 ${r.status}）：${r.stderr || r.stdout}`)
  return r.stdout
}

// commitGate：写进**提交**的 gate.txt 内容（决定被推提交本身是 pass 还是 fail）。
function makePushFixture ({ commitGate = 'pass' } = {}) {
  const { dir, home } = makeCase()
  const remote = path.join(dir, 'remote.git')
  const work = path.join(dir, 'work')
  const hooks = path.join(dir, 'hooks')
  const tmp = path.join(dir, 'tmp')
  const log = path.join(dir, 'gate.log')
  fs.mkdirSync(hooks)
  fs.mkdirSync(tmp)
  const env = sandboxEnv(home)
  mustGit(['init', '-q', '--bare', remote], { cwd: dir, env }, 'git init --bare（假远端）')
  mustGit(['-c', 'init.defaultBranch=main', 'init', '-q', work], { cwd: dir, env }, 'git init（工作仓库）')
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
    name: 'xbk-prepush-fixture',
    version: '1.0.0',
    private: true,
    scripts: { 'test:filter': 'node gate.js' }
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(work, 'gate.js'), FIXTURE_GATE_JS)
  fs.writeFileSync(path.join(work, 'gate.txt'), commitGate + '\n')
  mustGit(['config', 'user.email', 'fixture@example.invalid'], { cwd: work, env })
  mustGit(['config', 'user.name', 'fixture'], { cwd: work, env })
  mustGit(['add', '-A'], { cwd: work, env })
  mustGit(['commit', '-qm', 'fixture: 初始提交'], { cwd: work, env })
  mustGit(['remote', 'add', 'origin', remote], { cwd: work, env })
  // 与真仓库同款接线：core.hooksPath → hooks/pre-push（真钩子的逐字节副本，用例 A 里断言一致）
  fs.copyFileSync(REAL_PRE_PUSH, path.join(hooks, 'pre-push'))
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o700)
  mustGit(['config', 'core.hooksPath', hooks], { cwd: work, env })
  return {
    dir,
    home,
    remote,
    work,
    hooks,
    tmp,
    log,
    env,
    // 复刻 git 调用钩子时的环境：cwd=工作树根 + GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 指向调用方仓库
    // （隔离路径必须把它们清掉，否则子目录里的 git 操作会被指回调用方）。
    gateEnv: {
      ...env,
      TMPDIR: tmp,
      XBK_GATE_LOG: log,
      GIT_DIR: path.join(work, '.git'),
      GIT_WORK_TREE: work,
      GIT_INDEX_FILE: path.join(work, '.git', 'index')
    }
  }
}

// 按 git 的方式驱动真钩子（脚本参数 = <remote-name> <remote-url>，stdin = refs 流）。
function driveHook (fx, refLines, { env = {}, cwd } = {}) {
  return spawnSync(BASH, [path.join(fx.hooks, 'pre-push'), 'origin', fx.remote], {
    cwd: cwd || fx.work,
    encoding: 'utf8',
    env: { ...fx.gateEnv, ...env },
    input: refLines,
    timeout: 180000
  })
}

function hookOut (r) { return (r.stdout || '') + (r.stderr || '') }

function refLine (localRef, localSha, remoteRef, remoteSha = ZERO_SHA) {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`
}

// 门禁执行记录：每跑一次 npm run test:filter 就多一行 { cwd, top, flag }
// 不用 `existsSync` 预检再按路径读（那是 CodeQL js/file-system-race 的 check-then-use 形状，
// 会在 PR 上新增告警）：直接读，缺失（E NOENT）按「没有记录」处理。
function gateRuns (fx) {
  let raw = ''
  try {
    raw = fs.readFileSync(fx.log, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function headOf (fx, ref = 'HEAD') {
  return mustGit(['rev-parse', ref], { cwd: fx.work, env: fx.env }).trim()
}

function worktreeCount (fx) {
  const lines = mustGit(['worktree', 'list', '--porcelain'], { cwd: fx.work, env: fx.env }, 'git worktree list')
  return lines.split('\n').filter(line => line.startsWith('worktree ')).length
}

// 隔离目录必须落在夹具的 TMPDIR 下（/data/user/0 与 /data/data 是同一目录的两种写法，都接受）。
function assertInFixtureTmp (fx, dir, label) {
  const forms = new Set([fx.tmp, fs.realpathSync(fx.tmp)])
  assert.ok(forms.has(path.dirname(dir)), `${label}：${dir} 应落在夹具 TMPDIR（= 隔离 worktree 的位置）下`)
}

// 无论成败都不许残留：git worktree list 不留条目、TMPDIR 不留**本钩子**创建的隔离目录。
// 判据只认钩子自己的命名（`mktemp -d "${TMPDIR:-/tmp}/xbk-prepush-XXXXXX"`）：TMPDIR 是共用目录，
// npm/node/git 也会把各自的临时文件放进去（CI 上实测如此），把「整个 TMPDIR 必须为空」当判据会把
// 无关临时文件误判成钩子泄漏——而钩子真正的泄漏（残留 xbk-prepush-* 目录）仍然会被这条抓住。
function assertNoResidue (fx, label) {
  assert.strictEqual(worktreeCount(fx), 1, `${label}：git worktree list 不应残留临时 worktree`)
  const entries = fs.readdirSync(fx.tmp)
  const leaked = entries.filter(name => name.startsWith('xbk-prepush-'))
  const others = entries.filter(name => !name.startsWith('xbk-prepush-'))
  assert.deepStrictEqual(leaked, [],
    `${label}：TMPDIR 不得残留本钩子创建的隔离目录（泄漏：${leaked.join(', ') || '无'}；TMPDIR 内其它条目（非本钩子）：${others.join(', ') || '无'}）`)
}

// A) 快路径：干净工作树 + 推 HEAD → exit 0，且门禁只在当前工作树跑一次
{
  const fx = makePushFixture({ commitGate: 'pass' })
  try {
    assert.strictEqual(
      fs.readFileSync(path.join(fx.hooks, 'pre-push'), 'utf8'),
      fs.readFileSync(REAL_PRE_PUSH, 'utf8'),
      '夹具 hooks/pre-push 必须是 .githooks/pre-push 的逐字节副本（否则测的不是真钩子）'
    )
    const head = headOf(fx)
    const r = driveHook(fx, refLine('refs/heads/main', head, 'refs/heads/main'))
    assert.strictEqual(r.status, 0, `A：干净工作树推 HEAD 应通过：${hookOut(r)}`)
    // 断言只锁**行为**（不锁提示语）：干净 + sha==HEAD 时必须在当前工作树跑、且只跑一次、不建临时 worktree。
    const runs = gateRuns(fx)
    assert.strictEqual(runs.length, 1, `A：快路径门禁应只跑一次，实际 ${runs.length} 次`)
    assert.strictEqual(fs.realpathSync(runs[0].cwd), fs.realpathSync(fx.work), 'A：快路径必须在当前工作树里跑门禁')
    assert.strictEqual(runs[0].flag, 'pass', 'A：快路径读到的应是工作树（= 被推提交）的内容')
    assertNoResidue(fx, 'A')
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
}

// B) 【靶向本次修复】脏工作树：被推提交本身是 fail，工作树里未提交的改动是 pass
//    → 必须给出**提交**的结论（红），绝不能拿工作树（pass）冒充而放行。旧实现（无条件跑工作树）必红。
{
  const fx = makePushFixture({ commitGate: 'fail' })
  try {
    fs.writeFileSync(path.join(fx.work, 'gate.txt'), 'pass\n')
    const head = headOf(fx)
    const r = driveHook(fx, refLine('refs/heads/main', head, 'refs/heads/main'))
    assert.notStrictEqual(r.status, 0, `B（靶向）：被推提交内容是 fail，绝不能拿工作树（pass）冒充而假绿：${hookOut(r)}`)
    assert.match(hookOut(r), /GATE-FIXTURE\[fail\]/, 'B：失败回显必须是**被推提交**的结论')
    assert.doesNotMatch(hookOut(r), /GATE-FIXTURE\[pass\]/, 'B：绝不能出现工作树内容的结论')
    const runs = gateRuns(fx)
    assert.strictEqual(runs.length, 1, `B：门禁应只跑一次（在隔离 worktree 里），实际 ${runs.length} 次`)
    assert.strictEqual(runs[0].flag, 'fail', 'B：跑的必须是被推提交的内容')
    assert.notStrictEqual(runs[0].cwd, fx.work, 'B：不能在当前（脏）工作树里跑门禁')
    assert.match(runs[0].cwd, /xbk-prepush-/, 'B：隔离路径应落在钩子自建的临时 worktree 里')
    assertInFixtureTmp(fx, runs[0].cwd, 'B')
    assert.ok(!fs.existsSync(runs[0].cwd), 'B：临时 worktree 必须被清理（失败路径也不能残留）')
    assertNoResidue(fx, 'B')
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
}

// C) 非当前检出：推另一个分支 → 走隔离路径校验那个 sha 的内容，临时 worktree 用后必删
{
  const fx = makePushFixture({ commitGate: 'pass' })
  try {
    mustGit(['checkout', '-q', '-b', 'feature'], { cwd: fx.work, env: fx.env })
    fs.writeFileSync(path.join(fx.work, 'feature.txt'), 'feature\n')
    mustGit(['add', '-A'], { cwd: fx.work, env: fx.env })
    mustGit(['commit', '-qm', 'fixture: feature 提交'], { cwd: fx.work, env: fx.env })
    const feature = headOf(fx, 'feature')
    mustGit(['checkout', '-q', 'main'], { cwd: fx.work, env: fx.env })
    assert.notStrictEqual(headOf(fx), feature, 'C：前置条件——feature 必须不是当前 HEAD')
    const r = driveHook(fx, refLine('refs/heads/feature', feature, 'refs/heads/feature'))
    assert.strictEqual(r.status, 0, `C：推非当前检出的分支应按该提交内容通过：${hookOut(r)}`)
    assert.match(hookOut(r), /不是当前 HEAD/, 'C：应显式说明被推提交不是当前 HEAD')
    const runs = gateRuns(fx)
    assert.strictEqual(runs.length, 1, `C：门禁应只跑一次，实际 ${runs.length} 次`)
    assert.notStrictEqual(runs[0].cwd, fx.work, 'C：必须在隔离 worktree 里跑，不能拿当前检出冒充')
    assertInFixtureTmp(fx, runs[0].cwd, 'C')
    assert.strictEqual(runs[0].flag, 'pass', 'C：跑的应是被推提交的内容')
    assert.ok(!fs.existsSync(runs[0].cwd), 'C：临时 worktree 必须已删除')
    assertNoResidue(fx, 'C')
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
}

// D) fail-closed：隔离路径建不起来（这里把 git 包一层，让 worktree add 失败）
//    → 必须非零退出并说明，且**一次都不许**在脏工作树上跑门禁（跑了就是拿工作树冒充被推提交）。
{
  const fx = makePushFixture({ commitGate: 'fail' })
  try {
    fs.writeFileSync(path.join(fx.work, 'gate.txt'), 'pass\n')
    const shim = path.join(fx.dir, 'shim')
    fs.mkdirSync(shim)
    fs.writeFileSync(path.join(shim, 'git'),
      '#!/bin/sh\ncase " $* " in *" worktree add "*) echo "shim: 注入故障——拒绝 worktree add" >&2; exit 128;; esac\nexec ' + GIT + ' "$@"\n')
    fs.chmodSync(path.join(shim, 'git'), 0o700)
    const r = driveHook(fx, refLine('refs/heads/main', headOf(fx), 'refs/heads/main'),
      { env: { PATH: shim + path.delimiter + fx.env.PATH } })
    assert.notStrictEqual(r.status, 0, `D：隔离路径建不起来必须非零退出（fail-closed）：${hookOut(r)}`)
    assert.match(hookOut(r), /fail-closed/, 'D：必须显式说明是 fail-closed')
    assert.match(hookOut(r), /worktree/, 'D：应点名失败的是 worktree 隔离路径')
    assert.doesNotMatch(hookOut(r), /GATE-FIXTURE/, 'D：不得降级成在脏工作树上跑门禁')
    assert.strictEqual(gateRuns(fx).length, 0, 'D：门禁一次都不该跑（跑一次就是拿工作树冒充被推提交）')
    assertNoResidue(fx, 'D')
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
}

// E) 附：refs 解析细节——同一提交去重（只校验一次）、删除引用（local sha 全 0）跳过、
//    非推送上下文（stdin 没有 ref 流）仍可用且显式声明其证明力
{
  const fx = makePushFixture({ commitGate: 'pass' })
  const fx2 = makePushFixture({ commitGate: 'pass' })
  try {
    const head = headOf(fx)
    const r = driveHook(fx,
      refLine('refs/heads/main', head, 'refs/heads/main') +
      refLine('refs/heads/main', head, 'refs/heads/other') +
      refLine('refs/heads/dead', ZERO_SHA, 'refs/heads/dead', head))
    assert.strictEqual(r.status, 0, `E：同一提交多个 ref + 删除引用应通过：${hookOut(r)}`)
    assert.strictEqual((hookOut(r).match(/校验被推提交/g) || []).length, 1, 'E：同一提交去重后只校验一次')
    assert.match(hookOut(r), /删除（local sha 全 0）/, 'E：删除引用应显式跳过')
    assert.strictEqual(gateRuns(fx).length, 1, 'E：去重后门禁只跑一次')

    // 只含删除引用的推送：没有提交内容可校验 → 不跑门禁、不拿工作树冒充，exit 0
    const rDel = driveHook(fx, refLine('refs/heads/dead', ZERO_SHA, 'refs/heads/dead', head))
    assert.strictEqual(rDel.status, 0, `E：只含删除引用的推送应通过（没有提交内容要校验）：${hookOut(rDel)}`)
    assert.match(hookOut(rDel), /只含删除引用/, 'E：应显式说明本次没有提交内容需要校验')
    assert.strictEqual(gateRuns(fx).length, 1, 'E：删除引用不触发门禁（不得凭空跑一次工作树门禁）')

    const r2 = driveHook(fx2, '')
    assert.strictEqual(r2.status, 0, `E：非推送上下文（无 ref 流）仍应可用：${hookOut(r2)}`)
    assert.match(hookOut(r2), /非推送上下文/, 'E：必须显式声明这不是推送上下文')
    assert.match(hookOut(r2), /没有待推送 ref/, 'E：应说明没有 ref 流可校验')
    assert.strictEqual(gateRuns(fx2).length, 1, 'E：非推送上下文仍对当前工作树跑门禁')

    // tty 分支（stdin 是终端的手工执行）：需要 pty，用 script(1)；缺失则显式跳过（不静默假装跑了）
    if (SCRIPT) {
      const wrapper = path.join(fx2.dir, 'drive-tty.sh')
      fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + BASH + " '" + path.join(fx2.hooks, 'pre-push') + "' origin '" + fx2.remote + "'\n")
      fs.chmodSync(wrapper, 0o700)
      const rt = spawnSync(SCRIPT, ['-qec', "'" + wrapper + "'", '/dev/null'],
        { cwd: fx2.work, encoding: 'utf8', env: fx2.gateEnv, timeout: 180000 })
      assert.strictEqual(rt.status, 0, `E：stdin 是终端时钩子不应阻塞且应可用：${hookOut(rt)}`)
      assert.match(hookOut(rt), /stdin 是终端/, 'E：tty 执行应显式说明没有 ref 流（而不是静默挂住）')
      assert.strictEqual(gateRuns(fx2).length, 2, 'E：tty 分支同样对当前工作树跑一次门禁')
    } else {
      console.log('ℹ️ 未找到 script(1)：跳过「stdin 是终端」的 tty 分支用例（该分支与上面的空 ref 流共用同一段代码，仅提示语不同）')
    }
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true })
    fs.rmSync(fx2.dir, { recursive: true, force: true })
  }
}

// F) 【靶向本次修复：一 sha 一清理】一次推送两个**不同**的非 HEAD sha（两者门禁内容都是 pass）
//    → 钩子 exit 0；两个 sha 各建一个隔离 worktree、各跑一次门禁；跑完**两个**都必须被清理。
//    旧实现：WT_TMP 是单变量，成功路径只重置 GATE_DIR/NODE_PATH 而不清理；第二个 sha 的 mktemp
//    覆盖 WT_TMP，第一个 sha 的 worktree 从此失去引用（TMPDIR 里留着、`git worktree list` 里也留着），
//    EXIT trap 只清得到最后一个，而钩子照样打印「✅ pre-push 全部通过」→ 本用例必红。
//    注意与用例 E 的区别：E 的两个 ref 指向**同一个** sha（去重后只隔离一次），不构成多 sha 场景，
//    不能替代本条（也正因如此，「一次推多个隔离 sha」的泄漏此前一直隐形）。
{
  const fx = makePushFixture({ commitGate: 'pass' })
  try {
    // 造两个都不是当前 HEAD 的提交：main（夹具初始提交）→ a → b，再把 HEAD 拨回 main。
    mustGit(['checkout', '-q', '-b', 'a'], { cwd: fx.work, env: fx.env })
    fs.writeFileSync(path.join(fx.work, 'a.txt'), 'a\n')
    mustGit(['add', '-A'], { cwd: fx.work, env: fx.env })
    mustGit(['commit', '-qm', 'fixture: A'], { cwd: fx.work, env: fx.env })
    const shaA = headOf(fx, 'a')
    mustGit(['checkout', '-q', '-b', 'b'], { cwd: fx.work, env: fx.env })
    fs.writeFileSync(path.join(fx.work, 'b.txt'), 'b\n')
    mustGit(['add', '-A'], { cwd: fx.work, env: fx.env })
    mustGit(['commit', '-qm', 'fixture: B'], { cwd: fx.work, env: fx.env })
    const shaB = headOf(fx, 'b')
    mustGit(['checkout', '-q', 'main'], { cwd: fx.work, env: fx.env })
    assert.notStrictEqual(shaA, shaB, 'F：前置条件——两个 sha 必须不同（相同会被去重，构不成多 sha 场景）')
    assert.notStrictEqual(headOf(fx), shaA, 'F：前置条件——shaA 不能是当前 HEAD（否则走快路径，不建隔离 worktree）')
    assert.notStrictEqual(headOf(fx), shaB, 'F：前置条件——shaB 不能是当前 HEAD')

    const r = driveHook(fx,
      refLine('refs/heads/a', shaA, 'refs/heads/a') +
      refLine('refs/heads/b', shaB, 'refs/heads/b'))
    assert.strictEqual(r.status, 0, `F（靶向）：两个非 HEAD sha 门禁都通过时钩子应 exit 0：${hookOut(r)}`)
    assert.strictEqual((hookOut(r).match(/校验被推提交/g) || []).length, 2,
      'F：两个不同 sha 必须各校验一次（不得被去重）')

    const runs = gateRuns(fx)
    assert.strictEqual(runs.length, 2, `F：两个 sha 各应在隔离 worktree 里跑一次门禁，实际 ${runs.length} 次`)
    for (const run of runs) {
      assert.match(run.cwd, /xbk-prepush-/, 'F：两次门禁都必须在钩子自建的临时 worktree 里跑')
      assertInFixtureTmp(fx, run.cwd, 'F')
      assert.strictEqual(run.flag, 'pass', 'F：两次读到的都是各自被推提交的内容')
    }
    assert.notStrictEqual(runs[0].cwd, runs[1].cwd, 'F：两个 sha 必须各建自己的隔离 worktree（不是同一个）')

    // 核心断言：两个 sha 都校验完之后，**两个** worktree 都已清理。旧实现只清最后一个。
    for (const run of runs) {
      assert.ok(!fs.existsSync(run.cwd),
        `F：临时 worktree 必须被清理（泄漏：${run.cwd}）——WT_TMP 被下一个 sha 覆盖后 ` +
        'EXIT trap 再也定位不到它，成功路径必须显式清理（一 sha 一清理）')
    }
    // 沿用 assertNoResidue 的判据（git worktree list 只剩 1 条 + TMPDIR 无 xbk-prepush-* 残留）
    assertNoResidue(fx, 'F')
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true })
  }
}

console.log('✅ install-hooks --verify 只读自检：未生效 fail-closed / 生效 exit 0 / 不改配置不改权限；pre-push（v3.276）列入清单且缺失/无执行位均被检出')
console.log('✅ pre-push 门禁对象回归（PR #156）：快路径只跑一次 / 脏工作树按**被推提交内容**判定（旧实现必红）/ 非当前检出走隔离 worktree 且清理干净 / 隔离建不起来即 fail-closed 不跑工作树 / 去重+删除引用+非推送上下文 / 一次推多个非 HEAD sha 时每个隔离 worktree 都被清理（旧实现必红）')
