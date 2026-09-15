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

  console.log('✅ 常驻失败策略：可重试错误持续退避重试、永久错误立即停止、部分成功不熔断、成功后恢复')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
