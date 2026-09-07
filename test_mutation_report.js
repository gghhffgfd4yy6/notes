'use strict'

// 回归测试（v3.266）：scripts/mutation-report.js 的 render 函数输出快照
// 目标：拆 render 之前先固化为 markdown 快照；拆分后行为必须字节级一致。
// 同时覆盖日报日期的 Asia/Shanghai 跨 UTC 日期边界。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  render, validateSegments, shanghaiDate, escCell, countMutant,
  collectStats, findReportJson, analyzeSegment, analyze
} = require('./scripts/mutation-report.js')

// Fixture：3 段（正常 + 错误 + 全被杀）→ 覆盖全部 6 条核心分支
//   1) 段汇总表（正常行）
//   2) 段汇总表（error 行：含 ❌ 前缀）
//   3) 段合计行（含 timeout 计入）
//   4) 存活最多文件 Top 10（按数量降序，含 escCell 处理）
//   5) 存活变异类型分布 Top 15
//   6) 存活变异体清单（>30 时显示"还有 N 个"，否则列全部）
// 附带："无存活变异体"分支（🎉）由含全被杀段的 case2 验证。
const FIXTURE = [
  {
    seg: 'part2',
    total: 20,
    killed: 8,
    survived: 4,
    noCoverage: 2,
    timeout: 6,
    score: 70,
    survivedMutants: [
      { file: 'src/a.js', line: 10, mutator: 'BinaryExpression', replacement: 'a + b' },
      { file: 'src/a.js', line: 20, mutator: 'Block', replacement: 'foo()' },
      { file: 'src/b.js', line: 5, mutator: 'ConditionalExpression', replacement: 'x ? y : z' },
      { file: 'src/c.js', line: 100, mutator: 'StringLiteral', replacement: '"foo"' }
    ]
  },
  { seg: 'part3-broken', error: '缺 mutation-report.json' },
  {
    seg: 'part4-all-killed',
    total: 5,
    killed: 5,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    score: 100,
    survivedMutants: []
  }
]

const EMPTY_CASE = [
  {
    seg: 'clean',
    total: 3,
    killed: 3,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    score: 100,
    survivedMutants: []
  }
]

let pass = 0
/**
 * 执行一项同步断言并累计通过数量。
 * @param {string} name 测试名称
 * @param {Function} fn 测试函数
 */
function check (name, fn) {
  try { fn(); pass++ } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1 }
}

check('render 输出快照（含 error 段 + 正常段 + 全被杀段）', () => {
  const expected = '## 🧬 变异测试日报\n' +
'\n' +
'| 段 | 变异体 | 被杀 | 超时 | 存活 | 无覆盖 | 分数 |\n' +
'|---|---|---|---|---|---|---|\n' +
'| part2 | 20 | 8 | 6 | 4 | 2 | 70% |\n' +
'| part3-broken | ❌ 缺 mutation-report.json | - | - | - | - | - |\n' +
'| part4-all-killed | 5 | 5 | 0 | 0 | 0 | 100% |\n' +
'| **合计** | **25** | **13** | **6** | **4** | | **76%** |\n' +
'\n' +
'## 存活最多的文件 Top 10\n' +
'\n' +
'| 文件 | 存活变异体数 |\n' +
'|---|---|\n' +
'| `src/a.js` | 2 |\n' +
'| `src/b.js` | 1 |\n' +
'| `src/c.js` | 1 |\n' +
'\n' +
'## 存活变异类型分布 Top 15\n' +
'\n' +
'| 变异类型 | 存活数 |\n' +
'|---|---|\n' +
'| BinaryExpression | 1 |\n' +
'| Block | 1 |\n' +
'| ConditionalExpression | 1 |\n' +
'| StringLiteral | 1 |\n' +
'\n' +
'## 存活变异体（4 个）\n' +
'\n' +
'- `src/a.js:10` BinaryExpression → `a + b`\n' +
'- `src/a.js:20` Block → `foo()`\n' +
'- `src/b.js:5` ConditionalExpression → `x ? y : z`\n' +
'- `src/c.js:100` StringLiteral → `"foo"`\n' +
'\n' +
'> 由 mutation-report.js 自动生成'
  assert.strictEqual(render(FIXTURE), expected)
})

