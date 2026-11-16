'use strict'

// v3.465：反回归闸自身的用例（scripts/check-source-text-asserts.js）。
//
// 为什么必须有这一套：闸门漏检不会让任何东西变红——旧实现（文件级变量名集合 + 正则）就是这样，
// 857/857 全绿却漏掉 helper 链 / 模板 / 正则 test / 多跳赋值 / 函数参数；反过来它又把
// `res.text.includes('…')` 这类非源码 receiver 误计进基线。下面每条用例都对着一个**已实测过的**
// 形态：正向必红（exit 1 且点名文件 + 增量），反向必绿（正确写法不入账 / 改动后恢复 exit 0）。
//
// 本版守 5 种形状（直接字面量 / 变量锚点与比较 / 模板插值 / reader 别名 / helper 返回源码与形参）：
// 闸门的 known-uncovered 清单（.call/.apply/.bind、计算成员、跨文件 helper、嵌套导出、JSON.stringify、
// parseShell tokens、split 下标、解构形参、运行期文件名）写在 scripts/check-source-text-asserts.js 文件头，
// 明确不覆盖——不要以为这里有对应用例就等于守住了。
//
// 全部在 `fs.mkdtempSync(os.tmpdir(), 'xbk-assertgate-')` 建的隔离工作区里跑：把闸脚本复制进去、
// 给 node_modules 软链、夹具写在那里面，跑完 rmSync 删掉。不碰真实基线，也不在仓库根留垃圾。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname)
const GATE = path.join(ROOT, 'scripts', 'check-source-text-asserts.js')
const ALLOW_REL = path.join('scripts', 'source-text-assert.allowlist.json')

// 每个形状在对应用例里的**实测命中数**：用例断言它、test_suites.js 的 desc 必须逐字写出它
// （改一处不改另一处就红——这就是「套件说明不得漂移」的机械判据）。
const SHAPE_HITS = { 1: 1, 2: 3, 3: 1, 4: 4, 5: 1 }
const SHAPE_CLAIMS = [
  `①直接字面量 +${SHAPE_HITS[1]}`,
  `②变量锚点/比较 +${SHAPE_HITS[2]}`,
  `③模板插值 +${SHAPE_HITS[3]}`,
  `④reader 别名 +${SHAPE_HITS[4]}`,
  `⑤helper 源码/形参 +${SHAPE_HITS[5]}`
]

// 与 test_ci_static_gates.js / test_doc_line_gates.js 同一套 harness 形态：每条检查独立捕获，
// passed/failed 双计数，末尾统一汇总并置非零退出码。
function createChecker (log = (s) => console.log(s)) {
  let passed = 0
  let registered = 0
  const failures = []
  return {
    check (label, fn) {
      registered++
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
    stats () {
      return { passed, failed: failures.length, registered }
    },
    summary () {
      if (!failures.length) {
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

/* ── 隔离工作区 ──────────────────────────────────────────────────────────── */
const workspaces = []

function makeWorkspace () {
  // dir = mkdtempSync 在 os.tmpdir() 下新建的本进程独占目录，无外部净输入
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-assertgate-')) // nosemgrep（os.tmpdir() + 本文件硬编码前缀，本进程独占随机目录）
  workspaces.push(dir)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true }) // nosemgrep（dir = mkdtemp 结果 + 本文件硬编码的 'scripts'）
  // 闸门脚本整份复制：ROOT 由 __dirname/.. 推出 ⇒ 副本把工作区当成仓库根，绝不碰真实仓库。
  fs.copyFileSync(GATE, path.join(dir, 'scripts', 'check-source-text-asserts.js')) // nosemgrep（源 = 本仓常量路径，目标 = mkdtemp 工作区 + 硬编码段）
  // 闸门 require('acorn')：软链到本仓 node_modules，不装依赖。
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir') // nosemgrep（两端都是本仓/本进程常量路径）
  return dir
}

function removeWorkspaces () {
  for (const dir of workspaces) {
    try {
      fs.rmSync(dir, { recursive: true, force: true }) // nosemgrep（dir = 本进程 mkdtemp 结果）
    } catch { /* 临时目录删不掉不影响结论 */ }
  }
}

function writeFile (ws, rel, content) {
  const abs = path.join(ws, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true }) // nosemgrep（abs 由 mkdtemp 工作区 + 本文件硬编码相对路径拼成）
  fs.writeFileSync(abs, content) // nosemgrep（同上一行：工作区内的夹具文件）
}

const readJson = (abs) => JSON.parse(fs.readFileSync(abs, 'utf8')) // nosemgrep（abs = mkdtemp 工作区内的基线文件；JSON.parse 后只取字段）

function writeBaseline (ws, data) {
  fs.writeFileSync(path.join(ws, ALLOW_REL), JSON.stringify(data, null, 2) + '\n') // nosemgrep（ws = mkdtemp 结果 + 硬编码相对路径）
}

// 在工作区里跑闸门（TZ=UTC）。返回 { code, out, err }。
// 夹具是**故意**没有 .git 的沙箱：闸门「CI 上参照不可得 ⇒ exit 2」这条不适用于这种目录，
// 故夹具子进程一律清掉 CI（该分支由「CI=true + 非 git 目录 ⇒ exit 2」那条用例显式覆盖，
// 不清会让本机全绿、CI 全红——GitHub Actions 恒设 CI=true）。
function runGate (ws, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(ws, 'scripts', 'check-source-text-asserts.js'), ...args], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    // SOURCE_TEXT_ASSERT_BASELINE_REF 也清空：宿主（或 CI）导出的参照不得漏进夹具——
    // 那几个「参照不可得 / 参照树无基线文件」用例的全部意义就是没有可用参照。
    env: { ...process.env, TZ: 'UTC', CI: '', SOURCE_TEXT_ASSERT_BASELINE_REF: '', ...env }
  })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

// 把「加了这一条 ⇒ 红且点名 file +N」与「删掉恢复 ⇒ 绿」写成一条用例的两个阶段。
function expectRedThenGreen (ws, rel, before, after, pattern, hits = 1) {
  writeFile(ws, rel, before)
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const green0 = runGate(ws)
  assert.strictEqual(green0.code, 0, `基线应能写 0 条：${green0.err}`)
  writeFile(ws, rel, before + after)
  const red = runGate(ws)
  assert.strictEqual(red.code, 1, `新增源码文本断言必须 exit 1，实得 ${red.code}\n${red.out}${red.err}`)
  assert.ok(red.err.includes(`${rel}  基线 0 / 实测 ${hits} / +${hits}`),
    `必须点名「文件 / 基线 / 实测 / 增量」（期望 +${hits}），实得：\n${red.err}`)
  assert.match(red.err, pattern, `必须标出形状与命中行，实得：\n${red.err}`)
  writeFile(ws, rel, before)
  const green1 = runGate(ws)
  assert.strictEqual(green1.code, 0, `删掉后必须恢复 exit 0：${green1.err}`)
  return red
}

