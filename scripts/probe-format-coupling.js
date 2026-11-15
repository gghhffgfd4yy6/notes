#!/usr/bin/env node
'use strict'
/*
 * 格式耦合探针（S0）：判断一个测试是否**绑死**了仓内源码/资产的排版。
 *
 * 做法：把仓内**扰动面**里的文件重排（语义不变，见下）→ 逐个跑传入的测试（TZ=UTC）→ 无论成败都还原。
 *   - 重排后仍绿 ⇒ format-clean（该测试不依赖这些文件的排版）
 *   - 重排后变红 ⇒ format-coupled（断言在读源码文本/结构片段，重排就误红——正是本批要清掉的形态）
 *   - 读到扰动面之外的仓内文件 ⇒ format-uncertified（**exit 2**，fail-closed）：不允许把「探针没覆盖」
 *     说成「没有耦合」。这是 r4 评审的核心意见：旧实现只扰动 `.js`，于是测试读 `.css`/`.mjs`/`.yml`/`.json`
 *     做逐字断言时永远 format-clean，而 RUNBOOK 把探针绿当作「不再绑文本格式」的机械判据。
 *
 * 扰动面（按类型，全部语义不变；详细见各种 perturb* 的实现）：
 *   - `.js` / `.mjs` / `.cjs`：acorn 词法在 `,`/`(`/`{` 之后与 `(`/`)`/`}` 之前各插一个空格 + 非空行统一重缩进
 *     （跨行字符串/模板/正则覆盖的行与 shebang 行跳过：那些行首空白是运行期数据）。
 *     `.mjs` 用同一套词法，sourceType 先 script 后 module（`import`/`export` 只有 module 能切词）。
 *   - `.json`：`JSON.parse` → `JSON.stringify`（紧凑单行），并回读深比较确认数据完全一致。
 *   - `.yml` / `.yaml`：块映射行的键后加一个空格（`runs-on:` → `runs-on :`；YAML 语义上键与冒号之间的
 *     空白被丢弃，数据不变），块标量（`|`/`>`）内部原样保留。读 YAML 文本的 `includes('key: …')`
 *     因此必然失配。**不做** parse→dump：那要 `require('js-yaml')`，而探针不为自己加运行时依赖
 *     （js-yaml 自 v3.454 起已在 `devDependencies` 里声明，但探针仍是纯文本重排，不需要它）。
 *   - `.css`：字符串/注释/括号内（`url(…)` 的数据串）不动，`;`/`{`/`}` 两侧插空格 + 重缩进。
 *   - `.html` / `.htm`：只重缩进，`<pre>/<textarea>/<script>/<style>` 块内跳过。
 *   - shell（`.sh` / `.bash` / `.githooks/*` 的无扩展名钩子）：每个非空行把**第一个引号外的空白**
 *     扩成两个（shell 按空白串切词，语义不变；注释行、续行、heredoc 正文、shebang 跳过）。
 *   - 点目录：`.github/**`、`.githooks/**` 是仓库源码，进扰动面与快照（r8-4：早先按
 *     `entry.name.startsWith('.')` 一刀切跳过，于是读 workflow / 钩子的逐字断言永远判 format-clean）；
 *     只有 `SKIP_DIRS` 里逐个登记的目录（node_modules / .git / .stryker-tmp / …）才跳过。
 *   扰动不了的文件（解析失败、格式不支持）**不静默放过**：被测试读到就判 not-covered（exit 2）。
 *   测试文件自身（`test_*.js` / `test/**` / `test_support/**`）不在扰动面：那一层由
 *   `scripts/check-source-text-asserts.js` 的扫描面管辖（探针只管生产/资产；扰动测试文件自身会让
 *   「测试读自己」的条目变成永远红，把两个仪器的职责搅在一起）。
 *
 * 「测试读到了什么」不是靠正则猜的：每次跑测试都通过 `NODE_OPTIONS=--require <垫片>` 注入一个
 * `fs.readFileSync`/`fs.promises.readFile` 记录器（垫片运行期写在 os.tmpdir() 里，不进仓库），
 * 只记录**运行前就在仓库里**的文件（运行期产物如 run.log / .lock 不算源码文本），逐个与扰动面对账。
 *
 * 还原（r4-3）：`try/finally` 之外，任何 fail-closed 分支都只 `throw`，绝不 `process.exit`——
 * 进程内 exit 会跳过 finally，把 70+ 个被重排的生产文件留在工作树里（评审实测：10 个真实生产文件被留改）。
 * 退出前先打印「已还原 N 个文件」，再拿 `git status --short` 与运行前比对，出现新增改动即 exit 3 并点名。
 *
 * 退出码：0 全部 format-clean / 1 存在 format-coupled / 2 用法错误、词法错误、或存在 not-covered
 *        （含「重排后无法解析」这条探针自身 bug 的 fail-closed）/ 3 还原失败（工作树有新增改动）。
 *
 * 扰动面下限（r13-7，fail-closed）：候选数为 0、低于 `MIN_CANDIDATES`（默认 20，可用 `--min-candidates=N`
 * 显式放宽）、或实际写盘 0 个文件 ⇒ exit 2。理由：`walk()`/`SKIP_DIRS` 回归导致「扰动面塌缩」时，
 * 输出与「所有测试都不耦合格式」逐字相同，而 RUNBOOK 把探针绿当机械判据——这是唯一能把两者分开的地方。
 *
 * 用法：node scripts/probe-format-coupling.js test_console.js test_utils_pure.js
 *      不带参数：跑内置自检集（DEFAULT_TESTS，两个不读仓内文本的套件）——探针自身可用即 exit 0。
 *      PROBE_TIMEOUT_MS=900000 可调单条测试上限（默认 15 分钟，超时按 coupled 计，fail-closed）。
 *
 * 静态分析豁免（两套引擎，各留一条注释）：下面这些 fs.* 的目标路径按设计必然是变量（ROOT = __dirname
 * 常量 + 本文件硬编码的相对段 / mkdtempSync 建出的本进程独占临时目录，没有外部净输入参与构造，也不碰
 * 仓库之外的任何位置）。opengrep 侧的「非字面量路径」由行尾 `// nosemgrep` 压住；ESLint 系的
 * security/detect-non-literal-fs-filename 只认 `// eslint-disable-next-line`，单靠 nosemgrep 对它无效。
 * ⚠️ ESLint 侧一律写成**不带规则名**的裸形态：本仓 standard 17 不带 eslint-plugin-security，指名规则会让
 * lint 直接报 "Definition for rule … was not found" 并整体判红（与 test_source_model.js 同口径）；指令必须
 * 独占一行，行尾带文字就不再是指令。
 */
