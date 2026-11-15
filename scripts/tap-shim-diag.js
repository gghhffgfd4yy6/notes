'use strict'

// tap-shim 的诊断落盘（2026-11-15）：把被测测试文件自己的 stdout/stderr 另存一份，
// 供 CI 的 dry run 失败时定位是哪条断言。
//
// 为什么单独成文件：本模块的两处 fs 调用都是「运行期拼路径」（目录来自 XBK_TAP_LOG_DIR、
// 文件名来自被 spawn 的测试文件名）⇒ Codacy/Opengrep 的 pathtraversal-non-literal-fs-filename
// 必然命中。把它与 scripts/tap-shim.js 分开，是为了只登记这一层诊断代码、不牺牲 tap-shim
// 本体（TAP 投点/跳过判定/退出码）的 Codacy 覆盖——同 scripts/status-utils.js 的拆模块口径。
//
// 边界：只在该环境变量注入时启用；未注入（本地直跑、普通 CI 测试）不落任何文件。

const fs = require('fs')
const path = require('path')

// 文件名按白名单字符归一，避免把 argv 里的任意字符带进路径。
const safeName = (name) => String(name || 'unknown').replace(/[^\w.-]/g, '_')

function installTee (dir, fileName) {
  const target = path.join(dir, safeName(fileName) + '.log')
  fs.mkdirSync(dir, { recursive: true })
  const origErrWrite = process.stderr.write.bind(process.stderr)
  const origWriteSync = fs.writeSync
  const tee = (data) => {
    try {
      fs.appendFileSync(target, typeof data === 'string' ? data : Buffer.from(data))
    } catch { /* 写诊断失败不影响转发：诊断缺失不等于测试失败 */ }
  }
  process.stderr.write = function (chunk, encoding, callback) {
    tee(chunk)
    return origErrWrite(chunk, encoding, callback)
  }
  // 本仓 harness 大量用 fs.writeSync(1|2, …) 直写 fd（不经 process.stdout.write），
  // 只包 stream 会漏掉这些行——2026-11-15 实测：日志文件建出来了但一条 ❌ 都没有。
  fs.writeSync = function (fd, data, ...rest) {
    if (fd === 1 || fd === 2) tee(data)
    return origWriteSync.call(fs, fd, data, ...rest)
  }
  return target
}

module.exports = { installTee, safeName }
