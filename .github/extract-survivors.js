'use strict'
// 临时脚本：解析 stryker incremental 缓存，统计存活变异体分布（用完即删）
const fs = require('fs')
const path = require('path')

function walk (dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

// stryker incremental 结构: { files: { <path>: { mutants: { <id>: {status, ...} } } } }
function collectMutants (obj, out = []) {
  if (!obj || typeof obj !== 'object') return out
  if (typeof obj.status === 'string' && obj.mutatorName) {
    out.push(obj)
  }
  for (const k of Object.keys(obj)) {
    if (k === 'files' || k === 'mutants' || k === 'result' || k === 'reports') {
      collectMutants(obj[k], out)
    }
  }
  return out
}

const byKind = {}
const byStatus = {}
const byFile = {}
let total = 0
let survivors = []

for (const dir of ['p1', 'p2', 'p3', 'p4']) {
  for (const f of walk(dir)) {
    let data
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { continue }
    const mutants = collectMutants(data)
    for (const m of mutants) {
      total++
      byStatus[m.status] = (byStatus[m.status] || 0) + 1
      const kind = m.mutatorName || 'unknown'
      byKind[kind] = (byKind[kind] || 0) + 1
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        survivors.push(m)
        const file = (m.fileName || (m.location && m.location.file) || '?').split('/').pop()
        byFile[file] = (byFile[file] || 0) + 1
      }
    }
  }
}

console.log('=== 总变异体:', total, '===')
console.log('状态分布:', JSON.stringify(byStatus, null, 1))
console.log('\n=== 按 mutatorName 分布(全部) ===')
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`)
console.log('\n=== 存活/NoCoverage 按 mutatorName ===')
const sk = {}
for (const m of survivors) { const k = m.mutatorName || '?'; sk[k] = (sk[k] || 0) + 1 }
for (const [k, v] of Object.entries(sk).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`)
console.log('\n=== 存活按文件 ===')
for (const [k, v] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`)
console.log('\n=== 存活样本(前30, 含位置) ===')
for (const m of survivors.slice(0, 30)) {
  const loc = m.location || {}
  console.log(`  ${m.mutatorName.padEnd(24)} line=${String(loc.startLine ?? loc.start?.line ?? '?').padEnd(5)} ${(m.replacement || '')}`)
}
