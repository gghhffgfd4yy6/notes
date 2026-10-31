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

// C10-074（audit38）：同 key 等待项的上限与单次等待上限（毫秒）。
// 为什么必须有：`dns.lookup` 无法取消（got 的 signal 传不到这里，见 prewarmDns 的注释），坏解析器 /
// 网络黑洞下底层回调永远不来 ⇒ 「同 key 复用一次底层 lookup」会把所有等待项无限堆在 dnsPending 里
// （实测：500 次调用 = 1 次底层 lookup + 500 个回调全部存活，再压 1000 次变 1500 个），而普通调用方
// （含 got 超时/取消后仍存在的 net lookup 回调）没有任何摘除路径 ⇒ 长驻进程无界增长、调用方永远收不到回调。
// 两个上限的分工：cap 让表**有界**（超限立即以可重试错误失败，不静默丢），deadline 让等待项**有终点**
// （到点按失败回调并摘除）。默认 10s 远大于正常解析耗时（CI 实测 <1s），只为坏解析器兜底。
const DNS_PENDING_MAX_WAITERS = 64
const DNS_PENDING_TIMEOUT_DEFAULT_MS = 10000

// 正整数环境变量（与 run_tests.js 的 positiveIntEnv 同口径）：非法值告警并回退默认，绝不按非法值运行。
// 只给测试注入用；生产不设即走默认 10s。
function positiveIntEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`⚠️  环境变量 ${name}=${raw} 非法（应为正整数），已回退默认值 ${fallback}`)
    return fallback
  }
  return value
}

const DNS_PENDING_TIMEOUT_MS = positiveIntEnv('XBK_DNS_PENDING_TIMEOUT_MS', DNS_PENDING_TIMEOUT_DEFAULT_MS)

// PR #362 评审（CodeRabbit Major · Stability & Availability）：deadline 只给**等待项**一个终点，不回收
// 底层查询——`dns.lookup` 无法取消，等待项超时后那条 getaddrinfo 仍占着 libuv 线程池里的一个线程；
// 同 key 每轮重试都会另起一条（实测：8 轮重试 = 8 条在飞），坏解析器下无界累积，可占满线程池并拖慢
// 同池的文件操作。故对「已交给底层、回调还没到」的查询记**两份账**，分工不同：
//   · 软名额（同 key ≤ DNS_INFLIGHT_MAX_PER_KEY，全局 ≤ DNS_INFLIGHT_MAX）：表达「这个 key 最近试过几次」，
//     管**允许恢复探测**。同 key 2 条：正常慢解析（第一条在飞时超时、重试接班第二条）够用，第三条起立即
//     失败；全局 32（默认，XBK_DNS_MAX_INFLIGHT 可注入）：兜住多主机同时打洞的进程级占用。
//   · 真实名额（DNS_REAL_INFLIGHT_MAX，默认 64，XBK_DNS_MAX_REAL_INFLIGHT 可注入）：表达「真实还有几条
//     getaddrinfo 没跑完」，管**真实并发的硬顶**。只由两条路径释放：底层回调到达（第一时间 -1，在
//     endInflightLookup 与 onDone 之前）与 startInflightLookup 的同步抛错。
//   · 单条最长存活 DNS_INFLIGHT_MAX_AGE_MS（默认 60s，XBK_DNS_MAX_INFLIGHT_AGE_MS 可注入）：软名额必须
//     有退役路径，否则「坏解析器永不回调」会把软名额永久占住——同 key 两条填满后，这个主机连解析器恢复
//     也永远拿到 EAI_AGAIN（直到进程重启），等于把「无界泄漏」换成「单主机 DNS 永久瘫痪」。
//     过龄条目在过闸时逐条退役、当场归还**软**名额；退役只动记账，不动那条底层查询的回调语义。
// 为什么过龄退役绝不能释放真实名额：退役只是让 JS 侧重试（这个 key 可以再发起探测），那条 getaddrinfo
// 仍在 libuv 线程池里跑、回调没到就还没结束。若退役也归还真实名额，重试就又能新增一条，跨每个存活周期
// 净增一批，**真实未完成查询数仍然无界**——这正是只有软上限时的漏洞：60s 周期一到，同 key 又能起 2 条，
// 慢速泄漏照样填满线程池。硬顶的语义就是只认「回调到了 / 当场抛错」这一个事实。
// 超限一律以 EAI_AGAIN 立即失败（与等待队列上限同码、可重试，且不静默丢回调）。
// 为什么不走「超时后继续复用那条在飞查询」：仓内契约要求超时后重试必须重新发起解析
// （test_dns_cache.js「超时摘除后重试必须重新发起底层 lookup」），且坏解析器若永不回调，复用等于让
// 该 key 永久卡死。上限与存活时间只压**并发在飞条数**，不改变「超时 ⇒ 本次失败、下次可重试」的语义。
const DNS_INFLIGHT_MAX_DEFAULT = 32
const DNS_INFLIGHT_MAX_PER_KEY = 2
const DNS_INFLIGHT_MAX = positiveIntEnv('XBK_DNS_MAX_INFLIGHT', DNS_INFLIGHT_MAX_DEFAULT)
const DNS_INFLIGHT_MAX_AGE_MS = positiveIntEnv('XBK_DNS_MAX_INFLIGHT_AGE_MS', 60000)
// 真实在飞硬顶：默认 64，必须远高于软全局上限 32——它兜的是未完成的 getaddrinfo 队列（超了就是真实查询
// 无界堆积），不是恢复探测的节流阀（那是软名额的活）；压到软上限之下只会让软名额永远用不满，且同 key
// 的两条接班查询也无处安放。
const DNS_REAL_INFLIGHT_MAX_DEFAULT = 64
const DNS_REAL_INFLIGHT_MAX = positiveIntEnv('XBK_DNS_MAX_REAL_INFLIGHT', DNS_REAL_INFLIGHT_MAX_DEFAULT)
// key → 在飞条目数组（key 为 null 表示该调用不进缓存，借同一个 Map 只计全局数，否则它没有退役路径）。
// 每条带 startedAt 供逐条退役；条目对象本身就是回调的身份凭据（见 endInflightLookup）。
const dnsInflight = new Map()
let dnsInflightTotal = 0
// 真实在飞条数：只由底层回调到达或同步抛错增减，**过龄退役绝不碰它**（见上）。
let dnsRealInflightTotal = 0

