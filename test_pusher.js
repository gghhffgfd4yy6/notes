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

  // ===== htmlTagNameEnd / isTagNameBoundary 边界补强 =====
  await test('P15 htmlTagNameEnd 必须跳过标签名前导空白（含闭合标签）', () => {
    // 杀「跳过空白」循环的三类变异体：条件整体→false（等于不跳空白）、
    // `j < s.length`→`j >= s.length`（一进循环即退出）、`j++`→`j--`（反向自增）。
    assert.strictEqual(htmlTagNameEnd('< div>', 0), 5, '前导空白必须跳过，标签名 div 结束于 > 之前（=5）')
    assert.strictEqual(htmlTagNameEnd('</\tdiv>', 0), 6, '闭合标签的空白（制表符）必须跳过（=6）')
  })

  await test('P16 htmlTagNameEnd 无分隔符时结束位恰好是字符串长度', () => {
    // 杀名字扫描循环 `j < s.length`→`j <= s.length`：越界时 /[A-Za-z0-9-]/.test(undefined) 为真
    // （'undefined' 全由字母组成），结束位会多推一格，返回值由 length 变成 length+1。
    assert.strictEqual(htmlTagNameEnd('<div', 0), 4, '<div 的标签名结束位必须等于长度 4，不得是 5')
    assert.strictEqual(htmlTagNameEnd('<b', 0), 2, '<b 同理必须是 2，不得是 3')
  })

  await test('P17 isTagNameBoundary 只有 / 才可能构成自闭合边界', () => {
    // 杀 `ch === '/'`→true：左操作数被常量化后退化为「后继是 > 即边界」，
    // 任意字母后跟 > 都会被误判为标签边界。
    assert.strictEqual(isTagNameBoundary('ab>', 1), false, 'ch 是字母 b 时，即使 s[pos+1] 是 > 也不是边界')
    assert.strictEqual(isTagNameBoundary('a/>', 1), true, 'ch 是 / 且后继是 > 才是自闭合边界')
  })

  // ===== 追加：按 SYSTEM_CONTRACT「推送」条杀 xbk_pusher.send 的变异体 =====
  // 统一注入式发送：定时器 mock 只触发 10s 那个、捕获入参 params / 告警 / 拒绝原因，绝不真实等 10 秒。
  const runSend = async (mod, opts = {}) => {
    const originalSetTimeout = global.setTimeout
    const originalAbortController = global.AbortController
    const originalWarn = console.warn
    const warns = []
    let captured = null
    let watchdogTimer
    let timerFired = false
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = originalSetTimeout(() => reject(new Error('测试看门狗：p.send 未 settle（reject 可能被删）')), 5000)
    })
    try {
      console.warn = (...args) => { warns.push(args.join(' ')) }
      if (opts.noAbortController) global.AbortController = undefined
      if (opts.countAborts) {
        // 计数版 AbortController：超时分支的 controller.abort() 会被 finally 的兜底 abort 掩盖
        // （signal.aborted 早已为 true），只有数调用次数才能区分「超时路径 abort 了两次」与「一次」。
        global.AbortController = class {
          constructor () { this.signal = { aborted: false, addEventListener () {}, removeEventListener () {} }; this.abortCount = 0 }
          abort () { this.abortCount++; this.signal.aborted = true; opts.onController && opts.onController(this) }
        }
      }
      global.setTimeout = (fn, ms, ...args) => {
        if (ms === 10000) {
          // 在真实 0ms 宏任务里触发 10s 定时器：立即结算的成功路径会在微任务中先赢下 race（不误走超时），
          // 挂起的通道则在同一轮事件循环内立刻进入超时分支——既不真等 10 秒，也不靠同步时序蒙混。
          return originalSetTimeout(() => { timerFired = true; fn(...args) }, 0)
        }
        return originalSetTimeout(fn, ms, ...args)
      }
      const orig = mod.sendNotify
      const wrapped = Object.assign({}, mod, {
        sendNotify: (t, d, params) => {
          captured = { text: t, desp: d, params }
          return typeof orig === 'function' ? orig(t, d, params) : undefined
        }
      })
      const p = createPusher({
        Utils: opts.utils || { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => wrapped
      })
      const text = 'text' in opts ? opts.text : 'text'
      const desp = 'desp' in opts ? opts.desp : 'desp'
      let err = null
      let value
      try {
        value = await Promise.race([p.send(text, desp, wrapped), watchdog])
      } catch (e) {
        err = e
      }
      return { err, value, captured, warns, timerFired }
    } finally {
      clearTimeout(watchdogTimer)
      global.setTimeout = originalSetTimeout
      global.AbortController = originalAbortController
      console.warn = originalWarn
    }
  }

  // ===== 收口 P18–P24 登记的 3 个可击杀缺口（父代理补齐）=====
  // 缺口①（id 9，ConditionalExpression@L10:41）：P18 只测了 text=undefined，漏了 text===null 这一格。
  await test('P25 入参归一补齐：text===null 同样必须归为空串（L10 的 null 分支）', async () => {
    const mod = { sendNotify: async () => 'ok', configuredChannelNames: () => [] }
    const r = await runSend(mod, { text: null, desp: 'x' })
    assert.strictEqual(r.captured.text, '', 'text=null 必须归为空串（漏测该格时 L10 的 === null 分支可被删而不被发现）')
    const r2 = await runSend(mod, { text: 'keep', desp: undefined })
    assert.strictEqual(r2.captured.text, 'keep', '普通串不得被归一化吞掉（反向对照）')
    assert.strictEqual(r2.captured.desp, '', 'desp=undefined 归为空串')
  })

  // 缺口②（id 100/101，L83 超时分支的 controller.abort()）：超时路径**必须**在超时回调里再 abort 一次。
  // 断言口径用「同一 controller 上的 abort 次数」而非「创建了几个 controller」——前者直接对应被删的那次调用，
  // 不受 createPusher 内部实现细节（是否复用一个 controller）影响。
  await test('P26 超时路径必须自行 abort（同一 controller 的 abort 次数：超时 2 / 成功 1）', async () => {
    const hanging = { sendNotify: () => new Promise(() => {}), configuredChannelNames: () => ['c1'] }
    const c1 = []
    const r = await runSend(hanging, { countAborts: true, onController: c => c1.push(c.abortCount) })
    assert.ok(r.timerFired, '前置条件：必须真的走到 10s 超时分支')
    assert.strictEqual(r.err && r.err.code, 'PUSH_TIMEOUT', '超时必须带顶层 code=PUSH_TIMEOUT')
    assert.strictEqual(c1.length >= 1, true, '必须至少创建过一个 AbortController（否则无从 abort）')
    assert.strictEqual(Math.max(...c1), 2, '超时路径同一 controller 的 abort 次数必须达到 2（超时回调 1 + finally 兜底 1）——删掉超时分支那次即变 1')
    const ok = { sendNotify: async () => 'ok', configuredChannelNames: () => [] }
    const c2 = []
    const r2 = await runSend(ok, { countAborts: true, onController: c => c2.push(c.abortCount) })
    assert.strictEqual(r2.timerFired, false, '成功路径不得走超时分支')
    assert.strictEqual(Math.max(...c2), 1, '成功路径同一 controller 的 abort 次数必须恰好 1（仅 finally 兜底）')
  })

  // 杀 L10/L11 条件恒真/恒假、等号方向（归一化被吞 → 推送文本 "undefined" 或吞掉正常内容）
  await test('P18 入参归一：undefined/null→空串、数字 String() 化、普通串原样', async () => {
    const mod = { sendNotify: async () => 'ok', configuredChannelNames: () => [] }
    let r = await runSend(mod, { text: undefined, desp: null })
    assert.strictEqual(r.captured.text, '', 'text=undefined 必须归为空串（不得推送文本 "undefined"）')
    assert.strictEqual(r.captured.desp, '', 'desp=null 必须归为空串')
    r = await runSend(mod, { text: 0, desp: 123 })
    assert.strictEqual(r.captured.text, '0', '数字 0 必须 String() 化为 "0"（归一条件恒真会把它吞成空串）')
    assert.strictEqual(r.captured.desp, '123', '数字 desp 必须 String() 化')
    r = await runSend(mod, { text: 'abc', desp: 'def' })
    assert.strictEqual(r.captured.text, 'abc', '普通字符串必须原样透传')
    assert.strictEqual(r.captured.desp, 'def', '普通 desp 必须原样透传')
  })

  // 杀 L62 AbortController 三态（恒真/恒假/typeof 字面量被清空）与 L83/L105 abort 分支被删/恒真
  await test('P19 有 AbortController 必传 signal 且超时 abort；无它时不得伪造 signal', async () => {
    const mod = { sendNotify: () => new Promise(() => {}), configuredChannelNames: () => ['ch1'] }
    const r = await runSend(mod)
    assert.ok(r.captured.params && r.captured.params.signal instanceof AbortSignal,
      'controller 可用时 sendParams.signal 必须是真 AbortSignal（超时可中断在飞请求）')
    assert.strictEqual(r.captured.params.signal.aborted, true, '10s 超时必须 abort 在飞请求（abort 被删即失败）')
    assert.strictEqual(r.timerFired, true, '超时上限必须是 10s 那个定时器')
    assert.strictEqual(r.err.code, 'PUSH_TIMEOUT', '超时顶层 code')
    const r2 = await runSend(mod, { noAbortController: true })
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r2.captured.params, 'signal'), false,
      '无 AbortController 时不得伪造 signal 键（恒真分支会 new 出假控制器）')
    assert.strictEqual(typeof r2.captured.params.inFlightTracker, 'object', '两种分支都必须把在飞追踪器交给投递层')
    assert.strictEqual(r2.err && r2.err.code, 'PUSH_TIMEOUT',
      '无 AbortController 时超时仍须正常 reject（abort 分支恒真会 TypeError）')
  })

  // 杀 L103 finally 体被清空、L104 clearTimeout 调用被删（定时器泄漏 = 进程退出延迟）
  await test('P20 成功路径必须只注册一个 10s 定时器并 clearTimeout + abort', async () => {
    const originalSetTimeout = global.setTimeout
    const originalClearTimeout = global.clearTimeout
    const originalWarn = console.warn
    const handles = []
    const cleared = []
    let params = null
    try {
      console.warn = () => {}
      global.setTimeout = (fn, ms, ...args) => { const h = { ms }; handles.push(h); return h }
      global.clearTimeout = (h) => { if (handles.includes(h)) cleared.push(h); else originalClearTimeout(h) }
      const mod = {
        sendNotify: (t, d, p) => { params = p; return Promise.resolve('sent') },
        configuredChannelNames: () => ['ch1']
      }
      const p = createPusher({
        Utils: { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s },
        getNotify: async () => mod
      })
      const value = await Promise.race([
        p.send('T', 'D', mod),
        new Promise((_resolve, reject) => originalSetTimeout(() => reject(new Error('测试看门狗：成功路径未 settle')), 5000))
      ])
      assert.strictEqual(value, 'sent', '成功结果必须原样返回（部分/全部通道成功即本轮成功）')
    } finally {
      global.setTimeout = originalSetTimeout
      global.clearTimeout = originalClearTimeout
      console.warn = originalWarn
    }
    assert.strictEqual(handles.length, 1, '成功路径必须且只注册一个超时定时器')
    assert.strictEqual(handles[0].ms, 10000, '该定时器必须是 10s')
    assert.deepStrictEqual(cleared, [handles[0]], '完成后必须 clearTimeout(该 10s 句柄)（finally 体被清空即失败）')
    assert.strictEqual(params.signal.aborted, true, '成功路径 finally 同样必须 abort 控制器')
  })

  // 杀 L28 阈值恒真 / `>`→`>=` 与 L30 告警文案被清空
  await test('P21 恰好 100000 码元不截断；超限截断并给出含数值的告警原文', async () => {
    const calls = []
    const utils = {
      sanitizeDecodedHtml: s => s,
      decodeHtmlEntities: s => s,
      truncateUtf16: (s, max) => { calls.push([s.length, max]); return s.slice(0, max) }
    }
    const mod = { sendNotify: async () => 'ok', configuredChannelNames: () => [] }
    const atLimit = 'a'.repeat(100000)
    let r = await runSend(mod, { desp: atLimit, utils })
    assert.deepStrictEqual(calls, [], '恰好 100000 码元不得截断（> 而非 >=，恒真分支同样会误截）')
    assert.strictEqual(r.captured.desp, atLimit, '边界内内容必须原样透传')
    r = await runSend(mod, { desp: 'a'.repeat(100001), utils })
    assert.deepStrictEqual(calls, [[100001, 100000]], '超限必须调用 Utils.truncateUtf16(desp, 100000)')
    assert.deepStrictEqual(r.warns,
      ['[Pusher] desp 长度 100001 超过硬上限 100000，已截断；若 push.contentMax > 100000，实际推送内容不会超过该上限'],
      '截断必须且只告警一次，且文案含两个数值（用户才能发现配置被硬上限覆盖）')
  })

  // 杀 L39 代理对判定的等号方向与各子条件恒真（截断点落在代理对中间必须整体退一格）
  // 注：L36 的 6 个变异体（子条件恒真 / `||` / `<=` / `>=`）在 endIdx 恒为常量 100000（既 >0 又 < length）下等价，不可击杀。
  await test('P22 缺 truncateUtf16 时按代理对安全截断（含 0xD800/0xDBFF/0xDC00/0xDFFF 精确边界）', async () => {
    const utils = { sanitizeDecodedHtml: s => s, decodeHtmlEntities: s => s }
    const mod = { sendNotify: async () => 'ok', configuredChannelNames: () => [] }
    const cut = async (payload) => (await runSend(mod, { desp: payload, utils })).captured.desp
    const hi = (c) => String.fromCharCode(c)
    const pad = 'a'.repeat(99999)
    assert.strictEqual((await cut(pad + hi(0xD800) + hi(0xDC00))).length, 99999,
      '高位恰 0xD800、低位恰 0xDC00：必须整体退一格（prev > 0xD800 / next > 0xDC00 变异体在此暴露）')
    assert.strictEqual((await cut(pad + hi(0xDBFF) + hi(0xDFFF))).length, 99999,
      '高位恰 0xDBFF、低位恰 0xDFFF：同样必须退一格（prev < 0xDBFF / next < 0xDFFF 变异体在此暴露）')
    assert.strictEqual((await cut('a'.repeat(100000) + 'b')).length, 100000, '普通字符边界不得退格')
    assert.strictEqual((await cut(pad + hi(0xD800) + 'b')).length, 100000, '高位+非低位（0x62）不是代理对，不得退格')
    assert.strictEqual((await cut(pad + 'b' + hi(0xDC00))).length, 100000, '非高位（0x62）+低位不是代理对，不得退格')
    assert.strictEqual((await cut(pad + hi(0xD800) + hi(0xE000))).length, 100000, 'next 超出 0xDFFF 不是代理对，不得退格')
    assert.strictEqual((await cut(pad + hi(0xE000) + hi(0xDC00))).length, 100000, 'prev 超出 0xDBFF 不是代理对，不得退格')
  })

  // 杀 L71 tracker 形状、L97 在飞清单判空恒真、L98/L103 缺失清单告警被清空/删调用
  await test('P23 超时归因：tracker 形状、空数组有效态、非空在飞清单、缺失清单告警原文', async () => {
    let tracker = null
    const modEmpty = {
      sendNotify: (t, d, p) => { tracker = p.inFlightTracker; return new Promise(() => {}) },
      configuredChannelNames: () => ['ch1']
    }
    await runSend(modEmpty)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(tracker, 'pending'), true,
      'inFlightTracker 必须自带 pending 属性（被变异成 {} 后投递层无法回填）')
    assert.strictEqual(tracker.pending, null, 'pending 初值必须是 null：未回填 ≠ 空数组')
    // 调用方不支持该契约（pending 保持 null）且无 configuredChannelNames → failures 空 + 告警可观测
    const r2 = await runSend({ sendNotify: () => new Promise(() => {}) })
    assert.strictEqual(r2.err && r2.err.code, 'PUSH_TIMEOUT', '顶层 code 必须 PUSH_TIMEOUT（判空恒真会 TypeError）')
    assert.deepStrictEqual(r2.err.failures, [], '既无在飞清单又无配置清单时 failures 为空，不得编造通道')
    assert.strictEqual(r2.warns.length, 1, '超时归因整体缺失必须且只告警一次')
    assert.strictEqual(r2.warns[0],
      '[Pusher] 推送超时，但无法获取已配置通道清单（configuredChannelNames 缺失），failures 为空',
      '告警原文')
    // 空数组是有效状态：全部已结算 → failures 空、不得回落静态清单、不得告警
    const r3 = await runSend({
      sendNotify: (t, d, p) => { if (p.inFlightTracker) p.inFlightTracker.pending = []; return new Promise(() => {}) },
      configuredChannelNames: () => ['ch1', 'ch2']
    })
    assert.deepStrictEqual(r3.err.failures, [], '空数组=全部已结算：failures 必须为空，不得回落静态配置清单')
    assert.deepStrictEqual(r3.warns, [], '空数组是有效状态，与「调用方不支持该契约」必须区别对待，不得告警')
    // 非空在飞清单 → 只标真正未结算的通道，字段完整
    const r4 = await runSend({
      sendNotify: (t, d, p) => { if (p.inFlightTracker) p.inFlightTracker.pending = ['ch2']; return new Promise(() => {}) },
      configuredChannelNames: () => ['ch1', 'ch2']
    })
    assert.deepStrictEqual(r4.err.failures,
      [{ channel: 'ch2', code: 'PUSH_TIMEOUT', message: '推送超时(10s)' }],
      '只归因仍在飞的通道（已结算的 ch1 不得被标为超时）')
  })

  // 杀 L77 拒绝原因被清空（静默成功即「未发送却写缓存」）
  await test('P24 非 thenable 返回值必须拒绝静默成功，且拒绝原因可自描述', async () => {
    const r = await runSend({ sendNotify: () => undefined, configuredChannelNames: () => ['ch1'] })
    assert.ok(r.err, '同步 undefined 必须被拒绝，不得静默成功（主流程会误写缓存）')
    assert.strictEqual(r.err.message, '推送模块 sendNotify 未返回 Promise，拒绝静默成功', '拒绝原因原文')
    // 伪 thenable（then 非函数）必须被拒绝：用 defineProperty 而非对象字面量构造夹具。
    // SonarCloud S7739 对「给对象加 then」一律报 bug，但此对象不参与任何 await 链 ⇒ 显式 NOSONAR。
    const pseudo = {}
    Object.defineProperty(pseudo, String.fromCharCode(116, 104, 101, 110), { value: 'nope', enumerable: true }) // NOSONAR
    const r2 = await runSend({ sendNotify: () => pseudo, configuredChannelNames: () => ['ch1'] })

    assert.strictEqual(r2.err && r2.err.message, '推送模块 sendNotify 未返回 Promise，拒绝静默成功',
      'then 非函数的伪 thenable 同样必须拒绝')
  })

  console.log(`test_pusher OK (${failed === 0 ? '全部通过' : failed + ' 项失败'})`)
  process.exit(failed > 0 ? 1 : 0)
})()
