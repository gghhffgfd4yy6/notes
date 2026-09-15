'use strict'

// 官方 got 的薄封装：got 负责 HTTP/TLS/重定向/超时，本文只补项目需要的响应体大小与 JSON 解析。
const got = require('got')
const { AGENTS, baseRequestOptions, invalidateDnsForError, profileMs } = require('./xbk_agents')

const DEFAULT_MAX_BODY = 20 * 1024 * 1024

// 日志脱敏（XBK_PROFILE=3 专用）：URL 只保留 origin（协议+主机+端口），路径/查询/凭据整段遮蔽。
// 旧实现 `String(url).replace(/\/[^/]+$/, '/***')` 只遮蔽最后一个路径段——非末段密钥（如 /SECRET/v1）
// 会原样进日志，且 URL 以 / 结尾（或解析不出路径段）时正则不匹配、整条 URL 原样输出。
function redactUrlForLog (url) {
  try {
    return new URL(String(url)).origin + '/***'
  } catch {
    return '<invalid-url>/***'
  }
}

function parseJsonBody (text) {
  // 上游可能返回带 UTF-8 BOM（U+FEFF）的合法 JSON：JSON.parse 对它直接抛错，
  // 旧实现会归成 ERR_BODY_NOT_JSON（xbk_failure_policy 的 PERMANENT 集合）→ 常驻循环永久停推。
  // 这里先剥离 BOM 再解析；不带 BOM 的输入行为不变。
  const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  try { return JSON.parse(normalized) } catch {
    // 不回显上游响应体内容（可能含密钥/业务数据），只报长度——避免经日志与告警外泄；
    // 错误码保持 ERR_BODY_NOT_JSON，失败分类语义不变（区分空体需新增错误码并同步 xbk_failure_policy.js）。
    const err = new Error('Response is not JSON: ' + (normalized.length === 0 ? 'empty body' : `body ${normalized.length} chars`))
    err.code = 'ERR_BODY_NOT_JSON'
    throw err
  }
}

async function fetchJson (url, options = {}, maxBody = DEFAULT_MAX_BODY) {
  const requestOptions = { ...baseRequestOptions(), ...options }
  const detailedProfile = process.env.XBK_PROFILE === '3'
  const started = Date.now()
  if (detailedProfile) console.log(`[profile api] start url=${redactUrlForLog(url)}`)
  // 集成测试的 got mock 只提供 promise API；生产官方 got 提供 stream API，走可限流的真实路径。
  if (!got.stream) {
    const body = await got(url, requestOptions).json()
    if (detailedProfile) console.log(`[profile api] complete totalMs=${Date.now() - started} transport=mock`)
    return body
  }

  const limit = Number.isFinite(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY
  // 非法 maxBody（非数字/NaN/Infinity/负数/0，如环境变量传来的字符串 '10'）静默替换成 20MB 会隐藏调用方笔误：
  // 显式告警，但钳制语义不变（合法数字的行为零变更）。
  if (limit !== maxBody) console.warn(`[xbk_http] maxBody 非法(${String(maxBody)})，已钳制到 ${DEFAULT_MAX_BODY} 字节`)
  return new Promise((resolve, reject) => {
    let response
    let responseAtMs = 0
    let firstDataAt = 0
    let total = 0
    const chunks = []
    let settled = false
    const finishReject = (err) => {
      if (settled) return
      settled = true
      invalidateDnsForError(err, url)
      if (detailedProfile) console.log(`[profile api] error totalMs=${Date.now() - started} code=${err && err.code ? err.code : 'unknown'}`)
      reject(err)
    }
    const stream = got.stream(url, { ...requestOptions, throwHttpErrors: false })
    stream.once('response', (res) => {
      response = res
      // 真实响应到达时刻只在这里可取：end 回调里再取 Date.now() 会恒等于 downloadEnd，不是响应到达时间。
      responseAtMs = Date.now() - started
      if (detailedProfile) console.log(`[profile api] responseAtMs=${responseAtMs} status=${res.statusCode}`)
    })
    stream.on('data', (chunk) => {
      if (!firstDataAt) firstDataAt = Date.now()
      total += chunk.length
      if (total > limit) {
        const err = new Error(`响应体过大(超过 ${limit} 字节)`)
        err.code = 'EBODYLIMIT'
        stream.destroy(err)
        finishReject(err)
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', finishReject)
    stream.once('end', () => {
      if (settled) return
      const endedAt = Date.now()
      const text = Buffer.concat(chunks).toString('utf8')
      // 只把 4xx/5xx 判为 HTTP 错误。终态 3xx/304（followRedirect:false 或响应无 Location 时可达）落到
      // 下面的 JSON 解析报 ERR_BODY_NOT_JSON：改成 >= 300 会把错误码变成 HTTP_3xx，而 xbk_failure_policy
      // 未对 3xx 归类（现在按 PERMANENT 处理，改后落 UNKNOWN/retryable）——需先跨文件统一口径，故此处不动。
      if (response && response.statusCode >= 400) {
        const err = new Error(`HTTP ${response.statusCode}`)
        err.code = `HTTP_${response.statusCode}`
        err.response = { statusCode: response.statusCode, body: text, headers: response.headers }
        finishReject(err)
        return
      }
      try {
        const body = parseJsonBody(text)
        settled = true
        if (detailedProfile) {
          const timings = stream.timings && stream.timings.phases ? stream.timings.phases : {}
          console.log(`[profile api timing] wait=${profileMs(timings.wait)} dns=${profileMs(timings.dns)} tcp=${profileMs(timings.tcp)} tls=${profileMs(timings.tls)} request=${profileMs(timings.request)} firstByte=${profileMs(timings.firstByte)} download=${profileMs(timings.download)} responseAt=${response ? responseAtMs : 'n/a'} firstDataAt=${firstDataAt ? firstDataAt - started : 'n/a'} downloadEnd=${endedAt - started} parse=${Date.now() - endedAt} total=${Date.now() - started} bytes=${total}`)
        }
        resolve(body)
      } catch (e) { finishReject(e) }
    })
  })
}

module.exports = { fetchJson, DEFAULT_MAX_BODY, AGENTS }
