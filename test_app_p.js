'use strict'
// ============================================================
// test_app 并行调度器（v3.172 重写）
// 前身（v3.122）因「多 worker 共享 xianbaoku_cache 目录」在沙箱 overlayfs 产生
// IO 竞态（ENOENT 偶发失败）被回滚。重写核心改进：
//   1. 每个 worker 用独立缓存目录（XBK_PARALLEL_ID → xianbaoku_cache_p<N>）
//      ——缓存/run.log/state 全隔离，无任何共享 IO，根除竞态
//   2. --list-file 精确名单分片（--only 子串可能重叠/漏跑）
//   3. QUICK=1 快测（pushInterval/finalWait=0；重试类测试的真实退避等待保留）
//   4. 每次运行使用唯一 worker ID，允许多个调度器同时执行而不撞临时文件/缓存目录
// 用法：node test_app_p.js        （沙箱默认并发 8 稳定）
//       CONCURRENCY=32 node test_app_p.js   （真机可调大）
// 失败时用串行定位：node test_app.js --only=<测试名子串>
//   （v3.276/EXEC-D T10 起 `--only=<子串>` 与空格形式 `--only <子串>` 均生效；
//     此前只有空格形式生效，照本行提示抄等号形式会静默跑全量用例）
// ============================================================
const { fork } = require('child_process')
const fs = require('fs')
const path = require('path')

const CONCURRENCY = (() => {
  const c = Number.parseInt(process.env.CONCURRENCY || '8', 10)
  return Number.isInteger(c) && c > 0 ? c : 8
})()
const SRC = path.join(__dirname, 'test_app.js')
// 同一目录内并发启动多个调度器时，临时名单和 worker 缓存必须互不碰撞。
// ⚠️ workerId 必须始终由本文件**自造**，并在 runChunk 里以 `{ ...process.env, XBK_PARALLEL_ID: workerId }`
// 的**覆盖**形式注入——那里 workerId 位于 spread 之后，故父进程即便已有同名变量也传不进子进程，
// 隔离不依赖调用方守规矩。这不是洁癖：XBK_PARALLEL_ID 直接参与 `xianbaoku_cache_p<ID>` 的路径拼接
// （生产侧 xbk_message_store.js，而测试侧有多处对该目录递归 rmSync——本文件的 worker 缓存清理
// 与 test_filter.js 的缓存隔离用例），非受控值即越界删除向量
// （test_filter.js 曾因此被报 Qodo PR #158 High/Security）。
// ⇒ 不要改成 `process.env.XBK_PARALLEL_ID || workerId`，也不要把 spread 挪到后面。
const RUN_ID = `${process.pid}_${Date.now()}`
const workerIds = []

