'use strict'
/* eslint no-control-regex: off */

// xbk_message_store.js 纯函数方法测试（提升变异分数）
// 覆盖：getFilePath（路径安全/清洗/截断）+ getFileName（URL 提取/清洗/后缀）
const assert = require('node:assert')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMessageStore, IDENTITY_INDEX_REF_PROBE_WINDOW, IDENTITY_INDEX_IDENTITY_PROBE_WINDOW } = require('./xbk_message_store')

// C3-002（backlog）：夹具加载期先清掉外部部署开关 XBK_CACHE_DIR。
// 生产 cacheDir getter 让它无条件压过 Config.cache.dir（SYSTEM_CONTRACT 三方同源契约，语义正确），
// 而本套件下方用 Config.cache.dir 把 F1 夹具隔离到私有目录——在 export 过该变量的 shell 里直跑
// 本套件，隔离会被 env 顶掉、夹具写进部署缓存目录（实测：17 条用例假红 + 12 个夹具文件落进哨兵目录）。
const { isolateProcessCacheDirEnv } = require('./scripts/test-env-isolation')
isolateProcessCacheDirEnv()

// 夹具装配只允许一处真相（C5-075）：父进程 store / 探针 store / 子进程 preamble 全部由下面两个工厂生成。
// 子进程侧用 Function.prototype.toString() 把同一份源码注入 `node -e`——工厂签名或 Config 口径一变自动同步；
// 旧实现把这段装配逐字抄进 CHILD_PREAMBLE，签名一变子进程就静默停在旧副本上（探针在测过期夹具，套件仍绿）。
function buildMockUtils () {
  return {
    anonKey: (s) => 'anon' + String(s).length,
    safeObjectCopy: (o) => JSON.parse(JSON.stringify(o)),
    getMessageIdentity: () => ({ valid: false }),
    isValidItem: () => true,
    num: () => 10000,
    addIndex: () => {}
  }
}

const mockUtils = buildMockUtils()

