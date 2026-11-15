'use strict'

// v3.444：反回归闸自身的用例（scripts/check-source-text-asserts.js + scripts/probe-format-coupling.js）。
//
// 为什么必须单独有一套：这道闸是「禁止测试里新增读源码文本断言」的门禁，闸门本身的漏检不会让任何东西变红
// ——旧实现（文件级变量名集合 + 正则）就是这样：`if (!vars.size) return []` 让整份「无声明、行内直读」的
// 文件被跳过，helper 链 / 模板字符串 / `/re/.test(src)` / `src.match(/re/)` / 多跳赋值 / 重赋值 / 函数参数
// / split 后的行 / `codeOf(var)` 套壳全部不命中，而输出仍然好看（857/857 全绿）。
// 下面每条用例都对着一个**已实测过的漏检形态**：正向必红，反向（不是源码文本的 receiver）必绿。
//
// 全部在 `fs.mkdtempSync(os.tmpdir(), 'xbk-assertgate-')` 建的隔离工作区里跑：复制闸脚本进去、给
// node_modules 软链、夹具全都写在那里面，跑完 rmSync 删掉——不在仓库根留任何垃圾，也不碰真实白名单。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname)
const CHECKER = path.join(ROOT, 'scripts', 'check-source-text-asserts.js')
const PROBE = path.join(ROOT, 'scripts', 'probe-format-coupling.js')
// 字面量相对路径 require（Codacy/Opengrep「非字面量 require」）：与本文件其它 require 同口径，
// 解析结果与 require(CHECKER) 完全相同——CHECKER/PROBE 两个常量仍留给 copyFileSync / spawn 用。
const { analyzeSource, compareMultiset } = require('./scripts/check-source-text-asserts.js')

// 与 test_ci_static_gates.js / test_doc_line_gates.js 同一套 harness 形态：每条检查独立捕获，
// passed/failed 双计数，末尾统一汇总并置非零退出码（harness 自身也有用例，见文件末尾）。
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
        log(`✅ test_check_source_text_asserts 全部通过（${passed} 检查）`)
        return 0
      }
      log(`❌ test_check_source_text_asserts：${passed} 通过 / ${failures.length} 失败（共 ${passed + failures.length} 检查）`)
      for (const f of failures) log('   ❌ ' + f.label + '：' + f.message)
      return 1
    }
  }
}

const harness = createChecker()
const check = harness.check

// ── 隔离工作区 ────────────────────────────────────────────────────────────
const workspaces = []

function makeWorkspace () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-assertgate-'))
  workspaces.push(dir)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true }) // nosemgrep（路径 = mkdtemp 结果 + 本文件硬编码的 'scripts'，无外部净输入）
  // 闸门脚本整份复制：ROOT 由 __dirname/.. 推出 ⇒ 副本把工作区当成仓库根，绝不碰真实仓库。
  fs.copyFileSync(CHECKER, path.join(dir, 'scripts', 'check-source-text-asserts.js'))
  fs.copyFileSync(PROBE, path.join(dir, 'scripts', 'probe-format-coupling.js'))
  // acorn 从仓库的 node_modules 借（与工作树的软链同一做法），不装任何依赖。
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir') // nosemgrep（ROOT = __dirname 常量，dir = mkdtemp 结果，无外部净输入）
  return dir
}

function write (dir, rel, text) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true }) // nosemgrep（abs = mkdtemp 工作区 + 本文件硬编码的相对路径，无外部净输入）
  fs.writeFileSync(abs, text) // nosemgrep（同上：只写隔离工作区里的夹具，跑完 rmSync）
  return abs
}

function run (dir, script, args) {
  const result = spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, TZ: 'UTC' }
  })
  return { status: result.status, out: (result.stdout || '') + (result.stderr || '') }
}

const runChecker = (dir, ...args) => run(dir, 'check-source-text-asserts.js', args)
const runProbe = (dir, ...args) => run(dir, 'probe-format-coupling.js', args)
const allowlistOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), 'utf8')) // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码段，无外部净输入）
const lines = (...parts) => parts.join('\n') + '\n'

