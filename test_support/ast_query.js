'use strict'

/*
 * AST 查询层（assertshape S3）：在 `source_model.loadModel()` 之上补「结构 + 实参」级查询。
 *
 * 为什么要有这一层：`source_model` 只给 calls / members / funcs / exports 四个**名字集合**，
 * 够表达「有这个调用」，但表达不了这些必须说清楚的事——
 *   · 这次 `isRealPathInside` 调用的第一、二个实参是不是 root / p；
 *   · 这个 `require` 的模块名是不是 './test-env-isolation'；
 *   · `if (require.main === module)` 的 if 链各支分别是什么、runSingleEntry 是不是只在最后一支；
 *   · `formatRunSummaryLine` 的实参对象键名里有没有 stamp / counters。
 * 这些正是替代 `src.includes('isRealPathInside(root, p')` 一类源码文本断言时必须表达的东西。
 *
 * 设计约束（勿放宽）：
 *   - 只读 AST，不做任何文本比对；断言落在「节点类型 / 标识符名 / 字面量值 / 实参位置」上。
 *   - 不修改 source_model 的导出面：`test_source_model.js` 把那个集合锁成「12 公共面 + 2 内部件」，
 *     加一个导出会让一个与本包无关的套件变红。因此 `memberPath` 在本层自带一份（逻辑与
 *     source_model 内部同名函数等价：Identifier / this / super / 字面量键的静态成员逐级拼接）。
 *   - 查询入口既接受 model（`loadModel(f)`）也接受仓库内相对/绝对路径，还接受**子树节点**——
 *     `callSites(tryStatement, 'fs.readSync')` 只在该 try 内找，这样「某段代码里只允许 fd 系列调用」
 *     这类区域断言才能表达。
 */

const { loadModel } = require('./source_model')
const acorn = require('acorn')

const PARSE_OPTS = { ecmaVersion: 'latest', allowHashBang: true, locations: true }
const NON_NODE_KEYS = new Set(['type', 'loc', 'range', 'start', 'end'])

// 解析一段源码文本（夹具 / 合成样本用）：与 loadModel 同一套 acorn 选项，语法坏掉当场抛错
// ——自检夹具若解析失败，静默返回空树会让「有该调用」这类断言全绿，等于把夹具写错伪装成通过。
function parseText (code, label = '<text>') {
  try {
    return acorn.parse(code, { ...PARSE_OPTS, sourceType: 'script' })
  } catch (e) {
    throw new Error(`ast_query: 无法解析 ${label}（${e.message}）`)
  }
}

// model / 文件路径 / 裸节点 三种入口归一成 AST 根（或子树根）。
function astOf (source) {
  if (typeof source === 'string') return loadModel(source).ast
  if (!source || typeof source !== 'object') {
    throw new TypeError('ast_query: 需要 source_model 的 model、仓库内文件路径或 AST 节点')
  }
  if (source.ast) return source.ast
  if (typeof source.type === 'string') return source
  throw new TypeError('ast_query: 入参既不是 model 也不是 AST 节点')
}

// 通用遍历：visit(node, ancestors)。跳过 loc/start/end 这类非节点字段（不引入 acorn-walk 依赖）。
function walk (node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return
  visit(node, ancestors)
  const next = ancestors.concat(node)
  for (const key of Object.keys(node)) {
    if (NON_NODE_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, next)
    } else if (value && typeof value === 'object') {
      walk(value, visit, next)
    }
  }
}

function findAll (source, predicate) {
  const out = []
  walk(astOf(source), (node, ancestors) => {
    if (predicate(node, ancestors)) out.push(node)
  })
  return out
}

function findFirst (source, predicate) {
  let found = null
  walk(astOf(source), (node, ancestors) => {
    if (found === null && predicate(node, ancestors)) found = node
  })
  return found
}

// 静态成员路径：`fs.readSync` / `this.x` / `a['b']`（字面量键）→ 字符串；动态键返回 null（不猜）。
function memberPath (node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'Super') return 'super'
  if (node.type !== 'MemberExpression') return null
  const object = memberPath(node.object)
  if (!object) return null
  let prop = null
  if (!node.computed && node.property.type === 'Identifier') prop = node.property.name
  else if (node.property.type === 'Literal' && (typeof node.property.value === 'string' || typeof node.property.value === 'number')) prop = String(node.property.value)
  return prop === null ? null : object + '.' + prop
}

// 该子树里所有「被调名恰为 path」的调用点（path 是 memberPath 口径：'runResident' / 'fs.fstatSync'）。
function callSites (source, path) {
  return findAll(source, (node) => node.type === 'CallExpression' && memberPath(node.callee) === path)
}

function hasCallTo (source, path) {
  return callSites(source, path).length > 0
}

// 实参位置断言：第 argIndex 个实参必须是指定字面量 / 指定标识符。
function hasCallWithLiteral (source, path, argIndex, value) {
  return callSites(source, path).some((call) => {
    const arg = call.arguments[argIndex]
    return !!arg && arg.type === 'Literal' && arg.value === value
  })
}

function hasCallWithIdentifier (source, path, argIndex, name) {
  return callSites(source, path).some((call) => {
    const arg = call.arguments[argIndex]
    return !!arg && arg.type === 'Identifier' && arg.name === name
  })
}

// 模块图断言：`require('<spec>')` 这条边是否存在（比在源码里找字符串可靠——注释里的 require 不算）。
function requireEdge (source, spec) {
  return hasCallWithLiteral(source, 'require', 0, spec)
}

// 子树里是否声明了该名字的变量（`const fd14 = …`）——用于按「结构锚点」选取代码段。
function declaresVariable (source, name) {
  return findAll(source, (node) => node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name).length > 0
}

// if / else if / … / else 逐支展开：[{ test, consequent }]，末尾 else 的 test 为 null。
function ifChain (node) {
  const arms = []
  let cursor = node
  while (cursor && cursor.type === 'IfStatement') {
    arms.push({ test: cursor.test, consequent: cursor.consequent })
    cursor = cursor.alternate
  }
  if (cursor) arms.push({ test: null, consequent: cursor })
  return arms
}

// 对象字面量的键名集合（非对象返回 null）：`{ stamp, counters }` → ['stamp', 'counters']。
function objectKeyNames (node) {
  if (!node || node.type !== 'ObjectExpression') return null
  return node.properties.map((prop) => {
    if (prop.type !== 'Property') return null
    if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name
    if (prop.key.type === 'Literal') return String(prop.key.value)
    return null
  }).filter((name) => name !== null)
}

module.exports = {
  astOf,
  parseText,
  walk,
  findAll,
  findFirst,
  memberPath,
  callSites,
  hasCallTo,
  hasCallWithLiteral,
  hasCallWithIdentifier,
  requireEdge,
  declaresVariable,
  ifChain,
  objectKeyNames
}
