'use strict'
/* eslint no-control-regex: off */

// xbk_message_store.js 纯函数方法测试（提升变异分数）
// 覆盖：getFilePath（路径安全/清洗/截断）+ getFileName（URL 提取/清洗/后缀）
const assert = require('node:assert')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMessageStore } = require('./xbk_message_store')

const mockUtils = {
  anonKey: (s) => 'anon' + String(s).length,
  safeObjectCopy: (o) => JSON.parse(JSON.stringify(o)),
  getMessageIdentity: () => ({ valid: false }),
  isValidItem: () => true,
  num: () => 10000,
  addIndex: () => {}
}

const store = createMessageStore({
  Config: { cache: { maxSize: 10000 } },
  Utils: mockUtils,
  fs: {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p
  },
  path,
  crypto: { randomUUID: () => 'uuid' },
  normalize: () => {},
  storage: {},
  constants: {}
})

let pass = 0
let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

// 墓碑淘汰（qodo #147-4）专用夹具：四类 Map 全空的墓碑集合。
function emptyTombstoneMaps () {
  return { id: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() }
}

// 与内部 serialize 同口径，用于在不触发淘汰的前提下测量序列化体积。
function tombstoneBytes (ts) {
  return Buffer.byteLength(JSON.stringify({
    v: 1,
    id: [...ts.id.keys()],
    urlOnly: [...ts.urlOnly.keys()],
    idWithUrl: [...ts.idWithUrl.keys()],
    anon: [...ts.anon.keys()]
  }), 'utf8')
}

// 注入 writeAtomic 探针，用于证明「放弃持久化」时确实没有写盘。
function createProbeStore (storage) {
  return createMessageStore({
    Config: { cache: { maxSize: 10000 } },
    Utils: mockUtils,
    fs: {
      existsSync: () => true,
      lstatSync: () => ({ isDirectory: () => true }),
      realpathSync: (p) => p
    },
    path,
    crypto: { randomUUID: () => 'uuid' },
    normalize: () => {},
    storage: storage || {},
    constants: {}
  })
}

// 死循环守卫的「有限时间」证明必须借子进程设界：同进程内的 setTimeout 无法中断同步
// 自旋，只有 execFileSync 的 timeout 能杀掉挂死调用。子进程共用一段 store 装配前导，
// 后接各自探针体；NODE_OPTIONS 的 execpath-shim 已把 process.execPath 指向真实 node，
// 与 test_cli.js 同一手法。
const CHILD_PREAMBLE = `
const path = require('node:path')
const { createMessageStore } = require('./xbk_message_store')
const mockUtils = {
  anonKey: (s) => 'anon' + String(s).length,
  safeObjectCopy: (o) => JSON.parse(JSON.stringify(o)),
  getMessageIdentity: () => ({ valid: false }),
  isValidItem: () => true,
  num: () => 10000,
  addIndex: () => {}
}
function makeStore (storage) {
  return createMessageStore({
    Config: { cache: { maxSize: 10000 } },
    Utils: mockUtils,
    fs: { existsSync: () => true, lstatSync: () => ({ isDirectory: () => true }), realpathSync: (p) => p },
    path,
    crypto: { randomUUID: () => 'uuid' },
    normalize: () => {},
    storage: storage || {},
    constants: {}
  })
}
`

// 探针体 1：四类 Map 全空 + maxBytes=1（小于空墓碑序列化 53 字节）。
const EVICT_GUARD_CHILD_BODY = `
const store = makeStore()
const ts = { id: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() }
process.stdout.write(String(store._evictTombstonesToSize(ts, 1)))
`

// 探针体 2：同样无法达标的 maxBytes=1，但走 _saveTombstones 的持久化门径，
// 回传 { ret, writes, warns } 供父进程断言「放弃持久化 + 告警 + 不写盘」。
function saveProbeBody (targetPath) {
  return `
const writes = []
const store = makeStore({ writeAtomic: (p, text) => { writes.push(p); return true } })
const warns = []
const origWarn = console.warn
console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
const ts = { id: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() }
const ret = store._saveTombstones(${JSON.stringify(targetPath)}, ts, 1)
console.warn = origWarn
process.stdout.write(JSON.stringify({ ret, writes: writes.length, warns }))
`
}

// 在带超时的子进程里执行探针体；挂死（守卫被回退）时 execFileSync 抛错 → 断言失败。
function runChildProbe (body) {
  try {
    return execFileSync(process.execPath, ['-e', CHILD_PREAMBLE + body], {
      encoding: 'utf8',
      timeout: 8000,
      cwd: __dirname
    })
  } catch (e) {
    assert.fail(`子进程未在 8s 内返回（疑似死循环挂死；killed=${e.killed} signal=${e.signal} code=${e.code}）：${e.message}`)
  }
}

