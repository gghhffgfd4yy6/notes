'use strict'

/*
 * 标记结构视图（assertshape C1）：把 `html`…`` 模板或服务端渲染出的 HTML 文本解析成
 * 「元素 / 属性 / 文本」结构，让断言落在「有这个元素吗 / 它带这个属性吗 / 属性绑的是哪个表达式」
 * 上，而不是在源码里找 `class="rule-src"` 这样的文本片段。
 *
 * 为什么需要这一层（而不是直接用 ast_query）：
 *   · `src.includes('title="数据备份与恢复"')` 这类断言守的其实是**渲染出来的 DOM 形状**；
 *     只在原文里搜字符串既会被注释满足，又会随格式化（`title="x"` → 换行/多空格）误红。
 *   · htm 的属性值有两种来源：静态文本（`title="…"`）与表达式（`open=${open}`）。前者是文案，
 *     后者才是接线；AST 上正好是 quasi 文本与 expression 节点两段，因此可以分别断言。
 *   · 组件标签是插值形态 `<${Drawer} …>`：标签名取自表达式（Identifier / 成员路径），不是文本。
 *
 * 设计约束（勿放宽）：
 *   - 只吃 AST 节点（TaggedTemplateExpression / TemplateLiteral）或调用方给出的**运行期**文本，
 *     本层不读任何源码文件——读源码是 source_model.loadModel 的事。
 *   - 不做「整串 includes」：暴露的元素树带 attrs / children，断言用元素名、属性名、属性值、
 *     文本内容（textOf 已折叠空白）。
 *   - 解析宽进严出：遇到不认识的形状（未闭合标签、`<` 当文本）按 HTML 的容错规则吞掉，
 *     绝不抛错——但**语法正确的模板/HTML 必须解析出正确的树**（见自带的基本不变式）。
 *   - `expandTemplates: true` 会把 `${cond && html`…`}` 这种嵌套模板就地展开（等价于渲染结果），
 *     用于「抽屉里必须有两个密码框」这类跨层断言；默认不展开（只看本层）。
 */

const { findAll, findFirst, memberPath } = require('./ast_query')

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

