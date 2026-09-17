'use strict'

// 定时器毫秒上界（XL-02）：Node 的 setTimeout 上限是 2^31-1，超界会被静默降为 1ms
// （TimeoutOverflowWarning）。毫秒配置一旦放大（如误填 1e12），「等一小时」就变成立即返回，
// 常驻间隔语义反转、循环空转。三处 setTimeout 消费者（runBounded 超时、sleep、runLoop
// 间隔）统一经此钳制；下界沿用既有的 0，非有限值回落到各自的历史默认（sleep 为 10000）。
// 写成表达式而非裸字面量：与 scripts/mutation-json.js 的 MAX_STRING_LENGTH 同款写法，
// 规避 Codacy PMD「数值字面量在运行时会有不同取值」的误报（值仍精确为 2147483647）。
const MAX_TIMER_MS = 2 ** 31 - 1

function clampTimerMs (ms, fallback = 10000) {
  const value = Number.isFinite(ms) ? ms : fallback
  return Math.min(MAX_TIMER_MS, Math.max(0, value))
}

// 取消信号的唯一判定：只有**真正可监听**（有函数型 addEventListener）的值才算 signal。
// 非信号的普通真值对象（如 `{ aborted: true }`、`{ aborted: false }`）一律视为「未提供取消信号」。
// 这是三处消费者（runBounded / sleep / runLoop）必须共用的同一口径：若某处凭同名属性判定，
// 就会出现「sleep 忽略它、runLoop 却因它跳过整轮 run」这类互相矛盾的行为
// （qodo PR #151-2 / CodeRabbit PR #151 outside-diff）。
function isAbortable (value) {
  return !!value && typeof value.addEventListener === 'function'
}

// 单轮刷新超时错误：文案必须报**实际生效**的毫秒数（clampTimerMs 之后的定时器长度）。
// 直接回显配置值会让运维看到「超过 1000000000000ms 未完成」而看门狗其实在 2147483647ms
// 就响了——一个不可能发生的时长（qodo PR #151-4）。被钳制时额外标注配置请求值，便于定位误填。
function refreshTimeoutError (requestedMs) {
  const effectiveMs = clampTimerMs(requestedMs)
  const error = new Error(
    effectiveMs === requestedMs
      ? `常驻刷新超过 ${effectiveMs}ms 未完成`
      : `常驻刷新超过 ${effectiveMs}ms 未完成（配置请求 ${requestedMs}ms，超出 setTimeout 上限已钳制）`
  )
  error.code = 'INTERVAL_REFRESH_TIMEOUT'
  return error
}

function runBounded (task, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer // eslint-disable-line prefer-const -- 声明与赋值分离（setTimeout 回填），let 语义清晰
    let settled = false
    const childController = typeof AbortController === 'function' ? new AbortController() : null
    const childSignal = childController ? childController.signal : signal
    const relayAbort = () => {
      if (childController && !childController.signal.aborted) childController.abort()
    }
    const cleanup = () => {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onAbort = () => {
      relayAbort()
      const error = new Error('常驻刷新已取消')
      error.code = 'ABORT_ERR'
      finish(reject, error)
    }
    timer = setTimeout(() => {
      relayAbort()
      finish(reject, refreshTimeoutError(timeoutMs))
    }, clampTimerMs(timeoutMs))
    if (isAbortable(signal)) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    Promise.resolve()
      .then(() => task(childSignal))
      .then(value => finish(resolve, value), error => finish(reject, error))
  })
}

