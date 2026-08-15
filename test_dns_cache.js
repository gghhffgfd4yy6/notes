'use strict'

const assert = require('assert')
const dns = require('dns')
const originalLookup = dns.lookup
let calls = 0
dns.lookup = (hostname, options, callback) => {
  calls += 1
  callback(null, '192.0.2.1', 4)
};

(async () => {
  try {
    delete require.cache[require.resolve('./xbk_agents')]
    const { prewarmDns, invalidateDns } = require('./xbk_agents')
    await prewarmDns('cache-probe.invalid')
    await prewarmDns('cache-probe.invalid')
    assert.strictEqual(calls, 1, 'TTL 内应命中 DNS 缓存')
    assert.strictEqual(invalidateDns('cache-probe.invalid'), 1, '应清除该主机缓存')
    await prewarmDns('cache-probe.invalid')
    assert.strictEqual(calls, 2, '清除后应重新解析')
    console.log('✅ 连接错误 DNS 失效处理：清除后下一次请求重新解析')
    // v3.263（CodeRabbit）：abort 应 settle 为 aborted 并摘除 dnsPending 记账——再次预热重新发起解析
    const hanging = []
    dns.lookup = (hostname, options, callback) => { hanging.push(callback) } // 模拟坏解析器：永不回调
    const ac = new AbortController()
    const p1 = prewarmDns('abort-probe.invalid', ac.signal)
    await new Promise(resolve => setImmediate(resolve))
    ac.abort()
    const r1 = await p1
    assert.strictEqual(r1.ok, false, 'abort 后应 settle 为失败')
    assert.strictEqual(r1.error, 'aborted', 'abort 后错误应为 aborted')
    const p2 = prewarmDns('abort-probe.invalid')
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(hanging.length, 2, 'abort 后应摘除 pending 记账，再次预热应重新发起解析')
    for (const cb of hanging) cb(null, '192.0.2.1', 4) // 释放挂起回调，避免测试进程悬挂
    await p2
    dns.lookup = (hostname, options, callback) => { calls += 1; callback(null, '192.0.2.1', 4) }
    console.log('✅ prewarmDns abort：settle 为 aborted 且摘除 dnsPending 记账')
    // v3.263（CodeAnt）：abort 后同 key 新 lookup 接管——旧 lookup 完成不得派发/清空新列表
    const raceCbs = []
    dns.lookup = (hostname, options, callback) => { raceCbs.push(callback) }
    const ac3 = new AbortController()
    const pA = prewarmDns('race-probe.invalid', ac3.signal) // lookup #1（挂起）
    await new Promise(resolve => setImmediate(resolve))
    ac3.abort() // 摘除 #1 的记账
    const rA = await pA
    assert.strictEqual(rA.error, 'aborted', '被摘除的 lookup #1 应 settle 为 aborted')
    const pB = prewarmDns('race-probe.invalid') // lookup #2 接管同一 key
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(raceCbs.length, 2, 'abort 后应发起新 lookup')
    raceCbs[0](null, '192.0.2.1', 4) // 旧 lookup 先完成
    await new Promise(resolve => setImmediate(resolve))
    let resolvedEarly = false
    pB.then(() => { resolvedEarly = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(resolvedEarly, false, '旧 lookup 完成不应派发到新请求')
    raceCbs[1](null, '192.0.2.2', 4) // 新 lookup 完成 → pB 用自身结果
    const rb = await pB
    assert.strictEqual(rb.address, '192.0.2.2', '新请求应拿到自身 lookup 的结果（而非旧 lookup 的）')
    dns.lookup = (hostname, options, callback) => { calls += 1; callback(null, '192.0.2.1', 4) }
    console.log('✅ prewarmDns 竞态：旧 lookup 完成不会派发到接管的新请求')
    // CodeAnt v2：旧 lookup 完成不得写缓存——接管等待期间的新调用方不能读到旧解析结果
    const staleCbs = []
    dns.lookup = (hostname, options, callback) => { staleCbs.push(callback) }
    const ac4 = new AbortController()
    const pS1 = prewarmDns('stale-probe.invalid', ac4.signal) // lookup #1
    await new Promise(resolve => setImmediate(resolve))
    ac4.abort()
    const rS1 = await pS1
    assert.strictEqual(rS1.error, 'aborted', '被 abort 的 lookup #1 应 settle 为 aborted')
    const pS2 = prewarmDns('stale-probe.invalid') // lookup #2 接管同一 key
    await new Promise(resolve => setImmediate(resolve))
    staleCbs[0](null, '192.0.2.10', 4) // 旧 lookup 完成（不应写缓存）
    await new Promise(resolve => setImmediate(resolve))
    const pS3 = prewarmDns('stale-probe.invalid') // 新调用方：应加入接管中的 lookup，而非读旧缓存
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(staleCbs.length, 2, '旧 lookup 完成不应写缓存，新调用方应加入接管中的 lookup')
    staleCbs[1](null, '192.0.2.11', 4)
    const rs2 = await pS2
    const rs3 = await pS3
    assert.strictEqual(rs2.address, '192.0.2.11', '接管 lookup 应用自身结果')
    assert.strictEqual(rs3.address, '192.0.2.11', '接管期间新调用方应拿到接管 lookup 结果，而非旧缓存')
    dns.lookup = (hostname, options, callback) => { calls += 1; callback(null, '192.0.2.1', 4) }
    console.log('✅ prewarmDns 竞态 v2：旧 lookup 完成不写缓存，接管期间新调用方不吃旧结果')
  } finally {
    dns.lookup = originalLookup
  }
})().catch(error => {
  console.error(error)
  process.exit(1)
})
