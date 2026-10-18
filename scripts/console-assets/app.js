// scripts/console-assets/app.js —— 控制台前端（preact + htm standalone，无构建、零 npm 依赖）。
// vendor 锚点（v3.296 补）：./htm-preact.module.js = preact 10.24.3 + hooks + htm 3.1.1
// standalone 内联版（npmmirror 文件直链入库，sha256 =
// 2aeaa3232ca84a7ad7ac0bef39bad3223dbd2173bee6ce4554b77be2f7f271b3）。重取/升级必须核对该值；
// CVE-2026-22028 影响 preact ≥10.26.5，升级越过该版本前先确认修复态。
// 数据面：GET /api/status、/api/runs、/api/runs/:id（同源，token 走 Authorization: Bearer
// 请求头——不复述进 URL，避免出现在任何中间层访问日志/浏览器历史，Sourcery rwH）。
// 动作面：POST /trigger（token 同样在 Bearer 头；body 只带 action）。
// 页面本体仍以 ?token= 打开（浏览器导航无法带头），fetch 层换头后 URL 零凭证。
import { html, render, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from './htm-preact.module.js'
// 纯函数单独成 ESM 模块（Node 测试可直接 import 做行为断言，不在测试里 eval 源码）。
import { relDay, cacheWriteInfo, filterLogLines, ageFromStamp, logLineCounts, filterRunItems, tabFromHash } from './pure.mjs'

// token 由 renderPage 注入的 JSON 岛（<script type="application/json" id="xbk-boot">）提供。
// 岛内文本由服务端做 JSON 转义（控制字符 → \uXXXX；不用 HTML 实体——script 文本不做实体解码，
// 实体会让 JSON.parse 得到含 &amp; 的错误 token，Sourcery vwK）。
// 解析后立即移除该节点（用后即焚，token 不常驻 DOM）。
function readBoot () {
  try {
    const el = document.getElementById('xbk-boot')
    if (!el) return { token: '' }
    const data = JSON.parse(el.textContent || '{}')
    el.remove()
    return { token: typeof data.token === 'string' ? data.token : '' }
  } catch (e) { return { token: '' } }
}
const BOOT = readBoot()

// BFCache 恢复（评审 #233 · Sourcery Medium）：浏览器从往返缓存恢复页面时会跳过 `/` 请求，
// BOOT.token 可能已随服务重启/轮换而过期——GET 靠 Cookie 仍正常，但写动作会 401。
// persisted=true 即非首次加载，强制重载拿当前凭证（no-store 不保证 BFCache 驱逐）。
window.addEventListener('pageshow', (ev) => { if (ev.persisted) window.location.reload() })

const POLL_MS = 5000
const POLL_BUSY_MS = 2000
// 提交成功后按钮锁定的最长兜底时长（Sourcery vwU/vv2：轮询竞态/请求挂起时不能永久锁死；
// 上限 = 服务端 PROC_TIMEOUT_MS(10min) + 提交往返余量，取 11 分钟）。
const BUSY_FALLBACK_MS = 11 * 60 * 1000
// fetch 请求期限（Sourcery G_n6）：挂起连接不得阻塞刷新链路；超时由 AbortController 取消，
// 走正常 reject 路径（「刷新失败」可见），不会堆积请求。
const FETCH_TIMEOUT_MS = 8000

// ── 工具 ────────────────────────────────────────────────────────────────────
// 服务端时间戳统一按 Asia/Shanghai（UTC+8）渲染，不跟浏览器时区走。
// 服务器时区是 UTC，若用本地 getHours()，「自动刷新 14:xx」会和 run.log 的 22:xx 混显，
// 看起来像日志停在 8 小时前（实测）。上海无夏令时，固定 +8 即可。
function fmtTime (ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

function fmtNum (n) {
  return (n === undefined || n === null) ? '—' : String(n)
}

// 本机时钟（lastSync = 浏览器 Date.now()）用本地时间渲染：套 fmtTime 的 +8 会让
// 非 UTC+8 用户看到「未来时间」（审查 #244 可选）。服务器时间戳仍走 fmtTime。
function fmtLocalTime (ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 「多久以前」（缓存写入停滞判断）与日报相对日期见 pure.mjs——纯函数便于行为测试。

// 字节人性化（v3.298 上提为模块级：系统信息与缓存健康面板共用）；0 字节是真实大小，
// 显式显示「0 B」而不是「—」（— 意为未知/不适用，会掩盖 0 字节文件的异常）。
function fmtBytes (b) {
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '—'
  if (b === 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

// 生效快照的 appliedAt 是服务端 ISO 串（writeAppliedSnapshot 写 toISOString），
// 与 run.log 时间戳同口径按 Asia/Shanghai 展示；解析失败原样显示，不吞成「—」。
function fmtIsoStamp (iso) {
  if (!iso) return '—'
  if (typeof iso === 'number') return fmtTime(iso)
  const t = Date.parse(String(iso))
  return Number.isFinite(t) ? fmtTime(t) : String(iso)
}

// ── API ─────────────────────────────────────────────────────────────────────
// token 只走 Authorization: Bearer 头（URL 不带任何凭证；console.js 服务端不打访问日志，
// 但浏览器扩展/中间代理可能记 URL——凭证不进 URL 是更安全的默认）。
// fetch 期限（Sourcery G_n6）：8s 超时 AbortController 取消——挂起请求走 reject，
// 刷新链路不阻塞，历史与状态在下一轮照常更新。
// Codacy Critical（SSRF 启发式：fetch 收到「用户可控 URL」）：每个端点独立函数、
// URL 全部为字面量——fetch 的第一个参数在数据流上只有字面量一种来源，不存在
// 「变量 URL」路径。run id 是服务端生成的 `epoch.seq` 字符串（不是数字），详情端点以独立函数封装。
// Sourcery Stalled-bodies x3：fetch() 在收到响应头时就 resolve，此前 clearTimeout 让
// 「头到了、body 挂起」的响应绕过超时——轮询消费 res.json() 时永久等待，刷新链路卡死。
// 修复：期限定时器不在 fetch resolve 时清掉，而是移交给 body 消费方（readBodyJson），
// 整个「头+体」共享同一个 8s 期限；消费完成后才真正 clearTimeout。
// Codacy/Opengrep node-ssrf（Codacy Critical）：该规则将「fetch 第一参数为任何变量」
// 判为 SSRF（不追数据流来源，即使字面量经辅助函数传入也算）。因此 fetch 调用必须
// 内联到各端点函数、第一参数为字面量；超时/中止参数由 timedRequest() 统一构造。
// Sourcery Stalled-bodies x3：期限定时器不在 fetch resolve 时清掉，而是移交给
// body 消费方（readBodyJson），整个「头+体」共享同一个 8s 期限。
function timedRequest (opts) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  const merged = { ...opts, signal: ctrl.signal }
  return { merged, done: () => clearTimeout(t) }
}

// 与 fetchWithTimeout 配套：res.json() 的读取也受同一期限约束（由 fetch 的 AbortController
// 触发——body 挂起到期时 abort 会 reject json() 解析）。这里再兜一层竞速，防止个别环境
// abort 不中断进行中的 body 读取。
async function readBodyJson (res) {
  let timer
  // 标准 lint（promise/param-names）要求 promise 构造第二参数名匹配 ^_?reject$。
  const bodyTimeout = new Promise((_resolve, _reject) => {
    timer = setTimeout(() => _reject(new Error('响应体读取超时')), FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([res.json(), bodyTimeout])
  } finally {
    clearTimeout(timer)
  }
}

// 响应消费公共骨架：fetch promise 进来后统一「非 2xx 抛错 + body 消费完才清期限」。
// 注意 fetch 本身不收进这里——各端点保持字面量 URL（Codacy SSRF 启发式：第一参数
// 任何变量形态都会红，包括白名单查表后的常量；字面量是唯一全绿形态，PR #227 实测）。
async function consumeJson (p, done) {
  p.then(() => {}, () => {}) // fetch reject（网络错）时由下方 done 兜底；正常路径在 body 消费后清
  try {
    const res = await p
    if (res.status === 401) {
      // 审查 #224：凭证失效必须让页面进入明确的「重新打开带 token 链接」状态，
      // 否则轮询每 5s 继续打 401，页面只剩空壳。事件由 App 监听并停轮询。
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new Event('xbk-auth-expired'))
      }
      throw new Error('凭证已失效（401）')
    }
    if (!res.ok) { done(); throw new Error(`HTTP ${res.status}`) }
    try {
      return await readBodyJson(res)
    } finally {
      done() // body 消费完才清期限（Sourcery Stalled-bodies-outlive：done 提前会让挂起 body 绕过 abort）
    }
  } catch (e) {
    done()
    throw e
  }
}

function apiGetStatus () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/status', merged), done)
}

function apiGetRuns () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/runs', merged), done)
}

async function apiGetRunDetail (id) {
  // 详情查询走 POST /api/runs/detail：fetch 的 URL 是纯字面量，run id 在请求体里
  // （id = 「epoch.seq」字符串原样传，服务端正则按此形态校验——v3.299 评审）。
  // GET /api/runs/:id 服务端仍保留（API 兼容），前端不再拼变量 URL——
  // Codacy SSRF 规则不接受任何含变量的 fetch 第一参数，字面量 + body 是唯一全绿形态。
  const body = new URLSearchParams({ id: String(id) })
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Bearer ${BOOT.token}`
    },
    body
  })
  const p = fetch('/api/runs/detail', merged)
  return consumeJson(p, done)
}

// 取消运行中的触发任务（v3.299 批次②）：POST 字面量 URL + id 走请求体
// （Codacy SSRF 全绿形态，与 /api/runs/detail 同款）。202 = 已受理（异步终止中），
// 200 = 幂等命中（已取消过），409 = 已结束无需停止。
function apiCancelRun (id) {
  // id = 「epoch.seq」字符串原样传（v3.299 评审：进程 epoch 形态），不做 Number 归一。
  const body = new URLSearchParams({ id: String(id) })
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Bearer ${BOOT.token}`
    },
    body
  })
  const p = fetch('/api/runs/cancel', merged)
  return consumeJson(p, done)
}

// 逐轮运行历史（v3.299 批次②）：run.log 摘要行解析（服务端），分页游标 before=已看轮数。
function apiGetRunHistory ({ limit, before, windowKey, excludeCancelled = false } = {}) {
  const params = new URLSearchParams()
  if (Number.isSafeInteger(limit) && limit > 0) params.set('limit', String(limit))
  if (Number.isSafeInteger(before) && before > 0) params.set('before', String(before))
  // 尾窗指纹：只在服务端下发过时回传（8 位十六进制），翻页跨窗口时服务端会判 stale
  if (typeof windowKey === 'string' && /^[0-9a-f]{8}$/.test(windowKey)) params.set('win', windowKey)
  if (excludeCancelled === true) params.set('excludeCancelled', '1')
  const qs = params.toString()
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const p = fetch(qs.length > 0 ? `/api/run-history?${qs}` : '/api/run-history', merged)
  return consumeJson(p, done)
}

// ── v3.297 扩展 API：推送记录 / 趋势 / 日志 / 系统 ────────────────────────────
// 与上方端点同纪律：fetch 第一参数是纯字面量（查询参数经 URLSearchParams 编码后
// 只进模板字符串的查询段，authority 恒为字面量——SSRF 启发式全绿形态）。
function apiGetMessages ({ page, size, cate, q, days }) {
  const params = new URLSearchParams()
  if (Number.isSafeInteger(page) && page > 1) params.set('page', String(page))
  if (Number.isSafeInteger(size) && size !== 20) params.set('size', String(size))
  if (typeof cate === 'string' && cate.length > 0) params.set('cate', cate)
  if (typeof q === 'string' && q.length > 0) params.set('q', q)
  // 时间窗（v3.307）：0/未传=全部；1/3/7/30=近 N 个上海日历日（服务端白名单兜底）
  if (Number.isSafeInteger(days) && days > 0) params.set('days', String(days))
  const qs = params.toString()
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const p = fetch(qs.length > 0 ? `/api/messages?${qs}` : '/api/messages', merged)
  return consumeJson(p, done)
}

function apiGetTrends (days) {
  const params = new URLSearchParams()
  // days 由固定常量 TREND_DAYS 提供（14 为服务端默认，省略参数）；非法值前端先行钳制，
  // 服务端白名单仍兜底。查询段进模板字符串、authority 恒为字面量（Codacy SSRF 全绿形态）。
  if (days === 30 || days === 60) params.set('days', String(days))
  const qs = params.toString()
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const p = fetch(qs.length > 0 ? `/api/trends?${qs}` : '/api/trends', merged)
  return consumeJson(p, done)
}

// v3.298 只读扩展 API：缓存健康 / 文件清单 / 配置视图。与上方端点同纪律——
// fetch 第一参数是纯字面量（无查询参数，字面量是唯一形态）。
function apiGetCacheHealth () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/cache-health', merged), done)
}

function apiGetFiles () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/files', merged), done)
}

function apiGetConfig () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/config', merged), done)
}

function apiGetLogs () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/logs', merged), done)
}

function apiGetSys () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/sys', merged), done)
}

// 访问日志（v3.300 §3.3）：系统页可查的内存环形访问日志。与上方端点同纪律——
// fetch 第一参数纯字面量（Codacy SSRF 全绿形态，静态红线测试自动覆盖）。
function apiGetAccessLog () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/access-log', merged), done)
}

// ── v3.310 过滤规则控制面：读面 GET + 四个写面 POST ─────────────────────────
// 读面沿用现有 api helper（Cookie / Bearer / ?token= 均可）。写面只带
// `Authorization: Bearer <boot token>`，不带 ?token=（服务端写端点只认 Bearer 头，
// URL 里带 token 会直接 400 query_token_not_allowed）。
// 写请求的错误体必须读出来：409 要区分 revision_mismatch / write_busy / store_corrupt，
// 400 要逐字段 errors。consumeJson 把非 2xx 收敛成「HTTP 4xx」会丢掉 code，所以这里用
// consumeJsonResult 保留状态码与响应体；超时/中止仍由同一个 timedRequest + readBodyJson 期限覆盖。
async function consumeJsonResult (p, done) {
  p.then(() => {}, () => {}) // fetch reject 由 await 抛出；这里只防提前未处理拒绝
  try {
    const res = await p
    let data = null
    try {
      data = await readBodyJson(res)
    } catch (e) {
      data = null
    }
    // 与 consumeJson 同口径：401 让 App 停轮询并显示「重新打开带 token 链接」。
    if (res.status === 401 && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event('xbk-auth-expired'))
    }
    return {
      status: res.status,
      ok: res.ok,
      data,
      retryAfter: res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null
    }
  } finally {
    done()
  }
}

function filterWriteHeaders () {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${BOOT.token}`
  }
}

function apiGetFilter () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/config/filter', merged), done)
}

function apiPostFilterSave (body) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter', merged), done)
}

function apiPostFilterValidate (body) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter/validate', merged), done)
}

function apiPostFilterPreview (body) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter/preview', merged), done)
}

function apiPostFilterRestore (body) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter/restore', merged), done)
}

// 触发类请求公共体（SonarCloud new_duplicated_lines_density：trigger 与 triggerNotifyTest
// 两段同构模板抽公共，消除新增代码重复率超标）。fetch 字面量由调用侧闭包注入——
// 第一参数仍是纯字面量（§0 静态红线形态保持），公共体只管 timedRequest/重放拦截语义。
async function triggerVia (timedOpts, doFetch, dupMsg, failMsgOf) {
  const { merged, done } = timedRequest(timedOpts)
  const p = doFetch(merged)
  p.then(() => {}, () => {})
  let res
  try {
    res = await p
  } catch (e) {
    done()
    throw e
  }
  let data
  try {
    data = await readBodyJson(res)
  } catch (e) {
    data = {}
  } finally {
    done()
  }
  if (!res.ok) {
    // 服务端幂等重放窗（与 console.js REPLAY_WINDOW_MS 配套）：同动作重试被拦时
    // 返回首轮 runId——提示用户「那一轮已经在跑/已完成」，前端顺手刷新历史。
    if (data && data.replayBlocked && data.runId) {
      const err = new Error(dupMsg)
      err.replayRunId = data.runId
      throw err
    }
    throw new Error(failMsgOf(data, res.status))
  }
  return data
}

async function trigger (action) {
  const body = new URLSearchParams({ action })
  return triggerVia(
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${BOOT.token}`
      },
      body
    },
    (merged) => fetch('/trigger', merged),
    '刚才那次触发已受理（正在运行或已完成），未重复执行',
    (data, status) => (data && data.error) || `HTTP ${status}`
  )
}

