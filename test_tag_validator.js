'use strict'

// release.yml 的 tag semver 校验回归测试（#131 qodo #8）。
// release.yml 的「校验 tag 版本号格式（semver）」步骤用 bash 内联正则（位于
// .github/workflows/release.yml 第 41 行）判定 v* tag 是否合法；sourcery 已修复该正则
// （禁止前导零、禁止空后缀组件），但当时无自动化测试固化。本套件从 scripts/validate-release-tag.js
// 复用同一套正则与校验函数，逐字断言合法/非法 tag 集合——测试与 workflow 同源，防止语义再漂移。
// 运行方式：node test_tag_validator.js（exit 0 = 通过）。
const assert = require('node:assert')
const fs = require('node:fs')
const { SEMVER_RE, isValidVersion } = require('./scripts/validate-release-tag.js')

// 双保险：脚本里的正则必须与 release.yml 步骤里 bash 内联的正则逐字一致（否则测试固化的不是
// CI 实际运行的判断）。从 release.yml 提取 `=~ <正则>` 的 bash 正则体，归一化后比对。
const releaseYml = fs.readFileSync('.github/workflows/release.yml', 'utf8')
const match = releaseYml.match(/! \[\[ "\$VERSION" =~ (\^.+?\$) \]\]/, '')
assert.ok(match, 'release.yml 应包含 semver 校验正则（=~ 判断）')
// 归一化：bash 正则的 `$` 与脚本的 `/.../` 字面等价，去掉 bash 正则里的 `^...$` 边界做正则源比对
const bashRegexSource = match[1]
assert.ok(bashRegexSource.startsWith('^') && bashRegexSource.endsWith('$'),
  'release.yml 的 semver 正则应有 ^...$ 边界')
const scriptSource = SEMVER_RE.source
// bash 正则体里的 `\` 转义序列与 JS 正则源码字符串一致（都不含 / 分隔符转义）
assert.strictEqual(scriptSource, bashRegexSource,
  'scripts/validate-release-tag.js 的 SEMVER_RE 必须与 release.yml 的 bash 内联正则逐字一致')

// 合法 tag 集合（语义：v数字.数字[.数字][-prerelease][+build]；禁止前导零；后缀组件非空）
const validTags = [
  'v3.272',         // 两段（CHANGELOG 风格）
  'v3.272.0',       // 三段（package.json 风格）
  'v0.1.0',         // 前导数字 0 合法
  'v1.2.3-rc.1',    // prerelease 多组件
  'v1.2.3+build.5', // build 多组件
  'v1.2.3-rc.1+build.2' // prerelease + build 同时存在
]
for (const tag of validTags) {
  const version = tag.slice(1) // 去 v 前缀，对应 workflow 的 ${GITHUB_REF#refs/tags/v}
  assert.strictEqual(isValidVersion(version), true, `合法 tag ${tag} 应通过校验`)
}

// 非法 tag 集合（必须 reject）
const invalidTags = [
  'vfoo',            // 非数字
  'v1',              // 只一个数字组件
  'v03.272',         // 前导零
  'v3.272-alpha.',   // prerelease 以 . 结尾（空组件）
  'v1.2.3.4',        // 四段（多一个数字组件）
  'v1.2.3-rc..1',    // 相邻空组件
  'v01.2.3',         // 前导零
  'v1.2.3-',         // 连字符后为空
  'v1.2.3+'          // + 后为空
]
for (const tag of invalidTags) {
  const version = tag.slice(1)
  assert.strictEqual(isValidVersion(version), false, `非法 tag ${tag} 不应通过校验`)
}

console.log(`✅ tag 校验通过：${validTags.length} 个合法 / ${invalidTags.length} 个非法（与 release.yml 同源）`)
