// 变异测试日报汇总：解析各段 stryker mutation-report.json → 汇总 → 发 GitHub Issue
// 用法：node scripts/mutation-report.js <reports-dir> [--issue]
//   <reports-dir>：包含 mutation-report-* 子目录的目录（各子目录内有 mutation-report.json）
//   --issue：发 GitHub Issue（需 GITHUB_TOKEN 环境变量）；不带则只打印汇总
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { readReportJson, writeStrippedReport, resolveMaxReportBytes } = require('./mutation-json.js')

// 必须与 mutation.yml 的矩阵名称保持一致；缺段时禁止把部分结果伪装成完整日报。
const EXPECTED_SEGMENTS = Object.freeze([
  'v3-entry', 'app', 'filter', 'formatter', 'message-store', 'network', 'pusher', 'rules', 'utils',
  'sendnotify-part1', 'sendnotify-part2',
  'failure-policy', 'storage', 'agents', 'http', 'loop', 'qinglong-push', 'check-deps', 'status'
])

// stryker 报告的合法变异状态——权威来源是本仓已安装的 mutation-testing-report-schema 里
// MutantStatus 的 enum。countMutant 只对其中 4 个计数，其余 4 个（CompileError/RuntimeError/
// Ignored/Pending）只计入 total；校验必须按这个全集来，收窄成计数的 4 个会把正常报告整段拒掉。
const MUTANT_STATUSES = new Set([
  'Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored', 'Pending'
])

// F7：去重列表查询的整体超时（毫秒）——列表 API 只回答「当天是否已发过」，挂住不能拖死整个日报 job。
const LIST_QUERY_TIMEOUT_MS = 15000

// F1：新鲜度闸门阈值（缓存回填检测）。修复前的参考基准只有「本批报告文件里最新的 mtime」：
//   * 同一次 CI 运行内各段 matrix job 并行执行，单 job 默认上限 6h，正常产出的 mtime 跨度不可能超过 6h；
//   * 段 job 崩溃/被 6h 取消时，actions/cache 恢复出来的上一次运行的 reports/mutation/mutation.json
//     被原样带进 artifact——其 mtime 与当日其它段相差 ≥12h（日报每日一轮）。
// 故默认 12h：远大于正常跨度、小于跨日缓存的陈旧跨度。可用 MUTATION_REPORT_MAX_SKEW_MS 覆盖
// （单位毫秒；`off` 或 ≤0 关闭该闸门；无法解析的值回落到默认值，不静默关闭闸门）。
// 返工（V4 打回）：只用「本批最新者」当基准会漏掉两种**回填同族**——全体回填（所有段 mtime 都很旧、
// 互差≈0）与跨轮同日回填（<12h、互差≈0）。故该阈值同时用作「相对现在的年龄上限」，并另加一层
// 以本轮 workflow 运行起点（MUTATION_RUN_STARTED_AT = github.run_started_at）为下界的判定。
const DEFAULT_MAX_SKEW_MS = 12 * 60 * 60 * 1000

// F1（返工）：本轮运行起点下界的容差——工件落盘/时钟分辨率的余量（CI 内各 job 同钟，无需大余量）。
const RUN_START_SLACK_MS = 5 * 60 * 1000

// 阈值解析是纯函数（不读环境变量 → 测试 hermetic）；调用点显式把环境变量传进来。
function resolveMaxSkewMs (raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_SKEW_MS
  if (String(raw).trim().toLowerCase() === 'off') return 0
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_MAX_SKEW_MS // 配置笔误不得把闸门静默关掉
  return n > 0 ? n : 0
}

