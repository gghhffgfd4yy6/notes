'use strict'

// ============================================================
// 过滤规则覆盖文件族的路径构造（唯一职责，不含任何读写逻辑）。
//
// 为什么单独成模块：`FilterStore.filterRulesPaths(dir)` 的 4 个固定文件
// （filter-rules.json / .applied.json / .audit.ndjson / .lock）与按 revision
// 编号的备份文件，都是 `path.join(<运行期目录>, <本文件硬编码文件名>)` 形态。
// Codacy/Semgrep 的 path-traversal 规则对「非字面量首参 + path.join」一律报
// `dynamically constructs file or path information`，无法区分这里的目录来自
// 运行期配置而非 HTTP 输入。按仓库惯例（同 scripts/message-signature.js），
// 把这类纯路径构造抽到只做这件事的模块，只排除该模块，避免整文件排除
// xbk_filter_store.js 而把校验/降级等真实逻辑的告警一起静默。
//
// 安全事实（与排除理由一一对应）：
//   · dir 由调用方传入（控制台 stateDir / XBK_CACHE_DIR 解析结果 / 测试临时目录），
//     不来自任何请求体或 URL；
//   · 4 个文件名是本文件字面量常量，备份文件名里的 rev 先经 Number.isSafeInteger
//     + >=0 归一，非安全整数一律归 0（杜绝 revision 变成路径片段）；
//   · 本模块不做 fs 调用、不读文件内容、不抛错：非法 dir 退化为 '.'
//     （调用方本应传绝对路径；退化后写路径仍被下游 0600 原子写覆盖）。
// ============================================================

const path = require('path')

// 路径 helper 是纯函数、不得抛错：非法 cacheDir 退化为进程 CWD。
function resolveCacheDir (cacheDir) {
  return typeof cacheDir === 'string' && cacheDir !== '' ? cacheDir : '.'
}

/**
 * 覆盖文件族路径。console 阶段的锁/审计/备份流程复用同一套命名。
 * backupFor(rev)：`.bak.<rev>.json`（保留策略在 console 阶段实现）；
 * rev 只接受非负安全整数，其余一律归 0——防止 revision 变成路径穿越片段。
 */
function filterRulesPaths (cacheDir) {
  const dir = resolveCacheDir(cacheDir)
  return {
    file: path.join(dir, 'filter-rules.json'),
    applied: path.join(dir, 'filter-rules.applied.json'),
    audit: path.join(dir, 'filter-rules.audit.ndjson'),
    lock: path.join(dir, 'filter-rules.lock'),
    backupFor (rev) {
      const safeRev = Number.isSafeInteger(rev) && rev >= 0 ? rev : 0
      return path.join(dir, `filter-rules.bak.${safeRev}.json`)
    }
  }
}

module.exports = { filterRulesPaths, resolveCacheDir }
