'use strict'

// v3.446（S0 r4 评审 must_fix r4-4）：`test_support/source_model.js` 的自动化用例。
//
// 为什么必须单独有一套：这 398 行共享工具层是后续每个包做「结构断言」的唯一入口，但此前**零用例**——
// loadModel / calls / members / funcs / exports / codeOnly / loadYaml / parseShell 全靠人工 smoke。
// 危害与 S0 自己要治的失效是同一类：`assert.ok(!hasFunction(f, '旧实现'))` 是仓库里最常见的
// 「不得再定义 X」写法，一旦 model 退化（collectFuncs 少收一类、memberPath 返回 null、缓存键漏改），
// **否定断言会静默变绿**，而正向断言（「有这个函数」）在空集合上会红——所以这里每条语义都配一对
// 「必须存在 / 必须不存在」，并额外断言集合规模下界（空集合 = 退化，必须红）。
//
// 全部夹具写在 `fs.mkdtempSync(os.tmpdir(), 'xbk-srcmodel-')` 里，跑完 rmSync 删掉：不读仓库源码、
// 不碰真实文件，因此本套件在变异沙箱里也能跑（不设 mutationSkip）。
// **但本套件仍受 scripts/check-source-text-asserts.js 管辖**（根 `test_*.js` 在扫描面内）：基线里
// 本文件已入账 5 条——`m.code === CJS_FIXTURE` 那类「相等比较」1 条 + `m.codeOnly.includes(…)` 4 条
// （`by_file: { "test_source_model.js": 5 }`）。所以「这里不比任何源码文本」是错的：写 code/codeOnly
// 的逐字比对同样要按基数额度算，多写一条就会让闸门 exit 1。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const model = require('./test_support/source_model.js')

// 与 test_ci_static_gates.js / test_check_source_text_asserts.js 同一套 harness 形态：
// 每条检查独立捕获，passed/failed 双计数，末尾统一汇总并置非零退出码（一条抛错不中断后续检查）。
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
        log(`✅ test_source_model 全部通过（${passed} 检查）`)
        return 0
      }
      log(`❌ test_source_model：${passed} 通过 / ${failures.length} 失败（共 ${passed + failures.length} 检查）`)
      for (const f of failures) log('   ❌ ' + f.label + '：' + f.message)
      return 1
    }
  }
}

const harness = createChecker()
const check = harness.check

// ── 隔离工作区 ────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-srcmodel-'))

function write (name, text) {
  const abs = path.join(dir, name) // nosemgrep（dir = mkdtempSync(os.tmpdir()) 结果 + 本文件硬编码文件名，无外部净输入）
  // Codacy 在这一行报的是 ESLint 系规则 `security/detect-non-literal-fs-filename`（只认「首参是字符串
  // 字面量」），它跟 opengrep 的 nosemgrep 是两套引擎，故各留一条注释。目标路径按设计必然是变量：
  // mkdtempSync 建出的隔离工作区 + 本文件硬编码的夹具名（cjs.js / workflow.yml 等），既没有外部净输入
  // 参与路径构造，也不写工作区之外的任何位置。
  // ⚠️ 这里**刻意**写成不带规则名的裸 `eslint-disable-next-line`：本仓 standard 17 不带
  // eslint-plugin-security，指名该规则会让 `npm run lint` 直接报 "Definition for rule … was not found"
  // 并整体判红（实测）。裸形态只作用于这一行，语义就是「这一行的静态告警已知且已核对」。
  // eslint-disable-next-line
  fs.writeFileSync(abs, text) // nosemgrep（同上：只写隔离工作区里的夹具）
  return abs
}

