#!/usr/bin/env node
'use strict'
/*
 * 反回归闸：禁止在测试里新增「读源码文本」的断言。
 *
 * 为什么：源码文本断言会随格式化、插桩、注释调整而误红（2026-11-15 mutation 13 段集体误红即此类），
 * 且注释里出现同样字面量时又永远为真。这类断言应改成三种形态之一：
 *   ① 行为断言（跑真实逻辑看结果）  ② AST 断言（test_support/source_model.js）  ③ 配置断言（YAML/JSON/shlex 解析后比字段）
 *
 * 检测面（v3.444 重写：acorn AST + 作用域感知的数据流，不再用正则找变量名）：
 *   - 源：`readFileSync` / `readFile` / `codeOf` / `codeOnly` / `stripComments` 的返回值，
 *         以及**任何返回源码文本的本地函数**（按函数摘要判定：返回表达式被污染即算，天然含
 *         `readConsoleSource()` 这类拼接 helper、`codeOf(var)` 套壳、`buf.toString()` 这一类多跳）。
 *   - 传播：赋值/重赋值、变量声明、函数实参→形参、`split()` 后的行数组、`.map/.filter/.find/…`
 *         回调形参、`for…of` 循环变量、解构、模板字符串、`+` 拼接、成员取值。
 *   - 命中（只认 receiver **确实绑定到源码文本**的调用）：
 *         `<src>.includes|startsWith|endsWith|indexOf|lastIndexOf|search|match(<任意实参>)`、
 *         `<任意正则>.test(<src>)`、`assert.match(<src>, <任意实参>)`。
 *     运算符 / 断言函数形态（r12-1：旧检测面只认调用表达式，这一整族永远数不到）：
 *         `<src行> === | == | !== | != <字面量>`（`lines[10] === '…'`）、
 *         `assert.strictEqual|notStrictEqual|deepStrictEqual|notDeepStrictEqual|equal|notEqual|deepEqual|notDeepEqual(<src>, <字面量>)`
 *         （含 `.trim()` / `.slice()` 之后比对；字面量侧可以是字符串/无插值模板或**字面量数组**）。
 *         判据与上面同源：只有一侧**确实绑定到源码文本**、另一侧是可冻结字面量（数组取首个字符串，
 *         取不到记 `<dynamic>`）才记一条；`src.length === 3` / `typeof src === 'string'` 是量纲断言，
 *         **不**计入（否则行数断言会把基线灌满噪声）。
 *     方括号字面量键、`.bind` 后的别名、`String.prototype.includes.call/apply(<src>, …)`、
 *     `[].includes.call(<src>, …)` 与点号写法**同一口径**（r8-1：只差一个字符的写法不能成为绕过路径）。
 *     锚点 = 字符串字面量 / 无插值模板字符串 / 正则字面量（记为 `/src/flags`）；
 *     **锚点不是可冻结字面量**（变量、字面量表、带插值模板、helper 形参、动态 `RegExp`）时记
 *     `<dynamic>` 哨兵——它同样计入基线。这一点是本闸的命门：判据只看「receiver 是否绑定到源码文本 +
 *     是否在做字符串比对」，**不看实参形态**。否则「把字面量提成常量」就是一条零成本绕过路径
 *     （4 轮评审实测：旧判据下 6 种写法全 exit 0，且仓库现有 109 处真实比对完全在基线外）。
 *   - 被调名做**绑定解析**，不只按名字认：`const read = fs.readFileSync; read(f).includes('X')` 里
 *     `read` 的初值是成员链尾名 `readFileSync` ⇒ 它读的是源码文本。同理对象方法
 *     （`const H = { read: f => readFileSync(f) }; H.read(f).includes('X')`）与类方法
 *     （`new R().read(f).includes('X')`）按「返回值污染 + obj.m()/new C().m()」计入。
 *   - **不看名字看绑定**：`res.text.includes(…)` 的 receiver 是成员表达式（`res` 不是源码文本），
 *     不算命中；同名局部变量只在它自己的作用域里算（`const text = readFileSync(…)` 不会污染
 *     整个文件里的 `text`）。这是旧实现（文件级变量名集合 + 正则）44 条误判的根因。
 *   - 扫描面：**整棵仓库**的 `.js/.cjs/.mjs`（r12-4：旧实现是「根 test_*.js + test_support/** + test/**」
 *     的封闭白名单，把「读源码 + 比对」整段搬进 helpers/ 就整段豁免）。豁免只有一个**显式**名单
 *     `REPO_SKIP`（依赖/产物/vendor/被测系统本身），新目录默认被扫描——没有第二份隐式白名单。
 *     跨文件：被 require 的本地模块按「导出函数的形参 → 字符串比对」摘要，在**调用点**按实参入账；
 *     `module.exports = fn`（默认导出）与「自身读源码文本的 helper」（`readSrc(f).includes('X')`）同口径
 *     （r12-2 / r12-3）。
 *
 * 白名单（v3.448 起是**紧凑基线** schema 2）：`scripts/source-text-assert.allowlist.json` 只冻结
 * 「文件 → 条数」，逐条清单（file/line/literal/kind）**不随仓库走**——用 `--inventory` 写到仓库外
 * （默认 `~/ledgers/pipelines/assertshape-20261115/inventory.json`，可用 `--inventory <path>` /
 * `--inventory=<path>` / 环境变量 `SOURCE_TEXT_ASSERT_INVENTORY` 覆盖；写仓库目录内一律 exit 2 拒绝）。
 *
 * 判定（只看条数，不看字面量）：某文件实测条数 > 基线 → exit 1，点名 文件 / 基线 / 实测 / 增量；
 * 基线里没有的文件实测有条目 → exit 1（新文件，按基线 0 算）；条数下降允许，按文件报 shortfall。
 * 输出里把 literal（静态可冻结锚点：字符串字面量 / 无插值模板 / 正则字面量）与 dynamic（`<dynamic>`）
 * 两个口径分开报，但它们**不参与放行判定**——锚点从字面量提成常量不是「新增断言」。
 *
 * 退出码：0 无新增 / 1 有新增（某文件超基线 / 新文件）/ 2 基线自相矛盾（total ≠ by_file 之和、
 * literal+dynamic ≠ all、条目形状非法）、扫描失败、或 --inventory 目标落在仓库内。
 *
 * 已知取舍（compact 化的代价，必须知道）：按文件计数**看不到同一文件内 literal 之间的互换**——
 * 把一处锚点从 `'A'` 改成 `'B'`（条数不变）不会红，只有 `--inventory` 快照的 diff 才看得到。
 * 计数拦的是**增量**，锚点质量靠评审看 diff。
 *
 * 用法：
 *   node scripts/check-source-text-asserts.js                   # 门禁：对紧凑基线（exit 0/1/2）
 *   node scripts/check-source-text-asserts.js --inventory [p]   # 逐条清单出仓（默认见上，拒绝仓库内）
 *   node scripts/check-source-text-asserts.js --write-allowlist # 重生成紧凑基线（改基线才用；逐字节稳定）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const ALLOW_FILE = path.join(__dirname, 'source-text-assert.allowlist.json')
const ALLOW_REL = path.relative(ROOT, ALLOW_FILE)

// 按「最后一个成员名」认的源码读取函数。`fs.readFileSync` / `readFileSync` / 解构后的
// `const { readFileSync } = require('fs')` 都归一到 readFileSync。
const SOURCE_CALLS = new Set(['readFileSync', 'readFile', 'codeOf', 'codeOnly', 'stripComments', 'stripComment'])
// receiver 是源码文本、参数是字面量 ⇒ 文本比对的字符串方法。
const STRING_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'search', 'match'])
// 比较运算符：`lines[10] === '…'` 与 `src.includes('…')` 是同一件事（源码文本 vs 字面量的逐字耦合），
// 只是没有方法调用可抓——旧检测面只认调用表达式，这一整族（含 .trim()/.slice() 之后比对）永远数不到。
const COMPARISON_OPERATORS = new Set(['==', '===', '!=', '!=='])
// 断言库的等值比较：与 `===` 同口径。
const EQUALITY_CALLS = new Set([
  'strictEqual', 'notStrictEqual', 'deepStrictEqual', 'notDeepStrictEqual',
  'equal', 'notEqual', 'deepEqual', 'notDeepEqual'
])
// 「量纲」取值：`src.length === 3` 是行数断言，不是逐字比对。不排除它会把全仓的行数断言灌进基线。
const NON_TEXT_MEMBERS = new Set(['length', 'size', 'byteLength'])
// 这些方法在源码文本数组上的回调形参是「一行源码」——回调第一形参跟着 receiver 一起污染。
const ELEMENT_CALLBACK_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findIndex', 'some', 'every', 'sort', 'reduce'])
// 返回值不再是「源码文本」的调用：JSON/YAML 解析成对象、path 拼路径、fs 列目录/取元数据。
// 不在这里截断，配置类断言（`JSON.parse(readFileSync(...))` 之后比字段）会被当成文本断言计进基线。
const SANITIZER_PATHS = new Set([
  'JSON.parse', 'JSON.stringify',
  // 解析成结构化对象后就不是「源码文本」了：`acorn.parse(src)` 的结果是 AST（`node.type === 'Literal'`
  // 这类结构判断必须放行，否则整个解析器/闸门自身会被算成上百条文本断言——实测 112 条全在
  // check-source-text-asserts.js 自己的 AST 判断上）。
  'acorn.parse', 'acorn.parseExpressionAt',
  // 配置解析（RUNBOOK 四式的第 ② 式：解析后断言字段，不比对源码行）：YAML 解析结果同样是结构化数据。
  'yaml.load', 'yaml.loadAll', 'yaml.parse', 'YAML.parse', 'jsyaml.load',
  'path.join', 'path.resolve', 'path.relative', 'path.dirname', 'path.basename', 'path.extname',
  'path.normalize', 'path.isAbsolute', 'path.parse', 'path.sep',
  'fs.readdirSync', 'fs.realpathSync', 'fs.statSync', 'fs.lstatSync', 'fs.existsSync',
  'Number', 'Boolean', 'parseInt', 'parseFloat', 'Object.keys', 'Object.values', 'Object.entries'
])
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'regex', 'raw'])
// 不可冻结的锚点（实参是变量/表/带插值模板/helper 形参/动态 RegExp）。它必须**计入**基线：
// 「把字面量提成常量」曾让整条断言从检测面上消失（评审实测 6 种写法全 exit 0）。
const DYNAMIC_ANCHOR = '<dynamic>'

function parseAst (code, file) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, locations: true }
  const why = []
  for (const sourceType of ['script', 'module']) {
    try {
      return acorn.parse(code, { ...opts, sourceType })
    } catch (e) {
      why.push(`${sourceType}: ${e.message}`)
    }
  }
  // 解析失败必须响亮（exit 2），绝不返回空结果——空结果会让「没有新增源码文本断言」和
  // 「文件根本没被读到」长得一模一样。
  throw new Error(`无法解析 ${file}（${why.join('；')}）`)
}

// 成员的属性名：`a.b` 与 `a['b']` / `a[`b`]` 都算 b（**字面量键**）；`a[k]` 这类动态键返回 null（不猜）。
// 为什么必须认字面量键：`src['includes']('X')` 只多一个方括号，与 `src.includes('X')` 语义完全相同——
// 早先的 `!callee.computed` 判定把它整条漏掉，等于给「改一个字符」发通行证（r8-1）。
function propertyName (node) {
  if (!node || node.type !== 'MemberExpression') return null
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null
  const key = node.property
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0 && key.quasis.length === 1) {
    const cooked = key.quasis[0].value.cooked
    return typeof cooked === 'string' ? cooked : null
  }
  return null
}

// 成员链：`fs.readFileSync` → 'fs.readFileSync'；`a['b']` 与 `a.b` 同口径；动态键返回 null（不猜）。
function memberPath (node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type !== 'MemberExpression') return null
  const name = propertyName(node)
  if (!name) return null
  const object = memberPath(node.object)
  if (!object) return null
  return object + '.' + name
}

// 被调名的**尾段**：`readFileSync` / `fs.readFileSync` / `fs['readFileSync']` /
// `require('fs').readFileSync` 都归一成 readFileSync。第三种形态的 object 是 CallExpression
// （memberPath 走不通），但语义上它仍是「在某个 fs 对象上调 readFileSync」——按名字认即可
// （旧实现同样按名字认）；方括号字面量键同口径（r8-1，否则 `fs['readFileSync']` 又是一条零成本绕过）。
function calleeTailName (callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') return propertyName(callee)
  return null
}

// 「这个名字指向源码读取函数」——用于**绑定解析**（`const read = fs.readFileSync`）。
// 与 calleeTailName 的区别：这里输入的是右值表达式（别名声明的初值），不是调用点的 callee。
const isSourceReaderRef = (node) => {
  if (!node) return false
  if (node.type === 'Identifier') return SOURCE_CALLS.has(node.name)
  return node.type === 'MemberExpression' && SOURCE_CALLS.has(calleeTailName(node))
}

// 对象字面量 / 类体的键名（`read`、'read'、[0] 里的字面量键）。
function keyName (node) {
  if (!node) return null
  if (!node.computed && node.key && node.key.type === 'Identifier') return node.key.name
  const key = node.key
  if (key && key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value)
  }
  return null
}

// 对象字面量的方法表：`{ read: f => … }` / `{ read (f) { … } }`（简写方法）。
// 与类体方法表同一个用途：`H.read(f).includes('X')` 的返回值污染靠它追。
function attachObjectMethods (objectExpr, binding) {
  if (!binding.methods) binding.methods = new Map()
  for (const prop of objectExpr.properties) {
    if (!prop || prop.type !== 'Property' || !isFunctionNode(prop.value)) continue
    const name = keyName(prop)
    if (name) binding.methods.set(name, prop.value)
  }
}

// 会往容器里塞内容的原地方法：塞进去的是源码文本 ⇒ 容器整体按污染处理。
const MUTATOR_METHODS = new Set(['push', 'unshift', 'fill', 'add'])

// 返回布尔值的表达式（`x.includes(lit)` / `re.test(src)` / 比较 / `!`）：这类函数的返回值是**判定结果**，
// 不是源码文本。区分它才能不把 `src.split('\n').find(l => l.includes('X'))` 的回调当成「读取 helper」
// 而把真正的断言跳过（回调返回布尔 ⇒ 是断言点）。
function isBooleanExpr (node) {
  if (!node) return false
  // `return false` / `return true` 是判定结果，不是源码文本——漏了这一条会把所有带
  // `return false` 兜底的 helper 判成「返回源码文本的管道」，从而把它的锚点全部跳过。
  if (node.type === 'Literal' && typeof node.value === 'boolean') return true
  if (node.type === 'UnaryExpression' && node.operator === '!') return true
  if (node.type === 'BinaryExpression' && ['==', '===', '!=', '!==', '<', '>', '<=', '>='].includes(node.operator)) return true
  if (node.type === 'LogicalExpression') return isBooleanExpr(node.left) && isBooleanExpr(node.right)
  if (node.type === 'CallExpression') {
    const tail = calleeTailName(node.callee)
    if (tail && (STRING_METHODS.has(tail) || tail === 'test')) return true
  }
  return false
}

const isFunctionNode = (node) => !!node && (node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')

// 字面量取值：字符串字面量 / 无插值模板字符串 / 正则字面量（记为 `/src/flags`）。
// 返回 undefined 表示「不是可冻结的字面量」（变量、带插值的模板、`new RegExp(变量)`），
// 这种命中无法与基线逐字比对，不计数（宁可漏记也不让基线随运行期取值漂移）。
function literalValue (node) {
  if (!node) return undefined
  if (node.type === 'Literal') {
    if (node.regex) return '/' + node.regex.pattern + '/' + node.regex.flags
    if (typeof node.value === 'string') return node.value
    return undefined
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    const q = node.quasis[0].value
    return typeof q.cooked === 'string' ? q.cooked : q.raw
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'RegExp' &&
    node.arguments.length === 1) {
    const pattern = literalValue(node.arguments[0])
    return typeof pattern === 'string' ? '/' + pattern + '/' : undefined
  }
  return undefined
}

// `src.includes('A' + x)` / `src.includes('A' + 'B')`：锚点是字符串**前缀**。
// 旧闸门（正则版）同样只取最左字面量，这里保持同一口径——否则这类拼接断言会整批变成「零命中」，
// 看起来是误报消除，实际是把真断言从检测面上删掉（`'onReady=$' + '{onSysReady}'` 这类有 30+ 处）。
function literalAnchor (node) {
  const direct = literalValue(node)
  if (direct !== undefined) return direct
  if (!node || node.type !== 'BinaryExpression' || node.operator !== '+') return undefined
  const parts = []
  const flatten = (n) => {
    if (n && n.type === 'BinaryExpression' && n.operator === '+') {
      flatten(n.left)
      flatten(n.right)
      return
    }
    parts.push(n)
  }
  flatten(node)
  if (!parts.length) return undefined
  return literalValue(parts[0])
}

const isRegexLiteral = (node) => !!node && node.type === 'Literal' && !!node.regex

// 比较/等值断言的「字面量侧」锚点（r12-1）。返回 undefined = 这一侧不是可冻结的字面量（不是命中形态）。
//   · 字符串字面量 / 无插值模板 / 正则字面量 → 锚点原文；
//   · `+` 拼接 → 最左字面量（与 includes 同口径）；
//   · 字面量数组（`assert.deepStrictEqual(lines.slice(0, 2), ['A', 'B'])`）→ 首个字符串元素，
//     取不到记 <dynamic>（数组本身仍是字面量侧，不许因为「锚点不好取」整条消失）。
function literalSideAnchor (node) {
  const direct = literalAnchor(node)
  if (direct !== undefined) return direct
  // 带插值的模板字符串（`` `| ${label} | 5 | …` ``）：仍是「字面量侧」——它把字面量片段钉在源码文本上，
  // 只是锚点不能整条冻结 ⇒ 记 <dynamic>（与 `src.includes(`…${x}`)` 同口径，不许因为「取不到锚点」整条消失）。
  if (node && node.type === 'TemplateLiteral') return DYNAMIC_ANCHOR
  if (!node || node.type !== 'ArrayExpression') return undefined
  for (const element of node.elements) {
    const value = literalValue(element)
    if (typeof value === 'string') return value
  }
  return DYNAMIC_ANCHOR
}

// 参与比较的那一侧**表达的是文本**吗？`src.length === 3`（行数）与 `typeof src === 'string'`（类型）
// 都是量纲断言：它们对「源码写了什么」零约束，计进来只会让基线变成噪声。
function isTextualOperand (node) {
  if (!node) return false
  if (node.type === 'MemberExpression' && NON_TEXT_MEMBERS.has(propertyName(node))) return false
  if (node.type === 'UnaryExpression' && node.operator === 'typeof') return false
  return true
}

// 名字作用域：`functionScope` 供 `var` 提升；`declare` 幂等（重复声明取同一个 binding）。
// `registry` 是全局绑定表（不动点在这一份上迭代），新建绑定必须同时进 registry——否则该绑定
// 永远不会被求值，成为静默的漏检。
class Scope {
  constructor (parent, isFunction, registry) {
    this.parent = parent
    this.isFunction = !!isFunction
    this.registry = registry
    this.bindings = new Map()
  }

  functionScope () {
    let scope = this
    while (!scope.isFunction && scope.parent) scope = scope.parent
    return scope
  }

  declare (name) {
    let binding = this.bindings.get(name)
    if (!binding) {
      // methods：对象字面量/类体的方法表（`H.read` / `new R().read` 的绑定解析指向这里）；
      // instanceOf：`const r = new R()` 的类绑定，方法表按原型链回溯；
      // sourceCall：`const read = fs.readFileSync` 这类别名（初值是读取函数）；
      // fromSource：污染**来自读文件**（而不是从形参传入）。r12-3 的跨文件判定用它：
      //   `readSrc(f) { return fs.readFileSync(f) }` 的返回值是源码文本，`wrap(s) { return s.trim() }`
      //   的返回值只是「传进来的文本」——后者不能当成「这个 helper 自己会读源码」。形参本身**永不**
      //   带 fromSource（isParam）：否则某个调用点传了源码文本，就会让整个函数被当成「自己读文件的 helper」
      //   （实测：mutation-report.js 里 escCell/formatReuseCell 这类纯格式化函数因此全被误判）。
      binding = { name, tainted: false, fromSource: false, isParam: false, defs: [], fn: null, methods: null, instanceOf: null, sourceCall: false }
      this.bindings.set(name, binding)
      this.registry.push(binding)
    }
    return binding
  }

  lookup (name) {
    for (let scope = this; scope; scope = scope.parent) {
      const binding = scope.bindings.get(name)
      if (binding) return binding
    }
    return null
  }
}

function declarePattern (node, scope, kind, into) {
  if (!node) return into
  switch (node.type) {
    case 'Identifier': {
      // `var` 提升到最近的函数作用域，`let/const/class/参数` 留在当前块。
      into.push((kind === 'var' ? scope.functionScope() : scope).declare(node.name))
      return into
    }
    case 'ObjectPattern':
      for (const prop of node.properties) declarePattern(prop.value || prop.argument, scope, kind, into)
      return into
    case 'ArrayPattern':
      for (const element of node.elements) declarePattern(element, scope, kind, into)
      return into
    case 'AssignmentPattern':
      declarePattern(node.left, scope, kind, into)
      return into
    case 'RestElement':
      declarePattern(node.argument, scope, kind, into)
      return into
    default:
      return into
  }
}

// 函数/程序体里的 `var` 与函数声明提升到函数作用域（跳过嵌套函数体）：`var` 可能在大括号
// 深处声明、在前面的语句里被引用，只按块顺序登记会漏掉那些引用。
function hoistVars (node, scope) {
  const visit = (child) => {
    if (!child || typeof child !== 'object') return
    if (Array.isArray(child)) {
      child.forEach(visit)
      return
    }
    if (typeof child.type !== 'string') return
    if (child.type === 'VariableDeclaration') {
      if (child.kind === 'var') child.declarations.forEach((decl) => declarePattern(decl.id, scope, 'var', []))
      return
    }
    if (child.type === 'FunctionDeclaration') {
      if (child.id) scope.declare(child.id.name)
      return
    }
    if (child.type === 'FunctionExpression' || child.type === 'ArrowFunctionExpression') return
    for (const key of Object.keys(child)) {
      if (SKIP_KEYS.has(key)) continue
      visit(child[key])
    }
  }
  visit(node)
}

// 块作用域的 let/const/class/函数声明（含 switch 的 case 体）。
function hoistLexical (statements, scope) {
  for (const statement of statements) {
    if (!statement) continue
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      statement.declarations.forEach((decl) => declarePattern(decl.id, scope, statement.kind, []))
    } else if (statement.type === 'FunctionDeclaration' && statement.id) {
      scope.declare(statement.id.name)
    } else if (statement.type === 'ClassDeclaration' && statement.id) {
      scope.declare(statement.id.name)
    }
  }
}

/*
 * 分析一份源码，返回 `{ hits, exports }`（`analyzeSource()` 是只取 hits 的包装）。
 *
 * 三轮：
 *   A. 遍历建作用域/绑定，把所有「表达式 → 绑定」的传播边记成原始 AST 节点（此时还不算污染，
 *      因为顺序在前面的引用可能指向后面才声明的绑定）；
 *   B. 用 idBinding（每个 Identifier → 它的 binding）把边解析成 {hasSource, deps}；
 *   C. 单调不动点：绑定只会 false → true，所以必然收敛；收敛后逐条判定候选命中的 receiver。
 *
 * `options.moduleSummary`（r8-2 的跨文件 helper）：把**所有形参按已污染处理**，并把每条命中的
 * 「receiver 来自第几个形参 / 锚点来自第几个形参」记下来，连同 `module.exports` 的函数表一起返回。
 * 调用方（ModuleIndex）拿它当 helper 摘要，在**调用点**用实参重建候选——污染因此跨 require 边界传播。
 * `options.modules`：本地模块摘要表（懒加载，见 createModuleIndex）。
 */
