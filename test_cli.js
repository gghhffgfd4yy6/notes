'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')
const path = require('path')

const entry = path.join(__dirname, 'qinglong', 'xbk_push.js')

// 旧口径断言「--check 必然失败」，只在缺 re2/通知配置的环境成立（CI 绿、配置齐全的开发机必红）。
// 改为环境无关的契约断言：①诊断输出必须包含三类检查项；②退出码与实际失败项数一致（有 ❌ ⇒ 1，全 ✅ ⇒ 0）。
// re2 缺失拒绝启动的路径已由 test_loop.js 的 ensureDependencies 注入用例确定性地覆盖。
const checkRun = spawnSync(process.execPath, [entry, '--check'], {
  cwd: __dirname,
  encoding: 'utf8',
  env: { ...process.env, XBK_AUTO_INSTALL_DEPS: '' },
  timeout: 10000,
  stdio: ['ignore', 'pipe', 'pipe']
})
const checkOutput = `${checkRun.stdout || ''}${checkRun.stderr || ''}`
for (const label of ['Node.js 版本', 're2 原生模块', '通知通道']) {
  assert.ok(checkOutput.includes(label), `--check 诊断输出应包含「${label}」检查项（实际输出：${JSON.stringify(checkOutput)}）`)
}
const failedItems = checkOutput.split('\n').filter(line => line.includes('❌'))
assert.strictEqual(
  checkRun.status,
  failedItems.length > 0 ? 1 : 0,
  `--check 退出码必须与诊断结论一致（${failedItems.length} 项失败），实际 status=${checkRun.status}`
)

const source = require('fs').readFileSync(entry, 'utf8')
assert.match(source, /--dry-run/)
assert.match(source, /--check/)
assert.match(source, /--status/)
assert.ok(/if\s*\(\s*hasArg\(\s*['"]--dry-run['"]\s*\)\s*\)[\s\S]*ensureDependencies\s*\(\s*\)[\s\S]*const\s+app\s*=\s*loadApp\s*\(\s*\)/.test(source), '常驻入口必须先检查依赖，再加载会引入 got 的应用')

const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-cli-'))
const previousCwd = process.cwd()
try {
  process.chdir(statusDir)
  fs.writeFileSync('report.state', JSON.stringify({ date: '2026-09-05', runs: 1, total: 2, dedup: 0, filtered: 0, pushed: 2, failed: 0, truncated: 0 }))
  const before = fs.statSync('report.state').mtimeMs
  const statusRun = spawnSync(process.execPath, [entry, '--status'], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: statusDir } })
  assert.strictEqual(statusRun.status, 0, '--status 应独立于 got/re2 成功退出')
  assert.match(statusRun.stdout, /xbk-push 运行状态/)
  assert.match(statusRun.stdout, /推送成功：2 条/)
  assert.strictEqual(fs.statSync('report.state').mtimeMs, before, '--status 不得写状态文件')
} finally {
  process.chdir(previousCwd)
  fs.rmSync(statusDir, { recursive: true, force: true })
}

const dryRun = spawnSync(process.execPath, ['-e', `process.env.XBK_DRY_RUN = '1'; const app = require(${JSON.stringify(path.join(__dirname, 'xbk_function_v3.js'))}); const result = app.App; if (!result || typeof result.run !== 'function') process.exit(2)`], { cwd: __dirname, encoding: 'utf8' })
assert.strictEqual(dryRun.status, 0, 'dry-run 环境变量应能加载主模块')
console.log('✅ 青龙命令行：--check 诊断与 --dry-run 参数已接入')
