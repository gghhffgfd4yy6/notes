'use strict'

// xbk_pusher.js 单元测试：
//   - createPusher.send 超时分支（10s race → abort + PUSH_TIMEOUT failures + reject）
//   - htmlTagNameEnd / isTagNameBoundary 纯函数边界
const assert = require('node:assert')
const { createPusher, htmlTagNameEnd, isTagNameBoundary, looksLikeHtmlLinear, looksLikeHtmlEnvelope } = require('./xbk_pusher')

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
    // mock：仅立即触发“10000ms 超时定时器”（其余定时器不触发），确保导致 reject 的超时定时器就是它。
    // 若实现改用别的延迟计时，超时分支不会触发、看门狗兜底 → 断言失败，
    // 杜绝“任意 10000ms 定时器蒙混过关”的假绿（回应 sourcery-ai 评审）。
    // 第 3 个及以后参数按 Node 语义原样转发给回调（fn(...args)）。
    // 注意：mock 赋值纳入 try，确保异常时 finally 也能还原 global.setTimeout。
    let timeoutTimerFired = false
    try {
      global.setTimeout = (fn, ms, ...args) => {
        if (ms === 10000) { timeoutTimerFired = true; fn(...args) }
        return originalSetTimeout(() => {}, 0)
      }
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
      assert.strictEqual(timeoutTimerFired, true, '实现必须按 10s 触发超时定时器，且该定时器即 reject 的来源（仅它被触发，杜绝无关定时器蒙混）')
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

  // ===== 出口清洗门槛（审查 P1/S1/F1）=====
  // 门槛必须取宽松包络：严格判定为 false 的载荷（标签名后再跟 < / 引号属性内含 <）在
  // HTML5 tokenizer 下仍会构造出带事件的标签，而 slim 会以 contentType=2 原文送出。
  await test('P7 出口门槛取宽松包络：严格判定为 false 的载荷也必须清洗（fail-closed）', async () => {
    const desp = '<img src=x onerror=alert(1) <2>'
    assert.strictEqual(looksLikeHtmlLinear(desp), false, '严格判定为 false（既有导出语义不变）')
    assert.strictEqual(looksLikeHtmlEnvelope(desp), true, '宽松包络必须命中')
    let received
    const p = createPusher({
      Utils: { sanitizeDecodedHtml: s => 'SAN[' + s + ']', decodeHtmlEntities: s => s },
      getNotify: async () => ({ sendNotify: async (t, d) => { received = d }, configuredChannelNames: () => ['ch1'] })
    })
    await p.send('标题', desp, { sendNotify: async (t, d) => { received = d } })
    assert.strictEqual(received, 'SAN[' + desp + ']', '门槛漏判会让未清洗的主动 HTML 直达客户端')
  })

  await test('P7 出口门槛：无 > 的输入不清洗（既有语义不变）', async () => {
    const desp = '<a '.repeat(1000)
    assert.strictEqual(looksLikeHtmlEnvelope(desp), false, '全文无 > 不是 HTML 形态')
    let received
    const p = createPusher({
      Utils: { sanitizeDecodedHtml: s => 'SAN[' + s + ']', decodeHtmlEntities: s => s },
      getNotify: async () => ({ sendNotify: async (t, d) => { received = d }, configuredChannelNames: () => ['ch1'] })
    })
    await p.send('标题', desp, { sendNotify: async (t, d) => { received = d } })
    assert.strictEqual(received, desp, '纯文本不应被清洗改写')
  })

  // ===== 超时顶层 code（审查 2026-08-15 P3）=====
  // 回归：超时 reject 的 error 必须能自描述。改动前只有 error.failures[].code，
  // 顶层 error.code 为 undefined（failures 为空时更无从判断失败原因是超时）。
  await test('P8 超时 error 顶层 code = PUSH_TIMEOUT（不止 failures 内层）', async () => {
    const originalSetTimeout = global.setTimeout
    let watchdogTimer
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = originalSetTimeout(() => reject(new Error('测试看门狗：p.send 未在预期时间内 settle')), 5000)
    })
    try {
      global.setTimeout = (fn, ms, ...args) => {
        if (ms === 10000) fn(...args)
        return originalSetTimeout(() => {}, 0)
      }
      const notifyMod = {
        sendNotify: () => new Promise(() => {}),
        configuredChannelNames: () => ['ch1']
      }
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => notifyMod
      })
      let err = null
      try {
        await Promise.race([p.send('text', 'desp', notifyMod), watchdog])
      } catch (e) {
        err = e
      }
      assert.ok(err && err.message.includes('超时'), `超时分支必须 reject 且 message 含"超时"，实际: ${err && err.message}`)
      assert.strictEqual(err.code, 'PUSH_TIMEOUT', '顶层 error.code 应为 PUSH_TIMEOUT（回退 P3 后此处为 undefined）')
    } finally {
      clearTimeout(watchdogTimer)
      global.setTimeout = originalSetTimeout
    }
  })

  // ===== 超长 desp 截断（审查 2026-08-15 P4）=====
  // 回归：>100000 时不得再静默 slice——必须走注入的 Utils.truncateUtf16（代理对/ZWJ 安全）
  // 且补一条「配置被硬上限覆盖」告警；回退该改动后 truncateUtf16 不会被调用、也不会有告警。
  await test('P9 desp 超 100000 → 调用 Utils.truncateUtf16 截断并告警（P4）', async () => {
    const spy = { calls: [] }
    const desp = 'a'.repeat(100001)
    let received
    const warns = []
    const originalWarn = console.warn
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      const notifyMod = {
        sendNotify: async (t, d) => { received = d },
        configuredChannelNames: () => ['ch1']
      }
      const p = createPusher({
        Utils: {
          sanitizeDecodedHtml: s => s,
          decodeHtmlEntities: s => s,
          truncateUtf16: (s, max) => { spy.calls.push([s.length, max]); return s.slice(0, max) }
        },
        getNotify: async () => notifyMod
      })
      await p.send('标题', desp, notifyMod)
    } finally {
      console.warn = originalWarn
    }
    assert.deepStrictEqual(spy.calls, [[100001, 100000]],
      '必须调用 Utils.truncateUtf16(desp, 100000)，而不是静默 slice')
    assert.strictEqual(received, 'a'.repeat(100000), '推送内容应被截断到硬上限')
    assert.ok(warns.some(w => w.includes('超过硬上限') && w.includes('100000')),
      `截断必须告警（配置与行为不一致需可观测）；实际 warns=${JSON.stringify(warns)}`)
  })

  await test('P10 Utils 未提供 truncateUtf16 → 退回 slice（不抛错、仍截断）', async () => {
    const desp = 'b'.repeat(100001)
    let received
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const notifyMod = {
        sendNotify: async (t, d) => { received = d },
        configuredChannelNames: () => ['ch1']
      }
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => notifyMod
      })
      await p.send('标题', desp, notifyMod)
    } finally {
      console.warn = originalWarn
    }
    assert.strictEqual(received, 'b'.repeat(100000), '缺 truncateUtf16 时须退回 slice，不能抛错或漏截断')
  })

  // CodeRabbit PR #147 #9：退回分支必须自己做代理对安全截断，不能裸 slice。
  // 跨边界载荷：99999 个 'a' + 代理对 emoji（总长 100001），硬上限 100000 恰落在代理对中间——
  // 裸 slice(0, 100000) 会留下孤立高位代理（半个 emoji 乱码），违反 SYSTEM_CONTRACT 的 UTF-16 安全截断。
  await test('P10b Utils 未提供 truncateUtf16 → 退回截断不得切断代理对（跨边界载荷）', async () => {
    const desp = 'a'.repeat(99999) + '😀'
    assert.strictEqual(desp.length, 100001, '载荷应总长 100001 码元（截断点落在代理对中间）')
    let received
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const notifyMod = {
        sendNotify: async (t, d) => { received = d },
        configuredChannelNames: () => ['ch1']
      }
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => notifyMod
      })
      await p.send('标题', desp, notifyMod)
    } finally {
      console.warn = originalWarn
    }
    assert.strictEqual(typeof received, 'string', '缺 truncateUtf16 时须退回本地截断，不能抛错或漏截断')
    assert.strictEqual(received.length, 99999, '截断点落在代理对中间时须整体退一格，长度为 99999')
    const lastCode = received.charCodeAt(received.length - 1)
    assert.ok(!(lastCode >= 0xD800 && lastCode <= 0xDBFF),
      `末位码元不得是孤立高位代理（实际 0x${lastCode.toString(16)}）——被切断的代理对会渲染成乱码`)
  })

  // ===== 超时归因缺失告警（审查 2026-08-15 P3 零风险半边②）=====
  await test('P11 超时且 configuredChannelNames 缺失 → failures 为空并告警', async () => {
    const originalSetTimeout = global.setTimeout
    let watchdogTimer
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = originalSetTimeout(() => reject(new Error('测试看门狗：p.send 未在预期时间内 settle')), 5000)
    })
    const warns = []
    const originalWarn = console.warn
    try {
      console.warn = (...args) => { warns.push(args.join(' ')) }
      global.setTimeout = (fn, ms, ...args) => {
        if (ms === 10000) fn(...args)
        return originalSetTimeout(() => {}, 0)
      }
      const notifyMod = { sendNotify: () => new Promise(() => {}) } // 刻意不提供 configuredChannelNames
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => notifyMod
      })
      let err = null
      try {
        await Promise.race([p.send('text', 'desp', notifyMod), watchdog])
      } catch (e) {
        err = e
      }
      assert.ok(err && err.message.includes('超时'), `超时分支必须 reject，实际: ${err && err.message}`)
      assert.deepStrictEqual(err.failures, [], '无法取得通道清单时 failures 为空（既有语义不变）')
      assert.ok(warns.some(w => w.includes('configuredChannelNames')),
        `归因整体缺失必须告警；实际 warns=${JSON.stringify(warns)}`)
    } finally {
      clearTimeout(watchdogTimer)
      console.warn = originalWarn
      global.setTimeout = originalSetTimeout
    }
  })

  // ===== P3（跨批协同）超时按「仍在飞的通道」归因 =====
  // 契约：Pusher 把 { inFlightTracker } 交给 sendNotify；投递层（slim）启动通道任务前回填
  // tracker.pending（未结算通道名），每通道 settle 时移除。不支持该契约的模块（既有测试替身）
  // 忽略它 → pending 保持 null → 退回「配置通道全量列出」的既有语义（P1/P11 已锁定）。
  const withTimeoutNow = async (notifyMod, warns) => {
    const originalSetTimeout = global.setTimeout
    let watchdogTimer
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = originalSetTimeout(() => reject(new Error('测试看门狗：p.send 未在预期时间内 settle')), 5000)
    })
    try {
      global.setTimeout = (fn, ms, ...args) => {
        if (ms === 10000) fn(...args)
        return originalSetTimeout(() => {}, 0)
      }
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => notifyMod
      })
      try {
        await Promise.race([p.send('text', 'desp', notifyMod), watchdog])
        return null
      } catch (e) {
        return e
      }
    } finally {
      clearTimeout(watchdogTimer)
      global.setTimeout = originalSetTimeout
    }
  }

  await test('P12 归因只列在飞通道：已结算通道不得被标为 PUSH_TIMEOUT（P3）', async () => {
    let trackerSeen = null
    const notifyMod = {
      sendNotify: (t, d, params) => {
        trackerSeen = params && params.inFlightTracker
        // 模拟 slim：ch1 已成功结算，ch2 仍在飞
        if (trackerSeen) trackerSeen.pending = ['ch2']
        return new Promise(() => {})
      },
      configuredChannelNames: () => ['ch1', 'ch2']
    }
    const err = await withTimeoutNow(notifyMod)
    assert.ok(err && err.message.includes('超时'), '超时分支必须 reject')
    assert.ok(trackerSeen && typeof trackerSeen === 'object', 'Pusher 必须把在飞追踪器交给 sendNotify（跨文件契约）')
    assert.deepStrictEqual(err.failures.map(f => f.channel), ['ch2'],
      `只应归因仍在飞的通道（ch1 已结算），实际 ${JSON.stringify(err.failures)}`)
    assert.strictEqual(err.failures[0].code, 'PUSH_TIMEOUT')
  })

  await test('P13 在飞清单为空数组 → failures 为空且不得误报「清单缺失」告警（P3）', async () => {
    const warns = []
    const originalWarn = console.warn
    try {
      console.warn = (...args) => { warns.push(args.join(' ')) }
      const notifyMod = {
        sendNotify: (t, d, params) => {
          if (params && params.inFlightTracker) params.inFlightTracker.pending = [] // 全部通道已结算
          return new Promise(() => {})
        },
        configuredChannelNames: () => ['ch1', 'ch2'] // 有清单，但必须被在飞清单取代
      }
      const err = await withTimeoutNow(notifyMod)
      assert.ok(err && err.message.includes('超时'), '超时分支必须 reject')
      assert.deepStrictEqual(err.failures, [], '全部已结算时 failures 必须为空（不得回落静态清单）')
      assert.ok(!warns.some(w => w.includes('configuredChannelNames')),
        `有在飞清单时不得误报清单缺失；实际 warns=${JSON.stringify(warns)}`)
    } finally {
      console.warn = originalWarn
    }
  })

  await test('P14 未支持该契约的模块 → 保持既有「配置通道全量列出」语义（P3 回退）', async () => {
    const notifyMod = {
      sendNotify: () => new Promise(() => {}), // 忽略 params（既有替身形态）
      configuredChannelNames: () => ['pushplus', 'telegram']
    }
    const err = await withTimeoutNow(notifyMod)
    assert.ok(err && err.message.includes('超时'), '超时分支必须 reject')
    assert.deepStrictEqual(err.failures.map(f => f.channel), ['pushplus', 'telegram'],
      '不支持在飞契约时必须退回既有语义（test_pusher P1 / test_app 锁定口径）')
  })

  console.log(`test_pusher OK (${failed === 0 ? '全部通过' : failed + ' 项失败'})`)
  process.exit(failed > 0 ? 1 : 0)
})()