// 通知自检走独立端点（无 body）：与 trigger() 共用 triggerVia 模板，
// fetch 第一参数为纯字面量（§0 红线，查询参数-free）。
async function triggerNotifyTest () {
  return triggerVia(
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${BOOT.token}` }
    },
    (merged) => fetch('/api/notify-test', merged),
    '刚才那次通知自检已受理（正在运行或已完成），60 秒内无需重复',
    (data, status) => (data && data.error) || `通知自检失败（HTTP ${status}）`
  )
}

// ── 组件：状态徽章 ──────────────────────────────────────────────────────────
// tone: 'ok'=正常绿 | 'bad'=异常红 | 'warn'=有历史失败琥珀 | 'run'=中性黄（运行中/无记录）
// 显式字符串四态而非 true/false/null 魔值（CodeQL implicit null→string conversion）。
function Badge ({ tone, children }) {
  const cls = tone === 'ok'
    ? 'badge-ok'
    : (tone === 'bad' ? 'badge-bad' : (tone === 'warn' ? 'badge-warn' : 'badge-run'))
  return html`<span class="badge ${cls}">${children}</span>`
}

// 顶栏倒计时独立持有 1s 时钟：避免 App 每秒重渲染整页（安卓原生 select 会闪）。
function AutoRefreshText ({ nextAt, pollMs, lastSync }) {
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    // 每秒只重渲染这个文本节点；App 不再持有该时钟。
    const t = setInterval(() => setNowMs(() => Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const remain = Math.max(0, Math.min(Math.ceil(pollMs / 1000), Math.ceil(((nextAt || (Date.now() + pollMs)) - nowMs) / 1000)))
  return html`${`自动刷新 · ${remain}s`}${lastSync ? ` · ${fmtLocalTime(lastSync)}` : ''}`
}

// 提示行：tone='error' 时红色。页面不再拼 'hint hint-err' 字符串。
function Hint ({ tone, style, children }) {
  return html`<div class=${tone === 'error' ? 'hint hint-err' : 'hint'} style=${style}>${children}</div>`
}

// 面板头：标题 + 说明 + 右侧操作（右侧自动左推）。含 select 等复杂头部仍可手写。
function PanelHead ({ title, sub, right, afterTitle }) {
  return html`<div class="panel-head">
    <span class="panel-title">${title}</span>
    ${afterTitle}
    ${sub && html`<span class="panel-sub">${sub}</span>`}
    ${right && html`<span class="panel-right">${right}</span>`}
  </div>`
}

// 按钮：variant 生成 `btn btn-<variant>`；修饰词（btn-danger/btn-busy）可拼进 variant。
function Button ({ variant = 'secondary', disabled, onClick, title, buttonRef, children }) {
  return html`<button ref=${buttonRef} class=${'btn btn-' + variant} disabled=${disabled} onClick=${onClick} title=${title}>${children}</button>`
}

// 指标卡：标题 + 右上角徽章 + 若干行文本。换卡片实现（或组件库）只改这里。
function Card ({ title, badge, children }) {
  return html`<div class="card">
    <div class="card-head">
      <span class="card-title">${title}</span>
      ${badge}
    </div>
    <div class="card-lines">${children}</div>
  </div>`
}

// ── 状态归类（Sourcery vvy/vv4/vvX/vwc/vvG：错误态/中断态/畸形条目/失败数不得伪装成健康）──

// 部件三态判定（Sourcery G_od/G_oY）：readStatus 对「文件还没建」返回 truthy status
// （'missing'）且无 value——缺失 ≠ 异常，应中性；「存在但不可读/超限/校验失败」
// （'invalid'/'tooLarge'/...）才是异常，必须标红，不得伪装成「暂无记录」。
// 返回：'ok'（绿）| 'bad'（红）| 'run'（中性）。
function partTone (part, isOk) {
  if (!part) return 'run'
  if (part.status === 'ok') return isOk ? 'ok' : 'bad'
  // ok 之外的显式 status：missing → 中性；invalid/tooLarge 等 → 异常
  if (part.status === 'missing') return 'run'
  return 'bad'
}

// runOk：最近一轮必须「status=ok 且未中断且 failed=0」才算绿（Sourcery vvG：failed>0 不得绿）。
function runIsOk (state) {
  if (!state || !state.run) return false
  if (state.run.status !== 'ok') return false
  const v = state.run.value || {}
  if (v.interrupted === true) return false
  return !(typeof v.failed === 'number' && v.failed > 0)
}

// repOk：日报 status=ok 且 failed=0（同上口径）。
function repIsOk (state) {
  if (!state || !state.report || state.report.status !== 'ok') return false
  const v = state.report.value || {}
  return !(typeof v.failed === 'number' && v.failed > 0)
}

// 通道条目合法性（Sourcery vvC + G_oE：与 scripts/status.js 的 validChannelEntry 同口径——
// 三个计数字段必须同时为非负安全整数，服务端以 lastAlertAt 为必需字段，前端镜像；
// 缺任一字段或负数视为畸形条目，不进展示与健康判定）。
function validCounter (v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}
function validChannelEntry (name, entry) {
  // 空 key 不判畸形（与后端 status.js validChannels 同口径：后端只验 entry 结构，
  // 不验 key 名）——否则同一份 channel-health 后端判 ok、前端标红，两处结论相反。
  return typeof name === 'string' &&
    entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
    validCounter(entry.consecutiveFailures) &&
    validCounter(entry.lastFailureAt) &&
    validCounter(entry.lastAlertAt)
}

// 渠道 id → 展示名：配置页/状态卡不再把 `serverchan` 这种内部键直接端给用户。
const CHANNEL_LABELS = {
  pushplus: 'PushPlus',
  serverchan: 'Server酱',
  bark: 'Bark',
  wecom: '企业微信',
  wxpusher: 'WxPusher',
  xizhi: '息知',
  pushdeer: 'PushDeer',
  pushme: 'PushMe',
  telegram: 'Telegram'
}
function channelLabel (k) {
  return CHANNEL_LABELS[k] || k
}

function channelInfo (state) {
  // Sourcery G_oY：先看部件 status 再看 value——
  //   missing（文件还没建）→ 中性「暂无记录」；
  //   invalid/tooLarge 等坏读 → 红「状态异常」，不得伪装成暂无记录；
  //   ok 但 value 缺失 → 异常（服务端 ok 必带 value，缺失即契约破坏）。
  if (!state || !state.channels) return { tone: 'run', entries: [], note: '暂无记录' }
  if (state.channels.status === 'missing') return { tone: 'run', entries: [], note: '暂无记录' }
  if (state.channels.status !== 'ok') return { tone: 'bad', entries: [], note: '状态异常' }
  const raw = state.channels.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tone: 'bad', entries: [], note: '状态异常' }
  }
  const allKeys = Object.keys(raw)
  const entries = allKeys
    .filter((k) => validChannelEntry(k, raw[k]))
    .map((k) => ({ name: k.length > 0 ? channelLabel(k) : '(空名)', failures: raw[k].consecutiveFailures }))
  // Sourcery Corrupt-channels x2：合法条目全健康但存在畸形条目时，此前 filter 掉畸形后
  // 整卡仍显示绿色「正常」——数据损坏被吞。只要 valid 条目数 < 总键数即标红，
  // 提示「部分通道数据异常」，畸形条目名一并列出。
  const corruptKeys = allKeys.filter((k) => !validChannelEntry(k, raw[k]))
  if (corruptKeys.length > 0) {
    return { tone: 'bad', entries, note: `部分通道数据异常：${corruptKeys.join('、')}` }
  }
  // 空表 ≠ 未配置：只显示中性「暂无记录」（Sourcery vwc）。
  if (entries.length === 0) return { tone: 'run', entries, note: '暂无记录' }
  const tone = entries.every((e) => e.failures === 0) ? 'ok' : 'bad'
  return { tone, entries, note: '' }
}

// 过滤诊断卡片（Sourcery Filter-diagnostics x3）：readStatus 返回 state.diagnostics
// （{status, value}），此前 SPA 从未渲染——无脚本降级版有此信息，JS 版反而丢失。
// 口径与 formatStatus 一致：missing=中性暂无；invalid=红；ok 时展示最近时间与原因分布。
function diagCard (state) {
  if (!state || !state.diagnostics) return []
  const d = state.diagnostics
  if (d.status === 'missing') {
    return [{ title: '过滤诊断', tone: 'run', lines: ['暂无记录'] }]
  }
  if (d.status !== 'ok') {
    return [{ title: '过滤诊断', tone: 'bad', lines: [`状态异常（${d.status}）`] }]
  }
  const v = d.value || {}
  if (!v || typeof v !== 'object') {
    return [{ title: '过滤诊断', tone: 'bad', lines: ['状态异常'] }]
  }
  const reasons = v.byReason && typeof v.byReason === 'object' && !Array.isArray(v.byReason)
    ? Object.entries(v.byReason).map(([k, n]) => `${k}=${typeof n === 'number' ? n : '?'}`).join('，')
    : ''
  return [{
    title: '过滤诊断',
    tone: 'ok',
    lines: [
      `最近 ${fmtNum(v.at)}`,
      `原因分布 ${reasons || '无'}`
    ]
  }]
}

// ── 组件：首屏异常横幅（v3.307）────────────────────────────────────────────
// 只在「最近一轮失败/中断」或「近 7 天有失败」时出现：用户打开控制台第一眼就知道
// 有没有需要处理的事，并可直接跳到带筛选的日志（不再靠逐页翻逐轮历史）。
function AlertBanner ({ state, onOpenLog }) {
  if (!state) return null
  const run = state.run && state.run.value ? state.run.value : null
  const stats = state.stats && state.stats.status === 'ok' ? state.stats.value : null
  const lastFail = stats ? stats.lastFailure : null
  const orphan = run && typeof run.orphanFailures === 'number' ? run.orphanFailures : 0
  const runBad = !!(run && (run.interrupted === true || (typeof run.failed === 'number' && run.failed > 0) || orphan > 0))
  // 周失败只在「今天/昨天」置顶：三天前的失败仍留在「近 7 天」卡里，但不再每天红着脸占首屏。
  // 运行级异常（最近一轮失败/中断/孤儿失败）始终置顶，不受日期限制。
  const failRel = lastFail ? relDay(lastFail.date) : ''
  const recentFail = !!(lastFail && (failRel === '今天' || failRel === '昨天'))
  if (!runBad && !recentFail) return null
  const at = orphan > 0 && run.orphanFailureAt ? run.orphanFailureAt : (runBad && run.at ? run.at : (lastFail ? lastFail.at : ''))
  const text = orphan > 0 && !(run && (run.interrupted === true || run.failed > 0))
    ? `运行日志有 ${orphan} 条失败行未归属任何轮次（独立崩溃，最近 ${run.orphanFailureAt || '时间未知'}）`
    : (runBad
        ? (run.failed > 0
            ? `最近一轮推送失败 ${run.failed} 条（${run.at || '时间未知'}）`
            : `最近一轮异常中断（${run.at || '时间未知'}）`)
        : `近 7 天有失败：${lastFail.date} 推送失败 ${lastFail.failed} 条`)
  return html`<div class="alert-banner" role="alert">
    <span class="alert-dot" aria-hidden="true"></span>
    <span class="alert-text">${text}</span>
    <button type="button" class="alert-link" onClick=${() => onOpenLog && onOpenLog({ q: at.slice(0, 10), mode: 'issue' })}>查看日志 →</button>
  </div>`
}

// ── 组件：状态卡片区 ────────────────────────────────────────────────────────
// v3.307 信息层级：今日 / 近 7 天 / 最近一轮 / 通道与过滤。旧版「最近日报」与「最近一轮」
// 两张卡都在讲最近一次，缺「今天怎么样、成功率多少」；现在日报压成今日卡的一行，
// 过滤诊断并入通道卡，四张卡各答一个问题。
function StatusCards ({ state }) {
  if (!state) return null
  const rep = state.report && state.report.value ? state.report.value : null
  const repTone = partTone(state.report, repIsOk(state))
  const run = state.run && state.run.value ? state.run.value : null
  const runTone = partTone(state.run, runIsOk(state))
  const chan = channelInfo(state)
  const stats = state.stats && state.stats.status === 'ok' ? state.stats.value : null
  const today = stats ? stats.today : null
  const week = stats ? stats.week : null
  const diag = diagCard(state)[0] || null
  const diagTone = diag ? diag.tone : 'run'
  const diagLines = diag ? diag.lines : ['暂无记录']
  const repRel = rep ? relDay(rep.date) : ''
  const rateText = (r) => (r && typeof r.successRate === 'number' ? `${(r.successRate * 100).toFixed(1)}%` : '—')
  const todayTone = !today ? 'run' : (today.failed > 0 ? 'bad' : (today.rounds > 0 ? 'ok' : 'run'))
  // 周失败用琥珀色而非红色：它仍是「过去 7 天」的事实，但不应让三天前的故障长期染红首屏。
  const weekTone = !week ? 'run' : (week.failed > 0 ? 'warn' : (week.rounds > 0 ? 'ok' : 'run'))
  const chanTone = (chan.tone === 'bad' || diagTone === 'bad') ? 'bad' : (chan.tone === 'ok' ? 'ok' : 'run')
  const runAge = run ? ageFromStamp(run.at) : ''
  const cards = [
    {
      title: '今日',
      tone: todayTone,
      badge: !today ? '—' : (today.failed > 0 ? '异常' : (today.rounds > 0 ? '正常' : '—')),
      lines: today
        ? [
            `轮次 ${today.rounds} · 推送 ${today.pushed}`,
            `失败 ${today.failed}${today.failed > 0 ? ' ⚠️' : ''} · 成功率 ${rateText(today)}`,
            `日报 ${rep ? `${rep.date || '—'}${repRel ? `（${repRel}）` : ''} · ${repTone === 'ok' ? '正常' : repTone === 'bad' ? '异常' : '暂无'}` : '暂无'}`
          ]
        : ['暂无 run.log 数据']
    },
    {
      title: '近 7 天',
      tone: weekTone,
      badge: !week ? '—' : (week.failed > 0 ? '有失败' : (week.rounds > 0 ? '正常' : '—')),
      lines: week
        ? [
            `轮次 ${week.rounds} · 推送 ${week.pushed}`,
            `失败 ${week.failed} · 成功率 ${rateText(week)}`,
            `日均 ${(week.rounds / 7).toFixed(1)} 轮`,
            ...(stats && stats.truncated ? ['⚠️ run.log 超窗，统计仅覆盖尾部'] : [])
          ]
        : ['暂无数据']
    },
    {
      title: '最近一轮',
      tone: runTone,
      badge: !run ? '—' : (run.cancelled === true ? '已取消' : (run.interrupted || run.failed > 0 ? '异常' : '正常')),
      lines: run
        ? [
            `${runAge || '时间未知'}${run.at ? ` · ${run.at.slice(5, 16)}` : ''}`,
            `获取 ${fmtNum(run.total)} · 推送 ${fmtNum(run.pushed)} · 失败 ${fmtNum(run.failed)}`,
            `耗时 ${fmtNum(run.elapsed)}${run.cancelled === true ? ' · ⏹ 已取消' : run.interrupted ? ' · ⚠️ 中断' : ''}`
          ]
        : ['暂无数据']
    },
    {
      title: '通道与过滤',
      tone: chanTone,
      badge: chanTone === 'bad' ? '异常' : (chanTone === 'ok' ? '正常' : '—'),
      lines: [
        ...(chan.entries.length > 0
          ? [...chan.entries.map((e) => `${e.name}：连续失败 ${fmtNum(e.failures)} 次`), ...(chan.note ? [chan.note] : [])]
          : [chan.note || '暂无记录']),
        ...(diagLines.length > 0 ? [`过滤 ${diagLines.join(' · ')}`] : [])
      ]
    }
  ]
  return html`<div class="cards">
    ${cards.map((c) => html`<${Card} key=${c.title} title=${c.title}
      badge=${html`<${Badge} tone=${c.tone}>${c.badge}<//>`}>
      ${c.lines.map((l) => html`<div key=${l}>${l}</div>`)}
    <//>`)}
  </div>`
}

// ── 组件：触发按钮 ──────────────────────────────────────────────────────────
const ACTION_DEFS = [
  { key: 'dry-run', label: '试运行', desc: '抓取但不推送', cls: 'btn-secondary' },
  { key: 'run', label: '正式运行一轮', desc: '抓取并真实推送', cls: 'btn-danger-solid' },
  { key: 'check', label: '环境检查', desc: '不抓取不推送', cls: 'btn-secondary' },
  { key: 'notify-test', label: '通知自检', desc: '向全部渠道发一条测试消息（真实推送）', cls: 'btn-secondary' }
]

// ── 组件：危险动作二次确认（v3.307）────────────────────────────────────────
// 「正式运行一轮」「通知自检」会真实推送，之前是蓝色主按钮一键触发、警示文案在页脚
// （桌面隔 1100px、手机更远）。现在弹窗列出真实目的地，默认焦点在「取消」。
function ConfirmDialog ({ open, title, confirmLabel, busy, onConfirm, onCancel, children }) {
  const cancelRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    const t = setTimeout(() => { if (cancelRef.current) cancelRef.current.focus() }, 0)
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t) }
  }, [open, onCancel])
  if (!open) return null
  return html`<div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onCancel() }}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="modal-title" id="confirm-title">${title}</div>
      <div class="modal-body">${children}</div>
      <div class="modal-actions">
        <${Button} variant="secondary" buttonRef=${cancelRef} onClick=${onCancel}>取消<//>
        <${Button} variant="danger-solid" disabled=${busy} onClick=${onConfirm}>${confirmLabel}<//>
      </div>
    </div>
  </div>`
}

function TriggerBar ({ onTriggered, locking, setBusy }) {
  const [err, setErr] = useState('')
  // 待确认的真实推送动作（null = 无弹窗）；dry-run/check 不弹窗，直接执行。
  const [pending, setPending] = useState(null)
  // 确认框里的渠道名必须来自「当前配置」，不能拿 channel-health 历史凑数——配置改过之后
  // 历史里可能是已删除的渠道（Sourcery 确认框列错渠道）。null = 还没拉到，用模糊文案。
  const [configuredNames, setConfiguredNames] = useState(null)
  const channelText = Array.isArray(configuredNames)
    ? (configuredNames.length > 0 ? configuredNames.join('、') : '未配置任何渠道')
    : '所有已配置渠道（以「配置」页为准）'
  const doTrigger = useCallback(async (action) => {
    setErr('')
    setBusy(true)
    try {
      // 202 响应带首轮 runId（epoch.seq 字符串，v3.299）——交给 App 登记为 busy 归属
      // （G_nv 解锁判据）。Sourcery Medium：makeRunId 返回字符串，这里不能按数字过滤，
      // 否则 busy 状态丢 run 关联（自检 202 的 string id 被误判为 null）。
      const data = action === 'notify-test' ? await triggerNotifyTest() : await trigger(action)
      onTriggered(data && typeof data.id === 'string' ? data.id : null)
      // busy 不在此处清零（Sourcery vvo）：202 只代表已受理，子进程还在跑；App 的
      // 「提交轮进历史」派生 + BUSY_FALLBACK 兜底负责解锁。
    } catch (e) {
      // 幂等重放窗命中（服务端 replayBlocked）：首轮已受理，提示后立即刷新历史
      // 并解锁——这与「提交失败」不同，不该锁按钮。
      if (e && e.replayRunId) {
        setErr(`${e.message}（运行 #${e.replayRunId}）`)
        setBusy(false)
        // Sourcery Old-run-unlocks-new-trigger：这里不能把 prevRunId 登记为 busy 归属
        // （onTriggered 会写 busyRunIdRef）——旧轮通常已在历史里，下一次新提交 setBusy(true)
        // 后、其 202 未返回前，「busy 且 busyRunIdRef 在历史」的解锁 effect 会立即把新提交
        // 的 busy 清掉（按钮提前解锁）。只刷新历史，不登记归属（传 null）。
        onTriggered(null)
        return
      }
      setErr(e.message === '已有触发任务在运行（或锁未过期），请稍后再试'
        ? '已有任务在运行，请等它结束'
        : `触发失败：${e.message}`)
      setBusy(false) // 只有「提交失败」才立即解锁；提交成功的解锁交给「进历史」派生
    }
  }, [onTriggered, setBusy])

  const ask = (action) => {
    setErr('')
    // 只有真实推送需要确认；试运行与环境检查立即执行
    if (action === 'run' || action === 'notify-test') {
      setPending(action)
      setConfiguredNames(null)
      // 配置页同源接口（脱敏）：只取渠道名，取不到就退回模糊文案，绝不猜。
      apiGetConfig().then((v) => {
        const names = v && v.pushChannels && Array.isArray(v.pushChannels.names) ? v.pushChannels.names : []
        setConfiguredNames(names)
      }).catch(() => setConfiguredNames(null))
    } else doTrigger(action)
  }
  const confirmPending = () => {
    const action = pending
    setPending(null)
    if (action) doTrigger(action)
  }
  return html`<div class="panel">
    <${PanelHead} title="手动触发" />
    <div class="btn-row">
      ${ACTION_DEFS.map((a) => html`<div class="btn-item" key=${a.key}>
        <${Button} variant=${a.cls.replace(/^btn-/, '')} disabled=${locking} onClick=${() => ask(a.key)}>${a.label}<//>
        <span class="btn-desc">${a.desc}</span>
      </div>`)}
    </div>
    ${locking && html`<${Hint}><span class="spin"></span> 任务进行中…（完成后自动解锁）<//>`}
    ${err && html`<${Hint} tone="error">${err}<//>`}
    <${ConfirmDialog} open=${pending !== null}
      title=${pending === 'run' ? '确认正式运行一轮？' : '确认发送通知自检？'}
      confirmLabel=${pending === 'run' ? '确认真实推送' : '确认发送'}
      busy=${locking} onConfirm=${confirmPending} onCancel=${() => setPending(null)}>
      ${pending === 'run'
        ? html`<div>将抓取线报并<b>真实推送</b>到：${channelText}。</div><div class="modal-note">推送发出后无法撤回；只想验证抓取流程请用「试运行」（不推送）。</div>`
        : html`<div>将向全部渠道发送一条<b>真实测试消息</b>：${channelText}。</div><div class="modal-note">这条消息会出现在你的微信/推送客户端里。</div>`}
    <//>
  </div>`
}

// ── 组件：运行历史 ──────────────────────────────────────────────────────────
function RunsPanel ({ runs, status = 'ok', pollMs, onRefresh }) {
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailErr, setDetailErr] = useState('')
  // 详情日志跟随（审查 #244）：运行中标题写「实时跟随」，但输出框此前从不滚动——
  // 新行只追加在底部，用户看到的是开头几行。与运行日志页同口径：默认贴底，
  // 用户上翻后不抢位置，滚回底部自动恢复跟随。
  const logRef = useRef(null)
  const followRef = useRef(true)
  // 乱序防护（Sourcery vwI）：detail 请求领号，落后响应丢弃。
  const detailSeqRef = useRef(0)
  // onRefresh 经 ref 解引用（v3.300 3.1 §2 D7）：若直接进 effect deps，其身份不稳定
  // 会导致 SSE 每渲染重连（快照重建流）。
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  // 切换目标 run 时立即清旧详情（Sourcery G_oi + Old-logs-flash）：useEffect 在渲染后
  // 才跑，「新 openId + 旧 detail」会闪一帧。渲染期同步判定：detail.runId 与当前 openId
  // 不符就不显示（下方 logpre 用 detailForOpen 而非裸 detail）。effect 仍负责清状态。
  useEffect(() => {
    setDetail(null)
    setDetailErr('')
  }, [openId])
  // openRun/openActive 先声明后使用（v3.300 3.1 §1.9b）：详情跟随 effect 依赖 openActive，
  // 须在 effect 之前声明（渲染逻辑零变化）。
  const openRun = openId !== null ? runs.find((r) => r.id === openId) : null
  const openActive = !!(openRun && !openRun.finishedAt)
  // typeof 判据必须是 'string'（v3.300 3.1 §1.9a 回归修复）：v3.299 起 run id 改为
  // 「epoch.seq」字符串下发（服务端 makeRunId 模板串），number 判据恒 false ⇒
  // detailForOpen 恒 null ⇒ 日志框永远「加载中…」。
  const detailForOpen = detail !== null && typeof detail.id === 'string' && detail.id === openId
    ? detail
    : null

  // 切换目标时恢复跟随；输出变化时若仍在底部就贴底（含 SSE 增量与轮询快照）。
  useEffect(() => { followRef.current = true }, [openId])
  useEffect(() => {
    const el = logRef.current
    if (!el || detailForOpen === null) return
    if (followRef.current) el.scrollTop = el.scrollHeight
  }, [detailForOpen])
  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // 详情跟随（v3.300 3.1）：运行中走 SSE 实时流（原生 EventSource，零依赖）；
  // 非运行中 / 快照已完结 / 流错误回退原轮询。两通道在 effect 内二选一：SSE 模式不建
  // interval，轮询模式不建 EventSource——切态必经 cleanup（dead + es.close()），无叠加。
  // SSE 不经过 inFlightRef/timedRequest（那是 5s 主轮询的互斥面），互不抢占（蓝图红线 6）。
  useEffect(() => {
    if (openId === null) return undefined
    let dead = false
    let es = null
    let inflight = false
    let pollTimer = null
    const fetchOnce = async () => {
      // Sourcery Overlapping-log-polls/Slow-log-requests：详情请求慢于轮询间隔时逐 tick
      // 叠加并发请求，迟到的失败响应会把过期错误写到当前面板。与主轮询同口径：
      // 上一轮未回跳过本轮（8s 期限保证不会永久跳过）；领号防乱序保留。
      if (document.visibilityState === 'hidden') return // 后台标签页不轮询详情（切回时补一次）
      if (inflight) return
      inflight = true
      const seq = ++detailSeqRef.current
      try {
        const d = await apiGetRunDetail(openId)
        if (dead || seq !== detailSeqRef.current) return
        setDetail(d)
        setDetailErr('')
      } catch (e) {
        if (dead || seq !== detailSeqRef.current) return
        setDetailErr(`加载失败：${e.message}`)
      } finally {
        inflight = false
      }
    }
    // 切回前台立即补一拍（不依赖 interval 的下一 tick；隐藏期间已跳过所有详情请求）。
    // SSE 模式不能 fetchOnce：它会领号 ++detailSeqRef，令已建流的所有回调因代次不符被丢弃，
    // 运行中日志就此冻结（审查 #248）。SSE 模式下只需刷新 runs 徽章，详情交给流继续推。
    const onVisibility = () => {
      if (dead || document.visibilityState !== 'visible') return
      if (openActive) { onRefreshRef.current(); return }
      fetchOnce().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    const startPolling = () => {
      if (pollTimer !== null || dead) return
      // S9383：fetchOnce 内部已 try/catch 全收（不会 reject），但仍显式 .catch 兜底，
      // 不留 floating promise（与 console.js 里 readBody 的处理同口径）。
      fetchOnce().catch(() => { /* fetchOnce 不 reject，S9383 口径 */ })
      // 已结束的轮次只需要一次快照，永不建 interval（Sourcery #254：否则打开已完成的
      // 日志会按 pollMs 无限轮询详情）。运行中 SSE 回退才需要继续轮询。
      if (!openActive) return
      // pollMs=0 表示自动刷新已暂停：只取一次快照，绝不能 setInterval(fn, 0)
      // （暂停后打开已结束轮次的日志会变成热循环，持续打 /api/runs/detail）。
      if (!(pollMs > 0)) return
      pollTimer = setInterval(() => { fetchOnce().catch(() => {}) }, pollMs)
    }
    if (!openActive) {
      startPolling()
      return () => {
        dead = true
        document.removeEventListener('visibilitychange', onVisibility)
        if (pollTimer !== null) clearInterval(pollTimer)
      }
    }
    // ── SSE 模式：先取轮询快照，以快照 outputTotalLength 为初始游标建流（顺序不可倒置，
    // 快照先落 detail 再开流，快照后新增量由首个 tick 补发——不重不漏，见 §2 D5）。
    const seq = ++detailSeqRef.current
    // 流代次号（评审 231-M4）：本 effect 运行 = 新一代。旧流的排队回调（同一 run 关了
    // 又开的场景：prev.id===openId 仍命中）必须凭代次失效——seq 是闭包值，回调比对
    // detailSeqRef.current 即可判「自己是否仍是当前代」。
    const mySeq = seq
    apiGetRunDetail(openId).then((d) => {
      if (dead || seq !== detailSeqRef.current) return
      setDetail(d)
      setDetailErr('')
      if (d.finishedAt) return // 快照时已完结：不开流，runs 刷新翻转 openActive 后进轮询
      const start = typeof d.outputTotalLength === 'number' ? d.outputTotalLength : (d.output || '').length
      const params = new URLSearchParams({ id: String(openId), since: String(start) })
      // EventSource 第一参数照 fetch 字面量纪律：`/api/...` 模板字面量（同源相对路径，
      // authority 恒同源），变量只进查询段（§2 D1）。不带 token：会话 Cookie 自动携带
      // （页面加载即下发，authorize GET 收 Cookie）；token 进 URL 会落浏览器历史/访问日志。
      es = new window.EventSource(`/api/runs/stream?${params.toString()}`)
      es.onmessage = (ev) => {
        // 未命名 data 帧 = 增量文本（JSON 字符串）。函数式更新 + 身份护栏（prev.id 匹配
        // + 代次守卫：陈旧流回调在「同 run 关闭重开」场景 prev.id 仍命中，必须再验
        // mySeq===detailSeqRef.current，评审 231-M4）。
        try {
          const chunk = JSON.parse(ev.data)
          if (typeof chunk === 'string' && chunk.length > 0) {
            setDetail((prev) => (prev !== null && prev.id === openId && mySeq === detailSeqRef.current ? { ...prev, output: (prev.output || '') + chunk } : prev))
          }
        } catch (e) { /* 坏帧忽略：最终快照/重拉自愈 */ }
      }
      // named event 不进 onmessage（蓝图红线）：显式注册 reset / done。
      es.addEventListener('reset', (ev) => {
        try {
          const payload = JSON.parse(ev.data)
          if (payload && typeof payload.full === 'string') {
            setDetail((prev) => (prev !== null && prev.id === openId && mySeq === detailSeqRef.current ? { ...prev, output: payload.full } : prev))
          }
        } catch (e) { /* 同上 */ }
      })
      es.addEventListener('done', () => {
        if (es !== null) { es.close(); es = null } // 防原生自动重连在流关闭后无限重试（蓝图口径）
        fetchOnce().catch(() => {}) // 最终快照补 finishedAt/exitCode
        onRefreshRef.current() // 立即刷新 runs 列表徽章（ref 解引用，防 effect 重连，§2 D7）
      })
      es.onerror = () => {
        // 显式 close 后整段重拉一次后退回轮询；不带过期游标复连（蓝图重连语义）。
        if (es !== null) { es.close(); es = null }
        fetchOnce().catch(() => {})
        startPolling()
      }
    }).catch(() => { if (!dead) startPolling() }) // 快照失败 → 回退轮询（既有能力兜底）
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (es !== null) es.close()
      if (pollTimer !== null) clearInterval(pollTimer)
    }
  }, [openId, openActive, pollMs])

  // statusOf（Sourcery vv4）：以 finishedAt 为完成判据；
  // 「finishedAt 已设但 exitCode null」= 信号终止（含超时 SIGKILL），显示「已终止」。
  // cancelled 徽章优先于普通结果（v3.299 批次②）：被停止的轮次无论退出码如何都标「已停止」。
  const statusOf = (r) => {
    if (r.cancelled === true && !r.finishedAt) return html`<${Badge} tone='run'>停止中<//>`
    if (r.finishedAt) {
      if (r.cancelled === true) return html`<${Badge} tone='bad'>已停止<//>`
      if (r.timedOut) return html`<${Badge} tone='bad'>超时<//>`
      if (r.exitCode === 0) return html`<${Badge} tone='ok'>成功<//>`
      if (r.exitCode === null) return html`<${Badge} tone='bad'>已终止<//>`
      return html`<${Badge} tone='bad'>退出码 ${r.exitCode}<//>`
    }
    if (r.exitCode === null) return html`<${Badge} tone='run'>运行中<//>`
    return html`<${Badge} tone='bad'>已终止<//>`
  }
  // 停止按钮（v3.299 批次②）：只对未完成的轮次显示；点击后置本地 pending 态并刷新，
  // 结果徽章由下一轮轮询的 cancelled/finishedAt 驱动。
  const [cancelPending, setCancelPending] = useState(null)
  const [cancelErr, setCancelErr] = useState('')
  const doCancel = async (id) => {
    setCancelPending(id)
    setCancelErr('')
    try {
      await apiCancelRun(id)
    } catch (e) {
      // v3.299 评审 #9：取消失败必须可见——成功刷新会清掉同步错误条，吞掉这里的
      // 异常会让任务在无提示下继续跑。面板内局部横幅不依赖全局轮询状态。
      setCancelErr(`停止请求失败：${e && e.message ? e.message : String(e)}（任务可能仍在运行，请重试）`)
    } finally {
      setCancelPending(null)
    }
    onRefresh()
  }

  return html`<div class="panel">
    <${PanelHead} title="触发历史" sub="最多 20 条 · 本进程内存" />
    ${cancelErr && html`<${Hint} tone="error">${cancelErr}<//>`}
    ${status === 'loading'
      ? html`<div class="empty">触发历史加载中…</div>`
      : status === 'error' && runs.length === 0
        ? html`<div class="empty">触发历史暂不可用，请稍后刷新</div>`
        : runs.length === 0
          ? html`<div class="empty">暂无触发记录</div>`
          : html`<div class="runs-scroll"><table class="runs-table">
        <thead><tr><th>#</th><th>动作</th><th>开始时间</th><th>结果</th><th></th></tr></thead>
        <tbody>
          ${runs.map((r) => html`<tr key=${r.id} class=${openId === r.id ? 'row-open' : ''}>
            <td class="mono">#${r.id}</td>
            <td>${r.label}</td>
            <td class="mono">${fmtTime(r.startedAt)}</td>
            <td>${statusOf(r)}</td>
            <td>
              ${!r.finishedAt && html`<${Button} variant=${'ghost btn-danger' + (cancelPending === r.id ? ' btn-busy' : '')} disabled=${cancelPending === r.id}
                onClick=${() => { doCancel(r.id).catch(() => {}) }} title="停止该任务（SIGTERM，3 秒后强杀；已发送但未记录的通知下轮会重推）">停止<//>`}
              <${Button} variant="ghost" onClick=${() => setOpenId(openId === r.id ? null : r.id)}>
                ${openId === r.id ? '收起' : '日志'}
              <//>
            </td>
          </tr>`)}
        </tbody>
      </table></div>`}
    ${openId !== null && html`<div class="logbox">
      <div class="logbox-head">
        <span>运行 #${openId} 输出${openActive ? '（实时跟随）' : ''}</span>
        <${Button} variant="ghost" onClick=${() => setOpenId(null)}>关闭<//>
      </div>
      <pre class="logpre" ref=${logRef} onScroll=${onLogScroll}>${
        detailErr ||
        (detailForOpen === null
          ? '加载中…'
          // Sourcery G_oq：detail 已加载但 output 为空串 = 该轮合法地没有任何输出，
          // 必须显示「（无输出）」而不是永远「加载中…」。
          : (typeof detailForOpen.output === 'string' && detailForOpen.output.length > 0 ? detailForOpen.output : '（无输出）'))
      }</pre>
    </div>`}
  </div>`
}

// ── 组件：逐轮运行历史（v3.307 改版）────────────────────────────────────────
// 旧版用 before 游标 + 每页 2/3/5/10 条：180 行日志要翻 30+ 页，找某天的失败轮只能一页页点。
// 现在一次取尾窗最近 200 轮（服务端上限），在前端做「只看失败/中断」「按日期」筛选与页码分页；
// 数据量小（≤200 条），换来的是「跳日期、看失败、点日志」三件事都能直接做。
// 尾窗指纹/stale 语义仍由服务端保留（本组件只发一次 limit=200，不翻游标）。
const RUN_PAGE_SIZES = [10, 20, 50, 100]
const RUN_FETCH_LIMIT = 200

function RunHistoryPanel ({ onOpenLog }) {
  const [size, setSize] = useState(10)
  // 默认只看真实轮次：取消留痕是操作审计，不该在每次打开历史时占据一半行。
  const [mode, setMode] = useState('runs')
  const [day, setDay] = useState('')
  const [pageNo, setPageNo] = useState(1)
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const d = await apiGetRunHistory({ limit: RUN_FETCH_LIMIT, excludeCancelled: mode === 'runs' })
      if (seq !== seqRef.current) return
      setData(d)
      setErr('')
    } catch (e) {
      if (seq === seqRef.current) setErr(`加载失败：${e.message}`)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [mode])
  useEffect(() => { load().catch(() => {}) }, [load])

  const all = data && data.status === 'ok' && Array.isArray(data.items) ? data.items : []
  const issueCount = filterRunItems(all, { mode: 'issue' }).length
  const runsCount = filterRunItems(all, { mode: 'runs' }).length
  const filtered = filterRunItems(all, { mode, day })
  const pages = Math.max(1, Math.ceil(filtered.length / size))
  const current = Math.min(pageNo, pages)
  // 数据变少（筛选/刷新）时把页码收回有效区间；不在渲染期 setState。
  useEffect(() => { if (pageNo > pages) setPageNo(pages) }, [pageNo, pages])
  const shown = filtered.slice((current - 1) * size, current * size)
  const changeSize = (n) => {
    if (n === size) return
    setSize(n)
    setPageNo(1)
  }
  const refresh = () => { setPageNo(1); load().catch(() => {}) }
  const changeDay = (v) => { setDay(v); setPageNo(1) }
  const jumpLog = (r) => {
    if (!onOpenLog || typeof r.at !== 'string' || r.at.length < 10) return
    // 单轮「日志」= 看这一天的完整日志（含摘要/告警/错误）；要只看异常，进日志页点「异常」。
    onOpenLog({ q: r.at.slice(0, 10), mode: 'all' })
  }
  return html`<div class="panel">
    <${PanelHead} title="逐轮运行历史"
      sub=${err
        ? 'run.log 读取失败'
        : (data
            ? `run.log 摘要逐轮 · 最近 ${all.length} 轮` + (data.truncated ? ' · 日志已轮转/超窗，更早轮次已丢失' : '')
            : 'run.log 摘要逐轮 · 加载中…')}
      right=${html`<div class="toolbar">
        <select class="msg-select" value=${String(size)} onChange=${(e) => changeSize(Number(e.target.value))} aria-label="每页显示条数">
          ${RUN_PAGE_SIZES.map((n) => html`<option key=${n} value=${String(n)}>每页 ${n} 条</option>`)}
        </select>
        <${Button} variant="ghost" onClick=${refresh} disabled=${loading}>刷新<//>
      </div>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && data.status === 'ok' && html`<div class="run-tools">
      <div class="log-chips" role="group" aria-label="逐轮筛选">
        <button type="button" class=${'log-chip' + (mode === 'all' ? ' on' : '')}
          aria-pressed=${mode === 'all' ? 'true' : 'false'} onClick=${() => { setMode('all'); setPageNo(1) }}>${mode === 'all' ? `全部 ${all.length}` : '全部'}</button>
        <button type="button" class=${'log-chip' + (mode === 'runs' ? ' on' : '')}
          aria-pressed=${mode === 'runs' ? 'true' : 'false'} onClick=${() => { setMode('runs'); setPageNo(1) }}>仅运行 ${runsCount}</button>
        <button type="button" class=${'log-chip' + (mode === 'issue' ? ' on' : '')}
          aria-pressed=${mode === 'issue' ? 'true' : 'false'} onClick=${() => { setMode('issue'); setPageNo(1) }}>${mode === 'runs' ? '只看异常' : `只看异常 ${issueCount}`}</button>
      </div>
      <label class="run-day">
        <span>日期</span>
        <input type="date" value=${day} onInput=${(e) => changeDay(e.target.value)} onChange=${(e) => changeDay(e.target.value)} aria-label="按日期筛选轮次" />
      </label>
      ${day !== '' && html`<button type="button" class="log-chip on" onClick=${() => changeDay('')}>清除日期</button>`}
      <span class="run-tools-note">${mode === 'issue' ? '只显示失败、中断或取消的轮次' : (mode === 'runs' ? '不显示取消留痕；切「全部」可查' : '点行尾「日志」跳到该日日志')}</span>
    </div>`}
    ${data && data.status && data.status !== 'ok' && html`<div class="empty">run.log${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}</div>`}
    ${!data && !err && html`<div class="empty">加载中…</div>`}
    ${shown.length > 0 && html`<div class="runs-scroll"><table class="runs-table">
      <thead><tr><th>时间</th><th>获取</th><th>去重</th><th>过滤</th><th>推送</th><th>失败</th><th>耗时</th><th></th></tr></thead>
      <tbody>
        ${shown.map((r, i) => html`<tr key=${`${r.at}-${r.lineNo}-${i}`}>
          <td class="mono">${r.cancelled === true ? `${r.at || '—'} ⏹已取消` : r.interrupted ? `${r.at || '—'} ⚠️中断` : (r.at || '—')}</td>
          <td>${r.total == null ? '—' : r.total}</td>
          <td>${r.dedup == null ? '—' : r.dedup}</td>
          <td>${r.filtered == null ? '—' : r.filtered}</td>
          <td>${r.dryRun != null ? `试跑 ${r.dryRun}` : (r.pushed == null ? '—' : r.pushed)}</td>
          <td>${r.failed == null ? '—' : (r.failed > 0 ? html`<span class="sync-err">${r.failed}</span>` : r.failed)}</td>
          <td class="mono">${r.elapsed || '—'}</td>
          <td class="run-actions">${r.cachesaved === 0 ? html`<span class="run-note">未落盘</span>` : ''}
            <button type="button" class="row-link" disabled=${!r.at} onClick=${() => jumpLog(r)}>日志</button></td>
        </tr>`)}
      </tbody>
    </table></div>`}
    ${data && data.status === 'ok' && filtered.length === 0 && html`<div class="empty">${all.length === 0 ? '日志尾窗内没有摘要行' : '没有匹配的轮次'}</div>`}
    ${filtered.length > 0 && html`<div class="pager">
      <${Button} disabled=${current <= 1 || loading} onClick=${() => setPageNo(1)}>« 首页<//>
      <${Button} disabled=${current <= 1 || loading} onClick=${() => setPageNo(current - 1)}>上一页<//>
      <span class="pager-info">第 ${current} / ${pages} 页 · 共 ${filtered.length} 条</span>
      <${Button} disabled=${current >= pages || loading} onClick=${() => setPageNo(current + 1)}>下一页<//>
      <${Button} disabled=${current >= pages || loading} onClick=${() => setPageNo(pages)}>末页 »<//>
    </div>`}
  </div>`
}

