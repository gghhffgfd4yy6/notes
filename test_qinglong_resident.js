'use strict'

// 青龙常驻入口：refreshConnections（DNS/TLS 预热）+ runResident（常驻循环/失败退避）
const assert = require('assert')
const { refreshConnections, runResident } = require('./qinglong/xbk_push')

// ===== refreshConnections：mock agents/notify =====
const agentsPath = require.resolve('./xbk_agents')
const notifyPath = require.resolve('./xbk_sendNotify_slim')
const origAgents = require.cache[agentsPath]
const origNotify = require.cache[notifyPath]

function mockDeps (hasWx) {
  const state = { dnsHosts: [], tlsHosts: [] }
  require.cache[agentsPath] = {
    exports: {
      prewarmDns: async (host) => { state.dnsHosts.push(host); return { hostname: host, ok: true } },
      prewarmTls: async (host, timeout, count) => { state.tlsHosts.push(host); return { okCount: count, count } }
    }
  }
  require.cache[notifyPath] = {
    exports: { hasWxPusherConfigured: () => hasWx }
  }
  return state
}

function restoreDeps () {
  require.cache[agentsPath] = origAgents
  require.cache[notifyPath] = origNotify
}

function makeApp (pushUrl) {
  return {
    Config: { api: { pushUrl }, push: { parallelLimit: 1, maxPerRun: 1 } },
    num: (v, d) => d
  }
}

// ===== runResident：mock app.run =====
function makeResidentApp (runFn) {
  return {
    num: () => 10, // 极短 interval，加速测试
    Config: { push: { parallelLimit: 1, maxPerRun: 1 } },
    run: runFn
  }
}

