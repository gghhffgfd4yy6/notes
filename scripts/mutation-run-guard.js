'use strict'

// Stryker 配置加载期闸门：阻止本机启动变异评估。
// 判据不是「入口路径里含 stryker 子串」——仓库目录名含 stryker 会误伤 npm test，
// `node -e` / 自命名 wrapper 又会绕过。改为两条不可靠路径判据之外的进程事实：
//   1) 入口确实是 Stryker CLI 的 bin（node_modules/.bin/stryker 或
//      @stryker-mutator/core/bin/stryker.js）；
//   2) 或本进程已加载 @stryker-mutator/core（programmatic API / `node -e` 加载配置的形态）。
// CI 里 GITHUB_ACTIONS 严格等于字符串 'true' 才放行：'0'/'false' 不得当作 CI。
const STRYKER_BIN_RE = /(^|[\\/])node_modules[\\/](?:\.bin[\\/]stryker|@stryker-mutator[\\/]core[\\/]bin[\\/]stryker(?:\.js)?)$/
const STRYKER_CORE_RE = /[\\/]node_modules[\\/]@stryker-mutator[\\/]core[\\/]/

function isStrykerProcess (mainFile, loadedModules) {
  if (STRYKER_BIN_RE.test(String(mainFile || ''))) return true
  return (loadedModules || []).some((p) => STRYKER_CORE_RE.test(String(p || '')))
}

function shouldBlock (mainFile, env, loadedModules) {
  const isStryker = isStrykerProcess(mainFile, loadedModules)
  return isStryker && env.GITHUB_ACTIONS !== 'true' && env.XBK_ALLOW_LOCAL_MUTATION !== '1'
}

function assertLocalMutationAllowed () {
  // Stryker 可能以 ESM import 方式加载本配置文件（此时 require.main 为 undefined），
  // 故入口判定同时看 process.argv[1] 与 require.cache 里是否已有 stryker core。
  const entry = (require.main && require.main.filename) || process.argv[1] || ''
  if (!shouldBlock(entry, process.env, Object.keys(require.cache))) return
  throw new Error(
    '❌ 本机禁止跑变异评估（用户明确指示；判据只在 CI）。\n' +
    '   不要直接 npx stryker run —— 变异矩阵由 .github/workflows/mutation.yml 执行。\n' +
    '   仅单段/沙箱调试时显式放开（结果不得当作判据）：\n' +
    '     XBK_ALLOW_LOCAL_MUTATION=1 npm run test:mutation -- --mutate "<文件:行段>"'
  )
}

module.exports = { shouldBlock, isStrykerProcess, assertLocalMutationAllowed }
