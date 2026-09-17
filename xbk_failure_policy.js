'use strict'

// 常驻运行失败分类：把可波动的网络/服务故障与不可恢复的配置/契约故障分开。
// 默认未知错误按可重试处理，遵守“宁可重复，不可丢失”的主流程原则。

const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED',
  'ABORT_ERR', 'HTTP_408', 'HTTP_409', 'HTTP_425', 'HTTP_429'
])

const PERMANENT_CODES = new Set([
  'ERR_INVALID_URL', 'ERR_BODY_NOT_JSON', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_ARG_TYPE',
  'MODULE_NOT_FOUND', 'NO_CHANNEL_CONFIG',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HTTP_400', 'HTTP_401', 'HTTP_403',
  'HTTP_404', 'HTTP_405', 'HTTP_406', 'HTTP_410', 'HTTP_411', 'HTTP_413',
  'HTTP_415', 'HTTP_422', 'HTTP_423', 'HTTP_426', 'HTTP_451'
])

function safeString (value) {
  try { return String(value === undefined || value === null ? '' : value) } catch (e) { return '' }
}

// XFP-04（含独立对抗审查 A 组补漏）：脱敏必须**整体**抹掉凭据，且要覆盖写法差异。一条键值规则
//  + 一条裸 scheme 规则，比按形态堆多条正则更好推理，也不会出现「前一条把后一条的输入改掉」的耦合。
//
// 键值规则：`<关键字(可带引号)> < = | : > [scheme] <值>`，值三选一（顺序即优先级）：
//  ① `"(?:\.|[^"\\])*"?`  双引号值，按 JSON 转义语义吃完整串——用 `[^"]*` 会把值内的转义引号当
//     收尾引号、只抹前半段（qodo #151-1：`{"appToken":"abc\"SECRET"}` 残留 `SECRET`）；收尾引号
//     可选，未闭合的引号值同样被抹掉（否则 `token="x` 整段漏抹）。单引号形态同构。
//  ② `'(?:\.|[^'\\])*'?`  单引号值（A 组反例：`{'token':'SECRET'}` 旧规则整体不命中）。
//  ③ `[^\s,;}\]&]+`       裸值，含非字符串 JSON 值（`{"token":12345}`）。分隔符 `\s,;}\]&` 是
//     **有意收窄**：逗号/分号/& 之后属于下一个参数（`?token=a,b` 只抹 `a`），该行为有断言锁定。
//  值以引号开头时按原引号形态回填（`"***"` / `'***'`），保持 JSON/JS 结构可读。
//  已脱敏值（`***`）不会被二次处理——回调按值重新生成，天然幂等。
//
// 裸 scheme 规则：无关键字的 `Bearer|Basic <凭据>`（如上游把 Authorization 头值回显进 message）。
//  凭据部分要求 ≥8 个凭据字符：否则普通英文句子 `the bearer of good news` 会被误抹
//  （A 组反例，本批前一版引入的假阳性）。
const SECRET_KEY = '(?:app[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|pushkey|authorization|credential|password|passwd|pwd|session|cookie|token|key|secret)'
// 关键字本身可能是引用形态：双引号（JSON）、单引号（JS 字面量）
const SECRET_KEY_QUOTED = `["']?${SECRET_KEY}["']?`
const SECRET_KV_RE = new RegExp(
  `(${SECRET_KEY_QUOTED}\\s*[=:]\\s*)(?:(?:bearer|basic)\\s+)?("(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|[^\\s,;}\\]&]+)`,
  'gi'
)
const SECRET_BARE_SCHEME_RE = /\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]{8,})[^\s,;}\]]+/gi

// 保持值原有的引号形态（`"abc"` → `"***"`、`'abc'` → `'***'`、裸值 → `***`）
function maskSecretValue (value) {
  const quote = value[0] === '"' ? '"' : value[0] === "'" ? "'" : ''
  return quote ? `${quote}***${quote}` : '***'
}

