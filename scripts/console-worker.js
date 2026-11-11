'use strict'
// 常驻运行进程（P3）：控制台侧的生命周期管理。
//
// 背景：控制台每轮都 `spawn(node, [xbk_function_v3.js, ...])`，单轮冷启动约 0.5s（起进程 +
// require got/re2 + 读 13MB 判重缓存 + 编译规则）。本模块负责常驻一个 `xbk_function_v3.js --worker`
// 子进程，每轮只写一条命令并等一行 JSON 结果：
//   · 首次需要时拉起（控制台启动不预热，避免「没开自动运行也占一个 node」）；
//   · 崩溃/被 kill → 记原因，下一轮自动重启；
//   · 连续 N 次启动失败 → 置降级标记，调用方退回一次性 spawn（推送不中断），只告警一次；
//   · 关闭时先发 {"cmd":"exit"}，宽限期（5s）内不退再 SIGKILL 整个进程组；
//   · 启动时按 pid 文件清理上一代控制台留下的孤儿 worker（只清「属主进程已死」的，避免误杀
//     同 stateDir 的另一个还活着的控制台实例）。
//
// 设计约束：
//   · worker 的 stdout 只走协议（一行一条 JSON），业务日志走 stderr；本模块把 stderr 原样交给
//     调用方转发/落 run.log（格式与一次性 spawn 完全一致）。
//   · 同一 worker 同时只允许一轮（调用方还有 console-auto 单飞锁；这里再 fail-closed 一次）。
//   · 进程组（detached）是清理孤儿与超时兜底的唯一可靠口径：控制台自己被 SIGKILL 时，worker
//     不会收到信号，只能靠下一代控制台按 pid 文件清理。

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

const RUN_WORKER_ARG = '--worker'
// 单轮超时：worker 僵死但没退出时唯一能救场的兜底。一次性 spawn 的既有上限是 10 分钟，
// 常驻进程一旦卡住会拖死后续每一轮，故这里取更短的 120s（正常一轮 < 1s）。
const RUN_WORKER_TIMEOUT_MS = 120 * 1000
// 关闭宽限：先发 exit，超过这个时间还没退再 SIGKILL（spec 要求 5s）。
const RUN_WORKER_STOP_GRACE_MS = 5000
// 连续启动失败上限：达到后退回一次性 spawn（只告警一次）。
const RUN_WORKER_START_FAIL_LIMIT = 3
const RUN_WORKER_PID_FILE = 'console-worker.pid'

function workerPidFile (stateDir) {
  return path.join(stateDir, RUN_WORKER_PID_FILE)
}

// 进程组优先：worker 以 detached 启动，-pid 即它自己的进程组；进程组已不存在时退回单 pid。
function killGroup (pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(-pid, signal); return true } catch (e) {
    if (e && e.code === 'EPERM') return false
  }
  try { process.kill(pid, signal); return true } catch (e) { return false }
}

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return false }
}

// 只认「这个 pid 真的是我们的 --worker」：pid 会被 OS 复用，单看存活就杀会误杀无关进程。
// /proc 不可用时返回 false（宁可不清理，也不误杀）。
function looksLikeOurWorker (pid, entryFile) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') // nosemgrep（只读 /proc，无用户输入拼接）
    if (!raw) return false
    const parts = raw.split('\u0000')
    const base = path.basename(entryFile)
    return parts.includes(RUN_WORKER_ARG) && parts.some(part => path.basename(part) === base)
  } catch (e) {
    return false
  }
}

function readPidFile (file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return null
    const pid = Number(data.pid)
    if (!Number.isInteger(pid) || pid <= 0) return null
    return {
      pid,
      ownerPid: Number.isInteger(Number(data.ownerPid)) ? Number(data.ownerPid) : 0,
      startedAt: Number(data.startedAt) || 0
    }
  } catch (e) {
    return null
  }
}

function writePidFile (file, frame) {
  try { fs.writeFileSync(file, JSON.stringify(frame), { mode: 0o600 }) } catch (e) { /* 清理是尽力而为 */ }
}

function removePidFile (file, pid) {
  const current = readPidFile(file)
  if (current && current.pid !== pid) return // 已被新 worker 覆盖：绝不删别人的
  try { fs.unlinkSync(file) } catch (e) { /* 已不存在 */ }
}

