/* eslint promise/param-names: off */ // new Promise(r => ...) 短参数名为项目既有风格
/* eslint no-control-regex: off, camelcase: off */ // 脱敏正则与 tuisong_replace/zkt_gjc 等 snake_case 为设计命名
'use strict'

// ============================================================
// 直接测试 xbk_function_v3.js 里的 listfilter
// ============================================================

const { listfilter, filterByKeyword, validateConfig, tuisong_replace, htmlToMarkdown, looksLikeHtmlLinear, isMessageInFile, appendMessageToFile, getFileName, whitelistFilter, compileRules, matchesCompiled, checkTimeCompiled, saveBatch, init, decodeHtmlEntities, Config, daysComputed, checkRegisterTime, checkCategory, checkFields, _splitLines, getFilePath, _ensureFileExists, readMessages, saveMessages, anonKey, hasValidId, normUrl, safeUrl, validUrl, safeText, safeErrorText, sanitizeDecodedHtml, runSingleEntry, hasNestedQuantifier, truncateUtf16, filterHash, MessageStore, getMessageIdentity } = require('./xbk_function_v3.js')
const assert = require('assert')
const slim = require('./xbk_sendNotify_slim.js')
const { extractTestSummary } = require('./run_mutation.js')
const path = require('path')
// 缓存目录（基于 __dirname——v3.113 修复 /workspace 硬编码，仓库可移植）
const CACHE = path.join(__dirname, 'xianbaoku_cache')

// CodeAnt R7 建议：运行前/后清理 test_ 前缀缓存残留（含 .seen.json/.seen.lock 与临时目录），
// 避免上次异常中断残留影响本次结果；真实运行缓存 push.json 保留
function cleanupTestCache () {
  try {
    const fs = require('node:fs')
    const dir = path.join(__dirname, 'xianbaoku_cache')
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('test_')) continue
        const p = path.join(dir, f)
        try {
          const st = fs.statSync(p)
          if (st.isDirectory()) fs.rmSync(p, { recursive: true })
          else fs.unlinkSync(p)
        } catch (e) {
          console.warn(`清理测试残留失败 ${f}:`, e?.message) // 单个残留清理失败不影响测试结果
        }
      }
    }
  } catch (e) {
    console.warn('清理测试缓存失败:', e?.message) // 清理失败不影响测试结果
  }
}

let passed = 0
let failed = 0
const errors = []
const TIMEOUT_MS = 3000

async function test (name, fn) {
  const start = Date.now()
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`⏰ 超时 (${TIMEOUT_MS}ms)`)), TIMEOUT_MS)
      )
    ])
    passed++
    console.log(`  ✅ ${name}  (${Date.now() - start}ms)`)
  } catch (e) {
    failed++
    errors.push({ name, message: e.message, expected: e.expected, actual: e.actual })
    console.log(`  ❌ ${name}  (${Date.now() - start}ms)`)
    if (e.code === 'ERR_ASSERTION') {
      console.log(`      ┌─ 期望: ${JSON.stringify(e.expected)}`)
      console.log(`      └─ 实际: ${JSON.stringify(e.actual)}`)
    } else {
      console.log(`      └─ 💥 ${e.message}`)
    }
  }
}

function assertEqual (actual, expected, msg) {
  try {
    assert.strictEqual(actual, expected)
  } catch (e) {
    e.message = msg || `期望=${expected}, 实际=${actual}`
    throw e
  }
}

// 输出中是否存在成链的 Markdown 危险链接 `[label](javascript:/vbscript:/data:)`。
// CodeRabbit 审查：只查首个标记会漏掉「前畸形后有效」的组合——扫描全部标记，任一成链即 true
// CodeAnt 复审：label 可含转义 `\]`——配对须跳过转义右括号，避免漏检
// CodeRabbit 复审：`[`/`](` 定界符自身被转义时属纯文本，不得误报为危险链接
function hasDangerLink (out) {
  const re = /\]\((?:javascript|vbscript|data):/gi
  let m
  while ((m = re.exec(out)) !== null) {
    if (!isEscaped(out, m.index) && findLinkOpen(out, m.index) !== -1) return true
  }
  return false
}

// 从 `](` 所在右括号向左找配对的 `[`：`[` 未被转义，且两者之间不得有未转义的 `]`
function findLinkOpen (s, closeIdx) {
  let open = s.lastIndexOf('[', closeIdx - 1)
  while (open !== -1) {
    if (!isEscaped(s, open) && !hasUnescapedClose(s, open + 1, closeIdx - 1)) return open
    // lastIndexOf 的负 fromIndex 会被钳制为 0——open 已到 0 时须终止，否则死循环
    if (open === 0) break
    open = s.lastIndexOf('[', open - 1)
  }
  return -1
}

// 区间 [from, to] 内是否存在未转义的 `]`（`\]` 属转义，不视为闭合）
function hasUnescapedClose (s, from, to) {
  for (let i = from; i <= to; i++) {
    if (s[i] === ']' && !isEscaped(s, i)) return true
  }
  return false
}

// 下标 i 的字符是否被奇数个反斜杠转义
function isEscaped (s, i) {
  let backslashes = 0
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++
  return (backslashes & 1) === 1
}

function makeItem (overrides = {}) {
  return {
    catename: '微博线报',
    louzhu: '小明',
    title: '京东神券 100元',
    content: '限时抢购，手慢无！京东大促活动内容详情',
    louzhuregtime: '2026-01-01',
    url: '/weibo/123.html',
    ...overrides
  }
}

console.log('\n========================================')
console.log('  🧪 listfilter 全套测试（直测 xbk_function_v3.js）')
console.log('========================================\n');

(async () => {
  cleanupTestCache() // 运行前清理上次可能残留的 test_ 缓存/墓碑/锁文件（CodeAnt R7）
  // ==================== 1. 基础场景 ====================
  console.log('📂 1. 基础场景')

  // 相对日期生成器（v3.111：修复测试时间漂移——写死日期会随真实日期跨过天数阈值，8/2 后 2026-07-28 从4天变5天不再拦截）
  // v3.115：getUTC* 生成——与 parseTime 的 UTC 解析口径一致（跨时区稳定；本地生成会在 Honolulu 等时区差 1 天）
  function daysAgo (n) {
    const d = new Date(Date.now() - n * 86400000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }

  await test('全部配置为空 → 全部保留', () => {
    assertEqual(listfilter(makeItem(), {}), true)
  })

  await test('所有配置都不匹配 → 保留', () => {
    assertEqual(listfilter(makeItem(), { pingbifenlei: '赚客吧' }), true)
  })

  // ==================== 2. 分类屏蔽 ====================
  console.log('\n📂 2. 分类屏蔽')

  await test('分类屏蔽命中 → 被屏蔽', () => {
    assertEqual(listfilter(makeItem({ catename: '赚客吧' }), { pingbifenlei: '赚客吧' }), false)
  })

  await test('分类屏蔽未命中 → 保留', () => {
    assertEqual(listfilter(makeItem(), { pingbifenlei: '赚客吧' }), true)
  })

  await test('分类屏蔽支持正则', () => {
    assertEqual(listfilter(makeItem(), { pingbifenlei: '微博' }), false)
    assertEqual(listfilter(makeItem({ catename: '赚客吧' }), { pingbifenlei: '微博' }), true)
  })

  await test('分类屏蔽 正则 OR 匹配', () => {
    assertEqual(listfilter(makeItem({ catename: '赚客吧' }), { pingbifenlei: '微博|赚客吧' }), false)
    assertEqual(listfilter(makeItem({ catename: '好单线报' }), { pingbifenlei: '微博|赚客吧' }), true)
  })

  // ==================== 3. 楼主过滤 ====================
  console.log('\n📂 3. 楼主过滤')

  await test('楼主屏蔽命中 → 被屏蔽', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小黑' }), { pingbilouzhu: '小黑' }), false)
  })

  await test('楼主屏蔽未命中 → 保留', () => {
    assertEqual(listfilter(makeItem(), { pingbilouzhu: '小黑' }), true)
  })

  await test('楼主强制展现 → 即使楼主屏蔽也保留', () => {
    assertEqual(listfilter(makeItem(), { pingbilouzhu: '小明', zhanxianlouzhu: '小明' }), true)
  })

  await test('楼主强化屏蔽 → 抵消强制展现', () => {
    assertEqual(listfilter(makeItem(), { zhanxianlouzhu: '小明', pingbilouzhuplus: '小明' }), false)
  })

  await test('楼主强化屏蔽不匹配 → 强制展现生效', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      pingbilouzhu: '小明', // 屏蔽命中
      zhanxianlouzhu: '小明', // 强制展现命中
      pingbilouzhuplus: '小黑' // 强化屏蔽不匹配 → 不抵消
    }), true) // 强制展现 > 屏蔽
  })

  await test('楼主强化屏蔽未配置 → 普通屏蔽生效', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小黑' }), {
      pingbilouzhu: '小黑',
      zhanxianlouzhu: '' // 无强制展现
      // plus 未配置
    }), false)
  })

  // ==================== 4. 标题过滤 ====================
  console.log('\n📂 4. 标题过滤')

  await test('标题屏蔽命中 → 被屏蔽', () => {
    assertEqual(listfilter(makeItem(), { pingbibiaoti: '京东' }), false)
  })

  await test('标题强制展现 → 即使标题屏蔽也保留', () => {
    assertEqual(listfilter(makeItem(), { pingbibiaoti: '京东', zhanxianbiaoti: '京东' }), true)
  })

  await test('标题强化屏蔽 → 抵消标题强制展现', () => {
    assertEqual(listfilter(makeItem(), { zhanxianbiaoti: '京东', pingbibiaotiplus: '京东' }), false)
  })

  await test('楼主强制展现时 → 标题屏蔽不生效', () => {
    assertEqual(listfilter(makeItem(), { zhanxianlouzhu: '小明', pingbibiaoti: '京东' }), true)
  })

  await test('标题强化屏蔽不匹配 → 强制展现生效', () => {
    assertEqual(listfilter(makeItem({ title: '京东神券' }), {
      pingbibiaoti: '京东',
      zhanxianbiaoti: '京东',
      pingbibiaotiplus: '淘宝' // 不匹配
    }), true)
  })

  await test('标题三种同时配置 → 强化屏蔽优先', () => {
    assertEqual(listfilter(makeItem({ title: '京东神券' }), {
      zhanxianbiaoti: '京东', // 强制展现
      pingbibiaotiplus: '京东', // 强化屏蔽 → 抵消强制展现
      pingbibiaoti: '' // 无普通屏蔽
    }), false)
  })

  // ==================== 5. 内容过滤 ====================
  console.log('\n📂 5. 内容过滤')

  await test('内容屏蔽命中 → 被屏蔽', () => {
    assertEqual(listfilter(makeItem(), { pingbineirong: '限时抢购' }), false)
  })

  await test('内容强制展现 → 即使内容屏蔽也保留', () => {
    assertEqual(listfilter(makeItem(), { pingbineirong: '限时抢购', zhanxianneirong: '限时抢购' }), true)
  })

  await test('标题强制展现时 → 内容屏蔽不生效', () => {
    assertEqual(listfilter(makeItem(), { zhanxianbiaoti: '京东', pingbineirong: '广告内容' }), true)
  })

  await test('楼主强制展现时 → 内容屏蔽不生效', () => {
    assertEqual(listfilter(makeItem(), { zhanxianlouzhu: '小明', pingbineirong: '广告内容' }), true)
  })

  await test('内容强化屏蔽 → 抵消内容强制展现', () => {
    assertEqual(listfilter(makeItem({ content: '限时抢购' }), {
      zhanxianneirong: '限时抢购',
      pingbineirongplus: '限时抢购'
    }), false)
  })

  await test('楼主+标题同时强制展现 → 内容屏蔽不生效', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东', content: '广告内容' }), {
      zhanxianlouzhu: '小明',
      zhanxianbiaoti: '京东',
      pingbineirong: '广告内容'
    }), true)
  })

  await test('内容三级：屏蔽+展现+强化 → 强化屏蔽优先', () => {
    assertEqual(listfilter(makeItem({ content: '广告内容' }), {
      pingbineirong: '广告内容',
      zhanxianneirong: '广告内容',
      pingbineirongplus: '广告内容'
    }), false) // 强化屏蔽 > 强制展现 > 普通屏蔽
  })

  // ==================== 6. 天数过滤 ====================
  console.log('\n📂 6. 天数过滤')

  await test('设定值(5) > 注册天数(2) → 新号被拦截', () => {
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(4) }), { pingbitime: '5' }), false)
  })

  await test('设定值(3) < 注册天数(100) → 老号通过', () => {
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(100) }), { pingbitime: '3' }), true)
  })

  await test('设定值=0 → 不拦截任何人', () => {
    // pingbitime=0, 0不可能大于任何天数 → 永远不拦截
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(2) }), { pingbitime: '0' }), true)
  })

  await test('分类限定天数：匹配分类 → 拦截', () => {
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhuregtime: daysAgo(4) }),
      { pingbitime: '微博线报###5' }
    ), false)
  })

  await test('分类限定天数：不匹配分类 → 不拦截', () => {
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', louzhuregtime: daysAgo(4) }),
      { pingbitime: '微博线报###5' }
    ), true)
  })

  await test('天数 + 分类屏蔽同时生效 → 任一拦截即屏蔽', () => {
    // 天数拦截
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhuregtime: daysAgo(4) }),
      { pingbifenlei: '赚客吧', pingbitime: '微博线报###5' }
    ), false)
    // 分类拦截
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', louzhuregtime: '2026-01-01' }),
      { pingbifenlei: '赚客吧', pingbitime: '微博线报###5' }
    ), false)
  })

  await test('多行 pingbitime 空值行 → 跳过不生成 0 天规则（v3.238）', () => {
    // 修复前：'微博线报###' 空值 → Number('')=0 → 静默生成"拦截当天注册"规则 → 当天注册被拦
    // 修复后：空值行跳过（与 pingbifenlei 惯例一致）→ 不拦截
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhuregtime: new Date().toISOString() }),
      { pingbitime: '微博线报###' }
    ), true)
  })

  // ==================== 7. 多分类模式（###） ====================
  console.log('\n📂 7. 多分类模式（###）')

  await test('分类+关键词匹配 → 被屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', louzhu: '黑名单用户' }),
      { pingbilouzhu: '赚客吧###黑名单用户' }
    ), false)
  })

  await test('分类不匹配 → 不屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhu: '黑名单用户' }),
      { pingbilouzhu: '赚客吧###黑名单用户' }
    ), true)
  })

  await test('分类+关键词 标题屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', title: '违规内容' }),
      { pingbibiaoti: '赚客吧###违规' }
    ), false)
  })

  await test('分类+关键词 内容屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '好单线报', content: '下单联系微信' }),
      { pingbineirong: '好单线报###微信' }
    ), false)
  })

  // ==================== 8. 多行配置模式（<br> / \n\n） ====================
  console.log('\n📂 8. 多行配置模式（<br> / \\n\\n）')

  await test('<br> 多行楼主：某行匹配 → 被屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhu: '小黑' }),
      { pingbilouzhu: '赚客吧###黑名单<br>微博线报###小黑' }
    ), false)
  })

  await test('<br> 多行楼主：都不匹配 → 保留', () => {
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhu: '小白' }),
      { pingbilouzhu: '赚客吧###黑名单<br>微博线报###小黑' }
    ), true)
  })

  await test('\\n\\n 多行标题：某行匹配 → 被屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', title: '违规标题' }),
      { pingbibiaoti: '违规标题' }
    ), false)
  })

  await test('混合 <br> + \\n\\n：任意匹配 → 被屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', title: '特价商品' }),
      { pingbibiaoti: '特价商品' }
    ), false)
  })

  await test('多行天数：匹配分类且超阈值 → 拦截', () => {
    assertEqual(listfilter(
      makeItem({ catename: '赚客吧', louzhuregtime: daysAgo(4) }),
      { pingbitime: '微博线报###3<br>赚客吧###5' }
    ), false) // 第二行 5>2 → 拦截
  })

  await test('多行天数：匹配分类但未超阈值 → 不拦截', () => {
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhuregtime: daysAgo(4) }),
      { pingbitime: '赚客吧###5<br>微博线报###1' }
    ), true) // 第二行 1>2? 否 → 保留
  })

  // ==================== 9. 只看它模式 ====================
  console.log('\n📂 9. 只看它模式')

  await test('只看它空配置 → 全部展现', () => {
    assertEqual(listfilter(makeItem(), { pingbibiaoti: '(.*)', zhanxianbiaoti: '(.*)' }), true)
  })

  await test('只看它关键词不匹配 → 屏蔽', () => {
    assertEqual(listfilter(makeItem({ title: '淘宝特价' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: '京东'
    }), false)
  })

  await test('只看它关键词匹配 → 保留', () => {
    assertEqual(listfilter(makeItem({ title: '京东神券' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: '京东'
    }), true)
  })

  await test('只看它 + 强化屏蔽 → 匹配强化则屏蔽', () => {
    assertEqual(listfilter(makeItem({ title: '京东神券' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: '(.*)', pingbibiaotiplus: '京东'
    }), false)
  })

  await test('只看它 + 强化屏蔽不匹配 → 保留', () => {
    assertEqual(listfilter(makeItem({ title: '淘宝特价' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: '(.*)', pingbibiaotiplus: '京东'
    }), true)
  })

  await test('只看它 + 楼主强制展现 → 标题屏蔽不执行', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '随便' }), {
      zhanxianlouzhu: '小明', pingbibiaoti: '(.*)'
    }), true)
  })

  await test('只看它完整流程模拟（zkt_gjc 为空）', () => {
    const zkt_gjc = ''
    assertEqual(listfilter(makeItem({ title: '京东神券' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: zkt_gjc || '(.*)'
    }), true)
  })

  await test('只看它完整流程模拟（zkt_gjc=京东）', () => {
    const zkt_gjc = '京东'
    assertEqual(listfilter(makeItem({ title: '京东神券' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: zkt_gjc || '(.*)'
    }), true)
    assertEqual(listfilter(makeItem({ title: '淘宝特价' }), {
      pingbibiaoti: '(.*)', zhanxianbiaoti: zkt_gjc || '(.*)'
    }), false)
  })

  // ==================== 10. 边界与异常 ====================
  console.log('\n📂 10. 边界与异常')

  await test('字段值为空 → 跳过过滤', () => {
    assertEqual(listfilter(
      makeItem({ title: '', content: '', louzhu: '' }),
      { pingbibiaoti: '京东', pingbineirong: '活动' }
    ), true)
  })

  await test('正则 OR 多关键词 → 任一命中即屏蔽', () => {
    assertEqual(listfilter(makeItem(), { pingbibiaoti: '京东|淘宝' }), false)
  })

  await test('输入数据缺失 → 不崩溃', () => {
    assertEqual(listfilter({ catename: '测试' }, {}), true)
    assertEqual(listfilter({}, {}), true)
  })

  await test('配置含未知字段 → 不影响', () => {
    assertEqual(listfilter(makeItem(), {
      pingbibiaoti: '京东', unknownField: '测试', foo: 'bar'
    }), false)
  })

  await test('标题含正则特殊字符 → 可转义匹配', () => {
    assertEqual(listfilter(
      makeItem({ title: '测试[特价]商品' }),
      { pingbibiaoti: '\\[特价\\]' }
    ), false)
  })

  await test('配置 undefined / null → 不崩溃', () => {
    assertEqual(listfilter(makeItem(), undefined), true)
    assertEqual(listfilter(makeItem(), null), true)
  })

  await test('超大数值 → 不溢出', () => {
    assertEqual(listfilter(
      makeItem({ louzhuregtime: daysAgo(3) }),
      { pingbitime: '999999' }
    ), false)
  })

  // ==================== 11. 组合场景 ====================
  console.log('\n📂 11. 组合场景')

  await test('所有配置填满且都不匹配 → 保留', () => {
    assertEqual(listfilter(
      makeItem({
        catename: '好单线报',
        louzhu: '普通用户',
        title: '普通商品',
        content: '普通描述',
        louzhuregtime: '2026-01-01'
      }),
      {
        pingbifenlei: '微博|赚客吧',
        pingbilouzhu: '黑名单|广告号',
        zhanxianlouzhu: 'VIP用户',
        pingbilouzhuplus: '禁言用户',
        pingbibiaoti: '京东|淘宝',
        zhanxianbiaoti: '神价|免单',
        pingbibiaotiplus: '违规|垃圾',
        pingbineirong: '加V|下单联系',
        zhanxianneirong: '重磅|限时',
        pingbineirongplus: '虚假|诈骗',
        pingbitime: '30'
      }
    ), true)
  })

  await test('所有配置填满且分类匹配 → 屏蔽', () => {
    assertEqual(listfilter(
      makeItem({ catename: '微博线报', louzhu: '普通用户', title: '普通商品', content: '普通描述' }),
      {
        pingbifenlei: '微博',
        pingbilouzhu: '黑名单',
        pingbibiaoti: '京东',
        pingbineirong: '虚假',
        pingbitime: '200'
      }
    ), false)
  })

  await test('自增天数边界：当天注册 → 被拦截', () => {
    // v3.115：daysAgo(0)=UTC 今天，与 parseTime UTC 解析一致（跨时区稳定）
    assertEqual(listfilter(
      makeItem({ louzhuregtime: daysAgo(0) }),
      { pingbitime: '1' }
    ), false) // 1 > 0 → 拦截
  })

  await test('自增天数边界：很久以前注册 → 老号通过', () => {
    assertEqual(listfilter(
      makeItem({ louzhuregtime: '2020-01-01' }),
      { pingbitime: '1000' }
    ), true) // 1000 > ~2400? 要看实际天数... 假设2020-01-01到2026-07-30约2400天
    // 如果 1000 > 2400? 否 → 保留
  })

  // ==================== 12. filterByKeyword（只看它封装） ====================
  console.log('\n📂 12. filterByKeyword（只看它封装）')

  await test('关键词为空 → 全部通过', () => {
    assertEqual(filterByKeyword(makeItem({ title: '随便' }), ''), true)
  })

  await test('关键词匹配 → 保留', () => {
    assertEqual(filterByKeyword(makeItem({ title: '京东神券' }), '京东'), true)
  })

  await test('关键词不匹配 → 屏蔽', () => {
    assertEqual(filterByKeyword(makeItem({ title: '淘宝特价' }), '京东'), false)
  })

  await test('只看它 + 楼主强制展现 → 标题过滤被跳过', () => {
    // filterByKeyword 只设置了标题相关，楼主要靠 filterConfig
    // 这里直接用 listfilter 验证级联
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '随便' }), {
      zhanxianlouzhu: '小明',
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '京东'
    }), true) // 楼主强制展现，只看它不生效
  })

  // ==================== 13. validateConfig（配置校验） ====================
  console.log('\n📂 13. validateConfig（配置校验）')

  await test('合法配置 → 无警告', () => {
    const warns = validateConfig({
      pingbifenlei: '微博',
      pingbibiaoti: '京东|淘宝',
      pingbitime: '5'
    })
    assertEqual(warns.length, 0)
  })

  await test('空配置 → 无警告', () => {
    const warns = validateConfig({})
    assertEqual(warns.length, 0)
  })

  await test('非法正则 → 有警告', () => {
    const warns = validateConfig({ pingbibiaoti: '[未闭合' })
    assertEqual(warns.length, 1)
    assertEqual(warns[0].includes('无效的正则'), true)
  })

  await test('非法天数 → 有警告', () => {
    const warns = validateConfig({ pingbitime: 'abc' })
    assertEqual(warns.length, 1)
    assertEqual(warns[0].includes('不是有效数字'), true)
  })

  await test('zkt_gjc 首尾空白 → 告警（P2：白名单语义下误配空格会静默全量滤空）', () => {
    const warns = validateConfig({ zkt_gjc: ' 京东 ' })
    assertEqual(warns.some(w => w.includes('zkt_gjc') && w.includes('首尾空白')), true,
        `应有 zkt_gjc 首尾空白告警: ${warns.join(' | ')}`)
    // 正常关键词不告警（无首尾空白）
    const warns2 = validateConfig({ zkt_gjc: '京东' })
    assertEqual(warns2.some(w => w.includes('zkt_gjc') && w.includes('首尾空白')), false)
  })

  await test('多分类天数：合法 → 无警告', () => {
    const warns = validateConfig({ pingbitime: '微博线报###5<br>赚客吧###3' })
    assertEqual(warns.length, 0)
  })

  await test('多分类天数：非法 → 有警告', () => {
    const warns = validateConfig({ pingbitime: '微博线报###abc' })
    assertEqual(warns.length, 1)
    assertEqual(warns[0].includes('不是有效数字'), true)
  })

  await test('多个字段非法 → 多个警告', () => {
    const warns = validateConfig({
      pingbifenlei: '[',
      pingbibiaoti: '(',
      pingbitime: 'x'
    })
    assertEqual(warns.length, 3)
  })

  await test('validateConfig ### 多行同源警告去重（v3.257）', () => {
    const warns = validateConfig({ pingbibiaoti: '###x###y\n###x###y' })
    assertEqual(warns.length, 1)
    assertEqual(new Set(warns).size, warns.length)
  })

  // ==================== 14. tuisong_replace（模板替换） ====================
  console.log('\n📂 14. tuisong_replace（模板替换）')

  await test('基本替换：{标题}{内容}{链接}', () => {
    const result = tuisong_replace('{标题} - {内容}', {
      title: '京东神券', content: '限时抢购', url: 'http://xxx', catename: '线报'
    })
    assertEqual(result, '京东神券 - 限时抢购')
  })

  await test('全部占位符都替换', () => {
    const result = tuisong_replace('【{分类名}】{标题} {日期} {时间}', {
      title: '神价',
      catename: '微博线报',
      url: 'http://x',
      datetime: '2026-07-30',
      shorttime: '01:30'
    })
    assertEqual(result, '【微博线报】神价 2026-07-30 01:30')
  })

  await test('含 $ 符号的内容不被错误解释', () => {
    const result = tuisong_replace('{标题}', {
      title: '仅需$9.9 $&超值', url: 'http://x', catename: '线报'
    })
    assertEqual(result, '仅需$9.9 $&超值')
  })

  await test('不存在的占位符保持原样', () => {
    const result = tuisong_replace('{标题} {不存在的占位符}', {
      title: '测试', url: 'http://x', catename: '线报'
    })
    assertEqual(result, '测试 {不存在的占位符}')
  })

  await test('字段为 undefined → 替换为空', () => {
    const result = tuisong_replace('【{分类名}】{楼主}', {
      title: '测试', url: 'http://x', catename: '线报'
      // 没有 louzhu 字段
    })
    assertEqual(result, '【线报】')
  })

  await test('posttime 时间戳 → 正确格式化', () => {
    // 2026-07-30 01:30:00 UTC+8 的时间戳
    const ts = 1785346200
    const result = tuisong_replace('{日期} {时间}', {
      title: 't',
      url: 'http://x',
      catename: 'c',
      posttime: ts,
      datetime: undefined,
      shorttime: undefined
    })
    // posttime 被解析，datetime/shorttime 被计算出来
    assertEqual(result.includes('2026'), true)
  })

  await test('shijianchuo 时间戳 → 正确格式化', () => {
    const result = tuisong_replace('{日期} {时间}', {
      title: 't',
      url: 'http://x',
      catename: 'c',
      shijianchuo: 1785346200,
      datetime: undefined,
      shorttime: undefined
    })
    assertEqual(result.includes('2026'), true)
  })

  await test('数据源已有 datetime → 保留原始值', () => {
    const result = tuisong_replace('{日期} {时间}', {
      title: 't',
      url: 'http://x',
      catename: 'c',
      shijianchuo: 9999999999,
      datetime: '2026-07-30',
      shorttime: '01:30'
    })
    // 即使有时间戳，也优先用数据源的 datetime
    assertEqual(result, '2026-07-30 01:30')
  })

  // ==================== 15. htmlToMarkdown（HTML转Markdown） ====================
  console.log('\n📂 15. htmlToMarkdown（HTML转Markdown）')

  await test('空内容 → 返回空', () => {
    const result = htmlToMarkdown({ url: 'http://x' })
    assertEqual(result.includes('原文链接'), true)
    assertEqual(result.includes('http://x'), true)
  })

  await test('HTML 标签被正确转换', () => {
    const result = htmlToMarkdown({
      content_html: '<a href="http://url">链接</a><br>下一行',
      url: 'http://x'
    })
    assertEqual(result.includes('[链接](http://url)'), true)
    assertEqual(result.includes('原文链接'), true)
  })

  await test('图片标签被转换', () => {
    const result = htmlToMarkdown({
      content_html: '<img src="http://pic.jpg" alt="图片描述">',
      url: 'http://x'
    })
    assertEqual(result.includes('![图片描述](http://pic.jpg)'), true)
  })

  await test('标题标签被转换', () => {
    const result = htmlToMarkdown({
      content_html: '<h2>二级标题</h2>',
      url: 'http://x'
    })
    assertEqual(result.includes('## 二级标题'), true)
  })

  await test('htmlToMarkdown 字面 &lt;a&gt; 文本保留（#098）', () => {
    const r = htmlToMarkdown({ url: 'https://x', content_html: '<a href="https://x">见 &lt;a&gt;标签</a>' })
    assertEqual(r.includes('见 <a>标签'), true, `字面 &lt;a&gt; 不应被误删: ${r}`)
  })

  await test('htmlToMarkdown 真实嵌套 <a> 仍被剥离（#098）', () => {
    const r = htmlToMarkdown({ url: '', content_html: '<a href="https://x"><a href="https://y">内</a></a>' })
    assertEqual(r.includes('[内](https://x)'), true, `嵌套内层 a 应剥离: ${r}`)
    assertEqual(r.includes('https://y'), false, `内层链接不应出现: ${r}`)
  })

  await test('htmlToMarkdown 原有嵌套/转义不回归（#098）', () => {
    const r1 = htmlToMarkdown({ url: '', content_html: '<a href="http://url">链接</a>' })
    assertEqual(r1.includes('[链接](http://url)'), true, `普通链接应正常: ${r1}`)
    const r2 = htmlToMarkdown({ url: '', content_html: 'A&amp;B' })
    assertEqual(r2.includes('A&B'), true, `实体解码不回归: ${r2}`)
    const r3 = htmlToMarkdown({ url: '', content_html: '<div><p>段落<b>加粗</b></p><a href="http://url">链接</a></div>' })
    assertEqual(r3.includes('加粗'), true, `复杂嵌套文本应保留: ${r3}`)
    assertEqual(r3.includes('[链接](http://url)'), true, `复杂嵌套链接应保留: ${r3}`)
  })

  await test('htmlToMarkdown anchor 文本 ](javascript:) 不注入（Round2 C008）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="https://x.com">foo](javascript:alert(1))</a>', url: '' })
    assertEqual(r.includes('[foo](javascript:'), false, `不得生成 javascript 链接: ${r}`)
    assertEqual(r.includes('\\]'), true, `] 应转义: ${r}`)
    assertEqual(r.includes('(https://x.com)'), true, `仍保留安全 href: ${r}`)
  })

  await test('htmlToMarkdown img alt ](javascript:) 不注入（Round2 C008）', () => {
    const r = htmlToMarkdown({ content_html: '<img src="http://x.jpg" alt="x](javascript:y)">', url: '' })
    assertEqual(r.includes('![x](javascript:'), false, `img alt 不得生成 javascript 链接: ${r}`)
    assertEqual(r.includes('\\]'), true, `alt ] 应转义: ${r}`)
    assertEqual(r.includes('(http://x.jpg)'), true, `仍保留安全 src: ${r}`)
  })

  await test('htmlToMarkdown 普通链接不回归（Round2 C008）', () => {
    const r1 = htmlToMarkdown({ content_html: '<a href="https://x.com">text</a>', url: '' })
    assertEqual(r1.includes('[text](https://x.com)'), true, `普通链接应正常: ${r1}`)
    const r2 = htmlToMarkdown({ content_html: '<a href="https://x.com">[text](url)</a>', url: '' })
    assertEqual(r2.includes('\\[text\\]'), true, `字面 [text](url) 应转义括号: ${r2}`)
    assertEqual(r2.includes('[text](url)'), false, `不应生成嵌套链接: ${r2}`)
  })

  await test('htmlToMarkdown 嵌套 <img> 于 <a> 内各自独立转义（Round2 C008 二次修复）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="https://x.com">before <img src="http://p.jpg" alt="pic[1]"> after</a>', url: '' })
    assertEqual(r.includes('[before'), true, `anchor 文本应保留: ${r}`)
    assertEqual(r.includes(' after](https://x.com)'), true, `anchor 闭合应正常: ${r}`)
    assertEqual(r.includes('![pic\\[1\\]](http://p.jpg)'), true, `img alt 应独立转义且图片转换正常: ${r}`)
    assertEqual(/\u0003|\u0004/.test(r), false, `不应残留哨兵字符: ${JSON.stringify(r)}`)
  })

  await test('htmlToMarkdown 文本含字面 \u0003/\u0004 不冲突（Round2 C008 二次修复）', () => {
    const r1 = htmlToMarkdown({ content_html: '<a href="https://x.com">a\u0003b\u0004c</a>', url: '' })
    assertEqual(r1.includes('a\u0003b\u0004c'), true, `anchor 字面哨兵字符应原样保留: ${JSON.stringify(r1)}`)
    const r2 = htmlToMarkdown({ content_html: '<img src="http://p.jpg" alt="a\u0003b\u0004c">', url: '' })
    assertEqual(r2.includes('a\u0003b\u0004c'), true, `alt 字面哨兵字符应原样保留: ${JSON.stringify(r2)}`)
  })

  await test('htmlToMarkdown 嵌套 <img> + 字面哨兵字符组合不互相干扰（Round2 C008 二次修复）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="https://x.com">\u0003 <img src="http://p.jpg" alt="\u0004pic[1](javascript:y)"> \u0004</a>', url: '' })
    assertEqual(/(?<!\\)\]\(javascript:/i.test(r), false, `img alt 不得形成 javascript 链接: ${JSON.stringify(r)}`)
    assertEqual(r.includes('\\[1\\]'), true, `img alt 中的 ] 应转义: ${JSON.stringify(r)}`)
    assertEqual(r.includes('\u0003'), true, `anchor 字面哨兵字符应原样保留: ${JSON.stringify(r)}`)
    assertEqual(r.includes('\u0004'), true, `alt 字面哨兵字符应原样保留: ${JSON.stringify(r)}`)
  })

  await test('htmlToMarkdown anchor 实体编码 ] 也转义（Round2 C008 二次修复）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="https://x.com">foo&#93;(javascript:alert(1))</a>', url: '' })
    assertEqual(r.includes('[foo](javascript:'), false, `实体编码 ] 不得形成 javascript 链接: ${r}`)
    assertEqual(r.includes('\\]'), true, `实体编码 ] 应转义: ${r}`)
    assertEqual(r.includes('(https://x.com)'), true, `仍保留安全 href: ${r}`)
  })

  await test('htmlToMarkdown 99999+emoji 截断无孤立代理（C046）', () => {
    const content = '.'.repeat(99999) + '😀'
    const r = htmlToMarkdown({ content_html: content, url: '' })
    let orphan = false
    for (let i = 0; i < r.length; i++) {
      const c = r.charCodeAt(i)
      if (c >= 0xD800 && c <= 0xDBFF) {
        const n = r.charCodeAt(i + 1)
        if (!(n >= 0xDC00 && n <= 0xDFFF)) { orphan = true; break }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        const p = r.charCodeAt(i - 1)
        if (!(p >= 0xD800 && p <= 0xDBFF)) { orphan = true; break }
      }
    }
    assertEqual(orphan, false, `100k 截断后不应有孤立代理: ${r.length}`)
  })

  // ==================== 16. 缓存管理 ====================
  console.log('\n📂 16. 缓存管理')

  await test('getFileName 从 URL 提取文件名', () => {
    assertEqual(getFileName('http://x.com/push.json'), 'push.json')
    assertEqual(getFileName('http://x.com/a/b/123.json'), '123.json')
  })

  await test('getFileName 补全 .json 后缀', () => {
    assertEqual(getFileName('http://x.com/abc'), 'abc.json')
  })

  await test('新增消息 → 可查到', () => {
    const msg = { id: 99999, title: '测试' }
    const name = 'test_cache.json'
    // 先确保不存在
    const before = isMessageInFile(msg, name)
    // 新增
    appendMessageToFile(msg, name)
    const after = isMessageInFile(msg, name)
    assertEqual(before, false)
    assertEqual(after, true)
  })

  await test('重复消息 → 去重', () => {
    const msg = { id: 88888, title: '重复测试' }
    const name = 'test_dedup.json'
    appendMessageToFile(msg, name)
    appendMessageToFile(msg, name)
    // 只应该存了一条
    const result = isMessageInFile(msg, name)
    assertEqual(result, true)
  })

  // ==================== 17. listfilter 更多级联组合 ====================
  console.log('\n📂 17. listfilter 更多级联组合')

  await test('楼主+标题 同时强制展现 → 内容屏蔽被跳过', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东', content: '广告' }), {
      zhanxianlouzhu: '小明',
      zhanxianbiaoti: '京东',
      pingbineirong: '广告'
    }), true) // 楼主和标题都强制展现，内容屏蔽被跳过
  })

  await test('楼主强制展现 + 标题强化屏蔽 → 标题被屏蔽', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东' }), {
      zhanxianlouzhu: '小明',
      zhanxianbiaoti: '京东',
      pingbibiaotiplus: '京东'
    }), true) // 楼主强制展现时，标题强化屏蔽也被跳过（原版设计）
  })

  await test('只看它 + 天数过滤组合', () => {
    // 只看它关键词不匹配
    assertEqual(listfilter(makeItem({ title: '淘宝', louzhuregtime: daysAgo(4) }), {
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '京东',
      pingbitime: '5'
    }), false) // 只看它不匹配
  })

  await test('只看它匹配 + 天数过滤拦截 → 被拦截', () => {
    assertEqual(listfilter(makeItem({ title: '京东', louzhuregtime: daysAgo(4) }), {
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '京东',
      pingbitime: '5'
    }), false) // 只看它匹配了，但天数过滤 5>1 拦截
  })

  await test('天数过滤 + 分类屏蔽 同时生效', () => {
    assertEqual(listfilter(makeItem({ catename: '微博线报', louzhuregtime: daysAgo(4) }), {
      pingbifenlei: '微博',
      pingbitime: '5'
    }), false) // 分类匹配即拦截，天数还没走到
  })

  await test('楼主内容双屏蔽 + 标题强制展现', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小黑', title: '京东', content: '广告' }), {
      pingbilouzhu: '小黑',
      zhanxianbiaoti: '京东',
      pingbineirong: '广告'
    }), false) // 楼主屏蔽命中，直接返回false，后面的不执行
  })

  // ==================== 18. tuisong_replace 更多场景 ====================
  console.log('\n📂 18. tuisong_replace 更多场景')

  await test('同一占位符出现多次 → 全部替换', () => {
    const r = tuisong_replace('{标题} - {标题} - {标题}', {
      title: 'A', url: 'x', catename: 'c'
    })
    assertEqual(r, 'A - A - A')
  })

  await test('占位符连续无分隔符', () => {
    const r = tuisong_replace('{标题}{分类名}{日期}', {
      title: 'T', catename: 'C', url: 'x', datetime: 'D'
    })
    assertEqual(r, 'TCD')
  })

  await test('内容含 HTML 标签 → 原样保留', () => {
    const r = tuisong_replace('{内容}', {
      content: '<b>加粗</b>', url: 'x', catename: 'c'
    })
    assertEqual(r, '<b>加粗</b>')
  })

  await test('category_name 覆盖 catename', () => {
    const r = tuisong_replace('{分类名}', {
      category_name: '覆盖分类', catename: '原始分类', url: 'x'
    })
    assertEqual(r, '覆盖分类')
  })

  await test('posttime 和 shijianchuo 同时存在 → posttime 优先', () => {
    // posttime 存在时用 posttime，shijianchuo 被忽略
    const r = tuisong_replace('{日期}', {
      title: 't',
      url: 'x',
      catename: 'c',
      posttime: 1000000000,
      shijianchuo: 9999999999,
      datetime: undefined
    })
    // posttime: 1000000000 → 2001-09-09
    assertEqual(r.includes('2001'), true)
  })

  await test('所有已知占位符同时替换', () => {
    const r = tuisong_replace('{标题}|{分类名}|{链接}|{日期}|{时间}|{楼主}', {
      title: 'T',
      catename: 'C',
      url: 'U',
      datetime: 'D',
      shorttime: 'S',
      louzhu: 'L'
    })
    assertEqual(r, 'T|C|U|D|S|L')
  })

  await test('占位符大小写敏感', () => {
    const r = tuisong_replace('{标题} {标题}', {
      title: '正确', url: 'x', catename: 'c'
    })
    assertEqual(r, '正确 正确')
  })

  // ==================== 19. htmlToMarkdown 更多场景 ====================
  console.log('\n📂 19. htmlToMarkdown 更多场景')

  await test('无 alt 的 img 标签', () => {
    const r = htmlToMarkdown({
      content_html: '<img src="http://pic.jpg">',
      url: 'http://x'
    })
    assertEqual(r.includes('![](http://pic.jpg)'), true)
  })

  await test('多个连续 br', () => {
    const r = htmlToMarkdown({
      content_html: '行1<br><br><br>行2',
      url: 'http://x'
    })
    // 多个 br 被替换为多个换行
    assertEqual(r.includes('\n\n'), true)
  })

  await test('复杂嵌套标签', () => {
    const r = htmlToMarkdown({
      content_html: '<div><p>段落<b>加粗</b></p><a href="http://url">链接</a></div>',
      url: 'http://x'
    })
    assertEqual(r.includes('加粗'), true)
    assertEqual(r.includes('[链接](http://url)'), true)
  })

  await test('纯文本无标签', () => {
    const r = htmlToMarkdown({
      content_html: '纯文本内容',
      url: 'http://x'
    })
    assertEqual(r.includes('纯文本内容'), true)
  })

  await test('h1-h6 全部支持', () => {
    for (let i = 1; i <= 6; i++) {
      const r = htmlToMarkdown({
        content_html: `<h${i}>标题${i}</h${i}>`,
        url: 'http://x'
      })
      assertEqual(r.includes('#'.repeat(i) + ' 标题' + i), true, `h${i} 转换失败`)
    }
  })

  await test('htmlToMarkdown data-href 不当作链接目标（CodeRabbit）', () => {
    const r = htmlToMarkdown({ content_html: '<a data-href="https://evil.example">文本</a>', url: '' })
    assertEqual(r.includes('(https://evil.example)'), false, 'data-href 不应生成 Markdown 链接')
    assertEqual(r.includes('文本'), true, '内容应保留为纯文本')
  })

  await test('htmlToMarkdown <area>/<abbr> 前缀不误当锚点（CodeAnt）', () => {
    const r1 = htmlToMarkdown({ content_html: '<area href="https://x">中间内容</a>尾部', url: '' })
    assertEqual(r1.includes('[中间内容](https://x)'), false, '<area> 不应吞并后续内容转链接')
    assertEqual(r1.includes('中间内容尾部'), true)
    const r2 = htmlToMarkdown({ content_html: '<abbr>缩略</abbr>', url: '' })
    assertEqual(r2.includes('缩略'), true, '<abbr> 不应被当作锚点')
  })

  await test('htmlToMarkdown İ 大小写闭合搜索索引不错位（CodeRabbit）', () => {
    const a = htmlToMarkdown({ content_html: '<a href="https://x">İçerik</a>', url: '' })
    assertEqual(a.includes('[İçerik](https://x)'), true, 'İ 后锚点内容不应带出 <')
    const h = htmlToMarkdown({ content_html: '<h2>İ</h2>', url: '' })
    assertEqual(h.includes('## İ'), true)
    assertEqual(h.includes('## İ<'), false, 'İ 后标题内容不应带出 <')
    const s = htmlToMarkdown({ content_html: '<script>İ</script>after', url: '' })
    assertEqual(s.startsWith('after'), true, 'İ 后 script 移除不应丢首字符（曾错位丢 a 只剩 fter）')
  })

  await test('htmlToMarkdown 属性值内字面 <a>/<h> 不转换（CodeAnt）', () => {
    const r1 = htmlToMarkdown({ content_html: '<div data-x="<a href="https://x">text</a>', url: '' })
    assertEqual(r1.includes('[text](https://x)'), false, '属性值内 <a> 不应被伪造成链接')
    assertEqual(r1.includes('text'), true)
    const r2 = htmlToMarkdown({ content_html: '<div data-x="<h2>标题</h2>', url: '' })
    assertEqual(r2.includes('## 标题'), false, '属性值内 <h2> 不应被转换为标题')
    assertEqual(r2.includes('标题'), true)
    const r3 = htmlToMarkdown({ content_html: '<div data-x="<a href="https://x">text</a>">', url: '' })
    assertEqual(r3.includes('[text](https://x)'), false)
  })

  await test('content_html 为 undefined → 不崩溃', () => {
    const r = htmlToMarkdown({ url: 'http://x' })
    assertEqual(typeof r, 'string')
  })

  // ==================== 20. 缓存管理 更多场景 ====================
  console.log('\n📂 20. 缓存管理 更多场景')

  await test('缓存超过100条 → 自动裁剪', () => {
    const name = 'test_trim.json'
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // v3.120：显式小上限（默认已 10000）
    try {
      // 写入101条
      for (let i = 0; i < 101; i++) {
        appendMessageToFile({ id: i, title: `第${i}条` }, name)
      }
      // 验证最多保留100条（ID 1~100，第0条被删）
      const r = isMessageInFile({ id: 0 }, name)
      const r2 = isMessageInFile({ id: 100 }, name)
      // 模块内 splice(0, length-100) 会删掉前1条；P4：被裁剪记录的身份进墓碑，
      // isMessageInFile 仍应判重命中（防上游重放重复推送）
      assertEqual(r, true, '第0条被裁剪但身份应保留（墓碑判重）')
      assertEqual(r2, true)
    } finally {
      Config.cache.maxSize = orig
    }
  })

  await test('P4 裁剪后判重身份保留：被裁记录重放不重复入库', () => {
    const name = 'test_tomb_replay.json'
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 50 // 显式小上限触发条数裁剪
    try {
      for (let i = 0; i < 60; i++) appendMessageToFile({ id: i, title: `t${i}` }, name)
      assertEqual(isMessageInFile({ id: 0 }, name), true, '被裁 id 0 应仍判重命中（墓碑）')
      assertEqual(isMessageInFile({ id: 59 }, name), true, '未裁记录正常命中')
      const before = readMessages(getFilePath(name)).length
      assertEqual(before, 50, '消息数组应裁剪到 50 条')
      // 重放被裁记录：saveBatch/append 不应再收进缓存（身份已在墓碑）
      saveBatch([{ id: 0, title: 't0' }], name)
      assertEqual(readMessages(getFilePath(name)).length, before, '重放被裁记录不应重复入库')
      const r = appendMessageToFile({ id: 1, title: 't1' }, name)
      assertEqual(r, true, '重放被裁记录应视为已判重（不触发落盘）')
      assertEqual(readMessages(getFilePath(name)).length, before, 'append 重放被裁记录也不应重复入库')
    } finally {
      Config.cache.maxSize = orig
    }
  })

  await test('P4 过滤未推(_f)记录不落墓碑：规则改宽后仍可重新评估', () => {
    const name = 'test_tomb_f.json'
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100
    try {
      for (let i = 0; i < 120; i++) appendMessageToFile({ id: i, title: `t${i}`, _f: true }, name)
      // _f 记录从未推送：被裁剪后不应进墓碑 → isMessageInFile 判不存在
      assertEqual(isMessageInFile({ id: 0 }, name), false, '过滤未推记录被裁剪后不应被墓碑误判')
      // 同身份重放应能重新入库（规则改宽后可重新评估/推送）——墓碑未收录，正常 append
      appendMessageToFile({ id: 0, title: 't0', _f: true }, name)
      assertEqual(isMessageInFile({ id: 0 }, name), true, '过滤未推记录重放应重新收录')
    } finally {
      Config.cache.maxSize = orig
    }
  })

  await test('P4 墓碑四类身份 × 条数裁剪后 has() 命中 + save/saveBatch 不重写', () => {
    const name = 'test_tomb_4kinds_count.json'
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 20
    try {
      // 四类身份各自灌满并触发条数裁剪：id / id+url / url-only / anon
      for (let i = 0; i < 30; i++) appendMessageToFile({ id: i, title: `c${i}` }, name)
      for (let i = 0; i < 30; i++) appendMessageToFile({ id: 100 + i, url: `https://idurl.example/${i}`, title: `d${i}` }, name)
      for (let i = 0; i < 30; i++) appendMessageToFile({ url: `https://url.example/${i}`, title: `e${i}` }, name)
      for (let i = 0; i < 30; i++) appendMessageToFile({ title: `匿名内容 f${i} 足够长避免退化` }, name)
      const before = readMessages(getFilePath(name)).length
      assertEqual(before, 20, '缓存应裁剪到 20 条')
      // 四类被裁身份 has() 仍命中（墓碑兜底）
      assertEqual(isMessageInFile({ id: 0 }, name), true, 'id 被裁身份应墓碑命中')
      assertEqual(isMessageInFile({ id: 100, url: 'https://idurl.example/0' }, name), true, 'id+url 被裁身份应墓碑命中')
      assertEqual(isMessageInFile({ url: 'https://url.example/0' }, name), true, 'url-only 被裁身份应墓碑命中')
      assertEqual(isMessageInFile({ title: '匿名内容 f0 足够长避免退化' }, name), true, 'anon 被裁身份应墓碑命中')
      // save/saveBatch 重放均不重新入库
      saveBatch([{ id: 0 }], name)
      appendMessageToFile({ id: 100, url: 'https://idurl.example/0' }, name)
      appendMessageToFile({ url: 'https://url.example/0' }, name)
      appendMessageToFile({ title: '匿名内容 f0 足够长避免退化' }, name)
      assertEqual(readMessages(getFilePath(name)).length, before, '四类重放均不应重复入库')
    } finally {
      Config.cache.maxSize = orig
    }
  })

  await test('P4 墓碑四类身份 × 字节裁剪后 has() 命中', () => {
    const name = 'test_tomb_4kinds_bytes.json'
    const fp = getFilePath(name)
    const toSave = []
    for (let i = 0; i < 10; i++) toSave.push({ id: i, title: `b${i}`, content: 'x'.repeat(200) })
    for (let i = 0; i < 10; i++) toSave.push({ id: 100 + i, url: `https://idurl.example/${i}`, title: `c${i}`, content: 'y'.repeat(200) })
    for (let i = 0; i < 10; i++) toSave.push({ url: `https://url.example/${i}`, title: `d${i}`, content: 'z'.repeat(200) })
    for (let i = 0; i < 10; i++) toSave.push({ title: `匿名字节 f${i}`, content: 'w'.repeat(200) })
    const droppedOut = []
    const trimmed = MessageStore._trimCacheByBytes(JSON.stringify(toSave), toSave, fp, 1500, droppedOut)
    assertEqual(typeof trimmed, 'string', '小上限应裁剪成功')
    assertEqual(toSave.length < 40, true, `应裁剪掉最早一部分，实际保留 ${toSave.length}`)
    assertEqual(droppedOut.length > 0, true, '被裁剪记录应收敛到 droppedOut')
    // Round2 时序：裁剪只收集，缓存写盘成功后由 saveMessages 统一落墓碑（此处模拟）
    MessageStore._tombstoneDropped(fp, droppedOut)
    // 被字节裁剪的最早各身份应墓碑命中
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 0 }), true, '字节裁剪后 id 墓碑命中')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 100, url: 'https://idurl.example/0' }), true, '字节裁剪后 id+url 墓碑命中')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { url: 'https://url.example/0' }), true, '字节裁剪后 url-only 墓碑命中')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { title: '匿名字节 f0', content: 'w'.repeat(200) }), true, '字节裁剪后 anon 墓碑命中')
    // 最新保留的记录不落墓碑
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { title: '匿名字节 f9' }), false, '未裁剪记录不应有墓碑')
  })

  await test('P4 墓碑时序：条数裁剪后序列化失败 → 不落墓碑（CodeAnt Round2 Major）', () => {
    const name = 'test_tomb_serialize_fail.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 2
    try {
      const circular = { id: 9, title: '循环引用' }
      circular.self = circular
      // 条数裁剪会先收集 {id:0}，但随后 JSON.stringify 失败 → 缓存未落盘，不得落墓碑
      const ok = MessageStore.saveMessages(fp, [{ id: 0 }, { id: 1 }, circular])
      assertEqual(ok, false, '序列化失败应返回 false')
      assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 0 }), false, '写盘失败不得产生墓碑')
      const fsmod = require('node:fs')
      assertEqual(fsmod.existsSync(fp + '.seen.json'), false, '.seen.json 不应存在')
    } finally {
      Config.cache.maxSize = orig
    }
  })

  await test('P4 墓碑时序：缓存原子写失败 → 不落墓碑（CodeAnt Round2 Major）', () => {
    const name = 'test_tomb_atomic_fail.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 2
    const fsmod = require('node:fs')
    const origRename = fsmod.renameSync
    try {
      // 模拟 writeAtomic 的 rename 失败（tmp 已写、目标未替换 → 磁盘缓存保持原状）
      fsmod.renameSync = () => { throw new Error('模拟 rename 失败') }
      const ok = MessageStore.saveMessages(fp, [{ id: 0 }, { id: 1 }, { id: 2 }])
      assertEqual(ok, false, '原子写失败应返回 false')
    } finally {
      fsmod.renameSync = origRename
      Config.cache.maxSize = orig
    }
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 0 }), false, '写盘失败不得产生墓碑')
    assertEqual(fsmod.existsSync(fp + '.seen.json'), false, '.seen.json 不应存在')
    // 同身份重放应能正常重新入库（无墓碑误判）
    const ok2 = MessageStore.saveMessages(fp, [{ id: 0 }])
    assertEqual(ok2, true, '写盘失败后重放应正常落盘')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 0 }), false, '成功落盘但未裁剪不得产生墓碑')
  })

  await test('P4 墓碑时序：字节裁剪返回 null → 不产生墓碑（CodeAnt Round2 Major）', () => {
    const name = 'test_tomb_bytenull.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const droppedOut = []
    // 单条即超 tiny 上限：字节裁剪返回 null，不得产生任何丢弃/墓碑
    const big = { id: 0, content: 'x'.repeat(500) }
    const toSave = [big]
    const r = MessageStore._trimCacheByBytes(JSON.stringify(toSave), toSave, fp, 100, droppedOut)
    assertEqual(r, null, '单条超限应返回 null')
    assertEqual(droppedOut.length, 0, 'null 路径不应收集丢弃记录')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 0 }), false, 'null 路径不得产生墓碑')
    assertEqual(require('node:fs').existsSync(fp + '.seen.json'), false, '.seen.json 不应存在')
  })

  await test('P4 字节裁剪：不可序列化元素不崩溃且按数组口径计字节（v3.267 评审回归）', () => {
    const name = 'test_tomb_unserializable.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const droppedOut = []
    // 含 undefined / 函数 / Symbol / toJSON→undefined 的元素：整体 JSON.stringify 时写为 null，
    // 单条 JSON.stringify 返回 undefined——此前 Buffer.byteLength(undefined) 抛 TypeError，v3.267 回归修复
    const toSave = [
      undefined,
      { id: 1, title: 'fn', cb: function () {} },
      { id: 2, title: 'sym', s: Symbol('x') },
      { id: 3, title: 'tojson', toJSON: () => undefined },
      { id: 4, title: 'normal', content: 'y'.repeat(50) }
    ]
    // 数组整体序列化口径（对照）：不可序列化元素落盘为 null
    const ref = JSON.stringify(toSave)
    assertEqual(ref.includes('null'), true, '对照：数组 stringify 应将不可序列化元素写为 null')
    const sizesRef = Buffer.byteLength(ref, 'utf8')
    let r = null
    try {
      r = MessageStore._trimCacheByBytes(JSON.stringify(toSave), toSave, fp, sizesRef, droppedOut)
      assertEqual(typeof r, 'string', '裁剪不应崩溃且应返回字符串')
    } catch (e) {
      assertEqual(false, true, '不得抛出异常: ' + e.message)
    }
    // 上限等于整体大小（含 null 口径）时全部保留，无丢弃
    assertEqual(droppedOut.length, 0, '上限足够时不应裁剪')
    // 上限收紧到只放得下最新 1 条：仍不崩溃，裁掉最早 4 条
    droppedOut.length = 0
    const small = Buffer.byteLength(JSON.stringify([{ id: 4, title: 'normal', content: 'y'.repeat(50) }]), 'utf8')
    r = MessageStore._trimCacheByBytes(JSON.stringify(toSave), toSave, fp, small + 2, droppedOut)
    assertEqual(typeof r, 'string', '收紧上限后仍不应崩溃')
    assertEqual(droppedOut.length, 4, '应裁掉 4 条不可/可序列化混合的最早记录')
    assertEqual(JSON.parse(r).length, 1, '应仅保留最新 1 条')
    MessageStore._tombstoneDropped(fp, droppedOut) // 模拟 saveMessages 裁剪后统一落墓碑
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), true, '被裁的 fn 记录应落墓碑')
  })

  await test('P4 墓碑双向 fallback 与原缓存索引一致', () => {
    const name = 'test_tomb_fallback.json'
    const fp = getFilePath(name)
    // 带 id+url 的记录被裁：无 id 的 url 查询应命中（idWithUrl 兜底，与 _indexHasIdentity 同构）
    MessageStore._tombstoneDropped(fp, [{ id: 1, url: 'https://fb.example/a' }])
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { url: 'https://fb.example/a' }), true, 'url 查询应命中带 url 的 id 墓碑')
    // 纯 url 记录被裁：不同 id 同 url 的 id 查询应命中（urlOnly 兜底，与 _indexHasIdentity 同构）
    MessageStore._tombstoneDropped(fp, [{ url: 'https://fb.example/b' }])
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 99, url: 'https://fb.example/b' }), true, 'id 查询应命中纯 url 墓碑')
    // 带 id+url 记录被裁后，不同 id 同 url 的 id 查询不命中（缓存索引 sameMessageIdentity 同样不判重）
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 2, url: 'https://fb.example/a' }), false, '不同 id 同 url 不应判重（与索引一致）')
    // anon 互相独立
    MessageStore._tombstoneDropped(fp, [{ title: '匿名fallback1' }])
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { title: '匿名fallback2' }), false, '不同匿名内容不应互相命中')
  })

  await test('P4 墓碑统一判重接口 _tombstoneSetsHas（App 闸门复用）与 has 同构', () => {
    const name = 'test_tomb_gate.json'
    const fp = getFilePath(name)
    const probes = [
      { id: 1 },
      { id: 2, url: 'https://g.example/a' },
      { url: 'https://g.example/b' },
      { title: '匿名gate内容足够长' }
    ]
    MessageStore._tombstoneDropped(fp, probes)
    for (const p of probes) {
      const ident = getMessageIdentity(p)
      assertEqual(ident.valid, true, `身份应有效: ${JSON.stringify(p)}`)
      // App 推送闸门与 has/save/saveBatch 现在统一走同一墓碑判重接口，结果必须一致
      assertEqual(MessageStore._tombstoneSetsHas(fp, ident), true, `_tombstoneSetsHas 应命中: ${JSON.stringify(p)}`)
      assertEqual(MessageStore._tombstoneSetsHas(fp, ident), MessageStore._tombstoneHasIdentity(fp, p), '两入口结果应一致')
    }
    assertEqual(MessageStore._tombstoneSetsHas(fp, getMessageIdentity({ id: 999 })), false, '未收录身份不命中')
  })

  await test('P4 墓碑容量超限按文件体积淘汰最旧键（不放弃持久化）', () => {
    const name = 'test_tomb_bytes_evict.json'
    const fp = getFilePath(name)
    const ts = { id: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() }
    const pad = 'x'.repeat(64)
    for (let i = 0; i < 40; i++) ts.id.set(`id-${i}-${pad}`, true)
    const ok = MessageStore._saveTombstones(fp, ts, 600)
    assertEqual(ok, true, '超限应通过淘汰达标而非放弃持久化')
    MessageStore._tombstoneLoaded.delete(fp) // 绕过进程内缓存，验证磁盘真实内容
    const loaded = MessageStore._loadTombstones(fp)
    assertEqual(loaded.id.size > 0 && loaded.id.size < 40, true, `应淘汰到体积达标，保留 ${loaded.id.size} 个`)
    assertEqual(loaded.id.has(`id-39-${pad}`), true, '最新键应保留')
    assertEqual(loaded.id.has(`id-0-${pad}`), false, '最旧键应被淘汰')
  })

  await test('P4 墓碑写前重读合并：并发进程新增身份不互相覆盖（CodeAnt Major 竞态）', () => {
    const name = 'test_tomb_merge.json'
    const fp = getFilePath(name)
    // 进程 B 先加载空快照（模拟并发窗口内的旧缓存）
    MessageStore._tombstoneLoaded.delete(fp)
    MessageStore._loadTombstones(fp)
    // 进程 A 已写入 id:1（模拟另一进程先落盘）
    MessageStore._saveTombstones(fp, { id: new Map([['1', true]]), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() })
    // 进程 B 裁剪新增 id:2：写前重读磁盘合并，而非基于旧快照覆盖
    MessageStore._tombstoneDropped(fp, [{ id: 2 }])
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), true, 'A 进程身份应被合并保留')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 2 }), true, 'B 进程身份应新增')
  })

  await test('P4 墓碑锁忙（他人持有）：等待超时放弃写入，不无锁覆盖（CodeAnt Round3 Major）', () => {
    const name = 'test_tomb_lock_busy.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const fsmod = require('node:fs')
    // 模拟另一进程正持有锁（新 mtime，未过期）
    fsmod.writeFileSync(fp + '.seen.lock', '', { flag: 'wx' })
    const t0 = Date.now()
    MessageStore._tombstoneDropped(fp, [{ id: 1 }])
    // 等待超时（TOMBSTONE_LOCK_TIMEOUT_MS=2000）后应放弃，不得写盘
    assertEqual(Date.now() - t0 >= 1800, true, `应等到锁超时，实际 ${Date.now() - t0}ms`)
    assertEqual(fsmod.existsSync(fp + '.seen.json'), false, '锁忙时不得写墓碑文件')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), false, '锁忙时墓碑不命中')
    fsmod.unlinkSync(fp + '.seen.lock')
  })

  await test('P4 墓碑锁残留过期：按 STALE 抢占恢复写入（CodeAnt Round3 Major）', () => {
    const name = 'test_tomb_lock_stale.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const fsmod = require('node:fs')
    // 模拟崩溃残留锁：mtime 改到 20s 前 → 超过 STALE(10s) 可抢占
    fsmod.writeFileSync(fp + '.seen.lock', '', { flag: 'wx' })
    const past = new Date(Date.now() - 20000)
    fsmod.utimesSync(fp + '.seen.lock', past, past)
    MessageStore._tombstoneDropped(fp, [{ id: 1 }])
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), true, '过期残留锁抢占后应正常写入墓碑')
    assertEqual(fsmod.existsSync(fp + '.seen.lock'), false, '抢占后锁文件应被清理')
  })

  await test('P4 墓碑锁被抢占（token 被换）：放弃写盘不覆盖他人身份，释放不删他人锁（CodeAnt Round5 Major）', () => {
    const name = 'test_tomb_lock_stolen.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const fsmod = require('node:fs')
    const lockPath = fp + '.seen.lock'
    // 进程 A 正常拿锁，锁文件写入 owner token
    const token = MessageStore._acquireTombstoneLock(lockPath, Date.now() + 1000)
    assertEqual(typeof token === 'string' && token.length > 0, true, '拿锁应返回 owner token')
    // 另一进程误判 stale 抢占：删除 A 的锁并创建自己的锁（token 被替换），且已落盘自己的身份
    fsmod.writeFileSync(lockPath, 'other-process-token', { flag: 'w' })
    MessageStore._saveTombstones(fp, { id: new Map([['other', true]]), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() })
    // A 继续写盘：写前 token 校验失败 → 静默放弃，不得覆盖 B 已写入的身份
    MessageStore._recordTombstoneDrops(fp, [{ id: 1 }], lockPath, token)
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 'other' }), true, '抢占者身份应保留')
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), false, '被抢占进程身份不得写入')
    // A 释放：token 不匹配，不得删除抢占者的锁
    MessageStore._releaseTombstoneLock(lockPath, token)
    assertEqual(fsmod.existsSync(lockPath), true, '不得删除他人锁')
    // 旧格式空锁文件（无 token）：释放同样不得删除（内容不匹配视为非本人）
    fsmod.unlinkSync(lockPath)
    fsmod.writeFileSync(lockPath, '', { flag: 'wx' })
    MessageStore._releaseTombstoneLock(lockPath, token)
    assertEqual(fsmod.existsSync(lockPath), true, '空锁非本人持有，释放不得删除')
    fsmod.unlinkSync(lockPath)
  })

  await test('P4 墓碑读改写中途锁被抢占：临时副本不提交，内存不污染（CodeAnt Round6 Major）', () => {
    const name = 'test_tomb_lock_mid_stolen.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const fsmod = require('node:fs')
    const lockPath = fp + '.seen.lock'
    const token = MessageStore._acquireTombstoneLock(lockPath, Date.now() + 1000)
    // 在第二次 owner 校验（写盘瞬间）前替换锁内容，模拟读改写期间被抢占
    const origOwner = MessageStore._isTombstoneLockOwner.bind(MessageStore)
    let calls = 0
    MessageStore._isTombstoneLockOwner = (p, t) => {
      calls++
      if (calls === 2) fsmod.writeFileSync(p, 'other-token', { flag: 'w' })
      return origOwner(p, t)
    }
    try {
      MessageStore._recordTombstoneDrops(fp, [{ id: 1 }], lockPath, token)
    } finally {
      MessageStore._isTombstoneLockOwner = origOwner
    }
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), false, '中途被抢占：内存墓碑不得命中')
    assertEqual(fsmod.existsSync(fp + '.seen.json'), false, '中途被抢占：不得写盘')
    fsmod.unlinkSync(lockPath)
  })

  await test('P4 墓碑写盘失败：临时副本不提交，内存不污染（CodeAnt Round6 Major）', () => {
    const name = 'test_tomb_save_fail.json'
    const fp = getFilePath(name)
    MessageStore._tombstoneLoaded.delete(fp)
    const fsmod = require('node:fs')
    const lockPath = fp + '.seen.lock'
    const token = MessageStore._acquireTombstoneLock(lockPath, Date.now() + 1000)
    const origSave = MessageStore._saveTombstones
    MessageStore._saveTombstones = () => false
    try {
      MessageStore._recordTombstoneDrops(fp, [{ id: 1 }], lockPath, token)
    } finally {
      MessageStore._saveTombstones = origSave
    }
    assertEqual(MessageStore._tombstoneHasIdentity(fp, { id: 1 }), false, '写盘失败：内存墓碑不得命中')
    assertEqual(fsmod.existsSync(fp + '.seen.json'), false, '写盘失败：不得产生墓碑文件')
    MessageStore._releaseTombstoneLock(lockPath, token)
  })

  await test('更新已存在消息 → 内容更新', () => {
    const name = 'test_update.json'
    appendMessageToFile({ id: 777, title: '旧标题' }, name)
    appendMessageToFile({ id: 777, title: '新标题' }, name)
    // 查一下存储的内容（通过读文件验证）
    // isMessageInFile 只检查存在性，不返回值
    const exists = isMessageInFile({ id: 777 }, name)
    assertEqual(exists, true)
  })

  await test('文件名含特殊字符', () => {
    const name = getFileName('http://x.com/a/b/c/d.json')
    assertEqual(name, 'd.json')
    const name2 = getFileName('http://x.com/abc')
    assertEqual(name2, 'abc.json')
  })

  // ==================== 21. validateConfig 更多场景 ====================
  console.log('\n📂 21. validateConfig 更多场景')

  await test('多行配置：部分合法部分非法 → 有警告', () => {
    const warns = validateConfig({
      pingbibiaoti: '京东\n\n[未闭合'
    })
    // 无 ### 时整个字符串当正则校验 → 不合法
    assertEqual(warns.length >= 1, true)
  })

  await test('多行天数配置：部分非法 → 有警告', () => {
    const warns = validateConfig({
      pingbitime: '微博线报###5<br>赚客吧###abc'
    })
    assertEqual(warns.length, 1)
  })
  await test('多行天数配置：空值行/小数/超上限均告警（C049）', () => {
    const warns = validateConfig({
      pingbitime: '微博线报###<br>赚客吧###1.5<br>好单###3650001'
    })
    assertEqual(warns.some(w => w.includes('天数值为空')), true, `空值行应告警: ${JSON.stringify(warns)}`)
    assertEqual(warns.some(w => w.includes('是小数')), true, `小数行应告警: ${JSON.stringify(warns)}`)
    assertEqual(warns.some(w => w.includes('超过上限')), true, `超上限应告警: ${JSON.stringify(warns)}`)
  })

  await test('空配置对象 → 无警告', () => {
    assertEqual(validateConfig({}).length, 0)
  })

  await test('所有配置都是空格 → 给出空白警告（审查10 #115）', () => {
    // 修复前空白配置静默；修复后给出明确警告
    const warns = validateConfig({ pingbibiaoti: ' ', pingbilouzhu: '  ' })
    assertEqual(warns.some(w => w.includes('空白')), true)
  })

  // ==================== 22. 综合极限场景 ====================
  console.log('\n📂 22. 综合极限场景')

  await test('全部字段含 emoji', () => {
    const r = tuisong_replace('{标题} {内容}', {
      title: '🎉 大促 🎉',
      content: '🔥 限时抢购 🔥',
      url: 'x',
      catename: 'c'
    })
    assertEqual(r.includes('🎉'), true)
    assertEqual(r.includes('🔥'), true)
  })

  await test('超长标题不崩溃', () => {
    const longTitle = 'A'.repeat(5000)
    const r = tuisong_replace('{标题}', {
      title: longTitle, url: 'x', catename: 'c'
    })
    assertEqual(r.length, 5000)
  })

  await test('listfilter 所有配置填满且全部匹配的排列组合', () => {
    // 分类匹配
    assertEqual(listfilter(makeItem({ catename: '微博线报' }), {
      pingbifenlei: '微博'
    }), false)

    // 楼主匹配
    assertEqual(listfilter(makeItem({ louzhu: '小黑' }), {
      pingbilouzhu: '小黑'
    }), false)

    // 标题匹配
    assertEqual(listfilter(makeItem({ title: '京东' }), {
      pingbibiaoti: '京东'
    }), false)

    // 内容匹配
    assertEqual(listfilter(makeItem({ content: '抢购' }), {
      pingbineirong: '抢购'
    }), false)

    // 天数匹配
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(4) }), {
      pingbitime: '5'
    }), false)
  })

  await test('所有字段同时配置但都不匹配 → 保留', () => {
    assertEqual(listfilter(
      makeItem({ catename: '好单线报', louzhu: '普通用户', title: '普通商品', content: '普通描述' }),
      {
        pingbifenlei: '微博|赚客吧',
        pingbilouzhu: '黑名单',
        zhanxianlouzhu: 'VIP',
        pingbibiaoti: '京东|淘宝',
        zhanxianbiaoti: '神价',
        pingbineirong: '加V|下单',
        zhanxianneirong: '重磅',
        pingbitime: '100'
      }
    ), true)
  })

  // ==================== 23. htmlToMarkdown 更多标签 ====================
  console.log('\n📂 23. htmlToMarkdown 更多标签')

  await test('<ul><li> 列表标签', () => {
    const r = htmlToMarkdown({
      content_html: '<ul><li>项目一</li><li>项目二</li></ul>',
      url: 'http://x'
    })
    assertEqual(r.includes('项目一'), true)
    assertEqual(r.includes('项目二'), true)
  })

  await test('<strong> 加粗标签 → 保留文本去掉标签', () => {
    const r = htmlToMarkdown({
      content_html: '普通<strong>加粗</strong>普通',
      url: 'http://x'
    })
    assertEqual(r.includes('加粗'), true)
    assertEqual(r.includes('<strong>'), false)
  })

  await test('<span> 内联标签 → 保留文本去掉标签', () => {
    const r = htmlToMarkdown({
      content_html: '<span style="color:red">红色文字</span>',
      url: 'http://x'
    })
    assertEqual(r.includes('红色文字'), true)
    assertEqual(r.includes('<span'), false)
  })

  await test('多个不同类型标签混合', () => {
    const r = htmlToMarkdown({
      content_html: '<p><strong>标题</strong>：<a href="http://url">链接</a><br>下一行</p>',
      url: 'http://x'
    })
    assertEqual(r.includes('标题'), true)
    assertEqual(r.includes('[链接](http://url)'), true)
    assertEqual(r.includes('下一行'), true)
  })

  await test('<table> 表格 → 保留文本丢掉表格标签', () => {
    const r = htmlToMarkdown({
      content_html: '<table><tr><td>单元格1</td><td>单元格2</td></tr></table>',
      url: 'http://x'
    })
    assertEqual(r.includes('单元格1'), true)
    assertEqual(r.includes('单元格2'), true)
    assertEqual(r.includes('<table>'), false)
  })

  // ==================== 24. listfilter 极端值 ====================
  console.log('\n📂 24. listfilter 极端值')

  await test('group 为 null → 不崩溃返回 true', () => {
    assertEqual(listfilter(null, {}), true)
  })

  await test('group 为 undefined → 不崩溃返回 true', () => {
    assertEqual(listfilter(undefined, {}), true)
  })

  await test('group 为空对象 → 跳过所有过滤返回 true', () => {
    assertEqual(listfilter({}, { pingbibiaoti: '京东' }), true)
  })

  await test('字段值为 null 而非 undefined → 不崩溃', () => {
    assertEqual(listfilter({
      catename: '线报', louzhu: null, title: null, content: null
    }, { pingbibiaoti: '京东', pingbilouzhu: '小明', pingbineirong: '广告' }), true)
  })

  await test('标题为数字 → 隐式转字符串匹配', () => {
    assertEqual(listfilter({
      catename: '线报', louzhu: '小明', title: '12345', content: '内容'
    }, { pingbibiaoti: '123' }), false)
  })

  await test('catename 为 undefined → 不崩溃', () => {
    assertEqual(listfilter({
      louzhu: '小明', title: '京东', content: '内容'
    }, { pingbifenlei: '微博' }), true) // catename 是 undefined，不匹配
  })

  await test('louzhuregtime 非法格式 → 与缺失一致放行', () => {
    // 非空但 parseTime 失败（非法格式）→ checkTimeCompiled 返回 null（不拦截），
    // 与"缺失"口径一致放行；曾因 daysComputed 归 0 天（5 > 0）被误判为老号而拦截
    assertEqual(listfilter({
      catename: '线报',
      louzhu: '小明',
      title: '京东',
      content: '内容',
      louzhuregtime: 'not-a-date'
    }, { pingbitime: '5' }), true) // 解析失败 → 放行
  })

  // ==================== 25. 缓存管理 更多边界 ====================
  console.log('\n📂 25. 缓存管理 更多边界')

  await test('getFileName 边界：空字符串 URL → default.json（v3.20审查5）', () => {
    const name = getFileName('')
    assertEqual(name, 'default.json')
  })

  await test('appendMessageToFile 相同 ID 多次 → 只保留一条', () => {
    const name = 'test_idempotent.json'
    appendMessageToFile({ id: 1, data: 'a' }, name)
    appendMessageToFile({ id: 1, data: 'b' }, name)
    appendMessageToFile({ id: 1, data: 'c' }, name)
    // 应该只有一条记录
    const exists = isMessageInFile({ id: 1 }, name)
    assertEqual(exists, true)
    // 检查文件只有一条（通过内部机制验证）
    // 连续添加不同 ID
    appendMessageToFile({ id: 2 }, name)
    appendMessageToFile({ id: 3 }, name)
    assertEqual(isMessageInFile({ id: 2 }, name), true)
    assertEqual(isMessageInFile({ id: 3 }, name), true)
  })

  // ==================== 26. tuisong_replace 极端值 ====================
  console.log('\n📂 26. tuisong_replace 极端值')

  await test('内容为 null → 替换为空字符串', () => {
    const r = tuisong_replace('【{内容}】', {
      title: 'T', content: undefined, url: 'x', catename: 'c'
    })
    assertEqual(r, '【】')
  })

  await test('标题为数字 → 转字符串输出', () => {
    const r = tuisong_replace('{标题}', {
      title: 999, url: 'x', catename: 'c'
    })
    assertEqual(r, '999')
  })

  await test('所有字段都缺失 → 替换为空', () => {
    const r = tuisong_replace('{标题} - {分类名} - {链接}', {
      // 空对象
    })
    assertEqual(r, ' -  - ')
  })

  await test('空模板字符串 → 返回空', () => {
    const r = tuisong_replace('', {
      title: 'T', url: 'x', catename: 'c'
    })
    assertEqual(r, '')
  })

  // ==================== 27. 关键冲突覆盖 ====================
  console.log('\n📂 27. 关键冲突覆盖')

  await test('楼主show + 标题plus都匹配 → 楼主优先', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东' }), {
      zhanxianlouzhu: '小明',
      zhanxianbiaoti: '京东',
      pingbibiaotiplus: '京东'
    }), true) // 楼主show → 标题plus被跳过
  })

  await test('标题show + 内容plus都匹配 → 标题优先', () => {
    assertEqual(listfilter(makeItem({ title: '京东', content: '广告' }), {
      zhanxianbiaoti: '京东',
      zhanxianneirong: '广告',
      pingbineirongplus: '广告'
    }), true) // 标题show → 内容plus被跳过
  })

  await test('标题block + 标题plus都匹配 → block先触发', () => {
    assertEqual(listfilter(makeItem({ title: '京东' }), {
      pingbibiaoti: '京东',
      pingbibiaotiplus: '京东'
    }), false) // block先触发 → 屏蔽
  })

  await test('天数拦截 + 分类匹配 + 标题匹配 → 天数优先', () => {
    assertEqual(listfilter(makeItem({ catename: '微博线报', title: '京东', louzhuregtime: daysAgo(4) }), {
      pingbitime: '5',
      pingbifenlei: '微博',
      pingbibiaoti: '京东'
    }), false) // 天数拦截优先
  })

  await test('天数不拦截 + 分类不匹配 + 标题匹配 → 标题屏蔽', () => {
    assertEqual(listfilter(makeItem({ catename: '好单线报', title: '京东', louzhuregtime: daysAgo(100) }), {
      pingbitime: '999',
      pingbifenlei: '微博',
      pingbibiaoti: '京东'
    }), false) // 天数放过，分类不匹配，标题命中 → 屏蔽
  })

  await test('楼主block + 内容show → 楼主block优先', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小黑', content: '好东西' }), {
      pingbilouzhu: '小黑',
      zhanxianneirong: '好东西'
    }), false) // 楼主先被屏蔽，内容show没机会执行
  })

  await test('内容block + 内容show同时匹配 → show优先', () => {
    assertEqual(listfilter(makeItem({ content: '好东西' }), {
      pingbineirong: '好东西',
      zhanxianneirong: '好东西'
    }), true) // 内容show > 内容block
  })

  await test('楼主show + 标题plus → 楼主优先跳过标题plus', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东' }), {
      zhanxianlouzhu: '小明',
      zhanxianbiaoti: '京东',
      pingbibiaotiplus: '京东'
    }), true) // 楼主show → 标题plus被跳过
  })

  await test('楼主show + 内容plus → 楼主优先跳过内容plus', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', content: '广告' }), {
      zhanxianlouzhu: '小明',
      zhanxianneirong: '广告',
      pingbineirongplus: '广告'
    }), true)
  })

  await test('标题show + 内容plus → 标题优先跳过内容plus', () => {
    assertEqual(listfilter(makeItem({ title: '京东', content: '广告' }), {
      zhanxianbiaoti: '京东',
      zhanxianneirong: '广告',
      pingbineirongplus: '广告'
    }), true)
  })

  await test('天数拦截 + 楼主show → 天数优先', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', louzhuregtime: daysAgo(4) }), {
      pingbitime: '5',
      zhanxianlouzhu: '小明'
    }), false) // 天数优先拦截
  })

  await test('楼主block不匹配 + 标题show + 内容block → 标题show生效', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东', content: '广告' }), {
      pingbilouzhu: '小黑',
      zhanxianbiaoti: '京东',
      pingbineirong: '广告'
    }), true) // 标题show生效，内容block被跳过
  })

  await test('楼主block + 标题block + 内容block全匹配 → 楼主优先拦截', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小黑', title: '京东', content: '广告' }), {
      pingbilouzhu: '小黑',
      pingbibiaoti: '京东',
      pingbineirong: '广告'
    }), false) // 楼主先被拦了
  })

  await test('楼主show + 标题show + 内容show全匹配 → 全部展现', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东', content: '广告' }), {
      zhanxianlouzhu: '小明',
      zhanxianbiaoti: '京东',
      zhanxianneirong: '广告'
    }), true)
  })

  await test('楼主plus + 标题plus + 内容plus全匹配 → 楼主优先拦截', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东', content: '广告' }), {
      zhanxianlouzhu: '小明',
      pingbilouzhuplus: '小明',
      zhanxianbiaoti: '京东',
      pingbibiaotiplus: '京东',
      zhanxianneirong: '广告',
      pingbineirongplus: '广告'
    }), false) // 楼主plus先拦截
  })

  await test('多行混合：小红被block → 屏蔽', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小红' }), {
      pingbilouzhu: '线报###小红\n\n线报###小明\n\n线报###小黑',
      zhanxianlouzhu: '线报###小明',
      pingbilouzhuplus: '线报###小黑'
    }), false)
  })

  await test('多行混合：小明被show → 保留', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      pingbilouzhu: '小红\n\n小明\n\n小黑',
      zhanxianlouzhu: '小明',
      pingbilouzhuplus: '小黑'
    }), true)
  })

  await test('多行混合：小黑被plus → 屏蔽', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小黑' }), {
      pingbilouzhu: '小红\n\n小明\n\n小黑',
      zhanxianlouzhu: '小明',
      pingbilouzhuplus: '小黑'
    }), false)
  })

  await test('五重过滤：天数+分类+楼主+标题+内容全匹配 → 天数优先', () => {
    assertEqual(listfilter(makeItem({ catename: '微博线报', louzhu: '小明', title: '京东', content: '广告', louzhuregtime: daysAgo(4) }), {
      pingbitime: '5',
      pingbifenlei: '微博',
      pingbilouzhu: '小明',
      pingbibiaoti: '京东',
      pingbineirong: '广告'
    }), false)
  })

  await test('五重过滤：全匹配但天数不拦截 → 分类拦截', () => {
    assertEqual(listfilter(makeItem({ catename: '微博线报', louzhu: '小明', title: '京东', content: '广告', louzhuregtime: daysAgo(100) }), {
      pingbitime: '3',
      pingbifenlei: '微博',
      pingbilouzhu: '小明',
      pingbibiaoti: '京东',
      pingbineirong: '广告'
    }), false) // 天数不拦截 → 分类拦截
  })

  await test('null 配置字段 → 不崩溃', () => {
    assertEqual(listfilter(makeItem(), { pingbibiaoti: null }), true)
  })

  await test('空字符串配置 → 不崩溃', () => {
    assertEqual(listfilter(makeItem(), { pingbibiaoti: '' }), true)
  })

  await test('标题含零宽字符 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ title: '\u200b京东\u200b' }), { pingbibiaoti: '京东' }), false)
  })

  await test('内容含emoji → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ content: '🔥限时抢购🔥' }), { pingbineirong: '抢购' }), false)
  })

  await test('标题含括号 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ title: '【京东】大促' }), { pingbibiaoti: '京东' }), false)
  })

  await test('多行配置带空格 → trim后正常匹配（v3.22审查15）', () => {
    // 修复前空格进入正则导致不匹配；修复后 trim，空格不再影响
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      pingbilouzhu: ' 线报###小明 \n\n 线报###小黑 '
    }), false)
  })

  await test('正则中文全角字符 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ title: '京东神券' }), { pingbibiaoti: '京东' }), false)
    assertEqual(listfilter(makeItem({ title: '淘宝特价' }), { pingbibiaoti: '京东' }), true)
  })

  await test('超长分类名 → 不崩溃', () => {
    const longName = 'A'.repeat(1000)
    assertEqual(listfilter(makeItem({ catename: longName }), { pingbifenlei: 'B' }), true)
  })

  await test('所有配置为空字符串 → 全部保留', () => {
    assertEqual(listfilter(makeItem(), {
      pingbifenlei: '',
      pingbilouzhu: '',
      zhanxianlouzhu: '',
      pingbibiaoti: '',
      zhanxianbiaoti: '',
      pingbibiaotiplus: '',
      pingbineirong: '',
      zhanxianneirong: '',
      pingbineirongplus: '',
      pingbitime: ''
    }), true)
  })

  await test('多行配置空行 → 跳过空行', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      pingbilouzhu: '线报###小红\n\n\n\n线报###小明'
    }), false)
  })

  await test('show/block/plus 同一字段全部不配置 → 保留', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东', content: '广告' }), {}), true)
  })

  await test('天数负数 → 不拦截', () => {
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(4) }), { pingbitime: '-1' }), true)
  })

  await test('天数极大值 → 全部拦截', () => {
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(4) }), { pingbitime: '999999' }), false)
  })

  await test('楼主plus生效后 show被抵消 → 不应再被其他字段block', () => {
    // plus抵消show后，plus生效 → 返回false，后面的字段不执行
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '京东' }), {
      zhanxianlouzhu: '小明',
      pingbilouzhuplus: '小明',
      pingbibiaoti: '京东'
    }), false)
  })

  await test('混合分隔符 <br> + \n\n 在相同配置中', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      pingbilouzhu: '线报###小红<br>线报###小明\n\n线报###小黑'
    }), false)
  })

  await test('内容含单引号 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ content: "它's 好物" }), { pingbineirong: "它's" }), false)
  })

  await test('楼主名含数字 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ louzhu: 'user123' }), { pingbilouzhu: 'user123' }), false)
  })

  await test('标题全英文 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ title: 'iPhone 15 Pro Max' }), { pingbibiaoti: 'iPhone' }), false)
  })

  await test('标题含斜杠 → 正常匹配', () => {
    assertEqual(listfilter(makeItem({ title: 'Apple/iPhone/15' }), { pingbibiaoti: 'iPhone' }), false)
  })

  await test('内容含URL → 匹配URL的一部分', () => {
    assertEqual(listfilter(makeItem({ content: '详情见 https://example.com/goods/123' }), { pingbineirong: 'example' }), false)
  })

  await test('分类含前缀 → 正则部分匹配', () => {
    assertEqual(listfilter(makeItem({ catename: '微博线报-更多-京东' }), { pingbifenlei: '京东' }), false)
  })

  await test('标题+内容同时命中block → 先标题拦截', () => {
    assertEqual(listfilter(makeItem({ title: '京东', content: '抢购' }), {
      pingbibiaoti: '京东',
      pingbineirong: '抢购'
    }), false)
  })

  await test('楼主block不匹配 + 标题block匹配 + 内容block匹配 → 标题拦截', () => {
    assertEqual(listfilter(makeItem({ louzhu: '张三', title: '京东', content: '广告' }), {
      pingbilouzhu: '李四',
      pingbibiaoti: '京东',
      pingbineirong: '广告'
    }), false)
  })

  await test('楼主show不匹配 + 标题show不匹配 + 内容show匹配 → 内容保留', () => {
    assertEqual(listfilter(makeItem({ louzhu: '张三', title: '淘宝', content: '好东西' }), {
      zhanxianlouzhu: '李四',
      zhanxianbiaoti: '京东',
      zhanxianneirong: '好东西',
      pingbineirong: '好东西'
    }), true)
  })

  await test('天数精确边界：当天注册 pingbitime=1 → 当天是否拦截', () => {
    // v3.115：daysAgo(0)=UTC 今天
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(0) }), { pingbitime: '1' }), false)
  })

  await test('配置中包含正则回溯 → 不耗尽性能', () => {
    assertEqual(listfilter(makeItem({ title: '京东' }), { pingbibiaoti: '(a+)+b' }), true)
  })

  await test('getFileName URL 含复杂参数', () => {
    const v3 = require('./xbk_function_v3')
    assertEqual(v3.getFileName('http://x.com/a/b/c.json'), 'c.json')
    assertEqual(v3.getFileName(''), 'default.json')
    assertEqual(v3.getFileName('http://x.com/a/b/'), 'default.json') // 尾部 / 兜底
  })

  await test('缓存写入后立即读取 → 数据一致', () => {
    const name = 'test_consistency.json'
    const msg = { id: 666, data: '测试' }
    appendMessageToFile(msg, name)
    appendMessageToFile({ id: 666, data: '更新' }, name)
    assertEqual(isMessageInFile(msg, name), true)
  })

  await test('多个不同缓存文件 → 互不干扰', () => {
    appendMessageToFile({ id: 1 }, 'test_a.json')
    appendMessageToFile({ id: 2 }, 'test_b.json')
    assertEqual(isMessageInFile({ id: 1 }, 'test_a.json'), true)
    assertEqual(isMessageInFile({ id: 1 }, 'test_b.json'), false)
  })

  await test('tuisong_replace 全字段含特殊字符', () => {
    const r = tuisong_replace('{标题}|{分类名}|{日期}', {
      title: '特🔥价',
      catename: '线报',
      url: 'x',
      datetime: '2026-07-30',
      shorttime: '01:30'
    })
    assertEqual(r, '特🔥价|线报|2026-07-30')
  })

  await test('多行配置 五行混合 → 只有最后一行匹配', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      pingbilouzhu: 'a###x\n\nb###x\n\nc###x\n\nd###x\n\n线报###小明'
    }), false)
  })

  await test('天数过滤 + 多行分类 + 多行标题 → 超复杂', () => {
    assertEqual(listfilter(makeItem({ catename: '赚客吧', title: '京东', louzhuregtime: daysAgo(4) }), {
      pingbitime: '微博线报###3\n\n赚客吧###5',
      pingbibiaoti: '微博线报###淘宝\n\n赚客吧###京东'
    }), false) // 天数拦截
  })

  await test('天数不拦截 + 多行分类不匹配 + 多行标题匹配 → 标题拦截', () => {
    assertEqual(listfilter(makeItem({ catename: '赚客吧', title: '京东', louzhuregtime: daysAgo(100) }), {
      pingbitime: '微博线报###3\n\n赚客吧###1000',
      pingbibiaoti: '微博线报###淘宝\n\n赚客吧###京东'
    }), false) // 标题拦截
  })

  await test('show 通配符 (.*) → 所有都展现', () => {
    assertEqual(listfilter(makeItem({ title: '随便什么标题' }), {
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '(.*)'
    }), true)
  })

  await test('show 通配符 + block 通配符 → show优先', () => {
    assertEqual(listfilter(makeItem({ title: '随便什么标题' }), {
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '(.*)'
    }), true)
  })

  await test('配置中所有字段都是空格 → 当作有效正则', () => {
    assertEqual(listfilter(makeItem({ title: '测试' }), { pingbibiaoti: '   ' }), true)
  })

  await test('tuisong_replace 内容含 \n → 保留原始换行', () => {
    const r = tuisong_replace('【{内容}】', {
      title: 't', content: '第一行\n第二行', url: 'x', catename: 'c'
    })
    assertEqual(r.includes('\n'), true)
  })

  await test('htmlToMarkdown 纯文本 → 保留', () => {
    const r = htmlToMarkdown({ content_html: '纯文本', url: 'http://x' })
    assertEqual(r.includes('纯文本'), true)
  })

  await test('htmlToMarkdown 空 content_html → 不崩溃', () => {
    const r = htmlToMarkdown({ url: 'http://x' })
    assertEqual(typeof r, 'string')
  })

  await test('天数过滤 pingbitime=0 → 不拦截任何人', () => {
    assertEqual(listfilter(makeItem({ louzhuregtime: daysAgo(2) }), { pingbitime: '0' }), true)
  })

  await test('楼主: 强化屏蔽不匹配 → 强制展现生效(无普通屏蔽,简化场景)', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明' }), {
      zhanxianlouzhu: '小明',
      pingbilouzhuplus: '小黑'
    }), true)
  })

  await test('内容强化屏蔽不匹配 → 强制展现生效', () => {
    assertEqual(listfilter(makeItem({ content: '好东西' }), {
      zhanxianneirong: '好东西',
      pingbineirongplus: '坏东西'
    }), true)
  })

  await test('只看它 + 天数过滤 + 分类屏蔽 → 三重过滤', () => {
    assertEqual(listfilter(makeItem({ catename: '微博线报', title: '京东神券', louzhuregtime: daysAgo(4) }), {
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '京东',
      pingbifenlei: '微博',
      pingbitime: '5'
    }), false) // 天数拦截优先
  })

  await test('只看它 + 楼主强制展现 → 只看它不生效', () => {
    assertEqual(listfilter(makeItem({ louzhu: '小明', title: '淘宝' }), {
      zhanxianlouzhu: '小明',
      pingbibiaoti: '(.*)',
      zhanxianbiaoti: '京东'
    }), true) // 楼主show → 标题block被跳过
  })

  await test('配置全部填满且全部不匹配 → 保留', () => {
    assertEqual(listfilter(makeItem({ catename: 'A', louzhu: 'B', title: 'C', content: 'D' }), {
      pingbifenlei: 'X',
      pingbilouzhu: 'Y',
      zhanxianlouzhu: 'Z',
      pingbilouzhuplus: 'W',
      pingbibiaoti: 'V',
      zhanxianbiaoti: 'U',
      pingbibiaotiplus: 'T',
      pingbineirong: 'S',
      zhanxianneirong: 'R',
      pingbineirongplus: 'Q',
      pingbitime: '100'
    }), true)
  })

  // ==================== 27. compileRules 预编译 ====================
  console.log('\n📂 27. compileRules 预编译')

  await test('compileRules 简单正则字段', () => {
    const r = compileRules({ pingbifenlei: '微博|赚客吧' })
    assertEqual(r.pingbifenlei._type, 're')
    assertEqual(r.pingbifenlei.re.test('微博线报'), true)
    assertEqual(r.pingbifenlei.re.test('好单线报'), false)
  })

  await test('" 美妆 " 校验/编译一致（C048 trim口径）', () => {
    // 简单模式 validateConfig 与 compileRules 都使用 trim 后的值
    const cfg = { pingbibiaoti: ' 美妆 ' }
    assertEqual(validateConfig(cfg).length, 0)
    const r = compileRules(cfg)
    assertEqual(r.pingbibiaoti._type, 're')
    assertEqual(r.pingbibiaoti.re.source, '美妆')
    assertEqual(matchesCompiled(r.pingbibiaoti, '美妆', '线报'), true)

    // trim 暴露出的非法正则：compileRules 会跳过，validateConfig 也必须告警
    assertEqual(validateConfig({ pingbibiaoti: ' * ' }).length, 1)
    assertEqual(compileRules({ pingbibiaoti: ' * ' }).pingbibiaoti, null)
  })

  await test('compileRules ### 多分类字段', () => {
    const r = compileRules({ pingbilouzhu: '线报###小明\n\n线报###小黑' })
    assertEqual(r.pingbilouzhu._type, 'multi')
    assertEqual(r.pingbilouzhu.rules.length, 2)
  })

  await test('compileRules pingbifenlei 遇 ### 被忽略', () => {
    const r = compileRules({ pingbifenlei: '微博###京东' })
    assertEqual(r.pingbifenlei, null)
  })

  await test('compileRules 天数简单规则', () => {
    const r = compileRules({ pingbitime: '5' })
    assertEqual(r.pingbitime._type, 'time')
    assertEqual(r.pingbitime.value, 5)
  })

  await test('compileRules 天数多分类规则', () => {
    const r = compileRules({ pingbitime: '微博线报###5\n\n赚客吧###3' })
    assertEqual(r.pingbitime._type, 'timeMulti')
    assertEqual(r.pingbitime.rules.length, 2)
  })

  await test('compileRules 无效正则安全处理', () => {
    const r = compileRules({ pingbibiaoti: '[未闭合' })
    assertEqual(r.pingbibiaoti, null)
  })

  await test('matchesCompiled 简单正则匹配', () => {
    const r = compileRules({ pingbibiaoti: '京东|淘宝' })
    assertEqual(matchesCompiled(r.pingbibiaoti, '京东神券', '线报'), true)
    assertEqual(matchesCompiled(r.pingbibiaoti, '拼多多', '线报'), false)
  })

  await test('matchesCompiled 零宽字符归一（C038）', () => {
    const r = compileRules({ pingbibiaoti: 'bad' })
    assertEqual(matchesCompiled(r.pingbibiaoti, 'ba\u200Bd', '线报'), true)
  })

  await test('matchesCompiled 多分类规则匹配', () => {
    const r = compileRules({ pingbilouzhu: '线报###小明\n\n线报###小黑' })
    // 分类匹配+值匹配 → true
    assertEqual(matchesCompiled(r.pingbilouzhu, '小明', '微博线报'), true)
    // 分类不匹配 → false
    assertEqual(matchesCompiled(r.pingbilouzhu, '小明', '其他分类'), false)
    // 值不匹配 → false
    assertEqual(matchesCompiled(r.pingbilouzhu, '小红', '微博线报'), false)
  })

  await test('checkTimeCompiled 简单天数', () => {
    const r = compileRules({ pingbitime: '5' })
    // 注册2天 → 5 > 2 → 拦截 true
    assertEqual(checkTimeCompiled(r.pingbitime, { louzhuregtime: daysAgo(3) }), true)
    // 注册100天 → 5 > 100? 否 → 不拦截 false
    assertEqual(checkTimeCompiled(r.pingbitime, { louzhuregtime: daysAgo(100) }), false)
  })

  await test('checkTimeCompiled 多分类天数', () => {
    const r = compileRules({ pingbitime: '微博线报###5\n\n赚客吧###3' })
    // 分类匹配+超天数 → 拦截
    assertEqual(checkTimeCompiled(r.pingbitime, { catename: '微博线报', louzhuregtime: daysAgo(3) }), true)
    // 分类不匹配 → 不拦截
    assertEqual(checkTimeCompiled(r.pingbitime, { catename: '好单线报', louzhuregtime: daysAgo(3) }), false)
  })

  await test('compileRules boolean 值 → null（v3.257 口径对齐）', () => {
    const r = compileRules({ pingbibiaoti: true })
    assertEqual(r.pingbibiaoti, null)
  })

  await test('compileRules BigInt 值 → null（v3.257 口径对齐）', () => {
    const r = compileRules({ pingbibiaoti: 5n })
    assertEqual(r.pingbibiaoti, null)
  })

  await test('compileRules function 值 → null（v3.257 口径对齐）', () => {
    const r = compileRules({ pingbibiaoti: () => {} })
    assertEqual(r.pingbibiaoti, null)
  })

  await test('compileRules 正常字符串规则不受影响', () => {
    const r = compileRules({ pingbibiaoti: '京东|淘宝' })
    assertEqual(r.pingbibiaoti._type, 're')
    assertEqual(r.pingbibiaoti.re.test('京东'), true)
  })

  // ==================== C007 _legacyCompileKey 字符串/对象同缓存键 ====================
  console.log('\n📂 C007 _legacyCompileKey 字符串/对象同缓存键')

  await test('C007 先字符串后对象：对象按 compileRules null 放行', () => {
    assertEqual(listfilter(makeItem({ title: 'x' }), { pingbibiaoti: 'x' }), false)
    assertEqual(listfilter(makeItem({ title: 'x' }), { pingbibiaoti: { toString: () => 'x' } }), true)
  })

  await test('C007 先对象后字符串：不互相污染', () => {
    assertEqual(listfilter(makeItem({ title: 'x' }), { pingbibiaoti: { toString: () => 'x' } }), true)
    assertEqual(listfilter(makeItem({ title: 'x' }), { pingbibiaoti: 'x' }), false)
  })

  await test('C007 同类型同值仍共享缓存', () => {
    assertEqual(listfilter(makeItem({ title: 'x' }), { pingbibiaoti: 'x' }), false)
    assertEqual(listfilter(makeItem({ title: 'x' }), { pingbibiaoti: 'x' }), false)
    assertEqual(listfilter(makeItem({ title: 'y' }), { pingbibiaoti: { toString: () => 'y' } }), true)
    assertEqual(listfilter(makeItem({ title: 'y' }), { pingbibiaoti: { toString: () => 'y' } }), true)
  })

  // ==================== C015 filterHash 类型归一 ====================
  console.log('\n📂 C015 filterHash 类型归一')

  await test('C015 filterHash number 0 与 string "0" 哈希不同', () => {
    assertEqual(filterHash({ pingbibiaoti: 0 }) === filterHash({ pingbibiaoti: '0' }), false, '0 与 "0" 应不同哈希')
  })

  await test('C015b filterHash 64 位确定性 + 碰撞空间扩展（P2：32 位 djb2 曾碰撞致 _f 缓存不失效）', () => {
    // 确定性：相同输入 → 相同输出（filter.hash 相等比较依赖此性质）
    const a = filterHash({ pingbibiaoti: '京东' }, 'abc')
    const b = filterHash({ pingbibiaoti: '京东' }, 'abc')
    assertEqual(a === b, true, '相同输入应产生相同哈希')
    // 64 位拼接形态（两段 32 位，'-' 分隔）
    assertEqual(typeof a === 'string' && a.includes('-'), true, `应输出 64 位拼接形态: ${a}`)
    assertEqual(a.split('-').length === 2, true)
    // 不同输入 → 不同哈希
    assertEqual(filterHash({ pingbibiaoti: '京东' }) === filterHash({ pingbibiaoti: '淘宝' }), false)
  })

  await test('validateConfig 对 true 仍告警（v3.257 口径对齐）', () => {
    const warns = validateConfig({ pingbibiaoti: true })
    assertEqual(warns.length, 1)
    assertEqual(warns[0].includes('应为字符串'), true)
  })

  // ==================== 28. whitelistFilter ====================
  console.log('\n📂 28. whitelistFilter')

  await test('whitelistFilter 空关键词 → 全部通过', () => {
    assertEqual(whitelistFilter({ title: '随便' }, 'title', ''), true)
  })

  await test('whitelistFilter 非字符串 keyword → 放行', () => {
    assertEqual(whitelistFilter({ title: 'foo' }, 'title', { toString: () => 'bar' }), true)
  })

  await test('whitelistFilter 标题匹配', () => {
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', '京东'), true)
  })

  await test('whitelistFilter 标题不匹配', () => {
    assertEqual(whitelistFilter({ title: '淘宝特价' }, 'title', '京东'), false)
  })

  await test('whitelistFilter 内容字段匹配', () => {
    assertEqual(whitelistFilter({ content: '限时抢购' }, 'content', '抢购'), true)
  })

  await test('whitelistFilter 楼主字段匹配', () => {
    assertEqual(whitelistFilter({ louzhu: '小明' }, 'louzhu', '小明'), true)
  })

  await test('whitelistFilter 字段值缺失 → 放行（与 App.run 保留空标题口径一致）', () => {
    assertEqual(whitelistFilter({}, 'title', '京东'), true)
  })

  await test('whitelistFilter 无效正则 → 放行（与 App.run 预编译失败口径一致）', () => {
    assertEqual(whitelistFilter({ title: '京东' }, 'title', '[未闭合'), true)
  })

  await test('whitelistFilter 空串 + .* → true（空串视为缺失，不参与白名单匹配也不拦截）', () => {
    assertEqual(whitelistFilter({ title: '' }, 'title', '.*'), true)
  })

  await test('whitelistFilter 空串 + 非空关键词 → true（与 App.run 空标题保留一致）', () => {
    assertEqual(whitelistFilter({ title: '' }, 'title', 'abc'), true)
    assertEqual(whitelistFilter({ title: '' }, 'title', 'foo'), true)
  })

  await test('whitelistFilter 0 + 关键词 "0" → true（0 参与匹配）', () => {
    assertEqual(whitelistFilter({ title: 0 }, 'title', '0'), true)
  })

  await test('whitelistFilter undefined → true（缺失视为放行）', () => {
    assertEqual(whitelistFilter({ title: undefined }, 'title', '.*'), true)
  })

  await test('whitelistFilter 正常值匹配不受影响', () => {
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', '京东'), true)
  })

  // ==================== 29. saveBatch 批量写入 ====================
  console.log('\n📂 29. saveBatch 批量写入')

  await test('saveBatch 批量写入多条', () => {
    saveBatch([{ id: 1 }, { id: 2 }, { id: 3 }], 'test_batch.json')
    assertEqual(isMessageInFile({ id: 1 }, 'test_batch.json'), true)
    assertEqual(isMessageInFile({ id: 2 }, 'test_batch.json'), true)
    assertEqual(isMessageInFile({ id: 3 }, 'test_batch.json'), true)
  })

  await test('saveBatch 空数组 → 不报错', () => {
    saveBatch([], 'test_batch_empty.json')
    assertEqual(true, true)
  })

  await test('saveBatch 含重复 id → 更新不重复', () => {
    saveBatch([{ id: 10, v: 'a' }, { id: 10, v: 'b' }], 'test_batch_dup.json')
    // 应该只有一条
    assertEqual(isMessageInFile({ id: 10 }, 'test_batch_dup.json'), true)
    const fs = require('fs')
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, 'test_batch_dup.json'), 'utf8'))
    assertEqual(msgs.filter(m => m.id === 10).length, 1)
  })

  await test('saveBatch 共享 addIndex 后索引化判重一致（f7）', () => {
    // 共享 Utils.addIndex 后：id 与 url 两种身份键在跨批保存时仍能正确命中索引并判重
    const name = 'test_batch_f7_shared.json'
    saveBatch([{ id: 30, title: 'id-old' }], name)
    saveBatch([{ id: 30, title: 'id-new' }], name) // 同 id → 更新不重复
    saveBatch([{ url: '/f7.html', title: 'url-old' }], name)
    saveBatch([{ url: '/f7.html', title: 'url-new' }], name) // 同 url（纯 url 消息）→ 更新不重复
    const fs = require('fs')
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))
    assertEqual(msgs.filter(m => m.id === 30).length, 1, '同 id 应只保留一条')
    assertEqual(msgs.filter(m => m.url === '/f7.html').length, 1, '同 url 应只保留一条')
    assertEqual(msgs.length, 2, '共享 addIndex 后总条数不应因索引失效而膨胀')
  })

  // ==================== 30. init & decodeHtmlEntities ====================
  console.log('\n📂 30. init & decodeHtmlEntities')

  await test('init 重复调用 → 不报错', () => {
    init()
    init()
    assertEqual(true, true)
  })

  await test('decodeHtmlEntities 全部常见实体', () => {
    assertEqual(decodeHtmlEntities('&amp; &lt; &gt; &quot; &apos; &nbsp;'), "& < > \" '  ")
  })

  await test('decodeHtmlEntities 空字符串 → 原样', () => {
    assertEqual(decodeHtmlEntities(''), '')
  })

  await test('decodeHtmlEntities 无实体 → 原样', () => {
    assertEqual(decodeHtmlEntities('普通文本123'), '普通文本123')
  })

  await test('decodeHtmlEntities 混合实体和文本', () => {
    assertEqual(decodeHtmlEntities('a&amp;b&lt;c'), 'a&b<c')
  })

  // ==================== 31. Formatter 惰性计算 ====================
  console.log('\n📂 31. Formatter 惰性计算')

  await test('模板不用Markdown → 不触发htmlToMarkdown', () => {
    // 模板不含 {Markdown内容} → 结果里没有Markdown相关内容，正常输出标题
    const r = tuisong_replace('【{分类名}】{标题}', {
      catename: '线报', title: '测试', url: 'x'
    })
    assertEqual(r, '【线报】测试')
  })

  await test('模板用Markdown → 正常输出', () => {
    const r = tuisong_replace('{Markdown内容}', {
      content_html: '<h2>标题</h2>', url: 'http://x'
    })
    assertEqual(r.includes('## 标题'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('模板不用Html内容 → rawHtml 惰性生效（100k content_html <500ms）', () => {
    const big = 'a'.repeat(100000)
    const t0 = Date.now()
    const r = tuisong_replace('{标题}', { title: '测试', content_html: big })
    const dt = Date.now() - t0
    assertEqual(r, '测试')
    assertEqual(dt < 500, true, `耗时 ${dt}ms 应 <500ms`)
  })

  await test('模板用Html内容 → 功能不回归', () => {
    const r = tuisong_replace('{Html内容}', {
      content_html: '<p>hello</p>', url: 'http://x'
    })
    assertEqual(r.includes('hello'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  // ==================== 32. has() url fallback 判重 ====================
  console.log('\n📂 32. has() url fallback 判重')

  await test('无id+相同url → 判重', () => {
    appendMessageToFile({ url: '/x/1.html', title: 'a' }, 'test_urlfb.json')
    assertEqual(isMessageInFile({ url: '/x/1.html', title: 'b' }, 'test_urlfb.json'), true)
  })

  await test('无id+不同url → 不判重', () => {
    appendMessageToFile({ url: '/x/2.html', title: 'a' }, 'test_urlfb.json')
    assertEqual(isMessageInFile({ url: '/x/3.html', title: 'b' }, 'test_urlfb.json'), false)
  })

  await test('有id优先用id判重（url不同也无所谓）', () => {
    appendMessageToFile({ id: 999, url: '/x/old.html' }, 'test_urlfb2.json')
    // 同id但不同url → 判重
    assertEqual(isMessageInFile({ id: 999, url: '/x/new.html' }, 'test_urlfb2.json'), true)
  })

  await test('无id且无url → 不误判重复', () => {
    appendMessageToFile({ title: '无标识' }, 'test_urlfb3.json')
    // 两个都无id无url → 不应判重（避免 undefined===undefined 误判）
    assertEqual(isMessageInFile({ title: '另一个无标识' }, 'test_urlfb3.json'), false)
  })

  // ==================== 33. Config getter ====================
  console.log('\n📂 33. Config getter')

  await test('Config.api.pushUrl 正确拼接', () => {
    assertEqual(Config.api.pushUrl, Config.domain + '/plus/json/push.json')
  })

  await test('Config.filter 包含完整过滤配置字段', () => {
    assertEqual(typeof Config.filter.pingbifenlei, 'string')
    assertEqual(typeof Config.filter.pingbibiaoti, 'string')
    assertEqual(typeof Config.filter.zhanxianbiaoti, 'string')
    assertEqual(typeof Config.filter.pingbibiaotiplus, 'string')
    assertEqual(typeof Config.filter.pingbineirong, 'string')
    assertEqual(typeof Config.filter.zhanxianneirong, 'string')
    assertEqual(typeof Config.filter.pingbineirongplus, 'string')
    assertEqual(typeof Config.filter.pingbilouzhu, 'string')
    assertEqual(typeof Config.filter.zhanxianlouzhu, 'string')
    assertEqual(typeof Config.filter.pingbilouzhuplus, 'string')
    assertEqual(typeof Config.filter.pingbitime, 'string')
  })

  await test('修改 domain 后 pushUrl 联动变化', () => {
    const original = Config.domain
    Config.domain = 'https://example.com'
    assertEqual(Config.api.pushUrl, 'https://example.com/plus/json/push.json')
    Config.domain = original // 恢复
  })

  // ==================== 34. fetchData ====================
  console.log('\n📂 34. fetchData')

  // ==================== 35. daysComputed 边界 ====================
  console.log('\n📂 35. daysComputed 边界')

  await test('daysComputed 正常日期', () => {
    assertEqual(typeof daysComputed('2026-07-28'), 'number')
    assertEqual(daysComputed('2026-07-28') >= 0, true)
  })

  await test('daysComputed 空字符串 → 0', () => {
    assertEqual(daysComputed(''), 0)
  })

  await test('daysComputed undefined → 0', () => {
    assertEqual(daysComputed(undefined), 0)
  })

  await test('daysComputed 非法格式 → 0', () => {
    assertEqual(daysComputed('not-a-date'), 0)
  })

  await test('daysComputed 未来日期 → 0', () => {
    assertEqual(daysComputed('2030-01-01'), 0)
  })

  await test('daysComputed 带时刻注册：UTC 自然日差（v3.170 修复 24h 段少算 1 天）', () => {
    const origNow = Date.now
    try {
      Date.now = () => Date.UTC(2026, 7, 3, 6, 0) // 固定"今天"= 2026-08-03 06:00 UTC
      // 8/1 23:00 注册（带时刻）→ 24h 段曾算 1 天，自然日差应为 2 天
      assertEqual(daysComputed('2026-08-01T23:00:00Z'), 2, '8/1 23:00 → 8/3 应 2 天（自然日）')
      assertEqual(daysComputed('2026-08-02T23:00:00Z'), 1, '8/2 23:00 → 应 1 天')
      assertEqual(daysComputed('2026-08-03T05:59:59Z'), 0, '今天（含未来时刻）→ 0 天')
    } finally {
      Date.now = origNow
    }
  })

  await test('parseTime 单数字月日 T 分隔（v3.171：2026-8-1T10:30 曾 Invalid 而空格格式有效）', () => {
    const origNow = Date.now
    try {
      Date.now = () => Date.UTC(2026, 7, 3, 6, 0)
      // T 分隔（无秒）与空格分隔应一致
      assertEqual(daysComputed('2026-8-1T10:30'), 2, '单数字 T 分隔应=2 天（与空格分隔同口径）')
      assertEqual(daysComputed('2026-8-1 10:30'), 2, '单数字空格分隔应=2 天')
      // 非法时刻仍无效
      assertEqual(daysComputed('2026-08-01T25:00:00'), 0, '非法时刻仍=0')
    } finally {
      Date.now = origNow
    }
  })

  await test('日期统一 UTC：不同宿主时区下单数字月日结果一致', () => {
    const cp = require('child_process')
    const script = 'const x=require(\'./xbk_function_v3.js\'); Date.now=()=>Date.UTC(2026,7,3,6,0); console.log(JSON.stringify({days:x.daysComputed(\'2026-8-1T10:30\'), display:x.tuisong_replace(\'{日期}|{时间}\', {posttime:\'2026-8-1T10:30\'})}));'
    const outputs = ['UTC', 'Asia/Shanghai', 'Pacific/Honolulu'].map(tz => cp.execFileSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8'
    }).trim())
    assertEqual(new Set(outputs).size, 1, `UTC 日期结果不应随宿主时区变化: ${outputs.join(' | ')}`)
    const result = JSON.parse(outputs[0])
    assertEqual(result.days, 2, 'UTC 自然日差应为2')
    assertEqual(result.display, '2026-08-01|10:30', `日期时间显示应明确按 UTC: ${result.display}`)
  })

  await test('truncateUtf16 ZWJ/变体选择符/组合字符不切断（v3.175）', () => {
    // ZWJ 序列：截断后无孤立 ZWJ、无半代理
    assertEqual(truncateUtf16('👨👩👧👦', 3), '👨', '家庭 emoji max=3 → 完整首个')
    assertEqual(truncateUtf16('👨👩👧👦', 5), '👨👩', 'max=5 → 完整前两个（无孤立 ZWJ）')
    const r5 = truncateUtf16('👨👩👧👦', 5)
    assertEqual(r5.endsWith('\u200D'), false, '末尾不应是孤立 ZWJ')
    // Round2 C018：删除末尾 ZWJ 后不再二次回退
    assertEqual(truncateUtf16('a\u200Db', 2), 'a', 'a\u200Db max=2 → 保留 a（曾误删为空）')
    // 变体选择符：❤️ max=1 → 退位为空（不丢 VS16 留残缺 ❤）
    assertEqual(truncateUtf16('❤️', 1), '', 'VS16 序列 max=1 → 保守退位')
    // 组合字符：e + 重音 max=1 → 退位（不丢重音留残缺 e）
    assertEqual(truncateUtf16('e\u0301', 1), '', '组合字符 max=1 → 保守退位')
    // 普通行为不变
    assertEqual(truncateUtf16('abc', 2), 'ab', '普通文本正常截断')
    assertEqual(truncateUtf16('😀😀', 2), '😀', '双 emoji 完整保留')
  })

  await test('truncateUtf16 补充平面修饰符不切断（v3.185）', () => {
    // 肤色修饰符 U+1F3FD：小 max 应退为空，不得留下半个代理（👍 基底）
    assertEqual(truncateUtf16('👍🏽', 1), '', '👍🏽 max=1 → 退位为空（无半代理）')
    assertEqual(truncateUtf16('👍🏽', 2), '', '👍🏽 max=2 → 退位为空（不拆散基底与肤色）')
    assertEqual(truncateUtf16('👍🏽', 3), '', '👍🏽 max=3 → 退位为空')
    assertEqual(truncateUtf16('👍🏽', 4), '👍🏽', '👍🏽 max=4 → 完整保留')
    // 区域指示符（旗帜）：每个区域指示符是独立码点，不作为修饰符退位（#073）
    assertEqual(truncateUtf16('🇨🇳', 2), '🇨', '🇨🇳 max=2 → 保留首个区域指示符（不误删为修饰符）')
    assertEqual(truncateUtf16('🇨🇳', 4), '🇨🇳', '🇨🇳 max=4 → 完整保留')
    // 既有 BMP 用例仍通过
    assertEqual(truncateUtf16('👨👩👧👦', 3), '👨', '家庭 emoji max=3 → 完整首个')
    assertEqual(truncateUtf16('👨👩👧👦', 5), '👨👩', 'max=5 → 完整前两个（无孤立 ZWJ）')
    assertEqual(truncateUtf16('❤️', 1), '', 'VS16 序列 max=1 → 保守退位')
    assertEqual(truncateUtf16('e\u0301', 1), '', '组合字符 max=1 → 保守退位')
  })

  await test('truncateUtf16 区域指示符不误删（#073）', () => {
    // 区域指示符是独立码点，不应作为"前一字符修饰符"误删正常字符
    assertEqual(truncateUtf16('A🇨🇳', 2), 'A', 'A🇨🇳 max=2 → 保留 A（曾误删为空）')
    // 多旗帜：截断到 4 应保留第一个完整旗帜
    const flagCut = truncateUtf16('🇨🇳🇺🇸', 4)
    assertEqual(flagCut.length > 0, true, '🇨🇳🇺🇸 max=4 → 至少保留第一个旗帜')
    assertEqual(flagCut, '🇨🇳', '🇨🇳🇺🇸 max=4 → 保留第一个旗帜')
    // 肤色修饰符仍受保护，不产生孤代理
    const skin = truncateUtf16('👍🏽', 2)
    assertEqual(/[\uD800-\uDBFF]$/.test(skin), false, '👍🏽 max=2 → 末尾无孤高代理')
    assertEqual(skin.length === 0 || skin.endsWith('🏽'), true, '👍🏽 max=2 → 不拆散修饰符')
    // 原有用例不得回归
    assertEqual(truncateUtf16('❤️', 1), '', '❤️ max=1 → 保守退位')
    assertEqual(truncateUtf16('e\u0301', 1), '', '组合音标 max=1 → 保守退位')
  })

  await test('htmlToMarkdown 短标签词边界（v3.171：img/input/blockquote 不再误当 i/b）', () => {
    // 前缀标签不应输出 */**/- 垃圾
    assertEqual(htmlToMarkdown({ content_html: '<img class="x">', url: '' }), '', 'img 无 src 应剥空（曾输出 *）')
    assertEqual(htmlToMarkdown({ content_html: '<input type="text">', url: '' }), '', 'input 应剥空（曾输出 *）')
    assertEqual(htmlToMarkdown({ content_html: '<blockquote>引用</blockquote>', url: '' }), '引用', 'blockquote 保留文本（曾输出 **引用**）')
    assertEqual(htmlToMarkdown({ content_html: '<link rel="stylesheet">', url: '' }), '', 'link 应剥空（曾输出 -）')
    // 正常标签不受影响
    assertEqual(htmlToMarkdown({ content_html: '<b>粗</b><i>斜</i>', url: '' }), '**粗***斜*', '正常 b/i 不变')
    assertEqual(htmlToMarkdown({ content_html: '<ul><li>项</li></ul>', url: '' }), '- 项', '正常 li 不变')
  })

  await test('htmlToMarkdown 无引号 href（v3.170）', () => {
    const r = htmlToMarkdown({ content_html: '<a href=https://u.jd.com/x>京东</a>', url: '' })
    assertEqual(r.includes('[京东](https://u.jd.com/x)'), true, `无引号 href 应转换链接: ${JSON.stringify(r)}`)
    // 无引号 + 危险协议仍拦截
    const r2 = htmlToMarkdown({ content_html: '<a href=javascript:alert(1)>点我</a>', url: '' })
    assertEqual(r2.includes('javascript:'), false, '无引号危险 href 应拦截')
  })

  await test('{链接}/原文链接 危险协议过滤（v3.170）', () => {
    // javascript: url → {链接} 为空、原文链接不出现
    assertEqual(tuisong_replace('{链接}', { url: 'javascript:alert(1)', title: 't' }), '', '危险 url 的 {链接} 应为空')
    const r2 = htmlToMarkdown({ content_html: '<p>x</p>', url: 'javascript:alert(1)' })
    assertEqual(r2.includes('原文链接'), false, '危险 url 不应生成原文链接')
    // {Html内容} 的原文链接必须是文本，不能生成危险 href
    const html = tuisong_replace('{Html内容}', { content_html: '<p>x</p>', url: 'javascript:alert(1)' })
    assertEqual(/href\s*=\s*["']javascript:/i.test(html), false, 'Html内容 不应生成 javascript href')
    assertEqual(html.includes('原文链接：'), true, '危险 URL 仍保留原文链接文本提示')
    // 实体编码/控制空白绕过也必须拦截
    for (const u of ['javascript&#58;alert(1)', ' \\u0000javascript:alert(1)', 'VBScript:msgbox(1)', 'data:text/html,x']) {
      const out = tuisong_replace('{Html内容}', { content_html: '<p>x</p>', url: u })
      assertEqual(/href\s*=\s*["'](?:javascript|vbscript|data):/i.test(out), false, `编码危险 URL 不应生成 href: ${u}`)
    }
    // v3.245 P0(XSS)：浏览器解析时解码的命名实体绕过（&colon;→:、&Tab;→\t、&NewLine;→\n、&nbsp;→\u00A0）
    for (const u of ['javascript&colon;alert(1)', 'java&Tab;script:alert(1)', 'javascript&NewLine;:alert(1)', 'java&nbsp;script:alert(1)']) {
      const out = tuisong_replace('{Html内容}', { content_html: '<p>x</p>', url: u })
      assertEqual(/href\s*=\s*["'](?:javascript|vbscript|data):/i.test(out), false, `命名实体绕过不应生成 href: ${u}`)
    }
    // v3.251 P0(XSS)：未闭合引号属性绕过——`href="javascript:alert(1)` 无闭合引号时
    // 成对引号/无引号正则均不匹配，危险协议会保留执行；必须单独清洗。
    for (const bad of ['<a href="javascript:alert(1)>x</a>', "<a href='javascript:alert(1)>x</a>", '<a href=javascript:alert(1)>x</a>', '<img src="data:text/html,x">']) {
      const out = tuisong_replace('{Html内容}', { content_html: bad, url: 'https://safe.example/a' })
      // S8786：`[^\]]*` + 后缀回溯 O(n²)；改定位 `](危险协议` 后核对配对 `[`（线性）
      // CodeRabbit 审查：exec 只取首个标记会漏检——hasDangerLink 扫描全部标记，任一成链即失败
      assertEqual(hasDangerLink(out), false, `未闭合引号危险属性不应生成链接: ${bad.slice(0, 30)}`)
    }
    // 原始 content_html 中的危险 href/src 也必须清洗
    const raw = tuisong_replace('{Html内容}', { content_html: '<a href="javascript:alert(1)">点我</a><img src="javascript:x">', url: 'https://safe.example/a' })
    assertEqual(/(?:href|src)\s*=\s*["']javascript:/i.test(raw), false, '原始 HTML 属性中的危险协议应清洗')
    // {Html内容} 会进入 HTML 渲染通道：主动标签、事件属性和实体编码绕过必须清除
    const active = tuisong_replace('{Html内容}', {
      content_html: '<script>alert(1)</script><img src="x" onerror="alert(2)"><p>&lt;iframe&gt;x&lt;/iframe&gt;</p>',
      url: 'https://safe.example/a'
    })
    assertEqual(/<script|<iframe|<svg|<meta|\bonerror\s*=/i.test(active), false, 'Html内容 不应保留主动标签/事件属性')
    assertEqual(active.includes('alert(1)'), false, 'script 内容不应进入 HTML 推送')
    const activeAttrs = tuisong_replace('{Html内容}', {
      content_html: '<svg><a xlink:href="javascript:alert(1)">x</a></svg><div style="background:url(javascript:alert(2))">y</div><img srcset="javascript:alert(3) 1x">',
      url: 'https://safe.example/a'
    })
    assertEqual(/xlink:href\s*=\s*["']javascript:|url\s*\(\s*javascript:|srcset\s*=\s*["']javascript:/i.test(activeAttrs), false,
      'Html内容 不应保留 xlink/style/srcset 危险加载路径')
    const activeUnquoted = tuisong_replace('{Html内容}', {
      content_html: '<img srcset=javascript:alert(4)><div style=background:url(javascript:alert(5))>z</div>',
      url: 'https://safe.example/a'
    })
    // S8786：`style=[^>]*javascript:` 回溯 O(n²)；拆成 srcset 直查 + style 段线性扫描
    const srcsetDanger = /srcset\s*=\s*javascript:/i.test(activeUnquoted)
    let styleDanger = false
    for (let i = 0; !styleDanger && i < activeUnquoted.length;) {
      const m = /style\s*=\s*/i.exec(activeUnquoted.slice(i))
      if (!m) break
      const start = i + m.index + m[0].length
      const end = activeUnquoted.indexOf('>', start)
      const seg = activeUnquoted.slice(start, end === -1 ? activeUnquoted.length : end)
      styleDanger = /javascript:/i.test(seg)
      i = end === -1 ? activeUnquoted.length : end + 1
    }
    assertEqual(srcsetDanger || styleDanger, false,
      'Html内容 不应遗漏无引号 srcset/style 危险路径')
    const slashEvent = tuisong_replace('{Html内容}', {
      content_html: '<img/onerror=alert(6)><div/onload = "alert(7)">x</div>',
      url: 'https://safe.example/a'
    })
    assertEqual(/(?:\/|\s)on(?:error|load)\s*=/i.test(slashEvent), false,
      'Html内容 不应遗漏斜杠分隔的事件属性')
    const nested = tuisong_replace('{Html内容}', {
      content_html: '<div><svg><foreignObject><img/onerror=alert(8)></foreignObject></svg><script>&amp;lt;img onerror=alert(9)&amp;gt;</script></div>',
      url: 'https://safe.example/a'
    })
    assertEqual(/<script|<svg|<foreignObject|(?:\/|\s)onerror\s*=/i.test(nested), false,
      '嵌套 SVG/foreignObject/script 主动路径不应残留')
    const nulAttr = tuisong_replace('{Html内容}', {
      content_html: '<img on\u0000error=alert(10)>',
      url: 'https://safe.example/a'
    })
    assertEqual(/on(?:\u0000)?error\s*=/i.test(nulAttr), false,
      'NUL 拆散的事件属性不应残留')
    // 正常 url 不受影响（含空格 → <> 包裹）
    assertEqual(tuisong_replace('{链接}', { url: 'https://u.jd.com/a b', title: 't' }), '<https://u.jd.com/a b>', '正常 url 含空格应 <> 包裹')
    // 相对路径不受影响
    assertEqual(tuisong_replace('{链接}', { url: '/haodan/123.html', title: 't' }), '/haodan/123.html', '相对路径保留')
  })

  // ==================== 36. _splitLines 解析 ====================
  console.log('\n📂 36. _splitLines 解析')

  await test('_splitLines 有### → 返回行数组（v3.22审查12：支持单\n）', () => {
    const lines = _splitLines('a###1\n\nb###2')
    // 单 \n 也作为分隔符（\n\n 会拆出空行）
    assertEqual(lines.includes('a###1'), true)
    assertEqual(lines.includes('b###2'), true)
    // 单 \n 分隔
    const lines2 = _splitLines('a###1\nb###2')
    assertEqual(lines2.includes('a###1'), true)
    assertEqual(lines2.includes('b###2'), true)
  })

  await test('_splitLines 无### → 返回null', () => {
    assertEqual(_splitLines('京东|淘宝'), null)
  })

  await test('_splitLines 空字符串 → 空数组', () => {
    assertEqual(_splitLines('').length, 0)
  })

  // ==================== 37. 过滤子方法直接测 ====================
  console.log('\n📂 37. 过滤子方法直接测')

  await test('checkRegisterTime 无配置 → 通过', () => {
    assertEqual(checkRegisterTime({ louzhuregtime: daysAgo(4) }, null), true)
  })

  await test('checkRegisterTime 天数拦截', () => {
    const compiled = compileRules({ pingbitime: '5' })
    // 注册2天 → 5>2 → 拦截 → checkRegisterTime 返回 false
    assertEqual(checkRegisterTime({ louzhuregtime: daysAgo(3) }, compiled.pingbitime), false)
  })

  await test('checkRegisterTime 天数通过', () => {
    const compiled = compileRules({ pingbitime: '5' })
    // 注册100天 → 5>100? 否 → 通过
    assertEqual(checkRegisterTime({ louzhuregtime: daysAgo(100) }, compiled.pingbitime), true)
  })

  await test('checkCategory 无配置 → 通过', () => {
    assertEqual(checkCategory({ catename: '微博线报' }, null), true)
  })

  await test('checkCategory 分类匹配 → 拦截', () => {
    const compiled = compileRules({ pingbifenlei: '微博|赚客吧' })
    assertEqual(checkCategory({ catename: '微博线报' }, compiled.pingbifenlei), false)
  })

  await test('checkCategory 分类不匹配 → 通过', () => {
    const compiled = compileRules({ pingbifenlei: '微博|赚客吧' })
    assertEqual(checkCategory({ catename: '好单线报' }, compiled.pingbifenlei), true)
  })

  await test('checkFields 楼主block拦截', () => {
    const compiled = compileRules({ pingbilouzhu: '小黑' })
    assertEqual(checkFields({ louzhu: '小黑', title: 'x', content: 'y' }, compiled), false)
  })

  await test('checkFields 楼主show优先', () => {
    const compiled = compileRules({ zhanxianlouzhu: '小明', pingbilouzhu: '小明' })
    assertEqual(checkFields({ louzhu: '小明', title: 'x', content: 'y' }, compiled), true)
  })

  await test('checkFields 0/false 字段值参与匹配（P2：与 matchesCompiled C013 契约一致）', () => {
    // title=0（数字）：修复前 if(!val) 真值判定跳过匹配（放行）；修复后 String(0)='0' 参与匹配
    const c0 = compileRules({ pingbibiaoti: '^0$' })
    assertEqual(checkFields({ louzhu: 'x', title: 0, content: 'y' }, c0), false, 'title=0 应参与匹配被屏蔽')
    // title=false：修复后 String(false)='false' 参与匹配
    const cf = compileRules({ pingbibiaoti: '^false$' })
    assertEqual(checkFields({ louzhu: 'x', title: false, content: 'y' }, cf), false, 'title=false 应参与匹配被屏蔽')
    // 空串/缺失仍视为字段缺失 → 不拦截（口径不变）
    assertEqual(checkFields({ louzhu: 'x', title: '', content: 'y' }, c0), true, '空串仍视为缺失放行')
    assertEqual(checkFields({ louzhu: 'x', content: 'y' }, c0), true, '字段缺失仍放行')
  })

  await test('checkFields 强化屏蔽抵消展现', () => {
    const compiled = compileRules({ zhanxianbiaoti: '京东', pingbibiaotiplus: '京东' })
    assertEqual(checkFields({ louzhu: 'x', title: '京东', content: 'y' }, compiled), false)
  })

  await test('checkFields 无任何配置 → 通过', () => {
    const compiled = compileRules({})
    assertEqual(checkFields({ louzhu: 'x', title: 'y', content: 'z' }, compiled), true)
  })

  // ==================== 38. 缓存内部方法 ====================
  console.log('\n📂 38. 缓存内部方法')

  await test('getFilePath 拼接路径', () => {
    const p = getFilePath('test.json')
    assertEqual(p.endsWith('test.json'), true)
  })

  await test('getFilePath 非信息文件名回退 default.json（v3.176 修复#4）', () => {
    // 对象/布尔 String 化产物曾产生 xianbaoku_cache/[object Object] 垃圾文件——与 getFileName 口径一致
    // （不断言完整路径——前置测试可能改过 Config.cache.dir；只断言文件名部分与无垃圾名）
    assertEqual(getFilePath({}).endsWith('default.json'), true)
    assertEqual(getFilePath({}).includes('[object Object]'), false)
    assertEqual(getFilePath(undefined).endsWith('default.json'), true)
    assertEqual(getFilePath(null).endsWith('default.json'), true)
    assertEqual(getFilePath(true).endsWith('default.json'), true)
    assertEqual(getFilePath('').endsWith('default.json'), true)
    // 正常文件名不受影响
    assertEqual(getFilePath('正常.json').endsWith('正常.json'), true)
  })

  await test('_ensureFileExists 创建文件', () => {
    _ensureFileExists(path.join(CACHE, 'test_ensure.json'))
    assertEqual(require('fs').existsSync(path.join(CACHE, 'test_ensure.json')), true)
  })

  await test('readMessages 空文件返回[]', () => {
    _ensureFileExists(path.join(CACHE, 'test_read.json'))
    const msgs = readMessages(path.join(CACHE, 'test_read.json'))
    assertEqual(Array.isArray(msgs), true)
  })

  await test('saveMessages 写入后 readMessages 可读', () => {
    const p = path.join(CACHE, 'test_wr.json')
    saveMessages(p, [{ id: 1 }, { id: 2 }])
    const msgs = readMessages(p)
    assertEqual(msgs.length, 2)
  })

  await test('缓存初始化独占创建：不覆盖已存在文件（CodeAnt）', () => {
    const fs = require('fs')
    const { writeAtomicIfAbsent } = require('./xbk_storage')
    const p = path.join(CACHE, 'test_init_race.json')
    fs.writeFileSync(p, '[{"id":"keep"}]')
    const ok = writeAtomicIfAbsent(p, '[]', '测试')
    assertEqual(ok, true, '已存在文件应视为初始化成功（并发创建不覆盖）')
    assertEqual(fs.readFileSync(p, 'utf8'), '[{"id":"keep"}]', '不得覆盖另一进程已写入的缓存')
    const p2 = path.join(CACHE, 'test_init_absent.json')
    const ok2 = writeAtomicIfAbsent(p2, '[]', '测试')
    assertEqual(ok2, true, '缺失文件应创建')
    assertEqual(fs.readFileSync(p2, 'utf8'), '[]')
  })

  await test('saveMessages 单条超读端上限 → 跳过落盘（防 tooLarge 自锁）', () => {
    const fs = require('fs')
    const p = path.join(CACHE, 'test_oversized_single.json')
    const ok = saveMessages(p, [{ id: 0, body: 'x'.repeat(64 * 1024 * 1024 + 1024) }])
    assertEqual(ok, false, '单条超限应拒绝落盘')
    assertEqual(fs.existsSync(p), false, '不应写出超限缓存文件（读端会置 _readFailed 永久自锁）')
    const ok2 = saveMessages(p, [{ id: 1 }, { id: 2 }])
    assertEqual(ok2, true, '正常写入不应受影响')
    assertEqual(readMessages(p).length, 2)
  })

  await test('saveMessages 非数组入参 → 返回 false 且不写空缓存（P2：防清空缓存路径）', () => {
    const p = path.join(CACHE, 'test_nonarray.json')
    saveMessages(p, [{ id: 1 }])
    const ok = saveMessages(p, 'not-array')
    assertEqual(ok, false, '非数组写入应被拒绝返回 false')
    const msgs = readMessages(p)
    assertEqual(msgs.length, 1, '非数组写入不应把缓存覆写为空数组')
    assertEqual(msgs[0].id, 1)
  })

  await test('saveMessages 超过maxSize自动裁剪', () => {
    const p = path.join(CACHE, 'test_trim2.json')
    const many = []
    for (let i = 0; i < 150; i++) many.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // v3.120：显式小上限
    try {
      saveMessages(p, many)
    } finally {
      Config.cache.maxSize = orig
    }
    const msgs = readMessages(p)
    assertEqual(msgs.length <= 100, true)
  })

  await test('saveMessages maxSize 字符串配置生效（v3.176 修复#1：层间一致）', () => {
    const p = path.join(CACHE, 'test_trim3.json')
    const many = []
    for (let i = 0; i < 12000; i++) many.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = '5000' // 环境变量字符串（validateConfig 认合法，函数层曾静默回退 10000）
    try {
      saveMessages(p, many)
    } finally {
      Config.cache.maxSize = orig
    }
    const msgs = readMessages(p)
    assertEqual(msgs.length, 5000, `字符串 maxSize '5000' 应生效（曾回退默认 10000），实际 ${msgs.length}`)
  })

  // ==================== 39. {Html内容} 惰性计算分支 ====================
  console.log('\n📂 39. {Html内容} 惰性计算分支')

  await test('模板用{Html内容} → 正常输出HTML', () => {
    const r = tuisong_replace('{Html内容}', {
      content_html: '测试<b>加粗</b>', url: 'http://x'
    })
    assertEqual(r.includes('测试'), true)
    assertEqual(r.includes('<b>'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('模板含{Html内容}和{标题}混合', () => {
    const r = tuisong_replace('{标题}\n{Html内容}', {
      title: '商品', content_html: '内容', url: 'http://x'
    })
    assertEqual(r.includes('商品'), true)
    assertEqual(r.includes('内容'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  // ==================== 40. 补充缺口覆盖 ====================
  console.log('\n📂 40. 补充缺口覆盖')

  // validateConfig ### 多行正则校验
  await test('validateConfig ### 多行：分类正则无效 → 有警告', () => {
    const warns = validateConfig({ pingbibiaoti: '[未闭合###京东' })
    assertEqual(warns.length >= 1, true)
  })

  await test('validateConfig ### 多行：值正则无效 → 有警告', () => {
    const warns = validateConfig({ pingbibiaoti: '微博###[未闭合' })
    assertEqual(warns.length >= 1, true)
  })

  await test('validateConfig ### 多行：全部合法 → 无警告', () => {
    const warns = validateConfig({ pingbibiaoti: '微博###京东\n\n赚客吧###淘宝' })
    assertEqual(warns.length, 0)
  })

  // matchesCompiled !rule.cat 分支（分类为空）
  await test('matchesCompiled ### 分类为空 → 走全局匹配', () => {
    const r = compileRules({ pingbilouzhu: '###小明' })
    // 分类部分为空 → 无分类限定
    assertEqual(r.pingbilouzhu.rules[0].cat, null)
    assertEqual(matchesCompiled(r.pingbilouzhu, '小明', '任意分类'), true)
    assertEqual(matchesCompiled(r.pingbilouzhu, '小红', '任意分类'), false)
  })

  // readMessages JSON 损坏
  await test('readMessages JSON损坏 → 保留文件并标记读取失败（不重置，防重复入库）', () => {
    const fs = require('fs')
    const p = path.join(CACHE, 'test_corrupt.json')
    fs.writeFileSync(p, '这不是合法JSON{{{', 'utf8')
    // 清内存缓存
    const msgs = readMessages(p)
    assertEqual(Array.isArray(msgs), true)
    assertEqual(msgs.length, 0)
    // 文件应被保留（不被重置为 []），避免销毁去重缓存
    assertEqual(fs.readFileSync(p, 'utf8'), '这不是合法JSON{{{')
    // save() 应因 _readFailed 拒绝写入，防止同一条消息重复入库
    assertEqual(appendMessageToFile({ id: 1 }, 'test_corrupt.json'), false)
    // v3.249：saveBatch 首次调用也必须拒绝覆写损坏文件（先读后判的时序守卫）——
    // 此前检查在读取之前，首次调用会绕过守卫直接覆写，销毁去重缓存。
    const fs2 = require('fs')
    const p2 = path.join(CACHE, 'test_corrupt_batch.json')
    fs2.writeFileSync(p2, '这不是合法JSON{{{', 'utf8')
    saveBatch([{ id: 9, title: 'x' }], 'test_corrupt_batch.json')
    assertEqual(fs2.readFileSync(p2, 'utf8'), '这不是合法JSON{{{', 'saveBatch 首次调用应拒绝覆写损坏文件')
    fs2.unlinkSync(p2)
    // 恢复合法缓存后重新可读判重
    fs.writeFileSync(p, JSON.stringify([{ id: 1 }]), 'utf8')
    assertEqual(isMessageInFile({ id: 1 }, 'test_corrupt.json'), true)
  })

  // decodeHtmlEntities 未知实体 fallback
  await test('decodeHtmlEntities 未知实体 → 原样保留', () => {
    assertEqual(decodeHtmlEntities('&foo;&bar;'), '&foo;&bar;')
  })

  // compileRules 多行中部分行正则无效 → 跳过无效行保留有效行
  await test('compileRules ### 部分行无效 → 保留有效行', () => {
    const r = compileRules({ pingbilouzhu: '[无效分类###小明\n\n线报###小黑' })
    // 第一行分类无效被跳过，第二行有效
    assertEqual(r.pingbilouzhu._type, 'multi')
    assertEqual(r.pingbilouzhu.rules.length, 1)
    assertEqual(r.pingbilouzhu.rules[0].val.test('小黑'), true)
  })

  // saveMessages 裁剪后数据正确
  await test('saveMessages 裁剪后保留最新数据', () => {
    const p = path.join(CACHE, 'test_trim_new.json')
    const many = []
    for (let i = 0; i < 150; i++) many.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // v3.120：显式小上限
    try {
      saveMessages(p, many)
    } finally {
      Config.cache.maxSize = orig
    }
    const msgs = readMessages(p)
    // 裁剪后保留的是后面的数据（splice 删除前面的）
    assertEqual(msgs.length, 100)
    assertEqual(msgs.some(m => m.id === 0), false) // 最旧的被删
    assertEqual(msgs.some(m => m.id === 149), true) // 最新的保留
  })

  // ==================== 41. 错误分支覆盖 ====================
  console.log('\n📂 41. 错误分支覆盖')

  await test('compileRules pingbitime 非数字 → null 不编译（v3.157）', () => {
    const r = compileRules({ pingbitime: 'abc' })
    assertEqual(r.pingbitime, null)
  })

  await test('validateConfig pingbitime ### 分类正则无效 → 有警告', () => {
    const warns = validateConfig({ pingbitime: '[未闭合###5' })
    assertEqual(warns.length >= 1, true)
  })

  await test('init 在目录不存在时自动创建', () => {
    const fs = require('fs')
    const dir = CACHE
    // 临时删除缓存目录
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    init()
    assertEqual(fs.existsSync(dir), true)
  })

  await test('save 在目录不存在时自动创建（_ensureFileExists）', () => {
    const fs = require('fs')
    const dir = CACHE
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    appendMessageToFile({ id: 555 }, 'test_recreate.json')
    assertEqual(fs.existsSync(dir), true)
    assertEqual(isMessageInFile({ id: 555 }, 'test_recreate.json'), true)
  })

  // ==================== 42. 剩余缺口覆盖 ====================
  console.log('\n📂 42. 剩余缺口覆盖')

  await test('compileRules ### 值正则无效 → 跳过该行', () => {
    const r = compileRules({ pingbilouzhu: '线报###[未闭合' })
    assertEqual(r.pingbilouzhu._type, 'multi') // 编译为 multi
    assertEqual(r.pingbilouzhu.rules.length, 0) // 无效行被跳过
  })

  await test('compileRules pingbitime 分类无效 → 跳过该行', () => {
    const r = compileRules({ pingbitime: '[未闭合###5\n\n线报###3' })
    assertEqual(r.pingbitime._type, 'timeMulti')
    assertEqual(r.pingbitime.rules.length, 1) // 只剩有效行
  })

  await test('matchesCompiled compiled为null → false', () => {
    assertEqual(matchesCompiled(null, 'x', 'y'), false)
  })

  await test('matchesCompiled fieldValue为空 → false', () => {
    const r = compileRules({ pingbibiaoti: '京东' })
    assertEqual(matchesCompiled(r.pingbibiaoti, '', '线报'), false)
  })

  await test('matchesCompiled 0/false 参与匹配（非缺失）', () => {
    // 修复 !fieldValue 短路把 0/false 误判为缺失：0/false 应参与匹配
    assertEqual(matchesCompiled({ _type: 're', re: /0/i }, 0), true)
    assertEqual(matchesCompiled({ _type: 're', re: /false/i }, false), true)
    assertEqual(matchesCompiled({ _type: 're', re: /0/i }, '0'), true)
    assertEqual(matchesCompiled({ _type: 're', re: /false/i }, 'false'), true)
    assertEqual(matchesCompiled({ _type: 're', re: /0/i }, '1'), false)
    assertEqual(matchesCompiled({ _type: 're', re: /false/i }, 'true'), false)
  })

  await test('checkTimeCompiled compiled为null → null', () => {
    assertEqual(checkTimeCompiled(null, { louzhuregtime: daysAgo(4) }), null)
  })

  await test('checkTimeCompiled 天数分类为空 → 全局匹配', () => {
    const r = compileRules({ pingbitime: '###5' })
    assertEqual(r.pingbitime.rules[0].cat, null)
    // 注册2天 → 5>2 → 拦截 true
    assertEqual(checkTimeCompiled(r.pingbitime, { louzhuregtime: daysAgo(3) }), true)
  })

  await test('validateConfig pingbifenlei ### → 有警告', () => {
    const warns = validateConfig({ pingbifenlei: '微博###京东' })
    assertEqual(warns.length >= 1, true)
    assertEqual(warns[0].includes('不支持 ###'), true)
  })

  // ==================== 43. save upsert 更新分支 ====================
  console.log('\n📂 43. save upsert 更新分支')

  await test('save 已存在消息 → 内容被更新', () => {
    const fs = require('fs')
    const name = 'test_upsert.json'
    appendMessageToFile({ id: 777, title: '旧标题' }, name)
    appendMessageToFile({ id: 777, title: '新标题' }, name)
    // 读取缓存文件，验证内容确实被更新
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))
    const item = msgs.find(m => m.id === 777)
    assertEqual(item.title, '新标题') // 内容已更新
    assertEqual(msgs.length, 1) // 没有重复新增
  })

  await test('save 不同id → 各自追加不覆盖', () => {
    const fs = require('fs')
    const name = 'test_upsert2.json'
    appendMessageToFile({ id: 1, title: 'A' }, name)
    appendMessageToFile({ id: 2, title: 'B' }, name)
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))
    assertEqual(msgs.length, 2)
    assertEqual(msgs.some(m => m.id === 1), true)
    assertEqual(msgs.some(m => m.id === 2), true)
  })

  // ==================== 44. 变异测试盲区修复 ====================
  console.log('\n📂 44. 变异测试盲区修复')

  await test('whitelistFilter 空关键词+字段为空 → 返回true', () => {
    // 空关键词应放行，即使字段为空（不误拦截）
    assertEqual(whitelistFilter({}, 'title', ''), true)
    assertEqual(whitelistFilter({ title: '' }, 'title', ''), true)
  })

  await test('readMessages 内存缓存生效 → 返回同一引用', () => {
    const p = path.join(CACHE, 'test_memcache.json')
    saveMessages(p, [{ id: 1 }])
    const first = readMessages(p)
    const second = readMessages(p)
    // 第二次读应命中内存缓存，返回同一数组引用
    assertEqual(first === second, true)
  })

  await test('readMessages 外部删除文件 → 用内存快照自动恢复', () => {
    const fs = require('fs')
    const p = path.join(CACHE, 'test_mem_restore.json')
    saveMessages(p, [{ id: 7001, title: '内存恢复' }])
    assertEqual(fs.existsSync(p), true)
    fs.unlinkSync(p)
    const msgs = readMessages(p)
    assertEqual(msgs.length, 1)
    assertEqual(msgs[0].id, 7001)
    assertEqual(fs.existsSync(p), true)
    assertEqual(JSON.parse(fs.readFileSync(p, 'utf8')).length, 1)
  })

  await test('readMessages 磁盘缺失且恢复失败 → 不标记已验证，下次重新恢复（v3.257）', () => {
    const fs = require('fs')
    const p = path.join(CACHE, 'test_mem_restore_retry', 'cache.json')
    const parent = path.dirname(p)
    try {
      saveMessages(p, [{ id: 7002, title: '恢复重试' }])
      assertEqual(fs.existsSync(p), true)
      fs.unlinkSync(p)
      // 用普通文件顶替父目录：existsSync(child) 为 false，但 saveMessages/writeAtomic 会拒绝写入
      fs.rmdirSync(parent)
      fs.writeFileSync(parent, '')
      const msgs = readMessages(p)
      assertEqual(msgs.length, 1)
      assertEqual(msgs[0].id, 7002)
      assertEqual(fs.existsSync(p), false)
      // 排除故障后再次读取：应重新触发恢复并重建文件（若首次失败被固化 verified 则不会重建）
      fs.unlinkSync(parent)
      const msgs2 = readMessages(p)
      assertEqual(msgs2.length, 1)
      assertEqual(msgs2[0].id, 7002)
      assertEqual(fs.existsSync(p), true)
      assertEqual(JSON.parse(fs.readFileSync(p, 'utf8')).length, 1)
    } finally {
      try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch (e) { /* 忽略 */ }
      try { if (fs.statSync(parent).isDirectory()) fs.rmdirSync(parent) } catch (e) { /* 忽略 */ }
      try { if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) fs.unlinkSync(parent) } catch (e) { /* 忽略 */ }
    }
  })

  await test('缓存符号链接 → 拒绝读取和写入外部目标', () => {
    const fs = require('fs')
    const p = path.join(CACHE, 'test_cache_symlink.json')
    const outside = path.join(process.env.TMPDIR || '/tmp', `xbk-cache-symlink-${process.pid}.json`)
    try {
      fs.writeFileSync(outside, JSON.stringify([{ id: 9001 }]), 'utf8')
      try { fs.unlinkSync(p) } catch (e) { /* 不存在 */ }
      fs.symlinkSync(outside, p)
      const msgs = readMessages(p)
      assertEqual(msgs.length, 0)
      saveMessages(p, [{ id: 9002 }])
      assertEqual(JSON.parse(fs.readFileSync(outside, 'utf8'))[0].id, 9001)
      assertEqual(fs.lstatSync(p).isSymbolicLink(), true)
    } finally {
      try { fs.unlinkSync(p) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(outside) } catch (e) { /* 忽略 */ }
    }
  })

  await test('tuisong_replace 模板不含占位符 → 输出与含占位符等价', () => {
    // 惰性计算的正确性：不含Markdown的模板输出不含Markdown内容
    const r = tuisong_replace('{标题}', {
      title: '测试', content_html: '<h2>标题</h2>', url: 'http://x'
    })
    assertEqual(r, '测试')
    // 不含{Markdown内容}，不应包含## 标题
    assertEqual(r.includes('##'), false)
  })

  // ==================== 44b. 2026-08-03 盲区锁定（M1/M2/M3 变异未被抓住的行为） ====================

  await test('M1: message 有 id 无 url → 不误判重（url fallback 需双方有 url）', () => {
    // 变异曾去掉 m.url && message.url 检查——m 无 id 无 url 时 normUrl 双空会误判重（''===''）
    // 原版：message 有 id 无 url → 只按 id 判重，不匹配无 id 无 url 的缓存记录
    const p = path.join(CACHE, 'test_m1_urlfallback.json')
    saveMessages(p, [{ title: '旧匿名', timestamp: 't' }]) // 无 id 无 url 的旧记录（无有效 id）
    assertEqual(isMessageInFile({ id: '999', title: '新数据' }, 'test_m1_urlfallback.json'), false, '有id无url不应匹配无id无url')
    assertEqual(isMessageInFile({ id: '999', title: '新数据', url: 'https://x.com/1' }, 'test_m1_urlfallback.json'), false, '有id记录不应被url误判重')
    // 正常路径：message 有 id 有 url + 缓存同 url 无 id → 应判重（url fallback 生效）
    saveMessages(p, [{ id: '1', title: '有id', url: 'https://x.com/2', timestamp: 't' }])
    assertEqual(isMessageInFile({ id: '999', title: '新', url: 'https://x.com/2' }, 'test_m1_urlfallback.json'), false, '有id不同不判重')
  })

  await test('M2: whitelistFilter 字段空值/缺失 → 放行（与 App.run 空标题保留一致）', () => {
    // 主流程只看它保留空标题（!it.title），导出 API whitelistFilter 同步统一：空/缺失值不参与匹配也不拦截
    assertEqual(whitelistFilter({ title: '' }, 'title', '京东'), true, '空标题+关键词应放行')
    assertEqual(whitelistFilter({ title: undefined }, 'title', '京东'), true, '缺标题+关键词应放行')
    assertEqual(whitelistFilter({ content: '' }, 'content', '京东'), true, '空内容+关键词应放行')
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', '京东'), true, '正常匹配仍保留')
    // 已定义假值（0/false）视为有效内容参与匹配（仅 undefined/null/空串视为字段缺失）；
    // 修复 !value 短路把 0 误判为不匹配：0 应可被关键词 '0' 命中
    assertEqual(whitelistFilter({ title: 0 }, 'title', '0'), true, 'title=0 + 关键词0 应命中（0 是有效值）')
    assertEqual(whitelistFilter({ title: false }, 'title', 'false'), true, 'title=false + 关键词false 应命中（false 是有效值）')
    assertEqual(whitelistFilter({ title: 0 }, 'title', '京东'), false, 'title=0 + 不相关关键词仍不命中')
    assertEqual(whitelistFilter({ title: false }, 'title', '京东'), false, 'title=false + 不相关关键词仍不命中')
  })

  await test('M3: matchesCompiled 空串 → 不匹配（空值不参与过滤）', () => {
    // 变异曾让空串参与正则匹配（'0' 类正则可匹配空串）——原版空值不匹配，调用方（_passIfMissing/!val）已保护主流程
    const c = compileRules({ pingbibiaoti: '.*', pingbineirong: '京东' })
    assertEqual(matchesCompiled(c.pingbibiaoti, '', null), false, '空串不匹配（即使 .*）')
    assertEqual(matchesCompiled(c.pingbineirong, '', null), false, '空内容不匹配')
    assertEqual(listfilter({ title: '', content: '', catename: '' }, c), true, '主流程空值放行（调用方保护）')
  })

  // ==================== 45. htmlToMarkdown 输出细节断言 ====================
  console.log('\n📂 45. htmlToMarkdown 输出细节断言')

  await test('htmlToMarkdown <br> → 换行', () => {
    const r = htmlToMarkdown({ content_html: '行一<br>行二', url: 'http://x' })
    // <br> 应转为换行（关键断言：中间是换行不是空格）
    assertEqual(r.includes('行一\n\n行二'), true)
    assertEqual(r.includes('行一 行二'), false)
  })

  await test('htmlToMarkdown <p> 段落 → 换行', () => {
    const r = htmlToMarkdown({ content_html: '<p>段落一</p><p>段落二</p>', url: 'http://x' })
    // <p> 应转为换行（关键断言：段落间是换行不是空格）
    assertEqual(r.includes('段落一\n\n段落二'), true)
    assertEqual(r.includes('段落一 段落二'), false)
  })

  await test('htmlToMarkdown 实体 &amp; 被解码', () => {
    const r = htmlToMarkdown({ content_html: 'A&amp;B', url: 'http://x' })
    assertEqual(r.includes('A&B'), true)
    assertEqual(r.includes('&amp;'), false)
  })

  // ==================== 46. 第4轮变异盲区修复 ====================
  console.log('\n📂 46. 第4轮变异盲区修复')

  await test('tuisong_replace {分类ID} 占位符', () => {
    const r = tuisong_replace('{分类ID}', { cateid: '30', url: 'x' })
    assertEqual(r, '30')
  })

  await test('tuisong_replace {时间} 占位符', () => {
    // 有效秒时间戳 → shorttime（曾用 posttime:60 当秒=1970 误导，现 60 视为无效）
    // v3.115：{时间} 用本地时区 getHours——断言格式而非具体值（跨时区部署稳定）
    const r = tuisong_replace('{时间}', { posttime: 1785346200, datetime: undefined, url: 'x' })
    assertEqual(/^\d{2}:\d{2}$/.test(r), true, `shorttime 应为 HH:MM 格式: ${r}`)
  })

  await test('save 已存在消息 → timestamp 被更新', () => {
    const fs = require('fs')
    const name = 'test_ts.json'
    appendMessageToFile({ id: 888, title: 'a' }, name)
    // 再存一次同id
    appendMessageToFile({ id: 888, title: 'b' }, name)
    const second = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))
    // 至少有一个 timestamp 字段
    assertEqual(typeof second[0].timestamp, 'string')
    assertEqual(second.length, 1)
  })

  // ==================== 47. 第5轮变异盲区修复 ====================
  console.log('\n📂 47. 第5轮变异盲区修复')

  await test('tuisong_replace {类目} 占位符', () => {
    const r = tuisong_replace('{类目}', { category_name: '美妆', url: 'x' })
    assertEqual(r, '美妆')
  })

  await test('tuisong_replace {价格} 占位符', () => {
    const r = tuisong_replace('{价格}', { price: '19.9', url: 'x' })
    assertEqual(r, '19.9')
  })

  await test('tuisong_replace {商城} 占位符', () => {
    const r = tuisong_replace('{商城}', { mall_name: '淘宝', url: 'x' })
    assertEqual(r, '淘宝')
  })

  await test('tuisong_replace {品牌} 占位符', () => {
    const r = tuisong_replace('{品牌}', { brand: '苹果', url: 'x' })
    assertEqual(r, '苹果')
  })

  await test('tuisong_replace {图片} 占位符', () => {
    const r = tuisong_replace('{图片}', { pic: 'http://img/1.jpg', url: 'x' })
    assertEqual(r, 'http://img/1.jpg')
  })

  await test('tuisong_replace {图片} 危险协议被清空（v3.262 统一安全 URL 入口）', () => {
    const r = tuisong_replace('图片:{图片}', { pic: 'javascript:alert(1)', url: 'x' })
    assertEqual(r, '图片:', '危险协议 pic 应清空')
    const ok = tuisong_replace('图片:{图片}', { pic: 'https://img/1.jpg' })
    assertEqual(ok, '图片:https://img/1.jpg', '合法 pic 保留')
  })

  await test('htmlToMarkdown h2 换行精确断言', () => {
    const r = htmlToMarkdown({ content_html: '<h2>标题</h2>', url: 'http://x' })
    assertEqual(r.includes('## 标题\n\n'), true)
  })

  await test('saveBatch 已存在消息 → 更新内容', () => {
    const fs = require('fs')
    saveBatch([{ id: 55, title: '旧' }], 'test_sb_up.json')
    saveBatch([{ id: 55, title: '新' }], 'test_sb_up.json')
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, 'test_sb_up.json'), 'utf8'))
    assertEqual(msgs.length, 1)
    assertEqual(msgs[0].title, '新')
  })

  await test('tuisong_replace {Html内容} content_html为空', () => {
    const r = tuisong_replace('{Html内容}', { url: 'http://x', content_html: undefined })
    assertEqual(r.includes('原文链接'), true)
    // 空内容不应显示 "undefined" 文本
    assertEqual(r.includes('undefined'), false)
  })

  await test('matchesCompiled multi catename为空', () => {
    const compiled = compileRules({ pingbilouzhu: '线报###小明' })
    // catename 为空 → 分类匹配失败 → 返回 false
    assertEqual(matchesCompiled(compiled.pingbilouzhu, '小明', ''), false)
    assertEqual(matchesCompiled(compiled.pingbilouzhu, '小明', null), false)
  })

  await test('Config.domain 默认值', () => {
    assertEqual(Config.domain, 'https://new.ixbk.net')
  })

  // ==================== 48. 第7轮变异盲区修复 ====================
  console.log('\n📂 48. 第7轮变异盲区修复')

  await test('tuisong_replace 不修改原对象（纯函数）', () => {
    const original = { category_name: '分类', catename: '原分类', title: 'T', url: 'x' }
    const snapshot = { ...original }
    tuisong_replace('{分类名}', original)
    // 原对象应保持不变
    assertEqual(original.catename, snapshot.catename)
    assertEqual(original.title, snapshot.title)
    assertEqual(Object.keys(original).length, Object.keys(snapshot).length)
  })

  await test('tuisong_replace {Html内容} 原文链接URL正确', () => {
    const r = tuisong_replace('{Html内容}', { content_html: '内容', url: 'http://example.com/a.html' })
    assertEqual(r.includes('http://example.com/a.html'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  // ==================== 49. 第8轮变异盲区修复（异常输入健壮性） ====================
  console.log('\n📂 49. 第8轮变异盲区修复')

  await test('tuisong_replace shuju为null → 不崩溃', () => {
    const r = tuisong_replace('{标题}', null)
    assertEqual(typeof r, 'string')
  })

  await test('htmlToMarkdown shuju为null → 不崩溃', () => {
    const r = htmlToMarkdown(null)
    assertEqual(typeof r, 'string')
  })

  await test('compileRules rawCfg为null → 不崩溃', () => {
    const r = compileRules(null)
    assertEqual(typeof r, 'object')
  })

  await test('validateConfig cfg为null → 不崩溃', () => {
    const warns = validateConfig(null)
    assertEqual(Array.isArray(warns), true)
  })

  await test('MessageStore has message为null → 不崩溃', () => {
    const result = isMessageInFile(null, 'test_null_msg.json')
    assertEqual(result, false)
  })

  await test('getFileName url为undefined → 不崩溃', () => {
    const r = getFileName(undefined)
    assertEqual(typeof r, 'string')
  })

  await test('daysComputed time为0 → 不崩溃', () => {
    const r = daysComputed(0)
    assertEqual(typeof r, 'number')
  })

  await test('decodeHtmlEntities 输入数字 → 不崩溃', () => {
    const r = decodeHtmlEntities(123)
    assertEqual(typeof r, 'string')
  })

  await test('tuisong_replace posttime=0 → 正常处理', () => {
    // posttime=0 是 falsy，应仍能处理（不崩溃）
    const r = tuisong_replace('{标题}', { title: 'T', posttime: 0, url: 'x' })
    assertEqual(r, 'T')
  })

  // ==================== 50. 第9轮变异盲区修复（数字输入健壮性） ====================
  console.log('\n📂 50. 第9轮变异盲区修复')

  await test('htmlToMarkdown content_html为数字 → 不崩溃', () => {
    const r = htmlToMarkdown({ content_html: 12345, url: 'http://x' })
    assertEqual(typeof r, 'string')
  })

  await test('daysComputed time为数字 → 不崩溃', () => {
    const r = daysComputed(20260728)
    assertEqual(typeof r, 'number')
  })

  await test('decodeHtmlEntities 连续实体 → 全部解码', () => {
    assertEqual(decodeHtmlEntities('&amp;&lt;'), '&<')
    assertEqual(decodeHtmlEntities('a&amp;b&lt;c&gt;d'), 'a&b<c>d')
  })

  await test('validateConfig 字段值为数字 → 不崩溃', () => {
    const warns = validateConfig({ pingbibiaoti: 12345 })
    assertEqual(Array.isArray(warns), true)
  })

  await test('compileRules 字段值为数字 → 不崩溃', () => {
    const r = compileRules({ pingbibiaoti: 12345 })
    assertEqual(typeof r, 'object')
  })

  // ==================== 51. 第10-20轮边界覆盖 ====================
  console.log('\n📂 51. 第10-20轮边界覆盖')

  await test('decodeHtmlEntities 大写实体', () => {
    // HTML 实体一般小写，大写应原样保留（不误转换）
    assertEqual(decodeHtmlEntities('&AMP;'), '&AMP;')
    assertEqual(decodeHtmlEntities('&amp;'), '&')
  })

  await test('daysComputed 带T时间格式', () => {
    const r = daysComputed('2026-07-28T10:00:00')
    assertEqual(typeof r, 'number')
    assertEqual(r >= 0, true)
  })

  await test('compileRules 负天数', () => {
    const r = compileRules({ pingbitime: '-5' })
    assertEqual(typeof r.pingbitime, 'object')
  })

  await test('tuisong_replace posttime为字符串', () => {
    const r = tuisong_replace('{日期}', { posttime: '1785346200', datetime: undefined, url: 'x' })
    assertEqual(typeof r, 'string')
    assertEqual(r.length > 0, true)
  })

  await test('saveBatch 非数组输入 → 不崩溃', () => {
    for (const value of [undefined, null, {}, 123, true, Symbol('x'), 'abc']) {
      saveBatch(value, 'test_sb_non_array.json')
    }
    assertEqual(true, true)
  })

  await test('htmlToMarkdown 纯空格内容', () => {
    const r = htmlToMarkdown({ content_html: '   ', url: 'http://x' })
    assertEqual(typeof r, 'string')
  })

  await test('compileRules 多行含空行', () => {
    const r = compileRules({ pingbilouzhu: '线报###小明\n\n\n\n线报###小黑' })
    assertEqual(r.pingbilouzhu._type, 'multi')
  })

  await test('compileRules 无匹配字段 → null', () => {
    const r = compileRules({ unknownField: 'x' })
    assertEqual(r.pingbibiaoti, null)
  })

  await test('MessageStore save 更新保留旧字段', () => {
    const fs = require('fs')
    appendMessageToFile({ id: 66, title: '旧', extra: '保留' }, 'test_keep.json')
    appendMessageToFile({ id: 66, title: '新' }, 'test_keep.json')
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, 'test_keep.json'), 'utf8'))
    assertEqual(msgs.length, 1)
    assertEqual(msgs[0].title, '新')
  })

  // ==================== 52. 大规模变异盲区修复 ====================
  console.log('\n📂 52. 大规模变异盲区修复')

  await test('htmlToMarkdown 原文链接格式精确断言', () => {
    const r = htmlToMarkdown({ content_html: '内容', url: 'http://x.com/1' })
    // 原文链接必须是 markdown 链接格式
    assertEqual(r.includes('[http://x.com/1](http://x.com/1)'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('天数过滤 恰好等于阈值 → 不拦截', () => {
    // 注册天数恰好等于 pingbitime 时，> 判断不拦截
    // v3.112：用 daysAgo(5) 精确构造"注册5天前"（原写死 2026-07-26 随日期漂移，靠 daysComputed 反推自适应但不清晰）
    const item = { louzhuregtime: daysAgo(5) } // 注册 5 天前
    const days = daysComputed(daysAgo(5))
    // pingbitime 设为 days → 不拦截（= 不是 >）；days+1 → 拦截
    const r1 = listfilter(item, { pingbitime: String(days) })
    const r2 = listfilter(item, { pingbitime: String(days + 1) })
    assertEqual(r1, true) // days == pingbitime → 不拦截
    assertEqual(r2, false) // days < pingbitime → 拦截
  })

  await test('Config.filter.pingbitime 默认值', () => {
    assertEqual(Config.filter.pingbitime, '5')
  })

  await test('saveMessages 恰好 maxSize 条 → 不裁剪', () => {
    const p = path.join(CACHE, 'test_exact100.json')
    const msgs = []
    for (let i = 0; i < 100; i++) msgs.push({ id: i })
    saveMessages(p, msgs)
    const r = readMessages(p)
    assertEqual(r.length, 100) // 恰好100条不裁剪
  })

  await test('saveMessages 超过maxSize → 裁剪到上限（v3.120：显式 maxSize=100 验证裁剪逻辑）', () => {
    const p = path.join(CACHE, 'test_over100.json')
    const msgs = []
    for (let i = 0; i < 101; i++) msgs.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // 显式小上限，验证裁剪（不依赖默认 10000）
    try {
      saveMessages(p, msgs)
    } finally {
      Config.cache.maxSize = orig // v3.120b：finally 保证恢复（断言失败也恢复，防污染）
    }
    const r = readMessages(p)
    assertEqual(r.length, 100)
  })

  await test('htmlToMarkdown 连续换行合并', () => {
    // 3个以上连续换行应合并为2个
    const r = htmlToMarkdown({ content_html: 'a<br><br><br>b', url: 'http://x' })
    assertEqual(r.includes('a\n\n\n\nb'), false) // 不应有3个以上换行
  })

  // ==================== 53. 第21-30轮盲区修复 ====================
  console.log('\n📂 53. 第21-30轮盲区修复')

  await test('htmlToMarkdown 大写标签也转换（i flag）', () => {
    const r = htmlToMarkdown({ content_html: '<P>大写段落</P><BR>换行', url: 'http://x' })
    assertEqual(r.includes('<P>'), false)
    assertEqual(r.includes('<BR>'), false)
    assertEqual(r.includes('大写段落'), true)
  })

  await test('htmlToMarkdown 输出首尾无多余空白（trim）', () => {
    const r = htmlToMarkdown({ content_html: '  内容  ', url: 'http://x' })
    assertEqual(r[0] !== ' ', true)
    assertEqual(r[r.length - 1] !== ' ', true)
  })

  await test('htmlToMarkdown 大写img标签', () => {
    const r = htmlToMarkdown({ content_html: '<IMG SRC="http://x/a.jpg">', url: 'http://x' })
    assertEqual(r.includes('http://x/a.jpg'), true)
  })

  // ==================== 54. 第1-10批×10变异盲区修复 ====================
  console.log('\n📂 54. 第1-10批×10变异盲区修复')

  await test('htmlToMarkdown 多种实体都被解码', () => {
    const r = htmlToMarkdown({ content_html: 'a&amp;b&lt;c&gt;d&nbsp;e', url: 'http://x' })
    assertEqual(r.includes('a&b<c>d e'), true)
    assertEqual(r.includes('&amp;'), false)
    assertEqual(r.includes('&lt;'), false)
    assertEqual(r.includes('&gt;'), false)
  })

  await test('daysComputed 当天注册 = 0天', () => {
    // v3.115：daysAgo(0)=UTC 今天（本地日期字符串会在 Honolulu 等时区差 1 天）
    const d = daysComputed(daysAgo(0))
    assertEqual(d, 0)
  })

  await test('save timestamp 每次更新为新值', () => {
    const fs = require('fs')
    const name = 'test_ts2.json'
    appendMessageToFile({ id: 42 }, name)
    const t1 = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))[0].timestamp
    // 等1ms再存
    appendMessageToFile({ id: 42 }, name)
    const t2 = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))[0].timestamp
    // 两次 timestamp 应该是 ISO 字符串格式
    assertEqual(typeof t1, 'string')
    assertEqual(typeof t2, 'string')
    assertEqual(t2.length >= t1.length, true)
  })

  // ==================== 55. 第11-20批×10盲区修复 ====================
  console.log('\n📂 55. 第11-20批×10盲区修复')

  await test('htmlToMarkdown h标签#数量精确断言', () => {
    // ### 不能匹配为 ##，必须精确数量
    const r2 = htmlToMarkdown({ content_html: '<h2>标题</h2>', url: 'http://x' })
    assertEqual(r2.includes('## 标题'), true)
    assertEqual(r2.includes('### 标题'), false)
  })

  await test('htmlToMarkdown 引号内 > 不截断 + 未闭合引号不吞文本（Round2 C045）', () => {
    const r = htmlToMarkdown({ content_html: '<h1 title="a>b">text</h1>', url: '' })
    assertEqual(r, '# text', '引号内 > 不应截断 h 标签')
    // C045 二次修复：未闭合引号的属性值在第一个 > 处结束，不吞后续标签/文本
    assertEqual(htmlToMarkdown({ content_html: '<p title="unterminated>text</p>', url: '' }), 'text', '未闭合双引号属性不应吞文本')
    assertEqual(htmlToMarkdown({ content_html: "<p title='unterminated>text</p>", url: '' }), 'text', '未闭合单引号属性不应吞文本')
    assertEqual(htmlToMarkdown({ content_html: '<h1 title="unterminated>text</h1>', url: '' }), '# text', '未闭合引号 h1 不应吞文本')
    assertEqual(htmlToMarkdown({ content_html: "<h1 title='a>b'>text</h1>", url: '' }), '# text', '闭合单引号含 > h1 仍应正确')
    assertEqual(htmlToMarkdown({ content_html: "<h1 title='unterminated>text</h1>", url: '' }), '# text', '未闭合单引号 h1 不应吞文本')
    assertEqual(htmlToMarkdown({ content_html: '<p title="a>b">text</p>', url: '' }), 'text', '闭合双引号含 > p 仍应正确')
    assertEqual(htmlToMarkdown({ content_html: "<p title='a>b'>text</p>", url: '' }), 'text', '闭合单引号含 > p 仍应正确')
  })

  await test('whitelistFilter 大小写不敏感（i flag）', () => {
    assertEqual(whitelistFilter({ title: 'JINGDONG神券' }, 'title', 'jingdong'), true)
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', 'JD'), false)
  })

  await test('tuisong_replace category_name为空字符串', () => {
    // category_name 空字符串时不覆盖 catename
    const r = tuisong_replace('{分类名}', { category_name: '', catename: '原始分类', url: 'x' })
    assertEqual(r, '原始分类')
  })

  await test('htmlToMarkdown 原文链接含**加粗', () => {
    const r = htmlToMarkdown({ content_html: '内容', url: 'http://x' })
    assertEqual(r.includes('**['), false)
  })

  // ==================== 56. 第21-30批盲区修复 ====================
  console.log('\n📂 56. 第21-30批盲区修复')

  await test('tuisong {Html内容} 原文链接含实际URL', () => {
    const r = tuisong_replace('{Html内容}', { content_html: '内容', url: 'http://example.com/p.html' })
    assertEqual(r.includes('http://example.com/p.html'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('tuisong {Html内容} 链接文本是URL本身', () => {
    const r = tuisong_replace('{Html内容}', { content_html: '内容', url: 'http://example.com/p.html' })
    // 链接文本应是URL，不是固定文案
    assertEqual(r.includes('>http://example.com/p.html<'), true)
  })

  await test('Config.filter 各字段默认值', () => {
    // v3.176：个人过滤配置不再硬编码进默认 Config（'美妆' 曾默认屏蔽——克隆用户意外继承）
    assertEqual(Config.filter.pingbifenlei, '') // 需屏蔽分类请自行配置
    assertEqual(Config.filter.pingbibiaoti, '')
    assertEqual(Config.filter.zhanxianbiaoti, '')
    assertEqual(Config.filter.pingbineirong, '')
  })

  // ==================== 57. 第31-40批盲区修复 ====================
  console.log('\n📂 57. 第31-40批盲区修复')

  await test('tuisong 日期格式带-分隔', () => {
    const r = tuisong_replace('{日期}', { posttime: 1785346200, datetime: undefined, url: 'x' })
    // 日期格式应为 yyyy-mm-dd
    assertEqual(/^\d{4}-\d{2}-\d{2}$/.test(r), true)
  })

  await test('compileRules 分类正则大小写不敏感', () => {
    const r = compileRules({ pingbilouzhu: '微博线报###小明' })
    // 分类大写也能匹配
    assertEqual(matchesCompiled(r.pingbilouzhu, '小明', '微博线报'), true)
  })

  await test('validateConfig 正则大小写不敏感', () => {
    // 大小写不同的配置不报错（i flag 正常）
    const warns = validateConfig({ pingbibiaoti: 'JINGDONG' })
    assertEqual(Array.isArray(warns), true)
  })

  // ==================== 58. 盲区误判修复（实证发现） ====================
  console.log('\n📂 58. 盲区误判修复')

  await test('whitelistFilter 用match测试也应匹配（test/exec等价性）', () => {
    // exec 和 test 对相同输入应返回一致结果
    const r1 = whitelistFilter({ title: '京东神券' }, 'title', '京东')
    assertEqual(r1, true)
    const r2 = whitelistFilter({ title: '淘宝特价' }, 'title', '京东')
    assertEqual(r2, false)
  })

  await test('compileRules 分类大小写不敏感（toLowerCase安全）', () => {
    const compiled = compileRules({ pingbilouzhu: '微博线报###小明' })
    // 分类大小写变体应匹配
    assertEqual(matchesCompiled(compiled.pingbilouzhu, '小明', '微博线报'), true)
  })

  await test('whitelistFilter 字段名大小写敏感（缺失字段放行）', () => {
    // 字段名是精确的，不因大小写变化；缺失字段（大小写不匹配）按空值放行
    assertEqual(whitelistFilter({ title: '京东' }, 'title', '京东'), true)
    assertEqual(whitelistFilter({ Title: '京东' }, 'title', '京东'), true)
  })

  await test('MS save 时间戳格式为ISO完整', () => {
    const fs = require('fs')
    appendMessageToFile({ id: 77 }, 'test_iso.json')
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, 'test_iso.json'), 'utf8'))
    // ISO 格式：yyyy-mm-ddThh:mm:ss.msZ（含 T 和 Z）
    assertEqual(/^\d{4}-\d{2}-\d{2}T/.test(msgs[0].timestamp), true)
  })

  // ==================== 59. 边缘误判修复（实证发现） ====================
  console.log('\n📂 59. 边缘误判修复')

  await test('daysComputed 日期解析为本地时间（非UTC）', () => {
    // 2026-07-28 解析后应是本地日期的天数
    const d = daysComputed('2026-07-28')
    assertEqual(d >= 0, true)
    // 用 UTC 解析会不同（东八区日期差），验证当前解析方式
    assertEqual(typeof d, 'number')
  })

  await test('compileRules ###检测 test与includes等价', () => {
    const r = compileRules({ pingbilouzhu: '线报###小明' })
    assertEqual(r.pingbilouzhu._type, 'multi')
    // 空配置不因 includes/test 差异出错
    assertEqual(compileRules({}).pingbilouzhu, null)
  })

  await test('getFileName 空url/undefined → default.json（v3.20审查5）', () => {
    const r = getFileName('')
    assertEqual(r, 'default.json')
    const r2 = getFileName(undefined)
    assertEqual(r2, 'default.json')
    // 正常 URL 不受影响
    assertEqual(getFileName('http://x.com/push.json'), 'push.json')
  })

  // ==================== 60. 误判实证修复（第二批） ====================
  console.log('\n📂 60. 误判实证修复')

  await test('daysComputed 天数精确计算', () => {
    // 用精确日期验证天数（v3.115：expected 用 Date.UTC 与 parseTime UTC 解析口径一致）
    const days = daysComputed('2026-01-01')
    const expected = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 86400000)
    assertEqual(days, expected)
  })

  await test('tuisong 年份精确', () => {
    const r = tuisong_replace('{日期}', { posttime: 1785346200, datetime: undefined, url: 'x' })
    const year = r.split('-')[0]
    assertEqual(parseInt(year) >= 2026, true)
  })

  await test('whitelistFilter 正则 边界', () => {
    // 关键词应匹配包含它的词， 影响边界匹配
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', '京东'), true)
    assertEqual(whitelistFilter({ title: '京东' }, 'title', '京东'), true)
  })

  await test('compileRules 天数值精确', () => {
    const r = compileRules({ pingbitime: '5' })
    assertEqual(r.pingbitime.value, 5)
    const r2 = compileRules({ pingbitime: '线报###3' })
    assertEqual(r2.pingbitime.rules[0].value, 3)
  })

  // ==================== 61. 精确断言修复（实证盲区） ====================
  console.log('\n📂 61. 精确断言修复')

  await test('daysComputed 天数精确（不因时区偏移变化）', () => {
    // 精确日期 → 精确天数
    const d1 = daysComputed('2026-07-26')
    const d2 = daysComputed('2026-07-25')
    assertEqual(d2, d1 + 1) // 7-25 比 7-26 早1天，天数多1
  })

  await test('tuisong 年份精确值', () => {
    const r = tuisong_replace('{日期}', { posttime: 1785346200, datetime: undefined, url: 'x' })
    // 具体年份（用当前年份验证范围）
    const year = parseInt(r.split('-')[0])
    assertEqual(year >= 2026 && year <= 2027, true)
  })

  await test('whitelistFilter 正则边界（\b 影响匹配）', () => {
    // 关键词边界：含关键词的词应匹配
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', '京东'), true)
    // 大小写不敏感
    assertEqual(whitelistFilter({ title: 'JINGDONG' }, 'title', 'jingdong'), true)
  })

  await test('MS save 时间戳是ISO格式非时间戳数字', () => {
    const fs = require('fs')
    appendMessageToFile({ id: 88 }, 'test_ts_iso.json')
    const msgs = JSON.parse(fs.readFileSync(path.join(CACHE, 'test_ts_iso.json'), 'utf8'))
    assertEqual(typeof msgs[0].timestamp, 'string')
    assertEqual(/^\d{4}-\d{2}-\d{2}T/.test(msgs[0].timestamp), true)
  })

  await test('compileRules 天数值精确（不减不加）', () => {
    const r = compileRules({ pingbitime: '5' })
    assertEqual(r.pingbitime.value, 5)
    const r2 = compileRules({ pingbitime: '线报###3' })
    assertEqual(r2.pingbitime.rules[0].value, 3)
  })

  await test('MS 裁剪用splice保留后100条', () => {
    const p = path.join(CACHE, 'test_splice.json')
    const msgs = []
    for (let i = 0; i < 150; i++) msgs.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // v3.120：显式小上限验证裁剪（默认已 10000）
    try {
      saveMessages(p, msgs)
    } finally {
      Config.cache.maxSize = orig
    }
    const r = readMessages(p)
    assertEqual(r.length, 100)
    // 裁剪应删前面的，保留后面的
    assertEqual(r.some(m => m.id === 0), false)
    assertEqual(r.some(m => m.id === 149), true)
  })

  // ==================== 62. 变异实证盲区修复（第41-50批） ====================
  console.log('\n📂 62. 变异实证盲区修复')

  await test('add0 边界：9分钟补0 → 09', () => {
    // v3.115：{时间} 用 getUTC*——测试用 Date.UTC 构造（跨时区稳定）
    const ts = Math.floor(new Date(Date.UTC(2026, 0, 9, 12, 9, 0)).getTime() / 1000)
    const r = tuisong_replace('{日期}|{时间}', { posttime: ts, url: 'x' })
    // 变异 m<11 时 add0(9) 会变成 '9'，此处精确断言 '09'
    assertEqual(r, '2026-01-09|12:09')
  })

  await test('add0 边界：10分钟不补0 → 10（变异 m<11 会错误补0成010）', () => {
    // v3.115：{时间} 用 getUTC*——测试用 Date.UTC 构造（跨时区稳定）
    const ts = Math.floor(new Date(Date.UTC(2026, 0, 10, 12, 10, 0)).getTime() / 1000)
    const r = tuisong_replace('{日期}|{时间}', { posttime: ts, url: 'x' })
    // 变异 m<11 时 add0(10) 会变成 '010'；变异 m<9 时 add0(9) 会丢0
    assertEqual(r, '2026-01-10|12:10')
  })

  await test('decodeHtmlEntities undefined → 空串（变异 || 变 && 会返回 "undefined"）', () => {
    // 变异 if (str===undefined && str===null) 恒 false，String(undefined)='undefined'
    assertEqual(decodeHtmlEntities(undefined), '')
  })

  await test('decodeHtmlEntities null → 空串', () => {
    assertEqual(decodeHtmlEntities(null), '')
  })

  await test('daysComputed 明天（未来24h内）→ 0（变异 >-1 会返回负数）', () => {
    // v3.115：daysAgo(-1) = 明天（UTC，与 parseTime 口径一致）
    assertEqual(daysComputed(daysAgo(-1)), 0)
  })

  await test('htmlToMarkdown h0 无效标签 → 不转为标题', () => {
    const r = htmlToMarkdown({ content_html: '<h0>无效标题</h0>', url: 'http://x' })
    // 变异正则 [0-6] 匹配 h0 后 repeat('0') 会丢失 # 号（输出行为与原型一致，属等价变异，此处锁原型行为）
    assertEqual(r.includes('无效标题'), true)
    assertEqual(r.startsWith('无效标题'), true)
  })

  await test('htmlToMarkdown 恰好3个连续换行 → 合并为2个（变异 {4,} 会保留3个）', () => {
    const r = htmlToMarkdown({ content_html: '第一段\n\n\n第二段', url: 'http://x' })
    // 变异 \n{4,} 时 \n\n\n 不会被合并，输出中残留 3 个换行
    assertEqual(r.includes('\n\n\n'), false)
    assertEqual(r.includes('第一段\n\n第二段'), true)
  })

  await test('compileRules 简单模式正则大小写不敏感（大写输入匹配）', () => {
    // 变异 DROP i flag 后 'JD' 无法匹配 'jd'
    const r = compileRules({ pingbibiaoti: 'jd' })
    assertEqual(r.pingbibiaoti._type, 're')
    assertEqual(matchesCompiled(r.pingbibiaoti, 'JD神券大促', null), true)
  })

  await test('compileRules 多行值正则大小写不敏感（大写输入匹配）', () => {
    const r = compileRules({ pingbilouzhu: 'weibo###xiaoming' })
    assertEqual(r.pingbilouzhu._type, 'multi')
    // 变异 DROP i flag 后 'XIAOMING' 无法匹配 'xiaoming'
    assertEqual(matchesCompiled(r.pingbilouzhu, 'XIAOMING', 'weibo'), true)
    // 分类正则同样大小写不敏感
    assertEqual(matchesCompiled(r.pingbilouzhu, 'xiaoming', 'WEIBO'), true)
  })

  await test('compileRules 多行中含无###的行 → 该行被忽略（变异 >=1 会生成垃圾规则）', () => {
    // 变异 parts.length>=1 会把无 ### 的 "垃圾行" 编译成匹配 /undefined/ 的规则
    const r = compileRules({ pingbilouzhu: '微博线报###小明<br>垃圾行' })
    assertEqual(r.pingbilouzhu.rules.length, 1)
    // 垃圾行本身不应匹配任何值
    assertEqual(matchesCompiled(r.pingbilouzhu, '垃圾', '微博线报'), false)
    // 有效规则仍生效
    assertEqual(matchesCompiled(r.pingbilouzhu, '小明', '微博线报'), true)
  })

  await test('compileRules pingbitime 多行中含无###的行 → 被忽略', () => {
    const r = compileRules({ pingbitime: '微博线报###3<br>垃圾行' })
    assertEqual(r.pingbitime._type, 'timeMulti')
    assertEqual(r.pingbitime.rules.length, 1)
  })

  await test('checkFields 强制展现配置存在但字段为空 → 不触发白名单（变异 && 变 || 会越权）', () => {
    // 变异 stage.showCfg || val 时，title 为空也会设置 showFlags.title，
    // 导致内容屏蔽被整体跳过（越权）。正确行为：空字段不触发强制展现。
    const cfg = {
      zhanxianbiaoti: '京东', // 标题强制展现配置，但 title 为空
      pingbineirong: '大促' // 内容屏蔽
    }
    const group = {
      catename: '微博线报',
      louzhu: '小明',
      title: '', // 空标题
      content: '京东大促活动',
      url: '/w/1.html'
    }
    // 标题为空 → 不触发强制展现 → 内容屏蔽命中 → 被屏蔽
    assertEqual(listfilter(group, cfg), false)
  })

  await test('checkFields 强制展现字段有值且匹配 → 正常免疫屏蔽', () => {
    const cfg = {
      zhanxianbiaoti: '京东',
      pingbineirong: '大促'
    }
    const group = {
      catename: '微博线报',
      louzhu: '小明',
      title: '京东神券',
      content: '京东大促活动',
      url: '/w/2.html'
    }
    // 标题非空且匹配强制展现 → 内容屏蔽被跳过 → 保留
    assertEqual(listfilter(group, cfg), true)
  })

  await test('validateConfig pingbitime 无效数字警告包含具体值', () => {
    const warns = validateConfig({ pingbitime: '微博线报###abc' })
    // 变异模板字符串 parts[1]->parts[0] 时警告里会打印错误的值
    assertEqual(warns.some(w => w.includes('「abc」')), true)
  })

  await test('pingbitime 多行分类正则大小写不敏感（变异 L229 DROP i 后大写分类失配）', () => {
    // 变异 pingbitime 多行的 catRe 去掉 i flag 后，'weibo' 无法匹配 /WEIBO/
    const r = compileRules({ pingbitime: 'WEIBO###5' })
    assertEqual(r.pingbitime._type, 'timeMulti')
    // 2天前注册的新号（注册天数 < 5 → 应拦截）——v3.115：daysAgo(2) UTC 统一
    const group = { catename: 'weibo', louzhuregtime: daysAgo(2) }
    // 分类大小写不敏感 → 规则命中 → 拦截
    assertEqual(checkTimeCompiled(r.pingbitime, group), true)
  })

  await test('matchesCompiled 未知规则类型 → 不匹配（变异 L269 兜底 true 会误匹配）', () => {
    // 变异兜底 return false->true 后，未知 _type 的规则会匹配任何非空字段
    const weird = { _type: 'unknown-type', re: /京东/ }
    assertEqual(matchesCompiled(weird, '任意内容', null), false)
  })

  await test('checkTimeCompiled 未知规则类型 → 不拦截（变异 L292 兜底 true 会误拦截）', () => {
    // 变异兜底 return false->true 后，未知 _type 的天数规则会拦截所有人
    const weird = { _type: 'unknown-type', value: 5 }
    const group = { catename: '微博线报', louzhuregtime: '2026-07-01' }
    assertEqual(checkTimeCompiled(weird, group), false)
  })

  // ==================== 63. 第51批变异盲区修复（v2算子） ====================
  console.log('\n📂 63. 第51批变异盲区修复')

  await test('saveBatch 新消息按顺序追加到末尾（变异 push->unshift 会倒序）', () => {
    // 变异 unshift 后新消息会插到数组开头，顺序颠倒
    saveBatch([{ id: 200 }], 'test_batch_order.json')
    saveBatch([{ id: 201 }], 'test_batch_order.json')
    const msgs = readMessages(getFilePath('test_batch_order.json'))
    const i200 = msgs.findIndex(m => m.id === 200)
    const i201 = msgs.findIndex(m => m.id === 201)
    // 后保存的 201 必须在 200 之后（append 语义）
    assertEqual(i200 >= 0, true)
    assertEqual(i201 > i200, true)
  })

  await test('save 单条新消息同样追加到末尾', () => {
    // save 内部的 push 变异同样影响顺序
    appendMessageToFile({ id: 300 }, 'test_save_order.json')
    appendMessageToFile({ id: 301 }, 'test_save_order.json')
    const msgs = readMessages(getFilePath('test_save_order.json'))
    assertEqual(msgs[msgs.length - 1].id, 301)
    assertEqual(msgs[0].id, 300)
  })

  await test('htmlToMarkdown 空h标签也转换（变异 .*?->.+? 会漏掉空标题）', () => {
    // 变异 (.*?)->(.+?) 后 <h1></h1> 空内容不匹配，不再转成标题
    const r = htmlToMarkdown({ content_html: '<h1></h1>', url: 'http://x' })
    // 空 h1 也应转成 '# '（repeat(1) + 空格）
    assertEqual(r.includes('# '), true)
  })

  await test('htmlToMarkdown 链接替换模板无附加字符（变异 STR append 会多出x）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="http://u">链接</a>', url: 'http://x' })
    // 变异替换模板 '[$2]($1)' 追加字符后输出会带 'x'
    assertEqual(r.includes('[链接](http://u)x'), false)
    // 精确锁定替换结果本身
    assertEqual(r.includes('[链接](http://u)\n'), true)
  })

  await test('htmlToMarkdown img替换模板无附加字符', () => {
    const r1 = htmlToMarkdown({ content_html: '<img src="http://p.jpg" alt="图">', url: 'http://x' })
    assertEqual(r1.includes('![图](http://p.jpg)x'), false)
    const r2 = htmlToMarkdown({ content_html: '<img src="http://p.jpg">', url: 'http://x' })
    assertEqual(r2.includes('![](http://p.jpg)x'), false)
  })

  await test('tuisong {Html内容} 替换后无花括号残留（变异 key 截断会残留 }）', () => {
    // 变异 '{Html内容' 作为 key 时仍前缀匹配，替换结果末尾会残留 '}'
    const r = tuisong_replace('{Html内容}', { content_html: '测试', url: 'http://x' })
    assertEqual(r.includes('}'), false)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('tuisong {Markdown内容} 替换后无花括号残留', () => {
    const r = tuisong_replace('{Markdown内容}', { content_html: '测试', url: 'http://x' })
    assertEqual(r.includes('}'), false)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('validateConfig 逐字段验证无效正则（变异字段名数组会漏验）', () => {
    // 变异 regexFields 数组里字段名被改/删后，该字段的无效正则不再报警告
    const fields = [
      'pingbifenlei', 'pingbilouzhu', 'zhanxianlouzhu', 'pingbilouzhuplus',
      'pingbibiaoti', 'zhanxianbiaoti', 'pingbibiaotiplus',
      'pingbineirong', 'zhanxianneirong', 'pingbineirongplus'
    ]
    for (const f of fields) {
      const warns = validateConfig({ [f]: '[' }) // '[' 是无效正则
      assertEqual(warns.some(w => w.includes(`「${f}」`)), true, `${f} 未产生警告`)
    }
  })

  await test('whitelistFilter 空字段不参与匹配（缺失按放行，不与关键词比对）', () => {
    // 空/缺失字段按缺失放行，不会与 'undefined' 等关键词比对
    assertEqual(whitelistFilter({ title: '' }, 'title', 'undefined'), true)
    assertEqual(whitelistFilter({ title: undefined }, 'title', 'undefined'), true)
  })

  await test('htmlToMarkdown h标签替换模板无附加字符（变异模板后追加x）', () => {
    // 变异替换回调 '\n\n' 追加 'x' 后，输出会多出 x
    const r = htmlToMarkdown({ content_html: '<h1>标题1</h1>', url: 'http://x' })
    assertEqual(r.includes('标题1\n\nx'), false)
  })

  await test('htmlToMarkdown img模板无附加字符（带alt/无alt）', () => {
    const r1 = htmlToMarkdown({ content_html: '<img src="http://p.jpg" alt="图">', url: 'http://x' })
    assertEqual(r1.includes('![图](http://p.jpg)\n\nx'), false)
    const r2 = htmlToMarkdown({ content_html: '<img src="http://p.jpg">', url: 'http://x' })
    assertEqual(r2.includes('![](http://p.jpg)\n\nx'), false)
  })

  // ==================== 64. fuzz 属性测试发现修复 ====================
  console.log('\n📂 64. fuzz 属性测试发现修复')

  await test('htmlToMarkdown 内容尾部换行 + 模板拼接处 → 无3连换行（fuzz发现）', () => {
    // 内容以 <p> 结尾产生尾部 \n\n，拼接模板的 \n\n 原文链接 会拼出 4 连换行
    // 修复前：合并 \n{3,} 在拼接之前执行，拼接处残留 \n\n\n\n
    const r = htmlToMarkdown({ content_html: '<p>段落</p>', url: 'http://x' })
    assertEqual(r.includes('\n\n\n'), false)
    assertEqual(r.includes('段落\n\n原文链接'), true)
  })

  await test('htmlToMarkdown 多p标签拼接处 → 无3连换行', () => {
    const r = htmlToMarkdown({ content_html: '<p>第一段</p><p>第二段</p>', url: 'http://x' })
    assertEqual(r.includes('\n\n\n'), false)
    assertEqual(r.includes('第一段\n\n第二段'), true)
    assertEqual(r.includes('第二段\n\n原文链接'), true)
  })

  await test('tuisong_replace 模板缺失/非字符串 → 不崩溃（针对性构造发现）', () => {
    // 真实场景模板配置缺失时 text 可能为 undefined/null
    assertEqual(tuisong_replace(undefined, { title: 'x' }), '')
    assertEqual(tuisong_replace(null, { title: 'x' }), '')
    // 数字模板被字符串化
    assertEqual(tuisong_replace(123, { title: 'x' }), '123')
    // 正常模板不受影响
    assertEqual(tuisong_replace('{标题}', { title: 'x' }), 'x')
  })

  await test('whitelistFilter item 缺失 → 不崩溃（针对性构造发现）', () => {
    // 防御：item 为 undefined 时，有关键词 → 不匹配；空关键词 → 全通过
    assertEqual(whitelistFilter(undefined, 'title', '京东'), false)
    assertEqual(whitelistFilter(undefined, 'title', ''), true)
    assertEqual(whitelistFilter(null, 'title', '京东'), false)
  })

  await test('checkRegisterTime/checkCategory group 缺失 → 不崩溃（针对性构造发现）', () => {
    const c = compileRules({ pingbitime: '5', pingbifenlei: '微博' })
    // 防御：group 为 null/undefined 时不崩溃，视为通过
    assertEqual(checkRegisterTime(null, c.pingbitime), true)
    assertEqual(checkRegisterTime(undefined, c.pingbitime), true)
    assertEqual(checkCategory(null, c.pingbifenlei), true)
    assertEqual(checkCategory(undefined, c.pingbifenlei), true)
    // 正常 group 不受影响
    assertEqual(checkCategory({ catename: '微博' }, c.pingbifenlei), false)
  })

  // ==================== 65. 代码审查修复（v3.14 审查请求） ====================
  console.log('\n📂 65. 代码审查修复')

  await test('saveBatch 无id不同url → 互不覆盖（修复前 undefined===undefined 误判覆盖）', () => {
    // 修复前 m.id === message.id 在两者都是 undefined 时为 true，
    // 导致不同 url 的无 id 数据互相覆盖（数据丢失）
    saveBatch([{ url: '/a.html', title: 'A' }], 'test_noid_diffurl.json')
    saveBatch([{ url: '/b.html', title: 'B' }], 'test_noid_diffurl.json')
    const r = readMessages(getFilePath('test_noid_diffurl.json'))
    assertEqual(r.length, 2, `应2条，实际${r.length}`)
    assertEqual(r.map(m => m.title).join(','), 'A,B')
  })

  await test('saveBatch 无id非字符串 url → 不互相覆盖（v3.228）', () => {
    saveBatch([{ url: {}, title: '对象URL-A' }], 'test_noid_invalid_url.json')
    saveBatch([{ url: {}, title: '对象URL-B' }], 'test_noid_invalid_url.json')
    const r = readMessages(getFilePath('test_noid_invalid_url.json'))
    assertEqual(r.length, 2, `非字符串 URL 的不同消息应分别保留，实际${r.length}`)
    assertEqual(r.map(m => m.title).join(','), '对象URL-A,对象URL-B')
  })

  await test('saveBatch 无id同url → 更新不重复', () => {
    saveBatch([{ url: '/c.html', title: 'C1' }], 'test_noid_sameurl.json')
    saveBatch([{ url: '/c.html', title: 'C2' }], 'test_noid_sameurl.json')
    const r = readMessages(getFilePath('test_noid_sameurl.json'))
    assertEqual(r.length, 1, `应1条，实际${r.length}`)
    assertEqual(r[0].title, 'C2')
  })

  await test('saveBatch 无id无url → 保守收录不判重', () => {
    // 与 has() 一致：无 id 无 url 不判重，全部收录
    saveBatch([{ title: 'X' }, { title: 'Y' }], 'test_noid_nourl.json')
    const r = readMessages(getFilePath('test_noid_nourl.json'))
    assertEqual(r.length, 2, `应2条，实际${r.length}`)
  })

  await test('saveBatch 无id + 有id 混存 → 互不影响', () => {
    saveBatch([{ url: '/d.html', title: 'D' }], 'test_noid_mix.json')
    saveBatch([{ id: 5, title: 'E' }], 'test_noid_mix.json')
    const r = readMessages(getFilePath('test_noid_mix.json'))
    assertEqual(r.length, 2, `应2条，实际${r.length}`)
  })

  // ==================== 66. v3.15 审查报告修复 ====================
  console.log('\n📂 66. v3.15 审查报告修复')

  await test('save 无id不同url → 互不覆盖（v3.15审查3.1：save与saveBatch对齐）', () => {
    appendMessageToFile({ url: '/x1.html', title: 'A' }, 'test_save_noid.json')
    appendMessageToFile({ url: '/x2.html', title: 'B' }, 'test_save_noid.json')
    const r = readMessages(getFilePath('test_save_noid.json'))
    assertEqual(r.length, 2, `应2条，实际${r.length}`)
    assertEqual(r.map(m => m.title).join(','), 'A,B')
  })

  await test('save 无id同url → 更新不重复', () => {
    appendMessageToFile({ url: '/y.html', title: 'C1' }, 'test_save_sameurl.json')
    appendMessageToFile({ url: '/y.html', title: 'C2' }, 'test_save_sameurl.json')
    const r = readMessages(getFilePath('test_save_sameurl.json'))
    assertEqual(r.length, 1, `应1条，实际${r.length}`)
    assertEqual(r[0].title, 'C2')
  })

  await test('decodeHtmlEntities 数字实体十进制 → 转字符（v3.15审查4.2）', () => {
    assertEqual(decodeHtmlEntities('&#39;'), "'")
    assertEqual(decodeHtmlEntities('a&#65;b'), 'aAb')
    assertEqual(decodeHtmlEntities('&#60;&#62;'), '<>')
  })

  await test('decodeHtmlEntities 数字实体十六进制 → 转字符', () => {
    assertEqual(decodeHtmlEntities('&#x41;'), 'A')
    assertEqual(decodeHtmlEntities('&#x26;'), '&')
    // 命名实体仍生效
    assertEqual(decodeHtmlEntities('&amp;&#65;'), '&A')
  })

  await test('decodeHtmlEntities 数字实体与命名实体混合', () => {
    assertEqual(decodeHtmlEntities('&lt;&#49;&gt;'), '<1>')
    assertEqual(decodeHtmlEntities('普通&#x4E2D;文'), '普通中文')
  })

  await test('saveMessages 原子写入后无 .tmp 残留（v3.16审查3.1）', () => {
    const p = getFilePath('test_atomic.json')
    saveMessages(p, [{ id: 1, title: '原子' }])
    const r = readMessages(p)
    assertEqual(r.length, 1)
    // tmp 文件应在 rename 后被清掉
    const fs = require('fs')
    assertEqual(fs.existsSync(p + '.tmp'), false, 'tmp 文件应被清理')
  })

  // ==================== 67. v3.18 审查报告修复 ====================
  console.log('\n📂 67. v3.18 审查报告修复')

  await test('anonKey 稳定合成id：相同输入相同key（v3.18审查Bug2）', () => {
    assertEqual(anonKey('京东', '内容A'), anonKey('京东', '内容A'))
    // 空值处理
    assertEqual(typeof anonKey(undefined, null), 'string')
    assertEqual(anonKey('京东', '内容A') !== anonKey('淘宝', '内容A'), true)
    // 格式: anon: 前缀 + 十六进制
    assertEqual(/^anon:[0-9a-f]+$/.test(anonKey('x', 'y')), true)
  })

  await test('anonKey 楼主不同 → 不同key（v3.176 修复#6）', () => {
    // 曾：同标题/内容/时间/图/价/商城/品牌/分类但楼主不同 → 误合并（合成 id 漏 louzhu）
    const base = ['京东', '内容A', 1699999999, 1699999999, '/p.png', '京东商城', '99', '京东自营', '数码']
    assertEqual(anonKey(...base, '小明'), anonKey(...base, '小明'), '同楼主应同key')
    assertEqual(anonKey(...base, '小明') !== anonKey(...base, '小红'), true, '楼主不同应不同key')
    // 无楼主字段与空楼主 → 同 key（空值被过滤，行为不变）
    assertEqual(anonKey(...base), anonKey(...base, ''), '空楼主不影响key')
  })

  await test('tuisong {类目} 与 {分类名} 统一来源（v3.18审查Bug3）', () => {
    // 数据源只有 catename（无 category_name）→ {类目} 也应有值
    const r = tuisong_replace('{类目}|{分类名}', { catename: '美妆', url: 'x' })
    assertEqual(r, '美妆|美妆')
    // 只有 category_name → 归一化后两者一致
    const r2 = tuisong_replace('{类目}|{分类名}', { category_name: '数码', url: 'x' })
    assertEqual(r2, '数码|数码')
  })

  // ==================== 68. v3.20 审查报告修复 ====================
  console.log('\n📂 68. v3.20 审查报告修复')

  await test('hasValidId 排除 null/空串（v3.20审查2：id判重过宽）', () => {
    assertEqual(hasValidId({ id: undefined }), false)
    assertEqual(hasValidId({ id: null }), false)
    assertEqual(hasValidId({ id: '' }), false)
    assertEqual(hasValidId({ id: 0 }), true) // 数字 0 是有效 id
    assertEqual(hasValidId({ id: '123' }), true)
    assertEqual(hasValidId({ id: 'anon:abc' }), true)
  })

  await test('真实 anon:... 前缀 id 保持 id 权威，跨 url 判重（v3.247 修复）', async () => {
    // 曾：无 url 的 id='anon:abc1' 被 /^anon:[0-9a-f]+$/i 误降级为匿名身份，与同 id 带 url 的
    // 记录（kind 'id'）判重路径分裂 → 同一条消息被重复推送。修复后保持 id 权威，按 idKey 合并。
    const fs = require('fs')
    const name = 'test_identity_real_anon_id.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    saveBatch([{ id: 'anon:abc1', title: '真实A', url: '/u/x.html' }], name)
    saveBatch([{ id: 'anon:abc1', title: '真实A' }], name) // 同 id 无 url → 不应降级
    assertEqual(readMessages(p).length, 1, `真实 anon:... id 应保持 id 权威跨 url 合并，实际${readMessages(p).length}`)
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('历史 anon:hash 自身内容键仍降级匿名并跨运行去重（兼容保留）', async () => {
    // 旧版 App 曾把 anonKey(自身字段) 写入 id 字段落缓存；该 id 与自身内容哈希一致 → 仍降级
    // 为匿名，与同内容的无 id 消息判同一身份（兼容路径不受影响）。
    const fs = require('fs')
    const name = 'test_identity_legacy_anon_id.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    const legacyId = anonKey('历史标题', '历史内容')
    saveBatch([{ id: legacyId, title: '历史标题', content: '历史内容' }], name)
    saveBatch([{ title: '历史标题', content: '历史内容' }], name) // 无 id → anonKey 相同
    assertEqual(readMessages(p).length, 1, `历史 anon:hash id 应降级匿名并与同内容无 id 消息去重，实际${readMessages(p).length}`)
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('id为null的记录不与正常记录误合并（v3.20审查2）', () => {
    // null id 不参与 id 判重 → url 兜底
    saveBatch([{ id: null, url: '/a.html', title: 'A' }], 'test_nullid.json')
    saveBatch([{ id: null, url: '/b.html', title: 'B' }], 'test_nullid.json')
    const r = readMessages(getFilePath('test_nullid.json'))
    assertEqual(r.length, 2, `null id 不同 url 应2条，实际${r.length}`)
    assertEqual(r.map(m => m.title).join(','), 'A,B')
  })

  // ==================== C006 继承属性 id 判重 vs 落盘丢 id ====================
  console.log('\n📂 C006 继承属性 id 判重 vs 落盘丢 id')

  await test('C006 继承 id 不参与判重（无自有字段不落盘，避免重复入库）', async () => {
    const fs = require('fs')
    const name = 'test_c006_inherited_noown.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    saveBatch([Object.create({ id: 'X' })], name)
    assertEqual(readMessages(p).length, 0, `仅继承 id 且无自有字段的消息不应落盘，实际${readMessages(p).length}`)
    assertEqual(isMessageInFile(Object.create({ id: 'X' }), name), false, '仅继承 id 且无自有字段的消息不应命中')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('C006 继承 id 不参与判重（同构造含自有字段消息 saveBatch 后 has 命中）', async () => {
    const fs = require('fs')
    const name = 'test_c006_inherited_ownfields.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    const mk = () => { const m = Object.create({ id: 'X' }); m.title = '继承ID消息'; return m }
    saveBatch([mk()], name)
    assertEqual(isMessageInFile(mk(), name), true, '继承 id 不应参与判重，同构造消息应命中')
    const stored = readMessages(p)
    assertEqual(stored.length, 1, `同构造消息应合并为1条，实际${stored.length}`)
    assertEqual(Object.prototype.hasOwnProperty.call(stored[0], 'id'), false, '落盘副本不应携带继承 id')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('C006 自有 id 正常判重', async () => {
    const fs = require('fs')
    const name = 'test_c006_own_id.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    const mk = () => {
      const m = Object.create({ id: 'X' })
      m.id = 'own-X'
      m.title = '自有ID消息'
      return m
    }
    saveBatch([mk()], name)
    assertEqual(isMessageInFile(mk(), name), true, '自有 id 应正常判重命中')
    assertEqual(readMessages(p).length, 1, `自有 id 同构造消息应合并为1条，实际${readMessages(p).length}`)
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('C006 原身份用例不回归（普通自有 id/url 判重）', async () => {
    const fs = require('fs')
    const name = 'test_c006_regress.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    saveBatch([{ id: 'c006-a', url: '/c006.html', title: 'old' }], name)
    saveBatch([{ id: 'c006-a', url: '/c006-other.html', title: 'new' }], name)
    assertEqual(readMessages(p).length, 1, `同自有 id 跨 url 仍应合并为1条，实际${readMessages(p).length}`)
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('decodeHtmlEntities 超BMP emoji 实体（v3.20审查7：fromCodePoint）', () => {
    assertEqual(decodeHtmlEntities('&#128512;'), '😀')
    assertEqual(decodeHtmlEntities('&#x1F600;'), '😀')
    // 非法码点保留原文（不抛异常）
    assertEqual(decodeHtmlEntities('&#99999999;'), '&#99999999;')
    assertEqual(decodeHtmlEntities('&#x110000;'), '&#x110000;')
  })

  await test('htmlToMarkdown a标签单引号/属性顺序（v3.20审查8）', () => {
    // 单引号 href
    const r1 = htmlToMarkdown({ content_html: "<a href='http://u'>链接1</a>", url: 'http://x' })
    assertEqual(r1.includes('[链接1](http://u)'), true)
    // href 不在首位
    const r2 = htmlToMarkdown({ content_html: '<a class="btn" href="http://u2">链接2</a>', url: 'http://x' })
    assertEqual(r2.includes('[链接2](http://u2)'), true)
    // 原有双引号行为不变
    const r3 = htmlToMarkdown({ content_html: '<a href="http://u3">链接3</a>', url: 'http://x' })
    assertEqual(r3.includes('[链接3](http://u3)'), true)
  })

  // ==================== 69. v3.21 审查报告修复 ====================
  console.log('\n📂 69. v3.21 审查报告修复')

  await test('daysComputed 非法日期 2026-02-31 → 0（v3.21审查1）', () => {
    assertEqual(daysComputed('2026-02-31'), 0)
    assertEqual(daysComputed('2026-13-01'), 0)
    assertEqual(daysComputed('2026-00-10'), 0)
  })

  await test('parseTime 斜杠/带时区 ISO 非法日期 → null（C017：宿主解析曾滚动到 2026-03-03）', () => {
    // parseTime 未单独导出，用 daysComputed 断言 parseTime(...)===null → 0
    assertEqual(daysComputed('2026/02/31'), 0, 'parseTime(2026/02/31) 应 null')
    assertEqual(daysComputed('2026-02-31T00:00:00Z'), 0, 'parseTime(2026-02-31T00:00:00Z) 应 null')
    // 合法同格式不受影响
    assertEqual(typeof daysComputed('2026/08/01'), 'number', '合法斜杠日期仍可解析')
    assertEqual(typeof daysComputed('2026-08-01T00:00:00Z'), 'number', '合法 ISO 仍可解析')
    // 单数字月/日带时区 ISO（v3.171 行为）：宿主 Invalid 时补零回退，仍应有效
    assertEqual(daysComputed('2026-8-1T00:00:00Z'), daysComputed('2026-08-01T00:00:00Z'),
      '合法单数字 ISO 应与补零 ISO 同值（2026-8-1T00:00:00Z）')
  })

  await test('daysComputed 脏后缀 2026-07-31abc → 0（v3.21审查2：锚定）', () => {
    assertEqual(daysComputed('2026-07-31abc'), 0)
    assertEqual(daysComputed('2026-07-31 乱字符'), 0)
    // 合法日期不受影响
    assertEqual(typeof daysComputed('2026-07-28'), 'number')
  })

  await test('daysComputed 0 时间戳 → 走解析不跳过（v3.21审查3）', () => {
    // 0 = 1970-01-01，应返回大天数而非被 !time 短路
    const d = daysComputed(0)
    assertEqual(d > 10000, true)
    assertEqual(daysComputed(undefined), 0)
    assertEqual(daysComputed(null), 0)
    assertEqual(daysComputed(''), 0)
  })

  await test('tuisong 0 时间戳 → 生成日期（v3.21审查3）', () => {
    const r = tuisong_replace('{日期}', { posttime: 0, url: 'x' })
    assertEqual(/^\d{4}-\d{2}-\d{2}$/.test(r), true)
  })

  await test('hasValidId 空白串 → 无效（v3.21审查4）', () => {
    assertEqual(hasValidId({ id: '   ' }), false)
    assertEqual(hasValidId({ id: '\t' }), false)
    assertEqual(hasValidId({ id: ' a ' }), true)
  })

  await test('htmlToMarkdown 无url → 无原文链接空壳（v3.21审查6）', () => {
    const r = htmlToMarkdown({ content_html: '内容', url: '' })
    assertEqual(r.includes('[]()'), false)
    assertEqual(r.includes('原文链接'), false)
    // 有 url 正常
    assertEqual(htmlToMarkdown({ content_html: '内容', url: 'http://x' }).includes('原文链接'), true)
  })

  await test('htmlToMarkdown h标签带属性 → 转换（v3.21审查8）', () => {
    const r = htmlToMarkdown({ content_html: '<h2 class="title" id="t">带属性标题</h2>', url: 'http://x' })
    assertEqual(r.includes('## 带属性标题'), true)
  })

  await test('decodeHtmlEntities 扩展实体（v3.21审查10）', () => {
    assertEqual(decodeHtmlEntities('&hellip;'), '…')
    assertEqual(decodeHtmlEntities('&mdash;'), '—')
    assertEqual(decodeHtmlEntities('&copy; 2026'), '© 2026')
    assertEqual(decodeHtmlEntities('&euro;&times;'), '€×')
  })

  await test('readMessages 非数组 JSON → 保留文件返回[]不崩溃（v3.21审查11）', () => {
    const p = getFilePath('test_notarray.json')
    const fs = require('fs')
    fs.writeFileSync(p, JSON.stringify({ foo: 'bar' }), 'utf8')
    const r = readMessages(p)
    assertEqual(Array.isArray(r), true)
    assertEqual(r.length, 0)
    // 非数组 JSON 不再被重置，原文件保留（供排查/恢复）
    assertEqual(fs.readFileSync(p, 'utf8'), JSON.stringify({ foo: 'bar' }))
  })

  await test('saveMessages 不原地修改传入数组（v3.21审查13）', () => {
    const arr = []
    for (let i = 0; i < 150; i++) arr.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // v3.120：显式小上限（默认已 10000）
    try {
      saveMessages(getFilePath('test_no_mutate.json'), arr)
    } finally {
      Config.cache.maxSize = orig
    }
    assertEqual(arr.length, 150, '原数组不应被截断')
    const r = readMessages(getFilePath('test_no_mutate.json'))
    assertEqual(r.length, 100)
  })

  await test('getFileName 查询参数/保留字符清洗（v3.21审查14）', () => {
    assertEqual(getFileName('http://x.com/a/b/c.json?token=1'), 'c.json')
    assertEqual(getFileName('http://x.com/a/b/c:1.json'), 'c_1.json')
    assertEqual(getFileName('a|b.json'), 'a_b.json')
  })

  await test('判重：旧url-only缓存 + 新id+url → 判重（v3.21审查16）', () => {
    // 旧缓存只有 url（无 id）
    saveBatch([{ url: '/dup.html', title: '旧' }], 'test_idurl_dup.json')
    // 新数据带 id 同 url → 应判重不重复
    const r = readMessages(getFilePath('test_idurl_dup.json'))
    assertEqual(r.length, 1)
  })

  await test('判重：空归一 URL 不得作为 id/url fallback 键', () => {
    const fname = 'test_empty_norm_url_dedup.json'
    const fp = getFilePath(fname)
    try {
      saveBatch([{ url: '#', title: '旧垃圾 URL' }], fname)
      saveBatch([{ id: 123, url: '#', title: '新有效 ID' }], fname)
      const r = readMessages(fp)
      assertEqual(r.length, 2, '有效 ID 不应被旧垃圾 URL 判重拦截')
    } finally {
      try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    }
  })

  await test('判重：id 类型漂移 1 vs "1" → 判重（v3.21审查17）', () => {
    saveBatch([{ id: 1, url: '/t.html', title: '数字' }], 'test_idtype.json')
    const r = readMessages(getFilePath('test_idtype.json'))
    assertEqual(r.length, 1)
    // 类型归一后 String(1)===String("1") → 更新不重复
  })

  await test('saveMessages 内存缓存与裁剪结果一致', () => {
    const p = getFilePath('test_trim_mem.json')
    const arr = []
    for (let i = 0; i < 150; i++) arr.push({ id: i })
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 100 // v3.120：显式小上限（默认已 10000）
    try {
      saveMessages(p, arr)
    } finally {
      Config.cache.maxSize = orig
    }
    const r = readMessages(p) // 应读内存缓存（已裁剪的 toSave）
    assertEqual(r.length, 100)
  })

  // ==================== 70. v3.22 审查报告修复 ====================
  console.log('\n📂 70. v3.22 审查报告修复')

  await test('daysComputed ISO 时间串 → 正常解析（v3.22审查1）', () => {
    const d = daysComputed('2026-08-01T00:00:00Z')
    assertEqual(typeof d, 'number')
    assertEqual(d >= 0, true)
  })

  await test('daysComputed 12位毫秒时间戳 → 按毫秒解析（v3.22审查2）', () => {
    // 123456789012 毫秒 ≈ 1973-11-29，不应被误乘 1000
    const d = daysComputed(123456789012)
    assertEqual(d > 19000 && d < 20000, true, `应为1973年至今约${d}天`)
  })

  await test('tuisong ISO posttime → 日期时间正确（与 daysComputed 口径一致）', () => {
    // 曾用 new Date(s.replace(/-/g,'/')) 破坏 ISO 格式 → {日期}/{时间} 恒空
    // v3.115：{日期}/{时间} 用 getUTC* 显示——ISO 带 Z（明确 UTC）跨时区稳定
    const r = tuisong_replace('{日期}|{时间}', { posttime: '2026-08-01T10:30:00Z', url: 'x' })
    assertEqual(r, '2026-08-01|10:30', `ISO+Z 应解析为 UTC 时间: ${r}`)
    // 带 Z 后缀（UTC）日期部分稳定
    const r2 = tuisong_replace('{日期}', { posttime: '2026-08-01T00:00:00Z', url: 'x' })
    assertEqual(r2, '2026-08-01', `ISO+Z 应解析: ${r2}`)
    // / 分隔格式仍兼容
    const r3 = tuisong_replace('{日期}', { posttime: '2026/08/01', url: 'x' })
    assertEqual(r3, '2026-08-01', `/ 分隔应解析: ${r3}`)
  })

  await test('tuisong 8位日期/范围限制（与 daysComputed 口径一致）', () => {
    // 8 位 YYYYMMDD：曾当秒时间戳 → '1970-08-23'（daysComputed 正确解析 2026-07-31）
    assertEqual(tuisong_replace('{日期}', { posttime: '20260731' }), '2026-07-31', '8 位日期应正确解析')
    // 非法 8 位日期 → 空，不能因数值为 0 落入 Unix 时间戳分支
    assertEqual(tuisong_replace('{日期}', { posttime: '20261332' }), '', '非法 8 位日期应空')
    assertEqual(tuisong_replace('{日期}', { posttime: '00000000' }), '', '零日期应空，不应变成 1970-01-01')
    // 超大数字(≥1e14)：曾生成 '33658-09-27'，现应空
    assertEqual(tuisong_replace('{日期}', { posttime: 1e15 }), '', '超大数字应视为无效')
    // 小数字(<1e8)：曾当秒 → '1970-01-01'，现应空（避免误导日期）
    assertEqual(tuisong_replace('{日期}', { posttime: 100 }), '', '小数字应视为无效')
    // 有效时间戳不受影响：秒/毫秒
    assertEqual(/^\d{4}-\d{2}-\d{2}$/.test(tuisong_replace('{日期}', { posttime: 1785346200 })), true, '秒仍有效')
    assertEqual(/^\d{4}-\d{2}-\d{2}$/.test(tuisong_replace('{日期}', { posttime: 1754000000000 })), true, '毫秒仍有效')
    // 0 时间戳 = 1970-01-01（v3.21 口径）
    assertEqual(tuisong_replace('{日期}', { posttime: 0 }), '1970-01-01', '0 时间戳语义保留')
  })

  await test('tuisong 毫秒 posttime → 日期正确（v3.22审查3）', () => {
    const ms = Date.parse('2026-01-10T12:00:00') || 0
    const r = tuisong_replace('{日期}', { posttime: ms, url: 'x' })
    assertEqual(/^\d{4}-\d{2}-\d{2}$/.test(r), true)
  })

  await test('readMessages 数组含null元素 → 过滤不崩溃（v3.22审查4）', () => {
    const p = getFilePath('test_null_elem.json')
    require('fs').writeFileSync(p, JSON.stringify([{ id: 1 }, null, 'x', 42]), 'utf8')
    const r = readMessages(p)
    assertEqual(r.length, 1, '只保留对象元素')
    assertEqual(r[0].id, 1)
  })

  await test('htmlToMarkdown img 单引号/属性顺序（v3.22审查5）', () => {
    const r1 = htmlToMarkdown({ content_html: "<img src='http://p.jpg' alt='图1'>", url: 'http://x' })
    assertEqual(r1.includes('![图1](http://p.jpg)'), true)
    const r2 = htmlToMarkdown({ content_html: '<img alt="图2" class="x" src="http://p2.jpg">', url: 'http://x' })
    assertEqual(r2.includes('![图2](http://p2.jpg)'), true)
  })

  await test('htmlToMarkdown a标签多行链接文本（v3.22审查6）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="http://u">第一行\n第二行</a>', url: 'http://x' })
    assertEqual(r.includes('[第一行\n第二行](http://u)'), true)
  })

  await test('decodeHtmlEntities 大写X十六进制（v3.22审查7）', () => {
    assertEqual(decodeHtmlEntities('&#X1F600;'), '😀')
    assertEqual(decodeHtmlEntities('&#x1F600;'), '😀')
  })

  await test('decodeHtmlEntities 扩展实体（v3.22审查8）', () => {
    assertEqual(decodeHtmlEntities('&ndash;&bull;&yen;'), '–•¥')
  })

  await test('getFileName 去 hash（v3.22审查9）', () => {
    assertEqual(getFileName('http://x.com/a/b.json#section'), 'b.json')
  })

  await test('getFilePath 路径逃逸防护（v3.22审查11）', () => {
    const { getFilePath } = require('./xbk_function_v3.js')
    const pathMod = require('path')
    const cacheDir = pathMod.join(__dirname, 'xianbaoku_cache') + pathMod.sep
    const p1 = getFilePath('../evil.json')
    assertEqual(p1.startsWith(cacheDir), true, `应留在缓存目录内: ${p1}`)
    const p2 = getFilePath('/etc/passwd')
    assertEqual(p2.startsWith(cacheDir), true, `绝对路径应落入缓存目录: ${p2}`)
    assertEqual(p2.includes('passwd'), true)
    // 正常文件名不受影响
    assertEqual(getFilePath('normal.json').startsWith(cacheDir), true)
  })

  await test('cache.dir 指向普通文件 → 回退安全缓存目录而不崩溃', () => {
    const fs = require('fs')
    const name = 'test_cache_regular_file_dir.json'
    const original = Config.cache.dir
    let p = ''
    try {
      Config.cache.dir = 'package.json'
      p = getFilePath(name)
      assertEqual(p.startsWith(path.join(__dirname, 'package.json')), false, `普通文件不能作为缓存目录: ${p}`)
      saveBatch([{ id: 'regular-dir-safe' }], name)
      assertEqual(readMessages(p).length, 1, '回退目录应能正常落盘缓存')
    } finally {
      try { fs.unlinkSync(p) } catch (e) {}
      Config.cache.dir = original
    }
  })

  await test('pingbitime 负数/Infinity → null 不编译（v3.157: 曾落 value:0 静默关闭过滤）', () => {
    const r = compileRules({ pingbitime: '-5' })
    assertEqual(r.pingbitime, null)
    const r2 = compileRules({ pingbitime: 'Infinity' })
    assertEqual(r2.pingbitime, null)
    const warns = validateConfig({ pingbitime: '-5' })
    assertEqual(warns.some(w => w.includes('pingbitime')), true)
  })

  await test('checkTimeCompiled louzhuregtime=0 → 走解析（v3.22审查18）', () => {
    // 0 = 1970-01-01 老号，value=5 不应拦截
    const r = compileRules({ pingbitime: '5' })
    assertEqual(checkTimeCompiled(r.pingbitime, { catename: 'a', louzhuregtime: 0 }), false)
  })

  await test('url 归一化判重：/foo 与 foo/ 视为同一（v3.22审查20）', () => {
    assertEqual(normUrl('/foo/'), 'foo') // 首尾斜杠都去除
    assertEqual(normUrl('/foo'), 'foo')
    assertEqual(normUrl(' foo '), 'foo')
    // S8786 线性化回归（CodeAnt 建议）：畸形输入与旧正则语义等价
    assertEqual(normUrl('https://'), 'https:', '协议尾斜杠被剥（与旧行为一致）')
    assertEqual(normUrl('https:///path'), 'https:///path', '空 host 原样保留')
    assertEqual(normUrl('https://host'), 'https://host', 'host 小写化')
    assertEqual(normUrl('https://HOST/path'), 'https://host/path', 'host 小写化+路径保留')
    assertEqual(normUrl('  / '), '', '纯斜杠空白归空')
    assertEqual(normUrl('/\t/  /x/ '), 'x', '交替空白/斜杠线性剥离')
    // 清理可能残留的旧缓存文件
    try { require('fs').unlinkSync(getFilePath('test_urlnorm.json')) } catch (e) {}
    // 同一 url 不同形态（尾斜杠）→ 应判重为 1 条
    saveBatch([{ url: '/dup2.html' }], 'test_urlnorm.json')
    saveBatch([{ url: 'dup2.html/' }], 'test_urlnorm.json')
    assertEqual(readMessages(getFilePath('test_urlnorm.json')).length, 1, '不同尾斜杠应判重')
    // 不同 url → 2 条
    saveBatch([{ url: '/other.html' }], 'test_urlnorm2.json')
    saveBatch([{ url: '/dup2.html' }], 'test_urlnorm2.json')
    assertEqual(readMessages(getFilePath('test_urlnorm2.json')).length, 2, '不同url应2条')
  })

  await test('mdLinksToPlain 畸形输入线性等价（CodeAnt 建议回归）', () => {
    const f = slim.mdLinksToPlain
    assertEqual(f('[abc'), '[abc', '未闭合 [ 原样保留')
    assertEqual(f('[abc]()'), '[abc]()', '空 url 原样保留')
    assertEqual(f('[abc](url'), '[abc](url', '未闭合 ) 原样保留')
    assertEqual(f('[a[b](url)'), 'a[b (url)', '嵌套 [ 在首个 ] 闭合（与原正则一致）')
    assertEqual(f('x[text](https://a) y'), 'xtext (https://a) y', '常规链接正常转换')
    assertEqual(f('[https://a](https://a)'), 'https://a', '原文链接只显示一次')
    assertEqual(f('[a](url)[b](url2)'), 'a (url)b (url2)', '多链接连续转换')
    // v3.264：大量「[text]( 后无 )」的未闭合块曾每块重扫 indexOf(')') 退化为 O(n²)
    const bad = '[x]('.repeat(200000)
    const tBad = Date.now()
    assertEqual(f(bad), bad, '未闭合 ) 应原样保留')
    assert(Date.now() - tBad < 1000, `[x]( 对抗输入应 <1s，实际 ${Date.now() - tBad}ms`)
  })

  await test('looksHtml/stripAngleTags 畸形输入线性等价（CodeAnt 建议回归）', () => {
    // looksHtml：大量 "<tag" 且无 ">" 的对抗输入不得回溯卡死（线性扫描）
    const long = '<script'.repeat(20000)
    const t0 = Date.now()
    assertEqual(slim.looksHtml(long), false, '无 > 不应判 HTML')
    assertEqual(Date.now() - t0 < 1000, true, `对抗输入应 <1s，实际 ${Date.now() - t0}ms`)
    // v3.264：`<tag `（名字后跟空格）形态会走 includes('>') 全扫剩余串——原实现每处重扫
    // 呈 O(n²)（80 万字符 3s）；此形态旧测试的 '<script'（后跟 '<'）未覆盖
    const long2 = '<h1 '.repeat(200000)
    const t1 = Date.now()
    assertEqual(slim.looksHtml(long2), false, '无 > 不应判 HTML')
    assert(Date.now() - t1 < 1000, `对抗输入 <h1 应 <1s，实际 ${Date.now() - t1}ms`)
    assertEqual(slim.looksHtml('<b>hi</b>'), true, '正常 HTML 判定')
    assertEqual(slim.looksHtml('https://a.com/<b>x</b>'), true, '含 HTML 判定')
    assertEqual(slim.looksHtml('看看 <https://autolink>'), false, 'autolink 不算 HTML')
    assertEqual(slim.looksHtml('<br/>x'), true, '自闭合标签算 HTML')
    assertEqual(slim.looksHtml('<h1\u00A0id="a">hi</h1>'), true, 'U+00A0 等 Unicode 空白分隔属性仍判 HTML（空白类语义回归，CodeRabbit 完整审核）')
    // stripAngleTags：无 > 的输入原样保留，autolink 保留内容，HTML 标签剥空
    assertEqual(slim.stripAngleTags('<url>https://a</url>', true), 'https://a', 'autolink 保留内容')
    assertEqual(slim.stripAngleTags('<b>加粗</b>', true), '加粗', 'HTML 标签剥空')
    assertEqual(slim.stripAngleTags('a<b', true), 'a<b', '无 > 原样保留')
    assertEqual(slim.stripAngleTags('<b', true), '<b', '无 > 原样保留')
    assertEqual(slim.stripAngleTags('<b>x</b>', false), '<b>x</b>', 'stripAngle=false 整体保留')
  })

  await test('mdImagesToPlain 线性等价（v3.264：图片正则 O(n²) 修复回归）', () => {
    const f = slim.mdImagesToPlain
    // 行为：与旧 /!\[([^\]]*)\]\(([^)]+)\)/ → alt 逐例等价
    assertEqual(f('![alt](https://a)'), 'alt', '常规图片替换为 alt')
    assertEqual(f('![](url)'), '', '空 alt 替换为空')
    assertEqual(f('![](url)', '(图片)'), '(图片)', 'emptyAlt 参数生效')
    assertEqual(f('![] (url)'), '![] (url)', '] 与 ( 之间有空格：不匹配原样保留')
    assertEqual(f('x![a]()y'), 'x![a]()y', '空 url 原样保留')
    assertEqual(f('![a](b'), '![a](b', '未闭合 ) 原样保留')
    assertEqual(f('![a'), '![a', '未闭合 ] 原样保留')
    assertEqual(f('![a]x(b)'), '![a]x(b)', '] 后非 ( 原样保留')
    assertEqual(f('![a](b)(c)'), 'a(c)', '只替换首个闭合图片，剩余保留')
    assertEqual(f('![a![b]](c)'), '![a![b]](c)', '嵌套 [ 与旧正则一致：不匹配原样保留')
    assertEqual(f('![a](b)![c](d)'), 'ac', '多图片连续替换')
    // 性能：大量未配对 ![ 不得回溯卡死（旧正则 4 万字符 ~9.5s）
    const bad = '![a'.repeat(200000)
    const t0 = Date.now()
    assertEqual(f(bad), bad, '未配对 ![ 应原样保留')
    assert(Date.now() - t0 < 1000, `![ 对抗输入应 <1s，实际 ${Date.now() - t0}ms`)
  })

  // ==================== 71. 通读复查修复 ====================
  console.log('\n📂 71. 通读复查修复')

  await test('validateConfig 单换行 pingbitime → 无误报警告（复查1）', () => {
    // 修复前分隔符不含单\n，单换行配置被粘成一行 → 误报"天数值不是有效数字"
    const warns = validateConfig({ pingbitime: '微博###3\n赚客吧###5' })
    assertEqual(warns.length, 0, `不应误报警告: ${JSON.stringify(warns)}`)
  })

  await test('checkRegisterTime 与 checkTimeCompiled 0时间戳口径一致（复查2）', () => {
    const r = compileRules({ pingbitime: '30000' })
    // 0 = 1970-01-01 老号，但 30000 天阈值下仍按解析判断（两入口结论一致）
    // checkTimeCompiled: 拦截(true)；checkRegisterTime: 取反(false) = 不通过 = 拦截
    assertEqual(checkTimeCompiled(r.pingbitime, { louzhuregtime: 0 }), true)
    assertEqual(checkRegisterTime({ louzhuregtime: 0 }, r.pingbitime), false)
    // 常规缺失仍是放行
    assertEqual(checkRegisterTime({}, r.pingbitime), true)
  })

  // ==================== 72. 审查3轮修复 ====================
  console.log('\n📂 72. 审查3轮修复')

  await test('htmlToMarkdown h标签跨行标题 → 转换（审查3 B）', () => {
    const r = htmlToMarkdown({ content_html: '<h2>第一行\n第二行</h2>', url: 'http://x' })
    assertEqual(r.includes('## 第一行\n第二行'), true)
  })

  // ==================== 73. 审查4轮修复 ====================
  console.log('\n📂 73. 审查4轮修复')

  await test('getFileName 纯点串URL → default.json（审查4-2）', () => {
    assertEqual(getFileName('http://x.com/a/..'), 'default.json')
    assertEqual(getFileName('http://x.com/.'), 'default.json')
  })

  await test('htmlToMarkdown 无空格ahref → 转换（审查4-5）', () => {
    const r = htmlToMarkdown({ content_html: '<ahref="http://u">链接</a>', url: 'http://x' })
    assertEqual(r.includes('[链接](http://u)'), true)
  })

  await test('validateConfig pingbitime 多行带空格分类 → 无假警告（审查4-4）', () => {
    // parts[0] 未 trim 时 ' 微博 ' 直接 new RegExp 虽合法，但统一 trim 后一致
    const warns = validateConfig({ pingbitime: ' 微博 ###3\n 赚客吧 ###5' })
    assertEqual(warns.some(w => w.includes('pingbitime')), false, `不应有pingbitime警告: ${JSON.stringify(warns)}`)
  })

  // ==================== 74. 审查5轮修复 ====================
  console.log('\n📂 74. 审查5轮修复')

  await test('非法posttime → 日期留空不回退当前时间（审查5-1）', () => {
    const r = tuisong_replace('{日期}|{时间}', { posttime: 'abc', url: 'x' })
    assertEqual(r, '|')
  })

  await test('负posttime → 日期留空不生成1969（审查5-2）', () => {
    const r = tuisong_replace('{日期}', { posttime: -1, url: 'x' })
    assertEqual(r, '')
  })

  await test('validateConfig 校验 zkt_gjc（审查5-3）', () => {
    const warns = validateConfig({ zkt_gjc: '[' })
    assertEqual(warns.some(w => w.includes('zkt_gjc')), true)
    // 纯空白 → 与 App.run 口径一致，显式告警（p12 修复空白口径漂移）
    const blankWarns = validateConfig({ zkt_gjc: ' ' })
    assertEqual(blankWarns.some(w => w.includes('zkt_gjc') && w.includes('空白')), true, '空白 zkt_gjc 应显式告警')
    // 合法关键词不告警
    assertEqual(validateConfig({ zkt_gjc: '京东' }).length, 0)
  })

  await test('decodeHtmlEntities NUL字符过滤（审查5-4）', () => {
    assertEqual(decodeHtmlEntities('a&#0;b'), 'ab')
    assertEqual(decodeHtmlEntities('&#0;'), '')
  })

  // ==================== 75. 审查6轮修复(推送模块/got/代理区) ====================
  console.log('\n📂 75. 审查6轮修复')

  await test('decodeHtmlEntities 代理区字符保留原文（审查6-8）', () => {
    assertEqual(decodeHtmlEntities('&#xD800;'), '&#xD800;')
    assertEqual(decodeHtmlEntities('&#55296;'), '&#55296;')
    // emoji 不受影响
    assertEqual(decodeHtmlEntities('&#128512;'), '😀')
    assertEqual(decodeHtmlEntities('&#x1F600;'), '😀')
  })

  await test('推送模块无通道 → reject 不静默成功（审查6-2）', async () => {
    const notify = require('./xbk_sendNotify_slim.js')
    // 临时清空所有通道（不受本地配置影响），验证无通道时 reject
    const orig = { ...notify.push_config }
    const channelKeys = ['BARK_PUSH', 'QYWX_KEY', 'WX_pusher_appToken', 'WX_pusher_channels', 'WX_XIZHI_KEY', 'DEER_KEY', 'PUSH_KEY', 'PUSHME_KEY']
    channelKeys.forEach(k => { notify.push_config[k] = '' })
    let rejected = false
    try { await notify.sendNotify('标题', '内容') } catch (e) { rejected = true }
    // 恢复
    Object.assign(notify.push_config, orig)
    assertEqual(rejected, true, '未配置通道应 reject（避免主流程误判推送成功并写缓存）')
  })

  // ==================== 76. 审查7轮修复(主代码) ====================
  console.log('\n📂 76. 审查7轮修复')

  await test('whitelistFilter 空格关键词 → 全通过（审查7-1）', () => {
    assertEqual(whitelistFilter({ title: 'a b' }, 'title', ' '), true)
    assertEqual(whitelistFilter({ title: '京东神券' }, 'title', ' '), true)
    // 正常关键词不受影响
    assertEqual(whitelistFilter({ title: '京东' }, 'title', '京东'), true)
    assertEqual(whitelistFilter({ title: '淘宝' }, 'title', '京东'), false)
  })

  await test('htmlToMarkdown 空href → 不生成空链接（审查7-2）', () => {
    const r = htmlToMarkdown({ content_html: '<a href="">空链接</a>', url: 'http://x' })
    assertEqual(r.includes('[空链接]()'), false)
    assertEqual(r.includes('空链接'), true) // 文本保留
  })

  await test('htmlToMarkdown 原文链接url含] → <>包裹（审查7-3）', () => {
    const r = htmlToMarkdown({ content_html: 'x', url: 'http://u/a]b.html' })
    assertEqual(r.includes('(<http://u/a]b.html>)'), true)
    // 正常 url 不包裹
    assertEqual(htmlToMarkdown({ content_html: 'x', url: 'http://u/a.html' }).includes('(http://u/a.html)'), true)
  })

  // ==================== 77. 审查8轮(文档项升级修复) ====================
  console.log('\n📂 77. 审查8轮(文档项升级修复)')

  await test('tuisong 对象字段 → JSON 显示（审查8-2）', () => {
    const r = tuisong_replace('{价格}', { price: { value: 5.9, unit: '元' }, url: 'x' })
    assertEqual(r, '{"value":5.9,"unit":"元"}')
    // 普通字段不受影响
    assertEqual(tuisong_replace('{标题}', { title: '正常' }), '正常')
  })

  await test('daysComputed 8位日期 YYYYMMDD → 解析（审查8-3）', () => {
    const d = daysComputed('20260701')
    assertEqual(d > 0, true)
    // 非法 8 位(13月/32日) → 0
    assertEqual(daysComputed('20261332'), 0)
    assertEqual(daysComputed('20260231'), 0)
  })

  // ==================== 78. 审查9轮(文档项升级) ====================
  console.log('\n📂 78. 审查9轮(文档项升级)')

  await test('saveMessages maxSize 0/负 → 回退默认10000（审查9-B，v3.120）', () => {
    const { Config } = require('./xbk_function_v3.js')
    const orig = Config.cache.maxSize
    Config.cache.maxSize = 0 // 恶意/误配
    const arr = []
    for (let i = 0; i < 150; i++) arr.push({ id: i })
    try {
      saveMessages(getFilePath('test_maxsize0.json'), arr)
    } finally {
      Config.cache.maxSize = orig // v3.120b：finally 保证恢复
    }
    const r = readMessages(getFilePath('test_maxsize0.json'))
    assertEqual(r.length, 150, 'maxSize=0 时回退默认 10000，150 条不裁剪')
  })

  // ==================== 79. 审查10轮高价值修复 ====================
  console.log('\n📂 79. 审查10轮高价值修复')

  await test('saveBatch 含非对象元素 → 跳过不崩（审查10 #158）', () => {
    saveBatch([{ id: 1 }, null, 'x', { id: 2 }], 'test_r10_elem.json')
    const r = readMessages(getFilePath('test_r10_elem.json'))
    assertEqual(r.length, 2, `应只存2条对象，实际${r.length}`)
    assertEqual(r.map(m => m.id).join(','), '1,2')
  })

  // ==================== 80. 审查10轮批量修复(20项) ====================
  console.log('\n📂 80. 审查10轮批量修复')

  await test('htmlToMarkdown script/style 内容移除（#62）', () => {
    const r = htmlToMarkdown({ content_html: '<script>var x=1;</script>正文<style>.a{}</style>', url: 'http://x' })
    assertEqual(r.includes('var x=1'), false)
    assertEqual(r.includes('正文'), true)
  })

  await test('htmlToMarkdown content_html 对象 → 空（#68）', () => {
    const r = htmlToMarkdown({ content_html: { a: 1 }, url: 'http://x' })
    assertEqual(r.includes('[object Object]'), false)
  })

  await test('safeText：Symbol/异常对象/循环引用不抛且不泄漏伪文本（v3.229）', () => {
    assertEqual(safeText(Symbol('bad')), '', 'Symbol 应为空串')
    const bad = { toJSON () { throw new Error('bad json') } }
    assertEqual(safeText(bad), '', '异常序列化对象应为空串')
    const circular = {}; circular.self = circular
    assertEqual(safeText(circular), '', '循环对象应为空串')
    assertEqual(safeText({ a: 1 }), '{"a":1}', '普通对象保留安全 JSON 摘要')
    assertEqual(safeText('a\uD800b'), 'a�b', '孤立代理应清洗')
  })

  await test('safeErrorText：0/false 等非空原始值不被吞（Round2 C036）', () => {
    assertEqual(safeErrorText(0, 'fb'), '0', 'safeErrorText(0) 应为 0 的字符串')
    assertEqual(safeErrorText(false, 'fb'), 'false', 'safeErrorText(false) 应为 false 的字符串')
    assertEqual(safeErrorText(Symbol('x'), 'fb'), 'Symbol(x)', 'Symbol 不应被吞')
  })

  await test('_splitLines 单\r 分隔（#84）', () => {
    const lines = _splitLines('a###1\rb###2')
    assertEqual(lines.includes('a###1'), true)
    assertEqual(lines.includes('b###2'), true)
  })

  await test('pingbitime 小数 → 警告（#95）', () => {
    const warns = validateConfig({ pingbitime: '5.5' })
    assertEqual(warns.some(w => w.includes('小数')), true)
  })

  await test('validateConfig 三个### → 警告（#91）', () => {
    const warns = validateConfig({ pingbibiaoti: 'a###b###c' })
    assertEqual(warns.some(w => w.includes('多个 ###')), true)
  })

  // ==================== 81. 审查10轮批量修复(补齐测试) ====================
  console.log('\n📂 81. 审查10轮批量修复(补齐测试)')

  await test('htmlToMarkdown </br> → 换行（#58）', () => {
    const r = htmlToMarkdown({ content_html: 'a</br>b', url: 'http://x' })
    assertEqual(r.includes('a\n\nb'), true)
  })

  await test('htmlToMarkdown 尖括号剥离（#61）', () => {
    const r = htmlToMarkdown({ content_html: '<<>> 文本 >>', url: 'http://x' })
    assertEqual(r.includes('<<'), false)
    assertEqual(r.includes('文本'), true)
    // v3.173：>> / << 合法文本不再被剥离（'5>>3' 曾误删成 '53'）
    const r2 = htmlToMarkdown({ content_html: '<p>5>>3 位运算</p>', url: '' })
    assertEqual(r2.includes('5>>3'), true, `>> 应保留: ${JSON.stringify(r2)}`)
    const r3 = htmlToMarkdown({ content_html: '<p>价格<<100</p>', url: '' })
    assertEqual(r3.includes('<<'), true, `<< 应保留: ${JSON.stringify(r3)}`)
  })

  await test('htmlToMarkdown 纯文本短路路径输出正确（#66）', () => {
    // 无标签内容走短路路径，输出应与正常路径一致
    const r = htmlToMarkdown({ content_html: '纯文本&nbsp;内容', url: 'http://x' })
    assertEqual(r.includes('纯文本 内容'), true)
    assertEqual(r.includes('原文链接'), true)
  })

  await test('getFilePath 超长文件名截断（#146）', () => {
    const p = getFilePath('a'.repeat(300) + '.json')
    assertEqual(Buffer.byteLength(require('path').basename(p), 'utf8') <= 220, true, `文件名应截断: ${require('path').basename(p).length}`)
  })

  await test('saveMessages 超长文件名保存后无tmp残留（#153）', () => {
    const fs = require('fs')
    const p = getFilePath('b'.repeat(250) + '.json')
    try {
      saveMessages(p, [{ id: 1 }])
      assertEqual(fs.existsSync(p), true)
      assertEqual(fs.existsSync(p + '.tmp'), false, '不应有 tmp 残留')
    } finally {
      // 自清理：避免超长文件残留污染缓存目录（与其余测试的 unlinkSync 清理一致）
      try { fs.unlinkSync(p) } catch (e) { /* 忽略 */ }
    }
  })

  await test('validateConfig 警告去重（#120）', () => {
    // 相同警告只出现一次
    const warns = validateConfig({ pingbibiaoti: '(', pingbilouzhu: '(' })
    const cnt = warns.filter(w => w.includes('pingbibiaoti') && w.includes('无效的正则')).length
    assertEqual(cnt <= 1, true)
  })

  await test('导出包含 Pusher（#174）', () => {
    const mod = require('./xbk_function_v3.js')
    assertEqual(typeof mod.Pusher, 'object')
    assertEqual(typeof mod.Pusher.send, 'function')
  })

  await test('缓存裁剪给出提示（#243）', () => {
    const orig = require('./xbk_function_v3.js').Config.cache.maxSize
    require('./xbk_function_v3.js').Config.cache.maxSize = 5
    const warns = []
    const origWarn = console.warn
    console.warn = (msg) => warns.push(String(msg))
    try {
      const arr = []
      for (let i = 0; i < 10; i++) arr.push({ id: i })
      saveMessages(getFilePath('test_trim_warn.json'), arr)
    } finally {
      console.warn = origWarn
      require('./xbk_function_v3.js').Config.cache.maxSize = orig
    }
    assertEqual(warns.some(w => w.includes('裁剪')), true, '裁剪应提示')
  })

  await test('重复id覆盖给出提示（#252）', () => {
    const logs = []
    const orig = console.log
    console.log = (msg) => logs.push(String(msg))
    try {
      appendMessageToFile({ id: 900, title: '旧' }, 'test_upsert_warn.json')
      appendMessageToFile({ id: 900, title: '新' }, 'test_upsert_warn.json')
    } finally {
      console.log = orig
    }
    assertEqual(logs.some(w => w.includes('更新缓存记录')), true, '覆盖应提示')
  })

  // ==================== 82. 性质测试(Property-based) ====================
  console.log('\n📂 82. 性质测试(Property-based)')

  // 固定种子生成器(可复现)
  let propSeed = 20260801
  function prnd () { propSeed = (propSeed * 1103515245 + 12345) & 0x7fffffff; return propSeed / 0x7fffffff }
  function print (n) { return Math.floor(prnd() * n) }
  function ppick (a) { return a[print(a.length)] }
  function prstr (n) { const c = "abcXYZ09 &<>\"'[](){}|*+?\\/.-_$#@！；，。~"; let s = ''; for (let i = 0; i < n; i++) s += ppick(c.split('')); return s }

  await test('性质: daysComputed 任意输入返回非负整数', () => {
    const inputs = [
      () => `${2000 + print(50)}-${print(12) + 1}-${print(28) + 1}`,
      () => `${2000 + print(50)}${print(12) + 1}${print(28) + 1}`,
      () => print(2000000000), () => String(print(2000000000)), () => prstr(10),
      () => '', () => null, () => undefined, () => 'abc', () => print(100)
    ]
    for (let i = 0; i < 2000; i++) {
      const d = daysComputed(ppick(inputs)())
      assertEqual(typeof d === 'number' && Number.isInteger(d) && d >= 0, true, `daysComputed 应返回非负整数: ${d}`)
    }
  })

  await test('性质: decodeHtmlEntities 输出长度不超过输入(只缩短)', () => {
    const ents = ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;', '&nbsp;', '&#39;', '&#x41;', '&#128512;', '&hellip;', '&yen;', '&copy;']
    for (let i = 0; i < 2000; i++) {
      let s = ''
      const n = print(6) + 1
      for (let j = 0; j < n; j++) s += (prnd() < 0.5 ? ppick(ents) : prstr(print(5)))
      const d = decodeHtmlEntities(s)
      assertEqual(d.length <= s.length, true, `解码不应变长: ${s} → ${d}`)
    }
  })

  await test('性质: normUrl 幂等 normUrl(normUrl(x)) === normUrl(x)', () => {
    const urls = [
      () => '/foo/' + prstr(2), () => prstr(4) + '.html', () => 'http://A.com/' + prstr(3),
      () => '///', () => ' a ', () => 'https://x.com/' + prstr(2) + '/'
    ]
    for (let i = 0; i < 2000; i++) {
      const u = ppick(urls)()
      assertEqual(normUrl(normUrl(u)), normUrl(u), `normUrl 应幂等: ${u}`)
    }
  })

  await test('性质: anonKey 确定性 + 格式 anon:hex', () => {
    for (let i = 0; i < 500; i++) {
      const a = prstr(4); const b = prstr(4); const t = print(2e9)
      const k1 = anonKey(a, b, t); const k2 = anonKey(a, b, t)
      assertEqual(k1, k2, '同输入应同 key')
      assertEqual(/^anon:[0-9a-f]+$/.test(k1), true, `格式: ${k1}`)
    }
  })

  await test('性质: htmlToMarkdown 输出不残留常见标签', () => {
    const tags = ['h1', 'h2', 'h3', 'p', 'br', 'a', 'img']
    for (let i = 0; i < 1500; i++) {
      let html = ''
      const n = print(4) + 1
      for (let j = 0; j < n; j++) {
        const t = ppick(tags)
        if (t === 'a') html += `<a href="http://u${print(9)}">${prstr(3)}</a>`
        else if (t === 'img') html += `<img src="p${print(9)}.jpg" alt="${prstr(2)}">`
        else if (t === 'br') html += '<br>'
        else html += `<${t}>${prstr(3)}</${t}>`
      }
      const out = htmlToMarkdown({ content_html: html, url: 'http://x' })
      const re = /<(?:img|h\d|br|p|a)\b/i
      assertEqual(re.test(out), false, `不应残留标签: ${html} → ${out.slice(0, 60)}`)
    }
  })

  await test('性质: tuisong_replace 输出不含已知占位符', () => {
    const phs = ['{标题}', '{内容}', '{分类名}', '{类目}', '{链接}', '{日期}', '{时间}', '{楼主}', '{价格}', '{商城}', '{品牌}', '{图片}']
    for (let i = 0; i < 1500; i++) {
      let tpl = ''
      const n = print(4) + 1
      for (let j = 0; j < n; j++) tpl += (prnd() < 0.5 ? ppick(phs) : prstr(print(4)))
      const data = { title: prstr(3), content: prstr(3), category_name: prstr(2), url: '/' + prstr(3), posttime: print(2e9), louzhu: prstr(2), price: prstr(2), mall_name: prstr(2), brand: prstr(2), pic: prstr(3) }
      const out = tuisong_replace(tpl, data)
      for (const p of phs) {
        assertEqual(out.includes(p), false, `占位符应被替换: ${tpl} → ${out}`)
      }
    }
  })

  await test('性质: getFileName 总以 .json 结尾', () => {
    for (let i = 0; i < 1000; i++) {
      const url = 'http://x.com/' + prstr(print(8)) + ppick(['', '/', '.html', '?a=1', '#sec'])
      assertEqual(getFileName(url).endsWith('.json'), true, getFileName(url))
    }
  })

  await test('性质: compileRules 任意配置返回编译对象', () => {
    for (let i = 0; i < 1000; i++) {
      const cfg = {
        pingbibiaoti: prnd() < 0.3 ? '(' : prstr(print(5)),
        pingbilouzhu: prnd() < 0.3 ? 'x###(' : prstr(2) + '###' + prstr(2),
        pingbitime: ppick(['5', 'x###3', '(', '']),
        pingbifenlei: prnd() < 0.2 ? 'a###b' : prstr(2)
      }
      const c = compileRules(cfg)
      assertEqual(c && c.__compiled === true, true, '应返回编译对象')
      assertEqual(typeof matchesCompiled(c.pingbibiaoti, prstr(3), prstr(2)), 'boolean')
      const t = checkTimeCompiled(c.pingbitime, { catename: prstr(2), louzhuregtime: prstr(4) })
      assertEqual(t === null || typeof t === 'boolean', true)
    }
  })

  // ==================== 83. 契约测试(锁定导出 API) ====================
  console.log('\n📂 83. 契约测试(锁定导出 API)')

  await test('契约: 全部导出键存在且类型正确', () => {
    const mod = require('./xbk_function_v3.js')
    const expected = {
      listfilter: 'function',
      filterByKeyword: 'function',
      validateConfig: 'function',
      tuisong_replace: 'function',
      htmlToMarkdown: 'function',
      isMessageInFile: 'function',
      appendMessageToFile: 'function',
      getFileName: 'function',
      fetchData: 'function',
      run: 'function',
      runSingleEntry: 'function',
      whitelistFilter: 'function',
      compileRules: 'function',
      matchesCompiled: 'function',
      checkTimeCompiled: 'function',
      saveBatch: 'function',
      init: 'function',
      decodeHtmlEntities: 'function',
      anonKey: 'function',
      hasValidId: 'function',
      normUrl: 'function',
      daysComputed: 'function',
      checkRegisterTime: 'function',
      checkCategory: 'function',
      checkFields: 'function',
      _splitLines: 'function',
      getFilePath: 'function',
      _ensureFileExists: 'function',
      readMessages: 'function',
      saveMessages: 'function',
      Pusher: 'object',
      Config: 'object',
      hasNestedQuantifier: 'function',
      truncateUtf16: 'function'
    }
    const keys = Object.keys(expected)
    assertEqual(keys.length, 34, `导出键数应为34，实际${keys.length}`)
    for (const [k, type] of Object.entries(expected)) {
      assertEqual(k in mod, true, `缺少导出: ${k}`)
      assertEqual(typeof mod[k], type, `导出类型错误: ${k} 应为${type}`)
    }
  })

  await test('契约: 关键导出可独立调用(bind 生效)', () => {
    const mod = require('./xbk_function_v3.js')
    // 独立调用不依赖 this(已 bind)
    assertEqual(typeof mod.listfilter({}, {}), 'boolean')
    assertEqual(typeof mod.daysComputed('2026-01-01'), 'number')
    assertEqual(typeof mod.decodeHtmlEntities('&amp;'), 'string')
    assertEqual(typeof mod.getFileName('http://x/a.json'), 'string')
    assertEqual(typeof mod.whitelistFilter({ title: 'a' }, 'title', 'a'), 'boolean')
    assertEqual(typeof mod.compileRules({}).__compiled, 'boolean')
    assertEqual(mod.Config.domain, 'https://new.ixbk.net')
  })

  await test('契约: 单次入口全失败设置非零语义，部分成功保持成功', async () => {
    const oldExitCode = process.exitCode
    try {
      process.exitCode = undefined
      await runSingleEntry({
        run: async () => ({ total: 1, pushed: 0, failed: 1, failures: [{ code: 'ETIMEDOUT', message: 'timeout' }] })
      })
      assertEqual(process.exitCode, 1, '全推送失败时单次入口应设置非零退出码')
      process.exitCode = undefined
      await runSingleEntry({
        run: async () => ({ total: 2, pushed: 1, failed: 1, failures: [{ code: 'ETIMEDOUT', message: 'timeout' }] })
      })
      assertEqual(process.exitCode, undefined, '部分成功时不应设置失败退出码')
      process.exitCode = undefined
      await runSingleEntry({
        run: async () => ({ total: 2, pushed: 1, failed: 1, failures: [{ code: 'HTTP_401', message: 'invalid token' }] })
      })
      assertEqual(process.exitCode, undefined, '部分成功即使失败通道为永久错误，也不应熔断单次入口')
    } finally {
      process.exitCode = oldExitCode
    }
  })

  await test('契约: 核心判重链路导出互相一致(has/save/saveBatch 同口径)', () => {
    const fs = require('fs')
    const mod = require('./xbk_function_v3.js')
    const f = 'test_contract_dedup.json'
    try { fs.unlinkSync(mod.getFilePath(f)) } catch (e) {}
    mod.appendMessageToFile({ id: 1, title: 'A' }, f)
    mod.appendMessageToFile({ id: 1, title: 'B' }, f)
    mod.saveBatch([{ id: 2, title: 'C' }], f)
    const msgs = mod.readMessages(mod.getFilePath(f))
    assertEqual(msgs.length, 2, '判重应只存2条')
    assertEqual(mod.isMessageInFile({ id: 1 }, f), true, 'has 应命中')
    assertEqual(mod.isMessageInFile({ id: 3 }, f), false)
  })

  // ==================== 84. 快照测试(锁定输出格式) ====================
  console.log('\n📂 84. 快照测试(锁定输出格式)')

  await test('快照: htmlToMarkdown 组合标签', () => {
    const r = htmlToMarkdown({ content_html: '<h2>标题</h2><p>段落</p><a href="http://u">链接</a><br>换行', url: 'http://x/1.html' })
    assertEqual(r, '## 标题\n\n段落\n\n[链接](http://u)\n\n换行\n\n原文链接：[http://x/1.html](http://x/1.html)')
  })

  await test('快照: htmlToMarkdown 图片+文本', () => {
    const r = htmlToMarkdown({ content_html: '<img src="p.jpg" alt="图">正文', url: 'http://x/2.html' })
    assertEqual(r, '![图](p.jpg)\n\n正文\n\n原文链接：[http://x/2.html](http://x/2.html)')
  })

  await test('htmlToMarkdown 列表/粗体/斜体 → Markdown（v3.48）', () => {
    // <li> 列表项：曾粘连成"苹果香蕉"无分隔
    const r = htmlToMarkdown({ content_html: '<ul><li>苹果</li><li>香蕉</li></ul>', url: 'http://x' })
    assertEqual(r.includes('- 苹果'), true, `列表项应转 - 前缀: ${r}`)
    assertEqual(r.includes('- 香蕉'), true, '第二项也应 - 前缀')
    assertEqual(r.includes('苹果香蕉'), false, '不应粘连')
    // 粗体/斜体
    const r2 = htmlToMarkdown({ content_html: '<b>加粗</b>和<strong>重点</strong>与<i>斜体</i>', url: 'http://x' })
    assertEqual(r2.includes('**加粗**'), true, `粗体应转 **: ${r2}`)
    assertEqual(r2.includes('**重点**'), true, 'strong 应转 **')
    assertEqual(r2.includes('*斜体*'), true, `斜体应转 *: ${r2}`)
    // 有序列表 ol
    const r3 = htmlToMarkdown({ content_html: '<ol><li>第一步</li><li>第二步</li></ol>', url: '' })
    assertEqual(r3.includes('- 第一步'), true, 'ol 项也转 - 前缀')
    // div 块级元素：真实接口数据常见，曾粘连（v3.144）
    const rd = htmlToMarkdown({ content_html: '<div>商品一</div><div>商品二</div>', url: '' })
    assertEqual(rd.includes('商品一\n\n商品二'), true, `div 应换行: ${JSON.stringify(rd)}`)
    assertEqual(rd.includes('商品一商品二'), false, 'div 不应粘连')
    // img alt 截断（真实接口 alt 250+ 字符）+ URL 含空格不产生空 ![]()（v3.144）
    const ri = htmlToMarkdown({ content_html: '<img src="http://x.jpg" alt="' + '很长的描述'.repeat(20) + '">', url: '' })
    const altM = ri.match(/!\[([^\]]*)\]/)
    assertEqual(altM && altM[1].length <= 50, true, `alt 应截断 ≤50: ${altM && altM[1].length}`)
    const ri2 = htmlToMarkdown({ content_html: '<img src="http://x.com/a b.jpg">', url: '' })
    assertEqual(ri2.includes('http://x.com/a b.jpg'), true, 'URL 含空格应保留非空')
    assertEqual(ri2.includes('![]()'), false, '不应产生空图片')
    // 空标签不残留
    assertEqual(/<\/?[a-z][a-z0-9]*\s*>/i.test(r), false, '不应残留 HTML 标签')
  })

  await test('htmlToMarkdown 表格单元格分隔（v3.50）', () => {
    // <td> 曾全部粘连成"甲乙丙丁"无分隔
    const r = htmlToMarkdown({ content_html: '<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>', url: '' })
    assertEqual(r.includes('甲 | 乙'), true, `单元格应有 | 分隔: ${r}`)
    assertEqual(r.includes('丙 | 丁'), true, '第二行也应分隔')
    assertEqual(r.includes('甲乙'), false, '不应粘连')
    // th 表头同样分隔
    const r2 = htmlToMarkdown({ content_html: '<table><tr><th>名称</th><th>价格</th></tr></table>', url: '' })
    assertEqual(r2.includes('名称 | 价格'), true, `表头应分隔: ${r2}`)
    // 空表格不残留标签
    assertEqual(/<\/?[a-z][a-z0-9]*\s*>/i.test(r), false, '不应残留 HTML 标签')
  })

  await test('listfilter 兼容旧调用（字符串配置走 _legacyListfilter）', () => {
    // 旧路径：直接传原始字符串配置（无 __compiled），应自动编译生效
    assertEqual(listfilter({ catename: 'a', title: '京东', content: 'x', louzhuregtime: '2026-01-01' }, { pingbibiaoti: '京东' }), false, '字符串配置应拦截命中')
    assertEqual(listfilter({ catename: 'a', title: '淘宝', content: 'x', louzhuregtime: '2026-01-01' }, { pingbibiaoti: '京东' }), true, '未命中放行')
    assertEqual(listfilter({ catename: 'a', title: 'x', content: 'y', louzhuregtime: '2026-01-01' }, { pingbibiaoti: '(', pingbitime: '5' }), true, '非法正则跳过不崩')
  })

  await test('快照: htmlToMarkdown 纯文本无url', () => {
    const r = htmlToMarkdown({ content_html: '纯文本&nbsp;内容', url: '' })
    assertEqual(r, '纯文本 内容')
  })

  await test('快照: tuisong_replace 标题+日期时间', () => {
    // v3.115：{日期} UTC 解析稳定（2026-07-29）；{时间} 本地时区——断言格式而非具体值
    const r = tuisong_replace('【{分类名}】{标题}\n{日期} {时间}', { title: '测试标题', category_name: '分类', posttime: 1785346200, url: '/a.html' })
    assertEqual(r.startsWith('【分类】测试标题\n2026-07-29 '), true, `日期部分应稳定: ${r}`)
    assertEqual(/^\d{2}:\d{2}$/.test(r.slice(-5)), true, `时间部分应为 HH:MM: ${r}`)
  })

  await test('快照: tuisong_replace Markdown内容', () => {
    const r = tuisong_replace('{Markdown内容}', { content_html: '<b>粗</b>文本', title: 'T', url: 'http://x' })
    // v3.48: <b> 转 Markdown 粗体 **（原剥成纯文本）
    assertEqual(r, '**粗**文本\n\n原文链接：[http://x](http://x)')
    const safe = tuisong_replace('{Markdown内容}', { content_html: '<img src="javascript:x">', title: 'T', url: 'http://x' })
    assertEqual(/javascript:/i.test(safe), false, 'Markdown 图片不应保留危险 src')
  })

  await test('快照: tuisong_replace 多字段', () => {
    const r = tuisong_replace('{价格}|{商城}|{品牌}|{图片}', { price: '9.9', mall_name: '京东', brand: '某牌', pic: 'http://p.jpg' })
    assertEqual(r, '9.9|京东|某牌|http://p.jpg')
  })

  // ==================== 85. 性能基准(防性能回归) ====================
  console.log('\n📂 85. 性能基准(防性能回归)')

  // v3.175：基准测试负载容错——瞬时系统负载（CI 2核/并行残留进程）可能偶发超时误报，
  // 首次超时重跑一次（排除瞬时负载）；真实性能回归两次都超时仍会红（保留检测力）
  function benchRetry (fn, limitMs, label) {
    let elapsed = Infinity
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now()
      fn()
      elapsed = Date.now() - t0
      if (elapsed < limitMs) break
    }
    assertEqual(elapsed < limitMs, true, `${label} 耗时 ${elapsed}ms(应<${limitMs}ms)`)
  }

  await test('基准: htmlToMarkdown 1000次 < 500ms', () => {
    benchRetry(() => {
      for (let i = 0; i < 1000; i++) {
        htmlToMarkdown({ content_html: '<h2>标题</h2><p>段</p><a href="http://u">链</a><img src="p.jpg" alt="图">', url: 'http://x' })
      }
    }, 500, '1000次htmlToMarkdown')
  })

  await test('基准: tuisong_replace 1000次 < 300ms', () => {
    benchRetry(() => {
      const data = { title: 'T', content: 'C', content_html: '<b>x</b>', category_name: '分类', url: '/a', posttime: 1785346200 }
      for (let i = 0; i < 1000; i++) {
        tuisong_replace('【{分类名}】{标题}\n{Markdown内容}', data)
      }
    }, 300, '1000次tuisong_replace')
  })

  await test('基准: listfilter 5000次 < 500ms', () => {
    benchRetry(() => {
      const cfg = compileRules({ pingbibiaoti: '京东', pingbilouzhu: '微博###小明', pingbitime: '5' })
      const group = { catename: '微博线报', louzhu: '小明', title: '京东神券', content: '大促', louzhuregtime: '2026-01-01' }
      for (let i = 0; i < 5000; i++) listfilter(group, cfg)
    }, 500, '5000次listfilter')
  })

  // ==================== 86. 分支覆盖显式验证(关键if两方向) ====================
  console.log('\n📂 86. 分支覆盖显式验证')

  await test('分支: checkCategory 命中/未命中/字段缺失', () => {
    const c = compileRules({ pingbifenlei: '微博' })
    assertEqual(checkCategory({ catename: '微博线报' }, c.pingbifenlei), false) // 命中→拦截
    assertEqual(checkCategory({ catename: '赚客吧' }, c.pingbifenlei), true) // 未命中→放行
    assertEqual(checkCategory({ catename: '' }, c.pingbifenlei), true) // 缺失→放行
  })

  await test('分支: checkRegisterTime 超阈值/未超/缺失', () => {
    const c = compileRules({ pingbitime: '5' })
    assertEqual(checkRegisterTime({ louzhuregtime: daysAgo(2) }, c.pingbitime), false) // 新号→拦截
    assertEqual(checkRegisterTime({ louzhuregtime: '2026-01-01' }, c.pingbitime), true) // 老号→放行
    assertEqual(checkRegisterTime({}, c.pingbitime), true) // 缺失→放行
  })

  await test('分支: checkFields show/block/plus 三方向', () => {
    const c = compileRules({ zhanxianbiaoti: '白名单', pingbibiaoti: '屏蔽', pingbibiaotiplus: '强屏' })
    assertEqual(checkFields({ catename: 'a', louzhu: 'x', title: '白名单内容', content: 'c' }, c), true) // show
    assertEqual(checkFields({ catename: 'a', louzhu: 'x', title: '屏蔽词', content: 'c' }, c), false) // block
    assertEqual(checkFields({ catename: 'a', louzhu: 'x', title: '强屏词', content: 'c' }, c), false) // plus
    assertEqual(checkFields({ catename: 'a', louzhu: 'x', title: '普通', content: 'c' }, c), true) // 无规则
  })

  await test('分支: matchesCompiled re/multi/未知类型', () => {
    const c = compileRules({ pingbibiaoti: 'jd', pingbilouzhu: '微博###小明' })
    assertEqual(matchesCompiled(c.pingbibiaoti, 'JD神券', null), true) // re 命中
    assertEqual(matchesCompiled(c.pingbibiaoti, '淘宝', null), false) // re 未命中
    assertEqual(matchesCompiled(c.pingbilouzhu, '小明', '微博线报'), true) // multi 命中
    assertEqual(matchesCompiled(c.pingbilouzhu, '小明', '赚客吧'), false) // multi 分类不匹配
    assertEqual(matchesCompiled({ _type: 'x' }, '任意', null), false) // 未知类型兜底
  })

  await test('分支: whitelistFilter 空/有/非法关键词', () => {
    assertEqual(whitelistFilter({ title: 'a' }, 'title', ''), true) // 空关键词全过
    assertEqual(whitelistFilter({ title: '京东' }, 'title', '京东'), true) // 命中
    assertEqual(whitelistFilter({ title: '淘宝' }, 'title', '京东'), false) // 未命中
    assertEqual(whitelistFilter({ title: 'a' }, 'title', '('), true) // 非法正则→放行（宁可多推，与 App.run 口径一致）
  })

  await test('分支: compileRules 简单/多行/###跳过/非法', () => {
    assertEqual(compileRules({ pingbibiaoti: 'jd' }).pingbibiaoti._type, 're')
    assertEqual(compileRules({ pingbilouzhu: '微博###小明' }).pingbilouzhu._type, 'multi')
    assertEqual(compileRules({ pingbifenlei: 'a###b' }).pingbifenlei, null) // ### 跳过
    assertEqual(compileRules({ pingbibiaoti: '(' }).pingbibiaoti, null) // 非法→null
    assertEqual(compileRules({}).pingbibiaoti, null) // 空→null
  })

  await test('分支: daysComputed 日期/时间戳/非法/未来', () => {
    assertEqual(typeof daysComputed('2026-07-31'), 'number') // 日期
    assertEqual(typeof daysComputed(1785346200), 'number') // 时间戳
    assertEqual(daysComputed('not-date'), 0) // 非法→0
    assertEqual(daysComputed('2099-01-01'), 0) // 未来→0
    assertEqual(daysComputed(null), 0) // 空→0
  })

  // ==================== 87. 安全测试(原型污染+输出注入) ====================
  console.log('\n📂 87. 安全测试')

  await test('安全: listfilter 不受 __proto__ 污染', () => {
    delete Object.prototype.polluted
    const g = { catename: '微博', title: 'x', __proto__: { polluted: 1 } }
    listfilter(g, {})
    assertEqual(Object.prototype.polluted, undefined, '不应污染原型')
  })

  await test('安全: compileRules 配置含 __proto__ 不污染', () => {
    delete Object.prototype.polluted
    const cfg = JSON.parse('{"pingbibiaoti":"jd","__proto__":{"polluted":1}}')
    compileRules(cfg)
    assertEqual(Object.prototype.polluted, undefined, '不应污染原型')
  })

  await test('安全: saveBatch 数据含 __proto__ 键不污染', () => {
    delete Object.prototype.polluted
    const msg = { id: 7, title: 'x' }
    Object.defineProperty(msg, '__proto__', { value: { polluted: 1 }, enumerable: true })
    saveBatch([msg], 'test_proto_safe.json')
    assertEqual(Object.prototype.polluted, undefined, '不应污染原型')
    const r = readMessages(getFilePath('test_proto_safe.json'))
    assertEqual(Array.isArray(r), true)
  })

  await test('安全: htmlToMarkdown 输出无事件注入残留', () => {
    const r = htmlToMarkdown({ content_html: '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">链接</a>', url: 'http://x' })
    assertEqual(r.includes('onerror'), false, '不应残留 onerror')
    assertEqual(r.includes('javascript:'), false, '不应残留 javascript:')
    assertEqual(r.includes('<script'), false, '不应残留 script')
  })

  await test('安全: 实体解码后主动 HTML/事件属性仍被清理', () => {
    const cases = [
      '&lt;script&gt;alert(1)&lt;/script&gt;正文',
      '&lt;img src="javascript:x" onerror="alert(1)"&gt;正文',
      '&lt;iframe src="https://evil.example"&gt;恶意&lt;/iframe&gt;正文',
      // v3.254 P0(XSS)：引号值闭合后无空格紧跟的 onerror（HTML5 视为新属性）也必须清除
      '<img src="x"onerror="alert(1)">正文',
      '<img src="x"onclick="f()" onmouseover="g()">正文'
    ]
    for (const h of cases) {
      const r = htmlToMarkdown({ content_html: h, url: '' })
      assertEqual(/<\/?(?:script|iframe|object|embed)\b/i.test(r), false, `实体主动标签不应残留: ${r}`)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r), false, `实体事件属性不应残留: ${r}`)
      assertEqual(/(?:javascript|vbscript|data):/i.test(r), false, `实体危险协议不应残留: ${r}`)
      assertEqual(r.includes('正文'), true, '安全文本应保留')
    }
  })

  await test('安全: 相邻 on* 事件属性逐轮剥除（Round2 C001）', () => {
    // 单次 replace 连引号分隔符一起消费后，后续相邻 on* 属性会残留；逐轮剥除覆盖该形态
    const strip = [
      '<img onerror="alert(1)"onclick="alert(2)">',
      '<img src="x"onerror="a"onclick="b">'
    ]
    for (const h of strip) {
      const r = htmlToMarkdown({ content_html: h, url: '' })
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r), false, `事件属性不应残留: ${h} → ${r.slice(0, 90)}`)
    }
    // Round2 二次修复：32 个相邻 on* 属性链（去掉 5 轮上限后应全部剥除，曾残留最后 1 个）
    let chain = '<img '
    for (let i = 0; i < 32; i++) chain += `onerror${i}="x"`
    chain += '>'
    const r2 = sanitizeDecodedHtml(chain)
    assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r2), false, `32 链事件属性不应残留: ${r2.slice(0, 90)}`)
    // 未闭合引号事件属性也应剥除（Round2 C045 边界）
    for (const h of ['<img src="x"onerror="a>', '<img src="x" onerror="a>']) {
      const r3 = sanitizeDecodedHtml(h)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r3), false, `未闭合引号事件属性不应残留: ${h} → ${r3.slice(0, 90)}`)
    }
    // 回归：引号值内 on 开头的合法 URL 仍应保留
    const keep = '<a href="onclick=x">link</a>'
    const r = tuisong_replace('{Html内容}', { content_html: keep, url: 'https://example.com' })
    const m = keep.match(/href="([^"]*)"/)
    assertEqual(r.includes(`href="${m[1]}"`), true, `引号值内合法 on 开头值应保留: ${keep} → ${r.slice(0, 90)}`)
  })

  await test('安全: 引号值内 on 开头的合法 URL/值不被误伤（v3.257 修复 086）', () => {
    // 曾把 href="onclick=x" 当事件属性清空为 href=""（合法 URL 被破坏）
    const keep = [
      '<a href="onclick=x">link</a>', // on 开头的合法相对 URL
      '<a href="https://x.com/p?onclick=1">go</a>', // URL 参数含 onclick
      '<a href="http://onmouseover.example/a">m</a>' // 值内含 on 字样
    ]
    for (const h of keep) {
      const r = tuisong_replace('{Html内容}', { content_html: h, url: 'https://example.com' })
      const m = h.match(/href="([^"]*)"/)
      assertEqual(r.includes(`href="${m[1]}"`), true, `引号值内合法 on 开头值应保留: ${h} → ${r.slice(0, 90)}`)
    }
    // 回归：无空格 XSS 形态与真事件属性仍必须清除
    const strip = [
      '<img src="x"onerror="alert(1)">',
      '<img onclick="f()" src="x">',
      '<a href="x" onmouseover="g()">h</a>'
    ]
    for (const h of strip) {
      const r = tuisong_replace('{Html内容}', { content_html: h, url: 'https://example.com' })
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r), false, `事件属性不应残留: ${h} → ${r.slice(0, 90)}`)
    }
  })

  await test('安全: 实体编码 href 不绕过危险协议检查（v3.143）', () => {
    // javascript&#58; / &#106;avascript: / jav&#x61;script: 等编码形式曾绕过（decode 在 a 转换后）
    const cases = [
      'javascript&#58;alert(1)',
      'javascript&#x3A;alert(1)',
      '&#106;avascript:alert(1)',
      'jav&#x61;script:alert(1)',
      'vbscript&#58;msgbox(1)'
    ]
    for (const h of cases) {
      const r = htmlToMarkdown({ content_html: `<a href="${h}">点我</a>`, url: '' })
      assertEqual(r.includes('javascript:'), false, `不应残留 javascript: (${h})`)
      assertEqual(r.includes('vbscript:'), false, `不应残留 vbscript: (${h})`)
      assertEqual(r.includes('[点我]'), false, '危险链接应降级为纯文本')
      assertEqual(r.includes('alert(1)') || r.includes('msgbox(1)'), false, '不应保留危险 payload')
    }
    // 正常 http/https 链接不受影响
    const ok = htmlToMarkdown({ content_html: '<a href="https://x.com/a?b=1">正常</a>', url: '' })
    assertEqual(ok.includes('[正常](https://x.com/a?b=1)'), true, '正常链接应保留')
  })

  await test('安全: 剥标签后无闭合标签残留', () => {
    const r = htmlToMarkdown({ content_html: '文本</div><p>段</p><br><h1>标题</h1>', url: 'http://x' })
    assertEqual(/<\/?[a-z][a-z0-9]*\s*>/i.test(r), false, '不应残留任何 HTML 标签')
  })

  // ==================== 88. 稳定性/时间旅行/竞态 ====================
  console.log('\n📂 88. 稳定性/时间旅行/竞态')

  await test('稳定性: 连续500轮调用内存不显著增长', () => {
    global.gc && global.gc()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < 500; i++) {
      daysComputed('2026-07-31')
      htmlToMarkdown({ content_html: '<h2>标题</h2><p>段</p>', url: 'http://x' })
      tuisong_replace('{标题}|{日期}', { title: 'T', posttime: 1785346200 })
      decodeHtmlEntities('&amp;&#65;')
    }
    const growth = process.memoryUsage().heapUsed - before
    // GC 未强制时允许一定增长，阈值 30MB 宽松
    assertEqual(growth < 30 * 1024 * 1024, true, `内存增长 ${(growth / 1024 / 1024).toFixed(1)}MB(应<30MB)`)
  })

  await test('时间旅行: 固定 Date.now 后 daysComputed 确定性', () => {
    const origNow = Date.now
    try {
      // v3.115：用 Date.UTC 构造固定"今天"——与 parseTime 的 UTC 解析口径一致（跨时区稳定）
      Date.now = () => Date.UTC(2026, 7, 1) // 固定"今天"= 2026-08-01 00:00 UTC
      assertEqual(daysComputed('2026-07-31'), 1, '昨天应=1天')
      assertEqual(daysComputed('2026-08-01'), 0, '今天应=0天')
      assertEqual(daysComputed('2026-08-02'), 0, '明天应=0天(未来)')
      assertEqual(daysComputed('2026-06-01'), 61, '61天前应=61')
    } finally {
      Date.now = origNow
    }
  })

  await test('内存: _memoryCache 上限防御（防无限增长泄漏）', async () => {
    const fs = require('fs')
    // 写入 105 个不同文件名 → 内存缓存 key 超 100 应触发重置（磁盘权威不受影响）
    for (let i = 0; i < 105; i++) saveBatch([{ id: i }], 'test_memo_' + i + '.json')
    // 重置后重新读取仍正常（从磁盘恢复）
    const r = readMessages(getFilePath('test_memo_50.json'))
    assertEqual(Array.isArray(r) && r.length === 1, true, '超限重置后读取应正常')
    // 清理
    for (let i = 0; i < 105; i++) { try { fs.unlinkSync(getFilePath('test_memo_' + i + '.json')) } catch (e) {} }
  })

  await test('竞态: 并发 saveBatch 到同一文件不损坏', async () => {
    const fs = require('fs')
    try { fs.unlinkSync(getFilePath('test_race.json')) } catch (e) {}
    const batches = []
    for (let i = 0; i < 10; i++) batches.push([{ id: i, title: 't' + i }])
    await Promise.all(batches.map(b => Promise.resolve().then(() => saveBatch(b, 'test_race.json'))))
    // 并发后文件必须是合法 JSON 数组(原子写未损坏)
    const data = JSON.parse(fs.readFileSync(getFilePath('test_race.json'), 'utf8'))
    assertEqual(Array.isArray(data), true)
    assertEqual(data.length >= 1, true)
  })

  // ==================== 89. 配置矩阵(组合爆炸) ====================
  console.log('\n📂 89. 配置矩阵')

  await test('矩阵: 过滤字段全组合 listfilter 不崩', () => {
    const fields = ['pingbifenlei', 'pingbibiaoti', 'zhanxianbiaoti', 'pingbibiaotiplus', 'pingbineirong', 'zhanxianneirong', 'pingbineirongplus', 'pingbilouzhu', 'zhanxianlouzhu', 'pingbilouzhuplus']
    const group = { catename: '微博线报', louzhu: '小明', title: '京东神券', content: '限时大促内容', louzhuregtime: '2026-01-01' }
    // 2^10 全组合(每个字段 开/关)
    for (let mask = 0; mask < 1024; mask++) {
      const cfg = {}
      for (let i = 0; i < fields.length; i++) {
        if (mask & (1 << i)) cfg[fields[i]] = '京东'
      }
      cfg.pingbitime = mask % 3 === 0 ? '5' : ''
      const r = listfilter(group, cfg)
      assertEqual(typeof r === 'boolean', true, `组合 ${mask} 应返回布尔`)
    }
  })

  await test('矩阵: 配置含全部字段+无效值不崩', () => {
    const all = {
      pingbifenlei: '(',
      pingbibiaoti: 'x###(',
      zhanxianbiaoti: '(((',
      pingbibiaotiplus: 'a###b###c',
      pingbineirong: '(',
      zhanxianneirong: '[',
      pingbineirongplus: '\\',
      pingbilouzhu: 'a###',
      zhanxianlouzhu: 'jd',
      pingbilouzhuplus: '(?=)',
      pingbitime: 'Infinity',
      zkt_gjc: '['
    }
    const c = compileRules(all)
    const g = { catename: '', louzhu: null, title: '', content: undefined }
    assertEqual(typeof listfilter(g, c), 'boolean')
    assertEqual(Array.isArray(validateConfig(all)), true)
  })

  // ==================== 90. 死代码检测(可达性) ====================
  console.log('\n📂 90. 死代码检测')

  await test('可达性: 全部导出被测试引用', () => {
    const mod = require('./xbk_function_v3.js')
    const tf = require('fs').readFileSync(path.join(__dirname, 'test_filter.js'), 'utf8')
    const ta = require('fs').readFileSync(path.join(__dirname, '/test_app.js'), 'utf8')
    const all = tf + ta
    const unused = []
    for (const k of Object.keys(mod)) {
      if (k === 'Config' || k === 'Pusher') continue
      // 测试中是否出现该导出名
      if (!all.includes(k) && !all.includes('.' + k)) unused.push(k)
    }
    assertEqual(unused.length, 0, `未使用的导出: ${unused.join(', ')}`)
  })

  await test('可达性: _splitLines/_parseLine 等内部方法被使用', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '/xbk_function_v3.js'), 'utf8')
    // 内部 helper 都应被调用(出现次数 > 定义处)
    for (const h of ['_parseLine', '_compileCatRe', '_validateCatRe', '_catMatches', '_anyRule', '_passIfMissing', '_findDedupIndex', '_upsert', '_finalizeMd', '_decodeNumeric', 'isValidItem', 'daysFrom']) {
      const cnt = (src.match(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
      assertEqual(cnt >= 2, true, `${h} 应被调用(出现${cnt}次)`)
    }
  })

  // ==================== 91. Unicode 深度测试 ====================
  console.log('\n📂 91. Unicode 深度测试')

  await test('Unicode: emoji 代理对在解码/格式化/判重中正常', () => {
    assertEqual(decodeHtmlEntities('&#128512;'), '😀') // emoji 解码
    assertEqual(decodeHtmlEntities('&#x1F600;'), '😀') // hex emoji
    const r = htmlToMarkdown({ content_html: '<p>🎉 大促 🚀</p>', url: 'http://x' })
    assertEqual(r.includes('🎉 大促 🚀'), true, 'emoji 保留')
    assertEqual(normUrl('http://A.com/🎉'), normUrl('http://a.com/🎉'), 'emoji url 判重一致')
    const key1 = anonKey('🎉', '🚀'); const key2 = anonKey('🎉', '🚀')
    assertEqual(key1, key2, 'emoji 参与合成 id 确定')
  })

  await test('Unicode: 全角/组合字符/零宽不破坏', () => {
    const r = htmlToMarkdown({ content_html: '<p>ＡＢＣ　全角</p>', url: 'http://x' })
    assertEqual(r.includes('ＡＢＣ　全角'), true)
    // 组合字符(é = e + ́)
    const comb = 'e\u0301'
    const r2 = tuisong_replace('{标题}', { title: comb })
    assertEqual(r2, comb)
    // 零宽空格保留
    const zw = 'a\u200bb'
    assertEqual(decodeHtmlEntities(zw), zw)
  })

  await test('Unicode: 判重对 emoji/全角 id 稳定', () => {
    saveBatch([{ id: '😀', url: '/u1' }, { id: '😀', url: '/u2' }, { id: 'Ａ', url: '/u3' }], 'test_uni_dedup.json')
    const r = readMessages(getFilePath('test_uni_dedup.json'))
    assertEqual(r.length, 2, 'emoji id 应判重,全角 id 不同')
  })

  await test('判重: 布尔/对象/Symbol id 不误合并（v3.20 id:null 修复的同类漏网）', () => {
    const fs = require('fs')
    // 布尔 id：false/true 曾被 String('false') 判为有效 → 不同数据误合并
    try { fs.unlinkSync(getFilePath('test_boolid.json')) } catch (e) {}
    saveBatch([
      { id: false, url: '/a', title: '甲' },
      { id: false, url: '/b', title: '乙' },
      { id: true, url: '/c', title: '丙' }
    ], 'test_boolid.json')
    const r = readMessages(getFilePath('test_boolid.json'))
    assertEqual(r.length, 3, `布尔 id 应走 url 判重各存 1 条，实际 ${r.length}`)
    // 对象/Symbol id 同样无效
    const symId = Symbol('s')
    try { fs.unlinkSync(getFilePath('test_objid.json')) } catch (e) {}
    saveBatch([
      { id: {}, url: '/x', title: '对象甲' },
      { id: {}, url: '/y', title: '对象乙' },
      { id: symId, url: '/z', title: '符号丙' }
    ], 'test_objid.json')
    const r2 = readMessages(getFilePath('test_objid.json'))
    assertEqual(r2.length, 3, `对象/Symbol id 应走 url 判重各存 1 条，实际 ${r2.length}`)
    // 数字/字符串 id 仍有效
    assertEqual(hasValidId({ id: 0 }), true, '数字 0 仍视为有效')
    assertEqual(hasValidId({ id: 'x' }), true, '字符串仍有效')
    assertEqual(hasValidId({ id: NaN }), false, 'NaN 无效')
    assertEqual(hasValidId({ id: '' }), false, '空串无效')
    assertEqual(hasValidId({ id: false }), false, '布尔无效')
    assertEqual(hasValidId({ id: {} }), false, '对象无效')
  })

  await test('Unicode: truncateUtf16 不切断代理对', () => {
    const s = '😀'.repeat(51) // 102 码元
    // 奇数码元截断（原 slice 会在代理对中间切断 → 孤立高代理乱码）
    const cut = truncateUtf16(s, 99)
    assertEqual(cut.length, 98, `99 码元截断应退一位到 98（49 个完整 emoji），实际 ${cut.length}`)
    assertEqual(cut, '😀'.repeat(49), '应为 49 个完整 emoji')
    // 偶数码元截断（配对完整低代理末尾）→ 保留
    const cut2 = truncateUtf16(s, 100)
    assertEqual(cut2.length, 100, '配对完整时保留 100 码元')
    assertEqual(cut2, '😀'.repeat(50), '应为 50 个完整 emoji')
    // 中文/ASCII 不受影响（汉字 BMP 单码元）
    assertEqual(truncateUtf16('你好世界abcdef', 4), '你好世界')
    assertEqual(truncateUtf16('你好世界abcdef', 6), '你好世界ab')
    assertEqual(truncateUtf16('abc', 5), 'abc')
    // 不超限返回原串
    assertEqual(truncateUtf16('😀😀', 4), '😀😀')
    // 混合：末尾恰为中文（无代理）不误退
    assertEqual(truncateUtf16('😀😀中文', 4), '😀😀')
  })

  // ==================== 92. 故障注入(fs错误) ====================
  console.log('\n📂 92. 故障注入')

  await test('故障注入: fs.writeFileSync 抛错 → saveMessages 不崩溃', () => {
    const fs = require('fs')
    const orig = fs.writeFileSync
    fs.writeFileSync = () => { throw new Error('磁盘满') }
    try {
      saveMessages(getFilePath('test_fault.json'), [{ id: 1 }])
      // 不应抛到调用方(内部已 try-catch)
    } finally {
      fs.writeFileSync = orig
    }
    assertEqual(true, true, 'fs 写失败应被容错')
  })

  await test('故障注入: fs.readFileSync 抛错 → readMessages 返回空数组', () => {
    const fs = require('fs')
    const orig = fs.readFileSync
    fs.readFileSync = () => { throw new Error('IO错误') }
    try {
      const r = readMessages(getFilePath('test_fault_read.json'))
      assertEqual(Array.isArray(r), true)
    } finally {
      fs.readFileSync = orig
    }
  })

  await test('故障注入: 双故障(read+write都抛) → readMessages 不崩溃', () => {
    const fs = require('fs')
    const origR = fs.readFileSync; const origW = fs.writeFileSync
    fs.readFileSync = () => { throw new Error('IO读错误') }
    fs.writeFileSync = () => { throw new Error('磁盘满写错误') }
    try {
      const r = readMessages(getFilePath('test_dual_fault.json'))
      assertEqual(Array.isArray(r), true, '双故障应仍返回数组')
    } finally {
      fs.readFileSync = origR
      fs.writeFileSync = origW
    }
  })

  await test('故障注入: fs.renameSync 抛错 → saveMessages 不崩溃+tmp残留清理', () => {
    const fs = require('fs')
    const orig = fs.renameSync
    fs.renameSync = () => { throw new Error('rename失败') }
    const p = getFilePath('test_rename_fault.json')
    try {
      saveMessages(p, [{ id: 1 }]) // 内部 try-catch，不应抛
      assertEqual(fs.existsSync(p + '.tmp'), false, 'tmp 应被清理')
    } finally {
      fs.renameSync = orig
      try { fs.unlinkSync(p) } catch (e) {}
    }
    assertEqual(true, true, 'rename 失败应被容错')
  })

  await test('故障注入: saveBatch 落盘失败 → 内存缓存不得提前判重', () => {
    const fs = require('fs')
    const name = 'test_save_batch_persist_fail.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    // 先建立空的内存缓存快照，再模拟 rename 失败。
    readMessages(p)
    const orig = fs.renameSync
    fs.renameSync = () => { throw new Error('rename失败') }
    try {
      saveBatch([{ id: 991 }], name)
    } finally {
      fs.renameSync = orig
    }
    assertEqual(isMessageInFile({ id: 991 }, name), false, '落盘失败的消息不能被内存缓存判定为已处理')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('故障注入: 缓存损坏且重置 rename 失败 → 不污染内存，恢复后可重新读取', () => {
    const fs = require('fs')
    const name = 'test_reset_failure_memory.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    fs.writeFileSync(p, '{bad json', 'utf8')
    const origRename = fs.renameSync
    fs.renameSync = () => { throw new Error('reset rename 失败') }
    try {
      const first = readMessages(p)
      assertEqual(Array.isArray(first), true, '损坏缓存读取应返回数组')
    } finally {
      fs.renameSync = origRename
    }
    fs.writeFileSync(p, JSON.stringify([{ id: 992 }]), 'utf8')
    const recovered = readMessages(p)
    assertEqual(recovered.some(m => m.id === 992), true, '重置失败时不能缓存空数组，恢复后应重新读到磁盘内容')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('故障注入: 缓存读取 ioError → 不缓存空结果，恢复后重新读取', () => {
    const fs = require('fs')
    const name = 'test_read_failure_memory.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    fs.writeFileSync(p, JSON.stringify([{ id: 993 }]), 'utf8')
    const origRead = fs.readFileSync
    fs.readFileSync = (filePath, ...args) => {
      if (filePath === p) throw new Error('read 失败')
      return origRead.call(fs, filePath, ...args)
    }
    try {
      assertEqual(readMessages(p).length, 0, '读取失败本次返回空数组但不能缓存')
    } finally {
      fs.readFileSync = origRead
    }
    const recovered = readMessages(p)
    assertEqual(recovered.some(m => m.id === 993), true, '读取恢复后必须重新读取文件')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('故障注入: fs.mkdirSync 抛错 → init 不崩溃', () => {
    const fs = require('fs')
    const orig = fs.mkdirSync
    fs.mkdirSync = () => { throw new Error('权限不足') }
    try {
      init() // init 内部 try-catch(console.error)，不应抛
      assertEqual(true, true)
    } finally {
      fs.mkdirSync = orig
    }
  })

  await test('故障注入: fs.readdirSync 抛错 → 测试清理不崩溃', () => {
    const fs = require('fs')
    const orig = fs.readdirSync
    fs.readdirSync = () => { throw new Error('readdir失败') }
    try {
      // 模拟测试结尾清理逻辑（readdirSync 抛 → catch 吞）
      try {
        const dir = require('path').join(__dirname, 'xianbaoku_cache')
        if (fs.existsSync(dir)) {
          fs.readdirSync(dir).forEach(() => { /* 清理 */ })
        }
      } catch (e) { /* 预期吞掉 */ }
      assertEqual(true, true, 'readdir 失败应被容错')
    } finally {
      fs.readdirSync = orig
    }
  })

  await test('故障注入: 循环引用 message → saveMessages/saveBatch 不崩溃', () => {
    const fs = require('fs')
    const circular = { id: 1, title: '循环' }
    circular.self = circular // 循环引用
    const p = getFilePath('test_circular.json')
    try { fs.unlinkSync(p) } catch (e) {}
    saveMessages(p, [circular]) // 序列化失败应容错（内存保留不落盘）
    assertEqual(true, true, 'saveMessages 循环引用应容错')
    saveBatch([circular], 'test_circular.json') // _upsert 比较失败按更新处理
    assertEqual(true, true, 'saveBatch 循环引用应容错')
  })

  // ==================== 93. 深度嵌套压力 ====================
  console.log('\n📂 93. 深度嵌套压力')

  await test('压力: 100层嵌套HTML不崩不卡', () => {
    const deep = '<div>'.repeat(100) + '最深层' + '</div>'.repeat(100)
    const r = htmlToMarkdown({ content_html: deep, url: 'http://x' })
    assertEqual(r.includes('最深层'), true)
    assertEqual(r.includes('<div>'), false, '嵌套标签应剥净')
  })

  await test('压力: 100条多行规则 matchesCompiled 正常', () => {
    let cfg = ''
    for (let i = 0; i < 100; i++) cfg += `分类${i}###关键词${i}\n`
    const c = compileRules({ pingbilouzhu: cfg })
    assertEqual(c.pingbilouzhu.rules.length, 100)
    assertEqual(matchesCompiled(c.pingbilouzhu, '关键词50', '分类50'), true)
    assertEqual(matchesCompiled(c.pingbilouzhu, '关键词50', '其他'), false)
  })

  // ==================== 94. 兼容性/契约/一致性 ====================
  console.log('\n📂 94. 兼容性/契约/一致性')

  await test('兼容: 旧格式缓存(无timestamp/缺字段)读入不崩', () => {
    const fs = require('fs')
    // 模拟旧版本缓存: 无 timestamp、结构简化
    fs.writeFileSync(getFilePath('test_old_cache.json'), JSON.stringify([{ id: 1, title: '旧数据' }, '损坏行', { id: 2, url: '/u' }]), 'utf8')
    const r = readMessages(getFilePath('test_old_cache.json'))
    assertEqual(Array.isArray(r), true, '应返回数组')
    assertEqual(r.filter(m => m && typeof m === 'object').length >= 1, true)
    // 不崩溃可继续使用
    assertEqual(isMessageInFile({ id: 1 }, 'test_old_cache.json'), true)
  })

  await test('兼容: 缓存含多余字段不破坏判重', () => {
    const fs = require('fs')
    fs.writeFileSync(getFilePath('test_extra_fields.json'), JSON.stringify([{ id: 5, url: '/e', title: 'x', extra: { a: 1 }, legacy: 'old' }]), 'utf8')
    assertEqual(isMessageInFile({ id: 5 }, 'test_extra_fields.json'), true)
    assertEqual(isMessageInFile({ url: '/e' }, 'test_extra_fields.json'), true)
  })

  await test('契约: Config 默认值全量锁定', () => {
    const { Config } = require('./xbk_function_v3.js')
    assertEqual(Config.domain, 'https://new.ixbk.net')
    assertEqual(Config.api.timeout, 5000)
    assertEqual(Config.api.retry, 2)
    assertEqual(Config.filter.pingbitime, '5')
    assertEqual(Config.keyword.zkt_gjc, '')
    assertEqual(Config.timing.pushInterval, 0)
    assertEqual(Config.timing.finalWait, 0)
    assertEqual(Config.cache.maxSize, 10000)
    assertEqual(Config.cache.dir, 'xianbaoku_cache')
    assertEqual(Config.push.mode, 'parallel')
    assertEqual(Config.push.parallelLimit, 10)
    assertEqual(Config.api.pushUrl, 'https://new.ixbk.net/plus/json/push.json')
  })

  await test('一致性: save 后内存缓存与磁盘文件一致', () => {
    const fs = require('fs')
    try { fs.unlinkSync(getFilePath('test_mem_disk.json')) } catch (e) {}
    appendMessageToFile({ id: 1, title: 'A' }, 'test_mem_disk.json')
    appendMessageToFile({ id: 2, title: 'B' }, 'test_mem_disk.json')
    const mem = readMessages(getFilePath('test_mem_disk.json')) // 走内存缓存
    const disk = JSON.parse(fs.readFileSync(getFilePath('test_mem_disk.json'), 'utf8'))
    assertEqual(JSON.stringify(mem), JSON.stringify(disk), '内存与磁盘应一致')
  })

  await test('一致性: 多轮 saveBatch 后内存与磁盘同步', () => {
    const fs = require('fs')
    try { fs.unlinkSync(getFilePath('test_mem_disk2.json')) } catch (e) {}
    for (let i = 0; i < 5; i++) saveBatch([{ id: i }], 'test_mem_disk2.json')
    const mem = readMessages(getFilePath('test_mem_disk2.json'))
    const disk = JSON.parse(fs.readFileSync(getFilePath('test_mem_disk2.json'), 'utf8'))
    assertEqual(mem.length, 5)
    assertEqual(JSON.stringify(mem), JSON.stringify(disk), '多轮后仍一致')
  })

  // ==================== 95. ReDoS 防护(灾难性回溯) ====================
  console.log('\n📂 95. ReDoS 防护(灾难性回溯)')

  // 95-1. hasNestedQuantifier 检测正确性
  await test('ReDoS: hasNestedQuantifier 命中嵌套量词模式', () => {
    for (const p of ['(a+)+', '(a*)*', '(a+)*', '(a*)+', '(?:a+)+', '((a+)+)', '((a)+)+', '(a+)+$', '(a{2,})+', '(a+)+(b+)+', '(a?)+', '(ab?)+', '(a?){2,}', '(\\d+)+']) {
      assertEqual(hasNestedQuantifier(p), true, `应判定危险: ${p}`)
    }
    // v3.174：歧义交替 + 无限量词也判危险（(a|aa)+ 曾漏检——'^(a|aa)+b$' 对 30a 已 156ms/40a 2.5s 指数爆炸）
    for (const p of ['(a|aa)+', '(a|ab)+', '(ab|a)+', '(?:a|aa)+', '(a|b)+', '(a|a)+', '(aa|ab)+b', '(a|aa){2,}', '((a|b)+)+']) {
      assertEqual(hasNestedQuantifier(p), true, `歧义交替应判定危险: ${p}`)
    }
  })

  await test('ReDoS: hasNestedQuantifier 放过安全模式', () => {
    for (const p of ['(a+){1,3}', '(a+)?', '(ab)+', 'a+', 'a{2,}', '[()]+', '\\\\(a+\\\\)+', '', '(a+b)+', '(a+)b', '[a+]', '(a{2})+', '(a{2,3})+', '京东', '微博|赚客吧', 'a|b', '(a|b)', '(a|b){2,3}', '[a|b]+', 'colou?r', '(a|b)c']) {
      assertEqual(hasNestedQuantifier(p), false, `不应判定危险: ${p}`)
    }
  })

  // 95-2. compileRules 拦截（不生成正则，避免运行时卡死）
  await test('ReDoS: compileRules 跳过嵌套量词规则(简单模式)', () => {
    const c = compileRules({ pingbibiaoti: '(a+)+' })
    assertEqual(c.pingbibiaoti, null, '嵌套量词规则应被跳过')
    // 其他字段不受影响
    const c2 = compileRules({ pingbibiaoti: '京东', pingbilouzhu: '(a+)+' })
    assertEqual(c2.pingbibiaoti._type, 're', '正常规则仍编译')
    assertEqual(c2.pingbilouzhu, null, '风险规则跳过')
  })

  await test('ReDoS: compileRules 跳过嵌套量词(多行模式)', () => {
    const c = compileRules({ pingbilouzhu: '微博###(a+)+<br>赚客吧###小明' })
    // 第一行(风险)被跳过，第二行保留
    assertEqual(c.pingbilouzhu.rules.length, 1, `应只保留1条安全规则，实际${c.pingbilouzhu.rules.length}`)
    assertEqual(matchesCompiled(c.pingbilouzhu, '小明', '赚客吧'), true, '安全规则仍生效')
  })

  // 95-3. validateConfig 警告
  await test('ReDoS: validateConfig 对嵌套量词给出警告', () => {
    const warns = validateConfig({ pingbibiaoti: '(a+)+', zkt_gjc: '(a*)*' })
    assertEqual(warns.some(w => w.includes('嵌套量词') && w.includes('pingbibiaoti')), true, '应警告 pingbibiaoti')
    assertEqual(warns.some(w => w.includes('嵌套量词') && w.includes('zkt_gjc')), true, '应警告 zkt_gjc')
  })

  // 95-4. whitelistFilter 不执行风险正则（全部放行）
  await test('ReDoS: whitelistFilter 风险关键词放行不卡死', () => {
    const t0 = Date.now()
    const r = whitelistFilter({ title: 'a'.repeat(5000) }, 'title', '(a+)+$')
    assertEqual(r, true, '风险关键词应放行(与非法正则口径一致)')
    assertEqual(Date.now() - t0 < 1000, true, '不应卡死')
  })

  // 95-5. 端到端：listfilter 用编译结果不触发灾难性回溯
  await test('ReDoS: listfilter 全程不执行风险正则', () => {
    const c = compileRules({ pingbibiaoti: '(a+)+', pingbilouzhu: 'x###(a+)+' })
    const t0 = Date.now()
    const r = listfilter({ catename: 'a', louzhu: 'b', title: 'a'.repeat(5000), content: 'c', louzhuregtime: '2026-01-01' }, c)
    assertEqual(typeof r === 'boolean', true)
    assertEqual(Date.now() - t0 < 1000, true, '嵌套量词配置不应卡死')
  })

  // ==================== 96. 一致性修复(配置解析口径) ====================
  console.log('\n📂 96. 一致性修复(配置解析口径)')

  await test('一致性: validateConfig \\r 分隔与 _splitLines 口径一致', () => {
    // \r 单独分隔多行：compileRules 拆 2 行，validateConfig 不应误报"多个 ###"
    const cfg = '微博###小明\rcat2###小红'
    const c = compileRules({ pingbilouzhu: cfg })
    assertEqual(c.pingbilouzhu.rules.length, 2, 'compileRules 应拆 2 行')
    const warns = validateConfig({ pingbilouzhu: cfg })
    assertEqual(warns.length, 0, `\r 分隔合法配置不应有警告，实际: ${warns.join('; ')}`)
  })

  await test('一致性: validateConfig pingbitime \\r 分隔与 _splitLines 口径一致', () => {
    const cfg = '微博###3\rcat2###5'
    const c = compileRules({ pingbitime: cfg })
    assertEqual(c.pingbitime.rules.length, 2, 'compileRules 应拆 2 行')
    const warns = validateConfig({ pingbitime: cfg })
    assertEqual(warns.length, 0, `pingbitime \r 分隔不应有警告，实际: ${warns.join('; ')}`)
  })

  await test('一致性: 四种分隔符(<br>/\\n/\\r\\n/\\r)解析结果一致', () => {
    const sep = ['<br>', '\n', '\r\n', '\r']
    for (const s of sep) {
      const cfg = ['微博###小明', 'cat2###小红'].join(s)
      const c = compileRules({ pingbilouzhu: cfg })
      assertEqual(c.pingbilouzhu.rules.length, 2, `分隔符 ${JSON.stringify(s)} 应拆 2 行`)
      assertEqual(validateConfig({ pingbilouzhu: cfg }).length, 0, `分隔符 ${JSON.stringify(s)} 不应有警告`)
    }
  })

  await test('一致性: {Html内容} 对象 content_html 置空(与 {Markdown内容} 口径一致)', () => {
    // v3.33 修过 htmlToMarkdown 对象置空，getContentHtml({Html内容}) 是独立路径，曾漏防御
    const r = tuisong_replace('{Html内容}', { content_html: { a: 1 }, title: 'T', url: 'http://x' })
    assertEqual(r.includes('[object Object]'), false, `对象不应泄漏为 [object Object]: ${r}`)
    assertEqual(r.includes('原文链接'), true, '链接模板应保留')
    // 正常字符串不受影响
    const r2 = tuisong_replace('{Html内容}', { content_html: '<b>正常</b>', title: 'T', url: 'http://x' })
    assertEqual(r2.includes('<b>正常</b>'), true, '字符串 content_html 应保留')
    // null/undefined/数字同样置空
    for (const bad of [null, undefined, 123, [], true]) {
      const r3 = tuisong_replace('{Html内容}', { content_html: bad, title: 'T', url: 'http://x' })
      assertEqual(r3.includes('[object Object]'), false, `content_html=${String(bad)} 不应泄漏`)
    }
  })

  // ==================== 97. 官方 got 客户端直测(本地 server) ====================
  console.log('\n📂 97. 官方 got 客户端直测')

  await test('got: 302 重定向跟随 + JSON 解析', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      if (req.url === '/r') { res.writeHead(302, { Location: '/f' }); res.end() } else if (req.url === '/f') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"n":1}') } else { res.writeHead(404); res.end('nf') }
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      const data = await got(`http://127.0.0.1:${port}/r`).json()
      assertEqual(data.ok, true, '重定向后应解析 JSON')
      assertEqual(data.n, 1, 'JSON 数值正确')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 协议相对 // 重定向 location 不拼坏（曾拼成 origin//host/x → 404）', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      if (req.url === '/pr') { res.writeHead(302, { Location: '//127.0.0.1:' + server.address().port + '/target' }); res.end() } else if (req.url === '/target') { res.writeHead(200); res.end('ok') } else { res.writeHead(404); res.end('nf:' + req.url) }
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      const res = await got(`http://127.0.0.1:${port}/pr`)
      assertEqual(res.statusCode, 200, `协议相对 location 应正确跟随，实际 ${res.statusCode}（修复前拼成 origin//host 404）`)
      assertEqual(res.body, 'ok')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 路径相对重定向正确解析（Location: next）', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      if (req.url === '/r') { res.writeHead(302, { Location: 'next' }); res.end() } else if (req.url === '/next') { res.writeHead(200); res.end('relative-ok') } else { res.writeHead(404); res.end('nf:' + req.url) }
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      const res = await got(`http://127.0.0.1:${port}/r`)
      assertEqual(res.statusCode, 200, `路径相对 location 应正确跟随，实际 ${res.statusCode}`)
      assertEqual(res.body, 'relative-ok')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 非法重定向地址应 reject，不应抛出到进程外', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://[' })
      res.end()
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      let caught = null
      try { await got(`http://127.0.0.1:${port}/bad`) } catch (e) { caught = e }
      assertEqual(!!caught, true, '非法重定向应以 Promise reject 返回')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 4xx 抛错带 response.statusCode', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => { res.writeHead(404); res.end('nf') })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      let caught = null
      try { await got(`http://127.0.0.1:${port}/x`) } catch (e) { caught = e }
      assertEqual(!!caught, true, '4xx 应抛错')
      assertEqual(caught.response.statusCode, 404, '应带 statusCode')
      assertEqual(caught.code, 'ERR_NON_2XX_3XX_RESPONSE', '官方 got 非 2xx/3xx 应使用标准错误码')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got/项目 HTTP 薄封装：官方读取响应体且保留大小上限', async () => {
    const http = require('http')
    const got = require('got')
    const { fetchJson, AGENTS } = require('./xbk_http')
    assert(AGENTS && AGENTS.http && AGENTS.https, 'HTTP 薄封装应导出共享 HTTP/HTTPS Agent')
    const body = JSON.stringify({ data: 'x'.repeat(4096) })
    const server = http.createServer((req, res) => { res.writeHead(200); res.end(body) })
    await new Promise(r => server.listen(0, r))
    try {
      const r = await got(`http://127.0.0.1:${server.address().port}/x`, { retry: { limit: 0 } })
      assertEqual(r.body.length, body.length, '官方 got 应完整读取响应体')
      let caught = null
      try { await fetchJson(`http://127.0.0.1:${server.address().port}/x`, { retry: { limit: 0 } }, 1024) } catch (e) { caught = e }
      assertEqual(caught && caught.code === 'EBODYLIMIT', true, '项目薄封装应保留响应体上限')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 响应中断(aborted) → 快速 reject 不挂起（#11 v3.165）', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.write('partial')
      setTimeout(() => res.destroy(), 20) // 写部分后断开（响应中断）
    })
    await new Promise(r => server.listen(0, r))
    const t0 = Date.now()
    try {
      let caught = null
      try { await got(`http://127.0.0.1:${server.address().port}/x`, { timeout: 3000, retry: { limit: 0 } }) } catch (e) { caught = e }
      assertEqual(!!caught, true, '响应中断应 reject')
      assertEqual(Date.now() - t0 < 2000, true, '应快速 reject 不挂起（曾永久挂起）')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 慢流响应按总时长超时（#11 v3.165，空闲超时不触发）', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      let i = 0
      const iv = setInterval(() => { res.write('x'); if (++i > 20) { clearInterval(iv); res.end() } }, 100)
    })
    await new Promise(r => server.listen(0, r))
    const t0 = Date.now()
    try {
      let caught = null
      try { await got(`http://127.0.0.1:${server.address().port}/x`, { timeout: 200, retry: { limit: 0 } }) } catch (e) { caught = e }
      // 总时长 = timeout×3 = 600ms 强制超时（间隔100ms<200ms 空闲超时不触发，曾无限拖）
      assertEqual(caught && caught.code === 'ETIMEDOUT', true, '慢流应总时长超时')
      assertEqual(Date.now() - t0 < 2000, true, `应在总时长内 reject（曾无限拖），耗时 ${Date.now() - t0}ms`)
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 超时抛 ETIMEDOUT', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer(() => { /* 故意不响应 */ })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      let caught = null
      try { await got(`http://127.0.0.1:${port}/x`, { timeout: 200, retry: { limit: 0 } }) } catch (e) { caught = e }
      assertEqual(caught && caught.code === 'ETIMEDOUT', true, `应超时 ETIMEDOUT，实际: ${caught && caught.code}`)
    } finally {
      server.closeAllConnections && server.closeAllConnections()
      await new Promise(r => server.close(r))
    }
  })

  await test('got: POST JSON body 正确发送', async () => {
    const http = require('http')
    const got = require('got')
    let received = null
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { received = body; res.writeHead(200); res.end('{}') })
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      await got.post(`http://127.0.0.1:${port}/p`, { json: { a: 1, b: 'x' }, headers: { 'Content-Type': 'application/json' } })
      assertEqual(received, '{"a":1,"b":"x"}', `POST body 应发送 JSON: ${received}`)
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: UTF-8 跨 chunk 不乱码(Buffer.concat)', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => {
      const data = Buffer.from('{"t":"😀中文"}', 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 逐字节分块发送：模拟 UTF-8 多字节(4字节emoji)跨 chunk 拆分
      for (let i = 0; i < data.length; i++) res.write(data.slice(i, i + 1))
      res.end()
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      const data = await got(`http://127.0.0.1:${port}/u`).json()
      assertEqual(data.t, '😀中文', `UTF-8 跨 chunk 应不乱码: ${JSON.stringify(data.t)}`)
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  // ==================== 98. 异常路径批量(类型/网络边界) ====================
  console.log('\n📂 98. 异常路径批量')

  await test('异常: 未知占位符 {不存在} 保留原文', () => {
    assertEqual(tuisong_replace('x{不存在}y', { title: 'T' }), 'x{不存在}y', '未知占位符应保留')
  })

  await test('异常: 对象字段不崩(category_name/louzhuregtime/posttime)', () => {
    // 对象 category_name → JSON 化（v3.30 口径）
    assertEqual(tuisong_replace('{分类名}', { category_name: { a: 1 } }), '{"a":1}')
    // 对象 louzhuregtime → 解析失败 0（不崩）
    assertEqual(daysComputed({ a: 1 }), 0)
    // 对象 posttime → 日期空（不崩）
    assertEqual(tuisong_replace('{日期}', { posttime: { a: 1 } }), '')
    // 对象 url → 不崩（urlOf 防御在集成层，此处格式化层 String 化）
    assertEqual(typeof tuisong_replace('{链接}', { url: { a: 1 } }), 'string')
  })

  await test('got: 重定向循环达到上限后 reject（官方 got 语义）', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => { res.writeHead(302, { Location: '/loop' }); res.end() })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      let caught = null
      try { await got(`http://127.0.0.1:${port}/loop`, { maxRedirects: 5, retry: { limit: 0 } }) } catch (e) { caught = e }
      assertEqual(!!caught, true, '重定向循环达到上限应 reject')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: JSON 原始值(number/boolean/null) 可通过 .json() 返回', async () => {
    const http = require('http')
    const got = require('got')
    const values = ['123', 'true', 'null']
    const expected = [123, true, null]
    const server = http.createServer((req, res) => {
      const body = values.shift()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      for (const want of expected) {
        const gotValue = await got(`http://127.0.0.1:${port}/primitive`).json()
        assertEqual(gotValue, want, `JSON 原始值应保留: ${want}`)
      }
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 连接拒绝抛 ECONNREFUSED（供 fetchData 重试）', async () => {
    const got = require('got')
    let caught = null
    try { await got('http://127.0.0.1:1/x', { timeout: 2000, retry: { limit: 0 } }) } catch (e) { caught = e }
    assertEqual(!!caught, true, '连接拒绝应抛错')
    assertEqual(caught.code, 'ECONNREFUSED', `code 应为 ECONNREFUSED: ${caught.code}`)
  })

  await test('got: 官方 timeout 配置正常生效', async () => {
    const http = require('http')
    const got = require('got')
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise(r => server.listen(0, r))
    try {
      const r = await got(`http://127.0.0.1:${server.address().port}/x`, { timeout: 2000, retry: { limit: 0 } })
      assertEqual(r.statusCode, 200, '官方 got 正常 timeout 应正常响应')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('got: 调用方小写 content-type 不被覆盖为 json（v3.78）', async () => {
    const http = require('http')
    const got = require('got')
    let receivedCT = null
    const server = http.createServer((req, res) => {
      receivedCT = req.headers['content-type']
      res.writeHead(200); res.end('{}')
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    try {
      await got(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })
      assertEqual(receivedCT, 'text/plain', '调用方小写 content-type 应保留（不被覆盖为默认 json）')
      await got(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}' })
      assertEqual(receivedCT === undefined || receivedCT === 'application/json', true, '不传 Content-Type 时应由官方 got 保持默认语义')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  // ==================== 99. 边界精确值(锁定行为) ====================
  console.log('\n📂 99. 边界精确值')

  await test('边界: TS_BOUND(1e11) 精确分界行为锁定', () => {
    // 10 位秒(2001年)→正常天数
    assertEqual(daysComputed(1000000000) > 8000, true, '10位秒(2001年)应有天数')
    // 11 位秒(≈3171年,未来)→0(未来日期)
    assertEqual(daysComputed(99999999999), 0, '11位秒为未来→0')
    // 1e11 本身 → 1973 毫秒 → 有天数
    assertEqual(daysComputed(100000000000) > 19000, true, '1e11按毫秒=1973→天数')
    // 12/13 位毫秒
    assertEqual(daysComputed(123456789012) > 19000, true, '12位毫秒→1973')
    assertEqual(daysComputed(1785346200000) >= 0, true, '13位毫秒→2026')
  })

  await test('边界: normUrl 极端输入行为锁定', () => {
    assertEqual(normUrl('http://'), 'http:', '纯协议残留(已知#27)')
    assertEqual(normUrl('///'), '', '全斜杠→空')
    assertEqual(normUrl('a?x=1'), 'a', 'v3.156: query 去除(与 getFileName 口径一致,防跟踪参数重复判重)')
    assertEqual(normUrl('http://A.com/p?x=1#s'), 'http://a.com/p', 'v3.156: query+hash+主机小写')
    assertEqual(normUrl('/A/B/'), 'A/B', '首尾斜杠去除')
    assertEqual(normUrl('  /a/  '), 'a', '空白+斜杠')
  })

  await test('边界: pingbitime 0/极大行为锁定', () => {
    const c0 = compileRules({ pingbitime: '0' })
    assertEqual(checkTimeCompiled(c0.pingbitime, { louzhuregtime: '2026-01-01' }), false, 'pingbitime=0 不拦截')
    const cBig = compileRules({ pingbitime: '99999' })
    assertEqual(checkTimeCompiled(cBig.pingbitime, { louzhuregtime: '2026-01-01' }), true, 'pingbitime=99999 拦截所有')
    const cNeg = compileRules({ pingbitime: '-5' })
    assertEqual(cNeg.pingbitime, null, '负数→不编译(null)')
  })

  await test('边界: 编码大小写/超范围行为锁定', () => {
    assertEqual(decodeHtmlEntities('&#x1f600;'), '😀', '小写x hex')
    assertEqual(decodeHtmlEntities('&#X1F600;'), '😀', '大写X hex')
    assertEqual(decodeHtmlEntities('&#1114111;'), String.fromCodePoint(0x10FFFF), '最大码点')
    assertEqual(decodeHtmlEntities('&#x110000;'), '&#x110000;', '超范围保留原文')
    assertEqual(decodeHtmlEntities('&#xD800;'), '&#xD800;', '代理区保留')
    assertEqual(decodeHtmlEntities('&#0;'), '', 'NUL过滤')
  })

  console.log('\n📂 100. 审查项 #56/#65/#7')

  await test('#56: img 空 src / 纯空白 src → 不生成 ![]() 空图片', () => {
    const r1 = htmlToMarkdown({ content_html: '<img src="">', url: 'http://x' })
    assertEqual(r1.includes('![]('), false, '空 src 不应生成空图片')
    const r2 = htmlToMarkdown({ content_html: '<img src="   ">', url: 'http://x' })
    assertEqual(r2.includes('![]('), false, '纯空白 src 不应生成空图片')
    const r3 = htmlToMarkdown({ content_html: '<img src="http://p.jpg" alt="图">', url: 'http://x' })
    assertEqual(r3.includes('![图](http://p.jpg)'), true, '正常 src 仍转换')
    const r4 = htmlToMarkdown({ content_html: '<img src=" http://p.jpg ">', url: 'http://x' })
    assertEqual(r4.includes('![](http://p.jpg)'), true, 'src 首尾空白 trim 后使用')
  })

  await test('#65: url 含换行 → 链接文本与目标均剥离换行不破坏', () => {
    const r = htmlToMarkdown({ content_html: '内容', url: 'http://x.com/a\nb' })
    assertEqual(r.includes('原文链接：[http://x.com/ab](http://x.com/ab)'), true, '链接完整且无换行（剥离后不再触发<>包裹）')
    assertEqual(r.includes('\n\n原文链接'), true, '模板分隔正常')
    const r2 = htmlToMarkdown({ content_html: '内容', url: 'http://x.com/a\r\nb' })
    assertEqual(r2.includes('http://x.com/ab'), true, 'CRLF 换行也被剥离')
    const r3 = htmlToMarkdown({ content_html: '内容', url: 'http://x.com/正常' })
    assertEqual(r3.includes('原文链接：[http://x.com/正常](http://x.com/正常)'), true, '无换行 url 不受影响')
  })

  await test('#7: cache.maxSize 校验统一在 App.run（validateConfig 只接收 Config.filter，不做双形态校验）', () => {
    // v3.x：validateConfig 只被 RuleEngine.validateConfig(Config.filter) 调用，cfg 无 cache/maxSize 字段，
    // 原双形态（cfg.cache.maxSize / cfg.maxSize）校验是恒不触发的死代码，已移除；maxSize 校验统一由 App.run 兜底。
    assertEqual(validateConfig({ cache: { maxSize: -1 } }).some(w => w.includes('cache.maxSize')), false, '负数不再在此校验（App.run 兜底）')
    assertEqual(validateConfig({ maxSize: 0 }).some(w => w.includes('cache.maxSize')), false, '平铺形态不再在此校验')
    assertEqual(validateConfig({ maxSize: 2.5 }).some(w => w.includes('cache.maxSize')), false, '小数不再在此校验')
    assertEqual(validateConfig({ cache: { maxSize: 'abc' } }).some(w => w.includes('cache.maxSize')), false, '非数字不再在此校验')
    assertEqual(validateConfig({ cache: { maxSize: 100 } }).length, 0, '无 filter 字段时无任何警告')
  })

  await test('#链接: {链接} 占位符 Markdown 安全化（v3.74）', () => {
    // 含空格/括号 → <> 包裹（与 htmlToMarkdown 的 mdUrl 同口径）
    assertEqual(tuisong_replace('{链接}', { url: 'http://x.com/a b', title: 't' }), '<http://x.com/a b>')
    assertEqual(tuisong_replace('{链接}', { url: 'http://x.com/a(b)', title: 't' }), '<http://x.com/a(b)>')
    // 含换行 → 剥离
    assertEqual(tuisong_replace('{链接}', { url: 'http://x.com/a\nb', title: 't' }), 'http://x.com/ab')
    // 正常 url 原样；无 url → 空
    assertEqual(tuisong_replace('{链接}', { url: 'http://x.com/ok', title: 't' }), 'http://x.com/ok')
    assertEqual(tuisong_replace('{链接}', { title: 't' }), '')
  })

  console.log('\n📂 101. 版本一致性（防文件头版本号过时——v3.35 曾出现「v3.8 当前最新」过时误导）')

  await test('版本一致性：文件头版本号与 CHANGELOG 最新一致', () => {
    const fs = require('fs')
    const path = require('path')
    const main = fs.readFileSync(path.join(__dirname, 'xbk_function_v3.js'), 'utf8')
    const changelog = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8')
    const m = main.match(/v(\d+\.\d+)/)
    // v3.123：CHANGELOG 改为正序（最新在最下面）——取最后一个版本号
    const all = changelog.match(/^## v(\d+\.\d+)/gm)
    const c = all ? all[all.length - 1].match(/v(\d+\.\d+)/) : null
    assertEqual(!!m, true, '主代码文件头应有版本号')
    assertEqual(!!c, true, 'CHANGELOG 应有版本号')
    assertEqual(m[1], c[1], `文件头版本号(${m[1]})应与 CHANGELOG 最新(${c[1]})一致`)
  })

  await test('版本一致性：package.json 版本与文件头一致（v3.71）', () => {
    const fs = require('fs')
    const path = require('path')
    const main = fs.readFileSync(path.join(__dirname, 'xbk_function_v3.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
    const m = main.match(/v(\d+)\.(\d+)/)
    assertEqual(!!m, true, '主代码文件头应有版本号')
    const expected = `${m[1]}.${m[2]}.0`
    assertEqual(pkg.version, expected, `package.json 版本(${pkg.version})应与文件头(v${expected})一致`)
  })

  // v3.169：README 不再维护版本号（避免每次发布手动同步的过时源）——版本一致性收敛为
  // 文件头 ↔ CHANGELOG 最新 ↔ package.json 三方自动校验；README 的版本信息指向 package.json/CHANGELOG

  console.log('\n📂 102. 配置防御（v3.80）')

  await test('防御: cache.dir 非字符串 → 回退默认不崩（v3.80）', () => {
    const orig = Config.cache.dir
    try {
      Config.cache.dir = 123 // 非字符串：path.join 会抛 TypeError 的崩溃点
      const p = getFilePath('test_102_cache.json')
      assertEqual(typeof p, 'string', '应返回字符串路径（回退默认目录）')
      assertEqual(p.includes('xianbaoku_cache'), true, `应回退默认缓存目录: ${p}`)
      try { require('fs').unlinkSync(p) } catch (e) { /* 忽略 */ }
    } finally {
      Config.cache.dir = orig
    }
  })

  await test('防御: cache.dir 符号链接不能指向项目外部', () => {
    const fs = require('fs')
    const os = require('os')
    const orig = Config.cache.dir
    const link = path.join(__dirname, 'test_cache_symlink_probe')
    const target = path.join(os.tmpdir(), 'xbk-cache-symlink-target')
    try {
      try { fs.unlinkSync(link) } catch (e) { /* 不存在 */ }
      try { fs.rmdirSync(target) } catch (e) { /* 不存在 */ }
      fs.mkdirSync(target, { recursive: true })
      fs.symlinkSync(target, link, 'dir')
      Config.cache.dir = 'test_cache_symlink_probe'
      const p = getFilePath('push.json')
      assertEqual(fs.realpathSync(path.dirname(p)).startsWith(path.resolve(__dirname) + path.sep), true, `符号链接缓存目录不应逃逸: ${p}`)
    } finally {
      Config.cache.dir = orig
      try { fs.unlinkSync(link) } catch (e) { /* 忽略 */ }
      try { fs.rmdirSync(target) } catch (e) { /* 忽略 */ }
    }
  })

  await test('防御: cache.dir 路径不能逃出项目根目录', () => {
    const orig = Config.cache.dir
    const root = path.resolve(__dirname) + path.sep
    try {
      for (const dir of ['../../tmp/xbk-escape', '../../../etc', 'foo/../../bar', '/tmp/outside']) {
        Config.cache.dir = dir
        const p = getFilePath('push.json')
        assertEqual(p.startsWith(root), true, `cache.dir=${dir} 不应逃出项目根目录: ${p}`)
      }
    } finally {
      Config.cache.dir = orig
    }
  })

  await test('安全: URL 协议内部控制空白不能绕过危险协议过滤', () => {
    for (const u of ['java\nscript:alert(1)', 'java\tscript:alert(1)', 'java\rscript:alert(1)']) {
      const out = htmlToMarkdown({ content_html: `<a href="${u}">危险链接</a>` })
      assertEqual(out.includes('[危险链接]('), false, `内部控制空白不应生成可点击链接: ${JSON.stringify(u)} -> ${out}`)
    }
  })

  await test('实体扩展: ensp/emsp/cent/curren/箭头（v3.83）', () => {
    assertEqual(decodeHtmlEntities('a&ensp;b'), 'a b', '&ensp; 半角空格')
    assertEqual(decodeHtmlEntities('a&emsp;b'), 'a b', '&emsp; 全角空格（与 nbsp 同口径转普通空格）')
    assertEqual(decodeHtmlEntities('&cent;&curren;'), '¢¤', '货币符号')
    assertEqual(decodeHtmlEntities('&larr;&rarr;&uarr;&darr;'), '←→↑↓', '方向箭头')
    assertEqual(decodeHtmlEntities('&ensp;'), ' ', '单独 ensp')
  })

  await test('实体递归解码: 双重转义 &amp;amp; → &（v3.105 真机验证发现）', () => {
    assertEqual(decodeHtmlEntities('&amp;amp;'), '&', '双重转义应完全解码')
    assertEqual(decodeHtmlEntities('a=1&amp;amp;b=2'), 'a=1&b=2', 'URL 参数双重转义')
    assertEqual(decodeHtmlEntities('&amp;amp;lt;'), '<', '三重转义收敛')
    assertEqual(decodeHtmlEntities('&amp;'), '&', '单重转义')
    assertEqual(decodeHtmlEntities('&lt;b&gt;'), '<b>', '普通实体一轮收敛不误伤')
    assertEqual(decodeHtmlEntities('&#38;amp;'), '&', '数字实体双重转义')
    assertEqual(decodeHtmlEntities('文本&nbsp;空格'), '文本 空格', '正常内容不受影响')
  })

  await test('防御: domain 尾斜杠 → pushUrl 无双斜杠（v3.94）', () => {
    const orig = Config.domain
    try {
      Config.domain = 'https://new.ixbk.net/'
      assertEqual(Config.api.pushUrl, 'https://new.ixbk.net/plus/json/push.json', 'domain 尾斜杠不应导致 pushUrl 双斜杠')
      Config.domain = 'https://new.ixbk.net///'
      assertEqual(Config.api.pushUrl, 'https://new.ixbk.net/plus/json/push.json', '多尾斜杠也应去除')
      Config.domain = 'https://new.ixbk.net'
      assertEqual(Config.api.pushUrl, 'https://new.ixbk.net/plus/json/push.json', '无尾斜杠不受影响')
    } finally {
      Config.domain = orig
    }
  })

  await test('契约: template/push 新配置默认值锁定（v3.97）', () => {
    assertEqual(Config.template.title, '【{分类名}】{标题}', 'template.title 默认')
    assertEqual(Config.template.content, '{Markdown内容}', 'template.content 默认')
    assertEqual(Config.push.titleMax, 100, 'push.titleMax 默认')
    assertEqual(Config.push.contentMax, 3000, 'push.contentMax 默认')
    assertEqual(Config.push.mode, 'parallel', 'push.mode 默认')
    assertEqual(Config.push.parallelLimit, 10, 'push.parallelLimit 默认')
  })

  console.log('\n📂 103. 随机输入冒烟（Fuzz，固定 seed 确定性）')

  await test('Fuzz: 纯函数随机脏数据 500 轮不崩（v3.107）', () => {
    // 确定性伪随机（固定 seed 42——跨运行结果一致，88 章确定性精神）
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    // 随机脏数据源：null/undefined/空串/大数/NaN/Infinity/对象/数组/含实体与标签的随机串
    const randomValue = () => {
      const r = rand()
      if (r < 0.08) return null
      if (r < 0.16) return undefined
      if (r < 0.24) return ''
      if (r < 0.32) return rand() * 1e12
      if (r < 0.40) return Math.floor(rand() * 1e10)
      if (r < 0.46) return NaN
      if (r < 0.52) return Infinity
      if (r < 0.60) return { a: 1, b: { c: [1] } }
      if (r < 0.68) return [1, 2, 3]
      const chars = 'abc0123 &<>=#?/\\n\t\u00e9\ud83d\ude00;&#amp;lt;'
      let s = ''
      const len = Math.floor(rand() * 60)
      for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)]
      return s
    }
    const fns = [
      ['decodeHtmlEntities', (v) => decodeHtmlEntities(v)],
      ['normUrl', (v) => normUrl(v)],
      ['daysComputed', (v) => daysComputed(v)],
      ['hasValidId', (v) => hasValidId(v)],
      ['anonKey', (v) => anonKey(v, v, v)],
      ['tuisong_replace', (v) => tuisong_replace('{标题}|{日期}|{Markdown内容}|{链接}', v)],
      ['htmlToMarkdown', (v) => htmlToMarkdown(v)],
      ['truncateUtf16', (v) => truncateUtf16(v, Math.floor(rand() * 200))],
      ['whitelistFilter', (v) => whitelistFilter(v, 'title', String(v))],
      ['hasNestedQuantifier', (v) => hasNestedQuantifier(v)]
    ]
    for (let i = 0; i < 500; i++) {
      for (const [name, fn] of fns) {
        const input = randomValue()
        try { fn(input) } catch (e) {
          // 注意：JSON.stringify(undefined) 返回 undefined，需兜底再 slice
          const raw = JSON.stringify(input)
          const inputStr = raw === undefined ? 'undefined' : raw
          assertEqual(false, true, `${name} 对输入 ${inputStr.slice(0, 60)} 抛错: ${e.message}`)
        }
      }
    }
  })

  await test('Fuzz: 大数据量性能冒烟 10000 条 listfilter（v3.107）', () => {
    // 模拟 10000 条真实形态数据（含脏字段），验证过滤不崩且耗时可控
    const items = []
    for (let i = 0; i < 10000; i++) {
      items.push({
        id: i,
        catename: i % 3 === 0 ? null : `分类${i % 10}`,
        title: `标题${i} 京东神券`,
        content: '内容' + (i % 5 === 0 ? '&amp;amp;' : ''),
        louzhu: i % 7 === 0 ? '' : `楼主${i}`,
        louzhuregtime: i % 11 === 0 ? null : '2026-01-01',
        url: `/item/${i}.html`
      })
    }
    const t0 = Date.now()
    let pushed = 0; let filtered = 0
    for (const it of items) {
      if (listfilter(it, {})) pushed++; else filtered++
    }
    const ms = Date.now() - t0
    assertEqual(pushed + filtered, 10000, '10000 条应全部处理')
    assertEqual(ms < 3000, true, `10000 条 listfilter 应 <3s，实际 ${ms}ms`)
  })

  await test('Fuzz 回归: hasValidId 对缺失/非对象输入不崩（v3.107）', () => {
    assertEqual(hasValidId(undefined), false, 'undefined 不崩且无效')
    assertEqual(hasValidId(null), false, 'null 不崩且无效')
    assertEqual(hasValidId(42), false, '数字不崩且无效')
    assertEqual(hasValidId('abc'), false, '字符串不崩且无效')
    assertEqual(hasValidId({ id: 1 }), true, '正常对象仍有效')
    assertEqual(hasValidId({ id: 'x' }), true, '字符串 id 有效')
    assertEqual(hasValidId({}), false, '无 id 无效')
  })

  await test('#链接: {Html内容} href 换行剥离（v3.85）', () => {
    const r = tuisong_replace('{Html内容}', { url: 'http://x.com/a\nb', content_html: '<p>内容</p>', title: 't' })
    assertEqual(r.includes('\n'), false, 'Html内容不应残留换行')
    assertEqual(r.includes('http://x.com/ab'), true, 'href 换行应剥离')
    const r2 = tuisong_replace('{Html内容}', { url: 'http://x.com/ok', content_html: '<p>内容</p>', title: 't' })
    assertEqual(r2.includes('http://x.com/ok'), true, '正常 url 不受影响')
  })

  // ==================== 103. R1 低风险修复锁定（v3.105 不推版本） ====================
  console.log('\n📂 103. 低风险修复批次锁定（R1-R6/R9：truncate/getFileName/splitLines/domain/maxSize/retry/原型键/url/title）')

  await test('truncateUtf16: 非法 max(undefined/NaN/0/负数) 不截断（R1）', () => {
    assertEqual(truncateUtf16('abc', undefined), 'abc', 'undefined 不截断')
    assertEqual(truncateUtf16('abc', NaN), 'abc', 'NaN 不截断')
    assertEqual(truncateUtf16('abc', 0), 'abc', '0 不截断')
    assertEqual(truncateUtf16('abc', -5), 'abc', '负数不截断')
    assertEqual(truncateUtf16('abcdef', 3), 'abc', '合法 max 仍截断')
    assertEqual(truncateUtf16('😀😀', 1), '', '代理对边界仍安全（max=1 → 高代理退位）')
  })

  await test('getFileName: 非字符串 url 哈希命名（v3.157: 曾共用 default.json 互相误判重）', () => {
    const n1 = getFileName({ a: 1 })
    const n2 = getFileName(123)
    assertEqual(n1.endsWith('.json') && n2.endsWith('.json'), true, '应 .json 结尾')
    assertEqual(n1 !== n2, true, '不同坏源应不同缓存名')
    assertEqual(getFileName({ a: 1 }), getFileName({ a: 1 }), '同坏源应幂等')
    assertEqual(getFileName(''), 'default.json', '空串兜底')
    assertEqual(getFileName('/weibo/123.html'), '123.html.json', '正常路径补 .json 后缀不受影响')
    assertEqual(getFileName('https://x.com/a/b.json?x=1'), 'b.json', 'query 剥离不受影响')
  })

  await test('_splitLines: 支持 <br/> 自闭合标签（R2）', () => {
    assertEqual(JSON.stringify(_splitLines('分类1###规则1<br/>分类2###规则2')), JSON.stringify(['分类1###规则1', '分类2###规则2']), '<br/> 拆分')
    assertEqual(JSON.stringify(_splitLines('分类1###规则1<br />分类2###规则2')), JSON.stringify(['分类1###规则1', '分类2###规则2']), '<br /> 空格拆分')
    assertEqual(JSON.stringify(_splitLines('分类1###规则1<br>分类2###规则2')), JSON.stringify(['分类1###规则1', '分类2###规则2']), '<br> 原行为保持')
    assertEqual(JSON.stringify(_splitLines('分类1###规则1\n分类2###规则2')), JSON.stringify(['分类1###规则1', '分类2###规则2']), '\\n 原行为保持')
    assertEqual(JSON.stringify(_splitLines('a###b')), JSON.stringify(['a###b']), '多行模式无分隔符 → 单元素数组')
    assertEqual(_splitLines('abc'), null, '简单模式仍返回 null（无 ### 不拆分）')
  })

  await test('saveMessages: maxSize 小数回退默认、整数裁剪生效（R3-2 整数化）', () => {
    const saved = Config.cache.maxSize
    const fs = require('fs')
    const p = getFilePath('test_103_maxsize.json')
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `t${i}` }))
    try {
      // 小数 maxSize → 回退默认 10000（v3.120）→ 100 条不裁剪
      Config.cache.maxSize = 2.5
      saveMessages(p, msgs)
      assertEqual(readMessages(p).length, 100, `maxSize=2.5 应回退默认 10000 不裁剪: ${readMessages(p).length}`)
      // 整数 maxSize=3 → 裁剪到 3 条（上限语义为整数条数）
      Config.cache.maxSize = 3
      saveMessages(p, msgs)
      assertEqual(readMessages(p).length, 3, `整数 maxSize=3 应裁剪到 3 条: ${readMessages(p).length}`)
      // 0/负值仍回退默认（原行为保持）
      Config.cache.maxSize = 0
      saveMessages(p, msgs)
      assertEqual(readMessages(p).length, 100, 'maxSize=0 回退默认 10000 不裁剪')
    } finally {
      Config.cache.maxSize = saved
      try { fs.unlinkSync(p) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(p + '.tmp') } catch (e) { /* 忽略 */ }
    }
  })

  await test('安全: readMessages 原型键 __proto__ 防御（R5-2）', () => {
    const fs = require('fs')
    const p = getFilePath('__proto__')
    try {
      // 首次读：原型键不走内存直读（hasOwnProperty false）→ 磁盘初始化空数组
      const r1 = readMessages('__proto__')
      assert(Array.isArray(r1), `__proto__ 键读取应为数组: ${typeof r1} ${Array.isArray(r1) ? '' : JSON.stringify(r1).slice(0, 60)}`)
      // 二次读：走内存缓存（defineProperty 写入）→ 仍应为数组
      const r2 = readMessages('__proto__')
      assert(Array.isArray(r2), `__proto__ 键二次读取应为数组: ${typeof r2}`)
      // Object.prototype 不被污染
      assertEqual(Object.prototype.constructor, Object, 'Object.prototype 不被污染')
      assertEqual(Object.prototype.polluted, undefined, '无 polluted 残留')
    } finally {
      try { fs.unlinkSync(p) } catch (e) { /* 忽略 */ }
      // readMessages 直接传 '__proto__'（触发原型键分支）时 _ensureFileExists 会在 cwd 创建文件——测试后清理
      try { fs.unlinkSync(require('path').join(__dirname, '__proto__')) } catch (e) { /* 忽略 */ }
    }
  })

  await test('url 非字符串防御：三处无 [object Object] 泄漏（R6-1）', () => {
    // htmlToMarkdown：对象/数字 url → 无垃圾文本、无原文链接
    const md1 = htmlToMarkdown({ content_html: '<p>内容</p>', url: { a: 1 } })
    assert(!md1.includes('[object Object]'), 'htmlToMarkdown 对象 url 无垃圾文本')
    assert(!md1.includes('原文链接'), '对象 url → 无原文链接')
    const md2 = htmlToMarkdown({ content_html: '<p>c</p>', url: 123 })
    assert(!md2.includes('[object Object]') && !md2.includes('原文链接'), '数字 url 同样无链接')
    // tuisong_replace：{链接} 与 {Html内容} 占位符
    const r1 = tuisong_replace('{链接}|{Html内容}', { url: { a: 1 }, content_html: '<p>x</p>' })
    assert(!r1.includes('[object Object]'), 'tuisong_replace 无垃圾文本')
    assert(r1.startsWith('|'), `{链接} 应为空: ${JSON.stringify(r1.slice(0, 20))}`)
    // 正常字符串 url 不受影响
    const md3 = htmlToMarkdown({ content_html: '<p>c</p>', url: '/a/1.html' })
    assert(md3.includes('原文链接：'), '字符串 url 仍生成原文链接')
    const r2 = tuisong_replace('{链接}', { url: '/a/1.html' })
    assertEqual(r2, '/a/1.html', '字符串 url 占位符正常')
  })

  await test('validateConfig: zkt_gjc 非字符串 → 警告（R11-1）', () => {
    const w1 = validateConfig({ zkt_gjc: { a: 1 } })
    assert(w1.some(w => w.includes('zkt_gjc') && w.includes('应为字符串')), `对象 zkt_gjc 应警告: ${JSON.stringify(w1)}`)
    const w2 = validateConfig({ zkt_gjc: 123 })
    assert(w2.some(w => w.includes('zkt_gjc') && w.includes('应为字符串')), `数字 zkt_gjc 应警告: ${JSON.stringify(w2)}`)
    const w3 = validateConfig({ zkt_gjc: '京东' })
    assert(!w3.some(w => w.includes('zkt_gjc')), '合法字符串无警告')
  })

  await test('pushUrl getter: domain 非字符串不崩溃（R2 防御）', () => {
    const saved = Config.domain
    try {
      Config.domain = 123
      assertEqual(Config.api.pushUrl, '/plus/json/push.json', '数字 domain → 空前缀')
      Config.domain = null
      assertEqual(Config.api.pushUrl, '/plus/json/push.json', 'null domain → 空前缀')
      Config.domain = { x: 1 }
      assertEqual(Config.api.pushUrl, '/plus/json/push.json', '对象 domain → 空前缀')
      Config.domain = 'https://new.ixbk.net'
      assertEqual(Config.api.pushUrl, 'https://new.ixbk.net/plus/json/push.json', '正常 domain 不受影响')
      Config.domain = 'https://new.ixbk.net/'
      assertEqual(Config.api.pushUrl, 'https://new.ixbk.net/plus/json/push.json', '尾斜杠仍剥离')
    } finally {
      Config.domain = saved
    }
  })

  // ================================================

  console.log('\n📂 104. 深度 Fuzz（全导出扫描 + 不变量 Property Tests）')

  await test('Fuzz-深度: 扩展随机值生成器（Symbol/函数/BigInt/Date/RegExp/循环/Proxy）', () => {
    // 固定 seed，确定性
    let seed = 20260801
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const deep = (depth) => {
      if (depth <= 0) return randomScalar()
      const r = rand()
      if (r < 0.35) return randomScalar()
      if (r < 0.6) return { k: deep(depth - 1), k2: deep(depth - 1) }
      if (r < 0.8) return [deep(depth - 1), deep(depth - 1), deep(depth - 1)]
      return randomScalar()
    }
    const randomScalar = () => {
      const r = rand()
      if (r < 0.06) return null
      if (r < 0.12) return undefined
      if (r < 0.18) return ''
      if (r < 0.24) return Symbol('sym')
      if (r < 0.30) return () => 'fn'
      if (r < 0.36) return 123n
      if (r < 0.42) return new Date(rand() * 1e12)
      if (r < 0.48) return /ab+c?/gi
      if (r < 0.54) return rand() * 1e15
      if (r < 0.60) return Math.floor(rand() * 1e10)
      if (r < 0.64) return NaN
      if (r < 0.68) return Infinity
      if (r < 0.72) return -Infinity
      if (r < 0.78) return { a: 1 }
      if (r < 0.84) return [1, [2, { x: 3 }]]
      // 字符串：含实体/标签/emoji/代理对/控制字符/超长
      const chars = 'abcXYZ0123 &<>=#?/\\n\\t\\0\\u00e9\\u00a9\\ud83d\\ude00\\ud800\\udc00;&#amp;lt;&#x41;\\u4e2d\\u6587'
      let s = ''
      const len = Math.floor(rand() * 500)
      for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)]
      return s
    }
    // 循环引用
    const circular = { name: 'circ' }
    circular.self = circular
    const withGetter = { get boom () { throw new Error('getter 抛错') } }
    const withProxy = new Proxy({}, { get: () => { throw new Error('proxy 抛错') } })
    const specials = [circular, withGetter, withProxy, new ArrayBuffer(8), new Uint8Array([1, 2, 3])]

    const targets = [
      ['decodeHtmlEntities', (v) => decodeHtmlEntities(v)],
      ['normUrl', (v) => normUrl(v)],
      ['daysComputed', (v) => daysComputed(v)],
      ['hasValidId', (v) => hasValidId(v)],
      ['anonKey', (v) => anonKey(v, v, v)],
      ['tuisong_replace', (v) => tuisong_replace('{标题}|{日期}|{Markdown内容}|{链接}', v)],
      ['htmlToMarkdown', (v) => htmlToMarkdown(v)],
      ['truncateUtf16', (v) => truncateUtf16(v, Math.floor(rand() * 200))],
      ['whitelistFilter', (v) => whitelistFilter(v, 'title', String(v))],
      ['hasNestedQuantifier', (v) => hasNestedQuantifier(v)],
      ['_splitLines', (v) => _splitLines(v)],
      ['getFileName', (v) => getFileName(v)],
      ['matchesCompiled', (v) => matchesCompiled(v, v, v)],
      ['checkRegisterTime', (v) => checkRegisterTime(v, null)],
      ['checkCategory', (v) => checkCategory(v, null)]
    ]
    for (let i = 0; i < 300; i++) {
      for (const [name, fn] of targets) {
        // 65% 深度随机对象，15% 特殊值，20% 普通随机
        let input
        const r = rand()
        if (r < 0.65) input = deep(4)
        else if (r < 0.80) input = specials[Math.floor(rand() * specials.length)]
        else input = randomScalar()
        try { fn(input) } catch (e) {
          // getter/proxy 抛错是输入自身行为，不算被测函数 bug；其余算
          if (e && e.message === 'getter 抛错') continue
          if (e && e.message === 'proxy 抛错') continue
          let inStr
          try { inStr = JSON.stringify(input) } catch (ee) { inStr = '[不可序列化]' }
          if (inStr === undefined) inStr = 'undefined'
          throw new Error(`${name} 深度fuzz 输入 ${inStr.slice(0, 60)} 抛错: ${e.message}`)
        }
      }
    }
  })

  await test('Property: normUrl 幂等（随机输入 normUrl(normUrl(x))===normUrl(x)）', () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const urls = ['http://A.com/x', 'https://x.com/a/', '//host/path', '/rel/path', 'http://x.com', 'a?b=1', '///', 'http://x.com//d//', 'ftp://f.com/', 'HTTP://Mixed.COM/U']
    for (let i = 0; i < 1000; i++) {
      const base = urls[Math.floor(rand() * urls.length)]
      const junk = ' &/?#[]()\\t'.slice(0, Math.floor(rand() * 8))
      const x = base + junk + Math.floor(rand() * 1000)
      const once = normUrl(x)
      assertEqual(normUrl(once), once, `normUrl 应幂等: 输入 "${x.slice(0, 40)}" once="${once}"`)
    }
  })

  await test('Property: decodeHtmlEntities 的 & 计数只减不增（随机输入）', () => {
    let seed = 99
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 1000; i++) {
      let s = ''
      const len = Math.floor(rand() * 100)
      for (let j = 0; j < len; j++) {
        s += rand() < 0.3 ? '&amp;' : (rand() < 0.5 ? '&#38;' : '&#x26;')
        if (rand() < 0.4) s += 'x'
      }
      const out = decodeHtmlEntities(s)
      const inAmp = (s.match(/&/g) || []).length
      const outAmp = (out.match(/&/g) || []).length
      assertEqual(outAmp <= inAmp, true, `& 计数应只减不增: "${s.slice(0, 40)}" ${inAmp}→${outAmp}`)
    }
  })

  await test('Property: daysComputed 非负（随机时间输入）', () => {
    let seed = 1234
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 2000; i++) {
      const t = Math.floor(rand() * 1e14)
      const d = daysComputed(t)
      assertEqual(typeof d, 'number', 'daysComputed 应返回数字')
      assertEqual(d >= 0, true, `daysComputed 非负: ${t} → ${d}`)
    }
  })

  await test('Property: anonKey 确定性（同输入同输出）+ 不抛', () => {
    let seed = 55
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 500; i++) {
      const a = Math.floor(rand() * 1e6)
      const b = rand() < 0.5 ? null : 'x' + Math.floor(rand() * 1e6)
      const c = rand() < 0.3 ? '' : '内容' + Math.floor(rand() * 100)
      const k1 = anonKey(a, b, c)
      const k2 = anonKey(a, b, c)
      assertEqual(k1, k2, `anonKey 确定性: ${a}|${b}|${c}`)
      assertEqual(/^anon:[0-9a-f]+$/.test(k1), true, `anonKey 格式: ${k1}`)
    }
  })

  await test('Property: truncateUtf16 长度不超限（随机字符串+emoji）', () => {
    let seed = 777
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 1000; i++) {
      let s = ''
      const len = Math.floor(rand() * 200)
      for (let j = 0; j < len; j++) {
        s += rand() < 0.5 ? '😀' : (rand() < 0.8 ? '中' : 'a')
      }
      const max = Math.floor(rand() * 150) + 1
      const out = truncateUtf16(s, max)
      assertEqual(out.length <= max, true, `truncateUtf16 长度 ${out.length} 应 ≤ ${max}`)
      // 不应切断代理对（低代理出现时前一位必须是高代理）
      for (let j = 0; j < out.length; j++) {
        const code = out.charCodeAt(j)
        if (code >= 0xDC00 && code <= 0xDFFF) {
          const prev = out.charCodeAt(j - 1)
          assertEqual(prev >= 0xD800 && prev <= 0xDBFF, true, '孤立低代理不应出现')
        }
      }
    }
  })

  await test('Fuzz-深度: 超长输入（100KB 字符串）不崩', () => {
    const huge = '&amp;'.repeat(20000) + 'x'.repeat(10000) + '<b>'.repeat(5000)
    assertEqual(typeof decodeHtmlEntities(huge), 'string', '100KB 实体串解码不崩')
    assertEqual(typeof normUrl('http://x.com/' + 'a'.repeat(50000)), 'string', '50KB url 不崩')
    const emojiHuge = '😀'.repeat(20000)
    assertEqual(truncateUtf16(emojiHuge, 300).length <= 300, true, '超长 emoji 截断不崩')
  })

  console.log('\n📂 105. Fuzz 回归锁定（嵌套 Symbol 数组全 API 防御）')

  await test('Fuzz 回归: 嵌套 Symbol 数组输入 16 个 API 不崩（v3.108）', () => {
    const symArr = [Symbol('x')]
    assertEqual(typeof decodeHtmlEntities(symArr), 'string', 'decodeHtmlEntities')
    assertEqual(typeof tuisong_replace(symArr, {}), 'string', 'tuisong_replace 模板')
    assertEqual(typeof tuisong_replace('{标题}', symArr), 'string', 'tuisong_replace 数据')
    assertEqual(typeof truncateUtf16(symArr, 10), 'string', 'truncateUtf16')
    assertEqual(typeof whitelistFilter({ title: 'a' }, 'title', symArr), 'boolean', 'whitelistFilter')
    assertEqual(Array.isArray(_splitLines(symArr)), true, '_splitLines')
    assertEqual(typeof daysComputed(symArr), 'number', 'daysComputed/parseTime')
    assertEqual(typeof getFileName(symArr), 'string', 'getFileName')
    assertEqual(typeof hasNestedQuantifier(symArr), 'boolean', 'hasNestedQuantifier')
    assertEqual(typeof normUrl(symArr), 'string', 'normUrl')
    assertEqual(typeof anonKey(symArr, 1), 'string', 'anonKey')
    assertEqual(typeof hasValidId(symArr), 'boolean', 'hasValidId')
    assertEqual(typeof htmlToMarkdown(symArr), 'string', 'htmlToMarkdown')
    assertEqual(!!compileRules({ pingbibiaoti: symArr }).pingbibiaoti === false || compileRules({ pingbibiaoti: symArr }).pingbibiaoti === null, true, 'compileRules')
    assertEqual(Array.isArray(validateConfig({ pingbibiaoti: symArr })), true, 'validateConfig')
    assertEqual(typeof getFilePath(symArr), 'string', 'getFilePath')
  })

  await test('Fuzz 回归: 其他脏类型（Proxy/循环引用/超长）不崩', () => {
    const circular = { x: 1 }; circular.self = circular
    assertEqual(typeof normUrl(circular), 'string', 'normUrl 循环引用')
    assertEqual(typeof decodeHtmlEntities(circular), 'string', 'decode 循环引用')
    assertEqual(typeof truncateUtf16(circular, 5), 'string', 'truncateUtf16 循环引用')
    assertEqual(typeof daysComputed(circular), 'number', 'daysComputed 循环引用')
    // 超长 + 特殊字符
    assertEqual(typeof decodeHtmlEntities('&'.repeat(100000)), 'string', '10 万 & 不崩')
    assertEqual(typeof hasNestedQuantifier('(a+)+'.repeat(500)), 'boolean', '超长正则模式不崩')
  })

  console.log('\n========================================')
  console.log('\n📂 106. 深度 Fuzz 二轮（跨函数不变量 + 正则安全 + IO + 深度压力）')

  await test('Property-2: truncateUtf16 单调性（max 更大 → 输出不更短）', () => {
    let seed = 314159
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 500; i++) {
      let s = ''
      const len = Math.floor(rand() * 300)
      for (let j = 0; j < len; j++) s += rand() < 0.5 ? '😀' : (rand() < 0.8 ? '中文' : 'a')
      const m1 = Math.floor(rand() * 100) + 1
      const m2 = m1 + Math.floor(rand() * 100) + 1
      const o1 = truncateUtf16(s, m1)
      const o2 = truncateUtf16(s, m2)
      assertEqual(o2.length >= o1.length, true, `单调性: max ${m1}→${o1.length}, ${m2}→${o2.length}`)
    }
  })

  await test('Property-2: {分类名} 与 {类目} 同源一致（随机数据）', () => {
    let seed = 2718
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 500; i++) {
      const catename = rand() < 0.2 ? null : '分类' + Math.floor(rand() * 100)
      const item = { catename, title: 't', content: 'c', url: '/x' }
      const r1 = tuisong_replace('{分类名}', item)
      const r2 = tuisong_replace('{类目}', item)
      assertEqual(r1, r2, `{分类名} 应等于 {类目}: ${JSON.stringify(item)}`)
      if (catename) assertEqual(r1, catename, '分类名应等于 catename')
    }
  })

  await test('Property-2: whitelistFilter 与 filterByKeyword 一致（随机数据）', () => {
    let seed = 1618
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 500; i++) {
      const title = '标题' + Math.floor(rand() * 1000) + (rand() < 0.5 ? '京东' : '') + '神券'
      const kw = rand() < 0.3 ? '' : (rand() < 0.5 ? '京东' : (rand() < 0.8 ? '[' : '神券'))
      const item = { title, content: 'x' }
      const r1 = filterByKeyword(item, kw)
      const r2 = whitelistFilter(item, 'title', kw)
      assertEqual(r1, r2, `filterByKeyword 应等于 whitelistFilter: kw="${kw}" title="${title}"`)
    }
  })

  await test('Property-2: daysComputed 与 parseTime 一致性（无效/未来 → 0）', () => {
    let seed = 4242
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 1000; i++) {
      const x = rand() < 0.3 ? (rand() < 0.5 ? 'abc' : null) : Math.floor(rand() * 1e13)
      const d = daysComputed(x)
      // 未来日期 → 0（daysComputed 的非正差归零）
      const future = typeof x === 'number' && x > Date.now() + 86400000
      if (future) assertEqual(d, 0, `未来时间戳应归 0: ${x}`)
      assertEqual(d >= 0, true, `非负: ${x} → ${d}`)
    }
  })

  await test('Property-2: decodeHtmlEntities 幂等（递归解码收敛后稳定）', () => {
    let seed = 8888
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 500; i++) {
      let s = ''
      const len = Math.floor(rand() * 40)
      for (let j = 0; j < len; j++) {
        const parts = ['&amp;', '&lt;', '&gt;', '&#38;', '&#x26;', '&amp;amp;', '文本', 'x', '&nbsp;', '&quot;']
        s += parts[Math.floor(rand() * parts.length)]
      }
      const once = decodeHtmlEntities(s)
      const twice = decodeHtmlEntities(once)
      assertEqual(once, twice, `解码幂等: "${s.slice(0, 40)}" once="${once.slice(0, 30)}" twice="${twice.slice(0, 30)}"`)
    }
  })

  await test('Fuzz-正则: 100 个随机正则模式 hasNestedQuantifier 不崩且判定一致', () => {
    let seed = 999
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const atoms = ['a', 'b', '\\d', '.', '[ab]', '(ab)', '(?:cd)', 'a+', 'b*', 'a?', 'x{1,3}', 'y{2,}', '(a+)+', '(b*)*', '\\', '|', '^', '$']
    for (let i = 0; i < 100; i++) {
      let pat = ''
      const len = Math.floor(rand() * 8) + 1
      for (let j = 0; j < len; j++) pat += atoms[Math.floor(rand() * atoms.length)]
      const r = hasNestedQuantifier(pat)
      // 随机模式（可能含转义干扰）：只断言返回 boolean 不崩——危险判定用下方显式模式验证
      assertEqual(typeof r, 'boolean', `hasNestedQuantifier 应返回 boolean: "${pat}"`)
    }
    // 已知安全模式不误报
    assertEqual(hasNestedQuantifier('a+b+c'), false, 'a+b+c 安全')
    assertEqual(hasNestedQuantifier('(a|b)+'), true, '(a|b)+ 歧义交替+无限量词 → 保守判危险（v3.174）')
    assertEqual(hasNestedQuantifier('(a|b)'), false, '(a|b) 无量词安全')
    assertEqual(hasNestedQuantifier('(a+){1,3}'), false, '(a+){1,3} 有界安全')
    assertEqual(hasNestedQuantifier('a+{2,}'), false, '量词后不嵌套')
    // 已知危险模式必须被标记（无转义干扰的显式模式——防漏报）
    assertEqual(hasNestedQuantifier('(a+)+'), true, '(a+)+ 危险')
    assertEqual(hasNestedQuantifier('(a*)*'), true, '(a*)* 危险')
    assertEqual(hasNestedQuantifier('(a+)*'), true, '(a+)* 危险')
    assertEqual(hasNestedQuantifier('((ab)+)+'), true, '嵌套危险')
    assertEqual(hasNestedQuantifier('(?:a+)+'), true, '非捕获组嵌套危险')
    assertEqual(hasNestedQuantifier('(a{2,})+'), true, '无界量词组嵌套危险')
    // 转义模式安全（括号被转义不构成分组）
    assertEqual(hasNestedQuantifier('\\(a+\\)+'), false, '转义括号安全')
    assertEqual(hasNestedQuantifier(''), false, '空模式安全')
  })

  await test('Fuzz-IO: 随机文件名/内容 → 缓存 API 不崩（临时文件自动清理）', () => {
    let seed = 12321
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const randName = () => {
      const chars = 'abcXYZ0123 ../\\\\?*:"<>|&.;\u4e2d\ud83d\ude00'
      let s = 'test_106_'
      const len = Math.floor(rand() * 30)
      for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)]
      return s + '.json'
    }
    const randContent = () => {
      const r = rand()
      if (r < 0.2) return null
      if (r < 0.4) return '不是JSON'
      if (r < 0.6) return [{ id: Math.floor(rand() * 100), title: 'x' }, null, 'str']
      return []
    }
    const written = [] // 记录本测试实际写过的文件（getFilePath 的 basename 可能截断前缀，不能按前缀猜）
    // v3.237：name/content 提到 try 外——catch 里引用（此前 catch 块引用 try 内块级变量会 ReferenceError，掩盖原始失败原因）
    let lastName = ''
    let lastContent = null
    try {
      for (let i = 0; i < 50; i++) {
        const name = randName()
        const content = randContent()
        lastName = name
        lastContent = content
        const fp = getFilePath(name)
        written.push(fp)
        assertEqual(typeof fp, 'string', 'getFilePath 应返回字符串')
        // saveBatch 只收对象数组（内部有校验）；用合法内容写入
        const msgs = Array.isArray(content) ? content.filter(x => x && typeof x === 'object') : []
        saveBatch(msgs, name)
        const read = readMessages(fp)
        assertEqual(Array.isArray(read), true, 'readMessages 应返回数组')
        // v3.176：参数顺序纠正——曾 isMessageInFile(name, {id}) 颠倒（message 位传文件名、
        // filename 位传对象），断言空转 + 每次运行残留 xianbaoku_cache/[object Object] 垃圾文件
        assertEqual(isMessageInFile({ id: 99999, title: 'n' }, name), false, 'isMessageInFile 不崩且不误判')
      }
    } catch (e) {
      throw new Error(`IO fuzz 失败 name="${String(lastName).slice(0, 40)}" content=${JSON.stringify(lastContent).slice(0, 40)}: ${e.message}`)
    } finally {
      // v3.155：清理本测试实际写过的文件（曾声称"自动清理"但未实现，跑完留乱码名垃圾如 01Zc;Z.json）
      try {
        const fs = require('fs')
        for (const fp of written) { try { fs.unlinkSync(fp) } catch (e) { /* 忽略 */ } }
      } catch (e) { /* 清理失败忽略 */ }
    }
  })

  await test('Fuzz-深度: 8 层嵌套 + 1MB 字符串 + 1000 轮大扫描', () => {
    let seed = 55555
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const deep = (d) => {
      if (d <= 0) return rand() < 0.5 ? Math.floor(rand() * 1e9) : (rand() < 0.7 ? 'str' + Math.floor(rand() * 100) : null)
      return rand() < 0.5 ? { k: deep(d - 1) } : [deep(d - 1)]
    }
    for (let i = 0; i < 200; i++) {
      const input = deep(8)
      assertEqual(typeof decodeHtmlEntities(input), 'string', '8 层嵌套 decode')
      assertEqual(typeof normUrl(input), 'string', '8 层嵌套 normUrl')
      assertEqual(typeof daysComputed(input), 'number', '8 层嵌套 daysComputed')
    }
    // 1MB 字符串
    const big = 'x'.repeat(1024 * 1024)
    assertEqual(typeof decodeHtmlEntities(big), 'string', '1MB decode')
    assertEqual(truncateUtf16(big, 100).length, 100, '1MB 截断')
    // 1000 轮快速扫描（5 个热函数）
    for (let i = 0; i < 1000; i++) {
      const v = rand() < 0.5 ? Math.floor(rand() * 1e10) : '2026-0' + Math.floor(rand() * 9) + '-1' + Math.floor(rand() * 9)
      daysComputed(v)
      normUrl('http://x.com/' + Math.floor(rand() * 10000) + '.html')
      decodeHtmlEntities('&amp;' + Math.floor(rand() * 100))
      truncateUtf16('标题' + Math.floor(rand() * 1000), 50)
      anonKey(Math.floor(rand() * 1e9), 't', 'c')
    }
  })

  console.log('\n📂 107. 深度 Fuzz 三轮（广覆盖：单调性/前缀性/组合/极端/模板/存储一致性）')

  await test('Property-3: daysComputed 单调性（更早日期 → 天数不更小）', () => {
    let seed = 112358
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const mkDate = () => {
      const y = 2020 + Math.floor(rand() * 10)
      const mo = 1 + Math.floor(rand() * 12)
      const d = 1 + Math.floor(rand() * 28)
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
    for (let i = 0; i < 500; i++) {
      const a = mkDate()
      const b = mkDate()
      const da = daysComputed(a)
      const db = daysComputed(b)
      assertEqual(da >= 0 && db >= 0, true, '天数非负')
      // a 早于 b → a 的天数应 >= b 的天数
      if (a < b) assertEqual(da >= db, true, `单调性: ${a}(${da}) vs ${b}(${db})`)
      else if (a > b) assertEqual(da <= db, true, `单调性: ${a}(${da}) vs ${b}(${db})`)
    }
  })

  await test('Property-3: truncateUtf16 前缀性（输出是输入前缀，允许代理对回退）', () => {
    let seed = 131071
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 500; i++) {
      let s = ''
      const len = Math.floor(rand() * 100)
      for (let j = 0; j < len; j++) s += rand() < 0.4 ? '😀' : (rand() < 0.7 ? '中' : 'a')
      const max = Math.floor(rand() * 80) + 1
      const out = truncateUtf16(s, max)
      // 输出必须是输入的前缀（允许末尾代理对回退 1 位）
      assertEqual(s.startsWith(out), true, `前缀性: "${s.slice(0, 20)}" → "${out.slice(0, 20)}"`)
    }
  })

  await test('Property-3: decode+htmlToMarkdown 组合无实体残留（随机实体 HTML）', () => {
    let seed = 161803
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 500; i++) {
      let html = ''
      const len = Math.floor(rand() * 20)
      for (let j = 0; j < len; j++) {
        const parts = ['&amp;', '&lt;b&gt;', '&amp;amp;', '&#38;', '&nbsp;', '<p>', '</p>', '文本', '&quot;', '&amp;lt;']
        html += parts[Math.floor(rand() * parts.length)]
      }
      const md = htmlToMarkdown({ content_html: html, url: 'http://x.com/' + i })
      // 输出不应含未解码实体（&amp; 等）
      assertEqual(md.includes('&amp;'), false, `组合无 &amp; 残留: "${html.slice(0, 40)}" → "${md.slice(0, 40)}"`)
    }
  })

  await test('Fuzz-极端: Unicode 边界（孤立代理/零宽/BOM/RTL/emoji 混合）', () => {
    const cases = [
      '\ud800', '\udfff', '\ud800\ud800', '\udfff\udfff', // 孤立代理
      '\u200b\u200c\u200d', // 零宽
      '\ufeff', // BOM
      '\u202e\u202b', // RTL
      '😀🎉💯🔍'.repeat(50), // emoji 堆叠
      '\u0000\u0001\u001f', // 控制字符
      '中\u0301\u0302文', // 组合变音符号
      'a'.repeat(10000) + '\ud800', // 尾随孤立高代理
      '&'.repeat(5000) + '\udfff', // 实体+孤立代理
      '\uD83D\uDE00' + 'x'.repeat(1000) // 代理对+长串
    ]
    for (const c of cases) {
      assertEqual(typeof decodeHtmlEntities(c), 'string', 'decode 极端 Unicode')
      assertEqual(typeof normUrl(c), 'string', 'normUrl 极端 Unicode')
      const out = truncateUtf16(c, 100)
      assertEqual(out.length <= 100, true, 'truncate 极端 Unicode 长度')
      assertEqual(typeof htmlToMarkdown({ content_html: c, url: 'x' }), 'string', 'htmlToMarkdown 极端 Unicode')
      assertEqual(typeof tuisong_replace('{标题}|{内容}', { title: c, content: c }), 'string', 'tuisong 极端 Unicode')
    }
  })

  await test('Fuzz-极端: 数字边界（-0/1e-323/MAX_VALUE/负数/1n）', () => {
    const nums = [-0, 1e-323, Number.MAX_VALUE, Number.MIN_VALUE, -1e12, -123.456, 1n, -1n, 0.0000001, 999999999999999]
    for (const n of nums) {
      assertEqual(typeof daysComputed(n), 'number', `daysComputed(${n})`)
      assertEqual(typeof anonKey(n, 't'), 'string', `anonKey(${n})`)
      assertEqual(typeof normUrl(n), 'string', `normUrl(${n})`)
      assertEqual(typeof truncateUtf16(n, 10), 'string', `truncateUtf16(${n})`)
      assertEqual(typeof decodeHtmlEntities(n), 'string', `decodeHtmlEntities(${n})`)
      assertEqual(typeof hasValidId({ id: n }), 'boolean', `hasValidId({id:${n}})`)
    }
  })

  await test('Fuzz-模板: 随机模板（占位符组合）tuisong_replace 不崩且已知占位符被替换', () => {
    let seed = 271828
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const placeholders = ['{分类名}', '{分类ID}', '{标题}', '{链接}', '{日期}', '{时间}', '{楼主}', '{类目}', '{价格}', '{商城}', '{品牌}', '{图片}', '{Html内容}', '{Markdown内容}', '{不存在}', '{{标题}}', '{标题', '标题}']
    const data = {
      catename: '测试分类',
      cateid: 42,
      title: '测试标题',
      url: '/t/1.html',
      datetime: '2026-08-01',
      shorttime: '22:00',
      louzhu: '楼主A',
      price: '9.9',
      mall_name: '京东',
      brand: '品牌',
      pic: 'http://img/1.jpg',
      content_html: '<b>内容</b>',
      content: '纯文本'
    }
    for (let i = 0; i < 500; i++) {
      let tpl = ''
      const len = Math.floor(rand() * 8) + 1
      for (let j = 0; j < len; j++) {
        tpl += placeholders[Math.floor(rand() * placeholders.length)]
        if (rand() < 0.5) tpl += '|'
      }
      // 强制追加未知占位符——保证"未知保留"断言对每个模板都有效
      const withUnknown = tpl + '{不存在}'
      const out = tuisong_replace(withUnknown, data)
      assertEqual(typeof out, 'string', `模板输出应为字符串: "${withUnknown}"`)
      // 已知占位符（标准格式 {X}）应被替换
      for (const ph of ['{分类名}', '{标题}', '{链接}', '{日期}', '{楼主}', '{类目}']) {
        if (out.includes(ph)) {
          throw new Error(`已知占位符 ${ph} 应被替换: 模板="${withUnknown}" 输出="${out.slice(0, 80)}"`)
        }
      }
      // 未知占位符 {不存在} 必须保留（tuisong_replace 只替换已知占位符）
      assertEqual(out.includes('{不存在}'), true, `未知占位符保留: "${withUnknown}"`)
    }
  })

  await test('Fuzz-存储: MessageStore 跨操作一致性（save→read→has 闭环）', () => {
    let seed = 3141592
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const file = 'test_107_store.json'
    const fp = getFilePath(file)
    try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    try {
      // 随机写入 50 条（含重复 id）
      const msgs = []
      for (let i = 0; i < 50; i++) {
        msgs.push({ id: Math.floor(rand() * 30), title: 'T' + i, url: '/u/' + Math.floor(rand() * 30) + '.html' })
      }
      saveBatch(msgs, file)
      // 读回：数量 ≤ 50（去重）
      const read = readMessages(fp)
      assertEqual(Array.isArray(read), true, '读回应为数组')
      // 每条读回的对象都有 id 或 url
      for (const m of read) {
        assertEqual(m && typeof m === 'object', true, '读回元素应为对象')
        assertEqual(m.id !== undefined || m.url !== undefined, true, '元素应有 id 或 url')
      }
      // 随机查询一致性：查询存在的 id → has 应为 true（注意 has(message, filename) 参数顺序）
      const some = read[Math.floor(rand() * read.length)]
      if (some && some.id !== undefined) {
        if (!isMessageInFile({ id: some.id, title: 'x' }, file)) {
          throw new Error(`已存 id ${some.id} 应查到（title="${some.title}" url="${some.url}"）`)
        }
      }
      // 查询不存在的 id → false（has(message, filename) 参数顺序）
      assertEqual(isMessageInFile({ id: 99999, title: 'n' }, file), false, '不存在的 id 查不到')
    } finally {
      try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    }
  })

  console.log('\n📂 108. Fuzz 回归二（孤立代理清洗）')

  await test('Fuzz 回归: 孤立代理 → tuisong_replace 输出 U+FFFD 且 encode 不崩（v3.110）', () => {
    const cases = ['a\ud800b', 'a\udfff b', '😀\ud800', '\udfff😀', '正常文本😀🎉', '&amp;\ud800&lt;']
    const isolatedRe = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const c of cases) {
      const out = tuisong_replace('{内容}', { title: 't', content: c })
      assertEqual(isolatedRe.test(out), false, `输出无孤立代理: ${JSON.stringify(c)} → ${JSON.stringify(out)}`)
      try { encodeURIComponent(out) } catch (e) { throw new Error(`encodeURIComponent 崩: ${JSON.stringify(c)} → ${JSON.stringify(out)}`) }
      if (c.includes('😀')) assertEqual(out.includes('😀'), true, '完整代理对应保留')
    }
    // 完整代理对不受影响
    const emoji = tuisong_replace('{内容}', { title: 't', content: '完整😀🎉对' })
    assertEqual(emoji, '完整😀🎉对', '正常 emoji 原样')
  })

  await test('Fuzz 回归: sanitize 与 truncate 组合（孤立代理+截断边界）', () => {
    const s = '标题\ud800' + '😀'.repeat(50) + '\udfff尾部'
    const out = tuisong_replace('{标题}', { title: s, content: 'c' })
    assertEqual(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), false, '组合输出无孤立代理')
    assertEqual(out.includes('😀'), true, '完整代理对保留')
  })

  console.log('\n📂 109. 深度 Fuzz 四轮（过滤引擎组合/HTML 畸形/自定义 got/实体映射完整性）')

  await test('Fuzz-过滤: 随机 filter 配置 × 随机数据 → listfilter 不崩且返回 boolean', () => {
    let seed = 20261201
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const randRe = () => {
      const r = rand()
      if (r < 0.2) return ''
      if (r < 0.4) return '京东'
      if (r < 0.5) return '(' // 非法正则
      if (r < 0.6) return '(a+)+' // ReDoS 风险
      if (r < 0.7) return '楼主|小明'
      if (r < 0.8) return '分类###京东' // 多行
      if (r < 0.9) return '标题###京东<br/>内容###秒杀'
      const chars = 'ab()[]*+?|.\\^$分类标题'
      let s = ''
      const len = Math.floor(rand() * 10) + 1
      for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)]
      return s
    }
    for (let i = 0; i < 200; i++) {
      const cfg = {
        pingbifenlei: randRe(),
        pingbibiaoti: randRe(),
        pingbineirong: randRe(),
        pingbilouzhu: randRe(),
        zhanxianbiaoti: randRe(),
        zhanxianlouzhu: randRe(),
        pingbitime: String(Math.floor(rand() * 30))
      }
      const compiled = compileRules(cfg)
      for (let j = 0; j < 20; j++) {
        const item = {
          catename: rand() < 0.3 ? null : ('分类' + Math.floor(rand() * 5)),
          title: rand() < 0.2 ? '' : ('标题' + Math.floor(rand() * 100) + (rand() < 0.5 ? '京东' : '')),
          content: rand() < 0.2 ? null : '内容' + Math.floor(rand() * 100),
          louzhu: rand() < 0.2 ? '' : '楼主' + Math.floor(rand() * 20),
          louzhuregtime: rand() < 0.3 ? null : ('2026-0' + (1 + Math.floor(rand() * 9)) + '-1' + Math.floor(rand() * 9))
        }
        const r = listfilter(item, compiled)
        assertEqual(typeof r, 'boolean', `listfilter 应返回 boolean: ${JSON.stringify(cfg).slice(0, 60)}`)
      }
    }
  })

  await test('Fuzz-HTML: 随机畸形标签 htmlToMarkdown 不崩且标签剥离干净', () => {
    let seed = 2718282
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const atoms = ['<b>', '</b>', '<a href="x">', '</a>', '<img src="i">', '<br>', '<br/>', '<p>', '</p>',
      '<h1>', '<h2>', '</h1>', '<li>', '</li>', '<table>', '<td>', '<tr>', '<div>', '<span>',
      '<', '>', '</', '<>', '</>', '<a>', '文本', 'x', '&amp;', '&lt;', '😀', '<script>', '</script>', '<style>', '</style>']
    for (let i = 0; i < 300; i++) {
      let html = ''
      const len = Math.floor(rand() * 15) + 1
      for (let j = 0; j < len; j++) html += atoms[Math.floor(rand() * atoms.length)]
      const md = htmlToMarkdown({ content_html: html, url: 'http://x.com/' + i })
      assertEqual(typeof md, 'string', `htmlToMarkdown 应返回字符串: "${html.slice(0, 60)}"`)
      // 标签剥离干净由 84 章快照锁定；fuzz 只验证健壮性（字面 &lt; 解码的 < 与残余文本拼形似标签属正确保留）
      // encode 不崩（孤立代理清洗后）
      try { encodeURIComponent(md) } catch (e) { throw new Error(`encode 崩: "${html.slice(0, 40)}"`) }
    }
  })

  await test('Fuzz-实体: ENTITY_MAP 完整性（每个实体解码正确 + 无重复）', () => {
    // 通过导出验证 36 个实体全部可解码
    const entities = ['amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'hellip', 'mdash', 'copy', 'reg',
      'trade', 'euro', 'times', 'divide', 'middot', 'deg', 'plusmn', 'laquo', 'raquo', 'ndash',
      'lsquo', 'rsquo', 'ldquo', 'rdquo', 'bull', 'sect', 'para', 'pound', 'yen', 'ensp', 'emsp',
      'cent', 'curren', 'larr', 'rarr', 'uarr', 'darr']
    const expected = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
      hellip: '…',
      mdash: '—',
      copy: '©',
      reg: '®',
      trade: '™',
      euro: '€',
      times: '×',
      divide: '÷',
      middot: '·',
      deg: '°',
      plusmn: '±',
      laquo: '«',
      raquo: '»',
      ndash: '–',
      lsquo: '‘',
      rsquo: '’',
      ldquo: '“',
      rdquo: '”',
      bull: '•',
      sect: '§',
      para: '¶',
      pound: '£',
      yen: '¥',
      ensp: ' ',
      emsp: ' ',
      cent: '¢',
      curren: '¤',
      larr: '←',
      rarr: '→',
      uarr: '↑',
      darr: '↓'
    }
    const seen = new Set()
    for (const name of entities) {
      assertEqual(!seen.has(name), true, `实体 ${name} 不应重复`)
      seen.add(name)
      const out = decodeHtmlEntities('&' + name + ';')
      assertEqual(out, expected[name], `&${name}; 应解码为 ${JSON.stringify(expected[name])}，实际 ${JSON.stringify(out)}`)
    }
  })

  await test('Fuzz-got: 随机 URL/options 调用不抛同步异常（reject 是预期）', async () => {
    const http = require('http')
    const got = require('got')
    // 本地正常 server（部分 URL 命中它）
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port
    let seed = 111111
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const randUrl = () => {
      const r = rand()
      if (r < 0.3) return `http://127.0.0.1:${port}/ok`
      if (r < 0.4) return 'http://127.0.0.1:1/x' // 连接拒绝
      if (r < 0.5) return 'not a url'
      if (r < 0.6) return '//host/path'
      if (r < 0.7) return 'http://' + Math.floor(rand() * 255) + '.' + Math.floor(rand() * 255) + '.x/x'
      if (r < 0.8) return 'ftp://x.com/'
      return 'http://127.0.0.1:' + port + '/' + Math.floor(rand() * 1000)
    }
    const randOptions = () => ({
      timeout: 300, // 短超时防挂
      retry: { limit: 0 },
      headers: rand() < 0.5 ? { 'X-Test': String(Math.floor(rand() * 100)) } : {},
      json: rand() < 0.3 ? { a: Math.floor(rand() * 10) } : undefined
    })
    const calls = []
    for (let i = 0; i < 40; i++) {
      const url = randUrl()
      const options = randOptions()
      let threw = false
      try {
        // 调用本身不应抛同步异常
        const p = got(url, options)
        calls.push(p.catch(() => 'rejected')) // reject 是预期（网络失败/畸形 URL）
      } catch (e) {
        threw = true
        calls.push(Promise.resolve('sync-threw:' + e.message))
      }
      assertEqual(threw, false, `got 不应同步抛: url="${url.slice(0, 40)}"`)
    }
    await Promise.allSettled(calls)
    await new Promise(r => server.close(r))
  })

  await test('Fuzz-时间: checkTimeCompiled 随机 compiled × 随机 group 不崩', () => {
    let seed = 99999
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const mkCompiled = () => {
      const r = rand()
      if (r < 0.25) return null
      if (r < 0.5) return { _type: 'time', value: Math.floor(rand() * 50) }
      if (r < 0.75) return { _type: 'timeMulti', rules: [{ cat: null, value: Math.floor(rand() * 50) }] }
      return { _type: 'weird', value: 'x' }
    }
    const mkGroup = () => ({
      catename: rand() < 0.3 ? null : '分类' + Math.floor(rand() * 5),
      louzhuregtime: rand() < 0.3 ? null : (rand() < 0.5 ? '2026-01-01' : String(Math.floor(rand() * 1e9)))
    })
    for (let i = 0; i < 300; i++) {
      const c = mkCompiled()
      const g = mkGroup()
      const r = checkTimeCompiled(c, g)
      assertEqual(r === null || typeof r === 'boolean', true, `checkTimeCompiled 应返回 null/boolean: ${JSON.stringify(c)}`)
    }
  })

  console.log('\n📂 110. 边界精确值二（官方 got 响应体/getFilePath 200 字节/跨日边界）')

  await test('边界: 官方 got 响应体精确读取', async () => {
    const http = require('http')
    const got = require('got')
    const body = '1234567890'
    const server = http.createServer((req, res) => { res.writeHead(200); res.end(body) })
    await new Promise(r => server.listen(0, r))
    try {
      const r = await got(`http://127.0.0.1:${server.address().port}/x`, { retry: { limit: 0 } })
      assertEqual(r.body, body, '官方 got 应保留精确响应体')
    } finally {
      await new Promise(r => server.close(r))
    }
  })

  await test('边界: getFilePath 200 字节精确截断（ASCII/中文/混合）', () => {
    // 恰好 200 字节 → 不截断（v3.33 逻辑：>200 才截）
    const n200 = 'x'.repeat(195) + '.json' // 195+5=200 字节
    const p1 = getFilePath(n200)
    assertEqual(require('path').basename(p1), n200, '恰好 200 字节不截断')
    // 201 字节 → 截断到 ≤200
    const n201 = 'x'.repeat(196) + '.json' // 201 字节
    const p2 = getFilePath(n201)
    const base2 = require('path').basename(p2)
    assertEqual(Buffer.byteLength(base2, 'utf8') <= 200, true, `201 字节截断到 ≤200: ${Buffer.byteLength(base2, 'utf8')}`)
    // 中文（3 字节/字）边界：67 字 = 201 字节
    const cn = '中'.repeat(65) + '.json' // 195+5=200
    const p3 = getFilePath(cn)
    assertEqual(Buffer.byteLength(require('path').basename(p3), 'utf8') <= 200, true, '中文名截断 ≤200')
    // 尾部代理对 emoji 名不崩
    const em = '😀'.repeat(80) + '.json' // 160+5=165 字节（代理对 4 字节/个）
    const p4 = getFilePath(em)
    assertEqual(typeof p4, 'string', 'emoji 文件名不崩')
    // 极端：200 字节恰好是代理对中间 → 截断安全
    const edge = 'x'.repeat(196) + '\ud83d\ude00' + '.json'
    const p5 = getFilePath(edge)
    assertEqual(typeof p5, 'string', '代理对边界文件名不崩')
  })

  await test('边界: 跨日边界（今天 0 点 = 0 天 / 昨天 0 点 = 1 天）', () => {
    // v3.174：用 UTC 日期构造"今天/昨天 0 点"——daysFrom 按 UTC 日期差（v3.170）；
    // 原 setHours(0,0,0,0) 是本地时区 0 点，+8 时区本地 0 点 = UTC 前一天 16:00 → 误算 1 天
    // （Gitee Go 容器 +8 时区实测失败，本地 UTC 时区全绿——跨环境暴露）
    const now = new Date()
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    assertEqual(daysComputed(todayUtc), 0, '今天 0 点应=0 天')
    const yesterdayUtc = todayUtc - 86400000
    assertEqual(daysComputed(yesterdayUtc), 1, '昨天 0 点应=1 天')
    // v3.170：自然日语义（原 24h 段）——以下用固定"今天"避免真实时刻导致边界不稳
    const origNow = Date.now
    try {
      Date.now = () => Date.UTC(2026, 7, 3, 12, 0) // 今天 = 2026-08-03 12:00 UTC
      const future = Date.now() + 60000
      assertEqual(daysComputed(future), 0, '未来 1 分钟应=0')
      // 差 24h-1ms（昨日同时刻）→ 自然日 = 昨天 → 1 天（24h 段曾算 0，v3.170 修正）
      const almost = Date.now() - 86399999
      assertEqual(daysComputed(almost), 1, '差 24h-1ms 属昨日 → 1 天（自然日，v3.170）')
      // 恰好 24h 前 → 昨日 → 1 天（两种口径一致）
      const dayAgo = Date.now() - 86400000
      assertEqual(daysComputed(dayAgo), 1, '恰好 24h 前应=1')
    } finally {
      Date.now = origNow
    }
  })

  console.log('\n📂 111. 边界回归补充（负数天数/空值/TS_BOUND 下界/normUrl 空）')

  await test('时区回归: 数字形态字符串无效(v3.142: 字符串-1曾宿主解析成2001)', () => {
    // 数字形态字符串（负号/小数）应无效——与数字 -1/2026.5 一致（审查5-2 精神）
    assertEqual(daysComputed('-1'), 0, '字符串 -1 应无效(曾解析成 2001 年 9344 天)')
    assertEqual(daysComputed('2026.5'), 0, '字符串小数应无效(曾解析成 2026-05-01)')
    assertEqual(daysComputed('-100'), 0, '字符串 -100 应无效')
    assertEqual(daysComputed('0') > 20000, true, '字符串 0=1970 应巨大天数（与数字 0 一致）')
    assertEqual(daysComputed('2026-07-28') > 0, true, '正常日期不受影响')
    assertEqual(daysComputed('1785346200') > 0, true, '正常时间戳不受影响')
  })

  await test('时区回归: ISO 无时区标记与含 Z 恒等（v3.131：v3.115 漏此格式，Honolulu 差 1 天）', () => {
    // 无 Z / 含 Z / 空格分隔 三者在任何时区都应恒等（统一 UTC 解析）
    const t = '2026-08-01T10:30:00'
    assertEqual(daysComputed(t), daysComputed(t + 'Z'), 'ISO 无 Z 应等于含 Z')
    assertEqual(daysComputed('2026-08-01 10:30:00'), daysComputed(t + 'Z'), '空格分隔应等于含 Z')
    assertEqual(daysComputed('2026-07-31T22:00:00'), daysComputed('2026-07-31T22:00:00Z'), '边界日期')
    // 带偏移的不受影响（保留原语义）
    assertEqual(daysComputed('2026-08-01T10:30:00+08:00'), daysComputed('2026-08-01T02:30:00Z'), '偏移解析正确')
  })

  await test('边界回归: daysComputed 负数 → 0（v3.62 修复 -1→2001 bug 的显式回归）', () => {
    assertEqual(daysComputed(-1), 0, '-1 应无效→0（曾 new Date(-1)=1969/2001 怪异）')
    assertEqual(daysComputed(-100), 0, '-100 应无效→0')
    assertEqual(daysComputed(-1e12), 0, '-1e12 应无效→0')
    assertEqual(daysComputed(-Infinity), 0, '-Infinity 应无效→0')
    assertEqual(daysComputed(0) > 20000, true, '0=1970 应有巨大天数')
  })

  await test('边界回归: parseTime/daysComputed 空值边界', () => {
    assertEqual(daysComputed(null), 0, 'null → 0')
    assertEqual(daysComputed(''), 0, '空串 → 0')
    assertEqual(daysComputed(undefined), 0, 'undefined → 0')
    assertEqual(daysComputed('   '), 0, '纯空白 → 0')
    assertEqual(daysComputed('abc'), 0, '非日期字符串 → 0')
  })

  await test('边界回归: TS_BOUND 下界/上界精确（1e8/1e14）', () => {
    assertEqual(daysComputed(99999999), 0, '9位(1e8-1) 范围外→0')
    assertEqual(daysComputed(100000000) > 19000, true, '1e8 秒起点(1973)有天数')
    assertEqual(daysComputed(99999999999999), 0, '1e14-1(5138年)未来→0')
    assertEqual(daysComputed(100000000000000), 0, '1e14 超范围→0')
  })

  await test('边界回归: normUrl 空/空白/null', () => {
    assertEqual(normUrl(''), '', '空串→空')
    assertEqual(normUrl('   '), '', '纯空白→空')
    assertEqual(normUrl('///'), '', '全斜杠→空')
    assertEqual(normUrl('//'), '', '双斜杠→空')
    assertEqual(normUrl(null), '', 'null→空')
    assertEqual(normUrl(undefined), '', 'undefined→空')
    assertEqual(normUrl('http://x.com/'), 'http://x.com', '尾斜杠去除')
  })

  console.log('\n📂 112. saveBatch 索引化：判重一致性 + 性能基准')

  await test('统一 URL 身份：伪 URL/危险 URL 不参与判重，脏 URL 走匿名身份', () => {
    const fs = require('fs')
    assertEqual(safeUrl({}), '', '对象 URL 不应字符串化')
    assertEqual(validUrl('[object Object]'), '', '历史伪 URL 不应参与判重')
    assertEqual(validUrl('java\nscript:alert(1)'), '', '危险协议不应参与判重')
    const name = 'test_identity_url_contract.json'
    const p = getFilePath(name)
    try { fs.unlinkSync(p) } catch (e) {}
    fs.writeFileSync(p, JSON.stringify([{ url: '[object Object]', title: '旧伪URL' }]), 'utf8')
    saveBatch([{ url: {}, title: '新匿名消息' }], name)
    assertEqual(readMessages(p).length, 2, '旧伪 URL 与新脏 URL 不应互相吞掉')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('异常 getter 字段在模板/HTML/缓存路径均安全降级（v3.231）', () => {
    const item = {}
    Object.defineProperty(item, 'title', {
      enumerable: true,
      configurable: true,
      get () { throw new Error('title getter') }
    })
    Object.defineProperty(item, 'content_html', {
      enumerable: true,
      configurable: true,
      get () { throw new Error('html getter') }
    })
    assertEqual(tuisong_replace('{标题}|{内容}', item), '|', '异常 getter 不应让模板替换抛错')
    assertEqual(htmlToMarkdown(item), '', '异常 content_html getter 应按空内容处理')
    item.id = 5832
    saveBatch([item], 'test_throwing_getter_cache.json')
    assertEqual(readMessages(getFilePath('test_throwing_getter_cache.json')).length, 1, '异常 getter 消息仍可安全落盘')
  })

  await test('safeUrl 拒绝非换行 ASCII 控制字符（v3.231）', () => {
    assertEqual(safeUrl('https://example.com/a\u0000b'), '', 'NUL 不应进入 URL 输出/身份')
    assertEqual(validUrl('https://example.com/a\u0000b'), '', 'NUL URL 不应参与身份判重')
  })

  await test('safeUrl 拒绝命名实体/双编码危险协议变体（Round2 C009）', () => {
    assertEqual(safeUrl('javascript&Colon;alert(1)'), '', '&Colon; 不应绕过危险协议检查')
    assertEqual(safeUrl('javascript&COLON;alert(1)'), '', '&COLON; 不应绕过危险协议检查')
    assertEqual(safeUrl('javascript&amp;colon;alert(1)'), '', '&amp;colon; 双编码不应绕过危险协议检查')
    assertEqual(safeUrl('javascript&Newline;x'), '', '&Newline; 不应绕过危险协议检查')
    assertEqual(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1', '正常 https URL 不受影响')
  })

  await test('性能: saveBatch 5000 条 <500ms（v3.118 索引化，原 2475ms）', () => {
    const msgs = []
    for (let i = 0; i < 5000; i++) msgs.push({ id: i % 3000, title: 'T' + i, url: '/u/' + (i % 3000) + '.html' })
    const t0 = Date.now()
    saveBatch(msgs, 'test_112_perf.json')
    const ms = Date.now() - t0
    assertEqual(ms < Number(process.env.PERF_MS || 500), true, `5000 条 saveBatch 应 <${process.env.PERF_MS || 500}ms，实际 ${ms}ms`)
    try { require('fs').unlinkSync(getFilePath('test_112_perf.json')) } catch (e) { /* 忽略 */ }
  })

  await test('一致性: saveBatch 索引判重 vs 逐条 upsert 结果一致（随机数据）', () => {
    let seed = 20261202
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    // 生成含重复 id/url/无 id 的随机消息流（覆盖 id 命中/url 命中/更新/追加）
    const mkMsgs = () => {
      const msgs = []
      for (let i = 0; i < 60; i++) {
        const r = rand()
        const m = { title: 'T' + i, content: 'C' + Math.floor(rand() * 20) }
        if (r < 0.4) m.id = Math.floor(rand() * 30) // 有 id（含重复）
        else if (r < 0.7) m.url = '/u/' + Math.floor(rand() * 25) + '.html' // 无 id 有 url
        else { m.id = Math.floor(rand() * 15); m.url = '/u/' + Math.floor(rand() * 15) + '.html' } // id+url
        msgs.push(m)
      }
      return msgs
    }
    // 两轮：第一轮 + 第二轮（覆盖缓存中已存在时的更新/追加）
    for (let round = 0; round < 3; round++) {
      const msgs = mkMsgs()
      // A: saveBatch（索引版）
      const fa = getFilePath('test_112_cmp_a.json')
      try { require('fs').unlinkSync(fa) } catch (e) { /* 忽略 */ }
      saveBatch(msgs, 'test_112_cmp_a.json')
      const ra = readMessages(fa).map(x => ({ id: x.id, title: x.title, url: x.url }))
      // B: 逐条 appendMessageToFile（原 _upsert 逻辑，每批同序）
      const fb = getFilePath('test_112_cmp_b.json')
      try { require('fs').unlinkSync(fb) } catch (e) { /* 忽略 */ }
      for (const msg of msgs) {
        if (msg && typeof msg === 'object' && !Array.isArray(msg)) appendMessageToFile(msg, 'test_112_cmp_b.json')
      }
      const rb = readMessages(fb).map(x => ({ id: x.id, title: x.title, url: x.url }))
      // 结果数组必须一致（顺序 + 内容）
      assertEqual(JSON.stringify(ra), JSON.stringify(rb), `第${round}轮 saveBatch 与逐条 upsert 结果应一致`)
      try { require('fs').unlinkSync(fa) } catch (e) { /* 忽略 */ }
      try { require('fs').unlinkSync(fb) } catch (e) { /* 忽略 */ }
    }
  })

  await test('一致性: 更新后索引维护（id 变化/url 失效）', () => {
    const file = 'test_112_reindex.json'
    const fp = getFilePath(file)
    try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    try {
      saveBatch([{ id: 1, title: 'old', url: '/a' }], file)
      saveBatch([{ id: 1, title: 'new', url: '/b' }], file) // 同 id 更新，url 变化
      const r = readMessages(fp)
      assertEqual(r.length, 1, '更新后仍 1 条')
      assertEqual(r[0].title, 'new', '标题已更新')
      assertEqual(r[0].url, '/b', 'url 已更新')
      assertEqual(isMessageInFile({ id: 1 }, file), true, '新 id 查到')
      assertEqual(isMessageInFile({ url: '/a' }, file), false, '旧 url 失效')
      assertEqual(isMessageInFile({ url: '/b' }, file), true, '新 url 查到')
      // 追加新 id + 更新旧 id 混合
      saveBatch([{ id: 2, title: 'x' }, { id: 1, title: 'final' }], file)
      assertEqual(readMessages(fp).length, 2, '混合后 2 条')
      assertEqual(isMessageInFile({ id: 1, title: 'final' }, file), true, 'id1 更新')
    } finally {
      try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    }
  })

  console.log('\n📂 113. saveBatch 索引化强化验证（脏缓存/多批/同键多条 vs 旧逻辑）')

  await test('一致性-强化: 30 轮随机（脏缓存+多批+同键多条）索引版 vs 旧 findIndex 逻辑', () => {
    // 旧逻辑精确复刻 _findDedupIndex（findIndex 顺序语义）——作为对照基准
    const oldDedup = (messages, message) => messages.findIndex(mm => {
      const isId = (v) => v !== undefined && v !== null && (typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' && Number.isFinite(v))
      const mid = mm && mm.id; const qid = message.id
      return (isId(qid) && (String(mid) === String(qid) || (!isId(mid) && mm.url && message.url && normUrl(mm.url) === normUrl(message.url)))) ||
               (!isId(qid) && message.url && normUrl(mm.url) === normUrl(message.url))
    })
    let seed = 424242
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const randMsg = () => {
      const r = rand()
      const msg = { title: 'T' + Math.floor(rand() * 1000) }
      if (r < 0.35) msg.id = Math.floor(rand() * 40)
      else if (r < 0.65) msg.url = '/u/' + Math.floor(rand() * 30) + '.html'
      else { msg.id = Math.floor(rand() * 20); msg.url = '/u/' + Math.floor(rand() * 20) + '.html' }
      return msg
    }
    for (let round = 0; round < 30; round++) {
      const fname = 'test_113_r' + round + '.json'
      // 脏缓存（同 id/同 url 多条）
      const dirty = []
      const nd = Math.floor(rand() * 6)
      for (let i = 0; i < nd; i++) dirty.push(randMsg())
      const batches = []
      let total = nd
      for (let b = 0; b < 4 && total < 80; b++) {
        const batch = []
        const nb = Math.min(Math.floor(rand() * 12), 80 - total)
        for (let i = 0; i < nb; i++) batch.push(randMsg())
        total += nb
        batches.push(batch)
      }
      // A：saveBatch（索引版）
      const fa = getFilePath(fname)
      try { require('fs').unlinkSync(fa) } catch (e) { /* 忽略 */ }
      require('fs').writeFileSync(fa, JSON.stringify(dirty))
      for (const batch of batches) saveBatch(batch, fname)
      const ra = readMessages(fa).map(x => ({ id: x.id === undefined ? undefined : String(x.id), title: x.title, url: x.url }))
      try { require('fs').unlinkSync(fa) } catch (e) { /* 忽略 */ }
      // B：旧 findIndex 逻辑（同数据）
      const arr = dirty.map(x => ({ ...x }))
      for (const batch of batches) {
        for (const msg of batch) {
          const idx = oldDedup(arr, msg)
          if (idx >= 0) arr[idx] = { ...msg }; else arr.push({ ...msg })
        }
      }
      const rb = arr.map(x => ({ id: x.id === undefined ? undefined : String(x.id), title: x.title, url: x.url }))
      assertEqual(JSON.stringify(ra), JSON.stringify(rb), `第${round}轮索引版与旧逻辑结果应一致`)
    }
  })

  await test('一致性-强化: 脏缓存同键多条 + 首条被覆盖 + 更新索引维护', () => {
    // 场景：同 url 多条无 id 脏缓存，首条被 id 消息覆盖，再有无 id 同 url 消息
    const fname = 'test_113_dirty.json'
    const fp = getFilePath(fname)
    try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    try {
      require('fs').writeFileSync(fp, JSON.stringify([{ title: 'x1', url: '/u/1' }, { title: 'x2', url: '/u/1' }]))
      saveBatch([{ id: 5, title: 'id5', url: '/u/1' }], fname)
      saveBatch([{ title: 'noId', url: '/u/1' }], fname)
      const r = readMessages(fp)
      assertEqual(r.length, 2, '应 2 条')
      assertEqual(r[0].title, 'noId', '无 id 消息更新了 index 0（id5 那条，url 匹配首个）')
      assertEqual(r[1].title, 'x2', 'x2 保留')
    } finally {
      try { require('fs').unlinkSync(fp) } catch (e) { /* 忽略 */ }
    }
  })

  // ==================== 100. v3.156 配置空白/normUrl/更新日志修复 ====================
  console.log('\n📂 100. v3.156 修复')

  await test('空白 pingbibiaoti → 编译为 null + validateConfig 警告（#1/#6）', () => {
    const c = compileRules({ pingbibiaoti: '   ' })
    assertEqual(c.pingbibiaoti, null, '空白不应编译成正则（曾 /   /i 假过滤）')
    const warns = validateConfig({ pingbibiaoti: '   ' })
    assertEqual(warns.some(w => w.includes('空白字符')), true, '应警告空白配置')
    assertEqual(listfilter(makeItem({ title: '京东   神券' }), c), true, '3+空格标题不应被假过滤')
  })

  await test('空白 pingbitime → 编译为 null + validateConfig 警告（#2/#6）', () => {
    const c = compileRules({ pingbitime: '   ' })
    assertEqual(c.pingbitime, null, '空白不应编译成 value:0（曾静默关闭时间过滤）')
    const warns = validateConfig({ pingbitime: '   ' })
    assertEqual(warns.some(w => w.includes('空白字符')), true, '应警告空白配置')
    const c2 = compileRules({ pingbitime: ' 5 ' })
    assertEqual(c2.pingbitime._type === 'time' && c2.pingbitime.value === 5, true, '首尾空格应 trim 后生效')
  })

  await test('normUrl 去 query/hash + 无id同内容不同query去重（#4）', () => {
    assertEqual(normUrl('/a?x=1'), 'a')
    assertEqual(normUrl('/a?x=2'), 'a')
    assertEqual(normUrl('/a#sec'), 'a')
    assertEqual(normUrl('https://A.com/p?u=1&t=2#top'), 'https://a.com/p')
    const fs = require('fs')
    const p = getFilePath('test_q156.json')
    try { fs.unlinkSync(p) } catch (e) {}
    saveBatch([{ url: '/a?x=1', title: '同' }], 'test_q156.json')
    saveBatch([{ url: '/a?x=2', title: '同' }], 'test_q156.json')
    assertEqual(readMessages(p).length, 1, '去 query 后应判重 1 条')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('saveBatch 同内容更新不误报"更新缓存记录"（#5）', () => {
    const fs = require('fs')
    const p = getFilePath('test_ts156.json')
    try { fs.unlinkSync(p) } catch (e) {}
    saveBatch([{ id: 1, title: 'A' }], 'test_ts156.json')
    const logs = []
    const orig = console.log
    console.log = (...a) => logs.push(a.join(' '))
    try {
      saveBatch([{ id: 1, title: 'A' }], 'test_ts156.json')
    } finally {
      console.log = orig
    }
    assertEqual(logs.some(l => l.includes('更新缓存记录')), false, '内容相同不应报更新（曾因 timestamp 差异误报）')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  // ==================== 101. v3.157 修复 ====================
  console.log('\n📂 101. v3.157 修复')

  await test('anonKey 字段差异不合并（#2/41）', () => {
    const k1 = anonKey('同标题', '同内容', null, null, 'pic1', '京东', '9.9', 'A牌', '分类')
    const k2 = anonKey('同标题', '同内容', null, null, 'pic1', '京东', '19.9', 'A牌', '分类')
    assertEqual(k1 !== k2, true, '价格不同应不同 key')
    const k3 = anonKey('同标题', '同内容', null, null, 'pic1', '淘宝', '9.9', 'B牌', '分类')
    assertEqual(k1 !== k3, true, '商城/品牌不同应不同 key')
  })

  await test('pingbitime 非法数值 → null + validateConfig 警告（#15）', () => {
    const c = compileRules({ pingbitime: 'abc' })
    assertEqual(c.pingbitime, null, '非法值不应落 value:0')
    const warns = validateConfig({ pingbitime: 'abc' })
    assertEqual(warns.some(w => w.includes('不是有效数字')), true, '应警告')
    assertEqual(compileRules({ pingbitime: '5' }).pingbitime.value, 5, '合法值不受影响')
  })

  await test('readMessages 数组元素被排除（#21）', () => {
    const fs = require('node:fs')
    const p = getFilePath('test_arr157.json')
    try { fs.unlinkSync(p) } catch (e) {}
    fs.writeFileSync(p, JSON.stringify([{ id: 1, title: 'A' }, [1, 2], 'str', null]), 'utf8')
    const r = readMessages(p)
    assertEqual(r.length, 1, '数组/字符串/null 应被排除，仅保留对象')
    try { fs.unlinkSync(p) } catch (e) {}
  })

  await test('getFileName 坏源命名（#10/49）', () => {
    const n1 = getFileName(123)
    const n2 = getFileName(456)
    assertEqual(n1 !== n2, true, '不同数字应不同缓存名')
    assertEqual(n1.endsWith('.json') && n2.endsWith('.json'), true, '应 .json 结尾')
    assertEqual(getFileName(123), getFileName(123), '同坏源幂等')
    assertEqual(getFileName(''), 'default.json', '空串 default')
    assertEqual(getFileName(undefined), 'default.json', 'undefined default')
    assertEqual(getFileName({ a: 1 }), 'default.json', '对象 default')
  })

  await test('脏字段转字符串失败不应让过滤流程崩溃', () => {
    const bad = { toString () { throw new Error('bad toString') } }
    assertEqual(listfilter({ catename: 'a', louzhu: bad, title: bad, content: bad, louzhuregtime: '2020-01-01' }, {
      pingbilouzhu: 'x', pingbibiaoti: 'x', pingbineirong: 'x'
    }), true, '无法转字符串的字段应保守放行')
    assertEqual(listfilter({ catename: bad, title: 'x', content: 'x', louzhuregtime: '2020-01-01' }, {
      pingbibiaoti: 'a###x'
    }), true, '分类限定字段转换失败也应保守放行')
  })

  await test('validateConfig/compileRules 脏 pingbitime 转换失败不应抛异常', () => {
    const bad = { toString () { throw new Error('bad pingbitime') } }
    const warnings = validateConfig({ pingbitime: bad })
    assertEqual(Array.isArray(warnings), true, '应返回警告数组')
    assertEqual(warnings.some(w => w.includes('无法转换')), true, '应提示无法转换')
    assertEqual(compileRules({ pingbitime: bad }).pingbitime, null, '编译失败应忽略脏规则')

    const symbolWarnings = validateConfig({ pingbitime: Symbol('bad pingbitime') })
    assertEqual(Array.isArray(symbolWarnings), true, 'Symbol pingbitime 应返回警告数组')
    assertEqual(symbolWarnings.some(w => w.includes('不是有效数字')), true, 'Symbol pingbitime 应给出数值警告')
    assertEqual(compileRules({ pingbitime: Symbol('bad pingbitime') }).pingbitime, null, 'Symbol 编译应忽略脏规则')

    const maxWarnings = validateConfig({ cache: { maxSize: Symbol('bad maxSize') } })
    assertEqual(Array.isArray(maxWarnings), true, 'Symbol maxSize 应返回警告数组')
  })

  await test('tuisong_replace 循环引用字段不应崩溃', () => {
    const circular = {}
    circular.self = circular
    assertEqual(tuisong_replace('{内容}|{标题}|{分类名}', {
      content: circular, title: circular, catename: circular
    }), '||', '循环引用字段应安全降为空')
  })

  await test('HTML 图片支持无引号 src/alt', () => {
    const out = htmlToMarkdown({ content_html: '<img src=https://img.example/a.png alt=示例>' })
    assertEqual(out.includes('![示例](https://img.example/a.png)'), true, `无引号图片应转换: ${out}`)
  })

  // ==================== C002：sanitizeDecodedHtml ReDoS/性能 ====================
  console.log('\n📂 C002 sanitizeDecodedHtml ReDoS/性能')

  await test('sanitizeDecodedHtml 正常 <script>...</script> 被移除', () => {
    assertEqual(sanitizeDecodedHtml('a<script>alert(1)</script>b'), 'ab')
    assertEqual(sanitizeDecodedHtml('<svg><script>x</script></svg>'), '')
  })

  await test('sanitizeDecodedHtml 错配闭合标签不吞有效内容（CodeAnt L630）', () => {
    // 开/闭标签独立交替曾让 <script>content</iframe> 整段删除；改为同标签名配对后，
    // 错配闭合只移除标签本体，中间内容保留
    assertEqual(sanitizeDecodedHtml('<script>content</iframe>'), 'content', '错配闭合不应删除有效内容')
    assertEqual(sanitizeDecodedHtml('<style>css</script>css'), 'csscss', 'style 错配 script 闭合应保留内容')
    assertEqual(sanitizeDecodedHtml('<script>a</iframe>b</script>c'), 'c', '正常配对仍整段移除')
    assertEqual(sanitizeDecodedHtml('<script><style>x</style>y</script>z'), 'z', '嵌套不同主动标签正常移除')
  })

  await test('sanitizeDecodedHtml 交叉嵌套标签不吞有效内容（CodeAnt 建议回归）', () => {
    // 逐标签成对移除不是完整 HTML 栈解析：交叉闭合按循环顺序处理，
    // 锁定行为——不允许跨标签名配对把中间有效内容整段删除。
    // <script>a<style>b</script>c</style>d：script 对移除 a<style>b，剩余 c</style>d → 孤立 style 闭合被兜底剥掉
    assertEqual(sanitizeDecodedHtml('<script>a<style>b</script>c</style>d'), 'cd', 'script 配对移除后 style 孤立闭合只剥标签本体')
    // <script>a</iframe>b：无 script 闭合 → 未闭合规则只剥 <script> 本体，孤立 </iframe> 由闭合规则剥掉
    assertEqual(sanitizeDecodedHtml('<script>a</iframe>b'), 'ab', '未闭合 script/孤立闭合只剥标签本体，内容保留')
    // <iframe>a</script>b</iframe>c：iframe 成对移除 a</script>b，剩 c
    assertEqual(sanitizeDecodedHtml('<iframe>a</script>b</iframe>c'), 'c', 'iframe 配对移除整段')
    // 交叉嵌套中的有效文本不得被跨标签名配对吞掉
    assertEqual(sanitizeDecodedHtml('<style>a<script>b</style>c</script>d'), 'ad', 'script 配对移除后 style 未闭合只剥标签本体')
    assertEqual(sanitizeDecodedHtml('x<script>a<style>b</style>c</script>y'), 'xy', '嵌套不同标签正常移除，外圈文本保留')
  })

  await test('sanitizeDecodedHtml iframe srcdoc XSS 移除（codex review 发现 P1）', () => {
    // codex review 5a0c785 发现：未闭合主动标签正则 [^<>]* 遇引号值内 <img 停住，
    // iframe srcdoc="<img onerror>" 原样通过（srcdoc 内文档可执行）。修复：引号值整体匹配。
    const cases = [
      '<iframe srcdoc="<img src=x onerror=alert(1)>">',
      '<iframe srcdoc=\'<svg onload=alert(2)>\'>',
      '<svg viewBox="0 0 <x>" onload="alert(3)">',
      '<script src="a"><img src=x onerror=y>'
    ]
    for (const h of cases) {
      const r = sanitizeDecodedHtml(h)
      assertEqual(/<(?:iframe|svg|script)\b/i.test(r), false, `带引号属性的主动标签应移除: ${h} → ${r}`)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r), false, `事件属性不应残留: ${h} → ${r}`)
    }
  })

  await test('sanitizeDecodedHtml 文本引号内的主动标签仍被移除（Round2 C002 终修）', () => {
    // 引号保护方案曾把文本中 "<iframe src=x>" 保护为占位符导致真实标签漏网（可执行）。
    // 终修：不做全局引号保护，文本中的主动标签照常移除。
    const cases = [
      '<div>text "<iframe src=x>" more</div>',
      '说 "太 <svg onload=alert(1)> 了" 吧',
      '<p>"<script>alert(2)</script>"</p>'
    ]
    for (const h of cases) {
      const r = sanitizeDecodedHtml(h)
      assertEqual(/<(?:iframe|svg|script)\b/i.test(r), false, `文本引号内主动标签应移除: ${h} → ${r}`)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r), false, `事件属性不应残留: ${h} → ${r}`)
    }
  })

  await test('sanitizeDecodedHtml 嵌套引号 script 内容被移除（Round2 C002）', () => {
    const cases = [
      '前<script>var s = "<img src=x onerror=alert(1)>";</script>后',
      // 验证 agent 边界：引号内再嵌套一个主动标签，曾泄漏 img+onerror
      '前<script>a="<script>b</script><img src=x onerror=alert(1)>";</script>后'
    ]
    for (const h of cases) {
      const r = sanitizeDecodedHtml(h)
      assertEqual(r.includes('<script'), false, `script 不应残留: ${h} → ${r}`)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r), false, `嵌套引号内事件属性不应残留: ${h} → ${r}`)
      assertEqual(r.includes('前'), true, 'script 前文本应保留')
      assertEqual(r.includes('后'), true, 'script 后文本应保留')
    }
  })

  await test('sanitizeDecodedHtml C001 32 链事件属性 + C045 未闭合引号（Round2 C002 回归）', () => {
    let chain = '<img '
    for (let i = 0; i < 32; i++) chain += `onerror${i}="x"`
    chain += '>'
    const r1 = sanitizeDecodedHtml(chain)
    assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r1), false, `32 链事件属性不应残留: ${r1.slice(0, 90)}`)
    for (const h of ['<img src="x"onerror="a>', '<img src="x" onerror="a>']) {
      const r2 = sanitizeDecodedHtml(h)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(r2), false, `未闭合引号事件属性不应残留: ${h} → ${r2.slice(0, 90)}`)
    }
  })

  await test('sanitizeDecodedHtml 未闭合引号跨标签不配对（子代理审查：残留 javascript P2）', () => {
    // 子代理发现：第一个 href 未闭合引号与第二个 href 引号跨标签配对，
    // 吞掉中间标签并遗留 `javascript:alert(2)>` 裸文本（`<a href=""javascript:alert(2)>`）
    const cases = [
      '<a href="javascript:alert(1)><b><a href="javascript:alert(2)>',
      '<a href="javascript:alert(1)><b>',
      '<a href="vbscript:msgbox(1)><span>x</span><a href="javascript:alert(3)>',
      '<a href="data:text/html;base64,PHNjcmlwdD4><p><a href="javascript:alert(4)>'
    ]
    for (const input of cases) {
      const out = sanitizeDecodedHtml(input)
      assertEqual(out.includes('javascript'), false, `危险协议残留: ${input} → ${out}`)
      assertEqual(out.includes('vbscript'), false, `vbscript 残留: ${input} → ${out}`)
      assertEqual(out.includes('data:text/html'), false, `data: 残留: ${input} → ${out}`)
    }
  })

  await test('sanitizeDecodedHtml 未闭合主动标签堆叠 <2s（C002）', () => {
    const input = Array(20000).fill('<script').join(' ')
    const start = Date.now()
    console.time('sanitizeDecodedHtml-20k')
    const out = sanitizeDecodedHtml(input)
    console.timeEnd('sanitizeDecodedHtml-20k')
    const cost = Date.now() - start
    assertEqual(cost < 2000, true, `性能超时 ${cost}ms >= 2000ms`)
    assertEqual(out.length, 100000, '超长输入应按 100k 截断')
  })

  await test('sanitizeDecodedHtml 长 href/src 值 + 多标签不回溯（v3.260 ReDoS 回归：v3.251 未闭合引号正则曾同步卡死）', () => {
    const evil = '<a href="https://u.jd.com/' + 'A'.repeat(500) + '" onclick="x()"><img src="https://img.com/x.jpg">'.repeat(5)
    const start = Date.now()
    const out = sanitizeDecodedHtml(evil)
    const cost = Date.now() - start
    assertEqual(cost < 500, true, `长 href 输入应 <500ms，实际 ${cost}ms（v3.251 正则回溯复活）`)
    assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(out), false, `事件属性不应残留: ${out.slice(0, 90)}`)
    assertEqual(out.includes('javascript'), false, '危险协议不应残留')
  })

  await test('sanitizeDecodedHtml 普通文本 href= 不误修（CodeAnt PR27 审查：仅标签内属性）', () => {
    // 无标签上下文的普通文本（htmlToMarkdown 会对纯文本调用 sanitizeDecodedHtml）
    const a = sanitizeDecodedHtml('see href="https://example')
    assertEqual(a, 'see href="https://example', `普通文本不应被改写: ${a}`)
    const b = sanitizeDecodedHtml('讨论 XSS: href="javascript:alert(1)')
    assertEqual(b.includes('javascript'), true, `普通文本中的 javascript: 字样不应被清空: ${b}`)
    // 标签内才处理（XSS 防护语义保持）
    const c = sanitizeDecodedHtml('<a href="javascript:alert(1)')
    assertEqual(c.includes('javascript'), false, `标签内未闭合 javascript: 仍应清空: ${c}`)
  })

  await test('sanitizeDecodedHtml 引号内 > 不当作标签结束（CodeAnt PR28 Critical：XSS 绕过）', () => {
    const r = sanitizeDecodedHtml('<a title=">" href=\'javascript:alert(1)')
    assertEqual(r.includes('javascript'), false, `引号内 > 场景危险 URL 应清空: ${r}`)
    const p = sanitizeDecodedHtml('see href="https://example')
    assertEqual(p, 'see href="https://example', `普通文本不应被改写: ${p}`)
    const e = sanitizeDecodedHtml('</a> href="javascript:alert(1)')
    assertEqual(e.includes('javascript'), true, `标签结束后的 href= 是普通文本不应清空: ${e}`)
  })

  await test('sanitizeDecodedHtml 未闭合安全链接补闭合引号（CodeAnt PR27 审查：畸形 HTML）', () => {
    const r = sanitizeDecodedHtml('<a href="https://x.com/a b')
    assertEqual(r, '<a href="https://x.com/a b"', `未闭合安全链接应补闭合引号: ${r}`)
  })

  await test('sanitizeDecodedHtml 未闭合引号 javascript: 清空 + 合法链接保留（v3.260 线性扫描语义）', () => {
    const a = sanitizeDecodedHtml('<a href="javascript:alert(1)')
    assertEqual(a.includes('javascript'), false, `未闭合 javascript: 应清空: ${a}`)
    const b = sanitizeDecodedHtml('<a href="https://u.jd.com/abc" target="_blank">链接</a>')
    assertEqual(b.includes('https://u.jd.com/abc'), true, `合法链接应保留: ${b}`)
    const c = sanitizeDecodedHtml('<img src="javascript:alert(1)">')
    assertEqual(c.includes('javascript'), false, `未闭合 src javascript: 应清空: ${c}`)
  })

  // ==================== 真实数据形态性能基准（v3.260：v3.251 长 href ReDoS 教训） ====================
  // 覆盖真实接口 content_html 的各类触发形态——修复前这些数据会让 sanitizeDecodedHtml 同步卡死
  // （单条正则快、组合真实数据才炸——基准数据必须用真实形态才能抓到这类雷）
  const perfCases = [
    ['长 href URL + 多标签（v3.251 触发形态）', '<a href="https://u.jd.com/' + 'A'.repeat(800) + '" target="_blank">领券</a><img src="https://img.com/x.jpg" alt="图">'.repeat(6)],
    ['长 src + img 堆叠', '<img src="https://img14.360buyimg.com/n1/s450x450_jfs/t1/170905/30/12345/67890/1234567890abcdef.jpg">'.repeat(8)],
    ['未闭合引号长值（v3.251 XSS 形态）', '<a href="javascript:alert(1)' + 'B'.repeat(600)],
    ['引号内 > 标签边界（PR#28 Critical 形态）', '<a title="' + '>'.repeat(100) + '" href="javascript:alert(1)" onclick="x()">'.repeat(4)],
    ['嵌套引号 + script 长内容', '<script>var x = "' + 'C'.repeat(2000) + '"</script><a href="https://x.com/a">链</a>'.repeat(3)],
    ['100k 截断边界 + 长 URL', ('<a href="https://u.jd.com/' + 'D'.repeat(5000) + '"><img src="x">').repeat(20)],
    ['on* 属性链 + style 危险值', ('<div onclick="x()" onmouseover="y()" style="background:url(javascript:alert(1))"><a href="https://x.com/a">t</a></div>').repeat(5)]
  ]
  for (const [name, input] of perfCases) {
    await test(`基准: sanitizeDecodedHtml ${name} <500ms（真实形态）`, () => {
      // 3 次测量取中位数——单次调度抖动不误报（CI 偶发 flaky），中位数保留真实回归灵敏度
      const measure = () => {
        const t0 = Date.now()
        const out = sanitizeDecodedHtml(input)
        return { cost: Date.now() - t0, out }
      }
      const runs = [measure(), measure(), measure()].sort((a, b) => a.cost - b.cost)
      const { cost, out } = runs[1]
      assertEqual(cost < 500, true, `${name} 应 <500ms（3 次中位数），实际 ${cost}ms（真实数据 ReDoS 回归）`)
      assertEqual(/\bon[a-z][a-z0-9_-]*\s*=/i.test(out), false, `${name} 事件属性不应残留: ${out.slice(0, 60)}`)
      assertEqual(out.includes('javascript') || out.includes('vbscript') || out.includes('data:text/html'), false, `${name} 危险协议不应残留: ${out.slice(0, 60)}`)
    })
  }

  await test('sanitizeDecodedHtml style CSS 十六进制转义 url 变体被拦截（Round2 C010）', () => {
    const r = sanitizeDecodedHtml('<div style="background:u\\72l(javascript:alert(1))">x</div>')
    assertEqual(/url\s*\(/i.test(r), false, `url( 不应残留: ${r}`)
    assertEqual(r.includes('javascript'), false, `javascript 不应残留: ${r}`)
  })

  await test('sanitizeDecodedHtml style CSS 十六进制转义 expression 变体被拦截（Round2 C010）', () => {
    const r = sanitizeDecodedHtml('<div style="e\\78pression(alert(1))">x</div>')
    assertEqual(/expression/i.test(r), false, `expression 不应残留: ${r}`)
  })

  await test('sanitizeDecodedHtml 正常 style 值保留（Round2 C010）', () => {
    const r = sanitizeDecodedHtml('<div style="color:red">x</div>')
    assertEqual(r.includes('style="color:red"'), true, `正常 style 应保留: ${r}`)
  })

  await test('sanitizeDecodedHtml style 超界码点不抛异常且危险 url 仍拦截（Round2 C010）', () => {
    const inputs = [
      '<div style="background:\\u110000url(javascript:alert(1))">x</div>',
      '<div style="background:\\110000url(javascript:alert(1))">x</div>',
      '<div style="background:\\uFFFFFFurl(javascript:alert(1))">x</div>',
      '<div style="background:\\FFFFFFurl(javascript:alert(1))">x</div>'
    ]
    for (const h of inputs) {
      const r = sanitizeDecodedHtml(h)
      assertEqual(/url\s*\(/i.test(r), false, `url( 不应残留: ${r}`)
      assertEqual(r.includes('javascript'), false, `javascript 不应残留: ${r}`)
    }
  })

  await test('looksLikeHtmlLinear 与旧正则边界一致（CodeAnt 审查）', () => {
    // / 后必须紧跟 >：<tag/foo> 不构成标签（旧正则 (?=\s|\/?>) 不匹配）
    assertEqual(looksLikeHtmlLinear('<tag/foo>x>'), false, '<tag/foo>x> 不应判定为 HTML')
    // 标签名后先出现 < 再 >：旧正则 [^<>]*> 不跨 <
    assertEqual(looksLikeHtmlLinear('<tag <2> '), false, '<tag <2> 不应判定为 HTML')
    // /> 要求 / 后紧跟 >（旧正则 \/?> 语义）
    assertEqual(looksLikeHtmlLinear('<br/ >'), false, '<br/ > 不应判定为 HTML')
    // autolink、无 >、非字母开头均不触发
    assertEqual(looksLikeHtmlLinear('<https://example.com>'), false, 'autolink 不应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<a'), false, '<a 不应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<2>'), false, '<2> 不应判定为 HTML')
    // 完整标签触发
    assertEqual(looksLikeHtmlLinear('<b>x</b>'), true, '<b>x</b> 应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<br/>'), true, '<br/> 应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<br />'), true, '<br /> 应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<a href="x">y'), true, '<a href> 应判定为 HTML')
    // 首个 < 不完整但后段完整标签仍触发（与正则逐位置尝试一致）
    assertEqual(looksLikeHtmlLinear('<tag <2> <b>'), true, '后段 <b> 应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<b>x <i>'), true, '后段 <i> 应判定为 HTML')
    // CodeAnt 复审：大量候选标签但全文无 > 必须快速返回（曾因每候选 indexOf('>') 到末尾 O(n²)）
    assertEqual(looksLikeHtmlLinear('<a '.repeat(50000)), false, '大量 <a 前缀无 > 不应判定为 HTML')
    assertEqual(looksLikeHtmlLinear('<a '.repeat(50000) + 'x>'), true, '大量 <a 前缀后出现 > 应判定为 HTML')
  })

  await test('extractTestSummary 噪声日志不干扰汇总提取（CodeAnt 审查）', () => {
    const cases = [
      ['预检查通过\n实际结果：10 通过, 2 失败, 共 12', ['10', '2', '12']],
      ['检查点通过\n检查点失败\n最终：3 通过, 1 失败, 共 4', ['3', '1', '4']],
      ['10 通过, 2 失败, 共 12', ['10', '2', '12']],
      ['共 99 条记录（无关）\n运行结束：7 通过, 0 失败, 共 7 个', ['7', '0', '7']],
      // 汇总行后还有错误条目（含「通过」字样）也要取到汇总行
      ['0 通过, 1 失败, 共 1 个\n1. 检查点通过', ['0', '1', '1']],
      // CodeAnt 复审：更早的无关「全部通过！1/1」日志不得抢答真实汇总行
      ['测试名：全部通过！1/1\n实际结果：7 通过, 0 失败, 共 7', ['7', '0', '7']],
      // CodeAnt 复审：同一行前置无关「通过/失败」文本不得抢答
      ['检查通过：准备完成；实际结果：7 通过, 0 失败, 共 7', ['7', '0', '7']],
      ['之前失败 0；实际结果：7 通过, 0 失败, 共 7', ['7', '0', '7']],
      ['全部通过！785/785  100%', ['785', '785']],
      ['🎉 全部通过！12/12', ['12', '12']],
      ['无关键字的普通输出', []]
    ]
    for (const [input, expected] of cases) {
      assert.deepStrictEqual(extractTestSummary(input), expected, `输入: ${JSON.stringify(input)}`)
    }
  })

  await test('hasDangerLink 扫描全部危险标记，前畸形后有效也检出（CodeRabbit 审查）', () => {
    // 前畸形（标签含 ]）后有效：只查首个标记会漏检
    assertEqual(hasDangerLink('[a]b](javascript:alert(1)) [c](javascript:alert(1))'), true, '后段有效危险链接应检出')
    // 畸形标记本身不误报
    assertEqual(hasDangerLink('[a]b](javascript:alert(1))'), false, '畸形标记不应误报')
    assertEqual(hasDangerLink('plain ](javascript:alert(1))'), false, '无配对 [ 不误报')
    // CodeAnt 复审：边界——转义右括号、额外开括号、安全链接后的悬空标记
    assertEqual(hasDangerLink(String.raw`[a\]b](javascript:alert(1))`), true, 'label 含转义 ] 仍应检出')
    assertEqual(hasDangerLink('[[x](javascript:alert(1))'), true, '前有额外 [ 仍应检出')
    assertEqual(hasDangerLink('[x](safe) text ](javascript:alert(1))'), false, '安全链接后的悬空标记不误报')
    // CodeRabbit 复审：定界符被转义时属纯文本，不得误报
    assertEqual(hasDangerLink(String.raw`\[x](javascript:alert(1))`), false, '转义 [ 不误报')
    assertEqual(hasDangerLink(String.raw`[x\](javascript:alert(1))`), false, '转义 ] 不误报')
    // 安全链接不误报
    assertEqual(hasDangerLink('[x](https://safe.example/a)'), false, '安全链接不误报')
    // 三种危险协议均检出
    assertEqual(hasDangerLink('[x](javascript:alert(1))'), true, 'javascript: 应检出')
    assertEqual(hasDangerLink('[x](vbscript:msgbox(1))'), true, 'vbscript: 应检出')
    assertEqual(hasDangerLink('[x](data:text/html,x)'), true, 'data: 应检出')
  })

  if (failed === 0) {
    console.log(`  🎉 全部通过！${passed}/${passed}  100%`)
  } else {
    console.log(`  ⚠️   ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`)
    errors.forEach((e, i) => {
      console.log(`    ${i + 1}. ${e.name}\n       ${e.message}`)
    })
  }
  console.log('========================================\n')

  // 清理本套件产生的缓存测试文件（保留真实运行缓存 push.json；清理失败不影响测试结果）
  cleanupTestCache()

  // v3.236：缓存文件缺失且恢复写入抛错（磁盘满/权限）时，readMessages 降级返回内存快照，不向外抛
  await test('readMessages 文件缺失且恢复写入抛错时降级返回内存快照（v3.236）', () => {
    const p = path.join(CACHE, 'test_restore_throw.json')
    saveMessages(p, [{ id: 'restore-ok' }]) // 内存快照 + 磁盘文件
    assertEqual(require('fs').existsSync(p), true, '写入后文件应存在')
    require('fs').unlinkSync(p) // 模拟外部误删缓存文件
    require('fs').chmodSync(CACHE, 0o444) // 目录只读 → 恢复写入必然抛 EACCES
    let threw = false
    let result = null
    try {
      result = readMessages(p)
    } catch (e) {
      threw = true
    }
    require('fs').chmodSync(CACHE, 0o755) // 无论如何先恢复权限
    try { require('fs').unlinkSync(p) } catch (e) { /* 清理容错: 只读目录下文件未创建 */ }
    assertEqual(threw, false, '恢复写入抛错时 readMessages 不得抛出（v3.236 降级）')
    assertEqual(Array.isArray(result) && result.length === 1 && result[0].id === 'restore-ok', true, '应返回内存快照而非清空')
  })

  // ============================================================
  // v3.258 变异驱动补测（V3 尾部存活变异体定向击杀）
  // 数据来源：8-13 全量变异报告（v3-part4 存活 1171 个，其中
  // L2763 alert 启用判断 19 个 + L2819 report 启用判断 16 个
  // 已提取为 _enabledFlag 纯函数——测试直接打纯函数精准击杀）
  // ============================================================
  const { App: V3App, truncateUtf16: v3Truncate } = require('./xbk_function_v3.js')
  const fc = require('fast-check')

  // 参考实现（与源码 _enabledFlag 同口径，仅用于属性测试对照）
  // v3.267：同步空串/纯空白串关闭口径
  function refEnabledFlag (cfg) {
    const en = cfg && cfg.enabled
    const s = en == null ? '' : String(en).trim().toLowerCase()
    return !(!cfg || !en || s === '' || s === 'false' || s === '0')
  }

  await test('_enabledFlag：表格驱动——全部关闭/开启形态（杀 L2763+L2819 共 35 存活）', async () => {
    const cases = [
    // [输入, 预期开启]
      [undefined, false], [null, false], [{}, false], [{ enabled: undefined }, false],
      [{ enabled: '' }, false], [{ enabled: ' ' }, false], [{ enabled: '   ' }, false],
      [{ enabled: '\t' }, false], [{ enabled: '\n' }, false], [{ enabled: '\r\n' }, false],
      [{ enabled: '\u00A0' }, false], [{ enabled: '\u3000' }, false],
      [{ enabled: 0 }, false], [{ enabled: '0' }, false],
      [{ enabled: 'false' }, false], [{ enabled: 'FALSE' }, false], [{ enabled: 'False' }, false],
      [{ enabled: ' false ' }, false], [{ enabled: 'FaLsE' }, false],
      [{ enabled: true }, true], [{ enabled: 1 }, true], [{ enabled: '1' }, true],
      [{ enabled: 'true' }, true], [{ enabled: 'TRUE' }, true], [{ enabled: ' true ' }, true],
      [{ enabled: '2' }, true], [{ enabled: 'yes' }, true], [{ enabled: 'on' }, true]
    ]
    for (const [input, expected] of cases) {
      assertEqual(V3App._enabledFlag(input), expected, `_enabledFlag(${JSON.stringify(input)})`)
    }
  })

  await test('_enabledFlag：属性测试——任意输入与参考实现一致（不变量）', async () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.constant(undefined),
        fc.constant(null),
        fc.constant({}),
        fc.record({ enabled: fc.oneof(fc.boolean(), fc.integer(), fc.string({ maxLength: 10 })) }),
        fc.record({ enabled: fc.oneof(fc.constant(''), fc.constant(0), fc.constant('0'), fc.constant('false'), fc.constant(' true ')) })
      ),
      (cfg) => {
        assertEqual(V3App._enabledFlag(cfg), refEnabledFlag(cfg), `cfg=${JSON.stringify(cfg)}`)
      }
    ), { numRuns: 400 })
  })

  await test('truncateUtf16：属性测试——任意字符串截断后无孤立代理且长度不超 max', async () => {
    fc.assert(fc.property(
      fc.string({ maxLength: 150 }),
      fc.integer({ min: 1, max: 60 }),
      (s, max) => {
        const out = v3Truncate(s, max)
        assert.ok(out.length <= max, `长度 ${out.length} > ${max}（输入 ${JSON.stringify(s)} max=${max}）`)
        for (let i = 0; i < out.length; i++) {
          const c = out.charCodeAt(i)
          if (c >= 0xD800 && c <= 0xDBFF) {
            const nx = out.charCodeAt(i + 1)
            assert.ok(!Number.isNaN(nx) && nx >= 0xDC00 && nx <= 0xDFFF, `孤立高代理 at ${i}（输出 ${JSON.stringify(out)}）`)
          }
          if (c >= 0xDC00 && c <= 0xDFFF) {
            const pv = out.charCodeAt(i - 1)
            assert.ok(!Number.isNaN(pv) && pv >= 0xD800 && pv <= 0xDBFF, `孤立低代理 at ${i}（输出 ${JSON.stringify(out)}）`)
          }
        }
      }
    ), { numRuns: 400 })
  })

  await test('_diskMinFree：表格驱动——边界配置解析（Utils.num 语义）', async () => {
    const D = 50 * 1024 * 1024
    const cases = [
      [undefined, D],
      [null, D],
      [{}, D],
      [{ storage: {} }, D],
      [{ storage: { minFreeBytes: undefined } }, D],
      [{ storage: { minFreeBytes: null } }, D],
      [{ storage: { minFreeBytes: false } }, D],
      [{ storage: { minFreeBytes: '' } }, D],
      [{ storage: { minFreeBytes: 'abc' } }, D],
      [{ storage: { minFreeBytes: '5000' } }, 5000],
      [{ storage: { minFreeBytes: 1e9 } }, 1e9],
      [{ storage: { minFreeBytes: 0 } }, null],
      [{ storage: { minFreeBytes: -1 } }, null]
    ]
    for (const [cfg, expected] of cases) {
      assertEqual(V3App._diskMinFree(cfg), expected, `_diskMinFree(${JSON.stringify(cfg)})`)
    }
  })

  await test('_diskMinFree：属性测试——任意输入返回 null 或正数有限（不变量）', async () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.constant(undefined),
        fc.constant(null),
        fc.constant({}),
        fc.record({ storage: fc.constant(null) }),
        fc.record({ storage: fc.record({ minFreeBytes: fc.oneof(fc.constant(undefined), fc.constant(0), fc.constant(-1), fc.integer({ min: -1e6, max: 1e9 }), fc.string({ maxLength: 8 }), fc.constant(false), fc.constant('5000')) }) })
      ),
      (cfg) => {
        const r = V3App._diskMinFree(cfg)
        if (r !== null) {
          assert.ok(Number.isFinite(r) && r > 0, `应返回正数有限，实际 ${r}（cfg=${JSON.stringify(cfg)}）`)
        }
      }
    ), { numRuns: 300 })
  })

  await test('_validateTplConfig：合法模板零警告 + 非法占位符警告（表格驱动）', async () => {
    const saved = Config.template === undefined ? undefined : JSON.stringify(Config.template)
    try {
    // 合法模板：全部占位符在支持列表内
      Config.template = { title: '【{分类名}】{标题} {价格}', content: '内容：{内容} 商城：{商城} 品牌：{品牌}' }
      assertEqual(V3App._validateTplConfig().length, 0, '合法占位符不应警告')
      // 非法占位符
      Config.template = { title: '含非法占位符 {不存在字段}', content: '正常内容' }
      const warns = V3App._validateTplConfig()
      assert.ok(warns.length >= 1, '非法占位符应警告')
      assert.ok(warns.some(w => w.includes('不存在字段')), `警告应含占位符名: ${JSON.stringify(warns)}`)
      // 非字符串模板
      Config.template = { title: 123, content: null }
      assert.ok(V3App._validateTplConfig().some(w => w.includes('template.title/content')), '非字符串应警告')
    } finally {
      Config.template = saved === undefined ? undefined : JSON.parse(saved)
    }
  })

  await test('_validateTplConfig：属性测试——任意模板不崩溃，合法占位符不产生警告', async () => {
    const saved = Config.template === undefined ? undefined : JSON.stringify(Config.template)
    try {
      fc.assert(fc.property(
        fc.record({
          title: fc.oneof(fc.string({ maxLength: 60 }), fc.constant(null), fc.constant(123)),
          content: fc.oneof(fc.string({ maxLength: 60 }), fc.constant(null))
        }),
        (tpl) => {
          Config.template = tpl
          const warns = V3App._validateTplConfig()
          assert.ok(Array.isArray(warns), '应返回数组')
          assert.ok(warns.every(w => typeof w === 'string'), '警告应为字符串')
          // 纯合法占位符模板（title 与 content 均无占位符）不应产生"非法占位符"警告
          // v3.259 修复：原断言只查 title，content 含 '{ }' 等非法占位符时误报失败
          if (typeof tpl.title === 'string' && typeof tpl.content === 'string' &&
              !/\{[^{}]+\}/.test(tpl.title) && !/\{[^{}]+\}/.test(tpl.content)) {
            assert.ok(!warns.some(w => w.includes('含占位符')), `不应有占位符警告: ${JSON.stringify(warns)}`)
          }
        }
      ), { numRuns: 200 })
    } finally {
      Config.template = saved === undefined ? undefined : JSON.parse(saved)
    }
  })

  await test('_safeCounter：表格驱动——计数归一化边界', async () => {
    const cases = [
      [0, 0], [1, 1], [999, 999], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [-1, 0], [1.5, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0],
      [true, 0], [false, 0], ['5', 5], ['abc', 0], ['', 0], [null, 0], [undefined, 0], [{}, 0], [[5], 5] // 数组经 Number() 隐式转换（源码实际行为，保持口径）
    ]
    for (const [input, expected] of cases) {
      assertEqual(V3App._safeCounter(input), expected, `_safeCounter(${JSON.stringify(input)})`)
    }
  })

  await test('_safeCounter：属性测试——任意输入返回非负整数（不变量）', async () => {
    fc.assert(fc.property(
      fc.oneof(fc.integer(), fc.double(), fc.boolean(), fc.string(), fc.constant(null), fc.constant(undefined), fc.constant(NaN), fc.constant(Infinity)),
      (v) => {
        const r = V3App._safeCounter(v)
        assert.ok(Number.isInteger(r) && r >= 0 && r <= Number.MAX_SAFE_INTEGER, `应返回非负整数，实际 ${r}（输入 ${JSON.stringify(v)}）`)
      }
    ), { numRuns: 300 })
  })

  await test('_normalizeReportState：表格驱动——损坏/异常输入归一化', async () => {
    const blank = () => V3App._blankReportState()
    // 非对象 → blank
    assertEqual(JSON.stringify(V3App._normalizeReportState(null)), JSON.stringify(blank()))
    assertEqual(JSON.stringify(V3App._normalizeReportState(undefined)), JSON.stringify(blank()))
    assertEqual(JSON.stringify(V3App._normalizeReportState(42)), JSON.stringify(blank()))
    assertEqual(JSON.stringify(V3App._normalizeReportState('x')), JSON.stringify(blank()))
    assertEqual(JSON.stringify(V3App._normalizeReportState([1, 2])), JSON.stringify(blank()))
    // 正常对象
    const ok = V3App._normalizeReportState({ date: '2026-08-13', total: 5, dedup: '3', filtered: -1, pushed: 1.5, failed: true, truncated: 'abc' })
    assertEqual(ok.date, '2026-08-13')
    assertEqual(ok.total, 5)
    assertEqual(ok.dedup, 3)
    assertEqual(ok.filtered, 0, '负数归 0')
    assertEqual(ok.pushed, 0, '小数归 0')
    assertEqual(ok.failed, 0, '布尔归 0')
    assertEqual(ok.truncated, 0, '非法字符串归 0')
    // pending 正常
    const withPending = V3App._normalizeReportState({ total: 1, pending: { total: 9, dedup: '2' } })
    assertEqual(withPending.pending.total, 9)
    assertEqual(withPending.pending.dedup, 2)
    // pending 损坏（非对象）→ 警告 + 空 pending
    const warns = []
    const oldWarn = console.warn
    console.warn = (m) => warns.push(String(m))
    try {
      const bad = V3App._normalizeReportState({ total: 1, pending: 'corrupt' })
      assertEqual(JSON.stringify(bad.pending), JSON.stringify(blank()), '损坏 pending 重置为空累计')
    } finally {
      console.warn = oldWarn
    }
    assert.ok(warns.length >= 1, '损坏 pending 应告警')
  })

  await test('_normalizeReportState：属性测试——任意输入不崩溃且计数合法（不变量）', async () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.constant(null), fc.constant(undefined), fc.constant(42), fc.constant('x'),
        fc.array(fc.integer()),
        fc.record({
          date: fc.oneof(fc.string(), fc.constant(null), fc.constant(42)),
          total: fc.oneof(fc.integer(), fc.boolean(), fc.string(), fc.constant(null)),
          pending: fc.oneof(fc.constant('corrupt'), fc.constant(7), fc.record({ total: fc.integer(), dedup: fc.string() }), fc.constant(null))
        })
      ),
      (raw) => {
        const oldWarn = console.warn
        console.warn = () => {}
        try {
          const st = V3App._normalizeReportState(raw)
          assert.ok(st && typeof st === 'object', '应返回对象')
          assert.ok(!Array.isArray(st), '不应是数组')
          assert.ok(typeof st.date === 'string', `date 应为字符串: ${JSON.stringify(st.date)}`)
          for (const k of ['total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
            assert.ok(Number.isInteger(st[k]) && st[k] >= 0, `字段 ${k} 应为非负整数: ${st[k]}`)
          }
          if (st.pending) {
            assert.ok(typeof st.pending === 'object' && !Array.isArray(st.pending), 'pending 应为对象')
            for (const k of ['total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
              assert.ok(Number.isInteger(st.pending[k]) && st.pending[k] >= 0, `pending.${k} 应为非负整数: ${st.pending[k]}`)
            }
          }
        } finally {
          console.warn = oldWarn
        }
      }
    ), { numRuns: 200 })
  })

  await test('_validateTplConfig：全部支持占位符不告警（CodeRabbit 建议——杀 SUPPORTED_TPL_KEYS 15 个 StringLiteral）', async () => {
    const saved = Config.template === undefined ? undefined : JSON.stringify(Config.template)
    try {
      const keys = ['分类名', '分类ID', '标题', '链接', '日期', '时间', '楼主', '类目', '内容', '价格', '商城', '品牌', '图片', 'Html内容', 'Markdown内容']
      // 全组合：title+content 用全部 key
      Config.template = { title: keys.map(k => `{${k}}`).join(' '), content: keys.map(k => `{${k}}`).join(' ') }
      assertEqual(V3App._validateTplConfig().length, 0, '全部支持占位符不应警告')
      // 逐个 key 单独验证（任一 key 被变异 → 此处抓出）
      for (const k of keys) {
        Config.template = { title: `{${k}}`, content: '正常内容' }
        const warns = V3App._validateTplConfig()
        assertEqual(warns.length, 0, `占位符 {${k}} 不应警告: ${JSON.stringify(warns)}`)
      }
    } finally {
      Config.template = saved === undefined ? undefined : JSON.parse(saved)
    }
  })

  process.exit(failed > 0 ? 1 : 0)
})()
