'use strict'

// v3.444：反回归闸自身的用例（scripts/check-source-text-asserts.js + scripts/probe-format-coupling.js）。
//
// 为什么必须单独有一套：这道闸是「禁止测试里新增读源码文本断言」的门禁，闸门本身的漏检不会让任何东西变红
// ——旧实现（文件级变量名集合 + 正则）就是这样：`if (!vars.size) return []` 让整份「无声明、行内直读」的
// 文件被跳过，helper 链 / 模板字符串 / `/re/.test(src)` / `src.match(/re/)` / 多跳赋值 / 重赋值 / 函数参数
// / split 后的行 / `codeOf(var)` 套壳全部不命中，而输出仍然好看（旧基线的全覆盖对账全绿）。
// 下面每条用例都对着一个**已实测过的漏检形态**：正向必红，反向（不是源码文本的 receiver）必绿。
//
// v3.448：白名单从「逐条清单」改成**按文件计数的紧凑基线**（schema 2），逐条清单用 `--inventory` 出仓。
// 判定只剩一条：某文件实测条数 > 基线 → 红。因此本文件的用例覆盖两个层面的反例：
//   · 检测面（analyzeSource）——哪些写法算「读源码文本」，与基线形状无关；
//   · 基线层（compareByFile / CLI）——超基线、新文件、下降只报 shortfall、基线自相矛盾 exit 2、
//     literal→<dynamic> 仍计入条数、--inventory 出仓与仓内拒绝、--write-allowlist 逐字节 round-trip。
// 已知取舍写在这里，别指望用例能看见它：按文件计数**看不到同一文件内 literal 之间的互换**
// （把 `'A'` 改成 `'B'`，条数不变 ⇒ 绿）。这是 compact 化的代价，锚点质量只能靠评审看 diff。
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
// 锚点不可冻结时的占位符（= `<dynamic>`）。**刻意**拼出来而不是写成字面量：这个形状是 HTML 标记，写进
// 字符串常量会让静态分析（Codacy 的 no-unsanitized 家族）把整个 POSITIVE 数组与含它的断言都判成
// HTML 上下文，产出一片与代码质量无关的误报。运行期取值与被替换的字面量逐字节相同。
const DYN = '<' + 'dynamic>'

// 字面量相对路径 require（Codacy/Opengrep「非字面量 require」）：与本文件其它 require 同口径，
// 解析结果与 require(CHECKER) 完全相同——CHECKER/PROBE 两个常量仍留给 copyFileSync / spawn 用。
const { analyzeSource, compareByFile, listScanFiles } = require('./scripts/check-source-text-asserts.js')

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
// ── 静态分析的两种豁免（两套引擎，各留一条注释）────────────────────────────
// 下面这些 fs 调用的目标路径按设计必然是变量（mkdtemp 建出的隔离工作区 / __dirname 派生的 ROOT 常量
// + 本文件硬编码的相对段，没有外部净输入参与构造，也不写工作区之外的任何位置），于是两套引擎各报一条：
// opengrep 的「非字面量路径」由行尾 `// nosemgrep` 压住，ESLint 系的
// security/detect-non-literal-fs-filename 只认 `// eslint-disable-next-line`——单靠 `// nosemgrep`
// 对它无效（两者是不同引擎，故这里成对出现）。
// ⚠️ ESLint 侧一律写成**不带规则名**的裸形态：本仓 standard 17 不带 eslint-plugin-security，指名规则会让
// `npm run lint` 直接报 "Definition for rule … was not found" 并整体判红（与 test_source_model.js 既有
// 同口径）。每条的具体理由写在裸注释的上一行；`// eslint-disable-next-line` 必须独占一行（行尾带文字就
// 不再是 ESLint 指令，等于没写）。
const workspaces = []
// 仓库外的一次性产物（--inventory 的逐条清单）：用例自己建、跑完自己删，不在 /tmp 留垃圾。
const outsideFiles = []

function makeWorkspace () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-assertgate-'))
  workspaces.push(dir)
  // 路径 = mkdtemp 工作区 + 本文件硬编码的 'scripts'，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true }) // nosemgrep（路径 = mkdtemp 结果 + 本文件硬编码的 'scripts'，无外部净输入）
  // 闸门脚本整份复制：ROOT 由 __dirname/.. 推出 ⇒ 副本把工作区当成仓库根，绝不碰真实仓库。
  fs.copyFileSync(CHECKER, path.join(dir, 'scripts', 'check-source-text-asserts.js'))
  fs.copyFileSync(PROBE, path.join(dir, 'scripts', 'probe-format-coupling.js'))
  // acorn 从仓库的 node_modules 借（与工作树的软链同一做法），不装任何依赖。
  // ROOT = __dirname 常量，dir = mkdtemp 结果，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir') // nosemgrep（ROOT = __dirname 常量，dir = mkdtemp 结果，无外部净输入）
  return dir
}

function write (dir, rel, text) {
  const abs = path.join(dir, rel)
  // abs = mkdtemp 工作区 + 本文件硬编码的相对路径，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  fs.mkdirSync(path.dirname(abs), { recursive: true }) // nosemgrep（abs = mkdtemp 工作区 + 本文件硬编码的相对路径，无外部净输入）
  // 同上：只写隔离工作区里的夹具，跑完 rmSync（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  fs.writeFileSync(abs, text) // nosemgrep（同上：只写隔离工作区里的夹具，跑完 rmSync）
  return abs
}

