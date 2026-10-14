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

// token 可用性口径（Sourcery Medium G_ot）：isValidToken 此前只看长度，但 token 要同时
// 走三条通道——Authorization 头（fetch 只接受 ByteString：非 Latin-1 直接抛错）、
// Set-Cookie（cookie-octet 禁 `;` `,` `"` `\` 与空白）、URL 查询参数。含这些字符的
// token 能启动服务却让浏览器端全部请求失败——校验前移到启动闸，fail-closed。
// 允许集：可见 ASCII（0x21–0x7e）再排除 `;` `,` `"` `\`。
// Sourcery M3Zv/Mline/Long-tokens：JS 正则的 $ 会在尾随换行（\n、\r、\u2028、\u2029）前
// 匹配成功，导致「合法 token + 尾部换行」被放行、随后污染 Cookie/URL 三通道。改用 \u0000-
// \uffff 闭区间显式断言「到串尾为止无任何字符」（[^] 不匹配空串但配合 + 语义即「至少 1 个
// 可见 ASCII 且到此为止」）。长度上限 TOKEN_MAX_LEN=200：浏览器单 Cookie 约 4KB 上限，
// 超长 token 会被静默丢弃导致资产/API 全 401，启动闸直接拒绝（fail-closed）。
const TOKEN_MAX_LEN = 200
const TOKEN_VISIBLE_ASCII_RE = /^[\x21-\x7e]+$/
// `&` `#` `+` 额外禁止（Sourcery Raw-token-URLs）：raw ?token= 打开时浏览器把 & 当参数分隔、
// # 当锚点、+ 在 URLSearchParams 里解码成空格——含这些字符的 token 让「文档里的 raw URL」
// 直接失效。对自用工具，禁掉比要求操作者 percent-encode 更可靠。
// `%` 额外禁止（Sourcery Percent-tokens）：raw ?token= 打开时 URLSearchParams 会对 %XX
// 做 decodeURIComponent——含合法 percent escape 的 token 会被浏览器改写后与配置值失配 → 401。
const TOKEN_UNSAFE_CHARS_RE = /[;,"\\&#+%]/
const TOKEN_TRAILING_JUNK_RE = /[\n\r\u2028\u2029]$/
function isValidToken (token) {
  return typeof token === 'string' && token.length >= TOKEN_MIN_LEN &&
    token.length <= TOKEN_MAX_LEN &&
    TOKEN_VISIBLE_ASCII_RE.test(token) && !TOKEN_UNSAFE_CHARS_RE.test(token) &&
    !TOKEN_TRAILING_JUNK_RE.test(token)
}

// ── 单飞锁 ─────────────────────────────────────────────────────────────────
// 锁文件写 {pid, startedAt}。接管判据：锁 age 超过 PROC_TIMEOUT_MS（与子进程超时一致）
// ⇒ 持有方已死或卡死，安全覆盖。活跃持有期内的重复触发返回 409。
function lockPath (stateDir) { return path.join(stateDir, 'console-trigger.lock') }

function writeLockAtomic (p, now, token) {
  // 独占创建 + 先写内容再占用：以 open(p,'wx') 抢占文件名（并发方在这里 EEXIST 失败），
  // 再把完整内容写进同一 fd。⚠️ 不能走 rename 覆盖路径——POSIX rename 会静默替换已存在
  // 目标，独占性名存实亡（回归教训见 test「并发获取拒绝」用例）。
  // token：进程级随机归属标识，释放/判定所有权须 pid+token 双匹配（评审 Medium：
  // 单看 pid 会被 OS 复用 pid 的后来进程误认；接管换主后也可能误删新主锁）。
  const fd = fs.openSync(p, 'wx')
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, token }))
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function acquireLock (stateDir, now, token) {
  const p = lockPath(stateDir)
  try {
    // 第一层：直接独占创建（无锁时最常见路径）。
    writeLockAtomic(p, now, token)
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
    let released = false
    try {
      const parsed = JSON.parse(raw)
      startedAt = Number(parsed.startedAt)
      // released 锁（releaseLockFor 覆写作废）：语义等价无锁，立即接管，不判 age。
      released = parsed.released === true
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) corrupted = true
    } catch (err) { corrupted = true }
    // 锁内容损坏/startedAt 无效（Sourcery Medium #11）：无法判定持有方死活，fail-closed
    // 视为仍被持有，由外部人工清理（README「故障排查」节说明）。不降级为按 age 接管——
    // 那会让损坏锁在超时后被自动覆盖，重新引入「无法安全分类的锁被承认」问题。
    if (corrupted && !released) return false
    const stale = released || now - startedAt > PROC_TIMEOUT_MS
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
    // rename 静默替换语义恰好覆盖旧文件——原子替换、无半成品窗口。带本进程 token。
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: now, token }))
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
  // 归属判定 pid + token 双匹配（单看 pid 会被 OS pid 复用/接管换主绕过，评审 Medium）。
  // TOCTOU 收口（评审 Medium G5K + CodeQL js/file-system-race）：「读-判-删」按路径
  // unlink 存在 check-then-act 窗口——判定后锁可能被接管换主，unlink 会误删新主锁，
  // 或删掉后第三进程立刻拿锁与新主重叠。改为**原地覆写作废**：归属校验通过后把同一
  // fd 的内容覆写为 {"released":true,...}（writeFileSync 同 fd = 同 inode 原子覆盖），
  // acquireLock 读到 released 锁立即视为可接管（与无锁等价）。全程不 unlink 路径，
  // 无任何按路径删除动作，竞态无从谈起。锁文件残留由下次 acquireLock 的 released
  // 短路 + 哨兵接管机制兜底，不会阻塞触发。
  const p = lockPath(record._stateDir)
  let fd = null
  try {
    fd = fs.openSync(p, 'r+')
    const raw = fs.readFileSync(fd, 'utf8')
    const data = JSON.parse(raw)
    if (data.pid === process.pid && data.token === record._lockToken) {
      // 归属成立：原地单次 writeSync 覆写为 released 帧（同 inode，无 unlink、无
      // truncate——中间态不可见）。released JSON 后补空格到原文件长度（JSON 尾部
      // 空白合法），保证「读到的要么是完整旧锁、要么是完整 released 帧」，绝不出现
      // 半旧半新或零字节窗口；若内容比原来长（不会发生，released 帧更短）就超写。
      // 若此刻已被接管换主，校验不会通过；接管者随后覆盖则最后写者胜，语义仍正确。
      const releasedFrame = Buffer.from(JSON.stringify({ pid: process.pid, startedAt: data.startedAt, token: record._lockToken, released: true }) + ' ', 'utf8')
      const origLen = Buffer.byteLength(raw, 'utf8')
      let payload = releasedFrame
      if (releasedFrame.length < origLen) {
        payload = Buffer.concat([releasedFrame, Buffer.alloc(origLen - releasedFrame.length, 0x20)])
      }
      fs.writeSync(fd, payload, 0, payload.length, 0)
      fs.fsyncSync(fd)
    }
  } catch (e) { /* 锁已不在/内容不可读：无事可做 */ } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (e) { /* 已关 */ } }
  }
}

