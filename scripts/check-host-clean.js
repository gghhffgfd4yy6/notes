// v3.283 主机干净度前置检查：把「机器脏了 ≠ 契约失败」变成显式门禁，而不是靠人记得清场。
//
// 为什么存在（v3.282 收尾实测归因）：`npm run check` 的一轮红被追到 `test_filter.js` 的
// `基准: tuisong_replace 1000次 < 300ms`——脏机器上实测 878ms，清场后同一断言 276ms 通过、
// 全链 49/49。脏的来源是**被 job_kill / timeout 从外面 SIGKILL 的上一轮运行留下的 detached 孤儿**：
// `test_ci_skip_suites.js` 的「挂死套件（带孙进程）」夹具每 20ms 写一次盘，而 F6 的整组杀伤只覆盖
// `run_unit_tests.js` 主动超时那条路径。另有一批 `/tmp/xbk-*` 沙箱因父进程被杀而没走到 finally 清理。
// 反证已做：另起 4 个 40s busy-loop 的纯 CPU 负载不复现（49s / 66s 全绿）⇒ 凶器是常驻写盘的孤儿，
// 不是平均负载。与其把「记得清场」写成纪律，不如让入口自己判。
//
// 误拦控制（三条，都是必须的）：
//   1. `XBK_MUTATION_CHILD=1`（stryker / run_mutation 的变异评估子进程）直接跳过——沙箱里跑全量套件时，
//      `/tmp` 下本来就有活动沙箱，按「脏」判会立刻假红。
//   2. 沙箱只认**过期**的：活跃时间距今 > STALE_MS（默认 30min）。活跃时间取「目录自身与它的直接
//      子项里最新的 mtime」，并且只要有一个活进程的 cwd 落在该沙箱里就直接放行——目录自身的 mtime
//      只在增删/改名条目时前进，长时间只改已有文件的沙箱会被误判成残留（review #211）。
//   3. 孤儿进程只认**已被 reparent 到 1**（ppid===1）或父进程已从进程表里消失者：两条终端并发正常
//      跑测试时，活动桩/子套件的父进程都还在，互不误伤；非 Linux（读不到 /proc）响亮标注「该平台不
//      检测」，绝不静默当成「已检查干净」。
//      返回「该平台不检测」并响亮说明，绝不静默当成「干净」。
//
// 用法：node scripts/check-host-clean.js [--selftest] [--stale-min N]
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const STALE_MS = 30 * 60 * 1000
// tmp 根取自 os.tmpdir()，不写死 '/tmp'：macOS/Android 上根本不是这个路径（写死会在那些宿主上
// 永远扫不到东西 = 静默失效），而 Sonar S5995 也把公共可写目录的字面量单独列为安全问题。
// 前缀与 run_mutation.js / test_ci_skip_suites.js 里 mkdtempSync(path.join(os.tmpdir(), 'xbk-…'))
// 的落点同源，两边改形态时这里跟着变即可。
const TMP_ROOT = os.tmpdir()
const SANDBOX_NAME_PREFIX = 'xbk-'
const SANDBOX_PREFIX = path.join(TMP_ROOT, SANDBOX_NAME_PREFIX)
const STUB_MARKERS = ['stub_heartbeat', 'test_stub_tree']
// 被外部 SIGKILL 打断的运行还会留下**孤儿套件进程**本身（被 reparent 到 1）——test_filter.js 一类
// 持续吃 CPU 并写缓存目录，同样拖红墙钟基准。本次排查就抓到过一个 job_kill 留下的 test_filter。
const SUITE_RE = /(?:^|[/\\])(?:run_tests|run_unit_tests|test_[A-Za-z0-9_]+)\.js$/

// 变异评估子进程 / 显式关闭：跳过（跳过必须响亮打印，见 main）
function shouldSkipCheck (env) {
  return env.XBK_MUTATION_CHILD === '1'
}

