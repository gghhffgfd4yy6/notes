#!/usr/bin/env node
'use strict'
/*
 * 格式耦合探针：判断一个测试是否**绑死**了生产源码的排版。
 *
 * 做法：把生产 JS（仓内 .js/.mjs/.cjs，测试面除外）按语义不变的方式重排 → 逐个跑传入的测试（TZ=UTC）
 * → 无论成败都还原。
 *   - 重排后仍绿 ⇒ format-clean（该测试不依赖生产源码的排版）
 *   - 重排后变红 ⇒ format-coupled（断言在读源码文本/结构片段——本批要清掉的形态）
 *
 * 重排（acorn 词法定位，字符串/模板/正则/注释内不动）：`,`/`(`/`{` 之后与 `(`/`)`/`}` 之前各插一个空格，
 * 再把非空行统一缩进两格（跨行字符串/模板/正则覆盖的行与 shebang 行跳过——行首空白在那些行是运行期数据）。
 * `(` 前也插一个空格是必需的：只往 `(` 后面插时，以 `(` 结尾的锚点（`…name (`，S0 的动机锚点）
 * 重排后文本不变、会被判成 clean（假绿）。重排后必须仍能解析，否则按探针自身 bug 退出（exit 2），
 * 不产出 coupled 结论——那是把工具 bug 伪装成「测试耦合」。
 *
 * 还原（不可删的能力）：扰动写盘前逐文件留原文备份，`try/finally` 里写回；SIGINT/SIGTERM/SIGHUP 也还原
 * （try/finally 管不到信号）。退出前打印「已还原 N 个文件」，再拿 `git status --short` 与运行前比对，
 * 出现**新增**改动即 exit 3 并点名——不静默相信 writeFileSync 成功。
 *
 * 不覆盖（本版刻意删掉，不要误以为已守）：非 JS 资产（.json/.yml/.css/.html/shell 钩子）不扰动，
 * 因此「读 yml/css 文本」的断言在这里永远判 clean。那一层由 `scripts/check-source-text-asserts.js`
 * 按「测试文件 → 读取文本断言条数」守（扫描面含测试面全部 .js），探针只回答生产 JS 这一问。
 *
 * 退出码：0 全部 format-clean / 1 存在 format-coupled / 2 用法错误、词法错误、扰动面塌缩 /
 *        3 还原失败（工作树有新增改动）。
 *
 * 用法：node scripts/probe-format-coupling.js test_console.js [test_b.js …]
 *      PROBE_TIMEOUT_MS=900000 可调单条测试上限（默认 15 分钟，超时按 coupled 计，fail-closed）。
 *
 * 静态分析豁免：下面 fs.* 的目标路径按设计必然是变量（ROOT = __dirname 常量 + 本文件硬编码相对段，
 * 没有外部净输入参与构造，也不碰仓库之外的位置）。opengrep 侧由行尾 `// nosemgrep` 压住；ESLint 侧
 * 只认 `// eslint-disable-next-line`（裸形态：standard 17 未装 eslint-plugin-security，指名规则会
 * 报 "Definition for rule … was not found" 并整体判红）。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const LEX_OPTS = { ecmaVersion: 'latest', allowHashBang: true, locations: true }
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 15 * 60 * 1000
// 目录跳过名单逐个登记（不按「点开头」一刀切：`.github/**`、`.githooks/**` 不是 JS，进不了扰动面，
// 但也不该因为名字带点就让将来新增的 JS 目录被漏掉）。
const SKIP_DIRS = new Set(['node_modules', '.git', '.stryker-tmp', '.nyc_output', 'coverage', 'reports', 'scratch', '.local', '.ai', '.tools'])
const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
// 扰动面下限：候选数低于下限或实际写盘 0 个 ⇒ exit 2。否则「walk() 回归导致扰动面塌缩」与
// 「所有测试都不耦合格式」在输出上逐字相同，而 RUNBOOK 把探针绿当机械判据。
const MIN_CANDIDATES = 20
// 无参自检集：两个不读仓内文本的套件（只依赖自己写的临时夹具），用来证明「探针本身能跑通且不误判」。
const DEFAULT_TESTS = ['test_utils_pure.js', 'test_source_model.js']

function die (code, message) {
  console.error(message)
  process.exit(code)
}

// 测试面由 assert-style 闸管辖：不从生产面扰动它（扰动测试文件自身会让「测试读自己」永远假红）。
const isTestSurface = (rel) => /^test_.*\.js$/.test(rel) || rel.startsWith('test/') || rel.startsWith('test_support/')

function walk (dir, out = []) {
  const abs = path.join(ROOT, dir)
  // abs = ROOT（__dirname 常量）+ 仓内相对目录，扫描面就是本仓，无外部净输入（ESLint 侧理由见文件头）
  // eslint-disable-next-line
  if (!fs.existsSync(abs)) return out // nosemgrep（abs = ROOT 常量 + 仓内相对目录）
  // 同上：只遍历本仓目录项（ESLint 侧理由见文件头）
  // eslint-disable-next-line
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) { // nosemgrep（同上：只遍历本仓）
    const rel = dir ? dir + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

// 扰动面 = 仓内所有生产 JS（测试面除外，按路径码元序稳定）。
function productionFiles () {
  return walk('')
    .filter((rel) => JS_EXT.has(path.extname(rel).toLowerCase()) && !isTestSurface(rel))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/* ── 词法级重排 ─────────────────────────────────────────────────────────── */

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

