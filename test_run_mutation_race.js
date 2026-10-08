'use strict'

// runTests 超时契约回归（#131 qodo #3 + D1「超时丢弃真实退出码」）。run_mutation.js 的 runTests
// 有 4 条结算路径，全部由本套件的 fake child 注入式覆盖：
//   A) 超时 → kill → close 携带真实退出码 0：按真实 code 判 pass，不得谎报 timeout + SIGKILL
//      （D1：谎报会把「刚好赶上超时窗口的正常完成」记为 timeout → 本地运行误红，且同
//      scripts/mutation-report.js:103 的 (killed + timeout) / total 口径虚增分数、掩盖真实存活）
//   A2) 超时 → kill → close 携带真实退出码 1：同样按真实 code 判 fail（非零真实码不被吞掉）
//   B1) 超时 → kill → close 无真实 code（被信号杀死）：timeout 形态，透传 close 的真实 signal
//      （#132 review Q4：close 发射非默认信号 'SIGTERM' 并断言返回 SIGTERM——兜底值恰是
//      'SIGKILL'，若实现不透传而硬编码回退值，本断言即红）
//   B2) 超时 → kill → close 悬空（异常 fd/僵尸进程）：2000ms 兜底保险定时器 resolve，signal 回退 'SIGKILL'
// 本套件用注入法（把 child_process.spawn 替换为 fake child 工厂）覆盖四条路径，并用独立 Node 进程验证兜底结算后没有遗留计时器；只依赖 node 内置模块，不依赖 node_modules。
// 关键原理：run_mutation.js 顶层是 `const { spawn } = require('child_process')`（模块加载时解构），
// 所以必须先替换 child_process.spawn，再清 require 缓存重新 require('./run_mutation') 才生效。
// 运行方式：node test_run_mutation_race.js（exit 0 = 通过；普通环境约 5.5s，含 B2 约 2s 兜底与进程级探针）。
// 变异沙箱（XBK_MUTATION_CHILD=1）下秒级跳过（#132 review Q6）；普通单元门禁完整执行。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const childProcess = require('node:child_process')

const originalSpawn = childProcess.spawn
const killedSignals = [] // fake child 的 kill 收到的信号（按调用次序）
let lastChild = null // 最近一次 spawn 返回的 fake child（测试需手动触发其 close）

function makeFakeChild () {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = (signal) => {
    killedSignals.push(String(signal))
    return true
  }
  lastChild = child
  return child
}

// 轮询等待 kill 调用次数达到 expected（30ms 定时器触发后 runTests 才会 kill）
function waitKillCount (expected, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (killedSignals.length >= expected) {
        clearInterval(iv)
        resolve()
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv)
        reject(new Error(`kill 未在 ${timeoutMs}ms 内触发第 ${expected} 次（当前 ${killedSignals.length} 次）`))
      }
    }, 5)
  })
}

