#!/usr/bin/env node
'use strict'
/*
 * 反回归闸：禁止在测试里新增「读源码文本」的断言。
 *
 * 为什么：源码文本断言会随格式化、插桩、注释调整而误红（2026-11-15 mutation 13 段集体误红即此类），
 * 注释里出现同样字面量时又永远为真。这类断言应改成三式之一：① 行为断言（跑真实逻辑看结果）
 * ② AST 结构断言（test_support/source_model.js）③ 配置断言（YAML/JSON/shell 解析后比字段）。
 *
 * 扫描面（v3.463 收窄）：**只扫测试面**——仓库根 `test_*.js`、`test/**`、`test_support/**` 的
 * .js/.cjs/.mjs。scripts/ 与生产 .js 不在扫描面：那是被测系统，把「读缓存/日志后做字符串判定」
 * 冻进基线会让任何生产改动都误红，也与「测试断言」这个口径不是一回事。
 *
 * 检测面（5 种形状，形状 = 源码文本怎么走到比对点）：
 *   ① 直接：`assert.ok(src.includes('字面量'))`——receiver 由 `readFileSync`/`codeOf`/… 得到
 *      （行内直读，或 `const src = fs.readFileSync(…)` 后再比），锚点是可冻结字面量；
 *   ② 变量实参 / 运算符：`src.includes(anchorVar)`（锚点提成常量）、`src === '…'`、
 *      `assert.strictEqual(src, '…')` 与 equal 家族——同一件事的三种写法；
 *   ③ 模板插值：`` src.includes(`a${x}b`) ``——锚点不可冻结，同样计入；
 *   ④ reader 别名：`const readSrc = () => fs.readFileSync(…)` 之后 `readSrc(f).includes('…')`，
 *      以及 `const { readFileSync: read } = require('fs')` 这类简单解构重命名；
 *   ⑤ helper 返回源码：本地函数 `function codeOf (f) { return fs.readFileSync(f, 'utf8') }`
 *      的调用点 `codeOf(f).includes('…')`（返回值被判定为源码文本即可，不看函数名）。
 *   比对 API 仍是同一族：includes/startsWith/endsWith/indexOf/lastIndexOf/search/match/matchAll、
 *   `/re/.test(src)`、`assert.match/doesNotMatch(src, …)`、`==/===/!=/!==` 与 assert 等值比较族。
 *   量纲断言（`.length` / `typeof`）不计；`JSON.parse` / `acorn.parse` / `yaml.load` 之后是结构化
 *   数据，不计（RUNBOOK 第 ② 式正是要它们）。
 *   读的是**哪个文件**不区分（生产源码 / 测试夹具 / 临时文件一律算）：静态上无法可靠区分路径，宁可多算
 *   ——本闸拦的是「读文本 + 逐字比对」这个形态本身，不是「路径是否指向生产代码」。代价是基线里混入了
 *   夹具内容断言（如 test_storage.js 的临时文件比对），故计划口径 857 与本基线 629 **不可换算**，见文末。
 *
 * 基线（schema 3）：`scripts/source-text-assert.allowlist.json` 只冻结
 *   `{ "schema": 3, "total": N, "by_file": { "test_console.js": 374, … } }`
 * ——「每个测试文件还剩多少条断言要改」。锚点/行号只是**内部定位信息**，命中时用于打印行，不进基线。
 * 判据：某文件实测条数 > 基线 → exit 1 并点名「文件 / 基线 / 实测 / 增量」；基线里没有的文件实测
 * 有条目 → exit 1（新文件按 0 算）；条数下降允许（按文件报 shortfall，供每个包对账）。
 * `total` 必须等于 `by_file` 各值之和，否则 exit 2（手改一个数字而不改另一个，是唯一能静默放宽
 * 基线的写法，必须在读入时就拒掉）。
 *
 * 已知取舍：按文件计数看不到同一文件内两条断言互换（N 条换 N 条仍绿）；锚点质量靠评审看 diff。
 * 基线只能靠 `--write-allowlist` 重生成，任何 total / 单文件增长都被拒绝写盘（除非显式 --allow-growth）。
 *
 * ⚠️ known-uncovered（本闸**不**覆盖，不得误以为已守）——已从实现中删除的数据流，逐条给反例：
 *   1. `.call/.apply/.bind` 改 receiver：`fs.readFileSync.call(null, f).includes('X')`、
 *      `readFileSync.bind(null)(f).includes('X')`——被调名不是尾名为读取函数的成员调用，记 0 条。
 *   2. 计算成员取值：`fs['readFileSync'](f).includes('X')`、`obj[key].includes('X')`——只认非计算成员。
 *   3. 跨文件 helper：`const { readSrc } = require('./test_support/helpers')` 后
 *      `readSrc(f).includes('X')`——只在**本文件**建 helper 表，跨 require 边界不传播。
 *   4. 嵌套导出对象 / 类方法：`module.exports = { util: { read: (f) => readFileSync(f) } }` 的
 *      `h.util.read(f).includes('X')`；`new Reader().text(f).includes('X')`——两者都不入账。
 *   5. 字符串化后再比：`JSON.stringify(src).includes('X')`——`JSON.stringify` 被当作产出非文本，
 *      `JSON.parse(src)` 之后的字段比对同理（后者是本批的目标形态，故意放行）。
 *   6. 解析成 token/结构后再比：`parseShell(f).tokens[0] === 'run_gate'`、
 *      `loadModel(f).code.includes('X')`——容器字段与解析产物都不算源码文本。
 *   7. split 之后按下标取值：`src.split('\n')[3] === 'x'`——下标成员表达式没有 receiver 绑定，
 *      不入账（`src.split('\n').includes('x')` 这类整体比对仍计入）。
 *   8. 基线自身被改写：手改 JSON 同时抬高 total 与 by_file 的闸门看不出（没有 git 参照版本对账），
 *      只有 `--write-allowlist` 的增长拒绝与评审 diff 能拦。
 *   9. 非 .js 测试夹具 / 运行时拼出来的文件名：扫描面按目录与扩展名枚举，运行期生成的测试文件不入账。
 *
 * 与 plan 的 857 的差额（不编数，逐项如实）：857 是 v3.442 起草时那版**文件级正则**的实测值
 * （变量名按整文件认，只认 includes/indexOf/startsWith/match），本口径是作用域感知的 AST 判定且含
 * strictEqual 族 / 比较运算符 / 正则 test / helper 与别名。两把尺子逐文件差额见 PR body：test_console
 * 783 → 374（旧口径把 fixture/lock/日志的 .includes 也算进同名变量）、test_app 24 → 24、
 * test_filter 12 → 11、test_ci_static_gates 0 → 8，另有 21 个旧口径完全没算的文件合计 85 条。
 *
 * 退出码：0 无新增 / 1 有新增（某文件超基线或新文件）/ 2 基线自相矛盾、扫描失败、或用法错误。
 *
 * 用法：
 *   node scripts/check-source-text-asserts.js                    # 门禁（exit 0/1/2）
 *   node scripts/check-source-text-asserts.js --write-allowlist  # 重生成基线（增长须显式 --allow-growth）
 */