// 排序口径（SonarCloud S2871）：`sort()` 不带比较器＝按 String 化后的默认字典序，是 BUG 级告警。
// 这里显式给一个比较器，且**左右两侧共用同一个**——比的是「多重集对账的结果」，两侧口径必须一致，
// 否则同样的两条数据会因排序不同而假红（这两条元组的首字符就不同，比较结果与默认排序一致）。
const byString = (x, y) => String(x).localeCompare(String(y))

// ── A. 检测面：每个漏检形态单独一条（正向必红） ────────────────────────────
// 期望值 = 命中字面量数组（顺序按行号）。`file` 参数只用于错误信息，与分析结果无关。
const POSITIVE = [
  ['行内直读（无任何变量声明：旧实现 !vars.size 直接跳过整份文件）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "assert.ok(fs.readFileSync('a.js', 'utf8').includes('INLINE'))"), ['INLINE']],
  ['helper 返回值链式（readConsoleSource() 形态：先 map+join 再 includes）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "function readConsoleSource () { return ['a.js'].map((f) => fs.readFileSync(f, 'utf8')).join('\\n') }",
      "assert.ok(readConsoleSource().includes('HELPER'))"), ['HELPER']],
  ['helper 箭头表达式体（f => fs.readFileSync(f)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const readSrc = () => fs.readFileSync('a.js', 'utf8')",
      "assert.ok(readSrc().includes('ARROW'))"), ['ARROW']],
  ['模板字符串字面量（src.includes(`…`)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.ok(src.includes(`TEMPLATE`))'), ['TEMPLATE']],
  ['正则字面量做 receiver（/re/.test(src)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.ok(/function\\s+foo\\s*\\(/.test(src))'), ['/function\\s+foo\\s*\\(/']],
  ['正则字面量做实参（src.match(/re/)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.ok(src.match(/export\\s+const/))'), ['/export\\s+const/']],
  ['assert.match(src, /re/)（断言库形态的同一件事）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.match(src, /AM/)'), ['/AM/']],
  ['多跳赋值（buf → toString → src）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const buf = fs.readFileSync('a.js')",
      "const src = buf.toString('utf8')",
      "assert.ok(src.includes('MULTIHOP'))"), ['MULTIHOP']],
  ['let 先声明后重赋值（let src; src = readFileSync(…)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'let src',
      "src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(src.includes('REASSIGN'))"), ['REASSIGN']],
  ['函数参数（function check(src) { src.includes(…) } 由调用点传入源码文本）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "function check (src) { assert.ok(src.includes('PARAM')) }",
      "check(fs.readFileSync('a.js', 'utf8'))"), ['PARAM']],
  ['split 后的行（forEach 回调形参）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "src.split('\\n').forEach((line) => { assert.ok(line.includes('SPLIT')) })"), ['SPLIT']],
  ['split 后的行（find 回调形参）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const hit = src.split('\\n').find((line) => line.startsWith('FIND'))"), ['FIND']],
  ['for…of 逐行（循环变量）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "for (const line of src.split('\\n')) { assert.ok(line.includes('FOROF')) }"), ['FOROF']],
  ['codeOf(var) 套壳（本地 codeOf 由参数污染、返回值继续污染）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'const codeOf = (text) => text.trim()',
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(codeOf(src).includes('CODEOF'))"), ['CODEOF']],
  ['解构 require 出来的 readFileSync',
    lines("const { readFileSync } = require('node:fs')", "const assert = require('node:assert')",
      "const text = readFileSync('a.js', 'utf8')",
      "assert.ok(text.includes('DESTRUCTURE'))"), ['DESTRUCTURE']],
  ['helper 里读文件再 return（function load() { const s = readFileSync(); return s }）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "function load () { const s = fs.readFileSync('a.js', 'utf8'); return s }",
      "assert.ok(load().includes('LOADER'))"), ['LOADER']],
  ['同一字面量两次必须记两条（多重集，不是 Set）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(src.includes('DUP'))",
      "assert.ok(src.includes('DUP'))"), ['DUP', 'DUP']]
]

// ── B. 反向：receiver 不是源码文本就必须不命中（否则误报会把基线灌满） ──────
const NEGATIVE = [
  ['HTTP 响应体的 .text（res.text.includes：旧实现按文件级变量名误判的 44 条之一）',
    lines("const assert = require('node:assert')",
      "async function request () { return { text: 'xbk-push 控制台' } }",
      'const res = await request()',
      "assert.ok(res.text.includes('xbk-push 控制台'))"), []],
  ['同名局部变量只在自己的作用域里生效（另一函数的 text 形参不得被污染）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "function a () { const text = fs.readFileSync('a.js', 'utf8'); return text.length }",
      "function b (text) { assert.ok(text.includes('SHADOWED')) }"), []],
  ['JSON.parse 之后是数据不是源码文本（配置断言必须放行）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))",
      "assert.ok(pkg.scripts.check.includes('assert-style'))"), []],
  ['普通字符串/数组上的 includes（与源码无关）',
    lines("const assert = require('node:assert')",
      "const s = 'hello world'",
      "const arr = ['x', 'y']",
      "assert.ok(s.includes('hello'))",
      "assert.ok(arr.includes('x'))"), []]
]

