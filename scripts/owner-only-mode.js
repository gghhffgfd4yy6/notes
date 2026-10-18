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
// ============================================================

const fs = require('fs')

const OWNER_ONLY_MODE = 0o600
const GROUP_OTHER_BITS = 0o077

function safeErrorMessage (err) {
  if (!err) return '未知错误'
  return typeof err.message === 'string' && err.message ? err.message : String(err)
}

/**
 * 把已存在的文件收紧到 0600。
 * @param {string} file 状态目录内的固定文件（见模块头部的安全事实）
 * @returns {{ok:true, tightened:boolean}|{ok:false, message:string}}
 */
function enforceOwnerOnlyMode (file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (e) {
    // 读成功后 stat 仍失败（并发删除/替换）：无法确认权限 ⇒ 按损坏降级。
    return { ok: false, message: `覆盖文件无法确认权限（${safeErrorMessage(e)}）` }
  }
  const mode = stat.mode & 0o777
  if ((mode & GROUP_OTHER_BITS) === 0) return { ok: true, tightened: false }
  try {
    fs.chmodSync(file, OWNER_ONLY_MODE)
  } catch (e) {
    return { ok: false, message: `覆盖文件权限过宽（0${mode.toString(8)}）且无法收紧到 0600：${safeErrorMessage(e)}` }
  }
  return { ok: true, tightened: true }
}

module.exports = { enforceOwnerOnlyMode, OWNER_ONLY_MODE, GROUP_OTHER_BITS }
