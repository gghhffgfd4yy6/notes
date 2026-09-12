#!/usr/bin/env node
// Release tag 版本号格式校验（semver 子集）。
// 从 .github/workflows/release.yml 的「校验 tag 版本号格式（semver）」步骤里抽出为可复用模块：
//   - workflow 的 bash 内联正则与本文件保持逐字一致（不强制改 release.yml，此处复用同一套判断）
//   - 供 test_tag_validator.js 直接 require 断言合法/非法 tag 集合
// 仓库版本格式：CHANGELOG 为 v3.272（两段）、package.json 为 3.272.0（三段），两种形式均接受；
// 数字组件不允许前导零（03.2 非法，0.1.0 合法），后缀（prerelease/build）不允许空组件/以 . 结尾
// （alpha.、alpha..1 非法，rc.1、build.5 合法）；正则无嵌套/相邻量词，线性安全（参考 #127 超线性正则教训）。
//
// ⚠️ 正则语义交集约束（bash ERE ↔ JS RegExp）：本文件 SEMVER_RE 与 release.yml 的 bash 内联正则
// 必须逐字一致（test_tag_validator.js 断言），但「逐字一致」只防文本漂移、不防语义分叉——bash ERE 与
// JS RegExp 语法集合不同：\d \w \s \b \B \D \W \S 简写类、反向引用 \1 等、(?= (?<= (?! (?<!
// 前瞻/后顾、\p{...} Unicode 属性在两边要么一方不支持、要么语义不同。若未来把正则扩展进这类写法，
// 逐字断言照样通过，CI（bash）与本地（JS）行为却分叉。故本正则必须始终保持在 bash ERE 与 JS RegExp
// 语义交集的子集之内：
//   ✅ 允许：字符类 [0-9]、分组 ( )、可选 ?、量词 * +、\. 等两方言语义一致的转义
//   ❌ 禁止：\d \w \s \b \B \D \W \S、反向引用、(?= (?<= (?! (?<! 前瞻/后顾、\p{...} 等分歧写法
// 约束由 test_tag_validator.js 的「交集语法约束」禁用 token 黑名单强制执行，引入即红。
'use strict'

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?([-][0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?([+][0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

// 判断一个「去掉 v 前缀后的版本号」（version）是否合法。
// workflow 里 `${GITHUB_REF#refs/tags/v}` 得到的正是这个字符串；返回布尔值，供测试断言。
function isValidVersion (version) {
  return SEMVER_RE.test(version)
}

// CLI 用法：node scripts/validate-release-tag.js <tag>  校验单个 tag（含 v 前缀则去掉）。
// exit 0 = 合法；1 = 非法。供 workflow / 提交前钩子复用同一套判断。
if (require.main === module) {
  const tag = process.argv[2]
  if (tag === undefined) {
    console.error('用法：node scripts/validate-release-tag.js <tag>（如 v3.272 / v3.272.0 / v1.2.3-rc.1+build.2）')
    process.exit(2)
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (isValidVersion(version)) {
    console.log(`版本号格式校验通过：v${version}`)
    process.exit(0)
  }
  console.error(`❌ tag 名称 'v${version}' 不是合法版本号（应为 v数字.数字[.数字][-后缀] 形式，如 v3.272 / v3.272.0）`)
  process.exit(1)
}

module.exports = { SEMVER_RE, isValidVersion }
