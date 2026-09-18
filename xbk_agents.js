'use strict'

// 共享 Keep-Alive Agent：避免连续请求反复建立 TCP/TLS 连接；并行请求仍可同时发出。
const http = require('http')
const https = require('https')
const dns = require('dns')
const got = require('got')

// DNS 地址族：默认 auto；XBK_DNS_FAMILY=4/6 可用于对比 IPv4/IPv6 路径。
const DNS_LOOKUP_IP_VERSION = process.env.XBK_DNS_FAMILY === '4' ? 'ipv4' : process.env.XBK_DNS_FAMILY === '6' ? 'ipv6' : ''

const AGENTS = {
  http: new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, keepAliveMsecs: 1000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, keepAliveMsecs: 1000 })
}

// 进程内 DNS 缓存：避免同一进程的并发请求重复解析同一个 HTTPS 主机。
// 使用 Node 原生 dns.lookup，不依赖网卡枚举，兼容受限 Android/沙箱环境。
const DNS_TTL_MS = 60000
const DNS_ERROR_TTL_MS = 1000
// AGENTS-02：含 ETIMEDOUT——连接/请求超时（重试窗口 1s/2s 远短于 60s TTL）很可能就是缓存里那个地址
// 已不可达，不清缓存会让整个重试窗口反复复用同一失效地址。失效代价只是下一次多一次系统解析。
// AGENTS-08：不含 ERR_TLS_CERT_ALTNAME_INVALID——证书主机名不匹配是服务端证书/域名的确定性配置问题
// （xbk_failure_policy.js 已把它按 PERMANENT 归类），与「缓存里的 IP 已失效」无关；把它当 DNS 失效码
// 只会让每次重试白清一次缓存并重新解析，问题依旧。指示地址可能失效的是网络层错误码（连接/解析类）。
const DNS_INVALIDATION_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED', 'ETIMEDOUT'
])
const dnsCache = new Map()
const dnsPending = new Map()

function profileMs (value) {
  return Number.isFinite(value) ? Math.round(value) : 'n/a'
}

function shouldInvalidateDns (error) {
  return Boolean(error && DNS_INVALIDATION_CODES.has(error.code))
}

function baseRequestOptions () {
  return {
    agent: AGENTS,
    lookup: dnsLookup,
    ...(DNS_LOOKUP_IP_VERSION ? { dnsLookupIpVersion: DNS_LOOKUP_IP_VERSION } : {})
  }
}

function invalidateDnsForError (error, url) {
  if (!shouldInvalidateDns(error)) return false
  try {
    const hostname = new URL(url).hostname
    if (!hostname) return false
    invalidateDns(hostname)
    return true
  } catch (e) { return false }
}
// AGENTS-01：预热必须与真实请求同 key，否则预热写进一个永不被读的条目、DNS 预热完全无效。
// AGENTS-11（PR #154 评审 / qodo High-Correctness）：但「同 key」不能靠丢掉结果选择选项来换——
// 缓存里存的是**解析器按调用方选项筛选/排序后**的地址。key 只含 hostname|family 时，用默认选项
// 预热后，带地址筛选（hints）或排序（verbatim/order）的真实请求会在 TTL 内直接复用不匹配的地址：
// 选择逻辑不再执行，还可能选中本应排除的地址（实测本机无默认网络 IPv6，平台的 AI_ADDRCONFIG 会
// 剔除 AAAA）。故 key 收敛为 hostname|family|hints|order：任一影响结果选择的选项不同即不同条目，
// 各自向底层解析器取真实结果——**不**在 JS 内复现 getaddrinfo 语义（实测 os.networkInterfaces()
// 有全局 IPv6 240e:/2408:，而平台 AI_ADDRCONFIG 仍只返回 A：平台按默认网络/路由判断「本机已配置
// 族」，JS 侧无法忠实复现）。all 不进 key：它只决定回调形状（由 dispatchLookupResult 适配）。
// 预热有效性由「同源取值」保证：prewarmDns 用生产请求路径实测的选项（见 productionLookupOptions），
// 与 net.connect 实际传给 lookup 的选项同 key。
const DNS_MODELED_OPTION_KEYS = new Set(['all', 'family', 'hints', 'verbatim', 'order'])
const DNS_RESULT_ORDERS = new Set(['verbatim', 'ipv4first', 'ipv6first'])