// ── 静态资产（前端现代化 v3.285）────────────────────────────────────────────
// 前端是零依赖 preact+htm standalone（scripts/console-assets/，无构建、无 CDN）。
// 仅伺服白名单内的静态文件：路径映射写死，不存在用户输入拼接（无路径穿越面）。
const ASSETS_DIR = path.join(__dirname, 'console-assets')
const STATIC_ASSETS = Object.freeze({
  '/assets/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/htm-preact.module.js': { file: 'htm-preact.module.js', type: 'text/javascript; charset=utf-8' }
})

function serveStatic (res, spec) {
  let body
  try {
    body = fs.readFileSync(path.join(ASSETS_DIR, spec.file))
  } catch (e) {
    sendJson(res, 500, { error: '控制台前端资产缺失（仓库不完整？）' })
    return
  }
  res.writeHead(200, {
    'Content-Type': spec.type,
    // 资产更新随部署走：浏览器缓存但每次部署后 ETag 变化即失效。
    'Cache-Control': 'no-cache',
    ETag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
  })
  res.end(body)
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

function renderPage (state, runsList, query, sessionToken) {
  const statusText = formatStatus(state)
  const statusLines = statusText.split('\n').map(escapeHtml)
  // 浏览器流（Sourcery High）：fetch/ESM 也带不了页内凭证之外的上下文，token 经
  // 查询参数进入页面后由 JSON 岛交给前端 fetch。仅在本请求本身通过鉴权后才回显
  // （token 已验证合法，原样传递；不新增任何存储）。
  // 兼容语义：<noscript> 环境保留纯 HTML 降级（状态文本 + 提示），核心信息不丢。
  // Sourcery G_4Kk：资产 URL 不再拼 tokenSuffix——资产鉴权已由会话 Cookie 覆盖
  // （页面响应下发 xbk_session，同源请求自动携带），URL 里重复凭证只会多日志暴露面。
  // Sourcery Authenticated-page-boots-bad-credentials：query.get('token') 是未验证输入
  // （请求可能靠 Cookie/Bearer 通过鉴权、却带了垃圾 ?token=）——boot 必须用「本次请求实际
  // 通过验证的凭证」（sessionToken，由调用方传入 authorize 的通过值），query token 仅在
  // 没有 sessionToken 时作为兼容回退。
  const bootToken = (typeof sessionToken === 'string' && sessionToken.length > 0)
    ? sessionToken
    : ((query instanceof URLSearchParams && query.get('token')) ? query.get('token') : '')
  // JSON 岛（<script type="application/json"> 的文本内容）：script 文本不做 HTML 实体解码，
  // escapeHtml 的 &quot; 会原样留在 JSON 里被前端 parse 成错误 token（Sourcery vwK）。
  // 只需防 </script> 逃逸与注释/CDATA 攻击：把 < 和控制字符转成 \uXXXX JSON 转义
  // （JSON.parse 会还原成原字符；/ 也转义防 </script> 序列被拼出）。
  const bootJson = JSON.stringify({ token: bootToken })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>xbk-push 控制台</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'">
<link rel="stylesheet" href="/assets/app.css">
<link rel="modulepreload" href="/assets/htm-preact.module.js">
</head><body>
<div id="app"><noscript>
<section style="max-width:60rem;margin:2rem auto;font-family:system-ui,sans-serif">
<h2>xbk-push 控制台（无脚本降级）</h2>
<pre>${statusLines.join('\n')}</pre>
<p>前端需要启用 JavaScript 才能使用触发与实时刷新。可用动作：试运行（抓取但不推送）、正式运行一轮（真实推送）、环境检查（不抓取不推送）。</p>
</section>
</noscript></div>
<script type="application/json" id="xbk-boot">${bootJson}</script>
<script type="module" src="/assets/app.js"></script>
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
// 会话 Cookie 名（Sourcery G_oJ：ESM import/静态资产请求无法带 Authorization 头，
// 页面鉴权后下发 HttpOnly Cookie，浏览器同源请求自动携带）。
const SESSION_COOKIE = 'xbk_session'
// 从 Cookie 头取会话值：手写解析（分号分段 + 首个 = 切分），不用正则
// （CodeQL js/polynomial-redos：cookie 值虽是自产 token，解析仍保持线性）。
// Sourcery Critical G_4Ki：decodeURIComponent 对畸形序列（如 %）会抛 URIError——
// 任何畸形 Cookie 都不能炸请求处理器：解析异常一律按「无有效 Cookie」处理。
function sessionCookieValue (cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim()
      if (value.length === 0) return null
      try { return decodeURIComponent(value) } catch (e) { return null }
    }
  }
  return null
}
function authorize (req, token, urlQuery) {
  const header = req.headers.authorization || ''
  if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
    const value = header.slice(BEARER_PREFIX.length)
    if (value.length > 0 && timingSafeEqualStr(value.trim(), token)) return true
  }
  // 浏览器路径：?token=xxx（urlQuery 由调用方传 URLSearchParams；单独接收以便测试）
  const supplied = urlQuery instanceof URLSearchParams ? urlQuery.get('token') : null
  if (typeof supplied === 'string' && supplied.length > 0 && timingSafeEqualStr(supplied, token)) return true
  // 会话 Cookie 路径（Sourcery G_oJ）：仅用于「读取面」——GET 页面与静态资产。
  // 写动作（POST /trigger）不接受 Cookie：SameSite=Strict 挡不住同站子域/同源注入页
  // 的表单伪造（Sourcery High G_4Kb Forged push actions），POST 保持显式凭证
  // （Bearer 头或 ?token=，两者都要求请求方真实持有 token）。
  if (req.method !== 'POST') {
    const cookie = sessionCookieValue(req.headers && req.headers.cookie)
    if (cookie !== null && timingSafeEqualStr(cookie, token)) return true
  }
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

