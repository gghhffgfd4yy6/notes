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
// 环境注入用「!== undefined」判空而非 ||（#136 review F7）：夹具显式传空串时，|| 会静默回退去读真实
// mutation.yml，把「空输入」变成假绿（实测旧实现 MUTATION_WORKFLOW_TEXT="" 时 exit 0，且校验的是真实
// 文件）。故只要 TEXT 出现过（含空串）就以它为准，空串随后因零条目 fail-loud。
const workflowTextEnv = process.env.MUTATION_WORKFLOW_TEXT
const workflowPathEnv = process.env.MUTATION_WORKFLOW_PATH
// 空/仅空白的路径只在「没有 TEXT 注入、真的要读文件」时拦下（F-04）：path.resolve('') = cwd，
// readFileSync(目录) 抛裸 EISDIR 堆栈（不可读）。TEXT 已给出时该路径根本不参与读取，此时仍按空路径
// 退出，等于让一个被忽略的输入否掉有效注入（实测 PATH="" + 合法 TEXT 直接 exit 1，yml 压根没校验）。
// 失败收场照旧收敛到 exitIfDirectRun（直跑 exit 1、被 require 则 throw），与本文件其他提前退出一致。
if (workflowTextEnv === undefined && workflowPathEnv !== undefined && workflowPathEnv.trim() === '') {
  console.error('❌ MUTATION_WORKFLOW_PATH 不能为空（应指向 mutation.yml；不设置才会读仓库默认路径）')
  exitIfDirectRun(1)
}
const workflowPath = path.resolve(workflowPathEnv ?? path.join(root, '.github/workflows/mutation.yml'))
// 注入文本与真实读取必须在输出里可区分（F-04）：此前 TEXT 会无提示地整体替换掉真实 mutation.yml，
// 一次「看起来全绿」的校验实际校验的是注入文本。此告警只改可观测性，不改任何判定。
let yml
if (workflowTextEnv !== undefined) {
  console.warn('⚠️ 使用 MUTATION_WORKFLOW_TEXT 注入文本校验（未读取真实 mutation.yml）')
  yml = workflowTextEnv
} else {
  // 读不到 mutation.yml（路径写错/文件缺失/权限）必须转成可读的失败，而不是裸 ENOENT 堆栈——
  // 与下方正文文件的读取失败处理（fileRanges 循环里的 try/catch）同口径。
  try {
    yml = fs.readFileSync(workflowPath, 'utf8') // nosemgrep（仓库内固定路径，非用户输入）
  } catch (err) {
    console.error(`❌ 无法读取 mutation.yml（${workflowPath}）：${err.message}`)
    exitIfDirectRun(1)
  }
}

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
// 全文件变异条目（mutate 不带 `:`）是合法写法，但它不参与下面的行段校验：必须显式提示，
// 否则「矩阵里有这一条」会被读成「它的行段也被校验过了」（真实 mutation.yml 18 条里 15 条如此）。
const fullFileTargets = new Set()
// 格式非法的行段必须响亮失败（#136 review F1）：此前只无条件登记 mutateTargets、行段仅在
// /^\d+-\d+$/ 命中时才登记，于是把「xbk_function_v3.js:1-426」写成「:1-42x」既不报错、也不进入
// 逐文件校验循环 —— 该文件的行数/连续性/尾部检查被整段跳过，门禁照旧 exit 0（实测复现）。
const malformedRanges = []
for (const entry of matrixEntries) {
  if (!entry.mutate) continue
  const segments = entry.mutate.split(':')
  const file = segments[0]
  mutateTargets.add(file)
  // 冒号超过两段必须拦下（#136 CodeRabbit）：旧实现用解构只取前两段，于是「file.js:1-10:extra」
  // 会被当成合法的 1-10 放行、尾段被静默丢弃（实测旧实现对该夹具 exit 0 并报「1 段全覆盖」）。
  if (segments.length > 2) {
    malformedRanges.push({ name: entry.name || file, mutate: entry.mutate })
    continue
  }
  const range = segments[1]
  if (range === undefined) { // 完全不带行段 = 合法（按全文件变异处理）
    fullFileTargets.add(file)
    continue
  }
  if (!/^\d+-\d+$/.test(range)) {
    malformedRanges.push({ name: entry.name || file, mutate: entry.mutate })
    continue
  }
  const [start, end] = range.split('-').map(Number)
  if (!fileRanges.has(file)) fileRanges.set(file, [])
  fileRanges.get(file).push({ start, end })
}

