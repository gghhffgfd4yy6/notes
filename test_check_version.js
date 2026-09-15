'use strict'
// check-version.js（版本三方一致性闸门）回归测试。
// 覆盖 PR 评审 #143-4「Mismatched versions pass the gate」：原实现把补丁段整段丢弃，
// package.json=3.272.5 这类漂移在闸门上判绿。
// 只喂「已读到的值」给纯函数 checkVersionValues()——不建夹具目录、不碰文件系统，因此在 Stryker/变异
// 沙箱（copyProject 只复制 test_*.js / xbk_*.js / 固定清单）里同样可运行；真实仓库的读取路径由
// CI 的 `node check-version.js` 步骤覆盖。
const assert = require('node:assert')
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

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_check_version ${fail === 0 ? `全部通过（${pass} 项）` : `通过 ${pass}/${pass + fail} 项，失败 ${fail} 项`}`)
