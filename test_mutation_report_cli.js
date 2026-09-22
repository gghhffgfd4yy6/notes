'use strict'

// 补 scripts/mutation-report.js 覆盖率：main() CLI 入口的 3 种场景（子进程集成测试）
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, 'scripts', 'mutation-report.js')

// validateSegments 要求的全部分段名——以生产脚本为单一来源，消除双份维护：
// 直接消费导出的常量（mutation-report.js 现已导出 EXPECTED_SEGMENTS；
// 不再从源码文本正则解析——导出后文本解析既多余又脆弱）
const REQUIRED_SEGS = require('./scripts/mutation-report.js').EXPECTED_SEGMENTS
assert.ok(REQUIRED_SEGS.length > 0, '生产脚本 EXPECTED_SEGMENTS 不应为空')
// F-2：段名单元格的 command 档标注——测试消费生产的标注常量与函数（不自造第二份逻辑），
// 但「哪些段被标注」用字面断言咬住，不经过 formatSegmentLabel（见场景 3）。
const { formatSegmentLabel, readMatrixRunnerConfigs, COMMAND_RUNNER_CONFIG, COMMAND_SEGMENT_MARK } = require('./scripts/mutation-report.js')
const RUNNER_CONFIGS = readMatrixRunnerConfigs()
assert.ok(RUNNER_CONFIGS.size > 0, '真实 mutation.yml 必须能解析出 runner 档位（否则下面的标注断言退化为恒真）')
// F-2 靶向：日报必须披露矩阵里 config=stryker.config.js 的那些段。这里**不钉死总量**——矩阵是唯一
// 权威（逐段披露的设计就是随矩阵自动跟随，例如将来某段从 TAP 挪到 command 时日报无需改代码），
// 故只断言「PR-1 登记的保留段都在、且 command 档没有覆盖全部段（否则逐段披露失去对照面）」；
// 场景 3 再逐段断言「stdout 里标注的有无 === 矩阵档位」，把标注机制本身咬住。
const COMMAND_SEGS = [...RUNNER_CONFIGS.entries()].filter(([, cfg]) => cfg === COMMAND_RUNNER_CONFIG).map(([seg]) => seg).sort()
for (const must of ['check-deps', 'qinglong-push', 'storage']) {
  assert.ok(COMMAND_SEGS.includes(must), `${must} 必须仍在 command 档（PR-1 登记：TAP 档下它会被记成 RuntimeError/丢检出），实际 command 档=${COMMAND_SEGS.join('、')}`)
}
assert.ok(COMMAND_SEGS.length < REQUIRED_SEGS.length, 'command 档不得覆盖全部段（否则「逐段披露 runner」没有对照面）')

function runCli (args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' }
  }
}

// stryker json reporter 的必填字段（权威来源：本仓已安装的 mutation-testing-report-schema）：
//   顶层 schemaVersion / thresholds / files；FileResult language / source / mutants；
//   MutantResult id / mutatorName / location / status（取值见 MutantStatus enum）。
// 夹具一律按真 schema 构造——否则「夹具算不算真报告」本身就成了未验证假设：本批前一版夹具缺
// thresholds/source，注释却声称「夹具必须是真 stryker schema」，被独立对抗审查 B 组当场证伪。
const SCHEMA_VERSION = '1.0'
// 与本仓 stryker.config.js 的 thresholds 同口径（真报告里 config.thresholds 就是被解析后的这些值）；
// 本文件只做 schema 形状与统计值断言，不依赖这个数字。
const THRESHOLDS = { high: 80, low: 60, break: 65 }
function mutantOf (over = {}) {
  return {
    id: '0',
    mutatorName: 'BlockStatement',
    replacement: '{}',
    status: 'Killed',
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    ...over
  }
}
function schemaReport (seg, mutants) {
  return {
    schemaVersion: SCHEMA_VERSION,
    thresholds: THRESHOLDS,
    files: { [`${seg}.js`]: { language: 'javascript', source: 'const x = 1\n', mutants } }
  }
}

// 场景 1：无参数 → exit 1 + 用法提示
{
  const r = runCli([])
  assert.strictEqual(r.code, 1, '无参数应 exit 1')
  assert.ok(r.stderr.includes('用法') || r.stderr.includes('mutation-report.js'), '应输出用法提示')
}

// 场景 2：不存在的目录 → exit 1 + 错误提示
{
  const r = runCli(['/nonexistent/path/xyz123'])
  assert.strictEqual(r.code, 1, '不存在的目录应 exit 1')
  assert.ok(r.stderr.includes('不存在') || r.stderr.includes('不可访问'), '应输出目录不存在错误')
}

