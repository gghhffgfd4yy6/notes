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
  // 审查 STG-06：显式 0o700（旧实现不传 mode，权限随 umask——022 下为 0755，与文件强制 0o600
  // 口径不一致；缓存目录首建即在此处，同机其他用户可进入目录并读取/替换缓存文件）。目录必须有
  // 执行位才能访问其中文件，0700 即 0600 的等价目录形态；mode 只在新建目录时生效，已存在的
  // 目录不做 chmod（不改动部署侧既有权限）。
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

// 尽力 fsync 父目录（审查 STG-04）：rename 的持久性要靠目录项的 fsync 才成立。
// 目录 fsync 在部分平台/FUSE 上不被支持（EINVAL/EPERM/EBADF），此处只告警不失败——
// 掉电持久性是尽力而为的加固，不应让一次成功的写入因目录 fsync 不可用而整体报失败。
function fsyncDirBestEffort (filePath) {
  const dir = path.dirname(filePath)
  let dfd
  try {
    dfd = fs.openSync(dir, 'r')
    fs.fsyncSync(dfd)
  } catch (e) {
    console.warn(`目录 fsync 失败（本次写入仍视为成功，掉电后可能丢失该次 rename）${dir}: ${e && e.code ? e.code : e.message}`)
  } finally {
    if (dfd !== undefined) { try { fs.closeSync(dfd) } catch (e) { /* 忽略 */ } }
  }
}

function writeAtomic (filePath, text, label = '缓存文件') {
  // 已知取舍（审查 2026-08-15，记录不修）：isRegularOrMissing 检查与 renameSync 之间、以及
  // cacheDir 的 realpath 校验与每次写入之间均存在 TOCTOU 窗口（校验时是普通文件/目录，窗口内被替换
  // 为符号链接时，rename 会替换链接本身不跟随，但中间目录若为链接可指向根外）。本模块自身只提供
  // 「末级 lstat + 唯一 tmp + 原子写」；basename 清洗在调用方（xbk_message_store.getFilePath /
  // xbk_app._writeRunLog），O_NOFOLLOW 只作用于 readSafeTextResult 的读路径，写路径不做路径清洗
  // 或目录包含校验（审查 STG-07：原注释把后两者记为本模块写路径的防御层，口径有误，已改正）。
  //
  // 审查 STG-04：写路径补 fsync——rename 之前先 fsync 临时文件，rename 之后尽力 fsync 父目录，
  // 使「原子写」在掉电场景也成立（此前只对进程崩溃成立）。fsync 失败不再静默：文件 fsync 失败
  // 走 catch → 删除 tmp 并返回 false（fail-closed，避免假装持久），目录 fsync 失败只告警。
  // 攻击者需先具备对项目根/缓存目录的写权限，风险等级低，接受现状（单实例 cron 信任本地文件系统）。
  if (!isRegularOrMissing(filePath)) {
    console.error(`拒绝写入非普通文件 ${label} ${filePath}`)
    return false
  }
  let tmpFile = ''
  let fd = -1
  try {
    ensureParent(filePath)
    // 每次使用唯一临时文件，避免预置/竞态 .tmp 符号链接；rename 替换目标本身不会跟随目标链接。
    // S2245：Math.random 伪随机可预测（临时文件路径防预置/竞态），改加密随机
    tmpFile = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
    fd = fs.openSync(tmpFile, 'wx', 0o600)
    fs.writeFileSync(fd, text, { encoding: 'utf8' })
    fs.fsyncSync(fd) // 内容先落盘，再 rename 提交
    fs.closeSync(fd)
    fd = -1
    fs.renameSync(tmpFile, filePath)
    tmpFile = ''
    fsyncDirBestEffort(filePath)
    return true
  } catch (e) {
    if (fd >= 0) { try { fs.closeSync(fd) } catch (e2) { /* 忽略 */ } }
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
    fs.fsyncSync(fd) // 与 writeAtomic 同口径：内容落盘后再视为初始化成功（审查 STG-04）
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
  // length 由调用方按 fstat 观测值算出（不是「读到 EOF」），故一次分配即可：
  // 分配的字节数永远不超过检查时看到的大小，不会因文件在窗口内膨胀而抬高峰值内存。
  const buf = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const read = fs.readSync(fd, buf, filled, length - filled, start + filled)
    if (read <= 0) break // 文件在读取期间被截短
    filled += read
  }
  return buf.subarray(0, filled).toString('utf8')
}

