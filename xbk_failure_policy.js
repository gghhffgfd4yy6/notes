'use strict'

// 常驻运行失败分类：把可波动的网络/服务故障与不可恢复的配置/契约故障分开。
// 默认未知错误按可重试处理，遵守“宁可重复，不可丢失”的主流程原则。

const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED',
  'ABORT_ERR', 'HTTP_408', 'HTTP_409', 'HTTP_425', 'HTTP_429',
  // XHTTP-05：空响应体（含剥离 BOM 后的空体、纯空白体）单列可重试码。上游「连上后未写体即结束」是
  // 典型瞬时故障（网关/后端抖动），重试一次通常即可恢复；而「返回了内容但不是 JSON」是合约性错误
  // （ERR_BODY_NOT_JSON，仍在 PERMANENT_CODES）。旧实现两者共用一个码 → 一次瞬时空体被判永久停推。
  // 显式列进本集合（而不是留空让它落 UNKNOWN）是为了让口径可审计：归类理由即本码本身，
  // 不依赖「未知默认保守重试」的兜底，避免日后有人收紧兜底时语义被静默翻转。
  'ERR_EMPTY_BODY'
])

const PERMANENT_CODES = new Set([
  'ERR_INVALID_URL', 'ERR_BODY_NOT_JSON', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_ARG_TYPE',
  // C8-004：响应体超过本地上限（xbk_http.fetchJson 与推送出口 xbk_sendNotify_slim.$.post 用的同一个码）。
  // 此前它不在任何集合里 → 落 UNKNOWN 判可重试，常驻每轮重新下载同一个 20MB+ 响应体、在同一处再失败。
  // 重试同一请求的结果必然相同（与 ERR_BODY_NOT_JSON 同属「响应内容不合契约」的确定性错误），故归永久。
  'EBODYLIMIT',
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

// XFP-04（含独立对抗审查 A 组与 qodo #152 的补漏）：脱敏必须**整体**抹掉凭据，且要覆盖写法差异。
// 一条键值规则 + 一条裸 scheme 规则，比按形态堆多条正则更好推理，也不会出现「前一条把后一条的
// 输入改掉」的耦合。
//
// 键值规则：`<关键字(可带引号)> < = | : > [scheme] <值>`，值三种形态（顺序即优先级）：
//  ① `"…"` / `'…'`  引号值，按 JSON 转义语义吃完整串——用「遇引号即停」会把值内的转义引号当收尾
//     引号、只抹前半段（qodo #151-1：`{"appToken":"abc\"SECRET"}` 残留 `SECRET`）；未闭合的引号值
//     吞到串尾，同样整段抹掉（否则 `token="x` 整段漏抹）。单引号形态同构。
//  ② `[…]` / `{…}`  **结构化值**（数组/对象），含值内的引号串与逗号。qodo #152-1：旧规则的裸值
//     分支遇 `,`/`}`/`]` 即停，`token=[0,"SECRET"]` 只抹到 `token=***,"SECRET"]`、
//     `token={"a":"SECRET"}` 只抹到 `token=***}`，凭据仍进日志。引号串按转义语义整段跳过，收尾
//     括号取第一个不在引号串内的；括号未闭合的（如 `token=[1,2`）落回下面的裸值分支，不会吞掉
//     后续文本；引号串本身未闭合时括号边界已不可判定，一律吞到串尾——只会多抹，旧实现在
//     `token=[0,"SECRET]` 上同样是整段抹掉。
//  ③ `[^\s,;}\]&]+`  裸值，含非字符串 JSON 值（`{"token":12345}`）。分隔符 `\s,;}\]&` 是
//     **有意收窄**：逗号/分号/& 之后属于下一个参数（`?token=a,b` 只抹 `a`），该行为有断言锁定。
//  值以引号开头时按原引号形态回填（`"***"` / `'***'`），保持 JSON/JS 结构可读；
//  已脱敏值（`***`）不会被二次处理——回调按值重新生成，天然幂等。
//
// 关键字边界（qodo #152-3）：关键字两侧**必须**是字符串/文本边界，否则「关键字」可能只是更长字段名
//   的后缀——`{"monkey":"business"}` 里的 `key`、`{"turkey":"dinner"}` 里的 `key` 都会被误当成凭据键，
//   把无关的普通字段抹掉。边界 = 串首/串尾或非标识符字符（`[A-Za-z0-9_]`），关键字内部的 `_`/`-`
//   仍照常匹配（`app_token`/`refresh-token`）。
//
// 裸 scheme 规则：无关键字的 `Bearer|Basic <凭据>`（如上游把 Authorization 头值回显进 message）。
//  凭据可被引号包住（qodo #152-2：`Basic "YWJjOmRlZg=="` 旧规则整体不命中）；判定长度时剥掉引号，
//  要求 ≥8 个凭据字符——否则普通英文句子 `the bearer of good news` 会被误抹（A 组反例）。
const SECRET_KEY = '(?:app[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|pushkey|authorization|credential|password|passwd|pwd|session|cookie|token|key|secret)'
// 关键字本身可能是引用形态（双引号 JSON / 单引号 JS 字面量），两侧加边界断言
const SECRET_KEY_QUOTED = `(?:^|[^A-Za-z0-9_])["']?${SECRET_KEY}["']?(?![A-Za-z0-9_])`
// C9-001（P0）：值的边界**不再用正则取**。旧实现把「收尾引号可选」的引号串塞进数组/对象的量词里
//   （`\[(?:[^\]"']|"(?:[^"\\]|\\.)*"?|…)*\]`）：同一个 `"` 既可以是开引号、又可以是上一个串的收尾
//   引号，括号配不上时回溯树按元素数指数增长。实测 `token=[` + `"a",`×n 的耗时 n=9/43B→101ms、
//   10→610ms、11→3.33s、12→19.28s（每多一个元素约 ×5.5），199B（48 个元素）30s 未返回——一条畸形
//   厂商错误信息就能把整轮推送挂死（厂商 `data.msg` → safeErr 截到 200 字符 → Error → classifyFailure
//   → summarizeError → redact，正好落在主线程上）。
//   现在只保留「关键字 + 分隔符」的前缀正则（无嵌套量词，线性），值的结束位置由下面的单趟扫描给出：
//   每个字符只前进一次、引号串按转义语义整段跳过 ⇒ 严格 O(n)，不存在指数回溯路径。
const SECRET_KV_PREFIX_RE = new RegExp(`(${SECRET_KEY_QUOTED}\\s*[=:]\\s*)(?:(?:bearer|basic)\\s+)?`, 'gi')
// 裸值字符集：分隔符 `\s,;}\]&` 与旧正则完全一致（见上方 ③）
const BARE_VALUE_CHAR_RE = /[^\s,;}\]&]/

