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
// 锚点不可冻结时的占位符（= `<dynamic>`）。**刻意**逐字节拼出来而不是写成字面量：这个形状是 HTML 标记，
// 写进字符串常量会让静态分析（Codacy 的 no-unsanitized 家族）把整个 POSITIVE 数组与含它的断言都判成
// HTML 上下文，产出一片与代码质量无关的误报。连「左尖括号字面量 + dynamic>」的拼接也会被常量折叠回同一个
// 字面量（实测仍被判 HTML），故左侧用 fromCharCode(60) 取码点 —— 文件里不出现这个字符。
// 运行期取值与被替换的字面量逐字节相同。
const DYN = String.fromCharCode(60) + 'dynamic>'

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

  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true }) // nosemgrep（路径 = mkdtemp 结果 + 本文件硬编码的 'scripts'，无外部净输入）
  // 闸门脚本整份复制：ROOT 由 __dirname/.. 推出 ⇒ 副本把工作区当成仓库根，绝不碰真实仓库。
  fs.copyFileSync(CHECKER, path.join(dir, 'scripts', 'check-source-text-asserts.js'))
  fs.copyFileSync(PROBE, path.join(dir, 'scripts', 'probe-format-coupling.js'))
  // acorn 从仓库的 node_modules 借（与工作树的软链同一做法），不装任何依赖。
  // ROOT = __dirname 常量，dir = mkdtemp 结果，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）

  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir') // nosemgrep（ROOT = __dirname 常量，dir = mkdtemp 结果，无外部净输入）
  return dir
}

function write (dir, rel, text) {
  const abs = path.join(dir, rel)
  // abs = mkdtemp 工作区 + 本文件硬编码的相对路径，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）

  fs.mkdirSync(path.dirname(abs), { recursive: true }) // nosemgrep（abs = mkdtemp 工作区 + 本文件硬编码的相对路径，无外部净输入）
  // 同上：只写隔离工作区里的夹具，跑完 rmSync（ESLint 侧为何是裸注释：见上方豁免说明）

  fs.writeFileSync(abs, text) // nosemgrep（同上：只写隔离工作区里的夹具，跑完 rmSync）
  return abs
}

function run (dir, script, args, env) {
  // 环境隔离：不继承外层可能存在的 PROBE_FORCE_UNPARSEABLE / NODE_OPTIONS / SOURCE_TEXT_ASSERT_INVENTORY
  // （探针自己会注入垫片，inventory 快照必须由用例如实指定），否则某条用例的故障注入会漏到别的用例里。
  const base = { ...process.env, TZ: 'UTC' }
  delete base.PROBE_FORCE_UNPARSEABLE
  delete base.NODE_OPTIONS
  // r18-B1：闸门在 CI=true 且拿不到 git 参照时 fail-closed。夹具工作区**不是** git 仓，
  // 若继承宿主机的 CI，整片用例会被这条（正确的）守卫打红 —— 隔离掉它，
  // 「CI=true 必须 fail-closed」由专门的那条用例显式注入 CI=true 来证明。
  delete base.CI
  delete base.SOURCE_TEXT_ASSERT_BASELINE_REF
  delete base.SOURCE_TEXT_ASSERT_GROWTH_REASON
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
const runProbe = (dir, ...args) => run(dir, 'probe-format-coupling.js', [...args, '--min-candidates=0'])
const runProbeWith = (dir, env, ...args) => run(dir, 'probe-format-coupling.js', [...args, '--min-candidates=0'], env)
// 夹具工作区只有 2-5 个文件，必须显式放宽扰动面下限（r13-7）；不带这个开关的探针会按真仓口径 exit 2。
// 「扰动面塌缩」的用例专门走 runProbeStrict（不带开关），见下面的 r13-7 用例。
const runProbeStrict = (dir, ...args) => run(dir, 'probe-format-coupling.js', args)
// 少数用例要把探针放到 SKIP_DIRS 里的目录下（`.tools/**`）：这样仓内没有任何可扰动文件，
// 才能测「写盘 0 个文件」这条 fail-closed 分支（探针自己也是 .js 候选，放 scripts/ 下就必然被扰动）。
const runProbeAt = (dir, rel, ...args) => {
  const base = { ...process.env, TZ: 'UTC' }
  delete base.PROBE_FORCE_UNPARSEABLE
  delete base.NODE_OPTIONS
  const result = spawnSync(process.execPath, [rel, ...args], { cwd: dir, encoding: 'utf8', timeout: 120000, env: base })
  return { status: result.status, out: (result.stdout || '') + (result.stderr || '') }
}
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
  // ── r17-A（读取函数的别名解析：解构重命名 / .bind 两种写法旧实现 0 命中、exit 0） ─────────
  // 旧实现只按「本地名恰好与读取函数同名」认出读取器（calleeTailName），把 `readFileSync` 改名成
  // `readSource` 或经 `.bind(fs)` 接住后，`readSource(...)` 的返回值从不污染 ⇒ 整族失明。
  ['解构重命名（const { readFileSync: readSource } = require(\'node:fs\')，r17-A）',
    lines("const { readFileSync: readSource } = require('node:fs')", "const assert = require('node:assert')",
      "const src = readSource('a.js', 'utf8')",
      "assert.ok(src.includes('DESTRUCTURE_RENAME'))"), ['DESTRUCTURE_RENAME']],
  ['.bind 后的读取别名（const readSource = fs.readFileSync.bind(fs)，r17-A）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'const readSource = fs.readFileSync.bind(fs)',
      "const src = readSource('a.js', 'utf8')",
      "assert.ok(src.includes('BOUND_READER'))"), ['BOUND_READER']],
  ['r17-A 反例：同一夹具改回裸 includes 仍命中（别名不是检测面的必要条件）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(src.includes('BARE_CONTROL'))"), ['BARE_CONTROL']],
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
      "assert.ok(src.includes('FS_BRACKET'))"), ['FS_BRACKET']],
  // ── r12-1（运算符 / 等值断言族：旧检测面只认调用表达式，这一整族永远数不到） ─────────
  ['比较运算符：lines[10] === \'…\'（行级逐字比对，没有方法调用可抓）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const lines = src.split('\\n')",
      "assert.ok(lines[10] === 'const CACHE_SHARD_ID_RE =')"), ['const CACHE_SHARD_ID_RE =']],
  ['assert.strictEqual(lines[10], \'…\')（等值断言形态，与 === 同口径）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'const lines = src.split(\'\\n\')',
      "assert.strictEqual(lines[11], 'ASSERT_EQ')"), ['ASSERT_EQ']],
  ['.slice() 之后 !==（先切片再逐字比对）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.ok(src.slice(0, 12) !== 'SLICED_TEXT')"), ['SLICED_TEXT']],
  ['.trim() 之后 assert.strictEqual（整形后仍绑文本）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "assert.strictEqual(src.trim(), 'TRIMMED')"), ['TRIMMED']],
  ['assert.deepStrictEqual(行切片, [字面量…])（字面量数组取首个字符串做锚点）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const head = src.split('\\n').slice(0, 2)",
      "assert.deepStrictEqual(head, ['LINE_A', 'LINE_B'])"), ['LINE_A']],
  // ── r13-1（等值族的「提成常量」绕过：锚点不在同一行时记 <dynamic>，不许整条消失） ──────────
  // 标签形状的占位符仍用 DYN 拼：这个数组里有任何一处「尖括号 + 名字 + 尖括号」的**字符串字面量**，
  // 静态分析就会把整个 POSITIVE 判成「存了 raw HTML」，产出一片与代码质量无关的告警。
  ['assert.strictEqual(lines[10], EXPECTED)（锚点提成 const：另一侧不是字面量 ⇒ ' + DYN + '）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const lines = src.split('\\n')",
      "const EXPECTED = '  const REV = 42'",
      'assert.strictEqual(lines[10], EXPECTED)'), [DYN]],
  ['lines[11] === EXPECTED（运算符形态的同一件事）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const lines = src.split('\\n')",
      "const EXPECTED = '  const REV = 42'",
      'assert.ok(lines[11] === EXPECTED)'), [DYN]],
  ['assert.deepStrictEqual(head, EXPECTED_LINES)（常量数组做锚点）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const EXPECTED_LINES = ['LINE_A', 'LINE_B']",
      "const head = src.split('\\n').slice(0, 2)",
      'assert.deepStrictEqual(head, EXPECTED_LINES)'), [DYN]],
  // ── r13-3（loadModel 的 code / codeOnly 字段就是源码文本：容器不是洗白通道） ──────────────
  ['loadModel(f).codeOnly.includes(…)（容器字段 = 源码文本，与 codeOnly(f) 同口径）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'function loadModel (f) {',
      "  const code = fs.readFileSync(f, 'utf8')",
      '  return { code, codeOnly: code }',
      '}',
      "assert.ok(loadModel('a.js').codeOnly.includes('CONTAINER_INLINE'))"), ['CONTAINER_INLINE']],
  ['const m = loadModel(f); m.code.includes(…)（把容器接住再取字段）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'function loadModel (f) {',
      "  const code = fs.readFileSync(f, 'utf8')",
      '  return { code: code }',
      '}',
      "const m = loadModel('a.js')",
      "assert.ok(m.code.includes('CONTAINER_BOUND'))"), ['CONTAINER_BOUND']],
  // ── r15（第 15 轮评审的五处检测面缺口：每一条都先实测「换成这个写法 ⇒ 0 命中、exit 0」） ─────────
  ['assert.doesNotMatch(src, /re/)（否定式与 assert.ok(!src.includes(…)) 同口径，r15-1）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.doesNotMatch(src, /NEGATED_ANCHOR/)'), ['/NEGATED_ANCHOR/']],
  ['src.matchAll(/re/g)（与 src.match 同一件事，只是多了一个 All，r15-3）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.ok(src.matchAll(/GLOBAL_ANCHOR/g))'), ['/GLOBAL_ANCHOR/g']],
  ['JSON.stringify(src).includes(…)（只转义不改写内容，不是 sanitizer，r15-4）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "assert.ok(JSON.stringify(fs.readFileSync('a.js', 'utf8')).includes('JSON_ANCHOR'))"), ['JSON_ANCHOR']],
  ['const { codeOnly } = loadModel(f)（解构容器字段与 loadModel(f).codeOnly 同口径，r15-2）',
    lines("const assert = require('node:assert')",
      "function loadModel (f) { return { code: 'x', codeOnly: 'x' } }",
      "const { codeOnly } = loadModel('a.js')",
      "assert.ok(codeOnly.includes('DESTRUCTURED_FIELD'))"), ['DESTRUCTURED_FIELD']],
  ['helper 锚点形参（function hasFileText (file, anchor) { …includes(anchor) } 的每个调用点，r15-5）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "function hasFileText (file, anchor) { return fs.readFileSync(file, 'utf8').includes(anchor) }",
      "assert.ok(hasFileText('a.js', 'LANE_A'))",
      "assert.ok(hasFileText('a.js', 'LANE_B'))"), [DYN, 'LANE_A', 'LANE_B']],
  // ── r18-A1：同一本地函数在**不同调用点**传/不传源码文本时，只有传进去的那次入账 ──────
  // 旧实现把形参污染做成全文件所有调用点共用的 binding ⇒ 这处 `pick(readFileSync(…))` 会让
  // 另外两次 `pick([])` 也记成 dynamic（幽灵命中）。期望值刻意只列 1 条。
  ['同一本地函数按调用点实参入账（pick(readFileSync(…)) 记 1 条，pick([]) 的两次调用不记，r18-A1）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'function pick (items) { return (items || []).filter((x) => x.pid) }',
      "assert.deepStrictEqual(pick(fs.readFileSync('a.js', 'utf8')), [])",
      'assert.deepStrictEqual(pick([]), [])',
      'assert.deepStrictEqual(pick([]), [])'), [DYN]]
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
      "assert.ok(arr.includes('x'))"), []],
  // r12-1 的反向：运算符/等值形态**只有一侧绑源码文本时才成立**——量纲断言与纯字面量比较必须放行，
  // 否则全仓的行数断言（`src.split('\\n').length === 42`）会把基线灌成噪声。
  ['量纲断言不计：src.length === 3 / typeof src === \'string\' / 行数 strictEqual',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      'assert.ok(src.length === 3)',
      "assert.strictEqual(src.split('\\n').length, 42)",
      "assert.strictEqual(typeof src, 'string')"), []],
  ['两侧都是字面量 / 未绑源码文本的字符串比较不计',
    lines("const assert = require('node:assert')",
      "const plain = 'hello'",
      "assert.strictEqual('abc', 'abc')",
      "assert.strictEqual(plain, 'hello')"), []],
  // r13-1 的另一侧：数字/下标/枚举比较不是逐字比对（否则 `!== -1` 这一族会把基线灌满）。
  ['下标 / 计数 / 量纲比较不计：idx !== -1、map.get(k) === 数字常量',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      "const src = fs.readFileSync('a.js', 'utf8')",
      "const lines = src.split('\\n')",
      'const idx = lines.length - 1',
      'assert.ok(idx !== -1)',
      'const TIMEOUTS = new Map()',
      'const DEFAULT_TIMEOUT_MS = 300000',
      "assert.strictEqual(TIMEOUTS.get('seg'), DEFAULT_TIMEOUT_MS)"), []],
  // r13-4：parseShell 的 tokens 是**解析后的结构化数据**，不是源码排版——token 级断言不算源码文本断言。
  // 不这样登记，按 spec 用 parseShell 换掉文本断言的包会看到条数不降反升，而探针对同一条断言判 format-clean。
  ['parseShell 的 tokens 是结构化数据（token 级等值断言不计，r13-4）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'function parseShell (f) {',
      "  return fs.readFileSync(f, 'utf8').split('\\n').map((line) => ({ line, tokens: line.split(' ') }))",
      '}',
      "const l = parseShell('pre-commit')",
      "assert.strictEqual(l.tokens[0], 'run_gate')",
      "assert.ok(l.tokens.includes('check:assert-style'))"), []],
  // ── r15 的反向：补齐检测面不得把「不是逐字比对」的写法一起算进来 ─────────────────
  ['matchAll 用在普通字符串上（receiver 不是源码文本，r15-3）',
    lines("const assert = require('node:assert')",
      "const s = 'hello world'",
      'assert.ok(s.matchAll(/hello/g))'), []],
  ['解构容器的非文本字段（const { file } = loadModel(f); file.startsWith(…) 不是逐字比对，r15-2）',
    lines("const assert = require('node:assert')",
      "function loadModel (f) { return { code: 'x', codeOnly: 'x' } }",
      "const { file } = loadModel('a.js')",
      "assert.ok(file.startsWith('/tmp'))"), []],
  ['真 sanitizer 仍放行：yaml.load 之后比字段（r15-4 只摘掉 JSON.stringify，不许顺手废掉解析器）',
    lines("const fs = require('node:fs')", "const yaml = require('js-yaml')",
      "const cfg = yaml.load(fs.readFileSync('config.yml', 'utf8'))",
      "assert.ok(cfg.segments.includes('build'))"), []],
  // r17-A 的反向：别名只用来取量纲（行数/长度）时不是逐字比对——检测面变宽不得把行数断言灌进基线。
  ['解构重命名的读取器只取行数（readSource(f).split(…).length，r17-A 反向）',
    lines("const { readFileSync: readSource } = require('node:fs')", "const assert = require('node:assert')",
      "const lines = readSource('a.js', 'utf8').split('\\n')",
      'assert.ok(lines.length > 3)'), []],
  ['.bind 读取别名只取长度（readSource(f).length，r17-A 反向）',
    lines("const fs = require('node:fs')", "const assert = require('node:assert')",
      'const readSource = fs.readFileSync.bind(fs)',
      "const n = readSource('a.js', 'utf8').length",
      'assert.ok(n > 0)'), []],
  // r18-A1 的反向：同一本地函数在不同调用点传/不传源码文本——按**本次实参**判定，
  // `pick([])` 与期望值两侧都是字面量，旧实现（形参污染 = 全文件并集）把它记成 dynamic。
  ['同一本地函数的纯字面量调用点（pick([]) 两侧都是字面量，r18-A1 反向：并集污染不得外溢到无污染调用点）',
    lines("const assert = require('node:assert')",
      'function pick (items) { return (items || []).filter((x) => x.pid) }',
      'assert.deepStrictEqual(pick([]), [])',
      'assert.deepStrictEqual(pick([]), [])'), []]
]

