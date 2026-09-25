'use strict'

const assert = require('assert')
const { spawnSync } = require('node:child_process')
const { runLoop, sleep, refreshTimeoutError, isAbortable } = require('./xbk_loop')

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

  // ===== 独立对抗审查 A 组指出的咬合力缺口：sleep 的**摘除侧**守卫此前无断言 =====
  // 鸭子 signal 只有 addEventListener、没有 removeEventListener：若 done() 不守卫 removeEventListener，
  // 回调里抛 TypeError → resolve() 永不执行 → Promise 永久挂起。生产不可达（真 AbortSignal 两者俱全），
  // 但注释里宣称的「守卫同时覆盖摘除侧」必须有断言支撑，否则被变异掉也不会有测试变红。
  {
    const duckNoRemove = { aborted: false, addEventListener: () => {} }
    await Promise.race([
      sleep(10, duckNoRemove),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('sleep 在缺 removeEventListener 的 signal 上挂死')), 2000))
    ])
  }

  // ===== CodeRabbit PR #151（outside-diff）：runLoop 与 sleep 必须共用同一套取消判定 =====
  // 旧实现 runLoop 写 `const signal = options.signal || null`，于是 `{ aborted: true }` 会让
  // `while (!(signal && signal.aborted))` 直接为假——整轮 run 一次都不跑；而同一对象在 sleep 里
  // 已被判为非信号（会正常等待）。两条路径的取消规则互相矛盾。
  assert.strictEqual(isAbortable({ aborted: true }), false, '只有同名属性、无可听接口的对象不算信号')
  assert.strictEqual(isAbortable({ aborted: false }), false, '非信号真值对象不算信号')
  assert.strictEqual(isAbortable({ addEventListener: 1 }), false, 'addEventListener 非函数不算信号')
  assert.strictEqual(isAbortable(null), false, 'null 不算信号')
  assert.strictEqual(isAbortable(42), false, '原始值不算信号')
  assert.strictEqual(isAbortable(new AbortController().signal), true, '真实 AbortSignal 必须算信号')
  // 集成证据：非信号真值不得让 runLoop 跳过整轮 run。放子进程里跑并用 stdout 回调收尾——
  // 归一为非信号后该循环不会再自行退出（旧实现则一次都不跑），父进程另设超时兜底防挂死。
  {
    const probe = `
      const { runLoop } = require(${JSON.stringify(require.resolve('./xbk_loop'))})
      let n = 0
      runLoop(() => { n += 1; if (n === 3) process.stdout.write('RUNS=' + n + '\\n', () => process.exit(0)) },
        { signal: { aborted: true }, intervalMs: 0 })
    `
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 5000 })
    assert.ok(String(r.stdout || '').includes('RUNS=3'),
      `非信号真值 {aborted:true} 不得让 runLoop 跳过整轮 run（stdout=${JSON.stringify(r.stdout)} signal=${r.signal} status=${r.status}）`)
  }
  // 反向断言：真正可监听的 signal（含鸭子类型）必须仍被接受——aborted 翻转后当轮结束即退出。
  // 若 isAbortable 被写成恒 false，上面的子进程会通过，但这里会因循环不退出而被 withTimeout 判挂死。
  {
    const duck = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }
    let duckRuns = 0
    const withTimeoutDuck = (p, ms) => Promise.race([
      p,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`runLoop(duck) 挂死超时（${ms}ms）`)), ms))
    ])
    await withTimeoutDuck(runLoop(async () => { duckRuns += 1; duck.aborted = true }, { signal: duck, intervalMs: 0 }), 2000)
    assert.strictEqual(duckRuns, 1, '可监听 signal 的 aborted 翻转后应只跑一轮即退出')
  }

  // ===== qodo PR #151-4：单轮刷新超时文案必须报**生效**的毫秒数，而不是被钳制前的配置值 =====
  // 反例（改动前）：配置 onIntervalTimeoutMs=10^12 时看门狗在 2^31-1 ms 就响，文案却写配置原值。
  // 大数一律写成表达式而非裸字面量：规避 Codacy PMD「数值字面量在运行时会有不同取值」误报
  // （与 xbk_loop.js 的 MAX_TIMER_MS / scripts/mutation-json.js 同款处理）。
  {
    const plain = refreshTimeoutError(5000)
    assert.strictEqual(plain.message, '常驻刷新超过 5000ms 未完成', '未钳制时文案与既有格式逐字一致')
    assert.strictEqual(plain.code, 'INTERVAL_REFRESH_TIMEOUT', '错误码不变')
    const capped = refreshTimeoutError(10 ** 12)
    assert.ok(capped.message.includes('2147483647ms 未完成'), `超上限时应报生效值，实际：${capped.message}`)
    assert.ok(capped.message.includes('配置请求 1000000000000ms'), `应标注被钳制前的配置请求值，实际：${capped.message}`)
    assert.strictEqual(capped.code, 'INTERVAL_REFRESH_TIMEOUT', '钳制分支错误码同样不变')
    // 归因正确性（独立对抗审查 A 组反例）：非有限值走的是**回落默认**、负值走的是**下界**，
    // 都不是「超上限钳制」——旧文案把三种情况统一说成超出上限，属错误归因、误导运维。
    const nanCase = refreshTimeoutError(Number.NaN)
    assert.ok(nanCase.message.includes('回落默认 10000ms'), `NaN 应报回落默认，实际：${nanCase.message}`)
    assert.ok(!nanCase.message.includes('上限'), `NaN 不得归因为超上限，实际：${nanCase.message}`)
    const negCase = refreshTimeoutError(-5)
    assert.ok(negCase.message.includes('已按 0 处理'), `负值应报按下界处理，实际：${negCase.message}`)
    assert.ok(!negCase.message.includes('上限'), `负值不得归因为超上限，实际：${negCase.message}`)
  }

  // ===== XL-02 回归：毫秒值超过 setTimeout 上限（2^31-1）必须钳制后再交给 Node =====
  // 反例（改动前）：sleep(10^12) 把该值原样交给 setTimeout，Node 静默降为 1ms——
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
      for (const huge of [10 ** 12, 2 ** 31, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER]) {
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
      [2 ** 31 - 1, 2 ** 31 - 1, 2 ** 31 - 1, 2 ** 31 - 1],
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

  // ===== XL-06 反例锁定：停止信号不得中止在飞轮次，也不得开启新一轮（不强杀契约）=====
  // 条目背景：XL-06 报「run() 无超时且不接收 signal，单轮挂起时 runLoop 无法响应停止信号」。
  // 候选修法 A「把停止信号透传进单轮、让轮次内的等待可被取消」经 R4 探针实测**必然引入重复推**：
  // 生产在轮末**一次性**写判重缓存（xbk_app.js:1524 `MessageStore.saveBatch(toCache, cacheName)`），
  // 中途取消 ⇒ 本轮已推消息整批不入缓存 ⇒ 下一轮（或进程重启后）全部重推；取消在飞请求还会产生
  // 「半推」（上游可能已收到、本地未记）。因此这里锁定既有契约：abort 后**当前轮必须跑完**
  // （含轮末缓存写入）、且不得开始第二轮。轮次内等待按生产同构布置，覆盖用户要求的三种触发时点。
  // 打齿方式（同族反例）：把 xbk_loop.js 的 `await run()` 改成 `await run(signal)`（路径 A）后，
  // 下面 round 会响应信号截断 → pushed 不足 3 条 → 断言必红。
  {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
    const waitStage = (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve() }, ms)
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(Object.assign(new Error('轮次被停止信号取消'), { code: 'ABORT_ERR' })) }
      function cleanup () { if (signal) signal.removeEventListener('abort', onAbort) }
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    const items = [1, 2, 3]
    // 触发时点 → abort 毫秒数：轮次前置等待中 / 第 1 条推送后的间隔等待中 / 第 2 条推送在飞
    const triggerPoints = [
      { label: 'signal 在轮次前置等待中触发（尚未推送）', kind: 'pre-push', at: 10 },
      { label: 'signal 在推送间隔等待中触发（已推 1 条）', kind: 'interval', at: 100 },
      { label: 'signal 在推送在飞时触发（第 2 条）', kind: 'in-flight', at: 120 }
    ]
    for (const point of triggerPoints) {
      const controller = new AbortController()
      const log = { pushed: [], cached: false, rounds: 0, inFlight: null }
      const round = async (signal) => {
        log.rounds += 1
        await waitStage(30, signal) // ① 拉取/过滤
        for (const item of items) {
          await waitStage(20, signal) // 推送间隔
          log.inFlight = item
          await waitStage(40, signal) // 推送在飞
          log.inFlight = null
          log.pushed.push(item)
        }
        log.cached = true // ③ 轮末一次性写判重缓存（xbk_app.js:1524 同构）
      }
      const loop = runLoop(round, { signal: controller.signal, intervalMs: 0 })
      setTimeout(() => controller.abort(), point.at)
      await withTimeout(loop, 3000, `XL-06 ${point.kind}`)
      assert.deepStrictEqual(log.pushed, items,
        `${point.label}：停止信号不得截断在飞轮次（截断即半推 + 已推未入缓存 → 下轮重复推）`)
      assert.strictEqual(log.cached, true,
        `${point.label}：轮末判重缓存必须写入，否则本轮已推消息下一轮会重复推`)
      assert.strictEqual(log.rounds, 1,
        `${point.label}：停止后不得开始新一轮（重复推）`)
    }
    console.log('✅ 常驻循环：停止信号不截断在飞轮次（三种时点），轮末缓存照写、不产生重复轮次（XL-06 探针结论锁定）')
    await delay(0)
  }

  // 本地小工具：把「该 settle 却永不 settle」的变异体转成快速失败，而不是只靠 900s 外部超时判负。
  // 计时器必须在 race settle 后清掉：p 先 settle 时原写法仍留着定时器存活，
  // 会把进程多留 ms 毫秒（反复的变异运行逐次累积这段空等）。见 PR #173 评审。
  const withinSettle = (p, ms = 2000) => {
    let timer
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('未在期限内 settle')), ms) })
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
  }

  // L1. clampTimerMs/refreshTimeoutError 的文案分支与上下界：专杀 EqualityOperator
  //     `requestedMs > MAX_TIMER_MS`→`>=`（上界等值被误报「已钳制」）与 `requestedMs < 0`→`<=`（0 被误报非法）。
  {
    const MAX = 2 ** 31 - 1
    assert.strictEqual(refreshTimeoutError(MAX).message, `常驻刷新超过 ${MAX}ms 未完成`, '恰为上界不得出现「已钳制」文案')
    assert.strictEqual(refreshTimeoutError(0).message, '常驻刷新超过 0ms 未完成', '0 是合法下界，不得报「已按 0 处理」')
    assert.strictEqual(refreshTimeoutError(MAX + 1).message, `常驻刷新超过 ${MAX}ms 未完成（配置请求 ${MAX + 1}ms，超出 setTimeout 上限已钳制）`, '越上界必须报钳制')
    assert.strictEqual(refreshTimeoutError(-5).message, '常驻刷新超过 0ms 未完成（配置值 -5ms 非法，已按 0 处理）', '负值必须报按下界处理')
    assert.strictEqual(refreshTimeoutError(Number.POSITIVE_INFINITY).message, '常驻刷新超过 10000ms 未完成（配置值 Infinity 非法，已回落默认 10000ms）', '非有限值必须报回落默认')
  }

  // L2. runLoop 复用 sleep/runBounded 时的监听契约与 cycle 语义（duck signal 可观测）——一次覆盖：
  //     注册的监听必须全部摘除（cleanup 未被清空 / 摘除守卫未被绕过）、事件名与 { once: true } 精确、
  //     预热拿到的是 childController 的 signal（不是父 signal）、refreshEvery=2 只在 cycle 2 触发一次
  //     （`cycle += 1`→`-= 1`、`onInterval && cycle % refreshEvery === 0`、onInterval 参数对象变异体）。
  {
    const added = []
    const removed = []
    const live = new Set()
    const duck = {
      aborted: false,
      addEventListener (ev, fn, opts) { added.push([ev, fn, opts]); live.add(fn) },
      removeEventListener (ev, fn) { removed.push([ev, fn]); live.delete(fn) }
    }
    const cycles = []
    const childSignals = []
    let runs = 0
    const loop = runLoop(async () => {
      runs += 1
      if (runs >= 3) { duck.aborted = true; for (const fn of [...live]) fn() }
    }, {
      intervalMs: 0,
      refreshEvery: 2,
      signal: duck,
      onInterval: async (ctx) => { cycles.push(ctx.cycle); childSignals.push(ctx.signal) }
    })
    await withinSettle(loop)
    assert.strictEqual(runs, 3, '前置：应跑满 3 轮')
    assert.deepStrictEqual(cycles, [2], 'refreshEvery=2 只在 cycle 2 触发一次（cycle 必须递增）')
    assert.strictEqual(childSignals.length, 1, '预热只应触发一次')
    assert.ok(childSignals[0] && childSignals[0] !== duck, '预热必须拿到 childController 的 signal，不得退化成父 signal')
    assert.ok(added.length >= 3, `前置：至少应注册 3 次监听，实际 ${added.length}`)
    assert.strictEqual(removed.length, added.length, '每个注册的监听都必须被摘除（cleanup 未被清空、摘除守卫未被绕过）')
    for (const [ev, fn] of removed) assert.ok(added.some(([e2, f2]) => e2 === ev && f2 === fn), '摘除的必须是注册过的同一函数（事件名/函数被变异会失配）')
    for (const [ev, , opts] of added) {
      assert.strictEqual(ev, 'abort', '只允许注册 abort 事件（StringLiteral 变异体）')
      assert.deepStrictEqual(opts, { once: true }, '监听必须带 { once: true }（ObjectLiteral/BooleanLiteral 变异体）')
    }
    assert.strictEqual(live.size, 0, '退出后不得残留监听')
  }

  // L3. 预热超时路径：错误码/文案精确、超时必须中继 abort 给子 signal、且超时不中断循环——专杀
  //     relayAbort()/cleanup/finish/文案被清空的 CallExpression/BlockStatement/StringLiteral 变异体。
  {
    const ctrl = new AbortController()
    let runs = 0
    let err = null
    let child = null
    let intervalErrors = 0
    const loop = runLoop(async () => { runs += 1; if (runs >= 2) ctrl.abort() }, {
      intervalMs: 0,
      refreshEvery: 1,
      signal: ctrl.signal,
      onIntervalTimeoutMs: 20,
      onInterval: async (ctx) => { child = ctx.signal; return new Promise(() => {}) },
      onIntervalError: async (e) => { intervalErrors += 1; err = e }
    })
    await withinSettle(loop, 4000)
    assert.strictEqual(intervalErrors, 1, '预热超时必须触发 onIntervalError 一次')
    assert.strictEqual(err && err.code, 'INTERVAL_REFRESH_TIMEOUT', '超时错误码须为 INTERVAL_REFRESH_TIMEOUT')
    assert.strictEqual(err && err.message, '常驻刷新超过 20ms 未完成', '超时文案须报实际生效毫秒数')
    assert.strictEqual(child && child.aborted, true, '超时必须把 abort 中继给子 signal')
    assert.strictEqual(runs, 2, '超时不得中断循环（第 2 轮仍执行并由停止信号退出）')
  }

  // L4. 只带 addEventListener 的 duck signal 不得抛错（摘除守卫）——专杀把
  //     `typeof signal.removeEventListener === 'function'` 改成 true/`!==`/'' 的变异体（会去调不存在的方法）。
  {
    const adds = []
    const half = { aborted: false, addEventListener (ev, fn) { adds.push(fn) } }
    let runs = 0
    const loop = runLoop(async () => {
      runs += 1
      if (runs >= 2) { half.aborted = true; for (const fn of adds.slice()) fn() }
    }, { intervalMs: 0, refreshEvery: 1, signal: half, onInterval: async () => {} })
    await withinSettle(loop)
    assert.strictEqual(runs, 2, '无 removeEventListener 的 duck signal 不得让循环抛错')
  }

  // L5. 没有 AbortController 全局时 runBounded 必须退化为「直接用父 signal」且超时路径照常——专杀
  //     `childController && !childController.signal.aborted` 被改成 true / `||`（会读 null.signal 抛错）。
  {
    const saved = globalThis.AbortController
    const ctrl = new AbortController()
    let err = null
    try {
      globalThis.AbortController = undefined
      let runs = 0
      const loop = runLoop(async () => { runs += 1; if (runs >= 2) ctrl.abort() }, {
        intervalMs: 0,
        refreshEvery: 1,
        signal: ctrl.signal,
        onIntervalTimeoutMs: 20,
        onInterval: async () => new Promise(() => {}),
        onIntervalError: async (e) => { err = e }
      })
      await withinSettle(loop, 4000)
      assert.strictEqual(runs, 2, '循环轮次不受影响')
    } finally { globalThis.AbortController = saved }
    assert.strictEqual(err && err.code, 'INTERVAL_REFRESH_TIMEOUT', '无 AbortController 全局时仍须按超时正常 reject')
  }

  // L6. sleep 的监听契约：事件名/options 精确、abort 必须唤醒、done() 必须摘除监听——专杀 sleep 里的
  //     StringLiteral/ObjectLiteral/BooleanLiteral 与 executor/done body 被清空的变异体。
  {
    const added = []
    const removed = []
    const duck = {
      aborted: false,
      addEventListener (ev, fn, opts) { added.push([ev, fn, opts]); setTimeout(() => { duck.aborted = true; fn() }, 5) },
      removeEventListener (ev, fn) { removed.push([ev, fn]) }
    }
    const t0 = Date.now()
    await withinSettle(sleep(10000, duck), 900)
    assert.ok(Date.now() - t0 < 900, 'abort 必须唤醒 sleep，不得等满 10000ms')
    assert.strictEqual(added.length, 1, '只应注册一次监听')
    assert.strictEqual(added[0][0], 'abort', '只注册 abort 事件')
    assert.deepStrictEqual(added[0][2], { once: true }, '监听必须带 { once: true }')
    assert.strictEqual(removed.length, 1, 'done() 必须摘除自己的监听（未被清空）')
    assert.strictEqual(removed[0][1], added[0][1], '摘除同一函数')
  }

  // L7. sleep(0) 必须正常 settle（executor/done body 被清空类变异体会永久挂起）。
  {
    const t0 = Date.now()
    await withinSettle(sleep(0), 600)
    assert.ok(Date.now() - t0 < 600, 'sleep(0) 必须 resolve')
  }

  // L8. runLoop 参数归一：intervalMs=-1 必须回落默认 10000ms（60ms 内只跑 1 轮，不得空转成百上千轮）——
  //     专杀 intervalMs 守卫的 LogicalOperator `&&`→`||` 与 `>= 0` 条件变异体。
  {
    const ctrl = new AbortController()
    let runs = 0
    const loop = runLoop(async () => { runs += 1 }, { intervalMs: -1, signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 60)
    await withinSettle(loop, 3000)
    assert.strictEqual(runs, 1, `intervalMs=-1 必须回落默认 10000ms（60ms 内仅 1 轮），实际 ${runs} 轮`)
  }

  // L9. refreshEvery 非法值（1.5 / 0）必须回落默认 10：11 轮内仍只在 cycle 10 触发一次——专杀
  //     `Number.isInteger(...)`/`> 0` 被改成 true / `>= 0` 的变异体（1.5 会在 3、9 轮触发；0 会永不触发）。
  {
    const invalidRefreshEvery = [1.5, 0]
    for (const bad of invalidRefreshEvery) {
      const ctrl = new AbortController()
      let runs = 0
      const cycles = []
      const loop = runLoop(async () => { runs += 1; if (runs >= 11) ctrl.abort() }, {
        intervalMs: 0,
        refreshEvery: bad,
        signal: ctrl.signal,
        onInterval: async (ctx) => { cycles.push(ctx.cycle) }
      })
      await withinSettle(loop, 4000)
      assert.deepStrictEqual(cycles, [10], `refreshEvery=${bad} 非法必须回落默认 10（只在 cycle 10 触发）`)
    }
  }

  // L10. 未传 onError 时默认实现必须打印，且对非 Error 抛出物按 String 处理（不得读 .message）——专杀
  //      默认文案里 `error && error.message` 的 LogicalOperator/ConditionalExpression 变异体。
  {
    const ctrl = new AbortController()
    const origErr = console.error
    const logged = []
    console.error = (...a) => logged.push(a.join(' '))
    try {
      const nonErr = { code: 'NON_ERROR' }
      let runs = 0
      const loop = runLoop(async () => {
        runs += 1
        if (runs >= 2) ctrl.abort()
        throw nonErr
      }, { intervalMs: 0, signal: ctrl.signal })
      await withinSettle(loop)
    } finally { console.error = origErr }
    assert.deepStrictEqual(logged, [
      '常驻循环单轮失败（调用方未提供 onError）: [object Object]',
      '常驻循环单轮失败（调用方未提供 onError）: [object Object]'
    ], `未传 onError 的错误必须打印且非 Error 按 String 处理，实际 ${JSON.stringify(logged)}`)
  }

  // L11. onInterval 传非函数必须归一为「不预热」而不是被当真处理器调用——专杀
  //      `typeof options.onInterval === 'function'`→true。
  {
    const ctrl = new AbortController()
    let runs = 0
    let intervalErrors = 0
    const loop = runLoop(async () => { runs += 1; if (runs >= 2) ctrl.abort() }, {
      intervalMs: 0,
      refreshEvery: 1,
      signal: ctrl.signal,
      onInterval: 'not-a-function',
      onIntervalError: async () => { intervalErrors += 1 }
    })
    await withinSettle(loop)
    assert.strictEqual(intervalErrors, 0, 'onInterval 非函数必须归一为不预热（不得触发 onIntervalError）')
    assert.strictEqual(runs, 2, '循环轮次不受影响')
  }

  // L12. onIntervalTimeoutMs 非法值（-1 / 0）必须回落默认 10000ms，而不是让预热立刻超时——专杀
  //      `> 0`→`>= 0`、`&&`→`||` 两类变异体。
  {
    const invalidTimeoutMs = [-1, 0]
    for (const bad of invalidTimeoutMs) {
      const ctrl = new AbortController()
      let runs = 0
      let refreshed = 0
      let intervalErrors = 0
      const loop = runLoop(async () => { runs += 1; if (runs >= 2) ctrl.abort() }, {
        intervalMs: 0,
        refreshEvery: 1,
        signal: ctrl.signal,
        onIntervalTimeoutMs: bad,
        onInterval: async () => { refreshed += 1; await sleep(20) },
        onIntervalError: async () => { intervalErrors += 1 }
      })
      await withinSettle(loop, 4000)
      assert.strictEqual(refreshed, 1, `onIntervalTimeoutMs=${bad} 时预热应正常完成一次（20ms 任务不得被判超时）`)
      assert.strictEqual(intervalErrors, 0, `onIntervalTimeoutMs=${bad} 必须回落默认 10000ms`)
    }
  }

  console.log('test_loop_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
