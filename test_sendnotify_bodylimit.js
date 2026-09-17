'use strict'

// F5/S3 回归：推送层（xbk_sendNotify_slim 的 $.post/$.get）响应体上限。
// got@11 没有 maxResponseSize（实测 11.8.6）——此前 promise API 把整个响应体读进内存再 JSON.parse，
// xbk_http 的 20MB 流式上限只覆盖 fetchJson，推送出口完全没有上限。
// 本套件用 EventEmitter 假流验证流式限长路径（与 test_http.js 测 fetchJson 同一手法），并用回环服务器
// 验证官方 got 的真实 stream API 同样可用（只连 127.0.0.1，不触外网）：
//   ① 正常 JSON 仍被解析并被通道消费，请求选项原样透传（新路径不是空转、不改 body/headers）；
//   ② 超过上限的响应体报 EBODYLIMIT、流被销毁，且失败经 sendNotify 归因可见（不得记为推送成功）；
//   ③ got 替身没有 stream API 时（test_notify.js 那种 mock）退回原 promise 路径，行为不变；
//   ④ 官方 got + 回环 HTTP 服务器：真实流式路径端到端成功。
// ①② 同时安装「promise 路径替身」（回一个超大体）：老实现只会走 promise 路径并把它当普通响应处理，
// 因此拿不到 EBODYLIMIT —— 这正是本套件对旧实现的证伪点（只靠假流会退化成「打真实网络」的假红）。

const assert = require('assert')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const got = require('got')
const slim = require('./xbk_sendNotify_slim')
const { DEFAULT_MAX_BODY } = require('./xbk_http')

const cfg = slim.push_config
const MB = 1024 * 1024

// 安装假 got.stream：每个请求返回一个 EventEmitter 假流，按 behavior 发 response/data/(end|error)。
// 返回 { restore, created }，created 记录本次安装期间创建的流（含收到的请求参数，用于断言透传/销毁）。
function installMockStream (behavior) {
  const orig = got.stream
  const created = []
  const make = (url, opts) => {
    const s = new EventEmitter()
    s.timings = { phases: { total: 1 } }
    s.destroy = (err) => { s.__destroyed = err || true }
    s.__url = url
    s.__options = opts
    created.push(s)
    setTimeout(() => {
      if (behavior.response) s.emit('response', behavior.response)
      if (behavior.chunks) for (const c of behavior.chunks) s.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c))
      if (behavior.error) { s.emit('error', behavior.error); return }
      s.emit('end')
    }, 0)
    return s
  }
  got.stream = Object.assign(function (url, opts) { return make(url, opts) }, { get: make, post: make })
  return { restore: () => { got.stream = orig }, created }
}

// 安装 promise 路径替身（老实现唯一走的路径）：bodyFactory 延迟构造响应体，避免无谓的大字符串分配
function installPromiseMocks (bodyFactory) {
  const orig = { post: got.post, get: got.get }
  const make = () => Promise.resolve({ body: bodyFactory(), statusCode: 200, headers: {}, timings: { phases: {} } })
  got.post = make
  got.get = make
  return () => { got.post = orig.post; got.get = orig.get }
}

