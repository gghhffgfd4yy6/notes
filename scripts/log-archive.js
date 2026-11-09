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
//   - 切档顺序：发布 gz → 发布 idx → 截断明文 → 写「新周」标记（v3.405：先截断后标记）。
//     截断失败就抛错、保留旧标记：宁可下一轮重试，也不让「标记已进新周、明文还是上一周」
//     的错位状态把上一周数据交给 100MB 截尾覆盖。
//   - 上次崩在「发布之后、截断/标记之前」时（gz 在、idx 缺 / gz+idx 都在、标记仍旧）不返回
//     null：idx 缺则从 gz 重建并补写，然后继续补做截断与标记；重建失败抛明确错误。
//   - 读完到截断之间若有 fail-open 写者追加，把追加段搬回文件开头再截断，不吞这几行；
//     搬运循环核验 EOF，快照之后的新追加也会被搬走。
//     搬家前先逐成员核验明文 [0, idx.bytes) 与归档逐字节一致：不一致时，只有 `<log>.seal.json`
//     事务记录（上次确实已完成截断）能证明明文是新周内容；没有该记录就抛错保留 archivePending，
//     绝不推进 marker（否则 100MB 截尾会覆盖仅存的明文副本）。

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

// 定点写：把 buf[0, len) 写到 fd 的 pos；同样把短写当失败而不是成功。
function writeAllAtSync (fd, buf, len, pos) {
  let off = 0
  while (off < len) {
    const n = fs.writeSync(fd, buf, off, len - off, pos + off)
    if (!(n > 0)) throw Object.assign(new Error('short write'), { code: 'ESHORT' })
    off += n
  }
}

// 把明文 [from, EOF) 搬到文件开头并截断，作为「已归档前缀 + 并发追加段」的压缩动作。
// fail-open 写者（拿不到锁的进程）可能在 fstat 快照之后继续 append：只按快照长度搬一次再
// ftruncate 会把快照之后的追加整段删掉（写者以为写成功，日志里却没有这一行）。这里的做法是
// 「搬完再 fstat」：只要 EOF 比已搬到的位置更远，就继续搬新增段；只有确认已搬位置 == 当前 EOF
// 才允许截断。极端情况下写者持续追加（轮次上限）就抛错、把截断推迟到下一轮——宁可这轮不清空，
// 也不能吞掉别人已经写成功的行。
const MOVE_CHUNK_BYTES = 256 * 1024
const MOVE_MAX_ROUNDS = 16

function moveTailToHeadAndTruncate (fdIn, from, logPath) {
  const buf = Buffer.alloc(MOVE_CHUNK_BYTES)
  let src = from
  let dst = 0
  for (let round = 0; ; round++) {
    const size = fs.fstatSync(fdIn).size
    while (src < size) {
      const want = Math.min(buf.length, size - src)
      const n = fs.readSync(fdIn, buf, 0, want, src)
      if (n <= 0) break
      writeAllAtSync(fdIn, buf, n, dst)
      src += n
      dst += n
    }
    if (fs.fstatSync(fdIn).size <= src) break
    if (round >= MOVE_MAX_ROUNDS) {
      throw archiveError(`归档搬运期间明文持续追加，推迟到下一轮再截断：${logPath}`)
    }
  }
  fs.ftruncateSync(fdIn, dst)
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

function archiveError (msg) {
  return Object.assign(new Error(msg), { code: 'EARCHIVE' })
}

// 封档事务日志：记录「gz+idx 已发布、正在/已经截断明文」这一步。
// 为什么需要它（Sourcery PRRT_kwDOT8kkjs61McwB）：截断成功但 .week 写失败时，明文里可能
// 已经追加了新周内容；下次 sealLog 看到「前缀与归档不一致」必须能区分两种现场——
//   (a) 上次截断已完成（有 journal）⇒ 明文全是新周内容，保留并推进 marker；
//   (b) 归档损坏/明文被替换（无 journal）⇒ 无法证明归档就是这份明文的副本，绝不能推进 marker
//       （否则调用方清掉 archivePending，100MB 截尾会把仅存的明文副本丢掉）。
// journal 在动明文之前写入、marker 成功之后删除；写到一半崩溃时它仍在，下一次 sealLog 先补齐
// marker（截断已完成）或重新执行截断（截断未完成，前缀仍与归档一致），两种现场都不会丢数据。
const SEAL_JOURNAL_VERSION = 1

function sealJournalPath (logPath) {
  return logPath + '.seal.json'
}

function readSealJournal (logPath) {
  let o = null
  try {
    o = openLog(sealJournalPath(logPath), false)
    const j = JSON.parse(fs.readFileSync(o.fd, 'utf8'))
    if (!j || j.v !== SEAL_JOURNAL_VERSION) return null
    if (typeof j.prevKey !== 'string' || !/^\d{8}-\d{8}$/.test(j.prevKey)) return null
    if (typeof j.nextKey !== 'string' || !/^\d{8}-\d{8}$/.test(j.nextKey)) return null
    if (!Number.isSafeInteger(j.bytes) || j.bytes < 0) return null
    if (j.source !== path.basename(logPath)) return null
    return j
  } catch (e) {
    return null
  } finally { if (o) { try { fs.closeSync(o.fd) } catch (e) {} } }
}

function writeSealJournal (logPath, prevKey, nextKey, idx) {
  writeAtomic(sealJournalPath(logPath), JSON.stringify({
    v: SEAL_JOURNAL_VERSION,
    source: path.basename(logPath),
    prevKey,
    nextKey,
    bytes: idx.bytes,
    lines: idx.lines
  }))
  fsyncDirBestEffort(path.dirname(logPath))
}

function clearSealJournal (logPath) {
  try { fs.unlinkSync(sealJournalPath(logPath)) } catch (e) {} // nosemgrep（路径=白名单日志名 + .seal.json）
}

// 定点读：读不满（EOF/短读）返回 null，调用方按「核验失败」处理，绝不拿半截数据当证据。
function readExactAt (fd, pos, len) {
  if (!(len > 0)) return null
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got)
    if (n <= 0) return null
    got += n
  }
  return buf
}