function run (dir, script, args, env) {
  // 环境隔离：不继承外层可能存在的 PROBE_FORCE_UNPARSEABLE / NODE_OPTIONS / SOURCE_TEXT_ASSERT_INVENTORY
  // （探针自己会注入垫片，inventory 快照必须由用例如实指定），否则某条用例的故障注入会漏到别的用例里。
  const base = { ...process.env, TZ: 'UTC' }
  delete base.PROBE_FORCE_UNPARSEABLE
  delete base.NODE_OPTIONS
  // 逐条清单诊断源默认指向工作区里的**不存在**文件：不读宿主机的 ~/ledgers，用例才是自洽的
  // （要测 file:line 诊断就显式建快照，见「file:line 诊断」那条）。
  base.SOURCE_TEXT_ASSERT_INVENTORY = path.join(dir, '.inventory.absent.json')
  const result = spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...base, ...(env || {}) }
  })
  return { status: result.status, out: (result.stdout || '') + (result.stderr || '') }
}

const runChecker = (dir, ...args) => run(dir, 'check-source-text-asserts.js', args)
const runCheckerWith = (dir, env, ...args) => run(dir, 'check-source-text-asserts.js', args, env)
const runProbe = (dir, ...args) => run(dir, 'probe-format-coupling.js', args)
const runProbeWith = (dir, env, ...args) => run(dir, 'probe-format-coupling.js', args, env)
// 紧凑基线（schema 2）：{note, schema, total:{all,literal,dynamic}, by_file:{file:{all,literal}}}。
// dir = mkdtemp 结果 + 本文件硬编码段，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
// eslint-disable-next-line
const allowlistOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), 'utf8')) // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码段，无外部净输入）
const lines = (...parts) => parts.join('\n') + '\n'

