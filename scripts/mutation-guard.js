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
//   ⑤（**默认关闭，需显式提供基线**）某段 killed 数低于「同 commit 全量重算基线」减去容忍值 —— 见下。
//
// 判据 ⑤ 为什么默认关闭（C10-021，诚实登记：没有基线时**这个门禁不存在**）：
//   stryker 侧的分数门禁已撤回（stryker.config.js 的 thresholds.break = null，:83-101 用三条实测证据
//   记录了这个取舍：同配置同 commit 同段三轮 79.08% / 82.92% / 71.02%，极差 11.90pp）；而「读上一轮
//   artifact 当基线」正是被否定的做法 —— 增量复用会把上一轮的 killed 原样搬过来，与「本轮测试变弱」
//   不可区分（:92 的污染基线）。故判据 ⑤ 只在调用方**显式**提供基线时生效，且基线必须是:
//     * **同一 commit** 的全量重算结果（基线文件带 commit，与 GITHUB_SHA 逐字相同；缺一即 fail-closed），
//     * `mode: "full"`（partial / incremental / 未知一律拒），不得带 reuse / incremental 字段，
//     * 逐段 killed 计数（非负整数）。
//   只有这三条同时成立，「killed 下降」才是可归因的测试变弱信号，而不是抖动或复用残留。
//   容忍值由 XBK_MUTATION_KILLED_TOLERANCE 给出（默认 0，非负整数）。
//
// 附带产出（**不属于判据、不影响退出码**）：每份成功解析的报告会在同目录落盘 timeout-stats.json，把 Timeout
//   按 statusReason 分成 hang（无 reason，真挂死）/ hitLimit（`Hit limit reached` 前缀，tap-runner 的命中
//   上限）/ other（其余 reason）。原因：落盘剥离步会把 statusReason 置空串，artifact 里再也分不出这两类；
//   而日报把 Timeout 计入 detected，需要能区分「跑不动」与「上限太小」。写失败只告警，绝不改退出码。
//
// 读取与上限口径**全部复用** scripts/mutation-json.js 的 readReportJson / resolveMaxReportBytes：不另写一份
// 读取/剥离/大小上限逻辑，避免护栏漂移（该文件的 statusReason 剥离与「非普通文件拒绝 / 预读上限」是既有防线）。
// 状态名取自本仓已安装的 mutation-testing-report-schema 的 MutantStatus enum
//   * node_modules/mutation-testing-report-schema/dist/src/mutation-testing-report-schema.json 的
//     files.*.mutants.items.status（enum）
//   * node_modules/mutation-testing-report-schema/dist/src-generated/schema.d.ts 的 `export type MutantStatus = ...`
// 与 scripts/mutation-report.js 的 MUTANT_STATUSES 同源同集合——收窄成 countMutant 计数的 4 个会把正常报告整段拒掉。
//
// ── argv 解析策略（C10-054）────────────────────────────────────────────────────────────────
// 本仓有 ≥8 个 CLI 入口各自手写 argv 解析（本文件、xbk_function_v3.js、qinglong/xbk_push.js、
// scripts/mutation-report.js、scripts/check-doc-lines.js、scripts/check-host-clean.js、
// scripts/check-ci-static.js、scripts/validate-release-tag.js）。未知参数历史上分三类互斥策略：
//   ① throw 后收敛成非零退出（本文件）；② console.error + process.exitCode=1（xbk_function_v3/qinglong 入口）；
//   ③ 静默忽略（其余用 includes/indexOf 取已知项，剩下的当位置参数）。
// 统一口径 = **未知或非法参数一律 fail-closed**（本文件即该口径的实现，见 parseArgs）：拼错 `--segmnt`
// 曾能让守卫静默空转（无路径 ⇒ 无判据）。空取值、取值看起来像另一个参数、同一参数重复指定都算非法。
// 其余入口的收敛**不在本次改动范围**（动它们会改变既有 CLI 行为）；换 node:util parseArgs 也应排在
// 统一策略之后，而不是先换实现再谈语义。
const path = require('node:path')
const fs = require('node:fs')
const { readReportJson, resolveMaxReportBytes } = require('./mutation-json.js')

// 与 mutation-testing-report-schema 的 MutantStatus enum 逐字一致（8 个）
const MUTANT_STATUSES = new Set([
  'Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored', 'Pending'
])

