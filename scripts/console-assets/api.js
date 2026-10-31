// scripts/console-assets/api.js —— 数据层（v3.366，拆自 app.js 的 API 段）。
// 只做 HTTP：各端点函数 + 期限/条件缓存/幂等重放的公共模板；不碰 DOM、不渲染。
// 凭证来自服务端注入的 JSON 岛（readBoot/BOOT），只走 Authorization 头，从不进 URL。
import { FETCH_TIMEOUT_MS, BACKUP_FETCH_TIMEOUT_MS, BACKUP_BROWSER_MAX_BYTES, NOTIFY_WINDOW_DEFAULT_S } from './constants.js'

// token 由 renderPage 注入的 JSON 岛（<script type="application/json" id="xbk-boot">）提供。
// 岛内文本由服务端做 JSON 转义（控制字符 → \uXXXX；不用 HTML 实体——script 文本不做实体解码，
// 实体会让 JSON.parse 得到含 &amp; 的错误 token，Sourcery vwK）。
// 解析后立即移除该节点（用后即焚，token 不常驻 DOM）——解析失败同样要移除：节点里带着明文 token。
// bootError 把「没有 token」的两种情形分开（C7-034）：'missing' = 页面没注入岛（Cookie 会话 /
// 老页面，凭证本来就不走这里，不算错误）；'invalid-json' = 注入了但解析不了（页面数据坏了）。
// 只回空 token 会把后者伪装成「凭证失效」——随后必然出现的 401 让控制台提示「用带 ?token= 的
// 链接重开」，而真正的原因（注入内容损坏）被埋掉，也没有任何日志可查。
function readBoot () {
  const el = document.getElementById('xbk-boot')
  if (!el) return { token: '', version: '', instance: '', bootError: 'missing' }
  let data = null
  let fault = null
  try {
    data = JSON.parse(el.textContent || '{}')
  } catch (e) {
    fault = e
  } finally {
    el.remove()
  }
  // JSON 合法但不是对象（"1" / null）与解析失败同一口径：岛里的内容不可用。
  let bootError = ''
  if (fault !== null || data === null || typeof data !== 'object') {
    bootError = 'invalid-json'
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('xbk-boot 启动数据不可用（不是凭证失效）：JSON 岛解析失败或不是对象', fault)
    }
    data = {}
  }
  // version：页面启动时的构建版本（服务端注入），用来发现「部署后还开着旧标签页」。
  return {
    token: typeof data.token === 'string' ? data.token : '',
    version: typeof data.version === 'string' ? data.version : '',
    // instance：本实例的短 id（服务端按 stateDir 派生）。只用于给 localStorage 里的
    // 首屏快照做命名空间，防止同一 origin 换实例后渲染上一个实例的数据。
    instance: typeof data.instance === 'string' ? data.instance : '',
    bootError
  }
}
const BOOT = readBoot()

// 日期键（YYYY-MM-DD）：数据层的 from/to 查询参数只接受这个形状——形状不对的值不发给
// 服务端（形状对但不是日期由服务端判）；日期区间组件（app.js）复用同一个判定。
const DAY_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

// 搜索词长度上限（UTF-8 字节，与服务端 console.js 的钳制同口径）：推送记录
// MESSAGES_QUERY_MAX_BYTES=240（80 个汉字）、线报全站搜索 LINE_SEARCH_QUERY_MAX_BYTES=120。
// 日期参数形状不对就不发；搜索词同样不能无上限（C7-057）——超长 q 会把 URL 顶到服务端/代理的
// 长度上限（414，或服务端按字节截断后回包的 queryUsed 与发出去的不是同一个词）。数据层先按同一
// 上限截断，URL 长度有界，且发出去的就是服务端真正会用的那个词（前端不必再靠 queryUsed 兜）。
const MESSAGES_QUERY_MAX_BYTES = 240
const LINE_SEARCH_QUERY_MAX_BYTES = 120
const UTF8_ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null
// 没有 TextEncoder 时的 UTF-8 字节数（评审 CR-08）：按**码点**判宽——1/2/3/4 字节。
// 旧实现用 `ch.length`（UTF-16 码元数）：240 个汉字算成 240 字节、实际 720 字节，服务端于是按
// 一个被截到更短的词搜索，超长 URL 还可能被中间代理拒收。这里逐码点累加，与服务端 sliceUtf8Bytes 同口径。
function utf8BytesOfCodePoint (ch) {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return 0
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}
function clampQueryBytes (raw, maxBytes) {
  if (typeof raw !== 'string') return ''
  // 服务端两个端点都是「先 trim 再按字节截断」（console.js /api/messages 与 clampLineQuery），
  // 这里同口径：否则首尾空格会把真正生效的词挤出上限，queryUsed 与请求又不一致。
  const s = raw.trim()
  if (s.length === 0) return ''
  // 绝大多数词远未到上限：先整体编码一次走快路径。
  if (UTF8_ENCODER && UTF8_ENCODER.encode(s).length <= maxBytes) return s
  // 截断按码点走（for...of），不切断代理对/emoji；字节口径与服务端 sliceUtf8Bytes 一致。
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = UTF8_ENCODER ? UTF8_ENCODER.encode(ch).length : utf8BytesOfCodePoint(ch)
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}

