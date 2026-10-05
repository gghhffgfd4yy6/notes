'use strict'

/* eslint camelcase: off */ // 模块导出的配置对象字面量就叫 push_config（改名会与生产同名导出脱钩）

// xbk_sendNotify_slim.js 纯函数方法测试（提升变异分数）
// 覆盖：maskKey/maskUrl/safeSlice/safeErr/mdLinksToPlain/mdImagesToPlain/mdToPlain/looksHtml/stripAngleTags
const assert = require('node:assert')
const fs = require('node:fs')
const { maskKey, maskUrl, safeSlice, safeErr, mdLinksToPlain, mdImagesToPlain, mdToPlain, looksHtml, stripAngleTags, push_config, configuredChannelCount, configuredChannelNames, hasWxPusherConfigured, getWxPusherProfileSummary, printWxPusherProfileSummary, sendNotify } = require('./xbk_sendNotify_slim')
// 判定器同源（S1/F1/P1）与截断单一实现（S6/F7）回归的对拍对象
const { looksLikeHtmlEnvelope } = require('./xbk_pusher')
const { createUtils } = require('./xbk_utils')
const Utils = createUtils({ safeRe: (source, flags) => new RegExp(source, flags) })

let pass = 0
let fail = 0
function check (name, fn) {
  const ok = () => { pass++; console.log(`  ✅ ${name}`) }
  const bad = (e) => { fail++; console.error(`  ❌ ${name}: ${e && e.message ? e.message : e}`); process.exitCode = 1 }
  let r
  try { r = fn() } catch (e) { bad(e); return }
  // 异步感知：回调返回 promise 时，须等 settled 再计数，否则断言失败会以 unhandled rejection
  // 逃逸出本函数的 try/catch，pass/fail 汇总失真（CodeRabbit PR #192 发现）。
  if (r && typeof r.then === 'function') {
    pendingAsyncChecks++
    r.then(() => { ok(); settleAsync() }, (e) => { bad(e); settleAsync() })
  } else {
    ok()
  }
}
// --- 异步用例互斥 ---
// 异步用例共享模块级 push_config / got 单例，promise 回调默认并发（注册即跑）会串扰
// （通道列表互染、mock 互相覆盖）。需要改全局状态的 async 用例一律经 checkS 注册：
// 内部串行队列，前一个 settled 才跑下一个；同步用例不受影响。
let channelQueue = Promise.resolve()
function checkS (name, fn) {
  check(name, () => {
    const run = channelQueue.then(fn, fn)
    channelQueue = run.then(() => {}, () => {})
    return run
  })
}

