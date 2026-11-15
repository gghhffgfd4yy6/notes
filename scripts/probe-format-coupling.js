#!/usr/bin/env node
'use strict'
/*
 * 格式耦合探针（S0）：判断一个测试是否**绑死**了生产源码的排版。
 *
 * 做法：把生产 JS（仓库根 `*.js` 去掉 `test_*`，加上 `scripts/`、`qinglong/` 全量）用 acorn 词法重排——
 * 在词法安全的边界上做**多种空白扰动**：每个 `,`/`(`/`{` 之后、`)`/`}` 之前各插一个空格，
 * 再把非空行统一重缩进两格（跨行字符串/模板/正则覆盖到的行跳过，动它们等于改运行期数据）；
 * 字符串/模板/正则/注释里的同样字符不是词法记号，天然不动，语义完全不变；然后逐个跑传入的测试（TZ=UTC）。
 *
 * 为什么不能只插 `,`/`(` 之后：锚点本身以 `(` 结尾时（`src.includes('function messagesCacheName (')`），
 * 只往 `(` 后面插空格不会改变**锚点字面量所在的文本片段**，重排后断言照样通过 ⇒ 假绿。
 * 现在 `(` 与 `)` 两侧同时扰动（`name (x)` → `name ( x )`）+ 重缩进，锚点必然失配。
 *   - 重排后仍绿 ⇒ format-clean（该测试不依赖源码排版）
 *   - 重排后变红 ⇒ format-coupled（说明断言在读源码文本/结构，重排就误红——正是本批要清掉的形态）
 * 无论成败（含异常、Ctrl-C）都还原原文；还原可验证：跑完 `git status --short` 必须与运行前一致，
 * 出现新的改动即 exit 3 并点名文件（不静默相信「我还原过了」）。
 *
 * 退出码：0 全部 format-clean / 1 存在 format-coupled / 2 用法或词法错误 / 3 还原失败（工作树有新增改动）。
 *
 * 用法：node scripts/probe-format-coupling.js test_console.js test_utils_pure.js
 *      PROBE_TIMEOUT_MS=900000 可调单条测试上限（默认 15 分钟，超时按 coupled 计，fail-closed）。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const LEX_OPTS = { ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', locations: true }
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 15 * 60 * 1000
const WALK_DIRS = ['scripts', 'qinglong']
const SKIP_DIRS = new Set(['node_modules', '.git', '.stryker-tmp', '.nyc_output', 'coverage', 'reports', 'scratch'])

function die (code, message) {
  console.error(message)
  process.exit(code)
}

function walkJs (dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out // nosemgrep（abs = ROOT（__dirname 常量）+ 仓库内相对目录，探针的扫描面就是本仓生产 JS）
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) { // nosemgrep（同上：只遍历本仓 scripts/ 与 qinglong/）
    const rel = dir + '/' + entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walkJs(rel, out)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(rel)
    }
  }
  return out
}

// 生产 JS 面：根目录 *.js（排除 test_*.js）+ scripts/ + qinglong/。
// 根目录里 run_tests.js / run_mutation.js 这类工具脚本也算在内——它们同样被测件 require，重排后语义不变。
function productionFiles () {
  const root = fs.readdirSync(ROOT, { withFileTypes: true }) // nosemgrep（同上：扫描面为本仓生产 JS 清单，不接受外部入参）
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('test_'))
    .map((e) => e.name)
  return [...root, ...WALK_DIRS.flatMap((d) => walkJs(d))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// 词法边界的空白扰动：`(`、`{`、`,` 之后与 `)`、`}` 之前各插一个空格，然后统一重缩进。
// 按 token 边界插而不是对原文做正则替换：字符串/模板/正则/注释里的同样字符根本不是记号，
// 因此不会被误改（那是语义改动，会造出假红）。
//
// 重缩进必须跳过「跨行字符串/模板/正则」覆盖到的行：那些行首空白是**字符串内容**的一部分，
// 改它会改变运行期数据，把「语义改动」伪装成「排版耦合」。同行的首行不受影响（行首空白在
// 字符串开始之前），末行也一并跳过（末行行首空白仍在字符串里）。
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

// script / module 各试一次：`scripts/console-assets/*.js` 是浏览器 ESM，按 script 解析必失败。
function parseable (code) {
  for (const sourceType of ['script', 'module']) {
    try {
      acorn.parse(code, { ...LEX_OPTS, sourceType })
      return true
    } catch { /* 试下一种 */ }
  }
  return false
}