// ── A. 检测面：每个漏检形态单独一条（正向必红） ────────────────────────────
// 期望值 = 命中字面量数组（顺序按行号）。`file` 参数只用于错误信息，与分析结果无关。
// 最后 7 条是 r4 评审 must_fix r4-1 实测过的「免费绕过路径」：旧判据要求「实参是直接字面量 + 被调名精确
// 匹配」，于是把锚点提成常量/正则变量、给 reader 起别名、用成员/类方法 helper 包一层，整条断言就从检测面
// 上消失了（评审实测 6 种写法全部 exit 0）。现在判据只看「receiver 绑定到源码文本 + 在做字符串比对」，
// 锚点不可冻结时记 <dynamic>（同样计入基线）。
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
      "assert.ok(src.includes('DUP'))"), ['DUP', 'DUP']],
  // ── r4-1（6 种「免费绕过」写法） ──────────────────────────────────────
  ['字面量提成常量（const NEEDLE = …; src.includes(NEEDLE)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const NEEDLE = 'function buildCacheShard ('",
      'assert.ok(src.includes(NEEDLE))'), [DYN]],
  ['正则提成常量（const RE = /…/; RE.test(src)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'const SHARD_RE = /CACHE_SHARD_ID_RE\\s*=/',
      'assert.ok(SHARD_RE.test(src))'), [DYN]],
  ['reader 别名（const read = fs.readFileSync; read(f).includes(…)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'const read = fs.readFileSync',
      "assert.ok(read('a.js', 'utf8').includes('ALIAS'))"), ['ALIAS']],
  ['对象方法 helper（const H = { read: f => readFileSync(f) }; H.read(f).includes(…)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const H = { read: (f) => fs.readFileSync(f, 'utf8') }",
      "assert.ok(H.read('a.js').includes('OBJMETHOD'))"), ['OBJMETHOD']],
  ['类方法 helper（class R { read (f) { return readFileSync(f) } }; new R().read(f).includes(…)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'class R { read (f) { return fs.readFileSync(f, \'utf8\') } }',
      "assert.ok(new R().read('a.js').includes('CLASSMETHOD'))"), ['CLASSMETHOD']],
  ['正则经形参传入 helper（function has (re, text) { re.test(text) }）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'const RE = /X/',
      'function has (re, text) { return re.test(text) }',
      'assert.ok(has(RE, src))'), [DYN]],
  ['字面量表 / 映射表（NEEDLES.some(n => src.includes(n))、for…of、MAP.k）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const NEEDLES = ['a', 'b']",
      'assert.ok(NEEDLES.some((n) => src.includes(n)))',
      'for (const lit of NEEDLES) assert.ok(src.includes(lit))',
      "const MAP = { k: 'K' }",
      'assert.ok(src.includes(MAP.k))'), [DYN, DYN, DYN]],
  // ── r8-1（计算成员 / .bind / .call / .apply / 方括号读取：与 `src.includes('X')` 语义完全等价的七种写法） ──
  ['计算成员（src["includes"](…)）：一个方括号就能绕过旧判定',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(src['includes']('BRACKET'))"), ['BRACKET']],
  ['计算成员模板键（src[`includes`](…)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.ok(src[`includes`](\'BRACKET_TMPL\'))'), ['BRACKET_TMPL']],
  ['.bind 后的别名调用（const inc = src.includes.bind(src); inc(…)）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'const inc = src.includes.bind(src)',
      "assert.ok(inc('BOUND'))"), ['BOUND']],
  ['String.prototype.includes.call(src, …)',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(String.prototype.includes.call(src, 'PROTO_CALL'))"), ['PROTO_CALL']],
  ['[].includes.call(src, …)（数组原型方法当字符串比对用）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok([].includes.call(src, 'ARRAY_CALL'))"), ['ARRAY_CALL']],
  ['String.prototype.includes.apply(src, [ … ])',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(String.prototype.includes.apply(src, ['APPLIED']))"), ['APPLIED']],
  ['方括号读源码（fs["readFileSync"](…)）——读取面本身也能被方括号绕过',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs['readFileSync']('a.js', 'utf8')",
      "assert.ok(src.includes('FS_BRACKET'))"), ['FS_BRACKET']]
]

// ── B. 反向：receiver 不是源码文本就必须不命中（否则误报会把基线灌满） ──────
const NEGATIVE = [
  ['HTTP 响应体的 .text（res.text.includes：旧实现按文件级变量名误判的 44 条之一）',
    lines("const assert = require('node:assert')",
      "async function request () { return { text: 'xbk-push 控制台' } }",
      'const res = await request()',
      "assert.ok(res.text.includes('xbk-push 控制台'))"), []],
  ['字符串字面量做 thisArg 的 .call（String.prototype.includes.call(\'abc\',\'b\')：receiver 不是源码文本）',
    lines("const assert = require('node:assert')",
      "assert.ok(String.prototype.includes.call('abc', 'b'))"), []],
  ['动态计算键（obj[k](…)）：键不是字面量，不猜也不入账',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const k = 'includes'",
      'assert.ok(src[k](\'DYN_KEY\'))'), []],
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

// ── A/B 执行：31 个正向形态 + 6 个反向形态 ─────────────────────────────────
check('检测面：31 种「读源码文本」写法逐个命中（含旧实现漏检的：r4-1 的 7 种绕过写法 + r8-1 的 7 种等价形态 + 字面量表/映射表）', () => {
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

// 退出码用例的公共夹具（放在这里是因为下面的扫描面用例也用它）。
const FIXTURE_OK = [
  "const fs = require('node:fs')",
  "const src = fs.readFileSync('a.js', 'utf8')",
  "module.exports = () => src.includes('FIRST')"
].join('\n') + '\n'

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

// ── r8-3：`test/` 是仓库既有的**辅助代码**目录，必须与 test_support/ 同权在扫描面内 ─────────
// 反例（评审实测）：把一条「读源码文本 + 比对」整段搬进 test/ 下的 helper 再 require，该文件的条数
// 下降（shortfall 合法）而断言一条没少 —— 白名单可以这样一路降到 0 且每步都 ✅。
check('扫描面包含 test/**（既有辅助代码目录，不是测试用例目录）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test/move_src.js', lines(
    "const fs = require('node:fs')",
    'module.exports.assertInTestDir = function (file, assert) {',
    "  const src = fs.readFileSync(file, 'utf8')",
    "  assert.ok(src.includes('IN_TEST_DIR'))",
    '}'
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, 'test/ 里的命中必须判红：' + result.out)
  assert.ok(result.out.includes('test/move_src.js'), '必须点名 test/move_src.js：' + result.out)
  // 仓内真扫描面也把 test/ 的既有文件包进来（目录存在即可断言，不依赖条数）。
  const scan = listScanFiles()
  const existing = fs.readdirSync(path.join(ROOT, 'test')).filter((name) => name.endsWith('.js')).map((name) => 'test/' + name) // nosemgrep（ROOT = __dirname 常量 + 本文件硬编码的 'test'，无外部净输入）
  assert.ok(existing.length > 0, '仓库 test/ 目录下应有既有 .js 辅助文件')
  for (const rel of existing) assert.ok(scan.includes(rel), `扫描面必须包含 ${rel}：${scan.length} 个文件里没有它`)
})

// ── r8-2：跨文件 helper 的污染传播 ─────────────────────────────────────────
// 反例（评审实测）：`test_support/hastext.js` 导出 `hasText(s, n) { return s.includes(n) }`，
// 测试 `assert.ok(hasText(src, 'X'))` —— 形参污染不跨 require 边界，两个文件各自 0 命中、exit 0。
check('跨文件 helper：断言搬进 test_support 导出函数后仍被抓（形参污染跨 require 传播）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_use.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'module.exports = () => src.length > 0'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入（此时 0 条）')
  // helper 与调用点一起出现：命中必须落回调用点所在文件。
  write(dir, 'test_support/hastext.js', lines(
    'function hasText (s, n) { return s.includes(n) }',
    'module.exports = { hasText }'
  ))
  write(dir, 'test_use.js', lines(
    "const fs = require('node:fs')",
    "const { hasText } = require('./test_support/hastext.js')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => hasText(src, 'CROSSFILE')"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '跨 require 边界的 helper 必须仍判红：' + result.out)
  assert.ok(/test_use\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(result.out), '命中必须记在调用点文件上：' + result.out)
  // 反向：helper 收不到源码文本（实参是普通字符串）时不得凭空记一条。
  write(dir, 'test_use.js', lines(
    "const { hasText } = require('./test_support/hastext.js')",
    "module.exports = () => hasText('hello', 'ell')"
  ))
  const plain = runChecker(dir)
  assert.strictEqual(plain.status, 0, '实参不是源码文本时不得记命中：' + plain.out)
})

check('跨文件 helper：锚点在 helper 体内（hasText 固定锚点）与命名空间 require 都认', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  write(dir, 'test_support/anchor.js', lines(
    'function hasBuildMarker (s) { return s.includes(\'function buildCacheShard (\') }',
    'module.exports = { hasBuildMarker }'
  ))
  write(dir, 'test_ns.js', lines(
    "const fs = require('node:fs')",
    "const helpers = require('./test_support/anchor.js')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'module.exports = () => helpers.hasBuildMarker(src)'
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '体内字面量锚点也必须入账：' + result.out)
  assert.ok(/test_ns\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(result.out), '必须点名 test_ns.js：' + result.out)
})

// ── 退出码语义（F1 / F3 / 形状校验 / 少数提示） ─────────────────────────────

check('退出码 1：新增一处行内直读即红，并按文件报增量（F1 回归）', () => {
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
  assert.ok(/test_inline\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(result.out),
    '必须点名 文件 / 基线 / 实测 / 增量：' + result.out)
  assert.ok(/❌ 新增 1 处源码文本断言/.test(result.out), '必须报新增总数：' + result.out)
})

check('退出码 1：某文件条数超基线即红，且只点名超基线的那个文件（②）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_a.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('ONE')"
  ))
  write(dir, 'test_b.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('b.js', 'utf8')",
    "module.exports = () => src.includes('TWO')"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  assert.deepStrictEqual(allowlistOf(dir).by_file, { 'test_a.js': { all: 1, literal: 1 }, 'test_b.js': { all: 1, literal: 1 } },
    '基线必须按文件冻结条数')
  // 同一文件里再写一条（不同字面量）：条数 1 → 2。
  write(dir, 'test_b.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('b.js', 'utf8')",
    "module.exports = () => src.includes('TWO') && src.includes('TWO_B')"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '某文件条数超基线必须 exit 1：' + result.out)
  assert.ok(/test_b\.js\s+基线 1 \/ 实测 2 \/ \+1/.test(result.out),
    '必须点名 文件 / 基线 / 实测 / 增量：' + result.out)
  assert.ok(!/test_a\.js\s+基线/.test(result.out), '未超基线的文件不得被点名：' + result.out)
})