function gunzipMemberAt (fd, m) {
  const buf = readExactAt(fd, m.off, m.len)
  if (!buf) return null
  try { return zlib.gunzipSync(buf) } catch (e) { return null }
}

// 判定明文 [0, idx.bytes) 是否仍是归档内容（F1-4 / Sourcery PRRT_kwDOT8kkjs61Mcvy）。
// 只看 st.size >= idx.bytes 不够：F1-3 把 marker 推进挪到截断之后，会有「明文已截到 0、
// gz+idx 已发布、marker 仍旧周」的现场；这期间追加的新周内容一旦超过 idx.bytes，旧逻辑就会把
// [idx.bytes, size) 搬到文件头再截断——静默丢掉新内容开头 idx.bytes 字节、留下半行。
// 这里逐成员解压并与明文对应区间逐字节比对：只比首/末 64KiB 时，中间被改写的字节会被漏过，
// 随后按 idx.bytes 搬家截断就把「改过的中间段」删掉了。成员按 1MiB 切，单次比对只持有
// 一个成员（≤ MAX_MEMBER_BYTES），不整份解压到内存。索引与档案对不上（成员解压失败/总字节
// 不符）一律判「不一致」，走保留明文的保守分支。
function plaintextPrefixIsArchive (fdIn, gzPath, idx) {
  if (!idx.members || !idx.members.length || !(idx.bytes > 0)) return false
  let o
  try { o = openLog(gzPath, false) } catch (e) { return false }
  try {
    let off = 0
    for (const m of idx.members) {
      const text = gunzipMemberAt(o.fd, m)
      if (!text || !text.length) return false
      if (!Number.isSafeInteger(off + text.length) || off + text.length > idx.bytes) return false
      const plain = readExactAt(fdIn, off, text.length)
      if (!plain || !plain.equals(text)) return false
      off += text.length
    }
    return off === idx.bytes
  } catch (e) {
    return false
  } finally { try { fs.closeSync(o.fd) } catch (e) {} }
}

function countNewlines (buf) {
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n += 1
  return n
}

// 从 gz 重建索引（F1-2：崩在「gz 已发布、idx 未落」时）。
// 成员边界靠 inflateRaw 回读「本成员 deflate 流消耗的压缩字节数」：本模块写出的 gzip 头固定 10 字节
// （flags=0，无 FNAME/FEXTRA 等附加字段），故成员长度 = 10 + deflate + 8（CRC32 + ISIZE）。
// 头形态/长度/CRC/ISIZE 任一对不上都抛错——恢复路径宁可拒绝，也不能按猜出来的偏移生成一份
// 会把控制台读坏的索引。
//
// 内存边界（Sourcery PRRT_kwDOT8kkjs61McwH）：旧实现先 Buffer.alloc(整个 gz) 再无限解压，
// 大档案或高压缩比成员能把进程内存打爆（logger 直接崩，而不是给出可恢复的 EARCHIVE）。
// 现在按成员定点读：压缩输入从 64KiB 起倍增、封顶 MAX_REBUILD_INPUT；inflateRawSync 用
// maxOutputLength 限制单个成员解压上限（超过即拒绝）。任一时刻只持有一个成员的输入/输出。
const MAX_REBUILD_INPUT = 16 * 1024 * 1024
const MAX_REBUILD_MEMBER = 32 * 1024 * 1024
const REBUILD_INPUT_STEP = 64 * 1024

