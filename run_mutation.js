'use strict'

// 自动变异测试调度器：生成变异点 → 批量并行执行 → 失败批次递归二分 → 单点复验。
// 默认只修改临时副本，不触碰当前工作区。
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const ROOT = __dirname
const DEFAULT_FILES = [
  'xbk_function_v3.js', 'xbk_agents.js', 'xbk_http.js',
  'xbk_sendNotify_slim.js', 'xbk_storage.js', 'xbk_loop.js',
  'xbk_failure_policy.js',
  'qinglong/xbk_push.js'
]
// 变异测试使用全量单元测试入口（26 个单元套件），而非仅 test_filter.js——
// 此前只跑 test_filter.js 导致 #100/#101 新增的 1400+ 行测试对变异分数完全无效。
const DEFAULT_TEST = ['node', 'run_unit_tests.js']
const OPS = new Map([
  ['===', ['!==']], ['!==', ['===']], ['==', ['!=']], ['!=', ['==']],
  ['&&', ['||']], ['||', ['&&']],
  ['<=', ['<', '>']], ['>=', ['>', '<']], ['<', ['<=', '>']], ['>', ['>=', '<']],
  ['true', ['false']], ['false', ['true']]
])

function lineColumn (source, offset) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const last = before.lastIndexOf('\n')
  return { line, column: offset - (last < 0 ? 0 : last + 1) }
}

function isIdentStart (ch) { return /[A-Za-z_$]/.test(ch || '') }
function isIdentPart (ch) { return /[A-Za-z0-9_$]/.test(ch || '') }

// 轻量 JS 词法扫描：只在代码区生成条件/逻辑变异，跳过注释、字符串和模板文本。
function generateMutants (file, source) {
  const out = []
  let i = 0
  let state = 'code'
  let quote = ''
  const add = (start, end, original, replacement, kind) => {
    const lc = lineColumn(source, start)
    out.push({ file, start, end, original, replacement, kind, line: lc.line, column: lc.column })
  }
  while (i < source.length) {
    const c = source[i]
    const n = source[i + 1]
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2 } else i++; continue }
    if (quote) { if (c === '\\') i += 2; else if (c === quote) { quote = ''; i++ } else i++; continue }
    if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
    if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue }
    let matched = false
    for (const [op, replacements] of OPS) {
      if (source.startsWith(op, i)) {
        for (const replacement of replacements) add(i, i + op.length, op, replacement, 'operator')
        i += op.length; matched = true; break
      }
    }
    if (matched) continue
    if (isIdentStart(c)) {
      let j = i + 1
      while (isIdentPart(source[j])) j++
      const word = source.slice(i, j)
      if (OPS.has(word)) for (const replacement of OPS.get(word)) add(i, j, word, replacement, 'boolean')
      i = j; continue
    }
    i++
  }
  return out
}

function collectMutants (files) {
  const all = []
  for (const file of files) {
    const full = path.join(ROOT, file)
    const source = fs.readFileSync(full, 'utf8')
    for (const mutant of generateMutants(file, source)) all.push(mutant)
  }
  return all.map((m, index) => ({ ...m, id: index + 1 }))
}