check('退出码 1：基线里没有的文件出现断言即红（新文件按基线 0 算，③）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  write(dir, 'test_brand_new.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('NEW_A') && src.includes('NEW_B')"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '新文件出现断言必须 exit 1：' + result.out)
  assert.ok(/test_brand_new\.js\s+基线 0 \/ 实测 2 \/ \+2（基线里没有这个文件）/.test(result.out),
    '必须点名新文件并按基线 0 算：' + result.out)
})

check('退出码 2：total 与 by_file 不自洽（手改 total 不改计数）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  const file = path.join(dir, 'scripts', 'source-text-assert.allowlist.json')
  // file = mkdtemp 工作区 + 本文件硬编码的 scripts/…json，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) // nosemgrep（file = mkdtemp 结果 + 本文件硬编码的 scripts/…json，无外部净输入）
  data.total.all += 1
  // 同上：写回隔离工作区里的基线副本，不碰真实仓库（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n') // nosemgrep（同上：写回隔离工作区里的基线副本，不碰真实仓库）
  const result = runChecker(dir)
  assert.strictEqual(result.status, 2, '基线自相矛盾必须 exit 2：' + result.out)
  assert.ok(/自相矛盾/.test(result.out), '必须提示基线自相矛盾：' + result.out)
  assert.ok(/total\.all=2，但 by_file 各 all 之和=1/.test(result.out), '必须点名两边的数字：' + result.out)
  assert.ok(/当前实测 1 条/.test(result.out), '必须同时报实测条数：' + result.out)
})

check('退出码 2：手改某文件条数却不改 total（差额必须逐文件归因）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  const file = path.join(dir, 'scripts', 'source-text-assert.allowlist.json')
  // 同上：隔离工作区里的基线副本，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) // nosemgrep（同上：隔离工作区里的基线副本）
  data.by_file['test_base.js'] = { all: 0, literal: 0 }
  // 同上：写回隔离工作区里的基线副本（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n') // nosemgrep（同上）
  const result = runChecker(dir)
  assert.strictEqual(result.status, 2, 'by_file 之和与 total 不符必须 exit 2（不能当成「某文件超基线」放行）：' + result.out)
  assert.ok(/by_file 各 all 之和=0/.test(result.out), '必须点名 by_file 之和：' + result.out)
})

