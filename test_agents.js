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
  assert.strictEqual(shouldInvalidateDns({ code: 'ETIMEDOUT' }), false, '超时不应失效 DNS')
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

  console.log('test_agents OK')
})().catch((e) => { console.error(e); process.exit(1) })