const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const LEX_OPTS = { ecmaVersion: 'latest', allowHashBang: true, locations: true }
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 15 * 60 * 1000
// 目录跳过名单**逐个登记**，不按「点开头」一刀切（r8-4）：早先 `entry.name.startsWith('.')` 把
// `.github/**` 与 `.githooks/**` 一起跳掉了 ⇒ 它们既不在扰动面也不在快照，测试读它们一律判
// format-clean（假绿）。现在点目录默认**纳入**，只有下面这些确认「不是仓库源码」的才跳过。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.stryker-tmp', '.nyc_output', 'coverage', 'reports', 'scratch',
  '.local', '.ai', '.tools', '.cache', '.venv', '.idea', '.vscode'
])
const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
const SHELL_EXT = new Set(['.sh', '.bash'])
// 无扩展名但确实是脚本的目录（钩子）：`.githooks/pre-commit` 这类文件没有扩展名，光按扩展名认会
// 把它们排除在扰动面之外——它们的排版断言就永远探不到。
const SHELL_DIRS = ['.githooks/']
const EXT_KIND = new Map([
  ['.json', 'json'], ['.yml', 'yaml'], ['.yaml', 'yaml'], ['.css', 'css'], ['.html', 'html'], ['.htm', 'html']
])
// 自测用故障注入：把列出的文件在扰动后当作「无法解析」，用来验证 fail-closed 分支**仍然还原**
// （test_check_source_text_asserts.js 的 r4-3 用例）。只影响本进程、只接受仓库内相对路径。
// 之所以做成显式开关而不是在用例里改脚本源码：改源码的用例会在脚本重构后静默失效（补丁没命中就绿了）。
const FORCE_UNPARSEABLE = new Set((process.env.PROBE_FORCE_UNPARSEABLE || '').split(',').filter(Boolean))
// 无参自检集：两个不读仓内文本的套件（只依赖自己写的临时夹具），用来证明「探针本身能跑通且不误判」。
const DEFAULT_TESTS = ['test_utils_pure.js', 'test_source_model.js']
// 扰动面下限（r13-7）：「walk()/SKIP_DIRS 回归 ⇒ 候选 0 个」与「全部不耦合」在输出上长得一样，
// 而 RUNBOOK 把「probe 绿」当机械判据。所以候选数低于下限、或实际写盘 0 个文件，一律 exit 2。
// 真仓是数百个候选；用例在 mkdtemp 里造的夹具工作区只有 2-5 个文件，用 `--min-candidates=N` 显式放宽
// （「我知道这个面很小」是个必须写出来的声明，不是默认值）。
const MIN_CANDIDATES = 20

function die (code, message) {
  console.error(message)
  process.exit(code)
}

// 扰动面之外、按「解析失败 / 格式不支持」拒绝扰动的文件：不是错误，但被读到就必须 not-covered。
class NotPerturbable extends Error {}

const kindOf = (rel) => {
  const ext = path.extname(rel).toLowerCase()
  if (JS_EXT.has(ext)) return 'js'
  if (EXT_KIND.has(ext)) return EXT_KIND.get(ext)
  if (SHELL_EXT.has(ext)) return 'shell'
  if (SHELL_DIRS.some((prefix) => rel.startsWith(prefix) && ext === '')) return 'shell'
  return null
}

// 测试面：由 scripts/check-source-text-asserts.js 的扫描面管辖，探针不扰动也不对它下 not-covered 结论。
const isTestSurface = (rel) => /^test_.*\.js$/.test(rel) || rel.startsWith('test/') || rel.startsWith('test_support/')