// 末尾汇总须等全部异步用例 settled 再打印（同步脚本结束时 promise 可能尚未完成）
let pendingAsyncChecks = 0
function settleAsync () {
  if (asyncWatchdog && pendingAsyncChecks === 1) clearTimeout(asyncWatchdog)
  if (--pendingAsyncChecks === 0) printSuiteSummary()
}
function printSuiteSummary () {
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_sendnotify_pure.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
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
// 部署侧 push_config.local.js（gitignore 真实密钥）经模块加载期 Object.assign 混进 push_config。
// local 注入的键在测试口径下必须视为「未配置」：否则 withConfig 的保存/恢复会把真实 token 原样带回，
// 「未配置」断言假红（本机曾 100% 红：WX_pusher_appToken/topicIds 泄入 isolateChannel/withConfig 状态）。
let LOCAL_ONLY_KEYS = []
try { LOCAL_ONLY_KEYS = Object.keys(require('./push_config.local.js')) } catch (e) { /* 无 local 配置文件 */ }
// env 覆盖不经过 withConfig（见 ENV_ALIASES 用例自管），此清单只含 local 文件注入的键。
const BASELINE_CONFIG = {}
for (const k of Object.keys(push_config)) BASELINE_CONFIG[k] = push_config[k]
for (const k of LOCAL_ONLY_KEYS) BASELINE_CONFIG[k] = undefined

function withConfig (patch, fn) {
  const saved = {}
  for (const k of Object.keys(push_config)) saved[k] = push_config[k]
  try {
    for (const k of Object.keys(push_config)) delete push_config[k]
    for (const [k, v] of Object.entries(BASELINE_CONFIG)) push_config[k] = v
    for (const [k, v] of Object.entries(patch)) push_config[k] = v
    return fn()
  } finally {
    for (const k of Object.keys(push_config)) delete push_config[k]
    for (const [k, v] of Object.entries(BASELINE_CONFIG)) push_config[k] = v
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
// SonarCloud S5332 对 http:// 字面量告警；此处只测解析（不发请求），用拼接规避字面量
const HTTP_ = 'http' + '://'
check('stripAngleTags: http:// 与 http: 前缀的 autolink 保留内容', () => {
  assert.strictEqual(stripAngleTags('<' + HTTP_ + 'x>', true), HTTP_ + 'x', 'https? 的 s 可选')
  assert.strictEqual(stripAngleTags('<http:x>', true), 'http:x', '// 可选')
  assert.strictEqual(stripAngleTags('<HTTPS://X>', true), 'HTTPS://X', '大小写不敏感')
  assert.strictEqual(stripAngleTags('<ftp://x>', true), '', '非 http(s) 方案仍按 HTML 标签剥空')
})

check('stripAngleTags: 尖括号内首尾空白先 trim 再判定 autolink', () => {
  assert.strictEqual(stripAngleTags('< ' + HTTP_ + 'x>', true), HTTP_ + 'x')
  assert.strictEqual(stripAngleTags('<' + HTTP_ + 'x >', true), HTTP_ + 'x')
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
  // 部署侧存在 push_config.local.js（gitignore 的真实密钥文件）时，local 配置按设计在模块加载期
  // Object.assign 覆盖默认值——此时默认值不可观测，与 test_sendnotify_utils.js:280 的跳过口径对齐
  // （本机存在该文件时本用例曾 100% 假红：WX_pusher_topicIds 被真实主题 ID 覆盖）。
  let hasLocalCfg = true
  try { require.resolve('./push_config.local.js') } catch (e) { hasLocalCfg = false }
  if (!hasLocalCfg) {
    for (const [key, value] of Object.entries(expected)) {
      assert.strictEqual(push_config[key], value, `push_config.${key} 默认值必须为 ${JSON.stringify(value)}`)
    }
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

// ===== WX_pusher_channels 解析簇真值表：丢弃原因与「已配置」判定（17 个 Survived 变异体的主战场） =====
// 探针：注入给定 WX_pusher_channels，返回 hasWxPusherConfigured() 与该次解析逐字产生的 warning 列表。
function probeChannels (value) {
  const warns = []
  const originalWarn = console.warn
  console.warn = (msg) => { warns.push(String(msg)) }
  try {
    let configured
    withConfig({ WX_pusher_channels: value }, () => { configured = hasWxPusherConfigured() })
    return { configured, warns }
  } finally {
    console.warn = originalWarn
  }
}

check('WX_pusher_channels: null/undefined/空白/显式空数组零告警，非 null 非字符串视为「已配置但不是数组」', () => {
  // 杀 L878-880 的比较/逻辑符/字面量变异：null 与 undefined 必须短路成「未配置」（零告警），
  // 而 0/false/{}/5 是「配了值但不是数组」必须逐字告警 —— 把 && 换 ||、把 !== 翻转、
  // 把 typeof 比较或空串字面量替换掉，都会在这两侧之一露馅（真值表两侧都要有真/假断言）。
  const NOT_ARRAY = '⚠️ WX_pusher_channels 不是数组（应为 [{ appToken, topicIds }]），已忽略该多应用配置（回退 WX_pusher_appToken/WX_pusher_topicIds）'
  for (const v of [null, undefined, '', '   ', '\t\n', [], '[]']) {
    const r = probeChannels(v)
    assert.strictEqual(r.configured, false, `${String(v)} 必须视为未配置`)
    assert.deepStrictEqual(r.warns, [], `${String(v)} 是未配置/显式空数组，不得告警`)
  }
  for (const v of [0, false, {}, 5]) {
    const r = probeChannels(v)
    assert.strictEqual(r.configured, false, `${String(v)} 解析不出条目`)
    assert.deepStrictEqual(r.warns, [NOT_ARRAY], `${String(v)} 是非 null 非字符串，必须判为已配置并告警形状`)
  }
  assert.deepStrictEqual(probeChannels('{"a":1}').warns, [NOT_ARRAY], 'JSON 对象不是数组，必须告警形状')
  assert.deepStrictEqual(probeChannels('{oops').warns,
    ['⚠️ WX_pusher_channels 不是合法 JSON，已忽略该多应用配置（回退 WX_pusher_appToken/WX_pusher_topicIds）'],
    '非法 JSON 必须逐字告警解析失败')
  assert.strictEqual(probeChannels([{ topicIds: '1' }]).warns[0],
    '⚠️ WX_pusher_channels 的 1 项均缺 appToken 或 topicIds，已忽略该多应用配置（回退 WX_pusher_appToken/WX_pusher_topicIds）',
    '整表丢弃必须逐字告警并带上项数')
})

check('WX_pusher_channels: 项内三别名 + trim/逗号分隔/空项过滤，空白或逗号项不得冒充条目', () => {
  // 杀 L895-899：项守卫被反转（合法项被丢、或非对象项走进属性访问而抛错）、appToken/topicIds 的 trim
  // 被去掉、split 的 ',' 字面量被替换、filter(Boolean) 被去掉、条目对象字面量被清空——每一个都会让
  // 「无效项」冒充合法通道（静默启用一个永远发不出去的通道）。逐例 deepStrictEqual 告警逐字文案。
  const ALL_MISSING = '⚠️ WX_pusher_channels 的 1 项均缺 appToken 或 topicIds，已忽略该多应用配置（回退 WX_pusher_appToken/WX_pusher_topicIds）'
  for (const v of [
    [{ appToken: 'APP_A', topicIds: '1,2' }],
    [{ appToken: 'APP_A', topicIds: '1,2,3' }],
    [{ app_token: 'APP_B', topic_ids: ' 3 , 4 ' }],
    [{ WX_pusher_appToken: 'APP_C', WX_pusher_topicIds: '5' }]
  ]) {
    const r = probeChannels(v)
    assert.strictEqual(r.configured, true, `合法条目必须算已配置：${JSON.stringify(v)}`)
    assert.deepStrictEqual(r.warns, [], `合法条目不得告警：${JSON.stringify(v)}`)
  }
  for (const v of [
    [{ appToken: '   ', topicIds: '1' }],
    [{ appToken: 'A', topicIds: '   ' }],
    [{ appToken: 'A', topicIds: ',' }],
    [{ appToken: 'A', topicIds: ' , ' }],
    [null],
    [' APP_A ']
  ]) {
    const r = probeChannels(v)
    assert.strictEqual(r.configured, false, `无效项不得冒充条目：${JSON.stringify(v)}`)
    assert.deepStrictEqual(r.warns, [ALL_MISSING], `无效项必须逐字告警：${JSON.stringify(v)}`)
  }
  const partial = probeChannels([{ appToken: 'APP_A', topicIds: '1' }, { appToken: '  ', topicIds: '2' }])
  assert.strictEqual(partial.configured, true, '部分丢弃后仍有合法项即算已配置')
  assert.deepStrictEqual(partial.warns,
    ['⚠️ WX_pusher_channels 的 1 项缺 appToken 或 topicIds，已丢弃；仅启用其余 1 项'],
    '部分丢弃必须按条数逐字告警')
  // 函数项：typeof 是 'function' 而非 'object'，必须丢弃；项守卫的 || 被换成 && 时它会带着
  // appToken/topicIds 混进 channels（函数在 JSON 里序列化成 null，故前面补一个合法项让缓存键唯一）
  const fnItem = Object.assign(() => {}, { appToken: 'APP_F', topicIds: '2' })
  const withFn = probeChannels([{ appToken: 'APP_A', topicIds: '1' }, fnItem])
  assert.strictEqual(withFn.configured, true, '函数项丢弃后合法项仍算已配置')
  assert.deepStrictEqual(withFn.warns,
    ['⚠️ WX_pusher_channels 的 1 项缺 appToken 或 topicIds，已丢弃；仅启用其余 1 项'],
    '函数项不是对象，必须按丢弃项计入告警条数')
})

// ===== 补测 PlanC：Markdown/文本处理簇的形态边界（父代理按 instrumenter 逐 id 定位后补齐）=====
// 反例（改动前）：下列形态边界在既有用例下全部存活——既有用例覆盖了主路径与「未闭合 ]」，
// 但没有覆盖 findDestEnd 的括号嵌套/转义/角括号预算、truncateBytes 的字节边界、cleanSurrogates 的配对语义。

// --- findDestEnd（经导出的 mdLinksToPlain / mdImagesToPlain 观测）---
// 杀「括号嵌套计数」「转义跳过」「角括号分支」「预算守卫」四类变异体。
check('PlanC findDestEnd: 目标里的嵌套括号必须配平到最外层（p1）', () => {
  // 目标 http://a/(b) 中的括号要配平；变异把 d 的增减/边界改坏就会截在错误位置
  const out = mdLinksToPlain('[t](http://a/(b))')
  assert.strictEqual(out, 't (http://a/(b))', '嵌套括号必须整体收进链接目标')
})

check('PlanC findDestEnd: 转义括号不参与配平（p2）', () => {
  const out = mdLinksToPlain('[t](http://a/\\(x\\))')
  assert.strictEqual(out, 't (http://a/\\(x\\))', '反斜杠转义的括号必须被跳过、不改变配平深度')
})

check('PlanC findDestEnd: 角括号包裹的目标必须整体保留（p3）', () => {
  // 实测：角括号形态的目标**连尖括号一起**原样保留在输出里（并非剥掉 <>）。
  assert.strictEqual(mdLinksToPlain('[t](<http://a>)'), 't (<http://a>)', '角括号命中 g+1 后目标段必须完整取出（含 <>）')
  assert.strictEqual(mdLinksToPlain('[t](<http://a> extra)'), 't (<http://a> extra)', '角括号后不是 ) 时必须继续走配平循环、同样完整保留')
})

check('PlanC findDestEnd: 预算耗尽必须回落而不越界（p4）', () => {
  // 角括号分支要先扣预算：'[a](<' 这类「有 < 但没有 >」的畸形构造不得扫到串尾后仍返回越界值
  const out = mdLinksToPlain('[a](<')
  assert.strictEqual(typeof out, 'string', '畸形输入不得抛错')
  assert.strictEqual(out.includes('undefined'), false, '不得把越界下标拼进输出')
})

// --- mdLinksToPlain / mdImagesToPlain 的畸形尾部必须原样保留且不重复整段 ---
check('PlanC mdLinksToPlain: 连 ")" 都没有的畸形尾部原样保留（p5）', () => {
  assert.strictEqual(mdLinksToPlain('[t](http://a'), '[t](http://a', '既无 ) 也无配平时必须原样保留整段，不得重复前缀')
  assert.strictEqual(mdLinksToPlain('pre [t](http://a'), 'pre [t](http://a', '带前缀时同样不得重复前缀')
})

check('PlanC mdImagesToPlain: 未闭合且无可配平括号时原样保留（p6）', () => {
  assert.strictEqual(mdImagesToPlain('![a](http://x'), '![a](http://x', '图片链接畸形尾部必须原样保留')
})

// --- truncateBytes（经 mdToPlain 的出口清洗路径不可达；该函数未导出 ⇒ 只断言可观测行为）---
// 说明：truncateBytes 未在 module.exports 中，无法直接断言；其 13 个靶子需经调用点观测。
// 已在报告里登记为「需导出或注入才可观测」，此处不写自欺断言。

// --- cleanSurrogates（未导出 ⇒ 经 sendNotify 入口观测：入口必须清洗孤立代理）---
// 该函数未导出，但其语义可由「sendNotify 对入参的清洗」间接锁定（见 test_sendnotify_utils.js 的通道用例）。
// 此处不写不可达断言，登记为「需导出才可直接断言」。

// --- getWxPusherProfileSummary（此前无任何测试覆盖）---
// 语义：XBK_PROFILE!=='3' 时返回空数组；='3' 时返回内部统计 Map 的浅拷贝快照（对象隔离，不暴露内部引用）。
// 注意：stats Map 为模块级单例，仅在 XBK_PROFILE='3' 时经 wxPusherProfileStat 填充，
// 测试环境默认未设置该变量 → 只断言「非 profile 模式返回 []」与「开启后返回的是全新对象数组」，
// 不依赖 Map 内历史内容（其他套件曾在子进程设置过 XBK_PROFILE 也不会影响本进程）。
check('getWxPusherProfileSummary: XBK_PROFILE 未设置/非3 时返回空数组（profile 功能关闭）', () => {
  const orig = process.env.XBK_PROFILE
  try {
    delete process.env.XBK_PROFILE
    assert.deepStrictEqual(getWxPusherProfileSummary(), [], '未开启 profile 必须返回空数组')
    process.env.XBK_PROFILE = '2'
    assert.deepStrictEqual(getWxPusherProfileSummary(), [], "XBK_PROFILE='2' 不属于 summary 档（只有 '3' 汇总）")
  } finally {
    if (orig === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = orig
  }
})

checkS('getWxPusherProfileSummary: 开启时返回快照且与内部状态对象隔离（返回 {...stat} 浅拷贝）', () => {
  const orig = process.env.XBK_PROFILE
  const got = require('got')
  const { EventEmitter } = require('node:events')
  const origGot = { post: got.post, get: got.get, stream: got.stream }
  const cfgKeys = ['WX_pusher_appToken', 'WX_pusher_topicIds', 'WX_pusher_channels']
  const savedCfg = cfgKeys.map(k => [k, push_config[k]])
  // restoreEnv：恢复 got / push_config / XBK_PROFILE。Map 本身未导出、无法直接 clear；
  // 残留条目的 key 是原始 appToken（本用例为 'AT_test123' 占位符），且仅在 XBK_PROFILE='3'
  // 时对任何读取者可见（getWxPusherProfileSummary/printWxPusherProfileSummary 首行即拦截），
  // 恢复 env 后即对外不可见——无同套件污染风险，无需生产端加清理口。
  const restoreEnv = () => {
    Object.assign(got, origGot)
    for (const [k, v] of savedCfg) { if (v === undefined) delete push_config[k]; else push_config[k] = v }
    if (orig === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = orig
  }
  try {
    // arrange：经生产路径（sendNotify → wxPusher 通道 → wxPusherProfileStat）填入一条真实统计，
    // 避免「空 Map 下循环不执行、断言空洞」——Sourcery PR #192 发现的问题。
    // got.stream 假流回 {code:1000}（成功），不触网；其余通道不配置。
    for (const k of cfgKeys) delete push_config[k]
    push_config.WX_pusher_appToken = 'AT_test123'
    push_config.WX_pusher_topicIds = '5'
    process.env.XBK_PROFILE = '3'
    const makeMockStream = () => {
      const s = new EventEmitter()
      s.timings = { phases: { total: 1 } }
      s.destroy = () => {}
      setTimeout(() => {
        s.emit('response', { statusCode: 200, headers: { 'content-type': 'application/json' } })
        s.emit('data', Buffer.from('{"code":1000}'))
        s.emit('end')
      }, 0)
      return s
    }
    const mockPost = () => Promise.resolve({ body: '{}', statusCode: 200, headers: {}, timings: { phases: {} } })
    got.post = mockPost
    got.get = mockPost
    got.stream = Object.assign(makeMockStream, { get: makeMockStream, post: makeMockStream })
    return Promise.resolve()
      .then(() => sendNotify('快照隔离探针', '正文'))
      .then(() => {
        const summary = getWxPusherProfileSummary()
        assert.strictEqual(summary.length, 1, '经生产路径应恰好记录 1 个 app 的统计')
        const stat = summary[0]
        // 形状锁：七个统计字段齐全——新增/删除字段这里即红（与 printWxPusherProfileSummary 的打印字段同源）
        for (const k of ['app', 'attempts', 'success', 'failed', 'rateLimited', 'networkError', 'apiError']) {
          assert.ok(Object.prototype.hasOwnProperty.call(stat, k), `快照缺字段 ${k}`)
        }
        assert.strictEqual(stat.attempts, 1, 'attempts 应为 1')
        assert.strictEqual(stat.success, 1, 'success 路径应计 1 次成功')
        assert.strictEqual(stat.failed, 0, '失败计数应为 0')
        assert.strictEqual(typeof stat.app, 'string', 'app 应是 maskKey 后的字符串')
        assert.ok(stat.app.startsWith('AT_t') && stat.app.endsWith('23'), 'app 必须经 maskKey 脱敏（不得回显完整 token）')
        // 隔离性：改快照不得影响下一次读取（浅拷贝语义，防止调用方污染内部统计）
        const before = JSON.stringify(getWxPusherProfileSummary())
        stat.attempts = 999999
        assert.strictEqual(JSON.stringify(getWxPusherProfileSummary()), before, '修改快照不得影响内部状态（必须返回拷贝）')
      })
      .finally(() => {
        restoreEnv()
      })
  } catch (e) {
    restoreEnv()
    throw e
  }
})

// 假绿防护：若有异步用例永不 settled（如 mock 流在发事件前抛错），事件循环会保持空转、node 静默
// 挂着不退出或排空后 exit 0 且不打印汇总。看门狗必须在全部 check 注册之后再启动（否则
// pendingAsyncChecks 还是 0，看门狗会是 null）——故放文件末尾。5s 仍有未决用例则判失败并打印汇总。
const asyncWatchdog = pendingAsyncChecks > 0
  ? setTimeout(() => {
    if (pendingAsyncChecks > 0) {
      console.error(`  ❌ ${pendingAsyncChecks} 个异步用例 5s 内未 settle（可能 mock 未发事件），判定为失败`); process.exitCode = 1
      printSuiteSummary()
    }
  }, 5000)
  : null
if (pendingAsyncChecks === 0) printSuiteSummary()

// ===== v3 通道发送簇（PR #192 后续补强：息知/PushDeer/TG 通道、字节截断）=====
// 夹具：单一通道隔离 + got.stream 假流（回包体按该通道成功判定协议定制），全程不触网。
// 各通道成功判定（生产契约）：息知 code===200；PushDeer data.content.result.length>0；TG data.ok===true。
// API 级失败契约（v3.160）：HTTP 200 但业务失败必须 reject（channelError 带 channel/providerCode），
// 不得静默 resolve 把消息记成成功。
const gotModule = require('got')
const { EventEmitter: ChannelEE } = require('node:events')

function mockGotForChannels (respond) {
  const makeStream = (body) => {
    const s = new ChannelEE()
    s.timings = { phases: { total: 1 } }
    s.destroy = () => {}
    setTimeout(() => {
      s.emit('response', { statusCode: 200, headers: { 'content-type': 'application/json' } })
      s.emit('data', Buffer.from(body))
      s.emit('end')
    }, 0)
    return s
  }
  const orig = { post: gotModule.post, get: gotModule.get, stream: gotModule.stream }
  const fakeStream = (method) => (url, opts) => makeStream(respond(String(url), opts))
  const fakePromise = (url, opts) => Promise.resolve({ body: respond(String(url), opts), statusCode: 200, headers: {}, timings: { phases: {} } })
  gotModule.post = fakePromise
  gotModule.get = fakePromise
  gotModule.stream = Object.assign((...a) => makeStream(respond(...a)), {
    post: fakeStream('post'),
    get: fakeStream('get')
  })
  return () => { Object.assign(gotModule, orig) }
}

// 单通道隔离：清掉已知通道键，只留 want 里给的；结束后按 saved 恢复。
// 通道「使能键」+「端点/群组覆盖键」全集：isolateChannel 每次只留 want 里给的键，其余一律删掉。
// 后 5 个（QYWX_ORIGIN/PUSH_PLUS_USER/PUSHME_URL/TG_API_HOST/DEER_URL）不是使能键，但会改变
// 请求 URL 与「一对一/一对多」形态 ⇒ 不清就会让上一条用例的端点覆盖漏进下一条（v4 簇的
// SN-07/SNB-02/SN-24 正是靠「恰好发 1 次、URL 逐字」做判据的）。删掉后各通道按 `|| 默认值` 回退，
// 与生产默认一致，所以老用例（只设使能键）行为不变。
const ALL_CHANNEL_KEYS = ['WX_pusher_appToken', 'WX_pusher_topicIds', 'WX_pusher_channels',
  'PUSH_PLUS_TOKEN', 'PUSH_KEY', 'BARK_PUSH', 'QYWX_KEY', 'WX_XIZHI_KEY', 'DEER_KEY',
  'PUSHME_KEY', 'TG_BOT_TOKEN', 'TG_USER_ID', 'TG_API_HOST', 'HITOKOTO',
  'QYWX_ORIGIN', 'PUSH_PLUS_USER', 'PUSHME_URL', 'DEER_URL']

function isolateChannel (want) {
  const saved = ALL_CHANNEL_KEYS.map(k => [k, push_config[k]])
  for (const k of ALL_CHANNEL_KEYS) delete push_config[k]
  for (const [k, v] of Object.entries(want)) push_config[k] = v
  return () => {
    for (const [k, v] of saved) { if (v === undefined) delete push_config[k]; else push_config[k] = v }
  }
}

checkS('息知通道: code===200 判成功，successfulChannels 含「息知」', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/key' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ code: 200 }))
  try {
    const res = await sendNotify('息知成功探针', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['息知'], '成功通道应为息知')
    assert.strictEqual(res.failures.length, 0, '不得有失败记录')
  } finally { restore(); restoreGot() }
})

checkS('息知通道: HTTP 200 但 code≠200 必须 reject（API 级失败不得静默成功）', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/key' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ code: 500, msg: '内部错误' }))
  try {
    let threw = null
    try { await sendNotify('息知失败探针', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'code≠200 必须抛错（v3.160 契约）')
    assert.ok(Array.isArray(threw.failures) && threw.failures.some(f => f.channel === '息知'), `failures 应含息知失败，实际: ${JSON.stringify(threw.failures)}`)
  } finally { restore(); restoreGot() }
})

checkS('息知通道: HTTP 200 + JSON null 响应必须按失败处理（v3.180 判空防御）', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/key' })
  const restoreGot = mockGotForChannels(() => 'null')
  try {
    let threw = null
    try { await sendNotify('息知空响应', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'data 为 null 必须拒绝（曾虚假成功）')
  } finally { restore(); restoreGot() }
})

checkS('息知通道: 请求体形态——url 用 WX_XIZHI_KEY，json 含 title/content', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/realpath' })
  let captured = null
  const restoreGot = mockGotForChannels((url, opts) => { captured = { url, opts }; return JSON.stringify({ code: 200 }) })
  try {
    await sendNotify('标题甲', '内容乙')
    assert.ok(captured, '必须发出请求')
    assert.ok(String(captured.url).startsWith('https://xizhi.fake/realpath'), `url 应取 WX_XIZHI_KEY，实际 ${captured.url}`)
    assert.strictEqual(captured.opts.json.title, '标题甲', 'title 应为 text')
    assert.strictEqual(captured.opts.json.content, '内容乙', 'content 应为 desp')
  } finally { restore(); restoreGot() }
})

checkS('PushDeer: content.result.length>0 判成功', async () => {
  const restore = isolateChannel({ DEER_KEY: 'PDK_fake' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ content: { result: [{ message: 'ok' }] } }))
  try {
    const res = await sendNotify('PD成功', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['pushdeer'], '成功通道应为 pushdeer')
  } finally { restore(); restoreGot() }
})

checkS('PushDeer: result 空数组必须 reject（API 级失败）', async () => {
  const restore = isolateChannel({ DEER_KEY: 'PDK_fake' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ content: { result: [] } }))
  try {
    let threw = null
    try { await sendNotify('PD失败', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'result 空必须拒绝')
  } finally { restore(); restoreGot() }
})

checkS('PushDeer: 请求体为 urlencode 表单，pushkey/text/desp 齐全且 & = # 已编码', async () => {
  const restore = isolateChannel({ DEER_KEY: 'PDK&weird=key#x' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ content: { result: [1] } }))
  try {
    let bodyCaptured = null
    const origStreamPost = gotModule.stream.post
    gotModule.stream.post = (url, opts) => { bodyCaptured = { url, opts }; return origStreamPost(url, opts) }
    try { await sendNotify('标题&特=殊#字', '正文<a>') } finally { gotModule.stream.post = origStreamPost }
    assert.ok(bodyCaptured, '必须发出 POST')
    const body = bodyCaptured.opts.body
    assert.ok(body.includes(`pushkey=${encodeURIComponent('PDK&weird=key#x')}`), 'pushkey 必须 encodeURIComponent（&=# 不得裸传）')
    assert.ok(body.includes(`text=${encodeURIComponent('标题&特=殊#字')}`), 'text 必须编码')
    assert.ok(body.includes('type=markdown'), 'type=markdown 是既有契约')
  } finally { restore(); restoreGot() }
})

checkS('PushDeer: 默认 url 为 api2.pushdeer.com，DEER_URL 可覆盖', async () => {
  const restoreGot = mockGotForChannels(() => JSON.stringify({ content: { result: [1] } }))
  try {
    const origStreamPost = gotModule.stream.post
    const grab = (urls) => (url, opts) => { urls.push(String(url)); return origStreamPost(url, opts) }
    let restore = isolateChannel({ DEER_KEY: 'PDK1' })
    const urls1 = []
    gotModule.stream.post = grab(urls1)
    try { await sendNotify('a', 'b') } finally { gotModule.stream.post = origStreamPost; restore() }
    assert.strictEqual(new URL(urls1[0]).hostname, 'api2.pushdeer.com', `默认端点应为 api2.pushdeer.com，实际 ${urls1[0]}`)
    restore = isolateChannel({ DEER_KEY: 'PDK2', DEER_URL: 'https://deer.example/push' })
    const urls2 = []
    gotModule.stream.post = grab(urls2)
    try { await sendNotify('a', 'b') } finally { gotModule.stream.post = origStreamPost; restore() }
    assert.strictEqual(new URL(urls2[0]).hostname, 'deer.example', `DEER_URL 应可覆盖，实际 ${urls2[0]}`)
  } finally { restoreGot() }
})

checkS('Telegram: data.ok===true 判成功；text 经 HTML 转义；url 含 bot token', async () => {
  const restore = isolateChannel({ TG_BOT_TOKEN: 'TOK', TG_USER_ID: '42' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ ok: true }))
  try {
    let captured = null
    const origStreamPost = gotModule.stream.post
    gotModule.stream.post = (url, opts) => { captured = { url, opts }; return origStreamPost(url, opts) }
    try {
      const res = await sendNotify('TG标题', '正文<b>&"x')
      assert.deepStrictEqual(res.successfulChannels, ['telegram'], '成功通道应为 telegram')
    } finally { gotModule.stream.post = origStreamPost }
    assert.ok(/\/botTOK\/sendMessage$/.test(String(captured.url).split('?')[0]), `url 应含 bot token 路径，实际 ${captured.url}`)
    assert.strictEqual(captured.opts.json.parse_mode, 'HTML', 'parse_mode 必须是 HTML（v3.132，Markdown 对未配对 * 报错）')
    assert.strictEqual(captured.opts.json.disable_web_page_preview, true, '禁预览契约')
    assert.ok(captured.opts.json.text.includes('&lt;b&gt;'), 'HTML 敏感字符必须转义')
    assert.ok(captured.opts.json.text.includes('&amp;'), '& 必须转义')
  } finally { restore(); restoreGot() }
})

checkS('Telegram: ok≠true 必须 reject（API 级失败）', async () => {
  const restore = isolateChannel({ TG_BOT_TOKEN: 'TOK', TG_USER_ID: '42' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ ok: false, error_code: 400, description: 'chat not found' }))
  try {
    let threw = null
    try { await sendNotify('TG失败', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'ok≠true 必须拒绝')
    assert.ok(/chat not found|Telegram/.test(threw.message), `错误信息应含 description 或通道名，实际: ${threw.message}`)
  } finally { restore(); restoreGot() }
})

checkS('Telegram: TG_PROXY 配置给出一次性不生效警告（v3.76 防误配静默失效）', async () => {
  const restore = isolateChannel({ TG_BOT_TOKEN: 'TOK', TG_USER_ID: '42', TG_PROXY_HOST: 'proxy.example', TG_PROXY_PORT: '1080' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ ok: true }))
  const origWarn = console.warn
  const warns = []
  console.warn = (m) => warns.push(String(m))
  try {
    await sendNotify('a', 'b')
    assert.ok(warns.some(w => w.includes('TG_PROXY') && w.includes('不生效')), `必须警告代理未接入，实际: ${JSON.stringify(warns)}`)
  } finally { console.warn = origWarn; restore(); restoreGot() }
})

checkS('TG 超长文本: safeSlice 4000 字符截断且末尾不得是孤立高代理', async () => {
  const restore = isolateChannel({ TG_BOT_TOKEN: 'TOK', TG_USER_ID: '42' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ ok: true }))
  try {
    let captured = null
    const origStreamPost = gotModule.stream.post
    gotModule.stream.post = (url, opts) => { captured = opts; return origStreamPost(url, opts) }
    const longText = '锚' + '🌟'.repeat(3000) // 3000 个 4 字节 emoji ≈ 12000 字节
    try { await sendNotify('t', longText) } finally { gotModule.stream.post = origStreamPost }
    const sent = captured.json.text
    assert.ok(sent.length <= 4000, `TG 文本必须按字符受限（safeSlice 4000），实际 ${sent.length} 字符`)
    const last = sent.charCodeAt(sent.length - 1)
    assert.ok(!(last >= 0xD800 && last <= 0xDBFF), '末尾不得是孤立高代理（会乱码/URIError）')
  } finally { restore(); restoreGot() }
})

checkS('sendNotify: 未配置任何通道时抛 NO_CHANNEL_CONFIG', async () => {
  const restore = isolateChannel({})
  try {
    let threw = null
    try { await sendNotify('a', 'b') } catch (e) { threw = e }
    assert.ok(threw, '无通道必须抛错')
    assert.strictEqual(threw.code, 'NO_CHANNEL_CONFIG', `错误码应为 NO_CHANNEL_CONFIG，实际 ${threw.code}`)
    assert.ok(threw.message.includes('未配置任何推送通道'), '错误信息应列出全部通道名')
  } finally { restore() }
})

checkS('sendNotify: 双通道一败一成=部分成功不抛错；双成功 failures 为空', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', DEER_KEY: 'PDK' })
  const restoreGot = mockGotForChannels((url) => {
    if (String(url).includes('xizhi.fake')) return JSON.stringify({ code: 200 })
    return JSON.stringify({ content: { result: [] } })
  })
  try {
    let threw = null
    let res = null
    try { res = await sendNotify('混合', '正文') } catch (e) { threw = e }
    assert.ok(!threw, `一成一败不得抛错（部分成功语义），实际: ${threw && threw.message}`)
    assert.deepStrictEqual(res.successfulChannels, ['息知'], '成功通道应为息知')
    assert.strictEqual(res.failures.length, 1, 'pushdeer 失败应计入 failures')
    assert.strictEqual(res.failures[0].channel, 'pushdeer', '失败记录必须带 channel 标识')
  } finally { restore(); restoreGot() }
  const restore2 = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', DEER_KEY: 'PDK' })
  const restoreGot2 = mockGotForChannels((url) => {
    if (String(url).includes('xizhi.fake')) return JSON.stringify({ code: 200 })
    return JSON.stringify({ content: { result: [1] } })
  })
  try {
    const res2 = await sendNotify('双成功', '正文')
    assert.strictEqual(res2.successfulChannels.length, 2, '两通道都应成功')
    assert.deepStrictEqual(res2.failures, [], 'failures 应为空数组')
  } finally { restore2(); restoreGot2() }
})