// ---------- 1. 提取测试名（与 test_app.js 的 await test('name' 一一对应） ----------
const src = fs.readFileSync(SRC, 'utf8')
const names = [...src.matchAll(/await test\((['"])(.*?)\1,/g)].map(m => m[2])
if (names.length === 0) { console.error('未提取到测试名'); process.exit(2) }

// ---------- 2. 分片（名称排序后均分，每片一个 worker，保证无重叠） ----------
// CodeRabbit 审查：localeCompare 跟随进程 locale（C=en-US 与 zh-CN 分片不同）→ 改 code-unit 比较，全环境确定性
// S3358：嵌套三元拆成显式比较函数（S2871：显式且 locale 无关）
const cmpTestName = (a, b) => {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
const sorted = names.slice().sort(cmpTestName)
const chunkSize = Math.ceil(sorted.length / CONCURRENCY)
const chunks = []
for (let i = 0; i < sorted.length; i += chunkSize) {
  chunks.push(sorted.slice(i, i + chunkSize))
  workerIds.push(`${RUN_ID}_${chunks.length - 1}`)
}

// ---------- 3. 并发 fork（独立缓存目录 + 精确名单 + QUICK 快测） ----------
const t0 = Date.now()
// 活跃子进程登记：setup 中途抛错（writeFileSync/fork）时顶层 catch 能终止已启动的 worker
const activeChildren = new Set()

// 跑一个分片：返回退出码。quick=true 时用 QUICK 快测；重跑时用非 QUICK 完整验证
// executedReports：worker 落盘的执行计数（idx → {executed, skipped, passed, failed}）。
// 用文件而不是 stdout：stdio 是 inherit（进度照常打到终端），父进程读不到子进程输出。
const executedReports = new Map()
function runChunk (chunk, idx, quick) {
  return new Promise((resolve) => {
    const workerId = workerIds[idx]
    const listFile = path.join(__dirname, `.tmp_parallel_${workerId}.json`)
    const reportFile = path.join(__dirname, `.tmp_parallel_report_${workerId}.json`)
    fs.writeFileSync(listFile, JSON.stringify(chunk))
    try { fs.unlinkSync(reportFile) } catch (e) { /* 上一轮残留（重跑路径） */ }
    const child = fork(SRC, ['--list-file', listFile], {
      env: { ...process.env, XBK_PARALLEL_ID: workerId, QUICK: quick ? '1' : '', XBK_TEST_APP_REPORT: reportFile },
      stdio: 'inherit'
    })
    activeChildren.add(child)
    // spawn 失败（EACCES/ENOENT 等）时 Node 只发 'error' 事件、不发 'exit'——
    // 不 resolve 会让 Promise.all 永久挂起，调度器静默卡死。按失败片处理（进串行重跑路径）。
    child.on('error', (err) => {
      activeChildren.delete(child)
      try { fs.unlinkSync(listFile) } catch (e) {}
      console.error(`worker#${idx} 启动失败：${err && err.code ? err.code : err}`)
      resolve(1)
    })
    child.on('exit', (code) => {
      activeChildren.delete(child)
      try { fs.unlinkSync(listFile) } catch (e) {}
      // 报告缺失/损坏时不要抛：让对账段统一判定（缺报告本身就是「无法证明执行过」）。
      try {
        const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
        if (rep && typeof rep.executed === 'number') executedReports.set(idx, rep)
        else executedReports.delete(idx)
      } catch (e) {
        executedReports.delete(idx)
      }
      resolve(code)
    })
  })
}

// 收尾：worker 名单临时文件 + 独立缓存目录（本进程自己创建的临时产物）。
// 旧实现只在「子进程 exit」与「happy path 末尾」两处清理：被 Ctrl-C / 外部 kill、或 setup
// 中途抛错时，`.tmp_parallel_<workerId>.json` 与 `xianbaoku_cache_p<workerId>` 会留在仓库根。
// 两者都被 .gitignore 覆盖（目录 `xianbaoku_cache*`、名单 `.tmp_parallel_*.json`）⇒ git status
// 看不出来，只能靠数文件发现——实测已滞留 2 个名单文件。收敛成幂等入口，三条退出路径都调。
function cleanupArtifacts () {
  for (const workerId of workerIds) {
    try { fs.unlinkSync(path.join(__dirname, `.tmp_parallel_${workerId}.json`)) } catch (e) {} // 已删 / 未建
    try { fs.unlinkSync(path.join(__dirname, `.tmp_parallel_report_${workerId}.json`)) } catch (e) {} // 执行计数报告
    try { fs.rmSync(path.join(__dirname, `xianbaoku_cache_p${workerId}`), { recursive: true, force: true }) } catch (e) {}
  }
}

// 被 Ctrl-C / 外部 kill 时同样收尾（SIGKILL 抓不到，不属本机制的覆盖范围）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    for (const child of activeChildren) { try { child.kill() } catch (e) {} }
    cleanupArtifacts()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  })
}

console.log(`🧪 test_app 并行调度：${names.length} 个测试 → ${chunks.length} 片（并发 ${CONCURRENCY}，独立缓存目录）\n`);

// ---------- 4. 首轮并发 + 失败片串行重跑（flaky 容错） ----------
// 沙箱 overlayfs 高并发下偶发 IO 抖动（v3.122 同源）：首轮失败不直接判定，
// 该片串行完整重跑一次（无 QUICK）——偶发失败应转绿，真实失败仍红可定位
(async () => {
  const codes = await Promise.all(chunks.map((chunk, idx) => runChunk(chunk, idx, true)))
  for (let i = 0; i < chunks.length; i++) {
    if (codes[i] !== 0) {
      console.log(`\n⚠️ worker#${i} 首轮失败，串行重跑完整验证（flaky 容错）...`)
      codes[i] = await runChunk(chunks[i], i, false)
    }
  }

  cleanupArtifacts()
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const failedWorkers = codes.map((c, i) => ({ c, i })).filter(w => w.c !== 0)
  // 计数对账（C5-004）：只看退出码挡不住「名单里的名字一个都没命中」——那时每个 worker
  // 0 例执行也 exit 0，汇总照报「全部通过」。这里要求每片都回报执行数，且 Σexecuted === 名单总数。
  let reconProblem = null
  let sumExecuted = 0
  for (let i = 0; i < chunks.length; i++) {
    const rep = executedReports.get(i)
    if (!rep) { reconProblem = `worker#${i} 未回报执行计数（报告缺失，无法证明该片跑过）`; break }
    sumExecuted += rep.executed
    if (rep.executed !== chunks[i].length) {
      reconProblem = `worker#${i} 名单 ${chunks[i].length} 例但实际执行 ${rep.executed} 例（过滤跳过 ${rep.skipped} 例）` +
        `${rep.skipped > 0 ? '——名单与 test_app.js 的用例名对不上' : ''}`
      break
    }
  }
  if (!reconProblem && sumExecuted !== names.length) reconProblem = `Σexecuted=${sumExecuted} ≠ 名单总数 ${names.length}`
  console.log('\n════════ 并行汇总 ════════')
  console.log(`  测试: ${names.length} 个 | 并发: ${CONCURRENCY} | 耗时: ${secs}s | 实际执行: ${sumExecuted} 例`)
  if (failedWorkers.length === 0 && !reconProblem) {
    console.log('  结果: 全部通过 ✅')
    process.exit(0)
  } else {
    for (const w of failedWorkers) console.log(`  ✗ worker#${w.i} 重跑后仍失败（涉及 ${chunks[w.i].length} 个测试）`)
    if (reconProblem) {
      console.log(`  ✗ 执行计数对账失败（本次结果不可信）：${reconProblem}`)
    }
    console.log('  定位: node test_app.js --only=<测试名子串> 串行重跑（等号/空格两种写法均生效）')
    process.exit(1)
  }
})().catch(e => {
  console.error(e)
  for (const child of activeChildren) { try { child.kill() } catch (err) {} }
  cleanupArtifacts()
  process.exitCode = 1
})
