'use strict'

// C10-074：坏解析器场景要在测试里快速验证——把等待上限压到 150ms（生产默认 10s）。
// 必须在 require('./xbk_agents') 之前设置（模块加载时读取）。
process.env.XBK_DNS_PENDING_TIMEOUT_MS = '150'
// PR #362：全局在飞 lookup 上限同口径压小（生产默认 32）——否则要造 32 个「堆死」的主机才能验证上限。
process.env.XBK_DNS_MAX_INFLIGHT = '6'

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
    const { prewarmDns, invalidateDns, dnsLookup, DNS_PENDING_MAX_WAITERS, DNS_PENDING_TIMEOUT_MS, DNS_INFLIGHT_MAX, DNS_INFLIGHT_MAX_PER_KEY } = require('./xbk_agents')
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
    // ── C10-074（audit38 · P3）：同 key 等待项必须有上限 + deadline ────────────────────────────
    // 复现（修复前）：坏解析器永不回调时，同 key 500 次 dnsLookup 只发起 1 次底层 lookup，
    // dnsPending 里堆 500 个回调（再压 1000 次 → 1500），底层不回调时无任何超时/上限/摘除路径，
    // 长驻进程下无界增长且调用方永远收不到回调。
    const cap = DNS_PENDING_MAX_WAITERS
    assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 1000, `同 key 等待上限必须是有限正整数，实际 ${cap}`)
    assert.ok(Number.isInteger(DNS_PENDING_TIMEOUT_MS) && DNS_PENDING_TIMEOUT_MS === 150,
      `环境变量应把等待上限压到 150ms（测试注入生效的前提），实际 ${DNS_PENDING_TIMEOUT_MS}`)
    const stuck = []
    dns.lookup = (hostname, options, callback) => { stuck.push(callback) } // 坏解析器：永不回调
    const calls500 = []
    const fire = (i) => new Promise(resolve => {
      dnsLookup('pending-cap.invalid', { all: true }, (error, address) => {
        calls500.push({ i, error, address })
        resolve()
      })
    })
    const all500 = []
    for (let i = 0; i < 500; i++) all500.push(fire(i))
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(stuck.length, 1, '同 key 只应发起 1 次底层 lookup（复用等待项的前提不变）')
    const early = calls500.filter(c => c.error)
    assert.strictEqual(early.length, 500 - cap,
      `超出同 key 上限的调用必须**立即**以失败回调（不得堆进表）：期望 ${500 - cap}，实际 ${early.length}`)
    assert.ok(early.every(c => c.error.code === 'EAI_AGAIN'), '超限失败必须带可重试错误码（EAI_AGAIN），不得静默丢弃')
    // deadline：到点后仍在等待的每一项都要收到超时错误（一个回调都不能少）
    await new Promise(resolve => setTimeout(resolve, DNS_PENDING_TIMEOUT_MS + 200))
    await Promise.all(all500)
    assert.strictEqual(calls500.length, 500, '每个调用方都必须收到回调（500 个一个都不能少）')
    assert.ok(calls500.every(c => c.error), '底层不回调时全部按失败收场，绝不当作成功')
    const timeouts = calls500.filter(c => c.error.code === 'ETIMEDOUT')
    assert.strictEqual(timeouts.length, cap, `超时失败应恰好是仍在等待的 ${cap} 项，实际 ${timeouts.length}`)
    // 表已摘除 ⇒ 坏解析器恢复后同一 key 仍可重试（回归：超时后必须能重新发起解析）
    const recovered = []
    dns.lookup = (hostname, options, callback) => {
      recovered.push(callback)
      callback(null, [{ address: '192.0.2.7', family: 4 }], 4)
    }
    const retry = await new Promise(resolve => dnsLookup('pending-cap.invalid', { all: true }, (error, address) => resolve({ error, address })))
    assert.strictEqual(recovered.length, 1, '超时摘除后重试必须重新发起底层 lookup')
    assert.strictEqual(retry.error, null)
    assert.deepStrictEqual(retry.address, [{ address: '192.0.2.7', family: 4 }], 'all:true 的回调形状不得丢')
    // wantAll 形状差异（all:true → 数组 / 缺省 → 标量）在缓存回填路径上同样不得丢
    const scalar = await new Promise(resolve => dnsLookup('pending-cap.invalid', {}, (error, address, family) => resolve({ error, address, family })))
    assert.strictEqual(scalar.error, null)
    assert.strictEqual(scalar.address, '192.0.2.7', 'all 缺省时必须拿标量地址（取列表首项）')
    assert.strictEqual(scalar.family, 4)
    await prewarmDns('pending-cap.invalid')
    dns.lookup = (hostname, options, callback) => { calls += 1; callback(null, '192.0.2.1', 4) }
    console.log('✅ C10-074 dnsPending 有界：超限/超时都按失败回调并摘除，重试可重新解析，wantAll 形状不变')
    // ── PR #362 评审（CodeRabbit Major · Stability & Availability）：超时后仍在飞的底层查询必须有界 ──────
    // 复现（修复前）：deadline 只摘等待项，底层 dns.lookup 仍在飞；同 key 每轮重试都再起一条，坏解析器
    // 永不回调时无界累积（实测 8 轮重试 = 8 条在飞 getaddrinfo，占满 libuv 线程池并拖慢同池文件操作）。
    // 修复后同 key 最多 DNS_INFLIGHT_MAX_PER_KEY 条在飞，其后立即 EAI_AGAIN（可重试、不静默丢）。
    const cycles = 20
    const perCycle = 25
    const multiStuck = []
    dns.lookup = (hostname, options, callback) => { multiStuck.push(callback) } // 坏解析器：永不回调
    const multiCodes = []
    for (let c = 0; c < cycles; c++) {
      const batch = []
      for (let i = 0; i < perCycle; i++) {
        batch.push(new Promise(resolve => dnsLookup('pending-inflight.invalid', { all: true }, (error) => {
          multiCodes.push(error ? error.code : 'none')
          resolve()
        })))
      }
      // 等到本轮所有等待项都过 deadline（= 生产上 got 超时后的下一次重试），再打下一轮
      await new Promise(resolve => setTimeout(resolve, DNS_PENDING_TIMEOUT_MS + 40))
      await Promise.all(batch)
    }
    assert.ok(multiStuck.length < cycles,
      `坏解析器下同 key 连重试 ${cycles} 轮不得每轮都另起一条底层 lookup（旧实现 = 每轮 1 条），实际 ${multiStuck.length}`)
    assert.ok(Number.isInteger(DNS_INFLIGHT_MAX_PER_KEY) && DNS_INFLIGHT_MAX_PER_KEY >= 2 && DNS_INFLIGHT_MAX_PER_KEY <= 8,
      `同 key 在飞上限必须是 ≥2 的有限小整数（取 1 会让超时后连一次接班解析都发不出去），实际 ${DNS_INFLIGHT_MAX_PER_KEY}`)
    assert.strictEqual(multiStuck.length, DNS_INFLIGHT_MAX_PER_KEY,
      `同 key 在飞的底层 lookup 必须收敛到上限 ${DNS_INFLIGHT_MAX_PER_KEY} 条，实际 ${multiStuck.length}`)
    assert.strictEqual(multiCodes.length, cycles * perCycle, `${cycles * perCycle} 个调用方都必须收到回调（一个都不能少）`)
    const multiTimeouts = multiCodes.filter(code => code === 'ETIMEDOUT').length
    const multiRefused = multiCodes.filter(code => code === 'EAI_AGAIN').length
    assert.strictEqual(multiTimeouts, DNS_INFLIGHT_MAX_PER_KEY * perCycle,
      `上限内那 ${DNS_INFLIGHT_MAX_PER_KEY} 轮仍按 deadline 超时（ETIMEDOUT）：期望 ${DNS_INFLIGHT_MAX_PER_KEY * perCycle}，实际 ${multiTimeouts}`)
    assert.strictEqual(multiRefused, (cycles - DNS_INFLIGHT_MAX_PER_KEY) * perCycle,
      `超限轮次必须立即以 EAI_AGAIN 失败（不静默丢、也不新建底层查询）：期望 ${(cycles - DNS_INFLIGHT_MAX_PER_KEY) * perCycle}，实际 ${multiRefused}`)
    console.log(`✅ PR #362 在飞 dns.lookup 有界：同 key 连重试 ${cycles} 轮共 ${cycles * perCycle} 次调用，只发起 ${multiStuck.length} 条底层 lookup，回调一个不少`)
    // 坏解析器恢复：在飞记账随底层回调释放，同 key 能重新解析，结果照常写回缓存
    for (const cb of multiStuck) cb(null, '192.0.2.1', 4) // 释放挂起的在飞回调（记账随之清零）
    let afterRecoverCalls = 0
    dns.lookup = (hostname, options, callback) => {
      afterRecoverCalls += 1
      callback(null, [{ address: '192.0.2.9', family: 4 }], 4)
    }
    const afterRecover = await new Promise(resolve => dnsLookup('pending-inflight.invalid', { all: true }, (error, address) => resolve({ error, address })))
    assert.strictEqual(afterRecover.error, null, '在飞上限解除后同 key 必须能重新解析（不得永久卡死）')
    await new Promise(resolve => dnsLookup('pending-inflight.invalid', { all: true }, (error) => resolve(error)))
    assert.strictEqual(afterRecoverCalls, 1, '恢复后的解析结果应写回缓存并被下一次请求命中')
    console.log('✅ PR #362 恢复路径：在飞回调释放后同 key 可重解析，结果写回缓存')
    // ── 全局在飞上限（XBK_DNS_MAX_INFLIGHT = 文件头注入值）：超限立即 EAI_AGAIN，绝不新建 getaddrinfo ──
    assert.ok(Number.isInteger(DNS_INFLIGHT_MAX) && DNS_INFLIGHT_MAX === 6,
      `环境变量应把全局在飞上限压到 6（测试注入生效的前提），实际 ${DNS_INFLIGHT_MAX}`)
    for (const cb of stuck) cb(null, '192.0.2.1', 4) // 释放前面遗留的挂起回调，把进程内在飞记账清零
    const globalStuck = []
    dns.lookup = (hostname, options, callback) => { globalStuck.push(callback) }
    const heldCodes = []
    const held = []
    for (let i = 0; i < DNS_INFLIGHT_MAX; i++) {
      held.push(new Promise(resolve => dnsLookup(`inflight-global-${i}.invalid`, { all: true }, (error) => {
        heldCodes.push(error ? error.code : 'none')
        resolve()
      })))
    }
    const blockedCode = await new Promise(resolve => dnsLookup('inflight-global-over.invalid', { all: true }, (error) => resolve(error ? error.code : 'none')))
    assert.strictEqual(globalStuck.length, DNS_INFLIGHT_MAX,
      `上限内的 ${DNS_INFLIGHT_MAX} 个不同 key 都应真正发起底层 lookup，实际 ${globalStuck.length}`)
    assert.strictEqual(blockedCode, 'EAI_AGAIN', '超出全局在飞上限必须立即以 EAI_AGAIN 失败（可重试），且不新建底层 lookup')
    await new Promise(resolve => setTimeout(resolve, DNS_PENDING_TIMEOUT_MS + 40))
    await Promise.all(held)
    assert.ok(heldCodes.every(code => code === 'ETIMEDOUT'),
      `上限内的等待项仍按 deadline 收场为 ETIMEDOUT（错误码不得被上限逻辑改写），实际 ${heldCodes.join(',')}`)
    for (const cb of globalStuck) cb(null, '192.0.2.1', 4) // 释放，清零在飞记账
    dns.lookup = (hostname, options, callback) => { calls += 1; callback(null, '192.0.2.1', 4) }
    console.log(`✅ PR #362 全局在飞上限：${DNS_INFLIGHT_MAX} 条在飞后新调用立即 EAI_AGAIN，未新建底层 lookup`)
    // 同步抛错（非法参数等极端路径）不得泄漏在飞名额：否则 2×上限次抛错就把整个进程的解析钉死
    dns.lookup = () => { throw new Error('sync-boom') }
    let thrownSync = 0
    for (let i = 0; i < DNS_INFLIGHT_MAX * 2; i++) {
      try { dnsLookup(`inflight-throw-${i}.invalid`, { all: true }, () => {}) } catch (e) { thrownSync += 1 }
    }
    assert.strictEqual(thrownSync, DNS_INFLIGHT_MAX * 2, '底层同步抛错必须原样上抛（不得被吞掉或改写成回调）')
    dns.lookup = (hostname, options, callback) => { callback(null, [{ address: '192.0.2.33', family: 4 }], 4) }
    const afterThrow = await new Promise(resolve => dnsLookup('inflight-throw-ok.invalid', { all: true }, (error) => resolve(error ? error.code : 'none')))
    assert.strictEqual(afterThrow, 'none', `同步抛错不得泄漏在飞名额（${DNS_INFLIGHT_MAX * 2} 次抛错后仍须能正常解析）`)
    console.log(`✅ PR #362 同步抛错不泄漏在飞名额：${thrownSync} 次抛错后仍能正常解析`)
  } finally {
    dns.lookup = originalLookup
  }
})().catch(error => {
  console.error(error)
  process.exit(1)
})
