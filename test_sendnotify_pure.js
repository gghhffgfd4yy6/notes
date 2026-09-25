'use strict'

/* eslint camelcase: off */ // 模块导出的配置对象字面量就叫 push_config（改名会与生产同名导出脱钩）

// xbk_sendNotify_slim.js 纯函数方法测试（提升变异分数）
// 覆盖：maskKey/maskUrl/safeSlice/safeErr/mdLinksToPlain/mdImagesToPlain/mdToPlain/looksHtml/stripAngleTags
const assert = require('node:assert')
const fs = require('node:fs')
const { maskKey, maskUrl, safeSlice, safeErr, mdLinksToPlain, mdImagesToPlain, mdToPlain, looksHtml, stripAngleTags, push_config, configuredChannelCount, hasWxPusherConfigured } = require('./xbk_sendNotify_slim')
// 判定器同源（S1/F1/P1）与截断单一实现（S6/F7）回归的对拍对象
const { looksLikeHtmlEnvelope } = require('./xbk_pusher')
const { createUtils } = require('./xbk_utils')
const Utils = createUtils({ safeRe: (source, flags) => new RegExp(source, flags) })

let pass = 0
let fail = 0
function check (name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1 }
}
// 计时取多次最小值：屏蔽单次 GC/调度抖动，只服务于「不得退化」的量级断言（阈值极宽松）
function bestMs (fn, runs = 3) {
  let best = Infinity
  for (let k = 0; k < runs; k++) {
    const t0 = process.hrtime.bigint()
    fn()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (ms < best) best = ms
  }
  return best
}

// ============================================================
// 比值型墙钟判据的沙箱缩放（PERF_MS）—— 与 CI「并发假杀」同一条判定链
// 判定链：Stryker 的 command runner 只看**退出码**（command-test-runner.js：exitCode===0 → Survived，
// 否则 Killed），而 coverageAnalysis:'off' 下 incremental-differ 拿不到覆盖信息时直接 `return true`
// （复用全部旧结果）⇒ 本套件在并发负载下被**任何一条**墙钟断言打成红，都会让与变异体无关的变异
// 被判 Killed 并被长期冻结。故墙钟判据必须在沙箱里按 PERF_MS 缩放（mutation.yml step env、
// scripts/mutation-child.js:13、run_mutation.js:393 三处都设 PERF_MS=3000）。
//
// 口径（test_filter.js:66-79 同一份逻辑的本地副本，为何不抽公共模块见下）：
//   生效阈值 = 默认阈值 × PERF_SCALE，PERF_SCALE = (PERF_MS / 500) × PERF_SANDBOX_HEADROOM(2)
//   · 未设 PERF_MS 或设 500 ⇒ PERF_SCALE 恰为 1 ⇒ **默认口径逐字节不变**；设 <500 时按比例收紧。
//   · 只缩放**比值型**判据：分母 tBenign 在并发沙箱里会塌到 1–2ms，噪声被比值直接放大。实测（CI，
//     4 vCPU、--concurrency 8）良性 1.53–1.85ms / 畸形 17.60–24.84ms ⇒ 比值 10.4–13.3×，越过默认
//     10× 口径；而同样这两条在本机空载只有 2.4–2.6×（见下方回归用例的实测口径）。
//   · **绝对上界（500/1000ms）故意不缩放**：分母噪声不影响它，它才是沙箱里拦「灾难性回溯」的硬牙。
//     沙箱内合法耗时 17–25ms（160KB 那条实测），距 500ms 有 ~20× 余量；而真实退化（去掉共享配平
//     预算、去掉角括号预算守卫）是 1.5–2.3s。若按 PERF_SCALE=12 把它放大到 6000/12000ms，秒级退化
//     会被直接放过 —— 断言在沙箱里形同虚设。test_filter.js 必须缩放绝对阈值，是因为它的合法沙箱
//     耗时（tuisong 1903ms）本身就**超过**默认阈值；本例不存在这一前提，故不缩放。
//   · 沙箱内比值断言退化为「只拦数量级退化」，这是既有口径已写明的语义代价；常规运行（test.yml 的
//     npm test，不带 PERF_MS）阈值未变，仍按 10×/25× 严格判定。秒级退化的保证由**不缩放的绝对上界**
//     与**确定性断言**（预算耗尽即短路，与计时无关）双重承担，回归用例① ② ③ 锁定。
//   · **为何是本地副本而非抽公共模块**：口径源头 test_filter.js 属本改动冻结清单（不得改动），抽模块
//     必然要动它；且新增根目录文件会撞 test_suite_registry.js（根目录每个 test_*.js 必须注册进
//     SUITES，非 test_ 前缀的公共模块又要另立放行口子），与「一次提交只做一件事」冲突。故按
//     test_filter.js:66-79 原样复制，两侧注释互相点明来源。
const PERF_BASE_MS = 500
const PERF_SANDBOX_HEADROOM = 2
function perfScaleFor (perfMs) {
  const v = Number(perfMs)
  const ratio = Number.isFinite(v) && v > 0 ? v / PERF_BASE_MS : 1
  return ratio > 1 ? ratio * PERF_SANDBOX_HEADROOM : ratio
}
const PERF_SCALE = perfScaleFor(process.env.PERF_MS)
// 比值型判据的生效上界：默认式（maxRatio × tBenign + floorMs）整式 × PERF_SCALE。
// floorMs 是同文件 25× 那两条已用的 +50ms 噪声地板；10× 那两条为 0 ⇒ 默认口径恰为
// 「maxRatio × tBenign」，与改动前逐字节等价（perfScaleFor(500)=perfScaleFor(undefined)=1）。
function ratioBudgetWith (maxRatio, tBenign, floorMs, perfMs) {
  return (maxRatio * tBenign + floorMs) * perfScaleFor(perfMs)
}
function ratioBudget (maxRatio, tBenign, floorMs) {
  return ratioBudgetWith(maxRatio, tBenign, floorMs, process.env.PERF_MS)
}

console.log('=== xbk_sendNotify_slim.js 纯函数方法测试 ===')

// ===== maskKey =====
check('maskKey: 短字符串(<=6)返回 ***', () => {
  assert.strictEqual(maskKey('abc'), '***')
})
check('maskKey: 6字符返回 ***', () => {
  assert.strictEqual(maskKey('123456'), '***')
})
check('maskKey: 长字符串前4位+***+后2位', () => {
  assert.strictEqual(maskKey('abcdefgh'), 'abcd***gh')
})
check('maskKey: 空串返回 ***', () => {
  assert.strictEqual(maskKey(''), '***')
})
check('maskKey: undefined 返回 ***', () => {
  assert.strictEqual(maskKey(undefined), '***')
})
check('maskKey: null 返回 ***', () => {
  assert.strictEqual(maskKey(null), '***')
})
check('maskKey: 数字转字符串', () => {
  assert.strictEqual(maskKey(12345678), '1234***78')
})

// ===== maskUrl =====
check('maskUrl: http URL 保留 host 脱敏路径', () => {
  const r = maskUrl('http://example.com/path/to/key123456')
  assert.ok(r.startsWith('http://example.com/'), '应保留 host')
  assert.ok(r.includes('***'), '路径应脱敏')
})
check('maskUrl: https URL 保留 host 脱敏路径', () => {
  const r = maskUrl('https://example.com/deviceKey123456')
  assert.ok(r.startsWith('https://example.com/'), '应保留 host')
})
check('maskUrl: URL 无路径只保留 host', () => {
  assert.strictEqual(maskUrl('https://example.com'), 'https://example.com')
})
check('maskUrl: 非 http URL 用 maskKey', () => {
  const r = maskUrl('ftp://example.com/key123456')
  assert.ok(r.includes('***'), '非 http URL 应用 maskKey')
})
check('maskUrl: 无效 URL 用 maskKey', () => {
  const r = maskUrl('not-a-url')
  assert.ok(r.includes('***'), '无效 URL 应用 maskKey')
})
check('maskUrl: 空串返回 ***', () => {
  assert.strictEqual(maskUrl(''), '***')
})