const fs = require('node:fs')
const path = require('node:path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const ALLOW_FILE = path.join(__dirname, 'source-text-assert.allowlist.json')
const SCHEMA = 3

// 「源码文本」的产出点：读取仓内文件 / 剥注释。
const SOURCE_CALLS = new Set(['readFileSync', 'readFile', 'codeOf', 'codeOnly', 'stripComments', 'stripComment'])
// receiver 是源码文本 ⇒ 文本比对的字符串方法（matchAll 与 match 同口径）。
const STRING_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'search', 'match', 'matchAll'])
// 等值比较族：与 `===` 同口径（`assert.strictEqual(src, '…')` 是同一件事的写法）。
const EQUALITY_CALLS = new Set([
  'strictEqual', 'notStrictEqual', 'deepStrictEqual', 'notDeepStrictEqual',
  'equal', 'notEqual', 'deepEqual', 'notDeepEqual'
])
const COMPARISONS = new Set(['==', '===', '!=', '!=='])
// 量纲取值：`src.length === 3` / `typeof src === 'string'` 不是逐字比对。
const NON_TEXT_MEMBERS = new Set(['length', 'size', 'byteLength'])
const NON_TEXT_IDENTIFIERS = new Set(['undefined', 'NaN', 'Infinity'])
// 仍返回字符串/数组的链式方法：继续往上追一层 receiver（`.trim().includes('X')`）。
const CHAIN_METHODS = new Set([
  'trim', 'trimStart', 'trimEnd', 'slice', 'substring', 'substr', 'replace', 'replaceAll',
  'split', 'join', 'toLowerCase', 'toUpperCase', 'concat', 'toString'
])
// 不可冻结的锚点（变量 / 表 / 带插值模板 / 动态 RegExp）。它必须**计入**：把字面量提成常量
// 不得让整条断言从检测面上消失（否则是一条零成本绕过路径）。
const DYNAMIC = '<dynamic>'
const SHAPE_LABEL = {
  1: '①直接字面量',
  2: '②变量锚点/比较',
  3: '③模板插值',
  4: '④reader 别名',
  5: '⑤helper 返回源码'
}

