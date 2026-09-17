'use strict'

// 🌐 Network — 网络请求层（从 xbk_function_v3.js 独立准备，暂不接入主入口）
// 依赖全部由组合根注入，避免反向 require 主入口及重复单例。
//
// net-1：PERMANENT_CODES 目前组合根尚未接线（xbk_function_v3.js 只注入 RETRYABLE_CODES），缺省回落到
// xbk_failure_policy 的同名导出——该模块是无状态常量/纯函数模块，直接 require 不产生反向依赖或重复
// 单例；若日后组合根改为显式注入，注入值优先，语义不变。
const { PERMANENT_CODES: POLICY_PERMANENT_CODES } = require('./xbk_failure_policy')

// net-1：请求层本地「确定性失败」码——重试同一个请求不会改变结果（响应体超过 maxBody 是确定性的），
// 但 xbk_failure_policy 未把该码列进 PERMANENT_CODES（该模块对未知码按「保守重试」处理，见其头部口径），
// 故只在请求层单列，不改动失败分类模块的语义（常驻循环仍按策略归类决定下一轮）。
const DETERMINISTIC_LOCAL_CODES = new Set(['EBODYLIMIT'])

// net-3：请求超时的合法性口径——只有「≥100ms 的整数」才采用，其余一律回落默认 5000ms 并告警：
//   * got 把数值 timeout 直接交给定时器，小数与超 2^31-1 的值会被 Node 归一到约 1ms（每次请求瞬间超时）；
//   * 亚 100ms 的值几乎只可能来自「想写秒却按毫秒填」的单位误填（timeout:5 想表达 5 秒）——采用它等于
//     每次请求必然超时，且现象是「请求超时」而非「配置有问题」，比回落默认值更糟；
//   * 非整数不猜用户意图（不四舍五入/不向上取整），一律按非法配置处理；
//   * 整数但越上界（1e12、2147483648…）钳到 2^31-1 并**告警留痕**（不静默）——钳制值语义不变。
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 2147483647
const DEFAULT_TIMEOUT_MS = 5000

// net-7：重试退避上限（指数退避与 Retry-After 两条路径共用）。上游给出天文数字的等待时不得把单轮
// fetchData 挂死；30s 也足以覆盖限流窗口内的常规 Retry-After。
const RETRY_BACKOFF_CAP_MS = 30000

// net-7：Retry-After 只认 RFC 9110 §10.2.1 明列的三种 HTTP-date 形态（诚实实现 MUST 接受全部三种）：
//   IMF-fixdate   Sun, 06 Nov 1994 08:49:37 GMT
//   rfc850-date   Sunday, 06-Nov-94 08:49:37 GMT        （obs-date）
//   asctime-date  Sun Nov  6 08:49:37 1994              （obs-date）
// 先把形态卡死再用 Date.parse 取值：Date.parse 的接受面太大（'5 Oct'、ISO-8601 '2026-09-17T00:00:00Z'
// 都能解析），它们被当成「已过期」钳成 0 后，日志会输出「0s 后重试（按 Retry-After）」——谎报来源，
// 而修前这些输入走指数退避 1s。故非上述形态一律 null，回落指数退避，不做宽松猜测。
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/
// delta-seconds（RFC 9110 的 1*DIGIT）上界：超过 2^31-1 秒（≈68 年）不可能是真实回访时刻，
// 按非法形态处理（Number 为 Infinity 的数字串同理），不把垃圾头当有效来源。
const MAX_DELTA_SECONDS = 2147483647

// net-7：解析 Retry-After（RFC 9110：delta-seconds 非负整数，或上述三种 HTTP-date）→ 毫秒。
// 只认这两种合法形态，其余（空串、'1.5'、'-5'、非日期文本、ISO-8601）返回 null 交由指数退避兜底——
// 不做宽松猜测，避免把笔误当成等待时长。HTTP-date 已过期 → 0（立即重试，语义同 RFC）。
function parseRetryAfterMs (value, now = Date.now()) {
  if (value === undefined || value === null) return null
  const raw = String(value).trim()
  if (raw === '') return null
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw)
    if (!Number.isFinite(seconds) || seconds > MAX_DELTA_SECONDS) return null
    return seconds * 1000
  }
  if (!IMF_FIXDATE_RE.test(raw) && !RFC850_DATE_RE.test(raw) && !ASCTIME_DATE_RE.test(raw)) return null
  // asctime-date 无时区标记，Date.parse 会按**本地时区**解释（实测 UTC+8 下同一串差 8 小时）；
  // RFC 9110 规定 HTTP-date 一律 GMT，故显式补 GMT 再解析，避免把服务端给出的回访时刻按本地时区算错。
  const asctime = ASCTIME_DATE_RE.test(raw)
  const at = Date.parse(asctime ? raw + ' GMT' : raw)
  if (!Number.isFinite(at)) return null
  // 星期与日期必须一致（RFC 9110 的 HTTP-date 里 day-name 由日期导出）：
  // IMF-fixdate / asctime 都是 4 位年、无歧义，交叉校验；rfc850 的 2 位年由引擎按 ECMAScript 的
  // 50 年切点解释（yy=50..76 与 RFC 9110 的「不超 50 年未来」规则不同），不做交叉校验以免误拒。
  if (!RFC850_DATE_RE.test(raw)) {
    const actualName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(at).getUTCDay()]
    if (raw.slice(0, 3) !== actualName) return null
  }
  return Math.max(0, at - now)
}

