'use strict'

// 日志按周归档（v3.403）：run.log / filter-diagnostics.ndjson
//
// 设计（与用户约定）：
//   - 两个日志各自上限 100MB；
//   - 自然周（周一 00:00 Asia/Shanghai）切档：旧档改名成 <base>-YYYYMMDD-YYYYMMDD.log，
//     并按 1MiB 文本块压成多成员 gzip（.log.gz），同时落一份 .idx.json 记录
//     「每个 gzip 成员的压缩偏移/长度/行数」与总行数；
//   - 控制台读档时只解压「目标页所在的那一个成员」，首屏与翻页都不整份解压、不进内存缓存；
//   - 保留一年由调用方按周清理（pruneArchives）。
//
// 多成员 gzip 是合法 gzip（gunzip 会顺序解完所有成员），但 Node 的 gunzipSync 一次只
// 处理一个成员：这里按 .idx.json 的偏移切片后单独解压，正好只解一页所需的块。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CST_OFFSET_MS = 8 * 3600 * 1000
const CHUNK_BYTES = 1024 * 1024 // 每个 gzip 成员对应约 1MiB 原文
const PLAIN_INDEX_STEP = 2000 // 明文档索引：每 2000 行记一个字节偏移
const ARCHIVE_DIR = 'logs'
const KEEP_WEEKS = 53 // 一年（含跨年那一周）

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
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - back * 86400000)
  const sunday = new Date(monday.getTime() + 6 * 86400000)
  return { start: ymd(monday), end: ymd(sunday), key: ymd(monday) + '-' + ymd(sunday) }
}

function archiveDir (cacheDir) {
  return path.join(cacheDir, ARCHIVE_DIR)
}

function baseOf (fileName) {
  return fileName === 'run.log' ? 'run' : 'diag'
}

function archivePath (cacheDir, fileName, key) {
  return path.join(archiveDir(cacheDir), baseOf(fileName) + '-' + key + '.log.gz')
}

function weekMarkerPath (logPath) {
  return logPath + '.week'
}

function readMarker (logPath) {
  try {
    const v = fs.readFileSync(weekMarkerPath(logPath), 'utf8').trim()
    return /^\d{8}-\d{8}$/.test(v) ? v : ''
  } catch (e) { return '' }
}