// 等待项失败用的错误：码必须落在 xbk_failure_policy 的可重试集合里（ETIMEDOUT / EAI_AGAIN 都是），
// 否则一次本地排队失败会被判成 PERMANENT、连重试都不许。
function dnsPendingError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// 在飞记账只覆盖真正交给解析器的调用；回调**第一件事**就释放（身份检查之前——线程已还回池子，
// 与这条 lookup 的结果还要不要无关）。key 为 null 表示该调用不进缓存，只计全局数。
function inflightLookupsFor (key) {
  const entries = dnsInflight.get(key)
  return entries ? entries.length : 0
}

function beginInflightLookup (key) {
  const entry = { key, startedAt: Date.now(), retired: false }
  const entries = dnsInflight.get(key)
  if (entries) entries.push(entry)
  else dnsInflight.set(key, [entry])
  dnsInflightTotal += 1
  return entry
}

// 释放名额。身份校验：条目一旦按龄退役（名额当时已归还），它自己晚到的回调只能清自己的账、不得再减
// 一次——否则会把全局计数减成负数（上限失效），或把后来那条同名 key 的新条目名额一起吃掉。
function endInflightLookup (entry) {
  if (entry.retired) return
  entry.retired = true
  dnsInflightTotal -= 1
  const entries = dnsInflight.get(entry.key)
  if (!entries) return
  const left = entries.filter(other => other !== entry)
  if (left.length > 0) dnsInflight.set(entry.key, left)
  else dnsInflight.delete(entry.key)
}