function redact (text) {
  return safeString(text)
    .replace(SECRET_KV_RE, (_match, prefix, value) => prefix + maskSecretValue(value))
    .replace(SECRET_BARE_SCHEME_RE, '$1 ***')
    .replace(/\/bot[^/\s]+/gi, '/bot***')
}

function readProp (object, key) {
  try { return object && object[key] } catch (e) { return undefined }
}

function statusCodeOf (error) {
  const response = readProp(error, 'response')
  const candidates = [
    readProp(error, 'statusCode'),
    readProp(response, 'statusCode'),
    readProp(response, 'status')
  ]
  for (const value of candidates) {
    const n = Number(value)
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n
  }
  return null
}

function codeOf (error) {
  if (!error || typeof error !== 'object') return ''
  const code = readProp(error, 'code')
  return typeof code === 'string' || typeof code === 'number' ? String(code).toUpperCase() : ''
}

// 聚合失败的子结构可能来自外部上报或通道适配器拼接，既可能自引用也可能极深。
// 本模块对调用方承诺“不抛异常”，因此递归统一带上祖先集合 + 深度上限：
// 命中环或超深时截断为可读标记（标记本身只会落进 UNKNOWN → retryable，不会误判永久）。
const MAX_FAILURE_DEPTH = 5
const TRUNCATED_FAILURE_MESSAGE = '[嵌套失败结构过深或自引用，已截断]'

function depthExceeded (value, ancestors, depth) {
  if (depth > MAX_FAILURE_DEPTH) return true
  return Boolean(ancestors && ancestors.has(value))
}

// qodo #147-11：failures 可能来自敌意对象——Array.isArray 对 **revoked proxy** 会抛 TypeError，
// 索引 getter 抛错的数组在遍历时也会抛，二者都会让本模块的「绝不抛异常」契约失效。
// 凡是「判定是否为数组 + 取元素」都统一走这里：任何一步失败即返回 null（调用方按「没有该数组」处理）。
// CodeRabbit PR #147：**不要用 Array.prototype.slice.call(value)** —— 它对数组子类会走 Symbol.species，
// 自定义 species 可让它返回一个没有 .map 的对象，于是后续 .map(...) 在 try 之外抛 TypeError。
// 改为在 try 内把元素逐个拷进一个新建的普通数组，确保返回值恒为真数组。
function safeArray (value) {
  try {
    if (!Array.isArray(value)) return null
    const copy = []
    for (let i = 0; i < value.length; i++) copy.push(value[i])
    return copy
  } catch (e) { return null }
}

// XFP-05/XFP-06：failureInfo 透传前与常规路径同口径清洗（脱敏 + 折叠换行 + 截断），
// 而不是直接浅拷贝——否则 failureInfo 里的凭据会绕过清洗链原样带出，
// 且自引用结构会抛 RangeError 破坏本模块的“不抛”契约。
// 逐字段用 readProp 读取，getter/proxy 抛错时降级为 undefined，不让摘要读取把调用方带崩。
function sanitizeFailureInfo (info, ancestors, depth) {
  if (depthExceeded(info, ancestors, depth)) return { message: TRUNCATED_FAILURE_MESSAGE }
  // CodeRabbit PR #147：用无原型对象承载清洗结果——若 info 带一个可枚举的自有 `__proto__` 字段，
  // 写进普通对象会改写原型，随后 classifyOne 读到的 `info.failureKind` / `code` 可能是**继承**来的
  // 伪造值（例如伪造 failureKind:'permanent' 让本可重试的失败被误判为永久并停止重试）。
  const sanitized = Object.create(null)
  let keys = []
  try { keys = Object.keys(info) } catch (e) { keys = [] }
  for (const key of keys) {
    const value = readProp(info, key)
    if (key === 'failures') {
      // qodo #147-11：failures 可能来自敌意对象——Array.isArray 对 **revoked proxy** 会抛
      // TypeError，索引 getter 抛错的数组在 .map 遍历时也会抛，二者都会让 summarizeError 逃逸，
      // 违反本模块「绝不抛」契约（旧实现是浅拷贝，不遍历该数组，故无此风险）。
      // 统一经 safeArray 取值：任何一步失败即退回原值透传（不遍历）。
      const items = safeArray(value)
      if (items !== null) {
        const childAncestors = new Set(ancestors || [])
        childAncestors.add(info)
        sanitized.failures = items.map(item => summarizeError(item, childAncestors, depth + 1))
        continue
      }
    }
    if (typeof value !== 'string') {
      sanitized[key] = value
      continue
    }
    // message/reason 与常规路径一致：折叠换行并截断；其余字符串只做脱敏，保留原值语义。
    sanitized[key] = key === 'message' || key === 'reason' || key === 'failureReason'
      ? redact(value).replace(/[\r\n]+/g, ' ').slice(0, 500)
      : redact(value)
  }
  return sanitized
}

