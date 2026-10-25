// scripts/console-assets/api.js —— 数据层（v3.366，拆自 app.js 的 API 段）。
// 只做 HTTP：各端点函数 + 期限/条件缓存/幂等重放的公共模板；不碰 DOM、不渲染。
// 凭证来自服务端注入的 JSON 岛（readBoot/BOOT），只走 Authorization 头，从不进 URL。
import { FETCH_TIMEOUT_MS, BACKUP_FETCH_TIMEOUT_MS, BACKUP_BROWSER_MAX_BYTES, NOTIFY_WINDOW_DEFAULT_S } from './constants.js'

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
      version: typeof data.version === 'string' ? data.version : '',
      // instance：本实例的短 id（服务端按 stateDir 派生）。只用于给 localStorage 里的
      // 首屏快照做命名空间，防止同一 origin 换实例后渲染上一个实例的数据。
      instance: typeof data.instance === 'string' ? data.instance : ''
    }
  } catch (e) { return { token: '', version: '', instance: '' } }
}
const BOOT = readBoot()

// 日期键（YYYY-MM-DD）：数据层的 from/to 查询参数只接受这个形状——形状不对的值不发给
// 服务端（形状对但不是日期由服务端判）；日期区间组件（app.js）复用同一个判定。
const DAY_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

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
function timedRequest (opts, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
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

// 条件请求缓存（v3.363）：键 → { tag, data }。服务端对只读快照端点发 ETag，
// 命中 If-None-Match 时回 304 空体——前端复用上一份 data，省掉重复 body。
// 只存内存（刷新即空），不落 localStorage；凭证不进这个 Map。
// 有界（Sourcery PR #321）：messages 的缓存键含筛选/分页，键空间无上限——留 16 条
// 覆盖「当前视图 + 来回切几个筛选 + 趋势/历史/配置/缓存健康各一份」，超出按插入序
// 淘汰（Map 保序，最老的先走）。v3.373：8→16，因为条件请求从 3 个端点扩到 7 个。
const COND_CACHE = new Map()
const COND_CACHE_MAX = 16
function rememberConditional (key, entry) {
  if (COND_CACHE.size >= COND_CACHE_MAX && !COND_CACHE.has(key)) {
    const oldest = COND_CACHE.keys().next()
    if (!oldest.done) COND_CACHE.delete(oldest.value)
  }
  COND_CACHE.set(key, entry)
}
function addConditional (merged, key) {
  const hit = COND_CACHE.get(key)
  if (!hit || !hit.tag) return null
  merged.headers = { ...merged.headers, 'If-None-Match': hit.tag }
  // 把「这次请求发出去的是哪个 tag」交回调用方：304 到达时要用它核对缓存条还是不是
  // 同一份快照。两个并发请求之间缓存可能被另一个 tag 覆盖，只按 key 取会把 T2 的数据
  // 冒充成 T1 的 304 结果（Sourcery Medium）。
  return hit.tag
}

// 响应消费公共骨架：fetch promise 进来后统一「非 2xx 抛错 + body 消费完才清期限」。
// 注意 fetch 本身不收进这里——各端点保持字面量 URL（Codacy SSRF 启发式：第一参数
// 任何变量形态都会红，包括白名单查表后的常量；字面量是唯一全绿形态，PR #227 实测）。
async function consumeJson (p, done, condKey, retry, sentTag) {
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
    if (res.status === 304) {
      // 304 无 body：直接复用条件缓存里的上一份（服务端已确认内容未变）。
      done()
      const hit = condKey ? COND_CACHE.get(condKey) : null
      // 只有缓存条仍是我们发出去的那个 tag 才复用它；被别的并发响应换掉时必须重取，
      // 否则会把 T2 的快照当成 T1 的 304 结果（配置/趋势/历史短暂显示错数据）。
      if (hit && (!sentTag || hit.tag === sentTag)) return hit.data
      // 本地没有对应副本（换了标签页 / 前端刚更新过 / 缓存条目被淘汰 / 服务端 tag 与本地
      // 记录不一致）时**必须重取**：去掉 If-None-Match 再发一次，拿完整的 200。
      // 绝不能把 304 当失败——配置页会直接显示「加载失败」，而且用户无处可点。
      if (typeof retry === 'function') return retry()
      throw new Error('HTTP 304（无本地副本）')
    }
    if (!res.ok) { done(); throw new Error(`HTTP ${res.status}`) }
    try {
      const data = await readBodyJson(res)
      if (condKey) {
        const tag = res.headers.get('ETag')
        if (tag) rememberConditional(condKey, { tag, data })
      }
      return data
    } finally {
      done() // body 消费完才清期限（Sourcery Stalled-bodies-outlive：done 提前会让挂起 body 绕过 abort）
    }
  } catch (e) {
    done()
    throw e
  }
}

