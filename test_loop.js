'use strict'

const assert = require('assert')
const { runLoop } = require('./xbk_loop');

(async () => {
  const controller = new AbortController()
  let runs = 0
  const errors = []
  const refreshes = []
  await runLoop(async () => {
    runs += 1
    if (runs === 1) throw new Error('probe')
    if (runs === 3) controller.abort()
  }, {
    intervalMs: 0,
    refreshEvery: 2,
    signal: controller.signal,
    onInterval: async ({ cycle }) => refreshes.push(cycle),
    onError: async error => errors.push(error.message)
  })
  assert.strictEqual(runs, 3)
  assert.deepStrictEqual(errors, ['probe'])
  assert.deepStrictEqual(refreshes, [2])

  const controller2 = new AbortController()
  let intervalErrors = 0
  let businessErrors = 0
  let runs2 = 0
  await runLoop(async () => {
    runs2 += 1
    if (runs2 === 2) controller2.abort()
  }, {
    intervalMs: 0,
    refreshEvery: 1,
    signal: controller2.signal,
    onInterval: async () => { throw new Error('warmup-only failure') },
    onError: async () => { businessErrors += 1 },
    onIntervalError: async () => { intervalErrors += 1 }
  })
  assert.strictEqual(businessErrors, 0, '性能预热失败不应进入业务失败处理')
  assert.strictEqual(intervalErrors, 1, '性能预热失败应走独立错误处理')
  console.log('✅ 常驻循环：性能刷新失败与业务运行失败隔离')

  const controller3 = new AbortController()
  let refreshTimeout
  let refreshSignal
  await runLoop(async () => {}, {
    intervalMs: 0,
    refreshEvery: 1,
    signal: controller3.signal,
    onIntervalTimeoutMs: 20,
    onInterval: async ({ signal }) => {
      refreshSignal = signal
      return new Promise(() => {})
    },
    onIntervalError: async error => {
      refreshTimeout = error
      controller3.abort()
    }
  })
  assert.strictEqual(refreshTimeout && refreshTimeout.code, 'INTERVAL_REFRESH_TIMEOUT', '刷新挂起应有超时边界')
  assert.strictEqual(refreshSignal && refreshSignal.aborted, true, '刷新超时应取消子刷新信号')
  assert.strictEqual(controller3.signal.aborted, true, '刷新超时后应可安全停止循环')
  console.log('✅ 常驻循环：性能刷新挂起有界，不阻塞停止信号')

  console.log('✅ 常驻循环：单轮异常不中断，停止信号在当前轮结束后生效，定期刷新与等待并行')
})()
