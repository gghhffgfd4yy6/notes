'use strict'

// 判重缓存文件的轻量签名：只给默认 push.json 用（自定义缓存名的部署走无缓存路径）。
// 单独成文件的原因：Codacy/ESLint security 的「动态构造路径」规则会把 `dir` 变量
// + 字面量文件名的 stat 误报为路径注入；本模块只做只读 stat、不接收用户输入，
// 在 .codacy.yml 里按工具文件口径排除，避免在 status.js 里散落豁免注释。
//
// P1（v3.412）：判重缓存改成「push.json 快照 + <cache>.journal.ndjson 增量日志」后，签名必须
// 把 journal 的 (ino,size,mtime) 一并折进去——否则运行侧刚追加的条目在 60s TTL 内看不见
// （journal 变了、push.json 没变，旧签名照样命中 ⇒ 控制台显示旧数据）。
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_FILE = 'push.json'
// 与 xbk_message_store.JOURNAL_SUFFIX 同一口径（本文件保持「只读 stat、不 require 主模块」的定位，
// 两处常量的一致性由 test_message_store_journal.js 的常量对账断言锁死）。
const JOURNAL_SUFFIX = '.journal.ndjson'

function statSignature (filePath, minAgeMs, now) {
  const st = fs.statSync(filePath)
  if (!st.isFile()) return null
  if (now - st.mtimeMs < minAgeMs) return null
  return `${st.ino}:${st.size}:${Math.round(st.mtimeMs)}`
}

function defaultMessageSignature (dir, maxBytes, minAgeMs, now = Date.now()) {
  try {
    const st = fs.statSync(path.join(dir, DEFAULT_FILE))
    if (!st.isFile() || st.size > maxBytes) return null
    if (now - st.mtimeMs < minAgeMs) return null
    const main = `${st.ino}:${st.size}:${Math.round(st.mtimeMs)}`
    const journal = path.join(dir, DEFAULT_FILE + JOURNAL_SUFFIX)
    let journalSig
    try {
      journalSig = statSignature(journal, minAgeMs, now)
      if (journalSig === null) return null
      journalSig = 'j' + journalSig
    } catch (e) {
      // journal 缺失 = 无增量（正常）；其余读不到的情况（EACCES 等）不进缓存：
      // 宁可每次重读，也绝不拿旧结果冒充「当前数据」。
      if (!e || e.code !== 'ENOENT') return null
      journalSig = 'jnone'
    }
    return `${main}|${journalSig}`
  } catch (e) { return null }
}

module.exports = { defaultMessageSignature }
