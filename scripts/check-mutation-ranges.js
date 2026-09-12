#!/usr/bin/env node
// 变异测试行段覆盖校验（v3.270 新增）：
// mutation.yml 的 mutate 行段是硬编码的，曾因文件增长静默漏测尾部 430 行
// （v3-part4 只到 4494，实际文件 4924 行）。本脚本校验：
//   1. mutation.yml 中每个长文件的行段必须覆盖到当前实际行数（无静默漏测）
//   2. 行段之间连续无缝隙、不重叠
// 用法：node scripts/check-mutation-ranges.js
// 退出码：0 = 通过；1 = 存在漏测或行段错误。CI/提交前均可运行。
'use strict'
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const workflowPath = path.resolve(process.env.MUTATION_WORKFLOW_PATH || path.join(root, '.github/workflows/mutation.yml'))
const yml = process.env.MUTATION_WORKFLOW_TEXT || fs.readFileSync(workflowPath, 'utf8') // nosemgrep（仓库内固定路径，非用户输入）

// matrix include 的唯一解析器：`- name:` / `- src:` / `- mutate:` 任一开头都算新条目，
// 引号（单/双）与缩进放宽，字段值停在空白或 #。
// 行段与 mutate 目标都从这里派生——避免「两个解析器口径不一致」（曾出现：条目校验接受单引号
// mutate，而旧的 range/target 正则只认双引号 → 合法 yml 被误报漏测）。
const ymlLines = yml.split(/\r?\n/)
const includeIdx = ymlLines.findIndex(line => /^\s*include:\s*$/.test(line))
const includeIndent = includeIdx === -1 ? -1 : ymlLines[includeIdx].match(/^\s*/)[0].length
const matrixEntries = []
let currentEntry = null
if (includeIdx !== -1) {
  for (const line of ymlLines.slice(includeIdx + 1)) {
    const indent = line.match(/^\s*/)[0].length
    if (/^\s*[A-Za-z_][\w-]*:/.test(line) && indent <= includeIndent) break // include 块结束（回到 steps: 等同级键）
    const trimmed = line.trim()
    let body = trimmed
    if (trimmed.startsWith('-')) {
      // 条目起始放宽：`- name:`、`-name:`、`-\tname:` 均视为新条目（曾漏掉无空格/制表符前缀的
      // 写法，导致条目字段缺失被误报成「缺 name」）；但去掉 `-` 前缀后为空或以 `#` 开头
      // （如 `- # 纯注释`、`-#注释`）的不算新条目，避免生成全空条目触发「缺 name 字段」误报。
      const rest = trimmed.slice(1).trim()
      if (rest === '' || rest.startsWith('#')) continue
      currentEntry = { name: null, src: null, mutate: null }
      matrixEntries.push(currentEntry)
      body = rest
    }
    if (!currentEntry) continue
    // 字段解析走字符串切片而非正则：`\s*-?\s*` 这类相邻量词会被静态分析判为可回溯超线性（Sonar S8786）
    const colon = body.indexOf(':')
    if (colon <= 0) continue
    const key = body.slice(0, colon)
    if (key !== 'name' && key !== 'src' && key !== 'mutate') continue
    let value = body.slice(colon + 1).trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      // 引号标量：内部的 # 属于值而非注释；`''`/`""` 是转义后的引号本身——连续两个相同
      // 引号折叠为一个并继续扫描，到真正的闭合引号为止；未闭合时回退为去掉开引号取全部
      // （防御性处理——仓库 yml 统一双引号，但解析器不应在首个相遇处误截断）。
      let raw = ''
      for (let i = 1; i < value.length; i++) {
        const ch = value[i]
        if (ch !== quote) { raw += ch; continue }
        if (value[i + 1] === quote) { raw += quote; i++ } else break // 闭合引号
      }
      value = raw
    } else {
      const hash = value.indexOf('#') // 裸标量：行内注释从 # 开始
      if (hash !== -1) value = value.slice(0, hash)
    }
    value = value.trim()
    if (value) currentEntry[key] = value
  }
}