function walk (dir, out = []) {
  const abs = path.join(ROOT, dir)
  // abs = ROOT（__dirname 常量）+ 仓库内相对目录，探针的扫描面就是本仓，无外部净输入（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  if (!fs.existsSync(abs)) return out // nosemgrep（abs = ROOT（__dirname 常量）+ 仓库内相对目录，探针的扫描面就是本仓）
  // 同上：只遍历本仓目录项，不跟随仓库外路径（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) { // nosemgrep（同上：只遍历本仓）
    const rel = dir ? dir + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      // 显式名单（r8-4）：`.github/**`、`.githooks/**` 是仓库源码，必须进扰动面与快照；
      // 只有 SKIP_DIRS 里这些确认不是源码的目录才跳过。
      if (SKIP_DIRS.has(entry.name)) continue
      walk(rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

// 扰动面：仓内所有「可安全重排」的文件（JS/build 资产），测试面与 SKIP_DIRS 除外。
function perturbableFiles () {
  return walk('').filter((rel) => kindOf(rel) && !isTestSurface(rel)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// 生产 JS 面（导出给用例/后续包用）：`.js`/`.mjs`/`.cjs`，测试面除外。
function productionFiles () {
  return perturbableFiles().filter((rel) => kindOf(rel) === 'js')
}

// 运行前快照：仓内所有文件（相对路径）。用来区分「源码」与「运行期产物」——只有在快照里的文件被读到
// 才可能是源码文本断言；run.log / .lock / 临时状态文件是测试自己造的，不参与对账。
function snapshotFiles () {
  return new Set(walk(''))
}

/* ── 词法级重排（JS：`(`/`)`/`,`/`{`/`}` 两侧插空格 + 重缩进） ─────────────────── */

// 跨行字符串/模板/正则覆盖到的行：行首空白是**字符串内容**的一部分，重缩进会改运行期数据。
function protectedLines (tokens) {
  const lines = new Set()
  for (const token of tokens) {
    const label = token.type.label
    if (label !== 'template' && label !== 'string' && label !== 'regexp' && label !== '`') continue
    if (!token.loc) continue
    for (let line = token.loc.start.line + 1; line <= token.loc.end.line; line++) lines.add(line)
  }
  return lines
}

// script / module 各试一次：`scripts/console-assets/*` 是浏览器 ESM，按 script 解析必失败。
function parseable (code) {
  for (const sourceType of ['script', 'module']) {
    try {
      acorn.parse(code, { ...LEX_OPTS, sourceType })
      return true
    } catch { /* 试下一种 */ }
  }
  return false
}

// 切词同样两种 sourceType 都试（`.mjs` 里的 import/export 只有 module 能切）。
function tokenize (code, file) {
  const errors = []
  for (const sourceType of ['module', 'script']) {
    try {
      const tokens = []
      const lexer = acorn.tokenizer(code, { ...LEX_OPTS, sourceType })
      for (;;) {
        const token = lexer.getToken()
        if (token.type === acorn.tokTypes.eof) break
        tokens.push(token)
      }
      return tokens
    } catch (e) {
      errors.push(`${sourceType}: ${e.message}`)
    }
  }
  // 词法失败 = 这个文件没法安全重排。响亮失败而不是跳过：跳过会把它排除在探针面之外，
  // 于是「该文件里的排版耦合」永远探不到，而输出仍然好看（静默失效）。
  throw new Error(`词法解析失败，无法安全重排 ${file}: ${errors.join('；')}`)
}

function reformat (code, file) {
  const insertions = []
  const tokens = tokenize(code, file)
  for (const token of tokens) {
    const label = token.type.label
    if (label === ',' || label === '(' || label === '{') insertions.push(token.end)
    // `(` 前也插一个空格：只往 `(` 后面插时，以 `(` 结尾的锚点（`…name (`）**完全不受影响**，
    // 探针会把它判成 format-clean——S0 的动机锚点正是这种形状，必须由 `(` 前这一格打破。
    if (label === '(' || label === ')' || label === '}') insertions.push(token.start)
  }
  if (!insertions.length) return code
  insertions.sort((a, b) => a - b)
  const parts = []
  let prev = 0
  for (const pos of insertions) {
    parts.push(code.slice(prev, pos), ' ')
    prev = pos
  }
  parts.push(code.slice(prev))
  // 二次扰动：统一重缩进（跳过跨行字符串/模板/正则覆盖的行）。
  // 第一行是 shebang 时也不动：`#!` 必须是文件的**头两个字节**，缩进两格会让整个文件解析失败
  // （那是把「探针 bug」伪装成「排版耦合」）。
  const skip = protectedLines(tokens)
  if (code.startsWith('#!')) skip.add(1)
  return parts.join('').split('\n').map((line, index) =>
    line.trim() === '' || skip.has(index + 1) ? line : '  ' + line
  ).join('\n')
}

/* ── 非 JS 资产：解析后重排（json/yaml）与空白扰动（css/html） ───────────────── */

function perturbJson (code, rel) {
  let data
  try {
    data = JSON.parse(code)
  } catch (e) {
    throw new NotPerturbable(`${rel}: JSON 解析失败（${e.message}）`)
  }
  const out = JSON.stringify(data) + '\n'
  // 语义自检：重排后回读必须与原文数据**深相等**，否则不写盘（宁可不覆盖，也不制造假红）。
  if (!isDeepStrictEqual(JSON.parse(out), data)) throw new NotPerturbable(`${rel}: JSON 重排后数据不一致`)
  return out
}

function perturbYaml (code, rel) {
  // 为什么不用 parse→dump：那需要 `js-yaml`，而它在本仓只是 stryker 的**传递依赖**（package.json 没声明）。
  // `scripts/check-deps.js` 的反向扫描（代码 require → 声明清单）会把这个 require 判成「代码 require 了
  // 未声明的包」，而为一个探针新增运行时依赖不划算（S0 只加工具层，不动依赖面）。
  // 改用 YAML 规范允许的**空白扰动**：块映射行的键后加一个空格（`runs-on:` → `runs-on :`）。
  // `key : value` 与 `key: value` 在 YAML 里等价（键与冒号之间的空白被丢弃），语义完全不变；但任何
  // `includes('runs-on: …')` / `includes('strategy:')` 都会失配——这正是要探测的文本耦合。
  // 仓库 14 个 yml（含 6 个 workflow）逐个用 js-yaml 解析对比过：扰动前后数据深相等（报告里给了命令）。
  if (/^ *\t/m.test(code)) throw new NotPerturbable(`${rel}: YAML 里出现制表符缩进（规范不允许），不扰动`)
  const lines = code.split('\n')
  const out = []
  let blockIndent = null // 块标量（`|`/`>`）的键缩进；缩进更深的行是字符串内容，原样保留
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) { out.push(line); continue }
      blockIndent = null
    }
    // 块标量行识别：输入的每一行都以 \n 切成单行、正则锚在 ^…$，嵌套量词只吃本行线性长度（无 ReDoS 可乘之机）
    // eslint-disable-next-line
    const blockScalar = /^(\s*(?:-\s+)?)([A-Za-z0-9_$][\w.$-]*) ?: +[|>][+-]?\d*\s*$/.exec(line)
    if (blockScalar) {
      blockIndent = indent
      out.push(line)
      continue
    }
    // 只动「行首缩进 + 可选 `- ` + 简单键 + 冒号 + 空格/行尾」这种块映射行；值里同样的 `x: y`
    // 不会被碰到（每行只替换最左一次，且键字符集排除了引号/括号/冒号）。
    // 块映射行改写：同样锚在单行首尾，且键字符集排除引号/括号/冒号（每行只替换最左一次）
    // eslint-disable-next-line
    out.push(line.replace(/^(\s*(?:-\s+)?)([A-Za-z0-9_$][\w.$-]* ?):( |$)/, '$1$2 :$3'))
  }
  const mutated = out.join('\n')
  if (mutated === code) throw new NotPerturbable(`${rel}: YAML 里没有可扰动的块映射行（可能是纯 flow/单行文档）`)
  return mutated
}

// Shell（`.sh` / `.bash` / `.githooks/*` 的钩子）：行内空白扰动。
// 语义不变的理由：shell 只在**引号外**按「空白串」切词，一个空格与两个空格是同一个分隔符；
// 注释行整行跳过（注释正文不是可执行语义）。
// 为什么动「第一个 token 间空白」而不是行尾补空格：`run_gate "lint"` 这类锚点是「命令 + 第一个参数」，
// 行尾空格不会让它失配（那是假绿）；行内空白会。整行没有可动的空白（`fi`、`esac`）时补行尾空格，
// 那同样不改语义。
// 跳过：shebang（必须是文件头两个字节）、续行（`\` 结尾）、heredoc 正文（是数据，不是代码）。
function mutateShellLine (line, isShebang) {
  if (isShebang || line.trim() === '') return line
  if (line.trimEnd().endsWith('\\')) return line
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line.at(i)
    if (quote) {
      if (c === '\\' && quote === '"') {
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === '\'' || c === '"') {
      quote = c
      continue
    }
    // `#` 在词首才是注释起点：注释整行原样保留（改注释正文没有探测价值，却会让 diff 变脏）。
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line
    if (/\s/.test(c) && i > 0 && !/\s/.test(line[i - 1])) return line.slice(0, i) + ' ' + line.slice(i)
  }
  return line + ' '
}

function perturbShell (code, rel) {
  const lines = code.split('\n')
  const out = []
  let heredoc = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines.at(index)
    if (heredoc) {
      out.push(line)
      const body = heredoc.stripTabs ? line.replace(/^\t+/, '') : line
      if (body === heredoc.word) heredoc = null
      continue
    }
    out.push(mutateShellLine(line, index === 0 && code.startsWith('#!')))
    // `<<'EOF'` / `<<-EOF`：正文原样保留到结束标记那一行（含）。
    const marker = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line)
    if (marker) heredoc = { word: marker[3], stripTabs: marker[1] === '-' }
  }
  const mutated = out.join('\n')
  if (mutated === code) throw new NotPerturbable(`${rel}: shell 里没有可扰动的空白行`)
  return mutated
}

