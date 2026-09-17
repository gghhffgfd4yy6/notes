'use strict'

// 补 run_mutation.js 覆盖率：runTests（子进程运行测试）+ evaluate（复制项目→应用变异→运行测试）
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runTests, evaluate, main } = require('./run_mutation')

;(async () => {
  // 防重入：run_mutation.js 的 runTests 在临时目录内运行 run_unit_tests.js 时会设置
  // XBK_MUTATION_CHILD=1。本套件的 evaluate 场景会再次调用 evaluate（→ copyProject → 跑
  // run_unit_tests.js → 又跑到本套件），若不拦截将无限递归并超时。嵌套时直接跳过。
  if (process.env.XBK_MUTATION_CHILD === '1') {
    console.log('⏭  检测到 XBK_MUTATION_CHILD，跳过 runTests/evaluate 场景（防变异运行递归）')
    return
  }

  // ===== main：基线首跑（review F1） =====
  // 无基线时沙箱整体红会把每个变异体都判 killed → survived=0/timeout=0 → exit 0（假绿 100%）。
  // 用注入的 fake evaluate（deps.evaluate）复现「基线 fail」：只跑基线、不进批次、不写断点、退出码 1。
  {
    const originalExitCode = process.exitCode
    const originalCheckpoint = process.env.MUTATION_CHECKPOINT
    const ckpt = path.join(os.tmpdir(), `xbk-baseline-ckpt-${process.pid}.json`)
    const calls = []
    try {
      process.env.MUTATION_CHECKPOINT = ckpt
      await main({
        evaluate: async (mutants) => {
          calls.push(mutants.length)
          return { status: 'fail', code: 1, signal: null, output: '沙箱本来就有红套件', summary: ['0', '1', '1'] }
        }
      })
      assert.deepStrictEqual(calls, [0],
        '基线失败时只应跑一次未套变异的基线（mutants 为空），不得进入批次循环把红归因给变异体')
      assert.strictEqual(process.exitCode, 1, '基线失败必须非零退出（不得 survived=0 却 exit 0）')
      assert.ok(!fs.existsSync(ckpt), '基线失败不得写出断点文件（否则留下待判定的污染断点）')
    } finally {
      process.exitCode = originalExitCode
      if (originalCheckpoint === undefined) delete process.env.MUTATION_CHECKPOINT
      else process.env.MUTATION_CHECKPOINT = originalCheckpoint
      fs.rmSync(ckpt, { force: true })
    }
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
      // 超时契约断言放在确定触发 timeout 的场景（死循环 500ms），而非 evaluate 分支——
      // evaluate 用 120s 超时跑全量套件，CI 中几乎不会走到 timeout，那里的断言形同虚设（仅作防御保留）。
      assert.strictEqual(result.code, null, '超时结果应显式返回 code: null（不是 undefined）')
      assert.strictEqual(result.signal, 'SIGKILL', '超时应记录 SIGKILL')
      assert.ok(Array.isArray(result.summary), '超时结果应返回 summary 数组（与正常运行路径契约对称）')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // 场景 3b：超时必须杀整个进程组（F6）。只 kill 直接子进程时，它派生的孙进程（真实的套件进程）
  // 仍是孤儿并持有 stdout/stderr 管道 → 'close' 被推迟到 2000ms 兜底保险（超时被记 timeout 的同时
  // 孤儿继续跑）。本场景用真实进程验证：孙进程持续写心跳文件，超时后心跳必须停止、且 'close' 快速到达。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtests-groupkill-'))
    const marker = path.join(dir, 'orphan-heartbeat.log')
    const prevMarker = process.env.XBK_TEST_ORPHAN_MARKER
    try {
      process.env.XBK_TEST_ORPHAN_MARKER = marker
      // 直接子进程：spawn 一个持续写心跳的孙进程（继承管道），自己挂住不退 —— 触发超时分支。
      // 孙进程 15s 后自杀：即使修复被回退（孤儿存活）也不会留下无界进程。
      fs.writeFileSync(path.join(dir, 'run_unit_tests.js'), `
        const { spawn } = require('child_process')
        spawn(process.execPath, ['-e', "const fs=require('fs');const f=process.env.XBK_TEST_ORPHAN_MARKER;setInterval(()=>fs.appendFileSync(f,'x'),20);setTimeout(()=>process.exit(0),15000)"], { stdio: ['ignore', 'inherit', 'inherit'] })
        setInterval(() => {}, 1000)
      `)
      const t0 = Date.now()
      const result = await runTests(dir, 800)
      const elapsed = Date.now() - t0
      assert.strictEqual(result.status, 'timeout', '挂住的直接子进程应按超时结算')
      assert.ok(fs.existsSync(marker), '孙进程应至少写入一次心跳（否则本回归没有判据：夹具未真正派生后代）')
      const size1 = fs.statSync(marker).size
      await new Promise(resolve => setTimeout(resolve, 600))
      const size2 = fs.statSync(marker).size
      assert.strictEqual(size2, size1,
        `超时后孙进程仍在运行（心跳 ${size1} → ${size2} 字节）：进程组未被杀伤，孤儿继续跑`)
      assert.ok(elapsed < 2000,
        `孙进程被杀后管道应立即关闭、由 close 收敛（实测 ${elapsed}ms；>=2000ms 说明落到了兜底定时器）`)
    } finally {
      if (prevMarker === undefined) delete process.env.XBK_TEST_ORPHAN_MARKER
      else process.env.XBK_TEST_ORPHAN_MARKER = prevMarker
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // 场景 4：runTests 必须清空 SKIP_SUITES，给子进程带 XBK_MUTATION_CHILD=1，并注入 PERF_MS
  // 原因：CI 显式步骤的 SKIP_SUITES 若继承进变异评估子进程，被跳过的套件不再参与变异判定 → 分数失真；
  // PERF_MS 必须与 stryker 沙箱同口径（scripts/mutation-child.js），否则 test_filter.js 的性能断言
  // 在默认最多 8 并发下误失败 → 变异体被记 killed、分数虚高，且两条变异路径不可比（F8）。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtests-skip-'))
    const prev = process.env.SKIP_SUITES
    try {
      process.env.SKIP_SUITES = 'test_filter.js,test_storage.js'
      fs.writeFileSync(path.join(dir, 'run_unit_tests.js'), `
        console.log('SKIP=[' + (process.env.SKIP_SUITES || '') + '] MUT=[' + (process.env.XBK_MUTATION_CHILD || '') + '] PERF=[' + (process.env.PERF_MS || '') + ']')
        process.exit(0)
      `)
      const result = await runTests(dir, 10000)
      assert.strictEqual(result.status, 'pass', `应正常通过，output=${result.output}`)
      assert.match(result.output, /SKIP=\[\]/, 'runTests 必须清空 SKIP_SUITES（否则 CI 跳过清单会继承到变异评估）')
      assert.match(result.output, /MUT=\[1\]/, 'runTests 应标记 XBK_MUTATION_CHILD=1（防递归 + 抑制 summary 追加）')
      // 与 stryker 沙箱同口径：预期值取自 scripts/mutation-child.js 的实际赋值（单一事实源），
      // 任一侧被改动（去掉注入 / 改 mutation-child 的值）都会让本断言红。
      const childScript = fs.readFileSync(path.join(__dirname, 'scripts', 'mutation-child.js'), 'utf8')
      const perf = /process\.env\.PERF_MS\s*=\s*'(\d+)'/.exec(childScript)
      assert.ok(perf, 'scripts/mutation-child.js 应显式设置 PERF_MS（stryker 沙箱性能阈值口径来源）')
      assert.match(result.output, new RegExp(`PERF=\\[${perf[1]}\\]`),
        `runTests 注入的 PERF_MS 必须与 stryker 沙箱同口径（scripts/mutation-child.js 的 ${perf[1]}）`)
    } finally {
      if (prev === undefined) delete process.env.SKIP_SUITES
      else process.env.SKIP_SUITES = prev
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
    // 沙箱内整套必须真的通过：此前只断言 status ∈ {pass,fail,timeout}，copyProject 漏拷文件导致
    // 沙箱恒红（#120/#122 一类）也无人发现——这里改成硬断言 pass。
    assert.strictEqual(result.status, 'pass',
      `沙箱内单元测试应整体通过，实际 ${result.status}。output 末尾：${result.output.slice(-400)}`)
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