// ── A/B 执行：17 个正向形态 + 4 个反向形态 ─────────────────────────────────
check('检测面：17 种「读源码文本」写法逐个命中（含旧实现漏检的 16 种）', () => {
  const missed = POSITIVE.filter(([, code, expected]) => {
    const got = analyzeSource(code, 'positive.js').map((hit) => hit.literal)
    return JSON.stringify(got) !== JSON.stringify(expected)
  }).map(([label, code, expected]) => {
    const got = analyzeSource(code, 'positive.js').map((hit) => hit.literal)
    return `${label}: 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(got)}`
  })
  assert.deepStrictEqual(missed, [], '以下形态没被识别（漏检 = 这条闸门对这些写法形同不存在）：\n' + missed.join('\n'))
})

check('反向：receiver 不是源码文本时一律不命中（res.text / 遮蔽 / JSON.parse / 普通字符串）', () => {
  const wrong = NEGATIVE.filter(([, code]) => analyzeSource(code, 'negative.js').length > 0)
    .map(([label, code]) => `${label}: ${JSON.stringify(analyzeSource(code, 'negative.js').map((h) => h.literal))}`)
  assert.deepStrictEqual(wrong, [], '以下形态被误判成源码文本断言（会把基线灌满噪声）：\n' + wrong.join('\n'))
})

check('扫描面包含 test_support/**/*.js（旧实现只看仓库根 test_*.js）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_root.js', lines("const assert = require('node:assert')", 'assert.ok(1 === 1)'))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_support/helper.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('x.js', 'utf8')",
    "module.exports = () => src.includes('IN_HELPER')"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, 'test_support/ 里的命中必须判红：' + result.out)
  assert.ok(result.out.includes('test_support/helper.js'), '必须点名 test_support/helper.js：' + result.out)
})

// ── 退出码语义（F1 / F3 / 形状校验 / 少数提示） ─────────────────────────────
const FIXTURE_OK = [
  "const fs = require('node:fs')",
  "const src = fs.readFileSync('a.js', 'utf8')",
  "module.exports = () => src.includes('FIRST')"
].join('\n') + '\n'

check('退出码 1：新增一处行内直读即红，并点名 file:line 与字面量（F1 回归）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  assert.strictEqual(runChecker(dir).status, 0, '刚写完基线必须绿')
  // 纯行内直读：文件里没有任何「读文件 → 变量」的声明，旧实现 `if (!vars.size) return []` 直接跳过。
  write(dir, 'test_inline.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "assert.ok(fs.readFileSync('a.js', 'utf8').includes('INLINE_NEW'))"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '新增行内直读必须 exit 1：' + result.out)
  assert.ok(/test_inline\.js:3\b/.test(result.out), '必须点名 test_inline.js:3：' + result.out)
  assert.ok(result.out.includes('INLINE_NEW'), '必须点名新增字面量：' + result.out)
})

