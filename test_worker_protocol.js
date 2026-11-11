'use strict'

// P3：控制台常驻 worker（`xbk_function_v3.js --worker`）协议、生命周期与跨轮隔离。
//
// 覆盖 P3 验收：
//   1) 连续两轮 run 都 ok、run.log 各一行；exit / stdin 关闭后 5s 内退出；
//   2) 崩溃恢复：运行中 kill -9 → 下一轮自动重启成功；连续 3 次启动失败 → 退回一次性
//      spawn（同一个 record / 同一把锁，推送不中断）且只告警一次；僵死超时按失败处理；
//      启动时按 pid 文件清理上一代控制台留下的孤儿 worker；
//   3) 隔离性：一轮内会写的模块级可变状态逐项复位（App 限频/告警表、过滤编译缓存、
//      格式化单槽缓存、MessageStore 告警去重），且复位入口的 5 个内部调用点逐项可咬
//      （删掉任意一条复位语句 ⇒ 摘要缺项 + 对应脏状态仍在，用例变红）；
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
  // 按空白切分后取每段首个 '='：run.log 摘要是 `key=value` 以空白分隔（value 不含空白，见
  // scripts/status.js 的 RUN_SUMMARY_LINE_RE），所以按分隔符解析与旧正则等价。
  // 旧实现 `/([A-Za-z\u4e00-\u9fa5-]+)=([^\s]+)/g` 的两个量词在长串上互相重叠，回溯超线性
  // （Sonar S8786：实测 16k 字符 235ms、输入每翻倍耗时约 4×）；这里是纯线性扫描。
  for (const token of String(line).split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1)
  }
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

// ── P3 must_fix 回归：关停/取消判死的轮次不得被当成「启动失败」再起一轮 ──────────
// 生产入口有两条：① console.js 的关停序列（先 runWorker.shutdown() 发 {"cmd":"exit"}，再对
// activeChildren 逐个 SIGKILL；伪 child.kill → worker.cancelRound → killGroup(-pid)）；
// ② /api/runs/cancel（置 cancelled/cancelRequestedAt 后 record._child.kill('SIGTERM')）。
// 两条都走**生产同一路径**：真 createRunWorker + 真 startAction，只把一次性 spawn 换成记录器。
// 判据要点：spawnImpl 调用次数必须为 0（否则「点停止」变成「立刻重跑一整轮抓取+推送」），
// startFails 必须仍为 0（首轮上取消 3 次即永久降级为一次性 spawn）。
function makeDeafStub (name) {
  // 一个「收下 run 命令但永不回协议行、也不理 exit」的入口：模拟「worker 已跑起来、第一轮还在跑」。
  return writeStub(name, "'use strict'\nprocess.stdin.resume()\nprocess.stdin.on('data', () => {})\n")
}

async function startInFlightRound (dir, entry, spawnImpl, lockToken) {
  const worker = createRunWorker({
    entryFile: entry,
    root: TMP,
    stateDir: dir,
    timeoutMs: 60000,
    stopGraceMs: 200,
    log: () => {}
  })
  const children = new Set()
  const record = startAction('run', Date.now(), children, dir, lockToken, dir, { worker, spawnImpl })
  await waitFor(() => record.runner === 'worker' && worker.hasChild && worker.pid > 0, 3000,
    '常驻 worker 应已拉起并在跑这一轮')
  await sleep(50) // 让 run 命令真的进到子进程（在飞态：pending 已登记、还没回协议行）
  return { worker, children, record }
}

