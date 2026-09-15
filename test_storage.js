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

  // 目录路径打开后 fstat 非文件 → unsafe
  const r5 = readSafeTextResult(dirPath)
  assert.strictEqual(r5.status, 'unsafe', '目录路径应返回 unsafe（fstat 非文件）')

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

  // 清理：临时目录递归删除即可覆盖所有测试文件
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}

  console.log('test_storage OK')
})().catch((e) => { console.error(e); process.exit(1) })
