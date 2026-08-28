#!/usr/bin/env node
// 变异测试行段覆盖校验（v3.270 新增）：
// mutation.yml 的 mutate 行段是硬编码的，曾因文件增长静默漏测尾部 430 行
// （v3-part4 只到 4494，实际文件 4924 行）。本脚本校验：
//   1. mutation.yml 中每个长文件的行段必须覆盖到当前实际行数（无静默漏测）
//   2. 行段之间连续无缝隙、不重叠
// 用法：node scripts/check-mutation-ranges.js
// 退出码：0 = 通过；1 = 存在漏测或行段错误。CI/提交前均可运行。
'use strict'
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const yml = fs.readFileSync(path.join(root, '.github/workflows/mutation.yml'), 'utf8')

// 收集 yml 中形如 "file.js:start-end" 的行段（含引号），按文件聚合
const rangeRe = /"([\w/.-]+\.(?:js|mjs|cjs)):(\d+)-(\d+)"/g
const fileRanges = new Map()
for (const match of yml.matchAll(rangeRe)) {
  const [, file, start, end] = match
  if (!fileRanges.has(file)) fileRanges.set(file, [])
  fileRanges.get(file).push({ start: Number(start), end: Number(end) })
}

if (fileRanges.size === 0) {
  console.error('❌ 未在 mutation.yml 中解析到任何 mutate 行段（格式应为 "file.js:start-end"）')
  process.exit(1)
}

let failed = false
for (const [file, ranges] of fileRanges) {
  const filePath = path.join(root, file)
  if (!fs.existsSync(filePath)) {
    console.error(`❌ ${file}: mutation.yml 引用的文件不存在`)
    failed = true
    continue
  }
  // 行数口径与 wc -l 一致：以换行符计数，末尾换行不额外算一行
  const raw = fs.readFileSync(filePath, 'utf8')
  const actualLines = raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)

  // 校验 1：连续无缝隙、不重叠
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start !== sorted[i - 1].end + 1) {
      console.error(`❌ ${file}: 行段不连续 —— ${sorted[i - 1].start}-${sorted[i - 1].end} 与 ${sorted[i].start}-${sorted[i].end} 之间有缝隙或重叠`)
      failed = true
    }
  }

  // 校验 2：最后一段必须覆盖到实际行数（文件增长检测）
  const coveredEnd = sorted[sorted.length - 1].end
  if (coveredEnd < actualLines) {
    console.error(`❌ ${file}: 行段止于 ${coveredEnd}，但文件实际 ${actualLines} 行 —— 尾部 ${actualLines - coveredEnd} 行未被变异测试覆盖（v3.270 教训）`)
    failed = true
  } else if (coveredEnd > actualLines) {
    console.error(`⚠️  ${file}: 行段止于 ${coveredEnd}，超过文件实际行数 ${actualLines}（不算错误，但建议收紧）`)
  }

  if (!failed) {
    const segs = sorted.map(r => `${r.start}-${r.end}`).join(', ')
    console.log(`✅ ${file}: ${actualLines} 行，${sorted.length} 段全覆盖 [${segs}]`)
  }
}

process.exit(failed ? 1 : 0)
