'use strict'
// 变异报告 fail-closed 守卫（mutation.yml 的「变异报告 fail-closed 守卫」step 调用；stryker step 之后、上传
// artifact 之前）。它替代已撤回的「分数门禁」（stryker.config.js 的 thresholds.break 改回 null）承担**恒常**判据。
//
// 为什么需要它（stryker 的分数门禁**不会**在这一类故障上置退出码）：
//   * mutation-testing-metrics 的 calculateMetrics.js：
//       const DEFAULT_SCORE = NaN;
//       mutationScore: totalValid > 0 ? (totalDetected / totalValid) * 100 : DEFAULT_SCORE,   // totalValid = killed + timeout + survived + noCoverage
//   * @stryker-mutator/core 的 mutation-test-report-helper.js determineExitCode()：
//       if (typeof breaking === 'number') { if (mutationScore < breaking) setExitCode(1) }
//     即分数门禁的判据是**严格 `<`**：当 totalValid === 0（整段全 RuntimeError / 全 CompileError / 空报告）
//     时 mutationScore 为 NaN，而 `NaN < 65 === false` ⇒ 不置退出码 ⇒ **job 假绿**。
//     （break = null 之后这条通道本身不再能造成假绿，但「全 RuntimeError / 空报告」仍是必须响的故障信号，
//      而且将来重新标定 break 时本守卫是分数门禁的前置条件。）
//
// 判据（任一命中即 exit 1）：
//   ① 某段报告的 runtimeErrors > 0 —— status 为 RuntimeError 的变异体数（测试自身崩溃导致的「没能判定」，
//      既不算已检出也不算存活，出现即说明本轮测试环境有问题）；
//   ② 某段报告的 totalValid === 0 —— 与 stryker 口径逐字一致（killed + timeout + survived + noCoverage）；
//   ③ 报告缺失或不可读 —— fail-closed：守卫失去判定输入时拒绝放行。**注意这与「worker 未产出报告」的缺段
//      判据不是同一回事**：缺段由汇总 job 的 scripts/mutation-report.js validateSegments 负责，本守卫只管
//      「守卫自己判不了」。两者文案分开，避免排障时把「守卫读不到文件」误读成「上游没产出」。
//   ④ 报告存在但结构非法 —— 无法按 stryker 口径计数时同样 fail-closed（不许「算不出来就当通过」）。
//
// 读取与上限口径**全部复用** scripts/mutation-json.js 的 readReportJson / resolveMaxReportBytes：不另写一份
// 读取/剥离/大小上限逻辑，避免护栏漂移（该文件的 statusReason 剥离与「非普通文件拒绝 / 预读上限」是既有防线）。
// 状态名取自本仓已安装的 mutation-testing-report-schema 的 MutantStatus enum
//   * node_modules/mutation-testing-report-schema/dist/src/mutation-testing-report-schema.json 的
//     files.*.mutants.items.status（enum）
//   * node_modules/mutation-testing-report-schema/dist/src-generated/schema.d.ts 的 `export type MutantStatus = ...`
// 与 scripts/mutation-report.js 的 MUTANT_STATUSES 同源同集合——收窄成 countMutant 计数的 4 个会把正常报告整段拒掉。
const path = require('node:path')
const { readReportJson, resolveMaxReportBytes } = require('./mutation-json.js')

// 与 mutation-testing-report-schema 的 MutantStatus enum 逐字一致（8 个）
const MUTANT_STATUSES = new Set([
  'Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored', 'Pending'
])

function describe (v) {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
}

