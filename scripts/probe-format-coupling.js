#!/usr/bin/env node
'use strict'
/*
 * 格式耦合探针（S0）：判断一个测试是否**绑死**了生产源码的排版。
 *
 * 做法：把生产 JS（仓库根 `*.js` 去掉 `test_*`，加上 `scripts/`、`qinglong/` 全量）用 acorn 词法重排——
 * 每个 `,` 与 `(` 之后插入一个空格（字符串 / 模板 / 正则 / 注释里的 `,`、`(` 不是词法记号，天然不动），
 * 语义完全不变；然后逐个跑传入的测试（TZ=UTC）。
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
const LEX_OPTS = { ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script' }
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 15 * 60 * 1000
const WALK_DIRS = ['scripts', 'qinglong']
const SKIP_DIRS = new Set(['node_modules', '.git', '.stryker-tmp', '.nyc_output', 'coverage', 'reports', 'scratch'])

function die (code, message) {
  console.error(message)
  process.exit(code)
}

function walkJs (dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
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
  const root = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('test_'))
    .map((e) => e.name)
  return [...root, ...WALK_DIRS.flatMap((d) => walkJs(d))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// 在每个 `,` 与 `(` 记号之后插入一个空格。按 token 边界插而不是对原文做正则替换：
// 字符串/模板/正则/注释里的同样字符根本不是 `,`/`(` 记号，因此不会被误改（那是语义改动，会造出假红）。
function reformat (code, file) {
  const positions = []
  try {
    const lexer = acorn.tokenizer(code, LEX_OPTS)
    for (;;) {
      const token = lexer.getToken()
      if (token.type === acorn.tokTypes.eof) break
      const label = token.type.label
      if (label === ',' || label === '(') positions.push(token.end)
    }
  } catch (e) {
    // 词法失败 = 这个文件没法安全重排。响亮失败而不是跳过：跳过会把它排除在探针面之外，
    // 于是「该文件里的排版耦合」永远探不到，而输出仍然好看（静默失效）。
    throw new Error(`词法解析失败，无法安全重排 ${file}: ${e.message}`)
  }
  if (!positions.length) return code
  const parts = []
  let prev = 0
  for (const pos of positions) {
    parts.push(code.slice(prev, pos), ' ')
    prev = pos
  }
  parts.push(code.slice(prev))
  return parts.join('')
}

function gitStatus () {
  const r = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
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
      fs.writeFileSync(path.join(ROOT, rel), backups.get(rel))
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

function firstFailureLine (output) {
  // 只保留「不是成功行」的行：套件里的 ✅ / 🎉 行常常也含「失败」字样（例如用例名），
  // 直接按关键词全局搜会抓到一条绿行当失败原因（本工具的第一版就这么错过）。
  const lines = String(output).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !SUCCESS_PREFIXES.some((p) => l.startsWith(p)))
  const hit = lines.find((l) => /AssertionError/.test(l)) ||
    lines.find((l) => /^❌|\bError\b|not ok/.test(l)) ||
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
  const missing = tests.filter((t) => !fs.existsSync(path.join(ROOT, t)))
  if (missing.length) die(2, '测试文件不存在：' + missing.join(', '))

  const baseline = gitStatus()
  if (!baseline) console.error('⚠️ 读不到 git status（不是 git 仓库或 git 不可用），还原只能靠退出码判断。')

  const files = productionFiles()
  for (const rel of files) backups.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))

  console.log(`生产文件重排：${files.length} 个（根目录 *.js 排除 test_* + scripts/ + qinglong/）`)
  const results = []
  let restoreFailures = []
  try {
    for (const rel of files) {
      const original = backups.get(rel)
      const mutated = reformat(original, rel)
      if (mutated === original) continue
      fs.writeFileSync(path.join(ROOT, rel), mutated)
      written.add(rel)
    }
    console.log(`已重排 ${written.size} 个文件（每个 \`,\` 与 \`(\` 后插入一个空格）\n`)
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

main()
