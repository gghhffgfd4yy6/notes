// scripts/console-assets/app.js —— 控制台前端（preact + htm standalone，无构建、零 npm 依赖）。
// vendor 锚点（v3.296 补）：./htm-preact.module.js = preact 10.24.3 + hooks + htm 3.1.1
// standalone 内联版（npmmirror 文件直链入库，sha256 =
// 2aeaa3232ca84a7ad7ac0bef39bad3223dbd2173bee6ce4554b77be2f7f271b3）。重取/升级必须核对该值；
// CVE-2026-22028 影响 preact ≥10.26.5，升级越过该版本前先确认修复态。
// 数据面：GET /api/status、/api/runs、/api/runs/:id（同源，token 走 Authorization: Bearer
// 请求头——不复述进 URL，避免出现在任何中间层访问日志/浏览器历史，Sourcery rwH）。
// 动作面：POST /trigger（token 同样在 Bearer 头；body 只带 action）。
// 页面本体仍以 ?token= 打开（浏览器导航无法带头），fetch 层换头后 URL 零凭证。
import { html, render, useState, useEffect, useRef, useCallback } from './htm-preact.module.js'

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

const POLL_MS = 5000
const POLL_BUSY_MS = 2000
// 提交成功后按钮锁定的最长兜底时长（Sourcery vwU/vv2：轮询竞态/请求挂起时不能永久锁死；
// 上限 = 服务端 PROC_TIMEOUT_MS(10min) + 提交往返余量，取 11 分钟）。
const BUSY_FALLBACK_MS = 11 * 60 * 1000
// fetch 请求期限（Sourcery G_n6）：挂起连接不得阻塞刷新链路；超时由 AbortController 取消，
// 走正常 reject 路径（「刷新失败」可见），不会堆积请求。
const FETCH_TIMEOUT_MS = 8000