// 纯函数：哪些沙箱目录算「过期残留」。entries = [{p, mtimeMs}]，由调用方负责读取。
// ⚠️ mtimeMs 传入的必须是**活跃时间**（见 activityMtimeMs），不是目录自身的 mtime：目录 mtime 只在
// 增删/改名条目时前进，一个只往已有文件里追加写的长任务沙箱，目录 mtime 会停在创建那一刻。
function findStaleSandboxes (entries, nowMs, staleMs) {
  const limit = Number.isInteger(staleMs) && staleMs > 0 ? staleMs : STALE_MS
  return entries
    .filter((e) => typeof e.p === 'string' && e.p.startsWith(SANDBOX_PREFIX))
    .filter((e) => Number.isFinite(e.mtimeMs) && nowMs - e.mtimeMs > limit)
    .map((e) => ({ p: e.p, ageMin: Math.round((nowMs - e.mtimeMs) / 60000) }))
    .sort((a, b) => b.ageMin - a.ageMin)
}

// 沙箱的活跃时间 = 目录自身与它**直接子项**里最新的 mtime（lstat，不跟随符号链接）。
// 为什么不是只看目录自身：写已有文件只推进那个文件自己的 mtime，不推进父目录的（本机实测：
// 往 heartbeat.txt 追加一次，目录 mtime 一秒没动、文件 mtime +2s）。run_mutation 的变异沙箱、
// test_ci_skip_suites 的沙箱夹具都会在沙箱里建缓存目录再持续写，两级都看才不会把活动沙箱判成残留。
// 残余边界（如实登记）：写入落在孙辈及更深、且中途不在子项里增删条目时，这里仍会静止——
// 那种情形由 isActiveSandbox 的活进程 cwd 信号兜住。
function activityMtimeMs (dirPath) {
  let newest = Number.NaN
  const consider = (p) => {
    let st
    try {
      st = fs.lstatSync(p) // lstat 而非 stat：公共可写目录里的同名条目可以是指向别处的符号链接
    } catch {
      return // 读不到就不参与判定（宁可漏报也不误删）
    }
    if (!Number.isFinite(st.mtimeMs)) return
    // 初值是 NaN：NaN 参与任何比较都是 false，必须先用 !isFinite 开这个头，否则 newest 永远是 NaN
    if (!Number.isFinite(newest) || st.mtimeMs > newest) newest = st.mtimeMs
  }
  consider(dirPath)
  let names
  try {
    names = fs.readdirSync(dirPath)
  } catch {
    return newest // 子项读不到：只用自身时间，不因读不到就判脏
  }
  for (const n of names) consider(path.join(dirPath, n))
  return newest
}

// 活进程占用的 cwd 集合（/proc/<pid>/cwd 的符号链接目标）。读不到 /proc ⇒ null = 该平台不提供
// 这个信号（由调用方按「不可判定」处理，禁止继续生成沙箱删除候选）。
function liveSandboxCwds (procRoot, onReadError) {
  let pids
  try {
    pids = fs.readdirSync(procRoot).filter((s) => /^\d+$/.test(s))
  } catch {
    return null
  }
  const cwds = []
  for (const pid of pids) {
    const procPath = path.join(procRoot, pid)
    try {
      cwds.push(fs.readlinkSync(path.join(procPath, 'cwd')))
    } catch (e) {
      const details = {
        pid: Number(pid),
        errorCode: e && e.code ? e.code : 'UNKNOWN',
        procDirExists: null,
        uid: null,
        state: null,
        statErrorCode: null
      }
      try {
        const st = fs.statSync(procPath)
        details.procDirExists = true
        details.uid = st.uid
        details.state = procStateOf(path.join(procPath, 'stat'))
      } catch (pidError) {
        if (pidError && (pidError.code === 'ENOENT' || pidError.code === 'ESRCH')) continue
        details.statErrorCode = pidError && pidError.code ? pidError.code : 'UNKNOWN'
      }
      Object.assign(details, procStatusDetails(procPath))
      if (typeof onReadError === 'function') onReadError(details)
      return null
    }
  }
  return cwds
}

// 纯函数：沙箱是否被某个活进程当作 cwd（run_mutation.js:400 的 spawn({cwd: dir}) 正是这个形态）。
// 前缀判定按路径分段，避免 /tmp/xbk-a 命中 /tmp/xbk-ab（那是另一个沙箱）。
function isActiveSandbox (dirPath, cwds) {
  if (!Array.isArray(cwds) || cwds.length === 0) return false
  let canonicalDir
  try {
    canonicalDir = fs.realpathSync(dirPath)
  } catch {
    return true // 无法规范化候选目录时，不生成可能误删的建议
  }
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep
  return cwds.some((c) => {
    if (typeof c !== 'string') return false
    // Linux /proc 已解析 cwd 符号链接；resolve 也使注入的相对测试路径有确定口径。
    const activePath = path.resolve(c)
    return activePath === canonicalDir || activePath.startsWith(prefix)
  })
}