/* ── 5 种形状：正向必红 / 删除恢复 ─────────────────────────────────────── */

check('形状① 直接 assert.ok(src.includes(字面量))：红并点名 文件 +1、标出①与行号', () => {
  const ws = makeWorkspace()
  const head = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    ''
  ].join('\n')
  const red = expectRedThenGreen(ws, 'test_direct.js', head,
    "assert.ok(src.includes('function messagesCacheName ('))\n",
    /test_direct\.js:4 .*（①直接字面量）/, SHAPE_HITS[1])
  assert.ok(red.out.includes('基线 total=0'), '基线 total 必须打印出来')
  assert.ok(red.out.includes(`实测 total=${SHAPE_HITS[1]}`), '实测 total 必须打印出来')
})

check('形状② 变量实参 / 比较运算符 / assert.strictEqual 族：三条各记一条，量纲不计', () => {
  const ws = makeWorkspace()
  const body = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'const NEEDLE = "function messagesCacheName ("',
    'assert.ok(src.includes(NEEDLE))',
    'assert.strictEqual(src, "const a = 1")',
    'assert.ok(src.split("\\n").includes("const b = 2"))',
    'assert.strictEqual(src.length, 3)',
    'assert.strictEqual(typeof src, "string")',
    ''
  ].join('\n')
  writeFile(ws, 'test_operators.js', body)
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `必须 exit 1，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes(`test_operators.js  基线 0 / 实测 ${SHAPE_HITS[2]} / +${SHAPE_HITS[2]}`),
    `变量锚点 + 等值比较 + 行数组比对共 ${SHAPE_HITS[2]} 条（.length / typeof 是量纲不计），实得：\n${r.err}`)
  assert.ok(r.err.includes('（②变量锚点/比较）'), '必须标出形状②')
  // 下降方向：只留量纲断言后必须绿（否则闸门只会红、不能对账）。
  writeFile(ws, 'test_operators.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'assert.strictEqual(src.length, 3)',
    'assert.strictEqual(typeof src, "string")',
    ''
  ].join('\n'))
  const green = runGate(ws)
  assert.strictEqual(green.code, 0, `只剩量纲断言后必须绿：${green.err}`)
})

check('形状③ 模板插值（插值锚点不可冻结）：同样必须计入', () => {
  const ws = makeWorkspace()
  const head = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'const name = "messagesCacheName"',
    ''
  ].join('\n')
  // 逐段拼接：`${…}` 写在普通字符串里会被 standard 的 no-template-curly-in-string 判红（夹具内容必须逐字是插值写法）。
  const interpolated = 'assert.ok(src.includes(`function ' + '${' + 'name} (`))\n'
  expectRedThenGreen(ws, 'test_template.js', head, interpolated, /test_template\.js:5 .*（③模板插值）/, SHAPE_HITS[3])
})

check('形状④ reader 别名：arrow / 解构重命名 / 成员赋值（fs.readFileSync 与 require(…).readFileSync）', () => {
  const ws = makeWorkspace()
  const body = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const { readFileSync: read } = require("node:fs")',
    'const readSrc = () => fs.readFileSync("scripts/console.js", "utf8")',
    'const readMember = fs.readFileSync',
    'const readRequired = require("node:fs").readFileSync',
    'assert.ok(readSrc().includes("function messagesCacheName ("))',
    'assert.ok(read("scripts/status.js", "utf8").includes("function messagesFileName ("))',
    'assert.ok(readMember("scripts/status.js", "utf8").includes("MEMBER_ALIAS_ANCHOR"))',
    'assert.ok(readRequired("scripts/status.js", "utf8").includes("REQUIRE_ALIAS_ANCHOR"))',
    ''
  ].join('\n')
  writeFile(ws, 'test_reader_alias.js', body)
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `必须 exit 1，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes(`test_reader_alias.js  基线 0 / 实测 ${SHAPE_HITS[4]} / +${SHAPE_HITS[4]}`),
    `arrow 别名 + 解构重命名 + 两种成员赋值共 ${SHAPE_HITS[4]} 条，实得：\n${r.err}`)
  assert.ok(r.err.includes('（④reader 别名）'), '必须标出形状④')
  assert.match(r.err, /test_reader_alias\.js:9 .*MEMBER_ALIAS_ANCHOR/,
    `const read = fs.readFileSync 必须入账（只认裸标识符会让最常见写法 0 命中），实得：\n${r.err}`)
  assert.match(r.err, /test_reader_alias\.js:10 .*REQUIRE_ALIAS_ANCHOR/, `require(…).readFileSync 必须入账，实得：\n${r.err}`)
})

check('形状⑤ helper 返回源码：本地函数返回值被判定为源码文本（不看函数名）', () => {
  const ws = makeWorkspace()
  const head = [
    '"use strict"',
    'const fs = require("node:fs")',
    'function anyNameAtAll (f) {',
    '  return fs.readFileSync(f, "utf8")',
    '}',
    ''
  ].join('\n')
  expectRedThenGreen(ws, 'test_helper.js', head,
    'assert.ok(anyNameAtAll("scripts/console.js").includes("registerRoute ("))\n',
    /test_helper\.js:6 .*（⑤helper 源码\/形参）/, SHAPE_HITS[5])
})