// 场景 3：有效目录 + 全部分段的 mutation.json → exit 0 + 输出 markdown
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-'))
  try {
    // F3：夹具必须是**真 stryker schema**（见文件头 schemaReport 的说明）。旧夹具写成顶层 mutants
    // （无 files）——既不是 stryker 的产出，也正好掩盖了「files 缺失被当成 0 变异体」的 F2 缺陷。
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify(schemaReport(seg, [
        mutantOf({ id: '0', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', location: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } }, killedBy: ['test.js'] }),
        mutantOf({ id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', location: { start: { line: 7, column: 1 }, end: { line: 7, column: 2 } } })
      ])))
    }

    const r = runCli([tmp])
    assert.strictEqual(r.code, 0, '有效目录应 exit 0, stderr: ' + r.stderr)
    // 断言必须咬住**统计值**：旧断言只查 stdout 含 '变异' 或 '#'，而标题「## 🧬 变异测试日报」
    // 恒含「变异」——统计全部归零、解析彻底失效也照样判绿（并因此把 F2 的缺陷锁成了"正确行为"）。
    const segCount = REQUIRED_SEGS.length
    // 合计行的 `无覆盖` 列由空白改为给出 NoCoverage 计数汇总（PR-1 双口径），covered 口径列随之在
    // 分数列右侧出现：本夹具 NoCoverage = 0 ⇒ 两列相等（50%）。
    assert.ok(r.stdout.includes(`| **合计** | **${segCount * 2}** | **${segCount}** | **0** | **${segCount}** | **0** | **50%** | **50%** |`),
      `合计行必须等于夹具统计（${segCount * 2} 变异体 / 各 ${segCount} 被杀与存活 / NoCoverage 0 / 两口径均 50%）：\n${r.stdout}`)
    assert.ok(r.stdout.includes(`## 存活变异体（${segCount} 个）`), '应列出存活变异体总数')
    assert.ok(!r.stdout.includes('🎉 无存活变异体'), '夹具含存活变异体，不得走「无存活」分支')
    for (const seg of REQUIRED_SEGS) {
      // 段行也一并咬住新列（含末尾的复用列：无 reuse.json ⇒ 未记录）；段名单元格按 mutation.yml 的
      // 真实 runner 档位渲染（F-2：command 档段带「（command 档）」标注，TAP 档段不带）——用生产的
      // formatSegmentLabel，避免测试自造一份标注逻辑而与实现漂移。
      const label = formatSegmentLabel(seg, RUNNER_CONFIGS.get(seg))
      assert.ok(r.stdout.includes(`| ${label} | 2 | 1 | 0 | 1 | 0 | 50% | 50% | 未记录 |`), `段 ${seg}（${label}）的统计行应正确，实际输出缺该行`)
      // 标注的**存在/缺失**必须与矩阵档位一致——这一断言不经过 formatSegmentLabel（否则「标注函数被
      // 改成恒等」时两边同时退化，断言恒真）。它直接咬住 CLI stdout 里的字面段名单元格。
      const annotated = r.stdout.includes(`| ${seg}${COMMAND_SEGMENT_MARK} |`)
      assert.strictEqual(annotated, RUNNER_CONFIGS.get(seg) === COMMAND_RUNNER_CONFIG,
        `${seg} 的 command 档标注必须与 mutation.yml 的 config 一致（实际标注=${annotated}，config=${RUNNER_CONFIGS.get(seg)}）`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 4（F2）：某段的报告是「缓存回填」形状（非 stryker schema、无 files）→ 必须拒绝发布。
// 反例（改动前）：files 缺失使该段统计归 0、无 error、exit 0，日报照发且打印「🎉 无存活变异体！」，
// 缓存回填的陈旧 artifact 被当成满分结果发布。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-stale-'))
  try {
    const staleSeg = REQUIRED_SEGS[0]
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      const payload = seg === staleSeg
        ? { mutants: [mutantOf()], testFiles: ['test.js'] } // 上一次运行/旧格式的残留（刻意非 schema）
        : schemaReport(seg, [mutantOf()])
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify(payload))
    }
    const r = runCli([tmp])
    assert.notStrictEqual(r.code, 0, '含「非本次运行」报告的段必须拒绝发布（exit 非 0）')
    assert.ok(r.stderr.includes('拒绝发布不完整日报'), `应给出拒绝发布提示，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes('缺少 files 映射'), `错误应指出根因是缺少 files 映射，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes(staleSeg), '错误应指出是哪个分段，便于只重跑该段')
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 5（F2）：files 是空映射（或各文件 mutants 均为空）→ 零内容报告同样必须拒绝发布，
// 不能因为「结构齐全」就当满分。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-empty-'))
  try {
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      // 交替两种零内容形态：空 files 映射 / files 非空但 mutants 为空数组。
      // 两种都是 **schema 合法**的形状（files 可为空对象、mutants 可为空数组）——正因如此才需要这道
      // 闸门：schema 允许「没有变异体」，但日报不能把「没有数据」渲染成 🎉 满分。
      const emptyFiles = REQUIRED_SEGS.indexOf(seg) % 2 === 0
      const payload = emptyFiles
        ? { schemaVersion: SCHEMA_VERSION, thresholds: THRESHOLDS, files: {} }
        : schemaReport(seg, [])
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify(payload))
    }
    const r = runCli([tmp])
    assert.notStrictEqual(r.code, 0, '零内容报告必须拒绝发布（exit 非 0）')
    assert.ok(r.stderr.includes('不含任何变异体'), `错误应指出报告不含变异体，实际 stderr：${r.stderr}`)
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 6（CodeRabbit PR #151）：**合法但不在 4 个计数桶里**的状态（RuntimeError / CompileError /
// Ignored / Pending）必须被接受并计入 total，不得因为「只认 Killed/Survived/NoCoverage/Timeout」
// 的白名单而把正常报告整段拒掉。每个段：1 Killed + 1 RuntimeError（total=2、killed=1、survived=0）。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-runtimeerr-'))
  try {
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify(schemaReport(seg, [
        mutantOf({ id: '0' }),
        mutantOf({ id: '1', mutatorName: 'ArrayLiteral', replacement: '[]', status: 'RuntimeError', statusReason: 'boom', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } })
      ])))
    }
    const r = runCli([tmp])
    assert.strictEqual(r.code, 0, `含 RuntimeError 的合法报告必须照常发布，stderr: ${r.stderr}`)
    const segCount = REQUIRED_SEGS.length
    // PR-1 双口径的一个**非 NoCoverage** 差异来源：RuntimeError 计入 total（分数口径分母）但**不在**
    // covered 口径的分母（killed+timeout+survived）里 ⇒ 即使 NoCoverage = 0，两列也会不同
    // （此处 50% vs 100%）。这是所给公式的直接推论，故意在此锁死，防止后人以为「NoCoverage=0 ⇒ 必定相等」。
    assert.ok(r.stdout.includes(`| **合计** | **${segCount * 2}** | **${segCount}** | **0** | **0** | **0** | **50%** | **100%** |`),
      `RuntimeError 应计入 total（${segCount * 2} 个、仅 ${segCount} 个被杀、分数 50%）；covered 口径因不含 RuntimeError 为 100%：\n${r.stdout}`)
    assert.ok(r.stdout.includes('🎉 无存活变异体'), '该夹具无存活变异体，应走 🎉 分支')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 6b（PR-1 · 日报双口径）：**端到端**证明新列真的出现在子进程 stdout 里——
// 「真 mutation.json → analyzeSegment → render → stdout」整条链，而不是直接构造 render 入参。
// 两段刻意各占一个边界：
//   * ncSeg：1 Killed + 2 Survived + 2 NoCoverage ⇒ 分数 = 1/5 = 20%（含 NoCoverage），
//     covered = 1/(1+0+2) = 33.33%（剔除 NoCoverage）⇒ 两列必须不同且 covered > 分数；
//   * allNcSeg：整段 1 个 NoCoverage（killed+timeout+survived === 0）⇒ covered 分母为 0，
//     必须显示占位符 `—`，不得是 NaN / Infinity / 0%。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-dualscope-'))
  try {
    const ncSeg = REQUIRED_SEGS[0]
    const allNcSeg = REQUIRED_SEGS[1]
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      let mutants = [
        mutantOf({ id: '0' }),
        mutantOf({ id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', location: { start: { line: 7, column: 1 }, end: { line: 7, column: 2 } } }),
        mutantOf({ id: '2', mutatorName: 'StringLiteral', replacement: '"x"', status: 'Survived', location: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } } })
      ]
      if (seg === ncSeg) {
        mutants = mutants.concat([
          mutantOf({ id: '3', mutatorName: 'ArrayLiteral', replacement: '[]', status: 'NoCoverage', location: { start: { line: 11, column: 1 }, end: { line: 11, column: 2 } } }),
          mutantOf({ id: '4', mutatorName: 'ObjectLiteral', replacement: '{}', status: 'NoCoverage', location: { start: { line: 13, column: 1 }, end: { line: 13, column: 2 } } })
        ])
      }
      if (seg === allNcSeg) {
        mutants = [mutantOf({ id: '0', mutatorName: 'ArrayLiteral', replacement: '[]', status: 'NoCoverage', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } })]
      }
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify(schemaReport(seg, mutants)))
    }
    const r = runCli([tmp])
    assert.strictEqual(r.code, 0, `含 NoCoverage 的合法报告应照常发布，stderr: ${r.stderr}`)
    assert.ok(r.stdout.includes('| 分数 | covered 口径 |'), '表头必须同时列出两个口径列（新增而非替换）')
    const lineOf = (seg) => r.stdout.split('\n').find(l => l.startsWith(`| ${seg} |`))
    // ncSeg 行（末尾复用列为「未记录」：夹具没有 reuse.json）
    assert.strictEqual(lineOf(ncSeg), `| ${ncSeg} | 5 | 1 | 0 | 2 | 2 | 20% | 33.33% | 未记录 |`,
      `NoCoverage>0 的段必须同排给出两个口径与 NoCoverage 计数：\n${r.stdout}`)
    // 整段 NoCoverage 行：covered 列是占位符（分数列仍是既有的 0%，语义不改）
    assert.strictEqual(lineOf(allNcSeg), `| ${allNcSeg} | 1 | 0 | 0 | 0 | 1 | 0% | — | 未记录 |`,
      `分母为 0 时 covered 列必须是占位符：\n${r.stdout}`)
    const table = r.stdout.split('\n').filter(l => l.startsWith('|')).join('\n')
    assert.ok(!/NaN|Infinity/.test(table), `表格里不得出现 NaN / Infinity：\n${table}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 7（CodeRabbit PR #151 + 独立对抗审查 B 组）：**缺 status**（`{}`）与**未知 status**（`'Bogus'`）
// 都会让 countMutant 先 total++ 再什么都计不进去——零变异体护栏被绕过、分数被压低后照发，两者都必须
// 按段级失败拒绝。B 组反例：本批前一版只要求「非空字符串」，于是 'Bogus' 被接受并计入 total。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-badstatus-'))
  try {
    const missingSeg = REQUIRED_SEGS[0]
    const bogusSeg = REQUIRED_SEGS[1]
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      let mutants = [mutantOf()]
      if (seg === missingSeg) mutants = [{ id: '0', mutatorName: 'BlockStatement', replacement: '{}' }] // 缺 status
      if (seg === bogusSeg) mutants = [mutantOf({ status: 'Bogus' })] // 非空但不在 MutantStatus enum 内
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify(schemaReport(seg, mutants)))
    }
    const r = runCli([tmp])
    assert.notStrictEqual(r.code, 0, '含缺/未知 status 条目的报告必须拒绝发布（exit 非 0）')
    assert.ok(r.stderr.includes('缺失或未知 status'), `错误应指出根因是条目 status 缺失/未知，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes(missingSeg), '错误应指出缺 status 的分段，便于只重跑该段')
    assert.ok(r.stderr.includes(bogusSeg), '错误应指出未知 status 的分段')
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 8（F1）：某段报告「内容完全合法但文件时间远早于其它段」——这正是段 job 崩溃/被 6h 取消时
// actions/cache 回填上一次运行产物的形态。旧实现只做名称/内容级校验 → 陈旧报告照发日报；
// 现必须拒绝发布并指出陈旧段，且把闸门关掉（MUTATION_REPORT_MAX_SKEW_MS=0）后同一夹具应放行
// ——后者证明拒绝确实来自本闸门，而不是别的校验顺手拦下。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-stale-age-'))
  try {
    const staleSeg = REQUIRED_SEGS[2]
    const staleAt = new Date(Date.now() - 30 * 3600 * 1000) // 30 小时前：跨日缓存回填
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      const reportPath = path.join(segDir, 'mutation.json')
      fs.writeFileSync(reportPath, JSON.stringify(schemaReport(seg, [mutantOf()])))
      if (seg === staleSeg) fs.utimesSync(reportPath, staleAt, staleAt)
    }

    const r = runCli([tmp])
    assert.notStrictEqual(r.code, 0, '含陈旧（缓存回填）报告的日报必须拒绝发布（exit 非 0）')
    assert.ok(r.stderr.includes('疑似缓存回填'), `错误应指出根因是缓存回填，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes(staleSeg), '错误应指出陈旧的段名，便于只重跑该段')
    assert.ok(r.stderr.includes('30 小时'), `错误应给出时间偏差便于判断，实际 stderr：${r.stderr}`)
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')

    // 同一夹具 + 关闭闸门 → 必须放行：排除「其它校验碰巧拦下」的假阳性解释
    const rOff = runCli([tmp], { env: { ...process.env, MUTATION_REPORT_MAX_SKEW_MS: '0' } })
    assert.strictEqual(rOff.code, 0, `关闭新鲜度闸门后同一夹具应放行，stderr：${rOff.stderr}`)
    assert.ok(rOff.stdout.includes('🧬 变异测试日报'), '闸门关闭时应正常输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 9（F1 返工 · 同族反例①）：**全体回填**——所有段的报告都来自上一次运行（互差≈0、26h 前）。
// 打回现场：旧闸门只比较「本批最新的那一份」，互差为 0 时恒放行 → 回填的旧报告被当成今日日报发布。
// 现必须按 wall-clock 年龄拒绝；同一夹具把闸门关掉（MUTATION_REPORT_MAX_SKEW_MS=0）后必须放行，
// 证明拒绝确实来自本闸门。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-allbackfill-'))
  try {
    const staleAt = new Date(Date.now() - 26 * 3600 * 1000)
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      const reportPath = path.join(segDir, 'mutation.json')
      fs.writeFileSync(reportPath, JSON.stringify(schemaReport(seg, [mutantOf()])))
      fs.utimesSync(reportPath, staleAt, staleAt) // 全体同刻：跨段偏斜为 0
    }
    const r = runCli([tmp])
    assert.notStrictEqual(r.code, 0, '全体回填的日报必须拒绝发布（exit 非 0）')
    assert.ok(r.stderr.includes('疑似缓存回填'), `错误应指出根因是缓存回填，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes('全体陈旧'), `错误应点名「全体陈旧」这一形态，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes(REQUIRED_SEGS[0]) && r.stderr.includes('26 小时'),
      `错误应逐段给出距今小时数，实际 stderr：${r.stderr}`)
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')

    const rOff = runCli([tmp], { env: { ...process.env, MUTATION_REPORT_MAX_SKEW_MS: '0' } })
    assert.strictEqual(rOff.code, 0, `关闭闸门后同一夹具应放行（排除别处顺手拦下），stderr：${rOff.stderr}`)
    assert.ok(rOff.stdout.includes('🧬 变异测试日报'), '闸门关闭时应正常输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 10（F1 返工 · 同族反例②）：**跨轮 <12h 的同日回填**——全部段都来自同一天的上一次运行
// （互差≈0、11h 前）。年龄层看不见（11h < 12h 阈值），只有「本轮运行起点」层能拦下：CI 由
// mutation.yml 注入 MUTATION_RUN_STARTED_AT=github.run_started_at。不注入时必须放行（本地手工运行
// 日报不得误红）——两条一起构成「该层真的在起作用」的证据。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-sameday-'))
  try {
    const staleAt = new Date(Date.now() - 11 * 3600 * 1000)
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      const reportPath = path.join(segDir, 'mutation.json')
      fs.writeFileSync(reportPath, JSON.stringify(schemaReport(seg, [mutantOf()])))
      fs.utimesSync(reportPath, staleAt, staleAt)
    }
    const noRunStart = runCli([tmp])
    assert.strictEqual(noRunStart.code, 0,
      `未注入本轮起点时 11h 的全体报告在阈值内，必须放行（否则本地手工运行日报会误红），stderr：${noRunStart.stderr}`)

    const r = runCli([tmp], { env: { ...process.env, MUTATION_RUN_STARTED_AT: new Date().toISOString() } })
    assert.notStrictEqual(r.code, 0, '注入本轮运行起点后，同日跨轮回填必须拒绝发布')
    assert.ok(r.stderr.includes('早于本轮运行起点'), `错误应点名「早于本轮运行起点」，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes('11 小时'), `错误应给出折算小时数，实际 stderr：${r.stderr}`)
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 11（F1 返工 · 接线）：report job 必须把本轮运行起点喂给闸门——否则第三层在 CI 里永不生效
// （本机无法执行 Actions，只能对 workflow 文本做结构断言）。
{
  const yml = fs.readFileSync(path.join(__dirname, '.github', 'workflows', 'mutation.yml'), 'utf8')
  assert.ok(/MUTATION_RUN_STARTED_AT:\s*\$\{\{\s*github\.run_started_at\s*\}\}/.test(yml),
    'mutation.yml 的汇总步骤必须注入 MUTATION_RUN_STARTED_AT: ' + '${' + '{ github.run_started_at }}')
}

