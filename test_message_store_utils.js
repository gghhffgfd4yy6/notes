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

// ===== QX-08：缓存目录解析由生产与青龙 --status 共用同一实现 =====
// 反例（改动前）：--status 把默认目录硬编码成 path.join(ROOT,'xianbaoku_cache')，生产却会在该目录
// 被普通文件占位 / realpath 逃出根目录时回退 .xbk_cache_safe ⇒ 前者静默读错目录（状态实际写在
// 备用目录时 --status 报「缺失」）。这里用假 fs（不触碰真实文件系统：/tmp 不可写、跨挂载点符号
// 链接会被沙箱拒绝）对拍两侧结果：同一输入必须得到同一目录。把 --status 侧回退成硬编码后，
// 「必须与生产一致」这条断言即红。
const { resolveCacheDirInRoot } = require('./xbk_message_store')
const { statusCacheDir } = require('./qinglong/xbk_push')

// root 取真实模块根（生产 getter 用 path.resolve(__dirname)），但 exists/lstat/realpath 全部由
// 假 fs 回答，测试不触碰真实文件系统。
const FAKE_ROOT = __dirname

// 假 fs：map 为「绝对路径 → 'dir' | 'file' | { kind, real }」，未登记路径视为不存在。
function makeCacheFs (map) {
  const entry = (p) => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : undefined)
  const isDir = (p) => {
    const e = entry(p)
    if (e === 'dir') return true
    if (e === 'file') return false
    if (e && typeof e === 'object') return e.kind === 'dir'
    return false
  }
  return {
    existsSync: (p) => entry(p) !== undefined,
    lstatSync: (p) => ({ isDirectory: () => isDir(p) }),
    realpathSync: (p) => {
      const e = entry(p)
      return e && typeof e === 'object' && e.real ? e.real : p
    }
  }
}

function storeWithFs (fakeFs, cacheDir = 'xianbaoku_cache') {
  return createMessageStore({
    Config: { cache: { dir: cacheDir, maxSize: 10000 } },
    Utils: mockUtils,
    fs: fakeFs,
    path,
    crypto: { randomUUID: () => 'uuid' },
    normalize: () => {},
    storage: {},
    constants: {}
  })
}

const DEFAULT_DIR = path.join(FAKE_ROOT, 'xianbaoku_cache')
const SAFE_DIR = path.join(FAKE_ROOT, '.xbk_cache_safe')
const CACHE_FS_SCENARIOS = [
  {
    name: '默认目录是根内正常目录 → 原样使用',
    map: { [FAKE_ROOT]: 'dir', [DEFAULT_DIR]: 'dir' },
    expect: DEFAULT_DIR
  },
  {
    name: '默认目录从未创建（父级存在）→ 仍使用默认目录',
    map: { [FAKE_ROOT]: 'dir' },
    expect: DEFAULT_DIR
  },
  {
    name: '默认目录被普通文件占位 → 回退 .xbk_cache_safe（生产口径）',
    map: { [FAKE_ROOT]: 'dir', [DEFAULT_DIR]: 'file' },
    expect: SAFE_DIR
  },
  {
    name: '默认目录是逃出根目录的符号链接 → 回退 .xbk_cache_safe（生产口径）',
    map: { [FAKE_ROOT]: 'dir', [DEFAULT_DIR]: { kind: 'dir', real: '/outside/xianbaoku_cache' } },
    expect: SAFE_DIR
  }
]

for (const scenario of CACHE_FS_SCENARIOS) {
  check(`QX-08 同源解析：${scenario.name}（--status 必须与生产 getter 一致）`, () => {
    const fakeFs = makeCacheFs(scenario.map)
    const prod = storeWithFs(fakeFs).cacheDir
    const status = statusCacheDir({ env: {}, fs: fakeFs, path, root: FAKE_ROOT })
    assert.strictEqual(prod, scenario.expect, `生产缓存目录应为 ${scenario.expect}，实际 ${prod}`)
    assert.strictEqual(status, prod, `--status 解析结果必须与生产一致（status=${status}，prod=${prod}）`)
  })
}

check('resolveCacheDirInRoot: 所有候选都被根外 realpath 劫持 → 显式抛错（禁止静默写穿）', () => {
  const hijacked = {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => '/outside' + p
  }
  assert.throws(() => resolveCacheDirInRoot({
    fs: hijacked, path, root: FAKE_ROOT, raw: 'xianbaoku_cache', fallback: 'xianbaoku_cache'
  }), /缓存目录安全检查失败/, '全部候选逃出根目录时必须抛错，而不是返回任意路径')
})

