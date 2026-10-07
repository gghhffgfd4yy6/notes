'use strict'

// v3.283 主机干净度检查（scripts/check-host-clean.js）的接线与不回退断言。
//
// 为什么由一个套件来锁：这个检查挂在 run_tests.js / run_unit_tests.js 的入口上，「把那一行删掉」本身
// 不会让任何东西变红——与 v3.280 静态闸门、v3.281 文档行长闸门同一族失效方式。
// 本套件是普通单元套件（不标 mutationSkip）：只读仓库文件 + 调纯函数；变异沙箱的 copyProject 会整体
// 复制 scripts/，故沙箱内也能跑；由「全量单元测试（run_unit_tests.js）」兜底步骤覆盖，SKIP_SUITES 不动。
// 判据本身的边界用例（NUL cmdline、ppid 排除、过期阈值覆盖等）在 --selftest 的 21 条里，不在此重复。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const host = require('./scripts/check-host-clean.js')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
let checks = 0
function check (label, fn) {
  fn()
  checks++
  console.log('✅ ' + label)
}

check('接线：npm 脚本在册 + 两个测试入口都挂了 guard', () => {
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

check('孤儿判据：只认被 reparent（ppid===1）的测试进程，活动子进程不误伤', () => {
  const nul = String.fromCharCode(0)
  const ps = [
    { pid: 200, ppid: 1, cmdline: 'node' + nul + '/root/x/test_filter.js' + nul },
    { pid: 201, ppid: 55, cmdline: 'node' + nul + '/root/x/test_filter.js' + nul },
    { pid: 202, ppid: 1, cmdline: 'node' + nul + '/usr/local/bin/dsh web' + nul }
  ]
  assert.deepStrictEqual(host.findOrphanSuites(ps, 999, []).map((x) => x.pid), [200],
    '200 是被 reparent 的孤儿套件；201 父进程还活着（并发跑测试不误伤）；202 不是测试进程')
  assert.deepStrictEqual(host.findOrphanSuites(ps, 200, []).map((x) => x.pid), [], '自己的 PID 必须排除')
})

check('v3.282 那条机制不复发：挂死夹具与心跳孙进程都带 90s 有界自杀', () => {
  const s = read('test_ci_skip_suites.js')
  const n = s.split('setTimeout(() => process.exit(0), 90000).unref()').length - 1
  assert.strictEqual(n, 2, '父桩与孙进程各一处；少一处 = 从外面 kill -9 入口后它会永久每 50ms 写盘')
})

check('此刻判定与真实环境一致（跳过或干净，二者其一）', () => {
  const r = host.inspect({ env: process.env })
  if (r.skipped) return
  if (r.unsupported) {
    assert.ok(Array.isArray(r.dirs), '读不到 /proc 时仍要给出沙箱判定（不得静默当已检查）')
    return
  }
  assert.deepStrictEqual(r.stubs.map((x) => x.pid), [], '本机存在孤儿测试桩：' + JSON.stringify(r.stubs))
  assert.deepStrictEqual(r.suites.map((x) => x.pid), [], '本机存在孤儿套件进程：' + JSON.stringify(r.suites))
})

console.log('✅ test_host_clean_gates 全部通过（' + checks + ' 检查）')
