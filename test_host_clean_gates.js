'use strict'

// v3.283 主机干净度检查（scripts/check-host-clean.js）的接线与不回退断言。
//
// 为什么由一个套件来锁：这个检查挂在 run_tests.js / run_unit_tests.js 的入口上，「把那一行删掉」本身
// 不会让任何东西变红——与 v3.280 静态闸门、v3.281 文档行长闸门同一族失效方式。
// 本套件是普通单元套件（不标 mutationSkip）：只读仓库文件 + 调纯函数；变异沙箱的 copyProject 会整体
// 复制 scripts/，故沙箱内也能跑；由「全量单元测试（run_unit_tests.js）」兜底步骤覆盖，SKIP_SUITES 不动。
// 判据本身的边界用例（NUL cmdline、ppid 排除、过期阈值覆盖等）在 --selftest 的 34 条里，不在此重复。
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const host = require('./scripts/check-host-clean.js')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
// 子进程探针用 env：本套件也可能跑在变异评估沙箱里（XBK_MUTATION_CHILD=1）⇒ 必须先摘掉它，
// 否则 CLI 会按设计跳过检查，探针测到的就不是「门禁怎么判」而是「门禁被关掉了」。
const probeEnv = (extra) => {
  const env = { ...process.env, ...(extra || {}) }
  delete env.XBK_MUTATION_CHILD
  return env
}
// C5-022：harness 必须「逐条捕获」而不是裸调用。旧实现是 `fn(); checks++; console.log('✅')`——
// 任何一条检查抛错就直接穿出顶层：不打印该条的 label、不记失败、没有汇总，**其后的检查一条都不跑**
// （本文件 12 条检查里前 3 条一红，后面 9 条连同最终结论全部沉默，CI 只看到一段 Node 堆栈）。
// 现在与 test_doc_line_gates.js / test_ci_static_gates.js 的 createChecker 同形：每条独立 try/catch，
// passed/failed 双计数，抛错时打印 ❌ + label + 原始 message，末尾 summary() 汇总并给出退出码。
function createChecker (out) {
  const log = (out && out.log) || ((s) => console.log(s))
  let passed = 0
  const failures = []
  function check (label, fn) {
    try {
      fn()
      passed++
      log('✅ ' + label)
    } catch (e) {
      const message = (e && e.message) || String(e)
      failures.push({ label, message })
      log('❌ ' + label + '：' + message)
    }
  }
  return {
    check,
    get passed () { return passed },
    get failures () { return failures.slice() },
    summary () {
      if (failures.length === 0) {
        log(`✅ test_host_clean_gates 全部通过（${passed} 检查）`)
        return 0
      }
      log(`❌ test_host_clean_gates：${passed} 通过 / ${failures.length} 失败（共 ${passed + failures.length} 检查）`)
      for (const f of failures) log('   ❌ ' + f.label + '：' + f.message)
      return 1
    }
  }
}

const harness = createChecker()
const check = harness.check

// C5-022 自测接缝：让「一条检查抛错」这条控制流在**子进程**里可复现——本文件的 harness 自测只能证明
// createChecker 的返回值，证明不了 `process.exitCode = harness.summary()` 真的会把退出码变成 1。
// 只有探针子进程（见下方「harness 退出码」用例）会设这个变量；正常跑完全不走这条分支。
if (process.env.XBK_HOST_CLEAN_THROW_PROBE === '1') {
  check('💥 探针：故意抛错（仅 XBK_HOST_CLEAN_THROW_PROBE=1 时存在）', () => {
    throw new Error('probe-throw')
  })
}

