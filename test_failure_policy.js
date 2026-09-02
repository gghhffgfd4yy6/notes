'use strict'

const assert = require('assert')
const {
  classifyFailure,
  classifySummary
} = require('./xbk_failure_policy')
const { runResident, shouldAutoInstallDependencies } = require('./qinglong/xbk_push')

function error (message, code) {
  const e = new Error(message)
  if (code) e.code = code
  return e
}

(async () => {
  assert.strictEqual(shouldAutoInstallDependencies({}), false, '默认不得在任务运行时安装依赖')
  assert.strictEqual(shouldAutoInstallDependencies({ XBK_AUTO_INSTALL_DEPS: '1' }), true, '显式开关应允许自动安装依赖')
  assert.strictEqual(shouldAutoInstallDependencies({ XBK_AUTO_INSTALL_DEPS: 'true' }), false, '仅接受明确值 1，避免误开启')

  assert.strictEqual(classifyFailure(error('timeout', 'ETIMEDOUT')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('HTTP 500', 'HTTP_500')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('HTTP 401', 'HTTP_401')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('未配置任何推送通道', 'NO_CHANNEL_CONFIG')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('接口返回数据格式异常：期望数组')).kind, 'permanent')

  for (const code of ['ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH',
    'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED', 'ABORT_ERR',
    'HTTP_408', 'HTTP_409', 'HTTP_425', 'HTTP_429']) {
    assert.strictEqual(classifyFailure(error(code, code)).kind, 'retryable', `${code} 应可重试`)
  }
  for (const code of ['ERR_INVALID_URL', 'ERR_BODY_NOT_JSON', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_ARG_TYPE',
    'MODULE_NOT_FOUND', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'HTTP_400', 'HTTP_403', 'HTTP_404', 'HTTP_405', 'HTTP_406',
    'HTTP_410', 'HTTP_411', 'HTTP_413', 'HTTP_415', 'HTTP_422', 'HTTP_423', 'HTTP_426', 'HTTP_451']) {
    assert.strictEqual(classifyFailure(error(code, code)).kind, 'permanent', `${code} 应立即停止`)
  }
  assert.strictEqual(classifyFailure({ response: { statusCode: 500 }, message: 'server' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ response: { statusCode: 408 }, message: 'timeout' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ response: { statusCode: 400 }, message: 'bad request' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ response: { statusCode: 499 }, message: 'client error' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ response: { statusCode: 99 }, message: 'unknown' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ response: { statusCode: 600 }, message: 'unknown' }).kind, 'retryable')
  assert.strictEqual(classifyFailure(Object.assign(new Error('forced'), {
    failureKind: 'permanent', failureReason: 'TEST_FORCE', failureInfo: { message: 'forced-safe' }
  })).reason, 'TEST_FORCE')

  assert.strictEqual(classifyFailure(error('超时', '')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('invalid token')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('参数配置错误')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('服务暂时不可用')).kind, 'retryable')
  assert.strictEqual(classifyFailure({ providerCode: 1001, message: '速度太快' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ code: 1001, message: '速度太快' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ code: 401, message: 'unauthorized' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ providerCode: 40014, message: 'token invalid' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ providerCode: 500, message: 'provider busy' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ providerCode: 500, message: 'invalid token' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ channel: 'wxpusher', providerCode: 1300, message: 'bad app token' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ channel: 'wxpusher', providerCode: 1001, message: '速度太快' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 45009, message: '频率限制' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 40014, message: '请求失败' }).kind, 'permanent')
  // v3.232：企业微信瞬时错误（500 系统繁忙）不得误判永久（曾导致常驻停止重试、消息丢失）
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 500, message: 'system error' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 45001, message: 'no permission' }).kind, 'permanent')
  // v3.236 补充（AI none 复核 32d155a 质疑）：130101=webhook 未找到/机器人删除、41001=缺 token、
  // 42001=token 过期——均配置类永久错误，锁定语义防回归
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 130101, message: 'webhook not found' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 41001, message: 'missing token' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 42001, message: 'token expired' }).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('完全未知故障')).kind, 'retryable')
  assert.strictEqual(classifyFailure(Object.assign(new SyntaxError('代码解析失败'), { name: 'SyntaxError' })).kind, 'permanent')

  // TLS / 证书分类：明确证书故障文本判 permanent，瞬时连接/超时/复合文本仍保持 retryable
  assert.strictEqual(classifyFailure(error('certificate has expired')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('certificate is not yet valid')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('self-signed certificate')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('self signed certificate')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('unable to verify the first certificate')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('unable to get local issuer certificate')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('unable to get issuer certificate')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('certificate signature failure')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('certificate revoked')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('证书已过期')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('自签名证书')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('证书签名失败')).kind, 'permanent')
  assert.strictEqual(classifyFailure(error('无法获取颁发者证书')).kind, 'permanent')

  // 瞬时证书/网络复合文本反例（禁止泛匹配，必须仍为 retryable）
  assert.strictEqual(classifyFailure(error('certificate verification timed out')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('certificate check failed: ECONNRESET')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('TLS handshake temporarily unavailable')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('certificate handshake timed out', 'ETIMEDOUT')).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('certificate socket reset', 'ECONNRESET')).kind, 'retryable')

  const summarized = require('./xbk_failure_policy').summarizeError({
    code: 'HTTP_500',
    providerCode: 500,
    channel: 'test',
    message: 'token=SECRET',
    failures: [{ code: 'HTTP_401', message: 'bad key' }]
  })
  assert.strictEqual(summarized.code, 'HTTP_500')
  assert.strictEqual(summarized.statusCode, null)
  assert.strictEqual(summarized.providerCode, '500')
  assert.strictEqual(summarized.channel, 'test')
  assert(!summarized.message.includes('SECRET'), '错误摘要不得保留明文 token')
  assert.strictEqual(summarized.failures.length, 1)
  assert.strictEqual(require('./xbk_failure_policy').summarizeError({ failureInfo: { message: 'kept' } }).message, 'kept')

  const getterError = {}
  Object.defineProperty(getterError, 'message', { get: () => { throw new Error('getter') } })
  assert.doesNotThrow(() => classifyFailure(getterError))

  assert.strictEqual(classifySummary({
    total: 1,
    pushed: 0,
    failed: 1,
    failures: [{ code: 'ETIMEDOUT', message: 'timeout' }]
  }).kind, 'retryable')
  assert.strictEqual(classifySummary({
    total: 1,
    pushed: 0,
    failed: 1,
    failures: [{ code: 'HTTP_401', message: 'unauthorized' }]
  }).kind, 'permanent')
  assert.strictEqual(classifySummary({
    total: 1,
    pushed: 0,
    failed: 1,
    failures: [{ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }]
  }).kind, 'permanent')
  assert.strictEqual(classifySummary({
    total: 2,
    pushed: 0,
    failed: 2,
    failures: [
      { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' },
      { code: 'ETIMEDOUT', message: 'timeout' }
    ]
  }).kind, 'retryable', '全部失败但包含 permanent 与 retryable 混合错误时整体仍应 retryable')
  assert.strictEqual(classifyFailure({
    code: 'HTTP_401',
    message: 'invalid token + timeout summary',
    failureKind: 'permanent',
    failures: [{ code: 'HTTP_401', message: 'invalid token' }, { code: 'ETIMEDOUT', message: 'timeout' }]
  }).kind, 'retryable', '顶层 permanent 标签不能覆盖嵌套 retryable 失败')

  assert.strictEqual(classifySummary({
    total: 2,
    pushed: 1,
    failed: 1,
    failures: [
      { code: 'HTTP_401', message: 'permanent failure' },
      { code: 'ETIMEDOUT', message: 'transient failure' }
    ]
  }), null, '部分成功且剩余失败含临时因素时不应熔断')
  assert.strictEqual(classifySummary({
    total: 2,
    pushed: 1,
    failed: 1,
    failures: [{ code: 'HTTP_401', message: 'one channel permanent failure' }]
  }), null, '部分成功即保持成功，不应因失败通道的永久错误熔断')
  assert.strictEqual(classifySummary({
    total: 2,
    pushed: 1,
    failed: 1,
    failures: [{ code: 'ETIMEDOUT', message: 'one channel transient failure' }]
  }), null, '部分成功且仅临时失败时保持继续')

  const oldInterval = process.env.XBK_INTERVAL_MS
  const oldBackoffCap = process.env.XBK_RETRY_BACKOFF_CAP_MS
  process.env.XBK_INTERVAL_MS = '0'
  try {
    let permanentRuns = 0
    const permanentController = new AbortController()
    await runResident({
      num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      run: async () => { permanentRuns++; throw error('HTTP 401', 'HTTP_401') }
    }, permanentController)
    assert.strictEqual(permanentRuns, 1, '永久错误应立即停止')
    assert.strictEqual(permanentController.signal.aborted, true)

    let transientRuns = 0
    const transientController = new AbortController()
    // v3.270：可重试错误不再「三轮退出」，改为持续退避重试。
    // 通过把退避封顶调到极小值验证多轮重试（真实默认封顶 30 分钟）。
    process.env.XBK_RETRY_BACKOFF_CAP_MS = '1'
    const transientApp = {
      num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      run: async () => {
        transientRuns++
        if (transientRuns >= 5) {
          transientController.abort()
          return { total: 0, pushed: 0, failed: 0, failures: [] }
        }
        throw error('连接超时', 'ETIMEDOUT')
      }
    }
    await runResident(transientApp, transientController)
    assert.strictEqual(transientRuns, 5, '可重试错误应持续退避重试而非三轮后退出')
    assert.strictEqual(transientController.signal.aborted, true)

    let recoveryRuns = 0
    const recoveryController = new AbortController()
    await runResident({
      num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      run: async () => {
        recoveryRuns++
        if (recoveryRuns === 1) throw error('连接超时', 'ETIMEDOUT')
        recoveryController.abort()
        return { total: 0, pushed: 0, failed: 0, failures: [] }
      }
    }, recoveryController)
    assert.strictEqual(recoveryRuns, 2, '恢复成功后应清零失败状态并正常停止')
    assert.strictEqual(recoveryController.signal.aborted, true)
  } finally {
    if (oldInterval === undefined) delete process.env.XBK_INTERVAL_MS
    else process.env.XBK_INTERVAL_MS = oldInterval
    if (oldBackoffCap === undefined) delete process.env.XBK_RETRY_BACKOFF_CAP_MS
    else process.env.XBK_RETRY_BACKOFF_CAP_MS = oldBackoffCap
  }

  console.log('✅ 常驻失败策略：可重试错误持续退避重试、永久错误立即停止、部分成功不熔断、成功后恢复')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
