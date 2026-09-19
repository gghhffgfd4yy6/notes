#!/usr/bin/env node
// Release tag 版本号格式校验（严格 semver 的**超集**，非子集；放宽项见下方「偏差登记」）。
// 从 .github/workflows/release.yml 的「校验 tag 版本号格式（semver）」步骤里抽出为可复用模块：
//   - workflow 的 bash 内联正则与本文件保持逐字一致（不强制改 release.yml，release.yml 保留自持的内联副本；
//     一致性由 test_tag_validator.js 逐字断言，本模块当前**唯一调用点**就是该测试，pre-commit/pre-push 均不执行本文件（pre-commit 只跑 lint/版本闸门/变异行段校验，pre-push 只跑 test:filter）：
//     这里的「同一套判断」是防语义漂移的约束，尚不构成生产调用链）
//   - 供 test_tag_validator.js 直接 require 断言合法/非法 tag 集合
// 仓库版本格式：CHANGELOG 为 v3.272（两段）、package.json 为 3.272.0（三段），两种形式均接受；
// 数字组件不允许前导零（03.2 非法，0.1.0 合法），后缀（prerelease/build）不允许空组件/以 . 结尾
// （alpha.、alpha..1 非法，rc.1、build.5 合法）；正则无嵌套/相邻量词，线性安全（参考 #127 超线性正则教训）。
// 与严格 semver 的偏差登记（本正则相对严格 semver 只放宽、不收紧，故是超集）：
//   ① 接受两段式核心（3.272）——严格 semver 要求 major.minor.patch 三段。
//   ② 后缀里**数字型标识符允许前导零**（实测 1.2.3-01、1.2.3-00 均判合法）——严格 semver 规定数字型
//      标识符不得有前导零；本文件后缀统一按 [0-9A-Za-z-]+ 匹配、不区分数字型/字母型，故未拦下。
//   注：核心段禁前导零、后缀组件非空两条**不是**对严格 semver 的放宽——严格 semver 同样拒绝，属共同约束。
//
// ⚠️ 正则语义交集约束（bash ERE ↔ JS RegExp）：本文件 SEMVER_RE 与 release.yml 的 bash 内联正则
// 必须逐字一致（test_tag_validator.js 断言），但「逐字一致」只防文本漂移、不防语义分叉——bash ERE 与
// JS RegExp 语法集合不同：\d \w \s \b \B \D \W \S 简写类、反向引用 \1 等、(?= (?<= (?! (?<!
// 前瞻/后顾、\p{...} Unicode 属性在两边要么一方不支持、要么语义不同。若未来把正则扩展进这类写法，
// 逐字断言照样通过，CI（bash）与本地（JS）行为却分叉。故本正则必须始终保持在 bash ERE 与 JS RegExp
// 语义交集的子集之内：
//   ✅ 允许：字符类 [0-9]、分组 ( )、可选 ?、量词 * +、\. 等两方言语义一致的转义
//   ❌ 禁止（黑名单逐条强制，命中即红）：
//      \d \w \s \b \B \D \W \S、反向引用 \1、任何 `(?` 组构造（含 (?= (?<= (?! (?<! 前瞻/后顾
//      与 (?: (?i 等）、\p{...}、JS 专有转义 \n \t \r \f \v \0 \xHH \uHHHH \cX、
//      POSIX 字符类 [[:digit:]] 等、GNU 词边界 \< \>、无上界/无下界量词 {n,} {,n}
// 约束由 test_tag_validator.js 的「交集语法约束」禁用 token / 禁用形态黑名单强制执行。
// 边界如实说明：黑名单强制的只是上面**已列出**的形态，它并不穷举 bash 与 JS 的全部方言差异
// （例如 GNU 大小写算子 \l \U \L \E、排序/等价元素 [.ch.] [=a=] 等未列入），故新增写法前仍须按
// 「两方言交集」人工判断——「CI 没红」不等价于「语义一定一致」。
// 同类未列入转义黑名单的还有：字符类**范围**的 locale/校对序敏感性（[a-z] 一类在不同 LC_ALL/LC_COLLATE
// 下展开的字符集合可能不同，某些 locale 下 [A-Z] 会匹配小写字母，而 JS RegExp 恒按码点展开）。
// 该形态现由 test_tag_validator.js 的「字符类范围强制登记」覆盖：正则里出现任何未登记的范围即红，
// 新增范围必须先人工复核 locale 敏感性并在登记表里写明理由；当前登记的 [0-9]/[1-9]/[A-Z]/[a-z] 均为
// ASCII 范围（GitHub Actions 的默认 locale 下与 JS 一致，残留的理论风险见该测试的登记表说明）。
'use strict'

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?([-][0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?([+][0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

// 判断一个「去掉 v 前缀后的版本号」（version）是否合法。
// workflow 里 `${GITHUB_REF#refs/tags/v}` 得到的正是这个字符串；返回布尔值，供测试断言。
// 入参必须是字符串：RegExp.test 会先把非字符串入参 String() 化（1.2 → '1.2'、['1.2.3'] → '1.2.3'），
// 从而把非法类型静默判成「合法」；这里显式拒绝，合法字符串入参的行为不变。
function isValidVersion (version) {
  if (typeof version !== 'string') return false
  return SEMVER_RE.test(version)
}

// CLI 用法：node scripts/validate-release-tag.js <tag>  校验单个 tag（含 v 前缀则去掉）。
// exit 0 = 合法；1 = 非法；2 = 未提供 tag（用法错误，见下）。
// 当前**无生产调用点**：release.yml 保留自持的内联副本（与本文件逐字一致由 test_tag_validator.js 断言），
// pre-commit 只跑 lint/版本闸门/变异行段校验、pre-push 只跑 test:filter，两者都不执行本文件。
// CLI 分支本身**有**自动化覆盖：test_tag_validator.js 的「CLI 文案/退出码回归」段以子进程直接跑本文件，
// 断言 exit 0/1/2 与两处文案逐字回显入参原文（不带 v 的裸版本号不得被补成 v），改这里前先看该段。
if (require.main === module) {
  const tag = process.argv[2]
  if (tag === undefined) {
    console.error('用法：node scripts/validate-release-tag.js <tag>（如 v3.272 / v3.272.0 / v1.2.3-rc.1+build.2）')
    process.exit(2)
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (isValidVersion(version)) {
    console.log(`版本号格式校验通过：${tag}`)
    process.exit(0)
  }
  console.error(`❌ tag 名称 '${tag}' 不是合法版本号（应为 v数字.数字[.数字][-后缀] 形式，如 v3.272 / v3.272.0）`)
  process.exit(1)
}

module.exports = { SEMVER_RE, isValidVersion }
