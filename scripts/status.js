'use strict'

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  run: 'run.log',
  report: 'report.state',
  channels: 'channel-health.state',
  diagnostics: 'filter-diagnostics.ndjson'
}

function result (status, value) {
  return { status, ...(value === undefined ? {} : { value }) }
}

function readText (dir, name, maxBytes = 1024 * 1024) {
  const file = path.join(dir, name)
  let fd = -1
  try {
    // 打开后再 fstat，避免 lstat/readFile 两步之间被替换成符号链接或设备文件。
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    fd = fs.openSync(file, flags)
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return result('unsafe')
    if (st.size > maxBytes) return result('tooLarge')
    return result('ok', fs.readFileSync(fd, 'utf8'))
  } catch (error) {
    return result(error && error.code === 'ENOENT' ? 'missing' : 'ioError')
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd) } catch (error) { /* 只读诊断，关闭失败不影响调用方 */ }
    }
  }
}

function parseJson (read) {
  if (read.status !== 'ok') return { status: read.status }
  try {
    const value = JSON.parse(read.value)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? result('ok', value)
      : result('invalid')
  } catch (error) { return result('invalid') }
}

function parseLastRun (read) {
  if (read.status !== 'ok') return { status: read.status }
  const lines = read.value.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /total=(\d+) dedup=(\d+) filtered=(\d+) truncated=(\d+) pushed=(\d+) failed=(\d+) elapsed=([^\s]+)/.exec(lines[i])
    if (match) return result('ok', { total: Number(match[1]), dedup: Number(match[2]), filtered: Number(match[3]), truncated: Number(match[4]), pushed: Number(match[5]), failed: Number(match[6]), elapsed: match[7] })
  }
  return result('invalid')
}

function parseDiagnostics (read) {
  if (read.status !== 'ok') return { status: read.status }
  const lines = read.value.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i])
      if (value && value.type === 'run') return result('ok', value)
    } catch (error) { /* 忽略单条损坏记录，继续查找最近完整汇总 */ }
  }
  return result('invalid')
}

function readStatus (dir, { now = Date.now() } = {}) {
  const report = parseJson(readText(dir, FILES.report, 64 * 1024))
  const channels = parseJson(readText(dir, FILES.channels, 64 * 1024))
  const run = parseLastRun(readText(dir, FILES.run))
  const diagnostics = parseDiagnostics(readText(dir, FILES.diagnostics))
  return { generatedAt: now, report, channels, run, diagnostics }
}

function describe (part) {
  return part.status === 'missing' ? '缺失' : part.status === 'ok' ? '正常' : `不可读（${part.status}）`
}

function formatStatus (status) {
  const lines = [`📊 xbk-push 运行状态（${new Date(status.generatedAt).toISOString()}）`]
  const report = status.report.value
  lines.push(`日报：${describe(status.report)}${report ? ` | ${report.date || '无日期'} | ${report.runs || 0} 轮 | 推送成功：${report.pushed || 0} 条 | 失败：${report.failed || 0} 条` : ''}`)
  const run = status.run.value
  lines.push(`最近一轮：${describe(status.run)}${run ? ` | 获取 ${run.total} | 去重 ${run.dedup} | 过滤 ${run.filtered} | 推送 ${run.pushed} | 失败 ${run.failed}` : ''}`)
  const channels = status.channels.value
  if (channels) {
    const entries = Object.entries(channels).filter(([, value]) => value && typeof value === 'object')
    lines.push(`通道健康：${entries.length ? entries.map(([name, value]) => `${name}：连续失败 ${Number(value.consecutiveFailures) || 0} 次`).join('；') : '暂无记录'}`)
  } else lines.push(`通道健康：${describe(status.channels)}`)
  const diagnostics = status.diagnostics.value
  lines.push(`过滤诊断：${describe(status.diagnostics)}${diagnostics ? ` | 最近 ${diagnostics.date || '未知'} | 原因：${Object.entries(diagnostics.byReason || {}).map(([key, value]) => `${key}=${value}`).join('，') || '无'}` : ''}`)
  return lines.join('\n')
}

module.exports = { readStatus, formatStatus }
