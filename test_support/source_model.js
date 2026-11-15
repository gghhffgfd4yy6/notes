'use strict'

/*
 * 源码结构视图（S0 工具层）：把「读源码文本再 includes」换成「解析后断言结构」的唯一入口。
 *
 * 为什么要有这一层：测试里冻结的 857 处 `assert.ok(src.includes('…'))` 会随格式化、插桩、注释调整
 * 误红（2026-11-15 mutation 13 段集体误红），而注释里出现同样字面量时又永远为真。断言应该问
 * 「有这个函数吗 / 调用了这个成员吗 / 导出了它吗」，而不是「这段文本出现过吗」。
 *
 * 依赖：仓库已有的 acorn（devDependencies 里的 `acorn`，沙箱里由 copyProject 的 node_modules 软链提供），
 * **不新装依赖**。
 *
 * 设计约束（勿放宽）：
 *   - AST 解析失败**抛错**，绝不静默返回空集合——空集合会让「有该函数」这类断言全绿，等于把
 *     一个语法错误伪装成通过。ESM 解析失败时会再按 module 试一次，两次都失败才抛（错误信息带两侧原因）。
 *   - model 按文件缓存（进程内），重复 hasCall 调用不重复解析大文件（xbk_function_v3.js 有几千行）。
 *   - `codeOnly` 只作兜底（例如断言「某处顺序」这类结构断言表达不了的东西），不得作为主要手段：
 *     它仍然是在比字符串，只是把注释与空白差异抹平。用法：assert.ok(codeOnly('a.js').includes('foo('))。
 */

const fs = require('node:fs')
const path = require('node:path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')

// 生产/测试文件都是 CommonJS 脚本；sourceType 先按 script 试，失败再按 module（仓库里没有 ESM，
// 但工具层不该假设调用方只喂 CJS）。allowHashBang：qinglong 入口可能带 shebang。
const BASE_OPTS = { ecmaVersion: 'latest', allowHashBang: true, locations: true }

const cache = new Map()

function resolvePath (file) {
  if (typeof file !== 'string' || !file) throw new TypeError('source_model: file 必须是非空字符串路径')
  return path.isAbsolute(file) ? file : path.join(ROOT, file)
}

function readSource (file) {
  return fs.readFileSync(resolvePath(file), 'utf8')
}

// 通用遍历：只认 `.type` 是字符串的节点，跳过 loc/range 之类非节点字段（不引入 acorn-walk 依赖）。
function walk (node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit)
    } else if (value && typeof value === 'object') {
      walk(value, visit)
    }
  }
}

// 成员路径：Identifier → 'a'；this → 'this'；静态成员逐级拼接 → 'a.b.c'。
// 计算成员只有字面量键（a['b']）能还原成 a.b，动态键返回 null（无法表达就不猜）。
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

function keyName (node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value)
  return null
}

function isFunctionNode (node) {
  return !!node && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
}

function parseCode (file, code) {
  const attempts = [
    { ...BASE_OPTS, sourceType: 'script' },
    { ...BASE_OPTS, sourceType: 'module' }
  ]
  const errors = []
  for (const opts of attempts) {
    try {
      return acorn.parse(code, opts)
    } catch (e) {
      errors.push(`${opts.sourceType}: ${e.message}`)
    }
  }
  // 关键：抛错而不是返回空集合。空集合会让「有该函数/该调用」之类断言一律变绿（语法坏了也绿）。
  throw new Error(`source_model: 无法解析 ${file}（${errors.join('；')}）`)
}

function collectCalls (ast, calls) {
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return
    const name = memberPath(node.callee)
    if (name) calls.add(name)
  })
}

function collectMembers (ast, members) {
  walk(ast, (node) => {
    if (node.type !== 'MemberExpression') return
    const name = memberPath(node)
    if (name) members.add(name)
  })
}

// 函数声明 / 类方法（含 static 与类字段箭头函数）/ `const f = () => {}` 形式的变量赋值函数表达式。
// 名字取「调用方会写出来的那个名字」，不取带类名前缀的全名（hasFunction 只问「有这个函数吗」）。
function collectFuncs (ast, funcs) {
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) funcs.add(node.id.name)
    else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFunctionNode(node.init)) funcs.add(node.id.name)
    else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      const name = keyName(node.key)
      if (name && isFunctionNode(node.value)) funcs.add(name)
    } else if (node.type === 'Property' && node.value && isFunctionNode(node.value)) {
      // 对象字面量里的方法（{ foo () {} } / { foo: () => {} }）：模块导出的对象写法常见
      const name = keyName(node.key)
      if (name) funcs.add(name)
    }
  })
}