// 启动时清理上一代控制台留下的孤儿：属主进程还活着就跳过（同一个 stateDir 可能被另一个
// 控制台实例占用，那种情况下它不是孤儿）。
function cleanupOrphanWorker ({ pidFile, entryFile, log = () => {} } = {}) {
  const frame = readPidFile(pidFile)
  if (!frame) return { cleaned: false }
  if (frame.ownerPid && frame.ownerPid !== process.pid && pidAlive(frame.ownerPid)) {
    log(`[console] 发现另一个控制台实例（pid ${frame.ownerPid}）的常驻 worker，跳过清理`)
    return { cleaned: false, ownedByOthers: true }
  }
  if (!pidAlive(frame.pid)) {
    try { fs.unlinkSync(pidFile) } catch (e) { /* 已不存在 */ }
    return { cleaned: false, stale: true }
  }
  if (!looksLikeOurWorker(frame.pid, entryFile)) {
    try { fs.unlinkSync(pidFile) } catch (e) { /* 已不存在 */ }
    return { cleaned: false, mismatched: true }
  }
  killGroup(frame.pid, 'SIGKILL')
  try { fs.unlinkSync(pidFile) } catch (e) { /* 已不存在 */ }
  log(`[console] 已清理上一代控制台遗留的常驻 worker（pid ${frame.pid}）`)
  return { cleaned: true, pid: frame.pid }
}