// ── Timeout 取证（可观测性，**不参与门禁**）──────────────────────────────────────────────────
// 为什么需要：日报把 Timeout 计入 detected（(killed+timeout)/total），但 Timeout 本身有两种成因，
//   混在一起看不出「跑不动」还是「等待上限太小」：
//   ① 真挂死：TimeoutDecorator 杀掉的变异体，报告里**不带** statusReason；
//   ② 命中上限：tap-runner 的 determineHitLimitReached（node_modules/@stryker-mutator/api 的
//      test-runner/run-result-helpers.js）判定测试跑太多次数，statusReason 以 `Hit limit reached (n/m)` 开头。
//   两类在 artifact 里原本不可分：落盘剥离步（mutation.yml 的「剥离报告中的 statusReason」）把 reason 置空串。
//   故本守卫在**剥离之前**（它本来就在剥离步之前）按 statusReason 前缀分类，落盘 timeout-stats.json，
//   随 artifact 到汇总 job 供日报分列展示。退出码语义一字不改：这是纯粹的可观测性，写失败只告警。
const HIT_LIMIT_PREFIX = 'Hit limit reached'
const TIMEOUT_STATS_FILENAME = 'timeout-stats.json'
// statusReason 只保留前 N 个字符：够判别 `Hit limit reached (n/m)` 前缀，又不会让 command 档
// （整段测试输出写进 reason）的报告在内存里翻倍。
const STATUS_REASON_KEEP_CHARS = 64
// other 类的样本条数上限（只做诊断，不改变计数）
const OTHER_REASON_SAMPLES = 3

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

/**
 * 按 statusReason 给一个 Timeout 变异体分类（纯函数，**不抛**）。
 *
 * 依据（实测，非推测）：
 *   * 真挂死 = 被 TimeoutDecorator 杀掉 ⇒ 报告里**没有** statusReason（缺键或空串）；
 *   * 命中上限 = tap-runner 的 determineHitLimitReached ⇒ statusReason 以 `Hit limit reached (n/m)` 开头
 *     （node_modules/@stryker-mutator/api/dist/src/test-runner/run-result-helpers.js）。
 *   * other = 其余任何 reason（例如 command 档把测试输出写进 reason）：既不冒充挂死，也不冒充上限。
 *
 * @param {unknown} reason 变异体的 statusReason（可能是 undefined / null / 非字符串）
 * @returns {'hang'|'hitLimit'|'other'} 分类
 */
function classifyTimeoutReason (reason) {
  if (typeof reason !== 'string' || reason.trim() === '') return 'hang'
  return reason.trimStart().startsWith(HIT_LIMIT_PREFIX) ? 'hitLimit' : 'other'
}

/**
 * 统计一份报告里的 Timeout 分类（纯函数，结构非法时退化为 0，**不抛**——它是可观测性，不是门禁）。
 *
 * 字段：segment（段名）/ total（Timeout 总数）/ hang / hitLimit / other / otherReasons（other 的样本）
 * / mutants（报告里的变异体总数，便于与 counts.total 交叉核对）。报告不带单次耗时，
 * 故**没有**「最长单次」这类字段（不编造）。
 *
 * @param {object} report readReportJson 的产物（statusReason 已保留前缀）
 * @param {string} label 段名
 * @returns {{segment: string, total: number, hang: number, hitLimit: number, other: number, otherReasons: string[], mutants: number}}
 */
function collectTimeoutStats (report, label) {
  const stats = { segment: label, total: 0, hang: 0, hitLimit: 0, other: 0, otherReasons: [], mutants: 0 }
  const files = report && typeof report === 'object' ? report.files : undefined
  if (!files || typeof files !== 'object' || Array.isArray(files)) return stats
  for (const file of Object.values(files)) {
    const mutants = file && typeof file === 'object' && Array.isArray(file.mutants) ? file.mutants : []
    for (const m of mutants) {
      stats.mutants++
      if (!m || typeof m !== 'object' || m.status !== 'Timeout') continue
      stats.total++
      const kind = classifyTimeoutReason(m.statusReason)
      stats[kind]++
      if (kind === 'other' && stats.otherReasons.length < OTHER_REASON_SAMPLES) {
        // 只留诊断样本且截断：这是给人看的线索，不承担判据
        stats.otherReasons.push(String(m.statusReason).slice(0, 120))
      }
    }
  }
  return stats
}