// r25-A：function 声明是提升的，调用点可以写在声明之前（断言在文件头、helper 在文件尾是本仓常见写法）。
// 旧实现三遍各自 newScope(null) ⇒ 记录遍在调用点处 helper/funcs 表仍为空 ⇒ 整条 ⑤ 链条静默 0 命中、
// 闸门照绿（实测 total=0 / exit 0）。这条用例把两种顺序、两条路（返回值 / 形参）都钉住。
check('形状⑤ 声明提升：调用点在 function 声明之前（返回值与形参两条路）同样必须红，顺序不改变结论', () => {
  const ws = makeWorkspace()
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const callFirst = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const assert = require("node:assert")',
    'assert.ok(laterDeclared("scripts/console.js").includes("HOIST_RETURN_ANCHOR"))',
    'function laterDeclared (f) {',
    '  return fs.readFileSync(f, "utf8")',
    '}',
    ''
  ].join('\n')
  writeFile(ws, 'test_hoist.js', callFirst)
  const red = runGate(ws)
  assert.strictEqual(red.code, 1,
    `调用点写在声明之前必须 exit 1（旧实现 0 命中、exit 0），实得 ${red.code}\n${red.out}${red.err}`)
  assert.ok(red.err.includes('test_hoist.js  基线 0 / 实测 1 / +1'),
    `必须点名该文件 +1，实得：\n${red.err}`)
  assert.match(red.err, /test_hoist\.js:4 .*（⑤helper 源码\/形参）/,
    `必须标出形状⑤与命中行，实得：\n${red.err}`)
  // 对照组：把 function 声明换到调用点之前，结论必须完全相同（顺序不是判据）。
  const declFirst = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const assert = require("node:assert")',
    'function laterDeclared (f) {',
    '  return fs.readFileSync(f, "utf8")',
    '}',
    'assert.ok(laterDeclared("scripts/console.js").includes("HOIST_RETURN_ANCHOR"))',
    ''
  ].join('\n')
  writeFile(ws, 'test_hoist.js', declFirst)
  const redControl = runGate(ws)
  assert.strictEqual(redControl.code, 1, `声明在前同样必须红，实得 ${redControl.code}\n${redControl.out}${redControl.err}`)
  assert.ok(redControl.err.includes('test_hoist.js  基线 0 / 实测 1 / +1'), `声明在前必须同样 +1，实得：\n${redControl.err}`)
  // 形参路：调用点在前、声明在后；命中点在函数体的比对处（第 7 行）。
  writeFile(ws, 'test_hoist.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const assert = require("node:assert")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'checkLate(src)',
    'function checkLate (t) {',
    '  assert.ok(t.includes("PARAM_HOIST_ANCHOR"))',
    '}',
    ''
  ].join('\n'))
  const redParam = runGate(ws)
  assert.strictEqual(redParam.code, 1,
    `形参收到源码文本 + 声明在后必须 exit 1（旧实现在调用点处 resolveFunc 为 null，0 命中），实得 ${redParam.code}\n${redParam.out}${redParam.err}`)
  assert.ok(redParam.err.includes('test_hoist.js  基线 0 / 实测 1 / +1'), `形参路必须 +1，实得：\n${redParam.err}`)
  assert.match(redParam.err, /test_hoist\.js:7 .*（⑤helper 源码\/形参）/, `形参命中必须标成 ⑤，实得：\n${redParam.err}`)
  // 反向：同样的提升顺序，但实参不是源码文本 ⇒ 不得入账（否则任何后置函数都会被误计）。
  writeFile(ws, 'test_hoist.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'checkLate("不是文件内容")',
    'function checkLate (t) {',
    '  assert.ok(t.includes("PARAM_HOIST_ANCHOR"))',
    '}',
    ''
  ].join('\n'))
  const green = runGate(ws)
  assert.strictEqual(green.code, 0, `实参不是源码文本时不得入账（提升顺序不改变这一点），实得：\n${green.out}${green.err}`)
})

/* ── 数据流边界：异步读取 / 形参 / 链式 reader / loadModel.code ─────────── */

check('异步读取链：await fs.promises.readFile(…) 与回调式 fs.readFile(…, (e, data) => …) 都必须入账', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_async.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'async function main () {',
    '  const s1 = await fs.promises.readFile("scripts/console.js", "utf8")',
    '  assert.ok(s1.includes("AWAIT_ANCHOR"))',
    '  fs.readFile("scripts/console.js", "utf8", (e, data) => {',
    '    assert.ok(data.includes("CALLBACK_ANCHOR"))',
    '  })',
    '}',
    'main()',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `异步读取必须 exit 1（旧实现在 AwaitExpression 处断流、0 命中），实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_async.js  基线 0 / 实测 2 / +2'), `await 与回调各 1 条，实得：\n${r.err}`)
  assert.match(r.err, /test_async\.js:5 .*AWAIT_ANCHOR.*（①直接字面量）/, `await 链必须入账，实得：\n${r.err}`)
  assert.match(r.err, /test_async\.js:7 .*CALLBACK_ANCHOR.*（⑤helper 源码\/形参）/, `回调形参必须入账，实得：\n${r.err}`)
})

check('同文件 helper 形参：const checkYml = (t) => … 再 checkYml(src) 按调用点入账', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_param.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const assert = require("node:assert")',
    'const checkYml = (ymlText) => {',
    '  const at = ymlText.indexOf("- name: 恢复增量缓存")',
    '  assert.ok(at >= 0, "必须存在该步骤")',
    '  assert.ok(ymlText.includes("stryker-"), "key 形态")',
    '}',
    'const ymlText = fs.readFileSync(".github/workflows/mutation.yml", "utf8")',
    'checkYml(ymlText)',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `形参收到源码文本必须 exit 1（旧实现记 0 条），实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_param.js  基线 0 / 实测 2 / +2'), `indexOf 与 includes 各 1 条，实得：\n${r.err}`)
  assert.ok(r.err.includes('（⑤helper 源码/形参）'), `形参命中必须标成 ⑤，实得：\n${r.err}`)
  // 实参不是源码文本时不得入账（否则任何 helper 都会被误计）。
  writeFile(ws, 'test_param.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'const checkYml = (ymlText) => {',
    '  assert.ok(ymlText.includes("stryker-"))',
    '}',
    'checkYml("不是文件内容")',
    ''
  ].join('\n'))
  const green = runGate(ws)
  assert.strictEqual(green.code, 0, `实参不是源码文本时不得入账：${green.err}`)
})

check('链式 reader：FILES.map((f) => …readFileSync…).join(\\n) 整条链判定为源码文本', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_readall.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const assert = require("node:assert")',
    'const FILES = ["scripts/console.js"]',
    'function readAll () {',
    '  return FILES.map((file) => {',
    '    const text = fs.readFileSync(file, "utf8")',
    '    return text',
    '  }).join("\\n")',
    '}',
    'const src = readAll()',
    'assert.ok(src.includes("function messagesCacheName ("))',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `链式 reader 必须 exit 1（旧实现 CHAIN_METHODS 有 join 无 map ⇒ 0 条），实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_readall.js  基线 0 / 实测 1 / +1'), `必须点名该文件 +1，实得：\n${r.err}`)
})

check('loadModel(f).code / model.code / const { code } = … 必须计入（不是「解析产物」）', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_model_code.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'const { loadModel } = require("./test_support/source_model")',
    'assert.ok(loadModel("scripts/console.js").code.includes("CHAIN_ANCHOR"))',
    'const model = loadModel("scripts/console.js")',
    'assert.ok(model.code.includes("MEMBER_ANCHOR"))',
    'const { code } = loadModel("scripts/console.js")',
    'assert.ok(code.includes("DESTRUCTURED_ANCHOR"))',
    'assert.ok(model.funcs.has("messagesCacheName"))',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `model.code 就是源码原文，必须 exit 1，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_model_code.js  基线 0 / 实测 3 / +3'),
    `三处写法各 1 条（funcs.has 是结构断言、不计），实得：\n${r.err}`)
})

