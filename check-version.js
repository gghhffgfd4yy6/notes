#!/usr/bin/env node
// 版本三方一致性闸门：文件头 ↔ CHANGELOG 最新 ↔ package.json
// CI 与提交前使用。任一不一致 → 退出码 1。
// 可测试性（PR 评审 #143-4）：判定逻辑收敛为纯函数 checkVersionValues({ headLine, changelog, pkgVersion })——
// 只吃「已读到的值」、不碰文件系统，test_check_version.js 用夹具值直接断言；读仓库三处与退出码收在
// checkVersion()/require.main 分支里。
// 路径与模块解析一律由模块常量（__dirname）与字符串字面量组成：不接受任何入参参与路径构造，
// package.json 用字面量 require —— 不引入「入参 → path.join / require」的静态告警面。
'use strict'
const fs = require('fs')
const path = require('path')

const MAIN_FILE = path.join(__dirname, 'xbk_function_v3.js')
const CHANGELOG_FILE = path.join(__dirname, 'CHANGELOG.md')

// 版本归一：先去后缀（预发布/构建元数据，从首个 - 或 + 起），再仅当剩余形如 x.y.z 时去掉补丁段。
// 3.273.0-rc.1 → 3.273；3.272 → 3.272；3.272.1 → 3.272；3.272.0 → 3.272。
// 不用旧写法 String(v).replace(/\.\d+$/, '')：那把 3.273.0-rc.1 削成 3.273.0-rc（误杀合法预发布，
// 与 release.yml 的 tag 闸门口径相反），把两段式 3.272 削成 3（把「形态手误」伪装成「三方不一致」）。
function baseVersion (v) {
  const core = String(v).trim().split(/[-+]/, 1)[0]
  const m = core.match(/^(\d+)\.(\d+)(?:\.\d+)?$/)
  return m ? m[1] + '.' + m[2] : core
}

// 补丁段提取（PR 评审 #143-4）：两段式（缺省补丁段）视为 '0'，形如 x.y.z 取 z，形态异常返回 null。
// 预发布/构建元数据先剥离：3.272.0-rc.1 → 0。
function patchOf (v) {
  const core = String(v).trim().split(/[-+]/, 1)[0]
  const m = core.match(/^\d+\.\d+(?:\.(\d+))?$/)
  if (!m) return null
  return m[1] === undefined ? '0' : m[1]
}

// 纯判定（无 I/O）：ok=false 时 messages 为要打印的错误行（含 ❌ 前缀）。
function checkVersionValues ({ headLine, changelog, pkgVersion } = {}) {
  const messages = []
  const fail = (msg) => { messages.push('❌ ' + msg) }

  // F1：只认主文件「第一行」文件头。旧写法对全文 match(/v(\d+\.\d+)/) 会命中正文里的历史版本注释
  // （xbk_function_v3.js:103 v3.235 等），文件头整行被删时闸门仍会冒充通过——双门（本脚本 +
  // test_filter.js 同源断言）同时假绿，故取不到即 fail，不回落全文搜索。
  const headMatch = String(headLine === undefined || headLine === null ? '' : headLine).match(/v(\d+\.\d+)/)
  if (!headMatch) {
    fail('主文件头未找到版本号 vX.Y')
    return { ok: false, messages }
  }

  const versions = [...String(changelog === undefined || changelog === null ? '' : changelog)
    .matchAll(/^##\s*v?(\d+\.\d+)/gm)]
  if (!versions.length) {
    fail('CHANGELOG 未找到版本条目')
    return { ok: false, messages }
  }
  // F5：隐式约定 CHANGELOG 为正序（v3.123 起，最新在底部），故取最后一条；若有人按常见习惯把
  // 新条目顶插到 `# Changelog` 之后，这里会误红（安全方向），需人工确认顺序约定，这里不改成取最大版本。
  const latestCl = versions[versions.length - 1][1]

  // 基准取自主文件头。F2：旧代码把 package.json 自身归一结果当基准、又把它放进 parts 自比，
  // package.json ≠ package.json 恒为假 → 那一项是永远进不了 bad 的死检查；现改为两侧各自独立
  // 归一（CHANGELOG 一条、package.json 一条）后与基准比对。
  const base = baseVersion(headMatch[1])

  // F6 收口（PR 评审 #143-4「Mismatched versions pass the gate」）：原实现把包补丁段整段丢弃，
  // 于是 package.json=3.272.5 这类漂移在本闸门判绿（test_filter.js:6731 的「补丁段必须 .0」断言
  // 虽会拦，但门禁自身不该放行）。这里显式要求补丁段为 .0——与 test_filter.js 及 release.yml 的
  // 「补丁段为 0 才接受两段式 tag」口径一致；版本方案本身（文件头/CHANGELOG 用 major.minor、
  // package.json 用 major.minor.patch）不变。将来若要做真补丁发布，需连同 test_filter.js 与
  // release.yml 一起改，属跨文件版本方案变更。
  const patch = patchOf(pkgVersion)
  if (patch === null) {
    fail('package.json 版本形态异常（应形如 x.y.z 或 x.y）：' + pkgVersion)
  } else if (patch !== '0') {
    fail('package.json 补丁段必须为 .0（现为 ' + pkgVersion + '）：补丁发布需同时调整 test_filter.js 与 release.yml 口径')
  }

  const parts = { CHANGELOG: baseVersion(latestCl), 'package.json': baseVersion(String(pkgVersion)) }
  const bad = Object.entries(parts).filter(([, v]) => v !== base)
  if (bad.length) {
    messages.push('❌ 版本不一致（基准 = 主文件头 v' + base + '）：')
    for (const [k, v] of bad) messages.push('   ' + k + ' = ' + v)
  }
  if (messages.length) return { ok: false, messages, base, patch }
  return { ok: true, messages: ['✅ 版本三方一致：v' + base], base, patch }
}

// 读取仓库三处版本源后判定（路径全部是模块常量 + 字面量，见文件头说明）。
function checkVersion () {
  let pkg
  try {
    pkg = require('./package.json')
  } catch (e) {
    return { ok: false, messages: ['❌ package.json 读取失败：' + ((e && e.message) || e)] }
  }
  let mainFile
  try {
    mainFile = fs.readFileSync(MAIN_FILE, 'utf8')
  } catch (e) {
    return { ok: false, messages: ['❌ 主文件读取失败：' + ((e && e.message) || e)] }
  }
  let changelog
  try {
    changelog = fs.readFileSync(CHANGELOG_FILE, 'utf8')
  } catch (e) {
    return { ok: false, messages: ['❌ CHANGELOG 读取失败：' + ((e && e.message) || e)] }
  }
  return checkVersionValues({ headLine: mainFile.split('\n', 1)[0], changelog, pkgVersion: pkg.version })
}

if (require.main === module) {
  const result = checkVersion()
  for (const line of result.messages) (result.ok ? console.log(line) : console.error(line))
  if (!result.ok) process.exit(1)
}

module.exports = { baseVersion, patchOf, checkVersionValues, checkVersion }