// 「行首插入两格」式空白扰动：protected 里的行原样保留（跨行字符串/注释/代码块的内容行）。
function reindent (code, protectedLinesSet) {
  return code.split('\n').map((line, index) =>
    line.trim() === '' || (protectedLinesSet && protectedLinesSet.has(index + 1)) ? line : '  ' + line
  ).join('\n')
}

// 通用扫描器：逐字符走一遍，标出「字符串/注释/括号内」的行（受保护），并给出可插入空格的位置。
// 返回 { insertions, protectedLines }。CSS/HTML 共用同一套状态机（HTML 的括号保护更宽也无害）。
function scanTextAssets (code, { insertAt = '{};', protectParens = true } = {}) {
  const insertions = []
  const lineSet = new Set()
  let line = 1
  let quote = null
  let inComment = false
  let paren = 0
  for (let i = 0; i < code.length; i++) {
    const c = code.at(i)
    if (c === '\n') {
      if (quote || inComment || paren > 0) lineSet.add(line)
      line++
      continue
    }
    if (inComment) {
      if (c === '*' && code[i + 1] === '/') { inComment = false; i++ }
      continue
    }
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '/' && code[i + 1] === '*') { inComment = true; i++; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (protectParens && c === '(') { paren++; continue }
    if (protectParens && c === ')') { paren = Math.max(0, paren - 1); continue }
    // 到这里的 `quote` / `inComment` 恒为假：上面两条分支（inComment / quote）已经 continue 掉了。
    // 旧写法 `if (paren > 0 || (quote || inComment)) continue` 里的后两项是死分支（CodeQL 报
    // always-evaluates-to-false ×3），删掉后控制流不变，只留真正的括号保护。
    if (paren > 0) continue
    if (insertAt.includes(c)) insertions.push(i)
  }
  if (quote || inComment) lineSet.add(line) // 未闭合（不该发生）：末行也按受保护处理，宁可少扰动
  return { insertions, protectedLines: lineSet }
}

