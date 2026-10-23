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
import { relDay, cacheWriteInfo, filterLogLines, ageFromStamp, logLineCounts, logLineTone, splitHits, filterRunItems, tabFromHash, effectiveFilterRows, filterSourceNote, backToTopBehavior, dateRangeLabel } from './pure.mjs'
// 日期区间（v3.326）：flatpickr 4.6.13 的 ESM 单文件 bundle（含 zh 语言包，vendored 入库，
// 与 htm-preact 同口径——不引 CDN，CSP script-src 'self' 覆盖）。样式在 flatpickr.css，
// 主题化覆盖写在 app.css 的 .flatpickr-calendar 段（跟四套 token 走）。
import flatpickr from './flatpickr.js'

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
    // version：页面启动时的构建版本（服务端注入），用来发现「部署后还开着旧标签页」。
    return {
      token: typeof data.token === 'string' ? data.token : '',
      version: typeof data.version === 'string' ? data.version : ''
    }
  } catch (e) { return { token: '', version: '' } }
}
const BOOT = readBoot()

// BFCache 恢复（评审 #233 · Sourcery Medium）：浏览器从往返缓存恢复页面时会跳过 `/` 请求，
// BOOT.token 可能已随服务重启/轮换而过期——GET 靠 Cookie 仍正常，但写动作会 401。
// persisted=true 即非首次加载，强制重载拿当前凭证（no-store 不保证 BFCache 驱逐）。
window.addEventListener('pageshow', (ev) => { if (ev.persisted) window.location.reload() })

const POLL_MS = 5000
const POLL_BUSY_MS = 2000
// 部署后旧标签页仍跑旧脚本（数据照常轮询，看起来「在线」却看不到新 UI）。每 60s 对一次
// /api/sys 的版本，不一致就挂一条「刷新后生效」的提示——不自动 reload，避免打断正在填的表单。
// 边界（Sourcery #294）：只覆盖本版之后打开的页面。部署那一刻已经开着的旧页拿不到这段代码，
// 服务端也无法给旧页注入逻辑——那些页仍需手动刷一次；此后每次部署都有提示。
const VERSION_CHECK_MS = 60000
// 提交成功后按钮锁定的最长兜底时长（Sourcery vwU/vv2：轮询竞态/请求挂起时不能永久锁死；
// 上限 = 服务端 PROC_TIMEOUT_MS(10min) + 提交往返余量，取 11 分钟）。
const BUSY_FALLBACK_MS = 11 * 60 * 1000
// fetch 请求期限（Sourcery G_n6）：挂起连接不得阻塞刷新链路；超时由 AbortController 取消，
// 走正常 reject 路径（「刷新失败」可见），不会堆积请求。
const FETCH_TIMEOUT_MS = 8000
// 通知自检重复提交拦截窗的客户端边界（与 console.js NOTIFY_REPLAY_MIN_S/MAX_S 同口径）：
// 这层只负责「非法值不发请求」，服务端仍是唯一权威（越界/类型错一律 400）。
const NOTIFY_WINDOW_MIN_S = 0
const NOTIFY_WINDOW_MAX_S = 3600
const NOTIFY_WINDOW_DEFAULT_S = 60

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

// 只取时分秒（Asia/Shanghai）：触发结果行要与 run.log 的时间对照，口径必须与 fmtTime 一致。
function fmtClock (ts) {
  const s = fmtTime(ts)
  return s === '—' ? '—' : s.slice(11)
}

// 轮次用时：<1s 用 ms（避免「0.0s」），其余一位小数秒。未知返回 '—'（不编 0）。
function fmtDuration (startedAt, finishedAt) {
  const a = Number(startedAt)
  const b = Number(finishedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—'
  const ms = b - a
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
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
function apiGetMessages ({ page, size, cate, q, days, from, to }) {
  const params = new URLSearchParams()
  if (Number.isSafeInteger(page) && page > 1) params.set('page', String(page))
  if (Number.isSafeInteger(size) && size !== 20) params.set('size', String(size))
  if (typeof cate === 'string' && cate.length > 0) params.set('cate', cate)
  if (typeof q === 'string' && q.length > 0) params.set('q', q)
  // 时间窗（v3.307）：0/未传=全部；1/3/7/30=近 N 个上海日历日（服务端白名单兜底）
  if (Number.isSafeInteger(days) && days > 0) params.set('days', String(days))
  // 自定义区间（v3.326）：YYYY-MM-DD 闭区间，服务端优先于 days（非法/颠倒时静默回落）
  if (typeof from === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(from)) params.set('from', from)
  if (typeof to === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(to)) params.set('to', to)
  const qs = params.toString()
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const p = fetch(qs.length > 0 ? `/api/messages?${qs}` : '/api/messages', merged)
  return consumeJson(p, done)
}

function apiGetTrends ({ days, from, to } = {}) {
  const params = new URLSearchParams()
  // days 由固定常量 TREND_DAYS 提供（14 为服务端默认，省略参数）；非法值前端先行钳制，
  // 服务端白名单仍兜底。查询段进模板字符串、authority 恒为字面量（Codacy SSRF 全绿形态）。
  if (days === 30 || days === 60) params.set('days', String(days))
  // v3.326：自定义区间优先于 days（服务端同口径：非法/颠倒回落 days）。
  if (typeof from === 'string' && DAY_KEY_RE.test(from)) params.set('from', from)
  if (typeof to === 'string' && DAY_KEY_RE.test(to)) params.set('to', to)
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

let filesInFlight = null
function apiGetFiles () {
  // 启动预加载会同时命中缓存健康右列、系统页文件清单、过滤规则备份下拉；
  // 共享同一个在飞 Promise，避免对大目录做三次同步扫描（Sourcery #272）。
  if (filesInFlight) return filesInFlight
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  filesInFlight = consumeJson(fetch('/api/files', merged), done)
  const clear = () => { filesInFlight = null }
  filesInFlight.then(clear, clear)
  return filesInFlight
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

// v3.332：版本探针走 ?probe=version——服务端据此不把它记进访问日志（60s 一条会挤掉真实历史）；
// 同时 no-store，防代理/浏览器启发式缓存把旧版本喂回来，让「有新版本」永远判不出来。
function apiGetSys ({ probeVersion = false } = {}) {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` },
    ...(probeVersion ? { cache: 'no-store' } : {})
  })
  return consumeJson(fetch(probeVersion ? '/api/sys?probe=version' : '/api/sys', merged), done)
}

// 服务器端自动运行：GET 读状态；POST 开关/改间隔（写面只认 Bearer）。
function apiGetAuto () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/auto', merged), done)
}

function apiSetAuto (payload) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${BOOT.token}`
    },
    body: JSON.stringify(payload)
  })
  return consumeJson(fetch('/api/auto', merged), done)
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

let filterInFlight = null
function apiGetFilter () {
  // 配置页和过滤规则页启动预加载时都会要同一份过滤规则快照，共享在飞 Promise。
  if (filterInFlight) return filterInFlight
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  filterInFlight = consumeJson(fetch('/api/config/filter', merged), done)
  const clear = () => { filterInFlight = null }
  filterInFlight.then(clear, clear)
  return filterInFlight
}

// 服务器草稿：读面沿用 Cookie/?token= 均可的全局鉴权；写/删只认 Bearer。
function apiGetFilterDraft () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/config/filter/draft', merged), done)
}

function apiPostFilterDraft (filter, baseRevision, { keepalive = false } = {}) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({ schema: 1, baseRevision, filter }),
    keepalive
  })
  return consumeJsonResult(fetch('/api/config/filter/draft', merged), done)
}

function apiDeleteFilterDraft () {
  const { merged, done } = timedRequest({
    method: 'DELETE',
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` },
    keepalive: true
  })
  return consumeJsonResult(fetch('/api/config/filter/draft', merged), done)
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

// 控制台设置（v3.340）：通知自检拦截窗的读/写面。GET 与其它读面同款（Bearer + Accept）；
// 写面复用 filterWriteHeaders（Bearer + application/json，服务端 415 闸要求后者）。
function apiGetConsoleSettings () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/config/console', merged), done)
}

function apiPostConsoleSettings (body) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/console', merged), done)
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
      // dupMsg 允许传函数（v3.340）：拦截窗已可配置，文案里的秒数必须取服务端响应的
      // data.replayWindowS（该动作实际生效窗），不能在客户端写死 60。
      const msg = typeof dupMsg === 'function' ? dupMsg(data) : dupMsg
      const err = new Error(msg)
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
    (data) => {
      // 窗长由服务端下发（配置页可改）；缺失才回退默认 60（老服务端/异常响应）。
      const winS = data && Number.isInteger(data.replayWindowS) ? data.replayWindowS : NOTIFY_WINDOW_DEFAULT_S
      // 窗长不等于「还要等多久」：第 57 秒重试时窗还是 60，说「60 秒内无需重复」就是谎话。
      // 服务端同时给了 retryAfterS，剩余时间更短时补上真实还剩多久。
      const retryS = data && Number.isInteger(data.retryAfterS) ? data.retryAfterS : null
      return retryS !== null && retryS < winS
        ? `刚才那次通知自检已受理（正在运行或已完成），拦截窗 ${winS} 秒，还需等 ${retryS} 秒`
        : `刚才那次通知自检已受理（正在运行或已完成），${winS} 秒内无需重复`
    },
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

// 顶栏用的时间：v3.342 起「是否带年月日」可设置（默认带）。只影响显示，tip 里永远是完整时间。
function fmtBarTime (ts, withDate) {
  const s = fmtLocalTime(ts)
  if (s === '—' || withDate !== false) return s
  return s.slice(11)
}

// 顶栏状态行：所有页共用这一个组件、这一套词（v3.346）。
//  - 轮询中的页（概览/日志）秒数倒数；不轮询的页给配置的间隔，不假装在倒数。
//  - 暂停时只换开头两个字，后半句「数据截至 · 时间」保持同一形态。
// 独立持有 1s 时钟：避免 App 每秒重渲染整页（安卓原生 select 会闪）。
function AutoRefreshText ({ nextAt, pollMs, lastSync, showDate = true, paused = false, live = true }) {
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    // 不轮询的页不需要秒级时钟，别白建定时器。
    if (!live) return undefined
    // v3.347：500ms 而不是 1000ms。1s 的时钟和 mark() 不同相，最多落后近 1s，
    // 实测倒数会「5 4 3 2 → 5」直接跳过 1s（用户真机录屏反馈的顿挫感就来自这里）。
    const t = setInterval(() => setNowMs(() => Date.now()), 500)
    return () => clearInterval(t)
  }, [live])
  const at = lastSync ? fmtBarTime(lastSync, showDate) : '—'
  if (paused) return html`已暂停 · 数据截至 · ${at}`
  const sec = Math.max(1, Math.round(pollMs / 1000))
  const remain = live ? Math.max(0, Math.min(sec, Math.ceil(((nextAt || (Date.now() + pollMs)) - nowMs) / 1000))) : sec
  return html`自动刷新 ${remain}s · 数据截至 · ${at}`
}

function fmtWeekday (ts) {
  if (!ts) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(Number(ts)).getDay()]
}

// v3.341：窄屏下顶栏状态行会被省略号截断（时间只剩半截）。点一下就地弹出完整文本，点页面
// 其它任意地方/按 Esc 收回。弹层用 position: fixed：祖先 .sync 是 overflow:hidden，绝对定位
// 会被裁掉；fixed 也不受滚动容器影响（滚动时直接收回，避免跟着飘）。
function TapTip ({ tip, children }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const boxRef = useRef(null)
  const popRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (boxRef.current && boxRef.current.contains(e.target)) return
      if (popRef.current && popRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])
  if (!tip) return html`${children}`
  const toggle = () => {
    if (open) { setOpen(false); return }
    const box = boxRef.current
    if (box) {
      const r = box.getBoundingClientRect()
      const width = Math.min(360, Math.max(200, window.innerWidth - 24))
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setPos({ top: Math.round(r.bottom + 6), left: Math.round(left), width: Math.round(width) })
    }
    setOpen(true)
  }
  return html`<span class="tap-tip" ref=${boxRef} role="button" tabindex="0"
      aria-expanded=${open ? 'true' : 'false'}
      onClick=${(e) => { e.stopPropagation(); toggle() }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle() }
      }}>${children}</span>
    ${open && html`<span class="tap-tip-pop" ref=${popRef} role="tooltip"
      style=${pos ? `top:${pos.top}px;left:${pos.left}px;width:${pos.width}px` : ''}>${tip}</span>`}`
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
function Button ({ variant = 'secondary', disabled, onClick, title, buttonRef, ariaBusy, children }) {
  return html`<button ref=${buttonRef} class=${'btn btn-' + variant} disabled=${disabled} onClick=${onClick} title=${title} aria-busy=${ariaBusy}>${children}</button>`
}

// 深色小下拉：趋势窗口/每页条数/时间范围共用。
// 不用原生 <select>：Android Chrome 会弹全屏白底系统列表，和暗色控制台完全割裂
// （分类筛选已因此改 CategoryPicker）。这里保留锚定弹层：选项少时不铺满屏幕，
// 空间不足向上翻，键盘/触屏同一套交互。
function MiniSelect ({ value, options, onChange, ariaLabel, disabled = false }) {
  const list = Array.isArray(options) ? options : []
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState({ up: false, max: 240, dx: 0, ready: false })
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const focusedRef = useRef(false)

  const selIdx = Math.max(0, list.findIndex((o) => o.value === value))
  const current = list[selIdx]

  const focusOpt = (i) => {
    const pop = popRef.current
    if (!pop) return
    const el = pop.querySelector(`[data-idx="${i}"]`)
    if (!el) return
    // preventScroll：弹层在页面下部时，浏览器默认 focus 会把整页猛地滚下去。
    el.focus({ preventScroll: true })
    const r = el.getBoundingClientRect()
    const pr = pop.getBoundingClientRect()
    if (r.top < pr.top) pop.scrollTop -= (pr.top - r.top)
    else if (r.bottom > pr.bottom) pop.scrollTop += (r.bottom - pr.bottom)
  }

  // 先量再显示：首帧用 visibility:hidden，避免先按「向下」铺一帧再跳到上方。
  // 打开期间滚动/缩放也要重量：否则页面滚走后方向与高度还是旧值，选项会被裁掉。
  useLayoutEffect(() => {
    if (!open) return undefined
    let raf = 0
    const measure = () => {
      const btn = btnRef.current
      const pop = popRef.current
      if (!btn || !pop) return
      const b = btn.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const below = vh - b.bottom - 10
      const above = b.top - 10
      const natural = Math.min(pop.scrollHeight + 2, 320)
      const up = below < Math.min(natural, 200) && above > below
      const max = Math.max(48, Math.min(natural, up ? above : below))
      // 水平也做视口夹取：默认右对齐，靠左的按钮 + 更长选项时不能越出左边界。
      const w = pop.getBoundingClientRect().width
      const pad = 8
      const left = Math.min(Math.max(pad, b.right - w), Math.max(pad, vw - w - pad))
      const dx = Math.round(left - b.left)
      setPlace((prev) => (prev.ready && prev.up === up && prev.max === max && prev.dx === dx
        ? prev
        : { up, max, dx, ready: true }))
    }
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => { raf = 0; measure() })
    }
    measure()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [open])

  useEffect(() => {
    if (!open) { focusedRef.current = false; return undefined }
    if (!place.ready || focusedRef.current) return undefined
    focusedRef.current = true
    setActive(selIdx)
    focusOpt(selIdx)
    return undefined
  }, [open, place.ready, selIdx])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // busy/loading 时按钮 disabled；必须允许按钮本身失焦，不能再接键盘动作。
  useEffect(() => { if (disabled && open) setOpen(false) }, [disabled, open])

  const openMenu = () => {
    if (disabled) return
    setPlace({ up: false, max: 240, dx: 0, ready: false })
    setActive(Math.max(0, list.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const close = (refocus) => {
    setOpen(false)
    if (refocus && btnRef.current) btnRef.current.focus({ preventScroll: true })
  }
  const choose = (i) => {
    const o = list[i]
    close(true)
    if (o && o.value !== value) onChange(o.value)
  }
  const move = (i) => {
    if (list.length === 0) return
    const next = Math.max(0, Math.min(list.length - 1, i))
    setActive(next)
    focusOpt(next)
  }
  // Tab 必须显式把焦点送到组件外的下一个/上一个可聚焦控件：只 close 再放行默认行为，
  // 浏览器可能落在即将卸载的选项上，焦点会掉到 body。
  const focusOutside = (dir) => {
    const root = rootRef.current
    const btn = btnRef.current
    if (!root || !btn) return null
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const els = [...document.querySelectorAll(sel)].filter((el) => !root.contains(el) && el.getClientRects().length > 0)
    if (dir < 0) {
      for (let i = els.length - 1; i >= 0; i--) {
        if (btn.compareDocumentPosition(els[i]) & window.Node.DOCUMENT_POSITION_PRECEDING) return els[i]
      }
    } else {
      for (const el of els) {
        if (btn.compareDocumentPosition(el) & window.Node.DOCUMENT_POSITION_FOLLOWING) return el
      }
    }
    return null
  }
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); close(true); return }
    if (!open) {
      if (!disabled && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(active + 1); break
      case 'ArrowUp': e.preventDefault(); move(active - 1); break
      case 'Home': e.preventDefault(); move(0); break
      case 'End': e.preventDefault(); move(list.length - 1); break
      case 'Enter':
      case ' ': e.preventDefault(); choose(active); break
      case 'Tab': {
        e.preventDefault()
        const target = focusOutside(e.shiftKey ? -1 : 1)
        close(false)
        if (target) target.focus({ preventScroll: true })
        else if (btnRef.current) btnRef.current.focus({ preventScroll: true })
        break
      }
    }
  }

  const buttonLabel = current ? current.label : ''
  const buttonAria = current ? `${ariaLabel}，当前 ${buttonLabel}` : ariaLabel
  return html`<span class="mini-select" ref=${rootRef} onKeyDown=${onKeyDown}>
    <button type="button" class="mini-btn" ref=${btnRef} disabled=${disabled}
      aria-haspopup="listbox" aria-expanded=${open ? 'true' : 'false'} aria-label=${buttonAria}
      onClick=${() => { if (open) close(true); else openMenu() }}>
      <span class="mini-label">${buttonLabel}</span>
      <span class="mini-caret" aria-hidden="true">▾</span>
    </button>
    ${open && html`<div class="mini-pop" ref=${popRef} role="listbox" aria-label=${ariaLabel}
      style=${`left:${place.dx}px;right:auto;max-height:${place.max}px;visibility:${place.ready ? 'visible' : 'hidden'};${place.up ? 'top:auto;bottom:calc(100% + 6px);' : ''}`}>
      ${list.map((o, i) => html`<button type="button" key=${o.value} data-idx=${i}
        class=${'mini-opt' + (o.value === value ? ' on' : '')}
        role="option" aria-selected=${o.value === value ? 'true' : 'false'}
        tabIndex=${i === active ? 0 : -1}
        onFocus=${() => setActive(i)}
        onClick=${() => choose(i)}>
        <span>${o.label}</span>${o.value === value ? html`<span class="mini-check" aria-hidden="true">✓</span>` : ''}
      </button>`)}
    </div>`}
  </span>`
}

// 指标卡：标题 + 右上角徽章 + 若干行文本。换卡片实现（或组件库）只改这里。
// v3.325：卡片加「主数字」——之前四张卡都是同一档小字，扫读时分不出主次。
// main = { num, unit, hint }：数字单独放大 + 等宽数字（tabular-nums），标签压回小字。
// ── 组件：日期区间（v3.326）──────────────────────────────────────────────────
// 所有「按时间筛」的地方共用这一个：推送记录（服务端区间）、运行日志（按行首日期）、
// 逐轮历史（按轮次日期）、趋势（服务端区间）。flatpickr 挂在 1px 隐形 input 上，
// 弹层对齐按钮（positionElement）；只认 Date 数组不解析本地化字符串——zh 语言包的
// 区间分隔符是「 至 」，按 " to " 切永远匹配不上（实测踩过）。
const DAY_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const EMPTY_RANGE = { from: '', to: '' }

// 上海日历日（与 run.log / 服务端同口径）：按钮文案按它判断「是不是今年」。
function todayKeyShanghai () {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function fmtDayKey (d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 月份箭头长按连翻（v3.326）：跨年要按十几下，用户要求按住就能一直翻、按越久翻越快。
// 单击仍旧只翻一个月（原生 click 负责），长按 420ms 后由这里接管自动重复。
function attachMonthHoldRepeat (inst) {
  const pick = (delta) => inst.calendarContainer.querySelector(delta < 0 ? '.flatpickr-prev-month' : '.flatpickr-next-month')
  const bind = (delta) => {
    const el = pick(delta)
    if (!el || el.dataset.holdBound === '1') return
    el.dataset.holdBound = '1'
    let timer = null
    let startTs = 0
    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const step = () => {
      const arrow = pick(delta)
      if (!arrow || arrow.classList.contains('flatpickr-disabled')) return stop()
      inst.changeMonth(delta, true)
      // 越按越快（用户口径：起手约一秒一格，按住越久越快）：
      // 1.2s 内 800ms/格 ≈ 1 格/秒；2.4s 内 400ms；4s 内 200ms；之后 100ms ≈ 10 格/秒。
      const held = Date.now() - startTs
      timer = setTimeout(step, held < 1200 ? 800 : held < 2400 ? 400 : held < 4000 ? 200 : 100)
    }
    // 手势全部自己接管：系统在长按 ~500ms 时会弹选字/预览菜单（手机会"叮"一声），
    // 所以 touchstart / pointerdown 都 preventDefault，点击也只认我们自己的 pointerup。
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation() }, true)
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false })
    el.addEventListener('pointerdown', (e) => {
      if (typeof e.button === 'number' && e.button > 0) return
      e.preventDefault()
      stop()
      startTs = Date.now()
      timer = setTimeout(step, 420)
    })
    el.addEventListener('pointerup', () => {
      const held = Date.now() - startTs
      stop()
      // 没到连翻阈值就是单击：自己翻一格（原生 click 已被吞掉）。
      if (held < 420 && !pick(delta).classList.contains('flatpickr-disabled')) inst.changeMonth(delta, true)
    })
    for (const ev of ['pointerleave', 'pointercancel', 'blur']) el.addEventListener(ev, stop)
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  bind(-1)
  bind(1)
}

function DateRange ({ value, onChange, label = '日期区间', disabled = false }) {
  const from = value && typeof value.from === 'string' ? value.from : ''
  const to = value && typeof value.to === 'string' ? value.to : ''
  const active = DAY_KEY_RE.test(from) && DAY_KEY_RE.test(to)
  const anchorRef = useRef(null)
  const instRef = useRef(null)
  const btnRef = useRef(null)
  const cbRef = useRef(onChange)
  cbRef.current = onChange
  useEffect(() => {
    const el = anchorRef.current
    if (!el) return undefined
    const inst = flatpickr(el, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      // 只到今天（上海日历日）：数据都按上海日聚合，用浏览器本地 'today' 会在
      // 时差区和上海跨零点后错位（选不到今天 / 选到未来得到空结果，Sourcery #288 M6）。
      maxDate: todayKeyShanghai(),
      disableMobile: true,
      // 单月：双月在 390 宽必然溢出；maxDate 之后第二个月也只剩禁用格。
      showMonths: 1,
      // 月份不用原生 <select>：它弹出的是系统选择器（手机上是白底系统弹层，CSS 改不了），
      // 在深色面板里必然破一致性。改成静态文字 + 左右箭头翻月，年份仍可直接改。
      monthSelectorType: 'static',
      positionElement: btnRef.current || el,
      onReady (_sel, _str, inst) { attachMonthHoldRepeat(inst) },
      // 面板可能开着跨过上海零点：每次打开按当下上海日重设上限。
      onOpen (_d, _s, inst) { inst.set('maxDate', todayKeyShanghai()) },

      onChange (dates) {
        if (!Array.isArray(dates) || dates.length !== 2) return
        const f = fmtDayKey(dates[0])
        const t = fmtDayKey(dates[1])
        if (!DAY_KEY_RE.test(f) || !DAY_KEY_RE.test(t) || f > t) return
        if (cbRef.current) cbRef.current({ from: f, to: t })
        inst.close()
      }
    })
    instRef.current = inst
    return () => { inst.destroy(); instRef.current = null }
  }, [])
  // 受控值外部变化（清除 ×、切预设、跳转重置）时同步 flatpickr 的选中态：
  // 实例只在挂载时建一次，不同步的话日历仍高亮上一个区间（Sourcery #288 M7）。
  useEffect(() => {
    const inst = instRef.current
    if (!inst) return
    const want = active ? [from, to] : []
    const cur = (inst.selectedDates || []).map(fmtDayKey)
    if (cur.join('|') === want.join('|')) return
    if (want.length === 2) inst.setDate(want, false, 'Y-m-d')
    else inst.clear()
  }, [from, to, active])
  const clear = () => { if (cbRef.current) cbRef.current({ ...EMPTY_RANGE }) }
  return html`<span class="date-range">
    <button type="button" ref=${btnRef} class=${active ? 'date-btn on' : 'date-btn'} disabled=${disabled}
      aria-label=${active ? `${label} ${from} 至 ${to}` : label}
      onClick=${() => { const inst = instRef.current; if (inst) inst.open() }}>
      ${active ? dateRangeLabel(from, to, todayKeyShanghai()) : label}
    </button>
    ${active && html`<button type="button" class="date-clear" aria-label=${`清除${label}`} onClick=${clear}>×</button>`}
    <input ref=${anchorRef} class="fp-anchor" type="text" tabIndex=${-1} aria-hidden="true" readOnly />
  </span>`
}

// 按区间过滤「带 datetime/at 前缀」的条目（客户端侧复用：日志行、逐轮历史）。
function inDayRange (day, range) {
  if (!range || !DAY_KEY_RE.test(range.from) || !DAY_KEY_RE.test(range.to)) return true
  return typeof day === 'string' && day >= range.from && day <= range.to
}

function Card ({ title, badge, main, children }) {
  return html`<div class="card">
    <div class="card-head">
      <span class="card-title">${title}</span>
      ${badge}
    </div>
    ${main
      ? html`<div class="card-main">
          <span class="card-num">${main.num}</span><span class="card-unit">${main.unit}</span>
        </div>
        ${main.hint ? html`<div class="card-hint">${main.hint}</div>` : null}`
      : null}
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
  // v3.318：横幅的「查看日志」也走先取后切；150ms 后才显示「加载中…」，失败变「重试 →」。
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const jumpSeqRef = useRef(0)
  const jumpTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(jumpTimerRef.current), [])
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
  const openJump = () => {
    if (!onOpenLog) return
    const seq = ++jumpSeqRef.current
    setFailed(false)
    clearTimeout(jumpTimerRef.current)
    jumpTimerRef.current = window.setTimeout(() => {
      if (seq === jumpSeqRef.current) setBusy(true)
    }, 150)
    Promise.resolve(onOpenLog({ q: at.slice(0, 10), mode: 'issue' }))
      .then((res) => {
        if (seq !== jumpSeqRef.current) return
        if (res && res.ok === false && !res.canceled) setFailed(true)
      })
      .catch(() => {
        if (seq === jumpSeqRef.current) setFailed(true)
      })
      .finally(() => {
        if (seq !== jumpSeqRef.current) return
        clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = 0
        setBusy(false)
      })
  }
  return html`<div class="alert-banner" role="alert">
    <span class="alert-dot" aria-hidden="true"></span>
    <span class="alert-text">${text}</span>
    <button type="button" class="alert-link" aria-busy=${busy ? 'true' : 'false'}
      title=${failed ? '日志加载失败，点此重试' : '查看该日日志'}
      onClick=${openJump}>${busy ? '加载中…' : (failed ? '重试 →' : '查看日志 →')}</button>
  </div>`
}

