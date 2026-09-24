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

// ===== 复用状态（PR #158 评审 · Qodo Medium / Correctness）=============================
// 问题：mutation.yml 的增量缓存 key **有意不含测试侧指纹**（本 PR 的取舍，理由见该文件「恢复增量缓存」
//   注释），而 coverageAnalysis:'off' 下 incremental-differ 在拿不到覆盖信息时**无条件复用**旧结果
//   （@stryker-mutator/core 的 mutants/incremental-differ.js：`if (!testCoverage.hasCoverage) return true`）
//   ⇒ 被复用的变异体沿用**旧测试状态**下的 killed/survived。当前 thresholds.break = null（无分数门禁），
//   故这不构成任何门禁风险；但**日报与 artifact 会把旧结果呈现为「本 commit 的结果」**，读者无法分辨。
//   这一层是真实缺陷。本节的唯一目标：让「复用」在报告里**可见**——不改分数口径、不改 EXPECTED_SEGMENTS、
//   不加任何 throw（日报 throw 会在最需要看分数时把日报一起吞掉，见 _renderSegmentTable 的注释）。
//
// 判定源（已实测，非推测）：stryker 把两种情形都写进 INFO 日志，而 mutation.yml 的「变异测试」step
//   现在带 `--fileLogLevel info` ⇒ 同一份日志落进 cwd 的 `stryker.log`（LoggingBackend 把
//   priority ≥ activeFileLevel 的事件写进该文件，见 @stryker-mutator/core 的 logging/logging-backend.js；
//   两条目标行都是 logger.info，且 info 级**没有**逐变异体日志 ⇒ 日志是 KB 级）：
//     * 全量：`No incremental result file found at <file>, a full mutation testing run will be performed.`
//       （fs/project-reader.js 的 readIncrementalReport，读 inc 文件 ENOENT 分支）
//     * 复用：`Result:\t\t<N> of <M> mutant result(s) are reused.`
//       （mutants/incremental-differ.js 的 diff()，isInfoEnabled() 分支，随 `Incremental report:` 多行输出）
//   实测证据（本机最小 stryker 工程 + 同版本 @stryker-mutator/core@10.0.0，`--incremental` 连跑三次，
//   每次都带 `--fileLogLevel info`，三次运行的三行都落在同一份 stryker.log 里）：
//     ① 无 inc 文件：`INFO ProjectReader No incremental result file found at inc.json, a full mutation testing run will be performed.`
//     ② inc 文件在且源未变：`INFO IncrementalDiffer Incremental report:` / `\tMutants:\t0 files changed (+0 -0)` / `\tResult:\t\t10 of 10 mutant result(s) are reused.`
//     ③ 改了源文件：`\tResult:\t\t10 of 13 mutant result(s) are reused.`
//   **报告本身没有复用标记**：mutation-testing-report-schema 的 MutantResult 只有
//   id/mutatorName/replacement/status/statusReason/location/coveredBy/killedBy/testsCompleted/static 等字段，
//   没有任何 reuse 维度（已核对该包内的 schema JSON）⇒ 日志是唯一可用判定源，必须在**段 job 里**落盘成
//   `reports/mutation/reuse.json` 才能随 artifact 到达汇总 job（汇总 job 只拿得到 reports/mutation/）。
//
// 实测坑（都会导致「读到的复用状态是错的」，必须防）：
//   ① 日志文件以 `flags: 'a'` 打开 ⇒ 同一路径会累积多次运行的记录，**必须取最后一次事件**
//      （实测：连跑 4 次后同一份 stryker.log 里有 1 条「全量」+ 3 条「复用」，取首个匹配会把第一次
//      运行的「全量」当成结论）。
//   ② 消息里的 ANSI 着色（**已实测核实，结论与直觉相反，勿照抄「必须剥」的说法**）：
//      `chalk.yellowBright(reusedMutantCount)` 是在**消息构造时**着色的，CI 的 chalk.level>0 时消息
//      确实带 `ESC[93m…ESC[39m`（本机 `FORCE_COLOR=1` 实测：stdout 上是 `^[[93m14^[[39m of 14 …`）。
//      但**写进文件的那份日志是干净的**——文件走 `LoggingEvent.format()`，它显式
//      `.replace(ansiRegex, '')`（@stryker-mutator/core 的 logging/logging-event.js），只有写 stdout 的
//      `formatColorized()` 保留颜色。同一实验里 stryker.log 全文件 **0 个 ESC 字节**，`Result:` 行是纯文本。
//      故 `stripAnsi` 是**纵深防御**（防 stryker 未来改掉 format()、或有人把 stdout 文本喂进本解析器），
//      不是当前文件格式的必要条件；留着零成本，但注释与文档**不得**再宣称「CI 下文件日志带 ANSI」。
//
// 溯源三态（v3.276 续 · issue #167）：上面这条链路只回答了「有没有复用」，回答不了「**为什么**复用」。
//   实测案例 run 35775812104（issue #167）：19/19 段 100% 复用，其中 fast-check 4.10.0→4.10.1 的依赖变化
//   被**兜底缓存**吞掉、从未重算，而日报完全看不出来。两种复用的可信度不同：
//     * `primary` —— 主 key 命中 ⇒ hashFiles 覆盖的输入（package-lock.json / run_mutation.js / matrix.src /
//       stryker 配置与 tap-shim）真的没变，复用是「输入未变」的直接推论；
//     * `fallback` —— 主 key 未命中、由 `restore-keys` 兜底前缀恢复了同段同档配置的旧缓存 ⇒ 输入**已经变了**
//       （或缓存过期/被逐出），而增量差分只保证「被复用变异体所在**文件内容**未变」，不保证依赖等全局输入未变；
//     * `none` —— 主 key 与兜底都没恢复（等价于全新运行，正常应落回全量重算）。
//   事实依据（勿把「空值」写成「参数漏传」的同义词）：`actions/cache` 在主 key 与兜底前缀**都没恢复**时
//   **有意不设置** `cache-hit` 这个 output（上游 actions/cache issue #1466：无恢复 ≠ cache-hit=false）
//   ⇒ 工作流必须用 `${{ steps.<id>.outputs.cache-hit || 'none' }}` 归一，故「空值」与「参数漏传」是两件事：
//   空值经 `|| 'none'` 归一后是 `none`（明确的「没有缓存可复用」），而参数**缺席**才是「复用来源未记录」
//   （旧 artifact / 其它调用方）——后者一律降级为 undefined，**绝不能被读成 `primary`**。
const REUSE_MODE_FULL = 'full'
const REUSE_MODE_PARTIAL = 'partial'
const REUSE_MODE_UNKNOWN = 'unknown'
// reuse.json 的 `cacheHit` 字段取值（溯源三态）；CLI 侧的 `--cache-hit` 只接受 true/false/none 三个**字符串**。
const CACHE_HIT_PRIMARY = 'primary'
const CACHE_HIT_FALLBACK = 'fallback'
const CACHE_HIT_NONE = 'none'
const CACHE_HIT_ARG_VALUES = Object.freeze(['true', 'false', 'none'])
// 「复用比例高」的阈值：过半结果取自旧运行 ⇒ 日报额外给一条显式提示（比例本身逐段照示，不靠阈值才可见）。
const HIGH_REUSE_RATIO = 0.5
// stryker.log 的策略读取上限。info 级**没有**逐变异体日志（逐变异体那条是 clear-text-reporter 的
// `this.log.debug(input)`，debug 级不落 info 文件）⇒ 体积不随变异体数增长，只随「运行次数」线性增长：
// 实测 16 变异体 × 4 次运行 = 38 行 / 3593 字节。8MiB 留了三个数量级余量；超限一律按「未记录」处理
// 并给出原因——绝不为了拿到一个数字而整份读入病态文件（例如有人改成 --fileLogLevel debug）。
const REUSE_LOG_MAX_BYTES = 8 * 1024 * 1024
// ANSI CSI 序列（含 SGR 颜色），形态为 ESC '[' [0-?]* [ -/]* [@-~]（ECMA-48 的 CSI 子集）。
// 刻意**不用正则**实现——两种正则写法都得靠抑制注释才能过静态检查，而这里根本不需要正则：
//   · 正则字面量要把 ESC 写成 \u001B/\x1b，命中 eslint 的 no-control-regex（standard 启用）；
//   · new RegExp(拼接字符串) 又踩 Codacy 的「RegExp 构造函数传非字面量」告警（本文件此前正是这种写法）。
// 手写扫描没有回溯面，剥离规则本身就是逐字符的定长状态机；行为与旧的 ANSI_ESCAPE_RE 逐字节等价
// （由 test_mutation_report.js 的 stripAnsi 用例锁定：转义序列全部剥掉、且剥后可正常解析复用计数）。
const ESC_CHAR = String.fromCharCode(27)
function stripAnsi (text) {
  const s = String(text)
  if (s.indexOf(ESC_CHAR) === -1) return s // 常见形态（写进文件的那份 stryker.log）0 个 ESC 字节：原样返回
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 27 && s[i + 1] === '[') {
      let j = i + 2
      while (j < s.length && s[j] >= '0' && s[j] <= '?') j++ // 参数字节 [0-?]
      while (j < s.length && s[j] >= ' ' && s[j] <= '/') j++ // 中间字节 [ -/]
      if (j < s.length && s[j] >= '@' && s[j] <= '~') { i = j; continue } // 终止字节 [@-~]（缺终止字节则不是 CSI）
    }
    out += s[i]
  }
  return out
}