// 「生产文件」的判定口径：运行时加载链上的模块，必须全部是 mutate 目标（缺一即漏测，审查 F-01）。
// 根目录 xbk_*.js 与 qinglong/xbk_push.js 是运行时模块/入口；scripts/status.js 被
// qinglong/xbk_push.js 顶层无条件 require（--status 诊断与常驻入口都会加载），此前漏列使本门禁与
// stryker.config.js 对同一份缺口双向对账假绿（实测 exit 0）；scripts/check-deps.js 仅是测试入口
// run_tests.js 的预检，按历史口径一并保留在此清单中。
const productionFiles = [
  ...fs.readdirSync(root).filter(file => /^xbk_.*\.js$/.test(file)),
  'qinglong/xbk_push.js',
  'scripts/check-deps.js',
  'scripts/status.js',
  'scripts/console.js'
]

// ── 运行链候选集（C10-009）──────────────────────────────────────────────────────────────
// 为什么需要它：productionFiles 是**手写清单**，与 mutate 清单只做单向比对（「清单里的都列了吗」）。
// 运行链上被顶层无条件 require 的模块只要没被写进清单，就既不在比对范围内、也不在 mutate 目标里
// ⇒ 门禁永久绿灯 + 零变异覆盖，而「清单漏了一行」这件事本身无法自证（实测：过滤器规则路径 /
// 文件权限收紧 / 判重缓存签名三个模块就是这样躺了很久）。故这里从**运行入口**出发派生候选集，
// 再与 mutate 清单**双向**核对；两张显式表（豁免 / 非运行时）都必须带理由，且做过期校验——
// 改名或删除后不清表，门禁自己变红。
const RUNTIME_ENTRIES = ['qinglong/xbk_push.js']
const JS_MODULE_RE = /\.(?:js|cjs|mjs)$/
// require(...) 的参数可能含嵌套括号（`require(path.join(ROOT, 'x'))`），故只取到第一个右括号为止：
// 参数里的引号字符串仍能被完整捕获，足够解析仓库内模块；拿不到引号时按「非字面量 require」记录。
const REQUIRE_CALL_RE = /require\s*\(([^)]*)\)/g
const QUOTED_LITERAL_RE = /(['"])((?:[^'"\\]|\\.)*)\1/g

// 把 require 的字符串实参解析成仓库内文件的相对路径（'/' 分隔）；解析不到返回 null。
// 口径：相对路径按**所在文件目录**解析；其它（裸名 / scripts/ 前缀 / path.join(ROOT, 'x') 里的
// 目录名）一律按**仓库根**解析——本仓的动态 require 只有这两种形态，实测逐个核对过。
function resolveRuntimeSpec (fromRel, spec) {
  if (!spec || spec.startsWith('/')) return null
  const base = spec.startsWith('.')
    ? path.resolve(path.dirname(path.join(root, fromRel)), spec)
    : path.join(root, spec)
  for (const suffix of ['', '.js', '.cjs', '.mjs', path.join('index.js')]) {
    const candidate = base + suffix
    if (!candidate.startsWith(root + path.sep)) continue
    try {
      if (fs.statSync(candidate).isFile() && JS_MODULE_RE.test(candidate)) {
        return path.relative(root, candidate).split(path.sep).join('/')
      }
    } catch (e) { /* 不存在：试下一个后缀 */ }
  }
  return null
}

// 从运行入口派生 require 闭包。只读源码文本、不执行任何运行时代码（入口有副作用，绝不能 require 它）。
// 注释行（`//` / `*` / `/*` 开头）跳过：注释掉的 require 不该把模块拖进候选集（也不该让门禁假红）。
// 非字面量 require（`require(localPath)`）无法静态解析 ⇒ 收进 unresolved 如实列出，由人工复核。
function deriveRuntimeChain (entries = RUNTIME_ENTRIES) {
  const chain = new Set()
  const unresolved = []
  const queue = entries.slice()
  while (queue.length) {
    const rel = queue.shift()
    if (chain.has(rel)) continue
    let source
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8') // nosemgrep（仓库内相对路径，非用户输入）
    } catch (err) {
      unresolved.push(`${rel}: 读取失败 —— ${err.message}`)
      continue
    }
    chain.add(rel)
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      REQUIRE_CALL_RE.lastIndex = 0
      let call
      while ((call = REQUIRE_CALL_RE.exec(line)) !== null) {
        const specs = [...call[1].matchAll(QUOTED_LITERAL_RE)].map(m => m[2])
        if (!specs.length) {
          unresolved.push(`${rel}: require(${call[1].trim().slice(0, 60)})（非字面量实参，静态闭包看不到）`)
          continue
        }
        for (const spec of specs) {
          const resolved = resolveRuntimeSpec(rel, spec)
          if (resolved) queue.push(resolved)
        }
      }
    }
  }
  return { chain: [...chain].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), unresolved }
}