// ===== safeSlice =====
check('safeSlice: 短字符串不截断', () => {
  assert.strictEqual(safeSlice('hello', 10), 'hello')
})
check('safeSlice: 长字符串截断到 max', () => {
  assert.strictEqual(safeSlice('hello world', 5), 'hello')
})
check('safeSlice: max=0 返回空串', () => {
  assert.strictEqual(safeSlice('hello', 0), '')
})
check('safeSlice: 空串返回空串', () => {
  assert.strictEqual(safeSlice('', 5), '')
})
check('safeSlice: undefined 返回空串', () => {
  assert.strictEqual(safeSlice(undefined, 5), '')
})
check('safeSlice: null 返回空串', () => {
  assert.strictEqual(safeSlice(null, 5), '')
})
check('safeSlice: emoji 不切断代理对', () => {
  const s = 'a😀b'
  const r = safeSlice(s, 2)
  assert.ok(r.length <= 2, '截断后长度应 <= 2')
  assert.ok(!r.includes('\uD83D') || r.includes('\uDE00'), '不应残留孤立高代理')
})
check('safeSlice: 截断点后是修饰符则退位', () => {
  const s = 'ab\u0301c' // b + 组合重音
  const r = safeSlice(s, 2)
  assert.strictEqual(r, 'a', '截断点后是修饰符应退位去掉b')
})
check('safeSlice: 修饰符退位到空', () => {
  const s = 'a\u0301b' // a + 组合重音
  const r = safeSlice(s, 1)
  assert.strictEqual(r, '', 'a后是修饰符，退位后为空')
})
check('safeSlice: 与主代码 Utils.truncateUtf16 全等（S6/F7 收敛回归，max>0）', () => {
  const corpus = [
    'hello', 'hello world', 'a\u{1F600}b', 'ab\u0301c', 'a\u0301b', '\u2764\uFE0F',
    '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', '\u{1F1E8}\u{1F1F3}',
    'AB\u{1F44D}\u{1F3FD}x', 'a\u200Db'
  ]
  for (const s of corpus) {
    for (let max = 1; max <= s.length + 2; max++) {
      assert.strictEqual(safeSlice(s, max), Utils.truncateUtf16(s, max), `max=${max} ${JSON.stringify(s)}`)
    }
  }
  // v3.185 补充平面修饰符（肤色）：整组退位，而不是只丢修饰符（旧本地实现返回 'AB👍' 裸基底）
  assert.strictEqual(safeSlice('AB\u{1F44D}\u{1F3FD}x', 4), 'AB', '不留下裸基底 emoji')
  assert.strictEqual(safeSlice('AB\u{1F44D}\u{1F3FD}x', 6), 'AB\u{1F44D}\u{1F3FD}')
})

// ===== safeErr =====
check('safeErr: null 返回空串', () => {
  assert.strictEqual(safeErr(null), '')
})
check('safeErr: undefined 返回空串', () => {
  assert.strictEqual(safeErr(undefined), '')
})
check('safeErr: 字符串原样返回(短)', () => {
  assert.strictEqual(safeErr('error message'), 'error message')
})
check('safeErr: 超长字符串截断到 200 字符加省略号', () => {
  const long = 'a'.repeat(300)
  const r = safeErr(long)
  assert.strictEqual(r.length, 201, '应截断到 200 + 省略号')
  assert.ok(r.endsWith('…'), '应以省略号结尾')
})
check('safeErr: Error 对象返回 message', () => {
  const r = safeErr(new Error('test error'))
  assert.strictEqual(r, 'test error')
})
check('safeErr: 有 message 的对象返回 message', () => {
  const r = safeErr({ message: 'obj error' })
  assert.strictEqual(r, 'obj error')
})

// ===== mdLinksToPlain =====
check('mdLinksToPlain: 正常链接转 text (url)', () => {
  assert.strictEqual(mdLinksToPlain('[Google](https://google.com)'), 'Google (https://google.com)')
})
check('mdLinksToPlain: text===url 只显示一次', () => {
  assert.strictEqual(mdLinksToPlain('[https://google.com](https://google.com)'), 'https://google.com')
})
check('mdLinksToPlain: 无链接原样返回', () => {
  assert.strictEqual(mdLinksToPlain('plain text'), 'plain text')
})
check('mdLinksToPlain: 未闭合 ] 原样返回', () => {
  assert.strictEqual(mdLinksToPlain('[Google(https://google.com)'), '[Google(https://google.com)')
})
check('mdLinksToPlain: 空 url 原样保留', () => {
  assert.strictEqual(mdLinksToPlain('[Google]()'), '[Google]()')
})
check('mdLinksToPlain: 空 text 跳过', () => {
  assert.strictEqual(mdLinksToPlain('[](https://google.com)'), '[](https://google.com)')
})
check('mdLinksToPlain: 多个链接', () => {
  const r = mdLinksToPlain('[a](http://a.com) and [b](http://b.com)')
  assert.ok(r.includes('a (http://a.com)'), '应包含第一个链接')
  assert.ok(r.includes('b (http://b.com)'), '应包含第二个链接')
})
// v3.273（F6）：目标段闭合点按 Markdown 合法形态解析——'(' 后首字符 '<' 取 '>)'，否则 '(' ')' 配平扫描
check('mdLinksToPlain: URL 内含 ")" 且 text===url 去重后完整保留（配平到最外层 ")"）', () => {
  assert.strictEqual(
    mdLinksToPlain('[https://x/a(b)c.jpg](https://x/a(b)c.jpg)'),
    'https://x/a(b)c.jpg',
    '若回退为首个 ")" 截断，会残留 " (https://x/a(b)c.jpg)" 重复串'
  )
})
check('mdLinksToPlain: URL 内含 ")" 且 <...> 包裹 + text===url 去重后完整保留', () => {
  assert.strictEqual(
    mdLinksToPlain('[<https://x/a(b)c.jpg>](<https://x/a(b)c.jpg>)'),
    '<https://x/a(b)c.jpg>',
    '角括号形态同样要走配平扫描，不能把 URL 内的 ")" 当闭合点'
  )
})
check('mdLinksToPlain: 简单形态不回归（配平扫描不改变基本输出）', () => {
  assert.strictEqual(mdLinksToPlain('[Google](https://google.com)'), 'Google (https://google.com)')
  assert.strictEqual(mdLinksToPlain('[t](https://x/a(b)c.jpg)'), 't (https://x/a(b)c.jpg)')
  assert.strictEqual(mdLinksToPlain('[t](<https://x/y.jpg>)'), 't (<https://x/y.jpg>)')
})
// v3.274（qodo #147-7）：destination 里被反斜杠转义的括号是字面量，不参与 '('/')' 配平；
// 否则 '[a](foo\() [b](bar))' 的第一个 destination 会一路吞掉后一条链接。
check('mdLinksToPlain: 反斜杠转义的括号不参与配平，后一条链接仍被转换（qodo #147-7）', () => {
  assert.strictEqual(
    mdLinksToPlain('[a](foo\\() [b](bar))'),
    'a (foo\\() b (bar))',
    '若转义的 "(" 参与配平，后一条 [b](bar) 会被吞进前一条 destination'
  )
})
// 既有口径：配平失败（destination 含未配平 "("）只放弃这一处构造、回落「首个 )」，不整段 bail；
// 若整段 bail，其后本应正常剥离的链接会原样残留。
check('mdLinksToPlain: 配平失败回落首个 ")"，且不整段 bail 吞掉后续链接', () => {
  assert.strictEqual(mdLinksToPlain('[t](https://x/a(b.jpg)'), 't (https://x/a(b.jpg)')
  assert.strictEqual(mdLinksToPlain('[a](x(y) [b](bar)'), 'a (x(y) b (bar)', '整段 bail 会让后一条链接原样残留')
})
// v3.274（qodo #147-8）：配平扫描带「整次转换共享」的预算，畸形构造（未配平 "(" 后仍跟 ")"）不退化 O(n²)——
// 无预算时每个这类构造都一路扫到串尾，N 个构造呈 O(n²)；预算耗尽即回落「首个 )」，整体保持线性。
// 断言同时给绝对上界与「同规模良性输入（线性基线）」的相对上界，后者不随机器快慢漂移。
check('mdLinksToPlain: 畸形构造不退化 O(n²)——配平扫描共享预算（qodo #147-8）', () => {
  const malformed = (kb) => '[a](x() '.repeat(Math.floor(kb * 1024 / 8))
  const benign = (kb) => '[a](https://e.com/p) '.repeat(Math.floor(kb * 1024 / 20))
  bestMs(() => mdLinksToPlain(malformed(2))) // 预热，排除首次 JIT 编译
  bestMs(() => mdLinksToPlain(benign(2)))
  const tMal = bestMs(() => mdLinksToPlain(malformed(64)))
  const tBenign = bestMs(() => mdLinksToPlain(benign(64)))
  // 绝对上界：故意不随 PERF_MS 缩放（沙箱里拦灾难性回溯的硬牙，理由见顶部 PERF_MS 段）
  assert.ok(tMal < 1000, `64KB 畸形输入应在 1000ms 内完成，实测 ${tMal.toFixed(1)}ms（无预算实现约 1.5-2.3s）`)
  // 比值型上界：随 PERF_MS 缩放（默认口径 = 25 × tBenign + 50ms，逐字节不变）
  assert.ok(
    tMal <= ratioBudget(25, tBenign, 50),
    `畸形输入耗时不应相对同规模良性输入爆炸（默认 25 倍 + 50ms，本进程生效上界 ${ratioBudget(25, tBenign, 50).toFixed(1)}ms），实测良性=${tBenign.toFixed(2)}ms 畸形=${tMal.toFixed(2)}ms（无预算实现约 1600-1800 倍）`
  )
})
// CodeRabbit PR #147：findDestEnd 的角括号分支必须先扣扫描预算——否则「有 '<' 但整串没有 '>'」的畸形构造
// 每轮都会让 indexOf('>') 从该处一路扫到串尾（预算形同虚设），多个叠起来仍是 O(n²)。
// 下面两类断言都直接针对「删掉 findDestEnd 顶部 `if (budget.left <= 0) return -1`」这一回退：
//   · 确定性断言（不依赖机器快慢、不依赖计时）：预算被前序畸形构造耗尽后，角括号形态必须在预算耗尽处
//     短路返回 -1、由调用方回落「首个 )」；回退守卫后它仍会执行 indexOf('>') 直接闭合，
//     在 `[<u)v>](<u)v>)` 这类「destination 内含 ')' 的 <...> 形态」上产出文本不同（前者去重成 `<u)v>`）。
//   · 计时断言（宽松）：畸形输入相对同规模良性输入不得爆炸；回退守卫后实测约 37-44 倍（阈值 10 倍）。
check('mdLinksToPlain: 预算耗尽后角括号分支必须短路 + 畸形输入不退化（CodeRabbit #147）', () => {
  // 前 6 段 `[a](() ` 每段净多一个 '('，配平扫描一路扫到尾：预算在到达末条链接前已被耗尽。
  const exhausted = '[a](() '.repeat(6) + '[<u)v>](<u)v>)'
  assert.strictEqual(
    mdLinksToPlain(exhausted),
    'a (() '.repeat(6) + '<u)v> (<u)v>)',
    '预算耗尽后 <...> 形态也必须回落「首个 )」；若角括号分支先于预算检查执行，末条会得到去重后的 `<u)v>`'
  )
  // 「有 '<' 但整串无 '>'」的畸形构造：'[a](<x) ' 每段都以 '<' 开头、串中无任何 '>'，
  // 末尾的 ')' 让外层 while 继续推进（否则首轮就 bail，退化不成立）。
  const malformed = '[a](<x) '.repeat(20000)
  assert.ok(!malformed.includes('>'), '用例前提：整串不得含 ">"')
  const benign = '[a](https://e.com/p) '.repeat(8000) // 与畸形输入同为 160KB 量级
  bestMs(() => mdLinksToPlain(malformed.slice(0, 2000))) // 预热，排除首次 JIT 编译
  bestMs(() => mdLinksToPlain(benign.slice(0, 2000)))
  const tMal = bestMs(() => mdLinksToPlain(malformed), 5)
  const tBenign = bestMs(() => mdLinksToPlain(benign), 5)
  // 绝对上界：故意不随 PERF_MS 缩放（沙箱里拦灾难性回溯的硬牙，理由见顶部 PERF_MS 段）
  assert.ok(tMal < 500, `160KB 畸形输入应在 500ms 内完成，实测 ${tMal.toFixed(1)}ms`)
  // 比值型上界：随 PERF_MS 缩放 —— CI 假 Killed 的正是这一条（默认 10× 在沙箱里被噪声放大）
  assert.ok(
    tMal <= ratioBudget(10, tBenign, 0),
    `畸形输入不得相对同规模良性输入爆炸（默认 10 倍，本进程生效上界 ${ratioBudget(10, tBenign, 0).toFixed(1)}ms）：实测良性=${tBenign.toFixed(2)}ms 畸形=${tMal.toFixed(2)}ms（回退角括号预算守卫约 37-44 倍）`
  )
})

