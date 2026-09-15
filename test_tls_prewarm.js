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

  // ===== AGENTS-06（本文件无法断言，已记入 problems）=====
  // 外层 catch 的 GET 回退分支新增 signal.aborted 检查（xbk_agents.js:193），但它只改 per-connection
  // 结果对象，而 prewarmTls 的 aggregate 返回值（:200-207）只映射 elapsedMs/ok，不传播 cancelled/error；
  // 任何调用方（xbk_app.js / qinglong/xbk_push.js）也只读 ok/okCount/count/hostname。
  // 因此「回退该行」不会改变任何可观测输出，写不出「回退即红」的断言——故此处不写空断言。

  console.log('✅ TLS 预热 count 边界钳制（NaN/Infinity → 1）')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