// ── 组件：状态卡片区 ────────────────────────────────────────────────────────
// v3.307 信息层级：今日 / 近 7 天 / 最近一轮 / 通道与过滤。旧版「最近日报」与「最近一轮」
// 两张卡都在讲最近一次，缺「今天怎么样、成功率多少」；现在日报压成今日卡的一行，
// 过滤诊断并入通道卡，四张卡各答一个问题。
// v3.329：首屏（以及下拉刷新触发的整页重载）在 /api/status 回来前，四张卡必须已经按最终
// 形态占位。此前 !state 直接 return null，卡片块整块缺席，下面的「手动触发」先顶到页签下；
// 状态回来后再插入一块 340px 高的卡片，手机上就是整屏一闪（360×795 实测「手动触发」顶部
// 180 → 536.5，跳 356.5px）。占位只写「—」不写 0/「正常」，不谎报数据。
const CARD_PLACEHOLDERS = [
  { title: '今日', tone: 'run', badge: '—', main: { num: '—', unit: '', hint: '正在读取…' }, lines: ['失败 —', '日报 —'] },
  { title: '近 7 天', tone: 'run', badge: '—', main: { num: '—', unit: '', hint: '正在读取…' }, lines: ['失败 — · 成功率 —', '日均 — 轮'] },
  { title: '最近一轮', tone: 'run', badge: '—', main: { num: '—', unit: '', hint: '正在读取…' }, lines: ['获取 — · 失败 — · 耗时 —'] },
  { title: '通道与过滤', tone: 'run', badge: '—', main: { num: '—', unit: '条被过滤', hint: '正在读取…' }, lines: ['最近过滤 —', '原因 —'] }
]

function CardsGrid ({ cards, busy }) {
  return html`<div class="cards" aria-busy=${busy ? 'true' : undefined}>
    ${cards.map((c) => html`<${Card} key=${c.title} title=${c.title} main=${c.main}
      badge=${html`<${Badge} tone=${c.tone}>${c.badge}<//>`}>
      ${c.lines.map((l) => html`<div key=${l}>${l}</div>`)}
    <//>`)}
  </div>`
}

function StatusCards ({ state, err }) {
  // 占位文案只区分「正在读」与「读取失败」两种，都是一行，不改变预留高度。
  if (!state) {
    const hint = err ? '读取失败' : '正在读取…'
    const cards = CARD_PLACEHOLDERS.map((c) => ({ ...c, main: { ...c.main, hint } }))
    return html`<${CardsGrid} cards=${cards} busy=${!err} />`
  }
  const rep = state.report && state.report.value ? state.report.value : null
  const repTone = partTone(state.report, repIsOk(state))
  const run = state.run && state.run.value ? state.run.value : null
  const runTone = partTone(state.run, runIsOk(state))
  const runDry = run && run.dryRun != null
  const runBad = run && (run.interrupted === true || run.failed > 0)
  const chan = channelInfo(state)
  const stats = state.stats && state.stats.status === 'ok' ? state.stats.value : null
  const today = stats ? stats.today : null
  const week = stats ? stats.week : null
  const diag = diagCard(state)[0] || null
  const diagTone = diag ? diag.tone : 'run'
  const diagLines = diag ? diag.lines : ['暂无记录']
  // v3.325：通道卡的「主数字」用被过滤条数（有信息量），连续失败放 hint。
  const diagRaw = state.diagnostics && state.diagnostics.status === 'ok' ? state.diagnostics.value : null
  const diagReasons = diagRaw && diagRaw.byReason && typeof diagRaw.byReason === 'object'
    ? Object.entries(diagRaw.byReason).map(([k, n]) => `${k} ${typeof n === 'number' ? n : '?'}`).join('，')
    : ''
  const filteredCount = diagRaw && diagRaw.byReason && typeof diagRaw.byReason === 'object'
    ? Object.values(diagRaw.byReason).reduce((a, n) => a + (typeof n === 'number' ? n : 0), 0)
    : null
  const diagAt = diagRaw ? diagRaw.at : null
  const chanMax = chan.entries.length > 0 ? Math.max(...chan.entries.map((e) => e.failures)) : 0
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
      main: today
        ? { num: fmtNum(today.pushed), unit: '条推送', hint: `轮次 ${today.rounds} · 成功率 ${rateText(today)}` }
        : { num: '—', unit: '', hint: '暂无 run.log 数据' },
      lines: today
        ? [
            `失败 ${fmtNum(today.failed)}${today.failed > 0 ? ' ⚠️' : ''}`,
            // 「正常」不再重复写在日报行：右上角状态点已经表达，重复反而每次都要读两遍。
            `日报 ${rep ? `${rep.date || '—'}${repRel ? `（${repRel}）` : ''}${repTone === 'ok' ? '' : repTone === 'bad' ? ' · 异常' : ' · 暂无'}` : '暂无'}`
          ]
        // 没有 run.log 数据时也要占满两行：行数随数据增减会让卡片块在加载完成的瞬间长高/变矮，
        // 把下面的面板整体推走（Sourcery PR #292：首帧占位必须与加载完成态同高）。
        : ['失败 —', '日报 —']
    },
    {
      title: '近 7 天',
      tone: weekTone,
      badge: !week ? '—' : (week.failed > 0 ? '有失败' : (week.rounds > 0 ? '正常' : '—')),
      main: week
        ? { num: fmtNum(week.pushed), unit: '条推送', hint: `轮次 ${week.rounds}${stats && stats.truncated ? ' · 仅统计尾部' : ''}` }
        : { num: '—', unit: '', hint: '暂无数据' },
      lines: week
        ? [
            `失败 ${fmtNum(week.failed)} · 成功率 ${rateText(week)}`,
            `日均 ${(week.rounds / 7).toFixed(1)} 轮`
          ]
        : ['失败 — · 成功率 —', '日均 — 轮']
    },
    {
      title: '最近一轮',
      tone: runDry ? (runBad ? 'bad' : 'warn') : runTone,
      badge: !run
        ? '—'
        : (run.cancelled === true
            ? '已取消'
            : (runDry ? (runBad ? '试跑异常' : '试跑') : (runBad ? '异常' : '正常'))),
      main: run
        ? {
            num: fmtNum(runDry ? run.dryRun : run.pushed),
            unit: runDry ? '条未推送' : '条推送',
            hint: `${runAge || '时间未知'}${run.at ? ` · ${run.at.slice(5, 16)}` : ''}`
          }
        : { num: '—', unit: '', hint: '暂无数据' },
      lines: run
        ? [
            `获取 ${fmtNum(run.total)} · 失败 ${fmtNum(run.failed)} · 耗时 ${fmtNum(run.elapsed)}${run.cancelled === true ? ' · ⏹ 已取消' : run.interrupted ? ' · ⚠️ 中断' : ''}`
          ]
        : ['获取 — · 失败 — · 耗时 —']
    },
    {
      title: '通道与过滤',
      tone: chanTone,
      badge: chanTone === 'bad' ? '异常' : (chanTone === 'ok' ? '正常' : '—'),
      // 主数字换成「被过滤条数」：连续失败 0 当大字没意义（0 太抢且不是成绩）。
      main: {
        num: filteredCount === null ? '—' : fmtNum(filteredCount),
        unit: '条被过滤',
        hint: `${chan.entries.length > 0 ? chan.entries.map((e) => e.name).join('、') : (chan.note || '暂无记录')}${chanMax > 0 ? ` · 连续失败 ${chanMax}` : ' · 连续失败 0'}`
      },
      lines: diagLines.length > 0
        ? [`最近过滤 ${fmtNum(diagAt)}`, `原因 ${diagReasons || '无'}`]
        : ['最近过滤 —', '原因 —']
    }
  ]
  return html`<${CardsGrid} cards=${cards} />`
}

// ── 组件：触发按钮 ──────────────────────────────────────────────────────────
// 自动正式运行由服务器调度；前端只负责输入/保存/开关与展示状态。
const AUTO_MIN_S = 3
const AUTO_MAX_S = 20
// 打开确认弹窗前等配置接口的上限：正常一发几十毫秒；超时就先用兜底文案开，
// 绝不为了等渠道名把按钮卡住，也绝不在弹窗显示后再换文案（会缩一行）。
const CONFIRM_NAMES_WAIT_MS = 600
const AUTO_DEFAULT_S = 10
const AUTO_MAX_FAILS = 3
function clampAutoSeconds (v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return AUTO_DEFAULT_S
  return Math.min(AUTO_MAX_S, Math.max(AUTO_MIN_S, n))
}
const ACTION_DEFS = [
  { key: 'dry-run', label: '试运行', desc: '抓取但不推送', cls: 'btn-secondary' },
  { key: 'run', label: '正式运行一轮', desc: '抓取并真实推送', cls: 'btn-danger-solid' },
  { key: 'check', label: '环境检查', desc: '不抓取不推送', cls: 'btn-secondary' },
  { key: 'notify-test', label: '通知自检', desc: '向全部渠道发一条测试消息（真实推送）', cls: 'btn-secondary' }
]

// ── 组件：危险动作二次确认（v3.307）────────────────────────────────────────
// 「正式运行一轮」「通知自检」会真实推送，之前是蓝色主按钮一键触发、警示文案在页脚
// （桌面隔 1100px、手机更远）。现在弹窗列出真实目的地，默认焦点在「取消」。
// 每个弹窗实例一个唯一标题 id：页签保活后多个页面可能同时留着一个未关闭的弹窗，
// 固定 id 会让无障碍名称重复（Sourcery #271）。
let dialogSeq = 0

function ConfirmDialog ({ open, title, confirmLabel, busy, onConfirm, onCancel, children }) {
  const cancelRef = useRef(null)
  const [titleId] = useState(() => `confirm-title-${++dialogSeq}`)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    const t = setTimeout(() => { if (cancelRef.current) cancelRef.current.focus() }, 0)
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t) }
  }, [open, onCancel])
  if (!open) return null
  return html`<div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onCancel() }}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby=${titleId}>
      <div class="modal-title" id=${titleId}>${title}</div>
      <div class="modal-body">${children}</div>
      <div class="modal-actions">
        <${Button} variant="secondary" buttonRef=${cancelRef} onClick=${onCancel}>取消<//>
        <${Button} variant="danger-solid" disabled=${busy} onClick=${onConfirm}>${confirmLabel}<//>
      </div>
    </div>
  </div>`
}

// 未保存草稿的离开拦截：三选一（取消 / 不保存并离开 / 去保存），默认焦点在取消。
// 由 App 在“过滤页有脏草稿又要切页/后退”时挂出；保存仍走过滤页原来的确认流程。
function LeaveGuardDialog ({ open, count, busy, onCancel, onSave, onDiscard }) {
  const cancelRef = useRef(null)
  const [titleId] = useState(() => `leave-title-${++dialogSeq}`)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    const t = setTimeout(() => { if (cancelRef.current) cancelRef.current.focus() }, 0)
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t) }
  }, [open, onCancel])
  if (!open) return null
  return html`<div class="modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onCancel() }}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby=${titleId}>
      <div class="modal-title" id=${titleId}>有未保存的过滤规则</div>
      <div class="modal-body">
        <div class="fr-dialog-line">当前有 ${count} 个字段还没保存。现在离开，这些修改会丢。</div>
        <div class="modal-note">「去保存」会留在这里并打开保存确认；「不保存并离开」会丢掉这些修改；「取消」继续编辑。</div>
      </div>
      <div class="modal-actions">
        <${Button} variant="secondary" buttonRef=${cancelRef} onClick=${onCancel}>取消<//>
        <${Button} variant="danger-solid" disabled=${busy} onClick=${onDiscard}>不保存并离开<//>
        <${Button} variant="primary" disabled=${busy} onClick=${onSave}>去保存<//>
      </div>
    </div>
  </div>`
}

// ── 触发结果行（v3.317）─────────────────────────────────────────────────────
// 触发返回 202 后旧界面只把面板头徽标从「任务运行中」改回「空闲」：手机上看不出
// 「刚才那次到底成没成」。这里用 App 已有的 runs（被触发那条 run 的结算）拼一行结果，
// 不新增轮询、不引入新接口。文案：上一轮：环境检查 · 成功 · 16:13:11 · 用时 1.2s
// 这一行在面板里**常驻**（空态也占着 min-height），出现时只换文字，按钮位置不动。
function runOutcome (run) {
  if (run.cancelled === true) return { text: '已停止', tone: 'warn' }
  if (run.timedOut) return { text: '超时', tone: 'bad' }
  if (run.exitCode === null) return { text: '已终止', tone: 'bad' }
  if (run.exitCode === 0) return { text: '成功', tone: 'ok' }
  return { text: `失败（退出码 ${run.exitCode}）`, tone: 'bad' }
}

function triggerResultLine (trig, run) {
  if (!trig) return { text: '', tone: '', final: false }
  const label = trig.label || '任务'
  if (!run) return { text: `上一轮：${label} · 已提交 · ${fmtClock(trig.at)}`, tone: '', final: false }
  if (!run.finishedAt) return { text: `上一轮：${label} · 运行中 · ${fmtClock(run.startedAt)}`, tone: '', final: false }
  const o = runOutcome(run)
  return {
    text: `上一轮：${label} · ${o.text} · ${fmtClock(run.finishedAt)} · 用时 ${fmtDuration(run.startedAt, run.finishedAt)}`,
    tone: o.tone,
    final: true
  }
}

function TriggerBar ({ onTriggered, locking, setBusy, auto, runs = [] }) {
  const [err, setErr] = useState('')
  // 最近一次「提交成功」的触发（202 那一刻记下 id/label/at）；结果由 runs 结算。
  const [lastTrigger, setLastTrigger] = useState(null)
  const lastRun = lastTrigger && lastTrigger.id ? runs.find((r) => r.id === lastTrigger.id) : null
  const live = triggerResultLine(lastTrigger, lastRun)
  // 结算过的结果必须留住（Sourcery：Settled outcomes regress）。服务端只保留最近 20 轮，
  // 被触发那条 run 滑出窗口后 lastRun 变 null、live 退回「已提交」——用户会看到一条已经
  // 跑完（成功 · 用时 1.2s）的记录倒退成「已提交」。所以第一次拿到 final 结果时把文案快照
  // 进 lastTrigger（同一个触发的快照不再覆盖），run 消失后继续用快照渲染。
  useEffect(() => {
    if (!live.final || !lastTrigger || lastTrigger.settled) return
    setLastTrigger({ ...lastTrigger, settled: { text: live.text, tone: live.tone } })
  }, [live.final, live.text, live.tone, lastTrigger])
  const result = live.final || !(lastTrigger && lastTrigger.settled) ? live : lastTrigger.settled
  // 错误走固定的 toast（不占布局）：出现/消失都不许把页面顶动，10s 后自动收起，点按也能关。
  useEffect(() => {
    if (!err) return
    const t = setTimeout(() => setErr(''), 10000)
    return () => clearTimeout(t)
  }, [err])
  // 待确认的真实推送动作（null = 无弹窗）；dry-run/check 不弹窗，直接执行。
  const [pending, setPending] = useState(null)
  // 确认框里的渠道名必须来自「当前配置」，不能拿 channel-health 历史凑数——配置改过之后
  // 历史里可能是已删除的渠道（Sourcery 确认框列错渠道）。
  // 文案还必须在弹窗「画出来之前」定稿：先画模糊文案、配置回来再换成真实渠道名，会让
  // 正文少一行 ⇒ 居中的弹窗在打开后缩一截、上下各跳半行（手机上就是「弹一下」）。
  // 所以每次打开都先取一次配置（最多等 CONFIRM_NAMES_WAIT_MS），把渠道名和 pending
  // 一起 set：首帧就是最终文案；拿不到（失败/超时）才用兜底文案，绝不在显示后改。
  const [pendingNames, setPendingNames] = useState(null)
  const confirmSeqRef = useRef(0)
  const askConfirm = useCallback((action) => {
    const seq = ++confirmSeqRef.current
    let timer = 0
    let settled = false
    const open = (names) => {
      if (settled || seq !== confirmSeqRef.current) return
      settled = true
      clearTimeout(timer)
      setPendingNames(names)
      setPending(action)
    }
    timer = setTimeout(() => open(null), CONFIRM_NAMES_WAIT_MS)
    apiGetConfig().then((v) => {
      open(v && v.pushChannels && Array.isArray(v.pushChannels.names) ? v.pushChannels.names : [])
    }).catch(() => open(null))
  }, [])
  const channelText = Array.isArray(pendingNames)
    ? (pendingNames.length > 0 ? pendingNames.join('、') : '未配置任何渠道')
    : '所有已配置渠道（以「配置」页为准）'
  // 自动间隔草稿：输入框可自由键入，保存/开始时统一夹到 3–20；运行状态由 App 持有。
  const [autoDraft, setAutoDraft] = useState(String(auto.interval))
  const [autoSaved, setAutoSaved] = useState(false)
  const autoSavedTimerRef = useRef(0)
  useEffect(() => { setAutoDraft(String(auto.interval)) }, [auto.interval])
  useEffect(() => () => clearTimeout(autoSavedTimerRef.current), [])
  const adjustAuto = (delta) => {
    const next = clampAutoSeconds(Number(autoDraft) + delta)
    setAutoDraft(String(next))
    setAutoSaved(false)
  }
  const flashAutoSaved = () => {
    setAutoSaved(true)
    clearTimeout(autoSavedTimerRef.current)
    autoSavedTimerRef.current = setTimeout(() => setAutoSaved(false), 1500)
  }
  const saveAuto = async () => {
    setErr('')
    try {
      const v = await auto.save(autoDraft)
      setAutoDraft(String(v))
      flashAutoSaved()
    } catch (e) {
      setErr(`保存失败：${e && e.message ? e.message : e}`)
    }
  }
  const stopAuto = async () => {
    setErr('')
    try { await auto.stop() } catch (e) { setErr(`停止失败：${e && e.message ? e.message : e}`) }
  }
  const doTrigger = useCallback(async (action) => {
    setErr('')
    setBusy(true)
    try {
      // 202 响应带首轮 runId（epoch.seq 字符串，v3.299）——交给 App 登记为 busy 归属
      // （G_nv 解锁判据）。Sourcery Medium：makeRunId 返回字符串，这里不能按数字过滤，
      // 否则 busy 状态丢 run 关联（自检 202 的 string id 被误判为 null）。
      const data = action === 'notify-test' ? await triggerNotifyTest() : await trigger(action)
      const runId = data && typeof data.id === 'string' ? data.id : null
      // 结果行与 busy 归属用同一份数据：202 的 id 还没进 runs 时显示「已提交」，
      // 主轮询把它带进 runs 后自动改成「成功/失败 · 用时」。
      const def = ACTION_DEFS.find((a) => a.key === action)
      setLastTrigger({ id: runId, label: def ? def.label : ((data && data.label) || '任务'), at: Date.now() })
      onTriggered(runId)
      // busy 不在此处清零（Sourcery vvo）：202 只代表已受理，子进程还在跑；App 的
      // 「提交轮进历史」派生 + BUSY_FALLBACK 兜底负责解锁。
    } catch (e) {
      // 幂等重放窗命中（服务端 replayBlocked）：首轮已受理，提示后立即刷新历史
      // 并解锁——这与「提交失败」不同，不该锁按钮。
      if (e && e.replayRunId) {
        setErr(`${e.message}（运行 #${e.replayRunId}）`)
        setBusy(false)
        // 重放命中 = 首轮已受理：把那条 run 登记为结果行来源，否则结果行停在空白/上一次的
        // 旧文案（Sourcery：Replay leaves result line stale）。run.id 是字符串，这里统一转。
        const replayDef = ACTION_DEFS.find((a) => a.key === action)
        setLastTrigger({ id: String(e.replayRunId), label: replayDef ? replayDef.label : '任务', at: Date.now() })
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
    if (action === 'run' || action === 'notify-test') askConfirm(action)
    else doTrigger(action)
  }
  // 自动运行是持续真实推送，必须先确认；确认后用当前草稿值启动。
  const askAuto = () => {
    setErr('')
    setAutoDraft(String(clampAutoSeconds(autoDraft)))
    askConfirm('auto')
  }
  const confirmPending = async () => {
    const action = pending
    setPending(null)
    if (action === 'auto') {
      try {
        const v = await auto.start(autoDraft)
        setAutoDraft(String(v))
      } catch (e) {
        setErr(`启动失败：${e && e.message ? e.message : e}`)
      }
      return
    }
    if (action) doTrigger(action)
  }
  return html`<div class="panel trigger-panel">
    <${PanelHead} title="手动触发"
      right=${locking && html`<span class="trigger-busy" role="status" aria-live="polite"
        aria-label="任务进行中，完成后自动解锁" title="任务进行中，完成后自动解锁"><span class="spin"></span><span class="trigger-busy-text">任务进行中…</span></span>`} />
    <div class="btn-row">
      ${ACTION_DEFS.map((a) => html`<div class="btn-item" key=${a.key}>
        <${Button} variant=${a.cls.replace(/^btn-/, '')} disabled=${locking} onClick=${() => ask(a.key)}>${a.label}<//>
        <span class="btn-desc">${a.desc}</span>
      </div>`)}
    </div>
    <div class=${'trigger-result' + (result.tone ? ' ' + result.tone : '')}
      role="status" aria-live="polite" aria-atomic="true">${result.text}</div>
    ${err && html`<div class="trigger-toast" role="alert" title="点按关闭"
      onClick=${() => setErr('')}>${err}</div>`}
    <div class="auto-run">
      <div class="auto-run-head">
        <span class="auto-run-title">自动正式运行</span>
        <span class="auto-run-tag">真实推送</span>
        <span class="auto-run-tag">服务器调度</span>
        ${auto.on && html`<span class="auto-run-live">运行中</span>`}
      </div>
      <div class="auto-run-row">
        <button type="button" class="auto-step" aria-label="减少间隔" onClick=${() => adjustAuto(-1)}>−</button>
        <input class="auto-input" type="number" inputmode="numeric" min=${AUTO_MIN_S} max=${AUTO_MAX_S} step="1"
          aria-label="自动运行间隔（秒）" value=${autoDraft}
          onInput=${(e) => { setAutoDraft(e.target.value); setAutoSaved(false) }}
          onBlur=${() => setAutoDraft(String(clampAutoSeconds(autoDraft)))} />
        <span class="auto-unit">秒</span>
        <button type="button" class="auto-step" aria-label="增加间隔" onClick=${() => adjustAuto(1)}>+</button>
        <${Button} variant="secondary" onClick=${saveAuto}>保存<//>
        ${auto.on
          ? html`<${Button} variant="danger" onClick=${stopAuto}>停止<//>`
          : html`<${Button} variant="danger-solid" onClick=${askAuto}>开始<//>`}
      </div>
      <div class="auto-run-note">每轮结束后等待 ${auto.interval} 秒；可调 ${AUTO_MIN_S}–${AUTO_MAX_S} 秒；由服务器常驻运行，关闭页面、切后台、锁屏都不影响，点「停止」才停；连续失败 ${AUTO_MAX_FAILS} 次会自动停止。</div>
      ${auto.on && html`<div class="auto-run-status">${auto.nextAt > 0 ? `下一轮 ${Math.max(0, Math.ceil((auto.nextAt - auto.now) / 1000))} 秒` : '本轮进行中'} · 已自动运行 ${auto.runs} 轮</div>`}
      ${!auto.on && html`<div class="auto-run-status">${autoSaved ? '间隔已保存' : ''}</div>`}
      ${auto.err && html`<${Hint} tone="error">${auto.err}<//>`}
    </div>
    <${ConfirmDialog} open=${pending !== null}
      title=${pending === 'run' ? '确认正式运行一轮？' : pending === 'auto' ? '确认开启自动正式运行？' : '确认发送通知自检？'}
      confirmLabel=${pending === 'run' ? '确认真实推送' : pending === 'auto' ? '开始自动运行' : '确认发送'}
      busy=${locking} onConfirm=${confirmPending} onCancel=${() => setPending(null)}>
      ${pending === 'run'
        ? html`<div>将抓取线报并<b>真实推送</b>到：${channelText}。</div><div class="modal-note">推送发出后无法撤回；只想验证抓取流程请用「试运行」（不推送）。</div>`
        : pending === 'auto'
          ? html`<div>将每轮结束后等待 <b>${clampAutoSeconds(autoDraft)} 秒</b>，自动再次<b>正式运行</b>（真实推送）到：${channelText}。</div><div class="modal-note">最低 3 秒、最高 20 秒；运行在服务器上，关闭页面/切后台/锁屏都不影响；点「停止」才停；连续失败 3 次会自动停止。</div>`
          : html`<div>将向全部渠道发送一条<b>真实测试消息</b>：${channelText}。</div><div class="modal-note">这条消息会出现在你的微信/推送客户端里。</div>`}
    <//>
  </div>`
}

// ── 组件：运行历史 ──────────────────────────────────────────────────────────
// 点「日志」时等详情接口的上限（同确认弹窗的 CONFIRM_NAMES_WAIT_MS 口径）：
// 正常一发几十毫秒；超时就先用「加载中…」开框，绝不把点击卡住。
const RUN_LOG_WAIT_MS = 600
function RunsPanel ({ runs, status = 'ok', pollMs, onRefresh, active = true }) {
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

  // 切换目标 run 时清旧详情（Sourcery G_oi + Old-logs-flash）：useEffect 在渲染后
  // 才跑，「新 openId + 旧 detail」会闪一帧。渲染期同步判定：detail.runId 与当前 openId
  // 不符就不显示（下方 logpre 用 detailForOpen 而非裸 detail）。effect 仍负责清状态。
  // v3.313：点「日志」改为先取详情再开框（见 openLog），预取的 detail 已属于新 openId，
  // 这里必须原样保留——无条件 setDetail(null) 会把预取结果当场抹掉，框又退回「加载中…」。
  useEffect(() => {
    setDetail((prev) => (prev !== null && prev.id === openId ? prev : null))
    setDetailErr('')
  }, [openId])
  // openRun/openActive 先声明后使用（v3.300 3.1 §1.9b）：详情跟随 effect 依赖 openActive，
  // 须在 effect 之前声明（渲染逻辑零变化）。
  const openRun = openId !== null ? runs.find((r) => r.id === openId) : null
  const openActive = !!(openRun && !openRun.finishedAt)
  // 打开日志框：先取详情、再与 openId 同一批 set，让首帧就是最终日志（v3.313）。
  // 旧实现先 setOpenId、由 effect 再拉详情：框首帧只有「加载中…」（实测高 89px），
  // 详情回来撑成整段（366px、页高 +277px）——手机上就是先闪一下再跳一截。
  // 与确认弹窗同口径：最多等 RUN_LOG_WAIT_MS；拿不到才用占位符开框，开框后原请求
  // 到达只回填正文（不再重开）。seq 作废「先点 A 再点 B」时迟到的 A；openingRef 防连点
  // 同一行反复起请求（每次重起都会把 600ms 的上限重新计时，等于越点越慢）。
  const openSeqRef = useRef(0)
  const openingRef = useRef(null)
  // 预取成功的详情只给「打开它的那次 effect」用一次：之后 openActive 翻转等重跑
  // 必须重新取快照，否则拿旧 outputTotalLength 当游标会把已有增量再推一遍。
  const seedRef = useRef(null)
  // 关闭必须同时作废在飞的预取：否则「点 B → 关闭」后 B 的详情回来还会把框打开。
  const closeLog = () => {
    openSeqRef.current++
    openingRef.current = null
    setOpenId(null)
  }
  const openLog = (id) => {
    if (openId === id) {
      closeLog()
      return
    }
    if (openingRef.current === id) return
    const seq = ++openSeqRef.current
    openingRef.current = id
    let timer = 0
    let opened = false
    const openWith = (d) => {
      // 代次守卫必须是第一句：过期响应不得在任何 set 之前漏过去。
      if (seq !== openSeqRef.current) return
      clearTimeout(timer)
      openingRef.current = null
      if (d) setDetail(d)
      setDetailErr('')
      if (opened) return // 超时已开框：晚到的详情只回填正文，不再 setOpenId
      opened = true
      if (d) seedRef.current = { id, detail: d }
      setOpenId(id)
    }
    // 正常一发几十毫秒；超时也不能把点击卡住——照旧用「加载中…」开框。
    timer = setTimeout(() => openWith(null), RUN_LOG_WAIT_MS)
    apiGetRunDetail(id).then((d) => openWith(d)).catch(() => openWith(null))
  }
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
    // pollMs=0 只关掉 interval；页签保活后隐藏的概览/日志仍会打开 SSE 或拉快照。
    // active=false 直接不建流：切走即断开，切回 effect 重跑会重新取快照/重连。
    if (openId === null || !active) return undefined
    // 预取成功时本轮已有完整快照：不再重复请求（慢网下第二次失败会把有效日志盖成
    // 「加载失败」）。seed 只吃一次——之后 effect 因 openActive 翻转等重跑时必须
    // 重新取快照，不能拿旧 outputTotalLength 当游标（会把已追加的增量再推一遍）。
    const seed = seedRef.current !== null && seedRef.current.id === openId ? seedRef.current.detail : null
    seedRef.current = null
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
      // 预取已拿到快照：不再发第二个详情请求（失败会覆盖有效日志）。
      if (seed === null) startPolling()
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
    const startStream = (d) => {
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
    }
    // 预取快照直接建流（省一次请求，也避免慢网下第二次失败覆盖有效日志）。
    if (seed !== null) startStream(seed)
    else apiGetRunDetail(openId).then(startStream).catch(() => { if (!dead) startPolling() }) // 快照失败 → 回退轮询（既有能力兜底）
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (es !== null) es.close()
      if (pollTimer !== null) clearInterval(pollTimer)
    }
  }, [openId, openActive, pollMs, active])

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
              <${Button} variant="ghost" onClick=${() => openLog(r.id)}>
                ${openId === r.id ? '收起' : '日志'}
              <//>
            </td>
          </tr>`)}
        </tbody>
      </table></div>`}
    ${openId !== null && html`<div class="logbox">
      <div class="logbox-head">
        <span>运行 #${openId} 输出${openActive ? '（实时跟随）' : ''}</span>
        <${Button} variant="ghost" onClick=${closeLog}>关闭<//>
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
// 逐轮历史的两份服务端快照：仅运行（excludeCancelled）与全量（全部/只看异常共用）。
const RUN_SNAP_KEY = (m) => (m === 'runs' ? 'runs' : 'all')