// 按龄逐条退役：只归还**软**名额，不碰底层查询本身（取消不了），不碰真实名额（那条 getaddrinfo 还在
// 线程池里跑，回调没到就不算结束——退役只是让 JS 侧能再试），也不碰它的回调派发语义——结果还要不要由
// dnsLookup 里既有的 pending record 身份检查决定。
function retireAgedInflight (now) {
  for (const [key, entries] of [...dnsInflight]) {
    const alive = []
    for (const entry of entries) {
      if (now - entry.startedAt < DNS_INFLIGHT_MAX_AGE_MS) {
        alive.push(entry)
        continue
      }
      entry.retired = true
      dnsInflightTotal -= 1
    }
    if (alive.length > 0) dnsInflight.set(key, alive)
    else dnsInflight.delete(key)
  }
}

// 释放真实名额。与 endInflightLookup 的 retired 同口径：一条底层查询只有一份真实名额，故它只能被释放
// 一次，否则计数会被减成负数、硬顶随之失效（实测硬顶 3 却放行 6 条）。两条违反 dns.lookup 契约的路径
// 都会重复释放：底层同步回调 + 调用方回调抛错（异常冒进 startInflightLookup 的 catch 再释放一次）、
// 底层回调被调两次。标记只挡「第二次释放」，不新增释放路径——真实名额仍只由「回调到达」与「同步抛错」
// 两条路径归还，过龄退役依旧绝不碰它。
function releaseRealInflight (entry) {
  if (entry.realReleased) return
  entry.realReleased = true
  dnsRealInflightTotal -= 1
}

// 发起一条底层查询并记两份账。真实名额在 dns.lookup 之前 +1、回调第一件事归还（先于软名额与 onDone：
// 线程已还回池子，与这条 lookup 的结果还要不要无关）。同步抛错（非法参数等）时必须当场释放两份名额——
// 否则这条永远收不到回调的记账会白占名额，攒满上限后整个进程的解析都会被判成超限。
function startInflightLookup (key, hostname, opts, onDone) {
  const entry = beginInflightLookup(key)
  entry.realReleased = false // 名额身份凭据：先于 +1 建立，回调与 catch 共用同一次释放
  dnsRealInflightTotal += 1
  try {
    dns.lookup(hostname, { ...opts, all: true }, (error, address, family) => {
      releaseRealInflight(entry)
      endInflightLookup(entry)
      onDone(error, address, family)
    })
  } catch (e) {
    releaseRealInflight(entry)
    endInflightLookup(entry)
    throw e
  }
}

// 超限错误：立即失败，绝不新建 getaddrinfo 任务。检查点放在「建等待项之前」——超限的调用方既不占
// 等待队列，也不会留下一条永远等不到回调的记账。
// 先按龄退役再判上限：软名额过龄后必须允许另起一条底层查询，否则坏解析器下这个主机永久 EAI_AGAIN
// （名额被永不回调的老查询占死）。真实名额则**不因退役归还**，故它是唯一能拦住「每过一个存活周期又
// 新增一批真实查询」的那道闸——两道闸顺序：先真实硬顶，再软全局，最后同 key。
function inflightLimitError (key) {
  retireAgedInflight(Date.now())
  if (dnsRealInflightTotal >= DNS_REAL_INFLIGHT_MAX) {
    return dnsPendingError('EAI_AGAIN',
      `DNS 真实在飞查询已达硬上限（真实在飞 ${dnsRealInflightTotal} 条 ≥ ${DNS_REAL_INFLIGHT_MAX}），本次调用按失败返回，可重试`)
  }
  if (dnsInflightTotal >= DNS_INFLIGHT_MAX) {
    return dnsPendingError('EAI_AGAIN',
      `DNS 在飞查询已达全局上限（在飞 ${dnsInflightTotal} 条 ≥ ${DNS_INFLIGHT_MAX}），本次调用按失败返回，可重试`)
  }
  if (key !== null && inflightLookupsFor(key) >= DNS_INFLIGHT_MAX_PER_KEY) {
    return dnsPendingError('EAI_AGAIN',
      `DNS 在飞查询已达同 key 上限（同 key 在飞 ${inflightLookupsFor(key)} 条 ≥ ${DNS_INFLIGHT_MAX_PER_KEY}），本次调用按失败返回，可重试`)
  }
  return null
}

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

