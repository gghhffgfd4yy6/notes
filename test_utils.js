'use strict'

// 补 xbk_utils.js 覆盖率：9 个纯函数分支（日期解析/CSS转义/safeErrorText/filterHash）
const assert = require('node:assert')
const { createUtils } = require('./xbk_utils')

// safeRe 简单实现：测试中不涉及用户输入正则，直接用原生 RegExp 即可
const safeRe = (src, flags) => new RegExp(src, flags)
const Utils = createUtils({ safeRe })

// ===== parseTime：日期解析分支 =====
// 行 176：解析失败返回 null
assert.strictEqual(Utils.parseTime('not-a-date-at-all'), null, '无效日期应返回 null')

// 行 191-199：_parseSlashDate 显式分支（YYYY/MM/DD 按 UTC 解析，回读校验拒绝非法日期）
// 注意：此格式被 _parseSlashDate 拦截，不会走到 _parseFallback 的补 Z 分支（#32 修正口径）
const slashDate = Utils.parseTime('2026/09/08')
assert.ok(slashDate !== null && slashDate > 0, 'YYYY/MM/DD 应解析为有效时间戳')
assert.strictEqual(new Date(slashDate).getUTCFullYear(), 2026, '年份应为 2026')
assert.strictEqual(new Date(slashDate).getUTCMonth(), 8, '月份应为 9 月(0-indexed=8)')
assert.strictEqual(new Date(slashDate).getUTCDate(), 8, '日期应为 8 号')

// 行 164-178：_parseDateTimeNoTz 显式分支（空格分隔无时区按 UTC 解析）
// 注意：此格式被 _parseDateTimeNoTz 拦截，不会走到 _parseFallback 的补 Z 分支（#32 修正口径）
const spaceDate = Utils.parseTime('2026-09-08 10:30:00')
assert.ok(spaceDate !== null && spaceDate > 0, '空格分隔日期应解析为有效时间戳')
assert.strictEqual(new Date(spaceDate).getUTCHours(), 10, 'UTC 小时应为 10')
assert.strictEqual(new Date(spaceDate).getUTCMinutes(), 30, 'UTC 分钟应为 30')

// #32 修复：真正触达 _parseFallback 补 Z 分支的用例
// 注意：_parseFallback 第225行（YYYY/MM/DD 补 Z）是死代码——_parseSlashDate 已完全拦截该格式
// （匹配则返回时间戳，非法则返回 null 导致 parseTime 提前返回），永远不会走到 _parseFallback。
// _parseFallback 第227行（ISO/空格无时区补 Z）：需绕过 _parseDateTimeNoTz——用超过3位毫秒的格式
// （如 2026-09-08T10:30:00.123456），_parseDateTimeNoTz 的毫秒正则 \d{1,3} 不匹配，走到 _parseFallback。
const fallbackIso = Utils.parseTime('2026-09-08T10:30:00.123456')
assert.ok(fallbackIso !== null && fallbackIso > 0, '超长毫秒 ISO 日期应走 _parseFallback 补 Z 分支')
assert.strictEqual(new Date(fallbackIso).getUTCFullYear(), 2026, '_parseFallback 补 Z 后年份应为 2026')
assert.strictEqual(new Date(fallbackIso).getUTCHours(), 10, '_parseFallback 补 Z 后 UTC 小时应为 10')

// ===== sanitizeDecodedHtml：CSS 转义分支 =====
// #33 修复：从仅 typeof==='string'（不崩即过）升级为具体返回值断言
// 输入 '\\r'（反斜杠+r，非回车符）：sanitizeDecodedHtml 不做 CSS 转义，原样返回
const cssIdent = Utils.sanitizeDecodedHtml('\\r')
assert.strictEqual(cssIdent, '\\r', '\\r（反斜杠+r）应原样返回（非 CSS 转义上下文）')
assert.ok(typeof cssIdent === 'string', '返回值应为字符串')

// 输入 'abc\\\ndef'（反斜杠+换行）：原样返回（sanitizeDecodedHtml 不处理 CSS 行延续）
const cssLineCont = Utils.sanitizeDecodedHtml('abc\\\ndef')
assert.strictEqual(cssLineCont, 'abc\\\ndef', '\\\n（反斜杠+换行）应原样返回')
assert.ok(typeof cssLineCont === 'string', '返回值应为字符串')

// 额外行为断言：主动标签应被移除（验证 sanitizeDecodedHtml 真正执行了清洗逻辑，而非恒等桩）
const scriptInput = 'before<script>alert(1)</script>after'
const scriptOutput = Utils.sanitizeDecodedHtml(scriptInput)
assert.ok(!scriptOutput.includes('alert(1)'), 'script 标签内容应被移除')
assert.ok(scriptOutput.includes('before') && scriptOutput.includes('after'), '前后文本应保留')

// ===== safeErrorText：错误文本提取分支 =====
// 行 697：error 有 code 属性（无 message）→ 返回 code
const errWithCode = Utils.safeErrorText({ code: 'ENOENT' })
assert.strictEqual(errWithCode, 'ENOENT', '有 code 无 message 应返回 code')

// 行 699：error 既无 message 也无 code → 返回 fallback
const errEmpty = Utils.safeErrorText({}, 'fallback-value')
assert.strictEqual(errEmpty, 'fallback-value', '无 message 无 code 应返回 fallback')

// 默认 fallback 为空字符串
const errEmptyDefault = Utils.safeErrorText({})
assert.strictEqual(errEmptyDefault, '', '默认 fallback 应为空字符串')

// ===== filterHash：pingbitime 配置解析分支 =====
// 行 915：pingbitime 含 ### → timeActive=true（多行天数规则）
const hashWithMulti = Utils.filterHash({ pingbitime: 'cat###5' }, '')
assert.ok(typeof hashWithMulti === 'string' && hashWithMulti.length > 0, '含 ### 的 pingbitime 应生成非空哈希')

// 行 922-923：pingbitime 非有效数字 → 清空（pb=''）
const hashInvalid = Utils.filterHash({ pingbitime: 'abc' }, '')
assert.ok(typeof hashInvalid === 'string', '无效 pingbitime 应返回字符串')

// 有效数字 pingbitime 应正常归一化
const hashValid = Utils.filterHash({ pingbitime: '5' }, '')
assert.ok(typeof hashValid === 'string' && hashValid.length > 0, '有效数字应返回非空哈希')
assert.notStrictEqual(hashValid, hashInvalid, '有效数字与无效数字的哈希应不同')

console.log('test_utils OK')