// 引号串：text[start] 是引号，返回收尾引号之后的下标；未闭合返回 -1。
// 转义（`\"`）整段跳过，与旧正则 `\\.` 同义——不能把转义引号当收尾（qodo #151-1）。
function scanQuoted (text, start) {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === quote) return i + 1
  }
  return -1
}

// 结构化值（数组/对象）：返回收尾括号之后的下标；括号未闭合返回 -1（调用方落回裸值）。
// 括号内的引号串整段跳过；引号串本身未闭合时括号边界已不可判定。未配平时取**最后一个**同类括号
// 兜底——旧实现的引号分支「收尾引号可选」，同一个 `"` 可在开/收两种角色间互换，于是引号串**里面**的
// 收尾括号也会被当成数组收尾（实测 `token=[0,"S]"` 旧实现抹掉 `[0,"S]`）。兜底只在「一个可配平的
// 收尾括号都没有」时生效，一个括号都没有才落回裸值：只会多抹，不会少抹。
function scanBracket (text, start, closers) {
  const close = text[start] === '[' ? ']' : '}'
  // closers 缓存了全文最后一个同类收尾括号的下标（redact 每次调用只算一次）。这个值落在值起点之前
  // ⇒ 之后不可能再有收尾括号，扫描必然扫到串尾才失败：直接落回裸值，否则「N 处 `token=[…` + 后面
  // 再没有 `]`」的输入会退化成 O(键数 × 长度)。
  const lastCloser = closers[close]
  if (lastCloser <= start) return -1
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === close) return i + 1
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(text, i)
      if (end === -1) {
        // 引号串未闭合 ⇒ 括号边界不可判定：先按「最后一个同类括号」收尾（旧实现会拿引号里的括号当收尾），
        // 一个括号都没有才吞到串尾——只会多抹，不会少抹。
        return lastCloser > i ? lastCloser + 1 : text.length
      }
      // 不变量：scanQuoted 返回的是收尾引号之后的下标（≥ i + 2），所以这里 i 严格前进；
      // 若以后把 scanQuoted 改成可能返回 ≤ i，这一行会原地死循环——动它之前先确认这个前提。
      i = end
      continue
    }
    i += 1
  }
  // 走完仍没有可配平的收尾括号：取最后一个同类括号兜底（它只可能落在引号串里，旧实现会拿它当收尾）。
  return lastCloser + 1
}

