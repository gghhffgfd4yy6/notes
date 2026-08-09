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
})().catch(error => {
  console.error(error)
  process.exit(1)
})