const FULL_RUN_LOG_RE = /No incremental result file found at .*?, a full mutation testing run will be performed\./g
const REUSE_LOG_RE = /Result:\s+(\d+) of (\d+) mutant result\(s\) are reused\./g

// 取**最后一次**匹配（全局正则逐次 exec；零宽匹配时手动推进 lastIndex，避免死循环）
function lastMatch (re, text) {
  re.lastIndex = 0
  let m
  let last = null
  while ((m = re.exec(text)) !== null) {
    last = m
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return last
}

/**
 * 从 stryker 日志文本判定**本轮**该段的复用状态（纯函数，便于测试注入任意日志夹具）。
 *
 * 两类事件取「位置靠后」的那一次：日志是追加写的，多次运行的记录会叠在同一份文件里，位置即时间序。
 * 同一次运行内两者互斥（inc 文件缺失时 incremental-differ 根本不会被调用，见 mutant-test-planner 的
 * `if (incrementalReport)`），所以这个比较不会把同一次运行的两个事件混起来。
 *
 * @param {string} logText stryker.log 文本（可含 ANSI 转义、CRLF）
 * @returns {{mode: string, reused?: number, total?: number, evidence?: string, reason?: string, note?: string}}
 *   mode ∈ full / partial / unknown；unknown 一定带 reason（绝不猜）
 */
function parseReuseFromLog (logText) {
  const text = stripAnsi(logText === undefined || logText === null ? '' : logText)
  const full = lastMatch(FULL_RUN_LOG_RE, text)
  const reuse = lastMatch(REUSE_LOG_RE, text)
  if (!full && !reuse) {
    return {
      mode: REUSE_MODE_UNKNOWN,
      reason: '日志中既无「全量运行」也无「复用 N/M」记录（未开 --fileLogLevel info / 日志缺失 / 运行在差异判定之前就失败）'
    }
  }
  if (full && (!reuse || full.index > reuse.index)) {
    return { mode: REUSE_MODE_FULL, evidence: full[0] }
  }
  const reused = Number(reuse[1])
  const total = Number(reuse[2])
  // stryker 自报的数字也要过一遍形状校验：异常形状按「未记录」处理，不参与渲染成看似可信的比例。
  if (!Number.isSafeInteger(reused) || !Number.isSafeInteger(total) || total <= 0 || reused < 0 || reused > total) {
    return { mode: REUSE_MODE_UNKNOWN, reason: `复用记录形状异常（reused=${reuse[1]} total=${reuse[2]}）` }
  }
  // reused === 0：增量文件在，但没有任何结果可复用 ⇒ 语义上就是「本轮全量重算」。
  return reused === 0
    ? { mode: REUSE_MODE_FULL, reused, total, evidence: reuse[0], note: '增量运行无结果可复用' }
    : { mode: REUSE_MODE_PARTIAL, reused, total, evidence: reuse[0] }
}

function reuseRatio (reused, total) {
  return Math.round((reused / total) * 10000) / 10000
}

// CLI 取值（'true'/'false'/'none'，来自 actions/cache 的 cache-hit output）→ reuse.json 的 `cacheHit` 字段。
// 非法值（含 undefined 之外的任何东西）返回 undefined = 不写该字段；参数合法性在 parseReuseArgs 里 fail-closed。
function mapCacheHitArg (raw) {
  if (raw === 'true') return CACHE_HIT_PRIMARY
  if (raw === 'false') return CACHE_HIT_FALLBACK
  if (raw === 'none') return CACHE_HIT_NONE
  return undefined
}

// reuse.json 的 `cacheHit` 字段 → 渲染用值：**只认三态**，字段缺失或取值非法一律降级为 undefined
// （= 未记录）。这是**显示层交叉校验**，不是门禁：绝不抛、也不参与 mode 判定。
function normalizeCacheHitField (raw) {
  return raw === CACHE_HIT_PRIMARY || raw === CACHE_HIT_FALLBACK || raw === CACHE_HIT_NONE ? raw : undefined
}

/**
 * 组装某段的复用元信息（落盘成 reuse.json 的内容）。
 * @param {string} segment 段名（mutation.yml 的 matrix.name）
 * @param {string} logText stryker.log 文本
 * @param {{generatedAt?: string, cacheHit?: string}} [options] cacheHit 为**已归一**的三态之一
 *   （primary/fallback/none）；未传或非法 ⇒ 不写该字段（保持旧形状，向后兼容旧 artifact 读取方）
 * @returns {object} 可 JSON 序列化的元信息
 */
function buildReuseMeta (segment, logText, options = {}) {
  const parsed = parseReuseFromLog(logText)
  const meta = { segment: String(segment), mode: parsed.mode }
  const cacheHit = normalizeCacheHitField(options.cacheHit)
  if (cacheHit) meta.cacheHit = cacheHit
  if (Number.isSafeInteger(parsed.reused) && Number.isSafeInteger(parsed.total) && parsed.total > 0) {
    meta.reused = parsed.reused
    meta.total = parsed.total
    meta.reuseRatio = reuseRatio(parsed.reused, parsed.total)
    meta.highReuse = meta.reuseRatio >= HIGH_REUSE_RATIO
  }
  if (parsed.reason) meta.reason = parsed.reason
  if (parsed.note) meta.note = parsed.note
  if (parsed.evidence) meta.evidence = parsed.evidence
  if (options.generatedAt) meta.generatedAt = options.generatedAt
  return meta
}

// 单次 open + 只对 fd 判定与读取（与 scripts/mutation-json.js 的 readGuardedBytes 同口径：消除
// statSync→readFileSync 的 check-then-use 竞态）。非普通文件 / 超上限 / 读失败一律抛出，由调用侧转成
// 「未记录 + 原因」——复用状态是**可观测性**，不该让段 job 因此变红，但也绝不静默伪装成全量。
function readLogText (logPath, maxBytes = REUSE_LOG_MAX_BYTES) {
  const abs = path.resolve(logPath)
  let fd
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  } catch (err) {
    throw new Error(`无法读取 ${abs}：${err.message}`)
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`无法读取 ${abs}：不是普通文件`)
    if (stat.size > maxBytes) throw new Error(`日志 ${abs} 为 ${stat.size} 字节，超过解析上限 ${maxBytes} 字节：按「未记录」处理（不整份读入）`)
    return fs.readFileSync(fd, 'utf8')
  } finally {
    try {
      fs.closeSync(fd)
    } catch (err) {
      // 关闭失败不覆盖主流程结果；仅 fd 泄漏一种后果，且进程随后退出。
    }
  }
}