function analyzeModule (code, file, options = {}) {
  const ast = parseAst(code, file)
  const idBinding = new Map() // Identifier 节点 → binding
  const bindings = []
  const edges = [] // { target: Binding, expr: Node } —— target 污染当且仅当 expr 被污染
  const candidates = [] // { line, literal, receiverKind, node, fn }
  const rets = new Map() // function 节点 → 返回值伪绑定
  const paramBindings = new Map() // function 节点 → [{ binding }]
  const fnParent = new Map() // 函数节点 → 外层函数节点（嵌套回调里的命中要归到导出的那个函数上）
  const imports = new Map() // 本地名 → { moduleFile, exportName }（只收本地 .js 模块）
  const exportSites = [] // { name, value } —— `module.exports = …` / `exports.x = …` 的右值
  // 跨文件「返回源码文本」的调用点（r12-3）：`readSrc(f)` 的返回值是源码文本 ⇒ 它出现在 receiver 位置
  // 时必须与 `readFileSync(…)` 同口径地污染下游。节点由 handleCall 在调用点登记，collectDeps 认它。
  const externalSourceCalls = new Set()
  const moduleSummary = !!options.moduleSummary

  const retBinding = (fn) => {
    let binding = rets.get(fn)
    if (!binding) {
      binding = { name: '(return)', tainted: false, fromSource: false, defs: [], fn: null }
      rets.set(fn, binding)
      bindings.push(binding)
    }
    return binding
  }

  const track = (target, expr) => {
    if (target && expr) edges.push({ target, expr })
  }

  // 方法表回溯：`new R()` 的实例绑定 → 类绑定 → 类体方法表（一跳到顶，不做复杂原型分析）。
  const methodOf = (binding, name) => {
    let cursor = binding
    for (let hop = 0; cursor && hop < 8; hop++) {
      if (cursor.methods && cursor.methods.has(name)) return cursor.methods.get(name)
      cursor = cursor.instanceOf
    }
    return null
  }

  // 被调名 → 返回源码文本的本地函数（绑定解析，不只看名字）：
  //   `f()`（函数声明 / `const f = () => …`）、`H.read()`（对象字面量方法）、
  //   `new R().read()`（类方法）、`R.prototype.read()`（原型方法）。方括号字面量键同口径。
  const resolveCalleeFn = (callee, scope) => {
    if (!callee) return null
    if (callee.type === 'Identifier') {
      const binding = scope.lookup(callee.name)
      return binding && binding.fn ? binding.fn : null
    }
    if (callee.type !== 'MemberExpression') return null
    const methodName = propertyName(callee)
    if (!methodName) return null
    const owner = callee.object
    let binding = null
    if (owner.type === 'Identifier') {
      binding = scope.lookup(owner.name)
    } else if (owner.type === 'NewExpression' && owner.callee.type === 'Identifier') {
      binding = scope.lookup(owner.callee.name)
    } else if (owner.type === 'MemberExpression' && propertyName(owner) === 'prototype' && owner.object.type === 'Identifier') {
      binding = scope.lookup(owner.object.name)
    }
    return binding ? methodOf(binding, methodName) : null
  }

  // 字符串比对方法的**引用**（r8-1）：`src.includes` / `src['includes']` / `String.prototype.includes` /
  // `[].includes` / 以及被 `.bind` 或别名接住后的绑定名。
  //   { method, receiver, bound }：bound = 已经 `.bind(receiver)`，可直接当函数调。
  const methodRefOf = (expr, scope) => {
    if (!expr) return null
    if (expr.type === 'Identifier') {
      const binding = scope.lookup(expr.name)
      return binding && binding.methodRef ? binding.methodRef : null
    }
    if (expr.type !== 'MemberExpression') return null
    const name = propertyName(expr)
    if (!name || !(STRING_METHODS.has(name) || name === 'test')) return null
    return { method: name, receiver: expr.object, bound: false }
  }

  // `const inc = src.includes.bind(src)` / `src['includes'].bind(src)` / 直接引用。
  const boundMethodRef = (expr, scope) => {
    if (!expr) return null
    if (expr.type === 'CallExpression' && propertyName(expr.callee) === 'bind') {
      const ref = methodRefOf(expr.callee.object, scope)
      if (!ref) return null
      const receiver = expr.arguments[0] || ref.receiver
      return receiver ? { method: ref.method, receiver, bound: true } : null
    }
    const ref = methodRefOf(expr, scope)
    return ref ? { ...ref, bound: false } : null
  }

  // 调用的「字符串比对」语义，三种等价形态统一成 { method, receiver, args }：
  //   ① `src.includes(x)` / `src['includes'](x)`             —— receiver = 被读的对象
  //   ② `X.call(thisArg, x)` / `X.apply(thisArg, [x])`      —— X 是 ① 的成员或别名，thisArg 即真 receiver
  //      （`String.prototype.includes.call(src,'X')`、`[].includes.call(src,'X')`、`RegExp.prototype.test.call(RE, src)`）
  //   ③ `const inc = src.includes.bind(src); inc('X')`       —— 已绑定的别名直接调用
  const stringComparisonCall = (node, scope) => {
    const callee = node.callee
    const name = propertyName(callee)
    if (name && STRING_METHODS.has(name)) return { method: name, receiver: callee.object, args: node.arguments }
    if (name === 'test') return { method: 'test', receiver: callee.object, args: node.arguments }
    if (name === 'call' || name === 'apply') {
      const ref = methodRefOf(callee.object, scope)
      const thisArg = node.arguments[0]
      if (!ref || !thisArg) return null
      let args
      if (name === 'call') {
        args = node.arguments.slice(1)
      } else {
        // `.apply(thisArg, [a, b])` 只认数组字面量：变量表无法静态对应到形参位置。
        const list = node.arguments[1]
        if (!list || list.type !== 'ArrayExpression') return null
        args = list.elements
      }
      return { method: ref.method, receiver: thisArg, args }
    }
    if (callee.type === 'Identifier') {
      const binding = scope.lookup(callee.name)
      const ref = binding && binding.methodRef
      if (ref && ref.bound && ref.receiver) return { method: ref.method, receiver: ref.receiver, args: node.arguments }
    }
    return null
  }

  // ── 跨文件 helper（r8-2） ──────────────────────────────────────────────
  // 形参来源：binding 的污染来自哪个函数的第几个形参。只在 `options.moduleSummary` 时维护
  // （正常扫描不付这份代价）。不动点里与污染一起传播，因为摘要要按「第几个形参」重建调用点候选。
  const addOrigin = (binding, fn, index) => {
    if (!binding.paramOrigins) binding.paramOrigins = new Map()
    let set = binding.paramOrigins.get(fn)
    if (!set) {
      set = new Set()
      binding.paramOrigins.set(fn, set)
    }
    set.add(index)
  }

  const unionOrigins = (target, source) => {
    let changed = false
    for (const [fn, set] of source) {
      if (!target.paramOrigins) target.paramOrigins = new Map()
      let own = target.paramOrigins.get(fn)
      if (!own) {
        own = new Set()
        target.paramOrigins.set(fn, own)
      }
      for (const index of set) {
        if (!own.has(index)) {
          own.add(index)
          changed = true
        }
      }
    }
    return changed
  }

  const mergeOrigins = (sources) => {
    let out = null
    for (const binding of sources) {
      if (!binding.paramOrigins) continue
      if (!out) out = new Map()
      for (const [fn, set] of binding.paramOrigins) {
        let own = out.get(fn)
        if (!own) {
          own = new Set()
          out.set(fn, own)
        }
        for (const index of set) own.add(index)
      }
    }
    return out
  }

  const paramOriginOf = (node) => {
    if (!node || node.type !== 'Identifier') return null
    const binding = idBinding.get(node)
    return binding && binding.paramOrigin ? binding.paramOrigin : null
  }

  // `const { hasText } = require('./test_support/hastext.js')` → imports 记「本地名 → 模块 + 导出名」；
  // `const mod = require('./x')` → importName '*'（调用点按 `mod.fn(…)` 的成员名取导出名）。
  const linkRequire = (init, id) => {
    if (!options.modules || !init) return
    if (init.type !== 'CallExpression' || calleeTailName(init.callee) !== 'require') return
    const specifier = literalValue(init.arguments[0])
    const moduleFile = typeof specifier === 'string' ? options.modules.resolve(specifier, file) : null
    if (!moduleFile) return
    if (id.type === 'ObjectPattern') {
      for (const prop of id.properties) {
        const name = keyName(prop)
        const local = prop.value && prop.value.type === 'Identifier' ? prop.value.name : null
        if (name && local) imports.set(local, { moduleFile, exportName: name })
      }
      return
    }
    if (id.type === 'Identifier') imports.set(id.name, { moduleFile, exportName: '*' })
  }

  // 调用点 → 本地模块的导出名（`hasText(…)` / `mod.hasText(…)`）；非本地模块调用返回 null。
  // r12-2：`const hasText = require('./x')` 时 importName 是 '*'（命名空间 require）——但**没有任何成员
  // 访问**就叫，说明模块本身被当函数用，即 `module.exports = fn`（默认导出）。旧实现在这里直接 return null，
  // 于是 exportsMap 把 `module.exports = fn` 记在 '*' 下却**从不被查**（:1094 的条目成了死数据）。
  // 两种形态都交给 summaryFor：它按导出名取函数，导出名不存在（`module.exports = { … }` 的命名空间
  // 被当函数调）时自然返回 null，不会凭空记命中。
  const moduleTargetOf = (callee) => {
    if (!callee) return null
    if (callee.type === 'Identifier') {
      const entry = imports.get(callee.name)
      if (!entry) return null
      return { moduleFile: entry.moduleFile, exportName: entry.exportName }
    }
    if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null
    const entry = imports.get(callee.object.name)
    const name = propertyName(callee)
    if (!entry || entry.exportName !== '*' || !name) return null
    return { moduleFile: entry.moduleFile, exportName: name }
  }

  // `module.exports = …` / `exports.x = …` 的登记（walk 之后解析成「导出名 → 函数节点」）。
  const collectExport = (node) => {
    const left = node.left
    if (!left || left.type !== 'MemberExpression') return
    const full = memberPath(left)
    if (!full) return
    if (full === 'module.exports') {
      exportSites.push({ name: null, value: node.right })
    } else if (full.startsWith('module.exports.')) {
      exportSites.push({ name: full.slice('module.exports.'.length), value: node.right })
    } else if (full.startsWith('exports.') && !full.slice('exports.'.length).includes('.')) {
      exportSites.push({ name: full.slice('exports.'.length), value: node.right })
    }
  }

  // 形参绑定（含解构/默认值/rest）：实参污染 → 形参污染。
  // 只能在函数节点被 walker 访问过之后调用（那时形参已在函数作用域里声明好），
  // 因此调用点的边一律进 deferred，walk 结束后再统一解析。
  const functionSchema = (fn) => {
    const schema = paramBindings.get(fn)
    if (!schema) throw new Error(`内部错误：函数未初始化就取形参（${file}）`)
    return schema
  }

  const collectDeps = (node, out) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      node.forEach((child) => collectDeps(child, out))
      return out
    }
    switch (node.type) {
      case undefined:
        return out
      case 'Identifier': {
        const binding = idBinding.get(node)
        if (binding) out.deps.add(binding)
        return out
      }
      case 'Literal':
      case 'ThisExpression':
      case 'Super':
      case 'MetaProperty':
        return out
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'FunctionDeclaration':
        // 函数值本身不携带文本（返回值另有 ret 绑定）。
        return out
      case 'CallExpression':
      case 'NewExpression': {
        const callee = node.callee
        const calleeName = memberPath(callee)
        // 读源码文本：`readFileSync(…)` / `fs.readFileSync(…)` / 别名 `read = fs.readFileSync` 后 `read(…)`。
        if (node.type === 'CallExpression' && SOURCE_CALLS.has(calleeTailName(callee))) {
          out.hasSource = true
          return out
        }
        if (node.type === 'CallExpression' && callee.type === 'Identifier') {
          const alias = idBinding.get(callee)
          if (alias && alias.sourceCall) {
            out.hasSource = true
            return out
          }
        }
        // 跨文件「返回源码文本」的 helper（r12-3）：`readSrc(f)` 与 `fs.readFileSync(f)` 同口径。
        // 没有这一跳时，把读文件抽成 helper 就能让 `readSrc(f).includes('X')` 两处都 0 命中。
        if (options.modules && externalSourceCalls.has(node)) {
          out.hasSource = true
          return out
        }
        if (calleeName && SANITIZER_PATHS.has(calleeName)) return out
        if (node.type === 'CallExpression' && callee.type === 'MemberExpression' && !callee.computed &&
          ELEMENT_CALLBACK_METHODS.has(callee.property.name)) {
          // 回调形参经 functionSchema 的 param 边单独污染；这里补「回调返回值」这一跳
          // （`FILES.map(f => readFileSync(f)).join('')` 这类拼接 helper 全靠它）。
          const callback = node.arguments.find(isFunctionNode)
          if (callback) out.deps.add(retBinding(callback))
        }
        // 返回源码文本的本地函数（函数声明 / 对象方法 / 类方法）：`H.read(f).includes(…)`、
        // `new R().read(f).includes(…)` 这一跳靠 callTargets（walk 后做的绑定解析）。
        // 已知本地函数时，**返回值是否污染由它的返回绑定决定**——不能因为实参是源码文本就把结果
        // 也当成源码文本：`parseAst(code)` 返回的是 AST（否则 `node.type === 'Literal'` 这类结构判断
        // 全被判成文本断言，闸门自身实测就有 112 条这种噪声）。未知函数（外部 API）才退化成
        // 「任一实参污染 ⇒ 结果污染」。
        const target = callTargets.get(node)
        if (target) {
          out.deps.add(retBinding(target))
        } else {
          node.arguments.forEach((argument) => collectDeps(argument, out))
        }
        collectDeps(callee, out)
        return out
      }
      case 'MemberExpression':
        collectDeps(node.object, out)
        if (node.computed) collectDeps(node.property, out)
        return out
      case 'ObjectExpression':
        node.properties.forEach((prop) => collectDeps(prop.value || prop.argument, out))
        return out
      case 'ArrayExpression':
      case 'SequenceExpression':
        (node.elements || node.expressions).forEach((child) => collectDeps(child, out))
        return out
      case 'TemplateLiteral':
        node.expressions.forEach((child) => collectDeps(child, out))
        return out
      case 'TaggedTemplateExpression':
        collectDeps(node.tag, out)
        collectDeps(node.quasi, out)
        return out
      default: {
        for (const key of Object.keys(node)) {
          if (SKIP_KEYS.has(key)) continue
          const child = node[key]
          if (child && typeof child === 'object' && typeof child.type === 'string') collectDeps(child, out)
        }
        return out
      }
    }
  }

  const newDeps = () => ({ hasSource: false, deps: new Set() })

  // ── 遍历（作用域感知） ────────────────────────────────────────────────
  let currentFn = null

  const walkList = (list, scope) => { for (const child of list) walk(child, scope) }

  const addCandidate = (node, receiverNode, literal, fn, method, anchorNode) => {
    // 锚点不可冻结时记 <dynamic>，**不跳过**：跳过等于给「把字面量提成常量」发通行证。
    const anchor = typeof literal === 'string' ? literal : DYNAMIC_ANCHOR
    candidates.push({ node, receiverNode, literal: anchor, fn, method, anchorNode, line: node.loc ? node.loc.start.line : 0 })
  }

  // 调用点记录（walk 结束后统一做绑定解析）：被调名 → 本地函数（对象方法 / 类方法 / 函数声明）。
  // 解析必须在 walk 之后：类体方法表在遍历到类声明时才建立，而 `const read = fs.readFileSync`
  // 这类别名的初值也要等 VariableDeclaration 走过。
  const callSites = [] // { node, callee, scope }
  const callTargets = new Map() // CallExpression 节点 → 返回源码文本的本地函数（或 null）
  // 调用点记录（walk 结束后统一解析成边）：实参→形参。
  const deferredArgEdges = [] // { fn, args }
  const deferredElementEdges = [] // { fn, receiver }

  // 比较/等值断言的登记（r12-1）：`<src> === '<字面量>'`、`assert.strictEqual(<src>, '<字面量>')`。
  // 恰好一侧是「可冻结的字面量侧」、另一侧**确实绑定到源码文本** ⇒ 一条命中（锚点 = 字面量侧）。
  // 两侧都是字面量 / 两侧都不是字面量 / 另一侧是量纲取值（.length、typeof）⇒ 不记。
  const noteEquality = (node, left, right, method) => {
    const leftAnchor = literalSideAnchor(left)
    const rightAnchor = literalSideAnchor(right)
    if (leftAnchor === undefined && rightAnchor === undefined) return
    if (leftAnchor !== undefined && rightAnchor !== undefined) return
    const anchor = leftAnchor !== undefined ? leftAnchor : rightAnchor
    const operand = leftAnchor !== undefined ? right : left
    const anchorNode = leftAnchor !== undefined ? left : right
    if (!isTextualOperand(operand)) return
    addCandidate(node, operand, anchor, currentFn, method, anchorNode)
  }

  const handleCall = (node, scope) => {
    callSites.push({ node, callee: node.callee, scope })
    const callee = node.callee
    const method = propertyName(callee)
    if (method) {
      if (MUTATOR_METHODS.has(method) && node.arguments.length) {
        // `tokens.push(buf)` / `arr.unshift(x)`：容器被写入源码文本 ⇒ 容器按污染处理。
        const holder = callee.object.type === 'Identifier' ? scope.lookup(callee.object.name) : null
        if (holder) track(holder, node.arguments[0])
      }
      if (ELEMENT_CALLBACK_METHODS.has(method)) {
        const callback = node.arguments.find(isFunctionNode)
        // 数组元素（一行源码）→ 回调第一形参；reduce 的累加器同源。
        if (callback) deferredElementEdges.push({ fn: callback, receiver: callee.object })
      }
    }
    // 字符串比对：直接成员 / `.call`·`.apply` 转发 / `.bind` 后的别名，三种形态同一口径（r8-1）。
    // **不看实参形态**：receiver 是源码文本 + 这是字符串比对方法 ⇒ 命中（锚点能冻结就冻结，
    // 不能就记 <dynamic>）。`src.includes(NEEDLE)` / `src['includes']('X')` / `line.includes(name)` 一律在册。
    const compare = stringComparisonCall(node, scope)
    if (compare) {
      if (compare.method === 'test') {
        // 正则字面量在 receiver 侧、源码文本在实参侧。正则**不是**字面量（变量/形参/new RegExp）时
        // 锚点不可冻结，但被比对的仍是源码文本 ⇒ <dynamic>。
        const literal = isRegexLiteral(compare.receiver) ? literalValue(compare.receiver) : undefined
        addCandidate(node, compare.args[0], literal, currentFn, 'regexp.test', compare.args[0])
      } else {
        addCandidate(node, compare.receiver, literalAnchor(compare.args[0]), currentFn, compare.method, compare.args[0])
      }
    }
    // `assert.match(<src>, <任意>)`：断言库形态的文本比对，与 `src.match(…)` 等价。
    // 第二参不是正则字面量（变量/形参）时同样记 <dynamic>——被测的仍是源码文本。
    if (memberPath(callee) === 'assert.match' && node.arguments.length >= 2) {
      addCandidate(node, node.arguments[0], literalAnchor(node.arguments[1]), currentFn, 'assert.match', node.arguments[1])
    }
    // 跨文件 helper（r8-2）：本地模块导出的函数里「形参 → 字符串比对」，在**调用点**按实参重建候选。
    // 例：`test_support/hastext.js` 的 `function hasText (s, n) { return s.includes(n) }` ⇒ 摘要
    // `{receiverParam:0, anchorParam:1}` ⇒ `hasText(src, 'X')` 在这里记一条锚点 'X' 的命中。
    // r12-3：摘要同时带「这个导出**自己**会读源码文本」（returnsSource）——`readSrc(f)` 这种 helper
    // 的返回值必须与 readFileSync 同口径，否则 `readSrc(f).includes('X')` 两个文件都不入账。
    if (options.modules && imports.size) {
      const target = moduleTargetOf(callee)
      if (target) {
        const summary = options.modules.summaryFor(target.moduleFile, target.exportName)
        if (summary && summary.returnsSource) externalSourceCalls.add(node)
        for (const entry of (summary && summary.entries) || []) {
          const receiver = node.arguments[entry.receiverParam]
          if (!receiver) continue
          const label = 'module-helper:' + target.exportName
          if (entry.anchorLiteral !== undefined) {
            addCandidate(node, receiver, entry.anchorLiteral, currentFn, label)
            continue
          }
          const anchorNode = entry.anchorParam === null || entry.anchorParam === undefined ? null : node.arguments[entry.anchorParam]
          addCandidate(node, receiver, literalAnchor(anchorNode), currentFn, label, anchorNode)
        }
      }
    }
    // 等值断言（r12-1）：`assert.strictEqual(<src行>, '…')` 与 `lines[i] === '…'` 同一口径。
    // 只认调用名在 EQUALITY_CALLS 里的形态（`assert.xxx` / 解构出来的 `xxx`），实参两两比较。
    if (EQUALITY_CALLS.has(calleeTailName(callee)) && node.arguments.length >= 2) {
      noteEquality(node, node.arguments[0], node.arguments[1], 'assert.' + calleeTailName(callee))
    }
  }

  const handleFunction = (node, scope) => {
    const outer = currentFn
    fnParent.set(node, outer)
    // 函数声明要先登记「这个名字是函数」：调用点靠 binding.fn 找形参，不登记就永远追不到
    // `function check(src) { src.includes(…) }` 这一跳。
    if (node.type === 'FunctionDeclaration' && node.id) scope.declare(node.id.name).fn = node
    const fnScope = new Scope(scope, true, bindings)
    if (node.type === 'FunctionExpression' && node.id) fnScope.declare(node.id.name)
    // 形参先声明（体里的引用要能解析到它们）
    const schema = node.params.map((param) => declarePattern(param, fnScope, 'param', []))
    paramBindings.set(node, schema)
    // 形参永不携带 fromSource（见 Scope.declare 的说明）：调用点传进来的源码文本属于 tainted 那一维，
    // 不属于「这个函数自己读了文件」。
    schema.forEach((list) => list.forEach((binding) => { binding.isParam = true }))
    // 模块摘要模式（r8-2）：形参按「已污染」处理，并记住它的来源（函数 + 形参序号）。
    if (moduleSummary) {
      schema.forEach((list, index) => {
        list.forEach((binding) => {
          binding.tainted = true
          binding.paramOrigin = { fn: node, index }
          addOrigin(binding, node, index)
        })
      })
    }
    hoistVars(node.body, fnScope)
    currentFn = node
    if (node.body.type === 'BlockStatement') {
      const blockScope = new Scope(fnScope, false, bindings)
      hoistLexical(node.body.body, blockScope)
      walkList(node.body.body, blockScope)
    } else {
      // 表达式体箭头函数（`f => fs.readFileSync(f, 'utf8')`）：表达式本身就是返回值。
      track(retBinding(node), node.body)
      walk(node.body, fnScope)
    }
    currentFn = outer
  }

  const walk = (node, scope) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    switch (node.type) {
      case 'Program': {
        const programScope = new Scope(null, true, bindings)
        hoistVars(node.body, programScope)
        hoistLexical(node.body, programScope)
        walkList(node.body, programScope)
        return
      }
      case 'BlockStatement':
      case 'StaticBlock': {
        const blockScope = new Scope(scope, false, bindings)
        hoistLexical(node.body, blockScope)
        walkList(node.body, blockScope)
        return
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        handleFunction(node, scope)
        return
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const classScope = new Scope(scope, false, bindings)
        // 方法表挂在**外层**作用域的类绑定上（`new R()` 在类体外，拿不到类内那层影子绑定）。
        // `hoistLexical` 已把类名声明进当前块，这里复用同一个 binding（没有才声明）。
        const classBinding = node.id ? (scope.lookup(node.id.name) || scope.declare(node.id.name)) : null
        if (classBinding) {
          if (!classBinding.methods) classBinding.methods = new Map()
          for (const member of node.body.body) {
            if ((member.type === 'MethodDefinition' || member.type === 'PropertyDefinition') &&
              isFunctionNode(member.value)) {
              const name = keyName(member)
              if (name) classBinding.methods.set(name, member.value)
            }
          }
          classScope.bindings.set(node.id.name, classBinding)
        }
        if (node.superClass) walk(node.superClass, classScope)
        walk(node.body, classScope)
        return
      }
      case 'VariableDeclaration': {
        for (const decl of node.declarations) {
          const targets = declarePattern(decl.id, scope, node.kind, [])
          const init = decl.init
          if (init && isFunctionNode(init)) {
            targets.forEach((binding) => { binding.fn = init })
          }
          // 绑定解析的三条「指向」：读源码函数的别名（const read = fs.readFileSync）、
          // 对象字面量的方法表（const H = { read: f => … }）、`new R()` 的类（方法表按原型链回溯）。
          if (init && isSourceReaderRef(init)) targets.forEach((binding) => { binding.sourceCall = true })
          // `const inc = src.includes.bind(src)` / `const inc = src['includes']`：别名也认（r8-1）。
          const methodRef = init ? boundMethodRef(init, scope) : null
          if (methodRef) targets.forEach((binding) => { binding.methodRef = methodRef })
          // `const { hasText } = require('./test_support/hastext.js')`：登记本地模块导出（r8-2）。
          linkRequire(init, decl.id)
          if (init && init.type === 'ObjectExpression') {
            targets.forEach((binding) => attachObjectMethods(init, binding))
          }
          if (init && init.type === 'NewExpression' && init.callee.type === 'Identifier') {
            const classBinding = scope.lookup(init.callee.name)
            if (classBinding) targets.forEach((binding) => { binding.instanceOf = classBinding })
          }
          targets.forEach((binding) => track(binding, init))
          walk(decl.id, scope)
          if (init) walk(init, scope)
        }
        return
      }
      case 'AssignmentExpression': {
        // `=` 与复合赋值（`buf += chunk`）都会把右值的文本带进左值。
        // 必须先 lookup 再 declare：`let text = ''; try { text = readFileSync(...) }` 这类在**块内**
        // 赋值的写法，直接 declare 会在块作用域里造影子绑定，块外的 `text.includes(...)` 就看不到污染。
        const resolveTargets = (pattern) => {
          if (!pattern) return []
          if (pattern.type === 'Identifier') {
            return [scope.lookup(pattern.name) || scope.declare(pattern.name)]
          }
          if (pattern.type === 'ObjectPattern') {
            return pattern.properties.flatMap((prop) => resolveTargets(prop.value || prop.argument))
          }
          if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(resolveTargets)
          if (pattern.type === 'AssignmentPattern') return resolveTargets(pattern.left)
          if (pattern.type === 'RestElement') return resolveTargets(pattern.argument)
          return []
        }
        const targets = resolveTargets(node.left)
        targets.forEach((binding) => track(binding, node.right))
        // 赋值的绑定解析（与 VariableDeclaration 同口径）：`read = fs.readFileSync`、
        // `H = { read: … }`、`H.read = f => …`。
        if (isSourceReaderRef(node.right)) targets.forEach((binding) => { binding.sourceCall = true })
        const methodRef = boundMethodRef(node.right, scope)
        if (methodRef) targets.forEach((binding) => { binding.methodRef = methodRef })
        if (moduleSummary) collectExport(node)
        if (node.right.type === 'ObjectExpression') targets.forEach((binding) => attachObjectMethods(node.right, binding))
        // 只给**本文件定义的对象字面量/类**登记方法（`methods` 已存在才收）：`fs.writeSync = fn`
        // 这类对 require 进来的模块对象打桩不得改变「fs 有什么方法」的认知——否则桩函数的形参
        // 会被别处 `fs.writeSync(fd, 数据)` 的实参污染，造出「data.includes(...) 是源码文本断言」的假命中。
        if (node.left.type === 'MemberExpression' && !node.left.computed &&
          node.left.object.type === 'Identifier' && isFunctionNode(node.right)) {
          const holder = scope.lookup(node.left.object.name)
          if (holder && holder.methods) holder.methods.set(node.left.property.name, node.right)
        }
        if (targets.length === 0 && node.left.type === 'MemberExpression') {
          // `arr[i] = tainted` / `obj.text = tainted`：容器被写入源码文本 ⇒ 容器整体按污染处理
          // （`shellTokens` 里 `tokens.push(buf)` 这类「逐字符搭出文本容器」的函数靠这一跳才认得出来）。
          const holder = memberPath(node.left.object)
          const binding = holder && !holder.includes('.') ? scope.lookup(holder) : null
          if (binding) track(binding, node.right)
        }
        walk(node.left, scope)
        walk(node.right, scope)
        return
      }
      case 'CallExpression':
      case 'NewExpression':
        handleCall(node, scope)
        walk(node.callee, scope)
        walkList(node.arguments, scope)
        return
      case 'BinaryExpression':
        // `lines[10] === '…'` / `src.slice(a, b) !== '…'`：运算符形态的逐字比对（r12-1）。
        if (COMPARISON_OPERATORS.has(node.operator)) noteEquality(node, node.left, node.right, node.operator)
        walk(node.left, scope)
        walk(node.right, scope)
        return
      case 'ReturnStatement':
        if (currentFn && node.argument) track(retBinding(currentFn), node.argument)
        walk(node.argument, scope)
        return
      case 'ForStatement': {
        const loopScope = new Scope(scope, false, bindings)
        if (node.init && node.init.type === 'VariableDeclaration') hoistLexical([node.init], loopScope)
        walk(node.init, loopScope)
        walk(node.test, loopScope)
        walk(node.update, loopScope)
        walk(node.body, loopScope)
        return
      }
      case 'ForOfStatement':
      case 'ForInStatement': {
        const loopScope = new Scope(scope, false, bindings)
        if (node.left.type === 'VariableDeclaration') {
          hoistLexical([node.left], loopScope)
          for (const decl of node.left.declarations) {
            const targets = declarePattern(decl.id, loopScope, node.left.kind, [])
            targets.forEach((binding) => track(binding, node.right))
          }
        }
        walk(node.left, loopScope)
        walk(node.right, loopScope)
        walk(node.body, loopScope)
        return
      }
      case 'SwitchStatement': {
        walk(node.discriminant, scope)
        const switchScope = new Scope(scope, false, bindings)
        hoistLexical(node.cases.flatMap((c) => c.consequent), switchScope)
        for (const switchCase of node.cases) {
          if (switchCase.test) walk(switchCase.test, switchScope)
          walkList(switchCase.consequent, switchScope)
        }
        return
      }
      case 'CatchClause': {
        const catchScope = new Scope(scope, false, bindings)
        if (node.param) declarePattern(node.param, catchScope, 'let', [])
        walk(node.param, catchScope)
        walk(node.body, catchScope)
        return
      }
      case 'Identifier': {
        const binding = scope.lookup(node.name)
        if (binding) idBinding.set(node, binding)
        return
      }
      case 'ImportDeclaration':
        for (const specifier of node.specifiers) scope.declare(specifier.local.name)
        return
      default:
        break
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach((item) => walk(item, scope))
      else if (child && typeof child === 'object') walk(child, scope)
    }
  }

  walk(ast, null)

  // 调用点的绑定解析必须在 walk 之后：方法表（类体/对象字面量）与别名初值（const read = fs.readFileSync）
  // 都是遍历过程中登记到 binding 上的。解析结果同时用于「实参 → 形参」边与 collectDeps 的返回值污染。
  for (const site of callSites) {
    const fn = resolveCalleeFn(site.callee, site.scope)
    callTargets.set(site.node, fn)
    if (fn) deferredArgEdges.push({ fn, args: site.node.arguments })
  }

  // 调用点的边必须等 walk 结束（形参已在各自函数作用域里声明）再解析。
  for (const deferred of deferredArgEdges) {
    const schema = functionSchema(deferred.fn)
    schema.forEach((list, index) => {
      const argument = deferred.args[index]
      if (!argument) return
      list.forEach((target) => track(target, argument))
    })
  }
  for (const deferred of deferredElementEdges) {
    functionSchema(deferred.fn).forEach((list) => list.forEach((binding) => track(binding, deferred.receiver)))
  }

  // ── B. 边 → {hasSource, deps} ────────────────────────────────────────
  for (const edge of edges) {
    const deps = newDeps()
    collectDeps(edge.expr, deps)
    if (!isBooleanExpr(edge.expr)) deps.textual = true
    edge.target.defs.push(deps)
  }

  // ── C. 单调不动点 ────────────────────────────────────────────────────
  // 污染：binding 只会 false → true；形参来源（模块摘要模式）同样是单调并集 ⇒ 必然收敛。
  let changed = true
  while (changed) {
    changed = false
    for (const binding of bindings) {
      if (!binding.tainted) {
        for (const dep of binding.defs) {
          if (dep.hasSource || [...dep.deps].some((other) => other.tainted)) {
            binding.tainted = true
            changed = true
            break
          }
        }
      }
      // 「污染来自读文件」（r12-3）：与 tainted 分开传播，因为模块摘要模式下**形参也已污染**，
      // 只用 tainted 会把 `wrap(s) { return s.trim() }` 也判成「自己会读源码的 helper」。
      // 形参本身不参与（isParam）：它们只能从调用点拿到文本，不代表「这个函数自己读了文件」。
      if (!binding.fromSource && !binding.isParam) {
        for (const dep of binding.defs) {
          if (dep.hasSource || [...dep.deps].some((other) => other.fromSource)) {
            binding.fromSource = true
            changed = true
            break
          }
        }
      }
      if (moduleSummary) {
        for (const dep of binding.defs) {
          for (const other of dep.deps) {
            if (other.paramOrigins && unionOrigins(binding, other.paramOrigins)) changed = true
          }
        }
      }
    }
  }

  // 返回源码文本的本地函数是**管道**（`codeOf` / `stripComments` / `readConsoleSource`）：它们体内
  // 的 `'('`、`'//'`、`'{'`、`'\n'` 这类纯分隔符是词法/解析实现细节，不是排版锚点——格式化重排不会
  // 让它们失配，冻进基线只会让闸门对「改剥注释逻辑」这种无关改动误红。但**带标识符的锚点**
  // （`'function buildCacheShard ('`、`/REPORT_COUNTERS/g`）在管道里也是真断言（`extractBlock`
  // 这类「切块再比对」的 helper 就是），照常计入。
  const readers = new Set()
  for (const [fn, binding] of rets) {
    if (binding.tainted && binding.defs.some((dep) => dep.textual)) readers.add(fn)
  }
  // 「**自己**会读源码文本」的函数（r12-3）：返回值污染源自读文件（fromSource）且返回的是文本。
  // 与 readers 的差别：readers 也包含「形参传进来的文本」这一路（切块 helper 的分隔符豁免要用它），
  // 而跨文件推断必须更严——否则 `wrap(s) { return s.trim() }` 会被误判成「这个 helper 会读源码」，
  // 于是 `wrap('普通字符串').includes('x')` 平白多一条命中。
  const sourceReturners = new Set()
  for (const [fn, binding] of rets) {
    if (binding.fromSource && binding.defs.some((dep) => dep.textual)) sourceReturners.add(fn)
  }
  const isDelimiterLiteral = (literal) => !/[A-Za-z0-9\u4e00-\u9fff]/.test(literal)

  const hits = []
  for (const candidate of candidates) {
    if (candidate.fn && readers.has(candidate.fn) && isDelimiterLiteral(candidate.literal)) continue
    const deps = newDeps()
    collectDeps(candidate.receiverNode, deps)
    const tainted = deps.hasSource || [...deps.deps].some((binding) => binding.tainted)
    if (!tainted) continue
    const hit = { file, line: candidate.line, literal: candidate.literal, method: candidate.method }
    if (moduleSummary) {
      // 摘要只描述「形参 → 字符串比对」这一条路：receiver 必须来自形参，锚点要么是形参、要么是体内字面量。
      hit.fn = candidate.fn
      hit.paramOrigins = mergeOrigins(deps.deps)
      hit.anchorOrigin = paramOriginOf(candidate.anchorNode)
      hit.anchorLiteral = candidate.anchorNode ? literalValue(candidate.anchorNode) : undefined
    }
    hits.push(hit)
  }
  hits.sort((a, b) => (a.line - b.line) || (a.literal < b.literal ? -1 : a.literal > b.literal ? 1 : 0))

  // 导出函数表 + 每个导出函数的「形参 → 字符串比对」摘要（只有 moduleSummary 模式才需要）。
  const exportsMap = new Map() // 导出名 → 函数节点（'*' = `module.exports = fn`）
  const byFn = new Map() // 函数节点 → [{ receiverParam, anchorParam?, anchorLiteral? }]
  if (moduleSummary) {
    const fnOf = (node) => {
      if (!node) return null
      if (isFunctionNode(node)) return node
      if (node.type === 'Identifier') {
        const binding = idBinding.get(node)
        return binding && binding.fn ? binding.fn : null
      }
      return null
    }
    for (const site of exportSites) {
      if (site.name) {
        const fn = fnOf(site.value)
        if (fn) exportsMap.set(site.name, fn)
        continue
      }
      if (site.value && site.value.type === 'ObjectExpression') {
        for (const prop of site.value.properties) {
          if (!prop || prop.type !== 'Property') continue
          const name = keyName(prop)
          const fn = fnOf(prop.value)
          if (name && fn) exportsMap.set(name, fn)
        }
        continue
      }
      const fn = fnOf(site.value)
      if (fn) exportsMap.set('*', fn)
    }
    const exportedFns = new Set(exportsMap.values())
    for (const hit of hits) {
      // 命中可能落在嵌套回调里（`s.split('\n').some(l => l.includes(n))`）：往最近的导出函数上爬，
      // 形参序号按**那个函数**的口径取——回调自己的形参不是调用点能对应的东西。
      let fn = hit.fn
      let guard = 0
      while (fn && !exportedFns.has(fn) && guard++ < 64) fn = fnParent.get(fn)
      if (!fn) continue
      const indexes = hit.paramOrigins && hit.paramOrigins.get(fn)
      if (!indexes || indexes.size !== 1) continue
      const receiverParam = [...indexes][0]
      let entry
      if (hit.anchorOrigin && hit.anchorOrigin.fn === fn) {
        entry = { receiverParam, anchorParam: hit.anchorOrigin.index }
      } else if (typeof hit.anchorLiteral === 'string') {
        entry = { receiverParam, anchorLiteral: hit.anchorLiteral }
      } else {
        entry = { receiverParam, anchorParam: null }
      }
      let list = byFn.get(fn)
      if (!list) {
        list = []
        byFn.set(fn, list)
      }
      const same = (other) => other.receiverParam === entry.receiverParam &&
        other.anchorParam === entry.anchorParam && other.anchorLiteral === entry.anchorLiteral
      if (!list.some(same)) list.push(entry)
    }
  }
  return { hits, exports: exportsMap, byFn, sourceReturners }
}

