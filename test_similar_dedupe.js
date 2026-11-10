'use strict'

// scripts/similar-dedupe.js 纯函数套件（v3.410）
//
// 覆盖两点：
//   ① v3.410 新增的 findSimilarTitle —— 命中时返回**命中的那条窗口条目**（含 t/p/c 等字段），
//      未命中返回 null；价格护栏与券档护栏在「取命中条目」这条新入口上同样生效；
//   ② 判定口径不变：isSimilarTitle 有且只有 `findSimilarTitle(...) !== null` 这一份实现，
//      用固定种子的随机 200 组（标题/窗口/正文/时间全随机）逐组对账两者结论一致。
//
// 为什么单独成套件：近似去重此前只在 test_app_unit.js 里顺带 6 例，脚本自身没有专属套件；
// 拦截明细（similar-blocked.ndjson）依赖 findSimilarTitle 返回的条目，缺一条回归就可能「明细记错哪一条」
// 而判定仍然正确——这种偏差不会被 isSimilarTitle 的布尔断言抓到。
const assert = require('node:assert')

const Similar = require('./scripts/similar-dedupe.js')

let passed = 0
let failed = 0
const failures = []

function check (name, fn) {
  try {
    fn()
    passed += 1
  } catch (e) {
    failed += 1
    failures.push(`${name} :: ${e.message}`)
  }
}

const NOW = 1760000000000
// 仓库里实测相似度 0.80 的一对（同一楼主把一句话改几个字重发）
const BASE_TITLE = '大家各个平台都看看 如果出现负数就跑吧'
const NEAR_TITLE = '大家各个平台看看 负数就跑'

check('findSimilarTitle：命中时返回窗口里的那一整条条目（含 t/p/c/x），不是布尔值', () => {
  const recent = Similar.appendRecent([], BASE_TITLE, NOW)
  assert.strictEqual(recent.length, 1, '前置：窗口应有 1 条')
  const hit = Similar.findSimilarTitle(NEAR_TITLE, recent, { now: NOW })
  assert.ok(hit && typeof hit === 'object', `命中必须返回条目对象，实际 ${JSON.stringify(hit)}`)
  assert.strictEqual(hit, recent[0], '必须返回窗口里的同一条目（同一引用），明细才能回填 matched 的价格签名')
  assert.strictEqual(hit.t, Similar.normalizeTitle(BASE_TITLE), '返回条目的 t 必须是窗口里的归一化标题')
  assert.strictEqual(typeof hit.p, 'string', '返回条目必须带价格签名字段 p')
  assert.strictEqual(typeof hit.c, 'string', '返回条目必须带券档字段 c')
  assert.strictEqual(hit.at, NOW, '返回条目必须带写入时刻 at')
})

check('findSimilarTitle：未命中返回 null（不相关标题 / 空窗口 / 短标题 / 非字符串）', () => {
  const recent = Similar.appendRecent([], BASE_TITLE, NOW)
  assert.strictEqual(Similar.findSimilarTitle('伊利高钙奶粉礼盒装30元一罐 61元两罐', recent, { now: NOW }), null)
  assert.strictEqual(Similar.findSimilarTitle(NEAR_TITLE, [], { now: NOW }), null, '空窗口必须返回 null')
  assert.strictEqual(Similar.findSimilarTitle('京东神券100元', recent, { now: NOW }), null, '短标题不参与判重')
  assert.strictEqual(Similar.findSimilarTitle('', recent, { now: NOW }), null)
  assert.strictEqual(Similar.findSimilarTitle(undefined, recent, { now: NOW }), null)
  // 过期窗口同样不命中
  assert.strictEqual(Similar.findSimilarTitle(NEAR_TITLE, recent, { now: NOW + 11 * 60 * 1000 }), null)
})

check('findSimilarTitle：价格不同不命中（保住降价），价格相同才命中', () => {
  const recent = Similar.appendRecent([], '维达抽纸24包 59.9元 包邮', NOW)
  assert.strictEqual(Similar.findSimilarTitle('维达抽纸24包 49.9元 包邮', recent, { now: NOW }), null,
    '两边都写了价格且不同 ⇒ 不同报价，不得判重')
  const hit = Similar.findSimilarTitle('维达抽纸24包 59.9元 包邮 秒杀', recent, { now: NOW })
  assert.ok(hit, '价格相同且标题相似 ⇒ 必须命中')
  assert.strictEqual(hit.p, '59.9', '命中条目的价格签名必须是原窗口那条的')
})

check('findSimilarTitle：券档不同不命中（1000-150 vs 1000-120），档位相同才命中', () => {
  const recent = Similar.appendRecent([], '斯凯奇1000-120有价券 点击进入传送门', NOW)
  assert.strictEqual(Similar.findSimilarTitle('1000-150有价券 点击进入传送门', recent, { now: NOW }), null,
    '两边都写了档位且不同 ⇒ 不同面额的券，不得判重')
  const hit = Similar.findSimilarTitle('1000-120有价券 点击进入传送门 速领', recent, { now: NOW })
  assert.ok(hit, '档位相同且标题相似 ⇒ 必须命中')
  assert.strictEqual(hit.c, '1000-120', '命中条目的券档必须是原窗口那条的')
})

check('isSimilarTitle 与 findSimilarTitle 结论一致（固定种子随机 200 组：标题/窗口/正文/时刻）', () => {
  // 线性同余生成器：固定种子 ⇒ 失败可复现，不依赖 Math.random 的进程随机性
  let seed = 20261110
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length]
  const fragments = [
    '大家各个平台都看看', '如果出现负数就跑吧', '维达抽纸24包', '59.9元 包邮', '49.9元 包邮',
    '斯凯奇1000-120有价券', '1000-150有价券', '伊利高钙奶粉礼盒装30元一罐', '61元两罐',
    '洁婷卫生巾拍6件赠4件总到手10包', '19.9元', '京东神券100元', '限时秒杀 手慢无', '点击进入传送门'
  ]
  const makeTitle = () => {
    const n = 2 + Math.floor(rand() * 3)
    let out = ''
    for (let i = 0; i < n; i++) out += (i ? ' ' : '') + pick(fragments)
    return out
  }
  const makeContent = () => (rand() < 0.4 ? `${pick(fragments)} 正文模板口令 ${pick(fragments)}` : '')
  let compared = 0
  for (let i = 0; i < 200; i++) {
    const at = NOW - Math.floor(rand() * 20 * 60 * 1000)
    const entries = []
    const count = Math.floor(rand() * 4)
    for (let k = 0; k < count; k++) entries.push(...Similar.appendRecent([], makeTitle(), at - Math.floor(rand() * 900 * 1000), makeContent()))
    const title = makeTitle()
    const opts = { now: at, content: makeContent() }
    const bool = Similar.isSimilarTitle(title, entries, opts)
    const hit = Similar.findSimilarTitle(title, entries, opts)
    assert.strictEqual(bool, hit !== null,
      `第 ${i} 组结论不一致：isSimilarTitle=${bool} findSimilarTitle=${hit === null ? 'null' : '条目'}，标题=${title}`)
    if (hit !== null) assert.ok(entries.includes(hit), `第 ${i} 组返回的条目必须来自入参窗口`)
    compared += 1
  }
  assert.strictEqual(compared, 200, '必须真的跑满 200 组')
})

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
if (failed > 0) {
  for (const f of failures) console.log(`  ❌ ${f}`)
}
process.exit(failed > 0 ? 1 : 0)