// ── 夹具：一份把「算 / 不算」都摆在一起的 CJS 源码 ────────────────────────
// `ghostFn` / `obj.ghostCall` 只出现在**注释与字符串**里：它们必须不算（旧实现按文本匹配时正是这里假绿）。
const CJS_FIXTURE = [
  '// 注释里的 function ghostFn () {} 与 obj.ghostCall() 都不是代码',
  "const note = 'function ghostFn () {} 和 obj.ghostCall()'",
  'function declared (a) { return a }',
  'const arrow = (x) => x + 1',
  'const exprFn = function (y) { return y }',
  'class Widget {',
  '  build (n) { return n }',
  '  static make () { return 1 }',
  '}',
  'const api = {',
  '  readText (f) { return declared(f) },',
  '  pick: () => 1',
  '}',
  'const obj = { prop: 1 }',
  'const alias = obj.prop',
  "const bracket = obj['prop']",
  'const dynamic = obj[note]',
  'function caller (src) {',
  '  helper()',
  '  a.b.c(1)',
  '  return src.split(",")',
  '}',
  'function helper () {}',
  'module.exports = { declared, arrow, api }',
  'exports.extra = 1'
].join('\n') + '\n'

const ESM_FIXTURE = [
  'export function esmFn () { return 1 }',
  'export const esmConst = 2',
  'const localName = 3',
  'export { localName as renamed }',
  'export default esmFn'
].join('\n') + '\n'

const DEFAULT_EXPORT_CJS = 'module.exports = function () { return 1 }\n'

// codeOnly 夹具：注释必须消失，**字符串里的连续空格必须原样保留**（折叠空白时若误伤字符串，
// 等于篡改被测数据——这正是 codeOnly 用 token 重建而不是正则替换的原因）。
const CODEONLY_FIXTURE = [
  '// 行注释 COMMENT_MARK',
  "const s = 'a  b'",
  '/* 块注释 BLOCK_MARK */ const t =  1'
].join('\n') + '\n'

const SHELL_FIXTURE = [
  '#!/bin/bash',
  '# 整行注释',
  'run_gate "标签 带空格" "提示（含括号）" npm run check:assert-style',
  't0=$(date +%s)',
  "echo 'a b' # 行尾注释",
  'echo x && echo y',
  'echo (z)'
].join('\n') + '\n'

const YAML_FIXTURE = [
  'name: demo',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  quality:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: 源码文本断言闸门',
  '        run: npm run check:assert-style'
].join('\n') + '\n'

const cjsFile = write('cjs.js', CJS_FIXTURE)
const esmFile = write('esm.mjs', ESM_FIXTURE)
const defaultExportFile = write('default-export.js', DEFAULT_EXPORT_CJS)
const codeOnlyFile = write('codeonly.js', CODEONLY_FIXTURE)
const shellFile = write('hook.sh', SHELL_FIXTURE)
const yamlFile = write('workflow.yml', YAML_FIXTURE)
const brokenFile = write('broken.js', 'const x = {\n  a: 1\n')

// ── 1. loadModel 的形状 ───────────────────────────────────────────────────
check('loadModel：返回 code/ast/tokens/calls/members/funcs/exports/codeOnly 八件套', () => {
  const m = model.loadModel(cjsFile)
  for (const key of ['code', 'ast', 'tokens', 'calls', 'members', 'funcs', 'exports', 'codeOnly']) {
    assert.ok(Object.prototype.hasOwnProperty.call(m, key), `model 缺字段 ${key}`)
  }
  assert.strictEqual(m.ast.type, 'Program', 'ast 必须是 acorn 的 Program 节点')
  assert.ok(Array.isArray(m.tokens) && m.tokens.length > 20, `tokens 必须非空（实得 ${m.tokens.length}）`)
  assert.strictEqual(m.code, CJS_FIXTURE, 'code 必须是文件原文（逐字）')
  assert.ok(m.calls instanceof Set && m.members instanceof Set && m.funcs instanceof Set && m.exports instanceof Set,
    '四个集合必须是 Set')
})

check('loadModel：同一文件重复调用命中共缓存（返回同一对象，不重复解析）', () => {
  const a = model.loadModel(cjsFile)
  const b = model.loadModel(cjsFile)
  assert.strictEqual(a, b, '第二次 loadModel 必须返回缓存里的同一个对象')
  assert.ok(model._cache.size >= 1, '_cache 必须记录已解析文件（否则缓存键漏改会让每次调用重新解析）')
})