const fileRanges = new Map()
const mutateTargets = new Set()
for (const entry of matrixEntries) {
  if (!entry.mutate) continue
  const [file, range] = entry.mutate.split(':')
  mutateTargets.add(file)
  if (range && /^\d+-\d+$/.test(range)) {
    const [start, end] = range.split('-').map(Number)
    if (!fileRanges.has(file)) fileRanges.set(file, [])
    fileRanges.get(file).push({ start, end })
  }
}

const productionFiles = [
  ...fs.readdirSync(root).filter(file => /^xbk_.*\.js$/.test(file)),
  'qinglong/xbk_push.js',
  'scripts/check-deps.js'
]

if (fileRanges.size === 0) {
  console.error('❌ 未在 mutation.yml 中解析到任何 mutate 行段（格式应为 "file.js:start-end"）')
  process.exit(1)
}

let failed = false
for (const file of productionFiles) {
  if (!mutateTargets.has(file)) {
    console.error(`❌ ${file}: 未列入 mutation.yml 的 mutate 目标`)
    failed = true
  }
}

// 校验 0：matrix include 每项必须有 name、src 与其 mutate 目标同文件（解析见文件顶部）。
// 背景：src 只被 actions/cache 的 hashFiles 指纹使用（mutation.yml），写错或整行删掉都不会让 CI 报错，
// 只会让该段的缓存指纹失真（缓存串段 / 永不过期）；缺 name 的条目则会让缓存 key 变成 stryker-undefined-*。
if (matrixEntries.length === 0) {
  console.error('❌ 未在 mutation.yml 的 matrix include 中解析到任何条目')
  failed = true
}
for (const entry of matrixEntries) {
  const label = entry.name || '(无 name)'
  if (!entry.name) {
    console.error('❌ matrix 条目缺 name 字段（缓存 key 会退化为 stryker-undefined-*）')
    failed = true
  }
  if (!entry.mutate) {
    console.error(`❌ matrix「${label}」缺 mutate 字段`)
    failed = true
  } else if (!entry.src) {
    console.error(`❌ matrix「${label}」缺 src 字段（缓存指纹会退化为空 → 缓存串段）`)
    failed = true
  } else if (entry.src !== entry.mutate.split(':')[0]) {
    console.error(`❌ matrix「${label}」src(${entry.src}) 与 mutate 目标(${entry.mutate}) 不一致`)
    failed = true
  }
}

// 依赖模块加载的友好降级：mutation-report.js / stryker.config.js 未来若在顶层抛错或引入副作用，
// checker 不应裸栈崩溃，而要指明是哪个模块加载失败并以 exit 1 退出。
function requireOrDie (modulePath, displayName) {
  try {
    return require(modulePath)
  } catch (err) {
    console.error(`❌ 无法加载 ${displayName}（${modulePath}）：${err.message}`)
    process.exit(1)
  }
}

// 校验 0.5：矩阵 name 必须与 mutation-report 的 EXPECTED_SEGMENTS 一致（含重复检测）。
// 背景：name 写错/漏改要等 report 阶段 validateSegments() 才 throw —— 那时整轮矩阵（小时级）已经白跑。
const expectedSegments = requireOrDie('../scripts/mutation-report.js', 'mutation-report.js').EXPECTED_SEGMENTS || []
const matrixNames = matrixEntries.map(entry => entry.name).filter(Boolean)
const dupNames = [...new Set(matrixNames.filter((name, i) => matrixNames.indexOf(name) !== i))]
const nameMissing = expectedSegments.filter(name => !matrixNames.includes(name))
const nameExtra = matrixNames.filter(name => !expectedSegments.includes(name))
if (dupNames.length) {
  console.error(`❌ matrix name 重复：${dupNames.join(', ')}（缓存 key 会互相覆盖）`)
  failed = true
}
if (nameMissing.length) {
  console.error(`❌ mutation-report 期望的分段未出现在矩阵：${nameMissing.join(', ')}`)
  failed = true
}
if (nameExtra.length) {
  console.error(`❌ 矩阵含 mutation-report 不认识的段名：${nameExtra.join(', ')}`)
  failed = true
}