// ── A/B 执行：正向形态数 = POSITIVE.length，反向形态数 = NEGATIVE.length ────────────
// 标签里的数字**由数组长度算**，不手写：套件说明（test_suites.js 的 desc）与注释里手写的
// 「17 种 / 16 种」曾经三处互相矛盾（r12-5），这里不再留第二个可漂移的副本。
check(`检测面：${POSITIVE.length} 种「读源码文本」写法逐个命中（含旧实现漏检的：r4-1 的绕过写法 + r8-1 的等价形态 + r12-1 的运算符/等值断言族）`, () => {
  const missed = POSITIVE.filter(([, code, expected]) => {
    const got = analyzeSource(code, 'positive.js').map((hit) => hit.literal)
    return JSON.stringify(got) !== JSON.stringify(expected)
  }).map(([label, code, expected]) => {
    const got = analyzeSource(code, 'positive.js').map((hit) => hit.literal)
    return `${label}: 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(got)}`
  })
  assert.deepStrictEqual(missed, [], '以下形态没被识别（漏检 = 这条闸门对这些写法形同不存在）：\n' + missed.join('\n'))
})

check(`反向：${NEGATIVE.length} 类非源码文本 / 量纲形态一律不命中（res.text / 遮蔽 / JSON.parse / 普通串 / .length / typeof）`, () => {
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

// ── r12-2：`module.exports = fn`（默认导出）的跨文件摘要 ─────────────────────
// 反例（评审实测）：「一个文件一个 helper」写成默认导出时，`moduleTargetOf` 对 exportName === '*' 直接
// return null，而 exportsMap 恰好把 `module.exports = fn` 记在 '*' 下 —— 收集了从不使用。调用点
// `hasText(src, 'X')` 因此 0 命中、exit 0；改成 `module.exports = { hasText }` 立刻 exit 1。
check('跨文件 helper：module.exports = fn（默认导出）与命名导出同口径（r12-2）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_support/hastext.js', lines('module.exports = function hasText (s, n) { return s.includes(n) }'))
  write(dir, 'test_use_default.js', lines(
    "const fs = require('node:fs')",
    "const hasText = require('./test_support/hastext.js')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => hasText(src, 'DEFAULT_EXPORT')"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '默认导出的 helper 必须仍判红：' + result.out)
  assert.ok(/test_use_default\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(result.out),
    '命中必须记在调用点文件上：' + result.out)
  // 反向：同一文件改成命名导出后，`hasText(…)` 是「把模块对象当函数调」——不得凭空记一条命中。
  write(dir, 'test_support/hastext.js', lines(
    'function hasText (s, n) { return s.includes(n) }',
    'module.exports = { hasText }'
  ))
  const namespace = runChecker(dir)
  assert.strictEqual(namespace.status, 0, '模块对象被当函数调时不得记命中：' + namespace.out)
})

// ── r12-3：自身读源码文本的 helper（返回源码，不是 receiver 来自实参） ─────────
// 反例（评审实测）：`readSrc(f) { return fs.readFileSync(f, 'utf8') }` 放进 test_support/，断言写
// `assert.ok(readSrc('xbk_function_v3.js').includes('X'))`——两个文件都在扫描面内却都 0 命中，
// 新增任意多条永远绿。摘要必须记住「这个导出自己会读源码文本」，调用点按 readFileSync 同口径处理。
check('跨文件 helper：自身读源码文本的 helper（readSrc(f).includes(…)）跨 require 传播（r12-3）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_support/reader.js', lines(
    "const fs = require('node:fs')",
    "function readSrc (f) { return fs.readFileSync(f, 'utf8') }",
    'module.exports = { readSrc }'
  ))
  write(dir, 'test_use_reader.js', lines(
    "const assert = require('node:assert')",
    "const { readSrc } = require('./test_support/reader.js')",
    "assert.ok(readSrc('xbk_function_v3.js').includes('RETURN_SOURCE'))"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '返回源码文本的 helper 必须判红：' + result.out)
  assert.ok(/test_use_reader\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(result.out),
    '命中必须记在调用点文件上：' + result.out)
  // 反向：只做文本整形、自己不读文件的 helper（wrap(s){return s.trim()}）收到普通字符串时不得记命中。
  write(dir, 'test_support/reader.js', lines(
    'function wrap (s) { return s.trim() }',
    'module.exports = { wrap }'
  ))
  write(dir, 'test_use_reader.js', lines(
    "const assert = require('node:assert')",
    "const { wrap } = require('./test_support/reader.js')",
    "assert.ok(wrap('hello').includes('hell'))"
  ))
  const plain = runChecker(dir)
  assert.strictEqual(plain.status, 0, '不自己读文件的整形 helper 不得被当成源码文本：' + plain.out)
})