check('render 输出快照（全被杀 → 🎉 无存活变异体分支）', () => {
  const expected = '## 🧬 变异测试日报\n' +
'\n' +
'| 段 | 变异体 | 被杀 | 超时 | 存活 | 无覆盖 | 分数 |\n' +
'|---|---|---|---|---|---|---|\n' +
'| clean | 3 | 3 | 0 | 0 | 0 | 100% |\n' +
'| **合计** | **3** | **3** | **0** | **0** | | **100%** |\n' +
'\n' +
'## 🎉 无存活变异体！\n' +
'\n' +
'> 由 mutation-report.js 自动生成'
  assert.strictEqual(render(EMPTY_CASE), expected)
})

/**
 * 验证日报在上海时区跨 UTC 日期边界时仍使用正确自然日。
 */
function testShanghaiDate () {
  // UTC 16:17 已是北京时间次日 00:17，不能继续使用 UTC 日期。
  assert.strictEqual(shanghaiDate(new Date('2026-08-28T16:17:00.000Z')), '2026-08-29')
  assert.strictEqual(shanghaiDate(new Date('2026-08-29T04:17:00.000Z')), '2026-08-29')
}
check('日报日期按 Asia/Shanghai 自然日计算', testShanghaiDate)

check('缺少变异测试分段时拒绝发布不完整日报', () => {
  assert.throws(
    () => validateSegments([{ seg: 'v3-part1' }], ['v3-part1', 'v3-part2']),
    /缺少分段：v3-part2/
  )
})

check('包含错误变异测试分段时拒绝发布不完整日报', () => {
  const results = [{ seg: 'v3-part1', error: '缺 mutation.json' }]
  assert.throws(
    () => validateSegments(results, ['v3-part1']),
    /包含错误分段：v3-part1/
  )
})

check('生产默认分段完整时允许生成日报', () => {
  const results = [
    'v3-entry', 'app', 'filter', 'formatter', 'message-store', 'network', 'pusher', 'rules', 'utils',
    'sendnotify-part1', 'sendnotify-part2',
    'failure-policy', 'storage', 'agents', 'http', 'loop', 'qinglong-push', 'check-deps'
  ].map(seg => ({ seg }))
  assert.deepStrictEqual(validateSegments(results), results)
})

// ===== escCell：Markdown 表格单元格转义 =====
check('escCell 转义竖线/反斜杠/换行/反引号', () => {
  assert.strictEqual(escCell('hello'), 'hello')
  assert.strictEqual(escCell('a|b'), 'a\\|b')
  assert.strictEqual(escCell('a\\b'), 'a\\\\b')
  assert.strictEqual(escCell('a\nb'), 'a b')
  assert.strictEqual(escCell('a`b'), "a'b")
  // 反斜杠先行，避免 \| 被二次转义
  assert.strictEqual(escCell('a\\|b'), 'a\\\\\\|b')
  assert.strictEqual(escCell(123), '123')
})

// ===== countMutant：变异体分类计数 =====
check('countMutant 正确分类 Killed/Survived/NoCoverage/Timeout', () => {
  const mk = () => ({ total: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0, survivedMutants: [] })
  const s1 = mk(); countMutant(s1, 'f.js', { status: 'Killed' })
  assert.strictEqual(s1.killed, 1); assert.strictEqual(s1.total, 1)
  const s2 = mk(); countMutant(s2, 'f.js', { status: 'Survived', mutatorName: 'B', replacement: 'y', location: { start: { line: 10 } } })
  assert.strictEqual(s2.survived, 1); assert.strictEqual(s2.survivedMutants.length, 1)
  assert.deepStrictEqual(s2.survivedMutants[0], { file: 'f.js', line: 10, mutator: 'B', replacement: 'y' })
  const s3 = mk(); countMutant(s3, 'f.js', { status: 'Survived', mutatorName: 'X', replacement: 'z' })
  assert.strictEqual(s3.survivedMutants[0].line, '?', '无 location 时 line 应为 ?')
  const s4 = mk(); countMutant(s4, 'f.js', { status: 'NoCoverage' }); assert.strictEqual(s4.noCoverage, 1)
  const s5 = mk(); countMutant(s5, 'f.js', { status: 'Timeout' }); assert.strictEqual(s5.timeout, 1)
  const s6 = mk(); countMutant(s6, 'f.js', { status: 'Unknown' })
  assert.strictEqual(s6.total, 1); assert.strictEqual(s6.killed + s6.survived + s6.noCoverage + s6.timeout, 0)
})

