'use strict'

const assert = require('assert')
const { createNetwork } = require('./xbk_network')
const { RETRYABLE_CODES } = require('./xbk_failure_policy')

// fetchData 依赖全部注入：Config / Utils / fetchJson / prewarmDns / getNotify / crypto / RETRYABLE_CODES
function makeNetwork (opts = {}) {
  const { retry = 2, timeout = 5000, statusCode = 500, failTimes = 0 } = opts
  let calls = 0
  const requestOptions = [] // net-3：捕获传给 HTTP 层的 option，供 timeout 钳制断言使用
  const fetchJson = async (_url, requestOpts) => {
    calls += 1
    requestOptions.push(requestOpts)
    if (calls <= failTimes) {
      const e = new Error('fail ' + calls)
      if (statusCode !== undefined) e.response = { statusCode }
      throw e
    }
    return { ok: true, calls }
  }
  const net = createNetwork({
    Config: { api: { pushUrl: 'https://api.example.com/push', retry, timeout } },
    Utils: {
      num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d },
      safeErrorText: (e, d) => (e && e.message) || d
    },
    fetchJson,
    prewarmDns: async () => ({ ok: true, elapsedMs: 1, family: 'ipv4' }),
    getNotify: async () => 'notify-module',
    crypto: { randomInt: () => 0 }, // 抖动固定为 0，退避仅由 1000*2^attempt 决定
    RETRYABLE_CODES
  })
  return { net, getCalls: () => calls, getRequestOptions: () => requestOptions }
}