// 等待项计时器（C10-074）：deadline 逐条目登记，但一个 key 只保留**一个** timer（合并到最早 deadline），
// 到点只摘除真正过期的项，其余重算下一个最早 deadline。timer 一律 unref——正常路径会 clearTimeout，
// 这里兜底：坏解析器场景不得因为一个计时器把进程钉住。
function clearPendingTimer (record) {
  if (record && record.timer) {
    clearTimeout(record.timer)
    record.timer = null
  }
}

function armPendingTimer (key, record) {
  if (!record || record.entries.length === 0) return
  clearPendingTimer(record)
  let next = Infinity
  for (const entry of record.entries) if (entry.deadline < next) next = entry.deadline
  record.timer = setTimeout(() => sweepExpiredWaiters(key, record), Math.max(0, next - Date.now()))
  if (typeof record.timer.unref === 'function') record.timer.unref()
}

// 到点的等待项：先按 key 摘除记账，再逐个以 ETIMEDOUT 失败回调（**不静默丢**）。
// 为什么先摘除再回调：回调里若同步重试（很常见），不得让它看到这批已过期的等待项，也不得把新 lookup
// 绑到一条已经判定超时的底层调用上。底层 lookup 若晚到，dnsLookup 里的身份检查会把它整条丢弃。
function sweepExpiredWaiters (key, record) {
  record.timer = null
  if (dnsPending.get(key) !== record) return
  const now = Date.now()
  const expired = record.entries.filter(entry => entry.deadline <= now)
  if (expired.length === 0) {
    armPendingTimer(key, record)
    return
  }
  record.entries = record.entries.filter(entry => entry.deadline > now)
  if (record.entries.length === 0) dnsPending.delete(key)
  else armPendingTimer(key, record)
  const err = dnsPendingError('ETIMEDOUT', `DNS 解析等待超时（>${DNS_PENDING_TIMEOUT_MS}ms，底层 lookup 未回调）`)
  for (const entry of expired) dispatchLookupResult(entry.callback, entry.all, err)
}