function summarizeError (error, ancestors, depth) {
  const level = Number.isInteger(depth) && depth > 0 ? depth : 0
  const failureInfo = readProp(error, 'failureInfo')
  if (failureInfo && typeof failureInfo === 'object') {
    return sanitizeFailureInfo(failureInfo, ancestors, level)
  }
  const source = error && typeof error === 'object' ? error : { message: error }
  if (depthExceeded(source, ancestors, level)) return { message: TRUNCATED_FAILURE_MESSAGE }
  const rawProviderCode = readProp(source, 'providerCode')
  const rawChannel = readProp(source, 'channel')
  const rawName = readProp(source, 'name')
  const rawMessage = readProp(source, 'message') || readProp(source, 'reason') || source
  const info = {
    code: codeOf(source),
    name: rawName ? safeString(rawName).toUpperCase() : '',
    statusCode: statusCodeOf(source),
    providerCode: rawProviderCode === undefined || rawProviderCode === null ? '' : safeString(rawProviderCode),
    channel: rawChannel ? redact(rawChannel).slice(0, 40) : '',
    message: redact(rawMessage).replace(/[\r\n]+/g, ' ').slice(0, 500)
  }
  const sourceKind = readProp(source, 'failureKind')
  if (sourceKind === 'retryable' || sourceKind === 'permanent') {
    info.failureKind = sourceKind
    info.failureReason = readProp(source, 'failureReason') || ''
  }
  const failures = safeArray(readProp(source, 'failures'))
  if (failures) {
    // 祖先集合按路径复制（不是共享可变集合），保证同一子对象作为兄弟节点重复出现时仍完整展开。
    const childAncestors = new Set(ancestors || [])
    childAncestors.add(source)
    info.failures = failures.map(item => summarizeError(item, childAncestors, level + 1))
  }
  return info
}

function codeIs (code, set) {
  return Boolean(code && set.has(String(code).toUpperCase()))
}