// r25-C：`.codeOnly` 与 `.code` 同性质（只去注释、折叠空白，仍是读进来的原文）。旧实现只认 `.code`
// ⇒ 把 `src.includes(...)` 改写成 `loadModel(f).codeOnly.includes(...)` 会让该文件条数合法降到 0，
// 白名单能在断言一条未改的情况下归零（契约见脚本文件头与 SYSTEM_CONTRACT.md）。
check('容器字段 codeOnly：loadModel(f).codeOnly / model.codeOnly / const { codeOnly } = … 都必须计入', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_model_codeonly.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'const { loadModel } = require("./test_support/source_model")',
    'assert.ok(loadModel("scripts/console.js").codeOnly.includes("CHAIN_CODEONLY"))',
    'const model = loadModel("scripts/console.js")',
    'assert.ok(model.codeOnly.includes("MEMBER_CODEONLY"))',
    'const { codeOnly } = loadModel("scripts/console.js")',
    'assert.ok(codeOnly.includes("DESTRUCTURED_CODEONLY"))',
    'assert.ok(model.funcs.has("messagesCacheName"))',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `codeOnly 就是源码原文，必须 exit 1（旧实现 0 命中），实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_model_codeonly.js  基线 0 / 实测 3 / +3'),
    `三种写法各 1 条（funcs.has 是结构断言、不计），实得：\n${r.err}`)
  assert.match(r.err, /test_model_codeonly\.js:4 .*CHAIN_CODEONLY/, `loadModel(f).codeOnly 必须入账，实得：\n${r.err}`)
  assert.match(r.err, /test_model_codeonly\.js:6 .*MEMBER_CODEONLY/, `model.codeOnly 必须入账，实得：\n${r.err}`)
  assert.match(r.err, /test_model_codeonly\.js:8 .*DESTRUCTURED_CODEONLY/, `解构 codeOnly 必须入账，实得：\n${r.err}`)
  // 单条隔离副本：必须就是 1 条（这是「改写成容器字段 ⇒ 白名单归零」这条路的最小复现）。
  writeFile(ws, 'test_model_codeonly.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'const { loadModel } = require("./test_support/source_model")',
    'assert.ok(loadModel("x.js").codeOnly.includes("A"))',
    ''
  ].join('\n'))
  const one = runGate(ws)
  assert.strictEqual(one.code, 1, `单条 codeOnly 断言必须 exit 1，实得 ${one.code}\n${one.out}${one.err}`)
  assert.ok(one.err.includes('test_model_codeonly.js  基线 0 / 实测 1 / +1'),
    `必须 exactly 1 条（多算/少算都是口径漂移），实得：\n${one.err}`)
  // 反向：`.codeOnly` 落在**非** loadModel 视图对象上（普通对象字段）不得入账——否则任何同名属性都被误计。
  writeFile(ws, 'test_model_codeonly.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'const other = { codeOnly: "x" }',
    'assert.ok(other.codeOnly.includes("NOT_A_MODEL"))',
    ''
  ].join('\n'))
  const green = runGate(ws)
  assert.strictEqual(green.code, 0, `非 loadModel 视图对象的 .codeOnly 不得入账，实得：\n${green.out}${green.err}`)
})

check('解构出来的等值断言函数：const { strictEqual } / 重命名 eq 都必须入账', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_eq_alias.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const { strictEqual, strictEqual: eq } = require("node:assert/strict")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'strictEqual(src, "EQ_BARE_ANCHOR")',
    'eq(src, "EQ_RENAME_ANCHOR")',
    'assert.ok(src.includes("CONTROL_ANCHOR"))',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `解构等值断言必须 exit 1（旧实现只认成员调用），实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_eq_alias.js  基线 0 / 实测 3 / +3'), `三条各 1 条，实得：\n${r.err}`)
  assert.match(r.err, /test_eq_alias\.js:5 .*EQ_BARE_ANCHOR/, `裸标识符 strictEqual 必须入账，实得：\n${r.err}`)
  assert.match(r.err, /test_eq_alias\.js:6 .*EQ_RENAME_ANCHOR/, `重命名 eq 必须入账，实得：\n${r.err}`)
})

/* ── 反向：正确写法不入账 ───────────────────────────────────────────────── */

check('正确写法必绿：AST 结构断言 / 配置解析断言 / 行为断言都不计入', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_clean.js', [
    '"use strict"',
    'const assert = require("node:assert")',
    'const { loadModel, loadYaml } = require("./test_support/source_model")',
    'const model = loadModel("scripts/console.js")',
    'assert.ok(model.funcs.has("messagesCacheName"))',
    'assert.strictEqual(loadYaml(".github/workflows/test.yml").jobs.quality.runsOn, "ubuntu-latest")',
    'assert.strictEqual(process.exitCode || 0, 0)',
    'const data = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"))',
    'assert.strictEqual(data.name, "xbk-push")',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 0, `正确写法不得入账，实得 exit ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.out.includes('实测 total=0'), `实测必须是 0 条，实得：\n${r.out}`)
})

check('只扫测试面：scripts/ 与生产 .js 里的同样写法不入账', () => {
  const ws = makeWorkspace()
  const prod = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("xbk_function_v3.js", "utf8")',
    'module.exports = () => src.includes("shouldRun")',
    ''
  ].join('\n')
  writeFile(ws, 'scripts/console.js', prod)
  writeFile(ws, 'xbk_function_v3.js', prod)
  writeFile(ws, 'test_public.js', '"use strict"\nassert.strictEqual(1, 1)\n')
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 0, `生产文件不在扫描面，实得 exit ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.out.includes('实测 total=0'), `实测必须是 0 条，实得：\n${r.out}`)
})

/* ── 基线层 ─────────────────────────────────────────────────────────────── */

check('基线增长拒绝：--write-allowlist 不得把新增断言写进基线（须显式 --allow-growth --reason）', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_growth.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  writeFile(ws, 'test_growth.js', 'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(src.includes("X"))\n')
  const refused = runGate(ws, ['--write-allowlist'])
  assert.strictEqual(refused.code, 1, `增长必须拒绝写盘，实得 ${refused.code}\n${refused.out}${refused.err}`)
  assert.ok(refused.err.includes('拒绝写盘'), `必须说清拒绝理由，实得：\n${refused.err}`)
  assert.strictEqual(readJson(path.join(ws, ALLOW_REL)).total, 0, '被拒绝时基线文件不得被改写')
})

