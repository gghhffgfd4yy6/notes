'use strict'

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
      const error = new Error(`常驻刷新超过 ${timeoutMs}ms 未完成`)
      error.code = 'INTERVAL_REFRESH_TIMEOUT'
      finish(reject, error)
    }, timeoutMs)
    if (signal && typeof signal.addEventListener === 'function') {
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
function sleep (ms, signal) {
  if (signal && signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, Math.max(0, Number.isFinite(ms) ? ms : 10000))
    function done () {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', done)
      resolve()
    }
    if (signal) signal.addEventListener('abort', done, { once: true })
  })
}

async function runLoop (run, options = {}) {
  if (typeof run !== 'function') throw new TypeError('runLoop 需要函数作为 run 参数')
  const signal = options.signal || null
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 0 ? options.intervalMs : 10000
  const refreshEvery = Number.isInteger(options.refreshEvery) && options.refreshEvery > 0 ? options.refreshEvery : 10
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  const onIntervalError = typeof options.onIntervalError === 'function' ? options.onIntervalError : onError
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

module.exports = { runLoop, sleep }