function isWhitespace (ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

// 标签名/属性名允许的字符：htm 组件名首字母大写（Drawer）、允许 `-`/`:`/`.`（data-*、xlink:href）。
function isNameChar (ch) {
  if (ch === undefined) return false
  if (isWhitespace(ch)) return false
  return ch !== '=' && ch !== '>' && ch !== '/' && ch !== '<' && ch !== '"' && ch !== "'" && ch !== '`'
}

// 段序列 → 字符/表达式游标：文本段按下标推进，表达式段整体当一个符号。
// 不把文本拆成逐字符数组：pages.js 的模板动辄几千字符，逐字符建对象是纯浪费。
function cursorOf (segments) {
  let si = 0
  let ci = 0
  const skipDone = () => {
    while (si < segments.length && segments[si].kind === 'text' && ci >= segments[si].text.length) {
      si++
      ci = 0
    }
  }
  const peek = () => {
    skipDone()
    if (si >= segments.length) return null
    const seg = segments[si]
    if (seg.kind === 'expr') return { expr: seg.node }
    return { ch: seg.text[ci] }
  }
  const next = () => {
    const item = peek()
    if (!item) return null
    if (item.ch === undefined) { si++; ci = 0 } else ci++
    return item
  }
  const mark = () => ({ si, ci })
  const reset = (m) => { si = m.si; ci = m.ci }
  return { peek, next, mark, reset }
}

// 模板节点（TaggedTemplateExpression 或裸 TemplateLiteral）→ [{kind:'text',text} | {kind:'expr',node}]
function segmentsOfTemplate (node) {
  const quasi = node && (node.quasi || (node.type === 'TemplateLiteral' ? node : null))
  if (!quasi || !Array.isArray(quasi.quasis)) {
    throw new TypeError('markup: 需要 TaggedTemplateExpression 或 TemplateLiteral 节点')
  }
  const out = []
  for (let i = 0; i < quasi.quasis.length; i++) {
    const value = quasi.quasis[i].value
    out.push({ kind: 'text', text: value.cooked == null ? value.raw : value.cooked })
    if (i < quasi.expressions.length) out.push({ kind: 'expr', node: quasi.expressions[i] })
  }
  return out
}

function segmentsOfText (text) {
  if (typeof text !== 'string') throw new TypeError('markup: 文本必须是字符串')
  return [{ kind: 'text', text }]
}

function elementName (node) {
  const path = memberPath(node)
  return path === null ? '' : path
}

function parseSegments (segments, options = {}) {
  const expand = options.expandTemplates === true
  const root = { type: 'element', name: '#root', attrs: [], children: [] }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  const cur = cursorOf(segments)

  const addText = (value) => {
    if (!value) return
    const parent = top()
    const last = parent.children[parent.children.length - 1]
    if (last && last.type === 'text') { last.value += value; return }
    parent.children.push({ type: 'text', value })
  }
  const addNode = (node) => { top().children.push(node) }

  // 表达式出现在文本位置：留一个占位节点（textOf 跳过它，嵌套模板可选展开）。
  // expand 模式把表达式里出现的 html`` 模板就地展开（`${cond && html`…`}` /
  // `${list.map((x) => html`…`)}` 都是同一个意思：这些分支可能渲染出这些元素）。
  // 不展开时它们只是 expression 节点——挡在树外，不会被误当成当前层的元素。
  const addExpression = (node) => {
    if (expand && node) {
      const nested = (node.type === 'TaggedTemplateExpression' || node.type === 'TemplateLiteral')
        ? [node]
        : outermostTemplatesIn(node)
      if (nested.length > 0) {
        for (const tpl of nested) {
          const inner = parseSegments(segmentsOfTemplate(tpl), options)
          for (const child of inner.children) addNode(child)
        }
        return
      }
    }
    addNode({ type: 'expr', node })
  }

  const matchesAt = (seq) => {
    const m = cur.mark()
    for (const ch of seq) {
      const item = cur.peek()
      if (!item || item.expr || String(item.ch).toLowerCase() !== ch) { cur.reset(m); return false }
      cur.next()
    }
    cur.reset(m)
    return true
  }
  const consume = (seq) => {
    for (let i = 0; i < seq.length; i++) cur.next()
  }
  const readUntilChar = (stop) => {
    let out = ''
    for (;;) {
      const item = cur.peek()
      if (!item || item.expr) break
      if (item.ch === stop) break
      out += item.ch
      cur.next()
    }
    return out
  }
  const readName = () => {
    const item = cur.peek()
    if (!item) return ''
    if (item.expr) { cur.next(); return elementName(item.expr) }
    let out = ''
    for (;;) {
      const t = cur.peek()
      if (!t || t.expr || !isNameChar(t.ch)) break
      out += cur.next().ch
      if (out.length > 128) break
    }
    return out
  }

  const readBareValue = () => {
    let out = ''
    for (;;) {
      const t = cur.peek()
      if (!t || t.expr || isWhitespace(t.ch) || t.ch === '>' || t.ch === '/') break
      out += cur.next().ch
    }
    return out
  }

  // 开标签内部：属性列表，直到 `>` 或 `/>`。
  const readAttrs = () => {
    const attrs = []
    for (;;) {
      const item = cur.peek()
      if (!item) return { attrs, selfClosing: false, closed: false }
      if (item.expr) { cur.next(); attrs.push({ name: '', spread: true, value: { kind: 'expr', node: item.expr } }); continue }
      const ch = item.ch
      if (isWhitespace(ch)) { cur.next(); continue }
      if (ch === '>') { cur.next(); return { attrs, selfClosing: false, closed: true } }
      if (ch === '/') {
        cur.next()
        const after = cur.peek()
        if (after && !after.expr && after.ch === '>') { cur.next(); return { attrs, selfClosing: true, closed: true } }
        continue
      }
      const name = readName()
      if (name === '') { cur.next(); continue }
      let value = { kind: 'text', value: '' }
      const eq = cur.peek()
      if (eq && !eq.expr && eq.ch === '=') {
        cur.next()
        const first = cur.peek()
        if (first && !first.expr && isWhitespace(first.ch)) cur.next()
        const v = cur.peek()
        if (!v) { value = { kind: 'text', value: '' } } else if (v.expr) { cur.next(); value = { kind: 'expr', node: v.expr } } else if (v.ch === '"' || v.ch === "'") {
          cur.next()
          value = { kind: 'text', value: readUntilChar(v.ch) }
          const close = cur.peek()
          if (close && !close.expr && close.ch === v.ch) cur.next()
        } else {
          value = { kind: 'text', value: readBareValue() }
        }
      }
      attrs.push({ name, value })
    }
  }

  // 原文元素（script/style/textarea/title）：内容不当标签解析，读到对应的结束标签为止。
  const readRawText = (name) => {
    const close = '</' + name.toLowerCase()
    let out = ''
    for (;;) {
      const item = cur.peek()
      if (!item) return out
      if (!item.expr && item.ch === '<' && matchesAt(close)) {
        consume(close)
        readUntilChar('>')
        const gt = cur.peek()
        if (gt && !gt.expr && gt.ch === '>') cur.next()
        return out
      }
      if (item.expr) { cur.next(); continue }
      out += cur.next().ch
    }
  }

  for (;;) {
    const item = cur.peek()
    if (!item) break
    if (item.expr) { cur.next(); addExpression(item.expr); continue }
    if (item.ch !== '<') { addText(cur.next().ch); continue }
    // '<'：注释 / 结束标签 / 开标签 / 普通文本
    if (matchesAt('<!--')) {
      consume('<!--')
      let guard = 0
      while (cur.peek() && !matchesAt('-->') && guard++ < 1e6) cur.next()
      if (matchesAt('-->')) consume('-->')
      continue
    }
    if (matchesAt('<!')) {
      // `<!doctype html>` 这类声明不是元素：整段吃掉，别让它变成一个名为 `!doctype` 的节点
      // （否则「响应必须是完整 HTML 文档」这类断言会数错根节点）。
      consume('<!')
      while (cur.peek() && !(cur.peek().ch === '>')) cur.next()
      if (cur.peek()) cur.next()
      continue
    }
    const m = cur.mark()
    cur.next()
    const after = cur.peek()
    if (after && !after.expr && after.ch === '/') {
      cur.next()
      const after2 = cur.peek()
      if (after2 && !after2.expr && (after2.ch === '>' || after2.ch === '/')) {
        // `</>` / `<//>`：htm 的无名结束标签 = 关掉**最内层**元素（不是「忽略」：
        // 忽略会把后面的兄弟节点全塞进当前元素，`backup-list 在抽屉内` 这类断言就白给了）。
        while (cur.peek() && !(cur.peek().ch === '>')) cur.next()
        if (cur.peek()) cur.next()
        if (stack.length > 1) stack.pop()
        continue
      }
      const name = readName().toLowerCase()
      readUntilChar('>')
      const gt = cur.peek()
      if (gt && !gt.expr && gt.ch === '>') cur.next()
      // 出栈到匹配的同名元素（HTML 容错：多余的结束标签直接忽略）
      let idx = -1
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name.toLowerCase() === name) { idx = i; break }
      }
      if (idx > 0) stack.length = idx
      continue
    }
    if (!after || (!after.expr && !isNameChar(after.ch) && after.ch !== '>')) {
      // `<` 后面不是标签名：按文本处理
      cur.reset(m)
      addText(cur.next().ch)
      continue
    }
    const name = readName()
    if (name === '') { cur.reset(m); addText(cur.next().ch); continue }
    const { attrs, selfClosing, closed } = readAttrs()
    if (!closed) break // 模板末尾未闭合：不猜
    const el = { type: 'element', name, attrs, children: [] }
    addNode(el)
    if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) stack.push(el)
    if (!selfClosing && RAW_TEXT_TAGS.has(name.toLowerCase())) {
      const raw = readRawText(name) // 读到 `</title>` 为止（连结束标签一起吃掉）
      if (raw) el.children.push({ type: 'text', value: raw })
      if (stack.length > 1) stack.pop() // 结束标签已被吃掉 ⇒ 自己出栈
      continue
    }
  }
  return root
}