// C5-022 门禁：harness 自身的控制流必须有断言，否则「一条检查抛错就整份文件中断」这种改动零覆盖。
check('harness 自身：一条检查抛错只记失败，后续检查照跑并汇总为红（C5-022）', () => {
  const lines = []
  const probe = createChecker({ log: (s) => lines.push(s) })
  probe.check('通过的检查', () => {})
  probe.check('抛错的检查', () => { throw new Error('boom') })
  probe.check('抛错之后的检查', () => { lines.push('AFTER-RAN') })
  assert.deepStrictEqual(probe.failures.map((f) => f.label), ['抛错的检查'],
    '抛错的检查必须被记为失败（带 label），而不是把异常穿出 harness')
  assert.strictEqual(probe.failures[0].message, 'boom', '失败明细必须带原始错误信息，否则定位不到根因')
  assert.ok(lines.includes('AFTER-RAN'), '抛错之后的检查必须照跑——旧实现在这里整份文件中止')
  assert.ok(lines.some((l) => l.startsWith('❌ 抛错的检查')), '失败检查必须打印 ❌ 与 label（旧实现连 label 都不打）')
  assert.strictEqual(probe.passed, 2, 'passed 只算真正跑完的检查')
  assert.strictEqual(probe.summary(), 1, '有失败时汇总必须返回 1，不得把「跑了一半」当全绿')
  assert.ok(lines.some((l) => l.includes('2 通过 / 1 失败')), '汇总必须同时报通过与失败数：' + JSON.stringify(lines))
})

// C5-022 退出码（子进程，真跑）：把探针异常插进**这一个套件本身**，断言 ① 它被记成 ❌ 而不是崩栈、
// ② 其后的检查照跑（末条检查的 ✅ 必须出现）、③ 进程退出码是 1。缺了 ③，harness 就只是「打印得好
// 看」——CI 仍会把一份带失败明细的报告当绿。
// 探针子进程里必须跳过本用例自身：否则它会再 spawn 一个孙进程，无限递归。
if (process.env.XBK_HOST_CLEAN_THROW_PROBE !== '1') {
  check('harness 退出码：一条检查抛错 ⇒ 后续检查照跑且 exit 1（C5-022，子进程实跑）', () => {
    // 子进程里必须摘掉 XBK_MUTATION_CHILD（与本文件 probeEnv 同口径）：否则它会按设计跳过主机检查，
    // 探针测到的就不是「门禁怎么判」而是「门禁被关掉了」。
    const childEnv = { ...process.env, XBK_HOST_CLEAN_THROW_PROBE: '1' }
    delete childEnv.XBK_MUTATION_CHILD
    const probe = spawnSync(process.execPath, [__filename],
      { encoding: 'utf8', cwd: __dirname, env: childEnv })
    const both = (probe.stdout || '') + (probe.stderr || '')
    assert.strictEqual(probe.status, 1,
      `注入抛错后套件必须以 1 退出（实际 ${probe.status}）：` + both.slice(-600))
    assert.match(probe.stdout, /❌ 💥 探针：故意抛错/, '抛错的检查必须打印 ❌ + label，而不是抛栈退出：' + both.slice(-600))
    assert.ok(probe.stdout.includes('✅ 清理建议必须对空格和 shell 元字符进行 POSIX 引用'),
      '抛错之后的检查必须照跑（末条检查的 ✅ 缺失说明整份文件中止了）：' + both.slice(-600))
    // 计数按「真实数量」核对（不写死通过数：宿主机不干净时其它检查可能连带失败，那与本用例无关）
    const summary = probe.stdout.match(/(\d+) 通过 \/ (\d+) 失败（共 (\d+) 检查）/)
    assert.ok(summary, '有失败时必须有汇总行（旧实现连结论都没有）：' + both.slice(-600))
    const [, passed, failed, total] = summary.map(Number)
    assert.ok(failed >= 1, `汇总必须记下失败条数（实得 ${failed}）：` + both.slice(-600))
    assert.strictEqual(passed + failed, total, `汇总三数字必须自洽（${passed}+${failed}≠${total}）`)
    assert.ok(passed >= 13, `探头之后仍有 13 条检查必须跑完（实得 ${passed} 通过）：` + both.slice(-600))
    assert.ok(!/Error: probe-throw\s*\n\s*at /.test(both),
      '不得把原始异常栈直接抛到顶层（旧实现的行为）：' + both.slice(-600))
  })
}

