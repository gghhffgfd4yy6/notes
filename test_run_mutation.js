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
  // review F10：true/false 移出 OPS 后走完整标识符分支，kind 由 'operator' 修正为 'boolean'
  //（此前 'boolean' 分支永远不可达，且 trueCount 一类标识符会被 startsWith 改名）。
  assert.strictEqual(m4[0].kind, 'boolean')

  // ===== generateMutants：布尔标识符边界（review F10） =====
  assert.deepStrictEqual(generateMutants('test.js', 'trueCount = 1'), [], 'trueCount 这类标识符不得被改名为 falseCount')
  assert.deepStrictEqual(generateMutants('test.js', 'falsePositive = 2'), [], 'falsePositive 这类标识符不得被改名')
  const mBool = generateMutants('test.js', 'x = true; y = false')
  assert.strictEqual(mBool.length, 2, '独立 true/false 字面量仍应各生成一个变异')
  assert.ok(mBool.every(m => m.kind === 'boolean'), '布尔字面量的 kind 应为 boolean')

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

  // ===== generateMutants：正则字面量（review F2） =====
  // 正则字面量此前完全未被建模：正则体内的引号/反引号会劫持词法状态。xbk_sendNotify_slim.js:1366 的
  // /`([^`]+)`/g 使状态机进入永不闭合的模板串，令该文件尾部 86 个变异点被静默丢弃（含 sendNotify
  // 推送结果统计这类高风险逻辑）；正则体内的 < > 还会生成伪变异（(?<![0-9]) → (?<=[0-9]) 语义反转）。
  assert.strictEqual(generateMutants('test.js', "const s = x.replace(/`([^`]+)`/g, '$1')").length, 0,
    '反引号正则体内不应生成变异')
  const mAfterRegex = generateMutants('test.js', 'const s = x.replace(/`([^`]+)`/g, `y`)\nconst t = a === b')
  assert.strictEqual(mAfterRegex.length, 1, '反引号正则之后的代码区变异点不得被静默丢弃')
  assert.strictEqual(mAfterRegex[0].original, '===')
  assert.strictEqual(mAfterRegex[0].line, 2, '变异点应定位到正则之后的第 2 行')
  assert.strictEqual(generateMutants('test.js', "x.replace(/</g, 'a').replace(/>/g, 'b')").length, 0,
    '正则体内的 < > 不得生成变异')
  assert.strictEqual(generateMutants('test.js', 'const r = /(?<![0-9])\\*([^*\\n]+?)(?<![0-9])\\*/g').length, 0,
    '正则体内的 (?<! 不得被变异为 (?<=（语义反转）')
  // 除号不得被误判为正则起始（否则会吞掉同行后续代码区的变异点）
  const mDiv = generateMutants('test.js', 'const z = a / b === c / d')
  assert.strictEqual(mDiv.length, 1, '除号不得被误判为正则：=== 必须仍被生成')
  assert.strictEqual(mDiv[0].original, '===')
  const mIncr = generateMutants('test.js', 'i++ / b === c / d')
  assert.strictEqual(mIncr.length, 1, '自增后的 / 是除号，不得吞掉同行的 ===')
  // 扫描状态错乱（未闭合引号/模板串）必须响亮失败并给出文件与行号，不得静默丢弃尾部变异点
  assert.throws(() => generateMutants('test.js', 'const a = 1\nconst s = `abc'), /第 2 行有未闭合的/,
    '未闭合模板串应响亮失败（含文件与行号）')

  // ===== generateMutants：模板串 ${} 内是代码（review F2） =====
  // 模板文本要跳过，但 ${...} 内是代码；且模板可嵌套（xbk_app.js:1442 的 `${x ? `${a}/${b}` : 'n/a'}`），
  // 内层反引号不得把词法状态带偏。
  assert.strictEqual(generateMutants('test.js', 'const s = `a < b`').length, 0, '模板文本中的运算符不应生成变异')
  const mSubst = generateMutants('test.js', 'const s = `v=${a === b}`')
  assert.strictEqual(mSubst.length, 1, '${} 内的 === 应生成变异')
  assert.strictEqual(mSubst[0].original, '===')
  const mNested = generateMutants('test.js', "const t = `x${a ? `y${b === c}` : ''}z`")
  assert.strictEqual(mNested.length, 1, '嵌套模板内的 === 应生成变异（内层反引号不得让状态失配）')
  assert.strictEqual(mNested[0].original, '===')
  assert.strictEqual(generateMutants('test.js', 'const o = `v=${({ a: 1 }).a && b}`').length, 1,
    '${} 内对象字面量的花括号应配平，&& 应生成变异')
  const mAfterTemplate = generateMutants('test.js', 'const s = `v=${a}`\nconst t = x === y')
  assert.strictEqual(mAfterTemplate.length, 1, '模板串之后的代码区变异点不得丢失')
  assert.strictEqual(mAfterTemplate[0].line, 2, '应定位到模板之后的第 2 行')

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