;(async () => {
  // 防重入/省固定成本（#132 review Q6）：stryker 变异沙箱（mutation.yml 的 commandRunner 反复
  // spawn run_unit_tests.js，18 个分片）每次都会执行本套件，场景 B 的 ~2s 兜底等待白白重复 18 次
  // ——run_mutation.js 不在变异目标内，本场景与 mutate 目标无关。与 test_run_mutation_cli.js 同款
  // 防重入：XBK_MUTATION_CHILD=1（run_mutation.js 子进程与 mutation.yml 的 stryker step 均设置）
  // 时跳过；普通单元门禁（npm run test:unit 等）不设该变量，仍完整执行本套件，回归覆盖不受影响。
  // #132 CI lint 教训——guard 必须在函数内，模块顶层 return 会被 standard/espree 判解析错误
  if (process.env.XBK_MUTATION_CHILD === '1') {
    console.log('⏭ 检测到 XBK_MUTATION_CHILD，跳过竞态场景（防变异运行递归/省 2s 固定成本）')
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtests-race-'))
  try {
    // 注入 + 重载：让 run_mutation.js 顶层解构拿到 fake spawn
    childProcess.spawn = makeFakeChild
    delete require.cache[require.resolve('./run_mutation')]
    const { runTests } = require('./run_mutation')

    // ── 场景 A：超时 → kill → close 携带真实退出码 0 → pass（D1 核心：不得谎报 timeout） ──
    {
      killedSignals.length = 0
      const t0 = Date.now()
      const pending = runTests(dir, 30)
      await waitKillCount(1)
      assert.strictEqual(killedSignals[0], 'SIGKILL', '超时后应向子进程发 SIGKILL')
      // 模拟「超时线已过，但进程在 SIGKILL 生效前已自然退出」：close 携带真实 code=0、无 signal。
      // D1 修复前此处返回 { status:'timeout', code:null, signal:'SIGKILL' }（真实结论被丢弃）。
      lastChild.emit('close', 0, null)
      const result = await pending
      const elapsed = Date.now() - t0
      assert.strictEqual(result.status, 'pass', '超时窗口内自然退出（code=0）应按真实退出码判 pass，而非 timeout')
      assert.strictEqual(result.code, 0, '应透传 close 的真实退出码 0（不是 null）')
      assert.strictEqual(result.signal, null, '自然退出无 signal，应透传 null（不得回退 SIGKILL）')
      assert.ok(Array.isArray(result.summary), 'summary 应为数组（空输出 → []）')
      assert.strictEqual(result.output, '', '未写入任何输出时 output 应为空字符串')
      assert.ok(elapsed < 1900,
        `路径 A 应由 close 收敛快速 resolve（实测 ${elapsed}ms，应 < 1900ms，而非等 2000ms 兜底）`)
      console.log('✅ 场景A：超时→close 携带真实 code=0 → pass（不再谎报 timeout/SIGKILL）')
    }

    // ── 场景 A2：超时 → kill → close 携带真实退出码 1 → fail（真实非零码同样不被吞掉） ──
    {
      const t0 = Date.now()
      const pending = runTests(dir, 30)
      await waitKillCount(2)
      assert.strictEqual(killedSignals[1], 'SIGKILL', '第二次超时后同样应发 SIGKILL')
      lastChild.emit('close', 1, null)
      const result = await pending
      const elapsed = Date.now() - t0
      assert.strictEqual(result.status, 'fail', '真实退出码 1 应判 fail，而非 timeout')
      assert.strictEqual(result.code, 1, '应透传真实退出码 1')
      assert.ok(elapsed < 1900,
        `路径 A2 应由 close 收敛快速 resolve（实测 ${elapsed}ms，应 < 1900ms）`)
      console.log('✅ 场景A2：超时→close 携带真实 code=1 → fail')
    }

    // ── 场景 B1：超时 → kill → close 无真实 code（被信号杀死）→ timeout + 透传真实 signal ──
    {
      const pending = runTests(dir, 30)
      await waitKillCount(3)
      assert.strictEqual(killedSignals[2], 'SIGKILL', '第三次超时后同样应发 SIGKILL')
      // 模拟真实子进程被 kill 后 close 正常到达（带真实 signal、无 code）。故意发射非默认信号 'SIGTERM'
      // 而非 'SIGKILL'（#132 review Q4）：兜底回退值恰是 SIGKILL，若实现偷偷硬编码回退值而
      // 不透传 close 的真实 signal，用 SIGKILL 断言仍全绿——非默认信号才能证明透传。
      lastChild.emit('close', null, 'SIGTERM')
      const result = await pending
      assert.strictEqual(result.status, 'timeout', 'close 无真实退出码（被信号杀死）应返回 timeout')
      assert.strictEqual(result.code, null, '超时结果应显式返回 code: null')
      assert.strictEqual(result.signal, 'SIGTERM', '应透传 close 的真实 signal（SIGTERM，而非兜底回退的 SIGKILL）')
      assert.ok(Array.isArray(result.summary), 'summary 应为数组（空输出 → []）')
      assert.strictEqual(result.output, '', '未写入任何输出时 output 应为空字符串')
      console.log('✅ 场景B1：超时→close 无 code → timeout 并透传真实 signal（SIGTERM）')
    }

    // ── 场景 B2：超时 → kill → close 悬空 → 兜底定时器 resolve（signal 回退 'SIGKILL'） ──
    {
      const t0 = Date.now()
      const pending = runTests(dir, 30)
      await waitKillCount(4)
      assert.strictEqual(killedSignals[3], 'SIGKILL', '第四次超时后同样应发 SIGKILL')
      // 故意不 emit close：只能靠 2000ms 兜底保险定时器 resolve。
      // #132 review Q5：直接 await pending 时，若生产代码的 2000ms 兜底被移除/变长/未调度，
      // 测试会无限挂到 CI 作业超时而不是断言失败。加测试侧 watchdog（10s）：兜底故障时显式
      // 断言失败并给出明确错误。
      // A1（重要）：watchdog 必须保持 ref，绝不 .unref()。30ms 定时器 kill 后进程内再无其他 ref
      // 句柄（waitKillCount 的 5ms interval 已 clear、fake child 无 OS 句柄），unref 的 watchdog
      // 不计入存活 → Node 事件循环清空直接 exit 0，pending 与 watchdog 都不结算，而
      // run_unit_tests.js 只看退出码 → 判 ✅。那正是「删掉生产兜底仍全绿」的假绿；ref 之后
      // 正常路径由 finally 的 clearTimeout 清掉，不拖慢 CI（本套件预算仍约 2.2s）。
      let watchdogTimer
      const watchdog = new Promise((resolve, reject) => {
        watchdogTimer = setTimeout(
          () => reject(new Error('生产兜底未在预期时间内 resolve（2000ms 兜底被移除/变长/未调度？）')),
          10000)
      })
      try {
        const result = await Promise.race([pending, watchdog])
        const elapsed = Date.now() - t0
        assert.strictEqual(result.status, 'timeout', 'close 悬空时兜底结果应为 timeout')
        assert.strictEqual(result.code, null, '兜底结果 code 应为 null')
        assert.strictEqual(result.signal, 'SIGKILL', 'close 悬空时 signal 应回退 SIGKILL')
        assert.ok(Array.isArray(result.summary), 'summary 应为数组（空输出 → []）')
        assert.ok(elapsed >= 1900,
          `路径 B2 应等待 2000ms 兜底定时器 resolve（实测 ${elapsed}ms，应 >= 1900ms）`)
        console.log('✅ 场景B2：close 悬空由 2000ms 兜底定时器 resolve（signal 回退 SIGKILL）')
      } finally {
        clearTimeout(watchdogTimer)
      }
      // 进程级回归：Promise 已 resolve 不能证明事件循环已清空。用独立 Node 子进程复现 close 悬空，
      // idle 线故意设为 60s；修复前该子进程会被 5s watchdog 杀掉，修复后约 2s 自然退出。
      const probeNode = process.argv0 && fs.existsSync(process.argv0) ? process.argv0 : process.execPath
      const probe = [
        "'use strict'",
        "const { EventEmitter } = require('node:events')",
        "const { PassThrough } = require('node:stream')",
        "const cp = require('node:child_process')",
        'cp.spawn = () => {',
        '  const c = new EventEmitter()',
        '  c.stdout = new PassThrough()',
        '  c.stderr = new PassThrough()',
        '  c.kill = () => true',
        '  return c',
        '}',
        "const { runTests } = require('./run_mutation')",
        "runTests('.', 10, 60000).then(r => { if (r.status !== 'timeout') process.exitCode = 1 })"
      ].join('\n')
      const probeResult = childProcess.spawnSync(probeNode, ['-e', probe], {
        cwd: __dirname, encoding: 'utf8', timeout: 5000
      })
      assert.strictEqual(probeResult.status, 0,
        `B2 兜底后 Node 进程应在 5s 内退出，实际 status=${probeResult.status} signal=${probeResult.signal} error=${probeResult.error ? probeResult.error.message : ''}`)
      console.log('✅ 场景B2进程级回归：兜底结算后无遗留 idle 定时器')
    }

    // ── 场景 E：spawn 失败（如 PATH 里没有 node → ENOENT）只发 'error' 且不触发 'close' ──
    // review F5：此前 runTests 没有 child.on('error')，spawn 失败会抛 uncaughtException 崩掉整轮调度器，
    // 且 Promise 一直悬到 90s 超时定时器/2000ms 兜底。现在必须按 fail 立即结算并清掉定时器。
    {
      const t0 = Date.now()
      const pending = runTests(dir, 60000) // 超时给足：证明结算是 error 触发，而不是靠超时/兜底
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(lastChild, 'spawn 应返回 fake child')
      lastChild.emit('error', new Error('spawn node ENOENT'))
      const result = await pending
      const elapsed = Date.now() - t0
      assert.strictEqual(result.status, 'fail', 'spawn 失败应按 fail 结算（未监听 error 会抛 uncaughtException）')
      assert.strictEqual(result.code, null, 'spawn 失败没有退出码，code 应为 null')
      assert.match(result.error, /ENOENT/, '应保留 error.message 便于定位')
      assert.ok(Array.isArray(result.summary), 'summary 应为数组')
      assert.ok(elapsed < 5000, `error 应立即结算（实测 ${elapsed}ms，不得等 60s 超时）`)
      console.log('✅ 场景E：子进程 error 事件按 fail 立即结算（不再 uncaughtException/悬空）')
    }

    // ── 场景 F（v3.282）：子进程一直静默 → 静默线判挂死，总上限远未到达 ──
    {
      killedSignals.length = 0
      const t0 = Date.now()
      const pending = runTests(dir, 60000, 120) // 总上限 60s、静默线 120ms
      await waitKillCount(1)
      assert.strictEqual(killedSignals[0], 'SIGKILL', '静默到线应整组 SIGKILL')
      lastChild.emit('close', null, 'SIGKILL')
      const result = await pending
      const elapsed = Date.now() - t0
      assert.strictEqual(result.status, 'timeout', '静默挂死应结算 timeout')
      assert.ok(elapsed < 3000, '挂死应在静默线附近收敛（实测 ' + elapsed + 'ms），不该等 60s 总上限——这正是本次改动要修的语义')
      console.log('✅ 场景F：持续静默 → 静默线判挂死（无须等总上限）')
    }

    // ── 场景 G（v3.282）：持续输出、总耗时跨过静默线 → 不被杀，按真实退出码结算 ──
    {
      killedSignals.length = 0
      const pending = runTests(dir, 60000, 150)
      const iv = setInterval(() => { if (lastChild && lastChild.stdout.writable) lastChild.stdout.write('推进一行\n') }, 40)
      await new Promise(resolve => setTimeout(resolve, 520)) // 远超 150ms 静默线：旧语义在这里就会被杀
      clearInterval(iv)
      lastChild.emit('close', 0, null)
      const result = await pending
      assert.deepStrictEqual(killedSignals, [], '只要持续推进就不该被杀（墙钟总长的缺陷正在于区分不了「慢」与「挂死」）')
      assert.strictEqual(result.status, 'pass', '慢但推进的子进程应按真实 code=0 判 pass')
      assert.ok(result.output.includes('推进一行'), '输出应被完整收集')
      console.log('✅ 场景G：持续输出跨过静默线 → 不被杀、判 pass（慢机器不再假红）')
    }

    // ── 场景 H（v3.282）：总上限仍是兜底——持续输出也要在 timeoutMs 收敛 ──
    {
      killedSignals.length = 0
      const pending = runTests(dir, 150, 60000) // 总上限 150ms 先于静默线
      const iv = setInterval(() => { if (lastChild && lastChild.stdout.writable) lastChild.stdout.write('x') }, 20)
      await waitKillCount(1)
      clearInterval(iv)
      lastChild.emit('close', null, 'SIGKILL')
      const result = await pending
      assert.strictEqual(result.status, 'timeout', '总上限到线仍应判 timeout（静默线不是唯一防线）')
      console.log('✅ 场景H：总上限依然兜底（持续输出也会被 timeoutMs 收敛）')
    }

    console.log('✅ 变异超时契约：四路径 + spawn error + 静默线/总上限双轨 注入式回归通过')
  } finally {
    // 还原模块状态：恢复真实 spawn，清缓存后重新 require（顶层解构重新绑定真实 spawn）
    childProcess.spawn = originalSpawn
    delete require.cache[require.resolve('./run_mutation')]
    require('./run_mutation')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})().catch((e) => { console.error(e); process.exit(1) })
