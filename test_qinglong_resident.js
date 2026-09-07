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
  const abortedSignal = { aborted: true }
  await refreshConnections(makeApp('https://api.example.com/push'), abortedSignal)
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
  await runResident(appPerm, ctrl2)
  assert.strictEqual(ctrl2.signal.aborted, true, 'permanent 错误应触发 controller.abort()')
  assert.strictEqual(runCalls, 1, 'permanent 错误后应停止，只调用 1 次')

  // 3. 可重试失败后成功：第一次返回全失败 summary（retryable），第二次成功
  process.env.XBK_RETRY_BACKOFF_CAP_MS = '10' // 极短退避，加速测试
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
  delete process.env.XBK_RETRY_BACKOFF_CAP_MS

  console.log('test_qinglong_resident OK')
})().catch((e) => { console.error(e); process.exit(1) })