// ── API ─────────────────────────────────────────────────────────────────────
// token 只走 Authorization: Bearer 头（URL 不带任何凭证；console.js 服务端不打访问日志，
// 但浏览器扩展/中间代理可能记 URL——凭证不进 URL 是更安全的默认）。
// fetch 期限（Sourcery G_n6）：8s 超时 AbortController 取消——挂起请求走 reject，
// 刷新链路不阻塞，历史与状态在下一轮照常更新。
// Codacy Critical（SSRF 启发式：fetch 收到「用户可控 URL」）：每个端点独立函数、
// URL 全部为字面量——fetch 的第一个参数在数据流上只有字面量一种来源，不存在
// 「变量 URL」路径。run id 是服务端生成的 `epoch.seq` 字符串（不是数字），详情端点以独立函数封装。
// Sourcery Stalled-bodies x3：fetch() 在收到响应头时就 resolve，「fetch resolve 即清期限」
// 会让「头到了、body 挂起」的响应绕过超时——轮询消费 res.json() 时永久等待，刷新链路卡死。
// v3.385：期限改由 AbortSignal.timeout() 承担——同一个 signal 同时管 fetch 与 body 读取，
// 到期时 res.json()/text() 一并 reject，手写的 Promise.race 与 done() 握手全部删除。
// Codacy/Opengrep node-ssrf（Codacy Critical）：该规则将「fetch 第一参数为任何变量」
// 判为 SSRF（不追数据流来源，即使字面量经辅助函数传入也算）。因此 fetch 调用必须
// 内联到各端点函数、第一参数为字面量；超时/中止参数由 timedRequest() 统一构造。
// 兼容（Safari < 16 / Android WebView < 103 没有 AbortSignal.timeout）：退回
// AbortController + setTimeout，信号语义一致——到期 abort 在飞请求，含仍在读 body 的那一步。
// 这一路不持有可清的定时器句柄：请求提前结束时它只是对已 settled 的请求 abort 一次（空操作）。
function timedRequest (opts, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof AbortSignal.timeout === 'function') return { ...opts, signal: AbortSignal.timeout(timeoutMs) }
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), timeoutMs)
  return { ...opts, signal: ctrl.signal }
}

// 条件请求缓存（v3.363）：键 → { tag, data }。服务端对只读快照端点发 ETag，
// 命中 If-None-Match 时回 304 空体——前端复用上一份 data，省掉重复 body。
// 只存内存（刷新即空），不落 localStorage；凭证不进这个 Map。
// 有界（Sourcery PR #321）：messages 的缓存键含筛选/分页，键空间无上限——留 16 条
// 覆盖「当前视图 + 来回切几个筛选 + 趋势/历史/配置/缓存健康各一份」，超出按**最近使用**
// 淘汰。v3.373：8→16，因为条件请求从 3 个端点扩到 7 个。
// C7-030：旧实现只在写入时 Map.set，读取从不改顺序 ⇒ 淘汰退化成 FIFO：冷启动第一批
// 放进去的 runs / config（页签保活后一直在用）反而最先被淘汰，而每次翻页都新建的
// messages 分页键把它们挤出去。命中即挪到队尾（touchConditional），写回也算一次使用。
const COND_CACHE = new Map()
const COND_CACHE_MAX = 16
function touchConditional (key) {
  const hit = COND_CACHE.get(key)
  if (!hit) return null
  // Map 的插入序就是淘汰序：删掉再插 = 挪到队尾（不复制对象，tag/data 仍是同一份）。
  COND_CACHE.delete(key)
  COND_CACHE.set(key, hit)
  return hit
}
function rememberConditional (key, entry) {
  if (COND_CACHE.has(key)) COND_CACHE.delete(key) // 覆盖同样是「刚用过」：先删再插
  else if (COND_CACHE.size >= COND_CACHE_MAX) {
    const oldest = COND_CACHE.keys().next()
    if (!oldest.done) COND_CACHE.delete(oldest.value)
  }
  COND_CACHE.set(key, entry)
}
function addConditional (merged, key) {
  const hit = touchConditional(key)
  if (!hit || !hit.tag) return null
  merged.headers = { ...merged.headers, 'If-None-Match': hit.tag }
  // 把「这次请求发出去的是哪个 tag」交回调用方：304 到达时要用它核对缓存条还是不是
  // 同一份快照。两个并发请求之间缓存可能被另一个 tag 覆盖，只按 key 取会把 T2 的数据
  // 冒充成 T1 的 304 结果（Sourcery Medium）。
  return hit.tag
}

