'use strict'
/* codacy-disable-file: 测试 sandbox — tmpdir 由 fs.mkdtempSync 创建，
   Codacy 对"动态路径 + fs.writeFileSync" pattern 误报；本文件不参与
   生产 I/O，无路径遍历风险。 */

// 回归测试：mutation-json 超大文件解析（v3.264）
// stryker command runner 把整段测试输出写进每个变异体的 statusReason，单文件可达 500MB+，
// 超过 V8 字符串上限（0x1fffffe8）——readReportJson 按字节剥离 statusReason 后再解析。
const assert = require('node:assert')
const fs = require('node:fs')
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
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true })
}
console.log(`\n🎉 test_mutation_json.js 全部通过（${pass} 项）`)