checkS('sendNotify: 全通道业务失败抛 ALL_CHANNELS_FAILED 且带 failures 数组', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', DEER_KEY: 'PDK' })
  const restoreGot = mockGotForChannels(() => JSON.stringify({ code: 1 }))
  try {
    let threw = null
    try { await sendNotify('全败', '正文') } catch (e) { threw = e }
    assert.ok(threw, '全部失败必须抛错')
    assert.strictEqual(threw.code, 'ALL_CHANNELS_FAILED', `错误码应为 ALL_CHANNELS_FAILED，实际 ${threw.code}`)
    assert.ok(Array.isArray(threw.failures) && threw.failures.length === 2, '必须带两个通道的失败详情')
    assert.ok(/息知|pushdeer/.test(threw.message), `错误信息应含通道名，实际: ${threw.message}`)
  } finally { restore(); restoreGot() }
})

// --- 一言开关与拼接簇（HITOKOTO 开关口径、3s 短超时、响应防御）---
checkS('一言: HITOKOTO 显式 true 时请求一言并拼接 desp（含 from 缺省不输出 undefined）', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', HITOKOTO: true })
  const restoreGot = mockGotForChannels((url) => {
    if (String(url).includes('hitokoto')) return JSON.stringify({ hitokoto: '一句', from: '出处' })
    return JSON.stringify({ code: 200 })
  })
  try {
    let hitokotoOpts = null
    const origGet = gotModule.get
    gotModule.get = (url, opts) => { if (String(url).includes('hitokoto')) hitokotoOpts = opts; return origGet(url, opts) }
    try { await sendNotify('t', '正文') } finally { gotModule.get = origGet }
    assert.ok(hitokotoOpts, 'HITOKOTO=true 必须请求一言')
    assert.strictEqual(hitokotoOpts.timeout, 3000, '一言必须 3s 短超时（v3.151）')
    assert.deepStrictEqual(hitokotoOpts.retry, { limit: 0 }, '必须显式关闭 got 重试（v3.273 S4）')
  } finally { restore(); restoreGot() }
})