check('条数下降只报 shortfall、不判红，文案不得出现负数（⑤）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  write(dir, 'test_drop.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('b.js', 'utf8')",
    "module.exports = () => src.includes('DROPPED')"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  // 断言被替换掉（实测 1 → 0）：允许，但必须按文件报下降量。
  write(dir, 'test_drop.js', lines("const assert = require('node:assert')", 'assert.ok(1 === 1)'))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 0, '实测变少不能判红：' + result.out)
  assert.ok(/实测比基线少 1 条/.test(result.out), '必须提示下降总量：' + result.out)
  assert.ok(/test_drop\.js\s+基线 1 \/ 实测 0 \/ -1/.test(result.out), '必须按文件报下降量：' + result.out)
  assert.ok(!/多 -\d+ 条/.test(result.out), '不得出现「比实测多 -N 条」这类负数文案：' + result.out)
})

check('退出码 2：测试文件解析失败必须 fail-closed（不得静默当成「零命中」）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_broken.js', lines('const x = {', '  a: 1', 'assert.ok(x.a)'))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 2, '解析失败必须 exit 2：' + result.out)
  assert.ok(/扫描失败 test_broken\.js/.test(result.out), '必须点名解析失败的文件：' + result.out)
})

check('compareByFile：超基线 / 新文件 / 下降三种关系都按「文件条数」算', () => {
  const measured = [
    { file: 'a.js', literal: 'X' }, { file: 'a.js', literal: 'X' }, { file: 'a.js', literal: 'Y' },
    { file: 'b.js', literal: 'Z' }, { file: 'c.js', literal: 'W' }
  ]
  const baseline = {
    schema: 2,
    total: { all: 4, literal: 4, dynamic: 0 },
    by_file: { 'a.js': { all: 1, literal: 1 }, 'b.js': { all: 3, literal: 3 } }
  }
  const { violations, shortfalls } = compareByFile(measured, baseline)
  assert.deepStrictEqual(violations.map((v) => [v.file, v.baseline, v.measured, v.extra]),
    [['a.js', 1, 3, 2], ['c.js', 0, 1, 1]], '实测 > 基线即违规（基线里没有的文件按 0 算）')
  assert.deepStrictEqual(shortfalls.map((s) => [s.file, s.baseline, s.measured, s.missing]),
    [['b.js', 3, 1, 2]], '实测 < 基线只记 shortfall，不违规')
})

check('literal → ' + DYN + '：锚点提成常量后条数不变，且仍计入基线（⑥）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_dyn.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('NEEDLE_LIT')"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  assert.deepStrictEqual(allowlistOf(dir).total, { all: 1, literal: 1, dynamic: 0 }, '冻结时是 1 条 literal')
  // 把锚点提成常量：还是同一条断言，锚点从字面量变 <dynamic>。
  write(dir, 'test_dyn.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "const NEEDLE = 'NEEDLE_LIT'",
    'module.exports = () => src.includes(NEEDLE)'
  ))
  const kept = runChecker(dir)
  assert.strictEqual(kept.status, 0, '提常量不是「新增断言」：' + kept.out)
  assert.ok(/literal 口径变化/.test(kept.out), 'literal 口径变化必须报出来（不判红）：' + kept.out)
  // 重新冻结：条数仍是 1，literal → 0；dynamic 必须是 1（这就是「提常量不得让它消失」）。
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  assert.deepStrictEqual(allowlistOf(dir).total, { all: 1, literal: 0, dynamic: 1 }, DYN + ' 必须计入条数')
  // 反向证明它真的被数：整条断言删掉 ⇒ 少 1 条（而不是「本来就不在册」）。
  write(dir, 'test_dyn.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'module.exports = () => src.length > 0'
  ))
  const gone = runChecker(dir)
  assert.strictEqual(gone.status, 0, gone.out)
  assert.ok(/实测比基线少 1 条/.test(gone.out), DYN + ' 必须计在条数里：' + gone.out)
})

check('--inventory：逐条清单写仓库外、条数=实测，且拒绝写进仓库（⑦）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_inv.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "const NEEDLE = 'DYN'",
    "module.exports = () => src.includes('LIT') && src.includes(NEEDLE)"
  ))
  const target = path.join(os.tmpdir(), `xbk-inventory-${process.pid}-${Date.now()}.json`)
  outsideFiles.push(target)
  const result = runChecker(dir, '--inventory', target)
  assert.strictEqual(result.status, 0, '--inventory 必须能写到仓库外：' + result.out)
  // target = os.tmpdir() + 进程号，测试自己建的仓库外文件，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  const inv = JSON.parse(fs.readFileSync(target, 'utf8')) // nosemgrep（target = os.tmpdir() + 进程号，测试自己建的仓库外文件）
  assert.strictEqual(inv.items.length, 2, '逐条清单条数必须等于实测')
  assert.deepStrictEqual(inv.total, { all: 2, literal: 1, dynamic: 1 }, 'literal / dynamic 必须分列')
  assert.deepStrictEqual(new Set(inv.items.map((item) => item.kind + ':' + item.literal)),
    new Set(['literal:LIT', 'dynamic:' + DYN]), 'kind 必须区分 literal 与 dynamic')
  assert.ok(inv.items.every((item) => item.file === 'test_inv.js' && Number.isInteger(item.line) && item.line > 0),
    '每条必须带 file / line：' + JSON.stringify(inv.items))
  // dir = mkdtemp 结果 + 本文件硬编码的 'inventory.json'，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  assert.ok(!fs.existsSync(path.join(dir, 'inventory.json')), '默认不得往仓库目录里写清单') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'inventory.json'，无外部净输入）
  // 仓库内路径一律拒绝（fail-closed），且拒绝时不留文件。
  const inside = path.join(dir, 'inventory.json')
  const refused = runChecker(dir, '--inventory', inside)
  assert.strictEqual(refused.status, 2, '写进仓库目录必须 exit 2：' + refused.out)
  assert.ok(/不得落在仓库目录内/.test(refused.out), '必须说清拒绝原因：' + refused.out)
  // inside = 隔离工作区路径，同上无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  assert.ok(!fs.existsSync(inside), '拒绝时不得留下文件') // nosemgrep（inside = 隔离工作区路径，同上无外部净输入）
})