;(async () => {
  const savedCfg = {}
  for (const k of Object.keys(cfg)) { savedCfg[k] = cfg[k]; delete cfg[k] }
  // 只启用企业微信：其 URL 完全由假流接管（不会发出真实请求）
  cfg.QYWX_KEY = 'bodylimit-test-key'
  cfg.QYWX_ORIGIN = 'https://qyapi.invalid'
  try {
    // ① 正常 JSON：流式路径必须把 body 交给通道并判定成功，且请求选项原样透传
    const restoreOkPromise = installPromiseMocks(() => '{"errcode":0}')
    const okMock = installMockStream({
      response: { statusCode: 200, headers: { 'content-type': 'application/json' } },
      chunks: ['{"errcode":0}']
    })
    let okResult = null
    try {
      okResult = await slim.sendNotify('标题', '正文')
    } finally { okMock.restore(); restoreOkPromise() }
    assert.ok(okResult && okResult.successfulChannels.includes('企业微信'),
      '流式路径应正常解析 JSON 响应并判定通道成功（新路径不得空转）')
    assert.strictEqual(okMock.created.length, 1, '正常用例应只发起 1 个请求流')
    assert.strictEqual(okMock.created[0].__options.json.msgtype, 'markdown', '请求选项应原样透传给 got.stream（json body 未被改写）')
    assert.strictEqual(okMock.created[0].__options.timeout, 15000, 'timeout 选项应原样透传')
    assert.ok(String(okMock.created[0].__url).includes('/cgi-bin/webhook/send?key='), 'URL 构造不变')

    // ② 超过 20MB：EBODYLIMIT，且不得被当成推送成功
    const restoreBigPromise = installPromiseMocks(() => 'x'.repeat(21 * MB))
    const bigMock = installMockStream({
      response: { statusCode: 200, headers: {} },
      chunks: [Buffer.alloc(7 * MB, 0x61), Buffer.alloc(7 * MB, 0x61), Buffer.alloc(7 * MB, 0x61)]
    })
    let rejected = null
    try {
      await slim.sendNotify('标题', '正文')
    } catch (e) {
      rejected = e
    } finally { bigMock.restore(); restoreBigPromise() }
    assert.ok(rejected, '响应体超限应整体失败（不得静默记为成功）')
    assert.strictEqual(rejected.code, 'ALL_CHANNELS_FAILED', '全部通道失败应归因为 ALL_CHANNELS_FAILED')
    assert.ok(Array.isArray(rejected.failures) && rejected.failures.some(f => f && f.code === 'EBODYLIMIT'),
      `失败原因应带 EBODYLIMIT，实际：${JSON.stringify((rejected.failures || []).map(f => f && f.code))}`)
    assert.ok(rejected.failures.some(f => f && String(f.message).includes('响应体过大')), '失败消息应说明响应体过大')
    // 口径一致性护栏：推送层上限必须等于 xbk_http.DEFAULT_MAX_BODY（两边是各自独立声明的字面量，
    // slim 不能 require xbk_http——见 xbk_sendNotify_slim.js 的注释：会破坏 test_app.js 的 mock 注入顺序）
    assert.ok(rejected.failures.some(f => f && String(f.message).includes(String(DEFAULT_MAX_BODY))),
      `超限阈值必须与 xbk_http.DEFAULT_MAX_BODY(${DEFAULT_MAX_BODY}) 同口径`)
    assert.strictEqual(bigMock.created.length, 1, '超限用例应只发起 1 个请求流')
    assert.ok(bigMock.created[0].__destroyed, '超限后必须销毁响应流，不能继续把剩余体量读进内存')

    // ③ 无 stream 替身（test_notify.js 那种 promise-only mock）→ 退回原 promise 路径，行为不变
    const restoreFallback = installPromiseMocks(() => '{"errcode":0}')
    const savedStream = got.stream
    got.stream = undefined
    let fallbackResult = null
    try {
      fallbackResult = await slim.sendNotify('标题', '正文')
    } finally {
      restoreFallback()
      got.stream = savedStream
    }
    assert.ok(fallbackResult && fallbackResult.successfulChannels.includes('企业微信'),
      'got 替身无 stream 时应退回 promise 路径并照常成功（test_notify.js 等既有 mock 不受影响）')

    // ④ 官方 got + 回环服务器：真实 stream API 端到端（只连 127.0.0.1）
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"errcode":0}')
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    cfg.QYWX_ORIGIN = `http://127.0.0.1:${server.address().port}`
    let realResult = null
    try {
      realResult = await slim.sendNotify('标题', '正文')
    } finally {
      cfg.QYWX_ORIGIN = 'https://qyapi.invalid'
      await new Promise(resolve => server.close(resolve))
    }
    assert.ok(realResult && realResult.successfulChannels.includes('企业微信'),
      '官方 got 的真实流式路径应端到端成功（请求选项/响应解析与 promise 路径等价）')

    console.log('✅ F5/S3：推送层响应体上限（流式解析/选项透传、超限 EBODYLIMIT 并销毁流、无 stream 回退、官方 got 回环端到端）')
  } finally {
    for (const k of Object.keys(cfg)) delete cfg[k]
    for (const [k, v] of Object.entries(savedCfg)) cfg[k] = v
  }
  console.log('test_sendnotify_bodylimit OK')
})().catch((e) => { console.error(e); process.exit(1) })
