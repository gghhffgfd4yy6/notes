#!/usr/bin/env node
// 版本四方一致性闸门：文件头 ↔ CHANGELOG 最新 ↔ package.json ↔ package-lock.json 根元数据（两处）
// CI 与提交前使用。任一不一致 → 退出码 1。
// 可测试性（PR 评审 #143-4）：判定逻辑收敛为纯函数 checkVersionValues({ headLine, changelog,
// pkgVersion, lockVersion, lockRootPackageVersion })——
// 只吃「已读到的值」、不碰文件系统，test_check_version.js 用夹具值直接断言；读仓库四处与退出码收在
// checkVersion()/require.main 分支里。
// 锁文件两处（PR 评审 #154-3「Release lock keeps old version」）：package-lock.json 顶层 version 与
// packages[""].version 历史上都漂过（#146 对齐过一次，版本收口时又漂），故两处都纳入硬门禁：任一缺失/
// 形态异常即 fail-closed，不允许「字段读不到就跳过」把门禁静默绕过。
// 路径与模块解析一律由模块常量（__dirname）与字符串字面量组成：不接受任何入参参与路径构造，
// package.json 用字面量 require —— 不引入「入参 → path.join / require」的静态告警面。
'use strict'
const fs = require('fs')
const path = require('path')

const MAIN_FILE = path.join(__dirname, 'xbk_function_v3.js')
const CHANGELOG_FILE = path.join(__dirname, 'CHANGELOG.md')
// 锁文件在 checkVersion() 里用 fs.readFileSync 读（不在模块顶层 require/读取）：顶层 require 会让
// test_check_version.js 一旦被变异沙箱等「不含 package-lock.json 的副本目录」加载就 MODULE_NOT_FOUND。
const LOCK_FILE = path.join(__dirname, 'package-lock.json')

// 锁文件两处根版本的「字段名 → 值」清单（Q1，PR 评审 #154-3）：名字直接进失败详情，便于按字段定位。
function lockRootVersions (values = {}) {
  const v = values === null || values === undefined ? {} : values
  return [
    ['package-lock.json 顶层 version', v.lockVersion],
    ['package-lock.json packages[""].version', v.lockRootPackageVersion]
  ]
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

// 补丁段提取（PR 评审 #143-4）：两段式（缺省补丁段）视为 '0'，形如 x.y.z 取 z，形态异常返回 null。
// 预发布/构建元数据先剥离：3.272.0-rc.1 → 0。
function patchOf (v) {
  const core = String(v).trim().split(/[-+]/, 1)[0]
  const m = core.match(/^\d+\.\d+(?:\.(\d+))?$/)
  if (!m) return null
  return m[1] === undefined ? '0' : m[1]
}

// x.y 两段式版本比较（按数值而非字典序：3.100 > 3.99）。
function compareBaseVersion (a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (Number.parseInt(pa[i], 10) || 0) - (Number.parseInt(pb[i], 10) || 0)
    if (d !== 0) return d
  }
  return 0
}

