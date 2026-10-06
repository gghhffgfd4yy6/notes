// v3.280 静态扫描闸门：shellcheck（.githooks/*）+ zizmor（.github/workflows/）。
//
// 为什么存在：pre-commit 原三道门禁（lint / 版本 / 变异行段）全部面向 JS 源码，shell 钩子与
// workflow YAML 从未被扫描——AGENTS.md 长期人工执行 zizmor template-injection 约定（上游 step
// output 一律经 env 注入等），却没有任何本地执行者，全靠评审兜。本闸门把两台扫描器固化为
// 硬校验：npm run check、pre-commit、CI quality job 三处同链。
//
// 工具缺失语义（CI vs 本地）：
//   - CI（env CI=true）或显式 --require-tools：缺工具 = 红（fail-closed）。
//     否则「CI 里扫描器没装 ⇒ 静默绿」等价于门禁不存在。
//   - 本地：缺工具时打印显眼提示并跳过该扫描器——与「npm 不会自动注册仓库钩子」同一先例，
//     本地缺失不阻塞开发，由 CI 兜底，绝不假装扫描过。
//
// 用法：node scripts/check-ci-static.js [--selftest]
//   --selftest：纯函数断言（解析与缺工具判定），不需要任何外部工具在场。
'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ZIZMOR_ARGS_BASE = ['--no-exit-codes', '--format', 'json', '--no-progress', '.github/workflows/']

function toolAvailable (name) {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' })
  return !r.error
}

// 缺工具时的判定纯函数：CI 环境（或 --require-tools）fail-closed，本地软跳过。
function decideToolMissing (isCi, requireTools) {
  if (isCi || requireTools) return 'fail'
  return 'skip'
}

// zizmor --format json 的解析纯函数：数组即 findings 清单；形状不符 = 不可判定 = 红（宁红勿绿，
// 与 test_ci_skip_suites.js 的「提取不出命令名 ⇒ 对账保持红」同一口径）。
function summarizeZizmor (stdout) {
  let data
  try {
    data = JSON.parse(stdout)
  } catch (e) {
    return { ok: false, reason: 'zizmor JSON 输出无法解析：' + e.message, findings: [] }
  }
  const findings = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.findings) ? data.findings : null)
  if (findings === null) {
    return { ok: false, reason: 'zizmor 输出形状不符预期（既非数组也无 findings 数组）', findings: [] }
  }
  return { ok: true, findings }
}

// .githooks/ 下逐个常规文件跑 shellcheck；符号链接不跟随（存储层符号链接防御的同族纪律）。
function runShellcheck () {
  const dir = path.join(ROOT, '.githooks')
  let files = []
  if (fs.existsSync(dir)) {
    files = fs.readdirSync(dir).filter((f) => {
      const st = fs.lstatSync(path.join(dir, f))
      return st.isFile() && !st.isSymbolicLink()
    })
  }
  const failures = []
  for (const f of files) {
    const r = spawnSync('shellcheck',
      ['--severity=style', '-x', path.join(dir, f)],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (r.error) throw new Error('shellcheck 无法执行：' + r.error.message)
    if (r.status !== 0) failures.push({ file: '.githooks/' + f, out: ((r.stdout || '') + (r.stderr || '')).trim() })
  }
  return { scanned: files.length, failures }
}

// zizmor medium 及以上计为红（本机体检口径：high 必修，medium 起拦）。
function runZizmor () {
  const r = spawnSync('zizmor',
    [...ZIZMOR_ARGS_BASE, '--min-severity', 'medium'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error) throw new Error('zizmor 无法执行：' + r.error.message)
  const parsed = summarizeZizmor(r.stdout || '[]')
  if (!parsed.ok) return { ok: false, reason: parsed.reason, findings: [] }
  return { ok: true, findings: parsed.findings }
}

function selftest () {
  const assert = require('assert')
  // —— summarizeZizmor 边界
  assert.deepStrictEqual(summarizeZizmor('[]'), { ok: true, findings: [] })
  assert.strictEqual(summarizeZizmor('[{"audit":"x","severity":"high"}]').findings.length, 1)
  assert.deepStrictEqual(summarizeZizmor('{"findings":[]}'), { ok: true, findings: [] })
  assert.strictEqual(summarizeZizmor('not json').ok, false, '非 JSON 必须不可判定')
  assert.strictEqual(summarizeZizmor('{"foo":1}').ok, false, '形状不符必须不可判定')
  // —— decideToolMissing 边界：CI/require-tools fail-closed，本地软跳过
  assert.strictEqual(decideToolMissing(true, false), 'fail')
  assert.strictEqual(decideToolMissing(false, true), 'fail')
  assert.strictEqual(decideToolMissing(false, false), 'skip')
  // —— toolAvailable 对不存在工具返回 false
  assert.strictEqual(toolAvailable('definitely-not-a-real-tool-xyz-98'), false)
  console.log('✅ check-ci-static --selftest 全部通过（' + 8 + ' 断言）')
}

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    selftest()
    return 0
  }
  const isCi = process.env.CI === 'true'
  const requireTools = argv.includes('--require-tools')
  let red = false
  console.log('🔍 静态扫描闸门：shellcheck(.githooks) + zizmor(.github/workflows)')

  for (const t of ['shellcheck', 'zizmor']) {
    if (!toolAvailable(t)) {
      const act = decideToolMissing(isCi, requireTools)
      const hint = t === 'shellcheck' ? 'apt install shellcheck' : 'pipx install zizmor（本仓基线 1.30.1）'
      if (act === 'fail') {
        console.log('❌ 缺少 ' + t + '（CI/--require-tools 下 fail-closed）：' + hint)
        red = true
      } else {
        console.log('⚠️ 本机无 ' + t + '，跳过该扫描器（CI 会硬拦）：' + hint)
      }
    }
  }

  if (toolAvailable('shellcheck')) {
    const sc = runShellcheck()
    if (sc.failures.length === 0) {
      console.log('✅ shellcheck：' + sc.scanned + ' 个钩子文件，0 发现')
    } else {
      red = true
      console.log('❌ shellcheck：' + sc.failures.length + ' 个文件有发现（severity≥style）')
      for (const f of sc.failures) {
        console.log('  —— ' + f.file + '\n' + f.out.split('\n').map((l) => '     ' + l).join('\n'))
      }
    }
  } else if (isCi || requireTools) {
    // 上面已红，这里不重复计数
  }

  if (toolAvailable('zizmor')) {
    const z = runZizmor()
    if (!z.ok) {
      red = true
      console.log('❌ zizmor：' + z.reason + '（不可判定 = 红）')
    } else if (z.findings.length === 0) {
      console.log('✅ zizmor：medium 及以上 0 发现')
    } else {
      red = true
      console.log('❌ zizmor：medium 及以上 ' + z.findings.length + ' 发现')
      for (const f of z.findings) {
        const loc = f.location && f.location.start ? (f.location.start.line + ':' + f.location.start.column) : '?'
        console.log('  - ' + (f.audit || '?') + ' [' + (f.severity || '?') + '] @ ' +
          ((f.details && f.details.issue_start) || loc) + ' — ' + (f.message || '').slice(0, 120))
      }
    }
  }

  console.log(red ? '❌ 静态扫描未通过' : '✅ 静态扫描全部通过')
  return red ? 1 : 0
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { summarizeZizmor, decideToolMissing, toolAvailable }
