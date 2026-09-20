/* eslint promise/param-names: off */ // new Promise(r => ...) 短参数名为项目既有风格
/* eslint camelcase: off */ // tuisong_replace 等 snake_case 为项目设计命名
'use strict'

// ============================================================
// App.run 集成测试：mock got + notify，验证主流程完整链路
// 独立文件：因需在 require 前替换 require.cache，不与 test_filter.js 混跑
// ============================================================

// ---------- mock 注入（必须在 require 主模块之前） ----------
require('got') // 先加载，让 require.cache 有条目
require('./xbk_sendNotify_slim')
const gotPath = require.resolve('got')
const notifyPath = require.resolve('./xbk_sendNotify_slim')

let gotCalls = []
let fakeData = []
let failCount = 0 // 5xx 类失败次数（无 response，会重试）
let fail4xx = false // 4xx 失败（带 response，不重试）
let failTimeout = false // 超时失败（code=ETIMEDOUT，会重试）
let fail429Once = false // 仅第一次抛 429（限流，应重试）
let fail425Once = false // 仅第一次抛 425（Too Early，应重试——P2：与 failure_policy RETRYABLE_CODES 收敛）
let failPlainString = false // 抛普通字符串(非 Error)
let failNonJson = false // 仅第一次返回非 JSON 响应（.json() 抛错，应重试）
let failLongMsg = false // 抛超长 message 的 Error（C043 日志截断）

require.cache[gotPath].exports = (url, opts) => {
  gotCalls.push({ url, opts })
  if (failLongMsg) {
    throw new Error('E'.repeat(3000)) // C043：超长 error.message
  }
  if (failPlainString) {
    // eslint-disable-next-line no-throw-literal -- 测试字符串异常处理
    throw 'plain string error'
  }
  if (fail429Once) {
    fail429Once = false
    const e = new Error('Too Many')
    e.response = { statusCode: 429 }
    throw e
  }
  if (fail425Once) {
    fail425Once = false
    const e = new Error('Too Early')
    e.response = { statusCode: 425 }
    throw e
  }
  if (failTimeout) {
    const e = new Error('timeout')
    e.code = 'ETIMEDOUT'
    throw e
  }
  if (fail4xx) {
    const e = new Error('Not Found')
    e.response = { statusCode: 404 }
    throw e
  }
  if (failCount > 0) {
    failCount--
    throw new Error('boom')
  }
  return {
    json: async () => {
    // 非 JSON 响应（真实 got 的 .json() 会抛 "Response is not JSON" → fetchData 应重试）
      if (failNonJson) { failNonJson = false; throw new Error('Response is not JSON: <html>') }
      return fakeData
    }
  }
}

let pushCalls = []
let notifyFail = false
let notifyFailAt = -1 // -1=永不失败，N=第N次调用失败
let notifyFailString = false // 抛非 Error(字符串)——R1：验证 pushOne catch 兜底
let notifyDelayMs = 0 // sendNotify 响应延迟（v3.164 #10：模拟真实网络，验证告警 await 后 exit）
let notifyCalls = 0
const defaultNotifySend = async (text, desp) => {
  notifyCalls++
  if (notifyDelayMs > 0) await new Promise(r => setTimeout(r, notifyDelayMs))
  if (notifyFailString) {
    // eslint-disable-next-line no-throw-literal -- 测试字符串异常处理
    throw 'push boom string' // 字符串异常（非 Error）
  }
  if (notifyFail) throw new Error('push boom')
  if (notifyFailAt > 0 && notifyCalls === notifyFailAt) throw new Error('push boom')
  pushCalls.push({ text, desp })
}
require.cache[notifyPath].exports = { sendNotify: defaultNotifySend }
// Pusher 在主模块加载时持有这个对象引用；测试替换 sendNotify 时必须修改对象属性，
// 仅替换 require.cache.exports 不会影响已捕获的引用。
const notifyMock = require.cache[notifyPath].exports

// ---------- require 主模块 ----------
const xbk = require('./xbk_function_v3.js')
const { Config } = xbk
const fs = require('fs')
const path = require('path')

// v3.172：并行 worker 独立缓存目录——多进程共享同一缓存目录曾致沙箱 overlayfs IO 竞态(ENOENT)，
// 每个 worker 用 xianbaoku_cache_p<N> 彻底隔离（缓存/run.log/state 全独立，无竞态）。
// Qodo PR #158（High / Security）后：ID 必须过白名单 + 根内校验，非法一律回退 pid 分片（fail-closed）；
// `XBK_PARALLEL_ID` 在**推导之前**先写回归一值，保证 env / DEFAULT_CACHE_DIR / CACHE_DIR 三者同源
// （否则生产 fallback 分支出的是另一个目录，测试断言与清理会指向不同落点）。
// ============================================================
// 缓存分片目录的「已验证路径」入口（Qodo PR #158 High / Security 修复）
// ============================================================
// 缺陷：本套件把 XBK_PARALLEL_ID 原样插值进 `xianbaoku_cache_p${ID}` 再 path.join(__dirname, …)，
// 未校验分隔符/根内包含 ⇒ 含 `../` 的值会解析到仓库之外，而本套件有 10 处在 finally 里
// `fs.rmSync(stateDir,{recursive:true,force:true})` 清理缓存派生目录，会被劫持到仓库外递归删除。
// 生产侧 xbk_message_store.resolveCacheDirInRoot 虽有根内校验，但测试清理跑在它之前 ⇒ 校验形同虚设。
//
// ⚠️ 与 test_filter.js 的**同源代码块**（必须同步修改，锚点见本文件 :Qodo #158 同步断言）：
//    本段（正则常量 → sanitizeIsolationId → buildCacheShard 的完整定义）与 test_filter.js 的同名段
//    **代码逐字符相同**（仅注释措辞不同），并由两处断言锁死：① 本文件断言两段**源码**（剥注释后）
//    normalize 相等；② 同时断言本文件除 removeDirInRoot 与其声明的外部目标豁免外无裸递归 rmSync。
//    改一处忘改另一处，两边的门禁都会真红。
const CACHE_SHARD_ID_RE = /^[A-Za-z0-9_-]+$/

// 单层目录名硬上限（防超长环境变量造出 ENAMETOOLONG / 触发文件系统边界行为）
const CACHE_SHARD_ID_MAX = 64

// 把任意来源的 XBK_PARALLEL_ID 归一为一个**安全分片 ID**。
// 非法（空串、含 `.` `/` `\` 或其它非白名单字符、超长）一律回退到 String(process.pid)。
function sanitizeIsolationId (raw) {
  const s = raw === undefined || raw === null ? '' : String(raw)
  if (!CACHE_SHARD_ID_RE.test(s)) return String(process.pid)
  if (s.length > CACHE_SHARD_ID_MAX) return String(process.pid)
  return s
}

// 唯一的「分片目录」入口（最末兜底 ID 取内核分配的 pid，必然通过白名单与根内校验）：白名单 + 根内校验 + 一体化返回同源三元组
// { id, dirName, cacheDir } —— 调用方必须用返回的 dirName/cacheDir 去设 Config.cache.dir 与
// 环境变量，禁止各自重新拼一遍（否则会出现「生产写 A、测试断言 B」的分裂）。
// 注：本函数是 `require(path)` 参数的接收者（不做模块级 require），既便于回归用例反复构造，
// 也让 lint/static analysis 不把 `path` 当成被遮蔽的全局。
function buildCacheShard (rawId, root, pathMod) {
  const rootAbs = pathMod.resolve(root)
  const id = sanitizeIsolationId(rawId)
  const dirName = `xianbaoku_cache_p${id}`
  const cacheDir = pathMod.join(rootAbs, dirName)
  // ② 根内校验：resolve 后必须以 rootAbs + sep 起头，且不等于 rootAbs 本身。
  // 用 path.resolve（词法规范化）而非 realpath：本套件的删除目标是自己刚构造的**新**目录，
  // 越界向量只有 `..`（词法即可完全覆盖）；而 realpath 会把「仓库本身位于符号链接路径下」
  // 这类合法部署判成越界，反而制造 fail-open（回退到共享目录）或误红。
  const resolved = pathMod.resolve(cacheDir)
  if (resolved !== rootAbs && resolved.startsWith(rootAbs + pathMod.sep)) {
    return { id, dirName, cacheDir }
  }
  // 白名单下不可达；一旦可达说明拼接逻辑本身被改坏了——此时回退到 pid（仍根内），
  // 并在 stderr 留痕，绝不返回越界路径。
  const fallbackId = String(process.pid)
  const fallbackDirName = `xianbaoku_cache_p${fallbackId}`
  const fallbackCacheDir = pathMod.join(rootAbs, fallbackDirName)
  console.warn(`[test_filter] 分片目录越出仓库根，已回退 pid 分片：raw=${JSON.stringify(rawId)} → ${fallbackDirName}`)
  return { id: fallbackId, dirName: fallbackDirName, cacheDir: fallbackCacheDir }
}

const PARALLEL_ID = sanitizeIsolationId(process.env.XBK_PARALLEL_ID)
process.env.XBK_PARALLEL_ID = PARALLEL_ID
const DEFAULT_CACHE_DIR = `xianbaoku_cache_p${PARALLEL_ID}`
const CACHE_DIR = path.join(__dirname, DEFAULT_CACHE_DIR)

// Qodo #158 回归用的根内断言（与 test_filter.js 的 assertPathInRoot 同语义、无返回值）
function assertPathInRoot (targetPath, root, msg) {
  const rootAbs = path.resolve(root)
  const t = path.resolve(targetPath)
  assert(t !== rootAbs && t.startsWith(rootAbs + path.sep),
    msg || `路径必须位于仓库根之内：${t} 不在 ${rootAbs}${path.sep} 之下`)
  return t
}

// 收敛后的**唯一**递归删除入口（与 test_filter.js 同源、同语义）：先校验后删除。
// 传入路径必须已由 buildCacheShard 产出或由用例在根内字面量构造；越界即抛错（fail-closed）。
// 唯一声明的豁免是 :3737 的局部 removePath（目标含 os.tmpdir() 下的仓库外夹具），见其处注释。
function removeDirInRoot (targetPath, root) {
  const rootAbs = path.resolve(root)
  const p = path.resolve(targetPath)
  if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) {
    throw new Error(`拒绝递归删除仓库根之外的路径（fail-closed）：${p}`)
  }
  fs.rmSync(p, { recursive: true, force: true })
  return p
}

// ---------- 工具 ----------
let passed = 0; let failed = 0
// v3.276（EXEC-D T10）：跳过数与实跑数单独计数——只靠 passed 无法区分「真跑了」与「被过滤跳过」
// （跳过同样计入 passed，故 passed 恒等于用例总数），门禁就写不出「过滤确实生效」的可证伪断言。
let skipped = 0; let executed = 0
const errors = []

// v3.122：支持 --only=子串（并行调度用：只跑匹配测试，其余跳过不计失败）
// v3.276（EXEC-D T10）：同时支持 `--only=<子串>` 与 `--only <子串>` 两种写法。
// 旧实现用 process.argv.indexOf('--only') 定位，`=` 写法下没有独立的 '--only' 元素 → 返回 -1 →
// 过滤静默失效、照跑全部用例（实测：`--only=FX3` 仍在跑全量，被 timeout 掐断）。
// 危害被放大在「最需要快速定位的时刻」：test_app_p.js 并行失败时打印的定位提示正是
// `--only=<测试名子串>`，用户照做却触发全量重跑。
// 支持环境变量 QUICK=1（快测模式：pushInterval/finalWait 置 0，加速非 timing 测试）
const onlyFilter = (() => {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--only=')) {
      // 空值（--only=）与旧实现 `--only ''` 同口径：视为未指定过滤，不得静默变成「匹配一切」
      return argv[i].slice('--only='.length) || null
    }
    if (argv[i] === '--only') return argv[i + 1] ?? null
  }
  return null
})()
// v3.172：并行调度精确名单——--list-file=<json数组文件>，只跑名单内的测试（与 --only 子串互补，
// 避免 --only 子串重叠/漏跑；worker 由 test_app_p.js 分片生成）
let nameSet = null
{
  const lfIdx = process.argv.indexOf('--list-file')
  if (lfIdx >= 0) {
    try { nameSet = new Set(JSON.parse(fs.readFileSync(process.argv[lfIdx + 1], 'utf8'))) } catch (e) { console.error('--list-file 解析失败:', e.message); process.exit(2) }
  }
}
if (process.env.QUICK === '1') {
  Config.timing.pushInterval = 0
  Config.timing.finalWait = 0
}

async function test (name, fn) {
  if (onlyFilter && !name.includes(onlyFilter)) { skipped++; passed++; return } // 跳过（并行调度用）
  if (nameSet && !nameSet.has(name)) { skipped++; passed++; return } // v3.172：名单外跳过（并行分片）
  executed++ // v3.276（EXEC-D T10）：真正进入 fn() 的用例数（passed 含跳过，无法反映过滤是否生效）
  const t0 = Date.now() // v3.122：耗时统计（识别慢测试供并行调度）
  try {
    await fn()
    passed++
    const ms = Date.now() - t0
    console.log(`  ✅ ${name}${ms > 100 ? `  (${(ms / 1000).toFixed(1)}s)` : ''}`)
  } catch (e) {
    failed++
    errors.push(`${name}: ${e.message}`)
    console.log(`  ❌ ${name}  (${e.message})`)
  }
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

// Qodo PR #158 回归用：与 test_filter.js 的 assertEqual / assert.strictEqual 同口径的严格相等断言。
// 单独命名（assertEqualStr/Num）以免与上面的布尔断言 assert 混淆，也不引入 node:assert。
function assertEqualStr (actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `期望=${expected}, 实际=${actual}`)
}
function assertEqualNum (actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `期望=${expected}, 实际=${actual}`)
}

function setPushUrl (suffix) {
  // 覆盖 getter，让每个测试用独立缓存文件，避免 _memoryCache 状态污染
  Object.defineProperty(Config.api, 'pushUrl', {
    value: `https://test.local/plus/json/${suffix}.json`,
    configurable: true,
    writable: true
  })
  // 清理该测试可能残留的旧缓存文件（持久化文件会跨进程留存）
  try { fs.unlinkSync(path.join(CACHE_DIR, `${suffix}.json`)) } catch (e) { /* 不存在则忽略 */ }
}

function reset () {
  gotCalls = []
  pushCalls = []
  fakeData = []
  failCount = 0
  fail4xx = false
  fail425Once = false
  failTimeout = false
  fail429Once = false
  failPlainString = false
  failNonJson = false
  failLongMsg = false
  notifyDelayMs = 0
  notifyFail = false
  notifyFailAt = -1
  notifyFailString = false
  notifyCalls = 0
  Config.filter.pingbifenlei = ''
  Config.filter.pingbibiaoti = ''
  Config.filter.pingbilouzhu = ''
  Config.keyword.zkt_gjc = ''
  // v3.91：reset 同时恢复运行配置默认值（防未来测试忘恢复导致跨测试污染）
  Config.template.title = '【{分类名}】{标题}'
  Config.template.content = '{Markdown内容}'
  Config.push.mode = 'parallel'
  Config.push.titleMax = 100
  Config.push.contentMax = 3000
  Config.domain = 'https://new.ixbk.net'
  Config.cache.maxSize = 10000
  Config.cache.dir = DEFAULT_CACHE_DIR // v3.172：并行 worker 恢复各自独立目录（曾硬编码 'xianbaoku_cache'）
  Config.storage.minFreeBytes = 50 * 1024 * 1024
  // R3-1：api 配置也恢复默认（t51 等会改 api.retry/timeout，漏恢复会污染后续测试）
  Config.api.timeout = 5000
  Config.api.retry = 2
  // v3.140：告警/日报默认关闭——预期失败测试(4xx/超时)触发告警、跨天时成功 run 触发日报，
  // 都会污染 pushCalls 断言（t56/t57 显式开启）
  Config.alert.enabled = false
  Config.report.enabled = false
  Config.diagnostics.filterLog.enabled = true
  Config.diagnostics.filterLog.maxDetailsPerRun = 100
  Config.diagnostics.filterLog.includePassed = false
}