function copyProject (dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  // 变异测试运行 run_unit_tests.js（全量单元测试入口），需复制其依赖的全部文件：
  //   - 测试入口与套件清单：run_unit_tests.js / test_suites.js
  //   - 所有 test_*.js（单元测试会 require 对应 xbk_*.js 源文件）
  //   - 所有 xbk_*.js 生产源文件（测试依赖；变异目标 files 也在其中）
  //   - run_mutation.js 自身（test_filter.js / test_run_mutation*.js 等单元套件顶层 require 它）
  //   - package.json（版本一致性用例读取）
  //   - CHANGELOG.md（test_filter.js 的“文件头版本 ↔ CHANGELOG 最新”用例会 readFileSync 它）
  //   - scripts/ 与 qinglong/ 目录（部分测试依赖）
  // 此前只复制 test_filter.js 但运行 run_unit_tests.js，导致临时目录 MODULE_NOT_FOUND，
  // evaluate 恒返回 fail，行为断言无法建立（#15 根因）。
  // 注：漏拷 CHANGELOG.md 会使 test_filter.js 版本一致性用例 ENOENT → 同样令 evaluate 恒 fail，
  // 故“测试会读取的项目根文件”须逐一纳入，切勿遗漏。
  const entries = fs.readdirSync(ROOT)
  const testFiles = entries.filter(f => /^test_.*\.js$/.test(f))
  const srcFiles = entries.filter(f => /^xbk_.*\.js$/.test(f))
  const extraTop = ['run_unit_tests.js', 'test_suites.js', 'run_tests.js', 'run_mutation.js', 'package.json', 'CHANGELOG.md']
  // 固定清单（extraTop + 调用方传入的 files，如 DEFAULT_FILES）属必选：缺失须响亮报错，不能静默 continue——
  // 漏拷文件会留下沙箱 MODULE_NOT_FOUND/ENOENT → evaluate 恒 fail 的不响亮回归（#120/#122 一类根因）。
  // 动态清单（testFiles/srcFiles 来自 readdirSync，必已存在）保持 continue 兜底；目录整体复制（scripts/qinglong/.github）是可选复制，语义不变。
  const required = new Set([...extraTop, ...files])
  for (const name of [...required, ...testFiles, ...srcFiles]) {
    // 信任边界防护：拒绝目录穿越/绝对路径，确保只复制 ROOT 内文件
    if (name.includes('..') || path.isAbsolute(name)) throw new Error(`copyProject 拒绝越界路径: ${name}`)
    const src = path.join(ROOT, name)
    if (!fs.existsSync(src)) {
      if (required.has(name)) throw new Error(`copyProject 缺少必要文件: ${name}`)
      continue
    }
    const dst = path.join(dir, name)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  // 目录整体复制：scripts/ 与 qinglong/ 是部分测试的依赖；.github/ 是 CI 清单
  // （test_ci_skip_suites.js 要读 test.yml 与 mutation.yml 对账，缺一个就 ENOENT 误判失败，同 #120/#122 口径）
  for (const sub of ['scripts', 'qinglong', '.github']) {
    const srcDir = path.join(ROOT, sub)
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(dir, sub), { recursive: true })
    }
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
}

function applyMutants (dir, mutants) {
  const grouped = new Map()
  for (const m of mutants) {
    if (!grouped.has(m.file)) grouped.set(m.file, [])
    grouped.get(m.file).push(m)
  }
  for (const [file, list] of grouped) {
    const full = path.join(dir, file)
    let source = fs.readFileSync(full, 'utf8')
    for (const m of [...list].sort((a, b) => b.start - a.start)) {
      source = source.slice(0, m.start) + m.replacement + source.slice(m.end)
    }
    fs.writeFileSync(full, source, 'utf8')
  }
}

function runTests (dir, timeoutMs) {
  return new Promise(resolve => {
    // 变异评估必须跑全量套件 —— 清除 SKIP_SUITES，防止 CI 显式步骤的跳过清单继承到子进程使变异分数失真。
    const child = spawn(DEFAULT_TEST[0], DEFAULT_TEST.slice(1), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XBK_MUTATION_CHILD: '1', SKIP_SUITES: '' } })
    let output = ''
    // 超时竞态修复：此前 setTimeout 回调里 kill 后立即 resolve，但此时 close 尚未触发、closeSignal 必为 null，
    // 且 stdout/stderr 还在继续排空——resolve 时既拿不到真实 signal（竞态），也拿不到最终完整 output，
    // 后续 close 回调的 resolve 因 Promise 已 resolve 被忽略（#131 qodo #3）。现改为：超时分支只标记 timedOut
    // 并 kill，真正的 resolve 一律收敛到 close 回调（close 时信号/输出已定稿），再叠加一个兜底保险定时器
    // 防止 kill 后 close 永不触发（异常文件描述符/僵尸进程）导致 Promise 悬空。
    let timedOut = false
    let falloutTimer = null
    child.stdout.on('data', d => { output += d })
    child.stderr.on('data', d => { output += d })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // 兜底保险：kill 后若 close 迟迟不触发（极端情况），仍要 resolve 不让 Promise 悬空——
      // 用当前已 collect 的输出，signal 回退 'SIGKILL'（真实 close signal 已无从得知）。
      // 正常 kill 会在毫秒级触发 close，此保险不会与 close 的 resolve 竞争（timedOut 已置位，
      // 谁先 resolve 都会走 timeout 形态且结果一致）。
      falloutTimer = setTimeout(() => {
        resolve({ status: 'timeout', code: null, signal: 'SIGKILL', output, summary: extractTestSummary(output) })
      }, 2000)
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (falloutTimer) clearTimeout(falloutTimer)
      if (timedOut) {
        // 已标记超时：契约固定返回 timeout 形态（code: null），signal 用 close 收到的真实值——
        // 子进程被 SIGKILL 杀死时此地拿到 'SIGKILL'；若 kill 前已自然退出则拿到 null（带真实 code），
        // 但既然标记了 timedOut，约定仍返回 timeout 形态，signal 用 signal || 'SIGKILL' 兜底。
        resolve({ status: 'timeout', code: null, signal: signal || 'SIGKILL', output, summary: extractTestSummary(output) })
      } else {
        // 正常路径：按退出码判定 pass/fail（与修复前一致）
        resolve({ status: code === 0 ? 'pass' : 'fail', code, signal, output, summary: extractTestSummary(output) })
      }
    })
  })
}

