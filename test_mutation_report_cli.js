'use strict'

// 补 scripts/mutation-report.js 覆盖率：main() CLI 入口的 3 种场景（子进程集成测试）
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, 'scripts', 'mutation-report.js')

// validateSegments 要求的全部分段名——以生产脚本为单一来源，消除双份维护：
// scripts/mutation-report.js 未导出该常量，故直接读取其源码里的 EXPECTED_SEGMENTS 字面量，
// 生产端新增/改名分段时本测试自动跟随（解析失败即显式报错，不会静默用空清单）。
const SEG_SOURCE = fs.readFileSync(SCRIPT, 'utf8')
const SEG_MATCH = SEG_SOURCE.match(/EXPECTED_SEGMENTS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\)/)
assert.ok(SEG_MATCH, '应从 scripts/mutation-report.js 解析到 EXPECTED_SEGMENTS 清单')
const REQUIRED_SEGS = [...SEG_MATCH[1].matchAll(/'([^']+)'/g)].map(m => m[1])
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
    // 构造所有预定义分段，每个分段一个简单的 mutation.json（1 个 killed 变异体）
    for (const seg of REQUIRED_SEGS) {
      const segDir = path.join(tmp, 'mutation-report-' + seg)
      fs.mkdirSync(segDir, { recursive: true })
      fs.writeFileSync(path.join(segDir, 'mutation.json'), JSON.stringify({
        mutants: [
          { id: 1, file: seg + '.js', line: 1, replacement: 'x', status: 'Killed', killedBy: ['test.js'] }
        ],
        testFiles: ['test.js']
      }))
    }

    const r = runCli([tmp])
    assert.strictEqual(r.code, 0, '有效目录应 exit 0, stderr: ' + r.stderr)
    assert.ok(r.stdout.length > 0, '应输出 markdown 报告')
    assert.ok(r.stdout.includes('变异') || r.stdout.includes('突变') || r.stdout.includes('Killed') || r.stdout.includes('#'), '输出应包含报告内容')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('test_mutation_report_cli OK')