// 递归查找 reuse.json（与 findReportJson 同口径：artifact 里是 mutation-reports/mutation-report-<段>/reports/mutation/）
function findReuseJson (dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) // NOSONAR:S8707 报告目录树内递归（根目录已校验）
  } catch (e) {
    return null
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const found = findReuseJson(p)
      if (found) return found
    } else if (e.name === 'reuse.json') {
      return p
    }
  }
  return null
}

// 把 reuse.json 的原始对象归一成渲染用形状；任何形状异常 → unknown + reason（不猜、不抛）
// `cacheHit`（溯源三态）是**显示层交叉校验**、不是门禁：字段缺失或取值非法一律降级为 undefined（= 未记录），
// 既不抛、也不影响 mode 判定（旧 artifact 没有该字段 ⇒ 渲染成「复用来源未记录」，绝不能被读成主 key 命中）。
function normalizeReuseMeta (raw, expectedSeg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: REUSE_MODE_UNKNOWN, reason: `reuse.json 顶层不是 JSON 对象（实际 ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}）` }
  }
  // 段名交叉校验：artifact 被错标/串段时不得把别段的复用状态安到本段头上
  if (raw.segment !== undefined && String(raw.segment) !== String(expectedSeg)) {
    return { mode: REUSE_MODE_UNKNOWN, reason: `reuse.json 段名不一致（${raw.segment} ≠ ${expectedSeg}）` }
  }
  const cacheHit = normalizeCacheHitField(raw.cacheHit)
  if (raw.mode === REUSE_MODE_FULL) {
    const meta = { mode: REUSE_MODE_FULL }
    if (Number.isSafeInteger(raw.reused) && Number.isSafeInteger(raw.total) && raw.total > 0) {
      meta.reused = raw.reused
      meta.total = raw.total
      meta.ratio = reuseRatio(raw.reused, raw.total)
    }
    if (cacheHit) meta.cacheHit = cacheHit
    if (raw.note) meta.note = String(raw.note)
    return meta
  }
  if (raw.mode === REUSE_MODE_PARTIAL) {
    if (!Number.isSafeInteger(raw.reused) || !Number.isSafeInteger(raw.total) || raw.total <= 0 || raw.reused <= 0 || raw.reused > raw.total) {
      return { mode: REUSE_MODE_UNKNOWN, reason: `reuse.json 的 partial 计数非法（reused=${JSON.stringify(raw.reused)} total=${JSON.stringify(raw.total)}）` }
    }
    const ratio = Number.isFinite(raw.reuseRatio) ? raw.reuseRatio : reuseRatio(raw.reused, raw.total)
    const meta = { mode: REUSE_MODE_PARTIAL, reused: raw.reused, total: raw.total, ratio, high: ratio >= HIGH_REUSE_RATIO }
    if (cacheHit) meta.cacheHit = cacheHit
    return meta
  }
  return { mode: REUSE_MODE_UNKNOWN, reason: `reuse.json 的 mode 非法（${JSON.stringify(raw.mode)}）` }
}

/**
 * 从某段的 artifact 目录读取复用状态（缺文件/坏 JSON/形状非法一律降级为「未记录 + 原因」）。
 * @param {string} searchRoot 段目录（递归查找 reuse.json）
 * @param {string} expectedSeg 期望的段名（与 reuse.json 的 segment 交叉校验）
 * @returns {object} 归一后的复用状态（永远可渲染，不抛）
 */
function readReuseMeta (searchRoot, expectedSeg) {
  const found = findReuseJson(searchRoot)
  if (!found) return { mode: REUSE_MODE_UNKNOWN, reason: '缺 reuse.json（本轮未落盘复用状态）' }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(found, 'utf8'))
  } catch (e) {
    return { mode: REUSE_MODE_UNKNOWN, reason: `reuse.json 无法解析：${String((e && e.message) || e)}` }
  }
  return normalizeReuseMeta(raw, expectedSeg)
}

// 表格单元格文案（「每段标注本轮全量 / 复用 N/M / 未记录」）。
// reportTotal（报告的变异体数）是可选的第二参：`0 of M` 分支的「全量」只有在**报告数与日志口径 M 一致**时
// 才敢这么写——计数对不上说明报告里还并入了 sticky 的旧变异体（见 reuseUnaccountedCount），
// 此时标注「口径不符」，细节由「♻️ 复用状态」小节给出。绝不在这里把「有旧结果」写成「全量」。
// 溯源三态只影响**复用来源未变可信**的那一种：`partial + fallback`（主 key 未命中却仍在复用）加 `·兜底`
// 后缀，其余情形（primary / none / 未记录 / full）一字不改。
function formatReuseCell (reuse, reportTotal) {
  if (!reuse || reuse.mode === REUSE_MODE_UNKNOWN) return '未记录'
  if (reuse.mode === REUSE_MODE_PARTIAL) {
    return reuse.cacheHit === CACHE_HIT_FALLBACK ? `复用 ${reuse.reused}/${reuse.total}·兜底` : `复用 ${reuse.reused}/${reuse.total}`
  }
  if (reuseUnaccountedCount({ total: reportTotal, reuse }) !== null) return '全量(口径不符)'
  return '全量'
}

function formatRatio (ratio) {
  return `${(ratio * 100).toFixed(2)}%`
}

/**
 * 写本段的复用状态到 `reports/mutation/reuse.json`（mutation.yml 的「记录本段增量复用状态」step 调用）。
 *
 * 报告存在性闸门是**必须**的：`reports/mutation/` 里若只有 reuse.json，上传步骤的
 * `if-no-files-found: error` 就不再触发，于是「stryker 未产出报告 ⇒ 该段 job 响亮变红」被降级成
 * 「汇总 job 缺段才暴露」——那是 PR #156 有意前移的故障信号，不得回退。因此**只在 mutation.json 已存在时**
 * 才落盘 reuse.json（同目录），否则只打一行提示、什么都不写。
 *
 * @param {{segment: string, logPath: string, outPath: string, cacheHit?: string, now?: Date}} options
 *   cacheHit 是 CLI 的**原始取值**（'true'/'false'/'none'）；缺席 ⇒ reuse.json 不写 `cacheHit` 字段
 * @returns {{written: boolean, outPath: string, meta: object, reason?: string}}
 */
function writeReuseMeta (options) {
  const { segment, logPath, outPath } = options
  const now = options.now instanceof Date ? options.now : new Date()
  const cacheHit = mapCacheHitArg(options.cacheHit)
  const reportPath = path.join(path.dirname(path.resolve(outPath)), 'mutation.json')
  let logText
  let readError
  try {
    logText = readLogText(logPath)
  } catch (e) {
    readError = String((e && e.message) || e)
  }
  const meta = readError
    ? { segment: String(segment), mode: REUSE_MODE_UNKNOWN, reason: `无法读取日志：${readError}`, generatedAt: now.toISOString() }
    : buildReuseMeta(segment, logText, { generatedAt: now.toISOString(), cacheHit })
  if (cacheHit) meta.cacheHit = cacheHit
  if (!fs.existsSync(reportPath)) {
    return { written: false, outPath: path.resolve(outPath), meta, reason: `本段未产出 ${reportPath}（stryker 未完成/崩溃），跳过写 reuse.json：写下去会让上传步骤的 if-no-files-found: error 失效` }
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(meta, null, 2) + '\n')
  return { written: true, outPath: path.resolve(outPath), meta }
}

