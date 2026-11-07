'use strict'

// 日志按周归档（v3.403）：run.log / filter-diagnostics.ndjson
//
// 设计（与用户约定）：
//   - 两个日志各自上限 100MB；
//   - 自然周（周一 00:00 Asia/Shanghai）切档：旧档压成多成员 gzip（.log.gz），
//     同时落一份 .idx.json 记录「每个 gzip 成员的压缩偏移/长度/行数」与总行数；
//   - 控制台读档时只解压「目标页所在的那一个成员」，首屏与翻页都不整份解压；
//   - 保留一年由调用方按周清理（pruneArchives）。
//
// 安全/一致性要点（Sourcery/CodeQL 评审后加固）：
//   - 所有 open 走 O_NOFOLLOW + fstat 常规文件校验：日志路径被换成符号链接/FIFO 时不跟。
//   - 归档写入用 O_EXCL 临时文件 + rename；索引先写 .tmp 再 rename；没有索引的 gz
//     对控制台不可见（listArchives 过滤），避免把半成品当成品读。
//   - 切档顺序：发布 gz → 发布 idx → 写「新周」标记 → 截断明文。标记写失败就抛错、
//     不截断：宁可下次重复归档，也不丢上一周的数据。
//   - 读完到截断之间若有 fail-open 写者追加，把追加段搬回文件开头再截断，不吞这几行。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const DAY_MS = 24 * 3600 * 1000
const CST_OFFSET_MS = 8 * 3600 * 1000
const CHUNK_BYTES = 1024 * 1024 // 每个 gzip 成员对应约 1MiB 原文
const PLAIN_INDEX_STEP = 2000 // 明文档索引：每 2000 行记一个字节偏移
const ARCHIVE_DIR = 'logs'
const KEEP_WEEKS = 53 // 一年（含跨年那一周）
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0

function cstDate (ts) {
  return new Date((ts == null ? Date.now() : ts) + CST_OFFSET_MS)
}

function pad2 (n) { return n < 10 ? '0' + n : String(n) }

function ymd (d) {
  return String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
}

// 自然周：周一 00:00:00.000 ~ 周日 23:59:59.999（CST）
function weekRange (ts) {
  const now = cstDate(ts)
  const dow = now.getUTCDay() // 0=周日
  const back = dow === 0 ? 6 : dow - 1
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - back * DAY_MS)
  const sunday = new Date(monday.getTime() + 6 * DAY_MS)
  return { start: ymd(monday), end: ymd(sunday), key: ymd(monday) + '-' + ymd(sunday) }
}

function archiveDir (cacheDir) {
  return path.join(cacheDir, ARCHIVE_DIR) // nosemgrep（路径=固定缓存目录+固定子目录）
}

function baseOf (fileName) {
  return fileName === 'run.log' ? 'run' : 'diag'
}

function archivePath (cacheDir, fileName, key) {
  return path.join(archiveDir(cacheDir), baseOf(fileName) + '-' + key + '.log.gz') // nosemgrep（key 由 weekRange 生成/白名单正则校验）
}

function weekMarkerPath (logPath) {
  return logPath + '.week'
}

// 只读/读写打开：O_NOFOLLOW + fstat 常规文件校验（符号链接、FIFO、设备、目录一律拒绝）。
function openLog (logPath, writable) {
  const flags = (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | O_NOFOLLOW
  const fd = fs.openSync(logPath, flags) // nosemgrep（logPath = 缓存目录 + 白名单日志名）
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' })
    return { fd, size: st.size, writable }
  } catch (e) {
    try { fs.closeSync(fd) } catch (err) {}
    throw e
  }
}

// 一次 writeSync 可能短写（磁盘满/被信号打断）；循环写完，短写不当作成功。
function writeAllSync (fd, buf) {
  let off = 0
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off)
    if (!(n > 0)) throw Object.assign(new Error('short write'), { code: 'ESHORT' })
    off += n
  }
}

function writeAtomic (filePath, data) {
  const tmp = filePath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600) // nosemgrep（tmp 由目标路径 + pid + 随机后缀构成）
  try {
    writeAllSync(fd, Buffer.from(data, 'utf8'))
    fs.fsyncSync(fd)
  } finally { try { fs.closeSync(fd) } catch (e) {} }
  fs.renameSync(tmp, filePath) // nosemgrep（目标=白名单日志名；tmp 同目录随机后缀）
}

function fsyncDirBestEffort (dir) {
  try {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY) // nosemgrep（dir=缓存目录/logs）
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (e) { /* 部分文件系统不支持目录 fsync */ }
}

function readMarker (logPath) {
  try {
    const v = fs.readFileSync(weekMarkerPath(logPath), 'utf8').trim() // nosemgrep（路径=白名单日志名 + .week）
    return /^\d{8}-\d{8}$/.test(v) ? v : ''
  } catch (e) { return '' }
}