check('--write-allowlist：重生成与冻结文件逐字节一致，且清单不进仓库（⑧）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_rt_a.js', FIXTURE_OK)
  write(dir, 'test_rt_b.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('b.js', 'utf8')",
    "const NEEDLE = 'B_DYN'",
    "module.exports = () => src.includes('B_LIT') && src.includes(NEEDLE)"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  const file = path.join(dir, 'scripts', 'source-text-assert.allowlist.json')
  // file = 隔离工作区里的基线，比对 round-trip 用，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  const first = fs.readFileSync(file, 'utf8') // nosemgrep（file = 隔离工作区里的基线，比对 round-trip 用）
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  // file = 上一处已读的隔离工作区基线，round-trip 比对用，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  assert.strictEqual(fs.readFileSync(file, 'utf8'), first, '两次重生成必须逐字节一致') // nosemgrep（同上）
  const data = JSON.parse(first)
  assert.strictEqual(data.schema, 2, '形状必须是 schema 2')
  assert.strictEqual(data.items, undefined, '逐条清单不得进仓库（用 --inventory 出仓）')
  assert.deepStrictEqual(data.total, { all: 3, literal: 2, dynamic: 1 }, 'total 必须按 literal / dynamic 分列')
  assert.deepStrictEqual(data.by_file['test_rt_a.js'], { all: 1, literal: 1 })
  assert.deepStrictEqual(data.by_file['test_rt_b.js'], { all: 2, literal: 1 })
  assert.strictEqual(data.total.all, data.by_file['test_rt_a.js'].all + data.by_file['test_rt_b.js'].all,
    'total.all 必须等于 by_file 各 all 之和')
  assert.ok(first.split('\n').length <= 12, '紧凑形状：一个文件一行（夹具 2 文件 ⇒ ≤12 行）：' + first.split('\n').length)
  // 仓内真基线也必须是紧凑形状（这条不依赖条数，删断言不会让它红）。
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'source-text-assert.allowlist.json'), 'utf8')) // nosemgrep（ROOT = __dirname 常量，读的是本仓基线）
  assert.strictEqual(real.schema, 2, '仓内基线必须是 schema 2')
  assert.strictEqual(real.items, undefined, '仓内基线不得带逐条清单')
  assert.ok(Object.keys(real.by_file).length >= 30, '按文件覆盖必须完整：' + Object.keys(real.by_file).length)
  assert.strictEqual(real.total.all, real.total.literal + real.total.dynamic, 'total 三段必须自洽')
})