const JS_FILE_RE = /\.(?:js|cjs|mjs)$/
const TEST_FILE_RE = /^test_.*\.js$/

function die (code, message) {
  console.error(message)
  process.exit(code)
}

function parseAst (code, file) {
  try {
    return acorn.parse(code, { ecmaVersion: 'latest', allowHashBang: true, locations: true })
  } catch (e) {
    // 解析失败必须响亮（exit 2）：静默返回空集合会让该文件的断言全部「消失」而闸门照绿。
    die(2, `扫描失败：无法解析 ${file}：${e.message}`)
  }
}

const isFunction = (node) => !!node && (node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')

// 被调名：`readFileSync` / `fs.readFileSync` 都归一到尾名（只认非计算成员，计算成员见 known-uncovered 2）。
function calleeTail (callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name
  return null
}

// 锚点：字符串/数字字面量、无插值模板、正则字面量 → 可冻结；其余一律 `<dynamic>`。
function anchorOf (node) {
  if (!node) return DYNAMIC
  if (node.type === 'Literal') {
    if (node.regex) return '/' + node.regex.pattern + '/' + node.regex.flags
    if (typeof node.value === 'string' || typeof node.value === 'number') return String(node.value)
    return DYNAMIC
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('')
  return DYNAMIC
}

const isTemplateWithExpr = (node) => !!node && node.type === 'TemplateLiteral' && node.expressions.length > 0

/*
 * 单文件分析：作用域感知的极简数据流。
 * scope = { parent, vars:<名字→是源码文本>, helpers:<名字→返回源码文本的函数>, readers:<名字→读取函数别名> }
 */
function analyzeFile (code, file) {
  const ast = parseAst(code, file)
  const hits = []
  const newScope = (parent) => ({ parent, vars: new Set(), helpers: new Set(), readers: new Set() })
  const inScope = (scope, kind, name) => {
    for (let s = scope; s; s = s.parent) if (s[kind].has(name)) return true
    return false
  }

  function isSource (node, scope) {
    if (!node) return false
    switch (node.type) {
      case 'Identifier':
        return inScope(scope, 'vars', node.name)
      case 'TemplateLiteral':
        return node.expressions.some((e) => isSource(e, scope))
      case 'BinaryExpression':
        return node.operator === '+' && (isSource(node.left, scope) || isSource(node.right, scope))
      case 'CallExpression': {
        const callee = node.callee
        const tail = calleeTail(callee)
        if (callee.type === 'Identifier') {
          if (inScope(scope, 'helpers', callee.name) || inScope(scope, 'readers', callee.name)) return true
        }
        if (tail && !callee.computed) {
          // `fs.readFileSync` / 解构后的 `readFileSync` 都按尾名认。
          if (SOURCE_CALLS.has(tail)) return true
          if (callee.type === 'MemberExpression' && CHAIN_METHODS.has(tail)) return isSource(callee.object, scope)
        }
        return false
      }
      default:
        return false
    }
  }

  // 「本文件定义的、返回源码文本的函数」：看函数体里有没有 `return <源码文本>`（不进入嵌套函数）。
  function returnsSource (fn, scope) {
    // 表达式体箭头（`() => fs.readFileSync(…)`）没有 ReturnStatement，直接看返回表达式。
    if (fn.body.type !== 'BlockStatement') return isSource(fn.body, scope)
    let found = false
    const scan = (node) => {
      if (found || !node || typeof node.type !== 'string') return
      if (node !== fn && isFunction(node)) return
      if (node.type === 'ReturnStatement' && isSource(node.argument, scope)) {
        found = true
        return
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue
        const value = node[key]
        if (Array.isArray(value)) value.forEach(scan)
        else if (value && typeof value.type === 'string') scan(value)
      }
    }
    scan(fn.body)
    return found
  }

  // 量纲/存在性取值：不计入（否则 `src.length === 3` 这类计数断言会把基线灌满噪声）。
  function isNonText (node) {
    if (!node) return false
    if (node.type === 'Identifier' && NON_TEXT_IDENTIFIERS.has(node.name)) return true
    if (node.type === 'UnaryExpression' && node.operator === 'typeof') return true
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' &&
      NON_TEXT_MEMBERS.has(node.property.name)) return true
    return false
  }

  // receiver 是不是别名/helper 调用：`readSrc(f).includes('X')` 的 receiver 是 CallExpression，
  // 被调名（Identifier）落在 readers / helpers 表里。
  function calleeName (node) {
    if (!node) return null
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') return node.callee.name
    if (node.type === 'Identifier') return node.name
    return null
  }

  // 形状判定：锚点形态优先（③ 模板插值 / ① 字面量 / ② 变量），再看 receiver 怎么来的（④ 别名 / ⑤ helper）。
  function shapeOf (argNode, receiver, scope) {
    if (isTemplateWithExpr(argNode)) return 3
    const name = calleeName(receiver)
    if (name && inScope(scope, 'readers', name)) return 4
    if (name && inScope(scope, 'helpers', name)) return 5
    if (anchorOf(argNode) !== DYNAMIC) return 1
    return 2
  }

  // 命中判定：receiver 绑定到源码文本 + 在做字符串比对。返回 { anchor, shape } 或 null。
  function classify (node, scope) {
    if (node.type === 'BinaryExpression' && COMPARISONS.has(node.operator)) {
      const leftSource = isSource(node.left, scope)
      const rightSource = isSource(node.right, scope)
      if (leftSource === rightSource) return null // 两侧同类：关系比较，不是排版锚点
      if (leftSource && isNonText(node.right)) return null
      const anchorNode = leftSource ? node.right : node.left
      return { anchor: anchorOf(anchorNode), shape: shapeOf(anchorNode, null, scope) }
    }
    if (node.type !== 'CallExpression') return null
    const callee = node.callee
    if (callee.type !== 'MemberExpression' || callee.computed) return null
    const name = callee.property.type === 'Identifier' ? callee.property.name : null
    // ① / ④ / ⑤：receiver 上直接做字符串比对。
    if (STRING_METHODS.has(name) && isSource(callee.object, scope)) {
      const arg = node.arguments[0]
      return { anchor: anchorOf(arg), shape: shapeOf(arg, callee.object, scope) }
    }
    // 正则 test：`/re/.test(src)`（receiver 是正则、实参才是源码文本）。
    if (name === 'test' && callee.object.type === 'Literal' && callee.object.regex &&
      node.arguments.some((a) => isSource(a, scope))) {
      return { anchor: anchorOf(callee.object), shape: 1 }
    }
    // assert.match / assert.doesNotMatch：与 includes 同口径。
    if ((name === 'match' || name === 'doesNotMatch') && node.arguments[0] && isSource(node.arguments[0], scope)) {
      const arg = node.arguments[1]
      return { anchor: anchorOf(arg), shape: shapeOf(arg, null, scope) }
    }
    // ②：assert 等值比较族的「源码文本 vs 字面量」。
    if (EQUALITY_CALLS.has(name) && node.arguments.length >= 2) {
      const a = isSource(node.arguments[0], scope)
      const b = isSource(node.arguments[1], scope)
      if (a === b) return null
      if (a && isNonText(node.arguments[1])) return null
      const anchorNode = a ? node.arguments[1] : node.arguments[0]
      return { anchor: anchorOf(anchorNode), shape: shapeOf(anchorNode, null, scope) }
    }
    return null
  }

  function visitFunction (fn, scope) {
    const inner = newScope(scope)
    if (fn.id && fn.type === 'FunctionDeclaration' && returnsSource(fn, scope)) scope.helpers.add(fn.id.name)
    if (fn.body.type === 'BlockStatement') fn.body.body.forEach((stmt) => visit(stmt, inner))
    else visit(fn.body, inner)
  }

  function visit (node, scope) {
    if (!node || typeof node.type !== 'string') return
    if (isFunction(node)) {
      visitFunction(node, scope)
      return
    }
    const hit = classify(node, scope)
    if (hit) hits.push({ file, line: node.loc.start.line, anchor: hit.anchor, shape: hit.shape })

    if (node.type === 'VariableDeclarator') {
      const { id, init } = node
      if (!init) {
        visit(id, scope)
        return
      }
      if (isFunction(init)) {
        // ④/⑤：按返回值判定，不看名字。表达式体箭头（`() => fs.readFileSync(…)`）是 reader 别名，
        // 块体函数（`function f () { return fs.readFileSync(…) }`）是 helper。
        if (id.type === 'Identifier' && returnsSource(init, scope)) {
          (init.body.type === 'BlockStatement' ? scope.helpers : scope.readers).add(id.name)
        }
        visitFunction(init, scope)
        return
      }
      visit(init, scope)
      if (id.type === 'Identifier') {
        if (isSource(init, scope)) scope.vars.add(id.name)
        else if (init.type === 'Identifier' && SOURCE_CALLS.has(init.name)) scope.readers.add(id.name)
      } else if (id.type === 'ObjectPattern') {
        // `const { readFileSync: read } = require('fs')`：简单解构重命名 → reader 别名。
        for (const prop of id.properties) {
          const from = prop.key && (prop.key.name || prop.key.value)
          const to = prop.value && prop.value.type === 'Identifier' ? prop.value.name : from
          if (SOURCE_CALLS.has(from) && to) scope.readers.add(to)
        }
        visit(id, scope)
      } else {
        visit(id, scope)
      }
      return
    }
    if (node.type === 'AssignmentExpression') {
      visit(node.right, scope)
      visit(node.left, scope)
      if (node.left.type === 'Identifier' && isSource(node.right, scope)) scope.vars.add(node.left.name)
      return
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) value.forEach((child) => visit(child, scope))
      else if (value && typeof value.type === 'string') visit(value, scope)
    }
  }

  const root = newScope(null)
  ast.body.forEach((stmt) => visit(stmt, root))
  return hits
}

