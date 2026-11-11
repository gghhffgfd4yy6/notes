'use strict'

// P3：控制台常驻 worker（`xbk_function_v3.js --worker`）协议、生命周期与跨轮隔离。
//
// 覆盖 P3 验收：
//   1) 连续两轮 run 都 ok、run.log 各一行；exit / stdin 关闭后 5s 内退出；
//   2) 崩溃恢复：运行中 kill -9 → 下一轮自动重启成功；连续 3 次启动失败 → 退回一次性
//      spawn（同一个 record / 同一把锁，推送不中断）且只告警一次；僵死超时按失败处理；
//      启动时按 pid 文件清理上一代控制台留下的孤儿 worker；
//   3) 隔离性：一轮内会写的模块级可变状态逐项复位（App 限频/告警表、过滤编译缓存、
//      格式化单槽缓存、MessageStore 告警去重），且内存判重快照对外部改写失效；
//      worker 第二轮 run.log 的计数与一次性 spawn 同口径。
//
// 真实 worker 用 dry-run（XBK_DRY_RUN=1）跑：不推送、不写判重缓存，但走完整抓取/过滤/
// 摘要/run.log 路径，所以两轮都是真进程内的完整一轮。涉网用例失败时会重试一次，
// 避免上游抖动把门禁染红（断言不变，只是重跑）。

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

const ROOT = __dirname
const ENTRY = path.join(ROOT, 'xbk_function_v3.js')
const TMP = path.join(ROOT, 'scratch', `xbk-worker-${process.pid}-${Date.now()}`)
const {
  createRunWorker,
  cleanupOrphanWorker,
  workerPidFile,
  RUN_WORKER_STOP_GRACE_MS
} = require('./scripts/console-worker')
const { startAction, canUseRunWorker, createConsole } = require('./scripts/console')