// 校验 0.6：stryker.config.js 的 mutate 必须与矩阵文件集完全一致。
// 背景：本地 `npm run test:mutation` 走 config 的清单，与 CI 矩阵漂移会「本地少跑/多跑」而无人知
// （实际漏过 scripts/check-deps.js）。
// stryker 的 mutate 原生支持 glob 写法（如 'xbk_*.js'）：含通配符的条目无法字符串精确比对，
// 硬比会把「被 glob 覆盖的矩阵目标」误报成「缺矩阵目标」。处理：glob 条目输出提示并跳过精确
// 比对，改用最小 glob→RegExp 判定矩阵目标是否可能被覆盖；非 glob 条目仍严格比对，通过/失败
// 语义与历史一致（当前 config 无 glob 时行为完全不变）。
const configMutateRaw = requireOrDie('../stryker.config.js', 'stryker.config.js').mutate || []
const globChars = /[*?[\]{}]/
const configGlob = configMutateRaw.filter(item => globChars.test(item))
const configMutate = new Set(configMutateRaw.filter(item => !globChars.test(item)))

// 最小 glob→RegExp（仅为「矩阵目标是否可能被 glob 覆盖」的判定服务）：
// `*`/`?` 不跨 `/`，`{a,b}` 为交替，`[...]` 为字符类（`!`/`^` 开头取反，内部保留 `-` 范围）；
// 无法安全解析的结构（空类、含 `\`/`^` 的类、含通配符的交替项）一律按字面处理——宁可继续报
// 「缺矩阵目标」，也不能把不存在的覆盖说成存在。
// `**`（globstar）在「路径开头或紧跟 / 后」实现真实递归匹配——`**/` 匹配零个或多个目录段
// （`(?:[^/]*/)*`，可跨 `/`），末尾 `**`（如 `scripts/**`）递归匹配其后所有层
// （`[^/]*(?:/[^/]*)*`）。两者均在每次迭代中带显式分隔符 `/`，无嵌套/相邻量词，线性安全
// （Sonar S8786 把 `(?:.*.*)` 这类判为可回溯超线性，此处避免）。此前把 `**` 折叠成单个 `*`
// （[^/]*）无法跨目录，导致 `**/xbk_*.js` 这类覆盖文件被误报成 configMissing（#131 缺陷C）。
// 字符类内 `-` 范围合法性：`x-y` 要求 x <= y（乱序范围如 `0--`/`z-a` 直接拼进字符类会让
// new RegExp 抛「Range out of order in character class」）。首/尾位置的 `-` 是字面量不算范围；
// `-` 相邻 `-`（如 `a--z`）无法确定语义，同样判为不安全。不安全 → 整个类按字面 `[` 处理。
function rangesOrdered (cls) {
  for (let k = 0; k < cls.length; k++) {
    if (cls[k] !== '-') continue
    if (k === 0 || k === cls.length - 1) continue // 首/尾 `-` 为字面量
    const prev = cls[k - 1]
    const next = cls[k + 1]
    if (prev === '-' || next === '-') return false // 连续 `-`：无法确定语义，按字面处理
    if (prev.charCodeAt(0) > next.charCodeAt(0)) return false // 乱序范围 → new RegExp 会抛错
  }
  return true
}

