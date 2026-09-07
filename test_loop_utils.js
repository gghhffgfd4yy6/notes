'use strict'

const assert = require('assert')
const { runLoop, sleep } = require('./xbk_loop')

;(async () => {
  // ===== sleep：正常等待 =====
  const t0 = Date.now()
  await sleep(50)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 40, `sleep(50) 应至少等待约 50ms，实际 ${elapsed}ms`)
  assert.ok(elapsed < 500, `sleep(50) 不应过度等待，实际 ${elapsed}ms`)

  // ===== sleep：signal 已 aborted 时立即 resolve =====
  const c1 = new AbortController()
  c1.abort()
  const t1 = Date.now()
  await sleep(10000, c1.signal)
  assert.ok(Date.now() - t1 < 100, 'signal 已 aborted 时 sleep 应立即返回')

  // ===== sleep：等待期间 abort 应提前结束 =====
  const c2 = new AbortController()
  const t2 = Date.now()
  setTimeout(() => c2.abort(), 30)
  await sleep(10000, c2.signal)
  const elapsed2 = Date.now() - t2
  assert.ok(elapsed2 < 500, `等待期间 abort 应提前结束，实际 ${elapsed2}ms`)
  assert.ok(elapsed2 >= 20, `应等待约 30ms 后被 abort，实际 ${elapsed2}ms`)

  // ===== sleep：非有限 ms 使用默认 10000（用已 aborted signal 避免真等 10s）=====
  const c3 = new AbortController()
  c3.abort()
  await sleep(Number.NaN, c3.signal) // 不应抛错
  await sleep(Infinity, c3.signal)
  await sleep('abc', c3.signal)
  await sleep(-5, c3.signal) // 负值 → Math.max(0, -5)=0，不抛错

  // ===== runLoop：run 非函数返回 rejected Promise（async 函数）=====
  await assert.rejects(() => runLoop('not-a-function'), /runLoop 需要函数/, '非函数 run 应 reject')
  await assert.rejects(() => runLoop(123), /runLoop 需要函数/, '数字 run 应 reject')
  await assert.rejects(() => runLoop(null), /runLoop 需要函数/, 'null run 应 reject')

  // ===== runLoop：signal 初始 aborted → run 一次都不执行 =====
  const c4 = new AbortController()
  c4.abort()
  let runs4 = 0
  await runLoop(async () => { runs4 += 1 }, { signal: c4.signal, intervalMs: 0 })
  assert.strictEqual(runs4, 0, 'signal 初始 aborted 时 run 不应执行')

  // ===== runLoop：onError 抛错被忽略，循环继续 =====
  const c5 = new AbortController()
  let runs5 = 0
  let errorHandlerCalls = 0
  await runLoop(async () => {
    runs5 += 1
    if (runs5 === 1) throw new Error('business-error')
    if (runs5 === 2) c5.abort()
  }, {
    intervalMs: 0,
    signal: c5.signal,
    onError: async () => {
      errorHandlerCalls += 1
      throw new Error('error-handler-itself-fails')
    }
  })
  assert.strictEqual(runs5, 2, 'onError 抛错不应阻止下一轮运行')
  assert.strictEqual(errorHandlerCalls, 1, 'onError 应被调用一次')

  // ===== runLoop：onIntervalError 抛错被忽略 =====
  const c6 = new AbortController()
  let runs6 = 0
  let intervalErrorCalls = 0
  await runLoop(async () => {
    runs6 += 1
    if (runs6 === 2) c6.abort()
  }, {
    intervalMs: 0,
    refreshEvery: 1,
    signal: c6.signal,
    onInterval: async () => { throw new Error('refresh-fails') },
    onIntervalError: async () => {
      intervalErrorCalls += 1
      throw new Error('interval-error-handler-fails')
    }
  })
  assert.strictEqual(runs6, 2, 'onIntervalError 抛错不应阻止循环')
  assert.ok(intervalErrorCalls >= 1, 'onIntervalError 应被调用')

  // ===== runLoop：默认参数不抛错（signal aborted 立即退出）=====
  const c7 = new AbortController()
  c7.abort()
  await runLoop(async () => {}, { signal: c7.signal }) // 用默认 intervalMs/refreshEvery/onError

  console.log('test_loop_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