// 子树里的 html`` 模板，只保留**最外层**（模板里再嵌模板时，外层展开会一并展开内层；
// 若两级都算进「就地展开」，同一棵子树会被展开多次，元素被重复计数）。
function outermostTemplatesIn (node) {
  const out = []
  const visit = (current, insideTemplate) => {
    if (!current || typeof current.type !== 'string') return
    const isTemplate = current.type === 'TaggedTemplateExpression'
    if (isTemplate && !insideTemplate) out.push(current)
    const childInside = insideTemplate || isTemplate
    for (const key of Object.keys(current)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === 'string') visit(item, childInside)
      } else if (value && typeof value.type === 'string') {
        visit(value, childInside)
      }
    }
  }
  visit(node, false)
  return out
}

// 模板节点 → 元素树。
function markupOf (node, options = {}) {
  return parseSegments(segmentsOfTemplate(node), options)
}

// 运行期文本（HTTP 响应体 / 静态 HTML 夹具）→ 元素树。
function markupOfText (text, options = {}) {
  return parseSegments(segmentsOfText(text), options)
}

// 子树里的第一个函数声明（`function BackupBlock (…) {}`）。
function functionNodeOf (model, name) {
  return findFirst(model, (node) => node.type === 'FunctionDeclaration' && node.id && node.id.name === name)
}

