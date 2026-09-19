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
    assert.ok(r.stdout.includes(`| **合计** | **${segCount * 2}** | **${segCount}** | **0** | **${segCount}** | | **50%** |`),
      `合计行必须等于夹具统计（${segCount * 2} 变异体 / 各 ${segCount} 被杀与存活 / 50%）：\n${r.stdout}`)
    assert.ok(r.stdout.includes(`## 存活变异体（${segCount} 个）`), '应列出存活变异体总数')
    assert.ok(!r.stdout.includes('🎉 无存活变异体'), '夹具含存活变异体，不得走「无存活」分支')
    for (const seg of REQUIRED_SEGS) {
      assert.ok(r.stdout.includes(`| ${seg} | 2 | 1 | 0 | 1 | 0 | 50% |`), `段 ${seg} 的统计行应正确，实际输出缺该行`)
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
    assert.ok(r.stdout.includes(`| **合计** | **${segCount * 2}** | **${segCount}** | **0** | **0** | | **50%** |`),
      `RuntimeError 应计入 total（${segCount * 2} 个、仅 ${segCount} 个被杀、50%）：\n${r.stdout}`)
    assert.ok(r.stdout.includes('🎉 无存活变异体'), '该夹具无存活变异体，应走 🎉 分支')
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

console.log('test_mutation_report_cli OK')
