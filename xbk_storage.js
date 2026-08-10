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
  // 修复 TOCTOU：先以 O_NOFOLLOW 打开并 fstat 确认为普通文件，读取后复检路径仍指向
  // 同一 inode（dev+ino）的普通文件。路径读取（保持既有故障注入兼容）后若被替换成
  // 符号链接/其他文件，读后复检会将其判为 unsafe 并丢弃结果，不再泄露任意文件内容。
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  let fd
  try {
    fd = fs.openSync(filePath, flags)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', text: null, error: e }
    if (e && e.code === 'ELOOP') return { status: 'unsafe', text: null, error: new Error('非普通文件') }
    return { status: 'ioError', text: null, error: e }
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return { status: 'unsafe', text: null, error: new Error('非普通文件') }
    const text = fs.readFileSync(filePath, 'utf8')
    let reFd
    try {
      reFd = fs.openSync(filePath, flags)
      const reStat = fs.fstatSync(reFd)
      if (!reStat.isFile() || reStat.dev !== stat.dev || reStat.ino !== stat.ino) {
        return { status: 'unsafe', text: null, error: new Error('文件读取期间被替换') }
      }
    } catch (e) {
      if (e && (e.code === 'ELOOP' || e.code === 'ENOENT')) return { status: 'unsafe', text: null, error: new Error('非普通文件') }
      return { status: 'ioError', text: null, error: e }
    } finally {
      if (reFd !== undefined) { try { fs.closeSync(reFd) } catch (e) { /* 忽略 */ } }
    }
    return { status: 'ok', text, error: null }
  } catch (e) {
    return { status: 'ioError', text: null, error: e }
  } finally {
    try { fs.closeSync(fd) } catch (e) { /* 忽略 */ }
  }
}

function readSafeText (filePath) {
  const result = readSafeTextResult(filePath)
  return result.status === 'ok' ? result.text : null
}

module.exports = { isRegularOrMissing, writeAtomic, readSafeText, readSafeTextResult }
