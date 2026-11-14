'use strict'

// v3.435：测试入口公共层（scripts/test-harness.js）的单元套件。
//
// 为什么需要一个专门的套件：run_tests.js 与 run_unit_tests.js 此前各有一份逐字相同的底层实现
// （displayWidth / padEndWidth / positiveIntEnv / 套件 env 准备 / 主机干净度 guard 加载 /
// 进程组杀伤），收敛成一份之后，任何「搬的时候改了一个字符」或「某个入口又偷偷长回一份」
// 都不会被任何现有套件发现——它们的断言都停在行为输出上，不看这两个文件怎么拿到这些能力。
//
// 覆盖（对应 spec 的「测试要求」）：
//   · displayWidth / padEndWidth：ASCII、中文、混合字符串，补齐宽度；
//   · positiveIntEnv：合法正整数 / 空串 / 非数字 / 负数 / 小数 / 0，非法值告警并回退；
//   · prepareSuiteEnv：只删 XBK_CACHE_DIR、其余键原样、cleared 回传原值、未设置时为空、不改入参；
//   · 主机 guard 加载：注入模块路径；不存在 → missing=true 且不抛；存在但内部抛错 → 照常抛出；
//   · killSuiteGroup：非法 pid 返回 false（绝不真杀当前测试进程组）；
//   · 接线：两个入口只 require harness，不再各自定义公共层、也不再各自做 host-clean 解析预判。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  displayWidth,
  padEndWidth,
  positiveIntEnv,
  FALLBACK_STRIP_CACHE_DIR_ENV,
  prepareSuiteEnv,
  loadHostCleanGuard,
  killSuiteGroup
} = require('./scripts/test-harness')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')

// 与 test_host_clean_gates.js / test_doc_line_gates.js 同形的逐条检查器：一条抛错只记失败，
// 后续检查照跑，末尾汇总并给出退出码（裸调用会让第一条失败吞掉整份文件的结论）。
function createChecker (out) {
  const log = (out && out.log) || ((s) => console.log(s))
  let passed = 0
  const failures = []
  return {
    check (label, fn) {
      try {
        fn()
        passed++
        log('✅ ' + label)
      } catch (e) {
        const message = (e && e.message) || String(e)
        failures.push({ label, message })
        log('❌ ' + label + '：' + message)
      }
    },
    summary () {
      if (failures.length === 0) {
        log(`✅ test_test_harness 全部通过（${passed} 检查）`)
        return 0
      }
      log(`❌ test_test_harness：${passed} 通过 / ${failures.length} 失败（共 ${passed + failures.length} 检查）`)
      for (const f of failures) log('   ❌ ' + f.label + '：' + f.message)
      return 1
    }
  }
}

const checks = createChecker()
const check = checks.check

// 抓 console.warn（positiveIntEnv 与 prepareSuiteEnv 的告警默认走它），返回 { lines, restore }：
// 断言文案逐字，而不是「大概打了点什么」。
function captureWarn (fn) {
  const lines = []
  const orig = console.warn
  console.warn = (...args) => { lines.push(args.join(' ')) }
  try {
    return { value: fn(), lines }
  } finally {
    console.warn = orig
  }
}

// ---------- displayWidth / padEndWidth ----------
check('displayWidth：ASCII 按 1 列计', () => {
  assert.strictEqual(displayWidth('abc'), 3)
  assert.strictEqual(displayWidth(''), 0)
  assert.strictEqual(displayWidth('test_filter.js'), 'test_filter.js'.length)
})

check('displayWidth：中文每字按 2 列计（含全角标点）', () => {
  assert.strictEqual(displayWidth('中文'), 4)
  assert.strictEqual(displayWidth('推送'), 4)
  // 全角 Ａ（U+FF21，FF00-FF60 段）同样是 2 列
  assert.strictEqual(displayWidth('Ａ'), 2)
})

check('displayWidth：中英混合按各字符宽度累加', () => {
  assert.strictEqual(displayWidth('a中b'), 4)
  assert.strictEqual(displayWidth('中文abc'), 7)
  assert.strictEqual(displayWidth('test_中文.js'), 12)
})