function reformat (code, file) {
  const insertions = []
  const tokens = []
  try {
    const lexer = acorn.tokenizer(code, LEX_OPTS)
    for (;;) {
      const token = lexer.getToken()
      if (token.type === acorn.tokTypes.eof) break
      tokens.push(token)
      const label = token.type.label
      if (label === ',' || label === '(' || label === '{') insertions.push(token.end)
      // `(` 前也插一个空格：只往 `(` 后面插时，以 `(` 结尾的锚点（`…name (`）**完全不受影响**，
      // 探针会把它判成 format-clean——S0 的动机锚点正是这种形状，必须由 `(` 前这一格打破。
      if (label === '(' || label === ')' || label === '}') insertions.push(token.start)
    }
  } catch (e) {
    // 词法失败 = 这个文件没法安全重排。响亮失败而不是跳过：跳过会把它排除在探针面之外，
    // 于是「该文件里的排版耦合」永远探不到，而输出仍然好看（静默失效）。
    throw new Error(`词法解析失败，无法安全重排 ${file}: ${e.message}`)
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

// Sonar S4036：按名 spawnSync('git', …) 让子进程经 PATH 解析可执行文件，静态分析判为依赖未受控的
// 查找路径。本仓既有口径（scripts/check-ci-static.js 的 resolveTool、test_install_hooks.js 的 git 解析）
// 是先用纯 JS 扫 PATH 得到绝对路径、再以该绝对路径 spawn——这里同款处理，不挂 NOSONAR 压制。
// 解析不到返回 null（调用方按「读不到 git status」原有语义降级：只靠退出码判断还原）。
function resolveExecutable (name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK) // nosemgrep（candidate 由 PATH 目录 + 硬编码工具名（git）拼成，只做存在性/可执行位检查）
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

const backups = new Map() // 相对路径 → 原文
const written = new Set()
let restored = false

function restoreAll () {
  if (restored) return []
  restored = true
  const failures = []
  for (const rel of written) {
    try {
      fs.writeFileSync(path.join(ROOT, rel), backups.get(rel)) // nosemgrep（rel 来自本文件的生产文件枚举，写入的是刚刚读出的原文备份（还原路径））
    } catch (e) {
      failures.push(`${rel}: ${e.message}`)
    }
  }
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
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' }
  })
  const output = (r.stdout || '') + (r.stderr || '')
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT')
  return {
    file,
    code: r.status,
    timedOut,
    ms: Date.now() - started,
    detail: timedOut ? `超时（>${TIMEOUT_MS}ms）` : (r.status === 0 ? '' : firstFailureLine(output))
  }
}

function main () {
  const tests = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  if (!tests.length) {
    die(2, '用法：node scripts/probe-format-coupling.js <test_a.js> [test_b.js …]\n' +
      '  把生产 JS 按「`,` / `(` 后加空格」重排后逐条跑测试；重排后仍绿的记为 format-clean。')
  }
  const missing = tests.filter((t) => !fs.existsSync(path.join(ROOT, t))) // nosemgrep（t 只来自命令行给出的测试文件名，用于存在性检查；不写盘）
  if (missing.length) die(2, '测试文件不存在：' + missing.join(', '))

  const baseline = gitStatus()
  if (!baseline) console.error('⚠️ 读不到 git status（不是 git 仓库或 git 不可用），还原只能靠退出码判断。')

  const files = productionFiles()
  for (const rel of files) backups.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')) // nosemgrep（rel 来自生产文件枚举，读取的是本仓源码（探针必须先读原文才能还原））

  console.log(`生产文件重排：${files.length} 个（根目录 *.js 排除 test_* + scripts/ + qinglong/）`)
  const results = []
  let restoreFailures = []
  try {
    for (const rel of files) {
      const original = backups.get(rel)
      const mutated = reformat(original, rel)
      if (mutated === original) continue
      // 重排必须是**语义不变**的：输出解析不了说明扰动本身把代码改坏了，此时跑出来的红是假信号
      // （会把「探针实现有 bug」记成「测试排版耦合」）。响亮退出，不产生 coupled 结论。
      if (!parseable(mutated)) {
        die(2, `❌ 重排后无法解析 ${rel}（探针自身的 bug，不是排版耦合）`)
      }
      fs.writeFileSync(path.join(ROOT, rel), mutated) // nosemgrep（rel/mutated 都来自生产文件枚举与刚做的重排结果，只在探针运行期内写、finally 还原）
      written.add(rel)
    }
    console.log(`已重排 ${written.size} 个文件（\`,\`/\`(\`/\`{\` 后与 \`)\`/\`}\` 前插空格 + 统一重缩进）\n`)
    for (const test of tests) {
      const r = runTest(test)
      results.push(r)
      const verdict = r.code === 0 ? 'format-clean ' : 'format-coupled'
      console.log(`  ${test}  ${verdict}  exit=${r.code}  ${(r.ms / 1000).toFixed(1)}s` +
        (r.detail ? `\n      ↳ ${r.detail}` : ''))
    }
  } finally {
    restoreFailures = restoreAll()
  }

  // 还原可验证：与运行前的 git status 比对，出现**新增**改动即判还原失败（不静默相信 writeFileSync）。
  const after = gitStatus()
  let dirty = false
  if (baseline && after) {
    const before = new Set(baseline)
    const extra = after.filter((l) => !before.has(l))
    if (extra.length) {
      dirty = true
      console.error('\n❌ 还原后工作树出现新增改动（疑似未还原），请先 git checkout -- 再重跑：')
      extra.forEach((l) => console.error('  ' + l))
      if (after.length === 0) console.error('  （空）')
    } else {
      console.log(`\n还原校验：git status --short 与运行前一致（${after.length} 项）` +
        (after.length ? '' : '，工作树干净'))
    }
  }

  const coupled = results.filter((r) => r.code !== 0)
  console.log(`\n汇总：format-coupled ${coupled.length} / format-clean ${results.length - coupled.length}`)
  // 优先级：还原失败 > 用法错误 > coupled —— 还原失败意味着工作树里躺着被改过的生产代码，
  // 比「某条测试红了」严重得多，必须是唯一的失败口径（否则 1 会盖住 3）。
  if (restoreFailures.length || dirty) die(3, '❌ 还原失败：生产文件可能仍是重排后的内容（见上，先 git checkout --）')
  if (coupled.length) {
    console.log('format-coupled 说明这些测试的断言绑在源码排版上（读源码文本/结构片段）——' +
      '本批目标是让它们重排后仍绿：改用 test_support/source_model.js 的 AST 断言、配置解析断言或行为断言。')
    process.exit(1)
  }
  console.log('✅ 全部 format-clean')
}

module.exports = { reformat, protectedLines, productionFiles }

if (require.main === module) main()
