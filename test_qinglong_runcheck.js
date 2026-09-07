'use strict'

// 青龙 --check 诊断入口：runCheck 函数的各种通过/失败场景
const assert = require('assert')
const path = require('node:path')
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
  mockNotify(1)
  const code0 = runCheck(makeApp())
  assert.strictEqual(code0, 0, '全部检查通过应返回 0')
  restoreNotify()

  // ===== validateConfig 返回警告 → 返回 1 =====
  mockNotify(1)
  const codeWarn = runCheck(makeApp({ validateConfig: () => ['warning1', 'warning2'] }))
  assert.strictEqual(codeWarn, 1, '过滤配置有警告应返回 1')
  restoreNotify()

  // ===== init() 抛错 → 返回 1 =====
  mockNotify(1)
  const codeInitFail = runCheck(makeApp({ init: () => { throw new Error('cache init failed') } }))
  assert.strictEqual(codeInitFail, 1, '缓存目录初始化失败应返回 1')
  restoreNotify()

  // ===== 通知通道为 0 → 返回 1 =====
  mockNotify(0)
  const codeNoChannel = runCheck(makeApp())
  assert.strictEqual(codeNoChannel, 1, '无可用通知通道应返回 1')
  restoreNotify()

  // ===== notify 无 configuredChannelCount 方法 → 返回 1（count=0）=====
  require.cache[notifyPath] = { exports: {} }
  const codeNoMethod = runCheck(makeApp())
  assert.strictEqual(codeNoMethod, 1, 'notify 无 configuredChannelCount 方法应返回 1')
  restoreNotify()

  console.log('test_qinglong_runcheck OK')
})().catch((e) => { console.error(e); process.exit(1) })