// 单文件入口（用例与外部调用用）：只要命中列表。
function analyzeSource (code, file, options) {
  return analyzeModule(code, file, options).hits
}

/* ── 扫描面 + 显式跳过名单 ──────────────────────────────────────────────
 * r12-4：扫描面曾是**封闭白名单**（根 test_*.js + test_support/** + test/**），r8-3 只补了 test/。
 * 把「读源码文本 + 比对」整段搬进 helpers/（或 scripts/）的 helper，调用点只传锚点，就两处同时失明：
 * helper 不在扫描面、摘要因形参来源为空也不产条目 ⇒ 闸门 exit 0 并提示「重跑 --write-allowlist 收紧基线」，
 * 白名单能一路降到 0 而每步 ✅。这与 r8-3 判 must_fix 的洗白路径只差一个目录名。
 *
 * 现在：扫描面 = **整棵仓库**的 .js/.cjs/.mjs，减去下面这一份**显式**名单。新目录（helpers/、lib/、任何
 * 未命名的目录）默认在扫描面内——不存在第二份隐式白名单。跳过项及理由：
 *   · 依赖 / 版本库 / 产物 / 缓存：node_modules、.git、.stryker-tmp、.nyc_output、coverage、reports、
 *     .local、.ai、.tools、xianbaoku_cache*（运行期缓存目录，名字带进程号）；
 *   · vendor 打包产物：scripts/console-assets/（第三方库的单文件 bundle，standard 同样忽略）；
 *   · **被测系统本身**：根 xbk_*.js、qinglong/、deploy/。它们不是断言，是业务逻辑；实测把
 *     xbk_failure_policy.js(12) / xbk_app.js(2) / xbk_message_store.js(2) 计进来，等于把「读缓存/日志后
 *     做字符串判定」这类正常生产写法冻进基线，之后任何生产改动都会被这道**测试面**闸门误红。
 *     跨文件 helper 的解析（CROSS_FILE_SKIP 时代起）用的就是同一份名单——扫描面与摘要面口径一致。
 */
