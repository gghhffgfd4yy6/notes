'use strict'

const assert = require('assert')
const path = require('path')
const { runLoop } = require('./xbk_loop')
const { ensureDependencies } = require('./qinglong/xbk_push')

;(async () => {
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

  // --ignore-scripts 会让 re2 缺少原生 .node；got 可加载并不代表过滤规则可用。
  // 入口必须把 re2 当作必需运行依赖检查，缺失时拒绝带着“正则全部跳过”的状态启动。
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 're2') {
        const error = new Error('Cannot find native binding')
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return {}
    },
    env: {}
  }), /re2 依赖或原生模块未完整安装/, 'got 正常但 re2 不可加载时应明确阻止启动')

  const commands = []
  let re2Ready = false
  ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 're2' && !re2Ready) {
        const error = new Error('Native module version mismatch')
        error.code = 'ERR_DLOPEN_FAILED'
        throw error
      }
      return {}
    },
    spawnSyncFn: (cmd, args) => {
      commands.push([cmd, args])
      if (args[0] === 'run' && args[1] === 'rebuild') re2Ready = true
      return { status: 0 }
    },
    env: { XBK_AUTO_INSTALL_DEPS: '1' },
    // QX-04：恢复命令按「仓库根是否有 package-lock.json」选择 ci/install。这里显式注入，
    // 使断言不依赖跑测试时工作区是否存在锁文件（变异沙箱不复制 package-lock.json）。
    lockExists: () => true
  })
  assert.strictEqual(commands.length, 2, '缺模块或 ABI 不匹配时，自动恢复应先安装依赖，再构建 re2 原生模块')
  assert.strictEqual(commands[0][1][0], 'ci', '有 package-lock.json 时恢复必须用冻结安装 npm ci（QX-04）')
  assert.deepStrictEqual(commands[1][1].slice(0, 3), ['run', 'rebuild', '--prefix'])

  const gotOnlyCommands = []
  let gotReady = false
  ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 'got' && !gotReady) {
        const error = new Error('Cannot find module got')
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return {}
    },
    spawnSyncFn: (cmd, args) => {
      gotOnlyCommands.push([cmd, args])
      if (args[0] === 'ci') gotReady = true
      return { status: 0 }
    },
    env: { XBK_AUTO_INSTALL_DEPS: '1' },
    lockExists: () => true
  })
  assert.strictEqual(gotOnlyCommands.length, 1, '仅 got 缺失且 re2 可用时不得触发无关的 re2 构建')
  assert.strictEqual(gotOnlyCommands[0][1][0], 'ci', '有 package-lock.json 时恢复必须用冻结安装 npm ci（QX-04）')
  console.log('✅ 青龙入口：re2 缺失会阻止启动，自动恢复按实际失败依赖构建并复检')

  // XL-04（xbk_loop.js:71-73）：未传 onError 时默认处理器必须每轮打印一行诊断日志且不中断循环。
  // 这里验证「连续多轮失败 → 每轮一行」，与 test_loop_utils.js 的单轮/回落断言互补。
  const controller4 = new AbortController()
  const stderrChunks = []
  const originalStderrWrite = process.stderr.write
  process.stderr.write = function (chunk) { stderrChunks.push(String(chunk)); return true }
  let runs4 = 0
  try {
    await runLoop(async () => {
      runs4 += 1
      if (runs4 <= 2) throw new Error(`default-log-${runs4}`)
      controller4.abort()
    }, { intervalMs: 0, signal: controller4.signal })
  } finally {
    process.stderr.write = originalStderrWrite
  }
  const defaultLogs = stderrChunks.join('').split('\n').filter(line => line.includes('调用方未提供 onError'))
  assert.strictEqual(runs4, 3, '默认 onError 记录日志后常驻循环不应中断')
  assert.deepStrictEqual(defaultLogs, [
    '常驻循环单轮失败（调用方未提供 onError）: default-log-1',
    '常驻循环单轮失败（调用方未提供 onError）: default-log-2'
  ], '未传 onError 时每轮异常都应留下一条默认诊断日志')
  console.log('✅ 常驻循环：未传 onError 时每轮异常留一行诊断日志且不中断')

  console.log('✅ 常驻循环：单轮异常不中断，停止信号在当前轮结束后生效，定期刷新与等待并行')
})()
