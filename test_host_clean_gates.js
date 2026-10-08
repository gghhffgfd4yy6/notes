'use strict'

// v3.283 主机干净度检查（scripts/check-host-clean.js）的接线与不回退断言。
//
// 为什么由一个套件来锁：这个检查挂在 run_tests.js / run_unit_tests.js 的入口上，「把那一行删掉」本身
// 不会让任何东西变红——与 v3.280 静态闸门、v3.281 文档行长闸门同一族失效方式。
// 本套件是普通单元套件（不标 mutationSkip）：只读仓库文件 + 调纯函数；变异沙箱的 copyProject 会整体
// 复制 scripts/，故沙箱内也能跑；由「全量单元测试（run_unit_tests.js）」兜底步骤覆盖，SKIP_SUITES 不动。
// 判据本身的边界用例（NUL cmdline、ppid 排除、过期阈值覆盖等）在 --selftest 的 34 条里，不在此重复。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const host = require('./scripts/check-host-clean.js')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
let checks = 0
function check (label, fn) {
  fn()
  checks++
  console.log('✅ ' + label)
}

check('接线：npm 脚本在册 + 三个测试入口都挂了 guard', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.strictEqual(pkg.scripts['check:host-clean'], 'node scripts/check-host-clean.js',
    'check:host-clean 必须指向 scripts/check-host-clean.js')
  for (const entry of ['run_tests.js', 'run_unit_tests.js']) {
    // 行首锚定真实调用行：只在注释里提一句不算接线
    const src = read(entry)
    assert.match(src, /^if \(hostClean && hostClean\.guardOrExit\(process\.env\)\) process\.exit\(1\)$/m,
      entry + ' 缺入口 guard：脏机器上跑出的红会被当成契约失败（v3.282 那轮 48/49 正是如此）')
    // 容错必须是「只放过 MODULE_NOT_FOUND」：最小工作树（RT-08 夹具只复制 run_tests.js）不得崩，
    // 但吞掉一切异常会让真故障伪装成「已检查且干净」。
    assert.match(src, /if \(e\.code !== 'MODULE_NOT_FOUND'\) throw e/,
      entry + ' 的 require 容错必须只吞 MODULE_NOT_FOUND，其它异常照常抛出')
    assert.match(src, /console\.log\('⚠️ 未找到 scripts\/check-host-clean\.js/,
      entry + ' 跳过时必须响亮打印，不得静默通过')
  }
  const direct = read('test_filter.js')
  assert.match(direct, /^if \(hostClean\.guardOrExit\(process\.env\)\) process\.exit\(1\)$/m,
    '直接执行 test_filter.js（CI/pre-push）也必须先经过主机干净度检查')
})

check('不回退：变异子进程必跳过；沙箱只认过期；阈值必须是 30 分钟', () => {
  assert.strictEqual(host.shouldSkipCheck({ XBK_MUTATION_CHILD: '1' }), true,
    '变异评估子进程内必须跳过——沙箱里本来就有活动 /tmp 沙箱，按「脏」判会立刻假红')
  assert.strictEqual(host.shouldSkipCheck({}), false)
  const now = 1e12
  assert.deepStrictEqual(host.findStaleSandboxes([{ p: path.join(host.TMP_ROOT, 'xbk-a'), mtimeMs: now - 60000 }], now, undefined), [],
    '1 分钟内的活动沙箱不得被误报（并发跑测试时 /tmp 里本来就有）')
  assert.strictEqual(host.findStaleSandboxes([{ p: path.join(host.TMP_ROOT, 'xbk-a'), mtimeMs: now - 31 * 60000 }], now, undefined).length, 1,
    '超过阈值的残留沙箱必须被点名')
  assert.strictEqual(host.STALE_MS, 30 * 60 * 1000,
    '阈值被悄悄调小 = 并发场景假红；调大 = 门禁形同虚设')
})

