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
 * .js/.cjs/.mjs。scripts/ 与生产 .js 不在扫描面：那是被测系统，把「读缓存/日志后做字符串判定」冻进
 * 基线会让任何生产改动都误红，也与「测试断言」这个口径不是一回事。
 *
 * 检测面（5 种形状，形状 = 源码文本怎么走到比对点）：
 *   ① 直接：`assert.ok(src.includes('字面量'))`——receiver 由 `readFileSync`/`codeOf`/… 得到
 *      （行内直读，或 `const src = fs.readFileSync(…)` 后再比），锚点是可冻结字面量；
 *   ② 变量实参 / 运算符：`src.includes(anchorVar)`（锚点提成常量）、`src === '…'`、
 *      `assert.strictEqual(src, '…')` 与 equal 家族——同一件事的三种写法。**含解构形态**：
 *      `const { strictEqual } = require('node:assert/strict')` 后的 `strictEqual(src, '…')`
 *      与重命名 `const { strictEqual: eq } = …` 后的 `eq(src, '…')`（本仓已有这种写法）；
 *   ③ 模板插值：`` src.includes(`a${x}b`) ``——锚点不可冻结，同样计入；
 *   ④ reader 别名：`const readSrc = () => fs.readFileSync(…)` 之后 `readSrc(f).includes('…')`，
 *      以及 `const { readFileSync: read } = require('fs')`、`const read = fs.readFileSync`、
 *      `const read = require('node:fs').readFileSync` 这类简单别名（成员赋值与裸标识符等价）；
 *   ⑤ helper 源码（返回 / 形参两条路）：本地函数 `function codeOf (f) { return fs.readFileSync(f, 'utf8') }`
 *      的调用点 `codeOf(f).includes('…')`（返回值被判定为源码文本即可，**不看函数名**）；
 *      同一机制也覆盖链式 reader `FILES.map((f) => { const t = readFileSync(f); return t }).join('\n')`
 *      （map/filter/flatMap 的回调返回源码文本 ⇒ 整条链是源码文本），以及**同文件 helper 的形参**：
 *      `const checkYml = (t) => { assert.ok(t.includes('X')) }` 之后 `checkYml(src)`——形参在调用点
 *      收到源码文本，函数体里的比对点按其调用点入账（形参名不参与判定，看的是实参的数据流）。
 *   异步读取整条链同样在检测面内：`const s = await fs.promises.readFile(f, 'utf8')` 后 `s.includes('…')`
 *   （AwaitExpression / ChainExpression 往下追一层），以及回调式
 *   `fs.readFile(f, 'utf8', (e, data) => assert.ok(data.includes('…')))`（readFile 的回调签名是
 *   (err, data)，末位形参登记为源码文本）。
 *   `loadModel(f).code`（及其等价 `model.code`、`const { code } = loadModel(f)`）**计入**：
 *   `model.code` 就是读进来的源码原文（`codeOnly` 只去注释），与 `parseShell(...).tokens` 这类
 *   解析产物性质不同——否则把 `src.includes` 改写成容器字段就能让白名单合法归零。
 *   比对 API 仍是同一族：includes/startsWith/endsWith/indexOf/lastIndexOf/search/match/matchAll、
 *   `/re/.test(src)`、`assert.match/doesNotMatch(src, …)`、`==/===/!=/!==` 与 assert 等值比较族。
 *   量纲断言（`.length` / `typeof`）不计；`JSON.parse` / `acorn.parse` / `yaml.load` 之后是结构化
 *   数据，不计（RUNBOOK 第 ② 式正是要它们）。
 *   读的是**哪个文件**不区分（生产源码 / 测试夹具 / 临时文件一律算）：静态上无法可靠区分路径，宁可多算
 *   ——本闸拦的是「读文本 + 逐字比对」这个形态本身，不是「路径是否指向生产代码」。代价是基线里混入了
 *   夹具内容断言（如 test_storage.js 的临时文件比对），故计划口径 857 与本基线**不可换算**，见文末。
 *
 * 计数单位：**源码文本比对点**（不是「断言行」）。一行里两处 `includes` 记 2 条；切片用的
 * `comp.slice(comp.indexOf('开始'), comp.indexOf('结束'))` 也记 2 条（那里并没有断言）。多算的方向是安全的。
 *
 * 基线（schema 3）：`scripts/source-text-assert.allowlist.json` 只冻结
 *   `{ "schema": 3, "total": N, "by_file": { "test_console.js": 1763, … } }`
 * ——「每个测试文件还剩多少条断言要改」。锚点/行号只是**内部定位信息**，命中时用于打印行，不进基线。
 * 判据：某文件实测条数 > 基线 → exit 1 并点名「文件 / 基线 / 实测 / 增量」；基线里没有的文件实测
 * 有条目 → exit 1（新文件按 0 算）；条数下降允许（按文件报 shortfall，供每个包对账）。
 * `total` 必须等于 `by_file` 各值之和，否则 exit 2（手改一个数字而不改另一个，是唯一能静默放宽
 * 基线的写法，必须在读入时就拒掉）。
 *
 * 已知取舍：按文件计数看不到同一文件内两条断言互换（N 条换 N 条仍绿）；锚点质量靠评审看 diff。
 *
 * 基线**只减不增**是机械校验的，不靠评审自觉：
 *   · 写盘侧：任何 total / 单文件增长都被拒绝写盘，除非显式 `--allow-growth --reason "…"`
 *     ——理由必填，并写进基线的 `growth` 段（钉参照提交 sha + 逐文件增量）与 CI 日志。
 *   · 运行侧：`verifyGrowthAgainstReference` 把**当前基线**与 git 参照版本逐文件 + total 比一遍，
 *     手改 JSON 把 by_file 与 total 等量抬高会在这里 exit 1。参照 = `--baseline-ref` /
 *     `SOURCE_TEXT_ASSERT_BASELINE_REF`（显式给出时是**唯一**候选）→ origin/main → origin/master → main
 *     → master；**HEAD 永不作参照**——它就是被判定的提交本身，基线自比自会恒打印「✓ 未增长」，
 *     手改 by_file 与 total 等量抬高在 CI 形态（detached 单提交、没有 base 引用）下就完全不拦。
 *     候选解析出来的提交若**恰好就是 HEAD**（本地在 main 上、CI push 到 main），改用它**之前的提交**
 *     （`<ref>^`）这条真实 base 引用；取不到父提交（根提交 / 浅克隆）时按「参照不可得」处理。
 *   · 参照不可得（无 git / 候选都解析不出 / 参照树里没有基线文件 / 候选就是 HEAD 且无父提交）时：
 *     **CI（`CI=true/1/…`）fail-closed exit 2**；非 CI 打印「无法核对增长」后按 on-disk 基线继续，
 *     **绝不打印 ✓**（「读不到」不得读成「没有增长」）。显式给出的参照不可用一律 exit 2（本机也不降级）；
 *     `--allow-growth` 是唯一的人工放行路径，且输出里同样不出现 ✓。
 *     **唯一例外 = 可证明的「首次引入基线」**（`firstBaselineBootstrap`）：参照树里没有这份文件**且**
 *     `git diff --diff-filter=A <参照> HEAD` 证明是**本变更新增**了它**且** on-disk 基线逐文件与实测
 *     **完全一致**（不留预授权额度）⇒ 打印「无法核对增长（首次引入）」并放行（CI 亦然，仍不打印 ✓）。
 *     少了任何一条即回到 fail-closed——这条例外的窗口只有「基线文件本身还没进 base 分支」那一次，
 *     基线进 main 之后所有 PR / push 都走正常参照核对。
 *   · 读基线只走一次 `readFileSync`（缺文件 = ENOENT ⇒ 没有旧基线），写盘走「同目录临时文件 + rename
 *     原子替换」：先 `existsSync` 探测再读/写同一路径是 check-then-use（CodeQL js/file-system-race /
 *     TOCTOU），不得回退成探测式。代价是一处已登记的行为变化：`chmod 444` 的基线旧实现 EACCES
 *     exit 1 拒绝写，新实现 rename 只要求目录可写 ⇒ 覆盖并改回 644（见 CHANGELOG v3.465）。
 *   · `--write-allowlist` 是唯一的重生成路径，因此**必须**能修好读不出的旧基线：schema≠3 / 半截 JSON /
 *     形状不对时按「没有旧基线」重生成并打印降级原因（旧实现这两条都 exit 2 ⇒ 重生成路径自锁）。
 *     门禁路径保持严格：读不出即 exit 2，绝不「读不出就写」。
 *
 * ⚠️ known-uncovered（本闸**不**覆盖，不得误以为已守）——逐条给反例：
 *   1. `.call/.apply/.bind` 改 receiver：`fs.readFileSync.call(null, f).includes('X')`、
 *      `readFileSync.bind(null)(f).includes('X')`——被调名不是尾名为读取函数的成员调用，记 0 条。
 *   2. 计算成员取值：`fs['readFileSync'](f).includes('X')`、`obj[key].includes('X')`——只认非计算成员。
 *   3. 跨文件 helper：`const { readSrc } = require('./test_support/helpers')` 后
 *      `readSrc(f).includes('X')`——只在**本文件**建 helper/形参表，跨 require 边界不传播。
 *   4. 嵌套导出对象 / 类方法：`module.exports = { util: { read: (f) => readFileSync(f) } }` 的
 *      `h.util.read(f).includes('X')`；`new Reader().text(f).includes('X')`——两者都不入账。
 *   5. 字符串化后再比：`JSON.stringify(src).includes('X')`——`JSON.stringify` 被当作产出非文本，
 *      `JSON.parse(src)` 之后的字段比对同理（后者是本批的目标形态，故意放行）。
 *   6. 解析成 token/结构后再比：`parseShell(f).tokens[0] === 'run_gate'`——容器字段是解析产物，
 *      不算源码文本（`loadModel(f).code` 例外：它就是原文，已计入，见上）。
 *   7. split 之后按下标取值：`src.split('\n')[3] === 'x'`——下标成员表达式没有 receiver 绑定，
 *      不入账（`src.split('\n').includes('x')` 这类整体比对仍计入）。
 *   8. 解构形参 / 传给二期函数：`function f ({ text }) { … }`、`const g = (t) => h(t)` 里 h 定义在
 *      另一文件——形参传播只认本文件里、形参是裸标识符、且调用点实参已判定为源码文本的情形
 *      （两级链最多一次回溯；更深的传递只按已见的一级入账）。
 *   9. 非 .js 测试夹具 / 运行时拼出来的文件名：扫描面按目录与扩展名枚举，运行期生成的测试文件不入账。
 *
 * 与 plan 的 857 的差额（不编数，逐项如实）：857 是 v3.442 起草时那版**文件级正则**的实测值
 * （变量名按整文件认，只认 includes/indexOf/startsWith/match），本口径是作用域感知的 AST 判定且含
 * strictEqual 族 / 比较运算符 / 正则 test / helper 与别名。两把尺子逐文件差额见 CHANGELOG：v3.465 把
 * 链式 reader（map/filter/flatMap）与同文件 helper 形参接进检测面后，test_console.js 从 374 涨到
 * 真实值（旧口径把 fixture/lock/日志的 .includes 也算进同名变量），**这不是债变多，是尺子变准**。
 *
 * 退出码：0 无新增 / 1 有新增（某文件超基线、新文件、或基线相对参照被抬高）/
 *         2 基线读不出、基线自相矛盾、扫描失败、参照不可得（CI 或显式给出）或用法错误。
 *
 * 用法：
 *   node scripts/check-source-text-asserts.js                    # 门禁（exit 0/1/2）
 *   node scripts/check-source-text-asserts.js --baseline-ref origin/main
 *   node scripts/check-source-text-asserts.js --write-allowlist  # 重生成基线（增长须 --allow-growth --reason）
 *     环境变量：SOURCE_TEXT_ASSERT_BASELINE_REF（同 --baseline-ref；CI 应传 PR base sha）
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const ALLOW_FILE = path.join(__dirname, 'source-text-assert.allowlist.json')
const ALLOW_REL = path.relative(ROOT, ALLOW_FILE).split(path.sep).join('/')
const SCHEMA = 3
const BASELINE_REF_ENV = 'SOURCE_TEXT_ASSERT_BASELINE_REF'