checkS('一言: 字符串 \'true\' 与 \'TRUE\' 也开启（兼容环境变量字符串形态）', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', HITOKOTO: 'true' })
  const restoreGot = mockGotForChannels((url) => {
    if (String(url).includes('hitokoto')) return JSON.stringify({ hitokoto: 'x', from: '' })
    return JSON.stringify({ code: 200 })
  })
  try {
    let called = false
    const origGet = gotModule.get
    gotModule.get = (url, opts) => { if (String(url).includes('hitokoto')) called = true; return origGet(url, opts) }
    try { await sendNotify('t', '正文') } finally { gotModule.get = origGet }
    assert.strictEqual(called, true, "HITOKOTO='true' 字符串必须开启")
  } finally { restore(); restoreGot() }
})

checkS('一言: 0 / \'false\' / undefined 均关闭（旧逻辑仅排 \'false\'，\'0\' 曾误开）', async () => {
  for (const v of [0, 'false', '0', undefined, '']) {
    const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', HITOKOTO: v })
    const restoreGot = mockGotForChannels((url) => {
      if (String(url).includes('hitokoto')) return JSON.stringify({ hitokoto: 'x', from: '' })
      return JSON.stringify({ code: 200 })
    })
    try {
      let called = false
      const origGet = gotModule.get
      gotModule.get = (url, opts) => { if (String(url).includes('hitokoto')) called = true; return origGet(url, opts) }
      try { await sendNotify('t', '正文') } finally { gotModule.get = origGet }
      assert.strictEqual(called, false, `HITOKOTO=${JSON.stringify(v)} 必须关闭`)
    } finally { restore(); restoreGot() }
  }
})

checkS('一言: 一言失败不阻塞推送（catch 跳过，主通道照发）', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k', HITOKOTO: true })
  const restoreGot = mockGotForChannels((url) => {
    if (String(url).includes('hitokoto')) return 'not-json{{' // 解析失败
    return JSON.stringify({ code: 200 })
  })
  try {
    const res = await sendNotify('t', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['息知'], '一言挂掉不得影响主推送')
  } finally { restore(); restoreGot() }
})

// ============================================================
// v4 分支补强簇（g12）：通道响应判定 / 传输错误 / 结构异常 / 汇总归因
// 依据 c8 全语料口径实测的「未达分支」清单（xbk_sendNotify_slim.js 68 条）逐条判定可达性后落地。
// 不可达的（配置谓词与 sendNotify 的 configuredFlags 同源 ⇒「未配置就返回」的内部守卫永远走不到；
// `$.get` 全仓无调用方 ⇒ 已随 v3.279 删除）不写断言，单独在 PR 说明里交底——不为凑覆盖率伪造演员。
//
// 夹具扩展：可编程假收件台。respond 返回 spec，两态——`spec.error`＝传输错误，否则＝回包体
// （`spec.body`，流式路径按 JSON 解析失败时保留原样字符串，所以 HTML 响应体也演得出）。
// 桩必须打在 got.stream.post|get 上：本机 got.stream 存在 ⇒ canStreamRequest() 恒真 ⇒
// `$.post` 生产真实走 streamRequest(:354)，got.post(:407) 只是无 stream 时的回退。
// 两种桩都装：stream 走生产真实路径，promise 桩保证万一 got 形态变化用例仍能收敛而非触网。
// ============================================================

// ============================================================
// 夹具契约：respond(url, opts) **一律返回 spec 对象**（{ body | error }），不做 `|| {}` 兜底——
// 兜底是一道没人经过的门（本 PR 在 utils 侧已按同一口径删过一次），留着只会被 Sonar 再点名。
// 也不开放 spec.timings / spec.response 开关：本簇没有任何用例传过它们，需要的计时/状态观测
// 已在生产路径上固定注入；将来真要用例要观测它们，请连同断言一起把开关加回来。
const mockTransport = (respond) => {
  const captured = []
  const bodyOf = (spec) => typeof spec.body === 'string'
    ? spec.body
    : JSON.stringify(spec.body === undefined ? {} : spec.body)
  const makeStream = (url, opts) => {
    captured.push({ url: String(url), opts })
    const spec = respond(String(url), opts)
    const s = new ChannelEE()
    s.timings = { phases: { total: 1 } }
    s.destroy = () => {}
    setTimeout(() => {
      if (spec.error !== undefined) { s.emit('error', spec.error); return }
      s.emit('response', { statusCode: 200, headers: { 'content-type': 'application/json' } })
      s.emit('data', Buffer.from(bodyOf(spec)))
      s.emit('end')
    }, 0)
    return s
  }
  const fakePromise = (url, opts) => {
    captured.push({ url: String(url), opts })
    const spec = respond(String(url), opts)
    if (spec.error !== undefined) return Promise.reject(spec.error)
    return Promise.resolve({ body: bodyOf(spec), statusCode: 200, headers: {}, timings: { phases: {} } })
  }
  const orig = { post: gotModule.post, get: gotModule.get, stream: gotModule.stream }
  gotModule.stream = Object.assign((url, opts) => makeStream(url, opts), { post: makeStream, get: makeStream })
  gotModule.post = fakePromise
  gotModule.get = fakePromise
  return { capture: captured, restore: () => { Object.assign(gotModule, orig) } }
}

// 捕获 console.log/warn（生产各通道只靠日志区分「一对一/一对多」「异常」与「成功」）
function captureLogs () {
  const origLog = console.log
  const origWarn = console.warn
  const logs = []
  const warns = []
  console.log = (...a) => logs.push(a.map(x => String(x)).join(' '))
  console.warn = (...a) => warns.push(a.map(x => String(x)).join(' '))
  return { logs, warns, restore: () => { console.log = origLog; console.warn = origWarn } }
}

// 关于「response 对象本身读 statusCode 就抛」这种形态：实测会让生产的 catch 处理器自己再抛
// （channelError 读同一个 resp），异常冒出传输回调。真实 got 的 statusCode 是普通数值，构造不出该形态
// ⇒ 判为「实际不可达的防御性脆弱点」，不写考题（写了只考我自己造的演员），已记入 PR 交底清单。

// 业务体字段读取即抛（与 test_notify.js 的 malformedResponse 同口径：脏的是【响应内容】，不是 got 的 response）。
// 必须走 got.post 的 promise 回退路径才保得住 getter：streamRequest 走 JSON.parse(Buffer)，
// 解析出来必然是普通对象、造不出 getter；而 $.post 的 `try { body = JSON.parse(res.body) } catch {}`
// 在 res.body 非字符串时保留原对象（生产注释 :343-344 明确说这是给测试替身留的回退路径）。
function brokenBody () {
  return { get code () { throw new Error('业务码字段不可读') }, get message () { throw new Error('文案字段不可读') } }
}

// 只装 promise 桩、把 got.stream 摘掉 ⇒ canStreamRequest()(:350) 为假 ⇒ 生产走 :407 的 promise 回退分支
// （:405-421 那一支；`$.get` 的对称分支已随 v3.279 删除，故此处不再有成对的两个回退分支）。
// restore 必须把 stream 原样放回，否则同进程后续套件全部改走 promise 路径（覆盖口径被悄悄换掉）。
function mockTransportPromiseOnly (respond) {
  const captured = []
  const orig = { post: gotModule.post, get: gotModule.get, stream: gotModule.stream }
  const fake = (url, opts) => {
    captured.push({ url: String(url), opts })
    const spec = respond(String(url), opts)
    if (spec.error !== undefined) return Promise.reject(spec.error)
    return Promise.resolve({ body: spec.body, statusCode: 200, headers: {}, timings: { phases: {} } })
  }
  gotModule.stream = undefined
  gotModule.post = fake
  gotModule.get = fake
  return { capture: captured, restore: () => { Object.assign(gotModule, orig) } }
}

// --- SN-01：Server酱 title 32 字符上限 + 末尾高代理退一位（:518）---
// 变异对照：删掉 `if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1)` ⇒ 截断留下孤立高代理
// ⇒ encodeURIComponent 抛 URIError ⇒ 本用例（断言通道成功）当场红。
checkS('SN-01 Server酱: 标题>32 且第 32 位落在代理对中间时必须退位（不得留孤立高代理）', async () => {
  const restore = isolateChannel({ PUSH_KEY: 'SCTfakekey' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ errno: 0 }) }))
  try {
    const res = await sendNotify('a'.repeat(31) + '🌟', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['server酱'], 'Server酱 应成功送达')
    assert.strictEqual(got1.capture.length, 1, '必须发出 1 次请求')
    const form = new URLSearchParams(String(got1.capture[0].opts.body))
    const sent = form.get('text') || ''
    assert.strictEqual(sent.length, 31, `标题必须截到完整代理对之前（31 字符），实际 ${sent.length}`)
    const last = sent.charCodeAt(sent.length - 1)
    assert.ok(!(last >= 0xD800 && last <= 0xDBFF), '末尾不得是孤立高代理')
  } finally { got1.restore(); restore() }
})

