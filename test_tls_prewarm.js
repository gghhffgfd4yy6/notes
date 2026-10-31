'use strict'

const assert = require('assert')

const gotPath = require.resolve('got')
let headCalls = 0
const fakeGot = {
  stream: {},
  async head () {
    headCalls += 1
    return { statusCode: headCalls === 1 ? 200 : 500 }
  },
  async get () {
    throw new Error('模拟 GET 预热失败')
  }
}
require.cache[gotPath] = { id: gotPath, filename: gotPath, loaded: true, exports: fakeGot };

(async () => {
  const { prewarmTls } = require('./xbk_agents')
  const result = await prewarmTls('tls-probe.invalid', 100, 2)
  assert.strictEqual(result.count, 2)
  assert.strictEqual(result.okCount, 1)
  assert.strictEqual(result.ok, false, '部分连接失败时 aggregate ok 必须为 false')
  assert.strictEqual(result.perConnectionMs.length, 2)
  console.log('✅ TLS 预热 aggregate ok 与 okCount 保持一致')

  // ===== AGENTS-10：got 替身无 stream（无法建连）必须报 ok:false，不得 ok:true 假成功 =====
  // 旧口径：`if (!got.stream) return { …, skipped: true, ok: true }` —— 一次请求都没发却报成功，
  // 聚合统计（ok=true 而 okCount=0）自相矛盾。restore 后继续后续用例。
  {
    const savedStream = fakeGot.stream
    delete fakeGot.stream
    const noStream = await prewarmTls('tls-probe.invalid', 100, 2)
    fakeGot.stream = savedStream
    assert.strictEqual(noStream.skipped, true, '无 stream 时应标记 skipped')
    assert.strictEqual(noStream.ok, false, '未建连必须报 ok:false（旧口径为 ok:true 假成功）')
    assert.strictEqual(noStream.okCount, 0, '未建连时 okCount 应为 0')
    assert.strictEqual(noStream.kind, 'tls', '应带 kind=tls（AGENTS-07）')
    console.log('✅ AGENTS-10：got.stream 缺失时不建连，ok 为 false 而非假成功')
  }

  // ===== AGENTS-03：count 边界钳制（NaN / Infinity / 非数字一律 ≥1）=====
  // 后续用例不再依赖上面按调用序返回 200/500 的 head：改为「HEAD 恒成功」，
  // 使 okCount 能直接反映实际建连条数（NaN 旧行为返回空数组 → ok:true/okCount:0）。
  fakeGot.head = async () => ({ statusCode: 200 })
  fakeGot.get = async () => ({ statusCode: 200 })

  const nanResult = await prewarmTls('tls-probe.invalid', 100, Number.NaN)
  assert.strictEqual(nanResult.count, 1, 'count=NaN 应钳制为 1（旧行为为空数组 count=0）')
  assert.strictEqual(nanResult.okCount, 1, 'count=NaN 必须真的建 1 条连接（旧行为 okCount=0 却报 ok:true）')
  assert.strictEqual(nanResult.ok, true, 'count=NaN 钳为 1 且建连成功时 aggregate ok 应为 true')
  assert.strictEqual(nanResult.perConnectionMs.length, 1, 'count=NaN 只应有 1 条连接耗时')

  // Infinity 旧行为：Array.from({ length: Infinity }) 抛 RangeError，prewarmTls 整体 reject
  let infResult = null
  let infError = null
  try {
    infResult = await prewarmTls('tls-probe.invalid', 100, Infinity)
  } catch (error) {
    infError = error
  }
  assert.strictEqual(infError, null, 'count=Infinity 不应再抛 RangeError（应钳为 1）')
  assert.strictEqual(infResult && infResult.count, 1, 'count=Infinity 应钳制为 1 条连接')
  assert.strictEqual(infResult && infResult.okCount, 1, 'count=Infinity 钳为 1 后应完成 1 条连接')

  // ===== AGENTS-03 补充：非数字字符串同样钳为 1（“NaN/Infinity/非数字一律钳制为 1”的类型无关性）=====
  // 旧行为：Math.floor('abc') = NaN → Array.from({length: NaN}) = []（不建连却报 ok:true/count:0）。
  const nanStrResult = await prewarmTls('tls-probe.invalid', 100, 'abc')
  assert.strictEqual(nanStrResult.count, 1, "count='abc' 应钳制为 1（旧行为为空数组 count=0）")
  assert.strictEqual(nanStrResult.okCount, 1, "count='abc' 必须真的建 1 条连接（旧行为 okCount=0 却报 ok:true）")
  assert.strictEqual(nanStrResult.ok, true, "count='abc' 钳为 1 且建连成功时 aggregate ok 应为 true")

  console.log('✅ TLS 预热 count 边界钳制（NaN/Infinity/非数字 → 1）')

  // ===== AGENTS-03 上界：超大 count 必须钳到上界，而不是抛 RangeError（更不能真开海量连接）=====
  // 旧行为（改动前）：守卫只排除了非有限值，10^10 / 2^32 原样传给 Array.from({ length }) →
  //   RangeError: Invalid array length，prewarmTls 整体 reject（调用方按 ok/okCount 取值，
  //   异常会变成未处理的 rejection）。
  // 大数写成表达式而非裸字面量：规避 Codacy PMD「数值字面量在运行时会有不同取值」误报。
  for (const huge of [10 ** 10, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    let hugeError = null
    let hugeResult = null
    try {
      hugeResult = await prewarmTls('tls-probe.invalid', 100, huge)
    } catch (error) {
      hugeError = error
    }
    assert.strictEqual(hugeError, null, `count=${huge} 不应抛 RangeError（应钳到上界后再建连）`)
    assert.strictEqual(hugeResult && hugeResult.count, 64, `count=${huge} 应钳到上界 64`)
    assert.strictEqual(hugeResult && hugeResult.okCount, 64, `count=${huge} 应实际完成 64 条连接`)
    assert.strictEqual(hugeResult && hugeResult.perConnectionMs.length, 64, `count=${huge} 只应有 64 条连接耗时`)
  }
  // 反向断言：上界不能顺手收紧既有合法用途（仓内调用方 window ≤10、qinglong ≤3）
  const exactUpper = await prewarmTls('tls-probe.invalid', 100, 64)
  assert.strictEqual(exactUpper.count, 64, 'count=64 恰为上界时应原样采用（边界取闭区间）')
  const withinWindow = await prewarmTls('tls-probe.invalid', 100, 10)
  assert.strictEqual(withinWindow.count, 10, '仓内调用方的 count=10 不得被上界影响')
  assert.strictEqual(withinWindow.okCount, 10, 'count=10 应实际完成 10 条连接')
  console.log('✅ TLS 预热 count 上界钳制（1e10/2^32/MAX_SAFE_INTEGER → 64，且不收紧 ≤64 的合法值）')

  // ===== AGENTS-06：GET 回退被 abort 的 cancelled 分支 —— 可执行覆盖 + 公开契约特征化 =====
  // xbk_agents.js:193（外层 catch 的 GET 回退分支里新增的 signal.aborted 判断）只在下面这种时序被走到：
  // HEAD 抛错（进入外层 catch）时 signal 尚未 abort（:186 为假），随后 GET 回退期间才 abort 并抛错
  // （:191 捕获 → :193 为真），返回 per-connection 的 { ok:false, cancelled:true }。
  //
  // 已知结论（上一轮评审已确认）：该 per-connection 对象在 prewarmTls 的公开返回值（:200-207）上被丢弃
  // ——aggregate 只映射 hostname/count/ok/okCount/elapsedMs/perConnectionMs，cancelled 与 error 均不传播；
  // 调用方（xbk_app.js:871 及 :1440-1469 / qinglong/xbk_push.js:169）也只读 ok/okCount/count/elapsedMs/skipped。
  // 因此「单纯回退 :193」不会让任何断言变红——这一不可观测性无法被消除，本组断言把它固化为可执行的
  // 特征化契约（而不是留一条「无覆盖」的注释）：
  //   ① 结构证明：本用例确实走到 :193（HEAD 发起时未 abort；只有 GET 回退抛错时才 abort），
  //      branch/line 覆盖不再空缺；
  //   ② 行为底线：abort 期间的回退失败绝不能被 aggregate 当成成功（ok=false / okCount=0）；
  //   ③ 现状记录：cancelled 分支与 error 分支产出的公开结果在全部公开字段上一致，aggregate 公开形状里
  //      不含 per-connection 的 cancelled/error。
  // ②③ 是「改了行为就必须改测试」的护栏：一旦有人把 cancelled 暴露到 aggregate（正是 AGENTS-06 的修法），
  // ③ 的形状断言会立刻变红，不会再出现「改了行为却零测试覆盖」的盲区。
  const abortedAc = new AbortController()
  let abortedAtHead = null
  let headCalls06 = 0
  let getCalls06 = 0
  fakeGot.head = async () => {
    headCalls06 += 1
    abortedAtHead = abortedAc.signal.aborted
    throw new Error('HEAD 不被支持')
  }
  fakeGot.get = async () => {
    getCalls06 += 1
    abortedAc.abort() // 关键时序：abort 落在 GET 回退期间，而非 HEAD 之前（否则停在 :186）
    const err = new Error('aborted')
    err.code = 'ERR_CANCELED'
    throw err
  }
  const cancelledAgg = await prewarmTls('tls-probe.invalid', 100, 1, abortedAc.signal)
  // ① 结构证明：本用例命中 :193，而不是 :186（外层 catch 已 abort）或 :173/:180（405 回退分支）
  assert.strictEqual(headCalls06, 1, 'AGENTS-06 用例应先发起 1 次 HEAD')
  assert.strictEqual(abortedAtHead, false, 'HEAD 发起时必须尚未 abort，否则会停在 :186 走不到 :193')
  assert.strictEqual(getCalls06, 1, 'AGENTS-06 用例应经外层 catch 恰好回退 1 次 GET')
  assert.strictEqual(abortedAc.signal.aborted, true, 'GET 回退期间应已 abort')
  // ② 行为底线：回退被取消 ≠ 建连成功
  assert.strictEqual(cancelledAgg.ok, false, 'GET 回退被 abort 时 aggregate ok 必须为 false')
  assert.strictEqual(cancelledAgg.okCount, 0, 'GET 回退被 abort 时 aggregate okCount 必须为 0')
  assert.strictEqual(cancelledAgg.count, 1, '被取消的连接尝试仍应计入 count')

  // 对照组：同一路径但全程不 abort → 走 :194 的 error 分支
  const erroredAc = new AbortController()
  fakeGot.head = async () => { throw new Error('HEAD 不被支持') }
  fakeGot.get = async () => { throw new Error('模拟 GET 预热失败') }
  const erroredAgg = await prewarmTls('tls-probe.invalid', 100, 1, erroredAc.signal)
  assert.strictEqual(erroredAgg.ok, false, 'GET 回退普通失败时 aggregate ok 同样为 false')
  assert.strictEqual(erroredAgg.okCount, 0, 'GET 回退普通失败时 aggregate okCount 同样为 0')
  // ③ 现状记录：两条分支的公开结果逐字段一致
  // 显式比较函数：键集比对需要确定性排序（SonarJS S2871 也要求 sort() 必须传比较函数）；
  // 这里用码元序而非 localeCompare，避免测试结果随宿主 locale 变化。
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  assert.deepStrictEqual(
    Object.keys(cancelledAgg).sort(byCodeUnit),
    ['count', 'elapsedMs', 'hostname', 'kind', 'ok', 'okCount', 'perConnectionMs'],
    'aggregate 公开形状（AGENTS-07 已补 kind）：若新增 cancelled/error 等字段（即修 AGENTS-06），必须同步更新本测试'
  )
  // AGENTS-07：aggregate 必须带显式任务类型 kind:'tls'（调用方按字段即可区分 DNS/TLS 预热结果）
  assert.strictEqual(cancelledAgg.kind, 'tls', 'aggregate 应带 kind=tls（AGENTS-07）')
  assert.strictEqual(erroredAgg.kind, 'tls', 'aggregate 应带 kind=tls（AGENTS-07）')
  assert.deepStrictEqual(Object.keys(erroredAgg).sort(byCodeUnit), Object.keys(cancelledAgg).sort(byCodeUnit), 'cancelled 分支与 error 分支的公开结果键集应一致')
  assert.strictEqual(cancelledAgg.ok, erroredAgg.ok, 'cancelled 分支与 error 分支的 ok 应一致')
  assert.strictEqual(cancelledAgg.okCount, erroredAgg.okCount, 'cancelled 分支与 error 分支的 okCount 应一致')
  assert.strictEqual(cancelledAgg.count, erroredAgg.count, 'cancelled 分支与 error 分支的 count 应一致')
  assert.strictEqual(cancelledAgg.perConnectionMs.length, 1, 'cancelled 分支应仍产出 1 条 per-connection 耗时')
  assert.strictEqual(erroredAgg.perConnectionMs.length, 1, 'error 分支应仍产出 1 条 per-connection 耗时')
  assert.ok(!('cancelled' in cancelledAgg), 'aggregate 当前不暴露 per-connection 的 cancelled（AGENTS-06 现状，修形状时同步改本测试）')
  assert.ok(!('error' in cancelledAgg), 'aggregate 当前不暴露 per-connection 的 error（AGENTS-06 现状，修形状时同步改本测试）')

  console.log('✅ TLS 预热 GET 回退 cancelled 分支：可执行覆盖 + 公开契约特征化（不可观测性已由断言记录）')

  // ===== C10-073：预热 GET 回退的响应体上限 =====
  // 缺陷形状（改动前）：await got.get(...) 会把整个响应体读进内存——预热只为建连、正文一点不需要，
  // 而 got@11 没有 maxResponseSize，xbk_http 的 20MB 上限只覆盖 fetchJson ⇒ 此路径零上限
  // （× 最多 64 条连接）。实测 got@11 的 afterResponse 钩子**不能**拦下响应体（8MB 响应体照样被读完），
  // 故只能走 got.stream 逐块累计。三条判据：
  //   ① 上限口径必须与 xbk_http.DEFAULT_MAX_BODY 一致（不新造数字）；
  //   ② 未超限必须读到 end（不读完 socket 回不回 keep-alive 池，预热就白做了）；
  //   ③ 超限必须 destroy 且立刻结算（不挂死），且 destroy 后冒出的 premature-close error 不得炸进程。
  {
    const { EventEmitter } = require('node:events')
    const { PREWARM_BODY_CAP } = require('./xbk_agents')
    assert.strictEqual(PREWARM_BODY_CAP, require('./xbk_http').DEFAULT_MAX_BODY,
      '预热响应体上限必须与 xbk_http 的 DEFAULT_MAX_BODY 同口径（两处写死同一个数就算红）')
    assert.ok(PREWARM_BODY_CAP > 0 && Number.isFinite(PREWARM_BODY_CAP), '上限必须是有限正数')

    const runWithStream = async (behave) => {
      const calls = { get: 0, destroy: 0, data: 0 }
      const stream = new EventEmitter()
      stream.destroy = () => {
        calls.destroy += 1
        // 真实 got.stream 在 destroy 后会冒 ERR_STREAM_PREMATURE_CLOSE：必须被消费掉
        setImmediate(() => stream.emit('error', Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })))
      }
      const savedStream = fakeGot.stream
      const savedHead = fakeGot.head
      fakeGot.stream = { get: () => { calls.get += 1; setImmediate(() => behave(stream, calls)); return stream } }
      fakeGot.head = async () => { throw new Error('HEAD 不被支持') }
      try {
        const agg = await prewarmTls('tls-probe.invalid', 100, 1)
        return { agg, calls }
      } finally {
        fakeGot.stream = savedStream
        fakeGot.head = savedHead
      }
    }

    // ② 未超限：读到 end、不 destroy ⇒ 连接可回池，按成功计
    const under = await runWithStream((stream, calls) => {
      calls.data += 1
      stream.emit('data', Buffer.alloc(64 * 1024))
      stream.emit('end')
    })
    assert.strictEqual(under.calls.get, 1, '应恰好发起 1 次预热 GET')
    assert.strictEqual(under.calls.destroy, 0, '未超限时不得 destroy（destroy 会让 socket 报废、预热失去意义）')
    assert.strictEqual(under.agg.okCount, 1, '未超限的预热应记为建连成功')
    assert.strictEqual(under.agg.ok, true, '未超限时 aggregate ok 应为 true')

    // ③ 超限：destroy 一次、立刻结算（不挂死），仍按「建连成功」计（TLS 握手已经完成）
    const over = await runWithStream((stream) => {
      stream.emit('data', Buffer.alloc(PREWARM_BODY_CAP + 1))
      // 故意不 emit 'end'：实现必须靠 destroy 分支自己结算，否则本用例会挂到超时
    })
    assert.strictEqual(over.calls.destroy, 1, '超限必须 destroy 一次并停止读取')
    assert.strictEqual(over.agg.okCount, 1, '超限只是不读正文：TLS 握手已完成，仍应计为建连成功')
    assert.strictEqual(over.agg.ok, true, '超限时 aggregate ok 应为 true（不把建连成功报成失败）')

    // ④ 流错误：按失败计（未建连）
    const failed = await runWithStream((stream) => {
      stream.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }))
    })
    assert.strictEqual(failed.agg.okCount, 0, 'GET 流错误时不得记为建连成功')
    assert.strictEqual(failed.agg.ok, false, 'GET 流错误时 aggregate ok 必须为 false')

    console.log('✅ C10-073：预热 GET 有体量上限（口径同 DEFAULT_MAX_BODY / 未超限读到 end / 超限 destroy 即结算 / 流错误按失败计）')
  }
})().catch(error => {
  console.error(error)
  process.exit(1)
})
