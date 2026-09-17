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
    // F3：夹具必须是**真 stryker schema**。json reporter 的形状是
    // { schemaVersion, files: { "<path>": { language, mutants: [...] } } }；旧夹具写成顶层 mutants
    // （无 files）——既不是 stryker 的产出，也正好掩盖了「files 缺失被当成 0 变异体」的 F2 缺陷。
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify({
        schemaVersion: '1.0',
        files: {
          [`${seg}.js`]: {
            language: 'javascript',
            mutants: [
              { id: '0', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', location: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } }, killedBy: ['test.js'] },
              { id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', location: { start: { line: 7, column: 1 }, end: { line: 7, column: 2 } } }
            ]
          }
        }
      }))
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
        ? { mutants: [{ id: 1, status: 'Killed' }], testFiles: ['test.js'] } // 上一次运行/旧格式的残留
        : { files: { [`${seg}.js`]: { mutants: [{ status: 'Killed' }] } } }
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
      // 交替两种零内容形态：空 files 映射 / files 非空但 mutants 为空数组
      const emptyFiles = REQUIRED_SEGS.indexOf(seg) % 2 === 0
      const payload = emptyFiles
        ? { files: {} }
        : { files: { [`${seg}.js`]: { language: 'javascript', mutants: [] } } }
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
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify({
        schemaVersion: '1.0',
        files: {
          [`${seg}.js`]: {
            language: 'javascript',
            mutants: [
              { id: '0', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
              { id: '1', mutatorName: 'ArrayLiteral', replacement: '[]', status: 'RuntimeError', statusReason: 'boom', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } }
            ]
          }
        }
      }))
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

// 场景 7（CodeRabbit PR #151）：条目缺 status（如 `{}`）会让 countMutant 先 total++ 再什么都计不进去——
// 零变异体护栏被绕过、分数被压低后照发。必须按段级失败拒绝发布。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mut-report-nostatus-'))
  try {
    const badSeg = REQUIRED_SEGS[0]
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      const mutants = seg === badSeg
        ? [{ id: '0', mutatorName: 'BlockStatement', replacement: '{}' }] // 缺 status
        : [{ id: '0', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }]
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify({
        files: { [`${seg}.js`]: { language: 'javascript', mutants } }
      }))
    }
    const r = runCli([tmp])
    assert.notStrictEqual(r.code, 0, '含缺 status 条目的报告必须拒绝发布（exit 非 0）')
    assert.ok(r.stderr.includes('缺失或非法 status'), `错误应指出根因是条目缺 status，实际 stderr：${r.stderr}`)
    assert.ok(r.stderr.includes(badSeg), '错误应指出是哪个分段，便于只重跑该段')
    assert.ok(!r.stdout.includes('🧬 变异测试日报'), '拒绝发布时不得输出日报正文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('test_mutation_report_cli OK')
