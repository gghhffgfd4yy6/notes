'use strict'
/* codacy-disable-file: 测试 sandbox — tmpdir 由 fs.mkdtempSync 创建，
   Codacy 对"动态路径 + fs.writeFileSync" pattern 误报；本文件不参与
   生产 I/O，无路径遍历风险。 */

// 回归测试：mutation-json 超大文件解析（v3.264）
// stryker command runner 把整段测试输出写进每个变异体的 statusReason，单文件可达 500MB+，
// 超过 V8 字符串上限（0x1fffffe8）——readReportJson 按字节剥离 statusReason 后再解析。
const assert = require('node:assert')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const { readReportJson, resolveMaxReportBytes, DEFAULT_MAX_FILE_BYTES, MAX_BUFFER_BYTES } = require('./scripts/mutation-json.js')

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-json-test-'))

function parseJson (json, options) {
  const file = path.join(tmpdir, 'case.json')
  // nosemgrep: 测试临时文件路径由代码生成，非外部输入
  fs.writeFileSync(file, json)
  return readReportJson(file, options)
}

const cases = [
  { name: 'statusReason 剥离为空串', json: '{"a":1,"statusReason":"hello world","b":2}', expect: { a: 1, statusReason: '', b: 2 } },
  { name: 'statusReason 为 null 时保留', json: '{"statusReason":null,"a":1}', expect: { statusReason: null, a: 1 } },
  { name: '冒号前有空白仍剥离', json: '{"a":1,"statusReason" : " x ","b":2}', expect: { a: 1, statusReason: '', b: 2 } },
  { name: 'statusReason2 相似字段不误伤', json: '{"statusReason2":"keep me","statusReason":"y"}', expect: { statusReason2: 'keep me', statusReason: '' } },
  { name: '值内转义引号/反斜杠', json: String.raw`{"statusReason":"a\"b\\c","n":1}`, expect: { statusReason: '', n: 1 } },
  { name: '值内含转义字段名文本', json: String.raw`{"statusReason":"pre \"statusReason\": post","n":2}`, expect: { statusReason: '', n: 2 } },
  { name: '无 statusReason 原样解析', json: '{"a":[1,2,{"x":"y"}]}', expect: { a: [1, 2, { x: 'y' }] } }
]

