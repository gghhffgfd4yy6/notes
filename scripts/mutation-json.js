'use strict'
// 读取并解析 stryker mutation.json（支持超大文件）：
// command runner 会把整段测试输出写进每个变异体的 statusReason——单个文件可达 500MB+，
// 超过 V8 字符串上限（0x1fffffe8 ≈ 536MB）后 JSON.parse 直接抛错（日报该段显示 ❌）。
// statusReason 日报用不到，解析前按字节剥离：Buffer 无字符串长度限制。
// 注意：整文件读入 + Buffer.concat 会短暂翻倍内存（600MB 级报告峰值约 1.2GB，CI 7GB 内存下安全）。
const fs = require('node:fs')
const path = require('node:path')
const { constants: bufferConstants } = require('node:buffer')

const KEY = Buffer.from('"statusReason"')
const PLACEHOLDER = Buffer.from(':""')
const MAX_STRING_LENGTH = 512 * 1024 * 1024 - 24 // V8 单字符串最大字符数（0x1fffffe8 ≈ 512MiB；表达式写法规避 Codacy PMD InnaccurateNumericLiteral 误报）
// F1：读取前的护栏上限——Buffer 能表示的最大长度（超出时 readFileSync 抛 ERR_OUT_OF_RANGE，
// 该异常既不带被读路径也不带实际大小）。与 maxStringLength 一样可由调用侧覆盖，供测试构造小夹具。
const MAX_FILE_BYTES = bufferConstants.MAX_LENGTH
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d])

// 从 i 起跳过空白，返回首个非空白位置
function skipWhitespace (buf, i) {
  while (i < buf.length && WHITESPACE.has(buf[i])) i++
  return i
}

// 若 buf[i] 是字符串起始引号，返回字符串结束后的位置；否则返回 -1
// （逐字节跳过 \" 转义，避免把值内的引号误判为结束）
function stringEnd (buf, i) {
  if (buf[i] !== 0x22 /* " */) return -1
  let j = i + 1
  while (j < buf.length) {
    const c = buf[j]
    if (c === 0x5c /* \\ */) { j += 2; continue }
    if (c === 0x22 /* " */) return j + 1
    j++
  }
  return -1
}

// 定位 idx 处 statusReason 字段的字符串值：返回值结束位置；非该字段/值非字符串时返回 -1
// （indexOf 命中的未必是字段名：某字符串值的引号+内容也可能构成同一字节序列——
//   如 {"replacement":"statusReason"} 命中于值位置；故须再校验紧随 KEY 的冒号
//   才能确认是字段，冒号检查才是剥离正确性的依据，而非引号位置）
function statusReasonValueEnd (buf, idx) {
  const afterKey = skipWhitespace(buf, idx + KEY.length)
  if (buf[afterKey] !== 0x3a /* : */) return -1
  return stringEnd(buf, skipWhitespace(buf, afterKey + 1))
}

// 追加 [pos, idx) 原文 + KEY + 空串占位（单次变参 push，S7778）
function appendWithPlaceholder (chunks, buf, pos, idx) {
  chunks.push(buf.subarray(pos, idx), KEY, PLACEHOLDER)
}