// CSS：`;`/`{`/`}` 两侧插空格 + 重缩进；字符串、注释、括号内（含 `url(…)` 的数据串）不动。
function perturbCss (code, rel) {
  const { insertions, protectedLines: skip } = scanTextAssets(code)
  if (!insertions.length) return reindent(code, skip)
  const parts = []
  let prev = 0
  for (const pos of insertions) {
    parts.push(code.slice(prev, pos), ' ')
    prev = pos
  }
  parts.push(code.slice(prev))
  return reindent(parts.join(''), skip)
}

// HTML：只重缩进（不动标签内空白，避免造出非法标签），`<pre>/<textarea>/<script>/<style>` 块内跳过。
function perturbHtml (code, rel) {
  const skip = new Set()
  let depth = 0
  let open = null
  code.split('\n').forEach((line, index) => {
    const no = index + 1
    if (depth > 0) skip.add(no)
    const opens = line.match(/<(pre|textarea|script|style)\b/gi) || []
    const closes = line.match(/<\/(pre|textarea|script|style)>/gi) || []
    if (opens.length && !open) { open = opens[opens.length - 1]; depth++ }
    if (closes.length && open) { depth = Math.max(0, depth - 1); if (!depth) open = null }
  })
  return reindent(code, skip)
}

// 扰动调度。未知格式/无法安全扰动 ⇒ NotPerturbable（调用方记 not-covered，不写盘）。
function mutate (code, rel) {
  switch (kindOf(rel)) {
    case 'js': return reformat(code, rel)
    case 'json': return perturbJson(code, rel)
    case 'yaml': return perturbYaml(code, rel)
    case 'css': return perturbCss(code, rel)
    case 'html': return perturbHtml(code, rel)
    case 'shell': return perturbShell(code, rel)
    default: throw new NotPerturbable(`${rel}: 不在扰动面（${path.extname(rel) || '无扩展名'}）`)
  }
}

/* ── 读取轨迹垫片（记录测试运行期读到的仓内文件） ───────────────────────────── */

const SHIM_SOURCE = `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const OUT = process.env.XBK_PROBE_TRACE
const ROOT = process.env.XBK_PROBE_ROOT
const seen = new Set()
function record (target) {
  try {
    if (!OUT || !ROOT) return
    if (typeof target !== 'string' && !Buffer.isBuffer(target) && !(target instanceof URL)) return
    let p = target instanceof URL ? target.pathname : String(target)
    if (!path.isAbsolute(p)) p = path.resolve(process.cwd(), p)
    if (!p.startsWith(ROOT + path.sep)) return
    if (p.includes(path.sep + 'node_modules' + path.sep) || p.includes(path.sep + '.git' + path.sep)) return
    if (seen.has(p)) return
    seen.add(p)
    fs.appendFileSync(OUT, p + '\\n')
  } catch {}
}
const origSync = fs.readFileSync
fs.readFileSync = function (target, ...rest) { record(target); return origSync.call(this, target, ...rest) }
const origPromise = fs.promises.readFile
fs.promises.readFile = function (target, ...rest) { record(target); return origPromise.call(this, target, ...rest) }
`

let shimPath = null
function shim () {
  if (shimPath) return shimPath
  // dir = mkdtempSync 在 os.tmpdir() 下新建的本进程独占目录，无外部净输入（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-probe-trace-'))
  shimPath = path.join(dir, 'read-trace.cjs')
  // shimPath = 上一步 mkdtemp 目录 + 常量文件名，写入内容是本文件的常量字符串（同上：裸注释的理由见文件头）
  // eslint-disable-next-line
  fs.writeFileSync(shimPath, SHIM_SOURCE) // nosemgrep（shimPath = mkdtempSync(os.tmpdir()) 结果 + 常量文件名，内容为本文件的常量字符串）
  return shimPath
}

function readTrace (traceFile) {
  let text
  try {
    // traceFile = 本进程刚在 mkdtemp 目录里建的轨迹文件，路径不含外部净输入（ESLint 侧为何是裸注释：见文件头）
    // eslint-disable-next-line
    text = fs.readFileSync(traceFile, 'utf8') // nosemgrep（traceFile = mkdtempSync(os.tmpdir()) 结果，由本进程刚创建）
  } catch {
    return []
  }
  const rels = new Set()
  for (const line of text.split('\n')) {
    if (!line) continue
    const rel = path.relative(ROOT, line)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    rels.add(rel)
  }
  return [...rels]
}

/* ── git 还原校验（Sonar S4036：先纯 JS 扫 PATH 得绝对路径，再以绝对路径 spawn） ── */

function resolveExecutable (name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      // candidate = PATH 目录 + 硬编码工具名（git），只做存在性/可执行位检查（ESLint 侧为何是裸注释：见文件头）
      // eslint-disable-next-line
      fs.accessSync(candidate, fs.constants.X_OK) // nosemgrep（candidate 由 PATH 目录 + 硬编码工具名（git）拼成，只做存在性/可执行位检查）
      // 同上：只 stat 刚解析出的绝对路径，不跟随仓库外输入
      // eslint-disable-next-line
      if (fs.statSync(candidate).isFile()) return candidate // nosemgrep（同上：只 stat 已解析出的绝对路径，不跟随仓库外输入）
    } catch {
      // 该候选目录不存在或不可执行：继续下一段 PATH 目录
    }
  }
  return null
}

