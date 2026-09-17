'use strict'

// 回归测试（v3.266）：scripts/mutation-report.js 的 render 函数输出快照
// 目标：拆 render 之前先固化为 markdown 快照；拆分后行为必须字节级一致。
// 同时覆盖日报日期的 Asia/Shanghai 跨 UTC 日期边界。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  render, validateSegments, validateFreshness, resolveMaxSkewMs, resolveRunStartedAtMs, shanghaiDate, escCell, countMutant,
  collectStats, findReportJson, analyzeSegment, analyze, postIssue
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
let fail = 0
/**
 * 执行一项同步断言并累计通过数量。
 * @param {string} name 测试名称
 * @param {Function} fn 测试函数
 */
function check (name, fn) {
  try { fn(); pass++ } catch (e) { fail++; console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1 }
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
    'failure-policy', 'storage', 'agents', 'http', 'loop', 'qinglong-push', 'check-deps', 'status'
  ].map(seg => ({ seg }))
  assert.deepStrictEqual(validateSegments(results), results)
})

// ===== validateSegments 反向校验（F5）：额外/陌生段与重复段不得静默计入合计 =====
check('validateSegments 出现预期之外的分段时拒绝发布', () => {
  // 旧实现只做单向包含检查（missing），多余段被静默聚合进合计 → 分数口径失真
  const results = [{ seg: 'v3-part1' }, { seg: 'v3-part2' }, { seg: 'rogue-residual' }]
  assert.throws(
    () => validateSegments(results, ['v3-part1', 'v3-part2']),
    /预期之外的分段：rogue-residual/
  )
})

check('validateSegments 分段重复时拒绝发布', () => {
  // 同一段出现两次会让合计静默翻倍；该段本身在预期内，故与"预期之外"分支互不覆盖
  const results = [{ seg: 'v3-part1' }, { seg: 'v3-part1' }, { seg: 'v3-part2' }]
  assert.throws(
    () => validateSegments(results, ['v3-part1', 'v3-part2']),
    /分段重复：v3-part1/
  )
})

// ===== F1：新鲜度闸门（缓存回填的陈旧报告）=====
// 报告内容与 stryker schema 完全合法，但文件时间远早于当日其它段——这正是「某段 stryker 崩溃/被 6h
// 取消 → artifact 里是 actions/cache 恢复的上一次运行产物」的形态。旧实现只做名称级校验 → 照发日报。
check('validateFreshness 正常跨度放行、陈旧段拒绝、可显式关闭', () => {
  const H = 3600 * 1000
  const now = Date.now()
  const fresh = [{ seg: 'a', reportMtimeMs: now }, { seg: 'b', reportMtimeMs: now - 5.9 * H }]
  assert.deepStrictEqual(validateFreshness(fresh), fresh, '6h 内的正常跨度（单 job 上限）必须放行')
  const withinThreshold = [{ seg: 'a', reportMtimeMs: now }, { seg: 'b', reportMtimeMs: now - 11.9 * H }]
  assert.deepStrictEqual(validateFreshness(withinThreshold), withinThreshold, '阈值内的跨度放行')
  const stale = [{ seg: 'a', reportMtimeMs: now }, { seg: 'b', reportMtimeMs: now - 24 * H }]
  assert.throws(
    () => validateFreshness(stale),
    /疑似缓存回填（陈旧）：b（报告文件时间比最新报告早 24 小时）/,
    '跨日缓存回填（24h）必须拒绝发布并指出段名与偏差'
  )
  // 阈值确实在起作用（把窗口压到 1h，5.9h 的跨度即判陈旧）——证明结论来自阈值比较而非巧合
  assert.throws(() => validateFreshness(fresh, 1 * H), /疑似缓存回填（陈旧）：b/)
  // 可比对象不足 / error 段 / 缺 mtime 的段不得被当成「陈旧」误红（误红会阻断正常日报）
  assert.deepStrictEqual(validateFreshness([{ seg: 'a', reportMtimeMs: now }]), [{ seg: 'a', reportMtimeMs: now }])
  const mixed = [{ seg: 'a', reportMtimeMs: now }, { seg: 'b', error: '缺 mutation-report.json' }, { seg: 'c' }]
  assert.deepStrictEqual(validateFreshness(mixed), mixed, 'error 段/无 mtime 段不参与比较')
  // 显式关闭（≤0）
  assert.deepStrictEqual(validateFreshness(stale, 0), stale, 'maxSkewMs=0 关闭闸门')
})