check('--allow-growth 必须同时给 --reason，且增长写进基线 growth 段留痕', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_growth.js', 'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(src.includes("X"))\n')
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const noReason = runGate(ws, ['--write-allowlist', '--allow-growth'])
  assert.strictEqual(noReason.code, 2, `--allow-growth 缺 --reason 必须 exit 2，实得 ${noReason.code}\n${noReason.out}${noReason.err}`)
  assert.ok(noReason.err.includes('--reason'), `必须点名缺 --reason，实得：\n${noReason.err}`)
  assert.strictEqual(readJson(path.join(ws, ALLOW_REL)).total, 0, '缺理由时不得写盘')
  const reason = '仪器变宽：r22-B1 接进链式 reader（逐文件已写入 CHANGELOG）'
  const accepted = runGate(ws, ['--write-allowlist', '--allow-growth', '--reason', reason])
  assert.strictEqual(accepted.code, 0, `显式 --allow-growth --reason 必须可写，实得：\n${accepted.out}${accepted.err}`)
  const written = readJson(path.join(ws, ALLOW_REL))
  assert.strictEqual(written.total, 1, '显式接受后基线 total 应为 1')
  assert.ok(written.growth, '增长必须写进基线的 growth 段（不留痕的放行等于没有门禁）')
  assert.strictEqual(written.growth.why, reason, 'growth.why 必须逐字记下 --reason')
  assert.strictEqual(written.growth.total, 1, 'growth.total 必须是本次增量')
  assert.strictEqual(written.growth.by_file['test_growth.js'], 1, 'growth.by_file 必须逐文件列出增量')
  assert.ok(accepted.out.includes(reason), `CI 日志里必须能看到理由，实得：\n${accepted.out}`)
  assert.strictEqual(runGate(ws).code, 0, '按新基线重跑必须绿')
})

check('基线自相矛盾（total ≠ by_file 之和）必须 exit 2，不当作放行', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_x.js', [
    '"use strict"',
    'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")',
    'assert.ok(src.includes("X"))',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 2, by_file: { 'test_x.js': 1 } })
  const r = runGate(ws)
  assert.strictEqual(r.code, 2, `必须 exit 2，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('基线自相矛盾'), `必须点明矛盾，实得：\n${r.err}`)
})

check('新文件（基线里没有）出现断言 → exit 1，按基线 0 算', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_old.js', '"use strict"\nassert.strictEqual(1, 1)\n')
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  writeFile(ws, 'test_new.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'assert.ok(src.includes("brandNew"))',
    ''
  ].join('\n'))
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `新文件必须红，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_new.js  基线 0 / 实测 1 / +1'), `必须点名新文件与增量，实得：\n${r.err}`)
})

check('条数下降只报 shortfall、不判红（本批逐包收敛的对账口径）', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_down.js', [
    '"use strict"',
    'const fs = require("node:fs")',
    'const src = fs.readFileSync("scripts/console.js", "utf8")',
    'assert.ok(src.includes("kept"))',
    ''
  ].join('\n'))
  writeBaseline(ws, { schema: 3, total: 3, by_file: { 'test_down.js': 3 } })
  const r = runGate(ws)
  assert.strictEqual(r.code, 0, `下降必须绿，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.out.includes('基线 total=3'), '基线 total 必须打印')
  assert.ok(r.out.includes('实测 total=1'), '实测 total 必须打印')
  assert.ok(r.out.includes('test_down.js\t2'), `必须按文件报 shortfall 2，实得：\n${r.out}`)
})

/* ── r21 原子写语义（r22-A4）：这三条是本轮唯一的写盘判据，缺一条就等于没守 ── */

// 预加载垫片：把闸门进程里对 fs 的三类写操作记成 JSON（只记录、不改语义）。
const SPY_PRELOAD = [
  "'use strict'",
  "const fs = require('node:fs')",
  'const out = process.env.SPY_LOG',
  'const ops = []',
  "for (const name of ['writeFileSync', 'renameSync', 'unlinkSync']) {",
  '  const original = fs[name]',
  '  fs[name] = function (...args) {',
  '    ops.push({ op: name, path: String(args[0]), dest: args[1] === undefined ? null : String(args[1]) })',
  '    return original.apply(this, args)',
  '  }',
  '}',
  "process.on('exit', () => { fs.writeFileSync(out, JSON.stringify(ops)) })",
  ''
].join('\n')

// 预加载垫片：让 rename 以 EIO 失败（模拟「临时文件写好了但替换失败」）。
const RENAME_FAIL_PRELOAD = [
  "'use strict'",
  "const fs = require('node:fs')",
  'fs.renameSync = function () {',
  "  const err = new Error('EIO: i/o error, rename')",
  "  err.code = 'EIO'",
  '  throw err',
  '}',
  ''
].join('\n')

const listTmp = (ws) => fs.readdirSync(path.join(ws, 'scripts')).filter((name) => name.endsWith('.tmp')) // nosemgrep（ws = mkdtemp 工作区；只列目录名）
const sha256 = (abs) => require('node:crypto').createHash('sha256').update(fs.readFileSync(abs)).digest('hex') // nosemgrep（abs = 工作区内的基线文件）

check('无旧基线时 --write-allowlist 直接写盘（ENOENT 分支不得退化成拒绝）', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_fresh.js', 'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(src.includes("FRESH_ANCHOR"))\n')
  // 不写基线：文件不存在就是「没有旧基线」这一事实本身
  assert.strictEqual(listTmp(ws).length, 0, '前置：目录里不该有 .tmp')
  const r = runGate(ws, ['--write-allowlist'])
  assert.strictEqual(r.code, 0, `没有旧基线时必须直接生成，实得 exit ${r.code}\n${r.out}${r.err}`)
  assert.strictEqual(readJson(path.join(ws, ALLOW_REL)).total, 1, '新基线必须记下实测条数')
  assert.deepStrictEqual(listTmp(ws), [], '写盘成功后不得留下 .tmp')
})

check('写盘失败：exit 2 + 原文件字节不变 + 临时文件被清掉', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_keep.js', 'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(src.includes("KEEP_ANCHOR"))\n')
  writeBaseline(ws, { schema: 3, total: 1, by_file: { 'test_keep.js': 1 } })
  const allow = path.join(ws, ALLOW_REL)
  const before = sha256(allow)
  writeFile(ws, 'preload_rename_fail.js', RENAME_FAIL_PRELOAD)
  const r = runGate(ws, ['--write-allowlist'], {
    NODE_OPTIONS: '--require ' + path.join(ws, 'preload_rename_fail.js')
  })
  assert.strictEqual(r.code, 2, `写盘失败必须 exit 2，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('基线写盘失败（原文件未改动）'), `必须说清原文件未改动，实得：\n${r.err}`)
  assert.strictEqual(sha256(allow), before, '失败时原基线必须逐字节不变')
  assert.deepStrictEqual(listTmp(ws), [], '失败路径必须清掉刚写的临时文件（否则每次失败都留垃圾）')
})