// ── 组件：整体 ──────────────────────────────────────────────────────────────
// v3.297 标签页：概览（原看板+触发+历史）/ 推送记录 / 运行日志 / 系统。
// 轮询只挂在概览（状态+历史要跟任务跑）；其余标签页进页时拉取 + 手动刷新，
// 不自动轮询——消息/日志读的是磁盘文件，5s 轮询只会白耗磁盘与带宽。

// 近 14 日趋势（纯 CSS 条形图，零依赖）：一格=一天，高度按当日推送条数归一。
// failed>0 的日子用红色渐变提示；0 推送的日子画灰色基线（看得见「没有数据」≠ 没画）。
// 面板加载器公共骨架：data/err 状态 + load()（成功清错、失败写横幅）。
// apiFn 由调用方用 useCallback/useMemo 固定引用，避免 effect 风暴。
function usePanelLoader (apiFn, onLoaded) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0) // 竞态守卫：只应用「最新一次 load」的响应（审查 Sourcery PR#227）
  const mountedRef = useRef(true) // 卸载后旧请求仍可能回包：不得再写父页时间戳（PR#253）
  useEffect(() => () => { mountedRef.current = false }, [])
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const d = await apiFn()
      if (seq !== seqRef.current || !mountedRef.current) return // 已有更新的请求或面板已卸载，本次响应作废
      setData(d)
      setErr('')
      if (typeof onLoaded === 'function') onLoaded(Date.now())
    } catch (e) {
      if (seq !== seqRef.current || !mountedRef.current) return
      setErr(`加载失败：${e.message}`)
    } finally {
      if (seq === seqRef.current && mountedRef.current) setLoading(false)
    }
  }, [apiFn, onLoaded])
  return { data, err, load, loading }
}