// 生产请求路径（https.get → net.connect → lookup）实测于 Node v24.18.0：
//   family 未指定 → {hints: dns.ADDRCONFIG}（autoSelectFamily 默认开启时另加 all:true）
//   family 已指定 → {family: 4|6, hints: 0}
// 分别对应默认 / XBK_DNS_FAMILY=4|6 两种部署；autoSelectFamily 关闭时只少一个 all:true，而 all 不
// 进 key，故不影响命中。若将来 Node 改了这些选项，后果只是预热条目不再被请求命中（key 承载的始终
// 是各调用方自己的选项，正确性不受影响），届时需同步本函数。
const PRODUCTION_LOOKUP_HINTS = typeof dns.ADDRCONFIG === 'number' ? dns.ADDRCONFIG : 0

function productionLookupOptions () {
  const family = DNS_LOOKUP_IP_VERSION === 'ipv4' ? 4 : DNS_LOOKUP_IP_VERSION === 'ipv6' ? 6 : 0
  return { family, hints: family === 0 ? PRODUCTION_LOOKUP_HINTS : 0 }
}

// 与 Node dns.lookup 同口径：order 优先于 verbatim；两者都未显式给出时才用进程级默认顺序
// （可被 --dns-result-order / dns.setDefaultResultOrder 改写）。非法取值返回 null → 该调用不进缓存。
function dnsResultOrder (opts) {
  if (opts.order !== undefined) return DNS_RESULT_ORDERS.has(opts.order) ? opts.order : null
  if (opts.verbatim !== undefined) {
    if (typeof opts.verbatim !== 'boolean') return null
    return opts.verbatim ? 'verbatim' : 'ipv4first'
  }
  try {
    const fallback = typeof dns.getDefaultResultOrder === 'function' ? dns.getDefaultResultOrder() : 'verbatim'
    return DNS_RESULT_ORDERS.has(fallback) ? fallback : 'verbatim'
  } catch (e) { return 'verbatim' }
}

// 选项签名：只覆盖本模块建模到的、影响结果选择/排序的字段。
// 返回 null = 选项超出建模范围（未知键、非法类型/取值）→ 该调用不进缓存，直接交给底层解析器：
// 宁可这类调用方少一次缓存命中，也不能让它复用按别的选项筛选/排序过的地址。
function dnsSelectionSignature (options) {
  const opts = options || {}
  for (const key of Object.keys(opts)) {
    if (!DNS_MODELED_OPTION_KEYS.has(key)) return null
  }
  if (opts.family !== undefined && opts.family !== 0 && opts.family !== 4 && opts.family !== 6) return null
  if (opts.hints !== undefined && (typeof opts.hints !== 'number' || !Number.isFinite(opts.hints))) return null
  const order = dnsResultOrder(opts)
  if (order === null) return null
  return { family: opts.family || 0, hints: opts.hints || 0, order }
}

// 返回 null 表示该调用不走缓存（选项未建模），调用方需直接交给底层解析器。
function dnsCacheKey (hostname, options) {
  const sig = dnsSelectionSignature(options)
  if (!sig) return null
  return [hostname, sig.family, sig.hints, sig.order].join('|')
}

// 按调用方的 all 适配回调形状：all:true 拿 [{address, family}]，其余拿标量（取列表首项）。
// 非数组结果（测试替身未按 all 建模）原样透传，保持既有替身语义不变。
function dispatchLookupResult (callback, wantAll, error, address, family) {
  if (error || !Array.isArray(address)) { callback(error, address, family); return }
  if (wantAll) { callback(null, address, family); return }
  const first = address[0]
  callback(null, first ? first.address : undefined, first ? first.family : family)
}