function gitStatus () {
  const git = resolveExecutable('git')
  if (!git) return null
  const r = spawnSync(git, ['status', '--short', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  return r.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean)
}

/* ── 备份 / 还原 ──────────────────────────────────────────────────────────── */

const backups = new Map() // 相对路径 → 原文
const written = new Set() // 真正写盘（内容变了）的相对路径
const covered = new Set() // 已在扰动面内（含「重排后与原文相同」的文件）
const notPerturbable = new Map() // 相对路径 → 拒绝扰动的原因
const reference = new Set() // 运行前的仓内文件快照
let restored = false

function restoreAll () {
  if (restored) return []
  restored = true
  const failures = []
  for (const rel of written) {
    try {
      // 还原：rel 来自本文件扰动面枚举，写入的是刚刚读出的原文备份（ESLint 侧为何是裸注释：见文件头）
      // eslint-disable-next-line
      fs.writeFileSync(path.join(ROOT, rel), backups.get(rel)) // nosemgrep（rel 来自本文件扰动面枚举，写入的是刚刚读出的原文备份（还原路径））
    } catch (e) {
      failures.push(`${rel}: ${e.message}`)
    }
  }
  // 退出路径上必须留一行「还原了几个」：评审实测旧实现在 fail-closed 分支里 process.exit 跳过 finally，
  // 10 个真实生产文件被留在重排态而输出里一个字都没提（r4-3）。
  console.log(`已还原 ${written.size} 个文件${failures.length ? `（${failures.length} 个失败）` : ''}`)
  if (failures.length) {
    console.error('❌ 还原失败（以下文件可能仍是重排后的内容，请手工 git checkout --）：')
    failures.forEach((f) => console.error('  ' + f))
  }
  return failures
}

// 信号路径也还原：try/finally 管不到 SIGINT/SIGTERM（外部 timeout / Ctrl-C 是流水线里最常见的中断）。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`\n收到 ${sig}，还原生产文件…`)
    restoreAll()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  })
}

/* ── 跑测试 / 判读输出 ────────────────────────────────────────────────────── */

// 成功行的前缀：✅ 通过 / 🎉 汇总 / ℹ️ 提示。用 startsWith 而不是字符类正则——`ℹ️` 这类
// emoji 变体带 U+FE0F 选择符，写进字符类会被 standard 的 no-misleading-character-class 判红。
const SUCCESS_PREFIXES = ['✅', '🎉', 'ℹ️']

// 失败行的提示词。三条各自独立的字面量正则，而不是一条 `^❌|\bError\b|not ok` 的交替式：
// 那种写法把 `^` 只绑在第一个分支上、优先级不显式（Sonar S5850）；但也不能简单写成
// `^(?:❌|\bError\b|not ok)`——那会把「Error」收窄成只能出现在行首（丢掉 `Uncaught Error: …`、
// `exit code 1: Error: …` 这类真实失败行），与改动前的匹配面不一致。拆成三条后语义与旧式逐字相同。
const FAILURE_HINTS = [/^❌/, /\bError\b/, /not ok/]
const isFailureLine = (line) => FAILURE_HINTS.some((re) => re.test(line))

function firstFailureLine (output) {
  // 只保留「不是成功行」的行：套件里的 ✅ / 🎉 行常常也含「失败」字样（例如用例名），
  // 直接按关键词全局搜会抓到一条绿行当失败原因（本工具的第一版就这么错过）。
  const lines = String(output).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !SUCCESS_PREFIXES.some((p) => l.startsWith(p)))
  const hit = lines.find((l) => /AssertionError/.test(l)) ||
    lines.find(isFailureLine) ||
    lines[lines.length - 1] ||
    ''
  return hit.slice(0, 160)
}

function runTest (file) {
  const started = Date.now()
  // 轨迹文件名必须不可预测且进程内唯一：旧实现用 `Math.random().toString(36)`（Codacy 的弱随机告警），
  // 换成 CSPRNG 的 6 字节随机（48 位 + pid，同目录下不会撞名）。文件名只用于本进程写读删，不含敏感数据。
  const traceFile = path.join(path.dirname(shim()), 'trace-' + process.pid + '-' + randomBytes(6).toString('hex') + '.log')
  const nodeOptions = [process.env.NODE_OPTIONS, '--require', '"' + shim() + '"'].filter(Boolean).join(' ')
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      TZ: 'UTC',
      XBK_PROBE_TRACE: traceFile,
      XBK_PROBE_ROOT: ROOT,
      NODE_OPTIONS: nodeOptions
    }
  })
  const output = (r.stdout || '') + (r.stderr || '')
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT')
  const traced = readTrace(traceFile)
  // traceFile = 本进程刚在 mkdtemp 目录里建的临时轨迹文件（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  try { fs.rmSync(traceFile, { force: true }) } catch { /* 临时轨迹文件删不掉不影响结论 */ } // nosemgrep（同上：临时文件在 mkdtemp 目录里）
  return {
    file,
    code: r.status,
    timedOut,
    ms: Date.now() - started,
    traced,
    detail: timedOut ? `超时（>${TIMEOUT_MS}ms）` : (r.status === 0 ? '' : firstFailureLine(output))
  }
}

