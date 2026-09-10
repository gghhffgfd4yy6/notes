'use strict'

// xbk_pusher.js 单元测试：
//   - createPusher.send 超时分支（10s race → abort + PUSH_TIMEOUT failures + reject）
//   - htmlTagNameEnd / isTagNameBoundary 纯函数边界
const assert = require('node:assert')
const { createPusher, htmlTagNameEnd, isTagNameBoundary } = require('./xbk_pusher')

let failed = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log(`  ✅ ${name}`)
  }).catch((e) => {
    failed += 1
    console.error(`  ❌ ${name}: ${e.message}`)
  })
}

;(async () => {
  console.log('test_pusher')

  // ===== 探针：createPusher.send 超时分支 =====
  // 最高风险契约：10s 超时后必须 reject，且 error.failures 含 PUSH_TIMEOUT
  await test('P1 超时 reject 且 failures 含 PUSH_TIMEOUT（探针）', async () => {
    const originalSetTimeout = global.setTimeout
    // 看门狗：若实现 bug 导致超时分支不 settle，5 秒后强制失败而非无限挂起
    let watchdogTimer
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = originalSetTimeout(() => reject(new Error('测试看门狗：p.send 未在预期时间内 settle')), 5000)
    })
    // mock：setTimeout 立即执行回调，模拟 10s 超时已到；同时捕获实现注册的延迟，
    // 显式固化“实现必须基于 10s setTimeout 计时”这一契约——若将来改为 Date.now() 差值计时，
    // 此处注册的延迟将不再是 10000，下方断言会失败，从而杜绝测试假绿。
    let registeredTimeoutMs = null
    global.setTimeout = (fn, ms) => { registeredTimeoutMs = ms; fn(); return originalSetTimeout(() => {}, 0) }
    try {
      const neverResolve = new Promise(() => {})
      const notifyMod = {
        sendNotify: () => neverResolve,
        configuredChannelNames: () => ['ch1', 'ch2']
      }
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => notifyMod,
        looksLikeHtmlLinear: () => false
      })
      let rejected = false
      let err
      try {
        await Promise.race([p.send('text', 'desp', notifyMod), watchdog])
      } catch (e) {
        rejected = true
        err = e
      }
      assert.strictEqual(rejected, true, '超时必须 reject，不能挂起或静默成功')
      assert.ok(err.message.includes('超时'), `error.message 应含"超时"，实际: ${err.message}`)
      assert.ok(Array.isArray(err.failures), 'error.failures 应为数组')
      assert.strictEqual(err.failures.length, 2, 'failures 应包含所有配置通道（2 个）')
      assert.strictEqual(err.failures[0].code, 'PUSH_TIMEOUT', 'failure.code 应为 PUSH_TIMEOUT')
      assert.strictEqual(err.failures[0].channel, 'ch1', 'failure.channel 应对应配置通道名')
      assert.strictEqual(err.failures[1].channel, 'ch2', '第二个通道名应正确')
      assert.strictEqual(registeredTimeoutMs, 10000, '实现必须按 10s 注册超时计时器，否则“超时契约”不成立（若改为 Date.now() 计时，此断言会失败提醒）')
    } finally {
      clearTimeout(watchdogTimer)
      global.setTimeout = originalSetTimeout
    }
  })

  // ===== htmlTagNameEnd 纯函数 =====
  await test('P2 htmlTagNameEnd 正常/自闭合标签', () => {
    assert.strictEqual(htmlTagNameEnd('<div>', 0), 4, '<div> 标签名结束于索引 4')
    assert.strictEqual(htmlTagNameEnd('<br/>', 0), 3, '<br/> 标签名 br 结束于索引 3（指向 /）')
    assert.strictEqual(htmlTagNameEnd('<br />', 0), 3, '<br /> 标签名 br 结束于索引 3（指向空白）')
    assert.strictEqual(htmlTagNameEnd('<h1>', 0), 3, '<h1> 含数字标签名结束于索引 3')
  })

  await test('P3 htmlTagNameEnd 闭合标签含前导空白', () => {
    assert.strictEqual(htmlTagNameEnd('</div>', 0), 5, '</div> 标签名结束于索引 5')
    assert.strictEqual(htmlTagNameEnd('</ div>', 0), 6, '</ div> 含空白时结束于索引 6')
  })

  await test('P4 htmlTagNameEnd 非法标签名返回 -1', () => {
    assert.strictEqual(htmlTagNameEnd('<123>', 0), -1, '数字开头不是合法标签名')
    assert.strictEqual(htmlTagNameEnd('<>', 0), -1, '空标签名返回 -1')
    assert.strictEqual(htmlTagNameEnd('< >', 0), -1, '纯空白后无字母返回 -1')
  })

  await test('P5 htmlTagNameEnd 标签后无合法边界返回 -1', () => {
    // '<div/'：标签名 div 结束于索引 4，s[4]='/' 但 s[5]=undefined → 不是 /> 边界 → -1
    assert.strictEqual(htmlTagNameEnd('<div/', 0), -1, '/ 后无 > 不是自闭合边界')
  })

  // ===== isTagNameBoundary 纯函数 =====
  await test('P6 isTagNameBoundary 各边界字符', () => {
    assert.strictEqual(isTagNameBoundary('<div>', 4), true, '> 是边界')
    assert.strictEqual(isTagNameBoundary('<div ', 4), true, '空白是边界')
    assert.strictEqual(isTagNameBoundary('<br/>', 3), true, '/ 后跟 > 是边界（索引 3 指向 /）')
    assert.strictEqual(isTagNameBoundary('<divx', 4), false, '普通字母不是边界')
    assert.strictEqual(isTagNameBoundary('<div', 4), true, '字符串末尾 undefined 是边界')
  })

  console.log(`test_pusher OK (${failed === 0 ? '全部通过' : failed + ' 项失败'})`)
  process.exit(failed > 0 ? 1 : 0)
})()
