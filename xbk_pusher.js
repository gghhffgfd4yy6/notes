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
      const HTML_LIKE_MAX_LEN = 100000
      if (desp.length > HTML_LIKE_MAX_LEN) desp = desp.slice(0, HTML_LIKE_MAX_LEN)
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
        const sendResult = notifyMod.sendNotify(text, desp, controller ? { signal: controller.signal } : {})
        if (!sendResult || typeof sendResult.then !== 'function') {
          throw new Error('推送模块 sendNotify 未返回 Promise，拒绝静默成功')
        }
        return await Promise.race([
          sendResult,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              if (controller) controller.abort()
              const error = new Error('推送超时(10s)')
              const names = notifyMod && typeof notifyMod.configuredChannelNames === 'function' ? notifyMod.configuredChannelNames() : []
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