// 「源码文本」的产出点：读取仓内文件 / 剥注释。
const SOURCE_CALLS = new Set(['readFileSync', 'readFile', 'codeOf', 'codeOnly', 'stripComments', 'stripComment'])
// 解析源码文本得到的视图对象：`loadModel(f).code` 就是读进来的原文（codeOnly 只去注释），必须计入。
const MODEL_CALLS = new Set(['loadModel'])
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
  'split', 'join', 'toLowerCase', 'toUpperCase', 'concat', 'toString',
  // 逐元素映射/筛选：结果类型由回调返回值决定，不是由 receiver 决定（见 isSource 里的回调判定）。
  'map', 'filter', 'flatMap'
])
// 元素级链式方法：`FILES.map((f) => readFileSync(f, 'utf8'))` 的源码文本性来自回调的返回值。
const ARRAY_CHAIN_METHODS = new Set(['map', 'filter', 'flatMap'])
// 不可冻结的锚点（变量 / 表 / 带插值模板 / 动态 RegExp）。它必须**计入**：把字面量提成常量
// 不得让整条断言从检测面上消失（否则是一条零成本绕过路径）。
const DYNAMIC = '<dynamic>'
const SHAPE_LABEL = {
  1: '①直接字面量',
  2: '②变量锚点/比较',
  3: '③模板插值',
  4: '④reader 别名',
  5: '⑤helper 源码/形参'
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

const isModelCall = (node) => !!node && node.type === 'CallExpression' && !node.callee.computed &&
  MODEL_CALLS.has(calleeTail(node.callee))

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
 * scope = { parent,
 *           vars:<名字→是源码文本>, helpers:<名字→返回源码文本的函数>, readers:<名字→读取函数别名>,
 *           equalities:<名字→等值断言函数别名>, models:<名字→loadModel 视图>, paramSources:<名字→由实参传入源码文本的形参>,
 *           funcs:<名字→函数节点（供调用点污染）> }
 */
function analyzeFile (code, file) {
  const ast = parseAst(code, file)
  const hits = []
  // 同文件 helper 的形参污染：fnNode → 在调用点收到「源码文本」实参的形参名集合。
  // 为什么要跨遍收集：调用点可能在函数声明之前（提升），一遍走完才知道全部实参。
  const sourceParams = new Map()
  let recording = false
  const newScope = (parent) => ({
    parent,
    vars: new Set(),
    helpers: new Set(),
    readers: new Set(),
    equalities: new Set(),
    models: new Set(),
    paramSources: new Set(),
    funcs: new Map()
  })
  const inScope = (scope, kind, name) => {
    for (let s = scope; s; s = s.parent) if (s[kind].has(name)) return true
    return false
  }
  const resolveFunc = (scope, name) => {
    for (let s = scope; s; s = s.parent) if (s.funcs.has(name)) return s.funcs.get(name)
    return null
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
      // await 只是把 promise 拆包：`const s = await fs.promises.readFile(…)` 之后 s 仍是源码文本。
      // 缺这一条会让整条异步读取链在 AwaitExpression 处断流（实测 0 命中、exit 0）。
      case 'AwaitExpression':
        return isSource(node.argument, scope)
      case 'ChainExpression':
        return isSource(node.expression, scope)
      case 'MemberExpression':
        // `loadModel(f).code` / `model.code`：code 字段就是读进来的原文（不是解析产物），
        // 计入才能堵住「把 includes 改写成容器字段 ⇒ 白名单合法下降」这条路。
        if (!node.computed && node.property.type === 'Identifier' && node.property.name === 'code') {
          return isModelCall(node.object) || (node.object.type === 'Identifier' && inScope(scope, 'models', node.object.name))
        }
        return false
      case 'CallExpression': {
        const callee = node.callee
        const tail = calleeTail(callee)
        if (callee.type === 'Identifier') {
          if (inScope(scope, 'helpers', callee.name) || inScope(scope, 'readers', callee.name)) return true
        }
        if (tail && !callee.computed) {
          // `fs.readFileSync` / 解构后的 `readFileSync` 都按尾名认。
          if (SOURCE_CALLS.has(tail)) return true
          if (callee.type === 'MemberExpression' && CHAIN_METHODS.has(tail)) {
            if (isSource(callee.object, scope)) return true
            // map/filter/flatMap 的结果由回调返回值决定：`FILES.map((f) => { const t = readFileSync(f); return t })`
            // 是本仓最广的 reader 形态（test_console.js 的 readConsoleSource），只看 receiver 会漏掉整条链。
            if (ARRAY_CHAIN_METHODS.has(tail)) {
              const cb = node.arguments.find((arg) => isFunction(arg))
              if (cb && returnsSource(cb, scope)) return true
            }
          }
        }
        return false
      }
      default:
        return false
    }
  }

  // 函数体内的局部源码变量：`const text = fs.readFileSync(…)`、`const b = a`。
  // 供 returnsSource 判定 `return text`——只看形参/外层作用域会把本仓最多的
  // `FILES.map((f) => { const text = readFileSync(f); return text })` 判成非源码文本。
  // 两轮迭代：第一轮抓直接读取，第二轮抓「由已判定的局部变量再赋值」。
  function localSourceScope (fn, scope) {
    const names = new Set()
    const build = () => ({
      parent: scope,
      vars: names,
      helpers: new Set(),
      readers: new Set(),
      equalities: new Set(),
      models: new Set(),
      paramSources: new Set(),
      funcs: new Map()
    })
    for (let round = 0; round < 2; round++) {
      const walkBody = (node) => {
        if (!node || typeof node.type !== 'string') return
        // 不进入嵌套函数：那里的局部变量不属于本函数的返回值。
        if (node !== fn && isFunction(node)) return
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && isSource(node.init, build())) {
          names.add(node.id.name)
        }
        if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && isSource(node.right, build())) {
          names.add(node.left.name)
        }
        for (const key of Object.keys(node)) {
          if (key === 'loc' || key === 'start' || key === 'end') continue
          const value = node[key]
          if (Array.isArray(value)) value.forEach(walkBody)
          else if (value && typeof value.type === 'string') walkBody(value)
        }
      }
      if (fn.body.type === 'BlockStatement') fn.body.body.forEach(walkBody)
      else walkBody(fn.body)
    }
    return build()
  }

  // 「本文件定义的、返回源码文本的函数」：看函数体里有没有 `return <源码文本>`（不进入嵌套函数）。
  function returnsSource (fn, scope) {
    const local = localSourceScope(fn, scope)
    // 表达式体箭头（`() => fs.readFileSync(…)`）没有 ReturnStatement，直接看返回表达式。
    if (fn.body.type !== 'BlockStatement') return isSource(fn.body, local)
    let found = false
    const scan = (node) => {
      if (found || !node || typeof node.type !== 'string') return
      if (node !== fn && isFunction(node)) return
      if (node.type === 'ReturnStatement' && isSource(node.argument, local)) {
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
    if (name && receiver.type === 'Identifier' && inScope(scope, 'paramSources', name)) return 5
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
    const member = callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
    const name = member ? callee.property.name : null
    // ① / ④ / ⑤：receiver 上直接做字符串比对。
    if (member && STRING_METHODS.has(name) && isSource(callee.object, scope)) {
      const arg = node.arguments[0]
      return { anchor: anchorOf(arg), shape: shapeOf(arg, callee.object, scope) }
    }
    // 正则 test：`/re/.test(src)`（receiver 是正则、实参才是源码文本）。
    if (member && name === 'test' && callee.object.type === 'Literal' && callee.object.regex &&
      node.arguments.some((a) => isSource(a, scope))) {
      return { anchor: anchorOf(callee.object), shape: 1 }
    }
    // assert.match / assert.doesNotMatch：与 includes 同口径。
    if (member && (name === 'match' || name === 'doesNotMatch') && node.arguments[0] && isSource(node.arguments[0], scope)) {
      const arg = node.arguments[1]
      return { anchor: anchorOf(arg), shape: shapeOf(arg, null, scope) }
    }
    // ②：assert 等值比较族的「源码文本 vs 字面量」。成员形态（`assert.strictEqual`）**与**
    // 解构/裸标识符形态（`const { strictEqual } = require('node:assert/strict')` 后 `strictEqual(src, '…')`；
    // 重命名 `eq` 由 ObjectPattern 登记在 scope.equalities）——只认成员调用会让本仓已有的写法对闸门不可见。
    const equality = member
      ? EQUALITY_CALLS.has(name)
      : callee.type === 'Identifier' && (EQUALITY_CALLS.has(callee.name) || inScope(scope, 'equalities', callee.name))
    if (equality && node.arguments.length >= 2) {
      const a = isSource(node.arguments[0], scope)
      const b = isSource(node.arguments[1], scope)
      if (a === b) return null
      if (a && isNonText(node.arguments[1])) return null
      const anchorNode = a ? node.arguments[1] : node.arguments[0]
      return { anchor: anchorOf(anchorNode), shape: shapeOf(anchorNode, null, scope) }
    }
    return null
  }

  // 回调式读取：`fs.readFile(f, 'utf8', (e, data) => { assert.ok(data.includes('X')) })` 的数据在
  // 回调形参上——readFile 的签名是 (err, data)，把末位形参登记为源码文本再走函数体，否则异步读取
  // 整条链在回调边界断流（await 侧由 isSource 的 AwaitExpression 分支处理）。
  function sourceCallback (node) {
    if (node.type !== 'CallExpression' || node.callee.computed) return null
    const tail = calleeTail(node.callee)
    if (!tail || !SOURCE_CALLS.has(tail)) return null
    const cb = node.arguments.find((arg) => isFunction(arg))
    if (!cb || cb.params.length < 2) return null
    const data = cb.params[cb.params.length - 1]
    return data.type === 'Identifier' ? { cb, data } : null
  }

  function visitFunction (fn, scope) {
    const inner = newScope(scope)
    // 函数声明提升到声明它的那个作用域（供调用点污染与 helper 判定用）。
    if (fn.id && fn.type === 'FunctionDeclaration') scope.funcs.set(fn.id.name, fn)
    if (fn.id && fn.type === 'FunctionDeclaration' && returnsSource(fn, scope)) scope.helpers.add(fn.id.name)
    // 形参污染：调用点已证明某个形参收到源码文本 ⇒ 在函数作用域里把该形参登记为源码文本
    // （`const checkYml = (t) => t.includes('X')` 再 `checkYml(src)` 必须入账）。
    const seeded = sourceParams.get(fn)
    if (seeded) {
      for (const param of fn.params) {
        if (param.type === 'Identifier' && seeded.has(param.name)) {
          inner.vars.add(param.name)
          inner.paramSources.add(param.name)
        }
      }
    }
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
    if (hit && recording) hits.push({ file, line: node.loc.start.line, anchor: hit.anchor, shape: hit.shape })

    const callback = sourceCallback(node)
    if (callback) {
      node.arguments.forEach((arg) => { if (arg !== callback.cb) visit(arg, scope) })
      const inner = newScope(scope)
      inner.vars.add(callback.data.name)
      inner.paramSources.add(callback.data.name)
      if (callback.cb.body.type === 'BlockStatement') callback.cb.body.body.forEach((stmt) => visit(stmt, inner))
      else visit(callback.cb.body, inner)
      return
    }

    // 调用点污染：`checkYml(src)` 把 src 的「是源码文本」这一事实传给形参 ⇒ 记进 sourceParams，
    // 下一遍遍历时由 visitFunction 种入函数作用域。
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      const fn = resolveFunc(scope, node.callee.name)
      if (fn && fn.params.length) {
        node.arguments.forEach((arg, index) => {
          const param = fn.params[index]
          if (!param || param.type !== 'Identifier' || !isSource(arg, scope)) return
          if (!sourceParams.has(fn)) sourceParams.set(fn, new Set())
          sourceParams.get(fn).add(param.name)
        })
      }
    }

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
        if (id.type === 'Identifier') scope.funcs.set(id.name, init)
        visitFunction(init, scope)
        return
      }
      visit(init, scope)
      if (id.type === 'Identifier') {
        if (isSource(init, scope)) scope.vars.add(id.name)
        else if (isModelCall(init)) scope.models.add(id.name)
        else if (init.type === 'Identifier' && SOURCE_CALLS.has(init.name)) scope.readers.add(id.name)
        // `const read = fs.readFileSync` / `const read = require('node:fs').readFileSync`：
        // 成员赋值与裸标识符是同一件事，只登记后者会让照文件头写的人 0 命中。
        else if (init.type === 'MemberExpression' && !init.computed && init.property.type === 'Identifier' &&
          SOURCE_CALLS.has(init.property.name)) scope.readers.add(id.name)
      } else if (id.type === 'ObjectPattern') {
        // `const { readFileSync: read } = require('fs')`：简单解构重命名 → reader 别名；
        // `const { strictEqual: eq } = require('node:assert/strict')` → 等值断言别名；
        // `const { code } = loadModel(f)` → code 就是源码原文。
        for (const prop of id.properties) {
          const from = prop.key && (prop.key.name || prop.key.value)
          const to = prop.value && prop.value.type === 'Identifier' ? prop.value.name : from
          if (!to) continue
          if (SOURCE_CALLS.has(from)) scope.readers.add(to)
          if (EQUALITY_CALLS.has(from)) scope.equalities.add(to)
          if (isModelCall(init) && from === 'code') scope.vars.add(to)
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

  // 三遍：① 收集调用点污染；② 带上①的种子再收集一遍（helper 链两级）；③ 记录命中。
  // 前两遍不记录，只为让「形参收到源码文本」这个事实先于记录成立（调用点可能在定义之前）。
  for (let pass = 0; pass < 2; pass++) {
    const scope = newScope(null)
    ast.body.forEach((stmt) => visit(stmt, scope))
  }
  recording = true
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

// 基线文本 → { baseline } | { reason }。schema / 形状 / 自洽三类问题都给出**可读的原因**：
// 门禁路径据此 exit 2，重生成路径据此降级成「没有旧基线」（原因照样打印，不静默）。
function parseBaselineText (text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { reason: `基线读不了 ${ALLOW_REL}：${e.message}` }
  }
  if (!raw || raw.schema !== SCHEMA) return { reason: `基线 schema 必须是 ${SCHEMA}（实得 ${JSON.stringify(raw && raw.schema)}）——旧形状请用 --write-allowlist 重生成` }
  if (!isCount(raw.total) || !raw.by_file || typeof raw.by_file !== 'object' || Array.isArray(raw.by_file)) {
    return { reason: '基线必须有整数的 total 与对象的 by_file' }
  }
  let sum = 0
  for (const [file, count] of Object.entries(raw.by_file)) {
    if (!isCount(count)) return { reason: `基线 by_file["${file}"] 不是非负整数：${JSON.stringify(count)}` }
    sum += count
  }
  if (sum !== raw.total) return { reason: `基线自相矛盾：total=${raw.total}，by_file 各值之和=${sum}——两者必须相等（只改一个数字等于放宽基线）` }
  return { baseline: raw }
}

function readBaselineOrNull () {
  let text
  try {
    // ALLOW_FILE = __dirname 常量；只读一次，缺文件由 ENOENT 表达（不做 existsSync 探测）
    // eslint-disable-next-line
    text = fs.readFileSync(ALLOW_FILE, 'utf8') // nosemgrep（ALLOW_FILE = __dirname 常量）
  } catch (e) {
    // 文件不存在不是错误（首次生成基线）：ENOENT 就是「没有旧基线」这一事实本身。
    // 先 fs.existsSync 再读/写同一路径是 check-then-use（CodeQL js/file-system-race），故不再探测。
    if (e.code === 'ENOENT') return null
    die(2, `基线读不了 ${ALLOW_REL}：${e.message}`)
  }
  const parsed = parseBaselineText(text)
  if (parsed.reason) die(2, parsed.reason)
  return parsed.baseline
}

// 门禁路径必须真有基线：不存在即 exit 2（旧实现由 readFileSync 的 ENOENT 走到同一退出码）。
function readBaseline () {
  const baseline = readBaselineOrNull()
  if (!baseline) die(2, `基线不存在 ${ALLOW_REL}：请先运行 --write-allowlist 生成`)
  return baseline
}

// 重生成路径的宽容读取：`--write-allowlist` 是基线的**唯一**重生成方式，它必须能修好「读不出来」的基线
// （旧 schema / 半截 JSON / 形状不对）。这两类文件按「没有旧基线」处理并把降级原因打出来；
// 门禁路径仍走 readBaselineOrNull 的严格判定（exit 2），否则「读不出就写」等于静默放宽。
function readBaselineForRewrite () {
  let text
  try {
    // ALLOW_FILE = __dirname 常量；重生成路径同样只读一次
    // eslint-disable-next-line
    text = fs.readFileSync(ALLOW_FILE, 'utf8') // nosemgrep（ALLOW_FILE = __dirname 常量）
  } catch (e) {
    if (e.code === 'ENOENT') return { previous: null, reason: null }
    return { previous: null, reason: `读不了（${e.code || e.message}）` }
  }
  const parsed = parseBaselineText(text)
  if (parsed.reason) return { previous: null, reason: parsed.reason }
  return { previous: parsed.baseline, reason: null }
}

// 原子写盘：与 ALLOW_FILE 同目录（同一文件系统，rename 才是原子的）的临时文件写好后再 rename 替换。
// 直接 fs.writeFileSync(ALLOW_FILE) 既与前面的存在性探测构成 check-then-use，中途失败还会留下半份基线。
// 临时名 = 常量前缀 + 本进程 pid + crypto 随机后缀（Math.random 属弱随机，Codacy 判为不安全）。
function writeBaselineAtomic (baseline) {
  const tmp = path.join(path.dirname(ALLOW_FILE),
    `.${path.basename(ALLOW_FILE)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const body = JSON.stringify(baseline, null, 2) + '\n'
  try {
    // tmp = ALLOW_FILE 同目录 + pid + 随机后缀，无外部净输入；'wx' 不覆盖已有文件，mode 固定 0o644（库内 100644，免被 umask 改成组可写）
    // eslint-disable-next-line
    fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o644 }) // nosemgrep（tmp = ALLOW_FILE 同目录 + pid + 随机后缀）
    // 目标 = __dirname 常量、源 = 同目录刚写好的临时文件：rename 原子替换，读者永远看不到半份基线
    // eslint-disable-next-line
    fs.renameSync(tmp, ALLOW_FILE) // nosemgrep（目标 = __dirname 常量）
  } catch (e) {
    // 清理 best-effort：临时文件已被 rename 掉或删不掉都不覆盖主错误，原基线保持未改动
    try {
      // eslint-disable-next-line
      fs.unlinkSync(tmp) // nosemgrep（tmp = 本次调用自己拼出的临时名）
    } catch (cleanupErr) { /* 无残留可清或清理失败：主错误照响 */ }
    die(2, `基线写盘失败（原文件未改动）：${e.message}`)
  }
}

/* ── 基线增长核对：与 git 参照版本逐文件 + total 比对 ───────────────────── */
// 为什么必须有：闸门自身只比 on-disk 基线，而基线就在同一个提交里 ⇒「手改 by_file 与 total 等量抬高」
// 与「往测试里加真断言」一起提交时条数差额被抹平，闸门打印 ✅ exit 0。条数判据没有「历史」概念，
// 只有 git 里的参照版本能提供。参照不可得时 CI fail-closed（读不到 ≠ 没有增长）。

// 按名 spawn('git') 会让子进程经 PATH 解析可执行文件（SonarCloud S4036）⇒ 先纯 JS 扫 PATH
// 解析绝对路径，再以绝对路径调用（与 scripts/check-ci-static.js 的 resolveTool 同一口径）。
function resolveToolPath (name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try {
      // candidate = PATH 分段 + 硬编码工具名，无外部净输入
      // eslint-disable-next-line
      fs.accessSync(candidate, fs.constants.X_OK) // nosemgrep（candidate = PATH 分段 + 硬编码工具名）
      // eslint-disable-next-line
      const isFile = fs.statSync(candidate).isFile() // nosemgrep（同上）
      if (isFile) return candidate
    } catch { /* 该候选目录不存在或无权限：继续下一段固定目录 */ }
  }
  return null
}

const GIT = resolveToolPath('git')

function gitRun (args) {
  if (!GIT) return { ok: false, out: '', reason: '找不到 git 可执行文件' }
  const result = spawnSync(GIT, ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 30000 })
  return {
    ok: result.status === 0,
    out: (result.stdout || '').trim(),
    reason: (result.stderr || '').trim() || (result.error ? String(result.error.message) : '')
  }
}

// CI 环境判定（与 scripts/check-ci-static.js 的 decideCiEnv 同口径）：未设置/空/false/0 = 本机，
// 其余任何非空值按 CI —— 判不准时 fail-closed（多一次 exit 2 只是显眼地红，把 CI 当本机的代价是门禁不存在）。
function isCiEnv (value) {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  if (v === '' || v === 'false' || v === '0') return false
  return true
}

// 参照候选链：**不含 HEAD**。HEAD 就是被判定的提交本身，拿它当参照等于基线自比自，恒打印
// 「✓ 未增长」——r22-B2 要拦的「手改 by_file 与 total 等量抬高」在 CI 形态（detached 单提交、
// 没有 base 引用）下因此完全不拦。候选指到 HEAD 时另走「改用父提交」那条路（见下）。
const DEFAULT_REF_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']
const shortSha = (sha) => String(sha || '').slice(0, 12)

// 参照基线：{ ok:true, label, commit, raw, note } | { ok:false, kind, explicit, reason }。
// 形状不合法（schema≠3 / 缺 by_file）的版本按「这一项不可用」处理并继续找下一项——参照坏了不能读成零增长。
//
// 三条硬规则（r23-A1/B1/C1）：
//   ① 参照**不得**是被判定的提交本身：候选解析出来等于 HEAD 时改用它之前的提交（`<ref>^`，真实 base 引用）；
//      取不到父提交（根提交 / 浅克隆）⇒ 按「参照不可得」处理，绝不退回自比自。
//   ② 参照树里**没有基线文件**而当前树有 ⇒ 不是「没有可比的历史」，而是「无法核对」：CI fail-closed exit 2。
//   ③ 显式给出（--baseline-ref / SOURCE_TEXT_ASSERT_BASELINE_REF）时它是**唯一**候选，不可用即 exit 2。
function resolveReferenceBaseline (flags) {
  const explicit = flags.baselineRef || process.env[BASELINE_REF_ENV] || ''
  if (!gitRun(['rev-parse', '--git-dir']).ok) {
    return { ok: false, kind: 'no-git', explicit: !!explicit, reason: '非 git 环境（git 不可用或仓库根不是 work tree）' }
  }
  const head = gitRun(['rev-parse', '--verify', '--quiet', 'HEAD'])
  const headCommit = head.ok ? head.out : ''
  const candidates = explicit ? [explicit] : DEFAULT_REF_CANDIDATES
  const problems = []
  let sawMissingFile = false
  let sawSelf = false
  let missingAt = null
  for (const candidate of candidates) {
    const rev = gitRun(['rev-parse', '--verify', '--quiet', candidate + '^{commit}'])
    if (!rev.ok) {
      problems.push(`${candidate} 不可解析`)
      continue
    }
    let target = { sha: rev.out, label: candidate, note: '' }
    if (headCommit && rev.out === headCommit) {
      // 候选 = 被判定的提交本身（本地在 main 上、CI push 到 main）：基线自比自恒绿，不能当参照。
      // 换用它的父提交这条真实 base 引用；根提交 / 浅克隆取不到 ⇒ 这一项按参照不可得处理。
      const parent = gitRun(['rev-parse', '--verify', '--quiet', candidate + '^'])
      if (!parent.ok || parent.out === headCommit) {
        sawSelf = true
        problems.push(`${candidate}（${shortSha(rev.out)}）就是被判定提交本身且取不到它之前的提交，不能当参照`)
        continue
      }
      target = {
        sha: parent.out,
        label: candidate + '^',
        note: `${candidate} 指向被判定的提交本身（${shortSha(rev.out)}），参照改用它的父提交 ${shortSha(parent.out)}` +
          '（基线自比自恒绿，不能当参照）'
      }
    }
    const shown = gitRun(['show', target.sha + ':' + ALLOW_REL])
    if (!shown.ok) {
      sawMissingFile = true
      if (!missingAt) missingAt = { sha: target.sha, label: target.label }
      problems.push(`${target.label}（${shortSha(target.sha)}）里没有 ${ALLOW_REL}`)
      continue
    }
    let raw = null
    try {
      raw = JSON.parse(shown.out)
    } catch {
      raw = null
    }
    if (!raw || raw.schema !== SCHEMA || !isCount(raw.total) || !raw.by_file ||
      typeof raw.by_file !== 'object' || Array.isArray(raw.by_file)) {
      if (explicit && candidate === explicit) {
        return {
          ok: false,
          kind: 'explicit-missing',
          explicit: true,
          reason: `指定的参照 ${explicit} 的基线形状不可用（需要 schema ${SCHEMA} + total/by_file）`
        }
      }
      problems.push(`${candidate} 的基线形状不可用`)
      continue
    }
    return { ok: true, label: target.label, commit: target.sha, raw, note: target.note }
  }
  const reason = problems.join('；') || '没有可用的参照候选'
  if (explicit) {
    // 显式参照**可解析、只是树里还没有基线文件**：与默认候选同一语义（唯一的例外是「可证明的首次引入」，
    // 由 firstBaselineBootstrap 判定）。其余（ref 拼错 / 形状坏）一律 explicit-missing，本机也不降级。
    if (sawMissingFile && missingAt) {
      return { ok: false, kind: 'no-baseline-in-ref', explicit: true, reason, refCommit: missingAt.sha, refLabel: missingAt.label }
    }
    return { ok: false, kind: 'explicit-missing', explicit: true, reason: `指定的参照 ${explicit} 不可用（${reason}）` }
  }
  // 三态分开，fail-closed 的文案必须能直接指向修法：
  //   no-baseline-in-ref = 参照树里没有基线文件（base 分支还没有这份文件）
  //   self-reference     = 候选就是被判定提交本身，且拿不到它之前的提交
  //   no-ref             = 一个候选都解析不出来
  const kind = sawMissingFile ? 'no-baseline-in-ref' : sawSelf ? 'self-reference' : 'no-ref'
  return {
    ok: false,
    kind,
    explicit: false,
    reason,
    refCommit: missingAt ? missingAt.sha : '',
    refLabel: missingAt ? missingAt.label : ''
  }
}

// 逐文件增长（只报 delta > 0）。参照里没有的文件按 0 算 ⇒ 新文件有任何条目都算增长。
function growthAgainst (next, previous) {
  const rows = []
  for (const [file, count] of sortedByFile(new Map(Object.entries(next.by_file)))) {
    const before = isCount(previous.by_file[file]) ? previous.by_file[file] : 0
    if (count > before) rows.push({ file, before, after: count, delta: count - before })
  }
  return { rows, totalBefore: previous.total, totalAfter: next.total, totalDelta: next.total - previous.total }
}

const describeGrowth = (growth) => [
  `total ${growth.totalBefore} → ${growth.totalAfter}`,
  ...growth.rows.map((row) => `${row.file} ${row.before} → ${row.after}（+${row.delta}）`)
].join('\n  ')

// 基线里的 growth 登记是否**精确**覆盖本次观察到的增长（多报/少报/漏文件都不算）：
// 「等价开关」必须显式到每个文件与每个增量，改它一定是一次可见的 diff；并钉在**写入时的参照提交**上，
// 否则一条旧登记会被日后任何同形状的增长反复复用（= 一张永久通行证）。
function growthAcceptedByRecord (record, growth, commit) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false
  if (typeof record.commit !== 'string' || !record.commit || record.commit !== commit) return false
  if (typeof record.why !== 'string' || !record.why.trim()) return false
  if (!isCount(record.total) || record.total !== growth.totalDelta) return false
  const declared = record.by_file && typeof record.by_file === 'object' && !Array.isArray(record.by_file) ? record.by_file : {}
  const declaredFiles = Object.keys(declared).filter((file) => declared[file] > 0)
  if (declaredFiles.length !== growth.rows.length) return false
  return growth.rows.every((row) => declared[row.file] === row.delta)
}

// 门禁路径：相对参照不得增长；增长只有基线里的 growth 登记（--write-allowlist --allow-growth --reason
// 写下的那份）或运行期的 --allow-growth 能放行，两者都必须在输出里留痕。
// 参照不可得时**绝不打印 ✓**：CI 上 exit 2（fail-closed），本机打印「无法核对增长」后按 on-disk 基线继续。
// 显式参照不可用（拼错 / 没 fetch / 形状坏 / 就是被判定提交本身）一律 exit 2，本机也不降级。
function baselineAddedSince (commit) {
  if (!commit) return { ok: false, reason: '参照提交未知' }
  const diff = gitRun(['diff', '--name-status', '--diff-filter=A', commit, 'HEAD', '--', ALLOW_REL])
  if (!diff.ok) return { ok: false, reason: `git diff ${shortSha(commit)}..HEAD 不可用（${diff.reason}）` }
  const lines = diff.out.split('\n').map((line) => line.trim()).filter(Boolean)
  const added = lines.some((line) => {
    const [status, ...rest] = line.split('\t')
    return status === 'A' && rest.join('\t') === ALLOW_REL
  })
  return added ? { ok: true } : { ok: false, reason: `本变更没有新增 ${ALLOW_REL}（git diff --diff-filter=A 无该项）` }
}

// 基线与实测的逐文件差额（两个方向都算）：首次引入时要求**完全一致**，不留任何预授权额度。
function baselineExactDiffs (baseline, measured) {
  const files = new Set([...Object.keys(baseline.by_file), ...measured.keys()])
  const rows = []
  for (const file of [...files].sort()) {
    const allowed = isCount(baseline.by_file[file]) ? baseline.by_file[file] : 0
    const count = measured.get(file) || 0
    if (allowed !== count) rows.push({ file, allowed, count })
  }
  return rows
}

// 「首次引入基线」的可证明形态（参照树里没有基线文件时唯一允许放行的情形）：
//   ① 本变更相对参照**新增**了这份文件（参照里根本没有它 ⇒ 不存在「把已有基线抬高」这件事）；
//   ② on-disk 基线逐文件与本次实测**完全一致**（既无超基线的增长，也没有高于实测的预授权额度）。
// 把「没有历史可比」换成一条当场可核的更强判据；两条缺一即按参照不可得处理（CI fail-closed）。
function firstBaselineBootstrap (reference, baseline, measured) {
  if (reference.kind !== 'no-baseline-in-ref') return { ok: false, reason: '不属于「参照树里没有基线文件」' }
  const added = baselineAddedSince(reference.refCommit)
  if (!added.ok) return added
  const diffs = baselineExactDiffs(baseline, measured)
  if (diffs.length) {
    return {
      ok: false,
      reason: '基线逐文件与实测不一致（' + diffs.slice(0, 5).map((d) => `${d.file} 基线 ${d.allowed} / 实测 ${d.count}`).join('；') +
        '）——首次引入时基线必须等于实测，不得预留额度'
    }
  }
  return { ok: true, total: baseline.total }
}

function verifyGrowthAgainstReference (baseline, flags, measured) {
  const reference = resolveReferenceBaseline(flags)
  if (!reference.ok) {
    let reason = reference.reason
    if (reference.kind === 'no-baseline-in-ref') {
      const boot = firstBaselineBootstrap(reference, baseline, measured || new Map())
      if (boot.ok) {
        console.log(`ℹ️ 无法核对增长（${reason}）：参照树里没有这份基线、本变更新增了它 = 首次引入，没有可比的历史；` +
          `已按「基线逐文件与实测完全一致」核对（total=${boot.total}），不声称「未增长」。`)
        return
      }
      reason = `${reason}；也不能按「首次引入」放行：${boot.reason}`
    }
    if (reference.explicit) {
      die(2, `❌ 无法核对增长（${reason}）。显式指定的参照不可用不能当成「零增长」：` +
        `请指向一个含 ${ALLOW_REL}、且不是被判定提交本身的提交（--baseline-ref / ${BASELINE_REF_ENV}）。`)
    }
    // --allow-growth 是人工确认并留痕的放行路径（与写盘侧同一开关）：仍然放行，但输出里不得出现 ✓ 未增长。
    if (flags.allowGrowth) {
      console.log(`⚠️ 无法核对增长（${reason}）：已按 --allow-growth 接受，` +
        '本次「未增长」未经参照核对（须逐文件归因写进 CHANGELOG）。')
      return
    }
    if (isCiEnv(process.env.CI)) {
      die(2, `❌ 无法核对增长（${reason}）：CI 上 fail-closed——` +
        '拿不到参照版本（或参照树里没有基线文件、参照就是被判定提交本身）就不能证明基线没有被抬高，' +
        '本次判定直接退出，不按 on-disk 基线放行。修法：quality job 的 checkout 取全历史' +
        `（fetch-depth: 0）并把 ${BASELINE_REF_ENV} 指向含基线的真实 base 提交（origin/<base>，` +
        '且不得等于本次被判定提交）。')
    }
    console.log(`ℹ️ 无法核对增长（${reason}）：只按当前基线判定，` +
      '本次「未增长」未经参照核对；CI 上该分支 fail-closed（exit 2）。')
    return
  }
  if (reference.note) console.log(`ℹ️ ${reference.note}`)
  const growth = growthAgainst(baseline, reference.raw)
  if (!growth.rows.length) {
    console.log(`✓ 基线相对参照 ${reference.label} 未增长（逐文件与 total 一致：${growth.totalAfter} 条）`)
    return
  }
  if (growthAcceptedByRecord(baseline.growth, growth, reference.commit)) {
    console.log(`ℹ️ 基线相对参照 ${reference.label} 增长 ${growth.totalDelta} 条，已由基线里的 growth 登记显式接受：${baseline.growth.why}`)
    growth.rows.forEach((row) => console.log(`  ${row.file}  ${row.before} → ${row.after}（+${row.delta}）`))
    return
  }
  if (flags.allowGrowth) {
    console.log(`ℹ️ 已按 --allow-growth 接受基线相对 ${reference.label} 的增长 ${growth.totalDelta} 条（须逐文件归因写进 CHANGELOG）。`)
    return
  }
  console.error(`❌ 基线相对参照 ${reference.label} 被抬高 ${growth.totalDelta} 条（白名单「只减不增」，含「by_file 与 total 等量抬高」）：`)
  growth.rows.forEach((row) => console.error(`  ${row.file}  参照 ${row.before} / 当前 ${row.after} / +${row.delta}`))
  console.error('修法：新增断言改成行为/AST/配置断言；确属仪器变宽就 ' +
    'node scripts/check-source-text-asserts.js --write-allowlist --allow-growth --reason "…" 重生成（增长随基线留痕）。')
  process.exit(1)
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
const FLAG_DOC = '--write-allowlist / --allow-growth / --reason / --baseline-ref'

function parseArgv (argv) {
  const flags = { write: false, allowGrowth: false, reason: '', baselineRef: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const key = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : null
    if (key === '--write-allowlist' || key === '--allow-growth') {
      if (inline !== null) die(2, `${key} 不接受取值（只支持 ${FLAG_DOC}）`)
      if (key === '--write-allowlist') flags.write = true
      else flags.allowGrowth = true
      continue
    }
    if (key === '--reason' || key === '--baseline-ref') {
      const value = inline !== null ? inline : argv[++i]
      if (!value || value.startsWith('--')) die(2, `${key} 需要取值（${key} <值> 或 ${key}=<值>）`)
      if (key === '--reason') flags.reason = value
      else flags.baselineRef = value
      continue
    }
    die(2, `未知参数：${arg}（只支持 ${FLAG_DOC}）`)
  }
  return flags
}

function main () {
  const flags = parseArgv(process.argv.slice(2))
  const hits = scanAll()

  if (flags.write) {
    const next = renderBaseline(hits)
    const rewrite = readBaselineForRewrite()
    const previous = rewrite.previous
    if (rewrite.reason) console.log(`ℹ️ 旧基线不可用（${rewrite.reason}）⇒ 按「没有旧基线」重生成`)
    const growth = previous ? growthAgainst(next, previous) : null
    if (growth && growth.rows.length) {
      if (!flags.allowGrowth) {
        die(1, '❌ 拒绝写盘：基线增长（新增源码文本断言或检测面变宽）\n  ' + describeGrowth(growth) +
          '\n  确实要抬高基线请显式加 --allow-growth --reason "…"，并在 CHANGELOG 里逐文件归因。')
      }
      if (!flags.reason.trim()) {
        die(2, '--allow-growth 必须同时给出 --reason "…"：基线增长是把债记回去的动作，理由要随基线与 CI 日志留痕。')
      }
      const reference = resolveReferenceBaseline(flags)
      const byFile = {}
      growth.rows.forEach((row) => { byFile[row.file] = row.delta })
      next.growth = {
        why: flags.reason,
        commit: reference.ok ? reference.commit : null,
        ref: reference.ok ? reference.label : null,
        at: new Date().toISOString(),
        total: growth.totalDelta,
        by_file: byFile
      }
      if (!reference.ok) console.log(`⚠️ 参照版本不可得（${reference.reason}）：growth 登记无法钉提交，只留理由与增量。`)
    } else if (previous && previous.growth) {
      // 没有新增增长时把既有登记原样带过去：否则一次普通重生成会抹掉「债被记回去」的痕迹。
      next.growth = previous.growth
    }
    writeBaselineAtomic(next)
    console.log(`已写入基线：total=${next.total}（${Object.keys(next.by_file).length} 个文件）`)
    if (growth && growth.rows.length) {
      console.log(`ℹ️ --allow-growth 已使用：本次增长 ${growth.totalDelta} 条，理由「${flags.reason}」`)
      growth.rows.forEach((row) => console.log(`  ${row.file}  ${row.before} → ${row.after}（+${row.delta}）`))
      console.log('ℹ️ 增长登记已写入基线的 growth 段（评审只看这份 diff 就能看到债被记回去了）。')
    }
    printByFile('按文件：', perFile(hits))
    return
  }

  const baseline = readBaseline()
  console.log(`源码文本断言：基线 total=${baseline.total}（${Object.keys(baseline.by_file).length} 个文件）` +
    `，实测 total=${hits.length}（扫描 ${listTestFiles().length} 个测试面文件）`)
  const measured = perFile(hits)
  verifyGrowthAgainstReference(baseline, flags, measured)
  const { violations, shortfalls } = compare(hits, baseline)
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