// 条件请求端点的统一骨架（v3.373）：注入 If-None-Match → fetch → consumeJson。
// config / cache-health / trends / run-history 四个端点共用它；「304 但本地无副本」的
// 重试也在这里（见 consumeJson 的 retry 参数）。fetch 的 URL 仍留在各端点里保持字面量
// （Codacy SSRF 口径）——这里收的是「怎么发」，不是 URL。
function conditionalRequest (condKey, build) {
  const once = (conditional) => {
    const { merged, done } = timedRequest({
      headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
    })
    // 必须在 fetch 之前注入：fetch 调用时就快照 headers（Sourcery PR #321）。
    const sentTag = conditional ? addConditional(merged, condKey) : null
    return { p: build(merged), done, sentTag }
  }
  const first = once(true)
  return consumeJson(first.p, first.done, condKey, () => {
    // 只重试一次：重试不带条件头，再拿到 304 就是服务端异常，按「无本地副本」抛错。
    const again = once(false)
    return consumeJson(again.p, again.done, condKey)
  }, first.sentTag)
}

function apiGetStatus () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  // /api/status 含 generatedAt / lock.ageMs（每拍都在变），不做条件请求——给它发 ETag
  // 永远不会命中（服务端 sendJsonConditional 注释同口径）。
  return consumeJson(fetch('/api/status', merged), done)
}

function apiGetRuns () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const sentTag = addConditional(merged, 'runs')
  return consumeJson(fetch('/api/runs', merged), done, 'runs', undefined, sentTag)
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
  // 条件请求（v3.373）：键含查询串——limit/before/win 不同的请求各算一份缓存。
  return conditionalRequest(`run-history?${qs}`,
    (merged) => fetch(qs.length > 0 ? `/api/run-history?${qs}` : '/api/run-history', merged))
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
  // 分页/筛选不同的请求各算一份缓存（同一 URL 语义才可复用 304 结果）。
  // 必须在 fetch 之前注入 If-None-Match（Sourcery PR #321）：fetch 在调用时就快照
  // headers，先 fetch 后 addConditional 等于永远不发条件头。
  const condKey = `messages?${qs}`
  const sentTag = addConditional(merged, condKey)
  return consumeJson(fetch(qs.length > 0 ? `/api/messages?${qs}` : '/api/messages', merged), done, condKey, undefined, sentTag)
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
  // 条件请求（v3.373）：键含查询串（days/from/to 不同的请求各算一份缓存）。
  return conditionalRequest(`trends?${qs}`,
    (merged) => fetch(qs.length > 0 ? `/api/trends?${qs}` : '/api/trends', merged))
}

// v3.298 只读扩展 API：缓存健康 / 文件清单 / 配置视图。与上方端点同纪律——
// fetch 第一参数是纯字面量（无查询参数，字面量是唯一形态）。
function apiGetCacheHealth () {
  // 条件请求（v3.373）：缓存文件的 size/mtime/条目数都在 body 里，内容未变时 304 即可。
  return conditionalRequest('cache-health', (merged) => fetch('/api/cache-health', merged))
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
  // 条件请求（v3.373）：配置视图在运行期基本不变（只随部署/环境变量变），命中率最高的一支。
  return conditionalRequest('config', (merged) => fetch('/api/config', merged))
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
  const sentTag = addConditional(merged, 'auto')
  return consumeJson(fetch('/api/auto', merged), done, 'auto', undefined, sentTag)
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

// 数据备份：导出先取回 JSON 文本，浏览器加密后再下载；导入返回 {ok, imported, backupDir}。
// 不能直接把服务器响应 blob 下载——那样落盘的是明文，浏览器端加密就失去意义。
function apiPostBackupExport (categories) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({ categories })
  }, BACKUP_FETCH_TIMEOUT_MS)
  return fetch('/api/backup/export', merged).then(async (res) => {
    if (!res.ok) {
      const text = await res.text()
      let message = `HTTP ${res.status}`
      try {
        const data = JSON.parse(text)
        if (data && data.error) message = data.error
      } catch (e) { /* 非 JSON 错误体 */ }
      throw new Error(message)
    }
    // 先看服务端声明的长度，避免把接近 256MiB 的明文读进手机内存；没有 Content-Length 时读完再兜底。
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : '')
    if (Number.isFinite(declared) && declared > BACKUP_BROWSER_MAX_BYTES) {
      throw new Error('备份超过 32MB，浏览器加密会占用过多内存；请减少勾选类别')
    }
    const text = await res.text()
    if (new TextEncoder().encode(text).length > BACKUP_BROWSER_MAX_BYTES) {
      throw new Error('备份超过 32MB，浏览器加密会占用过多内存；请减少勾选类别')
    }
    done()
    const skippedHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('X-Backup-Skipped') : ''
    const skipped = skippedHeader ? skippedHeader.split(',') : []
    return { text, skipped }
  }).catch((e) => { done(); throw e })
}

