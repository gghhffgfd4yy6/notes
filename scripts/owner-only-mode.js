'use strict'

// ============================================================
// 状态文件权限收紧（唯一职责：把调用方给定的文件收紧到 0600）。
//
// 为什么单独成模块：`xbk_filter_store.js` 读覆盖文件前要把外部工具/手工创建时
// 留下的 group/other 位收紧（A3）。Codacy/Semgrep 的 path-traversal 规则对
// 「非字面量首参的 fs 调用」一律报 `dynamically constructs file or path
// information`，无法区分这里的路径来自运行期状态目录而非 HTTP 输入。按仓库
// 惯例（同 scripts/filter-rules-paths.js），把这类只做一件事的 fs 助手抽出来，
// 只排除该模块，避免整文件排除 xbk_filter_store.js 而把校验/降级等真实逻辑
// 的告警一起静默。
//
// 安全事实：入参只来自 FilterStore 的 filterRulesPaths(cacheDir).file —— 目录由
// 调用方（控制台 stateDir / XBK_CACHE_DIR / 测试临时目录）传入，文件名是本仓
// 字面量常量；不接受请求体/URL 拼出的路径。本模块只 stat + chmod，不读内容。
//
// 但是「路径来自内部」不等于「路径上的节点不可被替换」：状态目录可写者（同机其它
// 进程/账号，或未来的多租户部署）能在读与收紧之间把该路径换成符号链接，而按路径
// 的 stat/chmod 都会跟随链接 —— 收紧动作就落到链接目标上，改的是别人的权限位
// （C10-019）。故本模块以 O_NOFOLLOW 打开、按 fd 确认普通文件、再对比路径的
// inode，最后只在这个**已校验的 fd** 上 fchmod 并按同一 fd 复检位宽：检查完成到
// 写入之间路径即使被换掉，改的也只是「刚打开并校验过的那份 inode」，链接目标与
// 别人的文件一律碰不到（同仓 scripts/console.js:2070/2285 的 O_NOFOLLOW + fchmod 范式）。
// ============================================================

const fs = require('fs')

const OWNER_ONLY_MODE = 0o600
const GROUP_OTHER_BITS = 0o077
// O_NOFOLLOW 在 Windows 上不存在：此时退化为 0（由下方 lstat 的符号链接判断兜底）。
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0
// O_NONBLOCK（评审 CR-09）：末级若被换成 FIFO，裸 O_RDONLY open 会**阻塞到有写者打开**——
// O_NOFOLLOW 只挡符号链接，挡不住 FIFO；而 fstatSync().isFile() 要等 open 返回才跑，永远没机会
// 拒绝。加 O_NONBLOCK 后 FIFO 的 open 立刻返回（无写者时读端也照样返回，随后被 isFile() 判掉），
// 整轮运行不再挂死；对普通文件没有任何影响（它只影响 FIFO/设备节点的打开语义）。Windows 上没有
// 这个常量，同样退化为 0。
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0

function safeErrorMessage (err) {
  if (!err) return '未知错误'
  return typeof err.message === 'string' && err.message ? err.message : String(err)
}

/**
 * 把已存在的**普通文件**收紧到 0600；符号链接一律拒绝（绝不改链接目标的权限）。
 * @param {string} file 状态目录内的固定文件（见模块头部的安全事实）
 * @returns {{ok:true, tightened:boolean}|{ok:false, message:string}}
 */
function enforceOwnerOnlyMode (file) {
  let fd
  try {
    // O_NOFOLLOW：末级是符号链接时 open 直接 ELOOP，从源头上不跟随。
    // O_NONBLOCK：末级是 FIFO 时让 open 立刻返回（读端无写者也照样返回），随后被 isFile() 判掉。
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (e && e.code === 'ELOOP') {
      return { ok: false, message: '覆盖文件是符号链接，拒绝按路径收紧权限（这会改到链接目标）' }
    }
    // 读成功后 open 仍失败（并发删除/替换/权限变化）：无法确认权限 ⇒ 按损坏降级。
    return { ok: false, message: `覆盖文件无法确认权限（${safeErrorMessage(e)}）` }
  }
  try {
    let fdStat
    let pathStat
    try {
      fdStat = fs.fstatSync(fd)
      pathStat = fs.lstatSync(file)
    } catch (e) {
      return { ok: false, message: `覆盖文件无法确认权限（${safeErrorMessage(e)}）` }
    }
    // 三重确认「路径此刻指向的就是我们打开的这个普通文件」：非普通文件、路径已是链接、
    // 或 inode 不符（打开后被原子替换）都拒绝，不去碰任何目标。
    if (!fdStat.isFile() || pathStat.isSymbolicLink() || pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      return { ok: false, message: '覆盖文件不是稳定的普通文件（符号链接/类型变化/读取期间被替换），拒绝收紧权限' }
    }
    const mode = fdStat.mode & 0o777
    if ((mode & GROUP_OTHER_BITS) === 0) return { ok: true, tightened: false }
    try {
      // 只按 fd 改（C10-019）：路径在 lstat 校验之后被换成符号链接/别人的文件时，
      // chmodSync(file) 会跟随链接改到目标上；fchmodSync 作用于上面校验过的这份 inode。
      fs.fchmodSync(fd, OWNER_ONLY_MODE)
    } catch (e) {
      return { ok: false, message: `覆盖文件权限过宽（0${mode.toString(8)}）且无法收紧到 0600：${safeErrorMessage(e)}` }
    }
    // 按 fd 复检：这一份 inode 的位宽真的被收窄了吗？写入不生效（只读挂载/文件系统
    // 不认 mode）时这里会看到位宽未变 ⇒ 报失败，而不是把「没改成」说成「已收紧」。
    let after
    try {
      after = fs.fstatSync(fd).mode & 0o777
    } catch (e) {
      return { ok: false, message: `覆盖文件收紧后无法复检权限（${safeErrorMessage(e)}）` }
    }
    if ((after & GROUP_OTHER_BITS) !== 0) {
      return { ok: false, message: `覆盖文件权限过宽（0${mode.toString(8)}）且收紧后复检仍为 0${after.toString(8)}：该 fd 的位宽未被改写` }
    }
    return { ok: true, tightened: true }
  } finally {
    try { fs.closeSync(fd) } catch (e) { /* 忽略关闭失败 */ }
  }
}

module.exports = { enforceOwnerOnlyMode, OWNER_ONLY_MODE, GROUP_OTHER_BITS }
