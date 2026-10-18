'use strict'

// 判重缓存文件的轻量签名：只给默认 push.json 用（自定义缓存名的部署走无缓存路径）。
// 单独成文件的原因：Codacy/ESLint security 的「动态构造路径」规则会把 `dir` 变量
// + 字面量文件名的 stat 误报为路径注入；本模块只做只读 stat、不接收用户输入，
// 在 .codacy.yml 里按工具文件口径排除，避免在 status.js 里散落豁免注释。
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_FILE = 'push.json'

function defaultMessageSignature (dir, maxBytes, minAgeMs, now = Date.now()) {
  try {
    const st = fs.statSync(path.join(dir, DEFAULT_FILE))
    if (!st.isFile() || st.size > maxBytes) return null
    if (now - st.mtimeMs < minAgeMs) return null
    return `${st.ino}:${st.size}:${Math.round(st.mtimeMs)}`
  } catch (e) { return null }
}

module.exports = { defaultMessageSignature }