// 切档：把上一周（prevKey）的明文压成「多成员 gz + idx」，写新周标记（nextKey），再截断明文。
// 调用方必须已持有该日志的写锁；崩溃/失败时绝不先截断（数据留在明文里，下一轮重试）。
function sealLog (logPath, cacheDir, prevKey, nextKey) {
  const dir = archiveDir(cacheDir)
  fs.mkdirSync(dir, { recursive: true }) // nosemgrep（固定子目录）
  const outPath = archivePath(cacheDir, path.basename(logPath), prevKey)
  // 同名归档已存在（上次崩在「发布后、写标记前」）：不覆盖已有数据，交给下一轮。
  try { if (fs.existsSync(outPath)) return null } catch (e) {} // nosemgrep（outPath=缓存目录/logs + 白名单周键）

  let opened
  try { opened = openLog(logPath, true) } catch (e) {
    try { opened = openLog(logPath, false) } catch (err) { return null }
  }
  const fdIn = opened.fd
  const writable = opened.writable
  if (!opened.size) {
    try { writeAtomic(weekMarkerPath(logPath), nextKey) } catch (e) {}
    try { fs.closeSync(fdIn) } catch (e) {}
    return null
  }

  const tmpPath = outPath + '.tmp'
  const idx = { key: prevKey, base: baseOf(path.basename(logPath)), source: path.basename(logPath), members: [], lines: 0, bytes: 0 }
  let fdOut = null
  let readTo = 0
  try {
    fdOut = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600) // nosemgrep（路径=缓存目录 + 白名单周键）
    const buf = Buffer.alloc(CHUNK_BYTES)
    let carry = Buffer.alloc(0)
    let compOff = 0
    for (;;) {
      const n = fs.readSync(fdIn, buf, 0, CHUNK_BYTES, readTo)
      if (n <= 0) break
      readTo += n
      const chunk = carry.length ? Buffer.concat([carry, buf.slice(0, n)]) : buf.slice(0, n)
      let cut = chunk.length
      const nl = chunk.lastIndexOf(0x0a)
      if (nl >= 0) cut = nl + 1
      const take = chunk.slice(0, cut)
      carry = chunk.slice(cut)
      if (!take.length) continue
      const gz = zlib.gzipSync(take, { level: 6 })
      writeAllSync(fdOut, gz)
      const lines = take.toString('utf8').split('\n').length - 1
      idx.members.push({ off: compOff, len: gz.length, lines })
      idx.lines += lines
      idx.bytes += take.length
      compOff += gz.length
    }
    if (carry.length) {
      // 末尾没有换行的那一行也要归档、也要算行数（否则翻页会漏最后一条）。
      const gz = zlib.gzipSync(carry, { level: 6 })
      writeAllSync(fdOut, gz)
      idx.members.push({ off: compOff, len: gz.length, lines: 1, tail: true })
      idx.lines += 1
      idx.bytes += carry.length
      compOff += gz.length
    }
    fs.fsyncSync(fdOut)
  } catch (e) {
    try { fs.closeSync(fdIn) } catch (err) {}
    if (fdOut !== null) { try { fs.closeSync(fdOut) } catch (err) {} }
    try { fs.unlinkSync(tmpPath) } catch (err) {} // nosemgrep（tmpPath 同上，仅清理自己的临时文件）
    throw e
  }
  try { fs.closeSync(fdOut) } catch (e) {}

  // 发布：gz → idx（两者都在才算成品；listArchives 只认带 idx 的 gz）。
  fs.renameSync(tmpPath, outPath) // nosemgrep（路径=缓存目录 + 白名单周键）
  writeAtomic(outPath + '.idx.json', JSON.stringify(idx))
  fsyncDirBestEffort(dir)

  // 标记先落到「新周」再截断：标记写失败抛错、明文保持原样（重复归档好过丢数据）。
  writeAtomic(weekMarkerPath(logPath), nextKey)

  // 读完到截断之间可能有 fail-open 写者追加：把 [readTo, size) 搬回文件开头再截断。
  try {
    const st = fs.fstatSync(fdIn)
    let keepLen = 0
    if (writable && st.size > readTo) {
      const extra = Buffer.alloc(st.size - readTo)
      let got = 0
      while (got < extra.length) {
        const n = fs.readSync(fdIn, extra, got, extra.length - got, readTo + got)
        if (n <= 0) break
        got += n
      }
      let off = 0
      while (off < got) {
        const n = fs.writeSync(fdIn, extra, off, got - off, off)
        if (!(n > 0)) break
        off += n
      }
      keepLen = off
    }
    if (writable) fs.ftruncateSync(fdIn, keepLen)
  } catch (e) {
    // 截断失败不影响归档（数据已在 gz 里），下一轮会再试。
  } finally {
    try { fs.closeSync(fdIn) } catch (e) {}
  }
  return { path: outPath, lines: idx.lines, bytes: idx.bytes }
}

