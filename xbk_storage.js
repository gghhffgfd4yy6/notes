'use strict'

// 统一安全文件入口：状态、日志和消息缓存都通过同一套普通文件检查与原子写入。
const fs = require('fs')
const path = require('path')

function isRegularOrMissing (filePath) {
  try { return fs.lstatSync(filePath).isFile() } catch (e) { return e && e.code === 'ENOENT' }
}

function ensureParent (filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeAtomic (filePath, text, label = '缓存文件') {
  if (!isRegularOrMissing(filePath)) {
    console.error(`拒绝写入非普通文件 ${label} ${filePath}`)
    return false
  }
  let tmpFile = ''
  try {
    ensureParent(filePath)
    // 每次使用唯一临时文件，避免预置/竞态 .tmp 符号链接；rename 替换目标本身不会跟随目标链接。
    tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    fs.writeFileSync(tmpFile, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.renameSync(tmpFile, filePath)
    tmpFile = ''
    return true
  } catch (e) {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile) } catch (e2) { /* 忽略清理失败 */ }
    }
    console.error(`${label}写入失败 ${filePath}:`, e.message)
    return false
  }
}

function readSafeTextResult (filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', text: null, error: e }
    return { status: 'ioError', text: null, error: e }
  }
  if (!stat.isFile()) return { status: 'unsafe', text: null, error: new Error('非普通文件') }
  try {
    return { status: 'ok', text: fs.readFileSync(filePath, 'utf8'), error: null }
  } catch (e) {
    return { status: 'ioError', text: null, error: e }
  }
}

function readSafeText (filePath) {
  const result = readSafeTextResult(filePath)
  return result.status === 'ok' ? result.text : null
}

module.exports = { isRegularOrMissing, writeAtomic, readSafeText, readSafeTextResult }