/* ── 扫描面：只扫测试面 ──────────────────────────────────────────────────── */
const SCAN_SKIP = new Set(['node_modules', '.git', '.stryker-tmp', '.nyc_output', 'coverage', 'reports'])
const SCAN_DIRS = ['test', 'test_support']

function listTestFiles () {
  const files = []
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) { // nosemgrep（ROOT = __dirname 常量 + 仓根枚举，无外部输入）
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) files.push(entry.name)
  }
  const walkDir = (rel) => {
    const abs = path.join(ROOT, rel)
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) { // nosemgrep（abs = ROOT（__dirname 常量）+ 仓内常量目录）
      const child = rel + '/' + entry.name
      if (entry.isDirectory()) {
        if (!SCAN_SKIP.has(entry.name)) walkDir(child)
        continue
      }
      if (entry.isFile() && JS_FILE_RE.test(entry.name)) files.push(child)
    }
  }
  for (const dir of SCAN_DIRS) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue // nosemgrep（ROOT 常量 + 硬编码目录名）
    walkDir(dir)
  }
  if (!files.length) die(2, '扫描失败：测试面为 0 个文件（ROOT 不对？）——这不能读作「没有源码文本断言」')
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function scanAll () {
  const hits = []
  for (const rel of listTestFiles()) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8') // nosemgrep（rel 来自本文件枚举出的测试面）
    hits.push(...analyzeFile(code, rel))
  }
  return hits
}

