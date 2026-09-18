// ============================================================
// 📤 Pusher — 推送层
// ============================================================
function createPusher ({ Utils, getNotify }) {
  return {
    // notifyModule：可选推送模块实例（延迟加载）；未传时按需加载
    async send (text, desp, notifyModule) {
      // R4-2：非字符串归一——undefined/null → 空串（避免模板串输出 'undefined' 文本）；数字等 String() 化
      // P3（审查 2026-08-15）：Symbol/抛错 toString 会抛 TypeError——try/catch 防护（对象保持 String() 语义不变）
      try { text = text === undefined || text === null ? '' : String(text) } catch (e) { text = '' }
      try { desp = desp === undefined || desp === null ? '' : String(desp) } catch (e) { desp = '' }
      // 最终推送出口再清理一次：自定义 {内容} 模板可能绕过 Formatter 的 {Html内容} 专用清理，
      // 而 WxPusher HTML 通道会直接渲染 desp；统一出口防止任意模板把主动 HTML 带入客户端。
      // 仅当 desp 呈 HTML 形态（将触发 wxpusher 等 HTML 渲染通道）时清洗：
      // 纯 Markdown/纯文本（默认 {Markdown内容}、{内容} 普通文本）不清洗，
      // 避免破坏 Markdown 代码块、技术讨论文本（onerror= 等字面量）与排版实体。
      // 注意（P5）：门槛是「HTML 形态」而非「模板类型」——含 HTML 形态标签的代码块示例同样会被改写。
      // C030：htmlLike 正则对“大量 <tag 前缀但全文无 >”的输入呈 O(n²) 回溯。
      // Round2 C030：将 100k 截断提升到入口统一——检测与清洗作用于同一份（截断后的）desp，
      // 消除“检测截断、清洗不截断”导致第 100k 后的 HTML 绕过出口清洗的行为回归。
      // 超长 desp 截断为已知边界（与全局 htmlToMarkdown/sanitizeDecodedHtml 截断策略一致）。
      // P4（审查 2026-08-15）：此前静默 slice——用户 push.contentMax > 100000 时配置与行为不一致却无任何提示；
      // 且 slice 按 UTF-16 码元切分会在代理对中间切断，产生孤立代理（半个 emoji 乱码）。
      // 改为复用 Utils.truncateUtf16（与 xbk_formatter 同一 100k 上限同一口径，代理对/ZWJ 安全），
      // 并补一条告警让「配置被硬上限覆盖」可观测。注意：Utils 为注入依赖，测试替身可能未提供
      // truncateUtf16 → 退回本地代理对安全截断（行为等价：都不切断代理对）。
      const HTML_LIKE_MAX_LEN = 100000
      if (desp.length > HTML_LIKE_MAX_LEN) {
        console.warn(`[Pusher] desp 长度 ${desp.length} 超过硬上限 ${HTML_LIKE_MAX_LEN}，已截断；` +
          `若 push.contentMax > ${HTML_LIKE_MAX_LEN}，实际推送内容不会超过该上限`)
        // CodeRabbit PR #147：退回分支不能再裸 slice——它可能只留下跨边界 emoji 的高位代理，
        // 违反 SYSTEM_CONTRACT「按 UTF-16 安全截断（不得切断代理对）」。这里本地做一次代理对回退，
        // 与 Utils.truncateUtf16 的口径一致（截断点若落在低位代理上则整体退一格）。
        const safeSlice = (text, max) => {
          let endIdx = max
          if (endIdx < text.length && endIdx > 0) {
            const prev = text.charCodeAt(endIdx - 1)
            const next = text.charCodeAt(endIdx)
            if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) endIdx -= 1
          }
          return text.slice(0, endIdx)
        }
        desp = Utils && typeof Utils.truncateUtf16 === 'function'
          ? Utils.truncateUtf16(desp, HTML_LIKE_MAX_LEN)
          : safeSlice(desp, HTML_LIKE_MAX_LEN)
      }
      // 审查 P1/S1/F1：门槛收敛为 looksLikeHtmlEnvelope——与渲染侧（slim 的 contentType 判定）
      // 同一实现，且取宽松包络。此前注入的 looksLikeHtmlLinear 更严：
      // <img src=x onerror=alert(1) <2> 判 false 不清洗，而 slim 仍以 contentType=2 原文送出
      // → 未清洗的主动 HTML 直达客户端（「模板/链接统一安全入口」被绕过）。
      // 门槛必须覆盖所有可能被渲染成 HTML 的输入，不能反向收敛到渲染侧的严格判定。
      const htmlLike = looksLikeHtmlEnvelope(desp) // S8786：线性扫描替代原回溯正则
      if (htmlLike) {
        desp = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(desp))
      }
      // 抛异常由主流程处理：推送失败的消息不写缓存，下次运行重试（避免永久丢失）
      // 加整体超时：整体 race 上限 10s（slim 层每通道 HTTP timeout 15s 为单通道上限），
      // 避免慢通道把整批推送拖到数分钟
      // v3.121：clearTimeout 清除超时定时器——Promise.race 完成后定时器仍挂着会导致
      // 进程退出延迟（事件循环被 keep-alive）+ 多次推送定时器堆积（资源泄漏）
      let timer
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const notifyMod = notifyModule || await getNotify()
      try {
        // P2（审查 2026-08-15）：契约防御——第三方 sendNotify 必须返回 thenable；同步 undefined 会让
        // Promise.race 立即 resolve → 主流程误写缓存造成「未发送即成功」静默丢消息。真实模块为 async，
        // 此处防未来接入同步实现时静默成功（抛错由 pushOne catch → 不写缓存 → 下次重试）。
        // P3（跨批协同，low）：把在飞通道追踪器交给投递层（slim 契约见 xbk_sendNotify_slim 的
        // params.inFlightTracker）；不支持该契约的模块会忽略它 → tracker.pending 保持 null → 超时归因
        // 退回既有「按静态配置清单全量列出」语义（其口径被 test_pusher.js / test_app.js 双向锁定）。
        const inFlight = { pending: null }
        const sendParams = controller
          ? { signal: controller.signal, inFlightTracker: inFlight }
          : { inFlightTracker: inFlight }
        const sendResult = notifyMod.sendNotify(text, desp, sendParams)
        if (!sendResult || typeof sendResult.then !== 'function') {
          throw new Error('推送模块 sendNotify 未返回 Promise，拒绝静默成功')
        }
        return await Promise.race([
          sendResult,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              if (controller) controller.abort()
              const error = new Error('推送超时(10s)')
              // P3（审查 2026-08-15）零风险半边①：补顶层 code。此前只有 error.failures[].code，
              // 顶层错误对象无法自描述（failures 为空时更无从判断是超时）。归类语义不变：
              // xbk_failure_policy 只用 message/statusCode/providerCode/failures 归类，
              // 且 PUSH_TIMEOUT 不在 RETRYABLE_CODES/PERMANENT_CODES 内 → 仍按 message「超时」→ retryable。
              error.code = 'PUSH_TIMEOUT'
              // P3：优先按「仍在飞的通道」归因——已成功结算的通道不再被误标为 PUSH_TIMEOUT
              // （旧行为：把静态配置清单里的每个通道都标为失败，含已送达通道 → 通道健康统计与
              // 下轮重试判断被污染）。pending 为空数组是有效状态（全部已结算），必须区别于「无该能力」。
              const pending = Array.isArray(inFlight.pending) ? inFlight.pending.slice() : null
              const names = pending || (notifyMod && typeof notifyMod.configuredChannelNames === 'function' ? notifyMod.configuredChannelNames() : [])
              // P3 零风险半边②：既无在飞清单、又未提供 configuredChannelNames 时 failures 静默为空
              // （超时归因整体缺失）→ 补告警使其可观测。
              if (!pending && names.length === 0) console.warn('[Pusher] 推送超时，但无法获取已配置通道清单（configuredChannelNames 缺失），failures 为空')
              error.failures = names.map(channel => ({ channel, code: 'PUSH_TIMEOUT', message: '推送超时(10s)' }))
              reject(error)
            }, 10000)
          })
        ])
      } finally {
        clearTimeout(timer)
        if (controller) controller.abort()
      }
    }
  }
}