// 场景 12（F1 返工 · workflow 兜底层）：清理缓存回填的旧报告是 mtime 不可靠时**唯一不依赖文件时间**
// 的防线（崩溃段没有 mutation.json → validateSegments 直接拒绝）。V4 打回的两个洞：
//   ① 没有 `if: always()`：位于它之前、可能失败的步骤（npm ci / 下载+验证 re2）一旦失败，清理被跳过，
//      而「上传变异报告」是 `if: always()` → 回填报告仍被上传。必须补 `if: always()` **并前置到
//      缓存恢复之后**（两层才真正互补）；
//   ② `rm -rf reports/mutation reports/mutation.html` 的第二个路径是死参数（stryker 默认
//      reports/mutation/mutation.html，schema:754/766）→ 精简为只删目录。
{
  const yml = fs.readFileSync(path.join(__dirname, '.github', 'workflows', 'mutation.yml'), 'utf8')
  const all = yml.split('\n')
  // 只在 matrix job（`  mutation:` … 下一个顶层 job）里定位步骤：prepare-re2 也有「安装依赖」等同名步骤，
  // 全文 findIndex 会命中上一个 job。
  const jobStart = all.findIndex(l => /^ {2}mutation:\s*$/.test(l))
  let jobEnd = all.length
  for (let i = jobStart + 1; i < all.length; i++) {
    if (/^ {2}\S/.test(all[i])) { jobEnd = i; break }
  }
  assert.ok(jobStart >= 0 && jobEnd > jobStart, 'mutation.yml 必须能定位 matrix job（  mutation: … 下一个顶层 job）')
  const lines = all.slice(jobStart, jobEnd)
  const stepStart = (name) => lines.findIndex(l => l.trim() === `- name: ${name}`)
  const stepBlock = (name) => {
    const start = stepStart(name)
    assert.ok(start >= 0, `mutation.yml 必须存在步骤「${name}」`)
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.startsWith('- uses:') || t.startsWith('- name:') || t.startsWith('- id:')) { end = i; break }
    }
    return { text: lines.slice(start, end).join('\n'), start }
  }
  const cleanup = stepBlock('清理缓存回填的旧报告')
  const restore = stepStart('恢复增量缓存')
  const install = stepStart('安装依赖')
  const stryker = stepStart('变异测试（' + '${' + '{ matrix.name }}）')
  assert.ok(restore >= 0 && install >= 0 && stryker >= 0,
    '矩阵 job 的步骤名必须可定位（恢复增量缓存 / 安装依赖 / 变异测试）')
  // S8786（超线性回溯）：`^\s*if: always\(\)\s*$/m` 在 m 模式下 \s 可跨行，首尾两个空量词会对
  // 同一串反复重扫，被静态分析判为 super-linear；改为「逐行 trim 后整行相等」的线性扫描，
  // 语义等价——真实 yml 里该断言要的就是 if: always() 独占一行（允许缩进与行尾空白）。
  assert.ok(cleanup.text.split('\n').some(line => line.trim() === 'if: always()'),
    'F1 兜底：清理步骤必须带 if: always()（其前序步骤失败时不得被跳过，否则回填报告仍会被 if: always() 的上传步骤带上）')
  assert.ok(cleanup.start > restore, 'F1 兜底：清理步骤必须前置在「恢复增量缓存」之后（否则缓存里的旧报告先被恢复、没人清）')
  assert.ok(cleanup.start < install, 'F1 兜底：清理步骤必须在「安装依赖」等可能失败的步骤之前')
  assert.ok(cleanup.start < stryker, 'F1 兜底：清理步骤必须在 stryker 之前（否则清掉的是本次产出）')
  assert.ok(/run:\s*rm -rf reports\/mutation\s*$/m.test(cleanup.text),
    `F1 兜底：清理命令必须恰为 rm -rf reports/mutation，实际：${JSON.stringify(cleanup.text)}`)
  assert.ok(!cleanup.text.includes('reports/mutation.html'),
    'reports/mutation.html 是死参数（stryker 实际默认 reports/mutation/mutation.html），必须精简掉')
}