console.log('=== xbk_message_store.js 纯函数方法测试 ===')

// ===== getFilePath =====
check('getFilePath: 正常文件名返回缓存目录下路径', () => {
  const r = store.getFilePath('test.json')
  assert.ok(r.endsWith(path.sep + 'test.json'), '应返回缓存目录下的 test.json')
})

check('getFilePath: 路径穿越被阻止（只取 basename）', () => {
  const r = store.getFilePath('../../etc/passwd')
  assert.ok(!r.includes('..'), '路径穿越应被阻止')
  assert.ok(r.endsWith(path.sep + 'passwd'), '应只取 basename')
})

check('getFilePath: 绝对路径被阻止（只取 basename）', () => {
  const r = store.getFilePath('/etc/passwd')
  assert.ok(r.endsWith(path.sep + 'passwd'), '绝对路径应只取 basename')
})

check('getFilePath: 非法文件名字符被清洗', () => {
  const r = store.getFilePath('a:b*c?d"e<f>g|h.json')
  assert.ok(!/[:*?"<>|]/.test(path.basename(r)), '非法字符应被清洗')
})

check('getFilePath: NUL 字符被清洗', () => {
  const r = store.getFilePath('test\u0000.json')
  assert.ok(!r.includes('\u0000'), 'NUL 字符应被清洗')
})

check('getFilePath: 空文件名回退 default.json', () => {
  const r = store.getFilePath('')
  assert.ok(r.endsWith(path.sep + 'default.json'), '空文件名应回退 default.json')
})

check('getFilePath: undefined 回退 default.json', () => {
  const r = store.getFilePath(undefined)
  assert.ok(r.endsWith(path.sep + 'default.json'), 'undefined 应回退 default.json')
})

check('getFilePath: null 回退 default.json', () => {
  const r = store.getFilePath(null)
  assert.ok(r.endsWith(path.sep + 'default.json'), 'null 应回退 default.json')
})

check('getFilePath: [object Object] 回退 default.json', () => {
  const r = store.getFilePath('[object Object]')
  assert.ok(r.endsWith(path.sep + 'default.json'), '[object Object] 应回退 default.json')
})

check('getFilePath: . 回退 default.json', () => {
  const r = store.getFilePath('.')
  assert.ok(r.endsWith(path.sep + 'default.json'), '. 应回退 default.json')
})

check('getFilePath: .. 回退 default.json', () => {
  const r = store.getFilePath('..')
  assert.ok(r.endsWith(path.sep + 'default.json'), '.. 应回退 default.json')
})

check('getFilePath: 超长文件名截断到 200 字节', () => {
  const longName = 'a'.repeat(300) + '.json'
  const r = store.getFilePath(longName)
  const basename = path.basename(r)
  assert.ok(Buffer.byteLength(basename, 'utf8') <= 200, '文件名应截断到 200 字节以内')
})

check('getFilePath: 超长文件名保留扩展名', () => {
  const longName = 'a'.repeat(300) + '.json'
  const r = store.getFilePath(longName)
  assert.ok(r.endsWith('.json'), '超长文件名应保留 .json 扩展名')
})

check('getFilePath: 数字文件名正常处理', () => {
  const r = store.getFilePath(123)
  assert.ok(r.endsWith(path.sep + '123'), '数字文件名应 String 化')
})

// ===== getFileName =====
check('getFileName: 正常 URL 提取文件名', () => {
  const r = store.getFileName('https://example.com/path/to/data.json')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: URL 带查询参数', () => {
  const r = store.getFileName('https://example.com/data.json?foo=bar')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: URL 带 hash', () => {
  const r = store.getFileName('https://example.com/data.json#section')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: 空 URL 回退 default.json', () => {
  const r = store.getFileName('')
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 无扩展名自动加 .json', () => {
  const r = store.getFileName('https://example.com/data')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: 非法文件名字符替换为下划线', () => {
  const r = store.getFileName('https://example.com/a:b*c?.json')
  assert.ok(!/[:*?]/.test(r), '非法字符应替换为下划线')
})

check('getFileName: 末段为空回退 default', () => {
  const r = store.getFileName('https://example.com/path/')
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 末段为纯点串回退 default', () => {
  const r = store.getFileName('https://example.com/..')
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 非字符串 URL 回退 default.json', () => {
  const r = store.getFileName(undefined)
  assert.strictEqual(r, 'default.json')
})

check('getFileName: null URL 回退 default.json', () => {
  const r = store.getFileName(null)
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 数字 URL 生成 bad_ 前缀文件名', () => {
  const r = store.getFileName(123)
  assert.ok(r.startsWith('bad_'), '数字 URL 应生成 bad_ 前缀文件名')
  assert.ok(r.endsWith('.json'), '应以 .json 结尾')
})

check('getFileName: 控制字符被过滤', () => {
  const r = store.getFileName('https://example.com/a\u0001b.json')
  assert.ok(!/[\u0000-\u001f]/.test(r), '控制字符应被过滤')
})

check('getFileName: 末段全为控制字符回退 default', () => {
  const r = store.getFileName('https://example.com/\u0001\u0002\u0003')
  assert.strictEqual(r, 'default.json', '末段全为控制字符应回退 default')
})

// ===== _evictTombstonesToSize / _saveTombstones（qodo #147-4 墓碑淘汰死循环守卫）=====
// 空墓碑序列化长度恒为 53 字节；maxBytes 小于它时「淘汰到空必然达标」不成立，
// 守卫必须在有限时间内如实返回 null，否则该调用会永久自旋挂死进程。
check('_evictTombstonesToSize: 空墓碑 + 极小 maxBytes 有限时间内返回 null（超时兜底防挂死）', () => {
  const out = runChildProbe(EVICT_GUARD_CHILD_BODY)
  assert.strictEqual(out.trim(), 'null', '四类 Map 全空且 maxBytes 小于空序列化长度时应返回 null')
})

check('_evictTombstonesToSize: 合法 maxBytes 下空墓碑返回 53 字节文本（守卫不误伤达标路径）', () => {
  const ts = emptyTombstoneMaps()
  const r = store._evictTombstonesToSize(ts, 53)
  assert.strictEqual(typeof r, 'string', '恰好达标时应返回序列化文本而非 null')
  assert.strictEqual(Buffer.byteLength(r, 'utf8'), 53, '空墓碑序列化长度应为 53 字节')
})

check('_evictTombstonesToSize: 有键可删时逐键淘汰到达标而非返回 null', () => {
  const ts = emptyTombstoneMaps()
  for (let i = 0; i < 40; i++) {
    ts.id.set('id' + i, 1)
    ts.urlOnly.set('url' + i, 1)
    ts.idWithUrl.set('both' + i, 1)
    ts.anon.set('anon' + i, 1)
  }
  const maxBytes = 800
  assert.ok(tombstoneBytes(ts) > maxBytes, '前置：初始序列化应超过 maxBytes 以便触发淘汰')
  const r = store._evictTombstonesToSize(ts, maxBytes)
  assert.notStrictEqual(r, null, '仍有键可删时应淘汰达标，不得走 null 出口')
  assert.ok(Buffer.byteLength(r, 'utf8') <= maxBytes, '返回文本应符合 maxBytes 上限')
  assert.ok(ts.id.size + ts.urlOnly.size + ts.idWithUrl.size + ts.anon.size < 160, '应确实丢弃了最旧键')
})

check('_saveTombstones: 淘汰无法达标（返回 null）时放弃持久化并告警、不写盘', () => {
  const out = runChildProbe(saveProbeBody(path.join(__dirname, 'dsh_probe_entry')))
  const r = JSON.parse(out)
  assert.strictEqual(r.ret, false, '无法通过淘汰达标时应放弃持久化并返回 false')
  assert.strictEqual(r.writes, 0, '放弃持久化时不得调用 writeAtomic 写盘')
  assert.ok(
    r.warns.some((w) => w.includes('放弃持久化') && w.includes('dsh_probe_entry.seen.json')),
    `应告警「超限且无法通过淘汰达标，放弃持久化」并带上路径，实际告警: ${JSON.stringify(r.warns)}`
  )
})

check('_saveTombstones: 可达标时正常序列化并交给 writeAtomic（对照，证明 null 出口非必然）', () => {
  const writes = []
  const probe = createProbeStore({ writeAtomic: (p, text) => { writes.push({ p, text }); return true } })
  const ret = probe._saveTombstones(path.join(__dirname, 'dsh_probe_ok'), emptyTombstoneMaps(), 100)
  assert.strictEqual(ret, true, '空墓碑在 maxBytes=100 下应写盘成功')
  assert.strictEqual(writes.length, 1, '应恰好调用一次 writeAtomic')
  assert.ok(writes[0].p.endsWith('dsh_probe_ok.seen.json'), '写入目标应为 <filePath>.seen.json')
  assert.strictEqual(Buffer.byteLength(writes[0].text, 'utf8'), 53, '写入内容应为 53 字节空墓碑文本')
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_message_store_utils.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