function apiPostBackupImport (bundle, idempotencyKey) {
  const headers = filterWriteHeaders()
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const { merged, done } = timedRequest({
    method: 'POST',
    headers,
    body: JSON.stringify(bundle)
  }, BACKUP_FETCH_TIMEOUT_MS)
  return consumeJsonResult(fetch('/api/backup/import', merged), done)
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

// 两步验证（v3.357）：状态读取 + 开启/确认/关闭。写面与其它写端点同款 Bearer + JSON。
function apiGetTwoFactorStatus () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/2fa/status', merged), done)
}

function apiPostTwoFactorSetup () {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({})
  })
  return consumeJsonResult(fetch('/api/2fa/setup', merged), done)
}

function apiPostTwoFactorEnable (code, setupId) {
  const payload = { code }
  if (typeof setupId === 'string' && setupId !== '') payload.setupId = setupId
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(payload)
  })
  return consumeJsonResult(fetch('/api/2fa/enable', merged), done)
}

function apiPostTwoFactorDisable (code) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({ code })
  })
  return consumeJsonResult(fetch('/api/2fa/disable', merged), done)
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

// ── v3.370 线报全站搜索 / 关注词 ─────────────────────────────────────────────
// 搜索走服务端代理（线报酷是第三方站点，浏览器直连会被 CORS 挡）。查询词只进
// URLSearchParams，authority 恒为字面量；期限比普通端点长（服务端上游超时 8s）。
function apiSearchLines ({ q, page, limit } = {}) {
  const params = new URLSearchParams()
  if (typeof q === 'string' && q.length > 0) params.set('q', q)
  if (Number.isSafeInteger(page) && page > 1) params.set('page', String(page))
  if (Number.isSafeInteger(limit) && limit > 0) params.set('limit', String(limit))
  const qs = params.toString()
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  }, 12000)
  return consumeJson(fetch(qs.length > 0 ? `/api/line-search?${qs}` : '/api/line-search', merged), done)
}

function apiGetLineWatch () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/line-watch', merged), done)
}

function apiPostLineWatch (payload = {}) {
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(payload)
  })
  return consumeJsonResult(fetch('/api/line-watch', merged), done).then((r) => {
    if (!r.ok) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`)
    return r.data
  })
}

export {
  BOOT, DAY_KEY_RE, timedRequest, trigger,
  triggerNotifyTest, apiGetStatus, apiGetRuns, apiGetRunDetail,
  apiCancelRun, apiGetRunHistory, apiGetMessages, apiGetTrends,
  apiGetCacheHealth, apiGetFiles, apiGetConfig, apiGetLogs,
  apiGetSys, apiGetAuto, apiSetAuto, apiGetAccessLog,
  apiGetFilter, apiGetFilterDraft, apiPostFilterDraft, apiDeleteFilterDraft,
  apiPostFilterSave, apiPostFilterValidate, apiPostFilterPreview, apiPostBackupExport,
  apiPostBackupImport, apiPostFilterRestore, apiGetConsoleSettings, apiPostConsoleSettings,
  apiGetTwoFactorStatus, apiPostTwoFactorSetup, apiPostTwoFactorEnable, apiPostTwoFactorDisable,
  apiSearchLines, apiGetLineWatch, apiPostLineWatch
}
