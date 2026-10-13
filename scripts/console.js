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
const { StringDecoder } = require('node:string_decoder')
const { readStatus, formatStatus } = require('./status')
const { statusCacheDir } = require('../qinglong/xbk_push')

const ROOT = path.resolve(__dirname, '..')
const RUN_LOG_MAX_BYTES = 512 * 1024
const PROC_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_MIN_LEN = 16

// 三种触发模式 → 子进程参数。均跑一轮即退出（--dry-run 与单轮天然退出；--check 只做环境检查），
// 绝不启动常驻循环（网页服务自己就是长驻进程，嵌套常驻只会制造孤儿）。
// ⚠️ `run` 必须指向 xbk_function_v3.js（其 require.main 分支是 runSingleEntry：单轮 + 真实推送）；
// qinglong/xbk_push.js 无参数时是常驻模式——曾据此误配，Sourcery 评审指出后修正。
const ACTIONS = Object.freeze({
  'dry-run': { entry: 'qinglong', args: ['--dry-run'], label: '试运行（抓取但不推送）' },
  run: { entry: 'single', args: [], label: '正式运行一轮（真实推送）' },
  check: { entry: 'qinglong', args: ['--check'], label: '环境检查（不抓取不推送）' }
})
const ENTRY_QINGLONG = path.join(ROOT, 'qinglong', 'xbk_push.js')
const ENTRY_SINGLE = path.join(ROOT, 'xbk_function_v3.js')

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

function writeLockAtomic (p, now) {
  // 独占创建 + 先写内容再占用：以 `<name>.<rand>.tmp`（wx）写完整内容后 rename 覆盖，
  // 中断只会留下孤立 tmp（无害），不会留下「文件存在但内容残缺」的半成品锁。
  // ⚠️ rename 在 POSIX 语义下会静默替换已存在目标，独占性只能由 open(wx) 保证：
  // 正确顺序是先 open(p, 'wx') 抢占文件名（并发方在这里 EEXIST 失败），再把完整内容
  // 写进同一 fd——不能走 rename 覆盖路径，否则二次获取会静默成功。
  const fd = fs.openSync(p, 'wx')
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }))
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function acquireLock (stateDir, now) {
  const p = lockPath(stateDir)
  try {
    // 第一层：直接独占创建（无锁时最常见路径）。
    writeLockAtomic(p, now)
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') return false
  }
  // 第二层：锁已存在——读内容判定死活。陈旧接管仍以「独占 rename 覆盖」收口：
  // rename 覆盖是原子替换，两个并发接管进程各自 prepared tmp 后同时 rename，
  // 只有一个会成功成为最终内容——但两者都已判定 takeover 并 spawn。故接管前用
  // 独占哨兵：先以 wx 创建 `<name>.takeover` 抢接管权，抢到的才允许覆盖锁。
  try {
    const raw = fs.readFileSync(p, 'utf8')
    let startedAt = 0
    let corrupted = false
    try {
      const parsed = JSON.parse(raw)
      startedAt = Number(parsed.startedAt)
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) corrupted = true
    } catch (err) { corrupted = true }
    // 锁内容损坏/startedAt 无效（Sourcery Medium #11）：无法判定持有方死活，fail-closed
    // 视为仍被持有，由外部人工清理（README「故障排查」节说明）。不降级为按 age 接管——
    // 那会让损坏锁在超时后被自动覆盖，重新引入「无法安全分类的锁被承认」问题。
    if (corrupted) return false
    const stale = now - startedAt > PROC_TIMEOUT_MS
    if (!stale) return false
    // 陈旧/损坏锁接管：哨兵独占，防并发接管双跑（Sourcery High）。
    const sentinel = p + '.takeover'
    let claimed = false
    try {
      const fd = fs.openSync(sentinel, 'wx')
      fs.closeSync(fd)
      claimed = true
    } catch (err) {
      if (err.code === 'EEXIST') {
        // 哨兵已存在：看它是否也陈旧（上次接管者死了留下的）。
        try {
          const sAge = now - (fs.statSync(sentinel).mtimeMs || 0)
          if (sAge > PROC_TIMEOUT_MS) {
            fs.writeFileSync(sentinel, String(now))
            claimed = true
          }
        } catch (err2) { claimed = false }
      }
    }
    if (!claimed) return false
    // takeover 路径不能再用 open(wx) 写锁（目标存在必 EEXIST）：锁内容短且由
    // rename 静默替换语义恰好覆盖旧文件——原子替换、无半成品窗口。
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: now }))
    try { fs.unlinkSync(sentinel) } catch (err) { /* 并发接管者会各自清自己的 */ }
    return true
  } catch (err) {
    return false
  }
}

function releaseLock (stateDir) {
  try { fs.unlinkSync(lockPath(stateDir)) } catch (e) { /* 不存在即已释放 */ }
}

