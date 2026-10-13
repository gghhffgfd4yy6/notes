// scripts/console-assets/app.js —— 控制台前端（preact + htm standalone，无构建、零 npm 依赖）。
// 数据面：GET /api/status、/api/runs、/api/runs/:id（同源，GET 一律带 ?token=——
// authorize 在读 body 前只看请求头/查询参数，GET 无 body 必须显式拼 URL）。
// 动作面：POST /trigger（token 同时在 URL 与 body，两种通道都成立）。
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

// 所有 fetch 统一带 ?token=（页面流没有请求头，token 只能走查询参数）。
function withToken (path) {
  return `${path}?token=${encodeURIComponent(BOOT.token)}`
}

const POLL_MS = 5000
const POLL_BUSY_MS = 2000

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
async function apiGet (path) {
  const res = await fetch(withToken(path), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function trigger (action) {
  const body = new URLSearchParams({ action })
  const res = await fetch(withToken('/trigger'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── 组件：状态徽章 ──────────────────────────────────────────────────────────
// tone: 'ok'=正常绿 | 'bad'=异常红 | 'run'=中性黄（运行中/无记录）
// 显式字符串三态而非 true/false/null 魔值（CodeQL implicit null→string conversion）。
function Badge ({ tone, children }) {
  const cls = tone === 'ok' ? 'badge-ok' : (tone === 'bad' ? 'badge-bad' : 'badge-run')
  return html`<span class="badge ${cls}">${children}</span>`
}

// ── 状态归类（Sourcery vvy/vv4/vvX/vwc：错误态/中断态/畸形条目不得伪装成健康）──
// runOk：最近一轮必须「status=ok 且未中断」才算绿。
function runIsOk (state) {
  if (!state || !state.run) return false
  if (state.run.status !== 'ok') return false
  const v = state.run.value || {}
  return v.interrupted !== true
}

// 通道条目合法性：名字非空 + 是对象 + consecutiveFailures 是数字（畸形条目不进展示与健康判定）。
function validChannelEntry (name, entry) {
  return typeof name === 'string' && name.length > 0 &&
    entry !== null && typeof entry === 'object' &&
    typeof entry.consecutiveFailures === 'number'
}

function channelInfo (state) {
  const raw = state && state.channels && state.channels.value && typeof state.channels.value === 'object'
    ? state.channels.value
    : null
  if (!raw) return { tone: 'bad', entries: [], note: '暂无记录' }
  const entries = Object.keys(raw)
    .filter((k) => validChannelEntry(k, raw[k]))
    .map((k) => ({ name: k, failures: raw[k].consecutiveFailures }))
  if (state.channels.status !== 'ok') return { tone: 'bad', entries, note: '状态异常' }
  // 空表 ≠ 未配置：只显示中性「暂无记录」（Sourcery vwc）。
  if (entries.length === 0) return { tone: 'run', entries, note: '暂无记录' }
  const tone = entries.every((e) => e.failures === 0) ? 'ok' : 'bad'
  return { tone, entries, note: '' }
}

// ── 组件：状态卡片区 ────────────────────────────────────────────────────────
function StatusCards ({ state }) {
  if (!state) return null
  const rep = state.report && state.report.value ? state.report.value : null
  const repOk = !!(state.report && state.report.status === 'ok')
  const run = state.run && state.run.value ? state.run.value : null
  const runOk = runIsOk(state)
  const chan = channelInfo(state)

  const cards = [
    {
      title: '今日日报',
      tone: repOk ? 'ok' : 'bad',
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
      tone: runOk ? 'ok' : 'bad',
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
    }
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
      await trigger(action)
      onTriggered()
      // busy 不在此处清零（Sourcery vvo）：202 只代表已受理，子进程还在跑；
      // App 的 active 派生会在轮询看到全部 finishedAt 后自动解锁。
    } catch (e) {
      setErr(e.message === '已有触发任务在运行（或锁未过期），请稍后再试'
        ? '已有任务在运行，请等它结束'
        : `触发失败：${e.message}`)
      setBusy(false) // 只有「提交失败」才立即解锁；提交成功的解锁交给 active 派生
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

  // 日志面板：打开期间跟随运行状态轮询（Sourcery vv-：运行中的输出要持续刷新）。
  useEffect(() => {
    if (openId === null) { setDetail(null); setDetailErr(''); return undefined }
    let dead = false
    const fetchOnce = async () => {
      try {
        const d = await apiGet(`/api/runs/${openId}`)
        if (dead) return
        setDetail(d)
        setDetailErr('')
      } catch (e) {
        if (!dead) setDetailErr(`加载失败：${e.message}`)
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
      <pre class="logpre">${detailErr || (detail && detail.output ? detail.output : (openActive ? '等待输出…' : '加载中…'))}</pre>
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

  const refresh = useCallback(async () => {
    // 乱序防护（Sourcery vwE）：每次 refresh 领号，落后响应直接丢弃。
    const seq = ++seqRef.current
    try {
      const [s, r] = await Promise.all([apiGet('/api/status'), apiGet('/api/runs')])
      if (seq !== seqRef.current) return
      setState(s)
      setRuns(r.runs || [])
      setLastSync(Date.now())
      setSyncErr('')
    } catch (e) {
      if (seq !== seqRef.current) return
      // Sourcery vwN：读失败必须可见（不能静默吞掉让卡片停在旧数据上）。
      setSyncErr(`刷新失败：${e.message}（自动重试中）`)
    }
  }, [])

  // 轮询节奏：基础 5s；locking（任务在跑）时 2s。
  useEffect(() => {
    refresh()
    clearInterval(timerRef.current)
    timerRef.current = setInterval(refresh, busy ? POLL_BUSY_MS : POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [refresh, busy])

  // active/busy 解耦（Sourcery vvo）：busy=「已提交、还没在历史里看到」；
  // active 由运行历史派生（存在未 finishedAt 的记录）。两者合成为 locking：
  // locking=true → 按钮锁定 + 2s 快轮询；全部转假 → 自动解锁回 5s。
  const active = runs.some((r) => !r.finishedAt)
  const locking = busy || active
  useEffect(() => {
    if (busy && active) setBusy(false) // 轮询已确认任务进了历史 → busy 使命完成
  }, [busy, active])

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
    <${TriggerBar} onTriggered=${refresh} locking=${locking} setBusy=${setBusy} />
    <${RunsPanel} runs=${runs} pollMs=${locking ? POLL_BUSY_MS : POLL_MS} />

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送通知 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
