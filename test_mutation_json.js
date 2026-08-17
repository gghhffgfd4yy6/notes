'use strict'

// 回归测试：mutation-json 超大文件解析（v3.264）
// stryker command runner 把整段测试输出写进每个变异体的 statusReason，单文件可达 500MB+，
// 超过 V8 字符串上限（0x1fffffe8）——readReportJson 按字节剥离 statusReason 后再解析。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readReportJson } = require('./scripts/mutation-json.js')

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-json-test-'))

function parseJson (json) {
  const file = path.join(tmpdir, 'case.json')
  // eslint-disable-next-line
  // nosemgrep: 测试临时文件路径由代码生成，非外部输入
  fs.writeFileSync(file, json)
  return readReportJson(file)
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
  // 损坏 JSON：报错应包含文件路径与尺寸上下文（便于定位，而非 V8 晦涩异常）
  assert.throws(() => parseJson('{"a":1'), err => String(err.message).includes('case.json'), '损坏 JSON 报错应包含文件路径')
  console.log('✅ 解析失败报错包含文件路径与尺寸上下文')
  pass++
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true })
}
console.log(`\n🎉 test_mutation_json.js 全部通过（${pass} 项）`)
