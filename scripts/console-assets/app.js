// scripts/console-assets/app.js —— 控制台前端（preact + htm standalone，无构建、零 npm 依赖）。
// 数据面：GET /api/status、/api/runs、/api/runs/:id（同源）。动作面：POST /trigger。
import { h, render, useState, useEffect, useRef, useCallback } from './htm-preact.module.js'

// token 由 renderPage 注入的 JSON 岛（<script type="application/json" id="xbk-boot">）提供。
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

const html = h
const POLL_MS = 5000

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
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function trigger (action) {
  const body = new URLSearchParams({ action, token: BOOT.token })
  const res = await fetch('/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── 组件：状态徽章 ──────────────────────────────────────────────────────────
// ok: true=正常绿 false=异常红 null=运行中黄
function Badge ({ ok, children }) {
  const cls = ok === null ? 'badge-run' : (ok ? 'badge-ok' : 'badge-bad')
  return html`<span class="badge ${cls}">${children}</span>`
}

// ── 组件：状态卡片区 ────────────────────────────────────────────────────────
function StatusCards ({ state }) {
  if (!state) return null
  const rep = state.report && state.report.value ? state.report.value : null
  const repOk = !!(state.report && state.report.status === 'ok')
  const run = state.run && state.run.value ? state.run.value : null
  const runOk = !!(state.run && state.run.status === 'ok')
  const chans = state.channels && state.channels.value ? state.channels.value : {}
  const chanNames = Object.keys(chans)
  const chanOk = state.channels && state.channels.status === 'ok' && chanNames.length > 0 &&
    chanNames.every((k) => chans[k] && chans[k].consecutiveFailures === 0)

  const cards = [
    {
      title: '今日日报',
      ok: repOk,
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
      ok: runOk,
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
      ok: chanOk,
      lines: chanNames.length > 0
        ? chanNames.map((k) => {
          const c = chans[k] || {}
          return `${k}：连续失败 ${fmtNum(c.consecutiveFailures)} 次`
        })
        : ['未配置通道']
    }
  ]
  return html`<div class="cards">
    ${cards.map((c) => html`<div class="card" key=${c.title}>
      <div class="card-head">
        <span class="card-title">${c.title}</span>
        <${Badge} ok=${c.ok}>${c.ok ? '正常' : '异常'}<//>
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

function TriggerBar ({ onTriggered, busy, setBusy }) {
  const [err, setErr] = useState('')
  const doTrigger = useCallback(async (action) => {
    setErr('')
    setBusy(true)
    try {
      await trigger(action)
      onTriggered()
    } catch (e) {
      setErr(e.message === '已有触发任务在运行（或锁未过期），请稍后再试'
        ? '已有任务在运行，请等它结束'
        : `触发失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [onTriggered, setBusy])

  return html`<div class="panel">
    <div class="panel-head"><span class="panel-title">手动触发</span></div>
    <div class="btn-row">
      ${ACTION_DEFS.map((a) => html`<div class="btn-item" key=${a.key}>
        <button class="btn ${a.cls}" disabled=${busy} onClick=${() => doTrigger(a.key)}>${a.label}</button>
        <span class="btn-desc">${a.desc}</span>
      </div>`)}
    </div>
    ${busy && html`<div class="hint"><span class="spin"></span> 任务已提交，正在等待结果…</div>`}
    ${err && html`<div class="hint hint-err">${err}</div>`}
  </div>`
}

// ── 组件：运行历史 ──────────────────────────────────────────────────────────
function RunsPanel ({ runs }) {
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    if (openId === null) { setDetail(null); return undefined }
    let dead = false
    setDetail(null)
    apiGet(`/api/runs/${openId}`)
      .then((d) => { if (!dead) setDetail(d) })
      .catch(() => {})
    return () => { dead = true }
  }, [openId])

  const statusOf = (r) => {
    if (r.exitCode === null) {
      return r.timedOut
        ? html`<${Badge} ok=${false}>超时<//>`
        : html`<${Badge} ok=${null}>运行中<//>`
    }
    return r.exitCode === 0
      ? html`<${Badge} ok=${true}>成功<//>`
      : html`<${Badge} ok=${false}>退出码 ${r.exitCode}<//>`
  }

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
        <span>运行 #${openId} 输出</span>
        <button class="btn btn-ghost" onClick=${() => setOpenId(null)}>关闭</button>
      </div>
      <pre class="logpre">${detail && detail.output ? detail.output : '加载中…'}</pre>
    </div>`}
  </div>`
}

// ── 组件：整体 ──────────────────────────────────────────────────────────────
function App () {
  const [state, setState] = useState(null)
  const [runs, setRuns] = useState([])
  const [busy, setBusy] = useState(false)
  const [lastSync, setLastSync] = useState(null)
  const timerRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([apiGet('/api/status'), apiGet('/api/runs')])
      setState(s)
      setRuns(r.runs || [])
      setLastSync(Date.now())
    } catch (e) { /* 网络抖动：下轮轮询重试，不打断页面 */ }
  }, [])

  // 基础轮询 5s；busy（任务已提交）期间加密到 2s，尽快反映「运行中→完成」。
  useEffect(() => {
    refresh()
    clearInterval(timerRef.current)
    timerRef.current = setInterval(refresh, busy ? 2000 : POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [refresh, busy])

  const active = runs.length > 0 && runs[0].exitCode === null

  return html`<div class="wrap">
    <header class="topbar">
      <div class="brand">
        <span class="logo">⚡</span>
        <span class="name">xbk-push 控制台</span>
        <${Badge} ok=${active ? null : true}>${active ? '任务运行中' : '空闲'}<//>
      </div>
      <div class="sync">自动刷新${lastSync ? ` · ${fmtTime(lastSync)}` : ''}</div>
    </header>

    <${StatusCards} state=${state} />
    <${TriggerBar} onTriggered=${refresh} busy=${busy} setBusy=${setBusy} />
    <${RunsPanel} runs=${runs} />

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送通知 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