// 提取测试汇总数字："全部通过！N/M" 或 "N 通过, M 失败, 共 K"
// S8786：数字组后接空白量词（\d+\s*）会被标超线性回溯，改用纯线性扫描。
// CodeAnt 审查：indexOf 取全文首个关键字会被无关日志（如测试名「…全部通过」）干扰；
// 汇总行位于输出末尾——从末行向上逐行匹配「全部通过！N/M」或「通过/失败/共」三数字齐全
// 的行；CodeAnt 复审：「全部通过」正则原先在行扫描前全文匹配，会被更早的无关「全部通过！1/1」
// 日志抢答——现与关键字检查同属逐行扫描，噪声日志不影响。
function extractTestSummary (output) {
  const lines = output.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const all = /全部通过！(\d+)\/(\d+)/.exec(lines[i])
    if (all) return [all[1], all[2]]
    const triple = lineTriple(lines[i])
    if (triple) return triple
  }
  return []
}

// 单行内找「K 通过, M 失败, 共 N」：取最后一个「共 N」，再向左取最近的「M 失败」「K 通过」。
// CodeAnt 复审：同一行前置无关「通过/失败/共」文本（如「检查通过：…」「之前失败 0」）不得抢答。
function lineTriple (s) {
  let total = null
  let totalPos = -1
  for (let i = 0; (i = s.indexOf('共', i)) !== -1; i += 1) {
    const n = numberAfter(s, i, 1)
    if (n !== null) {
      total = n
      totalPos = i
    }
  }
  if (total === null) return null
  let fail = null
  let failPos = -1
  for (let i = 0; (i = s.indexOf('失败', i)) !== -1 && i < totalPos; i += 1) {
    const n = numberBefore(s, i)
    if (n !== null) {
      fail = n
      failPos = i
    }
  }
  if (fail === null) return null
  let pass = null
  for (let i = 0; (i = s.indexOf('通过', i)) !== -1 && i < failPos; i += 1) {
    const n = numberBefore(s, i)
    if (n !== null) pass = n
  }
  if (pass === null) return null
  return [pass, fail, total]
}

// 关键字起点 idx 前紧邻的整数字符串（允许空白间隔），找不到返回 null
function numberBefore (s, idx) {
  let end = idx
  while (end > 0 && /\s/.test(s[end - 1])) end--
  let start = end
  while (start > 0 && s[start - 1] >= '0' && s[start - 1] <= '9') start--
  return start < end ? s.slice(start, end) : null
}

// 关键字终点（idx + kwLen）后紧邻的整数字符串（允许空白间隔），找不到返回 null
function numberAfter (s, idx, kwLen) {
  let start = idx + kwLen
  while (start < s.length && /\s/.test(s[start])) start++
  let end = start
  while (end < s.length && s[end] >= '0' && s[end] <= '9') end++
  return start < end ? s.slice(start, end) : null
}