// 轨迹对账：扰动面之内 ⇒ 已覆盖；测试面 ⇒ 由 assert-style 闸管辖（out-of-scope）；
// 运行期产物（不在快照里）⇒ 不参与；其余 ⇒ not-covered（fail-closed）。
function classify (traced) {
  const coveredHits = []
  const outOfScope = []
  const notCovered = []
  for (const rel of traced) {
    if (covered.has(rel)) coveredHits.push(rel)
    else if (isTestSurface(rel)) outOfScope.push(rel)
    else if (!reference.has(rel)) continue
    else notCovered.push(rel)
  }
  return { coveredHits, outOfScope, notCovered }
}

// `--min-candidates=N` / `--min-candidates N`：夹具工作区显式放宽扰动面下限（默认 MIN_CANDIDATES）。
// 非法值（负数 / 非整数）fail-closed：写错参数的探针不该安静地按默认值跑。
function minCandidates () {
  const inline = process.argv.find((arg) => arg.startsWith('--min-candidates='))
  const index = process.argv.indexOf('--min-candidates')
  const raw = inline
    ? inline.slice('--min-candidates='.length)
    : (index >= 0 ? process.argv[index + 1] : undefined)
  if (raw === undefined) return MIN_CANDIDATES
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) die(2, `--min-candidates 必须是非负整数，实得 ${JSON.stringify(raw)}`)
  return value
}

