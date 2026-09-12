'use strict'

// 补 run_mutation.js 覆盖率：runTests（子进程运行测试）+ evaluate（复制项目→应用变异→运行测试）
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runTests, evaluate } = require('./run_mutation')

;(async () => {
  // 防重入：run_mutation.js 的 runTests 在临时目录内运行 run_unit_tests.js 时会设置
  // XBK_MUTATION_CHILD=1。本套件的 evaluate 场景会再次调用 evaluate（→ copyProject → 跑
  // run_unit_tests.js → 又跑到本套件），若不拦截将无限递归并超时。嵌套时直接跳过。
  if (process.env.XBK_MUTATION_CHILD === '1') {
    console.log('⏭  检测到 XBK_MUTATION_CHILD，跳过 runTests/evaluate 场景（防变异运行递归）')
    return
  }

  // ===== runTests：子进程运行测试的 3 种场景 =====
  // runTests 在指定目录运行 DEFAULT_TEST=['node', 'run_unit_tests.js']

  // 场景 1：测试通过（process.exit(0) + 输出汇总）→ status='pass'
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtests-pass-'))
    try {
      fs.writeFileSync(path.join(dir, 'run_unit_tests.js'), `
        console.log('3 通过, 0 失败, 共 3')
        process.exit(0)
      `)
      const result = await runTests(dir, 10000)
      assert.strictEqual(result.status, 'pass', '通过的测试应返回 pass')
      assert.strictEqual(result.code, 0, '退出码应为 0')
      assert.ok(result.output.includes('3 通过'), 'output 应包含测试汇总')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // 场景 2：测试失败（process.exit(1)）→ status='fail'
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtests-fail-'))
    try {
      fs.writeFileSync(path.join(dir, 'run_unit_tests.js'), `
        console.error('测试失败')
        process.exit(1)
      `)
      const result = await runTests(dir, 10000)
      assert.strictEqual(result.status, 'fail', '失败的测试应返回 fail')
      assert.strictEqual(result.code, 1, '退出码应为 1')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // 场景 3：测试超时（死循环）→ status='timeout'
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtests-timeout-'))
    try {
      fs.writeFileSync(path.join(dir, 'run_unit_tests.js'), `
        while (true) {}
      `)
      const result = await runTests(dir, 500) // 500ms 超时
      assert.strictEqual(result.status, 'timeout', '超时的测试应返回 timeout')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // ===== evaluate：复制项目→应用变异→运行测试→清理 =====
  // evaluate 会复制 ROOT 下的完整单元测试运行环境（run_unit_tests.js + 全部 test_*.js + xbk_*.js + scripts/），
  // 然后应用变异，运行测试，最后清理临时目录（finally 块）。
  // 行为断言：验证 evaluate 真正执行了测试运行（而非因缺文件立即失败），output 含测试入口输出。

  // 场景 1：无变异（mutants=[]）→ evaluate 正常运行全量单元测试并返回结果
  {
    const files = ['xbk_utils.js']
    const result = await evaluate([], files, 120000)
    // 行为断言 1：返回结构完整
    assert.ok(typeof result === 'object', 'evaluate 应返回对象')
    assert.ok(['pass', 'fail', 'timeout'].includes(result.status), 'status 应为 pass/fail/timeout')
    assert.ok(Array.isArray(result.mutants), '应返回 mutants 数组')
    assert.strictEqual(result.mutants.length, 0, '无变异时 mutants 应为空')
    // 行为断言 2：output 中包含单元测试入口的真实输出（证明测试真正运行了，而非 MODULE_NOT_FOUND 立即失败）
    assert.ok(result.output.includes('单元测试入口') || result.output.includes('统一测试入口'),
      `output 应包含测试入口输出，证明测试真正运行。output 末尾：${result.output.slice(-200)}`)
    // 行为断言 3：output 中包含至少一个测试套件的执行痕迹
    assert.ok(result.output.includes('通过') || result.output.includes('失败'),
      'output 应包含测试通过/失败的执行痕迹')
    // 行为断言 4：code 字段契约完整——正常退出是数字；超时路径显式 code: null（不接受 undefined）
    if (result.status === 'timeout') {
      assert.ok(result.code === null, '超时结果应显式返回 code: null（不是 undefined）')
      assert.strictEqual(result.signal, 'SIGKILL', '超时应记录 SIGKILL')
    } else {
      assert.ok(typeof result.code === 'number', '非超时结果 code 应为数字（进程退出码）')
    }
    // evaluate 的 finally 块会清理临时目录，无需额外断言
  }

  // 场景 2：有变异体 → evaluate 应用变异后运行测试，mutants 数组包含变异体 ID
  {
    const { generateMutants } = require('./run_mutation')
    const source = fs.readFileSync(path.join(__dirname, 'xbk_utils.js'), 'utf8')
    const allMutants = generateMutants('xbk_utils.js', source)
    assert.ok(allMutants.length > 0, 'xbk_utils.js 应能生成变异体')
    // 取第一个变异体（确定性），验证 evaluate 能应用并返回其 ID
    const oneMutant = allMutants[0]
    const result = await evaluate([oneMutant], ['xbk_utils.js'], 120000)
    assert.ok(Array.isArray(result.mutants), '应返回 mutants 数组')
    assert.strictEqual(result.mutants.length, 1, '应包含 1 个变异体 ID')
    assert.strictEqual(result.mutants[0], oneMutant.id, '变异体 ID 应一致')
    // 行为断言：应用变异后测试仍真正运行（output 含测试入口输出或执行痕迹）
    assert.ok(result.output.includes('单元测试入口') || result.output.includes('统一测试入口') || result.output.includes('通过') || result.output.includes('失败'),
      '应用变异后测试应仍真正运行')
  }

  console.log('test_run_mutation_cli OK')
})().catch((e) => { console.error(e); process.exit(1) })