function classifyOne (error) {
  const info = summarizeError(error)

  // 结构化聚合错误优先递归：顶层可能只保留“token 无效”等永久摘要，
  // 但子通道仍可能有超时/限流。只要任一子错误可重试，就必须保留重试机会。
  const nestedFailures = safeArray(info.failures)
  if (nestedFailures && nestedFailures.length > 0) {
    const nested = nestedFailures.map(classifyOne)
    if (nested.some(x => x.kind === 'retryable')) {
      // 全部子项都可重试时并非“原因混合”，标成 MIXED 会让诊断失真；kind 不变，只分清 reason。
      const allRetryable = nested.every(x => x.kind === 'retryable')
      return { kind: 'retryable', reason: allRetryable ? 'ALL_CHANNELS_RETRYABLE' : 'MIXED_CHANNEL_FAILURES', info }
    }
    // classifyOne 只返回 retryable|permanent：走到这里说明不存在 retryable 子项，即全永久。
    // 原 UNKNOWN_CHANNEL_FAILURE 分支（nested.some(x => x.kind !== 'permanent')）恒 false，已移除。
    return { kind: 'permanent', reason: 'ALL_CHANNELS_PERMANENT', info }
  }

  if (info.failureKind === 'retryable' || info.failureKind === 'permanent') {
    return { kind: info.failureKind, reason: info.failureReason || 'EXPLICIT', info }
  }
  const code = String(info.code || '').toUpperCase()
  const status = Number.isInteger(info.statusCode) ? info.statusCode : null
  const errorName = String(info.name || '').toUpperCase()
  const providerCode = String(info.providerCode || '').toUpperCase()
  const channel = String(info.channel || '').toLowerCase()
  const message = String(info.message || '').toLowerCase()
  const permanentMessage = /接口返回数据格式异常|未配置任何推送通道|invalid\s+url|module\s+not\s+found|证书.*(主机|域名)|主机名.*证书/.test(message) ||
        /(?:unauthori[sz]ed|forbidden|bad request|not found|invalid\s+(?:(?:webhook|access|api)\s+)?(?:token|key|parameter)|(?:token|key|密钥).*(?:invalid|invalidated|无效|错误|不存在|过期))/.test(message) ||
        /(?:参数|配置).*(?:错误|无效|非法)/.test(message) ||
        /(?:certificate has expired|certificate is not yet valid|self[- ]signed certificate|unable to verify the first certificate|unable to get (?:[a-z0-9_-]+\s+)*issuer certificate|certificate signature failure|certificate (?:has been )?revoked)/.test(message) ||
        /(?:证书(?:已)?(?:过期|失效|吊销)|证书尚未生效|自签名证书|无法获取(?:本地)?(?:颁发者证书|证书颁发者)|证书签名(?:校验)?失败)/.test(message)

  if (errorName === 'SYNTAXERROR' || errorName === 'REFERENCEERROR') {
    return { kind: 'permanent', reason: errorName, info }
  }
  if (codeIs(code, RETRYABLE_CODES)) return { kind: 'retryable', reason: code, info }
  if (codeIs(code, PERMANENT_CODES)) return { kind: 'permanent', reason: code, info }
  if (channel.includes('wxpusher') && providerCode) {
    if (providerCode === '1001' || /(?:限流|限频|rate.?limit|速度太快)/.test(message)) {
      return { kind: 'retryable', reason: 'WXPUSHER_RATE_LIMIT', info }
    }
    return { kind: 'permanent', reason: `WXPUSHER_${providerCode}`, info }
  }
  if (channel.includes('企业微信') && providerCode) {
    if (providerCode === '45009') {
      return { kind: 'retryable', reason: 'QYWX_RATE_LIMIT', info }
    }
    // v3.232：仅明确配置类错误判永久（key/token 无效、缺 token、无权限、webhook 未找到）；
    // 其余（如 500 系统繁忙）落回通用分类（5xx → retryable），防瞬时错误误判永久导致常驻停止重试、消息丢失
    // XFP-02：补 93000（群机器人 invalid webhook key）——webhook key 无效是配置类永久错误，
    // 落在 UNKNOWN 会让常驻永久退避重试同一个失效 webhook（每轮都失败且永不停止）。
    if (['40014', '41001', '42001', '45001', '130101', '93000'].includes(providerCode)) {
      return { kind: 'permanent', reason: `QYWX_${providerCode}`, info }
    }
  }
  if (permanentMessage) {
    return { kind: 'permanent', reason: 'CONFIG_OR_CONTRACT', info }
  }
  const numericCode = Number(code)
  if (code === '1001' || code === '429' || (Number.isInteger(numericCode) && numericCode >= 500 && numericCode <= 599)) {
    return { kind: 'retryable', reason: `PROVIDER_${code}`, info }
  }
  if (Number.isInteger(numericCode) && numericCode >= 400 && numericCode < 500) {
    return { kind: 'permanent', reason: `PROVIDER_${code}`, info }
  }
  if (providerCode === '1001' || /(?:限流|限频|rate.?limit)/.test(message)) {
    return { kind: 'retryable', reason: 'PROVIDER_RATE_LIMIT', info }
  }
  const providerNumber = Number(providerCode)
  if (Number.isInteger(providerNumber) && providerNumber >= 400 && providerNumber < 500) {
    return { kind: 'permanent', reason: `PROVIDER_${providerNumber}`, info }
  }
  if (Number.isInteger(providerNumber) && providerNumber >= 500 && providerNumber <= 599) {
    return { kind: 'retryable', reason: `PROVIDER_${providerNumber}`, info }
  }
  if (code.startsWith('HTTP_')) {
    const n = Number(code.slice(5))
    if (n === 408 || n === 409 || n === 425 || n === 429 || n >= 500) {
      return { kind: 'retryable', reason: code, info }
    }
    if (n >= 400 && n < 500) return { kind: 'permanent', reason: code, info }
  }
  if (status !== null) {
    if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
      return { kind: 'retryable', reason: `HTTP_${status}`, info }
    }
    if (status >= 400 && status < 500) return { kind: 'permanent', reason: `HTTP_${status}`, info }
  }

  if (/(?:timeout|timed out|超时|econn|eai_again|enet|ehost|epipe|socket|rate.?limit|限流|限频|暂时|服务.*(?:不可用|繁忙)|连接.*(?:失败|重置))/.test(message)) {
    return { kind: 'retryable', reason: 'TRANSIENT_TEXT', info }
  }

  // 未知错误默认可重试：重复几轮的代价低于误判后永久漏推。
  return { kind: 'retryable', reason: 'UNKNOWN', info }
}

