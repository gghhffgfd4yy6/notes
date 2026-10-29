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
//   5. 失败片重跑换**新的** worker 分片（新 workerId ⇒ 新缓存目录），不复用首轮那份脏目录（C5-085）
// 用法：node test_app_p.js        （沙箱默认并发 8 稳定）
//       CONCURRENCY=32 node test_app_p.js   （真机可调大）
// 失败时用串行定位：node test_app.js --only=<测试名子串>
//   （v3.276/EXEC-D T10 起 `--only=<子串>` 与空格形式 `--only <子串>` 均生效；
//     此前只有空格形式生效，照本行提示抄等号形式会静默跑全量用例）
// 自测（C5-081 回归）：node test_app_p.js --selfcheck
//   —— 在夹具目录上跑同一份 cleanupArtifacts/scanResidualArtifacts，断言「清理失败 ⇒ 有残留 ⇒ exit 1」
// 复现故障注入（只跳过报告文件的删除，用来验证残留回扫真能拦住报告类产物）：
//   XBK_CLEANUP_FAULT=report node test_app_p.js   ⇒ 正常跑完但 exit 1 并点名残留的 .tmp_parallel_report_*.json
// ============================================================
const { fork } = require('child_process')
const fs = require('fs')
const os = require('os')
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
// 本进程用过的**全部**分片 ID（含失败重跑那几轮）：cleanupArtifacts 必须按它逐个清，否则重跑
// 分片目录会漏在仓库根。C5-085 起重跑不再复用首轮 ID（见 workerIdFor）。
const usedWorkerIds = new Set()

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
}

// 分片 ID 按「第几次跑这一片」现算（C5-085）：首轮 `${RUN_ID}_<idx>` 保持不变
// （test_app.js:4426 的「与 test_app_p.js 分片口径逐字符一致」断言就锚在这个形态上），
// 重跑则用 `${RUN_ID}_<idx>_r<n>`。
// 为什么要换：重跑复用同一个 workerId ⇒ 同一个 `xianbaoku_cache_p<ID>`。而首轮失败恰恰常是
// overlayfs 的 IO 竞态，用「上一轮刚写过、进程可能还没退干净」的目录去重验，等于把同一竞态再演一遍，
// 把 flaky 判成真失败——「每 worker 独立缓存目录」的隔离设计在重跑路径上被自己抵消了。
// 形态约束：只含 [A-Za-z0-9_-]（test_app.js 的 sanitizeIsolationId 白名单 + 64 字符上限），
// 且仍**由本文件自造**（理由见上方 XBK_PARALLEL_ID 段）。
const workerIdFor = (idx, attempt) => (attempt > 0 ? `${RUN_ID}_${idx}_r${attempt}` : `${RUN_ID}_${idx}`)

// ---------- 3. 并发 fork（独立缓存目录 + 精确名单 + QUICK 快测） ----------
const t0 = Date.now()
// 活跃子进程登记：setup 中途抛错（writeFileSync/fork）时顶层 catch 能终止已启动的 worker
const activeChildren = new Set()