check('原子替换：必须 rename(tmp → 基线)，不得回退成 writeFileSync(基线)', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_atomic.js', 'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(src.includes("ATOMIC_ANCHOR"))\n')
  writeBaseline(ws, { schema: 3, total: 1, by_file: { 'test_atomic.js': 1 } })
  const allow = path.join(ws, ALLOW_REL)
  const log = path.join(ws, 'ops.json')
  writeFile(ws, 'preload_spy.js', SPY_PRELOAD)
  const r = runGate(ws, ['--write-allowlist'], {
    NODE_OPTIONS: '--require ' + path.join(ws, 'preload_spy.js'),
    SPY_LOG: log
  })
  assert.strictEqual(r.code, 0, `写盘必须成功，实得 ${r.code}\n${r.out}${r.err}`)
  const ops = JSON.parse(fs.readFileSync(log, 'utf8')) // nosemgrep（log = mkdtemp 工作区内的探针输出）
  assert.ok(Array.isArray(ops) && ops.length > 0, `探针必须记到 fs 调用，实得：${JSON.stringify(ops)}`)
  assert.ok(ops.some((o) => o.op === 'renameSync' && o.dest === allow),
    `必须 rename 到基线路径（原子替换），实得：${JSON.stringify(ops)}`)
  assert.ok(!ops.some((o) => o.op === 'writeFileSync' && o.path === allow),
    `不得直接 writeFileSync(基线)（既非原子，又与存在性探测构成 check-then-use），实得：${JSON.stringify(ops)}`)
})

check('参照不可得 + CI=true 必须 fail-closed exit 2（「读不到」不得读成「没有增长」）', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_ci.js', 'const s = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(s.includes("CI_ANCHOR"))\n')
  writeBaseline(ws, { schema: 3, total: 1, by_file: { 'test_ci.js': 1 } })
  // 本机（非 CI）在无 git 的目录里只打印原因并继续——夹具目录没有 .git 是构造出来的事实，不是「零增长」。
  const local = runGate(ws)
  assert.strictEqual(local.code, 0, `本机无 git 应打印原因后继续，实得 ${local.code}\n${local.out}${local.err}`)
  assert.ok(local.out.includes('无法核对增长'), `本机必须打印原因（不静默跳过），实得：\n${local.out}`)
  assert.ok(!local.out.includes('✓ 基线相对参照'), `本机不得把「读不到参照」印成 ✓ 未增长，实得：\n${local.out}`)
  // CI 上拿不到参照 = 不能证明基线没被抬高 ⇒ 必须退出，不按 on-disk 基线放行。
  const ci = runGate(ws, [], { CI: 'true' })
  assert.strictEqual(ci.code, 2, `CI 无参照必须 exit 2，实得 ${ci.code}\n${ci.out}${ci.err}`)
  assert.ok(ci.err.includes('CI 上 fail-closed'), `必须说清 fail-closed 的理由，实得：\n${ci.err}`)
})

/* ── 参照接线（r23-A1/B1/C1）：HEAD 不得当参照；参照不可得 / 无基线文件时不得判「未增长」 ────── */

// 下面四条要建**真实 git 仓库**（detached 单提交 / 有 base 引用 / 参照树缺基线文件 / 显式参照不可用）。
// git 一律以**绝对路径**调用：按名 spawn 会让子进程经 PATH 解析可执行文件（Sonar S4036），与
// test_install_hooks.js 的 GIT 常量同口径。解析不到直接 fail-closed——这几条不能静默跳过。
const GIT = (process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean)
  .map((dir) => path.join(dir, 'git'))
  .find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true } catch { return false }
  })
assert.ok(GIT, 'PATH 里找不到可执行的 git——参照核对的三态用例依赖真实 git，不得静默跳过')

// 沙箱化 git 环境：HOME/XDG 指向用例私有目录、禁用全局与系统 gitconfig（开发机上的 core.hooksPath /
// gpgsign / commit.template 会泄漏进夹具），并清掉调用方的 GIT_DIR 等变量（否则临时仓库的 git 操作
// 会被导向本仓）。提交身份用固定 env 给出，不写任何配置文件。
function gitEnv (ws) {
  const env = {
    ...process.env,
    HOME: ws,
    XDG_CONFIG_HOME: ws,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'xbk-assertgate',
    GIT_AUTHOR_EMAIL: 'assertgate@example.invalid',
    GIT_COMMITTER_NAME: 'xbk-assertgate',
    GIT_COMMITTER_EMAIL: 'assertgate@example.invalid'
  }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

function gitIn (ws, args) {
  const r = spawnSync(GIT, ['-C', ws, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: gitEnv(ws)
  })
  if (r.error) throw r.error
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} 必须成功，实得 exit ${r.status}：${r.stderr}`)
  return (r.stdout || '').trim()
}

// 默认分支固定叫 main（不依赖宿主的 init.defaultBranch）：init 后再挑 HEAD，任何 git ≥2.28 都成立。
function initGitRepo (ws) {
  writeFile(ws, '.gitignore', 'node_modules\n')
  gitIn(ws, ['init', '-q'])
  gitIn(ws, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
}

function commitAll (ws, message) {
  gitIn(ws, ['add', '-A', '--', '.'])
  gitIn(ws, ['commit', '-q', '-m', message])
}

// 基线的自洽形状（total = by_file 之和）：「by_file 与 total 等量 +1」正是 r22-B2 要拦的形态——
// 两个数一起改才自洽，所以夹具必须成对抬。
const baselineOf = (byFile) => ({
  schema: 3,
  total: Object.values(byFile).reduce((sum, n) => sum + n, 0),
  by_file: byFile
})

// 每个参照用例的夹具：恰好 1 条源码文本断言（`s.includes('…')`，形状①）。
const ONE_HIT_FIXTURE = [
  '"use strict"',
  'const s = require("node:fs").readFileSync("scripts/console.js", "utf8")',
  "assert.ok(s.includes('SELF_ANCHOR'))",
  ''
].join('\n')

check('参照不得是 HEAD 自身：main 指向被判定提交时改用它的父提交，手改 by_file+total 等量抬高必须 exit 1', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_selfref.js', ONE_HIT_FIXTURE)
  writeBaseline(ws, baselineOf({ 'test_selfref.js': 1 }))
  initGitRepo(ws)
  commitAll(ws, 'base')
  // r22-B2 的真实攻击形态：手改 by_file 与 total 各 +1，**和新断言一起提交**（内容自洽、on-disk 看不出来）。
  writeBaseline(ws, baselineOf({ 'test_selfref.js': 2 }))
  commitAll(ws, 'raise baseline')
  gitIn(ws, ['checkout', '-q', '--detach'])
  // CI 形态：main 仍指向被判定提交本身 ⇒ 旧实现拿 HEAD 自比自，打印 ✓ 未增长 exit 0。
  const r = runGate(ws, [], { CI: 'true' })
  assert.strictEqual(r.code, 1, `参照 == 被判定提交时必须改用父提交并抓到 +1，实得 exit ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_selfref.js  参照 1 / 当前 2 / +1'), `必须逐文件点名增量，实得：\n${r.err}`)
  assert.ok(r.out.includes('参照改用它的父提交'), `必须说明参照不是 HEAD 本身（改用父提交），实得：\n${r.out}`)
  assert.ok(!r.out.includes('✓ 基线相对参照 main 未增长'), `绝不许把「参照 == 自己」读成未增长，实得：\n${r.out}`)
})