check('resolveCacheDirInRoot: 并行 worker 分片名（xianbaoku_cache_p7）同样走根内校验', () => {
  const fakeFs = makeCacheFs({ [FAKE_ROOT]: 'dir' })
  const dir = resolveCacheDirInRoot({
    fs: fakeFs, path, root: FAKE_ROOT, raw: 'xianbaoku_cache_p7', fallback: 'xianbaoku_cache_p7'
  })
  assert.strictEqual(dir, path.join(FAKE_ROOT, 'xianbaoku_cache_p7'), '分片目录名应被根内校验放行')
})

// ===== F4（B8 回归；V6 实锤数据丢失）=====
// 反例：_isResidualTombstoneLockName 旧实现第三条判据是 name.includes('.seen.cleanup.lock.')，
// 于是**合法缓存文件** '<name>.seen.cleanup.lock.json'（上游 pushUrl 末段恰为 xxx.seen.cleanup.lock）
// 也进了启动清理名单：mtime 陈旧 + 内容不是锁 token（PID 解析失败 → 判「进程已退出」）时被静默
// unlink，整份判重记录丢失。两层锁定：① 纯函数名单；② 真实目录端到端回收。
check('F4: 合法缓存文件 <name>.seen.cleanup.lock.json 不得进启动清理名单（数据丢失回归）', () => {
  const legit = [
    'v6probe.seen.cleanup.lock.json',
    'push.json.seen.cleanup.lock.json',
    'url_x.seen.cleanup.lock.json'
  ]
  for (const name of legit) {
    assert.strictEqual(store._isResidualTombstoneLockName(name), false,
      `合法缓存文件不得被判为残留锁（旧实现 includes('.seen.cleanup.lock.') 会误判 → 启动清理删盘丢判重记录）：${name}`)
  }
  // 反向：真正的残留锁与哨兵中间态必须仍在名单内（改窄不得静默漏回收）
  for (const name of ['.seen.cleanup.lock', '.seen.cleanup.lock.4242.1700000000000.reclaim', 'push.json.seen.lock']) {
    assert.strictEqual(store._isResidualTombstoneLockName(name), true, `真残留锁应仍在清理名单：${name}`)
  }
  // 近似但非法的形状不得进名单（子串包含式的判据会在这里全部误判）
  for (const name of ['.seen.cleanup.lock.txt', 'seen.cleanup.lock', '.seen.cleanup.lock.', '.seen.cleanup.lock.x.1.reclaim', '.seen.cleanup.lock.1.2.reclaim.tmp']) {
    assert.strictEqual(store._isResidualTombstoneLockName(name), false, `非精确形状不得进清理名单：${name}`)
  }
})

