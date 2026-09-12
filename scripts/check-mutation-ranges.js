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
const workflowPath = path.resolve(process.env.MUTATION_WORKFLOW_PATH || path.join(root, '.github/workflows/mutation.yml'))
const yml = process.env.MUTATION_WORKFLOW_TEXT || fs.readFileSync(workflowPath, 'utf8') // nosemgrep（仓库内固定路径，非用户输入）

// 收集 yml 中形如 "file.js:start-end" 的行段（含引号），按文件聚合
const rangeRe = /"([\w/.-]+\.(?:js|mjs|cjs)):(\d+)-(\d+)"/g
const fileRanges = new Map()
for (const match of yml.matchAll(rangeRe)) {
  const [, file, start, end] = match
  if (!fileRanges.has(file)) fileRanges.set(file, [])
  fileRanges.get(file).push({ start: Number(start), end: Number(end) })
}

const mutateTargets = new Set([...yml.matchAll(/^\s*mutate:\s*"([^":]+)(?::\d+-\d+)?"/gm)].map(match => match[1]))
const productionFiles = [
  ...fs.readdirSync(root).filter(file => /^xbk_.*\.js$/.test(file)),
  'qinglong/xbk_push.js',
  'scripts/check-deps.js'
]

if (fileRanges.size === 0) {
  console.error('❌ 未在 mutation.yml 中解析到任何 mutate 行段（格式应为 "file.js:start-end"）')
  process.exit(1)
}

let failed = false
for (const file of productionFiles) {
  if (!mutateTargets.has(file)) {
    console.error(`❌ ${file}: 未列入 mutation.yml 的 mutate 目标`)
    failed = true
  }
}

// 校验 0：matrix include 每项的 src 必须存在且与其 mutate 目标同文件。
// 背景：src 只被 actions/cache 的 hashFiles 指纹使用（mutation.yml），写错或整行删掉都不会让 CI 报错，
// 只会让该段的缓存指纹失真（缓存串段 / 永不过期），故在此拦住。
const matrixEntries = []
let currentEntry = null
for (const line of yml.split(/\r?\n/)) {
  const name = line.match(/^ {10}- name:\s*(\S+)\s*$/)
  if (name) {
    currentEntry = { name: name[1], src: null, mutate: null }
    matrixEntries.push(currentEntry)
    continue
  }
  if (!currentEntry) continue
  const src = line.match(/^ {12}src:\s*"([^"]+)"/)
  if (src) { currentEntry.src = src[1]; continue }
  const target = line.match(/^ {12}mutate:\s*"([^":]+)/)
  if (target) currentEntry.mutate = target[1]
}
if (matrixEntries.length === 0) {
  console.error('❌ 未在 mutation.yml 的 matrix include 中解析到任何条目（缩进应为 10/12 空格）')
  failed = true
}
for (const entry of matrixEntries) {
  if (!entry.mutate) {
    console.error(`❌ matrix「${entry.name}」缺 mutate 字段`)
    failed = true
  } else if (!entry.src) {
    console.error(`❌ matrix「${entry.name}」缺 src 字段（缓存指纹会退化为空 → 缓存串段）`)
    failed = true
  } else if (entry.src !== entry.mutate) {
    console.error(`❌ matrix「${entry.name}」src(${entry.src}) 与 mutate 目标(${entry.mutate}) 不一致`)
    failed = true
  }
}

for (const [file, ranges] of fileRanges) {
  let fileFailed = false
  // 路径加固：解析后必须仍在仓库根目录内，拒绝 yml 里的越界路径
  const filePath = path.resolve(root, file)
  if (!filePath.startsWith(root + path.sep)) {
    console.error(`❌ ${file}: 路径越出仓库根目录，拒绝处理`)
    failed = true
    continue
  }
  if (!fs.existsSync(filePath)) { // nosemgrep（filePath 已做 resolve + 仓库根前缀校验，运行时防护到位）
    console.error(`❌ ${file}: mutation.yml 引用的文件不存在`)
    failed = true
    continue
  }
  // 读取失败（如 yml 指向目录、权限问题）必须转为校验失败，不能让脚本崩溃
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8') // nosemgrep（filePath 已做 resolve + 仓库根前缀校验，运行时防护到位）
  } catch (err) {
    console.error(`❌ ${file}: 读取失败 —— ${err.message}`)
    failed = true
    continue
  }
  const actualLines = raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)

  // 校验 1：首段必须从第 1 行开始（防头部静默漏测）
  if (sorted[0].start !== 1) {
    console.error(`❌ ${file}: 首段从第 ${sorted[0].start} 行开始 —— 第 1-${sorted[0].start - 1} 行未被变异测试覆盖`)
    fileFailed = true
  }

  // 校验 2：连续无缝隙、不重叠
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start !== sorted[i - 1].end + 1) {
      console.error(`❌ ${file}: 行段不连续 —— ${sorted[i - 1].start}-${sorted[i - 1].end} 与 ${sorted[i].start}-${sorted[i].end} 之间有缝隙或重叠`)
      fileFailed = true
    }
  }

  // 校验 3：最后一段必须覆盖到实际行数（文件增长检测）
  const coveredEnd = sorted[sorted.length - 1].end
  if (coveredEnd < actualLines) {
    console.error(`❌ ${file}: 行段止于 ${coveredEnd}，但文件实际 ${actualLines} 行 —— 尾部 ${actualLines - coveredEnd} 行未被变异测试覆盖（v3.270 教训）`)
    fileFailed = true
  } else if (coveredEnd > actualLines) {
    console.error(`❌ ${file}: 行段止于 ${coveredEnd}，超过文件实际行数 ${actualLines}`)
    fileFailed = true
  }

  if (fileFailed) failed = true
  if (!fileFailed) {
    const segs = sorted.map(r => `${r.start}-${r.end}`).join(', ')
    console.log(`✅ ${file}: ${actualLines} 行，${sorted.length} 段全覆盖 [${segs}]`)
  }
}

process.exit(failed ? 1 : 0)
