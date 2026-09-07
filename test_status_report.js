'use strict'

// 补 scripts/status.js 覆盖率：parseLastRun 的 invalid 分支（run.log 无匹配行时）
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readStatus } = require('./scripts/status')

;(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-'))
  try {
    fs.writeFileSync(path.join(tmp, 'run.log'), '2026-09-08 12:00:00 [INFO] 启动\n2026-09-08 12:00:01 [INFO] 加载配置完成\n')
    const status = readStatus(tmp)
    assert.strictEqual(status.run.status, 'invalid', 'run.log 无匹配行时应返回 invalid')
    assert.strictEqual(status.run.value, undefined, 'invalid 时不应有 value')
    console.log('test_status_report OK')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})().catch((e) => { console.error(e); process.exit(1) })