// 场景 13（F-04）：--strip 缺文件参数 → exit 1 + 用法（不得被当成目录名去走汇总路径）
{
  const r = runCli(['--strip'])
  assert.strictEqual(r.code, 1, '--strip 不带文件应 exit 1')
  assert.ok(r.stderr.includes('用法'), `应输出用法提示，实际 stderr：${r.stderr}`)
  // 必须走 --strip 自己的分支：旧实现没有该分支，会把 `--strip` 当目录名而报「报告目录不存在」
  // （那条路径同样 exit 1、同样含「用法」，只断言 code/用法 会放过它）——本条钉死分流顺序。
  assert.ok(!r.stderr.includes('报告目录不存在'),
    `--strip 不得被当成报告目录名（必须在读取 <reports-dir> 之前分流），实际 stderr：${r.stderr}`)
}

// 场景 14（F-04，核心）：落盘剥离 + **日报正文逐字节不变**。
// 剥离的意义是「artifact 不再背 statusReason 这份纯废重」（真实 artifact 实测占报告 99.89%），
// 而剥离绝不能改门禁语义——本场景用最强口径证明：同一夹具剥离前后的日报正文（含段汇总表/合计行/
// 存活清单）必须逐字节相同；若剥离动了任何消费方读到的字段，这里的 markdown 必然出现差异。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-strip-'))
  try {
    const longReason = 'runner output "quoted" \\ escaped\n'.repeat(10000) // ≈ 280 KB/条，量级同真实报告
    const reportPaths = []
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      const p = path.join(segDir, 'mutation.json')
      fs.writeFileSync(p, JSON.stringify(schemaReport(seg, [
        mutantOf({ id: '0' }),
        mutantOf({ id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', statusReason: longReason, location: { start: { line: 7, column: 1 }, end: { line: 7, column: 2 } } })
      ])))
      reportPaths.push(p)
    }
    const beforeOut = runCli([tmp])
    assert.strictEqual(beforeOut.code, 0, `夹具必须能正常出日报，stderr：${beforeOut.stderr}`)
    const sizeBefore = reportPaths.map(p => fs.statSync(p).size)

    const strip = runCli(['--strip', ...reportPaths])
    assert.strictEqual(strip.code, 0, `--strip 应 exit 0，stderr：${strip.stderr}`)
    assert.ok(strip.stdout.includes('🧹'), `应逐文件报告剥离动作，实际 stdout：${strip.stdout}`)
    // 不用正则判定「xx.x%」：`\d+\.\d+%` 会被 SonarCloud S8786 判为潜在超线性回溯（本场景是本 PR 新增代码），
    // 改为按空白切 token 后逐项判断（线性、语义等价）：token 含 `%` 且 `parseFloat` 能解析出有限数字即算报告了比例
    // （真实输出形如「…（省 370000，99.87%）」，百分比后还跟全角右括号，故不能用 endsWith('%')）。
    const hasPercentRatio = strip.stdout.split(/\s+/).some(tok =>
      tok.includes('%') && Number.isFinite(Number.parseFloat(tok)))
    assert.ok(hasPercentRatio, `应报告缩小比例，实际 stdout：${strip.stdout}`)

    let shrunk = 0
    for (let i = 0; i < reportPaths.length; i++) {
      const p = reportPaths[i]
      const txt = fs.readFileSync(p, 'utf8')
      assert.ok(!/"statusReason"\s*:\s*"[^"]/.test(txt), `${p} 落盘后不得含非空 statusReason`)
      assert.ok(fs.statSync(p).size < sizeBefore[i], `${p} 应被真正缩小`)
      assert.ok(fs.statSync(p).size < 16 * 1024, `${p} 剥离后应只剩骨架级体积，实际 ${fs.statSync(p).size}`)
      shrunk++
    }
    assert.strictEqual(shrunk, REQUIRED_SEGS.length, '全部段报告都应被处理')

    const afterOut = runCli([tmp])
    assert.strictEqual(afterOut.code, 0, `剥离后仍必须能出日报，stderr：${afterOut.stderr}`)
    assert.strictEqual(afterOut.stdout, beforeOut.stdout,
      '剥离前后日报正文必须逐字节一致（聚合/闸门语义零变化）')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 15（F-04）：--strip 对不存在的文件必须 fail-closed（exit 非 0 并点名），不得静默跳过——
// artifact 会不会瘦身是性能问题，但「以为剥了其实没剥」会让 F-04 静默回退。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-strip-missing-'))
  try {
    const missing = path.join(tmp, 'not-there.json')
    const r = runCli(['--strip', missing])
    assert.notStrictEqual(r.code, 0, '不存在的文件必须 exit 非 0')
    assert.ok(r.stderr.includes('剥离失败'), `应报告剥离失败，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes(missing), '应点名失败的文件路径')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 16（F-04）：写侧不得绕过预读上限——XBK_MUTATION_REPORT_MAX_BYTES 经生产调用方注入后，
// 超限文件必须拒绝且**原文件逐字节不变**（与读侧同一条 readGuardedBytes 路径）。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-strip-cap-'))
  try {
    const p = path.join(tmp, 'mutation.json')
    fs.writeFileSync(p, JSON.stringify(schemaReport(REQUIRED_SEGS[0], [
      mutantOf({ id: '0', statusReason: 'x'.repeat(5000) })
    ])))
    const before = fs.readFileSync(p)
    const r = runCli(['--strip', p], { env: { ...process.env, XBK_MUTATION_REPORT_MAX_BYTES: '16' } })
    assert.notStrictEqual(r.code, 0, '超过预读上限必须 exit 非 0')
    assert.ok(r.stderr.includes('超过预读上限'), `stderr 应说明超限根因，实际：${r.stderr}`)
    assert.deepStrictEqual(fs.readFileSync(p), before, '失败时原文件必须逐字节不变')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 场景 17（F-04 · 接线；PR #156 返工后口径）：落盘剥离必须接在 CI 的「stryker 产出之后、上传 artifact
// 之前」——放在上传之后就只是白跑（artifact 早已带上剥离前的体积）；必须 if: always()（与「清理缓存
// 回填的旧报告」「上传变异报告」同口径）。**剥离范围自 PR #156 起收窄为只剥机器报告**：
//   * reports/mutation/mutation.json —— 剥离（消费方 readReportJson 本就把该字段读成空串，语义零变化）；
//   * reports/inc-*.json —— **不得剥离**：它是下一次运行 incremental-differ 的复用输入，statusReason 会被
//     原样透传进新产出的 JSON/HTML，在这里置空串会让被复用变异体「为什么存活/报错」永久丢失
//     （Qodo Medium / Observability）。
// 另：断言只看 `run: |` 的 **shell 正文**（不认注释）——否则把剥离目标写进注释、代码改回去也能骗过
// `text.includes(...)`，等于门禁被注释糊过去（本场景上一版正是这样：inc 断言只由注释满足）。
{
  const ymlPath = path.join(__dirname, '.github', 'workflows', 'mutation.yml')
  // 抽成按文本取用的函数，是为了让紧随其后的反例在**同一套提取+断言代码**上跑真实 workflow 的变异副本。
  const assertStripContract = (ymlText) => {
    const all = ymlText.split('\n')
    const jobStart = all.findIndex(l => /^ {2}mutation:\s*$/.test(l))
    let jobEnd = all.length
    for (let i = jobStart + 1; i < all.length; i++) {
      if (/^ {2}\S/.test(all[i])) { jobEnd = i; break }
    }
    assert.ok(jobStart >= 0 && jobEnd > jobStart, 'mutation.yml 必须能定位 matrix job')
    const job = all.slice(jobStart, jobEnd)
    const stepAt = (name) => job.findIndex(l => l.trim() === `- name: ${name}`)
    const stripAt = stepAt('剥离报告中的 statusReason（artifact/缓存瘦身）')
    const strykerAt = stepAt('变异测试（' + '${' + '{ matrix.name }}）')
    const uploadAt = stepAt('上传变异报告')
    assert.ok(stripAt >= 0, 'mutation.yml 的 matrix job 必须存在「剥离报告中的 statusReason」步骤')
    assert.ok(strykerAt >= 0 && uploadAt >= 0, '必须能定位变异测试与上传变异报告步骤')
    assert.ok(stripAt > strykerAt, '剥离必须在 stryker 产出之后（否则剥的是缓存回填的旧报告）')
    assert.ok(stripAt < uploadAt, '剥离必须在上传 artifact 之前（放到上传之后等于白跑）')
    let stepEnd = job.length
    for (let i = stripAt + 1; i < job.length; i++) {
      const t = job[i].trim()
      if (t.startsWith('- uses:') || t.startsWith('- name:') || t.startsWith('- id:')) { stepEnd = i; break }
    }
    const text = job.slice(stripAt, stepEnd).join('\n')
    assert.ok(text.split('\n').some(l => l.trim() === 'if: always()'),
      '剥离步骤必须带 if: always()（stryker 失败时不得被跳过；此时步骤内显式筛掉不存在的文件）')
    // 取 `run: |` 之后的 shell 正文（缩进深于 run: 的行）作为唯一判据：注释不算证据——
    // 注释行必须在这里剔除，否则把活动命令整行改成 `# node scripts/…` 后正文里仍带着命令原文，
    // `includes('node scripts/mutation-report.js --strip')` 会被注释满足（CI 不再剥离而套件全绿）。
    const stepLines = text.split('\n')
    const runAt = stepLines.findIndex(l => l.trim() === 'run: |')
    assert.ok(runAt >= 0, '剥离步骤必须以 `run: |` 执行 shell（否则无从核对剥离目标）')
    const runIndent = stepLines[runAt].length - stepLines[runAt].trimStart().length
    const shellBody = []
    for (let i = runAt + 1; i < stepLines.length; i++) {
      if (stepLines[i].trim() === '' || (stepLines[i].length - stepLines[i].trimStart().length) <= runIndent) break
      if (stepLines[i].trim().startsWith('#')) continue // shell 注释不是证据
      shellBody.push(stepLines[i])
    }
    const shell = shellBody.join('\n')
    assert.ok(shell.includes('reports/mutation/mutation.json'), '剥离必须覆盖 stryker 的 mutation.json')
    assert.ok(!shell.includes('reports/inc-'),
      '剥离**不得**再覆盖 reports/inc-*.json（PR #156 返工，Qodo Medium）：inc 是下一次运行的增量复用输入，' +
      '把 statusReason 置空会让被复用变异体的存活/报错原因永久丢失；只看 shell 正文，注释里写什么都不算证据')
    assert.ok(shell.includes('node scripts/mutation-report.js --strip'), '剥离必须经生产 CLI 执行（不得内联脚本）')
  }
  assertStripContract(fs.readFileSync(ymlPath, 'utf8'))

  // 反例（端到端）：注释不能当证据。把真实 mutation.yml 里**活动**的剥离命令整行改成 shell 注释
  // （注释文本原样保留命令），落成临时文件再读回，仍走上面同一套提取+断言 ⇒ 必须红。
  // 一旦去掉注释行过滤，本反例会失败（正向断言被注释满足，断言骗得过门禁）。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-strip-comment-'))
    try {
      const fixture = path.join(dir, 'mutation.yml')
      const real = fs.readFileSync(ymlPath, 'utf8')
      const commented = real.replace(/(^[ \t]*)node scripts\/mutation-report\.js --strip/m,
        '$1# node scripts/mutation-report.js --strip')
      assert.notStrictEqual(commented, real,
        '反例夹具必须真的把活动命令行改成了注释（没改成本回归形同虚设）')
      assert.ok(/^[ \t]*# node scripts\/mutation-report\.js --strip/m.test(commented) &&
        !/^[ \t]*node scripts\/mutation-report\.js --strip/m.test(commented),
      '夹具中该命令应只剩注释形态（否则反例证明的不是「注释骗不过去」）')
      fs.writeFileSync(fixture, commented)
      assert.throws(() => assertStripContract(fs.readFileSync(fixture, 'utf8')),
        /剥离必须经生产 CLI/,
        '活动命令被改成注释后必须红：注释行不得再满足正向断言（旧实现只按缩进截断，注释里的命令原文照样入选）')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

// 场景 18（PR #158 Qodo Medium / Correctness）：`--reuse` 落盘模式的端到端行为。
// 三个契约：
//   ① 有报告 + 有日志 ⇒ 落盘 reuse.json（段名/模式/复用数/总数/比例/原文证据齐全）；
//   ② **无报告 ⇒ 一个字都不许写**（连目录都不建）——否则崩溃段因多出 reuse.json 让
//      reports/mutation/ 非空，上传步的 `if-no-files-found: error` 失效，「stryker 没产出报告 ⇒
//      段 job 响亮变红」被降级成「汇总 job 缺段才暴露」（PR #156 有意前移的故障信号）；
//   ③ 参数非法 ⇒ exit 1（fail-closed，不得静默按默认值跑）。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-reuse-cli-'))
  try {
    const log = path.join(dir, 'stryker.log')
    // 实测日志原文（本机最小 stryker 工程 + @stryker-mutator/core@10.0.0）
    fs.writeFileSync(log, '11:21:39 (9070) INFO IncrementalDiffer Incremental report:\n' +
      '\tMutants:\t0 files changed (+0 -0)\n' +
      '\tResult:\t\t10 of 13 mutant result(s) are reused.\n')
    const out = path.join(dir, 'reports', 'mutation', 'reuse.json')

    // ② 先测「无报告 ⇒ 不写」：此时目录还不存在
    const skipped = runCli(['--reuse', '--segment', 'app', '--log', log, '--out', out])
    assert.strictEqual(skipped.code, 0, `无报告时应跳过并 exit 0，stderr: ${skipped.stderr}`)
    assert.ok(skipped.stdout.includes('跳过写复用状态'), '应打印跳过原因（否则「复用状态没落盘」在 CI 里无声无息）')
    assert.strictEqual(fs.existsSync(out), false, '无 mutation.json 时不得写 reuse.json')
    assert.strictEqual(fs.existsSync(path.dirname(out)), false, '无 mutation.json 时连目录都不该创建')

    // ① 有报告 ⇒ 落盘
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(out), 'mutation.json'), '{"files":{}}')
    const ok = runCli(['--reuse', '--segment', 'app', '--log', log, '--out', out])
    assert.strictEqual(ok.code, 0, `有报告时应 exit 0，stderr: ${ok.stderr}`)
    assert.ok(ok.stdout.includes('复用 10/13'), `stdout 应报出复用数：${ok.stdout}`)
    const meta = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.strictEqual(meta.segment, 'app')
    assert.strictEqual(meta.mode, 'partial')
    assert.strictEqual(meta.reused, 10)
    assert.strictEqual(meta.total, 13)
    assert.strictEqual(meta.highReuse, true)
    assert.ok(meta.evidence.includes('Result:\t\t10 of 13 mutant result(s) are reused.'),
      'evidence 必须留 stryker 日志原文（人工可复核判定源）')

    // ③ 参数非法 ⇒ exit 1
    for (const args of [['--reuse', '--segment', 'app'], ['--reuse', '--log', log], ['--reuse', '--segmnt', 'app', '--log', log]]) {
      const bad = runCli(args)
      assert.strictEqual(bad.code, 1, `参数非法应 exit 1：${args.join(' ')}`)
      assert.ok(bad.stderr.includes('参数非法'), `应给出参数非法提示：${bad.stderr}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 场景 19（PR #158 · 接线）：复用状态的**生产链路**必须接全，否则日报永远显示「未记录」而没人发现。
// 链路三段（缺任一段，功能静默失效）：
//   ① 「变异测试」step 必须带 `--fileLogLevel info` —— stryker 默认 fileLogLevel 是 off，不写 stryker.log；
//      而报告本身没有复用维度（mutation-testing-report-schema 的 MutantResult 无任何 reuse 字段），
//      日志是唯一判定源 ⇒ 少了这个 flag，「复用可见」整条链失效且**没有任何报错**；
//   ② 必须存在「记录本段增量复用状态」step：if: always()、经生产 CLI `node scripts/mutation-report.js --reuse`、
//      带 --segment/--log/--out 三个参数（不得内联脚本，否则与用例/文档漂移）；
//   ③ 顺序：stryker → 本 step → 上传 artifact（在 stryker 之前没日志可读；在上传之后 reuse.json 进不了
//      artifact，汇总 job 拿不到 ⇒ 日报照旧显示「未记录」）。
// 断言只读**活动 YAML 行**（注释不算证据），并配两条靶向反例。
{
  const ymlPath = path.join(__dirname, '.github', 'workflows', 'mutation.yml')
  const assertReuseContract = (ymlText) => {
    const all = ymlText.split('\n')
    const jobStart = all.findIndex(l => /^ {2}mutation:\s*$/.test(l))
    let jobEnd = all.length
    for (let i = jobStart + 1; i < all.length; i++) {
      if (/^ {2}\S/.test(all[i])) { jobEnd = i; break }
    }
    assert.ok(jobStart >= 0 && jobEnd > jobStart, 'mutation.yml 必须能定位 matrix job')
    const job = all.slice(jobStart, jobEnd)
    const stepAt = (name) => job.findIndex(l => l.trim() === `- name: ${name}`)
    const strykerAt = stepAt('变异测试（' + '${' + '{ matrix.name }}）')
    const reuseAt = stepAt('记录本段增量复用状态（' + '${' + '{ matrix.name }}）')
    const uploadAt = stepAt('上传变异报告')
    assert.ok(strykerAt >= 0 && uploadAt >= 0, '必须能定位变异测试与上传变异报告步骤')
    assert.ok(reuseAt >= 0, 'mutation.yml 必须存在「记录本段增量复用状态」step：' +
      '它是「复用可见」（PR #158 Qodo Medium）的唯一落盘点，被删掉后日报会静默退回「未记录」而无人察觉')
    // ① stryker 的**活动** run 行必须带 --fileLogLevel info（注释里写不算）
    const strykerRun = (job.slice(strykerAt, reuseAt).find(l => l.trim().startsWith('run:')) || '').trim()
    assert.ok(strykerRun.startsWith('run: npx stryker run'), '变异测试 step 的 run 行应是 stryker 命令')
    assert.match(strykerRun, /--fileLogLevel info(\s|$)/,
      'stryker 运行行必须带 `--fileLogLevel info`（默认 fileLogLevel=off ⇒ 不写 stryker.log ⇒ 复用状态永远「未记录」）')
    // ② 本 step 的契约
    let reuseEnd = job.length
    for (let i = reuseAt + 1; i < job.length; i++) {
      const t = job[i].trim()
      if (t.startsWith('- uses:') || t.startsWith('- name:') || t.startsWith('- id:')) { reuseEnd = i; break }
    }
    const reuseStep = job.slice(reuseAt, reuseEnd)
    assert.ok(reuseStep.some(l => l.trim() === 'if: always()'),
      '复用状态 step 必须带 if: always()：stryker 失败/超时时也要把「没判出来」如实落盘（否则该段连「未记录」都没有）')
    const reuseRun = (reuseStep.find(l => l.trim().startsWith('run:')) || '').trim()
    assert.ok(reuseRun.includes('node scripts/mutation-report.js --reuse'),
      '必须经生产 CLI `node scripts/mutation-report.js --reuse` 执行（内联脚本会与用例/文档漂移）')
    assert.match(reuseRun, /--segment\s+"\$\{\{\s*matrix\.name\s*\}\}"/,
      '必须带 --segment "$' + '{' + '{ matrix.name }}"（与 mutation.yml 的 matrix 变量同源）')
    assert.match(reuseRun, /--log\s+stryker\.log(\s|$)/, '必须带 --log stryker.log（与 --fileLogLevel info 的落点一致）')
    assert.match(reuseRun, /--out\s+reports\/mutation\/reuse\.json(\s|$)/,
      '必须带 --out reports/mutation/reuse.json：只有这个目录会随 artifact 到汇总 job')
    // ③ 顺序
    assert.ok(reuseAt > strykerAt, '复用状态 step 必须在 stryker 之后（之前没有 stryker.log 可读）')
    assert.ok(reuseAt < uploadAt, '复用状态 step 必须在上传 artifact 之前（之后写就进不了 artifact，日报拿不到）')
  }
  assertReuseContract(fs.readFileSync(ymlPath, 'utf8'))

  // 反例 A（靶向）：只把**活动 run 行**上的 --fileLogLevel info 删掉 ⇒ 同一套提取+断言必须红。
  // 必须锚在 `run: npx stryker run` 那一行：注释里也写着 `--fileLogLevel info`，若用宽松的
  // `replace(/ --fileLogLevel info/m)`，被删掉的是注释里那处（活动行仍在）⇒ 反例根本不成立。
  {
    const real = fs.readFileSync(ymlPath, 'utf8')
    const stripped = real.replace(/^( *run: npx stryker run .*?) --fileLogLevel info$/m, '$1')
    assert.notStrictEqual(stripped, real, '反例夹具必须真的从活动 run 行删掉了 --fileLogLevel info（没改成本回归形同虚设）')
    assert.ok(!/^ *run: npx stryker run .*--fileLogLevel info$/m.test(stripped), '夹具中活动 run 行应已不含该 flag')
    assert.throws(() => assertReuseContract(stripped), /--fileLogLevel info/,
      '去掉活动 run 行的 --fileLogLevel info 后必须红：否则「日志判定源」被静默切断而套件仍全绿')
  }
  // 反例 B（靶向）：把复用状态 step 挪到上传之后 ⇒ 必须红（artifact 里不会有 reuse.json）。
  // 以**行**为单位搬移（按 6 空格缩进的 step 起点切块），不能按字符串首尾切片——那会把整块搬到文件末尾
  // （跑到 report job 之后），断言红的原因就变成「找不到 step」而不是「顺序不对」，反例证明不了要证的事。
  {
    const real = fs.readFileSync(ymlPath, 'utf8')
    const lines = real.split('\n')
    const stepStartRe = /^ {6}- (?:name|uses|id):/
    const blockEnd = (arr, at) => {
      for (let i = at + 1; i < arr.length; i++) {
        if (stepStartRe.test(arr[i])) return i
      }
      return arr.length
    }
    const reuseName = '记录本段增量复用状态（' + '${' + '{ matrix.name }}）'
    const reuseAt = lines.findIndex(l => l.trim() === `- name: ${reuseName}`)
    assert.ok(reuseAt > 0, '夹具必须能定位复用状态 step')
    const block = lines.slice(reuseAt, blockEnd(lines, reuseAt))
    const rest = [...lines.slice(0, reuseAt), ...lines.slice(blockEnd(lines, reuseAt))]
    const upAt = rest.findIndex(l => l.trim() === '- name: 上传变异报告')
    assert.ok(upAt > 0, '夹具必须能定位上传变异报告 step')
    const upEnd = blockEnd(rest, upAt)
    const moved = [...rest.slice(0, upEnd), ...block, ...rest.slice(upEnd)].join('\n')
    assert.notStrictEqual(moved, real, '反例夹具必须真的挪动了 step')
    assert.ok(moved.indexOf(`- name: ${reuseName}`) > moved.indexOf('- name: 上传变异报告'),
      '夹具中复用状态 step 必须已排在上传之后（否则反例证明的不是「顺序错会红」）')
    assert.throws(() => assertReuseContract(moved), /必须在上传 artifact 之前/,
      '把复用状态 step 挪到上传之后必须红：否则 artifact 里没有 reuse.json，日报永远「未记录」而套件仍全绿')
  }
}

console.log('test_mutation_report_cli OK')