// ── r13-2：require 绑定的三种等价写法（成员取值 / 成员别名 / 行内 require） ──────────
// 反例（评审实测，基线 1 条）：三种写法全部 0 命中、exit 0 —— 只有 `const { x } = require('./h')`
// 与 `const m = require('./h')` + `m.x(…)` 两种形态被 linkRequire / moduleTargetOf 认。
// 它们不是构造出来的形态：仓内已有 `require('./scripts/mutation-report.js').EXPECTED_SEGMENTS` 这类写法。
check('跨文件 helper：三种等价 require 绑定写法都入账（成员取值 / 成员别名 / 行内 require，r13-2）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  write(dir, 'h.js', lines(
    "const fs = require('node:fs')",
    "function readSrc (f) { return fs.readFileSync(f, 'utf8') }",
    'function hasText (s, n) { return s.includes(n) }',
    'module.exports = { readSrc, hasText }'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  // ① `const readSrc = require('./h.js').readSrc`：init 是 MemberExpression（旧实现要求 CallExpression）
  write(dir, 'test_member.js', lines(
    "const assert = require('node:assert')",
    "const readSrc = require('./h.js').readSrc",
    "assert.ok(readSrc('x.js').includes('MEMBER_BIND'))"
  ))
  // ② `const fn = h.hasText`：成员别名（旧实现没有任何别名登记）
  write(dir, 'test_alias.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const h = require('./h.js')",
    "const src = fs.readFileSync('x.js', 'utf8')",
    'const fn = h.hasText',
    "assert.ok(fn(src, 'ALIASED_BIND'))"
  ))
  // ③ 行内 `require('./h.js').readSrc(…)`：callee.object 是 CallExpression（旧实现只认 Identifier）
  write(dir, 'test_inline.js', lines(
    "const assert = require('node:assert')",
    "assert.ok(require('./h.js').readSrc('x.js').includes('INLINE_BIND'))"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '三种绑定写法都必须判红：' + result.out)
  for (const file of ['test_member.js', 'test_alias.js', 'test_inline.js']) {
    // 按行查子串，不构造 RegExp（CodeQL incomplete-sanitization + Codacy non-literal RegExp 的来源）：
    // 原意不变 —— 该文件必须被闸门单独点名「基线 0 / 实测 1 / +1」这一行，少了它本条即红。
    const hit = result.out.split('\n').some((line) => line.includes(file) && line.includes('基线 0 / 实测 1 / +1'))
    assert.ok(hit, `${file} 必须记 1 条命中：` + result.out)
  }
})

// ── r13-3：容器的 code / codeOnly 字段就是源码文本（loadModel 不是洗白通道） ──────────
// 反例（评审实测）：`codeOnly(f).includes('X')` 计 1 条，而 `loadModel(f).codeOnly.includes('X')` 与
// `const m = loadModel(f); m.code.includes('X')` 都计 0 条 —— 同一段源码文本、同一种子串比对，
// 只多一层容器壳就能让白名单归零，而 spec §2 又把 codeOnly 列为 loadModel 的字段。
check('跨文件：loadModel(f).codeOnly / m.code 的成员访问按源码文本入账（r13-3）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  write(dir, 'test_support/model.js', lines(
    "const fs = require('node:fs')",
    'function buildModel (file, code) { return { file, code, codeOnly: code } }',
    "function loadModel (f) { return buildModel(f, fs.readFileSync(f, 'utf8')) }",
    'module.exports = { loadModel }'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_container_inline.js', lines(
    "const assert = require('node:assert')",
    "const { loadModel } = require('./test_support/model.js')",
    "assert.ok(loadModel('x.js').codeOnly.includes('CONTAINER_INLINE'))"
  ))
  write(dir, 'test_container_bound.js', lines(
    "const assert = require('node:assert')",
    "const { loadModel } = require('./test_support/model.js')",
    "const m = loadModel('x.js')",
    "assert.ok(m.code.includes('CONTAINER_BOUND'))"
  ))
  // 再套一层：先把字段接到变量上（`const s = m.codeOnly`），也必须继续污染。
  write(dir, 'test_container_alias.js', lines(
    "const assert = require('node:assert')",
    "const { loadModel } = require('./test_support/model.js')",
    "const m = loadModel('x.js')",
    'const text = m.codeOnly',
    "assert.ok(text.includes('CONTAINER_ALIAS'))"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '容器字段必须按源码文本入账：' + result.out)
  for (const file of ['test_container_inline.js', 'test_container_bound.js', 'test_container_alias.js']) {
    // 同上一处：按行查子串、不构造 RegExp；原意不变（每个文件必须被点名「基线 0 / 实测 1 / +1」）。
    const hit = result.out.split('\n').some((line) => line.includes(file) && line.includes('基线 0 / 实测 1 / +1'))
    assert.ok(hit, `${file} 必须记 1 条命中：` + result.out)
  }
})

// ── r13-4：parseShell 的 tokens 是结构化数据（按 spec 用它换文本断言时条数必须降，不是升） ──
// 反例（评审实测）：test_ci_static_gates.js 新写的接线断言与 test_source_model.js 的 parseShell 用例
// 共 13 条被当成「源码文本断言」冻进基线，而探针对同一条断言判 format-clean —— 两个仪器结论相反。
check('跨文件：parseShell 的 token 级断言不计入源码文本断言（r13-4）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  write(dir, 'test_support/shell.js', lines(
    "const fs = require('node:fs')",
    'function parseShell (f) {',
    "  return fs.readFileSync(f, 'utf8').split('\\n').map((line) => ({ line, tokens: line.split(' ') }))",
    '}',
    'module.exports = { parseShell }'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_shell_tokens.js', lines(
    "const assert = require('node:assert')",
    "const { parseShell } = require('./test_support/shell.js')",
    "const l = parseShell('pre-commit')",
    "assert.strictEqual(l.tokens[0], 'run_gate')",
    "assert.ok(l.tokens.includes('check:assert-style'))",
    "assert.deepStrictEqual(l.tokens, ['run_gate', 'npm', 'run', 'lint'])"
  ))
  const tokens = runChecker(dir)
  assert.strictEqual(tokens.status, 0, 'token 级断言不得计入（否则按 spec 换写法时条数不降反升）：' + tokens.out)
  // 反向证明闸门仍然活着：同一个文件里加一条真正的源码文本断言，必须判红。
  write(dir, 'test_shell_text.js', lines(
    "const assert = require('node:assert')",
    "const fs = require('node:fs')",
    "const hook = fs.readFileSync('pre-commit', 'utf8')",
    "assert.ok(hook.includes('run_gate'))"
  ))
  const text = runChecker(dir)
  assert.strictEqual(text.status, 1, '同一文件里的源码文本断言必须仍然判红：' + text.out)
})

