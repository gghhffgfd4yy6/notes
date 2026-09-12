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

// matrix include 的唯一解析器：`- name:` / `- src:` / `- mutate:` 任一开头都算新条目，
// 引号（单/双）与缩进放宽，字段值停在空白或 #。
// 行段与 mutate 目标都从这里派生——避免「两个解析器口径不一致」（曾出现：条目校验接受单引号
// mutate，而旧的 range/target 正则只认双引号 → 合法 yml 被误报漏测）。
const ymlLines = yml.split(/\r?\n/)
const includeIdx = ymlLines.findIndex(line => /^\s*include:\s*$/.test(line))
const includeIndent = includeIdx === -1 ? -1 : ymlLines[includeIdx].match(/^\s*/)[0].length
const matrixEntries = []
let currentEntry = null
if (includeIdx !== -1) {
  for (const line of ymlLines.slice(includeIdx + 1)) {
    const indent = line.match(/^\s*/)[0].length
    if (/^\s*[A-Za-z_][\w-]*:/.test(line) && indent <= includeIndent) break // include 块结束（回到 steps: 等同级键）
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      currentEntry = { name: null, src: null, mutate: null }
      matrixEntries.push(currentEntry)
    }
    if (!currentEntry) continue
    // 字段解析走字符串切片而非正则：`\s*-?\s*` 这类相邻量词会被静态分析判为可回溯超线性（Sonar S8786）
    const body = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed
    const colon = body.indexOf(':')
    if (colon <= 0) continue
    const key = body.slice(0, colon)
    if (key !== 'name' && key !== 'src' && key !== 'mutate') continue
    let value = body.slice(colon + 1).trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1) // 引号标量：取到闭合引号，内部的 # 属于值而非注释
      value = close > 0 ? value.slice(1, close) : value.slice(1)
    } else {
      const hash = value.indexOf('#') // 裸标量：行内注释从 # 开始
      if (hash !== -1) value = value.slice(0, hash)
    }
    value = value.trim()
    if (value) currentEntry[key] = value
  }
}

const fileRanges = new Map()
const mutateTargets = new Set()
for (const entry of matrixEntries) {
  if (!entry.mutate) continue
  const [file, range] = entry.mutate.split(':')
  mutateTargets.add(file)
  if (range && /^\d+-\d+$/.test(range)) {
    const [start, end] = range.split('-').map(Number)
    if (!fileRanges.has(file)) fileRanges.set(file, [])
    fileRanges.get(file).push({ start, end })
  }
}

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

// 校验 0：matrix include 每项必须有 name、src 与其 mutate 目标同文件（解析见文件顶部）。
// 背景：src 只被 actions/cache 的 hashFiles 指纹使用（mutation.yml），写错或整行删掉都不会让 CI 报错，
// 只会让该段的缓存指纹失真（缓存串段 / 永不过期）；缺 name 的条目则会让缓存 key 变成 stryker-undefined-*。
if (matrixEntries.length === 0) {
  console.error('❌ 未在 mutation.yml 的 matrix include 中解析到任何条目')
  failed = true
}
for (const entry of matrixEntries) {
  const label = entry.name || '(无 name)'
  if (!entry.name) {
    console.error('❌ matrix 条目缺 name 字段（缓存 key 会退化为 stryker-undefined-*）')
    failed = true
  }
  if (!entry.mutate) {
    console.error(`❌ matrix「${label}」缺 mutate 字段`)
    failed = true
  } else if (!entry.src) {
    console.error(`❌ matrix「${label}」缺 src 字段（缓存指纹会退化为空 → 缓存串段）`)
    failed = true
  } else if (entry.src !== entry.mutate.split(':')[0]) {
    console.error(`❌ matrix「${label}」src(${entry.src}) 与 mutate 目标(${entry.mutate}) 不一致`)
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