// ===== runner 档位：逐段披露「该段走哪个 stryker 配置」=========================================
// 背景（独立审查 A2 · F-2）：PR-1 起 mutation.yml 的矩阵**逐段**用 `config` 选 runner——15 段走
// `stryker.tap.config.js`（`coverageAnalysis:'perTest'`，会产出 NoCoverage），4 段留在
// `stryker.config.js`（command 档，`coverageAnalysis:'off'`）。command 档**结构上不产出 NoCoverage**
// （见 mutation.yml 的矩阵注释与 .local/cmd-arts 的同段对照：`{'Killed':369,'Survived':75,'Timeout':1}`
// 里根本没有 NoCoverage 状态）⇒ 这 4 段的 `无覆盖` 恒为 0 是 **runner 的盲区**，不是「已全部覆盖」。
// 不披露 runner 会怎样：这 4 段上新增的 `covered 口径` 必然等于 `分数`（分母相同），再配上表下
// 「NC=0 ⇒ 两列相等」的说明，读者会把「runner 看不见覆盖」读成「不存在未覆盖区域」——与本 PR
// 「让不诚实的可见性浮出来」的立意相反。故日报必须**逐段**披露 runner 档位。
//
// 数据源是 mutation.yml 本身（矩阵是唯一权威，不新增第二份硬编码清单）：
//   * 解析失败（文件缺失/不可读/不是预期结构）一律**降级为「不标注」**——日报的价值在于即使 CI
//     拓扑变了也要能发出来，绝不因为读不到 mutation.yml 而崩；
//   * 解析口径与 scripts/check-mutation-ranges.js 的 include 解析器对齐（include 块边界 + `-` 开头
//     的条目 + 字符串切片取值，避免 `\s*-?\s*` 这类相邻量词被判超线性 S8786）。
const COMMAND_RUNNER_CONFIG = 'stryker.config.js'
const COMMAND_SEGMENT_MARK = '（command 档）'

// yml 标量取值（与 check-mutation-ranges.js 同口径）：引号内的 `#` 属于值、裸标量的 `#` 起行内注释。
function ymlScalar (raw) {
  let value = raw
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    // 连续两个相同引号折叠为一个（yml 转义）；未闭合时回退为去掉开引号取全部（防御性）
    let out = ''
    for (let i = 1; i < value.length; i++) {
      const ch = value[i]
      if (ch !== quote) { out += ch; continue }
      if (value[i + 1] === quote) { out += quote; i++ } else break
    }
    value = out
  } else {
    const hash = value.indexOf('#')
    if (hash !== -1) value = value.slice(0, hash)
  }
  return value.trim()
}

/**
 * 从 mutation.yml 文本解析 matrix 每段的 `config`（runner 档位）。纯函数、**绝不抛**。
 * @param {string} ymlText mutation.yml 文本
 * @returns {Map<string, string>} 段名 → config 文件名；解析不出任何条目时返回空 Map
 */
function parseMatrixRunnerConfigs (ymlText) {
  const map = new Map()
  if (typeof ymlText !== 'string' || ymlText === '') return map
  const lines = ymlText.split(/\r?\n/)
  const includeIdx = lines.findIndex(line => /^\s*include:\s*$/.test(line))
  if (includeIdx === -1) return map
  const includeIndent = lines[includeIdx].match(/^\s*/)[0].length
  let current = null
  for (const line of lines.slice(includeIdx + 1)) {
    const indent = line.match(/^\s*/)[0].length
    if (/^\s*[A-Za-z_][\w-]*:/.test(line) && indent <= includeIndent) break // include 块结束
    const trimmed = line.trim()
    let body = trimmed
    if (trimmed.startsWith('-')) {
      const rest = trimmed.slice(1).trim()
      if (rest === '' || rest.startsWith('#')) continue // `- # 注释` 不算新条目
      current = { name: null, config: null }
      body = rest
    }
    if (!current) continue
    const colon = body.indexOf(':')
    if (colon <= 0) continue
    const key = body.slice(0, colon)
    if (key !== 'name' && key !== 'config') continue
    const value = ymlScalar(body.slice(colon + 1).trim())
    if (!value) continue
    current[key] = value
    if (current.name && current.config) {
      map.set(current.name, current.config)
      current = null // 一条目只登记一次
    }
  }
  return map
}

/**
 * 读取仓库内的 mutation.yml 并解析 runner 档位；**任何失败都降级为空 Map**（不抛、不退出）。
 * @param {string} [matrixPath] 显式矩阵路径（测试注入用）；缺省为 `<repo>/.github/workflows/mutation.yml`
 * @returns {Map<string, string>} 段名 → config 文件名（读不到时为空的 Map ⇒ 调用侧不标注）
 */
function readMatrixRunnerConfigs (matrixPath) {
  const resolved = matrixPath || path.join(__dirname, '..', '.github', 'workflows', 'mutation.yml')
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8') // nosemgrep（路径来自 __dirname 常量或测试注入，非不可信输入）
  } catch (e) {
    return new Map()
  }
  try {
    return parseMatrixRunnerConfigs(text)
  } catch (e) {
    return new Map()
  }
}

/**
 * 段名单元格：command 档段显式标注，其余段原样（不改变任何既有列/数值语义，只加可见性）。
 * @param {string} seg 段名
 * @param {string} [runnerConfig] 该段的 config 文件名（来自矩阵；未知时 undefined）
 * @returns {string} 单元格文本
 */
function formatSegmentLabel (seg, runnerConfig) {
  return runnerConfig === COMMAND_RUNNER_CONFIG ? `${seg}${COMMAND_SEGMENT_MARK}` : String(seg)
}

/**
 * 既有 `分数` 列的四舍五入（段行与合计行**共用同一函数**，防止只改一处静默漂移）。
 * 与 covered 口径不同，分数的分母含 NoCoverage；`total <= 0` 时返回 0（无数据不报 100%，机器人审查）。
 * @param {{total?: number, killed?: number, timeout?: number}} r 段统计（或计数求和后的合计对象）
 * @returns {number} 百分比（两位小数）
 */
function scoreOf (r) {
  const total = r && Number.isFinite(r.total) ? r.total : 0
  if (!(total > 0)) return 0
  const value = (((r.killed || 0) + (r.timeout || 0)) / total) * 100
  return Math.round(value * 100) / 100
}