// 按 stryker 的 countFileMetrics/toMetrics 口径统计（状态 → 计数），并给出 totalValid。
// 结构非法一律 throw（调用侧记为该报告的一条 fail-closed 失败），绝不返回「全 0」——那会把损坏报告洗成合法输入。
function countMutantsByStatus (report) {
  const counts = {
    killed: 0,
    timeout: 0,
    survived: 0,
    noCoverage: 0,
    runtimeErrors: 0,
    compileErrors: 0,
    ignored: 0,
    pending: 0,
    total: 0
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error(`报告顶层结构非法（${describe(report)}），无法读取 files`)
  }
  const files = report.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(`报告缺少 files 映射（实际 ${describe(files)}），疑似非 stryker 报告`)
  }
  for (const [fileKey, file] of Object.entries(files)) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error(`files["${fileKey}"] 结构非法（${describe(file)}）`)
    }
    if (!Array.isArray(file.mutants)) {
      throw new Error(`files["${fileKey}"].mutants 缺失或非数组`)
    }
    for (const m of file.mutants) {
      const status = m && typeof m === 'object' && !Array.isArray(m) ? m.status : undefined
      if (!MUTANT_STATUSES.has(status)) {
        throw new Error(`files["${fileKey}"].mutants 含缺失或未知 status 的条目（status=${JSON.stringify(status)}）`)
      }
      counts.total++
      switch (status) {
        case 'Killed': counts.killed++; break
        case 'Timeout': counts.timeout++; break
        case 'Survived': counts.survived++; break
        case 'NoCoverage': counts.noCoverage++; break
        case 'RuntimeError': counts.runtimeErrors++; break
        case 'CompileError': counts.compileErrors++; break
        case 'Ignored': counts.ignored++; break
        case 'Pending': counts.pending++; break
      }
    }
  }
  // 与 stryker 的 toMetrics 逐字一致：totalValid = totalUndetected + totalDetected = (survived + noCoverage) + (timeout + killed)
  counts.totalValid = counts.killed + counts.timeout + counts.survived + counts.noCoverage
  counts.totalInvalid = counts.runtimeErrors + counts.compileErrors
  return counts
}

// 计数摘要（诊断输出：各状态计数，便于直接定位）
function formatCounts (c) {
  return `killed=${c.killed} timeout=${c.timeout} survived=${c.survived} noCoverage=${c.noCoverage} ` +
    `runtimeErrors=${c.runtimeErrors} compileErrors=${c.compileErrors} ignored=${c.ignored} pending=${c.pending} ` +
    `totalValid=${c.totalValid} total=${c.total}`
}

function parseArgs (argv) {
  const paths = []
  let segment = null
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--segment' || a === '--label') {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} 缺少取值`)
      segment = String(v)
      i++
    } else if (a.startsWith('--segment=')) {
      segment = a.slice('--segment='.length)
    } else if (a === '--') {
      for (let j = i + 1; j < argv.length; j++) paths.push(String(argv[j]))
      break
    } else if (a.startsWith('-') && a !== '-') {
      // 参数不明时静默忽略会让「--segmnt storage」这类笔误把守卫变异成空转（无路径 ⇒ 无判据）。
      throw new Error(`未知参数 ${a}（fail-closed：参数不明时拒绝静默放行）`)
    } else {
      paths.push(a)
    }
  }
  if (segment !== null && segment.trim() === '') segment = null
  return { paths, segment }
}

/**
 * 对一份或多份报告求值（纯判定，不做退出码/输出）。
 *
 * @param {string[]} reportPaths stryker mutation.json 路径（CI 传 reports/mutation/mutation.json）
 * @param {{segment?: string, env?: Record<string,string|undefined>, maxFileBytes?: number}} [options]
 *   env 默认 process.env：只用于取 XBK_MUTATION_REPORT_MAX_BYTES（与 mutation-report.js / analyze-artifacts.js 同源口径）。
 * @returns {{ok: boolean, reports: object[], failures: object[]}} failures 为空即 ok
 */
function evaluateReports (reportPaths, options = {}) {
  const env = options.env || process.env
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? options.maxFileBytes
    : resolveMaxReportBytes(env.XBK_MUTATION_REPORT_MAX_BYTES) // 复用同一份上限解析，不另写
  const reports = []
  const failures = []
  for (const reportPath of reportPaths) {
    const label = options.segment || path.basename(reportPath)
    let report
    try {
      // 复用 scripts/mutation-json.js 的读取护栏（非普通文件拒绝 / 预读上限 / statusReason 剥离后再解析）
      report = readReportJson(reportPath, { maxFileBytes })
    } catch (err) {
      failures.push({ kind: 'unreadable', label, reportPath, message: String((err && err.message) || err) })
      continue
    }
    let counts
    try {
      counts = countMutantsByStatus(report)
    } catch (err) {
      failures.push({ kind: 'malformed', label, reportPath, message: String((err && err.message) || err) })
      continue
    }
    reports.push({ label, reportPath, counts })
    if (counts.runtimeErrors > 0) failures.push({ kind: 'runtimeErrors', label, reportPath, counts })
    if (counts.totalValid === 0) failures.push({ kind: 'noValidMutants', label, reportPath, counts })
  }
  return { ok: failures.length === 0, reports, failures }
}