// 显式豁免：运行链上但**有意不列 mutate 目标**的模块，理由必须写清楚（空理由判红）。
// ⚠️ 这是「已登记的零变异覆盖缺口」，不是「没问题」：豁免表要逐条评审，新增条目必须说明为什么
// 不该变异、以及它的行为由哪些套件经调用方覆盖。
const MUTATION_EXEMPT = new Map([
  ['scripts/filter-rules-paths.js',
    '为消除 Codacy/Semgrep 的路径注入误报，从 xbk_filter_store 抽出的**纯路径构造**助手（51 行、无 fs 调用、不读内容）；行为由 filter-store 套件经 FilterStore 调用方覆盖。矩阵未拆该段 ⇒ 显式登记为零变异覆盖的已知缺口'],
  ['scripts/owner-only-mode.js',
    '同源抽出的**仅 stat+chmod** 权限收紧助手（52 行，入参只来自 FilterStore 的字面量文件名路径）；行为由 filter-store 套件的 0600 收紧用例经调用方覆盖，矩阵未拆该段 ⇒ 显式登记为零变异覆盖的已知缺口'],
  ['scripts/message-signature.js',
    '只做一次 statSync + mtime 签名的只读助手（21 行，给默认 push.json 判重缓存用），返回 null 的每条降级分支由 status 套件经 readStatus 覆盖；矩阵未拆该段 ⇒ 显式登记为零变异覆盖的已知缺口']
])

// 反向标注：是 mutate 目标、但**不在**运行入口的 require 闭包里的模块，必须写明原因。
// 否则「mutate 了一个早已不上运行链的死文件」也会被当成覆盖（是另一种假绿）。
const NON_RUNTIME_MUTATE_TARGETS = new Map([
  ['scripts/check-deps.js',
    '只被测试入口 run_tests.js 顶层 require（依赖预检），运行时不加载；按历史口径仍列为 mutate 目标（测试入口的预检逻辑也要有覆盖）'],
  ['scripts/console.js',
    '独立 CLI（网页控制台）：由用户/调度器以 `node scripts/console.js` 启动，不经运行入口 require 或 spawn，静态闭包看不到；它仍是生产模块，故保留 mutate 目标']
])

// 纯判定函数（导出给 test_check_mutation_ranges.js 直接驱动靶向反例）：两个方向 + 过期条目 + 空理由。
function auditRuntimeChain ({ chain, mutateTargets, exempt, nonRuntime }) {
  const errors = []
  const chainSet = new Set(chain)
  const targetSet = mutateTargets instanceof Set ? mutateTargets : new Set(mutateTargets)
  const exemptMap = exempt instanceof Map ? exempt : new Map(Object.entries(exempt || {}))
  const nonRuntimeMap = nonRuntime instanceof Map ? nonRuntime : new Map(Object.entries(nonRuntime || {}))
  // ① 正向：运行链上的每个模块必须「是 mutate 目标」或「显式豁免（且有理由）」
  for (const file of chainSet) {
    if (targetSet.has(file)) continue
    if (exemptMap.has(file)) {
      if (!String(exemptMap.get(file) || '').trim()) {
        errors.push(`运行链模块 ${file} 的豁免理由为空：豁免必须写明「为什么不该变异」，空理由等于静默豁免`)
      }
      continue
    }
    errors.push(`运行链模块 ${file} 既不是 mutation.yml 的 mutate 目标、也没有显式豁免（新增/改名运行链模块时必须二选一：列入 mutate 目标，或在 MUTATION_EXEMPT 里写明豁免理由与调用方覆盖）`)
  }
  // ② 反向：mutate 目标必须在运行链上，或显式标注「非运行时（且有理由）」
  for (const file of targetSet) {
    if (chainSet.has(file)) continue
    if (nonRuntimeMap.has(file)) {
      if (!String(nonRuntimeMap.get(file) || '').trim()) {
        errors.push(`mutate 目标 ${file} 的「非运行时」标注理由为空：必须写明它为何不在运行链上`)
      }
      continue
    }
    errors.push(`mutate 目标 ${file} 既不在运行链上、也没有显式标注为非运行时模块（NON_RUNTIME_MUTATE_TARGETS）：变异一个不上运行链的文件等于零收益覆盖`)
  }
  // ③ 过期条目：两张表都必须随代码演进自动失效，否则清单本身会成为新的盲区
  for (const file of exemptMap.keys()) {
    if (!chainSet.has(file)) errors.push(`MUTATION_EXEMPT 的 ${file} 不在运行链上：豁免已过期（模块已删除/改名或不再被运行入口加载），请删除该条`)
    if (nonRuntimeMap.has(file)) errors.push(`${file} 同时出现在 MUTATION_EXEMPT 与 NON_RUNTIME_MUTATE_TARGETS：两个口径互斥`)
  }
  for (const file of nonRuntimeMap.keys()) {
    if (!targetSet.has(file)) errors.push(`NON_RUNTIME_MUTATE_TARGETS 的 ${file} 不是任何 mutate 目标：标注已过期（该文件已不在矩阵里），请删除该条`)
  }
  return { errors }
}