const JS_FILE_RE = /\.(?:js|cjs|mjs)$/
const REPO_SKIP = [
  /(^|\/)(?:node_modules|\.git|\.stryker-tmp|\.nyc_output|coverage|reports|\.local|\.ai|\.tools)\//,
  /(^|\/)xianbaoku_cache[^/]*\//,
  /^xbk_[^/]*\.(?:js|cjs|mjs)$/,
  /^qinglong\//,
  /^deploy\//,
  /^scripts\/console-assets\//
]

// 路径（仓库相对、'/' 分隔）是否在显式跳过名单里。目录判断传 `rel + '/'`，这样 `foo/node_modules/`
// 这类嵌套依赖目录同样被跳过（正则的 `(^|/)` 分支就是为它写的）。
const isSkippedPath = (rel) => REPO_SKIP.some((re) => re.test(rel))

function listScanFiles () {
  const files = []
  const walkDir = (relative) => {
    const abs = relative ? path.join(ROOT, relative) : ROOT
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true }) // nosemgrep（abs = ROOT（__dirname 常量）+ 仓库内相对目录，无外部输入）
    } catch (e) {
      // r12-4：目录读不下去必须响亮（exit 2）——「少扫一个目录」与「全部干净」输出长得一样。
      die(2, `扫描失败：目录读不了 ${relative || '.'}：${e.message}`)
    }
    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name
      if (entry.isDirectory()) {
        if (!isSkippedPath(rel + '/')) walkDir(rel)
        continue
      }
      // 符号链接一律不跟（node_modules 在工作树里就是软链，跟进去等于扫依赖树）。
      if (!entry.isFile() || !JS_FILE_RE.test(entry.name)) continue
      if (isSkippedPath(rel)) continue
      files.push(rel)
    }
  }
  walkDir('')
  if (!files.length) die(2, '扫描失败：扫描面为 0 个文件（ROOT 不对？）——这不能读作「没有源码文本断言」')
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/* ── 本地模块摘要表（r8-2：跨文件 helper 的污染传播） ─────────────────────
 * 为什么需要：`function hasText (s, n) { return s.includes(n) }` 放在 test_support/（或 scripts/、test/）
 * 里导出，测试调用 `hasText(src, 'X')` 时形参污染从不跨 require 边界传播 ⇒ 两个文件各自 0 命中、
 * 闸门 exit 0，而断言一条没少（评审实测）。这里把「被 require 的本地模块」按**形参已污染**的假设
 * 分析一遍，得到「导出函数 → 第几个形参做 receiver / 锚点来自第几个形参」的摘要；调用点再用实参
 * 重建候选，污染因此跨文件传播。
 *
 * 解析范围：只认相对路径 require（`./x`、`../x`），并按与扫描面**同一份**显式跳过名单（REPO_SKIP）
 * 排除生产模块（xbk_*.js 是被测系统，不是测试 helper）与 vendor/产物目录。
 * 其余本地 .js/.cjs/.mjs 一律解析——包括仓库根的 helper 与**任意新目录**（否则「把断言搬进
 * helpers/foo.js」又是一条绕过；r12-4）。
 */