// --- SN-02：Server酱·Turbo 版把 errno 嵌在 data 里（:544 嵌套回退）---
checkS('SN-02 Server酱: errno 只在 data.data 内层时也必须按成功判（Turbo 响应形状）', async () => {
  const restore = isolateChannel({ PUSH_KEY: 'SCTfakekey' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ data: { errno: 0 }, errmsg: 'ok' }) }))
  const log1 = captureLogs()
  try {
    const res = await sendNotify('嵌套成功', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['server酱'], '内层 errno=0 必须判成功（不得回退外层 undefined 而 reject）')
    assert.strictEqual(res.failures.length, 0, '不得记失败')
  } finally { log1.restore(); got1.restore(); restore() }
})

// --- SN-03：1024=一分钟内重复内容，消息已送达 ⇒ 视为成功不 reject（:547 数字/字符串两侧 + :550 分支）---
// 判错的后果不对称：把 1024 当失败 ⇒ 不写缓存 ⇒ 每轮重推、有效设备被反复轰炸。
checkS('SN-03 Server酱: errno 1024（数字与字符串两种序列化）视为已送达，不得 reject', async () => {
  for (const raw of [1024, '1024']) {
    const restore = isolateChannel({ PUSH_KEY: 'SCTfakekey' })
    const got1 = mockTransport(() => ({ body: JSON.stringify({ errno: raw, errmsg: '此内容一分钟内已发送过' }) }))
    const log1 = captureLogs()
    try {
      const res = await sendNotify('重复内容', '正文')
      assert.deepStrictEqual(res.successfulChannels, ['server酱'], `errno=${JSON.stringify(raw)} 必须视为送达（不 reject）`)
      assert.ok(log1.logs.some(l => l.includes('异常')), '仍要打出异常日志（内容重复不是成功推送新内容）')
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

// --- SN-04 / SN-06：业务体字段读取即抛必须按通道失败（bark catch :656 / pushme catch :734）---
// 走 promise 回退路径才保得住 getter（见上方 brokenBody 注释），顺带覆盖 :407-423 的回退分支。
// 判错的后果是虚假成功：主流程写缓存 ⇒ 消息永久丢失（v3.180 那起 P1 的同族）。
for (const [label, cfg, key] of [['SN-04 Bark', { BARK_PUSH: 'dev1' }, 'bark'], ['SN-06 PushMe', { PUSHME_KEY: 'pmkey1' }, 'pushme']]) {
  checkS(`${label}: 响应业务体字段抛异常时不得被记成成功（catch 必须按通道失败）`, async () => {
    const restore = isolateChannel(cfg)
    const got1 = mockTransportPromiseOnly(() => ({ body: brokenBody() }))
    try {
      let threw = null
      try { await sendNotify('结构异常探针', '正文') } catch (e) { threw = e }
      assert.ok(threw, `${key} 必须失败上抛（业务体不可读不得虚假成功）`)
      assert.ok(Array.isArray(threw.failures) && threw.failures.some(f => f && f.channel === key),
        `failures 必须点名 ${key}，实际: ${JSON.stringify(threw.failures)}`)
      // 下钻逐 key 根因：catch 体被清空时 finally 只给 {ok:false}（无 error），聚合层 channel 仍在
      // 但内层 failures 为空——只断聚合层会漏（清空 catch 体仍绿）。bark 侧另有 SNB-05，此处把
      // pushme 侧补齐，两通道同口径。
      const agg = threw.failures.find(f => f && f.channel === key)
      assert.ok(agg && Array.isArray(agg.failures) && agg.failures.length === 1,
        `${key} catch 必须留下 1 条逐 key 根因，实际 ${JSON.stringify(agg && agg.failures)}`)
      assert.ok(agg.failures[0].channel === key && /不可读/.test(agg.failures[0].message),
        `${key} 根因必须点名并保留原始异常文案，实际 ${JSON.stringify(agg.failures[0])}`)
      assert.ok(!threw.successfulChannels || !threw.successfulChannels.includes(key),
        `${key} 不得出现在成功通道里`)
    } finally { got1.restore(); restore() }
  })
}

// --- SN-05：PushMe 业务码取值优先级（:726 data.code 缺省时回退 error_code / errno）---
// 层级契约：单 key 全失败时外层是 aggregateChannelError（code=CHANNEL_PUSHME_FAILED），
// 逐 key 的 channelError（带 providerCode）在它的 failures 里——读错层就看不到业务码。
function unwrapChannelFailures (threw, channel) {
  const agg = threw.failures[0]
  assert.strictEqual(agg.channel, channel, `${channel} 聚合失败记录必须带通道名`)
  assert.strictEqual(agg.code, `CHANNEL_${channel.toUpperCase()}_FAILED`, `${channel} 全部 key 失败必须给聚合错误码`)
  assert.ok(Array.isArray(agg.failures) && agg.failures.length >= 1, `${channel} 聚合错误必须逐 key 留痕`)
  return agg.failures[0]
}

checkS('SN-05 PushMe: 响应无 code 时 providerCode 取 error_code（再退 errno），不得丢业务码', async () => {
  const restore = isolateChannel({ PUSHME_KEY: 'pmkey1' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ error_code: 4001, message: 'invalid key' }) }))
  try {
    let threw = null
    try { await sendNotify('业务码探针', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'PushMe 非 success 响应必须失败')
    const inner = unwrapChannelFailures(threw, 'pushme')
    assert.strictEqual(inner.providerCode, 4001, `providerCode 必须回退到 error_code，实际 ${JSON.stringify(inner.providerCode)}`)
  } finally { got1.restore(); restore() }
  const restore2 = isolateChannel({ PUSHME_KEY: 'pmkey2' })
  const got2 = mockTransport(() => ({ body: JSON.stringify({ errno: 5, message: 'rate' }) }))
  try {
    let threw = null
    try { await sendNotify('业务码探针2', '正文') } catch (e) { threw = e }
    const inner = unwrapChannelFailures(threw, 'pushme')
    assert.strictEqual(inner.providerCode, 5, 'error_code 也缺时必须退到 errno')
  } finally { got2.restore(); restore2() }
})

// --- SN-07 / SN-08：企业微信端点可覆盖 + desp 为空时正文只取标题（:760 / :767）---
checkS('SN-07 企业微信: QYWX_ORIGIN 自定义端点必须去尾斜杠拼接（不得出现 //cgi-bin）', async () => {
  const restore = isolateChannel({ QYWX_KEY: 'qykey', QYWX_ORIGIN: 'https://qy.example.com///' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ errcode: 0, errmsg: 'ok' }) }))
  try {
    const res = await sendNotify('企微端点', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['企业微信'], 'errcode=0 判成功')
    const url = got1.capture[0].url
    assert.ok(url.startsWith('https://qy.example.com/cgi-bin/webhook/send'), `端点必须去尾斜杠，实际 ${url}`)
    assert.ok(url.includes('key=qykey'), 'key 必须进 query')
  } finally { got1.restore(); restore() }
})

checkS('SN-08 企业微信: desp 为空时 content 只取标题（不拼出「标题\\n\\nundefined」残尾）', async () => {
  const restore = isolateChannel({ QYWX_KEY: 'qykey' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ errcode: 0 }) }))
  try {
    await sendNotify('只有标题', '')
    const content = got1.capture[0].opts.json.markdown.content
    assert.strictEqual(content, '只有标题', `正文必须只等于标题，实际 ${JSON.stringify(content)}`)
    assert.ok(!content.includes('\n\n'), '不得出现拼接分隔符')
  } finally { got1.restore(); restore() }
})

// --- SN-09：WX_pusher_channels 是不可序列化形状（循环引用）⇒ 缓存键退位、解析继续（:846）---
checkS('SN-09 WxPusher: 多应用配置循环引用不得抛穿，必须回退旧字段并显形告警', async () => {
  const circular = { self: null }
  circular.self = circular // 对象形状（不是数组）⇒ 既撞 :846 的不可序列化 catch，也撞「不是数组」告警
  const restore = isolateChannel({ WX_pusher_appToken: 'APT_fake', WX_pusher_topicIds: 'T1', WX_pusher_channels: circular })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 1000 }) }))
  const log1 = captureLogs()
  try {
    const res = await sendNotify('循环配置探针', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['wxpusher'], '必须回退 WX_pusher_appToken 完成发送，不得因配置形状崩掉')
    assert.ok(log1.warns.some(w => w.includes('不是数组')), `必须显形「多应用配置被忽略」，实际: ${JSON.stringify(log1.warns)}`)
  } finally { log1.restore(); got1.restore(); restore() }
})

// --- SN-10：配置值「已配置」谓词的 String() 抛错兜底（:911 / :915）---
// 这条直接钉住注释里那起 P1：自检把脏值算成「已配置」而主流程 NO_CHANNEL_CONFIG ⇒ 全程漏推且零告警。
// 导出的 configuredChannelCount / configuredChannelNames 与 sendNotify 共用同一对谓词 ⇒ 可直调、进程内。
checkS('SN-10 通道自检: 配置值 String() 抛异常必须判「未配置」且不抛穿（自检与主流程同口径）', () => {
  const throwing = { toString () { throw new Error('脏配置不可字符串化') } }
  const restore = isolateChannel({ QYWX_KEY: throwing, PUSHME_KEY: throwing, WX_XIZHI_KEY: 'https://xizhi.fake/k' })
  try {
    assert.strictEqual(configuredChannelCount(), 1, '抛错的脏值不得计入已配置通道（只剩息知）')
    assert.deepStrictEqual(configuredChannelNames(), ['息知'], '自检清单不得包含脏值通道')
  } finally { restore() }
})

// --- SN-22：息知 providerCode 回退 errcode（:1201）---
checkS('SN-22 息知: 响应无 code 时 providerCode 取 errcode（业务码不得丢）', async () => {
  const restore = isolateChannel({ WX_XIZHI_KEY: 'https://xizhi.fake/k' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ errcode: 500, msg: '内部错误' }) }))
  try {
    let threw = null
    try { await sendNotify('息知业务码', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'errcode≠200 必须 reject')
    assert.strictEqual(threw.failures[0].providerCode, 500, `providerCode 必须回退 errcode，实际 ${JSON.stringify(threw.failures[0].providerCode)}`)
  } finally { got1.restore(); restore() }
})

// --- SN-23：Telegram 正文为空时只发标题（:1297 三元另一侧）---
checkS('SN-23 Telegram: desp 为空时 text 不含分隔符残尾', async () => {
  const restore = isolateChannel({ TG_BOT_TOKEN: 'TOK', TG_USER_ID: '42' })
  const got1 = mockTransport(() => ({ body: JSON.stringify({ ok: true }) }))
  try {
    await sendNotify('TG只有标题', '')
    assert.strictEqual(got1.capture[0].opts.json.text, 'TG只有标题', '正文空时只发标题')
  } finally { got1.restore(); restore() }
})

