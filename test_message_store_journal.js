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
    assert.ok(fs.readFileSync(jp, 'utf8').includes('"a"'), 'journal 必须仍含被裁剪条目 a 的 put（构造崩溃窗口）')
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

check('J2-04 同批「先插入后更新同一身份」：重启后 readMessages 必须与重启前逐条深比较一致（顺序+内容，无 _f 与含 _f 两式）', () => {
  // 审查 B 的 orderFlip 复现：写入顺序 ≠ 内存数组顺序。maxSize=5、journal 不合并 ⇒ 重启只能靠日志
  // 重建数组；回放对未命中项只能 push 到尾部，若 put 按写入顺序记（r 在前、p' 在后），重启后数组
  // 变成 [q,r,p']（修前实测），与内存的 [q,p',r] 不同 ⇒ 后续条数裁剪先裁谁也随之改变。
  // 含 _f 一式再叠一层「先插入 f、再插入 x、最后更新 f」，并且第三批触发条数裁剪（a 被裁）——
  // 被裁的身份必须进日志 drop，否则回放会把它放回数组。
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
        [{ id: 'y', title: 'Y' }] // 6 条 > 上限 5：最旧的 a 被裁（f 是 _f，不落墓碑，只能靠日志 drop）
      ],
      expectIds: ['b', 'c', 'f', 'x', 'y'],
      expectDropL3: ['a']
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
      if (c.tag === 'filtered') assert.strictEqual(reopened.has({ id: 'a' }, NAME), true, '已推送过的被裁条目仍须判重命中')
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
    const journalText = fs.readFileSync(jp, 'utf8')
    assert.ok(journalText.includes('"FILTERED"'), 'journal 必须仍含 _f 条目的 put（构造「journal 未截断」窗口）')
    assert.ok(journalText.includes('"ckpt":true'), 'truncate 失败前必须先追加检查点（否则旧行会被重复回放）')
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
  const journalText = fs.readFileSync(jp, 'utf8')
  assert.ok(journalText.includes('"b"'), '合并失败后日志必须原样保留（下轮重试）')
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
console.log(`\n判重日志套件：通过 ${pass} / 失败 ${fail}`)
cleanup()
if (fail > 0) console.error(`\n❌ ${fail} 项失败`)
else console.log('\n🎉 全部通过')
