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
  // 空串是非法路径：lstatSync('') 抛 ENOENT 会被下面的 catch 判为「文件不存在=安全」，
  // 从而让 writeAtomic 以空 filePath 在进程 CWD 落一个含 payload 的临时文件（审查 STG-03）。
  // 显式拒绝，避免安全入口给出「可用」的假信号。
  if (filePath === '') {
    console.warn('isRegularOrMissing: filePath 为空串，视为不安全，拒绝')
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
  // 已知口径差（审查 STG-06，记录不修）：不传 mode，目录权限随 umask（022 下为 0755），
  // 与本模块文件强制 0o600 不一致；缓存目录首建即在此处，是否收紧到 0o700 属权限模型决策，
  // 不在本轮范围。
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeAtomic (filePath, text, label = '缓存文件') {
  // 已知取舍（审查 2026-08-15，记录不修）：isRegularOrMissing 检查与 renameSync 之间、以及
  // cacheDir 的 realpath 校验与每次写入之间均存在 TOCTOU 窗口（校验时是普通文件/目录，窗口内被替换
  // 为符号链接时，rename 会替换链接本身不跟随，但中间目录若为链接可指向根外）。本模块自身只提供
  // 「末级 lstat + 唯一 tmp + 原子写」；basename 清洗在调用方（xbk_message_store.getFilePath /
  // xbk_app._writeRunLog），O_NOFOLLOW 只作用于 readSafeTextResult 的读路径，写路径不做路径清洗
  // 或目录包含校验（审查 STG-07：原注释把后两者记为本模块写路径的防御层，口径有误，已改正）。
  //
  // 另：写路径不含 fsync（文件与父目录），rename 的原子性只保证不出现半写文件，不保证掉电后持久性；
  // 该取舍已在 SYSTEM_CONTRACT.md「原子写不含 fsync」记录（审查 STG-04，记录不修）。
  // 攻击者需先具备对项目根/缓存目录的写权限，风险等级低，接受现状（单实例 cron 信任本地文件系统）。
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
  //
  // 审查 STG-02：wx 直写真实路径没有原子提交点（无 tmp+rename），写入中断会在缓存路径留下半写
  // 文件；而消费侧 xbk_message_store._ensureFileExists 以 existsSync 早退，残骸于是永久不自愈。
  // 本机 FUSE 不支持硬链接（linkSync EACCES），无法用「tmp + link 提交」补齐原子性，故此处修
  // 可控的一半：以 wx 打开确认「文件由本次调用创建」后，任何写失败都在 catch 里删除该残骸，
  // 让下次调用（或下次 existsSync 判定）能重新初始化，而不是把坏文件当成「已初始化」。
  if (!isRegularOrMissing(filePath)) {
    console.error(`拒绝写入非普通文件 ${label} ${filePath}`)
    return false
  }
  let fd = -1
  try {
    ensureParent(filePath)
    // wx 打开成功即证明该文件由本次调用创建；EEXIST 时 openSync 抛错、fd 仍为 -1，不会误删他人文件。
    fd = fs.openSync(filePath, 'wx', 0o600)
    fs.writeFileSync(fd, text, { encoding: 'utf8' })
    return true
  } catch (e) {
    if (e?.code === 'EEXIST') return true // 另一进程已创建：不覆盖，视为初始化成功
    if (fd >= 0) {
      // 清理半写残骸（可能是本次写入的部分内容，也可能是空文件）；失败只告警，不影响返回语义。
      try { fs.unlinkSync(filePath) } catch (e2) { console.warn(`${label}半写残骸清理失败 ${filePath}:`, e2.message) }
    }
    console.error(`${label}写入失败 ${filePath}:`, e.message)
    return false
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd) } catch (e) { /* 忽略 */ } }
  }
}

// 从已打开的 fd 读取 [start, start+length) 区间（审查 STG-01）。
// 旧实现对 fd 只做 fstat/复检，内容却按路径 readFileSync(filePath) 整读——检查看到的 size 与
// 实际读到的字节数没有任何约束关系（同 inode 就地 append 即可在读窗口内绕过 maxBytes，
// 路径被换成更大的文件时也会先整读进内存）。改为同一 fd 上有界读取：读取长度由调用方按
// fstat 观测值算出，读到的字节数永远不超过检查时看到的大小。
function readFdRange (fd, start, length) {
  const chunks = []
  const CHUNK = 64 * 1024
  let pos = start
  let remaining = length
  while (remaining > 0) {
    const size = Math.min(CHUNK, remaining)
    const buf = Buffer.allocUnsafe(size)
    const read = fs.readSync(fd, buf, 0, size, pos)
    if (read <= 0) break
    chunks.push(buf.subarray(0, read))
    pos += read
    remaining -= read
  }
  return Buffer.concat(chunks).toString('utf8')
}

// 可选大小上限：maxBytes 为数字且 > 0 时，普通文件超过该字节数即判 tooLarge，避免异常膨胀
// 文件被整读入内存（状态/哈希等小文件场景）。maxBytes 非数字或 ≤0 时按既有语义处理为「不设限」。
function readSafeTextResult (filePath, maxBytes) {
  // 修复 TOCTOU：先以 O_NOFOLLOW 打开并 fstat 确认为普通文件，读取内容后复检路径仍指向
  // 同一 inode（dev+ino）的普通文件。内容读取走同一 fd（readFdRange），读取期间路径被替换
  // 成符号链接/其他文件时，读后复检仍会将其判为 unsafe 并丢弃结果，不泄露任意文件内容。
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
    const text = readFdRange(fd, 0, stat.size)
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

// maxBytes 透传给 readSafeTextResult：不传时与旧行为完全一致（不设上限），
// 调用方可据此对这条读取入口显式设限（审查 STG-05）。
function readSafeText (filePath, maxBytes) {
  const result = readSafeTextResult(filePath, maxBytes)
  return result.status === 'ok' ? result.text : null
}

module.exports = { isRegularOrMissing, writeAtomic, writeAtomicIfAbsent, readSafeText, readSafeTextResult }