check('接线：npm 脚本在册 + 三个测试入口都挂了 guard', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.strictEqual(pkg.scripts['check:host-clean'], 'node scripts/check-host-clean.js',
    'check:host-clean 必须指向 scripts/check-host-clean.js')
  // C10-068：`guardOrExit` 名不符实（函数只返回布尔、从不 exit），调用方读起来语义相反 ⇒ 改名
  // shouldAbortForDirtyHost（语义不变：返回 true = 调用方应中止本次运行）。
  assert.strictEqual(typeof host.shouldAbortForDirtyHost, 'function',
    '入口守卫必须叫 shouldAbortForDirtyHost：名字要说明它返回布尔而不是替调用方退出')
  assert.strictEqual(host.guardOrExit, undefined,
    '旧名 guardOrExit 必须删除：它承诺 exit、实际只返回布尔（C10-068）')
  for (const entry of ['run_tests.js', 'run_unit_tests.js']) {
    // 行首锚定真实调用行：只在注释里提一句不算接线
    const src = read(entry)
    assert.match(src, /^if \(hostClean && hostClean\.shouldAbortForDirtyHost\(process\.env\)\) process\.exit\(1\)$/m,
      entry + ' 缺入口 guard：脏机器上跑出的红会被当成契约失败（v3.282 那轮 48/49 正是如此）')
    // 容错必须是「只放过 MODULE_NOT_FOUND」：最小工作树（RT-08 夹具只复制 run_tests.js）不得崩，
    // 但吞掉一切异常会让真故障伪装成「已检查且干净」。
    assert.match(src, /if \(e\.code !== 'MODULE_NOT_FOUND'\) throw e/,
      entry + ' 的 require 容错必须只吞 MODULE_NOT_FOUND，其它异常照常抛出')
    assert.match(src, /console\.log\('⚠️ 未找到 scripts\/check-host-clean\.js/,
      entry + ' 跳过时必须响亮打印，不得静默通过')
  }
  const direct = read('test_filter.js')
  assert.match(direct, /^if \(hostClean\.shouldAbortForDirtyHost\(process\.env\)\) process\.exit\(1\)$/m,
    '直接执行 test_filter.js（CI/pre-push）也必须先经过主机干净度检查')
})