// ── 触发执行 ───────────────────────────────────────────────────────────────
// 子进程输出进内存缓冲（环形上限 RUN_LOG_MAX_BYTES，按 UTF-8 字节计），供看板轮询；
// 运行中即可读（增量写 record.output）。state 存进程内 Map（重启即空——锁文件在，
// 重启后第一次触发会因陈旧锁接管或等待，不会双跑）。
const runs = new Map()
let runSeq = 0
// run ID = 单调序列，Map 重启即清空；「重启后旧 URL 命中新记录」的窗口由
// /api/runs/:id 的 404 文案（「进程重启后历史丢失」）向用户说明，不做持久化映射。

function startAction (actionKey, now, activeChildren) {
  const action = ACTIONS[actionKey]
  const id = ++runSeq
  const entryFile = action.entry === 'single' ? ENTRY_SINGLE : ENTRY_QINGLONG
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
  // 环境继承：剥离 XBK_DRY_RUN（Sourcery High：控制台自身带 XBK_DRY_RUN=1 时，
  // 「正式运行」会被子进程静默降级为 dry-run，承诺的推送不会发生）。
  const childEnv = { ...process.env }
  delete childEnv.XBK_DRY_RUN
  const child = spawn(process.execPath, [entryFile, ...action.args], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (activeChildren) activeChildren.add(child)
  const decoder = new StringDecoder('utf8')
  const append = (chunk) => {
    // StringDecoder 处理跨 chunk 的多字节 UTF-8（Sourcery Medium：逐 chunk toString 产生替换符）。
    let buf = record.output + decoder.write(chunk)
    // 上限按 UTF-8 字节计（Buffer.byteLength），超限从字节边界近似回退丢头部。
    if (Buffer.byteLength(buf, 'utf8') > RUN_LOG_MAX_BYTES) {
      let drop = Buffer.byteLength(buf, 'utf8') - RUN_LOG_MAX_BYTES
      while (drop > 0 && buf.length > 0) {
        drop -= Buffer.byteLength(buf[0], 'utf8')
        buf = buf.slice(1)
      }
    }
    record.output = buf
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.on('error', (err) => {
    // spawn 失败（ENOENT 等）：不能让 uncaught 崩掉控制台（Sourcery Medium），
    // 也不能把 run 永久留在「运行中」。close 事件在 spawn error 后仍会触发，
    // 这里只登记原因，收尾交给 close。
    record.output += `\n[console] 子进程启动失败：${err && err.message ? err.message : String(err)}\n`
  })
  const timer = setTimeout(() => {
    record.timedOut = true
    try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
  }, PROC_TIMEOUT_MS)
  child.on('close', (code) => {
    clearTimeout(timer)
    if (activeChildren) activeChildren.delete(child)
    record.exitCode = code
    record.finishedAt = Date.now()
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

function renderPage (state, runsList, query) {
  const statusText = formatStatus(state)
  const statusLines = statusText.split('\n').map(escapeHtml)
  // 浏览器流（Sourcery High）：原生表单/meta refresh 带不了请求头，token 经查询参数传递。
  // 仅在本请求本身通过鉴权后才回显（token 已验证合法，原样传递；不新增任何存储）。
  const tokenSuffix = (query instanceof URLSearchParams && query.get('token'))
    ? `?token=${encodeURIComponent(query.get('token'))}`
    : ''
  const runRows = runsList.map((r) => {
    const state = r.exitCode === null
      ? (r.timedOut ? '超时终止' : '运行中')
      : (r.exitCode === 0 ? '✅ 成功' : `❌ 退出码 ${r.exitCode}`)
    return `<tr><td>#${r.id}</td><td>${escapeHtml(r.label)}</td><td>${escapeHtml(new Date(r.startedAt).toISOString())}</td><td>${state}</td></tr>`
  }).join('')
  const buttons = Object.entries(ACTIONS).map(([key, a]) =>
    `<form method="POST" action="/trigger${escapeHtml(tokenSuffix)}" style="display:inline"><input type="hidden" name="action" value="${key}"><button type="submit">${escapeHtml(a.label)}</button></form>`).join(' ')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>xbk-push 控制台</title>
<meta http-equiv="refresh" content="15${escapeHtml(tokenSuffix)}">
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
// 鉴权：Authorization: Bearer *** 或 ?token=***（Sourcery High：浏览器导航、原生表单、
// meta refresh 都带不了自定义请求头，只有查询参数能让浏览器直接打开看板）。
// 单用户自用工具，恒定 token 已足够；timingSafeEqual 防时序侧信道。
// 解析不用正则（CodeQL js/polynomial-redos：`Bearer ` + 大量空白会让 `\s+(.+)$` 回溯）：
// 手写前缀匹配 + 切片，线性且语义等价（`Bearer ` 后取剩余全部，trim 一次容忍尾随空白）。
// ⚠️ ?token= 会进访问日志/浏览器历史：README 明确建议只在受信网络或 TLS 代理后使用。
const BEARER_PREFIX = 'Bearer '
function authorize (req, token, urlQuery) {
  const header = req.headers.authorization || ''
  if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
    const value = header.slice(BEARER_PREFIX.length)
    if (value.length > 0 && timingSafeEqualStr(value.trim(), token)) return true
  }
  // 浏览器路径：?token=xxx（urlQuery 由调用方传 URLSearchParams；单独接收以便测试）
  const supplied = urlQuery instanceof URLSearchParams ? urlQuery.get('token') : null
  if (typeof supplied === 'string' && supplied.length > 0 && timingSafeEqualStr(supplied, token)) return true
  return false
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
    let aborted = false
    req.on('data', (c) => {
      if (over) { req.destroy(); return } // Sourcery Medium：超限即断流，不再吸收内存
      buf += c.toString('utf8')
      if (buf.length > maxBytes) over = true
    })
    req.on('end', () => resolve({ body: buf, over, aborted }))
    // Sourcery Medium：error 时标记 aborted——残缺 body 不允许触发动作。
    req.on('error', () => { aborted = true; resolve({ body: buf, over, aborted }) })
    req.on('aborted', () => { aborted = true; resolve({ body: buf, over, aborted }) })
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
  // 活跃子进程登记（Sourcery High：控制台关闭时子进程要一并终止，否则触发任务
  // 会在控制服务消失后继续抓取/推送）。close 回调里自行从集合摘除。
  const activeChildren = new Set()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!authorize(req, token, url.searchParams)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const state = readStatus(stateDir)
      const runsList = [...runs.values()].sort((a, b) => b.id - a.id)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderPage(state, runsList, url.searchParams))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, readStatus(stateDir))
      return
    }
    if (req.method === 'POST' && url.pathname === '/trigger') {
      // S9383：promise 必须显式收尾——readBody 以 resolve 收口不会 reject，但仍接 .catch
      // 把意外异常转成 500，不留 floating promise。
      readBody(req)
        .then(({ body, aborted, over }) => {
          // Sourcery Medium：请求中断（error 后 resolve）时 body 可能已含 action=run，
          // 客户端却已放弃——绝不能凭残缺请求启动真实推送；超限同理拒绝。
          if (aborted) { sendJson(res, 400, { error: '请求中断，动作未执行' }); return }
          if (over) { sendJson(res, 413, { error: '请求体超限' }); return }
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
          const record = startAction(action, now, activeChildren)
          record._stateDir = stateDir
          record._lockAt = now
          sendJson(res, 202, { id: record.id, action, label: record.label })
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
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
  // Sourcery High：关闭时终止所有活跃子进程（SIGKILL），避免控制台停了触发任务还在跑。
  // 覆写 close：先杀子进程再走原生 close；'close' 事件再兜底清一次。
  const killAll = () => {
    for (const child of activeChildren) {
      try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
    }
  }
  const origClose = server.close.bind(server)
  server.close = (cb) => {
    killAll()
    return origClose(cb)
  }
  server.on('close', killAll)
  return { server, runs, activeChildren }
}

// ── 启动入口 ───────────────────────────────────────────────────────────────
function main () {
  const token = process.env.XBK_CONSOLE_TOKEN
  const port = Number(process.env.XBK_CONSOLE_PORT) || 7777
  const host = process.env.XBK_CONSOLE_HOST || '127.0.0.1'
  // Sourcery Medium：与生产入口 / --status 同源解析缓存目录（含安全回退），
  // 不再手写默认值——否则 .xbk_cache_safe 生效时看板会读错目录。
  const stateDir = statusCacheDir()
  const { server } = createConsole({ token, stateDir, port, host })
  server.listen(port, host, () => {
    console.log(`xbk-push 控制台已启动：http://${host}:${server.address().port}（缓存目录：${stateDir}）`)
    console.log('鉴权：请求头 Authorization: Bearer <XBK_CONSOLE_TOKEN>，或浏览器打开 http://<host>:<port>/?token=<XBK_CONSOLE_TOKEN>；token 未设置或过短则拒绝启动')
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      // Sourcery High：非回环绑定 = token 明文过网（HTTP 无 TLS）。此处只告警不强拒——
      // 内网受信环境是 README 认可的用法，但必须让操作者知道风险与缓解手段。
      console.warn('⚠️ XBK_CONSOLE_HOST 绑定的是非回环地址：Bearer/查询参数 token 将以明文传输（HTTP）。')
      console.warn('   仅在受信内网使用；跨网访问请前置 TLS 反代（nginx/caddy 终止 TLS 后转发本端口）。')
    }
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
  renderPage,
  authorize,
  ACTIONS,
  TOKEN_MIN_LEN,
  RUN_LOG_MAX_BYTES,
  PROC_TIMEOUT_MS
}
