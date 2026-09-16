'use strict'
// 依赖预检：检查 got 与 re2 是否可用（含 re2 原生绑定探针），
// 区分「未安装」与「已安装但不可用」两种情况并输出对应修复指引。
// 支持注入 resolve/load 以便测试（默认使用 Node 的 require 体系）。
// 已知口径缺口（本轮审查 F5/F6，暂不在此修）：
//   - 默认参数即生产路径，只有 run_tests.js 的无参调用会走到；test_check_deps.js 每条用例都显式注入
//     resolve/load，故默认分支零断言，默认值改动不会被单元套件发现。
//   - resolve 以 ROOT 为基准，默认 load 却以本文件所在目录（scripts/）为基准；当前布局
//     （scripts/ 无 package.json/node_modules）下两者同命中根 node_modules，属潜在而非现存不一致。
const path = require('path')

const ROOT = path.join(__dirname, '..')

function checkDependencies ({ resolve = require.resolve, load = require } = {}) {
  const missing = []
  const broken = []

  try {
    load('got')
  } catch (error) {
    missing.push('got')
  }

  let re2Resolvable = false
  try {
    resolve('re2', { paths: [ROOT] })
    re2Resolvable = true
  } catch (error) {
    missing.push('re2')
  }

  if (re2Resolvable) {
    try {
      const RE2 = load('re2')
      const probe = new RE2('^re2$')
      if (!probe.test('re2')) throw new Error('re2 native binding probe failed')
    } catch (error) {
      broken.push('re2')
    }
  }

  if (missing.length === 0 && broken.length === 0) return true

  if (missing.length > 0) {
    console.error(`❌ 缺少依赖：${missing.join(', ')}`)
    console.error('请先在项目根目录执行：')
    console.error('  npm ci --ignore-scripts')
    // 仅 re2 缺失时才提示重建原生模块；只缺 got 时该目录可能尚未创建，避免误导
    if (missing.includes('re2')) {
      console.error('  npm run rebuild --prefix node_modules/re2')
    }
  }
  if (broken.length > 0) {
    console.error(`❌ 依赖已安装但不可用：${broken.join(', ')}`)
    // 本预检不校验 Node 版本（re2 的 engines 严于本仓库 engines，口径未对齐，审查 F4），
    // 故带上当前版本，让「切换 Node 版本」这条指引可直接对照。
    console.error(`请重建原生模块或切换 Node 版本（当前 ${process.version}）：`)
    console.error('  npm run rebuild --prefix node_modules/re2')
  }
  return false
}

module.exports = { checkDependencies }