check('resolveMaxSkewMs 阈值解析（默认 12h / off 与 ≤0 关闭 / 非法值回落默认）', () => {
  const DEFAULT = 12 * 3600 * 1000
  assert.strictEqual(resolveMaxSkewMs(undefined), DEFAULT, '缺省 12h')
  assert.strictEqual(resolveMaxSkewMs(null), DEFAULT, 'null 按缺省')
  assert.strictEqual(resolveMaxSkewMs(''), DEFAULT, '空串按缺省')
  assert.strictEqual(resolveMaxSkewMs('   '), DEFAULT, '全空白按缺省')
  assert.strictEqual(resolveMaxSkewMs('off'), 0, 'off 关闭')
  assert.strictEqual(resolveMaxSkewMs(' OFF '), 0, '大小写与空白不敏感')
  assert.strictEqual(resolveMaxSkewMs('0'), 0, '0 关闭')
  assert.strictEqual(resolveMaxSkewMs('-5'), 0, '负数关闭')
  assert.strictEqual(resolveMaxSkewMs('3600000'), 3600000, '显式毫秒生效')
  assert.strictEqual(resolveMaxSkewMs('abc'), DEFAULT, '无法解析 → 回落默认（不得静默关掉闸门）')
})

// ===== F1 返工（V4 打回）：同族反例——全体回填 + 跨轮同日回填 =====
// 打回现场：闸门基准是「本批最新报告」而非 wall-clock，于是
//   ① 全体回填（所有段 mtime 都很旧、互差≈0）→ 跨段偏斜恒为 0 → 放行并照发日报；
//   ② 跨轮 <12h 的同日回填（实测 11h）→ 同样互差≈0 → 照发。
// 返工后 ① 由「相对现在的年龄」层拦下，② 由「本轮运行起点（CI 注入 github.run_started_at）」层拦下。
check('F1 返工：全体回填（互差≈0、全体 26h 前）必须拒绝；全新鲜/边界必须放行', () => {
  const H = 3600 * 1000
  const now = Date.now()
  const backfilled = [1, 2, 3, 4].map(i => ({ seg: 'seg' + i, reportMtimeMs: now - 26 * H }))
  // 跨段互差恰为 0 —— 旧实现（只看 skew）在此恒放行
  assert.throws(
    () => validateFreshness(backfilled),
    /疑似缓存回填.*全体陈旧.*超出本轮最大跨度 12 小时.*seg1（报告文件时间距今 26 小时）/,
    '全体回填必须被年龄层拒绝，并点名段名与距今小时数'
  )
  // 反向：同样「互差≈0」但全部新鲜 → 必须放行（证明拒绝来自年龄，而不是「互差≈0」本身）
  const allFresh = [1, 2, 3, 4].map(i => ({ seg: 'seg' + i, reportMtimeMs: now }))
  assert.deepStrictEqual(validateFreshness(allFresh), allFresh, '互差为 0 的全新鲜报告必须放行')
  // 边界：阈值内（11.9h）放行、超阈值（12.1h）拒绝
  const justInside = [{ seg: 'a', reportMtimeMs: now }, { seg: 'b', reportMtimeMs: now - 11.9 * H }]
  assert.deepStrictEqual(validateFreshness(justInside), justInside, '阈值内的年龄跨度必须放行')
  const justOver = [{ seg: 'a', reportMtimeMs: now }, { seg: 'b', reportMtimeMs: now - 12.1 * H }]
  assert.throws(() => validateFreshness(justOver), /疑似缓存回填/, '超出年龄上限必须拒绝')
  // 单个极旧段（无别的段可比）同样必须被年龄层拦下——旧实现在 dated.length<2 时直接 return
  assert.throws(() => validateFreshness([{ seg: 'only', reportMtimeMs: now - 30 * H }]), /全体陈旧/,
    '单段且极旧时不得因「无可比较对象」直接放行')
})