// ===== collectStats：汇总存活变异体 =====
check('collectStats 按文件/类型汇总存活变异体', () => {
  const empty = collectStats([])
  assert.strictEqual(empty.allSurvived.length, 0)
  const stats = collectStats([
    { seg: 'a', survivedMutants: [{ file: 'x.js', mutator: 'Bin', line: 1, replacement: 'r' }] },
    { seg: 'b', survivedMutants: [{ file: 'x.js', mutator: 'Bin', line: 2, replacement: 's' }, { file: 'y.js', mutator: 'Bool', line: 3, replacement: 't' }] }
  ])
  assert.strictEqual(stats.allSurvived.length, 3)
  assert.strictEqual(stats.byFile['x.js'], 2)
  assert.strictEqual(stats.byFile['y.js'], 1)
  assert.strictEqual(stats.byKind.Bin, 2)
  assert.strictEqual(stats.byKind.Bool, 1)
})

// ===== findReportJson / analyzeSegment：临时目录 =====
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mr-'))
try {
  check('findReportJson 递归找到 mutation.json / 旧名 / 无报告返回 null', () => {
    const d1 = path.join(tmp, 'mutation-report-a'); fs.mkdirSync(d1, { recursive: true })
    fs.writeFileSync(path.join(d1, 'mutation.json'), '{}')
    assert.strictEqual(findReportJson(d1), path.join(d1, 'mutation.json'))
    const d2 = path.join(tmp, 'mutation-report-b', 'reports', 'mutation'); fs.mkdirSync(d2, { recursive: true })
    fs.writeFileSync(path.join(d2, 'mutation.json'), '{}')
    assert.strictEqual(findReportJson(path.join(tmp, 'mutation-report-b')), path.join(d2, 'mutation.json'))
    const d3 = path.join(tmp, 'mutation-report-c'); fs.mkdirSync(d3, { recursive: true })
    fs.writeFileSync(path.join(d3, 'mutation-report.json'), '{}')
    assert.strictEqual(findReportJson(d3), path.join(d3, 'mutation-report.json'))
    const d4 = path.join(tmp, 'mutation-report-d'); fs.mkdirSync(d4, { recursive: true })
    assert.strictEqual(findReportJson(d4), null)
    assert.strictEqual(findReportJson(path.join(tmp, 'not-exist')), null)
  })

  check('analyzeSegment 正确解析统计 / 缺报告返回 error', () => {
    const d = path.join(tmp, 'mutation-report-utils'); fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'mutation.json'), JSON.stringify({
      files: {
        'u.js': {
          mutants: [
            { status: 'Killed' },
            { status: 'Survived', mutatorName: 'B', replacement: 'y', location: { start: { line: 5 } } },
            { status: 'NoCoverage' },
            { status: 'Timeout' }
          ]
        }
      }
    }))
    const r = analyzeSegment(tmp, { name: 'mutation-report-utils' })
    assert.strictEqual(r.seg, 'utils'); assert.strictEqual(r.total, 4)
    assert.strictEqual(r.killed, 1); assert.strictEqual(r.survived, 1)
    assert.strictEqual(r.noCoverage, 1); assert.strictEqual(r.timeout, 1)
    assert.strictEqual(r.score, 50)
    const missing = analyzeSegment(tmp, { name: 'mutation-report-nonexist' })
    assert.strictEqual(missing.error, '缺 mutation-report.json')
  })

  check('analyze 遍历 mutation-report-* 子目录并跳过普通目录', () => {
    const results = analyze(tmp)
    assert.ok(Array.isArray(results), '应返回数组')
    assert.ok(results.length > 0, 'tmp 下有多个 mutation-report-* 子目录')
    // 所有 seg 已去除 mutation-report- 前缀
    assert.ok(results.every(r => !r.seg.startsWith('mutation-report-')), 'seg 应去除前缀')
    // 包含已知段
    const segs = results.map(r => r.seg)
    assert.ok(segs.includes('utils'), '应包含 utils 段')
    // 普通目录（如 reports/）不应被包含
    assert.ok(!segs.some(s => s === 'reports' || s.includes('reports')), '应跳过非 mutation-report-* 目录')
  })

  check('analyze 空目录返回空数组', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mr-empty-'))
    try {
      const results = analyze(emptyDir)
      assert.deepStrictEqual(results, [], '空目录应返回空数组')
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n🎉 test_mutation_report.js 全部通过（${pass} 项）`)
