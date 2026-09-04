'use strict'

const assert = require('assert')
const { execFileSync } = require('child_process')
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
console.log('✅ 青龙命令行：--check 诊断与 --dry-run 参数已接入')
