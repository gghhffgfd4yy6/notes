'use strict'
// check-version.js（版本三方一致性闸门）回归测试。
// 覆盖 PR 评审 #143-4「Mismatched versions pass the gate」：原实现把补丁段整段丢弃，
// package.json=3.272.5 这类漂移在闸门上判绿。
// 只喂「已读到的值」给纯函数 checkVersionValues()——不建夹具目录、不碰文件系统，因此在 Stryker/变异
// 沙箱（copyProject 只复制 test_*.js / xbk_*.js / 固定清单）里同样可运行；真实仓库的读取路径由
// CI 的 `node check-version.js` 步骤覆盖。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { checkVersionValues, baseVersion, patchOf } = require('./check-version')

let pass = 0
let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

const HEAD = '//* ******* 线报酷推送脚本 v3.272 — 版本更新 *********'
const CHANGELOG = '# Changelog\n\n## v3.271\n\n## v3.272\n'
const values = (over = {}) => Object.assign({ headLine: HEAD, changelog: CHANGELOG, pkgVersion: '3.272.0' }, over)
const text = (r) => r.messages.join('\n')

console.log('=== check-version.js 版本闸门测试 ===')

check('三方一致（major.minor + 补丁段 .0）→ 通过', () => {
  const r = checkVersionValues(values())
  assert.strictEqual(r.ok, true, text(r))
  assert.match(text(r), /版本三方一致：v3\.272/)
})

check('补丁段非 0（3.272.5）→ 判红并点名补丁段（qodo #143-4 回归）', () => {
  const r = checkVersionValues(values({ pkgVersion: '3.272.5' }))
  assert.strictEqual(r.ok, false, '补丁段漂移必须判红（原实现丢弃补丁段、判绿）')
  assert.match(text(r), /补丁段必须为 \.0/, `应点名补丁段：${text(r)}`)
})

check('major.minor 漂移（3.999.0）→ 判红（F2 恒真死检查的回归）', () => {
  const r = checkVersionValues(values({ pkgVersion: '3.999.0' }))
  assert.strictEqual(r.ok, false, 'major.minor 漂移必须判红')
  assert.match(text(r), /版本不一致（基准 = 主文件头 v3\.272）/)
})

check('两段式 package.json（3.272）→ 补丁段视为 0，通过', () => {
  const r = checkVersionValues(values({ pkgVersion: '3.272' }))
  assert.strictEqual(r.ok, true, text(r))
})

check('预发布后缀（3.272.0-rc.1）→ 补丁段视为 0，通过', () => {
  const r = checkVersionValues(values({ pkgVersion: '3.272.0-rc.1' }))
  assert.strictEqual(r.ok, true, text(r))
})

check('文件头首行缺版本号（正文历史注释不算数）→ 判红', () => {
  const r = checkVersionValues(values({ headLine: '// 无版本头' }))
  assert.strictEqual(r.ok, false, '文件头取不到版本号必须判红')
  assert.match(text(r), /主文件头未找到版本号/)
})

check('CHANGELOG 无版本条目 → 判红', () => {
  const r = checkVersionValues(values({ changelog: '# Changelog\n\n还没有版本\n' }))
  assert.strictEqual(r.ok, false, 'CHANGELOG 无条目必须判红')
  assert.match(text(r), /CHANGELOG 未找到版本条目/)
})

check('CHANGELOG 落后于文件头 → 判红', () => {
  const r = checkVersionValues(values({ changelog: '# Changelog\n\n## v3.271\n' }))
  assert.strictEqual(r.ok, false, 'CHANGELOG 版本落后必须判红')
  assert.match(text(r), /CHANGELOG = 3\.271/)
})

check('package.json 版本非法/缺失 → 判红（不抛栈）', () => {
  for (const v of [undefined, null, '', 'v3.272.0', 'abc']) {
    const r = checkVersionValues(values({ pkgVersion: v }))
    assert.strictEqual(r.ok, false, `版本 ${JSON.stringify(v)} 必须判红`)
    assert.match(text(r), /版本形态异常/)
  }
})

check('入参整体缺失 → 判红（不抛栈）', () => {
  const r = checkVersionValues({})
  assert.strictEqual(r.ok, false, '空入参必须判红')
  assert.match(text(r), /主文件头未找到版本号/)
})

check('baseVersion/patchOf 边界', () => {
  assert.strictEqual(baseVersion('3.273.0-rc.1'), '3.273')
  assert.strictEqual(baseVersion('3.272'), '3.272')
  assert.strictEqual(baseVersion('3.272.1'), '3.272')
  assert.strictEqual(baseVersion(' 3.272.0 '), '3.272')
  assert.strictEqual(baseVersion('abc'), 'abc')
  assert.strictEqual(patchOf('3.272.0'), '0')
  assert.strictEqual(patchOf('3.272'), '0')
  assert.strictEqual(patchOf('3.272.5'), '5')
  assert.strictEqual(patchOf('3.272.0+build.7'), '0')
  assert.strictEqual(patchOf('v3.272.0'), null)
  assert.strictEqual(patchOf(''), null)
  assert.strictEqual(patchOf(undefined), null)
})