// 值：返回结束下标（不含）；-1 表示该位置没有可抹的值（整条键值不成立，调用方跳过）。
function scanSecretValue (text, start, closers) {
  const head = text[start]
  if (head === '"' || head === "'") {
    const end = scanQuoted(text, start)
    return end === -1 ? text.length : end
  }
  if (head === '[' || head === '{') {
    const end = scanBracket(text, start, closers)
    if (end !== -1) return end
  }
  let end = start
  while (end < text.length && BARE_VALUE_CHAR_RE.test(text[end])) end++
  return end === start ? -1 : end
}

const SECRET_BARE_SCHEME_RE = /\b(bearer|basic)\s+("[A-Za-z0-9._~+/=-]{8,}"|'[A-Za-z0-9._~+/=-]{8,}'|[A-Za-z0-9._~+/=-]{8,})/gi

// 保持值原有的引号形态（`"abc"` → `"***"`、`'abc'` → `'***'`、裸值 → `***`）
function maskSecretValue (value) {
  const quote = value[0] === '"' ? '"' : value[0] === "'" ? "'" : ''
  return quote ? `${quote}***${quote}` : '***'
}

function redact (text) {
  const input = safeString(text)
  // 全文最后一个收尾括号的下标（一次 O(n)，供上方 scanBracket 剪枝 + 兜底）
  const closers = { ']': input.lastIndexOf(']'), '}': input.lastIndexOf('}') }
  let out = ''
  let last = 0
  SECRET_KV_PREFIX_RE.lastIndex = 0
  let match
  while ((match = SECRET_KV_PREFIX_RE.exec(input)) !== null) {
    const prefix = match[1]
    let valueStart = match.index + match[0].length
    let valueEnd = scanSecretValue(input, valueStart, closers)
    // 前缀里的 scheme（`Bearer `）是可选的：旧实现在「认了 scheme 但后面没有值」时会退回不认 scheme
    // （`token=bearer ` 的 `bearer` 本身按裸值抹掉）。这里等价重试一次。
    if (valueEnd === -1 && match[0].length > prefix.length) {
      valueStart = match.index + prefix.length
      valueEnd = scanSecretValue(input, valueStart, closers)
    }
    if (valueEnd === -1) {
      SECRET_KV_PREFIX_RE.lastIndex = match.index + prefix.length
      continue
    }
    out += input.slice(last, match.index) + prefix + maskSecretValue(input.slice(valueStart, valueEnd))
    last = valueEnd
    SECRET_KV_PREFIX_RE.lastIndex = valueEnd
  }
  out += input.slice(last)
  return out
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

// XFP-01：4xx 里这几类不是「请求本身有问题」，而是暂时性语义（408 请求超时 / 409 冲突 /
// 425 过早 / 429 限流），与 RETRYABLE_CODES 里的 HTTP_408/409/425/429 是同一口径。
// 数字 code 与 providerCode 落在同一数值区间时必须按同一语义裁决：若只按「400<=n<500 → permanent」
// 无差别判定，同一 4xx 语义在不同承载字段下会分类相反，4xx 的限流/超时被误判永久而停止重试。
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429])