// maxBytes 入口校验（审查 STG-05）：合法输入只有两种——undefined（保持旧行为「不设限」）与
// 正的安全整数上限。其余（数字字符串、NaN、负数、0、Infinity、超安全整数）沿用「不设限」语义，
// 但必须告警：静默不设限会把调用方的限长意图悄悄变成整读入内存（本函数是安全读取入口）。
function resolveMaxBytes (maxBytes, filePath) {
  if (maxBytes === undefined) return null
  if (typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes > 0) return maxBytes
  console.warn(`readSafeTextResult: maxBytes 非法（${typeof maxBytes} ${String(maxBytes)}），上限未生效，按不设限读取 ${filePath}`)
  return null
}

// 可选大小上限：maxBytes 为数字且 > 0 时，普通文件超过该字节数即判 tooLarge，避免异常膨胀
// 文件被整读入内存（状态/哈希等小文件场景）。maxBytes 非数字或 ≤0 时按既有语义处理为「不设限」
// （但见 resolveMaxBytes：非法值一律告警，不再静默）。
// options.tail === true（审查 SS-03）：超限时读**尾部** maxBytes 字节而不是判 tooLarge——
// 日志类消费方（scripts/status.js 的 run.log / filter-diagnostics.ndjson）只关心最近记录，
// 而写入侧 fail-open 时日志可无上限增长，旧行为会让整个部件显示「不可读（tooLarge）」。
// 尾部读取的结果附 truncated:true：首行可能是被切开的半行，调用方须按「逐行解析、坏行跳过」处理。
function readSafeTextResult (filePath, maxBytes, options = {}) {
  // 修复 TOCTOU：先以 O_NOFOLLOW 打开并 fstat 确认为普通文件，读取内容后复检路径仍指向
  // 同一 inode（dev+ino）的普通文件。内容读取走同一 fd（readFdRange），读取期间路径被替换
  // 成符号链接/其他文件时，读后复检仍会将其判为 unsafe 并丢弃结果，不泄露任意文件内容。
  const limit = resolveMaxBytes(maxBytes, filePath)
  const tail = !!(options && options.tail === true)
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
    let start = 0
    if (limit !== null && stat.size > limit) {
      if (!tail) {
        return { status: 'tooLarge', text: null, error: new Error(`文件过大(${stat.size} 字节)，超过上限 ${limit} 字节`) }
      }
      start = stat.size - limit // 只读尾部 limit 字节（bound 仍由 fstat 观测值决定）
    }
    const text = readFdRange(fd, start, stat.size - start)
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
    return { status: 'ok', text, error: null, ...(start > 0 ? { truncated: true } : {}) }
  } catch (e) {
    return { status: 'ioError', text: null, error: e }
  } finally {
    try { fs.closeSync(fd) } catch (e) { /* 忽略 */ }
  }
}

// maxBytes / options 透传给 readSafeTextResult：不传时与旧行为完全一致（不设上限、超限判 tooLarge），
// 调用方可据此对这条读取入口显式设限（审查 STG-05：非法值由 readSafeTextResult 统一告警），
// 或以 options.tail 只读尾部（审查 SS-03）。
function readSafeText (filePath, maxBytes, options) {
  const result = readSafeTextResult(filePath, maxBytes, options)
  return result.status === 'ok' ? result.text : null
}

module.exports = { isRegularOrMissing, writeAtomic, writeAtomicIfAbsent, readSafeText, readSafeTextResult }