function resolveLocalModule (specifier, fromFile) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), specifier)
  const candidates = [base, base + '.js', base + '.cjs', base + '.mjs', path.join(base, 'index.js')]
  const abs = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile() // nosemgrep（candidate 由 ROOT（__dirname 常量）+ 仓库内相对 require 拼成，只做存在性检查）
    } catch {
      return false
    }
  })
  if (!abs) return null
  if (!abs.startsWith(ROOT + path.sep)) return null
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  if (!JS_FILE_RE.test(rel)) return null
  if (isSkippedPath(rel)) return null
  return rel
}

function createModuleIndex () {
  const cache = new Map() // 相对路径 → { exports, byFn, sourceReturners } | null
  const loading = new Set()
  const failures = []
  const api = {
    resolve: resolveLocalModule,
    // 返回 { entries, returnsSource }（r12-3）：
    //   entries       = 「第几个形参做 receiver / 锚点来自第几个形参」的摘要（r8-2）
    //   returnsSource = 这个导出**自己会读源码文本**（`readSrc(f) { return readFileSync(f) }`），
    //                   调用点据此把 `readSrc(f)` 的返回值当源码文本。
    summaryFor (rel, exportName) {
      const info = ensure(rel)
      if (!info) return null
      const fn = info.exports.get(exportName)
      if (!fn) return null
      return { entries: info.byFn.get(fn) || [], returnsSource: info.sourceReturners.has(fn) }
    },
    failures: () => failures.slice()
  }
  function ensure (rel) {
    if (cache.has(rel)) return cache.get(rel)
    // 循环 require：拿不到完整摘要就返回 null（下游只会少记，不会凭空多记）——本仓本地 helper 无环。
    if (loading.has(rel)) return null
    loading.add(rel)
    let info = null
    try {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8') // nosemgrep（rel 只来自 resolveLocalModule 的仓库内相对路径枚举）
      const analysis = analyzeModule(code, rel, { moduleSummary: true, modules: api })
      info = { exports: analysis.exports, byFn: analysis.byFn, sourceReturners: analysis.sourceReturners }
    } catch (e) {
      failures.push(`${rel}: ${e.message}`)
    } finally {
      loading.delete(rel)
    }
    cache.set(rel, info)
    return info
  }
  return api
}