// C9-004：HTTP 状态码语义的**唯一判据**。此前 classifyOne 对四个承载字段（数字 code /
// providerCode / `HTTP_` 前缀 / statusCode）各写一遍区间判定，其中后两份还把
// `408 || 409 || 425 || 429` 内联重写、RETRYABLE_HTTP_STATUS 只覆盖一半——任一处漏改，
// 同一状态码在不同承载字段下分类相反，而每个分支的单测都能过，口径分叉没有任何断言能发现。
// 返回 'retryable' / 'permanent' / null（不属于 HTTP 状态码语义）。
// 5xx 上界固定 599（statusCodeOf 只接受 100-599）。旧实现的 `n >= 500` 没有上界，'HTTP_600'
// 这类越界伪码会被判成可重试并记 reason=HTTP_600；现在落 null → 走兜底 UNKNOWN（同样可重试，
// 但不再声称它是 HTTP 状态码）。
function classifyHttpStatus (n) {
  if (!Number.isInteger(n)) return null
  if (RETRYABLE_HTTP_STATUS.has(n) || (n >= 500 && n <= 599)) return 'retryable'
  if (n >= 300 && n <= 399) return 'permanent'
  if (n >= 400 && n <= 499) return 'permanent'
  return null
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
  // XHTTP-06：终态 3xx 是**确定性**结果——got 默认跟随重定向，外层还能看到终态 3xx 只有三种可能：
  // followRedirect:false、3xx 不带 Location、或 304 Not Modified；重试同一个 URL 仍会得到同一个 3xx，
  // 故归 permanent（配置/契约类），与 4xx 同侧。此前它在四种承载字段（数字 code、providerCode、
  // HTTP_ 前缀、statusCode）下都落 UNKNOWN → 可重试，而 HTTP 层把终态 3xx 归成 ERR_BODY_NOT_JSON（永久）
  // ——同一状态码在「错误码字符串」与「statusCode」两条路径上分类相反。这里按区间统一，不逐条枚举
  // （HTTP_300-399 共 100 项）。
  // C9-004：四个承载字段统一走 classifyHttpStatus，语义只有一份实现。
  const numericCode = Number(code)
  const codeVerdict = classifyHttpStatus(numericCode)
  if (code === '1001' || codeVerdict === 'retryable') {
    return { kind: 'retryable', reason: `PROVIDER_${code}`, info }
  }
  if (codeVerdict === 'permanent') {
    return { kind: 'permanent', reason: `PROVIDER_${code}`, info }
  }
  if (providerCode === '1001' || /(?:限流|限频|rate.?limit)/.test(message)) {
    return { kind: 'retryable', reason: 'PROVIDER_RATE_LIMIT', info }
  }
  const providerNumber = Number(providerCode)
  const providerVerdict = classifyHttpStatus(providerNumber)
  if (providerVerdict === 'retryable') {
    return { kind: 'retryable', reason: `PROVIDER_${providerNumber}`, info }
  }
  if (providerVerdict === 'permanent') {
    return { kind: 'permanent', reason: `PROVIDER_${providerNumber}`, info }
  }
  if (code.startsWith('HTTP_')) {
    const verdict = classifyHttpStatus(Number(code.slice(5)))
    if (verdict === 'retryable') return { kind: 'retryable', reason: code, info }
    if (verdict === 'permanent') return { kind: 'permanent', reason: code, info }
  }
  if (status !== null) {
    const verdict = classifyHttpStatus(status)
    if (verdict === 'retryable') return { kind: 'retryable', reason: `HTTP_${status}`, info }
    if (verdict === 'permanent') return { kind: 'permanent', reason: `HTTP_${status}`, info }
  }

  if (/(?:timeout|timed out|超时|econn|eai_again|enet|ehost|epipe|socket|rate.?limit|限流|限频|暂时|服务.*(?:不可用|繁忙)|连接.*(?:失败|重置))/.test(message)) {
    return { kind: 'retryable', reason: 'TRANSIENT_TEXT', info }
  }

  // 未知错误默认可重试：重复几轮的代价低于误判后永久漏推。
  return { kind: 'retryable', reason: 'UNKNOWN', info }
}

// XFP-05：聚合失败的子错误可以挂在两个位置上——错误对象自身（error.failures）或
// failureInfo.failures（qinglong 适配器把子通道结果放进 failureInfo 上报）。父级标签的
// 「子级可重试优先」仲裁必须对两者一视同仁，否则同一形状换个承载字段就分类相反：
// {failureKind:'permanent', failures:[{code:'ETIMEDOUT'}]} → retryable，
// 而 {failureKind:'permanent', failureInfo:{failures:[{code:'ETIMEDOUT'}]}} → permanent（停止重试、漏推）。
function nestedFailuresOf (error) {
  const direct = safeArray(readProp(error, 'failures'))
  if (direct && direct.length > 0) return direct
  const info = readProp(error, 'failureInfo')
  if (!info || typeof info !== 'object') return null
  const viaInfo = safeArray(readProp(info, 'failures'))
  return viaInfo && viaInfo.length > 0 ? viaInfo : null
}

function classifyFailure (error) {
  const explicitKind = readProp(error, 'failureKind')
  const nested = nestedFailuresOf(error)
  // 聚合失败的子错误优先于父级预填标签，避免父级 permanent 覆盖子级 retryable。
  if ((explicitKind === 'retryable' || explicitKind === 'permanent') && !(nested && nested.length > 0)) {
    return { kind: explicitKind, reason: readProp(error, 'failureReason') || 'EXPLICIT', info: summarizeError(error) }
  }
  return classifyOne(error)
}