/**
 * 把一段的 Timeout 取证写到**报告所在目录**（CI 是 reports/mutation/，随 artifact 上传）。
 * 单报告调用是生产形态（每段一个 job、一个 report 目录）；同目录多报告时后者覆盖前者（仅诊断用途）。
 *
 * 只写报告同目录的固定文件名（不含任何来自报告内容的路径片段），**先断链再写**：
 * `fs.writeFileSync` 会跟随已存在的符号链接，写到链接指向的那个文件上（Sourcery：SymbolicLink
 * overwrite）——同目录里若有人预置了 `timeout-stats.json -> 别处的文件`，取证就会把那个文件改写掉。
 * `rmSync(target, { force: true })` 删的是链接本身（不跟随），随后 writeFileSync 新建的是普通文件；
 * 不存在时 force:true 静默通过，不引入新的失败路径（写失败在本脚本里本来就只告警）。
 * @param {string} reportPath 该段的 mutation.json 路径
 * @param {object} stats collectTimeoutStats 的产物
 * @returns {string} 实际写入的路径
 */
function writeTimeoutStats (reportPath, stats) {
  const target = path.join(path.dirname(path.resolve(reportPath)), TIMEOUT_STATS_FILENAME)
  fs.rmSync(target, { force: true }) // nosemgrep（同上，路径由 CLI 报告路径派生）NOSONAR:S8707 断链本身（只删固定文件名）
  fs.writeFileSync(target, JSON.stringify(stats, null, 2) + '\n') // nosemgrep（target 由 CLI 传入的报告路径派生：守卫本就按该路径读同一份报告，写回同目录不引入新输入面）
  return target
}

// ── killed 下降基线的读取与校验（判据 ⑤，**默认关闭**）─────────────────────────────────────────
// 「不得读上一轮 artifact」这条硬约束的可执行落地：基线必须自带 commit + mode:'full'，且不得带
// reuse / incremental 字段；与本轮 commit（GITHUB_SHA）不一致一律拒。三条缺一即 fail-closed。
const KILLED_BASELINE_ENV = 'XBK_MUTATION_KILLED_BASELINE'
const KILLED_TOLERANCE_ENV = 'XBK_MUTATION_KILLED_TOLERANCE'
const KILLED_BASELINE_MODE = 'full'

function resolveKilledTolerance (raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0
  const text = String(raw).trim()
  // 只认非负整数：'-1' / '1.5' / '1e3' 都会让「下降」判据变形（负容忍等于反向放宽），一律拒
  if (!/^\d+$/.test(text)) throw new Error(`${KILLED_TOLERANCE_ENV} 必须是非负整数（收到 ${JSON.stringify(raw)}）`)
  return Number(text)
}

/**
 * 读取并校验 killed 基线（判据 ⑤ 的输入）。任何一条不满足都 throw（调用侧按 fail-closed 处理）。
 * @param {string} filePath 基线 JSON 路径（XBK_MUTATION_KILLED_BASELINE）
 * @param {{commit?: string, maxFileBytes?: number}} [options] commit = 本轮 commit（CI 的 GITHUB_SHA）
 * @returns {{commit: string, segments: Map<string, number>}}
 */
