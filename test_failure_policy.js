'use strict'

const assert = require('assert')
const {
  classifyFailure,
  classifySummary,
  RETRYABLE_CODES,
  PERMANENT_CODES
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
  // XHTTP-05：空响应体（含纯空白体）单列可重试码——上游「连上后未写体即结束」是瞬时故障，
  // 不得与「有内容但不是 JSON」（ERR_BODY_NOT_JSON，合约性永久错误）同判。旧实现两者同码，
  // 而该码在 PERMANENT 集合 → 一次瞬时空体即永久停推（常驻循环漏推）。
  assert.strictEqual(RETRYABLE_CODES.has('ERR_EMPTY_BODY'), true, '空体码必须显式列进 RETRYABLE_CODES（不得只靠 UNKNOWN 兜底）')
  assert.strictEqual(PERMANENT_CODES.has('ERR_EMPTY_BODY'), false, '空体码不得进永久集合')
  assert.strictEqual(PERMANENT_CODES.has('ERR_BODY_NOT_JSON'), true, '非 JSON 合约错误的永久语义不得被本修复放松')
  assert.strictEqual(classifyFailure(error('Response is not JSON: empty body', 'ERR_EMPTY_BODY')).kind, 'retryable', '空体必须可重试')
  assert.strictEqual(classifyFailure(error('Response is not JSON: empty body', 'ERR_EMPTY_BODY')).reason, 'ERR_EMPTY_BODY', '空体的归类理由必须是本码本身（不是 UNKNOWN）')
  assert.strictEqual(classifyFailure(error('Response is not JSON: body 9 chars', 'ERR_BODY_NOT_JSON')).kind, 'permanent', '非 JSON 体仍判永久')

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
  assert.strictEqual(classifyFailure({ providerCode: 1001, message: '速度太快' }).reason, 'PROVIDER_RATE_LIMIT')
  assert.strictEqual(classifyFailure({ code: 1001, message: '速度太快' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ code: 1001, message: '速度太快' }).reason, 'PROVIDER_1001')
  assert.strictEqual(classifyFailure({ code: 401, message: 'unauthorized' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ providerCode: 40014, message: 'token invalid' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ providerCode: 500, message: 'provider busy' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ providerCode: 500, message: 'provider busy' }).reason, 'PROVIDER_500')
  assert.strictEqual(classifyFailure({ providerCode: 500, message: 'invalid token' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ providerCode: 500, message: 'invalid token' }).reason, 'CONFIG_OR_CONTRACT')
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
  // XFP-02：群机器人 webhook key 失效（errcode 93000）是配置类永久错误。反例（改动前）：
  // 93000 不在永久清单、文本兜底要求 invalid 后紧跟 token|key|parameter 接不住 'invalid webhook
  // key'（中间有 webhook），于是落回 UNKNOWN → retryable，常驻会对同一个失效 webhook 永久退避重试。
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 93000, message: 'invalid webhook key' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 93000, message: 'invalid webhook key' }).reason, 'QYWX_93000')
  // 无 channel/providerCode 时由文本兜底接住（同一缺陷的另一条路径）
  assert.strictEqual(classifyFailure({ message: 'invalid webhook key' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ message: 'invalid webhook key' }).reason, 'CONFIG_OR_CONTRACT')
  assert.strictEqual(classifyFailure({ message: 'invalid access token' }).kind, 'permanent')
  // 反向断言：兜底放宽不能把正常业务错判永久——'invalid' 后不是凭据类词的仍走通用分类
  assert.strictEqual(classifyFailure({ message: 'invalid response payload shape' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ message: 'invalid state transition' }).kind, 'retryable')
  assert.strictEqual(classifyFailure(error('完全未知故障')).kind, 'retryable')
  assert.strictEqual(classifyFailure(Object.assign(new SyntaxError('代码解析失败'), { name: 'SyntaxError' })).kind, 'permanent')

  // XFP-01：同一 4xx 语义在不同承载字段下必须分类一致。反例（改动前）：数字 code/providerCode
  // 落在 400-499 一律 permanent（providerCode 连 '429' 特判都没有），把 408/409/425/429 判为永久，
  // 与 RETRYABLE_CODES 的 HTTP_408/409/425/429 及 statusCode 路径相反 → 限流/冲突/超时被永久停推。
  for (const n of [408, 409, 425, 429]) {
    assert.strictEqual(classifyFailure({ code: String(n) }).kind, 'retryable', `数字 code ${n} 应与 HTTP_${n} 同判可重试`)
    assert.strictEqual(classifyFailure({ code: String(n) }).reason, `PROVIDER_${n}`, `数字 code ${n} 的 reason 保持 PROVIDER_ 口径`)
    assert.strictEqual(classifyFailure({ code: n }).kind, 'retryable', `数字型 code ${n} 同样可重试`)
    assert.strictEqual(classifyFailure({ providerCode: String(n) }).kind, 'retryable', `providerCode ${n} 应与 HTTP_${n} 同判可重试`)
    assert.strictEqual(classifyFailure({ providerCode: String(n) }).reason, `PROVIDER_${n}`, `providerCode ${n} 的 reason 保持 PROVIDER_ 口径`)
  }
  // 反向：其余 4xx 必须仍判永久（不得为放过 408/409/425/429 而把整个 4xx 区间放宽）
  for (const n of [400, 401, 403, 404, 405, 422, 451, 499]) {
    assert.strictEqual(classifyFailure({ code: String(n) }).kind, 'permanent', `code ${n} 仍应判永久`)
    assert.strictEqual(classifyFailure({ providerCode: String(n) }).kind, 'permanent', `providerCode ${n} 仍应判永久`)
  }
  // 跨承载字段一致性：同一 429 在 statusCode / 数字 code / HTTP_ 前缀三种形态下必须同判
  const kinds429 = [
    classifyFailure({ statusCode: 429 }).kind,
    classifyFailure({ code: 429 }).kind,
    classifyFailure({ providerCode: 429 }).kind,
    classifyFailure({ code: 'HTTP_429' }).kind
  ]
  assert.deepStrictEqual(kinds429, ['retryable', 'retryable', 'retryable', 'retryable'],
    `429 在四种承载形态下必须同判可重试，实际 ${JSON.stringify(kinds429)}`)

  // XFP-05：子错误挂在 failureInfo.failures 时，父级 permanent 同样不得覆盖子级 retryable。
  // 反例（改动前）：classifyFailure 只读 error.failures，qinglong 产生的形状
  // {failureKind:'permanent', failureInfo:{failures:[{code:'ETIMEDOUT'}]}} 直接按父标签判 permanent，
  // 与等价的 {failureKind:'permanent', failures:[...]} 分类相反 → 含可重试子通道的失败被永久停推。
  const viaFailures = { failureKind: 'permanent', failures: [{ code: 'ETIMEDOUT' }] }
  const viaFailureInfo = { failureKind: 'permanent', failureInfo: { failures: [{ code: 'ETIMEDOUT' }] } }
  assert.strictEqual(classifyFailure(viaFailures).kind, 'retryable', '前置：error.failures 承载子错误时的既有仲裁')
  assert.strictEqual(classifyFailure(viaFailureInfo).kind, 'retryable', 'failureInfo.failures 承载子错误时必须与 error.failures 同判')
  assert.strictEqual(classifyFailure(viaFailureInfo).reason, classifyFailure(viaFailures).reason, '两个承载位置的 reason 口径也应一致')
  // 反向：failureInfo.failures 全为永久子项时不得被放宽成可重试
  assert.strictEqual(classifyFailure({ failureKind: 'retryable', failureInfo: { failures: [{ code: 'ERR_INVALID_URL' }] } }).kind, 'permanent',
    'failureInfo.failures 全永久子项仍应以子项为准')
  // 无子项时不改变既有行为：failureInfo 只有描述字段 / 空对象 → 父标签仍生效
  assert.strictEqual(classifyFailure({ failureKind: 'permanent', failureInfo: { message: 'boom' } }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ failureKind: 'retryable', failureInfo: {} }).kind, 'retryable')
  // failureInfo.failures 为空数组同样不构成「有子项」，父标签继续生效
  assert.strictEqual(classifyFailure({ failureKind: 'permanent', failureInfo: { failures: [] } }).kind, 'permanent')

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

  // ============ 补测：xbk_failure_policy 未覆盖分支（契约→反例→证据） ============

  // [探针] 最高风险契约：聚合失败所有子通道均永久 → 整体永久停止。
  // 反例：只要任一子通道可重试，整体必须保留重试机会（见下一组 MIXED 断言）。
  const allPermanent = classifyFailure({
    message: 'aggregated',
    failures: [{ code: 'HTTP_401', message: 'a' }, { code: 'MODULE_NOT_FOUND', message: 'b' }]
  })
  assert.strictEqual(allPermanent.kind, 'permanent', '子通道全永久时整体应永久')
  assert.strictEqual(allPermanent.reason, 'ALL_CHANNELS_PERMANENT')

  // 嵌套混合：任一子通道可重试 → 整体可重试（宁可重复，不可丢失）
  const mixed = classifyFailure({
    message: 'agg',
    failures: [{ code: 'HTTP_401', message: 'a' }, { code: 'ETIMEDOUT', message: 'b' }]
  })
  assert.strictEqual(mixed.kind, 'retryable', '混合失败含可重试子通道时整体应可重试')
  assert.strictEqual(mixed.reason, 'MIXED_CHANNEL_FAILURES')

  // classifySummary：非对象 / 空入参 / 无失败 → null（不进入分类）
  assert.strictEqual(classifySummary(null), null)
  assert.strictEqual(classifySummary(undefined), null)
  assert.strictEqual(classifySummary('not-an-object'), null)
  assert.strictEqual(classifySummary({ total: 0, pushed: 0, failed: 0 }), null)

  // classifySummary：有失败但 failures 缺失（非数组）→ 全失败但原因未结构化 → 保守重试
  const unknownAll = classifySummary({ total: 1, pushed: 0, failed: 1 })
  assert.strictEqual(unknownAll.kind, 'retryable')
  assert.strictEqual(unknownAll.reason, 'ALL_PUSH_FAILED_UNKNOWN')

  // classifySummary：部分成功 + failures 空数组 → 保持成功，不熔断
  assert.strictEqual(classifySummary({ total: 2, pushed: 1, failed: 1, failures: [] }), null)

  // [XFP-03] 「有没有失败」只由 failed 决定，不得被 total 的缺失/非数字带偏。
  // 反例（改动前）：`Number(total)||0` 使 total<=0 成立 → 直接返回 null，一个有失败的摘要
  // 被判成“无失败”即成功，调度器按绿色处理、失败被静默吞掉。
  assert.strictEqual(classifySummary({ failed: 1, failures: [{ code: 'HTTP_401', message: 'unauthorized' }] }).kind, 'permanent',
    'total 缺失但 failed>0 时必须进入分类，不能返回 null')
  assert.strictEqual(classifySummary({ total: 'x', failed: 1, failures: [{ code: 'HTTP_401', message: 'unauthorized' }] }).kind, 'permanent',
    'total 非数字但 failed>0 时必须进入分类，不能返回 null')
  assert.strictEqual(classifySummary({ total: 0, failed: 2, failures: [{ code: 'ETIMEDOUT', message: 'timeout' }] }).kind, 'retryable',
    'total 为 0 但 failed>0 时必须进入分类（宁可重试，不可静默丢）')
  // 反向断言：真正无失败/非法 failed 仍必须返回 null，不能被放宽成“一律失败”
  assert.strictEqual(classifySummary({ total: 5, failed: 0 }), null, 'failed=0 仍为成功')
  assert.strictEqual(classifySummary({ total: 5 }), null, 'failed 缺失仍为成功')
  assert.strictEqual(classifySummary({ total: 5, failed: 'abc' }), null, 'failed 非数字仍为成功')
  assert.strictEqual(classifySummary({ total: 5, failed: -1 }), null, 'failed 负数仍为成功')

  // code 数值 400-499（未命中 message/错误码集合）→ PROVIDER_xxx 永久
  assert.strictEqual(classifyFailure({ code: 450, message: 'server replied' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ code: 450, message: 'server replied' }).reason, 'PROVIDER_450')

  // providerCode 数值 400-499（无 channel）→ PROVIDER_xxx 永久
  assert.strictEqual(classifyFailure({ providerCode: 450, message: 'plain' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ providerCode: 450, message: 'plain' }).reason, 'PROVIDER_450')

  // providerCode 数值 500-599（无 channel）→ 可重试（瞬时服务故障）
  assert.strictEqual(classifyFailure({ providerCode: 502, message: 'busy' }).kind, 'retryable')
  assert.strictEqual(classifyFailure({ providerCode: 502, message: 'busy' }).reason, 'PROVIDER_502')

  // HTTP_ 非错误码集合 4xx → 永久（走 HTTP_ 前缀分支）
  assert.strictEqual(classifyFailure({ code: 'HTTP_450', message: 'x' }).kind, 'permanent')
  assert.strictEqual(classifyFailure({ code: 'HTTP_450', message: 'x' }).reason, 'HTTP_450')

  // classifyOne 内部 failureKind（经 classifySummary 传递）：子错误显式永久 → 整体永久
  assert.strictEqual(classifySummary({
    total: 1,
    pushed: 0,
    failed: 1,
    failures: [{ failureKind: 'permanent', failureReason: 'EXPLICIT_X', message: 'm' }]
  }).kind, 'permanent')

  // ============ 补测：失败摘要递归防护（自引用 / 深度上限 / 兄弟重复）+ failureInfo 脱敏 ============
  const summarizeError = require('./xbk_failure_policy').summarizeError
  const TRUNCATED_FAILURE_MESSAGE = '[嵌套失败结构过深或自引用，已截断]'

  // [自引用·常规路径] 本模块契约“不抛异常”：failures 指向自身必须截断为标记，而不是无限递归栈溢出。
  // 反例（改动前）：summarizeError({message, failures:[self]}) 抛 RangeError: Maximum call stack size exceeded。
  const selfRefError = { message: 'self', code: 'HTTP_500' }
  selfRefError.failures = [selfRefError]
  let selfRefSummary
  assert.doesNotThrow(() => { selfRefSummary = summarizeError(selfRefError) }, '自引用失败结构不得抛 RangeError')
  assert.strictEqual(selfRefSummary.failures.length, 1)
  assert.strictEqual(selfRefSummary.failures[0].message, TRUNCATED_FAILURE_MESSAGE,
    '自引用子项应截断为标记而非继续递归')
  assert.strictEqual(Array.isArray(selfRefSummary.failures[0].failures), false, '截断标记不应再带子失败')
  // 截断标记只落进 UNKNOWN → 可重试，绝不因“结构异常”误判永久（宁可重复，不可丢失）
  assert.doesNotThrow(() => classifyFailure(selfRefError), 'classifyFailure 不得因自引用结构抛栈溢出')
  assert.strictEqual(classifyFailure(selfRefError).kind, 'retryable', '自引用截断后应保守判为可重试')

  // [深度上限] MAX_FAILURE_DEPTH=5：第 1..5 层完整展开，第 6 层截断。
  // 反例（改动前无上限）：7 节点深链被完整保留，第 5 层的子节点仍是原始对象而非截断标记。
  const deepChainNodes = []
  for (let i = 0; i < 7; i++) deepChainNodes.push({ message: `L${i}` })
  for (let i = 0; i < 6; i++) deepChainNodes[i].failures = [deepChainNodes[i + 1]]
  const deepSummary = summarizeError(deepChainNodes[0])
  assert.strictEqual(deepSummary.message, 'L0')
  let deepCursor = deepSummary
  for (let i = 1; i <= 5; i++) {
    assert(deepCursor.failures && deepCursor.failures.length === 1, `第 ${i} 层应有唯一子失败`)
    deepCursor = deepCursor.failures[0]
    assert(deepCursor, `第 ${i} 层应存在：MAX_FAILURE_DEPTH=5 允许展开到第 5 层`)
    assert.strictEqual(deepCursor.message, `L${i}`, `第 ${i} 层不应被截断`)
  }
  assert.strictEqual(deepCursor.failures[0].message, TRUNCATED_FAILURE_MESSAGE,
    '第 6 层超过 MAX_FAILURE_DEPTH=5 应截断为标记')

  // [兄弟重复不是环] 祖先集合按路径复制：同一子对象作为兄弟重复出现时必须完整展开。
  // 用“自带子失败的共享分支”而非纯叶子——只有会进入 failures 分支的节点才会被加入祖先集合，
  // 任何共享可变集合的实现都会让第二处误判为自引用并截断（纯叶子对象触发不到该缺陷）。
  const sharedBranch = { message: 'branch', failures: [{ message: 'leaf' }] }
  const siblingSummary = summarizeError({ message: 'root', failures: [sharedBranch, sharedBranch] })
  assert.strictEqual(siblingSummary.failures.length, 2)
  assert.deepStrictEqual(
    siblingSummary.failures.map(f => f.failures && f.failures[0] && f.failures[0].message),
    ['leaf', 'leaf'],
    '同一带子失败的对象重复作为兄弟出现不得被判为自引用'
  )
  const nestedSiblingSummary = summarizeError({
    message: 'root',
    failures: [{ message: 'p1', failures: [sharedBranch] }, { message: 'p2', failures: [sharedBranch] }]
  })
  assert.deepStrictEqual(
    nestedSiblingSummary.failures.map(f => f.failures[0].failures[0].message),
    ['leaf', 'leaf'],
    '不同父路径下的同一子对象也应完整展开'
  )

  // [深度上限·failureInfo 路径] failureInfo 内的失败链与常规路径同口径：
  // 反例（改动前是整对象浅拷贝）：深链原样带出，不截断。
  const fiDeepSummary = summarizeError({ failureInfo: deepChainNodes[0] })
  assert.strictEqual(fiDeepSummary.failures.length, 1)
  let fiDeepCursor = fiDeepSummary
  for (let i = 1; i <= 5; i++) {
    assert(fiDeepCursor.failures && fiDeepCursor.failures.length === 1, `failureInfo 第 ${i} 层应有唯一子失败`)
    fiDeepCursor = fiDeepCursor.failures[0]
    assert(fiDeepCursor, `failureInfo 第 ${i} 层应完整展开`)
  }
  assert.strictEqual(fiDeepCursor.failures[0].message, TRUNCATED_FAILURE_MESSAGE,
    'failureInfo 内第 6 层应截断为标记')

  // [reason 细分] 全部子项可重试并非“原因混合”：kind 仍 retryable，reason 改为 ALL_CHANNELS_RETRYABLE。
  // 反例（改动前）：此分支恒返回 MIXED_CHANNEL_FAILURES，诊断失真。
  const allRetryable = classifyFailure({
    message: 'agg',
    failures: [{ code: 'ETIMEDOUT', message: 'a' }, { code: 'ECONNRESET', message: 'b' }]
  })
  assert.strictEqual(allRetryable.kind, 'retryable')
  assert.strictEqual(allRetryable.reason, 'ALL_CHANNELS_RETRYABLE', '全部子项可重试时不应标成原因混合')
  // 只要存在永久子项就必须仍是 MIXED：挡住把上面“全可重试”判定泛化成“任一可重试”的错误实现。
  const mixedAggregate = classifyFailure({
    message: 'agg',
    failures: [{ code: 'HTTP_401', message: 'a' }, { code: 'ETIMEDOUT', message: 'b' }]
  })
  assert.strictEqual(mixedAggregate.kind, 'retryable')
  assert.strictEqual(mixedAggregate.reason, 'MIXED_CHANNEL_FAILURES', '存在永久子项时仍为原因混合')

  // [failureInfo 脱敏] failureInfo 不再是原样浅拷贝，字符串字段与常规路径同口径清洗。
  // 反例（改动前）：{...failureInfo} 让 message 原样带出 token=SECRET123。
  assert.strictEqual(summarizeError({ failureInfo: { message: 'token=SECRET123' } }).message, 'token=***',
    'failureInfo.message 必须脱敏，不得原样带出凭据')
  assert.strictEqual(summarizeError({ failureInfo: { detail: 'token=SECRET123' } }).detail, 'token=***',
    'failureInfo 的任意字符串字段都应脱敏')
  assert.strictEqual(summarizeError({ failureInfo: { message: 'l1\nl2' } }).message, 'l1 l2',
    'failureInfo.message 应与常规路径一致折叠换行')

  // [XFP-04 脱敏覆盖] 同一凭据换一种书写形态就不能漏抹——脱敏是「按形态」的，漏一种就是泄漏一种。
  // ① Authorization 头形态：反例（改动前）只吃掉 scheme，凭据残留 → `Authorization: *** SECRET123 x`。
  assert.strictEqual(summarizeError({ message: 'Authorization: Bearer SECRET123 x' }).message,
    'Authorization: *** x', 'Authorization 头的凭据必须整体脱敏，不能只抹 Bearer')
  assert.strictEqual(summarizeError({ message: 'authorization: basic YWJjOmRlZg==' }).message,
    'authorization: ***', 'basic 认证串必须整体脱敏')
  // ② JSON/JS 引号形态：反例（改动前）关键字与冒号之间夹引号 → 整体不命中，凭据原样带出。
  assert.strictEqual(summarizeError({ message: '{"appToken":"SECRET123"}' }).message,
    '{"appToken":"***"}', 'JSON 引号形态的 appToken 必须脱敏')
  assert.strictEqual(summarizeError({ failureInfo: { detail: '{"secret":"SECRET123","n":1}' } }).detail,
    '{"secret":"***","n":1}', 'failureInfo 字符串字段的 JSON 引号形态凭据同样脱敏')
  // ②b JSON 值内含转义序列：值匹配必须按 JSON 转义语义吃到真正的收尾引号。
  // 反例（qodo PR #151-1）：`[^"]*` 把值内的 \" 当成收尾引号——'{"appToken":"abc\"SECRET"}' 只被抹掉
  // 前半段、凭据后缀原样进日志/告警（脱敏是安全控制，漏抹即泄漏）。
  assert.strictEqual(summarizeError({ message: '{"appToken":"abc\\"SECRET"}' }).message,
    '{"appToken":"***"}', '值内含转义引号时凭据必须整体脱敏，不得残留后缀')
  assert.ok(!summarizeError({ message: '{"appToken":"abc\\"SECRET"}' }).message.includes('SECRET'),
    '转义引号形态不得残留凭据后缀')
  assert.strictEqual(summarizeError({ message: '{"appToken":"a\\\\bSECRET"}' }).message,
    '{"appToken":"***"}', '值内含转义反斜杠时凭据同样必须整体脱敏')
  assert.ok(!summarizeError({ message: '{"token":"x\\"ySECRET"}' }).message.includes('SECRET'),
    'token 关键字的转义引号形态同样不得残留')
  // ③ 裸 Bearer/Basic（无关键字前缀，如上游把 Authorization 头值回显进 message）
  assert.strictEqual(summarizeError({ message: 'upstream said: Bearer SECRET123 rejected' }).message,
    'upstream said: Bearer *** rejected', '裸 Bearer 凭据必须脱敏（保留原大小写）')
  assert.strictEqual(summarizeError({ message: 'Basic YWJjOmRlZg==' }).message,
    'Basic ***', '裸 Basic 与裸 Bearer 必须对称处理（A 组反例：旧实现只认 Bearer）')

  // ============ 独立对抗审查 A 组补漏：同一凭据被引号包住/换引号种类/非字符串值 ============
  // 反例（补漏前实测）：下面每一条都会把凭据原样留在日志里。脱敏是安全控制，漏抹即泄漏。
  assert.strictEqual(summarizeError({ message: 'Authorization: "Bearer SECRET123"' }).message,
    'Authorization: "***"', '值被双引号包住时凭据必须整体脱敏（含 scheme）')
  assert.strictEqual(summarizeError({ message: 'Authorization:"Bearer SECRET123"' }).message,
    'Authorization:"***"', '冒号后无空格 + 引号值同样必须脱敏')
  assert.strictEqual(summarizeError({ message: 'Authorization="Bearer SECRET123"' }).message,
    'Authorization="***"', '等号 + 引号值同样必须脱敏')
  assert.strictEqual(summarizeError({ message: "Authorization: 'Bearer SECRET123'" }).message,
    "Authorization: '***'", '单引号值同样必须脱敏')
  assert.strictEqual(summarizeError({ message: "{'token':'SECRET123'}" }).message,
    "{'token':'***'}", 'JS 单引号 JSON 形态必须脱敏（旧实现整体不命中）')
  assert.strictEqual(summarizeError({ message: '{"token":12345}' }).message,
    '{"token":***}', '非字符串 JSON 值同样必须脱敏')
  assert.strictEqual(summarizeError({ message: '"token" = "SECRET123"' }).message,
    '"token" = "***"', '带引号的关键字 + 等号形态必须脱敏')
  assert.strictEqual(summarizeError({ message: '?appToken=SECRET123&x=1' }).message,
    '?appToken=***&x=1', 'URL query 形态必须脱敏（& 之后的参数不受影响）')
  // 关键字表扩充（A 组：password/session/cookie 等常见凭据键此前完全不在表内）
  assert.strictEqual(summarizeError({ message: 'password=SECRET123' }).message, 'password=***', 'password 键必须脱敏')
  assert.strictEqual(summarizeError({ message: '{"password":"SECRET123"}' }).message, '{"password":"***"}', 'JSON password 必须脱敏')
  assert.strictEqual(summarizeError({ message: 'session: SECRET123' }).message, 'session: ***', 'session 键必须脱敏')
  assert.strictEqual(summarizeError({ message: 'cookie=SECRET123' }).message, 'cookie=***', 'cookie 键必须脱敏')
  assert.strictEqual(summarizeError({ message: 'refresh_token=SECRET123' }).message, 'refresh_token=***', 'refresh_token 键必须脱敏')
  // 有意的边界：逗号/分号/& 视为「值结束」——`token=a,b` 只抹 a（b 属下一个参数）
  assert.strictEqual(summarizeError({ message: 'token=a,b' }).message, 'token=***,b',
    '逗号视为值分隔符（有意收窄，避免吞掉后续参数）——若改为吞到空白需同步改本条')
  // 未闭合引号值同样必须抹掉（否则整段漏抹）
  assert.strictEqual(summarizeError({ message: 'token="x' }).message, 'token="***"', '未闭合引号值必须脱敏')

  // ============ qodo PR #152 的 4 条（已逐条复现后修复）============
  // #1 结构化值（数组/对象）：旧实现裸值分支遇 `,`/`}`/`]` 即停，凭据后半段残留。
  assert.strictEqual(summarizeError({ message: 'token=[0,"SECRET"]' }).message, 'token=***',
    '数组值必须整体脱敏（旧实现残留 ,"SECRET"]）')
  assert.strictEqual(summarizeError({ message: 'token={"a":"SECRET"}' }).message, 'token=***',
    '对象值必须整体脱敏（旧实现残留 } ）')
  assert.strictEqual(summarizeError({ message: 'token=[1,2,3]' }).message, 'token=***', '无可疑内容的数组值同样按凭据整段抹掉')
  // #2 裸 scheme 带引号：旧实现要求凭据首字符非引号 → 整体不命中，凭据原样出网。
  assert.strictEqual(summarizeError({ message: 'Basic "YWJjOmRlZg=="' }).message, 'Basic ***',
    '裸 Basic + 双引号值必须脱敏（旧实现整体漏抹）')
  assert.strictEqual(summarizeError({ message: "Bearer 'SECRET123'" }).message, 'Bearer ***',
    '裸 Bearer + 单引号值必须脱敏')
  // #3 关键字边界：旧实现的关键字两侧无边界，`monkey`/`turkey` 的后缀 `key` 被当成凭据键，
  //    把无关普通字段抹掉（可观测性损失）。
  assert.strictEqual(summarizeError({ message: '{"monkey":"business"}' }).message, '{"monkey":"business"}',
    'monkey 不得被当成 key 键脱敏（关键字需边界）')
  assert.strictEqual(summarizeError({ message: '{"turkey":"dinner"}' }).message, '{"turkey":"dinner"}',
    'turkey 不得被当成 key 键脱敏')
  assert.strictEqual(summarizeError({ message: 'keynote: hello world' }).message, 'keynote: hello world',
    'keynote 不得被当成 key 键脱敏')
  // 反向：真正的 key 键与含关键字的混合 JSON 仍必须脱敏（边界不能把该抹的也放过）
  assert.strictEqual(summarizeError({ message: '{"key":"v"}' }).message, '{"key":"***"}', '真正的 key 键仍须脱敏')
  assert.strictEqual(summarizeError({ message: '{"monkey":"business","token":"SECRET123"}' }).message,
    '{"monkey":"business","token":"***"}', '同一 JSON 里普通字段保留、凭据字段脱敏')
  // 幂等：已脱敏输出再次经过脱敏不得继续变化（身份/日志可能重复经过多条清洗路径）
  assert.strictEqual(summarizeError({ message: 'token=***' }).message, 'token=***', '脱敏必须幂等')
  assert.strictEqual(summarizeError({ message: 'Basic ***' }).message, 'Basic ***', '裸 scheme 脱敏同样幂等')

  // 反向断言：无凭据文本不得被脱敏误改（防止把规则写成吞掉正常内容）
  assert.strictEqual(summarizeError({ message: 'request timed out after 5000ms' }).message,
    'request timed out after 5000ms', '无凭据文本不应被脱敏改动')
  // A 组反例：本批前一版给裸 scheme 规则加了「任意长度凭据」匹配，把普通英文句子误抹。
  // 现要求凭据部分 ≥8 个凭据字符，句子里的 `bearer of good news` 不再被误抹。
  assert.strictEqual(summarizeError({ message: 'the bearer of good news' }).message,
    'the bearer of good news', '普通英文句子里的 bearer 不得被误抹（凭据长度门槛）')
  assert.strictEqual(summarizeError({ failureInfo: { message: 'plain text 1\n2' } }).message, 'plain text 1 2',
    '无凭据文本的换行折叠口径不变')
  // 非字符串字段原样保留，脱敏不改变结构语义
  const fiStructured = summarizeError({ failureInfo: { code: 'HTTP_500', statusCode: 500, message: 'ok' } })
  assert.strictEqual(fiStructured.code, 'HTTP_500')
  assert.strictEqual(fiStructured.statusCode, 500)
  // failureInfo 自引用：不得抛异常，子项截断为标记（改动前浅拷贝保留了自引用结构）
  const fiSelfRef = {}
  fiSelfRef.failures = [fiSelfRef]
  let fiSelfRefSummary
  assert.doesNotThrow(() => { fiSelfRefSummary = summarizeError({ failureInfo: fiSelfRef }) }, 'failureInfo 自引用不得抛异常')
  assert.strictEqual(fiSelfRefSummary.failures[0].message, TRUNCATED_FAILURE_MESSAGE,
    'failureInfo 内的自引用应截断为标记')

  // ============ 补测：failureInfo.failures 敌意对象（qodo #147-11：revoked proxy / 抛错索引 getter） ============
  // 契约：failureInfo 分支同样「绝不抛」。Array.isArray 对 revoked proxy 会抛 TypeError，
  // 索引 getter 抛错的数组在取元素时会抛——二者都必须被挡在 try 内，失败即退回原值透传（不遍历）。

  // [revoked proxy] 关键点：Array.isArray(revoked) 自身就抛，所以判定必须在 try 里。
  // 反例（qodo 修复前，HEAD 45a63b8 的 `key === 'failures' && Array.isArray(value)`）：判定裸写在 try 外，
  // summarizeError({failureInfo:{failures:revoked}}) 直接抛 TypeError，破坏本模块的不抛契约。
  const revocableFailures = Proxy.revocable([], {})
  revocableFailures.revoke()
  const revokedFailures = revocableFailures.proxy
  assert.throws(() => Array.isArray(revokedFailures), TypeError, '前置条件：Array.isArray 对 revoked proxy 必须抛 TypeError')
  let revokedFailuresSummary
  assert.doesNotThrow(
    () => {
      revokedFailuresSummary = summarizeError({ failureInfo: { code: 'HTTP_500', message: 'agg', failures: revokedFailures } })
    },
    'failureInfo.failures 为 revoked proxy 时 summarizeError 不得抛 TypeError'
  )
  assert.strictEqual(revokedFailuresSummary.failures, revokedFailures, '取元素失败时 failures 应原值透传，不得遍历或替换')
  assert.strictEqual(revokedFailuresSummary.code, 'HTTP_500', '同一 failureInfo 内的正常字段仍应照常归一')

  // [抛错索引 getter] Array.isArray 为 true，但读第 0 项即抛。
  // 反例（qodo 修复前）：`value.map(...)` 遍历索引 → summarizeError 抛 'index getter boom'。
  const hostileIndexFailures = []
  Object.defineProperty(hostileIndexFailures, 0, {
    get () { throw new Error('index getter boom') },
    enumerable: true,
    configurable: true
  })
  assert.strictEqual(hostileIndexFailures.length, 1, '前置条件：定义索引 0 的 getter 后数组长度为 1')
  assert.strictEqual(Array.isArray(hostileIndexFailures), true, '前置条件：带索引 getter 的对象仍是数组')
  assert.throws(() => hostileIndexFailures.map(item => item), /index getter boom/, '前置条件：遍历该数组必然抛错')
  let hostileIndexSummary
  assert.doesNotThrow(
    () => {
      hostileIndexSummary = summarizeError({ failureInfo: { message: 'kept', failures: hostileIndexFailures } })
    },
    'failures 数组元素 getter 抛错时 summarizeError 不得抛出'
  )
  assert.strictEqual(hostileIndexSummary.failures, hostileIndexFailures, '遍历失败时 failures 应原值透传，不得降级为空数组')
  assert.strictEqual(hostileIndexSummary.message, 'kept', '同一 failureInfo 内的正常字符串字段仍应照常归一')

  // [不回归] 正常 failureInfo.failures 仍逐项递归归一：子项走 summarizeError 全量清洗，
  // 挡住把上面的兜底误写成「任何 failures 都原值透传」的实现（那样子项凭据会绕过脱敏）。
  const normalFiFailures = [
    { code: 'HTTP_401', message: 'bad key' },
    { code: 'ETIMEDOUT', message: 'token=SECRET9\nnext', failures: [{ code: 'ECONNRESET', message: 'reset' }] }
  ]
  const normalFiSummary = summarizeError({ failureInfo: { message: 'agg', failures: normalFiFailures } })
  assert.strictEqual(normalFiSummary.failures.length, 2, '正常 failures 数组仍应逐项归一')
  assert.notStrictEqual(normalFiSummary.failures, normalFiFailures, '正常 failures 必须是归一化后的新副本，不是原值透传')
  assert.strictEqual(normalFiSummary.failures[0].code, 'HTTP_401')
  assert.strictEqual(normalFiSummary.failures[1].code, 'ETIMEDOUT')
  assert.strictEqual(normalFiSummary.failures[1].message, 'token=*** next', 'failureInfo 子项的 message 仍应脱敏并折叠换行')
  assert.strictEqual(normalFiSummary.failures[1].failures[0].code, 'ECONNRESET', 'failureInfo 子项的下级 failures 仍应递归归一')

  // [顶层 failures 同一收口 —— 主代理在 qodo 复核后补的第二轮]
  // 反例（只保住 failureInfo 分支时）：summarizeError 常规路径的 `Array.isArray(failures)`、
  // classifyOne 的 `Array.isArray(info.failures)`、classifyFailure 的 `Array.isArray(nested)`、
  // classifySummary 的 `Array.isArray(summary.failures)` 都裸写在 try 外——敌意数组挂在**顶层** failures
  // （或经 failureInfo 透传后被 classifyOne 再读一次）时仍会抛，等于异常只是被推迟了一层。
  // 现统一经 safeArray 取值，以下四条锁定这条口径。
  assert.doesNotThrow(() => summarizeError({ message: 'x', failures: revokedFailures }),
    '顶层 failures 为 revoked proxy 时 summarizeError 不得抛 TypeError')
  assert.doesNotThrow(() => summarizeError({ message: 'x', failures: hostileIndexFailures }),
    '顶层 failures 带抛错索引 getter 时 summarizeError 不得抛')
  assert.doesNotThrow(() => classifyFailure({ failureInfo: { failures: revokedFailures } }),
    'classifyFailure 对透传下来的敌意 failures 不得再抛（此前异常只是被推迟一层）')
  assert.doesNotThrow(() => classifyFailure({ message: 'x', failures: hostileIndexFailures }),
    'classifyFailure 对顶层索引 getter 抛错的 failures 不得再抛')
  assert.doesNotThrow(() => classifySummary({ total: 2, failed: 1, failures: revokedFailures }),
    'classifySummary 读取敌意 failures 时不得抛')
  // [不回归] 顶层正常 failures 仍逐项递归归一（挡住「任何 failures 都当空处理」的实现）
  const normalTopFailures = summarizeError({ message: 'agg', failures: [{ code: 'ETIMEDOUT' }, { code: 'HTTP_401' }] })
  assert.strictEqual(normalTopFailures.failures.length, 2, '顶层正常 failures 仍应逐项归一')
  assert.strictEqual(normalTopFailures.failures[0].code, 'ETIMEDOUT')
  assert.strictEqual(classifyFailure({ failures: [{ code: 'ETIMEDOUT' }] }).kind, 'retryable',
    '顶层可重试子项仍应让整体判 retryable')

  // ============ 补测（CodeRabbit PR #147）：safeArray 不得经 Array.prototype.slice 走 Symbol.species ============
  // 契约：safeArray 的返回值恒为「真数组」——有 .length 且可 .map，不得因数组子类的自定义
  // Symbol.species 而变成没有数组方法的对象。
  // 反例（PR #147 修复前 `Array.prototype.slice.call(value)`）：slice 走 ArraySpeciesCreate，
  // species 被改成 Object 时返回的是 Number 包装对象（无 .map）；随后 sanitizeFailureInfo /
  // summarizeError 里 **try 之外** 的 `items.map(...)` 直接抛 TypeError，破坏本模块「绝不抛」契约。
  class SpeciesWeird extends Array {
    static get [Symbol.species] () { return Object }
  }
  const weirdFailures = new SpeciesWeird()
  weirdFailures.push({ code: 'ETIMEDOUT', message: 'timeout' })
  assert.strictEqual(Array.isArray(weirdFailures), true, '前置条件：Array 子类实例仍应被 Array.isArray 认作数组')
  assert.strictEqual(typeof Array.prototype.slice.call(weirdFailures).map, 'undefined',
    '前置条件：该子类的 Symbol.species 必须让 slice 返回无 .map 的非数组对象，否则本条断言无意义')
  let speciesFiSummary
  assert.doesNotThrow(() => {
    speciesFiSummary = summarizeError({ failureInfo: { message: 'agg', failures: weirdFailures } })
  }, 'failures 为自定义 Symbol.species 的数组子类时 summarizeError 不得抛 TypeError')
  assert.strictEqual(Array.isArray(speciesFiSummary.failures), true, 'failureInfo 分支的 failures 必须是真数组')
  assert.strictEqual(typeof speciesFiSummary.failures.map, 'function', 'failureInfo 分支的 failures 必须可 .map')
  assert.strictEqual(speciesFiSummary.failures.length, 1, '子项数量应原样保留')
  assert.strictEqual(speciesFiSummary.failures[0].code, 'ETIMEDOUT', '数组子类内的子项仍应逐项递归归一')
  // 常规路径（顶层 failures）同样经 safeArray：species 逃逸会让这里的 .map 抛给调用方
  let speciesTopSummary
  assert.doesNotThrow(() => {
    speciesTopSummary = summarizeError({ message: 'agg', failures: weirdFailures })
  }, '顶层 failures 为自定义 Symbol.species 的数组子类时 summarizeError 不得抛 TypeError')
  assert.strictEqual(Array.isArray(speciesTopSummary.failures), true, '顶层 failures 必须是真数组')
  assert.strictEqual(speciesTopSummary.failures[0].code, 'ETIMEDOUT', '顶层子项仍应逐项归一')

  // ============ 补测（CodeRabbit PR #147）：failureInfo 的 __proto__ 污染不得伪造 failureKind ============
  // 契约：sanitizeFailureInfo 用 Object.create(null) 承载清洗结果；来自外部 JSON 的**自有**
  // `__proto__` 字段不得改写结果原型，更不得让 classifyOne 读到继承来的伪造 failureKind。
  // 反例（PR #147 修复前 `const sanitized = {}`）：`sanitized['__proto__'] = {...}` 触发原型 setter，
  // 结果对象继承 failureKind:'permanent'，本可重试的失败被误判永久并停止重试、丢消息。
  const protoPollutedInfo = JSON.parse('{"message":"m","__proto__":{"failureKind":"permanent"}}')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(protoPollutedInfo, '__proto__'), true,
    '前置条件：JSON.parse 结果必须带自有 __proto__ 字段')
  const protoSafe = summarizeError({ failureInfo: protoPollutedInfo })
  assert.strictEqual(Object.getPrototypeOf(protoSafe), null, '清洗结果必须是无原型对象，阻断 __proto__ 污染')
  assert.strictEqual(protoSafe.failureKind, undefined, '伪造的 failureKind 不得经原型继承泄露')
  assert.strictEqual(protoSafe.message, 'm', '同一 failureInfo 内的正常字段仍应保留')
  assert.strictEqual(classifyFailure({ failureInfo: protoPollutedInfo }).kind, 'retryable',
    '伪造 failureKind 不得把可重试失败带成永久停止（m 无永久文本 → UNKNOWN → retryable）')

  console.log('✅ 常驻失败策略：可重试错误持续退避重试、永久错误立即停止、部分成功不熔断、成功后恢复')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