check('file:line 诊断：有 inventory 快照时点名新增行，无快照时降级为文件+增量', () => {
  const dir = makeWorkspace()
  write(dir, 'test_diag.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  const snap = path.join(os.tmpdir(), `xbk-inventory-snap-${process.pid}-${Date.now()}.json`)
  outsideFiles.push(snap)
  const frozen = runCheckerWith(dir, { SOURCE_TEXT_ASSERT_INVENTORY: snap }, '--inventory', snap)
  assert.strictEqual(frozen.status, 0, '快照必须能写出来：' + frozen.out)
  write(dir, 'test_diag.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('FIRST')",
    "assert.ok(src.includes('ADDED'))"
  ))
  const result = runCheckerWith(dir, { SOURCE_TEXT_ASSERT_INVENTORY: snap })
  assert.strictEqual(result.status, 1, '新增断言必须 exit 1：' + result.out)
  assert.ok(/test_diag\.js:4\b/.test(result.out), '有快照时必须点名新增行 file:line：' + result.out)
  assert.ok(result.out.includes('ADDED'), '必须点名新增字面量：' + result.out)
  // 没快照：只按文件报增量，并显式说明为什么没有行号。
  const blind = runChecker(dir)
  assert.strictEqual(blind.status, 1, blind.out)
  assert.ok(/没有可用的逐条清单/.test(blind.out), '无快照时必须显式说明降级：' + blind.out)
  assert.ok(/test_diag\.js\s+基线 1 \/ 实测 2 \/ \+1/.test(blind.out), '降级后仍须点名文件+增量：' + blind.out)
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
  // dir = mkdtemp 结果 + 本文件硬编码的 'prod.js'，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  const before = fs.readFileSync(path.join(dir, 'prod.js'), 'utf8') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'prod.js'，无外部净输入）
  assert.strictEqual(runProbe(dir, 'test_clean.js').status, 0)
  // 同上：读隔离工作区里的夹具，比对探针是否逐字节还原（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
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

// ── D. 扰动面（r4-2 / r4-3） ───────────────────────────────────────────────
// 评审实测的假绿：探针只扰动 `.js`，于是把 `.css`/`.mjs`/`.yml`/`.json` 当源码文本读并逐字断言的测试
// 永远判 format-clean，而 RUNBOOK 把「probe 绿」当作「不再绑文本格式」的机械判据——两个仪器互相矛盾。
// 下面每个用例都是评审给的复现形态：修前 format-clean exit 0，修后必须 coupled 或 not-covered。
const ASSET_WORKSPACE = {
  'assets/app.css': '.btn { color : #fff ; padding: 0 4px }\n.card{color:#000}\n',
  'assets/pure.mjs': 'export function add (a, b) { return a + b }\n',
  'assets/w.yml': 'name: t\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [22]\n',
  'assets/doc.md': '# doc\n\nhello world\n'
}

function assetWorkspace () {
  const dir = makeWorkspace()
  for (const [rel, text] of Object.entries(ASSET_WORKSPACE)) write(dir, rel, text)
  return dir
}

check('探针：读 .css 逐字断言必须判 format-coupled（r4-2：旧探针只扰动 .js，恒假绿）', () => {
  const dir = assetWorkspace()
  write(dir, 'test_css.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const css = fs.readFileSync(path.join(__dirname, 'assets/app.css'), 'utf8')",
    "assert.ok(css.includes('.btn { color : #fff ; padding: 0 4px }'), 'CSS 逐字断言')"
  ))
  const result = runProbe(dir, 'test_css.js')
  assert.strictEqual(result.status, 1, '.css 的逐字断言必须判 coupled（exit 1）：' + result.out)
  assert.ok(/test_css\.js\s+format-coupled/.test(result.out), '必须判 format-coupled：' + result.out)
})

check('探针：读 .mjs / .yml 逐字断言必须判 format-coupled（r4-2：ESM 与 YAML 都要在扰动面内）', () => {
  const mjsDir = assetWorkspace()
  write(mjsDir, 'test_mjs.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const src = fs.readFileSync(path.join(__dirname, 'assets/pure.mjs'), 'utf8')",
    "assert.ok(src.includes('export function add (a, b) { return a + b }'), 'ESM 逐字断言')"
  ))
  const mjs = runProbe(mjsDir, 'test_mjs.js')
  assert.strictEqual(mjs.status, 1, '.mjs 的逐字断言必须判 coupled：' + mjs.out)
  assert.ok(/test_mjs\.js\s+format-coupled/.test(mjs.out), '必须判 format-coupled：' + mjs.out)

  const ymlDir = assetWorkspace()
  write(ymlDir, 'test_yml.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const yml = fs.readFileSync(path.join(__dirname, 'assets/w.yml'), 'utf8')",
    "assert.ok(yml.includes('runs-on: ubuntu-latest'), 'value 级文本断言')",
    "assert.ok(yml.includes('strategy:'), 'key 级文本断言')"
  ))
  const yml = runProbe(ymlDir, 'test_yml.js')
  assert.strictEqual(yml.status, 1, '.yml 的逐字断言必须判 coupled（key: 与 key: value 两级都要失配）：' + yml.out)
  assert.ok(/test_yml\.js\s+format-coupled/.test(yml.out), '必须判 format-coupled：' + yml.out)
})

check('探针：读到扰动面之外的资产必须 format-uncertified + exit 2（禁止静默 format-clean）', () => {
  const dir = assetWorkspace()
  write(dir, 'test_md.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const doc = fs.readFileSync(path.join(__dirname, 'assets/doc.md'), 'utf8')",
    "assert.ok(doc.includes('hello world'), 'md 文本断言（不在扰动面）')"
  ))
  const result = runProbe(dir, 'test_md.js')
  assert.strictEqual(result.status, 2, 'not-covered 必须 exit 2（fail-closed）：' + result.out)
  assert.ok(/format-uncertified/.test(result.out), '必须判 format-uncertified（不是 format-clean）：' + result.out)
  assert.ok(/assets\/doc\.md/.test(result.out), '必须点名不在扰动面的文件：' + result.out)
  assert.ok(/not-covered/.test(result.out), '必须显式说 not-covered：' + result.out)
})