// 明文档的字节偏移索引（每 PLAIN_INDEX_STEP 行一条）。
// run.log 每几秒追加一行，按 mtime 失效会让每次翻页重扫 100MB；追加只增长尾部、已有行
// 偏移不变 ⇒ 索引按「已扫到的字节数」增量延伸。截断后又长回同样长度时靠「尾部指纹」识别
// 并整份重建（否则会拿旧偏移读新内容）。
const plainIdxCache = new Map()

function plainIndexPath (logPath) { return logPath + '.idx.json' }

function tailHash (fd, end) {
  if (end <= 0) return ''
  const from = Math.max(0, end - 256)
  const buf = Buffer.alloc(end - from)
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, from)
    return crypto.createHash('sha1').update(buf.slice(0, n)).digest('hex').slice(0, 16)
  } catch (e) { return '' }
}

// 行数口径：换行数 + 「末尾没有换行的那一行」（有则 +1）。增量扫描时沿用上一轮的
// nl/partial，避免把同一条尾行重复计数。
function scanIntoFd (idx, fd, from, to) {
  const buf = Buffer.alloc(4 * 1024 * 1024)
  let pos = from
  let lastByte = -1
  while (pos < to) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos)
    if (n <= 0) break
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0x0a) {
        idx.nl += 1
        if (idx.nl - idx.lastMark >= PLAIN_INDEX_STEP) {
          idx.entries.push({ line: idx.nl, off: pos + i + 1 })
          idx.lastMark = idx.nl
        }
      }
    }
    lastByte = buf[n - 1]
    pos += n
  }
  if (lastByte >= 0) idx.partial = lastByte !== 0x0a
  idx.lines = idx.nl + (idx.partial ? 1 : 0)
  idx.size = pos
}

function loadPlainIndexFd (fd, logPath, size) {
  let idx = plainIdxCache.get(logPath)
  if (!idx) {
    try {
      const disk = JSON.parse(fs.readFileSync(plainIndexPath(logPath), 'utf8')) // nosemgrep（路径=白名单日志名 + .idx.json）
      if (disk && Array.isArray(disk.entries) && disk.size <= size) {
        idx = { size: disk.size, nl: disk.nl != null ? disk.nl : Math.max(0, disk.lines - (disk.partial ? 1 : 0)), partial: !!disk.partial, lines: disk.lines, lastMark: disk.nl != null ? disk.nl : disk.lines, entries: disk.entries, tail: disk.tail || '' }
      }
    } catch (e) {}
  }
  // 只有「前缀没变」才复用：大小不小于旧索引，且旧索引末尾 256 字节的指纹仍一致。
  if (idx && size >= idx.size && (idx.size === 0 || idx.tail === tailHash(fd, idx.size))) {
    if (size > idx.size) {
      const before = idx.size
      scanIntoFd(idx, fd, idx.size, size)
      idx.tail = tailHash(fd, idx.size)
      idx.size = size
      if (idx.size < before) idx.size = before
    }
  } else {
    idx = { size: 0, nl: 0, partial: false, lines: 0, lastMark: 0, entries: [{ line: 0, off: 0 }], tail: '' }
    scanIntoFd(idx, fd, 0, size)
    idx.tail = tailHash(fd, idx.size)
  }
  plainIdxCache.set(logPath, idx)
  return idx
}

function loadPlainIndex (logPath) {
  const o = openLog(logPath, false)
  try {
    return loadPlainIndexFd(o.fd, logPath, o.size)
  } finally { try { fs.closeSync(o.fd) } catch (e) {} }
}

function readPlainPage (logPath, page, size) {
  const o = openLog(logPath, false)
  const fd = o.fd
  try {
    const idx = loadPlainIndexFd(fd, logPath, o.size)
    const total = idx.lines
    const pages = Math.max(1, Math.ceil(total / size))
    const p = Math.min(Math.max(1, page), pages)
    const startLine = (p - 1) * size
    let ent = idx.entries[0]
    for (const e of idx.entries) { if (e.line <= startLine) ent = e; else break }
    // 从索引点按块读到「够 skip+size+1 行」为止：不假设每行多少字节，
    // 超长行不会把这一页截断（最多读到 EOF）。
    const wantLines = (startLine - ent.line) + size + 1
    const chunks = []
    let pos = ent.off
    let newlines = 0
    let bytes = 0
    const CAP = 256 * 1024 * 1024
    while (pos < o.size && newlines < wantLines && bytes < CAP) {
      const len = Math.min(256 * 1024, o.size - pos)
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, pos)
      if (n <= 0) break
      chunks.push(buf.slice(0, n))
      bytes += n
      pos += n
      for (let i = 0; i < n; i++) if (buf[i] === 0x0a) newlines++
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8')
    const lines = text.split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    const skip = startLine - ent.line
    return { page: p, pages, total, lines: lines.slice(skip, skip + size) }
  } finally { try { fs.closeSync(fd) } catch (e) {} }
}