// 纯函数：从 /proc/<pid>/cmdline 文本里挑出孤儿桩。selfPid 与 ancestors 排除在外。
// 孤儿判据（review #211，与 findOrphanSuites 同口径）：桩的特征只说明「它是个测试夹具」，不说明它
// 是**残留**。父进程还活着的桩属于正在跑的某次运行（另一条终端此刻在跑 test_ci_skip_suites.js 就是
// 这种），把它报成孤儿会让第二个运行拒绝启动——头注第 3 条「两条终端并发互不误伤」正是被这个漏掉
// 的判据破坏的。真孤儿的症状是父进程已经没了：被 reparent 到 1，或 ppid 指向一个已消失的 pid。
// ppid<=0（stat 读不到）不参与判定，与 readProcs 里「进程刚退出/无权限：不参与判定」同口径。
function findOrphanStubs (procs, selfPid, ancestors) {
  const skip = new Set([String(selfPid)].concat((ancestors || []).map(String)))
  const livePids = new Set((procs || []).filter((x) => x).map((x) => String(x.pid)))
  return (procs || [])
    .filter((x) => x && !skip.has(String(x.pid)))
    .filter((x) => STUB_MARKERS.some((m) => String(x.cmdline || '').includes(m)))
    .filter((x) => {
      const ppid = Number(x.ppid)
      if (!(ppid > 0)) return false
      return ppid === 1 || !livePids.has(String(ppid))
    })
    .map((x) => ({ pid: Number(x.pid), cmdline: pretty(x.cmdline) }))
}

// 读 /proc：非 Linux（macOS 等）抛 ENOENT → 返回 null，由上层响亮标注「该平台不检测」。
function readProcs (procRoot) {
  try {
    const pids = fs.readdirSync(procRoot).filter((s) => /^\d+$/.test(s))
    return pids.map((pid) => {
      try {
        return {
          pid: Number(pid),
          cmdline: fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8'),
          ppid: ppidOf(path.join(procRoot, pid, 'stat'))
        }
      } catch {
        return { pid: Number(pid), cmdline: '', ppid: -1 } // 进程刚退出/无权限：不参与判定
      }
    })
  } catch {
    return null
  }
}

