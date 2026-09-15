'use strict'

const assert = require('assert')
const { EventEmitter } = require('node:events')
const got = require('got')
const { fetchJson } = require('./xbk_http')

// 生产官方 got 提供 stream API；测试注入 mock stream（EventEmitter），
// 走 fetchJson 的可限流真实路径（含响应体上限 / HTTP 错误 / JSON 解析）。
function installMockStream (behavior) {
  const orig = got.stream
  got.stream = (url, opts) => {
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

  // 8b. 空响应体 → 报 'empty body'（旧实现输出 'Response is not JSON: ' + ''）
  {
    const restore = installMockStream({ response: { statusCode: 200, headers: {} }, chunks: [] })
    try {
      let rejected = null
      try { await fetchJson('https://api.example.com/x') } catch (e) { rejected = e }
      assert.strictEqual(rejected.code, 'ERR_BODY_NOT_JSON')
      assert.ok(rejected.message.includes('empty body'), '空体应报 empty body')
      assert.ok(!rejected.message.includes('body 0 chars'), '空体不应报 body 0 chars（两种语义分开）')
    } finally { restore() }
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

  console.log('test_http OK')
})().catch((e) => { console.error(e); process.exit(1) })