// 递归列举仓库根下的 .js/.mjs/.cjs 生产文件（供 glob 展开匹配），忽略 test_*.js、node_modules、.git。
// 返回相对仓库根的路径（'/' 分隔）。用于缺陷B：把 stryker 的 glob 条目展开成「实际会跑的仓库文件」，
// 再与矩阵 mutateTargets 双向比对，检出「矩阵没覆盖但本地会跑」的多余文件。
function listRepoJsFiles () {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const full = rel === '' ? root : path.join(root, rel)
    let entries
    try { entries = fs.readdirSync(full, { withFileTypes: true }) } catch (e) { continue }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const child = rel === '' ? ent.name : rel + '/' + ent.name
      if (ent.isDirectory()) stack.push(child)
      else if (/(?:\.js|\.mjs|\.cjs)$/.test(ent.name) && !/^test_.*\.js$/.test(ent.name)) out.push(child)
    }
  }
  return out
}

function globToRegExp (pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      // 收起连续的 `*`，先判 globstar（`**` 且位于路径开头或紧跟 / 后）：
      //   - `**/`：匹配零个或多个「目录/」段（可跨 /），消费掉紧随的 `/`（0 层时无前导 /）
      //   - 末尾 `**`：递归匹配其后所有层（如 `scripts/**`）
      //   - 其余位置的 `**`（段中间，如 `a/**b`）：保守按单 `*` 处理，避免跨分隔符误报覆盖
      let j = i
      while (pattern[j + 1] === '*') j++
      const isGlobstar = j - i + 1 >= 2 && (i === 0 || pattern[i - 1] === '/')
      if (isGlobstar && pattern[j + 1] === '/') {
        out += '(?:[^/]*/)*'
        i = j + 1 // 消费 `**` 及紧随的 `/`：`**/` 整体表示「零个或多个 dir/」
        continue
      }
      if (isGlobstar && j === pattern.length - 1) {
        out += '[^/]*(?:/[^/]*)*' // 末尾 globstar：递归匹配其余所有层
        i = j
        continue
      }
      out += '[^/]*'
      i = j
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const close = pattern.indexOf('}', i + 1)
      const alts = close === -1 ? null : pattern.slice(i + 1, close).split(',')
      if (alts && alts.length >= 2 && alts.every(a => a && !globChars.test(a))) {
        out += '(?:' + alts.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
        i = close // 循环 i++ 跳过 `}`
      } else {
        out += '\\{'
      }
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close !== -1) {
        let cls = pattern.slice(i + 1, close)
        let negate = ''
        if (cls[0] === '!' || cls[0] === '^') { negate = '^'; cls = cls.slice(1) }
        // 类内仅接受字面与 `-` 范围；含 `\`/`]`/`[`/`^`、空类或乱序范围（`0--` 等会让 new RegExp
        // 抛 Range out of order）一律按字面 `[` 处理——生成的 RegExp 必须永远合法（绝不崩溃，也绝不虚报覆盖）
        if (cls && !/[\\\]\[\^]/.test(cls) && rangesOrdered(cls)) {
          out += '[' + negate + cls + ']'
          i = close // 循环 i++ 跳过 `]`
        } else {
          out += '\\['
        }
      } else {
        out += '\\['
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(out + '$')
}

// 暴露给测试：glob→RegExp 与目录文件枚举（test_check_mutation_ranges.js 直接驱动断言）。
// 注：本文件被 require 时不会提前 process.exit（最终 exit 已用 require.main === module 包住），
// 供测试安全地复用 globToRegExp / listRepoJsFiles 做单元断言。
module.exports = { globToRegExp, listRepoJsFiles }

