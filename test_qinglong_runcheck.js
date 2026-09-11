'use strict'

// 青龙 --check 诊断入口：runCheck 函数的各种通过/失败场景
const assert = require('assert')
const path = require('node:path')
const Module = require('node:module')
const { runCheck } = require('./qinglong/xbk_push')

// 通过 require.cache mock xbk_sendNotify_slim（runCheck 内部动态 require）
const notifyPath = require.resolve('./xbk_sendNotify_slim')
const origNotify = require.cache[notifyPath]

function mockNotify (count) {
  require.cache[notifyPath] = { exports: { configuredChannelCount: () => count } }
}

function restoreNotify () {
  require.cache[notifyPath] = origNotify
}

// 环境探测 mock：runCheck 内部真实校验 Node 版本 / got / re2（qinglong/xbk_push.js:30-39），
// 裸环境（Node<22 或缺 got/re2）下"全部通过"用例必然返回 1。这里临时伪装成健康环境，
// 只覆盖 runCheck 的返回码聚合逻辑，使该用例在裸环境可确定性通过；返回后完整还原。
function withHealthyEnv (fn) {
  const origRequire = Module.prototype.require
  const versionsDesc = Object.getOwnPropertyDescriptor(process, 'versions')
  Module.prototype.require = function (id, ...rest) {
    if (id === 'got') return {}
    if (id === 're2') return class { test () { return true } }
    return origRequire.call(this, id, ...rest)
  }
  Object.defineProperty(process, 'versions', { value: { ...versionsDesc.value, node: '22.0.0' }, configurable: true })
  try {
    return fn()
  } finally {
    Module.prototype.require = origRequire
    Object.defineProperty(process, 'versions', versionsDesc)
  }
}

// #26 修复：捕获 runCheck 的 console.log 输出，用于区分具体哪个检查失败（而非只断返回码）
function captureRunCheck (app) {
  const lines = []
  const origLog = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    const code = runCheck(app)
    return { code, output: lines.join('\n') }
  } finally {
    console.log = origLog
  }
}

function makeApp (overrides = {}) {
  return {
    validateConfig: overrides.validateConfig || (() => []),
    init: overrides.init || (() => {}),
    Config: {
      filter: overrides.filter || {},
      keyword: { zkt_gjc: overrides.zkt_gjc || '' },
      cache: { dir: overrides.cacheDir || path.join(__dirname, '.test-cache') }
    }
  }
}

;(async () => {
  // ===== 全部通过 → 返回 0 =====
  // Node 版本/got/re2 三项环境探测用 mock 伪装为健康环境，避免裸环境（Node<22、无 got/re2）下必然失败
  mockNotify(1)
  const code0 = withHealthyEnv(() => runCheck(makeApp()))
  assert.strictEqual(code0, 0, '全部检查通过应返回 0')
  restoreNotify()

  // ===== validateConfig 返回警告 → 返回 1，且输出中"过滤配置"为 ❌ =====
  mockNotify(1)
  const rWarn = captureRunCheck(makeApp({ validateConfig: () => ['warning1', 'warning2'] }))
  assert.strictEqual(rWarn.code, 1, '过滤配置有警告应返回 1')
  assert.ok(rWarn.output.includes('❌ 过滤配置'), '失败项应为"过滤配置"，输出应含 ❌ 过滤配置')
  assert.ok(rWarn.output.includes('2 条警告'), '应显示 2 条警告')
  restoreNotify()

  // ===== init() 抛错 → 返回 1，且输出中"缓存目录"为 ❌ =====
  mockNotify(1)
  const rInitFail = captureRunCheck(makeApp({ init: () => { throw new Error('cache init failed') } }))
  assert.strictEqual(rInitFail.code, 1, '缓存目录初始化失败应返回 1')
  assert.ok(rInitFail.output.includes('❌ 缓存目录'), '失败项应为"缓存目录"，输出应含 ❌ 缓存目录')
  assert.ok(rInitFail.output.includes('cache init failed'), '应包含 init 错误信息')
  restoreNotify()

  // ===== 通知通道为 0 → 返回 1，且输出中"通知通道"为 ❌ =====
  mockNotify(0)
  const rNoChannel = captureRunCheck(makeApp())
  assert.strictEqual(rNoChannel.code, 1, '无可用通知通道应返回 1')
  assert.ok(rNoChannel.output.includes('❌ 通知通道'), '失败项应为"通知通道"，输出应含 ❌ 通知通道')
  assert.ok(rNoChannel.output.includes('未检测到完整通道配置'), '应显示未检测到通道配置')
  restoreNotify()

  // ===== notify 无 configuredChannelCount 方法 → 返回 1（count=0）=====
  require.cache[notifyPath] = { exports: {} }
  const codeNoMethod = runCheck(makeApp())
  assert.strictEqual(codeNoMethod, 1, 'notify 无 configuredChannelCount 方法应返回 1')
  restoreNotify()

  console.log('test_qinglong_runcheck OK')
})().catch((e) => { console.error(e); process.exit(1) })
