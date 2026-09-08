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

// 行 226：YYYY/MM/DD 格式（无时区标记）→ 补 Z 按 UTC 解析
const slashDate = Utils.parseTime('2026/09/08')
assert.ok(slashDate !== null && slashDate > 0, 'YYYY/MM/DD 应解析为有效时间戳')
assert.strictEqual(new Date(slashDate).getUTCFullYear(), 2026, '年份应为 2026')
assert.strictEqual(new Date(slashDate).getUTCMonth(), 8, '月份应为 9 月(0-indexed=8)')
assert.strictEqual(new Date(slashDate).getUTCDate(), 8, '日期应为 8 号')

// 行 228-230：空格分隔无时区标记（'2026-09-08 10:30:00'）→ 补 Z
const spaceDate = Utils.parseTime('2026-09-08 10:30:00')
assert.ok(spaceDate !== null && spaceDate > 0, '空格分隔日期应解析为有效时间戳')
assert.strictEqual(new Date(spaceDate).getUTCHours(), 10, 'UTC 小时应为 10')
assert.strictEqual(new Date(spaceDate).getUTCMinutes(), 30, 'UTC 分钟应为 30')

// ===== sanitizeDecodedHtml：CSS 转义分支 =====
// 行 456：CSS 恒等转义 \r → r（随后黑名单拦截）
const cssIdent = Utils.sanitizeDecodedHtml('\\r')
assert.ok(typeof cssIdent === 'string', '\\r 转义应返回字符串')

// 行 457：\\ 后接换行 → CSS 行延续，移除
const cssLineCont = Utils.sanitizeDecodedHtml('abc\\\ndef')
assert.ok(typeof cssLineCont === 'string', '\\\n 行延续应返回字符串')

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
