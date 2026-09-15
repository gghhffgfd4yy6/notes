'use strict'
// 解析全部 mutation artifact 的 mutation.json，统计存活变异体分布
const fs = require('fs')
const path = require('path')
const { readReportJson } = require('../scripts/mutation-json.js')

const REPO_ROOT = path.resolve(__dirname, '..')
// 报告目录默认相对仓库根解析（不再依赖 cwd）；命令行参数可覆盖（本地用夹具核对时）。
const reportsRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, 'reports-all')
// 与 scripts/mutation-report.js 的文件名匹配对齐（含历史名），避免文件名变化后静默全零
const REPORT_NAMES = new Set(['mutation.json', 'mutation-report.json'])

function walk (dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (REPORT_NAMES.has(e.name)) out.push(p)
  }
  return out
}

// 目标文件实际行数（读不到返回 0）；旧实现硬编码尾部阈值 2701，文件拆分后统计恒为空
function countLines (file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (!text) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch (e) {
    console.error(`警告：读取 ${file} 失败，V3 全文件行数未知：${e.message}`)
    process.exitCode = 1
    return 0
  }
}

// 目录缺失/为空 = 输入不可用：显式报错并非零退出，避免输出全零假绿
if (!fs.existsSync(reportsRoot)) {
  console.error(`错误：报告目录不存在：${reportsRoot}（download-artifact 是否成功？）`)
  process.exit(1)
}
const reportFiles = walk(reportsRoot)
if (reportFiles.length === 0) {
  console.error(`错误：${reportsRoot} 下未找到任何报告文件（${[...REPORT_NAMES].join(' / ')}）`)
  process.exit(1)
}

const allSurvivors = []
const byFileStatus = {}
const skipped = []

for (const f of reportFiles) {
  // 解析失败与结构异常（合法 JSON 但形状非预期）都计入 skipped，不中断其余报告
  try {
    const d = readReportJson(f)
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('报告顶层不是 JSON 对象')
    // PR 评审 #140：files 缺失本身是结构不完整（截断/半写产物），不能当成「空报告」静默放行
    if (!d.files || typeof d.files !== 'object' || Array.isArray(d.files)) throw new Error('报告缺少 files 对象')
    const counts = {}
    const survivors = []
    for (const [file, info] of Object.entries(d.files)) {
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error(`files[${file}] 不是对象`)
      if (!Array.isArray(info.mutants)) throw new Error(`files[${file}].mutants 不是数组`)
      const fileKey = file.split('/').pop()
      if (!counts[fileKey]) counts[fileKey] = {}
      for (const m of info.mutants) {
        if (!m || typeof m !== 'object') throw new Error(`files[${file}].mutants 含非对象元素`)
        counts[fileKey][m.status] = (counts[fileKey][m.status] || 0) + 1
        if (m.status === 'Survived') { // NoCoverage 有独立计数，不混入存活（机器人审查）
          survivors.push({ file: fileKey, ...m })
        }
      }
    }
    // 整份报告校验通过后才并入全局，坏报告不留半份统计
    for (const [fileKey, st] of Object.entries(counts)) {
      if (!byFileStatus[fileKey]) byFileStatus[fileKey] = {}
      for (const [status, n] of Object.entries(st)) {
        byFileStatus[fileKey][status] = (byFileStatus[fileKey][status] || 0) + n
      }
    }
    allSurvivors.push(...survivors)
  } catch (e) {
    skipped.push({ file: f, reason: e.message })
  }
}

console.log('=== 存活变异体总数:', allSurvivors.length, '===')
console.log('\n=== 按文件+状态 ===')
for (const [f, st] of Object.entries(byFileStatus)) {
  console.log(`  ${f.padEnd(24)} ${JSON.stringify(st)}`)
}

// V3 入口存活分布：v3.262 模块化拆分后入口仅 400+ 行，旧注释的「尾部 2701-4494」阈值早已失效
// （该行段现由 xbk_* 模块承载），继续按硬编码阈值过滤只会输出恒空的假统计。改为按实际文件行数
// 覆盖全文件，阈值不再硬编码。
const V3_BASENAME = 'xbk_function_v3.js'
const v3Lines = countLines(path.join(REPO_ROOT, V3_BASENAME))
const v3surv = allSurvivors.filter(m => m.file === V3_BASENAME && typeof m.location?.start?.line === 'number') // 无位置信息不进行段统计
console.log(`\n=== V3 存活(全文件 ${v3Lines || '?'} 行): ${v3surv.length} ===`)
const byKind = {}
for (const m of v3surv) byKind[m.mutatorName] = (byKind[m.mutatorName] || 0) + 1
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`)
}

// V3 存活按行聚类（每 100 行一段）
console.log('\n=== V3 存活按行段(每100行) ===')
const seg = {}
for (const m of v3surv) {
  const s = Math.floor(m.location.start.line / 100) * 100 // v3surv 已保证有位置
  seg[s] = (seg[s] || 0) + 1
}
for (const [s, v] of Object.entries(seg).sort((a, b) => a[0] - b[0])) {
  console.log(`  行 ${s}-${Number(s) + 99}: ${v}`)
}

// 前 40 个样本（位置 + 类型 + 替换）
console.log('\n=== 样本(前40) ===')
for (const m of v3surv.slice(0, 40)) {
  console.log(`  行${m.location?.start?.line ?? '?'}  ${String(m.mutatorName || '?').padEnd(26)} 替换→${m.replacement || ''}`)
}

// 解析/结构失败必须可见：打印到 stderr 并置非零退出码，避免存活总数静默偏低
if (skipped.length) {
  console.error(`\n=== 未纳入统计的报告: ${skipped.length}/${reportFiles.length} ===`)
  for (const s of skipped) console.error(`  ${s.file}: ${s.reason}`)
  process.exitCode = 1
}