// 失败收敛点：直接运行（node scripts/check-mutation-ranges.js）时按 code process.exit，保证 CI /
// `npm run check` 照旧 fail-loud（非零退出）；被 require 时（test_check_mutation_ranges.js 复用
// globMatcher / listRepoJsFiles）改为 throw —— require 者同样必须拿到失败信号。此前 require 路径
// 只置失败标记并降级返回，使「依赖模块加载失败 / mutation.yml 无任何行段」退化成 stderr 噪音，
// require 者拿到「校验通过」的假象（R2 审查发现；虽被同文件的 spawn 夹具兜住，但属脆弱点）。
function exitIfDirectRun (code) {
  if (require.main === module) process.exit(code)
  throw new Error('check-mutation-ranges 校验失败：详见上方 stderr 输出（被 require 时以 throw 传递失败）')
}

let failed = false

// 非法行段在此结算（#136 review F1）：置于 fileRanges 空值早退之前，故即使整份 yml 都是非法行段，
// 也会同时打出「格式非法」与「未解析到任何行段」两条信息，两条路径都非零/抛错。
for (const bad of malformedRanges) {
  console.error(`❌ matrix「${bad.name}」的 mutate 行段格式非法：${bad.mutate}（应为 "file.js:start-end"；旧实现会静默忽略该条，使该文件整段跳过行段校验）`)
  failed = true
}

// 全文件变异条目的提示（⚠️ 级，不改退出码）：它本身不是失败，只是把「哪些条目不参与行段校验」
// 明说出来——否则下面的 ✅ 行段清单会被误读成「矩阵每一条都校验过行段」。
if (fullFileTargets.size) {
  console.warn(`⚠️ ${fullFileTargets.size} 个 mutate 目标未带行段（按全文件变异处理，不参与行段连续性/尾部校验）：${[...fullFileTargets].join(', ')}`)
}

// 全文件条目与带行段条目走同一套「引用目标必须真实存在于仓库内且可读」的校验（F-02）：此前
// 存在性/可读性检查只写在下方 fileRanges 循环里，全文件目标只登记进 fullFileTargets、仅被上一行
// 打成一条 ⚠️，于是把矩阵里的真实目标换成不存在的幽灵（如 scripts/ghost-nonexistent.js）既不报错
// 也不影响退出码——「矩阵里有这一条」被读成「它被校验过了」。这里补齐同一口径（只做存在性/可读性，
// 全文件条目不参与行数/行段校验）。
for (const file of fullFileTargets) {
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
  try {
    fs.readFileSync(filePath, 'utf8') // nosemgrep（filePath 已做 resolve + 仓库根前缀校验；此处仅验证可读性）
  } catch (err) {
    console.error(`❌ ${file}: 读取失败 —— ${err.message}`)
    failed = true
  }
}