// 趋势天数选择器固定选项（与服务端白名单 TREND_DAYS_ALLOWED 对齐；14 为默认省略参数）
const TREND_DAYS = [14, 30, 60]

function TrendsPanel () {
  const [days, setDays] = useState(TREND_DAYS[0])
  const fetchTrends = useCallback(() => apiGetTrends(days), [days])
  const { data: trends, err, load } = usePanelLoader(fetchTrends)
  useEffect(() => { load().catch(() => {}) }, [load])
  // 展示口径只认「响应自带的 days」：切窗口后旧响应未替换（请求中/失败）时，
  // 标题与合计必须跟随旧窗口的数据，不能拿着旧数据标新窗口。
  const shownDays = trends && Number.isSafeInteger(trends.days) && TREND_DAYS.includes(trends.days)
    ? trends.days
    : (trends ? null : days) // 尚无任何响应时才用当前选择器值占位
  const byDay = trends && trends.status === 'ok' ? trends.byDay : []
  const maxPushed = Math.max(1, ...byDay.map((d) => d.pushed))
  const totalAll = byDay.reduce((acc, d) => acc + d.pushed, 0)
  const failAll = byDay.reduce((acc, d) => acc + d.failed, 0)
  // today 由服务端按 Asia/Shanghai 日历日下发（run.log 时间戳口径），浏览器本地时区不再参与
  const todayKey = trends && trends.today ? trends.today : ''
  // 点/键盘选中某天：手机没有 hover，title 提示不可达，点按展开当天明细（评审 #243-4）
  const [selDay, setSelDay] = useState(null)
  const toggleDay = (date) => setSelDay((cur) => (cur === date ? null : date))
  // 横向滚动：默认停在最右侧（最近一天），用户可直接左滑看更早日期
  const scrollRef = useRef(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const trend = el.firstElementChild
    if (!trend) return undefined
    let raf = 0
    const align = () => {
      raf = 0
      // 每轮先清掉上一轮补的右 padding：14→30→60 来回切时它会累加成大块空白。
      trend.style.paddingRight = ''
      el.scrollLeft = el.scrollWidth
      // 最右停靠时最左列可能只露半截：把下一个完整列的左缘对齐到容器左缘，
      // 不够的滚动量用右 padding 补出来（只在自动停靠时做，用户手动滑动不干预）。
      // 注意基准是滚动容器的左缘（面板有内边距，视口 x=0 不是容器左缘）。
      const base = el.getBoundingClientRect().left
      const cols = [...trend.children]
      const partial = cols.find((c) => {
        const r = c.getBoundingClientRect()
        return r.left < base && r.right > base
      })
      if (!partial) return
      const next = cols[cols.indexOf(partial) + 1]
      if (!next) return
      const shift = next.getBoundingClientRect().left - base
      if (shift <= 0) return
      const max = el.scrollWidth - el.clientWidth
      const need = el.scrollLeft + shift - max
      if (need > 0) {
        const pad = parseFloat(window.getComputedStyle(trend).paddingRight) || 0
        trend.style.paddingRight = `${Math.ceil(pad + need)}px`
      }
      el.scrollLeft += shift
    }
    const schedule = () => { if (raf === 0) raf = window.requestAnimationFrame(align) }
    align()
    // 容器宽度变化（横竖屏、窗口缩放）时 byDay.length 不变，也必须重新对齐；
    // 否则会保留旧 padding/滚动位置，最右几列又跑出容器（Sourcery #254）。
    let ro = null
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(schedule)
      ro.observe(el)
    } else {
      window.addEventListener('resize', schedule)
    }
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf)
      if (ro !== null) ro.disconnect()
      else window.removeEventListener('resize', schedule)
    }
  }, [byDay.length])
  return html`<div class="panel">
    <${PanelHead} title=${shownDays ? `近 ${shownDays} 日运行趋势` : '运行趋势'}
      afterTitle=${html`<select class="msg-select" value=${String(days)} onChange=${(e) => setDays(Number(e.target.value))} aria-label="趋势窗口天数">
        ${TREND_DAYS.map((d) => html`<option key=${d} value=${String(d)}>${d} 日</option>`)}
      </select>`}
      sub=${'run.log 摘要按日聚合' + (trends && trends.truncated ? '（日志超限，仅统计尾部 1 MiB）' : '')}
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${trends && trends.status !== 'ok' && html`<div class="empty">日志${trends.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${trends.status}）`}</div>`}
    ${trends && trends.status === 'ok' && html`<div>
      <div class="trend-scroll" ref=${scrollRef}>
        <div class="trend">
          ${byDay.map((d) => html`<div class="trend-col" key=${d.date} role="button" tabindex="0"
            aria-label=${`${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}`}
            title=${`${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}`}
            onClick=${() => toggleDay(d.date)}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(d.date) } }}>
            <span class="trend-n">${d.pushed > 0 ? d.pushed : ''}</span>
            <div class=${'trend-bar' + (d.pushed === 0 ? ' zero' : '') + (d.failed > 0 ? ' fail' : '')} style=${`height:${Math.max(3, Math.round(d.pushed / maxPushed * 88))}px`}></div>
            <span class=${'trend-day' + (d.date === todayKey ? ' today' : '')}>${d.date.slice(5)}</span>
          </div>`)}
        </div>
      </div>
      ${selDay && (() => {
        const d = byDay.find((x) => x.date === selDay)
        return d ? html`<div class="trend-detail">${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}</div>` : ''
      })()}
      <div class="trend-meta">${shownDays || ''} 日共推送 ${totalAll} 条 · 失败 ${failAll} 条${failAll > 0 ? ' · 红柱=当日有失败' : ''} · 左右滑动查看更早日期，点柱子看每日明细</div>
    </div>`}
  </div>`
}

// 缓存健康（v3.298）：判重缓存字节占用对照两级上限 + 墓碑计数。纯只读快照，
// 进概览页拉一次 + 手动刷新，不进 5s 主轮询（墓碑解析最坏 8MiB，不与状态轮询抢盘）。
// 条数维度：服务端在响应里附带 entryCount（readMessageCount，与 /api/messages 同一
// 读取封顶与防御；tooLarge 时 null 如实显示），对照 limits.entryMax 预警。
function CacheHealthPanel ({ paused = false }) {
  const { data, err, load } = usePanelLoader(apiGetCacheHealth)
  // 右列状态文件（v3.307）：缓存健康面板原来只占左半 451px，右边 460px 空白；
  // 系统页的「缓存目录文件」在这里给一份紧凑版（前 8 项），整页仍保留全量清单。
  const filesLoader = usePanelLoader(apiGetFiles)
  useEffect(() => { load().catch(() => {}); filesLoader.load().catch(() => {}) }, [load, filesLoader.load])
  // 缓存健康随概览常开：每分钟（且切回前台时）重拉一次，避免「页面开着过夜、mtime 早已更新
  // 但面板还拿着旧快照」；1 分钟一次只读小 JSON，不与 5s 主轮询抢盘。
  useEffect(() => {
    if (paused) return undefined
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') load().catch(() => {}) }, 60000)
    const onVis = () => { if (document.visibilityState === 'visible') load().catch(() => {}) }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [load, paused])
  const ok = data && data.status === 'ok'
  const ratioText = ok && data.writeRatio != null ? `${(data.writeRatio * 100).toFixed(1)}%` : '—'
  const tomb = data && data.tombstone ? data.tombstone : null
  // 最近写入：显示相对时间；超过 24 小时只陈述事实（不推断链路断没断——调度暂停同样会这样）。
  const write = ok ? cacheWriteInfo(data.mtimeMs) : { ageText: '', stale: false }
  // 控制台可读：长解释收进 title，首屏只留结论。上限取服务端下发的
  // limits.consoleReadMaxBytes（此前写死 32 MiB，服务端调到 64 MiB 后文案说谎）。
  const readCap = ok && data.limits && typeof data.limits.consoleReadMaxBytes === 'number'
    ? fmtBytes(data.limits.consoleReadMaxBytes)
    : '控制台读取上限'
  const readableText = data && data.consoleReadable
    ? `是（未超 ${readCap} 读取封顶）`
    : `否——超过 ${readCap} 读取封顶，推送记录页显示「过大不可读」（生产不受影响）`
  const readableTitle = '超限与否以推送记录页实际显示为准；JSON 损坏时该页会显示「记录不可读」'
  // 条数预警：服务端在 cache-health 响应里附带 entryCount（/api/status 同源的
  // readMessageCount；tooLarge 时 null）对照写端条目上限；接近上限时下轮保存
  // 会裁最旧条目（与字节裁剪同一出口）。
  const entryNear = ok && typeof data.entryCount === 'number' && data.entryCount >= data.limits.entryMax * 0.8
  const entryOver = ok && typeof data.entryCount === 'number' && data.entryCount >= data.limits.entryMax
  const files = filesLoader.data && Array.isArray(filesLoader.data.files) ? filesLoader.data.files : []
  return html`<div class="panel">
    <${PanelHead} title="缓存健康" sub=${(data && data.file ? data.file : 'push.json') + ' · 判重缓存占用'}
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && !ok && html`<div class="empty">${data.status === 'missing' ? '缓存尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}</div>`}
    ${ok && html`<div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>缓存大小</td><td>${fmtBytes(data.bytes)}（上限 ${fmtBytes(data.limits.writeMaxBytes)}）</td></tr>
        <tr><td>占用比例</td><td>${ratioText}${data.nearTrim ? ' · ⚠️ 临近字节裁剪' : ''}${data.overLimit ? ' · ⛔ 已超写端上限' : ''}</td></tr>
        <tr><td>条目数</td><td>${ok && typeof data.entryCount === 'number' ? `${data.entryCount} / ${data.limits.entryMax} 条上限${entryOver ? ' · ⛔ 已达上限，旧记录将被裁剪' : entryNear ? ' · ⚠️ 临近条目上限' : ''}` : `上限 ${data.limits.entryMax} 条${ok && data.entryCountStatus === 'tooLarge' ? '（当前条数不可得：缓存超控制台读取封顶）' : '（进推送记录页获取当前条数）'}`}</td></tr>
        <tr><td>控制台可读</td><td title=${readableTitle}>${readableText}</td></tr>
      </tbody></table>
      <div class="cache-side">
      <table class="sys-table"><tbody>
        <tr><td>墓碑状态</td><td>${tomb ? (tomb.status === 'ok' ? '正常' : tomb.status === 'missing' ? '尚未生成（未发生过裁剪时正常）' : `异常（${tomb.status}）`) : '—'}${tomb && tomb.status === 'ok' ? ` · ${tomb.counts.total} 键` : ''}</td></tr>
        <tr><td>最近写入</td><td>${data.mtimeMs ? `${fmtTime(data.mtimeMs)}${write.ageText ? ` · ${write.ageText}` : ''}` : '—'}${write.stale ? ' · 超过 24 小时未写入缓存' : ''}</td></tr>
      </tbody></table>
      <div class="cache-files">
        <div class="cache-files-head"><span>状态目录文件</span><button type="button" class="row-link" onClick=${filesLoader.load}>刷新</button></div>
        ${files.length === 0
          ? html`<div class="cache-files-empty">${filesLoader.err ? '文件清单加载失败' : '暂无文件'}</div>`
          : html`<table class="sys-table compact"><tbody>
            ${files.slice(0, 8).map((f) => html`<tr key=${f.name}>
              <td class="mono">${f.name}</td>
              <td>${f.kind === 'file' ? fmtBytes(f.bytes) : f.kind === 'symlink' ? '⚠️ 符号链接' : f.kind}</td>
            </tr>`)}
          </tbody></table>`}
      </div>
      </div>
    </div>`}
    ${ok && (data.nearTrim || data.overLimit || !data.consoleReadable) && html`<${Hint} style="margin-top:10px">占用达到写端上限 80% 时，下一轮保存会自动裁掉最旧条目并落墓碑——无需人工干预，但如果你希望保留更久，检查推送频率与 maxPerRun 配置。<//>`}
  </div>`
}

// 推送记录：搜索（300ms 防抖）+ 分类筛选 + 服务端分页；点标题展开 content 全文。
// URL 不含 content_html（服务端已裁剪）——CSP 禁外链图，贴文本才是控制台能诚实渲染的形态。
// 原文链接：相对路径拼服务端下发的 baseUrl（= 生产 Config.domain，与推送侧 resolve 同口径），
// 绝对 URL 原样；只放行 http/https（其他 scheme 不渲染链接）。
function msgHref (u, base) {
  if (u.startsWith('http://') || u.startsWith('https://')) return u
  if (u.startsWith('//')) return `https:${u}`
  const b = typeof base === 'string' && base.length > 0 ? base : 'https://new.ixbk.net'
  return `${b}${u.startsWith('/') ? u : '/' + u}`
}

function msgLink (m, base) {
  if (!(typeof m.url === 'string' && m.url.length > 0)) return ''
  const title = m.url.startsWith('http') ? `外部链接（来源站点）：${m.url}` : '外部链接（来源站点）'
  return html`<a class="msg-link" href=${msgHref(m.url, base)}
    target="_blank" rel="noopener noreferrer"
    title=${title}>原文链接 ↗</a>`
}

// 分类名是「来源-品类-平台」的三段式（如 好单线报-日用-京东）；按 '-' 建树，
// 弹层里逐级下钻，而不是把 83 个全名平铺给用户。
function buildCateTree (categories) {
  const root = { name: '', path: [], children: new Map(), count: 0, total: 0, full: '' }
  for (const c of categories) {
    if (!c || typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 300) continue
    // 按原始 '-' 段建树（不 trim/去空，避免 A-B 与 A- B 被合并）；最多 6 级，
    // 防上游塞超深分类名把渲染递归打爆。full 仍保留原始全名，筛选口径不变。
    const parts = c.name.split('-').slice(0, 6)
    if (parts.length === 0) continue
    let node = root
    for (const p of parts) {
      if (!node.children.has(p)) node.children.set(p, { name: p, path: [...node.path, p], children: new Map(), count: 0, total: 0, full: '' })
      node = node.children.get(p)
    }
    node.count += Number(c.count) || 0
    node.full = c.name
  }
  const sum = (n) => {
    let t = n.count
    for (const ch of n.children.values()) t += sum(ch)
    n.total = t
    return t
  }
  sum(root)
  return root
}
function flatCateLeaves (node, out = []) {
  for (const ch of node.children.values()) {
    if (ch.full) out.push({ name: ch.full, label: ch.path.map((s) => s.trim() || '（空）').join(' › '), count: ch.count })
    if (ch.children.size > 0) flatCateLeaves(ch, out)
  }
  return out
}

// 分类筛选：自定义弹层而不是原生 <select>。
// Android 上原生 select 会弹出全屏白底系统列表（80+ 分类、无搜索、与暗色控制台割裂），
// 这里改为暗色下拉 + 搜索，手机端贴底弹出，选中项打勾。
function CategoryPicker ({ value, categories, total, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [path, setPath] = useState([])
  const [active, setActive] = useState(0)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [place, setPlace] = useState({ up: false, max: 380 })
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const searchRef = useRef(null)
  const listRef = useRef(null)
  // 键盘导航时焦点既要避免带动整页滚动，又必须把选项滚进 .cate-list 的可视区。
  // 只调 focus({preventScroll:true}) 会让长列表里获得焦点的项停在视口外（Sourcery #254）。
  const focusInList = (el) => {
    if (!el) return
    el.focus({ preventScroll: true })
    const list = listRef.current
    if (!list) return
    if (!list.contains(el)) return
    const r = el.getBoundingClientRect()
    const lr = list.getBoundingClientRect()
    if (r.top < lr.top) list.scrollTop -= (lr.top - r.top)
    else if (r.bottom > lr.bottom) list.scrollTop += (r.bottom - lr.bottom)
  }
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // 每次打开都从一级分类开始；搜索词、高亮项与列表滚动一并清空（审查 #246 可选：
  // 手机端重开弹层时不能停在上次的 active 下标/滚动位置，否则容易误下钻）。
  useEffect(() => {
    if (open) {
      setPath([]); setQ(''); setActive(0)
      if (listRef.current) listRef.current.scrollTop = 0
    }
  }, [open])
  // 手机端是贴底模态弹层：锁住背景页滚动（审查 #245），否则手指滑弹层会把背后的
  // 推送记录/页面一起带动。只在本组件打开且窄屏时接管，关闭时还原原值。
  useEffect(() => {
    if (!open || !narrow) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open, narrow])
  // 打开时：桌面把焦点放进搜索框；手机聚焦当前选项（不弹软键盘）。
  useEffect(() => {
    if (!open) return undefined
    if (narrow) {
      // 打开时 path 会在同一提交里重置为空；立刻 query 会聚焦到上一级即将被移除的节点，
      // 重置渲染后焦点就丢了。延后一拍，等新一级列表渲染完再聚焦（与 focusFirst 同口径）。
      const t = setTimeout(() => {
        const el = listRef.current && listRef.current.querySelector('.cate-opt[tabindex="0"]')
        if (el) focusInList(el)
      }, 0)
      return () => clearTimeout(t)
    }
    if (searchRef.current) searchRef.current.focus({ preventScroll: true })
    return undefined
  }, [open, narrow])
  // 搜索词/层级变化后回到第一项，避免 active 指向已被过滤掉的项。
  useEffect(() => { setActive(0) }, [q, path])
  // 桌面端空间不足时向上翻，并按可用高度限制弹层，避免被视口底边裁掉。
  useEffect(() => {
    if (!open || narrow) return
    const calc = () => {
      const r = btnRef.current.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const want = 380
      if (below < Math.min(300, want) && above > below) setPlace({ up: true, max: Math.min(want, above) })
      else setPlace({ up: false, max: Math.min(want, below) })
    }
    calc()
    window.addEventListener('resize', calc)
    window.addEventListener('scroll', calc, true)
    return () => {
      window.removeEventListener('resize', calc)
      window.removeEventListener('scroll', calc, true)
    }
  }, [open, narrow])
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!rootRef.current || !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        if (btnRef.current) btnRef.current.focus({ preventScroll: true })
        return
      }
      // 手机端是带遮罩的模态弹层：Tab 在弹层内循环，不跑到背后的工具栏。
      if (e.key === 'Tab' && narrow && popRef.current) {
        const f = [...popRef.current.querySelectorAll('button, input')].filter((el) => !el.disabled && el.tabIndex !== -1)
        if (f.length === 0) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); focusInList(last) } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); focusInList(first) }
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, narrow])
  const current = categories.find((c) => c.name === value)
  const label = value === '' ? '全部分类' : `${value}${current ? `（${current.count}）` : ''}`
  const tree = buildCateTree(categories)
  let node = tree
  for (const p of path) node = node.children.get(p) || node
  const kw = q.trim().toLowerCase()
  const leaves = kw === '' ? [] : flatCateLeaves(tree)
  const results = kw === '' ? [] : leaves.filter((l) => l.label.toLowerCase().includes(kw) || l.name.toLowerCase().includes(kw))
  const level = [...node.children.values()].sort((a, b) => b.total - a.total)
  // 分类名同时是叶子与父节点时（如 A-B 与 A-B-C 并存），父级此前只能下钻、永远选不到
  // A-B 本身（审查 #246 可选）。下钻后补一条「本级」选项，既能选自己也能继续下钻。
  const selfOption = path.length > 0 && node.full
    ? [{ key: '__self', label: `${node.name}（本级）`, count: node.count, leaf: true, name: node.full }]
    : []
  const options = kw === ''
    ? [...(path.length === 0 ? [{ key: '__all', label: '全部分类', count: typeof total === 'number' ? total : tree.total, leaf: true, name: '' }] : []),
        ...selfOption,
        ...level.map((n) => ({ key: n.path.join('-'), label: n.name, count: n.total, leaf: n.children.size === 0, name: n.full, node: n }))]
    : results.map((l) => ({ key: l.name, label: l.label, count: l.count, leaf: true, name: l.name }))
  const focusFirst = () => {
    setTimeout(() => {
      const el = listRef.current && listRef.current.querySelector('.cate-opt[tabindex="0"]')
      if (el) focusInList(el)
    }, 0)
  }
  const choose = (name) => {
    onChange(name)
    setOpen(false)
    setQ('')
    if (btnRef.current) btnRef.current.focus({ preventScroll: true })
  }
  const pick = (o) => {
    if (!o.leaf) {
      setPath(o.node.path)
      setQ('')
      setActive(0)
      // 下钻后把焦点放到新一级第一项：键盘 Enter 不会掉到 body 上。
      focusFirst()
      return
    }
    choose(o.name)
  }
  const go = (nextPath) => {
    setPath(nextPath)
    setQ('')
    setActive(0)
    // 面包屑/「‹ 上一级」会重渲染掉当前按钮，焦点必须搬回列表（审查 #246：
    // 否则返回上层后焦点掉到 body，键盘下钻中断）。
    focusFirst()
  }
  const dismiss = () => {
    setOpen(false)
    setQ('')
    if (btnRef.current) btnRef.current.focus({ preventScroll: true })
  }
  const onListKey = (e) => {
    const opts = listRef.current ? [...listRef.current.querySelectorAll('.cate-opt')] : []
    if (opts.length === 0) return
    const inSearch = e.target === searchRef.current
    // 搜索框里的 Home/End 是文本光标操作，不能被列表导航劫持（审查 #245：
    // 此前光标无法到词首/词尾）。上下键仍可从搜索框进入列表。
    if (inSearch && (e.key === 'Home' || e.key === 'End')) return
    // 搜索框按 Enter 直接选中当前高亮项（审查 #245 可选：此前必须先 ↓ 再 Enter）。
    if (inSearch && e.key === 'Enter') {
      const target = opts[Math.min(active, opts.length - 1)]
      if (target) { e.preventDefault(); target.click() }
      return
    }
    const i = opts.indexOf(document.activeElement)
    let next = -1
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(opts.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = i < 0 ? 0 : Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = opts.length - 1
    if (next >= 0) {
      e.preventDefault()
      setActive(next)
      focusInList(opts[next])
    }
  }
  return html`<div class="cate-picker" ref=${rootRef}>
    <button type="button" class="cate-btn" ref=${btnRef} aria-haspopup="dialog"
      aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      <span class="cate-btn-label">${label}</span><span class="cate-caret" aria-hidden="true">▾</span>
    </button>
    ${open && html`<div class="cate-backdrop" aria-hidden="true" onClick=${dismiss}></div>
      <div class="cate-pop" ref=${popRef} role="dialog" aria-modal=${narrow ? 'true' : 'false'} aria-label="分类筛选"
        style=${narrow ? '' : `max-height:${Math.max(180, place.max)}px;${place.up ? 'top:auto;bottom:calc(100% + 6px);' : ''}`}>
        <input class="cate-search" ref=${searchRef} type="search" placeholder="搜索全部分类…"
          value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onListKey} />
        ${kw === ''
          ? html`<div class="cate-crumb">
            ${path.length > 0 && html`<button type="button" class="cate-back" aria-label="上一级"
              onClick=${() => go(path.slice(0, -1))}>‹</button>`}
            <button type="button" class="cate-crumb-link" onClick=${() => go([])}>全部分类</button>
            ${path.map((p, i) => html`<span class="cate-crumb-sep">›</span>
              <button type="button" class="cate-crumb-link" onClick=${() => go(path.slice(0, i + 1))}>${p}</button>`)}
          </div>`
          : html`<div class="cate-crumb"><span class="cate-crumb-cur">搜索“${q.trim()}”</span></div>`}
        <div class="cate-list" ref=${listRef} role="listbox" aria-label="分类" onKeyDown=${onListKey}>
          ${options.map((o, i) => html`<button type="button" key=${o.key}
            class=${'cate-opt' + (o.leaf ? '' : ' group') + (o.leaf && value === o.name ? ' active' : '')}
            role="option" aria-selected=${o.leaf && value === o.name ? 'true' : 'false'}
            tabIndex=${i === active ? 0 : -1} onFocus=${() => setActive(i)}
            title=${o.label} onClick=${() => pick(o)}>
            <span class="cate-opt-name">${o.label}</span>
            <span class="cate-count">${o.count}</span>
            <span class="cate-check">${o.leaf ? (value === o.name ? '✓' : '') : '›'}</span>
          </button>`)}
        </div>
        ${options.length === 0 && html`<div class="cate-empty">没有匹配的分类</div>`}
        <div class="cate-foot">${kw === ''
          ? (path.length === 0
              ? `${level.length + 1} 个一级分类${typeof total === 'number' ? ` · ${total} 条` : ''} · 逐级选择`
              : `${path[path.length - 1]}：${level.length} 项 · ${node.total} 条 · ${level.some((n) => n.children.size === 0) ? '点选筛选' : '逐级选择'}`)
          : `${results.length} 个匹配分类 · 点选即筛选`}</div>
      </div>`}
  </div>`
}

function MessagesPanel ({ onSync }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [cate, setCate] = useState('')
  const [days, setDays] = useState(0)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(null) // 展开的条目 rowKey（无 id 条目是 idx-N 合成键）
  // 响应归属（问题5）：请求发出时记下的 query 会在 in-flight 期间过期——旧响应的
  // queryUsed 会把刚打的新词清空（搜索吞字）。改为：loadSeqRef 给每次请求领号，
  // loadedQueryRef 只在「最新一次请求」回包时记录它对应的 query。
  const loadedQueryRef = useRef('')
  const loadSeqRef = useRef(0)
  // 搜索防抖：输入停 300ms 才真正改 query；页码重置跟随 query 的真实变化。
  useEffect(() => {
    const t = setTimeout(() => { setQuery(input.trim()) }, 300)
    return () => clearTimeout(t)
  }, [input])
  // 只有 query 真的变了才回第 1 页；只加/减空白时 query 不变，刷新不应把用户踢回首页。
  useEffect(() => { setPage(1) }, [query])
  const fetchMessages = useCallback(
    () => {
      const requested = query
      const seq = ++loadSeqRef.current
      return apiGetMessages({ page, size, cate, q: requested, days }).then((d) => {
        if (seq === loadSeqRef.current) loadedQueryRef.current = requested
        return d
      })
    },
    [page, size, cate, query, days])
  const { data, err, load, loading } = usePanelLoader(fetchMessages, onSync)
  useEffect(() => { load().catch(() => {}) }, [load])
  // 结果集缩小后旧页码可能超过新页数（服务端按请求页切片，回空 items）。收到响应后把
  // 页码钳到最后一页并重拉，避免「在后面的页点刷新，整页空白」。
  useEffect(() => {
    if (data && data.status === 'ok' && Number.isSafeInteger(data.pages) && data.pages >= 1 && page > data.pages) {
      setPage(data.pages)
    }
  }, [data, page])
  // 搜索框回车 / 刷新前先把未落地的输入立刻生效，避免「刚打完字点刷新，还是旧结果」。
  // 只有搜索词变了才回第 1 页；没改词时刷新当前页，不应把用户踢回首页（审查 #246 可选）。
  const refreshNow = () => {
    const q = input.trim()
    if (q !== query) { setQuery(q); setPage(1); return }
    load().catch(() => {})
  }
  const [exporting, setExporting] = useState('') // '' | 'csv' | 'json'：加载态防连点（两按钮共用一闸）
  const [exportErr, setExportErr] = useState('')
  const [exportNote, setExportNote] = useState('')

  // 导出下载（v3.300 3.2）：POST /api/messages/export（字面量第一参数 + 筛选词只进 body）
  // → response.blob() → URL.createObjectURL → 临时 <a download> 点击 → revokeObjectURL。
  // 不拼服务端下载 URL：凭证不出现在 href（蓝图红线）。
  const doExport = useCallback(async (format) => {
    if (exporting !== '') return
    setExporting(format)
    setExportErr('')
    setExportNote('')
    const body = new URLSearchParams({ format })
    if (typeof cate === 'string' && cate.length > 0) body.set('cate', cate)
    if (typeof query === 'string' && query.length > 0) body.set('q', query)
    if (Number.isSafeInteger(days) && days > 0) body.set('days', String(days))
    // page/size 不发送：导出=筛选结果全量（服务端亦不读取）。
    const { merged, done } = timedRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${BOOT.token}`
      },
      body
    })
    let url = ''
    try {
      const res = await fetch('/api/messages/export', merged)
      if (!res.ok) { setExportErr(`导出失败：HTTP ${res.status}`); return }
      const ct = String(res.headers.get('content-type') || '')
      const blob = await res.blob()
      if (ct.startsWith('application/json')) {
        // application/json 两种含义（评审 231-H1）：三态（missing/invalid/tooLarge）=
        // {status,...} 对象 → 不下载、如实提示；成功导出 = 行数组 → 照常下载。
        // 按 Array.isArray 区分（成功形态 231-M1 已改为直接数组）。
        let parsed = null
        try { parsed = JSON.parse(await blob.text()) } catch (e) { parsed = null }
        if (!Array.isArray(parsed)) {
          const status = parsed && typeof parsed.status === 'string' ? parsed.status : 'unknown'
          setExportErr(`记录暂不可导出（${status}）`)
          return
        }
        if (res.headers.get('x-export-truncated') === 'true') setExportNote('匹配结果超过上限，导出已截断')
        url = URL.createObjectURL(new Blob([JSON.stringify(parsed)], { type: 'application/json' }))
      } else {
        if (res.headers.get('x-export-truncated') === 'true') setExportNote('匹配结果超过上限，导出已截断')
        url = URL.createObjectURL(blob)
      }
      const a = document.createElement('a')
      a.href = url
      a.download = format === 'csv' ? 'messages-export.csv' : 'messages-export.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      setExportErr(`导出失败：${e && e.message ? e.message : e}`)
    } finally {
      done() // body（blob/text）消费完才清 8s 期限（Sourcery Stalled-bodies 同口径）
      // revoke 延迟到 click 之后一拍（评审 231-M5）：浏览器解析下载是异步的，同步
      // revoke 会让 deferred download 拿不到 blob。1 分钟后回收（URL 规范建议的
      // 「延迟 revoke」口径，内存占用一次性、不累积）。
      if (url !== '') setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { /* 已回收 */ } }, 60000)
      setExporting('')
    }
  }, [exporting, cate, query, days])
  const items = data && Array.isArray(data.items) ? data.items : []
  const categories = data && Array.isArray(data.categories) ? data.categories : []
  // 分类弹层的「全部分类」计数必须跟时间窗走（服务端 days>0 时 categories 已按窗口重算）；
  // 直接用 grandTotal 会在「今天」里显示全量 374，看起来像筛选没生效。
  const cateTotal = data && Array.isArray(data.categories)
    ? data.categories.reduce((sum, c) => sum + (typeof c.count === 'number' ? c.count : 0), 0)
    : null
  // 服务端对超长搜索词按字节截断——回显以 queryUsed（实际生效值）为准，
  // 但只在「响应确实属于当前查询、且用户没有继续输入」时回写；
  // 否则旧响应会把刚打的新词覆盖回旧值（搜索像没生效）。
  useEffect(() => {
    if (!data || typeof data.queryUsed !== 'string') return
    // 只接受「本次响应确实对应当前 query」的回写：旧 data 的 queryUsed 不能把刚输入的新词清空。
    if (loadedQueryRef.current !== query) return
    if (data.queryUsed !== query && input.trim() === query) {
      setInput(data.queryUsed)
      setQuery(data.queryUsed)
    }
  }, [data, input, query])
  return html`<div class="panel">
    <${PanelHead} title="推送记录" sub="判重缓存 push.json（已抓取并推送的消息）" />
    <div class="msg-toolbar">
      <input class="msg-search" type="search" placeholder="搜索标题 / 内容…" value=${input}
        onInput=${(e) => setInput(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); refreshNow() } }} />
      <${CategoryPicker} value=${cate} categories=${categories}
        total=${cateTotal}
        onChange=${(v) => { setCate(v); setPage(1) }} />
      <select class="msg-select" value=${String(days)} onChange=${(e) => { setDays(Number(e.target.value)); setPage(1) }} aria-label="时间范围">
        <option value="0">全部时间</option>
        <option value="1">今天</option>
        <option value="3">近 3 天</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
      </select>
      <select class="msg-select" value=${String(size)} onChange=${(e) => { setSize(Number(e.target.value)); setPage(1) }} aria-label="每页显示条数">
        ${[10, 20, 50, 100].map((n) => html`<option key=${n} value=${String(n)}>每页 ${n} 条</option>`)}
      </select>
      <${Button} variant="ghost" disabled=${loading} onClick=${refreshNow}>${loading ? '刷新中…' : '刷新'}<//>
      <${Button} variant="ghost" disabled=${exporting !== ''} onClick=${() => doExport('csv')}>${exporting === 'csv' ? '导出中…' : '导出 CSV'}<//>
      <${Button} variant="ghost" disabled=${exporting !== ''} onClick=${() => doExport('json')}>${exporting === 'json' ? '导出中…' : '导出 JSON'}<//>
    </div>
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${exportErr && html`<${Hint} tone="error">${exportErr}<//>`}
    ${exportNote && html`<${Hint}>${exportNote}<//>`}
    ${loading && !data && html`<div class="empty">加载中…</div>`}
    ${data && data.status !== 'ok' && html`<div class="empty">记录${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}${data.cacheDirHint ? html`<${Hint}>正在读取目录：${data.cacheDirHint}（若运行缓存在别处，请让 XBK_CACHE_DIR 与运行侧 Config.cache.dir 一致）<//>` : ''}</div>`}
    ${data && data.status === 'ok' && html`<div>
      <div class="msg-count" aria-live="polite">匹配 ${data.total} 条${(query.length > 0 || cate.length > 0) && data.grandTotal !== data.total ? ` / 共 ${data.grandTotal} 条` : ''}${loading ? html`<span class="msg-loading"> · 更新中…</span>` : ''}</div>
      ${items.length === 0
        ? html`<div class="empty">没有匹配的记录</div>`
        : html`<div class="msg-list">
          ${items.map((m) => html`<div class="msg-item" key=${m.rowKey}>
            <div class="msg-item-head">
              <span class="msg-title" role="button" tabindex="0"
                aria-expanded=${expanded === m.rowKey ? 'true' : 'false'}
                title=${expanded === m.rowKey ? '收起正文' : '点击展开正文'}
                onClick=${() => setExpanded(expanded === m.rowKey ? null : m.rowKey)}
                onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(expanded === m.rowKey ? null : m.rowKey) } }}>
                <span class="msg-caret" aria-hidden="true">${expanded === m.rowKey ? '▾' : '▸'}</span>${m.title || '（无标题）'}
              </span>
              ${m.price !== null ? html`<span class="msg-price">¥${m.price}</span>` : ''}
            </div>
            <div class="msg-meta">
              <span class="msg-cate">${m.catename}</span>
              <span class="mono">${m.datetime} ${m.shorttime}</span>
              ${msgLink(m, data.baseUrl)}
            </div>
            ${expanded === m.rowKey && html`<div class="msg-content">${m.content || '（无正文）'}</div>`}
          </div>`)}
        </div>`}
      <div class="pager">
        <${Button} disabled=${page <= 1} onClick=${() => setPage(1)}>« 首页<//>
        <${Button} disabled=${page <= 1} onClick=${() => setPage(page - 1)}>上一页<//>
        <span class="pager-info">第 ${data.page} / ${data.pages} 页</span>
        <${Button} disabled=${page >= data.pages} onClick=${() => setPage(page + 1)}>下一页<//>
        <${Button} disabled=${page >= data.pages} onClick=${() => setPage(data.pages)}>末页 »<//>
      </div>
    </div>`}
  </div>`
}

// 运行日志：run.log 尾部（服务端 1MiB 上限），进页拉一次 + 手动刷新；有任务在跑时跟随轮询。
// 异常口径与筛选在 pure.mjs（isIssueLogLine / filterLogLines），组件与测试共用。
function LogsPanel ({ pollMs, initialQuery = '', initialMode = 'all', onSync }) {
  const { data, err, load: loadRaw } = usePanelLoader(apiGetLogs, onSync)
  const preRef = useRef(null)
  const stickRef = useRef(true)
  const prevTextRef = useRef('')
  // 轮询互斥（审查 #231 前端项）：任务运行时每 2s 拉 1 MiB，上一请求未回时再叠一发
  // 只会让服务端并发读盘、后到的响应还可能盖掉新结果。手动刷新同样走这把闸。
  const busyRef = useRef(false)
  const pendingRef = useRef(false)
  const load = useCallback(async (queue = false) => {
    // 手动刷新撞上在飞请求时不丢这次意图：记 pending，当前请求结束后再补一轮。
    // 轮询/可见性补拉不排队（queue=false），避免慢请求把轮询变成背靠背重试。
    if (busyRef.current) {
      if (queue) pendingRef.current = true
      return
    }
    busyRef.current = true
    try {
      do {
        pendingRef.current = false
        await loadRaw()
      } while (pendingRef.current)
    } finally {
      busyRef.current = false
      pendingRef.current = false
    }
  }, [loadRaw])
  // 日志筛选（v3.307）：run.log 尾部最多 1 MiB，排障时先按级别收窄；纯客户端过滤，
  // 不发新请求。默认「异常」已排除控制台生命周期行（旧口径 123 条异常里 119 条是它）。
  const [mode, setMode] = useState(initialMode)
  const [q, setQ] = useState(initialQuery)
  useEffect(() => { setMode(initialMode); setQ(initialQuery) }, [initialMode, initialQuery])
  useEffect(() => {
    load().catch(() => {})
    // 页面在后台时不轮询（切回前台立即补一次）：控制台常驻标签页也不该整夜每 5s 读盘。
    // 即使 pollMs=0（空闲时不自动轮询），也要挂 visibilitychange——后台期间跑完的任务
    // 会在切回时补一次，不会停留在旧快照。
    let t = null
    if (pollMs) {
      const tick = () => { if (document.visibilityState !== 'hidden') load().catch(() => {}) }
      t = setInterval(tick, pollMs)
    }
    const onVis = () => { if (document.visibilityState === 'visible') load().catch(() => {}) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      if (t !== null) clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load, pollMs])
  const rawText = data && data.status === 'ok' && typeof data.text === 'string' ? data.text : ''
  // 1 MiB 文本的 split/lowercase 只在输入变化时做一次（审查 #248 可选：此前每次渲染
  // 3 次全量 split + 2 次 lowercase，手机输入关键字会掉帧）。
  const lines = useMemo(() => filterLogLines(rawText, 'all', ''), [rawText])
  const counts = useMemo(() => logLineCounts(rawText), [rawText])
  const kw = q.trim().toLowerCase()
  const filtered = useMemo(() => filterLogLines(rawText, mode, q), [rawText, mode, q])
  const shownText = useMemo(() => filtered.join('\n'), [filtered])
  const LOG_MODES = [
    ['all', '全部', counts.all],
    ['issue', '异常', counts.issue],
    ['error', '错误', counts.error],
    ['alert', '告警', counts.alert],
    ['summary', '摘要', counts.summary],
    ['console', '控制台', counts.console]
  ]
  // 首屏与「原本就在底部」时跟随最新日志；用户上翻查看历史时不抢滚动位置。
  // 手动「刷新」与日志从不可读恢复时强制回到底部，避免「刷新后仍停在旧位置」。
  useEffect(() => {
    const el = preRef.current
    if (!el || !data) return
    if (data.status !== 'ok') { stickRef.current = true; prevTextRef.current = ''; return }
    if (stickRef.current || prevTextRef.current === '') el.scrollTop = el.scrollHeight
    prevTextRef.current = shownText
  }, [data, mode, q, shownText])
  const onLogScroll = () => {
    const el = preRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  const refreshNow = () => {
    stickRef.current = true
    load(true).catch(() => {})
  }
  const pickMode = (next) => {
    stickRef.current = true
    setMode(next)
  }
  return html`<div class="panel">
    <${PanelHead} title="运行日志" sub=${'run.log 尾部 1 MiB' + (pollMs ? ' · 任务运行中，实时跟随' : '')}
      right=${html`<${Button} variant="ghost" onClick=${refreshNow}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && data.status !== 'ok' && html`<div class="empty">日志${data.status === 'missing' ? '尚未生成' : `不可读（${data.status}）`}</div>`}
    ${data && data.status === 'ok' && html`<div>
      <div class="log-tools">
        <div class="log-chips" role="group" aria-label="日志筛选">
          ${LOG_MODES.map(([key, label, n]) => html`
            <button type="button" key=${key} class=${'log-chip' + (mode === key ? ' on' : '')}
              aria-pressed=${mode === key ? 'true' : 'false'} onClick=${() => pickMode(key)}>${label} ${n}</button>`)}
        </div>
        <input class="msg-search log-search" type="search" placeholder="搜索日志…" aria-label="搜索日志"
          value=${q} onInput=${(e) => { stickRef.current = true; setQ(e.target.value) }} />
      </div>
      <div class="log-count">${mode !== 'all' || kw !== '' ? `显示 ${filtered.length} / ${lines.length} 行` : `共 ${lines.length} 行`}${mode === 'issue' || mode === 'error' ? ' · 已排除控制台停止记录' : ''}</div>
      <pre class="logpre" ref=${preRef} onScroll=${onLogScroll}>${filtered.length > 0 ? shownText : (lines.length === 0 ? '（空）' : '（没有匹配的日志行）')}</pre>
    </div>`}
  </div>`
}

// 系统信息：版本 / 运行环境 / 进程 / 缓存目录。全部只读，无操作按钮。
function SysPanel () {
  // 访问日志（v3.300 §3.3）：第二个 loader 并列拉取；「刷新」按钮同日 load 两个。
  // 近窗未授权尝试数 = 服务端独立 401 计数（进程启动以来、不随环形窗截断）。
  // 两个请求可能一成一败：本页不认「数据截至」，避免半套数据被标成完整刷新（Sourcery PR#253）。
  const { data: sys, err, load } = usePanelLoader(apiGetSys)
  const { data: access, err: accessErr, load: loadAccess } = usePanelLoader(apiGetAccessLog)
  useEffect(() => { load().catch(() => {}) }, [load])
  useEffect(() => { loadAccess().catch(() => {}) }, [loadAccess])
  const refreshAll = () => { load(); loadAccess() }
  const fmtUptime = (s) => {
    if (!(typeof s === 'number' && s >= 0)) return '—'
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d} 天 ${h} 时 ${m} 分` : h > 0 ? `${h} 时 ${m} 分` : `${m} 分`
  }
  const logItems = access && Array.isArray(access.items) ? access.items : []
  const logTail = logItems.slice(-20).reverse()
  return html`<div class="panel">
    <${PanelHead} title="系统信息" right=${html`<${Button} variant="ghost" onClick=${refreshAll}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${sys && html`<div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>脚本版本</td><td>v${sys.version || '?'}</td></tr>
        <tr><td>Node.js</td><td>${sys.node}</td></tr>
        <tr><td>平台</td><td>${sys.platform}</td></tr>
      </tbody></table>
      <table class="sys-table"><tbody>
        <tr><td>控制台已运行</td><td>${fmtUptime(sys.uptimeS)}</td></tr>
        <tr><td>内存占用</td><td>${fmtBytes(sys.rssBytes)}</td></tr>
        <tr><td>进程 PID</td><td>${sys.pid}</td></tr>
        <tr><td>缓存目录</td><td>${sys.cacheDir}</td></tr>
      </tbody></table>
    </div>`}
    <${Hint} style="margin-top:12px">近窗未授权尝试（401）：${access && Number.isSafeInteger(access.unauthorizedCount) ? access.unauthorizedCount : '—'} 次（服务启动以来累计；下方环形日志最多 200 条、重启即清空、不写盘；路径中 token 已由服务端脱敏）。<//>
    ${accessErr && html`<${Hint} tone="error">访问日志加载失败：${accessErr.message || accessErr}<//>`}
    ${access && access.items && access.items.length === 0 && html`<div class="empty">暂无访问记录（轮询端点与静态资产的成功请求不记入）</div>`}
    ${logTail.length > 0 && html`<details class="access-log"><summary>最近访问记录（最多 20 条，新在上）</summary>
      <table class="sys-table"><tbody>
        ${logTail.map((it, i) => html`<tr key=${`${i}|${it.at}|${it.method}|${it.path}|${it.status}|${it.ms}`}><td>${it.at}</td><td>${it.method} ${it.path} → ${it.status} · ${it.ms}ms</td></tr>`)}
      </tbody></table>
    </details>`}
    <${Hint} style="margin-top:12px">数据说明：推送记录来自判重缓存 push.json（服务端已裁剪正文 HTML）；趋势解析 run.log 摘要行；日志取尾部 1 MiB。<//>
  </div>`
}

// 状态目录文件清单（v3.298）：进系统页加载 + 手动刷新。符号链接/目录作为异常条目显性
// 展示（bytes 为 ——— 意为「不适用」，服务端不跟随符号链接、不泄露目标元数据）。
function FilesPanel () {
  const { data, err, load } = usePanelLoader(apiGetFiles)
  useEffect(() => { load().catch(() => {}) }, [load])
  const files = data && Array.isArray(data.files) ? data.files : []
  return html`<div class="panel">
    <${PanelHead} title="缓存目录文件"
      sub=${data ? `${data.total} 项${data.truncated ? '（超出展示上限，已截断）' : ''}` : ''}
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && data.status !== 'ok' && html`<div class="empty">${data.status === 'missing' ? '目录尚未生成' : `不可读（${data.status}）`}</div>`}
    ${data && data.status === 'ok' && html`<table class="sys-table"><tbody>
      ${files.map((f) => html`<tr key=${f.name}>
        <td>${f.name}</td>
        <td>${f.kind === 'file' ? `${fmtBytes(f.bytes)} · ${f.type}` : f.kind === 'symlink' ? '⚠️ 符号链接（异常，请排查）' : f.kind}</td>
      </tr>`)}
    </tbody></table>`}
    <${Hint} style="margin-top:10px">文件类型：cache=判重缓存 · tombstone=墓碑 · log/state=日志与状态 · lock=锁帧 · backup/temp=异常残留备份。出现 symlink/dir 即目录被异常写入，值得人工排查。<//>
  </div>`
}

// 过滤规则：按「一行一条」渲染，空规则默认折叠。
// 旧版把 11 条键值对拼成一行（k=v · k=v…），手机端只能从单词中间硬断，挤成一团；
// 规则再多页面会成一条无限长的“毛线”。这里每条独立成行，空值默认隐藏。
function FilterRules ({ entries }) {
  const [showEmpty, setShowEmpty] = useState(false)
  const isEmpty = (v) => v === undefined || v === null || String(v).length === 0
  const emptyCount = entries.filter(([, v]) => isEmpty(v)).length
  const shown = showEmpty ? entries : entries.filter(([, v]) => !isEmpty(v))
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">过滤规则</span>
      <span class="cfg-block-sub">${entries.length} 项${emptyCount > 0 ? ` · ${emptyCount} 项为空` : ''}</span>
    </div>
    ${shown.length === 0
      ? html`<div class="empty">暂无已设置的过滤规则${emptyCount > 0 ? `（${emptyCount} 项为空）` : ''}</div>`
      : html`<div class="rule-list">
        ${shown.map(([k, v]) => html`<div class="rule-row" key=${k}>
          <code class="rule-key">${k}</code>
          <span class=${'rule-val' + (isEmpty(v) ? ' rule-empty' : '')}>${isEmpty(v) ? '（空）' : String(v)}</span>
        </div>`)}
      </div>`}
    ${emptyCount > 0 && html`<button type="button" class="cfg-toggle" aria-expanded=${showEmpty} onClick=${() => setShowEmpty(!showEmpty)}>
      ${showEmpty ? '▾ 收起空规则' : `▸ 显示 ${emptyCount} 个空规则`}
    </button>`}
  </div>`
}

function ChannelList ({ pc }) {
  const raw = pc && pc.perChannel
  const map = raw && !Array.isArray(raw) ? raw : {}
  const legacy = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  const names = Object.keys(map).length > 0 ? Object.keys(map) : (Array.isArray(pc.names) ? pc.names : legacy)
  const isOn = (k) => Object.prototype.hasOwnProperty.call(map, k)
    ? !!map[k]
    : (Array.isArray(pc.names) && pc.names.includes(k)) || legacy.includes(k)
  const on = names.filter(isOn)
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">推送渠道</span>
      <span class="cfg-block-sub">已配置 ${on.length} / ${names.length} · 绿色为已配置</span>
    </div>
    ${!pc.moduleLoaded
      ? html`<div class="empty">配置模块加载失败（检查依赖）</div>`
      : names.length === 0
        ? html`<div class="empty">未配置任何渠道</div>`
        : html`<div class="chan-grid">
          ${names.map((k) => html`<span key=${k} class=${'chan-chip' + (isOn(k) ? ' on' : '')}
            role="img" aria-label=${`${channelLabel(k)}：${isOn(k) ? '已配置' : '未配置'}`}>
            <span class="chan-dot" aria-hidden="true"></span>${channelLabel(k)}
          </span>`)}
        </div>`}
  </div>`
}

// 运行配置脱敏视图（v3.298）：推送密钥只显示「已配置/未配置」，值永不下发（服务端白名单
// + 响应前保险丝双道防线）。进配置页加载 + 手动刷新。
function ConfigPanel ({ onSync }) {
  const { data, err, load } = usePanelLoader(apiGetConfig, onSync)
  useEffect(() => { load().catch(() => {}) }, [load])
  const r = data && data.runtime ? data.runtime : null
  const pc = data && data.pushChannels ? data.pushChannels : null
  const filterEntries = r && r.filter ? Object.entries(r.filter) : []
  return html`<div class="panel">
    <${PanelHead} title="运行配置" sub="脱敏视图 · 推送密钥只显示是否已配置"
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && !r && html`<div class="empty">运行配置不可读（模块加载失败——检查部署完整性）</div>`}
    ${r && html`<div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>站点域名</td><td>${r.domain}</td></tr>
        <tr><td>推送接口</td><td>${r.api.pushUrl}</td></tr>
        <tr><td>接口超时 / 重试</td><td>${r.api.timeout}ms / ${r.api.retry} 次</td></tr>
        <tr><td>推送模式</td><td>${r.push.mode}${r.push.mode === 'parallel' ? ` · 并发上限 ${r.push.parallelLimit}` : ''}</td></tr>
        <tr><td>单轮上限 / 截断</td><td>${r.push.maxPerRun} 条 · 标题 ${r.push.titleMax} / 正文 ${r.push.contentMax} 字符</td></tr>
        <tr><td>缓存上限</td><td>${r.cache.maxSize} 条 · 目录 ${r.cache.dirEffective || r.cache.dirConfigured || '—'}</td></tr>
      </tbody></table>
      <table class="sys-table"><tbody>
        <tr><td>接口异常告警</td><td>${r.alert.enabled ? `开（同错误限频 ${Math.round(r.alert.intervalMs / 60000)} 分钟）` : '关'}</td></tr>
        <tr><td>运行日报</td><td>${r.report.enabled ? '开' : '关'}</td></tr>
        <tr><td>通道健康监测</td><td>${r.channelHealth.enabled ? `开（连续失败 ${r.channelHealth.consecutiveFailures} 次告警）` : '关'}</td></tr>
        <tr><td>过滤诊断日志</td><td>${r.diagnostics.filterLog.enabled ? `开（每轮最多 ${r.diagnostics.filterLog.maxDetailsPerRun} 条）` : '关'}</td></tr>
        <tr><td>磁盘余量告警</td><td>${r.storage.minFreeBytes >= 0 ? `低于 ${fmtBytes(r.storage.minFreeBytes)} 时告警` : '—'}</td></tr>
        <tr><td>运行环境变量</td><td>${data.console && data.console.env ? [['intervalMs', 'XBK_INTERVAL_MS'], ['cacheDir', 'XBK_CACHE_DIR'], ['dryRun', 'XBK_DRY_RUN']].filter(([k]) => data.console.env[k]).map(([, label]) => `${label} 已设置`).join('，') || '无覆盖' : '—'}</td></tr>
      </tbody></table>
    </div>`}
    ${r && html`<div class="cfg-block">
      <div class="cfg-block-head"><span class="cfg-block-title">推送模板</span></div>
      <div class="tpl-row"><span>标题</span><code>${r.template.title}</code></div>
      <div class="tpl-row"><span>正文</span><code>${r.template.content}</code></div>
    </div>`}
    ${r && filterEntries.length > 0 && html`<${FilterRules} entries=${filterEntries} />`}
    ${r && html`<div class="cfg-block">
      <div class="cfg-block-head"><span class="cfg-block-title">关键词订阅</span></div>
      <div class="cfg-text">${r.keyword.zkt_gjc && String(r.keyword.zkt_gjc).length > 0 ? r.keyword.zkt_gjc : '（未设置）'}</div>
    </div>`}
    ${pc && html`<${ChannelList} pc=${pc} />`}
    ${pc && html`<div class="cfg-block">
      <div class="cfg-block-head"><span class="cfg-block-title">本地配置文件</span></div>
      <div class="cfg-text">${pc.localFilePresent ? 'push_config.local.js 存在（sendNotify 启动时加载；格式异常会在运行日志告警。密钥不入库不入页面）' : '未找到（用环境变量或该文件配置推送）'}</div>
    </div>`}
    <${Hint} style="margin-top:12px">本页为脱敏视图：所有推送密钥（appToken / BOT token 等）的值永不出现在页面或接口响应中，只显示「已配置 / 未配置」。修改配置请编辑 push_config.local.js 或环境变量后重启。<//>
  </div>`
}

// ── 过滤规则（v3.310）：覆盖文件编辑面 ─────────────────────────────────────
// 语义红线（规格 §2.8/§3）：zhanxian* 是「保护」——命中即保留、优先于屏蔽，绝不写成
// 「展示 / 只看」；pingbitime 是「屏蔽注册不足 N 天的楼主」，不是「只看最近 N 天」。
// 分组顺序 = 运行侧判定顺序：时间 → 分类 → 楼主 → 标题 → 内容。
const FILTER_GROUPS = [
  {
    key: 'time',
    title: '时间',
    note: '第 1 步 · 先按楼主注册天数判定',
    fields: [
      {
        name: 'pingbitime',
        label: '屏蔽注册不足 N 天的楼主',
        kind: 'days',
        hint: '填天数（整数）。留空 = 不启用；支持「分类###天数」多行写法。'
      }
    ]
  },
  {
    key: 'category',
    title: '分类',
    note: '第 2 步 · 分类名命中即屏蔽',
    fields: [
      { name: 'pingbifenlei', label: '屏蔽分类', hint: '分类名正则（如 美妆|数码），不支持 ### 多行语法。' }
    ]
  },
  {
    key: 'author',
    title: '楼主',
    note: '第 3 步 · 保护优先于屏蔽，强化屏蔽可抵消同字段保护',
    fields: [
      { name: 'pingbilouzhu', label: '屏蔽楼主', hint: '一行一条；支持「分类###关键词」。命中即过滤。' },
      { name: 'zhanxianlouzhu', label: '保护楼主', protect: true, hint: '保护（命中即保留，优先于屏蔽）。' },
      { name: 'pingbilouzhuplus', label: '强化屏蔽楼主', hint: '强化屏蔽：命中即过滤，并可抵消同字段的保护。' }
    ]
  },
  {
    key: 'title',
    title: '标题',
    note: '第 4 步 · 楼主已屏蔽时不再看标题',
    fields: [
      { name: 'pingbibiaoti', label: '屏蔽标题', hint: '一行一条；支持「分类###关键词」。命中即过滤。' },
      { name: 'zhanxianbiaoti', label: '保护标题', protect: true, hint: '保护（命中即保留，优先于屏蔽）。' },
      { name: 'pingbibiaotiplus', label: '强化屏蔽标题', hint: '强化屏蔽：命中即过滤，并可抵消同字段的保护。' }
    ]
  },
  {
    key: 'content',
    title: '内容',
    note: '第 5 步 · 楼主/标题已屏蔽时不再看内容',
    fields: [
      { name: 'pingbineirong', label: '屏蔽内容', hint: '一行一条；支持「分类###关键词」。命中即过滤。' },
      { name: 'zhanxianneirong', label: '保护内容', protect: true, hint: '保护（命中即保留，优先于屏蔽）。' },
      { name: 'pingbineirongplus', label: '强化屏蔽内容', hint: '强化屏蔽：命中即过滤，并可抵消同字段的保护。' }
    ]
  }
]

const FILTER_FIELD_NAMES = FILTER_GROUPS.reduce((acc, g) => acc.concat(g.fields.map((f) => f.name)), [])

// 全命中判定与服务端 wideMatchFields 同口径：trim 后等于 .* 或 ^.*$。
const FILTER_WIDE_PATTERNS = ['.*', '^.*$']

function isWideMatchValue (v) {
  const s = v === undefined || v === null ? '' : String(v).trim()
  return FILTER_WIDE_PATTERNS.includes(s)
}

function wideFieldsOf (filter) {
  const src = filter && typeof filter === 'object' ? filter : {}
  return FILTER_FIELD_NAMES.filter((name) => isWideMatchValue(src[name]))
}

// GET 返回的 filter 只含 11 个服务端字段；缺字段按空串（不把 undefined 塞进 textarea）。
function filterDraftFrom (data) {
  const src = data && data.filter && typeof data.filter === 'object' ? data.filter : {}
  const out = {}
  for (const name of FILTER_FIELD_NAMES) {
    out[name] = src[name] === undefined || src[name] === null ? '' : String(src[name])
  }
  return out
}

// 服务端 errors 是 [{field, code, message}]；body/baseRevision 这类非字段错误汇总在顶部 Hint。
function fieldErrorMap (errors) {
  const map = {}
  if (!Array.isArray(errors)) return map
  for (const item of errors) {
    if (item && typeof item.field === 'string' && FILTER_FIELD_NAMES.includes(item.field)) {
      map[item.field] = item.message || item.code || '校验失败'
    }
  }
  return map
}

// 补推口径（规格 §4.4）：最多扫 5000 条 _f 记录，超过显示「≥5000」。
// 缓存读不到时服务端回 available:false（scanned/reEvalCount 为 null）——此时显示「未知」，
// 不能把 null 格式化成 0 条（那等于把「读不到」说成「没有影响」）。
function reEvalText (preview) {
  if (preview && preview.available === false) return '无法读取推送历史，本次不显示补推估算'
  const n = preview && preview.capped === true ? '≥5000' : fmtNum(preview ? preview.reEvalCount : null)
  return `将重评 ${n} 条历史被过滤记录，后续每轮最多补推 Config.push.maxPerRun（默认 100）条。`
}

// 备份下拉：/api/files 的清单里筛 filter-rules.bak.<rev>.json（最多 3 代）。
// 清单不可读时退化为「最近 3 代候选」——缺失的 revision 由服务端 404 backup_not_found 如实提示。
function backupRevisionsOf (files, revision) {
  const list = files && Array.isArray(files.files) ? files.files : null
  if (!list) {
    const out = []
    for (let r = revision - 1; r >= 1 && out.length < 3; r--) out.push(r)
    return out
  }
  return list
    .map((f) => /^filter-rules\.bak\.(\d+)\.json$/.exec(f && typeof f.name === 'string' ? f.name : ''))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((r) => Number.isSafeInteger(r) && r >= 0 && r < revision)
    .sort((a, b) => b - a)
    .slice(0, 3)
}

// 单个规则字段：label/for 绑定、当前值、脏标记、逐字段错误。
function FilterField ({ def, value, saved, error, onChange }) {
  const id = `filter-rule-${def.name}`
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  const shown = value === undefined || value === null ? '' : String(value)
  const prev = saved === undefined || saved === null ? '' : String(saved)
  const dirty = shown !== prev
  const describedBy = error ? `${hintId} ${errId}` : hintId
  return html`<div class=${'fr-field' + (def.protect ? ' fr-field-protect' : '')}>
    <div class="fr-field-head">
      <label class="fr-label" for=${id}>${def.label}</label>
      ${def.protect && html`<span class="fr-protect">保护（命中即保留，优先于屏蔽）</span>`}
      ${dirty && html`<span class="fr-dirty">未保存</span>`}
      <code class="fr-key">${def.name}</code>
    </div>
    ${def.kind === 'days'
      ? html`<input id=${id} class="fr-input fr-input-days" type="text" inputmode="numeric" autocomplete="off"
          value=${shown} aria-describedby=${describedBy} aria-invalid=${error ? 'true' : 'false'}
          onInput=${(e) => onChange(def.name, e.target.value)} />`
      : html`<textarea id=${id} class="fr-input fr-textarea" rows="2" spellcheck="false"
          value=${shown} aria-describedby=${describedBy} aria-invalid=${error ? 'true' : 'false'}
          onInput=${(e) => onChange(def.name, e.target.value)}></textarea>`}
    <div class="fr-field-hint" id=${hintId}>${def.hint}</div>
    ${error && html`<div class="fr-field-err" id=${errId} role="alert">${error}</div>`}
  </div>`
}

function FilterRulesPanel ({ onSync }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [base, setBase] = useState(null)
  const [backups, setBackups] = useState([])
  const [backupListKnown, setBackupListKnown] = useState(false)
  const [restoreTo, setRestoreTo] = useState('default')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('') // '' | validate | preview | save | copy | restore
  const [err, setErr] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [preview, setPreview] = useState(null)
  const [dialog, setDialog] = useState(null)

  const applyLoaded = useCallback((d, files) => {
    const revision = d && Number.isSafeInteger(d.revision) ? d.revision : 0
    const next = filterDraftFrom(d)
    const list = backupRevisionsOf(files, revision)
    setData(d)
    setDraft(next)
    setBase(next)
    setPreview(null)
    setFieldErrors({})
    setBackups(list)
    setBackupListKnown(!!(files && Array.isArray(files.files)))
    setRestoreTo(list.length > 0 ? String(list[0]) : 'default')
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      // 备份清单与规则读取并行：/api/files 只是下拉数据，读不到不阻断规则编辑。
      const [d, files] = await Promise.all([apiGetFilter(), apiGetFiles().catch(() => null)])
      applyLoaded(d, files)
      if (typeof onSync === 'function') onSync(Date.now())
    } catch (e) {
      setErr(`加载失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [applyLoaded, onSync])

  useEffect(() => { load().catch(() => {}) }, [load])

  const dirtyFields = useMemo(() => {
    if (!draft || !base) return []
    return FILTER_FIELD_NAMES.filter((n) => String(draft[n]) !== String(base[n]))
  }, [draft, base])
  const draftWide = useMemo(() => wideFieldsOf(draft), [draft])

  const setFieldValue = useCallback((name, value) => {
    setDraft((cur) => (cur ? { ...cur, [name]: value } : cur))
    setFieldErrors((cur) => {
      if (!cur[name]) return cur
      const next = { ...cur }
      delete next[name]
      return next
    })
  }, [])

  const applySaved = useCallback((filter, revision, copy) => {
    const rev = Number.isSafeInteger(revision) ? revision : null
    const next = filterDraftFrom({ filter })
    setData((cur) => (cur
      ? { ...cur, revision: rev === null ? cur.revision : rev, source: 'override', filter: { ...filter }, wideMatch: wideFieldsOf(filter) }
      : cur))
    setDraft(next)
    setBase(next)
    setFieldErrors({})
    setPreview(null)
    setDialog(null)
    setNotice({ tone: 'ok', text: `${copy ? '已把当前规则复制到覆盖文件' : '已保存'}${rev === null ? '' : ` r${rev}`}，下一轮生效（当前轮不换规则）。` })
  }, [])

  // 备份清单单独刷新：保存会新增一代备份，下拉必须跟着更新（不重读规则，避免覆盖草稿）。
  const refreshBackups = useCallback(async (revision) => {
    try {
      const files = await apiGetFiles()
      const list = backupRevisionsOf(files, revision)
      setBackups(list)
      setBackupListKnown(!!(files && Array.isArray(files.files)))
      setRestoreTo((cur) => (cur !== 'default' && list.includes(Number(cur))
        ? cur
        : (list.length > 0 ? String(list[0]) : 'default')))
    } catch (e) { /* 清单读取失败：保留旧下拉，不阻断保存结果 */ }
  }, [])

  // 错误体 → 统一文案 + 逐字段错误。返回值供调用方决定是否开二次确认弹窗。
  const showFailure = useCallback((res, fallback) => {
    const payload = res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {}
    const code = typeof payload.code === 'string' ? payload.code : ''
    const errors = Array.isArray(payload.errors) ? payload.errors : []
    const fail = (text) => {
      setNotice(null) // 失败时清掉上一条成功提示，避免「已保存」与错误同屏
      setFieldErrors(fieldErrorMap(errors))
      setErr(text)
    }
    if (res.status === 401) { fail('凭证已失效（401），写操作被拒绝；请用带 token 的完整链接重新打开控制台。'); return 'unauthorized' }
    if (code === 'engine_unavailable' || res.status === 503) { fail('安全正则引擎（re2）暂不可用，本次不落盘；请检查部署后重试。'); return 'engine_unavailable' }
    if (code === 'body_too_large' || res.status === 413) { fail('规则内容超过 64 KiB 上限，请精简后再保存。'); return 'body_too_large' }
    if (code === 'unsupported_media_type' || res.status === 415) { fail('请求格式不被接受（写端点要求 application/json）。'); return 'unsupported_media_type' }
    if (code === 'write_busy') { fail(`另一个写入正在进行，请 1 秒后重试（Retry-After: ${res.retryAfter || '1'}）。`); return 'write_busy' }
    if (code === 'store_corrupt') { fail('覆盖文件已损坏：保存需要确认覆盖（确认后损坏内容不可回滚）。'); return 'store_corrupt' }
    if (code === 'revision_mismatch') {
      const cur = Number.isSafeInteger(payload.revision) ? payload.revision : null
      setFieldErrors({})
      setErr(`保存冲突：${cur === null ? '服务端 revision 已变化' : `服务端当前为 r${cur}`}，你基于 r${data ? data.revision : '?'}。请先「重新加载」合并后再保存。`)
      return 'revision_mismatch'
    }
    if (code === 'backup_not_found' || res.status === 404) { fail('备份不存在（backup_not_found），可能已被清理；请重新加载备份列表。'); return 'backup_not_found' }
    if (code === 'validation_failed' || res.status === 400) {
      const lines = errors.map((x) => `${x && x.field ? x.field : ''}${x && x.message ? `：${x.message}` : ''}`).filter(Boolean)
      fail(lines.length > 0 ? `${fallback}：${lines.join('；')}` : `${fallback}：规则未通过校验`)
      return 'validation_failed'
    }
    fail(`${fallback}：${payload.error || payload.code || `HTTP ${res.status}`}`)
    return code || `http_${res.status}`
  }, [data])

  // 保存前两次预检：/validate（逐字段语法）→ /preview（补推条数），再开二次确认弹窗。
  const beginSave = async () => {
    if (!data || !draft || busy) return
    setErr('')
    setFieldErrors({})
    setNotice(null)
    // 只提交用户真正改过的字段：把没动过的「当前生效值」也整份写进覆盖文件，等于把
    // 代码默认永久钉死——后续版本改默认时这台实例收不到（评审 Medium）。
    // 缺字段的语义本来就是「回代码默认」，所以省略未改字段不改变本次保存的结果。
    const candidate = {}
    for (const name of dirtyFields) candidate[name] = draft[name]
    setBusy('validate')
    try {
      // confirmWideMatch:true 只关掉服务端的「宽匹配需确认」闸；真正的二次确认由本页弹窗
      // 负责（用户必须在弹窗里看到 .* 字段与补推条数后才会发出保存）。
      const checked = await apiPostFilterValidate({ schema: 1, filter: candidate, confirmWideMatch: true })
      if (!checked.ok) { showFailure(checked, '校验未通过'); return }
      setBusy('preview')
      const pv = await apiPostFilterPreview({ schema: 1, filter: candidate, confirmWideMatch: true })
      if (!pv.ok) { showFailure(pv, '补推预览失败'); return }
      setPreview(pv.data)
      setDialog({ kind: 'save', filter: candidate, baseRevision: data.revision, preview: pv.data, wide: wideFieldsOf(candidate) })
    } catch (e) {
      setErr(`保存前检查失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  const runPreview = async () => {
    if (!draft || busy) return
    setErr('')
    setFieldErrors({})
    setNotice(null)
    setBusy('preview')
    try {
      const res = await apiPostFilterPreview({ schema: 1, filter: { ...draft }, confirmWideMatch: true })
      if (!res.ok) { showFailure(res, '预览失败'); return }
      setPreview(res.data)
    } catch (e) {
      setErr(`预览失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  const submitSave = async ({ filter, baseRevision, confirmWideMatch, confirmReplaceCorrupt, copy }) => {
    setBusy('save')
    setErr('')
    try {
      const res = await apiPostFilterSave({
        schema: 1,
        baseRevision,
        filter,
        confirmWideMatch: confirmWideMatch === true,
        confirmReplaceCorrupt: confirmReplaceCorrupt === true
      })
      if (res.ok) {
        const payload = res.data && typeof res.data === 'object' ? res.data : {}
        applySaved(filter, payload.revision, copy === true)
        refreshBackups(Number.isSafeInteger(payload.revision) ? payload.revision : data.revision)
        return
      }
      const code = showFailure(res, copy ? '复制默认规则失败' : '保存失败')
      const errors = res.data && Array.isArray(res.data.errors) ? res.data.errors : []
      if (code === 'store_corrupt') {
        setDialog({ kind: 'corrupt', filter, baseRevision, confirmWideMatch })
        return
      }
      if (code === 'validation_failed' && errors.some((x) => x && x.code === 'wide_match_confirm_required')) {
        setDialog({ kind: 'copyWide', filter })
        return
      }
      // 其余失败（revision_mismatch / write_busy / validation_failed / 503…）关掉确认弹窗，
      // 让顶部错误文案可见；草稿与 baseRevision 保留，用户可重新加载后再存。
      setDialog(null)
    } catch (e) {
      setErr(`保存请求失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  // 首启：把 GET 到的代码默认整份写进覆盖文件（baseRevision:0）。不自动写，必须点按钮。
  const copyDefaults = async () => {
    if (!data || !base || busy) return
    setDialog(null)
    setBusy('copy')
    setErr('')
    setFieldErrors({})
    setNotice(null)
    try {
      const res = await apiPostFilterSave({ schema: 1, baseRevision: 0, filter: { ...base } })
      if (res.ok) {
        const payload = res.data && typeof res.data === 'object' ? res.data : {}
        applySaved(base, payload.revision, true)
        refreshBackups(Number.isSafeInteger(payload.revision) ? payload.revision : data.revision)
        return
      }
      const code = showFailure(res, '复制默认规则失败')
      const errors = res.data && Array.isArray(res.data.errors) ? res.data.errors : []
      if (code === 'validation_failed' && errors.some((x) => x && x.code === 'wide_match_confirm_required')) {
        setDialog({ kind: 'copyWide', filter: { ...base } })
        setNotice({ tone: 'warn', text: '代码默认里含 .* 全命中字段，复制前需要二次确认。' })
      }
    } catch (e) {
      setErr(`复制失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  const doRestore = async (to, baseRevision) => {
    setBusy('restore')
    setErr('')
    try {
      const res = await apiPostFilterRestore({
        to: to === 'default' ? 'default' : Number(to),
        confirm: true,
        baseRevision
      })
      if (!res.ok) {
        const code = showFailure(res, '回滚失败')
        setDialog(null)
        // 陈旧页面（baseRevision 与服务端不一致）：自动重新加载，让用户在新版本上重试。
        if (code === 'revision_mismatch') { try { await load() } catch (e) { /* 顶部错误已提示 */ } }
        return
      }
      const payload = res.data && typeof res.data === 'object' ? res.data : {}
      const revText = Number.isSafeInteger(payload.revision) ? ` r${payload.revision}` : ''
      setDialog(null)
      setFieldErrors({})
      setNotice({
        tone: 'ok',
        text: to === 'default'
          ? `已恢复代码默认（写入空覆盖文件 filter:{}，revision${revText || ' 已递增'}），下一轮生效。`
          : `已回滚到备份 r${to}，写入新 revision${revText}，下一轮生效。`
      })
      // 回滚/恢复默认成功后重新 GET：来源/生效状态/备份列表都以服务端为准。
      await load()
    } catch (e) {
      setDialog(null)
      setErr(`回滚请求失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  const askReload = () => {
    if (busy) return
    if (dirtyFields.length > 0) {
      setDialog({ kind: 'reload' })
      return
    }
    load().catch(() => {})
  }

  const closeDialog = () => {
    if (busy) return
    setDialog(null)
  }

  const dialogNode = () => {
    if (!dialog) return null
    if (dialog.kind === 'save') {
      return html`<${ConfirmDialog} open=${true} title="确认保存过滤规则"
        confirmLabel=${busy === 'save' ? '保存中…' : '确认保存'} busy=${busy === 'save'}
        onCancel=${closeDialog}
        onConfirm=${() => submitSave({ filter: dialog.filter, baseRevision: dialog.baseRevision, confirmWideMatch: dialog.wide.length > 0 })}>
        <div class="fr-dialog-line">${reEvalText(dialog.preview)}</div>
        ${dialog.wide.length > 0 && html`<div class="fr-wide-warn" role="alert">
          含 .* 全命中规则：${dialog.wide.join('、')}。保存后几乎所有记录都会被命中，因此需要二次确认（confirmWideMatch:true）。
        </div>`}
        <div class="modal-note">保存后写入覆盖文件，<strong>下一轮生效</strong>；当前正在跑的一轮不换规则。</div>
      <//>`
    }
    if (dialog.kind === 'corrupt') {
      return html`<${ConfirmDialog} open=${true} title="覆盖已损坏的规则文件？"
        confirmLabel=${busy === 'save' ? '覆盖中…' : '确认覆盖'} busy=${busy === 'save'}
        onCancel=${closeDialog}
        onConfirm=${() => submitSave({ filter: dialog.filter, baseRevision: dialog.baseRevision, confirmWideMatch: dialog.confirmWideMatch, confirmReplaceCorrupt: true })}>
        <div class="fr-dialog-line">覆盖文件已损坏，不能作为可回滚版本。确认后用当前编辑内容重建覆盖文件（confirmReplaceCorrupt:true）。</div>
        <div class="modal-note">重建后同样下一轮生效；损坏内容不会被保留。</div>
      <//>`
    }
    if (dialog.kind === 'copyWide') {
      return html`<${ConfirmDialog} open=${true} title="默认规则含 .* 全命中字段"
        confirmLabel=${busy === 'save' ? '复制中…' : '确认复制'} busy=${busy === 'save'}
        onCancel=${closeDialog}
        onConfirm=${() => submitSave({ filter: dialog.filter, baseRevision: 0, confirmWideMatch: true, copy: true })}>
        <div class="fr-dialog-line">以下字段 trim 后是 .* / ^.*$：${wideFieldsOf(dialog.filter).join('、') || '（未知）'}。复制后几乎所有记录都会被命中。</div>
        <div class="modal-note">确认后以 confirmWideMatch:true 写入覆盖文件；同样下一轮生效。</div>
      <//>`
    }
    if (dialog.kind === 'restore') {
      return html`<${ConfirmDialog} open=${true} title="确认回滚过滤规则"
        confirmLabel=${busy === 'restore' ? '回滚中…' : '确认回滚'} busy=${busy === 'restore'}
        onCancel=${closeDialog}
        onConfirm=${() => doRestore(dialog.to, dialog.baseRevision)}>
        <div class="fr-dialog-line">${dialog.to === 'default'
          ? '写入空覆盖文件（filter:{}、revision+1）恢复代码默认，不删除文件——revision 与备份列表保持连续。'
          : `用备份 r${dialog.to} 的内容写入新 revision（revision 只增不减，线性历史）。`}</div>
        <div class="modal-note">回滚前会先备份当前配置（r${dialog.baseRevision}）；同样下一轮生效，当前正在跑的一轮不换规则。</div>
      <//>`
    }
    if (dialog.kind === 'reload') {
      return html`<${ConfirmDialog} open=${true} title="放弃未保存的修改？"
        confirmLabel="放弃并重新加载" busy=${false}
        onCancel=${closeDialog}
        onConfirm=${() => { setDialog(null); load().catch(() => {}) }}>
        <div class="fr-dialog-line">当前有 ${dirtyFields.length} 个字段尚未保存，重新加载会丢弃这些修改。</div>
      <//>`
    }
    return null
  }

  const revision = data && Number.isSafeInteger(data.revision) ? data.revision : 0
  const applied = data && data.applied && typeof data.applied === 'object' ? data.applied : null
  const appliedRev = applied && Number.isSafeInteger(applied.revision) ? applied.revision : null
  const appliedAt = applied && applied.appliedAt ? fmtIsoStamp(applied.appliedAt) : ''
  const pendingNext = appliedRev !== null && revision > appliedRev
  const corrupt = !!(data && data.source === 'corrupt')
  const auditBroken = !!(data && data.auditChain && data.auditChain.ok === false)
  const sourceBadge = !data
    ? null
    : data.source === 'corrupt'
      ? html`<${Badge} tone="bad">覆盖文件损坏（降级）<//>`
      : data.source === 'override'
        ? html`<${Badge} tone="ok">覆盖文件 r${revision}<//>`
        : html`<${Badge} tone="warn">代码默认<//>`

  return html`<div class="panel">
    <${PanelHead} title="过滤规则" sub="覆盖文件编辑 · 保存后在下一轮生效，当前轮不换规则" />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${notice && html`<${Hint}>${notice.text}<//>`}
    ${loading && !data && html`<div class="empty">加载中…</div>`}
    ${!loading && !data && html`<div class="empty">暂无可显示的规则（上方为错误详情）</div>`}
    ${data && html`<div>
      <div class="fr-status">
        <span class="fr-status-item"><span class="fr-status-k">来源</span>${sourceBadge}</span>
        <span class="fr-status-item"><span class="fr-status-k">已生效</span>${appliedRev === null
          ? html`<span class="fr-status-muted">尚未生效</span>`
          : html`<span class="fr-status-v">r${appliedRev}${appliedAt ? ` · ${appliedAt}` : ''}</span>`}</span>
        ${pendingNext && html`<span class="fr-status-item"><${Badge} tone="warn">r${revision} 待下一轮<//></span>`}
        ${dirtyFields.length > 0 && html`<span class="fr-status-item"><${Badge} tone="warn">有未保存修改<//></span>`}
        ${loading && html`<span class="fr-status-muted">刷新中…</span>`}
      </div>

      ${(corrupt || auditBroken) && html`<div class="alert-banner" role="alert">
        <span class="alert-dot" aria-hidden="true"></span>
        <div class="alert-main">
          <strong>${corrupt ? '过滤规则覆盖文件损坏，运行侧已降级' : '过滤规则审计链断链'}</strong>
          <span class="alert-sub">${corrupt
            ? `运行侧优先使用进程内 last-known-good，首次加载即损坏才回退代码默认（不清 _f、不推进过滤 hash）。${data.error && data.error.message ? `原因：${data.error.message}` : ''}`
            : `审计链在${data.auditChain.brokenAt === null || data.auditChain.brokenAt === undefined ? '未知位置' : `第 ${data.auditChain.brokenAt} 条`}断开，可能存在静默删除/篡改（只保证可检测，不声称防 root）。`}
            <br />本轮不换规则、下一轮生效：这里保存的修改从下一轮开始生效，正在跑的一轮继续用已生效规则。</span>
        </div>
      </div>`}

      ${data.source === 'default' && html`<div class="fr-firstrun">
        <div class="fr-firstrun-title">当前使用代码默认</div>
        <div class="fr-firstrun-text">还没有覆盖文件。保存任意修改会自动创建；也可以先把当前代码默认整份复制成第一版，之后的修改都写覆盖文件（不自动写，避免不知情地产生第一版）。</div>
        <${Button} variant="primary" disabled=${!!busy || loading} onClick=${copyDefaults}>把当前规则复制到覆盖文件<//>
      </div>`}

      <div class="fr-form" role="group" aria-label="过滤规则表单">
        ${FILTER_GROUPS.map((g) => html`<fieldset class="fr-group" key=${g.key}>
          <legend class="fr-group-title">${g.title}</legend>
          <div class="fr-group-note">${g.note}</div>
          ${g.fields.map((f) => html`<${FilterField} key=${f.name} def=${f}
            value=${draft ? draft[f.name] : ''} saved=${base ? base[f.name] : ''}
            error=${fieldErrors[f.name] || ''} onChange=${setFieldValue} />`)}
        </fieldset>`)}
      </div>

      <div class="fr-readonly">
        <div class="fr-field-head">
          <span class="fr-label">只看它关键词（v1 不开放写入）</span>
          <code class="fr-key">zkt_gjc</code>
        </div>
        <div class="fr-readonly-val">${data.keyword && data.keyword.zkt_gjc ? String(data.keyword.zkt_gjc) : '（未设置）'}</div>
        <div class="fr-field-hint">值来自代码配置 Config.keyword.zkt_gjc；v1 只读，不接受写入。修改需改代码并重启。</div>
      </div>

      ${preview && html`<div class="fr-preview" aria-live="polite">
        <div class="fr-preview-head">补推影响预览</div>
        <div class="fr-preview-main">${reEvalText(preview)}</div>
        ${preview.available === false
          ? html`<div class="fr-preview-meta">缓存读取 ${preview.cacheStatus || '—'}（${preview.code || 'cache_unavailable'}）</div>`
          : html`<div class="fr-preview-meta">已扫描 ${fmtNum(preview.scanned)} 条历史被过滤记录${preview.capped ? '（被过滤记录超过 5000 条，实际可能更多）' : ''}${preview.zktApplied === true ? ' · 已按 zkt_gjc 白名单排除不匹配标题' : ''} · 缓存读取 ${preview.cacheStatus || '—'}</div>`}
        ${Array.isArray(preview.samples) && preview.samples.length > 0 && html`<ul class="fr-samples">
          ${preview.samples.map((s, i) => html`<li key=${s && s.id !== null && s.id !== undefined ? String(s.id) : `sample-${i}`}>
            <span class="fr-sample-title">${s && s.title ? s.title : '（无标题）'}</span>
            ${s && s.id !== null && s.id !== undefined && html`<span class="fr-sample-id">${String(s.id)}</span>`}
          </li>`)}
        </ul>`}
        <div class="fr-field-hint">预览只在内存试算，不落盘、不推进过滤 hash、不触发推送。</div>
      </div>`}

      <div class="fr-actions">
        <${Button} variant="primary" disabled=${dirtyFields.length === 0 || !!busy || loading} onClick=${beginSave}>
          ${busy === 'validate' ? '校验中…' : busy === 'preview' ? '预览补推中…' : '校验并保存'}<//>
        <${Button} disabled=${!!busy || loading} onClick=${runPreview}>预览最近记录<//>
        <${Button} disabled=${!!busy || loading} onClick=${askReload}>重新加载<//>
        <span class="fr-actions-note">${dirtyFields.length > 0
          ? `${dirtyFields.length} 个字段有未保存修改${draftWide.length > 0 ? `（含 ${draftWide.length} 个 .* 全命中）` : ''}`
          : '没有未保存修改'}</span>
      </div>

      <div class="fr-restore">
        <div class="fr-restore-head">回滚 / 恢复默认</div>
        <div class="fr-restore-row">
          <label class="fr-label" for="filter-restore-to">回滚目标</label>
          <select id="filter-restore-to" class="fr-select" value=${restoreTo} disabled=${!!busy || loading}
            onChange=${(e) => setRestoreTo(e.target.value)}>
            <option value="default">恢复代码默认（写入空覆盖文件）</option>
            ${backups.map((r) => html`<option key=${r} value=${String(r)}>备份 r${r}</option>`)}
          </select>
          <${Button} variant="danger" disabled=${!!busy || loading} onClick=${() => setDialog({ kind: 'restore', to: restoreTo, baseRevision: revision })}>回滚<//>
        </div>
        <div class="fr-field-hint">${backups.length > 0
          ? `可用备份：${backups.map((r) => `r${r}`).join('、')}（保存前备份上一版，最多保留 3 代）`
          : (backupListKnown ? '没有可用备份（每次保存前会备份上一版，最多保留 3 代）' : '文件清单不可读，按最近 3 代候选列出；缺失的备份会在回滚时提示 404')}。回滚写入新 revision（历史不回退），同样下一轮生效。</div>
      </div>
    </div>`}
    ${dialogNode()}
  </div>`
}

function App () {
  const [state, setState] = useState(null)
  const [runs, setRuns] = useState([])
  // 触发历史是否已经成功加载过：首次请求未回/失败时不能显示「暂无触发记录」，
  // 否则会把「还不知道」谎报成「确实没有」（Sourcery #254）。
  const [runsState, setRunsState] = useState('loading') // loading | ok | error
  const [busy, setBusy] = useState(false)
  const [lastSync, setLastSync] = useState(null)
  // 非概览页的「数据截至」必须来自当前页自己的成功加载：共用一个 lastSync 会把
  // 概览/runs 的时间挂到日志页上（Sourcery PR#252）；换页时清空，加载失败就显示手动刷新。
  const [panelSync, setPanelSync] = useState(null)
  const [syncErr, setSyncErr] = useState('')
  // 标签页写 hash（v3.307）：刷新/后退不丢当前页；初始值从 hash 读，非法值回概览。
  // v3.310「过滤规则」新增为第六个页签。pure.mjs 的 tabFromHash 只认 v3.307 的五个键
  // （该模块本批不改），这里补一层本文件内的白名单，保持 hash 路由对新页签同样生效
  // （刷新/后退不丢当前页；非法值仍回概览）。
  const resolveTab = (hash) => (/^#\/filter$/.test(typeof hash === 'string' ? hash : '') ? 'filter' : tabFromHash(hash))
  const [tab, setTab] = useState(() => resolveTab(window.location.hash))
  // 跳日志请求：{q, mode, n}。n 只用来做 key，重复点同一行也能强制重挂载。
  const [logJump, setLogJump] = useState(null)
  // 自动刷新开关（v3.307）：默认开；暂停后顶部倒计时停住，手动「继续」恢复。
  const [autoRefresh, setAutoRefresh] = useState(true)
  // 凭证失效（审查 #224）：任一 API 401 ⇒ 停轮询并显示自助恢复提示，不再每 5s 空打。
  const [authExpired, setAuthExpired] = useState(false)
  const [nextAt, setNextAt] = useState(0)
  // 表单交互暂停轮询的截止时间（见下方 focusin/change/input 监听）。不能只看
  // activeElement：用户选完下拉后焦点仍停在 select 上，会永久冻住自动刷新。
  const formPauseUntilRef = useRef(0)
  const timerRef = useRef(null)
  const seqRef = useRef(0)
  // 轮询互斥（Sourcery G_oY）：上一轮未完成时跳过本轮 tick，不在途中叠加新请求
  // （fetch 有 8s 期限，跳过最多让数据晚 2-5s 更新，换来零堆积）。
  const inFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  // busy 由哪一次提交引起（Sourcery G_nv：解锁判据是「提交的那一轮出现在历史里」，
  // 不管它现在是否已结束——否则任务秒完成时按钮锁到 11 分钟兜底才开）。
  const busyRunIdRef = useRef(null)
  // 首次刷新完成前不判「无活跃任务」（启动时 runs 尚空，会把丢失响应的 busy 立刻清掉）。
  const refreshedOnceRef = useRef(false)

  // 换页先清掉上一页的「数据截至」；当前页自己的 loader 成功后再写入。
  useEffect(() => { setPanelSync(null) }, [tab])

  // 切页在 DOM 提交后、绘制前回顶：先 setTab 再立即 scrollTo 会让旧长页面先闪一下。
  useLayoutEffect(() => { window.scrollTo(0, 0) }, [tab, logJump])

  // vwD：逐请求独立收口——status 失败时 runs 结果仍可用（反之亦然）；
  // 并行发出（Sourcery G_n6）：串行 await 会让慢端点拖住另一端点的更新。
  // 乱序防护（Sourcery vwE）：每次 refresh 领号，落后响应直接丢弃（落后 ≠ 失败，
  // 落后者静默丢弃不报错——Sourcery vwB：报「刷新失败」是误导）。
  const refreshSplit = useCallback(async () => {
    // 表单交互暂停期间不发起刷新；已在途的响应也会在下方 apply 前被丢弃。
    if (Date.now() < formPauseUntilRef.current) return
    if (inFlightRef.current) {
      // 切回概览时若上一轮还在路上，标记一次补刷，等 finally 再跑。
      pendingRefreshRef.current = true
      return
    }
    inFlightRef.current = true
    const seq = ++seqRef.current
    const errs = []
    const paused = () => Date.now() < formPauseUntilRef.current
    const applyStatus = (s) => { if (seq === seqRef.current && !paused()) { setState(s); setSyncErr('') } }
    const applyRuns = (r) => {
      if (seq === seqRef.current && !paused()) {
        setRuns(r.runs || [])
        setLastSync(Date.now())
        setRunsState('ok')
      }
    }
    try {
      const [sRes, rRes] = await Promise.allSettled([
        apiGetStatus(),
        apiGetRuns()
      ])
      if (sRes.status === 'fulfilled') applyStatus(sRes.value)
      else errs.push(`状态 ${sRes.reason && sRes.reason.message ? sRes.reason.message : sRes.reason}`)
      if (rRes.status === 'fulfilled') applyRuns(rRes.value)
      else {
        errs.push(`历史 ${rRes.reason && rRes.reason.message ? rRes.reason.message : rRes.reason}`)
        if (seq === seqRef.current) setRunsState((s) => (s === 'ok' ? 'ok' : 'error'))
      }
      if (seq !== seqRef.current || paused()) return
      refreshedOnceRef.current = true
      if (errs.length > 0) setSyncErr(`刷新失败：${errs.join('；')}（自动重试中）`)
      else setSyncErr('')
    } finally {
      inFlightRef.current = false
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        refreshSplit()
      }
    }
  }, [])

  // 轮询节奏（Sourcery vvJ）：任务在跑时必须用快轮询——以 locking（而非 busy）为节奏源，
  // 避免「busy 在 active 确认后被清 → 退回慢轮询」的窗口。
  // Sourcery Other-instance-idle：另一实例持锁时本进程 runs 历史是空的，此前显示「空闲」
  // 并允许触发（会被服务端 409 拒绝）。status.lock.held（共享 stateDir 的锁文件）参与判定。
  const active = runs.some((r) => !r.finishedAt) || !!(state && state.lock && state.lock.held === true)
  const locking = busy || active

  useEffect(() => {
    const onAuth = () => setAuthExpired(true)
    window.addEventListener('xbk-auth-expired', onAuth)
    return () => window.removeEventListener('xbk-auth-expired', onAuth)
  }, [])

  // 表单交互期间短暂暂停整页轮询：用户的焦点会一直停在下拉/输入框上，
  // 只按 activeElement 判断会永久停轮；这里用截止时间兜底，最长 10s 后恢复。
  // 选择器展开到选择完成通常 <10s；change/input 后 1.5s 再恢复，避免选完立刻重绘。
  useEffect(() => {
    const isForm = (el) => el && (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    const bump = (ms) => { formPauseUntilRef.current = Date.now() + ms }
    const onFocus = (e) => { if (isForm(e.target)) bump(10000) }
    // 部分安卓 WebView 的原生下拉在 focus 之前就展开；pointerdown 先兜一层。
    const onPointerDown = (e) => { if (isForm(e.target)) bump(10000) }
    const onDone = (e) => {
      const tag = e.target && e.target.tagName
      if (tag === 'SELECT') { if (e.type === 'change') bump(1500) } else if (tag === 'INPUT' || tag === 'TEXTAREA') bump(1500)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('change', onDone)
    document.addEventListener('input', onDone)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('change', onDone)
      document.removeEventListener('input', onDone)
    }
  }, [])

  useEffect(() => {
    if (authExpired) return undefined
    refreshSplit()
    clearInterval(timerRef.current)
    // 概览与运行日志需要状态新鲜（日志的 pollMs 取决于 task 是否在跑）；
    // 推送记录/配置/系统不轮询，避免每 5s 的 App 重渲染让页面闪一下。
    // 切回需要的页时会立即补一次 refreshSplit。
    if (tab !== 'overview' && tab !== 'logs') return () => clearInterval(timerRef.current)
    // 页面在后台时不轮询（切回前台立即补一次）：控制台标签页常驻也不该整夜打接口。
    // 暂停（autoRefresh=false）同样不建定时器；恢复时本 effect 重跑并立即补一次。
    if (!autoRefresh) return () => clearInterval(timerRef.current)
    const interval = locking ? POLL_BUSY_MS : POLL_MS
    const mark = () => setNextAt(Date.now() + interval)
    const tick = () => {
      if (document.visibilityState !== 'hidden') {
        // 用户正在操作表单（下拉/输入框）时跳过整拍：不 refresh、也不 mark
        // （mark 会 setNextAt 触发 App 重渲染，安卓原生 select 仍可能被重建）。
        // 截止时间到后自动恢复，不会因为焦点一直停在 select 上而永久停轮。
        if (Date.now() < formPauseUntilRef.current) return
        refreshSplit()
        mark()
      }
    }
    timerRef.current = setInterval(tick, interval)
    mark()
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() < formPauseUntilRef.current) return
      refreshSplit()
      mark()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refreshSplit, locking, tab, autoRefresh, authExpired])

  // hash 路由（v3.307）：首次进入补 #/overview；前进/后退跟着切页。
  useEffect(() => {
    const onHash = () => { setTab(resolveTab(window.location.hash)) }
    if (!window.location.hash) window.history.replaceState(null, '', '#/overview')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 标题状态点（v3.307）：标签页在后台时也能一眼看出「有失败/在跑」。
  // 只在拿到状态后着色；未加载用灰点，不谎报「正常」。
  useEffect(() => {
    const run = state && state.run && state.run.status === 'ok' ? state.run.value : null
    const stats = state && state.stats && state.stats.status === 'ok' ? state.stats.value : null
    const bad = !!(stats && stats.today && stats.today.failed > 0) || !!(run && (run.failed > 0 || run.interrupted))
    const dot = authExpired ? '🔴' : !state ? '⚪' : locking ? '🟡' : bad ? '🔴' : '🟢'
    document.title = `${dot} xbk-push 控制台`
  }, [state, locking, authExpired])

  // vwU/vv2：busy 提交成功后启动兜底闹钟；active 确认或超时即清。
  // Sourcery Old-run-unlocks-new-trigger：兜底清 busy 时必须同步清 busyRunIdRef——
  // 只清 busy 留 ref，旧 runId 若随后进历史，会在「下一次提交 setBusy(true) 后、
  // 其 202 未写 ref 前」被解锁 effect 撞上，把新提交的 busy 提前清掉。
  useEffect(() => {
    if (!busy) return undefined
    const t = setTimeout(() => {
      busyRunIdRef.current = null
      setBusy(false)
    }, BUSY_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [busy])

  // 正常解锁路径（Sourcery G_nv）：busy 期间每次刷新比对「提交的那一轮是否已进历史」
  // ——不管它现在运行中还是已结束，出现即解锁。秒完成的任务不再锁到兜底超时。
  useEffect(() => {
    if (!busy) return
    if (busyRunIdRef.current === null) {
      // Sourcery Trigger-busy-after-lost-response：202 已受理但响应体丢失（无 runId 可归属）
      // 时，等「无任何活跃任务」即解锁——2s 快轮询保证任务结束后最多 2s 恢复，不再等 11min 兜底。
      if (refreshedOnceRef.current && !active) {
        setBusy(false)
      }
      return
    }
    if (runs.some((r) => r.id === busyRunIdRef.current)) {
      busyRunIdRef.current = null
      setBusy(false)
    }
  }, [busy, runs, active])

  const handleTriggered = useCallback((runId) => {
    // run id 形态「epoch.seq」字符串（v3.299 评审：进程 epoch 防重启后序列复用误命中）
    if (typeof runId === 'string' && /^\d{13,}\.\d{1,10}$/.test(runId)) busyRunIdRef.current = runId
    refreshSplit()
  }, [refreshSplit])

  // v3.297 标签页状态：概览 / 推送记录 / 日志 / 系统。非概览页不跑主轮询，
  // 避免每 5s 的 App 重渲染让推送记录/配置页「闪一下」（刷新记录页有自己的加载）。
  const TABS = [
    { key: 'overview', label: '概览' },
    { key: 'messages', label: '推送记录' },
    { key: 'logs', label: '运行日志' },
    { key: 'config', label: '配置' },
    { key: 'filter', label: '过滤规则' },
    { key: 'sys', label: '系统' }
  ]
  // 切页回到顶部（v3.306）：手机从概览滚到底部再点「推送记录」，此前会停在
  // 新页面的中段/底部（window.scrollY 被保留），看起来像页面缺了开头。
  // v3.307 同步写 hash：刷新/后退能回到同一页。
  const switchTab = (next) => {
    if (next === tab) return
    setTab(next)
    if (window.location.hash !== `#/${next}`) window.location.hash = `#/${next}`
  }
  // 「查看日志」跳转：横幅/逐轮历史点进来时带筛选条件与日期，重挂载 LogsPanel。
  const openLog = useCallback((jump) => {
    setLogJump({ q: jump && jump.q ? jump.q : '', mode: jump && jump.mode ? jump.mode : 'all', n: Date.now() })
    setTab('logs')
    if (window.location.hash !== '#/logs') window.location.hash = '#/logs'
  }, [])
  const pollMs = locking ? POLL_BUSY_MS : POLL_MS
  // 顶栏徽章只在「概览/日志 + 自动刷新开」时是活状态；其它情况（暂停、推送记录/配置/系统）
  // 主轮询已停，徽章显示的是离开时的快照——必须注明，不能永久挂着「任务运行中」（审查 #246）。
  const livePolling = !authExpired && autoRefresh && (tab === 'overview' || tab === 'logs')
  const badgeText = authExpired
    ? '凭证失效'
    : `${locking ? '任务运行中' : '空闲'}${livePolling ? '' : '（快照）'}`
  return html`<div class="wrap">
    <header class="topbar">
      <div class="brand">
        <span class="logo">⚡</span>
        <span class="name">xbk-push 控制台</span>
        <${Badge} tone=${authExpired ? 'bad' : locking ? 'run' : 'ok'}>${badgeText}<//>
      </div>
      <div class="sync">
        ${tab === 'overview'
          ? html`${autoRefresh ? html`<${AutoRefreshText} nextAt=${nextAt} pollMs=${pollMs} lastSync=${lastSync} />` : '自动刷新已暂停'}
            <button type="button" class="sync-toggle" aria-pressed=${autoRefresh ? 'true' : 'false'}
              onClick=${() => { setAutoRefresh((v) => !v) }}>${autoRefresh ? '暂停' : '继续'}</button>`
          : panelSync ? `数据截至 · ${fmtLocalTime(panelSync)}` : '手动刷新'}
        ${syncErr ? html`<span class="sync-err"> · ${syncErr}</span>` : ''}
      </div>
    </header>

    ${authExpired && html`<div class="alert-banner bad" role="alert">
      <div class="alert-main">
        <strong>凭证已失效，控制台已停止自动刷新</strong>
        <span class="alert-sub">请用带 <code>?token=</code> 的完整链接重新打开；若链接已过期，从部署环境重新获取 XBK_CONSOLE_TOKEN。</span>
      </div>
      <a class="alert-action" href="/">重新登录</a>
    </div>`}

    <nav class="tabs">
      ${TABS.map((t) => html`<button key=${t.key} class=${'tab-btn' + (tab === t.key ? ' active' : '')}
        onClick=${() => { if (t.key === 'logs') setLogJump(null); switchTab(t.key) }}>${t.label}</button>`)}
    </nav>

    ${!authExpired && tab === 'overview' && html`<div>
      <${AlertBanner} state=${state} onOpenLog=${openLog} />
      <${StatusCards} state=${state} />
      <${TriggerBar} onTriggered=${handleTriggered} locking=${locking} setBusy=${setBusy} />
      <${RunsPanel} runs=${runs} status=${runsState} pollMs=${autoRefresh ? pollMs : 0} onRefresh=${refreshSplit} />
      <${TrendsPanel} />
      <${RunHistoryPanel} onOpenLog=${openLog} />
      <${CacheHealthPanel} paused=${!autoRefresh} />
    </div>`}
    ${!authExpired && tab === 'messages' && html`<${MessagesPanel} onSync=${setPanelSync} />`}
    ${!authExpired && tab === 'logs' && html`<div>
      ${runs.length > 0 && html`<${RunsPanel} runs=${runs} status=${runsState} pollMs=${autoRefresh ? pollMs : 0} onRefresh=${refreshSplit} />`}
      <${LogsPanel} key=${logJump ? logJump.n : 'base'} pollMs=${autoRefresh && locking ? POLL_BUSY_MS : 0}
        initialQuery=${logJump ? logJump.q : ''} initialMode=${logJump ? logJump.mode : 'all'} onSync=${setPanelSync} />
    </div>`}
    ${!authExpired && tab === 'config' && html`<${ConfigPanel} onSync=${setPanelSync} />`}
    ${!authExpired && tab === 'filter' && html`<${FilterRulesPanel} onSync=${setPanelSync} />`}
    ${!authExpired && tab === 'sys' && html`<div>
      <${SysPanel} />
      <${FilesPanel} />
    </div>`}

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送，触发前二次确认 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