// ── 2. 注释 / 字符串不算（负向断言的真实性） ──────────────────────────────
check('注释与字符串里的名字不算：ghostFn / obj.ghostCall 一律不得出现在 funcs/calls 里', () => {
  const m = model.loadModel(cjsFile)
  assert.strictEqual(m.funcs.has('ghostFn'), false, '注释/字符串里的 function ghostFn 不得算函数')
  assert.strictEqual(m.calls.has('obj.ghostCall'), false, '字符串里的 obj.ghostCall() 不得算调用')
  // 负向断言的护栏：集合规模必须有下界。model 退化（空集合）时上面的「不算」会静默变绿，
  // 这条规模断言正是让它变红的那个钉子。
  assert.ok(m.funcs.size >= 9, `funcs 规模下界：实得 ${m.funcs.size}（退化会先红在这里）`)
  assert.ok(m.calls.size >= 4, `calls 规模下界：实得 ${m.calls.size}`)
  assert.ok(m.members.size >= 4, `members 规模下界：实得 ${m.members.size}`)
})

// ── 3. funcs：函数声明 / 箭头 / 函数表达式 / 类方法 / 静态方法 / 对象方法 ──
check('funcs：函数声明 + 箭头 + 函数表达式 + 类方法 + 静态方法 + 对象方法都算', () => {
  const m = model.loadModel(cjsFile)
  const expected = ['declared', 'arrow', 'exprFn', 'build', 'make', 'readText', 'pick', 'caller', 'helper']
  const missing = expected.filter((name) => !m.funcs.has(name))
  assert.deepStrictEqual(missing, [], 'funcs 漏收：' + missing.join(', '))
  for (const name of expected) assert.strictEqual(model.hasFunction(cjsFile, name), true, `hasFunction(${name}) 必须为 true`)
  assert.strictEqual(model.hasFunction(cjsFile, 'notDefinedAnywhere'), false, 'hasFunction 对不存在的名字必须为 false')
})

// ── 4. calls / members：成员链尾名、计算成员、动态键 ──────────────────────
check('calls：裸调用记 f、成员调用记 obj.m、多级记 a.b.c，动态键 obj[k]() 不记', () => {
  const m = model.loadModel(cjsFile)
  assert.strictEqual(m.calls.has('helper'), true, '裸调用 helper() 必须记为 helper')
  assert.strictEqual(m.calls.has('a.b.c'), true, '多级成员调用必须记为 a.b.c')
  assert.strictEqual(m.calls.has('declared'), true, '对象方法体里的 declared(f) 必须记为 declared')
  assert.strictEqual(m.calls.has('obj.' + 'prop'), false, '没有 obj.prop() 这种调用，不得凭空记一条')
  assert.strictEqual(model.hasCall(cjsFile, 'helper'), true, 'hasCall 便捷函数必须一致')
  assert.strictEqual(model.hasCall(cjsFile, 'ghostCall'), false, 'hasCall 对字符串里的名字必须为 false')
})

check('members：obj.prop / obj[\'prop\'] 都归一到 obj.prop，动态键 obj[k] 不记', () => {
  const m = model.loadModel(cjsFile)
  assert.strictEqual(m.members.has('obj.prop'), true, '静态成员与字面量计算成员都必须归一为 obj.prop')
  assert.strictEqual(m.members.has('a.b'), true, 'a.b.c 的中间成员 a.b 也必须在内')
  assert.strictEqual(model.hasMember(cjsFile, 'obj.prop'), true, 'hasMember 必须一致')
  assert.strictEqual(model.hasMember(cjsFile, 'obj.note'), false, '动态键 obj[note] 不得猜成 obj.note')
})

// ── 5. exports：CJS 三种形态 + module.exports = fn ────────────────────────
check('exports（CJS）：module.exports={a,b} / exports.x / module.exports=fn 都要认出来', () => {
  const m = model.loadModel(cjsFile)
  assert.strictEqual(m.exports.has('declared'), true, 'module.exports = { declared, … } 的键必须导出')
  assert.strictEqual(m.exports.has('arrow'), true)
  assert.strictEqual(m.exports.has('api'), true)
  assert.strictEqual(m.exports.has('extra'), true, 'exports.extra = 1 必须记为 extra')
  assert.strictEqual(m.exports.has('helper'), false, 'helper 没导出，不得记进 exports')
  assert.strictEqual(model.hasExport(cjsFile, 'declared'), true, 'hasExport 必须一致')
  // module.exports = fn：整体默认导出（既有口径 '(default)'，与 ESM 的 'default' 是两个名字；
  // 后续包写断言前必须先看这里的口径，别再猜）。
  const def = model.loadModel(defaultExportFile)
  assert.strictEqual(def.exports.has('(default)'), true, 'module.exports = function 必须记为 (default)')
})

