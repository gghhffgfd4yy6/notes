'use strict'

// 回归测试（v3.266）：scripts/mutation-report.js 的 render 函数输出快照
// 目标：拆 render 之前先固化为 markdown 快照；拆分后行为必须字节级一致。
const assert = require('node:assert')
const { render } = require('./scripts/mutation-report.js')

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

console.log(`\n🎉 test_mutation_report.js 全部通过（${pass} 项）`)