// ── 列表落点（v3.320）──────────────────────────────────────────────────────
// 推送记录 / 逐轮历史的列表都比一屏长，分页器在列表底部：用户翻页时人已经在底部，
// 新一页更短时浏览器会把 scrollY 夹进新的可滚动范围（document.scrollHeight 变小），
// 于是停在短页的中间甚至末行，看不到第一行。搜索落地同理（结果集变小）。
// 统一落点 = 列表容器顶部 − 吸顶页签高度 + 8，再夹进
// document.scrollHeight − innerHeight；返回 null 表示别滚（未挂载 / 面板隐藏时
// rect 全为 0 / 列表不在屏幕上），调用方据此跳过。
// pad 用 .tabs 的 height 而不是 bottom：页签还没吸顶时 bottom 会多算它自己的页面
// 偏移，落点比过滤定位/搜索门的「列表顶」偏低一个页签的距离。
function listLandTarget (el) {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!(rect.height > 0)) return null
  const tabs = document.querySelector('.tabs')
  const pad = (tabs ? tabs.getBoundingClientRect().height : 0) + 8
  const top = rect.top + window.scrollY - pad
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  return Math.max(0, Math.min(top, max))
}

// 落点请求在飞时，只有用户自己滚动才撤销；浏览器夹取/滚动锚定不会触发这些事件。
function useLandScrollCancel (landRef, movedRef) {
  useEffect(() => {
    const mark = () => { if (landRef.current) movedRef.current = true }
    const keys = ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']
    const onKey = (e) => { if (keys.includes(e.key)) mark() }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchmove', mark, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchmove', mark)
      window.removeEventListener('keydown', onKey)
    }
  }, [landRef, movedRef])
}

function RunHistoryPanel ({ onOpenLog, active = true }) {
  const [size, setSize] = useState(10)
  // 默认只看真实轮次：取消留痕是操作审计，不该在每次打开历史时占据一半行。
  const [mode, setMode] = useState('runs')
  // v3.326：单日筛选升级为日期区间（同一个 DateRange 组件，复用组件而不是再造一个原生 date）。
  const [runRange, setRunRange] = useState(EMPTY_RANGE)
  const runRangeActive = DAY_KEY_RE.test(runRange.from) && DAY_KEY_RE.test(runRange.to)
  const [pageNo, setPageNo] = useState(1)
  const [data, setData] = useState(null)
  // data 属于哪一档（runs = 仅运行，all = 全量，供 全部/只看异常 共用）。切模式时
  // data 可能与 mode 不同步：只用来渲染手里真正有的那一档，绝不把另一档的数据硬套
  // 新筛选（v3.326）。
  const [dataMode, setDataMode] = useState('runs')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // 没有目标快照时的等待态（v3.326 评审）：选中态与列表都先不动，数据回来一次性换。
  // 快速回来（<150ms）完全不闪；更慢才在点中的胶囊上转圈。
  const [pendingMode, setPendingMode] = useState(null)
  const [pendingBusy, setPendingBusy] = useState(false)
  const pendingSeqRef = useRef(0)
  const pendingTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(pendingTimerRef.current), [])
  // v3.318：点「日志」先在原页取快照，150ms 内没回来才在按钮上转圈——快请求不闪转圈；
  // 慢请求（日志到 1 MiB 时）也不会看起来「没点上」。失败就地报错，不切页。
  const [jumpBusy, setJumpBusy] = useState('')
  const [jumpErr, setJumpErr] = useState('')
  const jumpSeqRef = useRef(0)
  const jumpTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(jumpTimerRef.current), [])
  const seqRef = useRef(0)
  // v3.320：分页/筛选后把列表顶部拉回页签下沿的落点旗（见 listLandTarget）。
  // 只有用户主动改页/改每页/改分类/改时间时置位；纯 load() 与自动刷新不置。
  const listRef = useRef(null)
  const landRef = useRef(false)
  // 置旗那一刻的位置与数据：模式切换要等自动加载的响应落地才落点；
  // 请求飞行期间用户自己滚走（非浏览器夹取）则撤销这次落点。
  const armedDataRef = useRef(undefined)
  const armedErrRef = useRef('')
  const userMovedRef = useRef(false)
  // 「已滚进列表」门：列表顶还在页签下沿之下（用户停在顶部改筛选）时不置旗——
  // 否则会把列表顶拽到页签下沿，工具条被顶出视口。口径与 listLandTarget 一致
  // （.tabs 实测高度 + 8）。
  const armLand = () => {
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!(rect.height > 0)) return
    const tabs = document.querySelector('.tabs')
    const tabsH = tabs ? tabs.getBoundingClientRect().height : 0
    const listTop = rect.top + window.scrollY - tabsH - 8
    if (!(window.scrollY > listTop)) return
    landRef.current = true
    armedDataRef.current = data
    armedErrRef.current = err
    userMovedRef.current = false
  }
  useLandScrollCancel(landRef, userMovedRef)

  // 两种筛选各留一份快照：服务端口径不同（仅运行 = excludeCancelled，最近 200 个真轮次）。
  // 切「只看异常」若拿「仅运行」的快照按异常过滤，会先算成「只看异常 2 / 共 2 条」，
  // 等请求回来再跳成 48 条——手机上就是约 130ms 的闪跳（v3.326 录屏实测 4 帧）。
  // 所以另一档在后台预取，切过去首帧直接用目标快照；目标快照还没到就保持旧列表，
  // 绝不用另一档的数据重算。「全部」与「只看异常」共用同一份全量快照。
  const snapsRef = useRef({ runs: null, all: null })
  const preSeqRef = useRef({ runs: 0, all: 0 })
  const quietNextRef = useRef(false)
  const fetchSnap = useCallback((k) => {
    const seq = ++preSeqRef.current[k]
    return apiGetRunHistory({ limit: RUN_FETCH_LIMIT, excludeCancelled: k === 'runs' })
      .then((d) => {
        if (seq === preSeqRef.current[k]) snapsRef.current[k] = d
        return d
      })
  }, [])
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    const m = mode
    const k = RUN_SNAP_KEY(m)
    // 切到已有快照的档位时静默刷新：不置 loading（分页按钮不闪禁用态），
    // 首帧已由 changeMode 用快照画好。
    const quiet = quietNextRef.current
    quietNextRef.current = false
    // 另一档同时预取：每次刷新都补一次，切过去看到的是新快照而不是陈的。
    fetchSnap(k === 'runs' ? 'all' : 'runs').catch(() => {})
    // 静默刷新要顺手清掉可能还挂着的 loading（切档会顶掉上一发非静默请求，
    // 那发的 finally 因请求号过期不会再来清，否则分页按钮会一直禁用）。
    setLoading(!quiet)
    try {
      const d = await fetchSnap(k)
      if (seq !== seqRef.current) return
      setData(d)
      setDataMode(k)
      setErr('')
    } catch (e) {
      if (seq === seqRef.current) setErr(`加载失败：${e.message}`)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [mode, fetchSnap])
  // 保活后概览切回来时补拉一次；离开概览不拉。data 保留，不出现加载占位。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)

  const all = data && data.status === 'ok' && Array.isArray(data.items) ? data.items : []
  // 全量快照才含取消留痕：仅运行档算出来是假的 2（本档不显示数字，仍保险）。
  const fullSnap = dataMode === 'all'
  const issueCount = fullSnap ? filterRunItems(all, { mode: 'issue' }).length : null
  const runsCount = filterRunItems(all, { mode: 'runs' }).length
  // 切档是原子的（mode 变化时 data 已换成同一档），直接按 mode 过滤即可。
  const filtered = filterRunItems(all, { mode })
    .filter((r) => inDayRange(typeof r.at === 'string' ? r.at.slice(0, 10) : '', runRange))
  const pages = Math.max(1, Math.ceil(filtered.length / size))
  const current = Math.min(pageNo, pages)
  // 数据变少（筛选/刷新）时把页码收回有效区间；不在渲染期 setState。
  useEffect(() => { if (pageNo > pages) setPageNo(pages) }, [pageNo, pages])
  const shown = filtered.slice((current - 1) * size, current * size)
  const changeSize = (n) => {
    if (n === size) return // 值没变不置旗：旗子悬着会在下一次响应落地时替旧操作搬位置
    armLand()
    setSize(n)
    setPageNo(1)
  }
  // refresh() 是「重新加载当前页」，不搬滚动位置；只有用户主动改页/改每页/改分类/
  // 改日期才置落点旗。
  const refresh = () => { setPageNo(1); load().catch(() => {}) }
  const changeDay = (v) => {
    // 值守卫（同 MiniSelect）：区间没变就不回调，避免一次无意义的筛选重拉。
    if (v.from === runRange.from && v.to === runRange.to) return
    armLand()
    setRunRange(v)
    setPageNo(1)
  }
  const changeMode = (m) => {
    if (m === pendingMode) return // 已在等这个档位，别重复发请求
    if (m === mode) {
      if (pendingMode === null) return // 已选中的 chip 再点一次不搬位置
      // 点回当前档 = 取消还在路上的等待，留在原视图。
      clearTimeout(pendingTimerRef.current)
      pendingSeqRef.current++
      setPendingMode(null)
      setPendingBusy(false)
      return
    }
    const key = RUN_SNAP_KEY(m)
    const cached = snapsRef.current[key]
    clearTimeout(pendingTimerRef.current)
    const seq = ++pendingSeqRef.current // 取消上一次还没落地的等待
    seqRef.current++ // 作废还在飞的旧档刷新（晚到的响应会把新档数据盖掉）
    armLand() // 等待期间用户自己滚动会撤销落点
    if (cached !== null) {
      // 目标快照已在：同一批换列表与选中态，首帧就是目标数据。
      setPendingMode(null)
      setPendingBusy(false)
      setData(cached)
      setDataMode(key)
      setMode(m)
      setPageNo(1)
      quietNextRef.current = true
      return
    }
    // 没有目标快照：选中态与列表都先不动，等数据回来一次性换——绝不把旧档数据
    // 挂到新筛选下。150ms 内回来完全不闪，更慢才在点中的胶囊上转圈。
    setPendingMode(m)
    pendingTimerRef.current = window.setTimeout(() => {
      if (seq === pendingSeqRef.current) setPendingBusy(true)
    }, 150)
    fetchSnap(key).then((d) => {
      if (seq !== pendingSeqRef.current) return
      clearTimeout(pendingTimerRef.current)
      setPendingBusy(false)
      setPendingMode(null)
      setData(d)
      setDataMode(key)
      setMode(m)
      setPageNo(1)
      quietNextRef.current = true
    }).catch((e) => {
      if (seq !== pendingSeqRef.current) return
      clearTimeout(pendingTimerRef.current)
      setPendingBusy(false)
      setPendingMode(null)
      landRef.current = false // 失败不落点
      setErr(`加载失败：${e.message}`)
    })
  }
  const goPage = (n) => {
    if (n === current) return // 目标页 = 当前页：不置旗（否则残留的旗会替下一次操作落点）
    armLand()
    setPageNo(n)
  }
  // v3.320：在 paint 前落点（旧版换页后页高变化，浏览器把 scrollY 夹到新的上限，
  // 停在短页中间）。listLandTarget 在面板隐藏/列表不在时返回 null ⇒ 不滚。
  // 消费即清旗：返回 null 也不再重试（否则旗子会挂到下一次操作上）。
  useLayoutEffect(() => {
    if (!landRef.current) return
    landRef.current = false
    // 请求飞行期间用户自己滚动时撤销落点，别把人拽回列表顶（夹取/锚定不算）。
    if (userMovedRef.current) return
    const y = listLandTarget(listRef.current)
    if (y === null) return
    window.scrollTo(0, y)
  }, [data, loading, err, pageNo, size, mode, runRange.from, runRange.to])
  const jumpLog = (r) => {
    if (!onOpenLog || typeof r.at !== 'string' || r.at.length < 10) return
    const key = `${r.at}-${r.lineNo}`
    const seq = ++jumpSeqRef.current
    setJumpErr('')
    // 连点另一行时先撤掉上一行的转圈；点同一行则保持，避免转圈闪一下。
    setJumpBusy((prev) => (prev === '' || prev === key ? prev : ''))
    // 150ms 内回来的请求不显示忙碌（否则一闪而过的转圈比不转还烦）。
    clearTimeout(jumpTimerRef.current)
    jumpTimerRef.current = window.setTimeout(() => {
      if (seq === jumpSeqRef.current) setJumpBusy(key)
    }, 150)
    // 单轮「日志」= 看这一天的完整日志（含摘要/告警/错误）；带 focus 让日志页把
    // 点中的那一轮居中高亮，而不是丢进当天 14 条一模一样的时间戳里。
    Promise.resolve(onOpenLog({ q: r.at.slice(0, 10), mode: 'all', focus: r.at }))
      .then((res) => {
        if (seq !== jumpSeqRef.current) return
        if (res && res.ok === false && !res.canceled) {
          setJumpErr(`日志加载失败：${res.error || '请重试'}`)
        }
      })
      .catch((e) => {
        if (seq === jumpSeqRef.current) setJumpErr(`日志加载失败：${e && e.message ? e.message : e}`)
      })
      .finally(() => {
        if (seq !== jumpSeqRef.current) return
        clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = 0
        setJumpBusy('')
      })
  }
  return html`<div class="panel">
    <${PanelHead} title="逐轮运行历史"
      sub=${err
        ? 'run.log 读取失败'
        : (data
            ? `run.log 摘要逐轮 · 最近 ${all.length} 轮` + (data.truncated ? ' · 日志已轮转/超窗，更早轮次已丢失' : '') +
              (runRangeActive ? ` · 日期 ${runRange.from} ~ ${runRange.to}（${filtered.length} 轮）` : '')
            : 'run.log 摘要逐轮 · 加载中…')}
      right=${html`<div class="toolbar">
        <${MiniSelect} value=${String(size)} ariaLabel="每页显示条数"
          options=${RUN_PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
          onChange=${(v) => changeSize(Number(v))} />
        <${Button} variant="ghost" onClick=${refresh} disabled=${loading}>刷新<//>
      </div>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${jumpErr && html`<${Hint} tone="error">${jumpErr}<//>`}
    ${data && data.status === 'ok' && html`<div class="run-tools">
      <div class="log-chips" role="group" aria-label="逐轮筛选">
        <button type="button" class=${'log-chip' + (mode === 'all' ? ' on' : '')}
          aria-busy=${pendingMode === 'all' && pendingBusy ? 'true' : 'false'}
          aria-pressed=${mode === 'all' ? 'true' : 'false'} onClick=${() => changeMode('all')}>${mode === 'all' && fullSnap ? `全部 ${all.length}` : '全部'}</button>
        <button type="button" class=${'log-chip' + (mode === 'runs' ? ' on' : '')}
          aria-busy=${pendingMode === 'runs' && pendingBusy ? 'true' : 'false'}
          aria-pressed=${mode === 'runs' ? 'true' : 'false'} onClick=${() => changeMode('runs')}>仅运行 ${runsCount}</button>
        <button type="button" class=${'log-chip' + (mode === 'issue' ? ' on' : '')}
          aria-busy=${pendingMode === 'issue' && pendingBusy ? 'true' : 'false'}
          aria-pressed=${mode === 'issue' ? 'true' : 'false'} onClick=${() => changeMode('issue')}>${mode === 'runs' || issueCount === null ? '只看异常' : `只看异常 ${issueCount}`}</button>
      </div>
      <${DateRange} value=${runRange} onChange=${changeDay} label="按日期筛选轮次" />
      <span class="run-tools-note">${mode === 'issue' ? '只显示失败、中断或取消的轮次' : (mode === 'runs' ? '不显示取消留痕；切「全部」可查' : '点行尾「日志」跳到该日日志')}</span>
    </div>`}
    ${data && data.status && data.status !== 'ok' && html`<div class="empty">run.log${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}</div>`}
    ${!data && !err && html`<div class="empty">加载中…</div>`}
    ${data && data.status === 'ok' && html`<div class="runs-scroll" ref=${listRef}>
      ${shown.length > 0
        ? html`<table class="runs-table">
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
            <button type="button" class="row-link" disabled=${!r.at}
              aria-busy=${jumpBusy === `${r.at}-${r.lineNo}` ? 'true' : 'false'}
              aria-label=${jumpBusy === `${r.at}-${r.lineNo}` ? '日志加载中' : '查看该日日志'}
              onClick=${() => jumpLog(r)}>${jumpBusy === `${r.at}-${r.lineNo}`
                ? html`<span class="row-spin" aria-hidden="true"></span>`
                : '日志'}</button></td>
        </tr>`)}
      </tbody>
    </table>`
        : html`<div class="empty">${all.length === 0 ? '日志尾窗内没有摘要行' : '没有匹配的轮次'}</div>`}
    </div>`}
    ${filtered.length > 0 && html`<div class="pager">
      <${Button} disabled=${current <= 1 || loading} onClick=${() => goPage(1)}>« 首页<//>
      <${Button} disabled=${current <= 1 || loading} onClick=${() => goPage(current - 1)}>上一页<//>
      <span class="pager-info">第 ${current} / ${pages} 页 · 共 ${filtered.length} 条</span>
      <${Button} disabled=${current >= pages || loading} onClick=${() => goPage(current + 1)}>下一页<//>
      <${Button} disabled=${current >= pages || loading} onClick=${() => goPage(pages)}>末页 »<//>
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
function usePanelLoader (apiFn, onLoaded, initialData = null) {
  // initialData：跳转前已取到的快照（v3.318）。给它就把首帧定稿，挂载后不再立刻重拉。
  const [data, setData] = useState(initialData)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // v3.320：结算代数——每次最新一次 load 收尾（成功或失败）都 +1，与 setLoading(false) 同批。
  // 失败时只写 err、data 保持旧值，调用方只比 data 引用会永远等不到「这次响应落地」；
  // 有了代数就能区分「还没结算」与「结算完但数据没变」，错误路径的旗子才清得掉。
  const [settleTick, setSettleTick] = useState(0)
  const seqRef = useRef(0) // 竞态守卫：只应用「最新一次 load」的响应（审查 Sourcery PR#227）
  const mountedRef = useRef(true) // 卸载后旧请求仍可能回包：不得再写父页时间戳（PR#253）
  useEffect(() => () => { mountedRef.current = false }, [])
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const d = await apiFn()
      if (seq !== seqRef.current || !mountedRef.current) return false // 已有更新的请求或面板已卸载，本次响应作废
      setData(d)
      setErr('')
      if (typeof onLoaded === 'function') onLoaded(Date.now())
      return true
    } catch (e) {
      if (seq !== seqRef.current || !mountedRef.current) return false
      setErr(`加载失败：${e.message}`)
      return false
    } finally {
      if (seq === seqRef.current && mountedRef.current) {
        setSettleTick((t) => t + 1)
        setLoading(false)
      }
    }
  }, [apiFn, onLoaded])
  return { data, err, load, loading, settleTick }
}

// 页签保活 + 首屏预加载：面板即使还没被点开（active=false）也先拉一次，
// 刷新网页后第一次点页签时数据已经在手里，不会闪「加载中…」；之后离开不拉，
// 再切回才补一次（active 由 false 变 true）。
// queue=true 用于日志这种自带互斥的 loader（在飞时排队，而不是丢掉这次刷新）。
function usePanelAutoLoad (active, load, { queue = false } = {}) {
  const seenRef = useRef(null)
  const loadRef = useRef(load)
  const pendingRef = useRef(false)
  const loadedAtRef = useRef(0)
  useEffect(() => {
    const first = seenRef.current === null
    const becameActive = active && seenRef.current === false
    const loadChanged = loadRef.current !== load
    seenRef.current = active
    loadRef.current = load
    if (!active && !first) return
    if (!first && !becameActive && !loadChanged) return
    // 首次点开时若预加载还在飞、或刚回来不到 3s，直接用手里的/路上的数据，
    // 不再发第二发把预加载响应顶掉（Sourcery #272）。更久才点开则补一次新鲜的。
    if (becameActive && (pendingRef.current || (loadedAtRef.current && Date.now() - loadedAtRef.current < 3000))) return
    if (pendingRef.current && !loadChanged) return
    pendingRef.current = true
    const p = queue ? load(true) : load()
    Promise.resolve(p).then(() => { loadedAtRef.current = Date.now() }).catch(() => {}).finally(() => { pendingRef.current = false })
  }, [active, load, queue])
}

// ── 下拉刷新（v3.330）──────────────────────────────────────────────────────
// Chrome 的原生下拉刷新会整页重载：文档重建 → 首帧必然重新渲染，数据回得越快越像
// 「闪一下」。这里关掉原生手势（CSS overscroll-behavior-y: contain），改成页面内刷新：
// 下拉立即出指示条，松手调各面板的 loader，数据回来一次性换，不重建页面、不回顶。
const PULL_EVENT = 'xbk-pull-refresh'
const PULL_TRIGGER = 56 // 松手阈值（CSS px，手指位移按 0.5 倍阻尼折算）
const PULL_MAX = 84
const PULL_MIN_BUSY_MS = 450 // 再快也让「正在刷新…」停留一下，避免又变成一闪
// 切后台/锁屏/切走 App 很久再回来：页面里的数据已经过期了，但浏览器不会替我们重拉。
// 回到前台时若距上次刷新超过这个间隔，就静默补一轮（不显示「正在刷新…」，不重建页面）。
const VISIBLE_STALE_MS = 30000

function usePollReload (active, pollTick, fn) {
  // v3.349：轮询重拉的单飞闸——上一拍还没回来就跳过这一拍。慢接口下每个新请求都会把
  // 上一个响应的 seq 作废（usePanelLoader 的竞态守卫），响应慢过间隔就永远应用不上，
  // 页面看着「在刷新」其实数据不动（Sourcery #303 M3）。
  const fnRef = useRef(fn)
  fnRef.current = fn
  const busyRef = useRef(false)
  useEffect(() => {
    if (!active || !(pollTick > 0) || busyRef.current) return
    busyRef.current = true
    Promise.resolve()
      .then(() => fnRef.current())
      .catch(() => {})
      .finally(() => { busyRef.current = false })
  }, [pollTick, active])
}

// 面板侧：当前页签激活时订阅全局下拉刷新，把自己的 loader 交给 App 一起等。
// 用 ref 存 loader，避免每次渲染换函数导致反复重订阅。
function usePullRefresh (active, fn) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!active) return undefined
    const onPull = (e) => {
      const p = fnRef.current()
      if (e && e.detail && Array.isArray(e.detail.waits) && p && typeof p.then === 'function') {
        e.detail.waits.push(p)
      }
    }
    window.addEventListener(PULL_EVENT, onPull)
    return () => window.removeEventListener(PULL_EVENT, onPull)
  }, [active])
}

// App 侧：手势状态机。只在页面顶部（scrollY<=0）开始跟踪；竖直位移压 0.5 倍做阻尼。
function usePullToRefresh (onRefresh, enabled = true) {
  const [state, setState] = useState('idle') // idle | pull | ready | busy
  const ref = useRef({ y0: 0, x0: 0, dy: 0, tracking: false, busy: false, lock: false })
  useEffect(() => {
    if (!enabled) return undefined
    const stop = () => { ref.current.tracking = false; ref.current.dy = 0 }
    const idle = () => setState((s) => (s === 'busy' ? s : 'idle'))
    // 手指落在自己滚动的容器里（日志框、列表）时，先让它按原生滚动走；
    // 只有当那个容器已经在顶部，才算「整页下拉」。
    const inScrolled = (touch) => {
      let el = touch && touch.target
      while (el && el !== document.documentElement) {
        if (el.scrollTop > 0 && /(auto|scroll)/.test(window.getComputedStyle(el).overflowY)) return true
        el = el.parentElement
      }
      return false
    }
    const onStart = (e) => {
      const t = e.touches
      if (ref.current.busy || !t || t.length !== 1 || window.scrollY > 0 || inScrolled(t[0])) return
      ref.current.y0 = t[0].clientY
      ref.current.x0 = t[0].clientX
      ref.current.dy = 0
      ref.current.tracking = true
      ref.current.lock = false
    }
    const onMove = (e) => {
      const r = ref.current
      if (!r.tracking || r.busy || r.lock) return
      const t = e.touches
      // 多指按下（缩放/误触）：本次手势作废，松手也不刷新。
      if (!t || t.length !== 1) { r.lock = true; stop(); idle(); return }
      const dy = t[0].clientY - r.y0
      const dx = t[0].clientX - r.x0
      // 横滑、上滑、或已经离开顶部：本次手势不再当下拉，等下一次触摸。
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) { r.lock = true; stop(); idle(); return }
      r.dy = dy
      setState(Math.min(PULL_MAX, dy * 0.5) >= PULL_TRIGGER ? 'ready' : 'pull')
    }
    const onEnd = () => {
      const r = ref.current
      if (!r.tracking) return
      const armed = r.dy * 0.5 >= PULL_TRIGGER
      stop()
      if (!armed) { idle(); return }
      r.busy = true
      setState('busy')
      const t0 = Date.now()
      const settle = (did) => {
        // 当前页没有可刷新的面板（返回 false）：立刻收起，别假装刷了一下。
        const hold = did === false ? 0 : Math.max(0, PULL_MIN_BUSY_MS - (Date.now() - t0))
        setTimeout(() => { r.busy = false; setState('idle') }, hold)
      }
      // 微任务里再开跑：先让 busy 这一帧画出来，再发请求（不然快速响应会直接跳回 idle）。
      Promise.resolve().then(onRefresh).then(settle, () => settle(true))
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    // touchcancel = 手势被打断（来电、系统手势），不是「松手」：只复位，不刷新。
    const onCancel = () => { stop(); idle() }
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [enabled, onRefresh])
  return { state }
}

// v3.331：状态写在顶栏「数据截至」这一行（.sync），不做浮层——浮层会盖住标题，
// 手机上「正在刷新…」正好压在 xbk-push 控制台上。
function PullRefreshStatus ({ state }) {
  const label = state === 'busy' ? '正在刷新…' : state === 'ready' ? '松开刷新' : '下拉刷新'
  return html`<span class=${'ptr-text ' + state} role="status" aria-live="polite">
    <span class="ptr-ring" aria-hidden="true"></span>${label}
  </span>`
}

// 慢加载才亮「更新中…」：本地缓存命中时 loading 只存在十几毫秒（实测 512ms→529ms），
// 文案跟着切两次就是一闪。超过 600ms 还没回来才算真的慢，这时提示才有意义。
function useSlowFlag (on, delay = 600) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!on) { setSlow(false); return undefined }
    const t = setTimeout(() => setSlow(true), delay)
    return () => clearTimeout(t)
  }, [on, delay])
  // 完成当帧 state 还没被 effect 清掉，这里用 on 兜底，否则会多渲染一帧「更新中…」。
  return slow && on
}

// 趋势天数选择器固定选项（与服务端白名单 TREND_DAYS_ALLOWED 对齐；14 为默认省略参数）
const TREND_DAYS = [14, 30, 60]

