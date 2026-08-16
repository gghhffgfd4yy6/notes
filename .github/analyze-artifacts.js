'use strict'
// 解析全部 mutation artifact 的 mutation.json，统计存活变异体分布
const fs = require('fs')
const path = require('path')

function walk (dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name === 'mutation.json') out.push(p)
  }
  return out
}

const allSurvivors = []
const byFileStatus = {}

for (const f of walk('reports-all')) {
  let d
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { continue }
  for (const [file, info] of Object.entries(d.files || {})) {
    const fileKey = file.split('/').pop()
    if (!byFileStatus[fileKey]) byFileStatus[fileKey] = {}
    for (const m of info.mutants || []) {
      byFileStatus[fileKey][m.status] = (byFileStatus[fileKey][m.status] || 0) + 1
      if (m.status === 'Survived') { // NoCoverage 有独立计数，不混入存活（机器人审查）
        allSurvivors.push({ file: fileKey, ...m })
      }
    }
  }
}

console.log('=== 存活变异体总数:', allSurvivors.length, '===')
console.log('\n=== 按文件+状态 ===')
for (const [f, st] of Object.entries(byFileStatus)) {
  console.log(`  ${f.padEnd(24)} ${JSON.stringify(st)}`)
}

// V3 尾部（2701-4494 行）存活分布
const v3tail = allSurvivors.filter(m => m.file === 'xbk_function_v3.js' && m.location?.start?.line >= 2701) // 无位置信息不进尾部统计
console.log(`\n=== V3 尾部(2701+) 存活: ${v3tail.length} ===`)
const byKind = {}
for (const m of v3tail) byKind[m.mutatorName] = (byKind[m.mutatorName] || 0) + 1
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`)
}

// V3 尾部存活按行聚类（每 50 行一段）
console.log('\n=== V3 尾部存活按行段(每100行) ===')
const seg = {}
for (const m of v3tail) {
  const s = Math.floor(m.location.start.line / 100) * 100 // v3tail 已保证有位置
  seg[s] = (seg[s] || 0) + 1
}
for (const [s, v] of Object.entries(seg).sort((a, b) => a[0] - b[0])) {
  console.log(`  行 ${s}-${s + 99}: ${v}`)
}

// 前 40 个样本（位置 + 类型 + 替换）
console.log('\n=== 样本(前40) ===')
for (const m of v3tail.slice(0, 40)) {
  console.log(`  行${m.location?.start?.line ?? '?'}  ${String(m.mutatorName || '?').padEnd(26)} 替换→${m.replacement || ''}`)
}