// script / module 各试一次：`scripts/console-assets/*` 是浏览器 ESM，按 script 切词必失败。
function tokenize (code) {
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
  throw new Error(`词法解析失败，无法安全重排：${errors.join('；')}`)
}

function reformat (code) {
  const tokens = tokenize(code)
  const insertions = []
  for (const token of tokens) {
    const label = token.type.label
    if (label === ',' || label === '(' || label === '{') insertions.push(token.end)
    if (label === '(' || label === ')' || label === '}') insertions.push(token.start)
  }
  let text = code
  if (insertions.length) {
    insertions.sort((a, b) => a - b)
    const parts = []
    let prev = 0
    for (const pos of insertions) {
      parts.push(code.slice(prev, pos), ' ')
      prev = pos
    }
    parts.push(code.slice(prev))
    text = parts.join('')
  }
  const skip = protectedLines(tokens)
  // shebang 必须是文件头两个字节：缩进会让整个文件解析失败（那是把探针 bug 伪装成耦合）。
  if (code.startsWith('#!')) skip.add(1)
  return text.split('\n').map((line, index) =>
    line.trim() === '' || skip.has(index + 1) ? line : '  ' + line
  ).join('\n')
}

function parseable (code) {
  for (const sourceType of ['script', 'module']) {
    try {
      acorn.parse(code, { ...LEX_OPTS, sourceType })
      return true
    } catch { /* 试下一种 */ }
  }
  return false
}

/* ── 还原 ───────────────────────────────────────────────────────────────── */

const backups = new Map() // 相对路径 → 原文
const written = new Set() // 真正写盘（内容变了）的相对路径
let restored = false

function restoreAll () {
  if (restored) return []
  restored = true
  const failures = []
  for (const rel of written) {
    try {
      fs.writeFileSync(path.join(ROOT, rel), backups.get(rel)) // nosemgrep（rel 来自本文件扰动面枚举，写入的是刚读出的原文备份）
    } catch (e) {
      failures.push(`${rel}: ${e.message}`)
    }
  }
  // 退出路径上必须留一行「还原了几个」：fail-closed 分支曾因 process.exit 跳过 finally，
  // 让被重排的生产文件留在工作树里而输出一个字都不提。
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

/* ── git 状态对账（纯 JS 扫 PATH 得绝对路径，再以绝对路径 spawn） ─────────── */

function resolveExecutable (name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK) // nosemgrep（candidate = PATH 目录 + 硬编码工具名，只做存在性检查）
      if (fs.statSync(candidate).isFile()) return candidate // nosemgrep（同上：只 stat 已解析出的绝对路径）
    } catch { /* 继续下一段 PATH */ }
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

/* ── 跑测试 / 判读 ──────────────────────────────────────────────────────── */

// 成功行前缀（✅ 通过 / 🎉 汇总 / ℹ️ 提示）：套件里这些行常常也含「失败」字样，先排掉再找失败原因。
const SUCCESS_PREFIXES = ['✅', '🎉', 'ℹ️']
const FAILURE_HINTS = [/^❌/, /\bError\b/, /not ok/]

function firstFailureLine (output) {
  const lines = String(output).split('\n').map((l) => l.trim())
    .filter((l) => l && !SUCCESS_PREFIXES.some((p) => l.startsWith(p)))
  const hit = lines.find((l) => /AssertionError/.test(l)) ||
    lines.find((l) => FAILURE_HINTS.some((re) => re.test(l))) ||
    lines[lines.length - 1] ||
    ''
  return hit.slice(0, 160)
}

function runTest (rel) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [rel], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' }
  })
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT')
  return {
    file: rel,
    code: r.status,
    ms: Date.now() - started,
    detail: timedOut ? `超时（>${TIMEOUT_MS}ms）` : (r.status === 0 ? '' : firstFailureLine((r.stdout || '') + (r.stderr || '')))
  }
}

// `--min-candidates=N` / `--min-candidates N`：夹具工作区显式放宽扰动面下限。非法值 fail-closed。
function minCandidates () {
  const inline = process.argv.find((arg) => arg.startsWith('--min-candidates='))
  const index = process.argv.indexOf('--min-candidates')
  const raw = inline ? inline.slice('--min-candidates='.length) : (index >= 0 ? process.argv[index + 1] : undefined)
  if (raw === undefined) return MIN_CANDIDATES
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) die(2, `--min-candidates 必须是非负整数，实得 ${JSON.stringify(raw)}`)
  return value
}