function analyze (dir, options = {}) {
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
  // runner 档位只读一次（每段共用一个解析结果）；读不到 ⇒ 空 Map ⇒ 全表不标注（见上方 F-2 说明）。
  const runnerConfigs = readMatrixRunnerConfigs(options.matrixPath)
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
    results.push(analyzeSegment(dir, entry, runnerConfigs))
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
function analyzeSegment (dir, entry, runnerConfigs) {
  const seg = entry.name.replace('mutation-report-', '')
  // runner 档位（F-2）：该段在 mutation.yml 矩阵里的 `config`；读不到矩阵时为 undefined（不标注）。
  const runnerConfig = runnerConfigs && typeof runnerConfigs.get === 'function' ? runnerConfigs.get(seg) : undefined
  const reportPath = findReportJson(path.join(dir, entry.name))
  if (!reportPath) return { seg, runnerConfig, error: '缺 mutation-report.json' }
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
    return { seg, runnerConfig, error: `${String(e.message || e)}（报告：${reportPath}）` }
  }
  return {
    seg,
    runnerConfig,
    total: stats.total,
    killed: stats.killed,
    survived: stats.survived,
    noCoverage: stats.noCoverage,
    timeout: stats.timeout,
    // `分数` 的两位小数四舍五入与合计行共用 scoreOf（防止两处各写一份而静默漂移）。
    score: scoreOf(stats),
    survivedMutants: stats.survivedMutants,
    // F1：报告文件时间——内容层面无法区分「本次运行」与「缓存回填的陈旧报告」（stryker 的 json
    // report 不含时间戳），新鲜度闸门（validateFreshness）据此比较各段跨度。stat 失败不单列分支：
    // 上面已成功读到文件，取不到时间只说明文件被并发删除，此时 reportMtimeMs 为 undefined，
    // 该段不参与新鲜度比较（不误红），缺段/损坏仍由 validateSegments 负责。
    reportPath,
    reportMtimeMs: readMtimeMs(reportPath),
    // 复用状态（PR #158 Qodo Medium / Correctness）：段 job 落盘的 reports/mutation/reuse.json 随 artifact
    // 到达这里。读不到/形状非法一律降级为「未记录 + 原因」——它是可观测性，不是门禁，故既不 throw 也不猜；
    // 「未记录」在日报里必须与「全量」区分显示（读者不得把「没记录」读成「没复用」）。
    reuse: readReuseMeta(path.dirname(reportPath), seg)
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

// ===== 双口径：既有「分数」与新增「covered 口径」=================================================
// 背景：CI 从 command runner 切到 tap-runner（coverageAnalysis:'perTest'）后，报告里会首次出现大量
// NoCoverage（19 段合计 4017/15302 ≈ 26%）。同一个段在两种口径下回答的是不同问题：
//   * `分数`（既有列，语义**一字不改**）= (killed + timeout) / total，total **含** NoCoverage
//     ⇒ 保守口径：把「测试没覆盖到」的变异体留在分母里，反映「含未测区域」的真实风险；
//   * `covered 口径`（本次**新增**列）= (killed + timeout) / (killed + timeout + survived)
//     ⇒ 剔除 NoCoverage，只反映「已覆盖部分」的检出能力
//     （与 .local/tap-baseline-REPORT.md 的 covered 口径逐位一致，便于与基线表对账）。
// 两列**并列**是为了让读者能区分两种口径——不是替换任何一个列（尤其不是替换 `分数`）。
//
// 分母为 0（`killed + timeout + survived === 0`，即整段都是 NoCoverage）时**必须显式占位**：
// JS 里 0/0 是 NaN（会渲染成 "NaN%"），而「无数据报 0」（score 列对 total === 0 的处理）在这里会把
// 「整段没有覆盖」误读成「0% 检出」——两者都是误导，故一律显示占位符 `—`。**绝不**产出
// NaN / Infinity / 0%。
const NO_COVERAGE_PLACEHOLDER = '—'

// covered 口径的分母（killed + timeout + survived）。独立成函数是为了让「整段 NoCoverage」这一边界
// 在段行与合计行走**同一条**判定（合计必须按各段计数求和后再算，而不是各段百分比的平均）。
function coveredDenominator (r) {
  return (r.killed || 0) + (r.timeout || 0) + (r.survived || 0)
}

/**
 * 计算 covered 口径（百分比，保留两位小数）。分母为 0 时返回 null，由 formatCovered 渲染成占位符。
 * @param {{killed?: number, timeout?: number, survived?: number}} r 段统计（或计数求和后的合计对象）
 * @returns {number|null} 百分比；口径无法定义（分母为 0）时为 null
 */
function coveredScore (r) {
  const denom = coveredDenominator(r)
  if (!(denom > 0)) return null
  const value = ((r.killed || 0) + (r.timeout || 0)) / denom
  return Math.round(value * 10000) / 100 // 与既有 score 的两位小数口径一致
}

/**
 * covered 口径的单元格文案：有定义给 `N%`，分母为 0 给 `—`（见 NO_COVERAGE_PLACEHOLDER 的注释）。
 * @param {{killed?: number, timeout?: number, survived?: number}} r 段统计
 * @returns {string} 单元格文本
 */
function formatCovered (r) {
  const value = coveredScore(r)
  return value === null ? NO_COVERAGE_PLACEHOLDER : `${value}%`
}

/**
 * 表下口径说明（双口径 + runner 档位）。
 *
 * 为什么必须写在表下、而不只是靠表头两个字：两列只在一部分段上取值不同，读者看到
 * `分数 7.58%` / `covered 口径 35.58%` 时必须能立刻知道差在哪——差就是同一行里被 covered 口径
 * 剔出分母的 NoCoverage（`无覆盖` 列）。纯文本、无计算、无 throw。
 *
 * 第二段（F-2）逐段披露 runner：command 档段（`coverageAnalysis:'off'`）结构上不产出 NoCoverage，
 * 其 `无覆盖` 恒为 0 是 runner 语义、不代表已全部覆盖；这些段的 `covered 口径` 必然等于 `分数`，
 * 与其他段**不同口径**，跨段比较必须排除。段名/计数从 results 的 runnerConfig **推导**（不硬编码
 * 段名清单）：读不到矩阵时退化为不带段名/计数的通用表述，而不是把这段说明整句吞掉。
 *
 * @param {Array<object>} [results] analyzeSegment 的产物（带 runnerConfig 时给出段名与计数）
 * @returns {string[]} markdown 行
 */
function _renderCoveredScopeNote (results) {
  const usable = (Array.isArray(results) ? results : []).filter(r => r && !r.error)
  const commandSegs = usable.filter(r => r.runnerConfig === COMMAND_RUNNER_CONFIG).map(r => r.seg)
  const tapSegs = usable.filter(r => r.runnerConfig && r.runnerConfig !== COMMAND_RUNNER_CONFIG).length
  const runnerNote = commandSegs.length > 0
    ? '⚠️ **command 档段的 `无覆盖` 恒为 0 是 runner 语义**（`coverageAnalysis:\'off\'` 结构上不产出 NoCoverage），' +
      `**不代表已全部覆盖**：本表已逐段标注（${commandSegs.map(s => `\`${s}\``).join('、')}）——` +
      `这 ${commandSegs.length} 段的 score 与其余 ${tapSegs} 段**不同口径**，**跨段比较必须排除**。`
    : '⚠️ **command 档段（`coverageAnalysis:\'off\'`）的 `无覆盖` 恒为 0 是 runner 语义，不代表已全部覆盖**：' +
      '这类段的 `covered 口径` 必然等于 `分数`，与 TAP 档段**不同口径**，**跨段比较必须排除**。'
  return [
    '',
    '> **两种口径**：`分数` = (被杀 + 超时) / **全部**变异体（含 NoCoverage，保守口径）；' +
    '`covered 口径` = (被杀 + 超时) / (被杀 + 超时 + 存活)（**剔除** NoCoverage，只反映已覆盖部分的检出能力）。' +
    '`无覆盖` 列即 NoCoverage 计数：某段 NoCoverage > 0 时 covered ≥ 分数（分母更小），**但两列未必不同**——分子（被杀 + 超时）为 0 **且存活 > 0** 时两列都是 0%（例如 1 个存活 + 1 个无覆盖）；' +
    'NoCoverage = 0 且无其它未计入状态（RuntimeError / CompileError / Ignored / Pending 同样不在 covered 分母里）时两列相等；' +
    '整段 NoCoverage（分母为 0）时 `covered 口径` 显示 `—`（不显示 NaN / 0%）。',
    '> ' + runnerNote
  ]
}

