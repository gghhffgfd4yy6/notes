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
  // AGENTS-08：证书主机名不匹配与「缓存里的 IP 已失效」无关（xbk_failure_policy 已按 PERMANENT 归类），
  // 不得当 DNS 失效码——否则每次重试都白清一次缓存并重新解析，而问题依旧。此处必为 false（旧口径 true）。
  assert.strictEqual(shouldInvalidateDns({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), false, '证书主机名不匹配不应失效 DNS（AGENTS-08）')
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

  // AGENTS-08 行为断言：证书主机名不匹配不得清 DNS 缓存（旧口径会把缓存清掉、重试白解析一次）
  {
    const certHost = 'cert-invalidate-probe.invalid'
    let certLookups = 0
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      certLookups += 1
      process.nextTick(() => cb(null, '192.0.2.11', 4))
    }
    await new Promise((resolve, reject) => dnsLookup(certHost, {}, (e) => e ? reject(e) : resolve()))
    assert.strictEqual(certLookups, 1, '首次解析应走底层')
    assert.strictEqual(
      invalidateDnsForError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, `https://${certHost}/api`),
      false,
      '证书错误不应触发 DNS 失效（AGENTS-08）'
    )
    await new Promise((resolve, reject) => dnsLookup(certHost, {}, (e) => e ? reject(e) : resolve()))
    assert.strictEqual(certLookups, 1, '证书错误后缓存应仍然有效（旧口径此处为 2）')
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      process.nextTick(() => cb(null, '127.0.0.1', 4))
    }
    console.log('✅ AGENTS-08：证书主机名不匹配不再清 DNS 缓存')
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
  // AGENTS-07：DNS 预热结果带 kind:'dns'，与 prewarmTls 的 kind:'tls' 对称（两者都带 hostname，
  // 此前调用方无法按字段区分）——去掉该字段本断言即红。
  assert.strictEqual(prewarmResult.kind, 'dns', 'DNS 预热结果应带 kind=dns（AGENTS-07）')
  assert.ok(typeof prewarmResult.ok === 'boolean', 'ok 应为布尔值')
  assert.ok(typeof prewarmResult.elapsedMs === 'number', 'elapsedMs 应为数字')

  // 场景 2：已 aborted signal → 立即返回 cancelled
  const ac = new AbortController()
  ac.abort()
  const abortedResult = await prewarmDns('localhost', ac.signal)
  assert.strictEqual(abortedResult.ok, false, 'aborted 时 ok 应为 false')
  assert.ok(abortedResult.error?.includes('abort') || abortedResult.cancelled === true, 'aborted 时应包含取消信息')

  // ===== AGENTS-01 + AGENTS-11：prewarmDns 必须与真实请求的 lookup 同 key（默认 DNS 模式预热才有效），
  // 但同 key 的口径是「同选项」，不是「同主机」 =====
  // 真实 net.connect 实测（本机 Node v24.18.0）以 {hints: dns.ADDRCONFIG}（autoSelectFamily 默认
  // 开启时另加 all:true）调用本 lookup；prewarmDns 必须同源取值才能同 key——旧实现预热传 {}，
  // 与真实请求 hints 不同，预热写进一个永不被读的条目，DNS 预热完全无效（本断言在那种代码下必红：
  // 底层次数为 2 而非 1）。
  // AGENTS-11 追加口径：缓存键还必须区分**结果选择选项**（family/hints/verbatim/order）——旧键
  // hostname|family 让选项不同的调用方互相复用地址，其中一个必然拿到按别人选项筛选/排序过的结果。
  // 因此下面「非 all 调用方共享条目」的断言改用**与预热同选项**的调用方（形状适配语义不变），
  // 另加断言：选项不同的调用方必须重新解析、拿到自己的结果（不是放松，而是把旧断言指向正确的目标）。
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
    // 预热必须与生产请求同源取值：hints 必须等于 net 实测传的 ADDRCONFIG（family 未指定时）
    assert.strictEqual(keyCalls[0].options.hints, dns.ADDRCONFIG, '预热应按生产请求选项取 hints=ADDRCONFIG')
    // 真实请求形态：net 传 hints=ADDRCONFIG + all=true → 必须命中预热写入的缓存条目。
    // ⚠️ hints 必须与实现（xbk_agents 的 PRODUCTION_LOOKUP_HINTS）同源取 dns.ADDRCONFIG，不得把本机
    // 观测到的 1024 写死：该常量是**平台相关**取值（本机 Linux 为 1024，个别平台可为 0）。写死会在
    // 常量≠1024 的平台上构造出与预热不同的 key，把「同选项必须命中」这条断言变成平台专属假红
    // （CI 实测：本机绿、CI 红，底层解析次数 2 而非 1）。
    const allHit = await new Promise((resolve, reject) => {
      dnsLookup(keyProbeHost, { hints: dns.ADDRCONFIG, all: true }, (err, address, family) => err ? reject(err) : resolve({ address, family }))
    })
    assert.strictEqual(keyCalls.length, 1, `预热后真实请求形态的 lookup 应命中同一缓存（不同 key 时为 2），实际 ${keyCalls.length}`)
    assert.ok(Array.isArray(allHit.address) && allHit.address[0] && allHit.address[0].address === '192.0.2.7', 'all:true 调用方应拿到地址数组')
    // 同一缓存条目服务非 all 调用方：形状适配为标量（调用方选项与预热同源，故仍共享条目）
    const scalarHit = await new Promise((resolve, reject) => {
      dnsLookup(keyProbeHost, { hints: dns.ADDRCONFIG }, (err, address, family) => err ? reject(err) : resolve({ address, family }))
    })
    assert.strictEqual(keyCalls.length, 1, '同选项的非 all 调用方也应命中同一缓存条目，不应再发起解析')
    assert.strictEqual(scalarHit.address, '192.0.2.7', '非 all 调用方应拿到标量地址')
    assert.strictEqual(scalarHit.family, 4, '非 all 调用方应拿到地址族')
    // 选项不同的调用方（未指定 hints）语义不同，不得复用上面按 ADDRCONFIG 筛过的条目：必须自己解析。
    // ⚠️ 前提是 dns.ADDRCONFIG !== 0（同样是平台相关常量）：若该常量为 0，预热选项 hints 与未指定的 {}
    // 在 xbk_agents 的 dnsSelectionSignature 里归一后同为 0（`opts.hints || 0`）——两者**就是同一个 key**，
    // 「选项不同 ⇒ 必须重新解析」在数学上不可构造。这种平台上必须显式跳过并说明，不能留成恒假断言
    // （也不改成恒真：跳过路径不产生任何通过记录）。非 0 平台照旧逐条断言，强度不变。
    if (dns.ADDRCONFIG === 0) {
      console.log('⏭ 跳过 AGENTS-11「不同 hints 必须重新解析」：本平台 dns.ADDRCONFIG === 0，{} 与预热选项同 key（差异不可构造）')
    } else {
      const plainHit = await new Promise((resolve, reject) => {
        dnsLookup(keyProbeHost, {}, (err, address, family) => err ? reject(err) : resolve({ address, family }))
      })
      assert.strictEqual(keyCalls.length, 2, 'hints:0 与预热的 hints:ADDRCONFIG 选项不同 → 必须重新解析（AGENTS-11）')
      assert.ok(!keyCalls[1].options.hints, '重新解析必须把调用方自己的 hints（此处未指定）交给底层')
      assert.strictEqual(plainHit.address, '192.0.2.7', 'hints:0 调用方应拿到自己那次解析的结果')
    }
    // 恢复文件头的确定性 mock（保持后续断言的既定语义）
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      process.nextTick(() => cb(null, '127.0.0.1', 4))
    }
    console.log('✅ AGENTS-01/11：预热与真实请求同 key；选项不同（hints）不再互相复用条目')
  }

  // ===== AGENTS-11：缓存键覆盖 family/hints/verbatim/order（不同选项不得复用不匹配的地址）=====
  // 替身按 Node dns.lookup 语义建模：family 过滤 → hints&ADDRCONFIG 过滤（本机默认网络无 IPv6，
  // 平台 AI_ADDRCONFIG 会剔除 AAAA）→ order/verbatim 排序；解析器原始顺序固定 [v6, v4]。
  // 这条同时守住两个不变量：① 任何调用方拿到的地址必须按**自己**的选项筛选/排序；
  // ② 预热（生产选项）与真实请求形态仍共享条目、不重复解析。
  {
    const host = 'select-probe.invalid'
    const calls = []
    const resolverOrder = [{ address: '2001:db8::1', family: 6 }, { address: '192.0.2.7', family: 4 }]
    dns.lookup = (hostname, options, callback) => {
      const opts = options || {}
      calls.push({ hostname, options: opts })
      let list = resolverOrder.slice()
      if (opts.family === 4) list = list.filter(x => x.family === 4)
      else if (opts.family === 6) list = list.filter(x => x.family === 6)
      if (opts.hints & dns.ADDRCONFIG) list = list.filter(x => x.family === 4)
      const order = opts.order || (opts.verbatim === false ? 'ipv4first' : opts.verbatim === true ? 'verbatim' : 'verbatim')
      if (order === 'ipv4first') list = list.slice().sort((a, b) => a.family - b.family)
      if (order === 'ipv6first') list = list.slice().sort((a, b) => b.family - a.family)
      process.nextTick(() => callback(null, opts.all === false ? list[0] : list, undefined))
    }
    const lookup = (options) => new Promise((resolve, reject) => {
      dnsLookup(host, options, (err, address) => err ? reject(err) : resolve(address))
    })
    const families = (list) => list.map(x => x.family).join(',')
    // 平台相关取值（与上面 hints 同源问题的延伸）：dns.ADDRCONFIG 是宿主机 libc 的 AI_ADDRCONFIG
    // （本机 Android/bionic = 1024；CI 红反推 CI 平台 ≠ 1024；个别平台可为 0）。本块的替身按
    // 「该掩码置位 → 剔除本机未配置族的 AAAA」建模，故**掩码为 0 的平台**上生产请求形态
    // （hints=ADDRCONFIG=0）根本不会被剔除，正确期望就是完整地址集 '6,4'。这里用同一个常量推导
    // 期望值，而不是把本机观测到的 '4' 写死成平台专属；非 0 平台上取值仍为 '4'，与本块原有断言逐字一致。
    const addrconfigView = dns.ADDRCONFIG === 0 ? '6,4' : '4'
    const warm = await prewarmDns(host)
    assert.strictEqual(warm.ok, true, '预热应成功')
    assert.strictEqual(calls.length, 1, '预热应发起 1 次底层解析')
    // ① 生产请求形态（hints=ADDRCONFIG, all:true）命中预热条目，且按本平台掩码拿到地址集
    const acHit = await lookup({ hints: dns.ADDRCONFIG, all: true })
    assert.strictEqual(calls.length, 1, '生产请求形态应命中预热条目（预热仍有效）')
    assert.strictEqual(families(acHit), addrconfigView, '生产请求形态应按本平台 ADDRCONFIG 掩码筛选（掩码非 0 时不得含本机未配置族的 AAAA）')
    // ② 同一 hostname、选项不同 → 各自的条目与结果（TTL 内多次不同选项请求）。
    // ⚠️ 平台相关：dns.ADDRCONFIG 为 0 时预热选项 hints 归一后就是 0，与 `{hints:0}` **同 key**，
    // 「选项不同 ⇒ 重新解析」的前提消失（会变成恒假断言）。此处不用跳过、也不用恒真断言，而是改用
    // 必然与预热不同的 hints（1 是有限数值、仍在实现建模范围内，见 dnsSelectionSignature）：该断言
    // 仍可证伪——若实现忽略 hints 导致不同 hints 复用同一条目，calls 会停在 1 而红。非 0 平台上
    // otherHints 恒为 0，与改前逐字一致。
    const otherHints = dns.ADDRCONFIG === 0 ? 1 : 0
    const plain = await lookup({ hints: otherHints, all: true })
    assert.strictEqual(calls.length, 2, `hints:${otherHints} 与预热的 hints:${dns.ADDRCONFIG} 不同 → 应重新解析`)
    assert.strictEqual(families(plain), '6,4', 'hints 不同的调用方应拿到完整地址集（不得复用 ADDRCONFIG 视图）')
    // ③ 排序选项 verbatim:false（hints 0）→ 必须由解析器按 ipv4first 重新给出顺序
    const vf = await lookup({ hints: 0, verbatim: false, all: true })
    assert.strictEqual(calls.length, 3, 'verbatim:false 与 verbatim:true 顺序语义不同 → 应重新解析')
    assert.strictEqual(vf[0].family, 4, 'verbatim:false 必须得到 IPv4 在前')
    // ④ order 与 verbatim 归一：{order:'ipv4first'} 与 {verbatim:false} 语义相同 → 共享条目
    const of = await lookup({ hints: 0, order: 'ipv4first', all: true })
    assert.strictEqual(calls.length, 3, '{order:ipv4first} 与 {verbatim:false} 语义相同 → 应共享条目，不应再解析')
    assert.strictEqual(families(of), families(vf), '归一后的两种写法应得到相同结果')
    // ⑤ 非 all 调用方在同选项下共享条目（all 只决定回调形状）
    const scalar = await lookup({ hints: 0, verbatim: false })
    assert.strictEqual(calls.length, 3, '同选项的非 all 调用方应共享条目（形状适配）')
    assert.strictEqual(scalar, '192.0.2.7', '非 all 调用方应拿到标量首地址')
    // ⑥ family 4/6 各自条目
    const v6 = await lookup({ family: 6, all: true })
    const v4 = await lookup({ family: 4, all: true })
    assert.strictEqual(calls.length, 5, 'family 4/6 语义不同 → 各自解析')
    assert.strictEqual(families(v6), '6', 'family:6 只应拿到 AAAA')
    assert.strictEqual(families(v4), '4', 'family:4 只应拿到 A')
    // ⑦ 未建模的选项（未知键）→ 不读也不写缓存，按调用方原选项解析，且不污染同主机其它条目
    const exotic = await lookup({ hints: dns.ADDRCONFIG, v6Only: true, all: true })
    assert.strictEqual(calls.length, 6, '未知选项不得复用缓存条目，应直接解析')
    assert.strictEqual(calls[5].options.v6Only, true, '未知选项应原样交给底层解析器')
    assert.ok(Array.isArray(exotic), '未知选项调用方仍应按 all 形状拿到结果')
    const acAgain = await lookup({ hints: dns.ADDRCONFIG, all: true })
    assert.strictEqual(calls.length, 6, '未知选项的解析不得写回预热条目（不污染同主机其它选项的缓存）')
    assert.strictEqual(families(acAgain), addrconfigView, '预热条目内容不应被未知选项调用改写（期望值与本平台 ADDRCONFIG 掩码一致）')
    // ⑦b 非法取值（family/hints/verbatim/order 的类型或取值超出建模范围）同样不进缓存 → 每次直接解析
    for (const opts of [{ family: 5, all: true }, { family: 'IPv4', all: true }, { hints: '1024', all: true }, { hints: Number.NaN, all: true }, { hints: Infinity, all: true }, { verbatim: 'yes', all: true }, { order: 'ipv6only', all: true }]) {
      const before = calls.length
      await lookup(opts)
      assert.strictEqual(calls.length, before + 1, `非法取值 ${JSON.stringify(opts)} 应直接解析`)
    }
    const notModeledBefore = calls.length
    await lookup({ family: 5, all: true })
    assert.strictEqual(calls.length, notModeledBefore + 1, '未建模选项的调用不得写缓存（同形状再查仍解析）')
    // ⑧ 并发去重按选项分组：同选项合并 1 次解析，不同选项各自解析
    // （第三个调用方的 hints 用 otherHints：ADDRCONFIG 为 0 的平台上传 0 会与前两个**同 key**并合并，
    //   那样「不同选项各自解析」的前提就不成立；非 0 平台上 otherHints 恒为 0，与原断言逐字一致。）
    const hangHost = 'select-pending.invalid'
    const hanging = []
    dns.lookup = (hostname, options, callback) => { hanging.push({ options, callback }) }
    const p1 = new Promise((resolve, reject) => dnsLookup(hangHost, { hints: dns.ADDRCONFIG, all: true }, (e, a) => e ? reject(e) : resolve(a)))
    const p2 = new Promise((resolve, reject) => dnsLookup(hangHost, { hints: dns.ADDRCONFIG, all: true }, (e, a) => e ? reject(e) : resolve(a)))
    const p3 = new Promise((resolve, reject) => dnsLookup(hangHost, { hints: otherHints, all: true }, (e, a) => e ? reject(e) : resolve(a)))
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(hanging.length, 2, '并发去重应按选项分组：同选项合并、不同选项各自解析')
    hanging[0].callback(null, [{ address: '192.0.2.7', family: 4 }], undefined)
    hanging[1].callback(null, resolverOrder.slice(), undefined)
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    assert.strictEqual(families(r1), '4', '同选项并发调用方应共享同一次解析结果')
    assert.strictEqual(families(r2), '4', '同选项并发调用方应共享同一次解析结果')
    assert.strictEqual(families(r3), '6,4', '不同选项的并发调用方应拿到自己那次解析的结果')
    // 恢复文件头的确定性 mock（保持后续断言的既定语义）
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      process.nextTick(() => cb(null, '127.0.0.1', 4))
    }
    console.log('✅ AGENTS-11：缓存键含 family/hints/verbatim(order)——不同选项不复用不匹配地址，同选项仍共享条目')
  }

  // ===== module.exports：不再导出死值 DNS_CACHE（AGENTS-08）=====
  // 旧导出含 `DNS_CACHE: null`（无任何读取方）；若回退该行，`in` 判定为 true 即红。
  const agentsExports = require('./xbk_agents')
  assert.ok(!('DNS_CACHE' in agentsExports), 'module.exports 不应再包含 DNS_CACHE')

  console.log('test_agents OK')
})().catch((e) => { console.error(e); process.exit(1) })