function main () {
  let tests = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const minIndex = process.argv.indexOf('--min-candidates')
  if (minIndex >= 0) tests = tests.filter((t) => t !== process.argv[minIndex + 1])
  // 无参 ⇒ 跑内置自检集（无参即 exit 0 才说明「探针本身可用」）。
  if (!tests.length) tests = DEFAULT_TESTS.filter((t) => fs.existsSync(path.join(ROOT, t))) // nosemgrep（DEFAULT_TESTS 是本文件硬编码常量名单，只做存在性检查）
  if (!tests.length) {
    die(2, '用法：node scripts/probe-format-coupling.js test_a.js [test_b.js …]\n' +
      '  把生产 JS 重排后逐条跑测试：仍绿记 format-clean，变红记 format-coupled。' +
      '不带参数时跑内置自检集：' + DEFAULT_TESTS.join(' '))
  }
  // t 只来自命令行给出的测试文件名，只做存在性检查、不写盘（ESLint 侧理由见文件头）
  // eslint-disable-next-line
  const missing = tests.filter((t) => !fs.existsSync(path.join(ROOT, t))) // nosemgrep（t 只来自命令行，仅做存在性检查）
  if (missing.length) die(2, '测试文件不存在：' + missing.join(', '))

  const baseline = gitStatus()
  if (!baseline) console.error('⚠️ 读不到 git status（不是 git 仓库或 git 不可用），还原只能靠退出码判断。')

  const files = productionFiles()
  if (!files.length) die(2, '❌ 扰动面为 0 个候选：walk()/SKIP_DIRS 回归了？这不能读作「所有测试都不耦合格式」。')
  const floor = minCandidates()
  if (files.length < floor) {
    die(2, `❌ 扰动面只有 ${files.length} 个候选（下限 ${floor}）：扰动太少时「全部 format-clean」不是证据。`)
  }
  for (const rel of files) backups.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')) // nosemgrep（rel 来自扰动面枚举，必须先读原文才能还原）

  const results = []
  let fatal = null
  let restoreFailures = []
  console.log(`扰动面：生产 JS 候选 ${files.length} 个（测试面除外）`)
  try {
    for (const rel of files) {
      const original = backups.get(rel)
      const mutated = reformat(original)
      if (mutated === original) continue
      // 重排必须语义不变：解析不了说明扰动把代码改坏了，此时的红是假信号（探针自身的 bug）。
      // 这里必须 throw（不是 process.exit）：exit 会跳过 finally 的还原。
      if (!parseable(mutated)) throw new Error(`❌ 重排后无法解析 ${rel}（探针自身的 bug，不是排版耦合）`)
      fs.writeFileSync(path.join(ROOT, rel), mutated) // nosemgrep（rel/mutated 来自扰动面枚举与刚做的重排结果，finally 还原）
      written.add(rel)
    }
    console.log(`已扰动 ${written.size} 个文件\n`)
    if (!written.size) throw new Error('❌ 扰动面写了 0 个文件：没有任何文件被重排，「全部 format-clean」不能读作不耦合（fail-closed）')
    for (const test of tests) {
      const r = runTest(test)
      results.push(r)
      console.log(`  ${test}  ${r.code !== 0 ? 'format-coupled' : 'format-clean '}  exit=${r.code}  ${(r.ms / 1000).toFixed(1)}s` +
        (r.detail ? `\n      ↳ ${r.detail}` : ''))
    }
  } catch (e) {
    fatal = e
  } finally {
    restoreFailures = restoreAll()
  }

  // 还原可验证：与运行前的 git status 比对，出现**新增**改动即判还原失败。这一步排在任何 exit 之前。
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
      console.log(`还原校验：git status --short 与运行前一致（${after.length} 项）`)
    }
  }
  // 优先级：还原失败 > fail-closed > coupled —— 工作树里躺着被改过的生产代码比「某条测试红了」严重。
  if (restoreFailures.length || dirty) die(3, '❌ 还原失败：生产文件可能仍是重排后的内容（见上，先 git checkout --）')
  if (fatal) die(2, fatal.message)

  const coupled = results.filter((r) => r.code !== 0)
  console.log(`\n汇总：format-coupled ${coupled.length} / format-clean ${results.length - coupled.length}`)
  if (coupled.length) {
    console.log('format-coupled 说明断言绑在源码排版上——改用 test_support/source_model.js 的 AST 断言、配置解析断言或行为断言。')
    process.exit(1)
  }
  console.log('✅ 全部 format-clean')
}

module.exports = { reformat, protectedLines, productionFiles }

if (require.main === module) main()
