'use strict'

const assert = require('assert')
const dns = require('dns')
const {
  profileMs,
  shouldInvalidateDns,
  baseRequestOptions,
  invalidateDnsForError,
  invalidateDns
} = require('./xbk_agents')

// 确定性 DNS mock：避免测试依赖真实网络/解析器。
// 精简容器可能 /etc/hosts 缺 localhost 或 DNS 不可达，导致 dnsLookup 真实解析失败而误报。
// 统一回环解析，使 dnsCache 的填充/命中/失效路径仍可验证且不触网。
// ⚠️ 显式声明：本 mock 不模拟 family/options 语义——无条件返回 family=4，并忽略入参 options
// （family/all/hints）。若将来新增“XBK_DNS_FAMILY=6 → 解析出 IPv6”等断言，需在此依据
// options.family / options.all 返回对应结果，否则会因固定返回 4 而假绿。
dns.lookup = (hostname, options, callback) => {
  const cb = typeof options === 'function' ? options : callback
  process.nextTick(() => cb(null, '127.0.0.1', 4))
}

;(async () => {
  // ===== profileMs：有限数值四舍五入，否则 'n/a' =====
  assert.strictEqual(profileMs(123.6), 124, '有限数值应四舍五入')
  assert.strictEqual(profileMs(0), 0, '0 应保留')
  assert.strictEqual(profileMs(2.4), 2, '2.4 应四舍五入为 2')
  assert.strictEqual(profileMs(Number.NaN), 'n/a', 'NaN 应为 n/a')
  assert.strictEqual(profileMs(Infinity), 'n/a', 'Infinity 应为 n/a')
  assert.strictEqual(profileMs(-Infinity), 'n/a', '-Infinity 应为 n/a')
  assert.strictEqual(profileMs('5'), 'n/a', '字符串不应被接受')

  // ===== shouldInvalidateDns：仅 DNS/连接类错误码触发 =====
  assert.strictEqual(shouldInvalidateDns({ code: 'ENOTFOUND' }), true, 'ENOTFOUND 应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'ECONNRESET' }), true, 'ECONNRESET 应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'EAI_AGAIN' }), true, 'EAI_AGAIN 应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'HTTP_500' }), false, 'HTTP 错误不应失效 DNS')
  // AGENTS-02：超时（ETIMEDOUT）同样失效——重试窗口（got 1s/2s）远短于 60s TTL，超时很可能就是缓存
  // 里那个地址已不可达，不清缓存则整个重试窗口反复复用同一失效地址。此处必为 true（旧口径 false）。
  assert.strictEqual(shouldInvalidateDns({ code: 'ETIMEDOUT' }), true, '超时应失效 DNS（AGENTS-02）')
  assert.strictEqual(shouldInvalidateDns({}), false, '无 code 不应失效')
  assert.strictEqual(shouldInvalidateDns(null), false, 'null 不应失效')
  assert.strictEqual(shouldInvalidateDns(undefined), false, 'undefined 不应失效')

  // ===== baseRequestOptions：组合默认请求选项 =====
  const opts = baseRequestOptions()
  assert.ok(opts.agent, '应含 agent')
  assert.strictEqual(typeof opts.lookup, 'function', '应含 lookup（dnsLookup）')
  let expectedFamily = ''
  if (process.env.XBK_DNS_FAMILY === '4') expectedFamily = 'ipv4'
  else if (process.env.XBK_DNS_FAMILY === '6') expectedFamily = 'ipv6'
  if (expectedFamily) {
    assert.strictEqual(opts.dnsLookupIpVersion, expectedFamily, 'XBK_DNS_FAMILY 应映射为对应 dnsLookupIpVersion')
  } else {
    assert.ok(!('dnsLookupIpVersion' in opts), '未设置 XBK_DNS_FAMILY 时不应带 dnsLookupIpVersion')
  }

  // ===== invalidateDnsForError：DNS 错误 + 可解析 URL → 失效并返回 true =====
  assert.strictEqual(invalidateDnsForError({ code: 'ENOTFOUND' }, 'https://example.com/api/x'), true, 'DNS 错误应触发缓存失效')
  assert.strictEqual(invalidateDnsForError({ code: 'ECONNRESET' }, 'https://example.com/'), true, '连接错误应触发缓存失效')
  assert.strictEqual(invalidateDnsForError({ code: 'HTTP_500' }, 'https://example.com'), false, '非 DNS 错误不失效')
  assert.strictEqual(invalidateDnsForError({ code: 'ENOTFOUND' }, 'not a url'), false, 'URL 解析失败应返回 false')
  assert.strictEqual(invalidateDnsForError(null, 'https://example.com'), false, 'null 错误不失效')

  // ===== invalidateDns：非法/未缓存 hostname 返回 0，不抛错 =====
  assert.strictEqual(invalidateDns(''), 0, '空串 hostname 返回 0')
  assert.strictEqual(invalidateDns(null), 0, 'null hostname 返回 0')
  assert.strictEqual(invalidateDns(123), 0, '非字符串 hostname 返回 0')
  assert.strictEqual(invalidateDns('no.such.host.in.cache.example'), 0, '未缓存 hostname 返回 0')

  // ===== dnsLookup：缓存命中 + 缓存未命中 + 并发去重 =====
  // #19 修复：此前 dnsLookup 完全未被测试，导致 xbk_agents 分支覆盖率标称 100% 但实测 63-77%。
  const { dnsLookup } = require('./xbk_agents')

  // AGENTS-02 行为断言：ETIMEDOUT 必须真的清掉缓存条目（不只是 shouldInvalidateDns 返回 true）——
  // 先用 dnsLookup 填充，再用 ETIMEDOUT 失效，随后同一主机的 lookup 必须重新走底层解析（计数 +1）。
  {
    const timeoutHost = 'timeout-invalidate-probe.invalid'
    let timeoutLookups = 0
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      timeoutLookups += 1
      process.nextTick(() => cb(null, '192.0.2.9', 4))
    }
    await new Promise((resolve, reject) => dnsLookup(timeoutHost, {}, (e) => e ? reject(e) : resolve()))
    assert.strictEqual(timeoutLookups, 1, '首次解析应走底层')
    assert.strictEqual(invalidateDnsForError({ code: 'ETIMEDOUT' }, `https://${timeoutHost}/api`), true, 'ETIMEDOUT 应触发缓存失效（AGENTS-02）')
    await new Promise((resolve, reject) => dnsLookup(timeoutHost, {}, (e) => e ? reject(e) : resolve()))
    assert.strictEqual(timeoutLookups, 2, 'ETIMEDOUT 失效后同一主机应重新解析（旧口径此处仍为 1）')
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      process.nextTick(() => cb(null, '127.0.0.1', 4))
    }
    console.log('✅ AGENTS-02：ETIMEDOUT 清理 DNS 缓存后重试窗口重新解析')
  }

  // 场景 1：缓存未命中 → 真实解析后回调，且第二次调用命中缓存（更快）
  await new Promise((resolve, reject) => {
    dnsLookup('localhost', {}, (err, address, family) => {
      if (err) { reject(err); return }
      // 第二次调用应命中缓存（queueMicrotask 派发，远快于真实解析）
      const t1 = Date.now()
      dnsLookup('localhost', {}, (err2, address2, family2) => {
        if (err2) { reject(err2); return }
        const secondMs = Date.now() - t1
        assert.strictEqual(address, address2, '缓存命中应返回相同 address')
        assert.strictEqual(family, family2, '缓存命中应返回相同 family')
        // 缓存命中通过 queueMicrotask 派发，应远快于第一次真实解析（留 100ms 余量防 CI 抖动）
        assert.ok(secondMs < 100, `缓存命中应快速返回，实际 ${secondMs}ms`)
        resolve()
      })
    })
  })

  // 场景 2：并发去重 → 同一 key 的并发调用只发起一次真实解析，两个回调都被派发
  await new Promise((resolve, reject) => {
    let callCount = 0
    // 5 秒超时兜底（DNS 解析不应超过 5 秒）；settled 后 clearTimeout，避免已成功仍空转 5s
    const timer = setTimeout(() => reject(new Error('dnsLookup 并发去重超时')), 5000)
    const done = () => { clearTimeout(timer); resolve() }
    const cb1 = () => { callCount += 1; if (callCount === 2) done() }
    const cb2 = () => { callCount += 1; if (callCount === 2) done() }
    // 用不同的 hostname 避免命中之前的缓存
    dnsLookup('localhost.localdomain', {}, cb1)
    dnsLookup('localhost.localdomain', {}, cb2)
  })

  // ===== invalidateDns：缓存命中时删除并返回计数 =====
  // 先清除可能存在的缓存，再 dnsLookup 填充，最后 invalidateDns 断言删除数 > 0
  const invalidateHost = 'localhost'
  invalidateDns(invalidateHost) // 预清除，确保计数从 0 开始
  await new Promise((resolve, reject) => {
    dnsLookup(invalidateHost, {}, (err) => {
      if (err) { reject(err); return }
      resolve()
    })
  })
  const removed = invalidateDns(invalidateHost)
  assert.ok(removed > 0, `invalidateDns 缓存命中应返回删除数 > 0，实际 ${removed}`)
  const removedAgain = invalidateDns(invalidateHost)
  assert.strictEqual(removedAgain, 0, '缓存已删除后再次调用应返回 0')

  // ===== prewarmDns：基本解析 + abort 取消 =====
  const { prewarmDns } = require('./xbk_agents')

  // 场景 1：正常解析 → 返回 ok=true
  const prewarmResult = await prewarmDns('localhost')
  assert.strictEqual(prewarmResult.hostname, 'localhost', '应返回 hostname')
  assert.ok(typeof prewarmResult.ok === 'boolean', 'ok 应为布尔值')
  assert.ok(typeof prewarmResult.elapsedMs === 'number', 'elapsedMs 应为数字')

  // 场景 2：已 aborted signal → 立即返回 cancelled
  const ac = new AbortController()
  ac.abort()
  const abortedResult = await prewarmDns('localhost', ac.signal)
  assert.strictEqual(abortedResult.ok, false, 'aborted 时 ok 应为 false')
  assert.ok(abortedResult.error?.includes('abort') || abortedResult.cancelled === true, 'aborted 时应包含取消信息')

  // ===== AGENTS-01：prewarmDns 必须与真实请求的 lookup 同 key（默认 DNS 模式预热才有效）=====
  // 真实 net.connect 在 Node ≥20（autoSelectFamily 默认开启）下以 {hints: ADDRCONFIG(1024), all: true}
  // 调用本 lookup（本机 Node v24 实测 {"hints":1024,"all":true}），而 prewarmDns 传的是 {}。
  // 旧实现把 hints/all/verbatim 编进 key → 两者永不同 key，预热写进一个永不被读的条目，
  // DNS 预热完全无效（本断言在旧代码下必红：底层次数为 2 而非 1）。现按 hostname+family 共享条目，
  // 底层统一按 all:true 解析并缓存完整地址列表，回调形状在派发时按各调用方的 all 适配。
  {
    const keyProbeHost = 'prewarm-key-probe.invalid'
    const keyCalls = []
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      const opts = typeof options === 'function' ? {} : (options || {})
      keyCalls.push({ hostname, options: opts })
      process.nextTick(() => cb(null, opts.all ? [{ address: '192.0.2.7', family: 4 }] : '192.0.2.7', 4))
    }
    const warm = await prewarmDns(keyProbeHost)
    assert.strictEqual(warm.ok, true, '预热应成功')
    assert.strictEqual(keyCalls.length, 1, '预热应发起 1 次底层解析')
    assert.strictEqual(keyCalls[0].options.all, true, '底层应统一按 all:true 解析（缓存完整地址列表）')
    // 真实请求形态：net 传 hints=ADDRCONFIG + all=true → 必须命中预热写入的缓存条目
    const allHit = await new Promise((resolve, reject) => {
      dnsLookup(keyProbeHost, { hints: 1024, all: true }, (err, address, family) => err ? reject(err) : resolve({ address, family }))
    })
    assert.strictEqual(keyCalls.length, 1, `预热后真实请求形态的 lookup 应命中同一缓存（旧 key 含 hints/all 时为 2），实际 ${keyCalls.length}`)
    assert.ok(Array.isArray(allHit.address) && allHit.address[0] && allHit.address[0].address === '192.0.2.7', 'all:true 调用方应拿到地址数组')
    // 同一缓存条目服务非 all 调用方：形状适配为标量
    const scalarHit = await new Promise((resolve, reject) => {
      dnsLookup(keyProbeHost, {}, (err, address, family) => err ? reject(err) : resolve({ address, family }))
    })
    assert.strictEqual(keyCalls.length, 1, '非 all 调用方也应命中同一缓存条目，不应再发起解析')
    assert.strictEqual(scalarHit.address, '192.0.2.7', '非 all 调用方应拿到标量地址')
    assert.strictEqual(scalarHit.family, 4, '非 all 调用方应拿到地址族')
    // 恢复文件头的确定性 mock（保持后续断言的既定语义）
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      process.nextTick(() => cb(null, '127.0.0.1', 4))
    }
    console.log('✅ AGENTS-01：prewarmDns 与真实请求同 key（hints/all 不再导致缓存错配）')
  }

  // ===== module.exports：不再导出死值 DNS_CACHE（AGENTS-08）=====
  // 旧导出含 `DNS_CACHE: null`（无任何读取方）；若回退该行，`in` 判定为 true 即红。
  const agentsExports = require('./xbk_agents')
  assert.ok(!('DNS_CACHE' in agentsExports), 'module.exports 不应再包含 DNS_CACHE')

  console.log('test_agents OK')
})().catch((e) => { console.error(e); process.exit(1) })