function inflateMemberBounded (fd, start, end, gzPath, off) {
  const avail = end - start
  if (avail <= 0) throw archiveError(`归档索引缺失且 gz 成员无法解压（偏移 ${off}）：${gzPath}（无数据）`)
  let len = Math.min(REBUILD_INPUT_STEP, avail)
  for (;;) {
    const slice = readExactAt(fd, start, len)
    if (!slice) throw archiveError(`归档索引缺失且 gz 读不完整：${gzPath}`)
    let inflated
    try {
      inflated = zlib.inflateRawSync(slice, { info: true, maxOutputLength: MAX_REBUILD_MEMBER })
    } catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') {
        throw archiveError(`归档索引缺失且 gz 成员解压后超过上限（偏移 ${off}，上限 ${MAX_REBUILD_MEMBER} 字节）：${gzPath}`)
      }
      if (len < avail && len < MAX_REBUILD_INPUT) {
        // 切片不够长（成员本身没问题）：加倍重试；maxOutputLength 仍在每次调用上生效。
        len = Math.min(len * 2, MAX_REBUILD_INPUT, avail)
        continue
      }
      throw archiveError(`归档索引缺失且 gz 成员无法解压（偏移 ${off}）：${gzPath}（${e.code || e.message}）`)
    }
    return inflated
  }
}

function rebuildGzIndex (gzPath, prevKey, fileName) {
  let opened
  try { opened = openLog(gzPath, false) } catch (e) {
    throw archiveError(`归档索引缺失且 gz 无法读取：${gzPath}（${e.code || e.message}）`)
  }
  const fd = opened.fd
  try {
    if (!opened.size) throw archiveError(`归档索引缺失且 gz 为空：${gzPath}`)
    const idx = { key: prevKey, base: baseOf(fileName), source: fileName, members: [], lines: 0, bytes: 0 }
    let off = 0
    while (off < opened.size) {
      const head = readExactAt(fd, off, 10)
      if (!head) throw archiveError(`归档索引缺失且 gz 读不完整：${gzPath}`)
      if (opened.size - off < 18 || head[0] !== 0x1f || head[1] !== 0x8b || head[2] !== 0x08 || head[3] !== 0) {
        throw archiveError(`归档索引缺失且 gz 成员头非法（偏移 ${off}）：${gzPath}`)
      }
      const inflated = inflateMemberBounded(fd, off + 10, opened.size, gzPath, off)
      const deflateLen = inflated.engine && inflated.engine.bytesWritten
      const len = 10 + deflateLen + 8
      if (!Number.isSafeInteger(deflateLen) || deflateLen <= 0 || off + len > opened.size) {
        throw archiveError(`归档索引缺失且 gz 成员长度异常（偏移 ${off}）：${gzPath}`)
      }
      const text = inflated.buffer
      const crcOff = off + 10 + deflateLen
      const trailer = readExactAt(fd, crcOff, 8)
      if (!trailer || !text.length || trailer.readUInt32LE(4) !== (text.length >>> 0) ||
          (typeof zlib.crc32 === 'function' && (zlib.crc32(text) >>> 0) !== trailer.readUInt32LE(0))) {
        throw archiveError(`归档索引缺失且 gz 成员校验失败（偏移 ${off}）：${gzPath}`)
      }
      const nl = countNewlines(text)
      const tail = text[text.length - 1] !== 0x0a
      if (tail && off + len !== opened.size) {
        throw archiveError(`归档索引缺失且 gz 中间成员无换行结尾（偏移 ${off}）：${gzPath}`)
      }
      if (!Number.isSafeInteger(idx.bytes + text.length) || !Number.isSafeInteger(idx.lines + nl + (tail ? 1 : 0))) {
        throw archiveError(`归档索引缺失且 gz 统计溢出（偏移 ${off}）：${gzPath}`)
      }
      idx.members.push(tail ? { off, len, lines: nl + 1, tail: true } : { off, len, lines: nl })
      idx.lines += nl + (tail ? 1 : 0)
      idx.bytes += text.length
      off += len
    }
    return idx
  } finally { try { fs.closeSync(fd) } catch (e) {} }
}

