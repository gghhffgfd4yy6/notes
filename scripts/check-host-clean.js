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
//   2. 沙箱只认**过期**的：mtime 距今 > STALE_MS（默认 30min）。并发在跑的活动沙箱会被持续写，不会误报。
//   3. 孤儿进程只认**已被 reparent 到 1**（ppid===1）或命中夹具特征者：两条终端并发正常跑测试时，
//      子套件的父进程不是 1，互不误伤；非 Linux（读不到 /proc）响亮标注「该平台不检测」，绝不静默当成「已检查干净」。
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
const SANDBOX_PREFIX = path.join(TMP_ROOT, 'xbk-')
const STUB_MARKERS = ['stub_heartbeat', 'test_stub_tree']
// 被外部 SIGKILL 打断的运行还会留下**孤儿套件进程**本身（被 reparent 到 1）——test_filter.js 一类
// 持续吃 CPU 并写缓存目录，同样拖红墙钟基准。本次排查就抓到过一个 job_kill 留下的 test_filter。
const SUITE_RE = /\/(?:run_tests|run_unit_tests|test_[A-Za-z0-9_]+)\.js$/

// 变异评估子进程 / 显式关闭：跳过（跳过必须响亮打印，见 main）
function shouldSkipCheck (env) {
  return env.XBK_MUTATION_CHILD === '1'
}

// 纯函数：哪些沙箱目录算「过期残留」。entries = [{p, mtimeMs}]，由调用方负责读取。
function findStaleSandboxes (entries, nowMs, staleMs) {
  const limit = Number.isInteger(staleMs) && staleMs > 0 ? staleMs : STALE_MS
  return entries
    .filter((e) => typeof e.p === 'string' && e.p.startsWith(SANDBOX_PREFIX))
    .filter((e) => Number.isFinite(e.mtimeMs) && nowMs - e.mtimeMs > limit)
    .map((e) => ({ p: e.p, ageMin: Math.round((nowMs - e.mtimeMs) / 60000) }))
    .sort((a, b) => b.ageMin - a.ageMin)
}

