'use strict'

// 共享的「YAML / 报告文本」提取工具（C5-044）。
//
// 为什么必须收口：这三族提取原先都是「复制一份 → 各自演化」，规则已经分叉且没有任何断言盯着——
//   * `run: |` 正文：test_mutation_report_cli.js 里两份。副本 A（解析本轮运行起点的场景）保留注释行与
//     空行、把正文 dedent 到 `run:` 缩进 +2；副本 B（剥离报告的步骤）跳过 `#` 行、遇空行即停、保留原
//     缩进。同一段 YAML 喂给两份会得到不同正文（实测 A 4 行含注释、B 1 行），而 B 的「注释不算证据」
//     判据在 A 上等于不存在；
//   * 表格行（按内容剥掉 `复用` 单元格）：test_mutation_report.js 里三份逐字相同；
//   * fd 读循环（open → fstat → read → close，同一对象只按路径访问一次）：与 scripts/mutation-json.js
//     的 readGuardedBytes 同口径，测试侧原先是一份本地实现，随用例复制必然再分叉。
//
// 收口口径：机制只在这里定义，**差异只允许以显式选项出现**（skipComments / stopAtBlank / dedent），
// 调用点不再各写一份循环；锚点缺失一律返回 null，由调用方响亮断言（不得静默返回空正文）。

const fs = require('node:fs')

/**
 * 取 YAML 步骤里 `run: |` 块的正文行。
 * @param {string} text 步骤文本（可含前后步骤/其他键）
 * @param {{skipComments?: boolean, stopAtBlank?: boolean, dedent?: boolean}} [opts]
 *   skipComments：`#` 开头的行不算正文（判据只看活动命令；shell 注释不是证据）；
 *   stopAtBlank：遇第一个空行即停（块内没有空行的前提由调用方保证）；
 *   dedent：去掉 `run:` 缩进 + 2 个空格（要按相对缩进比较时用），否则保留原缩进。
 * @returns {string[]|null} 正文行；找不到 `run: |` 锚点返回 null
 */
function runBodyOf (text, opts = {}) {
  const { skipComments = false, stopAtBlank = false, dedent = false } = opts
  const lines = String(text).split('\n')
  const anchor = lines.findIndex((line) => line.trim() === 'run: |')
  if (anchor < 0) return null
  const indent = lines[anchor].search(/\S/)
  const body = []
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i]
    const lineIndent = line.search(/\S/)
    if (line.trim() === '') {
      if (stopAtBlank) break
      body.push('')
      continue
    }
    if (lineIndent <= indent) break
    if (skipComments && line.trim().startsWith('#')) continue
    body.push(dedent ? line.slice(indent + 2) : line)
  }
  return body
}

// `复用` 单元格是唯一随 reuse.json 变化的列，按内容锚定剥掉；其余列必须逐字稳定。
const REUSE_CELL_RE = / \| (未记录|复用 [\d/]+(?:·兜底)?|全量(?:\(口径不符\))?) \|/

/**
 * 取段汇总表里某段的整行，并把 `复用` 单元格归一化掉。
 * @param {string} out render 输出
 * @param {string} seg 段名
 * @returns {string} 归一化后的行
 */
function tableRowOf (out, seg) {
  const row = String(out).split('\n').find((line) => line.startsWith(`| ${seg} |`))
  if (row === undefined) throw new Error(`表格缺少段 ${seg} 的行（表头或段名变了？）`)
  return row.replace(REUSE_CELL_RE, ' |')
}

/**
 * 按 fd 一次读回文件（与 scripts/mutation-json.js 的 readGuardedBytes 同口径）：
 * 这条路径只按路径「访问一次」（openSync('r')），之后只对 fd 做 fstatSync/readSync——
 * 读到、量到的必然是同一个对象，路径二次查找（check-then-use）不再存在。
 * @param {string} p 文件路径
 * @returns {{bytes: Buffer, size: number, mtimeMs: number}}
 */
function readViaFd (p) {
  const fd = fs.openSync(p, 'r')
  try {
    const st = fs.fstatSync(fd)
    const buf = Buffer.allocUnsafe(st.size)
    let off = 0
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    return { bytes: buf.subarray(0, off), size: st.size, mtimeMs: st.mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = { runBodyOf, tableRowOf, readViaFd }
