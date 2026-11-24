'use strict'

// 判重缓存「追加日志 + 定期合并」（P1 / v3.412）专项测试。
//
// 覆盖验收口径（spec P1 §验收 1/2/4 + §风险提示）：
//   ① 等价性：随机 500 轮（新增/更新/重复/URL/匿名/裁剪/重启），逐轮对比「旧全量实现」
//      （constants.JOURNAL_MAX_BYTES=0 且**读路径也不回放**）与「journal 实现」「混合实现」的
//      readMessages() 逐条深比较，以及 has() 判重结论；三档各用独立缓存目录（独立 push.json +
//      journal），old 档是真正不同源的 oracle——共用一份文件时删回放/删读端裁剪仍会全绿；
//   ② 崩溃恢复：journal 末尾半行（含「半行之后继续 append」必须补换行）、中间坏行、合并中途 kill
//      （快照已写/journal 未清）、裁剪落墓碑后的崩溃回放（墓碑身份不得复活、活条目不得被挤掉）；
//   ③ fail-closed：journal 读失败（非常规文件/超限）绝不当成「没有日志」，必须保持写闸门；
//   ④ 合并顺序：先写快照（writeAtomic 内含 fsync）→ 成功后才 truncate journal；写失败必须保留日志；
//   ⑤ 体积：100 轮 × 20 条新增，统计写盘字节 < 100 MB（旧实现同场景对照）。
//
// 命名/断言风格与 test_message_store_utils.js 一致（check + ✅/❌ + 退出码）。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nodeCrypto = require('node:crypto')

// C3-002：夹具加载期清掉外部部署开关，避免把测试写进真实缓存目录
const { isolateProcessCacheDirEnv } = require('./scripts/test-env-isolation')
isolateProcessCacheDirEnv()

const {
  createMessageStore,
  journalPathFor,
  parseJournalText,
  applyJournalRecords,
  toDiskEntry,
  canDropBody,
  selectEvictionIndices,
  trimMessagesToMaxSize,
  projectMessagesText,
  JOURNAL_SUFFIX,
  JOURNAL_VERSION,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_AGE_MS,
  JOURNAL_READ_MAX_BYTES,
  JOURNAL_DIRECT_MAX_BYTES
} = require('./xbk_message_store')
const { createUtils } = require('./xbk_utils')
const storage = require('./xbk_storage')
const { defaultMessageSignature } = require('./scripts/message-signature')

