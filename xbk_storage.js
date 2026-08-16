'use strict'

// 统一安全文件入口：状态、日志和消息缓存都通过同一套普通文件检查与原子写入。
const fs = require('fs')
const path = require('path')
const crypto = require('node:crypto')

function isRegularOrMissing (filePath) {
  if (typeof filePath !== 'string') {
    console.warn(`isRegularOrMissing: filePath 非字符串(${typeof filePath})，视为不安全，拒绝`)
    return false
  }
  try { return fs.lstatSync(filePath).isFile() } catch (e) {
    if (e && e.code === 'ENOENT') return true
    const detail = e && e.code ? `${e.code}` : (e && e.message ? e.message : String(e))
    console.warn(`isRegularOrMissing: 检查 ${filePath} 读取异常(${detail})，视为不安全，拒绝`)
    return false
  }
}

function ensureParent (filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeAtomic (filePath, text, label = '缓存文件') {
  // 已知取舍（审查 2026-08-15，记录不修）：isRegularOrMissing 检查与 renameSync 之间、以及
  // cacheDir 的 realpath 校验与每次写入之间均存在 TOCTOU 窗口（校验时是普通文件/目录，窗口内被替换
  // 为符号链接时，rename 会替换链接本身不跟随，但中间目录若为链接可指向根外）。已属多层防御
  // （basename 清洗 + O_NOFOLLOW 读 + 原子写 + 唯一 tmp），攻击者需先具备对项目根/缓存目录的写权限，
  // 风险等级低，接受现状（单实例 cron 信任本地文件系统）。
  if (!isRegularOrMissing(filePath)) {
    console.error(`拒绝写入非普通文件 ${label} ${filePath}`)
    return false
  }
  let tmpFile = ''
  try {
    ensureParent(filePath)
    // 每次使用唯一临时文件，避免预置/竞态 .tmp 符号链接；rename 替换目标本身不会跟随目标链接。
    // S2245：Math.random 伪随机可预测（临时文件路径防预置/竞态），改加密随机
    tmpFile = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
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

function writeAtomicIfAbsent (filePath, text, label = '缓存初始化') {
  // v3.263（CodeAnt）：独占创建（wx）——仅当文件不存在时才写入。writeAtomic 的 tmp+rename 会
  // 无条件替换目标文件，初始化场景若在检查与写入之间另一进程已创建有效缓存，会把新文件覆盖成
  // [] 丢失判重记录；wx 语义下并发创建只会得到 EEXIST，视为初始化成功不覆盖。
  if (!isRegularOrMissing(filePath)) {
    console.error(`拒绝写入非普通文件 ${label} ${filePath}`)
    return false
  }
  try {
    ensureParent(filePath)
    fs.writeFileSync(filePath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return true
  } catch (e) {
    if (e?.code === 'EEXIST') return true // 另一进程已创建：不覆盖，视为初始化成功
    console.error(`${label}写入失败 ${filePath}:`, e.message)
    return false
  }
}

// 可选大小上限：maxBytes > 0 时，普通文件超过该字节数即判 tooLarge，避免异常膨胀
// 文件被整读入内存（状态/哈希等小文件场景）。
function readSafeTextResult (filePath, maxBytes) {
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
    if (typeof maxBytes === 'number' && maxBytes > 0 && stat.size > maxBytes) {
      return { status: 'tooLarge', text: null, error: new Error(`文件过大(${stat.size} 字节)，超过上限 ${maxBytes} 字节`) }
    }
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

module.exports = { isRegularOrMissing, writeAtomic, writeAtomicIfAbsent, readSafeText, readSafeTextResult }
