// 变异测试日报汇总：解析各段 stryker mutation-report.json → 汇总 → 发 GitHub Issue
// 用法：node scripts/mutation-report.js <reports-dir> [--issue]
//   <reports-dir>：包含 mutation-report-* 子目录的目录（各子目录内有 mutation-report.json）
//   --issue：发 GitHub Issue（需 GITHUB_TOKEN 环境变量）；不带则只打印汇总
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function analyze (dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mutation-report-')) continue
    results.push(analyzeSegment(dir, entry))
  }
  return results
}

// 递归查找 stryker 报告文件（文件名 mutation.json——json reporter 输出 reports/mutation/mutation.json；
// 兼容旧名 mutation-report.json；目录可能嵌套 reports/ 等层）
function findReportJson (dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const found = findReportJson(p)
      if (found) return found
    } else if (e.name === 'mutation.json' || e.name === 'mutation-report.json') {
      return p
    }
  }
  return null
}

// 解析单个段的 mutation-report.json（复杂度拆分：analyze 保持线性遍历）
function analyzeSegment (dir, entry) {
  const reportPath = findReportJson(path.join(dir, entry.name))
  if (!reportPath) return { seg: entry.name.replace('mutation-report-', ''), error: '缺 mutation-report.json' }
  let report
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (e) {
    return { seg: entry.name.replace('mutation-report-', ''), error: String(e.message || e) }
  }
  const stats = { total: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0, survivedMutants: [] }
  for (const file of Object.values(report.files || {})) {
    for (const m of file.mutants || []) countMutant(stats, file, m)
  }
  const score = stats.total > 0 ? ((stats.killed + stats.timeout) / stats.total) * 100 : 100
  return {
    seg: entry.name.replace('mutation-report-', ''),
    total: stats.total,
    killed: stats.killed,
    survived: stats.survived,
    noCoverage: stats.noCoverage,
    timeout: stats.timeout,
    score: Math.round(score * 100) / 100,
    survivedMutants: stats.survivedMutants
  }
}

// 单个变异体计数（独立小函数：killed/survived/noCoverage/timeout 分类）
function countMutant (stats, file, m) {
  stats.total++
  if (m.status === 'Killed') {
    stats.killed++
  } else if (m.status === 'Survived') {
    stats.survived++
    stats.survivedMutants.push({
      file: (file.sourcePath || file.name || '?').split('/').pop(),
      line: m.location ? m.location.start.line : '?',
      mutator: m.mutatorName
    })
  } else if (m.status === 'NoCoverage') {
    stats.noCoverage++
  } else if (m.status === 'Timeout') {
    stats.timeout++
  }
}

function render (results) {
  const lines = []
  lines.push('## 🧬 变异测试日报')
  lines.push('')
  lines.push('| 段 | 变异体 | 被杀 | 存活 | 无覆盖 | 分数 |')
  lines.push('|---|---|---|---|---|---|')
  let tTotal = 0
  let tKilled = 0
  let tSurvived = 0
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.seg} | ❌ ${r.error} | | | | |`)
      continue
    }
    tTotal += r.total
    tKilled += r.killed
    tSurvived += r.survived
    lines.push(`| ${r.seg} | ${r.total} | ${r.killed} | ${r.survived} | ${r.noCoverage} | ${r.score}% |`)
  }
  const overall = tTotal > 0 ? Math.round(((tKilled / tTotal) * 100) * 100) / 100 : 100
  lines.push(`| **合计** | **${tTotal}** | **${tKilled}** | **${tSurvived}** | | **${overall}%** |`)
  lines.push('')
  const allSurvived = results.flatMap(r => r.survivedMutants || [])
  if (allSurvived.length > 0) {
    lines.push(`## 存活变异体（${allSurvived.length} 个）`)
    lines.push('')
    for (const m of allSurvived.slice(0, 30)) {
      lines.push(`- \`${m.file}:${m.line}\` ${m.mutator} → \`${String(m.replacement).slice(0, 40)}\``)
    }
    if (allSurvived.length > 30) lines.push(`- …还有 ${allSurvived.length - 30} 个（见各段报告）`)
  } else {
    lines.push('## 🎉 无存活变异体！')
  }
  lines.push('')
  lines.push('> 由 mutation-report.js 自动生成')
  return lines.join('\n')
}

async function postIssue (body) {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('缺少 GITHUB_TOKEN')
  const repo = process.env.GITHUB_REPOSITORY || 'junhanw868-bot/notes'
  const title = `🧬 变异测试日报 ${new Date().toISOString().slice(0, 10)}`
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'mutation-report' },
    body: JSON.stringify({ title, body })
  })
  if (!res.ok) throw new Error(`发 Issue 失败: ${res.status} ${await res.text()}`)
  return res.json()
}

async function main () {
  const dir = process.argv[2]
  if (!dir || !fs.existsSync(dir)) {
    console.error('用法: node scripts/mutation-report.js <reports-dir> [--issue]')
    process.exit(1)
  }
  const results = analyze(dir)
  const body = render(results)
  console.log(body)
  if (process.argv.includes('--issue')) {
    const issue = await postIssue(body)
    console.log(`\n✅ 日报已发布: ${issue.html_url}`)
  }
}

main().catch((e) => {
  console.error('❌', e.message || e)
  process.exit(1)
})