// 切档：把已写满一周的明文日志压成「多成员 gz + idx」，然后清空原文件。
// 调用方必须已持有该日志的写锁（跨进程），且只在周键变化时调用一次。
function sealLog (logPath, cacheDir, key) {
  // CodeQL js/file-system-race：先开 fd 再 fstat，全程只用这个 fd 读/截断，
  // 不做「stat 路径 → 再 open 路径」的两步检查（中间可能被换文件）。
  let fdIn = null
  let fdWritable = true
  try { fdIn = fs.openSync(logPath, 'r+') } catch (e) {
    // 只读权限的镜像/备份目录：退回只读打开，截断改走路径（这条分支不参与常规轮转）。
    fdWritable = false
    try { fdIn = fs.openSync(logPath, 'r') } catch (err) { return null }
  }
  let size = 0
  try { size = fs.fstatSync(fdIn).size } catch (e) { try { fs.closeSync(fdIn) } catch (err) {} return null }
  if (!size) {
    try { fs.closeSync(fdIn) } catch (err) {}
    try { fs.writeFileSync(weekMarkerPath(logPath), key, 'utf8') } catch (e) {}
    return null
  }
  const dir = archiveDir(cacheDir)
  fs.mkdirSync(dir, { recursive: true })
  const outPath = archivePath(cacheDir, path.basename(logPath), key)
  const tmpPath = outPath + '.tmp'
  const idx = { key, base: baseOf(path.basename(logPath)), source: path.basename(logPath), members: [], lines: 0, bytes: 0 }
  const fdOut = fs.openSync(tmpPath, 'w')
  try {
    const buf = Buffer.alloc(CHUNK_BYTES)
    let carry = Buffer.alloc(0)
    let compOff = 0
    for (;;) {
      const n = fs.readSync(fdIn, buf, 0, CHUNK_BYTES, null)
      if (n <= 0) break
      const chunk = carry.length ? Buffer.concat([carry, buf.slice(0, n)]) : buf.slice(0, n)
      let cut = chunk.length
      if (n > 0) {
        const nl = chunk.lastIndexOf(0x0a)
        if (nl >= 0 && nl + 1 <= chunk.length) cut = nl + 1
      }
      const take = chunk.slice(0, cut)
      carry = chunk.slice(cut)
      if (!take.length) continue
      const gz = zlib.gzipSync(take, { level: 6 })
      fs.writeSync(fdOut, gz)
      const lines = take.toString('utf8').split('\n').length - 1
      idx.members.push({ off: compOff, len: gz.length, lines })
      idx.lines += lines
      idx.bytes += take.length
      compOff += gz.length
    }
    if (carry.length) {
      const gz = zlib.gzipSync(carry, { level: 6 })
      fs.writeSync(fdOut, gz)
      idx.members.push({ off: compOff, len: gz.length, lines: 0 })
      idx.bytes += carry.length
      compOff += gz.length
    }
    fs.fsyncSync(fdOut)
    // 用同一个 fd 截断（不再走路径），避免「读完到截断之间路径被替换」。
    if (fdWritable) fs.ftruncateSync(fdIn, 0)
  } finally {
    try { fs.closeSync(fdIn) } catch (e) {}
    fs.closeSync(fdOut)
  }
  fs.renameSync(tmpPath, outPath)
  fs.writeFileSync(outPath + '.idx.json', JSON.stringify(idx), 'utf8')
  if (!fdWritable) { try { fs.truncateSync(logPath, 0) } catch (e) {} }
  fs.writeFileSync(weekMarkerPath(logPath), key, 'utf8')
  return { path: outPath, lines: idx.lines, bytes: idx.bytes }
}

// 明文档的字节偏移索引（每 PLAIN_INDEX_STEP 行一条）。
// 关键：run.log 每 5 秒就追加一行，若按 mtime 失效，每次翻页都要重扫 100MB。
// 追加只会在尾部增长、已有行的偏移不变 ⇒ 索引按「已扫到的字节数」增量延伸，
// 只有文件变短（截尾/换档）才整份重建。索引常驻控制台进程内存（每 2000 行一条，100MB ≈ 数万条，几 MB）。
const plainIdxCache = new Map()

function plainIndexPath (logPath) { return logPath + '.idx.json' }

function scanIntoFd (idx, fd, from, to) {
  const buf = Buffer.alloc(4 * 1024 * 1024)
  let pos = from
  while (pos < to) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos)
    if (n <= 0) break
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0x0a) {
        idx.lines += 1
        if (idx.lines - idx.lastMark >= PLAIN_INDEX_STEP) {
          idx.entries.push({ line: idx.lines, off: pos + i + 1 })
          idx.lastMark = idx.lines
        }
      }
    }
    pos += n
  }
  idx.size = pos
}

// 打开一次、fstat 同一 fd、读完即关：不做「stat 路径 → open 路径」（CodeQL js/file-system-race）。
function loadPlainIndex (logPath) {
  const fd = fs.openSync(logPath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let idx = plainIdxCache.get(logPath)
    if (!idx) {
      // 冷启动：sidecar 若与当前文件前缀一致（文件只增长过）可直接复用其条目
      try {
        const disk = JSON.parse(fs.readFileSync(plainIndexPath(logPath), 'utf8'))
        if (disk && Array.isArray(disk.entries) && disk.size <= size) {
          idx = { size: disk.size, lines: disk.lines, lastMark: disk.lines, entries: disk.entries }
        }
      } catch (e) {}
    }
    if (idx && size >= idx.size) {
      if (size > idx.size) scanIntoFd(idx, fd, idx.size, size)
    } else {
      idx = { size: 0, lines: 0, lastMark: 0, entries: [{ line: 0, off: 0 }] }
      scanIntoFd(idx, fd, 0, size)
    }
    plainIdxCache.set(logPath, idx)
    return idx
  } finally { try { fs.closeSync(fd) } catch (e) {} }
}