// ── r15-1：否定式断言（assert.doesNotMatch）不得让条数归零 ────────────────────
// 反例（评审实测）：`assert.ok(!src.includes('X'))` 记 1 条 exit 1；改写成 `assert.doesNotMatch(src, /X/)`
// （Node 断言库做同一件事的惯用写法）后该文件记 0 条、闸门 exit 0。整族否定式等于免费通行证。
check('r15-1 否定式：assert.ok(!includes) 改写成 assert.doesNotMatch 后条数不降、仍判红', () => {
  const dir = makeWorkspace()
  write(dir, 'test_seed.js', FIXTURE_OK)
  write(dir, 'test_neg.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "assert.ok(!src.includes('LANE_NEG'))"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  assert.strictEqual(allowlistOf(dir).by_file['test_neg.js'].all, 1, '基线必须记 1 条')
  // 等价改写：同一个断言换成 doesNotMatch 形态。
  write(dir, 'test_neg.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'assert.doesNotMatch(src, /LANE_NEG/)'
  ))
  const same = runChecker(dir)
  assert.strictEqual(same.status, 0, '条数不降不得判红：' + same.out)
  assert.ok(/test_neg\.js\s+1（literal 1 \/ dynamic 0）/.test(same.out), '改写后必须仍是 1 条 literal：' + same.out)
  // 再补一条（第 2 条 doesNotMatch）必须判红：证明它不是「恒定记 1 条」。
  write(dir, 'test_neg.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'assert.doesNotMatch(src, /LANE_NEG/)',
    'assert.doesNotMatch(src, /LANE_NEG_2/)'
  ))
  const grew = runChecker(dir)
  assert.strictEqual(grew.status, 1, '第二条否定式断言必须判红（逐条计数，不是恒记 1）：' + grew.out)
  assert.ok(/test_neg\.js\s+基线 1 \/ 实测 2 \/ \+1/.test(grew.out), '必须点名该文件 +1：' + grew.out)
})

// ── r15-2：容器字段解构（const { codeOnly } = loadModel(f)）──────────────────
// 反例（评审实测）：`loadModel(f).codeOnly.includes('X')` 记 1 条，而 `const { codeOnly } = loadModel(f)`
// 之后 `codeOnly.includes('X')` 记 0 条——把同一份源码文本换个接法就能让白名单归零。
// 跨文件形态是真实缺口：同文件里参数污染会顺带污染解构绑定，跨文件摘要把返回值只标成「容器」。
check('r15-2 容器解构：const { codeOnly } = loadModel(f) 与 loadModel(f).codeOnly 同口径', () => {
  const dir = makeWorkspace()
  write(dir, 'test_seed.js', FIXTURE_OK)
  write(dir, 'test_support/model.js', lines(
    "const fs = require('node:fs')",
    'function buildModel (file, code) { return { file, code, codeOnly: code } }',
    'function loadModel (f) {',
    "  const code = fs.readFileSync(f, 'utf8')",
    '  return buildModel(f, code)',
    '}',
    'module.exports = { loadModel }'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_member.js', lines(
    "const assert = require('node:assert')",
    "const { loadModel } = require('./test_support/model.js')",
    "assert.ok(loadModel('a.js').codeOnly.includes('MEMBER_FIELD'))"
  ))
  const member = runChecker(dir)
  assert.strictEqual(member.status, 1, '成员访问形态必须判红（对照）：' + member.out)
  write(dir, 'test_destr.js', lines(
    "const assert = require('node:assert')",
    "const { loadModel } = require('./test_support/model.js')",
    "const { codeOnly } = loadModel('a.js')",
    "assert.ok(codeOnly.includes('DESTRUCTURED_FIELD'))"
  ))
  const destructured = runChecker(dir)
  assert.strictEqual(destructured.status, 1, '解构形态必须同样判红：' + destructured.out)
  assert.ok(/test_destr\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(destructured.out),
    '强制命中记在解构的调用点文件上：' + destructured.out)
  // 反向：解构出来的不是容器文本字段（file）就必须仍记 0——只按字段名认，不把整个 init 当污染。
  write(dir, 'test_other_field.js', lines(
    "const assert = require('node:assert')",
    "const { loadModel } = require('./test_support/model.js')",
    "const { file } = loadModel('a.js')",
    "assert.ok(file.startsWith('/tmp'))"
  ))
  const other = runChecker(dir)
  assert.ok(!other.out.includes('test_other_field.js'), '非文本字段不得记命中：' + other.out)
})

// ── r15-3：matchAll 与 match 同口径（检测面变宽，不是「新写断言」）────────────────
check('r15-3 matchAll：src.matchAll(/re/g) 与 src.match(/re/) 同口径入账', () => {
  const dir = makeWorkspace()
  write(dir, 'test_seed.js', FIXTURE_OK)
  write(dir, 'test_match.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'assert.ok(src.match(/FUNC_ANCHOR/))'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  assert.strictEqual(allowlistOf(dir).by_file['test_match.js'].all, 1, 'match 形态记 1 条')
  write(dir, 'test_matchall.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    'assert.ok(src.matchAll(/FUNC_ANCHOR/g))'
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, 'matchAll 形态必须判红：' + result.out)
  assert.ok(/test_matchall\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(result.out), '必须点名 matchAll 文件：' + result.out)
})

// ── r15-4：JSON.stringify 不是 sanitizer（只转义、不改写内容）──────────────────
check('r15-4 JSON.stringify：字符串化后的源码文本仍是源码文本（真解析器仍放行）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_seed.js', FIXTURE_OK)
  write(dir, 'test_support/yaml.js', lines(
    "const yaml = require('js-yaml')",
    "const fs = require('node:fs')",
    "module.exports.loadYaml = (f) => yaml.load(fs.readFileSync(f, 'utf8'))"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_stringify.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "assert.ok(JSON.stringify(fs.readFileSync('a.js', 'utf8')).includes('JSON_ANCHOR'))"
  ))
  const gate = runChecker(dir)
  assert.strictEqual(gate.status, 1, 'JSON.stringify 之后的子串比对必须判红：' + gate.out)
  assert.ok(/test_stringify\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(gate.out), '必须点名该文件：' + gate.out)
  // 同一个探针必须对同一条断言判 format-coupled——修前闸门 exit 0 而探针判 coupled（口径相反）。
  const probe = runProbe(dir, 'test_stringify.js')
  assert.strictEqual(probe.status, 1, '探针必须判 format-coupled：' + probe.out)
  assert.ok(/test_stringify\.js\s+format-coupled/.test(probe.out), '探针输出必须点名 format-coupled：' + probe.out)
  // 反向：解析器产出的是结构化数据，字段比较照旧放行（不许把 sanitizer 整族废掉）。
  write(dir, 'test_sanitized.js', lines(
    "const assert = require('node:assert')",
    "const { loadYaml } = require('./test_support/yaml.js')",
    "const cfg = loadYaml('config.yml')",
    "assert.ok(cfg.segments.includes('build'))"
  ))
  const sanitized = runChecker(dir)
  assert.strictEqual(sanitized.status, 1, '（此时仍只因 test_stringify.js 判红）' + sanitized.out)
  assert.ok(!sanitized.out.includes('test_sanitized.js'), 'yaml.load 之后的字段比较不得记命中：' + sanitized.out)
})

// ── r15-5：helper 的「锚点形参」——N 次调用必须记 N 条（不是 3 → 1） ─────────────
// 反例（评审实测）：`function hasFileText (file, anchor) { return readFileSync(file,'utf8').includes(anchor) }`
// + 3 次调用，条数从 3 降到 1（只剩 helper 体内那条 <dynamic>），闸门只报 shortfall 并 exit 0。
check('r15-5 helper 锚点形参：3 条字面量断言改写成 helper + 3 次调用后仍逐调用点入账', () => {
  const dir = makeWorkspace()
  write(dir, 'test_anchor.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "assert.ok(src.includes('LANE_1'))",
    "assert.ok(src.includes('LANE_2'))",
    "assert.ok(src.includes('LANE_3'))"
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  assert.strictEqual(allowlistOf(dir).by_file['test_anchor.js'].all, 3, '基线必须记 3 条')
  const rewrite = (n) => lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    // 先接成变量再比（receiver 是标识符、fromSource 传播这一路）：锚点形参必须照样认出来。
    "function hasFileText (file, anchor) { const s = fs.readFileSync(file, 'utf8'); return s.includes(anchor) }",
    ...Array.from({ length: n }, (_, i) => `assert.ok(hasFileText('a.js', 'LANE_${i + 1}'))`)
  )
  write(dir, 'test_anchor.js', rewrite(3))
  const three = runChecker(dir)
  assert.ok(/test_anchor\.js \d+（literal 3 /.test(three.out),
    '3 次调用必须逐调用点记 3 条 literal（不得 3 → 1）：' + three.out)
  // 逐条计数的证明：再加 3 次调用，literal 必须变 6（不是「每个 helper 恒记 1」）。
  write(dir, 'test_anchor.js', rewrite(6))
  const six = runChecker(dir)
  assert.ok(/test_anchor\.js \d+（literal 6 /.test(six.out),
    '6 次调用必须记 6 条 literal：' + six.out)
  assert.strictEqual(six.status, 1, '相对基线 3 必须判红：' + six.out)
  // 6 次调用 + helper 体内那条 <dynamic> = 7；基线 3 ⇒ +4（逐调用点计数，不是恒定值）。
  assert.ok(/test_anchor\.js\s+基线 3 \/ 实测 7 \/ \+4/.test(six.out), '必须按增量点名（6 次调用 + 1 条体内）：' + six.out)
})