// ── CLI 退出路径回归（audit low/info：失败路径 process.exit(1) → process.exitCode = 1）──────────────
// 判定逻辑 checkVersionValues() 是纯函数，但「失败时怎么退出」只在 require.main 分支里（第 110-117 行），
// 纯函数测不到。这里在临时目录里搭一套最小「版本三方源」夹具，并把 check-version.js **复制**过去执行——
// 复制而非改写，仓库文件一个字节都不动；模块内三处路径全是 __dirname 常量（MAIN_FILE / CHANGELOG_FILE /
// require('./package.json')），故复制到别处即读到夹具，无需任何生产改动或环境变量注入。
// 三种断言缺一不可：
//   ① 退出码语义不变：版本不一致仍 exit 1（process.exitCode 与 process.exit 的外部退出码一致）；
//   ② 失败详情完整出现在 stderr（含最后一行 `   package.json = …`）；
//   ③ **不得调用 process.exit()** ——这是本条生产改动唯一可鉴别的断言。②单独看无鉴别力：Linux 上 pipe
//      写入是同步的，旧实现（process.exit(1)）在管道下也不会截断（本机实测两种实现 stderr 逐字相同），
//      故只有预加载 process.exit 探针、看它有没有被调用才能区分；回退成 process.exit(1) 时探针文件
//      出现 → ③ 必红。
const EXIT_SPY = [
  "'use strict'",
  '// process.exit 探针：被调用即落标记文件（内容 = 退出码），随后原样执行真实退出。',
  "const fs = require('node:fs')",
  'const realExit = process.exit.bind(process)',
  'process.exit = function (code) {',
  '  try { fs.writeFileSync(process.env.DSH_EXIT_SPY_MARK, String(code)) } catch (e) {}',
  '  return realExit(code)',
  '}',
  ''
].join('\n')

// 搭夹具：主文件头 v3.272 / CHANGELOG 最新 v3.272 / package.json = 入参（与 HEAD、CHANGELOG 常量同源）
function makeVersionCliFixture (pkgVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvcli-'))
  fs.writeFileSync(path.join(dir, 'check-version.js'), fs.readFileSync(path.join(__dirname, 'check-version.js'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'xbk_function_v3.js'), HEAD + '\n')
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'check-version-fixture', version: pkgVersion }))
  fs.writeFileSync(path.join(dir, 'exit-spy.js'), EXIT_SPY)
  return dir
}

function runVersionCli (pkgVersion) {
  const dir = makeVersionCliFixture(pkgVersion)
  try {
    const mark = path.join(dir, 'exit-spy-mark.txt')
    const res = spawnSync(process.execPath, ['--require', path.join(dir, 'exit-spy.js'), path.join(dir, 'check-version.js')], {
      cwd: dir, encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { DSH_EXIT_SPY_MARK: mark })
    })
    assert.strictEqual(res.error, undefined,
      'check-version CLI 子进程应能启动（本机需 NODE_OPTIONS=--require .local/execpath-shim.js）：' + (res.error && res.error.message))
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, exitCalledWith: fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : null }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

check('CLI 失败路径：版本不一致仍 exit 1 + 失败详情完整 + 不调用 process.exit（F8 回归）', () => {
  const r = runVersionCli('3.999.0')
  assert.strictEqual(r.status, 1, `版本不一致时退出码必须仍为 1，实际 ${r.status}（stderr: ${JSON.stringify(r.stderr)}）`)
  assert.strictEqual(r.exitCalledWith, null,
    `失败路径不得调用 process.exit()（实测被以退出码 ${r.exitCalledWith} 调用）——同步退出会丢弃管道下尚未 flush 的 stderr 尾部，生产实现应为 process.exitCode = 1`)
  assert.ok(r.stderr.includes('❌ 版本不一致（基准 = 主文件头 v3.272）'),
    `stderr 应含失败结论行，实际: ${JSON.stringify(r.stderr)}`)
  assert.ok(r.stderr.trim().endsWith('package.json = 3.999'),
    `stderr 须完整到失败详情最后一行（package.json = 3.999），实际: ${JSON.stringify(r.stderr)}`)
})

check('CLI 成功路径：三方一致 exit 0 + 成功文案（对照，防「恒退 1」掩盖失败路径断言）', () => {
  const r = runVersionCli('3.272.0')
  assert.strictEqual(r.status, 0, `三方一致时退出码必须为 0，实际 ${r.status}（stderr: ${JSON.stringify(r.stderr)}）`)
  assert.strictEqual(r.exitCalledWith, null, '成功路径同样不得调用 process.exit()')
  assert.match(r.stdout, /版本三方一致：v3\.272/, `成功文案应报到 stdout，实际: ${JSON.stringify(r.stdout)}`)
  assert.strictEqual(r.stderr, '', `成功路径不得往 stderr 写内容，实际: ${JSON.stringify(r.stderr)}`)
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_check_version ${fail === 0 ? `全部通过（${pass} 项）` : `通过 ${pass}/${pass + fail} 项，失败 ${fail} 项`}`)