// ===== mdImagesToPlain =====
check('mdImagesToPlain: 正常图片转 alt', () => {
  assert.strictEqual(mdImagesToPlain('![logo](https://example.com/logo.png)'), 'logo')
})
check('mdImagesToPlain: 空 alt 用 emptyAlt', () => {
  assert.strictEqual(mdImagesToPlain('![](https://example.com/logo.png)', '(图片)'), '(图片)')
})
check('mdImagesToPlain: 空 alt 默认空串', () => {
  assert.strictEqual(mdImagesToPlain('![](https://example.com/logo.png)'), '')
})
check('mdImagesToPlain: 无图片原样返回', () => {
  assert.strictEqual(mdImagesToPlain('plain text'), 'plain text')
})
check('mdImagesToPlain: 未闭合 ] 原样返回', () => {
  assert.strictEqual(mdImagesToPlain('![logo(https://example.com/logo.png)'), '![logo(https://example.com/logo.png)')
})
check('mdImagesToPlain: 空 url 原样保留', () => {
  assert.strictEqual(mdImagesToPlain('![logo]()'), '![logo]()')
})
// v3.273（F6）：mdImagesToPlain 与 mdLinksToPlain 同口径（'<url>' / 配平扫描），URL 内含 ")" 不再残留 '.jpg)'
check('mdImagesToPlain: URL 内含 ")" 时整图剥成 alt，不残留 ".jpg)"', () => {
  assert.strictEqual(
    mdImagesToPlain('![t](https://x/a(b)c.jpg)'),
    't',
    '若回退为首个 ")" 截断，会得到 "tc.jpg)" 垃圾串'
  )
})
check('mdImagesToPlain: 空 alt + URL 内含 ")" 用 emptyAlt，不残留 ".jpg)"', () => {
  assert.strictEqual(
    mdImagesToPlain('![](https://x/a(b)c.jpg)', '(图片)'),
    '(图片)',
    '若回退为首个 ")" 截断，会得到 "(图片)c.jpg)"'
  )
})
check('mdImagesToPlain: <...> 包裹 + URL 内含 ")" 正确闭合', () => {
  assert.strictEqual(
    mdImagesToPlain('![t](<https://x/a(b)c.jpg>)'),
    't',
    '若回退为首个 ")" 截断，会残留 "c.jpg>)"'
  )
})
check('mdImagesToPlain: URL 嵌套括号配平到最外层 ")"', () => {
  assert.strictEqual(mdImagesToPlain('![t](https://x/a(b(c)d)e.jpg)'), 't')
})
check('mdImagesToPlain: 首图 URL 带 ")" 不吞掉后续图片', () => {
  assert.strictEqual(mdImagesToPlain('![a](https://x/a(b).jpg) ![b](https://y/d.png)'), 'a b')
})
check('mdImagesToPlain: 简单形态与 <...> 无括号形态不回归', () => {
  assert.strictEqual(mdImagesToPlain('![logo](https://example.com/logo.png)'), 'logo')
  assert.strictEqual(mdImagesToPlain('![t](<https://x/y.jpg>)'), 't')
})
// v3.274（qodo #147-7）：mdImagesToPlain 与 mdLinksToPlain 共用 findDestEnd，转义括号同样不参与配平；
// 若参与配平，第一张图的 destination 会一直配平到串尾的 ")"，把后一张 ![b](bar) 整个吞掉（只剩 "a"）。
check('mdImagesToPlain: 反斜杠转义的括号不参与配平，后一张图片仍被剥离（qodo #147-7）', () => {
  assert.strictEqual(
    mdImagesToPlain('![a](foo\\() ![b](bar))'),
    'a b)',
    '若转义的 "(" 参与配平，后一张 ![b](bar) 会被吞进第一张图的 destination'
  )
})
// v3.274（qodo #147-8）：mdImagesToPlain 的共享预算独立初始化，畸形图片构造同样不退化 O(n²)。
check('mdImagesToPlain: 畸形构造不退化 O(n²)——配平扫描共享预算（qodo #147-8）', () => {
  const malformed = (kb) => '![a](x() '.repeat(Math.floor(kb * 1024 / 9))
  const benign = (kb) => '![a](https://e.com/p.png) '.repeat(Math.floor(kb * 1024 / 26))
  bestMs(() => mdImagesToPlain(malformed(2)))
  bestMs(() => mdImagesToPlain(benign(2)))
  const tMal = bestMs(() => mdImagesToPlain(malformed(64)))
  const tBenign = bestMs(() => mdImagesToPlain(benign(64)))
  // 绝对上界：故意不随 PERF_MS 缩放（沙箱里拦灾难性回溯的硬牙，理由见顶部 PERF_MS 段）
  assert.ok(tMal < 1000, `64KB 畸形输入应在 1000ms 内完成，实测 ${tMal.toFixed(1)}ms（无预算实现约 1.5-1.8s）`)
  // 比值型上界：随 PERF_MS 缩放（默认口径 = 25 × tBenign + 50ms，逐字节不变）
  assert.ok(
    tMal <= ratioBudget(25, tBenign, 50),
    `畸形输入耗时不应相对同规模良性输入爆炸（默认 25 倍 + 50ms，本进程生效上界 ${ratioBudget(25, tBenign, 50).toFixed(1)}ms），实测良性=${tBenign.toFixed(2)}ms 畸形=${tMal.toFixed(2)}ms（无预算实现约 1600 倍）`
  )
})
// CodeRabbit PR #147：mdImagesToPlain 复用同一个 findDestEnd，角括号分支的预算守卫同样必须生效——
// 两个循环各自独立初始化 destBudget，因此需要各自的覆盖（本用例与上面链接版同构，只是把 '[' 换成 '!['）。
check('mdImagesToPlain: 预算耗尽后角括号分支必须短路 + 畸形输入不退化（CodeRabbit #147）', () => {
  const exhausted = '![a](() '.repeat(6) + '![<u)v>](<u)v>)'
  assert.strictEqual(
    mdImagesToPlain(exhausted),
    'a '.repeat(6) + '<u)v>v>)',
    '预算耗尽后 <...> 形态也必须回落「首个 )」；若角括号分支先于预算检查执行，末图只会剩去重后的 `<u)v>`'
  )
  const malformed = '![a](<x) '.repeat(20000) // 每段都以 '<' 开头、整串无 '>'
  assert.ok(!malformed.includes('>'), '用例前提：整串不得含 ">"')
  const benign = '![a](https://e.com/p.png) '.repeat(7000) // 与畸形输入同为 180KB 量级
  bestMs(() => mdImagesToPlain(malformed.slice(0, 2000)))
  bestMs(() => mdImagesToPlain(benign.slice(0, 2000)))
  const tMal = bestMs(() => mdImagesToPlain(malformed), 5)
  const tBenign = bestMs(() => mdImagesToPlain(benign), 5)
  // 绝对上界：故意不随 PERF_MS 缩放（沙箱里拦灾难性回溯的硬牙，理由见顶部 PERF_MS 段）
  assert.ok(tMal < 500, `180KB 畸形输入应在 500ms 内完成，实测 ${tMal.toFixed(1)}ms`)
  // 比值型上界：随 PERF_MS 缩放 —— 与链接版同源的 CI 假 Killed 类
  assert.ok(
    tMal <= ratioBudget(10, tBenign, 0),
    `畸形输入不得相对同规模良性输入爆炸（默认 10 倍，本进程生效上界 ${ratioBudget(10, tBenign, 0).toFixed(1)}ms）：实测良性=${tBenign.toFixed(2)}ms 畸形=${tMal.toFixed(2)}ms（回退角括号预算守卫约 40-44 倍）`
  )
})