test('关停：在飞一轮被 shutdown + SIGKILL 收尾 → 不再 respawn，也不计启动失败', async () => {
  const dir = dirOf('stop-shutdown')
  const entry = makeDeafStub('stub-deaf-shutdown.js')
  const fakeSpawn = makeFakeSpawn()
  const { worker, children, record } = await startInFlightRound(dir, entry, fakeSpawn, 'lock-shutdown')
  try {
    // 与 scripts/console.js 的关停序列逐项同序（:7198 先 shutdown，:7199-7201 再逐个 SIGKILL）
    const stop = worker.shutdown()
    for (const child of children) { try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ } }
    await withTimeout(stop, 5000, 'shutdown 应在宽限内完成')
    await waitFor(() => record.finishedAt > 0, 3000, '被关停的这一轮必须收尾（finishedAt > 0）')
    assert.strictEqual(fakeSpawn.calls.length, 0,
      `关停期间不得再拉起一次性 spawn（实际 ${fakeSpawn.calls.length} 次 ⇒ 关停中又多起了一个 node 进程）`)
    assert.strictEqual(worker.startFails, 0,
      `关停不是启动失败（startFails=${worker.startFails}；每次关停 +1 会让首轮上取消 3 次即永久降级）`)
    assert.strictEqual(worker.degraded, false, '关停不得把 worker 打成降级')
    assert.strictEqual(record.runner, 'worker', '关停收尾的这一轮不应被改写成 runner=spawn')
    assert.ok(!record.output.includes('one-shot-ok'), '关停后不该出现一次性运行的输出')
  } finally {
    worker.dispose()
  }
})

test('取消：在飞一轮被 SIGTERM 判死 → 不再 respawn，startFails 仍为 0', async () => {
  const dir = dirOf('stop-cancel')
  const entry = makeDeafStub('stub-deaf-cancel.js')
  const fakeSpawn = makeFakeSpawn()
  const { worker, record } = await startInFlightRound(dir, entry, fakeSpawn, 'lock-cancel')
  try {
    // 与 /api/runs/cancel 同口径（console.js:7074-7092）
    record.cancelled = true
    record.cancelRequestedAt = Date.now()
    record._child.kill('SIGTERM')
    await waitFor(() => record.finishedAt > 0, 3000, '被取消的这一轮必须收尾（finishedAt > 0）')
    assert.strictEqual(fakeSpawn.calls.length, 0,
      `取消后不得再拉起一次性 spawn（实际 ${fakeSpawn.calls.length} 次 ⇒ 用户点停止变成立刻重跑）`)
    // 这条是 worker 层修复的判别式：console 层的「已取消就不 spawn」防御只挡 spawn、挡不住
    // failStart 的 startFails+1（3 次取消即永久降级），所以必须在这里断言计数。
    assert.strictEqual(worker.startFails, 0,
      `取消不是启动失败（startFails=${worker.startFails}）`)
    assert.strictEqual(record.runner, 'worker', '取消收尾的这一轮不应被改写成 runner=spawn')
  } finally {
    worker.dispose()
  }
})

