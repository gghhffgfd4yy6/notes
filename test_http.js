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

  console.log('test_http OK')
})().catch((e) => { console.error(e); process.exit(1) })