// 跑一个分片：返回退出码。quick=true 时用 QUICK 快测；重跑时用非 QUICK 完整验证。
// attempt 决定分片 ID（C5-085）：0 = 首轮，n>0 = 第 n 次重跑，各自独立的名单文件/报告/缓存目录。
// executedReports：worker 落盘的执行计数（idx → {executed, skipped, passed, failed}）。
// 用文件而不是 stdout：stdio 是 inherit（进度照常打到终端），父进程读不到子进程输出。
const executedReports = new Map()
function runChunk (chunk, idx, quick, attempt = 0) {
  return new Promise((resolve) => {
    const workerId = workerIdFor(idx, attempt)
    usedWorkerIds.add(workerId)
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

// 收尾：worker 名单临时文件 + 执行报告 + 独立缓存目录（本进程自己创建的临时产物）。
// 旧实现只在「子进程 exit」与「happy path 末尾」两处清理：被 Ctrl-C / 外部 kill、或 setup
// 中途抛错时，`.tmp_parallel_<workerId>.json` 与 `xianbaoku_cache_p<workerId>` 会留在仓库根。
// 两者都被 .gitignore 覆盖（目录 `xianbaoku_cache*`、名单 `.tmp_parallel_*.json`）⇒ git status
// 看不出来，只能靠数文件发现——实测已滞留 2 个名单文件。收敛成幂等入口，三条退出路径都调。
// 故障注入（只服务本文件的回归自测/复现，默认不生效）：XBK_CLEANUP_FAULT=report 让「报告文件」的
// 删除空转，其余产物照删；这样跑完必留 N 份报告，用来验证回扫能接住并判 exit 1（见 --selfcheck）。
const CLEANUP_FAULT = process.env.XBK_CLEANUP_FAULT || ''

// opts 仅供 --selfcheck 使用（默认值即线上口径）：换成夹具目录/假 workerId/必抛的删除桩，
// 就能在不改产品代码的前提下复现「删不掉」。
function cleanupArtifacts (opts = {}) {
  const root = opts.root || __dirname
  const ids = opts.ids || usedWorkerIds
  const unlink = opts.unlink || fs.unlinkSync
  const rm = opts.rm || ((p) => fs.rmSync(p, { recursive: true, force: true }))
  for (const workerId of ids) {
    try { unlink(path.join(root, `.tmp_parallel_${workerId}.json`)) } catch (e) {} // 已删 / 未建
    if (CLEANUP_FAULT !== 'report') {
      try { unlink(path.join(root, `.tmp_parallel_report_${workerId}.json`)) } catch (e) {} // 执行计数报告
    }
    try { rm(path.join(root, `xianbaoku_cache_p${workerId}`)) } catch (e) {}
  }
}

// ---------- 收尾的正确顺序（C5-081）----------
// `child.kill()` 只**投递**信号，不保证子进程已经停手。旧收尾是「kill() → 立刻递归删目录 → process.exit()」：
// 子进程此刻可能还在跑（收尾写 XBK_TEST_APP_REPORT、刷缓存/run.log），父进程把目录删掉就退出，子进程随后
// 落盘即**没有人会清**的残留。三种产物又都被 .gitignore 覆盖（目录 `xianbaoku_cache*`、名单 `.tmp_parallel_*.json`）
// ⇒ git status 一片干净，这种残留既不会自己暴露，也没有门禁扫它（实测滞流过 2 个名单文件）。
// 收尾改成有序四步：① 投递 SIGTERM；② 等子进程**真的退出**（有界，超时升级 SIGKILL）；
// ③ 再删产物；④ 扫本次 RUN_ID 命名空间，扫到残留就判失败——残留从此是「看得见的失败」，不是运气。
const REAP_TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.XBK_REAP_TIMEOUT_MS || '5000', 10)
  return Number.isInteger(v) && v > 0 ? v : 5000
})()

// 等一个子进程退出：已退出立即 true；超时 false（调用方据此升级 SIGKILL）。
function waitChildExit (child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(ok)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), ms)
    child.once('exit', onExit)
  })
}

// 依次（而非同时）等：一个卡住的 worker 不该把其它 worker 的回收预算吃光。
async function reapChildren (budgetMs) {
  const children = [...activeChildren]
  for (const child of children) { try { child.kill('SIGTERM') } catch (e) {} }
  const stragglers = []
  const deadline = Date.now() + budgetMs
  for (const child of children) {
    const left = deadline - Date.now()
    if (left <= 0 || !(await waitChildExit(child, left))) stragglers.push(child)
  }
  if (stragglers.length > 0) {
    console.error(`⚠️ ${stragglers.length} 个 worker 未在 ${budgetMs}ms 内退出，升级 SIGKILL 后继续收尾`)
    for (const child of stragglers) { try { child.kill('SIGKILL') } catch (e) {} }
    for (const child of stragglers) await waitChildExit(child, 2000)
  }
  activeChildren.clear()
  return stragglers.length
}