// 长驻运行调度器：一次进程内重复执行 run，复用主模块、got、Agent、DNS 缓存和连接池。
// 调用方负责提供 AbortSignal；停止信号会在当前 run 完成后退出，不强杀正在进行的推送。
// XL-06：run() 既无单轮超时也不接收 signal，单轮挂起时 runLoop 无法响应停止信号（进程无法优雅退出）。
// 引入单轮看门狗会改变推送结果语义（可能产生半推/重复推），属设计决策，已登记 defer。
function sleep (ms, signal) {
  // XL-01：signal 原先只做真值判断——非 AbortSignal 的真值对象（如 {}）会让下面的
  // addEventListener 抛 TypeError；定时器此刻已调度，回调里再调 removeEventListener 会
  // 二次抛错，成为定时器回调中的未捕获异常并终止进程（runBounded 早有 typeof 守卫，
  // 此处对齐）。守卫同时覆盖摘除侧，避免只堵一半。
  const canListen = isAbortable(signal)
  // qodo PR #151-2：aborted 早退同样必须以 canListen 为前提。否则 `{ aborted: true }` 这种
  // 「只有同名属性、没有可听接口」的形状会被当成「已取消」而整个跳过等待，调用方的重试/轮询
  // 间隔凭空消失（常驻循环退化为空转）。真正的 AbortSignal 恒有 addEventListener，行为不变。
  if (canListen && signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, clampTimerMs(ms))
    function done () {
      clearTimeout(timer)
      if (canListen && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', done)
      resolve()
    }
    if (canListen) signal.addEventListener('abort', done, { once: true })
  })
}

async function runLoop (run, options = {}) {
  if (typeof run !== 'function') throw new TypeError('runLoop 需要函数作为 run 参数')
  // CodeRabbit PR #151（outside-diff）：入口就把 options.signal 归一成「真信号或 null」。
  // 否则 `{ aborted: true }` 这类非信号真值对象会让 `while (!(signal && signal.aborted))`
  // 直接为假——整轮 run 一次都不跑；而同一对象在 sleep 里已被判为非信号（会正常等待），
  // 两条路径的取消规则互相矛盾。归一后全函数（while 条件、break、传给 sleep/runBounded）
  // 只看同一个值，口径与 isAbortable 一致；真实 AbortSignal 行为不变。
  const signal = isAbortable(options.signal) ? options.signal : null
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 0 ? options.intervalMs : 10000
  const refreshEvery = Number.isInteger(options.refreshEvery) && options.refreshEvery > 0 ? options.refreshEvery : 10
  // XL-04：调用方漏传 onError 时，单轮异常不能被空实现静默吞掉（常驻模式下即为无声漏推）。
  // 默认改为打日志保留可观测性，但**不抛出**——抛回会中断常驻循环，属行为变更；
  // 日志即使抛错也不影响循环，因为调用点（下方 try/catch）已包裹。
  const onError = typeof options.onError === 'function'
    ? options.onError
    : error => { console.error(`常驻循环单轮失败（调用方未提供 onError）: ${error && error.message ? error.message : String(error)}`) }
  // XL-05：默认值**不再回落到 onError**——回落会把性能预热失败重新耦合进业务失败处理，
  // 且新默认 onError 的文案是「单轮失败」，用在预热失败上属错误归因（本轮自查发现）。
  // 独立默认同样只打日志、不抛出，并如实标注来源为性能预热。
  const onIntervalError = typeof options.onIntervalError === 'function'
    ? options.onIntervalError
    : error => { console.error(`常驻循环性能预热失败（调用方未提供 onIntervalError）: ${error && error.message ? error.message : String(error)}`) }
  const onInterval = typeof options.onInterval === 'function' ? options.onInterval : null
  const onIntervalTimeoutMs = Number.isFinite(options.onIntervalTimeoutMs) && options.onIntervalTimeoutMs > 0
    ? options.onIntervalTimeoutMs
    : 10000
  let cycle = 0
  // eslint-disable-next-line no-unmodified-loop-condition -- signal 由外部 abort 修改（等待中断信号是有意设计）
  while (!(signal && signal.aborted)) {
    try {
      await run()
    } catch (error) {
      try { await onError(error) } catch (ignored) { /* 错误记录不能阻止下一轮 */ }
    }
    cycle += 1
    if (signal && signal.aborted) break
    const intervalTask = sleep(intervalMs, signal)
    const refreshTask = onInterval && cycle % refreshEvery === 0
      ? runBounded(refreshSignal => onInterval({ cycle, signal: refreshSignal }), onIntervalTimeoutMs, signal)
        .catch(async error => {
          try { await onIntervalError(error) } catch (ignored) { /* 刷新失败不能阻止下一轮 */ }
        })
      : Promise.resolve()
    await Promise.all([intervalTask, refreshTask])
  }
}

module.exports = { runLoop, sleep, refreshTimeoutError, isAbortable }