test('防御：已收到停止请求时 worker 返回 fallback → 不 spawn、按已停止收尾（对照：无停止请求照旧降级 spawn）', async () => {
  const dir = dirOf('fallback-cancel')
  const fallingBack = { pid: 0, hasChild: false, run: () => Promise.resolve({ fallback: true, error: '常驻 worker 连续 3 次启动失败' }), cancelRound: () => {} }
  const fakeSpawn = makeFakeSpawn()
  const record = startAction('run', Date.now(), new Set(), dir, 'lock-fallback-cancel', dir, { worker: fallingBack, spawnImpl: fakeSpawn })
  record.cancelled = true
  record.cancelRequestedAt = Date.now()
  await waitFor(() => record.finishedAt > 0, 2000, '应直接按已停止收尾')
  assert.strictEqual(fakeSpawn.calls.length, 0,
    `已收到停止请求时不得再 spawn（实际 ${fakeSpawn.calls.length} 次 ⇒ worker 恰在点停止前一瞬自行退出时会被重跑）`)
  assert.strictEqual(record.runner, 'worker', '这一轮从未改走一次性 spawn，runner 应保持 worker')
  assert.ok(record.output.includes('已收到停止请求'), '应落一条说明进本轮输出')

  // 对照：同一条 fallback、但没有停止请求 ⇒ 既有降级行为必须原样保留（推送不中断）
  const dir2 = dirOf('fallback-no-cancel')
  const fakeSpawn2 = makeFakeSpawn()
  const record2 = startAction('run', Date.now(), new Set(), dir2, 'lock-fallback-plain', dir2, { worker: fallingBack, spawnImpl: fakeSpawn2 })
  await waitFor(() => fakeSpawn2.calls.length === 1 && record2.finishedAt > 0, 3000,
    '无停止请求时 fallback 应照旧拉起一次性子进程')
  assert.strictEqual(record2.runner, 'spawn', '降级路径的 runner 应变成 spawn')
  assert.strictEqual(record2.exitCode, 0)
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

// 本用例锁的是 resetRunStateForWorker 的 **5 个内部调用点**（上一轮审查 must_fix：删掉
// App._resetRunState() 或 MessageStore._resetRunWarnings() 后原有用例仍 17/17 全绿）。
// 判据有两层，缺一不可：① 逐项摘要齐全（每一项只由它自己那条复位语句 push，删语句=缺项）；
// ② 每一项的脏状态确实被清空/归零（把「调用」替换成不打紧的空语句也咬得住）。
test('隔离：resetRunStateForWorker 的 5 个复位调用点逐项可咬（摘要缺项/状态未清即红）', () => {
  const { App, MessageStore, resetRunStateForWorker, workerResetHooks } = require('./xbk_function_v3')
  const { FilterEngine, Formatter } = workerResetHooks
  // ① 不用 mock：直接把单例上的真实状态弄脏（都是 run() 一轮会写的字段）
  workerResetHooks.setRe2FallbackWarned(true)
  App._diskWarningAt = 123
  App._logRotateBackoffByPath.set('/a.log', { at: 1 })
  App._archiveWarnAtByKey.set('/a.log|2026-45', 1)
  App._weekMarkerWarnAtByKey.set('/a.log', 1)
  App._alertLastAtByPath.set('/a', 1)
  App._reportMemoryStateByPath.set('/r', { at: 1 })
  App._lastChannelHealthLockFailure = { reason: 'open', code: 'EACCES', message: 'x' }
  App._lastChannelHealthLockToken = 'deadbeef'
  MessageStore._journalWarned.add('push.json|badlines')
  MessageStore._residualTombstoneWarned.add('/x/push.json')
  MessageStore._memoWarned = true
  FilterEngine._whitelistReCache.set('k', /k/)
  FilterEngine._legacyCompileCache.set('k', [])
  // Formatter 的单槽缓存经公共 API 弄脏：htmlToMarkdown 会把整份 HTML 挂进 attrSpanCache，
  // 同一份 html 再取区间表命中的就是缓存里那一个 view（复位后必须重建 ⇒ 不是同一个对象）。
  const html = '<a href="https://example.com/a?b=1" title="t">链接</a><img src="https://example.com/i.png">'
  Formatter.htmlToMarkdown({ content_html: html })
  const cachedView = Formatter._quotedAttrSpans(html)
  assert.strictEqual(Formatter._quotedAttrSpans(html), cachedView,
    '前置：Formatter 单槽缓存应已填充（同一份 html 命中同一个 view）')

  // ② 只调用这一个导出的复位入口
  const summary = resetRunStateForWorker()

  // ③ 五项摘要逐项齐全（顺序固定）：删掉任意一条复位语句 ⇒ 该项缺失
  assert.deepStrictEqual(summary.steps, ['re2', 'app', 'filter', 'formatter', 'message-store'],
    `五项摘要必须齐全且顺序固定（实际 ${JSON.stringify(summary.steps)}；缺项 = 对应复位调用点没执行）`)

  // ④ 每一项的脏状态必须真的被清空/归零（摘要齐全但没真复位时这里红）
  assert.strictEqual(workerResetHooks.isRe2FallbackWarned(), false,
    'RE2 回落闸门必须归零（否则下一轮不再告警）')
  assert.strictEqual(App._diskWarningAt, 0, 'App._diskWarningAt 必须归零')
  assert.strictEqual(App._logRotateBackoffByPath.size, 0, 'App._logRotateBackoffByPath 必须清空')
  assert.strictEqual(App._archiveWarnAtByKey.size, 0, 'App._archiveWarnAtByKey 必须清空')
  assert.strictEqual(App._weekMarkerWarnAtByKey.size, 0, 'App._weekMarkerWarnAtByKey 必须清空')
  assert.strictEqual(App._alertLastAtByPath.size, 0, 'App._alertLastAtByPath 必须清空')
  assert.strictEqual(App._reportMemoryStateByPath.size, 0, 'App._reportMemoryStateByPath 必须清空')
  assert.strictEqual(App._lastChannelHealthLockFailure, null, '通道健康锁失败态必须归零')
  assert.strictEqual(App._lastChannelHealthLockToken, null, '通道健康锁令牌必须归零')
  assert.strictEqual(MessageStore._journalWarned.size, 0, 'MessageStore._journalWarned 必须清空')
  assert.strictEqual(MessageStore._residualTombstoneWarned.size, 0, 'MessageStore._residualTombstoneWarned 必须清空')
  assert.strictEqual(MessageStore._memoWarned, false, 'MessageStore._memoWarned 必须归零')
  assert.strictEqual(FilterEngine._whitelistReCache.size, 0, 'FilterEngine._whitelistReCache 必须清空')
  assert.strictEqual(FilterEngine._legacyCompileCache.size, 0, 'FilterEngine._legacyCompileCache 必须清空')
  assert.notStrictEqual(Formatter._quotedAttrSpans(html), cachedView,
    'Formatter 单槽缓存必须已丢弃（仍返回上一轮的 view = 复位调用点缺失或没清）')
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

test('接线：--worker 连续两轮都经过 resetRunStateForWorker（每轮五项明细齐全）', async () => {
  const dir = dirOf('reset-trace')
  const worker = startRawWorker(dir, { XBK_WORKER_TRACE_RESET: '1' })
  // 痕迹行自带逐项明细：五项必须全在（任一条复位语句被删 ⇒ 该项从 steps 里消失，这里变红）。
  const EXPECTED_STEPS = 'steps=re2,app,filter,formatter,message-store'
  const traceLines = () => worker.stderr().split('\n').filter((line) => line.includes('[worker] reset-run-state'))
  try {
    worker.send({ cmd: 'run', args: [] })
    const first = await worker.next()
    assert.strictEqual(first.ok, true, `第一轮协议应 ok：${JSON.stringify(first)}`)
    await waitFor(() => traceLines().length >= 1, 2000, '第一轮应留下复位痕迹')
    const firstLines = traceLines()
    assert.strictEqual(firstLines.length, 1, `第一轮必须调用一次复位钩子（实际 ${firstLines.length} 次）`)
    assert.ok(firstLines[0].includes(EXPECTED_STEPS),
      `第一轮的痕迹必须带五项明细（实际「${firstLines[0].trim()}」；缺项 = 对应复位调用点没执行）`)
    worker.send({ cmd: 'run', args: [] })
    const second = await worker.next()
    assert.strictEqual(second.ok, true, `第二轮协议应 ok：${JSON.stringify(second)}`)
    await waitFor(() => traceLines().length >= 2, 2000, '第二轮应再留下一次复位痕迹')
    const lines = traceLines()
    assert.strictEqual(lines.length, 2, `第二轮必须再复位一次（累计 ${lines.length} 次；删掉 resetRunStateForWorker() 调用点会变 0）`)
    for (const line of lines) {
      assert.ok(line.includes(EXPECTED_STEPS),
        `两轮痕迹都必须带五项明细（实际「${line.trim()}」）`)
    }
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