// ===== mdToPlain =====
check('mdToPlain: 粗体去除', () => {
  assert.strictEqual(mdToPlain('**bold**'), 'bold')
})
check('mdToPlain: 斜体去除', () => {
  assert.strictEqual(mdToPlain('*italic*'), 'italic')
})
check('mdToPlain: 标题去除 #', () => {
  assert.strictEqual(mdToPlain('# Title'), 'Title')
})
check('mdToPlain: 代码去除反引号', () => {
  assert.strictEqual(mdToPlain('`code`'), 'code')
})
check('mdToPlain: 链接转纯文本', () => {
  assert.strictEqual(mdToPlain('[Google](https://google.com)'), 'Google (https://google.com)')
})
check('mdToPlain: 图片转 alt', () => {
  assert.strictEqual(mdToPlain('![logo](https://example.com/logo.png)'), 'logo')
})
// v3.273（F6）：配平扫描贯穿出口 mdToPlain（图片先剥、链接按配平闭合）
check('mdToPlain: URL 内含 ")" 的图片端到端剥成 alt，无 ".jpg)" 残留', () => {
  assert.strictEqual(mdToPlain('![t](https://x/a(b)c.jpg)'), 't')
})
check('mdToPlain: URL 内含 ")" 的原文链接端到端只保留一次', () => {
  assert.strictEqual(mdToPlain('[https://x/a(b)c.jpg](https://x/a(b)c.jpg)'), 'https://x/a(b)c.jpg')
})
check('mdToPlain: HTML 标签被剥离', () => {
  assert.strictEqual(mdToPlain('<b>bold</b>'), 'bold')
})
check('mdToPlain: <url> autolink 保留内容', () => {
  assert.strictEqual(mdToPlain('<https://example.com>'), 'https://example.com')
})
check('mdToPlain: &nbsp; 解码为空格', () => {
  assert.strictEqual(mdToPlain('a&nbsp;b'), 'a b')
})
check('mdToPlain: &lt; &gt; 解码', () => {
  assert.strictEqual(mdToPlain('a&lt;b&gt;c'), 'a<b>c')
})
check('mdToPlain: stripAngle=false 保留 HTML 标签', () => {
  assert.strictEqual(mdToPlain('<b>bold</b>', false), '<b>bold</b>')
})
check('mdToPlain: 空串返回空串', () => {
  assert.strictEqual(mdToPlain(''), '')
})
check('mdToPlain: undefined 返回空串', () => {
  assert.strictEqual(mdToPlain(undefined), '')
})

// ===== looksHtml =====
check('looksHtml: 含 HTML 标签返回 true', () => {
  assert.strictEqual(looksHtml('<p>hello</p>'), true)
})
check('looksHtml: 纯文本返回 false', () => {
  assert.strictEqual(looksHtml('hello world'), false)
})
check('looksHtml: 空串返回 false', () => {
  assert.strictEqual(looksHtml(''), false)
})
check('looksHtml: 含 <br> 返回 true', () => {
  assert.strictEqual(looksHtml('hello<br>world'), true)
})
check('looksHtml: 含 <a href> 返回 true', () => {
  assert.strictEqual(looksHtml('<a href="http://x.com">link</a>'), true)
})
check('looksHtml: 与出口门槛 looksLikeHtmlEnvelope 同源等价（S1/F1/P1 回归）', () => {
  const corpus = [
    '<tag <2> ', '<img src=x onerror=alert(1) <2>', '<img src="a<b" onerror=alert(1)>',
    '<b>x</b>', '<br/>', '<br />', '<a href="x">y', '<h1\u00A0id="a">hi</h1>', 'hello<br>world',
    '<https://example.com>', '<2>', '<a', '<tag/foo>x>', '<br/ >', '<tag <2> <b>', '',
    'plain text', '```html\n<b>x</b>\n```', '未闭合 `<b', '未闭合反引号 `a'
  ]
  for (const s of corpus) {
    assert.strictEqual(looksHtml(s), looksLikeHtmlEnvelope(s), `渲染侧与出口门槛必须同一实现: ${JSON.stringify(s)}`)
  }
  // 曾发散的两类形态（渲染侧原为 true、出口原为 false → 未清洗即渲染）：宽松包络下必须仍判 HTML
  assert.strictEqual(looksHtml('<tag <2> '), true, '标签名后再跟 < 仍应判 HTML（fail-closed）')
  assert.strictEqual(looksHtml('<img src=x onerror=alert(1) <2>'), true, '无完整 > 的载荷应判 HTML')
  assert.strictEqual(looksHtml('未闭合 `a'), false, '未闭合反引号是纯文本，不误判')
  // 非字符串输入防御（门槛函数直接面对调用方传入值）
  assert.strictEqual(looksHtml(undefined), false, 'undefined 不抛错且非 HTML')
  assert.strictEqual(looksHtml(null), false, 'null 不抛错且非 HTML')
  assert.strictEqual(looksHtml(123), false, '数字不是 HTML')
})

// ===== stripAngleTags =====
check('stripAngleTags: stripAngle=true 剥离 HTML 标签', () => {
  assert.strictEqual(stripAngleTags('<b>bold</b>', true), 'bold')
})
check('stripAngleTags: stripAngle=false 保留标签', () => {
  assert.strictEqual(stripAngleTags('<b>bold</b>', false), '<b>bold</b>')
})
check('stripAngleTags: <url> autolink 保留内容', () => {
  assert.strictEqual(stripAngleTags('<https://example.com>', true), 'https://example.com')
})
check('stripAngleTags: 空标签保留', () => {
  assert.strictEqual(stripAngleTags('a<>b', true), 'a<>b')
})
check('stripAngleTags: 未闭合 < 原样保留', () => {
  assert.strictEqual(stripAngleTags('a<b', true), 'a<b')
})
check('stripAngleTags: 无标签原样返回', () => {
  assert.strictEqual(stripAngleTags('plain text', true), 'plain text')
})