check('孤儿判据：父进程已消失的测试进程也要拦，活动子进程不误伤', () => {
  const nul = String.fromCharCode(0)
  const ps = [
    { pid: 50, ppid: 1, cmdline: 'node' + nul + '/usr/local/bin/helper.js' + nul },
    { pid: 200, ppid: 1, cmdline: 'node' + nul + '/root/x/test_filter.js' + nul },
    { pid: 201, ppid: 50, cmdline: 'node' + nul + '/root/x/test_filter.js' + nul },
    { pid: 202, ppid: 999, cmdline: 'node' + nul + 'test_filter.js' + nul },
    { pid: 203, ppid: 999, cmdline: 'node' + nul + path.join(__dirname, 'test_app.js') + nul + '--only=foo' + nul },
    { pid: 204, ppid: 1, cmdline: 'node' + nul + '/usr/local/bin/dsh web' + nul }
  ]
  assert.deepStrictEqual(host.findOrphanSuites(ps, 999, []).map((x) => x.pid), [200, 202, 203],
    'reparent、父进程消失、相对脚本路径和尾随参数都必须被抓到；活动运行的 201 与非测试进程 204 不得误伤')
  assert.deepStrictEqual(host.findOrphanSuites(ps, 200, []).map((x) => x.pid), [202, 203], '自己的 PID 必须排除')
})

check('v3.282 那条机制不复发：挂死夹具与心跳孙进程都带 90s 有界自杀', () => {
  const s = read('test_ci_skip_suites.js')
  const n = s.split('setTimeout(() => process.exit(0), 90000).unref()').length - 1
  assert.strictEqual(n, 2, '父桩与孙进程各一处；少一处 = 从外面 kill -9 入口后它会永久每 50ms 写盘')
})

check('此刻判定与真实环境一致（跳过或干净，二者其一）', () => {
  const r = host.inspect({ env: process.env })
  if (r.skipped) return
  assert.strictEqual(r.tmpScanError, false, '真实环境临时根扫描失败必须直接暴露，而不是报告干净')
  if (r.unsupported) {
    assert.ok(Array.isArray(r.dirs), '读不到 /proc 时仍要给出沙箱判定（不得静默当已检查）')
    return
  }
  assert.deepStrictEqual(r.stubs.map((x) => x.pid), [], '本机存在孤儿测试桩：' + JSON.stringify(r.stubs))
  assert.deepStrictEqual(r.suites.map((x) => x.pid), [], '本机存在孤儿套件进程：' + JSON.stringify(r.suites))
})

check('桩的孤儿判据必须要求「父进程已没」（review #211：活动桩不得报成孤儿）', () => {
  const nul = String.fromCharCode(0)
  const stub = (pid, ppid, dir) => ({ pid, ppid, cmdline: 'node' + nul + dir + '/test_stub_tree.js' + nul })
  const testTmpRoot = os.tmpdir()
  // 另一条终端此刻正在跑 test_ci_skip_suites.js：桩的父进程（1000）与再上一级（60）都在进程表里 ⇒ 不是孤儿
  const runner = { pid: 60, ppid: 1, cmdline: 'node' + nul + path.join(testTmpRoot, 'runner', 'test_ci_skip_suites.js') + nul }
  const concurrentDir = path.join(testTmpRoot, 'xbk-run-tests-other')
  const concurrent = [runner, stub(1000, 60, concurrentDir), stub(1001, 1000, concurrentDir)]
  assert.deepStrictEqual(host.findOrphanStubs(concurrent, 500, []), [],
    '父进程仍在进程表里的活动桩必须放行——头注第 3 条「两条终端并发互不误伤」靠的就是这个判据')
  // 真残留：被 reparent 到 1
  assert.deepStrictEqual(host.findOrphanStubs([stub(1001, 1, path.join(testTmpRoot, 'xbk-run-tests-dead'))], 500, []).map((x) => x.pid), [1001],
    'reparent 到 1 的桩仍必须被抓到（摘掉特征匹配会让门禁对真残留失明）')
  // 真残留的另一种形态：ppid 指向一个已经不在进程表里的 pid
  assert.deepStrictEqual(host.findOrphanStubs([stub(1002, 8888, path.join(testTmpRoot, 'xbk-run-tests-dead'))], 500, []).map((x) => x.pid), [1002],
    '父进程已从进程表消失的桩同样算残留')
  // 判据不许只写在注释里：源码必须有 ppid 这一层
  const src = read('scripts/check-host-clean.js')
  assert.match(src, /ppid === 1 \|\| !livePids\.has\(String\(ppid\)\)/,
    'findOrphanStubs 的父进程判据被删 = 活动桩又被当成残留拦人')
})