// module.exports.x / exports.x / module.exports = { a, b } / export function x / export const x / export default
function collectExports (ast, exports) {
  const fromModuleExports = (p) => {
    if (p === 'module.exports') return '(default)'
    if (p.startsWith('module.exports.')) return p.slice('module.exports.'.length)
    if (p.startsWith('exports.')) return p.slice('exports.'.length)
    return null
  }
  walk(ast, (node) => {
    if (node.type === 'AssignmentExpression') {
      const p = memberPath(node.left)
      const name = p && fromModuleExports(p)
      if (!name) return
      if (name === '(default)' && node.right.type === 'ObjectExpression') {
        // module.exports = { a, b }: 导出名是对象的键，不是 '(default)'
        const keys = node.right.properties.map((prop) => keyName(prop.key || prop.argument)).filter(Boolean)
        if (keys.length) {
          keys.forEach((k) => exports.add(k))
          return
        }
      }
      exports.add(name)
      return
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration
        if (decl.id) exports.add(decl.id.name)
        else if (Array.isArray(decl.declarations)) {
          decl.declarations.forEach((d) => { if (d.id && d.id.type === 'Identifier') exports.add(d.id.name) })
        }
      }
      node.specifiers.forEach((s) => {
        const name = s.exported ? s.exported.name || s.exported.value : null
        if (name) exports.add(name)
      })
      return
    }
    if (node.type === 'ExportDefaultDeclaration') exports.add('default')
  })
}

// codeOnly：去注释 + 空白折叠成单空格（**仅兜底**）。逐 token 重建而不是对原文做正则替换——
// 后者会把字符串字面量里的连续空格也折叠掉，等于篡改被测数据。token 之间原本有间隔（空白或注释）
// 才补一个空格，所以 `foo(x)` 仍是 `foo(x)`、`foo (x)` 归一成 `foo (x)`（保留一个空格），
// 而 `a  +  b` / `a/*c*/+/*c*/b` 都归一成 `a + b`。
function buildCodeOnly (code, tokens) {
  const parts = []
  let prevEnd = 0
  for (const token of tokens) {
    // 位置上有间隔（空白或注释，acorn 的 token 流不含注释）就补一个空格；
    // 纯注释也算间隔，否则 a/*c*/b 会粘成 ab，改变词法边界。
    if (token.start > prevEnd) parts.push(' ')
    parts.push(code.slice(token.start, token.end))
    prevEnd = token.end
  }
  return parts.join('').trim()
}

function buildModel (file, code) {
  const ast = parseCode(file, code)
  const tokens = []
  const lexer = acorn.tokenizer(code, { ...BASE_OPTS, sourceType: 'script' })
  let token
  while ((token = lexer.getToken()).type !== acorn.tokTypes.eof) tokens.push(token)
  const calls = new Set()
  const members = new Set()
  const funcs = new Set()
  const exports = new Set()
  collectCalls(ast, calls)
  collectMembers(ast, members)
  collectFuncs(ast, funcs)
  collectExports(ast, exports)
  return {
    file,
    code,
    ast,
    tokens,
    calls,
    members,
    funcs,
    exports,
    codeOnly: buildCodeOnly(code, tokens)
  }
}

function loadModel (file) {
  const abs = resolvePath(file)
  const hit = cache.get(abs)
  if (hit) return hit
  const code = fs.readFileSync(abs, 'utf8')
  const model = buildModel(abs, code)
  cache.set(abs, model)
  return model
}

const pick = (field) => (file) => loadModel(file)[field]

// 便捷布尔函数（同一份缓存）：断言点只写 hasCall('xbk_utils.js', 'foo')，不必自己拿 Set。
const calls = pick('calls')
const members = pick('members')
const funcs = pick('funcs')
const exports_ = pick('exports')
const codeOnly = pick('codeOnly')

const hasCall = (file, name) => loadModel(file).calls.has(name)
const hasMember = (file, name) => loadModel(file).members.has(name)
const hasFunction = (file, name) => loadModel(file).funcs.has(name)
const hasExport = (file, name) => loadModel(file).exports.has(name)

