'use strict'

// .github/analyze-artifacts.js 的子进程回归（审查 F6）：该脚本此前没有任何测试或 CI 步骤覆盖
// （grep analyze-artifacts --include=test_*.js 为空、SUITES 里没有对应套件、mutation.yml 矩阵也不含它），
// 于是 v3.262 模块化拆分后硬编码的尾部行数阈值 2701 静默失效也无人发现。本套件以「真实子进程 +
// 夹具报告目录」守护它的退出路径、存活统计口径，以及「V3 全文件行数按实际行数取值」这一 F1 类常量。
//
// 为什么走子进程：该脚本是顶层执行式 CLI（require 即跑完并可能 process.exit），没有可单测的导出；
// CI 里它也正是被 `node .github/analyze-artifacts.js` 直接调用的，子进程断言与真实运行同路径。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname)
const SCRIPT = path.join(ROOT, '.github', 'analyze-artifacts.js')
const V3 = path.join(ROOT, 'xbk_function_v3.js')

function run (dir, env) {
  // process.execPath 由运行环境决定（CI 为 node 本体；本机经 execpath-shim 覆写为真实 node 二进制）
  const r = spawnSync(process.execPath, [SCRIPT, dir], { cwd: ROOT, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function mutant (id, status, line, mutatorName = 'BlockStatement') {
  return { id: String(id), mutatorName, status, location: { start: { line, column: 1 } }, replacement: 'x' }
}

// 与真实 artifact 布局一致：每个 artifact 目录下一个 mutation.json
function writeReport (root, sub, payload) {
  const dir = path.join(root, sub)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify(payload))
}

let failed = 0
function check (name, fn) {
  try { fn(); console.log(`  ✅ ${name}`) } catch (e) { failed += 1; console.error(`  ❌ ${name}: ${e.message}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-analyze-'))
try {
  console.log('test_analyze_artifacts')

  check('A1 报告目录不存在 → exit 1 且报错指名目录（不得输出全零假绿）', () => {
    const r = run(path.join(tmp, 'not-exist'))
    assert.strictEqual(r.status, 1, '目录缺失必须非零退出')
    assert.match(r.stderr, /报告目录不存在/, 'stderr 必须说明报告目录不可用')
  })

  check('A2 目录存在但没有任何报告文件 → exit 1', () => {
    const empty = path.join(tmp, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    const r = run(empty)
    assert.strictEqual(r.status, 1, '没有报告文件必须非零退出')
    assert.match(r.stderr, /未找到任何报告文件/, 'stderr 必须说明未找到报告文件')
  })

  check('A3 合法报告 → 只统计 Survived、按文件+状态计数、NoCoverage 不混入存活', () => {
    const dir = path.join(tmp, 'ok')
    writeReport(dir, 'a', { files: { 'xbk_function_v3.js': { mutants: [mutant(1, 'Survived', 10), mutant(2, 'Killed', 20), mutant(3, 'NoCoverage', 30)] } } })
    const r = run(dir)
    assert.strictEqual(r.status, 0, `合法输入必须 exit 0（stderr: ${r.stderr.trim()}）`)
    assert.match(r.stdout, /=== 存活变异体总数: 1 ===/, '存活总数只应包含 Survived（NoCoverage 有独立计数，不混入）')
    assert.match(r.stdout, /xbk_function_v3\.js\s+\{"Survived":1,"Killed":1,"NoCoverage":1\}/, '按文件+状态必须逐项计数')
  })

  check('A4 结构坏报告计入 skipped 并 exit 1，同目录的合法报告仍被统计', () => {
    const dir = path.join(tmp, 'mixed')
    writeReport(dir, 'bad', { files: 'not-an-object' })
    writeReport(dir, 'good', { files: { 'xbk_sendNotify_slim.js': { mutants: [mutant(1, 'Survived', 5)] } } })
    const r = run(dir)
    assert.strictEqual(r.status, 1, '存在未纳入统计的报告必须置非零退出码（避免存活总数静默偏低）')
    assert.match(r.stderr, /未纳入统计的报告: 1\/2/, 'stderr 必须给出 skipped 计数')
    assert.match(r.stdout, /存活变异体总数: 1/, '同一目录下的合法报告仍须被统计（坏报告不中断其余）')
  })

  check('A5 V3 全文件行数按实际文件行数取值（守护失效常量 2701）', () => {
    const dir = path.join(tmp, 'lines')
    writeReport(dir, 'a', { files: { 'xbk_function_v3.js': { mutants: [mutant(1, 'Survived', 10)] } } })
    // 独立复算：末行有换行时不额外计一个空行（与脚本 countLines 同口径）
    const text = fs.readFileSync(V3, 'utf8')
    const realLines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    const r = run(dir)
    // 用字符串包含替代 new RegExp(`…`)：插值只有十进制行数，转义括号在 includes 里写回字面
    // 「(全文件 N 行)」，语义等价；动态构造 RegExp 会被判为「非字面量 RegExp」（Codacy）。
    assert.ok(r.stdout.includes(`V3 存活(全文件 ${realLines} 行)`),
      `输出必须使用实际行数 ${realLines}（旧实现硬编码 2701，v3.262 拆分后该段统计恒为空）`)
    assert.ok(realLines > 0, 'V3 文件必须可读出行数（读不到时脚本会置 exitCode=1）')
  })

  check('A6 V3 存活按百行段聚类；无位置信息的存活体不进行段统计', () => {
    const dir = path.join(tmp, 'seg')
    writeReport(dir, 'a', {
      files: {
        'xbk_function_v3.js': {
          mutants: [
            mutant(1, 'Survived', 250),
            { id: '2', mutatorName: 'StringLiteral', status: 'Survived' }
          ]
        }
      }
    })
    const r = run(dir)
    assert.match(r.stdout, /=== 存活变异体总数: 2 ===/, '无位置信息的存活体仍计入总数')
    assert.match(r.stdout, /V3 存活\(全文件 \d+ 行\): 1/, '段统计只纳入有位置信息的存活体')
    assert.match(r.stdout, /行 200-299: 1/, '行 250 应落在 200-299 段')
  })

  check('A7 顶层非对象 / files 缺失都算结构异常（不得当空报告放行）', () => {
    const dir = path.join(tmp, 'shape')
    writeReport(dir, 'arr', [])
    writeReport(dir, 'nofiles', { schemaVersion: '1.0' })
    const r = run(dir)
    assert.strictEqual(r.status, 1, '两份结构异常报告都必须被记为未纳入统计')
    assert.match(r.stderr, /未纳入统计的报告: 2\/2/, '两份坏报告都要出现在 skipped 列表')
    assert.match(r.stderr, /报告顶层不是 JSON 对象|报告缺少 files 对象/, 'skipped 原因必须可读')
  })

  // R6（F1 收尾）：该脚本此前调 readReportJson(f)（零 options）且不读 XBK_MUTATION_REPORT_MAX_BYTES，
  // 于是「两个生产调用方都注入上限」的声称只闭了一半——这条生产路径只能拿默认 2 GiB，运维无法收紧/关闭。
  // 下列断言把「显式注入 + 与 mutation-report.js 同源口径」钉死：极小值必须按**超限**处理（计入 skipped、
  // 不静默整读），非法值回落默认值而非变成无上限，`off` 才关闭策略上限。
  check('A8 XBK_MUTATION_REPORT_MAX_BYTES 注入生效：极小上限必须按超限拒绝（不得静默整读）', () => {
    const dir = path.join(tmp, 'cap')
    writeReport(dir, 'a', { files: { 'xbk_function_v3.js': { mutants: [mutant(1, 'Survived', 10)] } } })
    const normal = run(dir)
    assert.strictEqual(normal.status, 0, `不设环境变量时合法报告必须正常统计（stderr: ${normal.stderr.trim()}）`)
    assert.match(normal.stdout, /存活变异体总数: 1/, '不设上限时报告应被正常读入')
    // ① 极小上限 → 该报告超限：计入 skipped、非零退出、原因可读；绝不能照常统计
    const capped = run(dir, { XBK_MUTATION_REPORT_MAX_BYTES: '4' })
    assert.strictEqual(capped.status, 1, '设了极小上限后超限报告必须非零退出（绿灯 = 上限未注入）')
    assert.match(capped.stderr, /未纳入统计的报告: 1\/1/, '超限报告必须出现在 skipped 列表（而非被静默整读）')
    assert.match(capped.stderr, /超过预读上限/, `skipped 原因必须指名超限（实际：${capped.stderr.trim().slice(0, 200)}）`)
    assert.doesNotMatch(capped.stdout, /存活变异体总数: 1/, '超限报告不得照常计入统计')
    // ② 非法值回落默认策略值（绝不变成无上限）：同一报告重新被正常读入
    for (const bad of ['abc', '-1', '0']) {
      const r = run(dir, { XBK_MUTATION_REPORT_MAX_BYTES: bad })
      assert.strictEqual(r.status, 0, `非法值 ${bad} 必须回落默认上限（不得把上限变成无穷）`)
      assert.match(r.stdout, /存活变异体总数: 1/, `非法值 ${bad} 回落默认后应正常统计`)
    }
    // ③ off 关闭策略上限（退回 Buffer 边界）：同一报告仍应正常读入
    const off = run(dir, { XBK_MUTATION_REPORT_MAX_BYTES: 'off' })
    assert.strictEqual(off.status, 0, 'off 应关闭策略上限而非拒绝一切报告')
    assert.match(off.stdout, /存活变异体总数: 1/, 'off 后报告正常统计')
  })

  check('A9 上限注入不得改坏既有口径：混合目录仍逐份统计 / 坏报告不中断其余', () => {
    const dir = path.join(tmp, 'cap-mixed')
    writeReport(dir, 'bad', { files: 'not-an-object' })
    writeReport(dir, 'good', { files: { 'xbk_sendNotify_slim.js': { mutants: [mutant(1, 'Survived', 5)] } } })
    const r = run(dir, { XBK_MUTATION_REPORT_MAX_BYTES: '1048576' })
    assert.strictEqual(r.status, 1, '存在未纳入统计的报告仍须非零退出（skipped 统计未被改坏）')
    assert.match(r.stderr, /未纳入统计的报告: 1\/2/, 'skipped 计数口径不变')
    assert.match(r.stdout, /存活变异体总数: 1/, '同目录合法报告仍被统计（不中断其余）')
    // 极小上限 → 两份都超限：skipped 2/2，且不得因「全部超限」而崩溃/静默
    const tiny = run(dir, { XBK_MUTATION_REPORT_MAX_BYTES: '4' })
    assert.strictEqual(tiny.status, 1, '全部超限时仍须非零退出')
    assert.match(tiny.stderr, /未纳入统计的报告: 2\/2/, `两份超限报告都要进 skipped（实际：${tiny.stderr.trim().slice(0, 200)}）`)
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`test_analyze_artifacts OK (${failed === 0 ? '全部通过' : failed + ' 项失败'})`)
process.exit(failed > 0 ? 1 : 0)
