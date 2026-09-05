'use strict'

// 🌐 Network — 网络请求层（从 xbk_function_v3.js 独立准备，暂不接入主入口）
// 依赖全部由组合根注入，避免反向 require 主入口及重复单例。
function createNetwork ({
  Config,
  Utils,
  fetchJson,
  prewarmDns,
  getNotify,
  crypto,
  RETRYABLE_CODES,
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
      // 线报接口 DNS 与实际请求共用 xbk_agents.dnsLookup：提前启动解析，
      // 若请求随后进入同一主机，dnsLookup 会合并到同一个 pending 查询，
      // 不增加额外 HTTP 请求，也不阻塞请求启动。
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
      const maxRetry = (() => { const r = Utils.num(Config.api.retry, 2); return Number.isInteger(r) && r >= 0 ? Math.min(r, 9999) : 2 })()
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        if (PROFILE3) logger.log(`[profile api attempt] start=${attempt + 1}/${maxRetry + 1}`)
        try {
          // retry: { limit: 0 } 关闭 got 内置重试，完全交给外层手写逻辑
          const result = await fetchJson(Config.api.pushUrl, {
            timeout: (() => {
              const n = Utils.num(Config.api.timeout, 5000)
              return n > 0 ? n : 5000
            })(), // 非正 timeout 只告警不应传入 HTTP 层
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
          // 4xx 客户端错误：重试也没用，直接抛出（限流/临时性状态码除外——408/409/425/429 可能瞬时，值得重试）
          // P2（审查 2026-08-15）：可重试状态码收敛到 xbk_failure_policy.RETRYABLE_CODES 单一来源，
          // 曾内联硬编码 429/408/409 漏掉 425（failure_policy 判 retryable 而 fetchData 立即抛，两份清单漂移）。
          if (e.response) {
            const sc = e.response.statusCode
            if (sc !== undefined && sc < 500 && !RETRYABLE_CODES.has('HTTP_' + sc)) throw e
          }
          if (attempt < maxRetry) { // v3.157：用兜底后的 maxRetry（曾用原始 Config.api.retry，非法类型时与实际重试不一致）
            // 退避等待：1s、2s、4s、8s...指数退避（与 README「指数退避+随机抖动」声明一致；
            // 封顶 30s 防长挂；0-500ms 随机抖动避免多实例同时重试）
            const wait = Math.min(1000 * 2 ** attempt, 30000) + crypto.randomInt(500)
            logger.log(`请求失败（${Utils.safeErrorText(e, 'unknown')}），${wait / 1000}s 后重试（第 ${attempt + 1}/${maxRetry} 次）...`)
            await new Promise(resolve => setTimeout(resolve, wait))
          }
        }
      }
      // 重试耗尽后抛出；防御 retry 为负等异常配置（循环可能一次都不执行 → lastErr undefined）
      throw lastErr || new Error('请求失败（未知错误）')
    }
  }
}

module.exports = { createNetwork }