function readKilledBaseline (filePath, options = {}) {
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? options.maxFileBytes
    : resolveMaxReportBytes(process.env.XBK_MUTATION_REPORT_MAX_BYTES)
  // 单 fd 读（与 scripts/mutation-json.js 的 readGuardedBytes 同一手法）：早先是
  // `statSync(路径)` 判类型/大小、再 `readFileSync(路径)` 二次查找，于是「检查看到的」与
  // 「实际读到的」可以是两个不同对象（换 inode / 被追加 / 被换成 FIFO），size 上限随之形同虚设。
  // 改成一次 openSync + 只对 fd 做 fstat 与读取：类型/大小判定与读入作用于同一个 inode，
  // 不存在「检查后被换」的窗口（CodeQL js/file-system-race 119）。
  // O_NONBLOCK：FIFO 单开只读会阻塞到出现写端；加上后 open 立即返回、随后被 fstat 按
  // 「非普通文件」拒绝，对常规文件无副作用。
  let fd
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  } catch (err) {
    throw new Error(`基线文件不可读（${filePath}）：${err.message}`)
  }
  let buf
  try {
    let stat
    try {
      stat = fs.fstatSync(fd)
    } catch (err) {
      throw new Error(`基线文件不可读（${filePath}）：${err.message}`)
    }
    if (!stat.isFile()) throw new Error(`基线不是普通文件（${filePath}）`)
    if (stat.size > maxFileBytes) throw new Error(`基线文件过大（${stat.size} > ${maxFileBytes} 字节）`)
    try {
      // 按 fd 读（不再按路径二次查找）：读到的就是上面 fstat 判定的那个对象。
      buf = fs.readFileSync(fd)
    } catch (err) {
      throw new Error(`基线文件不可读（${filePath}）：${err.message}`)
    }
    // fstat 之后仍可能被追加（同一 inode 追加不是换文件）：按真正读进来的字节数再判一次，
    // 上限不能只在「检查时」成立。
    if (buf.length > maxFileBytes) throw new Error(`基线文件过大（${buf.length} > ${maxFileBytes} 字节）`)
  } finally {
    try {
      fs.closeSync(fd)
    } catch (err) {
      // 关闭失败不得覆盖主流程的结果；后果只有 fd 泄漏，且进程随后退出。
    }
  }
  let baseline
  try {
    baseline = JSON.parse(buf.toString('utf8'))
  } catch (err) {
    throw new Error(`基线不是合法 JSON（${filePath}）：${err.message}`)
  }
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error(`基线顶层结构非法（${describe(baseline)}）`)
  }
  // 增量/复用痕迹一律拒：增量复用会把上一轮的 killed 原样搬过来，与「本轮测试变弱」不可区分
  for (const key of ['reuse', 'incremental', 'incrementalFile']) {
    if (Object.prototype.hasOwnProperty.call(baseline, key)) {
      throw new Error(`基线带 ${key} 字段 ⇒ 疑似上一轮 artifact / 增量结果，不能当基线（这就是本判据默认关闭的原因）`)
    }
  }
  if (baseline.mode !== KILLED_BASELINE_MODE) {
    throw new Error(`基线的 mode 必须是 ${JSON.stringify(KILLED_BASELINE_MODE)}（全量重算），实际 ${JSON.stringify(baseline.mode)}`)
  }
  if (typeof baseline.commit !== 'string' || baseline.commit.trim() === '') {
    throw new Error('基线缺 commit 字段（必须是产出该基线的那个 commit）')
  }
  const expectedCommit = typeof options.commit === 'string' ? options.commit.trim() : ''
  if (expectedCommit === '') {
    throw new Error('无法确认基线与本轮同 commit：本轮 commit 需由 GITHUB_SHA 提供（跨 commit 的 killed 不可比）')
  }
  if (baseline.commit !== expectedCommit) {
    throw new Error(`基线的 commit(${baseline.commit}) 与本轮 commit(${expectedCommit}) 不一致：跨 commit 的 killed 不可比`)
  }
  const segments = baseline.segments
  if (!segments || typeof segments !== 'object' || Array.isArray(segments)) {
    throw new Error(`基线缺 segments 映射（实际 ${describe(segments)}）`)
  }
  const map = new Map()
  for (const [name, value] of Object.entries(segments)) {
    const killed = value && typeof value === 'object' && !Array.isArray(value) ? value.killed : undefined
    if (!Number.isInteger(killed) || killed < 0) {
      throw new Error(`基线 segments["${name}"].killed 必须是非负整数（实际 ${JSON.stringify(killed)}）`)
    }
    map.set(name, killed)
  }
  if (map.size === 0) throw new Error('基线的 segments 为空 ⇒ 无判据可比')
  return { commit: baseline.commit, segments: map }
}

function parseArgs (argv) {
  const paths = []
  let segment = null
  let segmentSource = null
  // 口径（C10-054）：未知或**非法**参数一律 fail-closed。此前的三处静默接受都并进来：
  //   * `--segment=`（空取值）→ 旧实现 trim 后置 null，守卫在**没有标签**的情况下继续跑；
  //   * `--segment --label x` → 旧实现把 `--label` 当段名、`x` 当报告路径（真错时只报「文件不可读」，误导）；
  //   * 重复 `--segment a --segment b`（或 `--segment` 与 `--label` 同时给）→ 旧实现后者静默覆盖前者。
  const takeSegment = (source, raw) => {
    const value = String(raw)
    if (value.trim() === '') throw new Error(`${source} 取值为空（fail-closed：空取值会让守卫在没有段标签的情况下继续跑）`)
    if (value.startsWith('-')) throw new Error(`${source} 的取值 ${value} 看起来是另一个参数（fail-closed：参数不明时拒绝静默放行）`)
    if (segmentSource !== null) throw new Error(`${source} 重复指定段名（已由 ${segmentSource} 给出「${segment}」）—— fail-closed：取哪个都不该靠猜`)
    segment = value
    segmentSource = source
  }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--segment' || a === '--label') {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} 缺少取值`)
      takeSegment(a, v)
      i++
    } else if (a.startsWith('--segment=')) {
      takeSegment('--segment=', a.slice('--segment='.length))
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
  return { paths, segment }
}