check('退出码 1：同一 (文件,字面量) 出现次数超过白名单即红（多重集，F3 回归）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_dup.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('DUP')"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  const frozen = allowlistOf(dir)
  assert.strictEqual(frozen.count, 1, '基线应冻结 1 条')
  assert.strictEqual(runChecker(dir).status, 0, '一条对一条必须绿')
  // 同一文件再写一次同一字面量：Set 语义会放行（旧实现），多重集必须判红。
  write(dir, 'test_dup.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('DUP') && src.includes('DUP')"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '同一字面量重复出现必须 exit 1（旧实现 2 / 1 仍绿）：' + result.out)
  assert.ok(/实测 2 次 \/ 允许 1 次/.test(result.out), '必须点名「实测 2 次 / 允许 1 次」：' + result.out)
})

check('退出码 2：白名单 count 与 items.length 漂移（手删条目不改计数）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  const file = path.join(dir, 'scripts', 'source-text-assert.allowlist.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) // nosemgrep（file = mkdtemp 结果 + 本文件硬编码的 scripts/…json，无外部净输入）
  data.count += 1
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n') // nosemgrep（同上：写回隔离工作区里的白名单副本，不碰真实仓库）
  const result = runChecker(dir)
  assert.strictEqual(result.status, 2, '形状非法必须 exit 2：' + result.out)
  assert.ok(/计数漂移/.test(result.out), '必须提示计数漂移：' + result.out)
})

check('实测少于白名单只提示、不判红，且文案不得出现负数', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  write(dir, 'test_drop.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('b.js', 'utf8')",
    "module.exports = () => src.includes('DROPPED')"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  write(dir, 'test_drop.js', lines("const assert = require('node:assert')", 'assert.ok(1 === 1)'))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 0, '实测变少不能判红：' + result.out)
  assert.ok(/实测比白名单少 1 条/.test(result.out), '必须提示「实测比白名单少 1 条」：' + result.out)
  assert.ok(!/多 -\d+ 条/.test(result.out), '不得出现「比实测多 -N 条」这类负数文案：' + result.out)
})

check('退出码 2：测试文件解析失败必须 fail-closed（不得静默当成「零命中」）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_broken.js', lines('const x = {', '  a: 1', 'assert.ok(x.a)'))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 2, '解析失败必须 exit 2：' + result.out)
  assert.ok(/扫描失败 test_broken\.js/.test(result.out), '必须点名解析失败的文件：' + result.out)
})

check('compareMultiset：超出/不足/缺失三种关系都按「次数」算', () => {
  const measured = [['a.js', 'X'], ['a.js', 'X'], ['a.js', 'Y'], ['b.js', 'Z']].map(([file, literal]) => ({ file, literal }))
  const allowed = { items: [['a.js', 'X'], ['b.js', 'Z'], ['b.js', 'Z'], ['c.js', 'W']].map(([file, literal]) => ({ file, literal })) }
  const { violations, shortfalls } = compareMultiset(measured, allowed)
  assert.deepStrictEqual(violations.map((v) => [v.file, v.literal, v.count, v.allowed]),
    [['a.js', 'X', 2, 1], ['a.js', 'Y', 1, 0]], '实测 > 允许即违规（含「允许 0」的新增）')
  assert.deepStrictEqual(shortfalls.map((m) => [m.file, m.literal, m.count, m.allowed]).sort(byString),
    [['b.js', 'Z', 1, 2], ['c.js', 'W', 0, 1]].sort(byString), '实测 < 允许只记「少了」，不违规')
})

