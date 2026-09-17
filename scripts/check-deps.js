'use strict'
// 依赖预检：按 package.json 的运行时声明（dependencies + optionalDependencies）逐项探测，
// 含 re2 原生绑定探针；区分「未安装」与「已安装但不可用」两种情况并输出对应修复指引与失败根因。
// 支持注入 resolve/load/manifest 以便测试（默认使用 Node 的 require 体系与 ROOT/package.json）。
// 已知口径缺口（本轮审查 F5/F6，暂不在此修）：
//   - 默认参数即生产路径，只有 run_tests.js 的无参调用会走到；test_check_deps.js 每条用例都显式注入
//     resolve/load，故默认分支零断言，默认值改动不会被单元套件发现。
//   - resolve 以 ROOT 为基准，默认 load 却以本文件所在目录（scripts/）为基准；当前布局
//     （scripts/ 无 package.json/node_modules）下两者同命中根 node_modules，属潜在而非现存不一致。
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')

// re2 是唯一需要「重建原生绑定」这一步的依赖：它的修复指引与普通依赖不同（见输出分支）
const NATIVE_DEP = 're2'

// F1：探测清单必须来自 package.json 的运行时声明。此前清单硬编码在代码里
// （load('got') + resolve('re2')），声明清单变化或新增运行时依赖时预检零覆盖（依赖漂移不可见）。
function readPackageManifest () {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

// 运行时声明清单：dependencies + optionalDependencies（devDependencies 是测试/工具链，不参与运行时预检）
function declaredRuntimeDependencies (pkg) {
  const names = []
  for (const field of ['dependencies', 'optionalDependencies']) {
    const group = pkg && pkg[field]
    if (!group || typeof group !== 'object') continue
    for (const name of Object.keys(group)) if (!names.includes(name)) names.push(name)
  }
  return names
}

// F3：把被吞掉的根因提取成一行摘要（带 error.code），只取首行避免把 require 栈整段刷进输出。
function dependencyFailureReason (error) {
  const message = error && error.message ? String(error.message) : String(error)
  const code = error && error.code ? `${error.code}: ` : ''
  return `${code}${message.split('\n')[0]}`
}

function checkDependencies ({ resolve = require.resolve, load = require, manifest = readPackageManifest } = {}) {
  const missing = []
  const broken = []

  let declared = []
  try {
    declared = declaredRuntimeDependencies(manifest())
  } catch (error) {
    // package.json 读不到/解析失败：如实告警并退回内置清单——预检本身不得因此退化成「零检查」
    console.warn(`⚠️ 无法读取 package.json（${dependencyFailureReason(error)}），退回内置清单 got/re2`)
  }
  const targets = declared.length > 0 ? declared : ['got', NATIVE_DEP]

  for (const name of targets) {
    // F3：两段判定——resolve 失败才是「缺少」；resolve 成功而加载抛错（ERR_REQUIRE_ESM、
    // 内部依赖缺失、原生绑定损坏等）是「已安装但不可用」，此前一律按 missing 报「缺少 got」。
    try {
      resolve(name, { paths: [ROOT] })
    } catch (error) {
      missing.push(name)
      continue
    }

    try {
      const mod = load(name)
      // re2 原生绑定探针只对 re2 生效：能加载不等于绑定可用（跨 Node 版本编译的 .node 会加载失败）
      if (name === NATIVE_DEP) {
        const RE2 = mod // standard new-cap：构造器名须大写开头
        const probe = new RE2('^re2$')
        if (!probe.test('re2')) throw new Error('re2 native binding probe failed')
      }
    } catch (error) {
      broken.push({ name, reason: dependencyFailureReason(error) })
    }
  }

  if (missing.length === 0 && broken.length === 0) return true

  if (missing.length > 0) {
    console.error(`❌ 缺少依赖：${missing.join(', ')}`)
    console.error('请先在项目根目录执行：')
    console.error('  npm ci --ignore-scripts')
    // 仅 re2 缺失时才提示重建原生模块；只缺 got 时该目录可能尚未创建，避免误导
    if (missing.includes(NATIVE_DEP)) {
      console.error(`  npm run rebuild --prefix node_modules/${NATIVE_DEP}`)
    }
  }
  if (broken.length > 0) {
    console.error(`❌ 依赖已安装但不可用：${broken.map(b => b.name).join(', ')}`)
    // F3：根因入输出——此前 catch 完全丢弃 error，只留下「缺少 got」这类误判文案。
    for (const b of broken) console.error(`  - ${b.name}: ${b.reason}`)
    // 本预检不校验 Node 版本（re2 的 engines 严于本仓库 engines，口径未对齐，审查 F4），
    // 故带上当前版本，让「切换 Node 版本」这条指引可直接对照。
    if (broken.some(b => b.name === NATIVE_DEP)) {
      console.error(`请重建原生模块或切换 Node 版本（当前 ${process.version}）：`)
      console.error(`  npm run rebuild --prefix node_modules/${NATIVE_DEP}`)
    }
    // 指引按实际不可用的依赖给出：非原生依赖（got）走重装，rebuild re2 对它没有意义。
    if (broken.some(b => b.name !== NATIVE_DEP)) {
      console.error(`请重新安装依赖（当前 ${process.version}）：`)
      console.error('  npm ci --ignore-scripts')
    }
  }
  return false
}

module.exports = { checkDependencies }

// F2：此前没有 CLI 守卫——`node scripts/check-deps.js` 只加载模块、不执行任何检查，
// 于是「直接执行」这个入口永远 exit 0 且零输出（fail-open：把它挂进脚本链/CI 步骤时会静默放行）。
// 直接执行时跑一次检查并把结果落到退出码（用 process.exitCode 而非 process.exit，管道场景不丢输出）；
// 失败原因已由检查自身写到 stderr，成功路径保持静默（成功不产出噪声）。
if (require.main === module) {
  process.exitCode = checkDependencies() ? 0 : 1
}
