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

  console.log('test_http OK')
})().catch((e) => { console.error(e); process.exit(1) })