check('F1 返工：跨轮同日回填（互差≈0、全体 11h 前）须由本轮运行起点拦下', () => {
  const H = 3600 * 1000
  const now = Date.now()
  const sameDayBackfill = [1, 2, 3].map(i => ({ seg: 'seg' + i, reportMtimeMs: now - 11 * H }))
  // ① 无本轮起点（本地手工运行日报）：11h 在 12h 阈值内、互差≈0 → 放行（不得误红）
  assert.deepStrictEqual(validateFreshness(sameDayBackfill, 12 * H, undefined), sameDayBackfill,
    '未提供本轮起点时该层不生效')
  // ② 提供本轮起点（= 现在）→ 报告早于起点 11h → 必须拒绝（CI 形态）
  assert.throws(
    () => validateFreshness(sameDayBackfill, 12 * H, now),
    /疑似缓存回填.*早于本轮运行起点.*seg1（报告文件时间早于本轮运行起点 11 小时）/,
    '同日跨轮回填必须被运行起点层拒绝，并给出折算小时数'
  )
  // ③ 本轮真实产物（晚于起点）必须放行
  const producedThisRun = [{ seg: 'a', reportMtimeMs: now + 60 * 1000 }]
  assert.deepStrictEqual(validateFreshness(producedThisRun, 12 * H, now), producedThisRun,
    '本轮产出（晚于起点）必须放行')
  // ④ 起点解析：只有可解析的时间才启用该层
  assert.strictEqual(resolveRunStartedAtMs('2026-09-17T04:17:00Z'), Date.parse('2026-09-17T04:17:00Z'))
  assert.strictEqual(resolveRunStartedAtMs(''), undefined, '空串 → 该层不生效')
  assert.strictEqual(resolveRunStartedAtMs('昨天'), undefined, '不可解析 → 该层不生效（不误红）')
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
    // F1：正常段必须带上报告文件时间（新鲜度闸门的输入）；取不到时间的段会被排除在比较之外
    assert.strictEqual(r.reportPath, path.join(d, 'mutation.json'), '正常段应返回报告路径')
    assert.ok(Number.isFinite(r.reportMtimeMs), `正常段应返回可比较的 mtime，实际 ${r.reportMtimeMs}`)
    assert.ok(Math.abs(r.reportMtimeMs - fs.statSync(path.join(d, 'mutation.json')).mtimeMs) < 1,
      '返回的 mtime 必须是该报告文件自身的时间')
    const missing = analyzeSegment(tmp, { name: 'mutation-report-nonexist' })
    assert.strictEqual(missing.error, '缺 mutation-report.json')
    assert.strictEqual(missing.reportMtimeMs, undefined, '缺报告的段不带时间（不参与新鲜度比较）')
  })

  // F1（mutation-json 返工）：预读大小上限必须由**生产调用方**注入——本用例把生产入口
  // analyzeSegment 的注入点钉死：设 XBK_MUTATION_REPORT_MAX_BYTES=4 时，7 字节的正常报告必须被
  // 「超过预读上限」拒绝；不设时同一报告正常解析。若调用方退回 readReportJson(path)（V3 打回的
  // 「护栏只在测试里成立」形态），前者会照常解析成功 → 本条红。
  check('analyzeSegment 经 XBK_MUTATION_REPORT_MAX_BYTES 注入预读上限（生产调用方不得省略）', () => {
    const d = path.join(tmp, 'mutation-report-cap-injection'); fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'mutation.json'), JSON.stringify({
      schemaVersion: '1.0',
      thresholds: { high: 80, low: 60, break: null },
      files: { 'cap.js': { language: 'javascript', source: 'x\n', mutants: [{ status: 'Killed' }] } }
    }))
    const prev = process.env.XBK_MUTATION_REPORT_MAX_BYTES
    try {
      delete process.env.XBK_MUTATION_REPORT_MAX_BYTES
      const ok = analyzeSegment(tmp, { name: 'mutation-report-cap-injection' })
      assert.strictEqual(ok.error, undefined, `默认上限下正常报告应解析成功，实际 ${ok.error}`)
      assert.ok(ok.total > 0, '正常段应统计出变异体')
      process.env.XBK_MUTATION_REPORT_MAX_BYTES = '4'
      const capped = analyzeSegment(tmp, { name: 'mutation-report-cap-injection' })
      assert.ok(capped.error && capped.error.includes('超过预读上限'),
        `生产调用方必须把环境变量里的预读上限传下去（4 字节上限应拒绝 7 字节报告），实际 error=${capped.error}`)
      assert.ok(capped.error.includes('4 字节'), `报错应带上限值，实际 ${capped.error}`)
    } finally {
      if (prev === undefined) delete process.env.XBK_MUTATION_REPORT_MAX_BYTES
      else process.env.XBK_MUTATION_REPORT_MAX_BYTES = prev
    }
  })

  // F4：报告顶层为 null/原始值时显式失败并走段级隔离。
  // 旧实现 report.files 在 try 外求值 → 裸 TypeError 逃出 analyzeSegment，整份日报一起崩；
  // 新实现把解析+聚合同处 try 内，返回带报告路径的 error（且不得伪装成 0 变异体的正常段）。
  check('analyzeSegment 报告顶层为 null 时返回带上下文的 error（不抛 TypeError）', () => {
    const d = path.join(tmp, 'mutation-report-null-report'); fs.mkdirSync(d, { recursive: true })
    const reportPath = path.join(d, 'mutation.json')
    fs.writeFileSync(reportPath, 'null')
    const r = analyzeSegment(tmp, { name: 'mutation-report-null-report' })
    assert.strictEqual(r.seg, 'null-report')
    assert.ok(/报告顶层结构非法（null）/.test(r.error), `error 应说明顶层结构非法，实际：${r.error}`)
    assert.ok(r.error.includes(reportPath), `error 应携带报告路径便于定位，实际：${r.error}`)
    assert.strictEqual(r.total, undefined, '损坏报告不得伪装成 0 变异体的正常段')
  })

  check('analyzeSegment 报告顶层为原始值时返回带上下文的 error', () => {
    const d = path.join(tmp, 'mutation-report-primitive-report'); fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'mutation.json'), '42')
    const r = analyzeSegment(tmp, { name: 'mutation-report-primitive-report' })
    assert.strictEqual(r.seg, 'primitive-report')
    assert.ok(/报告顶层结构非法（number）/.test(r.error), `error 应说明顶层结构非法，实际：${r.error}`)
    assert.strictEqual(r.total, undefined, '损坏报告不得伪装成 0 变异体的正常段')
  })

  check('analyze 遍历 mutation-report-* 子目录并跳过普通目录', () => {
    // 显式创建一个普通目录（非 mutation-report-* 前缀），验证被跳过
    const plainDir = path.join(tmp, 'reports')
    fs.mkdirSync(plainDir, { recursive: true })
    fs.writeFileSync(path.join(plainDir, 'mutation.json'), '{}') // 即使有 mutation.json 也不应被收录

    const results = analyze(tmp)
    assert.ok(Array.isArray(results), '应返回数组')
    assert.ok(results.length > 0, 'tmp 下有多个 mutation-report-* 子目录')
    // 所有 seg 已去除 mutation-report- 前缀
    assert.ok(results.every(r => !r.seg.startsWith('mutation-report-')), 'seg 应去除前缀')
    // 包含已知段
    const segs = results.map(r => r.seg)
    assert.ok(segs.includes('utils'), '应包含 utils 段')
    // 普通目录（如 reports/）不应被包含——精确匹配 seg 名，而非宽松 includes
    assert.ok(!segs.includes('reports'), '应跳过非 mutation-report-* 目录（reports 不应出现在结果中）')
  })

  // F4：段级隔离——null 报告段以 error 形式隔离，其余段正常返回（旧实现整个 analyze 抛 TypeError）
  check('analyze 遇损坏段只隔离该段，其余段仍正常返回', () => {
    const results = analyze(tmp)
    const broken = results.find(r => r.seg === 'null-report')
    assert.ok(broken, 'null 报告段应出现在结果中')
    assert.ok(/报告顶层结构非法/.test(broken.error), 'null 报告段应以 error 形式隔离')
    const utils = results.find(r => r.seg === 'utils')
    assert.ok(utils && utils.total === 4, '其余正常段（utils.total=4）不受损坏段影响')
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

// 回归测试：大数量截断分支——Top10 文件 / Top15 变异类型 / 30+ 存活变异体
// 构造 31 个存活变异体，每个 file 和 mutator 都不同，一次覆盖三个截断边界。
check('render 大数量截断：Top10 文件 + Top15 变异类型 + 30+ 存活变异体', () => {
  const mutants = []
  for (let i = 1; i <= 31; i++) {
    const idx = String(i).padStart(2, '0')
    mutants.push({
      file: `src/file${idx}.js`,
      line: i,
      mutator: `Mutator${idx}`,
      replacement: `repl${idx}`
    })
  }
  const bigFixture = [{
    seg: 'big-seg',
    total: 100,
    killed: 69,
    survived: 31,
    noCoverage: 0,
    timeout: 0,
    score: 69,
    survivedMutants: mutants
  }]
  const out = render(bigFixture)
  const lines = out.split('\n')
  // Top10 文件表格：定位"存活最多的文件 Top 10"段，数数据行（排除表头/分隔/空行）
  const fileStart = lines.findIndex(l => l.includes('存活最多的文件 Top 10'))
  const fileRows = []
  for (let i = fileStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break
    if (lines[i].startsWith('| `')) fileRows.push(lines[i])
  }
  assert.strictEqual(fileRows.length, 10, `Top10 文件表格应只有10行，实际${fileRows.length}行`)
  // 计数全为 1 时并列名次无稳定先后，故只做集合断言（10 个互不相同的合法文件项），
  // 不依赖 Array.prototype.sort 稳定性 / Object 键插入序，避免实现细节变更引发 flake。
  const fileNames = fileRows.map(l => l.match(/`([^`]+)`/)[1])
  assert.strictEqual(new Set(fileNames).size, 10, 'Top10 表格应含 10 个互不重复的文件')
  assert.ok(fileNames.every(f => /^src\/file\d{2}\.js$/.test(f)), '每行应是合法的 src/fileNN.js 项')
  // Top15 变异类型表格：定位"存活变异类型分布 Top 15"段，数数据行
  const kindStart = lines.findIndex(l => l.includes('存活变异类型分布 Top 15'))
  const kindRows = []
  for (let i = kindStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break
    if (lines[i].startsWith('| Mutator')) kindRows.push(lines[i])
  }
  assert.strictEqual(kindRows.length, 15, `Top15 变异类型表格应只有15行，实际${kindRows.length}行`)
  const kindNames = kindRows.map(l => l.match(/\| (Mutator\d+) \|/)[1])
  assert.strictEqual(new Set(kindNames).size, 15, 'Top15 表格应含 15 个互不重复的变异类型')
  assert.ok(kindNames.every(k => /^Mutator\d{2}$/.test(k)), '每行应是合法的 MutatorNN 项')
  // 30+ 存活变异体：显示前 30 个 + "还有 1 个"
  assert.ok(out.includes('存活变异体（31 个）'), '应显示总存活数 31')
  assert.ok(out.includes('src/file01.js:1'), '应包含第1个存活变异体')
  assert.ok(out.includes('src/file30.js:30'), '应包含第30个存活变异体')
  assert.ok(!out.includes('src/file31.js:31'), '不应包含第31个存活变异体（>30截断）')
  assert.ok(out.includes('还有 1 个'), '应显示"还有 1 个"截断提示')
})

// === postIssue 单元测试（mock global.fetch，async IIFE 按顺序执行）===
;(async function runPostIssueTests () {
  const ORIG_TOKEN = process.env.GITHUB_TOKEN
  const ORIG_REPO = process.env.GITHUB_REPOSITORY
  const ORIG_FETCH = global.fetch
  let asyncPass = 0

  function mockFetch (responses) {
    let callIdx = 0
    global.fetch = async function (url, opts) {
      const r = responses[callIdx++]
      if (!r) throw new Error(`unexpected fetch call #${callIdx}: ${url}`)
      if (r instanceof Error) throw r // F7：模拟网络异常/超时拒绝（不是响应对象）
      r.capturedUrl = url
      r.capturedOpts = opts
      return r
    }
  }

  function makeRes (ok, status, body) {
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }

  async function acheck (name, fn) {
    try { await fn(); asyncPass++; pass++ } catch (e) { fail++; console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1 }
  }

  await acheck('postIssue 缺少 GITHUB_TOKEN 时抛错', async () => {
    delete process.env.GITHUB_TOKEN
    await assert.rejects(() => postIssue('body'), /缺少 GITHUB_TOKEN/)
  })

  await acheck('postIssue 当天日报已存在时跳过发布', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const today = shanghaiDate()
    const existingIssue = { number: 42, html_url: 'https://github.com/owner/repo/issues/42', title: `🧬 变异测试日报 ${today}` }
    const listRes = makeRes(true, 200, [existingIssue])
    mockFetch([listRes])
    const result = await postIssue('test body')
    assert.strictEqual(result.skipped, true)
    assert.strictEqual(result.number, 42)
    assert.strictEqual(result.html_url, existingIssue.html_url)
    assert.ok(listRes.capturedUrl.includes('/issues?state=all'), '应调用列表查询 API')
  })

  await acheck('postIssue 当天无日报时创建新 Issue', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const listRes = makeRes(true, 200, [])
    const createdIssue = { number: 99, html_url: 'https://github.com/owner/repo/issues/99' }
    const createRes = makeRes(true, 201, createdIssue)
    mockFetch([listRes, createRes])
    const result = await postIssue('test body content')
    assert.strictEqual(result.number, 99)
    assert.strictEqual(result.html_url, createdIssue.html_url)
    assert.strictEqual(result.skipped, undefined)
    const postBody = JSON.parse(createRes.capturedOpts.body)
    assert.ok(postBody.title.includes('变异测试日报'), 'title 应包含日报前缀')
    assert.strictEqual(postBody.body, 'test body content')
    // #30 修复：验证列表查询和创建请求的 method/per_page/creator 参数（篡改存活）
    // 列表查询：GET 方法，URL 含 per_page=100 和 creator=github-actions[bot]
    assert.ok(listRes.capturedOpts.method === undefined || listRes.capturedOpts.method === 'GET', '列表查询应为 GET（默认或显式）')
    assert.ok(listRes.capturedUrl.includes('per_page=100'), '列表查询 URL 应包含 per_page=100')
    assert.ok(listRes.capturedUrl.includes('creator='), '列表查询 URL 应包含 creator 过滤参数')
    assert.ok(listRes.capturedUrl.includes('github-actions'), 'creator 应为 github-actions[bot]')
    // 创建请求：POST 方法，Content-Type 为 application/json
    assert.strictEqual(createRes.capturedOpts.method, 'POST', '创建 Issue 应为 POST 方法')
    assert.strictEqual(createRes.capturedOpts.headers['Content-Type'], 'application/json', '创建请求 Content-Type 应为 application/json')
    assert.ok(createRes.capturedOpts.headers.Authorization.includes('test-token'), '创建请求应携带 Authorization token')
  })

  await acheck('postIssue 列表查询失败时跳过去重直接创建', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const listRes = makeRes(false, 500, { message: 'server error' })
    const createdIssue = { number: 100, html_url: 'https://github.com/owner/repo/issues/100' }
    const createRes = makeRes(true, 201, createdIssue)
    mockFetch([listRes, createRes])
    const result = await postIssue('body')
    assert.strictEqual(result.number, 100, '列表失败时应直接创建')
  })

  // F7：列表查询非 2xx 的静默降级必须有可观测输出（console.warn + 真实状态码）
  await acheck('postIssue 列表查询失败时输出可观测的降级 warn（含状态码）', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const listRes = makeRes(false, 503, { message: 'unavailable' })
    const createdIssue = { number: 101, html_url: 'https://github.com/owner/repo/issues/101' }
    const createRes = makeRes(true, 201, createdIssue)
    mockFetch([listRes, createRes])
    const warns = []
    const origWarn = console.warn
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      const result = await postIssue('body')
      assert.strictEqual(result.number, 101, '列表失败时仍应降级为直接创建')
    } finally {
      console.warn = origWarn
    }
    assert.strictEqual(warns.length, 1, `列表查询失败应恰好 warn 一次，实际 ${warns.length} 次`)
    assert.ok(warns[0].includes('HTTP 503'), `warn 应携带真实状态码，实际：${warns[0]}`)
  })

  await acheck('postIssue 创建 Issue 失败时抛错', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const listRes = makeRes(true, 200, [])
    const createRes = makeRes(false, 403, { message: 'Forbidden' })
    mockFetch([listRes, createRes])
    await assert.rejects(() => postIssue('body'), /发 Issue 失败，HTTP 状态码：403/)
  })

  // F7：列表 API 返回 200 但响应体非 JSON（代理页/限流说明页）——旧实现 `await listRes.json()` 未包 try，
  // SyntaxError 逃出 postIssue，当天日报直接不发。现在必须降级为「跳过去重直接创建」并 warn 留痕，
  // 且 warn 文本不得含换行（防伪造日志行）。
  await acheck('postIssue 列表查询 200 非 JSON 时降级为直接创建并 warn（不再抛 SyntaxError）', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const listRes = {
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <\nin JSON at position 0') },
      text: async () => '<html>'
    }
    const createdIssue = { number: 102, html_url: 'https://github.com/owner/repo/issues/102' }
    const createRes = makeRes(true, 201, createdIssue)
    mockFetch([listRes, createRes])
    const warns = []
    const origWarn = console.warn
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      const result = await postIssue('body')
      assert.strictEqual(result.number, 102, '200 非 JSON 的列表响应应降级为直接创建')
    } finally {
      console.warn = origWarn
    }
    assert.strictEqual(warns.length, 1, `应恰好 warn 一次，实际 ${warns.length} 次：${JSON.stringify(warns)}`)
    assert.ok(warns[0].includes('Unexpected token <'), `warn 应带根因，实际：${warns[0]}`)
    assert.ok(!/[\r\n]/.test(warns[0]), `warn 文本不得含换行，实际：${JSON.stringify(warns[0])}`)
  })

  // F7：列表查询网络异常/超时——旧实现会让整个 postIssue 失败；现按同一口径降级为直接创建。
  await acheck('postIssue 列表查询网络异常时降级为直接创建并 warn', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const timeoutErr = new Error('The operation was aborted due to timeout')
    timeoutErr.name = 'TimeoutError'
    const createdIssue = { number: 103, html_url: 'https://github.com/owner/repo/issues/103' }
    const createRes = makeRes(true, 201, createdIssue)
    mockFetch([timeoutErr, createRes])
    const warns = []
    const origWarn = console.warn
    console.warn = (...args) => { warns.push(args.join(' ')) }
    try {
      const result = await postIssue('body')
      assert.strictEqual(result.number, 103, '列表查询超时应降级为直接创建')
    } finally {
      console.warn = origWarn
    }
    assert.strictEqual(warns.length, 1, `应恰好 warn 一次，实际 ${warns.length} 次`)
    assert.ok(warns[0].includes('aborted due to timeout'), `warn 应带根因，实际：${warns[0]}`)
  })

  // F7：去重列表查询必须带 AbortSignal 超时（旧实现 fetch 无超时，列表接口挂住会拖死整个 report job）。
  await acheck('postIssue 列表查询携带 AbortSignal 超时', async () => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const listRes = makeRes(true, 200, [])
    const createRes = makeRes(true, 201, { number: 104, html_url: 'https://github.com/owner/repo/issues/104' })
    mockFetch([listRes, createRes])
    await postIssue('body')
    assert.ok(listRes.capturedOpts.signal instanceof AbortSignal,
      '列表查询必须带 AbortSignal 超时（无超时会让日报 job 无限等待）')
    assert.strictEqual(createRes.capturedOpts.signal, undefined, '发 Issue 请求不应被列表查询的超时信号绑住')
  })

  // 恢复原始环境变量和 fetch
  // #29 修复：ORIG_TOKEN 为 undefined 时必须 delete，而非赋值字符串 "undefined"
  if (ORIG_TOKEN !== undefined) process.env.GITHUB_TOKEN = ORIG_TOKEN; else delete process.env.GITHUB_TOKEN
  if (ORIG_REPO) process.env.GITHUB_REPOSITORY = ORIG_REPO; else delete process.env.GITHUB_REPOSITORY
  global.fetch = ORIG_FETCH

  // 汇总文案按真实失败计数条件化：存在失败项时不再谎报“全部通过”
  const failSuffix = fail > 0 ? ('，失败 ' + fail + ' 项') : '，全部通过'
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_mutation_report.js 通过 ${pass}/${pass + fail} 项${failSuffix}（含异步 ${asyncPass} 项）`)
})()