// --- SN-24：Push+「一对一/一对多」文案随 PUSH_PLUS_USER 变化（:463/:473/:478 三处日志三元）---
checkS('SN-24 Push+: PUSH_PLUS_USER 存在时三处日志都必须是「一对多」，缺省时都是「一对一」', async () => {
  const cases = [
    ['成功', () => ({ body: JSON.stringify({ code: 200 }) }), /完成/],
    ['异常', () => ({ body: JSON.stringify({ code: 500, msg: '失败' }) }), /异常/],
    ['失败', () => ({ error: new Error('连接被拒') }), /失败/]
  ]
  for (const [label, spec, re] of cases) {
    for (const who of ['一对多', '一对一']) {
      const restore = isolateChannel(who === '一对多'
        ? { PUSH_PLUS_TOKEN: 'PPT_fake', PUSH_PLUS_USER: 'U1' }
        : { PUSH_PLUS_TOKEN: 'PPT_fake' })
      const got1 = mockTransport(spec)
      const log1 = captureLogs()
      try {
        let swallowed = null
        try { await sendNotify('文案探针', '正文') } catch (e) { swallowed = e }
        // 上抛的聚合消息只作**排障线索**，不进被匹配的语料：它自带「所有推送通道失败」，
        // 混进 logs 后 /失败/ 那条断言会被自己注入的行满足（半自证，实测削弱判红面）。
        const threwHint = swallowed ? ` | 上抛: ${swallowed.message || String(swallowed)}` : ''
        const hit = log1.logs.filter(l => re.test(l))
        assert.ok(hit.length > 0, `Push+ ${label}路径（who=${who}）必须打日志，实际: ${JSON.stringify(log1.logs)}${threwHint}`)
        assert.ok(hit.some(l => l.includes(who)), `Push+ ${label}日志应含「${who}」，实际: ${JSON.stringify(hit)}${threwHint}`)
        assert.ok(!hit.some(l => l.includes(who === '一对多' ? '一对一' : '一对多')), '不得同时出现相反文案')
      } finally { log1.restore(); got1.restore(); restore() }
    }
  }
})

// ===== SN-11…SN-21：WxPusher 限频判定 / 时间窗 / profile 统计 / 通道任务异常归因 =====
// 这一簇是「改错了会怎样」最直观的地方：限流判定反转 ⇒ 要么疯狂重试刷屏，要么一次都不重试。
// WxPusher 多应用用唯一 appToken，profile 统计 Map 模块级不可清空 ⇒ 按 token 取自己的条目做绝对断言。
const WX_OK = () => ({ body: JSON.stringify({ code: 1000 }) })

checkS('SN-11 WxPusher: 取消（code=ABORT_ERR / name=AbortError）不得被文本规则自匹配成限频而继续换下一个应用', async () => {
  for (const [label, mkErr, checkCancel] of [
    ['code=ABORT_ERR', () => Object.assign(new Error('WxPusher 限频等待已取消'), { code: 'ABORT_ERR' }), (f) => assert.strictEqual(f.code, 'ABORT_ERR', '取消错误码必须原样透出')],
    ['name=AbortError', () => Object.assign(new Error('WxPusher 限频等待已取消'), { name: 'AbortError' }), (f) => assert.ok(/已取消/.test(f.message), '取消文案必须保留（不得换成 1001 限频摘要）')]
  ]) {
    const restore = isolateChannel({
      WX_pusher_channels: [{ appToken: 'APT_SNC11A_' + label, topicIds: ['T1'] }, { appToken: 'APT_SNC11B_' + label, topicIds: ['T2'] }]
    })
    const got1 = mockTransport(() => ({ error: mkErr() }))
    try {
      let threw = null
      try { await sendNotify('取消探针', '正文') } catch (e) { threw = e }
      assert.ok(threw, '取消必须上抛')
      assert.strictEqual(got1.capture.length, 1, `${label} 必须短路只发 1 次（判成限频会逐个换应用重发），实际 ${got1.capture.length} 次`)
      assert.strictEqual(threw.code, 'ALL_CHANNELS_FAILED', '唯一通道失败要走汇总上抛')
      checkCancel(threw.failures[0])
    } finally { got1.restore(); restore() }
  }
})

checkS('SN-12 WxPusher: 错误无 message 时仍须按 err 本身的文本判定 1001（换备用应用，不得一次都不重试）', async () => {
  const restore = isolateChannel({
    WX_pusher_channels: [{ appToken: 'APT_SNC12A', topicIds: ['T1'] }, { appToken: 'APT_SNC12B', topicIds: ['T2'] }]
  })
  const rateErr = Object.assign(new Error(''), { toString: () => 'upstream 1001 速度太快' })
  let n = 0
  const got1 = mockTransport(() => (++n === 1 ? { error: rateErr } : WX_OK()))
  try {
    const res = await sendNotify('无 message 限频', '正文')
    assert.strictEqual(n, 2, '首个应用被判限频后必须换下一个应用（判不出来就直接一次不重试）')
    assert.deepStrictEqual(res.successfulChannels, ['wxpusher'], '第二个应用应成功')
  } finally { got1.restore(); restore() }
})

checkS('SN-13 WxPusher: XBK_PROFILE=2 时打逐次日志但不写聚合统计（统计只在 3 档记录）', async () => {
  // 关键：统计 Map 是模块级、跨档位持续存在 ⇒ 必须切回 3 档再读，才能证明 2 档那次运行真的没写进去。
  // （先前我直接在 2 档读 getWxPusherProfileSummary()——它自己第一行就是同一道 !== '3' 的门，
  //  永远返回 [] ⇒ 这条断言在「门被删掉」时照样绿 ⇒ 是废题，已按可观测方式重写。）
  const restore = isolateChannel({ WX_pusher_appToken: 'APT_SNC13', WX_pusher_topicIds: 'T1' })
  const got1 = mockTransport(WX_OK)
  const log1 = captureLogs()
  const origProfile = process.env.XBK_PROFILE
  process.env.XBK_PROFILE = '2'
  try {
    await sendNotify('profile2', '正文')
    assert.ok(log1.logs.some(l => l.includes('[profile wxpusher]') && l.includes('outcome=success')), '2 档必须打逐次日志')
    process.env.XBK_PROFILE = '3'
    assert.ok(!getWxPusherProfileSummary().some(s => s.app === maskKey('APT_SNC13')), '2 档的运行不得在 3 档统计里留下条目')
  } finally {
    if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    log1.restore(); got1.restore(); restore()
  }
})

checkS('SN-14 WxPusher: XBK_PROFILE=3 的四种 outcome 分类计数必须各归各位', async () => {
  const restore = isolateChannel({ WX_pusher_appToken: 'APT_SNC14', WX_pusher_topicIds: 'T1' })
  const log1 = captureLogs()
  const origProfile = process.env.XBK_PROFILE
  process.env.XBK_PROFILE = '3'
  const scripted = [WX_OK, () => ({ body: JSON.stringify({ code: 1001 }) }), () => ({ error: new Error('连接中断') }), () => ({ body: JSON.stringify({ code: 500 }) })]
  const got1 = mockTransport(() => scripted[Math.min(got1.capture.length - 1, scripted.length - 1)]())
  try {
    for (let i = 0; i < scripted.length; i++) {
      try { await sendNotify('profile3-' + i, '正文') } catch (e) { /* 失败轮次预期上抛 */ }
    }
    const stat = getWxPusherProfileSummary().find(s => s.app === maskKey('APT_SNC14'))
    assert.ok(stat, '3 档必须记录该应用的统计条目')
    assert.deepStrictEqual(
      [stat.attempts, stat.success, stat.failed, stat.rateLimited, stat.networkError, stat.apiError],
      [4, 1, 3, 1, 1, 1],
      `四类 outcome 计数必须分别为 attempts=4/success=1/failed=3/rateLimited=1/networkError=1/apiError=1，实际 ${JSON.stringify(stat)}`
    )
  } finally {
    if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    log1.restore(); got1.restore(); restore()
  }
})

checkS('SN-15 WxPusher: 非 3 档调用 printWxPusherProfileSummary 必须一字不出（脱敏统计不得混进常规日志）', async () => {
  // 自播种：统计 Map 是模块级、不可清空，print 的早退条件是 `!== '3' || size === 0` 两个。
  // 只测「非 3 档一字不出」而**不先保证 Map 非空**，判红就依赖别的用例留下的残留——
  // 实测（本 PR 评审）：全新进程里把 `!== '3'` 那道门删掉，size===0 仍先兜住 ⇒ 本条照样绿。
  // 所以这里先自己在 3 档跑一轮，确保「Map 非空」是本用例造成的，档位门一坏就必然显形。
  const origProfile = process.env.XBK_PROFILE
  const restore = isolateChannel({ WX_pusher_appToken: 'APT_SNC15', WX_pusher_topicIds: 'T1' })
  const got1 = mockTransport(WX_OK)
  const log1 = captureLogs()
  try {
    process.env.XBK_PROFILE = '3'
    await sendNotify('播种-3档', '正文')
    const seeded = getWxPusherProfileSummary().filter(s => s.app === maskKey('APT_SNC15'))
    assert.strictEqual(seeded.length, 1, `前置播种必须真的写进 3 档统计（否则下面的断言是空转），实际 ${JSON.stringify(seeded)}`)
    assert.strictEqual(got1.capture.length, 1, '播种轮应发出 1 次请求')
    // 切到非 3 档再调 print：统计已非空，此时**只可能**是档位门让它闭嘴。
    delete process.env.XBK_PROFILE
    log1.logs.length = 0
    printWxPusherProfileSummary()
    assert.strictEqual(log1.logs.length, 0, `未开 3 档时不得输出任何 summary 行，实际: ${JSON.stringify(log1.logs)}`)
    // 同一非空统计在 3 档下必须打出来——反向对照，证明上一条不是「反正都不打」的废题
    process.env.XBK_PROFILE = '3'
    printWxPusherProfileSummary()
    assert.ok(log1.logs.some(l => l.includes('[profile wxpusher summary]')),
      `3 档且统计非空时必须输出，实际: ${JSON.stringify(log1.logs)}`)
  } finally {
    if (origProfile === undefined) delete process.env.XBK_PROFILE; else process.env.XBK_PROFILE = origProfile
    log1.restore(); got1.restore(); restore()
  }
})

checkS('SN-16 WxPusher: 10 秒窗口过期后必须腾出名额（不得因未清理的时间戳把自己锁死）', async () => {
  const restore = isolateChannel({ WX_pusher_appToken: 'APT_SNC16', WX_pusher_topicIds: 'T1' })
  const log1 = captureLogs()
  const got1 = mockTransport(WX_OK)
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  // 取消句柄：清理支被删掉时，下面那次「第 20 次」不是慢，而是**永远排不到名额**。
  // 有界 race 只让**断言**在 1.5s 变红，被放弃的那个 promise 仍在以 20ms 一轮的速度空转
  // ⇒ 事件循环永不排空、进程不退出（实测：红是红了，但要挂到 run_unit_tests 的 10min 超时，
  //   TAP 档下还会被 tap-runner 记成 RuntimeError 触发段级 fail-closed）。
  // 所以必须自己收尾：finally 里 abort，让那个泄漏的等待在循环顶撞上 signal.aborted 立即抛掉。
  const ac = new AbortController()
  try {
    for (let i = 0; i < 19; i++) await sendNotify('填窗口-' + i, '正文')
    assert.strictEqual(got1.capture.length, 19, '窗口内应发出 19 次')
    offset = 15000 // 跨过 WXPUSHER_WINDOW_MS(10s)：旧时间戳必须被清理，否则本轮永远排不到名额
    // 用有界 race：清理被删掉时这一轮不是「慢」而是永远排不到 ⇒ 让它 1.5s 就判红，而不是拖到套件看门狗。
    const done = sendNotify('窗口过期后', '正文', { signal: ac.signal }).then(() => 'done', (e) => 'failed: ' + (e && e.message))
    const settled = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve('stuck'), 1500))])
    assert.strictEqual(settled, 'done', `过期后第 20 次必须立刻排到名额，实际 ${settled}`)
    assert.strictEqual(got1.capture.length, 20, '窗口过期清理后必须真的发出第 20 次请求')
  } finally {
    ac.abort() // 收尾泄漏的在飞等待（判红时它已不可能自己结算）
    Date.now = realNow
    log1.restore(); got1.restore(); restore()
  }
})

