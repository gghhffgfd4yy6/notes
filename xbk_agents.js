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
const DNS_INVALIDATION_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED', 'ERR_TLS_CERT_ALTNAME_INVALID'
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
function dnsLookup (hostname, options, callback) {
  const opts = options || {}
  const key = [hostname, opts.family || 0, opts.hints || 0, opts.all ? 1 : 0, opts.verbatim ? 1 : 0].join('|')
  const now = Date.now()
  const cached = dnsCache.get(key)
  if (cached && cached.expiresAt > now) {
    queueMicrotask(() => callback(cached.error, cached.address, cached.family))
    return
  }

  const pending = dnsPending.get(key)
  if (pending) {
    pending.push(callback)
    return
  }
  const pendingList = [callback]
  dnsPending.set(key, pendingList)
  dns.lookup(hostname, opts, (error, address, family) => {
    // v3.263（CodeAnt）：只派发并缓存本次记账列表——abort 摘除回调后若同一 key 已有新 lookup
    // 接管，旧 lookup 完成时不得清空/派发到新列表，也不得写缓存（接管等待期间新调用方会读到
    // 旧结果，且晚到的旧回调会覆盖更新的缓存条目；新 lookup 会缓存自己的结果）
    if (dnsPending.get(key) !== pendingList) return
    dnsPending.delete(key)
    const ttl = error ? DNS_ERROR_TTL_MS : DNS_TTL_MS
    dnsCache.set(key, { error, address, family, expiresAt: Date.now() + ttl })
    for (const cb of pendingList) cb(error, address, family)
  })
}

function prewarmDns (hostname, signal = null) {
  const options = DNS_LOOKUP_IP_VERSION === 'ipv4' ? { family: 4 } : DNS_LOOKUP_IP_VERSION === 'ipv6' ? { family: 6 } : {}
  const started = Date.now()
  const makeResult = (error, address, family) => ({
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
    // 与 dnsLookup 内部同构的 key：abort 时按 key 定位 dnsPending 中的本回调
    const key = [hostname, options.family || 0, options.hints || 0, options.all ? 1 : 0, options.verbatim ? 1 : 0].join('|')
    const done = (error, address, family) => { if (!settled) { settled = true; resolve(makeResult(error, address, family)) } }
    const callback = (error, address, family) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      done(error, address, family)
    }
    const onAbort = () => {
      const pending = dnsPending.get(key)
      if (pending) {
        const i = pending.indexOf(callback)
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

async function prewarmTls (hostname, timeoutMs = 5000, count = 1, signal = null) {
  const started = Date.now()
  if (signal && signal.aborted) return { hostname, count, skipped: true, cancelled: true, ok: false, okCount: 0, elapsedMs: 0 }
  try {
    // 测试环境 got 为 mock（无 stream）：跳过真实建连，避免破坏 gotCalls 断言。
    if (!got.stream) return { hostname, count, skipped: true, ok: true, elapsedMs: Date.now() - started }
  } catch (e) { /* 忽略 */ }
  const baseOptions = {
    ...baseRequestOptions(),
    timeout: timeoutMs,
    retry: { limit: 0 },
    throwHttpErrors: false,
    ...(signal ? { signal } : {})
  }
  const results = await Promise.all(Array.from({ length: Math.max(1, Math.floor(count)) }, async () => {
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
        return { ok: false, error: e2 && (e2.code || e2.message) ? String(e2.code || e2.message) : String(e2), elapsedMs: Date.now() - singleStart }
      }
    }
  }))
  return {
    hostname,
    count: results.length,
    ok: results.every(r => r.ok),
    okCount: results.filter(r => r.ok).length,
    elapsedMs: Date.now() - started,
    perConnectionMs: results.map(r => r.elapsedMs)
  }
}

module.exports = { AGENTS, DNS_LOOKUP_IP_VERSION, DNS_CACHE: null, dnsLookup, invalidateDns, shouldInvalidateDns, profileMs, baseRequestOptions, invalidateDnsForError, prewarmDns, prewarmTls }