function _renderSegmentTable (results) {
  // 段汇总表（含合计行）：正常段 + error 段分支
  // 双口径：`分数`（既有语义一字不改）与 `covered 口径`（新增列，见上方 coveredScore 注释）并列。
  const lines = []
  lines.push('| 段 | 变异体 | 被杀 | 超时 | 存活 | 无覆盖 | 分数 | covered 口径 | 复用 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  let tTotal = 0
  let tKilled = 0
  let tTimeout = 0
  let tSurvived = 0
  let tNoCoverage = 0
  let reusedSegs = 0
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${formatSegmentLabel(r.seg, r.runnerConfig)} | ❌ ${r.error} | - | - | - | - | - | - | - |`) // 9 列对齐表头（含 covered 口径/复用列）；段名带 command 档标注
      continue
    }
    tTotal += r.total
    tKilled += r.killed
    tSurvived += r.survived
    tTimeout += r.timeout || 0
    tNoCoverage += r.noCoverage || 0
    if (r.reuse && r.reuse.mode === REUSE_MODE_PARTIAL) reusedSegs++
    lines.push(`| ${formatSegmentLabel(r.seg, r.runnerConfig)} | ${r.total} | ${r.killed} | ${r.timeout} | ${r.survived} | ${r.noCoverage} | ${r.score}% | ${formatCovered(r)} | ${formatReuseCell(r.reuse, r.total)} |`)
  }
  // 口径与段分一致（超时计入已处理）；无数据报 0 而非 100（机器人审查）
  // F6：本脚本只汇总，**不设分数门禁**——分数门禁在 stryker 侧（stryker.config.js 的 thresholds，
  // 由每个矩阵 job 各自按段判定，见该文件注释）。**当前 thresholds.break = null（分数不是门禁）**：
  // 分数在测试抖动下不可复现（同配置同段三轮 storage 79.08/82.92/71.02%，极差 11.90pp），且历史
  // 「最低段 69.38%」是含陈旧复用的虚高值、已证伪，故停用；撤回后「全 RuntimeError / 零有效变异体」
  // 改由 mutation.yml 的 fail-closed 守卫（scripts/mutation-guard.js）承担，**不落回本脚本**。
  // 这里**有意**不再加一道：
  // main() 是「先 validateSegments/validateFreshness 再 postIssue」，本脚本 throw 会让不达标时连
  // 日报一起吞掉——而那正是最需要看到分数的时刻。故此处只保留完整性/新鲜度两道 throw。
  // 合计行的 `分数` 与段行共用 scoreOf（同一四舍五入口径，防两处漂移）。
  const overall = scoreOf({ total: tTotal, killed: tKilled, timeout: tTimeout })
  // 合计口径 = 各段**计数求和后**再算，绝不取各段百分比的平均（段大小悬殊时平均会被小段带偏：
  // 例如 100 变异体 50% 与 10 变异体 100% ⇒ 按计数 54.55%，按平均 75%）。covered 口径同理；
  // 整批 NoCoverage（分母为 0）时合计的 covered 同样显示 `—`。`无覆盖` 合计列由空白改为给出
  // NoCoverage 计数汇总——这正是「两列差异」在全批层面的量级。
  lines.push(`| **合计** | **${tTotal}** | **${tKilled}** | **${tTimeout}** | **${tSurvived}** | **${tNoCoverage}** | **${overall}%** | **${formatCovered({ killed: tKilled, timeout: tTimeout, survived: tSurvived })}** | **${reusedSegs} 段复用** |`)
  lines.push(..._renderCoveredScopeNote(results))
  return lines
}

/**
 * 报告里的变异体数 vs 日志复用口径 `M` 的差值（可比且为 0 → null，即「口径一致」）。
 *
 * 为什么需要这个交叉校验（**实测**，不是推测）：`Result: N of M` 的 `M` 是
 * `currentMutants.length`，即**当前 `--mutate` 范围**内生成的变异体数；而 incremental-differ 还有一条
 * sticky 分支（mutants/incremental-differ.js 的 `if (!currentMutantKeys.has(mutantKey) &&
 * !this.isInMutatedScope(...))`）会把**旧增量报告里、已不在当前 mutate 范围**的变异体
 * `{...oldResult}` **原样并入**报告——它们的 status/statusReason 全部来自旧运行，却**既不计入 N
 * 也不计入 M**。于是 `N/M` 只是「旧结果占比」的**下界**。
 *
 * 实测复现（本机最小 stryker 工程 + @stryker-mutator/core@10.0.0，同一份 src.js 内容不改）：
 *   * 先 `--mutate "src.js:1-4"` 跑一次 ⇒ inc.json 含第 1-4 行的变异体；
 *   * 再用 `--mutate "src.js:1-3"`（范围收窄、src 内容未变 ⇒ 缓存 key 不含范围、旧 inc 照旧命中）
 *     ⇒ 日志 `Result:\t\t6 of 6 mutant result(s) are reused.`，**报告里却有 8 个变异体**：
 *     多出的 2 个正是第 4 行（已不在当前范围）的旧变异体，status 沿用旧值。
 *   * 对照组：删掉 inc.json 后用同一 `--mutate "src.js:1-3"` 全量跑 ⇒ 报告恰好 6 个。
 * 该场景在本仓可达（两条机制叠加，**都不要求「源文件完全没变」**）：① `mutation.yml`「恢复增量缓存」
 * step 的 `key:` / `restore-keys:`（该文件是唯一权威，此处不复述）——缓存 key 是
 * `stryker-<段>-cfg-<matrix.config 档位>-<hashFiles(stryker.config.js, stryker.tap.config.js, scripts/tap-shim.js)>-deps-<hashFiles(package-lock.json)>-src-<hashFiles(run_mutation.js, matrix.src)>`
 * （**不含 mutate 范围**），而 `restore-keys` 是带**同一档位名 + 同一配置指纹 + 同一依赖指纹**的兜底前缀
 * `stryker-<段>-cfg-<同一档位>-<同一配置指纹>-deps-<同一依赖指纹>-`
 * ⇒ 主 key 未命中时（源文件变了、或 run_mutation.js / matrix.src 变了）仍会恢复**同档
 * 配置**的最近一条同前缀缓存，旧 `reports/inc-<段>.json` 照样回到工作树；
 * ② 本仓要求大文件增长时**重拆 matrix 的 mutate 行段**（AGENTS.md）⇒ 旧 inc 里落在新范围之外的变异体
 * 被 sticky 分支原样并入报告。
 *
 * @param {object} r analyzeSegment 的产物（含报告口径的 total 与复用口径的 total）
 * @returns {number|null} 差值（>0 报告多、<0 报告少）；口径不可比或一致时 null
 */
function reuseUnaccountedCount (r) {
  if (!r || !r.reuse || !Number.isSafeInteger(r.reuse.total) || r.reuse.total <= 0) return null
  if (!Number.isSafeInteger(r.total)) return null
  const delta = r.total - r.reuse.total
  return delta === 0 ? null : delta
}

/**
 * partial 段行尾的「复用来源」溯源后缀（三种，逐字）。纯显示层：不抛、不改任何统计。
 *
 * 三种取值与三种文案的对应（`cacheHit` 只有 primary/fallback/none 三个合法值，缺失或非法已由
 * normalizeReuseMeta 降级为 undefined）：
 *   * primary    ⇒ 主 key 命中：hashFiles 覆盖的输入未变（复用的可信来源）；
 *   * fallback   ⇒ **兜底复原**：主 key 未命中，结果 = 旧缓存 + 按内容差分复用；
 *   * 其余（none / 缺失）⇒ 复用来源未记录。`none` 在这里并入「未记录」是**有意**的：缓存层明确报告
 *     「主 key 与兜底都没恢复」，于是这些复用到底从哪来就没有记录（接线坏了），由紧随其后的矛盾点名
 *     说清；文案只有三种，不新增第四态。
 * @param {object} reuse 归一后的复用元信息（partial）
 * @returns {string} 逐字后缀
 */
function reuseOriginSuffix (reuse) {
  if (reuse && reuse.cacheHit === CACHE_HIT_PRIMARY) return '（主 key 命中：hashFiles 覆盖的输入未变）'
  if (reuse && reuse.cacheHit === CACHE_HIT_FALLBACK) return '（**兜底复原**：主 key 未命中，结果 = 旧缓存 + 按内容差分复用）'
  return '（复用来源未记录）'
}

/**
 * 复用状态说明段（PR #158 Qodo Medium / Correctness）。
 *
 * 为什么必须有这一段（而不只是表格里加一列）：Qodo 指出的缺陷是「**published segment scores and survivor
 * list describe the old suite**」——读者拿到日报时无法分辨哪些数字来自旧测试状态。只加一列仍可能被略过，
 * 故这里用独立小节把结论讲清楚，并且**每种情形都给结论**（全部全量 / 有复用 / 完全没记录 / 计数口径不符），
 * 避免「没记录」被静默读成「没复用」、也避免「N/M 看着干净」被读成「旧结果占比就这么多」。
 *
 * 溯源三态（issue #167）：在「有复用」之上再回答「**为什么**复用」——partial 段逐条行尾追加
 * primary / fallback / 未记录 三种后缀；存在 fallback 段时另起一段点名「主 key 未命中却仍在复用 ⇒
 * 本段不是全量重算」；存在 `cache-hit=none` 却记录了复用的段时点名「接线可能坏了」。
 * 全部是纯显示层交叉校验（风格对齐 reuseUnaccountedCount）：**不新增第四态、不加 throw**。
 *
 * 分数口径零变化：本函数只读 r.reuse 与 r.total（后者仅用于与复用口径比对，不参与任何统计），
 * 不碰 killed/survived/score，也不产生任何 throw。
 * @param {Array<object>} results analyzeSegment 的产物
 * @returns {string[]} markdown 行
 */
function _renderReuseNotice (results) {
  // error 段没有数据，不参与复用口径（它们由 validateSegments 的缺段/错误分支负责）
  const usable = results.filter(r => !r.error)
  if (usable.length === 0) return []
  const partial = usable.filter(r => r.reuse && r.reuse.mode === REUSE_MODE_PARTIAL)
  const unknown = usable.filter(r => !r.reuse || r.reuse.mode === REUSE_MODE_UNKNOWN)
  // 计数口径不符（见 reuseUnaccountedCount）：N/M 是下界，必须单独点名，不能并进「全量重算」。
  const unaccounted = usable.filter(r => reuseUnaccountedCount(r) !== null)
  // 溯源三态（issue #167）：只有 partial 段才谈得上「复用来源」，故两个新分组都以 partial 为父集。
  //   * fallback：主 key 未命中（输入已变）却仍在复用 ⇒ 本段不是全量重算，必须单独点名；
  //   * contradiction：cache-hit=none 与「记录了复用 N/M」自相矛盾 ⇒ 接线可能坏了（纯显示层交叉校验）。
  const fallback = partial.filter(r => r.reuse.cacheHit === CACHE_HIT_FALLBACK)
  const contradiction = partial.filter(r => r.reuse.cacheHit === CACHE_HIT_NONE)
  const lines = []
  lines.push('## ♻️ 复用状态（结果是否对应当前测试状态）')
  lines.push('')
  if (partial.length === 0 && unknown.length === 0 && unaccounted.length === 0) {
    lines.push(`本轮 ${usable.length} 段全部全量重算（无复用）⇒ 分数与存活清单对应本 commit 的测试状态。`)
    lines.push('')
    return lines
  }
  if (partial.length === 0 && unaccounted.length === 0) {
    lines.push('⚠️ 本次日报**没有任何段的复用状态记录**（reuse.json 缺失或无法解析）⇒ 无法判定哪些段复用了旧结果；' +
      '**不要把这些段的分数/存活清单当作「本 commit 测试状态」下的结果**。')
    lines.push('')
    lines.push(`未记录复用状态的段（${unknown.length}）：${unknown.map(r => `\`${r.seg}\``).join('、')}`)
    lines.push('')
    return lines
  }
  if (partial.length > 0) {
    lines.push('⚠️ **本次日报含未重算的结果**：下列段的部分变异体直接复用了上一次运行的 killed/survived' +
      '（复用来自增量差分对**文件内容未变**的变异体沿用旧结果；**command 档**才会在 `coverageAnalysis:\'off\'` 下' +
      '拿不到覆盖信息时**无条件复用**——各段档位见表内标注），它们描述的是' +
      '**旧测试状态**，不代表本 commit 的测试；存活清单同理。')
    lines.push('')
    for (const r of partial) {
      const ratio = Number.isFinite(r.reuse.ratio) ? r.reuse.ratio : reuseRatio(r.reuse.reused, r.reuse.total)
      const high = r.reuse.high !== undefined ? r.reuse.high : ratio >= HIGH_REUSE_RATIO
      lines.push(`- \`${r.seg}\`：复用 ${r.reuse.reused}/${r.reuse.total}（${formatRatio(ratio)}）` +
        (high ? ` ⚠️ **复用比例高**（≥${formatRatio(HIGH_REUSE_RATIO)}）` : '') +
        reuseOriginSuffix(r.reuse))
    }
    lines.push('')
  }
  // 溯源三态 · 兜底复原点名（issue #167 实测案例 run 35775812104）：主 key 未命中说明 `hashFiles` 覆盖的
  // 输入（含依赖）已变化，而这些段仍在沿用旧缓存的 killed/survived ⇒ 必须明说「本段不是全量重算」，
  // 否则读者会把「复用 N/M」当成「输入未变的直接推论」。纯显示层，不加 throw、不新增第四态。
  if (fallback.length > 0) {
    lines.push('⚠️ **下列段主 key 未命中却仍在复用 ⇒ 本段不是全量重算**：主 key 未命中说明 `hashFiles` 覆盖的输入已变化（或缓存已过期/被逐出），而这些段仍在沿用旧缓存的 killed/survived（增量差分只保证被复用变异体所在的**文件内容**未变，不保证依赖等全局输入未变；依赖已进兜底前缀 ⇒ 依赖变化不会再落到这里）：')
    lines.push('')
    for (const r of fallback) {
      const ratio = Number.isFinite(r.reuse.ratio) ? r.reuse.ratio : reuseRatio(r.reuse.reused, r.reuse.total)
      lines.push(`- \`${r.seg}\`：复用 ${r.reuse.reused}/${r.reuse.total}（${formatRatio(ratio)}）`)
    }
    lines.push('')
  }
  // 溯源三态 · 矛盾点名：cache-hit=none（缓存层明确报告「主 key 与兜底都没恢复」）却记录了复用 N/M
  // ⇒ 只可能是接线坏了（参数没接上 / output 名写错 / 落到别的段）。纯显示层交叉校验，不加 throw。
  if (contradiction.length > 0) {
    lines.push('⚠️ 复用溯源与复用计数自相矛盾（cache-hit=none 却记录了复用 N/M）——接线可能坏了：')
    lines.push('')
    for (const r of contradiction) lines.push(`- \`${r.seg}\``)
    lines.push('')
  }
  if (unaccounted.length > 0) {
    lines.push('⚠️ **复用口径与报告不一致 ⇒ 上列/下列比例只是下界**：`Result: N of M` 的 `M` 只统计' +
      '**当前 `--mutate` 范围**内的变异体，而 incremental-differ 会把旧增量报告中**已不在当前范围**的变异体' +
      '（sticky 分支）**原样并入**报告——它们的 status/statusReason 沿用旧运行，却**不计入 N 也不计入 M**：')
    lines.push('')
    for (const r of unaccounted) {
      const delta = reuseUnaccountedCount(r)
      lines.push(`- \`${r.seg}\`：报告 ${r.total} 个变异体 vs 日志复用口径 ${r.reuse.total} 个` +
        `（${delta > 0 ? `多 ${delta} 个未计入` : `少 ${-delta} 个`}）`)
    }
    lines.push('')
  }
  if (unknown.length > 0) {
    lines.push(`⚠️ 另有 ${unknown.length} 段没有复用状态记录（reuse.json 缺失或无法解析）：` +
      `${unknown.map(r => `\`${r.seg}\``).join('、')}；无法判定其是否复用，**不要假定它们是全量重算**。`)
    lines.push('')
  }
  // 末行必须用**互斥**口径计数：partial 与 unknown 按 mode 天然互斥，但 unaccounted 会与 partial 重叠
  // （一个段既可能「含复用」又「口径对不上」），直接相减会得到负数（本代理在端到端验证时实测到
  // 「其余 -1 段」）。故只把「不在 partial 里的 unaccounted」单列，四类之和恒等于段数。
  const partialSet = new Set(partial)
  const unaccountedOnly = unaccounted.filter(r => !partialSet.has(r)).length
  const cleanFull = usable.length - partial.length - unknown.length - unaccountedOnly
  // 溯源三态只在**兜底段数 > 0** 时追加一句（其余情形末行逐字不变）：四类互斥计数逻辑一字不改。
  lines.push(`其余 ${cleanFull} 段本轮为全量重算（共 ${usable.length} 段：${partial.length} 段含复用、${unknown.length} 段未记录` +
    (unaccountedOnly > 0 ? `、${unaccountedOnly} 段标为全量但复用口径与报告不一致` : '') +
    (fallback.length > 0 ? `、其中 ${fallback.length} 段由兜底缓存复原（主 key 未命中）` : '') + '）。')
  lines.push('')
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
    ..._renderReuseNotice(results),
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

/**
 * 解析 `--reuse` 模式的参数（fail-closed：参数不明/缺取值一律抛错，不静默空转）。
 * 用法：`node scripts/mutation-report.js --reuse --segment <段名> --log <stryker.log> [--out <reuse.json>] [--cache-hit <true|false|none>]`
 *
 * `--cache-hit` 是**可选**参数，取值只接受 true / false / none 三个字符串（actions/cache 的 cache-hit
 * output 经工作流 `|| 'none'` 归一后的形态）：
 *   * 缺席 ⇒ 复用来源**未记录**（向后兼容旧 artifact / 其它调用方，不得报错）；
 *   * 非空但非法 ⇒ 抛错（走 fail-closed：stderr 提示 + 返回 1 + **不写** reuse.json）。
 * @param {string[]} args 去掉 `--reuse` 之后的参数
 * @returns {{segment: string, logPath: string, outPath: string, cacheHit?: string}}
 */
function parseReuseArgs (args) {
  const known = new Set(['--segment', '--log', '--out', '--cache-hit'])
  const values = {}
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(0, eq) : a
    if (!known.has(name)) throw new Error(`未知参数 ${a}`)
    const value = eq > 0 ? a.slice(eq + 1) : args[i + 1]
    if (value === undefined || String(value).trim() === '') throw new Error(`${name} 缺少取值`)
    values[name] = String(value)
    if (eq <= 0) i++
  }
  for (const required of ['--segment', '--log']) {
    if (!values[required]) throw new Error(`缺少必填参数 ${required}`)
  }
  // fail-closed：非空但非法（如 `--cache-hit yes` / `--cache-hit 1`）一律抛错，不得静默当成「未记录」
  // ——静默降级会把「接线写错」伪装成「旧 artifact」，正是 issue #167 要消灭的那类不可见。
  if (values['--cache-hit'] !== undefined && !CACHE_HIT_ARG_VALUES.includes(values['--cache-hit'])) {
    throw new Error(`--cache-hit 取值非法（${JSON.stringify(values['--cache-hit'])}）：只接受 ${CACHE_HIT_ARG_VALUES.join(' / ')}`)
  }
  return {
    segment: values['--segment'],
    logPath: values['--log'],
    outPath: values['--out'] || path.join('reports', 'mutation', 'reuse.json'),
    cacheHit: values['--cache-hit']
  }
}

// `--reuse` 模式的执行体：落盘本段的复用状态。可注入 io 以便测试拿到退出码（不真的结束进程）。
function runReuseMode (argv, io = {}) {
  const out = io.stdout || process.stdout
  const err = io.stderr || process.stderr
  const now = io.now instanceof Date ? io.now : new Date()
  let parsed
  try {
    parsed = parseReuseArgs(argv)
  } catch (e) {
    err.write(`❌ 复用状态参数非法：${String((e && e.message) || e)}\n`)
    err.write('   用法：node scripts/mutation-report.js --reuse --segment <段名> --log <stryker.log> [--out reports/mutation/reuse.json] [--cache-hit <true|false|none>]\n')
    return 1
  }
  const r = writeReuseMeta({ ...parsed, now })
  if (!r.written) {
    out.write(`ℹ️  跳过写复用状态：${r.reason}\n`)
    return 0
  }
  const m = r.meta
  const detail = m.mode === REUSE_MODE_PARTIAL
    ? `复用 ${m.reused}/${m.total}（${formatRatio(m.reuseRatio)}${m.highReuse ? '，复用比例高' : ''}）`
    : m.mode === REUSE_MODE_FULL ? '本轮全量重算' : `未记录（${m.reason || '原因未知'}）`
  out.write(`✅ ${parsed.segment} 复用状态已写入 ${r.outPath}：${detail}\n`)
  if (m.mode === REUSE_MODE_UNKNOWN) {
    // 未记录必须留痕（否则「复用可见」这条链断了却没人知道），但**不置退出码**：它是可观测性，
    // 让段 job 因它变红会把「报告不可信」与「报告缺一个标注」混为一谈（守卫负责前者）。
    out.write('⚠️  未判定出复用状态 ⇒ 日报该段将显示「未记录」（不会被伪装成「全量」）\n')
  }
  return 0
}

async function main () {
  const args = process.argv.slice(2)
  // 复用状态落盘模式：同样必须在读 <reports-dir> 之前分流（否则 --reuse 会被当成目录名走汇总路径）
  const reuseIdx = args.indexOf('--reuse')
  if (reuseIdx !== -1) {
    process.exitCode = runReuseMode([...args.slice(0, reuseIdx), ...args.slice(reuseIdx + 1)])
    return
  }
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
module.exports = {
  analyze,
  validateSegments,
  validateFreshness,
  resolveMaxSkewMs,
  resolveRunStartedAtMs,
  findReportJson,
  analyzeSegment,
  countMutant,
  escCell,
  collectStats,
  render,
  shanghaiDate,
  postIssue,
  EXPECTED_SEGMENTS,
  // 复用状态（PR #158 Qodo Medium / Correctness）
  parseReuseFromLog,
  buildReuseMeta,
  normalizeReuseMeta,
  readReuseMeta,
  findReuseJson,
  writeReuseMeta,
  parseReuseArgs,
  runReuseMode,
  formatReuseCell,
  reuseUnaccountedCount,
  reuseOriginSuffix,
  stripAnsi,
  // 双口径（PR-1 · A2 决策）：既有「分数」与新增「covered 口径」并列
  coveredDenominator,
  coveredScore,
  formatCovered,
  NO_COVERAGE_PLACEHOLDER,
  // runner 档位逐段披露（PR-1 · 审查 A2 的 F-2）
  parseMatrixRunnerConfigs,
  readMatrixRunnerConfigs,
  formatSegmentLabel,
  scoreOf,
  COMMAND_RUNNER_CONFIG,
  COMMAND_SEGMENT_MARK,
  REUSE_MODE_FULL,
  REUSE_MODE_PARTIAL,
  REUSE_MODE_UNKNOWN,
  HIGH_REUSE_RATIO,
  REUSE_LOG_MAX_BYTES,
  // 溯源三态（v3.276 续 · issue #167）
  CACHE_HIT_PRIMARY,
  CACHE_HIT_FALLBACK,
  CACHE_HIT_NONE,
  CACHE_HIT_ARG_VALUES,
  mapCacheHitArg,
  normalizeCacheHitField
}
