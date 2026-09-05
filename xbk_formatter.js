'use strict'

/* eslint indent: off */
// Formatter extracted verbatim; integration remains the main entrypoint's responsibility.
function createFormatter ({ Utils, safeRe }) {
  if (!Utils || typeof safeRe !== 'function') throw new TypeError('createFormatter requires Utils and safeRe')
  const Formatter = {
  /** Markdown 收尾：合并连续换行 + 去首尾空白（短路与正常路径共用） */
  _finalizeMd (s) {
    // v3.245 P1：非 string 输入（undefined/null/对象/Symbol）String() 兜底，此前直接
    // s.replace 抛 TypeError 无防护。
    // v3.249：undefined/null/空串直接返回空——String(undefined)→'undefined' 会泄漏成字面文本
    if (s === undefined || s === null || s === '') return ''
    try { s = String(s) } catch (e) { return '' }
    return s.replace(/\n{3,}/g, '\n\n').trim()
  },

  /** 从 from 起引号感知扫描定位标签结束 >：引号值内 > 不算结束（与原属性扫描正则口径一致），
   *  引号未闭合退化为首个 > 结束（Round2 C045 口径）。返回 > 下标，未找到返回 -1。
   *  线性扫描，供 _replaceTagged/anchorText/scanConvert/scanStrip 共用（消除重复代码）。 */
  _findTagEnd (str, from) {
    let j = from
    while (j < str.length) {
      const c = str[j]
      if (c === '>') return j
      if (c === '"' || c === "'") {
        const closeQ = str.indexOf(c, j + 1)
        j = closeQ === -1 ? j + 1 : closeQ + 1
      } else j++
    }
    return -1
  },

  _readTagAttrValue (tag, index, end) {
    while (index < end && /\s/.test(tag[index])) index++
    if (index >= end) return ['', end]
    if (tag[index] === '"' || tag[index] === "'") {
      const quote = tag[index++]
      const start = index
      while (index < end && tag[index] !== quote) index++
      return index >= end ? ['', end] : [tag.slice(start, index), index + 1]
    }
    const start = index
    while (index < end && !/[\s>]/.test(tag[index])) index++
    return [tag.slice(start, index), index]
  },

  /** 读取单个标签的真实属性值，跳过其他属性的引号内容，避免把 title/data-* 中的 href/src 文本误当属性。 */
  _getTagAttr (tag, wantedName) {
    if (typeof tag !== 'string') return ''
    const wanted = wantedName.toLowerCase()
    const end = tag.endsWith('>') ? tag.length - 1 : tag.length
    let i = 1
    while (i < end && /[A-Za-z0-9]/.test(tag[i])) i++
    if (wanted === 'href' && /^<ahref\s*=/i.test(tag)) i = 2
    while (i < end) {
      while (i < end && /[\s/]/.test(tag[i])) i++
      const nameStart = i
      while (i < end && !/[\s"'/>=]/.test(tag[i])) i++
      if (nameStart === i) { i++; continue }
      const name = tag.slice(nameStart, i).toLowerCase()
      while (i < end && /\s/.test(tag[i])) i++
      if (tag[i] !== '=') continue
      const [value, next] = this._readTagAttrValue(tag, i + 1, end)
      i = next
      if (name === wanted) return value
    }
    return ''
  },

  /** 已知标签转换操作查找（v3.262 扫描器用）：语义与原 if 链逐条一致——p/div 前缀匹配
   *  （原 <\/?p 无 \b），img/td/th/tr/table 仅开标签（</td> 由通用剥离移除），li 开闭均可，其余词边界内。 */
  _tagOpFor (name, closing, wordAfter, tagOps) {
    if (name.startsWith('p')) return tagOps.p
    if (name.startsWith('div')) return tagOps.div
    if (wordAfter) return null
    const op = Object.hasOwn(tagOps, name) ? tagOps[name] : null
    if (op == null) return null
    if (closing && (name === 'img' || name === 'td' || name === 'th' || name === 'tr' || name === 'table')) return null
    return op
  },

  /**
   * 线性化「开标签 + 首个闭合标签」转换：替代 ([\\s\\S]*?)<\\/x> 无界惰性正则——大量未闭合
   * 开标签时每处起始位置都回扫到串尾呈 O(n²)，v3.254 的 100k 截断不能根治（100k 最坏形态
   * 仍 12-16s 卡死主线程）。改为单标签打开正则 + indexOf 定位首个闭合：开标签互不重叠、
   * 每处只向前扫一次 → 全程 O(n)。
   * @param {string} html 待处理串
   * @param {RegExp} openRe 全局开标签正则（仅匹配标签名前缀，不含属性扫描；首捕获组 [1] 供
   *   closeOf/buildReplacement 使用；标签结束 > 由函数内引号感知扫描定位，杜绝属性扫描回溯）
   * @param {(m: RegExpExecArray, content: string, openTag: string) => string} buildReplacement 构建替换文本
   * @param {(m: RegExpExecArray) => string} closeOf 计算闭合标签（小写）
   */
  _replaceTagged (html, openRe, buildReplacement, closeOf) {
    // v3.263（CodeAnt）：先标记引号属性值区间——<a>/<h> 若位于另一标签的引号属性值内则不转换
    // （未闭合标签按「剩余原样保留」兜底时，属性里的字面标签不得被伪造成 Markdown 链接/标题）
    const attrSpans = this._quotedAttrSpans(html)
    openRe.lastIndex = 0
    let out = ''
    let pos = 0
    let m
    while ((m = openRe.exec(html)) !== null) {
      if (attrSpans.has(m.index)) continue // 命中属性值区间：原样保留，交由后续标签剥离处理
      // 开标签结束 >：引号值内 > 不算结束；无 > 视为无法转换（本处及之后无完整配对，剩余原样保留）
      const openEndRel = this._findTagEnd(html, m.index + m[0].length)
      if (openEndRel === -1) {
        out += html.slice(pos)
        pos = html.length
        break
      }
      const openEnd = openEndRel + 1
      const closeTag = closeOf(m)
      // v3.263：闭合搜索改用原串上的 i 标志正则——toLowerCase 在 İ(U+0130) 等字符上会展开为
      // 2 个码元，导致 lower 的索引相对原串错位（锚点/标题内容尾部多出 <、script 后内容丢首字符）。
      // lastIndex 线性推进，全程 O(n)，索引与 html 严格对齐。
      const closeRe = safeRe(closeTag, 'gi')
      closeRe.lastIndex = openEnd
      const closeM = closeRe.exec(html)
      if (closeM === null) {
        // 无闭合标签：本处及之后不再有可完整转换的配对，剩余原样保留（与原正则不产生匹配一致）
        out += html.slice(pos)
        pos = html.length
        break
      }
      const closeRel = closeM.index
      const closeEnd = closeRel + closeTag.length
      const content = html.slice(openEnd, closeRel)
      const openTag = html.slice(m.index, openEnd)
      out += html.slice(pos, m.index) + buildReplacement(m, content, openTag)
      pos = closeEnd
      openRe.lastIndex = closeEnd // 跳过已消费的开标签与闭合，避免重复扫描
    }
    if (pos < html.length) out += html.slice(pos)
    return out
  },

  /** 引号属性值区间标记：返回 Set<index>，命中表示该位置位于某标签的引号属性值内。
   *  与 _findTagEnd 同构的引号语义（跳到同引号下一次出现；未闭合引号视为延伸到串尾）。 */
  _quotedAttrSpans (html) {
    const inside = new Set()
    let inTag = false
    let i = 0
    while (i < html.length) {
      const c = html[i]
      if (!inTag) {
        const n = html[i + 1]
        if (c === '<' && n && (n === '/' || /[a-zA-Z]/.test(n))) inTag = true
        i++
        continue
      }
      if (c === '>') {
        inTag = false
        i++
        continue
      }
      if (c === '"' || c === "'") {
        i = this._markQuotedSpan(html, c, i, inside)
        continue
      }
      i++
    }
    return inside
  },

  /** 标记单个引号属性值跨度（供 _quotedAttrSpans 使用）：返回扫描结束位置；未闭合引号视为延伸到串尾。 */
  _markQuotedSpan (html, quote, from, inside) {
    const closeQ = html.indexOf(quote, from + 1)
    if (closeQ === -1) {
      for (let k = from + 1; k < html.length; k++) inside.add(k)
      return html.length
    }
    for (let k = from + 1; k < closeQ; k++) inside.add(k)
    return closeQ + 1
  },

  htmlToMarkdown (shuju) {
    shuju = Utils.safeObjectCopy(shuju || {})
    let html = (typeof shuju.content_html === 'string')
      ? shuju.content_html
      : '' // 非字符串内容视为空（避免 [object Object]）
    // v3.254 P1(ReDoS)：`<a>`/`<h1-6>` 正则曾用无界惰性 [\s\S]*? 接固定闭合标签且带 g，
    // 多个未闭合标签时每次起始位置回扫到串尾呈 O(n²)——content_html 来自外部接口可被
    // 构造为 10 万+ 字符卡死主线程。v3.254 的 100k 截断只能把最坏输入压到 ~100k（实测
    // 仍 12-16s）。v3.261：h/a/script/style 全部改为 _replaceTagged 线性定位（开标签互不
    // 重叠、indexOf 找首个闭合，全程 O(n)），入口截断保留作为下游（解码/清洗）的防护。
    if (html.length > 100000) html = Utils.truncateUtf16(html, 100000)
    // URL 文本/目标统一使用 safeUrl：非字符串、空值、伪 URL、危险协议和换行都不生成 Markdown 链接。
    const urlText = Utils.safeUrl(shuju && shuju.url)
    const safeUrl = urlText
    // url 含 Markdown 特殊字符(空格/括号/])时用 <> 包裹（短路与正常路径共用）
    const mdUrl = safeUrl && /[\s()[\]]/.test(safeUrl) ? `<${safeUrl}>` : safeUrl
    // 显示文本转义：urlText 原样插入 [] 会被 Markdown 特殊字符(] [ \\)破坏，转义后与 mdUrl 口径一致
    const mdLinkText = urlText ? urlText.replace(/[[\]\\]/g, '\\$&') : urlText
    // 无标签内容短路：跳过整个替换链（性能优化）
    if (!html.includes('<')) {
      html = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(html))
      return this._finalizeMd(mdUrl ? html + `\n\n原文链接：[${mdLinkText}](${mdUrl})` : html)
    }
    // P10/C008：锚点文本处理逻辑与原实现逐字一致（嵌套 <a> 剥离、实体解码、] ( 转义）
    // 解析 < 后的标签名：返回 {i: 属性起点, closing, name(小写), wordAfter}；< 后非字母时 name 为空串
    const readTagName = (txt, lt) => {
      let i = lt + 1
      const closing = txt[i] === '/'
      if (closing) i++
      const nameStart = i
      while (i < txt.length && /[a-zA-Z]/.test(txt[i])) i++
      return {
        i,
        closing,
        name: txt.slice(nameStart, i).toLowerCase(),
        wordAfter: i < txt.length && /[a-zA-Z0-9]/.test(txt[i])
      }
    }
    const anchorText = (txt) => {
      // v3.262 线性化：原 replace+split 正则链在「大量 <a 前缀且无闭合 >」的长文本上逐位重扫 O(n²)
      // （单条 <a href=x> + <a 重复 + </a> 即可卡主线程）；改为单趟扫描：标签段原样保留、其余段
      // 解码并转义，<a...>/</a> 整段剥除，全程线性，语义与原实现逐字一致。
      const esc = (s2) => Utils.decodeHtmlEntities(s2).replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[[\]\\]/g, String.raw`\$&`)
      let out = ''
      let pos = 0
      while (pos < txt.length) {
        const lt = txt.indexOf('<', pos)
        if (lt === -1) { out += esc(txt.slice(pos)); break }
        const { i, name, wordAfter } = readTagName(txt, lt)
        const gt = this._findTagEnd(txt, i)
        if (gt === -1) { out += esc(txt.slice(pos)); break }
        if (gt === lt + 1) { out += esc(txt.slice(pos, lt + 1)); pos = lt + 1; continue } // <> 不算标签，按文本转义（原 + 需至少 1 字符）
        const isA = name === 'a' && !wordAfter // 嵌套 <a...>/</a> 整段剥除（原 <a\b...>/<\/a\b\s*>）
        out += esc(txt.slice(pos, lt)) + (isA ? '' : txt.slice(lt, gt + 1))
        pos = gt + 1
      }
      return out
    }
    html = this._replaceTagged(html, /<h([1-6])/gi,
      (m, c) => '#'.repeat(Number(m[1])) + ' ' + c + '\n\n',
      (m) => '</h' + m[1] + '>')
    // P1（审查 2026-08-15）：href 引号/无引号两形态合并——开标签正则仅匹配 <a 前缀（无属性扫描
    // 无回溯），href 值从开标签段内引号感知提取；原两正则语义一致（<ahref 无空格形态除外，
    // 非合法 HTML 不再转换，由下方扫描器按普通标签剥离）。v3.263：<a 后仅接受空白/紧接 >/href=
    // （<area/<abbr/<article 等更长标签名不再误当锚点；<ahref 无空格形态保持转换，审查4-5 锁定），
    // href 前不允许 -/_ 属性名续接（data-href/data_href 不再误取链接目标）。
    html = this._replaceTagged(html, /<a(?=[\s>]|href\s*=)/gi,
      (m, txt, openTag) => {
        const cleanHref = Utils.safeUrl(this._getTagAttr(openTag, 'href'))
        return cleanHref ? `[${anchorText(txt)}](${cleanHref})` : anchorText(txt)
      },
      () => '</a>')
    // 线性标签转换/剥离（v3.262）：两阶段单趟扫描替代原 11 个 replace 链 + 通用剥离 + script/style 区域移除。
    // 原正则链在「大量同前缀标签且无闭合 >」的输入上逐位重扫呈 O(n²)——<p 重复 28600 次实测 ~6s、
    // <h1 重复 ~9s、<td 重复 ~10s，单条外部消息即可触发 DoS（入口 100k 截断只能压到有界常数）。
    // 阶段一：只转换已知标签（img/br/p/div/li/ul/ol/b/strong/i/em/td/th/tr/table）与 script/style 区域移除，
    // 未知标签原样保留——'<<100</p>' 中的 << 先按字面文本处理（< 后非字母），不吞并后续已知标签，
    // 与原链「先逐标签替换、最后统一剥离」的顺序语义一致；阶段二：通用剥离剩余 <...>（含 <<a> 整体）。
    // 引号值内 > 不算标签结束；引号未闭合时退化按首个 > 结束（Round2 C045 口径，与原 [^>] 行为一致）。
    // p/div 无词边界按前缀匹配（原 <\/?p 无 \b，<pre> 同样转 \n\n）；其余标签名后须非词字符（\b 语义）；
    // td/th/tr/table 只转换开标签（原正则无 \/?，</td> 由通用剥离移除）。
    // script/style 按 HTML 语义整体移除（内容直至 </script>；无闭合则丢弃至末尾），且只识别真实
    // 标签位置——`data-x="<script>"` 这类属性值内的 <script 不再误触发整段丢弃。
    html = (() => {
      const tagOps = {
        img: (tag) => {
          const srcValue = this._getTagAttr(tag, 'src')
          if (!srcValue) return tag // 无 src 不转换（原链由通用剥离兜底剥空）
          const src = Utils.safeUrl(srcValue)
          if (!src) return tag.replace(/\bsrc\s*=\s*(?:(["'])[^"']*\1|[^\s"'<>`]+)/i, '') // 空/危险 src 不生成可执行图片链接
          // alt 截断（真实接口 alt 可长达 250+字符拖累推送）——代理对安全
          const alt = Utils.truncateUtf16(this._getTagAttr(tag, 'alt'), 50)
          // C008 二次修复：alt 实体解码后直接转义（&#93; → \] 等），与 anchor 文本同口径
          const altText = alt ? Utils.decodeHtmlEntities(alt).replace(/[[\]\\]/g, '\\$&') : ''
          return `\n\n![${altText}](${src})\n\n`
        },
        br: () => '\n\n',
        p: () => '\n\n',
        div: () => '\n\n',
        li: (tag, closing) => closing ? '\n' : '\n- ',
        ul: () => '\n',
        ol: () => '\n',
        b: () => '**',
        strong: () => '**',
        i: () => '*',
        em: () => '*',
        td: () => ' | ',
        th: () => ' | ',
        tr: () => '\n',
        table: () => '\n\n'
      }
      // 阶段一：转换已知标签 + script/style 区域移除；未知标签原样保留
      // 单个 < 标签处理一步：返回 {out, next}；stop=true 表示本处起剩余原样保留（无闭合结构）
      const convertStep = (str, lt, pos, tagOps) => {
        const { i, closing, name, wordAfter } = readTagName(str, lt)
        if (name === '') {
          // < 后非字母：按字面文本处理（'<<100</p>' 的 << 不吞并后续已知标签）
          return { out: str.slice(pos, lt + 1), next: lt + 1 }
        }
        if (!wordAfter && !closing && (name === 'script' || name === 'style')) {
          // script/style：内容直至 </x> 整体移除；无闭合则丢弃至末尾（HTML 语义：内容到 EOF）
          // v3.263：同 _replaceTagged——原串 i 标志正则定位闭合（toLowerCase 长度展开会让索引错位）
          const closeRe = safeRe('</' + name + '>', 'gi')
          closeRe.lastIndex = lt + 1
          const closeM = closeRe.exec(str)
          if (closeM === null) return { out: str.slice(pos, lt), stop: true }
          return { out: str.slice(pos, lt), next: closeM.index + name.length + 3 }
        }
        const gt = this._findTagEnd(str, i)
        if (gt === -1) return { out: str.slice(pos), stop: true }
        const tag = str.slice(lt, gt + 1)
        const op = this._tagOpFor(name, closing, wordAfter, tagOps)
        if (op == null) return { out: str.slice(pos, gt + 1), next: gt + 1 } // 未知标签原样保留
        const replaced = op(tag, closing)
        // img 无 src 返回原标签——由通用剥离兜底剥空（其余 op 替换文本均非原标签）
        return {
          out: str.slice(pos, lt) + (op === tagOps.img && replaced === tag ? '' : replaced),
          next: gt + 1
        }
      }
      const scanConvert = (str) => {
        let out = ''
        let pos = 0
        while (pos < str.length) {
          const lt = str.indexOf('<', pos)
          if (lt === -1) { out += str.slice(pos); break }
          const step = convertStep(str, lt, pos, tagOps)
          out += step.out
          if (step.stop) break
          pos = step.next
        }
        return out
      }
      // 阶段二：通用剥离剩余 <...>（原 <(?:...)+> 兜底；<> 保留）
      const scanStrip = (str) => {
        let out = ''
        let pos = 0
        const knownTags = new Set(['a', 'br', 'p', 'div', 'li', 'ul', 'ol', 'b', 'strong', 'i', 'em', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'tr', 'table', 'script', 'style', 'input', 'link', 'blockquote'])
        const unknownPairs = []
        const lowerStr = str.replace(/[A-Z]/g, c => c.toLowerCase())
        const quotedAttrSpans = this._quotedAttrSpans(str)
        const findUnknownClose = (name, from) => {
          const needle = `</${name}`
          for (let i = lowerStr.indexOf(needle, from); i !== -1; i = lowerStr.indexOf(needle, i + 1)) {
            if (quotedAttrSpans.has(i)) continue
            const end = i + needle.length
            let j = end
            while (j < str.length && /\s/.test(str[j])) j++
            if (str[j] === '>') return i
          }
          return -1
        }
        while (pos < str.length) {
          const lt = str.indexOf('<', pos)
          if (lt === -1) { out += str.slice(pos); break }
          const gt = this._findTagEnd(str, lt + 1)
          if (gt === -1) { out += str.slice(pos); break }
          // 只有看起来像 HTML 标签的片段才剥离；`2 < 3 > 1`、`<world>` 等普通文本保留。
          const tagStart = str[lt + 1] === '/' ? lt + 2 : lt + 1
          const nameM = /^[a-z][a-z0-9-]*/i.exec(str.slice(tagStart, gt))
          const name = nameM ? nameM[0].toLowerCase() : ''
          const isClosing = str[lt + 1] === '/'
          const looksLikeClosedUnknown = name && !knownTags.has(name) &&
            !isClosing && findUnknownClose(name, gt + 1) !== -1
          const isTrackedUnknownClose = isClosing && unknownPairs.length > 0 && unknownPairs[unknownPairs.length - 1] === name
          if (gt === lt + 1 || !name || (!knownTags.has(name) && !looksLikeClosedUnknown && !isTrackedUnknownClose)) {
            // 未闭合的未知片段更可能是普通文本（如 `<world>`）；保留当前字符继续扫描。
            // `<<>>` 仍按历史语义丢弃首个尖括号，避免旧的畸形输入断言回归。
            if (!name && str[lt + 1] === '<') {
              out += str.slice(pos, lt)
              pos = lt + 1
            } else {
              out += str.slice(pos, lt + 1)
              pos = lt + 1
            }
            continue
          }
          if (looksLikeClosedUnknown) unknownPairs.push(name)
          if (isTrackedUnknownClose) unknownPairs.pop()
          out += str.slice(pos, lt)
          pos = gt + 1
        }
        return out
      }
      return scanStrip(scanConvert(html))
    })()
      .replace(/\n{3,}/g, '\n\n')
    // 先移除真实 HTML 标签，再解码实体；实体解码可能重新形成标签，需再次清理主动内容/危险属性。
    html = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(html))
    const result = html + (mdUrl ? `\n\n原文链接：[${mdLinkText}](${mdUrl})` : '')
    // 模板拼接后再次合并连续换行（内容尾部 \n\n + 模板 \n\n 会拼出 3+ 连换行）
    return this._finalizeMd(result)
  },

  tuisong_replace (text, shuju) {
    // 防御：模板缺失/非字符串时转空串或字符串化，避免 text.includes 崩溃
    // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 视为空模板
    try { text = text === undefined || text === null ? '' : String(text) } catch (e) { text = '' }
    const data = Utils.safeObjectCopy(shuju)

    if (data.category_name) data.catename = data.category_name
    if (data.category_id) data.cateid = data.category_id // 与 category_name→catename 对称（修复 {分类ID} 恒空）

    const timeSource = (data.posttime !== undefined && data.posttime !== null && data.posttime !== '')
      ? data.posttime
      : (data.shijianchuo !== undefined && data.shijianchuo !== null && data.shijianchuo !== '' ? data.shijianchuo : undefined)
    if (timeSource !== undefined && !data.datetime) {
      // 统一解析（v3.62 与 daysComputed 共用 parseTime，消除重复逻辑）：
      // 秒/毫秒时间戳、8 位日期、YYYY-MM-DD、ISO 全部同一口径
      const t = Utils.parseTime(timeSource)
      if (t === null || t < 0) {
        // 非法/负时间戳：不生成日期（留空），避免回退当前时间或 1969 误导
        data.datetime = undefined
        data.shorttime = undefined
      } else {
        const dt = new Date(t)
        // v3.115 时区统一：与 parseTime 的 UTC 解析口径一致——getUTC* 保证跨时区部署
        // 日期时间显示一致；顺带修复 getHours 无 add0（+8 时区输出 '1:30' 而非 '01:30'）
        data.datetime = `${dt.getUTCFullYear()}-${Utils.add0(dt.getUTCMonth() + 1)}-${Utils.add0(dt.getUTCDate())}`
        data.shorttime = `${Utils.add0(dt.getUTCHours())}:${Utils.add0(dt.getUTCMinutes())}`
      }
    }

    // 惰性计算：只有模板里真正用到 {Html内容} / {Markdown内容} 时才跑一遍替换/正则，
    // 避免像 App.run 里那样对同一条数据分别调用 tuisong_replace 生成 text/desp 时，
    // 没用到 Markdown 的那次也白白算一遍 htmlToMarkdown
    // url 做 HTML 转义，避免特殊字符破坏 <a href="..."> 结构；换行先剥离（v3.85，与 linkText 口径一致）；非字符串视为无链接（R6-1）
    const rawUrl = Utils.safeUrl(Utils.safeGet(data, 'url'))
    const safeHtmlUrl = rawUrl
    const escUrl = safeHtmlUrl
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 与 htmlToMarkdown 口径一致：非字符串 content_html 视为空（避免 [object Object] 泄漏）
    // {Html内容} 会在 wxpusher 等通道以 HTML 类型渲染；实体解码后再次清理主动标签、事件属性和危险 URL，
    // 防止接口 content_html 中的 <script>/onerror 或 &lt;script&gt; 进入客户端渲染。
    const hasHtmlPlaceholder = text.includes('{Html内容}')
    const hasMarkdownPlaceholder = text.includes('{Markdown内容}')
    let rawHtml = ''
    if (hasHtmlPlaceholder || hasMarkdownPlaceholder) {
      // 惰性计算：仅在模板确实用到 {Html内容}/{Markdown内容} 时才做实体解码+清洗；
      // 模板只含 {标题} 时跳过，避免超长 content_html 全量清洗拖慢推送。
      let raw = data.content_html
      if (typeof raw !== 'string') raw = ''
      // 与 htmlToMarkdown 对齐：超长截断到 10 万字符，防未闭合主动标签堆叠导致回溯式 ReDoS。
      if (raw.length > 100000) raw = raw.slice(0, 100000)
      rawHtml = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(raw))
    }
    // {链接} 占位符 Markdown 安全化（v3.74）：与 htmlToMarkdown 的 mdUrl 同口径——
    // 含空格/括号/] 用 <> 包裹、剥离换行（原样输出会在 Markdown 链接场景破坏）
    const linkText = () => {
      // R6-1：非字符串视为无链接（与 htmlToMarkdown urlText 同口径）
      const u = Utils.safeUrl(Utils.safeGet(data, 'url'))
      return u && /[\s()[\]]/.test(u) ? `<${u}>` : u
    }
    const getContentHtml = () => safeHtmlUrl
      ? `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="${escUrl}" target="_blank">${escUrl}</a><br>&nbsp;<br>&nbsp;<br>`
      : `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：${escUrl}<br>&nbsp;<br>&nbsp;<br>`

    const map = {
      '{标题}': data.title,
      '{内容}': data.content,
      '{Html内容}': text.includes('{Html内容}') ? getContentHtml() : undefined,
      '{Markdown内容}': text.includes('{Markdown内容}') ? this.htmlToMarkdown(data) : undefined,
      '{分类名}': data.catename,
      '{分类ID}': data.cateid,
      '{链接}': text.includes('{链接}') ? linkText() : undefined,
      '{日期}': data.datetime,
      '{时间}': data.shorttime,
      '{楼主}': data.louzhu,
      '{类目}': data.catename, // 与 {分类名} 统一来源（归一化后 catename 恒有值）
      '{价格}': data.price,
      '{商城}': data.mall_name,
      '{品牌}': data.brand,
      // v3.262：与 {链接}/{Html内容} 同口径走统一安全 URL 入口，防接口 pic 被污染为
      // javascript:/data: 等危险协议后原样进入模板（Markdown 图片/HTML 渲染通道）
      '{图片}': Utils.safeUrl(Utils.safeGet(data, 'pic'))
    }

    for (const [key, val] of Object.entries(map)) {
      // v3.237：字面量替换（split/join）替代 new RegExp(key)——占位符是固定文本而非正则模式，
      // 避免每次调用重建 14 个正则对象 + 消除占位符含正则元字符（$ ( [ 等）时的隐式陷阱。
      // 语义等价：replace(/X/g, fn) 对字面量 X ≡ split('X').join(fn())。
      text = text.split(key).join(Utils.safeText(val))
    }
    // v3.110：输出统一清洗孤立代理（encodeURIComponent 会崩；所有模板路径受益）
    return Utils.sanitizeSurrogates(text)
  }
  }

  return Formatter
}

module.exports = { createFormatter }