/* ── 基线 ────────────────────────────────────────────────────────────────── */
const isCount = (value) => Number.isInteger(value) && value >= 0

function readBaseline () {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) // nosemgrep（ALLOW_FILE = __dirname 常量）
  } catch (e) {
    die(2, `基线读不了 ${path.relative(ROOT, ALLOW_FILE)}：${e.message}`)
  }
  if (!raw || raw.schema !== SCHEMA) die(2, `基线 schema 必须是 ${SCHEMA}（实得 ${JSON.stringify(raw && raw.schema)}）——旧形状请用 --write-allowlist 重生成`)
  if (!isCount(raw.total) || !raw.by_file || typeof raw.by_file !== 'object') die(2, '基线必须有整数的 total 与对象的 by_file')
  let sum = 0
  for (const [file, count] of Object.entries(raw.by_file)) {
    if (!isCount(count)) die(2, `基线 by_file["${file}"] 不是非负整数：${JSON.stringify(count)}`)
    sum += count
  }
  if (sum !== raw.total) die(2, `基线自相矛盾：total=${raw.total}，by_file 各值之和=${sum}——两者必须相等（只改一个数字等于放宽基线）`)
  return raw
}

const perFile = (hits) => {
  const map = new Map()
  for (const hit of hits) map.set(hit.file, (map.get(hit.file) || 0) + 1)
  return map
}

const sortedByFile = (map) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

function printByFile (title, map) {
  if (!map.size) return
  console.log(title)
  for (const [file, count] of sortedByFile(map)) console.log(`  ${file}\t${count}`)
}

