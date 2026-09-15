'use strict'
// check-version.js（版本三方一致性闸门）回归测试。
// 覆盖 PR 评审 #143-4「Mismatched versions pass the gate」：原实现把补丁段整段丢弃，
// package.json=3.272.5 这类漂移在闸门上判绿。用夹具目录直接断言 checkVersion()：
// 非法形态必须 ok=false 且给出可读原因，合法形态必须过。
// 只用自建夹具、不读真实仓库状态：变异沙箱里 xbk_function_v3.js 首行会被插桩（// @ts-nocheck），
// 真实仓库自检会误红——真实一致性由 CI 的 `node check-version.js` 步骤与 test_filter.js 覆盖。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkVersion, baseVersion, patchOf } = require('./check-version')

let pass = 0
let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

const fixtures = []
function fixture ({ head, changelog, version } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-version-'))
  fixtures.push(dir)
  fs.writeFileSync(path.join(dir, 'xbk_function_v3.js'),
    (head === undefined ? '//* ******* 线报酷推送脚本 v3.272 — 版本更新 *********' : head) + '\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
    changelog === undefined ? '# Changelog\n\n## v3.271\n\n## v3.272\n' : changelog, 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: version === undefined ? '3.272.0' : version }), 'utf8')
  return dir
}

console.log('=== check-version.js 版本闸门测试 ===')

check('三方一致（major.minor + 补丁段 .0）→ 通过', () => {
  const r = checkVersion(fixture())
  assert.strictEqual(r.ok, true, r.messages.join(' | '))
  assert.match(r.messages.join('\n'), /版本三方一致：v3\.272/)
})

check('补丁段非 0（3.272.5）→ 判红并点名补丁段（qodo #143-4）', () => {
  const r = checkVersion(fixture({ version: '3.272.5' }))
  assert.strictEqual(r.ok, false, '补丁段漂移必须判红（原实现丢弃补丁段、判绿）')
  assert.match(r.messages.join('\n'), /补丁段必须为 \.0/, `应点名补丁段：${r.messages.join(' | ')}`)
})

check('major.minor 漂移（3.999.0）→ 判红（原 F2 恒真死检查的回归）', () => {
  const r = checkVersion(fixture({ version: '3.999.0' }))
  assert.strictEqual(r.ok, false, 'major.minor 漂移必须判红')
  assert.match(r.messages.join('\n'), /版本不一致（基准 = 主文件头 v3\.272）/)
})

check('两段式 package.json（3.272）→ 补丁段视为 0，通过', () => {
  const r = checkVersion(fixture({ version: '3.272' }))
  assert.strictEqual(r.ok, true, r.messages.join(' | '))
})

check('预发布后缀（3.272.0-rc.1）→ 补丁段视为 0，通过', () => {
  const r = checkVersion(fixture({ version: '3.272.0-rc.1' }))
  assert.strictEqual(r.ok, true, r.messages.join(' | '))
})

check('主文件头首行缺版本号（正文历史注释不算数）→ 判红', () => {
  const r = checkVersion(fixture({ head: '// 无版本头', changelog: '# Changelog\n\n## v3.235\n' }))
  assert.strictEqual(r.ok, false, '文件头取不到版本号必须判红')
  assert.match(r.messages.join('\n'), /主文件头未找到版本号/)
})

check('CHANGELOG 无版本条目 → 判红', () => {
  const r = checkVersion(fixture({ changelog: '# Changelog\n\n还没有版本\n' }))
  assert.strictEqual(r.ok, false, 'CHANGELOG 无条目必须判红')
  assert.match(r.messages.join('\n'), /CHANGELOG 未找到版本条目/)
})

check('CHANGELOG 与文件头不一致 → 判红', () => {
  const r = checkVersion(fixture({ changelog: '# Changelog\n\n## v3.271\n' }))
  assert.strictEqual(r.ok, false, 'CHANGELOG 版本落后必须判红')
  assert.match(r.messages.join('\n'), /CHANGELOG = 3\.271/)
})

check('package.json 缺失 → 判红（不抛栈）', () => {
  const dir = fixture()
  fs.rmSync(path.join(dir, 'package.json'))
  const r = checkVersion(dir)
  assert.strictEqual(r.ok, false, 'package.json 缺失必须判红')
  assert.match(r.messages.join('\n'), /package\.json 读取失败/)
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
})

for (const dir of fixtures) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } }

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_check_version ${fail === 0 ? `全部通过（${pass} 项）` : `通过 ${pass}/${pass + fail} 项，失败 ${fail} 项`}`)