;(async () => {
  // ---------- refreshConnections ----------
  // 1. signal.aborted → 直接返回，不调用任何预热
  let state = mockDeps(false)
  const abortedController = new AbortController()
  abortedController.abort()
  await refreshConnections(makeApp('https://api.example.com/push'), abortedController.signal)
  assert.strictEqual(state.dnsHosts.length, 0, 'signal.aborted 时不应预热 DNS')
  assert.strictEqual(state.tlsHosts.length, 0, 'signal.aborted 时不应预热 TLS')
  restoreDeps()

  // 2. pushUrl 无效 → apiHost=''，不预热任何 DNS
  state = mockDeps(false)
  await refreshConnections(makeApp('not-a-url'), null)
  assert.strictEqual(state.dnsHosts.length, 0, 'pushUrl 无效时不应预热 DNS')
  restoreDeps()

  // 3. pushUrl 有效 + hasWxPusher=false → 只预热 apiHost DNS
  state = mockDeps(false)
  await refreshConnections(makeApp('https://api.example.com/push'), null)
  assert.strictEqual(state.dnsHosts.length, 1, '无 wx 时应只预热 1 个 DNS')
  assert.strictEqual(state.dnsHosts[0], 'api.example.com', '应预热 apiHost DNS')
  assert.strictEqual(state.tlsHosts.length, 0, '无 wx 时不应预热 TLS')
  restoreDeps()

  // 4. pushUrl 有效 + hasWxPusher=true → 预热 apiHost DNS + wx DNS + wx TLS
  state = mockDeps(true)
  await refreshConnections(makeApp('https://api.example.com/push'), null)
  assert.strictEqual(state.dnsHosts.length, 2, '有 wx 时应预热 2 个 DNS（apiHost + wx）')
  assert.strictEqual(state.dnsHosts[0], 'api.example.com', '第一个应是 apiHost DNS')
  assert.strictEqual(state.dnsHosts[1], 'wxpusher.zjiecode.com', '第二个应是 wx DNS')
  assert.strictEqual(state.tlsHosts.length, 1, '有 wx 时应预热 1 个 TLS')
  assert.strictEqual(state.tlsHosts[0], 'wxpusher.zjiecode.com', '应预热 wx TLS')
  restoreDeps()

  // ---------- runResident ----------
  // 1. 正常运行：app.run() 成功，短 interval，setTimeout abort
  let runCalls = 0
  const appOk = makeResidentApp(async () => {
    runCalls++
    return { total: 1, pushed: 1, failed: 0 }
  })
  const ctrl1 = new AbortController()
  setTimeout(() => ctrl1.abort(), 80)
  await runResident(appOk, ctrl1)
  assert.ok(runCalls >= 1, `正常运行应至少调用 1 次 app.run，实际 ${runCalls}`)

  // 2. permanent 错误：app.run() throw failureKind='permanent' → controller.abort()
  runCalls = 0
  const appPerm = makeResidentApp(async () => {
    runCalls++
    const err = new Error('test permanent failure')
    err.failureKind = 'permanent'
    err.failureReason = 'TEST_PERMANENT'
    throw err
  })
  const ctrl2 = new AbortController()
  // C5-015：看门狗。permanent 分支一旦回归（判定被破坏 ⇒ 循环永不退出、runLoop 无轮次上限），
  // 这里的 await 永不 settle，套件只能挂到 CI 的 job 级 45min（node 矩阵两档各挂一次）；
  // run_tests.js 的 TEST_TIMEOUT 也就不到这条 CI 路径（test.yml 直接跑 npm run test:qinglong-resident）。
  // 超时即 abort（让回归的循环有机会停下，而不是留一个空转的重试循环）并判红。
  // clearTimeout 必须成对放在 finally：否则超时用例留下一个活定时器，同进程聚合执行会被拖住
  // （C5-017 那类定时器泄漏）。
  const PERM_WATCHDOG_MS = 5000
  let permTimer
  try {
    await Promise.race([
      runResident(appPerm, ctrl2),
      new Promise((resolve, reject) => {
        permTimer = setTimeout(() => {
          ctrl2.abort()
          reject(new Error(`runResident 未在 ${PERM_WATCHDOG_MS}ms 内因 permanent 错误退出（已尝试 ${runCalls} 次）：` +
            'permanent 判定疑似回归，循环永不结束（旧实现会挂满 CI job 的 45min）'))
        }, PERM_WATCHDOG_MS)
      })
    ])
  } finally {
    clearTimeout(permTimer)
  }
  assert.strictEqual(ctrl2.signal.aborted, true, 'permanent 错误应触发 controller.abort()')
  assert.strictEqual(runCalls, 1, 'permanent 错误后应停止，只调用 1 次')

  // 3. 可重试失败后成功：第一次返回全失败 summary（retryable），第二次成功
  // ⚠️ env 写/删必须成对且删在 finally：用例中途断言失败时若漏掉清理，同进程聚合执行
  // （变异测试/合并 runner）时后续用例会读到残留的 XBK_RETRY_BACKOFF_CAP_MS，退避上限被污染。
  // 快照恢复口径（Sourcery broader_impact）：若调用方在套件启动前已设该变量，finally 必须
  // 还原其原值而非一律 delete——否则反向剥掉调用方/runner 的既有配置，同样构成泄漏。
  const capMsWasSet = Object.prototype.hasOwnProperty.call(process.env, 'XBK_RETRY_BACKOFF_CAP_MS')
  const capMsOriginal = process.env.XBK_RETRY_BACKOFF_CAP_MS
  process.env.XBK_RETRY_BACKOFF_CAP_MS = '10' // 极短退避，加速测试
  try {
    runCalls = 0
    const appRetry = makeResidentApp(async () => {
      runCalls++
      if (runCalls === 1) return { total: 1, pushed: 0, failed: 1 } // 全失败 → retryable
      return { total: 1, pushed: 1, failed: 0 } // 成功
    })
    const ctrl3 = new AbortController()
    setTimeout(() => ctrl3.abort(), 150)
    await runResident(appRetry, ctrl3)
    assert.ok(runCalls >= 2, `可重试失败后应重试，至少调用 2 次 app.run，实际 ${runCalls}`)
  } finally {
    if (capMsWasSet) process.env.XBK_RETRY_BACKOFF_CAP_MS = capMsOriginal
    else delete process.env.XBK_RETRY_BACKOFF_CAP_MS
  }

  console.log('test_qinglong_resident OK')
})().catch((e) => { console.error(e); process.exit(1) })