function dnsLookup (hostname, options, callback) {
  const opts = options || {}
  const wantAll = Boolean(opts.all)
  const key = dnsCacheKey(hostname, opts)
  // AGENTS-11：选项未建模（未知键/非法取值）→ 不读也不写缓存，按调用方原选项直接解析。
  // 这类调用方（目前只有测试/未来扩展）失去缓存收益，换来的是「拿到的地址一定按自己的选项
  // 筛选/排序过」，也不会污染同主机其它选项的缓存条目。
  if (key === null) {
    dns.lookup(hostname, { ...opts, all: true }, (error, address, family) => dispatchLookupResult(callback, wantAll, error, address, family))
    return
  }
  const now = Date.now()
  const cached = dnsCache.get(key)
  if (cached && cached.expiresAt > now) {
    queueMicrotask(() => dispatchLookupResult(callback, wantAll, cached.error, cached.address, cached.family))
    return
  }

  // AGENTS-04（已知限制，改行为需先定状态机口径）：普通调用方（含 got 超时/取消后仍存在的 net
  // lookup 回调）没有摘除路径；唯一摘除是 prewarmDns 的 abort 分支，底层 dns.lookup 完成时才统一
  // delete。坏解析器下同 key 列表会随重试只增不减——本注释只记录现状，未改任何行为。
  const pending = dnsPending.get(key)
  if (pending) {
    pending.push({ callback, all: wantAll })
    return
  }
  const pendingList = [{ callback, all: wantAll }]
  dnsPending.set(key, pendingList)
  dns.lookup(hostname, { ...opts, all: true }, (error, address, family) => {
    // v3.263（CodeAnt）：只派发并缓存本次记账列表——abort 摘除回调后若同一 key 已有新 lookup
    // 接管，旧 lookup 完成时不得清空/派发到新列表，也不得写缓存（接管等待期间新调用方会读到
    // 旧结果，且晚到的旧回调会覆盖更新的缓存条目；新 lookup 会缓存自己的结果）
    if (dnsPending.get(key) !== pendingList) return
    dnsPending.delete(key)
    const ttl = error ? DNS_ERROR_TTL_MS : DNS_TTL_MS
    dnsCache.set(key, { error, address, family, expiresAt: Date.now() + ttl })
    for (const entry of pendingList) dispatchLookupResult(entry.callback, entry.all, error, address, family)
  })
}