function scanAll () {
  const hits = []
  const modules = createModuleIndex()
  for (const file of listScanFiles()) {
    let code
    try {
      code = fs.readFileSync(path.join(ROOT, file), 'utf8') // nosemgrep（file 只来自本文件的扫描面枚举（整棵仓库减 REPO_SKIP），不来自环境或入参）
    } catch (e) {
      die(2, '扫描失败 ' + file + ': ' + e.message)
    }
    try {
      hits.push(...analyzeModule(code, file, { modules }).hits)
    } catch (e) {
      die(2, '扫描失败 ' + file + ': ' + e.message)
    }
  }
  // 被 require 的本地 helper 解析不了 ⇒ 摘要缺失，污染跨文件传播就会出现静默漏洞：响亮 exit 2。
  const failures = modules.failures()
  if (failures.length) die(2, '本地 helper 无法解析（跨文件 helper 会漏检，fail-closed）：' + failures.join('；'))
  return hits
}

function die (code, message) {
  console.error(message)
  process.exit(code)
}

// ── 紧凑基线（schema 2）+ 逐条清单出仓 ─────────────────────────────────────
// v3.448：白名单从「逐条清单（items，13.5k 行 / 312 KB）」改成「按文件计数（~45 行）」。原因：逐条清单是
// 仓库体积与 diff 噪声的主要来源，而放行判定真正需要的只有「某文件现在有几个」。逐条清单仍有价值（定位
// 新增断言的 file:line），但它是**取证材料**，用 --inventory 写到仓库外，不随仓库走。
const BASELINE_SCHEMA = 2
const INVENTORY_ENV = 'SOURCE_TEXT_ASSERT_INVENTORY'
// 默认落在仓库外：逐条清单是 2714 行的一次性取证材料，进仓库等于把刚删掉的东西又加回来。
const INVENTORY_DEFAULT = path.join(os.homedir(), 'ledgers', 'pipelines', 'assertshape-20261115', 'inventory.json')
const BASELINE_NOTE = '紧凑基线（schema 2）：只冻结「文件 → 条数」，逐条清单不随仓库走（node scripts/check-source-text-asserts.js --inventory 出仓）。' +
  '扫描面：整棵仓库的 .js/.cjs/.mjs，减去显式跳过名单 REPO_SKIP（node_modules / .git / .stryker-tmp / .nyc_output / coverage / reports / .local / .ai / .tools / xianbaoku_cache* / scripts/console-assets 等 vendor 产物 / 被测系统本身 xbk_*.js、qinglong/、deploy/）；新目录默认在扫描面内。' +
  '跨文件 helper：被 require 的本地模块按「导出函数形参 → 字符串比对」摘要在调用点按实参入账；`module.exports = fn`（默认导出）与「自身读源码文本的 helper」（readSrc(f).includes(…)）同口径。' +
  '命中形态：字符串方法（includes/startsWith/…/match）、正则 test、assert.match、比较运算符（==/===/!=/!==）与 assert.strictEqual 家族的「源码文本 vs 字面量」逐字比对；量纲断言（.length / typeof）不计。' +
  '判定：某文件实测条数 > 基线 → exit 1 并点名 文件/基线/实测/增量；基线里没有的文件实测有条目 → exit 1；条数下降允许并按文件报 shortfall；' +
  'total 与 by_file 不自洽、或差额无法逐文件归因 → exit 2。' +
  'literal = 静态可冻结锚点（字符串字面量 / 无插值模板 / 正则字面量，正则记成 /src/flags）；dynamic = <dynamic>，' +
  'receiver 确实绑定到源码文本但锚点无法静态冻结（变量 / 常量表 / helper 形参 / 动态 RegExp）——把字面量提成常量不得让整条断言从检测面上消失。' +
  '已知取舍：按文件计数看不到同一文件内 literal 之间的互换（N 条换 N 条仍绿），只有 --inventory 的 diff 能看到。' +
  '重生成：node scripts/check-source-text-asserts.js --write-allowlist（改基线才用，正常不要跑；round-trip 逐字节稳定）。'