function TrendsPanel ({ active = true }) {
  const [days, setDays] = useState(TREND_DAYS[0])
  const [range, setRange] = useState(EMPTY_RANGE)
  const rangeActive = DAY_KEY_RE.test(range.from) && DAY_KEY_RE.test(range.to)
  const fetchTrends = useCallback(
    () => apiGetTrends(rangeActive ? { from: range.from, to: range.to } : { days }),
    [days, rangeActive, range.from, range.to])
  const { data: trends, err, load } = usePanelLoader(fetchTrends)
  // 保活后概览切回来时补拉一次；离开概览不拉。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // 展示口径只认「响应自带的 days」：切窗口后旧响应未替换（请求中/失败）时，
  // 标题与合计必须跟随旧窗口的数据，不能拿着旧数据标新窗口。
  // 区间模式下标题显示实际区间（服务端回显，含被 92 天上限截断后的真实起点）。
  const shownRange = trends && typeof trends.from === 'string' && trends.from !== '' ? `${trends.from} ~ ${trends.to}` : ''
  const shownDays = shownRange !== ''
    ? null
    : (trends && Number.isSafeInteger(trends.days) && TREND_DAYS.includes(trends.days)
        ? trends.days
        : (trends ? null : days)) // 尚无任何响应时才用当前选择器值占位
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
  // 对齐必须在绘制前完成：切窗口时一组新列在同一个 commit 里换进来，
  // 若放到 useEffect（绘制后）再对齐，会先画出一帧「沿用旧 scrollLeft、指向窗口最早几天」的
  // 空图表，下一帧才跳回最右——手机上看就是趋势模块「闪一下」（v3.315）。
  useLayoutEffect(() => {
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
    <${PanelHead} title=${shownRange ? `运行趋势（${shownRange}）` : (shownDays ? `近 ${shownDays} 日运行趋势` : '运行趋势')}
      afterTitle=${html`<div class="toolbar">
        <${MiniSelect} value=${rangeActive ? '__range' : String(days)} ariaLabel="趋势窗口天数"
          options=${[
            ...(rangeActive ? [{ value: '__range', label: '自定义区间' }] : []),
            ...TREND_DAYS.map((d) => ({ value: String(d), label: `${d} 日` }))
          ]}
          onChange=${(v) => { if (v === '__range') return; setRange(EMPTY_RANGE); setDays(Number(v)) }} />
        <${DateRange} value=${range} label="趋势日期区间"
          onChange=${(r) => setRange(r)} />
      </div>`}
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
function CacheHealthPanel ({ paused = false, active = true }) {
  const { data, err, load } = usePanelLoader(apiGetCacheHealth)
  // 右列状态文件（v3.307）：缓存健康面板原来只占左半 451px，右边 460px 空白；
  // 系统页的「缓存目录文件」在这里给一份紧凑版（前 8 项），整页仍保留全量清单。
  const filesLoader = usePanelLoader(apiGetFiles)
  useEffect(() => { load().catch(() => {}); filesLoader.load().catch(() => {}) }, [load, filesLoader.load])
  // 缓存健康随概览常开：每分钟（且切回前台时）重拉一次，避免「页面开着过夜、mtime 早已更新
  // 但面板还拿着旧快照」；1 分钟一次只读小 JSON，不与 5s 主轮询抢盘。
  const wasPausedRef = useRef(paused)
  useEffect(() => {
    const wasPaused = wasPausedRef.current
    wasPausedRef.current = paused
    if (paused) return undefined
    // 从暂停/隐藏状态回到概览时先补一拍（首帧由上面的 mount effect 拉，不重复）。
    // 右列文件清单也要一起补，否则左列新鲜、右列还是几小时前的快照。
    if (wasPaused) {
      load().catch(() => {})
      filesLoader.load().catch(() => {})
    }
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') load().catch(() => {}) }, 60000)
    // 切回前台不再自己补拉：App 的「回前台补拉」（VISIBLE_STALE_MS）会经下拉事件
    // 通知当前页签的面板，这里再挂一个就会被拉两次（Sourcery PR #300）。
    return () => clearInterval(t)
  }, [load, paused, filesLoader.load])
  // 下拉刷新：健康面板与右列文件清单一起重拉（两者都返回 promise）。
  // 认 active 不认 paused：暂停自动刷新时手动下拉照样要能刷。
  usePullRefresh(active, () => Promise.allSettled([load(), filesLoader.load()]))
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
function CategoryPicker ({ value, categories, total, onChange, pageActive = true }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [path, setPath] = useState([])
  const [active, setActive] = useState(0)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  // ready=false 时弹层先 visibility:hidden：桌面首帧的 up/max 还没量过，不能拿默认值上屏。
  const [place, setPlace] = useState({ up: false, max: 380, ready: false })
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
  // 页签保活后弹层不会随卸载自动关：切走时必须主动收起，否则 body 的 overflow:hidden
  // 会留在新页面上，整页滚不动（Sourcery #271）。
  useEffect(() => {
    if (!pageActive && open) setOpen(false)
  }, [pageActive, open])
  // 打开时：桌面把焦点放进搜索框；手机聚焦当前选项（不弹软键盘）。
  // 依赖 place.ready：桌面首帧弹层是 visibility:hidden（等量测），此时 focus 会被忽略；
  // ready 翻真、弹层可见后再跑一次，否则首次打开焦点进不了搜索框。
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
  }, [open, narrow, place.ready])
  // 搜索词/层级变化后回到第一项，避免 active 指向已被过滤掉的项。
  useEffect(() => { setActive(0) }, [q, path])
  // 桌面端空间不足时向上翻，并按可用高度限制弹层，避免被视口底边裁掉。
  // 必须 useLayoutEffect：量测要赶在首帧绘制前完成。用 useEffect 时弹层会先按默认的
  // 「向下」铺一帧，量到下方不够再跳到上方，肉眼就是先下坠再弹起。ready 未就绪时隐身兜底。
  useLayoutEffect(() => {
    if (!open || narrow) return undefined
    let raf = 0
    const measure = () => {
      const btn = btnRef.current
      if (!btn) {
        // 量不到按钮就退回默认值，绝不能让弹层一直停在 visibility:hidden。
        setPlace((prev) => (prev.ready ? prev : { up: false, max: 380, ready: true }))
        return
      }
      const r = btn.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const want = 380
      const cutoff = Math.min(300, want)
      const H = 8
      // 首次量测按硬阈值定方向；之后方向也走 8px 迟滞：页面在临界线附近小幅滚动时保持
      // 当前朝向。否则 up 一翻转，下面的 prev.up === up 就必然不成立，弹层会跟着上下跳。
      const baseUp = below < cutoff && above > below
      setPlace((prev) => {
        const up = !prev.ready
          ? baseUp
          : (prev.up
              ? !(below > cutoff + H && below > above + H) // 已在上方：明显更该在下方才翻
              : (below < cutoff - H && above > below + H)) // 已在下方：明显更该在上方才翻
        // 下限只保 1px：写死 180px 这类下限，在可用空间不足时会把弹层撑出视口。
        const max = Math.max(1, Math.min(want, up ? above : below))
        // 方向与高度都没跨过阈值时返回同一对象，preact 的 useState 会直接跳过重渲染。
        return prev.ready && prev.up === up && Math.abs(prev.max - max) < H ? prev : { up, max, ready: true }
      })
    }
    // open/断点变化：先回到未就绪，再同步量测，避免沿用上一轮的 up/max。
    setPlace({ up: false, max: 380, ready: false })
    measure()
    // 只监听 window 的 scroll（不 capture）：capture 会把 .cate-list 内部滚动也收进来，
    // 列表每滚一下都重算定位，阈值附近就上下反复。rAF 合并同帧的多次 scroll/resize。
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => { raf = 0; measure() })
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, { passive: true })
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
  // 80+ 分类建树有成本，输入/滚动重渲染时不该重做：tree 只随 categories 变。
  const tree = useMemo(() => buildCateTree(categories), [categories])
  // 当前层节点、搜索词、命中项、层级与最终选项都由 tree/path/q/total/value 派生，
  // 一次 useMemo 收口：搜索时的整树摊平与 80+ 选项对象只在输入/下钻/选中变化时重建，
  // 滚动定位这类无关重渲染直接复用同一份数组。
  const view = useMemo(() => {
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
    // 选中态与 options 同源：行上的 active 类、aria-selected、✓ 都读 sel，不再各算一遍。
    for (const o of options) o.sel = o.leaf && value === o.name
    return { node, kw, results, level, options }
  }, [tree, path, q, total, value])
  const { node, kw, results, level, options } = view
  const focusFirst = () => {
    setTimeout(() => {
      const el = listRef.current && listRef.current.querySelector('.cate-opt[tabindex="0"]')
      if (el) focusInList(el)
    }, 0)
  }
  const choose = (name) => {
    // 值守卫（同 MiniSelect）：点中的就是当前分类时不回调，避免一次无意义的筛选重拉。
    if (name !== value) onChange(name)
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
        style=${narrow ? '' : `max-height:${place.max}px;visibility:${place.ready ? 'visible' : 'hidden'};${place.up ? 'top:auto;bottom:calc(100% + 6px);' : ''}`}>
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
            class=${'cate-opt' + (o.leaf ? '' : ' group') + (o.sel ? ' active' : '')}
            role="option" aria-selected=${o.sel ? 'true' : 'false'}
            tabIndex=${i === active ? 0 : -1} onFocus=${() => setActive(i)}
            title=${o.label} onClick=${() => pick(o)}>
            <span class="cate-opt-name">${o.label}</span>
            <span class="cate-count">${o.count}</span>
            <span class="cate-check">${o.leaf ? (o.sel ? '✓' : '') : '›'}</span>
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

// v3.328：单条记录最多标 200 处命中。超长正文里同一关键词可能重复上千次，每个命中一个
// <mark> 会把「展开」卡住几秒；日志页超过 3000 行直接关高亮是同一思路（渲染上限，不改搜索口径）。
const MSG_HIT_MAX = 200

function MessagesPanel ({ onSync, active = true, pollTick = 0 }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [cate, setCate] = useState('')
  const [days, setDays] = useState(0)
  // 自定义日期区间（v3.326）：两项都非空才生效，否则退回「近 N 天」。
  const [range, setRange] = useState({ from: '', to: '' })
  const rangeActive = range.from !== '' && range.to !== ''
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(null) // 展开的条目 rowKey（无 id 条目是 idx-N 合成键）
  // 响应归属（问题5）：请求发出时记下的 query 会在 in-flight 期间过期——旧响应的
  // queryUsed 会把刚打的新词清空（搜索吞字）。改为：loadSeqRef 给每次请求领号，
  // loadedQueryRef 只在「最新一次请求」回包时记录它对应的 query。
  const loadedQueryRef = useRef('')
  const loadSeqRef = useRef(0)
  // v3.320：列表落点（见 listLandTarget）。listRef 指列表外层容器，landRef 只由用户
  // 主动改页/改每页/改分类/改时间/搜索词落地时置位；queryRef 供防抖里判断词真变了。
  const listRef = useRef(null)
  const landRef = useRef(false)
  // 置旗那一刻的 data：服务端分页要等「这次请求的响应」落地才落点，不能拿旧页的
  // 高度先滚一次（新页更短时浏览器还会二次夹取）。data 引用变了才算落地。
  // 失败时 data 引用不变，故同时记「结算代数」：load 收尾（成功或失败）才 +1，
  // 代数没前进就是响应还没来——旗子必须留着，不能拿旧数据先滚一次。
  const armedDataRef = useRef(undefined)
  const armedSettleRef = useRef(0)
  const userMovedRef = useRef(false)
  // 置旗那一刻已发出的请求号（fetchMessages 里自增）：只有当「置旗后才发出的请求」结算时
  // 才允许消费——否则置旗前就在飞的旧请求先回包，会拿旧筛选的结果抢着落点。
  const armedSeqRef = useRef(0)
  const queryRef = useRef(query)
  queryRef.current = query
  const dataRef = useRef(null)
  // 落点门（v3.320）：只有用户已经滚进列表（列表顶已在页签下沿之上）才置旗——
  // 停在顶部改筛选/搜索时把列表顶拽到页签下沿，工具条会被顶出视口。
  // 面板隐藏/列表不在（rect 为 0）⇒ 不置旗。口径与 listLandTarget 一致。
  const armLand = () => {
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!(rect.height > 0)) return
    const tabs = document.querySelector('.tabs')
    const tabsH = tabs ? tabs.getBoundingClientRect().height : 0
    const listTop = rect.top + window.scrollY - tabsH - 8
    if (!(window.scrollY > listTop)) return
    landRef.current = true
    armedDataRef.current = dataRef.current
    armedSettleRef.current = settleTick
    armedSeqRef.current = loadSeqRef.current
    userMovedRef.current = false
  }
  useLandScrollCancel(landRef, userMovedRef)
  // 搜索防抖：输入停 300ms 才真正改 query；页码重置跟随 query 的真实变化。
  // 落点旗只能在这里置：防抖触发时焦点必然还在输入框（原先看 activeElement 会让
  // 主路径永不落点），所以只按「已滚进列表」判断，滚动等这次响应落地后再做。
  useEffect(() => {
    const t = setTimeout(() => {
      const next = input.trim()
      if (next !== queryRef.current) {
        armLand()
        setQuery(next)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [input])
  // 只有 query 真的变了才回第 1 页；只加/减空白时 query 不变，刷新不应把用户踢回首页。
  useEffect(() => { setPage(1) }, [query])
  const fetchMessages = useCallback(
    () => {
      const requested = query
      const seq = ++loadSeqRef.current
      return apiGetMessages({ page, size, cate, q: requested, days: rangeActive ? 0 : days, from: range.from, to: range.to }).then((d) => {
        if (seq === loadSeqRef.current) loadedQueryRef.current = requested
        return d
      })
    },
    [page, size, cate, query, days, rangeActive, range.from, range.to])
  const { data, err, load, loading, settleTick } = usePanelLoader(fetchMessages, onSync)
  const slowLoading = useSlowFlag(loading)
  // armLand 需要「点击那一刻的 data」做前后对比；渲染期同步，避免闭包拿到旧值。
  dataRef.current = data
  // 保活后每次切回本页都静默拉一次新数据：旧列表留在原地（loading 不会清 data），
  // 只更新内容，不出现「加载中…」占位。离开本页时不拉。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // v3.348：App 的统一轮询节拍（后台/暂停时不涨），本页在前台就跟着重拉。
  usePollReload(active, pollTick, load)
  // 结果集缩小后旧页码可能超过新页数（服务端按请求页切片，回空 items）。收到响应后把
  // 页码钳到最后一页并重拉，避免「在后面的页点刷新，整页空白」。
  useEffect(() => {
    if (data && data.status === 'ok' && Number.isSafeInteger(data.pages) && data.pages >= 1 && page > data.pages) {
      setPage(data.pages)
    }
  }, [data, page])
  // v3.320：主动操作后（paint 前）把列表顶部落到吸顶页签下沿——旧版换页时页高变化，
  // 浏览器把 scrollY 夹到新的上限，用户停在短页中间/底部。纯 load()、自动刷新、不置旗 ⇒ 不搬用户的位置。
  // 服务端分页：置旗那一帧 data 还是旧页，先落点会在新页更短时被浏览器二次夹取；
  // 旗子跨过 loading 保留，等这次响应结算（settleTick 前进 + loading=false）再消费一次。
  // 失败时 data 引用不变，只比 data 会永远等下去（旗子跨过失败留到下一次成功 = 把用户拽到列表顶）。
  useLayoutEffect(() => {
    if (!landRef.current) return
    if (loading) return // 响应未回：保留旗子
    if (!(settleTick > armedSettleRef.current)) return // 这次响应还没结算：继续等（含失败前）
    if (!(loadSeqRef.current > armedSeqRef.current)) return // 结算的是置旗前的旧请求：不能拿它落点
    if (data === armedDataRef.current && !err) return // 仍是置旗前那份数据：继续等
    landRef.current = false
    armedDataRef.current = undefined
    if (err) return // 请求失败：新数据不会来了，清旗不重试，更不滚动
    // 请求飞行期间用户自己滚动时撤销落点（夹取/锚定不算）。
    if (userMovedRef.current) return
    const y = listLandTarget(listRef.current)
    if (y === null) return
    window.scrollTo(0, y)
  }, [data, loading, err, settleTick, page, size, cate, days, query])
  // 分页统一入口：只有用户点分页才置落点旗；目标页 = 当前页不置（否则旗子悬挂）。
  const goPage = (n) => {
    if (n === page) return
    armLand()
    setPage(n)
  }
  // 搜索框回车 / 刷新前先把未落地的输入立刻生效，避免「刚打完字点刷新，还是旧结果」。
  // 只有搜索词变了才回第 1 页；没改词时刷新当前页，不应把用户踢回首页（审查 #246 可选）。
  // v3.334：按钮不再因为 loading 变灰——缓存命中时 loading 只有 15ms，
  // disabled 会把按钮压到 0.45 透明度再弹回来，这就是那下闪。改成只在慢加载时禁用。
  const busyRef = useRef(false)
  const refreshNow = () => {
    // 搜索词先落地：请求在飞时改词 + 回车不能被节流到 300ms 后再发。
    const q = input.trim()
    if (q !== query) { armLand(); setQuery(q); setPage(1); return }
    // loading 覆盖自动刷新/下拉刷新发起的请求，busyRef 挡同一 tick 的连点。
    if (loading || busyRef.current) return
    busyRef.current = true
    load().catch(() => {}).finally(() => { busyRef.current = false })
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
    if (rangeActive) { body.set('from', range.from); body.set('to', range.to) }
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
  }, [exporting, cate, query, days, rangeActive, range.from, range.to])
  const items = data && Array.isArray(data.items) ? data.items : []
  const categories = data && Array.isArray(data.categories) ? data.categories : []
  // 分类弹层的「全部分类」计数必须跟时间窗走（服务端 days>0 时 categories 已按窗口重算）；
  // 直接用 grandTotal 会在「今天」里显示全量 374，看起来像筛选没生效。
  const cateTotal = data && Array.isArray(data.categories)
    ? data.categories.reduce((sum, c) => sum + (typeof c.count === 'number' ? c.count : 0), 0)
    : null
  // v3.328：搜索结果高亮——标题与正文里的命中片段套 <mark>。
  // 高亮词必须与「当前显示的这一页数据」同源：data.queryUsed 是服务端为这批结果实际生效的词。
  // 防抖提交新词后、新响应回来前 data 仍是上一轮的，用 query 会拿新词去标旧卡片
  // （PR #291 Sourcery：Old results get wrong highlights）。
  const hitKw = (data && typeof data.queryUsed === 'string' ? data.queryUsed : '').trim().toLowerCase()
  const hit = (text) => (typeof text === 'string'
    ? splitHits(text, hitKw, MSG_HIT_MAX).map(([part, on], i) => on ? html`<mark key=${i}>${part}</mark>` : part)
    : text)
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
        total=${cateTotal} pageActive=${active}
        onChange=${(v) => { armLand(); setCate(v); setPage(1) }} />
      <${MiniSelect} value=${rangeActive ? '__range' : String(days)} ariaLabel="时间范围"
        options=${[
          ...(rangeActive ? [{ value: '__range', label: '自定义区间' }] : []),
          { value: '0', label: '全部时间' },
          { value: '1', label: '今天' },
          { value: '3', label: '近 3 天' },
          { value: '7', label: '近 7 天' },
          { value: '30', label: '近 30 天' }
        ]}
        onChange=${(v) => {
          if (v === '__range') return
          armLand()
          setRange({ from: '', to: '' })
          setDays(Number(v))
          setPage(1)
        }} />
      <${DateRange} value=${range} onChange=${(r) => { armLand(); setRange(r); setDays(0); setPage(1) }} />
      <${MiniSelect} value=${String(size)} ariaLabel="每页显示条数"
        options=${[10, 20, 50, 100].map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
        onChange=${(v) => { armLand(); setSize(Number(v)); setPage(1) }} />
      <${Button} variant="ghost" disabled=${slowLoading} ariaBusy=${loading ? 'true' : 'false'} onClick=${refreshNow}>刷新<//>
      <${Button} variant="ghost" disabled=${exporting !== ''} onClick=${() => doExport('csv')}>${exporting === 'csv' ? '导出中…' : '导出 CSV'}<//>
      <${Button} variant="ghost" disabled=${exporting !== ''} onClick=${() => doExport('json')}>${exporting === 'json' ? '导出中…' : '导出 JSON'}<//>
    </div>
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${exportErr && html`<${Hint} tone="error">${exportErr}<//>`}
    ${exportNote && html`<${Hint}>${exportNote}<//>`}
    ${loading && !data && html`<div class="empty">加载中…</div>`}
    ${data && data.status !== 'ok' && html`<div class="empty">记录${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}${data.cacheDirHint ? html`<${Hint}>正在读取目录：${data.cacheDirHint}（若运行缓存在别处，请让 XBK_CACHE_DIR 与运行侧 Config.cache.dir 一致）<//>` : ''}</div>`}
    ${data && data.status === 'ok' && html`<div ref=${listRef}>
      <div class="msg-count" aria-live="polite">匹配 ${data.total} 条${(query.length > 0 || cate.length > 0) && data.grandTotal !== data.total ? ` / 共 ${data.grandTotal} 条` : ''}${slowLoading ? html`<span class="msg-loading"> · 更新中…</span>` : ''}</div>
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
                <span class="msg-caret" aria-hidden="true">${expanded === m.rowKey ? '▾' : '▸'}</span>${m.title ? hit(m.title) : '（无标题）'}
              </span>
              ${m.price !== null ? html`<span class="msg-price">¥${m.price}</span>` : ''}
            </div>
            <div class="msg-meta">
              <span class="msg-cate">${m.catename}</span>
              <span class="mono">${m.datetime} ${m.shorttime}</span>
              ${msgLink(m, data.baseUrl)}
            </div>
            ${expanded === m.rowKey && html`<div class="msg-content">${m.content ? hit(m.content) : '（无正文）'}</div>`}
          </div>`)}
        </div>`}
      <div class="pager">
        <${Button} disabled=${page <= 1 || loading} onClick=${() => goPage(1)}>« 首页<//>
        <${Button} disabled=${page <= 1 || loading} onClick=${() => goPage(page - 1)}>上一页<//>
        <span class="pager-info">第 ${data.page} / ${data.pages} 页</span>
        <${Button} disabled=${page >= data.pages || loading} onClick=${() => goPage(page + 1)}>下一页<//>
        <${Button} disabled=${page >= data.pages || loading} onClick=${() => goPage(data.pages)}>末页 »<//>
      </div>
    </div>`}
  </div>`
}

// 运行日志：run.log 尾部（服务端 1MiB 上限），启动预加载 + 手动/切回刷新；有任务在跑时跟随轮询。
// 异常口径与筛选在 pure.mjs（isIssueLogLine / filterLogLines），组件与测试共用。
// ── 日志行渲染（v3.317）────────────────────────────────────────────────────
// 旧版把整段尾部文本塞进一个 <pre>：ERROR/ALERT 与普通行同色；搜「推送」命中 53 行
// 却 0 处高亮。现在一行一个 <span>（仍是 <pre> 内的行内节点 ⇒ pre-wrap/等宽/复制
// 换行都不变），按级别着色，命中片段用 <mark> 包起来。
// 高亮上限：超过 3000 行退回纯文本（每行一个节点 + mark 在手机上明显掉帧），
// 计数行必须明说「已关闭高亮」，不能让用户以为搜不到。
const LOG_HIGHLIGHT_MAX = 3000

function LogsPanel ({ pollMs, initialQuery = '', initialMode = 'all', initialData = null, focusAt = '', focusDate = '', onSync, active = true }) {
  const { data, err, load: loadRaw, loading } = usePanelLoader(apiGetLogs, onSync, initialData)
  // v3.318：跳转前预取的快照只用于本次挂载——首帧即最终日志，且不再立刻重拉一次。
  const seededRef = useRef(initialData !== null)
  const preRef = useRef(null)
  // v3.319：行级跳转把「点中的那一轮」滚到框中部、加底色；只做一次，之后轮询不抢滚动。
  const focusRef = useRef(null)
  const focusDoneRef = useRef('')
  const stickRef = useRef(true)
  const prevTextRef = useRef('')
  // v3.351：日志框右侧「快滚条」——一长条轨道，按住拖动可快速掠过整段日志。
  // 手机浏览器不显示原生滚动条，长日志只能一屏屏甩；这里补一条可拖的条，点轨道直接跳。
  const railRef = useRef(null)
  const dragRef = useRef(null)
  const [rail, setRail] = useState({ top: 0, height: 0, pct: 0, show: false })
  const syncRail = useCallback(() => {
    const el = preRef.current
    const box = railRef.current
    if (!el || !box) return
    const track = box.clientHeight
    const max = el.scrollHeight - el.clientHeight
    if (track <= 0 || max <= 8) {
      setRail((prev) => (prev.show ? { top: 0, height: 0, pct: 0, show: false } : prev))
      return
    }
    const h = Math.max(28, Math.round(track * (el.clientHeight / el.scrollHeight)))
    const top = Math.round((track - h) * (el.scrollTop / max))
    const pct = Math.round((el.scrollTop / max) * 100)
    setRail((prev) => (prev.show && prev.top === top && prev.height === h && prev.pct === pct
      ? prev
      : { top, height: h, pct, show: true }))
  }, [])
  // 手指落在轨道空白处：以拇指高度折半起算，落到哪跳到哪；落在拇指上：保持抓取偏移，拖动不跳。
  const railScrollTo = useCallback((clientY, grab) => {
    const el = preRef.current
    const box = railRef.current
    if (!el || !box) return
    const track = box.clientHeight
    const h = Math.max(28, Math.round(track * (el.clientHeight / el.scrollHeight)))
    const usable = Math.max(1, track - h)
    const y = clientY - box.getBoundingClientRect().top - grab
    const ratio = Math.min(1, Math.max(0, y / usable))
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    syncRail()
  }, [syncRail])
  const onRailDown = (e) => {
    const el = preRef.current
    const box = railRef.current
    if (!el || !box) return
    // 多指并发（Sourcery #305 M3）：第二根手指按下时第一根还在拖——只认先按下的那根。
    // 否则 dragRef 被覆盖，第一根的 move/up 全被 id 过滤掉，松手后条还粘在旧抓取点。
    if (dragRef.current) return
    const track = box.clientHeight
    const h = Math.max(28, Math.round(track * (el.clientHeight / el.scrollHeight)))
    const thumbTop = box.getBoundingClientRect().top + rail.top
    const onThumb = e.clientY >= thumbTop - 2 && e.clientY <= thumbTop + h + 2
    dragRef.current = { id: e.pointerId, grab: onThumb ? e.clientY - thumbTop : h / 2 }
    // 捕获失败（合成事件 / 指针已抬起）不影响这次跳转：先记下抓取点，能捕获就捕获。
    if (typeof box.setPointerCapture === 'function') {
      try { box.setPointerCapture(e.pointerId) } catch (err) {}
    }
    e.preventDefault()
    railScrollTo(e.clientY, dragRef.current.grab)
  }
  const onRailMove = (e) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    e.preventDefault()
    railScrollTo(e.clientY, d.grab)
  }
  const onRailUp = (e) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    const box = railRef.current
    if (box && typeof box.releasePointerCapture === 'function') {
      try { box.releasePointerCapture(e.pointerId) } catch (err) {}
    }
  }
  // 键盘等价操作：上下 48px、翻页 0.9 屏、Home/End 到两端。
  const onRailKey = (e) => {
    const el = preRef.current
    if (!el) return
    const page = Math.max(80, el.clientHeight * 0.9)
    const map = { ArrowDown: 48, ArrowUp: -48, PageDown: page, PageUp: -page }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      el.scrollTop = e.key === 'Home' ? 0 : el.scrollHeight
    } else if (e.key in map) {
      e.preventDefault()
      el.scrollTop = Math.max(0, el.scrollTop + map[e.key])
    } else {
      return
    }
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    syncRail()
  }
  // 轮询互斥（审查 #231 前端项）：任务运行时每 2s 拉 1 MiB，上一请求未回时再叠一发
  // 只会让服务端并发读盘、后到的响应还可能盖掉新结果。手动刷新同样走这把闸。
  const busyRef = useRef(false)
  const pendingRef = useRef(false)
  // 排队等待者：下拉指示条要等「在飞那一轮 + 它触发的补跑」都结束才收。
  const idleWaitersRef = useRef([])
  const load = useCallback(async (queue = false) => {
    // 手动刷新撞上在飞请求时不丢这次意图：记 pending，当前请求结束后再补一轮。
    // 轮询/可见性补拉不排队（queue=false），避免慢请求把轮询变成背靠背重试。
    if (busyRef.current) {
      if (queue) {
        pendingRef.current = true
        await new Promise((resolve) => { idleWaitersRef.current.push(resolve) })
      }
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
      const waiters = idleWaitersRef.current
      idleWaitersRef.current = []
      for (const done of waiters) done()
    }
  }, [loadRaw])
  // 下拉刷新走排队路径：在飞的手动刷新结束后再补一轮，不丢这次意图。
  usePullRefresh(active, () => load(true))
  // 日志筛选（v3.307）：run.log 尾部最多 1 MiB，排障时先按级别收窄；纯客户端过滤，
  // 不发新请求。默认「异常」已排除控制台生命周期行（旧口径 123 条异常里 119 条是它）。
  const [mode, setMode] = useState(initialMode)
  const [q, setQ] = useState(initialQuery)
  // v3.319：用户切分类/手改搜索词即视为收起定位条，切回「全部」也不再自动弹出。
  const [focusDismissed, setFocusDismissed] = useState(false)
  useEffect(() => { setMode(initialMode); setQ(initialQuery); setFocusDismissed(false) }, [initialMode, initialQuery])
  const preloadedRef = useRef(false)
  const revealedRef = useRef(active)
  const dataAtRef = useRef(0)
  useEffect(() => { if (data) dataAtRef.current = Date.now() }, [data])
  useEffect(() => {
    // 首访预加载：页签还没点开也先把日志拉下来；之后离开不拉，切回再补。
    if (!active && preloadedRef.current) return undefined
    const firstReveal = preloadedRef.current && active && !revealedRef.current
    const seeded = seededRef.current
    seededRef.current = false
    preloadedRef.current = true
    revealedRef.current = active
    // v3.318：跳转前 openLog 已取到快照，首帧就用它定稿，不再立刻重拉——慢网下
    // 第二次请求失败还会把有效日志盖成错误。之后切走再回来仍走下面的补拉。
    if (seeded) {
      // 快照已就位，本次挂载不发请求。
    } else if (firstReveal) {
      // 第一次点开时直接用预加载结果；只有预加载失败（没 data 也没在飞）或数据已超过
      // 5s 才补一发，避免点击瞬间再发请求把预加载响应顶掉（Sourcery #272）。
      const stale = !loading && (!data || Date.now() - dataAtRef.current > 5000)
      if (stale) load(true).catch(() => {})
    } else {
      // 切回本页时若上一发还在飞，load(true) 会排队补拉；load() 会直接丢弃这次刷新，
      // 保活后就会出现「回来了但日志是离开那刻的旧快照」（Sourcery #271）。
      load(true).catch(() => {})
    }
    if (!active) return undefined
    // 页面在后台时不轮询（切回前台由 App 统一补拉）：控制台常驻标签页也不该整夜每 5s 读盘。
    // 保活后离开本页即清掉定时器：隐藏的日志页不跟着刷。
    let t = null
    if (pollMs) {
      const tick = () => { if (document.visibilityState !== 'hidden') load().catch(() => {}) }
      t = setInterval(tick, pollMs)
    }
    return () => { if (t !== null) clearInterval(t) }
  }, [load, pollMs, active])
  const rawText = data && data.status === 'ok' && typeof data.text === 'string' ? data.text : ''
  // 1 MiB 文本的 split/lowercase 只在输入变化时做一次（审查 #248 可选：此前每次渲染
  // 3 次全量 split + 2 次 lowercase，手机输入关键字会掉帧）。
  const lines = useMemo(() => filterLogLines(rawText, 'all', ''), [rawText])
  const counts = useMemo(() => logLineCounts(rawText), [rawText])
  const kw = q.trim().toLowerCase()
  // v3.319：「只看这一轮」必须按行首时间戳收窄——普通关键字搜索会把正文里
  // 提到同一时间戳的其他行也带进来，看起来像「这一轮」有多行。
  // 用户已用「清除定位 / 选区间 / 改搜索」把定位条收起了，就不能再按 focusAt 收窄——
  // 否则选了区间也只剩那一轮的行（Sourcery #288 M5）。
  const focusOnly = focusAt !== '' && focusDate !== '' && q === focusAt && mode === 'all' && !focusDismissed
  // v3.326：按日期区间筛日志（客户端侧，行首时间戳前缀；不重拉 /api/logs）。
  const [logRange, setLogRange] = useState(EMPTY_RANGE)
  const logRangeActive = DAY_KEY_RE.test(logRange.from) && DAY_KEY_RE.test(logRange.to)
  const filtered = useMemo(() => {
    const base = filterLogLines(rawText, mode, q)
    return focusOnly ? base.filter((l) => l.startsWith(focusAt)) : base
  }, [rawText, mode, q, focusOnly, focusAt])
  const ranged = useMemo(
    () => (logRangeActive ? filtered.filter((l) => inDayRange(l.slice(0, 10), logRange)) : filtered),
    [filtered, logRangeActive, logRange.from, logRange.to])
  const shownText = useMemo(() => ranged.join('\n'), [ranged])
  // 高亮节点上限（v3.319）：超过 3000 行退回纯文本，定位也不再假装有高亮。
  const heavy = ranged.length > LOG_HIGHLIGHT_MAX
  // v3.319：行级跳转的定位状态。day = 当天列表 + 高亮该轮；only = 只看该轮。
  // 用户切了分类/自己改了搜索词就收起定位条，避免和当前筛选打架。
  const focusHits = useMemo(() => (focusAt ? lines.filter((l) => l.startsWith(focusAt)).length : 0), [lines, focusAt])
  const focusHeavy = focusAt !== '' && mode === 'all' && q === focusDate && heavy && !focusDismissed
  const focusMode = focusDismissed || mode !== 'all' || focusAt === '' || focusHits === 0 || heavy
    ? ''
    : (q === focusAt ? 'only' : (q === focusDate ? 'day' : ''))
  const focusMiss = !focusDismissed && mode === 'all' && focusAt !== '' && focusHits === 0 && q === focusDate
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
  // v3.318：改用 layout effect——跳转时快照已在首帧，若等 paint 后再贴底，
  // 会先看到日志顶部再被拽到底部（一帧闪动）。
  useLayoutEffect(() => {
    const el = preRef.current
    if (!el || !data) return
    if (data.status !== 'ok') { stickRef.current = true; prevTextRef.current = ''; return }
    if (stickRef.current || prevTextRef.current === '') el.scrollTop = el.scrollHeight
    prevTextRef.current = shownText
    syncRail()
  }, [data, mode, q, shownText, syncRail])
  // 日志/筛选变化后等一帧再量轨道（<pre> 高度落定后再算）；窗口尺寸变化同理。
  useEffect(() => {
    const id = window.requestAnimationFrame(syncRail)
    return () => window.cancelAnimationFrame(id)
  }, [data, mode, q, shownText, syncRail])
  useEffect(() => {
    const onResize = () => syncRail()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [syncRail])
  // 面板被切走时 display:none ⇒ 量到 0 高、条被隐藏；切回来不一定伴随 resize 或内容变化
  // （Sourcery #305 M1），所以 active 变 true 时必须重量一次，否则条一直不出现。
  useEffect(() => {
    if (!active) return
    const id = window.requestAnimationFrame(syncRail)
    return () => window.cancelAnimationFrame(id)
  }, [active, syncRail])
  // 日志框自身高度变化（视口转屏、字号/行高变化）不触发 window resize，用 ResizeObserver 兜住。
  useEffect(() => {
    const el = preRef.current
    if (!el || typeof window.ResizeObserver !== 'function') return
    const ro = new window.ResizeObserver(() => syncRail())
    ro.observe(el)
    return () => ro.disconnect()
  }, [data, syncRail])
  // v3.319：行级跳转把点中的那一轮滚到日志框中部；只做一次，轮询不抢用户滚动。
  // 用 useLayoutEffect：与贴底同一帧完成，首帧就是定位后的位置，不会先闪顶部/底部。
  useLayoutEffect(() => {
    if (!focusAt || focusDoneRef.current === focusAt) return
    const pre = preRef.current
    const el = focusRef.current
    if (!pre || !el) return
    const box = pre.getBoundingClientRect()
    const row = el.getBoundingClientRect()
    const top = row.top - box.top + pre.scrollTop
    pre.scrollTop = Math.max(0, top - (pre.clientHeight - row.height) / 2)
    stickRef.current = false
    focusDoneRef.current = focusAt
  }, [data, focusAt, q])
  const onLogScroll = () => {
    const el = preRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    syncRail()
  }
  const refreshNow = () => {
    stickRef.current = true
    load(true).catch(() => {})
  }
  const pickMode = (next) => {
    stickRef.current = true
    if (next !== mode) setFocusDismissed(true)
    setMode(next)
  }
  // v3.317：计数行/空态都必须点名筛选——只说「没有匹配的日志行」时，用户会以为
  // 关键词搜不到，其实是上一个 chip 还开着（实测：先点「控制台」再搜「推送」= 0 行）。
  const modeLabel = (LOG_MODES.find((m) => m[0] === mode) || ['', '全部'])[1]
  const countLine = [
    mode !== 'all'
      ? `在「${modeLabel}」筛选下 · 显示 ${ranged.length} / ${lines.length} 行`
      : ((kw !== '' || logRangeActive) ? `显示 ${ranged.length} / ${lines.length} 行` : `共 ${lines.length} 行`),
    (mode === 'issue' || mode === 'error') ? '已排除控制台停止记录' : '',
    heavy ? `行数过多（>${LOG_HIGHLIGHT_MAX}），已关闭高亮` : '',
    logRangeActive ? `日期 ${logRange.from} ~ ${logRange.to}` : '',
    mode === 'all' ? '分类可重叠' : ''
  ].filter(Boolean).join(' · ')
  const emptyText = lines.length === 0
    ? '（空）'
    : mode !== 'all'
      ? `在「${modeLabel}」筛选下没有匹配的日志行${kw !== '' ? `（关键词「${q.trim()}」）` : ''}`
      : '（没有匹配的日志行）'
  // 空态里的出口：把筛选交回「全部」，关键词保留（用户本来要搜的就是这个词）。
  const searchAllLogs = () => {
    stickRef.current = true
    setMode('all')
  }
  // 一行一个 <span>，换行仍用真实 "\n"（行内节点 + pre-wrap）：复制日志保留原换行、
  // 空行不会塌成 0 高；命中片段只作为 <mark> 的文本子节点，不拼 innerHTML。
  // 超阈值先在 useMemo 里返回 null：旧实现「先 map 出一整页 span、再在渲染时二选一」，
  // 护栏只省了挂载没省构造，3000+ 行搜索在手机上照样卡（Sourcery：Large log searches still lag）。
  const lineNodes = useMemo(() => {
    if (ranged.length > LOG_HIGHLIGHT_MAX) return null
    const kwNow = q.trim().toLowerCase()
    const last = ranged.length - 1
    return ranged.map((line, i) => {
      const tone = logLineTone(line)
      // v3.319：点中的那一轮加底色并把 ref 交给居中 effect（只会在行首时间戳匹配）。
      const isFocus = focusAt !== '' && line.startsWith(focusAt)
      return html`<span class=${'logline' + (tone ? ' logline-' + tone : '') + (isFocus ? ' logline-focus' : '')}
        key=${i} ref=${isFocus ? focusRef : null}>${
        splitHits(line, kwNow).map(([text, hit], j) => hit ? html`<mark key=${j}>${text}</mark>` : text)
      }${i === last ? '' : '\n'}</span>`
    })
  }, [ranged, q, focusAt])
  // v3.320：工具条与计数行不再等数据。旧版整块挂在 ok 分支里：首帧只有「读取中」占位
  // （panel 583），数据到达后筛选栏凭空插进来（+134）再加计数行（+19），日志框连下半页
  // 一起被推走 153px。现在 chips 用同一组标签、计数先显示 —，计数行显示「读取中…」。
  const logReady = !!(data && data.status === 'ok')
  const countText = logReady ? countLine : ((data || err) ? '—' : '读取中…')
  return html`<div class="panel">
    <${PanelHead} title="运行日志" sub=${'run.log 尾部 1 MiB' + (pollMs ? ' · 任务运行中，实时跟随' : '')}
      right=${html`<${Button} variant="ghost" onClick=${refreshNow}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${/* v3.320：首帧就按最终高度占位（.log-empty 与 .logpre-main 同高）。旧版首帧只有
         90px，数据到达后 .logpre 一次性出现（776px），文档高度突跳一次。 */ ''}
    ${logReady && focusMode === 'day' && html`<div class="log-focus" role="status">
      <span class="log-focus-text">已定位：<span class="log-focus-time">${focusAt}</span> 这一轮${focusHits > 1 ? `（同秒 ${focusHits} 行，均已高亮）` : ''}</span>
      <button type="button" class="log-chip" onClick=${() => { focusDoneRef.current = ''; setQ(focusAt) }}>只看这一轮</button>
    </div>`}
    ${logReady && focusMode === 'only' && html`<div class="log-focus" role="status">
      <span class="log-focus-text">只看：<span class="log-focus-time">${focusAt}</span> 这一轮</span>
      <button type="button" class="log-chip" onClick=${() => { focusDoneRef.current = ''; setQ(focusDate) }}>看当天全部</button>
    </div>`}
    ${logReady && focusMiss && html`<div class="log-focus log-focus-miss" role="status">
      <span class="log-focus-text">这一轮不在当前日志尾部（可能已轮转），下面只显示当天其他轮次</span>
    </div>`}
    ${logReady && focusHeavy && html`<div class="log-focus log-focus-miss" role="status">
      <span class="log-focus-text">当天日志超过 ${LOG_HIGHLIGHT_MAX} 行，整行高亮已关闭</span>
      <button type="button" class="log-chip" onClick=${() => { stickRef.current = true; setQ(focusAt) }}>只看这一轮</button>
    </div>`}
    <div class="log-tools">
      <div class="log-chips" role="group" aria-label="日志筛选">
        ${LOG_MODES.map(([key, label, n]) => html`
          <button type="button" key=${key} class=${'log-chip' + (mode === key ? ' on' : '')}
            aria-pressed=${mode === key ? 'true' : 'false'} onClick=${() => pickMode(key)}>${label} <span class="log-chip-n">${logReady ? n : '—'}</span></button>`)}
      </div>
      <${DateRange} value=${logRange} onChange=${(r) => { stickRef.current = true; setFocusDismissed(true); setLogRange(r) }} />
      <input class="msg-search log-search" type="search" placeholder="搜索日志…" aria-label="搜索日志"
        value=${q} onInput=${(e) => { stickRef.current = true; setFocusDismissed(true); setQ(e.target.value) }} />
    </div>
    <div class="log-count">${countText}</div>
    ${!data && !err && html`<div class="log-empty" role="status">日志读取中…</div>`}
    ${/* v3.320：首次加载就失败时也给同高占位。旧版错误路径只有顶部 Hint，520px 日志框
         整个消失，跳转/切页后页面高度反向塌一次。 */ ''}
    ${err && !data && html`<div class="log-empty" role="status">日志读取失败</div>`}
    ${data && data.status !== 'ok' && html`<div class="log-empty">日志${data.status === 'missing' ? '尚未生成' : `不可读（${data.status}）`}</div>`}
    ${logReady && (ranged.length === 0
      ? html`<div class="log-empty" role="status">
        <div class="log-empty-text">${emptyText}</div>
        ${mode !== 'all' && html`<button type="button" class="log-chip" onClick=${searchAllLogs}>在全部日志中搜索</button>`}
      </div>`
      : html`<div class="log-wrap">
        <pre id="log-pre" class="logpre logpre-main" ref=${preRef} onScroll=${onLogScroll}>${heavy ? shownText : lineNodes}</pre>
        <div class=${'log-rail' + (rail.show ? ' show' : '')} ref=${railRef} role="scrollbar"
          aria-label="日志快速滚动条" aria-controls="log-pre" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow=${rail.pct} tabindex="0" onPointerDown=${onRailDown} onPointerMove=${onRailMove}
          onPointerUp=${onRailUp} onPointerCancel=${onRailUp} onKeyDown=${onRailKey}>
          <span class="log-thumb" style=${{ top: rail.top + 'px', height: rail.height + 'px' }}></span>
        </div>
      </div>`)}
  </div>`
}

// v3.342：控制台设置块（v3.340 在配置页，v3.342 搬到系统页「设置」）。
// 一条读面 + 两个写面：通知自检拦截窗、顶栏时间是否显示年月日。读面失败只影响本块。
function ConsoleSettingsBlock ({ settings, settingsErr, loadSettings, onSaved }) {
  // 拦截窗草稿：输入框可自由键入，保存前统一校验（整数 0–3600）；用户正在改（dirty）时
  // 刷新回来的生效值不覆盖输入框，避免「改到一半被定时重拉吃掉」。
  const [winDraft, setWinDraft] = useState('')
  const [winDirty, setWinDirty] = useState(false)
  const [winErr, setWinErr] = useState('')
  const [winSaved, setWinSaved] = useState(false)
  const [winSaving, setWinSaving] = useState(false)
  const winSavingRef = useRef(false)
  const winSavedTimerRef = useRef(0)
  const [dateErr, setDateErr] = useState('')
  const [dateSaved, setDateSaved] = useState(false)
  const [dateSaving, setDateSaving] = useState(false)
  const dateSavingRef = useRef(false)
  const dateSavedTimerRef = useRef(0)
  useEffect(() => () => {
    clearTimeout(winSavedTimerRef.current)
    clearTimeout(dateSavedTimerRef.current)
  }, [])
  // 读面失败时显式丢弃旧值：绝不让「读取失败」的页面继续显示一个可能已经过期的生效值。
  const settingsLive = settingsErr ? null : settings
  // 「还没读到」与「读失败」在数据上都是 null，但含义相反：把首帧的加载中渲染成
  // 「读取失败 + 全部禁用」，设置块一打开就在报一个不存在的错误（网络慢时持续到超时）。
  const settingsPending = settingsLive === null && !settingsErr
  const winCurrent = settingsLive && settingsLive.settings && Number.isInteger(settingsLive.settings.notifyTestReplayWindowS)
    ? settingsLive.settings.notifyTestReplayWindowS
    : null
  const winSourceLabel = settingsPending
    ? '读取中…'
    : (settingsLive === null ? '读取失败' : (settingsLive.source === 'file' ? '来自设置文件' : '默认值'))
  const showDate = settingsLive && settingsLive.settings && typeof settingsLive.settings.syncShowDate === 'boolean'
    ? settingsLive.settings.syncShowDate
    : null
  // 只在生效值真的变了时回写草稿：保存成功会把 winDirty 由 true 拨回 false，也会触发本 effect，
  // 而那一刻 settings 还是旧值——无条件回写会把刚写入的新值改回旧值（重读失败时长期停在旧值）。
  const winSyncedRef = useRef(null)
  // 保存时提交「开始编辑那一刻」的 revision：草稿期间别的标签页改了值，
  // 轮询会把 settingsLive.revision 推到新值；若仍提交新 revision，服务端会以
  // 为是同一次修改而静默覆盖对方（Sourcery #303 M1）。钉住编辑起点才能收到 409。
  const winBaseRevRef = useRef(null)
  useEffect(() => {
    if (!winDirty) { winBaseRevRef.current = null; return }
    if (winBaseRevRef.current === null && settingsLive) winBaseRevRef.current = settingsLive.revision
  }, [winDirty, settingsLive])
  useEffect(() => {
    if (winDirty || winCurrent === null) return
    if (winSyncedRef.current === winCurrent) return
    winSyncedRef.current = winCurrent
    setWinDraft(String(winCurrent))
  }, [winCurrent, winDirty])
  const adjustWin = (delta) => {
    if (winCurrent === null || winSavingRef.current) return
    const typed = winDraft.trim() === '' ? Number.NaN : Number(winDraft)
    const base = Number.isInteger(typed) ? typed : winCurrent
    const next = Math.min(NOTIFY_WINDOW_MAX_S, Math.max(NOTIFY_WINDOW_MIN_S, base + delta))
    setWinDraft(String(next))
    setWinDirty(true)
    setWinSaved(false)
    setWinErr('')
  }
  // 保存：客户端只做「整数 0–3600」这一层拦截（非法值不发请求）；带 baseRevision 做乐观锁，
  // 别处改过就 409，这里重读让用户看清当前值再决定。
  const saveWin = async () => {
    setWinErr('')
    // 连点两次会各带同一个 baseRevision 发两次 POST，第二次必然 409——那是自己造的冲突，
    // 页面却会同时出现「已保存」和「设置已被别处改过」。入口与按钮双守卫。
    if (winSavingRef.current) return
    if (!settingsLive || winCurrent === null) { setWinErr('当前生效值未读到，先刷新再改'); return }
    // 空串必须按非法处理：Number('') === 0，若直接转数字会把「清空输入框再点保存」
    // 静默解释成 0（关闭拦截）——那是最不该靠猜的语义。
    const typed = winDraft.trim() === '' ? Number.NaN : Number(winDraft)
    if (!Number.isInteger(typed) || typed < NOTIFY_WINDOW_MIN_S || typed > NOTIFY_WINDOW_MAX_S) {
      setWinErr(`拦截窗必须是 ${NOTIFY_WINDOW_MIN_S}–${NOTIFY_WINDOW_MAX_S} 的整数（秒）`)
      return
    }
    winSavingRef.current = true
    setWinSaving(true)
    try {
      const res = await apiPostConsoleSettings({ notifyTestReplayWindowS: typed, baseRevision: winBaseRevRef.current === null ? settingsLive.revision : winBaseRevRef.current })
      const payload = res.data && typeof res.data === 'object' ? res.data : {}
      if (!res.ok) {
        if (payload.error === 'revision_mismatch') {
          setWinErr('设置已被别处改过（revision 不一致），已重新读取，请确认后再保存')
          // 必须复位 dirty：否则本页草稿再也不会跟随刷新，只能整页重载才能回到可保存状态。
          setWinDirty(false)
          await loadSettings()
          return
        }
        setWinErr(`保存失败：${payload.error || `HTTP ${res.status}`}`)
        return
      }
      const saved = payload.settings && Number.isInteger(payload.settings.notifyTestReplayWindowS)
        ? payload.settings.notifyTestReplayWindowS
        : typed
      setWinDraft(String(saved))
      setWinDirty(false)
      setWinSaved(true)
      clearTimeout(winSavedTimerRef.current)
      winSavedTimerRef.current = setTimeout(() => setWinSaved(false), 1500)
      await loadSettings()
      if (typeof onSaved === 'function') onSaved()
    } catch (e) {
      setWinErr(`保存失败：${e && e.message ? e.message : e}`)
    } finally {
      winSavingRef.current = false
      setWinSaving(false)
    }
  }
  // 显示开关：勾一下就保存（不再要一次「保存」）；失败重读并报错，勾选状态跟随服务端。
  const toggleShowDate = async (next) => {
    setDateErr('')
    if (dateSavingRef.current) return
    if (!settingsLive || showDate === null) { setDateErr('当前设置未读到，先刷新再改'); return }
    if (next === showDate) return
    dateSavingRef.current = true
    setDateSaving(true)
    try {
      const res = await apiPostConsoleSettings({ syncShowDate: next, baseRevision: settingsLive.revision })
      const payload = res.data && typeof res.data === 'object' ? res.data : {}
      if (!res.ok) {
        setDateErr(payload.error === 'revision_mismatch'
          ? '设置已被别处改过（revision 不一致），已重新读取'
          : `保存失败：${payload.error || `HTTP ${res.status}`}`)
        await loadSettings()
        return
      }
      await loadSettings()
      if (typeof onSaved === 'function') onSaved()
      setDateSaved(true)
      clearTimeout(dateSavedTimerRef.current)
      dateSavedTimerRef.current = setTimeout(() => setDateSaved(false), 1500)
    } catch (e) {
      setDateErr(`保存失败：${e && e.message ? e.message : e}`)
    } finally {
      dateSavingRef.current = false
      setDateSaving(false)
    }
  }
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">通知自检</span>
      <span class="cfg-block-sub">重复提交拦截窗 · ${winSourceLabel}</span>
    </div>
    <div class="auto-run-row">
      <button type="button" class="auto-step" aria-label="减少" disabled=${winCurrent === null || winSaving} onClick=${() => adjustWin(-1)}>−</button>
      <input class="auto-input" type="number" inputmode="numeric"
        min=${NOTIFY_WINDOW_MIN_S} max=${NOTIFY_WINDOW_MAX_S} step="1"
        aria-label="通知自检拦截窗（秒）" value=${winCurrent === null ? '' : winDraft} disabled=${winCurrent === null || winSaving}
        onInput=${(e) => { setWinDraft(e.target.value); setWinDirty(true); setWinSaved(false); setWinErr('') }} />
      <span class="auto-unit">秒</span>
      <button type="button" class="auto-step" aria-label="增加" disabled=${winCurrent === null || winSaving} onClick=${() => adjustWin(1)}>+</button>
      <${Button} variant="secondary" disabled=${winCurrent === null || winSaving} onClick=${saveWin}>保存<//>
      ${winSaved && html`<span class="cfg-block-sub" role="status" aria-live="polite">已保存 · 立即生效</span>`}
    </div>
    <div class="cfg-text">${settingsPending
      ? '正在读取当前生效值…'
      : winCurrent === null
        ? `当前生效值读取失败，暂不可修改（点右上「刷新」重试）：${settingsErr || '未知错误'}`
        : `当前生效 ${winCurrent} 秒 · 0 = 关闭拦截（连点会重复真实发送）· 保存后下一次触发立即生效`}</div>
    ${winErr && html`<${Hint} tone="error">${winErr}<//>`}
    <div class="cfg-block-head set-head">
      <span class="cfg-block-title">顶栏时间</span>
      <span class="cfg-block-sub">「数据截至 / 自动刷新」后面那个时间</span>
    </div>
    <label class="set-toggle">
      <input type="checkbox" checked=${showDate === true} disabled=${showDate === null || dateSaving}
        onChange=${(e) => toggleShowDate(e.target.checked)} />
      <span>显示年月日</span>
      <span class="cfg-block-sub" role=${dateSaved ? 'status' : undefined} aria-live=${dateSaved ? 'polite' : undefined}>${dateSaving
        ? '保存中…'
        : dateSaved
          ? '已保存 · 立即生效'
          : showDate === null
            ? (settingsPending ? '读取中…' : '读取失败')
            : (showDate ? '关掉后只显示 时:分:秒（点一下仍可看完整日期）' : '当前只显示 时:分:秒（点一下可看完整日期）')}</span>
    </label>
    ${dateErr && html`<${Hint} tone="error">${dateErr}<//>`}
  </div>`
}

// 系统信息：版本 / 运行环境 / 进程 / 缓存目录。只读；下面另挂「设置」块（可写）。
function SysPanel ({ onReady, active = true, onSettingsSaved, pollTick = 0, onFresh, onSettings }) {
  // 访问日志（v3.300 §3.3）：第二个 loader 并列拉取；「刷新」按钮同日 load 两个。
  // 近窗未授权尝试数 = 服务端独立 401 计数（进程启动以来、不随环形窗截断）。
  // 两个请求可能一成一败：本页不认「数据截至」，避免半套数据被标成完整刷新（Sourcery PR#253）。
  // 保活后 data 不会清空，ready 也一直为真：必须等同一次刷新里的两个请求都结算，
  // 才能报「数据截至」；只跟其中一个会在访问日志还是旧快照时提前更新时间（Sourcery #272）。
  const { data: sys, err, load } = usePanelLoader(apiGetSys)
  // v3.335：系统页「检查更新」——页内下拉只刷数据、不换脚本，旧标签页得有个就地入口。
  // 比对的是页面启动版本（BOOT.version）与服务端当前版本；不一致就刷新整页。
  const [verState, setVerState] = useState('') // '' | 'checking' | 'latest' | 'stale' | 'error'
  const verTimerRef = useRef(0)
  const verSeqRef = useRef(0)
  const verBusyRef = useRef(false) // 同步闸：同一 tick 连点只发一次探针（state 要等重渲染）
  useEffect(() => () => clearTimeout(verTimerRef.current), [])
  const checkVersion = () => {
    // stale：已经判定有新版本、刷新已排期——这时再点不得取消那次刷新。
    if (verBusyRef.current || verState === 'stale') return
    verBusyRef.current = true
    const seq = ++verSeqRef.current
    clearTimeout(verTimerRef.current)
    setVerState('checking')
    apiGetSys({ probeVersion: true }).then((s) => {
      if (seq !== verSeqRef.current) return // 乱序响应：旧探针不得覆盖新判定
      const v = s && typeof s.version === 'string' ? s.version : ''
      clearTimeout(verTimerRef.current)
      if (v !== '' && v !== BOOT.version) {
        setVerState('stale')
        verTimerRef.current = setTimeout(() => window.location.reload(), 600)
        return // stale 不放开闸：刷新已排期，等 reload
      }
      verBusyRef.current = false
      setVerState('latest')
      verTimerRef.current = setTimeout(() => setVerState(''), 2500)
    }).catch(() => {
      if (seq !== verSeqRef.current) return
      verBusyRef.current = false
      clearTimeout(verTimerRef.current)
      setVerState('error')
      verTimerRef.current = setTimeout(() => setVerState(''), 2500)
    })
  }
  const { data: access, err: accessErr, load: loadAccess } = usePanelLoader(apiGetAccessLog)
  // v3.342：设置块（拦截窗 + 顶栏时间）的读面由本页统一持有——下拉/刷新必须等它一起落定，
  // 否则指示条会在设置块还在读的时候就收起（v3.330 的「所有 loader 落定」同一条规矩）。
  const { data: settings, err: settingsErr, load: loadSettings } = usePanelLoader(apiGetConsoleSettings)
  const [readyTick, setReadyTick] = useState(0)
  const seenRef = useRef(null)
  const pendingRef = useRef(false)
  const loadedAtRef = useRef(0)
  useEffect(() => {
    const first = seenRef.current === null
    const becameActive = active && seenRef.current === false
    seenRef.current = active
    if (!active && !first) return
    // 首次点开时预加载还在飞/刚回来不到 3s，直接用预加载结果；更久才点开则补一次。
    if (becameActive && (pendingRef.current || (loadedAtRef.current && Date.now() - loadedAtRef.current < 3000))) return
    if (pendingRef.current) return
    pendingRef.current = true
    Promise.allSettled([load(), loadAccess(), loadSettings()]).then(() => {
      pendingRef.current = false
      loadedAtRef.current = Date.now()
      setReadyTick((v) => v + 1)
    }).catch(() => {})
  }, [active, load, loadAccess, loadSettings])
  // 设置块每次读到（含轮询）就同步给 App 的顶栏缓存：别的标签页改了 syncShowDate，
  // 这边最多一个轮询周期就跟上，不用等用户手动保存（Sourcery #303 M6）。
  useEffect(() => {
    if (typeof onSettings === 'function' && settings && !settingsErr) onSettings(settings)
  }, [settings, settingsErr, onSettings])
  // 两个 loader 都落定才通知滚动层收口；只报第一个会在下半页还空着时提前释放垫高。
  const sysReady = !!(sys || err)
  const accessReady = !!(access || accessErr)
  useEffect(() => {
    if (sysReady && accessReady && typeof onReady === 'function') onReady()
  }, [sysReady, accessReady, readyTick, onReady])
  const refreshAll = () => {
    return Promise.allSettled([load(), loadAccess(), loadSettings()]).then((rs) => {
      loadedAtRef.current = Date.now()
      setReadyTick((v) => v + 1)
      return rs
    }).catch(() => [])
  }
  // 下拉刷新与「刷新」按钮同一条路径（两表 + 就绪 tick）。
  usePullRefresh(active, refreshAll)
  // v3.348：统一轮询节拍——本页在前台时每拍重拉（含访问日志与设置）。
  // v3.349：只有三份数据全部成功才推进「数据截至」，半个失败不得冒充整页新数据。
  usePollReload(active, pollTick, () => refreshAll().then((rs) => {
    if (typeof onFresh === 'function') onFresh('sys', rs.every((r) => r.status === 'fulfilled'), pollTick)
  }))
  const fmtUptime = (s) => {
    if (!(typeof s === 'number' && s >= 0)) return '—'
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d} 天 ${h} 时 ${m} 分` : h > 0 ? `${h} 时 ${m} 分` : `${m} 分`
  }
  const logItems = access && Array.isArray(access.items) ? access.items : []
  const logTail = logItems.slice(-20).reverse()
  // v3.320：首帧同形占位——数据到达前也按最终行数（3+4）把两张表画出来，值用 —。
  // 旧版整块 sys-grid 挂在 `${sys && …}` 后面：冷启动首帧只有面板头 + 提示（223px），
  // 75–137ms 后两张表一次性填满（551px），文档 795→1644，下半页整体被推走。
  // 不给容器拍 min-height（行高本身就是占位）。
  // v3.320：access-log 的 details 也无条件渲染——summary 的 44px 就是占位。旧版整块挂在
  // 「有访问记录」条件后面（空态另挂一条 condition），数据到达前首帧没有这一行，加载后凭空
  // 多出 44px（panel 487→551，留在 ≤25px 的残差里）。空态与表格一起移进 details：默认折叠
  // 不占高度，展开才长，首帧与加载后同形。
  const info = sys || {}
  return html`<div class="panel">
    <${PanelHead} title="系统信息" right=${html`<${Button} variant="ghost" onClick=${refreshAll}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    <div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>脚本版本</td><td><span class="ver-line"><span class="ver-num">${info.version ? `v${info.version}` : '—'}</span><button type="button" class=${'ver-check ' + (verState === 'latest' ? 'ok' : verState === 'stale' ? 'warn' : verState === 'error' ? 'bad' : '')} disabled=${verState === 'checking'} onClick=${checkVersion}>${verState === 'checking' ? '检查中…' : verState === 'latest' ? '✓ 已是最新' : verState === 'stale' ? '正在刷新…' : verState === 'error' ? '检查失败' : '检查更新'}</button></span></td></tr>
        <tr><td>Node.js</td><td>${info.node || '—'}</td></tr>
        <tr><td>平台</td><td>${info.platform || '—'}</td></tr>
      </tbody></table>
      <table class="sys-table"><tbody>
        <tr><td>控制台已运行</td><td>${fmtUptime(info.uptimeS)}</td></tr>
        <tr><td>内存占用</td><td>${fmtBytes(info.rssBytes)}</td></tr>
        <tr><td>进程 PID</td><td>${info.pid == null ? '—' : info.pid}</td></tr>
        <tr><td>缓存目录</td><td>${info.cacheDir || '—'}</td></tr>
      </tbody></table>
    </div>
    <div class="set-title">设置<span class="cfg-block-sub">改动立即生效 · 落盘 console-settings.json</span></div>
    <${ConsoleSettingsBlock} settings=${settings} settingsErr=${settingsErr} loadSettings=${loadSettings} onSaved=${onSettingsSaved} />
    <${Hint} style="margin-top:12px">近窗未授权尝试（401）：${access && Number.isSafeInteger(access.unauthorizedCount) ? access.unauthorizedCount : '—'} 次（服务启动以来累计；下方环形日志最多 200 条、重启即清空、不写盘；路径中 token 已由服务端脱敏）。<//>
    ${accessErr && html`<${Hint} tone="error">访问日志加载失败：${accessErr.message || accessErr}<//>`}
    <details class="access-log">
      <summary>最近访问记录（最多 20 条，新在上）</summary>
      ${!accessReady
        ? html`<div class="empty" role="status">读取中…</div>`
        : logTail.length === 0
          ? html`<div class="empty">${accessErr ? '访问日志读取失败' : '暂无访问记录（轮询端点与静态资产的成功请求不记入）'}</div>`
          : html`<table class="sys-table"><tbody>
          ${logTail.map((it, i) => html`<tr key=${`${i}|${it.at}|${it.method}|${it.path}|${it.status}|${it.ms}`}><td>${it.at}</td><td>${it.method} ${it.path} → ${it.status} · ${it.ms}ms</td></tr>`)}
        </tbody></table>`}
    </details>
    <${Hint} style="margin-top:12px">数据说明：推送记录来自判重缓存 push.json（服务端已裁剪正文 HTML）；趋势解析 run.log 摘要行；日志取尾部 1 MiB。<//>
  </div>`
}

// 状态目录文件清单（v3.298）：启动预加载 + 切回系统页刷新 + 手动刷新。符号链接/目录作为异常条目显性
// 展示（bytes 为 ——— 意为「不适用」，服务端不跟随符号链接、不泄露目标元数据）。
function FilesPanel ({ onReady, active = true, pollTick = 0, onFresh }) {
  const [loadTick, setLoadTick] = useState(0)
  const bumpTick = useCallback(() => setLoadTick((v) => v + 1), [])
  const { data, err, load } = usePanelLoader(apiGetFiles, bumpTick)
  // 保活后系统页切回来时补拉一次；离开不拉。data 保留，不出现加载占位。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // v3.348：统一轮询节拍——文件清单也跟着刷新。
  usePollReload(active, pollTick, () => load().then((ok) => {
    if (typeof onFresh === 'function') onFresh('files', ok === true, pollTick)
  }))
  // 文件清单是系统页的下半截；它落定前不能释放切页垫高。loadTick 让切回重拉完成
  // 后也再报一次，否则 ready 首访后就一直为 true，头部「数据截至」不会更新。
  const ready = !!(data || err)
  useEffect(() => { if (ready && typeof onReady === 'function') onReady() }, [ready, loadTick, onReady])
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
// v3.312：rows 来自 effectiveFilterRows（覆盖文件 > 代码配置），被覆盖字段带「覆盖」徽章——
// 配置页原先只读 Config.filter，保存覆盖文件后两页对不上（「已保存」但配置页全空）。
function FilterRules ({ rows, sub }) {
  const [showEmpty, setShowEmpty] = useState(false)
  const list = Array.isArray(rows) ? rows : []
  const isEmpty = (v) => v === undefined || v === null || String(v).length === 0
  const emptyCount = list.filter((row) => isEmpty(row.value)).length
  const shown = showEmpty ? list : list.filter((row) => !isEmpty(row.value))
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">过滤规则</span>
      <span class="cfg-block-sub">${sub || `${list.length} 项${emptyCount > 0 ? ` · ${emptyCount} 项为空` : ''}`}</span>
    </div>
    ${shown.length === 0
      ? html`<div class="empty">暂无已设置的过滤规则${emptyCount > 0 ? `（${emptyCount} 项为空）` : ''}</div>`
      : html`<div class="rule-list">
        ${shown.map((row) => html`<div class="rule-row" key=${row.key}>
          <code class="rule-key">${row.key}</code>
          <span class=${'rule-val' + (isEmpty(row.value) ? ' rule-empty' : '')}>${isEmpty(row.value) ? '（空）' : String(row.value)}</span>
          ${row.overridden && html`<span class="rule-src" title="该字段由覆盖文件提供">覆盖</span>`}
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
// v3.312：过滤规则块改为「实际生效值」——另拉 GET /api/config/filter（覆盖文件结果），
// 与代码默认按字段合并并给覆盖文件提供的字段打「覆盖」徽章。此前只读 Config.filter，保存
// 覆盖文件后两页对不上（用户看到「已保存」但配置页仍然全空）。
function ConfigPanel ({ onSync, active = true, pollTick = 0 }) {
  const [configAt, setConfigAt] = useState(0)
  const [filterAt, setFilterAt] = useState(0)
  const { data, err, load } = usePanelLoader(apiGetConfig, setConfigAt)
  const { data: eff, err: effErr, load: loadEff } = usePanelLoader(apiGetFilter, setFilterAt)
  // 两个 loader 都回过一次才算「配置页加载完成」；只报第一个会让滚动垫高
  // 在第二块还没渲染时就收口（Sourcery #263）。
  useEffect(() => {
    if (typeof onSync === 'function' && configAt && filterAt) onSync(Math.max(configAt, filterAt))
  }, [configAt, filterAt, onSync])
  const refresh = useCallback(() => Promise.allSettled([load(), loadEff()]), [load, loadEff])
  // 启动预加载；保活后每次切回本页静默重拉（旧值留在原地），离开本页不拉。
  usePanelAutoLoad(active, refresh)
  usePullRefresh(active, refresh)
  // v3.348：统一轮询节拍——配置页每拍重拉（只读视图，不会覆盖任何草稿）。
  usePollReload(active, pollTick, refresh)
  const r = data && data.runtime ? data.runtime : null
  const pc = data && data.pushChannels ? data.pushChannels : null
  // 读面失败时 usePanelLoader 仍保留上一次的 data（不清空），这里必须显式丢弃，
  // 否则页面会一边报「读取失败、显示代码默认值」一边渲染旧的覆盖值（Sourcery #257）。
  const effLive = effErr ? null : eff
  // 生效值口径与 FilterStore.mergeActiveFilter 一致：覆盖文件优先、缺字段回代码默认。
  const effFilter = effLive && effLive.filter && typeof effLive.filter === 'object' ? effLive.filter : null
  const filterRows = r ? effectiveFilterRows(r.filter, effFilter) : []
  const changedCount = filterRows.filter((row) => row.differs).length
  const filterSub = filterSourceNote(effLive, filterRows.length, changedCount)
  return html`<div class="panel">
    <${PanelHead} title="运行配置" sub="脱敏视图 · 推送密钥只显示是否已配置"
      right=${html`<${Button} variant="ghost" onClick=${refresh}>刷新<//>`} />
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
    ${r && filterRows.length > 0 && html`<${FilterRules} rows=${filterRows} sub=${filterSub} />`}
    ${r && effErr && html`<${Hint} tone="error">过滤规则覆盖层读取失败：${effErr}（本块显示代码默认值）<//>`}
    ${r && effLive && effLive.source === 'corrupt' && html`<${Hint} tone="error">覆盖文件损坏，当前按降级值运行${effLive.error && effLive.error.message ? `：${effLive.error.message}` : ''}。请到「过滤规则」标签回滚或重新保存。<//>`}
    ${r && html`<${Hint}>本块显示实际生效值：覆盖文件优先于代码默认，带「覆盖」标记的字段由覆盖文件提供。修改请到「过滤规则」标签。<//>`}
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

// 过滤规则草稿：改了但没保存的内容先落在浏览器本地，关标签/杀后台/浏览器退出后
// 下次打开还能捡回来。只存规则字段，不存 token；同一浏览器只保留最近一份。
const FILTER_DRAFT_KEY = 'xbk_filter_draft_v1'
const FILTER_DRAFT_SCHEMA = 1
const FILTER_DRAFT_SAVE_DELAY = 500
const FILTER_DRAFT_SERVER_DELAY = 1500
const FILTER_DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000

function readFilterDraft () {
  try {
    const raw = window.localStorage.getItem(FILTER_DRAFT_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || obj.schema !== FILTER_DRAFT_SCHEMA || !obj.filter || typeof obj.filter !== 'object' || !Number.isFinite(obj.savedAt)) {
      clearFilterDraft()
      return null
    }
    if (Date.now() - obj.savedAt > FILTER_DRAFT_MAX_AGE) {
      clearFilterDraft()
      return null
    }
    return obj
  } catch (e) {
    return null
  }
}

function writeFilterDraft (filter, baseRevision, savedAt) {
  try {
    window.localStorage.setItem(FILTER_DRAFT_KEY, JSON.stringify({
      schema: FILTER_DRAFT_SCHEMA,
      filter,
      baseRevision: Number.isSafeInteger(baseRevision) ? baseRevision : null,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now()
    }))
  } catch (e) { /* 隐私模式/配额满：不影响编辑，只是这次无法恢复 */ }
}

function clearFilterDraft () {
  try { window.localStorage.removeItem(FILTER_DRAFT_KEY) } catch (e) { /* 忽略 */ }
}

function filterDraftAgeText (savedAt) {
  const minutes = Math.max(0, Math.floor((Date.now() - Number(savedAt)) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

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

// 服务器草稿响应 → 与本地草稿同形；坏的/缺字段的响应当没有，不能让他覆盖页面。
function filterDraftFromServer (data) {
  if (!data || data.ok !== true || !data.draft || typeof data.draft !== 'object') return null
  const savedAt = Number(data.draft.savedAt)
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null
  return {
    filter: filterDraftFrom({ filter: data.draft.filter }),
    baseRevision: Number.isSafeInteger(data.draft.baseRevision) ? data.draft.baseRevision : null,
    savedAt,
    source: 'server'
  }
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

function FilterRulesPanel ({ onSync, active = true, pollTick = 0, guardRef, onLeaveRequest }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [base, setBase] = useState(null)
  const [backups, setBackups] = useState([])
  const [backupListKnown, setBackupListKnown] = useState(false)
  const [restoreTo, setRestoreTo] = useState('default')
  const [loading, setLoading] = useState(false)
  const slowLoading = useSlowFlag(loading)
  const [busy, setBusy] = useState('') // '' | validate | preview | save | copy | restore
  const [err, setErr] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [preview, setPreview] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [draftSavedAt, setDraftSavedAt] = useState(0)
  const [draftSyncedAt, setDraftSyncedAt] = useState(0)
  // 竞态/卸载守卫：只应用最新一次 load 的响应；旧响应不能刷新时间戳或覆盖草稿。
  const loadSeqRef = useRef(0)
  const mountedRef = useRef(true)
  // v3.320：校验失败的定位旗（见下方 useLayoutEffect）。只有「确有字段错误」的失败
  // 提交会置它，成功路径与加载失败路径不碰。
  const revealFieldRef = useRef(false)
  useEffect(() => () => { mountedRef.current = false }, [])

  const applyLoaded = useCallback((d, files, serverDraft) => {
    const revision = d && Number.isSafeInteger(d.revision) ? d.revision : 0
    const next = filterDraftFrom(d)
    const list = backupRevisionsOf(files, revision)
    const localSaved = readFilterDraft()
    const local = localSaved
      ? {
          filter: filterDraftFrom({ filter: localSaved.filter }),
          baseRevision: Number.isSafeInteger(localSaved.baseRevision) ? localSaved.baseRevision : null,
          savedAt: localSaved.savedAt,
          source: 'local'
        }
      : null
    const remote = filterDraftFromServer(serverDraft)
    // 同一份草稿可能本机和服务器都有：先排除基于旧 revision 的草稿，再按时间取新。
    // 否则「本机旧草稿但时间更新」会挡住「服务器上基于当前 revision 的可用草稿」。
    const candidates = [local, remote].filter(Boolean)
    const usable = candidates.filter((x) => !Number.isSafeInteger(x.baseRevision) || x.baseRevision === revision)
    const pool = usable.length > 0 ? usable : candidates
    const saved = pool.length > 0
      ? pool.reduce((a, b) => (Number(b.savedAt) > Number(a.savedAt) ? b : a))
      : null
    let restored = null
    let restoreNotice = null
    if (saved) {
      const savedDraft = filterDraftFrom({ filter: saved.filter })
      const changed = FILTER_FIELD_NAMES.filter((n) => String(savedDraft[n]) !== String(next[n]))
      if (changed.length > 0) {
        restored = savedDraft
        const baseRev = Number.isSafeInteger(saved.baseRevision) ? saved.baseRevision : null
        const sourceText = saved.source === 'server' ? '服务器' : '本机'
        restoreNotice = {
          tone: 'warn',
          text: `已恢复上次未保存的草稿（${sourceText}，${filterDraftAgeText(saved.savedAt)}，${changed.length} 个字段）${baseRev !== null && baseRev !== revision ? `；草稿基于 r${baseRev}，当前 r${revision}` : ''}。保存后才会生效。`
        }
        setDraftSavedAt(saved.savedAt)
        setDraftSyncedAt(saved.source === 'server' ? saved.savedAt : 0)
        // 服务器草稿也要在本机留一份：断网/服务挂掉时还能从 localStorage 捡回来。
        if (saved.source === 'server') writeFilterDraft(savedDraft, baseRev, saved.savedAt)
      } else {
        clearFilterDraft()
        setDraftSavedAt(0)
        setDraftSyncedAt(0)
        // 草稿和正式规则一样，已经没有任何可恢复的内容：把服务器那份也清掉。
        if (remote) apiDeleteFilterDraft().catch(() => {})
      }
    } else {
      setDraftSavedAt(0)
      setDraftSyncedAt(0)
    }
    setData(d)
    setDraft(restored || next)
    setBase(next)
    setPreview(null)
    setFieldErrors({})
    if (restoreNotice) setNotice(restoreNotice)
    setBackups(list)
    setBackupListKnown(!!(files && Array.isArray(files.files)))
    setRestoreTo(list.length > 0 ? String(list[0]) : 'default')
  }, [])

  // 渲染期同步的「有未保存改动」标记：load 的回调闭包里读它，避免拿到旧值。
  const dirtyRef = useRef(false)
  // 自动草稿：ref 里永远是最新值，pagehide/visibilitychange 来不及等 React 重渲染也能写。
  const draftRef = useRef(null)
  const baseRef = useRef(null)
  const dataRef = useRef(null)
  const draftPushRef = useRef(null)
  const draftEpochRef = useRef(0)
  draftRef.current = draft
  baseRef.current = base
  dataRef.current = data
  const saveDraftNow = useCallback(() => {
    if (!draftRef.current || !baseRef.current) return
    const d = dataRef.current
    writeFilterDraft(draftRef.current, d && Number.isSafeInteger(d.revision) ? d.revision : null)
    setDraftSavedAt(Date.now())
  }, [])
  const pushDraftNow = useCallback(({ keepalive = false } = {}) => {
    if (!draftRef.current || !baseRef.current) return Promise.resolve(false)
    const filter = draftRef.current
    const d = dataRef.current
    const baseRevision = d && Number.isSafeInteger(d.revision) ? d.revision : 0
    const epoch = draftEpochRef.current
    const p = apiPostFilterDraft(filter, baseRevision, { keepalive })
      .then((res) => {
        // 发出去以后又改了/已经放弃：这次响应不能把状态改回「已同步」。
        if (epoch !== draftEpochRef.current || draftRef.current !== filter) return false
        if (res && res.ok) {
          setDraftSyncedAt(Date.now())
          return true
        }
        return false
      })
      .catch(() => false)
    draftPushRef.current = p
    p.finally(() => {
      if (draftPushRef.current === p) draftPushRef.current = null
    })
    return p
  }, [])
  // 放弃/保存/回滚时同时清服务器草稿。若此时还有一发 PUT 在飞，等它落地后再删一次，
  // 否则晚到的 PUT 会把刚删掉的草稿又写回来。
  const clearServerDraft = useCallback(() => {
    draftEpochRef.current++
    setDraftSyncedAt(0)
    const pending = draftPushRef.current
    const remove = () => apiDeleteFilterDraft().catch(() => {})
    const first = remove()
    // 先删一次；若还有 PUT 在飞，等它落地后再删一次，防止晚到的写入复活草稿。
    const after = pending ? pending.finally(remove) : first
    return after.then(() => undefined)
  }, [])
  // 离开拦截：allowLeaveRef 表示用户已经明确「不保存」，此时 beforeunload/popstate 都放行。
  // guardPushedRef 防止每次输入都往历史里再压一条 sentinel。
  const allowLeaveRef = useRef(false)
  const guardPushedRef = useRef(false)
  const onLeaveRequestRef = useRef(onLeaveRequest)
  onLeaveRequestRef.current = onLeaveRequest
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setErr('')
    try {
      // 备份清单/服务器草稿与规则读取并行：/api/files 只是下拉数据，草稿读不到
      // 也不能阻断规则编辑；两者失败都退化为 null。
      const [d, files, serverDraft] = await Promise.all([apiGetFilter(), apiGetFiles().catch(() => null), apiGetFilterDraft().catch(() => null)])
      if (seq !== loadSeqRef.current || !mountedRef.current) return
      // 响应在飞期间用户改了草稿：这次结果不能覆盖（下拉刷新也不例外）。
      if (dirtyRef.current) return
      applyLoaded(d, files, serverDraft)
      if (typeof onSync === 'function') onSync(Date.now())
    } catch (e) {
      if (seq !== loadSeqRef.current || !mountedRef.current) return
      setErr(`加载失败：${e.message}`)
    } finally {
      if (seq === loadSeqRef.current && mountedRef.current) setLoading(false)
    }
  }, [applyLoaded, onSync])

  useEffect(() => { load().catch(() => {}) }, [load])
  // 首访预加载后规则文件可能已经变了：第一次真正点开本页时静默补一次（旧数据留在
  // 原地，不闪加载）。只在第一次打开时补；之后再切回不重拉，避免覆盖未保存草稿。
  const openedRef = useRef(active)
  useEffect(() => {
    if (!active || openedRef.current) return
    openedRef.current = true
    load().catch(() => {})
  }, [active, load])

  const dirtyFields = useMemo(() => {
    if (!draft || !base) return []
    return FILTER_FIELD_NAMES.filter((n) => String(draft[n]) !== String(base[n]))
  }, [draft, base])
  const draftWide = useMemo(() => wideFieldsOf(draft), [draft])
  const dirty = dirtyFields.length > 0
  dirtyRef.current = dirty
  // 下拉刷新不碰有未保存改动的草稿：一次下拉不能静默丢掉用户刚改的规则。
  usePullRefresh(active && dirtyFields.length === 0, load)
  // v3.348：统一轮询节拍。load 自己会在 dirtyRef 为真时丢弃响应，
  // 所以有未保存改动时自动刷新不会覆盖草稿（下拉刷新之外的第二道保险）。
  usePollReload(active, pollTick, load)

  // 自动草稿：改完 500ms 就写 localStorage，不等 5 分钟——等 5 分钟再存的话，
  // 改完立刻杀后台会丢掉最后 5 分钟的修改。draft 为空时不能清，否则会把上次
  // 尚未恢复的草稿在首帧抹掉。
  useEffect(() => {
    if (!draft || !base) return undefined
    if (!dirty) {
      clearFilterDraft()
      setDraftSavedAt(0)
      return undefined
    }
    const t = window.setTimeout(saveDraftNow, FILTER_DRAFT_SAVE_DELAY)
    return () => window.clearTimeout(t)
  }, [dirty, draft, base, data, saveDraftNow])

  // 服务器草稿比本机慢一点（1.5s），避免一边打字一边高频写盘；页面切走/关掉时
  // 下面的 flush 会立刻补发。服务器成功前本机草稿已经落盘，断网也不丢。
  useEffect(() => {
    if (!dirty) return undefined
    const t = window.setTimeout(() => { pushDraftNow() }, FILTER_DRAFT_SERVER_DELAY)
    return () => window.clearTimeout(t)
  }, [dirty, draft, base, data, pushDraftNow])

  // 离线时服务器写失败：网络回来且仍有未保存改动，补推一次。
  useEffect(() => {
    const retry = () => { if (dirtyRef.current) pushDraftNow() }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [pushDraftNow])

  // 切后台/关标签/刷新：立刻补一发，不能等 500ms 定时器。
  useEffect(() => {
    if (!dirty) return undefined
    const flush = () => {
      if (allowLeaveRef.current) return
      saveDraftNow()
      pushDraftNow({ keepalive: true })
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [dirty, saveDraftNow])

  // 刷新/关页：先把最新草稿写进 localStorage，再让浏览器弹原生提示。
  // 自定义弹窗在 beforeunload 里出不来，文案由浏览器决定。
  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (e) => {
      if (allowLeaveRef.current) return
      saveDraftNow()
      pushDraftNow({ keepalive: true })
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, saveDraftNow, pushDraftNow])

  // 手机左滑/浏览器后退：脏草稿时在历史里压一条同地址 sentinel。第一次后退会退到
  // 这条 sentinel（同页、不卸载），popstate 里再问「保存 / 不保存 / 取消」。取消时
  // App 调 restoreHistory() 重新压一条，保证下一次左滑还能拦。
  useEffect(() => {
    if (!dirty) {
      guardPushedRef.current = false
      return undefined
    }
    allowLeaveRef.current = false
    if (!guardPushedRef.current) {
      window.history.pushState({ ...(window.history.state || {}), __xbkFilterGuard: true }, '', window.location.href)
      guardPushedRef.current = true
    }
    const onPop = () => {
      if (!dirtyRef.current || allowLeaveRef.current) return
      if (onLeaveRequestRef.current) onLeaveRequestRef.current({ source: 'history' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [dirty])

  const setFieldValue = useCallback((name, value) => {
    setDraft((cur) => (cur ? { ...cur, [name]: value } : cur))
    setDraftSyncedAt(0)
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
    clearFilterDraft()
    setDraftSavedAt(0)
    clearServerDraft()
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
      // v3.320：确有逐字段错误时才置定位旗——没有字段错误的失败（401/503/写入忙…）
      // 顶部 Hint 就在原地，不该拽页面。旗子由下面的 useLayoutEffect 消费。
      revealFieldRef.current = errors.length > 0
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

  // v3.320：校验失败时反馈在视口外——顶部汇总 Hint 与每字段错误行都插在动作区上方，
  // 屏幕内只看到按钮被推下 74px。这里在状态提交后（paint 前）把第一个 aria-invalid
  // 字段滚到吸顶页签下沿并聚焦：先 focus({ preventScroll: true }) 拿焦点，再按
  // .tabs 高度 + 8 手工算 scrollTo（不居中，避免把错误行顶出屏幕上沿）。
  // 只由上面的 fail() 置旗 ⇒ 成功路径、加载失败路径都不会触发。
  useLayoutEffect(() => {
    if (!revealFieldRef.current) return
    revealFieldRef.current = false
    const el = document.querySelector('[aria-invalid="true"]')
    if (!el) return
    // 面板被 section[hidden] 隐藏时 rect 全为 0：不在这里拽页面。
    if (!el.getBoundingClientRect().height) return
    el.focus({ preventScroll: true })
    const tabs = document.querySelector('.tabs')
    const pad = (tabs ? tabs.getBoundingClientRect().height : 0) + 8
    const top = el.getBoundingClientRect().top + window.scrollY - pad
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    window.scrollTo(0, Math.max(0, Math.min(top, max)))
  }, [fieldErrors])

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

  // 复制默认会拿 base 覆盖 draft；有脏草稿时先问一句，别让一个按钮把编辑内容吃掉。
  const askCopyDefaults = () => {
    if (!data || !base || busy) return
    if (dirtyFields.length > 0) {
      setDialog({ kind: 'copyDefaults' })
      return
    }
    copyDefaults()
  }

  // 用户明确选择「不保存并离开」：把草稿退回 base，并立刻关掉拦截（历史后退不会等 React 重渲染）。
  const discardDraft = useCallback(() => {
    allowLeaveRef.current = true
    guardPushedRef.current = false
    dirtyRef.current = false
    clearFilterDraft()
    setDraftSavedAt(0)
    clearServerDraft()
    if (guardRef && guardRef.current) {
      guardRef.current.dirty = false
      guardRef.current.count = 0
    }
    if (base) setDraft({ ...base })
    setFieldErrors({})
    setPreview(null)
    setDialog(null)
    setNotice({ tone: 'warn', text: '已放弃未保存的修改。' })
  }, [base, guardRef])

  // 取消/去保存后重新压一条 sentinel，下一次左滑仍然能拦。当前已经是 sentinel 就不重复压。
  const restoreHistory = useCallback(() => {
    allowLeaveRef.current = false
    if (window.history.state && window.history.state.__xbkFilterGuard) {
      guardPushedRef.current = true
      return
    }
    guardPushedRef.current = true
    window.history.pushState({ ...(window.history.state || {}), __xbkFilterGuard: true }, '', window.location.href)
  }, [])

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
      clearFilterDraft()
      setDraftSavedAt(0)
      clearServerDraft()
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
    clearFilterDraft()
    setDraftSavedAt(0)
    load().catch(() => {})
  }

  // 用户确认「放弃并重新加载」：先清本地草稿、把 dirtyRef 放行，等服务器草稿删除
  // 落地后再 load；否则 GET 可能抢在 DELETE 前面把旧草稿又拉回来。
  const reloadNow = async () => {
    if (busy) return
    clearFilterDraft()
    setDraftSavedAt(0)
    dirtyRef.current = false
    allowLeaveRef.current = true
    if (base) setDraft({ ...base })
    setFieldErrors({})
    setPreview(null)
    setDialog(null)
    setNotice(null)
    await clearServerDraft()
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
    if (dialog.kind === 'copyDefaults') {
      return html`<${ConfirmDialog} open=${true} title="复制默认规则会覆盖草稿"
        confirmLabel=${busy === 'copy' ? '复制中…' : '放弃草稿并复制'} busy=${busy === 'copy'}
        onCancel=${closeDialog}
        onConfirm=${() => { setDialog(null); copyDefaults() }}>
        <div class="fr-dialog-line">当前有 ${dirtyFields.length} 个字段未保存；复制代码默认会把这些修改覆盖掉。</div>
        <div class="modal-note">复制后写入覆盖文件，下一轮生效。</div>
      <//>`
    }
    if (dialog.kind === 'restore') {
      return html`<${ConfirmDialog} open=${true} title="确认回滚过滤规则"
        confirmLabel=${busy === 'restore' ? '回滚中…' : dirtyFields.length > 0 ? '放弃草稿并回滚' : '确认回滚'} busy=${busy === 'restore'}
        onCancel=${closeDialog}
        onConfirm=${() => doRestore(dialog.to, dialog.baseRevision)}>
        <div class="fr-dialog-line">${dialog.to === 'default'
          ? '写入空覆盖文件（filter:{}、revision+1）恢复代码默认，不删除文件——revision 与备份列表保持连续。'
          : `用备份 r${dialog.to} 的内容写入新 revision（revision 只增不减，线性历史）。`}</div>
        ${dirtyFields.length > 0 && html`<div class="fr-wide-warn" role="alert">当前有 ${dirtyFields.length} 个字段未保存；回滚会用服务端版本覆盖草稿。</div>`}
        <div class="modal-note">回滚前会先备份当前配置（r${dialog.baseRevision}）；同样下一轮生效，当前正在跑的一轮不换规则。</div>
      <//>`
    }
    if (dialog.kind === 'reload') {
      return html`<${ConfirmDialog} open=${true} title="放弃未保存的修改？"
        confirmLabel="放弃并重新加载" busy=${false}
        onCancel=${closeDialog}
        onConfirm=${() => { setDialog(null); reloadNow() }}>
        <div class="fr-dialog-line">当前有 ${dirtyFields.length} 个字段尚未保存，重新加载会丢弃这些修改。</div>
      <//>`
    }
    return null
  }

  useEffect(() => () => { if (guardRef) guardRef.current = null }, [guardRef])
  if (guardRef) {
    guardRef.current = {
      dirty,
      count: dirtyFields.length,
      busy: !!busy,
      save: beginSave,
      discard: discardDraft,
      restoreHistory
    }
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
        ${dirty && draftSavedAt > 0 && html`<span class="fr-status-item"><span class="fr-status-muted">草稿已自动保存 · ${draftSyncedAt > 0 ? '本机+服务器' : '本机'} · ${fmtLocalTime(draftSavedAt).slice(11)}</span></span>`}
        ${slowLoading && html`<span class="fr-status-muted">刷新中…</span>`}
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
        <${Button} variant="primary" disabled=${!!busy || loading} onClick=${askCopyDefaults}>把当前规则复制到覆盖文件<//>
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
          <span class="fr-label">回滚目标</span>
          <${MiniSelect} value=${restoreTo} ariaLabel="回滚目标" disabled=${!!busy || loading}
            options=${[
              { value: 'default', label: '恢复代码默认（写入空覆盖文件）' },
              ...backups.map((r) => ({ value: String(r), label: `备份 r${r}` }))
            ]}
            onChange=${setRestoreTo} />
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

// ── 回到顶部（v3.321）──────────────────────────────────────────────────────
// 推送记录/逐轮历史/日志都远超一屏，手机滚到深处后没有回顶入口（iOS 可点状态栏，
// Android 只能一路往回拖）。固定按钮：不参与文档流 ⇒ 出现/消失都不改页高；超过
// TOP_SHOW_Y 才出现，回到顶部后自己消失。z-index 35 在吸顶页签(30)之上、浮层(45)/
// 确认弹窗遮罩(80)之下，展开选择器或弹窗时不会盖住它们；隐藏态连 pointer-events 一并
// 关掉，免得一个看不见的按钮吃掉列表末尾的点击。
const TOP_SHOW_Y = 320
// 日志页的日志框是内层滚动容器：页面停在顶部时只在框里滚，window.scrollY 一直是 0，
// 只看整页滚动就不出按钮（Sourcery #284）。内层滚过一屏的 1/8 也算「滚深了」。
const TOP_SHOW_INNER = 80
const LOG_SCROLLER = '.logpre-main'
function BackToTop () {
  const [show, setShow] = useState(false)
  const rafRef = useRef(0)
  useEffect(() => {
    const read = () => {
      rafRef.current = 0
      const box = document.querySelector(LOG_SCROLLER)
      const next = (window.scrollY || 0) > TOP_SHOW_Y || Boolean(box && box.scrollTop > TOP_SHOW_INNER)
      setShow((prev) => (prev === next ? prev : next))
    }
    const onScroll = () => {
      // rAF 合并：手机惯性滚动一帧能来好几个 scroll 事件，别每个都 setState。
      if (rafRef.current) return
      rafRef.current = window.requestAnimationFrame(read)
    }
    read()
    // scroll 不冒泡：捕获阶段才收得到 .logpre-main 的滚动，否则日志框滚到底也不出按钮。
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    }
  }, [])
  const toTop = () => {
    // 回顶后按钮自己隐藏：先把焦点交给当前页签，否则键盘/读屏用户的焦点会掉到 body。
    const activeTab = document.querySelector('.tab-btn.active')
    if (activeTab && typeof activeTab.focus === 'function') activeTab.focus({ preventScroll: true })
    // 日志页：内层日志框一起回到第一行，只滚整页的话用户仍停在日志末尾。
    const box = document.querySelector(LOG_SCROLLER)
    if (box) box.scrollTop = 0
    const reduce = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    // 老 Safari 没有 scrollBehavior，传 options 会被当成 (x, y) 静默失败。
    const behavior = backToTopBehavior(reduce, 'scrollBehavior' in document.documentElement.style)
    if (behavior) window.scrollTo({ top: 0, behavior })
    else window.scrollTo(0, 0)
  }
  return html`<button type="button" class=${'to-top' + (show ? ' show' : '')}
    aria-label="回到顶部" title="回到顶部" tabindex=${show ? '0' : '-1'}
    aria-hidden=${show ? 'false' : 'true'} onClick=${toTop}>↑</button>`
}

// ── 主题（v3.323）──────────────────────────────────────────────────────────
// 4 套配色只换 token（见 app.css 的 data-theme 块），不动布局。首帧由服务端把
// cookie 里的选择写进 <html data-theme>——CSP 是 script-src 'self'，不能在 head
// 里内联读 localStorage，否则浅色主题每次加载都会先闪一帧深色。
const THEMES = [
  { key: 'deep', label: '深夜' },
  { key: 'material', label: '材质' },
  { key: 'nord', label: '北境' },
  { key: 'light', label: '明亮' }
]
const THEME_COOKIE = 'xbk_theme'
function currentThemeKey () {
  const t = document.documentElement.getAttribute('data-theme')
  return THEMES.some((x) => x.key === t) ? t : 'deep'
}
function readThemeCookie () {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(THEME_COOKIE + '='))
  const value = hit ? hit.slice(THEME_COOKIE.length + 1) : ''
  return THEMES.some((x) => x.key === value) ? value : ''
}
function applyThemeKey (key) {
  document.documentElement.setAttribute('data-theme', key)
  try {
    document.cookie = THEME_COOKIE + '=' + key + '; Path=/; Max-Age=31536000; SameSite=Lax'
  } catch (e) {
    // 沙箱/禁用 Cookie 的上下文（opaque origin）会在这里抛：本页照样能切，
    // 只是刷新后回到服务端默认。绝不能让它挡住下面的 setTheme。
  }
}

function App () {
  const [state, setState] = useState(null)
  const [runs, setRuns] = useState([])
  // 主题：初值取服务端写进 <html data-theme> 的键（非法值回落 deep）。
  const [theme, setTheme] = useState(currentThemeKey)
  // 触发历史是否已经成功加载过：首次请求未回/失败时不能显示「暂无触发记录」，
  // 否则会把「还不知道」谎报成「确实没有」（Sourcery #254）。
  const [runsState, setRunsState] = useState('loading') // loading | ok | error
  const [busy, setBusy] = useState(false)
  // 服务器端自动运行状态：调度/持久化都在控制台进程，页面只读展示。
  const [autoState, setAutoState] = useState(null)
  const [autoNow, setAutoNow] = useState(Date.now())
  const [lastSync, setLastSync] = useState(null)
  // 非概览页的「数据截至」按页签缓存：每个页签只认自己的成功加载时间，
  // 切回已来过的页签先显示上次时间，首次进入/加载失败显示「数据截至 · —」。
  const [panelSync, setPanelSync] = useState(null)
  // 单调时钟：本次成功加载的时刻，只用于释放滚动垫高；不受系统时钟回拨影响。
  const [panelReadyAt, setPanelReadyAt] = useState(0)
  const [syncErr, setSyncErr] = useState('')
  // 「状态接口本身失败」要立刻反映到状态卡的占位文案上：/api/runs 可能还在路上，
  // 不能等 Promise.allSettled 两边都落定才把「正在读取…」改成「读取失败」。
  const [statusFailed, setStatusFailed] = useState(false)
  // 标签页写 hash（v3.307）：刷新/后退不丢当前页；初始值从 hash 读，非法值回概览。
  // v3.310「过滤规则」新增为第六个页签。pure.mjs 的 tabFromHash 只认 v3.307 的五个键
  // （该模块本批不改），这里补一层本文件内的白名单，保持 hash 路由对新页签同样生效
  // （刷新/后退不丢当前页；非法值仍回概览）。
  const resolveTab = (hash) => (/^#\/filter$/.test(typeof hash === 'string' ? hash : '') ? 'filter' : tabFromHash(hash))
  const [tab, setTab] = useState(() => resolveTab(window.location.hash))
  // 过滤页草稿守卫：脏状态、保存、放弃由面板写进这个 ref，App 只在切页/后退前问一句。
  // 不用 state 是因为每敲一个字都 dirty，App 不需要跟着重渲染。
  const [leaveRequest, setLeaveRequest] = useState(null)
  const filterGuardRef = useRef(null)
  const requestFilterLeave = useCallback((req) => {
    setLeaveRequest((cur) => cur || req)
  }, [])
  // 页签保活：第一次进入才挂载，之后切走只加 hidden、不卸载。切回已看过的页签时
  // 面板与数据都还在，文档高度不会在「卸载→挂载」的两帧之间塌成视口高。
  // 这是网关（WorkBuddy）切换丝滑的原因：它也是所有 page 常驻、只 toggle 可见性。
  const [visited, setVisited] = useState(() => new Set([resolveTab(window.location.hash)]))
  const visitedRef = useRef(visited)
  // 「真正点开过」的页签（用于滚动锚定）。预加载会把六个页签都挂上，但没点开过的页
  // 仍要按首访处理：先垫高，等内容/预加载落定再落位，避免点击瞬间文档变矮被夹到顶部
  // （Sourcery #272）。
  const enteredRef = useRef(new Set([resolveTab(window.location.hash)]))
  const markVisited = useCallback((key) => {
    if (visitedRef.current.has(key)) return
    // 不能先改 visitedRef.current 再交给 setVisited：那样 ref 与 state 是同一个 Set，
    // 更新器里 prev.has(key) 恒为真，会返回旧集合，state 实际上没换新（只靠 setTab
    // 顺带重渲染才碰巧能看见）。这里先复制，再同时替换 ref 与 state。
    const next = new Set(visitedRef.current)
    next.add(key)
    visitedRef.current = next
    setVisited(next)
  }, [])
  // 跳日志请求：{q, mode, n}。n 只用来做 key，重复点同一行也能强制重挂载。
  const [logJump, setLogJump] = useState(null)
  // 自动刷新开关（v3.307）：默认开；暂停后顶部倒计时停住，手动「继续」恢复。
  const [autoRefresh, setAutoRefresh] = useState(true)
  // v3.342：顶栏时间是否带年月日。值存在服务端 console-settings.json（系统页「设置」里改），
  // 这里只缓存一份给顶栏渲染；保存后由 onSettingsSaved 重拉。
  const [showDate, setShowDate] = useState(true)
  // 设置读面：并发读可能乱序（首帧读还在飞、保存后又读一次），旧响应不得覆盖新值。
  // 用 revision 判定：revision 更小的响应一律丢弃（Sourcery #303 M7/M9）。
  const uiSettingsRevRef = useRef(-1)
  const applyUiSettings = useCallback((body) => {
    if (!body || !body.settings || typeof body.settings.syncShowDate !== 'boolean') return
    const rev = Number.isSafeInteger(body.revision) ? body.revision : uiSettingsRevRef.current
    if (rev < uiSettingsRevRef.current) return
    uiSettingsRevRef.current = rev
    setShowDate(body.settings.syncShowDate)
  }, [])
  const reloadUiSettings = useCallback(() => {
    // consumeJson 直接回 body（不是 { ok, data }），别按写面 consumeJsonResult 的形状取。
    apiGetConsoleSettings().then((body) => {
      applyUiSettings(body)
    }).catch(() => {})
  }, [applyUiSettings])
  useEffect(() => { reloadUiSettings() }, [reloadUiSettings])
  // 凭证失效（审查 #224）：任一 API 401 ⇒ 停轮询并显示自助恢复提示，不再每 5s 空打。
  const [authExpired, setAuthExpired] = useState(false)
  const [nextAt, setNextAt] = useState(0)
  // v3.348：共享轮询节拍。非概览/日志页的数据在各面板里，App 每拍 +1，当前面板据此重拉。
  const [pollTick, setPollTick] = useState(0)
  // v3.332：部署后旧标签页仍在跑旧脚本，数据轮询却照常更新 ⇒ 用户以为「改了没生效」。
  // boot 里带页面启动版本；每 60s 与 /api/sys 对一次，不一致就提示刷新。
  const [newVersion, setNewVersion] = useState('')
  useEffect(() => {
    const bootVersion = BOOT.version
    // 凭证失效后不再探针：每次 401 都会派发 auth-expired 事件并多记一条未授权访问日志。
    if (!bootVersion || authExpired) return undefined
    let stopped = false
    let seq = 0
    let done = 0
    const check = () => {
      if (stopped || document.visibilityState === 'hidden') return
      const mine = ++seq
      apiGetSys({ probeVersion: true }).then((s) => {
        if (stopped || mine < done) return // 乱序响应：旧请求不得覆盖新判定
        done = mine
        const v = s && typeof s.version === 'string' ? s.version : ''
        // 与启动版本重新对齐（回滚也算）就收起提示，别留一条过期横幅。
        setNewVersion(v !== '' && v !== bootVersion ? v : '')
      }).catch(() => {})
    }
    check()
    const timer = setInterval(check, VERSION_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [authExpired])
  // 首屏渲染完就把六个页签全部挂上（隐藏），让它们的数据先加载。这样刷新网页后
  // 第一次点某个页签也只是切 hidden，而不是「现挂载 + 现请求」闪一下加载占位。
  // 各面板的 active 门控保证隐藏期间不轮询；这里只承担一次首载。
  useEffect(() => {
    if (authExpired) return
    for (const t of TABS) markVisited(t.key)
  }, [authExpired, markVisited])
  // 表单交互暂停轮询的截止时间（见下方 focusin/change/input 监听）。不能只看
  // activeElement：用户选完下拉后焦点仍停在 select 上，会永久冻住自动刷新。
  const formPauseUntilRef = useRef(0)
  const timerRef = useRef(null)
  // 最近一次「数据真的刷新过」的时间：回前台补拉、轮询、下拉都更新它。
  const lastRefreshRef = useRef(Date.now())
  const tabsRef = useRef(null)
  // 标签栏边缘渐隐状态（v3.317）：'' | 'left' | 'right' | 'both'。只在真的溢出时挂
  // data-edge，362 宽（6 个页签全部放得下）保持零遮罩——否则最后一格会被误读成被裁掉。
  const [tabEdge, setTabEdge] = useState('')
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

  // 每个页签记住自己的「数据截至」：切回已来过的页签时先显示上次时间，
  // 不再先闪一下「手动刷新」再跳成时间。第一次进入才显示占位符。
  const syncMemRef = useRef({})

  // 切页的滚动策略（修 #260 的二次跳动）：
  // 1) 每个页签记住自己的 scrollY；第一次进入的页签沿用当前视口位置（#260 的初衷：
  //    切页不把整页拽回顶部），只有「查看日志」才强制回顶。
  // 2) 返回已来过的页签时，切页前先给 #app 垫一个 min-height = y + innerHeight。
  //    旧面板卸载、新面板还在 loading 的那一帧文档不会塌陷，scrollY 也就不会被
  //    浏览器夹到 0；随后在 useLayoutEffect（绘制前）同步 scrollTo(y)。垫高一直
  //    留到新面板真正撑到目标高度（ResizeObserver 盯着内容增长，慢加载也不提前撤），
  //    这样全程没有「先回顶、再弹回去」的两段跳。目标页比记忆位置矮时，等它报加载
  //    完成再落到它自己的最大滚动位置，不空等 4s。
  // 3) 「查看日志」（logJump）是一次性的强制回顶；消费掉之后，后续切页仍按记忆还原。
  const scrollMemRef = useRef({})
  const pendingScrollRef = useRef(null)
  // 本次切页是否为「首访」：首访要等面板加载、内容长高，才需要垫高文档；
  // 已来过的页签整棵面板都还在 DOM 里，切过去高度是现成的，直接落位即可。
  const pendingFirstVisitRef = useRef(false)
  const scrollHoldRef = useRef(null)
  const logJumpPendingRef = useRef(false)
  // 日志跳转代次：主动切页/后退/新的跳转都会 ++，迟到的 /api/logs 响应据此作废。
  const logJumpSeqRef = useRef(0)
  const tabRef = useRef(tab)
  tabRef.current = tab
  // 每个面板只接受「自己这一页」的完成回调：切走后旧请求再回包，不碰新页的垫高。
  const syncFor = useMemo(() => {
    const make = (key) => (ts) => {
      if (typeof ts === 'number') syncMemRef.current[key] = ts
      if (tabRef.current === key) {
        setPanelSync(ts)
        setPanelReadyAt(performance.now())
      }
    }
    return { messages: make('messages'), logs: make('logs'), config: make('config'), filter: make('filter') }
  }, [])
  // 切页时同步换成目标页签自己的时间（没有就占位），同一帧内完成，不闪上一页/手动刷新。
  const showSyncFor = useCallback((next) => {
    const ts = syncMemRef.current[next]
    setPanelSync(typeof ts === 'number' ? ts : null)
  }, [])
  // 系统页由两个面板组成（SysPanel + FilesPanel）；两边都落定才允许释放垫高。
  const sysReadyRef = useRef(null)
  const markSysReady = useCallback((key) => {
    if (tabRef.current !== 'sys') return
    if (!sysReadyRef.current) sysReadyRef.current = new Set()
    sysReadyRef.current.add(key)
    if (sysReadyRef.current.size < 2) return
    const ts = Date.now()
    syncMemRef.current.sys = ts
    setPanelSync(ts)
    setPanelReadyAt(performance.now())
  }, [])
  // v3.349：系统页的「数据截至」只在本拍两块数据都成功时才推进——
  // 一块失败时停在上一轮完整刷新，别把半个新数据冒充整页新数据（Sourcery #303 M4）。
  const freshRef = useRef({ tick: -1, ok: {} })
  const onFresh = useCallback((key, ok, tick) => {
    const r = freshRef.current
    if (r.tick !== tick) { r.tick = tick; r.ok = {} }
    r.ok[key] = !!ok
    if (r.ok.sys && r.ok.files) {
      const ts = Date.now()
      syncMemRef.current.sys = ts
      setPanelSync(ts)
    }
  }, [])
  const onSysReady = useCallback(() => markSysReady('sys'), [markSysReady])
  const onFilesReady = useCallback(() => markSysReady('files'), [markSysReady])
  const holdScroll = (y) => {
    const el = document.getElementById('app')
    if (!el) return
    el.style.minHeight = y > 0 ? `${y + window.innerHeight}px` : ''
  }
  // 切页后的 1s 内关掉 scroll anchoring：新面板常分几批长高，锚定会把
  // scrollY 每次往上补一截（实测日志↔配置每来回一次 +26px，越切越往下漂）。
  // 只关这一小段，页面稳定后恢复，避免横幅/告警插入时正文跟着上下滑。
  const anchorTimerRef = useRef(0)
  const holdAnchor = () => {
    if (anchorTimerRef.current) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = 0
    document.documentElement.style.overflowAnchor = 'none'
  }
  const releaseAnchorSoon = () => {
    if (anchorTimerRef.current) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = 0
      document.documentElement.style.overflowAnchor = ''
    }, 1000)
  }
  const releaseScrollHold = () => {
    const hold = scrollHoldRef.current
    if (hold) {
      scrollHoldRef.current = null
      if (hold.raf) window.cancelAnimationFrame(hold.raf)
      if (hold.timer) window.clearTimeout(hold.timer)
      if (hold.ro) hold.ro.disconnect()
      window.removeEventListener('wheel', hold.onUser, true)
      window.removeEventListener('touchstart', hold.onUser, true)
      window.removeEventListener('pointerdown', hold.onUser, true)
      window.removeEventListener('keydown', hold.onUser, true)
    }
    // 过渡期临时关掉滚动锚定：旧面板卸载时它在背后微调 scrollY，
    // 会把「用户自己滚走了」的判据误触发。切页后 1s 再恢复。
    releaseAnchorSoon()
    const el = document.getElementById('app')
    if (el) el.style.minHeight = ''
  }
  // 切页前统一登记：保存出发页位置、决定目标页位置、需要时先垫高。
  // 只改 ref 与 #app 的临时样式，不触发 React 渲染；调用方随后 setTab。
  const prepareScroll = (next, { forceTop = false } = {}) => {
    const from = tabRef.current
    const y = window.scrollY
    if (from && from !== next) scrollMemRef.current[from] = y
    const firstVisit = !enteredRef.current.has(next)
    enteredRef.current.add(next)
    const mem = scrollMemRef.current[next]
    // 第一次进入沿用当前视口；只有 forceTop（查看日志）才回 0。
    const target = forceTop ? 0 : (typeof mem === 'number' ? mem : y)
    pendingScrollRef.current = target
    pendingFirstVisitRef.current = firstVisit
    sysReadyRef.current = null
    releaseScrollHold()
    // 只有首访的页面还处在「正在挂载/加载」状态，才需要先垫高；已保活的页面
    // 整棵 DOM 都在，切过去就是最终高度，垫高反而会把视口钉在空白处。
    if (firstVisit && target > 0) holdScroll(target)
  }
  const prepareScrollRef = useRef(prepareScroll)
  prepareScrollRef.current = prepareScroll
  useLayoutEffect(() => {
    if (logJumpPendingRef.current) {
      logJumpPendingRef.current = false
      // openLog 已经把 pendingScrollRef 置 0、pendingFirstVisitRef 置 true；这里直接
      // 回顶后必须一并清掉，否则之后清 logJump 让 effect 重跑时会消费这个 stale 0，
      // 把已在日志页滚动的用户再拽回顶部（审查 must-fix #3）。
      pendingScrollRef.current = null
      pendingFirstVisitRef.current = false
      // v3.319：行级跳转不再死回顶部——滚到定位条下方，保证被高亮的那一轮在首屏可见。
      // 日志框最高 520px，手机上框底会伸到视口外；只把框内滚到中间，行仍可能在屏幕外。
      let y = 0
      if (logJump && logJump.focus) {
        const banner = document.querySelector('.log-focus')
        if (banner) {
          const tabs = document.querySelector('.tabs')
          const pad = (tabs ? tabs.getBoundingClientRect().height : 0) + 8
          const startY = window.scrollY
          y = Math.max(0, banner.getBoundingClientRect().top + startY - pad)
          // 末尾几轮贴在日志框底部：只把定位条顶到 tabs 下，高亮行仍可能露在屏幕外。
          const line = document.querySelector('.logline-focus')
          if (line) {
            const bottomAfter = line.getBoundingClientRect().bottom - (y - startY)
            const vh = window.innerHeight || document.documentElement.clientHeight
            if (bottomAfter > vh - 12) y += bottomAfter - (vh - 12)
          }
        }
      }
      scrollMemRef.current[tab] = y
      holdAnchor()
      releaseScrollHold()
      window.scrollTo(0, y)
      return
    }
    const y = pendingScrollRef.current
    pendingScrollRef.current = null
    const firstVisit = pendingFirstVisitRef.current
    pendingFirstVisitRef.current = false
    if (typeof y !== 'number') return
    if (y <= 0) {
      // 回顶也要挡住锚定：新面板内容若在顶部上方插入，浏览器会把你从 0 挪走。
      holdAnchor()
      releaseScrollHold()
      window.scrollTo(0, 0)
      return
    }
    // 已保活的页签：目标页整棵 DOM 还在，文档高度就是最终高度，绘制前直接落到
    // 记忆位置（比内容矮时落到它的最大滚动位置）。没有挂载/加载窗口，也就没有
    // 需要垫高的塌陷，不需要 hold。
    if (!firstVisit) {
      holdAnchor()
      releaseScrollHold()
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo(0, Math.min(y, maxScroll))
      releaseAnchorSoon()
      return
    }
    // 垫高已生效：这里同步还原，绘制前就到位，不会先出现塌陷后的 0。
    holdAnchor()
    window.scrollTo(0, y)
    const t0 = performance.now()
    const hold = { y, user: false, raf: 0, timer: 0, ro: null, onUser: null, check: null, startedAtMono: performance.now() }
    hold.onUser = () => { hold.user = true; if (hold.check) hold.check() }
    window.addEventListener('wheel', hold.onUser, { capture: true, passive: true })
    window.addEventListener('touchstart', hold.onUser, { capture: true, passive: true })
    window.addEventListener('pointerdown', hold.onUser, { capture: true, passive: true })
    window.addEventListener('keydown', hold.onUser, true)
    const check = (settled = false) => {
      if (scrollHoldRef.current !== hold) return
      // 用户接管后不再钉住位置；但垫高先留着，等内容长到能接住当前视口再撤，
      // 否则撤早了浏览器会把 scrollY 夹回 0，用户的滚动直接丢。
      if (!hold.user && Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y)
      const foot = document.querySelector('.foot')
      const bottom = foot ? foot.getBoundingClientRect().bottom + window.scrollY : 0
      const need = (hold.user ? window.scrollY : y) + window.innerHeight
      const ready = bottom >= need
      // settled：目标面板已确认所有首批请求都结束。内容仍撑不到记忆位置时收口；
      // 用户自己已经滚过就不替他改位置，只撤垫高（浏览器会按内容高度自然夹取）。
      if (ready || settled || performance.now() - t0 > 9000) {
        if (settled && !hold.user && !ready && bottom > 0) {
          window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
        }
        releaseScrollHold()
      }
    }
    hold.check = check
    hold.ro = window.ResizeObserver ? new window.ResizeObserver(() => check()) : null
    const wrap = document.querySelector('.wrap')
    if (hold.ro && wrap) hold.ro.observe(wrap)
    scrollHoldRef.current = hold
    check()
    // 加载失败/永远撑不起来时，到点释放，避免一直留着一块空白。
    // 9s 比 fetch 的 8s 超时略长：正常响应（哪怕很慢）一定先报 settled。
    if (scrollHoldRef.current === hold) hold.timer = window.setTimeout(check, 9000)
    // 没有 ResizeObserver 的老环境：用 rAF 轮询兜底（9s 到点后 check 会自停）。
    if (!hold.ro) {
      const loop = () => {
        hold.raf = 0
        if (scrollHoldRef.current !== hold) return
        check()
        if (scrollHoldRef.current === hold) hold.raf = window.requestAnimationFrame(loop)
      }
      hold.raf = window.requestAnimationFrame(loop)
    }
  }, [tab, logJump])

  useEffect(() => () => {
    if (anchorTimerRef.current) window.clearTimeout(anchorTimerRef.current)
    document.documentElement.style.overflowAnchor = ''
  }, [])

  // 目标面板报「加载完成」后，如果它的内容撑不到记忆位置，就地落到最大滚动位置；
  // 只认切页后新面板写入的 panelReadyAt（单调时钟）：缓存时间/上一页在途响应
  // 都不会把垫高提前撤掉，系统时钟回拨也不影响。
  useEffect(() => {
    const hold = scrollHoldRef.current
    if (hold && panelReadyAt >= hold.startedAtMono) hold.check(true)
  }, [panelReadyAt])

  // 标签栏是单行横滚：切页、旋转屏幕或改窗口宽度后都要把当前页签滚进可视区，
  // 否则活动页签会停在滚动容器的裁剪边之外（Sourcery #260）。只改 .tabs 的
  // scrollLeft，不碰页面滚动；sticky 栏本身始终在视口里。
  // v3.317：改由 scrollIntoView({inline:'nearest', preventScroll:true}) 做同一件事
  // （浏览器只在需要时挪最近的滚动容器），并顺带刷新左右渐隐状态。
  const syncTabEdge = useCallback(() => {
    const bar = tabsRef.current
    if (!bar) return
    const max = bar.scrollWidth - bar.clientWidth
    if (max <= 1) { setTabEdge(''); return }
    const left = bar.scrollLeft > 1
    const right = bar.scrollLeft < max - 1
    setTabEdge(left && right ? 'both' : left ? 'left' : right ? 'right' : '')
  }, [])
  useLayoutEffect(() => {
    const bar = tabsRef.current
    if (!bar) return undefined
    const adjust = () => {
      const el = bar.querySelector('.tab-btn.active')
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ inline: 'nearest', block: 'nearest', preventScroll: true })
      }
      syncTabEdge()
    }
    adjust()
    window.addEventListener('resize', adjust)
    bar.addEventListener('scroll', syncTabEdge, { passive: true })
    const ro = window.ResizeObserver ? new window.ResizeObserver(adjust) : null
    if (ro) ro.observe(bar)
    return () => {
      window.removeEventListener('resize', adjust)
      bar.removeEventListener('scroll', syncTabEdge)
      if (ro) ro.disconnect()
    }
  }, [tab, syncTabEdge])

  // vwD：逐请求独立收口——status 失败时 runs 结果仍可用（反之亦然）；
  // 并行发出（Sourcery G_n6）：串行 await 会让慢端点拖住另一端点的更新。
  // 乱序防护（Sourcery vwE）：每次 refresh 领号，落后响应直接丢弃（落后 ≠ 失败，
  // 落后者静默丢弃不报错——Sourcery vwB：报「刷新失败」是误导）。
  const refreshSplit = useCallback(async (opts = {}) => {
    // 表单交互暂停期间不发起刷新；已在途的响应也会在下方 apply 前被丢弃。
    // 下拉刷新是明确的手势意图，传 { force: true } 跨过这段暂停。
    if (!(opts && opts.force) && Date.now() < formPauseUntilRef.current) return false
    if (inFlightRef.current) {
      // 切回概览时若上一轮还在路上，标记一次补刷，等 finally 再跑。
      pendingRefreshRef.current = true
      return false
    }
    inFlightRef.current = true
    const seq = ++seqRef.current
    const errs = []
    const paused = () => !(opts && opts.force) && Date.now() < formPauseUntilRef.current
    const applyStatus = (s) => { if (seq === seqRef.current && !paused()) { setState(s); setSyncErr(''); setStatusFailed(false) } }
    const applyRuns = (r) => {
      if (seq === seqRef.current && !paused()) {
        setRuns(r.runs || [])
        setLastSync(Date.now())
        setRunsState('ok')
      }
    }
    try {
      // 状态请求单独挂一个拒绝分支：/api/runs 还慢着的时候也要立刻把占位卡改成「读取失败」，
      // 不能等两边都落定（Sourcery PR #292）。
      const statusP = apiGetStatus().then(
        (v) => { if (seq === seqRef.current && !paused()) { setStatusFailed(false) }; return v },
        (e) => { if (seq === seqRef.current && !paused()) { setStatusFailed(true) }; throw e }
      )
      const [sRes, rRes] = await Promise.allSettled([
        statusP,
        apiGetRuns()
      ])
      if (sRes.status === 'fulfilled') applyStatus(sRes.value)
      else errs.push(`状态 ${sRes.reason && sRes.reason.message ? sRes.reason.message : sRes.reason}`)
      if (rRes.status === 'fulfilled') applyRuns(rRes.value)
      else {
        errs.push(`历史 ${rRes.reason && rRes.reason.message ? rRes.reason.message : rRes.reason}`)
        if (seq === seqRef.current) setRunsState((s) => (s === 'ok' ? 'ok' : 'error'))
      }
      if (seq !== seqRef.current || paused()) return false
      refreshedOnceRef.current = true
      if (errs.length > 0) setSyncErr(`刷新失败：${errs.join('；')}（自动重试中）`)
      else setSyncErr('')
      // 只有两边都落定才算「刷新成功」：调用方（回前台补拉）据此决定要不要推进时间戳。
      return errs.length === 0
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
    // v3.348：所有页都轮询（用户要求：推送记录/配置/过滤规则/系统 的「自动刷新」必须真的在跑）。
    // 概览/日志拉状态与历史；其余页由统一 tick 让当前面板重拉自己的数据。
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
        if (tab !== 'overview' && tab !== 'logs') setPollTick((t) => t + 1)
        mark()
      }
    }
    timerRef.current = setInterval(tick, interval)
    mark()
    // 回前台一律交给「回前台补拉」统一判断（>VISIBLE_STALE_MS 才拉）：
    // 这里只把下一拍的时间重排，避免刚回来就立刻又打一发。
    const onVis = () => {
      if (document.visibilityState === 'visible') mark()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refreshSplit, locking, tab, autoRefresh, authExpired])

  // hash 路由（v3.307）：首次进入补 #/overview；前进/后退跟着切页。
  useEffect(() => {
    // 后退/前进的滚动位置由本页的 per-tab 记忆负责；浏览器默认的
    // scrollRestoration='auto' 会在 layout effect 之后再按历史条目恢复一次，
    // 把刚还原好的位置覆盖掉（实测 forward 回到长页被压回旧位置）。
    const prevRestoration = window.history.scrollRestoration
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    const onHash = () => {
      const next = resolveTab(window.location.hash)
      if (next === tabRef.current) return
      // 过滤页有未保存草稿：先把地址改回去，再问「保存 / 不保存 / 取消」。
      // 手机左滑/浏览器后退通常会先撞到面板压的 sentinel，这里是第二道保险。
      if (next !== 'filter' && tabRef.current === 'filter') {
        const guard = filterGuardRef.current
        if (guard && guard.dirty) {
          window.history.replaceState(null, '', '#/filter')
          setLeaveRequest((cur) => cur || { target: next, source: 'hash' })
          return
        }
      }
      // 后退/前进也算主动切页：作废在飞的日志跳转，迟到的响应不得再改页。
      logJumpSeqRef.current++
      // 系统页每次进入都重新等两个面板，不能拿上一次的 ready 集合提前收口。
      if (next === 'sys') sysReadyRef.current = null
      // 后退/前进也走同一套记忆与垫高，不再绕过 switchTab 丢失还原。
      prepareScrollRef.current(next)
      markVisited(next)
      showSyncFor(next)
      setTab(next)
      tabRef.current = next
    }
    if (!window.location.hash) window.history.replaceState(null, '', '#/overview')
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      if ('scrollRestoration' in window.history) window.history.scrollRestoration = prevRestoration
    }
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

  const autoSeqRef = useRef(0)
  const refreshAuto = useCallback(async () => {
    const seq = ++autoSeqRef.current
    try {
      const data = await apiGetAuto()
      // 乱序响应：回前台补拉比先前的轮询更晚发出时，旧响应不得覆盖新状态。
      if (seq === autoSeqRef.current && data && data.auto) setAutoState(data.auto)
    } catch (e) { /* 轮询失败保留上次状态；401 由全局事件处理 */ }
  }, [])

  // 下拉刷新（v3.330）：不出页面、不重建 DOM。先广播给当前页签的面板收集各自 loader，
  // 再等主轮询（状态+轮次）、自动运行状态与所有面板一起落定，指示条才收起。
  const refreshActive = useCallback(async (opts = {}) => {
    const force = opts.force === true
    // 回前台补拉要避开表单交互（原生下拉展开时整页重渲染会卡住选择器）；
    // 下拉手势是明确意图，传 force 跨过这段暂停。
    if (opts.respectFormPause && Date.now() < formPauseUntilRef.current) return false
    const detail = { waits: [] }
    window.dispatchEvent(new CustomEvent(PULL_EVENT, { detail }))
    // 没有任何面板接手（如过滤规则页有未保存改动）：连全局请求也不发，下拉就当无事。
    if (detail.waits.length === 0) return false
    const [sRes] = await Promise.allSettled([refreshSplit(force ? { force: true } : undefined), refreshAuto(), ...detail.waits])
    const ok = sRes.status === 'fulfilled' && sRes.value === true
    // 失败不推进时间戳：否则接下来 30s 内都不会再补，数据一直停在旧值。
    if (ok) lastRefreshRef.current = Date.now()
    return ok
  }, [refreshSplit, refreshAuto])
  const pullRefresh = useCallback(() => refreshActive({ force: true }), [refreshActive])
  // 回到前台：离开超过 VISIBLE_STALE_MS 就静默补一次（走和下拉完全相同的刷新路径，
  // 当前页签的面板自己决定拉什么；有未保存草稿时它们不接，这里也就什么都不发）。
  useEffect(() => {
    // 注意：暂停自动刷新只是停轮询。这里是一次性的「回来补一刀」，不受暂停影响——
    // 用户切回来最想看到的就是最新数据，而不是「已暂停」四个字。
    if (authExpired) return undefined
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRefreshRef.current < VISIBLE_STALE_MS) return
      refreshActive({ respectFormPause: true }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refreshActive, authExpired])
  const pull = usePullToRefresh(pullRefresh, !authExpired)
  // 手机窄屏 .sync 是横向可滚动的：用户把它滑到右边时，行内状态会被裁在视口外。
  // 下拉一开始就把它滚回最左（状态就在第一个位置），保证反馈看得见。
  const syncRef = useRef(null)
  useEffect(() => {
    if (pull.state !== 'idle' && syncRef.current) syncRef.current.scrollLeft = 0
  }, [pull.state])

  // 概览页才轮询状态，避免非概览页每 2s 重渲染（与主轮询同纪律）。
  useEffect(() => {
    if (tab !== 'overview') return undefined
    let alive = true
    const load = () => { if (alive) refreshAuto() }
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [tab, refreshAuto])

  const autoOn = !!(autoState && autoState.on)

  // 倒计时显示 tick：纯展示，不参与服务器调度。概览不在前台时不 tick，
  // 否则保活的所有页签会跟着每秒重渲染一遍。
  useEffect(() => {
    if (!autoOn || tab !== 'overview') return undefined
    const t = setInterval(() => setAutoNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [autoOn, tab])

  const saveAutoInterval = useCallback(async (value) => {
    const v = clampAutoSeconds(value)
    const data = await apiSetAuto({ interval: v })
    if (data && data.auto) setAutoState(data.auto)
    return v
  }, [])
  const startAuto = useCallback(async (value) => {
    const v = clampAutoSeconds(value)
    const data = await apiSetAuto({ on: true, interval: v })
    if (data && data.auto) { setAutoState(data.auto); setAutoNow(Date.now()) }
    return v
  }, [])
  const stopAuto = useCallback(async () => {
    const data = await apiSetAuto({ on: false })
    if (data && data.auto) setAutoState(data.auto)
  }, [])

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
  // 真正切页：调用方已经确认没有需要拦截的过滤页草稿。
  const doSwitchTab = (next) => {
    if (next === tabRef.current) return
    // 任何主动切页都作废在飞的日志跳转：即使只切走再切回概览（tabRef 仍是 from），
    // 迟到的响应也不得把用户再拽去日志页。
    logJumpSeqRef.current++
    if (next === 'sys') sysReadyRef.current = null
    // 统一走 prepareScroll：保存出发页位置、决定目标页位置、首访时先垫高。
    // 第一次进入沿用当前视口，不把整页拽回顶部；只有「查看日志」走 forceTop。
    prepareScroll(next)
    markVisited(next)
    showSyncFor(next)
    setTab(next)
    tabRef.current = next
    if (window.location.hash !== `#/${next}`) window.location.hash = `#/${next}`
  }
  // 切页前先问过滤页：有未保存草稿就不要静默丢掉。
  const switchTab = (next) => {
    if (next === tab) return
    if (next !== 'filter' && tabRef.current === 'filter') {
      const guard = filterGuardRef.current
      if (guard && guard.dirty) {
        setLeaveRequest({ target: next, source: 'tab' })
        return
      }
    }
    doSwitchTab(next)
  }
  // history 来源的「不保存并离开」：后退一次可能只退到另一条同地址过滤记录
  // （取消时 restoreHistory 会再压 sentinel），继续退到真正离开过滤页为止；最多 5 步。
  const leaveHistory = () => {
    let tries = 0
    const step = () => {
      if (tries++ >= 5) return
      window.history.back()
      window.setTimeout(() => {
        if (resolveTab(window.location.hash) === 'filter') step()
      }, 220)
    }
    step()
  }
  // 离开拦截三选一。history 来源不能直接切页：用户是在后退，放弃后要让浏览器继续走完。
  const closeLeaveRequest = (mode) => {
    const req = leaveRequest
    if (!req) return
    const guard = filterGuardRef.current
    if (mode === 'save') {
      setLeaveRequest(null)
      if (guard && typeof guard.restoreHistory === 'function') guard.restoreHistory()
      if (guard && typeof guard.save === 'function') guard.save()
      return
    }
    if (mode === 'discard') {
      setLeaveRequest(null)
      if (guard && typeof guard.discard === 'function') guard.discard()
      if (req.source === 'history') leaveHistory()
      else if (req.target) doSwitchTab(req.target)
      return
    }
    setLeaveRequest(null)
    if (guard && typeof guard.restoreHistory === 'function') guard.restoreHistory()
  }
  // 「查看日志」跳转（v3.318）：先在原页取日志快照，取到再切页。重挂载的 LogsPanel
  // 直接拿这份快照当首帧，不再先 paint 一个 90px 空壳（否则下面的「触发历史」会
  // 顶进视口闪一下）。seq 守卫保证晚到的响应不会把已切走的用户拽回日志页。
  const openLog = useCallback((jump) => {
    const q = jump && jump.q ? jump.q : ''
    const mode = jump && jump.mode ? jump.mode : 'all'
    // 行级跳转带完整时间戳（YYYY-MM-DD HH:MM:SS）；页签/横幅跳转没有，日志页显示整天。
    const focus = jump && typeof jump.focus === 'string' ? jump.focus : ''
    const seq = ++logJumpSeqRef.current
    const from = tabRef.current
    return apiGetLogs().then(
      (d) => {
        if (seq !== logJumpSeqRef.current) return { ok: false, canceled: true }
        // 等待期间用户已切到别的页签：这次跳转作废，不能过一会儿再把人拽回来。
        if (tabRef.current !== from) return { ok: false, canceled: true }
        const at = Date.now()
        // 数据截至直接记这次预取的落盘时间，切页后首帧就显示正确时间。
        syncMemRef.current.logs = at
        prepareScrollRef.current('logs', { forceTop: true })
        markVisited('logs')
        logJumpPendingRef.current = true
        setLogJump({ q, mode, focus, n: seq, data: d })
        showSyncFor('logs')
        setTab('logs')
        tabRef.current = 'logs'
        if (window.location.hash !== '#/logs') window.location.hash = '#/logs'
        return { ok: true }
      },
      (e) => {
        // 迟到的失败同样要作废：用户已经切走时不能在他的新页面上弹旧错误。
        if (seq !== logJumpSeqRef.current || tabRef.current !== from) return { ok: false, canceled: true }
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    )
  }, [markVisited])
  // 循环切主题：一次点击换下一套，按钮上直接显示当前主题名（不弹菜单，手机少一次点按）。
  const cycleTheme = () => {
    // 多标签页：cookie 才是共享偏好——先读它再算下一位，别拿本标签页的旧 state
    // 把另一个标签页刚改的主题覆盖回去（Sourcery #286）。
    const shared = readThemeCookie() || currentThemeKey()
    const at = THEMES.findIndex((t) => t.key === shared)
    const next = THEMES[(at + 1) % THEMES.length]
    // 先落 React 状态再写 cookie：写 cookie 抛异常时不会出现「CSS 变了、按钮还是旧名」。
    setTheme(next.key)
    applyThemeKey(next.key)
  }
  const themeLabel = (THEMES.find((t) => t.key === theme) || THEMES[0]).label
  const nextThemeLabel = (THEMES[(THEMES.findIndex((t) => t.key === theme) + 1) % THEMES.length] || THEMES[0]).label
  const pollMs = locking ? POLL_BUSY_MS : POLL_MS
  // 顶栏徽章只在「概览/日志 + 自动刷新开」时是活状态；其它情况（暂停、推送记录/配置/系统）
  // 主轮询已停，徽章显示的是离开时的快照——必须注明，不能永久挂着「任务运行中」（审查 #246）。
  // 顶栏徽章只在「自动刷新开 + 未失效」时是活状态；所有页都轮询（v3.348），
  // 不再有「（快照）」后缀——数据新旧看后面的时间。
  const livePolling = !authExpired && autoRefresh
  const badgeText = authExpired
    ? '凭证失效'
    : locking ? '任务运行中' : '空闲'
  // 顶栏状态行：所有页同一套词，只有时间来源不同（概览看最近刷新，其它页看本页拉到数据的时间）。
  const syncAt = tab === 'overview' ? lastSync : panelSync
  return html`<div class="wrap">
    <header class="topbar">
      <div class="sync" ref=${syncRef} tabindex="0" aria-label="状态与刷新">
        <${Badge} tone=${authExpired ? 'bad' : locking ? 'run' : 'ok'}>${badgeText}<//>
        <span class="sync-meta">
          ${pull.state !== 'idle'
            ? html`<${PullRefreshStatus} state=${pull.state} />`
            : html`<${TapTip} tip=${showDate && syncAt ? `数据截至：${fmtLocalTime(syncAt)} ${fmtWeekday(syncAt)}` : ''}><${AutoRefreshText} nextAt=${nextAt} pollMs=${pollMs} lastSync=${syncAt} showDate=${showDate} paused=${!autoRefresh || authExpired} live=${livePolling} /><//>`}
        </span>
        <button type="button" class="sync-toggle" aria-pressed=${autoRefresh ? 'true' : 'false'}
          onClick=${() => { setAutoRefresh((v) => !v) }}>${autoRefresh ? '暂停' : '继续'}</button>
        <button type="button" class="sync-toggle theme-btn" onClick=${cycleTheme}
          aria-label=${'切换主题（当前 ' + themeLabel + '，下一套 ' + nextThemeLabel + '）'}
          title=${'主题：' + themeLabel + ' → ' + nextThemeLabel}>◐ ${themeLabel}</button>
      </div>
      ${syncErr ? html`<div class="sync-fail" role="status">${syncErr}</div>` : ''}
    </header>

    ${newVersion !== '' && html`<div class="alert-banner nudge" role="status">
      <div class="alert-main">
        <strong>控制台已更新到 ${newVersion}</strong>
        <span class="alert-sub">当前页面还在跑启动时的旧脚本，刷新后生效；正在填的表单会丢，先复制再刷。</span>
      </div>
      <button type="button" class="alert-action" onClick=${() => window.location.reload()}>刷新页面</button>
    </div>`}

    ${authExpired && html`<div class="alert-banner bad" role="alert">
      <div class="alert-main">
        <strong>凭证已失效，控制台已停止自动刷新</strong>
        <span class="alert-sub">请用带 <code>?token=</code> 的完整链接重新打开；若链接已过期，从部署环境重新获取 XBK_CONSOLE_TOKEN。</span>
      </div>
      <a class="alert-action" href="/">重新登录</a>
    </div>`}

    <nav class="tabs" ref=${tabsRef} data-edge=${tabEdge || undefined} onScroll=${syncTabEdge}>
      ${TABS.map((t) => html`<button key=${t.key} class=${'tab-btn' + (tab === t.key ? ' active' : '')}
        onClick=${() => switchTab(t.key)}>${t.label}</button>`)}
    </nav>

    ${!authExpired && visited.has('overview') && html`<section class="page" hidden=${tab !== 'overview'}>
      <div>
      <${AlertBanner} state=${state} onOpenLog=${openLog} />
      <${StatusCards} state=${state} err=${statusFailed} />
      <${TriggerBar} onTriggered=${handleTriggered} locking=${locking} setBusy=${setBusy} runs=${runs}
        auto=${{ on: autoOn, interval: autoState && Number.isInteger(autoState.interval) ? autoState.interval : AUTO_DEFAULT_S, runs: autoState && autoState.runs ? autoState.runs : 0, err: autoState && autoState.lastError ? autoState.lastError : '', nextAt: autoState && autoState.nextAt ? autoState.nextAt : 0, now: autoNow, start: startAuto, stop: stopAuto, save: saveAutoInterval }} />
      <${RunsPanel} runs=${runs} status=${runsState} active=${tab === 'overview'} pollMs=${autoRefresh && tab === 'overview' ? pollMs : 0} onRefresh=${refreshSplit} />
      <${TrendsPanel} active=${tab === 'overview'} />
      <${RunHistoryPanel} onOpenLog=${openLog} active=${tab === 'overview'} />
      <${CacheHealthPanel} paused=${!autoRefresh || tab !== 'overview'} active=${tab === 'overview'} />
      </div>
    </section>`}
    ${!authExpired && visited.has('messages') && html`<section class="page" hidden=${tab !== 'messages'}>
      <${MessagesPanel} active=${tab === 'messages'} onSync=${syncFor.messages} pollTick=${pollTick} />
    </section>`}
    ${!authExpired && visited.has('logs') && html`<section class="page" hidden=${tab !== 'logs'}>
      <div>
      ${/* 日志在前、触发历史在后（v3.317）：362×795 下旧顺序让日志框从 y=826 开始，
           首屏一行日志都看不到；排障时日志才是主内容，触发历史滚下去看。 */ ''}
      <${LogsPanel} key=${logJump ? logJump.n : 'base'} active=${tab === 'logs'}
        pollMs=${autoRefresh && tab === 'logs' && locking ? POLL_BUSY_MS : 0}
        initialQuery=${logJump ? logJump.q : ''} initialMode=${logJump ? logJump.mode : 'all'}
        focusAt=${logJump && logJump.focus ? logJump.focus : ''}
        focusDate=${logJump ? logJump.q : ''}
        initialData=${logJump ? logJump.data : null} onSync=${syncFor.logs} />
      ${runs.length > 0 && html`<${RunsPanel} runs=${runs} status=${runsState} active=${tab === 'logs'} pollMs=${autoRefresh && tab === 'logs' ? pollMs : 0} onRefresh=${refreshSplit} />`}
      </div>
    </section>`}
    ${!authExpired && visited.has('config') && html`<section class="page" hidden=${tab !== 'config'}>
      <${ConfigPanel} active=${tab === 'config'} onSync=${syncFor.config} pollTick=${pollTick} />
    </section>`}
    ${!authExpired && visited.has('filter') && html`<section class="page" hidden=${tab !== 'filter'}>
      <${FilterRulesPanel} onSync=${syncFor.filter} active=${tab === 'filter'} pollTick=${pollTick}
        guardRef=${filterGuardRef} onLeaveRequest=${requestFilterLeave} />
    </section>`}
    ${!authExpired && visited.has('sys') && html`<section class="page" hidden=${tab !== 'sys'}>
      <div>
      <${SysPanel} onReady=${onSysReady} active=${tab === 'sys'} onSettingsSaved=${reloadUiSettings} pollTick=${pollTick} onFresh=${onFresh} onSettings=${applyUiSettings} />
      <${FilesPanel} onReady=${onFilesReady} active=${tab === 'sys'} pollTick=${pollTick} onFresh=${onFresh} />
      </div>
    </section>`}

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送，触发前二次确认 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
    ${!authExpired && html`<${BackToTop} />`}
    ${leaveRequest && html`<${LeaveGuardDialog} open=${true}
      count=${filterGuardRef.current && filterGuardRef.current.count ? filterGuardRef.current.count : 1}
      busy=${!!(filterGuardRef.current && filterGuardRef.current.busy)}
      onCancel=${() => closeLeaveRequest('cancel')}
      onSave=${() => closeLeaveRequest('save')}
      onDiscard=${() => closeLeaveRequest('discard')} />`}
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
