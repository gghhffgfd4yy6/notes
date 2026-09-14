'use strict'

// run_mutation.js 内部函数补测：纯函数 + 文件系统操作
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  lineColumn, isIdentStart, isIdentPart,
  lineTriple, numberBefore, numberAfter,
  mapLimit, saveCheckpoint, loadCheckpoint,
  copyProject, linkNodeModules, applyMutants
} = require('./run_mutation')

let pass = 0
// check 必须等待 fn 完成：异步用例（mapLimit 等）若不被 await，
// ✅ 与 pass++ 会在断言真正执行前就发生，导致「假绿 + 计数虚增」。
const check = async (name, fn) => { await fn(); pass++; console.log(`  ✅ ${name}`) }

;(async () => {
  console.log('\n📂 run_mutation 内部函数补测')

  // ===== lineColumn =====
  console.log('\n--- lineColumn ---')
  await check('单行偏移', () => {
    const r = lineColumn('hello world', 6)
    assert.strictEqual(r.line, 1)
    assert.strictEqual(r.column, 6)
  })
  await check('多行偏移', () => {
    const r = lineColumn('line1\nline2\nline3', 14)
    assert.strictEqual(r.line, 3)
    assert.strictEqual(r.column, 2)
  })
  await check('偏移 0', () => {
    const r = lineColumn('abc', 0)
    assert.strictEqual(r.line, 1)
    assert.strictEqual(r.column, 0)
  })
  await check('行首偏移', () => {
    const r = lineColumn('aaa\nbbb', 4)
    assert.strictEqual(r.line, 2)
    assert.strictEqual(r.column, 0)
  })

  // ===== isIdentStart / isIdentPart =====
  console.log('\n--- isIdentStart / isIdentPart ---')
  await check('isIdentStart 字母', () => assert.strictEqual(isIdentStart('a'), true))
  await check('isIdentStart 下划线', () => assert.strictEqual(isIdentStart('_'), true))
  await check('isIdentStart 美元符', () => assert.strictEqual(isIdentStart('$'), true))
  await check('isIdentStart 数字(非法)', () => assert.strictEqual(isIdentStart('1'), false))
  await check('isIdentStart 空字符', () => assert.strictEqual(isIdentStart(''), false))
  await check('isIdentPart 数字', () => assert.strictEqual(isIdentPart('1'), true))
  await check('isIdentPart 字母', () => assert.strictEqual(isIdentPart('z'), true))
  await check('isIdentPart 运算符(非法)', () => assert.strictEqual(isIdentPart('+'), false))

  // ===== numberBefore / numberAfter =====
  console.log('\n--- numberBefore / numberAfter ---')
  await check('numberBefore 紧邻数字', () => {
    assert.strictEqual(numberBefore('5 通过', 2), '5')
  })
  await check('numberBefore 空白间隔', () => {
    assert.strictEqual(numberBefore('5  通过', 3), '5')
  })
  await check('numberBefore 无数字', () => {
    assert.strictEqual(numberBefore('通过', 2), null)
  })
  await check('numberAfter 紧邻数字', () => {
    assert.strictEqual(numberAfter('共 10', 0, 1), '10')
  })
  await check('numberAfter 空白间隔', () => {
    assert.strictEqual(numberAfter('共  10', 0, 1), '10')
  })
  await check('numberAfter 无数字', () => {
    assert.strictEqual(numberAfter('共', 0, 1), null)
  })

  // ===== lineTriple =====
  console.log('\n--- lineTriple ---')
  await check('标准格式 "3 通过, 1 失败, 共 4"', () => {
    const r = lineTriple('3 通过, 1 失败, 共 4')
    assert.deepStrictEqual(r, ['3', '1', '4'])
  })
  await check('无 "共" 返回 null', () => {
    assert.strictEqual(lineTriple('3 通过, 1 失败'), null)
  })
  await check('无 "失败" 返回 null', () => {
    assert.strictEqual(lineTriple('3 通过, 共 4'), null)
  })
  await check('无 "通过" 返回 null', () => {
    assert.strictEqual(lineTriple('1 失败, 共 4'), null)
  })
  await check('取最后一个 "共 N"', () => {
    const r = lineTriple('共 99, 3 通过, 1 失败, 共 4')
    assert.deepStrictEqual(r, ['3', '1', '4'])
  })
  await check('前置无关 "通过/失败" 不抢答', () => {
    const r = lineTriple('检查通过：之前失败 0，3 通过, 1 失败, 共 4')
    assert.deepStrictEqual(r, ['3', '1', '4'])
  })

  // ===== mapLimit =====
  console.log('\n--- mapLimit ---')
  async function trackConcurrency (limit, count) {
    let concurrent = 0; let maxConcurrent = 0
    await mapLimit(Array.from({ length: count }), limit, async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(resolve => setTimeout(resolve, 10)); concurrent--
    })
    return maxConcurrent
  }
  await check('顺序执行结果', async () => {
    const results = await mapLimit([1, 2, 3], 2, async (x) => x * 2)
    assert.deepStrictEqual(results, [2, 4, 6])
  })
  await check('limit=1 串行', async () => {
    assert.strictEqual(await trackConcurrency(1, 3), 1)
  })
  await check('limit=2 最多 2 并发', async () => {
    assert.strictEqual(await trackConcurrency(2, 4), 2)
  })
  await check('空数组返回空', async () => {
    const r = await mapLimit([], 5, async () => 1)
    assert.deepStrictEqual(r, [])
  })
  await check('limit 大于 items 长度', async () => {
    const r = await mapLimit([1, 2], 10, async (x) => x + 1)
    assert.deepStrictEqual(r, [2, 3])
  })

  // ===== saveCheckpoint / loadCheckpoint =====
  console.log('\n--- saveCheckpoint / loadCheckpoint ---')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-ckpt-'))
  try {
    await check('保存后读取一致', () => {
      const file = path.join(tmpDir, 'ckpt.json')
      const state = { killed: [[1, 'ok']], survived: [], pending: [[2, 3]] }
      saveCheckpoint(file, state)
      const loaded = loadCheckpoint(file)
      assert.deepStrictEqual(loaded, state)
    })
    await check('原子写入：临时文件已 rename', () => {
      const file = path.join(tmpDir, 'ckpt2.json')
      saveCheckpoint(file, { a: 1 })
      assert.ok(fs.existsSync(file), '目标文件应存在')
      assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), '临时文件应已清理')
    })
    await check('读取不存在文件返回 null', () => {
      assert.strictEqual(loadCheckpoint(path.join(tmpDir, 'nonexistent.json')), null)
    })
    await check('读取非法 JSON 返回 null', () => {
      const file = path.join(tmpDir, 'bad.json')
      fs.writeFileSync(file, 'not json{{{', 'utf8')
      assert.strictEqual(loadCheckpoint(file), null)
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  // ===== copyProject + applyMutants =====
  console.log('\n--- copyProject / applyMutants ---')
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-proj-'))
  try {
    await check('copyProject 复制文件与 node_modules symlink（缺依赖时按契约抛错）', () => {
      // node_modules 属必选输入（#136 review F3）：symlinkSync 不校验目标是否存在，缺依赖时会留下
      // 悬空链接 → 沙箱内套件必然失败 → 每个变异体被判 killed → 分数虚高且 exit 0（不响亮的假绿）。
      // 故未 npm ci 的环境下必须抛错；有依赖时仍按原断言核对复制结果与 symlink。
      if (!fs.existsSync(path.resolve(__dirname, 'node_modules'))) {
        assert.throws(
          () => copyProject(projDir, ['xbk_utils.js']),
          /缺少 node_modules/,
          '无 node_modules 时应抛错，而不是留下悬空 symlink（不响亮的假绿）'
        )
        return
      }
      copyProject(projDir, ['xbk_utils.js'])
      assert.ok(fs.existsSync(path.join(projDir, 'test_filter.js')), 'test_filter.js 应复制')
      assert.ok(fs.existsSync(path.join(projDir, 'package.json')), 'package.json 应复制')
      assert.ok(fs.existsSync(path.join(projDir, 'xbk_utils.js')), 'xbk_utils.js 应复制')
      assert.ok(fs.existsSync(path.join(projDir, 'run_mutation.js')), 'run_mutation.js 应复制（多个单元套件顶层 require 它）')
      assert.ok(fs.existsSync(path.join(projDir, 'CHANGELOG.md')), 'CHANGELOG.md 应复制（test_filter.js 版本一致性用例读取它）')
      assert.ok(fs.existsSync(path.join(projDir, '.github/workflows/test.yml')), '.github/workflows/test.yml 应复制（test_ci_skip_suites.js 读取它与显式步骤对账）')
      const nmStat = fs.lstatSync(path.join(projDir, 'node_modules'))
      assert.ok(nmStat.isSymbolicLink(), 'node_modules 应为 symlink')
    })
    await check('linkNodeModules 来源根缺 node_modules 必抛错且不留悬空 symlink（自建临时目录，CI 亦必执行）', () => {
      // 上一条用例把「缺依赖必抛错」交给本机是否 npm ci 决定：CI 在 npm ci 之后必然存在 node_modules，
      // 那条 assert.throws 分支在 CI 中永不执行——删掉 run_mutation.js 的 throw，CI 依然全绿（不响亮的假绿）。
      // 此处改从依赖注入点触发：来源根是自己造的临时目录（确实没有 node_modules），与 CI 是否装好依赖无关，
      // 任何环境都会走到「必须抛错」这条分支，且断言覆盖「不能留下悬空 symlink」这一原始危害。
      const noDepsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-nodeps-src-'))
      const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-nodeps-dst-'))
      try {
        assert.throws(
          () => linkNodeModules(linkDir, noDepsRoot),
          /缺少 node_modules/,
          '来源根缺 node_modules 时应抛错，而不是留下悬空 symlink（不响亮的假绿）'
        )
        // existsSync 跟随链接，悬空 symlink 同样返回 false——故必须用 lstatSync 确认「连条目都没有」
        assert.throws(
          () => fs.lstatSync(path.join(linkDir, 'node_modules')),
          /ENOENT/,
          '抛错须先于 symlinkSync：目标目录不得留下 node_modules 条目（含悬空链接）'
        )
      } finally {
        fs.rmSync(noDepsRoot, { recursive: true, force: true })
        fs.rmSync(linkDir, { recursive: true, force: true })
      }
    })
    await check('linkNodeModules 来源根有 node_modules 时建出可用 symlink（注入点正向对照）', () => {
      // 正向对照：证明来源根确实被采纳（若实现恒抛错或忽略 sourceRoot，本用例会失败）
      const depsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-deps-src-'))
      const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-deps-dst-'))
      try {
        fs.mkdirSync(path.join(depsRoot, 'node_modules'))
        const link = linkNodeModules(linkDir, depsRoot)
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'node_modules 应为 symlink')
        // realpath 比对：两侧都取真实路径，规避 macOS /tmp → /private/tmp 一类系统级链接差异
        assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(depsRoot, 'node_modules')), 'symlink 应指向来源根的 node_modules')
      } finally {
        fs.rmSync(depsRoot, { recursive: true, force: true })
        fs.rmSync(linkDir, { recursive: true, force: true })
      }
    })
    await check('copyProject 缺少调用方必选文件时抛错（固定清单加固回归）', () => {
      // 原实现遇缺失文件静默 continue，留下临时工程目录 MODULE_NOT_FOUND/ENOENT 的
      // 不响亮回归（#120/#122 一类根因）；加固后必选文件（extraTop + 调用方 files）缺失须抛错。
      assert.throws(
        () => copyProject(path.join(projDir, 'missing'), ['no_such_required_file.js']),
        /缺少必要文件: no_such_required_file\.js/
      )
    })
    await check('applyMutants 替换操作符（fixture 固定内容）', () => {
      const fixture = path.join(projDir, 'fixture.js')
      fs.writeFileSync(fixture, 'if (a && b) { c || d }', 'utf8')
      const mutants = [{ file: 'fixture.js', start: 6, end: 8, original: '&&', replacement: '||', kind: 'operator', id: 1 }]
      applyMutants(projDir, mutants)
      const modified = fs.readFileSync(fixture, 'utf8')
      assert.strictEqual(modified, 'if (a || b) { c || d }', '&& 应被替换为 ||')
    })
    await check('applyMutants 多变异体倒序应用不重叠（fixture）', () => {
      const fixture = path.join(projDir, 'fixture2.js')
      fs.writeFileSync(fixture, 'x && y && z', 'utf8')
      // 两个 &&：位置 2-4 和 7-9，倒序应用避免偏移
      const mutants = [
        { file: 'fixture2.js', start: 2, end: 4, original: '&&', replacement: '||', id: 1 },
        { file: 'fixture2.js', start: 7, end: 9, original: '&&', replacement: '||', id: 2 }
      ]
      applyMutants(projDir, mutants)
      const modified = fs.readFileSync(fixture, 'utf8')
      assert.strictEqual(modified, 'x || y || z', '两个 && 都应被替换')
    })
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true })
  }

  console.log(`\n🎉 test_run_mutation_internal 全部通过（${pass} 项）`)
})().catch((e) => { console.error(e); process.exit(1) })
