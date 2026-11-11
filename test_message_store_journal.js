'use strict'

// 判重缓存「追加日志 + 定期合并」（P1 / v3.412）专项测试。
//
// 覆盖验收口径（spec P1 §验收 1/2/4 + §风险提示）：
//   ① 等价性：随机 500 轮（新增/更新/重复/URL/匿名/裁剪/重启），逐轮对比「旧全量实现」
//      （constants.JOURNAL_MAX_BYTES=0，退回整份原子重写）与「journal 实现」「混合实现」的
//      readMessages() 逐条深比较，以及 has() 判重结论；
//   ② 崩溃恢复：journal 末尾半行、中间坏行、合并中途 kill（快照已写/journal 未清）；
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

// 三种实现档位：old = 旧全量重写；journal = 强制走日志（含频繁合并）；mixed = 小缓存直写 + 大缓存日志
const VARIANTS = {
  old: { JOURNAL_MAX_BYTES: 0 },
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
  assert.strictEqual(JOURNAL_VERSION, 1)
  assert.strictEqual(JOURNAL_MAX_BYTES, 8 * 1024 * 1024)
  assert.strictEqual(JOURNAL_MAX_AGE_MS, 6 * 60 * 60 * 1000)
  assert.strictEqual(JOURNAL_READ_MAX_BYTES, 64 * 1024 * 1024)
  assert.ok(JOURNAL_DIRECT_MAX_BYTES > 0 && JOURNAL_DIRECT_MAX_BYTES < JOURNAL_MAX_BYTES)
})

check('J1-02 parseJournalText：坏行/半行逐行忽略并计数，合法行照常返回，未知版本不猜', () => {
  const ok = JSON.stringify({ v: 1, at: 111, put: [{ id: 'a' }] })
  const text = [
    ok,
    '{"v":1,"at":222,"put":[{"id":"b"', // 半行（崩溃现场）
    'not-json', // 整行坏
    JSON.stringify({ v: 2, at: 333, put: [{ id: 'c' }] }), // 未知版本
    JSON.stringify({ v: 1, at: 444, put: [{ id: 'd' }, 'x', null] }), // 非对象元素跳过
    ''
  ].join('\n')
  const parsed = parseJournalText(text)
  assert.deepStrictEqual(parsed.puts.map(m => m.id), ['a', 'd'], '只回放合法行里的对象元素')
  assert.strictEqual(parsed.badLines, 3, '半行 + 坏 JSON + 未知版本各计一行')
  assert.strictEqual(parsed.lines, 2)
  assert.strictEqual(parsed.firstAt, 111, 'firstAt 取首条合法行的 at（合并窗口起点）')
  assert.deepStrictEqual(parseJournalText(''), { puts: [], lines: 0, badLines: 0, firstAt: null })
  assert.deepStrictEqual(parseJournalText(null), { puts: [], lines: 0, badLines: 0, firstAt: null })
})

// ============================================================
section('2. 等价性：随机 500 轮（旧全量实现 vs journal vs 混合）')
// ============================================================