// 纯函数：从 /proc/<pid>/cmdline 文本里挑出孤儿桩。selfPid 与 ancestors 排除在外。
function findOrphanStubs (procs, selfPid, ancestors) {
  const skip = new Set([String(selfPid)].concat((ancestors || []).map(String)))
  return (procs || [])
    .filter((x) => x && !skip.has(String(x.pid)))
    .filter((x) => STUB_MARKERS.some((m) => String(x.cmdline || '').includes(m)))
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

// cmdline 是 NUL 分隔的 argv：取最后一个非空段（真正被执行的脚本路径）
function lastArg (cmdline) {
  const parts = String(cmdline || '').split('\0').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

// 纯函数：孤儿套件进程 = cmdline 以本仓测试入口/套件结尾，且已被 reparent（ppid===1）。
// 「ppid===1」是关键判据：正在被 run_tests 驱动的子套件父进程不是 1，两条终端并发跑测试
// 互不误伤；只有父进程被外部 SIGKILL 之后留下的才是这里要拦的。
function findOrphanSuites (procs, selfPid, ancestors) {
  const skip = new Set([String(selfPid)].concat((ancestors || []).map(String)))
  return (procs || [])
    .filter((x) => x && Number(x.ppid) === 1 && !skip.has(String(x.pid)))
    .filter((x) => SUITE_RE.test(lastArg(x.cmdline)))
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

function listStaleSandboxDirs (tmpRoot, nowMs, staleMs) {
  let names
  try {
    names = fs.readdirSync(tmpRoot)
  } catch {
    return [] // 读不到 /tmp：不判脏也不谎报干净，由 main 的 scanned 标志体现
  }
  const base = tmpRoot.endsWith('/') ? '' : '/'
  const entries = names.map((n) => {
    const p = tmpRoot + base + n
    let mtimeMs = NaN
    try {
      // lstatSync 而非 statSync：公共可写目录里的同名条目可以是指向别处的符号链接，跟随它等于
      // 把判定建立在别人控制的 inode 上；这里只需要「这个名字存在吗、什么时候动的」。
      mtimeMs = fs.lstatSync(p).mtimeMs
    } catch {
      mtimeMs = NaN
    }
    return { p, mtimeMs }
  })
  return findStaleSandboxes(entries, nowMs, staleMs)
}

// 汇总判定：{ skipped, unsupported, stubs, dirs, ok }
function inspect (opts) {
  const env = opts.env || {}
  if (shouldSkipCheck(env)) return { skipped: true, reason: 'XBK_MUTATION_CHILD=1（变异评估沙箱内）', ok: true, stubs: [], suites: [], dirs: [] }
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
  const dirs = listStaleSandboxDirs(tmpRoot, nowMs, staleMs)
  return { skipped: false, unsupported, stubs, suites, dirs, ok: stubs.length === 0 && suites.length === 0 && dirs.length === 0 }
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
  assert.deepStrictEqual(findStaleSandboxes([{ p: path.join(TMP_ROOT, 'xbk-x'), mtimeMs: NaN }], now, undefined), [], 'stat 拿不到时间不判脏')
  assert.deepStrictEqual(findStaleSandboxes([{ p: path.join(TMP_ROOT, 'xbk-y'), mtimeMs: now - 20 * 60000 }], now, 10 * 60000).length, 1,
    'staleMs 可覆盖（20min > 10min 阈值）')
  // —— 孤儿桩识别：命中特征、排除自己与祖先
  const procs = [
    { pid: 100, cmdline: 'node\u0000/tmp/xbk-run-tests-q/test_stub_tree.js\u0000' },
    { pid: 101, cmdline: 'node\u0000/tmp/xbk-run-tests-q/stub_heartbeat.js\u0000' },
    { pid: 102, cmdline: 'node\u0000./run_unit_tests.js\u0000' },
    { pid: 103, cmdline: '' }
  ]
  const stubs = findOrphanStubs(procs, 102, ['1', '50'])
  assert.deepStrictEqual(stubs.map((s) => s.pid), [100, 101], '两个桩都必须被抓到，正常命令与空 cmdline 不得被抓')
  assert.match(stubs[0].cmdline, /test_stub_tree\.js/, 'cmdline 里的 NUL 必须换成空格，便于直接打印')
  assert.deepStrictEqual(findOrphanStubs(procs, 100, ['100']).map((s) => s.pid), [101], '自己与祖先链上的 PID 必须排除')
  assert.deepStrictEqual(findOrphanStubs([], 1, []), [], '空进程表不崩')
  // —— 孤儿套件：只认 ppid===1 的测试进程；活动子进程与非测试进程都不误伤
  const ps = [
    { pid: 200, ppid: 1, cmdline: 'node\u0000/root/x/test_filter.js\u0000' },
    { pid: 201, ppid: 55, cmdline: 'node\u0000/root/x/test_filter.js\u0000' },
    { pid: 202, ppid: 1, cmdline: 'node\u0000/root/x/run_unit_tests.js\u0000' },
    { pid: 203, ppid: 1, cmdline: 'node\u0000/usr/local/bin/dsh web\u0000' }
  ]
  assert.deepStrictEqual(findOrphanSuites(ps, 999, []).map((x) => x.pid), [200, 202],
    '被 reparent 到 1 的测试进程算孤儿；父进程还在的（201）与非测试进程（203）都不算')
  assert.deepStrictEqual(findOrphanSuites(ps, 200, []).map((x) => x.pid), [202], '自己的 PID 必须排除')
  assert.deepStrictEqual(findOrphanSuites([], 1, []), [])
  // —— 跳过与平台不支持
  assert.strictEqual(shouldSkipCheck({ XBK_MUTATION_CHILD: '1' }), true, '变异评估子进程必须跳过（否则沙箱内活动沙箱→假红）')
  assert.strictEqual(shouldSkipCheck({}), false)
  const missing = inspect({ env: {}, procRoot: path.join(TMP_ROOT, 'definitely-not-here'), tmpRoot: path.join(TMP_ROOT, 'definitely-not-here'), nowMs: now, selfPid: 1 })
  assert.strictEqual(missing.unsupported, true, '读不到 /proc 必须标为「该平台不检测」，不得当成已检查')
  assert.strictEqual(missing.ok, true)
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
  } finally {
    fs.rmSync(fake, { recursive: true, force: true })
  }
  console.log('✅ check-host-clean --selftest 全部通过（21 断言）')
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
    console.log('⚠️ 读不到 /proc，本机不做孤儿桩检测（**不等于已检查干净**）；沙箱过期检查仍在跑')
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
      console.log('  孤儿套件进程 ' + r.suites.length + ' 个（父进程被外部 kill 后被 reparent 到 1）：')
      for (const x of r.suites.slice(0, 6)) console.log('    pid ' + x.pid + '  ' + x.cmdline.slice(0, 120))
      console.log('    清理：kill -TERM ' + r.suites.map((x) => x.pid).join(' ') + '  然后再 kill -KILL')
    }
    if (r.dirs.length) {
      console.log('  过期沙箱 ' + r.dirs.length + ' 个：')
      for (const d of r.dirs.slice(0, 6)) console.log('    ' + d.p + '（' + d.ageMin + ' 分钟前）')
      console.log('    清理：rm -rf ' + r.dirs.map((d) => d.p).join(' '))
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
    console.log('⚠️ 主机干净度检查：读不到 /proc，跳过孤儿桩检测（**不等于已检查干净**）')
  }
  if (r.ok) return false
  console.log('❌ 主机不干净，本次运行不启动（避免把环境残留报成契约失败）：')
  for (const x of r.stubs) console.log('   孤儿桩 pid ' + x.pid + '  ' + x.cmdline.slice(0, 120))
  for (const x of r.suites) console.log('   孤儿套件 pid ' + x.pid + '  ' + x.cmdline.slice(0, 120))
  for (const d of r.dirs) console.log('   过期沙箱 ' + d.p + '（' + d.ageMin + ' 分钟前）')
  const pids = r.stubs.concat(r.suites).map((x) => x.pid)
  if (pids.length) console.log('   清理：kill -TERM ' + pids.join(' ') + ' && sleep 1 && kill -KILL ' + pids.join(' '))
  if (r.dirs.length) console.log('   清理：rm -rf ' + r.dirs.map((d) => d.p).join(' '))
  return true
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { STALE_MS, TMP_ROOT, shouldSkipCheck, findStaleSandboxes, findOrphanStubs, findOrphanSuites, ancestorPids, inspect, guardOrExit }