// YAML：仓库里没有直接声明 js-yaml（它作为 stryker 依赖树的一部分装在 node_modules 里，禁止新装），
// 因此按「存在就用、缺失就明确报错」解析，不静默降级成文本匹配。
// 安全性：js-yaml 4 的 load() 只走 DEFAULT_SCHEMA（!!js/function 一类的构造器已移除），不做代码执行，
// 这里解析的是本仓自己的 workflow/config 文件，与 Python 的 yaml.load 语义无关。
function loadYaml (file) {
  let yaml
  try {
    yaml = require('js-yaml')
  } catch (e) {
    throw new Error('source_model: 环境里没有 js-yaml（依赖树变化？）。配置文件断言请改用 test/_yaml.js 的文本提取或直接 JSON.parse。原始错误：' + e.message)
  }
  return yaml.load(readSource(file), { filename: resolvePath(file) })
}

// ── shell 切词：引号感知、不执行、不调用 shell ──────────────────────────────
// 返回 [{line, tokens}]（行号 1 起，空行给空 tokens）——入口脚本的接线断言用它
// （例如「第 3 行有 node，且同一个 tokens 里有 xbk_push.js」），不再比对源码行文本。
function shellTokens (line) {
  const tokens = []
  let buf = ''
  let inToken = false
  let quote = null
  // `$(…)` / `${…}` / `$((…))`：命令替换与参数展开是**词内**结构，不按元字符切开——否则
  // `t0=$(date +%s)` 会被切成 ['t0=$','(','date','+%s',')']，接线断言就得猜括号。整体当一个词。
  const dollarExpr = (start) => {
    const open = line[start + 1]
    const close = open === '(' ? ')' : '}'
    let depth = 0
    let cursor = start + 1
    let inner = null
    for (; cursor < line.length; cursor++) {
      const c = line[cursor]
      if (inner) {
        if (c === inner) inner = null
        continue
      }
      if (c === "'" || c === '"') {
        inner = c
        continue
      }
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) return [line.slice(start, cursor + 1), cursor + 1]
      }
    }
    throw new Error('source_model.parseShell: 未闭合的 ' + line.slice(start, start + 2) + ' …（' + line + '）')
  }
  // 显式游标（不是 for 计数器）：`$((…))` 与 `\x` 转义要整段跳过，游标由本循环自己推进
  // （Sonar S2310：循环变量不得在循环体内被改写）。
  let cursor = 0
  while (cursor < line.length) {
    const c = line[cursor]
    if (quote === "'") {
      if (c === "'") quote = null
      else buf += c
      cursor++
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && cursor + 1 < line.length && '"\\$`'.includes(line[cursor + 1])) {
        buf += line[cursor + 1]
        cursor++
      } else buf += c
      cursor++
      continue
    }
    if (c === '$' && (line[cursor + 1] === '(' || line[cursor + 1] === '{')) {
      const [text, next] = dollarExpr(cursor)
      buf += text
      inToken = true
      cursor = next
      continue
    }
    if (c === '#') {
      // 词首的 # 起注释（`a#b` 里的 # 是普通字符，与 shell 语义一致）
      if (!inToken) break
      buf += c
      cursor++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inToken = true
      cursor++
      continue
    }
    if (c === '\\') {
      if (cursor + 1 < line.length) {
        buf += line[cursor + 1]
        cursor++
      } else buf += c
      inToken = true
      cursor++
      continue
    }
    if (/\s/.test(c)) {
      if (inToken) {
        tokens.push(buf)
        buf = ''
        inToken = false
      }
      cursor++
      continue
    }
    if (';&|<>()'.includes(c)) {
      if (inToken) {
        tokens.push(buf)
        buf = ''
        inToken = false
      }
      const two = line.slice(cursor, cursor + 2)
      if (['&&', '||', '|&', '>>', '<<', '>&'].includes(two)) {
        tokens.push(two)
        cursor += 2
      } else {
        tokens.push(c)
        cursor++
      }
      continue
    }
    buf += c
    inToken = true
    cursor++
  }
  if (quote) throw new Error('source_model.parseShell: 未闭合的引号：' + line)
  if (inToken) tokens.push(buf)
  return tokens
}

function parseShell (file) {
  return fs.readFileSync(resolvePath(file), 'utf8')
    .split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, tokens: shellTokens(line) }))
}

module.exports = {
  loadModel,
  calls,
  members,
  funcs,
  exports: exports_,
  codeOnly,
  hasCall,
  hasMember,
  hasFunction,
  hasExport,
  loadYaml,
  parseShell,
  // 内部件（测试/工具自检用；业务断言不该直接用）
  shellTokens,
  _cache: cache
}