check('padEndWidth：按显示宽度补齐（不是按 UTF-16 码元）', () => {
  assert.strictEqual(padEndWidth('abc', 5), 'abc  ')
  const padded = padEndWidth('中文', 6)
  assert.strictEqual(padded, '中文  ', '中文占 4 列，补到 6 列应补 2 个空格')
  assert.strictEqual(displayWidth(padded), 6, '补齐后显示宽度必须恰好等于目标宽度')
  assert.strictEqual(displayWidth(padEndWidth('abc', 6)), 6)
})

check('padEndWidth：目标宽度不大于现有宽度时不截断、不补负空格', () => {
  assert.strictEqual(padEndWidth('中文', 4), '中文')
  assert.strictEqual(padEndWidth('中文', 2), '中文', 'width 小于显示宽度必须原样返回（不得抛 RangeError）')
  assert.strictEqual(padEndWidth('abc', 0), 'abc')
})

// ---------- positiveIntEnv ----------
check('positiveIntEnv：合法正整数按整数返回，空串/未设置静默回退', () => {
  assert.strictEqual(positiveIntEnv('XBK_T_VALID', 42, { XBK_T_VALID: '7' }), 7)
  assert.strictEqual(positiveIntEnv('XBK_T_VALID', 42, { XBK_T_VALID: 7 }), 7)
  const missing = captureWarn(() => positiveIntEnv('XBK_T_MISSING', 42, {}))
  assert.strictEqual(missing.value, 42, '未设置时必须回退默认值')
  assert.deepStrictEqual(missing.lines, [], '未设置不是非法值，不得告警')
  const empty = captureWarn(() => positiveIntEnv('XBK_T_EMPTY', 42, { XBK_T_EMPTY: '' }))
  assert.strictEqual(empty.value, 42, '空串按未设置处理')
  assert.deepStrictEqual(empty.lines, [], '空串不得告警（与两个入口的既有口径一致）')
})

check('positiveIntEnv：非数字 / 负数 / 小数 / 0 一律告警并回退默认', () => {
  for (const raw of ['abc', '-3', '1.5', '0', 'NaN', 'Infinity']) {
    const captured = captureWarn(() => positiveIntEnv('XBK_T_BAD', 42, { XBK_T_BAD: raw }))
    assert.strictEqual(captured.value, 42, `${JSON.stringify(raw)} 必须回退默认值`)
    assert.strictEqual(captured.lines.length, 1, `${JSON.stringify(raw)} 必须告警且只告警一次`)
    assert.strictEqual(captured.lines[0],
      `⚠️  环境变量 XBK_T_BAD=${raw} 非法（应为正整数），已回退默认值 42`,
      '告警文案必须逐字保持（两个入口原先各有一份同文案，运维侧按它排查）')
  }
})

// ---------- 套件子进程 env ----------
check('prepareSuiteEnv：只删 XBK_CACHE_DIR，其余键原样，cleared 回传原值', () => {
  const input = { XBK_CACHE_DIR: '/deploy/cache', KEEP: '1', PATH: '/usr/bin', EMPTY: '' }
  const { env, cleared } = captureWarn(() => prepareSuiteEnv(input)).value
  assert.strictEqual(env.XBK_CACHE_DIR, undefined, '剥离后不得残留 XBK_CACHE_DIR')
  assert.strictEqual(cleared, '/deploy/cache', '必须回传被清除的原值（入口据此告警）')
  assert.deepStrictEqual(
    { ...env },
    { KEEP: '1', PATH: '/usr/bin', EMPTY: '' },
    '其余环境变量必须原样保留（多删一个键就等于改了子进程的运行时环境）')
  assert.strictEqual(input.XBK_CACHE_DIR, '/deploy/cache', '不得原地修改入参（process.env 只由显式 API 改）')
})

check('prepareSuiteEnv：未设置该变量时 cleared 为空，且不得凭空造键', () => {
  const { env, cleared } = prepareSuiteEnv({ KEEP: '1' })
  assert.strictEqual(cleared, '')
  assert.strictEqual('XBK_CACHE_DIR' in env, false)
  assert.strictEqual(prepareSuiteEnv({ XBK_CACHE_DIR: '' }).cleared, '', '空值按「未设置」处理（不算泄漏）')
})