// ── r15-5 跨文件形态：helper 在 test_support/，锚点走形参，调用点逐个入账 ──────────
check('r15-5 跨文件 helper 锚点形参：require 过来的 hasFileText(f, anchor) 逐调用点入账', () => {
  const dir = makeWorkspace()
  write(dir, 'test_seed.js', FIXTURE_OK)
  write(dir, 'test_support/hasfile.js', lines(
    "const fs = require('node:fs')",
    "function hasFileText (file, anchor) { return fs.readFileSync(file, 'utf8').includes(anchor) }",
    'module.exports = { hasFileText }'
  ))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'test_use_file_helper.js', lines(
    "const assert = require('node:assert')",
    "const { hasFileText } = require('./test_support/hasfile.js')",
    "assert.ok(hasFileText('a.js', 'CROSS_LANE_1'))",
    "assert.ok(hasFileText('a.js', 'CROSS_LANE_2'))",
    "assert.ok(hasFileText('a.js', 'CROSS_LANE_3'))"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '跨文件锚点形参必须判红：' + result.out)
  assert.ok(/test_use_file_helper\.js\s+基线 0 \/ 实测 3 \/ \+3/.test(result.out),
    '必须逐调用点记 3 条（不是 0，也不是 1）：' + result.out)
})

// ── r17-A：读取函数的别名解析（解构重命名 / .bind）────────────────────────────
// 反例（评审实测，隔离副本）：`const { readFileSync: readSource } = require('node:fs')` 与
// `const readSource = fs.readFileSync.bind(fs)` 两种写法各建一份夹具，`node scripts/check-source-text-asserts.js`
// 都输出「✅ 未新增源码文本断言」、exit 0；只把 `: readSource` 加上就让整族失明。对照组（裸 includes）exit 1。
// 这里锁三层：两种别名形态各自判红并点名；改回裸 includes 仍判红（别名不是检测面的必要条件）；
// 只取量纲时不入账（检测面变宽不得把行数断言灌进基线）。
check('r17-A 读取别名：解构重命名与 .bind 都判红，改回裸 includes 仍红', () => {
  const dir = makeWorkspace()
  write(dir, 'test_seed.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  const bare = (anchor) => lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    `assert.ok(src.includes('${anchor}'))`
  )
  write(dir, 'test_alias_destr.js', lines(
    "const { readFileSync: readSource } = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = readSource('a.js', 'utf8')",
    "assert.ok(src.includes('DESTRUCTURE_RENAME'))"
  ))
  write(dir, 'test_alias_bind.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    'const readSource = fs.readFileSync.bind(fs)',
    "const src = readSource('a.js', 'utf8')",
    "assert.ok(src.includes('BOUND_READER'))"
  ))
  const aliased = runChecker(dir)
  assert.strictEqual(aliased.status, 1, '两种读取别名都必须判红（旧实现两种都 exit 0）：' + aliased.out)
  assert.ok(/test_alias_destr\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(aliased.out), '必须点名解构重命名文件：' + aliased.out)
  assert.ok(/test_alias_bind\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(aliased.out), '必须点名 .bind 文件：' + aliased.out)
  // 反例：把两种夹具都改回裸 includes，断言一条没少 ⇒ 仍判红（不得因为别名被移除而「变绿」）。
  write(dir, 'test_alias_destr.js', bare('DESTRUCTURE_RENAME'))
  write(dir, 'test_alias_bind.js', bare('BOUND_READER'))
  const reverted = runChecker(dir)
  assert.strictEqual(reverted.status, 1, '改回裸 includes 后仍必须判红：' + reverted.out)
  assert.ok(reverted.out.includes('test_alias_destr.js') && reverted.out.includes('test_alias_bind.js'),
    '两个文件都必须仍在超基线清单里：' + reverted.out)
  // 反向：别名只用来取行数 / 长度，不是逐字比对 ⇒ 不得入账（否则检测面一放宽就灌基线）。
  write(dir, 'test_alias_destr.js', lines(
    "const { readFileSync: readSource } = require('node:fs')",
    "const assert = require('node:assert')",
    "const lines = readSource('a.js', 'utf8').split('\\n')",
    'assert.ok(lines.length > 3)'
  ))
  write(dir, 'test_alias_bind.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    'const readSource = fs.readFileSync.bind(fs)',
    "const n = readSource('a.js', 'utf8').length",
    'assert.ok(n > 0)'
  ))
  const counts = runChecker(dir)
  assert.strictEqual(counts.status, 0, '量纲断言不得入账：' + counts.out)
  assert.ok(!counts.out.includes('test_alias_destr.js') && !counts.out.includes('test_alias_bind.js'),
    '两个别名文件都不得出现在命中清单里：' + counts.out)
})

// ── r18-A1：本地函数调用点按**本次实参**入账（不是全文件并集）─────────────────────
// 反例（评审实测，隔离副本）：`function pick(items){return (items||[]).filter(x=>x.pid)}` 只要有**一处**
// `pick(readFileSync(…))`，旧实现就让 `pick([])` 的两次调用也按「返回源码文本」计（形参污染是所有调用点
// 共用的流不敏感并集）⇒ 3 处方言里 2 处是幽灵命中；真实仓 scripts/check-host-clean.js:414
// `assert.deepStrictEqual(findOrphanSuites([], 1, []), [])` 两侧全字面量也被计 dynamic。
// 同一机制的假绿：先按 3 条幽灵命中冻结基线，再把传源码文本的调用点换成 2 条真断言 ⇒ 2 = 基线 2 ⇒ exit 0。
// 这里锁三层：检测面（纯字面量 0 条 / 混合 1 条）、CLI 假绿回归（换真断言必须 +1 判红）、以及真实仓那行形状。
check('r18-A1 调用点污染按实参：pick([]) 不计数，传源码文本那次才计数（幽灵命中不得抵消失新增）', () => {
  const pickSrc = 'function pick (items) { return (items || []).filter((x) => x.pid) }'
  const pure = lines(
    "const assert = require('node:assert')",
    pickSrc,
    'assert.deepStrictEqual(pick([]), [])',
    'assert.deepStrictEqual(pick([]), [])'
  )
  assert.deepStrictEqual(analyzeSource(pure, 'a1_pure.js'), [],
    '两侧都是字面量的 pick([]) 不得计数（旧实现记 2 条 dynamic）')
  const homed = lines(
    "const assert = require('node:assert')",
    'function findOrphanSuites (a, b, c) { return (a || []).filter((x) => x.pid) }',
    'assert.deepStrictEqual(findOrphanSuites([], 1, []), [])'
  )
  assert.deepStrictEqual(analyzeSource(homed, 'a1_homed.js'), [],
    '真实仓 scripts/check-host-clean.js:414 的同类形状不得计数（旧实现记 1 条 dynamic）')
  // 混合形态：只有把源码文本传进去的那次是源码文本断言（另外两次仍是纯字面量）。
  const dir = makeWorkspace()
  const mixed = (anchorCalls) => lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    pickSrc,
    ...anchorCalls
  )
  write(dir, 'test_a1.js', mixed([
    "assert.deepStrictEqual(pick(fs.readFileSync('a.js', 'utf8')), [])",
    'assert.deepStrictEqual(pick([]), [])',
    'assert.deepStrictEqual(pick([]), [])'
  ]))
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  assert.deepStrictEqual(allowlistOf(dir).total, { all: 1, literal: 0, dynamic: 1 },
    '混合夹具只能冻结 1 条（旧实现会冻 3 条：另外两条是幽灵命中）')
  // 假绿回归：把「传源码文本」的调用点换成两条**真实**源码文本断言 ⇒ 实测 2 > 基线 1 ⇒ 必须判红。
  // （旧实现：基线 3、实测 2 ⇒ shortfall ⇒ ✅ exit 0，两条新断言被两条幽灵命中抵消。）
  write(dir, 'test_a1.js', lines(
    "const fs = require('node:fs')",
    "const assert = require('node:assert')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "assert.ok(src.includes('REAL_ONE'))",
    "assert.ok(src.includes('REAL_TWO'))"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, '两条新真断言必须判红（旧实现被幽灵命中抵消成 exit 0）：' + result.out)
  assert.ok(/test_a1\.js\s+基线 1 \/ 实测 2 \/ \+1/.test(result.out), '必须点名 +1：' + result.out)
})