// ── 6. exports：ESM 四种形态（sourceType 回退到 module 才能解析） ─────────
check('exports（ESM）：export function / export const / export { x as y } / export default', () => {
  const m = model.loadModel(esmFile)
  assert.strictEqual(m.exports.has('esmFn'), true, 'export function 必须导出 esmFn')
  assert.strictEqual(m.exports.has('esmConst'), true, 'export const 必须导出 esmConst')
  assert.strictEqual(m.exports.has('renamed'), true, 'export { localName as renamed } 必须记导出名 renamed')
  assert.strictEqual(m.exports.has('localName'), false, '本地名不是导出名，不得混进 exports')
  assert.strictEqual(m.exports.has('default'), true, 'export default 必须记为 default')
  assert.strictEqual(model.hasExport(esmFile, 'default'), true, 'hasExport(default) 必须一致')
})

// ── 7. codeOnly：去注释、保留字符串内容、折叠空白 ─────────────────────────
check('codeOnly：注释消失、字符串原样（`a  b` 的双空格不得被折叠）、无块注释', () => {
  const m = model.loadModel(codeOnlyFile)
  assert.strictEqual(m.codeOnly.includes('COMMENT_MARK'), false, '行注释必须被去掉：' + m.codeOnly)
  assert.strictEqual(m.codeOnly.includes('BLOCK_MARK'), false, '块注释必须被去掉：' + m.codeOnly)
  assert.strictEqual(m.codeOnly.includes("'a  b'"), true, '字符串字面量必须逐字保留（双空格不得折叠）：' + m.codeOnly)
  assert.strictEqual(model.codeOnly(codeOnlyFile), m.codeOnly, 'codeOnly 便捷函数必须与 model 字段同源')
  // 空白折叠：`const t =  1`（双空格）归一成单空格，但 token 之间仍需一个空格（不得粘成 `t=1` 之外的东西）。
  assert.strictEqual(m.codeOnly.includes('const t = 1'), true, '语句内多余空白必须折叠成单空格：' + m.codeOnly)
})

// ── 8. parseShell：引号 / $(…) / 注释 / 元字符 / 未闭合 ───────────────────
check('parseShell：引号感知切词（空格在引号内不切、$(…) 整段一个词、注释与元字符）', () => {
  const lines = model.parseShell(shellFile)
  // 夹具以换行结尾 ⇒ split('\n') 多出一个空元素；parseShell 同样按行切（空行给空 tokens）。
  const expectedLines = SHELL_FIXTURE.split('\n').length
  assert.strictEqual(lines.length, expectedLines, `行数必须与文件行数一致（实得 ${lines.length} / 期望 ${expectedLines}）`)
  assert.deepStrictEqual(lines.map((l) => l.line), lines.map((_, i) => i + 1), '行号必须 1 起且连续')
  // shebang 行对 shell 来说就是注释（词首 `#`），所以切出空 tokens——接线断言不该指望它。
  assert.deepStrictEqual(lines[0].tokens, [], 'shebang 行按注释处理（词首 # 起注释），必须切出空 tokens')
  assert.deepStrictEqual(lines[1].tokens, [], '整行注释必须切出空 tokens')
  assert.deepStrictEqual(lines[2].tokens, ['run_gate', '标签 带空格', '提示（含括号）', 'npm', 'run', 'check:assert-style'],
    '引号内的空格属于同一个词，标签/提示/命令三段必须完整切出')
  assert.deepStrictEqual(lines[3].tokens, ['t0=$(date +%s)'], '$(…) 是词内结构，必须整体成一个 token（不按括号切）')
  assert.deepStrictEqual(lines[4].tokens, ['echo', 'a b'], '引号保留内容、行尾 # 起注释（注释不进 tokens）: ' + JSON.stringify(lines[4].tokens))
  assert.deepStrictEqual(lines[5].tokens, ['echo', 'x', '&&', 'echo', 'y'], '&& 必须是独立 token')
  assert.deepStrictEqual(lines[6].tokens, ['echo', '(', 'z', ')'], '裸括号是元字符 token')
  assert.throws(() => model.parseShell(write('unclosed.sh', "echo 'oops\n")), /未闭合的引号/,
    '未闭合引号必须响亮抛错（静默切词 = 断言在错误数据上判绿）')
})