// F1（返工）：解析本轮 workflow 的 run_started_at（mutation.yml 的 report 步骤注入
// MUTATION_RUN_STARTED_AT: ${{ github.run_started_at }}）。无法解析/未提供 → undefined（跳过该层，
// 不误红也不假绿；本地手工跑日报时该层自然不生效）。
function resolveRunStartedAtMs (raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const ms = Date.parse(String(raw).trim())
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * F1：陈旧（缓存回填）报告闸门（三层）。
 *
 * 「某段 stryker 崩溃/被取消 → artifact 里是上一次运行的 mutation.json」这一形态在**内容**上与正常
 * 报告无法区分（stryker 的 json reporter 不写任何时间戳，见 mutation-testing-report-schema 的顶层
 * properties：config/schemaVersion/files/testFiles/thresholds/projectRoot/performance/framework/system），
 * 因此只能看文件时间。三层判据（任一层命中即拒绝发布）：
 *   ① 跨段偏斜：与**本批最新报告**相差超过阈值 → 部分段回填（原有语义）；
 *   ② 年龄上限：与**现在**相差超过阈值 → 全体回填（所有段互差≈0 时 ① 看不见）；
 *   ③ 本轮起点下界：早于 run_started_at（减去容差）→ 同日跨轮回填（①②都看不见，例如全体 11h 前）。
 *
 * fail-open 边界（如实登记）：若 artifact 上传/下载不保留 mtime（各段 mtime 被归一为下载时间），
 * ①②③ 都不触发、也不会误红；该场景由 .github/workflows/mutation.yml 的「清理缓存回填的旧报告」步骤
 * 兜底（该步骤已加 `if: always()` 并前置到缓存恢复之后，见 mutation.yml）——崩溃段根本没有
 * mutation.json，走「缺 mutation-report.json」分支拒绝发布。
 *
 * @param {Array<{seg: string, error?: string, reportMtimeMs?: number}>} results 已分析的分段结果
 * @param {number} [maxSkewMs] 允许的最大跨段跨度/年龄（≤0 关闭闸门）；缺省读 `MUTATION_REPORT_MAX_SKEW_MS`
 * @param {number} [runStartedAtMs] 本轮运行起点（毫秒）；缺省读 `MUTATION_RUN_STARTED_AT`
 * @returns {Array<object>} 原始分段结果
 * @throws {Error} 存在明显陈旧的报告时抛出
 */
function validateFreshness (results, maxSkewMs = resolveMaxSkewMs(process.env.MUTATION_REPORT_MAX_SKEW_MS), runStartedAtMs = resolveRunStartedAtMs(process.env.MUTATION_RUN_STARTED_AT)) {
  if (!(maxSkewMs > 0)) return results
  const dated = results.filter(r => !r.error && Number.isFinite(r.reportMtimeMs))
  if (dated.length === 0) return results // 无可比较对象：交由 validateSegments 判定
  const hours = (ms) => Math.round((ms / 3600000) * 10) / 10
  // ① 跨段偏斜（原有语义，先判以保留「比最新报告早 N 小时」的定位口径）
  if (dated.length >= 2) {
    // 显式初始值 = 首元素（本分支已保证 dated.length >= 2）：reduce 无初始值时本就以首元素起算，
    // 故这与原写法逐元素等价，只是满足 SonarCloud S6959「reduce 必须给初始值」。
    const newest = dated.reduce((a, b) => (a.reportMtimeMs >= b.reportMtimeMs ? a : b), dated[0])
    const stale = dated.filter(r => newest.reportMtimeMs - r.reportMtimeMs > maxSkewMs)
    if (stale.length > 0) {
      const detail = stale
        .map(r => `${r.seg}（报告文件时间比最新报告早 ${hours(newest.reportMtimeMs - r.reportMtimeMs)} 小时）`)
        .join('；')
      throw new Error(`变异测试报告疑似缓存回填（陈旧）：${detail}；拒绝发布口径不符的日报`)
    }
  }
  // ② 年龄上限：全体回填时各段互差≈0，① 恒不命中；以 wall-clock 为基准的年龄才是判据
  const now = Date.now()
  const tooOld = dated.filter(r => now - r.reportMtimeMs > maxSkewMs)
  if (tooOld.length > 0) {
    const detail = tooOld
      .map(r => `${r.seg}（报告文件时间距今 ${hours(now - r.reportMtimeMs)} 小时）`)
      .join('；')
    throw new Error(`变异测试报告疑似缓存回填（全体陈旧，超出本轮最大跨度 ${hours(maxSkewMs)} 小时）：${detail}；拒绝发布口径不符的日报`)
  }
  // ③ 本轮起点下界：本批产物必须产自本轮 workflow（同一次运行内 matrix job 必然晚于 run_started_at）
  if (Number.isFinite(runStartedAtMs)) {
    const beforeRun = dated.filter(r => r.reportMtimeMs < runStartedAtMs - RUN_START_SLACK_MS)
    if (beforeRun.length > 0) {
      const detail = beforeRun
        .map(r => `${r.seg}（报告文件时间早于本轮运行起点 ${hours(runStartedAtMs - r.reportMtimeMs)} 小时）`)
        .join('；')
      throw new Error(`变异测试报告疑似缓存回填（早于本轮运行起点）：${detail}；拒绝发布口径不符的日报`)
    }
  }
  return results
}

function analyze (dir) {
  // S8707：CLI 参数显式校验（防 LLM/错误参数访问任意路径——先验证存在且是目录）
  let st
  try {
    st = fs.statSync(dir) // NOSONAR:S8707 校验调用本身（防错误 CLI 参数）
  } catch (e) {
    console.error(`❌ 报告目录不存在或不可访问：${dir}（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  if (!st.isDirectory()) {
    console.error(`❌ ${dir} 不是目录（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  const results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) // NOSONAR:S8707 报告目录处理（根目录已校验，工具合法用途）
  } catch (e) {
    // 入口目录不可读 = 调用错误：友好报错 + 干净退出（与单段错误隔离不同——入口失败全部失败）
    console.error(`❌ 无法读取报告目录 ${dir}：${e.message}（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mutation-report-')) continue
    results.push(analyzeSegment(dir, entry))
  }
  return results
}

/**
 * 验证变异测试报告是否包含全部预期分段且每段均可解析。
 * @param {Array<{seg: string, error?: string}>} results 已分析的分段结果
 * @param {string[]} [expected=EXPECTED_SEGMENTS] 预期分段名称
 * @returns {Array<{seg: string, error?: string}>} 原始分段结果
 * @throws {Error} 缺少分段或存在错误分段时抛出
 */
function validateSegments (results, expected = EXPECTED_SEGMENTS) {
  const actual = new Set(results.map(result => result.seg))
  const missing = expected.filter(seg => !actual.has(seg))
  if (missing.length > 0) {
    throw new Error(`变异测试报告缺少分段：${missing.join(', ')}；拒绝发布不完整日报`)
  }
  // F5：反向校验（对照 scripts/check-mutation-ranges.js 的 nameExtra 口径）——额外/陌生段目录
  // （残留 artifact、矩阵与 EXPECTED_SEGMENTS 漂移）不得静默并入合计，否则分数口径失真。
  const unexpected = [...actual].filter(seg => !expected.includes(seg))
  if (unexpected.length > 0) {
    throw new Error(`变异测试报告包含预期之外的分段：${unexpected.join(', ')}；拒绝发布口径不符的日报`)
  }
  // F5：重复分段检测——同一段被计两次会让合计静默翻倍。
  const segs = results.map(result => result.seg)
  const duplicated = [...new Set(segs.filter((seg, i) => segs.indexOf(seg) !== i))]
  if (duplicated.length > 0) {
    throw new Error(`变异测试报告分段重复：${duplicated.join(', ')}；拒绝发布重复计入的日报`)
  }
  const errored = results.filter(result => result.error)
  if (errored.length > 0) {
    // F2：逐段带上原因。只报段名时无法区分「缺报告」「报告损坏」与「报告内容非法（缓存回填）」，
    // 而 CI 日志里这条错误往往就是唯一线索——排查者据此才能判断要不要重跑该段。
    const detail = errored.map(result => `${result.seg}（${result.error}）`).join('；')
    throw new Error(`变异测试报告包含错误分段：${detail}；拒绝发布不完整日报`)
  }
  return results
}

// 递归查找 stryker 报告文件（文件名 mutation.json——json reporter 输出 reports/mutation/mutation.json；
// 兼容旧名 mutation-report.json；目录可能嵌套 reports/ 等层）
function findReportJson (dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) // NOSONAR:S8707 报告目录树内递归（根目录已校验）
  } catch (e) {
    // 目录不可读/不存在 → 跳过（与 analyzeSegment 的错误隔离设计一致，单段失败不中断整体）
    return null
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const found = findReportJson(p)
      if (found) return found
    } else if (e.name === 'mutation.json' || e.name === 'mutation-report.json') {
      return p
    }
  }
  return null
}

// 解析单个段的 mutation-report.json（复杂度拆分：analyze 保持线性遍历）
function analyzeSegment (dir, entry) {
  const seg = entry.name.replace('mutation-report-', '')
  const reportPath = findReportJson(path.join(dir, entry.name))
  if (!reportPath) return { seg, error: '缺 mutation-report.json' }
  const stats = { total: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0, survivedMutants: [] }
  // F4：解析与聚合同处 try 内——报告顶层为 null（JSON 字面量 null）/原始值时显式失败并走段级隔离，
  // 不抛 TypeError 逃出本函数（与上方注释「单段失败不中断整体」一致），也不把损坏报告伪装成
  // 0 变异体的正常段；错误补上报告路径便于定位。
  try {
    // F1（mutation-json 返工）：预读大小上限必须由**生产调用方**注入，否则护栏只在测试里成立
    // （独立验证 V3：默认 8 PiB + 零生产调用方注入 ⇒ 该分支生产恒假）。默认 2 GiB 的生产策略值
    // 由 resolveMaxReportBytes 给出，可用 XBK_MUTATION_REPORT_MAX_BYTES 覆盖。
    const report = readReportJson(reportPath, { maxFileBytes: resolveMaxReportBytes(process.env.XBK_MUTATION_REPORT_MAX_BYTES) })
    if (!report || typeof report !== 'object') {
      throw new Error(`报告顶层结构非法（${report === null ? 'null' : typeof report}），无法读取 files`)
    }
    // F2：段内容校验——「报告能解析」不等于「报告是本次运行的产出」。stryker 的 json reporter 必定
    // 写出 files 映射；files 缺失/非对象/为空只会让统计归 0、分数归 0，随后 render 走
    // 「🎉 无存活变异体！」并 exit 0——把「artifact 里是上一次的缓存回填 / 上游未产出」伪装成满分日报。
    // 这里逐层显式失败，错误进 validateSegments 的 errored 分支 → 拒绝发布不完整日报。
    const files = report.files
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      throw new Error(`报告缺少 files 映射（实际 ${files === null ? 'null' : Array.isArray(files) ? 'array' : typeof files}），疑似非本次运行的报告`)
    }
    for (const [fileKey, file] of Object.entries(files)) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw new Error(`files["${fileKey}"] 结构非法（${file === null ? 'null' : typeof file}）`)
      }
      if (!Array.isArray(file.mutants)) {
        throw new Error(`files["${fileKey}"].mutants 缺失或非数组`)
      }
      // CodeRabbit PR #151：只校验「是数组」不够。countMutant 先 total++ 再按状态分类，于是
      // `{}` / 缺 status 的条目会绕过上面的「零变异体」护栏——total 被抬高、哪个桶都计不进去，
      // 分数被压低后照发。这里要求每条的对象形状与 status 都在**厂商 schema 的取值域**内。
      // 状态集合取权威 enum（node_modules/mutation-testing-report-schema 的 MutantStatus），
      // **不是** countMutant 计数的那 4 个：CompileError/RuntimeError/Ignored/Pending 都是合法
      // 状态，只认 4 个会把正常报告整段拒掉（CodeRabbit 原提议即此，其后续 review 亦确认不采用）。
      // 用 enum 校验同时关掉「非空但未知的 status（如 'Bogus'）静默抬高 total」这类漏网
      // （独立对抗审查 B 组反例：只要求非空字符串时 'Bogus' 被接受并计数）。
      for (const m of file.mutants) {
        const status = m && typeof m === 'object' && !Array.isArray(m) ? m.status : undefined
        if (!MUTANT_STATUSES.has(status)) {
          throw new Error(`files["${fileKey}"].mutants 含缺失或未知 status 的条目（status=${JSON.stringify(status)}）`)
        }
        countMutant(stats, fileKey, m)
      }
    }
    // files 非空但一个变异体都没有（如各文件 mutants 均为空数组）同样是「零内容报告」，
    // 会照样渲染出 🎉 满分——一并按段级失败处理。
    if (stats.total === 0) {
      throw new Error('报告不含任何变异体（files 为空映射或各文件 mutants 均为空）')
    }
  } catch (e) {
    return { seg, error: `${String(e.message || e)}（报告：${reportPath}）` }
  }
  const score = stats.total > 0 ? ((stats.killed + stats.timeout) / stats.total) * 100 : 0 // 无数据不报 100%（机器人审查）
  return {
    seg,
    total: stats.total,
    killed: stats.killed,
    survived: stats.survived,
    noCoverage: stats.noCoverage,
    timeout: stats.timeout,
    score: Math.round(score * 100) / 100,
    survivedMutants: stats.survivedMutants,
    // F1：报告文件时间——内容层面无法区分「本次运行」与「缓存回填的陈旧报告」（stryker 的 json
    // report 不含时间戳），新鲜度闸门（validateFreshness）据此比较各段跨度。stat 失败不单列分支：
    // 上面已成功读到文件，取不到时间只说明文件被并发删除，此时 reportMtimeMs 为 undefined，
    // 该段不参与新鲜度比较（不误红），缺段/损坏仍由 validateSegments 负责。
    reportPath,
    reportMtimeMs: readMtimeMs(reportPath)
  }
}

// F1：读取报告文件的 mtime（毫秒）；读不到返回 undefined（该段退出新鲜度比较，不误判为陈旧）
// QG2：Codacy/Opengrep「动态构造文件/路径信息」（pathtraversal-non-literal-fs-filename）在此是纯语法
// 误报——规则只放行字符串字面量首参，而 filePath 由 analyze() 的 dir 入参（CI 里是固定的
// mutation-reports/ 目录，见 .github/workflows/mutation.yml 的调用）经 readdirSync 枚举 + 段名拼接而来，
// 无法用字面量表达。信任模型与同族的 scripts/mutation-json.js 完全一致——后者已在 .codacy.yml 里按
// 「变异报告读取工具：reportPath 来自 analyze() 对 CLI 传入目录的 readdir 枚举，非不可信输入」登记同一误报。
// 故该行加 `// nosemgrep`：Semgrep 原生行内抑制（引擎对无 ids 的 nosemgrep 判定 is_ignored=true），
// Codacy 的 opengrep wrapper 不传 --disable-nosem，且在解析 JSON 时显式跳过 extra.is_ignored 的结果，
// 故抑制在 Codacy 侧同样生效。
function readMtimeMs (filePath) {
  try {
    return fs.statSync(filePath).mtimeMs // nosemgrep（路径由 CLI 传入目录的 readdir 枚举 + 段名构成，同 mutation-json.js 口径）
  } catch (e) {
    return undefined
  }
}

// 单个变异体计数（独立小函数：killed/survived/noCoverage/timeout 分类）
function countMutant (stats, fileKey, m) {
  stats.total++
  if (m.status === 'Killed') {
    stats.killed++
  } else if (m.status === 'Survived') {
    stats.survived++
    stats.survivedMutants.push({
      file: String(fileKey || '?'),
      line: m.location ? m.location.start.line : '?',
      mutator: m.mutatorName,
      replacement: m.replacement
    })
  } else if (m.status === 'NoCoverage') {
    stats.noCoverage++
  } else if (m.status === 'Timeout') {
    stats.timeout++
  }
}

// Markdown 表格单元格转义：| 破坏表格、换行破坏行结构、反引号破坏代码标记（子代理审查）
function escCell (s) {
  // 转义顺序：反斜杠先行（避免 \| 二次转义）→ 竖线 → 反引号（Markdown 行内代码无法转义反引号，替换为单引号防 span 破坏）
  return String(s).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'")
}

// 统计收集（独立小函数——降低 render 圈复杂度：文件分布 + 类型分布 + 存活列表）
function collectStats (results) {
  // Object.create(null)：文件/类型名若为 __proto__/constructor 等不污染原型链（子代理审查）
  const byFile = Object.create(null)
  const byKind = Object.create(null)
  const allSurvived = []
  for (const r of results) {
    for (const m of r.survivedMutants || []) {
      allSurvived.push(m)
      byFile[m.file] = (byFile[m.file] || 0) + 1
      byKind[m.mutator] = (byKind[m.mutator] || 0) + 1
    }
  }
  return { byFile, byKind, allSurvived }
}

function _renderSegmentTable (results) {
  // 段汇总表（含合计行）：正常段 + error 段分支
  const lines = []
  lines.push('| 段 | 变异体 | 被杀 | 超时 | 存活 | 无覆盖 | 分数 |')
  lines.push('|---|---|---|---|---|---|---|')
  let tTotal = 0
  let tKilled = 0
  let tTimeout = 0
  let tSurvived = 0
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.seg} | ❌ ${r.error} | - | - | - | - | - |`) // 7 列对齐表头（含 Timeout 列——CodeAnt P1）
      continue
    }
    tTotal += r.total
    tKilled += r.killed
    tSurvived += r.survived
    tTimeout += r.timeout || 0
    lines.push(`| ${r.seg} | ${r.total} | ${r.killed} | ${r.timeout} | ${r.survived} | ${r.noCoverage} | ${r.score}% |`)
  }
  // 口径与段分一致（超时计入已处理）；无数据报 0 而非 100（机器人审查）
  // F6：本脚本只汇总，**不设分数门禁**——分数门禁在 stryker 侧（stryker.config.js 的
  // thresholds.break=65，由每个矩阵 job 各自按段判定，见该文件注释）。这里**有意**不再加一道：
  // main() 是「先 validateSegments/validateFreshness 再 postIssue」，本脚本 throw 会让不达标时连
  // 日报一起吞掉——而那正是最需要看到分数的时刻。故此处只保留完整性/新鲜度两道 throw。
  const overall = tTotal > 0 ? Math.round((((tKilled + tTimeout) / tTotal) * 100) * 100) / 100 : 0
  lines.push(`| **合计** | **${tTotal}** | **${tKilled}** | **${tTimeout}** | **${tSurvived}** | | **${overall}%** |`)
  return lines
}

function _renderTopFiles (byFile) {
  // 存活最多的文件 Top 10（含具体数量——定位补测重点）
  const lines = []
  const topFiles = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (topFiles.length === 0) return lines
  lines.push('## 存活最多的文件 Top 10')
  lines.push('')
  lines.push('| 文件 | 存活变异体数 |')
  lines.push('|---|---|')
  for (const [f, n] of topFiles) lines.push(`| \`${escCell(f)}\` | ${n} |`)
  lines.push('')
  return lines
}

function _renderTopKinds (byKind) {
  // 按变异类型分布（存活——种类 + 数量，定位测试弱在哪类）
  const lines = []
  const topKinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 15)
  if (topKinds.length === 0) return lines
  lines.push('## 存活变异类型分布 Top 15')
  lines.push('')
  lines.push('| 变异类型 | 存活数 |')
  lines.push('|---|---|')
  for (const [k, n] of topKinds) lines.push(`| ${escCell(k)} | ${n} |`)
  lines.push('')
  return lines
}

function _renderSurvivors (allSurvived) {
  // 存活变异体清单（>30 时截断显示"还有 N 个"）；无存活则 🎉 分支
  const lines = []
  if (allSurvived.length > 0) {
    lines.push(`## 存活变异体（${allSurvived.length} 个）`)
    lines.push('')
    for (const m of allSurvived.slice(0, 30)) {
      lines.push(`- \`${escCell(m.file)}:${m.line}\` ${escCell(m.mutator)} → \`${escCell(String(m.replacement).slice(0, 40))}\``)
    }
    if (allSurvived.length > 30) lines.push(`- …还有 ${allSurvived.length - 30} 个（见各段报告）`)
  } else {
    lines.push('## 🎉 无存活变异体！')
  }
  return lines
}

function render (results) {
  // 协调器：标题 + collectStats + 4 个子段拼装 + footer
  // 单 push 多参调用避免 SonarCloud S7778 / Lizard_ccn 重复 push 告警
  const { byFile, byKind, allSurvived } = collectStats(results)
  const lines = []
  lines.push(
    '## 🧬 变异测试日报',
    '',
    ..._renderSegmentTable(results),
    '',
    ..._renderTopFiles(byFile),
    ..._renderTopKinds(byKind),
    ..._renderSurvivors(allSurvived),
    '',
    '> 由 mutation-report.js 自动生成'
  )
  return lines.join('\n')
}

/**
 * 汇总日报并按上海自然日创建或复用 GitHub Issue。
 * @param {string} body 已渲染的日报 Markdown
 * @returns {Promise<object>} 新建或已存在的 Issue 信息
 */
async function postIssue (body) {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('缺少 GITHUB_TOKEN')
  const repo = process.env.GITHUB_REPOSITORY || 'junhanw868-bot/notes'
  const today = shanghaiDate()
  const title = `🧬 变异测试日报 ${today}`
  // 同天去重：当天已有日报则跳过（避免多次运行重复发 Issue）。
  // F7：去重查询必须整体容错——非 2xx / 网络异常 / 超时 / 200 但响应体非 JSON，一律按既有口径
  // 「跳过去重直接创建」并输出可观测 warn。旧实现有两条能吞掉当天日报的路径：
  //   ① `await listRes.json()` 未包 try：列表 API 返回 200 + 非 JSON（代理页/限流说明页）时抛
  //      SyntaxError，整个 run 失败，日报不发；
  //   ② fetch 无超时：列表接口挂住会把 report job 一起拖死（GitHub API 偶发长时间无响应）。
  // 只用本机异常文本拼 warn（非远端响应体），折叠换行/控制字符后截断，避免伪造日志行。
  let existing
  try {
    const listRes = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&creator=github-actions%5Bbot%5D`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'mutation-report' },
      signal: AbortSignal.timeout(LIST_QUERY_TIMEOUT_MS)
    })
    if (!listRes.ok) {
      console.warn(`⚠️  日报列表查询失败（HTTP ${listRes.status}），跳过去重直接创建`)
    } else {
      const list = await listRes.json()
      existing = (list || []).find(i => i.title === title)
    }
  } catch (e) {
    const reason = String((e && e.message) || e || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 200)
    console.warn(`⚠️  日报列表查询失败（${reason}），跳过去重直接创建`)
  }
  if (existing) {
    console.log('⏭️  当日日报已存在，跳过重复发布')
    return { number: existing.number, html_url: existing.html_url, skipped: true }
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'mutation-report' },
    body: JSON.stringify({ title, body })
  })
  if (!res.ok) {
    // S5145：远端响应体不可信（可能含换行/控制字符/伪日志前缀），只记录固定状态码
    await res.text().catch(() => {})
    throw new Error(`发 Issue 失败，HTTP 状态码：${res.status}`)
  }
  return res.json()
}

/**
 * 将时间转换为上海时区的 ISO 日期（YYYY-MM-DD）。
 * @param {Date} [now=new Date()] 待格式化时间
 * @returns {string} 上海自然日
 */
function shanghaiDate (now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai'
  }).format(now)
}

/**
 * 剥离落盘报告里的 statusReason（artifact / 增量缓存瘦身）。
 *
 * 用法：`node scripts/mutation-report.js --strip <file...>`
 * 与汇总模式完全独立：只重写**已存在**的文件，不发现目录、不解析汇总、不发 Issue、不改门禁。
 * 只重写已存在的文件这一点是刻意的——它不会把「崩溃段根本没有报告」伪装成「有报告」，
 * 因此 validateSegments（缺段拒绝）与 validateFreshness（mtime 判据）的语义都不受影响。
 *
 * 失败口径 fail-closed：任一文件失败（不存在/非普通文件/超过预读上限/剥离后 JSON 非法/写回失败）
 * 都进 stderr 并 exit 1，绝不静默跳过——artifact 会不会瘦身是性能问题，但「以为剥了其实没剥」是门禁问题。
 *
 * @param {string[]} files 目标文件（由调用方筛掉不存在的路径，例如 CI 里的 nullglob + [ -f ]）
 */
function stripReportFiles (files) {
  const maxFileBytes = resolveMaxReportBytes(process.env.XBK_MUTATION_REPORT_MAX_BYTES)
  const failed = []
  let saved = 0
  for (const f of files) {
    try {
      const r = writeStrippedReport(f, { maxFileBytes })
      saved += r.saved
      console.log(r.changed
        ? `🧹 ${r.path}：${r.before} → ${r.after} 字节（省 ${r.saved}，${(100 * r.saved / r.before).toFixed(2)}%）`
        : `✅ ${r.path}：无 statusReason 可剥（${r.before} 字节，未改写、mtime 未动）`)
    } catch (e) {
      failed.push(`${f}（${String((e && e.message) || e)}）`)
    }
  }
  if (failed.length > 0) {
    console.error(`❌ 剥离失败 ${failed.length} 个文件：${failed.join('；')}`)
    process.exit(1)
  }
  console.log(`✅ 已处理 ${files.length} 个文件，共省 ${saved} 字节`)
}

async function main () {
  const args = process.argv.slice(2)
  // 落盘剥离模式：必须在读 <reports-dir> 之前分流（否则 --strip 会被当成目录名走汇总路径）
  const stripIdx = args.indexOf('--strip')
  if (stripIdx !== -1) {
    const files = args.filter(a => a !== '--strip')
    if (files.length === 0) {
      console.error('用法: node scripts/mutation-report.js --strip <file...>')
      process.exit(1)
    }
    stripReportFiles(files)
    return
  }
  const dir = args[0]
  if (!dir) {
    console.error('用法: node scripts/mutation-report.js <reports-dir> [--issue]')
    process.exit(1)
  }
  if (!fs.existsSync(dir)) {
    console.error(`❌ 报告目录不存在或不可访问：${dir}（用法: node scripts/mutation-report.js <reports-dir> [--issue]）`)
    process.exit(1)
  }
  const results = validateSegments(analyze(dir))
  validateFreshness(results) // F1：内容齐全之后再看新鲜度（陈旧报告不得照发日报）
  const body = render(results)
  console.log(body)
  if (process.argv.includes('--issue')) {
    const issue = await postIssue(body)
    // CodeRabbit 审查：跳过分支补 number，且跳过不应标记为“已发布”
    if (issue.skipped) {
      // S5145：existing.number 来自远端 Issue 列表，属用户可控数据——跳过时不输出
      console.log('\n⏭️ 日报已存在，跳过发布')
    } else {
      // S5145：number 来自远端响应（POST /issues），属用户可控数据——日志不再输出远端字段
      console.log('\n✅ 日报已发布')
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌', e.message || e)
    process.exit(1)
  })
}

// 导出供测试（不导出 main：依赖 CLI 副作用；postIssue 导出以便 mock fetch 测去重/错误处理逻辑）
module.exports = { analyze, validateSegments, validateFreshness, resolveMaxSkewMs, resolveRunStartedAtMs, findReportJson, analyzeSegment, countMutant, escCell, collectStats, render, shanghaiDate, postIssue, EXPECTED_SEGMENTS }