// ── r18-A2：导出值是**嵌套一层的对象**时，其中的函数也要进摘要 ───────────────────
// 反例（评审实测）：`exports.reader = { read: function (f) { return fs.readFileSync(f, 'utf8') } }`
// + `viaObj.reader.read(f).includes('X')` ⇒ 实测 0 条、exit 0；把同一段读源码搬进 helper 只多套一层对象
// 就整族失明。修法：对象字面量导出递归登记（深度上限 + 环检测），成员链按点分路径取导出名。
check('r18-A2 嵌套导出：exports.reader.read(…) 与 reader 具名导入都判红，深层对象同样登记', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  const readerModule = lines(
    "const fs = require('node:fs')",
    "exports.reader = { read: function (f) { return fs.readFileSync(f, 'utf8') } }"
  )
  write(dir, 'test_support/obj.js', readerModule)
  write(dir, 'test_nested.js', lines(
    "const viaObj = require('./test_support/obj')",
    "const assert = require('node:assert')",
    "assert.ok(viaObj.reader.read('xbk_app.js').includes('CF4'))"
  ))
  const nested = runChecker(dir)
  assert.strictEqual(nested.status, 1, '嵌套一层的 reader 对象必须判红（旧实现 0 命中、exit 0）：' + nested.out)
  assert.ok(/test_nested\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(nested.out), '必须点名调用点文件：' + nested.out)
  // 具名导入（`const { reader } = require(…)`）走另一条解析分支（exportName + '.' + 余下路径）。
  write(dir, 'test_named.js', lines(
    "const { reader } = require('./test_support/obj')",
    "const assert = require('node:assert')",
    "assert.ok(reader.read('xbk_app.js').includes('CF4_NAMED'))"
  ))
  const named = runChecker(dir)
  assert.strictEqual(named.status, 1, '具名导入的嵌套对象也必须判红：' + named.out)
  assert.ok(/test_named\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(named.out), '必须点名 test_named.js：' + named.out)
  // 递归：多套一层（exports.a.b.read）同样登记。
  write(dir, 'test_support/deep.js', lines(
    "const fs = require('node:fs')",
    "exports.a = { b: { read: (f) => fs.readFileSync(f, 'utf8') } }"
  ))
  write(dir, 'test_deep.js', lines(
    "const deep = require('./test_support/deep')",
    "const assert = require('node:assert')",
    "assert.ok(deep.a.b.read('xbk_app.js').includes('CF4_DEEP'))"
  ))
  const deep = runChecker(dir)
  assert.strictEqual(deep.status, 1, '两层嵌套的对象导出也必须登记：' + deep.out)
  assert.ok(/test_deep\.js\s+基线 0 \/ 实测 1 \/ \+1/.test(deep.out), '必须点名 test_deep.js：' + deep.out)
  // 反向：嵌套对象里的方法不读文件（只整形入参）⇒ 不得凭空记命中。
  write(dir, 'test_support/obj.js', lines('exports.reader = { read: function (f) { return String(f).trim() } }'))
  write(dir, 'test_nested.js', lines(
    "const viaObj = require('./test_support/obj')",
    "const assert = require('node:assert')",
    "assert.ok(viaObj.reader.read('xbk_app.js').includes('NOT_SOURCE'))"
  ))
  write(dir, 'test_named.js', lines("const assert = require('node:assert')", 'assert.ok(1 === 1)'))
  write(dir, 'test_deep.js', lines("const assert = require('node:assert')", 'assert.ok(2 === 2)'))
  const plain = runChecker(dir)
  assert.strictEqual(plain.status, 0, '不读文件的嵌套方法不得被当成源码文本：' + plain.out)
})
// ── r12-4：扫描面 = 整棵仓库（显式跳过名单），任意新目录默认在内 ────────────────
// 反例（评审实测）：把「读源码 + 比对」整段搬进 helpers/，调用点只传锚点 —— helper 不在扫描面、
// 摘要因形参来源为空也不产条目，两处同时失明，闸门 exit 0 并提示「重跑 --write-allowlist 可收紧基线」。
check('扫描面：任意新目录（helpers/）默认在内——把「读源码 + 比对」整段搬走也判红（r12-4）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_base.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  write(dir, 'helpers/source_check.js', lines(
    "const fs = require('node:fs')",
    'module.exports.assertHas = function (file, needle, assert) {',
    "  const src = fs.readFileSync(file, 'utf8')",
    '  assert.ok(src.includes(needle))',
    '}'
  ))
  write(dir, 'test_use_helpers.js', lines(
    "const assert = require('node:assert')",
    "const { assertHas } = require('./helpers/source_check.js')",
    "assertHas('xbk_function_v3.js', 'HELPER_DIR_ANCHOR', assert)"
  ))
  const result = runChecker(dir)
  assert.strictEqual(result.status, 1, 'helpers/ 里的 helper 必须判红：' + result.out)
  assert.ok(result.out.includes('helpers/source_check.js'), '必须点名 helpers/source_check.js：' + result.out)
})