function prewarmDns (hostname, signal = null) {
  // AGENTS-11：预热与真实请求同源取值（生产请求路径实测的 family/hints），否则 key 不同 → 预热失效。
  const options = productionLookupOptions()
  const started = Date.now()
  const makeResult = (error, address, family) => ({
    // AGENTS-07：预热结果带显式任务类型，调用方可按字段区分 DNS/TLS（两者都带 hostname），
    // 不必靠每个调用点手工绑定 kind（qinglong/xbk_push.js 目前就是手工绑的）。
    kind: 'dns',
    hostname,
    ok: !error,
    error: error ? error.code || error.message || String(error) : '',
    address: Array.isArray(address) ? address.map(x => x.address || x) : address,
    family,
    elapsedMs: Date.now() - started
  })
  return new Promise(resolve => {
    // P3（审查 2026-08-15）：支持取消信号——坏解析器场景挂起的 dns.lookup 不再拖住进程退出
    // （与 prewarmTls 同款；dns.lookup 无原生 signal 选项，用 abort 监听 + settled 防重复 resolve）。
    // v3.263（CodeRabbit）：dns.lookup 无法真正取消，abort 只 settle 本 Promise；同时把本回调从
    // dnsPending 记账中摘除（不持有引用、再次预热会重新发起解析），并在解析完成时移除 abort 监听。
    // 契约：取消不保证进程立刻退出——底层解析仍可能后台完成，退出时机由调用方退出策略负责。
    let settled = false
    // 与 dnsLookup 内部同 key（AGENTS-11 起为 hostname+family+hints+order，见 dnsCacheKey）：
    // abort 时按 key 定位 dnsPending 中的本回调。options 由本函数自建、必在建模范围内（key 非空），
    // 这里仍按 null 兜底：key 为 null 时不做记账摘除（dnsLookup 也不会为该调用建记账）。
    const key = dnsCacheKey(hostname, options)
    const done = (error, address, family) => { if (!settled) { settled = true; resolve(makeResult(error, address, family)) } }
    const callback = (error, address, family) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      done(error, address, family)
    }
    const onAbort = () => {
      const pending = key === null ? null : dnsPending.get(key)
      if (pending) {
        // dnsPending 条目是 { callback, all }：按回调身份定位本记账项
        const i = pending.findIndex(entry => entry.callback === callback)
        if (i !== -1) pending.splice(i, 1)
        if (pending.length === 0) dnsPending.delete(key)
      }
      done(new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    dnsLookup(hostname, options, callback)
  })
}

// 连接错误可能意味着缓存中的地址已失效；清除该主机的所有地址族缓存，
// 让下一次重试重新走系统 DNS，而不是在 TTL 内反复使用旧地址。
function invalidateDns (hostname) {
  const host = typeof hostname === 'string' ? hostname : ''
  if (!host) return 0
  let removed = 0
  for (const key of dnsCache.keys()) {
    if (key.startsWith(host + '|')) {
      dnsCache.delete(key)
      removed += 1
    }
  }
  return removed
}

// AGENTS-03（上界）：count 只设下界不够。1e10 / 2^32 这类值会让后面的 Array.from({ length })
// 抛 RangeError（prewarmTls 整体 reject，且调用方通常只处理 ok/okCount，异常会变成未捕获拒绝）；
// 略小一些的值则会真的发起海量并发连接，打爆目标站点与本进程的 fd/内存。
// 上界取 64：仓内调用方全部远低于此（xbk_app.js 预热窗口 ≤10、qinglong 入口 ≤3），
// 既要挡住误填，也不能收紧既有合法用途。
const MAX_PREWARM_TLS_CONNECTIONS = 64

async function prewarmTls (hostname, timeoutMs = 5000, count = 1, signal = null) {
  const started = Date.now()
  // AGENTS-07：所有出口都带 kind，调用方可按字段区分 DNS/TLS（两条预热路径的返回值都带 hostname）
  if (signal && signal.aborted) return { kind: 'tls', hostname, count, skipped: true, cancelled: true, ok: false, okCount: 0, elapsedMs: 0 }
  try {
    // got 替身可能不提供 stream（真实 got 恒有；与 xbk_http.js 的 mock 判定同款）：无法建连 → skipped:true
    // 且 ok:false（AGENTS-10）。ok 的语义是「是否真的建连成功」，未建连却报 ok:true 会让聚合预热统计假绿
    // （okCount=0 却 ok=true）；skipped:true 保留既有「调用方按跳过展示、不计失败」的语义
    // （xbk_app.js 先判 skipped 再报「跳过」，qinglong 只在 PROFILE3 打点）。
    if (!got.stream) return { kind: 'tls', hostname, count, skipped: true, ok: false, okCount: 0, error: 'got.stream 不可用（未建连）', elapsedMs: Date.now() - started }
  } catch (e) { /* 忽略 */ }
  // AGENTS-05（已知缺口，未改行为）：本 HEAD→GET 回退只为建连、但 await 会读完整个响应体，而这里没有
  // 体量上限——got@11 无 maxResponseSize 选项，xbk_http.js 的 20MB 上限只覆盖 fetchJson。补上限需要
  // 统一的响应体策略，属跨文件口径决策，故仅记录现状。
  const baseOptions = {
    ...baseRequestOptions(),
    timeout: timeoutMs,
    retry: { limit: 0 },
    throwHttpErrors: false,
    ...(signal ? { signal } : {})
  }
  // 边界守卫（AGENTS-03）：NaN/Infinity/非数字一律钳制为 1，且整体收敛到
  // [1, MAX_PREWARM_TLS_CONNECTIONS]。此前 count=NaN 会得到空数组并静默返回 ok:true/okCount:0
  // （未建连却报成功），count=Infinity 会让 Array.from 抛 RangeError；而遗留的 1e10 / 2^32
  // 仍会抛 RangeError（守卫只排除了非有限值，没设上界）。合法小数值（含 0/负数→1，与旧
  // Math.max(1, …) 同口径）行为不变。
  const requestedCount = Math.floor(Number(count))
  const connectionCount = Number.isFinite(requestedCount) && requestedCount >= 1
    ? Math.min(requestedCount, MAX_PREWARM_TLS_CONNECTIONS)
    : 1
  const results = await Promise.all(Array.from({ length: connectionCount }, async () => {
    const singleStart = Date.now()
    try {
      // HEAD 无响应体：只需 DNS+TCP+TLS+响应头即可完成建连，连接进入 Keep-Alive 池，
      // 比 GET 下载首页快得多（GET 会把 body 下载时间也算进预取）。
      const response = await got.head(`https://${hostname}/`, baseOptions)
      // throwHttpErrors=false 时 405 不会进入 catch，显式检查后才回退 GET。
      if (response && response.statusCode >= 400) {
        if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
        try {
          await got.get(`https://${hostname}/`, baseOptions)
          return { ok: true, elapsedMs: Date.now() - singleStart, viaGet: true }
        } catch (e2) {
          // v3.233：GET 独立捕获，失败不回落到外层 catch 再发一次 GET（同一主机重复建连）
          // 复核修正：保持取消语义——GET 被 abort 时返回 cancelled 而非 error（此前外层 catch 会识别）
          if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
          return { ok: false, error: e2 && (e2.code || e2.message) ? String(e2.code || e2.message) : String(e2), elapsedMs: Date.now() - singleStart }
        }
      }
      return { ok: true, elapsedMs: Date.now() - singleStart }
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
      // 服务端不支持 HEAD（如 405）时回退 GET 建连；仍失败则静默跳过。
      try {
        await got.get(`https://${hostname}/`, baseOptions)
        return { ok: true, elapsedMs: Date.now() - singleStart, viaGet: true }
      } catch (e2) {
        // AGENTS-06：与 405 回退分支同口径——GET 回退被 abort 时返回 cancelled 而非普通 error。
        if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
        return { ok: false, error: e2 && (e2.code || e2.message) ? String(e2.code || e2.message) : String(e2), elapsedMs: Date.now() - singleStart }
      }
    }
  }))
  // AGENTS-07：返回值带显式 kind（与 prewarmDns 的 kind:'dns' 对称）——此前 DNS/TLS 两条预热结果都只
  // 带 hostname，调用方无法按字段区分，常驻日志会把 TLS 计入 DNS 计数（qinglong 侧已改为任务显式绑
  // kind；现在接口本身也可区分）。纯新增字段，既有调用方读 ok/okCount/count/elapsedMs 不受影响。
  return {
    kind: 'tls',
    hostname,
    count: results.length,
    ok: results.every(r => r.ok),
    okCount: results.filter(r => r.ok).length,
    elapsedMs: Date.now() - started,
    perConnectionMs: results.map(r => r.elapsedMs)
  }
}

module.exports = { AGENTS, DNS_LOOKUP_IP_VERSION, dnsLookup, invalidateDns, shouldInvalidateDns, profileMs, baseRequestOptions, invalidateDnsForError, prewarmDns, prewarmTls }