check('回归：拼接锚点 / 块内重赋值 / `return false` 兜底不得把真断言判没', () => {
  // ① `src.includes('A' + x)`：锚点是字符串前缀（旧闸门同口径），不得因为「不是单一字面量」整条消失。
  const concat = analyzeSource(lines(
    "const fs = require('fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "const tag = 'x'",
    "assert.ok(src.includes('onReady=$' + '{onSysReady}'), '拼接锚点')",
    "assert.ok(src.includes('data-mk=$' + tag))"
  ), 'concat.js')
  assert.deepStrictEqual(concat.map((h) => h.literal), ['onReady=$', 'data-mk=$'],
    '拼接断言必须取最左字面量：' + JSON.stringify(concat))

  // ② `let text = ''; try { text = readFileSync(...) }`：块内赋值必须落到外层绑定，否则块外的
  //    `text.includes(...)` 看不到污染——test_filter_store.js:101 的插桩守卫正是这种形状。
  const reassign = analyzeSource(lines(
    "const fs = require('fs')",
    "let text = ''",
    'try {',
    "  text = fs.readFileSync('scripts/console.js', 'utf8')",
    "} catch (e) { text = '' }",
    "if (text.includes('stryMutAct_')) console.log('instrumented')"
  ), 'reassign.js')
  assert.deepStrictEqual(reassign.map((h) => h.literal), ['stryMutAct_'],
    '块内重赋值必须传播污染：' + JSON.stringify(reassign))

  // ③ 返回源码文本的 helper + `return false` 兜底：它仍是「切块后比对」的真断言（test_app.js 的
  //    extractBlock 就是 `if (a < 0 || b < 0) return ''`），不得因为「返回了文本」把锚点当实现细节跳过。
  const reader = analyzeSource(lines(
    "const fs = require('fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'const blockOf = (text) => {',
    "  const at = text.indexOf('const CACHE_SHARD_ID_RE =')",
    "  const end = text.indexOf('function buildCacheShard (', at)",
    '  if (at < 0 || end < 0) return false',
    '  return text.slice(at, end)',
    '}',
    "assert.ok(blockOf(src), '同源块必须存在')"
  ), 'reader.js')
  assert.deepStrictEqual(reader.map((h) => h.literal), ['const CACHE_SHARD_ID_RE =', 'function buildCacheShard ('],
    '切块 helper 里的锚点必须计入：' + JSON.stringify(reader))
})

// ── C. 格式耦合探针（F6 回归） ─────────────────────────────────────────────
// 动机锚点：`src.includes('function messagesCacheName (')`——以 `(` 结尾，重排只要不动
// `(` 前的空白，锚点就不会失配，探针假绿。
const ANCHOR_TEST = [
  "const assert = require('node:assert')",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const src = fs.readFileSync(path.join(__dirname, 'prod.js'), 'utf8')",
  "assert.ok(src.includes('function messagesCacheName ('), '锚点必须原样存在')",
  "console.log('anchor ok')"
].join('\n') + '\n'
const CLEAN_TEST = [
  "const assert = require('node:assert')",
  'assert.strictEqual(1 + 1, 2)',
  "console.log('clean ok')"
].join('\n') + '\n'
const PROD_SOURCE = [
  'function messagesCacheName (name) {',
  '  const map = { a: 1, b: 2 }',
  '  return name || map',
  '}',
  'module.exports = { messagesCacheName }'
].join('\n') + '\n'

function probeWorkspace () {
  const dir = makeWorkspace()
  write(dir, 'prod.js', PROD_SOURCE)
  return dir
}

check('探针：锚点以 `(` 结尾的测试必须判 format-coupled（只插 `,`/`(` 之后的旧重排在这里假绿）', () => {
  const dir = probeWorkspace()
  write(dir, 'test_anchor.js', ANCHOR_TEST)
  write(dir, 'test_clean.js', CLEAN_TEST)
  const result = runProbe(dir, 'test_anchor.js')
  assert.strictEqual(result.status, 1, '锚点以 ( 结尾 ⇒ 重排后必然失配 ⇒ exit 1：' + result.out)
  assert.ok(/test_anchor\.js\s+format-coupled/.test(result.out), '必须判 test_anchor.js 为 format-coupled：' + result.out)
})

