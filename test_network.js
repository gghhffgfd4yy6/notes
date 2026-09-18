'use strict'

const assert = require('assert')
const { createNetwork, parseRetryAfterMs } = require('./xbk_network')
const { RETRYABLE_CODES } = require('./xbk_failure_policy')

// fetchData 依赖全部注入：Config / Utils / fetchJson / prewarmDns / getNotify / crypto / RETRYABLE_CODES
function makeNetwork (opts = {}) {
  const { retry = 2, timeout = 5000, statusCode = 500, failTimes = 0, errorCode, permanentCodes, responseHeaders } = opts
  let calls = 0
  const requestOptions = [] // net-3：捕获传给 HTTP 层的 option，供 timeout 钳制断言使用
  const warnings = [] // net-3：捕获 logger.warn（配置非法时必须告警留痕）
  const logs = [] // net-7：捕获退避日志（断言等待时长/是否按 Retry-After）
  const fetchJson = async (_url, requestOpts) => {
    calls += 1
    requestOptions.push(requestOpts)
    if (calls <= failTimes) {
      const e = new Error('fail ' + calls)
      if (errorCode !== undefined) e.code = errorCode // net-1：无 response 的永久性错误码
      if (statusCode !== undefined) e.response = { statusCode, headers: responseHeaders } // net-7：Retry-After 载体
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
    ...(permanentCodes === undefined ? {} : { PERMANENT_CODES: permanentCodes }),
    logger: { log: (...args) => logs.push(args.join(' ')), warn: (msg) => warnings.push(String(msg)) }
  })
  return {
    net,
    getCalls: () => calls,
    getRequestOptions: () => requestOptions,
    getWarnings: () => warnings,
    getLogs: () => logs
  }
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

  // 10. net-3（xbk_network.js resolveTimeoutMs）：只有「≥100ms 的整数」被采用，其余回落默认并告警
  // 上一轮实现 `n > 0 ? ceil(clamp(n)) : 5000` 仍放过小数与单位误填的小值：0.5 → 1ms、5 → 5ms
  // （用户想写 5 秒），现象是「请求超时」而不是「配置有问题」。回退本次改动 → 下面每条 case 立即变红。
  {
    const cases = [
      [30000, 30000, false, '常规值不被钳制'],
      [100, 100, false, '下界本身（100ms）被采用'],
      [99, 5000, true, '亚 100ms 判非法 → 回落默认（旧实现传出 99ms）'],
      [5, 5000, true, '单位误填（想写 5 秒）→ 回落默认（旧实现传出 5ms 即超时）'],
      [1, 5000, true, '1 同样按非法处理（旧实现传出 1ms）'],
      [0.5, 5000, true, '小数不取整、判非法 → 回落默认（旧实现传出 1ms）'],
      [1.2, 5000, true, '小数不取整（旧实现传出 2ms）'],
      [2147483647, 2147483647, false, '上界本身保持'],
      [2147483648, 2147483647, false, '超上界的整数钳到 2^31-1'],
      [1e12, 2147483647, false, '1e12 是整数 → 钳到 2^31-1（旧实现原样传出，被 Node 归一到约 1ms）'],
      [2147483647.5, 5000, true, '超上界的小数仍是非整数 → 回落默认（不猜用户意图）']
    ]
    for (const [input, expected, expectWarn, msg] of cases) {
      const { net, getRequestOptions, getWarnings } = makeNetwork({ retry: 0, timeout: input })
      await net.fetchData()
      const passed = getRequestOptions()[0].timeout
      assert.strictEqual(passed, expected, `timeout=${input} 应传出 ${expected}：${msg}`)
      assert.ok(Number.isInteger(passed), `timeout=${input} 传出的必须是整数（小数会被 Node 归一到约 1ms）`)
      const warned = getWarnings().some(w => w.includes('api.timeout') && w.includes('已回落默认'))
      assert.strictEqual(warned, expectWarn,
        `timeout=${input} ${expectWarn ? '回落时必须告警留痕' : '合法值不得告警'}，实际告警=${JSON.stringify(getWarnings())}`)
    }
  }

  // 10b. net-3 残留（V4 提示）：整数但越上界此前是**静默钳制**——配置写了不可能生效的值，日志与告警
  // 都看不出来。本块锁定「钳制值语义不变 + 补告警留痕」，并要求文案与「已回落默认」区分（不混用）。
  {
    const overBound = [2147483648, 1e12]
    const legal = [2147483647, 30000, 100]
    for (const input of overBound) {
      const { net, getRequestOptions, getWarnings } = makeNetwork({ retry: 0, timeout: input })
      await net.fetchData()
      assert.strictEqual(getRequestOptions()[0].timeout, 2147483647, `timeout=${input} 仍应钳到 2^31-1（值语义零变更）`)
      const warns = getWarnings()
      assert.ok(warns.some(w => w.includes('api.timeout') && w.includes('超过上界') && w.includes('已钳制到')),
        `timeout=${input} 越上界必须告警留痕（旧实现在此静默），实际告警=${JSON.stringify(warns)}`)
      assert.ok(!warns.some(w => w.includes('已回落默认')),
        `timeout=${input} 是钳制不是回落，文案不得混用「已回落默认」，实际告警=${JSON.stringify(warns)}`)
    }
    // 反向：上界本身与常规值合法 → 不得告警（防止把钳制告警挂到所有整数上）
    for (const input of legal) {
      const { net, getWarnings } = makeNetwork({ retry: 0, timeout: input })
      await net.fetchData()
      assert.strictEqual(getWarnings().length, 0, `timeout=${input} 合法（≤上界）不得告警，实际 ${JSON.stringify(getWarnings())}`)
    }
  }

  // 11. net-3：非正 / 空串 → 回落默认 5000 并告警（非数值经 Utils.num 已回落默认，与合法默认值不可区分，
  // 保持原语义不告警——这是口径的一部分，不再假装它们被「检出」）。
  {
    const cases = [[-5, '负数', true], [0, '零', true], ['', '空字符串', true],
      [Number.NaN, 'NaN', false], ['abc', '非数字字符串', false]]
    for (const [input, label, expectWarn] of cases) {
      const { net, getRequestOptions, getWarnings } = makeNetwork({ retry: 0, timeout: input })
      await net.fetchData()
      assert.strictEqual(getRequestOptions()[0].timeout, 5000, `timeout=${label} 应回落 5000（不得原样传出或钳成 1）`)
      assert.strictEqual(getWarnings().some(w => w.includes('api.timeout')), expectWarn,
        `timeout=${label} 的告警口径不符，实际告警=${JSON.stringify(getWarnings())}`)
    }
  }

  // 11b. net-3：注入的 logger 没有 warn（旧调用方形状）时不得抛错，回落语义不变
  {
    const requestOptions = []
    const net = createNetwork({
      Config: { api: { pushUrl: 'https://api.example.com/push', retry: 0, timeout: 5 } },
      Utils: {
        num: (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d },
        safeErrorText: (e, d) => (e && e.message) || d
      },
      fetchJson: async (_url, requestOpts) => { requestOptions.push(requestOpts); return { ok: true } },
      prewarmDns: async () => ({ ok: true }),
      getNotify: async () => 'notify',
      crypto: { randomInt: () => 0 },
      RETRYABLE_CODES,
      logger: { log: () => {} } // 无 warn：不得因告警而抛 TypeError
    })
    await net.fetchData()
    assert.strictEqual(requestOptions[0].timeout, 5000, '无 warn 的 logger 仍应回落默认')
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

  // 12d. XHTTP-05 反向守卫：空体码 ERR_EMPTY_BODY 已显式列入 RETRYABLE_CODES → 请求层必须按可重试处理；
  // 旧口径（空体与「非 JSON」同为 ERR_BODY_NOT_JSON，属 PERMANENT）下该形态 calls=1 即永久停推，本块红。
  {
    const { net, getCalls } = makeNetwork({ retry: 2, statusCode: undefined, errorCode: 'ERR_EMPTY_BODY', failTimes: 5 })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.strictEqual(rejected.code, 'ERR_EMPTY_BODY', '应抛出最后一次的 lastErr')
    assert.strictEqual(getCalls(), 3, '空体必须按可重试处理（首次 + 2 次重试），不得首次即永久停推')
  }

  // 12e. XHTTP-06：终态 3xx（HTTP_304）是确定性重定向，请求层必须首次即抛、不得退避重试。
  // 反向可证伪：若日后把 HTTP_3xx 放进 RETRYABLE_CODES（或去掉 `sc < 500` 的立即抛判定），本块 calls 变 3 → 红。
  {
    const { net, getCalls } = makeNetwork({ retry: 2, statusCode: 304, errorCode: 'HTTP_304', failTimes: 5 })
    let rejected = null
    try { await net.fetchData() } catch (e) { rejected = e }
    assert.strictEqual(rejected.code, 'HTTP_304', '应抛出原错误（保留真实状态码）')
    assert.strictEqual(getCalls(), 1, '终态 3xx 必须首次即抛，不得重试')
  }

  // 13. net-7：Retry-After 解析（RFC 9110 的 delta-seconds 或 HTTP-date；其余形态一律 null 回落指数退避）
  {
    const now = Date.parse('2026-09-17T00:00:00.000Z')
    assert.strictEqual(parseRetryAfterMs('5', now), 5000, 'delta-seconds → 毫秒')
    assert.strictEqual(parseRetryAfterMs('  7  ', now), 7000, '两侧空白应裁剪')
    assert.strictEqual(parseRetryAfterMs('0', now), 0, '0 秒 → 立即重试')
    assert.strictEqual(parseRetryAfterMs(120, now), 120000, '数值型秒数同样接受')
    assert.strictEqual(parseRetryAfterMs('', now), null, '空串非法 → 回落指数退避')
    assert.strictEqual(parseRetryAfterMs('1.5', now), null, "非 RFC 形态 '1.5' 非法（不猜小数秒）")
    assert.strictEqual(parseRetryAfterMs('-5', now), null, '负数非法')
    assert.strictEqual(parseRetryAfterMs('abc', now), null, '无日期的文本非法')
    assert.strictEqual(parseRetryAfterMs(undefined, now), null, '缺失非法')
    assert.strictEqual(parseRetryAfterMs(null, now), null, 'null 非法')
    assert.strictEqual(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now), 0, '已过期 HTTP-date → 立即重试')
    assert.strictEqual(parseRetryAfterMs(new Date(now + 3000).toUTCString(), now), 3000, '未来 HTTP-date → 剩余毫秒')
  }

  // 13b. net-7 端到端：429 + Retry-After: 0 → 按服务端指示立即重试，日志注明来源；
  // 旧实现（退避只用 1000*2^attempt）此处会打印「1s 后重试」且没有「按 Retry-After」标记 → 本块红。
  {
    const { net, getCalls, getLogs } = makeNetwork({ retry: 1, statusCode: 429, failTimes: 1, responseHeaders: { 'retry-after': '0' } })
    const r = await net.fetchData()
    assert.strictEqual(r.calls, 2, '429 + Retry-After 应重试后成功')
    assert.strictEqual(getCalls(), 2)
    const retryLog = getLogs().find(l => l.includes('后重试'))
    assert.ok(retryLog && retryLog.includes('0s 后重试'), `等待时长须取自 Retry-After（0s），实际：${JSON.stringify(getLogs())}`)
    assert.ok(retryLog.includes('（按 Retry-After）'), `日志须注明退避来源，实际：${retryLog}`)
  }

  // 13c. 兼容 WHATWG Headers 形态（headers.get）——两条取头路径都要工作
  {
    const { net, getLogs } = makeNetwork({
      retry: 1,
      statusCode: 429,
      failTimes: 1,
      responseHeaders: { get: (name) => (name === 'retry-after' ? '0' : undefined) }
    })
    await net.fetchData()
    const retryLog = getLogs().find(l => l.includes('后重试'))
    assert.ok(retryLog && retryLog.includes('0s 后重试') && retryLog.includes('（按 Retry-After）'),
      `Headers.get 形态同样应生效，实际：${JSON.stringify(getLogs())}`)
  }

  // 13d. 无 Retry-After（或非法值）→ 保持原指数退避（1s、2s…）且不出现来源标记。
  // V5 打回反例纳入：'5 Oct' 与 ISO-8601 曾被 Date.parse 宽松接受 → 输出「0s 后重试（按 Retry-After）」，
  // 既谎报来源又把修前的 1s 退避改成 0；本块对它们断言 1s + 无来源标记（旧实现直接红）。
  for (const [headers, label] of [
    [undefined, '无 headers'],
    [{ 'retry-after': '1.5' }, '非法 Retry-After'],
    [{ 'retry-after': '5 Oct' }, "非 HTTP-date（'5 Oct'）"],
    [{ 'retry-after': '2026-09-17T00:00:00Z' }, 'ISO-8601（非 HTTP-date）']
  ]) {
    const { net, getLogs } = makeNetwork({ retry: 1, statusCode: 503, failTimes: 1, responseHeaders: headers })
    await net.fetchData()
    const retryLog = getLogs().find(l => l.includes('后重试'))
    assert.ok(retryLog && retryLog.includes('1s 后重试'), `${label} 应回落指数退避（1s），实际：${JSON.stringify(getLogs())}`)
    assert.ok(!retryLog.includes('按 Retry-After'), `${label} 不得标成按 Retry-After 退避，实际：${retryLog}`)
  }

  // 13e. 上限保护：Retry-After 给出超大等待（3600s）时钳到 30s（不得把单轮请求挂死）。
  // 只把全局 setTimeout 替换成立即结算，断言落在日志里的等待值上（否则本用例要真等 30 秒）。
  {
    const realSetTimeout = global.setTimeout
    global.setTimeout = (fn) => { fn(); return 0 }
    try {
      const { net, getLogs } = makeNetwork({ retry: 1, statusCode: 429, failTimes: 1, responseHeaders: { 'retry-after': '3600' } })
      await net.fetchData()
      assert.ok(getLogs().some(l => l.includes('30s 后重试') && l.includes('（按 Retry-After）')),
        `超大 Retry-After 必须钳到 30s，实际：${JSON.stringify(getLogs())}`)
    } finally {
      global.setTimeout = realSetTimeout
    }
  }

  // 13f. net-7 返工（V5 打回）：HTTP-date 分支改为严格 RFC 9110 白名单（IMF-fixdate / rfc850 / asctime）
  // 的真值表。反例（旧实现）：Date.parse 宽松接受 '5 Oct'、ISO-8601、ISO 日期等非 HTTP-date，按「已过期」
  // 钳成 0，日志却标「0s 后重试（按 Retry-After）」；修前这些输入走指数退避 1s ⇒ 修复引入的新口径缺口。
  // 本块同时覆盖我自造的同族反例（星期与日期不一致、单位数小时、带时区后缀、非法日、越界数字串）。
  {
    const now = Date.parse('2026-09-17T00:00:00.000Z')
    const table = [
      // [输入, 期望, 说明]
      ['120', 120000, '合法：delta-seconds'],
      ['0', 0, '合法：delta-seconds 0（立即重试）'],
      ['  120  ', 120000, '合法：两侧空白裁剪'],
      [120, 120000, '合法：数值型 delta-seconds'],
      ['Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('2026-10-21T07:28:00.000Z') - now, '合法：IMF-fixdate（未来）'],
      ['Wed, 21 Oct 2015 07:28:00 GMT', 0, '合法：IMF-fixdate（已过期 → 0，语义同 RFC）'],
      ['Sunday, 06-Nov-94 08:49:37 GMT', 0, '合法：rfc850-date（obs-date，已过期 → 0）'],
      ['Sun Nov  6 08:49:37 1994', 0, '合法：asctime-date（obs-date，已过期 → 0）'],
      ['Thu Sep 17 00:00:03 2026', 3000, '合法：asctime 必须按 GMT 解释（按本地时区 UTC+8 会算成 8 小时前 → 0）'],
      ['5 Oct', null, '非法：自然语言日期（Date.parse 宽松接受，V5 打回反例）'],
      ['2026-09-17T00:00:00Z', null, '非法：ISO-8601 不是 HTTP-date（V5 打回反例）'],
      ['2026-09-17', null, '非法：ISO 日期形态'],
      ['Oct 5 2026', null, '非法：缺 day-name 的 asctime 变体'],
      ['Mon, 21 Oct 2026 07:28:00 GMT', null, '同族反例：星期与日期不一致（2026-10-21 是 Wed）'],
      ['Wed, 21 Oct 2026 7:28:00 GMT', null, '同族反例：小时非两位'],
      ['Wed, 21 Oct 2026 07:28:00 GMT+00:00', null, '同族反例：带时区后缀（HTTP-date 必须是 GMT 字面量）'],
      ['Sun, 32 Nov 2026 00:00:00 GMT', null, '同族反例：非法日（32）'],
      ['-5', null, '非法：负数 delta-seconds'],
      ['1.5', null, '非法：小数秒'],
      ['+3', null, '非法：带符号整数'],
      ['99999999999', null, '非法：delta-seconds 越 2^31-1 上界'],
      ['9'.repeat(400), null, '非法：数字串溢出（Number → Infinity）'],
      ['', null, '非法：空串'],
      ['true', null, '非法：任意文本'],
      [undefined, null, '非法：缺失'],
      [null, null, '非法：null']
    ]
    for (const [input, expected, label] of table) {
      const actual = parseRetryAfterMs(input, now)
      assert.strictEqual(actual, expected, `${label}：parseRetryAfterMs(${JSON.stringify(input)}) 应为 ${expected}，实际 ${actual}`)
    }
  }

  // 17. net-2 注释口径锁定（V4 #3 注释漂移）：xbk_network.js 的 DNS 预热注释声明「缓存/pending key 只含
  // hostname|family（AGENTS-01 起），故预热与真实请求三种 family 模式下同 key」。这里不靠读注释，直接
  // 用 xbk_agents 的真实现断言：① 预热一次后用**真实请求形状**的 lookup 选项（含 hints/all，family 由
  // baseRequestOptions 的 dnsLookupIpVersion 同源决定）再查 → 必须命中预热写入的缓存、不得二次解析；
  // ② 反向：family 不同 → key 不同 → 必须重新解析。旧口径（key 含 hints/all/verbatim）下 ① 会二次解析。
  {
    const dns = require('dns')
    const originalLookup = dns.lookup
    let calls = 0
    dns.lookup = (hostname, options, callback) => { calls += 1; callback(null, '192.0.2.1', 4) }
    try {
      delete require.cache[require.resolve('./xbk_agents')]
      const { prewarmDns, dnsLookup, DNS_LOOKUP_IP_VERSION } = require('./xbk_agents')
      const host = 'net2-key-probe.invalid'
      const lookupOnce = (options) => new Promise((resolve, reject) => {
        dnsLookup(host, options, (err, address, family) => (err ? reject(err) : resolve({ address, family })))
      })
      await prewarmDns(host)
      assert.strictEqual(calls, 1, '前置：预热应发起一次解析')
      // 真实请求形状：got 把 dnsLookupIpVersion 写进 requestOptions.family，net.connect 再传给 lookup；
      // 未设 XBK_DNS_FAMILY 时 family 为 undefined（dnsCacheKey 归一为 0），强制时是 4/6。
      // hints 同源：net 在 family 未指定时传 ADDRCONFIG、**指定 family 时传 0**（AGENTS-11 实测），
      // 所以这里必须按 realFamily 取 hints，否则 key 与预热不同源、断言会假红。ADDRCONFIG 必须从
      // dns 常量取（本块上方已 require('dns')），不得写死本机观测值 1024——该常量平台相关，
      // 写死只在本机成立（CI 上 xbk_agents 的 PRODUCTION_LOOKUP_HINTS 取的是 dns.ADDRCONFIG）。
      const realFamily = DNS_LOOKUP_IP_VERSION === 'ipv4' ? 4 : DNS_LOOKUP_IP_VERSION === 'ipv6' ? 6 : undefined
      const hit = await lookupOnce({ family: realFamily, hints: realFamily ? 0 : dns.ADDRCONFIG, all: true })
      assert.ok(hit.address, '真实请求形状的 lookup 应返回地址')
      assert.strictEqual(calls, 1, '预热与真实请求必须同 key（hostname|family|hints|order）→ 真实请求应命中预热条目（旧口径含 hints/all/verbatim，或 key 不含 hints，此处都会偏离）')
      await lookupOnce({ family: realFamily === 6 ? 4 : 6 })
      assert.strictEqual(calls, 2, '反向：family 不同 → key 不同 → 必须重新解析（key 只含 hostname|family）')
    } finally {
      dns.lookup = originalLookup
      delete require.cache[require.resolve('./xbk_agents')]
    }
  }

  console.log('test_network OK')
})().catch((e) => { console.error(e); process.exit(1) })