function readCacheFile (suffix) {
  const p = path.join(CACHE_DIR, `${suffix}.json`)
  if (!fs.existsSync(p)) return []
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function makeItem (overrides = {}) {
  return {
    id: 1,
    catename: '微博线报',
    title: '京东神券 100元',
    content: '限时抢购内容',
    content_html: '<b>京东神券 100元</b>秒杀',
    url: '/weibo/1.html',
    ...overrides
  }
}

console.log('\n========================================')
console.log('  🧪 App.run 集成测试（mock got/notify）')
console.log('========================================\n');

(async () => {
// ==================== 1. 正常主流程 ====================
  console.log('📂 1. 正常主流程')
  reset()
  setPushUrl('t01_normal')

  await test('拉取→推送完整链路：新数据全部推送', async () => {
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' }), makeItem({ id: 3, title: '拼多多砍价' })]
    const summary = await xbk.run()
    // run() 返回摘要契约：total/dedup/filtered/pushed/failed
    assert(summary && summary.total === 3 && summary.dedup === 0 && summary.filtered === 0 &&
        summary.pushed === 3 && summary.failed === 0,
        `摘要错误: ${JSON.stringify(summary)}`)
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}`)
    // text 格式：【分类名】标题
    assert(pushCalls[0].text === '【微博线报】京东神券 100元', `text格式错误: ${pushCalls[0].text}`)
    // desp 为 Markdown 内容（来自 content_html）
    assert(pushCalls[0].desp.includes('原文链接'), 'desp 应含原文链接')
    assert(pushCalls[0].desp.includes('京东神券 100元'), 'desp 应含 content_html 内容')
    assert(pushCalls[0].desp.includes('**京东神券 100元**'), 'desp 应含 Markdown 粗体转换结果（v3.90 锁定 htmlToMarkdown 真实链路）')
    // 新数据写入缓存
    const cached = readCacheFile('t01_normal')
    assert(cached.length === 3, `缓存应有3条，实际${cached.length}`)
    // 缓存保持原始顺序（变异 newMessages.unshift 会倒序写入）
    assert(cached[0].id === 1 && cached[1].id === 2 && cached[2].id === 3,
        `缓存顺序错误: ${cached.map(m => m.id).join(',')}`)
  })

  await test('已有缓存数据 → 去重不推送', async () => {
    reset()
    setPushUrl('t02_dedup')
    // 预置缓存（直接写文件，未经过内存缓存）
    fs.writeFileSync(path.join(CACHE_DIR, 't02_dedup.json'), JSON.stringify([makeItem({ id: 1 })]))
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '新数据' })]
    await xbk.run()
    assert(pushCalls.length === 1, `应只推新数据1条，实际${pushCalls.length}`)
    assert(pushCalls[0].text.includes('新数据'), '推送的应是新数据')
  })

  await test('空数据 → 不推送不崩溃', async () => {
    reset()
    setPushUrl('t03_empty')
    fakeData = []
    await xbk.run()
    assert(pushCalls.length === 0, '空数据不应推送')
  })

  await test('过滤诊断：跨运行追加屏蔽原因与保护记录', async () => {
    reset()
    setPushUrl('t03_filter_diagnostics')
    const logPath = path.join(CACHE_DIR, 'filter-diagnostics.ndjson')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    try {
      Config.filter.pingbibiaoti = '屏蔽词'
      Config.filter.zhanxianlouzhu = 'VIP'
      Config.diagnostics.filterLog.includePassed = false
      fakeData = [
        makeItem({ id: 'diag-blocked', title: '屏蔽词优惠', louzhu: '普通用户' }),
        makeItem({ id: 'diag-protected', title: '屏蔽词优惠', louzhu: 'VIP' })
      ]
      await xbk.run()
      await xbk.run()
      const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert(records.filter(record => record.type === 'run').length === 2, '两轮运行应写入两条汇总记录')
      const blocked = records.find(record => record.type === 'item' && record.id === 'diag-blocked')
      assert(blocked && blocked.decision === 'filtered', '屏蔽条目应写入诊断文件')
      assert(blocked.reason.configKey === 'pingbibiaoti' && blocked.reason.rule === '屏蔽词', `屏蔽原因不正确: ${JSON.stringify(blocked)}`)
      const protectedItem = records.find(record => record.type === 'item' && record.id === 'diag-protected')
      assert(protectedItem && protectedItem.decision === 'passed', '被保护条目应写入诊断文件')
      assert(protectedItem.protections.some(entry => entry.configKey === 'zhanxianlouzhu'), '应记录楼主强制展现')
      assert(protectedItem.skipped.some(entry => entry.configKey === 'pingbibiaoti'), '应记录跳过的标题屏蔽')
    } finally {
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('dry-run：接口失败时不发送告警通知', async () => {
    reset()
    setPushUrl('t03a_dry_run_fetch_error')
    const previousDryRun = process.env.XBK_DRY_RUN
    const alertState = path.join(CACHE_DIR, 'alert.state')
    try {
      process.env.XBK_DRY_RUN = '1'
      Config.alert.enabled = true
      Config.alert.intervalMs = 0
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 接口失败仍应向调用方暴露 */ }
      assert(pushCalls.length === 0, `dry-run 接口失败不得发送告警，实际 ${pushCalls.length} 次`)
      assert(!fs.existsSync(alertState), 'dry-run 接口失败不得写入告警状态')
    } finally {
      fail4xx = false
      Config.alert.enabled = false
      if (previousDryRun === undefined) delete process.env.XBK_DRY_RUN
      else process.env.XBK_DRY_RUN = previousDryRun
      try { fs.unlinkSync(alertState) } catch (e) { /* 忽略 */ }
    }
  })

  await test('dry-run：预览不发送、不写成功缓存或日报', async () => {
    reset()
    setPushUrl('t03b_dry_run_preview')
    const previousDryRun = process.env.XBK_DRY_RUN
    const reportState = path.join(CACHE_DIR, 'report.state')
    const cachePath = path.join(CACHE_DIR, 't03b_dry_run_preview.json')
    const logs = []
    const originalLog = console.log
    try {
      process.env.XBK_DRY_RUN = '1'
      Config.alert.enabled = true
      Config.report.enabled = true
      fakeData = [makeItem({ id: 'dry-run-preview' })]
      console.log = (...args) => logs.push(args.join(' '))
      const summary = await xbk.run()
      assert(summary && summary.pushed === 0 && summary.failed === 0, `dry-run 摘要不应伪造推送: ${JSON.stringify(summary)}`)
      assert(pushCalls.length === 0, `dry-run 不得调用通知通道，实际 ${pushCalls.length} 次`)
      assert(readCacheFile('t03b_dry_run_preview').length === 0, 'dry-run 不得写入成功消息缓存')
      assert(!fs.existsSync(reportState), 'dry-run 不得写入日报状态')
      assert(logs.some(line => line.includes('🧪 预览：')), 'dry-run 应输出预览内容')
    } finally {
      console.log = originalLog
      Config.alert.enabled = false
      Config.report.enabled = false
      if (previousDryRun === undefined) delete process.env.XBK_DRY_RUN
      else process.env.XBK_DRY_RUN = previousDryRun
      try { fs.unlinkSync(cachePath) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(reportState) } catch (e) { /* 忽略 */ }
    }
  })

  // ==================== 1.1 #140 app 可观测性回归（评审 #143-3） ====================
  // #140 改了 xbk_app 的 dry-run 台账、告警版本注入、身份无效对账与 stdout 回显清洗，
  // 但当时没有对应断言——下面四条锁住这些行为，防止「改了没人发现」。
  console.log('\n📂 1.1 #140 app 可观测性回归（评审 #143-3）')

  await test('dry-run：终端「未推送」文案与 run.log 台账口径一致（APP2-04）', async () => {
    reset()
    setPushUrl('t03c_dry_run_account')
    const previousDryRun = process.env.XBK_DRY_RUN
    const logPath = path.join(CACHE_DIR, 'run.log')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    const logs = []
    const originalLog = console.log
    try {
      process.env.XBK_DRY_RUN = '1'
      fakeData = [makeItem({ id: 'dry-run-account-1' }), makeItem({ id: 'dry-run-account-2', title: '第二条' })]
      console.log = (...args) => logs.push(args.join(' '))
      const summary = await xbk.run()
      assert(summary && summary.pushed === 0 && summary.failed === 0,
        `dry-run 摘要必须 pushed=0/failed=0: ${JSON.stringify(summary)}`)
      assert(logs.some(line => line.includes('推送:') && line.includes('dry-run 未推送 2 条')),
        `终端应显示未推送条数: ${logs.filter(l => l.includes('推送:')).join(' | ')}`)
      assert(!logs.some(line => line.includes('条失败，下次运行重试')), 'dry-run 不得共用真实失败文案')
      const lastLine = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop()
      assert(/\sfailed=0\s/.test(` ${lastLine} `), `dry-run run.log 的 failed 应为 0: ${lastLine}`)
      assert(lastLine.includes('dry-run未推送=2'), `run.log 应另记未推送条数: ${lastLine}`)
    } finally {
      console.log = originalLog
      if (previousDryRun === undefined) delete process.env.XBK_DRY_RUN
      else process.env.XBK_DRY_RUN = previousDryRun
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP-06：单条渲染异常不再中止整轮（按单条失败处理并继续其余条目）', async () => {
    reset()
    setPushUrl('t03e_render_fail')
    const previousDryRun = process.env.XBK_DRY_RUN
    const logPath = path.join(CACHE_DIR, 'run.log')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    const logs = []
    const originalLog = console.log
    let previewCalls = 0
    try {
      // dry-run 的 preview() 位于渲染段末端：把它做成可注入故障，等价于「渲染期抛错」
      process.env.XBK_DRY_RUN = '1'
      fakeData = [makeItem({ id: 'render-fail-1' }), makeItem({ id: 'render-fail-2', title: '第二条' })]
      console.log = (...args) => {
        const line = args.join(' ')
        if (line.startsWith('🧪 预览')) {
          previewCalls++
          throw new Error('render boom')
        }
        logs.push(line)
      }
      const summary = await xbk.run()
      assert(previewCalls === 2, `渲染异常不得中止整轮：两条都应走到预览，实际 ${previewCalls} 条`)
      assert(summary && summary.failures.length === 2, `渲染异常应按单条失败计入摘要，实际 ${JSON.stringify(summary && summary.failures)}`)
      assert(summary.pushed === 0 && summary.failed === 0, `dry-run 摘要口径不变: ${JSON.stringify(summary)}`)
      assert(logs.some(l => l.includes('内容渲染异常')), '渲染异常应有明确的失败日志')
    } finally {
      console.log = originalLog
      if (previousDryRun === undefined) delete process.env.XBK_DRY_RUN
      else process.env.XBK_DRY_RUN = previousDryRun
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(path.join(CACHE_DIR, 't03e_render_fail.json')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('身份无效条目单独对账（APP-04：终端 + run.log noidentity=）', async () => {
    reset()
    setPushUrl('t03d_no_identity')
    const logPath = path.join(CACHE_DIR, 'run.log')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    const logs = []
    const originalLog = console.log
    try {
      // 通过 isValidItem（对象）但 getMessageIdentity 判无效：无 id/有效 url 且身份来源字段全空
      // （anonKey 退化成固定键 → 显式判无效，避免所有无标识消息互相吞掉）
      fakeData = [{ title: '' }, makeItem({ id: 'noidentity-keep' })]
      console.log = (...args) => logs.push(args.join(' '))
      const summary = await xbk.run()
      assert(summary && summary.total === 2 && summary.pushed === 1,
        `身份无效条目仍应计入 total，正常条目应推送: ${JSON.stringify(summary)}`)
      assert(logs.some(line => line.includes('身份无效:') && line.includes('1 条')),
        `终端应单独统计身份无效条目: ${logs.filter(l => l.includes('身份无效')).join(' | ')}`)
      const lastLine = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop()
      assert(lastLine.includes('noidentity=1'), `run.log 应记录 noidentity=1: ${lastLine}`)
    } finally {
      console.log = originalLog
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('告警留痕使用注入的 PKG_VERSION（APP-01）', async () => {
    reset()
    setPushUrl('t03e_alert_version')
    const origAlert = Config.alert.enabled
    const origInterval = Config.alert.intervalMs
    const logPath = path.join(CACHE_DIR, 'run.log')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    // 防上一用例遗留的告警限频状态吞掉本次告警
    try { fs.unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 0
      notifyFailAt = 1 // 第 1 次主推送失败触发告警，第 2 次（告警）成功
      fakeData = [makeItem({ id: 'alert-version-1' })]
      await xbk.run()
      const log = fs.readFileSync(logPath, 'utf8')
      const pkgVersion = require('./package.json').version
      assert(log.includes(`ALERT [v${pkgVersion}]`),
        `告警留痕应带注入的 PKG_VERSION(v${pkgVersion})：${log.split('\n').filter(l => l.includes('ALERT')).join(' | ')}`)
      assert(!log.includes('[vundefined]'), '不得回落到 undefined 版本（缺 package.json 的部署场景）')
    } finally {
      Config.alert.enabled = origAlert
      Config.alert.intervalMs = origInterval
      notifyFailAt = -1
      try { fs.unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('stdout 回显清洗控制字符，防伪造日志行（APP2-07）', async () => {
    reset()
    setPushUrl('t03f_log_control_chars')
    const logs = []
    const originalLog = console.log
    try {
      // 接口脏数据：标题含换行/TAB/ANSI ESC——按行解析日志的青龙侧会被伪造出额外日志行
      fakeData = [makeItem({ id: 'ctl-1', title: '前段\n伪造行\t尾段\u001b[31m红' })]
      console.log = (...args) => logs.push(args.join(' '))
      await xbk.run()
      const itemLine = logs.find(l => l.includes('发现到新数据'))
      assert(itemLine, `应输出「发现到新数据」回显行: ${logs.slice(0, 5).join(' | ')}`)
      assert(!itemLine.includes('\n') && !itemLine.includes('\t') && !itemLine.includes('\u001b'),
        `回显行不得含控制字符: ${JSON.stringify(itemLine)}`)
      assert(itemLine.includes('前段 伪造行 尾段'), '控制字符应被替换为空格而非删除内容')
    } finally {
      console.log = originalLog
    }
  })

  await test('过滤诊断：只看它未命中写入白名单原因', async () => {
    reset()
    setPushUrl('t03_filter_diagnostics_keyword')
    const logPath = path.join(CACHE_DIR, 'filter-diagnostics.ndjson')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    try {
      Config.keyword.zkt_gjc = '仅保留'
      fakeData = [makeItem({ id: 'diag-keyword', title: '不匹配标题' })]
      await xbk.run()
      const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const blocked = records.find(record => record.type === 'item' && record.id === 'diag-keyword')
      assert(blocked && blocked.decision === 'filtered', '只看它未命中应写入屏蔽记录')
      assert(blocked.reason.configKey === 'zkt_gjc' && blocked.reason.kind === 'whitelist', `只看它原因不正确: ${JSON.stringify(blocked)}`)
    } finally {
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('过滤诊断：字符串 false 不记录普通放行条目', async () => {
    reset()
    setPushUrl('t03_filter_diagnostics_string_false')
    const logPath = path.join(CACHE_DIR, 'filter-diagnostics.ndjson')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    try {
      Config.diagnostics.filterLog.includePassed = 'false'
      fakeData = [makeItem({ id: 'diag-string-false', title: '普通放行条目' })]
      await xbk.run()
      const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert(records.some(record => record.type === 'run'), '应写入本轮汇总')
      assert(!records.some(record => record.type === 'item' && record.id === 'diag-string-false'), '字符串 false 不应记录普通放行条目')
    } finally {
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('过滤诊断：明细截断不影响汇总原因计数', async () => {
    reset()
    setPushUrl('t03_filter_diagnostics_summary')
    const logPath = path.join(CACHE_DIR, 'filter-diagnostics.ndjson')
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    try {
      Config.filter.pingbibiaoti = '屏蔽词'
      Config.diagnostics.filterLog.maxDetailsPerRun = 1
      fakeData = Array.from({ length: 3 }, (_, index) => makeItem({ id: `diag-summary-${index}`, title: '屏蔽词优惠' }))
      await xbk.run()
      const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const run = records.find(record => record.type === 'run')
      assert(run.detailCount === 1, `明细应按上限截断: ${JSON.stringify(run)}`)
      assert(run.byReason['title.block.pingbibiaoti'] === 3, `汇总必须统计全部屏蔽项: ${JSON.stringify(run)}`)
    } finally {
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    }
  })

  // ==================== 2. 字段归一化 ====================
  console.log('\n📂 2. 字段归一化')

  await test('category_name 自动映射为 catename（过滤/推送用同一个值）', async () => {
    reset()
    setPushUrl('t04_norm')
    fakeData = [{ id: 1, category_name: '测试分类', category_id: '42', title: '归一化测试', content: '内容', url: '/x/1.html' }]
    await xbk.run()
    assert(pushCalls.length === 1, '应推1条')
    assert(pushCalls[0].text === '【测试分类】归一化测试', `分类未归一化: ${pushCalls[0].text}`)
  })

  await test('category_id 自动映射为 cateid（{分类ID} 占位符生效）', async () => {
    reset()
    setPushUrl('t45_cateid')
    fakeData = [{ id: 1, category_id: '42', category_name: '测试', title: '分类ID测试', content: 'x', url: '/c/1.html' }]
    await xbk.run()
    assert(pushCalls.length === 1, '应推1条')
    // {分类ID} 只出现在自定义模板里；通过 tuisong_replace 直接验证映射
    const { tuisong_replace } = xbk
    const r = tuisong_replace('ID:{分类ID}', { category_id: '42' })
    assert(r === 'ID:42', `category_id 应映射为 cateid: ${r}`)
  })

  // ==================== 3. 批内去重 ====================
  console.log('\n📂 3. 批内去重')

  await test('同一批数据重复 id → 只收录1条', async () => {
    reset()
    setPushUrl('t05_batch_dup')
    fakeData = [makeItem({ id: 9 }), makeItem({ id: 9, title: '重复项' })]
    await xbk.run()
    assert(pushCalls.length === 1, `同id应只推1条，实际${pushCalls.length}`)
  })

  await test('同一批重复 url（无id）→ 只收录1条', async () => {
    reset()
    setPushUrl('t06_url_dup')
    fakeData = [
      { url: '/u/1.html', catename: 'a', title: 'A', content: 'c' },
      { url: '/u/1.html', catename: 'a', title: 'A2', content: 'c' }
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `同url应只推1条，实际${pushCalls.length}`)
  })

  await test('批内 id-ful 与无 id 同 url → 只收录1条（v3.176 修复#2：口径对齐）', async () => {
    reset()
    setPushUrl('t06b_mixed_dup')
    // 曾：A key='id:1'、B key='url:/m/1.html' → seenInBatch 互不可见 → 双推
    // 跨运行 _findDedupIndex 是双向 url fallback（无 id 方命中同 url），批内应与之一致
    fakeData = [
      { id: 1, url: '/m/1.html', catename: 'a', title: '有id', content: 'c' },
      { url: '/m/1.html', catename: 'a', title: '无id', content: 'c' }
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `id-ful+无id同url应只推1条，实际${pushCalls.length}`)
    const cached = readCacheFile('t06b_mixed_dup')
    assert(cached.length === 1, `缓存应只有1条，实际${cached.length}`)
  })

  await test('批内无 id 与有 id 同 url → 只收录1条（v3.176 修复#2 反向）', async () => {
    reset()
    setPushUrl('t06c_mixed_rev')
    fakeData = [
      { url: '/m/2.html', catename: 'a', title: '无id', content: 'c' },
      { id: 2, url: '/m/2.html', catename: 'a', title: '有id', content: 'c' }
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `无id在前+有id同url应只推1条，实际${pushCalls.length}`)
  })

  await test('缓存垃圾 url 不应拦截新有效 id 消息', async () => {
    reset()
    setPushUrl('t06e_empty_url_cache')
    fs.writeFileSync(path.join(CACHE_DIR, 't06e_empty_url_cache.json'), JSON.stringify([
      { url: '#', title: '旧垃圾 URL', content: 'old' }
    ]))
    fakeData = [{ id: 123, url: '#', catename: 'a', title: '新有效 ID', content: 'new' }]
    await xbk.run()
    assert(pushCalls.length === 1, `新有效 id 消息不应被垃圾 URL 判重，实际推送${pushCalls.length}条`)
    const summary = await xbk.run()
    assert(summary.pushed === 0 && summary.dedup === 1, `第二次应只按有效 id 去重: ${JSON.stringify(summary)}`)
  })

  await test('垃圾 url（#/?x=1）归一为空 → anonKey 化不互判重（v3.176 修复#5）', async () => {
    reset()
    setPushUrl('t06d_garbage_url')
    // 曾：normUrl('#')=normUrl('?x=1')='' → 两条 key 均为 'url:' 互判为同一资源 → 后者静默丢弃
    fakeData = [
      { url: '#', catename: 'a', title: '垃圾A', content: '内容A' },
      { url: '?x=1', catename: 'a', title: '垃圾B', content: '内容B' }
    ]
    await xbk.run()
    assert(pushCalls.length === 2, `两条不同内容垃圾url应全推，实际${pushCalls.length}`)
    // 跨运行：anonKey 稳定 → 下次全去重（不重复推送）
    reset()
    setPushUrl('t06d_garbage_url')
    fakeData = [
      { url: '#', catename: 'a', title: '垃圾A', content: '内容A' },
      { url: '?x=1', catename: 'a', title: '垃圾B', content: '内容B' }
    ]
    const s2 = await xbk.run()
    assert(s2.pushed === 0 && s2.dedup === 2, `二次应全去重: ${JSON.stringify(s2)}`)
  })

  await test('批内无id非字符串 url → 不得误判重，改走匿名身份（v3.228）', async () => {
    reset()
    setPushUrl('t06e_invalid_url_type')
    fakeData = [
      { url: {}, catename: 'a', title: '对象URL-A', content: '内容A' },
      { url: {}, catename: 'a', title: '对象URL-B', content: '内容B' }
    ]
    const summary = await xbk.run()
    assert(summary && summary.dedup === 0 && summary.pushed === 2,
        `非字符串 URL 不应把不同匿名消息判重: ${JSON.stringify(summary)}`)
    assert(pushCalls.length === 2, `两条不同消息都应推送，实际${pushCalls.length}`)
    assert(readCacheFile('t06e_invalid_url_type').length === 2, '两条消息都应进入缓存')
  })

  await test('标题屏蔽规则 → 命中数据不推送', async () => {
    reset()
    setPushUrl('t07_filter')
    Config.filter.pingbibiaoti = '京东'
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })]
    await xbk.run()
    assert(pushCalls.length === 1, `应只推淘宝1条，实际${pushCalls.length}`)
    assert(pushCalls[0].text.includes('淘宝'), '推送的应是淘宝')
  })

  await test('分类屏蔽规则 → 命中分类不推送', async () => {
    reset()
    setPushUrl('t08_cat')
    Config.filter.pingbifenlei = '赚客吧'
    fakeData = [makeItem({ id: 1, catename: '赚客吧' }), makeItem({ id: 2, catename: '微博线报' })]
    await xbk.run()
    assert(pushCalls.length === 1, `应只推微博1条，实际${pushCalls.length}`)
  })

  // ==================== 5. 只看它过滤 ====================
  console.log('\n📂 5. 只看它过滤')

  await test('zkt_gjc 关键词 → 只推送标题匹配的', async () => {
    reset()
    setPushUrl('t09_kwd')
    Config.keyword.zkt_gjc = '京东'
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })]
    await xbk.run()
    assert(pushCalls.length === 1, `应只推京东1条，实际${pushCalls.length}`)
    assert(pushCalls[0].text.includes('京东'), '推送的应是京东')
  })

  await test('zkt_gjc + frozen item → 不抛错（C041）', async () => {
    reset()
    setPushUrl('t09b_kwd_frozen')
    Config.keyword.zkt_gjc = '京东'
    fakeData = [
      makeItem({ id: 1, title: '京东神券' }),
      Object.freeze(makeItem({ id: 2, title: '淘宝特价' }))
    ]
    let crashed = false
    try { await xbk.run() } catch (e) { crashed = true }
    assert(!crashed, `frozen item + zkt_gjc 不应抛错: ${crashed}`)
    assert(pushCalls.length === 1, `应只推京东1条，实际${pushCalls.length}`)
    assert(pushCalls[0].text.includes('京东'), '推送的应是京东')
  })

  // ==================== 6. fetchData 重试 ====================
  console.log('\n📂 6. fetchData 重试')

  await test('5xx 失败一次后重试成功 → 共请求2次', async () => {
    reset()
    setPushUrl('t10_retry')
    failCount = 1 // 第一次失败，第二次成功
    fakeData = [makeItem({ id: 1 })]
    await xbk.run()
    assert(gotCalls.length === 2, `应请求2次，实际${gotCalls.length}`)
    assert(pushCalls.length === 1, '重试成功后应推送')
  })

  await test('4xx 客户端错误 → 不重试直接失败，不崩溃', async () => {
    reset()
    setPushUrl('t11_4xx')
    fail4xx = true
    let crashed = false
    try {
      await xbk.run()
    } catch (e) {
      crashed = true
    }
    // 修复后 run() 重新抛出，让 cron/调度感知失败
    assert(crashed, '4xx 应抛出异常（不再静默吞错）')
    assert(gotCalls.length === 1, `4xx 不应重试，实际请求${gotCalls.length}次`)
    assert(pushCalls.length === 0, '4xx 不应推送')
  })

  await test('425 Too Early → 重试成功（P2：fetchData 与 failure_policy RETRYABLE_CODES 收敛）', async () => {
    reset()
    setPushUrl('t425_retry')
    fail425Once = true // 第一次 425，第二次成功
    fakeData = [makeItem({ id: 1 })]
    await xbk.run()
    assert(gotCalls.length === 2, `425 应重试，实际请求${gotCalls.length}次`)
    assert(pushCalls.length === 1, '425 重试成功后应推送')
  })

  // ==================== 7. 组合场景 ====================
  console.log('\n📂 7. 组合场景')

  await test('去重+过滤+只看它 三合一完整链路', async () => {
    reset()
    setPushUrl('t12_combo')
    Config.filter.pingbibiaoti = '屏蔽词'
    Config.keyword.zkt_gjc = '京东'
    fakeData = [
      makeItem({ id: 1, title: '京东神券' }), // 通过
      makeItem({ id: 2, title: '屏蔽词内容' }), // 标题屏蔽
      makeItem({ id: 3, title: '淘宝特价' }), // 只看它过滤
      makeItem({ id: 1, title: '重复京东' }) // 批内去重
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `应只推1条，实际${pushCalls.length}`)
    assert(pushCalls[0].text.includes('京东神券'), '应推 id=1')
  })

  // ==================== 7.5 无标识数据去重 ====================
  console.log('\n📂 7.5 无标识数据去重')

  await test('批内多条无id无url → 全部推送（修复前 "url:undefined" 误判重复）', async () => {
    reset()
    setPushUrl('t16_anon')
    fakeData = [
      { catename: 'a', title: '无标识1', content: 'x' },
      { catename: 'a', title: '无标识2', content: 'y' },
      { catename: 'a', title: '无标识3', content: 'z' }
    ]
    await xbk.run()
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}`)
  })

  await test('批内无id同url重复 → 只推1条（url fallback 生效）', async () => {
    reset()
    setPushUrl('t17_urlfb')
    fakeData = [
      { url: '/u/1.html', catename: 'a', title: 'A', content: 'x' },
      { url: '/u/1.html', catename: 'a', title: 'A2', content: 'y' },
      { url: '/u/2.html', catename: 'a', title: 'B', content: 'z' }
    ]
    await xbk.run()
    assert(pushCalls.length === 2, `应推2条(A+B)，实际${pushCalls.length}`)
  })

  // ==================== 7.6 keyword 非法正则 ====================
  console.log('\n📂 7.6 keyword 非法正则')

  await test('zkt_gjc 非法正则 → 警告并不过滤，继续推送（v3.16审查2.1）', async () => {
    reset()
    setPushUrl('t18_badkw')
    Config.keyword.zkt_gjc = '[' // 未闭合字符类 = 非法正则
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' })]
    let crashed = false
    try { await xbk.run() } catch (e) { crashed = true }
    assert(!crashed, '不应崩溃')
    // 非法正则时 items 不过滤，全部推送
    assert(pushCalls.length === 2, `应推2条，实际${pushCalls.length}`)
  })

  await test('zkt_gjc 合法正则 → 正常过滤（行为不受影响）', async () => {
    reset()
    setPushUrl('t19_okkw')
    Config.keyword.zkt_gjc = '京东'
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })]
    await xbk.run()
    assert(pushCalls.length === 1, `应只推京东1条，实际${pushCalls.length}`)
  })

  await test('推送部分失败 → 只缓存推送成功的（v3.18审查Bug1）', async () => {
    reset()
    setPushUrl('t20_partial')
    notifyFailAt = 2 // 第2次推送失败
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '失败这条' }), makeItem({ id: 3, title: '过滤掉' })]
    Config.filter.pingbibiaoti = '过滤掉'
    const summary = await xbk.run()
    // 摘要应正确区分：3 获取、1 过滤、1 成功、1 失败
    assert(summary && summary.total === 3 && summary.dedup === 0 && summary.filtered === 1 &&
        summary.pushed === 1 && summary.failed === 1,
        `摘要错误: ${JSON.stringify(summary)}`)
    assert(pushCalls.length === 1, `应成功推1条，实际${pushCalls.length}`)
    // 缓存: 成功推送的 id=1 + 被过滤的 id=3（id=2 失败不缓存）
    const cached = readCacheFile('t20_partial')
    const ids = cached.map(m => m.id).sort()
    assert(ids.join(',') === '1,3', `缓存应为[1,3]，实际[${ids}]`)
  })

  await test('匿名数据（无id无url）跨运行去重（v3.18审查Bug2：合成id）', async () => {
    reset()
    setPushUrl('t21_anon_rerun')
    fakeData = [{ title: '匿名甲', content: '内容A', catename: 'a' }]
    await xbk.run()
    assert(pushCalls.length === 1, '第一次运行应推送')
    // 第二次运行相同数据（title+content 相同 → 合成 id 相同 → 去重）
    reset()
    setPushUrl('t21_anon_rerun')
    fakeData = [{ title: '匿名甲', content: '内容A', catename: 'a' }]
    await xbk.run()
    assert(pushCalls.length === 0, '第二次运行相同匿名数据应去重')
    // 不同内容 → 不判重
    reset()
    setPushUrl('t21_anon_rerun')
    fakeData = [{ title: '匿名甲', content: '内容B', catename: 'a' }]
    await xbk.run()
    assert(pushCalls.length === 1, '内容不同应重新推送')
  })

  // ==================== 7.7 v3.18 第二轮审查修复 ====================
  console.log('\n📂 7.7 v3.18 第二轮审查修复')

  await test('接口返回非数组 → 抛异常且错误信息友好（v3.18二轮审查问题3）', async () => {
    for (const bad of [null, {}, { code: 500 }, 'oops']) {
      reset()
      setPushUrl('t22_bad' + String(Math.random()).slice(2, 8))
      fakeData = bad
      let crashed = false
      let msg = ''
      try { await xbk.run() } catch (e) { crashed = true; msg = e.message || '' }
      assert(crashed, `返回 ${JSON.stringify(bad).slice(0, 20)} 应抛出异常`)
      // 无校验时 for...of 也会抛错但信息晦涩（如 "is not iterable"），校验应给出友好提示
      assert(msg.includes('格式异常'), `错误信息应友好，实际: ${msg.slice(0, 60)}`)
    }
  })

  await test('匿名数据同title+content但不同时间 → 不误合并（v3.18二轮审查问题2）', async () => {
    reset()
    setPushUrl('t23_anon_time')
    fakeData = [
      { title: '活动', content: '详情', posttime: 1785346200, catename: 'a' },
      { title: '活动', content: '详情', posttime: 1785432600, catename: 'a' }
    ]
    await xbk.run()
    assert(pushCalls.length === 2, `不同posttime应推2条，实际${pushCalls.length}`)
  })

  await test('匿名数据同title+content+posttime → 合并去重', async () => {
    reset()
    setPushUrl('t24_anon_same')
    fakeData = [
      { title: '活动', content: '详情', posttime: 1785346200, catename: 'a' },
      { title: '活动', content: '详情', posttime: 1785346200, catename: 'a' }
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `完全相同应推1条，实际${pushCalls.length}`)
  })

  // ==================== 7.8 v3.20 审查修复 ====================
  console.log('\n📂 7.8 v3.20 审查修复')

  await test('有id无url → 推送链接不含undefined（v3.20审查1）', async () => {
    reset()
    setPushUrl('t25_nourl')
    fakeData = [{ id: 1, catename: 'a', title: '无链接数据', content: 'x' }] // 无 url
    await xbk.run()
    assert(pushCalls.length === 1, '应推送')
    assert(!pushCalls[0].text.includes('undefined'), `链接不应含undefined: ${pushCalls[0].text.slice(0, 80)}`)
    assert(!pushCalls[0].desp.includes('undefined'), 'desp 不应含 undefined')
  })

  await test('数组含非对象元素 → 跳过不崩溃（v3.20审查3）', async () => {
    reset()
    setPushUrl('t26_badelem')
    fakeData = [
      null,
      'oops',
      123,
      { id: 1, catename: 'a', title: '正常数据', content: 'x', url: '/n/1.html' }
    ]
    let crashed = false
    try { await xbk.run() } catch (e) { crashed = true }
    assert(!crashed, '非对象元素不应导致崩溃')
    assert(pushCalls.length === 1, `应只推正常数据1条，实际${pushCalls.length}`)
  })

  await test('id为null的两条不同记录 → 不误合并（v3.20审查2）', async () => {
    reset()
    setPushUrl('t27_nullid')
    fakeData = [
      { id: null, catename: 'a', title: '甲', content: 'x', url: '/u/1.html' },
      { id: null, catename: 'a', title: '乙', content: 'y', url: '/u/2.html' }
    ]
    await xbk.run()
    assert(pushCalls.length === 2, `不同url应推2条，实际${pushCalls.length}`)
  })

  // ==================== 7.9 v3.22 审查修复 ====================
  console.log('\n📂 7.9 v3.22 审查修复')

  await test('绝对URL不拼前缀（v3.22审查19）', async () => {
    reset()
    setPushUrl('t28_absurl')
    fakeData = [
      makeItem({ id: 1, url: 'https://other.com/path/1.html' }),
      makeItem({ id: 2, url: '/relative/2.html' })
    ]
    await xbk.run()
    assert(pushCalls.length === 2, '应推2条')
    // URL 在 desp(Markdown 原文链接)里：绝对 URL 原样，相对 URL 拼 domain
    assert(pushCalls[0].desp.includes('https://other.com/path/1.html'), `绝对URL不应拼前缀: ${pushCalls[0].desp.slice(0, 80)}`)
    assert(!pushCalls[0].desp.includes('new.ixbk.nethttps://'), '不应双重前缀')
    assert(pushCalls[1].desp.includes('https://new.ixbk.net/relative/2.html'), '相对URL应拼前缀')
  })

  // ==================== 7.10 审查2轮: 空白url与url形态 ====================
  console.log('\n📂 7.10 审查2轮: 空白url与url形态')

  await test('无id+空白url多条 → 全推不丢失（审查2 BugA）', async () => {
    reset()
    setPushUrl('t29_blankurl')
    fakeData = [
      { catename: 'a', title: '空白甲', content: 'x', url: ' ' },
      { catename: 'a', title: '空白乙', content: 'y', url: ' ' },
      { catename: 'a', title: '空白丙', content: 'z', url: ' ' }
    ]
    await xbk.run()
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}（修复前丢失2条）`)
  })

  await test('同资源不同url形态批内 → 判重推1条（审查2 BugB）', async () => {
    reset()
    setPushUrl('t30_urlshape')
    fakeData = [
      { catename: 'a', title: '形态甲', content: 'x', url: '/dup/1.html' },
      { catename: 'a', title: '形态乙', content: 'x', url: 'dup/1.html/' }
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `应推1条，实际${pushCalls.length}（修复前重复推送）`)
  })

  // ==================== 7.11 审查3轮: 协议与空白关键词 ====================
  console.log('\n📂 7.11 审查3轮: 协议与空白关键词')

  await test('ftp协议URL不拼前缀（审查3 A）', async () => {
    reset()
    setPushUrl('t31_ftp')
    fakeData = [makeItem({ id: 1, url: 'ftp://files.x.com/a.zip' })]
    await xbk.run()
    assert(pushCalls.length === 1, '应推送')
    assert(pushCalls[0].desp.includes('ftp://files.x.com/a.zip'), 'ftp URL 不应拼前缀')
    assert(!pushCalls[0].desp.includes('new.ixbk.netftp'), '不应拼坏')
  })

  await test('空白关键词 → 忽略过滤全推（审查3 C）', async () => {
    reset()
    setPushUrl('t32_blankkw')
    Config.keyword.zkt_gjc = ' ' // 空白关键词(合法正则但误配)
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })]
    await xbk.run()
    assert(pushCalls.length === 2, `空白关键词应忽略过滤全推，实际${pushCalls.length}`)
  })

  // ==================== 7.12 审查4轮: 429与数组元素 ====================
  console.log('\n📂 7.12 审查4轮: 429与数组元素')

  await test('429限流 → 重试不直接抛（审查4-1）', async () => {
    reset()
    setPushUrl('t33_429')
    fail429Once = true // 第一次抛 429，第二次成功
    fakeData = [makeItem({ id: 1 })]
    await xbk.run()
    assert(gotCalls.length === 2, `429 应重试，实际请求${gotCalls.length}次`)
    assert(pushCalls.length === 1, '重试成功后应推送')
  })

  await test('非 JSON 响应 → .json() 抛错重试成功（真实 got 行为）', async () => {
    reset()
    setPushUrl('t46_nonjson')
    failNonJson = true // 第一次返回非 JSON，第二次成功
    fakeData = [makeItem({ id: 1 })]
    await xbk.run()
    assert(gotCalls.length === 2, `非 JSON 应重试，实际请求${gotCalls.length}次`)
    assert(pushCalls.length === 1, '重试成功后应推送')
  })

  await test('数组元素嵌套 → 跳过不推送（审查4-3）', async () => {
    reset()
    setPushUrl('t34_arrel')
    fakeData = [
      [1, 2], // 数组元素(嵌套)
      { id: 1, catename: 'a', title: '正常', content: 'x', url: '/n/1.html' }
    ]
    await xbk.run()
    assert(pushCalls.length === 1, `数组元素应被跳过，只推正常1条，实际${pushCalls.length}`)
  })

  // ==================== 7.13 审查9轮: 空标题/非Error异常 ====================
  console.log('\n📂 7.13 审查9轮: 空标题/非Error异常')

  await test('空标题推送 → (无标题) 占位（审查9-C）', async () => {
    reset()
    setPushUrl('t35_notitle')
    fakeData = [{ id: 1, catename: 'a', title: '', content: 'x', url: '/n/1.html' }]
    await xbk.run()
    assert(pushCalls.length === 1, '应推送')
    assert(pushCalls[0].text.includes('(无标题)'), '空标题应占位')
  })

  await test('接口抛非Error(字符串) → 不崩溃（审查9-D）', async () => {
    reset()
    setPushUrl('t36_strerr')
    failPlainString = true // 每次请求抛普通字符串(非 Error)
    let crashed = false
    try { await xbk.run() } catch (e) { crashed = true }
    assert(crashed, '非 Error 异常应被捕获并重抛')
  })

  // ==================== 7.14 审查10轮: 空标题保留/URL拼接 ====================
  console.log('\n📂 7.14 审查10轮: 空标题保留/URL拼接')

  await test('只看它过滤保留空标题（审查10 #181）', async () => {
    reset()
    setPushUrl('t37_kwt')
    Config.keyword.zkt_gjc = '京东'
    fakeData = [
      { id: 1, catename: 'a', title: '', content: 'x', url: '/n/1.html' }, // 空标题应保留
      { id: 2, catename: 'a', title: '京东神券', content: 'y', url: '/n/2.html' },
      { id: 3, catename: 'a', title: '淘宝特价', content: 'z', url: '/n/3.html' } // 关键词不匹配滤掉
    ]
    await xbk.run()
    assert(pushCalls.length === 2, `空标题+京东应推2条，实际${pushCalls.length}`)
  })

  await test('相对URL拼接无双斜杠（审查10 #268）', async () => {
    reset()
    setPushUrl('t38_urljoin')
    fakeData = [
      makeItem({ id: 1, url: 'rel/no-slash.html' }), // 无前导 /
      makeItem({ id: 2, url: '/with/slash.html' }) // 有前导 /
    ]
    await xbk.run()
    assert(pushCalls.length === 2)
    assert(pushCalls[0].desp.includes('https://new.ixbk.net/rel/no-slash.html'), `相对无斜杠应补斜杠: ${pushCalls[0].desp.slice(0, 80)}`)
    assert(!pushCalls[0].desp.includes('//rel/'), '不应双斜杠')
    assert(pushCalls[1].desp.includes('https://new.ixbk.net/with/slash.html'), '有斜杠正常')
  })

  // ==================== 7.15 审查10轮批量: 推送截断 ====================
  console.log('\n📂 7.15 审查10轮批量: 推送截断')

  await test('超长标题截断（审查10 #270）', async () => {
    reset()
    setPushUrl('t39_trunc')
    fakeData = [makeItem({ id: 1, title: '超'.repeat(500), content: '内容'.repeat(5000), url: '/n/1.html' })]
    await xbk.run()
    assert(pushCalls.length === 1, '应推送')
    // 标题截断到 100，内容截断到 3000
    assert(pushCalls[0].text.length <= 150, `标题应截断: ${pushCalls[0].text.length}`)
    assert(pushCalls[0].desp.length <= 3200, `内容应截断: ${pushCalls[0].desp.length}`)
  })

  // ==================== 7.16 审查10轮: UA请求头 ====================
  console.log('\n📂 7.16 审查10轮: UA请求头')

  await test('fetchData 带 User-Agent/Accept 请求头（#165/166）', async () => {
    reset()
    setPushUrl('t40_ua')
    fakeData = [makeItem({ id: 1 })]
    // 顶部 mock 已记录 gotCalls，检查 headers
    await xbk.run()
    assert(gotCalls.length >= 1, '应发请求')
    const headers = gotCalls[0].opts && gotCalls[0].opts.headers
    assert(headers && headers['User-Agent'], '应带 User-Agent')
    assert(headers && /^xbk-push-script\/\d+\.\d+\.\d+$/.test(headers['User-Agent']),
        `UA 应含 semver 版本号: ${headers['User-Agent']}`)
    assert(headers && headers.Accept === 'application/json', '应带 Accept')
  })

  // ==================== 7.17 并行推送模式 ====================
  console.log('\n📂 7.17 并行推送模式')

  let pushSeq = 0

  async function runWithPushMode (mode, limit, data, sendFn) {
    reset()
    // 每个测试唯一缓存文件名，避免 _memoryCache 进程内缓存导致跨测试误判
    setPushUrl('tpush_' + mode + (limit || 0) + '_' + (pushSeq++) + '.json')
    Config.push.mode = mode
    Config.push.parallelLimit = limit || 0
    fakeData = data
    notifyFail = false
    notifyFailAt = -1
    if (sendFn) {
      notifyMock.sendNotify = sendFn
    }
    const summary = await xbk.run()
    const cacheName = 'tpush_' + mode + (limit || 0) + '_' + (pushSeq - 1) + '.json'
    const res = { pushed: pushCalls.length, cached: readCacheFile(cacheName).length, summary }
    // 恢复默认
    Config.push.mode = 'parallel'
    Config.push.parallelLimit = 0
    notifyMock.sendNotify = defaultNotifySend
    require.cache[notifyPath].exports = notifyMock
    return res
  }

  await test('parallel 模式: 多条全部推送+缓存（并行模式）', async () => {
    const data = [1, 2, 3, 4, 5].map(i => ({ id: i, catename: 'a', title: '并行' + i, content: 'x', url: '/p/' + i + '.html' }))
    const r = await runWithPushMode('parallel', 0, data)
    assert(r.pushed === 5, `应推5条，实际${r.pushed}`)
    assert(r.cached === 5, `缓存应5条，实际${r.cached}`)
  })

  await test('parallelLimit=2: 滑动窗口补位且不超过并发上限', async () => {
    const data = [1, 2, 3].map(i => ({ id: i, catename: 'a', title: '滑动' + i, content: 'x', url: '/slide/' + i + '.html' }))
    const starts = []
    const ends = []
    let active = 0
    let maxActive = 0
    let abortSignalSeen = false
    const origInterval = Config.timing.pushInterval
    try {
      Config.timing.pushInterval = 0
      const r = await runWithPushMode('parallel', 2, data, async (text, desp, params) => {
        abortSignalSeen = !!(params && params.signal)
        const index = Number(String(text).match(/滑动(\d+)/)[1])
        starts[index] = Date.now()
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, index === 1 ? 60 : 5))
        ends[index] = Date.now()
        active--
      })
      assert(r.summary && r.summary.pushed === 3, `自定义 sendFn 三条应全部完成: ${JSON.stringify(r.summary)}`)
      assert(r.cached === 3, `缓存应3条，实际${r.cached}`)
      assert(maxActive === 2, `并发上限应为2，实际峰值${maxActive}`)
      assert(starts[3] < ends[1], '第3条应在第1条完成前补位，必须是滑动窗口')
      assert(abortSignalSeen, 'Pusher.send 应向底层 notify 传递 AbortSignal')
    } finally {
      Config.timing.pushInterval = origInterval
    }
  })

  await test('parallelLimit=2: 兼容并发推送与缓存', async () => {
    const data = [1, 2, 3, 4].map(i => ({ id: i, catename: 'a', title: '批' + i, content: 'x', url: '/q/' + i + '.html' }))
    const r = await runWithPushMode('parallel', 2, data)
    assert(r.pushed === 4, `应推4条，实际${r.pushed}`)
    assert(r.cached === 4, `缓存应4条，实际${r.cached}`)
  })

  await test('parallelLimit=1000: 硬性上限50，并发峰值不超过50', async () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ id: i, catename: 'a', title: '上限' + i, content: 'x', url: '/cap/' + i + '.html' }))
    let active = 0
    let maxActive = 0
    const origInterval = Config.timing.pushInterval
    try {
      Config.timing.pushInterval = 0
      const r = await runWithPushMode('parallel', 1000, data, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 3))
        active--
      })
      assert(r.summary && r.summary.pushed === 60, `60条应全部完成: ${JSON.stringify(r.summary)}`)
      assert(maxActive <= 50, `并发峰值应≤50（硬性上限），实际${maxActive}`)
    } finally {
      Config.timing.pushInterval = origInterval
    }
  })

  await test('parallelLimit=2.5(小数) → 取整为2，正常推送无空批', async () => {
    const data = [1, 2, 3, 4, 5].map(i => ({ id: i, catename: 'a', title: '小' + i, content: 'x', url: '/m/' + i + '.html' }))
    const r = await runWithPushMode('parallel', 2.5, data)
    assert(r.pushed === 5, `应推5条，实际${r.pushed}`)
    assert(r.cached === 5, `缓存应5条，实际${r.cached}`)
    assert(r.summary && r.summary.pushed === 5 && r.summary.failed === 0, `摘要正确: ${JSON.stringify(r.summary)}`)
  })

  await test('push.mode 非法值 → 警告并按顺序模式推送（防静默降级）', async () => {
    reset()
    setPushUrl('t47_badmode')
    Config.push.mode = 'PARALLEL' // 大写（拼写误配）
    fakeData = [1, 2].map(i => ({ id: i, catename: 'a', title: '模式' + i, content: 'x', url: '/b/' + i + '.html' }))
    await xbk.run()
    assert(pushCalls.length === 2, `非法 mode 应按顺序推送全部，实际${pushCalls.length}`)
    assert(Config.push.mode === 'PARALLEL', '不应修改用户配置')
    // 恢复
    Config.push.mode = 'parallel'
  })

  await test('parallel 模式部分失败 → 只缓存成功的', async () => {
    reset()
    setPushUrl('tpar_fail.json')
    Config.push.mode = 'parallel'
    notifyFailAt = 2 // 第2条推送失败
    fakeData = [1, 2, 3].map(i => ({ id: i, catename: 'a', title: '半' + i, content: 'x', url: '/r/' + i + '.html' }))
    await xbk.run()
    assert(pushCalls.length === 2, `应成功推2条，实际${pushCalls.length}`)
    const cached = readCacheFile('tpar_fail.json')
    assert(cached.length === 2, `应只缓存成功2条，实际${cached.length}`)
    Config.push.mode = 'parallel'
  })

  await test('parallel 与 sequential 推送结果一致', async () => {
    const data = [1, 2, 3, 4].map(i => ({ id: i, catename: 'a', title: '对' + i, content: 'x', url: '/s/' + i + '.html' }))
    const pa = await runWithPushMode('parallel', 0, data)
    const se = await runWithPushMode('sequential', 0, data)
    assert(pa.pushed === se.pushed, `推送数应一致: ${pa.pushed} vs ${se.pushed}`)
    assert(pa.cached === se.cached, `缓存应一致: ${pa.cached} vs ${se.cached}`)
    // 两种模式的 run() 返回摘要应完全一致（顺序模式统计曾恒错）
    assert(JSON.stringify(pa.summary) === JSON.stringify(se.summary),
        `summary 应一致: ${JSON.stringify(pa.summary)} vs ${JSON.stringify(se.summary)}`)
    assert(pa.summary && pa.summary.total === 4 && pa.summary.pushed === 4 && pa.summary.failed === 0,
        `摘要应正确: ${JSON.stringify(pa.summary)}`)
  })

  // ==================== 8. 错误分支 ====================
  console.log('\n📂 8. 错误分支')

  await test('重试耗尽（持续5xx）→ 抛错但 run 不崩溃', async () => {
    reset()
    setPushUrl('t13_exhaust')
    failCount = 99 // 一直失败，直到重试次数耗尽
    let crashed = false
    try {
      await xbk.run()
    } catch (e) {
      crashed = true
    }
    // 修复后 run() 重新抛出（不再静默吞错）
    assert(crashed, '重试耗尽应抛出异常')
    // retry=2 → 最多请求 3 次后放弃
    assert(gotCalls.length === 3, `应请求3次后放弃，实际${gotCalls.length}`)
    assert(pushCalls.length === 0, '失败不应推送')
  })

  await test('推送失败 → 被捕获不崩溃，且不写缓存（v3.18审查Bug1：下次可重试）', async () => {
    reset()
    setPushUrl('t14_push_fail')
    notifyFail = true
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '第二条' })]
    let crashed = false
    try {
      await xbk.run()
    } catch (e) {
      crashed = true
    }
    assert(!crashed, '推送失败不应导致未捕获异常')
    // 推送失败的消息不应写入缓存 → 下次运行会重新推送（避免永久丢失）
    const cached = readCacheFile('t14_push_fail')
    assert(cached.length === 0, `推送失败不应写缓存，实际${cached.length}条`)
  })

  await test('ETIMEDOUT → 重试后仍失败，run 走超时分支不崩溃', async () => {
    reset()
    setPushUrl('t15_timeout')
    failTimeout = true // 每次请求都超时（无 response 的错误会触发重试）
    let crashed = false
    try {
      await xbk.run()
    } catch (e) {
      crashed = true
    }
    // 修复后 run() 重新抛出（不再静默吞错）
    assert(crashed, 'ETIMEDOUT 应抛出异常')
    // retry=2 → 3 次请求后放弃（重试耗时较长，此处只验证次数）
    assert(gotCalls.length === 3, `应请求3次，实际${gotCalls.length}`)
  })

  // ==================== 7.18 ReDoS 防护（审查10轮 #240） ====================
  console.log('\n📂 7.18 ReDoS 防护')

  await test('zkt_gjc 嵌套量词正则 → 警告并忽略过滤，不卡死（#240）', async () => {
    reset()
    setPushUrl('t41_redos')
    Config.keyword.zkt_gjc = '(a+)+$' // 灾难性回溯正则
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })]
    let crashed = false
    const t0 = Date.now()
    try { await xbk.run() } catch (e) { crashed = true }
    assert(!crashed, '不应崩溃')
    assert(Date.now() - t0 < 3000, '不应被灾难性回溯卡死')
    // 风险关键词被忽略 → 不过滤，全部推送
    assert(pushCalls.length === 2, `应推2条(忽略风险过滤)，实际${pushCalls.length}`)
  })

  await test('filter 配置嵌套量词正则 → 规则跳过不卡死（#240）', async () => {
    reset()
    setPushUrl('t42_redos2')
    Config.filter.pingbibiaoti = '(a+)+$'
    fakeData = [makeItem({ id: 1, title: 'a'.repeat(5000) }), makeItem({ id: 2, title: '正常' })]
    let crashed = false
    const t0 = Date.now()
    try { await xbk.run() } catch (e) { crashed = true }
    assert(!crashed, '不应崩溃')
    assert(Date.now() - t0 < 3000, '不应卡死')
    assert(pushCalls.length === 2, '风险屏蔽规则被跳过 → 全部推送')
  })

  // ==================== 7.19 url 类型防御 ====================
  console.log('\n📂 7.19 url 类型防御')

  await test('对象 url 脏数据 → 不崩溃，正常数据照常推送（urlOf 防御）', async () => {
    reset()
    setPushUrl('t43_objurl')
    fakeData = [
      makeItem({ id: 1, url: '/n/1.html' }),
      { id: 2, catename: 'a', title: '对象url', content: 'y', url: { a: 1 } },
      { id: 3, catename: 'a', title: 'null url', content: 'z', url: null }
    ]
    let crashed = false
    try { await xbk.run() } catch (e) { crashed = true }
    assert(!crashed, '对象/空 url 不应导致崩溃')
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}`)
    // 正常数据链接完整；对象/空 url 无 undefined / [object Object]
    assert(pushCalls[0].desp.includes('https://new.ixbk.net/n/1.html'), '正常数据链接应完整')
    assert(!pushCalls[1].desp.includes('undefined') && !pushCalls[1].desp.includes('[object Object]'),
      '脏数据不应含垃圾文本')
  })

  await test('协议相对 // 开头 URL 不拼前缀（urlOf）', async () => {
    reset()
    setPushUrl('t44_protorel')
    fakeData = [makeItem({ id: 1, url: '//cdn.x.com/a.jpg' })]
    await xbk.run()
    assert(pushCalls.length === 1, '应推送')
    assert(pushCalls[0].desp.includes('//cdn.x.com/a.jpg'), '协议相对 URL 不应拼前缀')
    assert(!pushCalls[0].desp.includes('new.ixbk.net//'), '不应拼坏')
  })

  await test('运行时配置校验：非法数值配置警告、合法不警告（v3.64）', async () => {
    reset()
    setPushUrl('t45_cfgcheck')
    fakeData = [makeItem({ id: 1 })]
    const orig = {
      timeout: Config.api.timeout,
      retry: Config.api.retry,
      pushInterval: Config.timing.pushInterval,
      finalWait: Config.timing.finalWait,
      parallelLimit: Config.push.parallelLimit,
      domain: Config.domain,
      templateTitle: Config.template.title
    }
    let warns = []
    const origWarn = console.warn
    console.warn = (m) => warns.push(String(m))
    try {
      Config.api.timeout = -1
      Config.api.retry = 2.5
      Config.timing.pushInterval = 'abc'
      Config.timing.finalWait = -5
      Config.push.parallelLimit = -1
      Config.domain = '非法域名'
      Config.template.title = 123
      await xbk.run()
      assert(warns.some(w => w.includes('api.timeout')), 'timeout 应警告')
      assert(warns.some(w => w.includes('api.retry')), 'retry 应警告')
      assert(warns.some(w => w.includes('pushInterval')), 'pushInterval 应警告')
      assert(warns.some(w => w.includes('finalWait')), 'finalWait 应警告')
      assert(warns.some(w => w.includes('parallelLimit')), 'parallelLimit 应警告')
      assert(warns.some(w => w.includes('domain')), '非法 domain 应警告')
      assert(warns.some(w => w.includes('template')), '非法 template 应警告')
    } finally {
      Config.api.timeout = orig.timeout
      Config.api.retry = orig.retry
      Config.timing.pushInterval = orig.pushInterval
      Config.timing.finalWait = orig.finalWait
      Config.push.parallelLimit = orig.parallelLimit
      Config.domain = orig.domain
      Config.template.title = orig.templateTitle
      console.warn = origWarn
    }
    // 合法值不警告
    warns = []
    console.warn = (m) => warns.push(String(m))
    try {
      await xbk.run()
      assert(!warns.some(w => w.includes('⚠️ 配置「')), '合法配置不应有运行时配置警告')
    } finally {
      console.warn = origWarn
    }
  })

  await test('运行摘要持久化到 run.log（v3.65）', async () => {
    reset()
    setPushUrl('t46_runlog')
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '第二条' })]
    await xbk.run()
    const logPath = path.join(CACHE_DIR, 'run.log')
    assert(fs.existsSync(logPath), 'run.log 应已创建')
    const content = fs.readFileSync(logPath, 'utf8')
    const lastLine = content.trim().split('\n').pop()
    assert(/total=\d+ dedup=\d+ filtered=\d+ truncated=\d+ pushed=\d+ failed=\d+ elapsed=[\d.]+s/.test(lastLine),
        `日志行应含完整摘要字段（含 elapsed/truncated），实际: ${lastLine}`)
    assert(lastLine.includes('pushed=2'), `应记录推送 2 条，实际: ${lastLine}`)
    // 测试产生的日志行不污染真实运行日志（测试专用，删掉）
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
  })

  await test('运行失败也写 ERROR 日志（v3.66）', async () => {
    reset()
    setPushUrl('t47_runlog_fail')
    fakeData = []
    // 清掉可能残留的 run.log，确保断言的是本测试写入的行
    try { fs.unlinkSync(path.join(CACHE_DIR, 'run.log')) } catch (e) { /* 忽略 */ }
    fail4xx = true // 404 不重试 → run 直接抛错（走 catch 分支）
    let threw = false
    try { await xbk.run() } catch (e) { threw = true }
    assert(threw, '4xx 应使 run 抛错')
    const logPath = path.join(CACHE_DIR, 'run.log')
    assert(fs.existsSync(logPath), 'run.log 应已创建')
    const lastLine = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop()
    assert(lastLine.includes('ERROR'), `应记录 ERROR 行，实际: ${lastLine}`)
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
  })

  await test('超长 error.message 日志行 < 1KB（C043）', async () => {
    reset()
    setPushUrl('t_c043_runlog_longmsg')
    fakeData = []
    failLongMsg = true
    try { fs.unlinkSync(path.join(CACHE_DIR, 'run.log')) } catch (e) { /* 忽略 */ }
    let threw = false
    try { await xbk.run() } catch (e) { threw = true }
    assert(threw, '超长错误应使 run 抛错')
    const logPath = path.join(CACHE_DIR, 'run.log')
    assert(fs.existsSync(logPath), 'run.log 应已创建')
    const lastLine = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop()
    assert(lastLine.includes('ERROR'), `应记录 ERROR 行，实际: ${lastLine.slice(0, 80)}`)
    assert(lastLine.length < 1024, `超长 error.message 日志行应 <1KB，实际 ${lastLine.length}`)
    try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
  })

  await test('run.log 锁竞争时 fail-open 只追加不截尾（v3.257 修复 049）', async () => {
    reset()
    setPushUrl('t63_runlog_lock')
    fakeData = [makeItem({ id: 1 })]
    const logPath = path.join(CACHE_DIR, 'run.log')
    try {
      // 预创建锁文件模拟其他进程持锁（EEXIST → 3s 超时 fail-open：拿不到锁只追加）
      require('fs').writeFileSync(logPath + '.lock', '99999\n')
      await xbk.run()
      const content = fs.readFileSync(logPath, 'utf8')
      const lastLine = content.trim().split('\n').pop()
      assert(/total=\d+/.test(lastLine), `fail-open 下日志仍应追加摘要行，实际: ${lastLine}`)
      assert(lastLine.includes('pushed=1'), `应记录推送 1 条，实际: ${lastLine}`)
      // 外部创建的锁文件不应被误删（非本次调用创建的锁）
      assert(fs.existsSync(logPath + '.lock'), '外部锁文件不应被删除')
    } finally {
      try { fs.unlinkSync(logPath) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(logPath + '.lock') } catch (e) { /* 忽略 */ }
    }
  })

  await test('推送模板可配置 + 非法回退默认（v3.68）', async () => {
    reset()
    setPushUrl('t48_template')
    fakeData = [makeItem({ id: 1, title: '模板测试', content: '正文', posttime: Math.floor(Date.now() / 1000) })]
    const origTitle = Config.template.title
    const origContent = Config.template.content
    try {
      Config.template.title = '【{分类名}】{标题} | {日期} {时间}'
      Config.template.content = '{标题}\n{链接}\n{Markdown内容}'
      await xbk.run()
      assert(pushCalls.length === 1, '应推送 1 条')
      assert(pushCalls[0].text.includes(' | '), '标题模板应含自定义分隔符')
      assert(!pushCalls[0].text.includes('{日期}') && !pushCalls[0].text.includes('{时间}'),
            `日期/时间占位符应被替换，实际: ${pushCalls[0].text}`)
      assert(pushCalls[0].desp.includes('模板测试'), '内容模板应含 {标题}')
      assert(pushCalls[0].desp.includes('原文链接'), '内容模板应含 {Markdown内容} 全文')
    } finally {
      Config.template.title = origTitle
      Config.template.content = origContent
    }
    // 非法模板（undefined/非字符串）→ 回退默认，不影响推送
    reset()
    setPushUrl('t48b_template_fallback')
    fakeData = [makeItem({ id: 2, title: '回退测试' })]
    try {
      Config.template.title = undefined
      Config.template.content = 123
      await xbk.run()
      assert(pushCalls.length === 1, '回退默认仍应推送')
      assert(pushCalls[0].text.startsWith('【'), '非法模板应回退默认标题格式')
      assert(pushCalls[0].desp.includes('原文链接'), '非法模板应回退默认内容格式')
    } finally {
      Config.template.title = origTitle
      Config.template.content = origContent
    }
  })

  await test('自定义 {内容} 模板绕过 Formatter 后仍清理主动 HTML（最终推送出口防护）', async () => {
    reset()
    setPushUrl('t_html_final_sanitize')
    const origContent = Config.template.content
    try {
      Config.template.content = '{内容}'
      fakeData = [makeItem({
        id: 6001,
        content: '<script>alert(1)</script><img/onerror=alert(2)>正文',
        content_html: '<p>安全 HTML</p>'
      })]
      await xbk.run()
      assert(pushCalls.length === 1, '应推送一条')
      const d = pushCalls[0].desp
      assert(!/<script|onerror\s*=|javascript:/i.test(d), `自定义内容不应带主动 HTML: ${d}`)
      assert(d.includes('正文'), '普通内容文本应保留')
    } finally {
      Config.template.content = origContent
    }
  })

  await test('最终推送出口不破坏纯文本/纯 Markdown 内容（P2 过杀修复）', async () => {
    reset()
    setPushUrl('t_html_final_keep_plain')
    const origContent = Config.template.content
    try {
      // {内容} 模板 + 纯文本（含技术讨论字面量、实体文本）：无 HTML 标签形态，出口不应清洗
      Config.template.content = '{内容}'
      fakeData = [makeItem({
        id: 6002,
        content: '技术讨论：img 标签的 onerror=alert(1) 属性和 &lt;script&gt; 代码',
        content_html: '<p>安全 HTML</p>'
      })]
      await xbk.run()
      assert(pushCalls.length === 1, '应推送一条')
      const d = pushCalls[0].desp
      assert(d.includes('onerror=alert(1)'), `纯文本讨论不应被删: ${d}`)
      assert(d.includes('<script>') || d.includes('&lt;script&gt;'), `代码字面量应保留: ${d}`)
      // 对照：含真实 HTML 标签的 desp 仍被清洗（出口防护不失效）
      fakeData = [makeItem({ id: 6003, content: '<script>alert(1)</script>正文', content_html: '<p>x</p>' })]
      await xbk.run()
      const d2 = pushCalls[pushCalls.length - 1].desp
      assert(!/<script|onerror\s*=/i.test(d2), `HTML 形态内容仍应清洗: ${d2}`)
      // 对照：非白名单 HTML 元素（input/form 等）也必须触发最终出口清洗，不能绕过 htmlLike 检测
      fakeData = [makeItem({ id: 6004, content: '<input autofocus onfocus=alert(3)>输入控件', content_html: '<p>x</p>' })]
      await xbk.run()
      const d3 = pushCalls[pushCalls.length - 1].desp
      assert(!/onfocus\s*=/i.test(d3), `非白名单 HTML 元素的事件属性也应清洗: ${d3}`)
    } finally {
      Config.template.content = origContent
    }
  })

  await test('长 desp 截断保留原文链接（v3.152）', async () => {
    reset()
    setPushUrl('t61_linkkeep')
    // 超长 content_html → desp 超 contentMax → 截断后原文链接应保留
    fakeData = [makeItem({ id: 1, content_html: '<p>' + '很长内容'.repeat(2000) + '</p>' })]
    await xbk.run()
    assert(pushCalls.length === 1, '应推送')
    const d = pushCalls[0].desp
    assert(d.length <= Config.push.contentMax, `desp 应 ≤ contentMax: ${d.length}`)
    assert(d.includes('原文链接'), `截断后原文链接应保留: 尾部 ${JSON.stringify(d.slice(-30))}`)
  })

  await test('desp 链接补回极端 contentMax 不超限（v3.177 边界修正）', async () => {
    reset()
    setPushUrl('t61b_linkkeep_edge')
    const origContentMax = Config.push.contentMax
    try {
      // contentMax 略大于链接长度：曾 contentMax-link-2 ≤0 → truncateUtf16 返回原串 → desp 全量+链接超限
      Config.push.contentMax = 90 // 链接(81)+2 分隔符=83 ≤ 90 → 应补且总长 ≤ 90
      fakeData = [makeItem({ id: 1, content_html: '<p>' + '很长内容'.repeat(30) + '</p>' })]
      await xbk.run()
      const d = pushCalls[0].desp
      assert(d.length <= 90, `极端 contentMax=90 时 desp 应 ≤90: 实际 ${d.length}`)
      assert(d.includes('原文链接'), '链接应保留')
      assert(d.endsWith(')'), 'desp 应以链接结尾')
      // contentMax 太小（链接都放不下）→ 不补链接，尊重截断配置
      reset()
      setPushUrl('t61c_linkkeep_tiny')
      Config.push.contentMax = 10
      fakeData = [makeItem({ id: 1, content_html: '<p>' + '很长内容'.repeat(30) + '</p>' })]
      await xbk.run()
      const d2 = pushCalls[0].desp
      assert(d2.length <= 10, `contentMax=10 时 desp 应 ≤10: 实际 ${d2.length}`)
    } finally {
      Config.push.contentMax = origContentMax
    }
  })

  await test('截断补回原文链接不得重新引入危险 URL（v3.228）', async () => {
    reset()
    setPushUrl('t61d_danger_linkkeep')
    const originalContentMax = Config.push.contentMax
    try {
      Config.push.contentMax = 100
      fakeData = [makeItem({
        id: 6104,
        url: 'javascript://evil',
        content_html: '<p>' + '长'.repeat(100) + '原文链接</p>'
      })]
      await xbk.run()
      assert(pushCalls.length === 1, '危险 URL 场景仍应完成推送')
      assert(!/javascript:|vbscript:|data:/i.test(pushCalls[0].desp),
            `截断补链不得包含危险协议: ${pushCalls[0].desp}`)
    } finally {
      Config.push.contentMax = originalContentMax
    }
  })

  await test('推送截断长度可配置 + 非法回退默认（v3.69）', async () => {
    reset()
    setPushUrl('t49_trunc')
    fakeData = [makeItem({ id: 1, title: '这是一个非常长的标题用于测试截断', content: '内容内容内容内容内容内容' })]
    const origTitleMax = Config.push.titleMax
    const origContentMax = Config.push.contentMax
    try {
      Config.push.titleMax = 5
      Config.push.contentMax = 4
      await xbk.run()
      assert(pushCalls.length === 1, '应推送 1 条')
      assert(pushCalls[0].text.length <= 5, `标题最终长度应 ≤ titleMax(5)，实际: ${pushCalls[0].text}`)
      assert(!pushCalls[0].text.includes('非常长的标题用于测试截断'), '标题不应超过 5 字符')
      assert(pushCalls[0].desp.length <= 4, `内容应按 4 截断（含 Markdown 转换结果），实际: ${pushCalls[0].desp.length}`)
    } finally {
      Config.push.titleMax = origTitleMax
      Config.push.contentMax = origContentMax
    }
    // 非法值（负数/0/非数字）→ 回退默认，不误截
    reset()
    setPushUrl('t49b_trunc_fallback')
    fakeData = [makeItem({ id: 2, title: '正常标题', content: '正常内容' })]
    try {
      Config.push.titleMax = -1
      Config.push.contentMax = 0
      await xbk.run()
      assert(pushCalls.length === 1, '回退默认仍应推送')
      assert(pushCalls[0].text.includes('【分类】正常标题') || pushCalls[0].text.includes('正常标题'),
            `非法 titleMax 不应截断，实际: ${pushCalls[0].text}`)
      assert(pushCalls[0].desp.includes('原文链接'), '非法 contentMax 不应截断 Markdown 全文')
    } finally {
      Config.push.titleMax = origTitleMax
      Config.push.contentMax = origContentMax
    }
  })

  await test('并行模式 + 自定义模板/截断组合（v3.84）', async () => {
    reset()
    setPushUrl('t50_parallel_tpl')
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 })]
    const origMode = Config.push.mode
    const origTitleMax = Config.push.titleMax
    const origTpl = Config.template.title
    try {
      Config.push.mode = 'parallel'
      Config.push.titleMax = 20
      Config.template.title = '【{分类名}】{标题}|{链接}'
      await xbk.run()
      assert(pushCalls.length === 2, `应推 2 条: ${pushCalls.length}`)
      for (const c of pushCalls) {
        assert(c.text.length <= 20, `并行模式标题应 ≤ titleMax(20): ${c.text}`)
        assert(c.text.includes('|'), `模板分隔符应生效: ${c.text}`)
        assert(!c.text.includes('{'), `占位符应全部替换: ${c.text}`)
      }
    } finally {
      Config.push.mode = origMode
      Config.push.titleMax = origTitleMax
      Config.template.title = origTpl
    }
  })

  await test('组合防御: 过滤配置含嵌套 Symbol → filterHash/run 不崩', async () => {
    reset()
    setPushUrl('t_filter_hash_symbol')
    const orig = Config.filter.pingbibiaoti
    try {
      Config.filter.pingbibiaoti = [Symbol('bad')]
      fakeData = []
      const s = await xbk.run()
      assert(s && s.total === 0, `脏过滤配置不应阻断主流程: ${JSON.stringify(s)}`)
    } finally {
      Config.filter.pingbibiaoti = orig
    }
  })

  await test('配置矩阵: 全部非法值并行模式不崩（v3.95）', async () => {
    reset()
    setPushUrl('t51_cfg_matrix')
    fakeData = [makeItem({ id: 1 })]
    try {
      Config.api.timeout = 'abc'
      Config.api.retry = 2.5 // 小数合法执行（非法值会导致 fetchData 合理失败，非本测试目标）
      Config.timing.pushInterval = 'x'
      Config.timing.finalWait = 'y'
      Config.push.mode = 'parallel'
      Config.push.parallelLimit = 'z'
      Config.push.titleMax = -1
      Config.push.contentMax = 'abc'
      Config.cache.maxSize = 0
      Config.cache.dir = 123
      Config.template.title = 456
      Config.template.content = null
      Config.domain = '非法域名'
      await xbk.run()
      assert(pushCalls.length === 1, `全部非法配置下仍应推送成功: ${pushCalls.length}`)
      assert(pushCalls[0].desp.includes('原文链接'), '非法配置回退默认后内容应完整')
    } finally {
      reset() // v3.91 reset 恢复全部默认
    }
  })

  // ==================== 7.20 R1 低风险修复：pushOne 非 Error 兜底 ====================
  await test('推送抛非Error(字符串) → 不崩溃、失败计数、不写缓存（R1 防御）', async () => {
    reset()
    setPushUrl('t52_notify_string')
    fakeData = [makeItem({ id: 1 })]
    notifyFailString = true // notify 抛字符串异常
    const origLog = console.log
    const captured = []
    console.log = (...args) => captured.push(args.join(' '))
    try {
      const r = await xbk.run()
      assert(r.total === 1, `total=1: ${r.total}`)
      assert(r.pushed === 0 && r.failed === 1, `失败应计数: pushed=${r.pushed} failed=${r.failed}`)
      assert(pushCalls.length === 0, '字符串异常时 notify 不应有成功调用')
      assert(readCacheFile('t52_notify_string').length === 0, '失败不写缓存（下次重试）')
      // 日志断言：失败原因应显示字符串本身，而非 undefined（R1 兜底核心）
      const log = captured.join('\n')
      assert(log.includes('push boom string'), `日志应含字符串原因: ${log.slice(-120)}`)
      assert(!log.includes('undefined'), `日志不应含 undefined: ${log.slice(-120)}`)
    } finally {
      console.log = origLog
      notifyFailString = false
    }
  })

  // ==================== 7.21 R2 低风险修复：domain 防御 + fetchData 日志兜底 ====================
  await test('domain 非字符串(数字) → 不崩溃、正常推送（R2 baseUrl 防御）', async () => {
    reset()
    setPushUrl('t53_domain_num')
    fakeData = [makeItem({ id: 1 })]
    Config.domain = 123 // 脏配置：数字（v3.73 校验只警告不阻止，baseUrl 需防御）
    try {
      const r = await xbk.run()
      assert(r.total === 1 && r.pushed === 1, `domain=123 应仍能推送: pushed=${r.pushed}`)
      assert(pushCalls[0].desp.includes('原文链接'), '推送内容正常')
    } finally {
      reset()
    }
  })

  await test('fetchData 抛字符串 → 重试日志含原因且无 undefined（R2 日志兜底）', async () => {
    reset()
    setPushUrl('t54_fetch_string')
    fakeData = [makeItem({ id: 1 })]
    failPlainString = true // got 抛 'plain string error'
    const origLog = console.log
    const captured = []
    console.log = (...args) => captured.push(args.join(' '))
    try {
      let rejected = false
      try { await xbk.run() } catch (e) { rejected = true }
      assert(rejected, '重试耗尽应失败')
      const log = captured.join('\n')
      assert(log.includes('plain string error'), `日志应含字符串原因: ${log.slice(-120)}`)
      assert(!log.includes('undefined'), `日志不应含 undefined: ${log.slice(-120)}`)
    } finally {
      console.log = origLog
      failPlainString = false
    }
  })

  await test('reset() 恢复 api.timeout/retry 默认值（R3-1 测试隔离）', async () => {
    Config.api.timeout = 9999
    Config.api.retry = 7
    reset()
    assert(Config.api.timeout === 5000, `timeout 恢复默认: ${Config.api.timeout}`)
    assert(Config.api.retry === 2, `retry 恢复默认: ${Config.api.retry}`)
  })

  // ==================== 7.22 R4 低风险修复：retry 有界 + Pusher 参数归一 ====================
  await test('fetchData retry=Infinity → 有界兜底不无限重试（R4-1 防死循环）', async () => {
    reset()
    setPushUrl('t56_retry_inf')
    fakeData = [makeItem({ id: 1 })]
    failCount = 5 // mock got 持续失败
    Config.api.retry = Infinity // 非法配置：死循环风险
    const origLog = console.log
    const captured = []
    console.log = (...args) => captured.push(args.join(' '))
    try {
      let rejected = false
      try { await xbk.run() } catch (e) { rejected = true }
      assert(rejected, '持续失败应最终抛错')
      assert(gotCalls.length <= 3, `retry=Infinity 应兜底为 2 次重试(共3次请求): 实际 ${gotCalls.length}`)
      // R5-1：日志显示兜底后次数（1/2、2/2），非 "1/Infinity"
      const log = captured.join('\n')
      assert(log.includes('1/2'), `日志应显示兜底次数 1/2: ${log.slice(-160)}`)
      assert(!log.includes('Infinity'), `日志不应含 Infinity: ${log.slice(-160)}`)
    } finally {
      console.log = origLog
      failCount = 0
      reset() // R3-1 已恢复 api.retry
    }
  })

  await test('Pusher.send 超时为全部尝试通道保留结构化失败', async () => {
    reset()
    const originalSetTimeout = global.setTimeout
    const names = ['pushplus', 'telegram']
    global.setTimeout = (fn) => originalSetTimeout(fn, 0)
    try {
      let timeoutError
      try {
        await xbk.Pusher.send('标题', '内容', {
          configuredChannelNames: () => names,
          sendNotify: () => new Promise(() => {})
        })
      } catch (e) { timeoutError = e }
      assert(timeoutError && Array.isArray(timeoutError.failures), '超时应携带 failures')
      assert(timeoutError.failures.length === names.length, `超时失败数应为 ${names.length}: ${JSON.stringify(timeoutError && timeoutError.failures)}`)
      assert(timeoutError.failures.every((failure, index) => failure.channel === names[index] && failure.code === 'PUSH_TIMEOUT'), `超时失败应按通道结构化: ${JSON.stringify(timeoutError.failures)}`)
    } finally {
      global.setTimeout = originalSetTimeout
    }
  })

  await test('Pusher.send 非字符串参数 → 归一为空串（R4-2 防御）', async () => {
    reset()
    await xbk.Pusher.send(undefined, null)
    assert(pushCalls.length === 1, '应调用 sendNotify')
    assert(pushCalls[0].text === '', `text 归一为空串: ${JSON.stringify(pushCalls[0].text)}`)
    assert(pushCalls[0].desp === '', `desp 归一为空串: ${JSON.stringify(pushCalls[0].desp)}`)
  })

  await test('对象 title 脏数据 → (无标题) 占位、无 [object Object]（R9 防御）', async () => {
    reset()
    setPushUrl('t58_obj_title')
    fakeData = [makeItem({ id: 1, title: { a: 1 } })]
    const r = await xbk.run()
    assert(r.pushed === 1, `应推送成功: ${r.pushed}`)
    const p = pushCalls[0]
    assert(!p.text.includes('[object Object]'), `标题无泄漏: ${p.text.slice(0, 80)}`)
    assert(p.text.includes('(无标题)'), `标题应为 (无标题) 占位: ${p.text.slice(0, 80)}`)
  })

  await test('Symbol/异常字段不应破坏已成功推送的缓存一致性（v3.229）', async () => {
    reset()
    setPushUrl('t58_dirty_fields')
    const bad = { toString () { throw new Error('bad field') } }
    fakeData = [makeItem({ id: 5801, title: Symbol('bad-title'), catename: Symbol('bad-category'), content: bad })]
    const r = await xbk.run()
    assert(r && r.pushed === 1 && r.failed === 0, `脏字段不应影响成功摘要: ${JSON.stringify(r)}`)
    assert(pushCalls.length === 1, `底层推送应成功一次，实际${pushCalls.length}`)
    assert(readCacheFile('t58_dirty_fields').length === 1, '成功推送后仍应写入缓存')
    assert(!pushCalls[0].text.includes('Symbol') && !pushCalls[0].text.includes('[object Object]'), '推送标题不应泄漏脏字段')
  })

  await test('异常 getter 字段不应破坏推送后缓存事务（v3.231）', async () => {
    reset()
    setPushUrl('t58_throwing_getter')
    const item = makeItem({ id: 5831 })
    Object.defineProperty(item, 'title', {
      enumerable: true,
      configurable: true,
      get () { throw new Error('title getter') }
    })
    fakeData = [item]
    const r = await xbk.run()
    assert(r && r.pushed === 1 && r.failed === 0, `异常 getter 不应影响成功摘要: ${JSON.stringify(r)}`)
    assert(pushCalls.length === 1, `异常 getter 数据仍应推送一次，实际${pushCalls.length}`)
    assert(readCacheFile('t58_throwing_getter').length === 1, '成功推送后异常 getter 数据仍应写缓存')
    assert(pushCalls[0].text.includes('(无标题)'), '异常 getter 标题应使用安全占位')
  })

  await test('zkt_gjc 对象配置 → 警告并全部推送（R11-1 防御）', async () => {
    reset()
    setPushUrl('t59_zkt_obj')
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝好价' })]
    Config.keyword.zkt_gjc = { a: 1 } // 对象脏配置（String 化会成 '[object Object]' 正则）
    const origWarn = console.warn
    const warns = []
    console.warn = (m) => warns.push(String(m))
    try {
      const r = await xbk.run()
      assert(r.pushed === 2, `对象 zkt_gjc 应全部推送: ${r.pushed}`)
      assert(warns.some(w => w.includes('zkt_gjc') && w.includes('应为字符串')), '应有非字符串警告')
    } finally {
      console.warn = origWarn
      reset()
    }
  })

  // ================================================
  console.log('\n========================================')

  await test('集成 Fuzz: 随机数据流 + 随机配置 run() 不崩（v3.109）', async () => {
    // 确定性随机（固定 seed——跨运行一致）
    let seed = 20260901
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    // 随机数据生成器：id/catename/title/content/content_html/louzhu/louzhuregtime/url 全部随机脏化
    const randItem = (i) => {
      const r = rand()
      return {
        id: r < 0.2 ? null : (r < 0.4 ? String(i) : i),
        catename: rand() < 0.15 ? null : (rand() < 0.5 ? '分类' + Math.floor(rand() * 5) : ''),
        title: rand() < 0.1 ? null : ('标题' + i + (rand() < 0.5 ? ' 京东' : '')),
        content: rand() < 0.1 ? null : '内容' + i,
        content_html: rand() < 0.3 ? '<b>' + i + '</b>' + (rand() < 0.5 ? '&amp;amp;' : '') : '<p>html' + i + '</p>',
        louzhu: rand() < 0.2 ? null : '楼主' + i,
        louzhuregtime: rand() < 0.3 ? null : (rand() < 0.5 ? '2026-01-01' : String(Math.floor(rand() * 1e9))),
        url: rand() < 0.15 ? null : (rand() < 0.5 ? '/item/' + i + '.html' : 'http://x.com/' + i)
      }
    }
    for (let round = 0; round < 3; round++) {
      reset()
      setPushUrl('t52_fuzz_' + round)
      fakeData = []
      const n = 20 + Math.floor(rand() * 30)
      for (let i = 0; i < n; i++) fakeData.push(randItem(i))
      // 随机 filter 配置（合法/非法正则混合）
      Config.filter.pingbibiaoti = rand() < 0.5 ? '京东' : (rand() < 0.8 ? '(' : '')
      Config.filter.pingbitime = String(Math.floor(rand() * 20))
      Config.keyword.zkt_gjc = rand() < 0.3 ? '' : (rand() < 0.5 ? '京东' : '[')
      try {
        const summary = await xbk.run()
        assert(typeof summary.total === 'number' && summary.total === fakeData.length,
                `第${round}轮 total 应为 ${fakeData.length}，实际 ${summary.total}`)
        assert(typeof summary.pushed === 'number' && typeof summary.failed === 'number', '摘要字段完整')
        assert(summary.pushed + summary.failed <= summary.total, 'pushed+failed 不应超 total')
      } finally {
        reset()
      }
    }
  })

  await test('Fuzz 回归: 孤立代理内容 run() 推送成功且无孤立代理（v3.110）', async () => {
    reset()
    setPushUrl('t53_surrogate')
    fakeData = [makeItem({ id: 1, title: '标题\ud800', content_html: '<p>内容\udfff</p>', content: '正文\ud800' })]
    const summary = await xbk.run()
    assert(summary.pushed === 1, `应推送成功: ${JSON.stringify(summary)}`)
    const isolatedRe = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const c of pushCalls) {
      assert(!isolatedRe.test(c.text), `text 无孤立代理: ${JSON.stringify(c.text)}`)
      assert(!isolatedRe.test(c.desp), 'desp 无孤立代理')
      try { encodeURIComponent(c.text); encodeURIComponent(c.desp) } catch (e) { throw new Error('推送内容 encode 崩') }
    }
  })

  await test('边界: parallelLimit=1 与顺序模式等价 + pushInterval=0 快速 + retry=0 不重试', async () => {
    // parallelLimit=1：每批 1 条 = 串行效果
    reset()
    setPushUrl('t55_limit1')
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })]
    const origMode = Config.push.mode; const origLimit = Config.push.parallelLimit; const origPI = Config.timing.pushInterval
    try {
      Config.push.mode = 'parallel'
      Config.push.parallelLimit = 1
      Config.timing.pushInterval = 0
      const summary = await xbk.run()
      assert(summary.pushed === 3, `parallelLimit=1 应推 3 条: ${JSON.stringify(summary)}`)
      assert(pushCalls.length === 3, '3 条全部推送')
      assert(summary.failed === 0, '无失败')
    } finally {
      Config.push.mode = origMode; Config.push.parallelLimit = origLimit; Config.timing.pushInterval = origPI
    }
    // retry=0：不重试（mock 首次失败 → 直接抛错）
    reset()
    setPushUrl('t55b_retry0')
    fakeData = []
    const origRetry = Config.api.retry
    try {
      Config.api.retry = 0
      failCount = 1 // 首次失败，retry=0 不重试
      let threw = false
      try { await xbk.run() } catch (e) { threw = true }
      assert(threw, 'retry=0 时首次失败应直接抛错')
    } finally {
      Config.api.retry = origRetry
    }
    // retry=1：失败 1 次后重试成功
    reset()
    setPushUrl('t55c_retry1')
    fakeData = [makeItem({ id: 1 })]
    try {
      Config.api.retry = 1
      failCount = 1 // 失败 1 次 → 重试成功
      const summary = await xbk.run()
      assert(summary.pushed === 1, 'retry=1 失败一次后应重试成功')
    } finally {
      Config.api.retry = origRetry
    }
  })

  await test('接口异常 → 发送告警 + 限频（v3.123）', async () => {
    reset()
    setPushUrl('t56_alert')
    fakeData = []
    const origInterval = Config.alert.intervalMs
    const origEnabled = Config.alert.enabled
    // APP-05：临时把进程时区设为 UTC，让「上海口径」与「进程本地口径」必然相差 8 小时。
    // 本机默认 TZ=Asia/Shanghai 时两种实现渲染结果完全相同、断言对缺陷没有咬合力（CI runner 即 UTC）。
    const savedTz = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      // ① 不限频 → 接口异常发告警
      Config.alert.enabled = true // reset() 默认关闭（v3.124），此处显式开启
      Config.alert.intervalMs = 0
      fail4xx = true // 404 不重试 → run 抛错
      const tBefore = Date.now()
      let threw = false
      try { await xbk.run() } catch (e) { threw = true }
      const tAfter = Date.now()
      assert(threw, '接口异常应抛错')
      const alert = pushCalls.find(c => c.text.includes('运行异常'))
      assert(!!alert, '应发送运行异常告警')
      assert(alert.desp.includes('Not Found'), `告警内容应含原因: ${alert.desp.slice(0, 80)}`)
      assert(alert.desp.includes('\n\n时间：'), `告警 desp 应用段落分隔 \\n\\n（v3.159，wxpusher Markdown 渲染单\\n可能挤行）: ${JSON.stringify(alert.desp.slice(0, 60))}`)
      // APP-05：正文里的时间必须是上海口径。反例（改动前）：toLocaleString('zh-CN') 不带 timeZone，
      // TZ=UTC 时渲染 UTC（比上海早 8 小时），与 run.log/日报的上海口径错开。
      const alertStamp = (alert.desp.match(/时间：([^\n]+)/) || [])[1]
      // 期望值用与应用**同一个**表达式求（toLocaleString 默认含日期+时间，而 Intl.DateTimeFormat
      // 构造器默认只到日期，两者不可互替），只在 timeZone 上做对照。
      const fmtZh = (tz, t) => new Date(t).toLocaleString('zh-CN', { timeZone: tz })
      // CodeRabbit PR #151：告警时间被格式化到**整秒**，而 desp 构造发生在 run 中途——只要跨过
      // 秒边界，渲染出的秒就可能既不是 tBefore 也不是 tAfter（旧写法只允许两个端点 → 偶发红）。
      // 改为允许区间内每一个可能的渲染秒。
      const allowedStamps = new Set()
      for (let t = Math.floor(tBefore / 1000) * 1000; t <= tAfter; t += 1000) allowedStamps.add(fmtZh('Asia/Shanghai', t))
      assert(allowedStamps.has(alertStamp),
        `告警正文时间必须是 Asia/Shanghai 口径（进程 TZ=${process.env.TZ}；同一时刻的 UTC 渲染为 ${fmtZh('UTC', tBefore)}）：实际 ${alertStamp}`)
      // ② 限频生效：intervalMs 大 → 第二次异常不发（状态文件记录上次）
      Config.alert.intervalMs = 3600000
      reset()
      setPushUrl('t56_alert_2')
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      const alert2 = pushCalls.find(c => c.text.includes('运行异常'))
      assert(!alert2, '限频内不应重复发送告警')
    } finally {
      Config.alert.intervalMs = origInterval
      Config.alert.enabled = origEnabled
      if (savedTz === undefined) delete process.env.TZ
      else process.env.TZ = savedTz
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP-05：RE2 标记保留期与标记名同用上海日界', async () => {
    // 固定「现在」为 UTC 2026-09-15T20:00:00Z——此刻上海已是 2026-09-16，UTC 仍是 09-15，
    // 两种口径的「7 天前」cutoff 必然差一天（上海 2026-09-09 vs UTC 2026-09-08），断言因此有判别力。
    // 注意：该固定时刻只用于让边界可判定；真实墙钟下删除窗口与生产不同，故下面必须做快照恢复。
    const FIXED_NOW = Date.parse('2026-09-15T20:00:00Z')
    const savedTz = process.env.TZ
    const realDateNow = Date.now
    process.env.TZ = 'UTC'
    Date.now = () => FIXED_NOW
    const prefix = 're2warn.state.'
    const markers = ['2026-09-08', '2026-09-09', '2026-09-10']
    // hermetic（独立对抗审查 B 组实测：本用例会删掉别的运行留在缓存目录里的旧标记——
    // 它调用的正是真实的保留期清理逻辑，凡早于 cutoff 的既有标记都会被删）。故先快照、finally 原样恢复：
    // 依赖「测试目录里没有旧标记」是不可靠的假设，而恢复才能真正保证不污染共享缓存目录。
    const preExisting = []
    let backup = []
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      for (const name of fs.readdirSync(CACHE_DIR)) {
        if (name.startsWith(prefix)) preExisting.push(name)
      }
      backup = preExisting.map(name => [name, fs.readFileSync(path.join(CACHE_DIR, name))])
      for (const d of markers) fs.writeFileSync(path.join(CACHE_DIR, `${prefix}${d}`), 'test')
      xbk.App._cleanupStaleRe2WarnMarkers()
      assert(fs.existsSync(path.join(CACHE_DIR, `${prefix}2026-09-08`)) === false,
        '上海 cutoff=2026-09-09，故 09-08 必须删除（旧实现按进程本地 UTC 得 cutoff=09-08，会把它留下）')
      assert(fs.existsSync(path.join(CACHE_DIR, `${prefix}2026-09-09`)) === true,
        'cutoff 当天不算“严格早于”，必须保留')
      assert(fs.existsSync(path.join(CACHE_DIR, `${prefix}2026-09-10`)) === true, '保留期内的标记必须保留')
    } finally {
      Date.now = realDateNow
      if (savedTz === undefined) delete process.env.TZ
      else process.env.TZ = savedTz
      for (const d of markers) {
        try { fs.unlinkSync(path.join(CACHE_DIR, `${prefix}${d}`)) } catch (e) { /* 已删/不存在 */ }
      }
      // 恢复被本用例的清理逻辑删掉的既有标记（内容与名称一并还原）。
      // qodo PR #152-4：只有在路径仍「缺失」时才写回，避免覆盖**别的进程**在测试期间新建/更新的
      // 同名标记（本机没有跨进程锁，测试与应用可能共用默认缓存目录；无条件写回会把它退回陈旧字节）。
      // 缺失时才补，语义就是「撤销本用例的删除」，不会制造回退。
      for (const [name, content] of backup) {
        const target = path.join(CACHE_DIR, name)
        try {
          if (!fs.existsSync(target)) fs.writeFileSync(target, content)
        } catch (e) { /* 恢复失败不影响其它用例 */ }
      }
    }
  })

  await test('磁盘余量低于阈值 → 告警但不阻断主流程', async () => {
    reset()
    setPushUrl('t74_low_disk')
    const fs = require('fs')
    const origStatfs = fs.statfsSync
    const origWarn = console.warn
    const warns = []
    fs.statfsSync = () => ({ bsize: 1024, bavail: 10, blocks: 100 })
    console.warn = (m) => warns.push(String(m))
    try {
      Config.storage.minFreeBytes = 20 * 1024
      fakeData = []
      await xbk.run()
      assert(warns.some(w => w.includes('磁盘余量不足')), `低磁盘应告警: ${warns.join(' | ')}`)
    } finally {
      fs.statfsSync = origStatfs
      console.warn = origWarn
    }
  })

  await test('告警 intervalMs 空字符串 → 回退默认限频不轰炸', async () => {
    reset()
    setPushUrl('t72_alert_interval_empty')
    fakeData = []
    const origInterval = Config.alert.intervalMs
    const origEnabled = Config.alert.enabled
    const alertStatePath = path.join(CACHE_DIR, 'alert.state')
    try { fs.unlinkSync(alertStatePath) } catch (e) { /* 清理旧状态 */ }
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = ''
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期失败 */ }
      assert(pushCalls.some(c => c.text.includes('运行异常')), '首次异常应发告警')
      reset()
      setPushUrl('t72_alert_interval_empty_2')
      Config.alert.enabled = true
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期失败 */ }
      assert(!pushCalls.some(c => c.text.includes('运行异常')), '空字符串应回退默认限频，不应第二次轰炸')
    } finally {
      Config.alert.intervalMs = origInterval
      Config.alert.enabled = origEnabled
      try { fs.unlinkSync(alertStatePath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('告警 enabled=0（数字）→ 关闭不发送（v3.173）', async () => {
    reset()
    setPushUrl('t73_alert_enabled_zero')
    const origEnabled = Config.alert.enabled
    try {
      Config.alert.enabled = 0 // 数字 0（falsy）→ 应关闭（曾 === false/=== 'false' 严格判断漏掉）
      Config.alert.intervalMs = 0 // 不限频，确保只受 enabled 控制
      fakeData = []
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      assert(!pushCalls.find(c => c.text.includes('运行异常')), 'enabled=0 不应发送告警')
      // 字符串 '0' 同样关闭
      pushCalls = []
      Config.alert.enabled = '0'
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      assert(!pushCalls.find(c => c.text.includes('运行异常')), 'enabled="0" 不应发送告警')
      // 对照：true 时发送（确保测试本身有效）
      pushCalls = []
      Config.alert.enabled = true
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      assert(!!pushCalls.find(c => c.text.includes('运行异常')), 'enabled=true 应发送告警（对照）')
    } finally {
      Config.alert.enabled = origEnabled
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('告警 intervalMs 非法字符串 → 回退默认限频不轰炸（v3.167）', async () => {
    reset()
    setPushUrl('t72_alert_interval_abc')
    fakeData = []
    const origInterval = Config.alert.intervalMs
    const origEnabled = Config.alert.enabled
    const alertStatePath = path.join(CACHE_DIR, 'alert.state') // getFilePath 未导出（曾吞错致假清理，残留 lastAt 限频）
    try { require('fs').unlinkSync(alertStatePath) } catch (e) { /* 清残留防限频 */ }
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 'abc' // 非法字符串（环境变量拼错）——曾 'abc' > 0 比较 false → 0 不限频轰炸
      // 第一次：接口异常 → 发告警（lastAt 空，'abc' 回退默认 3600000 仍发首次）
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      const alert1 = pushCalls.find(c => c.text.includes('运行异常'))
      assert(!!alert1, '第一次应发告警')
      // 第二次：限频应生效（'abc' → 默认 3600000，曾 0 不限频每次轰炸）
      reset()
      setPushUrl('t72_alert_interval_abc_2')
      Config.alert.enabled = true // reset() 默认关闭告警（曾漏开 → 第二次不发是 disabled 而非限频，变异抓不住）
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      const alert2 = pushCalls.find(c => c.text.includes('运行异常'))
      assert(!alert2, `非法 intervalMs 应回退默认限频（曾不限频轰炸）: ${pushCalls.map(c => c.text).join('|')}`)
    } finally {
      Config.alert.intervalMs = origInterval
      Config.alert.enabled = origEnabled
      try { require('fs').unlinkSync(alertStatePath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('运行日报：跨天发昨日日报 + 当天累加（v3.125）', async () => {
    reset()
    setPushUrl('t57_report')
    fakeData = [makeItem({ id: 1 })]
    const orig = Config.report.enabled
    Config.report.enabled = true
    const statePath = path.join(CACHE_DIR, 'report.state')
    try {
      // 写昨天状态（有数据）→ 今天首次 run 应发昨日日报
      require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, dedup: 1, filtered: 1, pushed: 3, failed: 0 }))
      await xbk.run()
      const report = pushCalls.find(c => c.text.includes('日报'))
      assert(!!report, '跨天应发昨日日报')
      assert(report.desp.includes('推送 3 条'), `日报应含昨日统计: ${report.desp}`)
      assert(report.desp.includes('条\n\n获取'), `日报 desp 应用段落分隔 \\n\\n（v3.159，与主推送口径一致）: ${JSON.stringify(report.desp.slice(0, 60))}`)
      // 同一天再跑 → 不重复发日报（累加今天；用新 id 防缓存去重）
      pushCalls.length = 0
      fakeData = [makeItem({ id: 2 })]
      await xbk.run()
      assert(!pushCalls.some(c => c.text.includes('日报')), '同一天不重复发日报')
      const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(st.pushed >= 2, `当天应累加 pushed: ${st.pushed}`)
      // v3.174：断言统一使用上海自然日（与 _updateReport 的 Asia/Shanghai 口径一致）。
      // 不能依赖 CI runner 的系统时区；GitHub runner 通常为 UTC，北京时间凌晨会差一天。
      const localToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
      assert(st.date === localToday, `状态日期应为今天(上海): ${st.date} vs ${localToday}`)
    } finally {
      Config.report.enabled = orig
      try { require('fs').unlinkSync(statePath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('日报发送成功 → 今日累计不重复计数（v3.257 修复 089）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    Config.cache.dir = DEFAULT_CACHE_DIR + '_report_nodup_isolated'
    setPushUrl('t62_report_nodup')
    fakeData = [makeItem({ id: 1 })]
    const orig = Config.report.enabled
    Config.report.enabled = true
    const stateDir = path.join(__dirname, Config.cache.dir)
    const statePath = path.join(stateDir, 'report.state')
    try {
      // 写昨天状态（有数据）→ 今天首次 run 发昨日日报
      require('fs').mkdirSync(stateDir, { recursive: true })
      // 清理本测试隔离目录的历史缓存残留（setPushUrl 只清默认 CACHE_DIR；残留 id=1
      // 会让第二次本地运行被去重 → pushed=0 假失败；CI 全新 checkout 不触发）
      try { require('node:fs').unlinkSync(path.join(stateDir, 't62_report_nodup.json')) } catch (e) { /* 不存在则忽略 */ }
      require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, dedup: 1, filtered: 1, pushed: 3, failed: 0 }))
      await xbk.run()
      assert(pushCalls.some(c => c.text.includes('日报')), '跨天应发昨日日报')
      // 等待发送成功回调持久化（Pusher.send resolve 后的 .then）
      await new Promise(r => setTimeout(r, 100))
      const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(st.date !== '2026-08-01', '发送成功应重置日期为今天')
      // v3.257：pend2 已含本次 summary，曾 acc 一次 + pend2 一次 → 双重计数（pushed=2）
      assert(st.pushed === 1, `今日 pushed 应只计本次 summary 一次，实际: ${st.pushed}`)
      assert(st.total === 1, `今日 total 应只计一次，实际: ${st.total}`)
    } finally {
      Config.report.enabled = orig
      Config.cache.dir = originalCacheDir
      try { require('fs').unlinkSync(statePath) } catch (e) { /* 忽略 */ }
    }
  })

  let isolatedReportSeq = 0
  const withIsolatedReportEnv = async (name, testFn) => {
    const originalCacheDir = Config.cache.dir
    const originalToday = xbk.App._reportToday
    const origReportEnabled = Config.report.enabled
    const uniqueSuffix = `_report_iso_${Date.now()}_${++isolatedReportSeq}`
    const cacheDir = `${DEFAULT_CACHE_DIR}${uniqueSuffix}`
    const stateDir = path.join(__dirname, cacheDir)
    const statePath = path.join(stateDir, 'report.state')

    const setupRound = (initialState) => {
      reset()
      Config.cache.dir = cacheDir
      Config.report.enabled = true
      pushCalls.length = 0
      xbk.App._reportMemoryStateByPath.clear()
      require('fs').writeFileSync(statePath, JSON.stringify(initialState))
    }

    try {
      Config.cache.dir = cacheDir
      Config.report.enabled = true
      xbk.App._reportToday = () => '2026-09-02'
      require('fs').mkdirSync(stateDir, { recursive: true })
      await testFn({ statePath, setupRound })
    } finally {
      Config.report.enabled = origReportEnabled
      Config.cache.dir = originalCacheDir
      xbk.App._reportToday = originalToday
      xbk.App._reportMemoryStateByPath.clear()
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  }

  await test('跨天旧主全0 + pending缺失或全零 → 不发送日报且精确保存今日summary六项', async () => {
    await withIsolatedReportEnv('zero_empty', async ({ statePath, setupRound }) => {
      const cases = [
        { name: 'pending缺失', initialState: { date: '2026-09-01', total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 } },
        { name: 'pending全零', initialState: { date: '2026-09-01', total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0, pending: { total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 } } }
      ]

      for (const tc of cases) {
        setupRound(tc.initialState)

        const summary = { total: 11, dedup: 2, filtered: 3, pushed: 4, failed: 1, truncated: 1 }
        await xbk.App._updateReport(summary)

        assert(!pushCalls.some(c => c.text.includes('日报')), `${tc.name}: 跨天旧主全0且无非零pending时不应发送日报`)

        const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
        assert(st.date === '2026-09-02', `${tc.name}: 跨天后日期应更新为今天`)
        assert(st.total === 11, `${tc.name}: total 应精确保存`)
        assert(st.dedup === 2, `${tc.name}: dedup 应精确保存`)
        assert(st.filtered === 3, `${tc.name}: filtered 应精确保存`)
        assert(st.pushed === 4, `${tc.name}: pushed 应精确保存`)
        assert(st.failed === 1, `${tc.name}: failed 应精确保存`)
        assert(st.truncated === 1, `${tc.name}: truncated 应精确保存`)
        assert(st.pending === undefined, `${tc.name}: 切换到今日后不应保留 pending`)
      }
    })
  })

  await test('跨天旧主全0 + 非零pending → 发送昨日日报、结转成功/保留失败且覆盖failed/truncated', async () => {
    await withIsolatedReportEnv('zero_pending', async ({ statePath, setupRound }) => {
      // 1) 成功路径（六项全非零 pending）
      setupRound({
        date: '2026-09-01',
        total: 0,
        dedup: 0,
        filtered: 0,
        pushed: 0,
        failed: 0,
        truncated: 0,
        pending: { total: 10, dedup: 1, filtered: 2, pushed: 5, failed: 2, truncated: 3 }
      })

      const summarySuccess = { total: 7, dedup: 1, filtered: 1, pushed: 4, failed: 1, truncated: 2 }
      await xbk.App._updateReport(summarySuccess)

      const reportSuccess = pushCalls.find(c => c.text.includes('日报'))
      assert(!!reportSuccess, '旧主全0但存在非零pending时应发送昨日日报')
      assert(reportSuccess.text.includes('2026-09-01'), '日报标题应为昨日日期')
      assert(reportSuccess.desp.includes('推送 0 条 | 失败 0 条'), '正文昨日主统计应保持旧主全0')
      assert(reportSuccess.desp.includes('今日待结转：运行 1 轮 | 推送 9 条 | 失败 3 条'), '正文今日待结转应包含旧pending与当前summary合计')

      const stateSuccess = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(stateSuccess.date === '2026-09-02', '成功后日期应切到今天')
      assert(stateSuccess.total === 17, '今日 total 应为 10 + 7')
      assert(stateSuccess.dedup === 2, '今日 dedup 应为 1 + 1')
      assert(stateSuccess.filtered === 3, '今日 filtered 应为 2 + 1')
      assert(stateSuccess.pushed === 9, '今日 pushed 应为 5 + 4')
      assert(stateSuccess.failed === 3, '今日 failed 应为 2 + 1')
      assert(stateSuccess.truncated === 5, '今日 truncated 应为 3 + 2')
      assert(stateSuccess.pending === undefined, '成功后 pending 应被消费移除')

      // 2) 失败路径（仅 failed / truncated 非零 pending）
      setupRound({
        date: '2026-09-01',
        total: 0,
        dedup: 0,
        filtered: 0,
        pushed: 0,
        failed: 0,
        truncated: 0,
        pending: { total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 1, truncated: 2 }
      })
      notifyFail = true

      const summaryFail = { total: 3, dedup: 0, filtered: 0, pushed: 2, failed: 1, truncated: 1 }
      await xbk.App._updateReport(summaryFail)

      const stateFail = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(stateFail.date === '2026-09-01', '发送失败应保持昨日日期以便重试')
      assert(stateFail.total === 0, '旧主 total 保持 0')
      assert(stateFail.pushed === 0, '旧主 pushed 保持 0')
      assert(stateFail.failed === 0, '旧主 failed 保持 0')
      assert(stateFail.truncated === 0, '旧主 truncated 保持 0')
      const pendingFail = stateFail.pending
      assert(pendingFail && pendingFail.date === '', '失败时 pending date 应为空')
      assert(pendingFail.total === 3, '失败时 pending total 应为 3')
      assert(pendingFail.dedup === 0, '失败时 pending dedup 应为 0')
      assert(pendingFail.filtered === 0, '失败时 pending filtered 应为 0')
      assert(pendingFail.pushed === 2, '失败时 pending pushed 应为 2')
      assert(pendingFail.failed === 2, '失败时 pending failed 应为 2')
      assert(pendingFail.truncated === 3, '失败时 pending truncated 应为 3')

      // 3) 后续重试成功（新 run + 新 summary，断言不双计数且成功结转）
      notifyFail = false
      pushCalls.length = 0
      const summaryRetry = { total: 2, dedup: 1, filtered: 0, pushed: 1, failed: 0, truncated: 0 }
      await xbk.App._updateReport(summaryRetry)

      const reportRetry = pushCalls.find(c => c.text.includes('日报'))
      assert(!!reportRetry, '重试成功应发送昨日日报')
      const stateRetrySuccess = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(stateRetrySuccess.date === '2026-09-02', '重试成功后日期切到今天')
      assert(stateRetrySuccess.total === 5, '最终 total 应为 3 + 2')
      assert(stateRetrySuccess.dedup === 1, '最终 dedup 应为 0 + 1')
      assert(stateRetrySuccess.filtered === 0, '最终 filtered 应为 0 + 0')
      assert(stateRetrySuccess.pushed === 3, '最终 pushed 应为 2 + 1')
      assert(stateRetrySuccess.failed === 2, '最终 failed 应为 2 + 0')
      assert(stateRetrySuccess.truncated === 3, '最终 truncated 应为 3 + 0')
      assert(stateRetrySuccess.pending === undefined, '重试成功后 pending 移除')
    })
  })

  await test('日报累计运行轮数并在日报正文展示', async () => {
    await withIsolatedReportEnv('run_count', async ({ statePath, setupRound }) => {
      setupRound({ date: '2026-09-01', total: 1, dedup: 0, filtered: 0, pushed: 1, failed: 0, truncated: 0, runs: 2 })
      await xbk.App._updateReport({ total: 3, dedup: 1, filtered: 1, pushed: 1, failed: 0, truncated: 0 })
      const report = pushCalls.find(c => c.text.includes('日报'))
      assert(report && report.desp.includes('运行 2 轮'), `日报应展示昨日运行轮数: ${report && report.desp}`)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.runs === 1, `跨天后今日运行轮数应为 1，实际 ${state.runs}`)
    })
  })

  await test('通道连续失败告警、恢复告警均限频且不影响主推送语义', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const originalInterval = Config.channelHealth && Config.channelHealth.intervalMs
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 2
      Config.channelHealth.intervalMs = 3600000
      await xbk.App._updateChannelHealth({ successfulChannels: ['pushplus'], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      assert(!pushCalls.some(c => c.text.includes('通道异常')), '首次失败未达到阈值不应告警')
      await xbk.App._updateChannelHealth({ successfulChannels: ['pushplus'], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      assert(pushCalls.some(c => c.text.includes('通道异常')), '连续失败达到阈值应告警')
      pushCalls.length = 0
      await xbk.App._updateChannelHealth({ successfulChannels: ['pushplus'], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      assert(!pushCalls.some(c => c.text.includes('通道异常')), '限频内不得重复告警')
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      assert(pushCalls.some(c => c.text.includes('通道恢复')), '故障通道恢复应告警')
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'channel-health.state'), 'utf8'))
      assert(state.telegram.consecutiveFailures === 0, '恢复后连续失败计数应清零')
      fs.writeFileSync(path.join(stateDir, 'channel-health.state.lock'), 'other process')
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'timeout' }] })
      const lockedState = JSON.parse(fs.readFileSync(path.join(stateDir, 'channel-health.state'), 'utf8'))
      assert(lockedState.telegram.consecutiveFailures === 0, '健康状态被锁定时不得覆盖另一轮的状态更新')
      fs.unlinkSync(path.join(stateDir, 'channel-health.state.lock'))
    } finally {
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      Config.channelHealth.intervalMs = originalInterval
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP2-02：恢复告警发送失败不丢通知（保留 pending 并在下一轮重发）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const originalInterval = Config.channelHealth && Config.channelHealth.intervalMs
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_recover_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const origNotifyFail = notifyFail
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 2
      Config.channelHealth.intervalMs = 3600000
      // 两轮失败让 telegram 达到阈值（失败告警正常送达）
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      // 通道恢复但告警通道挂：恢复通知发送失败，不得落盘清零
      notifyFail = true
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      let state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.telegram.consecutiveFailures === 2, `恢复通知未送达时应保留失败计数，实际 ${state.telegram.consecutiveFailures}`)
      assert(state.telegram.recoverAlertPending === true, '恢复通知未送达时应保留 pending 标记')
      // 告警通道恢复：下一轮必须重发恢复通知，送达后才清零
      notifyFail = false
      pushCalls.length = 0
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      assert(pushCalls.some(c => c.text.includes('通道恢复')), '恢复通知应在下一轮重发')
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.telegram.consecutiveFailures === 0, `送达后应清零，实际 ${state.telegram.consecutiveFailures}`)
      assert(state.telegram.recoverAlertPending === undefined, '送达后应移除 pending 标记')
    } finally {
      notifyFail = origNotifyFail
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      Config.channelHealth.intervalMs = originalInterval
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP-02：通道健康锁陈旧判定须复核持有进程存活', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_lock_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const lockPath = statePath + '.lock'
    const origWarn = console.warn
    const warnings = []
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 1
      console.warn = (...a) => warnings.push(a.join(' '))
      const aged = new Date(Date.now() - 60000)
      // 1) 超龄锁 + 持有进程存活（本进程）→ 不得抢占（否则双进程同时进入临界区）
      fs.writeFileSync(lockPath, String(process.pid))
      fs.utimesSync(lockPath, aged, aged)
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'timeout' }] })
      assert(fs.existsSync(lockPath), '持有进程仍存活时不得抢占超龄健康锁')
      assert(warnings.some(w => w.includes('正由另一轮更新')), `存活持有者应导致本轮跳过: ${warnings.join(' | ')}`)
      assert(!fs.existsSync(statePath), '被锁跳过时不得写入健康状态')
      // 2) 超龄锁 + 持有进程已确认退出 → 正常回收并更新
      fs.writeFileSync(lockPath, '999999999')
      fs.utimesSync(lockPath, aged, aged)
      await xbk.App._updateChannelHealth({ successfulChannels: ['pushplus'], failures: [] })
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.pushplus && state.pushplus.consecutiveFailures === 0, '持有进程已退出应收割超龄锁并正常更新')
      assert(!fs.existsSync(lockPath), '更新完成后应释放锁')
    } finally {
      console.warn = origWarn
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP-02：run.log 锁陈旧判定须复核持有进程存活', async () => {
    const originalCacheDir = Config.cache.dir
    const isolatedDir = `${DEFAULT_CACHE_DIR}_runlog_lock_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const logPath = path.join(stateDir, 'run.log')
    const lockPath = logPath + '.lock'
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(logPath, '存量\n')
      const aged = new Date(Date.now() - 60000)
      // 1) 超龄锁 + 持有进程存活 → 不得抢占，按 fail-open 只追加
      fs.writeFileSync(lockPath, String(process.pid))
      fs.utimesSync(lockPath, aged, aged)
      xbk.App._writeRunLog('存活持有者期间追加\n')
      assert(fs.existsSync(lockPath), '持有进程仍存活时不得抢占 run.log 锁')
      assert(fs.readFileSync(logPath, 'utf8').includes('存活持有者期间追加'), '拿不到锁也应 fail-open 追加日志')
      // 2) 超龄锁 + 持有进程已退出 → 回收并在结束后释放
      fs.writeFileSync(lockPath, '999999999')
      fs.utimesSync(lockPath, aged, aged)
      xbk.App._writeRunLog('已退出持有者\n')
      assert(!fs.existsSync(lockPath), '持有进程已退出应回收并释放 run.log 锁')
    } finally {
      Config.cache.dir = originalCacheDir
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP-02：通道健康告警发送期间不持有跨进程锁（并发的健康更新不被挡住）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_sendlock_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const origWarn = console.warn
    const origDelay = notifyDelayMs
    const warnings = []
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 1
      notifyDelayMs = 300 // 告警发送耗时 300ms：期间锁必须已释放
      console.warn = (...a) => warnings.push(a.join(' '))
      const first = xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'boom' }] })
      await new Promise(r => setTimeout(r, 60)) // 此时第一次调用已进入告警发送阶段
      await xbk.App._updateChannelHealth({ successfulChannels: ['pushplus'], failures: [] })
      assert(!warnings.some(w => w.includes('正由另一轮更新')), `告警发送期间不得持有跨进程锁: ${warnings.join(' | ')}`)
      await first
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.pushplus, '并发的第二轮健康更新不应被告警发送挡住')
      assert(state.telegram && state.telegram.consecutiveFailures === 1, '两轮更新应各自落盘且互不覆盖')
    } finally {
      notifyDelayMs = origDelay
      console.warn = origWarn
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('FX3：重叠运行的恢复告警只发送一条（锁内原子认领 + 租约）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const originalInterval = Config.channelHealth && Config.channelHealth.intervalMs
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_recover_race_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const origSendNotify = notifyMock.sendNotify
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 2
      Config.channelHealth.intervalMs = 3600000
      // 两轮失败把 telegram 抬到阈值
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      pushCalls.length = 0
      // 可控闸门：把「第一次恢复发送」钉死在未完成状态，确定性制造两次运行的重叠
      // （不依赖随机时序——第二次进入时第一次的锁已释放、发送仍未 resolve）
      let enteredResolve
      const entered = new Promise(r => { enteredResolve = r })
      let releaseResolve
      const release = new Promise(r => { releaseResolve = r })
      let recoverSends = 0
      notifyMock.sendNotify = async (text, desp) => {
        pushCalls.push({ text, desp })
        if (text.includes('通道恢复')) {
          recoverSends++
          if (recoverSends === 1) { enteredResolve(); await release }
        }
      }
      const first = xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      await entered // 第一次已进入发送且仍挂起
      const second = xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      await second // 第二次在首次告警未完成时跑完临界区
      releaseResolve()
      await first
      const recovered = pushCalls.filter(c => c.text.includes('通道恢复'))
      assert(recovered.length === 1, `重叠运行下同一次恢复只应发送一条恢复告警，实际 ${recovered.length} 条`)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.telegram.recoverAlertPending === undefined, '送达后应移除 pending 标记')
      assert(state.telegram.consecutiveFailures === 0, `送达后应清零，实际 ${state.telegram.consecutiveFailures}`)
    } finally {
      notifyMock.sendNotify = origSendNotify
      require.cache[notifyPath].exports = notifyMock
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      Config.channelHealth.intervalMs = originalInterval
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('FX3：恢复告警发送失败即释放认领 → 下一轮立即重发（不丢）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const originalInterval = Config.channelHealth && Config.channelHealth.intervalMs
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_recover_release_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const origSendNotify = notifyMock.sendNotify
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 2
      Config.channelHealth.intervalMs = 3600000
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      let recoverFail = true
      notifyMock.sendNotify = async (text, desp) => {
        if (text.includes('通道恢复') && recoverFail) throw new Error('push boom')
        pushCalls.push({ text, desp })
      }
      // 通道恢复但告警通道挂：恢复通知发送失败
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      let state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.telegram.recoverAlertPending === true, '恢复通知未送达时应保留 pending 标记（不丢）')
      assert(state.telegram.consecutiveFailures === 2, `未送达时不得清零，实际 ${state.telegram.consecutiveFailures}`)
      // 告警通道恢复：下一轮必须立即重发——若认领未在失败时释放，这里会被自己的租约挡住（0 条）
      recoverFail = false
      pushCalls.length = 0
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      assert(pushCalls.some(c => c.text.includes('通道恢复')), '发送失败后下一轮应立即重发恢复通知')
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(state.telegram.recoverAlertPending === undefined && state.telegram.consecutiveFailures === 0,
        `重发送达后应清零，实际 ${JSON.stringify(state.telegram)}`)
    } finally {
      notifyMock.sendNotify = origSendNotify
      require.cache[notifyPath].exports = notifyMock
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      Config.channelHealth.intervalMs = originalInterval
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('FX3：租约内的活认领挡住重复重发；超租约陈旧认领可接管（有界可恢复）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_recover_lease_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const origSendNotify = notifyMock.sendNotify
    const baseEntry = () => ({
      consecutiveFailures: 2,
      lastFailureAt: Date.now(),
      lastAlertAt: Date.now(),
      lastRecoveredAt: Date.now(),
      recoverAlertPending: true
    })
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 2
      notifyMock.sendNotify = async (text, desp) => { pushCalls.push({ text, desp }) }
      // ① 持有方仍在发送（认领时间在租约内）→ 本轮不得重发
      fs.writeFileSync(statePath, JSON.stringify({ telegram: { ...baseEntry(), recoverAlertClaim: 'live-token', recoverAlertClaimAt: Date.now() } }))
      pushCalls.length = 0
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      assert(!pushCalls.some(c => c.text.includes('通道恢复')), '租约内的活认领不得被重复认领重发')
      const liveState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(liveState.telegram.recoverAlertPending === true, '活认领期间 pending 必须原样保留')
      // ② 持有方已崩溃（认领时间远超租约）→ 后续轮次必须接管重发，不得永久卡死
      fs.writeFileSync(statePath, JSON.stringify({ telegram: { ...baseEntry(), recoverAlertClaim: 'crashed-token', recoverAlertClaimAt: Date.now() - 3600000 } }))
      pushCalls.length = 0
      await xbk.App._updateChannelHealth({ successfulChannels: ['telegram'], failures: [] })
      assert(pushCalls.some(c => c.text.includes('通道恢复')), '超租约的陈旧认领应被接管并重发（有界可恢复）')
      const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(recoveredState.telegram.recoverAlertClaim !== 'crashed-token' || recoveredState.telegram.recoverAlertPending === undefined,
        `接管后原崩溃令牌不得继续生效，实际 ${JSON.stringify(recoveredState.telegram)}`)
    } finally {
      notifyMock.sendNotify = origSendNotify
      require.cache[notifyPath].exports = notifyMock
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('APP2-01：告警通道不可用时失败告警仍按 intervalMs 限频（按告警尝试计时）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    const originalEnabled = Config.channelHealth && Config.channelHealth.enabled
    const originalFailures = Config.channelHealth && Config.channelHealth.consecutiveFailures
    const originalInterval = Config.channelHealth && Config.channelHealth.intervalMs
    const isolatedDir = `${DEFAULT_CACHE_DIR}_channel_health_alert_${Date.now()}`
    const stateDir = path.join(__dirname, isolatedDir)
    const statePath = path.join(stateDir, 'channel-health.state')
    const origNotifyFail = notifyFail
    try {
      Config.cache.dir = isolatedDir
      fs.mkdirSync(stateDir, { recursive: true })
      Config.channelHealth.enabled = true
      Config.channelHealth.consecutiveFailures = 2
      Config.channelHealth.intervalMs = 3600000
      notifyFail = true // 告警通道本身不可用：告警发送必然失败
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      const afterAlert = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(afterAlert.telegram.lastAlertAt > 0, `告警尝试后应落盘 lastAlertAt（发送成功与否无关），实际 ${afterAlert.telegram.lastAlertAt}`)
      notifyFail = false
      pushCalls.length = 0
      await xbk.App._updateChannelHealth({ successfulChannels: [], failures: [{ channel: 'telegram', message: 'token invalid' }] })
      assert(!pushCalls.some(c => c.text.includes('通道异常')), '限频窗口内不得重复告警（即使上一轮发送失败）')
    } finally {
      notifyFail = origNotifyFail
      Config.cache.dir = originalCacheDir
      Config.channelHealth.enabled = originalEnabled
      Config.channelHealth.consecutiveFailures = originalFailures
      Config.channelHealth.intervalMs = originalInterval
      try { removeDirInRoot(stateDir, __dirname) } catch (e) { /* 忽略 */ }
    }
  })

  await test('告警通道挂 → 不误报"已发送"（v3.145）', async () => {
    reset()
    setPushUrl('t59_alert_nofalse')
    fakeData = []
    const origInterval = Config.alert.intervalMs
    const origEnabled = Config.alert.enabled
    const origLog = console.log
    const logs = []
    console.log = (...a) => logs.push(a.join(' '))
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 0
      fail4xx = true // 接口失败触发告警
      notifyFail = true // 告警通道也挂（sendNotify reject）
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      assert(!logs.some(l => l.includes('已发送运行异常告警')), `通道挂不应误报已发送: ${logs.join(' | ')}`)
    } finally {
      console.log = origLog
      Config.alert.intervalMs = origInterval
      Config.alert.enabled = origEnabled
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('日报通道挂 → 不误报"已发送"（v3.146）', async () => {
    reset()
    setPushUrl('t60_report_nofalse')
    fakeData = [makeItem({ id: 1 })]
    const orig = Config.report.enabled
    const statePath = path.join(CACHE_DIR, 'report.state')
    const origLog = console.log
    const logs = []
    console.log = (...a) => logs.push(a.join(' '))
    try {
      Config.report.enabled = true
      notifyFail = true // 日报通道挂
      require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, pushed: 3, failed: 0 }))
      await xbk.run()
      assert(!logs.some(l => l.includes('已发送昨日运行日报')), `通道挂不应误报已发送日报: ${logs.join(' | ')}`)
    } finally {
      console.log = origLog
      Config.report.enabled = orig
      try { require('fs').unlinkSync(statePath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('告警发送失败 → alert.state 不写（v3.156 #3）', async () => {
    reset()
    setPushUrl('t62_alert_state')
    try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 清残留 */ }
    fakeData = []
    const origInterval = Config.alert.intervalMs
    const origEnabled = Config.alert.enabled
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 60000
      fail4xx = true // 接口失败触发告警
      notifyFail = true // 告警通道也挂（sendNotify reject）
      try { await xbk.run() } catch (e) { /* 预期抛错 */ }
      await new Promise(r => setTimeout(r, 50)) // 等 sendNotify 微任务（fire-and-forget）
      const statePath = path.join(CACHE_DIR, 'alert.state')
      assert(!fs.existsSync(statePath), `发送失败不应写状态(曾写 lastAt 限频挡重试): ${fs.existsSync(statePath)}`)
    } finally {
      Config.alert.intervalMs = origInterval
      Config.alert.enabled = origEnabled
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('状态文件 rename 失败 → 保留旧 JSON，不留下半写状态（v3.185）', async () => {
    reset()
    setPushUrl('t62_state_atomic')
    const statePath = path.join(CACHE_DIR, 'alert.state')
    const oldState = { lastAt: 123456789 }
    const origRename = fs.renameSync
    const origEnabled = Config.alert.enabled
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 60000
      fs.writeFileSync(statePath, JSON.stringify(oldState))
      fs.renameSync = (from, to) => {
        if (to === statePath) throw new Error('模拟状态 rename 失败')
        return origRename(from, to)
      }
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 接口失败预期抛错 */ }
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert(st.lastAt === oldState.lastAt, `rename 失败不应破坏旧状态: ${JSON.stringify(st)}`)
      assert(!fs.existsSync(statePath + '.tmp'), '状态临时文件应清理')
      // 同一进程第二次异常不应因状态落盘失败而再次轰炸告警。
      const callsAfterFirst = notifyCalls
      try { await xbk.run() } catch (e) { /* 接口失败预期抛错 */ }
      assert(notifyCalls === callsAfterFirst, '状态落盘失败后应使用内存限频，不重复发送告警')
    } finally {
      fs.renameSync = origRename
      Config.alert.enabled = origEnabled
      try { fs.unlinkSync(statePath) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(statePath + '.tmp') } catch (e) { /* 忽略 */ }
    }
  })

  await test('日报发送失败 → report.state date 不重置（v3.156 #3）', async () => {
    reset()
    const originalCacheDir = Config.cache.dir
    Config.cache.dir = DEFAULT_CACHE_DIR + '_report_state_isolated'
    setPushUrl('t63_report_state')
    fakeData = [makeItem({ id: 1 })]
    const orig = Config.report.enabled
    const stateDir = path.join(__dirname, Config.cache.dir)
    const statePath = path.join(stateDir, 'report.state')
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      Config.report.enabled = true
      notifyFail = true // 日报通道挂
      require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, pushed: 3, failed: 0 }))
      await xbk.run()
      await new Promise(r => setTimeout(r, 50)) // 等 sendNotify 微任务（fire-and-forget）
      const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(st.date === '2026-08-01', `发送失败不应重置 date(曾直接跨天丢日报): ${st.date}`)
      assert(st.total >= 5, '本次数据应累计进旧 state(不丢)')
    } finally {
      Config.report.enabled = orig
      Config.cache.dir = originalCacheDir
      try { require('fs').unlinkSync(statePath) } catch (e) { /* 忽略 */ }
      try { fs.rmdirSync(stateDir) } catch (e) { /* 忽略 */ }
    }
  })

  await test('retry 字符串配置生效（v3.158 #21）', async () => {
    reset()
    setPushUrl('t64_retry_str')
    const orig = Config.api.retry
    try {
      Config.api.retry = '3' // 环境变量字符串(区分默认2)
      failCount = 99 // 一直失败直到重试耗尽
      fakeData = [makeItem({ id: 1 })]
      let crashed = false
      try { await xbk.run() } catch (e) { crashed = true }
      assert(gotCalls.length === 4, `字符串 retry='3' 应重试3次(共4请求)，实际${gotCalls.length}`)
      assert(crashed, '重试耗尽应抛错')
    } finally {
      Config.api.retry = orig
    }
  })

  await test('alert.enabled 字符串 "false" 关闭告警（v3.158 #28）', async () => {
    reset()
    setPushUrl('t65_alert_str')
    fakeData = []
    const orig = Config.alert.enabled
    try {
      Config.alert.enabled = 'false' // 环境变量字符串
      Config.alert.intervalMs = 0
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期 */ }
      assert(!pushCalls.some(c => c.text.includes('运行异常')), `字符串 false 应关闭告警: ${pushCalls.length}`)
    } finally {
      Config.alert.enabled = orig
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('Config.alert.enabled=" FALSE " 时不发告警（C016）', async () => {
    reset()
    setPushUrl('t65_alert_str_space')
    fakeData = []
    const orig = Config.alert.enabled
    try {
      Config.alert.enabled = ' FALSE ' // 环境变量字符串带空格/大写，应关闭
      Config.alert.intervalMs = 0
      fail4xx = true
      try { await xbk.run() } catch (e) { /* 预期 */ }
      assert(!pushCalls.some(c => c.text.includes('运行异常')), `" FALSE " 应关闭告警: ${pushCalls.length}`)
    } finally {
      Config.alert.enabled = orig
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('parallelLimit 字符串配置生效（v3.158 #24）', async () => {
    reset()
    setPushUrl('t66_plimit_str')
    const orig = Config.push.parallelLimit
    try {
      Config.push.mode = 'parallel'
      Config.push.parallelLimit = '1' // 字符串 → 每批 1 条
      fakeData = [1, 2, 3].map(i => makeItem({ id: i }))
      await xbk.run()
      assert(pushCalls.length === 3, 'parallelLimit=\'1\' 应全推 3 条')
      assert(Config.push.parallelLimit === '1', '不应修改用户配置')
    } finally {
      Config.push.parallelLimit = orig
      Config.push.mode = 'parallel'
    }
  })

  await test('单次推送上限 maxPerRun 防推送风暴（v3.129）', async () => {
    reset()
    setPushUrl('t58_maxperrun')
    const orig = Config.push.maxPerRun
    const origInt = Config.timing.pushInterval; const origWait = Config.timing.finalWait
    // v3.171 性能：3 次 run 各推 100 条 × 100ms 间隔曾耗时 ~29s——截断逻辑验证不依赖真实间隔
    Config.timing.pushInterval = 0
    Config.timing.finalWait = 0
    try {
      // 150 条 → 只推 100
      Config.push.maxPerRun = 100
      fakeData = []
      for (let i = 0; i < 150; i++) fakeData.push(makeItem({ id: i + 1000 }))
      const summary = await xbk.run()
      assert(summary.pushed === 100, `应只推 100 条: ${JSON.stringify(summary)}`)
      assert(summary.total === 150, 'total 仍是拉取数 150')
      assert(summary.truncated === 50, `截断应计入统计: ${JSON.stringify(summary)}`) // v3.145
      // 正常 20 条不截断
      reset()
      setPushUrl('t58b_maxperrun_ok')
      Config.push.maxPerRun = 100
      fakeData = []
      for (let i = 0; i < 20; i++) fakeData.push(makeItem({ id: i + 2000 }))
      const s2 = await xbk.run()
      assert(s2.pushed === 20, `正常 20 条应全推: ${JSON.stringify(s2)}`)
      // v3.134：截断未推的不写缓存 → 下次运行推剩余（不丢不重复）
      reset()
      setPushUrl('t58c_trunc_retry')
      Config.push.maxPerRun = 100
      fakeData = []
      for (let i = 0; i < 150; i++) fakeData.push(makeItem({ id: i + 3000 }))
      const s3 = await xbk.run() // 第一次：截断推 100
      assert(s3.pushed === 100, `首次应推 100: ${JSON.stringify(s3)}`)
      const cached1 = readCacheFile('t58c_trunc_retry')
      assert(cached1.length === 100, `首次只缓存推的 100（截断的 50 不缓存）: ${cached1.length}`)
      reset()
      setPushUrl('t58c_trunc_retry')
      fakeData = []
      for (let i = 0; i < 150; i++) fakeData.push(makeItem({ id: i + 3000 }))
      const s4 = await xbk.run() // 第二次：缓存去重 100 → 剩 50 → 推 50（不重复）
      assert(s4.pushed === 50, `二次应推剩余 50: ${JSON.stringify(s4)}`)
      assert(s4.dedup === 100, `二次去重 100: ${JSON.stringify(s4)}`)
    } finally {
      Config.push.maxPerRun = orig
      Config.timing.pushInterval = origInt
      Config.timing.finalWait = origWait
    }
  })

  await test('接口异常返回海量数据 → 判重不卡死（v3.179 缓存索引化）', async () => {
    reset()
    setPushUrl('t58d_massive')
    const orig = Config.push.maxPerRun
    const origInt = Config.timing.pushInterval; const origWait = Config.timing.finalWait
    Config.push.maxPerRun = 100
    Config.timing.pushInterval = 0
    Config.timing.finalWait = 0
    try {
      // 2 万条全不同数据（修复前逐条 has() O(N×M) 约 12s；修复后索引化 ~O(N+M)）
      fakeData = []
      for (let i = 0; i < 20000; i++) fakeData.push(makeItem({ id: i + 100000 }))
      const t0 = Date.now()
      const summary = await xbk.run()
      const ms = Date.now() - t0
      assert(summary.pushed === 100, `海量数据应只推 maxPerRun=100: ${JSON.stringify(summary)}`)
      assert(summary.total === 20000, `total 应 20000: ${JSON.stringify(summary)}`)
      assert(summary.truncated === 19900, `截断应 19900: ${JSON.stringify(summary)}`)
      assert(ms < 5000, `海量判重应 <5s（修复前 ~12s）: 实际 ${ms}ms`)
    } finally {
      Config.push.maxPerRun = orig
      Config.timing.pushInterval = origInt
      Config.timing.finalWait = origWait
    }
  })

  await test('maxPerRun 非正整数/小数配置 → 回退默认且不跳过推送', async () => {
    reset()
    setPushUrl('t70b_maxperrun_invalid')
    const orig = Config.push.maxPerRun
    const origInt = Config.timing.pushInterval; const origWait = Config.timing.finalWait
    Config.timing.pushInterval = 0
    Config.timing.finalWait = 0
    try {
      // 0.5 若先 Math.floor 会变成 0，导致 1 条消息被截断且不推送；现在必须回退默认 100
      for (const [idx, invalid] of ['0.5', 0.5, '2.5', 2.5, '0', 0, '-1', 'abc', ''].entries()) {
        reset()
        setPushUrl('t70b_maxperrun_invalid_' + idx)
        Config.timing.pushInterval = 0
        Config.timing.finalWait = 0
        Config.push.maxPerRun = invalid
        fakeData = [{ id: 4000, title: 'T', content: 'c', catename: 'c', url: 'https://x.com/1', content_html: '<p>c</p>' }]
        const summary = await xbk.run()
        assert(summary.pushed === 1 && summary.truncated === 0,
                `非法 maxPerRun=${JSON.stringify(invalid)} 应回退默认并推送: ${JSON.stringify(summary)}`)
      }
      Config.push.maxPerRun = '2.5'
      fakeData = [{ id: 4001, title: 'T2', content: 'c', catename: 'c', url: 'https://x.com/2', content_html: '<p>c</p>' }]
      const s2 = await xbk.run()
      assert(s2.pushed === 1 && s2.truncated === 0, `小数 maxPerRun 不应变成 0: ${JSON.stringify(s2)}`)
    } finally {
      Config.push.maxPerRun = orig
      Config.timing.pushInterval = origInt
      Config.timing.finalWait = origWait
    }
  })

  await test('告警/日报触发时通道失败 → 无 unhandledRejection（v3.135）', async () => {
    reset()
    setPushUrl('t59_alert_unhandled')
    fakeData = []
    Config.alert.enabled = true
    Config.alert.intervalMs = 0 // 不限频
    let unhandled = 0
    const handler = () => unhandled++
    process.on('unhandledRejection', handler)
    try {
      fail4xx = true // 接口 404 → run 抛错 → _sendAlert
      notifyFail = true // 告警通道 mock reject
      let threw = false
      try { await xbk.run() } catch (e) { threw = true }
      assert(threw, '接口异常应抛错')
      await new Promise(r => setTimeout(r, 100)) // 等 fire-and-forget 完成
      assert(unhandled === 0, `告警通道失败不应 unhandledRejection: ${unhandled}`)
    } finally {
      process.removeListener('unhandledRejection', handler)
      Config.alert.enabled = false
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('损坏 report.state 非对象 → 保留原文件并跳过日报更新（v3.270）', async () => {
    reset()
    setPushUrl('t63_report_state_corrupt')
    const statePath = path.join(CACHE_DIR, 'report.state')
    const orig = Config.report.enabled
    try {
      Config.report.enabled = true
      xbk.App._reportMemoryStateByPath.delete(statePath)
      try { fs.unlinkSync(statePath) } catch (e) {}
      fs.writeFileSync(statePath, JSON.stringify('corrupt-state'))
      xbk.App._reportMemoryStateByPath.delete(statePath)
      fakeData = [makeItem({ id: 1 })]
      await xbk.run()
      assert(fs.readFileSync(statePath, 'utf8') === JSON.stringify('corrupt-state'), '损坏状态原文应保留，不应覆盖为空状态')
    } finally {
      Config.report.enabled = orig
      try { fs.unlinkSync(statePath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('report.state 非法日期字符串 → 保留原文件并跳过更新（v3.271）', async () => {
    reset(); setPushUrl('t271_report_bad_date')
    const statePath = path.join(CACHE_DIR, 'report.state'); const orig = Config.report.enabled
    try {
      Config.report.enabled = true
      for (const date of ['garbage', '2026-99-99', '2026-02-29']) {
        const original = JSON.stringify({ date, total: 9, pushed: 9 })
        xbk.App._reportMemoryStateByPath.delete(statePath); fs.writeFileSync(statePath, original)
        fakeData = [makeItem({ id: Date.now() + date.length })]; await xbk.run()
        assert(fs.readFileSync(statePath, 'utf8') === original, `非法日期应保留原文件: ${date}`)
      }
    } finally { Config.report.enabled = orig; xbk.App._reportMemoryStateByPath.delete(statePath); try { fs.unlinkSync(statePath) } catch (e) {} }
  })

  await test('report.state date 非字符串 → 保留原文件并跳过更新（v3.270）', async () => {
    reset()
    setPushUrl('t270_report_date_invalid')
    const statePath = path.join(CACHE_DIR, 'report.state')
    const orig = Config.report.enabled
    const original = JSON.stringify({ date: 123, total: 9, pushed: 9 })
    try {
      Config.report.enabled = true
      xbk.App._reportMemoryStateByPath.delete(statePath)
      fs.writeFileSync(statePath, original)
      fakeData = [makeItem({ id: 1 })]
      await xbk.run()
      assert(fs.readFileSync(statePath, 'utf8') === original, '非法 date 状态应保留原文件')
    } finally {
      Config.report.enabled = orig
      xbk.App._reportMemoryStateByPath.delete(statePath)
      try { fs.unlinkSync(statePath) } catch (e) {}
    }
  })

  await test('连续运行：report.state 累加/缓存去重/状态文件正确（v3.141）', async () => {
    reset()
    setPushUrl('t60_cron')
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 })]
    const orig = Config.report.enabled
    Config.report.enabled = true
    const statePath = path.join(CACHE_DIR, 'report.state')
    try {
      try { require('fs').unlinkSync(statePath) } catch (e) { /* 不存在则忽略 */ }
      // 第 1 次：推 2 条
      const s1 = await xbk.run()
      assert(s1.pushed === 2, `第1次应推2: ${JSON.stringify(s1)}`)
      // 第 2 次：同数据 → 缓存去重 → 推 0
      const s2 = await xbk.run()
      assert(s2.pushed === 0 && s2.dedup === 2, `第2次应全去重: ${JSON.stringify(s2)}`)
      // 第 3 次：新数据 1 条 + 旧 1 条 → 推 1 去重 1
      fakeData = [makeItem({ id: 1 }), makeItem({ id: 3 })]
      const s3 = await xbk.run()
      assert(s3.pushed === 1 && s3.dedup === 1, `第3次应推1去重1: ${JSON.stringify(s3)}`)
      // report.state：3 次累加 pushed = 2+0+1 = 3
      const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'))
      assert(st.pushed === 3, `report.state 应累加 3 条: ${JSON.stringify(st)}`)
      assert(st.total === 6, `report.state total 应 2×3 次=6: ${JSON.stringify(st)}`)
    } finally {
      Config.report.enabled = orig
      try { require('fs').unlinkSync(statePath) } catch (e) { /* 忽略 */ }
    }
  })

  // ==================== v3.159：BUG_HUNT 候选修复验证 ====================
  await test('过滤规则变更 → 清除过滤写入缓存，改宽后旧条目重新推送（v3.159）', async () => {
    reset()
    setPushUrl('t67_filter_change')
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    try { require('fs').unlinkSync(hashPath) } catch (e) { /* 忽略 */ }
    try {
      // 第一次运行：屏蔽「京东」→ 京东条目被过滤写入缓存（_f 标记）
      Config.filter.pingbibiaoti = '京东'
      fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' }), makeItem({ id: 3, title: '拼多多砍价' })]
      let s = await xbk.run()
      assert(s.pushed === 2 && s.filtered === 1, `首次应推2过滤1: ${JSON.stringify(s)}`)
      const cached1 = readCacheFile('t67_filter_change')
      const marked = cached1.filter(m => m._f === true)
      assert(marked.length === 1 && marked[0].id === 1,
            `缓存应有 1 条过滤标记(京东 id=1): ${cached1.map(m => `${m.id}:_f=${m._f}`).join(',')}`)

      // 第二次运行：改宽（不屏蔽）→ 过滤写入缓存失效 → 京东重新评估并推送
      Config.filter.pingbibiaoti = ''
      pushCalls = []
      s = await xbk.run()
      assert(s.pushed === 1 && s.filtered === 0 && s.dedup === 2,
            `改宽后应重推 1 条(京东)，其余去重: ${JSON.stringify(s)}`)
      assert(pushCalls.length === 1 && pushCalls[0].desp.includes('京东神券'),
            `京东应重新推送: ${pushCalls.map(c => c.text).join('|')}`)
      const cached2 = readCacheFile('t67_filter_change')
      assert(cached2.length === 3 && cached2.every(m => m._f !== true),
            `过滤标记应已清除（重新推送的 id=1 以成功态写回）: ${cached2.map(m => `${m.id}:_f=${m._f}`).join(',')}`)
    } finally {
      try { require('fs').unlinkSync(hashPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('切换 pushUrl 后旧文件 _f 仍能随规则变更重评（v3.262 P2）', async () => {
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    try { fs.unlinkSync(hashPath) } catch (e) { /* 忽略 */ }
    try {
      // ① A 源 + 屏蔽「京东」→ id=1 过滤写入 _f
      reset()
      setPushUrl('t67_filter_switch_a')
      Config.filter.pingbibiaoti = '京东'
      fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' })]
      let s = await xbk.run()
      assert(s.pushed === 1 && s.filtered === 1, `首次应推1过滤1: ${JSON.stringify(s)}`)
      const markedA = readCacheFile('t67_filter_switch_a').filter(m => m._f === true)
      assert(markedA.length === 1 && markedA[0].id === 1, `A 文件应有 id=1 的 _f 条目: ${JSON.stringify(markedA)}`)

      // ② 规则改宽 + 切到 B 源 → hash 在 B 上推进（B 无 _f，清理空转）
      reset()
      setPushUrl('t67_filter_switch_b')
      Config.filter.pingbibiaoti = ''
      fakeData = [makeItem({ id: 1 })]
      s = await xbk.run()
      assert(s.pushed === 1, `B 源应正常推送: ${JSON.stringify(s)}`)

      // ③ 切回 A 源（规则仍改宽）→ 旧 _f 必须被重评并推送（修复前 lastHash 相同被跳过 → 静默漏推）
      reset()
      setPushUrl('t67_filter_switch_a')
      fakeData = [makeItem({ id: 1 })]
      s = await xbk.run()
      assert(s.pushed === 1 && s.filtered === 0, `切回 A 后 id=1 应重评推送: ${JSON.stringify(s)}`)
      assert(pushCalls.length === 1 && pushCalls[0].desp.includes('京东神券'),
            `京东应重新推送: ${pushCalls.map(c => c.text).join('|')}`)
    } finally {
      Config.filter.pingbibiaoti = ''
      try { fs.unlinkSync(hashPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('缺失/空 filter.hash → 历史 _f 重新评估并重推（v3.270）', async () => {
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    const orig = Config.filter.pingbibiaoti
    try {
      for (const [i, text] of ['', '   '].entries()) {
        reset()
        const suffix = `t270_filter_hash_missing_${i}`
        setPushUrl(suffix)
        Config.filter.pingbibiaoti = '屏蔽词'
        fakeData = [makeItem({ id: 100 + i, title: '屏蔽词内容' })]
        await xbk.run()
        assert(readCacheFile(suffix).some(m => m._f === true), '首次应留下 _f')
        fs.writeFileSync(hashPath, text, 'utf8')
        reset()
        Config.filter.pingbibiaoti = ''
        fakeData = [makeItem({ id: 100 + i, title: '屏蔽词内容' })]
        await xbk.run()
        assert(pushCalls.length === 1, `hash=${JSON.stringify(text)} 时应重推`)
        assert(!readCacheFile(suffix).some(m => m._f === true), '重推后不应保留 _f')
      }
    } finally {
      Config.filter.pingbibiaoti = orig
      try { fs.unlinkSync(hashPath) } catch (e) {}
    }
  })

  await test('过滤缓存清理写入失败 → filter.hash 不推进，下次可重试（P2 防回归）', async () => {
    reset()
    setPushUrl('t67_filter_hash_write_fail')
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    const origFilter = Config.filter.pingbibiaoti
    const origRename = fs.renameSync
    try {
      try { fs.unlinkSync(hashPath) } catch (e) { /* 首次运行无 hash */ }
      Config.filter.pingbibiaoti = '京东'
      fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' })]
      await xbk.run()
      const oldHash = fs.readFileSync(hashPath, 'utf8')

      Config.filter.pingbibiaoti = ''
      let failedOnce = true
      fs.renameSync = (from, to) => {
        if (failedOnce && String(to).endsWith('t67_filter_hash_write_fail.json')) {
          failedOnce = false
          throw new Error('模拟过滤缓存 rename 失败')
        }
        return origRename(from, to)
      }
      fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' })]
      await xbk.run()
      assert(fs.readFileSync(hashPath, 'utf8') === oldHash, '过滤缓存清理失败时 filter.hash 不应推进')
    } finally {
      fs.renameSync = origRename
      Config.filter.pingbibiaoti = origFilter
      try { fs.unlinkSync(hashPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('pingbitime 变更 → 清除过滤写入缓存并重推（#7 v3.161）', async () => {
    reset()
    setPushUrl('t68_pb_change')
    const origPb = Config.filter.pingbitime
    const fiveDaysAgo = Date.now() - 5 * 86400000
    try {
      Config.filter.pingbitime = '30' // 注册5天 < 30 → 被天数过滤
      fakeData = [makeItem({ id: 1, louzhuregtime: fiveDaysAgo })]
      await xbk.run()
      const cached1 = readCacheFile('t68_pb_change')
      assert(cached1.some(m => m._f === true), '被过滤条目应写 _f 标记')
      // 放宽 pingbitime → filterHash 变化 → 清除 _f → 重推
      reset()
      setPushUrl('t68_pb_change')
      Config.filter.pingbitime = '3' // 5天 > 3 → 应推送
      fakeData = [makeItem({ id: 1, louzhuregtime: fiveDaysAgo })]
      await xbk.run()
      const cached2 = readCacheFile('t68_pb_change')
      assert(pushCalls.length === 1, `放宽后应重推(不再被缓存判重跳过)，实际${pushCalls.length}`)
      assert(!cached2.some(m => m._f === true), '重推后 _f 标记应清除')
    } finally {
      Config.filter.pingbitime = origPb
    }
  })

  await test('filter.hash 折入「规则实际编译生效」维度（FILTER-01/RULES-05）', async () => {
    // 反例（改动前）：filter.hash 只由配置字节驱动——re2 缺失或规则被 ReDoS 守卫丢弃时过滤面变宽
    // 但哈希不变，已打 _f 的条目（上方 t68 场景）永不重评。本用例锚定「App 真的把编译生效维度
    // 折进了写入磁盘的哈希」，且该维度在同一环境内稳定（不得每轮变化导致每轮清 _f）。
    reset()
    setPushUrl('t_compile_dim')
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    const origFilter = Config.filter.pingbibiaoti
    try {
      try { fs.unlinkSync(hashPath) } catch (e) { /* 首次运行无 hash */ }
      Config.filter.pingbibiaoti = '不匹配任何标题的关键词'
      fakeData = [makeItem({ id: 1, title: '普通标题' })]
      await xbk.run()
      const stored1 = fs.readFileSync(hashPath, 'utf8').trim().split('\n')[1]
      assert(stored1 !== xbk.filterHash(Config.filter, Config.keyword.zkt_gjc),
        'app 写入的 filter.hash 必须含配置字节之外的「编译生效」维度（两参哈希 != 落盘哈希）')
      // 同配置重复运行：维度稳定（否则每轮 _f 全清、每轮全量重评）
      reset()
      setPushUrl('t_compile_dim')
      Config.filter.pingbibiaoti = '不匹配任何标题的关键词'
      fakeData = [makeItem({ id: 1, title: '普通标题' })]
      await xbk.run()
      const stored2 = fs.readFileSync(hashPath, 'utf8').trim().split('\n')[1]
      assert(stored2 === stored1, `编译生效维度必须随环境稳定，实际 ${stored1} → ${stored2}`)
    } finally {
      Config.filter.pingbibiaoti = origFilter
      try { fs.unlinkSync(hashPath) } catch (e) { /* 忽略 */ }
    }
  })

  await test('saveBatch 落盘失败 → 摘要/日志可观测（APP-03）', async () => {
    // 反例（改动前）：xbk_app.js 丢弃 MessageStore.saveBatch 的返回值，落盘失败时 summary 仍报
    // 「成功」、run.log 无任何痕迹，运维看不到「本轮推送成功但成功记录没落盘」（下次运行会重推）。
    // 本用例把真 saveBatch 打成返回 false（生产实现落盘失败时的返回值，见 xbk_message_store.js），
    // 断言：① summary.cacheSaved === false；② 控制台告警；③ run.log 有 WARN 行 + cachesaved=0。
    // 撤掉 app 侧消费（回到 `MessageStore.saveBatch(toCache, cacheName)` 裸调用）→ 三条断言全红。
    reset()
    setPushUrl('t_app03_cache_fail')
    const origSaveBatch = xbk.MessageStore.saveBatch
    const origWarn = console.warn
    const warns = []
    const runLogPath = path.join(CACHE_DIR, 'run.log')
    try {
      xbk.MessageStore.saveBatch = () => false
      console.warn = (m) => warns.push(String(m))
      try { fs.unlinkSync(runLogPath) } catch (e) { /* 首次无日志 */ }
      fakeData = [makeItem({ id: 1 })]
      const summary = await xbk.run()
      assert(summary.cacheSaved === false, `落盘失败时 summary.cacheSaved 必须为 false，实际 ${JSON.stringify(summary.cacheSaved)}`)
      assert(warns.some(w => w.includes('缓存落盘失败')), `落盘失败应告警，实际告警: ${warns.join(' | ')}`)
      const log = fs.readFileSync(runLogPath, 'utf8')
      assert(log.includes('WARN 缓存落盘失败'), `run.log 应含落盘失败 WARN 行: ${log.split('\n').slice(-3).join(' | ')}`)
      assert(log.includes('cachesaved=0'), 'run.log 摘要行应含 cachesaved=0')
    } finally {
      xbk.MessageStore.saveBatch = origSaveBatch
      console.warn = origWarn
    }
    // 对照：落盘成功时 summary.cacheSaved === true（防止断言恒真）
    reset()
    setPushUrl('t_app03_cache_ok')
    fakeData = [makeItem({ id: 2 })]
    const okSummary = await xbk.run()
    assert(okSummary.cacheSaved === true, `落盘成功时 summary.cacheSaved 应为 true，实际 ${JSON.stringify(okSummary.cacheSaved)}`)
  })

  await test('api.timeout 字符串配置生效（#8 v3.162）', async () => {
    reset()
    setPushUrl('t69_timeout_str')
    const orig = Config.api.timeout
    const origWarn = console.warn
    const warns = []
    console.warn = (m) => warns.push(String(m))
    try {
      Config.api.timeout = '5000' // 环境变量字符串（曾回退 15s）
      fakeData = [makeItem({ id: 1 })]
      await xbk.run()
      const call = gotCalls.find(c => c.url.includes('t69_timeout_str'))
      assert(call && call.opts && call.opts.timeout === 5000, `字符串 timeout 应生效为 5000: ${call && call.opts && call.opts.timeout}`)
      // v3.175：字符串配置（环境变量场景）不应误报「不是有效值」（曾 Number.isFinite('5000')=false 假警告）
      assert(!warns.some(w => w.includes('api.timeout') && w.includes('不是有效值')),
            `字符串 timeout 不应误报警告: ${warns.filter(w => w.includes('timeout')).join(' | ')}`)
    } finally {
      console.warn = origWarn
      Config.api.timeout = orig
    }
  })

  await test('api.timeout 非正数 → HTTP 请求回退默认 5000（v3.270）', async () => {
    for (const bad of [0, -1, '0', '-1']) {
      reset()
      setPushUrl(`t270_timeout_${String(bad).replace('-', 'neg')}`)
      Config.api.timeout = bad
      fakeData = [makeItem({ id: 1 })]
      try {
        await xbk.run()
        const call = gotCalls.find(c => c.url.includes('t270_timeout_'))
        assert(call && call.opts.timeout === 5000, `timeout=${bad} 应回退 5000: ${JSON.stringify(call && call.opts)}`)
      } finally { Config.api.timeout = 5000 }
    }
  })

  await test('数值配置为 Symbol → 回退默认且主流程不崩（#14）', async () => {
    reset()
    setPushUrl('t73_num_symbol')
    const orig = Config.push.maxPerRun
    try {
      Config.push.maxPerRun = Symbol('bad-maxPerRun')
      fakeData = [makeItem({ id: 1 })]
      await xbk.run()
      assert(pushCalls.length === 1, `Symbol 数值配置回退默认后应正常推送，实际${pushCalls.length}`)
    } finally {
      Config.push.maxPerRun = orig
    }
  })

  await test('pingbitime 为 Symbol → validateConfig 链路安全放行（#15）', async () => {
    reset()
    setPushUrl('t74_pingbitime_symbol')
    const orig = Config.filter.pingbitime
    try {
      Config.filter.pingbitime = Symbol('bad-pingbitime')
      fakeData = [makeItem({ id: 1 })]
      await xbk.run()
      assert(pushCalls.length === 1, `Symbol pingbitime 不应阻断主流程，实际${pushCalls.length}`)
    } finally {
      Config.filter.pingbitime = orig
    }
  })

  await test('配置告警脏值 Symbol → cache/domain/mode 链路不崩（#16）', async () => {
    reset()
    setPushUrl('t75_config_warning_symbol')
    const original = {
      maxSize: Config.cache.maxSize,
      domain: Config.domain,
      mode: Config.push.mode
    }
    try {
      Config.cache.maxSize = Symbol('bad-maxSize')
      Config.domain = Symbol('bad-domain')
      Config.push.mode = Symbol('bad-mode')
      fakeData = [makeItem({ id: 1 })]
      await xbk.run()
      assert(pushCalls.length === 1, `脏配置告警不应阻断主流程，实际${pushCalls.length}`)
    } finally {
      Config.cache.maxSize = original.maxSize
      Config.domain = original.domain
      Config.push.mode = original.mode
    }
  })

  await test('推送全部失败 → 触发告警调用 + run.log ERROR（#9 v3.163）', async () => {
    reset()
    setPushUrl('t70_pushfail')
    const orig = Config.alert.enabled
    const logPath = path.join(CACHE_DIR, 'run.log')
    try { require('fs').unlinkSync(logPath) } catch (e) { /* 忽略 */ }
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 0
      // 推送全部失败（notify mock 抛错）→ pushOne 全 catch → 触发 _sendAlert + ERROR 日志
      // v3.174：notifyFailAt=1 第 1 次主推送失败、第 2 次（告警）成功；notifyDelayMs=50 模拟告警慢——
      // await 时 run 等待告警完成（fire-and-forget 会提前返回，pushCalls 未达）
      notifyFailAt = 1
      notifyDelayMs = 50
      fakeData = [makeItem({ id: 1 })]
      const summary = await xbk.run()
      assert(summary && summary.failed === 1 && summary.pushed === 0, '推送全失败摘要应保留失败统计')
      assert(Array.isArray(summary.failures) && summary.failures.length === 1 &&
            summary.failures[0].message.includes('push boom'),
            `推送全失败摘要应保留结构化失败原因: ${JSON.stringify(summary)}`)
      const log = require('fs').readFileSync(logPath, 'utf8')
      assert(log.includes('ERROR'), `推送全失败应写 ERROR 行: ${log.slice(-100)}`)
      assert(log.includes('推送全部失败'), 'ERROR 行应标明推送全部失败')
      // v3.170：成功路径 _sendAlert 也 await——告警应在 run 返回前完成
      assert(pushCalls.some(c => c.text && String(c.text).includes('运行异常')),
        '告警应在 run 返回前完成（v3.170 await；曾 fire-and-forget 时序不定）')
    } finally {
      Config.alert.enabled = orig
      notifyFailAt = -1
      notifyDelayMs = 0
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('接口异常告警在 run 返回前完成（#10 v3.164，防 exit 杀死）', async () => {
    reset()
    setPushUrl('t71_alert_await')
    fakeData = []
    const origInterval = Config.alert.intervalMs
    const origEnabled = Config.alert.enabled
    try {
      Config.alert.enabled = true
      Config.alert.intervalMs = 0
      fail4xx = true // 接口失败 → 触发告警
      notifyDelayMs = 50 // 模拟真实网络往返：告警 sendNotify 延迟 50ms（fire-and-forget 会被 process.exit(1) 杀死）
      let crashed = false
      try { await xbk.run() } catch (e) { crashed = true }
      assert(crashed, '接口失败应抛错')
      // v3.164：catch 里 await _sendAlert → run 返回时告警已完成（曾 fire-and-forget → exit 杀死告警 HTTP）
      const alertSent = pushCalls.some(c => c.text && String(c.text).includes('运行异常'))
      assert(alertSent, '告警应在 run 返回前完成（否则被 process.exit 杀死，cron 直接运行收不到）')
    } finally {
      fail4xx = false
      notifyDelayMs = 0
      Config.alert.intervalMs = origInterval
      Config.alert.enabled = origEnabled
      try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('pingbitime 配置 + 接口缺 louzhuregtime → 运行期警告（v3.159）', async () => {
    reset()
    setPushUrl('t67_pingbtime_warn')
    Config.filter.pingbitime = '5'
    fakeData = [makeItem({ id: 1, louzhuregtime: null }), makeItem({ id: 2, louzhuregtime: '' }), makeItem({ id: 3 })]
    const origWarn = console.warn
    const warns = []
    console.warn = (m) => warns.push(String(m))
    try {
      await xbk.run()
    } finally {
      console.warn = origWarn
      Config.filter.pingbitime = ''
    }
    assert(warns.some(w => w.includes('louzhuregtime') && w.includes('pingbitime')),
        `应有注册时间缺失警告: ${warns.join(' | ')}`)
  })

  await test('缓存文件级符号链接 → filter.hash/run.log 不跟随到目录外（P2 安全防护）', async () => {
    reset()
    setPushUrl('t_symlink_file_guard')
    fakeData = []
    const os = require('os')
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    const logPath = path.join(CACHE_DIR, 'run.log')
    const hashTarget = path.join(os.tmpdir(), `xbk-filter-hash-${process.pid}`)
    const logTarget = path.join(os.tmpdir(), `xbk-run-log-${process.pid}`)
    const oldHash = 'KEEP_HASH'
    const oldLog = 'KEEP_LOG\\n'
    try {
      for (const p of [hashPath, logPath, hashTarget, logTarget]) { try { fs.unlinkSync(p) } catch (e) {} }
      fs.writeFileSync(hashTarget, oldHash, 'utf8')
      fs.writeFileSync(logTarget, oldLog, 'utf8')
      fs.symlinkSync(hashTarget, hashPath)
      fs.symlinkSync(logTarget, logPath)
      await xbk.run()
      assert(fs.lstatSync(hashPath).isSymbolicLink(), 'filter.hash 符号链接应被拒绝并保留')
      assert(fs.lstatSync(logPath).isSymbolicLink(), 'run.log 符号链接应被拒绝并保留')
      assert(fs.readFileSync(hashTarget, 'utf8') === oldHash, 'filter.hash 不应跟随符号链接写外部文件')
      assert(fs.readFileSync(logTarget, 'utf8') === oldLog, 'run.log 不应跟随符号链接写外部文件')
    } finally {
      for (const p of [hashPath, logPath, hashTarget, logTarget]) { try { fs.unlinkSync(p) } catch (e) {} }
    }
  })

  await test('应急路径 .xbk_cache_safe 符号链接 → cacheDir 不指向外部（C022）', async () => {
    reset()
    setPushUrl('t_c022_cache_safe_symlink')
    fakeData = []
    const os = require('os')
    const safeLinkPath = path.join(__dirname, '.xbk_cache_safe')
    const defaultCachePath = path.join(__dirname, DEFAULT_CACHE_DIR)
    const externalTarget = path.join(os.tmpdir(), `xbk-cache-safe-${process.pid}`)
    const backupDefault = path.join(__dirname, `.xbk_cache_safe_default_${process.pid}.bak`)
    const origCacheDir = Config.cache.dir
    // 声明的裸删除豁免（Qodo #158 收敛的唯一例外）：本局部 helper 的目标之一是 os.tmpdir() 下的
    // **仓库外**夹具 externalTarget——把它改走 removeDirInRoot 会直接使该用例失败。它不接收任何由
    // 环境变量派生的路径：三个调用点分别是仓库外夹具、仓库根的固定符号链接名、以及备份路径，
    // 全部为本文件字面量构造。:Qodo #158 的「来源」断言按此豁免逐字放行。
    const removePath = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } }
    try {
      removePath(backupDefault)
      removePath(externalTarget)
      removePath(safeLinkPath)
      let defaultStat = null
      try { defaultStat = fs.lstatSync(defaultCachePath) } catch (e) { defaultStat = null }
      if (defaultStat) {
        if (defaultStat.isSymbolicLink()) fs.unlinkSync(defaultCachePath)
        else fs.renameSync(defaultCachePath, backupDefault)
      }
      fs.mkdirSync(externalTarget, { recursive: true })
      fs.symlinkSync(externalTarget, safeLinkPath)
      fs.symlinkSync(externalTarget, defaultCachePath)
      Config.cache.dir = '.xbk_cache_safe'
      const probe = xbk.getFilePath('c022_probe.json')
      assert(!probe.startsWith(externalTarget), `cacheDir 不应指向外部: ${probe}`)
      assert(probe.startsWith(path.join(__dirname, path.sep)), `cacheDir 应留在项目根内: ${probe}`)
      assert(!probe.startsWith(safeLinkPath + path.sep), `cacheDir 不应使用被符号链接的应急路径: ${probe}`)
    } finally {
      Config.cache.dir = origCacheDir
      removePath(safeLinkPath)
      removePath(defaultCachePath)
      removePath(externalTarget)
      if (fs.existsSync(backupDefault)) fs.renameSync(backupDefault, defaultCachePath)
      removePath(backupDefault)
    }
  })

  await test('模板含 {价格} 无警告且推送不崩（C040）', async () => {
    reset()
    setPushUrl('t67_tpl_warn')
    const origT = Config.template.title; const origC = Config.template.content
    Config.template.title = '【{分类名}】{标题}'
    Config.template.content = '{价格} {商城} {品牌} {图片} {标题}'
    fakeData = [makeItem({ id: 1 })]
    const origWarn = console.warn
    const warns = []
    console.warn = (m) => warns.push(String(m))
    try {
      await xbk.run()
    } finally {
      console.warn = origWarn
      Config.template.title = origT
      Config.template.content = origC
    }
    assert(!warns.some(w => w.includes('{价格}') && w.includes('template.content')),
        `不应有模板占位符警告: ${warns.join(' | ')}`)
    // {价格} 等占位符由 tuisong_replace 替换；{标题} 正常替换——推送不崩
    assert(pushCalls.some(c => c.desp.includes('京东神券 100元') && !c.desp.includes('{价格}') && !c.desp.includes('{商城}')),
        `占位符应替换且标题正常: ${pushCalls.map(c => JSON.stringify(c.desp.slice(0, 80))).join('|')}`)
  })

  await test('损坏缓存文件 → 首次跳过推送防重复轰炸，修复后恢复推送（C005）', async () => {
    reset()
    setPushUrl('t99_corrupt_cache')
    const cachePath = path.join(CACHE_DIR, 't99_corrupt_cache.json')
    fs.writeFileSync(cachePath, '{ invalid json', 'utf8')
    fakeData = [makeItem({ id: 9001, title: '损坏缓存测试' })]
    const origErr = console.error
    const errs = []
    console.error = (m) => errs.push(String(m))
    let summary
    try {
      summary = await xbk.run()
    } finally {
      console.error = origErr
    }
    assert(pushCalls.length === 0, `损坏缓存首次运行不应推送，实际${pushCalls.length}`)
    assert(errs.some(e => e.includes('缓存读取失败，跳过本轮推送以防重复轰炸')),
        `应有跳过推送告警: ${errs.join(' | ')}`)
    // P1（审查 2026-08-15）：缓存读失败早退曾返回 undefined（退出码 0 + 零告警零日志，静默漏推）；
    // 修复后应返回带失败语义的摘要，使 classifySummary 判可重试失败 → runSingleEntry 置非零退出码
    assert(summary?.total === 1 && summary?.failed === 1 && summary?.pushed === 0,
        `缓存读失败应返回失败摘要(failed=待推送条数)，实际 ${JSON.stringify(summary)}`)
    // 修复缓存（写合法 JSON 空数组）后恢复正常推送
    reset()
    setPushUrl('t99_corrupt_cache')
    fs.writeFileSync(cachePath, '[]', 'utf8')
    fakeData = [makeItem({ id: 9002, title: '修复后推送' })]
    await xbk.run()
    assert(pushCalls.length === 1, `修复缓存后应推送，实际${pushCalls.length}`)
  })

  await test('sendNotify 同步返回非 Promise → 拒绝静默成功（P2：契约防御，不写缓存）', async () => {
    reset()
    setPushUrl('t_p2_sync_notify')
    fakeData = [makeItem({ id: 1 })]
    // 同步返回 undefined 的第三方实现：Promise.race 会对 undefined 立即 resolve → 曾误判成功写缓存
    notifyMock.sendNotify = () => undefined
    const summary = await xbk.run()
    notifyMock.sendNotify = defaultNotifySend
    assert(pushCalls.length === 0, `同步 sendNotify 不应产生推送记录，实际${pushCalls.length}`)
    assert(summary?.pushed === 0 && summary?.failed === 1,
        `应记录失败语义（不写缓存下次重试），实际 ${JSON.stringify(summary)}`)
    const cached = readCacheFile('t_p2_sync_notify')
    assert(cached.length === 0, '同步 sendNotify 失败不应写缓存')
  })

  await test('只看它：0/false 标题参与匹配（P2：App.run 收敛 whitelistFilter 消除漂移）', async () => {
    // title=0 且 zkt_gjc='0' → 匹配 → 推送（修复前内联 !rawTitle 对 0 一律放行，无法被关键词 '0' 命中）
    reset()
    setPushUrl('t_p2_kwd_zero')
    Config.keyword.zkt_gjc = '0'
    fakeData = [makeItem({ id: 1, title: 0 })]
    await xbk.run()
    assert(pushCalls.length === 1, `title=0 且 zkt_gjc='0' 应匹配推送，实际${pushCalls.length}`)
    // title=0 且 zkt_gjc='abc' → 不匹配 → 滤掉（修复前 0/false 一律放行会误推）
    reset()
    setPushUrl('t_p2_kwd_miss')
    Config.keyword.zkt_gjc = 'abc'
    fakeData = [makeItem({ id: 2, title: 0 })]
    await xbk.run()
    assert(pushCalls.length === 0, `title=0 且 zkt_gjc='abc' 应被滤掉，实际${pushCalls.length}`)
  })

  await test('缓存读失败时 filter.hash 不推进（P2：旧 _f 永久失效防线）', async () => {
    const hashPath = path.join(CACHE_DIR, 'filter.hash')
    const cachePath = path.join(CACHE_DIR, 't_p2_hash_broken.json')
    // ① 规则 A（屏蔽词）：正常 run → 写入 filter.hash(A)
    reset()
    setPushUrl('t_p2_hash_base')
    Config.filter.pingbibiaoti = '屏蔽词'
    fakeData = [makeItem({ id: 1, title: '屏蔽词内容' })]
    await xbk.run()
    const h1 = fs.readFileSync(hashPath, 'utf8').trim()
    // ② 规则改为 B + 切换到「从未读入内存」的损坏缓存文件（内存缓存会屏蔽磁盘损坏，须用新 cacheName）
    reset()
    setPushUrl('t_p2_hash_broken') // 清残留
    fs.writeFileSync(cachePath, '{ broken json', 'utf8')
    Config.filter.pingbibiaoti = '新词'
    fakeData = [makeItem({ id: 1, title: '屏蔽词内容' })]
    await xbk.run()
    const h3 = fs.readFileSync(hashPath, 'utf8').trim()
    assert(h3 === h1, `缓存读失败时 filter.hash 不应推进，期望 ${h1} 实际 ${h3}`)
    // ③ 修复缓存为空数组
    fs.writeFileSync(cachePath, '[]', 'utf8')
    // ④ 规则仍 B：hash(A) !== hash(B) → 检测到规则变更 → 推进 hash(B) → 正常推送
    reset()
    Config.filter.pingbibiaoti = '新词'
    fakeData = [makeItem({ id: 1, title: '屏蔽词内容' })]
    await xbk.run()
    const h5 = fs.readFileSync(hashPath, 'utf8').trim()
    assert(h5 !== h1, `修复缓存后 hash 应推进为新规则: ${h1} vs ${h5}`)
    assert(pushCalls.length === 1, `修复缓存后应正常推送，实际${pushCalls.length}`)
  })

  await test('saveBatch 同内容两次 → 文件 mtime/timestamp 不变（C024）', async () => {
    reset()
    const fname = 't68b_savebatch_mtime.json'
    const p = path.join(CACHE_DIR, fname)
    try { fs.unlinkSync(p) } catch (e) { /* ignore */ }
    const msg = { id: 'c024-1', title: 'same', content: 'same' }
    xbk.saveBatch([msg], fname)
    const cached1 = readCacheFile('t68b_savebatch_mtime')
    const stat1 = fs.statSync(p)
    xbk.saveBatch([msg], fname)
    const cached2 = readCacheFile('t68b_savebatch_mtime')
    const stat2 = fs.statSync(p)
    assert(stat2.mtimeMs === stat1.mtimeMs, '同内容 saveBatch 不应重写文件 mtime')
    assert(cached2[0].timestamp === cached1[0].timestamp, '同内容 saveBatch 不应刷新 timestamp')
  })

  await test('save 与 saveBatch 交错调用 timestamp 单调（C025）', async () => {
    reset()
    const fname = 't68c_save_savebatch_monotonic.json'
    const p = path.join(CACHE_DIR, fname)
    try { fs.unlinkSync(p) } catch (e) { /* ignore */ }
    const bigBatch = Array.from({ length: 200 }, (_, i) => ({ id: `c025-b${i}`, title: `b${i}` }))
    const steps = [
      () => xbk.appendMessageToFile({ id: 'c025-1', title: 'a' }, fname),
      () => xbk.saveBatch(bigBatch, fname),
      () => xbk.appendMessageToFile({ id: 'c025-4', title: 'd' }, fname),
      () => xbk.saveBatch([{ id: 'c025-5', title: 'e' }], fname),
      () => xbk.appendMessageToFile({ id: 'c025-6', title: 'f' }, fname)
    ]
    for (const step of steps) step()
    const stamps = readCacheFile('t68c_save_savebatch_monotonic').map(m => m.timestamp)
    assert(stamps.length >= 6, `应交错写入多条消息，实际 ${stamps.length}`)
    for (let i = 1; i < stamps.length; i++) {
      assert(Date.parse(stamps[i]) > Date.parse(stamps[i - 1]),
          `save/saveBatch 交错 timestamp 应单调递增: ${stamps.join(' -> ')}`)
    }
  })

  await test('MessageStore.init mkdirSync 抛错 → finally/warmupCancelled 仍执行（C042）', async () => {
    reset()
    setPushUrl('t_c042_init_finally')
    fakeData = []
    const origCacheDir = Config.cache.dir
    const testCacheDir = DEFAULT_CACHE_DIR + '_c042_missing'
    const testDir = path.join(__dirname, testCacheDir)
    const origMkdirSync = fs.mkdirSync
    const dnsMod = require('dns')
    const origLookup = dnsMod.lookup
    const origHasWx = notifyMock.hasWxPusherConfigured
    const origAbort = typeof AbortController !== 'undefined' ? AbortController.prototype.abort : null
    let aborted = 0
    try { removeDirInRoot(testDir, __dirname) } catch (e) { /* ignore */ }
    Config.cache.dir = testCacheDir
    notifyMock.hasWxPusherConfigured = () => true // 让预热路径创建 controller，用于观测 finally abort
    dnsMod.lookup = (host, opts, cb) => {
      if (typeof opts === 'function') { cb = opts }
      cb(null, '127.0.0.1', 4)
    }
    fs.mkdirSync = () => { throw new Error('mock mkdir fail') }
    if (origAbort) {
      AbortController.prototype.abort = function () {
        aborted++
        return origAbort.call(this)
      }
    }
    let threw = false
    try {
      await xbk.run()
    } catch (e) {
      threw = true
    } finally {
      Config.cache.dir = origCacheDir
      fs.mkdirSync = origMkdirSync
      dnsMod.lookup = origLookup
      if (origHasWx === undefined) delete notifyMock.hasWxPusherConfigured
      else notifyMock.hasWxPusherConfigured = origHasWx
      if (origAbort) AbortController.prototype.abort = origAbort
      try { removeDirInRoot(testDir, __dirname) } catch (e) { /* ignore */ }
    }
    assert(threw, 'mkdirSync 抛错应使 run 抛错')
    assert(aborted > 0, 'finally 应取消预热（warmupCancelled/abort 执行）')
  })

  // v3.276（EXEC-D T10）：过滤是否生效必须可观测。跳过同样计入 passed，故 passed 恒等于用例总数——
  // 过滤静默失效（--only 解析不到）时输出与「正常全量跑」完全同形，门禁无从察觉。
  // 打印「实际执行 N 例，过滤跳过 M 例」把这一点变成可断言的事实；无过滤时保持原输出不变。
  // ============================================================
  // Qodo PR #158（High / Security）回归：XBK_PARALLEL_ID 路径穿越（test_filter.js 同族）
  // ------------------------------------------------------------
  // 缺陷面：PARALLEL_ID 曾直接取 process.env.XBK_PARALLEL_ID 且无校验 → DEFAULT_CACHE_DIR/CACHE_DIR
  // 以及 10 处以 `DEFAULT_CACHE_DIR` 派生的 stateDir，都可能被含 `../` 的值劫持到仓库外，再被
  // finally 里的递归 rmSync 删掉。生产 resolveCacheDirInRoot 有根内校验，但测试清理跑在它之前。
  // 靶向回退：删掉 sanitizeIsolationId 的白名单 ⇒ 本用例第一条断言真红；还原 ⇒ 绿。
  await test('Qodo #158: XBK_PARALLEL_ID 含 / 绝对路径 .. 一律回退 pid 分片（路径穿越防护）', async () => {
    // 1) 模块级不变量：生效三元组必须同源、在根内、且已过白名单
    assertPathInRoot(CACHE_DIR, __dirname, '生效 CACHE_DIR 必须位于仓库根之内')
    assertEqualStr(CACHE_DIR, path.join(__dirname, DEFAULT_CACHE_DIR), 'CACHE_DIR 必须与 DEFAULT_CACHE_DIR 同源')
    assertEqualStr(process.env.XBK_PARALLEL_ID, PARALLEL_ID, '写回环境的 XBK_PARALLEL_ID 必须与生效分片 ID 同源')
    assertEqualStr(PARALLEL_ID, sanitizeIsolationId(PARALLEL_ID), '生效分片 ID 自身必须已通过白名单')
    assert(CACHE_SHARD_ID_RE.test(PARALLEL_ID), `生效分片 ID 必须只含 [A-Za-z0-9_-]（实得 ${PARALLEL_ID}）`)
    assert(DEFAULT_CACHE_DIR === `xianbaoku_cache_p${PARALLEL_ID}`,
      `DEFAULT_CACHE_DIR 必须恒为分片目录名（实得 ${DEFAULT_CACHE_DIR}）`)

    // 2) 三类恶意输入 + 等价变体：一律回退 pid 分片，构造结果必在仓库根内
    const rootAbs = path.resolve(__dirname)
    const malicious = [
      ['含斜杠', 'abc/../../etc'],
      ['含斜杠（多级）', 'a/b'],
      ['绝对路径', '/etc/cron.d'],
      ['绝对路径（仓库父目录）', path.resolve(__dirname, '..')],
      ['父目录段', '..'],
      ['父目录段（多级+分隔符）', '../../x'],
      ['以点开头（含分隔符）', './a/../b'],
      ['Windows 分隔符', '..\\..\\x'],
      ['空串', ''],
      ['URL 编码的穿越', '..%2f..%2fx'],
      ['超长单段', 'a'.repeat(CACHE_SHARD_ID_MAX + 1)]
    ]
    for (const [label, raw] of malicious) {
      const shard = buildCacheShard(raw, __dirname, path)
      assertPathInRoot(shard.cacheDir, __dirname, `${label} 输入经构造后仍在仓库根内`)
      assertEqualStr(path.resolve(shard.cacheDir), path.resolve(rootAbs, shard.dirName),
        `${label}：cacheDir 必须就是 root+dirName（无多余路径段）`)
      assertEqualStr(shard.dirName, `xianbaoku_cache_p${process.pid}`,
        `${label}：非法 XBK_PARALLEL_ID=${JSON.stringify(raw)} 必须回退 pid 分片（实得 ${shard.dirName}）`)
      assertEqualStr(shard.id, String(process.pid), `${label}：非法的归一 ID 必须是 pid`)
    }

    // 3) 恶意输入不得让任何**仓库外**路径被用于递归删除。
    //    用「哨兵目录 + 断言未被删除」证明：哨兵在仓库根之外，若旧口径被用在派生路径上，
    //    addSentinel 建的这棵树会被整棵删掉 ⇒ 断言真红。全程只新建/删除自己的哨兵，
    //    绝不触碰任何真实敏感路径。
    const victimDir = path.resolve(__dirname, '..', `xbk-o1-app-sentinel-${process.pid}`)
    const victimFile = path.join(victimDir, 'leaf.json')
    assert(!(victimDir === rootAbs || victimDir.startsWith(rootAbs + path.sep)),
      `哨兵必须位于仓库根之外才有证明力（当前 ${victimDir}）`)
    const addSentinel = () => {
      fs.rmSync(victimDir, { recursive: true, force: true })
      fs.mkdirSync(victimDir, { recursive: true })
      fs.writeFileSync(victimFile, '{"sentinel":true}')
    }
    try {
      for (const [label, raw] of malicious) {
        const shard = buildCacheShard(raw, __dirname, path)
        addSentinel()
        removeDirInRoot(shard.cacheDir, __dirname) // 只允许删自己（根内的分片名）
        assert(fs.existsSync(victimFile), `${label}：仓库外哨兵文件不得被递归删除（${victimDir}）`)
        assert(fs.existsSync(victimDir), `${label}：仓库外哨兵目录不得被递归删除（${victimDir}）`)
        assert(path.resolve(shard.cacheDir) !== path.resolve(victimDir),
          `${label}：生效缓存目录不得落在仓库之外`)
      }
      // 4) 自证旧口径确实逃逸：raw='3×../<sentinel basename>' 时旧派生路径恰好等于哨兵目录
      const escapeRaw = `../../../${path.basename(victimDir)}`
      const escapeDerived = path.join(rootAbs, `xianbaoku_cache_p${escapeRaw}`)
      assertEqualStr(path.resolve(escapeDerived), path.resolve(victimDir),
        '构造自证失败：该输入应恰好派生到哨兵目录（否则本用例的证明力不成立）')
      addSentinel()
      const escapeShard = buildCacheShard(escapeRaw, __dirname, path)
      assert(path.resolve(escapeShard.cacheDir) !== path.resolve(victimDir),
        '穿越输入必须被拦下，不得把仓库外目录当作缓存目录')
      let blocked = false
      try { removeDirInRoot(victimDir, __dirname) } catch (e) { blocked = true }
      assert(blocked, 'removeDirInRoot 必须拒绝仓库外路径（fail-closed）')
      assert(fs.existsSync(victimFile), '穿越输入派生出的清理不得删掉仓库外哨兵')
      removeDirInRoot(escapeShard.cacheDir, __dirname)
      assert(fs.existsSync(victimFile), '穿越输入被回退后的清理也不得删掉仓库外哨兵')
    } finally {
      try { fs.rmSync(victimDir, { recursive: true, force: true }) } catch (e) { /* 清理哨兵 */ }
    }
  })

  // 合法输入照常分片（白名单不得把正常 ID 一起挡掉；test_app_p.js 的 workerId 就是这两种形态）
  await test('Qodo #158: 合法 XBK_PARALLEL_ID 仍照常分片（白名单不误伤）', async () => {
    for (const good of ['worker1', '12345', '1234_5678901234_0', 'a-b_c-9', 'x'.repeat(CACHE_SHARD_ID_MAX)]) {
      const shard = buildCacheShard(good, __dirname, path)
      assertEqualStr(shard.id, good, `合法 ID ${good} 不应被改写`)
      assertEqualStr(shard.dirName, `xianbaoku_cache_p${good}`, `合法 ID ${good} 必须照原样分片`)
      assertPathInRoot(shard.cacheDir, __dirname, `合法 ID ${good} 的分片目录必须在仓库根内`)
    }
    // 与 test_app_p.js 的分片口径逐字符一致（workerId = `${pid}_${Date.now()}_${idx}`）
    const workerLike = `${process.pid}_${Date.now()}_0`
    assertEqualStr(buildCacheShard(workerLike, __dirname, path).cacheDir,
      path.join(__dirname, `xianbaoku_cache_p${workerLike}`), '与 test_app_p.js 分片口径一致')
    assertEqualStr(buildCacheShard(undefined, __dirname, path).dirName,
      `xianbaoku_cache_p${process.pid}`, '未设置时取进程 pid')
  })

  // 收敛点自证（两条独立事实）：
  //   ① 删除入口 removeDirInRoot 拒绝仓库根之外的路径（fail-closed）；
  //   ② 本文件除 removeDirInRoot 内部与**声明的豁免**（:3737 局部 removePath，其目标含仓库外
  //     夹具）外，不得再有裸的递归 rmSync；
  //   ③ 与 test_filter.js 的同源 helper 代码块 normalize 后必须逐字符相同（防两边漂移）。
  await test('Qodo #158: 删除入口收敛 + 与 test_filter.js 同源块未漂移', async () => {
    let threw = false
    try { removeDirInRoot(path.join(__dirname, '..'), __dirname) } catch (e) { threw = true }
    assert(threw, '对仓库根之外的路径必须抛错拒绝，而不是照删')
    threw = false
    try { removeDirInRoot(__dirname, __dirname) } catch (e) { threw = true }
    assert(threw, '不得把仓库根自身作为递归删除目标')

    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .split('\n').filter(line => !/^\s*\//.test(line)).join('\n') // 整行注释

    const selfSrc = stripComments(fs.readFileSync(__filename, 'utf8'))
    // 允许恰好 4 处：removeDirInRoot 内部 1 处 + 声明的豁免 removePath 1 处
    // + 本用例清理哨兵 2 处（addSentinel 前置清空 + finally 收尾，目标恒为仓库外自建哨兵）
    const rawRecursiveRm = selfSrc.match(/rmSync\([^)]*recursive:\s*true/g) || []
    assertEqualNum(rawRecursiveRm.length, 4,
      `递归删除只能收敛到 removeDirInRoot + 1 处声明豁免 + 本用例哨兵（实得 ${rawRecursiveRm.length} 处）`)

    // 两侧同源块逐字符比对（normalize：去整行注释、去空行、去行尾空白、行首空白）
    // 提取口径：先剥注释（否则 indexOf 可能命中注释里形如代码的锚点串），再从**行首**锚点切到
    // buildCacheShard 之后的第一个顶层声明。不能切到首个空行——函数体内也有空行（实测会截到 152 字符）。
    const extractBlock = (src) => {
      const clean = stripComments(src)
      const a = clean.indexOf('const CACHE_SHARD_ID_RE =')
      const b = clean.indexOf('function buildCacheShard (rawId, root, pathMod) {')
      if (a < 0 || b < 0) return ''
      const tail = clean.slice(b)
      const m = /\n(function |const |\(async )/.exec(tail)
      if (!m) return clean.slice(a)
      return clean.slice(a, b + m.index + 1)
    }
    const normalize = (text) => text
      .split('\n').map(line => line.trim()).filter(Boolean).join('\n')
    const mine = normalize(extractBlock(fs.readFileSync(__filename, 'utf8')))
    const other = normalize(extractBlock(fs.readFileSync(path.join(__dirname, 'test_filter.js'), 'utf8')))
    assert(mine.length > 200 && other.length > 200,
      `同源块提取失败（自身 ${mine.length} / test_filter ${other.length} 字符）——锚点注释失效`)
    assertEqualStr(mine, other,
      'test_app.js 与 test_filter.js 的 sanitizeIsolationId/buildCacheShard 块必须逐字符相同（改一处必须同改另一处）')
  })

  const filterNote = (onlyFilter || nameSet)
    ? `（实际执行 ${executed} 例，过滤跳过 ${skipped} 例${onlyFilter ? `，--only=${onlyFilter}` : ''}）`
    : ''
  if (failed === 0) {
    console.log(`  🎉 集成测试全部通过！${passed}/${passed}${filterNote}`)
  } else {
    console.log(`  ⚠️   ${passed} 通过, ${failed} 失败${filterNote}`)
    errors.forEach(e => console.log(`    ${e}`))
  }
  console.log('========================================\n')

  // 清理本套件产生的缓存测试文件（t\d{2}_/t48b_/tpush_/tpar_fail，保留真实运行缓存 push.json）
  // v3.122：--only 模式（并行调度）跳过清理——并行进程删除会删掉其他仍在跑的进程正在使用的缓存文件
  // v3.172：--list-file 模式同样跳过（调度器统一清理 worker 独立目录）
  if (!onlyFilter && !nameSet) {
    try {
      const fs = require('fs')
      const dir = path.join(__dirname, 'xianbaoku_cache')
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          // t\d{2}[a-z]?_ 同时匹配 t48_ 与 t48b_（v3.69 修复：原 ^t\d{2}_ 漏掉带字母后缀的测试名）
          if (/^t\d{2}[a-z]?_|^tpush_|^tpar_fail/.test(f)) { try { fs.unlinkSync(path.join(dir, f)) } catch (e) { /* 忽略 */ } }
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  process.exit(failed > 0 ? 1 : 0)
})()
