'use strict'

const assert = require('assert')
const { createNetwork } = require('./xbk_network')
const { RETRYABLE_CODES } = require('./xbk_failure_policy')

// fetchData 依赖全部注入：Config / Utils / fetchJson / prewarmDns / getNotify / crypto / RETRYABLE_CODES
function makeNetwork (opts = {}) {
  const { retry = 2, timeout = 5000, statusCode = 500, failTimes = 0, errorCode, permanentCodes } = opts
  let calls = 0
  const requestOptions = [] // net-3：捕获传给 HTTP 层的 option，供 timeout 钳制断言使用
  const fetchJson = async (_url, requestOpts) => {
    calls += 1
    requestOptions.push(requestOpts)
    if (calls <= failTimes) {
      const e = new Error('fail ' + calls)
      if (errorCode !== undefined) e.code = errorCode // net-1：无 response 的永久性错误码
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
    RETRYABLE_CODES,
    ...(permanentCodes === undefined ? {} : { PERMANENT_CODES: permanentCodes })
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

  // 12. net-1（xbk_network.js:83-87）：不可重试判定不再只看 HTTP 状态码——无 response 的永久性错误码
  // （PERMANENT_CODES 里的 ERR_BODY_NOT_JSON / CERT_HAS_EXPIRED / ERR_INVALID_URL 等 + 请求层单列的
  // 确定性失败码 EBODYLIMIT）必须立即抛出、不得退避重试满 maxRetry；旧实现对这些错误一律重试
  // （retry=2 → 3 次尝试 + 1s/2s 退避）。本块**不传** PERMANENT_CODES：缺省由 xbk_network 回落到
  // xbk_failure_policy 的同一导出（组合根尚未接线），故回退该改动即 calls=3、本块变红。
  for (const code of ['ERR_BODY_NOT_JSON', 'CERT_HAS_EXPIRED', 'ERR_INVALID_URL', 'EBODYLIMIT']) {
    const { net, getCalls } = makeNetwork({ retry: 2, statusCode: undefined, errorCode: code, failTimes: 5 })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.ok(rejected, `${code} 应立即抛出`)
    assert.strictEqual(rejected.code, code, `应抛出原错误（保留 code），实际 ${rejected.code}`)
    assert.strictEqual(getCalls(), 1, `${code} 属不可重试错误，不得重试（旧实现会重试到 maxRetry）`)
  }

  // 12b. 反向守卫：不在 PERMANENT_CODES / 本地确定性集合里的未知错误码仍按旧口径重试
  // （防止「凡带 code 就不重试」式一刀切把瞬时错误的挽回机会一起砍掉）
  {
    const { net, getCalls } = makeNetwork({ retry: 2, statusCode: undefined, errorCode: 'ERR_UNKNOWN_XYZ', failTimes: 5 })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.strictEqual(rejected.code, 'ERR_UNKNOWN_XYZ', '应抛出最后一次的 lastErr')
    assert.strictEqual(getCalls(), 3, '未知错误码应保持重试语义（首次 + 2 次重试）')
  }

  // 12c. PERMANENT_CODES 注入优先：显式注入的自定义集合以注入值为准（组合根日后接线该参数的接口已生效）
  {
    const { net, getCalls } = makeNetwork({
      retry: 2,
      statusCode: undefined,
      errorCode: 'MY_PERMANENT',
      failTimes: 5,
      permanentCodes: new Set(['MY_PERMANENT'])
    })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.strictEqual(rejected.code, 'MY_PERMANENT', '应抛出注入集合里的错误')
    assert.strictEqual(getCalls(), 1, '显式注入的 PERMANENT_CODES 必须生效')
  }

  console.log('test_network OK')
})().catch((e) => { console.error(e); process.exit(1) })