/**
 * 对一份或多份报告求值（纯判定，不做退出码/输出）。
 *
 * @param {string[]} reportPaths stryker mutation.json 路径（CI 传 reports/mutation/mutation.json）
 * @param {{segment?: string, env?: Record<string,string|undefined>, maxFileBytes?: number}} [options]
 *   env 默认 process.env：只用于取 XBK_MUTATION_REPORT_MAX_BYTES（与 mutation-report.js / analyze-artifacts.js 同源口径）。
 * @returns {{ok: boolean, reports: object[], failures: object[]}} failures 为空即 ok；
 *   每份成功解析的报告带 `timeoutStats`（Timeout 的 hang/hitLimit/other 分类，供落盘取证）。
 */
function evaluateReports (reportPaths, options = {}) {
  const env = options.env || process.env
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? options.maxFileBytes
    : resolveMaxReportBytes(env.XBK_MUTATION_REPORT_MAX_BYTES) // 复用同一份上限解析，不另写
  // 判据 ⑤（可选）：仅当调用方显式传入 { commit, segments: Map } 基线时比较 killed；未传 = 无该判据
  const baseline = options.baseline && options.baseline.segments instanceof Map ? options.baseline : null
  const killedTolerance = Number.isFinite(options.killedTolerance) ? options.killedTolerance : 0
  let comparedSegments = 0
  const reports = []
  const failures = []
  for (const reportPath of reportPaths) {
    const label = options.segment || path.basename(reportPath)
    let report
    try {
      // 复用 scripts/mutation-json.js 的读取护栏（非普通文件拒绝 / 预读上限 / statusReason 剥离后再解析）。
      // statusReasonPrefix：只保留前 64 字符供 Timeout 取证分类（见 collectTimeoutStats）；同时保持
      //   command 档超大 reason 的内存边界（整段保留会让报告内存翻倍）。
      report = readReportJson(reportPath, { maxFileBytes, statusReasonPrefix: STATUS_REASON_KEEP_CHARS })
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
    // Timeout 取证（可观测性）：读的是**同一份已解析报告**，不额外读盘、不改判据。
    // 结构非法已在 countMutantsByStatus 拦下，故这里不会再抛（collectTimeoutStats 本身也不抛）。
    reports.push({ label, reportPath, counts, timeoutStats: collectTimeoutStats(report, label) })
    if (counts.runtimeErrors > 0) failures.push({ kind: 'runtimeErrors', label, reportPath, counts })
    if (counts.totalValid === 0) failures.push({ kind: 'noValidMutants', label, reportPath, counts })
    // 判据 ⑤：killed 不得低于同 commit 全量重算基线（容忍值内视为抖动）。本段不在基线里 ⇒ 无法比较 ⇒ 判红。
    if (baseline) {
      const baselineKilled = baseline.segments.get(label)
      if (baselineKilled === undefined) {
        failures.push({ kind: 'baselineMissingSegment', label, reportPath, counts })
      } else {
        comparedSegments++
        if (counts.killed < baselineKilled - killedTolerance) {
          failures.push({ kind: 'killedDrop', label, reportPath, counts, baselineKilled, killedTolerance })
        }
      }
    }
  }
  // 基线与本次报告零交集（段名全对不上）⇒ 判据 ⑤ 实际上没判任何东西，必须响亮失败而不是假绿。
  if (baseline && comparedSegments === 0 && reports.length > 0) {
    failures.push({ kind: 'baselineNoOverlap', label: baseline.commit, reportPath: reportPaths.join(', '), counts: null })
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
    case 'killedDrop':
      return [
        head + `killed 数下降：本轮 ${f.counts.killed} < 基线 ${f.baselineKilled}（容忍 ${f.killedTolerance}）。`,
        '   判据 ⑤（需显式提供「同 commit 全量重算」基线）：killed 下降意味着测试变弱或变异目标被静默缩水，',
        '   不能用「分数抖动」解释。若确认为抖动，请在基线侧提高 XBK_MUTATION_KILLED_TOLERANCE，不要改本守卫。',
        `   计数：${formatCounts(f.counts)}`,
        `   路径：${f.reportPath}`
      ].join('\n')
    case 'baselineMissingSegment':
      return [
        head + '本段不在 killed 基线的 segments 里 ⇒ 无法比较（fail-closed：基线必须覆盖被比较的段）。',
        `   段：${f.label}`,
        `   路径：${f.reportPath}`
      ].join('\n')
    case 'baselineNoOverlap':
      return [
        head + '基线里的段与本次报告零交集 ⇒ 判据 ⑤ 没有判到任何东西（fail-closed，不接受「没比到就算通过」）。',
        `   基线 commit：${f.label}`,
        `   报告：${f.reportPath}`
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
  // 判据 ⑤ 的输入（默认关闭）：只有显式设置 XBK_MUTATION_KILLED_BASELINE 才比较 killed。
  // 基线不可用（读不到/结构非法/跨 commit/带增量痕迹）⇒ 立刻 fail-closed，不进入「没有判据」的假绿。
  let baseline = null
  let killedTolerance = 0
  try {
    killedTolerance = resolveKilledTolerance(env[KILLED_TOLERANCE_ENV])
    const baselineRaw = env[KILLED_BASELINE_ENV]
    if (baselineRaw !== undefined) {
      const baselinePath = String(baselineRaw).trim()
      if (baselinePath === '') throw new Error(`${KILLED_BASELINE_ENV} 不能为空串（不启用请删除该变量，不要置空）`)
      baseline = readKilledBaseline(baselinePath, {
        commit: env.GITHUB_SHA,
        maxFileBytes: resolveMaxReportBytes(env.XBK_MUTATION_REPORT_MAX_BYTES)
      })
    }
  } catch (e) {
    err.write(`❌ 守卫参数非法：killed 基线不可用 —— ${String((e && e.message) || e)}\n`)
    err.write('   基线必须是**同一 commit 的全量重算**结果（mode:"full" + commit + segments），不得用上一轮 artifact/增量结果。\n')
    return 1
  }
  if (baseline) {
    out.write(`ℹ️ killed 下降门禁已启用（判据 ⑤）：基线 commit=${baseline.commit}，${baseline.segments.size} 段，容忍 ${killedTolerance}\n`)
  }
  const { ok, reports, failures } = evaluateReports(parsed.paths, { segment: parsed.segment, env, baseline, killedTolerance })
  // Timeout 取证落盘（可观测性）：写在报告同目录（CI = reports/mutation/timeout-stats.json，随 artifact 上传）。
  // **绝不**影响退出码：写失败只告警——取证文件缺失不该把一段本该绿的 job 判红（日报会把缺取证显示成 `—`，
  // 不静默当 0）。放在判失败之前：即使本段红（如 RuntimeError），Timeout 的成因同样值得留档。
  const statsPaths = new Map()
  for (const r of reports) {
    try {
      statsPaths.set(r.reportPath, writeTimeoutStats(r.reportPath, r.timeoutStats))
    } catch (e) {
      err.write(`⚠️ [${r.label}] Timeout 取证落盘失败（不影响退出码）：${String((e && e.message) || e)}\n`)
    }
  }
  // 有失败的报告不能打成 ✅（否则「上面一行绿、下面明细红」自相矛盾）；失败的报告计数也走 stderr。
  const failedReports = new Set(failures.map(x => x.reportPath))
  for (const r of reports) {
    if (failedReports.has(r.reportPath)) {
      err.write(`❌ [${r.label}] 计数：${formatCounts(r.counts)}\n   报告：${r.reportPath}\n`)
    } else {
      out.write(`✅ [${r.label}] 守卫通过：${formatCounts(r.counts)}\n   报告：${r.reportPath}\n`)
    }
    const st = r.timeoutStats
    const target = statsPaths.get(r.reportPath)
    if (st && target) {
      out.write(`   🕒 Timeout 取证：total=${st.total} hang=${st.hang} hitLimit=${st.hitLimit} other=${st.other}` +
        `（按 statusReason 分类；写入 ${target}）\n`)
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

module.exports = {
  countMutantsByStatus,
  evaluateReports,
  formatCounts,
  parseArgs,
  run,
  MUTANT_STATUSES,
  classifyTimeoutReason,
  collectTimeoutStats,
  writeTimeoutStats,
  readKilledBaseline,
  resolveKilledTolerance,
  KILLED_BASELINE_ENV,
  KILLED_TOLERANCE_ENV,
  TIMEOUT_STATS_FILENAME,
  HIT_LIMIT_PREFIX
}

// CLI：用 process.exitCode 而非 process.exit()，让 stdout/stderr 正常 flush（stryker 的报告可能很长）。
if (require.main === module) {
  process.exitCode = run(process.argv.slice(2))
}
