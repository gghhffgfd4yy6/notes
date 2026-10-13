'use strict'
// xbk-push 网页控制台（v3.284）：只读看板 + 手动触发。
//
// 设计约束（与仓库契约对齐，勿破坏）：
//   · 只依赖 node 内置模块 + scripts/status.js（零新 npm 依赖，青龙 --omit=dev 环境可用）；
//   · 状态展示与 --status 完全同源（readStatus/formatStatus），不另造解析口径；
//   · 手动触发用 spawnSync 拉起 qinglong/xbk_push.js 子进程（--dry-run / 单轮 / --check），
//     与命令行入口共享同一套门禁（ensureDependencies / nodeVersionWarning），不内嵌业务逻辑；
//   · 单飞锁：同一时刻只允许一个触发任务（跨触发模式互斥），用 run.lock（O_EXCL）实现，
//     锁文件含 pid 与启动时间，持有进程死亡后由 age 判定可安全接管；
//   · 鉴权：XBK_CONSOLE_TOKEN 必须设置且 ≥16 字符，否则服务拒启（fail-closed）；
//     token 比对用 timingSafeEqual（与 xbk_app 的先例同源）。
//
// 读取类端点只读缓存目录下的状态文件；触发类端点只 spawn 子进程并轮询其产物（stdout 捕获 + 退出码），
// 不写入任何缓存/状态文件——业务写入仍由被拉起的入口自己完成。

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { readStatus, formatStatus } = require('./status')

const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(ROOT, 'qinglong', 'xbk_push.js')
const RUN_LOG_MAX_BYTES = 512 * 1024
const PROC_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_MIN_LEN = 16

// 三种触发模式 → 子进程参数。均跑一轮即退出（--dry-run 与单轮天然退出；--check 只做环境检查），
// 绝不启动常驻循环（网页服务自己就是长驻进程，嵌套常驻只会制造孤儿）。
const ACTIONS = Object.freeze({
  'dry-run': { args: ['--dry-run'], label: '试运行（抓取但不推送）' },
  run: { args: [], label: '正式运行一轮（真实推送）' },
  check: { args: ['--check'], label: '环境检查（不抓取不推送）' }
})

function timingSafeEqualStr (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ba, bb)
  } catch (e) { return false }
}

function isValidToken (token) {
  return typeof token === 'string' && token.length >= TOKEN_MIN_LEN
}

// ── 单飞锁 ─────────────────────────────────────────────────────────────────
// 锁文件写 {pid, startedAt}。接管判据：锁 age 超过 PROC_TIMEOUT_MS（与子进程超时一致）
// ⇒ 持有方已死或卡死，安全覆盖。活跃持有期内的重复触发返回 409。
function lockPath (stateDir) { return path.join(stateDir, 'console-trigger.lock') }

function acquireLock (stateDir, now) {
  const p = lockPath(stateDir)
  try {
    const fd = fs.openSync(p, 'wx')
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }))
    } finally { fs.closeSync(fd) }
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') return false
    try {
      const raw = fs.readFileSync(p, 'utf8')
      let startedAt = 0
      let corrupted = false
      try { startedAt = Number(JSON.parse(raw).startedAt) || 0 } catch (err) { corrupted = true }
      // 锁内容损坏（读不到合法 startedAt）：无法判定持有方死活，保守视为仍被持有，
      // 直到 age 上限后按陈旧锁接管——但损坏内容拿不到 startedAt，age 无从谈起，
      // 故损坏时直接按「仍被持有」处理，由外部（人工/下一进程）清理，绝不盲目覆盖。
      if (corrupted) return false
      if (now - startedAt > PROC_TIMEOUT_MS) {
        // 陈旧锁接管：覆盖写（不再用 wx，此刻占有权已判定转移）。
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: now }))
        return true
      }
    } catch (err) { /* 读不到锁内容：保守视为仍被持有 */ }
    return false
  }
}

function releaseLock (stateDir) {
  try { fs.unlinkSync(lockPath(stateDir)) } catch (e) { /* 不存在即已释放 */ }
}