// F5：CHANGELOG 的「最新」取版本号最大值，而不是文件里最后一条——文件顺序（正序/倒序/顶插）不再
// 参与判定。旧实现按位置取末条，把新条目顶插到 `# Changelog` 之后时会误红（安全方向，但对正序
// 约定之外的合法写法是假失败）。无版本条目时返回 null。
function latestChangelogVersion (changelog) {
  const versions = [...String(changelog === undefined || changelog === null ? '' : changelog)
    .matchAll(/^##\s*v?(\d+\.\d+)/gm)].map(m => m[1])
  if (!versions.length) return null
  // 显式初始值 = 首元素（上面已保证 versions 非空）：reduce 无初始值时本就以首元素起算，
  // 故这与原写法逐元素等价，只是满足 SonarCloud S6959「reduce 必须给初始值」。
  return versions.reduce((max, v) => (compareBaseVersion(v, max) > 0 ? v : max), versions[0])
}

// 纯判定（无 I/O）：ok=false 时 messages 为要打印的错误行（含 ❌ 前缀）。
// Q1（PR 评审 #154-3）：入参新增 lockVersion / lockRootPackageVersion —— package-lock.json 的两个
// 根版本字段，两者都必须与基准一致，否则锁文件元数据读者看到的是上一个版本，且下次再生 lock 会多出
// 一处与本次变更无关的版本 diff。
function checkVersionValues ({ headLine, changelog, pkgVersion, lockVersion, lockRootPackageVersion } = {}) {
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

  const latestCl = latestChangelogVersion(changelog)
  if (!latestCl) {
    fail('CHANGELOG 未找到版本条目')
    return { ok: false, messages }
  }

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

  // Q1：锁文件两处根元数据——先各查形态（缺失/非 x.y.z 形态即 fail-closed，不给「跳过」留口），
  // 再与 package.json 的补丁段对齐（3.276.5 这类「同 base 不同 patch」的漂移必须红），最后入 parts
  // 参与基准比对。顺序上 package.json 仍排在最后一项，失败详情末行保持既有 `   package.json = …`
  // 形态（test_check_version.js 的 CLI 断言依赖该末行，不因新增 lock 项而改变）。
  const parts = { CHANGELOG: baseVersion(latestCl) }
  for (const [name, value] of lockRootVersions({ lockVersion, lockRootPackageVersion })) {
    const lockPatch = patchOf(value)
    if (lockPatch === null) {
      fail(name + ' 缺失或版本形态异常（读到 ' + JSON.stringify(value) + '）：锁文件根版本必须与 package.json 同步')
      continue
    }
    if (patch !== null && lockPatch !== patch) {
      fail(name + ' 补丁段与 package.json 不一致（' + value + ' vs ' + pkgVersion + '）')
    }
    parts[name] = baseVersion(String(value))
  }
  parts['package.json'] = baseVersion(String(pkgVersion))

  const bad = Object.entries(parts).filter(([, v]) => v !== base)
  if (bad.length) {
    messages.push('❌ 版本不一致（基准 = 主文件头 v' + base + '）：')
    for (const [k, v] of bad) messages.push('   ' + k + ' = ' + v)
  }
  if (messages.length) return { ok: false, messages, base, patch }
  return { ok: true, messages: ['✅ 版本四方一致：v' + base + '（文件头 / CHANGELOG / package.json / package-lock.json 根元数据两处）'], base, patch }
}

// 读取仓库四处版本源后判定（路径全部是模块常量 + 字面量，见文件头说明）。
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
  // Q1：锁文件读不到（缺失/JSON 坏）直接判红——这是硬门禁，不允许「读不到就少校验一处」。
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
  } catch (e) {
    return { ok: false, messages: ['❌ package-lock.json 读取失败：' + ((e && e.message) || e)] }
  }
  const lockRoot = lock && lock.packages && lock.packages[''] ? lock.packages[''].version : undefined
  return checkVersionValues({
    headLine: mainFile.split('\n', 1)[0],
    changelog,
    pkgVersion: pkg.version,
    lockVersion: lock ? lock.version : undefined,
    lockRootPackageVersion: lockRoot
  })
}

if (require.main === module) {
  const result = checkVersion()
  for (const line of result.messages) (result.ok ? console.log(line) : console.error(line))
  // F8：失败时置 process.exitCode 而非 process.exit(1)——后者会立刻终止进程，丢弃尚未 flush 的
  // stdout/stderr，管道（如 CI `node check-version.js | tee`）最后一次 stderr 写可能被截断；
  // 此处无其它活动句柄，事件循环排空后自然退出，退出码语义不变（失败仍为 1）。
  if (!result.ok) process.exitCode = 1
}

module.exports = { baseVersion, patchOf, compareBaseVersion, latestChangelogVersion, lockRootVersions, checkVersionValues, checkVersion }
