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
      // 注意（net-2）：dnsLookup 的缓存/pending key 含 host|family|hints|all|verbatim，本预热未传
      // options，仅当 XBK_DNS_FAMILY=4/6（强制 family）时才与真实请求同 key；默认配置下两者不合并。
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
          // net-7：外层退避不读 Retry-After，429/408/425 统一按固定指数退避重试（是否遵守 Retry-After 待决策）
          const result = await fetchJson(Config.api.pushUrl, {
            timeout: (() => {
              // net-3：got 把数值 timeout 直接交给定时器，小数/超 2^31-1 会被 Node 归一到约 1ms
              // （每次请求瞬间超时）——统一钳到 [1, 2147483647] 整数；非正值沿用默认 5000
              const n = Utils.num(Config.api.timeout, 5000)
              if (!(n > 0)) return 5000
              return Math.min(Math.max(1, Math.ceil(n)), 2147483647)
            })(), // 非法 timeout 只告警不应原样传入 HTTP 层
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
            // 退避等待：1s、2s、4s、8s...指数退避（注：README 未声明本函数退避口径，README:68 的
            // 「指数退避」指常驻轮询入口）；封顶 30s 防长挂，+0-500ms 随机抖动避免多实例同时重试
            const wait = Math.min(1000 * 2 ** attempt, 30000) + crypto.randomInt(500)
            logger.log(`请求失败（${Utils.safeErrorText(e, 'unknown')}），${wait / 1000}s 后重试（第 ${attempt + 1}/${maxRetry} 次）...`)
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

module.exports = { createNetwork }