function readReportJson (reportPath, options = {}) {
  // F1：V8 字符串上限可被调用侧覆盖（默认 MAX_STRING_LENGTH）。生产调用方一律不传，
  // 该形参只为测试构造「剥离后仍超限」的输入——否则验证这条护栏需要一个 512MiB 级夹具。
  const maxStringLength = Number.isFinite(options && options.maxStringLength) ? options.maxStringLength : MAX_STRING_LENGTH
  // F1：预读大小护栏上限，同样只由测试注入（生产默认即 Buffer 上限）。
  const maxFileBytes = Number.isFinite(options && options.maxFileBytes) ? options.maxFileBytes : MAX_FILE_BYTES
  // nosemgrep: 工具脚本按 CLI 传入路径读取报告，路径非用户净输入
  // Trust Model（v3.266 强化）：readReportJson 是内部 API，期望 reportPath
  //   来自已校验目录——scripts/mutation-report.js 链中 fs.statSync(dir)
  //   + isDirectory() 是前置条件；.github/analyze-artifacts.js 只对 reportsRoot
  //   做 existsSync 存在性检查（未校验 isDirectory），其报告路径来自该目录的
  //   readdir 枚举（CI 仓库内目录，本地夹具可经 argv 覆盖），非不可信输入。
  //   公开 export 仅为测试复用与工具内嵌，不是给不可信输入使用。Codacy CRITICAL
  //   标"动态构造路径"在以上内部调用链上不成立（旧注释称"三个调用方 dir 入口
  //   已先校验"对 analyze-artifacts.js 并不成立，此处据实修正口径）。
  // Codacy MEDIUM：path.resolve() 防御性 normalize（公开 API，不假设上游已校验）
  const abs = path.resolve(reportPath)
  // F1：读取前的护栏——先 stat 拿到真实大小与文件类型，再决定是否整文件读入。
  // 此前唯一的尺寸守卫（strippedLength > maxStringLength）落在 Buffer.concat 的分配峰值**之后**：
  // 超限输入要先付出一次整份报告的分配才发现放不下；而且非普通文件（目录/FIFO/socket）会走
  // readFileSync——目录抛不带路径的 EISDIR，FIFO 直接把进程挂在读上。
  let stat
  try {
    stat = fs.statSync(abs)
  } catch (err) {
    throw new Error(`无法读取 ${abs}：${err.message}`)
  }
  if (!stat.isFile()) {
    throw new Error(`无法读取 ${abs}：不是普通文件（目录/FIFO/socket 一律拒绝整文件读入）`)
  }
  if (stat.size > maxFileBytes) {
    throw new Error(`报告文件 ${abs} 为 ${stat.size} 字节，超过预读上限 ${maxFileBytes} 字节：拒绝整文件读入`)
  }
  let buf
  try {
    buf = fs.readFileSync(abs) // Buffer 读取，绕开字符串长度上限
  } catch (err) {
    // 读取阶段失败（ENOENT/EACCES/EISDIR 等）原生异常消息不含被读路径，这里补上上下文
    // （实测目录入参抛 EISDIR: illegal operation on a directory, read，无法定位是哪个报告）
    // stat 与 read 之间文件仍可能被替换/删除（TOCTOU），故这段兜底保留。
    throw new Error(`无法读取 ${abs}：${err.message}`)
  }
  const chunks = []
  let pos = 0
  // 剥离是无条件的：全 buffer 扫描，任意嵌套层级的字符串型 statusReason 一律置为 ""
  // 返回值不携带「已改写」标记，调用方无法区分「被改写为空串」与「本来就是空串」
  // F1：边扫边累计剥离后的字节数。原先只在 Buffer.concat **之后**才比 MAX_STRING_LENGTH，
  // 那时整份报告已被复制一遍（分配峰值）；累计长度让上限判定落在 concat 之前，
  // 超限输入在读完之后、分配峰值之前就带路径快速失败。
  let strippedLength = buf.length
  let idx = buf.indexOf(KEY, pos)
  while (idx !== -1) {
    const valueEnd = statusReasonValueEnd(buf, idx)
    if (valueEnd === -1) {
      // 非字段命中一律原文保留：值非字符串（null/数字/对象/数组），或命中恰是内容为
      // statusReason 的字符串值本身（相似键名 statusReason2 不含带引号的 KEY，不会命中）
      chunks.push(buf.subarray(pos, idx + KEY.length))
      pos = idx + KEY.length
    } else {
      // 丢弃 [idx+KEY.length, valueEnd) 共 (valueEnd-idx)-KEY.length 字节，改写为 2 字节占位
      strippedLength -= (valueEnd - idx) - KEY.length - PLACEHOLDER.length
      appendWithPlaceholder(chunks, buf, pos, idx)
      pos = valueEnd
    }
    idx = buf.indexOf(KEY, pos)
  }
  chunks.push(buf.subarray(pos))
  // 剥离后仍超上限：快速失败并给出可行动报错（V8 原生异常不含文件上下文）
  if (strippedLength > maxStringLength) {
    throw new Error(`JSON 剥离 statusReason 后仍为 ${strippedLength} 字节，超过 V8 字符串上限 ${maxStringLength}：${abs}`)
  }
  const stripped = Buffer.concat(chunks)
  try {
    return JSON.parse(stripped.toString('utf8'))
  } catch (err) {
    // 带上文件路径与剥离前后尺寸，便于定位（报告文件损坏时原始异常不含上下文）
    throw new Error(`解析 ${abs} 失败（原始 ${buf.length} 字节，剥离后 ${stripped.length} 字节）：${err.message}`)
  }
}

module.exports = { readReportJson }
