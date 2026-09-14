#!/usr/bin/env node
// 版本三方一致性闸门：文件头 ↔ CHANGELOG 最新 ↔ package.json
// CI 与提交前使用。任一不一致 → 退出码 1。
'use strict'
const fs = require('fs')
const path = require('path')

function fail (msg) {
  console.error('❌ ' + msg)
  process.exit(1)
}

const root = __dirname
const pkg = require(path.join(root, 'package.json'))
const base = String(pkg.version).replace(/\.\d+$/, '') // 3.258.0 -> 3.258

const mainFile = fs.readFileSync(path.join(root, 'xbk_function_v3.js'), 'utf8')
const headMatch = mainFile.match(/v(\d+\.\d+)/)
if (!headMatch) { fail('主文件头未找到版本号 vX.Y') }

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const versions = [...changelog.matchAll(/^##\s*v?(\d+\.\d+)/gm)]
if (!versions.length) { fail('CHANGELOG 未找到版本条目') }
const latestCl = versions[versions.length - 1][1] // 正序索引：最新在底部

const parts = { 主文件头: headMatch[1], CHANGELOG: latestCl, 'package.json': base }
const bad = Object.entries(parts).filter(([, v]) => v !== base)
if (bad.length) {
  console.error('❌ 版本不一致（基准 ' + base + '）：')
  for (const [k, v] of bad) console.error('   ' + k + ' = ' + v)
  process.exit(1)
}
console.log('✅ 版本三方一致：v' + base)