if (configGlob.length) {
  console.log(`ℹ️ stryker.config.js 的 mutate 含 glob 写法（${configGlob.join(', ')}），相对仓库根展开匹配实际文件后再与矩阵双向比对`)
}
// 缺陷B修复：每个 glob 相对仓库根展开成「实际存在的仓库匹配文件」，与字面条目合并成
// 本地 mutate 全集，再与矩阵 mutateTargets 双向比对——既报 configMissing（矩阵有、glob/字面
// 都没覆盖），也报 configExtra（本地会跑但矩阵没覆盖）。修复前只看字面条目，glob 覆盖到的
// 「额外存在文件」检测不到（#131 缺陷B）。config 无 glob 时 allConfiguredMutate 恒等于
// configMutate，行为与历史完全一致。
const repoJsFiles = listRepoJsFiles()
const allConfiguredMutate = new Set([
  ...configMutate,
  ...configGlob.flatMap(pattern => {
    const re = globToRegExp(pattern)
    return repoJsFiles.filter(file => re.test(file))
  })
])
const configMissing = [...mutateTargets].filter(file => !allConfiguredMutate.has(file))
const configExtra = [...allConfiguredMutate].filter(file => !mutateTargets.has(file))
if (configMissing.length) {
  console.error(`❌ stryker.config.js 的 mutate 缺矩阵目标：${configMissing.join(', ')}（本地跑不全）`)
  failed = true
}
if (configExtra.length) {
  console.error(`❌ stryker.config.js 的 mutate 含矩阵未覆盖的文件：${configExtra.join(', ')}（本地比 CI 多跑）`)
  failed = true
}

for (const [file, ranges] of fileRanges) {
  let fileFailed = false
  // 路径加固：解析后必须仍在仓库根目录内，拒绝 yml 里的越界路径
  const filePath = path.resolve(root, file)
  if (!filePath.startsWith(root + path.sep)) {
    console.error(`❌ ${file}: 路径越出仓库根目录，拒绝处理`)
    failed = true
    continue
  }
  if (!fs.existsSync(filePath)) { // nosemgrep（filePath 已做 resolve + 仓库根前缀校验，运行时防护到位）
    console.error(`❌ ${file}: mutation.yml 引用的文件不存在`)
    failed = true
    continue
  }
  // 读取失败（如 yml 指向目录、权限问题）必须转为校验失败，不能让脚本崩溃
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8') // nosemgrep（filePath 已做 resolve + 仓库根前缀校验，运行时防护到位）
  } catch (err) {
    console.error(`❌ ${file}: 读取失败 —— ${err.message}`)
    failed = true
    continue
  }
  const actualLines = raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)

  // 校验 1：首段必须从第 1 行开始（防头部静默漏测）
  if (sorted[0].start !== 1) {
    console.error(`❌ ${file}: 首段从第 ${sorted[0].start} 行开始 —— 第 1-${sorted[0].start - 1} 行未被变异测试覆盖`)
    fileFailed = true
  }

  // 校验 2：连续无缝隙、不重叠
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start !== sorted[i - 1].end + 1) {
      console.error(`❌ ${file}: 行段不连续 —— ${sorted[i - 1].start}-${sorted[i - 1].end} 与 ${sorted[i].start}-${sorted[i].end} 之间有缝隙或重叠`)
      fileFailed = true
    }
  }

  // 校验 3：最后一段必须覆盖到实际行数（文件增长检测）
  const coveredEnd = sorted[sorted.length - 1].end
  if (coveredEnd < actualLines) {
    console.error(`❌ ${file}: 行段止于 ${coveredEnd}，但文件实际 ${actualLines} 行 —— 尾部 ${actualLines - coveredEnd} 行未被变异测试覆盖（v3.270 教训）`)
    fileFailed = true
  } else if (coveredEnd > actualLines) {
    console.error(`❌ ${file}: 行段止于 ${coveredEnd}，超过文件实际行数 ${actualLines}`)
    fileFailed = true
  }

  if (fileFailed) failed = true
  if (!fileFailed) {
    const segs = sorted.map(r => `${r.start}-${r.end}`).join(', ')
    console.log(`✅ ${file}: ${actualLines} 行，${sorted.length} 段全覆盖 [${segs}]`)
  }
}

// 主入口执行：仅当作为脚本直接运行（node scripts/check-mutation-ranges.js）时按结果 exit；
// 被 require（test_check_mutation_ranges.js 复用 globToRegExp / listRepoJsFiles）时不退出进程，
// 保证测试进程不被提前 kill。
if (require.main === module) process.exit(failed ? 1 : 0)
