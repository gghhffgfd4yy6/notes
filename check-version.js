#!/usr/bin/env node
// 版本三方一致性闸门：文件头 ↔ CHANGELOG 最新 ↔ package.json
// CI 与提交前使用。任一不一致 → 退出码 1。
'use strict'
const fs = require('fs')
const path = require('path')

function fail (msg) {
  console.error('❌ ' + msg)
  process.exit(1)
}

// 版本归一：先去后缀（预发布/构建元数据，从首个 - 或 + 起），再仅当剩余形如 x.y.z 时去掉补丁段。
// 3.273.0-rc.1 → 3.273；3.272 → 3.272；3.272.1 → 3.272；3.272.0 → 3.272。
// 不用旧写法 String(v).replace(/\.\d+$/, '')：那把 3.273.0-rc.1 削成 3.273.0-rc（误杀合法预发布，
// 与 release.yml 的 tag 闸门口径相反），把两段式 3.272 削成 3（把「形态手误」伪装成「三方不一致」）。
function baseVersion (v) {
  const core = String(v).trim().split(/[-+]/, 1)[0]
  const m = core.match(/^(\d+)\.(\d+)(?:\.\d+)?$/)
  return m ? m[1] + '.' + m[2] : core
}

const root = __dirname
const pkg = require(path.join(root, 'package.json'))

// F1：只认主文件「第一行」文件头。旧写法对全文 match(/v(\d+\.\d+)/) 会命中正文里的历史版本注释
// （xbk_function_v3.js:103 v3.235 等），文件头整行被删时闸门仍会冒充通过——双门（本脚本 +
// test_filter.js 同源断言）同时假绿，故取不到即 fail，不回落全文搜索。
const mainFile = fs.readFileSync(path.join(root, 'xbk_function_v3.js'), 'utf8')
const headLine = mainFile.split('\n', 1)[0]
const headMatch = headLine.match(/v(\d+\.\d+)/)
if (!headMatch) { fail('主文件头未找到版本号 vX.Y') }

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const versions = [...changelog.matchAll(/^##\s*v?(\d+\.\d+)/gm)]
if (!versions.length) { fail('CHANGELOG 未找到版本条目') }
// F5：隐式约定 CHANGELOG 为正序（v3.123 起，最新在底部），故取最后一条；若有人按常见习惯把
// 新条目顶插到 `# Changelog` 之后，这里会误红（安全方向），需人工确认顺序约定，这里不改成取最大版本。
const latestCl = versions[versions.length - 1][1]

// 基准取自主文件头。F2：旧代码把 package.json 自身归一结果当基准、又把它放进 parts 自比，
// package.json ≠ package.json 恒为假 → 那一项是永远进不了 bad 的死检查；现改为两侧各自独立
// 归一（CHANGELOG 一条、package.json 一条）后与基准比对。
// F6（跨文件口径冲突，本脚本本轮不改行为，需人工决策）：这里丢弃补丁段，故 package.json=3.272.1
// 在本闸门判绿，而 test_filter.js:6729 要求补丁段必须为 .0、release.yml:65-79 又为「补丁段非 0」
// 预留了 tag 分支——三处口径互斥，补丁发布路径实际不可执行。
const base = baseVersion(headMatch[1])
const parts = { CHANGELOG: baseVersion(latestCl), 'package.json': baseVersion(String(pkg.version)) }
const bad = Object.entries(parts).filter(([, v]) => v !== base)
if (bad.length) {
  console.error('❌ 版本不一致（基准 = 主文件头 v' + base + '）：')
  for (const [k, v] of bad) console.error('   ' + k + ' = ' + v)
  process.exit(1)
}
console.log('✅ 版本三方一致：v' + base)
