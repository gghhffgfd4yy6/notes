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
    ['count', 'elapsedMs', 'hostname', 'ok', 'okCount', 'perConnectionMs'],
    'aggregate 公开形状（AGENTS-07 记录）：若新增 cancelled/error 等字段（即修 AGENTS-06），必须同步更新本测试'
  )
  assert.deepStrictEqual(Object.keys(erroredAgg).sort(byCodeUnit), Object.keys(cancelledAgg).sort(byCodeUnit), 'cancelled 分支与 error 分支的公开结果键集应一致')
  assert.strictEqual(cancelledAgg.ok, erroredAgg.ok, 'cancelled 分支与 error 分支的 ok 应一致')
  assert.strictEqual(cancelledAgg.okCount, erroredAgg.okCount, 'cancelled 分支与 error 分支的 okCount 应一致')
  assert.strictEqual(cancelledAgg.count, erroredAgg.count, 'cancelled 分支与 error 分支的 count 应一致')
  assert.strictEqual(cancelledAgg.perConnectionMs.length, 1, 'cancelled 分支应仍产出 1 条 per-connection 耗时')
  assert.strictEqual(erroredAgg.perConnectionMs.length, 1, 'error 分支应仍产出 1 条 per-connection 耗时')
  assert.ok(!('cancelled' in cancelledAgg), 'aggregate 当前不暴露 per-connection 的 cancelled（AGENTS-06 现状，修形状时同步改本测试）')
  assert.ok(!('error' in cancelledAgg), 'aggregate 当前不暴露 per-connection 的 error（AGENTS-06 现状，修形状时同步改本测试）')

  console.log('✅ TLS 预热 GET 回退 cancelled 分支：可执行覆盖 + 公开契约特征化（不可观测性已由断言记录）')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