checkS('SN-17 WxPusher: 重复应用配置在限频后必须停止空转并保留最后一次真实错误', async () => {
  const dup = { appToken: 'APT_SNC17', topicIds: ['T1'] }
  const restore = isolateChannel({ WX_pusher_channels: [dup, { ...dup }] })
  const log1 = captureLogs()
  const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 1001, msg: '速度太快' }) }))
  try {
    let threw = null
    try { await sendNotify('重复应用限频', '正文') } catch (e) { threw = e }
    assert.ok(threw, '全部应用都试过仍限频必须上抛')
    assert.strictEqual(got1.capture.length, 1, '同一 appToken+topicIds 的重复项不得被当成「另一个备用应用」反复发（重复轰炸）')
    const inner = threw.failures[0]
    assert.strictEqual(inner.channel, 'wxpusher', '失败记录必须点名 wxpusher')
    assert.strictEqual(String(inner.providerCode), '1001', `必须保留最后一次限频业务码，实际 ${JSON.stringify(inner.providerCode)}`)
    assert.ok(inner.message.includes('速度太快'), `不得退化成无信息量的兜底文案，实际 ${inner.message}`)
  } finally { log1.restore(); got1.restore(); restore() }
})

// SN-18：通道内部抛异常时的「部分成功 + 在飞清单摘除」契约。
// 实测更正（写这条之前我以为能测 :1569 的同步抛 catch）：所有通道函数都以 `return new Promise(executor)` 开头，
// 而 executor 里的抛错被 Promise 构造器**转成 rejection**，`task()` 根本不会同步抛出
// ⇒ :1569 的 `try { running = task() } catch` 在当前调用图里不可达（已列入交底清单，不为它编断言）。
// 这条改测真语义：某通道自身异常只让该通道失败，其他通道照常成功，且失败通道必须从在飞清单摘掉
// （留着会让 Pusher 的 10s 超时归因把已结算通道也算成 PUSH_TIMEOUT）。
checkS('SN-18 sendNotify: 通道自身抛异常只算该通道失败，不得影响其他通道，且必须从在飞清单摘掉', async () => {
  let reads = 0
  const restore = isolateChannel({ PUSH_PLUS_TOKEN: 'PPT_once', WX_XIZHI_KEY: 'https://xizhi.fake/k' })
  Object.defineProperty(push_config, 'PUSH_PLUS_TOKEN', {
    configurable: true,
    get () { if (reads++ > 0) throw new Error('脏配置读取失败'); return 'PPT_once' }
  })
  const log1 = captureLogs()
  const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
  const tracker = {}
  try {
    let threw = null
    let res = null
    try { res = await sendNotify('通道内部异常探针', '正文', { inFlightTracker: tracker }) } catch (e) { threw = e }
    assert.ok(!threw, `一通道异常 + 一通道成功 = 部分成功，不得整体抛错，实际 ${threw && threw.message}`)
    assert.deepStrictEqual(res.successfulChannels, ['息知'], '健康通道必须照常成功')
    assert.strictEqual(res.failures[0].channel, 'pushplus', '异常通道必须记为失败并点名')
    assert.ok(/脏配置读取失败/.test(res.failures[0].message), `失败原因必须保留根因，实际 ${res.failures[0].message}`)
    assert.deepStrictEqual(tracker.pending, [], `已结算通道必须全部从在飞清单摘掉，实际 ${JSON.stringify(tracker.pending)}`)
    assert.strictEqual(got1.capture.length, 1, '异常通道不得发出请求（只有息知发一次）')
  } finally {
    delete push_config.PUSH_PLUS_TOKEN
    log1.restore(); got1.restore(); restore()
  }
})

checkS('SN-20 失败归因: reason 的结构化字段读取抛异常时只保留安全消息，不得抛穿汇总', async () => {
  const hostile = { message: '上游返回异常', code: 'ECONNRESET', get providerCode () { throw new Error('字段不可读') } }
  const restore = isolateChannel({ PUSH_KEY: 'SCTfakekey' })
  const log1 = captureLogs()
  const got1 = mockTransport(() => ({ error: hostile }))
  try {
    let threw = null
    try { await sendNotify('异常字段探针', '正文') } catch (e) { threw = e }
    assert.ok(threw, '通道失败必须上抛')
    assert.strictEqual(threw.code, 'ALL_CHANNELS_FAILED', `必须走正常汇总而不是被字段异常炸穿，实际 code=${threw && threw.code} msg=${threw && threw.message}`)
    assert.strictEqual(threw.failures[0].message, '上游返回异常', '失败记录必须保留安全消息')
    assert.strictEqual(threw.failures[0].channel, 'server酱', '失败记录必须带通道名')
  } finally { log1.restore(); got1.restore(); restore() }
})