function buildFixtureStore ({ createMessageStore, path, storage, Utils }) {
  return createMessageStore({
    Config: { cache: { maxSize: 10000 } },
    Utils,
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

const store = buildFixtureStore({ createMessageStore, path, Utils: mockUtils })

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
  return buildFixtureStore({ createMessageStore, path, storage, Utils: mockUtils })
}

// 死循环守卫的「有限时间」证明必须借子进程设界：同进程内的 setTimeout 无法中断同步
// 自旋，只有 execFileSync 的 timeout 能杀掉挂死调用。子进程共用一段 store 装配前导，
// 后接各自探针体；NODE_OPTIONS 的 execpath-shim 已把 process.execPath 指向真实 node，
// 与 test_cli.js 同一手法。装配由父进程工厂源码生成（C5-075），不再手抄一份。
const CHILD_PREAMBLE = `
const path = require('node:path')
const { createMessageStore } = require('./xbk_message_store')
const mockUtils = (${buildMockUtils.toString()})()
const buildFixtureStore = ${buildFixtureStore.toString()}
function makeStore (storage) {
  return buildFixtureStore({ createMessageStore, path, storage, Utils: mockUtils })
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

// getFilePath 的专项覆盖已收拢为单一参数表（C5-046：首版 14 条 + 持久化契约 4 条 + PlanP 4 条 + MS-05 1 条），
// 见下方「===== getFilePath：入参 → 产物 参数表 =====」；MS-05（超长扩展名分支）仍在原处单独成 check。

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

// ===== C5-031：放弃持久化分支必须在**进程内**执行（TAP 覆盖可归因）=====
// 同一行为已由上面带超时的子进程探针验过，但 TAP 档 perTest 覆盖只归因到测试进程：变异目标只在
// 子进程里被执行 ⇒ 判 NoCoverage 且不跑任何测试（message-store 段 3 个击杀静默丢失）。
// 这里用**真实入参**（空墓碑 + maxBytes=1）在进程内走完「淘汰无法达标 ⇒ 放弃持久化」整条链；
// 子进程探针保留——死循环守卫的「有限时间」证明必须靠外部 timeout。
check('_saveTombstones: 无法达标时放弃持久化（告警 + 不写盘 + 返回 false）在进程内被执行（覆盖可归因）', () => {
  const writes = []
  const probe = createProbeStore({ writeAtomic: (p) => { writes.push(p); return true } })
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
  try {
    const ret = probe._saveTombstones(path.join(__dirname, 'dsh_probe_inproc'), emptyTombstoneMaps(), 1)
    assert.strictEqual(ret, false, '无法通过淘汰达标时应放弃持久化并返回 false')
    assert.strictEqual(writes.length, 0, '放弃持久化时不得调用 writeAtomic 写盘')
    assert.ok(warns.some((w) => w.includes('放弃持久化') && w.includes('dsh_probe_inproc.seen.json')),
      `应告警「超限且无法通过淘汰达标，放弃持久化」并带上路径，实际告警: ${JSON.stringify(warns)}`)
  } finally {
    console.warn = origWarn
  }
})

// ===== C5-075：子进程夹具必须与父进程同源 =====
// 旧实现把父进程的 mockUtils + createMessageStore 装配逐字抄进 CHILD_PREAMBLE；工厂签名/Config 口径一变
// 子进程侧就静默停在旧副本上，探针变成「在测一份过期的夹具」而套件仍绿。下面两条把同源关系钉死。
check('CHILD_PREAMBLE: 不得内联一份 createMessageStore 装配（必须由父进程夹具工厂生成）', () => {
  assert.ok(!/const mockUtils = \{/.test(CHILD_PREAMBLE), 'preamble 不得再手抄 mockUtils 字面量：工厂签名/Config 一变就静默漂移')
  assert.ok(CHILD_PREAMBLE.includes(String(buildFixtureStore)) && CHILD_PREAMBLE.includes(String(buildMockUtils)),
    'preamble 必须由 buildFixtureStore/buildMockUtils 源码生成（父进程/探针/子进程同源）')
})

check('CHILD_PREAMBLE: 子进程夹具与父进程夹具对拍（_resolveMaxSize 同值）', () => {
  const child = runChildProbe('process.stdout.write(String(makeStore()._resolveMaxSize()))').trim()
  assert.strictEqual(child, String(store._resolveMaxSize()), '子进程夹具必须与父进程同源（不得是抄过去的旧副本）')
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
// 生产的第二级候选（fallback）目录名是按 XBK_PARALLEL_ID **现算**的（xbk_message_store.js:95），
// 与 raw 同源但可能不同名；resolveCacheDirInRoot 的顺序是 raw → fallback → .xbk_cache_safe。
// 因此「回退应急目录」这两条场景必须把**两级默认候选都置为不可用**，否则设了分片变量时生产会正确地
// 落在分片目录，而用例按「未设变量」的语义断言 .xbk_cache_safe —— 同一份代码带/不带该变量会得出
// 相反结论（本机实测：带变量 2 条红、不带就过）。
// ⚠️ 键顺序即语义：对象字面量后写覆盖先写。env 未设时 FALLBACK_DIR === DEFAULT_DIR 是**同一个键**，
// 把 [FALLBACK_DIR] 写在 [DEFAULT_DIR] 之后，它的 'file' 会悄悄盖掉本场景真正要测的形态——
// 评审实测踩过：那样一写，「符号链接逃根」这条在 CI 默认配置（变量未设）下不再测符号链接，
// 把生产的 realpath 防御打掉也不会变红（原样写法：符号链接场景红=0；本写法：两种配置都红）。
// 故 fallback 条目一律**前置**，并用下面的 defaultShape 不变式把键覆盖这件事钉死。
const FALLBACK_DIR = path.join(FAKE_ROOT, process.env.XBK_PARALLEL_ID
  ? `xianbaoku_cache_p${process.env.XBK_PARALLEL_ID}`
  : 'xianbaoku_cache')
const SYMLINK_OUTSIDE = { kind: 'dir', real: '/outside/xianbaoku_cache' }
const CACHE_FS_SCENARIOS = [
  {
    name: '默认目录是根内正常目录 → 原样使用',
    map: { [FAKE_ROOT]: 'dir', [DEFAULT_DIR]: 'dir' },
    defaultShape: 'dir',
    expect: DEFAULT_DIR
  },
  {
    name: '默认目录从未创建（父级存在）→ 仍使用默认目录',
    map: { [FAKE_ROOT]: 'dir' },
    expect: DEFAULT_DIR
  },
  {
    name: '默认目录与分片回退名都被普通文件占位 → 回退 .xbk_cache_safe（生产口径）',
    map: { [FAKE_ROOT]: 'dir', [FALLBACK_DIR]: 'file', [DEFAULT_DIR]: 'file' },
    defaultShape: 'file',
    expect: SAFE_DIR
  },
  {
    name: '默认目录是逃出根目录的符号链接且分片回退名也不可用 → 回退 .xbk_cache_safe（生产口径）',
    map: { [FAKE_ROOT]: 'dir', [FALLBACK_DIR]: 'file', [DEFAULT_DIR]: SYMLINK_OUTSIDE },
    defaultShape: SYMLINK_OUTSIDE,
    expect: SAFE_DIR
  }
]

for (const scenario of CACHE_FS_SCENARIOS) {
  check(`QX-08 同源解析：${scenario.name}（--status 必须与生产 getter 一致）`, () => {
    // 前置不变式：声明了 defaultShape 的场景，map 里 DEFAULT_DIR 这一项必须还是那个形态
    // ——专门用来抓住上面说的键覆盖（后写把先写盖掉），否则场景名与实际布景会说谎。
    if (scenario.defaultShape !== undefined) {
      assert.deepStrictEqual(scenario.map[DEFAULT_DIR], scenario.defaultShape,
        `场景布景被键覆盖：DEFAULT_DIR 应为 ${JSON.stringify(scenario.defaultShape)}，实际 ${JSON.stringify(scenario.map[DEFAULT_DIR])}（fallback 条目必须前置）`)
    }
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

// ===== F7 残留（R6：getFileName「转义后名字集合」单射的**性质测试**）=====
// W2 实测新碰撞：getFileName('https://x/url_') 与 getFileName('https://x/url_.json') 都是
// 'url_url_.json'（先前置 'url_' 再补 '.json' 后缀，两次改写叠加后像集相交）。这里用**语料 + 性质**
// 证明修法后「同缓存名 ⇒ 同 URL（等价）」成立，而不是只钉两三个例子。
// 等价口径（与既有断言一致）：清洗阶段（剥离 query/hash、保留字符 → '_'、去控制字符、空/纯点串 →
// 'default'）是**故意**的粗化；此外「仅差一个 .json 后缀」的粗化由既有断言钉死（test_filter 的
// `'abc' → 'abc.json'` 与 `'a.json' → 'a.json'`、`'.hidden' → 'url_.hidden.json'`），不在本次范围。
const relSeg = (seg) => {
  // 与 getFileName 内部同序的清洗镜像：只用于构造「等价类」参照，不参与生产逻辑
  const url = 'https://x/' + seg
  const parts = url.split('/')
  let name = parts[parts.length - 1].split(/[?#]/)[0]
  if (!name || /^\.+$/.test(name)) name = 'default'
  name = name.replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '')
  return name || 'default'
}
const canonJson = (s) => (s.endsWith('.json') ? s.slice(0, -'.json'.length) : s)

check('F7 残留: getFileName 性质测试——同名缓存文件必来自等价末段（语料级单射）', () => {
  const segs = [
    'x', 'x.json', 'x.JSON', '.json', '.hidden', '.hidden.json', '..', '.', '...',
    'url_', 'url_.json', 'url_url_', 'url_url_.json', 'url_x', 'url_x.json',
    'url_.hidden', 'url_.hidden.json', 'url_.json.json',
    'a b', ' a ', '\t\n x', 'x\u0000y', 'a|b.json', 'c:1.json', 'a?b=1', 'a#frag',
    '.json.json', 'a.json.json', '.secret', 'data.json', 'default', 'default.json',
    'u'.repeat(260) + 'aaaa.json', 'u'.repeat(260) + 'bbbb.json', 'x'.repeat(300),
    '[object Object]', 'seen.cleanup.lock', 'a/b', 'a\\b', 'a*b', 'a"b', '%20', 'a%5Cb'
  ]
  const names = segs.map(s => store.getFileName('https://x/' + s))
  let pairs = 0
  let escapePairs = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (names[i] !== names[j]) continue
      pairs += 1
      const ci = relSeg(segs[i])
      const cj = relSeg(segs[j])
      // Q1：碰撞只能来自已完成文档化的两处粗化（清洗等价 / 仅差 .json 后缀）
      assert.ok(ci === cj || canonJson(ci) === canonJson(cj),
        `不同末段撞同一缓存名 ${names[i]}：${JSON.stringify(segs[i])} vs ${JSON.stringify(segs[j])}（清洗后 ${JSON.stringify(ci)} / ${JSON.stringify(cj)}）`)
      // Q2：**转义类**（以 . 或 url_ 开头）必须严格单射——除「同以 . 开头且仅差 .json」（既有断言
      // 钉死的隐藏文件前缀口径）外，不允许任何额外粗化。W2 的 'url_' vs 'url_.json' 落在这里。
      const escI = ci.startsWith('.') || ci.startsWith('url_')
      const escJ = cj.startsWith('.') || cj.startsWith('url_')
      if (escI && escJ) {
        escapePairs += 1
        assert.ok(ci === cj || (ci.startsWith('.') && cj.startsWith('.') && canonJson(ci) === canonJson(cj)),
          `转义类不得额外粗化：${JSON.stringify(segs[i])}(${ci}) 与 ${JSON.stringify(segs[j])}(${cj}) 撞成 ${names[i]}`)
      }
    }
  }
  assert.ok(segs.length >= 40, `语料规模须足够（实际 ${segs.length} 条末段）`)
  // 修法后映射必须**至少与文档化口径一样细**：'url_'-来源不再与 'url_x.json' 型来源合并，
  // 故不同缓存名的数量不得少于「清洗 + 仅差 .json 视为同一」的等价类数量。
  const canonClasses = new Set(segs.map(s => canonJson(relSeg(s)))).size
  assert.ok(new Set(names).size >= canonClasses,
    `缓存名去重数 ${new Set(names).size} 不得少于文档化等价类数 ${canonClasses}（更粗即引入未文档化合并）`)
  // Q3：'url_'-来源（转义类里唯一可能被「补 .json」二次改写的一支）必须**严格单射**——
  // 不同清洗名 ⇒ 不同缓存名。'.'-来源仍受既有隐藏文件前缀断言约束（仅差 .json 视为同一）。
  const escSegs = segs.filter(s => { const c = relSeg(s); return c.startsWith('.') || c.startsWith('url_') })
  const escNames = escSegs.map(s => store.getFileName('https://x/' + s))
  const escExpected = new Set(escSegs.map(s => { const c = relSeg(s); return c.startsWith('.') ? canonJson(c) : c })).size
  assert.ok(new Set(escNames).size >= escExpected,
    `转义类缓存名去重数 ${new Set(escNames).size} 不得少于清洗名去重数 ${escExpected}（'url_' 与 'url_.json' 这类必须分开）`)
  // 显式反例：W2 的新碰撞必须消失，且不得回退既有两项修复
  assert.notStrictEqual(store.getFileName('https://x/url_'), store.getFileName('https://x/url_.json'), "W2 反例：'url_' 与 'url_.json' 不得撞名")
  assert.strictEqual(store.getFileName('https://x/url_.json'), 'url_url_.json', '既有产物不得改动（test_filter/test_message_store_utils 钉死）')
  assert.strictEqual(store.getFileName('https://x/.json'), 'url_.json', '隐藏文件前缀防护不得回退')
  for (const n of names) {
    assert.ok(!n.startsWith('.'), `getFileName 产物不得是隐藏文件：${n}`)
    assert.ok(n.endsWith('.json'), `getFileName 产物须保留 .json 后缀：${n}`)
  }
  console.log(`     （语料 ${segs.length} 条末段 / 撞名对数 ${pairs}，其中转义类 ${escapePairs}）`)
})

// ===== F-02（B8 回归；V6 实锤漏推方向）=====
// 反例：_identityIndex 的 O(1) 失效检查只看「引用 / 长度 / 首元素引用」，调用方**原地改写非首元素**
// （换元素或改 id/url 字段）不会触发重建，旧索引把已不存在的身份判为「已存在」→ has() 返回 true
// → 主流程跳过推送（漏推，与 SYSTEM_CONTRACT「宁可多推」相反）。这里用真实 Utils + 假 fs +
// 内存权威数组做单元级 oracle 对拍（oracle = _indexHasIdentityDirect 零索引线性扫描）。
// C5-077：每次 seed 都 new 一个实例——隔离由构造保证，不再靠「文件名不撞」的命名约定，
// 也不需要手工回退 _memoryCache / _memoCount / _verified（旧写法一旦漏写或换名，陈旧条目
// 就被下一个用例当作「已推送」判重，曾实锤漏推假绿）。
function makeIdentityStore () {
  return createMessageStore({
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
}

let identityStore = makeIdentityStore()

function seedIdentityProbe (messages, name) {
  // 全新实例 ⇒ 同一用例内不存在前序用例的 _memoryCache/_verified/_memoCount 残留
  identityStore = makeIdentityStore()
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

// ===== F-02 残留（R6：W2 实测 missVerified 跨数组版本粘滞）=====
// 反例（W2，4 步）：① 预热索引 → ② 原位替换非首元素 → ③ 查一个不存在的身份（本数组版本**首次**
// 未命中 ⇒ 全量复检并把 missVerified 置真）→ ④ 再原位替换同一位置、只查被替换者。
// 修复前：index 命中候选复检落空、索引层不含新身份、missVerified 已粘滞为真 ⇒ 不再重建，
// has() 对**数组里确实存在**的身份恒定返回 false，且此后永不恢复（自愈设计意图被破坏）。
// 方向是「多推」侧（SYSTEM_CONTRACT 允许），但仍与线性扫描 oracle 不一致，故必须闭合。
check('F-02 残留: 未命中重建后再原位替换非首元素，has 必须自愈（W2 4 步反例）', () => {
  const arr = [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]
  const name = seedIdentityProbe(arr, 'f02_sticky.json')
  assert.strictEqual(identityStore.has({ id: 'w1' }, name), true, '前置：预热索引')
  arr[1] = { id: 'w2b' }
  assert.strictEqual(identityStore.has({ id: 'zzz-absent' }, name), false, '第③步：不存在的身份判否（触发首次未命中复检，missVerified 置真）')
  assert.strictEqual(identityStore.has({ id: 'w2b' }, name), true, '前置：替换后的身份可见')
  arr[1] = { id: 'w2c' }
  for (let round = 1; round <= 3; round++) {
    const got = identityStore.has({ id: 'w2c' }, name)
    const oracle = identityStore._indexHasIdentityDirect(arr, { id: 'w2c' })
    assert.strictEqual(got, oracle, `第 ${round} 次查询 has()=${got} 必须等于 oracle=${oracle}（粘滞漏判即红）`)
  }
  assert.strictEqual(identityStore.has({ id: 'w2c' }, name), true, '数组里确实存在 w2c：不得恒定 false（粘滞未闭合）')
})

check('F-02 残留: 同族变体——字段级原位改写 + 首元素替换 + 扩容后只查新身份', () => {
  const arr = [{ id: 'v1', url: 'https://v.example/1' }, { id: 'v2', url: 'https://v.example/2' }, { id: 'v3' }]
  const name = seedIdentityProbe(arr, 'f02_sticky_forms.json')
  assert.strictEqual(identityStore.has({ id: 'v1' }, name), true, '前置：预热索引')
  assert.strictEqual(identityStore.has({ id: 'absent-1' }, name), false, '前置：先置 missVerified')
  // 同族形态逐条对拍：字段级改写、首元素替换、长度不变的原位改写、追加
  const forms = [
    { label: 'arr[2].id 字段改写', mutate: (a) => { a[2].id = 'v3-new' }, probes: [{ id: 'v3-new' }, { id: 'v3' }] },
    { label: 'arr[0] 首元素整体替换', mutate: (a) => { a[0] = { id: 'v1-new', url: 'https://v.example/1' } }, probes: [{ id: 'v1-new' }, { id: 'v1' }] },
    { label: 'arr[1].url 字段改写', mutate: (a) => { a[1].url = 'https://v.example/2-new' }, probes: [{ url: 'https://v.example/2-new' }, { url: 'https://v.example/2' }] },
    { label: 'push 追加（长度变化）', mutate: (a) => { a.push({ id: 'v9' }) }, probes: [{ id: 'v9' }] }
  ]
  for (const form of forms) {
    form.mutate(arr)
    for (const p of form.probes) {
      const got = identityStore.has(p, name)
      const oracle = identityStore._indexHasIdentityDirect(arr, p)
      assert.strictEqual(got, oracle,
        `${form.label}：has()=${got} 必须等于 oracle=${oracle}（probe=${JSON.stringify(p)}；true 侧不符即漏推）`)
    }
  }
})

check('F-02 残留: 大数组原位替换的自愈有上界（旋转抽查一轮内必须恢复，不得永不恢复）', () => {
  const n = 200
  const arr = []
  for (let i = 0; i < n; i++) arr.push({ id: 'big-' + i })
  const name = seedIdentityProbe(arr, 'f02_heal.json')
  assert.strictEqual(identityStore.has({ id: 'big-0' }, name), true, '前置：索引已建立')
  assert.strictEqual(identityStore.has({ id: 'absent-0' }, name), false, '前置：先置 missVerified（复现粘滞前提）')
  const realBuild = identityStore._buildIdentityIndex
  let builds = 0
  identityStore._buildIdentityIndex = function (...args) { builds += 1; return realBuild.apply(this, args) }
  try {
    arr[100] = { id: 'big-100-new' } // 非首元素整体替换：引用/长度/首元素引用都看不出
    // 引用层抽查窗宽 32 ⇒ 一轮 ceil(200/32)=7 次未命中即可覆盖到第 100 位，取 8 为硬上界
    // （**写成字面量**：若写成 ceil(n/WINDOW) 而 WINDOW 被靶向改 0 会得到 Infinity，测试会挂死而不是变红）
    const bound = 8
    let healed = false
    for (let k = 0; k < bound; k++) {
      if (identityStore.has({ id: 'big-100-new' }, name)) { healed = true; break }
    }
    assert.ok(healed, `引用层抽查必须在 ${bound} 次未命中内自愈（否则粘滞未闭合；窗宽 32 ⇒ ceil(${n}/32)=7）`)
    // 自愈代价必须仍是「每轮至多一次重建」，不能退化成每次未命中都重建
    assert.ok(builds <= 3, `自愈过程的重建次数须有界（每轮抽查至多一次），实际 ${builds} 次`)
  } finally {
    identityStore._buildIdentityIndex = realBuild
  }
  for (const p of [{ id: 'big-100-new' }, { id: 'big-100' }, { id: 'big-0' }]) {
    assert.strictEqual(identityStore.has(p, name), identityStore._indexHasIdentityDirect(arr, p),
      `自愈后 has 仍须与线性扫描 oracle 一致（probe=${JSON.stringify(p)}）`)
  }
})

// ===== 变异靶向回归（内存键上限 / 锁 token / /proc 启动时钟 / 启动清理哨兵）=====
// 夹具口径：内存 fs + 记录型 storage。所有断言只观察「可观测副作用」——落盘文本、写盘次数、
// 键计数、游标、返回值——不依赖本机时区（时间戳只用 Date.now() 的绝对值；本文件全部用例在
// `TZ=UTC` 与本机时区下都必须同结论，对齐 CI（UTC）口径）。
const REAL_CRYPTO = require('node:crypto')
const REAL_FS = require('node:fs')
const ROOT_DIR = __dirname
const CACHE_DIR = path.join(ROOT_DIR, 'xianbaoku_cache')
const cachePath = (name) => path.join(CACHE_DIR, name)

// 内存文件系统：exists/lstat/read/write(wx)/rename/unlink 语义够用即可；ROOT_DIR 恒为目录，
// 使 resolveCacheDirInRoot 的根内校验通过（不触碰真实仓库目录）。
function makeMemFs (initial) {
  const files = new Map(Object.entries(initial || {}))
  const dirs = new Set([ROOT_DIR])
  const hooks = { afterRename: null }
  const ops = { rename: [], unlink: [], write: [] }
  return {
    files,
    dirs,
    hooks,
    ops,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e }
      return files.get(p)
    },
    writeFileSync: (p, text, opts) => {
      if (opts && opts.flag === 'wx' && files.has(p)) { const e = new Error('EEXIST: ' + p); e.code = 'EEXIST'; throw e }
      ops.write.push(p)
      files.set(p, String(text))
    },
    unlinkSync: (p) => {
      ops.unlink.push(p)
      files.delete(p)
    },
    renameSync: (a, b) => {
      if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e }
      ops.rename.push([a, b])
      files.set(b, files.get(a))
      files.delete(a)
      if (hooks.afterRename) hooks.afterRename(a, b)
    },
    mkdirSync: (p) => dirs.add(p),
    lstatSync: (p) => {
      if (!files.has(p) && !dirs.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e }
      // size 与真实 lstat 同口径（F1 的「仍超限」复核要读它）；目录/不存在时给 0
      return { size: files.has(p) ? Buffer.byteLength(files.get(p), 'utf8') : 0, isDirectory: () => dirs.has(p), isFile: () => files.has(p), isSymbolicLink: () => false }
    },
    realpathSync: (p) => p,
    statSync: (p) => ({ isDirectory: () => dirs.has(p) })
  }
}

function makeRecordingStorage (fsMock, opts = {}) {
  const writes = []
  return {
    writes,
    readSafeTextResult: (p, maxBytes, options) => {
      if (opts.readStatus) { const r = opts.readStatus(p, fsMock, options); if (r) return r }
      if (!fsMock.files.has(p)) return { status: 'missing' }
      const text = fsMock.files.get(p)
      const bytes = Buffer.byteLength(text, 'utf8')
      if (maxBytes && bytes > maxBytes) {
        // 与真实 readSafeTextResult 同口径：{tail:true} 读尾部 maxBytes 字节（不判 tooLarge）
        if (options && options.tail === true) {
          const buf = Buffer.from(text, 'utf8')
          return { status: 'ok', text: buf.subarray(bytes - maxBytes).toString('utf8'), truncated: true }
        }
        return { status: 'tooLarge' }
      }
      return { status: 'ok', text }
    },
    writeAtomic: (p, text, label) => {
      writes.push({ p, text, label })
      if (opts.failWrite) return false
      fsMock.files.set(p, String(text))
      return true
    },
    writeAtomicIfAbsent: (p, text, label) => {
      writes.push({ p, text, label })
      if (opts.failInit) return false
      if (!opts.initNoFile && !fsMock.files.has(p)) fsMock.files.set(p, String(text))
      return true
    }
  }
}

function makeBatchStore (opts = {}) {
  const fsMock = opts.fsMock || makeMemFs(opts.files)
  const storage = makeRecordingStorage(fsMock, opts)
  const store = createMessageStore({
    Config: opts.noMaxSize ? { cache: {} } : { cache: { dir: 'xianbaoku_cache', maxSize: opts.maxSize === undefined ? 10000 : opts.maxSize } },
    Utils: createUtils({ fs: REAL_FS, safeRe: (p, f) => new RegExp(p, f) }),
    fs: fsMock,
    path,
    crypto: opts.crypto || { randomUUID: () => 'uuid', timingSafeEqual: REAL_CRYPTO.timingSafeEqual },
    normalize: (o) => o,
    storage,
    constants: Object.assign({
      DEFAULT_MAX_SIZE: 10000,
      MESSAGE_CACHE_MAX_BYTES: 8388608,
      TOMBSTONE_MAX_KEYS: 5000,
      TOMBSTONE_MAX_BYTES: 262144,
      TOMBSTONE_LOCK_STALE_MS: 10000
    }, opts.constants)
  })
  const name = opts.name || 'b.json'
  return { store, fs: fsMock, storage, writes: storage.writes, filePath: cachePath(name) }
}

function captureConsole (method, fn) {
  const lines = []
  const orig = console[method]
  console[method] = (...args) => lines.push(args.map(String).join(' '))
  try { fn() } finally { console[method] = orig }
  return lines
}

const cacheWrites = (writes) => writes.filter(w => w.label === '缓存')

// ===== C3-010：cache.dir 被安全检查拒绝时必须可见（静默回退 = 判重主存换文件）=====
// 旧实现直接 return 回退目录、一句都不说：运维只看到「缓存没了 / 又开始重复推送」，无从知道
// push.json 已经写到 .xbk_cache_safe。这里用假 fs 把默认目录做成「普通文件占位」，断言回退
// 目录 + 恰好一条 WARN（getter 每轮都会求值，必须按 raw→chosen 去重，不能每轮刷一条）。
check('C3-010 缓存目录回退必须 WARN（且按 raw→目标去重，不随每轮求值刷屏）', () => {
  // raw 用唯一值：去重表是模块级的，别的用例可能已经告过同一个 raw→目标组合
  const raw = 'c3010_probe_cache'
  const rejected = path.join(FAKE_ROOT, raw)
  const fakeFs = {
    existsSync: (p) => p === rejected, // 自定义目录被**普通文件**占位（真实生产里最常见的拒绝形态）
    lstatSync: (p) => ({ isDirectory: () => p !== rejected }), // 只有它不是一个目录
    realpathSync: (p) => p
  }
  const warns = captureConsole('warn', () => {
    const a = resolveCacheDirInRoot({ fs: fakeFs, path, root: FAKE_ROOT, raw, fallback: 'xianbaoku_cache' })
    const b = resolveCacheDirInRoot({ fs: fakeFs, path, root: FAKE_ROOT, raw, fallback: 'xianbaoku_cache' })
    assert.strictEqual(a, b, '同一输入两次求值必须同结果（去重不得影响返回值）')
    assert.strictEqual(a, DEFAULT_DIR, `自定义目录被拒绝时回退到默认目录：${a}`)
  })
  const fb = warns.filter(w => w.includes('缓存目录配置未生效'))
  assert.strictEqual(fb.length, 1, `回退只应告警一次（getter 每轮求值）：${JSON.stringify(warns)}`)
  assert.ok(fb[0].includes(rejected) && fb[0].includes(DEFAULT_DIR),
    `告警必须同时点名「被拒绝的配置」与「实际回退目录」：${fb[0]}`)
})

// ===== C3-007：不同 pushUrl 撞到同一缓存文件必须显形 =====
// 缓存文件名只由 URL 末段派生：两个不同来源（换域名、同末段的两个接口）会静默共用一份 push.json
// ⇒ 两边的判重记录互相覆盖（方向=漏推）。改名会迁移既有判重记录（等同全量重推），故只告警不改名。
check('C3-007 两个不同 pushUrl 撞到同一缓存名必须 WARN（每对一次），同名同源不告警', () => {
  const h = makeBatchStore({ name: 'c3007.json' })
  const u1 = 'https://a.example.com/api/push.json'
  const u2 = 'https://b.example.com/api/push.json'
  const warns = captureConsole('warn', () => {
    assert.strictEqual(h.store.getFileName(u1), 'push.json')
    assert.strictEqual(h.store.getFileName(u2), 'push.json', '末段相同 ⇒ 同一缓存名（共用判重主存的入口）')
    assert.strictEqual(h.store.getFileName(u2), 'push.json', '重复调用结果不变')
    assert.strictEqual(h.store.getFileName(u1), 'push.json')
  })
  const hits = warns.filter(w => w.includes('同一缓存文件'))
  assert.strictEqual(hits.length, 1, `同一对撞名只应告警一次：${JSON.stringify(warns)}`)
  assert.ok(hits[0].includes(u1) && hits[0].includes(u2), `告警必须点名两端 URL：${hits[0]}`)
  // 对照：同一个 URL 反复取用不得告警（否则每轮每源都刷一条，噪音淹没真撞名）
  const h2 = makeBatchStore({ name: 'c3007b.json' })
  const warns2 = captureConsole('warn', () => {
    h2.store.getFileName(u1)
    h2.store.getFileName(u1)
  })
  assert.strictEqual(warns2.filter(w => w.includes('同一缓存文件')).length, 0, `同源重复取用不得告警：${JSON.stringify(warns2)}`)
})

// ===== C3-009：超限裁剪的序列化次数 =====
// 旧实现把整份数组序列化三次：saveMessages 的初稿、_trimCacheByBytes 的「真实数组口径校准」、
// 以及 splicing 之后的终稿——超限轮次的峰值内存因此是 3×（初稿在裁剪期间一直活着）。
// 修后：初稿确认超限即丢弃，校准与终稿合并成一次 ⇒ 整份数组只序列化 2 次；未超限仍是 1 次。
check('C3-009 超限裁剪只序列化整份数组 2 次（旧实现 3 次）', () => {
  const name = 'c3009_trim.json'
  const h = makeBatchStore({ name, constants: { MESSAGE_CACHE_MAX_BYTES: 400 } })
  const msgs = []
  for (let i = 0; i < 30; i++) msgs.push({ id: 'id-' + i, title: 't'.repeat(60), url: 'https://example.com/' + i })
  const origStringify = JSON.stringify
  let arrayCalls = 0
  JSON.stringify = function (value, ...rest) {
    if (Array.isArray(value)) arrayCalls++
    return origStringify.call(JSON, value, ...rest)
  }
  let ok
  try { ok = h.store.saveMessages(h.filePath, msgs) } finally { JSON.stringify = origStringify }
  assert.strictEqual(ok, true, '裁剪后应成功落盘')
  assert.strictEqual(arrayCalls, 2, `整份数组的序列化次数必须恰为 2（初稿 + 终稿），实际 ${arrayCalls} 次`)
  const written = h.fs.files.get(h.filePath)
  assert.ok(Buffer.byteLength(written, 'utf8') <= 400, '终稿必须落在读端上限内')
  assert.ok(JSON.parse(written).length < 30, '必须真的裁掉最早的若干条')
})

check('C3-009 对照：未超限时仍然只序列化 1 次（不得为省内存白白多一次全量 stringify）', () => {
  const name = 'c3009_fast.json'
  const h = makeBatchStore({ name, constants: { MESSAGE_CACHE_MAX_BYTES: 1048576 } })
  const msgs = [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }]
  const origStringify = JSON.stringify
  let arrayCalls = 0
  JSON.stringify = function (value, ...rest) {
    if (Array.isArray(value)) arrayCalls++
    return origStringify.call(JSON, value, ...rest)
  }
  let ok
  try { ok = h.store.saveMessages(h.filePath, msgs) } finally { JSON.stringify = origStringify }
  assert.strictEqual(ok, true, '未超限应直接落盘')
  assert.strictEqual(arrayCalls, 1, `未超限只应有 1 次整份序列化，实际 ${arrayCalls} 次`)
})

// ===== C3-005：隔离备份「名字要原子预留、份数要有上限」=====
// 旧实现 existsSync → rename 之间有空窗：另一进程能在缝里抢先建同名 .bak，rename 随后把它静默
// 覆盖（上一份备份被销毁）。修法 = O_EXCL 预留占位（名字一落地就归本次调用）。判别式断言是
// 「返回的名字**立刻**就存在（0 字节占位）且两次调用必不同」——旧实现返回的名字当时都不存在。
check('C3-005 隔离备份名必须 O_EXCL 原子预留：返回即存在、连续两次必不同（不覆盖上一份备份）', () => {
  const dir = path.join(__dirname, 'xianbaoku_cache', 'c3005_reserve')
  const base = path.join(dir, 'r.json')
  REAL_FS.mkdirSync(dir, { recursive: true })
  try {
    const s = storeWithFs(REAL_FS, path.relative(ROOT_DIR, dir))
    const a = s._corruptBackupPath(base)
    assert.ok(typeof a === 'string' && a.endsWith('.bak'), `必须返回备份名：${a}`)
    assert.strictEqual(REAL_FS.existsSync(a), true, '返回的备份名必须已由本次调用原子预留（占位文件当场存在）')
    assert.strictEqual(REAL_FS.lstatSync(a).isFile(), true, '预留必须是普通文件占位')
    assert.strictEqual(REAL_FS.lstatSync(a).size, 0, '预留占位必须是 0 字节（rename 覆盖它不丢任何内容）')
    const b = s._corruptBackupPath(base)
    assert.notStrictEqual(b, a, '同名备份已被占用时必须换名——绝不复用（否则 rename 覆盖上一份备份）')
    assert.strictEqual(REAL_FS.existsSync(b), true, '第二个名字同样必须已预留')
    assert.strictEqual(REAL_FS.lstatSync(a).size, 0, '第二个名字的预留不得动到第一份（仍是空占位）')
    // 释放：只删本次预留的空占位
    s._releaseReservedBackup(a)
    assert.strictEqual(REAL_FS.existsSync(a), false, '释放必须删掉本次预留的空占位')
    REAL_FS.writeFileSync(b, '已写入的真实备份')
    s._releaseReservedBackup(b)
    assert.strictEqual(REAL_FS.existsSync(b), true, '已被覆盖成真备份的名字不得被释放逻辑删掉')
  } finally {
    REAL_FS.rmSync(dir, { recursive: true, force: true })
  }
})

check('C3-005 隔离备份保留上限：每缓存文件最多 10 份、最旧先删、非本模块命名的文件不动', () => {
  const dir = path.join(__dirname, 'xianbaoku_cache', 'c3005_prune')
  REAL_FS.mkdirSync(dir, { recursive: true })
  const base = path.join(dir, 'p.json')
  const stamp = (i) => `2026-10-31T00-00-00-${String(i).padStart(3, '0')}Z`
  try {
    for (let i = 0; i < 12; i++) {
      const f = `${base}.corrupt.${stamp(i)}.bak`
      REAL_FS.writeFileSync(f, `backup-${i}`)
      // 退避到确定的 mtime（同一毫秒写完时排序只能靠文件名兜底，这里显式把时间序也铺开）
      REAL_FS.utimesSync(f, new Date(1761900000000 + i * 1000), new Date(1761900000000 + i * 1000))
    }
    REAL_FS.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    REAL_FS.writeFileSync(`${base}.corrupt.not-a-stamp.bak`, 'y')
    const s = storeWithFs(REAL_FS, path.relative(ROOT_DIR, dir))
    const warns = captureConsole('warn', () => {
      assert.strictEqual(s._pruneCorruptBackups(base), 2, '12 份备份 + 上限 10 ⇒ 必须删掉最旧 2 份')
    })
    const left = REAL_FS.readdirSync(dir).filter(n => n.startsWith('p.json.corrupt.') && /^p\.json\.corrupt\.2026-10-31T00-00-00-\d{3}Z\.bak$/.test(n)).sort()
    assert.strictEqual(left.length, 10, `保留份数必须恰为 10：${JSON.stringify(left)}`)
    assert.ok(!left.includes(`p.json.corrupt.${stamp(0)}.bak`), '最旧的一份必须被清理')
    assert.ok(!left.includes(`p.json.corrupt.${stamp(1)}.bak`), '次旧的一份必须被清理')
    assert.ok(left.includes(`p.json.corrupt.${stamp(11)}.bak`), '最新的一份必须保留')
    assert.strictEqual(REAL_FS.existsSync(path.join(dir, 'notes.txt')), true, '非本模块命名的文件一律不动')
    assert.strictEqual(REAL_FS.existsSync(`${base}.corrupt.not-a-stamp.bak`), true, '命名口径不符的文件不动（不得按前缀误删）')
    assert.ok(warns.some(w => w.includes('保留上限') && w.includes('2')), `清理必须有告警说明：${JSON.stringify(warns)}`)
  } finally {
    REAL_FS.rmSync(dir, { recursive: true, force: true })
  }
})

// ===== C3-008：墓碑 0 字节 / 损坏不得被当成「空集」静默吞掉 =====
// 旧实现：0 字节走 `!result.text` 直接 return null（status 仍是 ok）、损坏走 JSON.parse 异常，
// 两条出口都不置位 _tombstoneLoaded ⇒ 每条消息重读一次整份墓碑（上限 8MiB）+ 每条一条 WARN；
// 下一次落墓碑又把损坏文件整份覆盖写回（无 .bak，现场永久销毁）。修后：0 字节记 empty、
// 损坏先改名隔离再记 corrupt，二者都算「磁盘已给出确定答案」（置位 + 只告警一次）。
check('C3-008 墓碑损坏：先改名隔离（原件保留）再按空集处理，置位且只读一次/只告警一次', () => {
  const name = 'c3008_corrupt.json'
  const seenPath = path.join(__dirname, 'xianbaoku_cache', name) + '.seen.json'
  const corruptText = '{"v":1,"id":["a"],"urlOnly":['
  let reads = 0
  const h = makeBatchStore({ name, files: { [seenPath]: corruptText }, readStatus: (p) => { if (p === seenPath) reads++; return null } })
  const warns = captureConsole('warn', () => {
    assert.strictEqual(h.store._tombstoneHasIdentity(h.filePath, { id: 'probe-a' }), false, '损坏墓碑按空集处理')
    assert.strictEqual(h.store._tombstoneHasIdentity(h.filePath, { id: 'probe-b' }), false, '第二次判重不得命中')
  })
  assert.strictEqual(reads, 1, `损坏墓碑确认后不得每条消息重读磁盘（实际读盘 ${reads} 次）`)
  assert.strictEqual(h.store._tombstoneLoaded.has(h.filePath), true, '已隔离的损坏墓碑必须置位（否则每条消息重读）')
  assert.strictEqual(h.store._tombstoneLoadStatus[h.filePath], 'corrupt', '读盘状态必须如实记为 corrupt')
  const backups = [...h.fs.files.keys()].filter(p => p.startsWith(seenPath + '.corrupt.') && p.endsWith('.bak'))
  assert.strictEqual(backups.length, 1, `损坏墓碑必须改名隔离一份（实际 ${JSON.stringify([...h.fs.files.keys()])}）`)
  assert.strictEqual(h.fs.files.get(backups[0]), corruptText, '隔离件必须逐字保留损坏原文（只隔离不删除）')
  assert.strictEqual(h.fs.files.has(seenPath), false, '在线路径必须让出来（下一次落墓碑重建）')
  assert.strictEqual(warns.filter(w => w.includes('墓碑文件损坏') && w.includes('已改名隔离')).length, 1,
    `损坏只应告警一次（每条消息一条 WARN 会把日志刷屏）：${JSON.stringify(warns)}`)
  // 下一次落墓碑按空集重建：新文件可写，且隔离件仍在（旧身份可人工取回）
  h.store._tombstoneDropped(h.filePath, [{ id: 'rebuilt-7' }])
  assert.strictEqual(h.fs.files.has(seenPath), true, '下一次落墓碑必须在原路径重建')
  assert.ok(String(h.fs.files.get(seenPath)).includes('rebuilt-7'), '重建内容必须包含本次身份')
  assert.strictEqual(h.fs.files.get(backups[0]), corruptText, '重建不得动隔离件（旧身份仍在 .bak 里）')
})

check('C3-008 墓碑 0 字节：按 empty 置位、不产生 .bak、只读一次/只告警一次', () => {
  const name = 'c3008_empty.json'
  const seenPath = path.join(__dirname, 'xianbaoku_cache', name) + '.seen.json'
  let reads = 0
  const h = makeBatchStore({ name, files: { [seenPath]: '' }, readStatus: (p) => { if (p === seenPath) reads++; return null } })
  const warns = captureConsole('warn', () => {
    h.store._tombstoneHasIdentity(h.filePath, { id: 'probe-a' })
    h.store._tombstoneHasIdentity(h.filePath, { id: 'probe-b' })
  })
  assert.strictEqual(reads, 1, `0 字节墓碑确认后不得每条消息重读磁盘（实际读盘 ${reads} 次）`)
  assert.strictEqual(h.store._tombstoneLoaded.has(h.filePath), true, '0 字节墓碑必须置位（等价于确认缺失）')
  assert.strictEqual(h.store._tombstoneLoadStatus[h.filePath], 'empty', '读盘状态必须与「损坏」区分开（empty）')
  assert.deepStrictEqual(h.fs.ops.rename, [], '0 字节没有任何字节可隔离 ⇒ 不得产生备份')
  assert.strictEqual(warns.filter(w => w.includes('0 字节')).length, 1, `0 字节只应告警一次：${JSON.stringify(warns)}`)
})

check('_memoSet: 非字符串键必须 String 化后落键（Symbol 键也要可枚举、可参与淘汰）', () => {
  const s = createProbeStore()
  assert.strictEqual(s._memoSet(Symbol('sk'), 'v'), true)
  assert.deepStrictEqual(Object.keys(s._memoryCache), ['Symbol(sk)'])
  assert.strictEqual(s._memoryCache['Symbol(sk)'], 'v')
  assert.strictEqual(s._memoCount, 1)
})

check('_memoSet: 重复写同一键不重复计数且必须返回 true', () => {
  const s = createProbeStore()
  s._memoSet('p', 1)
  assert.strictEqual(s._memoSet('p', 2), true)
  assert.strictEqual(s._memoCount, 1, '已存在的键不得重复计数（否则容量上限被提前触发）')
  assert.strictEqual(s._memoryCache.p, 2)
})

check('_memoSet: 打满后按最旧先淘汰且计数与键数守恒（告警只降频一次）', () => {
  // 契约：上限满时淘汰最旧键（不得整体重置），且 _memoCount 与键数守恒；「数字样键排最前、
  // 不被当最旧淘汰」是生产注释明示的**防御性死代码**（xbk_message_store.js:144-148），不再锁细节。
  const s = createProbeStore()
  s._MEMO_MAX = 3
  const warns = captureConsole('warn', () => {
    s._memoSet('a', 'A')
    s._memoSet('b', 'B')
    s._memoSet('c', 'C')
    s._memoSet('d', 'D')
    s._memoSet('e', 'E')
  })
  assert.ok(Object.keys(s._memoryCache).length <= 3, '打满后键数不得超过上限')
  assert.strictEqual(Object.keys(s._memoryCache).length, s._memoCount, '计数必须与键数一致')
  assert.strictEqual('a' in s._memoryCache, false, '最旧的 a 必须被淘汰（淘汰必须推进）')
  assert.strictEqual('e' in s._memoryCache, true, '最新写入必须保留')
  assert.strictEqual(warns.length, 1, '容量降频告警只应出现一次（连续淘汰不得反复告警）')
})

check('_memoSet: 计数打满但对象为空时拒绝写入（无可淘汰键，不得写入负数计数）', () => {
  const s = createProbeStore()
  s._memoCount = s._MEMO_MAX
  assert.strictEqual(s._memoSet('only', 'v'), false, '无键可淘汰时必须拒绝写入')
  assert.deepStrictEqual(Object.keys(s._memoryCache), [], '拒绝写入时不得落键')
  assert.strictEqual(s._memoCount, s._MEMO_MAX, '拒绝写入时计数不得漂移')
})

check('_memoSet: 原型键必须写成自有可枚举键、不污染原型、且淘汰时必须真的删掉', () => {
  const s = createProbeStore()
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    assert.strictEqual(s._memoSet(k, 'V-' + k), true)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s._memoryCache, k), true, `${k} 必须成为自有键`)
    assert.strictEqual(s._memoryCache[k], 'V-' + k)
    assert.ok(Object.keys(s._memoryCache).includes(k), `${k} 必须可枚举（否则永不参与淘汰计数）`)
  }
  // 不锁 Object.getPrototypeOf(...) === Object.prototype：把「必须是普通对象」写成契约会挡住
  // Object.create(null) 这类防污染加固重写；真正的防污染性质由上方「自有可枚举键」断言守住。
  assert.strictEqual(s._memoSet('__proto__', 'V2'), true, '原型键必须可重复写入（writable/configurable 不得被改小）')
  // eslint-disable-next-line no-proto -- 被测点即字面量键 '__proto__' 能否作为普通自有键读写（null 原型表）
  assert.strictEqual(s._memoryCache.__proto__, 'V2')
  // 淘汰路径：最旧的 __proto__ 键必须被真正 delete 掉，否则计数与键数脱钩
  const s2 = createProbeStore()
  s2._MEMO_MAX = 2
  s2._memoSet('__proto__', 'P')
  s2._memoSet('b', 'B')
  s2._memoSet('c', 'C')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(s2._memoryCache, '__proto__'), false, '最旧的 __proto__ 必须被删除')
  assert.strictEqual(Object.keys(s2._memoryCache).length, s2._memoCount, '键数必须与 _memoCount 一致（删除失败会让计数漂移）')
})

check('_getTombstoneProcessStart: 非 Linux 平台必须直接返回 null 且完全不读 /proc', () => {
  const fsMock = makeMemFs()
  let reads = 0
  fsMock.readFileSync = () => { reads++; return '1 (node) S 1 2 3' }
  const { store: s } = makeBatchStore({ fsMock })
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true, writable: true })
  try {
    assert.strictEqual(s._getTombstoneProcessStart(4242), null, '非 Linux 无 /proc 启动时钟，必须返回 null')
    assert.strictEqual(reads, 0, '非 Linux 不得读 /proc/<pid>/stat')
  } finally {
    delete process.platform
    if (desc) Object.defineProperty(process, 'platform', desc)
  }
})

check('_getTombstoneProcessStart: Linux 下按 /proc/<pid>/stat 第 20 个字段精确解析 starttime', () => {
  if (process.platform !== 'linux') return
  // 字段区含连续空白（\s+ 与 \s 在此分歧），第 20 个字段（索引 19）为 19
  const stat = '4321 (node) S  1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20'
  const paths = []
  const fsMock = makeMemFs()
  fsMock.readFileSync = (p) => { paths.push(p); return stat }
  const { store: s } = makeBatchStore({ fsMock })
  assert.strictEqual(s._getTombstoneProcessStart(4321), '19', 'starttime 必须是字段区第 20 个字段')
  assert.deepStrictEqual(paths, ['/proc/4321/stat'], '必须只读 /proc/<pid>/stat 且路径逐字节精确')
})

check('_getTombstoneProcessStart: 无右括号 / 字段缺失 / 字段非十进制一律返回 null', () => {
  if (process.platform !== 'linux') return
  const fields = (last) => Array.from({ length: 19 }, (_, i) => String(i)).concat(String(last)).join(' ')
  const cases = [
    { stat: fields(777), expect: null, why: '无 ")" 时不得把整串当字段区解析出数字' },
    { stat: '1 (x) ' + fields('abc'), expect: null, why: '第 20 字段非十进制应返回 null' },
    { stat: '1 (x) S 1 2 3', expect: null, why: '字段不足应返回 null' },
    { stat: ') ' + fields(555), expect: '555', why: '右括号落在第 0 列时后续字段仍应解析' }
  ]
  for (const c of cases) {
    const fsMock = makeMemFs()
    fsMock.readFileSync = () => c.stat
    const { store: s } = makeBatchStore({ fsMock })
    assert.strictEqual(s._getTombstoneProcessStart(1), c.expect, `${c.why}（stat=${JSON.stringify(c.stat)}）`)
  }
})

check('_acquireTombstoneCleanupGuard: 无竞争时以 wx 创建哨兵并返回 token', () => {
  const guardPath = path.join(CACHE_DIR, '.seen.cleanup.lock')
  const fsMock = makeMemFs()
  const { store: s } = makeBatchStore({ fsMock })
  const token = s._acquireTombstoneCleanupGuard(CACHE_DIR)
  assert.strictEqual(typeof token, 'string', '成功创建哨兵时必须返回字符串 token')
  assert.ok(token.length > 0)
  assert.strictEqual(fsMock.files.get(guardPath), token, '哨兵内容必须是本进程 token')
  assert.strictEqual(fsMock.ops.rename.length, 0, '无 EEXIST 时不得进入认领路径')
})

check('_acquireTombstoneCleanupGuard: 持有者已退出的陈旧哨兵必须被原子认领重建', () => {
  const guardPath = path.join(CACHE_DIR, '.seen.cleanup.lock')
  const fsMock = makeMemFs({ [guardPath]: '999999999:0:dead-owner' })
  const { store: s } = makeBatchStore({ fsMock })
  const token = s._acquireTombstoneCleanupGuard(CACHE_DIR)
  assert.strictEqual(typeof token, 'string', '陈旧哨兵可认领时必须返回新 token')
  assert.strictEqual(fsMock.files.get(guardPath), token, '认领后哨兵内容必须换成新 token')
  assert.ok([...fsMock.files.keys()].every(k => !k.endsWith('.reclaim')), '认领中间态不得残留')
})

check('_acquireTombstoneCleanupGuard: 非 EEXIST 的创建失败必须原样上报（不得误当他人持锁去认领）', () => {
  const guardPath = path.join(CACHE_DIR, '.seen.cleanup.lock')
  const fsMock = makeMemFs({ [guardPath]: '999999999:0:dead-owner' })
  fsMock.writeFileSync = () => { const e = new Error('EACCES: read-only fs'); e.code = 'EACCES'; throw e }
  const { store: s } = makeBatchStore({ fsMock })
  const warns = captureConsole('warn', () => {
    const token = s._acquireTombstoneCleanupGuard(CACHE_DIR)
    assert.strictEqual(token, null, '非 EEXIST 创建失败必须返回 null')
  })
  assert.strictEqual(fsMock.ops.rename.length, 0, '非 EEXIST 错误时不得进入认领路径（renameSync 不得被调用）')
  assert.strictEqual(warns.filter(w => w.includes(guardPath)).length, 1, `创建失败必须输出一条指向该哨兵路径的告警：${JSON.stringify(warns)}`)
})

check('_acquireTombstoneCleanupGuard: 认领期间出现的新哨兵不得被覆盖（wx 原子语义）', () => {
  const guardPath = path.join(CACHE_DIR, '.seen.cleanup.lock')
  const fsMock = makeMemFs({ [guardPath]: '999999999:0:dead-owner' })
  fsMock.hooks.afterRename = () => { fsMock.files.set(guardPath, '777777777:0:competitor') }
  const { store: s } = makeBatchStore({ fsMock })
  const token = s._acquireTombstoneCleanupGuard(CACHE_DIR)
  assert.strictEqual(token, null, '认领窗口内竞争者新建哨兵时必须放弃本次认领')
  assert.strictEqual(fsMock.files.get(guardPath), '777777777:0:competitor', '不得覆盖竞争者刚创建的哨兵')
})

check('_isTombstoneLockOwner: 只有长度与内容都相同的字符串 token 才算持有者', () => {
  const lockPath = '/mem/seen.lock'
  let calls = 0
  const fsMock = makeMemFs()
  const { store: s } = makeBatchStore({
    fsMock,
    crypto: { randomUUID: () => 'uuid', timingSafeEqual: (a, b) => { calls++; return REAL_CRYPTO.timingSafeEqual(a, b) } }
  })
  fsMock.files.set(lockPath, 'abc')
  assert.strictEqual(s._isTombstoneLockOwner(lockPath, 'abc'), true)
  assert.strictEqual(calls, 1, '等长内容相同的 token 必须走定长比较')
  assert.strictEqual(s._isTombstoneLockOwner(lockPath, 'abd'), false, '等长不同内容必须判非持有者')
  calls = 0
  assert.strictEqual(s._isTombstoneLockOwner(lockPath, 'abcd'), false, '长度不同必须直接判否')
  assert.strictEqual(calls, 0, '长度不同时不得进入定长比较（Node 实现会抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH）')
  fsMock.files.set(lockPath, Buffer.from('abc'))
  assert.strictEqual(s._isTombstoneLockOwner(lockPath, 'abc'), false, '读盘结果非字符串必须判非持有者')
  fsMock.files.set(lockPath, 'abc')
  assert.strictEqual(s._isTombstoneLockOwner(lockPath, Buffer.from('abc')), false, 'token 非字符串必须判非持有者')
  // 空 token 分支不可达（生产 _newTombstoneLockToken 恒返回非空 token），不再断言空串同长同内容。
})

// ===== getFilePath：入参 → 产物 参数表（C5-046：四波重复覆盖收拢为单表）=====
// 背景：同一函数曾被四个波次逐条重复覆盖（首版 14 个 check / 持久化契约 4 个 / PlanP 4 个 / MS-05 1 个），
// 同一入参的同一期望最多出现三份（'../../etc/passwd'、''/'undefined'/'null' 等回退名、200 字节截断各 2~3 份）。
// 现收拢为「一行 = 一种独有入参维度 × 期望产物」，由 runGfCases 统一执行；MS-05（超长**扩展名**分支）留在
// 原处独立成 check——它测的是「扩展名本身超预算 ⇒ 放弃扩展名保摘要」这条不同分支，与通用截断表不重叠。
// 期望口径：产物 = 缓存目录 + 消毒后的 basename，故每行都断言「逐字 basename」与「整串以该 basename 结尾」；
// 后者即路径安全不变量（任何 ../ 或绝对路径都逃不出缓存目录），比首版只查 endsWith('/passwd') 更严。
const GF_ILLEGAL = /[\\/:*?"<>|]/
const GF_CTRL = /[\u0000-\u001F]/
const GF_LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
const GF_LONE_LOW = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/
// 'stub' = 固定 anonKey 桩（store：长名摘要恒为 anon305，用于钉住持久化格式字面量）；
// 'real' = 真实 anonKey（longNameStore：摘要的单射性只能用真摘要验证，桩会让「不同长名不同路径」变恒真）。
const GF_STORES = { stub: store, real: longNameStore }
const GF_REPR = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))
// 无信息文件名（空串 / 纯点串 / 对象与布尔的 String 化产物）：一律回退 default.json。
const GF_FALLBACK_ARGS = ['', '.', '..', '[object Object]', 'undefined', 'null', 'true', 'false', undefined, null]

const GF_CASES = {
  base: [
    { name: '普通文件名', arg: 'test.json', basename: 'test.json' },
    { name: '短名不得被截断/加摘要（反向对照）', arg: 'ok.json', basename: 'ok.json' },
    { name: '正常名不得被回退掉', arg: 'normal-name.json', basename: 'normal-name.json' },
    { name: '数字入参必须 String 化', arg: 123, basename: '123' },
    { name: '相对路径穿越必须被 basename 消除', arg: '../../etc/passwd', basename: 'passwd', noDotDot: true },
    { name: '绝对路径必须只取末段', arg: '/etc/passwd', basename: 'passwd' },
    { name: '多级相对路径只取末段', arg: 'a/b', basename: 'b' }
  ],
  sanitize: [
    // Windows 保留字符 + 多段路径：POSIX 下 '\' 不是分隔符，故末段里的 '\' 也要按保留字符删除。
    { name: 'Windows 保留字符与多段路径全清', arg: 'a/b\\c:d*e?f"g<h>i|j.json', basename: 'bcdefghij.json', noIllegal: true },
    { name: '非法字符被删除（精确产物，不是只查"不含"）', arg: 'a:b*c?d"e<f>g|h.json', basename: 'abcdefgh.json', noIllegal: true },
    { name: 'NUL 被删除（原样进路径会让 fs 抛 ERR_INVALID_ARG_VALUE）', arg: 'test\u0000.json', basename: 'test.json', noCtl: true },
    { name: 'NUL 夹在名字中间同样被删除', arg: 'bad\u0000name.json', basename: 'badname.json', noCtl: true },
    { name: 'C0 控制字符同样被删除', arg: 'ctrl\u0001\u001F.json', basename: 'ctrl.json', noCtl: true }
  ],
  fallback: GF_FALLBACK_ARGS.map((arg) => ({ name: `无信息名 ${GF_REPR(arg)} 回退 default.json`, arg, basename: 'default.json' })),
  truncate: [
    // 字面量不是内部细节：缓存文件名直接来自此处，摘要口径一变，既有长 pushUrl 用户的缓存文件即被孤立
    // （判重记录丢失 → 重复推送），故与 anonKey/filterHash 的精确值同属「跨版本兼容」契约。
    // 一行同时覆盖首版的「≤200 字节」与「保留 .json 扩展名」两条弱断言（bytes=200 蕴含 ≤200）。
    { name: '超长 ASCII 名：逐字 200 字节产物（187 字节前缀 + -anon305.json）', arg: 'a'.repeat(300) + '.json', basename: 'a'.repeat(187) + '-anon305.json', bytes: 200, endsWith: '.json' },
    // 单射：仅第 200 字节之后不同的两条长名不得映射到同一缓存文件，且单射不得以突破长度上限为代价。
    { name: '真实摘要：仅第 200 字节之后不同的长名不得碰撞', store: 'real', arg: 'a'.repeat(300) + 'x.json', distinctFrom: 'a'.repeat(300) + 'y.json', maxBytes: 200 }
  ],
  multibyte: [
    { name: '多字节长名（3 字节/字）截断后仍须是合法 UTF-8', arg: '中'.repeat(80) + '.json', maxBytes: 200, utf8: true },
    { name: '代理对长名（4 字节/个）不得留孤立代理', arg: '😀'.repeat(60) + '.json', maxBytes: 200, surrogate: true },
    { name: '代理对更长名：末位不得落在半个码点上', arg: '😀'.repeat(80) + '.json', maxBytes: 200, surrogate: true }
  ],
  realDigest: [
    // 真实 anonKey 含 ':'，摘要必须只留 [0-9a-zA-Z._-]（否则又引入路径保留字符），且要用足 200 字节。
    { name: '真实 anonKey 摘要不得引入路径保留字符或空白', store: 'real', arg: 'u'.repeat(260) + 'aaaa.json', charset: /^[0-9a-zA-Z._-]+$/, bytes: 200 }
  ],
  coerce: [
    { name: '带自定义 toString 的对象必须可 String 化', arg: { toString () { return 'obj-name.json' } }, repr: "{ toString: () => 'obj-name.json' }", basename: 'obj-name.json', noThrow: true },
    // Symbol：String(Symbol) 本身不抛（会得到 'Symbol(s)'），但若被当数组/模板拼接则抛；此处只钉「不得抛」
    // 与产物可用（落在缓存目录、无保留字符），不钉具体名字——名字内容是 JS 内建 String 化的细节，不是本函数契约。
    { name: 'Symbol 必须被兜住且产物可用（不得抛）', arg: Symbol('s'), noThrow: true, noIllegal: true }
  ]
}

function runGfCases (cases) {
  for (const c of cases) {
    const s = GF_STORES[c.store || 'stub']
    const label = `${c.name}｜getFilePath(${c.repr || GF_REPR(c.arg)})`
    let full
    if (c.noThrow) {
      let threw = false
      try { full = s.getFilePath(c.arg) } catch (e) { threw = true }
      assert.strictEqual(threw, false, `${label}：String 化失败必须被兜住（不得抛）`)
    } else {
      full = s.getFilePath(c.arg)
    }
    const base = path.basename(full)
    const bytes = Buffer.byteLength(base, 'utf8')
    // ① 产物逐字（一行 = 一种入参维度；real 摘要分支不钉摘要字面量，改钉下面 ③ 的性质）
    if (c.basename !== undefined) {
      assert.strictEqual(base, c.basename, `${label}：产物必须逐字为 ${c.basename}，实际 ${base}`)
    }
    // ② 路径安全不变量：产物 = 缓存目录 + basename
    assert.ok(full.endsWith(path.sep + base), `${label}：产物必须是「缓存目录 + basename」，实际 ${full}`)
    if (c.noDotDot) assert.strictEqual(full.includes('..'), false, `${label}：产物不得含 .. 片段`)
    // ③ 按维度的附加性质
    if (c.noIllegal) assert.strictEqual(GF_ILLEGAL.test(base), false, `${label}：路径保留字符必须全部清洗`)
    if (c.noCtl) assert.strictEqual(GF_CTRL.test(base), false, `${label}：C0 控制字符必须清洗`)
    if (c.bytes !== undefined) assert.strictEqual(bytes, c.bytes, `${label}：产物必须恰好 ${c.bytes} 字节，实际 ${bytes}`)
    if (c.maxBytes !== undefined) assert.ok(bytes <= c.maxBytes, `${label}：产物不得超 ${c.maxBytes} 字节，实际 ${bytes}`)
    if (c.endsWith) assert.ok(full.endsWith(c.endsWith), `${label}：产物必须保留 ${c.endsWith} 扩展名，实际 ${base}`)
    if (c.charset) assert.ok(c.charset.test(base), `${label}：摘要产物只允许 ${c.charset}，实际 ${base}`)
    if (c.utf8) {
      assert.strictEqual(base, Buffer.from(base, 'utf8').toString('utf8'), `${label}：截断结果必须是合法 UTF-8`)
      assert.strictEqual(base.includes('\uFFFD'), false, `${label}：不得出现替换字符（切在多字节中间会留 U+FFFD）`)
    }
    if (c.surrogate) {
      assert.strictEqual(GF_LONE_HIGH.test(base), false, `${label}：不得残留孤立高位代理`)
      assert.strictEqual(GF_LONE_LOW.test(base), false, `${label}：不得残留孤立低位代理`)
    }
    if (c.distinctFrom !== undefined) {
      assert.notStrictEqual(full, s.getFilePath(c.distinctFrom), `${label}：仅第 ${c.maxBytes} 字节之后不同的长名不得碰撞（否则判重缓存互相覆盖 = 漏推/重推）`)
    }
  }
}

// 每条 check = 一族维度（表驱动执行）；失败信息里带行名与入参，定位粒度不亚于原来一条 check 一个用例。
check('getFilePath 参数表：basename 与路径安全（正常名 / 数字 / 穿越 / 绝对路径 / 多段路径）', () => runGfCases(GF_CASES.base))
check('getFilePath 参数表：非法字符与控制字符必须被删除（精确产物）', () => runGfCases(GF_CASES.sanitize))
check('getFilePath 参数表：无信息文件名一律回退 default.json', () => runGfCases(GF_CASES.fallback))
check('getFilePath 参数表：超长名截断（逐字 200 字节产物 + 真实摘要单射）', () => runGfCases(GF_CASES.truncate))
check('getFilePath 参数表：多字节与代理对截断不得切破码点', () => runGfCases(GF_CASES.multibyte))
check('getFilePath 参数表：真实 anonKey 摘要只允许安全字符', () => runGfCases(GF_CASES.realDigest))
check('getFilePath 参数表：String 化必须被兜住（toString 对象 / Symbol）', () => runGfCases(GF_CASES.coerce))

// ===== readMessages：内存命中/恢复窗口/读失败标记 =====
check('readMessages: 内存命中且磁盘存在时不得写盘，并标记已验证（后续命中不再重查磁盘）', () => {
  const name = 'rm_a.json'
  const { store: s, fs, writes, filePath } = makeBatchStore({ name })
  fs.files.set(filePath, JSON.stringify([{ id: 'a' }]))
  s._memoryCache[filePath] = [{ id: 'a' }]
  s._memoCount = 1
  assert.deepStrictEqual(s.readMessages(filePath), [{ id: 'a' }])
  assert.strictEqual(writes.length, 0, '磁盘文件存在时不得写盘')
  assert.strictEqual(s._verified.has(filePath), true, '文件已存在应固化「已验证」')
  fs.files.delete(filePath)
  assert.deepStrictEqual(s.readMessages(filePath), [{ id: 'a' }], '已验证命中应直接返回内存快照')
  assert.strictEqual(writes.length, 0, '已验证命中不得再尝试恢复写盘')
})

check('readMessages: 恢复失败必须告警、不固化已验证（保留重试窗口）', () => {
  const name = 'rm_fail.json'
  const { store: s, writes, filePath } = makeBatchStore({ name, failWrite: true })
  s._memoryCache[filePath] = [{ id: 'a' }]
  s._memoCount = 1
  const warns = captureConsole('warn', () => { s.readMessages(filePath) })
  assert.strictEqual(writes.length, 1, '磁盘缺失时必须尝试恢复写盘')
  assert.strictEqual(s._verified.has(filePath), false, '恢复失败不得固化「已验证」')
  assert.strictEqual(warns.filter(w => w.includes(filePath)).length, 1, `恢复失败必须告警且指向该缓存文件：${JSON.stringify(warns)}`)
  captureConsole('warn', () => { s.readMessages(filePath) })
  assert.strictEqual(writes.length, 2, '保留重试窗口：下一轮内存命中必须再尝试一次恢复')
})

check('readMessages: 恢复成功时不得告警且必须固化已验证', () => {
  const name = 'rm_ok.json'
  const { store: s, writes, filePath } = makeBatchStore({ name })
  s._memoryCache[filePath] = [{ id: 'a' }]
  s._memoCount = 1
  const warns = captureConsole('warn', () => { s.readMessages(filePath) })
  assert.strictEqual(writes.length, 1, '磁盘缺失时恢复写盘一次')
  assert.strictEqual(writes[0].text, JSON.stringify([{ id: 'a' }]), '恢复内容必须是内存权威快照')
  assert.strictEqual(warns.length, 0, '恢复成功不得告警')
  assert.strictEqual(s._verified.has(filePath), true)
})

check('readMessages: 内存权威命中必须清除读失败标记（否则后续写入被永久拒绝）', () => {
  const name = 'rm_clearflag.json'
  const { store: s, fs, writes, filePath } = makeBatchStore({ name })
  fs.files.set(filePath, '[]')
  s._memoryCache[filePath] = []
  s._memoCount = 1
  s._verified.add(filePath)
  s._readFailed[filePath] = true
  assert.deepStrictEqual(s.readMessages(filePath), [])
  assert.strictEqual(s._readFailed[filePath], undefined, '内存权威命中应清除读失败标记')
  assert.strictEqual(s.saveBatch([{ id: 'n1', title: 't1' }], name), true, '清除标记后写入闸门应放行')
  assert.strictEqual(cacheWrites(writes).length, 1)
})

check('readMessages 守边界: ioError 必须置读失败标记、精确诊断且拒绝覆写（绝不触发隔离）', () => {
  // 守边界（F1 的硬约束）：隔离/重建只允许在**确定性不可恢复**判据下触发；ioError 属瞬时/环境
  // 故障，必须保持既有保守口径（等磁盘恢复自动重试），否则会把「一次抖动」升级成「重建空缓存 +
  // 旧身份全部重推」。
  const name = 'rm_ioerror.json'
  const fp = cachePath(name)
  const { store: s, fs, writes, filePath } = makeBatchStore({ name, files: { [fp]: '[]' }, readStatus: (p) => (p === fp ? { status: 'ioError' } : null) })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(s._readFailed[filePath], true, 'ioError 必须置读失败标记')
  assert.ok(errs.some(e => e.includes('缓存读取失败')), `ioError 应输出该分支的诊断：${JSON.stringify(errs)}`)
  assert.strictEqual(fs.ops.rename.length, 0, 'ioError 绝不得触发隔离改名')
  assert.strictEqual(fs.ops.unlink.length, 0, 'ioError 绝不得删除任何文件')
  // 返工 R1-C：跨分支诊断互斥（重复/串味诊断必须被发现）
  for (const marker of ['缓存文件过大', '拒绝读取非普通缓存文件', '被替换', 'corrupt.']) {
    assert.ok(!errs.some(e => e.includes(marker)), `ioError 不得输出其它分支的诊断（${marker}）：${JSON.stringify(errs)}`)
  }
  captureConsole('error', () => {
    assert.strictEqual(s.saveBatch([{ id: 'x', title: 't' }], name), false, 'ioError 下 saveBatch 必须拒绝覆写')
  })
  assert.strictEqual(cacheWrites(writes).length, 0, 'ioError 下不得写缓存文件')
})

check('readMessages 守边界: tooLarge 但尾部恢复失败（二次读取仍不可读）必须回退写闸门', () => {
  // 恢复失败（尾部读不出可解析元素 / 单条即超限）时必须 fail-closed：不假装恢复成功，也不动原件。
  // 夹具故意写成**真的超限**文件：F1 返工 R1 起，隔离前会复核「此刻仍是普通文件且确实超限」，
  // 未超限的文件按瞬时替换处理而不会走到尾部恢复——本用例要覆盖的正是「仍超限但恢复失败」这条。
  const name = 'rm_toolarge.json'
  const fp = cachePath(name)
  const { store: s, fs, writes, filePath } = makeBatchStore({
    name,
    files: { [fp]: '[' + 'x'.repeat(5000) },
    constants: { MESSAGE_CACHE_MAX_BYTES: 4096 },
    readStatus: (p) => (p === fp ? { status: 'tooLarge' } : null)
  })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(s._readFailed[filePath], true, '恢复失败必须回退写闸门（fail-closed）')
  assert.ok(errs.some(e => e.includes('缓存文件过大')), `必须保留 tooLarge 诊断：${JSON.stringify(errs)}`)
  assert.ok(errs.some(e => e.includes('无法自动恢复')), `必须响亮报告恢复失败：${JSON.stringify(errs)}`)
  assert.strictEqual(fs.ops.rename.length, 0, '恢复失败不得改名隔离')
  assert.strictEqual(cacheWrites(writes).length, 0, '恢复失败不得写缓存文件')
  for (const marker of ['缓存读取失败', '拒绝读取非普通缓存文件', '被替换', 'corrupt.']) {
    assert.ok(!errs.some(e => e.includes(marker)), `超限恢复失败不得输出其它分支的诊断（${marker}）：${JSON.stringify(errs)}`)
  }
  captureConsole('error', () => {
    assert.strictEqual(s.saveBatch([{ id: 'x', title: 't' }], name), false, '恢复失败下 saveBatch 必须拒绝覆写')
  })
})

check('readMessages: 文件缺失且初始化失败必须置读失败标记（不得按空缓存放行全量重推）', () => {
  const name = 'rm_initfail.json'
  const { store: s, filePath } = makeBatchStore({ name, failInit: true })
  captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(s._readFailed[filePath], true, '缺失 + 初始化失败必须置标记')
  captureConsole('error', () => {
    assert.strictEqual(s.saveBatch([{ id: 'x', title: 't' }], name), false)
  })
})

check('readMessages: 文件缺失但初始化成功不得置读失败标记、不得输出任何错误诊断', () => {
  const name = 'rm_initok.json'
  const { store: s, writes, filePath } = makeBatchStore({ name, initNoFile: true })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(s._readFailed[filePath], undefined, '初始化成功时不得置读失败标记')
  assert.strictEqual(errs.length, 0, 'missing 是常态，不得输出诊断')
  assert.strictEqual(s.saveBatch([{ id: 'n1', title: 't1' }], name), true, '无标记时写入闸门必须放行')
  assert.strictEqual(cacheWrites(writes).length, 1)
})

check('readMessages: JSON 解析失败 → 改名隔离 + 重建空缓存 + 解除写闸门（F1：绝不删除原件）', () => {
  const name = 'rm_badjson.json'
  const fp = cachePath(name)
  const { store: s, fs, writes, filePath } = makeBatchStore({ name, files: { [fp]: '[{' } })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  // 返工 R1-C：恢复严格口径——恰好两条指向该文件的诊断（①分支诊断 ②隔离事件），
  // 既防「重复诊断」也防「串味诊断」（旧写法 some(...) 两者都发现不了）。
  const errsForFile = errs.filter(e => e.includes(filePath))
  assert.strictEqual(errsForFile.length, 2, `解析失败必须恰好两条指向该文件的诊断：${JSON.stringify(errs)}`)
  assert.ok(errsForFile.some(e => e.includes('JSON 解析失败')), `必须含解析失败诊断：${JSON.stringify(errs)}`)
  assert.ok(errsForFile.some(e => e.includes('corrupt.')), `必须含隔离事件（点名备份路径）：${JSON.stringify(errs)}`)
  for (const marker of ['缓存读取失败', '缓存文件过大', '拒绝读取非普通缓存文件', '被替换', '（非数组）']) {
    assert.ok(!errs.some(e => e.includes(marker)), `解析失败不得输出其它分支的诊断（${marker}）：${JSON.stringify(errs)}`)
  }
  const renamed = fs.ops.rename.filter(([a]) => a === filePath)
  assert.strictEqual(renamed.length, 1, `必须恰好一次改名隔离：${JSON.stringify(fs.ops.rename)}`)
  assert.ok(/^.*\.corrupt\..*\.bak$/.test(renamed[0][1]), `备份名口径必须是 <name>.corrupt.<ISO时间戳>.bak：${renamed[0][1]}`)
  assert.strictEqual(fs.files.get(renamed[0][1]), '[{', '原件必须逐字节保留在备份路径（绝不删除/清空）')
  assert.strictEqual(fs.ops.unlink.length, 0, '绝不 unlink 任何文件')
  assert.strictEqual(fs.files.get(filePath), '[]', '原路径必须重建为合法空缓存（判错方向 = 重推）')
  assert.strictEqual(s._readFailed[filePath], undefined, '隔离重建成功后必须解除写闸门')
  assert.strictEqual(writes.filter(w => w.label === '缓存重建').length, 1, '必须有一次重建写盘')
  captureConsole('error', () => {
    assert.strictEqual(s.saveBatch([{ id: 'x', title: 't' }], name), true, '解除闸门后写入必须放行')
  })
})

check('readMessages: 合法 JSON 但非数组 → 改名隔离 + 重建空缓存 + 解除写闸门（F1）', () => {
  const name = 'rm_obj.json'
  const fp = cachePath(name)
  const { store: s, fs, filePath } = makeBatchStore({ name, files: { [fp]: '{"a":1}' } })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  // 返工 R1-C：恢复严格口径（旧写法 errs.length >= 1 抓不住重复/串味诊断）
  assert.strictEqual(errs.length, 2, `非数组必须恰好两条诊断（分支 + 隔离事件）：${JSON.stringify(errs)}`)
  assert.ok(errs.some(e => e.includes('缓存格式异常（非数组）')), `必须含非数组诊断：${JSON.stringify(errs)}`)
  assert.ok(errs.some(e => e.includes('corrupt.')), `必须含隔离事件：${JSON.stringify(errs)}`)
  for (const marker of ['缓存读取失败', '缓存文件过大', '拒绝读取非普通缓存文件', '被替换', 'JSON 解析失败']) {
    assert.ok(!errs.some(e => e.includes(marker)), `非数组不得输出其它分支的诊断（${marker}）：${JSON.stringify(errs)}`)
  }
  const renamed = fs.ops.rename.filter(([a]) => a === filePath)
  assert.strictEqual(renamed.length, 1, '必须改名隔离')
  assert.strictEqual(fs.files.get(renamed[0][1]), '{"a":1}', '原件必须逐字节保留在备份路径')
  assert.strictEqual(fs.ops.unlink.length, 0, '绝不 unlink')
  assert.strictEqual(fs.files.get(filePath), '[]', '原路径必须重建为合法空缓存')
  assert.strictEqual(s._readFailed[filePath], undefined, '隔离重建成功后必须解除写闸门')
  captureConsole('error', () => {
    assert.strictEqual(s.saveBatch([{ id: 'x', title: 't' }], name), true)
  })
})

check('readMessages: 成功读取必须写入内存快照并固化已验证（后续命中不重读磁盘）', () => {
  const name = 'rm_memo.json'
  const fp = cachePath(name)
  const { store: s, fs, writes, filePath } = makeBatchStore({ name, files: { [fp]: JSON.stringify([{ id: 'a' }]) } })
  assert.deepStrictEqual(s.readMessages(filePath), [{ id: 'a' }])
  assert.strictEqual(s._verified.has(filePath), true)
  fs.files.set(filePath, JSON.stringify([{ id: 'b' }]))
  assert.deepStrictEqual(s.readMessages(filePath), [{ id: 'a' }], '内存快照为权威，不得重读磁盘')
  const before = writes.length
  fs.files.delete(filePath)
  assert.deepStrictEqual(s.readMessages(filePath), [{ id: 'a' }])
  assert.strictEqual(writes.length, before, '已验证命中不得触发恢复写盘')
})

// ===== F1（P1）：「坏/超限缓存 → 只隔离不删除 + 重建」自愈回归（真实 fs + 真实 storage）=====
// 为什么必须用真实 fs/storage：本缺陷的承重路径是 readSafeTextResult 的 {tail:true} 有界尾部读取、
// rename 隔离、writeAtomic 原子重建——mock 掉其中任何一件，「从超限文件尾部恢复完整元素」都会变成
// 测试自证（tail 语义由测试自己实现）。读端上限经 constants 注入缩到 4KiB，夹具文件因此只有
// 几 KB，但走的是与生产 64MiB 完全相同的代码路径。
const F1_DIR_NAME = `xianbaoku_cache_f1_${process.pid}`
const F1_DIR = path.join(ROOT_DIR, F1_DIR_NAME)
const F1_MAX_BYTES = 4096

function makeRealStore (opts = {}) {
  return createMessageStore({
    Config: { cache: { dir: opts.dir === undefined ? F1_DIR_NAME : opts.dir, maxSize: opts.maxSize === undefined ? 10000 : opts.maxSize } },
    Utils: createUtils({ fs: REAL_FS, safeRe: (p, f) => new RegExp(p, f) }),
    fs: REAL_FS,
    path,
    crypto: REAL_CRYPTO,
    normalize: (o) => o,
    storage: require('./xbk_storage'),
    constants: {
      DEFAULT_MAX_SIZE: 10000,
      MESSAGE_CACHE_MAX_BYTES: opts.maxBytes === undefined ? F1_MAX_BYTES : opts.maxBytes,
      TOMBSTONE_MAX_KEYS: 5000,
      TOMBSTONE_MAX_BYTES: 262144,
      TOMBSTONE_LOCK_STALE_MS: 10000
    }
  })
}

function cleanF1Dir () {
  try { REAL_FS.rmSync(F1_DIR, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
}
// 用例断言失败时最后的 cleanF1Dir() 不会执行（check 捕获异常），退场兜底再清一次，避免沙箱里逐进程累积。
process.once('exit', cleanF1Dir)

// 隔离备份名口径：<name>.corrupt.<ISO时间戳>.bak（见 xbk_message_store._corruptBackupPath）
function corruptBackups (base) {
  try {
    return REAL_FS.readdirSync(F1_DIR).filter(n => n.startsWith(base + '.corrupt.') && n.endsWith('.bak'))
  } catch (e) { return [] }
}

check('F1: tooLarge → 有界尾部恢复重建最新 N 条，原件改名隔离（绝不删除）且写闸门解除', () => {
  cleanF1Dir()
  const store = makeRealStore()
  const name = 'f1_toolarge.json'
  const fp = store.getFilePath(name)
  const all = []
  for (let i = 0; i < 40; i++) all.push({ id: `m${i}`, title: `线报${i}`, body: 'x'.repeat(160) })
  const original = JSON.stringify(all)
  assert.ok(Buffer.byteLength(original, 'utf8') > F1_MAX_BYTES, '夹具必须真的超过读端上限')
  REAL_FS.mkdirSync(F1_DIR, { recursive: true })
  REAL_FS.writeFileSync(fp, original)
  let recovered
  const errs = captureConsole('error', () => { recovered = store.readMessages(fp) })
  assert.ok(recovered.length > 0 && recovered.length < all.length,
    `尾部恢复应恢复「部分最新」元素（0 < n < ${all.length}），实得 ${recovered.length}`)
  const expectedIds = all.map(m => m.id).slice(-recovered.length)
  assert.deepStrictEqual(recovered.map(m => m.id), expectedIds, '恢复集必须是原数组的连续后缀（最新 N 条，保序）')
  assert.strictEqual(recovered[recovered.length - 1].id, `m${all.length - 1}`, '恢复集必须含最新一条')
  assert.strictEqual(recovered[0].body, 'x'.repeat(160), '恢复元素必须完整（尾部字段也在）')
  // 只隔离不删除：原件逐字节保留在 .bak（前端未读到的旧数据也不丢）
  const baks = corruptBackups(name)
  assert.strictEqual(baks.length, 1, `原件必须被改名隔离且只生成一份备份：${JSON.stringify(REAL_FS.readdirSync(F1_DIR))}`)
  assert.strictEqual(REAL_FS.readFileSync(path.join(F1_DIR, baks[0]), 'utf8'), original,
    '备份必须是原件的逐字节副本（绝不删除/截断）')
  assert.ok(errs.some(e => e.includes('corrupt.') && e.includes(fp)),
    `隔离事件必须响亮（console.error 点名备份路径）：${JSON.stringify(errs)}`)
  // 重建后的原路径必须是合法可读缓存，且写闸门解除（F1 的「永久零推送」消失）
  assert.deepStrictEqual(JSON.parse(REAL_FS.readFileSync(fp, 'utf8')).map(m => m.id), expectedIds)
  assert.strictEqual(store._readFailed[fp], undefined, '隔离重建成功后必须解除写闸门')
  assert.strictEqual(store.saveBatch([{ id: 'f1-new', title: '新条目' }], name), true,
    '恢复后本轮的写入必须放行（否则仍是永久零推送）')
  assert.ok(JSON.parse(REAL_FS.readFileSync(fp, 'utf8')).some(m => m.id === 'f1-new'), '恢复后新条目须真正落盘')
  cleanF1Dir()
})

const F1_ISOLATION_CASES = [
  { label: 'JSON 解析失败', slug: 'parse', raw: '[{ 坏 JSON', isDir: false },
  { label: '合法 JSON 但非数组', slug: 'obj', raw: '{"a":1}', isDir: false },
  { label: '非普通文件（目录占位）', slug: 'dir', raw: null, isDir: true }
]

for (const c of F1_ISOLATION_CASES) {
  check(`F1: ${c.label} → 重命名隔离 + 重建空缓存 + 写闸门解除（原件保留）`, () => {
    cleanF1Dir()
    const store = makeRealStore()
    const name = `f1_iso_${c.slug}.json`
    const fp = store.getFilePath(name)
    REAL_FS.mkdirSync(F1_DIR, { recursive: true })
    if (c.isDir) REAL_FS.mkdirSync(fp)
    else REAL_FS.writeFileSync(fp, c.raw)
    let msgs
    const errs = captureConsole('error', () => { msgs = store.readMessages(fp) })
    assert.deepStrictEqual(msgs, [], '隔离重建后本轮按空缓存处理（判错方向 = 重推而非永久零推送）')
    const baks = corruptBackups(name)
    assert.strictEqual(baks.length, 1, `原件必须被改名隔离：${JSON.stringify(REAL_FS.readdirSync(F1_DIR))}`)
    const bakPath = path.join(F1_DIR, baks[0])
    assert.strictEqual(REAL_FS.lstatSync(bakPath).isDirectory(), c.isDir,
      '备份必须保留原件类型（目录仍是目录，绝不删除其内容）')
    if (!c.isDir) assert.strictEqual(REAL_FS.readFileSync(bakPath, 'utf8'), c.raw, '备份必须是原件逐字节副本')
    assert.ok(errs.some(e => e.includes('corrupt.')), `隔离事件必须响亮：${JSON.stringify(errs)}`)
    // 返工 R1-C：恰好两条（分支诊断 + 隔离事件），且绝不串到其它分支/瞬时替换的诊断上
    assert.strictEqual(errs.length, 2, `隔离路径必须恰好两条诊断：${JSON.stringify(errs)}`)
    for (const marker of ['缓存读取失败', '缓存文件过大', '被替换']) {
      assert.ok(!errs.some(e => e.includes(marker)), `不得输出其它分支的诊断（${marker}）：${JSON.stringify(errs)}`)
    }
    assert.strictEqual(store._readFailed[fp], undefined, '隔离重建成功后必须解除写闸门')
    assert.strictEqual(REAL_FS.readFileSync(fp, 'utf8'), '[]', '原路径必须重建为合法的空缓存')
    assert.strictEqual(store.saveBatch([{ id: 'iso-new', title: 't' }], name), true, '隔离后本轮必须恢复写入')
    assert.ok(JSON.parse(REAL_FS.readFileSync(fp, 'utf8')).some(m => m.id === 'iso-new'))
    cleanF1Dir()
  })
}

check('F1 边界: ioError（超长路径 ENAMETOOLONG）不得触发隔离，保持写闸门且不动文件系统', () => {
  cleanF1Dir()
  const store = makeRealStore()
  REAL_FS.mkdirSync(F1_DIR, { recursive: true })
  const tooLong = path.join(F1_DIR, 'x'.repeat(300) + '.json')
  let msgs
  const errs = captureConsole('error', () => { msgs = store.readMessages(tooLong) })
  assert.deepStrictEqual(msgs, [])
  assert.strictEqual(store._readFailed[tooLong], true, 'ioError 必须保持既有保守口径（瞬时故障等磁盘恢复）')
  assert.strictEqual(REAL_FS.readdirSync(F1_DIR).filter(n => n.includes('.corrupt.')).length, 0,
    'ioError 绝不得触发隔离（守边界：不动 _readFailed 的其它来源）')
  assert.ok(errs.some(e => e.includes('缓存读取失败')), `ioError 分支仍须有诊断：${JSON.stringify(errs)}`)
  cleanF1Dir()
})

check('F1 边界: 隔离改名失败必须 fail-closed（保持闸门、原件不动、不写盘）', () => {
  const name = 'f1_renamefail.json'
  const fp = cachePath(name)
  const { store: s, fs: fsMock, writes, filePath } = makeBatchStore({ name, files: { [fp]: '[{ 坏 JSON' } })
  // 让「改名隔离」失败，并把 mock 的文件状态回滚到改名之前（真实 rename 的原子性）
  fsMock.hooks.afterRename = (a, b) => {
    fsMock.files.set(a, fsMock.files.get(b))
    fsMock.files.delete(b)
    const e = new Error('EPERM: rename'); e.code = 'EPERM'; throw e
  }
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(s._readFailed[filePath], true, '隔离失败必须保持写闸门（fail-closed）')
  assert.strictEqual(fsMock.files.get(filePath), '[{ 坏 JSON', '隔离失败不得改动/丢失原件')
  assert.strictEqual(cacheWrites(writes).length, 0, '隔离失败不得写缓存文件')
  assert.ok(errs.some(e => e.includes('隔离')), `隔离失败必须响亮：${JSON.stringify(errs)}`)
  captureConsole('error', () => { assert.strictEqual(s.saveBatch([{ id: 'x', title: 't' }], name), false) })
})

check('F1: 恢复集超过 maxSize → 丢最旧的并落墓碑（防重放），恢复集本身可读写', () => {
  cleanF1Dir()
  const store = makeRealStore({ maxSize: 3, maxBytes: 1024 })
  const name = 'f1_budget.json'
  const fp = store.getFilePath(name)
  const all = []
  for (let i = 0; i < 40; i++) all.push({ id: `b${i}`, title: `t${i}` })
  const original = JSON.stringify(all)
  assert.ok(Buffer.byteLength(original, 'utf8') > 1024, '夹具必须超过读端上限')
  REAL_FS.mkdirSync(F1_DIR, { recursive: true })
  REAL_FS.writeFileSync(fp, original)
  let recovered
  captureConsole('error', () => { recovered = store.readMessages(fp) })
  assert.strictEqual(recovered.length, 3, `恢复集必须按 maxSize 裁剪（实得 ${recovered.length} 条）`)
  assert.deepStrictEqual(recovered.map(m => m.id), ['b37', 'b38', 'b39'], '必须保留最新的 maxSize 条（保序）')
  assert.deepStrictEqual(JSON.parse(REAL_FS.readFileSync(fp, 'utf8')).map(m => m.id), ['b37', 'b38', 'b39'])
  // 「无法归入重建集的旧身份」必须走 _tombstoneDropped（防上游重放重复推送）
  const ts = store._tombstones.get(fp)
  assert.ok(ts, '墓碑必须已加载')
  assert.ok(ts.id.size > 0, '无法归入重建集的旧身份必须落墓碑')
  assert.ok(REAL_FS.existsSync(fp + '.seen.json'), '墓碑必须落盘')
  assert.strictEqual(store._readFailed[fp], undefined, '恢复成功后必须解除写闸门')
  cleanF1Dir()
})

// ===== F1 返工 R1：触发面复核（并发原子替换 ⇒ 瞬时读失败，绝不允许变成隔离/清零）=====
check('F1 返工A: 读窗口内被并发原子替换的有效缓存绝不得被隔离（零 .bak、在线内容不变、闸门保持）', () => {
  // 对抗性证伪 R1-A 的最小复现（移植自 .local/f1-verify/probe2.js）：在第二次 open（读后复检）之前，
  // 用「写 tmp + rename」原子替换缓存——这正是另一进程（cron 重叠 / 常驻 loop + cron）刚写入**有效**
  // 缓存的形态。修复前（把 unsafe 一律当确定性判据）会把这份有效新缓存搬进 .bak 并把在线路径置 []；
  // 正确行为是把它当作**瞬时**读失败：保持写闸门、返回 []、绝不 rename、绝不建 .bak。
  cleanF1Dir()
  const store = makeRealStore()
  const name = 'f1_toctou.json'
  const fp = store.getFilePath(name)
  REAL_FS.mkdirSync(F1_DIR, { recursive: true })
  const oldRaw = JSON.stringify([{ id: 'old-1', title: 'old' }])
  const newRaw = JSON.stringify([{ id: 'writer-A', title: 'A' }, { id: 'writer-B', title: 'B' }])
  REAL_FS.writeFileSync(fp, oldRaw)
  const origOpen = REAL_FS.openSync
  let opens = 0
  REAL_FS.openSync = function (p) {
    if (String(p) === fp) {
      opens += 1
      if (opens === 2) { // 第二次 open = readSafeTextResult 的读后复检
        const t = path.join(F1_DIR, 'writer-other.tmp')
        REAL_FS.writeFileSync(t, newRaw) // 另一进程的原子提交：写 tmp + rename（inode 变更）
        REAL_FS.renameSync(t, fp)
      }
    }
    return origOpen.apply(REAL_FS, arguments)
  }
  let msgs
  let errs
  try {
    errs = captureConsole('error', () => { msgs = store.readMessages(fp) })
  } finally { REAL_FS.openSync = origOpen }
  assert.strictEqual(opens, 2, '夹具必须真的触发了读后复检那一次 open')
  assert.deepStrictEqual(msgs, [], '瞬时替换只降级为空读，不得从被替换的文件里恢复内容')
  assert.deepStrictEqual(corruptBackups(name), [], '瞬时替换绝不得生成任何 .bak（这是本用例的核心）')
  assert.strictEqual(REAL_FS.readFileSync(fp, 'utf8'), newRaw,
    '另一进程刚写入的有效缓存必须原样保留（不得被搬走、不得被置 []）')
  assert.strictEqual(store._readFailed[fp], true, '瞬时读失败必须保持写闸门（fail-closed）')
  assert.ok(errs.some(e => e.includes('被替换')), `诊断必须说明「读取期间被替换」：${JSON.stringify(errs)}`)
  assert.ok(!errs.some(e => e.includes('拒绝读取非普通缓存文件')),
    `瞬时替换绝不得被错标成「非普通缓存文件」：${JSON.stringify(errs)}`)
  assert.ok(!errs.some(e => e.includes('corrupt.')), `不得输出隔离事件：${JSON.stringify(errs)}`)
  // 瞬态消失后（同一进程内再次读取）必须正常读回另一进程写入的有效缓存并解除闸门
  // ——这是「瞬时 vs 确定性」的分水岭：瞬时条件消失即自愈，不需要人工干预。
  let again
  captureConsole('error', () => { again = store.readMessages(fp) })
  assert.deepStrictEqual(again.map(m => m.id), ['writer-A', 'writer-B'], '瞬时条件消失后必须读回有效缓存')
  assert.strictEqual(store._readFailed[fp], undefined, '成功读回后闸门自动解除')
  cleanF1Dir()
})

check('F1 返工A-守卫: unsafe 但此刻已是普通文件（复核发现被替换）绝不得隔离', () => {
  // 第二道防线：即便存储层报了确定性的 unsafe，「隔离前复核 lstatSync(...).isFile() === false」也必须
  // 拦住「读时非普通文件、真正 rename 前已被换成普通文件」的竞态（否则仍会搬走有效缓存）。
  const name = 'rm_unsafe_swapped.json'
  const fp = cachePath(name)
  const raw = JSON.stringify([{ id: 'valid-after-swap', title: 'A' }])
  const { store: s, fs, writes, filePath } = makeBatchStore({
    name, files: { [fp]: raw }, readStatus: (p) => (p === fp ? { status: 'unsafe' } : null)
  })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(fs.ops.rename.length, 0, '此刻是普通文件 ⇒ 绝不得 rename 隔离（否则搬走有效缓存）')
  assert.strictEqual(fs.files.get(filePath), raw, '磁盘内容必须原样保留')
  assert.strictEqual(s._readFailed[filePath], true, '按瞬时读失败处理：保持写闸门')
  assert.strictEqual(writes.filter(w => w.label === '缓存重建').length, 0, '不得重建写盘')
  assert.ok(errs.some(e => e.includes('拒绝读取非普通缓存文件')), `unsafe 分支仍须有诊断：${JSON.stringify(errs)}`)
})

check('F1 返工A-守卫2: 解析失败后复检发现已被写回有效缓存 ⇒ 不得隔离（不搬走有效缓存）', () => {
  // 第三道防线：解析失败/非数组这两条「内容不可用」判据，在真正 rename 前必须重读复核——
  // 若此刻内容已是合法数组（另一进程读窗口内写回有效缓存），前提不成立 ⇒ 按瞬时读失败处理。
  const name = 'rm_parse_swapped.json'
  const fp = cachePath(name)
  const goodRaw = JSON.stringify([{ id: 'other-writer', title: 'W' }])
  let reads = 0
  const { store: s, fs, writes, filePath } = makeBatchStore({
    name,
    files: { [fp]: '[{' },
    readStatus: (p, mockFs) => {
      if (p !== fp) return null
      reads += 1
      if (reads === 2) {
        mockFs.files.set(fp, goodRaw) // 模拟另一进程在读窗口内原子写回有效缓存
        // 复检这一次直接读到刚写回的有效缓存：与下方 mock 兜底同值（语义等价），
        // 同时让本 hook 有两个取值（避免 SonarCloud S3516「总是返回同一个值」）。
        return { status: 'ok', text: goodRaw }
      }
      return null
    }
  })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(reads, 2, '夹具必须真的触发了一次复检重读')
  assert.strictEqual(fs.ops.rename.length, 0, '复检发现内容已有效 ⇒ 绝不得 rename 隔离')
  assert.strictEqual(fs.files.get(filePath), goodRaw, '对方写回的有效缓存必须原样保留（绝不得被置 []）')
  assert.strictEqual(s._readFailed[filePath], true, '按瞬时读失败处理：保持写闸门')
  assert.strictEqual(writes.filter(w => w.label === '缓存重建').length, 0, '不得重建写盘')
  assert.ok(errs.some(e => e.includes('已被替换')), `必须响亮说明复核结论：${JSON.stringify(errs)}`)
  assert.ok(!errs.some(e => e.includes('corrupt.')), `不得输出隔离事件：${JSON.stringify(errs)}`)
  // 条件消失即自愈（与其它瞬时判据同口径）
  let again
  captureConsole('error', () => { again = s.readMessages(filePath) })
  assert.deepStrictEqual(again.map(m => m.id), ['other-writer'], '复检后再次读取必须读回有效缓存')
  assert.strictEqual(s._readFailed[filePath], undefined, '成功读回后闸门自动解除')
})

check('F1 返工A4: tooLarge 但文件此刻已不再超限（读窗口内被替换/截断）绝不得隔离', () => {
  // tooLarge 的分支同理：读端按打开瞬间 fstat 的大小判定，与真正 rename 之间有窗口；
  // 复核「此刻仍是普通文件且确实超限」不成立时按瞬时读失败处理（不隔离、不建 .bak）。
  const name = 'rm_toolarge_swapped.json'
  const fp = cachePath(name)
  const raw = JSON.stringify([{ id: 'small-after-swap', title: 'A' }])
  // 只把**首次整读**打成 tooLarge（模拟「打开时文件确实超限」），尾部读取走真实语义——
  // 此刻文件已被并发替换成一份**小的有效缓存**，于是它会读成功，旧代码据此就把这份有效缓存隔离了。
  let whole = 0
  const { store: s, fs, writes, filePath } = makeBatchStore({
    name,
    files: { [fp]: raw },
    constants: { MESSAGE_CACHE_MAX_BYTES: 4096 },
    readStatus: (p, mockFs, options) => {
      if (p !== fp || (options && options.tail === true)) return null
      whole += 1
      return whole === 1 ? { status: 'tooLarge' } : null
    }
  })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(s.readMessages(filePath), []) })
  assert.strictEqual(fs.ops.rename.length, 0, '此刻未超限 ⇒ 绝不得 rename 隔离')
  assert.strictEqual(fs.files.get(filePath), raw, '磁盘内容必须原样保留（不得搬走这份有效小缓存）')
  assert.strictEqual(s._readFailed[filePath], true, '按瞬时读失败处理：保持写闸门')
  assert.strictEqual(writes.filter(w => w.label === '缓存重建').length, 0, '不得重建写盘')
  assert.ok(errs.some(e => e.includes('已被替换/截断')), `必须响亮说明「已被替换/截断」：${JSON.stringify(errs)}`)
  assert.ok(!errs.some(e => e.includes('corrupt.')), `不得输出隔离事件：${JSON.stringify(errs)}`)
})

// ===== F1 返工B：单条 save()（= appendMessageToFile）的读失败闸门（此前零覆盖，变异存活）=====
check('F1 返工B: 写闸门置位期间单条 save() 必须返回 false 且绝不覆写磁盘', () => {
  // 为什么必须单独立这条：save() 与 saveBatch() 各自有一份 `_readFailed` 闸门判断，删掉 save() 那份
  // 之前没有任何测试会变红（对抗性证伪 R1-B 用变异实测：删掉后全仓仍 117/117 全绿）。
  const name = 'rm_savegate.json'
  const fp = cachePath(name)
  const raw = JSON.stringify([{ id: 'keep-1', title: '存量' }])
  const { store: s, fs, writes, filePath } = makeBatchStore({
    name, files: { [fp]: raw }, readStatus: (p) => (p === fp ? { status: 'ioError' } : null)
  })
  const errs = captureConsole('error', () => {
    assert.strictEqual(s.save({ id: 'blocked-2', title: '应被拒绝' }, name), false,
      '读失败闸门置位期间单条 save 必须返回 false（删掉该闸门判断即变红）')
  })
  assert.ok(errs.some(e => e.includes('缓存读取失败，跳过写入以保护存量数据')),
    `save 的闸门必须有专门诊断：${JSON.stringify(errs)}`)
  assert.strictEqual(fs.files.get(filePath), raw, '闸门置位期间磁盘原文绝不得被覆写')
  assert.strictEqual(cacheWrites(writes).length, 0, '闸门置位期间不得写盘')
  // 反例对照（防断言恒真）：同夹具去掉读失败后，同一 save 必须放行并真正落盘
  const ok = makeBatchStore({ name, files: { [fp]: raw } })
  assert.strictEqual(ok.store.save({ id: 'ok-2', title: 't' }, name), true, '无读失败时 save 必须放行')
  assert.ok(JSON.parse(ok.fs.files.get(fp)).some(m => m.id === 'ok-2'), '放行时新条目必须真正落盘')
})

// ===== saveBatch / saveMessages：索引判重、上限裁剪、墓碑、失败回滚 =====
check('saveBatch: 非数组入参与空数组直接返回 true 且不落盘', () => {
  const name = 'sb_guard.json'
  const { store: s, writes } = makeBatchStore({ name })
  assert.strictEqual(s.saveBatch('nope', name), true)
  assert.strictEqual(s.saveBatch(null, name), true)
  assert.strictEqual(s.saveBatch([], name), true)
  assert.strictEqual(writes.length, 0, '无有效变更不得落盘（也不得初始化写盘）')
})

check('saveBatch: 同批内同 id 的第二条必须更新首条而非追加', () => {
  const name = 'sb_dup.json'
  const { store: s, writes } = makeBatchStore({ name })
  assert.strictEqual(s.saveBatch([{ id: 'x', v: 1 }, { id: 'x', v: 2 }], name), true)
  const saved = JSON.parse(cacheWrites(writes)[0].text)
  assert.strictEqual(saved.length, 1, '同 id 必须合并为一条')
  assert.strictEqual(saved[0].v, 2)
  assert.strictEqual(typeof saved[0].timestamp, 'string')
})

check('saveBatch: 新条目 id 带 url、缓存里只有纯 url 条目时必须靠 url 候选合并', () => {
  const name = 'sb_urlcand.json'
  const { store: s, writes } = makeBatchStore({ name })
  assert.strictEqual(s.saveBatch([{ url: 'https://u.example/1', v: 1 }], name), true)
  assert.strictEqual(s.saveBatch([{ id: 'x', url: 'https://u.example/1', v: 2 }], name), true)
  const saved = JSON.parse(cacheWrites(writes)[1].text)
  assert.strictEqual(saved.length, 1, '同 URL 的身份必须合并（urlOnlyMap 候选）')
  assert.strictEqual(saved[0].id, 'x')
  assert.strictEqual(saved[0].v, 2)
})

check('saveBatch: 纯 url 新条目必须匹配缓存中带 url 的 id 条目（urlMap 登记）', () => {
  const name = 'sb_urlmap.json'
  const { store: s, writes } = makeBatchStore({ name })
  assert.strictEqual(s.saveBatch([{ id: 'x', url: 'https://u.example/2', v: 1 }], name), true)
  assert.strictEqual(s.saveBatch([{ url: 'https://u.example/2', v: 2 }], name), true)
  const saved = JSON.parse(cacheWrites(writes)[1].text)
  assert.strictEqual(saved.length, 1, '同一 URL 必须合并（不得因新条目是纯 url 就重复收录）')
  assert.strictEqual(saved[0].v, 2)
})

check('saveBatch: 无 id/url 的匿名条目必须按合成键合并', () => {
  const name = 'sb_anon.json'
  const { store: s, writes } = makeBatchStore({ name })
  const msg = { title: '标题', content: '内容' }
  assert.strictEqual(s.saveBatch([msg], name), true)
  assert.strictEqual(s.saveBatch([{ ...msg, extra: 'x' }], name), true)
  const saved = JSON.parse(cacheWrites(writes)[1].text)
  assert.strictEqual(saved.length, 1, '匿名合成键相同必须合并')
  assert.strictEqual(saved[0].extra, 'x')
})

check('saveBatch: 无效条目（空对象/无身份/原始值）必须跳过', () => {
  const name = 'sb_invalid.json'
  const { store: s, writes } = makeBatchStore({ name })
  assert.strictEqual(s.saveBatch([{}, { id: 'ok', v: 1 }, null, 42], name), true)
  const saved = JSON.parse(cacheWrites(writes)[0].text)
  assert.deepStrictEqual(saved.map(m => m.id), ['ok'], '只有有效身份可落入缓存')
})

check('saveBatch: 超出 maxSize 必须裁剪最早条目并把被裁剪身份落墓碑（精确取舍）', () => {
  const name = 'sb_trim.json'
  const { store: s, writes, filePath } = makeBatchStore({ name, maxSize: 2 })
  const warns = captureConsole('warn', () => {
    assert.strictEqual(s.saveBatch([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }], name), true)
  })
  const saved = JSON.parse(cacheWrites(writes)[0].text)
  assert.deepStrictEqual(saved.map(m => m.id), ['b', 'c'], '必须只保留最新 maxSize 条')
  assert.strictEqual(warns.filter(w => w.includes('裁剪掉最早 1 条')).length, 1, `裁剪必须告警一次并含被裁剪条数：${JSON.stringify(warns)}`)
  assert.ok(!warns.some(w => w.includes('墓碑写入未获锁')), '单实例内存 fs 下墓碑锁必须拿到')
  const tomb = writes.filter(w => w.label === '墓碑')
  assert.strictEqual(tomb.length, 1, '裁剪后必须落一次墓碑')
  assert.strictEqual(tomb[0].p, filePath + '.seen.json', '墓碑路径必须是 <缓存文件>.seen.json')
  const tombData = JSON.parse(tomb[0].text)
  assert.deepStrictEqual(tombData.id, ['a'], '被裁剪身份必须进墓碑（防重放重复推送）')
})

check('saveBatch: 未超上限时不得裁剪、不得落墓碑、不得触碰墓碑锁文件', () => {
  const name = 'sb_notrim.json'
  const { store: s, fs, writes } = makeBatchStore({ name, maxSize: 2 })
  const warns = captureConsole('warn', () => {
    assert.strictEqual(s.saveBatch([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], name), true)
  })
  assert.deepStrictEqual(JSON.parse(cacheWrites(writes)[0].text).map(m => m.id), ['a', 'b'])
  assert.ok(!warns.some(w => w.includes('缓存超出上限')), `恰好等于上限不得裁剪：${JSON.stringify(warns)}`)
  assert.strictEqual(writes.filter(w => w.label === '墓碑').length, 0, '无裁剪不得落墓碑')
  assert.strictEqual(fs.ops.write.length, 0, '无裁剪不得创建墓碑锁/清理哨兵文件')
})

check('saveMessages: 写盘失败必须回滚内存快照、返回 false 并告警指明已回滚', () => {
  const name = 'sb_fail.json'
  const { store: s, writes, filePath } = makeBatchStore({ name, failWrite: true })
  let ret
  const warns = captureConsole('warn', () => { ret = s.saveBatch([{ id: 'a', v: 1 }], name) })
  assert.strictEqual(ret, false, '落盘失败必须返回 false')
  assert.strictEqual(warns.filter(w => w.includes(filePath)).length, 1, `落盘失败必须告警且指向该缓存文件：${JSON.stringify(warns)}`)
  assert.deepStrictEqual(s._memoryCache[filePath], [], '失败路径必须把内存快照回滚到写入前状态')
  assert.strictEqual(cacheWrites(writes).length, 1)
})

check('saveBatch: 落盘成功时不得输出「已回滚」告警', () => {
  const name = 'sb_ok.json'
  const { store: s } = makeBatchStore({ name })
  const warns = captureConsole('warn', () => {
    assert.strictEqual(s.saveBatch([{ id: 'a', v: 1 }], name), true)
  })
  assert.strictEqual(warns.length, 0, `成功且未裁剪时不得输出任何告警（尤其不得误报回滚）：${JSON.stringify(warns)}`)
})

check('saveBatch: 汇总日志必须如实（纯新增不报更新，更新 1 条报 1 条）', () => {
  const name = 'sb_log.json'
  const { store: s } = makeBatchStore({ name })
  s.saveBatch([{ id: 'a', v: 1 }], name)
  const logsNew = captureConsole('log', () => {
    assert.strictEqual(s.saveBatch([{ id: 'b', v: 1 }], name), true)
  })
  assert.ok(!logsNew.some(l => l.includes('缓存批量更新')), `纯新增不得输出更新汇总：${JSON.stringify(logsNew)}`)
  const logsUpd = captureConsole('log', () => {
    assert.strictEqual(s.saveBatch([{ id: 'a', v: 2 }], name), true)
  })
  assert.ok(logsUpd.some(l => l === `缓存批量更新: ${name} 更新 1 条`), `更新汇总必须精确：${JSON.stringify(logsUpd)}`)
})

check('saveBatch: 内容完全一致时不得落盘（changedAny 短路）', () => {
  const name = 'sb_nochange.json'
  const { store: s, writes } = makeBatchStore({ name })
  s.saveBatch([{ id: 'a', v: 1 }], name)
  const before = writes.length
  assert.strictEqual(s.saveBatch([{ id: 'a', v: 1 }], name), true)
  assert.strictEqual(writes.length, before, '内容一致不得重写磁盘、不得刷新 timestamp')
})

check('saveBatch: 单条消息超过读端字节上限时必须跳过落盘、返回 false 并回滚内存', () => {
  const name = 'sb_toobig.json'
  const { store: s, writes, filePath } = makeBatchStore({ name, constants: { MESSAGE_CACHE_MAX_BYTES: 40 } })
  const warns = captureConsole('warn', () => {
    assert.strictEqual(s.saveBatch([{ id: 'a', content: 'x'.repeat(200) }], name), false)
  })
  assert.strictEqual(cacheWrites(writes).length, 0, '超限时必须放弃落盘（不写超限文件）')
  assert.ok(warns.length >= 1, `超限放弃落盘必须告警（不得静默）：${JSON.stringify(warns)}`)
  assert.ok(warns.some(w => w.includes(filePath)), `告警必须指向该缓存文件：${JSON.stringify(warns)}`)
  assert.deepStrictEqual(s._memoryCache[filePath], [], '放弃落盘时必须回滚内存快照')
})

check('saveBatch: 缺少 maxSize 时必须回退 DEFAULT_MAX_SIZE（不得退化成 1 条上限）', () => {
  const name = 'sb_defmax.json'
  const { store: s, writes } = makeBatchStore({ name, noMaxSize: true })
  assert.strictEqual(s.saveBatch([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], name), true)
  const saved = JSON.parse(cacheWrites(writes)[0].text)
  assert.strictEqual(saved.length, 2, '非法/缺失 maxSize 必须回退 DEFAULT_MAX_SIZE')
})

// ===== _trimCacheByBytes：字节裁剪的精确取舍 =====
check('_trimCacheByBytes: 二分裁剪必须保留「最大可行」后缀（精确文本 + droppedOut + 告警）', () => {
  const toSave = []
  for (let i = 0; i < 10; i++) toSave.push({ id: 'm' + i, content: 'x'.repeat(i) })
  const expected = JSON.stringify(toSave.slice(-4))
  const maxBytes = Buffer.byteLength(expected, 'utf8')
  const dropped = []
  const warns = captureConsole('warn', () => {
    assert.strictEqual(store._trimCacheByBytes(JSON.stringify(toSave), toSave, 'probe.json', maxBytes, dropped), expected, '必须保留最大可行的后缀')
  })
  assert.strictEqual(dropped.length, 6, '被丢弃的 6 条必须上报 droppedOut')
  assert.strictEqual(dropped[0].id, 'm0')
  assert.strictEqual(warns.filter(w => w.includes('裁剪掉最早 6 条')).length, 1, `字节裁剪必须告警一次并含被裁剪条数：${JSON.stringify(warns)}`)
  const four = []
  for (let i = 6; i < 10; i++) four.push({ id: 'm' + i, content: 'x'.repeat(i) })
  const exact = JSON.stringify(four)
  const warns2 = captureConsole('warn', () => {
    assert.strictEqual(store._trimCacheByBytes(exact, four, 'p.json', Buffer.byteLength(exact, 'utf8')), exact)
  })
  assert.strictEqual(warns2.length, 0, '恰好不超限不得告警')
  assert.strictEqual(four.length, 4, '恰好达标不得裁剪任何条目')
})

check('_trimCacheByBytes: 连最新单条都超限时必须返回 null（不得返回超限/空文本自锁）', () => {
  const big = [{ id: 'x', content: 'y'.repeat(500) }, { id: 'z', content: 'w'.repeat(500) }]
  const warns = captureConsole('warn', () => {
    assert.strictEqual(store._trimCacheByBytes(JSON.stringify(big), [...big], 'p.json', 50), null)
  })
  assert.strictEqual(warns.length, 1, `单条超限必须告警一次：${JSON.stringify(warns)}`)
  const warns2 = captureConsole('warn', () => {
    assert.strictEqual(store._trimCacheByBytes(JSON.stringify([big[0]]), [big[0]], 'p.json', 50), null)
  })
  assert.strictEqual(warns2.length, 1, '单条超限必须告警一次（第二条路径）')
})

check('_trimCacheByBytes: 未传 droppedOut 时不得抛错（可选参数）', () => {
  const toSave = []
  for (let i = 0; i < 6; i++) toSave.push({ id: 'm' + i, content: 'x'.repeat(i) })
  const maxBytes = Buffer.byteLength(JSON.stringify(toSave.slice(-2)), 'utf8')
  const warns = captureConsole('warn', () => {
    const text = store._trimCacheByBytes(JSON.stringify(toSave), toSave, 'p.json', maxBytes)
    assert.strictEqual(text, JSON.stringify(toSave), '裁剪结果必须是剩余条目的序列化')
  })
  assert.ok(warns.length >= 1)
})

// ===== _evictOldestKeys：guardMax 上界与轮转淘汰 =====
check('_evictOldestKeys: guardMax 必须封顶轮数（既不得越界多删，也不得提前停手）', () => {
  const maps = [new Map([['a1', 1], ['a2', 1], ['a3', 1]]), new Map([['b1', 1], ['b2', 1]]), new Map(), new Map([['d1', 1]])]
  store._evictOldestKeys(maps, 8, 1)
  assert.deepStrictEqual([maps[0].size, maps[1].size, maps[2].size, maps[3].size], [1, 0, 0, 0], 'guardMax=1 只允许两轮（含 guard=0）')
  assert.strictEqual(maps[0].has('a3'), true, '最旧的键先被淘汰')
})

check('_evictOldestKeys: count 归零后必须立即停止，空 Map 不得白耗 count', () => {
  const maps = [new Map([['a1', 1]]), new Map([['b1', 1]]), new Map([['c1', 1]]), new Map([['d1', 1]])]
  store._evictOldestKeys(maps, 1, 10)
  assert.deepStrictEqual([maps[0].size, maps[1].size, maps[2].size, maps[3].size], [0, 1, 1, 1], 'count=1 只能删一个键')
  const emptyFirst = [new Map(), new Map([['b1', 1]])]
  store._evictOldestKeys(emptyFirst, 1, 10)
  assert.strictEqual(emptyFirst[1].size, 0, '空 Map 不得消耗 count（否则真正该删的键被漏删）')
})

// ===== _evictTombstonesToSize：比例估算 + 逐键精修 =====
check('_evictTombstonesToSize: 恰好不超限时必须原样序列化且不得淘汰任何键', () => {
  const ts = emptyTombstoneMaps()
  ts.id.set('id1', true)
  ts.anon.set('anon1', true)
  const exact = JSON.stringify({ v: 1, id: ['id1'], urlOnly: [], idWithUrl: [], anon: ['anon1'] })
  const text = store._evictTombstonesToSize(ts, Buffer.byteLength(exact, 'utf8'))
  assert.strictEqual(text, exact, '恰好达标必须原样返回（含真实键，不得退化成空集合文本）')
  assert.deepStrictEqual([ts.id.size, ts.urlOnly.size, ts.idWithUrl.size, ts.anon.size], [1, 0, 0, 1])
})

check('_evictTombstonesToSize: 超限时必须淘汰到达标（推进且最旧先丢），不锁精确产物文本', () => {
  const ts = emptyTombstoneMaps()
  const groups = [[ts.id, ['i1', 'i2']], [ts.urlOnly, ['u1', 'u2']], [ts.idWithUrl, ['b1', 'b2']], [ts.anon, ['a1', 'a2']]]
  for (const [map, keys] of groups) for (const k of keys) map.set(k, true)
  const before = groups.map(([map]) => map.size)
  const text = store._evictTombstonesToSize(ts, 69)
  assert.ok(text === null || Buffer.byteLength(text, 'utf8') <= 69, '超限时必须返回达标文本（否则按契约返回 null）')
  const after = groups.map(([map]) => map.size)
  assert.ok(after.every((n, i) => n <= before[i]), '淘汰只减不增（四类键数单调不增）')
  assert.ok(after.some((n, i) => n < before[i]), '超限必须真的淘汰（推进）')
  // 最旧先丢：每类保留的必须是各自插入序的**后缀**（不得从中间或最新处删）
  for (const [map, keys] of groups) {
    const kept = [...map.keys()]
    assert.deepStrictEqual(kept, keys.slice(keys.length - kept.length), `必须保留最新后缀、丢弃最旧键：${JSON.stringify(keys)}`)
  }
})
check('_evictTombstonesToSize: 全空且预算小于空序列化长度时返回 null（不得死循环）', () => {
  assert.strictEqual(store._evictTombstonesToSize(emptyTombstoneMaps(), 10), null, '无键可淘汰且不达标 ⇒ 返回 null（调用方放弃持久化）')
})

// ===== _probeIndexMiss：未命中抽查窗 =====
check('_probeIndexMiss: 空数组与无效身份必须返回精确的 {hit:false,diverged:false}', () => {
  const empty = []
  const e0 = identityStore._storeIdentityEntry(empty)
  assert.deepStrictEqual(identityStore._probeIndexMiss(e0, empty, { id: 'x' }), { hit: false, diverged: false })
  const arr = [{ id: 'a' }]
  const e1 = identityStore._storeIdentityEntry(arr)
  arr[0] = { id: 'zzz' }
  assert.deepStrictEqual(identityStore._probeIndexMiss(e1, arr, {}), { hit: false, diverged: false }, '无效身份必须直接返回，不得被引用层报成 diverged')
})

// 契约：引用层窗宽 32、身份层窗宽 2、n<=8 整表；未命中不得每次全量复检，且必须在有界轮数内自愈。
// 用「第 k 位是否落在首轮窗内」这类**可观测行为**反推窗宽，替代对 refCursor/identityCursor 的数值锁定。
check('_probeIndexMiss: 引用层窗宽恰为 32（0-based 第 31 位在首轮窗内、第 32 位不在）', () => {
  const mk = () => { const a = []; for (let i = 0; i < 33; i++) a.push({ id: 'w' + i }); return a }
  const a1 = mk()
  const e1 = identityStore._storeIdentityEntry(a1)
  a1[31] = { id: 'w31-new' }
  assert.strictEqual(identityStore._probeIndexMiss(e1, a1, { id: 'absent' }).diverged, true, '第 31 位必须在首轮引用层窗内（窗宽 >= 32）')
  const a2 = mk()
  const e2 = identityStore._storeIdentityEntry(a2)
  a2[32] = { id: 'w32-new' }
  assert.strictEqual(identityStore._probeIndexMiss(e2, a2, { id: 'absent' }).diverged, false, '第 32 位不得落在首轮窗内（窗宽 <= 32，即不得单轮全量复检）')
  assert.strictEqual(identityStore._probeIndexMiss(e2, a2, { id: 'absent' }).diverged, true, '旋转推进一轮后必须自愈')
})
check('_probeIndexMiss: 身份层窗宽恰为 2（0-based 第 2 位的字段改写次轮即被发现）', () => {
  const arr = []
  for (let i = 0; i < 12; i++) arr.push({ id: 'c' + i })
  const entry = identityStore._storeIdentityEntry(arr)
  arr[2].id = 'c2-new' // 引用不变 ⇒ 只能由身份层发现
  assert.strictEqual(identityStore._probeIndexMiss(entry, arr, { id: 'absent' }).diverged, false, '首轮身份层窗为 [0,1] ⇒ 第 2 位不得被发现（窗宽 <= 2）')
  assert.strictEqual(identityStore._probeIndexMiss(entry, arr, { id: 'absent' }).diverged, true, '次轮窗推到 [2,3] ⇒ 必须发现（窗宽 >= 2）')
})
check('_probeIndexMiss: 身份层正命中即真且与零索引 oracle 结论一致', () => {
  const arr = []
  for (let i = 0; i < 6; i++) arr.push({ id: 'h' + i })
  const entry = identityStore._storeIdentityEntry(arr)
  let hit = false
  for (let r = 0; r < 4; r++) {
    if (identityStore._probeIndexMiss(entry, arr, { id: 'h3' }).hit) { hit = true; break }
  }
  assert.strictEqual(hit, true, '同一数组内的真实身份必须在有界轮数内被抽查窗命中（正命中通道）')
  assert.strictEqual(identityStore._indexHasIdentityDirect(arr, { id: 'h3' }), true, 'oracle 同步为真（结论一致）')
  assert.strictEqual(identityStore._indexHasIdentityDirect(arr, { id: 'h4x' }), false, 'oracle 对不存在的身份为假（对拍基线）')
})
check('_probeIndexMiss: 5000 条批量判重不得每次全量重建（自愈有界、索引版本复用）', () => {
  const arr = []
  for (let i = 0; i < 5000; i++) arr.push({ id: 'b' + i })
  const name = seedIdentityProbe(arr, 'probe_bulk_n5000.json')
  assert.strictEqual(identityStore.has({ id: 'b0' }, name), true, '命中必须为真')
  assert.strictEqual(identityStore.has({ id: 'absent-0' }, name), false, '未命中必须为假')
  const entry = identityStore._identityIndex.get(arr)
  for (let k = 0; k < 50; k++) assert.strictEqual(identityStore.has({ id: 'absent-' + k }, name), false, '连续未命中不得改变答案')
  assert.strictEqual(identityStore._identityIndex.get(arr), entry, '同一数组版本的未命中不得每次重建索引（entries 必须复用）')
})

check('_probeIndexMiss: 小数组（n<=8）必须整表抽查（首次未命中即精确）', () => {
  const arr = []
  for (let i = 0; i < 8; i++) arr.push({ id: 's' + i })
  const entry = identityStore._storeIdentityEntry(arr)
  arr[5].id = 's5-new'
  assert.deepStrictEqual(identityStore._probeIndexMiss(entry, arr, { id: 'absent' }), { hit: false, diverged: true }, 'n=8 必须整表抽查，第 5 位字段改写必须被看见')
})

// ===== C5-077：identityStore 隔离必须由「每用例新实例」保证，不能靠命名约定 + 手工回退计数 =====
// 旧实现是模块级共享实例，seedIdentityProbe 靠删 _memoryCache[fp] / _memoCount -= 1 / _verified.delete
// 手工回退；一旦新用例换了文件名或忘写清理，陈旧条目与 _memoCount 就跨用例累积（曾实锤漏推假绿）。
check('identity 隔离：每个 seed 用例拿到全新实例（_memoCount/_verified 不得跨用例累积）', () => {
  seedIdentityProbe([{ id: 'iso-1' }], 'iso_probe_1.json')
  assert.strictEqual(identityStore._memoCount, 1, `seed 之后 _memoCount 必须只反映本次 seed，实际 ${identityStore._memoCount}（模块级实例跨用例累积）`)
  seedIdentityProbe([{ id: 'iso-2' }], 'iso_probe_2.json')
  assert.strictEqual(identityStore._memoCount, 1, '再次 seed 必须仍是 1 条（不得把上一个用例的条目带过来）')
  assert.deepStrictEqual(Object.keys(identityStore._memoryCache), [identityStore.getFilePath('iso_probe_2.json')], '不得残留前一用例的缓存条目')
  assert.strictEqual(identityStore._verified.size, 1, '_verified 不得累积')
})

// ===== 补测 PlanP：_getTombstoneProcessStart（message-store 未直测的方法）=====
// 反例（改动前）：它在既有 104 项里只经高层路径间接覆盖，**/proc 解析**的精确口径从未被直接断言
// —— 本段用 createProbeStore 直接调用。（同一段里原有的 getFilePath 补测已并入参数表，见上。）
{
  const S = createProbeStore()
  // —— getFilePath：四波重复覆盖已收拢为单表（C5-046），见「===== getFilePath：入参 → 产物 参数表 =====」——
  // 原 PlanP 的 4 条 getFilePath 用例（穿越/清洗、回退 default.json、String 化不抛、200 字节截断）逐条落在
  // 该表的 base / sanitize / fallback / truncate / multibyte / coerce 六族里，入参与维度均未减少。
  // —— _getTombstoneProcessStart：/proc 解析的边界 ——
  check('PlanP _getTombstoneProcessStart: 非 Linux 返回 null、读取失败返回 null', () => {
    const orig = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      assert.strictEqual(S._getTombstoneProcessStart(1), null, '非 Linux 必须返回 null（调用方按保守口径处理）')
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      assert.strictEqual(S._getTombstoneProcessStart(999999999), null, '不存在的 PID 读 /proc 失败 ⇒ null（不得抛）')
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })
}

// --- 已导出的身份索引探测窗常量（此前无任何守护断言）---
// 这两个常量直接控制 _evictTombstonesToSize/身份索引自检的探测窗口宽度：
// 被调大 → 大列表下身份层探测按位置重算 getMessageIdentity（~µs/位置）退化为 O(n) 热路径；
// 被调小 → 引用层/身份层探测窗覆盖不足，自检可能漏检原位替换。锁死当前契约值。
check('IDENTITY_INDEX_REF_PROBE_WINDOW: 契约值锁定 32（引用层宽窗，纯指针比较）', () => {
  assert.strictEqual(IDENTITY_INDEX_REF_PROBE_WINDOW, 32, '引用层宽窗被改动：确认性能/正确性权衡后再改此断言')
})
check('IDENTITY_INDEX_IDENTITY_PROBE_WINDOW: 契约值锁定 2（身份层窄窗，每位置重算 ~µs）', () => {
  assert.strictEqual(IDENTITY_INDEX_IDENTITY_PROBE_WINDOW, 2, '身份层窄窗被改动：该值直接决定 O(窗宽) 重算成本')
  assert.ok(IDENTITY_INDEX_IDENTITY_PROBE_WINDOW < IDENTITY_INDEX_REF_PROBE_WINDOW, '身份层窄窗必须严格小于引用层宽窗（窄窗逐位置重算、成本更高）')
})

// --- _releaseTombstoneLock（此前零覆盖）---
// 语义：锁内容仍是自己写入的 token（等长且 timingSafeEqual 相同）才 unlink；ENOENT 静默；
// 其余读盘错误同样忽略（锁清理非关键，不得抛出影响主流程）。
check('_releaseTombstoneLock: 自己的 token 才删锁、他人 token 不删、ENOENT 与读盘错误均静默', () => {
  const lockPath = '/mem/seen.release.lock'
  const fsMock = makeMemFs()
  let readShouldThrow = null
  fsMock.readFileSync = (p) => {
    if (readShouldThrow) throw readShouldThrow
    if (!fsMock.files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e }
    return fsMock.files.get(p)
  }
  const { store: s } = makeBatchStore({ fsMock })
  // 自己的 token → 删除
  fsMock.files.set(lockPath, 'tok-1')
  s._releaseTombstoneLock(lockPath, 'tok-1')
  assert.strictEqual(fsMock.files.has(lockPath), false, '持有者释放必须删除锁文件')
  assert.strictEqual(fsMock.ops.unlink.filter(p => p === lockPath).length, 1, '应恰好调用一次 unlinkSync')
  // 他人 token → 不删（锁仍归原持有者，不得误清竞争者的锁）
  fsMock.files.set(lockPath, 'other-holder')
  s._releaseTombstoneLock(lockPath, 'tok-1')
  assert.strictEqual(fsMock.files.get(lockPath), 'other-holder', 'token 不匹配不得删除他人锁')
  assert.strictEqual(fsMock.ops.unlink.filter(p => p === lockPath).length, 1, 'token 不匹配时不得新增 unlink 调用')
  // ENOENT → 静默（锁已被对方清理是正常竞态）
  fsMock.files.delete(lockPath)
  let threw = false
  try { s._releaseTombstoneLock(lockPath, 'tok-1') } catch (e) { threw = true }
  assert.strictEqual(threw, false, '锁已不存在必须静默返回')
  // 其余读盘错误（如 EACCES）→ 同样静默，不得抛出阻塞主流程
  readShouldThrow = Object.assign(new Error('EACCES: ' + lockPath), { code: 'EACCES' })
  threw = false
  try { s._releaseTombstoneLock(lockPath, 'tok-1') } catch (e) { threw = true }
  assert.strictEqual(threw, false, '非 ENOENT 读盘错误也必须静默（锁清理非关键路径）')
})

// ===== G11-MS：缓存自愈/墓碑锁/路径截断的未达分支（c8 实测 L271-272/330/348/354/382/463/470/636-639/753-774/791）=====
// 判重缓存是本仓最高风险区：这些分支的共同语义是「恢复不了就 fail-closed 保持写闸门，
// 绝不当着未读到的存量把磁盘覆写成空缓存」。它们一旦写坏（例如隔离名生成失败时改走「直接覆写」），
// 现有关于「成功恢复」的用例照样绿，而线上表现为整轮零推送或存量丢失。故逐条钉失败出口。
check('MS-01 init: 目录创建失败必须抛出原始异常并打印路径；getter 二次求值也失败时用占位符诊断', () => {
  const dir = path.join(FAKE_ROOT, 'xianbaoku_cache')
  const outsidePath = path.resolve(FAKE_ROOT, '..', 'outside-root')
  // ① 常规形态：getter 正常、mkdir 抛错 ⇒ 诊断带真实路径 + 原异常照常抛出
  const fs1 = {
    existsSync: () => false,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p,
    mkdirSync: () => { throw Object.assign(new Error('EACCES: cannot create cache dir'), { code: 'EACCES' }) }
  }
  const s1 = storeWithFs(fs1)
  let thrown1 = null
  const errs1 = captureConsole('error', () => { try { s1.init() } catch (e) { thrown1 = e } })
  assert.ok(thrown1, '目录创建失败必须抛给调用方（v3.245 起不得吞错）')
  assert.strictEqual(thrown1.message, 'EACCES: cannot create cache dir', '抛出的必须是原始异常')
  assert.ok(errs1.some(l => l.startsWith(`缓存目录创建失败: ${dir}`)), `诊断必须带目录路径：${JSON.stringify(errs1)}`)
  // ② catch 内二次求值 getter 也炸（校验间目录被换成指向根外的符号链接）
  // ⇒ 诊断必须用占位符、不得崩在 getter 上，且原异常仍必须抛出（旧写法会让 getter 异常顶替原始异常）
  let firstEval = true
  const fs2 = {
    existsSync: () => false,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => { if (firstEval) { firstEval = false; return p } return outsidePath },
    mkdirSync: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
  }
  const s2 = storeWithFs(fs2)
  let thrown2 = null
  const errs2 = captureConsole('error', () => { try { s2.init() } catch (e) { thrown2 = e } })
  assert.ok(thrown2, '二次求值失败也不得吞掉原始异常')
  assert.strictEqual(thrown2.message, 'ENOSPC: no space left on device',
    `抛出的必须仍是 mkdir 的原始异常（不能被 getter 的「所有候选目录不可用」顶替，实际 ${thrown2.message}）`)
  assert.ok(errs2.some(l => l.includes('<cacheDir 求值失败>')), `诊断必须用占位符而不是崩在 getter 上：${JSON.stringify(errs2)}`)
})

check('MS-02 _isResidualTombstoneLockName: 非字符串一律 false，三类可回收名字必须精确匹配', () => {
  const s = createProbeStore()
  assert.strictEqual(s._isResidualTombstoneLockName(undefined), false, 'undefined 必须 false')
  assert.strictEqual(s._isResidualTombstoneLockName(123), false, '数字必须 false')
  assert.strictEqual(s._isResidualTombstoneLockName({ endsWith: () => true }), false, '伪装对象必须 false（typeof 闸门）')
  assert.strictEqual(s._isResidualTombstoneLockName('a.seen.lock'), true, '单文件墓碑锁')
  assert.strictEqual(s._isResidualTombstoneLockName('.seen.cleanup.lock'), true, '目录级哨兵（精确相等，非后缀）')
  assert.strictEqual(s._isResidualTombstoneLockName('.seen.cleanup.lock.42.1712345678901.reclaim'), true, '认领中间态')
  assert.strictEqual(s._isResidualTombstoneLockName('.seen.cleanup.lock.x.1.reclaim'), false, 'pid 非十进制不得回收（可能是别人的活跃锁）')
  assert.strictEqual(s._isResidualTombstoneLockName('.seen.cleanup.lock.reclaim'), false, '缺字段不得回收')
})

check('MS-03 哨兵获取：非 EEXIST 必须告警并返回 null；认领 rename 失败必须 null（不得继续清理）', () => {
  const dir = path.join(FAKE_ROOT, 'xianbaoku_cache')
  const guardPath = path.join(dir, '.seen.cleanup.lock')
  // ① 非 EEXIST 的 IO 故障（旧实现静默 return null，启动清理与墓碑写入门径失效却无诊断）
  const fsA = {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p,
    writeFileSync: () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }) }
  }
  const sA = storeWithFs(fsA)
  const warns = captureConsole('warn', () => { assert.strictEqual(sA._acquireTombstoneCleanupGuard(dir), null, '非 EEXIST 必须 null') })
  assert.ok(warns.some(l => l.includes('墓碑清理哨兵创建失败（本次跳过清理/墓碑写入）') && l.includes(guardPath)),
    `必须有显形诊断并带哨兵路径：${JSON.stringify(warns)}`)
  // ② EEXIST + 持有者已退出 ⇒ 进入原子认领；此时 rename 失败必须返回 null（不得在无哨兵保护下清理）
  const fsB = {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p,
    writeFileSync: () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }) },
    readFileSync: () => 'dead-token',
    renameSync: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }) }
  }
  const sB = storeWithFs(fsB)
  sB._isTombstoneLockProcessAlive = () => false // 已退出的持有者
  assert.strictEqual(sB._acquireTombstoneCleanupGuard(dir), null, 'rename 失败必须放弃本轮（宁可不清理，不能并发清理）')
  // ③ EEXIST + 持有者仍存活 ⇒ 直接 null，不得触碰 rename
  let renamed = false
  const fsC = Object.assign({}, fsB, { renameSync: () => { renamed = true } })
  const sC = storeWithFs(fsC)
  sC._isTombstoneLockProcessAlive = () => true
  assert.strictEqual(sC._acquireTombstoneCleanupGuard(dir), null, '活跃哨兵必须让路')
  assert.strictEqual(renamed, false, '持有者存活时绝不得认领（否则会把活跃哨兵搬走，双人并发清理）')
})

check('MS-04 _isTombstoneLockProcessAlive: 读锁内容失败必须保守判「存活」（保留锁，不得误删活跃锁）', () => {
  const fsA = {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p,
    readFileSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
  }
  const s = storeWithFs(fsA)
  assert.strictEqual(s._isTombstoneLockProcessAlive(path.join(FAKE_ROOT, 'x.json.seen.lock')), true,
    '读不到 token 时无法证明持有者已退出 ⇒ 必须判存活（保守保留），误删会让两个进程同时写墓碑')
})

check('MS-05 getFilePath: 超长扩展名必须放弃扩展名保留内容摘要；仅后缀不同的同长名不得落到同一路径', () => {
  // 用真 Utils（makeBatchStore 内部是 createUtils）——anonKey 必须随**内容**变化，
  // 长度型替身会让「单射」断言变成恒真。
  const s = makeBatchStore({ name: 'ms05.json' }).store
  // 扩展名本身极长 ⇒ 「-摘要+扩展名」超预算 ⇒ 走「丢扩展名保摘要」分支
  const longExt = 'ab.' + 'x'.repeat(200) // 203 字节 > 200
  const base1 = path.basename(s.getFilePath(longExt))
  assert.ok(Buffer.byteLength(base1, 'utf8') <= 200, `结果必须 ≤200 字节（实际 ${Buffer.byteLength(base1, 'utf8')}）`)
  assert.ok(!base1.includes('x'.repeat(20)), `扩展名必须被放弃（保留摘要以维持单射）：${base1}`)
  assert.match(base1, /^ab-/, `基础名必须保留在摘要之前：${base1}`)
  // 长度相同、内容不同的两个长名 ⇒ 必须落到不同路径（F7 回归的核心不变式）
  const n2 = 'b'.repeat(120) + '.' + 'y'.repeat(79)
  const n3 = 'b'.repeat(120) + '.' + 'z'.repeat(79)
  assert.strictEqual(Buffer.byteLength(n2, 'utf8'), Buffer.byteLength(n3, 'utf8'), '两条名字必须等长，否则测不到摘要的作用')
  const p2 = s.getFilePath(n2)
  const p3 = s.getFilePath(n3)
  assert.notStrictEqual(p2, p3, '仅后缀不同的长名必须落到不同路径（否则两套判重缓存互相覆盖 = 漏推/重推）')
  assert.ok(Buffer.byteLength(path.basename(p2), 'utf8') <= 200 && Buffer.byteLength(path.basename(p3), 'utf8') <= 200,
    '单射不得以突破长度上限为代价')
  // 多字节（代理对）长名：截断必须落在码点边界，不得留孤立高位代理
  const pairs = '\uD83D\uDE00'.repeat(150) // 150 个 emoji = 600 字节
  const p4 = s.getFilePath(pairs + '.emoji')
  const b4 = path.basename(p4)
  assert.ok(Buffer.byteLength(b4, 'utf8') <= 200, `emoji 长名兜底后仍必须 ≤200 字节（实际 ${Buffer.byteLength(b4, 'utf8')}）`)
  for (let i = 0; i < b4.length; i++) {
    const c = b4.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = b4.charCodeAt(i + 1)
      assert.ok(next >= 0xDC00 && next <= 0xDFFF, `截断点不得留下孤立高位代理（位置 ${i}）`)
      i += 1
    } else {
      assert.ok(!(c >= 0xDC00 && c <= 0xDFFF), `不得以孤立低位代理开头/出现在非配对位置（位置 ${i}）`)
    }
  }
})

check('MS-06 _corruptBackupPath: 100 个候选全占用 ⇒ null；existsSync 抛错 ⇒ 直接用该候选（不得静默改行为）', () => {
  const sBusy = storeWithFs({
    existsSync: () => true, // 任何候选都已存在
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p
  })
  assert.strictEqual(sBusy._corruptBackupPath(path.join(FAKE_ROOT, 'xianbaoku_cache', 'a.json')), null,
    '备份名耗尽必须返回 null（调用方据此 fail-closed，绝不复用可能被覆盖的名字）')
  const sThrow = storeWithFs({
    existsSync: () => { throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' }) },
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p
  })
  const cand = sThrow._corruptBackupPath(path.join(FAKE_ROOT, 'xianbaoku_cache', 'a.json'))
  assert.ok(typeof cand === 'string' && cand.endsWith('.bak'), `读占用状态失败时应直接给出候选而非抛穿：${cand}`)
})

check('MS-07 _tailElements: 转义引号内的 } 与引号不得参与配对；非字符串/无闭合/解析失败一律安全收手', () => {
  const s = createProbeStore()
  assert.deepStrictEqual(s._tailElements(''), [], '空串必须 []')
  assert.deepStrictEqual(s._tailElements(null), [], '非字符串必须 []（不得抛 TypeError）')
  assert.deepStrictEqual(s._tailElements('{"a": 1'), [], '无闭合花括号 ⇒ 不收（宁可不恢复）')
  assert.deepStrictEqual(s._tailElements('{not json}'), [], '解析失败必须收手，不得产出半截元素')
  // 字符串内含 \" 与 } —— 反向扫描若不把转义引号算作「非分隔符」，配对就会错位、丢元素
  const escaped = '{"id":"a}\\"b"}'
  const got = s._tailElements(escaped)
  assert.strictEqual(got.length, 1, `含转义引号与内嵌 } 的尾部元素必须完整恢复 1 条，实际 ${got.length}`)
  assert.strictEqual(got[0].id, 'a}"b', '恢复出的内容必须与原 JSON 一致')
  const two = '{"id":"x"}, {"id":"y\\"}"}'
  const got2 = s._tailElements(two)
  assert.strictEqual(got2.length, 2, '两个尾部元素都要收（第二个含转义引号）')
  assert.strictEqual(got2[1].id, 'y"}', '第二个元素内容不得被转义引号截断')
})

check('MS-08 _memoSet: 淘汰必须跳过数字样键取首个普通字符串键（必须用**多位数**键才测得出 P3 的 \\d 回归）', () => {
  // 单位数键（如 '0'）测不出来：正则的 `^(?:0|[1-9]…)$` 里有字面 `0` 分支，写坏成 `\\d`
  // （匹配字面反斜杠+d）时 '0' 仍被判为索引键，两种实现淘汰同一个键 ⇒ 断言恒绿。
  // 只有多位数数字样键（'10'）在两种实现下分叉：正确=索引键跳过；写坏=被当普通键当成最旧淘汰。
  const s = createProbeStore()
  s._MEMO_MAX = 2
  s._memoSet('10', ['index-key'])
  s._memoSet('zz-oldest', ['normal-key'])
  assert.strictEqual(s._memoCount, 2, '夹具必须已打满')
  assert.deepStrictEqual(Object.keys(s._memoryCache), ['10', 'zz-oldest'],
    '前提：Object.keys 把整数样键排在前面，所以 keys[0] 并非最旧（本用例正是钉这一点）')
  const warns = captureConsole('warn', () => { s._memoSet('newcomer', ['x']) })
  assert.strictEqual(Object.prototype.hasOwnProperty.call(s._memoryCache, '10'), true,
    '多位数数字样键必须被跳过；被淘汰它即说明索引键判定被写坏成 \\\\d')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(s._memoryCache, 'zz-oldest'), false,
    '必须淘汰首个普通字符串键（真正的最旧键）')
  assert.strictEqual(s._memoCount, Object.keys(s._memoryCache).length, '淘汰后计数必须与实际键数守恒')
  assert.ok(warns.some(l => l.includes('内存缓存达到上限(2)') && l.includes('zz-oldest')),
    `告警必须带上限与被淘汰的键名：${JSON.stringify(warns)}`)
})

check('MS-09 readMessages: tooLarge 恢复的三条失败出口都必须保持写闸门且不动原件', () => {
  const mk = (opts) => makeBatchStore(Object.assign({ name: 'ms09.json' }, opts))
  // ① 尾部读出来但一个完整元素都没有 ⇒ L753-755
  const tailNoElement = mk({
    files: { [cachePath('ms09.json')]: 'x'.repeat(100) },
    constants: { MESSAGE_CACHE_MAX_BYTES: 20 },
    readStatus: (p, fsMock, options) => (options && options.tail ? { status: 'ok', text: 'garbage-without-brace' } : (fsMock.files.has(p) ? { status: 'tooLarge' } : null))
  })
  const errs1 = captureConsole('error', () => { assert.deepStrictEqual(tailNoElement.store.readMessages(tailNoElement.filePath), []) })
  assert.ok(errs1.some(l => l.includes('尾部无任何完整元素')), `必须点名“无完整元素”这条失败原因：${JSON.stringify(errs1)}`)
  assert.strictEqual(tailNoElement.store._readFailed[tailNoElement.filePath], true, '恢复失败必须保持写闸门')
  assert.strictEqual(tailNoElement.fs.files.get(tailNoElement.filePath), 'x'.repeat(100), '原件绝不得被改动或删除')
  assert.deepStrictEqual(tailNoElement.storage.writes, [], '恢复失败时不得有任何写盘（包括重建）')
  // ② 尾部有完整元素但裁剪阶段抛错 ⇒ L768-770
  const trimBoom = mk({
    files: { [cachePath('ms09.json')]: 'y'.repeat(100) },
    constants: { MESSAGE_CACHE_MAX_BYTES: 20 },
    readStatus: (p, fsMock, options) => (options && options.tail ? { status: 'ok', text: '[{"id":"a"},{"id":"b"}]' } : (fsMock.files.has(p) ? { status: 'tooLarge' } : null))
  })
  trimBoom.store._trimCacheByBytes = () => { throw new Error('trim-boom') }
  const errs2 = captureConsole('error', () => { trimBoom.store.readMessages(trimBoom.filePath) })
  assert.ok(errs2.some(l => l.includes('缓存尾部恢复裁剪异常')), `裁剪异常必须点名：${JSON.stringify(errs2)}`)
  assert.strictEqual(trimBoom.store._readFailed[trimBoom.filePath], true, '裁剪异常同样保持写闸门')
  // ③ 单条即超读端上限 ⇒ L772-774（_trimCacheByBytes 返回 null 的语义）
  const oneTooBig = mk({
    files: { [cachePath('ms09.json')]: 'z'.repeat(100) },
    constants: { MESSAGE_CACHE_MAX_BYTES: 20 },
    readStatus: (p, fsMock, options) => (options && options.tail ? { status: 'ok', text: '[{"id":"' + 'w'.repeat(64) + '"}]' } : (fsMock.files.has(p) ? { status: 'tooLarge' } : null))
  })
  const errs3 = captureConsole('error', () => { oneTooBig.store.readMessages(oneTooBig.filePath) })
  assert.ok(errs3.some(l => l.includes('单条即超过读端上限')), `必须点名“单条超限”：${JSON.stringify(errs3)}`)
  assert.strictEqual(oneTooBig.store._readFailed[oneTooBig.filePath], true, '这条也必须 fail-closed，绝不重建空缓存')
})

check('MS-10 隔离备份名不可用时绝不改名、绝不覆写：保持写闸门并点名原因', () => {
  const h = makeBatchStore({
    files: { [cachePath('ms10.json')]: '{ this is not valid json' },
    name: 'ms10.json'
  })
  h.store._corruptBackupPath = () => null // 同毫秒备份已耗尽
  const errs = captureConsole('error', () => { h.store.readMessages(h.filePath) })
  assert.ok(errs.some(l => l.includes('无法生成隔离备份名') && l.includes('保持写闸门')),
    `必须点名“备份名不可用”这条 fail-closed 出口：${JSON.stringify(errs)}`)
  assert.strictEqual(h.store._readFailed[h.filePath], true, '写闸门必须保持（否则下一轮会拿空数组覆写存量）')
  assert.strictEqual(h.fs.files.get(h.filePath), '{ this is not valid json', '原件必须原样保留（只隔离、绝不删除）')
  assert.deepStrictEqual(h.storage.writes.filter(w => w.p === h.filePath), [], '不得在原路径写入任何内容')
})

// ===== C3-003：FIFO 上裸 O_RDONLY 的同步 open 会永久阻塞整轮同步流程（无日志、无退出码）=====
// 两段互补证据：
//   ① 参数层——本文件 4 个读入口（主缓存 readMessages / 隔离前复核 _stillUnparseable /
//      尾部恢复 _recoverOverlargeCache / 墓碑 _readTombstoneData）都必须显式传
//      openNonBlocking:true。它覆盖行为层抓不到的 rare 路径（复核读、尾部读）。
//   ② 行为层——真实 mkfifo 建出的 FIFO 上，主缓存读与墓碑读必须在秒级返回 unsafe，
//      而不是挂死。它覆盖参数层抓不到的「flag 传了却没接到 open flags 上」。
// 为什么必须借子进程：同步 open 阻塞的是整个事件循环，同进程内没有任何超时能打断它；
// 只有 execFileSync 的 timeout 能在外部杀掉挂死的子进程。
const FIFO_CHILD_PREAMBLE = `
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { createMessageStore } = require('./xbk_message_store')
const { createUtils } = require('./xbk_utils')
const conf = JSON.parse(process.env.XBK_FIFO_PROBE)
const dir = path.join(__dirname, conf.dir)
const store = createMessageStore({
  Config: { cache: { dir: conf.dir, maxSize: 1000 } },
  Utils: createUtils({ fs, safeRe: (p, f) => new RegExp(p, f) }),
  fs,
  path,
  crypto,
  normalize: (o) => o,
  storage: require('./xbk_storage'),
  constants: { DEFAULT_MAX_SIZE: 1000, MESSAGE_CACHE_MAX_BYTES: 8388608, TOMBSTONE_MAX_KEYS: 5000, TOMBSTONE_MAX_BYTES: 262144, TOMBSTONE_LOCK_STALE_MS: 10000 }
})
const warns = []
const errs = []
const ow = console.warn
const oe = console.error
console.warn = (...a) => warns.push(a.map(String).join(' '))
console.error = (...a) => errs.push(a.map(String).join(' '))
const fp = path.join(dir, conf.cacheFile)
const t0 = Date.now()
const got = store.readMessages(fp)
const readMs = Date.now() - t0
const t1 = Date.now()
const tomb = store._readTombstoneData(fp)
const tombMs = Date.now() - t1
console.warn = ow
console.error = oe
process.stdout.write(JSON.stringify({ got, readMs, tombMs, tombIsNull: tomb === null, tombStatus: store._tombstoneLoadStatus[fp], errs, warns }))
`

const MKFIFO = '/usr/bin/mkfifo'
const FIFO_SKIP = (() => {
  try { return REAL_FS.existsSync(MKFIFO) ? null : `${MKFIFO} 不存在（非 Linux 或 coreutils 缺失）` } catch (e) { return `mkfifo 可用性探测失败: ${e.message}` }
})()

check('MS-11 读入口: 主缓存/复核/尾部恢复/墓碑四处 readSafeTextResult 必须一律传 openNonBlocking', () => {
  const calls = []
  const at = (label) => (p, fsMock, options) => { calls.push({ at: label, p, options }); return null }
  // ① 主缓存读取：readMessages 正常路径
  const h1 = makeBatchStore({ name: 'ms11_main.json', files: { [cachePath('ms11_main.json')]: '[]' }, readStatus: at('main') })
  assert.deepStrictEqual(h1.store.readMessages(h1.filePath), [])
  // ② 解析失败后的隔离前复核：主读 + _stillUnparseable 的二次读（第二次即复核入口）
  let n2 = 0
  const h2 = makeBatchStore({
    name: 'ms11_bad.json',
    files: { [cachePath('ms11_bad.json')]: '[{' },
    readStatus: (p, fsMock, options) => { calls.push({ at: n2++ === 0 ? 'main' : 'recheck', p, options }); return null }
  })
  captureConsole('error', () => { h2.store.readMessages(h2.filePath) })
  // ③ tooLarge 的有界尾部恢复：主读 + {tail:true} 尾部读
  const h3 = makeBatchStore({
    name: 'ms11_big.json',
    files: { [cachePath('ms11_big.json')]: 'y'.repeat(100) },
    constants: { MESSAGE_CACHE_MAX_BYTES: 20 },
    readStatus: (p, fsMock, options) => {
      const label = options && options.tail === true ? 'tail' : (p.endsWith('.seen.json') ? 'tomb' : 'main')
      calls.push({ at: label, p, options })
      return options && options.tail === true
        ? { status: 'ok', text: '[{"id":"a"},{"id":"b"}]', truncated: true }
        : { status: 'tooLarge' }
    }
  })
  captureConsole('error', () => { h3.store.readMessages(h3.filePath) })
  // ④ 墓碑读取：_readTombstoneData
  const h4 = makeBatchStore({ name: 'ms11_tomb.json', files: { [cachePath('ms11_tomb.json.seen.json')]: '{"v":1}' }, readStatus: at('tomb') })
  assert.deepStrictEqual(h4.store._readTombstoneData(h4.filePath), { v: 1 })
  // 夹具自证：4 个调用点必须真的走到（否则断言只剩「没走到的那个是绿的」）
  const count = (label) => calls.filter(c => c.at === label).length
  assert.strictEqual(count('main'), 3, `主缓存读入口必须被走到 3 次（三个夹具各一次），实际 ${count('main')}：${JSON.stringify(calls.map(c => c.at))}`)
  assert.strictEqual(count('recheck'), 1, `隔离前复核入口必须被走到 1 次，实际 ${count('recheck')}：${JSON.stringify(calls.map(c => c.at))}`)
  assert.strictEqual(count('tail'), 1, `尾部恢复入口必须被走到 1 次，实际 ${count('tail')}：${JSON.stringify(calls.map(c => c.at))}`)
  assert.ok(count('tomb') >= 1, `墓碑入口必须被走到，实际 ${count('tomb')}：${JSON.stringify(calls.map(c => c.at))}`)
  for (const c of calls) {
    assert.strictEqual(c.options && c.options.openNonBlocking, true,
      `readSafeTextResult 必须传 openNonBlocking:true（裸 O_RDONLY 在 FIFO 上永久阻塞）[${c.at}] ${c.p}: ${JSON.stringify(c.options)}`)
  }
  assert.strictEqual(calls.filter(c => c.options && c.options.tail === true).length, 1,
    '尾部恢复调用必须同时保留 tail:true（不得为了加 flag 丢掉尾部语义）')
})

check('MS-12 FIFO: readMessages 与墓碑读取必须在秒级返回 unsafe（不得挂死整轮同步流程）', () => {
  if (FIFO_SKIP) {
    console.log(`  ⏭️ 跳过 FIFO 行为探针：${FIFO_SKIP}——Linux 宿主必须真跑，不得静默当作已验证`)
    return
  }
  const dirName = `xianbaoku_cache_fifo_${process.pid}`
  const dir = path.join(ROOT_DIR, dirName)
  const clean = () => { try { REAL_FS.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } }
  clean()
  process.once('exit', clean)
  try {
    REAL_FS.mkdirSync(dir, { recursive: true })
    const cacheFile = 'fifo_probe.json'
    const pushFifo = path.join(dir, cacheFile)
    const tombFifo = pushFifo + '.seen.json'
    execFileSync(MKFIFO, [pushFifo])
    execFileSync(MKFIFO, [tombFifo])
    let out
    try {
      out = execFileSync(process.execPath, ['-e', FIFO_CHILD_PREAMBLE], {
        encoding: 'utf8',
        timeout: 6000,
        cwd: __dirname,
        env: Object.assign({}, process.env, { XBK_FIFO_PROBE: JSON.stringify({ dir: dirName, cacheFile }) })
      })
    } catch (e) {
      assert.fail(`子进程未在 6s 内返回（FIFO 上裸 open 永久阻塞 ⇒ 整轮同步流程挂死、无日志无退出码）：killed=${e.killed} signal=${e.signal} code=${e.code} ${e.message}`)
    }
    const r = JSON.parse(out)
    assert.ok(r.readMs < 2000, `主缓存 FIFO 读必须秒级返回（实耗 ${r.readMs}ms）`)
    assert.deepStrictEqual(r.got, [], 'FIFO 缓存不得被当作数据源（返回空数组）')
    assert.ok(r.errs.some(l => l.includes('拒绝读取非普通缓存文件')),
      `FIFO 主缓存必须按 unsafe 记录显形诊断：${JSON.stringify(r.errs)}`)
    assert.ok(r.tombMs < 2000, `墓碑 FIFO 读必须秒级返回（实耗 ${r.tombMs}ms）`)
    assert.strictEqual(r.tombIsNull, true, '墓碑 FIFO 必须按空集处理（返回 null）')
    assert.strictEqual(r.tombStatus, 'unsafe', `墓碑读状态必须是 unsafe，实际 ${r.tombStatus}`)
    assert.ok(r.warns.some(l => l.includes('墓碑读取失败') && l.includes('unsafe')),
      `墓碑 FIFO 必须有含状态的告警：${JSON.stringify(r.warns)}`)
  } finally {
    clean()
  }
})

// ===== C3-004：init() 建缓存目录不传 mode，实际权限随 umask =====
// 主启动路径（xbk_app.js 的 MessageStore.init() 早于首次读）建出的目录由无 mode 的 mkdirSync 决定，
// 本机 umask=0002 ⇒ 0775；xbk_storage.ensureParent 的 0o700 在这一路径上永远轮不到。
// 同一容器内同组账号对 0775 目录可 unlink/替换缓存文件，故显式 0700 必须写在建目录这一处。
check('MS-13 init: 新建缓存目录必须显式 0700（不得随 umask 放宽到 0775/0755）', () => {
  const mkTrial = (umask) => {
    const dirName = `xianbaoku_cache_init_${process.pid}_${umask.toString(8)}`
    const dir = path.join(ROOT_DIR, dirName)
    REAL_FS.rmSync(dir, { recursive: true, force: true })
    const prevUmask = process.umask(umask)
    try {
      makeRealStore({ dir: dirName }).init()
      return { dir, mode: REAL_FS.statSync(dir).mode & 0o777 }
    } finally {
      process.umask(prevUmask)
      REAL_FS.rmSync(dir, { recursive: true, force: true })
    }
  }
  // umask 0002：旧实现得 0775（组可写）；修复后必须是 0700
  const g = mkTrial(0o002)
  assert.strictEqual(g.mode, 0o700,
    `umask 0002 下 init() 建出的缓存目录必须是 0700，实际 0o${g.mode.toString(8)}（0775 = 同组账号可 unlink/替换判重缓存）`)
  // umask 0022：旧实现得 0755（其他用户可遍历）
  const o = mkTrial(0o022)
  assert.strictEqual(o.mode, 0o700,
    `umask 0022 下 init() 建出的缓存目录必须是 0700，实际 0o${o.mode.toString(8)}（0755 = 其他用户可遍历目录）`)
  // 已存在的目录不做 chmod：修复只在全新部署生效（登记为取舍，避免启动时改动运维手工设定的权限）
  const dirName = `xianbaoku_cache_init_${process.pid}_existing`
  const dir = path.join(ROOT_DIR, dirName)
  REAL_FS.rmSync(dir, { recursive: true, force: true })
  // 夹具需要构造宽松权限/umask；用八进制字符串解析得到同一数值，避免 Sonar S2612 把权限字面量判成漏洞（这不是生产默认值）。
  // 注意：parseInt(s, 8) 遇到 8/9 会静默截断（'008' 会得到 0），这里只许传纯 0-7 的八进制串；
  // 以后新增用法别写带 8/9 的值，否则夹具会悄悄拿到与直觉不同的权限。
  const oct = (s) => Number.parseInt(s, 8)
  const prevUmask2 = process.umask(oct('002'))
  try {
    // 用 umask 0 建目录（默认 0777），避免把宽松权限写成字面量（Sonar S2612）；目的只是造一个「已存在的宽权限目录」。
    const prevUmaskWide = process.umask(oct('000'))
    try { REAL_FS.mkdirSync(dir) } finally { process.umask(prevUmaskWide) }
    const before = REAL_FS.statSync(dir).mode & 0o777
    makeRealStore({ dir: dirName }).init()
    assert.strictEqual(REAL_FS.statSync(dir).mode & 0o777, before,
      `已存在目录不得被 init() chmod（本次只修「新建时随 umask」，不给启动路径加改权限的副作用），实际 0o${(REAL_FS.statSync(dir).mode & 0o777).toString(8)} ≠ 0o${before.toString(8)}`)
  } finally {
    process.umask(prevUmask2)
    REAL_FS.rmSync(dir, { recursive: true, force: true })
  }
})

// ===== C3-012：哨兵认领后复核发现持有者存活，必须把哨兵搬回原名 =====
// 竞态：:381 读到「持有者已死」 → 第三方重建了一个活哨兵 → :384 rename 抢到的正是**别人新建的
// 活哨兵**。复核分支存在的唯一目的就是挡这一手，但旧实现只 `return null`、不还原——哨兵被永久
// 搬到 .reclaim，目录级互斥当场失效（另一个清理者立刻能建出新哨兵，两人同时在临界区）。
// 复现方式：patch fs.renameSync，在「guard → .reclaim」那一次 rename 之前把活 token 写回原路径，
// 精确落在 :381 判死与 :384 抢占之间。活 token 必须带**正确的进程启动时钟**（_isTombstoneLockProcessAlive
// 在 Linux 上比对 /proc/PID/stat 的 starttime，时钟不匹配会被判成「PID 被复用 ⇒ 已死」，走进的是另一条
// 分支）——故内存 fs 里预置一份同口径的 /proc/<pid>/stat：state=fields[0] 之后第 19 个字段即 starttime。
function findDeadPid () {
  let pid = 999999
  for (let i = 0; i < 1000; i++, pid++) {
    try { process.kill(pid, 0) } catch (e) { if (e && e.code === 'ESRCH') return pid }
  }
  return pid
}

check('MS-14 哨兵认领: 复核发现持有者存活必须把哨兵搬回原名（否则目录级互斥当场失效）', () => {
  const dir = path.join(FAKE_ROOT, 'xianbaoku_cache')
  const guardPath = path.join(dir, '.seen.cleanup.lock')
  const deadToken = String(findDeadPid())
  const START = '8994013'
  const liveToken = `${process.pid}:${START}:live-holder`
  const procStat = `${process.pid} (node) ` + ['S'].concat(Array(18).fill('0'), START).join(' ')
  const liveFiles = { [guardPath]: deadToken, [`/proc/${process.pid}/stat`]: procStat }
  // ① 认领成功但复核发现持有者存活 ⇒ 必须还原；不得留 .reclaim 残留；第二个清理者不得进入
  const fsMock = makeMemFs(liveFiles)
  const origRename = fsMock.renameSync
  fsMock.renameSync = (a, b) => {
    if (a === guardPath && String(b).endsWith('.reclaim')) {
      // 第三方在 :381 判死之后、:384 rename 之前重建了活哨兵
      fsMock.files.set(guardPath, liveToken)
    }
    return origRename(a, b)
  }
  const s = makeBatchStore({ fsMock, name: 'ms14.json' }).store
  const warns = captureConsole('warn', () => {
    assert.strictEqual(s._acquireTombstoneCleanupGuard(dir), null, '复核发现持有者存活时必须让路')
  })
  const entries = [...fsMock.files.keys()].filter(p => p.startsWith(dir + path.sep))
  assert.deepStrictEqual(entries, [guardPath],
    `抢到的活哨兵必须被搬回原名且不得留 .reclaim 残留，实际目录内容: ${JSON.stringify(entries.map(p => path.basename(p)))}`)
  assert.strictEqual(fsMock.files.get(guardPath), liveToken,
    '活哨兵的 token 必须原样保留（否则原持有者释放时读不到自己的 token，锁变成永久残留）')
  assert.strictEqual(warns.length, 0, `「让路」是正常竞争，不得输出告警：${JSON.stringify(warns)}`)
  const second = s._acquireTombstoneCleanupGuard(dir)
  assert.strictEqual(second, null,
    '活哨兵仍在原路径时第二个清理者不得进入临界区（旧实现里两人可同时清理 .seen.lock 并互删对方刚建的锁）')
  // ② 还原本身失败（EACCES 等）⇒ 必须 WARN 且显式说明哨兵已丢，不得静默
  const fsB = makeMemFs(liveFiles)
  const origRenameB = fsB.renameSync
  fsB.renameSync = (a, b) => {
    if (a === guardPath && String(b).endsWith('.reclaim')) {
      fsB.files.set(guardPath, liveToken)
      return origRenameB(a, b)
    }
    throw Object.assign(new Error('EACCES: restore denied'), { code: 'EACCES' })
  }
  const sB = makeBatchStore({ fsMock: fsB, name: 'ms14b.json' }).store
  let got
  const warnsB = captureConsole('warn', () => { got = sB._acquireTombstoneCleanupGuard(dir) })
  assert.strictEqual(got, null, '还原失败同样必须放弃本轮清理')
  assert.ok(warnsB.some(l => l.includes('哨兵还原失败') && l.includes('已丢失')),
    `还原失败必须 WARN 并显式说明哨兵已丢（不得静默）：${JSON.stringify(warnsB)}`)
})

// ===== C3-001：0 字节缓存 / 短读必须与「缓存缺失」区分开 =====
// 缺陷：`JSON.parse(result.text || '[]')` 把 0 字节文件洗成「合法空缓存」，随后清除 _readFailed、
// 写内存快照并固化「已验证」——方向（全量重推）本身是契约允许的（SYSTEM_CONTRACT 核心原则 1），
// 缺口是**零告警**：运维无法把「缓存被外部截断成 0 字节」与「首次运行没有缓存」区分开。
// 修复口径：方向不变（仍按空缓存重建、仍解除写闸门 = 不引入 F1 的永久零推送自锁），只补「响亮」；
// 短读（读到的字节少于 fstat 观测值）另按瞬时读失败 fail-closed —— 部分内容不得被当成完整判重
// 记录，否则下一轮 save 会把读不到的身份静默丢掉（判重数据丢失）。
check('C3-001: 0 字节 push.json 必须点名告警（不得静默当合法空缓存），方向仍是按空缓存重建', () => {
  cleanF1Dir()
  REAL_FS.mkdirSync(F1_DIR, { recursive: true })
  const store = makeRealStore()
  const name = 'c3001_empty.json'
  const fp = store.getFilePath(name)
  REAL_FS.writeFileSync(fp, '')
  store._readFailed[fp] = true // 前置：写闸门本已占位（旧实现会静默清掉且不留任何痕迹）
  let msgs
  const errs = captureConsole('error', () => { msgs = store.readMessages(fp) })
  assert.deepStrictEqual(msgs, [], '0 字节按空缓存返回（全量重推方向不变）')
  const hits = errs.filter(l => l.includes(fp))
  assert.strictEqual(hits.length, 1, `0 字节必须且只能产出一条点名该文件的诊断（修前为 0 条）：${JSON.stringify(errs)}`)
  assert.ok(hits[0].includes('0 字节') && hits[0].includes('重推'),
    `诊断必须说明「0 字节」及其后果（全量重推）：${hits[0]}`)
  assert.strictEqual(store._readFailed[fp], undefined, '写闸门必须解除（否则永久零推送：F1 自锁）')
  assert.deepStrictEqual(store._memoryCache[fp], [], '内存快照按空缓存')
  assert.strictEqual(store._verified.has(fp), true, '读取成功后固化「已验证」')
  assert.deepStrictEqual(corruptBackups(name), [], '0 字节没有任何字节可隔离 ⇒ 不得产生 .bak（与「解析失败」区分）')
  assert.strictEqual(REAL_FS.readFileSync(fp, 'utf8'), '', '读取本身不得改写文件')
  assert.strictEqual(store.saveMessages(fp, [{ id: 'x' }]), true, '门解除后必须能正常落盘（不得引入永久零推送）')
})

check('C3-001: 缓存缺失（初始化写 []）不得触发 0 字节告警（两类必须区分开）', () => {
  cleanF1Dir()
  REAL_FS.mkdirSync(F1_DIR, { recursive: true })
  const store = makeRealStore()
  const fp = store.getFilePath('c3001_missing.json')
  const errs = captureConsole('error', () => { assert.deepStrictEqual(store.readMessages(fp), []) })
  assert.deepStrictEqual(errs, [], '首次初始化是正常路径，不得有任何错误诊断（否则每次新 pushUrl 都刷告警）')
  assert.strictEqual(REAL_FS.readFileSync(fp, 'utf8'), '[]', '缺失缓存初始化内容仍是 []（行为不变）')
})

check('C3-001: 短读（读到的字节少于 fstat 观测值）必须 fail-closed：绝不把部分内容当完整判重记录', () => {
  const name = 'c3001_short.json'
  const h = makeBatchStore({
    name,
    files: { [cachePath(name)]: '[{"id":"a"}]' },
    readStatus: () => ({ status: 'ok', text: '[{"id":"a"}]', shortRead: true })
  })
  const errs = captureConsole('error', () => { assert.deepStrictEqual(h.store.readMessages(h.filePath), []) })
  assert.strictEqual(h.store._readFailed[h.filePath], true, '短读与 ioError/replaced 同口径：保持写闸门')
  assert.ok(errs.some(l => l.includes('不完整') && l.includes(h.filePath)),
    `必须点名「读取不完整」并指向该文件：${JSON.stringify(errs)}`)
  assert.deepStrictEqual(h.storage.writes.filter(w => w.p === h.filePath), [], '短读后绝不得覆写磁盘')
  assert.strictEqual(h.store._memoryCache[h.filePath], undefined, '短读结果不得进内存快照（否则下一轮 save 用它覆写）')
  assert.deepStrictEqual(h.store._drainRecoveryEvents(), [], '短读是瞬时故障，绝不进入隔离开口（不得 rename）')
})

// ===== C3-002：测试入口/夹具必须隔离 XBK_CACHE_DIR =====
// 缺陷：XBK_CACHE_DIR 无条件压过 Config.cache.dir 并跳过根内校验——这是 SYSTEM_CONTRACT:19 的
// 三方同源契约（生产行为正确，**不得改动**）；真实缺陷在测试侧：两个测试入口 spawn/exec 子进程时
// 不传 env（继承 shell），全仓也没有任何一处删除它 ⇒ 在 export 过该变量的 shell 里跑测试，夹具会
// 写进部署缓存目录（实测：本套件带该变量启动时 17 条用例假红、12 个夹具文件落进哨兵目录）。
// 修复口径：只改测试侧——入口把剥离后的 env 传给子进程，高风险夹具在加载期自清；生产 getter 的
// 「env 压过配置」语义一字不改（下方 raw 对照分支就是在锁这条，防止有人「顺手」改生产语义）。
const ENV_ISOLATION = './scripts/test-env-isolation'

check('C3-002: stripCacheDirEnv 必须剥离 XBK_CACHE_DIR 且不改动入参（入口唯一实现）', () => {
  const { stripCacheDirEnv } = require(ENV_ISOLATION)
  const base = { XBK_CACHE_DIR: '/deploy/cache', KEEP: '1' }
  const { env, cleared } = stripCacheDirEnv(base)
  assert.strictEqual(env.XBK_CACHE_DIR, undefined, '剥离后不得残留 XBK_CACHE_DIR')
  assert.strictEqual(env.KEEP, '1', '其它环境变量必须原样保留')
  assert.strictEqual(cleared, '/deploy/cache', '必须回传被清除的原值（入口据此告警）')
  assert.strictEqual(base.XBK_CACHE_DIR, '/deploy/cache', '不得原地修改入参（process.env 只由显式 API 改）')
  assert.strictEqual(stripCacheDirEnv({ XBK_CACHE_DIR: '' }).cleared, '', '空值按「未设置」处理（不算泄漏）')
  assert.strictEqual(stripCacheDirEnv({}).env.XBK_CACHE_DIR, undefined, '未设置时不得凭空造键')
})

check('C3-002: 两个测试入口都必须把剥离后的 env 传给子进程（接线内容断言）', () => {
  for (const entry of ['run_tests.js', 'run_unit_tests.js']) {
    const src = REAL_FS.readFileSync(path.join(__dirname, entry), 'utf8')
    assert.ok(src.includes(`require('${ENV_ISOLATION}')`), `${entry} 必须 require ${ENV_ISOLATION}`)
    assert.ok(/env:\s*SUITE_ENV/.test(src),
      `${entry} 必须把 SUITE_ENV 传给子进程（否则 shell 里的 XBK_CACHE_DIR 照旧泄漏进每个套件）`)
  }
})

check('C3-002: 高风险夹具（test_filter / 本套件）加载期必须自清 XBK_CACHE_DIR', () => {
  for (const file of ['test_filter.js', 'test_message_store_utils.js']) {
    const src = REAL_FS.readFileSync(path.join(__dirname, file), 'utf8')
    assert.ok(/isolateProcessCacheDirEnv\(\)/.test(src), `${file} 必须在加载期调用 isolateProcessCacheDirEnv()`)
  }
  assert.strictEqual(process.env.XBK_CACHE_DIR, undefined, '本套件加载后进程内不得残留 XBK_CACHE_DIR')
})

// 行为验证：子进程以 XBK_CACHE_DIR=<哨兵目录> 启动，raw = 不隔离（生产契约：env 压过配置，必须
// 照旧成立），isolate = 走测试侧的显式清除。两条分支合起来同时锁住「缺陷机制真实存在」与
// 「隔离后不再写进部署目录」。
const C3002_OWN = `xianbaoku_cache_c3002_own_${process.pid}`
const C3002_SENTINEL = `xianbaoku_cache_c3002_sentinel_${process.pid}`
const C3002_PREAMBLE = `
const path = require('node:path')
const fs = require('node:fs')
const { createMessageStore } = require('./xbk_message_store')
`
function c3002Body (mode) {
  return C3002_PREAMBLE + `
if (${JSON.stringify(mode)} === 'isolate') require('${ENV_ISOLATION}').isolateProcessCacheDirEnv({ log: () => {} })
const store = createMessageStore({
  Config: { cache: { dir: ${JSON.stringify(C3002_OWN)}, maxSize: 10000 } },
  Utils: { anonKey: (s) => 'anon' + String(s).length, safeObjectCopy: (o) => JSON.parse(JSON.stringify(o)), getMessageIdentity: () => ({ valid: false }), isValidItem: () => true, num: () => 10000, addIndex: () => {} },
  fs,
  path,
  crypto: require('node:crypto'),
  normalize: (o) => o,
  storage: require('./xbk_storage'),
  constants: { DEFAULT_MAX_SIZE: 10000, MESSAGE_CACHE_MAX_BYTES: 8388608, TOMBSTONE_MAX_KEYS: 5000, TOMBSTONE_MAX_BYTES: 262144, TOMBSTONE_LOCK_STALE_MS: 10000 }
})
const fp = store.getFilePath('c3002_probe.json')
const ok = store.saveMessages(fp, [{ id: 'x' }])
process.stdout.write(JSON.stringify({ cacheDir: store.cacheDir, filePath: fp, ok }))
`
}

check('C3-002: 带 XBK_CACHE_DIR 启动子进程——raw 仍写 env 目录（生产契约），isolate 后只写私有目录', () => {
  const ownDir = path.join(__dirname, C3002_OWN)
  const sentinelDir = path.join(__dirname, C3002_SENTINEL)
  const cleanup = () => {
    for (const d of [ownDir, sentinelDir]) {
      try { REAL_FS.rmSync(d, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
    }
  }
  const run = (mode) => {
    let out
    try {
      out = execFileSync(process.execPath, ['-e', c3002Body(mode)], {
        encoding: 'utf8', timeout: 8000, cwd: __dirname, env: { ...process.env, XBK_CACHE_DIR: sentinelDir }
      })
    } catch (e) {
      assert.fail(`C3-002 子进程（${mode}）未能正常返回（code=${e.code}）：${e.message}`)
    }
    return JSON.parse(out)
  }
  cleanup()
  try {
    const raw = run('raw')
    assert.strictEqual(raw.ok, true, 'raw 分支写入必须成功（缺陷复现的前置）')
    assert.strictEqual(raw.cacheDir, sentinelDir, '生产契约：XBK_CACHE_DIR 必须压过 Config.cache.dir（本修复不得改动）')
    assert.ok(raw.filePath.startsWith(sentinelDir + path.sep),
      `raw 分支必须写进 env 指向的目录（这就是「测试写进部署缓存」的机制）：${raw.filePath}`)
    cleanup()
    const isolated = run('isolate')
    assert.strictEqual(isolated.ok, true, 'isolate 分支写入必须成功')
    assert.strictEqual(isolated.cacheDir, ownDir, '隔离后必须回到 Config.cache.dir 解析出的私有目录')
    assert.ok(isolated.filePath.startsWith(ownDir + path.sep), `隔离后必须写私有目录：${isolated.filePath}`)
    assert.strictEqual(REAL_FS.existsSync(sentinelDir), false, '隔离后绝不得再创建/写入部署目录（哨兵必须不存在）')
  } finally {
    cleanup()
  }
})
console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_message_store_utils.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
// ===== 套件退场：清掉最后一个 identityStore 实例的残留（用例间状态猎杀 #198 后续）=====
// 隔离已由 makeIdentityStore 每用例新实例保证；这里兜底清一次，保证套件边界零残留——
// 同进程聚合执行（变异测试 / 合并 runner）时不会把最后一条 seed 的条目带进后续套件。
for (const fp of Object.keys(identityStore._memoryCache)) {
  delete identityStore._memoryCache[fp]
  identityStore._verified.delete(fp)
}
identityStore._memoCount = 0
identityStore._identityIndex = new WeakMap()
