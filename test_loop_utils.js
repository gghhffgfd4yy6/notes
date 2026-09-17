'use strict'

const assert = require('assert')
const { runLoop, sleep, refreshTimeoutError } = require('./xbk_loop')

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

  // ===== XL-01 回归：非 AbortSignal 的真值 signal 不得抛错、更不得留下未捕获异常 =====
  // 反例（改动前）：sleep(10, {}) 在 executor 里调 signal.addEventListener 抛 TypeError →
  // Promise reject；而定时器已调度，10ms 后 done() 又调 signal.removeEventListener 二次抛错，
  // 这次落在定时器回调里成为未捕获异常（uncaughtException）直接终止进程。
  // 断言分两层：① await 不得 reject；② await 期间真实等到约 10ms（说明定时器正常走完，
  // 反例里定时器回调抛错会让进程在 await 之后崩掉，即本套件整体变红）。
  // `{ aborted: true }`（qodo PR #151-2）：只有同名属性、没有可听接口，不得被当成「已取消」
  // 而跳过等待——否则调用方的重试/轮询间隔凭空消失，常驻循环退化为空转。
  for (const bogus of [{}, { aborted: false }, { aborted: true }, 42, 'signal-string', { addEventListener: 1 }]) {
    const tBogus = Date.now()
    await sleep(10, bogus)
    const bogusElapsed = Date.now() - tBogus
    assert.ok(bogusElapsed >= 5, `非信号真值 ${JSON.stringify(bogus)} 应仍按毫秒正常等待，实际 ${bogusElapsed}ms`)
  }

  // ===== qodo PR #151-4：单轮刷新超时文案必须报**生效**的毫秒数，而不是被钳制前的配置值 =====
  // 反例（改动前）：配置 onIntervalTimeoutMs=1e12 时看门狗在 2147483647ms 就响，文案却写 1000000000000ms。
  {
    const plain = refreshTimeoutError(5000)
    assert.strictEqual(plain.message, '常驻刷新超过 5000ms 未完成', '未钳制时文案与既有格式逐字一致')
    assert.strictEqual(plain.code, 'INTERVAL_REFRESH_TIMEOUT', '错误码不变')
    const capped = refreshTimeoutError(1e12)
    assert.ok(capped.message.includes('2147483647ms 未完成'), `超上限时应报生效值，实际：${capped.message}`)
    assert.ok(capped.message.includes('配置请求 1000000000000ms'), `应标注被钳制前的配置请求值，实际：${capped.message}`)
    assert.strictEqual(capped.code, 'INTERVAL_REFRESH_TIMEOUT', '钳制分支错误码同样不变')
  }

  // ===== XL-02 回归：毫秒值超过 setTimeout 上限（2^31-1）必须钳制后再交给 Node =====
  // 反例（改动前）：sleep(1e12) 把 1e12 原样交给 setTimeout，Node 静默降为 1ms——
  // 「等一天」变成立即返回，常驻间隔语义反转。这里以 setTimeout 实参为观测点。
  {
    const realSetTimeout = global.setTimeout
    const capturedMs = []
    const pendingBounds = []
    global.setTimeout = function (fn, ms, ...rest) {
      capturedMs.push(ms)
      return realSetTimeout(fn, ms, ...rest)
    }
    try {
      for (const huge of [1e12, 2 ** 31, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER]) {
        const cUpper = new AbortController()
        pendingBounds.push(sleep(huge, cUpper.signal))
        cUpper.abort() // 立即取消，避免真的挂上 24.8 天的定时器
      }
    } finally {
      global.setTimeout = realSetTimeout
    }
    await Promise.all(pendingBounds)
    assert.deepStrictEqual(
      capturedMs,
      [2147483647, 2147483647, 2147483647, 2147483647],
      `超上限毫秒值必须钳到 2^31-1 再交给 setTimeout，实际 ${JSON.stringify(capturedMs)}`
    )
  }

  // ===== runLoop：run 非函数返回 rejected Promise（async 函数）=====
  // timeout 保护：若守卫失效（如被变异删掉），runLoop 会进入无限循环挂死；
  // 用 Promise.race 确保 2s 内必须 reject，否则判定为挂死失败。
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} 挂死超时（${ms}ms）`)), ms))
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

  // ===== runLoop：未传 onError 时单轮异常必须留下默认诊断日志（XL-04）=====
  // 生产改动 xbk_loop.js:71-73：默认 onError 由 `() => {}` 改为打印
  //   "常驻循环单轮失败（调用方未提供 onError）: <message>"
  // 捕获方式：同步打桩 process.stderr.write（console.error 持有同一 stderr 对象，
  // 每次调用动态取 .write，因此打桩后写入会同步进入数组，不依赖 pipe 的异步刷新）。
  const captureStderr = async fn => {
    const chunks = []
    const originalWrite = process.stderr.write
    process.stderr.write = function (chunk) { chunks.push(String(chunk)); return true }
    try { await fn() } finally { process.stderr.write = originalWrite }
    return chunks.join('')
  }
  // 默认诊断行统一由「调用方未提供 on?Error」标记识别（onError 与 onIntervalError 各有独立默认处理器）
  const defaultLogLines = text => text.split('\n').filter(line => line.includes('调用方未提供 on'))

  const c10 = new AbortController()
  let runs10 = 0
  const stderr10 = await captureStderr(async () => {
    await runLoop(async () => {
      runs10 += 1
      if (runs10 === 1) throw new Error('no-onError-probe')
      c10.abort()
    }, { intervalMs: 0, signal: c10.signal })
  })
  assert.strictEqual(runs10, 2, '默认 onError 记录日志后循环应继续到下一轮')
  assert.deepStrictEqual(defaultLogLines(stderr10), ['常驻循环单轮失败（调用方未提供 onError）: no-onError-probe'],
    '未传 onError 时单轮异常必须留下默认诊断日志（回退成空实现会静默吞掉）')

  // 抛出非 Error 值：默认处理器不得打印 undefined，应回落到 String(error)
  const c11 = new AbortController()
  let runs11 = 0
  const stderr11 = await captureStderr(async () => {
    await runLoop(async () => {
      runs11 += 1
      if (runs11 === 1) throw 'plain-string-probe' // eslint-disable-line no-throw-literal -- 故意抛非 Error 值验证回落分支
      c11.abort()
    }, { intervalMs: 0, signal: c11.signal })
  })
  assert.deepStrictEqual(defaultLogLines(stderr11), ['常驻循环单轮失败（调用方未提供 onError）: plain-string-probe'],
    '非 Error 抛值应回落 String(error)，不能打印 undefined')

  // 传了 onError：调用调用方处理器，且不得打印默认诊断行
  const c12 = new AbortController()
  let runs12 = 0
  const customOnErrorSeen = []
  const stderr12 = await captureStderr(async () => {
    await runLoop(async () => {
      runs12 += 1
      if (runs12 === 1) throw new Error('custom-onError-probe')
      c12.abort()
    }, {
      intervalMs: 0,
      signal: c12.signal,
      onError: async error => { customOnErrorSeen.push(error.message) }
    })
  })
  assert.deepStrictEqual(customOnErrorSeen, ['custom-onError-probe'], '传了 onError 应调用调用方的处理器')
  assert.strictEqual(defaultLogLines(stderr12).length, 0, '传了 onError 时不得打印默认诊断行')

  // 边界：未传 onIntervalError 时刷新失败由**独立**默认处理器留日志（不再回落到 onError——
  // XL-05 要求解耦；且 onError 默认文案是「单轮失败」，用在预热失败上属错误归因）
  const c13 = new AbortController()
  let runs13 = 0
  const stderr13 = await captureStderr(async () => {
    await runLoop(async () => {
      runs13 += 1
      if (runs13 === 2) c13.abort()
    }, {
      intervalMs: 0,
      refreshEvery: 1,
      signal: c13.signal,
      onInterval: async () => { throw new Error('refresh-default-probe') }
    })
  })
  assert.strictEqual(runs13, 2, '默认 onIntervalError 记录日志后循环仍应继续')
  assert.deepStrictEqual(defaultLogLines(stderr13), ['常驻循环性能预热失败（调用方未提供 onIntervalError）: refresh-default-probe'],
    '未传 onIntervalError 时刷新失败应留下独立来源标注的诊断日志，不得误标为「单轮失败」')

  console.log('✅ 常驻循环工具：未传 onError 时单轮异常留默认诊断日志，传了则不打印且仍调用调用方处理器；刷新失败走 onIntervalError 独立默认处理器（不与业务失败混淆）')

  console.log('test_loop_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