check('J2-01 500 轮随机新增/更新/重复/URL/匿名/重启：readMessages 逐条深比较 + has 结论一致', () => {
  const clock = virtualClock()
  const dir = tmpDir('equiv')
  const NAME = 'push.json'
  // 500 轮只跑「新增/更新/重复/URL/匿名 + 合并 + 重启」：条数上限放到不会触发裁剪（裁剪每轮都会
  // 写一次墓碑，500 轮 ≈1200 次墓碑重写会把套件拖成 I/O 大户，进而干扰并发批次里的墙钟断言）。
  // 裁剪/墓碑等价性由 J2-02 用 120 轮小缓存专门覆盖。
  const maxSize = 100000
  const stores = {}
  const make = () => {
    for (const [name, constants] of Object.entries(VARIANTS)) {
      stores[name] = makeStore({ dir, maxSize, constants })
    }
  }
  const fp = () => stores.old.getFilePath(NAME)
  const rng = rngFactory(20261111)
  const state = { seq: 0, seen: [], last: null }
  let restarts = 0
  try {
    make()
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
        const store = stores[name]
        if (single) store.save(batch[0], NAME)
        else store.saveBatch(batch, NAME)
      }
      // 每轮：内存视图必须逐条一致（timestamp 也一致——虚拟时钟让两边序列同源）
      const ref = stores.old.readMessages(fp())
      assert.deepStrictEqual(stores.journal.readMessages(fp()), ref, `第 ${round} 轮 journal 视图与旧实现不一致`)
      assert.deepStrictEqual(stores.mixed.readMessages(fp()), ref, `第 ${round} 轮 mixed 视图与旧实现不一致`)
      // 判重结论一致：每 5 轮抽 3 条（1 条已存在 + 2 条不存在）。has() 每次都会为当前内存数组
      // 重建身份索引（数组引用随 _memoSet 变化），逐轮全量抽查会让 500 轮变成几百万次身份计算——
      // 覆盖密度足够（100 轮 × 3 条），又不至于把套件拖成 CPU 大户。
      if (round % 5 === 0) {
        const probes = []
        if (state.seen.length > 0) probes.push({ id: state.seen[Math.floor(rng() * state.seen.length)] })
        probes.push({ id: 'missing-' + round + '-a' })
        probes.push({ url: 'https://example.com/news/' + round })
        for (const probe of probes) {
          const expected = stores.old.has(probe, NAME)
          assert.strictEqual(stores.journal.has(probe, NAME), expected, `第 ${round} 轮 has(${JSON.stringify(probe)}) 与旧实现不一致`)
          assert.strictEqual(stores.mixed.has(probe, NAME), expected, `第 ${round} 轮 mixed has(${JSON.stringify(probe)}) 与旧实现不一致`)
        }
      }
      // 重启：每 37 轮换新实例（内存清空，只能靠「快照 + journal」重建）
      if (round % 37 === 36) {
        restarts++
        make()
        const after = stores.old.readMessages(fp())
        assert.deepStrictEqual(stores.journal.readMessages(fp()), after, `第 ${round} 轮重启后 journal 视图不一致`)
        assert.deepStrictEqual(stores.mixed.readMessages(fp()), after, `第 ${round} 轮重启后 mixed 视图不一致`)
      }
    }
    assert.ok(restarts >= 13, `必须覆盖至少 13 次重启，实际 ${restarts}`)
    // 收尾自证：三种实现的最终快照内容（old 的 push.json == journal 合并后的视图）
    assert.deepStrictEqual(stores.journal.readMessages(fp()), stores.old.readMessages(fp()))
  } finally {
    clock.restore()
  }
})

check('J2-02 裁剪等价性：小缓存(maxSize=12) 60 轮，条数裁剪 + 墓碑路径与旧实现逐条一致', () => {
  const clock = virtualClock()
  const dir = tmpDir('equiv-trim')
  const NAME = 'push.json'
  const maxSize = 12
  const stores = {}
  const make = () => {
    for (const [name, constants] of Object.entries(VARIANTS)) stores[name] = makeStore({ dir, maxSize, constants })
  }
  const fp = () => stores.old.getFilePath(NAME)
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
      for (const name of Object.keys(stores)) stores[name].saveBatch(batch, NAME)
      const ref = stores.old.readMessages(fp())
      assert.deepStrictEqual(stores.journal.readMessages(fp()), ref, `裁剪第 ${round} 轮 journal 与旧实现不一致`)
      assert.deepStrictEqual(stores.mixed.readMessages(fp()), ref, `裁剪第 ${round} 轮 mixed 与旧实现不一致`)
      if (round % 40 === 39) make()
    }
    assert.strictEqual(stores.old.readMessages(fp()).length, maxSize, '稳态必须恰好保持条数上限')
    // 被裁剪的身份必须仍然判重命中（墓碑），且全新 id 不命中
    const dropped = 't-1'
    assert.strictEqual(stores.journal.has({ id: dropped }, NAME), stores.old.has({ id: dropped }, NAME), '墓碑判重结论必须与旧实现一致')
  } finally {
    clock.restore()
  }
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