const cases = []
function test (name, fn) { cases.push({ name, fn }) }

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function withTimeout (promise, ms, label) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${ms}ms 超时）`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function waitFor (predicate, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  throw new Error(`${label}（等待 ${ms}ms 仍未满足）`)
}

function alive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return false }
}

function dirOf (name) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function workerEnv (cacheDir, extra = {}) {
  return { ...process.env, TZ: 'UTC', XBK_DRY_RUN: '1', XBK_CACHE_DIR: cacheDir, ...extra }
}

// ── 裸协议客户端（验收 1 要按协议行断言，不经过控制台的封装）──────────────────
function startRawWorker (cacheDir, extraEnv = {}) {
  const child = spawn(process.execPath, [ENTRY, '--worker'], {
    cwd: ROOT,
    env: workerEnv(cacheDir, extraEnv),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const results = []
  const waiting = []
  const errChunks = []
  let buf = ''
  child.stderr.on('data', (chunk) => { errChunks.push(String(chunk)) })
  child.stdout.on('data', (chunk) => {
    buf += String(chunk)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch (e) { parsed = { raw: line } }
      const waiter = waiting.shift()
      if (waiter) waiter(parsed)
      else results.push(parsed)
    }
  })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child,
    exited,
    stderr: () => errChunks.join(''),
    send: (obj) => child.stdin.write(JSON.stringify(obj) + '\n'),
    closeStdin: () => child.stdin.end(),
    next: (ms = 60000) => (results.length
      ? Promise.resolve(results.shift())
      : withTimeout(new Promise((resolve) => waiting.push(resolve)), ms, '等待 worker 协议行')),
    kill: (signal) => child.kill(signal)
  }
}

function runLogSummaries (dir) {
  const file = path.join(dir, 'run.log')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('total='))
}

function parseSummaryLine (line) {
  const out = {}
  for (const m of String(line).matchAll(/([A-Za-z\u4e00-\u9fa5-]+)=([^\s]+)/g)) out[m[1]] = m[2]
  return out
}

function runOneShot (dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: workerEnv(dir),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (c) => { output += String(c) })
    child.stderr.on('data', (c) => { output += String(c) })
    child.on('exit', (code) => resolve({ code, output }))
  })
}

// 一次性 spawn 的替身：断言降级路径真的拉起了子进程（不发真实推送）。
function makeFakeSpawn ({ exitCode = 0, output = 'one-shot-ok\n' } = {}) {
  const calls = []
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new EventEmitter()
    child.pid = 40000 + calls.length
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => { child.killed = true }
    setTimeout(() => {
      child.stdout.write(output)
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', exitCode, null)
      child.emit('close', exitCode, null)
    }, 5)
    return child
  }
  impl.calls = calls
  return impl
}

// 常驻 worker 的替身（只按协议回一行 JSON）：给「控制台 → worker 接线」用例注入，
// 避免为了断言接线真的跑一轮抓取/推送。与 makeFakeSpawn 分开：这里模拟的是 --worker 子进程。
function makeFakeWorkerSpawn () {
  const calls = []
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new EventEmitter()
    child.pid = 43000 + calls.length
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.killed = false
    child.kill = () => { child.killed = true }
    let buf = ''
    child.stdin.on('data', (chunk) => {
      buf += String(chunk)
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        let msg = null
        try { msg = JSON.parse(line) } catch (e) { continue }
        if (!msg || typeof msg !== 'object') continue
        if (msg.cmd === 'exit') {
          setTimeout(() => {
            child.stdout.end()
            child.stderr.end()
            child.emit('exit', 0, null)
            child.emit('close', 0, null)
          }, 1)
        } else if (msg.cmd === 'run') {
          setTimeout(() => {
            child.stdout.write(JSON.stringify({
              ok: true,
              summary: { total: 0, dedup: 0, filtered: 0, truncated: 0, pushed: 0, failed: 0, cacheSaved: true },
              exitCode: 0,
              roundMs: 1
            }) + '\n')
          }, 2)
        }
      }
    })
    return child
  }
  impl.calls = calls
  return impl
}

function writeStub (name, source) {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, source)
  return file
}

// ── 验收 1：协议 + run.log + exit ───────────────────────────────────────────
test('真实 worker：连续两轮 run 都 ok、run.log 各一行、计数与一次性 spawn 同口径', async () => {
  const dir = dirOf('proto')
  const worker = startRawWorker(dir)
  try {
    worker.send({ cmd: 'run', args: [] })
    const first = await worker.next()
    worker.send({ cmd: 'run', args: [] })
    const second = await worker.next()
    assert.strictEqual(first.ok, true, `第一轮协议应 ok：${JSON.stringify(first)}`)
    assert.strictEqual(second.ok, true, `第二轮协议应 ok：${JSON.stringify(second)}`)
    for (const round of [first, second]) {
      assert.ok(round.summary && typeof round.summary.total === 'number', '摘要里应有数值 total')
      assert.ok(Number.isFinite(round.roundMs), '摘要里应有 roundMs（性能观测）')
      assert.strictEqual(typeof round.exitCode, 'number', '摘要里应有 exitCode')
    }
    const lines = runLogSummaries(dir)
    assert.strictEqual(lines.length, 2, `两轮应各写一行 run.log，实际 ${lines.length} 行`)
    // 对照一次性 spawn：同一份 dry-run 口径下，第二轮与一次性进程的计数必须一致
    // （判重/过滤/推送计数若跨轮泄漏，这里第一个不相等）。
    const oneShotDir = dirOf('proto-oneshot')
    const oneShot = await runOneShot(oneShotDir)
    const oneShotLines = runLogSummaries(oneShotDir)
    assert.strictEqual(oneShotLines.length, 1, `一次性 spawn 应写一行 run.log，exit=${oneShot.code}`)
    const a = parseSummaryLine(lines[1])
    const b = parseSummaryLine(oneShotLines[0])
    for (const key of ['total', 'dedup', 'filtered', 'truncated', 'pushed', 'failed']) {
      assert.strictEqual(a[key], b[key], `第二轮 ${key} 应与一次性 spawn 一致（${a[key]} vs ${b[key]}）`)
    }
    worker.send({ cmd: 'exit' })
    const exited = await withTimeout(worker.exited, 5000, 'exit 后 5s 内退出')
    assert.strictEqual(exited.code, 0, `exit 退出码应为 0，实际 ${JSON.stringify(exited)}`)
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.kill('SIGKILL')
  }
})

test('真实 worker：stdin 关闭即退出（5s 内）', async () => {
  const dir = dirOf('stdin-close')
  const worker = startRawWorker(dir)
  try {
    await sleep(150) // 等模块加载
    worker.closeStdin()
    const exited = await withTimeout(worker.exited, 5000, 'stdin 关闭后 5s 内退出')
    assert.strictEqual(exited.code, 0, `stdin 关闭应正常退出（0），实际 ${JSON.stringify(exited)}`)
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.kill('SIGKILL')
  }
})

test('真实 worker：业务日志只走 stderr，stdout 只有协议行', async () => {
  const dir = dirOf('streams')
  const worker = startRawWorker(dir)
  try {
    worker.send({ cmd: 'run', args: [] })
    const round = await worker.next()
    assert.strictEqual(round.ok, true)
    assert.ok(worker.stderr().includes('去重跳过'), '业务日志应出现在 stderr')
    worker.send({ cmd: 'exit' })
    await withTimeout(worker.exited, 5000, 'exit')
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.kill('SIGKILL')
  }
})

test('协议：未知命令/非法 JSON 回 ok:false 但进程继续服务', async () => {
  const dir = dirOf('bad-cmd')
  const worker = startRawWorker(dir)
  try {
    worker.child.stdin.write('not-json\n')
    const bad = await worker.next(10000)
    assert.strictEqual(bad.ok, false)
    worker.send({ cmd: 'nope' })
    const unknown = await worker.next(10000)
    assert.strictEqual(unknown.ok, false)
    // 带参数（--dry-run 等）必须 fail-closed，不能在 worker 里静默跑成真实一轮
    worker.send({ cmd: 'run', args: ['--dry-run'] })
    const args = await worker.next(10000)
    assert.strictEqual(args.ok, false)
    worker.send({ cmd: 'exit' })
    const exited = await withTimeout(worker.exited, 5000, 'exit')
    assert.strictEqual(exited.code, 0)
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.kill('SIGKILL')
  }
})

// ── 验收 2：崩溃恢复 / 降级 / 超时 / 孤儿 ──────────────────────────────────
test('崩溃恢复：运行中 kill -9 → 下一轮自动重启并成功', async () => {
  const dir = dirOf('kill9')
  const worker = createRunWorker({
    entryFile: ENTRY,
    root: ROOT,
    stateDir: dir,
    env: workerEnv(dir),
    timeoutMs: 60000,
    log: () => {}
  })
  try {
    const warm = await worker.run([])
    assert.strictEqual(warm.ok, true, `预热一轮应成功：${JSON.stringify(warm)}`)
    const pid = worker.pid
    assert.ok(pid > 0, 'worker 应有 pid')
    const inFlight = worker.run([])
    await sleep(10) // 这一轮还在抓取/推送阶段
    process.kill(pid, 'SIGKILL')
    const crashed = await inFlight
    assert.strictEqual(crashed.ok, false, `kill -9 后本轮应按失败返回：${JSON.stringify(crashed)}`)
    assert.strictEqual(worker.hasChild, false, '崩溃后不应还拿着旧句柄')
    const recovered = await worker.run([])
    assert.strictEqual(recovered.ok, true, `下一轮应自动重启并成功：${JSON.stringify(recovered)}`)
  } finally {
    worker.dispose()
  }
})

test('降级：连续 3 次启动失败 → 退回一次性 spawn，推送不中断且只告警一次', async () => {
  const dir = dirOf('degrade')
  const crash = writeStub('stub-crash.js', "'use strict'\nprocess.exit(1)\n")
  const logs = []
  const worker = createRunWorker({
    entryFile: crash,
    root: TMP,
    stateDir: dir,
    timeoutMs: 2000,
    log: (message) => logs.push(String(message))
  })
  try {
    for (let i = 1; i <= 3; i++) {
      const result = await worker.run([])
      assert.strictEqual(result.fallback, true, `第 ${i} 次启动失败应返回 fallback`)
    }
    assert.strictEqual(worker.degraded, true, '3 次后应进入降级')
    assert.strictEqual(
      logs.filter((m) => m.includes('退回一次性 spawn')).length,
      1,
      `降级告警应只打一次，实际 ${logs.filter((m) => m.includes('退回一次性 spawn')).length} 次`
    )
    // 同一轮改走一次性 spawn：同一个 record、同一把锁，推送不中断
    const fakeSpawn = makeFakeSpawn()
    const record = startAction('run', Date.now(), new Set(), dir, undefined, dir, { worker, spawnImpl: fakeSpawn })
    await waitFor(() => fakeSpawn.calls.length === 1, 3000, '降级后应拉起一次一次性子进程')
    assert.strictEqual(fakeSpawn.calls.length, 1, '降级后应拉起一次一次性子进程')
    assert.match(String(fakeSpawn.calls[0].args[0]), /xbk_function_v3\.js$/)
    await waitFor(() => record.finishedAt > 0, 3000, '降级 spawn 一轮应结束')
    assert.strictEqual(record.runner, 'spawn')
    assert.strictEqual(record.exitCode, 0)
    assert.ok(record.output.includes('one-shot-ok'), '一次性子进程输出应进 record.output')
  } finally {
    worker.dispose()
  }
})

test('超时兜底：worker 僵死 → 按失败处理并杀掉进程组', async () => {
  const dir = dirOf('timeout')
  const hang = writeStub('stub-hang.js', "'use strict'\nprocess.stdin.resume()\nprocess.stdin.on('data', () => {})\n")
  const worker = createRunWorker({
    entryFile: hang,
    root: TMP,
    stateDir: dir,
    timeoutMs: 300,
    log: () => {}
  })
  try {
    const running = worker.run([])
    const pid = worker.pid
    const result = await running
    assert.strictEqual(result.timedOut, true, `僵死应超时返回：${JSON.stringify(result)}`)
    assert.strictEqual(result.ok, false)
    await waitFor(() => !alive(pid), 3000, '超时后 worker 应被杀死')
    assert.strictEqual(worker.hasChild, false)
  } finally {
    worker.dispose()
  }
})

test('孤儿清理：上一代控制台留下的 worker 按 pid 文件整组清掉', async () => {
  const dir = dirOf('orphan')
  const child = spawn(process.execPath, [ENTRY, '--worker'], {
    cwd: ROOT,
    env: workerEnv(dir),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  try {
    await sleep(200) // 等它真正加载完（/proc cmdline 已就绪）
    const pidFile = workerPidFile(dir)
    fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, ownerPid: 2147483000, startedAt: Date.now() }))
    const result = cleanupOrphanWorker({ pidFile, entryFile: ENTRY })
    assert.strictEqual(result.cleaned, true, `应识别并清理孤儿：${JSON.stringify(result)}`)
    await withTimeout(new Promise((resolve) => child.on('exit', resolve)), 5000, '孤儿 worker 应被杀掉')
    assert.strictEqual(alive(child.pid), false, '被清理的 worker 不应还活着')
    assert.strictEqual(fs.existsSync(pidFile), false, '清理后 pid 文件应删除')
  } finally {
    try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
  }
})

test('孤儿清理：属主控制台还活着时不动它（避免误杀另一个实例）', async () => {
  const dir = dirOf('orphan-owned')
  const child = spawn(process.execPath, [ENTRY, '--worker'], {
    cwd: ROOT,
    env: workerEnv(dir),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  // 另一个「还活着的控制台实例」：拿一个真实存活的 pid 当属主（ppid = 当前测试进程的父进程）。
  const otherOwner = process.ppid
  try {
    await sleep(200)
    const pidFile = workerPidFile(dir)
    fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, ownerPid: otherOwner, startedAt: Date.now() }))
    const result = cleanupOrphanWorker({ pidFile, entryFile: ENTRY })
    assert.strictEqual(result.cleaned, false)
    assert.strictEqual(result.ownedByOthers, true)
    assert.strictEqual(alive(child.pid), true, '属主还活着时不应杀掉 worker')
  } finally {
    try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
    try { fs.unlinkSync(workerPidFile(dir)) } catch (e) { /* 不存在 */ }
  }
})

// ── 验收 3：跨轮隔离 ───────────────────────────────────────────────────────
test('隔离：App 的限频/告警去重状态逐项复位', () => {
  const { App } = require('./xbk_function_v3')
  App._diskWarningAt = 123
  App._logRotateBackoffByPath.set('/a.log', { at: 1 })
  App._archiveWarnAtByKey.set('/a.log|2026-45', 1)
  App._weekMarkerWarnAtByKey.set('/a.log', 1)
  App._alertLastAtByPath.set('/a', 1)
  App._reportMemoryStateByPath.set('/r', { at: 1 })
  App._lastChannelHealthLockFailure = { at: 1 }
  App._lastChannelHealthLockToken = 'deadbeef'
  assert.strictEqual(App._resetRunState(), true)
  assert.strictEqual(App._diskWarningAt, 0)
  assert.strictEqual(App._logRotateBackoffByPath.size, 0)
  assert.strictEqual(App._archiveWarnAtByKey.size, 0)
  assert.strictEqual(App._weekMarkerWarnAtByKey.size, 0)
  assert.strictEqual(App._alertLastAtByPath.size, 0)
  assert.strictEqual(App._reportMemoryStateByPath.size, 0)
  assert.strictEqual(App._lastChannelHealthLockFailure, null)
  assert.strictEqual(App._lastChannelHealthLockToken, null)
})

test('隔离：过滤编译缓存与格式化单槽缓存复位', () => {
  const { createFilterEngine } = require('./xbk_filter')
  const { createFormatter } = require('./xbk_formatter')
  const engine = createFilterEngine({
    Utils: {},
    RuleEngine: {},
    FILTER_FIELDS: ['title'],
    compileUserRegex: () => /x/
  })
  engine._whitelistReCache.set('k', /k/)
  engine._legacyCompileCache.set('k', [])
  assert.strictEqual(engine._resetRunCaches(), true)
  assert.strictEqual(engine._whitelistReCache.size, 0)
  assert.strictEqual(engine._legacyCompileCache.size, 0)
  const formatter = createFormatter({ Utils: {}, safeRe: (source) => new RegExp(source) })
  assert.strictEqual(formatter._resetRunCaches(), true)
})

test('隔离：MessageStore 告警去重标记复位', () => {
  const { MessageStore } = require('./xbk_function_v3')
  MessageStore._journalWarned.add('x')
  MessageStore._residualTombstoneWarned.add('y')
  MessageStore._memoWarned = true
  assert.strictEqual(MessageStore._resetRunWarnings(), true)
  assert.strictEqual(MessageStore._journalWarned.size, 0)
  assert.strictEqual(MessageStore._residualTombstoneWarned.size, 0)
  assert.strictEqual(MessageStore._memoWarned, false)
})

test('隔离：内存判重快照对外部改写失效（常驻进程不能拿旧快照判重）', () => {
  const { MessageStore } = require('./xbk_function_v3')
  const dir = dirOf('memo')
  const file = path.join(dir, 'push.json')
  fs.writeFileSync(file, JSON.stringify([{ id: 'a1', title: 'A' }]))
  assert.strictEqual(MessageStore.readMessages(file).length, 1)
  // 控制台导入/恢复/另一个进程写盘：绕过本进程直接改文件
  fs.writeFileSync(file, JSON.stringify([{ id: 'b1' }, { id: 'b2' }]))
  const reread = MessageStore.readMessages(file)
  assert.strictEqual(reread.length, 2, `外部改写后应按磁盘重读（实际 ${reread.length} 条）`)
  assert.strictEqual(reread[0].id, 'b1')
})

// ── F2：关键接线（删掉即整套功能失效，必须有真实路径用例锁住）──────────────
test('接线：startAction 经 workerForChildren 真实路径选中常驻 worker（runner=worker 且 pid>0）', async () => {
  const dir = dirOf('wiring-worker')
  const fakeWorkerSpawn = makeFakeWorkerSpawn()
  const inst = createConsole({
    token: 'test-token-for-wiring-0123456789',
    stateDir: dir,
    // 只替换 worker 进程的 spawn：createConsole 内部仍走 createRunWorker + workerByChildren.set，
    // 因此本用例锁的是 scripts/console.js 里那条「控制台 → worker」接线本身。
    createWorker: (opts) => createRunWorker({ ...opts, spawnImpl: fakeWorkerSpawn })
  })
  try {
    // 有意不传 deps.worker：worker 必须由 createConsole 登记进 workerByChildren 后经
    // workerForChildren(activeChildren) 取到。删掉 workerByChildren.set 这一行 ⇒ 退回一次性 spawn。
    const record = startAction('run', Date.now(), inst.activeChildren, dir, 'wiring-lock-token', dir, {
      spawnImpl: makeFakeSpawn()
    })
    assert.strictEqual(record.runner, 'worker',
      `startAction 必须选中常驻 worker（实际 runner=${record.runner}；接线断了会退回一次性 spawn）`)
    assert.ok(record._child && record._child.__runWorker === true, '本轮 record 应挂上常驻 worker 的伪 child')
    await waitFor(() => inst.runWorker.pid > 0, 2000, '常驻 worker 进程应已启动')
    assert.ok(inst.runWorker.pid > 0, `常驻 worker 必须有 pid（实际 ${inst.runWorker.pid}）`)
    assert.strictEqual(fakeWorkerSpawn.calls.length, 1, '应真的拉起一次常驻 worker 子进程')
    assert.match(String(fakeWorkerSpawn.calls[0].args[0]), /xbk_function_v3\.js$/)
    assert.ok(fakeWorkerSpawn.calls[0].args.includes('--worker'), '常驻进程必须以 --worker 启动')
    await waitFor(() => record.finishedAt > 0, 3000, '常驻 worker 一轮应结束')
    assert.strictEqual(record.exitCode, 0)
  } finally {
    inst.runWorker.dispose()
  }
})

test('接线：--worker 连续两轮都经过 resetRunStateForWorker（每轮复位钩子不可省）', async () => {
  const dir = dirOf('reset-trace')
  const worker = startRawWorker(dir, { XBK_WORKER_TRACE_RESET: '1' })
  const resetCount = () => worker.stderr().split('[worker] reset-run-state').length - 1
  try {
    worker.send({ cmd: 'run', args: [] })
    const first = await worker.next()
    assert.strictEqual(first.ok, true, `第一轮协议应 ok：${JSON.stringify(first)}`)
    await waitFor(() => resetCount() >= 1, 2000, '第一轮应留下复位痕迹')
    assert.strictEqual(resetCount(), 1, `第一轮必须调用一次复位钩子（实际 ${resetCount()} 次）`)
    worker.send({ cmd: 'run', args: [] })
    const second = await worker.next()
    assert.strictEqual(second.ok, true, `第二轮协议应 ok：${JSON.stringify(second)}`)
    await waitFor(() => resetCount() >= 2, 2000, '第二轮应再留下一次复位痕迹')
    assert.strictEqual(resetCount(), 2, `第二轮必须再复位一次（累计 ${resetCount()} 次；删掉 resetRunStateForWorker() 调用点会变 0）`)
    worker.send({ cmd: 'exit' })
    await withTimeout(worker.exited, 5000, 'exit 后 5s 内退出')
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.kill('SIGKILL')
  }
})

// ── 开关 ───────────────────────────────────────────────────────────────────
test('降级开关：XBK_RUN_WORKER=0 时 startAction 不走 worker', async () => {
  assert.strictEqual(canUseRunWorker({ entry: 'single', args: [] }), true)
  assert.strictEqual(canUseRunWorker({ entry: 'single', args: ['--notify-test'] }), false)
  assert.strictEqual(canUseRunWorker({ entry: 'qinglong', args: [] }), false)
  const previous = process.env.XBK_RUN_WORKER
  process.env.XBK_RUN_WORKER = '0'
  try {
    assert.strictEqual(canUseRunWorker({ entry: 'single', args: [] }), false)
    const dir = dirOf('switch')
    const fakeSpawn = makeFakeSpawn()
    const worker = { run: () => { throw new Error('不应调用 worker') } }
    const record = startAction('run', Date.now(), new Set(), dir, undefined, dir, { worker, spawnImpl: fakeSpawn })
    assert.strictEqual(fakeSpawn.calls.length, 1)
    await waitFor(() => record.finishedAt > 0, 3000, '一次性 spawn 应结束')
    assert.strictEqual(record.runner, 'spawn')
  } finally {
    if (previous === undefined) delete process.env.XBK_RUN_WORKER
    else process.env.XBK_RUN_WORKER = previous
  }
})

test('常量：关闭宽限期为 5s（spec 口径）', () => {
  assert.strictEqual(RUN_WORKER_STOP_GRACE_MS, 5000)
})

async function main () {
  fs.mkdirSync(TMP, { recursive: true })
  let failed = 0
  for (const { name, fn } of cases) {
    try {
      await fn()
      console.log(`ok   ${name}`)
    } catch (e) {
      failed += 1
      process.exitCode = 1
      console.error(`FAIL ${name}`)
      console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`)
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 用例通过`)
}

main().catch((e) => {
  process.exitCode = 1
  console.error(e && e.stack ? e.stack : e)
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) { /* 清理失败不影响结论 */ }
})