// 本次运行的残留扫描：只看自己的 RUN_ID 命名空间（并发调度器的 RUN_ID 不同，互不误伤）。
// 覆盖三类产物，注意**报告名不以名单前缀开头**：报告是 `.tmp_parallel_report_<RUN_ID>_<idx>.json`，
// 而名单前缀是 `.tmp_parallel_<RUN_ID>`（RUN_ID 以 pid 数字开头，报告名该位置是 `report_`），
// 只按名单前缀扫会把报告类残留整类漏掉——.gitignore 盖着、git status 看不见、也没有别的门禁扫它。
//   - 名单：`.tmp_parallel_<RUN_ID>_<idx>.json`（失败重跑为 `..._<idx>_r<n>.json`，C5-085）
//   - 报告：`.tmp_parallel_report_<RUN_ID>_<idx>.json`（同上，重跑多 `_r<n>`）
//   - 缓存：`xianbaoku_cache_p<RUN_ID>_<idx>`（同上，重跑多 `_r<n>`）
// 边界：只认本次 RUN_ID 前缀——扫不到上一个 RUN_ID 的历史遗留，也扫不到被 SIGKILL 杀死、
// 三条退出路径都没走成的进程。够不到的这两类只能靠人工清理。
function artifactPrefixes (runId) {
  return {
    list: `.tmp_parallel_${runId}`,
    report: `.tmp_parallel_report_${runId}`,
    cache: `xianbaoku_cache_p${runId}`
  }
}

function scanResidualArtifacts (opts = {}) {
  const root = opts.root || __dirname
  const prefixes = artifactPrefixes(opts.runId || RUN_ID)
  let names
  try {
    names = fs.readdirSync(root)
  } catch (e) {
    return { scanned: false, paths: [] } // 读不到仓库根：判不了，不能当成「干净」
  }
  const isOwn = (n) => n.startsWith(prefixes.list) || n.startsWith(prefixes.report) || n.startsWith(prefixes.cache)
  return {
    scanned: true,
    paths: names.filter(isOwn).map((n) => path.join(root, n))
  }
}

// 返回 true = 有残留（调用方据此把退出码判成失败）。
function reportResidualArtifacts (phase, opts = {}) {
  const r = scanResidualArtifacts(opts)
  const runId = opts.runId || RUN_ID
  if (!r.scanned) {
    console.error(`⚠️ ${phase}：无法扫描仓库根，残留判定不可用（RUN_ID=${runId}）`)
    return false
  }
  if (r.paths.length > 0) {
    console.error(`❌ ${phase}：本次运行（RUN_ID=${runId}）残留 ${r.paths.length} 个分片产物——被 .gitignore 盖住，git status 看不见：`)
    for (const p of r.paths) console.error(`   - ${path.basename(p)}`)
    console.error('   清理：rm -rf ' + r.paths.map((p) => `'${p}'`).join(' '))
    return true
  }
  return false
}

// 出口判定的唯一口径：失败片 / 执行计数对账 / 收尾残留，任一不满足即 1（fail-closed）。
// 三者在汇总里各占一行说明，这里只做布尔合成，避免「新增一类失败却忘了接进 exit code」。
function finalExitCode ({ failedWorkers, reconProblem, residualArtifacts }) {
  return failedWorkers.length === 0 && !reconProblem && !residualArtifacts ? 0 : 1
}

