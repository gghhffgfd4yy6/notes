'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const nodeCrypto = require('crypto')
const { readStatus, formatStatus, readMessages, readMessageCount, readMergedRawMessages } = require('./scripts/status')
const { createMessageStore } = require('./xbk_message_store')
const { createUtils } = require('./xbk_utils')
const storage = require('./xbk_storage')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-status-'))
const previousCwd = process.cwd()

function writeRunLog (value) { fs.writeFileSync('run.log', value) }
function writeReport (value) { fs.writeFileSync('report.state', value) }
function writeChannels (value) { fs.writeFileSync('channel-health.state', value) }
function writeDiagnostics (value) { fs.writeFileSync('filter-diagnostics.ndjson', value) }

try {
  process.chdir(dir)
  writeRunLog('2026-09-05 10:00:00 total=8 dedup=2 filtered=3 truncated=1 pushed=2 failed=1 elapsed=1.2s\n')
  writeReport(JSON.stringify({ date: '2026-09-05', runs: 4, total: 20, dedup: 5, filtered: 7, pushed: 6, failed: 1, truncated: 2 }))
  writeChannels(JSON.stringify({ pushplus: { consecutiveFailures: 2, lastFailureAt: 1000, lastAlertAt: 0 }, bark: { consecutiveFailures: 0, lastFailureAt: 0, lastAlertAt: 0 } }))
  writeDiagnostics([
    JSON.stringify({ type: 'run', at: '2026-09-05 10:00:00', total: 8, dedup: 2, filtered: 3, passed: 2, byReason: { title: 2, category: 1 }, detailCount: 3 }),
    JSON.stringify({ type: 'item', id: 'x' })
  ].join('\n') + '\n')

  const status = readStatus('.', { now: 2000 })
  assert.strictEqual(status.report.value.runs, 4)
  assert.strictEqual(status.report.value.pushed, 6)
  assert.strictEqual(status.channels.value.pushplus.consecutiveFailures, 2)
  assert.deepStrictEqual(status.diagnostics.value.byReason, { title: 2, category: 1 })
  assert.strictEqual(status.run.value.total, 8)
  assert.strictEqual(status.run.value.failed, 1)
  // v3.307 首屏统计：与 run.log 同源，今天=2026-09-05（上海），成功率=pushed/(pushed+failed)
  const stats = readStatus('.', { now: Date.UTC(2026, 8, 5, 2, 0, 0) }).stats
  assert.strictEqual(stats.status, 'ok')
  assert.deepStrictEqual(stats.value.today, {
    date: '2026-09-05', rounds: 1, total: 8, pushed: 2, failed: 1, successRate: 2 / 3
  })
  assert.strictEqual(stats.value.week.rounds, 1)
  assert.strictEqual(stats.value.lastFailure.date, '2026-09-05')
  assert.strictEqual(stats.value.lastFailure.failed, 1)

  // 7 天窗口：09-05 当天 + 09-04 计入，08-29（第 8 天）不计入；dry-run 轮次计入轮次但不计推送。
  writeRunLog([
    '2026-09-05 10:00:00 total=8 dedup=2 filtered=3 truncated=1 pushed=2 failed=1 elapsed=1.2s',
    '2026-09-04 23:00:00 total=10 dedup=0 filtered=0 truncated=0 pushed=10 failed=0 elapsed=2.0s',
    '2026-09-04 12:00:00 total=5 dedup=0 filtered=0 truncated=0 pushed=0 failed=0 elapsed=1.0s dry-run未推送=3',
    '2026-08-29 10:00:00 total=5 dedup=0 filtered=0 truncated=0 pushed=5 failed=0 elapsed=1.0s'
  ].join('\n') + '\n')
  const weekStats = readStatus('.', { now: Date.UTC(2026, 8, 5, 2, 0, 0) }).stats.value
  assert.strictEqual(weekStats.week.from, '2026-08-30', '窗口起点=今天-6 天')
  assert.strictEqual(weekStats.week.rounds, 3, '窗口外 08-29 不计入')
  assert.strictEqual(weekStats.week.pushed, 12)
  assert.strictEqual(weekStats.week.failed, 1)
  assert.strictEqual(weekStats.today.rounds, 1, '今天只算 09-05 一轮')
  writeRunLog('2026-09-05 10:00:00 total=8 dedup=2 filtered=3 truncated=1 pushed=2 failed=1 elapsed=1.2s\n')
  const output = formatStatus(status)
  assert.match(output, /运行状态/)
  assert.match(output, /推送成功：6 条/)
  assert.match(output, /pushplus：连续失败 2 次/)
  assert.match(output, /title=2/)

  writeReport('{broken')
  fs.unlinkSync('channel-health.state')
  const degraded = readStatus('.', { now: 2000 })
  assert.strictEqual(degraded.report.status, 'invalid')
  assert.strictEqual(degraded.channels.status, 'missing')
  assert.match(formatStatus(degraded), /日报：不可读（invalid）/, 'report 损坏必须在输出中体现为「不可读（invalid）」')
  assert.match(formatStatus(degraded), /通道健康：缺失/, '通道文件缺失必须在输出中体现为「缺失」')

  // `{}`（无 date、无计数）在生产侧 _loadReportState 里是**合法**的空累计状态（_normalizeReportState
  // 归一化为 blank：date→''、计数→0），故 --status 也必须显示正常。此前这里断言 invalid，
  // 与生产口径冲突（CodeRabbit PR #147 指出 date 缺失同样应被接受）——修的是断言，不是放宽整个校验。
  writeReport('{}')
  writeChannels(JSON.stringify({ pushplus: { consecutiveFailures: 'two' } }))
  writeDiagnostics(JSON.stringify({ type: 'run' }) + '\n')
  const blankState = readStatus('.')
  assert.strictEqual(blankState.report.status, 'ok', '{} 是合法空累计状态，应与生产 _loadReportState 同口径')
  assert.strictEqual(blankState.channels.status, 'invalid', '通道失败次数必须是非负整数')
  assert.strictEqual(blankState.diagnostics.status, 'invalid', '过滤汇总必须带计数对象')

  // 真正非法的 report.state 仍必须判 invalid（证明不是把校验整段放开）：
  // ① 计数为负 —— 生产侧同样判非法；② date 存在但类型错误。
  writeReport(JSON.stringify({ runs: -1 }))
  assert.strictEqual(readStatus('.').report.status, 'invalid', '负计数 report.state 必须判非法')
  writeReport(JSON.stringify({ date: 123, runs: 1 }))
  assert.strictEqual(readStatus('.').report.status, 'invalid', 'date 存在但非字符串必须判非法')

  fs.unlinkSync('run.log')
  fs.symlinkSync('/etc/passwd', 'run.log')
  assert.strictEqual(readStatus('.').run.status, 'unsafe', '符号链接必须拒绝读取')

  // ── P1（v3.412）：判重缓存改为「push.json 快照 + journal 增量」后，读路径必须能看见未合并条目 ──
  fs.unlinkSync('run.log') // 清掉上面的符号链接，后面不再用 run.log
  const cacheDir = path.join(dir, 'cache-journal')
  fs.mkdirSync(cacheDir)
  const cachePath = path.join(cacheDir, 'push.json')
  const journalPath = path.join(cacheDir, 'push.json.journal.ndjson')
  fs.writeFileSync(cachePath, JSON.stringify([{ id: 's1', title: '旧标题', timestamp: 't1' }]))
  fs.appendFileSync(journalPath, JSON.stringify({
    v: 1,
    at: 1,
    put: [{ id: 's1', title: '新标题', timestamp: 't2' }, { id: 's2', title: '新增条', timestamp: 't3' }]
  }) + '\n')
  const oldStamp = new Date(Date.now() - 60000)
  fs.utimesSync(cachePath, oldStamp, oldStamp)
  fs.utimesSync(journalPath, oldStamp, oldStamp)

  const mergedRead = readMessages(cacheDir, { cache: false })
  assert.strictEqual(mergedRead.status, 'ok')
  assert.strictEqual(mergedRead.value.total, 2, 'journal 未合并条目必须计入推送记录')
  assert.strictEqual(mergedRead.value.items.find(i => i.id === 's1').title, '新标题', 'journal 的更新必须覆盖快照内容')
  assert.strictEqual(readMessageCount(cacheDir).count, 2, 'readMessageCount 必须与 readMessages 同源（含 journal）')

  // 缓存失效：push.json 一字未动、只有 journal 追加 —— 签名必须变化，否则控制台 60s 内读旧数据
  assert.strictEqual(readMessages(cacheDir).value.total, 2)
  fs.appendFileSync(journalPath, JSON.stringify({ v: 1, at: 2, put: [{ id: 's3', title: '第三条', timestamp: 't4' }] }) + '\n')
  fs.utimesSync(journalPath, oldStamp, oldStamp)
  assert.strictEqual(readMessages(cacheDir).value.total, 3, 'journal 变化后缓存必须失效并读到新条目')

  // journal 不可读（目录占位）⇒ 整体按不可读返回，绝不拿旧快照冒充完整数据
  fs.unlinkSync(journalPath)
  fs.mkdirSync(journalPath)
  assert.strictEqual(readMessages(cacheDir, { cache: false }).status, 'unsafe', 'journal 读失败必须如实报不可读')
  fs.rmdirSync(journalPath)

  // ── P1（F4）：日志行带 drop 时，控制台/导出必须与运行侧 readMessages 逐条一致 ──
  // 背景：journal 每行 = 本批 put + 本批被头裁剪的 drop。只回放 put 会让「本批写入但同批就被裁掉」
  // 的条目从日志里复活——运行侧（MessageStore，逐行「先写后裁」）读出 c,d，控制台却报 a,b,c,d，
  // 备份导出同样带回已裁条目，缓存健康页据此误报 nearTrim/overLimit。
  // 夹具：maxSize=2、JOURNAL_DIRECT_MAX_BYTES=0（强制纯日志，快照保持 []），两批写入第二条日志行带 drop。
  const dropDir = path.join(dir, 'cache-drop')
  fs.mkdirSync(dropDir)
  const prevCacheEnv = process.env.XBK_CACHE_DIR
  process.env.XBK_CACHE_DIR = dropDir
  try {
    const storeUtils = createUtils({ fs, safeRe: (src, flags) => new RegExp(src, flags) })
    const makeStore = () => createMessageStore({
      Config: { cache: { maxSize: 2 } },
      Utils: storeUtils,
      fs,
      path,
      crypto: nodeCrypto,
      normalize: (o) => o,
      storage,
      constants: {
        DEFAULT_MAX_SIZE: 2,
        MESSAGE_CACHE_MAX_BYTES: 64 * 1024 * 1024,
        TOMBSTONE_MAX_KEYS: 64,
        TOMBSTONE_MAX_BYTES: 8 * 1024 * 1024,
        TOMBSTONE_LOCK_STALE_MS: 10000,
        JOURNAL_DIRECT_MAX_BYTES: 0
      }
    })
    const entry = (id) => ({ id, title: `标题-${id}`, content: `正文-${id}`, url: `https://example.test/${id}`, shijianchuo: 1760000000 })
    const writer = makeStore()
    writer.saveBatch([entry('a'), entry('b')], 'push.json')
    writer.saveBatch([entry('c'), entry('d')], 'push.json')

    // 前提断言：快照必须为空、且日志最后一行真的带 drop（否则本用例根本没走到「同批裁剪」这条路径，
    // 修与不修都会绿——这是本回归唯一的防假绿手段）。
    const dropFile = path.join(dropDir, 'push.json')
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(dropFile, 'utf8')), [], '前提：快照必须为空（纯日志档）')
    const dropLines = fs.readFileSync(dropFile + '.journal.ndjson', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const droppedIds = dropLines.flatMap((r) => (r.drop || []).map((m) => m.id))
    assert.deepStrictEqual(droppedIds, ['a', 'b'], '前提：第二条日志行必须记下被裁掉的 a,b')

    // 运行侧读的是「冷」实例：只能靠快照 + 日志重建，不能拿写端内存数组冒充磁盘口径。
    const reader = makeStore()
    const storeIds = reader.readMessages(reader.getFilePath('push.json')).map((m) => m.id)
    assert.deepStrictEqual(storeIds, ['c', 'd'], '运行侧回放按 drop 收敛后只应剩 c,d')

    const statusRead = readMessages(dropDir, { cache: false })
    assert.strictEqual(statusRead.status, 'ok')
    assert.deepStrictEqual(statusRead.value.items.map((m) => m.id), storeIds, '控制台条目必须与运行侧 readMessages 逐条一致')
    assert.strictEqual(statusRead.value.total, storeIds.length, '控制台 total 必须等于运行侧条数')
    assert.deepStrictEqual(statusRead.value.keys, storeIds, '控制台行键与条目同序（前端展开状态依赖它）')
    const count = readMessageCount(dropDir)
    assert.strictEqual(count.count, storeIds.length, 'readMessageCount 必须与运行侧条数一致（缓存健康页的 nearTrim/overLimit 判据）')
    assert.strictEqual(count.filteredCount, 0)
    // 备份导出（readMergedRawMessages）走同一个 mergeJournalEntries：不得带回已裁条目。
    const exported = readMergedRawMessages(dropDir)
    assert.strictEqual(exported.status, 'ok')
    assert.deepStrictEqual(exported.items.map((m) => m.id), storeIds, '备份导出不得包含日志里已裁掉的条目')
  } finally {
    if (prevCacheEnv === undefined) delete process.env.XBK_CACHE_DIR
    else process.env.XBK_CACHE_DIR = prevCacheEnv
  }

  // ── M1：pushUrl → 缓存文件名只允许一份实现（控制台/--status 读的必须就是运行侧写的那份）──
  // 生产 MessageStore.getFileName 带撞名诊断（会往缓存目录写 push-sources.json），故用临时目录
  // 顶掉 XBK_CACHE_DIR 建一个真 store 对拍；控制台侧的同表对拍在 test_console.js（三方逐字比对）。
  {
    const { messagesFileName } = require('./scripts/status')
    const nameDir = path.join(dir, 'cache-name')
    fs.mkdirSync(nameDir)
    const prevCacheEnv = process.env.XBK_CACHE_DIR
    process.env.XBK_CACHE_DIR = nameDir
    try {
      const prodStore = createMessageStore({
        Config: { cache: { maxSize: 10 } },
        Utils: createUtils({ fs, safeRe: (src, flags) => new RegExp(src, flags) }),
        fs,
        path,
        crypto: nodeCrypto,
        normalize: (o) => o,
        storage,
        constants: {}
      })
      const urls = [
        'https://new.ixbk.net/plus/json/push.json', // 默认部署
        'https://x/custom-push.json', // 自定义 pushUrl ①
        'https://x/data/line-reports', // 自定义 pushUrl ②
        'https://x/default.json',
        'https://x/a.json?foo=bar#frag',
        'https://x/path/',
        'https://x/..',
        'https://x/.hidden',
        'https://x/url_',
        'https://x/a:b*c?.json',
        'https://x/a\u0001b.json',
        '',
        undefined,
        null,
        true,
        123
      ]
      // 同一组 URL 会撞出重复的 default.json（'https://x/path/' 与 'https://x/default.json'），
      // getFileName 的撞名诊断会打印告警——那是它的职责，这里只需要文件名，静音即可。
      const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn() } finally { console.warn = w } }
      for (const url of urls) {
        assert.strictEqual(messagesFileName(url), quiet(() => prodStore.getFileName(url)),
          `--status 派生必须与运行侧 getFileName 逐字相同：${typeof url}:${String(url)}`)
      }
    } finally {
      if (prevCacheEnv === undefined) delete process.env.XBK_CACHE_DIR
      else process.env.XBK_CACHE_DIR = prevCacheEnv
    }
    // 读取侧仍只认纯文件名（traversal 防护没被这次重构带走）：filename 带目录成分时整形回 basename。
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 'only', title: '标题' }]))
    const guarded = readMessages(dir, { cache: false, filename: '../push.json' })
    assert.strictEqual(guarded.status, 'ok', '带目录成分的 filename 必须整形为纯文件名后再读')
    assert.strictEqual(guarded.value.total, 1)
  }

  console.log('✅ --status 聚合并展示运行状态，损坏/缺失/符号链接文件安全降级；journal 未合并条目可读且缓存随日志失效，drop 行与运行侧条数一致')
} finally {
  process.chdir(previousCwd)
  fs.rmSync(dir, { recursive: true, force: true })
}
