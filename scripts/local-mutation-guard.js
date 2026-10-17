#!/usr/bin/env node
'use strict'

// 本机禁止跑变异评估（用户明确指示 2026-10-16，2026-10-17 再次确认）。
// 变异分数与存活清单的唯一判据是 CI（.github/workflows/mutation.yml 的矩阵）。
// 本机跑全量大段的历史后果：沙箱残留触发 host-clean 闸 fail-closed、测试假红、
// 任务被拖到数小时，而结论仍然不可用。
// 确实要做单段/沙箱级调试时才显式放开（结果不得当作判据）：
//   XBK_ALLOW_LOCAL_MUTATION=1 npm run test:mutation

if (process.env.XBK_ALLOW_LOCAL_MUTATION !== '1') {
  console.error([
    '',
    '❌ 本机禁止跑变异评估（用户明确指示；判据只在 CI）',
    '',
    '   变异矩阵由 CI 执行：.github/workflows/mutation.yml（按行段拆分 + 增量缓存）。',
    '   本机运行会与 CI 抢占资源、留下沙箱残留（触发 host-clean 闸 fail-closed），',
    '   且分数与 CI 不可比。',
    '',
    '   仅在单段/沙箱级调试时显式放开（结果不得当作判据）：',
    '     XBK_ALLOW_LOCAL_MUTATION=1 npm run test:mutation',
    ''
  ].join('\n'))
  process.exit(1)
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
  process.exit(1)
}

const result = spawnSync(process.execPath, [binPath, 'run'], { stdio: 'inherit', cwd: ROOT })
if (result.error) {
  console.error(`stryker 启动失败：${result.error.message}`)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