check('扫描面：整棵仓库（scripts/、根 run_*.js 在内），依赖 / 产物 / 被测系统在显式跳过名单里', () => {
  const scan = listScanFiles()
  for (const rel of ['scripts/check-deps.js', 'run_mutation.js', 'check-version.js', 'test_support/source_model.js']) {
    assert.ok(scan.includes(rel), `扫描面必须包含 ${rel}（封闭白名单已废弃）：${scan.length} 个文件里没有它`)
  }
  // 显式跳过名单：依赖 / 版本库 / 产物 / 缓存 / vendor bundle / 被测系统本身（见脚本头 REPO_SKIP）。
  const forbidden = scan.filter((rel) =>
    /^(?:xbk_[^/]*\.(?:js|cjs|mjs)|qinglong\/|deploy\/|scripts\/console-assets\/)/.test(rel) ||
    /(^|\/)(?:node_modules|\.git|\.stryker-tmp|\.nyc_output|coverage|reports|\.local|\.ai|\.tools)\//.test(rel) ||
    /(^|\/)xianbaoku_cache[^/]*\//.test(rel))
  assert.deepStrictEqual(forbidden.slice(0, 10), [], '跳过名单里的路径不得进扫描面：' + forbidden.slice(0, 10).join(', '))
  assert.ok(scan.length > 100, '扫描面应是整棵仓库（实测 140+ 个 .js），实得 ' + scan.length)
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

  const data = JSON.parse(fs.readFileSync(file, 'utf8')) // nosemgrep（file = mkdtemp 结果 + 本文件硬编码的 scripts/…json，无外部净输入）
  data.total.all += 1
  // 同上：写回隔离工作区里的基线副本，不碰真实仓库（ESLint 侧为何是裸注释：见上方豁免说明）

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

  const data = JSON.parse(fs.readFileSync(file, 'utf8')) // nosemgrep（同上：隔离工作区里的基线副本）
  data.by_file['test_base.js'] = { all: 0, literal: 0 }
  // 同上：写回隔离工作区里的基线副本（ESLint 侧为何是裸注释：见上方豁免说明）

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

  const inv = JSON.parse(fs.readFileSync(target, 'utf8')) // nosemgrep（target = os.tmpdir() + 进程号，测试自己建的仓库外文件）
  assert.strictEqual(inv.items.length, 2, '逐条清单条数必须等于实测')
  assert.deepStrictEqual(inv.total, { all: 2, literal: 1, dynamic: 1 }, 'literal / dynamic 必须分列')
  assert.deepStrictEqual(new Set(inv.items.map((item) => item.kind + ':' + item.literal)),
    new Set(['literal:LIT', 'dynamic:' + DYN]), 'kind 必须区分 literal 与 dynamic')
  assert.ok(inv.items.every((item) => item.file === 'test_inv.js' && Number.isInteger(item.line) && item.line > 0),
    '每条必须带 file / line：' + JSON.stringify(inv.items))
  // dir = mkdtemp 结果 + 本文件硬编码的 'inventory.json'，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）

  assert.ok(!fs.existsSync(path.join(dir, 'inventory.json')), '默认不得往仓库目录里写清单') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'inventory.json'，无外部净输入）
  // 仓库内路径一律拒绝（fail-closed），且拒绝时不留文件。
  const inside = path.join(dir, 'inventory.json')
  const refused = runChecker(dir, '--inventory', inside)
  assert.strictEqual(refused.status, 2, '写进仓库目录必须 exit 2：' + refused.out)
  assert.ok(/不得落在仓库目录内/.test(refused.out), '必须说清拒绝原因：' + refused.out)
  // inside = 隔离工作区路径，同上无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）

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

  const first = fs.readFileSync(file, 'utf8') // nosemgrep（file = 隔离工作区里的基线，比对 round-trip 用）
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0)
  // file = 上一处已读的隔离工作区基线，round-trip 比对用，无外部净输入（ESLint 侧为何是裸注释：见上方豁免说明）

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

// ── r13-6：--write-allowlist 必须与旧基线比较，增长一律拒绝写盘 ────────────────────
// 反例（评审实测）：旧实现重扫后直接写盘并 return 0，于是「新增断言后跑一次 --write-allowlist」就是
// 一条全绿通道（连 literal drift 都不报），「只减不增」只剩人工看 JSON diff。
check('--write-allowlist：增长被拒（须显式 --allow-growth，并打印逐文件差额，r13-6）', () => {
  const dir = makeWorkspace()
  write(dir, 'test_grow.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '首次生成基线必须放行')
  const frozen = allowlistOf(dir)
  assert.deepStrictEqual(frozen.total, { all: 1, literal: 1, dynamic: 0 }, '夹具先冻结 1 条')
  // 加一条同形态的断言：基线必须拒绝抬高。
  write(dir, 'test_grow.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('FIRST') && src.includes('GROWN')"
  ))
  const refused = runChecker(dir, '--write-allowlist')
  assert.strictEqual(refused.status, 1, '增长必须 exit 1（旧实现直接写盘并 exit 0）：' + refused.out)
  assert.ok(/拒绝写盘/.test(refused.out), '必须说清拒绝原因：' + refused.out)
  assert.ok(/test_grow\.js\s+1 → 2（\+1）/.test(refused.out), '必须打印逐文件差额：' + refused.out)
  assert.deepStrictEqual(allowlistOf(dir).total, frozen.total, '被拒时基线一个字节都不能改（total 仍 1）')
  // 显式 --allow-growth 才写盘，并且要把增长说出来。
  const allowed = runChecker(dir, '--write-allowlist', '--allow-growth')
  assert.strictEqual(allowed.status, 0, '--allow-growth 必须放行：' + allowed.out)
  assert.ok(/--allow-growth/.test(allowed.out), '接受增长必须留痕：' + allowed.out)
  assert.deepStrictEqual(allowlistOf(dir).total, { all: 2, literal: 2, dynamic: 0 }, '放行后基线应为 2 条')
  // 收紧（下降）不需要开关：基线只减不增，收紧跟得上。
  write(dir, 'test_grow.js', FIXTURE_OK)
  const shrunk = runChecker(dir, '--write-allowlist')
  assert.strictEqual(shrunk.status, 0, '条数下降必须直接放行：' + shrunk.out)
  assert.deepStrictEqual(allowlistOf(dir).total, { all: 1, literal: 1, dynamic: 0 }, '下降后基线收紧到 1 条')
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

// ── r18-B1：白名单「只减不增」必须是**机械**判据（不是人工看 JSON diff）────────────
// 反例（评审实测，scratch 副本）：往 test_console.js 加 3 条真断言 ⇒ exit 1；随后只改一行 JSON
// （by_file[test_console].all/.literal += 3、total.all/.literal += 3，内部自洽）⇒ 再跑同一命令
// 「✅ 未新增源码文本断言」exit 0。闸门全文没有一次 git 调用 ⇒ 基线历史无从核对。
// 这里锁：① 非 git 环境显式降级；② CI=true 时 fail-closed；③ 真 git 仓里「等量抬高」判红并点名；
// ④ --allow-growth 放行；⑤ --write-allowlist 也被同一参照约束；⑥ growth 登记写入后闸门放行并打印理由，
// ⑦ 登记与观察值不精确相等时仍判红。
const gitIn = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.email=gate@example.com', '-c', 'user.name=gate', ...args],
  { encoding: 'utf8' })

check('r18-B1 基线增长机械校验：等量抬高 by_file+total 判红，--allow-growth / growth 登记才放行', () => {
  // ① 非 git 环境：明确说明「无法核对」，行为不变（不因拿不到参照就判红）。
  const plain = makeWorkspace()
  write(plain, 'test_plain.js', FIXTURE_OK)
  assert.strictEqual(runChecker(plain, '--write-allowlist').status, 0, '基线应能写入')
  const noGit = runChecker(plain)
  assert.strictEqual(noGit.status, 0, '非 git 环境必须继续（exit 0）：' + noGit.out)
  assert.ok(noGit.out.includes('无法核对基线增长（非 git 环境）'),
    '非 git 环境必须显式说明无法核对基线增长：' + noGit.out)
  // ② 同一环境注入 CI=true ⇒ fail-closed（拿到不参照就不许放行）。
  const ci = runCheckerWith(plain, { CI: 'true' })
  assert.strictEqual(ci.status, 2, 'CI=true 且无参照必须 fail-closed（exit 2）：' + ci.out)
  assert.ok(/fail-closed/.test(ci.out), '必须说明 fail-closed 的原因：' + ci.out)

  // ②b 参照提交里**没有基线文件**（首个引入基线的 PR）：不是配置错误，不能 fail-closed——
  //     否则「第一次提交基线」这件事永远过不了 CI。必须显式说明并跳过增长核对。
  const firstPr = makeWorkspace()
  write(firstPr, 'test_first.js', FIXTURE_OK)
  assert.strictEqual(gitIn(firstPr, 'init', '-q', '-b', 'gate-base').status, 0, 'git init 必须成功')
  assert.strictEqual(gitIn(firstPr, 'add', '-A').status, 0, 'git add 必须成功')
  assert.strictEqual(gitIn(firstPr, 'commit', '-q', '-m', 'no baseline yet').status, 0, 'git commit 必须成功')
  const firstSha = gitIn(firstPr, 'rev-parse', 'HEAD').stdout.trim()
  assert.strictEqual(runChecker(firstPr, '--write-allowlist', '--baseline-ref', firstSha).status, 0, '首次冻结应放行')
  const firstRun = runCheckerWith(firstPr, { CI: 'true' }, '--baseline-ref', firstSha)
  assert.strictEqual(firstRun.status, 0, '参照里没有基线文件时不得 fail-closed：' + firstRun.out)
  assert.ok(/没有可比的历史/.test(firstRun.out), '必须显式说明跳过增长核对的原因：' + firstRun.out)
  // 反例：参照写成不存在的 sha ⇒ 那是真配置错误，必须 exit 2（不能当成「没有历史」混过去）。
  const bogus = runCheckerWith(firstPr, { CI: 'true' }, '--baseline-ref', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  assert.strictEqual(bogus.status, 2, '不可解析的显式参照必须 exit 2：' + bogus.out)

  // ③ 真 git 仓：冻结基线 → 提交 → 加 3 条真断言 + 手改基线等量抬高。
  const dir = makeWorkspace()
  write(dir, 'test_b1.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '首次冻结应放行')
  assert.deepStrictEqual(allowlistOf(dir).total, { all: 1, literal: 1, dynamic: 0 }, '先冻结 1 条')
  assert.strictEqual(gitIn(dir, 'init', '-q', '-b', 'gate-base').status, 0, 'git init 必须成功（用例依赖真 git 仓）')
  assert.strictEqual(gitIn(dir, 'add', '-A').status, 0, 'git add 必须成功')
  assert.strictEqual(gitIn(dir, 'commit', '-q', '-m', 'base').status, 0, 'git commit 必须成功')
  write(dir, 'test_b1.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('GROW_A') && src.includes('GROW_B') && src.includes('GROW_C') && src.includes('GROW_D')"
  ))
  const inflated = allowlistOf(dir)
  inflated.by_file['test_b1.js'] = { all: 4, literal: 4 }
  inflated.total = { all: 4, literal: 4, dynamic: 0 }
  fs.writeFileSync(
    path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), JSON.stringify(inflated, null, 2) + '\n')
  const raised = runChecker(dir)
  assert.strictEqual(raised.status, 1, '基线相对参照被抬高必须 exit 1（旧实现这里 exit 0）：' + raised.out)
  assert.ok(/基线相对参照 HEAD 被抬高 3 条/.test(raised.out), '必须点名抬高总量与参照：' + raised.out)
  assert.ok(/test_b1\.js\s+参照 1 \/ 当前 4 \/ \+3/.test(raised.out), '必须逐文件点名差额：' + raised.out)
  // ④ 显式 --allow-growth 才放行（并在输出里留痕）。
  const allowed = runChecker(dir, '--allow-growth')
  assert.strictEqual(allowed.status, 0, '--allow-growth 必须放行：' + allowed.out)
  assert.ok(/已按 --allow-growth 接受/.test(allowed.out), '放行必须留痕：' + allowed.out)
  // ⑤ --write-allowlist 也受同一参照约束：手改基线之后重生成，on-disk 差额为 0 但参照差额是 3。
  const regen = runChecker(dir, '--write-allowlist')
  assert.strictEqual(regen.status, 1, '--write-allowlist 必须也被 git 参照拦住：' + regen.out)
  assert.ok(/相对参照 HEAD 还多 3 条/.test(regen.out), '必须说明是相对参照的增长：' + regen.out)
  // ⑥ 带理由的 --allow-growth 重生成：增长登记进基线，闸门随后放行并打印理由。
  const reason = 'r18-B1 用例：人为抬高基线以验证 growth 登记'
  const written = runChecker(dir, '--write-allowlist', '--allow-growth', '--reason', reason)
  assert.strictEqual(written.status, 0, '带 --reason 的重生成必须放行：' + written.out)
  const baseSha = gitIn(dir, 'rev-parse', 'HEAD').stdout.trim()
  assert.deepStrictEqual(allowlistOf(dir).growth,
    { vs: 'HEAD', commit: baseSha, total: 3, by_file: { 'test_b1.js': 3 }, why: reason },
    '增长必须连同理由与**参照提交**登记进基线')
  const afterRecord = runChecker(dir)
  assert.strictEqual(afterRecord.status, 0, '已登记的 growth 必须让闸门放行：' + afterRecord.out)
  assert.ok(afterRecord.out.includes(reason), '闸门必须打印登记里的理由：' + afterRecord.out)
  // ⑥a 已登记的例外不得反过来把自己顶住：同一差额下不带 --allow-growth 也必须能重生成（逐字节一致）。
  const recordBytes = fs.readFileSync(path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), 'utf8')
  const regenWithRecord = runChecker(dir, '--write-allowlist')
  assert.strictEqual(regenWithRecord.status, 0, '差额与登记一致时必须允许重生成（否则登记一次就再也收紧不了）：' + regenWithRecord.out)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), 'utf8'), recordBytes,
    '重生成必须逐字节一致')
  // ⑥b 重生成不得抹掉留痕：把带登记的基线提交（参照随之更新）后再 --write-allowlist，应逐字节不变。
  const frozenBytes = fs.readFileSync(path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), 'utf8')
  assert.strictEqual(gitIn(dir, 'add', '-A').status, 0, 'git add 必须成功')
  assert.strictEqual(gitIn(dir, 'commit', '-q', '-m', 'raised').status, 0, 'git commit 必须成功')
  const regenStable = runChecker(dir, '--write-allowlist')
  assert.strictEqual(regenStable.status, 0, '无新增时可重生成：' + regenStable.out)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), 'utf8'), frozenBytes,
    '重生成必须逐字节一致，且不得抹掉已登记的增长记录')
  assert.deepStrictEqual(allowlistOf(dir).growth, { vs: 'HEAD', commit: baseSha, total: 3, by_file: { 'test_b1.js': 3 }, why: reason },
    '增长记录必须原样保留')
  // ⑦ 登记与观察值不精确相等 ⇒ 仍判红（「等价开关」不是一张长期通行证）：
  //    参照（上一次提交）是 4 条，再把基线抬到 5 条、而登记写的是 +3 ⇒ 观察到的 +1 对不上登记。
  const tampered = allowlistOf(dir)
  tampered.by_file['test_b1.js'] = { all: 5, literal: 5 }
  tampered.total = { all: 5, literal: 5, dynamic: 0 }
  fs.writeFileSync(
    path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), JSON.stringify(tampered, null, 2) + '\n')
  const mismatch = runChecker(dir)
  assert.strictEqual(mismatch.status, 1, 'growth 登记与观察值不等必须判红：' + mismatch.out)
  assert.ok(/被抬高 1 条/.test(mismatch.out), '必须按**观察到的**增量点名（不是登记里的数字）：' + mismatch.out)
  assert.ok(/test_b1\.js\s+参照 4 \/ 当前 5 \/ \+1/.test(mismatch.out), '必须逐文件点名差额：' + mismatch.out)
  // ⑧ 登记钉在写入时的参照提交上：差额、文件、理由全部对得上，只有 commit 指向别处 ⇒ 仍判红。
  //    没有这条，一条「+1 某文件」的旧登记会被日后任何同形状的增长反复复用（永久通行证）。
  const reused = allowlistOf(dir)
  reused.growth = {
    vs: 'HEAD',
    commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    total: 1,
    by_file: { 'test_b1.js': 1 },
    why: reason
  }
  fs.writeFileSync(
    path.join(dir, 'scripts', 'source-text-assert.allowlist.json'), JSON.stringify(reused, null, 2) + '\n')
  const stale = runChecker(dir)
  assert.strictEqual(stale.status, 1, '登记指向别的参照提交时必须判红（否则旧例外可被复用）：' + stale.out)
  assert.ok(/被抬高 1 条/.test(stale.out), '必须按观察值点名：' + stale.out)
})