module.exports = { createPusher, looksLikeHtmlLinear, looksLikeHtmlEnvelope, htmlTagNameEnd, isTagNameBoundary }

// 返回 < 处标签名结束位；非完整标签返回 -1（S3776：独立成函数压认知复杂度）
function htmlTagNameEnd (s, lt) {
  let j = lt + 1
  while (j < s.length && /\s/.test(s[j])) j++
  if (s[j] === '/') { j++; while (j < s.length && /\s/.test(s[j])) j++ }
  if (!/[A-Za-z]/.test(s[j] || '')) return -1
  j++
  while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++
  return isTagNameBoundary(s, j) ? j : -1
}

// 标签名结束边界：空白、>，或 / 且后一个字符必须是 >（与旧正则 (?=\s|\/?>) 一致）
function isTagNameBoundary (s, pos) {
  const ch = s[pos]
  if (ch === undefined || ch === '>' || /\s/.test(ch)) return true
  return ch === '/' && s[pos + 1] === '>'
}

// S8786：HTML 形态线性检测；先定位标签名，再单趟扫描到下一个 < 或 >。
function looksLikeHtmlLinear (s) {
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) return false
    const nameEnd = htmlTagNameEnd(s, lt)
    if (nameEnd === -1) { i = lt + 1; continue }
    let j = nameEnd
    while (j < s.length && s[j] !== '>' && s[j] !== '<') j++
    if (j < s.length && s[j] === '>') return true
    i = j
  }
  return false
}

// 审查 P1/S1/F1：出口清洗门槛与渲染侧（slim 的 wxpusher contentType 判定）共用的唯一实现。
// 与上面的 looksLikeHtmlLinear 只差一点：标签名边界成立后，其【后】存在任意 > 即判 HTML——
// 即使中间又出现 <（HTML5 tokenizer 里引号属性值可含 <，如 <img src="a<b" onerror=alert(1)>
// 仍会被解析成带 onerror 的标签）。S8786 线性化时此处收窄为「先遇到 < 就跳过」，与它要替代的
// 旧正则 /<\s*\/?\s*[A-Za-z][A-Za-z0-9-]*(?=\s|\/?>)[^>]*>/i 不再等价（旧正则跨越 <）。
// 取宽松包络即 fail-closed：只要可能被当 HTML 渲染就先清洗，避免「本通道判 HTML 渲染、
// 出口判非 HTML 不清洗」的组合让未清洗的主动 HTML 直达客户端。
// 注意：looksLikeHtmlLinear 仍是既有导出（test_filter.js 锁定其「不跨界」语义），
// 但已不再作为出口门槛——门槛只认本函数。
function looksLikeHtmlEnvelope (s) {
  if (typeof s !== 'string') return false // undefined/null/数字等调用方输入防御（'' 由循环自然返回 false）
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) return false
    const nameEnd = htmlTagNameEnd(s, lt)
    if (nameEnd === -1) { i = lt + 1; continue }
    return s.includes('>', nameEnd) // 其后存在 > 即判 HTML；否则剩余串再无 >（O(n) 单趟扫描）
  }
  return false
}