function compare (hits, baseline) {
  const measured = perFile(hits)
  const violations = []
  for (const [file, count] of sortedByFile(measured)) {
    const allowed = isCount(baseline.by_file[file]) ? baseline.by_file[file] : 0
    if (count > allowed) violations.push({ file, allowed, count, delta: count - allowed })
  }
  const shortfalls = []
  for (const [file, allowed] of sortedByFile(new Map(Object.entries(baseline.by_file)))) {
    const count = measured.get(file) || 0
    if (count < allowed) shortfalls.push({ file, allowed, count, delta: allowed - count })
  }
  return { measured, violations, shortfalls }
}

function renderBaseline (hits) {
  const byFile = {}
  for (const [file, count] of sortedByFile(perFile(hits))) byFile[file] = count
  return {
    note: '紧凑基线（schema 3）：只冻结「测试文件 → 源码文本断言条数」。口径见 scripts/check-source-text-asserts.js 文件头；新增即 exit 1，只减不增。锚点与行号是内部定位信息，不进基线。',
    schema: SCHEMA,
    total: hits.length,
    by_file: byFile
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
function main () {
  const argv = process.argv.slice(2)
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--write-allowlist' && a !== '--allow-growth')
  if (unknown.length) die(2, `未知参数：${unknown.join(', ')}（只支持 --write-allowlist / --allow-growth）`)
  const hits = scanAll()

  if (argv.includes('--write-allowlist')) {
    const next = renderBaseline(hits)
    const allowGrowth = argv.includes('--allow-growth')
    if (fs.existsSync(ALLOW_FILE)) {
      const previous = readBaseline()
      const grown = []
      if (next.total > previous.total) grown.push(`total ${previous.total} → ${next.total}`)
      for (const [file, count] of Object.entries(next.by_file)) {
        const before = previous.by_file[file] || 0
        if (count > before) grown.push(`${file} ${before} → ${count}`)
      }
      if (grown.length && !allowGrowth) {
        die(1, '❌ 拒绝写盘：基线增长（新增源码文本断言或检测面变宽）\n  ' + grown.join('\n  ') +
          '\n  确实要抬高基线请显式加 --allow-growth，并在 CHANGELOG 里逐文件归因。')
      }
    }
    fs.writeFileSync(ALLOW_FILE, JSON.stringify(next, null, 2) + '\n') // nosemgrep（ALLOW_FILE = __dirname 常量）
    console.log(`已写入基线：total=${next.total}（${Object.keys(next.by_file).length} 个文件）`)
    printByFile('按文件：', perFile(hits))
    return
  }

  const baseline = readBaseline()
  const { measured, violations, shortfalls } = compare(hits, baseline)
  console.log(`源码文本断言：基线 total=${baseline.total}（${Object.keys(baseline.by_file).length} 个文件）` +
    `，实测 total=${hits.length}（扫描 ${listTestFiles().length} 个测试面文件）`)
  if (violations.length) {
    console.error(`❌ 新增 ${violations.reduce((n, v) => n + v.delta, 0)} 条源码文本断言（禁止）：`)
    for (const v of violations) console.error(`  ${v.file}  基线 ${v.allowed} / 实测 ${v.count} / +${v.delta}`)
    // 命中行只作内部定位信息（不进基线）：每个超基线文件最多列 20 条，避免大文件刷屏。
    const offending = new Set(violations.map((v) => v.file))
    const shown = new Map()
    for (const hit of hits) {
      if (!offending.has(hit.file)) continue
      const count = shown.get(hit.file) || 0
      if (count >= 20) continue
      shown.set(hit.file, count + 1)
      console.error(`    ${hit.file}:${hit.line}  ${JSON.stringify(hit.anchor).slice(0, 80)}（${SHAPE_LABEL[hit.shape]}）`)
    }
    console.error('改成 AST 结构断言（test_support/source_model.js）/ 配置解析断言 / 行为断言；不要调高基线。')
    process.exit(1)
  }
  if (shortfalls.length) printByFile('ℹ️ 基线下降（本批已处理，逐文件 shortfall）：', new Map(shortfalls.map((s) => [s.file, s.delta])))
  if (measured.size === 0) console.log('（测试面里没有命中任何源码文本断言）')
  console.log('✅ 未新增源码文本断言（逐文件计数均未超基线）')
}

module.exports = { analyzeFile, compare, renderBaseline, listTestFiles, SHAPE_LABEL, DYNAMIC }

if (require.main === module) main()