const MAX_MEMBER_BYTES = 64 * 1024 * 1024 // 1MiB 成员的理论上限；异常 idx 不许让 buf 无限分配

function readGzIndex (gzPath) {
  // 索引本身也可能被换成符号链接：走 O_NOFOLLOW 打开，再按 fd 读。
  let o = null
  try {
    o = openLog(gzPath + '.idx.json', false) // nosemgrep（gzPath=白名单周档名，.idx.json 同目录）
    const idx = JSON.parse(fs.readFileSync(o.fd, 'utf8'))
    if (!idx || !Array.isArray(idx.members) || !idx.members.length) return null
    for (const m of idx.members) {
      if (!Number.isSafeInteger(m.off) || m.off < 0 || !Number.isSafeInteger(m.len) || m.len < 0 || m.len > MAX_MEMBER_BYTES) return null
    }
    return idx
  } catch (e) { return null } finally { if (o) { try { fs.closeSync(o.fd) } catch (e) {} } }
}

// gz 档按页读：定位目标页落在哪个成员，只解压需要的那几个 1MiB 块。
function readGzPage (gzPath, page, size) {
  const idx = readGzIndex(gzPath)
  if (!idx) return null
  const total = idx.lines
  const pages = Math.max(1, Math.ceil(total / size))
  const p = Math.min(Math.max(1, page), pages)
  const startLine = (p - 1) * size
  let mi = 0
  let acc = 0
  for (let i = 0; i < idx.members.length; i++) {
    if (acc + idx.members[i].lines <= startLine) { acc += idx.members[i].lines; mi = i + 1 } else { mi = i; break }
  }
  const out = []
  const o = openLog(gzPath, false)
  try {
    let lineCursor = acc
    for (let i = mi; i < idx.members.length && out.length < size; i++) {
      const m = idx.members[i]
      const buf = Buffer.alloc(m.len)
      let got = 0
      while (got < m.len) {
        const n = fs.readSync(o.fd, buf, got, m.len - got, m.off + got)
        if (n <= 0) break
        got += n
      }
      if (got < m.len) break
      const text = zlib.gunzipSync(buf).toString('utf8')
      const lines = text.split('\n')
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      const skip = Math.max(0, startLine - lineCursor)
      out.push(...lines.slice(skip))
      lineCursor += m.lines
    }
  } finally { try { fs.closeSync(o.fd) } catch (e) {} }
  return { page: p, pages, total, lines: out.slice(0, size) }
}

// 列出某个日志的归档：只认「gz + idx 都在」的成品，按周倒序。
function listArchives (cacheDir, fileName) {
  const dir = archiveDir(cacheDir)
  const base = baseOf(fileName)
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { return out } // nosemgrep（固定子目录）
  for (const n of names) {
    if (!n.startsWith(base + '-') || !n.endsWith('.log.gz')) continue
    const key = n.slice(base.length + 1, -'.log.gz'.length)
    if (!/^\d{8}-\d{8}$/.test(key)) continue
    const p = path.join(dir, n) // nosemgrep（n 已按白名单正则过滤）
    const idx = readGzIndex(p)
    if (!idx) continue // 没有索引 = 上次崩在发布中途，不当作可读归档
    let st
    try { st = fs.statSync(p) } catch (e) { continue } // nosemgrep（p 同上，仅用于展示大小/时间）
    out.push({ file: 'logs/' + n, key, size: st.size, lines: idx.lines, mtimeMs: st.mtimeMs, kind: 'gz', pages: Math.max(1, Math.ceil(idx.lines / 200)) })
  }
  out.sort((a, b) => (a.key < b.key ? 1 : -1))
  return out
}

// 一年保留：删掉最老的归档（gz + idx）。
function pruneArchives (cacheDir, fileName, keep = KEEP_WEEKS) {
  const list = listArchives(cacheDir, fileName)
  for (const e of list.slice(keep)) {
    const p = path.join(cacheDir, e.file) // nosemgrep（e.file 由 listArchives 白名单构造）
    try { fs.unlinkSync(p) } catch (err) {} // nosemgrep（同上）
    try { fs.unlinkSync(p + '.idx.json') } catch (err) {} // nosemgrep（同上）
  }
}

module.exports = {
  weekRange,
  archiveDir,
  archivePath,
  sealLog,
  readPlainPage,
  readGzPage,
  loadPlainIndex,
  listArchives,
  pruneArchives,
  weekMarkerPath,
  readMarker,
  writeMarker: (logPath, key) => writeAtomic(weekMarkerPath(logPath), key)
}