check('沙箱活跃时间必须含直接子项与活进程 cwd（review #211：目录自身 mtime 不是活跃度）', () => {
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-gate-liveness-'))
  try {
    const sb = path.join(tmp, 'xbk-mutant-x')
    fs.mkdirSync(sb)
    fs.writeFileSync(path.join(sb, 'out.log'), 'tick\n')
    const past = new Date(Date.now() - 61 * 60 * 1000)
    fs.utimesSync(sb, past, past) // 只把**目录自身**退回 61 分钟前：模拟「持续写已有文件」的活动沙箱
    assert.ok(host.activityMtimeMs(sb) > Date.now() - 30 * 60 * 1000,
      '直接子项的 mtime 必须计入活跃时间，否则活动沙箱会被判过期并收到 rm -rf 建议')
    assert.ok(host.isActiveSandbox(sb, [path.join(sb, 'nested')]), '活进程 cwd 在沙箱内 = 活动')
    assert.ok(!host.isActiveSandbox(sb, [sb + 'brother']), '前缀相似但不同目录不得豁免（必须按路径分段）')
    const aliasRoot = path.join(tmp, 'alias')
    fs.symlinkSync(tmp, aliasRoot, 'dir')
    assert.ok(host.isActiveSandbox(path.join(aliasRoot, path.basename(sb)), [fs.realpathSync(sb)]),
      'TMPDIR 符号链接别名和 /proc cwd 的真实路径必须视为同一活动沙箱')
    // 接线：listStaleSandboxDirs 必须同时用上这两个信号
    const src = read('scripts/check-host-clean.js')
    assert.match(src, /return findStaleSandboxes\(entries, nowMs, staleMs\)\.filter\(\(d\) => !isActiveSandbox\(d\.p, cwds\)\)/,
      'cwd 豁免被摘掉 = 变异评估等长任务的沙箱会被误报成残留')
    assert.match(src, /mtimeMs: activityMtimeMs\(p\)/, '活跃时间又被换回目录自身 mtime')
    assert.match(src, /const entries = names\s+\.filter\(\(n\) => n\.startsWith\(SANDBOX_NAME_PREFIX\)\)/,
      '必须先过滤 xbk-* 候选，再读取直接子项；否则无关大目录会拖慢每次入口检查')
    // CodeQL「useless assignment」不复发：初值形态不得回到 let mtimeMs = NaN 再无条件覆盖
    assert.ok(!/let mtimeMs = Number\.NaN/.test(src), 'mtimeMs 的无用初值形态回潮')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('临时根扫描失败必须 fail-closed，普通文件不得进入沙箱清理清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-gate-scan-'))
  try {
    const missing = host.inspect({ env: {}, procRoot: root, tmpRoot: path.join(root, 'missing'), selfPid: 1 })
    assert.strictEqual(missing.tmpScanError, true, '临时根不可读必须显式标记扫描失败')
    assert.strictEqual(missing.ok, false, '扫描失败不得返回主机干净')
    const emptyTmpRoot = path.join(root, 'empty-tmp')
    fs.mkdirSync(emptyTmpRoot)
    const emptyProcRoot = path.join(root, 'empty-proc')
    fs.mkdirSync(emptyProcRoot)
    const cwdNotNeeded = host.inspect({ env: {}, procRoot: emptyProcRoot, tmpRoot: emptyTmpRoot, selfPid: 1 })
    assert.strictEqual(cwdNotNeeded.cwdScanError, false, '没有过期候选时不需要扫描 cwd 豁免')
    assert.deepStrictEqual(cwdNotNeeded.dirs, [], '没有过期候选时不生成删除建议')
    assert.strictEqual(cwdNotNeeded.ok, true, '没有候选且 proc 根可读时不得因未扫描 cwd 阻止测试启动')
    const unsupportedNoCandidate = host.inspect({ env: {}, procRoot: path.join(root, 'missing-proc'), tmpRoot: emptyTmpRoot, selfPid: 1 })
    assert.strictEqual(unsupportedNoCandidate.unsupported, true, '整个 proc 根不可读必须显式标记平台不可判定')
    assert.strictEqual(unsupportedNoCandidate.ok, false, '整个 proc 根不可读仍必须总体 fail-closed')
    const activeSandbox = path.join(root, 'xbk-active-unreadable-cwd')
    fs.mkdirSync(activeSandbox)
    const old = new Date(Date.now() - 61 * 60 * 1000)
    fs.utimesSync(activeSandbox, old, old)
    const cwdMissing = host.inspect({ env: {}, procRoot: path.join(root, 'missing-proc'), tmpRoot: root, selfPid: 1 })
    assert.strictEqual(cwdMissing.cwdScanError, true, '有过期候选且 cwd 保护信号不可读必须显式 fail-closed')
    assert.deepStrictEqual(cwdMissing.dirs, [], 'cwd 保护信号不可读时不得生成沙箱删除候选')
    assert.strictEqual(cwdMissing.ok, false, '有过期候选且 cwd 保护信号不可读不得报告主机干净')
    const file = path.join(root, 'xbk-not-a-sandbox')
    fs.writeFileSync(file, 'ordinary file\n')
    fs.utimesSync(file, new Date(0), new Date(0))
    const inspected = host.inspect({ env: {}, procRoot: root, tmpRoot: root, nowMs: Date.now(), selfPid: 1 })
    assert.ok(!inspected.dirs.some((d) => d.p === file), '普通文件不得进入过期沙箱清单')
    const procRoot = path.join(root, 'proc')
    const makeFakeProc = (pid, rootPath = procRoot) => {
      const pidPath = path.join(rootPath, pid)
      fs.mkdirSync(pidPath, { recursive: true })
      fs.writeFileSync(path.join(pidPath, 'cmdline'), 'node\0worker\0')
      fs.writeFileSync(path.join(pidPath, 'stat'), `${pid} (node) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`)
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      fs.writeFileSync(path.join(pidPath, 'status'), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`)
      const cwdLink = path.join(pidPath, 'cwd')
      fs.symlinkSync(activeSandbox, cwdLink, 'dir')
      return { pidPath, cwdLink, procRoot: rootPath }
    }
    const inspectWithCwdError = (proc, code, pidGone) => {
      const originalReadlink = fs.readlinkSync
      const originalStat = fs.statSync
      fs.readlinkSync = function (target, ...args) {
        if (target === proc.cwdLink) {
          const error = new Error('cwd read failure')
          error.code = code
          throw error
        }
        return originalReadlink.call(this, target, ...args)
      }
      fs.statSync = function (target, ...args) {
        if (pidGone && target === proc.pidPath) {
          const error = new Error('process exited during cwd scan')
          error.code = code
          throw error
        }
        return originalStat.call(this, target, ...args)
      }
      try {
        return host.inspect({ env: {}, procRoot: proc.procRoot, tmpRoot: root, selfPid: 1, nowMs: Date.now() })
      } finally {
        fs.readlinkSync = originalReadlink
        fs.statSync = originalStat
      }
    }
    const unreadableCwd = inspectWithCwdError(makeFakeProc('12345'), 'EACCES', false)
    assert.strictEqual(unreadableCwd.cwdScanError, true, '单个进程 cwd 权限错误必须令保护信号不可判定')
    const cwdError = unreadableCwd.cwdScanErrorDetails
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0
    assert.strictEqual(cwdError.pid, 12345, 'cwd 错误诊断必须包含 PID')
    assert.strictEqual(cwdError.errorCode, 'EACCES', 'cwd 错误诊断必须包含 errno')
    assert.strictEqual(cwdError.procDirExists, true, 'cwd 错误诊断必须标记 PID 目录存在')
    assert.strictEqual(cwdError.state, 'S', 'cwd 错误诊断必须包含 proc stat state')
    assert.strictEqual(cwdError.uid, currentUid, 'cwd 错误诊断必须包含 /proc 目录 UID')
    assert.deepStrictEqual(cwdError.statusUids, [currentUid, currentUid, currentUid, currentUid], 'cwd 错误诊断必须包含 status Uid 字段')
    assert.strictEqual(cwdError.kthread, null, '缺失 Kthread 字段必须保持未知')
    assert.deepStrictEqual(unreadableCwd.dirs, [], 'cwd 扫描不完整时不得建议删除任何候选')
    assert.strictEqual(unreadableCwd.ok, false, 'cwd 扫描不完整不得报告主机干净')
    const missingCwdLink = inspectWithCwdError(makeFakeProc('12346'), 'ENOENT', false)
    assert.strictEqual(missingCwdLink.cwdScanError, true, 'PID 仍存在但 cwd 链接缺失时必须 fail-closed')
    const missingCwdWithEsrch = inspectWithCwdError(makeFakeProc('12347'), 'ESRCH', false)
    assert.strictEqual(missingCwdWithEsrch.cwdScanError, true, 'PID 仍存在但 readlink 返回 ESRCH 时必须 fail-closed')
    assert.deepStrictEqual(missingCwdWithEsrch.dirs, [], 'PID 仍存在但 cwd 信号异常时不得生成删除候选')
    assert.strictEqual(missingCwdWithEsrch.ok, false, 'PID 仍存在但 cwd 信号异常不得报告主机干净')
    for (const [index, code] of ['ENOENT', 'ESRCH'].entries()) {
      const raceRoot = path.join(root, 'proc-race-' + code.toLowerCase())
      const vanishedPid = inspectWithCwdError(makeFakeProc(String(12347 + index), raceRoot), code, true)
      assert.strictEqual(vanishedPid.cwdScanError, false, `${code} 且 PID 目录已消失应视为退出竞态`)
      assert.ok(vanishedPid.dirs.some((d) => d.p === activeSandbox), `${code} 退出竞态后不得遗留虚假 cwd 豁免`)
    }
    const src = read('scripts/check-host-clean.js')
    assert.match(src, /const tmpScanError = candidates === null/, '临时根扫描失败必须进入显式错误状态')
    assert.match(src, /const candidates = listStaleSandboxDirs\(tmpRoot, nowMs, staleMs, \[\]\)/, '必须先筛出过期候选')
    assert.match(src, /if \(!tmpScanError && candidates\.length > 0\)/, '没有删除候选时不得因 cwd 读取失败阻塞运行')
    assert.match(src, /cwdScanError = cwds === null/, '有过期候选时 cwd 保护信号不可判定必须 fail-closed')
    assert.match(src, /if \(!cwdScanError\) dirs\.push\(\.\.\.candidates\.filter/, 'cwd 信号不完整时不得生成沙箱清理候选')
    assert.match(src, /cwdScanFailureText\(r\.cwdScanErrorDetails\)/, 'cwd 失败须输出有限诊断字段')
    assert.match(src, /st\.isDirectory\(\) && !st\.isSymbolicLink\(\)/, '清理候选必须限定为真实目录')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

check('清理建议必须对空格和 shell 元字符进行 POSIX 引用', () => {
  assert.strictEqual(host.rmSuggestion([{ p: '/tmp/review space; touch marker; #' }]),
    "rm -rf '/tmp/review space; touch marker; #'")
  assert.strictEqual(host.rmSuggestion([{ p: "/tmp/reviewer's sandbox" }]),
    "rm -rf '/tmp/reviewer'\\''s sandbox'")
  const relativeDashPath = '-tmp/xbk-example'
  assert.strictEqual(host.rmSuggestion([{ p: relativeDashPath }]), "rm -rf '" + path.resolve(relativeDashPath) + "'")
})

console.log('✅ test_host_clean_gates 全部通过（' + checks + ' 检查）')