function main () {
  let tests = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  // `--min-candidates N` 的 N 不是测试文件（避免把 0 当成测试名跑起来）。
  const minIndex = process.argv.indexOf('--min-candidates')
  if (minIndex >= 0) tests = tests.filter((t) => t !== process.argv[minIndex + 1])
  const explicit = tests.length > 0
  // DEFAULT_TESTS 是本文件硬编码常量名单、ROOT 是 __dirname 常量，只做存在性检查不写盘（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  if (!explicit) tests = DEFAULT_TESTS.filter((t) => fs.existsSync(path.join(ROOT, t))) // nosemgrep（理由：DEFAULT_TESTS 是本文件硬编码常量名单、ROOT 是 __dirname 常量，只做存在性检查不写盘）
  if (!tests.length) {
    die(2, '用法：node scripts/probe-format-coupling.js test_a.js [test_b.js …]\n' +
      '  把扰动面（.js/.mjs/.cjs/.json/.yml/.yaml/.css/.html/shell）重排后逐条跑测试；重排后仍绿的记为 format-clean，\n' +
      '  读到扰动面之外的文件记为 format-uncertified（exit 2）。不带参数时跑内置自检集：' + DEFAULT_TESTS.join(' '))
  }
  // t 只来自命令行给出的测试文件名，用于存在性检查、不写盘（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  const missing = tests.filter((t) => !fs.existsSync(path.join(ROOT, t))) // nosemgrep（t 只来自命令行给出的测试文件名，用于存在性检查；不写盘）
  if (missing.length) die(2, '测试文件不存在：' + missing.join(', '))

  const baseline = gitStatus()
  if (!baseline) console.error('⚠️ 读不到 git status（不是 git 仓库或 git 不可用），还原只能靠退出码判断。')

  for (const rel of snapshotFiles()) reference.add(rel)
  const files = perturbableFiles()
  // 扰动面塌缩一律 fail-closed（r13-7）：「候选 0 个」与「全部不耦合」输出长得一样，不能靠人眼区分。
  if (!files.length) {
    die(2, '❌ 扰动面为 0 个候选：walk()/SKIP_DIRS 回归了？这不能读作「所有测试都不耦合格式」。' +
      '（夹具工作区请用 --min-candidates=N 显式放宽下限）')
  }
  const floor = minCandidates()
  if (files.length < floor) {
    die(2, `❌ 扰动面只有 ${files.length} 个候选（下限 ${floor}）：扰动太少时「全部 format-clean」不是证据。` +
      '真仓请先修 walk()/SKIP_DIRS；夹具工作区用 --min-candidates=N 显式放宽。')
  }
  // rel 来自扰动面枚举，读取的是本仓文件（探针必须先读原文才能还原）（ESLint 侧为何是裸注释：见文件头）
  // eslint-disable-next-line
  for (const rel of files) backups.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')) // nosemgrep（rel 来自扰动面枚举，读取的是本仓文件（探针必须先读原文才能还原））

  const results = []
  let fatal = null
  let restoreFailures = []
  console.log(`扰动面：候选 ${files.length} 个（.js/.mjs/.cjs + .json/.yml/.yaml/.css/.html + shell（.sh/.bash/.githooks 钩子），测试面除外）`)
  try {
    for (const rel of files) {
      const original = backups.get(rel)
      let mutated
      try {
        mutated = mutate(original, rel)
      } catch (e) {
        if (!(e instanceof NotPerturbable)) throw e
        notPerturbable.set(rel, e.message)
        continue
      }
      if (mutated === original) {
        covered.add(rel) // 无可扰动：本身就不含排版，重排不可能让它失配
        continue
      }
      // 重排必须是**语义不变**的：输出解析不了说明扰动本身把代码改坏了，此时跑出来的红是假信号
      // （会把「探针实现有 bug」记成「测试排版耦合」）。响亮失败，不产生 coupled 结论。
      if (kindOf(rel) === 'js' && (FORCE_UNPARSEABLE.has(rel) || !parseable(mutated))) {
        // r4-3：这里**必须 throw**——旧实现在 try 体内 process.exit(2)，跳过 finally 的 restoreAll()，
        // 于是这条「探针自身 bug」的 fail-closed 分支恰好是最需要还原的路径却不还原：评审实测 10 个真实
        // 生产文件被留在重排态、输出里一个字都没提。throw 之后由 finally 还原，还原校验排在所有 exit 之前。
        throw new Error(`❌ 重排后无法解析 ${rel}（探针自身的 bug，不是排版耦合）`)
      }
      // rel/mutated 都来自扰动面枚举与刚做的重排结果，只在探针运行期内写、finally 还原（ESLint 侧为何是裸注释：见文件头）
      // eslint-disable-next-line
      fs.writeFileSync(path.join(ROOT, rel), mutated) // nosemgrep（rel/mutated 都来自扰动面枚举与刚做的重排结果，只在探针运行期内写、finally 还原）
      written.add(rel)
      covered.add(rel)
    }
    console.log(`已扰动 ${written.size} 个文件` +
      `（无需扰动 ${covered.size - written.size} 个，无法安全扰动 ${notPerturbable.size} 个 → 若被读到判 not-covered）\n`)
    // 一个文件都没写盘 ⇒ 后面每条测试都会「因为重排无关而绿」，这个结论没有证据（r13-7 fail-closed）。
    if (!written.size) {
      throw new Error('❌ 扰动面写了 0 个文件：没有任何文件被重排，「全部 format-clean」不能读作不耦合（fail-closed）')
    }
    console.log('扰动方式：js/mjs/cjs = 词法边界插空格 + 重缩进；json = 紧凑单行；yaml = 块映射键后加空格（块标量内不动）；shell = 行内空白加倍；' +
      'css = 字符串/注释/括号外插空格 + 重缩进；html = 重缩进\n')
    for (const test of tests) {
      const r = runTest(test)
      const { coveredHits, outOfScope, notCovered } = classify(r.traced)
      results.push({ ...r, coveredHits, outOfScope, notCovered })
      const verdict = r.code !== 0 ? 'format-coupled' : (notCovered.length ? 'format-uncertified' : 'format-clean ')
      console.log(`  ${test}  ${verdict}  exit=${r.code}  ${(r.ms / 1000).toFixed(1)}s` +
        (r.detail ? `\n      ↳ ${r.detail}` : '') +
        (notCovered.length ? `\n      ↳ 读到扰动面之外：${notCovered.slice(0, 6).join(', ')}${notCovered.length > 6 ? ` …共 ${notCovered.length} 个` : ''}` : ''))
    }
  } catch (e) {
    fatal = e
  } finally {
    restoreFailures = restoreAll()
  }

  // 还原可验证：与运行前的 git status 比对，出现**新增**改动即判还原失败（不静默相信 writeFileSync）。
  // 这一步排在**任何 exit 之前**（r4-3）：否则 fail-closed 分支会把脏工作树留给后续所有测试与 CI。
  const after = gitStatus()
  let dirty = false
  if (baseline && after) {
    const before = new Set(baseline)
    const extra = after.filter((l) => !before.has(l))
    if (extra.length) {
      dirty = true
      console.error('\n❌ 还原后工作树出现新增改动（疑似未还原），请先 git checkout -- 再重跑：')
      extra.forEach((l) => console.error('  ' + l))
    } else {
      console.log(`还原校验：git status --short 与运行前一致（${after.length} 项）` +
        (after.length ? '' : '，工作树干净'))
    }
  }
  // 优先级：还原失败 > fail-closed（用法/词法/not-covered）> coupled —— 还原失败意味着工作树里躺着被改过的
  // 生产代码，比「某条测试红了」严重得多，必须是唯一的失败口径（否则 1 会盖住 3）。
  if (restoreFailures.length || dirty) die(3, '❌ 还原失败：生产文件可能仍是重排后的内容（见上，先 git checkout --）')
  if (fatal) die(2, fatal.message)

  const uncertified = results.filter((r) => r.notCovered.length)
  if (uncertified.length) {
    const byFile = new Map()
    for (const r of uncertified) {
      for (const rel of r.notCovered) {
        if (!byFile.has(rel)) byFile.set(rel, { tests: [], reason: notPerturbable.get(rel) || '不在扰动面' })
        byFile.get(rel).tests.push(r.file)
      }
    }
    console.error(`\n❌ not-covered ${byFile.size} 个文件：测试读到了它们，但它们不在扰动面内——` +
      '不能判 format-clean（格式耦合无法取证）：')
    ;[...byFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).forEach(([rel, info]) => {
      console.error(`  ${rel}  ← ${info.tests.join(', ')}（${info.reason}）`)
    })
    die(2, 'not-covered：要么把该资产纳入扰动面（scripts/probe-format-coupling.js 的 mutate），' +
      '要么先把这些断言换成结构/配置/行为断言，再重跑。')
  }

  const coupled = results.filter((r) => r.code !== 0)
  const clean = results.length - coupled.length
  console.log(`\n汇总：format-coupled ${coupled.length} / format-clean ${clean}` +
    (results.some((r) => r.outOfScope.length) ? `（另有 ${results.reduce((n, r) => n + r.outOfScope.length, 0)} 个测试面文件被读到，由 assert-style 闸管辖）` : '') +
    (notPerturbable.size ? `；未扰动 ${notPerturbable.size} 个文件（未被读到，不影响结论）` : ''))
  if (coupled.length) {
    console.log('format-coupled 说明这些测试的断言绑在源码排版上（读源码文本/结构片段）——' +
      '本批目标是让它们重排后仍绿：改用 test_support/source_model.js 的 AST 断言、配置解析断言或行为断言。')
    process.exit(1)
  }
  console.log('✅ 全部 format-clean')
}

module.exports = { reformat, protectedLines, productionFiles, perturbableFiles, mutate, NotPerturbable, kindOf }

if (require.main === module) main()
