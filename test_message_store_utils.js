'use strict'

// xbk_message_store.js 纯函数方法测试（提升变异分数）
// 覆盖：getFilePath（路径安全/清洗/截断）+ getFileName（URL 提取/清洗/后缀）
const assert = require('node:assert')
const path = require('node:path')
const { createMessageStore } = require('./xbk_message_store')

const mockUtils = {
  anonKey: (s) => 'anon' + String(s).length,
  safeObjectCopy: (o) => JSON.parse(JSON.stringify(o)),
  getMessageIdentity: () => ({ valid: false }),
  isValidItem: () => true,
  num: () => 10000,
  addIndex: () => {}
}

const store = createMessageStore({
  Config: { cache: { maxSize: 10000 } },
  Utils: mockUtils,
  fs: {
    existsSync: () => true,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (p) => p
  },
  path,
  crypto: { randomUUID: () => 'uuid' },
  normalize: () => {},
  storage: {},
  constants: {}
})

let pass = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}

console.log('=== xbk_message_store.js 纯函数方法测试 ===')

// ===== getFilePath =====
check('getFilePath: 正常文件名返回缓存目录下路径', () => {
  const r = store.getFilePath('test.json')
  assert.ok(r.endsWith(path.sep + 'test.json'), '应返回缓存目录下的 test.json')
})

check('getFilePath: 路径穿越被阻止（只取 basename）', () => {
  const r = store.getFilePath('../../etc/passwd')
  assert.ok(!r.includes('..'), '路径穿越应被阻止')
  assert.ok(r.endsWith(path.sep + 'passwd'), '应只取 basename')
})

check('getFilePath: 绝对路径被阻止（只取 basename）', () => {
  const r = store.getFilePath('/etc/passwd')
  assert.ok(r.endsWith(path.sep + 'passwd'), '绝对路径应只取 basename')
})

check('getFilePath: 非法文件名字符被清洗', () => {
  const r = store.getFilePath('a:b*c?d"e<f>g|h.json')
  assert.ok(!/[:*?"<>|]/.test(path.basename(r)), '非法字符应被清洗')
})

check('getFilePath: NUL 字符被清洗', () => {
  const r = store.getFilePath('test\u0000.json')
  assert.ok(!r.includes('\u0000'), 'NUL 字符应被清洗')
})

check('getFilePath: 空文件名回退 default.json', () => {
  const r = store.getFilePath('')
  assert.ok(r.endsWith(path.sep + 'default.json'), '空文件名应回退 default.json')
})

check('getFilePath: undefined 回退 default.json', () => {
  const r = store.getFilePath(undefined)
  assert.ok(r.endsWith(path.sep + 'default.json'), 'undefined 应回退 default.json')
})

check('getFilePath: null 回退 default.json', () => {
  const r = store.getFilePath(null)
  assert.ok(r.endsWith(path.sep + 'default.json'), 'null 应回退 default.json')
})

check('getFilePath: [object Object] 回退 default.json', () => {
  const r = store.getFilePath('[object Object]')
  assert.ok(r.endsWith(path.sep + 'default.json'), '[object Object] 应回退 default.json')
})

check('getFilePath: . 回退 default.json', () => {
  const r = store.getFilePath('.')
  assert.ok(r.endsWith(path.sep + 'default.json'), '. 应回退 default.json')
})

check('getFilePath: .. 回退 default.json', () => {
  const r = store.getFilePath('..')
  assert.ok(r.endsWith(path.sep + 'default.json'), '.. 应回退 default.json')
})

check('getFilePath: 超长文件名截断到 200 字节', () => {
  const longName = 'a'.repeat(300) + '.json'
  const r = store.getFilePath(longName)
  const basename = path.basename(r)
  assert.ok(Buffer.byteLength(basename, 'utf8') <= 200, '文件名应截断到 200 字节以内')
})

check('getFilePath: 超长文件名保留扩展名', () => {
  const longName = 'a'.repeat(300) + '.json'
  const r = store.getFilePath(longName)
  assert.ok(r.endsWith('.json'), '超长文件名应保留 .json 扩展名')
})

check('getFilePath: 数字文件名正常处理', () => {
  const r = store.getFilePath(123)
  assert.ok(r.endsWith(path.sep + '123'), '数字文件名应 String 化')
})

// ===== getFileName =====
check('getFileName: 正常 URL 提取文件名', () => {
  const r = store.getFileName('https://example.com/path/to/data.json')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: URL 带查询参数', () => {
  const r = store.getFileName('https://example.com/data.json?foo=bar')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: URL 带 hash', () => {
  const r = store.getFileName('https://example.com/data.json#section')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: 空 URL 回退 default.json', () => {
  const r = store.getFileName('')
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 无扩展名自动加 .json', () => {
  const r = store.getFileName('https://example.com/data')
  assert.strictEqual(r, 'data.json')
})

check('getFileName: 非法文件名字符替换为下划线', () => {
  const r = store.getFileName('https://example.com/a:b*c?.json')
  assert.ok(!/[:*?]/.test(r), '非法字符应替换为下划线')
})

check('getFileName: 末段为空回退 default', () => {
  const r = store.getFileName('https://example.com/path/')
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 末段为纯点串回退 default', () => {
  const r = store.getFileName('https://example.com/..')
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 非字符串 URL 回退 default.json', () => {
  const r = store.getFileName(undefined)
  assert.strictEqual(r, 'default.json')
})

check('getFileName: null URL 回退 default.json', () => {
  const r = store.getFileName(null)
  assert.strictEqual(r, 'default.json')
})

check('getFileName: 数字 URL 生成 bad_ 前缀文件名', () => {
  const r = store.getFileName(123)
  assert.ok(r.startsWith('bad_'), '数字 URL 应生成 bad_ 前缀文件名')
  assert.ok(r.endsWith('.json'), '应以 .json 结尾')
})

check('getFileName: 控制字符被过滤', () => {
  const r = store.getFileName('https://example.com/a\u0001b.json')
  assert.ok(!/[\u0000-\u001f]/.test(r), '控制字符应被过滤')
})

check('getFileName: 末段全为控制字符回退 default', () => {
  const r = store.getFileName('https://example.com/\u0001\u0002\u0003')
  assert.strictEqual(r, 'default.json', '末段全为控制字符应回退 default')
})

console.log(`\n🎉 test_message_store_utils.js 全部通过（${pass} 项）`)
