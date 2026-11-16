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
    env: { ...process.env, TZ: 'UTC', CI: '', ...env }
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
  assert.ok(local.out.includes('无法核对基线增长'), `本机必须打印原因（不静默跳过），实得：\n${local.out}`)
  // CI 上拿不到参照 = 不能证明基线没被抬高 ⇒ 必须退出，不按 on-disk 基线放行。
  const ci = runGate(ws, [], { CI: 'true' })
  assert.strictEqual(ci.code, 2, `CI 无参照必须 exit 2，实得 ${ci.code}\n${ci.out}${ci.err}`)
  assert.ok(ci.err.includes('CI 上 fail-closed'), `必须说清 fail-closed 的理由，实得：\n${ci.err}`)
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