check('参照不可得（detached、没有任何 base 引用）：CI exit 2，本机打印「无法核对增长」且不得出现 ✓', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_noref.js', ONE_HIT_FIXTURE)
  writeBaseline(ws, baselineOf({ 'test_noref.js': 1 }))
  initGitRepo(ws)
  commitAll(ws, 'base')
  writeBaseline(ws, baselineOf({ 'test_noref.js': 2 }))
  commitAll(ws, 'raise baseline')
  gitIn(ws, ['checkout', '-q', '--detach'])
  gitIn(ws, ['branch', '-D', 'main'])
  const ci = runGate(ws, [], { CI: 'true' })
  assert.strictEqual(ci.code, 2, `CI 形态没有任何参照必须 exit 2（旧实现退回 HEAD 自比自 exit 0），实得 ${ci.code}\n${ci.out}${ci.err}`)
  assert.ok(ci.err.includes('无法核对增长'), `CI 必须说清「无法核对增长」，实得：\n${ci.err}`)
  assert.ok(ci.err.includes('CI 上 fail-closed'), `CI 必须说清 fail-closed，实得：\n${ci.err}`)
  assert.ok(!ci.out.includes('✓ 基线相对参照'), `CI 上不得打印 ✓ 未增长，实得：\n${ci.out}`)
  const local = runGate(ws)
  assert.strictEqual(local.code, 0, `本机无参照按 on-disk 基线继续（exit 0），实得 ${local.code}\n${local.out}${local.err}`)
  assert.ok(local.out.includes('无法核对增长'), `本机必须打印「无法核对增长」而不是 ✓，实得：\n${local.out}`)
  assert.ok(!local.out.includes('✓ 基线相对参照'), `本机不得把「没有参照」读成「未增长」，实得：\n${local.out}`)
})

check('参照树里没有基线文件：只有「本变更新增 + 基线与实测完全一致」的首次引入放行，等量抬高仍 exit 2', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_newbase.js', ONE_HIT_FIXTURE)
  initGitRepo(ws)
  commitAll(ws, 'base without baseline') // base 分支：这份文件还不存在
  gitIn(ws, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  gitIn(ws, ['checkout', '-q', '-b', 'pr'])
  writeBaseline(ws, baselineOf({ 'test_newbase.js': 1 }))
  writeFile(ws, 'README.md', 'doc\n')
  commitAll(ws, 'introduce baseline')
  // ① 可证明的首次引入（新增该文件 + 基线逐文件 == 实测）：CI 也必须放行，否则基线永远进不了 base 分支；
  //    但输出只能说「无法核对增长（首次引入）」，绝不能声称 ✓ 未增长。
  const ci = runGate(ws, [], { CI: 'true' })
  assert.strictEqual(ci.code, 0, `可证明的首次引入在 CI 上必须放行（基线文件本身还没进 base 分支），实得 ${ci.code}\n${ci.out}${ci.err}`)
  assert.ok(ci.out.includes('无法核对增长'), `必须说清「无法核对增长」，实得：\n${ci.out}`)
  assert.ok(ci.out.includes('首次引入'), `必须说清这是首次引入、没有可比历史，实得：\n${ci.out}`)
  assert.ok(ci.out.includes('基线逐文件与实测完全一致'), `必须说清按哪条更强判据核对的，实得：\n${ci.out}`)
  assert.ok(!ci.out.includes('✓ 基线相对参照'), `CI 上不得打印 ✓ 未增长，实得：\n${ci.out}`)
  // ② 同一夹具手改 by_file 与 total 等量抬高 1 条（≠ 实测）⇒ 不得借「首次引入」放行：CI exit 2。
  writeBaseline(ws, baselineOf({ 'test_newbase.js': 2 }))
  commitAll(ws, 'raise baseline')
  const raised = runGate(ws, [], { CI: 'true' })
  assert.strictEqual(raised.code, 2, `首次引入时基线 ≠ 实测（等量抬高）必须 CI exit 2，实得 ${raised.code}\n${raised.out}${raised.err}`)
  assert.ok(raised.err.includes('基线逐文件与实测不一致'), `必须点名「基线 ≠ 实测」而不是笼统报参照不可得，实得：\n${raised.err}`)
  assert.ok(raised.err.includes('test_newbase.js 基线 2 / 实测 1'), `必须逐文件点名差额，实得：\n${raised.err}`)
  // ③ 本机（非 CI）：同一抬高态只降级为「无法核对增长」，仍不得打印 ✓。
  const local = runGate(ws)
  assert.strictEqual(local.code, 0, `本机应降级为只按当前基线判定（exit 0），实得 ${local.code}\n${local.out}${local.err}`)
  assert.ok(local.out.includes('无法核对增长'), `本机必须打印「无法核对增长」，实得：\n${local.out}`)
  assert.ok(!local.out.includes('✓ 基线相对参照'), `本机不得打印 ✓ 未增长，实得：\n${local.out}`)
  // ④ 保留既有的人工放行路径：--allow-growth 仍然放行，但同样只能打印 ⚠️（不留 ✓）。
  const accepted = runGate(ws, ['--allow-growth'])
  assert.strictEqual(accepted.code, 0, `--allow-growth 必须仍可放行，实得 ${accepted.code}\n${accepted.out}${accepted.err}`)
  assert.ok(accepted.out.includes('已按 --allow-growth 接受'), `必须留痕（说清是人工接受），实得：\n${accepted.out}`)
  assert.ok(!accepted.out.includes('✓ 基线相对参照'), `--allow-growth 放行时同样不得打印 ✓ 未增长，实得：\n${accepted.out}`)
})

