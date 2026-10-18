'use strict'

// Stryker 配置加载期闸门：阻止 `npx stryker run` 直接在本机启动变异评估。
// 只在「由 Stryker CLI 加载配置」时生效（require.main 指向 stryker 的 bin 或 @stryker-mutator/core）；
// 自家脚本（check-mutation-ranges.js、各测试）require 配置时 require.main 是它们自己，不会误伤。
// CI 里 GITHUB_ACTIONS=true，一律放行。

function shouldBlock (mainFile, env) {
  const loadedByStryker = /stryker/i.test(mainFile || '')
  return loadedByStryker && env.GITHUB_ACTIONS !== 'true' && env.XBK_ALLOW_LOCAL_MUTATION !== '1'
}

function assertLocalMutationAllowed () {
  // Stryker 可能以 ESM import 方式加载本配置文件（此时 require.main 为 undefined），
  // 故入口判定要同时看 process.argv[1]（npx stryker → .../node_modules/.bin/stryker）。
  const entry = (require.main && require.main.filename) || process.argv[1] || ''
  if (!shouldBlock(entry, process.env)) return
  throw new Error(
    '❌ 本机禁止跑变异评估（用户明确指示；判据只在 CI）。\n' +
    '   不要直接 npx stryker run —— 变异矩阵由 .github/workflows/mutation.yml 执行。\n' +
    '   仅单段/沙箱调试时显式放开（结果不得当作判据）：XBK_ALLOW_LOCAL_MUTATION=1 npx stryker run'
  )
}

module.exports = { shouldBlock, assertLocalMutationAllowed }