// comm 字段可能含空格与括号：切到最后一个 ')' 之后再取 ppid（第 2 个字段）
function procStateOf (statPath) {
  let stat
  try {
    stat = fs.readFileSync(statPath, 'utf8')
  } catch {
    return null
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  return /^[A-Z]$/.test(state) ? state : null
}

function procStatusDetails (procPath) {
  let status
  try {
    status = fs.readFileSync(path.join(procPath, 'status'), 'utf8')
  } catch (e) {
    return { statusUids: null, kthread: null, statusErrorCode: e && e.code ? e.code : 'UNKNOWN' }
  }
  const uidMatch = status.match(/^Uid:\s+([\d\s]+)/m)
  const kthreadMatch = status.match(/^Kthread:\s+([01])\s*$/m)
  return {
    statusUids: uidMatch ? uidMatch[1].trim().split(/\s+/).map(Number) : null,
    kthread: kthreadMatch ? kthreadMatch[1] === '1' : null,
    statusErrorCode: null
  }
}

function ppidOf (statPath) {
  let stat
  try {
    stat = fs.readFileSync(statPath, 'utf8')
  } catch {
    return -1
  }
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  return Number.isFinite(ppid) ? ppid : -1
}

function pretty (cmdline) {
  return String(cmdline || '').replace(/\0+/g, ' ').trim()
}

function shellQuote (value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function rmSuggestion (dirs) {
  return 'rm -rf ' + dirs.map((d) => shellQuote(path.resolve(d.p))).join(' ')
}

// cmdline 是 NUL 分隔的 argv：测试脚本可能是相对路径、绝对路径，也可能后面带 --only 等参数，
// 因此不能只看最后一个 argv。
function hasSuiteArg (cmdline) {
  return String(cmdline || '').split('\0').filter(Boolean).some((arg) => SUITE_RE.test(arg))
}

// 纯函数：孤儿套件进程 = 命中本仓测试入口/套件，且父进程已消失。selfPid 与 ancestors 排除在外。
function findOrphanSuites (procs, selfPid, ancestors) {
  const skip = new Set([String(selfPid)].concat((ancestors || []).map(String)))
  const livePids = new Set((procs || []).filter((x) => x).map((x) => String(x.pid)))
  return (procs || [])
    .filter((x) => x && !skip.has(String(x.pid)))
    .filter((x) => hasSuiteArg(x.cmdline))
    .filter((x) => {
      const ppid = Number(x.ppid)
      if (!(ppid > 0)) return false
      return ppid === 1 || !livePids.has(String(ppid))
    })
    .map((x) => ({ pid: Number(x.pid), cmdline: pretty(x.cmdline) }))
}

// 祖先链（自下而上读 /proc/<pid>/stat 的第 4 字段 ppid），用于排除「自己人」。
function ancestorPids (procRoot, pid) {
  const chain = []
  let cur = Number(pid)
  for (let i = 0; i < 32 && Number.isFinite(cur) && cur > 1; i++) {
    let stat
    try {
      stat = fs.readFileSync(path.join(procRoot, String(cur), 'stat'), 'utf8')
    } catch {
      break
    }
    // comm 字段可能含空格与括号，先切掉最后一个 ')' 之后的部分再取 ppid
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(rest[1])
    if (!Number.isFinite(ppid) || ppid <= 0 || chain.includes(String(ppid))) break
    chain.push(String(ppid))
    cur = ppid
  }
  return chain
}

function listStaleSandboxDirs (tmpRoot, nowMs, staleMs, cwds) {
  let names
  try {
    names = fs.readdirSync(tmpRoot)
  } catch {
    return null // 扫描面不可判定：调用方必须 fail-closed，不能把空结果当成干净
  }
  // 先按名称过滤候选，避免无关的大目录进入 activityMtimeMs；随后只接受真实目录，避免把普通文件或
  // 符号链接列入后续 rm -rf 建议。任何把该沙箱当 cwd 的活进程都直接豁免——残留判红会打印清理命令，
  // 误判活动沙箱等于劝人删掉正在跑的运行。
  const entries = names
    .filter((n) => n.startsWith(SANDBOX_NAME_PREFIX))
    .map((n) => {
      const p = path.join(tmpRoot, n)
      try {
        const st = fs.lstatSync(p)
        return st.isDirectory() && !st.isSymbolicLink() ? { p, mtimeMs: activityMtimeMs(p) } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return findStaleSandboxes(entries, nowMs, staleMs).filter((d) => !isActiveSandbox(d.p, cwds))
}

// 汇总判定：{ skipped, unsupported, cwdScanError, tmpScanError, stubs, dirs, ok }
function inspect (opts) {
  const env = opts.env || {}
  if (shouldSkipCheck(env)) return { skipped: true, reason: 'XBK_MUTATION_CHILD=1（变异评估沙箱内）', ok: true, cwdScanError: false, tmpScanError: false, stubs: [], suites: [], dirs: [] }
  const procRoot = opts.procRoot || '/proc'
  const tmpRoot = opts.tmpRoot || TMP_ROOT
  const nowMs = opts.nowMs || Date.now()
  const staleMs = opts.staleMs
  const procs = readProcs(procRoot)
  const selfPid = opts.selfPid || process.pid
  const unsupported = procs === null
  const anc = unsupported ? [] : ancestorPids(procRoot, selfPid)
  const stubs = unsupported ? [] : findOrphanStubs(procs, selfPid, anc)
  const suites = unsupported ? [] : findOrphanSuites(procs, selfPid, anc)
  // 先筛出过期候选：没有候选就不会输出删除建议，无需读取所有进程 cwd。
  const candidates = listStaleSandboxDirs(tmpRoot, nowMs, staleMs, [])
  const tmpScanError = candidates === null
  let cwdScanError = false
  let cwdScanErrorDetails = null
  const dirs = []
  // 有候选时，cwd 是删除建议的安全豁免信号；不可判定则 fail-closed，不输出任何候选。
  if (!tmpScanError && candidates.length > 0) {
    const cwds = unsupported ? null : liveSandboxCwds(procRoot, (details) => { cwdScanErrorDetails = details })
    cwdScanError = cwds === null
    if (!cwdScanError) dirs.push(...candidates.filter((d) => !isActiveSandbox(d.p, cwds)))
  }
  return {
    skipped: false,
    unsupported,
    cwdScanError,
    cwdScanErrorDetails,
    tmpScanError,
    stubs,
    suites,
    dirs,
    ok: !unsupported && !cwdScanError && !tmpScanError && stubs.length === 0 && suites.length === 0 && dirs.length === 0
  }
}

function selftest () {
  const assert = require('node:assert')
  const now = 1e12
  // —— 过期判定：只认 /tmp/xbk-* 且超过阈值
  const staleDir = path.join(TMP_ROOT, 'xbk-run-tests-a')
  assert.deepStrictEqual(findStaleSandboxes([{ p: staleDir, mtimeMs: now - 31 * 60000 }], now, undefined),
    [{ p: staleDir, ageMin: 31 }], '31 分钟的沙箱必须被点名（含年龄）')
  assert.deepStrictEqual(findStaleSandboxes([{ p: path.join(TMP_ROOT, 'xbk-run-tests-a'), mtimeMs: now - 60000 }], now, undefined), [],
    '1 分钟内的活动沙箱不得误报')
  assert.deepStrictEqual(findStaleSandboxes([{ p: path.join(TMP_ROOT, 'zz-not-xbk'), mtimeMs: now }], now, undefined), [], '非 xbk 前缀不参与判定')
  assert.deepStrictEqual(findStaleSandboxes([{ p: path.join(TMP_ROOT, 'xbk-x'), mtimeMs: Number.NaN }], now, undefined), [], 'stat 拿不到时间不判脏')
  assert.deepStrictEqual(findStaleSandboxes([{ p: path.join(TMP_ROOT, 'xbk-y'), mtimeMs: now - 20 * 60000 }], now, 10 * 60000).length, 1,
    'staleMs 可覆盖（20min > 10min 阈值）')
  // —— 孤儿桩识别：命中特征 **且父进程已没** 才算孤儿；排除自己与祖先
  const procs = [
    { pid: 100, ppid: 1, cmdline: 'node\u0000/tmp/xbk-run-tests-q/test_stub_tree.js\u0000' },
    { pid: 101, ppid: 1, cmdline: 'node\u0000/tmp/xbk-run-tests-q/stub_heartbeat.js\u0000' },
    { pid: 102, ppid: 1, cmdline: 'node\u0000./run_unit_tests.js\u0000' },
    { pid: 103, ppid: 1, cmdline: '' },
    // 另一次**正在跑**的运行里的活动桩：父进程还活着（200 在进程表里）⇒ 不得报成孤儿
    { pid: 200, ppid: 60, cmdline: 'node\u0000/root/x/test_ci_skip_suites.js\u0000' },
    { pid: 201, ppid: 200, cmdline: 'node\u0000/tmp/xbk-run-tests-live/test_stub_tree.js\u0000' },
    // 父进程已从进程表消失（被外部 SIGKILL、尚未 reparent 到的窗口）⇒ 同样是残留
    { pid: 301, ppid: 999, cmdline: 'node\u0000/tmp/xbk-run-tests-dead/stub_heartbeat.js\u0000' }
  ]
  const stubs = findOrphanStubs(procs, 102, ['1', '50'])
  assert.deepStrictEqual(stubs.map((s) => s.pid), [100, 101, 301],
    'reparent 到 1 的桩与父进程已消失的桩必须被抓到；活动运行的桩（201，父进程 200 仍在表里）不得被抓')
  assert.match(stubs[0].cmdline, /test_stub_tree\.js/, 'cmdline 里的 NUL 必须换成空格，便于直接打印')
  assert.deepStrictEqual(findOrphanStubs(procs, 100, ['100']).map((s) => s.pid), [101, 301], '自己与祖先链上的 PID 必须排除')
  assert.deepStrictEqual(findOrphanStubs([], 1, []), [], '空进程表不崩')
  // ppid<=0（/proc/<pid>/stat 读不到）不参与判定，与 readProcs 的「无权限/刚退出」口径一致
  assert.deepStrictEqual(findOrphanStubs([{ pid: 400, ppid: -1, cmdline: 'node\u0000x/stub_heartbeat.js' }], 1, []), [],
    'ppid 读不到时不判孤儿（宁可漏报也不误拦两条并发运行）')
  // —— 孤儿套件：脚本参数可为相对/绝对路径，后面可带 --only；父进程消失也算孤儿
  const ps = [
    { pid: 50, ppid: 1, cmdline: 'node\u0000/usr/local/bin/helper.js\u0000' },
    { pid: 200, ppid: 1, cmdline: 'node\u0000/root/x/test_filter.js\u0000' },
    { pid: 201, ppid: 50, cmdline: 'node\u0000/root/x/test_filter.js\u0000' },
    { pid: 202, ppid: 1, cmdline: 'node\u0000/root/x/run_unit_tests.js\u0000' },
    { pid: 203, ppid: 1, cmdline: 'node\u0000/usr/local/bin/dsh web\u0000' },
    { pid: 204, ppid: 999, cmdline: 'node\u0000test_filter.js\u0000' },
    { pid: 205, ppid: 999, cmdline: 'node\u0000/tmp/test_app.js\u0000--only=foo\u0000' }
  ]
  assert.deepStrictEqual(findOrphanSuites(ps, 999, []).map((x) => x.pid), [200, 202, 204, 205],
    'reparent 到 1、父进程已消失、相对脚本路径和带参数的测试进程都必须被抓到；活动运行的 201 与非测试进程 203 不得误伤')
  assert.deepStrictEqual(findOrphanSuites(ps, 200, []).map((x) => x.pid), [202, 204, 205], '自己的 PID 必须排除')
  assert.deepStrictEqual(findOrphanSuites([], 1, []), [])
  // —— 跳过与平台不支持
  assert.strictEqual(shouldSkipCheck({ XBK_MUTATION_CHILD: '1' }), true, '变异评估子进程必须跳过（否则沙箱内活动沙箱→假红）')
  assert.strictEqual(shouldSkipCheck({}), false)
  const missing = inspect({ env: {}, procRoot: path.join(TMP_ROOT, 'definitely-not-here'), tmpRoot: path.join(TMP_ROOT, 'definitely-not-here'), nowMs: now, selfPid: 1 })
  assert.strictEqual(missing.unsupported, true, '读不到 /proc 必须标为「该平台不检测」，不得当成已检查')
  assert.strictEqual(missing.cwdScanError, true, '读不到 /proc 必须标记 cwd 保护信号不可判定')
  assert.deepStrictEqual(missing.dirs, [], 'cwd 保护信号不可判定时不得生成沙箱删除候选')
  assert.strictEqual(missing.ok, false, '读不到临时根或 cwd 保护信号时不得把空结果当成主机干净')
  assert.strictEqual(missing.skipped, false)
  const skipped = inspect({ env: { XBK_MUTATION_CHILD: '1' }, procRoot: '/proc', tmpRoot: TMP_ROOT, selfPid: 1 })
  assert.strictEqual(skipped.skipped, true)
  assert.strictEqual(skipped.ok, true)
  // —— 真脏：用临时 tmp 造一个过期目录
  const os = require('os')
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-hostclean-selftest-'))
  try {
    const old = path.join(fake, 'xbk-run-tests-old')
    fs.mkdirSync(old)
    const past = new Date((now - 60 * 60000) / 1000)
    fs.utimesSync(old, past, past)
    const r = inspect({ env: {}, procRoot: fake, tmpRoot: fake, nowMs: now, selfPid: 1 })
    assert.ok(r.dirs.some((d) => d.p.endsWith('xbk-run-tests-old')), '过期沙箱必须出现在结果里')
    assert.strictEqual(r.ok, false, '有过期沙箱即判不干净')
    // 只有真实目录才是沙箱：同名前缀的普通文件不得进入 rm -rf 建议清单。
    const staleFile = path.join(fake, 'xbk-run-tests-file')
    fs.writeFileSync(staleFile, 'not a sandbox\n')
    fs.utimesSync(staleFile, past, past)
    const withFile = inspect({ env: {}, procRoot: fake, tmpRoot: fake, nowMs: now, selfPid: 1 })
    assert.ok(!withFile.dirs.some((d) => d.p.endsWith('xbk-run-tests-file')), '普通文件不得被当成过期沙箱')
    // 临时根扫描失败必须独立 fail-closed；这里让 procRoot 可读，避免把 /proc 不支持与 tmp 错误混在一起。
    const tmpScanError = inspect({ env: {}, procRoot: fake, tmpRoot: path.join(fake, 'missing-tmp-root'), nowMs: now, selfPid: 1 })
    assert.strictEqual(tmpScanError.tmpScanError, true, '临时根不可读必须留下扫描失败标记')
    assert.strictEqual(tmpScanError.ok, false, '临时根扫描失败不得报告主机干净')
    // —— 活动沙箱不得误报①：目录自身 mtime 停在 60min 前，但里面有一个刚写过的文件
    //    （目录 mtime 不随子文件写入前进——这是本门禁原先的误判方向）
    const active = path.join(fake, 'xbk-mutant-active')
    fs.mkdirSync(active)
    fs.writeFileSync(path.join(active, 'heartbeat.log'), 'tick\n')
    fs.utimesSync(active, past, past)
    assert.ok(activityMtimeMs(active) > now - 30 * 60000,
      '直接子项的 mtime 必须算进活跃时间（只看目录自身会把活动沙箱判成残留）')
    assert.ok(!inspect({ env: {}, procRoot: fake, tmpRoot: fake, nowMs: now, selfPid: 1 }).dirs
      .some((d) => d.p.endsWith('xbk-mutant-active')), '只写已有文件的沙箱不得被判过期')
    // —— 活动沙箱不得误报②：某活进程把它当 cwd（run_mutation 的 spawn({cwd: dir}) 形态）
    const held = path.join(fake, 'xbk-mutant-held')
    fs.mkdirSync(held)
    fs.utimesSync(held, past, past)
    fs.mkdirSync(path.join(fake, '4242'), { recursive: true })
    fs.symlinkSync(held, path.join(fake, '4242', 'cwd'))
    assert.ok(isActiveSandbox(held, liveSandboxCwds(fake)), 'cwd 落在沙箱里 = 该沙箱正在被使用')
    assert.ok(!inspect({ env: {}, procRoot: fake, tmpRoot: fake, nowMs: now, selfPid: 1 }).dirs
      .some((d) => d.p.endsWith('xbk-mutant-held')), '被活进程占用的沙箱不得进 rm -rf 建议清单')
    // 前缀相似不得误豁免：/tmp/xbk-a 的保护信号不能顺带放过 /tmp/xbk-ab
    assert.strictEqual(isActiveSandbox(path.join(fake, 'xbk-mutant-held'), [path.join(fake, 'xbk-mutant-held-other')]), false,
      'cwd 前缀判定必须按路径分段，不能靠字符串前缀放行兄弟目录')
    assert.strictEqual(isActiveSandbox(path.join(fake, 'xbk-mutant-held'), []), false, '无 cwd 信号时不豁免')
  } finally {
    fs.rmSync(fake, { recursive: true, force: true })
  }
  console.log('✅ check-host-clean --selftest 全部通过（34 断言）')
}

function cwdScanFailureText (details) {
  if (!details) return ''
  const procDir = details.procDirExists === true ? 'present' : 'unknown'
  const uids = Array.isArray(details.statusUids) ? details.statusUids.join('/') : 'unknown'
  const kthread = details.kthread === null ? 'unknown' : String(details.kthread)
  const statError = details.statErrorCode || 'none'
  const statusError = details.statusErrorCode || 'none'
  return `（pid=${details.pid} errno=${details.errorCode} procDir=${procDir} state=${details.state || 'unknown'} uid=${details.uid ?? 'unknown'} statusUid=${uids} kthread=${kthread} statErr=${statError} statusErr=${statusError}）`
}

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    selftest()
    return 0
  }
  const i = argv.indexOf('--stale-min')
  const staleMin = i >= 0 ? Number(argv[i + 1]) : undefined
  if (i >= 0 && (!Number.isFinite(staleMin) || staleMin <= 0)) {
    console.log('❌ --stale-min 必须是正数分钟，实得 ' + JSON.stringify(argv[i + 1]))
    return 1
  }
  const r = inspect({ staleMs: Number.isFinite(staleMin) ? Math.round(staleMin * 60000) : undefined })
  if (r.skipped) {
    console.log('⏭ 主机干净度检查跳过：' + r.reason)
    return 0
  }
  if (r.unsupported) {
    console.log('⚠️ 读不到 /proc，本机不做孤儿桩检测；若存在过期沙箱候选，则 cwd 豁免不可判定并按 fail-closed 拒绝继续')
  }
  if (r.cwdScanError) {
    console.log('❌ 活动沙箱 cwd 扫描失败，无法安全排除正在运行的沙箱（按 fail-closed 拒绝继续）' + cwdScanFailureText(r.cwdScanErrorDetails))
  }
  if (r.tmpScanError) {
    console.log('❌ 临时根目录扫描失败，无法判定过期沙箱（按 fail-closed 拒绝继续）')
  }
  if (r.ok && !r.unsupported) {
    console.log('✅ 主机干净：无孤儿测试桩 / 孤儿套件进程、无过期 ' + SANDBOX_PREFIX + '* 沙箱')
    return 0
  }
  if (!r.ok) {
    console.log('❌ 主机不干净——墙钟基准会被这些残留拖红（实测可让 300ms 基准跑到 878ms）')
    if (r.stubs.length) {
      console.log('  孤儿测试桩 ' + r.stubs.length + ' 个：')
      for (const s of r.stubs.slice(0, 6)) console.log('    pid ' + s.pid + '  ' + s.cmdline.slice(0, 120))
      console.log('    清理：kill -TERM ' + r.stubs.map((s) => s.pid).join(' ') + '  然后再 kill -KILL')
    }
    if (r.suites.length) {
      console.log('  孤儿套件进程 ' + r.suites.length + ' 个（父进程已被 reparent 到 1 或已从进程表消失）：')
      for (const x of r.suites.slice(0, 6)) console.log('    pid ' + x.pid + '  ' + x.cmdline.slice(0, 120))
      console.log('    清理：kill -TERM ' + r.suites.map((x) => x.pid).join(' ') + '  然后再 kill -KILL')
    }
    if (r.dirs.length) {
      console.log('  过期沙箱 ' + r.dirs.length + ' 个：')
      for (const d of r.dirs.slice(0, 6)) console.log('    ' + d.p + '（' + d.ageMin + ' 分钟前）')
      console.log('    清理：' + rmSuggestion(r.dirs))
    }
    console.log('  为什么判红：v3.282 一轮 48/49 的红就是被这类残留拖出来的（详见 scripts/check-host-clean.js 头注）。')
    console.log('  在变异评估子进程里本检查自动跳过；沙箱只认过期（默认 >30min，可用 --stale-min 调）。')
    return 1
  }
  return 0
}

// 供 run_tests.js / run_unit_tests.js 入口调用：返回 true 表示应当中止本次运行
function guardOrExit (env) {
  const r = inspect({ env: env || process.env })
  if (r.skipped) return false
  if (r.unsupported) {
    console.log('⚠️ 主机干净度检查：读不到 /proc，无法判定孤儿桩；若有过期沙箱候选，则 cwd 豁免不可判定并按 fail-closed 拒绝继续')
  }
  if (r.cwdScanError) console.log('   活动沙箱 cwd 扫描失败，无法安全排除正在运行的沙箱（fail-closed）' + cwdScanFailureText(r.cwdScanErrorDetails))
  if (r.tmpScanError) console.log('   临时根目录扫描失败，无法判定过期沙箱（fail-closed）')
  if (r.ok) return false
  console.log('❌ 主机不干净，本次运行不启动（避免把环境残留报成契约失败）：')
  for (const x of r.stubs) console.log('   孤儿桩 pid ' + x.pid + '  ' + x.cmdline.slice(0, 120))
  for (const x of r.suites) console.log('   孤儿套件 pid ' + x.pid + '  ' + x.cmdline.slice(0, 120))
  for (const d of r.dirs) console.log('   过期沙箱 ' + d.p + '（' + d.ageMin + ' 分钟前）')
  const pids = r.stubs.concat(r.suites).map((x) => x.pid)
  if (pids.length) console.log('   清理：kill -TERM ' + pids.join(' ') + ' && sleep 1 && kill -KILL ' + pids.join(' '))
  if (r.dirs.length) console.log('   清理：' + rmSuggestion(r.dirs))
  return true
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { STALE_MS, TMP_ROOT, shouldSkipCheck, findStaleSandboxes, findOrphanStubs, findOrphanSuites, ancestorPids, activityMtimeMs, liveSandboxCwds, isActiveSandbox, shellQuote, rmSuggestion, inspect, guardOrExit }