// 响应消费公共骨架：fetch promise 进来后统一「非 2xx 抛错 + 304 复用条件缓存」。
// 注意 fetch 本身不收进这里——各端点保持字面量 URL（Codacy SSRF 启发式：第一参数
// 任何变量形态都会红，包括白名单查表后的常量；字面量是唯一全绿形态，PR #227 实测）。
async function consumeJson (p, condKey, retry, sentTag) {
  p.then(() => {}, () => {}) // fetch reject（网络错）由下方 await 抛出；这里只防提前未处理拒绝
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
    // 命中也是「用过这一条」（C7-030）：走 touchConditional 挪到队尾，别让热键被淘汰。
    const hit = condKey ? touchConditional(condKey) : null
    // 只有缓存条仍是我们发出去的那个 tag 才复用它；被别的并发响应换掉时必须重取，
    // 否则会把 T2 的快照当成 T1 的 304 结果（配置/趋势/历史短暂显示错数据）。
    if (hit && (!sentTag || hit.tag === sentTag)) return hit.data
    // 本地没有对应副本（换了标签页 / 前端刚更新过 / 缓存条目被淘汰 / 服务端 tag 与本地
    // 记录不一致）时**必须重取**：去掉 If-None-Match 再发一次，拿完整的 200。
    // 绝不能把 304 当失败——配置页会直接显示「加载失败」，而且用户无处可点。
    if (typeof retry === 'function') return retry()
    throw new Error('HTTP 304（无本地副本）')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // body 读取仍受同一个 AbortSignal.timeout 约束：头到了体挂起时 res.json() 到期即 reject。
  const data = await res.json()
  if (condKey) {
    const tag = res.headers.get('ETag')
    if (tag) rememberConditional(condKey, { tag, data })
  }
  return data
}

// 「304 但本地没有副本 → 去掉条件头重取一次」的公共骨架（C7-025）：conditionalRequest 与
// 三个手写端点（runs / auto / messages）共用。只重试一次：重试不带条件头，再拿到 304 就是
// 服务端异常，按「无本地副本」抛错。attempt(conditional) 负责「怎么发」并交回发出的 tag。
function consumeConditional (condKey, attempt) {
  const first = attempt(true)
  return consumeJson(first.p, condKey, () => {
    const again = attempt(false)
    return consumeJson(again.p, condKey)
  }, first.sentTag)
}

// 条件请求端点的统一骨架（v3.373）：注入 If-None-Match → fetch → consumeJson。
// config / cache-health / trends / run-history 四个端点共用它；「304 但本地无副本」的
// 重试也在这里（见 consumeJson 的 retry 参数）。fetch 的 URL 仍留在各端点里保持字面量
// （Codacy SSRF 口径）——这里收的是「怎么发」，不是 URL。
function conditionalRequest (condKey, build) {
  const attempt = (conditional) => {
    const merged = timedRequest({
      headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
    })
    // 必须在 fetch 之前注入：fetch 调用时就快照 headers（Sourcery PR #321）。
    const sentTag = conditional ? addConditional(merged, condKey) : null
    return { p: build(merged), sentTag }
  }
  return consumeConditional(condKey, attempt)
}

