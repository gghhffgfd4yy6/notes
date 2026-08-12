#!/usr/bin/env node
// 中央裁判: 收集一轮审查报告 → 去重 → 生成真实 bug 清单 + 更新 state.json
const fs = require('fs')
const path = require('path')
const round = process.argv[2]
if (!round) { console.error('用法: dedupe.js <轮次号>'); process.exit(1) }
const dir = path.join('/workspace', '.ai', 'review', `round-${round}`)
const statePath = path.join('/workspace', '.ai', 'state.json')
if (!fs.existsSync(dir)) { console.error('目录不存在:', dir); process.exit(1) }

const files = fs.readdirSync(dir).filter(f => f.startsWith('agent-') && f.endsWith('.md'))
console.log(`═══ 中央裁判: round-${round} (${files.length} 个代理报告) ═══`)

// 解析每份报告
const all = []
for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8')
  // 按 ## BUG / ## PASS 切块
  const blocks = content.split(/\n## /).filter(b => b.trim())
  let seq = 0
  for (const b of blocks) {
    if (b.startsWith('PASS')) { all.push({ agent: f, type: 'PASS' }); continue }
    if (!b.startsWith('BUG')) continue
    seq++
    const get = (k) => { const m = b.match(new RegExp(k + ': (.*)')) ; return m ? m[1].trim() : '' }
    all.push({
      agent: f,
      type: 'BUG',
      severity: get('严重程度'),
      location: get('位置'),
      func: get('函数'),
      trigger: get('触发条件'),
      current: get('当前行为'),
      expected: get('预期行为'),
      evidence: get('证据'),
      suggestion: get('修复建议'),
      recommend: get('是否建议修复'),
    })
  }
}

// 统计
const bugs = all.filter(x => x.type === 'BUG')
const passes = all.filter(x => x.type === 'PASS')
console.log(`代理报告: ${files.length} | PASS: ${passes.length} | BUG 候选: ${bugs.length}`)
console.log('')
console.log('严重程度分布:', bugs.reduce((m, b) => { m[b.severity] = (m[b.severity] || 0) + 1; return m }, {}))
console.log('')

// 去重: 按 函数+位置 归组(同一函数同一行=重复)
const byFunc = {}
for (const b of bugs) {
  const key = `${b.func}|${b.location.split(':').pop()}`
  if (!byFunc[key]) byFunc[key] = []
  byFunc[key].push(b)
}
console.log('按 函数+位置 去重后:', Object.keys(byFunc).length, '条(原始', bugs.length + ')')
console.log('')

// 写出去重后的候选清单(供裁判人工/主代理裁决)
const out = []
let i = 0
for (const [key, group] of Object.entries(byFunc)) {
  i++
  const primary = group[0]
  out.push(`## BUG-${round}-${String(i).padStart(3, '0')}  [${primary.severity}] ${primary.func}`)
  out.push(`位置: ${primary.location}`)
  out.push(`触发: ${primary.trigger}`)
  out.push(`当前: ${primary.current}`)
  out.push(`预期: ${primary.expected}`)
  out.push(`证据: ${primary.evidence}`)
  out.push(`建议: ${primary.suggestion}`)
  out.push(`重复来源: ${group.map(g => g.agent).join(', ')}`)
  out.push('')
}
const outPath = path.join('/workspace', '.ai', 'patches', `round-${round}-candidates.md`)
fs.writeFileSync(outPath, out.join('\n'))
console.log(`✅ 候选清单已写: ${outPath}`)

// 更新 state.json
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
state.currentRound = Number(round)
state.lastRunAt = new Date().toISOString()
state.rounds[round] = { agents: files.length, pass: passes.length, candidates: bugs.length, deduped: Object.keys(byFunc).length }
fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
console.log(`✅ state.json 已更新 (round-${round})`)