// 早退守卫的真实意图：拦「解析压根没产出任何 mutate 目标」——矩阵为空、每条 mutate 都缺失、
// 或 include 块解析失败，这些一律 fail-loud。判空条件因此必须与 fullFileTargets 联动，不能只看
// fileRanges（#138 review）：「mutate 不带行段 = 全文件变异」已被本文件确立为合法写法（见上方
// fullFileTargets），若这里仍写 `fileRanges.size === 0`，则「整份矩阵都是全文件条目」这种完全合法
// 的形态必然 fileRanges 为空 → 被误报成「未解析到任何 mutate 行段」并 exit 1，与上方那条 ⚠️
// 提示自相矛盾（真实矩阵 18 条里已有 15 条是全文件条目，一旦行段条目被删/改就会整轮误失败）。
// 反向仍然成立、没有削弱：矩阵为空或所有条目 mutate 缺失/非法时 fullFileTargets 同样为空 →
// 条件成立 → 照旧 exit 1 / throw；而 malformedRanges 的结算在其之前，非法行段路径不受影响。
// 关键：早退之后的校验一条都没少（只拦「零目标」，其余照旧）——逐文件的行数/连续性/尾部校验
// （fileRanges 循环）、productionFiles 是否都被列为 mutate 目标、条目 name/src/mutate 字段与
// src-mutate 一致性、EXPECTED_SEGMENTS 段名（缺失/多余/重复）、stryker.config.js 与矩阵双向比对。
if (fileRanges.size === 0 && fullFileTargets.size === 0) {
  console.error('❌ 未在 mutation.yml 中解析到任何 mutate 行段（格式应为 "file.js:start-end"，或合法的全文件写法 "file.js"）')
  failed = true // 两条路径都记录失败；如何收场交给 exitIfDirectRun 决定
  exitIfDirectRun(1) // 两条路径都不返回：直接运行立即退出非零，require 路径抛错（fail-loud）
}

for (const file of productionFiles) {
  if (!mutateTargets.has(file)) {
    console.error(`❌ ${file}: 未列入 mutation.yml 的 mutate 目标`)
    failed = true
  }
}