function apiGetStatus () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  // /api/status 含 generatedAt / lock.ageMs（每拍都在变），不做条件请求——给它发 ETag
  // 永远不会命中（服务端 sendJsonConditional 注释同口径）。
  return consumeJson(fetch('/api/status', merged))
}

function apiGetRuns () {
  // 条件请求 + 「304 无本地副本就重取」（C7-025，与 conditionalRequest 同一骨架）。
  // fetch 第一参数保持字面量（Codacy SSRF 口径）；条件头必须在 fetch 之前注入
  // （fetch 调用时就快照 headers）。
  const attempt = (conditional) => {
    const merged = timedRequest({
      headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
    })
    const sentTag = conditional ? addConditional(merged, 'runs') : null
    return { p: fetch('/api/runs', merged), sentTag }
  }
  return consumeConditional('runs', attempt)
}

async function apiGetRunDetail (id) {
  // 详情查询走 POST /api/runs/detail：fetch 的 URL 是纯字面量，run id 在请求体里
  // （id = 「epoch.seq」字符串原样传，服务端正则按此形态校验——v3.299 评审）。
  // GET /api/runs/:id 服务端仍保留（API 兼容），前端不再拼变量 URL——
  // Codacy SSRF 规则不接受任何含变量的 fetch 第一参数，字面量 + body 是唯一全绿形态。
  const body = new URLSearchParams({ id: String(id) })
  const merged = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Bearer ${BOOT.token}`
    },
    body
  })
  const p = fetch('/api/runs/detail', merged)
  return consumeJson(p)
}

// 取消运行中的触发任务（v3.299 批次②）：POST 字面量 URL + id 走请求体
// （Codacy SSRF 全绿形态，与 /api/runs/detail 同款）。202 = 已受理（异步终止中），
// 200 = 幂等命中（已取消过），409 = 已结束无需停止。
function apiCancelRun (id) {
  // id = 「epoch.seq」字符串原样传（v3.299 评审：进程 epoch 形态），不做 Number 归一。
  const body = new URLSearchParams({ id: String(id) })
  const merged = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Bearer ${BOOT.token}`
    },
    body
  })
  const p = fetch('/api/runs/cancel', merged)
  return consumeJson(p)
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
  // 搜索词按服务端同一上限（240 字节）截断后再发：URL 有界，且发出去的就是生效的那个词。
  const qText = clampQueryBytes(q, MESSAGES_QUERY_MAX_BYTES)
  if (qText.length > 0) params.set('q', qText)
  // 时间窗（v3.307）：0/未传=全部；1/3/7/30=近 N 个上海日历日（服务端白名单兜底）
  if (Number.isSafeInteger(days) && days > 0) params.set('days', String(days))
  // 自定义区间（v3.326）：YYYY-MM-DD 闭区间，服务端优先于 days（非法/颠倒时静默回落）
  if (typeof from === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(from)) params.set('from', from)
  if (typeof to === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(to)) params.set('to', to)
  const qs = params.toString()
  // 分页/筛选不同的请求各算一份缓存（同一 URL 语义才可复用 304 结果）。
  // 必须在 fetch 之前注入 If-None-Match（Sourcery PR #321）：fetch 在调用时就快照
  // headers，先 fetch 后 addConditional 等于永远不发条件头。
  // 304 但本地无副本（tag 被并发换掉 / 条目被 16 条容量淘汰）→ 去掉条件头重取一次
  // （C7-025；旧实现直接 reject「HTTP 304（无本地副本）」，推送记录页显示加载失败）。
  const condKey = `messages?${qs}`
  const attempt = (conditional) => {
    const merged = timedRequest({
      headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
    })
    const sentTag = conditional ? addConditional(merged, condKey) : null
    return { p: fetch(qs.length > 0 ? `/api/messages?${qs}` : '/api/messages', merged), sentTag }
  }
  return consumeConditional(condKey, attempt)
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

// 在飞去重（v3.385）：同一 key 的并发调用共享同一个 Promise，settle 即清。
// 语义是「请求结束就重发」，**不是 TTL 缓存**——文件清单/过滤规则都是写后可变的，
// 缓存化会让刷新拿到旧快照（这两处各自抄过一份同样的模板，合成这一个函数）。
const IN_FLIGHT = new Map()
function once (key, fn) {
  const hit = IN_FLIGHT.get(key)
  if (hit) return hit
  const p = fn()
  IN_FLIGHT.set(key, p)
  const clear = () => { if (IN_FLIGHT.get(key) === p) IN_FLIGHT.delete(key) }
  p.then(clear, clear)
  return p
}

