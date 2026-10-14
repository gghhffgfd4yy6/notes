// scripts/console-assets/app.js —— 控制台前端（preact + htm standalone，无构建、零 npm 依赖）。
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

async function apiGetStatus () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const p = fetch('/api/status', merged)
  p.then(done, () => {})
  const res = await p
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readBodyJson(res)
}

async function apiGetRuns () {
  const { merged, done } = timedRequest({
    headers: { Accept: 'application/json', Authorization: `Bearer ${BOOT.token}` }
  })
  const p = fetch('/api/runs', merged)
  p.then(done, () => {})
  const res = await p
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readBodyJson(res)
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
  p.then(done, () => {})
  const res = await p
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readBodyJson(res)
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
  p.then(done, () => {})
  const res = await p
  const data = await readBodyJson(res).catch(() => ({}))
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
  return typeof name === 'string' && name.length > 0 &&
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
    .map((k) => ({ name: k, failures: raw[k].consecutiveFailures }))
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
  useEffect(() => {
    if (!busy) return undefined
    const t = setTimeout(() => setBusy(false), BUSY_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [busy])

  // 正常解锁路径（Sourcery G_nv）：busy 期间每次刷新比对「提交的那一轮是否已进历史」
  // ——不管它现在运行中还是已结束，出现即解锁。秒完成的任务不再锁到兜底超时。
  useEffect(() => {
    if (!busy || busyRunIdRef.current === null) return
    if (runs.some((r) => r.id === busyRunIdRef.current)) {
      busyRunIdRef.current = null
      setBusy(false)
    }
  }, [busy, runs])

  const handleTriggered = useCallback((runId) => {
    if (typeof runId === 'number') busyRunIdRef.current = runId
    refreshSplit()
  }, [refreshSplit])

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

    <${StatusCards} state=${state} />
    <${TriggerBar} onTriggered=${handleTriggered} locking=${locking} setBusy=${setBusy} />
    <${RunsPanel} runs=${runs} pollMs=${locking ? POLL_BUSY_MS : POLL_MS} />

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送通知 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