function classifyFailure (error) {
  const explicitKind = readProp(error, 'failureKind')
  const nested = safeArray(readProp(error, 'failures'))
  // 聚合失败的子错误优先于父级预填标签，避免父级 permanent 覆盖子级 retryable。
  if ((explicitKind === 'retryable' || explicitKind === 'permanent') && !(nested && nested.length > 0)) {
    return { kind: explicitKind, reason: readProp(error, 'failureReason') || 'EXPLICIT', info: summarizeError(error) }
  }
  return classifyOne(error)
}

function classifySummary (summary) {
  if (!summary || typeof summary !== 'object') return null
  const pushed = Number(summary.pushed) || 0
  const failed = Number(summary.failed) || 0
  // XFP-03：「有没有失败」只由 failed 决定。旧条件写作 `total <= 0 || failed <= 0`，而
  // total 来自 `Number(summary.total) || 0`——total 缺失、非数字（或恰好为 0）时即为 0，
  // 于是一个「报了失败但没报 total / total 非数字」的摘要被判成「无失败」返回 null，
  // 调度器据此读成成功（绿色），失败被静默吞掉。total 只描述本轮规模，不参与该判定。
  if (failed <= 0) return null
  const failures = safeArray(readProp(summary, 'failures')) || []
  if (failures.length === 0) {
    return pushed > 0
      ? null
      : { kind: 'retryable', reason: 'ALL_PUSH_FAILED_UNKNOWN', info: { message: '推送全部失败（原因未结构化）' } }
  }
  // 主流程契约：一条消息至少有一个通道成功即视为该消息处理成功。
  // 因此只要本轮已有成功推送，就不能因另一个通道的永久错误让单次/常驻入口熔断；
  // 失败通道不对该条消息立即重试，避免重复轰炸。只有全失败才进入退出/重试分类。
  if (pushed > 0) return null
  const nested = failures.map(classifyOne)
  const hasRetryable = nested.some(x => x.kind === 'retryable')
  const hasPermanent = nested.some(x => x.kind === 'permanent')
  // 全部失败时，混合原因中只要还有可恢复通道，就不能过早永久停止；
  // 只有不存在可重试原因时，永久错误才足以停止。
  if (hasRetryable) {
    return { kind: 'retryable', reason: 'PUSH_HAS_RETRYABLE_FAILURE', info: { failures: nested.map(x => x.info) } }
  }
  if (hasPermanent) {
    return { kind: 'permanent', reason: 'PUSH_HAS_ONLY_PERMANENT_FAILURES', info: { failures: nested.map(x => x.info) } }
  }
  // 全部失败且无法分类：保守重试，避免未知错误造成永久漏推。
  return { kind: 'retryable', reason: 'PUSH_HAS_UNKNOWN_FAILURE', info: { failures: nested.map(x => x.info) } }
}

module.exports = {
  RETRYABLE_CODES,
  PERMANENT_CODES,
  summarizeError,
  classifyFailure,
  classifySummary
}