const Utils = createUtils({ fs, safeRe: (src, flags) => new RegExp(src, flags) })

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-journal-'))
// 缓存目录只走 XBK_CACHE_DIR（绝对路径、可越出项目根）：Config.cache.dir 有「必须落在项目根内」
// 的安全校验，临时目录会被回退到仓库里的 xianbaoku_cache（= 测试污染真实缓存目录）。
const PREV_CACHE_ENV = process.env.XBK_CACHE_DIR
let dirSeq = 0
function tmpDir (tag = 'd') {
  const dir = path.join(ROOT, `${tag}-${++dirSeq}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.XBK_CACHE_DIR = dir
  return dir
}
function cleanup () {
  if (PREV_CACHE_ENV === undefined) delete process.env.XBK_CACHE_DIR
  else process.env.XBK_CACHE_DIR = PREV_CACHE_ENV
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch (e) { /* 忽略：清理失败不改变测试结论 */ }
}
process.on('exit', cleanup)

let pass = 0
let fail = 0
function check (name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.error(`  ❌ ${name}: ${e.message}`)
    process.exitCode = 1
  }
}
function section (title) { console.log(`\n${title}`) }

/**
 * 读 journal 文件并按 NDJSON 解析成记录（S3：解析后断言字段，不比对文本片段）。
 * journal 行是 `{v, at, put:[…]}` / `{v, at, drop:[…]}` / `{v, at, ckpt:true}`；崩溃现场本来就可能
 * 留半行或坏行，这里逐行 JSON.parse、解析不出的行跳过（与生产 parseJournalText 的容错口径一致）。
 * 旧写法直接 `.includes('"a"')`：注释/编码差异、字段顺序变化、甚至只把 id 写成字符串都能命中，
 * 却答不出「a 这条 put 到底在不在」。
 */
function readJournalRecords (file) {
  const records = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try { records.push(JSON.parse(text)) } catch (e) { /* 半行/坏行：崩溃现场的正常残留 */ }
  }
  return records
}
/** 所有 put 条目（跨行扁平化）：断言「某身份是否还留在 journal 里」。 */
function journalPuts (records) {
  return records.flatMap((rec) => (Array.isArray(rec.put) ? rec.put : []))
}

/** 临时静音（随机等价性/体积用例每轮都有告警，不静音会把失败信息冲掉） */
function quietly (fn) {
  const { log, warn, error } = console
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try { return fn() } finally { console.log = log; console.warn = warn; console.error = error }
}
/** 收集 console.warn 文案（坏行等告警的断言口径） */
function captureWarn (fn) {
  const out = []
  const orig = console.warn
  console.warn = (...a) => out.push(a.map(String).join(' '))
  try { fn() } finally { console.warn = orig }
  return out
}

/** 虚拟时钟：等价性对比要求两个实现的 message timestamp 序列逐字相同，不能用真实 Date.now */
function virtualClock (start = 1770000000000) {
  const real = Date.now
  let now = start
  Date.now = () => now
  return {
    advance (ms) { now += ms },
    restore () { Date.now = real }
  }
}

function makeStore ({ dir, maxSize = 60, constants = {}, fsImpl = fs, storageImpl = storage }) {
  process.env.XBK_CACHE_DIR = dir
  return createMessageStore({
    Config: { cache: { maxSize } },
    Utils,
    fs: fsImpl,
    path,
    crypto: nodeCrypto,
    normalize: (o) => o,
    storage: storageImpl,
    constants: Object.assign({
      DEFAULT_MAX_SIZE: 10000,
      MESSAGE_CACHE_MAX_BYTES: 64 * 1024 * 1024,
      // 墓碑上限压到与 maxSize 同量级：等价性用例每轮都可能触发条数裁剪，5000 键的墓碑文件
      // 每次重写 ≈100KB，500 轮会把套件拖成 I/O 大户（并发跑时还会干扰同批套件的墙钟断言）。
      TOMBSTONE_MAX_KEYS: 64,
      TOMBSTONE_MAX_BYTES: 8 * 1024 * 1024,
      TOMBSTONE_LOCK_STALE_MS: 10000
    }, constants)
  })
}

// 三种实现档位：old = 旧全量重写（读路径也不回放日志）；journal = 强制走日志（含频繁合并）；
// mixed = 小缓存直写 + 大缓存日志。**每档必须配独立缓存目录**（见 J2 用例）——共用一份
// push.json/journal 时 old 档读的就是 journal 档写出的文件，oracle 与被测实现同源。
const VARIANTS = {
  old: { JOURNAL_MAX_BYTES: 0, JOURNAL_READ_ENABLED: false },
  journal: { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 16384 },
  mixed: { JOURNAL_DIRECT_MAX_BYTES: 2048, JOURNAL_MAX_BYTES: 32768 }
}

/** 32 位确定性 PRNG（mulberry32）：同一 seed 必须复现同一轮次序列，失败可重放 */
function rngFactory (seed) {
  let a = seed >>> 0
  return function rng () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ============================================================
section('1. 纯函数与常量口径')
// ============================================================

check('J1-01 journalPathFor 与 scripts/message-signature.js 的后缀口径一致（控制台缓存失效依赖它）', () => {
  assert.strictEqual(JOURNAL_SUFFIX, '.journal.ndjson')
  assert.strictEqual(journalPathFor('/x/push.json'), '/x/push.json.journal.ndjson')
  const src = fs.readFileSync(path.join(__dirname, 'scripts', 'message-signature.js'), 'utf8')
  assert.ok(src.includes(`const JOURNAL_SUFFIX = '${JOURNAL_SUFFIX}'`),
    'message-signature.js 的 JOURNAL_SUFFIX 必须与 xbk_message_store 同值，否则控制台签名漏算日志变化')
  assert.strictEqual(JOURNAL_VERSION, 2)
  assert.strictEqual(JOURNAL_MAX_BYTES, 8 * 1024 * 1024)
  assert.strictEqual(JOURNAL_MAX_AGE_MS, 6 * 60 * 60 * 1000)
  assert.strictEqual(JOURNAL_READ_MAX_BYTES, 64 * 1024 * 1024)
  assert.ok(JOURNAL_DIRECT_MAX_BYTES > 0 && JOURNAL_DIRECT_MAX_BYTES < JOURNAL_MAX_BYTES)
})

check('J1-02 parseJournalText：坏行/半行逐行忽略并计数，合法行（v1/v2）照常返回，未知版本不猜，ckpt 之后才回放', () => {
  const ok = JSON.stringify({ v: 1, at: 111, put: [{ id: 'a' }] })
  const text = [
    ok,
    '{"v":1,"at":222,"put":[{"id":"b"', // 半行（崩溃现场）
    'not-json', // 整行坏
    JSON.stringify({ v: 3, at: 333, put: [{ id: 'c' }] }), // 未知版本
    JSON.stringify({ v: 1, at: 444, put: [{ id: 'd' }, 'x', null] }), // 非对象元素跳过
    JSON.stringify({ v: 2, at: 555, put: [{ id: 'e' }], drop: [{ id: 'old' }, 7] }), // v2：drop 里的非对象元素同样跳过
    ''
  ].join('\n')
  const parsed = parseJournalText(text)
  assert.deepStrictEqual(parsed.puts.map(m => m.id), ['a', 'd', 'e'], '只回放合法行里的对象元素')
  assert.deepStrictEqual(parsed.records.map(r => [r.put.map(m => m.id), r.drop.map(m => m.id)]),
    [[['a'], []], [['d'], []], [['e'], ['old']]], '记录序列必须保留每行的 put/drop 配对（drop 不能拍平进 put）')
  assert.strictEqual(parsed.badLines, 3, '半行 + 坏 JSON + 未知版本各计一行')
  assert.strictEqual(parsed.lines, 3)
  assert.strictEqual(parsed.firstAt, 111, 'firstAt 取首条合法行的 at（合并窗口起点）')
  const empty = { records: [], puts: [], lines: 0, badLines: 0, firstAt: null, ckptLines: 0 }
  assert.deepStrictEqual(parseJournalText(''), empty)
  assert.deepStrictEqual(parseJournalText(null), empty)
  // ckpt：它之前的行已全部写进快照（合并成功、truncate 未完成），必须整体丢弃；
  // firstAt 从最后一个 ckpt 之后重新起算（合并窗口起点不能被旧行拖到 6 小时前）。
  const withCkpt = [
    ok,
    JSON.stringify({ v: 2, at: 900, put: [{ id: 'stale' }] }),
    JSON.stringify({ v: 2, at: 1000, ckpt: true }),
    JSON.stringify({ v: 2, at: 1001, put: [{ id: 'fresh' }], drop: [{ id: 'gone' }] })
  ].join('\n')
  const p2 = parseJournalText(withCkpt)
  assert.deepStrictEqual(p2.puts.map(m => m.id), ['fresh'], 'ckpt 之前的行已被快照吸收，不得再回放')
  assert.strictEqual(p2.firstAt, 1001)
  assert.strictEqual(p2.ckptLines, 1)
  // 末尾就是 ckpt（之后没有新行）：回放为空
  assert.deepStrictEqual(parseJournalText([ok, JSON.stringify({ v: 2, at: 1000, ckpt: true })].join('\n')).puts, [])
})

// ============================================================
section('2. 等价性：随机 500 轮（旧全量实现 vs journal vs 混合）')
// ============================================================

check('J2-01 500 轮随机新增/更新/重复/URL/匿名/重启：三档独立目录，readMessages 逐条深比较 + has 结论一致', () => {
  const clock = virtualClock()
  // 每档一份独立缓存目录：old 档的 push.json 只由 old 档写、journal 档的日志只由 journal 档写。
  // 共用目录时「旧实现」读到的正是被测实现写出的快照 + 日志（同源 oracle），等价性断言会恒真。
  const dirs = { old: tmpDir('equiv-old'), journal: tmpDir('equiv-journal'), mixed: tmpDir('equiv-mixed') }
  const NAME = 'push.json'
  // 500 轮只跑「新增/更新/重复/URL/匿名 + 合并 + 重启」：条数上限放到不会触发裁剪（裁剪每轮都会
  // 写一次墓碑，500 轮 ≈1200 次墓碑重写会把套件拖成 I/O 大户，进而干扰并发批次里的墙钟断言）。
  // 裁剪/墓碑等价性由 J2-02 用 120 轮小缓存专门覆盖。
  const maxSize = 100000
  const stores = {}
  const make = () => {
    for (const [name, constants] of Object.entries(VARIANTS)) {
      process.env.XBK_CACHE_DIR = dirs[name]
      stores[name] = makeStore({ dir: dirs[name], maxSize, constants })
    }
  }
  // 所有读写都显式切到该档自己的缓存目录：saveBatch/readMessages 内部的 getFilePath 依赖
  // XBK_CACHE_DIR（Config.cache.dir 只认项目根内路径，临时目录必须走这个开关）。
  const act = (name, fn) => { process.env.XBK_CACHE_DIR = dirs[name]; return fn(stores[name]) }
  const fpOf = (name) => act(name, (s) => s.getFilePath(NAME))
  const readOf = (name) => act(name, (s) => s.readMessages(s.getFilePath(NAME)))
  const hasOf = (name, probe) => act(name, (s) => s.has(probe, NAME))
  const rng = rngFactory(20261111)
  const state = { seq: 0, seen: [], last: null }
  let restarts = 0
  try {
    make()
    // oracle 独立性自证 ①：三档必须真的落在三份不同的 push.json 上
    const fps = Object.keys(VARIANTS).map(fpOf)
    assert.strictEqual(new Set(fps).size, 3, `三档必须各自一份 push.json（实际：${JSON.stringify(fps)}）`)
    for (let round = 0; round < 500; round++) {
      clock.advance(1000 + (round % 7))
      const batch = []
      // 60% 的轮次是「内容完全没变」：只重放上一条（旧实现在 changedAny=false 时零写盘）。既覆盖
      // 「无变更不写盘」的等价性，也把 500 轮里真正落盘的轮次压到约 200 次——旧实现每轮一次
      // writeAtomic（含 fsync，实测 ≈11.6ms），"500 轮全写" 会让本套件单独就吃掉 6s 墙钟。
      const noChange = !!state.last && rng() < 0.6
      if (noChange) batch.push(JSON.parse(JSON.stringify(state.last)))
      const n = noChange ? 0 : 1 + Math.floor(rng() * 2)
      for (let i = 0; i < n; i++) {
        const r = rng()
        if (r < 0.42 || state.seen.length === 0) {
          state.seq++
          const msg = { id: 'id-' + state.seq, title: 'title-' + state.seq, content: 'c'.repeat(1 + Math.floor(rng() * 60)) }
          state.seen.push(msg.id)
          state.last = JSON.parse(JSON.stringify(msg))
          batch.push(msg)
        } else if (r < 0.66) {
          const id = state.seen[Math.floor(rng() * state.seen.length)]
          batch.push({ id, title: 'upd-' + state.seq + '-' + Math.floor(rng() * 1e6), content: 'u'.repeat(1 + Math.floor(rng() * 30)) })
        } else if (r < 0.78 && state.last) {
          batch.push(JSON.parse(JSON.stringify(state.last))) // 内容完全一致 → 必须零写入
        } else if (r < 0.9) {
          state.seq++
          batch.push({ url: 'https://example.com/news/' + state.seq, title: 'url-' + state.seq })
        } else {
          state.seq++
          batch.push({ title: 'anon-' + state.seq, content: 'anon-body-' + state.seq })
        }
      }
      const single = rng() < 0.12
      for (const name of Object.keys(stores)) {
        act(name, (store) => (single ? store.save(batch[0], NAME) : store.saveBatch(batch, NAME)))
      }
      // 每轮：内存视图必须逐条一致（timestamp 也一致——虚拟时钟让两边序列同源）
      const ref = readOf('old')
      assert.deepStrictEqual(readOf('journal'), ref, `第 ${round} 轮 journal 视图与旧实现不一致`)
      assert.deepStrictEqual(readOf('mixed'), ref, `第 ${round} 轮 mixed 视图与旧实现不一致`)
      // 判重结论一致：每 5 轮抽 3 条（1 条已存在 + 2 条不存在）。has() 每次都会为当前内存数组
      // 重建身份索引（数组引用随 _memoSet 变化），逐轮全量抽查会让 500 轮变成几百万次身份计算——
      // 覆盖密度足够（100 轮 × 3 条），又不至于把套件拖成 CPU 大户。
      if (round % 5 === 0) {
        const probes = []
        if (state.seen.length > 0) probes.push({ id: state.seen[Math.floor(rng() * state.seen.length)] })
        probes.push({ id: 'missing-' + round + '-a' })
        probes.push({ url: 'https://example.com/news/' + round })
        for (const probe of probes) {
          const expected = hasOf('old', probe)
          assert.strictEqual(hasOf('journal', probe), expected, `第 ${round} 轮 has(${JSON.stringify(probe)}) 与旧实现不一致`)
          assert.strictEqual(hasOf('mixed', probe), expected, `第 ${round} 轮 mixed has(${JSON.stringify(probe)}) 与旧实现不一致`)
        }
      }
      // 重启：每 37 轮换新实例（内存清空，只能靠「快照 + journal」重建）
      if (round % 37 === 36) {
        restarts++
        make()
        const after = readOf('old')
        assert.deepStrictEqual(readOf('journal'), after, `第 ${round} 轮重启后 journal 视图不一致`)
        assert.deepStrictEqual(readOf('mixed'), after, `第 ${round} 轮重启后 mixed 视图不一致`)
      }
    }
    assert.ok(restarts >= 13, `必须覆盖至少 13 次重启，实际 ${restarts}`)
    // 收尾自证：三种实现的最终快照内容（old 的 push.json == journal 合并后的视图）
    assert.deepStrictEqual(readOf('journal'), readOf('old'))
    // oracle 独立性自证 ②：old 档全程不产生 journal（既没写也不读），journal 档必须真的用到日志。
    // 若 old 也在写日志，说明「关掉 journal」的档位没生效，等价性就退回同源比较。
    assert.strictEqual(fs.existsSync(journalPathFor(fpOf('old'))), false, 'old 档不得产生 journal（否则 oracle 同源）')
    assert.ok(fs.existsSync(journalPathFor(fpOf('journal'))), 'journal 档必须真的落过日志')
  } finally {
    clock.restore()
  }
})

check('J2-02 裁剪等价性：小缓存(maxSize=12) 60 轮，三档独立目录，条数裁剪 + 墓碑路径与旧实现逐条一致', () => {
  const clock = virtualClock()
  const dirs = { old: tmpDir('equiv-trim-old'), journal: tmpDir('equiv-trim-journal'), mixed: tmpDir('equiv-trim-mixed') }
  const NAME = 'push.json'
  const maxSize = 12
  const stores = {}
  const make = () => {
    for (const [name, constants] of Object.entries(VARIANTS)) {
      process.env.XBK_CACHE_DIR = dirs[name]
      stores[name] = makeStore({ dir: dirs[name], maxSize, constants })
    }
  }
  const act = (name, fn) => { process.env.XBK_CACHE_DIR = dirs[name]; return fn(stores[name]) }
  const readOf = (name) => act(name, (s) => s.readMessages(s.getFilePath(NAME)))
  const rng = rngFactory(424242)
  let seq = 0
  try {
    make()
    for (let round = 0; round < 60; round++) {
      clock.advance(1000)
      const batch = []
      for (let i = 0; i < 2; i++) {
        seq++
        if (rng() < 0.8) batch.push({ id: 't-' + seq, title: 't' + seq })
        else batch.push({ id: 't-' + Math.max(1, seq - 5), title: 'upd' + seq })
      }
      for (const name of Object.keys(stores)) act(name, (store) => store.saveBatch(batch, NAME))
      const ref = readOf('old')
      assert.deepStrictEqual(readOf('journal'), ref, `裁剪第 ${round} 轮 journal 与旧实现不一致`)
      assert.deepStrictEqual(readOf('mixed'), ref, `裁剪第 ${round} 轮 mixed 与旧实现不一致`)
      // 每 15 轮重启并**冷读**（新实例内存为空，只能靠「快照 + journal」重建）：saveBatch 后的
      // 比较读的是内存视图，重建路径（回放 + 读端裁剪）必须单独对账，否则读端缺陷会被内存缓存掩盖。
      if (round % 15 === 14) {
        make()
        const coldOld = readOf('old')
        assert.deepStrictEqual(readOf('journal'), coldOld, `重启第 ${round} 轮冷读 journal 与旧实现不一致`)
        assert.deepStrictEqual(readOf('mixed'), coldOld, `重启第 ${round} 轮冷读 mixed 与旧实现不一致`)
      }
    }
    // 收尾冷读：新实例只能靠「快照 + journal」重建，必须逐条等于旧实现并收敛到上限。
    make()
    const coldRef = readOf('old')
    assert.deepStrictEqual(readOf('journal'), coldRef, '收尾冷读 journal 与旧实现不一致')
    assert.deepStrictEqual(readOf('mixed'), coldRef, '收尾冷读 mixed 与旧实现不一致')
    assert.strictEqual(coldRef.length, maxSize, '稳态必须恰好保持条数上限')
    // 读端裁剪必须真的在起作用：journal 档的快照 + 日志合并后条数一定落回上限，
    // 不能把已被裁掉（并落墓碑）的旧条目靠回放留在结果里。
    assert.strictEqual(readOf('journal').length, maxSize, 'journal 视图回放后必须收敛到条数上限')
    assert.strictEqual(readOf('mixed').length, maxSize, 'mixed 视图回放后必须收敛到条数上限')
    // 被裁剪的身份必须仍然判重命中（墓碑），且全新 id 不命中
    const dropped = 't-1'
    assert.strictEqual(act('journal', (s) => s.has({ id: dropped }, NAME)), act('old', (s) => s.has({ id: dropped }, NAME)), '墓碑判重结论必须与旧实现一致')
  } finally {
    clock.restore()
  }
})

check('J2-03 墓碑 + 崩溃回放：已落墓碑的裁剪条目不得靠 journal 复活，快照里的活条目一条不丢', () => {
  // 审查员 crash_trim_repro 的回归：maxSize=5，快照已是裁剪后的 [b,c,d,e,f]，journal 仍留有
  // 裁剪前的 put [a,b,c,d,e,f]（「快照已写、journal 未清」的崩溃窗口）。回放若不过墓碑闸门，
  // a 会追加到尾部 → 6 条 > 上限 → 从头部裁剪 → b 这条未墓碑的活条目被挤掉（判重记忆丢失）。
  const clock = virtualClock()
  const dir = tmpDir('crash-trim')
  const NAME = 'push.json'
  const maxSize = 5
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1 << 30 }
  const store = makeStore({ dir, maxSize, constants })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  try {
    // 两批写入：第一批 5 条（= 上限，全部进 journal）；第二批 f 触发裁剪，最旧的 a 落墓碑。
    // journal 因此同时保留 a..e（第一批）与 f（第二批）——这正是「快照已写、journal 未清」时的残留。
    store.saveBatch([
      { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' },
      { id: 'd', title: 'D' }, { id: 'e', title: 'E' }
    ], NAME)
    store.saveBatch([{ id: 'f', title: 'F' }], NAME)
    // 6 条 > maxSize=5 ⇒ 内存裁掉最旧的 a 并落墓碑，journal 里仍有 a..f 六条 put
    assert.deepStrictEqual(store.readMessages(fp).map(m => m.id), ['b', 'c', 'd', 'e', 'f'], '写入侧先自证裁剪结果')
    // 崩溃现场：快照已写成「裁剪后的完整内容」，但 journal 的 truncate 还没执行
    fs.writeFileSync(fp, JSON.stringify([
      { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
      { id: 'e', title: 'E' }, { id: 'f', title: 'F' }
    ]))
    assert.ok(journalPuts(readJournalRecords(jp)).some((put) => put.id === 'a'), 'journal 必须仍含被裁剪条目 a 的 put（构造崩溃窗口）')
    const reopened = makeStore({ dir, maxSize, constants })
    const got = reopened.readMessages(fp)
    assert.deepStrictEqual(got.map(m => m.id), ['b', 'c', 'd', 'e', 'f'], '墓碑身份不得复活，且未墓碑的活条目不得被挤掉')
    assert.strictEqual(new Set(got.map(m => m.id)).size, got.length, '不得重复入列')
    assert.strictEqual(reopened.has({ id: 'a' }, NAME), true, '被裁条目仍由墓碑拦下（上游重放不重复推送）')
    assert.strictEqual(reopened.has({ id: 'b' }, NAME), true, '活条目 b 的判重记忆不得丢失')
    // 继续写入也不得把 a 带回数组（回放 + 新写入叠加后仍然只有活条目）
    reopened.saveBatch([{ id: 'g', title: 'G' }], NAME)
    const after = makeStore({ dir, maxSize, constants }).readMessages(fp)
    assert.deepStrictEqual(after.map(m => m.id), ['c', 'd', 'e', 'f', 'g'], '重启 + 继续写入后仍不得出现复活条目')
  } finally {
    clock.restore()
  }
})

check('J2-04 同批「先插入后更新同一身份」：重启后 readMessages 必须与重启前逐条深比较一致（顺序+内容，无 _f 与含 _f 两式；含 _f 一式按 v3.534「_f 优先淘汰」口径）', () => {
  // 审查 B 的 orderFlip 复现：写入顺序 ≠ 内存数组顺序。maxSize=5、journal 不合并 ⇒ 重启只能靠日志
  // 重建数组；回放对未命中项只能 push 到尾部，若 put 按写入顺序记（r 在前、p' 在后），重启后数组
  // 变成 [q,r,p']（修前实测），与内存的 [q,p',r] 不同 ⇒ 后续条数裁剪先裁谁也随之改变。
  // 含 _f 一式再叠一层「先插入 f、再插入 x、最后更新 f」，并且第三批触发条数裁剪——v3.534 起
  // 条数淘汰 `_f` 优先 ⇒ 被裁的是 f（旧口径裁最旧的 a）。被裁身份必须进日志 drop，
  // 否则回放会把它放回数组尾部、又去挤掉活条目。
  const clock = virtualClock()
  const NAME = 'push.json'
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1 << 30 } // 不合并：顺序全靠日志自己承载
  const cases = [
    {
      tag: 'plain',
      maxSize: 5,
      batches: [
        [{ id: 'q', title: 'Q' }],
        [{ id: 'p', title: 'P' }, { id: 'r', title: 'R' }, { id: 'p', title: 'P2' }]
      ],
      expectIds: ['q', 'p', 'r'],
      expectPutL2: ['p', 'r']
    },
    {
      tag: 'filtered',
      maxSize: 5,
      batches: [
        [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
        [{ id: 'f', title: 'F', _f: true }, { id: 'x', title: 'X' }, { id: 'f', title: 'F2', _f: true }],
        // 6 条 > 上限 5。v3.534 口径：先淘汰 `_f`（f 从未推送、不落墓碑，规则变更后由上游整批重评），
        // 已推送的 a/b/c/x 因此保命——旧口径「数组最旧优先」会在这里先裁掉 a，等于用 `_f` 洪峰
        // 把已推送记录的判重记忆挤出上限（上游重放即重复推送）。被淘汰的 f 仍必须进日志 drop，
        // 否则回放会把它放回尾部、又去挤活条目。
        [{ id: 'y', title: 'Y' }]
      ],
      expectIds: ['a', 'b', 'c', 'x', 'y'],
      expectDropL3: ['f']
    }
  ]
  try {
    for (const c of cases) {
      const dir = tmpDir('order-' + c.tag)
      const store = makeStore({ dir, maxSize: c.maxSize, constants })
      const fp = store.getFilePath(NAME)
      for (const b of c.batches) { clock.advance(1000); store.saveBatch(b, NAME) }
      const before = store.readMessages(fp).map(m => Object.assign({}, m))
      assert.deepStrictEqual(before.map(m => m.id), c.expectIds, `${c.tag}: 写入侧先自证内存顺序`)
      const lines = fs.readFileSync(journalPathFor(fp), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      if (c.expectPutL2) {
        assert.deepStrictEqual(lines[1].put.map(m => m.id), c.expectPutL2,
          `${c.tag}: 同批同身份只记一次，且 put 顺序必须 = 内存数组顺序（不能是写入顺序 r,p）`)
        assert.strictEqual(lines[1].put[0].title, 'P2', `${c.tag}: 同一身份的内容取最后一次写入`)
      }
      if (c.expectDropL3) {
        assert.deepStrictEqual((lines[2].drop || []).map(m => m.id), c.expectDropL3,
          `${c.tag}: 本批被裁剪的身份必须记进 drop（否则回放会把它放回尾部并挤掉活条目）`)
      }
      const reopened = makeStore({ dir, maxSize: c.maxSize, constants })
      const after = reopened.readMessages(fp)
      assert.deepStrictEqual(after, before, `${c.tag}: 重启后 readMessages 必须与重启前逐条深比较一致（顺序+内容）`)
      assert.deepStrictEqual(after.map(m => m.id), before.map(m => m.id), `${c.tag}: 顺序必须逐条一致`)
      for (const m of before) {
        assert.strictEqual(reopened.has({ id: m.id, title: m.title }, NAME), true, `${c.tag}: 活条目 ${m.id} 的判重记忆不得丢失`)
      }
      // 被裁条目仍由墓碑拦下（_f 从不落墓碑：它只是「没被推送过」，回到上游应能重新评估）
      if (c.tag === 'filtered') {
        assert.strictEqual(reopened.has({ id: 'a' }, NAME), true, '已推送过的 a 在 _f 优先口径下保命 ⇒ 判重必须命中（旧口径它会先被裁掉）')
        assert.strictEqual(reopened.has({ id: 'f' }, NAME), false, '被淘汰的 _f（f）不得留下判重记忆：它从未推送，回到上游要能重新评估')
      }
    }
  } finally {
    clock.restore()
  }
})

check('J2-05 重启时 maxSize 调小：读端兜底裁剪必须为被裁活条目补墓碑，has() 不得丢失（与旧实现一致）', () => {
  // 审查员 must_fix（P1 / v3.415）的回归：读端把「回放后仍在缓存里、未墓碑」的最旧 N 条直接 splice
  // 掉、却不落墓碑，这些身份既不在内存/快照、也不在 .seen.json ⇒ 之后所有写入都不会再为它们补墓碑
  // ⇒ has() 永远 false，上游重放即重复推送。旧实现（读路径不裁）下一次写入会按 _persistChanges
  // 口径裁剪并落墓碑，has() 一直为 true——这就是本用例的对账口径。
  const NAME = 'push.json'
  const dir = tmpDir('shrink-maxsize')
  // 强制纯日志、不合并：快照保持空数组，重启只能靠 journal 回放重建数组（真实回放路径）。
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1 << 30 }
  const store = makeStore({ dir, maxSize: 7, constants })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  store.saveBatch([1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ id: 'm' + n, title: 'M' + n })), NAME)
  assert.deepStrictEqual(store.readMessages(fp).map(m => m.id), ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
    '写入侧先自证：上限 7 写 8 条只裁 m1')
  // 构造「重启时只能靠日志重建」的现场：快照仍是空数组，m2..m8 只在 journal 里，m1 已落墓碑。
  assert.strictEqual(JSON.parse(fs.readFileSync(fp, 'utf8') || '[]').length, 0, '快照必须还是空的（读路径必须真的回放 journal）')
  const lines = fs.readFileSync(jp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  assert.deepStrictEqual(lines[0].put.map(m => m.id), ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], 'journal 必须承载待回放的 7 条')
  assert.deepStrictEqual((lines[0].drop || []).map(m => m.id), ['m1'], 'journal 必须记下本批被裁的 m1')
  // 冷启且上限调小到 5：7 条里最旧的 m2/m3 是未墓碑的活条目，只能由读端兜底裁掉。
  const reopened = makeStore({ dir, maxSize: 5, constants })
  const got = reopened.readMessages(fp)
  assert.deepStrictEqual(got.map(m => m.id), ['m4', 'm5', 'm6', 'm7', 'm8'], '读端仍须按 maxSize 收敛（条数上界不变）')
  assert.strictEqual(got.length, 5, '读结果条数上界必须 = maxSize')
  // 修前实测：has(m2)/has(m3) 均为 false（内存/快照/墓碑三处都没有）⇒ 上游重放会再推一次。
  assert.strictEqual(reopened.has({ id: 'm2' }, NAME), true, '被读端裁掉的活条目 m2 必须由墓碑拦下（修前 false）')
  assert.strictEqual(reopened.has({ id: 'm3' }, NAME), true, '被读端裁掉的活条目 m3 必须由墓碑拦下（修前 false）')
  // 随后写入一条新消息（旧实现正是在这一步为被裁身份补墓碑）：判重结论必须保持。
  reopened.saveBatch([{ id: 'm9', title: 'M9' }], NAME)
  assert.strictEqual(reopened.has({ id: 'm2' }, NAME), true, 'saveBatch 之后 m2 的判重记忆不得丢失')
  assert.strictEqual(reopened.has({ id: 'm3' }, NAME), true, 'saveBatch 之后 m3 的判重记忆不得丢失')
  // 再重启一次（只靠快照 + 日志 + 墓碑重建）结论同样成立
  const again = makeStore({ dir, maxSize: 5, constants })
  assert.strictEqual(again.has({ id: 'm2' }, NAME), true, '重启后 m2 的判重记忆不得丢失')
  assert.strictEqual(again.has({ id: 'm3' }, NAME), true, '重启后 m3 的判重记忆不得丢失')
})

// ============================================================
section('3. 崩溃恢复')
// ============================================================

check('J3-01 末尾半行：忽略半行并告警，之前的行全部生效，判重结论不受影响', () => {
  const dir = tmpDir('half')
  const NAME = 'push.json'
  const store = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  store.saveBatch([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], NAME)
  const before = store.readMessages(fp).length
  // 模拟进程在 append 中途被 kill：最后一行没有换行、JSON 不完整
  fs.appendFileSync(jp, '{"v":1,"at":1,"put":[{"id":"half","title":"半')
  const warns = captureWarn(() => {
    const reopened = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
    const got = reopened.readMessages(fp)
    assert.strictEqual(got.length, before, '半行不得丢弃之前的行')
    assert.deepStrictEqual(got.map(m => m.id), ['a', 'b'])
    assert.strictEqual(reopened.has({ id: 'half' }, NAME), false, '半行里的条目不得被当成已推送')
    assert.strictEqual(reopened.has({ id: 'a' }, NAME), true)
  })
  assert.ok(warns.some(w => w.includes('判重日志有')), `坏行必须告警（实际：${JSON.stringify(warns)}）`)
})

check('J3-02 中间整行坏 JSON：只跳过该行，后续行照常回放（不整份丢弃）', () => {
  const dir = tmpDir('badline')
  const NAME = 'push.json'
  const store = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  store.saveBatch([{ id: 'first', title: '1' }], NAME)
  fs.appendFileSync(jp, '{"broken":\n')
  fs.appendFileSync(jp, JSON.stringify({ v: 1, at: 5, put: [{ id: 'second', title: '2' }] }) + '\n')
  fs.appendFileSync(jp, JSON.stringify({ v: 1, at: 6, put: [{ id: 'third', title: '3' }] }) + '\n')
  const reopened = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  const got = reopened.readMessages(fp)
  assert.deepStrictEqual(got.map(m => m.id), ['first', 'second', 'third'], '坏行之后的行必须继续回放')
  assert.strictEqual(reopened.has({ id: 'third' }, NAME), true)
})

check('J3-03 合并中途 kill（快照已写、journal 未清）：重启后幂等重放，不重复、不丢条', () => {
  const clock = virtualClock()
  const dir = tmpDir('kill')
  const NAME = 'push.json'
  const fp0 = makeStore({ dir, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } }).getFilePath(NAME)
  try {
    const store = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1024 } })
    store.saveBatch([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], NAME)
    const merged = store.readMessages(fp0)
    const journalBefore = fs.readFileSync(journalPathFor(fp0), 'utf8')
    assert.ok(journalBefore.length > 0)
    // 崩溃现场：快照已写成「合并后的完整内容」，但 truncate 还没执行
    fs.writeFileSync(fp0, JSON.stringify(merged))
    const reopened = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
    const got = reopened.readMessages(fp0)
    assert.deepStrictEqual(got, merged, '重复回放必须幂等：条数/顺序/内容都不变')
    assert.strictEqual(new Set(got.map(m => m.id)).size, got.length, '不得出现重复条目')
    // 重启后继续写入仍然只保留一条
    reopened.saveBatch([{ id: 'a', title: 'A2' }], NAME)
    const after = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } }).readMessages(fp0)
    assert.strictEqual(after.filter(m => m.id === 'a').length, 1)
    assert.strictEqual(after.find(m => m.id === 'a').title, 'A2')
  } finally {
    clock.restore()
  }
})

check('J3-04 快照 0 字节（被外部截断）：journal 里的判重记忆仍必须回放出来', () => {
  const dir = tmpDir('trunc')
  const NAME = 'push.json'
  const store = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  const fp = store.getFilePath(NAME)
  store.saveBatch([{ id: 'keep', title: 'K' }], NAME)
  fs.writeFileSync(fp, '')
  const reopened = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  const got = quietly(() => reopened.readMessages(fp))
  assert.deepStrictEqual(got.map(m => m.id), ['keep'], '快照被截断不等于判重记忆归零')
})

check('J3-05 末尾半行之后继续 append：先补换行，新记录独占一行可回放，此前完整记录仍在', () => {
  const dir = tmpDir('halfappend')
  const NAME = 'push.json'
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0 }
  const store = makeStore({ dir, maxSize: 100, constants })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  store.saveBatch([{ id: 'a', title: 'A' }], NAME)
  // 崩溃现场：上次 append 被 kill，留下没有换行的半行
  fs.appendFileSync(jp, '{"v":1,"at":1,"put":[{"id":"half","title":"残')
  // 同一实例继续写：append 前必须先把半行封闭，否则 b 会拼在半行后一起作废
  assert.strictEqual(store.saveBatch([{ id: 'b', title: 'B' }], NAME), true)
  const parsed = parseJournalText(fs.readFileSync(jp, 'utf8'))
  assert.strictEqual(parsed.badLines, 1, `只该有那条半行是坏行（实际 ${parsed.badLines}）`)
  assert.deepStrictEqual(parsed.puts.map(m => m.id), ['a', 'b'], '新记录必须独占一行，此前完整记录仍在')
  const reopened = makeStore({ dir, maxSize: 100, constants })
  const got = reopened.readMessages(fp)
  assert.deepStrictEqual(got.map(m => m.id), ['a', 'b'], '重启后新记录必须能回放（否则 saveBatch 报成功但判重丢了）')
  assert.strictEqual(reopened.has({ id: 'b' }, NAME), true, '新记录必须进入判重集合（否则上游重放会重复推送）')
  assert.strictEqual(reopened.has({ id: 'half' }, NAME), false, '半行里的条目不得被当成已推送')
})

check('J3-06 末尾是完整 JSON 但缺换行（短写）：补换行后两条都能解析，不得把新记录拼成坏行', () => {
  const dir = tmpDir('nonl')
  const NAME = 'push.json'
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0 }
  const store = makeStore({ dir, maxSize: 100, constants })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  store.saveBatch([{ id: 'a', title: 'A' }], NAME)
  // 短写：整行 JSON 已落盘，唯独末尾的 '\n' 没写出去
  const text = fs.readFileSync(jp, 'utf8')
  assert.ok(text.endsWith('\n'))
  fs.writeFileSync(jp, text.slice(0, -1))
  store.saveBatch([{ id: 'b', title: 'B' }], NAME)
  const parsed = parseJournalText(fs.readFileSync(jp, 'utf8'))
  assert.strictEqual(parsed.badLines, 0, `补换行后不该再有坏行（实际 ${parsed.badLines}）`)
  assert.deepStrictEqual(parsed.puts.map(m => m.id), ['a', 'b'])
  const reopened = makeStore({ dir, maxSize: 100, constants })
  assert.deepStrictEqual(reopened.readMessages(fp).map(m => m.id), ['a', 'b'])
})

check('J3-07 _f 记录 + 「快照已写、journal 未截断」窗口：重启读路径必须与旧读路径逐条一致，活条目不得被挤掉', () => {
  // 审查 B 的 crash-truncate 复现（探针注入 truncate EPERM）：maxSize=3，第一批 [f(_f),a,b] 合并成功、
  // 但 journal 清不掉；第二批 c 进内存后把 _f 的 f 头裁掉（f 从不落墓碑）⇒ 快照 [a,b,c] + journal 仍含
  // f 的 put。回放若只按 put 叠加，f 会复活到尾部 → 4 条 > 上限 → 读端从头部挤掉 a（活条目），
  // 修前 newRead=["b","c","f"]、hasA=false。
  const clock = virtualClock()
  const dir = tmpDir('f-crash')
  const NAME = 'push.json'
  const fp = path.join(dir, NAME)
  const jp = journalPathFor(fp)
  const fsWrap = Object.create(fs)
  // 只让 journal 的 truncate 失败：模拟「快照已写、清日志失败/进程死在两者之间」
  fsWrap.truncateSync = (p, ...rest) => {
    if (String(p) === jp) {
      const e = new Error('EPERM: injected truncate failure')
      e.code = 'EPERM'
      throw e
    }
    return fs.truncateSync(p, ...rest)
  }
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1 }
  try {
    const store = makeStore({ dir, maxSize: 3, fsImpl: fsWrap, constants })
    store.saveBatch([{ id: 'f', title: 'FILTERED', _f: true }, { id: 'a', title: 'A' }, { id: 'b', title: 'B' }], NAME)
    store.saveBatch([{ id: 'c', title: 'C' }], NAME)
    // 崩溃现场自证：快照已是裁剪后的 [a,b,c]，journal 因 truncate 失败仍留着 f 的 put
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(fp, 'utf8')).map(m => m.id), ['a', 'b', 'c'], '快照必须已写成裁剪后的内容')
    const journalRecords = readJournalRecords(jp)
    assert.ok(journalPuts(journalRecords).some((put) => put.id === 'f' && put.title === 'FILTERED'), 'journal 必须仍含 _f 条目的 put（构造「journal 未截断」窗口）')
    assert.ok(journalRecords.some((rec) => rec.ckpt === true), 'truncate 失败前必须先追加检查点（否则旧行会被重复回放）')
    const reopened = makeStore({ dir, maxSize: 3 })
    const got = reopened.readMessages(fp)
    const oldView = makeStore({ dir, maxSize: 3, constants: { JOURNAL_READ_ENABLED: false } }).readMessages(fp)
    assert.deepStrictEqual(got, oldView, '同一磁盘状态下，journal 读路径必须与旧读路径（只看快照）逐条一致')
    assert.deepStrictEqual(got.map(m => m.id), ['a', 'b', 'c'], '被裁剪的 _f 条目不得复活，活条目顺序不得变')
    assert.strictEqual(reopened.has({ id: 'a', title: 'A' }, NAME), true, '被挤掉的活条目 a 的判重记忆不得丢失')
    assert.strictEqual(reopened.has({ id: 'b', title: 'B' }, NAME), true)
    assert.strictEqual(reopened.has({ id: 'f', title: 'FILTERED', _f: true }, NAME), false, '被裁剪的 _f 条目不得判重命中（上游重发要能重新评估）')
  } finally {
    clock.restore()
  }
})

check('J3-08 检查点（ckpt）：合并时被裁掉的 _f 记录不得靠 ckpt 之前的旧行复活', () => {
  // 合并（compaction）自己也会裁剪（条数/字节上限），这些被裁身份没有 drop 行可记；`_f` 又不落墓碑，
  // 只能靠「ckpt 之前的行已被快照吸收、读端不回放」来挡住。修前 ckpt 行被当坏行、旧 put 照旧回放，
  // 会把 f 追加到尾部（大 maxSize 下直接多出一条判重记录，小 maxSize 下再挤掉最旧的活条目）。
  const dir = tmpDir('ckpt')
  const NAME = 'push.json'
  const fp = path.join(dir, NAME)
  const jp = journalPathFor(fp)
  const snapshot = [{ id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }]
  fs.writeFileSync(fp, JSON.stringify(snapshot))
  const lines = [
    { v: 2, at: 100, put: [{ id: 'f', title: 'FILTERED', _f: true }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }] },
    { v: 2, at: 200, ckpt: true },
    { v: 2, at: 300, put: [{ id: 'e', title: 'E' }] }
  ]
  fs.writeFileSync(jp, lines.map(l => JSON.stringify(l) + '\n').join(''))
  const reopened = makeStore({ dir, maxSize: 100 })
  const got = reopened.readMessages(fp)
  assert.deepStrictEqual(got.map(m => m.id), ['b', 'c', 'd', 'e'], 'ckpt 之前的行（含被合并裁掉的 _f）不得回放，ckpt 之后的新行必须照常回放')
  assert.strictEqual(reopened.has({ id: 'f', title: 'FILTERED', _f: true }, NAME), false, '被裁的 _f 记录不得复活')
  assert.strictEqual(reopened.has({ id: 'e', title: 'E' }, NAME), true)
})

// ============================================================
section('4. fail-closed：journal 读失败绝不能当成「没有日志」')
// ============================================================
check('J4-01 journal 路径被目录占位（unsafe）：readMessages 必须返回空集 + 写闸门，不得按空缓存放行', () => {
  const dir = tmpDir('unsafe')
  const NAME = 'push.json'
  const store = makeStore({ dir, maxSize: 100 })
  const fp = store.getFilePath(NAME)
  fs.writeFileSync(fp, JSON.stringify([{ id: 'a', title: 'A' }]))
  fs.mkdirSync(journalPathFor(fp)) // 非常规文件
  const reopened = makeStore({ dir, maxSize: 100 })
  let got
  const errs = []
  const origError = console.error
  console.error = (...a) => errs.push(a.map(String).join(' '))
  try { got = reopened.readMessages(fp) } finally { console.error = origError }
  assert.deepStrictEqual(got, [], 'journal 不可读时不得只返回快照（那会把快照外的新增当成新消息重推）')
  assert.ok(errs.some(e => e.includes('fail-closed')), `必须点名 fail-closed（实际：${JSON.stringify(errs)}）`)
  // 写闸门：本轮必须拒绝写入（否则内存与磁盘分叉）
  assert.strictEqual(reopened.save({ id: 'b', title: 'B' }, NAME), false, 'journal 读失败必须拒绝写入')
  assert.strictEqual(reopened.has({ id: 'b' }, NAME), false)
})

check('J4-02 journal 超过读端上限（tooLarge）：同样 fail-closed，不整读、不假装空日志', () => {
  const dir = tmpDir('big')
  const NAME = 'push.json'
  const store = makeStore({ dir, maxSize: 100 })
  const fp = store.getFilePath(NAME)
  fs.writeFileSync(fp, JSON.stringify([{ id: 'a', title: 'A' }]))
  // 超过 JOURNAL_READ_MAX_BYTES 不现实（64MiB），用稀疏文件造同尺寸
  const jp = journalPathFor(fp)
  fs.closeSync(fs.openSync(jp, 'w'))
  fs.truncateSync(jp, JOURNAL_READ_MAX_BYTES + 1)
  const reopened = makeStore({ dir, maxSize: 100 })
  const got = quietly(() => reopened.readMessages(fp))
  assert.deepStrictEqual(got, [])
  assert.strictEqual(reopened.save({ id: 'b', title: 'B' }, NAME), false)
})

// ============================================================
section('5. 合并顺序与失败语义')
// ============================================================

check('J5-01 合并顺序：先 writeAtomic 写快照，成功后才 truncate journal（顺序反了=丢判重记忆）', () => {
  const dir = tmpDir('order')
  const NAME = 'push.json'
  const events = []
  const fsWrap = Object.create(fs)
  fsWrap.truncateSync = (p, len) => { events.push('truncate'); return fs.truncateSync(p, len) }
  const storageWrap = Object.assign({}, storage, {
    writeAtomic: (p, text, label) => { const ok = storage.writeAtomic(p, text, label); events.push('write:' + label); return ok }
  })
  const store = makeStore({ dir, maxSize: 100, fsImpl: fsWrap, storageImpl: storageWrap, constants: { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1 } })
  const fp = store.getFilePath(NAME)
  store.saveBatch([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], NAME)
  assert.ok(events.includes('write:缓存合并'), `必须触发合并（实际：${JSON.stringify(events)}）`)
  const w = events.indexOf('write:缓存合并')
  const t = events.indexOf('truncate')
  assert.ok(w >= 0 && t > w, `truncate 必须晚于快照写入（实际：${JSON.stringify(events)}）`)
  assert.strictEqual(fs.statSync(journalPathFor(fp)).size, 0, '合并成功后日志必须清空')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fp, 'utf8')).map(m => m.id), ['a', 'b'])
})

check('J5-02 合并写失败：保留 journal 原样、下次重试，且本次追加仍算成功（不得丢已追加的变更）', () => {
  const dir = tmpDir('failsafe')
  const NAME = 'push.json'
  let failNext = false
  const storageWrap = Object.assign({}, storage, {
    writeAtomic: (p, text, label) => {
      if (failNext && label === '缓存合并') { failNext = false; return false }
      return storage.writeAtomic(p, text, label)
    }
  })
  const store = makeStore({ dir, maxSize: 100, storageImpl: storageWrap, constants: { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 1 } })
  const fp = store.getFilePath(NAME)
  store.saveBatch([{ id: 'a', title: 'A' }], NAME) // 首次合并成功
  const jp = journalPathFor(fp)
  failNext = true
  const errs = []
  const origError = console.error
  console.error = (...a) => errs.push(a.map(String).join(' '))
  let ok
  try { ok = store.saveBatch([{ id: 'b', title: 'B' }], NAME) } finally { console.error = origError }
  assert.strictEqual(ok, true, '合并失败不得让「已追加成功」的批次报失败')
  assert.ok(journalPuts(readJournalRecords(jp)).some((put) => put.id === 'b'), '合并失败后日志必须原样保留（下轮重试）')
  assert.ok(errs.some(e => e.includes('合并写盘失败')), `合并失败必须留痕（实际：${JSON.stringify(errs)}）`)
  // 下轮重试成功：日志清空、快照含两条
  store.saveBatch([{ id: 'c', title: 'C' }], NAME)
  const reopened = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  assert.deepStrictEqual(reopened.readMessages(fp).map(m => m.id), ['a', 'b', 'c'])
  assert.strictEqual(fs.statSync(jp).size, 0, '重试成功后日志必须清空')
})

check('J5-03 journal 新建必须 0600，且截断后仍是 0600', () => {
  const dir = tmpDir('mode')
  const NAME = 'push.json'
  const store = makeStore({ dir, maxSize: 100, constants: { JOURNAL_DIRECT_MAX_BYTES: 0 } })
  const fp = store.getFilePath(NAME)
  store.saveBatch([{ id: 'a', title: 'A' }], NAME)
  const jp = journalPathFor(fp)
  assert.strictEqual(fs.statSync(jp).mode & 0o777, 0o600, '判重日志含推送历史，不得组/他人可读')
})

// ============================================================
section('6. 体积：100 轮 × 20 条新增')
// ============================================================

check('J6-01 写盘字节 < 100 MB（旧实现同场景对照），且日志模式至少省一个数量级', () => {
  const clock = virtualClock()
  try {
    const payload = 'x'.repeat(800)
    const build = (round) => {
      const arr = []
      for (let i = 0; i < 20; i++) {
        const n = round * 20 + i
        arr.push({ id: 'vol-' + n, title: 'vol-' + n, content: payload })
      }
      return arr
    }
    function measure (constants) {
      const dir = tmpDir('vol')
      const counter = { bytes: 0 }
      const fsWrap = Object.create(fs)
      fsWrap.appendFileSync = (p, data, opts) => {
        counter.bytes += Buffer.byteLength(String(data), 'utf8')
        return fs.appendFileSync(p, data, opts)
      }
      const storageWrap = Object.assign({}, storage, {
        writeAtomic: (p, text, label) => {
          counter.bytes += Buffer.byteLength(String(text), 'utf8')
          return storage.writeAtomic(p, text, label)
        }
      })
      const store = makeStore({ dir, maxSize: 5000, fsImpl: fsWrap, storageImpl: storageWrap, constants })
      for (let round = 0; round < 100; round++) {
        clock.advance(60000)
        store.saveBatch(build(round), 'push.json')
      }
      const fp = store.getFilePath('push.json')
      const finalBytes = fs.statSync(fp).size
      return { bytes: counter.bytes, finalBytes }
    }
    const oldImpl = measure({ JOURNAL_MAX_BYTES: 0 })
    const journalImpl = measure({ JOURNAL_DIRECT_MAX_BYTES: 0 })
    console.log(`      旧实现写盘 ${(oldImpl.bytes / 1024 / 1024).toFixed(1)} MB；journal 实现 ${(journalImpl.bytes / 1024 / 1024).toFixed(1)} MB；最终快照 ${(journalImpl.finalBytes / 1024 / 1024).toFixed(1)} MB`)
    assert.ok(journalImpl.bytes < 100 * 1024 * 1024, `journal 实现写盘必须 < 100MB，实际 ${journalImpl.bytes}`)
    assert.ok(oldImpl.bytes > 50 * 1024 * 1024, `旧实现同场景必须明显更大（否则对照无效），实际 ${oldImpl.bytes}`)
    assert.ok(journalImpl.bytes * 10 < oldImpl.bytes, `必须至少省一个数量级（old=${oldImpl.bytes} new=${journalImpl.bytes}）`)
  } finally {
    clock.restore()
  }
})

// ============================================================
section('7. 控制台读路径共用口径（signature 必须把 journal 算进 key）')
// ============================================================

check('J7-01 defaultMessageSignature：journal 变化必须让签名变化（否则控制台 60s 缓存读旧数据）', () => {
  const dir = tmpDir('sig')
  fs.writeFileSync(path.join(dir, 'push.json'), '[]')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(path.join(dir, 'push.json'), old, old)
  const sigNoJournal = defaultMessageSignature(dir, 32 * 1024 * 1024, 100)
  assert.ok(sigNoJournal && sigNoJournal.endsWith('jnone'), `无日志时应带 jnone 标识（实际 ${sigNoJournal}）`)
  const jp = path.join(dir, 'push.json' + JOURNAL_SUFFIX)
  fs.writeFileSync(jp, JSON.stringify({ v: 1, at: 1, put: [{ id: 'a' }] }) + '\n')
  fs.utimesSync(jp, old, old)
  const sig1 = defaultMessageSignature(dir, 32 * 1024 * 1024, 100)
  assert.notStrictEqual(sig1, sigNoJournal, 'journal 出现后签名必须变化')
  fs.appendFileSync(jp, JSON.stringify({ v: 1, at: 2, put: [{ id: 'b' }] }) + '\n')
  fs.utimesSync(jp, old, old)
  const sig2 = defaultMessageSignature(dir, 32 * 1024 * 1024, 100)
  assert.notStrictEqual(sig2, sig1, 'journal 追加后签名必须变化（size/mtime 已折进 key）')
})

// ============================================================
section('8. P3 常驻进程：判重快照 / 墓碑的内存新鲜度')
// ============================================================

const identityMsg = (id) => ({ id, title: 'title-' + id, content: 'content-' + id })

check('J8-01 外部进程向 journal 追加一条 → 同进程 readMessages 能看见（_memoSig 必须含 journal 签名）', () => {
  const dir = tmpDir('memo-journal-append')
  const NAME = 'push.json'
  // 强制走 journal（JOURNAL_DIRECT_MAX_BYTES=0），并放大合并阈值保证本轮不会把 journal 合并掉。
  const store = makeStore({
    dir,
    maxSize: 5000,
    constants: { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 64 * 1024 * 1024, JOURNAL_MAX_AGE_MS: 365 * 24 * 3600 * 1000 }
  })
  const batch = []
  for (let i = 0; i < 200; i++) batch.push(identityMsg('base-' + i))
  assert.strictEqual(store.saveBatch(batch, NAME), true, 'saveBatch 应成功')
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  // CodeQL js/file-system-race：check（size>0）与 use（追加一行）必须落在**同一个 fd** 上，不能
  // statSync(路径) 之后再 appendFileSync(同一路径)。这里 open 一次拿 fd，fstatSync(fd) 取大小做
  // 「必须真的走 journal」断言，再用同一个 fd writeSync 追加。open 'a' 会创建空文件，所以 journal
  // 根本没被创建时 size 仍是 0、断言照旧变红——检出力不丢。
  const jfd = fs.openSync(jp, 'a')
  try {
    assert.ok(fs.fstatSync(jfd).size > 0, '200 条必须真的走 journal（否则用例没覆盖主写路径）')
    assert.strictEqual(store.readMessages(fp).length, 200, '本进程应读到 200 条')
    // 另一个运行进程只追加 journal（v3.412 起生产主写路径）：push.json 的 ino/size/mtime 完全不变。
    fs.writeSync(jfd, JSON.stringify({ v: JOURNAL_VERSION, at: Date.now(), put: [identityMsg('external-1')] }) + '\n')
  } finally {
    fs.closeSync(jfd)
  }
  const reread = store.readMessages(fp)
  assert.strictEqual(reread.length, 201, `外部追加 journal 后同进程必须看见（实际 ${reread.length} 条）`)
  assert.ok(reread.some((m) => m.id === 'external-1'), '必须包含外部进程追加的消息')
})

check('J8-02 journal 被外部删除/截断/重写 → 内存快照失效并按磁盘重读', () => {
  const dir = tmpDir('memo-journal-rotate')
  const NAME = 'push.json'
  const store = makeStore({
    dir,
    maxSize: 5000,
    constants: { JOURNAL_DIRECT_MAX_BYTES: 0, JOURNAL_MAX_BYTES: 64 * 1024 * 1024, JOURNAL_MAX_AGE_MS: 365 * 24 * 3600 * 1000 }
  })
  const batch = []
  for (let i = 0; i < 200; i++) batch.push(identityMsg('base-' + i))
  assert.strictEqual(store.saveBatch(batch, NAME), true)
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  assert.strictEqual(store.readMessages(fp).length, 200)
  // 外部删除（轮转/人工清理）：push.json 仍是空快照 ⇒ 必须按磁盘重读成 0 条，不能继续用内存 200 条。
  fs.rmSync(jp)
  assert.strictEqual(store.readMessages(fp).length, 0, 'journal 被外部删除后必须按磁盘重读（push.json 未合并 ⇒ 0 条）')
  // 外部重写成另一份日志：必须看见新内容、旧内容不再可见。
  fs.writeFileSync(jp, JSON.stringify({ v: JOURNAL_VERSION, at: Date.now(), put: [identityMsg('rotated-1')] }) + '\n')
  assert.deepStrictEqual(store.readMessages(fp).map((m) => m.id), ['rotated-1'], 'journal 被外部重写后必须按新内容重读')
  // 外部 truncate 成 0：等价于「日志被清空」，必须回到快照内容（此处 0 条）。
  fs.truncateSync(jp, 0)
  assert.strictEqual(store.readMessages(fp).length, 0, 'journal 被外部截断后必须判为不新鲜并重读')
})

check('J8-03 外部删除 .seen.json 后同进程不再用旧墓碑；外部新增墓碑后同进程能看见', () => {
  const dir = tmpDir('memo-tombstone')
  const store = makeStore({ dir, maxSize: 1000 })
  const fp = path.join(dir, 'push.json')
  fs.writeFileSync(fp, '[]')
  const seen = fp + '.seen.json'
  const writeSeen = (ids) => {
    // 真实写方是 writeAtomic（rename 换 inode）；这里同样先删再写，覆盖 inode 变化。
    fs.rmSync(seen, { force: true })
    fs.writeFileSync(seen, JSON.stringify({ v: 1, id: ids, urlOnly: [], idWithUrl: [], anon: [] }))
  }
  writeSeen(['tomb-old'])
  assert.strictEqual(store._tombstoneHasIdentity(fp, { id: 'tomb-old' }), true, '磁盘已有墓碑应命中')
  // 控制台导入/恢复的动作就是 unlink <push.json>.seen.json（removeStaleTombstoneFile）；
  // worker 是另一个进程，必须丢掉导入前的内存墓碑，否则本应重推的身份被永久静默漏推。
  fs.rmSync(seen)
  assert.strictEqual(store._tombstoneHasIdentity(fp, { id: 'tomb-old' }), false,
    '外部删除 .seen.json 后不得再用旧内存墓碑')
  // 反向：worker 先缓存空集，外部新增墓碑后必须能看见（否则导入进来的墓碑身份被重推）。
  writeSeen(['tomb-new'])
  assert.strictEqual(store._tombstoneHasIdentity(fp, { id: 'tomb-new' }), true,
    '外部新增墓碑后同进程必须能看见')
  // 外部替换成另一份墓碑：旧身份失效、新身份命中。
  writeSeen(['tomb-replaced'])
  assert.strictEqual(store._tombstoneHasIdentity(fp, { id: 'tomb-new' }), false, '外部替换墓碑后旧身份必须失效')
  assert.strictEqual(store._tombstoneHasIdentity(fp, { id: 'tomb-replaced' }), true)
  // 本进程写完墓碑后必须立刻记录最新签名（后续判重直接信任内存，不退化成每轮全量重读）。
  store._tombstoneDropped(fp, [{ id: 'drop-1' }], 1000)
  assert.strictEqual(store._tombstoneSig[fp], store._tombstoneFileSig(fp),
    '本进程写墓碑后记录的签名必须与磁盘一致')
  assert.strictEqual(store._tombstoneHasIdentity(fp, { id: 'drop-1' }), true, '本进程刚写的墓碑必须命中')
})

// ============================================================
section('9. v3.534：`_f` 写盘瘦身（journal 行同口径）')
// ============================================================

check('J9-01 journal 行的 _f put 已瘦身：日志不带 content/content_html，普通条目正文完整，重启后身份仍命中', () => {
  const NAME = 'push.json'
  const dir = tmpDir('slim-f-journal')
  // 强制纯日志模式（小块直写会把整份快照写进 push.json、日志里什么都没有，等于没测到 journal 行）
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0 }
  const store = makeStore({ dir, maxSize: 100, constants })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  const fBody = '过滤未推正文-'.repeat(40)
  const fHtml = '<p>' + '过滤未推正文-'.repeat(40) + '</p>'
  assert.strictEqual(store.saveBatch([
    { id: 'f1', url: 'https://u.example/f1', title: 'F1', content: fBody, content_html: fHtml, _f: true },
    { id: 'n1', url: 'https://u.example/n1', title: 'N1', content: '正常正文', content_html: '<p>正常正文</p>' }
  ], NAME), true)
  const put = journalPuts(readJournalRecords(jp)).filter((m) => m && m.id)
  const f = put.find((m) => m.id === 'f1')
  const n = put.find((m) => m.id === 'n1')
  assert.ok(f && n, `journal 的 put 必须同时含 f1 与 n1（实际：${JSON.stringify(put.map((m) => m.id))}）`)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(f, 'content'), false, 'journal 行里的 _f（id+url 齐全）不得带 content（否则新日志行把快照刚瘦掉的字节原样带回来）')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(f, 'content_html'), false, 'journal 行里的 _f 不得带 content_html')
  assert.strictEqual(f.url, 'https://u.example/f1', '身份字段 url 必须原样保留')
  assert.strictEqual(f._f, true, '_f 标记必须保留（规则变更时靠它整批重评）')
  assert.strictEqual(n.content, '正常正文', '普通条目的 content 必须逐字完整')
  assert.strictEqual(n.content_html, '<p>正常正文</p>', '普通条目的 content_html 必须逐字完整')
  // 最后一条兜底：journal 文件**整体**不得残留 _f 正文。判据落在解析后的结构上，而不是文件文本片段——
  // ① 逐行 JSON.parse（非空行必须全部可解析 ⇒ 同时证明文件里没有非 JSON 垃圾行）；
  // ② 递归收集每条记录里的全部字符串值（含嵌套对象/数组，覆盖 content/content_html 与任何新字段），
  //    断言没有任何一个字符串包含正文标记（不是只查两个已知键，新加的正文类字段同样会被兜住）；
  // ③ 字节量级：无正文时整份 journal 几百字节，f1 的 content+content_html（各 ~840 B）一旦残留会让
  //    体积翻数倍，故用体积上限兜住「解析看不到但字节还在」的形态（量纲比较不计入源码文本断言）。
  const F_BODY_MARK = '过滤未推正文'
  const journalLines = fs.readFileSync(jp, 'utf8').split('\n').filter((line) => line.trim().length > 0)
  assert.ok(journalLines.length >= 1, `journal 必须至少有一行非空记录（实际 ${journalLines.length}）`)
  const journalLinesParsed = journalLines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (e) {
      return assert.fail(`journal 第 ${index + 1} 个非空行不是合法 JSON（journal 里不得有非 JSON 垃圾行）：${e.message}`)
    }
  })
  const allStrings = (value, out = []) => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out))
    else if (value && typeof value === 'object') Object.keys(value).forEach((key) => allStrings(value[key], out))
    return out
  }
  const journalStrings = allStrings(journalLinesParsed)
  // 正控：递归遍历必须真的走到正文位置（否则下面的「没有残留」是空断言，遍历写错也能全绿）
  assert.ok(journalStrings.some((s) => s === '正常正文'),
    `递归收集必须覆盖到普通条目的正文（实收 ${journalStrings.length} 个字符串）；否则「无残留」是空断言`)
  const leaked = journalStrings.filter((s) => s.indexOf(F_BODY_MARK) !== -1)
  assert.deepStrictEqual(leaked.map((s) => s.slice(0, 40)), [],
    'journal 记录里不得有任何字符串携带 _f 正文（含嵌套字段）')
  const journalBytes = fs.statSync(jp).size
  assert.ok(journalBytes < 1024,
    `journal 字节必须在无正文上限内（实测 ${journalBytes} B；f1 的 content+content_html 残留约 +1.5 KB）`)
  for (const rec of journalPuts(journalLinesParsed).filter((m) => m && m._f === true)) {
    const recBytes = Buffer.byteLength(JSON.stringify(rec), 'utf8')
    assert.ok(recBytes < 400, `_f 条目的 journal 记录不得携带正文（实测 ${recBytes} B，无正文时约 100 B）`)
  }
  // 重启（新进程语义，只能靠 journal 回放重建）：瘦身不碰 id/url ⇒ 身份必须仍命中
  const reopened = makeStore({ dir, maxSize: 100, constants })
  assert.strictEqual(reopened.has({ id: 'f1', url: 'https://u.example/f1' }, NAME), true, '重启后 _f 身份必须仍可判重命中')
  assert.strictEqual(reopened.has({ id: 'n1' }, NAME), true, '重启后普通条目身份必须仍可判重命中')
  const after = reopened.readMessages(fp)
  assert.deepStrictEqual(after.map((m) => m.id), ['f1', 'n1'], '回放后的顺序与条目集合不得变化')
  assert.strictEqual(after.find((m) => m.id === 'n1').content, '正常正文', '回放后普通条目正文仍完整')
  // 合并写快照（_compact）也必须走同一份投影：磁盘上不能出现「日志瘦、快照胖」。
  // 这里喂的必须是**内存里带正文的 `_f`**（`_memoSet` 里存的就是原对象）：上面的 `after` 来自
  // journal 回放、本来就没有 content/content_html，拿它喂 `_compact` 是自证断言——`_compact`
  // 就算完全不投影，落盘快照照样无正文，这只用例照样全绿（B 路复查指出的缺陷）。
  const inMemory = [
    { id: 'f1', url: 'https://u.example/f1', _f: true, content: fBody, content_html: fHtml },
    { id: 'n1', content: '正常正文', content_html: '<p>正常正文</p>' }
  ]
  assert.strictEqual(reopened._compact(fp, inMemory), true, '合并必须成功')
  const snap = JSON.parse(fs.readFileSync(fp, 'utf8'))
  assert.strictEqual(snap.length, 2, '合并后的快照必须含两条')
  const snapF = snap.find((m) => m.id === 'f1')
  assert.ok(snapF, `合并后的快照必须含 f1（实际：${JSON.stringify(snap.map((m) => m.id))}）`)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapF, 'content'), false, '合并写快照时 _f 同样不得带 content（喂的是内存里带正文的原对象）')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(snapF, 'content_html'), false, '合并写快照时 _f 同样不得带 content_html')
  assert.strictEqual(snapF.url, 'https://u.example/f1', '合并写快照后 _f 的身份字段 url 必须原样保留')
  assert.strictEqual(snapF._f, true, '合并写快照后 _f 标记必须保留')
  // 与 journal 侧同一口径：递归收集快照里的全部字符串值（含嵌套字段），不得有任何一处携带 _f 正文
  const snapStrings = allStrings(snap)
  assert.ok(snapStrings.some((s) => s === '正常正文'),
    `递归收集必须覆盖到普通条目的正文（实收 ${snapStrings.length} 个字符串）；否则下面的「无残留」是空断言`)
  assert.deepStrictEqual(snapStrings.filter((s) => s.indexOf(F_BODY_MARK) !== -1).map((s) => s.slice(0, 40)), [],
    '合并后的快照里不得有任何字符串携带 _f 正文（含嵌套字段）')
  assert.strictEqual(snap.find((m) => m.id === 'n1').content, '正常正文', '快照里普通条目正文必须完整')
  assert.strictEqual(snap.find((m) => m.id === 'n1').content_html, '<p>正常正文</p>', '快照里普通条目 content_html 必须完整')
  // 回放（新实例，只能读磁盘快照）：顺序、正文、判重身份都不得因合并而变
  const reread = makeStore({ dir, maxSize: 100, constants })
  const replayed = reread.readMessages(fp)
  assert.deepStrictEqual(replayed.map((m) => m.id), ['f1', 'n1'], '合并写快照后回放的顺序与条目集合不得变化')
  assert.strictEqual(replayed.find((m) => m.id === 'n1').content, '正常正文', '合并后普通条目正文回放仍完整')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(replayed.find((m) => m.id === 'f1'), 'content'), false, '合并后的磁盘快照回放时 _f 仍无正文')
  assert.strictEqual(reread.has({ id: 'f1', url: 'https://u.example/f1' }, NAME), true, '合并后 _f 身份仍可判重命中')
  assert.strictEqual(reread.has({ id: 'n1' }, NAME), true, '合并后普通条目身份仍可判重命中')
})

check('J9-02 读端兜底裁剪（maxSize 下调 + journal 回放）必须与写路径同口径：_f 先出局、已推送条目不被挤掉', () => {
  const NAME = 'push.json'
  // 直接写快照 + 手写 journal 行（不经 store），避免写路径自己先裁一遍把现场做平。
  const setup = (tag) => {
    const dir = tmpDir('trim-f-' + tag)
    const fp = path.join(dir, NAME)
    fs.writeFileSync(fp, JSON.stringify([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'f', url: 'https://u.example/f', title: 'F', _f: true }
    ]))
    fs.writeFileSync(journalPathFor(fp), JSON.stringify({ v: 2, at: 100, put: [{ id: 'c', title: 'C' }] }) + '\n')
    return { dir, fp }
  }
  // 场景 1：上限 3、回放后 4 条 ⇒ 只超 1 条，必须淘汰 `_f`（f），不能动数组最旧的活条目 a。
  // 修前实测：返回 ['b','f','c']（a 被误删并落墓碑）——等于让 `_f` 挤掉已推送记录的判重记忆。
  {
    const { dir, fp } = setup('keep')
    const beforeBytes = fs.readFileSync(fp)
    const store = makeStore({ dir, maxSize: 3 })
    const got = store.readMessages(fp)
    assert.deepStrictEqual(got.map((m) => m.id), ['a', 'b', 'c'],
      '上限 3 + 回放 1 条：必须先淘汰 _f，已推送的 a/b 保命')
    assert.strictEqual(store.has({ id: 'a' }, NAME), true, '活条目 a 的判重记忆不得丢失')
    assert.strictEqual(store.has({ id: 'b' }, NAME), true, '活条目 b 的判重记忆不得丢失')
    assert.strictEqual(store.has({ id: 'f' }, NAME), false, '被淘汰的 _f 不落墓碑：回到上游要能重新评估')
    assert.deepStrictEqual(fs.readFileSync(fp), beforeBytes, '读路径不得写盘（push.json 字节不变）')
  }
  // 场景 2：上限 2、回放后 4 条 ⇒ 两个名额：`_f` 先出局，不足再按数组序取最旧的 a（必须落墓碑）。
  {
    const { dir, fp } = setup('drop')
    const beforeBytes = fs.readFileSync(fp)
    const store = makeStore({ dir, maxSize: 2 })
    const got = store.readMessages(fp)
    assert.deepStrictEqual(got.map((m) => m.id), ['b', 'c'], '上限 2：_f 先出局，再从最旧的活条目收敛到上限')
    assert.strictEqual(store.has({ id: 'a' }, NAME), true, '被读端裁掉的活条目 a 必须由墓碑拦下（fail-closed）')
    assert.strictEqual(store.has({ id: 'f' }, NAME), false, '被淘汰的 _f 不落墓碑')
    assert.deepStrictEqual(fs.readFileSync(fp), beforeBytes, '读路径不得写盘（push.json 字节不变）')
  }
})

// ============================================================
section('10. W5：投影判据与 getMessageIdentity 同源 / 字节上限 `_f` 优先 / drop 行只留身份')
// ============================================================

check('J10-01 legacy「anon:<hex> id + 非法 url」的 _f：投影必须保留正文（身份不得翻转），save→read 后 has() 仍命中、saveBatch 不重复收录', () => {
  const NAME = 'push.json'
  const dir = tmpDir('w5-legacy-anon-id')
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0 }
  const store = makeStore({ dir, maxSize: 100, constants })
  const fp = store.getFilePath(NAME)
  const jp = journalPathFor(fp)
  // 构造「历史匿名合成键」：id 就是这条消息自身内容的 anonKey（getMessageIdentity 会对
  // 「anon:<hex> id + 不可用 url」降级成内容 anon 身份），url='#' 在 validUrl 下不可用。
  const seed = { title: 'W5 匿名标题', content: 'W5匿名正文-'.repeat(20) }
  const anonKey = Utils.getMessageIdentity(seed).key
  assert.match(anonKey, /^anon:[0-9a-f]+$/, '前置：无 id/url 的消息应得内容匿名身份')
  const legacy = { id: anonKey, url: '#', title: seed.title, content: seed.content, _f: true }
  assert.strictEqual(Utils.getMessageIdentity(legacy).kind, 'anon', '前置：该条目的身份必须已降级成 anon（否则本用例没有判别力）')
  // 判据：删掉正文后身份会从 anon 翻转成 id:anon:… ⇒ 不允许投影
  assert.strictEqual(canDropBody(legacy, Utils), false, '身份依赖正文时必须判「不能丢正文」')
  assert.strictEqual(toDiskEntry(legacy, Utils), legacy, '不能安全丢正文时必须原样返回同一对象（保留正文）')
  // 快照路径：save → 磁盘上正文仍在 → 新进程 read 后 has() 仍命中
  assert.strictEqual(store.saveMessages(fp, [legacy]), true, '保存必须成功')
  const onDisk = JSON.parse(fs.readFileSync(fp, 'utf8'))
  assert.strictEqual(onDisk.length, 1)
  assert.strictEqual(onDisk[0].content, legacy.content, '身份依赖正文的 _f 不得被投影掉 content（否则身份翻转）')
  const reopened = makeStore({ dir, maxSize: 100, constants })
  assert.strictEqual(reopened.has(legacy, NAME), true, '重启后（读到落盘快照）原身份必须仍判重命中')
  // journal 路径同一判据：新批次写入的 put 行同样不得删正文
  assert.strictEqual(reopened.saveBatch([{ id: 'n1', title: 'N1', content: '正常正文' }], NAME), true)
  const putRows = journalPuts(readJournalRecords(jp))
  const legacyRow = putRows.concat(JSON.parse(fs.readFileSync(fp, 'utf8')).filter((m) => m._f === true))
    .find((m) => m && m.id === anonKey)
  assert.ok(legacyRow, '前置：journal 或快照里必须能找到这条 legacy 条目')
  // 同一身份再喂一次：不得重复收录（修前实测 1→2）
  assert.strictEqual(reopened.saveBatch([legacy], NAME), true)
  const after = reopened.readMessages(fp)
  assert.strictEqual(after.length, 2, `同一身份重放不得重复收录（实际 ${after.length} 条：${JSON.stringify(after.map((m) => m.id))}）`)
  assert.strictEqual(after.filter((m) => m.id === anonKey).length, 1, 'legacy anon 身份必须仍只有 1 条')
})

check('J10-02 空白 id（trim 后为空）的 _f 同样保留正文；id+url 齐全的普通 _f 仍瘦身；url 为空的 _f 行为不变（收紧而非放宽）', () => {
  const blank = { id: '   ', url: 'javascript:void(0)', title: '空白 id', content: 'C'.repeat(200), _f: true }
  assert.strictEqual(Utils.getMessageIdentity(blank).kind, 'anon', '前置：空白 id + 不可用 url 应降级成内容 anon 身份')
  assert.strictEqual(canDropBody(blank, Utils), false, '空白 id 的身份依赖正文 ⇒ 不能投影')
  assert.strictEqual(toDiskEntry(blank, Utils), blank, '空白 id 的 _f 必须保留正文（原实现按 id !== "" 误判为可投影）')
  const slim = { id: 'ok-1', url: 'https://u.example/ok-1', title: 'T', content: 'C'.repeat(200), content_html: '<p>C</p>', _f: true }
  assert.strictEqual(canDropBody(slim, Utils), true, 'id+url 齐全且身份只认 id ⇒ 可投影')
  const proj = toDiskEntry(slim, Utils)
  assert.notStrictEqual(proj, slim, '可投影时必须返回浅拷贝（内存对象不动）')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(proj, 'content'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(proj, 'content_html'), false)
  assert.strictEqual(slim.content, 'C'.repeat(200), '投影不得改动内存里的原对象')
  // 既有行为锁定（w3b ①② 的 f3）：url 缺失/为空的 _f 保留正文——W5 只收紧，不得放宽
  const f3 = { id: 'f3', url: '', title: 'F3', content: 'x'.repeat(50), _f: true }
  assert.strictEqual(toDiskEntry(f3, Utils), f3, 'url 为空的 _f 必须保留正文（既有测试锁定的行为）')
  assert.strictEqual(toDiskEntry({ id: 'f4', title: 'F4', content: 'y'.repeat(50), _f: true }, Utils).content, 'y'.repeat(50), '缺 url 的 _f 必须保留正文')
  // 非 _f 条目永不投影（写盘瘦身只针对过滤未推条目）
  const pushed = { id: 'p1', url: 'https://u.example/p1', content: 'z'.repeat(50) }
  assert.strictEqual(toDiskEntry(pushed, Utils), pushed, '已推送条目必须原样写盘')
})

check('J10-03 超字节上限淘汰与条数上限共用 selectEvictionIndices：先淘汰 `_f`（哪怕它最新），已推送条目仍在', () => {
  // 「超 64 MiB 且含 _f」的同一段代码路径：用注入的小上限代替 64 MiB（真 64 MiB 夹具会把套件变成内存大户，
  // maxBytes 只是 _trimCacheByBytes 的参数，生产恒为 MESSAGE_CACHE_MAX_BYTES）
  const dir = tmpDir('w5-bytes-f-first')
  const NAME = 'push.json'
  const p1 = { id: 'p1', title: 'P1', content: 'a'.repeat(120) }
  const p2 = { id: 'p2', title: 'P2', content: 'b'.repeat(120) }
  const fNew = { id: 'f-new', url: 'https://u.example/f-new', title: 'F', content: 'c'.repeat(400), _f: true }
  const all = [p1, p2, fNew]
  const project = (m) => toDiskEntry(m, Utils)
  const keepBoth = Buffer.byteLength(JSON.stringify([p1, p2].map(project)), 'utf8')
  const maxBytes = keepBoth + 8 // 放得下两条已推送，放不下再加最新那条 _f
  assert.ok(Buffer.byteLength(JSON.stringify(all.map(project)), 'utf8') > maxBytes, '前置：三整份必须超限（否则不会走裁剪）')
  const store = makeStore({ dir, maxSize: 100, constants: { MESSAGE_CACHE_MAX_BYTES: maxBytes } })
  const fp = path.join(dir, NAME)
  const toSave = [...all]
  const dropped = []
  const text = store._trimCacheByBytes(JSON.stringify(all.map(project)), toSave, fp, maxBytes, dropped, project)
  assert.strictEqual(typeof text, 'string', '超限必须裁剪出可读文本')
  assert.ok(Buffer.byteLength(text, 'utf8') <= maxBytes, '产出必须 ≤ maxBytes（防读端 tooLarge 自锁）')
  assert.deepStrictEqual(JSON.parse(text).map((m) => m.id), ['p1', 'p2'], '字节上限必须淘汰最新的 _f，而不是最旧的已推送条目（w3b 5.2 修前实测丢掉 pushed1）')
  assert.deepStrictEqual(toSave.map((m) => m.id), ['p1', 'p2'], '幸存者必须按原数组顺序写回入参（内存快照/tombstone 依赖它）')
  assert.deepStrictEqual(dropped.map((m) => m.id), ['f-new'], '被淘汰条目必须上报 droppedOut（journal drop 与墓碑语义不变）')
  // 与条数上限同一淘汰函数：同一集合、同样超 1 条 ⇒ 丢同一条
  const byCount = [...all]
  assert.deepStrictEqual(trimMessagesToMaxSize(byCount, 2).map((m) => m.id), ['f-new'], '条数上限必须与字节上限同口径')
  assert.deepStrictEqual(byCount.map((m) => m.id), ['p1', 'p2'], '条数上限的幸存者顺序同样不变')
  assert.deepStrictEqual(selectEvictionIndices(all, 1), [2], '淘汰顺序的唯一来源：唯一一条 _f（下标 2）先出局')
  assert.deepStrictEqual(selectEvictionIndices([p1, { id: 'f1', _f: true }, p2, { id: 'f2', _f: true }, { id: 'p3' }], 3), [1, 3, 0],
    '两条 _f 按数组序先出局，不足才轮到最旧的已推送条目')
  // `_f` 用尽后继续按「最旧优先」淘汰已推送条目
  const tight = Buffer.byteLength(JSON.stringify([p2].map(project)), 'utf8')
  const toSave2 = [...all]
  const dropped2 = []
  const text2 = store._trimCacheByBytes(JSON.stringify(all.map(project)), toSave2, fp, tight + 8, dropped2, project)
  assert.deepStrictEqual(JSON.parse(text2).map((m) => m.id), ['p2'], '_f 先出局，再淘汰最旧的已推送条目')
  assert.deepStrictEqual(dropped2.map((m) => m.id), ['p1', 'f-new'], 'droppedOut 按数组序收集被淘汰条目')
})

check('J10-04 字节上限单条即超限：仍返回 null、保留原告警文案、不记任何丢弃', () => {
  const dir = tmpDir('w5-bytes-single')
  const store = makeStore({ dir, maxSize: 100, constants: { MESSAGE_CACHE_MAX_BYTES: 64 } })
  const big = { id: 'f-big', url: 'https://u.example/big', content: 'x'.repeat(400), _f: true }
  const toSave = [big, { id: 'f-big2', url: 'https://u.example/big2', content: 'y'.repeat(400), _f: true }]
  const dropped = []
  const warns = captureWarn(() => {
    assert.strictEqual(store._trimCacheByBytes(JSON.stringify(toSave), toSave, path.join(dir, 'push.json'), 64, dropped), null,
      '连单条都放不下时必须返回 null（调用方跳过落盘）')
  })
  assert.ok(warns.some((w) => w.includes('缓存单条消息即超过读端上限')), `必须保留原告警文案：${JSON.stringify(warns)}`)
  assert.strictEqual(dropped.length, 0, 'null 路径不得记为丢弃（没有实际裁掉任何记录）')
  assert.strictEqual(toSave.length, 2, 'null 路径不得改动入参数组的成员')
})

check('J10-05 journal 的 drop 行只留身份：不带 content/content_html，回放仍按 id/url 命中；anon 身份原样保留正文', () => {
  const NAME = 'push.json'
  const constants = { JOURNAL_DIRECT_MAX_BYTES: 0 }
  {
    const dir = tmpDir('w5-drop-slim')
    const store = makeStore({ dir, maxSize: 2, constants })
    const fp = store.getFilePath(NAME)
    const jp = journalPathFor(fp)
    const bodyA = 'A正文-'.repeat(60)
    const a = { id: 'drop-a', url: 'https://u.example/a', title: 'A', content: bodyA, content_html: '<p>' + bodyA + '</p>', timestamp: 111 }
    const b = { id: 'drop-b', url: 'https://u.example/b', title: 'B', content: 'B正文-'.repeat(60) }
    const c = { id: 'drop-c', url: 'https://u.example/c', title: 'C', content: 'C正文-'.repeat(60) }
    assert.strictEqual(store.saveBatch([a, b], NAME), true)
    // 推入第 3 条 ⇒ 条数上限 2，最旧的 a（已推送、非 _f）被淘汰
    assert.strictEqual(store.saveBatch([c], NAME), true)
    const rec = readJournalRecords(jp).find((r) => Array.isArray(r.drop) && r.drop.length > 0)
    assert.ok(rec, '前置：journal 必须记下本批被裁的条目（drop 行）')
    const d = rec.drop[0]
    assert.deepStrictEqual(Object.keys(d).sort(), ['id', 'timestamp', 'url'],
      `drop 行只保留身份与必要字段（实际：${JSON.stringify(d).slice(0, 200)}）`)
    assert.strictEqual(d.id, 'drop-a', '身份字段 id 必须原样保留')
    assert.strictEqual(d.url, 'https://u.example/a', '身份字段 url 必须原样保留（回放的 idWithUrl fallback 依赖它）')
    assert.strictEqual(typeof d.timestamp, 'string', '必要展示字段 timestamp 必须保留')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(d, 'content'), false, 'drop 行不得带 content')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(d, 'content_html'), false, 'drop 行不得带 content_html')
    const allStrings = (value, out = []) => {
      if (typeof value === 'string') out.push(value)
      else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out))
      else if (value && typeof value === 'object') Object.keys(value).forEach((key) => allStrings(value[key], out))
      return out
    }
    assert.ok(allStrings(rec).some((s) => s === 'drop-b') || allStrings(rec).some((s) => s === 'drop-c'),
      '正控：递归遍历必须覆盖到同行的 put（否则「无残留」是空断言）')
    assert.deepStrictEqual(allStrings(rec).filter((s) => s.includes('A正文')).map((s) => s.slice(0, 20)), [],
      'drop 行里不得残留被淘汰条目的正文（含嵌套字段）')
    // 回放：去掉正文的 drop 行必须仍按 id/url 命中（修前若投影 anon 身份会 removed:0）
    const replay = [{ ...a }, { ...b }, { ...c }]
    const r = applyJournalRecords(replay, [{ put: [], drop: rec.drop }], Utils)
    assert.strictEqual(r.removed, 1, 'drop 行必须仍能按身份命中（removed 不得为 0）')
    assert.deepStrictEqual(replay.map((m) => m.id), ['drop-b', 'drop-c'], '回放后只删掉被淘汰的那条')
    // 墓碑口径不变：被淘汰的已推送条目仍按 id 与 url 判重命中
    assert.strictEqual(store.has({ id: 'drop-a', url: 'https://u.example/a' }, NAME), true, '墓碑必须仍按 id+url 命中')
    assert.strictEqual(store.has({ url: 'https://u.example/a' }, NAME), true, '墓碑必须仍按 url 单独命中（idWithUrl fallback）')
  }
  {
    // anon 身份（无 id/url）被淘汰：身份只能靠正文重算 ⇒ drop 行必须原样保留正文，否则回放失配
    const dir = tmpDir('w5-drop-anon')
    const store = makeStore({ dir, maxSize: 2, constants })
    const jp = journalPathFor(store.getFilePath(NAME))
    const a1 = { title: 'anon-1', content: 'anon1正文-'.repeat(40) }
    const a2 = { title: 'anon-2', content: 'anon2正文-'.repeat(40) }
    const a3 = { title: 'anon-3', content: 'anon3正文-'.repeat(40) }
    assert.strictEqual(store.saveBatch([a1, a2], NAME), true)
    assert.strictEqual(store.saveBatch([a3], NAME), true)
    const rec = readJournalRecords(jp).find((r) => Array.isArray(r.drop) && r.drop.length > 0)
    assert.ok(rec, '前置：anon 条目被淘汰时同样要有 drop 行')
    assert.strictEqual(rec.drop[0].content, a1.content, 'anon 身份不能脱离正文 ⇒ drop 行必须保留 content（否则回放 removed:0）')
    const replay = [{ ...a1 }, { ...a2 }, { ...a3 }]
    assert.strictEqual(applyJournalRecords(replay, [{ put: [], drop: rec.drop }], Utils).removed, 1,
      'anon 的 drop 回放必须命中（w3b 5.1 修前实测 removed:0）')
    assert.deepStrictEqual(replay.map((m) => m.title), ['anon-2', 'anon-3'])
  }
})

check('J10-06 旧格式快照加载/保存兼容：正文都在、身份不变；saveMessages 与 projectMessagesText 落盘逐字节一致', () => {
  const NAME = 'push.json'
  const dir = tmpDir('w5-legacy-file')
  const fp = path.join(dir, NAME)
  const seed = { title: 'legacy 匿名', content: 'legacy匿名正文-'.repeat(10) }
  const anonKey = Utils.getMessageIdentity(seed).key
  // W3 之前的磁盘形态：`_f` 全带正文，其中一条是 legacy 匿名 id
  const legacyItems = [
    { id: 'lf-1', url: 'https://u.example/lf-1', title: 'LF1', content: '瘦身正文-'.repeat(80), content_html: '<p>x</p>', _f: true },
    { id: anonKey, url: '#', title: seed.title, content: seed.content, _f: true },
    { id: 'ln-1', url: 'https://u.example/ln-1', title: 'LN1', content: '普通正文-'.repeat(20), content_html: '<p>n</p>' }
  ]
  const legacyText = JSON.stringify(legacyItems)
  fs.writeFileSync(fp, legacyText)
  const store = makeStore({ dir, maxSize: 100 })
  const loaded = store.readMessages(fp)
  assert.strictEqual(loaded.length, 3, '旧格式必须照常读入')
  assert.strictEqual(loaded[0].content, legacyItems[0].content, '旧格式的 _f 正文必须原样进内存（下一次保存才瘦身）')
  assert.strictEqual(store.has(legacyItems[1], NAME), true, 'legacy anon 身份读入后必须判重命中')
  assert.strictEqual(store.saveMessages(fp, loaded), true)
  const written = fs.readFileSync(fp, 'utf8')
  const projected = projectMessagesText(legacyText, Utils)
  assert.ok(projected, '前置：投影函数必须能处理旧格式文本')
  assert.ok(projected.length < legacyText.length, '正控：这份旧格式快照的投影必须真的变小')
  assert.strictEqual(Buffer.byteLength(written, 'utf8'), Buffer.byteLength(projected, 'utf8'), 'saveMessages 的落盘文本长度必须与 projectMessagesText 一致（控制台恢复同一口径）')
  assert.deepStrictEqual(JSON.parse(written), JSON.parse(projected), 'saveMessages 的落盘条目必须与 projectMessagesText 逐条一致')
  const saved = JSON.parse(written)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(saved[0], 'content'), false, '普通 `_f`（id+url 齐全）必须瘦身')
  assert.strictEqual(saved[1].content, seed.content, 'legacy 匿名 id 的 `_f` 必须保留正文')
  assert.deepStrictEqual(saved[2], legacyItems[2], '普通条目必须逐字不变')
  const reread = makeStore({ dir, maxSize: 100 })
  assert.strictEqual(reread.has(legacyItems[1], NAME), true, '瘦身写盘后 legacy 身份必须仍命中')
  assert.strictEqual(reread.has(legacyItems[2], NAME), true, '普通条目身份必须仍命中')
})

// ============================================================
console.log(`\n判重日志套件：通过 ${pass} / 失败 ${fail}`)
cleanup()
if (fail > 0) console.error(`\n❌ ${fail} 项失败`)
else console.log('\n🎉 全部通过')