// C10-028：run_tests.js / run_unit_tests.js 的 require 容错曾经只判 `e.code === 'MODULE_NOT_FOUND'`——于是
// 「scripts/check-host-clean.js 存在、但它内部某个依赖缺失（树损坏，或将来给它加相对依赖）」也被读成
// 「未找到 check-host-clean.js，跳过」，主机干净度门禁被静默关掉（且随后可能因别的 require 失败而看不出
// 真正原因）。判据：只有「本模块自身解析不到」才算最小工作树；模块内部的缺失必须原样抛出。
// 两个生产入口各用「坏门禁 / 无门禁」两个夹具实跑核对（两个入口的真实分支不同，必须各测一次）。
check('require 容错只吞「本模块不存在」，模块内部依赖缺失必须响亮失败（C10-028）', () => {
  const CASES = [
    {
      entry: 'run_tests.js',
      // 跑过 hostClean 之后的第一个可观察检查点（与 RT-01 夹具同口径）
      afterSkip: /SUITES 为空/,
      extra: { 'scripts/check-deps.js': "'use strict'\nmodule.exports = { checkDependencies: () => true }\n" }
    },
    {
      entry: 'run_unit_tests.js',
      afterSkip: /过滤后没有可执行的单元套件/,
      extra: {}
    }
  ]
  const makeFixture = (c, withBrokenGate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-host-clean-require-'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    // 补齐入口自身的最小依赖，让它能跑到可观察的节点（脚本本体只复制入口文件）
    fs.writeFileSync(path.join(dir, c.entry), read(c.entry))
    fs.writeFileSync(path.join(dir, 'test_suites.js'), "'use strict'\nmodule.exports = { SUITES: [] }\n")
    for (const [rel, body] of Object.entries(c.extra)) fs.writeFileSync(path.join(dir, rel), body)
    if (withBrokenGate) {
      // 门禁脚本本身存在，但它 require 的同级依赖不存在（树损坏 / 未来新增相对依赖的形态）
      fs.writeFileSync(path.join(dir, 'scripts', 'check-host-clean.js'),
        "'use strict'\nrequire('./missing-dep')\nmodule.exports = { shouldAbortForDirtyHost: () => false }\n")
    }
    return dir
  }
  for (const c of CASES) {
    // ① 坏输入：门禁脚本存在但内部依赖缺失 → 不得打印「未找到 check-host-clean.js」，必须以真实错误退出
    {
      const dir = makeFixture(c, true)
      try {
        const run = spawnSync(process.execPath, [path.join(dir, c.entry)], { cwd: dir, encoding: 'utf8', env: probeEnv() })
        const both = (run.stdout || '') + (run.stderr || '')
        assert.notStrictEqual(run.status, 0, `${c.entry}：内部依赖缺失必须非 0 退出：` + both.slice(-600))
        assert.ok(!/未找到 scripts\/check-host-clean\.js/.test(both),
          `${c.entry}：「模块内部依赖缺失」被读成「未找到 check-host-clean.js」= 门禁被静默关掉（C10-028）：` + both.slice(-600))
        assert.ok(/missing-dep/.test(both),
          `${c.entry}：必须把真正的缺失模块报出来，而不是谎报主机干净度脚本不存在：` + both.slice(-600))
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    // ② 好输入（最小工作树）：脚本真的不存在 → 仍要响亮跳过并继续跑到下一个检查点
    {
      const dir = makeFixture(c, false)
      try {
        const run = spawnSync(process.execPath, [path.join(dir, c.entry)], { cwd: dir, encoding: 'utf8', env: probeEnv() })
        const both = (run.stdout || '') + (run.stderr || '')
        assert.match(both, /⚠️ 未找到 scripts\/check-host-clean\.js/,
          `${c.entry}：最小工作树（无 scripts/check-host-clean.js）必须响亮跳过、不得崩：` + both.slice(-600))
        assert.match(both, c.afterSkip,
          `${c.entry}：跳过之后入口必须继续执行（跑到下一个检查点），不得在此中断：` + both.slice(-600))
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    // ③ 生产路径不得回退：先 require.resolve 预判，resolve 成功后的 require 异常照常抛
    const src = read(c.entry)
    assert.match(src, /try \{\s*\n\s*require\.resolve\(HOST_CLEAN_MODULE\)/,
      `${c.entry} 必须先 require.resolve 本模块、再 require 它（否则任何 MODULE_NOT_FOUND 又会被当成「脚本不存在」）`)
    assert.ok(!/hostClean = require\('\.\/scripts\/check-host-clean\.js'\)\s*\n\}\s*catch/.test(src),
      `${c.entry} 不得把 require 直接放在只判 e.code 的 catch 里（C10-028 的原形）`)
  }
})

check('跳过必须响亮打印：guardOrExit 与 CLI 走同一条 ⏭ 分支（C10-013）', () => {
  // 背景：`guardOrExit` 在 r.skipped 时曾直接 `return false`（零输出），三个生产入口拿到的
  // 结果与「已检查且干净」逐字相同；而 main() 调 inspect() 时不传 env，:483 的 ⏭ 分支是死代码
  // ⇒ 在变异评估子进程里直接跑 CLI 反而打印「✅ 主机干净」。这两处都让「门禁没跑」不可见。
  const entry = path.join(__dirname, 'scripts/check-host-clean.js')
  const guardProbe = 'const h=require(' + JSON.stringify(entry) + ');' +
    'const r=h.shouldAbortForDirtyHost({XBK_MUTATION_CHILD:"1"});process.stdout.write("\\nRET="+String(r))'
  const guardRun = spawnSync(process.execPath, ['-e', guardProbe], {
    encoding: 'utf8',
    env: { ...process.env, XBK_MUTATION_CHILD: '1' }
  })
  assert.ok(!guardRun.error, 'guardOrExit 探针未能启动: ' + (guardRun.error && guardRun.error.message))
  assert.strictEqual(guardRun.status, 0, '跳过路径不得改变退出码：' + guardRun.stderr)
  assert.match(guardRun.stdout, /⏭ 主机干净度检查跳过：XBK_MUTATION_CHILD=1（变异评估沙箱内）/,
    'guardOrExit 跳过时零输出 ⇒ 三个生产入口都不知道门禁没跑（跳过必须与 main 打同一行 ⏭）')
  assert.match(guardRun.stdout, /RET=false/, '跳过语义不变：仍返回 false（不阻断本次运行）')
  const cliRun = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    env: { ...process.env, XBK_MUTATION_CHILD: '1' }
  })
  assert.strictEqual(cliRun.status, 0, 'CLI 在跳过场景必须 exit 0: ' + cliRun.stderr)
  assert.match(cliRun.stdout, /⏭ 主机干净度检查跳过：XBK_MUTATION_CHILD=1/,
    'main() 必须把 env 传给 inspect()：否则 ⏭ 分支是死代码，变异子进程里 CLI 会谎报「✅ 主机干净」')
  assert.ok(!/✅ 主机干净/.test(cliRun.stdout),
    '跳过时不得打印「✅ 主机干净」：那是把「没检查」说成「检查过且干净」')
})

check('main() 的「不可判定」必须有独立结论，且不留不可达 return（C10-063）', () => {
  // 背景：ok 的定义已含 !unsupported（:346）⇒ `if (r.ok && !r.unsupported)` 冗余、末行 return 0 不可达；
  // 而 unsupported 时先打「❌ 主机不干净——墙钟基准会被这些残留拖红」再零条明细，读起来像扫到了残留。
  // 这里用 preload 让 /proc readdir 抛 ENOENT（与审计复现同一手法），从 CLI 端到端核对文案与退出码。
  const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-preload-')), 'no-proc.js')
  fs.writeFileSync(preload,
    "'use strict'\n" +
    "const fs = require('fs')\n" +
    'const orig = fs.readdirSync\n' +
    'fs.readdirSync = function (target, ...args) {\n' +
    "  if (String(target) === '/proc') { const e = new Error('no proc'); e.code = 'ENOENT'; throw e }\n" +
    '  return orig.call(this, target, ...args)\n' +
    '}\n')
  try {
    const run = spawnSync(process.execPath, ['-r', preload, path.join(__dirname, 'scripts/check-host-clean.js')],
      { encoding: 'utf8', env: probeEnv() })
    assert.strictEqual(run.status, 1, '读不到 /proc 仍必须 fail-closed（exit 1，语义不变）：' + run.stderr)
    assert.match(run.stdout, /该平台不检测/,
      'unsupported 必须单独一条「该平台不检测」，不得只说「主机不干净」')
    assert.ok(!/主机不干净——墙钟基准会被这些残留拖红/.test(run.stdout),
      'unsupported 时零条残留明细，却打「主机不干净——墙钟基准会被这些残留拖红」= 把「判不了」说成「扫到了残留」')
    assert.match(run.stdout, /无法判定主机是否干净/,
      '找不到明细时结论必须落在「无法判定」而不是「不干净」')
  } finally {
    fs.rmSync(path.dirname(preload), { recursive: true, force: true })
  }
  const src = read('scripts/check-host-clean.js')
  assert.ok(!/if \(r\.ok && !r\.unsupported\)/.test(src),
    'main() 不得保留冗余条件 `r.ok && !r.unsupported`：ok 的定义已含 !unsupported（:346）')
  const mainStart = src.indexOf('function main () {')
  assert.ok(mainStart > 0, '找不到 main()')
  const mainSrc = src.slice(mainStart, src.indexOf('\n}\n', mainStart))
  assert.ok(mainSrc.trimEnd().endsWith('return 1'),
    'main() 的最后一条语句必须是 `return 1`：末行 `return 0` 在 !ok 分支之后不可达（C10-063）')
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

check('cmdline 不可读必须计数并标不完整（C10-029：hidepid/跨用户不得静默假绿）', () => {
  // 背景：readProcs 对读不到的 pid 返回 { cmdline: '', ppid: -1 }，而孤儿判据先按 cmdline 匹配桩标记
  // ⇒ 不可读进程里的孤儿桩/孤儿套件整批消失，inspect 仍 ok=true（假绿）。修复 = 计数 + 标 incomplete，
  // 但**不**改变 ok（hidepid 主机上全部进程都不可读，判红等于让门禁在那种环境下永久误拦）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-gate-unreadable-'))
  const procRoot = path.join(root, 'proc')
  const tmpRoot = path.join(root, 'tmp')
  fs.mkdirSync(tmpRoot)
  const writeProc = (pid, ppid, marker) => {
    const dir = path.join(procRoot, pid)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'cmdline'), 'node\0' + marker + '\0')
    fs.writeFileSync(path.join(dir, 'stat'),
      `${pid} (node) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`)
  }
  writeProc('100', 1, 'worker.js')
  writeProc('200', 1, 'stub_heartbeat.js')
  const originalRead = fs.readFileSync
  const deny = (target, code) => {
    const e = new Error('read failed: ' + code)
    e.code = code
    throw e
  }
  let r
  fs.readFileSync = function (target, ...args) {
    if (String(target) === path.join(procRoot, '200', 'cmdline')) deny(target, 'EACCES')
    return originalRead.call(this, target, ...args)
  }
  try {
    r = host.inspect({ env: {}, procRoot, tmpRoot, selfPid: 1 })
  } finally {
    fs.readFileSync = originalRead
  }
  assert.deepStrictEqual(r.unreadableProcs, [{ pid: 200, errorCode: 'EACCES' }],
    'cmdline 读不到（EACCES）的进程必须被计数：静默给空 cmdline 会让它里面的孤儿桩永远扫不到')
  assert.strictEqual(r.incomplete, true, '有进程不可读时必须标 incomplete（「没扫到」≠「扫过且干净」）')
  assert.strictEqual(r.ok, true, '不可读只标不完整、不改 ok：hidepid 主机上判红等于门禁永久误拦')
  // 进程在读的过程中退出（ENOENT/ESRCH）是竞态，不是失明：不得计入不可读，否则每次扫描都会误报
  fs.readFileSync = function (target, ...args) {
    if (String(target) === path.join(procRoot, '200', 'cmdline')) deny(target, 'ENOENT')
    return originalRead.call(this, target, ...args)
  }
  let raced
  try {
    raced = host.inspect({ env: {}, procRoot, tmpRoot, selfPid: 1 })
  } finally {
    fs.readFileSync = originalRead
  }
  assert.deepStrictEqual(raced.unreadableProcs, [], 'ENOENT（进程刚退出）不得计为「不可读」')
  assert.strictEqual(raced.incomplete, false, '退出竞态不得把检测标成不完整')
  fs.rmSync(root, { recursive: true, force: true })

  // 端到端：CLI 在「全部 /proc cmdline 读不到」时不得再打「✅ 主机干净」，必须响亮标不完整
  const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-preload-')), 'deny-cmdline.js')
  fs.writeFileSync(preload,
    "'use strict'\n" +
    "const fs = require('fs')\n" +
    'const orig = fs.readFileSync\n' +
    'fs.readFileSync = function (target, ...args) {\n' +
    "  if (String(target).startsWith('/proc/') && String(target).endsWith('/cmdline')) {\n" +
    "    const e = new Error('denied'); e.code = 'EACCES'; throw e\n" +
    '  }\n' +
    '  return orig.call(this, target, ...args)\n' +
    '}\n')
  try {
    const run = spawnSync(process.execPath, ['-r', preload, path.join(__dirname, 'scripts/check-host-clean.js')],
      { encoding: 'utf8', env: probeEnv() })
    assert.strictEqual(run.status, 0, '不可读只标不完整、不改退出码：' + run.stderr)
    assert.match(run.stdout, /孤儿检测不完整/,
      'CLI 必须把「有进程不可读」说出来：否则输出与「全量扫过且干净」同形')
    assert.ok(!/✅ 主机干净/.test(run.stdout),
      '不可读时不得打印「✅ 主机干净」：孤儿检测对这批进程失明，结论不能读作全量已检查')
  } finally {
    fs.rmSync(path.dirname(preload), { recursive: true, force: true })
  }
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
  const specialPath = path.join(__dirname, 'review space; touch marker; #')
  assert.strictEqual(host.rmSuggestion([{ p: specialPath }]),
    "rm -rf '" + path.resolve(specialPath) + "'")
  const apostrophePath = path.join(__dirname, "reviewer's sandbox")
  const resolvedApostrophePath = path.resolve(apostrophePath)
  assert.strictEqual(host.rmSuggestion([{ p: apostrophePath }]),
    "rm -rf '" + resolvedApostrophePath.replaceAll("'", "'\\''") + "'")
  const relativeDashPath = '-tmp/xbk-example'
  assert.strictEqual(host.rmSuggestion([{ p: relativeDashPath }]), "rm -rf '" + path.resolve(relativeDashPath) + "'")
})

// C5-022：退出码必须由 summary() 决定——有失败即 1，全部通过才是 0。
process.exitCode = harness.summary()
