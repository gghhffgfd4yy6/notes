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
// ============================================================
const { fork } = require('child_process')
const fs = require('fs')
const path = require('path')

const CONCURRENCY = (() => {
  const c = parseInt(process.env.CONCURRENCY || '8', 10)
  return Number.isInteger(c) && c > 0 ? c : 8
})()
const SRC = path.join(__dirname, 'test_app.js')
// 同一目录内并发启动多个调度器时，临时名单和 worker 缓存必须互不碰撞。
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

// 跑一个分片：返回退出码。quick=true 时用 QUICK 快测；重跑时用非 QUICK 完整验证
function runChunk (chunk, idx, quick) {
  return new Promise((resolve) => {
    const workerId = workerIds[idx]
    const listFile = path.join(__dirname, `.tmp_parallel_${workerId}.json`)
    fs.writeFileSync(listFile, JSON.stringify(chunk))
    const child = fork(SRC, ['--list-file', listFile], {
      env: { ...process.env, XBK_PARALLEL_ID: workerId, QUICK: quick ? '1' : '' },
      stdio: 'inherit'
    })
    child.on('exit', (code) => { try { fs.unlinkSync(listFile) } catch (e) {} resolve(code) })
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

  // 清理：worker 独立缓存目录（自己创建的临时产物）
  for (const workerId of workerIds) {
    try { fs.rmSync(path.join(__dirname, `xianbaoku_cache_p${workerId}`), { recursive: true, force: true }) } catch (e) {}
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const failedWorkers = codes.map((c, i) => ({ c, i })).filter(w => w.c !== 0)
  console.log('\n════════ 并行汇总 ════════')
  console.log(`  测试: ${names.length} 个 | 并发: ${CONCURRENCY} | 耗时: ${secs}s`)
  if (failedWorkers.length === 0) {
    console.log('  结果: 全部通过 ✅')
    process.exit(0)
  } else {
    for (const w of failedWorkers) console.log(`  ✗ worker#${w.i} 重跑后仍失败（涉及 ${chunks[w.i].length} 个测试）`)
    console.log('  定位: node test_app.js --only=<测试名子串> 串行重跑')
    process.exit(1)
  }
})()