async function evaluate (mutants, files, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mutant-'))
  try {
    copyProject(dir, files)
    applyMutants(dir, mutants)
    const result = await runTests(dir, timeoutMs)
    return { ...result, mutants: mutants.map(m => m.id) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function mapLimit (items, limit, fn) {
  const results = []
  let cursor = 0
  async function worker () {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function saveCheckpoint (file, state) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function loadCheckpoint (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

async function main () {
  const batchSize = Number(process.env.MUTATION_BATCH || 50)
  const concurrency = Number(process.env.MUTATION_CONCURRENCY || Math.max(1, Math.min(os.cpus().length, 8)))
  const timeoutMs = Number(process.env.MUTATION_TIMEOUT || 90000)
  const checkpointFile = process.env.MUTATION_CHECKPOINT || path.join(ROOT, 'mutation-progress.json')
  const files = DEFAULT_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))
  const mutants = collectMutants(files)
  const byId = new Map(mutants.map(m => [m.id, m]))
  const old = loadCheckpoint(checkpointFile)
  const killed = new Map((old && old.killed) || [])
  const survived = new Map((old && old.survived) || [])
  const compileErrors = new Map((old && old.compileErrors) || [])
  const resolved = new Set([...killed.keys(), ...survived.keys(), ...compileErrors.keys()].map(Number))
  const allBatches = []
  for (let i = 0; i < mutants.length; i += batchSize) allBatches.push(mutants.slice(i, i + batchSize))
  const pending = old && Array.isArray(old.pending)
    ? old.pending.map(ids => ids.map(Number).map(id => byId.get(id)).filter(Boolean)).filter(b => b.length)
    : allBatches
  for (let i = pending.length - 1; i >= 0; i--) {
    pending[i] = pending[i].filter(m => !resolved.has(m.id))
    if (!pending[i].length) pending.splice(i, 1)
  }
  console.log(`变异点：${mutants.length} 个；批次：${batchSize}；并发：${concurrency}；待判定：${mutants.length - resolved.size}`)
  const persist = () => saveCheckpoint(checkpointFile, {
    total: mutants.length,
    batchSize,
    killed: [...killed.entries()],
    survived: [...survived.entries()],
    compileErrors: [...compileErrors.entries()],
    pending: pending.map(batch => batch.map(m => m.id))
  })
  persist()
  while (pending.length) {
    const round = pending.splice(0, concurrency)
    const results = await mapLimit(round, concurrency, batch => evaluate(batch, files, timeoutMs))
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const batch = round[i]
      if (result.status === 'pass') {
        for (const m of batch) survived.set(m.id, { status: 'survived', batch: batch.map(x => x.id) })
        continue
      }
      if (batch.length === 1) {
        const id = batch[0].id
        const status = result.status === 'timeout' ? 'timeout' : 'killed';
        (status === 'timeout' ? compileErrors : killed).set(id, { status, summary: result.summary || [] })
        console.log(`单点 ${id}: ${status}`)
        continue
      }
      const mid = Math.ceil(batch.length / 2)
      pending.push(batch.slice(0, mid), batch.slice(mid))
    }
    persist()
    console.log(`进度：已判定 ${killed.size + survived.size + compileErrors.size}/${mutants.length}，待拆分 ${pending.length}`)
  }
  const report = {
    total: mutants.length,
    killed: killed.size,
    survived: survived.size,
    timeout: compileErrors.size,
    mutants: mutants.map(m => ({ ...m, result: killed.get(m.id) || survived.get(m.id) || compileErrors.get(m.id) || { status: 'pending' } }))
  }
  const reportFile = path.join(ROOT, 'mutation-report.json')
  saveCheckpoint(reportFile, report)
  try { fs.unlinkSync(checkpointFile) } catch (e) { /* 完成后没有断点文件也不影响报告 */ }
  console.log(`完成：total=${report.total} killed=${report.killed} survived=${report.survived} timeout=${report.timeout}`)
  process.exitCode = report.survived || report.timeout ? 1 : 0
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
module.exports = { generateMutants, collectMutants, extractTestSummary, lineColumn, isIdentStart, isIdentPart, lineTriple, numberBefore, numberAfter, mapLimit, saveCheckpoint, loadCheckpoint, copyProject, applyMutants, runTests, evaluate }
