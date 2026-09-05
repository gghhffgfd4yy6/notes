'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const { execFileSync, spawnSync } = require('child_process')
const path = require('path')

const entry = path.join(__dirname, 'qinglong', 'xbk_push.js')

try {
  execFileSync(process.execPath, [entry, '--check'], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, XBK_AUTO_INSTALL_DEPS: '' },
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  assert.fail('--check 在当前缺少 re2/通知配置环境中应返回非零')
} catch (error) {
  const output = `${error.stdout || ''}${error.stderr || ''}`
  assert.match(output, /Node\.js 版本/)
  assert.match(output, /re2 原生模块/)
  assert.match(output, /通知通道/)
}

const source = require('fs').readFileSync(entry, 'utf8')
assert.match(source, /--dry-run/)
assert.match(source, /--check/)
assert.match(source, /--status/)

const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-cli-'))
try {
  // codacy-disable-next-line: test sandbox path from fs.mkdtempSync, not external input
  fs.writeFileSync(path.join(statusDir, 'report.state'), JSON.stringify({ date: '2026-09-05', runs: 1, total: 2, dedup: 0, filtered: 0, pushed: 2, failed: 0, truncated: 0 }))
  // codacy-disable-next-line: test sandbox path from fs.mkdtempSync, not external input
  const before = fs.statSync(path.join(statusDir, 'report.state')).mtimeMs
  const statusRun = spawnSync(process.execPath, [entry, '--status'], { cwd: __dirname, encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: statusDir } })
  assert.strictEqual(statusRun.status, 0, '--status 应独立于 got/re2 成功退出')
  assert.match(statusRun.stdout, /xbk-push 运行状态/)
  assert.match(statusRun.stdout, /推送成功：2 条/)
  // codacy-disable-next-line: test sandbox path from fs.mkdtempSync, not external input
  assert.strictEqual(fs.statSync(path.join(statusDir, 'report.state')).mtimeMs, before, '--status 不得写状态文件')
} finally {
  fs.rmSync(statusDir, { recursive: true, force: true })
}

const dryRun = spawnSync(process.execPath, ['-e', `process.env.XBK_DRY_RUN = '1'; const app = require(${JSON.stringify(path.join(__dirname, 'xbk_function_v3.js'))}); const result = app.App; if (!result || typeof result.run !== 'function') process.exit(2)`], { cwd: __dirname, encoding: 'utf8' })
assert.strictEqual(dryRun.status, 0, 'dry-run 环境变量应能加载主模块')
console.log('✅ 青龙命令行：--check 诊断与 --dry-run 参数已接入')