// 函数体里第一段 html`` 模板（找不到返回 null —— 调用方断言「必须存在」）。
function templateOfFunction (model, name) {
  const fn = functionNodeOf(model, name)
  if (!fn) return null
  return findFirst(fn, (node) => node.type === 'TaggedTemplateExpression')
}

// 子树里所有 html`` 模板（按出现顺序）。
function templatesIn (node) {
  return findAll(node, (n) => n.type === 'TaggedTemplateExpression')
}

function walkElements (node, visit) {
  for (const child of node.children || []) {
    if (child.type !== 'element') continue
    visit(child)
    walkElements(child, visit)
  }
}

function allElements (root) {
  const out = []
  walkElements(root, (el) => out.push(el))
  return out
}

// name 省略 = 任意标签；name 按 ASCII 大小写不敏感（HTML 侧小写、htm 侧组件名大写都能匹配）。
function elementsNamed (root, name) {
  const want = typeof name === 'string' ? name.toLowerCase() : null
  return allElements(root).filter((el) => want === null || el.name.toLowerCase() === want)
}

function attrOf (el, name) {
  const want = name.toLowerCase()
  for (const attr of el.attrs) {
    if (attr.name && attr.name.toLowerCase() === want) return attr
  }
  return null
}

// 静态属性值（`title="…"`）：表达式绑定的属性返回 null（用 attrExpr 取）。
function attrText (el, name) {
  const attr = attrOf(el, name)
  return attr && attr.value.kind === 'text' ? attr.value.value : null
}

function attrExpr (el, name) {
  const attr = attrOf(el, name)
  return attr && attr.value.kind === 'expr' ? attr.value.node : null
}

function classNames (el) {
  const raw = attrText(el, 'class')
  return raw === null ? [] : raw.split(/\s+/).filter(Boolean)
}

function hasClass (el, cls) {
  return classNames(el).includes(cls)
}

// 文本内容（递归，空白折叠）：只取静态文本；表达式绑定（`${x}`）不参与。
function textOf (el) {
  let out = ''
  for (const child of el.children || []) {
    if (child.type === 'text') out += child.value
    else if (child.type === 'element') out += textOf(child)
  }
  return out.replace(/\s+/g, ' ').trim()
}

// 元素子树里**绑定表达式**的节点（`${…}` 位点），按出现顺序。用于「这一格里绑的是哪个调用/
// 哪个字段」这类接线断言：元素文本只能证明文案，表达式节点才证明数据来源。
function expressionsIn (el) {
  const out = []
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'expr') out.push(child.node)
      else if (child.type === 'element') visit(child)
    }
  }
  visit(el)
  return out
}

// 元素的**原始**文本（不折叠空白、保留换行）：`<pre>` 这种按行排版的块用它，
// 折叠后的 textOf 会把「每行一个状态」揉成一句，行级断言就无从下手。
function rawTextOf (el) {
  let out = ''
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'text') out += child.value
      else if (child.type === 'element') visit(child)
    }
  }
  visit(el)
  return out
}

module.exports = {
  markupOf,
  markupOfText,
  segmentsOfTemplate,
  functionNodeOf,
  templateOfFunction,
  templatesIn,
  allElements,
  elementsNamed,
  attrOf,
  attrText,
  attrExpr,
  classNames,
  hasClass,
  textOf,
  rawTextOf,
  expressionsIn
}