const INVENTORY_NOTE = '逐条清单（仓库外取证材料，与 scripts/source-text-assert.allowlist.json 的紧凑基线同源）：' +
  'kind=literal 是静态可冻结锚点（字符串字面量 / 无插值模板 / 正则字面量，正则记成 /src/flags），kind=dynamic 是 <dynamic>' +
  '（receiver 绑定到源码文本、但锚点无法静态冻结）。total/by_file 必须与紧凑基线一致：它是「新增哪一行」的唯一依据。'

const kindOf = (hit) => (hit.literal === DYNAMIC_ANCHOR ? 'dynamic' : 'literal')

// 码元序比较器（Sonar S2871/S2879：`sort()` 不带比较器是 BUG 级告警；localeCompare 会随宿主 locale 漂移）。
function byFileName (a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// 按文件汇总：all = 条数（放行判定只看这个），literal = 可冻结锚点条数，dynamic = all - literal。
// items 保留原始命中（file/line/literal），供 --inventory 与 file:line 诊断用。
function summarize (items) {
  const perFile = new Map()
  for (const item of items) {
    let entry = perFile.get(item.file)
    if (!entry) {
      entry = { all: 0, literal: 0, dynamic: 0, items: [] }
      perFile.set(item.file, entry)
    }
    entry.all++
    if (kindOf(item) === 'literal') entry.literal++
    else entry.dynamic++
    entry.items.push(item)
  }
  return perFile
}

function totalsOf (perFile) {
  const totals = { all: 0, literal: 0, dynamic: 0 }
  for (const entry of perFile.values()) {
    totals.all += entry.all
    totals.literal += entry.literal
    totals.dynamic += entry.dynamic
  }
  return totals
}

const sortedByFile = (perFile) => [...perFile.entries()].sort((a, b) => byFileName(a[0], b[0]))

function printByFile (title, perFile, withSplit) {
  console.log(title)
  const rows = [...perFile.entries()].sort((a, b) => (b[1].all - a[1].all) || byFileName(a[0], b[0]))
  if (!rows.length) {
    console.log('  （无）')
    return
  }
  for (const [file, entry] of rows) {
    const split = withSplit ? `（literal ${entry.literal} / dynamic ${entry.dynamic}）` : ''
    console.log(`  ${file} ${entry.all}${split}`)
  }
}

// 紧凑基线的序列化：一个文件一行（JSON.stringify(…, null, 2) 会把每条展开成 4 行，落不进 ~50 行）。
// 顺序固定（note / schema / total / by_file，by_file 按文件名码元序）⇒ --write-allowlist 的 round-trip
// 与冻结文件**逐字节**一致，手改与重生成不会来回跳。
function renderBaseline (hits) {
  const perFile = summarize(hits)
  const totals = totalsOf(perFile)
  const rows = sortedByFile(perFile).map(([file, entry]) =>
    `    ${JSON.stringify(file)}: { "all": ${entry.all}, "literal": ${entry.literal} }`)
  const tail = rows.length ? [rows.join(',\n'), '  }'] : ['  }']
  return [
    '{',
    `  "note": ${JSON.stringify(BASELINE_NOTE)},`,
    `  "schema": ${BASELINE_SCHEMA},`,
    `  "total": { "all": ${totals.all}, "literal": ${totals.literal}, "dynamic": ${totals.dynamic} },`,
    '  "by_file": {',
    ...tail,
    '}'
  ].join('\n') + '\n'
}

const isCount = (value) => Number.isInteger(value) && value >= 0

// 基线自相矛盾一律 exit 2（fail-closed）：既不按 total 也不按 by_file 放行。
// 这里把「实测」也写进报错——手改 total 却不改 by_file 时，两个数字会同时出现在一行里，
// 一眼能看出是基线坏了而不是代码坏了。
function assertBaselineShape (raw, measuredTotal) {
  const bad = (why) => die(2, `❌ 基线自相矛盾（${ALLOW_REL}）：${why}。` +
    `当前实测 ${measuredTotal} 条。修法：node scripts/check-source-text-asserts.js --write-allowlist 重生成` +
    '（逐条清单用 --inventory 出仓）。')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('顶层必须是对象')
  if (raw.schema !== BASELINE_SCHEMA) {
    bad(`schema 必须是 ${BASELINE_SCHEMA}，实得 ${JSON.stringify(raw.schema)}（逐条清单形状已废弃，清单请用 --inventory 出仓）`)
  }
  const total = raw.total
  if (!total || typeof total !== 'object' || Array.isArray(total)) bad('缺少 total 对象')
  for (const key of ['all', 'literal', 'dynamic']) {
    if (!isCount(total[key])) bad(`total.${key} 必须是非负整数，实得 ${JSON.stringify(total[key])}`)
  }
  const files = raw.by_file
  if (!files || typeof files !== 'object' || Array.isArray(files)) bad('缺少 by_file 对象')
  let sumAll = 0
  let sumLiteral = 0
  for (const [file, entry] of Object.entries(files)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) bad(`by_file["${file}"] 必须是 {all, literal} 对象`)
    if (!isCount(entry.all) || !isCount(entry.literal)) {
      bad(`by_file["${file}"] 的 all / literal 必须是非负整数，实得 ${JSON.stringify(entry)}`)
    }
    if (entry.literal > entry.all) bad(`by_file["${file}"] 的 literal(${entry.literal}) > all(${entry.all})`)
    sumAll += entry.all
    sumLiteral += entry.literal
  }
  if (sumAll !== total.all) bad(`total.all=${total.all}，但 by_file 各 all 之和=${sumAll}`)
  if (sumLiteral !== total.literal) bad(`total.literal=${total.literal}，但 by_file 各 literal 之和=${sumLiteral}`)
  if (total.literal + total.dynamic !== total.all) {
    bad(`total.literal(${total.literal}) + total.dynamic(${total.dynamic}) ≠ total.all(${total.all})`)
  }
  return raw
}