function apiGetFiles () {
  // 启动预加载会同时命中缓存健康右列、系统页文件清单、过滤规则备份下拉；
  // 共享同一个在飞 Promise，避免对大目录做三次同步扫描（Sourcery #272）。
  return once('files', () => consumeJson(fetch('/api/files', timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  }))))
}

function apiGetConfig () {
  // 条件请求（v3.373）：配置视图在运行期基本不变（只随部署/环境变量变），命中率最高的一支。
  return conditionalRequest('config', (merged) => fetch('/api/config', merged))
}

function apiGetLogs () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/logs', merged))
}

// v3.332：版本探针走 ?probe=version——服务端据此不把它记进访问日志（60s 一条会挤掉真实历史）；
// 同时 no-store，防代理/浏览器启发式缓存把旧版本喂回来，让「有新版本」永远判不出来。
function apiGetSys ({ probeVersion = false } = {}) {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` },
    ...(probeVersion ? { cache: 'no-store' } : {})
  })
  return consumeJson(fetch(probeVersion ? '/api/sys?probe=version' : '/api/sys', merged))
}

// 服务器端自动运行：GET 读状态；POST 开关/改间隔（写面只认 Bearer）。
function apiGetAuto () {
  // 条件请求 + 「304 无本地副本就重取」（C7-025）。条件头在 fetch 之前注入。
  const attempt = (conditional) => {
    const merged = timedRequest({
      headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
    })
    const sentTag = conditional ? addConditional(merged, 'auto') : null
    return { p: fetch('/api/auto', merged), sentTag }
  }
  return consumeConditional('auto', attempt)
}

function apiSetAuto (payload) {
  const merged = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${BOOT.token}`
    },
    body: JSON.stringify(payload)
  })
  return consumeJson(fetch('/api/auto', merged))
}

// 访问日志（v3.300 §3.3）：系统页可查的内存环形访问日志。与上方端点同纪律——
// fetch 第一参数纯字面量（Codacy SSRF 全绿形态，静态红线测试自动覆盖）。
function apiGetAccessLog () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/access-log', merged))
}

// ── v3.310 过滤规则控制面：读面 GET + 四个写面 POST ─────────────────────────
// 读面沿用现有 api helper（Cookie / Bearer / ?token= 均可）。写面只带
// `Authorization: Bearer <boot token>`，不带 ?token=（服务端写端点只认 Bearer 头，
// URL 里带 token 会直接 400 query_token_not_allowed）。
// 写请求的错误体必须读出来：409 要区分 revision_mismatch / write_busy / store_corrupt，
// 400 要逐字段 errors。consumeJson 把非 2xx 收敛成「HTTP 4xx」会丢掉 code，所以这里用
// consumeJsonResult 保留状态码与响应体；超时/中止仍由同一个 AbortSignal.timeout 期限覆盖。
async function consumeJsonResult (p) {
  p.then(() => {}, () => {}) // fetch reject 由 await 抛出；这里只防提前未处理拒绝
  const res = await p
  let data = null
  try {
    data = await res.json()
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
}

function filterWriteHeaders () {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${BOOT.token}`
  }
}

function apiGetFilter () {
  // 配置页和过滤规则页启动预加载时都会要同一份过滤规则快照，共享在飞 Promise。
  return once('filter', () => consumeJson(fetch('/api/config/filter', timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  }))))
}

// 服务器草稿：读面沿用 Cookie/?token= 均可的全局鉴权；写/删只认 Bearer。
function apiGetFilterDraft () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/config/filter/draft', merged))
}

function apiPostFilterDraft (filter, baseRevision, { keepalive = false } = {}) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({ schema: 1, baseRevision, filter }),
    keepalive
  })
  return consumeJsonResult(fetch('/api/config/filter/draft', merged))
}

function apiDeleteFilterDraft () {
  const merged = timedRequest({
    method: 'DELETE',
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` },
    keepalive: true
  })
  return consumeJsonResult(fetch('/api/config/filter/draft', merged))
}

function apiPostFilterSave (body) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter', merged))
}

function apiPostFilterValidate (body) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter/validate', merged))
}

function apiPostFilterPreview (body) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter/preview', merged))
}