// ── 9. loadYaml：解析后按字段断言（而不是比对行文本） ────────────────────
check('loadYaml：解析成对象，按 job/step 字段取值（on: 解析为字符串键，不是布尔）', () => {
  const wf = model.loadYaml(yamlFile)
  assert.strictEqual(wf.name, 'demo')
  assert.deepStrictEqual(wf.jobs.quality.steps, [{ name: '源码文本断言闸门', run: 'npm run check:assert-style' }],
    'steps 必须解析成对象数组（配置断言的唯一正确形态）')
  assert.strictEqual(wf.jobs.quality['runs-on'], 'ubuntu-latest')
  assert.ok(Object.prototype.hasOwnProperty.call(wf, 'on'), 'YAML 1.2 下 on 是普通字符串键（js-yaml 4 不做布尔转换）')
})

// ── 10. 解析失败必须抛错（绝不静默返回空集合） ───────────────────────────
check('解析失败必抛：坏语法抛 source_model: 无法解析（返回空集合会让断言全绿）', () => {
  assert.throws(() => model.loadModel(brokenFile), /source_model: 无法解析/, '坏语法必须抛错')
  assert.throws(() => model.loadModel(path.join(dir, 'does-not-exist.js')), /ENOENT/, '文件不存在必须抛错')
  assert.throws(() => model.loadModel(''), /必须是非空字符串路径/, '空路径必须抛 TypeError')
})

// ── 11. 对外 API 面（缺一个 = 后续包的断言 import 不到） ──────────────────
// 12 个公共导出面 + 2 个内部件（shellTokens / _cache，见 test_support/source_model.js 的注释）。
// 集合边界必须锁死：只断言「12 个存在」时，新增/删除一个导出不会有任何用例变红（r28-7）。
const API_FACE = ['loadModel', 'calls', 'members', 'funcs', 'exports', 'codeOnly', 'hasCall', 'hasMember', 'hasFunction', 'hasExport', 'loadYaml', 'parseShell']
const INTERNALS = ['shellTokens', '_cache']
check('对外 API：12 个公共导出面齐全、2 个内部件单列，导出集合与登记表逐项相等', () => {
  // 用 Map 而不是 `model[name]`：动态属性名访问会被 Codacy 的 Generic Object Injection Sink 判红，
  // 而这里需要的只是「按名字取导出值」——Map 的键查找没有原型链、也没有注入面，语义更窄。
  const api = new Map(Object.entries(model))
  const missing = API_FACE.filter((name) => typeof api.get(name) !== 'function')
  assert.deepStrictEqual(missing, [], '缺导出（或不是函数）：' + missing.join(', '))
  // 集合边界：新增一个导出而不登记，这条当场红（否则 API 面会随实现悄悄漂移）。
  // 两处 sort 显式带比较器（SonarCloud S2871：默认排序不表达意图）。该比较器与默认排序同为
  // UTF-16 码元序，排序结果逐元素不变；刻意不用 localeCompare —— 那是按语言规则重排，会改变比对面。
  assert.deepStrictEqual(
    [...api.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    [...API_FACE, ...INTERNALS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    '导出集合必须恰为「12 个公共面 + 2 个内部件」：新增导出要同时登记到本用例与 test_suites.js 的 desc')
})

// 汇总后再清场：即使某条检查抛错，临时工作区也一定要删掉（不在 /tmp 留垃圾）。
process.exitCode = harness.summary()
try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch (e) {
  console.error('⚠️ 临时工作区清理失败（可手工删除）：' + dir + '：' + e.message)
  process.exitCode = 1
}
