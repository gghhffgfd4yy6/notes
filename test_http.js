'use strict'

const assert = require('assert')
const { EventEmitter } = require('node:events')
const got = require('got')
const { fetchJson, DEFAULT_TIMEOUT_MS } = require('./xbk_http')
const { classifyFailure } = require('./xbk_failure_policy')

// 生产官方 got 提供 stream API；测试注入 mock stream（EventEmitter），
// 走 fetchJson 的可限流真实路径（含响应体上限 / HTTP 错误 / JSON 解析）。
function installMockStream (behavior) {
  const orig = got.stream
  got.stream = (url, opts) => {
    if (behavior.onOptions) behavior.onOptions(url, opts)
    const s = new EventEmitter()
    s.timings = { phases: {} }
    s.destroy = (err) => { s.__destroyed = err || true }
    setTimeout(() => {
      if (behavior.response) s.emit('response', behavior.response)
      if (behavior.chunks) for (const c of behavior.chunks) s.emit('data', Buffer.from(c))
      if (behavior.error) { s.emit('error', behavior.error); return }
      s.emit('end')
    }, 0)
    return s
  }
  return () => { got.stream = orig }
}

;(async () => {
  // 1. 正常 JSON 解析
  {
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"a":1}'] })
    try {
      const body = await fetchJson('https://api.example.com/x')
      assert.deepStrictEqual(body, { a: 1 }, '应解析 JSON 对象')
    } finally { restore() }
  }

  // 2. HTTP 500 → reject HTTP_500，附响应详情
  {
    const restore = installMockStream({ response: { statusCode: 500, headers: {} }, chunks: ['oops'] })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.ok(rejected, 'HTTP 500 应 reject')
      assert.strictEqual(rejected.code, 'HTTP_500')
      assert.strictEqual(rejected.response.statusCode, 500, '应附 statusCode')
      assert.strictEqual(rejected.response.body, 'oops', '应附响应体')
    } finally { restore() }
  }

  // 3. 响应体超限 → EBODYLIMIT（maxBody=10，流 16 字节）
  {
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['0123456789', 'abcdef'] })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x', {}, 10) } catch (e) { rejected = e }
      assert.ok(rejected, '超限应 reject')
      assert.strictEqual(rejected.code, 'EBODYLIMIT')
    } finally { restore() }
  }

  // 4. 响应体非 JSON → ERR_BODY_NOT_JSON
  {
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['not json'] })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.ok(rejected, '非 JSON 应 reject')
      assert.strictEqual(rejected.code, 'ERR_BODY_NOT_JSON')
    } finally { restore() }
  }

  // 5. 网络错误（流 error 事件）→ 透传该错误
  {
    const netErr = new Error('socket hang up')
    netErr.code = 'ECONNRESET'
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, error: netErr })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.ok(rejected, '流错误应 reject')
      assert.strictEqual(rejected.code, 'ECONNRESET')
    } finally { restore() }
  }

  // 6. XBK_PROFILE=3 + 正常 JSON → 走 detailedProfile timing 日志分支（行75-78）
  // 行为断言：不仅验证 JSON 解析结果，还验证 profile 日志确实被输出（start/response/timing 三条日志）。
  {
    const origProfile = process.env.XBK_PROFILE
    process.env.XBK_PROFILE = '3'
    const logs = []
    const origLog = console.log
    console.log = (...args) => { logs.push(args.join(' ')) }
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"ok":true}'] })
    try {
      const body = await fetchJson('https://api.example.com/x')
      assert.deepStrictEqual(body, { ok: true }, 'PROFILE=3 下应正常解析 JSON')
      // 日志断言 1：start 日志应被输出
      assert.ok(logs.some(l => l.includes('[profile api] start')), '应输出 [profile api] start 日志')
      // 日志断言 2：response 日志应被输出
      assert.ok(logs.some(l => l.includes('[profile api] responseAtMs=')), '应输出 [profile api] responseAtMs 日志')
      // 日志断言 3：timing 日志应被输出（这是行75-78的核心分支，此前唯一断言未覆盖）
      assert.ok(logs.some(l => l.includes('[profile api timing]')), '应输出 [profile api timing] 日志（覆盖 timing 分支）')
      assert.ok(logs.some(l => l.includes('total=') && l.includes('bytes=')), 'timing 日志应包含 total 和 bytes 字段')
    } finally {
      restore()
      console.log = origLog
      if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    }
  }

  // 7. UTF-8 BOM 前缀的合法 JSON → 正常解析。旧实现直接 JSON.parse（对 BOM 抛错）→ 归成
  //    ERR_BODY_NOT_JSON，而 xbk_failure_policy 把该码放进 PERMANENT 集合 → 常驻循环永久停推。
  {
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['\uFEFF{"a":1}'] })
    try {
      const body = await fetchJson('https://api.example.com/x')
      assert.deepStrictEqual(body, { a: 1 }, 'BOM 前缀的合法 JSON 应解析成功')
    } finally { restore() }
  }

  // 8. 非 JSON → 错误消息只报长度，不回显响应体（防密钥/业务数据经日志与告警外泄）
  {
    const secret = 'sk-live-SECRET-1234567890'
    const payload = `{"token":"${secret}"`
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: [payload] })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.ok(rejected, '非 JSON 应 reject')
      assert.strictEqual(rejected.code, 'ERR_BODY_NOT_JSON')
      assert.ok(rejected.message.includes(`body ${payload.length} chars`), '错误消息应只报响应体长度')
      assert.ok(!rejected.message.includes(secret), '错误消息不得回显响应体内容')
      assert.ok(!rejected.message.includes('sk-live'), '错误消息不得回显响应体片段')
    } finally { restore() }
  }

  // 8b. 空响应体（含 BOM-only 与纯空白体）→ ERR_EMPTY_BODY，归类必须可重试；与「有内容但非 JSON」的
  //     ERR_BODY_NOT_JSON（永久）分开——旧实现两者同码且该码在 PERMANENT 集合 → 一次瞬时空体永久停推。
  {
    const cases = [[[], '空体'], [['\uFEFF'], 'BOM-only 体'], [['\n\t '], '纯空白体']]
    for (const [chunks, label] of cases) {
      const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks })
      try {
        let rejected = null
        try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
        assert.ok(rejected, `${label} 应 reject`)
        assert.strictEqual(rejected.code, 'ERR_EMPTY_BODY', `${label} 应归成空体码（旧实现 ERR_BODY_NOT_JSON=永久停推）`)
        assert.ok(rejected.message.includes('empty body'), `${label} 应报 empty body`)
        assert.ok(!rejected.message.includes('body 0 chars'), `${label} 不应报 body 0 chars（两种语义分开）`)
        assert.strictEqual(classifyFailure(rejected).kind, 'retryable', `${label} 的失败归类必须是可重试`)
      } finally { restore() }
    }
  }

  // 8c. BOM + 非 JSON → 报的是剥离 BOM 后的长度，且仍不回显原文
  {
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['\uFEFFnope'] })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.ok(rejected.message.includes('body 4 chars'), '应报剥离 BOM 后的长度 4')
      assert.ok(!rejected.message.includes('nope'), '错误消息不得回显响应体内容')
    } finally { restore() }
  }

  // 9. XBK_PROFILE=3 的 start 日志：URL 只保留 origin + '/***'，路径段里的密钥不得出现
  //    （旧实现 replace(/\/[^/]+$/, '/***') 只遮蔽末段 → /SECRET/ 原样进日志）
  {
    const origProfile = process.env.XBK_PROFILE
    process.env.XBK_PROFILE = '3'
    const logs = []
    const origLog = console.log
    console.log = (...args) => { logs.push(args.join(' ')) }
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"ok":true}'] })
    try {
      const body = await fetchJson('https://api.example.com/SECRET/v1?token=abc')
      assert.deepStrictEqual(body, { ok: true }, '脱敏不应影响请求本身')
      const startLog = logs.find(l => l.includes('[profile api] start url='))
      assert.ok(startLog, '应输出 start 日志')
      assert.ok(startLog.includes('url=https://api.example.com/***'), 'URL 应只保留 origin + /***')
      assert.ok(!startLog.includes('SECRET'), '非末段路径密钥不得进日志')
      assert.ok(!startLog.includes('v1') && !startLog.includes('token=abc'), '路径/查询串不得进日志')
    } finally {
      restore()
      console.log = origLog
      if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    }
  }

  // 10. 非法 URL → '<invalid-url>/***'（旧实现正则不匹配，整条 URL 原样进日志）
  {
    const origProfile = process.env.XBK_PROFILE
    process.env.XBK_PROFILE = '3'
    const logs = []
    const origLog = console.log
    console.log = (...args) => { logs.push(args.join(' ')) }
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"ok":true}'] })
    try {
      const body = await fetchJson('not-a-valid-url')
      assert.deepStrictEqual(body, { ok: true })
      const startLog = logs.find(l => l.includes('[profile api] start url='))
      assert.ok(startLog && startLog.includes('url=<invalid-url>/***'), '非法 URL 应打 <invalid-url>/***')
      assert.ok(!startLog.includes('not-a-valid-url'), '非法 URL 原串不得进日志')
    } finally {
      restore()
      console.log = origLog
      if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    }
  }

  // 11. maxBody 非法（非数字/≤0/NaN/Infinity）→ 告警一次并钳制到 DEFAULT_MAX_BODY；合法值不告警
  {
    const warns = []
    const origWarn = console.warn
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      for (const bad of [0, -1, Number.NaN, Infinity, '10']) {
        const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"a":1}'] })
        try {
          const body = await fetchJson('https://api.example.com/x', {}, bad)
          assert.deepStrictEqual(body, { a: 1 }, `maxBody=${String(bad)} 应钳制到 DEFAULT_MAX_BODY（不因非法上限误杀正常体）`)
        } finally { restore() }
      }
      assert.strictEqual(warns.length, 5, '每个非法 maxBody 都应告警一次')
      assert.ok(warns.every(w => w.includes('maxBody 非法') && w.includes('已钳制到') && w.includes('20971520')), '告警应说明非法值与钳制目标 DEFAULT_MAX_BODY')
      warns.length = 0
      const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"a":1}'] })
      try {
        const body = await fetchJson('https://api.example.com/x', {}, 1024)
        assert.deepStrictEqual(body, { a: 1 }, '合法 maxBody 不应改变解析行为')
        assert.strictEqual(warns.length, 0, '合法 maxBody 不应告警')
      } finally { restore() }
    } finally { console.warn = origWarn }
  }

  // 12. responseAtMs 在 response 事件取值：timing 日志的 responseAt 必须等于 response 日志的
  //     responseAtMs，且严格小于 downloadEnd（旧实现在 end 回调里重新取 Date.now()，恒 ≥ downloadEnd）。
  //     注入单调递增假时钟使两处取值必然可区分——真实时钟下旧实现常因同一毫秒而蒙混过关。
  {
    const origProfile = process.env.XBK_PROFILE
    const origNow = Date.now
    process.env.XBK_PROFILE = '3'
    const logs = []
    const origLog = console.log
    console.log = (...args) => { logs.push(args.join(' ')) }
    let clock = 0
    Date.now = () => { clock += 1000; return clock }
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"t":1}'] })
    try {
      const body = await fetchJson('https://api.example.com/x')
      assert.deepStrictEqual(body, { t: 1 }, '假时钟下 JSON 解析应正常')
      const respLog = logs.find(l => l.includes('[profile api] responseAtMs='))
      const timingLog = logs.find(l => l.includes('[profile api timing]'))
      assert.ok(respLog && timingLog, '应输出 response 与 timing 日志')
      const respAt = Number(/responseAtMs=(\d+)/.exec(respLog)[1])
      const timingAt = Number(/responseAt=(\d+)/.exec(timingLog)[1])
      const downloadEnd = Number(/downloadEnd=(\d+)/.exec(timingLog)[1])
      assert.strictEqual(timingAt, respAt, 'timing.responseAt 必须复用 response 事件的取值')
      assert.ok(timingAt < downloadEnd, `responseAt(${timingAt}) 应严格小于 downloadEnd(${downloadEnd})`)
    } finally {
      restore()
      console.log = origLog
      Date.now = origNow
      if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    }
  }

  // 13. maxBody 是「取值即抛错」的非法对象 → 告警路径必须先做安全转换。
  //     CodeRabbit PR #147 #8：旧实现直接 `String(maxBody)` 插进模板串，抛错发生在 console.warn
  //     之前 → fetchJson 返回的 Promise 直接 reject、一次告警都没有，且「非法上限一律钳制」契约被破坏。
  //     覆盖两类不可字符串化对象：带抛错 toString 的对象、无原型的 null 原型对象。
  {
    const cases = [
      ['toString 抛错的对象', { toString () { throw new Error('toString boom') } }],
      ['无原型的 null 原型对象', Object.create(null)]
    ]
    const warns = []
    const origWarn = console.warn
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      for (const [label, bad] of cases) {
        const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"ok":true}'] })
        try {
          let syncErr = null
          let promise = null
          try {
            promise = fetchJson('https://api.example.com/x', {}, bad)
            // SonarJS S6544：try 内的 promise 必须被 await（它给的另一选项「挂 .catch()」经实测无效——
            // 派生出的 promise 本身仍被判为悬空）。这里直接 await 一次：既满足规则，也把
            // 「同步抛错」与「异步 reject」都收敛进 catch（非法 maxBody 应被钳制，两种都不该发生）。
            await promise
          } catch (e) { syncErr = e }
          assert.strictEqual(syncErr, null, `${label}：不得同步抛异常，也不得 reject（非法 maxBody 应被钳制）`)
          assert.ok(promise instanceof Promise, `${label}：应返回 Promise`)
          const body = await promise
          assert.deepStrictEqual(body, { ok: true }, `${label}：非法 maxBody 仍应钳制到 DEFAULT_MAX_BODY 并正常解析（不因告警取值失败而 reject）`)
        } finally { restore() }
      }
      assert.strictEqual(warns.length, cases.length, '每个非法 maxBody 都应告警一次（告警自身不得抛错）')
      assert.ok(warns.every(w => w.includes('maxBody 非法') && w.includes('已钳制到') && w.includes('20971520')),
        `告警应说明非法值与钳制目标 DEFAULT_MAX_BODY；实际 warns=${JSON.stringify(warns)}`)
      assert.ok(warns.every(w => w.includes('无法转换')),
        `取值失败时应回退到兜底文案，而不是把异常带进告警路径；实际 warns=${JSON.stringify(warns)}`)
    } finally { console.warn = origWarn }
  }

  // 14. XHTTP-01：fetchJson 未显式传 timeout 时必须注入有限默认超时——got@11 默认 timeout:{}（不超时）
  //     且 baseRequestOptions() 的共享 Agent 不带超时，服务端半开（连上不返回）会让请求永久挂起。
  //     调用方显式传 timeout（数字或 got 支持的对象形态）时必须原样透传，语义零变更。
  {
    assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0, '默认超时必须是有限正数')
    const captured = []
    const restore = installMockStream({
      response: { statusCode: 200, headers: {} },
      chunks: ['{"a":1}'],
      onOptions: (url, opts) => captured.push(opts)
    })
    try {
      const body = await fetchJson('https://api.example.com/x')
      assert.deepStrictEqual(body, { a: 1 }, '注入默认超时不应影响正常请求')
      assert.strictEqual(captured[0].timeout, DEFAULT_TIMEOUT_MS, '未显式传 timeout 应注入默认超时（旧实现为 undefined，可永久挂起）')

      await fetchJson('https://api.example.com/x', { timeout: 1234 })
      assert.strictEqual(captured[1].timeout, 1234, '显式数字 timeout 必须优先于默认值')

      await fetchJson('https://api.example.com/x', { timeout: { request: 4321 } })
      assert.deepStrictEqual(captured[2].timeout, { request: 4321 }, 'got 对象形态 timeout 应原样透传（不被默认值覆盖）')
    } finally { restore() }
  }

  // 15. XHTTP-05：**失败归类**端到端（mock 流 → fetchJson 抛错 → classifyFailure），不只断言错误码字符串。
  //     覆盖「半开」与「空体」两类：半开（got 超时错误 shape：name=TimeoutError、code=ETIMEDOUT、
  //     message="Timeout awaiting 'request' for 30000ms"，见 got 的 core/utils/timed-out.js）必须可重试；
  //     空体必须可重试且理由是本码本身（旧实现按 ERR_BODY_NOT_JSON 判永久停推）。
  {
    const cases = [
      // [chunks, 期望 kind, 期望 reason, 场景]
      [[], 'retryable', 'ERR_EMPTY_BODY', '空响应体'],
      [['\n\t '], 'retryable', 'ERR_EMPTY_BODY', '纯空白体'],
      [['not json'], 'permanent', 'ERR_BODY_NOT_JSON', '非 JSON 合约错误（不得被空体修复一起放松）']
    ]
    for (const [chunks, kind, reason, label] of cases) {
      const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks })
      try {
        let rejected = null
        try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
        assert.ok(rejected, `${label} 应 reject`)
        const verdict = classifyFailure(rejected)
        assert.strictEqual(verdict.kind, kind, `${label} 应归类为 ${kind}，实际 ${verdict.kind}（reason=${verdict.reason}）`)
        assert.strictEqual(verdict.reason, reason, `${label} 的归类理由应为 ${reason}，实际 ${verdict.reason}`)
      } finally { restore() }
    }
    const timeoutErr = new Error("Timeout awaiting 'request' for 30000ms")
    timeoutErr.name = 'TimeoutError'
    timeoutErr.code = 'ETIMEDOUT'
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, error: timeoutErr })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.ok(rejected, '半开（请求超时）应 reject')
      const verdict = classifyFailure(rejected)
      assert.strictEqual(verdict.kind, 'retryable', `半开超时必须可重试，实际 ${verdict.kind}（reason=${verdict.reason}）`)
      assert.strictEqual(verdict.reason, 'ETIMEDOUT', `半开超时应按 ETIMEDOUT 归类，实际 ${verdict.reason}`)
    } finally { restore() }
  }

  // 16. XHTTP-06：终态 3xx 带**真实状态码**抛出并归 permanent。反例（旧实现）：3xx 落进 JSON 解析分支，
  //     空体 304 报 ERR_EMPTY_BODY、带体 302 报 ERR_BODY_NOT_JSON——同一条 3xx 因响应体不同而落到两个码；
  //     且若只把判据扩到 >=300 而失败策略不认 3xx，错误码变 HTTP_3xx 后会落 UNKNOWN=可重试（静默翻转）。
  {
    const cases = [[304, [], '终态 304（空体）'], [302, ['<html>moved</html>'], '终态 302（带体）'], [300, ['{}'], '终态 300（合法 JSON 体）']]
    for (const [status, chunks, label] of cases) {
      const restore = installMockStream({ response: { statusCode: status, headers: {} }, chunks })
      try {
        let rejected = null
        try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
        assert.ok(rejected, `${label} 应 reject（不得因响应体是合法 JSON 就当成成功）`)
        assert.strictEqual(rejected.code, `HTTP_${status}`, `${label} 必须带真实状态码（旧实现报体相关码）`)
        assert.strictEqual(rejected.response.statusCode, status, `${label} 应附 statusCode`)
        assert.strictEqual(rejected.response.body, chunks.join(''), `${label} 应附响应体`)
        const verdict = classifyFailure(rejected)
        assert.strictEqual(verdict.kind, 'permanent', `${label} 应判永久（确定性重定向），实际 ${verdict.kind}（reason=${verdict.reason}）`)
        assert.strictEqual(verdict.reason, `HTTP_${status}`, `${label} 的归类理由应为 HTTP_${status}，实际 ${verdict.reason}`)
      } finally { restore() }
    }
  }

  // 本地小工具：把「该 settle 却永不 settle」的变异体转成快速失败，而不是只靠 900s 外部超时判负。
  // 计时器必须在 race settle 后清掉：p 先 settle 时原写法仍留着定时器存活，
  // 会把进程多留 ms 毫秒（反复的变异运行逐次累积这段空等）。见 PR #173 评审。
  const withinSettle = (p, ms = 1500) => {
    let timer
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('fetchJson 未在期限内 settle')), ms) })
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
  }

  // H1. 默认环境（XBK_PROFILE 非 '3'）不得输出任何 [profile api] 日志——专杀
  //     `process.env.XBK_PROFILE === '3'`→true 与 `if (detailedProfile)`→if(true) 两类变异体。
  {
    const origProfile = process.env.XBK_PROFILE
    delete process.env.XBK_PROFILE
    const logs = []
    const origLog = console.log
    console.log = (...a) => logs.push(a.join(' '))
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"a":1}'] })
    try {
      assert.deepStrictEqual(await withinSettle(fetchJson('https://api.example.com/x')), { a: 1 }, '默认环境仍应正常返回 JSON')
    } finally {
      restore()
      console.log = origLog
      if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    }
    assert.strictEqual(logs.filter(l => l.startsWith('[profile api')).length, 0, `默认环境不得输出 profile 日志，实际 ${JSON.stringify(logs)}`)
  }

  // H2. 详细 profile：错误路径必须打且只打一条 `[profile api] error`；默认环境一条都不打——专杀
  //     `if (detailedProfile)` 的 true/false 两侧变异体（finishReject 内的日志分支）。
  {
    const profileModes = [true, false]
    for (const profileOn of profileModes) {
      const origProfile = process.env.XBK_PROFILE
      if (profileOn) process.env.XBK_PROFILE = '3'; else delete process.env.XBK_PROFILE
      const logs = []
      const origLog = console.log
      console.log = (...a) => logs.push(a.join(' '))
      const boom = new Error('boom')
      boom.code = 'ERR_BOOM'
      const restore = installMockStream({ error: boom })
      let rejected = null
      try {
        await withinSettle(fetchJson('https://api.example.com/x'))
      } catch (e) { rejected = e } finally {
        restore()
        console.log = origLog
        if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
      }
      assert.strictEqual(rejected, boom, '底层 error 必须原样 reject')
      assert.strictEqual(logs.filter(l => l.includes('[profile api] error')).length, profileOn ? 1 : 0, `XBK_PROFILE=${profileOn ? "'3'" : '未设'} 时 error 日志条数不符：${JSON.stringify(logs)}`)
    }
  }

  // H3. stream 路径必须显式 throwHttpErrors:false，且未传 timeout 时注入 DEFAULT_TIMEOUT_MS（30000）——专杀
  //     BooleanLiteral `false`→true（got 会自行吞掉非 2xx 的响应体，状态码分支失效）。
  {
    let seen = null
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"ok":true}'], onOptions: (_u, opts) => { seen = opts } })
    try {
      assert.deepStrictEqual(await withinSettle(fetchJson('https://api.example.com/x')), { ok: true })
    } finally { restore() }
    assert.strictEqual(seen.throwHttpErrors, false, 'stream 路径必须显式 throwHttpErrors:false')
    assert.strictEqual(seen.timeout, DEFAULT_TIMEOUT_MS, '未显式传 timeout 时必须注入默认 30000ms')
  }

  // H4. 响应体上限是**严格大于**才拒绝（total > limit）：恰好等于上限必须放行；超 1 字节必须拒绝且
  //     错误码/文案精确、并真的把错误交给 stream.destroy——专杀 EqualityOperator `>=`、StringLiteral
  //     文案清空、CallExpression `stream.destroy(err)` 被删三类变异体。
  {
    const body = '{"n":123}'
    const limit = Buffer.byteLength(body)
    const installExact = () => {
      const orig = got.stream
      let destroyed = null
      got.stream = () => {
        const s = new EventEmitter()
        s.timings = { phases: {} }
        s.destroy = (err) => { destroyed = err === undefined ? true : err }
        setTimeout(() => {
          s.emit('response', { statusCode: 200, headers: {} })
          s.emit('data', Buffer.from(body))
          s.emit('end')
        }, 0)
        return s
      }
      return { restore: () => { got.stream = orig }, destroyed: () => destroyed }
    }
    const a = installExact()
    try {
      assert.deepStrictEqual(await withinSettle(fetchJson('https://api.example.com/x', {}, limit)), { n: 123 }, '恰好等于上限（未超过）必须正常返回')
    } finally { a.restore() }
    const b = installExact()
    let rejected = null
    try {
      await withinSettle(fetchJson('https://api.example.com/x', {}, limit - 1))
    } catch (e) { rejected = e } finally { b.restore() }
    assert.strictEqual(rejected && rejected.code, 'EBODYLIMIT', '超上限必须报 EBODYLIMIT')
    assert.strictEqual(rejected && rejected.message, `响应体过大(超过 ${limit - 1} 字节)`, '错误文案必须报实际上限（StringLiteral 变异体）')
    assert.strictEqual(b.destroyed() && b.destroyed().code, 'EBODYLIMIT', '超限必须把错误交给 stream.destroy（CallExpression 变异体）')
  }

  // H5. 终态 3xx 的错误文案必须带真实状态码，且必须在期限内 settle——专杀 StringLiteral 文案清空与
  //     `finishReject(err)` / `if (settled) return` 被改成永不 settle 的变异体。
  {
    const restore = installMockStream({ response: { statusCode: 302, headers: {} }, chunks: ['<html>moved</html>'] })
    let rejected = null
    try {
      await withinSettle(fetchJson('https://api.example.com/x'))
    } catch (e) { rejected = e } finally { restore() }
    assert.strictEqual(rejected && rejected.message, 'HTTP 302', '3xx 错误文案必须是 HTTP_<status>')
    assert.strictEqual(rejected && rejected.code, 'HTTP_302')
  }

  // H6. profile timing 日志里的时间字段必须是**耗时差**（不得把绝对时间戳相加），firstDataAt 不得恒为
  //     n/a——专杀 `firstDataAt - started` / `endedAt - started` / `Date.now() - endedAt` 等
  //     ArithmeticOperator 变异体与 `if (!firstDataAt)` 的 BooleanLiteral 变异体。
  {
    const origProfile = process.env.XBK_PROFILE
    process.env.XBK_PROFILE = '3'
    const logs = []
    const origLog = console.log
    console.log = (...a) => logs.push(a.join(' '))
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: ['{"a":', '1}'] })
    try {
      assert.deepStrictEqual(await withinSettle(fetchJson('https://api.example.com/x')), { a: 1 })
    } finally {
      restore()
      console.log = origLog
      if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    }
    const timing = logs.find(l => l.includes('[profile api timing]'))
    assert.ok(timing, `必须输出 timing 日志，实际 ${JSON.stringify(logs)}`)
    for (const key of ['firstDataAt', 'downloadEnd', 'parse', 'total']) {
      // 用切分 + 字面量正则取数字：new RegExp(变量) 会被 Codacy 判为「非字面量构造器」（本例为误报）
      const tail = timing.split(key + '=')[1]
      const m = tail === undefined ? null : /^(\d+)/.exec(tail)
      assert.ok(m, `${key} 必须是数字耗时（恒为 n/a 说明首块未记录），实际日志：${timing}`)
      assert.ok(Number(m[1]) < 3600000, `${key} 必须是耗时差而不是时间戳相加，实际 ${m[1]}`)
    }
  }

  console.log('test_http OK')
})().catch((e) => { console.error(e); process.exit(1) })
