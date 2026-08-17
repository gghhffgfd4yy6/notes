'use strict'
// 读取并解析 stryker mutation.json（支持超大文件）：
// command runner 会把整段测试输出写进每个变异体的 statusReason——单个文件可达 500MB+，
// 超过 V8 字符串上限（0x1fffffe8 ≈ 536MB）后 JSON.parse 直接抛错（日报该段显示 ❌）。
// statusReason 日报用不到，解析前按字节剥离：Buffer 无字符串长度限制。
// 注意：整文件读入 + Buffer.concat 会短暂翻倍内存（600MB 级报告峰值约 1.2GB，CI 7GB 内存下安全）。
const fs = require('node:fs')
const path = require('node:path')

const KEY = Buffer.from('"statusReason"')
const PLACEHOLDER = Buffer.from(':""')
const MAX_STRING_LENGTH = 512 * 1024 * 1024 - 24 // V8 单字符串最大字符数（0x1fffffe8 ≈ 512MiB；表达式写法规避 Codacy PMD InnaccurateNumericLiteral 误报）
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
// （原始未转义引号只会出现在字段位置，字符串值内不可能出现裸 "statusReason" 字节）
function statusReasonValueEnd (buf, idx) {
  const afterKey = skipWhitespace(buf, idx + KEY.length)
  if (buf[afterKey] !== 0x3a /* : */) return -1
  return stringEnd(buf, skipWhitespace(buf, afterKey + 1))
}

// 追加 [pos, idx) 原文 + KEY + 空串占位（单次变参 push，S7778）
function appendWithPlaceholder (chunks, buf, pos, idx) {
  chunks.push(buf.subarray(pos, idx), KEY, PLACEHOLDER)
}

function readReportJson (reportPath) {
  // eslint-disable-next-line
  // nosemgrep: 工具脚本按 CLI 传入路径读取报告，路径非用户净输入
  // Codacy MEDIUM：path.resolve() 防御性 normalize（公开 API，不假设上游已校验）
  const abs = path.resolve(reportPath)
  const buf = fs.readFileSync(abs) // Buffer 读取，绕开字符串长度上限
  const chunks = []
  let pos = 0
  let idx = buf.indexOf(KEY, pos)
  while (idx !== -1) {
    const valueEnd = statusReasonValueEnd(buf, idx)
    if (valueEnd === -1) {
      chunks.push(buf.subarray(pos, idx + KEY.length)) // 非该字段（如 statusReason2）：KEY 原文保留
      pos = idx + KEY.length
    } else {
      appendWithPlaceholder(chunks, buf, pos, idx)
      pos = valueEnd
    }
    idx = buf.indexOf(KEY, pos)
  }
  chunks.push(buf.subarray(pos))
  const stripped = Buffer.concat(chunks)
  // 剥离后仍超上限：快速失败并给出可行动报错（V8 原生异常不含文件上下文）
  if (stripped.length > MAX_STRING_LENGTH) {
    throw new Error(`JSON 剥离 statusReason 后仍为 ${stripped.length} 字节，超过 V8 字符串上限 ${MAX_STRING_LENGTH}：${abs}`)
  }
  try {
    return JSON.parse(stripped.toString('utf8'))
  } catch (err) {
    // 带上文件路径与剥离前后尺寸，便于定位（报告文件损坏时原始异常不含上下文）
    throw new Error(`解析 ${abs} 失败（原始 ${buf.length} 字节，剥离后 ${stripped.length} 字节）：${err.message}`)
  }
}

module.exports = { readReportJson }