check('prepareSuiteEnv：清除原值时必须打出一次性警告（文案逐字）', () => {
  const captured = captureWarn(() => prepareSuiteEnv({ XBK_CACHE_DIR: '/deploy/cache' }))
  assert.strictEqual(captured.lines.length, 1, '有原值时必须告警且只告警一次')
  assert.strictEqual(captured.lines[0],
    '⚠️ 已从本入口派生的测试子进程环境中清除 XBK_CACHE_DIR（/deploy/cache）：测试只用 Config.cache.dir 的私有目录，避免写入部署缓存（backlog C3-002）',
    '告警文案是两个入口共用的对外契约（排障时要能一眼看出这次跑的缓存目录与 shell 里设的不一样）')
  assert.deepStrictEqual(captureWarn(() => prepareSuiteEnv({})).lines, [], '无原值时不得告警')
})

check('FALLBACK_STRIP_CACHE_DIR_ENV：最小工作树的内联回退与正式实现同口径', () => {
  const input = { XBK_CACHE_DIR: '/x', KEEP: '1' }
  const { env, cleared } = FALLBACK_STRIP_CACHE_DIR_ENV(input)
  assert.strictEqual(cleared, '/x')
  assert.deepStrictEqual({ ...env }, { KEEP: '1' })
  assert.strictEqual(input.XBK_CACHE_DIR, '/x', '回退实现同样不得原地修改入参')
  assert.deepStrictEqual({ ...FALLBACK_STRIP_CACHE_DIR_ENV(null).env }, {}, 'null 入参按空对象处理')
})

// ---------- 主机干净度 guard 加载 ----------
check('loadHostCleanGuard：默认路径加载真实门禁（missing=false）', () => {
  const { hostClean, missing } = loadHostCleanGuard()
  assert.strictEqual(missing, false, '仓库里 scripts/check-host-clean.js 一定存在，不得报 missing')
  assert.ok(hostClean, '必须返回门禁模块')
  assert.strictEqual(typeof hostClean.shouldAbortForDirtyHost, 'function',
    '返回的必须是真门禁（名字见 C10-068：返回布尔而不是替调用方退出）')
})