;(async () => {
  // 1. 成功路径：直接返回 fetchJson 结果（retry 默认 2，但无需重试）
  {
    const { net, getCalls } = makeNetwork({})
    const r = await net.fetchData()
    assert.strictEqual(r.ok, true, '应返回 fetchJson 结果')
    assert.strictEqual(getCalls(), 1, '成功时只调用 1 次')
  }

  // 2. [探针] 4xx 非可重试（400）→ 立即抛，不重试（retry=2 也不重试）
  {
    const { net, getCalls } = makeNetwork({ retry: 2, statusCode: 400, failTimes: 5 })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.ok(rejected, '400 应直接抛出')
    assert.strictEqual(getCalls(), 1, '400 客户端错误不得重试')
  }

  // 3. 4xx 可重试（429）→ 第二次成功
  {
    const { net, getCalls } = makeNetwork({ retry: 1, statusCode: 429, failTimes: 1 })
    const r = await net.fetchData()
    assert.strictEqual(r.calls, 2, '429 应重试后成功')
    assert.strictEqual(getCalls(), 2)
  }

  // 4. 5xx（503）→ 退避后重试成功
  {
    const { net, getCalls } = makeNetwork({ retry: 1, statusCode: 503, failTimes: 1 })
    const r = await net.fetchData()
    assert.strictEqual(r.calls, 2, '5xx 应重试后成功')
    assert.strictEqual(getCalls(), 2)
  }

  // 5. retry 非法值兜底：Infinity → 2（共 3 次尝试），前 2 次失败第 3 次成功
  {
    const { net } = makeNetwork({ retry: Infinity, statusCode: 500, failTimes: 2 })
    const r = await net.fetchData()
    assert.strictEqual(r.calls, 3, 'Infinity 应兜底为 2 次重试（共 3 次尝试）')
  }

  // 6. retry 为字符串 '5' → Utils.num 转 5，第 5 次才成功
  {
    const { net } = makeNetwork({ retry: '5', statusCode: 502, failTimes: 5 })
    const r = await net.fetchData()
    assert.strictEqual(r.calls, 6, "字符串 '5' 应经 Utils.num 转换为 5 次重试")
  }

  // 7. 重试耗尽 → 抛 lastErr（最后一次错误）
  {
    const { net } = makeNetwork({ retry: 1, statusCode: 503, failTimes: 9 })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.ok(rejected, '耗尽后应抛错')
    assert.ok(/fail/.test(rejected.message), '应抛最后一次的 lastErr')
  }

  // 8. PROFILE3 + prewarmDns reject → 走 .catch 日志分支（行38-39），不影响主流程
  {
    const logs = []
    const net = createNetwork({
      Config: { api: { pushUrl: 'https://api.example.com/push', retry: 0, timeout: 5000 } },
      Utils: {
        num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d },
        safeErrorText: (e, d) => (e && e.message) || d
      },
      fetchJson: async () => ({ ok: true }),
      prewarmDns: async () => { throw new Error('dns-fail') },
      getNotify: async () => 'notify',
      crypto: { randomInt: () => 0 },
      RETRYABLE_CODES,
      PROFILE3: true,
      logger: { log: (...args) => logs.push(args.join(' ')) }
    })
    const r = await net.fetchData()
    assert.strictEqual(r.ok, true, 'prewarmDns 失败不应影响主流程')
    assert.ok(logs.some(l => l.includes('dns-prewarm') && l.includes('ok=false')), 'PROFILE3 应输出 prewarm 失败日志')
  }

  // 9. PROFILE3 + 无效 pushUrl → new URL 抛错走 catch 日志分支（行43-44），不影响主流程
  {
    const logs = []
    const net = createNetwork({
      Config: { api: { pushUrl: 'not-a-valid-url', retry: 0, timeout: 5000 } },
      Utils: {
        num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d },
        safeErrorText: (e, d) => (e && e.message) || d
      },
      fetchJson: async () => ({ ok: true }),
      prewarmDns: async () => ({ ok: true }),
      getNotify: async () => 'notify',
      crypto: { randomInt: () => 0 },
      RETRYABLE_CODES,
      PROFILE3: true,
      logger: { log: (...args) => logs.push(args.join(' ')) }
    })
    const r = await net.fetchData()
    assert.strictEqual(r.ok, true, 'URL 解析失败不应影响主流程')
    assert.ok(logs.some(l => l.includes('dns-prewarm') && l.includes('skipped')), 'PROFILE3 应输出 skipped 日志')
  }

  // 10. net-3（xbk_network.js:63）：timeout 钳到 [1, 2147483647] 的整数
  // 旧实现 `n > 0 ? n : 5000` 会把 0.5 原样传出、1e12 原样传出——got 交给定时器后
  // 被 Node 归一到约 1ms（每次请求瞬间超时）。回退该改动则本块前两行即红。
  {
    const cases = [
      [1, 1, '合法整数 1 不变'],
      [0.5, 1, '0.5 向上取整为 1（曾原样传出 0.5）'],
      [0.9, 1, '0.9 向上取整为 1（曾原样传出 0.9）'],
      [1.2, 2, '1.2 向上取整为 2（曾原样传出 1.2）'],
      [30000, 30000, '常规值不被钳制'],
      [2147483646, 2147483646, '上界内最大值不变'],
      [2147483647, 2147483647, '上界本身保持不变'],
      [2147483647.5, 2147483647, '超上界小数取整后钳回 2147483647'],
      [1e12, 2147483647, '1e12 钳到 2^31-1（曾原样传出 1e12）']
    ]
    for (const [input, expected, msg] of cases) {
      const { net, getRequestOptions } = makeNetwork({ retry: 0, timeout: input })
      await net.fetchData()
      const passed = getRequestOptions()[0].timeout
      assert.strictEqual(passed, expected, `timeout=${input} 应传出 ${expected}：${msg}`)
      assert.ok(Number.isInteger(passed), `timeout=${input} 传出的必须是整数（小数会被 Node 归一到约 1ms）`)
    }
  }

  // 11. net-3（xbk_network.js:62）：非正 / NaN / 非数字 timeout → 回落默认 5000
  // 注意 `!(n > 0)` 守卫：若改成无条件 Math.max(1, …)，-5/0 会传出 1 而非 5000 → 本块红。
  {
    const cases = [[-5, '负数'], [0, '零'], [Number.NaN, 'NaN'], ['abc', '非数字字符串'], ['', '空字符串']]
    for (const [input, label] of cases) {
      const { net, getRequestOptions } = makeNetwork({ retry: 0, timeout: input })
      await net.fetchData()
      assert.strictEqual(getRequestOptions()[0].timeout, 5000, `timeout=${label} 应回落 5000（不得原样传出或钳成 1）`)
    }
  }

  console.log('test_network OK')
})().catch((e) => { console.error(e); process.exit(1) })