// C9-003：`Number(summary.failed) || 0` 把「缺失 / NaN / 非数字」一律洗成 0——「报了 failures 但没报计数」
// 的摘要因此落进 failed<=0 分支被判成功（退出码 0，失败被静默吞掉）。计数只描述规模，不该是「有没有失败」
// 的唯一证据：缺失/非法时用结构化 failures 的条数兜底（有多少条失败原因就至少有多少条没送达）。
// 显式合法计数（含 0）仍然优先——`failed: 0` 是上报方的明确断言（dry-run 就是这种口径），不在这里翻案。
// **先校验类型再转换**：Number() 是强制转换而非解析，null / '' / 纯空白 / [] / false 都不抛错，而是被
// 转成 0——「没上报计数」与「明确 0 条失败」被混为一谈，同一票面只把 failed 换个类型就能重新落进
// failed<=0 判成功。故只接受 number（有限、非负）或「非空、可整体转成非负有限数字」的字符串，
// null / '' / 纯空白串 / 数组 / 布尔 / 对象 / Symbol 一律按非法处理 → 回落 failures 条数。
// try 保留：Symbol 等类型会让 Number() 抛 TypeError，本模块「绝不抛」契约不能破（取值也可能来自
// 敌意 getter，readProp 已兜住，这里仍按非法计数收口）。
function failureCountOf (summary, failures) {
  const fallback = failures.length
  try {
    const raw = readProp(summary, 'failed')
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : fallback
    if (typeof raw === 'string') {
      const text = raw.trim()
      if (text === '') return fallback
      const n = Number(text)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    }
  } catch (e) { /* 非法计数：落到 failures 条数 */ }
  return fallback
}

function classifySummary (summary) {
  if (!summary || typeof summary !== 'object') return null
  const pushed = Number(summary.pushed) || 0
  const failures = safeArray(readProp(summary, 'failures')) || []
  const failed = failureCountOf(summary, failures)
  // C9-002：cacheSaved 此前从未被分类器读取——消息确实推出去了、但成功记录没落盘，下次运行会重复
  // 推送（另一半是「推送成功但缓存丢了」），运维却只能看到绿色退出码。落盘失败优先判定：它不是
  // 通道问题，重试即可恢复，故归 retryable/CACHE_SAVE_FAILED。
  if (readProp(summary, 'cacheSaved') === false) {
    return {
      kind: 'retryable',
      reason: 'CACHE_SAVE_FAILED',
      info: { message: '缓存落盘失败：本轮推送成功记录未写入，下次运行会重复推送' }
    }
  }
  // XFP-03：「有没有失败」只由 failed 决定。旧条件写作 `total <= 0 || failed <= 0`，而
  // total 来自 `Number(summary.total) || 0`——total 缺失、非数字（或恰好为 0）时即为 0，
  // 于是一个「报了失败但没报 total / total 非数字」的摘要被判成「无失败」返回 null，
  // 调度器据此读成成功（绿色），失败被静默吞掉。total 只描述本轮规模，不参与该判定。
  // C9-003：failed 的口径见 failureCountOf——缺失/非法的计数不再被洗成 0，非空 failures 即为失败证据。
  if (failed <= 0) return null
  // C9-002：pushed/failed 都是**消息**级计数——pushed>0 只说明「本轮不是全灭」，不说明「没有失败」。
  // 旧实现只要 pushed>0 就返回 null（1 条成功 + 99 条失败 → 退出码 0、告警不触发、99 条被静默吞掉）。
  // 部分失败同样是失败：给出 degraded 判定让入口置非零退出码并告警。kind 固定 retryable——还有消息
  // 没送达就必须下轮重试；若判 permanent，常驻入口会整轮停止，把后续新消息一起停掉（漏推）。
  // PR #362：常驻入口不得把本判定当成整轮失败叠加指数退避——那会让一条长期送不出去的消息连新消息
  // 的拉取一起拖到 30 分钟；qinglong/xbk_push.js 的 handleFailure 对 PARTIAL_MESSAGE_FAILURE 单独分流。
  if (pushed > 0) {
    const nested = failures.map(classifyOne)
    return {
      kind: 'retryable',
      reason: 'PARTIAL_MESSAGE_FAILURE',
      info: {
        message: `部分消息推送失败：成功 ${pushed} 条，失败 ${failed} 条`,
        failures: nested.map(x => x.info)
      }
    }
  }
  if (failures.length === 0) {
    return { kind: 'retryable', reason: 'ALL_PUSH_FAILED_UNKNOWN', info: { message: '推送全部失败（原因未结构化）' } }
  }
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