function dnsLookup (hostname, options, callback) {
  const opts = options || {}
  const wantAll = Boolean(opts.all)
  const key = dnsCacheKey(hostname, opts)
  // AGENTS-11：选项未建模（未知键/非法取值）→ 不读也不写缓存，按调用方原选项直接解析。
  // 这类调用方（目前只有测试/未来扩展）失去缓存收益，换来的是「拿到的地址一定按自己的选项
  // 筛选/排序过」，也不会污染同主机其它选项的缓存条目。
  if (key === null) {
    const overLimit = inflightLimitError(null)
    if (overLimit) {
      queueMicrotask(() => dispatchLookupResult(callback, wantAll, overLimit))
      return
    }
    startInflightLookup(null, hostname, opts, (error, address, family) => dispatchLookupResult(callback, wantAll, error, address, family))
    return
  }
  const now = Date.now()
  const cached = dnsCache.get(key)
  if (cached && cached.expiresAt > now) {
    queueMicrotask(() => dispatchLookupResult(callback, wantAll, cached.error, cached.address, cached.family))
    return
  }

  // C10-074：普通调用方（含 got 超时/取消后仍存在的 net lookup 回调）没有摘除路径，故这里用
  // 「同 key 上限 + 逐条目 deadline」兜住：超限立即以 EAI_AGAIN 失败（不静默丢），超时由
  // sweepExpiredWaiters 以 ETIMEDOUT 失败并摘除。底层回调正常到达时仍是「一次 lookup 派发给全部等待项」。
  const pending = dnsPending.get(key)
  if (pending) {
    if (pending.entries.length >= DNS_PENDING_MAX_WAITERS) {
      const err = dnsPendingError('EAI_AGAIN',
        `DNS 等待队列已满（同 key ${pending.entries.length} 项 ≥ 上限 ${DNS_PENDING_MAX_WAITERS}），本次调用按失败返回，可重试`)
      // 与缓存命中路径同口径：回调一律异步派发，绝不在 dnsLookup 里同步回调调用方
      queueMicrotask(() => dispatchLookupResult(callback, wantAll, err))
      return
    }
    pending.entries.push({ callback, all: wantAll, deadline: Date.now() + DNS_PENDING_TIMEOUT_MS })
    armPendingTimer(key, pending)
    return
  }
  // PR #362 评审：新建底层查询之前先过在飞上限——等待项超时只摘记账、不回收在飞查询，若不设上限，
  // 坏解析器下同 key 每轮重试都再起一条 getaddrinfo，最终占满 libuv 线程池并拖慢同池文件操作。
  // 与等待队列上限同口径：超限立即以 EAI_AGAIN 失败（可重试），回调一律异步派发。
  const overLimit = inflightLimitError(key)
  if (overLimit) {
    queueMicrotask(() => dispatchLookupResult(callback, wantAll, overLimit))
    return
  }
  const record = { entries: [{ callback, all: wantAll, deadline: Date.now() + DNS_PENDING_TIMEOUT_MS }], timer: null }
  dnsPending.set(key, record)
  armPendingTimer(key, record)
  startInflightLookup(key, hostname, opts, (error, address, family) => {
    // v3.263（CodeAnt）：只派发并缓存本次记账列表——abort 摘除回调后若同一 key 已有新 lookup
    // 接管，旧 lookup 完成时不得清空/派发到新列表，也不得写缓存（接管等待期间新调用方会读到
    // 旧结果，且晚到的旧回调会覆盖更新的缓存条目；新 lookup 会缓存自己的结果）。
    // C10-074：超时也走同一条身份检查——sweep 已把 key 摘掉/换新，晚到的旧回调整条丢弃。
    if (dnsPending.get(key) !== record) return
    dnsPending.delete(key)
    clearPendingTimer(record)
    const ttl = error ? DNS_ERROR_TTL_MS : DNS_TTL_MS
    dnsCache.set(key, { error, address, family, expiresAt: Date.now() + ttl })
    for (const entry of record.entries) dispatchLookupResult(entry.callback, entry.all, error, address, family)
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
      const record = key === null ? null : dnsPending.get(key)
      if (record) {
        // 等待项条目是 { callback, all, deadline }：按回调身份定位本记账项
        const i = record.entries.findIndex(entry => entry.callback === callback)
        if (i !== -1) record.entries.splice(i, 1)
        if (record.entries.length === 0) {
          // 本 key 已无等待项：连同 deadline 计时器一起摘除，别留一个空壳 timer
          clearPendingTimer(record)
          dnsPending.delete(key)
        } else {
          armPendingTimer(key, record) // 摘掉最早 deadline 的那项后要重排 timer
        }
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

// C10-073：预热 GET 回退的响应体上限。与 xbk_http.js 的 DEFAULT_MAX_BODY 同值同口径（那边是 20MB），
// 但**不 require xbk_http**——xbk_http 反向 require 本文件，循环依赖会让其中一侧在加载期拿到 undefined
// （谁先被 require 谁就拿不到对方的导出）。两处一致性由 test_tls_prewarm.js 直接比对常量断言。
const PREWARM_BODY_CAP = 20 * 1024 * 1024

// C10-073：「有上限」的预热 GET。预热只为建连、正文不需要，但也不能一律 destroy——不读完响应体
// socket 就回不到 keep-alive 池，预热本身失去意义。故：逐块累计，未超限则读到 end（连接回池），
// 超限立刻 destroy 并停止读取（此时 TLS 握手早已成功，按 ok:true 记建连 + bodyExceeded 供诊断）。
// 用 stream 而不是 got.get：got@11 没有 maxResponseSize 选项，got.get 的 promise 要等整个响应体读完
// 才 settle（实测 8MB 响应体会被完整读入）。
function prewarmConnectGet (url, options) {
  return new Promise((resolve, reject) => {
    // 替身/精简版 got 没有 stream.get（真实 got 恒有）：回落到 got.get，保持既有可测路径不变
    if (!got.stream || typeof got.stream.get !== 'function') {
      got.get(url, options).then(() => resolve({ bodyExceeded: false }), reject)
      return
    }
    let stream
    try {
      stream = got.stream.get(url, options)
    } catch (e) {
      reject(e)
      return
    }
    let received = 0
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }
    // error 用 on（不是 once）：destroy 之后可能再冒一个 ERR_STREAM_PREMATURE_CLOSE，settle 已完成后
    // 它必须仍被消费掉，否则会变成未捕获的 'error' 事件把进程打挂
    stream.on('error', (e) => finish(e))
    stream.on('data', (chunk) => {
      received += chunk && chunk.length ? chunk.length : 0
      if (received > PREWARM_BODY_CAP) {
        stream.destroy()
        finish(null, { bodyExceeded: true })
      }
    })
    stream.once('end', () => finish(null, { bodyExceeded: false }))
  })
}

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
  // AGENTS-05 / C10-073：本 HEAD→GET 回退只为建连。旧实现 await got.get 会读完整个响应体且零上限；
  // 现由 prewarmConnectGet 逐块累计、超 PREWARM_BODY_CAP（= xbk_http 的 20MB 口径）即 destroy。
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
  // C10-075：HEAD 被拒（405 等 statusCode>=400，throwHttpErrors=false 时不进 catch）与 HEAD 抛错（外层
  // catch）都要回退 GET 建连，旧实现把同一段回退逐字写了两份——修一处漏一处必然漂移（AGENTS-06 的取消语义
  // 就是这样补了两次）。收敛成单一实现：先看取消 → GET → 成功标 viaGet / 失败按取消或错误归类，
  // 结果对象形状与两份旧代码逐字段一致（cancelled / error / viaGet 三选一 + elapsedMs）。
  // C10-073：GET 回退必须有体量上限。预热只为建连、正文一点不需要，而旧实现 await got.get(...) 会把
  // 整个响应体读进内存（× count 条连接，最多 64 条）；got@11 没有 maxResponseSize 选项，xbk_http.js
  // 的 DEFAULT_MAX_BODY 只覆盖 fetchJson ⇒ 此路径此前零上限。口径直接复用 DEFAULT_MAX_BODY（不新造
  // 数字），实现用 got.stream.get 逐块累计：超限立即 destroy 并停止读取。
  const fallbackGet = async (singleStart) => {
    if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
    try {
      const outcome = await prewarmConnectGet(`https://${hostname}/`, baseOptions)
      return { ok: true, elapsedMs: Date.now() - singleStart, viaGet: true, ...(outcome && outcome.bodyExceeded ? { bodyExceeded: true } : {}) }
    } catch (e2) {
      // v3.233/AGENTS-06：GET 独立捕获，失败绝不再落回外层 catch 重发一次 GET（同一主机重复建连）；
      // 回退期间被 abort 时返回 cancelled 而非普通 error。
      if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
      return { ok: false, error: e2 && (e2.code || e2.message) ? String(e2.code || e2.message) : String(e2), elapsedMs: Date.now() - singleStart }
    }
  }
  const results = await Promise.all(Array.from({ length: connectionCount }, async () => {
    const singleStart = Date.now()
    try {
      // HEAD 无响应体：只需 DNS+TCP+TLS+响应头即可完成建连，连接进入 Keep-Alive 池，
      // 比 GET 下载首页快得多（GET 会把 body 下载时间也算进预取）。
      const response = await got.head(`https://${hostname}/`, baseOptions)
      // throwHttpErrors=false 时 405 不会进入 catch，显式检查后才回退 GET。
      if (response && response.statusCode >= 400) return await fallbackGet(singleStart)
      return { ok: true, elapsedMs: Date.now() - singleStart }
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, cancelled: true, elapsedMs: Date.now() - singleStart }
      // 服务端不支持 HEAD（如 405 抛出）时回退 GET 建连；仍失败则静默跳过。
      return await fallbackGet(singleStart)
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

module.exports = { AGENTS, DNS_LOOKUP_IP_VERSION, dnsLookup, invalidateDns, shouldInvalidateDns, profileMs, baseRequestOptions, invalidateDnsForError, prewarmDns, prewarmTls, PREWARM_BODY_CAP, DNS_PENDING_MAX_WAITERS, DNS_PENDING_TIMEOUT_MS, DNS_INFLIGHT_MAX, DNS_INFLIGHT_MAX_PER_KEY, DNS_INFLIGHT_MAX_AGE_MS, DNS_REAL_INFLIGHT_MAX }