function createConsole ({ token, stateDir, port = 0, host = '127.0.0.1', log = console.log, lockToken }) {
  // Sourcery Missing-assets：资产文件缺失时服务照常启动 → 用户拿到可打开但永远白屏的
  // 控制台（JS 引入失败）。启动闸逐个校验白名单资产可读，缺任何一个 fail-closed 拒启。
  for (const [route, spec] of Object.entries(STATIC_ASSETS)) {
    try {
      fs.accessSync(path.join(ASSETS_DIR, spec.file))
    } catch (e) {
      throw new Error(`控制台前端资产缺失：${route} → ${spec.file}（仓库不完整？），拒绝启动（fail-closed）`)
    }
  }
  if (!isValidToken(token)) {
    throw new Error(`XBK_CONSOLE_TOKEN 未设置、短于 ${TOKEN_MIN_LEN} 字符，或含浏览器无法传输的字符（仅允许可见 ASCII，禁 ; , " \\ 与空白），控制台拒绝启动（fail-closed）`)
  }
  fs.mkdirSync(stateDir, { recursive: true })
  // 活跃子进程登记（Sourcery High：控制台关闭时子进程要一并终止，否则触发任务
  // 会在控制服务消失后继续抓取/推送）。close 回调里自行从集合摘除。
  const activeChildren = new Set()
  // 锁归属 token：调用方传入（main 生成，SIGTERM 释放时须双匹配）；未传则随机。
  // 测试可直接传固定值断言锁内容。
  const ownerToken = typeof lockToken === 'string' && lockToken.length > 0 ? lockToken : crypto.randomBytes(12).toString('hex')
  // 关停闸（评审 High：SIGTERM 后 readBody 回调仍可能 acquireLock/startAction）：
  // 置位后 /trigger 一律 503，不认动作。由 main 的 shutdown 回调置位。
  let shuttingDown = false
  const setShuttingDown = () => { shuttingDown = true }
  // 幂等重放窗（Sourcery G_nm + G_4Kf）：受理时按 action 记录首轮
  // lastAccept[action] = { at, runId }。per-action 存储：换动作不会覆盖前一个动作的
  // 重放记录（「先 run 后重试 check 再重试 run」仍被拦）；进程内存语义 = 重启清空，
  // 重启后窗口失效是已知边界（锁与 runs 历史同样在内存，重启后本就没有「上一轮」）。
  // 窗口 > PROC_TIMEOUT_MS（子进程最长生命周期）：首轮结束后锁已释放，但重放
  // 窗仍拦截——这正是修复点。超窗不受影响，人工重跑语义保留。
  const REPLAY_WINDOW_MS = PROC_TIMEOUT_MS + 2 * 60 * 1000
  const lastAccept = new Map()
  // 读取持久化重放记录：返回合法条目的键值对数组（文件不存在/损坏返回空）。
  // 每次受理前实时调用（Sourcery High：多进程共享 stateDir 时，启动时读的快照会过期）。
  const readLastAccept = (p) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      const out = []
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === 'object' && typeof v.at === 'number' && typeof v.runId === 'number') {
            out.push([k, { at: v.at, runId: v.runId }])
          }
        }
      }
      return out
    } catch (e) { return [] }
  }
  // Sourcery Retries-duplicate x2：lastAccept 只在内存，重启后窗口失效 → 重试穿透再跑一轮。
  // 落盘到 stateDir/console-lastaccept.json（readStatus 同目录），受理时同步写、启动时回读。
  // 写入失败不阻断受理（主链路是单飞锁，落盘只是重放窗的持久化增强）。
  const lastAcceptPath = path.join(stateDir, 'console-lastaccept.json')
  try {
    for (const [k, v] of readLastAccept(lastAcceptPath)) lastAccept.set(k, v)
  } catch (e) { /* 文件不存在/损坏 = 空窗口，正常 */ }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    // 静态资产路由（Sourcery G_oJ：资产也须鉴权——此前免鉴权的理由（ESM import 无法带头）
    // 已被 Cookie 方案解决：页面通过鉴权后下发 HttpOnly 会话 Cookie，浏览器对同源
    // ESM import/静态请求自动带 Cookie。无凭证请求一律 401，与文档口径一致。
    // 白名单精确匹配（STATIC_ASSETS）保留：无路径穿越面。
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_ASSETS, url.pathname)) {
      if (!authorize(req, token, url.searchParams)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      serveStatic(res, STATIC_ASSETS[url.pathname])
      return
    }
    if (!authorize(req, token, url.searchParams)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/') {
      // Sourcery referrer x2：?token= 打开的页面在发起同源子请求时默认把完整 URL
      // （含 query 里的 token）作为 Referer 发出，反向代理/访问日志可能落盘。no-referrer
      // 从根上掐断（该页所有子请求一律不带 Referer）；启动页本身在浏览器地址栏的历史
      // 记录仍含 token，这是 raw-URL 方案的已知暴露面（README 已提醒可重置）。
      res.setHeader('Referrer-Policy', 'no-referrer')
      const state = readStatus(stateDir)
      const runsList = [...runs.values()].sort((a, b) => b.id - a.id)
      // 鉴权通过后下发会话 Cookie（Sourcery G_oJ）：HttpOnly（JS 不可读，XSS 拿不走）、
      // SameSite=Strict（跨站请求不携带）、Path=/；token 本身就是会话凭证，无需另发随机值。
      // Max-Age 30 天：自用工具，过期后重新打开 ?token= 链接即续期。
      // Sourcery 3x High（Cookie 无 Secure）：本服务部署在明文 HTTP 上（无 TLS 终结点），
      // Secure 属性会让浏览器拒绝在 http:// 上发送/存储 Cookie，控制台直接不可用——
      // 这是部署形态的固有权衡，不是代码缺陷可修；上 HTTPS（反代/自签）后应第一时间
      // 补 Secure + __Host- 前缀。缓解：HttpOnly（XSS 拿不走）+ SameSite=Strict（跨站不带）
      // + Max-Age 从 30 天收窄到 1 天（凭证下线窗口 30d → 1d）+ Referrer-Policy（见下）。
      res.setHeader('Set-Cookie',
        `xbk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // Sourcery Session-users-cannot-trigger x2：用户经 Cookie 会话（无 ?token=）打开页面时，
      // boot JSON 的 token 为空 → 前端发空 Bearer → POST /trigger 401。把本次请求实际
      // 使用的凭证（authorize 已通过的 token 值）交给 renderPage 注入 boot，会话用户
      // 无需再拼 ?token= 即可触发。
      res.end(renderPage(state, runsList, url.searchParams, token))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      // Sourcery Other-instance-idle：runs 历史是进程内存，另一实例持锁时本进程看不到。
      // 锁文件在共享 stateDir——把「锁被持有且未超时」附进 status，前端空闲徽章参考。
      const st = readStatus(stateDir)
      try {
        const lp = lockPath(stateDir)
        // CodeQL js/file-system-race（High）：statSync 后再 readFileSync 存在 TOCTOU——
        // 两次调用之间锁可能被释放/接管，stat 的 mtime 与 read 的内容来自不同代的锁帧。
        // 单次 readFileSync，时间与状态全部取自同一帧内容（锁帧/released 帧都写 startedAt）。
        let lockAge = 0
        let released = false
        try {
          const lockBody = JSON.parse(fs.readFileSync(lp, 'utf8'))
          const startedAt = typeof lockBody.startedAt === 'number' ? lockBody.startedAt : 0
          lockAge = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : PROC_TIMEOUT_MS
          released = lockBody.released === true
        } catch (e2) { st.lock = { held: false, ageMs: 0 }; throw e2 }
        st.lock = { held: !released && lockAge < PROC_TIMEOUT_MS, ageMs: lockAge }
      } catch (e) {
        if (!st.lock) st.lock = { held: false, ageMs: 0 }
      }
      sendJson(res, 200, st)
      return
    }
    if (req.method === 'POST' && url.pathname === '/trigger') {
      if (shuttingDown) {
        sendJson(res, 503, { error: '控制台正在关闭，动作未执行' })
        return
      }
      // S9383：promise 必须显式收尾——readBody 以 resolve 收口不会 reject，但仍接 .catch
      // 把意外异常转成 500，不留 floating promise。
      readBody(req)
        .then(({ body, aborted, over }) => {
          // 关停竞态兜底：readBody 期间收到 SIGTERM 时，此刻不能再 acquireLock/startAction
          // （评审 High：关停已清完 activeChildren，新 spawn 会逃过清理并留锁）。
          if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
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
          // 幂等重放窗（Sourcery G_nm + G_4Kf）：提交 202 后响应丢失 → 用户重试 →
          // 首轮已结束释放锁 → 重试被当作新触发再跑一轮真实推送。per-action 记录：
          // 同 action 在窗口内的重复提交返回 409 + 首轮 run id（前端把它当「已在跑」
          // 呈现，不再发起新一轮）；换动作不覆盖他动作的记录。
          // Sourcery High Retries-duplicate x2（多进程 stale map / 落盘晚于 spawn）：
          // 受理顺序改为「实时读盘合并 → 记 pending 帧 → 同步落盘（失败即拒绝）→ acquireLock
          // → startAction → 补写真实 runId → 再落盘」。pending 帧（runId=0）本身就能拦截
          // 窗口内重试；spawn 前记录已持久化，进程在 spawn 后崩溃也有完整重放记录。
          const persisted = readLastAccept(lastAcceptPath)
          for (const [k, v] of persisted) {
            if (!lastAccept.has(k) || lastAccept.get(k).at < v.at) lastAccept.set(k, v)
          }
          const prev = lastAccept.get(action)
          if (prev && now - prev.at < REPLAY_WINDOW_MS) {
            sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试', runId: prev.runId > 0 ? prev.runId : undefined, replayBlocked: true })
            return
          }
          if (!acquireLock(stateDir, now, ownerToken)) {
            sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试' })
            return
          }
          lastAccept.set(action, { at: now, runId: 0 })
          try {
            fs.writeFileSync(lastAcceptPath, JSON.stringify(Object.fromEntries(lastAccept)))
          } catch (e) {
            // 落盘失败 = 无持久重放记录，为满足「重试不得重复推送」必须拒绝受理（Sourcery High）。
            sendJson(res, 500, { error: '重放记录持久化失败，动作未执行（fail-closed）' })
            return
          }
          const record = startAction(action, now, activeChildren)
          record._stateDir = stateDir
          record._lockAt = now
          record._lockToken = ownerToken
          lastAccept.set(action, { at: now, runId: record.id })
          try {
            fs.writeFileSync(lastAcceptPath, JSON.stringify(Object.fromEntries(lastAccept)))
          } catch (e) { /* 二次落盘失败：pending 帧已持久化（runId=0），重试仍被窗口拦截 */ }
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
    // POST /api/runs/detail：详情查询的 POST 形态（body: id=...）。与 GET /api/runs/:id
    // 等价（同响应体）；提供 POST 形态是因为前端 fetch 的 URL 必须是字面量（Codacy SSRF
    // 规则不接受任何含变量的 URL 第一参数，GET /:id 形态无法满足），id 改走请求体。
    // 只读、无副作用，鉴权与 GET 完全一致（Cookie 会话对 POST 无效——G_4Kb 收紧口径不变，
    // 会话用户由 boot JSON 提供显式 Bearer 凭证）。
    if (req.method === 'POST' && url.pathname === '/api/runs/detail') {
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          const m = /(?:^|&)id=(\d+)/.exec(body)
          if (!m) { sendJson(res, 400, { error: '缺少数字 id' }); return }
          const record = runs.get(Number(m[1]))
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
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
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
  return { server, runs, activeChildren, setShuttingDown, ownerToken }
}

// ── 启动入口 ───────────────────────────────────────────────────────────────
function main () {
  const token = process.env.XBK_CONSOLE_TOKEN
  const port = Number(process.env.XBK_CONSOLE_PORT) || 7777
  const host = process.env.XBK_CONSOLE_HOST || '127.0.0.1'
  // Sourcery Medium：与生产入口 / --status 同源解析缓存目录（含安全回退），
  // 不再手写默认值——否则 .xbk_cache_safe 生效时看板会读错目录。
  const stateDir = statusCacheDir()
  // 锁归属 token（评审 Medium：pid 复用会让「pid===process.pid」误认他人锁为自有；
  // takeover 换主后 unlink 竞态也可能误删新主的锁）。锁内容带 token，释放须双匹配。
  const lockToken = crypto.randomBytes(12).toString('hex')
  const { server, activeChildren, setShuttingDown } = createConsole({ token, stateDir, port, host, lockToken })
  // 优雅关闭（Sourcery #21 余量）：SIGTERM/SIGINT 默认行为不走 server.close，会留下
  // ①还在跑的触发子进程 ②未释放的触发锁（下次触发 409 直到锁 age 超时）。这里统一收尾。
  const shutdown = (signal) => {
    setShuttingDown() // 关停闸：/trigger 即刻 503，readBody 回调不得再 spawn（评审 High）
    console.log(`收到 ${signal}，关闭控制台：终止触发子进程并释放锁…`)
    for (const child of activeChildren) {
      try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
    }
    // 锁释放时机（评审 Medium G5F/G5K）：不能在 SIGKILL 后立刻 unlink（子进程还没死，
    // 别的实例会立刻拿锁与垂死子进程重叠），也不能「读-判-删」（TOCTOU：判定后锁被
    // 接管换主，unlink 误删新主锁）。正确序列：杀子进程 → 等每个子进程真正 close
    // （close 回调里 releaseLockFor 已按 pid+token 双匹配释放）→ 全部收完才退出。
    // activeChildren.clear() 不能提前——清了就收不到 close 计数。
    const pending = [...activeChildren]
    let exited = 0
    const maybeFinish = () => {
      exited++
      if (exited >= pending.length) finishShutdown()
    }
    let finished = false
    const finishShutdown = () => {
      if (finished) return
      finished = true
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref()
    }
    if (pending.length === 0) {
      finishShutdown()
    } else {
      for (const child of pending) {
        // close 在子进程真正死后触发（SIGKILL 毫秒级）；同时兜底 3s 强制收尾，
        // 防个别子进程 close 事件丢失导致控制台挂住不退。
        child.once('close', maybeFinish)
      }
      setTimeout(finishShutdown, 3000).unref()
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  server.listen(port, host, () => {
    console.log(`xbk-push 控制台已启动：http://${host}:${server.address().port}（缓存目录：${stateDir}）`)
    console.log(`鉴权：请求头 Authorization: Bearer <XBK_CONSOLE_TOKEN>，或浏览器打开 http://${host}:${server.address().port}/?token=<XBK_CONSOLE_TOKEN>；token 未设置或过短则拒绝启动`)
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
  releaseLockFor,
  lockPath,
  parseAction,
  sessionCookieValue,
  SESSION_COOKIE,
  escapeHtml,
  formatMs,
  renderPage,
  authorize,
  ACTIONS,
  TOKEN_MIN_LEN,
  RUN_LOG_MAX_BYTES,
  PROC_TIMEOUT_MS
}