// ── 触发执行 ───────────────────────────────────────────────────────────────
// 子进程输出进内存缓冲（环形上限 RUN_LOG_MAX_BYTES，超限丢头部），供看板轮询；
// 结束后记录 60s 再清理。state 存进程内 Map（重启即空——锁文件在，重启后第一次触发会因
// 陈旧锁接管或等待，不会双跑）。
const runs = new Map()
let runSeq = 0

function startAction (actionKey, now) {
  const action = ACTIONS[actionKey]
  const id = ++runSeq
  const record = {
    id,
    action: actionKey,
    label: action.label,
    startedAt: now,
    finishedAt: 0,
    exitCode: null,
    timedOut: false,
    output: ''
  }
  runs.set(id, record)
  if (runs.size > 20) {
    // 只保留最近 20 条：按 id 最小的清理（id 单调递增即最旧）。
    const oldest = [...runs.keys()].sort((a, b) => a - b).slice(0, runs.size - 20)
    for (const k of oldest) runs.delete(k)
  }
  const child = spawn(process.execPath, [ENTRY, ...action.args], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let buf = ''
  const append = (chunk) => {
    buf += chunk.toString('utf8')
    if (buf.length > RUN_LOG_MAX_BYTES) buf = buf.slice(buf.length - RUN_LOG_MAX_BYTES)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const timer = setTimeout(() => {
    record.timedOut = true
    try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
  }, PROC_TIMEOUT_MS)
  child.on('close', (code) => {
    clearTimeout(timer)
    record.exitCode = code
    record.finishedAt = Date.now()
    record.output = buf
    releaseLockFor(record)
  })
  return record
}

function releaseLockFor (record) {
  // 只有仍持有锁的本次运行才释放：锁被陈旧接管后 pid 换人，此时不误删。
  try {
    const raw = fs.readFileSync(lockPath(record._stateDir), 'utf8')
    const data = JSON.parse(raw)
    if (data.pid === process.pid && data.startedAt === record._lockAt) releaseLock(record._stateDir)
  } catch (e) { /* 锁已不在：无事可做 */ }
}

// ── HTML 看板 ──────────────────────────────────────────────────────────────
function escapeHtml (s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function formatMs (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 100) / 10
  return `${s}s`
}

function renderPage (state, runsList) {
  const statusText = formatStatus(state)
  const statusLines = statusText.split('\n').map(escapeHtml)
  const runRows = runsList.map((r) => {
    const state = r.exitCode === null
      ? (r.timedOut ? '超时终止' : '运行中')
      : (r.exitCode === 0 ? '✅ 成功' : `❌ 退出码 ${r.exitCode}`)
    return `<tr><td>#${r.id}</td><td>${escapeHtml(r.label)}</td><td>${escapeHtml(new Date(r.startedAt).toISOString())}</td><td>${state}</td></tr>`
  }).join('')
  const buttons = Object.entries(ACTIONS).map(([key, a]) =>
    `<form method="POST" action="/trigger" style="display:inline"><input type="hidden" name="action" value="${key}"><button type="submit">${escapeHtml(a.label)}</button></form>`).join(' ')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>xbk-push 控制台</title>
<meta http-equiv="refresh" content="15">
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem;background:#fafafa;color:#222}
pre{background:#fff;border:1px solid #ddd;padding:1rem;white-space:pre-wrap;word-break:break-all}
button{padding:0.5rem 1rem;margin-right:0.5rem;cursor:pointer}
table{border-collapse:collapse;width:100%;background:#fff}
td,th{border:1px solid #ddd;padding:0.4rem 0.6rem;text-align:left;font-size:0.9rem}
.warn{color:#b45309}
</style></head><body>
<h1>xbk-push 控制台</h1>
<section><h2>运行状态</h2><pre>${statusLines.join('\n')}</pre></section>
<section><h2>手动触发</h2><p>${buttons}</p>
<p class="warn">⚠️ 「正式运行一轮」会真实推送通知；「试运行」抓取但不推送。同一时刻只能有一个触发任务。</p></section>
<section><h2>最近触发（最多 20 条，本进程内存）</h2>
<table><tr><th>#</th><th>动作</th><th>开始时间(UTC)</th><th>结果</th></tr>${runRows || '<tr><td colspan="4">暂无</td></tr>'}</table></section>
</body></html>`
}

// ── HTTP 服务 ──────────────────────────────────────────────────────────────
// 鉴权：Authorization: Bearer <token>（读取与触发同 token）。不设 cookie/session——
// 单用户自用工具，恒定 token 已足够；timingSafeEqual 防时序侧信道。
function authorize (req, token) {
  const header = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/.exec(header)
  if (!m) return false
  return timingSafeEqualStr(m[1], token)
}

function sendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody (req, maxBytes = 4096) {
  return new Promise((resolve) => {
    let buf = ''
    let over = false
    req.on('data', (c) => {
      buf += c.toString('utf8')
      if (buf.length > maxBytes) over = true
    })
    req.on('end', () => resolve({ body: buf, over }))
    req.on('error', () => resolve({ body: buf, over }))
  })
}

function parseAction (body) {
  // application/x-www-form-urlencoded 或裸 action=xxx
  const m = /(?:^|&)action=([^&]*)/.exec(body)
  if (!m) return null
  let v = m[1]
  try { v = decodeURIComponent(v.replace(/\+/g, ' ')) } catch (e) { return null }
  return Object.prototype.hasOwnProperty.call(ACTIONS, v) ? v : null
}

function createConsole ({ token, stateDir, port = 0, host = '127.0.0.1', log = console.log }) {
  if (!isValidToken(token)) {
    throw new Error(`XBK_CONSOLE_TOKEN 未设置或短于 ${TOKEN_MIN_LEN} 字符，控制台拒绝启动（fail-closed）`)
  }
  fs.mkdirSync(stateDir, { recursive: true })

  const server = http.createServer((req, res) => {
    if (!authorize(req, token)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/') {
      const state = readStatus(stateDir)
      const runsList = [...runs.values()].sort((a, b) => b.id - a.id)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderPage(state, runsList))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, readStatus(stateDir))
      return
    }
    if (req.method === 'POST' && url.pathname === '/trigger') {
      readBody(req).then(({ body }) => {
        const action = parseAction(body)
        if (!action) {
          sendJson(res, 400, { error: '未知 action' })
          return
        }
        const now = Date.now()
        if (!acquireLock(stateDir, now)) {
          sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试' })
          return
        }
        const record = startAction(action, now)
        record._stateDir = stateDir
        record._lockAt = now
        sendJson(res, 202, { id: record.id, action, label: record.label })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const list = [...runs.values()].sort((a, b) => b.id - a.id).map((r) => ({
        id: r.id,
        action: r.action,
        label: r.label,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        exitCode: r.exitCode,
        timedOut: r.timedOut
      }))
      sendJson(res, 200, { runs: list })
      return
    }
    const runMatch = /^\/api\/runs\/(\d+)$/.exec(url.pathname)
    if (req.method === 'GET' && runMatch) {
      const record = runs.get(Number(runMatch[1]))
      if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
      sendJson(res, 200, {
        id: record.id,
        action: record.action,
        label: record.label,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        exitCode: record.exitCode,
        timedOut: record.timedOut,
        output: record.output
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  return { server, runs }
}

// ── 启动入口 ───────────────────────────────────────────────────────────────
function main () {
  const token = process.env.XBK_CONSOLE_TOKEN
  const port = Number(process.env.XBK_CONSOLE_PORT) || 7777
  const host = process.env.XBK_CONSOLE_HOST || '127.0.0.1'
  const stateDir = process.env.XBK_CACHE_DIR && path.isAbsolute(process.env.XBK_CACHE_DIR)
    ? process.env.XBK_CACHE_DIR
    : path.join(ROOT, 'xianbaoku_cache')
  const { server } = createConsole({ token, stateDir, port, host })
  server.listen(port, host, () => {
    console.log(`xbk-push 控制台已启动：http://${host}:${server.address().port}（缓存目录：${stateDir}）`)
    console.log('鉴权：请求头 Authorization: Bearer <XBK_CONSOLE_TOKEN>；XBK_CONSOLE_TOKEN 未设置或过短则拒绝启动')
  })
}

if (require.main === module) main()

module.exports = {
  createConsole,
  isValidToken,
  timingSafeEqualStr,
  acquireLock,
  releaseLock,
  lockPath,
  parseAction,
  escapeHtml,
  formatMs,
  ACTIONS,
  TOKEN_MIN_LEN,
  RUN_LOG_MAX_BYTES,
  PROC_TIMEOUT_MS
}
