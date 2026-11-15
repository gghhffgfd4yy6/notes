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
 *   - 扫描面：仓库根 `test_*.js` + `test_support/**\/*.js`。
 *
 * 白名单：`scripts/source-text-assert.allowlist.json`，**多重集语义**——按 (文件, 字面量) 计数比对，
 * 实测命中数 > 允许数即 exit 1 并点名；实测少于允许数只提示（说明有断言被替换掉，是好事）。
 * 顶层 `count` 必须等于 `items.length`，否则 exit 2（防手删条目不改计数，那会让闸门静默放宽）。
 * 白名单由 `node scripts/check-source-text-asserts.js --write-allowlist` 生成（改基线才用，正常不要跑）。
 *
 * 退出码：0 无新增 / 1 有新增（同一 (文件,字面量) 超出允许次数也算新增）/ 2 白名单形状非法或扫描失败。
 */
const fs = require('node:fs')
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
// 这些方法在源码文本数组上的回调形参是「一行源码」——回调第一形参跟着 receiver 一起污染。
const ELEMENT_CALLBACK_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findIndex', 'some', 'every', 'sort', 'reduce'])
// 返回值不再是「源码文本」的调用：JSON/YAML 解析成对象、path 拼路径、fs 列目录/取元数据。
// 不在这里截断，配置类断言（`JSON.parse(readFileSync(...))` 之后比字段）会被当成文本断言计进基线。
const SANITIZER_PATHS = new Set([
  'JSON.parse', 'JSON.stringify',
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

// 不带计算键的成员链：`fs.readFileSync` → 'fs.readFileSync'；`a['b']` 这类动态键返回 null（不猜）。
function memberPath (node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type !== 'MemberExpression' || node.computed) return null
  const object = memberPath(node.object)
  if (!object || node.property.type !== 'Identifier') return null
  return object + '.' + node.property.name
}

// 被调名的**尾段**：`readFileSync` / `fs.readFileSync` / `require('fs').readFileSync` 都归一成
// readFileSync。第三种形态的 object 是 CallExpression（memberPath 走不通），但语义上它仍是
// 「在某个 fs 对象上调 readFileSync」——按名字认即可（旧实现同样按名字认）。
function calleeTailName (callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name
  }
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
      // sourceCall：`const read = fs.readFileSync` 这类别名（初值是读取函数）。
      binding = { name, tainted: false, defs: [], fn: null, methods: null, instanceOf: null, sourceCall: false }
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
 * 分析一份源码，返回命中列表 `[{ file, line, literal }]`。
 *
 * 三轮：
 *   A. 遍历建作用域/绑定，把所有「表达式 → 绑定」的传播边记成原始 AST 节点（此时还不算污染，
 *      因为顺序在前面的引用可能指向后面才声明的绑定）；
 *   B. 用 idBinding（每个 Identifier → 它的 binding）把边解析成 {hasSource, deps}；
 *   C. 单调不动点：绑定只会 false → true，所以必然收敛；收敛后逐条判定候选命中的 receiver。
 */
function analyzeSource (code, file) {
  const ast = parseAst(code, file)
  const idBinding = new Map() // Identifier 节点 → binding
  const bindings = []
  const edges = [] // { target: Binding, expr: Node } —— target 污染当且仅当 expr 被污染
  const candidates = [] // { line, literal, receiverKind, node, fn }
  const rets = new Map() // function 节点 → 返回值伪绑定
  const paramBindings = new Map() // function 节点 → [{ binding }]

  const retBinding = (fn) => {
    let binding = rets.get(fn)
    if (!binding) {
      binding = { name: '(return)', tainted: false, defs: [], fn: null }
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
  //   `new R().read()`（类方法）、`R.prototype.read()`（原型方法）。
  const resolveCalleeFn = (callee, scope) => {
    if (!callee) return null
    if (callee.type === 'Identifier') {
      const binding = scope.lookup(callee.name)
      return binding && binding.fn ? binding.fn : null
    }
    if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return null
    const owner = callee.object
    let binding = null
    if (owner.type === 'Identifier') {
      binding = scope.lookup(owner.name)
    } else if (owner.type === 'NewExpression' && owner.callee.type === 'Identifier') {
      binding = scope.lookup(owner.callee.name)
    } else if (owner.type === 'MemberExpression' && !owner.computed && owner.property.type === 'Identifier' &&
      owner.property.name === 'prototype' && owner.object.type === 'Identifier') {
      binding = scope.lookup(owner.object.name)
    }
    return binding ? methodOf(binding, callee.property.name) : null
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
        const target = callTargets.get(node)
        if (target) out.deps.add(retBinding(target))
        collectDeps(callee, out)
        node.arguments.forEach((argument) => collectDeps(argument, out))
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

  const addCandidate = (node, receiverNode, literal, fn, method) => {
    // 锚点不可冻结时记 <dynamic>，**不跳过**：跳过等于给「把字面量提成常量」发通行证。
    const anchor = typeof literal === 'string' ? literal : DYNAMIC_ANCHOR
    candidates.push({ node, receiverNode, literal: anchor, fn, method, line: node.loc ? node.loc.start.line : 0 })
  }

  // 调用点记录（walk 结束后统一做绑定解析）：被调名 → 本地函数（对象方法 / 类方法 / 函数声明）。
  // 解析必须在 walk 之后：类体方法表在遍历到类声明时才建立，而 `const read = fs.readFileSync`
  // 这类别名的初值也要等 VariableDeclaration 走过。
  const callSites = [] // { node, callee, scope }
  const callTargets = new Map() // CallExpression 节点 → 返回源码文本的本地函数（或 null）
  // 调用点记录（walk 结束后统一解析成边）：实参→形参。
  const deferredArgEdges = [] // { fn, args }
  const deferredElementEdges = [] // { fn, receiver }

  const handleCall = (node, scope) => {
    callSites.push({ node, callee: node.callee, scope })
    const callee = node.callee
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
      const method = callee.property.name
      if (STRING_METHODS.has(method)) {
        // **不看实参形态**：receiver 是源码文本 + 这是字符串比对方法 ⇒ 命中（锚点能冻结就冻结，
        // 不能就记 <dynamic>）。`src.includes(NEEDLE)` / `line.includes(name)` 一律在册。
        addCandidate(node, callee.object, literalAnchor(node.arguments[0]), currentFn, method)
      } else if (method === 'test') {
        // `/re/.test(src)`：正则字面量在 receiver 侧、源码文本在实参侧。
        // 正则**不是**字面量（变量/形参/new RegExp）时锚点不可冻结，但被比对的仍是源码文本 ⇒ <dynamic>。
        const literal = isRegexLiteral(callee.object) ? literalValue(callee.object) : undefined
        addCandidate(node, node.arguments[0], literal, currentFn, 'regexp.test')
      }
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
    // `assert.match(<src>, <任意>)`：断言库形态的文本比对，与 `src.match(…)` 等价。
    // 第二参不是正则字面量（变量/形参）时同样记 <dynamic>——被测的仍是源码文本。
    const calleeName = memberPath(callee)
    if (calleeName === 'assert.match' && node.arguments.length >= 2) {
      addCandidate(node, node.arguments[0], literalAnchor(node.arguments[1]), currentFn, 'assert.match')
    }
  }

  const handleFunction = (node, scope) => {
    const outer = currentFn
    // 函数声明要先登记「这个名字是函数」：调用点靠 binding.fn 找形参，不登记就永远追不到
    // `function check(src) { src.includes(…) }` 这一跳。
    if (node.type === 'FunctionDeclaration' && node.id) scope.declare(node.id.name).fn = node
    const fnScope = new Scope(scope, true, bindings)
    if (node.type === 'FunctionExpression' && node.id) fnScope.declare(node.id.name)
    // 形参先声明（体里的引用要能解析到它们）
    const schema = node.params.map((param) => declarePattern(param, fnScope, 'param', []))
    paramBindings.set(node, schema)
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
  let changed = true
  while (changed) {
    changed = false
    for (const binding of bindings) {
      if (binding.tainted) continue
      for (const dep of binding.defs) {
        if (dep.hasSource || [...dep.deps].some((other) => other.tainted)) {
          binding.tainted = true
          changed = true
          break
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
  const isDelimiterLiteral = (literal) => !/[A-Za-z0-9\u4e00-\u9fff]/.test(literal)

  const hits = []
  for (const candidate of candidates) {
    if (candidate.fn && readers.has(candidate.fn) && isDelimiterLiteral(candidate.literal)) continue
    const deps = newDeps()
    collectDeps(candidate.receiverNode, deps)
    const tainted = deps.hasSource || [...deps.deps].some((binding) => binding.tainted)
    if (!tainted) continue
    hits.push({ file: candidate.file || '', line: candidate.line, literal: candidate.literal, method: candidate.method })
  }
  hits.forEach((hit) => { hit.file = file })
  hits.sort((a, b) => (a.line - b.line) || (a.literal < b.literal ? -1 : a.literal > b.literal ? 1 : 0))
  return hits
}

// ── 扫描面 ──────────────────────────────────────────────────────────────
function listScanFiles () {
  const rootTests = fs.readdirSync(ROOT, { withFileTypes: true }) // nosemgrep（路径 = ROOT（__dirname 常量）+ readdirSync 枚举出的 test_*.js / test_support 文件，无外部输入）
    .filter((entry) => entry.isFile() && /^test_.*\.js$/.test(entry.name))
    .map((entry) => entry.name)
  const support = []
  const walkDir = (relative) => {
    const abs = path.join(ROOT, relative)
    if (!fs.existsSync(abs)) return // nosemgrep（同上：abs 由 ROOT（__dirname 常量）+ 仓库内相对目录拼成）
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) { // nosemgrep（同上：只遍历仓库内的 test_support 目录）
      const rel = relative + '/' + entry.name
      if (entry.isDirectory()) walkDir(rel)
      else if (entry.isFile() && entry.name.endsWith('.js')) support.push(rel)
    }
  }
  walkDir('test_support')
  return [...rootTests, ...support].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function scanAll () {
  const hits = []
  for (const file of listScanFiles()) {
    let code
    try {
      code = fs.readFileSync(path.join(ROOT, file), 'utf8') // nosemgrep（file 只来自本文件的扫描面枚举（仓库根 test_*.js / test_support），不来自环境或入参）
    } catch (e) {
      die(2, '扫描失败 ' + file + ': ' + e.message)
    }
    try {
      hits.push(...analyzeSource(code, file))
    } catch (e) {
      die(2, '扫描失败 ' + file + ': ' + e.message)
    }
  }
  return hits
}

function die (code, message) {
  console.error(message)
  process.exit(code)
}

// ── 白名单（多重集） ────────────────────────────────────────────────────
const keyOf = (item) => item.file + '\u0000' + item.literal

function byFile (items) {
  const counts = new Map()
  for (const item of items) counts.set(item.file, (counts.get(item.file) || 0) + 1)
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

function printByFile (title, items) {
  console.log(title)
  const rows = byFile(items)
  if (!rows.length) {
    console.log('  （无）')
    return
  }
  rows.forEach(([file, count]) => console.log(`  ${file} ${count}`))
}

function assertAllowlistShape (raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    die(2, `❌ 白名单形状非法（${ALLOW_REL}）：缺少 items 数组`)
  }
  if (!Number.isInteger(raw.count)) {
    die(2, `❌ 白名单形状非法（${ALLOW_REL}）：count 必须是整数，实得 ${JSON.stringify(raw.count)}`)
  }
  // count 与 items.length 不一致说明有人手删/手改条目而没同步计数——此时闸门口径已不可信，
  // 既不按 count 也不按 items 放行，直接 exit 2（fail-closed）。
  if (raw.count !== raw.items.length) {
    die(2, `❌ 白名单计数漂移（${ALLOW_REL}）：count=${raw.count}，items.length=${raw.items.length}。` +
      '删条目必须同时改 count（或重跑 --write-allowlist）。')
  }
  raw.items.forEach((item, i) => {
    if (!item || typeof item.file !== 'string' || typeof item.literal !== 'string') {
      die(2, `❌ 白名单第 ${i + 1} 条形状非法（${ALLOW_REL}）：需要 {file, literal} 两个字符串字段`)
    }
  })
  return raw
}

function readAllowlist () {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) // nosemgrep（ALLOW_FILE = __dirname 常量 + 固定文件名，白名单就在脚本旁边）
  } catch (e) {
    die(2, `❌ 白名单不可读或不是合法 JSON（${ALLOW_REL}）：${e.message}`)
  }
  return assertAllowlistShape(raw)
}

// 多重集比对：逐 (文件,字面量) 数次数。同一字面量在同一个文件里出现两次、白名单只冻结一次
// ⇒ 多出来的那一次就是**新增**（旧实现用 Set 比对，重复出现一律放行）。
function compareMultiset (hits, allow) {
  const allowedCount = new Map()
  for (const item of allow.items) allowedCount.set(keyOf(item), (allowedCount.get(keyOf(item)) || 0) + 1)
  const measured = new Map() // key → { file, literal, lines: [], count }
  for (const hit of hits) {
    const key = keyOf(hit)
    let entry = measured.get(key)
    if (!entry) {
      entry = { file: hit.file, literal: hit.literal, lines: [], count: 0 }
      measured.set(key, entry)
    }
    entry.count++
    entry.lines.push(hit.line)
  }
  const violations = []
  const shortfalls = []
  for (const [key, entry] of measured) {
    const allowed = allowedCount.get(key) || 0
    if (entry.count > allowed) violations.push({ ...entry, allowed, extra: entry.count - allowed })
    else if (entry.count < allowed) shortfalls.push({ ...entry, allowed, missing: allowed - entry.count })
  }
  for (const [key, allowed] of allowedCount) {
    if (measured.has(key)) continue
    const sample = allow.items.find((item) => keyOf(item) === key)
    shortfalls.push({ file: sample.file, literal: sample.literal, lines: [], count: 0, allowed, missing: allowed })
  }
  return { violations, shortfalls, allowTotal: allow.items.length }
}

function writeAllowlist (hits) {
  const body = JSON.stringify({
    note: '冻结清单（多重集：同一 (文件,字面量) 出现 N 次就记 N 条）：只减不增。新增源码文本断言一律红（scripts/check-source-text-asserts.js）。' +
      'literal 是能从 AST 冻结的锚点（字符串字面量 / 无插值模板 / 正则字面量，正则记成 /src/flags）；' +
      '<dynamic> = receiver 确实绑定到源码文本、但锚点无法静态冻结（变量 / 常量表 / helper 形参 / 非正则字面量的 X.test(...)），' +
      '它同样是「读源码文本」的证据，因此同样计入基数——把字面量提成常量不得让整条断言从检测面上消失。',
    count: hits.length,
    items: hits.map((hit) => ({ file: hit.file, line: hit.line, literal: hit.literal }))
  }, null, 2) + '\n'
  fs.writeFileSync(ALLOW_FILE, body) // nosemgrep（同上一行：写回的是 --write-allowlist 生成的白名单，路径为 __dirname 常量）
  console.log(`已写入白名单 ${hits.length} 条 → ${ALLOW_REL}`)
  printByFile('按文件分布：', hits)
}

function main () {
  const hits = scanAll()
  if (process.argv.includes('--write-allowlist')) {
    writeAllowlist(hits)
    return
  }
  const allow = readAllowlist()
  const { violations, shortfalls, allowTotal } = compareMultiset(hits, allow)
  console.log(`源码文本断言：实测 ${hits.length} 条 / 白名单冻结 ${allowTotal} 条（多重集按 (文件,字面量) 计数）`)
  if (violations.length) {
    const extra = violations.reduce((sum, v) => sum + v.extra, 0)
    printByFile('白名单外命中（按文件，含超出次数的部分）：', violations.flatMap((v) =>
      Array.from({ length: v.extra }, () => ({ file: v.file, literal: v.literal }))))
    console.error(`❌ 新增 ${extra} 处源码文本断言（禁止）：`)
    violations.slice(0, 40).forEach((v) => {
      console.error(`  ${v.file}:${v.lines.join(',')}  ${JSON.stringify(v.literal).slice(0, 80)}  实测 ${v.count} 次 / 允许 ${v.allowed} 次`)
    })
    if (violations.length > 40) console.error(`  …还有 ${violations.length - 40} 组未列出`)
    console.error('改成行为断言 / AST 断言（test_support/source_model.js）/ 配置解析断言，见 AGENTS.md「断言形态」')
    process.exit(1)
  }
  printByFile('按文件分布（实测命中）：', hits)
  if (shortfalls.length) {
    const missing = shortfalls.reduce((sum, s) => sum + s.missing, 0)
    console.log(`ℹ️ 实测比白名单少 ${missing} 条（已有断言被替换/删除，或同一字面量出现次数减少）——` +
      '这是好事，可删掉多余条目并同步 count。')
    shortfalls.slice(0, 20).forEach((s) => console.log(`  ${s.file}  ${JSON.stringify(s.literal).slice(0, 60)}  实测 ${s.count} / 允许 ${s.allowed}`))
  }
  console.log('✅ 未新增源码文本断言')
}

module.exports = { analyzeSource, compareMultiset, listScanFiles, literalValue, SOURCE_CALLS }

if (require.main === module) main()