// ── r18-C1：陈旧 inventory 快照不得参与 (file,literal) 逐条 diff ─────────────────
// 反例（评审实测）：inventory.json 的 total 是 2714、仓库基线是 3190，用这份快照做 diff 时
// 476 条**既有**命中都被当成「新增命中的位置」逐行打印（+1 的差额列出 2 处），
// 与 CHANGELOG v3.448「快照缺失或陈旧就显式说明只能按文件报增量，不猜行号」相反。
check('r18-C1 陈旧快照降级：inventory total 与基线不一致时只报文件增量、不打印 extras', () => {
  const dir = makeWorkspace()
  write(dir, 'test_stale.js', FIXTURE_OK)
  assert.strictEqual(runChecker(dir, '--write-allowlist').status, 0, '基线应能写入')
  const snap = path.join(os.tmpdir(), `xbk-inventory-stale-${process.pid}-${Date.now()}.json`)
  outsideFiles.push(snap)
  const frozen = runCheckerWith(dir, { SOURCE_TEXT_ASSERT_INVENTORY: snap }, '--inventory', snap)
  assert.strictEqual(frozen.status, 0, '快照必须能写出来：' + frozen.out)
  // 模拟「快照来自另一版基线」：total 与当前基线不一致（真实仓 2714 vs 3190 的同构最小化）。
  const staleData = JSON.parse(fs.readFileSync(snap, 'utf8'))
  staleData.total = { all: 5, literal: 5, dynamic: 0 }
  fs.writeFileSync(snap, JSON.stringify(staleData, null, 2) + '\n')
  // 新增一条真断言：条数判红（+1），但**行号**必须降级（快照不可信）。
  write(dir, 'test_stale.js', lines(
    "const fs = require('node:fs')",
    "const src = fs.readFileSync('a.js', 'utf8')",
    "module.exports = () => src.includes('FIRST')",
    "assert.ok(src.includes('ADDED'))"
  ))
  const result = runCheckerWith(dir, { SOURCE_TEXT_ASSERT_INVENTORY: snap })
  assert.strictEqual(result.status, 1, '新增断言必须仍判红（诊断降级不改退出码）：' + result.out)
  assert.ok(/逐条清单陈旧/.test(result.out), '必须显式说明快照陈旧：' + result.out)
  assert.ok(/total.*不一致|不一致/.test(result.out), '必须点出 total 不一致：' + result.out)
  assert.ok(/test_stale\.js\s+基线 1 \/ 实测 2 \/ \+1/.test(result.out), '仍须按文件报增量：' + result.out)
  assert.ok(!/test_stale\.js:\d/.test(result.out), '陈旧快照不得被用来打印「新增命中的位置」：' + result.out)
})

// ── 回归：拼接锚点 / 块内重赋值 / `return false` 兜底不得把真断言判没 ────────────
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

  const before = fs.readFileSync(path.join(dir, 'prod.js'), 'utf8') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'prod.js'，无外部净输入）
  assert.strictEqual(runProbe(dir, 'test_clean.js').status, 0)
  // 同上：读隔离工作区里的夹具，比对探针是否逐字节还原（ESLint 侧为何是裸注释：见上方豁免说明）

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

  const before = fs.readFileSync(path.join(dir, 'a.js'), 'utf8') // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'a.js'，无外部净输入）
  const result = runProbeWith(dir, { PROBE_FORCE_UNPARSEABLE: 'zz.js' }, 'test_clean2.js')
  assert.strictEqual(result.status, 2, '探针自身 bug 必须 exit 2（不产出 coupled 结论）：' + result.out)
  assert.ok(/已还原 [1-9][0-9]* 个文件/.test(result.out), '必须打印「已还原 N 个文件」（旧实现一个字都不提）：' + result.out)
  assert.ok(/重排后无法解析 zz\.js/.test(result.out), '必须点名触发分支的文件：' + result.out)
  // 同上：读隔离工作区里的夹具，验证 fail-closed 路径是否还原（ESLint 侧为何是裸注释：见上方豁免说明）

  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), before, // nosemgrep（同上：读隔离工作区里的夹具，验证 fail-closed 路径是否还原）
    'fail-closed 分支必须把先前已写盘的 a.js 逐字节还原（旧实现在这里整份留在重排态）')
})

check('探针：扰动面塌缩必须 exit 2（候选 < 下限 / 写盘 0 个，r13-7）', () => {
  // 「walk()/SKIP_DIRS 回归 ⇒ 候选 0 个」与「所有测试都不耦合」在输出上逐字相同 —— 这是唯一能分开的地方。
  const dir = probeWorkspace()
  write(dir, 'test_clean.js', CLEAN_TEST)
  const collapsed = runProbeStrict(dir, 'test_clean.js')
  assert.strictEqual(collapsed.status, 2, '夹具只有 3 个候选（< 默认下限 20）⇒ 必须 exit 2：' + collapsed.out)
  assert.ok(/下限 20/.test(collapsed.out) && /扰动面只有 [0-9]+ 个候选/.test(collapsed.out),
    '必须点明候选数与下限：' + collapsed.out)
  // 写盘 0 个文件（唯一候选重排后与原文逐字相同）⇒ 同样 fail-closed，不能靠「没有文件被改」判 clean。
  // 探针自己也是 .js 候选，所以把它放进 SKIP_DIRS 的目录（.tools/），并把 scripts/ 清空——
  // 这样 flat.json 是唯一候选，而紧凑 JSON 重排后与原文相同 ⇒ written.size 恒为 0。
  const flat = makeWorkspace()
  write(flat, 'flat.json', '{"a":1}\n')
  write(flat, 'test_clean3.js', CLEAN_TEST)
  write(flat, '.tools/probe.js', fs.readFileSync(PROBE, 'utf8')) // nosemgrep（PROBE = __dirname 常量，读的是本仓探针源码；只写进隔离工作区）
  fs.rmSync(path.join(flat, 'scripts'), { recursive: true, force: true })
  const nothing = runProbeAt(flat, path.join('.tools', 'probe.js'), 'test_clean3.js', '--min-candidates=0')
  assert.strictEqual(nothing.status, 2, '写盘 0 个文件必须 exit 2：' + nothing.out)
  assert.ok(/写了 0 个文件/.test(nothing.out), '必须说清是「一个文件都没重排」：' + nothing.out)
})

check('探针：真实仓扰动面 ≥ 20 个候选且含 .js/.yml/shell（下限不是空话）', () => {
  const { perturbableFiles, kindOf } = require('./scripts/probe-format-coupling.js')
  const files = perturbableFiles()
  assert.ok(files.length >= 20, '真仓扰动面必须 ≥ 20 个候选（实得 ' + files.length + '）')
  const kinds = new Set(files.map((rel) => kindOf(rel)))
  for (const kind of ['js', 'yaml', 'shell']) {
    assert.ok(kinds.has(kind), `扰动面必须含 ${kind}（实得 ${[...kinds].join(', ')}）：少了它那类资产的排版断言就探不到`)
  }
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

// ── 套件说明不得漂移（r12-5） ───────────────────────────────────────────────
// 注册表的 desc 是 run_tests 打印给开发者的唯一入口文档，也是「这道闸覆盖什么」的唯一说明。
// 它曾停在 v3.444 的「17 种写法 / 4 类必绿 / 多重集超次数」，而实际早已是 31+ / 6 且判据换成按文件计数，
// 同段注释里还写着第三个数字（16 种）——三处互相矛盾。这里让数字**跟着代码对账**：
// 改 POSITIVE / NEGATIVE / 增删一条检查而不同步改 desc，这条用例立刻红。
check('套件注册表的 desc 与实测用例数一致（数字不得再漂移：旧文案 17/16/31 三处互相矛盾）', () => {
  const { SUITES } = require('./test_suites.js')
  const entry = SUITES.find((suite) => suite.file === 'test_check_source_text_asserts.js')
  assert.ok(entry, '注册表里必须有本套件')
  // 本条检查自身也要计入总数：之前跑过的 + 本条 = 全套检查数。
  const total = harness.passed + harness.failures.length + 1
  for (const expected of [`${total} 条检查`, `${POSITIVE.length} 种`, `${NEGATIVE.length} 类`]) {
    assert.ok(entry.desc.includes(expected), `desc 必须写明「${expected}」（实测用例数变了就同步改 test_suites.js）：${entry.desc}`)
  }
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