// 切档：把上一周（prevKey）的明文压成「多成员 gz + idx」，截断明文，最后写新周标记（nextKey）。
// 调用方必须已持有该日志的写锁；崩溃/失败时不推进标记（数据留在明文里，下一轮重试）。
function sealLog (logPath, cacheDir, prevKey, nextKey) {
  const dir = archiveDir(cacheDir)
  fs.mkdirSync(dir, { recursive: true }) // nosemgrep（固定子目录）
  const outPath = archivePath(cacheDir, path.basename(logPath), prevKey)

  // F1-2：同名归档已存在时不能直接 return null。上次可能崩在「发布之后、截断/标记之前」，
  // 直接返回会让 marker 永远停在旧周、调用方的 archivePending 一直为真（100MB 截尾被永久禁用）。
  // gz 在而 idx 缺 ⇒ 从 gz 重建索引并补写；两者都在 ⇒ 只补做截断与标记。
  let idx = null
  if (fs.existsSync(outPath)) { // nosemgrep（outPath=缓存目录/logs + 白名单周键）
    idx = readGzIndex(outPath)
    if (!idx) {
      idx = rebuildGzIndex(outPath, prevKey, path.basename(logPath))
      try {
        writeAtomic(outPath + '.idx.json', JSON.stringify(idx))
      } catch (e) {
        throw archiveError(`归档索引重建后写盘失败：${outPath}.idx.json（${e.code || e.message}）`)
      }
      fsyncDirBestEffort(dir)
    }
  }

  let opened
  try { opened = openLog(logPath, true) } catch (e) {
    try { opened = openLog(logPath, false) } catch (err) { return null }
  }
  const fdIn = opened.fd
  const writable = opened.writable
  // 上一次封档若崩在「截断完成、marker 未写」之间，journal 会留下（见 readSealJournal 注释）。
  // 只有 prevKey/nextKey/bytes 与本次现场完全一致才算「同一笔事务」，防止陈旧 journal 被误用。
  const journal = readSealJournal(logPath)
  const journalMatches = !!idx && !!journal && journal.prevKey === prevKey &&
    journal.nextKey === nextKey && journal.bytes === idx.bytes
  if (!opened.size) {
    try { fs.closeSync(fdIn) } catch (e) {}
    if (!idx) {
      try { writeAtomic(weekMarkerPath(logPath), nextKey) } catch (e) {}
      clearSealJournal(logPath)
      return null
    }
    // 明文已空（上次截断成功但标记没写成功）：只剩补标记这一步。先落 journal 再写 marker：
    // 若 marker 再次失败，下一次 sealLog 能凭它确认「截断已完成」，新追加的内容不会被误判成
    // 「归档与明文对不上」而永久卡住封档。
    writeSealJournal(logPath, prevKey, nextKey, idx)
    writeAtomic(weekMarkerPath(logPath), nextKey)
    clearSealJournal(logPath)
    return { path: outPath, lines: idx.lines, bytes: idx.bytes }
  }

  if (!idx) {
    const tmpPath = outPath + '.tmp'
    idx = { key: prevKey, base: baseOf(path.basename(logPath)), source: path.basename(logPath), members: [], lines: 0, bytes: 0 }
    let fdOut = null
    try {
      fdOut = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600) // nosemgrep（路径=缓存目录 + 白名单周键）
      const buf = Buffer.alloc(CHUNK_BYTES)
      let carry = Buffer.alloc(0)
      let compOff = 0
      let readTo = 0
      for (;;) {
        // 读位置必须用 readTo（上一轮整块读到的末尾），不能用 idx.bytes（只累计已归档的 take）：
        // 两者相差 carry 的长度，混用会把 carry 段重读一遍（行数对、字节数偏大 → 截断错位）。
        const n = fs.readSync(fdIn, buf, 0, CHUNK_BYTES, readTo)
        if (n <= 0) break
        readTo += n
        const chunk = carry.length ? Buffer.concat([carry, buf.slice(0, n)]) : buf.slice(0, n)
        let cut = chunk.length
        const nl = chunk.lastIndexOf(0x0a)
        if (nl >= 0) cut = nl + 1
        const take = chunk.slice(0, cut)
        // F1-1：carry 必须是独立副本。chunk 可能是读缓冲 buf 的零拷贝视图，下一轮
        // readSync(fdIn, buf, ...) 会覆盖它——Buffer.concat 就会把「新块头部」当成上一块行尾
        // 拼进来，每次跨块封档在 member0→member1 边界固定坏一行（丢 k 字节 + 重复 k 字节）。
        carry = Buffer.from(chunk.subarray(cut))
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
  }

  // F1-3：先截断成功、再推进 marker。旧顺序（先 marker 后截断）在截断失败时会把 marker 留在
  // 新周而明文还全是上一周——下一轮直接跳过归档，上一周明文被 100MB 截尾覆盖。截断失败必须
  // 留痕并抛错（调用方保留 archivePending）。读完到截断之间可能有 fail-open 写者追加：
  // 把 [idx.bytes, size) 搬回文件开头再截断。
  // F1-4：但「size 够大」不等于「明文前缀还是归档内容」——上次截断成功、.week 写失败后，
  // 新周内容会被追加到空文件里；超过 idx.bytes 后再按 [idx.bytes, size) 搬家，就会静默丢掉
  // 新内容开头 idx.bytes 字节（还留下半行）。搬家前必须核验前缀；核验不过时只有 journal
  // （上次确实已完成截断）能证明明文是新周内容，否则归档与明文对不上、明文可能是仅存副本，
  // 必须抛错保留 archivePending，绝不能推进 marker 把明文交给 100MB 截尾。
  try {
    const st = fs.fstatSync(fdIn)
    const prefixIsArchive = writable && st.size >= idx.bytes && plaintextPrefixIsArchive(fdIn, outPath, idx)
    if (prefixIsArchive) {
      // 动明文之前先落事务记录：截断成功而 marker 写失败时，下一次 sealLog 靠它区分
      // 「明文是新周内容」与「归档/明文对不上」。journal 写失败就不动明文（抛错，下一轮重试）。
      writeSealJournal(logPath, prevKey, nextKey, idx)
      // F1-7：搬运/截断期间仍可能有 fail-open 写者追加（它拿不到写锁）。按快照长度只搬一次再
      // ftruncate 会把快照之后的追加整段删掉——写者返回成功、日志里却没有这一行。helper 会
      // 「搬完再 fstat」，把新增段接着搬，确认已搬位置就是当前 EOF 才截断。
      moveTailToHeadAndTruncate(fdIn, idx.bytes, logPath)
    } else if (writable && st.size >= idx.bytes) {
      if (journalMatches) {
        // 上次已截断（journal 为证），这期间追加的全部是新周内容：不截、不搬，只补 marker。
        console.warn(`⚠️ 日志归档：明文前缀与归档内容不一致（上次截断已完成），保留全部明文、只推进标记：${logPath}`)
      } else {
        throw archiveError(`明文前缀与归档内容不一致，且没有可证明「上次截断已完成」的事务记录，保留明文与旧标记：${logPath}`)
      }
    } else if (writable) {
      // 明文比归档短：可能上次截断成功但标记没写成功。不做截断（避免删掉未归档的新内容），只补标记。
      console.warn(`⚠️ 日志归档：明文比归档短（${st.size} < ${idx.bytes}），跳过截断只推进标记：${logPath}`)
    } else {
      // 只读打开（rw 失败）无法截断，但数据已在 gz 里；留下告警而不是静默跳过。
      console.warn(`⚠️ 日志归档：明文不可写，跳过截断（数据已归档）：${logPath}`)
    }
  } catch (e) {
    if (e && e.code === 'EARCHIVE') {
      console.warn(`⚠️ 日志归档：${e.message}`)
      throw e
    }
    console.warn(`⚠️ 日志归档：截断明文失败，保留旧周标记以便下一轮重试：${logPath}（${e.code || e.message}）`)
    throw Object.assign(new Error(`日志归档截断失败：${logPath}（${e.code || e.message}）`), { code: 'EARCHTRUNC', cause: e })
  } finally {
    try { fs.closeSync(fdIn) } catch (e) {}
  }

  writeAtomic(weekMarkerPath(logPath), nextKey)
  clearSealJournal(logPath)
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
    o = openLog(gzPath + '.idx.json', false) // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    const idx = JSON.parse(fs.readFileSync(o.fd, 'utf8'))
    if (!idx || !Array.isArray(idx.members) || !idx.members.length) return null
    // v3.405：lines/bytes 是切档状态机的输入（bytes 决定明文截断位置），形态异常一律当作
    // 「没有索引」——恢复路径会从 gz 重建，绝不用一个 NaN/负数去截断明文。
    if (!Number.isSafeInteger(idx.lines) || idx.lines < 0) return null
    if (!Number.isSafeInteger(idx.bytes) || idx.bytes < 0) return null
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