// ===== 比值型墙钟判据的 PERF_MS 缩放回归 =====
// 靶向对象：CI（4 vCPU、--concurrency 8）在 PR #158 新配置下 r5/r6/r7 三轮产生的**残余假 Killed**，
// 原始日志三条：良性/畸形 = 1.85/24.66ms、1.72/24.84ms、1.53/17.60ms（比值 10.4–13.3×）。良性基数
// 只有 1–2ms，噪声主导比值 ⇒ 越过默认 10× ⇒ 套件红 ⇒ command runner 按退出码判 Killed（与本变异体
// 无关的假杀）。本组用例锁定：① 沙箱口径必须放行这类噪声；② 默认口径必须仍拦下同一人造输入（证明
// 断言没被改死，而不是拿放宽阈值换绿）；③ 畸形耗时回到秒级的真实退化在**任何**口径下都必须红；
// ④ 断言点必须真的接到缩放函数上（否则本机实测比值只有 2.4–3.0×，改回裸比值会**静默变绿**）。
// 撤销顶部缩放、或只把断言点改回裸比值 ⇒ 本组用例真红。
check('PERF_MS 缩放 ①: 沙箱口径（PERF_MS=3000 ⇒ 12 倍）放行 CI 实测比值噪声', () => {
  // CI 原始实测三点（变异沙箱口径就是 PERF_MS=3000）
  for (const [tB, tM] of [[1.85, 24.66], [1.72, 24.84], [1.53, 17.60]]) {
    assert.ok(tM <= ratioBudgetWith(10, tB, 0, 3000), `沙箱口径必须放行 CI 实测：良性=${tB}ms 畸形=${tM}ms`)
  }
  // 题面人造输入：良性 1.5ms / 畸形 25ms
  assert.ok(ratioBudgetWith(10, 1.5, 0, 3000) >= 25, '沙箱口径须放行 1.5ms/25ms')
  assert.ok(ratioBudgetWith(10, 1.5, 0, '3000') >= 25, 'PERF_MS 以环境变量字符串传入时同样生效')
  // 倍率必须真是 (3000/500) × 2 = 12，而不是随手写死的常量
  assert.strictEqual(ratioBudgetWith(10, 2, 0, 3000), 240, 'PERF_MS=3000 ⇒ 10 × 2ms 的生效上界应为 240ms（12 倍）')
})
check('PERF_MS 缩放 ②: 默认口径（未设 / =500）仍拦下同一人造输入，且逐字节不变', () => {
  for (const perfMs of [undefined, 500, '500']) {
    assert.ok(!(ratioBudgetWith(10, 1.5, 0, perfMs) >= 25), `默认口径（PERF_MS=${perfMs}）必须拦下 1.5ms/25ms`)
    for (const [tB, tM] of [[1.85, 24.66], [1.72, 24.84], [1.53, 17.60]]) {
      assert.ok(!(tM <= ratioBudgetWith(10, tB, 0, perfMs)), `默认口径必须拦下 ${tB}/${tM}`)
    }
  }
  // 默认口径 = PERF_SCALE 恰为 1 ⇒ 整式与改动前同值（这是「逐字节不变」的可执行证据）
  assert.strictEqual(ratioBudgetWith(10, 2, 0, 500), 20, '默认 10× 口径必须仍恰为 10 × tBenign')
  assert.strictEqual(ratioBudgetWith(25, 2, 50, 500), 100, '默认 25×+50ms 口径必须仍恰为 25 × tBenign + 50')
  assert.strictEqual(ratioBudgetWith(10, 2, 0, undefined), 20, '未设 PERF_MS 时缩放必须恰为 1')
  assert.strictEqual(ratioBudgetWith(25, 2, 50, undefined), 100, '未设 PERF_MS 时 +50ms 噪声地板不变')
  assert.ok(ratioBudgetWith(10, 2, 0, 100) < 20, 'PERF_MS<500 必须按比例收紧（不得借缩放放宽）')
})
check('PERF_MS 缩放 ③: 畸形耗时回到秒级的真实退化在任何口径下都必须红', () => {
  // 真实退化量级（见各断言自带注释）：去掉共享配平预算 ≈1.5–2.3s（64KB）/ 去掉角括号预算守卫 ≈37–44×
  for (const tMal of [1800, 2000, 2300]) {
    for (const perfMs of [undefined, 500, 3000]) {
      assert.ok(!(tMal <= ratioBudgetWith(10, 1.5, 0, perfMs)), `10× 比值判据必须拦下 ${tMal}ms 退化（PERF_MS=${perfMs}）`)
      assert.ok(!(tMal <= ratioBudgetWith(25, 1.5, 50, perfMs)), `25× 比值判据必须拦下 ${tMal}ms 退化（PERF_MS=${perfMs}）`)
      // 绝对上界不随 PERF_MS 缩放 ⇒ 沙箱里也拦得住秒级：这是「不让断言在沙箱形同虚设」的第二颗牙
      assert.ok(!(tMal < 500), `绝对上界 500ms 必须拦下 ${tMal}ms（它不随 PERF_MS 缩放）`)
      assert.ok(!(tMal < 1000), `绝对上界 1000ms 必须拦下 ${tMal}ms（它不随 PERF_MS 缩放）`)
    }
  }
})
check('PERF_MS 缩放 ④: 生效上界必须来自本进程 PERF_MS，断言点不得退回裸比值', () => {
  // 防「算了但没接上」：断言点调用的 ratioBudget 必须与显式传参版同值
  assert.strictEqual(ratioBudget(10, 2, 0), ratioBudgetWith(10, 2, 0, process.env.PERF_MS), '生效上界必须来自本进程 PERF_MS')
  assert.strictEqual(ratioBudget(25, 2, 50), ratioBudgetWith(25, 2, 50, process.env.PERF_MS), '生效上界必须来自本进程 PERF_MS')
  assert.strictEqual(PERF_SCALE, perfScaleFor(process.env.PERF_MS), 'PERF_SCALE 必须由本进程 PERF_MS 推导')
  // 防「改回裸比值」：断言点若退回不含 PERF_SCALE 因子的裸形式，上面 ①②③ 会**照常全绿**（它们只测
  // 缩放函数本身），而本机实测比值仅 2.4–3.0× ⇒ 套件静默变绿、沙箱假杀复现。故直接扫本文件源码：
  //   (i) 逐行锁定 4 个比值断言行（以 tMal 起头紧跟比较符的行）都必须调用 ratioBudget；
  //   (ii) 再全局禁止「倍数 乘 tBenign」的裸形式（含括号包裹变体，朴素紧邻匹配会漏掉它）。
  // SonarCloud S8786（正则超线性回溯）：匹配前先做**归一**——去掉全部空白（replace(/\s+/g, '')）再
  // 去掉括号（replace(/[()]/g, '')）。归一后的待测串里既没有空白也没有括号，两条模式就只剩
  // 「字面量 + 单个量词 + 字面量」这一最简单形态：不再需要 \s*、不再需要可空的 `\(`/`\)`，
  // 也不再需要「倍数在左 / tBenign 在左」的交替分支 ⇒ 匹配退化为确定的一趟线性扫描。
  // 检测力不降：归一发生在匹配**之前**，且除逐行归一外还对整份源码归一并全局匹配一次
  // （与旧实现的「整份源码 + 可跨行 \s*」覆盖面相同；括号在归一阶段消掉，故括号包裹变体照样命中）；
  // 逐行那步只是额外把比率断言行单独挑出来核对。
  const flatLines = fs.readFileSync(__filename, 'utf8').split('\n').map(l => l.replace(/\s+/g, ''))
  const flatSrc = flatLines.join('') // 等价于 src.replace(/\s+/g, '')：行内空白与换行都被去掉
  const ratioLines = flatLines.filter(l => l.startsWith('tMal<='))
  assert.strictEqual(ratioLines.length, 4, `应有 4 条比值断言行（2 条 10× + 2 条 25×），实际 ${ratioLines.length} 条`)
  for (const l of ratioLines) {
    assert.match(l, /^tMal<=ratioBudget\(/, `比值断言行必须走 ratioBudget 缩放，实际：${l}`)
  }
  // 两条互不歧义的简单模式（各自都是线性的）：倍数在左 / 倍数在右；括号包裹变体已由上面的归一消掉
  const bareSrc = flatSrc.replace(/[()]/g, '')
  const bareRatioRes = [/tMal<=[0-9.]+\*tBenign/, /tMal<=tBenign\*[0-9.]+/]
  const bareRatio = bareRatioRes.map(re => bareSrc.match(re)).filter(Boolean).map(m => m[0])
  assert.deepStrictEqual(bareRatio, [], `比值断言不得退回不含 PERF_SCALE 因子的裸形式，已发现：${bareRatio.join(' / ')}`)
})

// ============================================================
// 脱敏链：addSecretCandidates → collectConfiguredSecrets → configuredSecrets → redactSecrets
// 这四个函数未导出，但从 safeErr 出口可观测：push_config 里的密钥值一旦出现在错误摘要里，
// 必须被 maskKey 遮蔽。cron 日志会重定向/分享，这条链断了就是真实密钥明文落盘。
// 每个用例把 push_config 临时换成给定键值（只换本次关心的），跑完逐键恢复。
// ============================================================
function withConfig (patch, fn) {
  const saved = {}
  for (const k of Object.keys(push_config)) saved[k] = push_config[k]
  try {
    for (const k of Object.keys(push_config)) delete push_config[k]
    for (const [k, v] of Object.entries(saved)) push_config[k] = v
    for (const [k, v] of Object.entries(patch)) push_config[k] = v
    return fn()
  } finally {
    for (const k of Object.keys(push_config)) delete push_config[k]
    for (const [k, v] of Object.entries(saved)) push_config[k] = v
  }
}

check('safeErr 脱敏: 密钥字段值被遮蔽成 maskKey 形态', () => {
  withConfig({ PUSH_KEY: 'fakesecretvalue' }, () => {
    assert.strictEqual(safeErr('失败 fakesecretvalue 结束'), '失败 fake***ue 结束')
    assert.strictEqual(safeErr('fakesecretvalue'), maskKey('fakesecretvalue'))
  })
})

check('safeErr 脱敏: URL 型密钥的路径段单独参与脱敏', () => {
  // 值里带 :// 时还要把 host 之后的路径段拆出来单独脱敏（Bark/Server酱 常把设备码放在路径里）
  withConfig({ PUSH_KEY: 'https://host.example/secretsegment' }, () => {
    assert.strictEqual(safeErr('x secretsegment y'), 'x secr***nt y', 'URL 路径段必须单独遮蔽')
    assert.strictEqual(safeErr('secretsegment'), maskKey('secretsegment'))
  })
})

check('safeErr 脱敏: # 分隔型密钥逐段参与脱敏', () => {
  withConfig({ PUSHME_KEY: 'aaaa1111#bbbb2222' }, () => {
    assert.strictEqual(safeErr('bbbb2222'), maskKey('bbbb2222'), '多设备码必须逐段遮蔽（不只遮整串）')
    assert.strictEqual(safeErr('aaaa1111'), maskKey('aaaa1111'))
    // 整值本身也是候选：日志里出现完整配置值时必须整串遮蔽（曾被逐段拆开遮）
    assert.strictEqual(safeErr('值 aaaa1111#bbbb2222 结束'), '值 aaaa***22 结束', '整值必须作为整体候选被遮蔽')
  })
})

check('safeErr 脱敏: 不足 4 字符的整值与分段不参与（短值会把正文打花）', () => {
  withConfig({ PUSH_KEY: 'abc' }, () => {
    assert.strictEqual(safeErr('abc'), 'abc', '3 字符整值不得加入候选')
  })
  withConfig({ PUSHME_KEY: 'longvalue#ab' }, () => {
    assert.strictEqual(safeErr('ab'), 'ab', '不足 4 字符的分段不得加入候选')
    assert.strictEqual(safeErr('longvalue'), maskKey('longvalue'), '够长的分段仍须遮蔽')
  })
})

check('safeErr 脱敏: 恰好 4 字符是参与下界', () => {
  withConfig({ PUSHME_KEY: 'longvalue#abcd' }, () => {
    assert.strictEqual(safeErr('abcd'), maskKey('abcd'), '4 字符分段必须参与脱敏')
  })
  withConfig({ PUSH_KEY: 'abcd' }, () => {
    assert.strictEqual(safeErr('abcd'), maskKey('abcd'), '4 字符整值必须参与脱敏')
  })
})

check('safeErr 脱敏: 长候选优先替换，短前缀先替换会残留明文尾部', () => {
  // 候选按长度降序替换：短候选先替换会把长密钥切成「前缀被遮、尾部明文」，等于脱敏失效。
  withConfig({ PUSH_KEY: 'abcd', PUSH_PLUS_TOKEN: 'abcdefghij' }, () => {
    const r = safeErr('abcdefghij')
    assert.strictEqual(r, '******ij')
    assert.ok(!r.includes('efghij'), `脱敏后不得残留密钥尾部明文，实际：${r}`)
  })
})

check('safeErr 脱敏: 数组值与数组项递归参与脱敏', () => {
  withConfig({ WX_pusher_appToken: ['arrsecretvalue'] }, () => {
    assert.strictEqual(safeErr('arrsecretvalue'), maskKey('arrsecretvalue'), '数组内的字符串项必须递归收集')
  })
  withConfig({ WX_pusher_channels: [{ appToken: 'channelsSecret1' }] }, () => {
    assert.strictEqual(safeErr('channelsSecret1'), maskKey('channelsSecret1'), '数组内对象的 appToken 必须递归收集')
  })
})

check('safeErr 脱敏: channels 字段的 JSON 字符串展开后逐字段脱敏', () => {
  // 青龙环境变量 WX_PUSHER_CHANNELS 是 JSON 字符串形态，必须先解析再收集里面的 appToken
  withConfig({ WX_pusher_channels: JSON.stringify([{ appToken: 'zzzzapptoken' }, { topicIds: '9999' }]) }, () => {
    assert.strictEqual(safeErr('zzzzapptoken'), maskKey('zzzzapptoken'))
  })
})

check('safeErr 脱敏: 非 channels 字段的 JSON 字符串不得展开', () => {
  // 展开只对 fieldName 含 channels 的字符串生效；否则会把无关配置里的 appToken 当密钥（甚至解析异常拖垮整轮收集）
  withConfig({ QYWX_ORIGIN: JSON.stringify({ appToken: 'qqqqapptoken' }) }, () => {
    assert.strictEqual(safeErr('qqqqapptoken'), 'qqqqapptoken', '非 channels 字段不得展开 JSON')
  })
})

check('safeErr 脱敏: 字段名白名单逐形态命中', () => {
  // SECRET_FIELD_RE 的每个分支都要有正例：token / app[_-]?token（含无分隔符）/ secret /
  // password / authorization / (^|_)(key|auth) / bark_push / push_key / pushme_key / deer_key /
  // xizhi_key / bot_token / user_id
  const names = [
    'token', 'APPToken', 'app_token', 'app-token', 'apptoken', 'secret', 'PASSWORD', 'Authorization',
    'key', '_key', 'api_key', 'auth', '_auth', 'BARK_PUSH', 'PUSH_KEY', 'PUSHME_KEY', 'DEER_KEY',
    'WX_XIZHI_KEY', 'TG_BOT_TOKEN', 'TG_USER_ID'
  ]
  const patch = {}
  names.forEach((n, i) => { patch[n] = `secmark${String(i).padStart(4, '0')}` })
  withConfig(patch, () => {
    names.forEach((n, i) => {
      const v = `secmark${String(i).padStart(4, '0')}`
      assert.strictEqual(safeErr(v), maskKey(v), `字段名 ${n} 的值必须被脱敏`)
    })
  })
})

check('safeErr 脱敏: 非密钥字段名不得参与（负例）', () => {
  const plain = [
    'QYWX_ORIGIN', 'PUSHME_URL', 'TG_API_HOST', 'DEER_URL', 'BARK_URL', 'BARK_GROUP',
    'BARK_SOUND', 'BARK_ICON', 'BARK_LEVEL', 'PUSH_PLUS_USER', 'WX_pusher_topicIds', 'HITOKOTO'
  ]
  const patch = {}
  plain.forEach((n, i) => { patch[n] = `plainmark${String(i).padStart(2, '0')}` })
  withConfig(patch, () => {
    plain.forEach((n, i) => {
      const v = `plainmark${String(i).padStart(2, '0')}`
      assert.strictEqual(safeErr(v), v, `非密钥字段 ${n} 的值不得被脱敏`)
    })
  })
})

check('safeErr 脱敏: 配置脏值（null / 数字 / 对象）不得中断后续密钥脱敏', () => {
  // 注释承诺「配置脏值不影响日志输出」：脏值必须被跳过后继续收集，而不是抛错中断整轮。
  withConfig({ HITOKOTO: null, TG_BOT_TOKEN: 'tgSecretValue01' }, () => {
    assert.strictEqual(safeErr('tgSecretValue01'), maskKey('tgSecretValue01'), 'null 脏值不得中断后续收集')
  })
  withConfig({ HITOKOTO: 0, TG_BOT_TOKEN: 'tgSecretValue01' }, () => {
    assert.strictEqual(safeErr('tgSecretValue01'), maskKey('tgSecretValue01'), '数字脏值不得中断后续收集')
  })
  withConfig({ WX_pusher_channels: [{ appToken: 'channelsSecret1' }], TG_BOT_TOKEN: 'tgSecretValue01' }, () => {
    assert.strictEqual(safeErr('tgSecretValue01'), maskKey('tgSecretValue01'), '数组值不得因走错分支而中断收集')
  })
})

check('safeErr 脱敏: 非 URL 字符串不得进入 URL 分段分支', () => {
  // 字段值不含 {}:// 时 match 为空，必须跳过而不是抛错——否则后置密钥全部漏遮
  withConfig({ BARK_PUSH: 'not a url with spaces', TG_BOT_TOKEN: 'tgSecretValue01' }, () => {
    assert.strictEqual(safeErr('tgSecretValue01'), maskKey('tgSecretValue01'))
  })
})

// ===== safeErr：协议摘要字段与 200 字符边界 =====
check('safeErr: 无 message 的对象取协议摘要字段，未命中字段时显式降级', () => {
  assert.strictEqual(safeErr({}), '[响应结构异常]', '空对象不得返回空串（否则失败日志整条丢失）')
  assert.strictEqual(safeErr({ code: 'ECONNRESET', statusCode: 500 }), '{"code":"ECONNRESET","statusCode":"500"}')
  assert.strictEqual(safeErr({ errno: -104, errmsg: 'bad gateway' }), '{"errno":"-104","errmsg":"bad gateway"}')
})

check('safeErr: 恰好 200 字符不截断、201 字符截断（字符串与 Error 两条路径）', () => {
  const y200 = 'y'.repeat(200)
  const y201 = 'y'.repeat(201)
  assert.strictEqual(safeErr(y200), y200, '200 字符在阈值内，不得追加省略号')
  assert.strictEqual(safeErr(y200).length, 200)
  assert.strictEqual(safeErr(y201).length, 201, '201 字符必须截断到 200 + 省略号')
  assert.ok(safeErr(y201).endsWith('…'))
  assert.strictEqual(safeErr(new Error(y200)), y200, 'Error.message 路径同一阈值')
  assert.strictEqual(safeErr(new Error(y201)).length, 201)
  assert.ok(safeErr(new Error(y201)).endsWith('…'))
})

// ===== stripAngleTags：autolink 前缀判定与 trim =====
check('stripAngleTags: http:// 与 http: 前缀的 autolink 保留内容', () => {
  assert.strictEqual(stripAngleTags('<http://x>', true), 'http://x', 'https? 的 s 可选')
  assert.strictEqual(stripAngleTags('<http:x>', true), 'http:x', '// 可选')
  assert.strictEqual(stripAngleTags('<HTTPS://X>', true), 'HTTPS://X', '大小写不敏感')
  assert.strictEqual(stripAngleTags('<ftp://x>', true), '', '非 http(s) 方案仍按 HTML 标签剥空')
})

check('stripAngleTags: 尖括号内首尾空白先 trim 再判定 autolink', () => {
  assert.strictEqual(stripAngleTags('< http://x>', true), 'http://x')
  assert.strictEqual(stripAngleTags('<http://x >', true), 'http://x')
})

check('stripAngleTags: 无 ">" 的尾部原样保留（i>0 时不得重复前缀）', () => {
  assert.strictEqual(stripAngleTags('文字<未闭合', true), '文字<未闭合')
  assert.strictEqual(stripAngleTags('a<b>c<未闭合', true), 'ac<未闭合')
})

// ===== mdToPlain 内联正则：斜体 lookbehind / 标题量词 / 实体解码 =====
check('mdToPlain: 斜体前后为字母或串首串尾仍剥除（数字例外）', () => {
  assert.strictEqual(mdToPlain('a*b*c'), 'abc')
  assert.strictEqual(mdToPlain('*a*'), 'a')
  assert.strictEqual(mdToPlain('5*3*2cm'), '5*3*2cm', '数字前后不剥（既有语义）')
})

check('mdToPlain: 多级标题（##~######）与多个空白', () => {
  assert.strictEqual(mdToPlain('## 标题'), '标题')
  assert.strictEqual(mdToPlain('###### h6'), 'h6')
  assert.strictEqual(mdToPlain('#  两个空格'), '两个空格', '标题后的多个空白必须整体剥掉')
  assert.strictEqual(mdToPlain('####### h7'), '####### h7', '超过 6 级不算标题')
})

check('mdToPlain: &quot; / &#39; 实体解码', () => {
  assert.strictEqual(mdToPlain('&quot;q&quot;'), '"q"')
  assert.strictEqual(mdToPlain('&#39;a&#39;'), "'a'")
})

// ===== mdLinksToPlain / mdImagesToPlain：线性扫描的「原样保留」分支 =====
// 这些分支在 i>0（前面已有成功替换）时若把整个 s 追加进去，会重复前缀——必须只追加 s.slice(i)。
check('mdLinksToPlain: 未闭合 ] 的尾部（i>0）原样保留，不重复整段', () => {
  assert.strictEqual(mdLinksToPlain('[a](u) x[y'), 'a (u) x[y')
})

check('mdImagesToPlain: 未闭合 ] 的尾部（i>0）原样保留，不重复整段', () => {
  assert.strictEqual(mdImagesToPlain('![a](u) x![y'), 'a x![y')
})

check('mdLinksToPlain: 连 ")" 都没有的畸形尾部（i>0）原样保留，不重复整段', () => {
  assert.strictEqual(mdLinksToPlain('[a](u) [b](c'), 'a (u) [b](c')
})

check('mdImagesToPlain: 连 ")" 都没有的畸形尾部（i>0）原样保留，不重复整段', () => {
  assert.strictEqual(mdImagesToPlain('![a](u) ![b](c'), 'a ![b](c')
})

check('mdLinksToPlain: 空 url 分支（i>0）只保留该构造，不重复整段', () => {
  assert.strictEqual(mdLinksToPlain('[a](u) [b]() z'), 'a (u) [b]() z')
})

// ===== push_config 默认值：配置字面量变异（StringLiteral/ArrayDeclaration）的击杀面 =====
check('push_config: 默认值逐键精确（空串默认不得被占位文本替换，非空默认不得被清空）', () => {
  // 源码注释逐键声明默认值：''=未配置、'false'=一言关闭、'https://api.telegram.org'=TG 默认 API。
  // StringLiteral 变异把 '' 换成 'Stryker was here!' ⇒ 「未配置」被自检当成已配置（假绿，
  // 主流程却抛 NO_CHANNEL_CONFIG）；反向变异清空非空默认值 ⇒ 默认 API 地址/一言开关丢失。
  const expected = {
    HITOKOTO: 'false',
    BARK_PUSH: '',
    BARK_ARCHIVE: '',
    BARK_GROUP: '',
    BARK_SOUND: '',
    BARK_ICON: '',
    BARK_LEVEL: '',
    BARK_URL: '',
    PUSH_KEY: '',
    DEER_KEY: '',
    DEER_URL: '',
    PUSH_PLUS_USER: '',
    WX_pusher_topicIds: '',
    PUSHME_URL: 'https://push.i-i.me',
    PUSHME_KEY: '',
    TG_USER_ID: '',
    TG_API_HOST: 'https://api.telegram.org',
    TG_PROXY_HOST: '',
    TG_PROXY_PORT: ''
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(push_config[key], value, `push_config.${key} 默认值必须为 ${JSON.stringify(value)}`)
  }
})

// ===== ENV_ALIASES：青龙 env 名 → push_config 键的映射表 =====
check('ENV_ALIASES: 每个键的别名列表完整，任一条目有非空 env 即覆盖 push_config', () => {
  // ArrayDeclaration 变异把别名列表清成 []、StringLiteral 变异把别名清成 '' ⇒ 面板里配好的密钥
  // 静默不生效（推送仍「成功」但一条没发出）。三个多别名键用**最后一个**别名驱动，
  // 证明整条列表都被保留而不是只剩首项。
  const env = {
    PUSH_PLUS_TOKEN: 'envPushPlus01',
    PUSH_PLUS_USER: 'envPushPlusUser',
    PUSH_KEY: 'envPushKey01',
    BARK_PUSH: 'envBarkPush01',
    BARK_ARCHIVE: 'envBarkArchive',
    BARK_GROUP: 'envBarkGroup01',
    BARK_SOUND: 'envBarkSound01',
    BARK_ICON: 'envBarkIcon01',
    BARK_LEVEL: 'envBarkLevel01',
    BARK_URL: 'envBarkUrl01',
    QYWX_KEY: 'envQywxKey01',
    QYWX_ORIGIN: 'envQywxOrigin',
    WX_PUSHER_APP_TOKEN: 'envWxAppToken1',
    WX_PUSHER_TOPIC_IDS: 'envWxTopicIds1',
    WX_PUSHER_CHANNELS: 'envWxChannels1',
    WX_XIZHI_KEY: 'envXizhiKey01',
    DEER_KEY: 'envDeerKey01',
    PUSHME_KEY: 'envPushmeKey1',
    PUSHME_URL: 'envPushmeUrl1',
    TG_BOT_TOKEN: 'envTgBotToken',
    TG_USER_ID: 'envTgUserId01',
    TG_API_HOST: 'envTgApiHost1',
    HITOKOTO: 'envHitokoto01'
  }
  const expect = {
    PUSH_PLUS_TOKEN: 'envPushPlus01',
    PUSH_PLUS_USER: 'envPushPlusUser',
    PUSH_KEY: 'envPushKey01',
    BARK_PUSH: 'envBarkPush01',
    BARK_ARCHIVE: 'envBarkArchive',
    BARK_GROUP: 'envBarkGroup01',
    BARK_SOUND: 'envBarkSound01',
    BARK_ICON: 'envBarkIcon01',
    BARK_LEVEL: 'envBarkLevel01',
    BARK_URL: 'envBarkUrl01',
    QYWX_KEY: 'envQywxKey01',
    QYWX_ORIGIN: 'envQywxOrigin',
    WX_pusher_appToken: 'envWxAppToken1',
    WX_pusher_topicIds: 'envWxTopicIds1',
    WX_pusher_channels: 'envWxChannels1',
    WX_XIZHI_KEY: 'envXizhiKey01',
    DEER_KEY: 'envDeerKey01',
    PUSHME_KEY: 'envPushmeKey1',
    PUSHME_URL: 'envPushmeUrl1',
    TG_BOT_TOKEN: 'envTgBotToken',
    TG_USER_ID: 'envTgUserId01',
    TG_API_HOST: 'envTgApiHost1',
    HITOKOTO: 'envHitokoto01'
  }
  const modPath = require.resolve('./xbk_sendNotify_slim')
  const cached = require.cache[modPath]
  const saved = {}
  for (const name of Object.keys(env)) { saved[name] = process.env[name]; process.env[name] = env[name] }
  try {
    delete require.cache[modPath]
    const reloaded = require('./xbk_sendNotify_slim')
    for (const [key, value] of Object.entries(expect)) {
      assert.strictEqual(reloaded.push_config[key], value, `env 别名必须让 push_config.${key} 取值 ${value}`)
    }
  } finally {
    delete require.cache[modPath]
    if (cached) require.cache[modPath] = cached
    for (const name of Object.keys(env)) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
})

// ===== collectConfiguredSecrets：递归收集的环路防护与类型守卫 =====
check('脱敏收集: 循环引用的对象不得死循环，且其中的密钥仍须收集', () => {
  // seen.has/seen.add 是环路防护：has 恒 true ⇒ 对象树整棵被跳过（漏遮）；has 恒 false ⇒
  // 自引用递归爆栈，被 configuredSecrets 的 catch 吞掉后同样整轮漏遮。
  const cyclic = { api_secret: 'cycleSecret01' }
  cyclic.self = cyclic
  withConfig({ holderField: cyclic }, () => {
    assert.strictEqual(safeErr('cycleSecret01'), maskKey('cycleSecret01'), '循环对象内的密钥必须被收集')
  })
})

check('脱敏收集: 纯对象（非数组）逐字段递归下潜', () => {
  // typeof value !== 'object' 守卫被反转/恒真时，对象值不再下潜 ⇒ 嵌套密钥整片漏遮。
  withConfig({ nestedHolder: { deep: { bot_token: 'deepSecret001' } } }, () => {
    assert.strictEqual(safeErr('deepSecret001'), maskKey('deepSecret001'), '嵌套对象的密钥必须递归收集')
  })
})

check('脱敏收集: 非字符串原语（数字）跳过但不得中断后续收集', () => {
  // 类型守卫失效时数字会走进 WeakSet 分支抛 TypeError，被外层 catch 吞掉 ⇒ 后面的密钥全漏遮。
  withConfig({ numericHolder: 12345, textHolder: { PUSH_KEY: 'afterPrimSecret' } }, () => {
    assert.strictEqual(safeErr('afterPrimSecret'), maskKey('afterPrimSecret'), '原语脏值不得中断后续收集')
  })
})

check('脱敏收集: URL 路径分段的 4 字符下界（3 字符不加入候选）', () => {
  withConfig({ BARK_PUSH: 'https://api.day.app/abc' }, () => {
    assert.strictEqual(safeErr('abc'), 'abc', '3 字符分段不足下界，不得加入候选')
  })
  withConfig({ BARK_PUSH: 'https://api.day.app/abcd' }, () => {
    assert.strictEqual(safeErr('abcd'), maskKey('abcd'), '4 字符分段必须加入候选')
  })
})

// ===== nonEmpty：0/false/空白 vs '0'/'false' 的两侧口径 =====
check('nonEmpty 口径: 0/false/纯空白不算已配置，"0"/"false" 等非空字符串算已配置', () => {
  // 判定被反转或 trim/字符串化被去掉，都会在「只配了空白」时误报可用通道（自检假绿 → 全程漏推）。
  withConfig({ PUSH_PLUS_TOKEN: '   ' }, () => {
    assert.strictEqual(configuredChannelCount(), 0, '纯空白值不算已配置')
  })
  withConfig({ PUSH_PLUS_TOKEN: 0 }, () => {
    assert.strictEqual(configuredChannelCount(), 0, '数字 0 不算已配置')
  })
  withConfig({ PUSH_PLUS_TOKEN: false }, () => {
    assert.strictEqual(configuredChannelCount(), 0, 'false 不算已配置')
  })
  withConfig({ PUSH_PLUS_TOKEN: '0' }, () => {
    assert.strictEqual(configuredChannelCount(), 1, '字符串 "0" 仍算已配置（历史口径不变）')
  })
})

// ===== WX_pusher_channels 解析：丢弃原因必须逐条精确告警（不得静默成功） =====
check('WX_pusher_channels: 丢弃/降级原因的告警文本与「已配置」判定逐例精确', () => {
  // 解析分支被反转或 configuredText 空白判定被改，会让「配了值但配置无效」静默回退 ⇒ 用户看到
  // 推送成功却一条没收到。逐例断言 hasWxPusherConfigured() 与 console.warn 的确切文本。
  const warns = []
  const originalWarn = console.warn
  console.warn = (msg) => { warns.push(String(msg)) }
  const tail = '，已忽略该多应用配置（回退 WX_pusher_appToken/WX_pusher_topicIds）'
  try {
    withConfig({ WX_pusher_channels: '{oops' }, () => {
      warns.length = 0
      assert.strictEqual(hasWxPusherConfigured(), false, 'JSON 解析失败不得算已配置')
      assert.strictEqual(warns.length, 1, 'JSON 解析失败必须告警且只告警一次')
      assert.strictEqual(warns[0], '⚠️ WX_pusher_channels 不是合法 JSON' + tail)
    })
    withConfig({ WX_pusher_channels: '{"a":1}' }, () => {
      warns.length = 0
      assert.strictEqual(hasWxPusherConfigured(), false, '非数组 JSON 不得算已配置')
      assert.strictEqual(warns.length, 1, 'JSON 不是数组必须告警且只告警一次')
      assert.strictEqual(warns[0], '⚠️ WX_pusher_channels 不是数组（应为 [{ appToken, topicIds }]）' + tail)
    })
    withConfig({ WX_pusher_channels: [{ topicIds: '1' }] }, () => {
      warns.length = 0
      assert.strictEqual(hasWxPusherConfigured(), false, '整表缺 appToken 不得算已配置')
      assert.strictEqual(warns.length, 1, '整表丢弃必须告警且只告警一次')
      assert.strictEqual(warns[0], '⚠️ WX_pusher_channels 的 1 项均缺 appToken 或 topicIds' + tail)
    })
    withConfig({ WX_pusher_channels: '   ' }, () => {
      warns.length = 0
      assert.strictEqual(hasWxPusherConfigured(), false, '纯空白视为未配置')
      assert.strictEqual(warns.length, 0, '纯空白是未配置，不得告警')
    })
    withConfig({ WX_pusher_channels: [] }, () => {
      warns.length = 0
      assert.strictEqual(hasWxPusherConfigured(), false, '空数组是明确不启用，不算已配置')
      assert.strictEqual(warns.length, 0, '空数组不得告警')
    })
    withConfig({ WX_pusher_channels: [{ appToken: 'APP_A', topicIds: '1' }, { topicIds: '2' }] }, () => {
      warns.length = 0
      assert.strictEqual(hasWxPusherConfigured(), true, '部分丢弃后仍有合法项即算已配置')
      assert.strictEqual(warns.length, 1, '部分丢弃必须告警且只告警一次')
      assert.strictEqual(warns[0], '⚠️ WX_pusher_channels 的 1 项缺 appToken 或 topicIds，已丢弃；仅启用其余 1 项')
    })
  } finally {
    console.warn = originalWarn
  }
})

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_sendnotify_pure.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