function describeFailure (f) {
  const head = `❌ [${f.label}] 守卫未通过：`
  switch (f.kind) {
    case 'unreadable':
      return [
        head + '报告缺失或不可读 —— fail-closed：守卫拿不到判定输入时拒绝放行。',
        '   与「worker 未产出报告」的缺段判据**不是同一回事**：缺段由汇总 job 的 scripts/mutation-report.js',
        '   validateSegments 负责；本守卫只负责「自己判不了」这一种情形，故文案分开。',
        `   路径：${f.reportPath}`,
        `   原因：${f.message}`
      ].join('\n')
    case 'malformed':
      return [
        head + '报告结构非法（无法按 stryker 口径计数）—— fail-closed：算不出来按不通过处理，不许当通过。',
        `   路径：${f.reportPath}`,
        `   原因：${f.message}`
      ].join('\n')
    case 'runtimeErrors':
      return [
        head + `${f.counts.runtimeErrors} 个变异体 status = RuntimeError。`,
        '   RuntimeError 是「测试自身崩溃导致没能判定」，既不算已检出、也不算存活；出现即说明本轮测试环境有问题，',
        '   不能因为「分数看起来还过得去」就放行（stryker 的分数门禁在 totalValid > 0 时也不会因 RuntimeError 变红）。',
        `   计数：${formatCounts(f.counts)}`,
        `   路径：${f.reportPath}`
      ].join('\n')
    case 'noValidMutants':
      return [
        head + 'totalValid = killed + timeout + survived + noCoverage = 0。',
        '   此时 stryker 的 mutationScore 为 NaN（mutation-testing-metrics 的 DEFAULT_SCORE = NaN），而分数门禁判据',
        '   `NaN < break === false` ⇒ 不置退出码 ⇒ job 假绿。本守卫在此显式置退出码 1。',
        f.counts.total === 0
          ? '   报告不含任何变异体（files 为空映射，或各文件 mutants 均为空数组）。'
          : `   报告有 ${f.counts.total} 个变异体，但全部落在 RuntimeError/CompileError/Ignored/Pending 里（无有效变异体）。`,
        `   计数：${formatCounts(f.counts)}`,
        `   路径：${f.reportPath}`
      ].join('\n')
    default:
      return head + `未知失败类型 ${f.kind}（fail-closed）`
  }
}

/**
 * CLI 入口（可注入 io 以便测试拿到退出码与输出，不真的结束进程）。
 * @returns {number} 退出码：0 = 全部通过；1 = 任一判据命中 / 参数非法 / 未给报告路径
 */
function run (argv, io = {}) {
  const out = io.stdout || process.stdout
  const err = io.stderr || process.stderr
  const env = io.env || process.env
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    err.write(`❌ 守卫参数非法：${String((e && e.message) || e)}\n`)
    err.write('   用法：node scripts/mutation-guard.js [--segment <段名>] <mutation.json> [更多报告...]\n')
    return 1
  }
  if (parsed.paths.length === 0) {
    // 没有报告路径就没有判据：静默 exit 0 等于「守卫不存在」，同样 fail-closed
    err.write('❌ 守卫未通过：没有给出任何报告路径 ⇒ 无判据可判，按 fail-closed 置退出码 1。\n')
    err.write('   用法：node scripts/mutation-guard.js [--segment <段名>] <mutation.json> [更多报告...]\n')
    return 1
  }
  const { ok, reports, failures } = evaluateReports(parsed.paths, { segment: parsed.segment, env })
  // 有失败的报告不能打成 ✅（否则「上面一行绿、下面明细红」自相矛盾）；失败的报告计数也走 stderr。
  const failedReports = new Set(failures.map(x => x.reportPath))
  for (const r of reports) {
    if (failedReports.has(r.reportPath)) {
      err.write(`❌ [${r.label}] 计数：${formatCounts(r.counts)}\n   报告：${r.reportPath}\n`)
    } else {
      out.write(`✅ [${r.label}] 守卫通过：${formatCounts(r.counts)}\n   报告：${r.reportPath}\n`)
    }
  }
  if (ok) {
    out.write(`✅ 变异报告 fail-closed 守卫全部通过（${reports.length} 份报告，退出码 0）\n`)
    return 0
  }
  for (const f of failures) err.write(describeFailure(f) + '\n')
  err.write(`❌ 变异报告 fail-closed 守卫未通过（${failures.length} 项判据命中，退出码 1）\n`)
  return 1
}

module.exports = { countMutantsByStatus, evaluateReports, formatCounts, parseArgs, run, MUTANT_STATUSES }

// CLI：用 process.exitCode 而非 process.exit()，让 stdout/stderr 正常 flush（stryker 的报告可能很长）。
if (require.main === module) {
  process.exitCode = run(process.argv.slice(2))
}