// ---------- 自测（C5-081 回归）：node test_app_p.js --selfcheck ----------
// 为什么落在本文件：残留判据/报告前缀就是这里的产品逻辑；放进 test_app.js 会改用例总数（173→174），
// 而单独 fork 全量套件只为验一条断言又太重。这里直接在夹具目录上跑**同一份**
// cleanupArtifacts/scanResidualArtifacts/finalExitCode，断言「清理失败 ⇒ 有残留 ⇒ exit 1」，
// 并用旧单前缀做负向自证（确认夹具真的复现了那个盲区，而不是碰巧命中）。
function runSelfCheck () {
  const assertSelf = (cond, msg) => { if (!cond) throw new Error(`自测失败：${msg}`) }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-u14-residual-'))
  try {
    const runId = '99999_1700000000000'
    const ids = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${runId}_${i}`)
    for (const id of ids) {
      fs.writeFileSync(path.join(base, `.tmp_parallel_${id}.json`), '[]')
      fs.writeFileSync(path.join(base, `.tmp_parallel_report_${id}.json`), '{"executed":1,"skipped":0}')
      fs.mkdirSync(path.join(base, `xianbaoku_cache_p${id}`))
    }
    // 重跑形态（C5-085）：workerId 末尾多一个 _r<n>
    const rerunId = `${ids[0]}_r1`
    fs.writeFileSync(path.join(base, `.tmp_parallel_${rerunId}.json`), '[]')
    fs.writeFileSync(path.join(base, `.tmp_parallel_report_${rerunId}.json`), '{"executed":1,"skipped":0}')
    fs.mkdirSync(path.join(base, `xianbaoku_cache_p${rerunId}`))
    // 诱饵：别的 RUN_ID 的同类产物，不得算到本次头上
    fs.writeFileSync(path.join(base, '.tmp_parallel_report_99999_1699999999999_0.json'), '{}')

    // 负向自证：旧口径（只按 `.tmp_parallel_<RUN_ID>` 单前缀）本来就匹配不到报告名
    const legacyHit = (n) => n.startsWith(`.tmp_parallel_${runId}`)
    assertSelf(!legacyHit(`.tmp_parallel_report_${runId}_0.json`), '旧单前缀竟能匹配报告名，夹具失去证明力')

    // ① 清理失败（unlink/rm 全抛）⇒ 残留必须被扫到，且点名 9 份报告（8 首轮 + 1 重跑）
    const boom = () => { throw new Error('EACCES: 注入的删除失败') }
    cleanupArtifacts({ root: base, ids, unlink: boom, rm: boom })
    const residual = scanResidualArtifacts({ root: base, runId })
    const names = residual.paths.map((p) => path.basename(p))
    assertSelf(residual.scanned, '夹具目录读不到')
    assertSelf(names.length === 27, `清理失败后应残留 27 个产物（8 名单+8 报告+8 缓存+重跑 3），实得 ${names.length}`)
    const reports = names.filter((n) => n.startsWith('.tmp_parallel_report_'))
    assertSelf(reports.length === 9, `报告类残留应为 9 份（8 首轮 + 1 重跑），实得 ${reports.length}`)
    assertSelf(reports.includes(`.tmp_parallel_report_${runId}_0.json`), '首轮报告未被扫到')
    assertSelf(reports.includes(`.tmp_parallel_report_${rerunId}.json`), '重跑报告（_r1）未被扫到')
    assertSelf(!names.some((n) => n.includes('1699999999999')), '别的 RUN_ID 的产物被误算成本次残留')
    assertSelf(reportResidualArtifacts('自测-清理失败', { root: base, runId }) === true, '残留回扫未返回 true')

    // ② 判定口径：同一批失败片/对账结果下，残留与否决定 exit 1 / 0
    assertSelf(finalExitCode({ failedWorkers: [], reconProblem: null, residualArtifacts: true }) === 1,
      '有残留必须 exit 1')
    assertSelf(finalExitCode({ failedWorkers: [], reconProblem: null, residualArtifacts: false }) === 0,
      '无残留且无失败必须 exit 0')

    // ③ 清理真成功 ⇒ 回扫干净 ⇒ exit 0（顺带证明夹具被清空，不留垃圾）
    // 这里必须把重跑 ID 一起交给清理，与线上 usedWorkerIds 覆盖「首轮 + 所有重跑」同口径。
    cleanupArtifacts({ root: base, ids: [...ids, rerunId] })
    assertSelf(scanResidualArtifacts({ root: base, runId }).paths.length === 0, '正常清理后仍有残留')
    console.log('✅ 自测通过：清理失败 ⇒ 27 个残留（含 9 份 .tmp_parallel_report_*.json）⇒ exit 1；清理成功 ⇒ 无残留 ⇒ exit 0')
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) { /* 夹具已随断言清空 */ }
  }
}

if (process.argv.includes('--selfcheck')) {
  try {
    runSelfCheck()
    process.exit(0)
  } catch (e) {
    console.error(e && e.message ? e.message : e)
    process.exit(1)
  }
}

// 被 Ctrl-C / 外部 kill 时同样收尾（SIGKILL 抓不到，不属本机制的覆盖范围）。
// 顺序：先等子进程回收，再删产物、再扫残留（理由见上）。
let shuttingDown = false
async function shutdownFromSignal (sig) {
  await reapChildren(REAP_TIMEOUT_MS)
  cleanupArtifacts()
  const residual = reportResidualArtifacts(`${sig} 收尾`)
  process.exit(residual ? 1 : (sig === 'SIGINT' ? 130 : 143))
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    if (shuttingDown) return // 二次信号不重入收尾（可能仍在等子进程退出）
    shuttingDown = true
    shutdownFromSignal(sig).catch(() => process.exit(1))
  })
}

console.log(`🧪 test_app 并行调度：${names.length} 个测试 → ${chunks.length} 片（并发 ${CONCURRENCY}，独立缓存目录）\n`);

// ---------- 4. 首轮并发 + 失败片串行重跑（flaky 容错） ----------
// 沙箱 overlayfs 高并发下偶发 IO 抖动（v3.122 同源）：首轮失败不直接判定，
// 该片串行完整重跑一次（无 QUICK）——偶发失败应转绿，真实失败仍红可定位
(async () => {
  const codes = await Promise.all(chunks.map((chunk, idx) => runChunk(chunk, idx, true)))
  // C5-081：信号收尾已接管时，这里不许再重跑/汇总/exit(0)——否则 Ctrl-C 之后仍会打印
  // 「全部通过 ✅」并以 0 退出，把收尾（等子进程回收 + 扫残留）盖掉。
  if (shuttingDown) return
  for (let i = 0; i < chunks.length; i++) {
    if (shuttingDown) return
    if (codes[i] !== 0) {
      console.log(`\n⚠️ worker#${i} 首轮失败，串行重跑完整验证（flaky 容错）...`)
      // attempt=1 ⇒ 全新的 workerId/缓存目录（C5-085）：不复用首轮那份可能还被上一轮进程占用、
      // 且已被写脏的目录。
      codes[i] = await runChunk(chunks[i], i, false, 1)
    }
  }

  cleanupArtifacts()
  // C5-081：删完立刻回扫——清理没成功（目录被占用/权限/子进程又落了盘）必须当场判失败，
  // 而不是留到下次有人手工数文件才发现。
  const residualArtifacts = reportResidualArtifacts('正常收尾')
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
  // C5-081：出口只由 finalExitCode 决定——残留与失败片/对账同权，不会被「全部通过」盖掉。
  const exitCode = finalExitCode({ failedWorkers, reconProblem, residualArtifacts })
  if (exitCode === 0) {
    console.log('  结果: 全部通过 ✅')
  } else {
    for (const w of failedWorkers) console.log(`  ✗ worker#${w.i} 重跑后仍失败（涉及 ${chunks[w.i].length} 个测试）`)
    if (reconProblem) {
      console.log(`  ✗ 执行计数对账失败（本次结果不可信）：${reconProblem}`)
    }
    if (residualArtifacts) {
      console.log('  ✗ 收尾残留：清单见上方 stderr（残留物被 .gitignore 盖住，git status 看不出来）')
    }
    console.log('  定位: node test_app.js --only=<测试名子串> 串行重跑（等号/空格两种写法均生效）')
  }
  process.exit(exitCode)
})().catch(async (e) => {
  console.error(e)
  // C5-081：异常退出同样先回收子进程，再删产物、再扫残留（顺序理由见 reapChildren 上方）。
  await reapChildren(REAP_TIMEOUT_MS)
  cleanupArtifacts()
  reportResidualArtifacts('异常收尾')
  process.exitCode = 1
})