let pass = 0
try {
  for (const c of cases) {
    assert.deepStrictEqual(parseJson(c.json), c.expect, c.name)
    console.log(`✅ ${c.name}`)
    pass++
  }
  // 大值（8MB）：模拟真实场景的整段测试输出，验证可被剥离且其余字段保留
  const big = `{"statusReason":"${'x'.repeat(8 * 1024 * 1024)}","status":"Survived"}`
  const bigResult = parseJson(big)
  assert.strictEqual(bigResult.statusReason, '', '8MB statusReason 应被剥离为空串')
  assert.strictEqual(bigResult.status, 'Survived', '其余字段应保留')
  console.log('✅ 8MB statusReason 剥离后正常解析')
  pass++
  // ===== F1：字符串上限守卫必须在 Buffer.concat（分配峰值）之前生效 =====
  // 旧实现先整份 concat（内存翻倍）再比 MAX_STRING_LENGTH——超限输入要先付出分配峰值才发现
  // 放不下。现改为边扫边累计剥离后字节数，判定落在 concat 之前。
  // 夹具经既有的 parseJson（固定文件名 case.json）落盘，不另建动态路径写法。
  {
    const limitJson = '{"a":1,"statusReason":"hello world","b":2}'
    const strippedBytes = Buffer.byteLength('{"a":1,"statusReason":"","b":2}')
    // ① 长度算术必须精确：上限恰等于剥离后长度时不得误报（多算 1 字节即会误杀合法报告）
    assert.deepStrictEqual(parseJson(limitJson, { maxStringLength: strippedBytes }),
      { a: 1, statusReason: '', b: 2 }, '上限恰等于剥离后长度时不应误报')
    // ② 少 1 字节必须报错，且报错里的字节数是真实剥离后长度（证明累计值没有算偏）
    const realConcat = Buffer.concat
    let concatCalls = 0
    let limitError = null
    Buffer.concat = function (...args) {
      concatCalls += 1
      return realConcat.apply(Buffer, args)
    }
    try {
      parseJson(limitJson, { maxStringLength: strippedBytes - 1 })
    } catch (e) {
      limitError = e
    } finally {
      Buffer.concat = realConcat
    }
    assert.ok(limitError, '剥离后超过上限必须抛错')
    assert.ok(String(limitError.message).includes(`仍为 ${strippedBytes} 字节`),
      `报错必须给出真实剥离后字节数（先算后分的算术不能偏），实际：${limitError && limitError.message}`)
    assert.ok(String(limitError.message).includes('case.json'), '超限报错必须带报告路径')
    assert.strictEqual(concatCalls, 0, '超限必须在 Buffer.concat（分配峰值）之前判定，不得先分配再报错')
    console.log('✅ 字符串上限守卫在 Buffer.concat 分配峰值之前生效')
    pass++
  }

  // 损坏 JSON：报错应包含文件路径与尺寸上下文（便于定位，而非 V8 晦涩异常）
  assert.throws(() => parseJson('{"a":1'), err => String(err.message).includes('case.json'), '损坏 JSON 报错应包含文件路径')
  console.log('✅ 解析失败报错包含文件路径与尺寸上下文')
  pass++

  // ===== F1：预读大小护栏必须在 readFileSync（分配峰值）之前生效 =====
  // 旧实现唯一的尺寸守卫在 Buffer.concat 之后；超限输入要先付一次整份报告的分配才发现放不下。
  // 现改为「一次 openSync + **只对 fd** fstatSync 预检大小与类型，再按同一 fd 读」——判定与读取
  // 作用于同一个 inode，不存在 statSync(路径)→readFileSync(路径) 的二次查找窗口
  // （CodeQL js/file-system-race）。因此这里计数 fstatSync（fd 探测），上限可注入以免构造 4GiB 夹具。
  {
    const file = path.join(tmpdir, 'oversize.json')
    fs.writeFileSync(file, '{"a":1}') // 7 字节
    const realReadFileSync = fs.readFileSync
    let readCalls = 0
    let fstatCalls = 0
    const realFstatSync = fs.fstatSync
    fs.fstatSync = function (...args) { fstatCalls += 1; return realFstatSync.apply(fs, args) }
    fs.readFileSync = function (...args) { readCalls += 1; return realReadFileSync.apply(fs, args) }
    let limitError = null
    try {
      readReportJson(file, { maxFileBytes: 4 })
    } catch (e) {
      limitError = e
    } finally {
      fs.readFileSync = realReadFileSync
      fs.fstatSync = realFstatSync
    }
    assert.ok(limitError, '超过预读上限必须抛错')
    assert.ok(String(limitError.message).includes('oversize.json'), `预读超限报错必须带路径，实际：${limitError && limitError.message}`)
    assert.ok(String(limitError.message).includes('7 字节'), `预读超限报错必须带真实大小，实际：${limitError && limitError.message}`)
    assert.ok(String(limitError.message).includes('4 字节'), `预读超限报错必须带上限，实际：${limitError && limitError.message}`)
    assert.strictEqual(fstatCalls > 0, true, '必须先 fstat 取真实大小')
    assert.strictEqual(readCalls, 0, '超限必须在 readFileSync（分配峰值）之前判定，不得先整份读入再报错')
    console.log('✅ 预读大小护栏在 readFileSync 分配之前生效（含路径与真实大小，按 fd fstat 探测）')
    pass++
  }

  // ===== F1（返工）：预读大小护栏必须是**生产有语义的策略上限**，而不是 Buffer 边界改文案 =====
  // 上一版默认 maxFileBytes = buffer.constants.MAX_LENGTH ≈ 8 PiB：任何真实文件系统都到不了，
  // 且两个生产调用方都不注入 options ⇒ 该分支生产中恒假（独立验证 V3 打回）。返工后默认是 2 GiB
  // 的显式策略值（报告按设计可达 500MB+，留足余量；病态输入在读入前失败而非把 runner 读 OOM），
  // 并可由 XBK_MUTATION_REPORT_MAX_BYTES 覆盖。下列断言把「默认值必须是策略而非 Buffer 边界」
  // 与「解析器不得把配置笔误变成无上限」钉死。
  {
    assert.ok(Number.isFinite(DEFAULT_MAX_FILE_BYTES) && DEFAULT_MAX_FILE_BYTES > 0, '默认预读上限必须是有限正值')
    assert.ok(DEFAULT_MAX_FILE_BYTES < MAX_BUFFER_BYTES,
      `默认预读上限必须是有生产意义的策略值（真实现约 500MB+ 的报告），而不是 buffer.constants.MAX_LENGTH（≈8 PiB，生产恒假）：实际 ${DEFAULT_MAX_FILE_BYTES}`)
    assert.ok(DEFAULT_MAX_FILE_BYTES >= 1024 * 1024 * 1024,
      `默认上限必须容得下文件头声明的 500MB+ 报告：实际 ${DEFAULT_MAX_FILE_BYTES}`)
    assert.strictEqual(resolveMaxReportBytes(undefined), DEFAULT_MAX_FILE_BYTES, '缺省用策略默认值')
    assert.strictEqual(resolveMaxReportBytes(''), DEFAULT_MAX_FILE_BYTES, '空串按缺省')
    assert.strictEqual(resolveMaxReportBytes('1024'), 1024, '正整数覆盖生效')
    assert.strictEqual(resolveMaxReportBytes(' 2048 '), 2048, '空白不敏感')
    assert.strictEqual(resolveMaxReportBytes('off'), MAX_BUFFER_BYTES, 'off 显式退回 Buffer 边界（关闭策略上限）')
    assert.strictEqual(resolveMaxReportBytes('OFF'), MAX_BUFFER_BYTES, 'off 大小写不敏感')
    const badValues = ['abc', '-1', '0', 'NaN', 'Infinity', '-Infinity']
    for (const bad of badValues) {
      assert.strictEqual(resolveMaxReportBytes(bad), DEFAULT_MAX_FILE_BYTES,
        `非法值 ${bad} 必须回落策略默认值——绝不静默变成「无上限」`)
    }
    assert.strictEqual(resolveMaxReportBytes(String(MAX_BUFFER_BYTES + 1)), MAX_BUFFER_BYTES,
      '覆盖值不得越过 Buffer 能表示的边界（否则 readFileSync 会抛无上下文的 ERR_OUT_OF_RANGE）')
    console.log('✅ 预读大小上限是生产有语义的策略值（默认 2 GiB / 可覆盖 / 非法值不变成无上限）')
    pass++
  }

  // F1：非普通文件（目录等）在读入前拒绝——readFileSync 对目录抛不带路径的 EISDIR，对 FIFO 会阻塞
  {
    let dirError = null
    try {
      readReportJson(tmpdir)
    } catch (e) {
      dirError = e
    }
    assert.ok(dirError, '目录入参必须抛错')
    assert.ok(String(dirError.message).includes('不是普通文件'),
      `目录必须被预读护栏拒绝，实际：${dirError && dirError.message}`)
    assert.ok(String(dirError.message).includes(path.basename(tmpdir)),
      `报错必须带路径上下文，实际：${dirError && dirError.message}`)
    console.log('✅ 非普通文件在读入前被拒绝（带路径上下文）')
    pass++
  }

  // Codacy MEDIUM：传入相对路径时，错误信息中的路径应是绝对路径（path.resolve 防御性 normalize）
  // 当前实现（不加 path.resolve）错误信息会保留传入的相对路径 → 测试会红
  {
    const origCwd = process.cwd()
    try {
      const file = path.join(tmpdir, 'abs-path-err.json')
      // codacy-disable-next-line：test sandbox — tmpdir 由 fs.mkdtempSync 创建，非用户输入
      // nosemgrep: test fixture, no path traversal risk
      fs.writeFileSync(file, '{ broken')
      process.chdir(tmpdir) // 让后续相对路径以 tmpdir 为基准
      let err
      try {
        readReportJson('./abs-path-err.json')
      } catch (e) {
        err = e
      }
      assert.ok(err, '相对路径 + 损坏 JSON 应抛出错误')
      const msg = String(err.message)
      // 取出 message 中所有 *.json 出现。原先用 /[^\s：:]+\.json/g：该式只有一个重叠量词，
      // 失配时每个起始位置都要把后缀整段重扫，长点串输入下是 O(n²)（二次，非指数）——即 S8786
      // 判定的超线性回溯。改为按分隔符切分再判后缀：线性，且比原式更严（要求整个 token 以
      // .json 结尾）。冒号仅在不后跟路径分隔符时才算分隔符，否则 Windows 盘符（C:\tmp\x.json）
      // 会被切掉，剩下的 \tmp\x.json 又恰好被 path.win32.isAbsolute 判为绝对，断言就失去咬合力。
      const pathMatches = msg.split(/[\s：]+|:(?![\\/])/).filter(t => t.endsWith('.json'))
      assert.ok(
        pathMatches.some(p => path.isAbsolute(p)),
        `错误信息应至少含一个绝对路径（防御性 path.resolve），实际：${msg}`
      )
      console.log('✅ 错误信息报告绝对路径（path.resolve 防御性 normalize）')
      pass++
    } finally {
      process.chdir(origCwd)
    }
  }

  // ===== fail-closed 守卫（scripts/mutation-guard.js）=====
  // 背景：stryker 的分数门禁（thresholds.break）在 totalValid === 0 时 mutationScore 为 NaN，而判据是
  // `NaN < break === false` ⇒ 不置退出码 ⇒ **job 假绿**。本 PR 撤回分数门禁（break 改回 null）后，由
  // scripts/mutation-guard.js 承担恒常判据：runtimeErrors > 0 / totalValid === 0 / 报告缺失或不可读 /
  // 报告结构非法 ⇒ exit 1。用例直接调用导出的 run()（注入 io 拿退出码与输出，不真结束进程），
  // 并另用**子进程**锁住 CLI 接线（require.main === module → process.exitCode）。
  {
    const { run, countMutantsByStatus, MUTANT_STATUSES } = require('./scripts/mutation-guard.js')
    const loc = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
    const mutant = (id, status) => ({ id, mutatorName: 'EqualityOperator', location: loc, status })
    const report = (mutants) => ({
      schemaVersion: '2',
      thresholds: { high: 80, low: 60, break: null },
      files: { 'xbk_storage.js': { language: 'javascript', source: 'x', mutants } }
    })
    const writeFixture = (name, obj) => {
      const p = path.join(tmpdir, name)
      fs.writeFileSync(p, JSON.stringify(obj))
      return p
    }
    // 注入 io：退出码必须由 run() 返回（而不是真结束进程），env 传空对象保证 hermetic
    // （不读宿主机的 XBK_MUTATION_REPORT_MAX_BYTES）。
    const guardRun = (argv, env = {}) => {
      let out = ''
      let err = ''
      const code = run(argv, {
        stdout: { write: s => { out += s } },
        stderr: { write: s => { err += s } },
        env
      })
      return { code, out, err }
    }

    // 状态集合必须与 mutation-testing-report-schema 的 MutantStatus enum 同宽（8 个）：
    // 收窄成 countMutant 计数的 4 个（Killed/Survived/NoCoverage/Timeout）会把正常报告整段拒掉。
    assert.strictEqual(MUTANT_STATUSES.size, 8, '守卫的状态集合必须覆盖 schema enum 的 8 个状态')
    for (const s of ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored', 'Pending']) {
      assert.ok(MUTANT_STATUSES.has(s), `守卫状态集合缺少 ${s}`)
    }
    // 计数口径直接钉死：runtimeErrors 只数 RuntimeError；totalValid 只含 4 个有效状态，
    // 不含 CompileError/Ignored/Pending（与 stryker 的 toMetrics 逐字一致）。
    {
      const c = countMutantsByStatus(report([
        mutant('1', 'RuntimeError'), mutant('2', 'CompileError'), mutant('3', 'Ignored'),
        mutant('4', 'Pending'), mutant('5', 'Killed'), mutant('6', 'Timeout'),
        mutant('7', 'Survived'), mutant('8', 'NoCoverage')
      ]))
      assert.strictEqual(c.runtimeErrors, 1, 'runtimeErrors 只数 RuntimeError（CompileError 另计）')
      assert.strictEqual(c.compileErrors, 1, 'compileErrors 只数 CompileError')
      assert.strictEqual(c.totalValid, 4, 'totalValid = killed+timeout+survived+noCoverage（不含 invalid/ignored/pending）')
      assert.strictEqual(c.total, 8, 'total 计全部 8 个状态')
      assert.strictEqual(c.totalInvalid, 2, 'totalInvalid = runtimeErrors + compileErrors')
      console.log('✅ 守卫计数口径：runtimeErrors/compileErrors/totalValid/total 与 stryker toMetrics 一致')
      pass++
    }
    console.log('✅ 守卫状态集合与 MutantStatus enum 同宽（8 个，未收窄成计数的 4 个）')
    pass++

    // ① 正常报告（killed/survived/timeout/noCoverage 混合）⇒ 绿，且计数口径与 stryker 的 toMetrics 一致
    const goodPath = writeFixture('guard-good.json', report([
      mutant('1', 'Killed'), mutant('2', 'Killed'), mutant('3', 'Timeout'),
      mutant('4', 'Survived'), mutant('5', 'NoCoverage')
    ]))
    {
      const r = guardRun(['--segment', 'storage', goodPath])
      assert.strictEqual(r.code, 0, `正常报告必须 exit 0：\n${r.out}${r.err}`)
      assert.ok(r.out.includes('守卫通过'), '正常报告应打印通过信息')
      assert.strictEqual(r.err, '', `正常报告不应有 stderr 输出，实际：${r.err}`)
      assert.ok(r.out.includes('killed=2 timeout=1 survived=1 noCoverage=1') && r.out.includes('totalValid=5 total=5'),
        `计数口径必须与 stryker 的 toMetrics 一致（totalValid = killed+timeout+survived+noCoverage）：\n${r.out}`)
      console.log('✅ 守卫：正常报告（killed/survived 混合）exit 0，计数口径与 stryker 一致')
      pass++
    }

    // ② 全 RuntimeError ⇒ 该红（这是分数门禁看不见的那一类：totalValid > 0 时它照样可能绿）
    const runtimePath = writeFixture('guard-all-runtime.json', report([
      mutant('1', 'RuntimeError'), mutant('2', 'RuntimeError'), mutant('3', 'Killed')
    ]))
    {
      const r = guardRun(['--segment', 'storage', runtimePath])
      assert.strictEqual(r.code, 1, `全 RuntimeError 报告必须 exit 1：\n${r.out}${r.err}`)
      assert.ok(r.err.includes('[storage]'), '失败输出必须带段名')
      assert.ok(r.err.includes('runtimeErrors=2'), `失败输出必须给出各状态计数，实际：\n${r.err}`)
      assert.ok(r.err.includes('RuntimeError'), '失败输出必须点明 RuntimeError')
      assert.ok(r.err.includes('退出码 1'), '失败输出必须写明退出码')
      assert.ok(!r.out.includes('守卫通过'), `失败报告不得打成 ✅（自相矛盾），实际 stdout：${r.out}`)
      // 该段 totalValid = 1（Killed）> 0 ⇒ 只应命中「runtimeErrors > 0」这一条，而不是 NaN 通道
      assert.ok(!r.err.includes('DEFAULT_SCORE'), '本例 totalValid > 0，不应命中 NaN 通道')
      console.log('✅ 守卫：全 RuntimeError（含 1 个 Killed ⇒ 分数门禁看不见）exit 1')
      pass++
    }

    // ③ 空报告 / totalValid = 0 ⇒ 该红（NaN 假绿通道）
    {
      const emptyFiles = writeFixture('guard-empty-files.json', {
        schemaVersion: '2', thresholds: { high: 80, low: 60, break: null }, files: {}
      })
      const zeroValid = writeFixture('guard-zero-valid.json', report([mutant('1', 'CompileError'), mutant('2', 'Ignored')]))
      for (const [name, p] of [['files 空映射', emptyFiles], ['全 CompileError/Ignored（totalValid=0）', zeroValid]]) {
        const r = guardRun(['--segment', 'storage', p])
        assert.strictEqual(r.code, 1, `${name} 必须 exit 1（否则 job 假绿）：\n${r.out}${r.err}`)
        assert.ok(r.err.includes('totalValid'), `${name} 的失败输出必须给出 totalValid，实际：\n${r.err}`)
        assert.ok(r.err.includes('NaN'), `${name} 的失败输出必须点明 NaN 假绿通道，实际：\n${r.err}`)
        assert.ok(r.err.includes('退出码 1'), `${name} 的失败输出必须写明退出码`)
      }
      assert.ok(guardRun(['--segment', 'storage', emptyFiles]).err.includes('不含任何变异体'),
        'files 空映射必须被描述为「不含任何变异体」')
      assert.ok(guardRun(['--segment', 'storage', zeroValid]).err.includes('无有效变异体'),
        '有变异体但全无效必须被描述为「无有效变异体」')
      console.log('✅ 守卫：空报告 / totalValid=0（NaN 假绿通道）exit 1')
      pass++
    }

    // ④ 报告缺失 / 不可读 ⇒ 该红（fail-closed），且措辞必须与「worker 未产出报告」的缺段判据区分开
    {
      const missing = path.join(tmpdir, 'guard-does-not-exist.json')
      const r = guardRun(['--segment', 'storage', missing])
      assert.strictEqual(r.code, 1, '报告缺失必须 exit 1（fail-closed）：\n' + r.out + r.err)
      assert.ok(r.err.includes('报告缺失或不可读'), `失败输出必须点明「报告缺失或不可读」，实际：\n${r.err}`)
      assert.ok(r.err.includes('validateSegments'), `措辞必须与「worker 未产出报告」的缺段判据区分（点明缺段由 validateSegments 负责），实际：\n${r.err}`)
      assert.ok(!r.err.includes('RuntimeError'), '缺失报告不应被误报成 RuntimeError')
      // 目录入参：证明复用了 mutation-json 的 readGuardedBytes（非普通文件在读入前拒绝），而不是自己 readFileSync
      const dirR = guardRun(['--segment', 'storage', tmpdir])
      assert.strictEqual(dirR.code, 1, '目录入参必须 exit 1')
      assert.ok(dirR.err.includes('不是普通文件'), `必须复用 readGuardedBytes 的非普通文件拒绝，实际：\n${dirR.err}`)
      console.log('✅ 守卫：报告缺失/不可读 exit 1（fail-closed，措辞与缺段判据区分，复用 readGuardedBytes）')
      pass++
    }

    // ⑤ 报告存在但结构非法 ⇒ 该红（算不出来不许当通过）
    {
      const noFiles = writeFixture('guard-no-files.json', { schemaVersion: '2' })
      const badStatus = writeFixture('guard-bad-status.json', report([mutant('1', 'Bogus')]))
      for (const [name, p] of [['缺 files 映射', noFiles], ['未知 status', badStatus]]) {
        const r = guardRun(['--segment', 'storage', p])
        assert.strictEqual(r.code, 1, `${name} 必须 exit 1：\n${r.out}${r.err}`)
        assert.ok(r.err.includes('结构非法') || r.err.includes('未知 status'), `${name} 必须以结构非法/未知 status 报错，实际：\n${r.err}`)
      }
      console.log('✅ 守卫：报告结构非法（缺 files / 未知 status）exit 1')
      pass++
    }

    // ⑥ 上限口径必须复用 resolveMaxReportBytes + readReportJson 的预读护栏（不另写一份读取/上限逻辑）
    {
      const r = guardRun(['--segment', 'storage', goodPath], { XBK_MUTATION_REPORT_MAX_BYTES: '10' })
      assert.strictEqual(r.code, 1, '注入极小 XBK_MUTATION_REPORT_MAX_BYTES 后必须 exit 1（证明上限来自 mutation-json）')
      assert.ok(r.err.includes('超过预读上限'), `必须报出 mutation-json 的预读上限文案，实际：\n${r.err}`)
      // 巨大 statusReason 必须能被剥离后正常判定（command runner 的真实报告可达 500MB+，raw JSON.parse 会炸）
      const big = report([mutant('1', 'Killed')])
      big.files['xbk_storage.js'].mutants[0].statusReason = 'x'.repeat(4 * 1024 * 1024)
      const bigPath = writeFixture('guard-big-status-reason.json', big)
      const rb = guardRun(['--segment', 'storage', bigPath])
      assert.strictEqual(rb.code, 0, `4MB statusReason 必须经 readReportJson 剥离后正常判定：\n${rb.out}${rb.err}`)
      console.log('✅ 守卫：读取与大小上限复用 mutation-json.js（预读上限生效 + 巨型 statusReason 可剥离）')
      pass++
    }

    // ⑦ 参数/多报告语义：无路径、未知参数、缺取值、混合（一绿一红）一律 fail-closed
    {
      const cases = [
        { name: '无报告路径', argv: [], hint: '没有给出任何报告路径' },
        { name: '未知参数', argv: ['--segmnt', 'storage', goodPath], hint: '未知参数' },
        { name: '--segment 缺取值', argv: ['--segment'], hint: '缺少取值' }
      ]
      for (const c of cases) {
        const r = guardRun(c.argv)
        assert.strictEqual(r.code, 1, `${c.name} 必须 exit 1`); assert.ok(r.err.includes(c.hint), `${c.name} 的报错应含「${c.hint}」，实际：${r.err}`)
      }
      const mixed = guardRun(['--segment', 'storage', goodPath, runtimePath])
      assert.strictEqual(mixed.code, 1, '多报告中任一不合格 ⇒ 整体 exit 1')
      assert.ok(mixed.out.includes('守卫通过'), '合格的那一份仍应打印通过信息（定位用）')
      console.log('✅ 守卫：无路径/未知参数/缺取值/多报告混合 全部 fail-closed exit 1')
      pass++
    }

    // ⑧ CLI 接线（子进程）：require.main === module 分支必须把 run() 的返回值写进 process.exitCode
    {
      const guardPath = path.join(__dirname, 'scripts', 'mutation-guard.js')
      const green = spawnSync(process.execPath, [guardPath, '--segment', 'storage', goodPath], { encoding: 'utf8' })
      assert.strictEqual(green.status, 0, `守卫 CLI 对正常报告应 exit 0：\n${green.stdout}\n${green.stderr}`)
      const red = spawnSync(process.execPath, [guardPath, '--segment', 'storage', runtimePath], { encoding: 'utf8' })
      assert.strictEqual(red.status, 1, `守卫 CLI 对含 RuntimeError 的报告应 exit 1：\n${red.stdout}\n${red.stderr}`)
      assert.ok(String(red.stderr).includes('退出码 1'), `CLI 失败输出应写明退出码，实际 stderr：${red.stderr}`)
      console.log('✅ 守卫 CLI 接线：子进程退出码 0/1 正确（run() 返回值 → process.exitCode）')
      pass++
    }
  }
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true })
}
console.log(`\n🎉 test_mutation_json.js 全部通过（${pass} 项）`)