function readPlainPage (logPath, page, size) {
  const idx = loadPlainIndex(logPath)
  const total = idx.lines
  const pages = Math.max(1, Math.ceil(total / size))
  const p = Math.min(Math.max(1, page), pages)
  const startLine = (p - 1) * size
  let ent = idx.entries[0]
  for (const e of idx.entries) { if (e.line <= startLine) ent = e; else break }
  const fd = fs.openSync(logPath, 'r')
  try {
    const fst = fs.fstatSync(fd)
    const readLen = Math.min(fst.size - ent.off, Math.max(64 * 1024, (size + PLAIN_INDEX_STEP) * 200))
    const buf = Buffer.alloc(Math.max(0, readLen))
    fs.readSync(fd, buf, 0, buf.length, ent.off)
    const lines = buf.toString('utf8').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    const skip = startLine - ent.line
    return { page: p, pages, total, lines: lines.slice(skip, skip + size) }
  } finally { fs.closeSync(fd) }
}

function readGzIndex (gzPath) {
  try { return JSON.parse(fs.readFileSync(gzPath + '.idx.json', 'utf8')) } catch (e) { return null }
}

// gz 档按页读：定位目标页落在哪个成员，只解压那一个 1MiB 块。
function readGzPage (gzPath, page, size) {
  const idx = readGzIndex(gzPath)
  if (!idx || !Array.isArray(idx.members) || !idx.members.length) return null
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
  const fd = fs.openSync(gzPath, 'r')
  try {
    let lineCursor = acc
    for (let i = mi; i < idx.members.length && out.length < size; i++) {
      const m = idx.members[i]
      const buf = Buffer.alloc(m.len)
      fs.readSync(fd, buf, 0, m.len, m.off)
      const text = zlib.gunzipSync(buf).toString('utf8')
      const lines = text.split('\n')
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      const skip = Math.max(0, startLine - lineCursor)
      out.push(...lines.slice(skip))
      lineCursor += m.lines
    }
  } finally { fs.closeSync(fd) }
  return { page: p, pages, total, lines: out.slice(0, size) }
}

// 列出某个日志的归档：当前明文 + 历史 gz，按周倒序。
function listArchives (cacheDir, fileName) {
  const dir = archiveDir(cacheDir)
  const base = baseOf(fileName)
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { return out }
  for (const n of names) {
    if (!n.startsWith(base + '-') || !n.endsWith('.log.gz')) continue
    const key = n.slice(base.length + 1, -'.log.gz'.length)
    if (!/^\d{8}-\d{8}$/.test(key)) continue
    const p = path.join(dir, n)
    let st
    try { st = fs.statSync(p) } catch (e) { continue }
    const idx = readGzIndex(p)
    out.push({ file: 'logs/' + n, key, size: st.size, lines: idx ? idx.lines : null, mtimeMs: st.mtimeMs, kind: 'gz', pages: idx ? Math.max(1, Math.ceil(idx.lines / 200)) : null })
  }
  out.sort((a, b) => (a.key < b.key ? 1 : -1))
  return out
}

// 一年保留：删掉最老的归档（gz + idx）。
function pruneArchives (cacheDir, fileName, keep = KEEP_WEEKS) {
  const list = listArchives(cacheDir, fileName)
  for (const e of list.slice(keep)) {
    const p = path.join(cacheDir, e.file)
    try { fs.unlinkSync(p) } catch (err) {}
    try { fs.unlinkSync(p + '.idx.json') } catch (err) {}
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
  readMarker
}
