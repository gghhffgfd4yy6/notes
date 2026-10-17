#!/usr/bin/env node
'use strict'

// 本机禁止跑变异评估（用户明确指示 2026-10-16，2026-10-17 再次确认）。
// 变异分数与存活清单的唯一判据是 CI（.github/workflows/mutation.yml 的矩阵）。
// 本机跑全量大段的历史后果：沙箱残留触发 host-clean 闸 fail-closed、测试假红、
// 任务被拖到数小时，而结论仍然不可用。
// 确实要做单段/沙箱级调试时才显式放开（结果不得当作判据）：
//   XBK_ALLOW_LOCAL_MUTATION=1 npm run test:mutation -- --mutate "src/a.js:1-50"

const POLICY = [
  '',
  '❌ 本机禁止跑变异评估（用户明确指示；判据只在 CI）',
  '',
  '   变异矩阵由 CI 执行：.github/workflows/mutation.yml（按行段拆分 + 增量缓存）。',
  '   本机运行会与 CI 抢占资源、留下沙箱残留（触发 host-clean 闸 fail-closed），',
  '   且分数与 CI 不可比。',
  '',
  '   仅在单段/沙箱级调试时显式放开（结果不得当作判据）：',
  '     XBK_ALLOW_LOCAL_MUTATION=1 npm run test:mutation -- --mutate "<文件:行段>"',
  ''
].join('\n')

// 放行判定独立成纯函数：测试可直接覆盖「显式放开」分支，无需真的启动 stryker。
function isAllowed (env) {
  return env.XBK_ALLOW_LOCAL_MUTATION === '1'
}

function main () {
  if (!isAllowed(process.env)) {
    console.error(POLICY)
    process.exitCode = 1
    return
  }

  const fs = require('fs')
  const path = require('path')
  const { spawnSync } = require('child_process')

  const ROOT = path.resolve(__dirname, '..')
  // 直接执行仓库内 node_modules 的 stryker 入口，不依赖 PATH（Sonar S4036）。
  const binLink = path.join(ROOT, 'node_modules', '.bin', 'stryker')
  let binPath
  try {
    binPath = fs.realpathSync(binLink)
  } catch (e) {
    console.error('未找到本地 stryker（node_modules/.bin/stryker）：先 npm install，再重试。')
    process.exitCode = 1
    return
  }

  // 转发额外参数（--mutate 等）：单段调试依赖它们，丢掉就会退化成全量。
  const result = spawnSync(process.execPath, [binPath, 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: ROOT
  })
  if (result.error) {
    console.error(`stryker 启动失败：${result.error.message}`)
    process.exitCode = 1
    return
  }
  process.exitCode = result.status === null ? 1 : result.status
}

if (require.main === module) main()

module.exports = { isAllowed, POLICY }