check('loadHostCleanGuard：模块自身不存在 → missing=true 且不抛，并响亮打印跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-harness-guard-missing-'))
  try {
    const lines = []
    const r = loadHostCleanGuard({ modulePath: path.join(dir, 'check-host-clean.js'), log: (s) => lines.push(s) })
    assert.strictEqual(r.missing, true, '最小工作树（无门禁脚本）必须判 missing')
    assert.strictEqual(r.hostClean, null, 'missing 时不得返回半个模块')
    assert.deepStrictEqual(lines,
      ['⚠️ 未找到 scripts/check-host-clean.js，跳过主机干净度前置检查（不影响本次运行）'],
      '跳过必须响亮且只打一行（静默通过会让「门禁没跑」与「已检查且干净」长得一样）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('loadHostCleanGuard：门禁存在但内部依赖缺失 → 照常抛出，不得伪装成「脚本不存在」（C10-028）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-harness-guard-broken-'))
  try {
    fs.writeFileSync(path.join(dir, 'check-host-clean.js'),
      "'use strict'\nrequire('./missing-dep')\nmodule.exports = { shouldAbortForDirtyHost: () => false }\n")
    const lines = []
    assert.throws(
      () => loadHostCleanGuard({ modulePath: path.join(dir, 'check-host-clean.js'), log: (s) => lines.push(s) }),
      /missing-dep/,
      '模块内部依赖缺失必须把真正的缺失模块报出来（旧实现会读成「脚本不存在」并静默关掉门禁）')
    assert.deepStrictEqual(lines, [], '内部依赖缺失不是最小工作树，不得打印跳过文案')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('loadHostCleanGuard：注入路径必须指向 check-host-clean.js（否则响亮拒绝）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-harness-guard-name-'))
  try {
    fs.writeFileSync(path.join(dir, 'other-name.js'), 'module.exports = {}\n')
    assert.throws(() => loadHostCleanGuard({ modulePath: path.join(dir, 'other-name.js') }),
      /check-host-clean\.js/,
      '注入只改变解析基准目录；文件名固定，命名不符时必须拒绝（否则会静默加载另一个文件）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 进程组杀伤 ----------
check('killSuiteGroup：非法 pid 一律返回 false，且绝不真发信号', () => {
  // 只喂非法形态：正整数 pid 会真的 kill(-pid)，本套件不能拿任何真实进程组试刀
  // （尤其是 process.pid —— kill(-process.pid) 会打掉本套件所在的进程组）。
  for (const pid of [0, -1, -12345, 1.5, NaN, Infinity, '5', null, undefined, {}, []]) {
    assert.strictEqual(killSuiteGroup(pid), false, `pid=${String(pid)} 必须返回 false（不抛错）`)
  }
})

// ---------- 接线：公共层只有一份 ----------
// spec 的验收第一条：两个入口不再各自定义公共层。这里按源码形状锁定——否则「又复制一份」不会有任何
// 行为断言变红（两份实现一开始逐字相同时，跑什么都是绿的）。
const ENTRIES = ['run_tests.js', 'run_unit_tests.js']
const DUPLICATED = [
  { needle: 'function displayWidth (', label: 'displayWidth' },
  { needle: 'function padEndWidth (', label: 'padEndWidth' },
  { needle: 'function positiveIntEnv (', label: 'positiveIntEnv' },
  { needle: 'FALLBACK_STRIP_CACHE_DIR_ENV', label: 'FALLBACK_STRIP_CACHE_DIR_ENV' },
  { needle: 'function killSuiteGroup (', label: 'killSuiteGroup' },
  { needle: 'stripCacheDirEnv', label: 'stripCacheDirEnv 解析' },
  { needle: 'require.resolve(HOST_CLEAN_MODULE)', label: 'host-clean 解析预判' }
]

check('接线：两个入口都 require 公共层，且不再各自定义公共层实现', () => {
  const harnessSrc = read('scripts/test-harness.js')
  for (const needle of ['function displayWidth (', 'function padEndWidth (', 'function positiveIntEnv (',
    'function prepareSuiteEnv (', 'function loadHostCleanGuard (', 'function killSuiteGroup (']) {
    const hits = harnessSrc.split(needle).length - 1
    assert.strictEqual(hits, 1, `scripts/test-harness.js 必须恰好有一份 ${needle}（实得 ${hits}）`)
  }
  for (const entry of ENTRIES) {
    const src = read(entry)
    assert.ok(src.includes("require('./scripts/test-harness')"),
      `${entry} 必须 require('./scripts/test-harness')（公共层的唯一入口）`)
    for (const d of DUPLICATED) {
      assert.strictEqual(src.includes(d.needle), false,
        `${entry} 不得再定义 ${d.label}：公共层已收敛到 scripts/test-harness.js（两份实现会静默漂移）`)
    }
    assert.match(src, /^if \(hostClean && hostClean\.shouldAbortForDirtyHost\(process\.env\)\) process\.exit\(1\)$/m,
      `${entry} 仍必须自己执行主机干净度 guard（删掉这一行等于门禁失效）`)
    assert.match(src, /const SUITE_ENV = prepareSuiteEnv\(process\.env\)\.env/,
      `${entry} 必须用公共层准备套件 env`)
    assert.match(src, /env:\s*SUITE_ENV/, `${entry} 必须把剥离后的 env 传给套件子进程`)
  }
})

check('接线：公共层的告警文案只在 harness 一处（入口不得各留一份）', () => {
  const harnessSrc = read('scripts/test-harness.js')
  const warnText = '已从本入口派生的测试子进程环境中清除 XBK_CACHE_DIR'
  assert.strictEqual(harnessSrc.split(warnText).length - 1, 1, 'harness 必须恰好有一份套件 env 告警文案')
  for (const entry of ENTRIES) {
    assert.strictEqual(read(entry).includes(warnText), false, `${entry} 不得再保留一份告警文案`)
  }
})

process.exitCode = checks.summary()
