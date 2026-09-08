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
  // 观测点：默认值生效体现在"未立即返回"——用极短等待验证 timer 已被调度（非 0ms 立即返回）
  const c3 = new AbortController()
  c3.abort()
  const t3 = Date.now()
  await sleep(Number.NaN, c3.signal) // 不应抛错；signal 已 aborted 所以立即返回
  await sleep(Infinity, c3.signal)
  await sleep('abc', c3.signal)
  await sleep(-5, c3.signal) // 负值 → Math.max(0, -5)=0，不抛错

  // 负毫秒边界：无 signal 时 sleep(-5) 应等价于 sleep(0)，快速返回（不挂死）
  const tNeg = Date.now()
  await sleep(-5)
  const negElapsed = Date.now() - tNeg
  assert.ok(negElapsed < 500, `sleep(-5) 应等价于 sleep(0) 快速返回，实际 ${negElapsed}ms`)

  // 默认值边界：sleep(NaN) 无 signal 时应使用默认 10000ms——用 50ms 后 abort 验证
  // （若默认值失效变成 0ms，会在 abort 之前就返回，断言失败）
  const c3b = new AbortController()
  const t3b = Date.now()
  setTimeout(() => c3b.abort(), 50)
  await sleep(Number.NaN, c3b.signal)
  const defaultElapsed = Date.now() - t3b
  assert.ok(defaultElapsed >= 40, `sleep(NaN) 应使用默认 10000ms 并在 50ms 后被 abort，实际 ${defaultElapsed}ms（若 <40ms 说明默认值未生效）`)
  assert.ok(defaultElapsed < 500, `sleep(NaN) 不应过度等待，实际 ${defaultElapsed}ms`)

  // ===== runLoop：run 非函数返回 rejected Promise（async 函数）=====
  // timeout 保护：若守卫失效（如被变异删掉），runLoop 会进入无限循环挂死；
  // 用 Promise.race 确保 2s 内必须 reject，否则判定为挂死失败。
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 挂死超时（${ms}ms）`)), ms))
  ])
  await assert.rejects(() => withTimeout(runLoop('not-a-function'), 2000, 'runLoop(string)'), /runLoop 需要函数|挂死超时/, '非函数 run 应 reject')
  await assert.rejects(() => withTimeout(runLoop(123), 2000, 'runLoop(number)'), /runLoop 需要函数|挂死超时/, '数字 run 应 reject')
  await assert.rejects(() => withTimeout(runLoop(null), 2000, 'runLoop(null)'), /runLoop 需要函数|挂死超时/, 'null run 应 reject')

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

  // ===== runLoop：onInterval 超时触发 runBounded INTERVAL_REFRESH_TIMEOUT =====
  const c8 = new AbortController()
  let runs8 = 0
  let timeoutErrors = 0
  await runLoop(async () => {
    runs8 += 1
    if (runs8 === 2) c8.abort()
  }, {
    intervalMs: 0,
    refreshEvery: 1,
    signal: c8.signal,
    onIntervalTimeoutMs: 50, // 较短超时（CI 环境留余量，避免 CPU jitter 导致 flaky）
    onInterval: async () => { await sleep(200) }, // 长时间运行，必然超时
    onIntervalError: async (e) => {
      if (e && e.code === 'INTERVAL_REFRESH_TIMEOUT') timeoutErrors += 1
    }
  })
  assert.ok(timeoutErrors >= 1, `onInterval 超时应触发 INTERVAL_REFRESH_TIMEOUT，实际 ${timeoutErrors} 次`)

  // ===== runLoop：onInterval 运行期间 abort 触发 runBounded ABORT_ERR =====
  // #24 修复：原用例 setTimeout(abort, 20) 延迟过短，在 CI 高负载下可能在 onInterval
  // 真正开始前就触发 abort（走"预先 abort"路径，while 循环条件直接退出），与注释所述不符。
  // 修复：① 延长 abort 到 80ms（onInterval sleep 200ms，确保已在运行）；
  //       ② 添加 onIntervalStarted 标记，验证 onInterval 确实被执行过；
  //       ③ 断言 abortErrors >= 1 且 onIntervalStarted === true，双重验证路径正确。
  const c9 = new AbortController()
  let runs9 = 0
  let abortErrors = 0
  let onIntervalStarted = false
  await runLoop(async () => {
    runs9 += 1
    if (runs9 === 1) setTimeout(() => c9.abort(), 80) // 80ms 后 abort，确保 onInterval（200ms）已在运行
  }, {
    intervalMs: 0,
    refreshEvery: 1,
    signal: c9.signal,
    onIntervalTimeoutMs: 10000, // 很长的超时，避免超时干扰
    onInterval: async () => { onIntervalStarted = true; await sleep(200) }, // 标记已开始 + 长时间运行等待 abort
    onIntervalError: async (e) => {
      if (e && e.code === 'ABORT_ERR') abortErrors += 1
    }
  })
  assert.ok(onIntervalStarted, 'onInterval 应确实被执行过（非预先 abort 路径）')
  assert.ok(abortErrors >= 1, `onInterval 运行期间 abort 应触发 ABORT_ERR，实际 ${abortErrors} 次`)

  console.log('test_loop_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
