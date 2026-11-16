'use strict'

// v3.463：反回归闸自身的用例（scripts/check-source-text-asserts.js）。
//
// 为什么必须有这一套：闸门漏检不会让任何东西变红——旧实现（文件级变量名集合 + 正则）就是这样，
// 857/857 全绿却漏掉 helper 链 / 模板 / 正则 test / 多跳赋值 / 函数参数；反过来它又把
// `res.text.includes('…')` 这类非源码 receiver 误计进基线。下面每条用例都对着一个**已实测过的**
// 形态：正向必红（exit 1 且点名文件 + 增量），反向必绿（正确写法不入账 / 改动后恢复 exit 0）。
//
// 本版只守 5 种形状（直接字面量 / 变量锚点与比较 / 模板插值 / reader 别名 / helper 返回源码）：
// 闸门的 known-uncovered 清单（.call/.apply/.bind、计算成员、跨文件 helper、嵌套导出、JSON.stringify、
// parseShell tokens、split 下标、基线手改）写在 scripts/check-source-text-asserts.js 文件头，
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

// 与 test_ci_static_gates.js / test_doc_line_gates.js 同一套 harness 形态：每条检查独立捕获，
// passed/failed 双计数，末尾统一汇总并置非零退出码。
function createChecker (log = (s) => console.log(s)) {
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
function runGate (ws, args = []) {
  const r = spawnSync(process.execPath, [path.join(ws, 'scripts', 'check-source-text-asserts.js'), ...args], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, TZ: 'UTC' }
  })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

// 把「加了这一条 ⇒ 红且点名 file +1」与「删掉恢复 ⇒ 绿」写成一条用例的两个阶段。
function expectRedThenGreen (ws, rel, before, after, pattern) {
  writeFile(ws, rel, before)
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const green0 = runGate(ws)
  assert.strictEqual(green0.code, 0, `基线应能写 0 条：${green0.err}`)
  writeFile(ws, rel, before + after)
  const red = runGate(ws)
  assert.strictEqual(red.code, 1, `新增源码文本断言必须 exit 1，实得 ${red.code}\n${red.out}${red.err}`)
  assert.ok(red.err.includes(`${rel}  基线 0 / 实测 1 / +1`),
    `必须点名「文件 / 基线 / 实测 / 增量」，实得：\n${red.err}`)
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
    /test_direct\.js:4 .*（①直接字面量）/)
  assert.ok(red.out.includes('基线 total=0'), '基线 total 必须打印出来')
  assert.ok(red.out.includes('实测 total=1'), '实测 total 必须打印出来')
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
  assert.ok(r.err.includes('test_operators.js  基线 0 / 实测 3 / +3'),
    `变量锚点 + 等值比较 + 行数组比对共 3 条（.length / typeof 是量纲不计），实得：\n${r.err}`)
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
  expectRedThenGreen(ws, 'test_template.js', head, interpolated, /test_template\.js:5 .*（③模板插值）/)
})

check('形状④ reader 别名：arrow 别名与解构重命名各记一条', () => {
  const ws = makeWorkspace()
  const body = [
    '"use strict"',
    'const fs = require("node:fs")',
    'const { readFileSync: read } = require("node:fs")',
    'const readSrc = () => fs.readFileSync("scripts/console.js", "utf8")',
    'assert.ok(readSrc().includes("function messagesCacheName ("))',
    'assert.ok(read("scripts/status.js", "utf8").includes("function messagesFileName ("))',
    ''
  ].join('\n')
  writeFile(ws, 'test_reader_alias.js', body)
  writeBaseline(ws, { schema: 3, total: 0, by_file: {} })
  const r = runGate(ws)
  assert.strictEqual(r.code, 1, `必须 exit 1，实得 ${r.code}\n${r.out}${r.err}`)
  assert.ok(r.err.includes('test_reader_alias.js  基线 0 / 实测 2 / +2'),
    `arrow 别名 + 解构重命名共 2 条，实得：\n${r.err}`)
  assert.ok(r.err.includes('（④reader 别名）'), '必须标出形状④')
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
    /test_helper\.js:6 .*（⑤helper 返回源码）/)
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

check('基线增长拒绝：--write-allowlist 不得把新增断言写进基线（须显式 --allow-growth）', () => {
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
  const accepted = runGate(ws, ['--write-allowlist', '--allow-growth'])
  assert.strictEqual(accepted.code, 0, `显式 --allow-growth 必须可写，实得：\n${accepted.err}`)
  assert.strictEqual(readJson(path.join(ws, ALLOW_REL)).total, 1, '显式接受后基线 total 应为 1')
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

/* ── 端到端自检：真实仓库 ───────────────────────────────────────────────── */

check('端到端：真实仓库闸门 exit 0，且打印的 total 与 sum(by_file) 一致', () => {
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, TZ: 'UTC' } })
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

try {
  process.exitCode = harness.summary()
} finally {
  removeWorkspaces()
}
