'use strict'

// scripts/install-hooks.js 的 --verify 只读自检回归（审查 F6）：
// 默认路径里「跳过/未覆盖」（非 git 工作树、已有其它 core.hooksPath）一律 exit 0——自动化只能
// 靠解析 stdout 区分「装上了」与「跳过了」，无法用退出码判定门禁是否生效。--verify 提供显式的
// 只读查询：门禁此刻生效 → exit 0；否则 exit 1 并说明原因，且绝不写 core.hooksPath、绝不 chmod。
// 全部用例在 os.tmpdir() 里自建 git 仓库（隔离 HOME/全局与系统 gitconfig），不依赖本仓库的钩子状态
// （本机 /storage/emulated 是 noexec 挂载，本仓库的钩子本就没有执行位，不能作为夹具）。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const INSTALL_HOOKS = path.join(__dirname, 'scripts', 'install-hooks.js')

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

// 沙箱化 git 环境：HOME/XDG 指向临时目录，禁用全局与系统 gitconfig——否则开发机上的
// core.hooksPath 会泄漏进用例，让「未配置」用例假绿/假红。
function sandboxEnv (home) {
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
}

function runVerify (cwd, home) {
  return spawnSync(process.execPath, [INSTALL_HOOKS, '--verify'], { cwd, encoding: 'utf8', env: sandboxEnv(home) })
}

function runPlugin (cwd, home, args) {
  return spawnSync(process.execPath, [INSTALL_HOOKS, ...args], { cwd, encoding: 'utf8', env: sandboxEnv(home) })
}

function gitConfig (cwd, home, key) {
  return spawnSync(GIT, ['config', '--get', key], { cwd, encoding: 'utf8', env: sandboxEnv(home) })
}

function initRepo (dir, home) {
  const init = spawnSync(GIT, ['init', '-q'], { cwd: dir, encoding: 'utf8', env: sandboxEnv(home) })
  assert.strictEqual(init.status, 0, `git init 失败：${init.stderr}`)
}

function writeHooks (dir, names = ['pre-commit', 'commit-msg'], mode = 0o700) {
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
    writeHooks(dir, ['pre-commit', 'commit-msg'], 0o600)
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

console.log('✅ install-hooks --verify 只读自检：未生效 fail-closed / 生效 exit 0 / 不改配置不改权限')
