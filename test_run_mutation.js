'use strict'

const assert = require('assert')
const { generateMutants, extractTestSummary, collectMutants } = require('./run_mutation')

;(async () => {
  // ===== generateMutants：比较运算符 =====
  const m1 = generateMutants('test.js', 'a === b')
  assert.strictEqual(m1.length, 1, '=== 应生成 1 个变异')
  assert.strictEqual(m1[0].original, '===')
  assert.strictEqual(m1[0].replacement, '!==')
  assert.strictEqual(m1[0].kind, 'operator')
  assert.strictEqual(m1[0].file, 'test.js')
  assert.strictEqual(m1[0].line, 1)
  assert.strictEqual(m1[0].column, 2)

  // < 应生成 2 个变异（<=, >）
  const m2 = generateMutants('test.js', 'a < b')
  assert.strictEqual(m2.length, 2, '< 应生成 2 个变异')
  assert.deepStrictEqual(m2.map(m => m.replacement).sort((a, b) => a.localeCompare(b)), ['<=', '>'])

  // 逻辑运算符
  const m3 = generateMutants('test.js', 'a && b')
  assert.strictEqual(m3.length, 1, '&& 应生成 1 个变异')
  assert.strictEqual(m3[0].replacement, '||')

  // 布尔字面量（标识符形式）
  const m4 = generateMutants('test.js', 'flag = true')
  assert.strictEqual(m4.length, 1, 'true 应生成 1 个变异')
  assert.strictEqual(m4[0].original, 'true')
  assert.strictEqual(m4[0].replacement, 'false')
  assert.strictEqual(m4[0].kind, 'operator')

  // ===== generateMutants：跳过注释 =====
  assert.strictEqual(generateMutants('test.js', '// a === b').length, 0, '行注释中运算符不应生成变异')
  assert.strictEqual(generateMutants('test.js', '/* a === b */').length, 0, '块注释中运算符不应生成变异')
  assert.strictEqual(generateMutants('test.js', 'x = 1 /* a && b */ + 2').length, 0, '行内块注释中运算符不应生成变异')

  // ===== generateMutants：跳过字符串 =====
  assert.strictEqual(generateMutants('test.js', "const s = 'a === b'").length, 0, '单引号字符串中运算符不应生成变异')
  assert.strictEqual(generateMutants('test.js', 'const s = "a && b"').length, 0, '双引号字符串中运算符不应生成变异')
  assert.strictEqual(generateMutants('test.js', 'const s = `a < b`').length, 0, '模板字符串中运算符不应生成变异')

  // 字符串转义不提前结束
  assert.strictEqual(generateMutants('test.js', "const s = 'a \\' === b'").length, 0, '含转义引号的字符串中运算符不应生成变异')

  // ===== generateMutants：代码+注释混合，只在代码区生成 =====
  const m5 = generateMutants('test.js', 'a === b // comment === c')
  assert.strictEqual(m5.length, 1, '代码区运算符应生成变异，注释区应跳过')
  assert.strictEqual(m5[0].start, 2)

  // ===== generateMutants：多行定位 =====
  const m6 = generateMutants('test.js', 'let x = 1\nlet y = true\n')
  assert.strictEqual(m6.length, 1, '多行源码中 true 应生成变异')
  assert.strictEqual(m6[0].line, 2, '应定位到第 2 行')
  assert.strictEqual(m6[0].column, 8, '应定位到正确列')

  // ===== generateMutants：空源码 =====
  assert.deepStrictEqual(generateMutants('test.js', ''), [], '空源码应返回空数组')

  // ===== extractTestSummary：全部通过格式 =====
  assert.deepStrictEqual(extractTestSummary('全部通过！3/5'), ['3', '5'], '全部通过！N/M 应提取两个数字')
  assert.deepStrictEqual(extractTestSummary('全部通过！0/0'), ['0', '0'], '0/0 应正确提取')
  assert.deepStrictEqual(extractTestSummary('全部通过！123/456'), ['123', '456'], '多位数应正确提取')

  // ===== extractTestSummary：三数字格式 =====
  assert.deepStrictEqual(extractTestSummary('2 通过, 1 失败, 共 3'), ['2', '1', '3'], 'K 通过, M 失败, 共 N 应提取三个数字')
  assert.deepStrictEqual(extractTestSummary('结果：10 通过, 5 失败, 共 15'), ['10', '5', '15'], '带前缀文本应正确提取')

  // ===== extractTestSummary：从末行向上匹配 =====
  const noisy = '噪声日志 全部通过！1/1\n中间行\n真实结果 全部通过！3/5'
  assert.deepStrictEqual(extractTestSummary(noisy), ['3', '5'], '应从末行向上匹配，噪声日志不影响')

  // 三数字格式也从末行匹配
  const noisy2 = '检查通过：0\n1 通过, 0 失败, 共 1'
  assert.deepStrictEqual(extractTestSummary(noisy2), ['1', '0', '1'], '三数字格式应从末行匹配，前置「检查通过」不抢答')

  // ===== extractTestSummary：无匹配 =====
  assert.deepStrictEqual(extractTestSummary(''), [], '空输出应返回空数组')
  assert.deepStrictEqual(extractTestSummary('没有任何汇总信息'), [], '无匹配应返回空数组')
  assert.deepStrictEqual(extractTestSummary('全部通过！'), [], '只有前缀无数字应返回空数组')

  // ===== collectMutants：多文件合并 + id 连续 =====
  const cm1 = collectMutants(['xbk_utils.js'])
  assert.ok(Array.isArray(cm1), '应返回数组')
  assert.ok(cm1.length > 0, 'xbk_utils.js 应生成变异体')
  assert.strictEqual(cm1[0].id, 1, '首个变异体 id 应为 1')
  assert.strictEqual(cm1[cm1.length - 1].id, cm1.length, 'id 应连续递增')
  // 所有变异体的 file 字段应为 xbk_utils.js
  assert.ok(cm1.every(m => m.file === 'xbk_utils.js'), '所有变异体 file 字段应正确')

  // 多文件合并：id 跨文件连续
  const cm2 = collectMutants(['xbk_utils.js', 'xbk_agents.js'])
  assert.ok(cm2.length > cm1.length, '多文件应生成更多变异体')
  assert.strictEqual(cm2[0].id, 1, '首个 id 应为 1')
  assert.strictEqual(cm2[cm2.length - 1].id, cm2.length, '末尾 id 应等于总数')
  // 前半部分是 xbk_utils.js，后半部分是 xbk_agents.js
  const utilsCount = cm2.filter(m => m.file === 'xbk_utils.js').length
  assert.strictEqual(utilsCount, cm1.length, 'xbk_utils.js 变异体数量应与单文件一致')

  // 空文件列表
  assert.deepStrictEqual(collectMutants([]), [], '空文件列表应返回空数组')

  // 不存在的文件 → 抛错
  assert.throws(() => collectMutants(['nonexistent_file_xyz.js']), /ENOENT|no such file/, '不存在的文件应抛错')

  console.log('test_run_mutation OK')
})().catch((e) => { console.error(e); process.exit(1) })