// 数据备份：导出先取回 JSON 文本，浏览器加密后再下载；导入返回 {ok, imported, backupDir}。
// 不能直接把服务器响应 blob 下载——那样落盘的是明文，浏览器端加密就失去意义。
function apiPostBackupExport (categories) {
  const merged = timedRequest({
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
    const skippedHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('X-Backup-Skipped') : ''
    const skipped = skippedHeader ? skippedHeader.split(',') : []
    return { text, skipped }
  })
}

function apiPostBackupImport (bundle, idempotencyKey) {
  const headers = filterWriteHeaders()
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const merged = timedRequest({
    method: 'POST',
    headers,
    body: JSON.stringify(bundle)
  }, BACKUP_FETCH_TIMEOUT_MS)
  return consumeJsonResult(fetch('/api/backup/import', merged))
}

function apiPostFilterRestore (body) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/filter/restore', merged))
}

// 控制台设置（v3.340）：通知自检拦截窗的读/写面。GET 与其它读面同款（Bearer + Accept）；
// 写面复用 filterWriteHeaders（Bearer + application/json，服务端 415 闸要求后者）。
function apiGetConsoleSettings () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/config/console', merged))
}

function apiPostConsoleSettings (body) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(body)
  })
  return consumeJsonResult(fetch('/api/config/console', merged))
}

// 两步验证（v3.357）：状态读取 + 开启/确认/关闭。写面与其它写端点同款 Bearer + JSON。
function apiGetTwoFactorStatus () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/2fa/status', merged))
}

function apiPostTwoFactorSetup () {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({})
  })
  return consumeJsonResult(fetch('/api/2fa/setup', merged))
}

function apiPostTwoFactorEnable (code, setupId) {
  const payload = { code }
  if (typeof setupId === 'string' && setupId !== '') payload.setupId = setupId
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(payload)
  })
  return consumeJsonResult(fetch('/api/2fa/enable', merged))
}

function apiPostTwoFactorDisable (code) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({ code })
  })
  return consumeJsonResult(fetch('/api/2fa/disable', merged))
}

// 信任设备（v3.374）：「退出所有信任设备」——清空服务端设备列表 + 让当前浏览器的设备 Cookie 失效。
// 写面与其它写端点同款 Bearer + JSON（Cookie-only 服务端回 401）。
function apiPostDevicesRevoke () {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify({})
  })
  return consumeJsonResult(fetch('/api/devices/revoke', merged))
}

// 触发类请求公共体（SonarCloud new_duplicated_lines_density：trigger 与 triggerNotifyTest
// 两段同构模板抽公共，消除新增代码重复率超标）。fetch 字面量由调用侧闭包注入——
// 第一参数仍是纯字面量（§0 静态红线形态保持），公共体只管 timedRequest/重放拦截语义。
async function triggerVia (timedOpts, doFetch, dupMsg, failMsgOf) {
  const p = doFetch(timedRequest(timedOpts))
  p.then(() => {}, () => {}) // 网络错由下面的 await 抛出；这里只防提前未处理拒绝
  const res = await p
  let data
  try {
    data = await res.json()
  } catch (e) {
    data = {}
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
  // 搜索词上限 120 字节（服务端 LINE_SEARCH_QUERY_MAX_BYTES 同口径）：面板已在输入侧钳制，
  // 数据层再兜一道——直接调 apiSearchLines 的路径（关注词/深链）也不能发出超长 q。
  const qText = clampQueryBytes(q, LINE_SEARCH_QUERY_MAX_BYTES)
  if (qText.length > 0) params.set('q', qText)
  if (Number.isSafeInteger(page) && page > 1) params.set('page', String(page))
  if (Number.isSafeInteger(limit) && limit > 0) params.set('limit', String(limit))
  const qs = params.toString()
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  }, 12000)
  return consumeJson(fetch(qs.length > 0 ? `/api/line-search?${qs}` : '/api/line-search', merged))
}

function apiGetLineWatch () {
  const merged = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  return consumeJson(fetch('/api/line-watch', merged))
}

function apiPostLineWatch (payload = {}) {
  const merged = timedRequest({
    method: 'POST',
    headers: filterWriteHeaders(),
    body: JSON.stringify(payload)
  })
  return consumeJsonResult(fetch('/api/line-watch', merged)).then((r) => {
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
  apiPostDevicesRevoke,
  apiSearchLines, apiGetLineWatch, apiPostLineWatch
}
