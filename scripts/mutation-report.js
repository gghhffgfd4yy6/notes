// 变异测试日报汇总：解析各段 stryker mutation-report.json → 汇总 → 发 GitHub Issue
// 用法：node scripts/mutation-report.js <reports-dir> [--issue]
//   <reports-dir>：包含 mutation-report-* 子目录的目录（各子目录内有 mutation-report.json）
//   --issue：发 GitHub Issue（需 GITHUB_TOKEN 环境变量）；不带则只打印汇总
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function analyze (dir) {
  // S8707：CLI 参数显式校验（防 LLM/错误参数访问任意路径——先验证存在且是目录）
  let st
  try {
    st = fs.statSync(dir) // NOSONAR:S8707 校验调用本身（防错误 CLI 参数）
  } catch (e) {
    console.error(`❌ 报告目录不存在或不可访问：${dir}（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  if (!st.isDirectory()) {
    console.error(`❌ ${dir} 不是目录（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  const results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) // NOSONAR:S8707 报告目录处理（根目录已校验，工具合法用途）
  } catch (e) {
    // 入口目录不可读 = 调用错误：友好报错 + 干净退出（与单段错误隔离不同——入口失败全部失败）
    console.error(`❌ 无法读取报告目录 ${dir}：${e.message}（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mutation-report-')) continue
    results.push(analyzeSegment(dir, entry))
  }
  return results
}

// 递归查找 stryker 报告文件（文件名 mutation.json——json reporter 输出 reports/mutation/mutation.json；
// 兼容旧名 mutation-report.json；目录可能嵌套 reports/ 等层）
function findReportJson (dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) // NOSONAR:S8707 报告目录树内递归（根目录已校验）
  } catch (e) {
    // 目录不可读/不存在 → 跳过（与 analyzeSegment 的错误隔离设计一致，单段失败不中断整体）
    return null
  }
  for (const e of entries) {
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
  for (const [fileKey, file] of Object.entries(report.files || {})) {
    for (const m of file.mutants || []) countMutant(stats, fileKey, m)
  }
  const score = stats.total > 0 ? ((stats.killed + stats.timeout) / stats.total) * 100 : 0 // 无数据不报 100%（机器人审查）
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
function countMutant (stats, fileKey, m) {
  stats.total++
  if (m.status === 'Killed') {
    stats.killed++
  } else if (m.status === 'Survived') {
    stats.survived++
    stats.survivedMutants.push({
      file: String(fileKey || '?'),
      line: m.location ? m.location.start.line : '?',
      mutator: m.mutatorName,
      replacement: m.replacement
    })
  } else if (m.status === 'NoCoverage') {
    stats.noCoverage++
  } else if (m.status === 'Timeout') {
    stats.timeout++
  }
}

// Markdown 表格单元格转义：| 破坏表格、换行破坏行结构、反引号破坏代码标记（子代理审查）
function escCell (s) {
  // 转义顺序：反斜杠先行（避免 \| 二次转义）→ 竖线 → 反引号（Markdown 行内代码无法转义反引号，替换为单引号防 span 破坏）
  return String(s).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'")
}

// 统计收集（独立小函数——降低 render 圈复杂度：文件分布 + 类型分布 + 存活列表）
function collectStats (results) {
  // Object.create(null)：文件/类型名若为 __proto__/constructor 等不污染原型链（子代理审查）
  const byFile = Object.create(null)
  const byKind = Object.create(null)
  const allSurvived = []
  for (const r of results) {
    for (const m of r.survivedMutants || []) {
      allSurvived.push(m)
      byFile[m.file] = (byFile[m.file] || 0) + 1
      byKind[m.mutator] = (byKind[m.mutator] || 0) + 1
    }
  }
  return { byFile, byKind, allSurvived }
}

function render (results) {
  const lines = []
  const { byFile, byKind, allSurvived } = collectStats(results)
  lines.push('## 🧬 变异测试日报')
  lines.push('')
  lines.push('| 段 | 变异体 | 被杀 | 超时 | 存活 | 无覆盖 | 分数 |')
  lines.push('|---|---|---|---|---|---|---|')
  let tTotal = 0
  let tKilled = 0
  let tTimeout = 0
  let tSurvived = 0
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.seg} | ❌ ${r.error} | - | - | - | - | - |`) // 7 列对齐表头（含 Timeout 列——CodeAnt P1）
      continue
    }
    tTotal += r.total
    tKilled += r.killed
    tSurvived += r.survived
    tTimeout += r.timeout || 0
    lines.push(`| ${r.seg} | ${r.total} | ${r.killed} | ${r.timeout} | ${r.survived} | ${r.noCoverage} | ${r.score}% |`)
  }
  // 口径与段分一致（超时计入已处理）；无数据报 0 而非 100（机器人审查）
  const overall = tTotal > 0 ? Math.round((((tKilled + tTimeout) / tTotal) * 100) * 100) / 100 : 0
  lines.push(`| **合计** | **${tTotal}** | **${tKilled}** | **${tTimeout}** | **${tSurvived}** | | **${overall}%** |`)
  lines.push('')
  // 存活最多的文件 Top 10（含具体数量——定位补测重点）
  const topFiles = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (topFiles.length > 0) {
    lines.push('## 存活最多的文件 Top 10')
    lines.push('')
    lines.push('| 文件 | 存活变异体数 |')
    lines.push('|---|---|')
    for (const [f, n] of topFiles) lines.push(`| \`${escCell(f)}\` | ${n} |`)
    lines.push('')
  }

  // 按变异类型分布（存活——种类 + 数量，定位测试弱在哪类）
  const topKinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 15)
  if (topKinds.length > 0) {
    lines.push('## 存活变异类型分布 Top 15')
    lines.push('')
    lines.push('| 变异类型 | 存活数 |')
    lines.push('|---|---|')
    for (const [k, n] of topKinds) lines.push(`| ${escCell(k)} | ${n} |`)
    lines.push('')
  }

  if (allSurvived.length > 0) {
    lines.push(`## 存活变异体（${allSurvived.length} 个）`)
    lines.push('')
    for (const m of allSurvived.slice(0, 30)) {
      lines.push(`- \`${escCell(m.file)}:${m.line}\` ${escCell(m.mutator)} → \`${escCell(String(m.replacement).slice(0, 40))}\``)
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
  const today = new Date().toISOString().slice(0, 10)
  const title = `🧬 变异测试日报 ${today}`
  // 同天去重：当天已有日报则跳过（避免多次运行重复发 Issue）
  const listRes = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&creator=github-actions%5Bbot%5D`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'mutation-report' }
  })
  if (listRes.ok) {
    const list = await listRes.json()
    const existing = (list || []).find(i => i.title === title)
    if (existing) {
      console.log('⏭️  当日日报已存在，跳过重复发布')
      return { number: existing.number, html_url: existing.html_url, skipped: true }
    }
  }
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
  if (!dir) {
    console.error('用法: node scripts/mutation-report.js <reports-dir> [--issue]')
    process.exit(1)
  }
  if (!fs.existsSync(dir)) {
    console.error(`❌ 报告目录不存在或不可访问：${dir}（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  const results = analyze(dir)
  const body = render(results)
  console.log(body)
  if (process.argv.includes('--issue')) {
    const issue = await postIssue(body)
    // CodeRabbit 审查：跳过分支补 number，且跳过不应标记为“已发布”
    if (issue.skipped) {
      // S5145：existing.number 来自远端 Issue 列表，属用户可控数据——跳过时不输出
      console.log('\n⏭️ 日报已存在，跳过发布')
    } else {
      // S5145：number 来自远端响应（POST /issues），属用户可控数据——日志不再输出远端字段
      console.log('\n✅ 日报已发布')
    }
  }
}

main().catch((e) => {
  console.error('❌', e.message || e)
  process.exit(1)
})