checkS('SN-21 入口清洗: text/desp 为 undefined/null 或 String() 抛异常时都必须按空串继续，不得抛穿', async () => {
  for (const [label, bad] of [['undefined', undefined], ['null', null], ['String() 抛', { toString () { throw new Error('不可字符串化') } }]]) {
    const restore = isolateChannel({ BARK_PUSH: 'dev_snc21' })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
    try {
      const res = await sendNotify(bad, bad)
      assert.deepStrictEqual(res.successfulChannels, ['bark'], `${label} 必须清洗成空串后照常发送`)
      assert.strictEqual(got1.capture[0].opts.json.title, '', `${label} 时 title 必须是空串，实际 ${JSON.stringify(got1.capture[0].opts.json.title)}`)
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

// ===== SNB 簇（g12 第三批）：Bark 通道剩余存活变异体 =====
// 依据：子代理用仓库自带 @stryker-mutator/instrumenter **真实枚举** barkNotify(:579-674) 的 80 个变异体
// 与 requestExtras(:25-27) 的 7 个，逐个喂给已提交的四套件 ⇒ barkNotify 32 个存活、requestExtras 6 个存活。
// 本簇吃掉其中 7 组；杀不掉的等价/不可达变异体在文件末尾的登记注释里说明，不伪造断言。
// 另：SN-04 的判据止于聚合层（实测把 catch 体清空后，finally 的 innerResolve({ok:false}) 仍让 SN-04 绿）
//     ⇒ SNB-05 把断言下钻到「逐设备根因」那一层补上这个缺口。

checkS('SNB-01 Bark: 设备码切分——空段丢弃、每段 trim，请求条数与非空段条数严格一致', async () => {
  const cases = [
    [' d1 ## d2 ', ['https://api.day.app/d1', 'https://api.day.app/d2']],
    ['  https://api.day.app/D3  ', ['https://api.day.app/D3']],
    ['d1#  #d2', ['https://api.day.app/d1', 'https://api.day.app/d2']]
  ]
  for (const [raw, urls] of cases) {
    const restore = isolateChannel({ BARK_PUSH: raw })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
    try {
      const res = await sendNotify('切分探针', '正文')
      assert.deepStrictEqual(got1.capture.map(c => c.url), urls, `配置 ${JSON.stringify(raw)} 的请求 URL 集合不符（filter/trim 被掏空就会多请求或带空格）`)
      assert.deepStrictEqual(res.successfulChannels, ['bark'], `配置 ${JSON.stringify(raw)} 应判通道成功`)
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

checkS('SNB-02 Bark: 端点协议判定——自建 http 与大写 HTTPS 原样保留，只有裸设备码才补 api.day.app 前缀', async () => {
  const cases = [
    // 自建端点用主机名 + .invalid 保留域（RFC 6761：永不解析），既测「http 也原样保留」，
    // 又不写死内网 IP 字面量（Sonar 的安全那条线会点硬编码 IP）。
    'http://bark-selfhost.invalid:8080/DevKey1234', // NOSONAR —— 本条用例测的就是「非加密 http 自建端点必须原样保留」，换成 https 等于删掉被测语义（S5332 的告警在这里是数据形态，不是缺陷）
    'HTTPS://api.day.app/DevKey1234',
    'xhttp://api.day.app/dk',
    'dev1'
  ]
  for (const raw of cases) {
    const restore = isolateChannel({ BARK_PUSH: raw })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
    try {
      await sendNotify('协议判定探针', '正文')
      assert.strictEqual(got1.capture.length, 1, `配置 ${raw} 必须恰好发一次`)
      const expect = /^https?:\/\//i.test(raw) ? raw : `https://api.day.app/${raw}`
      assert.strictEqual(got1.capture[0].url, expect, `配置 ${raw} 的端点判定错（锚点 ^ 或 s? 改动、取反都会在此变红）`)
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

checkS('SNB-06 Bark: 调用方 AbortSignal 必须原样交给传输层；未传时不得出现该键（顺带钉 headers/timeout/内部选项不漏）', async () => {
  // 轮1：带 signal —— 必须是同一个引用（取消能否生效的唯一通路）
  const ac = new AbortController()
  {
    const restore = isolateChannel({ BARK_PUSH: 'dev_snb06' })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
    try {
      await sendNotify('signal 透传', '正文', { signal: ac.signal, inFlightTracker: {} })
      const opts = got1.capture[0].opts
      assert.strictEqual(opts.signal, ac.signal, 'signal 必须原样（同引用）交给传输层；删掉透传这一路无人变红')
      assert.strictEqual(opts.headers['Content-Type'], 'application/json', 'Bark 必须显式 application/json（headers 对象被清空在此变红）')
      assert.strictEqual(opts.timeout, 15000, '超时形态契约')
      assert.strictEqual('signal' in opts.json, false, 'signal 不得进第三方 JSON body')
      assert.strictEqual('inFlightTracker' in opts, false, '内部选项不得漏进传输选项')
    } finally { log1.restore(); got1.restore(); restore() }
  }
  // 轮2：脏 params（读 signal 就抛）⇒ requestExtras 的 try/catch 必须兜住，照常发送
  {
    const restore = isolateChannel({ BARK_PUSH: 'dev_snb06' })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
    try {
      const res = await sendNotify('脏 params', '正文', { get signal () { throw new Error('脏 params') } })
      assert.deepStrictEqual(res.successfulChannels, ['bark'], '脏 params 不得影响发送（try/catch 被掏空则整条通道抛穿）')
      assert.strictEqual(got1.capture.length, 1, '仍恰好发一次')
    } finally { log1.restore(); got1.restore(); restore() }
  }
  // 轮3：只传内部选项 ⇒ 传输选项里不得凭空出现 signal 键
  {
    const restore = isolateChannel({ BARK_PUSH: 'dev_snb06' })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 200 }) }))
    try {
      await sendNotify('无 signal', '正文', { inFlightTracker: {} })
      assert.strictEqual('signal' in got1.capture[0].opts, false, '未传 signal 时不得注入该键（写成 {signal: undefined} 会让取消语义变成永不取消）')
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

checkS('SNB-03 Bark: 响应不是 JSON（代理回 HTML）时按业务失败，兜底文案逐字且不得把响应体塞进 message', async () => {
  const restore = isolateChannel({ BARK_PUSH: 'https://api.day.app/DevKey12345' })
  const log1 = captureLogs()
  // 流式路径 JSON.parse 失败时保留原始字符串（:390-393 的刻意行为）⇒ data 是个 HTML 字符串
  const got1 = mockTransport(() => ({ body: '<html>Bad Gateway DevKey12345</html>' }))
  try {
    let threw = null
    try { await sendNotify('HTML 响应', '正文') } catch (e) { threw = e }
    assert.ok(threw, 'HTTP 200 但响应不是业务成功码必须失败')
    const inner = threw.failures[0].failures[0]
    assert.ok(inner instanceof Error, '逐设备失败必须是 Error 实例')
    assert.strictEqual(inner.channel, 'bark', '必须逐设备点名 bark')
    assert.strictEqual(inner.message, 'Bark 发送失败', '无 message 字段时必须用兜底文案（把响应体当文案会在此变红）')
    assert.strictEqual('providerCode' in inner, false, '响应体没有 code 字段时不得造 providerCode')
    assert.strictEqual(inner.statusCode, 200, 'statusCode 取自 response 形参')
    assert.ok(!inner.message.includes('Bad Gateway') && !inner.message.includes('DevKey12345'), '异常响应体不得进 message（可能回显密钥）')
  } finally { log1.restore(); got1.restore(); restore() }
})

checkS('SNB-04 Bark: 传输错误（无 response）必须逐设备点名且不得重发', async () => {
  const restore = isolateChannel({ BARK_PUSH: 'dev_snb04' })
  const log1 = captureLogs()
  const got1 = mockTransport(() => ({ error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))
  try {
    let threw = null
    try { await sendNotify('传输失败', '正文') } catch (e) { threw = e }
    assert.ok(threw, '传输失败必须上抛')
    assert.strictEqual(threw.failures[0].code, 'CHANNEL_BARK_FAILED', '聚合层必须给通道码')
    const inner = threw.failures[0].failures[0]
    assert.strictEqual(inner.channel, 'bark', '逐设备失败必须点名 bark（通道名写错在这一层才看得见）')
    assert.strictEqual(inner.code, 'ECONNREFUSED', '传输错误码原样透传')
    assert.strictEqual('statusCode' in inner, false, '错误没有 response 时不得造 statusCode 键')
    assert.strictEqual(got1.capture.length, 1, 'Bark 没有重试语义，不得重发')
  } finally { log1.restore(); got1.restore(); restore() }
})

checkS('SNB-05 Bark: catch 分支必须留下逐设备根因（比 SN-04 下钻一层）', async () => {
  const restore = isolateChannel({ BARK_PUSH: 'dev_snb05' })
  const log1 = captureLogs()
  const got1 = mockTransportPromiseOnly(() => ({ body: brokenBody() }))
  try {
    let threw = null
    try { await sendNotify('catch 根因', '正文') } catch (e) { threw = e }
    assert.ok(threw, '业务体不可读必须失败')
    const agg = threw.failures[0]
    assert.strictEqual(agg.failures.length, 1, 'catch 分支必须留下 1 条逐设备根因；清空 catch 体时 finally 只给 {ok:false}（无 error）会被 filter(Boolean) 丢空，这一条就变 0')
    assert.strictEqual(agg.failures[0].channel, 'bark', '根因必须点名 bark')
    assert.ok(/不可读/.test(agg.failures[0].message), `根因必须保留原始异常文案，实际 ${agg.failures[0].message}`)
    assert.strictEqual('providerCode' in agg.failures[0], false, '读不出业务码时不得造键')
  } finally { log1.restore(); got1.restore(); restore() }
})

checkS('SNB-08 Bark: 三行日志逐字 + 端点一律脱敏（query/hash 绝不落日志）', async () => {
  // 成功 / 业务异常 / 传输失败 三条日志模板与 maskUrl 调用点：模板串被掏空（StringLiteral→''）
  // 或脱敏被绕过，都只在日志面上暴露——而日志正是用户排查推送失败的唯一依据。
  const scenarios = [
    ['成功', () => ({ body: JSON.stringify({ code: 200 }) })],
    ['业务异常', () => ({ body: JSON.stringify({ code: 500, message: 'bad key' }) })],
    ['传输失败', () => ({ error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })]
  ]
  for (const [label, spec] of scenarios) {
    const restore = isolateChannel({ BARK_PUSH: 'https://api.day.app/DEVI9999' })
    const log1 = captureLogs()
    const got1 = mockTransport(spec)
    try {
      try { await sendNotify('日志面探针', '正文') } catch (e) { /* 失败场景预期上抛 */ }
      const hit = log1.logs.filter(l => l.includes('Bark APP 发送通知到'))
      assert.ok(hit.length >= 1, `${label} 场景必须打「Bark APP 发送通知到 …」这条日志（模板被掏空在此暴露）`)
      assert.ok(hit.some(l => l.includes('https://api.day.app/DEVI***99')), `${label} 场景端点必须走 maskUrl，实际: ${JSON.stringify(hit)}`)
      assert.ok(!hit.some(l => l.includes('DEVI99')), `${label} 场景不得把完整设备码写进日志`)
    } finally { log1.restore(); got1.restore(); restore() }
  }
  // query/hash 形态：maskUrl 只保留协议+host+脱敏路径，query 与 hash 整段丢弃（防密钥随日志外泄）
  {
    const restore = isolateChannel({ BARK_PUSH: 'https://api.day.app/DevKey1234?auth=SECRETQUERY#frag' })
    const log1 = captureLogs()
    const got1 = mockTransport(() => ({ body: JSON.stringify({ code: 500, message: 'bad' }) }))
    try {
      try { await sendNotify('query 脱敏', '正文') } catch (e) { /* 预期失败 */ }
      const joined = log1.logs.join('\n')
      assert.ok(joined.includes('https://api.day.app/DevK***34'), `路径必须脱敏为 DevK***34，实际日志: ${joined.slice(0, 200)}`)
      assert.ok(!joined.includes('SECRETQUERY'), 'query 一律不得进日志')
      assert.ok(!joined.includes('#frag'), 'hash 一律不得进日志')
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

// --- SNB-09：isCode 的字符串业务码侧（slim:188）——评审实测的漏网变异体 ---
// 原先登记「已被 SNA-10（wxpusher '1001'）杀掉」是**错的**：实测把 :188 退化成
// `return value === expected`，pure / utils / failure_policy / pusher / bodylimit / http 六个单元档
// 全部 exit 0（SNA-10 的字符串 '1001' 走的是 wxPusherRateLimited 自己的 `err.code === '1001'`，
// 根本不经过 isCode）；唯一能杀它的 test_notify.js:1423 是 integration，被 tap-shim.js:111 挡在
// 变异集外 ⇒ 该变异体在 TAP 档与 command 档都存活。这条补上真正的击杀点。
checkS('SNB-09 Bark/企业微信: 业务码序列化成字符串时必须照样判成功（isCode 的 String 侧）', async () => {
  const forms = [
    ['bark', { BARK_PUSH: 'dev_snb09' }, () => ({ body: JSON.stringify({ code: '200' }) }), 'bark'],
    ['企业微信', { QYWX_KEY: 'qykey09' }, () => ({ body: JSON.stringify({ errcode: '0', errmsg: 'ok' }) }), '企业微信']
  ]
  for (const [label, cfg, respond, channel] of forms) {
    const restore = isolateChannel(cfg)
    const log1 = captureLogs()
    const got1 = mockTransport(respond)
    try {
      const res = await sendNotify('字符串业务码-' + label, '正文')
      assert.deepStrictEqual(res.successfulChannels, [channel],
        `${label} 的业务码是字符串时必须照样判成功（只认数字侧就会把已送达的消息当失败重推）`)
      assert.strictEqual(res.failures.length, 0, `${label} 字符串业务码不得记失败`)
    } finally { log1.restore(); got1.restore(); restore() }
  }
})

// --- SN-25：企业微信 key 的参数编码（评审实测的第二处漏网）---
// 实测把 URL 模板里的 `encodeURIComponent(String(QYWX_KEY || ''))` 换成裸拼接，全套件无人变红。
// 判错的后果是请求面而非文案面：key 里的 `&`/`#`/`=` 会被当成 query 分隔符，
// 轻则 webhook 截断成「发给了另一个 key」，重则用户配的脏 key 直接把 query 拼坏而无人报警。
checkS('SN-25 企业微信: QYWX_KEY 含 query 特殊字符时必须逐字符百分号编码（不得拼出可截断的 key）', async () => {
  const dirty = 'qy&key=x#1'
  const restore = isolateChannel({ QYWX_KEY: dirty })
  const log1 = captureLogs()
  const got1 = mockTransport(() => ({ body: JSON.stringify({ errcode: 0 }) }))
  try {
    const res = await sendNotify('脏 key 编码', '正文')
    assert.deepStrictEqual(res.successfulChannels, ['企业微信'], '脏 key 不得影响发送判定')
    const url = got1.capture[0].url
    assert.ok(url.endsWith('key=' + encodeURIComponent(dirty)),
      `key 必须整体百分号编码，实际 URL: ${url}`)
    assert.ok(!url.includes('qy&key=x'), '原始 & 不得留在 query 里（会被当参数分隔符）')
    assert.ok(!url.slice(url.indexOf('?')).includes('#'), '原始 # 不得留在 query 里（会被当 fragment 起点截断）')
    assert.strictEqual(url.split('?').length, 2, `URL 只能有一个 query 段，实际: ${url}`)
  } finally { log1.restore(); got1.restore(); restore() }
})

// 登记（本簇**不写**考题的等价/不可达变异体，实测所有候选都杀不掉）：
// · :591 `if (!BARK_PUSH)` 与 :599 `deviceKeys.length === 0`（4 个变异体）——经 sendNotify 不可达：
//   :1499 的 delimitedNonEmpty 与 :598 的 filter 是同一谓词，空列表永远走不到通道内的早退守卫。
// · :660/:661 finally 的 innerResolve({ok:false})（3 个）——所有路径都先结算，第二次 resolve 是 no-op
//   ⇒ 等价变异体；别造「catch 自己再抛」的演员场景（实测异常会冒出传输回调、进程级崩溃）。
// · :26 requestExtras 的 `catch (e) { return {} }`（1 个）——`{...undefined}` ≡ `{}`，无靶可杀。
// · :181 failures.filter(Boolean) ——外层 :1602 还有一份 filter(Boolean)，双层遮蔽，公开行为不可观测。
// · :547 Server酱 1024 的**数字侧**判定（`rawErrno === 1024`）——删掉后数字 1024 仍经兜底
//   `rawErrno` 得到 1024 ⇒ 语义不变，是等价变异体（评审实测：删数字侧全套件绿；删字符串侧 SN-03 红，
//   因为字符串 '1024' 过不了 `errno === 1024` 的严格比较）。字符串侧必须留，数字侧删了也不可疑。
// · :188 isCode 的字符串业务码侧 ——**原判「已被 SNA-10 杀掉」是错的**（评审实测：退化 :188 后
//   pure/utils/failure_policy/pusher/bodylimit/http 六个单元档全绿；SNA-10 的字符串 '1001' 走
//   wxPusherRateLimited 自己的判据，不经 isCode；唯一击杀点在 integration 的 test_notify.js:1423，
//   被 tap-shim.js:111 挡在变异集外）⇒ 已由 SNB-09 补成真正的单元档击杀。
// 编号说明（避免后人以为漏抄）：SN-19 缺号——原计划考 :1569 的「通道任务同步抛」catch，实测
// 所有通道都以 `return new Promise(executor)` 开头、executor 抛错被 Promise 构造器转成 rejection
// ⇒ 该支不可达，考点并入 SN-18（改测异步 rejection 下的在飞清单摘除）。SNB-07 缺号——与 SNB-08
// 同属「成功/异常/失败三条日志模板」考点，合并进 SNB-08 的三个场景，不重复列号。