function createRunWorker ({
  entryFile,
  root,
  stateDir,
  env = {},
  timeoutMs = RUN_WORKER_TIMEOUT_MS,
  stopGraceMs = RUN_WORKER_STOP_GRACE_MS,
  startFailLimit = RUN_WORKER_START_FAIL_LIMIT,
  spawnImpl = spawn,
  log = () => {}
} = {}) {
  if (typeof entryFile !== 'string' || entryFile === '') throw new TypeError('createRunWorker 需要 entryFile')
  const pidFile = stateDir ? workerPidFile(stateDir) : ''
  let child = null
  let pending = null // { resolve, timer, onOutput }
  let startFails = 0
  let degraded = false
  let degradeReason = ''
  let stopping = null
  let closed = false

  function emitLog (message) {
    try { log(message) } catch (e) { /* 日志失败不影响调度 */ }
  }

  function failStart (reason) {
    startFails += 1
    if (startFails >= startFailLimit && !degraded) {
      degraded = true
      degradeReason = `常驻 worker 连续 ${startFails} 次启动失败（${reason}），已退回一次性 spawn`
      emitLog(`⚠️ ${degradeReason}`)
    }
    return { fallback: true, error: reason, startFails }
  }

  function settle (result) {
    if (!pending) return
    const p = pending
    pending = null
    if (p.timer) { clearTimeout(p.timer); p.timer = null }
    p.resolve(result)
  }

  function onProtocolLine (line, inc) {
    const text = line.trim()
    if (!text) return
    let parsed = null
    try { parsed = JSON.parse(text) } catch (e) { parsed = null }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
      // 协议行以外的东西一律当业务输出（防御：stdout 被第三方库污染时不能静默丢日志）
      if (pending && pending.onOutput) pending.onOutput(text + '\n')
      return
    }
    inc.answered += 1
    if (parsed.ok) {
      inc.completed += 1
      startFails = 0 // 成功跑完一轮即清零「连续启动失败」
      settle({
        ok: true,
        summary: parsed.summary || {},
        exitCode: Number.isInteger(parsed.exitCode) ? parsed.exitCode : 0,
        roundMs: Number.isFinite(parsed.roundMs) ? parsed.roundMs : null
      })
    } else {
      settle({ ok: false, error: String(parsed.error || '本轮运行失败') })
    }
  }

  function wireChild (c) {
    const inc = {
      answered: 0,
      completed: 0,
      outDecoder: new StringDecoder('utf8'), // 两个流各用一个解码器：共享会把半个多字节序列串到另一流
      errDecoder: new StringDecoder('utf8'),
      outBuf: ''
    }
    child = c
    if (pidFile && c.pid) writePidFile(pidFile, { pid: c.pid, ownerPid: process.pid, startedAt: Date.now() })

    c.stdout.on('data', (chunk) => {
      inc.outBuf += inc.outDecoder.write(chunk)
      let idx
      while ((idx = inc.outBuf.indexOf('\n')) >= 0) {
        const line = inc.outBuf.slice(0, idx)
        inc.outBuf = inc.outBuf.slice(idx + 1)
        onProtocolLine(line, inc)
      }
    })
    c.stderr.on('data', (chunk) => {
      const text = inc.errDecoder.write(chunk)
      if (pending && pending.onOutput) pending.onOutput(text)
      else if (text) emitLog(text.replace(/\n$/, ''))
    })
    // stdin 的 EPIPE（worker 已死）不能变成未捕获异常：本轮结果交给 exit 结算。
    c.stdin.on('error', () => {})
    c.on('error', (err) => {
      const reason = `常驻 worker 启动失败：${err && err.message ? err.message : String(err)}`
      if (pending) {
        if (inc.completed === 0) settle(failStart(reason))
        else settle({ ok: false, error: reason })
      } else if (inc.completed === 0) {
        failStart(reason)
      }
      if (child === c) child = null
      if (pidFile) removePidFile(pidFile, c.pid)
    })
    c.on('exit', (code, signal) => {
      const reason = `常驻 worker 退出（code=${code === null ? 'null' : code}, signal=${signal || 'none'}）`
      if (pending) {
        if (inc.completed === 0) {
          // 刚拉起来就死（模块加载失败/入口崩）：按「启动失败」计数，第 3 次触发降级。
          settle(failStart(reason))
        } else {
          settle({ ok: false, error: reason, died: true, code, signal })
          emitLog(`⚠️ ${reason}，本轮按失败处理，下一轮自动重启`)
        }
      } else if (!stopping) {
        // 空闲期被外部杀掉：不算启动失败（否则 3 次 kill 就永久降级），只提示下一轮会重启。
        emitLog(`⚠️ ${reason}，下一轮自动重启`)
      }
      if (child === c) child = null
      if (pidFile) removePidFile(pidFile, c.pid)
    })
  }

  function ensureChild () {
    if (child) return child
    if (closed) throw new Error('常驻 worker 已关闭')
    stopping = null
    const c = spawnImpl(process.execPath, [entryFile, RUN_WORKER_ARG], {
      cwd: root || path.dirname(entryFile),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true // 独立进程组：超时/关闭/孤儿清理都能整组收掉
    })
    wireChild(c)
    return c
  }

  // 跑一轮。返回：
  //   { ok:true, summary, exitCode }        本轮执行完毕（exitCode 与一次性 spawn 的退出码同义）
  //   { ok:false, error, timedOut }         超时被强杀 / 运行失败
  //   { ok:false, error, died:true }        worker 中途崩溃
  //   { fallback:true }                     启动失败/已降级：调用方必须退回一次性 spawn
  function run (args = [], { onOutput } = {}) {
    if (closed) return Promise.resolve({ fallback: true, error: '常驻 worker 已关闭' })
    if (degraded) return Promise.resolve({ fallback: true, error: degradeReason })
    if (pending) return Promise.resolve({ ok: false, error: '常驻 worker 正在执行上一轮（不允许并发）' })
    let c
    try { c = ensureChild() } catch (e) {
      return Promise.resolve(failStart(`常驻 worker 启动失败：${e && e.message ? e.message : String(e)}`))
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const reason = `常驻 worker 单轮超时（${timeoutMs}ms），已杀掉并按失败处理`
        killGroup(c.pid, 'SIGKILL')
        settle({ ok: false, error: reason, timedOut: true })
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      pending = { resolve, timer, onOutput }
      try {
        c.stdin.write(JSON.stringify({ cmd: 'run', args }) + '\n')
      } catch (e) {
        settle({ ok: false, error: `写命令到常驻 worker 失败：${e && e.message ? e.message : String(e)}` })
      }
    })
  }

  function shutdown () {
    if (stopping) return stopping
    const c = child
    if (!c) return Promise.resolve()
    stopping = new Promise((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; resolve() }
      c.once('exit', finish)
      try { c.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n') } catch (e) { /* 已退出 */ }
      const timer = setTimeout(() => {
        killGroup(c.pid, 'SIGKILL')
        finish()
      }, stopGraceMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return stopping
  }

  // 立即收掉（server.close 等「控制台已经停了」的路径）：不等宽限，避免测试/退出被挂住。
  function dispose () {
    closed = true
    const c = child
    child = null
    if (c) {
      killGroup(c.pid, 'SIGKILL')
      if (pidFile) removePidFile(pidFile, c.pid)
    }
    if (pending) settle({ ok: false, error: '控制台关闭，本轮被终止' })
  }

  return {
    run,
    shutdown,
    dispose,
    cleanupOrphans: () => cleanupOrphanWorker({ pidFile, entryFile, log: emitLog }),
    cancelRound: (signal = 'SIGTERM') => { if (child) killGroup(child.pid, signal) },
    get pid () { return child ? child.pid : 0 },
    get hasChild () { return Boolean(child) },
    get degraded () { return degraded },
    get startFails () { return startFails },
    get closed () { return closed }
  }
}

module.exports = {
  createRunWorker,
  cleanupOrphanWorker,
  killGroup,
  looksLikeOurWorker,
  workerPidFile,
  RUN_WORKER_ARG,
  RUN_WORKER_TIMEOUT_MS,
  RUN_WORKER_STOP_GRACE_MS,
  RUN_WORKER_START_FAIL_LIMIT,
  RUN_WORKER_PID_FILE
}