check('F4: 启动清理真实回收 .reclaim 残留、且不动合法缓存文件（端到端）', () => {
  const realFs = require('node:fs')
  const crypto = require('node:crypto')
  // 探针目录放在被 gitignore 的 xianbaoku_cache 之下：即使异常退出也不会污染 git status
  const probeDir = path.join(__dirname, 'xianbaoku_cache', `.r4_f4_probe_${process.pid}`)
  const storeReal = createMessageStore({
    Config: { cache: { maxSize: 10000 } },
    Utils: mockUtils,
    fs: realFs,
    path,
    crypto,
    normalize: () => {},
    storage: {},
    constants: { TOMBSTONE_LOCK_STALE_MS: 10000 }
  })
  const stale = new Date(Date.now() - 60_000)
  const legitPath = path.join(probeDir, 'v6probe.seen.cleanup.lock.json')
  const reclaimPath = path.join(probeDir, '.seen.cleanup.lock.999999.1700000000000.reclaim')
  const legitBody = JSON.stringify([{ id: 'v6probe', title: '合法判重记录' }])
  try {
    realFs.mkdirSync(probeDir, { recursive: true })
    realFs.writeFileSync(legitPath, legitBody)
    realFs.writeFileSync(reclaimPath, '999999:0:dead-owner')
    realFs.utimesSync(legitPath, stale, stale)
    realFs.utimesSync(reclaimPath, stale, stale)
    storeReal._tombstoneLocksCleaned.delete(probeDir)
    storeReal._cleanupResidualTombstoneLocks(probeDir)
    assert.strictEqual(realFs.existsSync(legitPath), true,
      '合法缓存文件（URL 末段恰为 xxx.seen.cleanup.lock）必须保留：被启动清理删除即判重记录丢失')
    assert.strictEqual(realFs.readFileSync(legitPath, 'utf8'), legitBody, '合法缓存文件内容不得被改动')
    assert.strictEqual(realFs.existsSync(reclaimPath), false,
      '陈旧且持有进程已退出的 .reclaim 残留必须被启动清理回收（这是本条的真正增量）')
  } finally {
    try { realFs.rmSync(probeDir, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
  }
})

// ===== F7（B8 回归；V6 实锤两处碰撞）=====
// ① 名字层：末段以点开头加 'url_' 前缀会与「本身以 url_ 开头」的合法名撞名；
// ② 路径层：getFilePath 的 200 字节截断会让「仅第 200 字节后不同」的长名映射到同一路径。
// 生产 cacheName 直接来自 getFileName(pushUrl)，两者都意味着两个不同 pushUrl 共用缓存文件
// （判重记录互相覆盖）。这里用**真实** Utils（xbk_utils.anonKey）做摘要，验证真实碰撞面。
const { createUtils } = require('./xbk_utils')
const longNameStore = createMessageStore({
  Config: { cache: { maxSize: 10000 } },
  Utils: createUtils({ fs: require('node:fs'), safeRe: (p, f) => new RegExp(p, f) }),
  fs: makeCacheFs({ [FAKE_ROOT]: 'dir' }),
  path,
  crypto: { randomUUID: () => 'uuid' },
  normalize: () => {},
  storage: {},
  constants: {}
})

check('F7: 末段以点开头 / 以 url_ 开头的名字不得撞同一缓存文件（getFileName 单射）', () => {
  const dotted = store.getFileName('https://example.com/.json')
  const prefixed = store.getFileName('https://example.com/url_.json')
  assert.strictEqual(dotted, 'url_.json', '以点开头仍加 url_ 前缀（隐藏文件防护不得回退）')
  assert.strictEqual(prefixed, 'url_url_.json', '以 url_ 开头必须转义前缀，避免与前一条撞名')
  assert.notStrictEqual(dotted, prefixed, '两个不同 URL 不得映射到同一缓存文件名')
  const urls = [
    'https://e.example/.hidden', 'https://e.example/url_.hidden', 'https://e.example/url_x',
    'https://e.example/x', 'https://e.example/.json', 'https://e.example/url_.json', 'https://e.example/data.json'
  ]
  const names = urls.map(u => store.getFileName(u))
  assert.strictEqual(new Set(names).size, names.length, `不同 URL 不得撞名：${JSON.stringify(names)}`)
})

check('F7: 超长名截断必须保持单射（仅第 200 字节后不同的两条长名不得映射同一路径）', () => {
  const a = 'u'.repeat(260) + 'aaaa.json' // 269 字节：与 b 仅在第 200 字节之后不同
  const b = 'u'.repeat(260) + 'bbbb.json'
  const pa = longNameStore.getFilePath(a)
  const pb = longNameStore.getFilePath(b)
  assert.notStrictEqual(pa, pb, `截断后仍必须区分不同长名（生产 cacheName 来自 getFileName(pushUrl)，同路径即判重记录互相覆盖）：${path.basename(pa)}`)
  assert.ok(Buffer.byteLength(path.basename(pa)) <= 200 && Buffer.byteLength(path.basename(pb)) <= 200, '截断产物仍须 <= 200 字节')
  assert.ok(pa.endsWith('.json') && pb.endsWith('.json'), '截断仍应保留扩展名')
  assert.ok(!/[:*?"<>|]/.test(path.basename(pa)), `摘要不得引入路径保留字符：${path.basename(pa)}`)
  assert.strictEqual(longNameStore.getFilePath(a), pa, '同一名字必须稳定映射到同一路径（缓存名要能跨轮复用）')
})

// ===== F-02（B8 回归；V6 实锤漏推方向）=====
// 反例：_identityIndex 的 O(1) 失效检查只看「引用 / 长度 / 首元素引用」，调用方**原地改写非首元素**
// （换元素或改 id/url 字段）不会触发重建，旧索引把已不存在的身份判为「已存在」→ has() 返回 true
// → 主流程跳过推送（漏推，与 SYSTEM_CONTRACT「宁可多推」相反）。这里用真实 Utils + 假 fs +
// 内存权威数组做单元级 oracle 对拍（oracle = _indexHasIdentityDirect 零索引线性扫描）。
const identityStore = createMessageStore({
  Config: { cache: { maxSize: 10000 } },
  Utils: createUtils({ fs: require('node:fs'), safeRe: (p, f) => new RegExp(p, f) }),
  fs: makeCacheFs({ [FAKE_ROOT]: 'dir' }),
  path,
  crypto: { randomUUID: () => 'uuid' },
  normalize: () => {},
  storage: {
    readSafeTextResult: () => ({ status: 'missing' }), // 墓碑文件按「确认缺失」处理
    writeAtomic: () => true,
    writeAtomicIfAbsent: () => true
  },
  constants: {
    DEFAULT_MAX_SIZE: 10000,
    MESSAGE_CACHE_MAX_BYTES: 8388608,
    TOMBSTONE_MAX_KEYS: 5000,
    TOMBSTONE_MAX_BYTES: 262144,
    TOMBSTONE_LOCK_STALE_MS: 10000
  }
})

function seedIdentityProbe (messages, name) {
  // 必须经 getFilePath 求路径：has(message, filename) 内部同样先 getFilePath(filename)，
  // 直接塞绝对路径会让两次路径不一致、内存权威数组命不中。
  const fp = identityStore.getFilePath(name)
  identityStore._memoryCache[fp] = messages
  identityStore._memoCount += 1
  identityStore._verified.add(fp) // 跳过「内存命中未验证」的真实磁盘检查
  return name
}

check('F-02: 原地改写非首元素后 has 必须与线性扫描 oracle 一致（漏推方向）', () => {
  const forms = [
    { label: 'arr[1] 整体替换（非首元素、长度不变）', mutate: (a) => { a[1] = { id: 'u2-new' } }, probes: [{ id: 'u2' }, { id: 'u2-new' }] },
    { label: 'arr[2].id 字段改写', mutate: (a) => { a[2].id = 'u3-new' }, probes: [{ id: 'u3' }, { id: 'u3-new' }] },
    { label: 'arr[0].id 字段改写（首元素字段级）', mutate: (a) => { a[0].id = 'u1-new' }, probes: [{ id: 'u1' }, { id: 'u1-new' }] },
    { label: 'arr[2].url 字段改写', mutate: (a) => { a[2].url = 'https://u.example/changed' }, probes: [{ url: 'https://u.example/3' }, { url: 'https://u.example/changed' }] },
    { label: '原地 push 追加（长度变化）', mutate: (a) => { a.push({ id: 'u9' }) }, probes: [{ id: 'u9' }, { id: 'u1' }] }
  ]
  for (const form of forms) {
    const arr = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', url: 'https://u.example/3' }]
    const name = seedIdentityProbe(arr, `f02_form_${form.probes.length}_${form.label.length}.json`)
    assert.strictEqual(identityStore.has({ id: 'u1' }, name), true, `前置：${form.label} 前索引应已建立并命中`)
    form.mutate(arr)
    for (const p of form.probes) {
      const indexed = identityStore.has(p, name)
      const oracle = identityStore._indexHasIdentityDirect(arr, p)
      assert.strictEqual(indexed, oracle,
        `${form.label}：has()=${indexed} 必须等于 oracle=${oracle}（probe=${JSON.stringify(p)}；true 侧不符即漏推）`)
    }
  }
})

check('F-02: 原地改写的身份陈旧时 has 不得返回 true（无 oracle 的硬断言）', () => {
  const arr = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
  const name = seedIdentityProbe(arr, 'f02_stale.json')
  assert.strictEqual(identityStore.has({ id: 's2' }, name), true, '前置：s2 命中')
  arr[1] = { id: 's2-replaced' } // 非首元素替换：引用/长度/首元素引用三项失效检查都看不出
  assert.strictEqual(identityStore.has({ id: 's2' }, name), false, '已被原地替换掉的 s2 不得再判为已存在（陈旧索引 → 漏推）')
  assert.strictEqual(identityStore.has({ id: 's2-replaced' }, name), true, '原地写入的新身份应能查到（陈旧索引另一侧）')
})

check('F-02: 批量未命中不得每次重建索引（每数组版本至多一次 O(n) 复检）', () => {
  const arr = []
  for (let i = 0; i < 1000; i++) arr.push({ id: 'p' + i })
  const name = seedIdentityProbe(arr, 'f02_perf.json')
  assert.strictEqual(identityStore.has({ id: 'p0' }, name), true, '前置：索引已建立')
  const realBuild = identityStore._buildIdentityIndex
  let builds = 0
  identityStore._buildIdentityIndex = function (...args) { builds += 1; return realBuild.apply(this, args) }
  try {
    for (let i = 0; i < 500; i++) {
      assert.strictEqual(identityStore.has({ id: 'miss-' + i }, name), false, `不存在的身份必须判否（第 ${i} 个）`)
    }
  } finally {
    identityStore._buildIdentityIndex = realBuild
  }
  assert.ok(builds >= 1, '首次未命中必须做一次全量复检，否则原地写入的新身份永远查不到（F-02 机制被删即红）')
  assert.ok(builds <= 2, `500 次未命中最多重建 1~2 次，实际 ${builds} 次（每次未命中都重建 = O(n²)，B8 实测打死热路径）`)
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_message_store_utils.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