check('显式参照不可用一律 exit 2（本机也不降级）；可用时真的核对增长', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_explicit.js', ONE_HIT_FIXTURE)
  writeBaseline(ws, baselineOf({ 'test_explicit.js': 1 }))
  initGitRepo(ws)
  commitAll(ws, 'base')
  // ① 拼错的 ref：本机也必须 exit 2——显式参照不可用不是「没有可比的历史」。
  const bogusFlag = runGate(ws, ['--baseline-ref', 'origin/does-not-exist'])
  assert.strictEqual(bogusFlag.code, 2, `拼错的 --baseline-ref 本机也必须 exit 2，实得 ${bogusFlag.code}\n${bogusFlag.out}${bogusFlag.err}`)
  assert.ok(bogusFlag.err.includes('显式指定的参照不可用'), `必须点名显式参照不可用，实得：\n${bogusFlag.err}`)
  // ② 同一个错误经 env 给出（CI 的注入路径），结论必须一致。
  const bogusEnv = runGate(ws, [], { SOURCE_TEXT_ASSERT_BASELINE_REF: 'origin/does-not-exist' })
  assert.strictEqual(bogusEnv.code, 2, `env 注入的坏参照同样必须 exit 2，实得 ${bogusEnv.code}\n${bogusEnv.out}${bogusEnv.err}`)
  // ③ 参照就是被判定提交本身、且根提交没有父提交 ⇒ 同样 exit 2，绝不退回自比自。
  const selfRef = runGate(ws, ['--baseline-ref', 'HEAD'])
  assert.strictEqual(selfRef.code, 2, `单提交仓库里 --baseline-ref HEAD 不得自比自，实得 ${selfRef.code}\n${selfRef.out}${selfRef.err}`)
  assert.ok(selfRef.err.includes('就是被判定提交本身'), `必须说清参照 == 被判定提交本身，实得：\n${selfRef.err}`)
  // ④ 可用时必须真的核对（否则「接上了」只是接了个字符串）：参照 = main（上一个提交），未抬高 ⇒ ✓ 未增长。
  gitIn(ws, ['checkout', '-q', '-b', 'pr'])
  writeFile(ws, 'README.md', 'doc\n')
  commitAll(ws, 'second commit')
  const green = runGate(ws, [], { SOURCE_TEXT_ASSERT_BASELINE_REF: 'main' })
  assert.strictEqual(green.code, 0, `可用参照且未增长必须 exit 0，实得 ${green.code}\n${green.out}${green.err}`)
  assert.ok(green.out.includes('✓ 基线相对参照 main 未增长'), `必须真的打印「✓ 未增长」（说明参照可用），实得：\n${green.out}`)
  // ⑤ 同一参照下把 on-disk 基线等量抬高 1 条 ⇒ exit 1 并逐文件点名。
  writeBaseline(ws, baselineOf({ 'test_explicit.js': 2 }))
  const raised = runGate(ws, [], { SOURCE_TEXT_ASSERT_BASELINE_REF: 'main' })
  assert.strictEqual(raised.code, 1, `参照可用时等量抬高必须 exit 1，实得 ${raised.code}\n${raised.out}${raised.err}`)
  assert.ok(raised.err.includes('test_explicit.js  参照 1 / 当前 2 / +1'), `必须逐文件点名增量，实得：\n${raised.err}`)
})

/* ── 重生成路径不得自锁（r22-C1）───────────────────────────────────────── */

check('--write-allowlist 能从旧 schema / 损坏 JSON 重生成；门禁路径仍 exit 2', () => {
  const ws = makeWorkspace()
  writeFile(ws, 'test_legacy.js', 'const src = require("node:fs").readFileSync("scripts/console.js", "utf8")\nassert.ok(src.includes("LEGACY_ANCHOR"))\n')
  // ① 旧 schema（schema 2 的锚点口径）
  writeFile(ws, ALLOW_REL, JSON.stringify({ schema: 2, total: { all: 999 }, by_file: {} }, null, 2) + '\n')
  const legacy = runGate(ws, ['--write-allowlist'])
  assert.strictEqual(legacy.code, 0, `旧 schema 必须能重生成，实得 ${legacy.code}\n${legacy.out}${legacy.err}`)
  assert.ok(legacy.out.includes('旧基线不可用'), `必须打印降级原因（不静默丢弃旧基线），实得：\n${legacy.out}`)
  const regenerated = readJson(path.join(ws, ALLOW_REL))
  assert.strictEqual(regenerated.schema, 3, '重生成后必须是 schema 3')
  assert.strictEqual(regenerated.total, 1, '重生成必须记下实测条数')
  // ② 半截 JSON
  writeFile(ws, ALLOW_REL, '{"schema":3,"total":0,"by_')
  const broken = runGate(ws, ['--write-allowlist'])
  assert.strictEqual(broken.code, 0, `损坏 JSON 必须能重生成，实得 ${broken.code}\n${broken.out}${broken.err}`)
  assert.ok(broken.out.includes('旧基线不可用'), `必须打印降级原因，实得：\n${broken.out}`)
  assert.strictEqual(readJson(path.join(ws, ALLOW_REL)).total, 1, '损坏 JSON 重生成后必须自洽')
  // ③ 门禁路径保持严格：读不出即 exit 2，绝不「读不出就写」
  writeFile(ws, ALLOW_REL, JSON.stringify({ schema: 2, total: 0, by_file: {} }, null, 2) + '\n')
  const strict = runGate(ws)
  assert.strictEqual(strict.code, 2, `门禁读不出旧基线必须 exit 2，实得 ${strict.code}\n${strict.out}${strict.err}`)
})

/* ── 端到端自检：真实仓库 ───────────────────────────────────────────────── */

check('端到端：真实仓库闸门 exit 0，且打印的 total 与 sum(by_file) 一致', () => {
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, TZ: 'UTC', CI: '' } })
  if (r.error) throw r.error
  const out = (r.stdout || '') + (r.stderr || '')
  assert.strictEqual(r.status, 0, `真实仓库闸门必须 exit 0，实得 ${r.status}\n${out}`)
  const baseline = readJson(path.join(ROOT, ALLOW_REL))
  assert.strictEqual(baseline.schema, 3, '基线必须是 schema 3')
  const sum = Object.values(baseline.by_file).reduce((n, v) => n + v, 0)
  assert.strictEqual(baseline.total, sum, '基线 total 必须等于 by_file 之和')
  assert.ok(out.includes(`基线 total=${baseline.total}`), `闸门必须打印基线 total：\n${out}`)
  assert.ok(out.includes(`实测 total=${sum}`), `闸门必须打印实测 total（= sum(by_file)）：\n${out}`)
  assert.ok(!Object.keys(baseline.by_file).some((f) => f.startsWith('scripts/')), '基线不得含生产源码文件')
})

/* ── 套件说明不得漂移（r22-C4）：desc 的数字由这里机械对账 ──────────────── */

check('套件说明不得漂移：test_suites.js 的 desc 与实际检查数 / 形状计数对账', () => {
  const { SUITES } = require('./test_suites.js')
  const entry = SUITES.find((suite) => suite.file === 'test_check_source_text_asserts.js')
  assert.ok(entry, 'test_suites.js 必须有本套件条目')
  // 本条是最后注册的一条，所以「已注册的检查数」就是总数（与前面用例是否通过无关）。
  const total = harness.stats().registered
  assert.ok(entry.desc.includes(`（${total} 检查）`),
    `desc 必须写「（${total} 检查）」（改用例数要同时改 test_suites.js 的 desc），实际 desc：${entry.desc}`)
  for (const claim of SHAPE_CLAIMS) {
    assert.ok(entry.desc.includes(claim), `desc 必须逐字写出每个形状的实测条数「${claim}」，实际 desc：${entry.desc}`)
  }
})

try {
  process.exitCode = harness.summary()
} finally {
  removeWorkspaces()
}