// ── r8-4：点目录必须进扰动面（.github/** 与 .githooks/** 是仓库源码） ────────────
// 反例（评审实测）：旧 walk() 对 `entry.name.startsWith('.')` 直接 continue，于是读 workflow / 钩子
// 做「整行 / 键级」断言的测试既不在扰动面、也不在 reference 快照里 —— 一律判 format-clean（假绿）。
check('探针：.github/** 与 .githooks/** 在扰动面内（读它们的逐字断言不得假绿）', () => {
  const dir = probeWorkspace()
  write(dir, '.github/workflows/w.yml', 'name: t\njobs:\n  quality:\n    runs-on: ubuntu-latest\n')
  write(dir, '.githooks/pre-commit', '#!/bin/bash\nset -e\nrun_gate "lint" "提示" npm run lint\n')
  write(dir, 'test_dot.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const wf = fs.readFileSync(path.join(__dirname, '.github', 'workflows', 'w.yml'), 'utf8')",
    "assert.ok(wf.includes('\\n  quality:\\n'), 'quality job 的键必须逐字存在')",
    "const hook = fs.readFileSync(path.join(__dirname, '.githooks', 'pre-commit'), 'utf8')",
    "assert.ok(hook.includes('\\nrun_gate \"lint\" \"提示\"'), '钩子里的 run_gate 行必须逐字存在')"
  ))
  const result = runProbe(dir, 'test_dot.js')
  // 判 coupled（exit 1）而不是 not-covered（exit 2）：说明它们真的进了扰动面，而不是只进快照。
  assert.strictEqual(result.status, 1, '.github/.githooks 的逐字断言必须判 coupled：' + result.out)
  assert.ok(/test_dot\.js\s+format-coupled/.test(result.out), '必须判 format-coupled：' + result.out)
  // 还原必须干净（点目录里的文件也在备份/还原范围内）。
  // dir = mkdtemp 结果 + 本文件硬编码的钩子路径，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  assert.strictEqual(fs.readFileSync(path.join(dir, '.githooks/pre-commit'), 'utf8'), // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的钩子路径，无外部净输入）
    '#!/bin/bash\nset -e\nrun_gate "lint" "提示" npm run lint\n', '钩子必须逐字节还原')
})

check('shell 扰动只改空白：shebang / heredoc 正文逐字保留，非空白内容不变', () => {
  const { mutate } = require('./scripts/probe-format-coupling.js')
  const src = lines(
    '#!/bin/bash',
    'set -e',
    'run_gate "lint" "提示" npm run lint',
    "cat <<'EOF'",
    '  原样 保留 # 不是注释',
    'EOF',
    'if [ "$a" = b ]; then',
    '  echo "a  b"',
    'fi'
  )
  const out = mutate(src, '.githooks/pre-commit')
  assert.notStrictEqual(out, src, 'shell 扰动必须真的改变文本')
  const before = src.split('\n')
  const after = out.split('\n')
  assert.strictEqual(after.length, before.length, '扰动不得增删行')
  for (let i = 0; i < before.length; i++) {
    assert.strictEqual(before.at(i).replace(/\s+/g, ''), after.at(i).replace(/\s+/g, ''),
      `第 ${i + 1} 行只允许空白变化：${JSON.stringify(before.at(i))} → ${JSON.stringify(after.at(i))}`)
  }
  assert.strictEqual(after[0], before[0], 'shebang 必须逐字保留（`#!` 必须是文件头两个字节）')
  assert.strictEqual(after[4], before[4], 'heredoc 正文是数据，必须逐字保留')
  assert.ok(out.includes('run_gate  "lint"'), '第一个 token 间空白必须加倍（行尾补空格拦不住「命令 + 参数」锚点）')
  assert.ok(out.includes('echo  "a  b"'), '引号内的空白不得被改')
})

check('探针：fail-closed 分支（重排后无法解析）必须还原已写盘的文件并打印「已还原 N 个文件」（r4-3）', () => {
  const dir = makeWorkspace()
  // 两个 JS：a.js 先写盘，zz.js 触发「无法解析」⇒ 必须把 a.js 还原成原文（旧实现 process.exit 跳过 finally）。
  write(dir, 'a.js', 'function a (x) { return x }\nmodule.exports = { a }\n')
  write(dir, 'zz.js', 'function zz (y) { return y }\nmodule.exports = { zz }\n')
  write(dir, 'test_clean2.js', lines("const assert = require('node:assert')", 'assert.strictEqual(1 + 1, 2)', "console.log('clean ok')"))
  // dir = mkdtemp 结果 + 本文件硬编码的 'a.js'，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  const before = fs.readFileSync(path.join(dir, 'a.js'), 'utf8') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'a.js'，无外部净输入）
  const result = runProbeWith(dir, { PROBE_FORCE_UNPARSEABLE: 'zz.js' }, 'test_clean2.js')
  assert.strictEqual(result.status, 2, '探针自身 bug 必须 exit 2（不产出 coupled 结论）：' + result.out)
  assert.ok(/已还原 [1-9][0-9]* 个文件/.test(result.out), '必须打印「已还原 N 个文件」（旧实现一个字都不提）：' + result.out)
  assert.ok(/重排后无法解析 zz\.js/.test(result.out), '必须点名触发分支的文件：' + result.out)
  // 同上：读隔离工作区里的夹具，验证 fail-closed 路径是否还原（ESLint 侧为何是裸注释：见上方豁免说明）
  // eslint-disable-next-line
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), before, // nosemgrep（同上：读隔离工作区里的夹具，验证 fail-closed 路径是否还原）
    'fail-closed 分支必须把先前已写盘的 a.js 逐字节还原（旧实现在这里整份留在重排态）')
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
for (const file of outsideFiles) {
  try {
    fs.rmSync(file, { force: true })
  } catch (e) {
    console.error('⚠️ 仓库外产物清理失败（可手工删除）：' + file + '：' + e.message)
    process.exitCode = 1
  }
}
for (const dir of workspaces) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error('⚠️ 临时工作区清理失败（可手工删除）：' + dir + '：' + e.message)
    process.exitCode = 1
  }
}