check('探针：不读源码文本的测试必须判 format-clean（收紧扰动不得顺手判死所有测试）', () => {
  const dir = probeWorkspace()
  write(dir, 'test_clean.js', CLEAN_TEST)
  const result = runProbe(dir, 'test_clean.js')
  assert.strictEqual(result.status, 0, '纯行为断言必须 format-clean：' + result.out)
  assert.ok(/test_clean\.js\s+format-clean/.test(result.out), '必须判 format-clean：' + result.out)
})

check('探针：跑完必须逐字节还原生产文件（重排不得留在工作树里）', () => {
  const dir = probeWorkspace()
  write(dir, 'test_clean.js', CLEAN_TEST)
  const before = fs.readFileSync(path.join(dir, 'prod.js'), 'utf8') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'prod.js'，无外部净输入）
  assert.strictEqual(runProbe(dir, 'test_clean.js').status, 0)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'prod.js'), 'utf8'), before, // nosemgrep（同上：读隔离工作区里的夹具，比对探针是否逐字节还原）
    '探针必须把 prod.js 还原成原文（try/finally + 备份）')
})

check('reformat：`(`、`)`、`,`、`{`、`}` 边界都被扰动，且跨行模板内容不被改坏', () => {
  const { reformat } = require('./scripts/probe-format-coupling.js')
  const code = lines(
    'function f (a, b) {',
    '  return a && b',
    '}',
    'const t = `第一行',
    '  第二行 ${1 + 1}', // eslint-disable-line no-template-curly-in-string
    '  第三行`'
  )
  const out = reformat(code, 'x.js')
  const shown = JSON.stringify(out)
  assert.notStrictEqual(out, code, '重排必须真的改变文本')
  assert.ok(out.includes('f  ('), '`(` 前的空白必须被扰动（否则以 `(` 结尾的锚点根本不会失配）：' + shown)
  assert.ok(out.includes('( a'), '`(` 后的空白必须被扰动：' + shown)
  assert.ok(out.includes(',  b'), '`,` 后的空白必须被扰动：' + shown)
  assert.ok(out.includes('b )'), '`)` 前的空白必须被扰动：' + shown)
  assert.ok(out.includes('{ '), '`{` 后的空白必须被扰动：' + shown)
  assert.ok(out.includes(' }'), '`}` 前的空白必须被扰动：' + shown)
  // 跨行模板的内容行（第 2、3 行）行首两个空格是字符串内容，不得被重缩进成 4 个空格。
  assert.ok(out.includes('`第一行\n  第二行 '), '跨行模板的中间行不得被重缩进（那是运行期数据）：' + shown)
  assert.ok(out.includes('\n  第三行`'), '跨行模板的末行不得被重缩进：' + shown)
})

check('harness 自身：一条检查抛错只记失败，后续照跑、汇总为 1', () => {
  assert.strictEqual(check, harness.check, '全局 check 必须直接取自 harness.check')
  const logged = []
  const probe = createChecker({ log: (s) => logged.push(s) })
  probe.check('通过的检查', () => {})
  probe.check('抛错的检查', () => { throw new Error('boom') })
  probe.check('抛错之后的检查', () => { logged.push('AFTER-RAN') })
  assert.deepStrictEqual(probe.failures.map((f) => f.label), ['抛错的检查'], '抛错的检查必须被记为失败')
  assert.strictEqual(probe.failures[0].message, 'boom', '失败明细必须带原始错误信息')
  assert.ok(logged.includes('AFTER-RAN'), '抛错之后的检查必须照跑')
  assert.strictEqual(probe.passed, 2, 'passed 只算真正跑完的检查')
  assert.strictEqual(probe.summary(), 1, '有失败时汇总必须返回 1')
  assert.ok(logged.some((l) => l.includes('2 通过 / 1 失败')), '汇总必须同时报通过与失败数')
})

// 汇总后再清场：即使某条检查抛错，临时工作区也一定要删掉（不在 /tmp 与仓库根留垃圾）。
process.exitCode = harness.summary()
for (const dir of workspaces) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error('⚠️ 临时工作区清理失败（可手工删除）：' + dir + '：' + e.message)
    process.exitCode = 1
  }
}