// ── 工具 ────────────────────────────────────────────────────────────────────
function fmtTime (ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtNum (n) {
  return (n === undefined || n === null) ? '—' : String(n)
}

// 字节人性化（v3.298 上提为模块级：系统信息与缓存健康面板共用）；0 字节是真实大小，
// 显式显示「0 B」而不是「—」（— 意为未知/不适用，会掩盖 0 字节文件的异常）。
function fmtBytes (b) {
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '—'
  if (b === 0) return '0 B'
  return `${(b / 1048576).toFixed(1)} MB`
}

// ── API ─────────────────────────────────────────────────────────────────────
// token 只走 Authorization: Bearer 头（URL 不带任何凭证；console.js 服务端不打访问日志，
// 但浏览器扩展/中间代理可能记 URL——凭证不进 URL 是更安全的默认）。
// fetch 期限（Sourcery G_n6）：8s 超时 AbortController 取消——挂起请求走 reject，
// 刷新链路不阻塞，历史与状态在下一轮照常更新。
// Codacy Critical（SSRF 启发式：fetch 收到「用户可控 URL」）：每个端点独立函数、
// URL 全部为字面量——fetch 的第一个参数在数据流上只有字面量一种来源，不存在
// 「变量 URL」路径。run id 是服务端生成的数字 id，详情端点以独立函数封装。
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
  // （Number(id).toFixed(0) 强制数值化，非数字输入只会得到数字文本）。
  // GET /api/runs/:id 服务端仍保留（API 兼容），前端不再拼变量 URL——
  // Codacy SSRF 规则不接受任何含变量的 fetch 第一参数，字面量 + body 是唯一全绿形态。
  const body = new URLSearchParams({ id: Number(id).toFixed(0) })
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

// ── v3.297 扩展 API：推送记录 / 趋势 / 日志 / 系统 ────────────────────────────
// 与上方端点同纪律：fetch 第一参数是纯字面量（查询参数经 URLSearchParams 编码后
// 只进模板字符串的查询段，authority 恒为字面量——SSRF 启发式全绿形态）。
function apiGetMessages ({ page, size, cate, q }) {
  const params = new URLSearchParams()
  if (Number.isSafeInteger(page) && page > 1) params.set('page', String(page))
  if (Number.isSafeInteger(size) && size !== 20) params.set('size', String(size))
  if (typeof cate === 'string' && cate.length > 0) params.set('cate', cate)
  if (typeof q === 'string' && q.length > 0) params.set('q', q)
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

async function trigger (action) {
  const body = new URLSearchParams({ action })
  const { merged, done } = timedRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${BOOT.token}`
    },
    body
  })
  const p = fetch('/trigger', merged)
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
      const err = new Error('刚才那次触发已受理（正在运行或已完成），未重复执行')
      err.replayRunId = data.runId
      throw err
    }
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

// ── 组件：状态徽章 ──────────────────────────────────────────────────────────
// tone: 'ok'=正常绿 | 'bad'=异常红 | 'run'=中性黄（运行中/无记录）
// 显式字符串三态而非 true/false/null 魔值（CodeQL implicit null→string conversion）。
function Badge ({ tone, children }) {
  const cls = tone === 'ok' ? 'badge-ok' : (tone === 'bad' ? 'badge-bad' : 'badge-run')
  return html`<span class="badge ${cls}">${children}</span>`
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
    .map((k) => ({ name: k.length > 0 ? k : '(空名)', failures: raw[k].consecutiveFailures }))
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

// ── 组件：状态卡片区 ────────────────────────────────────────────────────────
function StatusCards ({ state }) {
  if (!state) return null
  const rep = state.report && state.report.value ? state.report.value : null
  // Sourcery G_od/G_oY：三态判定走 partTone——missing=中性（文件还没建很正常），
  // invalid/tooLarge=红（数据坏了必须看见），ok+健康=绿。
  const repTone = partTone(state.report, repIsOk(state))
  const run = state.run && state.run.value ? state.run.value : null
  const runTone = partTone(state.run, runIsOk(state))
  const chan = channelInfo(state)

  const cards = [
    {
      title: '今日日报',
      tone: repTone,
      lines: rep
        ? [
            `日期 ${fmtNum(rep.date)}`,
            `轮数 ${fmtNum(rep.runs)} · 抓取 ${fmtNum(rep.total)}`,
            `推送成功 ${fmtNum(rep.pushed)} · 失败 ${fmtNum(rep.failed)}`
          ]
        : ['暂无数据']
    },
    {
      title: '最近一轮',
      tone: runTone,
      lines: run
        ? [
            `${fmtNum(run.at)}`,
            `获取 ${fmtNum(run.total)} · 去重 ${fmtNum(run.dedup)} · 过滤 ${fmtNum(run.filtered)}`,
            `推送 ${fmtNum(run.pushed)} · 失败 ${fmtNum(run.failed)} · 耗时 ${fmtNum(run.elapsed)}`
          ]
        : ['暂无数据']
    },
    {
      title: '推送通道',
      tone: chan.tone,
      lines: chan.entries.length > 0
        ? chan.entries.map((e) => `${e.name}：连续失败 ${fmtNum(e.failures)} 次`)
        : [chan.note || '暂无记录']
    },
    ...diagCard(state)
  ]
  return html`<div class="cards">
    ${cards.map((c) => html`<div class="card" key=${c.title}>
      <div class="card-head">
        <span class="card-title">${c.title}</span>
        <${Badge} tone=${c.tone}>${c.tone === 'run' ? '—' : (c.tone === 'ok' ? '正常' : '异常')}<//>
      </div>
      <div class="card-lines">${c.lines.map((l) => html`<div key=${l}>${l}</div>`)}</div>
    </div>`)}
  </div>`
}

// ── 组件：触发按钮 ──────────────────────────────────────────────────────────
const ACTION_DEFS = [
  { key: 'dry-run', label: '试运行', desc: '抓取但不推送', cls: 'btn-secondary' },
  { key: 'run', label: '正式运行一轮', desc: '抓取并真实推送', cls: 'btn-primary' },
  { key: 'check', label: '环境检查', desc: '不抓取不推送', cls: 'btn-secondary' }
]

function TriggerBar ({ onTriggered, locking, setBusy }) {
  const [err, setErr] = useState('')
  const doTrigger = useCallback(async (action) => {
    setErr('')
    setBusy(true)
    try {
      // 202 响应带首轮 runId——交给 App 登记为 busy 归属（G_nv 解锁判据）。
      const data = await trigger(action)
      onTriggered(data && typeof data.id === 'number' ? data.id : null)
      // busy 不在此处清零（Sourcery vvo）：202 只代表已受理，子进程还在跑；
      // App 的「提交轮进历史」派生 + BUSY_FALLBACK 兜底负责解锁。
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

  return html`<div class="panel">
    <div class="panel-head"><span class="panel-title">手动触发</span></div>
    <div class="btn-row">
      ${ACTION_DEFS.map((a) => html`<div class="btn-item" key=${a.key}>
        <button class="btn ${a.cls}" disabled=${locking} onClick=${() => doTrigger(a.key)}>${a.label}</button>
        <span class="btn-desc">${a.desc}</span>
      </div>`)}
    </div>
    ${locking && html`<div class="hint"><span class="spin"></span> 任务进行中…（完成后自动解锁）</div>`}
    ${err && html`<div class="hint hint-err">${err}</div>`}
  </div>`
}

// ── 组件：运行历史 ──────────────────────────────────────────────────────────
function RunsPanel ({ runs, pollMs }) {
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailErr, setDetailErr] = useState('')
  // 乱序防护（Sourcery vwI）：detail 请求领号，落后响应丢弃。
  const detailSeqRef = useRef(0)

  // 切换目标 run 时立即清旧详情（Sourcery G_oi + Old-logs-flash）：useEffect 在渲染后
  // 才跑，「新 openId + 旧 detail」会闪一帧。渲染期同步判定：detail.runId 与当前 openId
  // 不符就不显示（下方 logpre 用 detailForOpen 而非裸 detail）。effect 仍负责清状态。
  useEffect(() => {
    setDetail(null)
    setDetailErr('')
  }, [openId])
  const detailForOpen = detail !== null && typeof detail.id === 'number' && detail.id === openId
    ? detail
    : null

  // 日志面板：打开期间跟随运行状态轮询（Sourcery vv-：运行中的输出要持续刷新）。
  useEffect(() => {
    if (openId === null) return undefined
    let dead = false
    let inflight = false
    const fetchOnce = async () => {
      // Sourcery Overlapping-log-polls/Slow-log-requests：详情请求慢于轮询间隔时逐 tick
      // 叠加并发请求，迟到的失败响应会把过期错误写到当前面板。与主轮询同口径：
      // 上一轮未回跳过本轮（8s 期限保证不会永久跳过）；领号防乱序保留。
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
    // S9383：fetchOnce 内部已 try/catch 全收（不会 reject），但仍显式 .catch 兜底，
    // 不留 floating promise（与 console.js 里 readBody 的处理同口径）。
    fetchOnce().catch(() => { /* 不可达：fetchOnce 不 reject */ })
    const t = setInterval(fetchOnce, pollMs)
    return () => { dead = true; clearInterval(t) }
  }, [openId, pollMs])

  // statusOf（Sourcery vv4）：以 finishedAt 为完成判据；
  // 「finishedAt 已设但 exitCode null」= 信号终止（含超时 SIGKILL），显示「已终止」。
  const statusOf = (r) => {
    if (r.finishedAt) {
      if (r.timedOut) return html`<${Badge} tone='bad'>超时<//>`
      if (r.exitCode === 0) return html`<${Badge} tone='ok'>成功<//>`
      if (r.exitCode === null) return html`<${Badge} tone='bad'>已终止<//>`
      return html`<${Badge} tone='bad'>退出码 ${r.exitCode}<//>`
    }
    if (r.exitCode === null) return html`<${Badge} tone='run'>运行中<//>`
    return html`<${Badge} tone='bad'>已终止<//>`
  }

  const openRun = openId !== null ? runs.find((r) => r.id === openId) : null
  const openActive = !!(openRun && !openRun.finishedAt)

  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">触发历史</span>
      <span class="panel-sub">最多 20 条 · 本进程内存</span>
    </div>
    ${runs.length === 0
      ? html`<div class="empty">暂无触发记录</div>`
      : html`<table class="runs-table">
        <thead><tr><th>#</th><th>动作</th><th>开始时间</th><th>结果</th><th></th></tr></thead>
        <tbody>
          ${runs.map((r) => html`<tr key=${r.id} class=${openId === r.id ? 'row-open' : ''}>
            <td class="mono">#${r.id}</td>
            <td>${r.label}</td>
            <td class="mono">${fmtTime(r.startedAt)}</td>
            <td>${statusOf(r)}</td>
            <td><button class="btn btn-ghost" onClick=${() => setOpenId(openId === r.id ? null : r.id)}>
              ${openId === r.id ? '收起' : '日志'}
            </button></td>
          </tr>`)}
        </tbody>
      </table>`}
    ${openId !== null && html`<div class="logbox">
      <div class="logbox-head">
        <span>运行 #${openId} 输出${openActive ? '（实时跟随）' : ''}</span>
        <button class="btn btn-ghost" onClick=${() => setOpenId(null)}>关闭</button>
      </div>
      <pre class="logpre">${
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

// ── 组件：整体 ──────────────────────────────────────────────────────────────
// v3.297 标签页：概览（原看板+触发+历史）/ 推送记录 / 运行日志 / 系统。
// 轮询只挂在概览（状态+历史要跟任务跑）；其余标签页进页时拉取 + 手动刷新，
// 不自动轮询——消息/日志读的是磁盘文件，5s 轮询只会白耗磁盘与带宽。

// 近 14 日趋势（纯 CSS 条形图，零依赖）：一格=一天，高度按当日推送条数归一。
// failed>0 的日子用红色渐变提示；0 推送的日子画灰色基线（看得见「没有数据」≠ 没画）。
// 面板加载器公共骨架：data/err 状态 + load()（成功清错、失败写横幅）。
// apiFn 由调用方用 useCallback/useMemo 固定引用，避免 effect 风暴。
function usePanelLoader (apiFn) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const seqRef = useRef(0) // 竞态守卫：只应用「最新一次 load」的响应（审查 Sourcery PR#227）
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const d = await apiFn()
      if (seq !== seqRef.current) return // 已有更新的请求，本次响应作废
      setData(d)
      setErr('')
    } catch (e) {
      if (seq !== seqRef.current) return
      setErr(`加载失败：${e.message}`)
    }
  }, [apiFn])
  return { data, err, load }
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
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">${shownDays ? `近 ${shownDays} 日运行趋势` : '运行趋势'}</span>
      <select class="msg-select" value=${days} onChange=${(e) => setDays(Number(e.target.value))} aria-label="趋势窗口天数">
        ${TREND_DAYS.map((d) => html`<option key=${d} value=${d}>${d} 日</option>`)}
      </select>
      <span class="panel-sub">run.log 摘要按日聚合${trends && trends.truncated ? '（日志超限，仅统计尾部 1 MiB）' : ''}</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
    ${trends && trends.status !== 'ok' && html`<div class="empty">日志${trends.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${trends.status}）`}</div>`}
    ${trends && trends.status === 'ok' && html`<div>
      <div class="trend">
        ${byDay.map((d) => html`<div class="trend-col" key=${d.date} title=${`${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}`}>
          <span class="trend-n">${d.pushed > 0 ? d.pushed : ''}</span>
          <div class=${'trend-bar' + (d.pushed === 0 ? ' zero' : '') + (d.failed > 0 ? ' fail' : '')} style=${`height:${Math.max(3, Math.round(d.pushed / maxPushed * 88))}px`}></div>
          <span class=${'trend-day' + (d.date === todayKey ? ' today' : '')}>${d.date.slice(5)}</span>
        </div>`)}
      </div>
      <div class="trend-meta">${shownDays || ''} 日共推送 ${totalAll} 条 · 失败 ${failAll} 条 · 每日轮次与抓取数悬停列查看</div>
    </div>`}
  </div>`
}

// 缓存健康（v3.298）：判重缓存字节占用对照两级上限 + 墓碑计数。纯只读快照，
// 进概览页拉一次 + 手动刷新，不进 5s 主轮询（墓碑解析最坏 8MiB，不与状态轮询抢盘）。
// 条数维度：服务端在响应里附带 entryCount（readMessageCount，与 /api/messages 同一
// 32MiB 封顶与防御；tooLarge 时 null 如实显示），对照 limits.entryMax 预警。
function CacheHealthPanel () {
  const { data, err, load } = usePanelLoader(apiGetCacheHealth)
  useEffect(() => { load().catch(() => {}) }, [load])
  const ok = data && data.status === 'ok'
  const ratioText = ok && data.writeRatio != null ? `${(data.writeRatio * 100).toFixed(1)}%` : '—'
  const tomb = data && data.tombstone ? data.tombstone : null
  // 条数预警：服务端在 cache-health 响应里附带 entryCount（/api/status 同源的
  // readMessageCount；tooLarge 时 null）对照写端条目上限；接近上限时下轮保存
  // 会裁最旧条目（与字节裁剪同一出口）。
  const entryNear = ok && typeof data.entryCount === 'number' && data.entryCount >= data.limits.entryMax * 0.8
  const entryOver = ok && typeof data.entryCount === 'number' && data.entryCount >= data.limits.entryMax
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">缓存健康</span>
      <span class="panel-sub">${data && data.file ? data.file : 'push.json'} · 判重缓存占用</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
    ${data && !ok && html`<div class="empty">${data.status === 'missing' ? '缓存尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}</div>`}
    ${ok && html`<div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>缓存大小</td><td>${fmtBytes(data.bytes)}（上限 ${fmtBytes(data.limits.writeMaxBytes)}）</td></tr>
        <tr><td>占用比例</td><td>${ratioText}${data.nearTrim ? ' · ⚠️ 临近字节裁剪' : ''}${data.overLimit ? ' · ⛔ 已超写端上限' : ''}</td></tr>
        <tr><td>条目数</td><td>${ok && typeof data.entryCount === 'number' ? `${data.entryCount} / ${data.limits.entryMax} 条上限${entryOver ? ' · ⛔ 已达上限，旧记录将被裁剪' : entryNear ? ' · ⚠️ 临近条目上限' : ''}` : `上限 ${data.limits.entryMax} 条${ok && data.entryCountStatus === 'tooLarge' ? '（当前条数不可得：缓存超控制台读取封顶）' : '（进推送记录页获取当前条数）'}`}</td></tr>
        <tr><td>控制台可读</td><td>${data.consoleReadable ? '是——未超 32 MiB 控制台读取封顶（超限与否以推送记录页实际显示为准，JSON 损坏时该页会显示「记录不可读」）' : '否——超过 32 MiB 读取封顶，推送记录页显示「过大不可读」（生产不受影响）'}</td></tr>
      </tbody></table>
      <table class="sys-table"><tbody>
        <tr><td>墓碑状态</td><td>${tomb ? (tomb.status === 'ok' ? '正常' : tomb.status === 'missing' ? '尚未生成（首轮前正常）' : `异常（${tomb.status}）`) : '—'}${tomb && tomb.status === 'ok' ? ` · ${tomb.counts.total} 键` : ''}</td></tr>
        <tr><td>最近写入</td><td>${data.mtimeMs ? fmtTime(data.mtimeMs) : '—'}（停滞 = 推送链路可能断了）</td></tr>
      </tbody></table>
    </div>`}
    ${ok && (data.nearTrim || data.overLimit || !data.consoleReadable) && html`<div class="hint" style="margin-top:10px">占用达到写端上限 80% 时，下一轮保存会自动裁掉最旧条目并落墓碑——无需人工干预，但如果你希望保留更久，检查推送频率与 maxPerRun 配置。</div>`}
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

function MessagesPanel () {
  const [page, setPage] = useState(1)
  const [size] = useState(20)
  const [cate, setCate] = useState('')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(null) // 展开的条目 rowKey（无 id 条目是 idx-N 合成键）
  // 搜索防抖：输入停 300ms 才真正改 query（重置回第 1 页）。
  useEffect(() => {
    const t = setTimeout(() => { setQuery(input.trim()); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [input])
  const fetchMessages = useCallback(
    () => apiGetMessages({ page, size, cate, q: query }),
    [page, size, cate, query])
  const { data, err, load } = usePanelLoader(fetchMessages)
  useEffect(() => { load().catch(() => {}) }, [load])
  const items = data && Array.isArray(data.items) ? data.items : []
  const categories = data && Array.isArray(data.categories) ? data.categories : []
  // 服务端对超长搜索词按字节截断——回显以 queryUsed（实际生效值）为准，避免「显示原词、结果未过滤」。
  // 只在 data 变化时对齐（standard 无 react-hooks 插件，不用行内豁免）。
  useEffect(() => {
    if (data && typeof data.queryUsed === 'string' && data.queryUsed !== input.trim()) {
      setInput(data.queryUsed)
      setQuery(data.queryUsed)
    }
  }, [data])
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">推送记录</span>
      <span class="panel-sub">判重缓存 push.json（已抓取并推送的消息）</span>
    </div>
    <div class="msg-toolbar">
      <input class="msg-search" type="search" placeholder="搜索标题 / 内容…" value=${input}
        onInput=${(e) => setInput(e.target.value)} />
      <select class="msg-select" value=${cate} onChange=${(e) => { setCate(e.target.value); setPage(1) }}>
        <option value="">全部分类</option>
        ${categories.map((c) => html`<option key=${c.name} value=${c.name}>${c.name}（${c.count}）</option>`)}
      </select>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
    ${data && data.status !== 'ok' && html`<div class="empty">记录${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}${data.cacheDirHint ? html`<div class="hint">正在读取目录：${data.cacheDirHint}（若运行缓存在别处，请让 XBK_CACHE_DIR 与运行侧 Config.cache.dir 一致）</div>` : ''}</div>`}
    ${data && data.status === 'ok' && html`<div>
      <div class="msg-count">匹配 ${data.total} 条${(query.length > 0 || cate.length > 0) && data.grandTotal !== data.total ? ` / 共 ${data.grandTotal} 条` : ''}</div>
      ${items.length === 0
        ? html`<div class="empty">没有匹配的记录</div>`
        : html`<div class="msg-list">
          ${items.map((m) => html`<div class="msg-item" key=${m.rowKey}>
            <div class="msg-item-head">
              <span class="msg-title" onClick=${() => setExpanded(expanded === m.rowKey ? null : m.rowKey)}>${m.title || '（无标题）'}</span>
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
        <button class="btn btn-secondary" disabled=${page <= 1} onClick=${() => setPage(1)}>« 首页</button>
        <button class="btn btn-secondary" disabled=${page <= 1} onClick=${() => setPage(page - 1)}>上一页</button>
        <span class="pager-info">第 ${data.page} / ${data.pages} 页</span>
        <button class="btn btn-secondary" disabled=${page >= data.pages} onClick=${() => setPage(page + 1)}>下一页</button>
        <button class="btn btn-secondary" disabled=${page >= data.pages} onClick=${() => setPage(data.pages)}>末页 »</button>
      </div>
    </div>`}
  </div>`
}

// 运行日志：run.log 尾部（服务端 1MiB 上限），进页拉一次 + 手动刷新；有任务在跑时跟随轮询。
function LogsPanel ({ pollMs }) {
  const { data, err, load } = usePanelLoader(apiGetLogs)
  useEffect(() => {
    load().catch(() => {})
    if (!pollMs) return undefined
    const t = setInterval(() => { load().catch(() => {}) }, pollMs)
    return () => clearInterval(t)
  }, [load, pollMs])
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">运行日志</span>
      <span class="panel-sub">run.log 尾部 1 MiB${pollMs ? ' · 任务运行中，实时跟随' : ''}</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
    ${data && data.status !== 'ok' && html`<div class="empty">日志${data.status === 'missing' ? '尚未生成' : `不可读（${data.status}）`}</div>`}
    ${data && data.status === 'ok' && html`<pre class="logpre">${data.text.length > 0 ? data.text : '（空）'}</pre>`}
  </div>`
}

// 系统信息：版本 / 运行环境 / 进程 / 缓存目录。全部只读，无操作按钮。
function SysPanel () {
  const { data: sys, err, load } = usePanelLoader(apiGetSys)
  useEffect(() => { load().catch(() => {}) }, [load])
  const fmtUptime = (s) => {
    if (!(typeof s === 'number' && s >= 0)) return '—'
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d} 天 ${h} 时 ${m} 分` : h > 0 ? `${h} 时 ${m} 分` : `${m} 分`
  }
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">系统信息</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
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
    <div class="hint" style="margin-top:12px">数据说明：推送记录来自判重缓存 push.json（服务端已裁剪正文 HTML）；趋势解析 run.log 摘要行；日志取尾部 1 MiB。</div>
  </div>`
}

// 状态目录文件清单（v3.298）：进系统页加载 + 手动刷新。符号链接/目录作为异常条目显性
// 展示（bytes 为 ——— 意为「不适用」，服务端不跟随符号链接、不泄露目标元数据）。
function FilesPanel () {
  const { data, err, load } = usePanelLoader(apiGetFiles)
  useEffect(() => { load().catch(() => {}) }, [load])
  const files = data && Array.isArray(data.files) ? data.files : []
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">缓存目录文件</span>
      <span class="panel-sub">${data ? `${data.total} 项${data.truncated ? '（超出展示上限，已截断）' : ''}` : ''}</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
    ${data && data.status !== 'ok' && html`<div class="empty">${data.status === 'missing' ? '目录尚未生成' : `不可读（${data.status}）`}</div>`}
    ${data && data.status === 'ok' && html`<table class="sys-table"><tbody>
      ${files.map((f) => html`<tr key=${f.name}>
        <td>${f.name}</td>
        <td>${f.kind === 'file' ? `${fmtBytes(f.bytes)} · ${f.type}` : f.kind === 'symlink' ? '⚠️ 符号链接（异常，请排查）' : f.kind}</td>
      </tr>`)}
    </tbody></table>`}
    <div class="hint" style="margin-top:10px">文件类型：cache=判重缓存 · tombstone=墓碑 · log/state=日志与状态 · lock=锁帧 · backup/temp=异常残留备份。出现 symlink/dir 即目录被异常写入，值得人工排查。</div>
  </div>`
}

// 运行配置脱敏视图（v3.298）：推送密钥只显示「已配置/未配置」，值永不下发（服务端白名单
// + 响应前保险丝双道防线）。进配置页加载 + 手动刷新。
function ConfigPanel () {
  const { data, err, load } = usePanelLoader(apiGetConfig)
  useEffect(() => { load().catch(() => {}) }, [load])
  const r = data && data.runtime ? data.runtime : null
  const pc = data && data.pushChannels ? data.pushChannels : null
  const chanNames = pc && Array.isArray(pc.perChannel) ? pc.perChannel : (pc && pc.perChannel ? Object.keys(pc.perChannel) : [])
  const filterEntries = r && r.filter ? Object.entries(r.filter) : []
  return html`<div class="panel">
    <div class="panel-head">
      <span class="panel-title">运行配置</span>
      <span class="panel-sub">脱敏视图 · 推送密钥只显示是否已配置</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onClick=${load}>刷新</button>
    </div>
    ${err && html`<div class="hint hint-err">${err}</div>`}
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
    ${r && html`<table class="sys-table" style="margin-top:12px"><tbody>
      <tr><td>推送模板</td><td>标题：${r.template.title} · 正文：${r.template.content}</td></tr>
      ${filterEntries.length > 0 && html`<tr><td>过滤规则</td><td>${filterEntries.map(([k, v]) => `${k}=${String(v).length > 0 ? v : '（空）'}`).join(' · ')}</td></tr>`}
      <tr><td>关键词订阅</td><td>${r.keyword.zkt_gjc && String(r.keyword.zkt_gjc).length > 0 ? r.keyword.zkt_gjc : '（未设置）'}</td></tr>
    </tbody></table>`}
    ${pc && html`<table class="sys-table" style="margin-top:12px"><tbody>
      <tr><td>推送渠道</td><td>${pc.moduleLoaded ? (pc.count > 0 ? `已配置 ${pc.count} 个：${pc.names.join('、')}` : '未配置任何渠道') : '配置模块加载失败（检查依赖）'}</td></tr>
      <tr><td>渠道明细</td><td>${chanNames.map((k) => `${k}：${pc.perChannel[k] ? '✅ 已配置' : '未配置'}`).join(' · ')}</td></tr>
      <tr><td>本地配置文件</td><td>${pc.localFilePresent ? 'push_config.local.js 存在（sendNotify 启动时加载；格式异常会在运行日志告警。密钥不入库不入页面）' : '未找到（用环境变量或该文件配置推送）'}</td></tr>
    </tbody></table>`}
    <div class="hint" style="margin-top:12px">本页为脱敏视图：所有推送密钥（appToken / BOT token 等）的值永不出现在页面或接口响应中，只显示「已配置 / 未配置」。修改配置请编辑 push_config.local.js 或环境变量后重启。</div>
  </div>`
}

function App () {
  const [state, setState] = useState(null)
  const [runs, setRuns] = useState([])
  const [busy, setBusy] = useState(false)
  const [lastSync, setLastSync] = useState(null)
  const [syncErr, setSyncErr] = useState('')
  const timerRef = useRef(null)
  const seqRef = useRef(0)
  // 轮询互斥（Sourcery G_oY）：上一轮未完成时跳过本轮 tick，不在途中叠加新请求
  // （fetch 有 8s 期限，跳过最多让数据晚 2-5s 更新，换来零堆积）。
  const inFlightRef = useRef(false)
  // busy 由哪一次提交引起（Sourcery G_nv：解锁判据是「提交的那一轮出现在历史里」，
  // 不管它现在是否已结束——否则任务秒完成时按钮锁到 11 分钟兜底才开）。
  const busyRunIdRef = useRef(null)
  // 首次刷新完成前不判「无活跃任务」（启动时 runs 尚空，会把丢失响应的 busy 立刻清掉）。
  const refreshedOnceRef = useRef(false)

  // vwD：逐请求独立收口——status 失败时 runs 结果仍可用（反之亦然）；
  // 并行发出（Sourcery G_n6）：串行 await 会让慢端点拖住另一端点的更新。
  // 乱序防护（Sourcery vwE）：每次 refresh 领号，落后响应直接丢弃（落后 ≠ 失败，
  // 落后者静默丢弃不报错——Sourcery vwB：报「刷新失败」是误导）。
  const refreshSplit = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    const seq = ++seqRef.current
    const errs = []
    const applyStatus = (s) => { if (seq === seqRef.current) { setState(s); setSyncErr('') } }
    const applyRuns = (r) => { if (seq === seqRef.current) { setRuns(r.runs || []); setLastSync(Date.now()) } }
    try {
      const [sRes, rRes] = await Promise.allSettled([
        apiGetStatus(),
        apiGetRuns()
      ])
      if (sRes.status === 'fulfilled') applyStatus(sRes.value)
      else errs.push(`状态 ${sRes.reason && sRes.reason.message ? sRes.reason.message : sRes.reason}`)
      if (rRes.status === 'fulfilled') applyRuns(rRes.value)
      else errs.push(`历史 ${rRes.reason && rRes.reason.message ? rRes.reason.message : rRes.reason}`)
      if (seq !== seqRef.current) return
      refreshedOnceRef.current = true
      if (errs.length > 0) setSyncErr(`刷新失败：${errs.join('；')}（自动重试中）`)
      else setSyncErr('')
    } finally {
      inFlightRef.current = false
    }
  }, [])

  // 轮询节奏（Sourcery vvJ）：任务在跑时必须用快轮询——以 locking（而非 busy）为节奏源，
  // 避免「busy 在 active 确认后被清 → 退回慢轮询」的窗口。
  // Sourcery Other-instance-idle：另一实例持锁时本进程 runs 历史是空的，此前显示「空闲」
  // 并允许触发（会被服务端 409 拒绝）。status.lock.held（共享 stateDir 的锁文件）参与判定。
  const active = runs.some((r) => !r.finishedAt) || !!(state && state.lock && state.lock.held === true)
  const locking = busy || active

  useEffect(() => {
    refreshSplit()
    clearInterval(timerRef.current)
    timerRef.current = setInterval(refreshSplit, locking ? POLL_BUSY_MS : POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [refreshSplit, locking])

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
    if (typeof runId === 'number') busyRunIdRef.current = runId
    refreshSplit()
  }, [refreshSplit])

  // v3.297 标签页状态：概览 / 推送记录 / 日志 / 系统。切到非概览页时主轮询继续跑
  // （后台保持状态新鲜，切回来即时可用），但该页的重内容组件只在挂载时拉取。
  const [tab, setTab] = useState('overview')
  const TABS = [
    { key: 'overview', label: '概览' },
    { key: 'messages', label: '推送记录' },
    { key: 'logs', label: '运行日志' },
    { key: 'config', label: '配置' },
    { key: 'sys', label: '系统' }
  ]
  return html`<div class="wrap">
    <header class="topbar">
      <div class="brand">
        <span class="logo">⚡</span>
        <span class="name">xbk-push 控制台</span>
        <${Badge} tone=${locking ? 'run' : 'ok'}>${locking ? '任务运行中' : '空闲'}<//>
      </div>
      <div class="sync">
        自动刷新${lastSync ? ` · ${fmtTime(lastSync)}` : ''}
        ${syncErr ? html`<span class="sync-err"> · ${syncErr}</span>` : ''}
      </div>
    </header>

    <nav class="tabs">
      ${TABS.map((t) => html`<button key=${t.key} class=${'tab-btn' + (tab === t.key ? ' active' : '')} onClick=${() => setTab(t.key)}>${t.label}</button>`)}
    </nav>

    ${tab === 'overview' && html`<div>
      <${TrendsPanel} />
      <${CacheHealthPanel} />
      <${StatusCards} state=${state} />
      <${TriggerBar} onTriggered=${handleTriggered} locking=${locking} setBusy=${setBusy} />
      <${RunsPanel} runs=${runs} pollMs=${locking ? POLL_BUSY_MS : POLL_MS} />
    </div>`}
    ${tab === 'messages' && html`<${MessagesPanel} />`}
    ${tab === 'logs' && html`<${LogsPanel} pollMs=${locking ? POLL_BUSY_MS : 0} />`}
    ${tab === 'config' && html`<${ConfigPanel} />`}
    ${tab === 'sys' && html`<div>
      <${SysPanel} />
      <${FilesPanel} />
    </div>`}

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送通知 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