function readBaseline (measuredTotal) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) // nosemgrep（ALLOW_FILE = __dirname 常量 + 固定文件名，基线就在脚本旁边）
  } catch (e) {
    die(2, `❌ 基线不可读或不是合法 JSON（${ALLOW_REL}）：${e.message}`)
  }
  return assertBaselineShape(raw, measuredTotal)
}

// 按文件计数比对（v3.448）：只看 all。
//   实测 > 基线        ⇒ violation（exit 1，点名文件 / 基线 / 实测 / 增量）
//   基线里没有该文件    ⇒ violation（新文件，基线按 0 算）
//   实测 < 基线        ⇒ shortfall（绿：断言被替换/删除，允许，并按文件报下降量）
// literal 与 dynamic 的分列只用于报告，不参与判定（锚点从字面量提成常量不是「新增断言」）。
function compareByFile (hits, baseline) {
  const measured = summarize(hits)
  const baselineFiles = baseline.by_file
  const files = new Set([...Object.keys(baselineFiles), ...measured.keys()])
  const violations = []
  const shortfalls = []
  for (const file of [...files].sort(byFileName)) {
    const hasBaseline = Object.prototype.hasOwnProperty.call(baselineFiles, file)
    const allowed = hasBaseline ? baselineFiles[file] : null
    const got = measured.get(file) || { all: 0, literal: 0, dynamic: 0, items: [] }
    if (!allowed) {
      if (got.all === 0) continue
      violations.push({
        file,
        isNewFile: true,
        baseline: 0,
        measured: got.all,
        extra: got.all,
        literal: got.literal,
        baselineLiteral: 0,
        entries: got.items
      })
      continue
    }
    if (got.all > allowed.all) {
      violations.push({
        file,
        isNewFile: false,
        baseline: allowed.all,
        measured: got.all,
        extra: got.all - allowed.all,
        literal: got.literal,
        baselineLiteral: allowed.literal,
        entries: got.items
      })
    } else if (got.all < allowed.all) {
      shortfalls.push({
        file,
        baseline: allowed.all,
        measured: got.all,
        missing: allowed.all - got.all,
        literal: got.literal,
        baselineLiteral: allowed.literal
      })
    }
  }
  return { violations, shortfalls, measured, measuredTotals: totalsOf(measured) }
}

// 逐条清单（file:line）只可能来自仓库外的 inventory：紧凑基线没有行号，所以「新增哪一行」要么由
// --inventory 的旧快照 diff 得出，要么只能点名文件 + 增量。inventory 缺失/陈旧一律不改变退出码。
function loadInventoryItems (hint) {
  try {
    const raw = JSON.parse(fs.readFileSync(hint, 'utf8')) // nosemgrep（hint = 环境变量或本文件常量路径，只读、缺失即降级为「点名文件」）
    if (!raw || !Array.isArray(raw.items)) return null
    return raw.items.filter((item) => item && typeof item.file === 'string' && typeof item.literal === 'string')
  } catch (e) {
    return null
  }
}

// 多重集扣减：inventory 里记过的 (file,literal) 出现 N 次就不再算「新增」，剩下的才是新断言。
function diffAgainstInventory (hits, known, onlyFiles) {
  const budget = new Map()
  for (const item of known) {
    const key = item.file + '\u0000' + item.literal
    budget.set(key, (budget.get(key) || 0) + 1)
  }
  const extras = []
  for (const hit of hits) {
    if (onlyFiles && !onlyFiles.has(hit.file)) continue
    const key = hit.file + '\u0000' + hit.literal
    const left = budget.get(key) || 0
    if (left > 0) {
      budget.set(key, left - 1)
      continue
    }
    extras.push(hit)
  }
  return extras
}

function printNewHitLines (hits, violations) {
  const hint = process.env[INVENTORY_ENV] || INVENTORY_DEFAULT
  const known = loadInventoryItems(hint)
  if (!known) {
    console.log(`ℹ️ 没有可用的逐条清单（${hint}）：只能按文件报增量。要 file:line 就在基线冻结状态下先跑 --inventory。`)
    return
  }
  const extras = diffAgainstInventory(hits, known, new Set(violations.map((v) => v.file)))
  if (!extras.length) {
    console.log(`ℹ️ 逐条清单（${hint}）里找不到对应的新增行（快照陈旧或条数在文件内互换）：按文件增量处理。`)
    return
  }
  console.log(`新增命中的位置（对照 ${hint}）：`)
  extras.slice(0, 40).forEach((hit) => {
    console.log(`  ${hit.file}:${hit.line}  ${JSON.stringify(hit.literal).slice(0, 80)}（${kindOf(hit)}）`)
  })
  if (extras.length > 40) console.log(`  …还有 ${extras.length - 40} 处未列出`)
}

// --inventory 的目标路径：--inventory <path> / --inventory=<path> / 环境变量 / 默认（仓库外）。
function inventoryTarget () {
  const inline = process.argv.find((arg) => arg.startsWith('--inventory='))
  if (inline) return inline.slice('--inventory='.length)
  const index = process.argv.indexOf('--inventory')
  if (index >= 0) {
    const next = process.argv[index + 1]
    if (next && !next.startsWith('--')) return next
  }
  return process.env[INVENTORY_ENV] || INVENTORY_DEFAULT
}

// 逐条清单**绝不进仓库**：它是 2714 行的取证材料，进仓库等于把刚刚删掉的东西换个名字加回来。
function assertOutsideRepo (abs, flag) {
  const rel = path.relative(ROOT, abs)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (inside) {
    die(2, `❌ ${flag} 的目标不得落在仓库目录内（${ROOT}）：${abs}。逐条清单是仓库外产物，禁止写进仓库。`)
  }
}

function writeInventory (hits, target) {
  const abs = path.resolve(target)
  assertOutsideRepo(abs, '--inventory')
  const perFile = summarize(hits)
  const totals = totalsOf(perFile)
  const byFile = {}
  for (const [file, entry] of sortedByFile(perFile)) byFile[file] = { all: entry.all, literal: entry.literal, dynamic: entry.dynamic }
  const body = {
    note: INVENTORY_NOTE,
    schema: BASELINE_SCHEMA,
    baseline: ALLOW_REL,
    total: totals,
    by_file: byFile,
    items: hits.map((hit) => ({ file: hit.file, line: hit.line, literal: hit.literal, kind: kindOf(hit) }))
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true }) // nosemgrep（abs 已过 assertOutsideRepo：仓库目录一律拒绝，这里只建仓库外的取证目录）
    fs.writeFileSync(abs, JSON.stringify(body, null, 2) + '\n') // nosemgrep（同上：目标是仓库外的逐条清单，路径由 --inventory 或常量默认给出）
  } catch (e) {
    die(2, `❌ 逐条清单写盘失败（${abs}）：${e.message}`)
  }
  console.log(`已写入逐条清单 ${totals.all} 条（literal ${totals.literal} / dynamic ${totals.dynamic}，${perFile.size} 个文件）→ ${abs}`)
  printByFile('按文件分布：', perFile)
}

function writeAllowlist (hits) {
  const body = renderBaseline(hits)
  const totals = totalsOf(summarize(hits))
  fs.writeFileSync(ALLOW_FILE, body) // nosemgrep（写回的是 --write-allowlist 生成的紧凑基线，路径为 __dirname 常量）
  console.log(`已写入紧凑基线 ${totals.all} 条（literal ${totals.literal} / dynamic ${totals.dynamic}，按文件计数）→ ${ALLOW_REL}`)
  printByFile('按文件分布：', summarize(hits))
}

function main () {
  const hits = scanAll()
  if (process.argv.includes('--write-allowlist')) {
    writeAllowlist(hits)
    return
  }
  if (process.argv.some((arg) => arg === '--inventory' || arg.startsWith('--inventory='))) {
    writeInventory(hits, inventoryTarget())
    return
  }
  const baseline = readBaseline(hits.length)
  const { violations, shortfalls, measured, measuredTotals } = compareByFile(hits, baseline)
  console.log(`源码文本断言：实测 ${measuredTotals.all} 条（literal ${measuredTotals.literal} / dynamic ${measuredTotals.dynamic}）` +
    ` / 基线 ${baseline.total.all} 条（literal ${baseline.total.literal} / dynamic ${baseline.total.dynamic}，` +
    `${Object.keys(baseline.by_file).length} 个文件，按文件计数 schema ${BASELINE_SCHEMA}）`)
  if (violations.length) {
    const extra = violations.reduce((sum, v) => sum + v.extra, 0)
    printByFile('超基线的文件（实测命中）：', new Map(violations.map((v) => [v.file, measured.get(v.file)])), true)
    console.error(`❌ 新增 ${extra} 处源码文本断言（按文件计数，禁止）：`)
    for (const v of violations) {
      const tag = v.isNewFile ? '（基线里没有这个文件）' : ''
      console.error(`  ${v.file}  基线 ${v.baseline} / 实测 ${v.measured} / +${v.extra}${tag}`)
    }
    printNewHitLines(hits, violations)
    console.error('改成行为断言 / AST 断言（test_support/source_model.js）/ 配置解析断言，见 AGENTS.md「断言形态」')
    process.exit(1)
  }
  printByFile('按文件分布（实测命中）：', measured, true)
  // literal 口径变化：条数没变但锚点从字面量变成 <dynamic>（或反之）。不判红——它不是「新增断言」，
  // 但会削弱「这个锚点能不能逐字核对」，所以明写出来，别让它静默发生。
  const drift = []
  for (const [file, entry] of sortedByFile(measured)) {
    const allowed = Object.prototype.hasOwnProperty.call(baseline.by_file, file) ? baseline.by_file[file] : null
    if (allowed && entry.all === allowed.all && entry.literal !== allowed.literal) drift.push([file, allowed.literal, entry.literal])
  }
  if (drift.length) {
    console.log('ℹ️ literal 口径变化（条数不变，不判红）：')
    drift.forEach(([file, before, now]) => console.log(`  ${file}  基线 literal ${before} / 实测 literal ${now}`))
  }
  if (shortfalls.length) {
    const missing = shortfalls.reduce((sum, s) => sum + s.missing, 0)
    console.log(`ℹ️ 实测比基线少 ${missing} 条（已有断言被替换/删除，按文件计数允许）：`)
    shortfalls.forEach((s) => console.log(`  ${s.file}  基线 ${s.baseline} / 实测 ${s.measured} / -${s.missing}`))
    console.log('   重跑 --write-allowlist 可把基线收紧到实测值（只减不增，收紧跟得上）。')
  }
  // fail-closed 兜底：total 与实测的差额必须由上面的逐文件增量/下降**完全**解释。算术上不可达
  // （所有文件都在并集里），留着是为了「基线/比对逻辑被改坏」时响亮而不是静默放行。
  const unexplained = (baseline.total.all - measuredTotals.all) -
    (shortfalls.reduce((sum, s) => sum + s.missing, 0) - violations.reduce((sum, v) => sum + v.extra, 0))
  if (unexplained !== 0) {
    die(2, `❌ 基线 total.all=${baseline.total.all} 与实测 ${measuredTotals.all} 的差额无法逐文件归因（残差 ${unexplained}）：` +
      '基线已不可信，重跑 --write-allowlist。')
  }
  console.log('✅ 未新增源码文本断言（按文件计数）')
}

module.exports = {
  analyzeSource,
  compareByFile,
  listScanFiles,
  literalValue,
  renderBaseline,
  summarize,
  kindOf,
  SOURCE_CALLS,
  DYNAMIC_ANCHOR,
  BASELINE_SCHEMA
}

if (require.main === module) main()