// net-7：从错误对象上取 Retry-After。真实链路（xbk_http/got）给的是小写键的普通对象，兼容 WHATWG Headers。
function readRetryAfterMs (e, now = Date.now()) {
  const headers = e && e.response && e.response.headers
  if (!headers) return null
  const value = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after']
  return parseRetryAfterMs(value, now)
}

function createNetwork ({
  Config,
  Utils,
  fetchJson,
  prewarmDns,
  getNotify,
  crypto,
  RETRYABLE_CODES,
  PERMANENT_CODES = POLICY_PERMANENT_CODES,
  PKG_VERSION = '3.x',
  PROFILE3 = false,
  logger = console
}) {
  // net-3：解析 api.timeout（口径见文件头 MIN_TIMEOUT_MS 说明）。被判非法的值不静默——告警留痕，便于把
  // 「请求超时」定位回「配置有问题」（非数值输入经 Utils.num 已回落到默认，与合法填写的默认值不可区分，
  // 保持原语义不告警）；注入的 logger 未提供 warn 时退化为不告警（不得因此抛错）。
  const resolveTimeoutMs = () => {
    const n = Utils.num(Config.api.timeout, DEFAULT_TIMEOUT_MS)
    if (Number.isInteger(n) && n >= MIN_TIMEOUT_MS) {
      // net-3 残留（V4 提示）：越上界的整数（1e12、2147483648…）此前是**静默钳制**——值与日志都看不出
      // 「配置写了不可能生效的值」。这里只补告警留痕，钳制语义零变更（仍钳到 MAX_TIMEOUT_MS）。
      // 文案与「已回落默认」区分：调用方与测试可据文案判断是钳制还是回落。
      if (n > MAX_TIMEOUT_MS && typeof logger.warn === 'function') {
        logger.warn(`[xbk_network] api.timeout=${String(Config.api.timeout)} 超过上界 ${MAX_TIMEOUT_MS}ms，已钳制到 ${MAX_TIMEOUT_MS}ms`)
      }
      return Math.min(n, MAX_TIMEOUT_MS)
    }
    if (typeof logger.warn === 'function') {
      logger.warn(`[xbk_network] api.timeout=${String(Config.api.timeout)} 非法（须为 ≥${MIN_TIMEOUT_MS}ms 的整数），已回落默认 ${DEFAULT_TIMEOUT_MS}ms`)
    }
    return DEFAULT_TIMEOUT_MS
  }
  return {
    /**
       * 拉取数据，失败自动重试
       * 官方 got 自带 retry；这里显式关闭内置重试，由主流程统一实现重试、退避和 4xx 例外语义
     */
    async fetchData () {
      let lastErr
      // v3.223：延迟加载推送模块（含 got）——与接口请求并行，主流程不必先等模块加载完成
      getNotify().catch(() => { /* 加载失败由推送阶段真实报错，这里不阻塞接口 */ })
      // 线报接口 DNS 预热：与真实请求共用 xbk_agents.dnsLookup 缓存，提前启动解析、不阻塞请求启动。
      // 注意（net-2，AGENTS-01 后订正）：缓存/pending key 只含 hostname|family（xbk_agents.js:dnsCacheKey），
      // hints/all/verbatim 已不再进 key——hints/verbatim 只影响地址过滤与排序、不改变地址集合，all 只决定
      // 回调形状（由 dispatchLookupResult 适配）。本预热未传 options 时 family=0、XBK_DNS_FAMILY=4/6 时为
      // 4/6；真实请求的 family 同源（baseRequestOptions 的 dnsLookupIpVersion 同样只由 XBK_DNS_FAMILY 决定，
      // got 把它写进 requestOptions.family），故三种模式下预热与真实请求的 key 一致，预热条目可被真实请求
      // 命中。旧的「key 含 host|family|hints|all|verbatim、默认配置下两者不合并」口径已随 AGENTS-01 作废。
      // net-6：本预热未接 AbortSignal（prewarmDns 的 signal 参数走不到），因此无法被取消。
      try {
        const apiHost = new URL(Config.api.pushUrl).hostname
        if (apiHost) {
          Promise.resolve(prewarmDns(apiHost))
            .then((result) => {
              if (PROFILE3) logger.log(`[profile api dns-prewarm] host=${apiHost} ok=${result.ok} elapsedMs=${result.elapsedMs} family=${result.family || 'auto'}`)
              return result
            })
            .catch((error) => {
              if (PROFILE3) logger.log(`[profile api dns-prewarm] host=${apiHost} ok=false error=${Utils.safeErrorText(error, 'unknown')}`)
              return null
            })
        }
      } catch (e) {
        if (PROFILE3) logger.log(`[profile api dns-prewarm] skipped reason=${Utils.safeErrorText(e, 'unknown')}`)
      }
      // R4-1：retry 非法值有界兜底——Infinity 会让 `attempt <= retry` 死循环重试（validateConfig 只警告不阻止）；

      // NaN → 意外只跑 1 次；小数 → 次数模糊。合法整数（默认 2）行为零变更
      // v3.158：Utils.num 转换——'5'(环境变量字符串) → 5（曾 Number.isFinite('5')=false 回退 2）
      // net-4：上界 9999 配合 30s 退避封顶 → 单次 fetchData 最长约 3.5 天且无整体时限（是否收紧上界待产品决策）
      const maxRetry = (() => { const r = Utils.num(Config.api.retry, 2); return Number.isInteger(r) && r >= 0 ? Math.min(r, 9999) : 2 })()
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        if (PROFILE3) logger.log(`[profile api attempt] start=${attempt + 1}/${maxRetry + 1}`)
        try {
          // retry: { limit: 0 } 关闭 got 内置重试（连带 got 自带 Retry-After 处理一并失效），交给外层手写逻辑
          // net-7（返工订正）：外层退避**已**遵守 Retry-After——下方 catch 经 parseRetryAfterMs 取合法形态，
          // 命中即按服务端指示等待、缺失/非法才回落指数退避，两条路径同受 RETRY_BACKOFF_CAP_MS 上限保护。
          const result = await fetchJson(Config.api.pushUrl, {
            timeout: resolveTimeoutMs(), // net-3：非法 timeout 告警 + 回落默认，不得原样传入 HTTP 层
            retry: { limit: 0 },
            headers: {
              'User-Agent': `xbk-push-script/${PKG_VERSION}`,
              Accept: 'application/json'
            }
          })
          if (PROFILE3) logger.log(`[profile api attempt] success=${attempt + 1}/${maxRetry + 1}`)
          return result
        } catch (e) {
          lastErr = e
          // net-1：不可重试判定不能只看 HTTP 状态码——无 response 的错误（JSON 契约错误 ERR_BODY_NOT_JSON、
          // 证书类 CERT_HAS_EXPIRED、URL/参数类 ERR_INVALID_URL 等）在 PERMANENT_CODES 里是明确的永久性
          // 错误，旧实现会退避重试满 maxRetry 次（白白空转 1s+2s+4s…）；EBODYLIMIT 同理（确定性失败）。
          // 未知错误码一律保持旧口径（继续重试），不因本改动扩大「不重试」的范围。
          if (e.code && (PERMANENT_CODES.has(e.code) || DETERMINISTIC_LOCAL_CODES.has(e.code))) throw e
          // 4xx 客户端错误：重试也没用，直接抛出（限流/临时性状态码除外——408/409/425/429 可能瞬时，值得重试）
          // P2（审查 2026-08-15）：可重试状态码收敛到 xbk_failure_policy.RETRYABLE_CODES 单一来源，
          // 曾内联硬编码 429/408/409 漏掉 425（failure_policy 判 retryable 而 fetchData 立即抛，两份清单漂移）。
          if (e.response) {
            const sc = e.response.statusCode
            if (sc !== undefined && sc < 500 && !RETRYABLE_CODES.has('HTTP_' + sc)) throw e
          }
          if (attempt < maxRetry) { // v3.157：用兜底后的 maxRetry（曾用原始 Config.api.retry，非法类型时与实际重试不一致）
            // net-7：服务端显式给了 Retry-After（429/408/425/503 常见）就按它等——外层手写退避曾完全不读它，
            // 结果是在限流窗口内按固定指数退避反复撞墙；缺失/非法时回落指数退避（1s、2s、4s…）。
            // 两条路径都受 RETRY_BACKOFF_CAP_MS 上限保护；Retry-After 是服务端给的回访时刻，不叠加抖动，
            // 指数退避保留 +0-500ms 抖动避免多实例同时重试（注：README 未声明本函数退避口径，
            // README:68 的「指数退避」指常驻轮询入口）。
            const retryAfterMs = readRetryAfterMs(e)
            const byServer = retryAfterMs !== null
            const wait = byServer
              ? Math.min(retryAfterMs, RETRY_BACKOFF_CAP_MS)
              : Math.min(1000 * 2 ** attempt, RETRY_BACKOFF_CAP_MS) + crypto.randomInt(500)
            logger.log(`请求失败（${Utils.safeErrorText(e, 'unknown')}），${wait / 1000}s 后重试（第 ${attempt + 1}/${maxRetry} 次）${byServer ? '（按 Retry-After）' : ''}...`)
            await new Promise(resolve => setTimeout(resolve, wait))
          }
        }
      }
      // 重试耗尽后抛出：maxRetry 已兜底为 [0,9999] 整数 → 循环至少执行一次且首轮失败即赋 lastErr，
      // 故 `|| new Error(...)` 为不可达的防御性兜底（保留不删，避免日后改动失去保护）
      throw lastErr || new Error('请求失败（未知错误）')
    }
  }
}

module.exports = { createNetwork, parseRetryAfterMs }