// 校验 0.7：运行链候选集 ↔ mutate 清单**双向**核对（C10-009）。
// 上面那道 productionFiles 校验是单向的（「手写清单里的都列了吗」）：运行链上被顶层 require 的模块
// 只要没被写进清单就完全在判据之外 ⇒ 永久绿灯、零变异覆盖。这里补上派生集：运行链模块必须二选一
// （mutate 目标 / 带理由的显式豁免），mutate 目标必须二选一（在运行链上 / 带理由的非运行时标注），
// 两张表都做过期校验。判据只增不减——上面的 productionFiles、行段、config 对账一条没动。
const runtimeChainInfo = deriveRuntimeChain()
const chainAudit = auditRuntimeChain({
  chain: runtimeChainInfo.chain,
  mutateTargets,
  exempt: MUTATION_EXEMPT,
  nonRuntime: NON_RUNTIME_MUTATE_TARGETS
})
for (const message of chainAudit.errors) {
  console.error(`❌ ${message}`)
  failed = true
}
if (runtimeChainInfo.unresolved.length) {
  console.log(`ℹ️ 运行链派生：${runtimeChainInfo.chain.length} 个仓库内模块；${runtimeChainInfo.unresolved.length} 处非字面量 require（静态闭包看不到，逐条列出以便复核）：`)
  for (const site of runtimeChainInfo.unresolved) console.log(`   · ${site}`)
}
if (MUTATION_EXEMPT.size) {
  console.log(`ℹ️ 运行链显式豁免（零变异覆盖、需逐条评审）：${[...MUTATION_EXEMPT.keys()].join(', ')}`)
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

// 依赖模块加载的友好报错：mutation-report.js / stryker.config.js 未来若在顶层抛错或引入副作用，
// checker 不应裸栈崩溃，而要指明是哪个模块加载失败，再以失败收场（直接运行 exit 1 / 被 require
// throw，两者都不返回）。因此这里不再有 null 降级：模块加载失败必须响亮，不能被翻译成「期望集合为空」。
function requireOrDie (modulePath, displayName) {
  try {
    return require(modulePath)
  } catch (err) {
    console.error(`❌ 无法加载 ${displayName}（${modulePath}）：${err.message}`)
    exitIfDirectRun(1)
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
// 比对，改用 glob 谓词判定矩阵目标是否可能被覆盖；非 glob 条目仍严格比对，通过/失败
// 语义与历史一致（当前 config 无 glob 时行为完全不变）。
const configMutateRaw = requireOrDie('../stryker.config.js', 'stryker.config.js').mutate || []
const globChars = /[*?[\]{}]/
const configGlob = configMutateRaw.filter(item => globChars.test(item))
const configMutate = new Set(configMutateRaw.filter(item => !globChars.test(item)))

// glob → 谓词（仅为「矩阵目标是否可能被 glob 覆盖」的判定服务）：匹配语义交给 Node 内置
// `path.matchesGlob`（minimatch 口径，Node 22.5+；本仓 engines >=22.22.2），不再手写 62 行状态机。
// 返回 `{ test }` 只为保持调用点与测试的 `.test(path)` 形状。
// 旧状态机在**实际调用面**上逐条等价：`*`/`?` 不跨 `/`、`{a,b}` 交替、`[...]` 字符类与 `[!...]`
// 取反、`**/` 与末尾 `**` 的递归、6 个 malformed 模式（`[[`/`[z-a]`/`[a-`/`{a,`/`a**b`/`*.`）不抛
// ——均由 test_check_mutation_ranges.js 锁定。实测差异仅 3 类，见下（都不可达或更贴近 stryker 口径）：
//   1. 点开头的路径段：内置 glob 默认不匹配隐藏文件 ⇒ `**/*.js` 不再命中 `.github/analyze-artifacts.js`
//      （旧实现命中）。这是**收紧且与 stryker 一致**：stryker 解析 mutate glob 时同样传 dot:false
//      （core 的 project-reader.resolveFileDescriptions → FileMatcher(…, allowHiddenFiles=false)），
//      故 `**/*.js` 本来就不会改到它；旧行为反而会把「实际没跑」判成「已覆盖」。当前
//      stryker.config.js 无 glob 条目，暂不可达。
//   2. 歧义字符类（`[a--b]`）：旧实现整体降级为字面文本，内置按 minimatch 解析该类的语义。
//      本仓 config 无此类 pattern；测试只锁「不抛异常」，不锁 upstream 的解析细节。
//   3. `*` 对以 `/` 结尾的**输入**：旧实现判 false、内置判 true；`listRepoJsFiles` 只产出文件路径
//      （绝无尾随 `/`），故该差异在本调用面不可达。
function globMatcher (pattern) {
  return { test: (file) => path.matchesGlob(file, pattern) }
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

// 暴露给测试：glob 谓词与目录文件枚举（test_check_mutation_ranges.js 直接驱动断言），
// 以及运行链派生 / 双向核对（C10-009 的靶向反例依赖它们：直接喂合成输入，不需要改仓库文件）。
// 注：本文件被 require 时不会用 process.exit 结束测试进程——全部失败收场（两处提前退出：未解析到
// 任何行段、依赖模块加载失败；以及文件末尾的最终判定）都收敛到 exitIfDirectRun / require.main：
// 直接运行 process.exit(code)，被 require 则 throw。故健康仓库下 require 不抛，可安全复用
// globMatcher / listRepoJsFiles；仓库真有问题时抛错让测试失败，正是期望行为。
module.exports = {
  globMatcher,
  listRepoJsFiles,
  deriveRuntimeChain,
  auditRuntimeChain,
  MUTATION_EXEMPT,
  NON_RUNTIME_MUTATE_TARGETS
}

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
    const matcher = globMatcher(pattern)
    return repoJsFiles.filter(file => matcher.test(file))
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

  // 校验 0：行段自身必须有序（start <= end）。此前只校验首段起点、相邻连续与末段终点，于是
  // 「1-2000, 2001-1470」（文件实际 1470 行）能被拼成「连续」（2001 === 2000+1）、且末段终点恰好
  // 等于实际行数，门禁打印「✅ ... 2 段全覆盖 [1-2000, 2001-1470]」并 exit 0（F-03 实测）。
  for (const range of sorted) {
    if (range.start > range.end) {
      console.error(`❌ ${file}: 行段 ${range.start}-${range.end} 起止颠倒（start > end），不是合法行段`)
      fileFailed = true
    }
  }

  // 校验 3 的前置：非末段同样不得越过 EOF。只查末段终点时，「1-150, 151-200」（文件 100 行）里
  // 越界的非末段只会被末段那条模糊带过（F-03）；按行段显式兜一层，报错点名越界的到底是哪一段。
  for (const range of sorted.slice(0, -1)) {
    if (range.end > actualLines) {
      console.error(`❌ ${file}: 非末段行段止于 ${range.end}，超过文件实际行数 ${actualLines}`)
      fileFailed = true
    }
  }

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

// 主入口执行：作为脚本直接运行（node scripts/check-mutation-ranges.js）时按结果 process.exit；
// 被 require（test_check_mutation_ranges.js 复用 globMatcher / listRepoJsFiles）时改为 throw，
// 让 require 者也拿到失败（不再静默返回「无结论」）。
if (require.main === module) process.exit(failed ? 1 : 0)
if (failed) exitIfDirectRun(1) // 直接运行：上一行已 exit，此处不可达；被 require：throw
