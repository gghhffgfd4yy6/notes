'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  isRegularOrMissing,
  writeAtomic,
  writeAtomicIfAbsent,
  readSafeText,
  readSafeTextResult
} = require('./xbk_storage')

;(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-storage-'))
  const make = (rel) => path.join(tmp, rel)

  // ===== isRegularOrMissing =====
  assert.strictEqual(isRegularOrMissing(123), false, '非字符串应返回 false')
  assert.strictEqual(isRegularOrMissing(null), false, 'null 应返回 false')
  assert.strictEqual(isRegularOrMissing(undefined), false, 'undefined 应返回 false')
  assert.strictEqual(isRegularOrMissing(make('not-exist')), true, '不存在的文件应返回 true')

  const regularFile = make('regular.txt')
  fs.writeFileSync(regularFile, 'hello')
  assert.strictEqual(isRegularOrMissing(regularFile), true, '普通文件应返回 true')

  const dirPath = make('subdir')
  fs.mkdirSync(dirPath)
  assert.strictEqual(isRegularOrMissing(dirPath), false, '目录应返回 false（非普通文件）')

  // ===== writeAtomic =====
  const w1 = make('atomic1.txt')
  assert.strictEqual(writeAtomic(w1, 'content-1'), true, '正常写入应返回 true')
  assert.strictEqual(fs.readFileSync(w1, 'utf8'), 'content-1', '写入内容应正确')
  // 覆盖已有文件
  assert.strictEqual(writeAtomic(w1, 'content-2'), true, '覆盖写入应返回 true')
  assert.strictEqual(fs.readFileSync(w1, 'utf8'), 'content-2', '覆盖后内容应更新')
  // 写入到目录路径应失败
  assert.strictEqual(writeAtomic(dirPath, 'x'), false, '写入目录路径应返回 false')
  // 写入到父目录不存在的嵌套路径应自动创建
  const nested = make('deep/nested/file.txt')
  assert.strictEqual(writeAtomic(nested, 'nested-ok'), true, '嵌套路径应自动创建父目录')
  assert.strictEqual(fs.readFileSync(nested, 'utf8'), 'nested-ok')

  // ===== STG-06：新建父目录必须显式 0o700，不得随 umask（022 下旧行为 0755）=====
  // 旧实现 mkdirSync(dir, { recursive: true }) 不传 mode，目录权限由 umask 决定，与本模块
  // 文件的 0o600 口径不一致。断言两路：① 传给 mkdirSync 的 mode 必须显式 0o700（本机 umask=077
  // 会让「实际权限」断言在修前也成立，只有参数断言能证伪）；② 新建目录的实际权限位为 0700。
  const mkdirCalls = []
  const origMkdirSync = fs.mkdirSync
  fs.mkdirSync = (target, options) => { mkdirCalls.push({ target, options }); return origMkdirSync.call(fs, target, options) }
  let permRet
  try { permRet = writeAtomic(make('perm/a/b/c.txt'), 'perm') } finally { fs.mkdirSync = origMkdirSync }
  assert.strictEqual(permRet, true, '新目录下的写入应成功')
  assert.ok(mkdirCalls.length > 0, '父目录不存在时必须调用 mkdirSync')
  assert.ok(mkdirCalls.every((c) => c.options && c.options.mode === 0o700),
    `mkdirSync 必须显式传 mode 0o700（旧实现不传；实际：${JSON.stringify(mkdirCalls.map((c) => c.options))}）`)
  assert.strictEqual(fs.statSync(make('perm/a')).mode & 0o777, 0o700, '新建目录实际权限应为 0700')
  assert.strictEqual(fs.statSync(make('perm/a/b')).mode & 0o777, 0o700, '递归新建的每一级目录都应为 0700')
  // 已存在目录不得被 chmod（不改动部署侧既有权限）：预先建一个 0755 目录，再写入其下文件
  const preexisting = make('preexist')
  fs.mkdirSync(preexisting, { recursive: true, mode: 0o755 })
  // NOSONAR（S2612 误报）：mkdir 的 mode 会被 umask 裁掉（本机 077 → 0700、CI 022 → 0755），
  // 要拿到确定的 0755 夹具只能显式 chmod。该目录位于 mkdtempSync 建的私有临时目录内，0755
  // 不含组/其他用户写位；且它正是下一行「既有目录权限不得被改动」断言的分母——改成 0700 会让
  // 断言失去区分度（被测实现 chmod 成 0700 时无法证伪）。权限本身安全，故就地抑制。
  fs.chmodSync(preexisting, 0o755) // NOSONAR
  const beforeMode = fs.statSync(preexisting).mode & 0o777
  assert.strictEqual(writeAtomic(make('preexist/f.txt'), 'x'), true, '已存在目录下的写入应成功')
  assert.strictEqual(fs.statSync(preexisting).mode & 0o777, beforeMode, '已存在的目录不得被 chmod')

  // ===== STG-03：空串路径必须显式拒绝（旧实现判为「ENOENT=缺失=安全」）=====
  // 本机实测：lstatSync('') 抛 ENOENT，旧实现因此返回 true；空 filePath 会让 writeAtomic 在
  // 进程 CWD 先落一个含 payload 的唯一临时文件（随后 renameSync(tmp,'') 才失败）。
  assert.strictEqual(isRegularOrMissing(''), false, '空串路径应返回 false（非法路径，不是「缺失=安全」）')

  // 观察窗：捕获告警/错误输出，并记录底层写动作——「拒绝写入」必须一次写都不发起。
  const watchWrites = (fn) => {
    const warns = []
    const errors = []
    const writes = []
    const origWarn = console.warn
    const origError = console.error
    const origWrite = fs.writeFileSync
    const origRename = fs.renameSync
    console.warn = (...args) => { warns.push(args.join(' ')) }
    console.error = (...args) => { errors.push(args.join(' ')) }
    fs.writeFileSync = (...args) => { writes.push(args[0]); return origWrite.apply(fs, args) }
    fs.renameSync = (...args) => { writes.push(args[1]); return origRename.apply(fs, args) }
    let ret
    try { ret = fn() } finally {
      console.warn = origWarn
      console.error = origError
      fs.writeFileSync = origWrite
      fs.renameSync = origRename
    }
    return { ret, warns, errors, writes }
  }

  const emptyAtomic = watchWrites(() => writeAtomic('', 'payload'))
  assert.strictEqual(emptyAtomic.ret, false, 'writeAtomic(\'\') 应返回 false')
  assert.ok(emptyAtomic.warns.some((w) => w.includes('为空串')), 'writeAtomic(\'\') 应告警空串路径')
  assert.ok(emptyAtomic.errors.some((e) => e.includes('拒绝写入非普通文件')), 'writeAtomic(\'\') 应按「拒绝写入」报错（而非走到写入失败）')
  assert.deepStrictEqual(emptyAtomic.writes, [], 'writeAtomic(\'\') 拒绝时不得发起任何写/重命名')

  const emptyAbsent = watchWrites(() => writeAtomicIfAbsent('', 'payload'))
  assert.strictEqual(emptyAbsent.ret, false, 'writeAtomicIfAbsent(\'\') 应返回 false')
  assert.ok(emptyAbsent.warns.some((w) => w.includes('为空串')), 'writeAtomicIfAbsent(\'\') 应告警空串路径')
  assert.ok(emptyAbsent.errors.some((e) => e.includes('拒绝写入非普通文件')), 'writeAtomicIfAbsent(\'\') 应按「拒绝写入」报错')
  assert.deepStrictEqual(emptyAbsent.writes, [], 'writeAtomicIfAbsent(\'\') 拒绝时不得发起任何写')

  // ===== writeAtomicIfAbsent =====
  const a1 = make('absent1.txt')
  assert.strictEqual(writeAtomicIfAbsent(a1, 'first'), true, '文件不存在时应写入并返回 true')
  assert.strictEqual(fs.readFileSync(a1, 'utf8'), 'first')
  // 已存在：不覆盖，返回 true
  assert.strictEqual(writeAtomicIfAbsent(a1, 'second'), true, '文件已存在时应返回 true（不覆盖）')
  assert.strictEqual(fs.readFileSync(a1, 'utf8'), 'first', '已存在文件内容不应被覆盖')
  // 写入目录路径应失败
  assert.strictEqual(writeAtomicIfAbsent(dirPath, 'x'), false, '写入目录路径应返回 false')

  // ===== STG-02：写失败必须清理本次调用创建的半写残骸 =====
  // 旧实现 wx 直写真实路径，写中途失败（ENOSPC 等）把半写文件留在缓存路径；消费侧
  // xbk_message_store._ensureFileExists 以 existsSync 早退，坏文件被当成「已初始化」→ 永久不自愈。
  const partial = make('partial.txt')
  const origWriteFileSync = fs.writeFileSync
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target !== 'number') return origWriteFileSync(target, ...rest)
    origWriteFileSync(target, 'half') // 模拟「已写入半份内容，随后设备写满」
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  }
  let partialRet
  try { partialRet = writeAtomicIfAbsent(partial, 'full-payload') } finally { fs.writeFileSync = origWriteFileSync }
  assert.strictEqual(partialRet, false, '写失败应返回 false')
  assert.strictEqual(fs.existsSync(partial), false, '写失败后不得留下半写残骸（否则 existsSync 早退使缓存永久不自愈）')

  // 反向对照：EEXIST（另一进程已创建）不得被「清理残骸」误删——那是别人的有效缓存
  const keep = make('keep.txt')
  fs.writeFileSync(keep, 'first')
  assert.strictEqual(writeAtomicIfAbsent(keep, 'second'), true, '已存在文件应返回 true（EEXIST 视为初始化成功）')
  assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'first', 'EEXIST 时不得清理/覆盖已存在的有效文件')

  // ===== STG-04：原子写必须在 rename 前 fsync 临时文件，并对父目录 fsync =====
  // 旧实现直接 writeFileSync(tmp)+renameSync：rename 的原子性只对进程崩溃成立，掉电时目录项与
  // 内容都可能丢失。修后顺序固定为 fsync(内容) → rename → fsync(父目录)。
  const order = []
  const origFsync = fs.fsyncSync
  const origRename2 = fs.renameSync
  fs.fsyncSync = (target) => { order.push(order.length === 0 ? 'fsync-file' : 'fsync'); return origFsync.call(fs, target) }
  fs.renameSync = (a, b) => { order.push('rename'); return origRename2.call(fs, a, b) }
  let durableOk
  try { durableOk = writeAtomic(make('durable.txt'), 'durable') } finally { fs.fsyncSync = origFsync; fs.renameSync = origRename2 }
  assert.strictEqual(durableOk, true, '补 fsync 后正常写入仍应成功')
  assert.ok(order.includes('fsync-file'), 'writeAtomic 必须在 rename 前 fsync 临时文件（否则掉电可丢内容）')
  assert.ok(order.indexOf('fsync-file') < order.indexOf('rename'), '文件 fsync 必须发生在 rename 之前（提交点唯一）')
  assert.ok(order.lastIndexOf('fsync') > order.indexOf('rename'), 'rename 之后必须 fsync 父目录（否则掉电可丢目录项）')
  assert.strictEqual(fs.readFileSync(make('durable.txt'), 'utf8'), 'durable', 'fsync 之后内容仍应是本次写入的')

  // writeAtomicIfAbsent 走同一口径（无 rename 提交点，但内容同样要先落盘）
  const order2 = []
  fs.fsyncSync = (target) => { order2.push('fsync'); return origFsync.call(fs, target) }
  let absentOk
  try { absentOk = writeAtomicIfAbsent(make('durable2.txt'), 'durable2') } finally { fs.fsyncSync = origFsync }
  assert.strictEqual(absentOk, true, '独占初始化写也应成功')
  assert.ok(order2.includes('fsync'), 'writeAtomicIfAbsent 必须 fsync 后才视为初始化成功')

  // 文件 fsync 失败必须 fail-closed：删 tmp、返回 false，不得留下「已提交」的假象
  const origFsync3 = fs.fsyncSync
  fs.fsyncSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
  const leftover = fs.readdirSync(tmp).filter((f) => f.startsWith('durable3.txt'))
  let fsyncFailRet
  try { fsyncFailRet = writeAtomic(make('durable3.txt'), 'nope') } finally { fs.fsyncSync = origFsync3 }
  assert.strictEqual(fsyncFailRet, false, 'fsync 失败时不得报成功')
  assert.strictEqual(fs.existsSync(make('durable3.txt')), false, 'fsync 失败时目标文件不得出现（未提交）')
  assert.deepStrictEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('durable3.txt')), leftover, 'fsync 失败时不得残留 .tmp')

  // ===== readSafeTextResult =====
  // 不存在 → missing
  const r1 = readSafeTextResult(make('missing.txt'))
  assert.strictEqual(r1.status, 'missing', '不存在文件应返回 missing')
  assert.strictEqual(r1.text, null)

  // 符号链接 → unsafe（ELOOP）
  const linkTarget = make('link-target.txt')
  fs.writeFileSync(linkTarget, 'linked')
  const symlink = make('symlink.txt')
  try { fs.symlinkSync(linkTarget, symlink) } catch (e) { /* 某些环境不支持 symlink */ }
  if (fs.lstatSync(symlink, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const r2 = readSafeTextResult(symlink)
    assert.strictEqual(r2.status, 'unsafe', '符号链接应返回 unsafe')
    assert.strictEqual(r2.text, null)
  }

  // 正常文件 → ok
  const okFile = make('ok.txt')
  fs.writeFileSync(okFile, 'safe-content')
  const r3 = readSafeTextResult(okFile)
  assert.strictEqual(r3.status, 'ok', '普通文件应返回 ok')
  assert.strictEqual(r3.text, 'safe-content')
  assert.strictEqual(r3.error, null)

  // 文件过大 → tooLarge
  const bigFile = make('big.txt')
  fs.writeFileSync(bigFile, 'x'.repeat(100))
  const r4 = readSafeTextResult(bigFile, 50)
  assert.strictEqual(r4.status, 'tooLarge', '超过 maxBytes 应返回 tooLarge')
  assert.strictEqual(r4.text, null)
  // maxBytes 非正数或未设置时不限制
  const r4b = readSafeTextResult(bigFile, 0)
  assert.strictEqual(r4b.status, 'ok', 'maxBytes=0 应不限制大小')

  // ===== STG-01：上限必须约束真正的读取（fstat 与内容读取同一 fd、同一字节区间）=====
  // 旧实现：fstat(fd) 只用来看 size，内容却按路径 readFileSync(filePath) 整读——检查值与实际
  // 读到的字节数之间没有任何约束，同一 inode 就地 append 即可在窗口内绕过 maxBytes（把整份
  // 膨胀文件读进内存）。修后按 fd 有界读取，返回内容不可能超过 fstat 观测到的字节数。
  const grown = make('grown.txt')
  fs.writeFileSync(grown, 'y'.repeat(100))
  const origFstat = fs.fstatSync
  const fakeStat = (s) => ({ isFile: () => s.isFile(), size: 50, dev: s.dev, ino: s.ino })
  fs.fstatSync = (target) => fakeStat(origFstat.call(fs, target))
  let raced
  try { raced = readSafeTextResult(grown, 50) } finally { fs.fstatSync = origFstat }
  assert.strictEqual(raced.status, 'ok', 'size 观测值未超上限时应判 ok（growth 发生在检查之后）')
  assert.strictEqual(raced.text.length, 50, '读取长度必须受 fstat 观测值约束（旧实现按路径整读，返回 100 字节）')
  assert.strictEqual(raced.text, 'y'.repeat(50), '有界读取应返回文件前缀而非截断后的其它内容')

  // 目录路径打开后 fstat 非文件 → unsafe
  const r5 = readSafeTextResult(dirPath)
  assert.strictEqual(r5.status, 'unsafe', '目录路径应返回 unsafe（fstat 非文件）')

  // ===== SS-03：options.tail 超限时读尾部而不是判 tooLarge =====
  // 追加式日志可超过上限（写入侧 fail-open），消费方只关心最近记录；旧行为一律 tooLarge，
  // 整个部件在 --status 里变成「不可读」。
  const tailFile = make('tail.txt')
  fs.writeFileSync(tailFile, 'A'.repeat(400) + 'B'.repeat(100)) // 共 500 字节，尾部为 100 个 B
  const tailMiss = readSafeTextResult(tailFile, 50)
  assert.strictEqual(tailMiss.status, 'tooLarge', '默认（不传 tail）超限仍必须判 tooLarge，行为不得回归')
  const tailHit = readSafeTextResult(tailFile, 100, { tail: true })
  assert.strictEqual(tailHit.status, 'ok', 'tail=true 时超限应读尾部而不是 tooLarge（修前为 tooLarge）')
  assert.strictEqual(tailHit.text, 'B'.repeat(100), 'tail=true 应返回最后 maxBytes 字节')
  assert.strictEqual(tailHit.truncated, true, '尾部读取必须标记 truncated，调用方才知道首行可能是半行')
  const tailWhole = readSafeTextResult(tailFile, 1024, { tail: true })
  assert.strictEqual(tailWhole.text.length, 500, '未超限时 tail 选项不得改变结果（仍返回全文）')
  assert.strictEqual(tailWhole.truncated, undefined, '未发生截断时不得标记 truncated')
  assert.strictEqual(readSafeText(tailFile, 100, { tail: true }), 'B'.repeat(100), 'readSafeText 也必须透传 options')

  // ===== readSafeText（包装）=====
  assert.strictEqual(readSafeText(okFile), 'safe-content', 'ok 时应返回文本')
  assert.strictEqual(readSafeText(make('missing2.txt')), null, 'missing 时应返回 null')
  assert.strictEqual(readSafeText(dirPath), null, 'unsafe 时应返回 null')

  // ===== STG-05：readSafeText 必须把 maxBytes 透传给 readSafeTextResult =====
  // 旧实现 readSafeText(filePath) 恒不传第 2 参 → 上限被静默忽略，超限文件仍整读入内存。
  assert.strictEqual(readSafeText(bigFile, 50), null, 'readSafeText 带 maxBytes 时超限应返回 null（tooLarge 按 null 处理）')
  assert.strictEqual(readSafeText(bigFile, 99), null, 'maxBytes 差 1 字节仍应判超限（比 stat.size 小即 tooLarge）')
  // 正向对照：带 maxBytes 且未超限仍须返回全文，否则上面的 null 无法区分 tooLarge 与「带参读取整体坏掉」
  assert.strictEqual(readSafeText(okFile, 1024), 'safe-content', '未超限时带 maxBytes 应正常返回文本')
  // 不传 / 传非正数 maxBytes 时保持旧行为「不设上限」，不得引入默认上限
  assert.strictEqual(readSafeText(bigFile), 'x'.repeat(100), '不传 maxBytes 时应无上限，返回全文')
  assert.strictEqual(readSafeText(bigFile, 0), 'x'.repeat(100), 'maxBytes=0 应视为不设限，返回全文')

  // ===== STG-05（续）：非法 maxBytes 必须告警，不得静默按「不设限」读取 =====
  // 旧实现：`typeof maxBytes === 'number' && maxBytes > 0` 为假即静默不设限——调用方传 '50'
  // （字符串）或 -1 时，限长意图被悄悄变成整读入内存，没有任何信号。
  const badWarns = []
  const origWarn = console.warn
  console.warn = (...args) => { badWarns.push(args.join(' ')) }
  let badRet
  try { badRet = readSafeTextResult(bigFile, '50') } finally { console.warn = origWarn }
  assert.strictEqual(badRet.status, 'ok', '非法 maxBytes 沿用「不设限」语义（读取结果不变）')
  assert.strictEqual(badRet.text, 'x'.repeat(100), '非法 maxBytes 仍返回全文')
  assert.strictEqual(badWarns.length, 1, '非法 maxBytes 必须告警一次（旧实现完全静默）')
  assert.match(badWarns[0], /maxBytes 非法/, '告警需指明 maxBytes 非法')
  assert.match(badWarns[0], /按不设限读取/, '告警需说明实际按不设限处理')

  // 对照：0 / -1 / Number.NaN / Infinity 同样告警（「非正数」不是合法上限，只是历史语义）
  // （Sonar 建议：全局 NaN 改 Number.NaN；两者同为 IEEE-754 NaN，`String(bad)` 仍为 'NaN'，行为等价）
  for (const bad of [0, -1, Number.NaN, Infinity]) {
    const seen = []
    console.warn = (...args) => { seen.push(args.join(' ')) }
    try { readSafeTextResult(bigFile, bad) } finally { console.warn = origWarn }
    assert.strictEqual(seen.length, 1, `maxBytes=${String(bad)} 应告警一次`)
  }
  // 反向对照：合法上限与不传（undefined）都不得告警，否则告警会变成噪声
  const okWarns = []
  console.warn = (...args) => { okWarns.push(args.join(' ')) }
  try { readSafeTextResult(bigFile, 50); readSafeTextResult(okFile) } finally { console.warn = origWarn }
  assert.deepStrictEqual(okWarns, [], '合法 maxBytes / 不传 maxBytes 时不得告警')

  // 清理：临时目录递归删除即可覆盖所有测试文件
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}

  console.log('test_storage OK')
})().catch((e) => { console.error(e); process.exit(1) })
