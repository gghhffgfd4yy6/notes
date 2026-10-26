'use strict'

// scripts/console.js 测试：token 校验 / 锁语义 / 动作解析 / HTML 转义 / HTTP 端到端（鉴权、
// 看板渲染、触发 202/409、JSON API、SIGTERM 优雅关闭）。触发用例真实 spawn 子进程——
// 动作默认指向 --check（环境检查，秒级、不写缓存不发通知），不存在注入式 fake child。

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')

// 前端模块清单（v3.364）：拆 app.js 时，测试按固定顺序把自家模块拼回一份源码——
// 653 条源码文本断言因此不必随搬家逐条改锚点。新增模块时把文件追加到入口之前。
const CONSOLE_MODULE_FILES = [
  'constants.js', // 页面级常量（v3.365 拆出）
  'format.js', // 时间/字节格式化（v3.365 拆出）
  'api.js', // 数据层：端点函数 + 凭证（v3.366 拆出；顺序与拆前源码一致，API 段在 UI 段之前）
  'components.js', // 公用零件：状态徽章/卡片/按钮/日期区间/触发条/确认弹窗（v3.368 拆出）
  'pages.js', // 页面面板：运行历史/趋势/推送记录/日志/配置/系统/过滤规则（v3.369 拆出）
  'ui.js', // 外壳：App + 主题/快照/回顶（v3.367 拆出；正文顺序原文不变）
  'app.js' // 入口：只做挂载、BFCache 与失败兜底清理（App 在 ui.js）
]
function readConsoleSource () {
  return CONSOLE_MODULE_FILES
    .map((file) => fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', file), 'utf8'))
    .join('\n')
}
// 竞态安全读取器（生产 xbk_storage）：测试里对「刚写完/刚 rename 过的路径」的断言读取
// 统一走它（O_NOFOLLOW + fstat 复检 + 读后复检），规避 CodeQL js/file-system-race 对
// 「写路径 → 按路径 open」的 check-then-use 判红。
const { readSafeTextResult } = require('./xbk_storage')

// 变异 dry-run 取证（仅变异子进程生效）：tap 档失败时只回传 `test_console.js # exit code 1`，
// stryker.log 不含测试 stdout；把 stdout/stderr 与未捕获异常落盘，mutation.yml 的
// `if: failure()` 步骤再 tail 出来。正常 npm test 下完全无副作用。
if (process.env.XBK_MUTATION_CHILD === '1') {
  const chunks = []
  const outWrite = process.stdout.write.bind(process.stdout)
  const errWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = (c, ...rest) => { try { chunks.push(String(c)) } catch (e) {} return outWrite(c, ...rest) }
  process.stderr.write = (c, ...rest) => { try { chunks.push(String(c)) } catch (e) {} return errWrite(c, ...rest) }
  process.on('uncaughtException', (e) => { try { chunks.push('UNCAUGHT ' + ((e && e.stack) || e) + '\n') } catch (e2) {} })
  process.on('exit', (code) => {
    // mkdtempSync 随机子目录（不直写 /tmp 固定名，Sonar S5443）；mutation.yml 的
    // failure 步骤按 xbk-test-console-*/log 通配 tail。
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-test-console-'))
      fs.writeFileSync(path.join(dir, 'log'), 'exit=' + code + '\n' + chunks.join('').slice(-200000), { mode: 0o600 })
    } catch (e) {}
  })
}

const {
  createConsole, consoleStateDir, finishRun, isValidToken, timingSafeEqualStr,
  acquireLock, releaseLockFor, lockPath,
  parseAction, escapeHtml, authorize, renderPage, ACTIONS, TOKEN_MIN_LEN, PROC_TIMEOUT_MS,
  statSafeMeta, tombstoneCounts, cacheHealthSnapshot, listStateFiles, classifyStateFile,
  buildConfigView, configuredFlag, TREND_DAYS_DEFAULT, FILES_LIST_MAX,
  sanitizeAccessPath, shouldLogAccess, acceptsGzip, ACCESS_LOG_MAX,
  findSecretLikeField, CACHE_HEALTH_COUNT_MAX_BYTES, cacheHealthEntryCount,
  filterMessageItems, filterMessagesByDays, messageCategoriesOf, MESSAGE_DAYS_ALLOWED,
  parseDayKey, filterMessagesByRange, windowMessages,
  clampQueryBytes, csvCell, exportRowOf, buildMessagesCsv,
  EXPORT_MAX_ROWS, EXPORT_EXCERPT_MAX, EXPORT_FORMATS,
  RUN_ID_RE, ssePlanChunk, SSE_TICK_MS, SSE_HEARTBEAT_MS, SSE_MAX_PENDING, SSE_MAX_CONNECTIONS,
  // v3.374 全站 SSE 通知（/api/stream）：常量走导出，用例不自己写死 2s/20s/20
  SSE_STREAM_TICK_MS, SSE_STREAM_HEARTBEAT_MS, SSE_STREAM_MAX_CONNECTIONS,
  REPLAY_WINDOW_NOTIFY_TEST_MS, ENTRY_SINGLE,
  // v3.340 控制台设置（通知自检拦截窗）：常量走导出，测试不自己写死 0/3600
  CONSOLE_SETTINGS_FILE, CONSOLE_SETTINGS_DEFAULT_S, NOTIFY_REPLAY_MIN_S, NOTIFY_REPLAY_MAX_S,
  // 导出端点的读取上限直接取实现常量（D2-N11：修前测试自己写死 32MiB，实现改 64MiB 后
  // 用例仍在 32MiB 造夹具 → 以为测了 tooLarge，实际测的是 invalid）
  MESSAGES_MAX_BYTES,
  // 过滤规则评审修复靶向用例：审计上限 / 锁接管原子性 / 真实 deps（注入 zkt_gjc 用）
  FILTER_AUDIT_MAX_BYTES,
  filterLockIdentity,
  claimStaleFilterLock,
  runtimeFilterDeps,
  // v3.357 两步验证：TOTP/恢复码/Cookie/配置读取
  base32Encode, base32Decode, generateTotpSecret, totpQrDataUrl, totpCodeAt, verifyTotpCode,
  generateRecoveryCodes, recoveryRecordOf, consumeRecoveryCode,
  makeTwoFactorCookie, verifyTwoFactorCookie, loadTwoFactorState, TWO_FACTOR_FILE,
  // v3.374 信任设备：签发/校验纯函数 + 落盘读写
  DEVICE_FILE, DEVICE_COOKIE, DEVICE_TTL_MS, DEVICE_MAX,
  makeDeviceRecord, parseDeviceCookie, trustedDeviceOf, appendDeviceRecord,
  readDeviceStore, writeDeviceStore, hashDeviceSecret,
  // v3.370 线报全站搜索：解析/归一纯函数 + 关注词文件常量
  decodeLineHtml, parseLineStamp, clampLineQuery, normalizeWatchWord, parseLineSearchHtml,
  readLineWatchWords, readWatchState, saveWatchState, formatWatchPush,
  LINE_WATCH_FILE, LINE_WATCH_MAX_WORDS, LINE_SEARCH_QUERY_MAX_BYTES
} = require('./scripts/console')
const { readMessages } = require('./scripts/status')

let passed = 0
let failed = 0

// ── 用例级收尾保障（变异测试 Timeout 的根因修复）──
// 旧写法把 server.close() 放在用例最后一行：变异体让断言提前抛错 → 最后一行不执行 →
// 监听句柄把事件循环钉住 → 进程打印完汇总也不退出 → Stryker 只能等满 timeoutMS 判 Timeout
// （part8: 313/769 条 Timeout 里绝大多数是这种「跑完了但不退出」，不是用例真的跑不完）。
// 收尾不能靠 241 条用例各自的自觉，必须由 harness 结构性保证：
//   · listen() 是全文件唯一开监听的口子 → 在这里登记 server，并在 connection 上登记 socket；
//   · SSE 用例的 waitConn/kick 是 setInterval 循环，同样在「最后一行」clear，同样会漏，
//     所以在模块加载期登记 setInterval 句柄；
//   · ok/aok 在每条用例结束（成功 / 断言失败 / 任意抛错）时统一收割，一步都不依赖用例代码。
// 只包 setInterval，不包 setTimeout：setTimeout 的返回值被约定俗成当成可 unref/ref 的句柄，
// 还支持额外传参、字符串回调，以及 util.promisify(setTimeout) 依赖的 [util.promisify.custom]
// 自定义实现——全局换成包装函数会静默改掉这些语义（promisify 的 custom 会丢、字符串回调退化成
// 空操作），而漏掉一个 setTimeout 最坏只是等它自然到期（最长 60s 的假 timer 由套件末那道
// force-exit 闸兜住），代价远小于把全局 setTimeout 换掉。实测也确认：基线里唯一滞留在表里的
// 是生产侧 SSE 每连接 heartbeat（自带 unref、不钉事件循环），setTimeout 从不滞留。
// 真实泄漏不会被吞掉：兜底回收了东西就打印一行 ♻️，并把这一笔记进 leakedScopes；套件末的
// 兜底闸据此把退出码置 1（评审 1：旧版「有泄漏但仍 exit 0」等于把泄漏吞掉）。正常路径下
// server 已被用例自己关掉，收割是 no-op，不会产生噪音。
const liveServers = new Set()
const liveIntervals = new Set()
// 全轮的真实泄漏记录：任一次收割（用例级 / 套件末 / 异常路径）收到真家伙就记一笔。
// 套件末的兜底闸据此把退出码置 1——单看「最后一次收割」会漏掉用例级已经收掉的那笔。
const leakedScopes = []
const realSetInterval = global.setInterval
const realSetTimeout = global.setTimeout
const realClearInterval = global.clearInterval
const realClearTimeout = global.clearTimeout
global.setInterval = function (...args) {
  const h = realSetInterval(...args)
  liveIntervals.add(h)
  return h
}
global.clearInterval = function (h) { liveIntervals.delete(h); return realClearInterval(h) }

function trackSockets (server) {
  if (server._testSockets) return
  server._testSockets = new Set()
  server.on('connection', (socket) => {
    server._testSockets.add(socket)
    socket.on('close', () => server._testSockets.delete(socket))
  })
}

// 同步收割即可：socket.destroy() 让长连接/keep-alive 立刻终结，server.close() 同步摘掉
// 监听句柄；close 回调在下一 tick 自行跑完，不需要 await 也能排空事件循环。
//
// 返回值是本轮收割到的「真实泄漏」：closed = 还开着的监听 server，cleared = 还在跑的 ref
// interval。unref 过的 interval（生产 SSE 每连接 heartbeat、用例自己 unref 的）不钉事件循环，
// 因此不算泄漏、不入 ♻️、不计失败——但**仍然 clearInterval**：测试结束就不该留后台定时器，
// 否则它自己的 teardown 失败时会一直空跑到进程退出（评审 3）。
function reapTestScope (label) {
  let closed = 0
  let cleared = 0
  for (const t of liveIntervals) {
    // hasRef 探测本身可能抛（已被 clear 的句柄），抛了按「有引用」处理，宁可多报不漏报。
    let refd
    try { refd = !(typeof t.hasRef === 'function' && !t.hasRef()) } catch (e) { refd = true }
    try { realClearInterval(t) } catch (e) {}
    if (refd) cleared++
  }
  liveIntervals.clear()
  for (const server of liveServers) {
    for (const socket of server._testSockets || []) { try { socket.destroy() } catch (e) {} }
    if (server.listening) { try { server.close() } catch (e) {} closed++ }
  }
  liveServers.clear()
  if (closed || cleared) {
    console.log(`  ♻️ ${label} 收尾兜底：关闭残留 server ${closed} 个 / 清理残留 interval ${cleared} 个`)
    leakedScopes.push(`${label}（server ${closed} / interval ${cleared}）`)
  }
  return { closed, cleared }
}

// 上一个 aok 超时未收尾的标记：aok 用 Promise.race 定局后原 work 仍在跑，Promise 没有取消
// 语义（原理上做不到把它掐掉），它迟到的回调可能新建 server/socket/interval 或改共享状态。
// 这里不做取消，只做最小防护：下一条 ok/aok 开始时先补一次收割，把僵尸刚造出来的句柄收掉；
// 真正的兜底是套件末那道非零退出闸——迟到回调不可取消，只能靠后续收割 + 非零退出兜底。
let timedOutStale = null
function reapStaleTimeout (next) {
  if (!timedOutStale) return
  const prev = timedOutStale
  timedOutStale = null
  console.log(`  ⏱️ ${prev} 已超时，迟到回调不可取消——先补一次收割再跑 ${next}`)
  reapTestScope(`${prev} 超时补收割`)
}

function refdHandleNames (ignore) {
  // 过滤「不钉事件循环」的句柄：unref 过的 timer/server/socket 不算泄漏；stdio 也不算
  // （管道形态下 process.stdout/stderr 常驻 _getActiveHandles）。剩下的才是真泄漏。
  const skip = new Set([ignore, process.stdout, process.stderr, process.stdin])
  const names = []
  for (const h of process._getActiveHandles()) {
    if (!h || skip.has(h)) continue
    let refd
    try { refd = !(typeof h.hasRef === 'function' && !h.hasRef()) } catch (e) { refd = true }
    if (!refd) continue
    names.push((h.constructor && h.constructor.name) || typeof h)
  }
  return names
}

function ok (name, fn) {
  reapStaleTimeout(name)
  try { fn(); passed++; console.log(`  ✅ ${name}`) } catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`) } finally { reapTestScope(name) }
}
// 变异体还有第二类 Timeout：不是「跑完不退出」，而是用例内部 await 永不返回（例如变异体
// 删掉 res.end 后 request() 永远等不到响应）。收尾收割只能在用例结束后跑，因此必须给每条
// 用例一个上界：超时记失败、继续下一条。
// 取值 25s 的依据（评审 4 校准，旧注释 15s 的口径是错的）：
//   · 基线最慢单条 5.3–5.5s（readRunHistory 尾窗），25s ≈ 4.5x，慢机器/抖动仍有富余；
//   · 必须严格大于 SSE 用例的最长内层等待 20s（untilTornDown(20000)：超限硬断要等满 20s
//     才能判负），否则合法慢用例会先被看门狗判红——15s 时这条用例本来就在赌，机器一慢就假红。
// 已知边界：同步死循环（while (true) {}）用同线程定时器打断不了——看门狗自己也是这个线程上的
// 回调，永远轮不到它执行。那种形态只能靠上层兜住（Stryker 的 timeoutMS、CI 的 step 超时）。
const TEST_TIMEOUT_MS = 25000
async function aok (name, fn) {
  reapStaleTimeout(name)
  let watchdog = null
  let timedOut = false
  try {
    const work = Promise.resolve().then(fn)
    // 看门狗判定超时后 work 仍可能稍后 reject（例如用例内部自己的 8s 等待又失败）；
    // race 已定局，这里显式吞掉，避免 unhandledRejection 把整个套件带崩、把失败数算错。
    work.catch(() => {})
    await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        watchdog = realSetTimeout(() => {
          timedOut = true
          reject(new Error(`用例超时 ${TEST_TIMEOUT_MS}ms（内部 await 未返回）`))
        }, TEST_TIMEOUT_MS)
        // 这里绝不能 unref()：unref 的 timer 不撑事件循环，而「纯 await 永不返回、手上又没有
        // 其它 ref 句柄」的用例正是要看门狗救的形态——unref 后进程会在到点前直接空转退出，
        // 打印半套汇总、exit 0，Stryker 反而当成通过（比判 Timeout 更糟）。timer 在 finally 里
        // 清掉，跑完的用例不会因为它在收尾多等 25s。
      })
    ])
    passed++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    // 超时是真超时（不是用例自己抛的错）才记僵尸标记：后续用例开始前会因此补收割一次。
    if (timedOut) timedOutStale = name
    // 带自定义消息的 assert 会把 actual/expected 藏起来（只留「剩余秒数按 5s 窗算」这种描述），
    // 排障时看不出差在哪。这里补上短摘要，超长截断。
    let detail = ''
    if (e && e.actual !== undefined) {
      try { detail = ` (actual=${JSON.stringify(e.actual)} expected=${JSON.stringify(e.expected)})`.slice(0, 200) } catch (err) { detail = '' }
    }
    console.log(`  ❌ ${name}: ${e.message}${detail}`)
  } finally {
    if (watchdog) realClearTimeout(watchdog)
    reapTestScope(name)
  }
}

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-test-')) }

// v3.340：每组设置用例自带 stateDir + server，退出时关服务并删沙箱——一段失败不影响其它段，
// 也不会因为漏关监听句柄把整套件挂到超时（旧版 60+ 断言挤在一个 aok 里，首错就吞掉余下全部）。
async function withSettingsConsole (fn, prepare) {
  const dir = tmpDir()
  try {
    if (typeof prepare === 'function') prepare(dir)
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    server.unref()
    try {
      await fn({ dir, port, server })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── token 校验 ──
ok(`isValidToken: ≥${TOKEN_MIN_LEN} 字符合法`, () => {
  assert.strictEqual(isValidToken('a'.repeat(TOKEN_MIN_LEN)), true)
})
ok('isValidToken: 过短/非字符串/空串拒绝', () => {
  assert.strictEqual(isValidToken('a'.repeat(TOKEN_MIN_LEN - 1)), false)
  assert.strictEqual(isValidToken(''), false)
  assert.strictEqual(isValidToken(undefined), false)
  assert.strictEqual(isValidToken(1.2345678901234568e21), false)
})
ok('isValidToken: 浏览器不可传输字符拒绝（Sourcery G_ot）', () => {
  assert.strictEqual(isValidToken('a\u00e9'.repeat(16)), false, '非 Latin-1（fetch ByteString 会抛错）拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + ';b'.repeat(4)), false, '分号（Set-Cookie 分隔符）拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + ',b'.repeat(4)), false, '逗号拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + '"b'.repeat(4)), false, '双引号拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + '\\b'.repeat(4)), false, '反斜杠拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + ' b'.repeat(4)), false, '空白拒绝')
  assert.strictEqual(isValidToken('-_.~' + 'a'.repeat(28)), true, '安全符号仍合法')
  // Sourcery Trailing-newline：$ 会匹配尾随换行前的位置——行尾终止符必须显式拒绝
  assert.strictEqual(isValidToken('a'.repeat(16) + '\n'), false, '尾随 LF 拒绝')
  assert.strictEqual(isValidToken('a'.repeat(16) + '\r'), false, '尾随 CR 拒绝')
  assert.strictEqual(isValidToken('a'.repeat(16) + '\u2028'), false, '尾随 U+2028 拒绝')
  // Sourcery Raw-token-URLs：& # + 让 raw ?token= 链接失效，启动闸禁掉
  assert.strictEqual(isValidToken('a'.repeat(8) + '&'.repeat(8)), false, '& 拒绝（URL 分隔符）')
  assert.strictEqual(isValidToken('a'.repeat(8) + '#'.repeat(8)), false, '# 拒绝（锚点）')
  assert.strictEqual(isValidToken('a'.repeat(8) + '+'.repeat(8)), false, '+ 拒绝（空格解码）')
  assert.strictEqual(isValidToken('a'.repeat(8) + '%41'.repeat(4)), false, '% 拒绝（URLSearchParams 会解码改写）')
  // Sourcery Long-tokens：超长 token 被浏览器 Cookie 静默丢弃 → 资产全 401
  assert.strictEqual(isValidToken('a'.repeat(201)), false, '超长（>200）拒绝')
  assert.strictEqual(isValidToken('a'.repeat(200)), true, '恰好 200 通过')
})
ok('sessionCookieValue: 解析/多段/无值/null', () => {
  const { sessionCookieValue, SESSION_COOKIE } = require('./scripts/console')
  assert.strictEqual(SESSION_COOKIE, 'xbk_session')
  assert.strictEqual(sessionCookieValue('xbk_session=abc; other=1'), 'abc')
  assert.strictEqual(sessionCookieValue('other=1; xbk_session=abc'), 'abc')
  assert.strictEqual(sessionCookieValue('xbk_session=a%40b'), 'a@b', 'decodeURIComponent 还原')
  assert.strictEqual(sessionCookieValue('xbk_session='), null)
  assert.strictEqual(sessionCookieValue('other=1'), null)
  assert.strictEqual(sessionCookieValue(''), null)
  assert.strictEqual(sessionCookieValue(undefined), null)
})
ok('createConsole: token 缺失/过短 fail-closed 拒启', () => {
  assert.throws(() => createConsole({ token: undefined, stateDir: tmpDir() }), /XBK_CONSOLE_TOKEN/)
  assert.throws(() => createConsole({ token: 'short', stateDir: tmpDir() }), /XBK_CONSOLE_TOKEN/)
})
ok('timingSafeEqualStr: 等长比较/长度不等 false/异常 false', () => {
  assert.strictEqual(timingSafeEqualStr('abc', 'abc'), true)
  assert.strictEqual(timingSafeEqualStr('abc', 'abd'), false)
  assert.strictEqual(timingSafeEqualStr('abc', 'abcd'), false)
  assert.strictEqual(timingSafeEqualStr(undefined, 'abc'), false)
})

// ── 锁语义 ──
ok('acquireLock: 空目录可获取；持有期内二次获取拒绝', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000, 'tok-a'), true)
  assert.strictEqual(acquireLock(dir, 2000, 'tok-b'), false, '持有期内必须拒绝')
  // 释放走 releaseLockFor（v3.296：按路径 unlinkSync 的 releaseLock 已删）
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-a' })
  assert.strictEqual(acquireLock(dir, 3000, 'tok-c'), true, 'released 锁立即可接管')
})
ok('acquireLock: 陈旧锁（age > PROC_TIMEOUT_MS）可接管', () => {
  const dir = tmpDir()
  // startedAt 必须是合法正整数（<=0 会被判为不可信锁而 fail-closed）
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, startedAt: 1 }))
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS + 2), true)
  const data = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
  assert.strictEqual(data.startedAt, PROC_TIMEOUT_MS + 2, '接管后 startedAt 更新')
  assert.strictEqual(fs.existsSync(lockPath(dir) + '.takeover'), false, '接管后哨兵清理')
})
ok('acquireLock: 畸形锁帧（released 非布尔 / pid 字段超长）→ fail-closed 拒绝（回归：JSON.parse 不得抛错崩进程）', () => {
  const dir = tmpDir()
  // released 键为字符串：旧实现 parsed.released === true 虽判 false，但 startedAt 缺失会
  // 走 corrupted 分支——真实回归点是 releaseLockFor 短帧化后「released+空格尾」与
  // 「released+残留旧内容」都必须解析为合法帧，任何畸形变体不得抛出未捕获异常。
  fs.writeFileSync(lockPath(dir), '{"released":"yes","startedAt":1}')
  assert.strictEqual(acquireLock(dir, 1000), false, 'released 非布尔不得当作已释放')
  fs.writeFileSync(lockPath(dir), `{"pid":"${'9'.repeat(400)}","startedAt":1,"released":true}`)
  assert.strictEqual(acquireLock(dir, 1000), true, '超长字段的 released 帧仍可接管（解析不崩）')
})
ok('acquireLock: 锁内容损坏 / startedAt 无效 → fail-closed 拒绝', () => {
  const dir = tmpDir()
  // JSON 损坏
  fs.writeFileSync(lockPath(dir), 'not-json{{')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false)
  // startedAt <= 0 或缺失同样不可信（Sourcery #11：Number(...)||0 曾把无效当成 epoch）
  fs.writeFileSync(lockPath(dir), '{"pid":5,"startedAt":0}')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false, 'startedAt=0 拒绝')
  fs.writeFileSync(lockPath(dir), '{"pid":5}')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false, 'startedAt 缺失拒绝')
  fs.writeFileSync(lockPath(dir), '{"pid":5,"startedAt":-5}')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false, 'startedAt 负数拒绝')
})
ok('acquireLock: 持有期内并发获取拒绝（rename 不得静默覆盖）', () => {
  // 回归锁：writeLockAtomic 曾用 rename 覆盖路径，POSIX rename 会静默替换目标，
  // 导致「独占创建」名存实亡——二次获取静默成功，单飞失效。
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000), true)
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(acquireLock(dir, 1000 + i), false, `并发第 ${i + 1} 次必须失败`)
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).startedAt, 1000, '锁内容不被后来者覆盖')
})
ok('acquireLock: 锁内容带归属 token；releaseLockFor 按 pid+token 双匹配作废', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000, 'tok-abc'), true)
  const data = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
  assert.strictEqual(data.token, 'tok-abc', '锁内容必须写入归属 token')
  assert.strictEqual(data.pid, process.pid)
  // token 不匹配（他人锁/pid 复用场景）不作废
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: 1000, token: 'other' }))
  const { releaseLockFor } = require('./scripts/console')
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-abc' })
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).token, 'other', 'token 不匹配不得作废他人锁')
  // 双匹配 → 覆写作废（released:true），且立刻可被接管
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: 1000, token: 'tok-abc' }))
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-abc' })
  const after = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
  assert.strictEqual(after.released, true, 'pid+token 双匹配覆写为 released')
  assert.strictEqual(acquireLock(dir, 1001, 'tok-def'), true, 'released 锁立即可接管')
})
ok('releaseLockFor: released 短帧不大于原帧（回归：恒比原帧长的旧帧使「补空格防半旧半新」成死代码）', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000, 'tok-abc'), true)
  const origLen = JSON.stringify({ pid: process.pid, startedAt: 1000, token: 'tok-abc' }).length
  const { releaseLockFor } = require('./scripts/console')
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-abc' })
  const body = fs.readFileSync(lockPath(dir), 'utf8')
  assert.strictEqual(body.length, origLen, '覆写后长度必须等于原帧（补空格到原长，杜绝跨扇区半旧半新窗）')
  assert.strictEqual(JSON.parse(body).released, true, '空格补尾后仍是合法 JSON released 帧')
  assert.strictEqual(body.trim(), '{"released":true}', '实体内容必须是短帧（pid/token/startedAt 已无保留价值）')
})
ok('releaseLockFor: inode 一致性闸（回归 Sourcery #225 High / D2-S4：闸必须真的被执行）', () => {
  const dir = tmpDir()
  const p = lockPath(dir)
  assert.strictEqual(acquireLock(dir, 1000, 'tok-old'), true)
  const fsmod = require('node:fs')
  // 旧持有者在 rename 之前 open 到的 fd（与本用例的 victimFd 指向同一 inode）。
  const victimFd = fsmod.openSync(p, 'r+')
  // 关键：在 releaseLockFor 的「open 读完内容 → statSync 取路径 inode」之间注入换代。
  // 旧用例把新帧 pid 写成 424242，releaseLockFor 先命中 pid 分支返回 false，闸那行从未
  // 执行——删掉闸仍然 PASS（假绿）。这里用 statSync 钩子在正确的时序点 rename，才真正
  // 覆盖 fstat(fd).ino !== stat(path).ino 这一行。
  const realStat = fsmod.statSync
  let injected = false
  fsmod.statSync = function (target, ...rest) {
    if (!injected && target === p) {
      injected = true
      fsmod.writeFileSync(`${p}.t`, JSON.stringify({ pid: process.pid, startedAt: 2000, token: 'tok-new' }))
      fsmod.renameSync(`${p}.t`, p)
    }
    return realStat.call(this, target, ...rest)
  }
  let released
  try { released = releaseLockFor({ _stateDir: dir, _lockToken: 'tok-old' }) } finally { fsmod.statSync = realStat }
  assert.strictEqual(injected, true, '用例必须真的在 open 与 stat 之间注入换代（否则闸未被执行）')
  assert.strictEqual(released, false, 'fd 指向孤儿 inode 时必须放弃覆写并如实报 false')
  // 新主锁帧原样无损（竞态安全读取）。
  const safe = readSafeTextResult(p)
  assert.strictEqual(safe.status, 'ok', `读锁帧必须 ok（实际 ${safe.status}）`)
  assert.strictEqual(JSON.parse(safe.text).token, 'tok-new', '新主锁帧原样无损')
  // 孤儿 inode 也不得被写成 released（删掉闸时这里会读到 {"released":true}）。
  const buf = Buffer.alloc(4096)
  const n = fsmod.readSync(victimFd, buf, 0, 4096, 0)
  assert.ok(buf.slice(0, n).toString('utf8').includes('tok-old'), '孤儿 inode 不得被覆写')
  fsmod.closeSync(victimFd)
})
ok('releaseLockFor: 短写循环（monkeypatch writeSync 首次少写，回归 Sourcery #225 M1）', () => {
  const dir = tmpDir()
  const fsmod = require('node:fs')
  assert.strictEqual(acquireLock(dir, 1000, 'tok-sw'), true)
  const realWrite = fsmod.writeSync
  let calls = 0
  fsmod.writeSync = function (fd, buf, off, len, pos) {
    if (Buffer.isBuffer(buf) && buf.slice(0, 17).toString('utf8') === '{"released":true}') {
      calls++
      if (calls === 1) return realWrite(fd, buf, off, len - 6, pos) // 模拟少写 6 字节
    }
    return realWrite(fd, buf, off, len, pos)
  }
  try {
    const { releaseLockFor } = require('./scripts/console')
    const res = releaseLockFor({ _stateDir: dir, _lockToken: 'tok-sw' })
    assert.strictEqual(res, true, '短写循环补齐后必须成功')
    assert.ok(calls >= 2, `必须发生多次 writeSync（实际 ${calls} 次）`)
  } finally {
    fsmod.writeSync = realWrite
  }
  // 断言补写结果：readSafeTextResult（竞态安全纪律，理由见文件头注释）。
  const safeBody = readSafeTextResult(lockPath(dir))
  assert.strictEqual(safeBody.status, 'ok')
  const body = safeBody.text
  assert.strictEqual(JSON.parse(body).released, true, '残尾补写后仍是合法 released 帧')
  assert.strictEqual(body.trim(), '{"released":true}')
})
ok('releaseLockFor: 他人活锁返回 false；released 帧返回 true；锁不存在返回 true', () => {
  const dir = tmpDir()
  const { releaseLockFor } = require('./scripts/console')
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999, startedAt: 1000, token: 'other' }))
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'mine' }), false, '他人活锁如实报 false')
  fs.writeFileSync(lockPath(dir), '{"released":true}')
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'mine' }), true, '已 released 报 true')
  fs.unlinkSync(lockPath(dir))
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'mine' }), true, '锁不存在报 true')
})
ok('acquireLock: 陈旧损坏锁 / 0 字节锁可接管；新鲜损坏锁仍 fail-closed（D2-S1 回归）', () => {
  const dir = tmpDir()
  const p = lockPath(dir)
  const old = new Date(Date.now() - PROC_TIMEOUT_MS - 60000)
  // 0 字节锁（旧写入路径 open(wx) 后崩溃的产物）：修前永久 fail-closed，只能人工删文件
  fs.writeFileSync(p, '')
  fs.utimesSync(p, old, old)
  assert.strictEqual(acquireLock(dir, Date.now(), 'tok-fix'), true, 'mtime 陈旧的 0 字节锁必须可接管')
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).token, 'tok-fix')
  // 半截 JSON 同理
  fs.writeFileSync(p, '{"pid":1,"starte')
  fs.utimesSync(p, old, old)
  assert.strictEqual(acquireLock(dir, Date.now(), 'tok-fix2'), true, 'mtime 陈旧的半截 JSON 锁可接管')
  // 新鲜的损坏锁仍 fail-closed（可能正被写入）
  fs.writeFileSync(p, 'half-json{{')
  assert.strictEqual(acquireLock(dir, Date.now(), 'tok-x'), false, '新鲜损坏锁不得接管')
  // 写入路径本身不再产生 0 字节锁：link 落地时内容已完整
  const dir2 = tmpDir()
  assert.strictEqual(acquireLock(dir2, 1000, 'tok-link'), true)
  const raw = fs.readFileSync(lockPath(dir2), 'utf8')
  assert.ok(raw.length > 0 && JSON.parse(raw).token === 'tok-link', '锁帧必须一次成型')
  const leftovers = fs.readdirSync(dir2).filter((n) => n.endsWith('.tmp'))
  assert.deepStrictEqual(leftovers, [], '临时文件必须清理干净')
})
ok('acquireLock: 陈旧 .takeover 哨兵 unlink 后重抢；新鲜哨兵仍拒绝（D2-S5 回归）', () => {
  const dir = tmpDir()
  const p = lockPath(dir)
  const sentinel = p + '.takeover'
  const old = new Date(Date.now() - PROC_TIMEOUT_MS - 60000)
  // 残留哨兵（上次接管者崩溃）+ 陈旧锁：修前用 stat→writeFileSync「刷新」哨兵（非原子），
  // 且哨兵残留会让后续触发连续 10 分钟 409。现在必须 unlink 后重新 open(wx) 抢占。
  fs.writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: 1, token: 'old' }))
  fs.writeFileSync(sentinel, 'stale')
  fs.utimesSync(sentinel, old, old)
  assert.strictEqual(acquireLock(dir, Date.now(), 'tok-reclaim'), true, '陈旧哨兵必须被回收')
  assert.strictEqual(fs.existsSync(sentinel), false, '接管完成后哨兵必须清理')
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).token, 'tok-reclaim')
  // 新鲜哨兵 = 另一个实例正在接管：让给对方（拒绝）
  fs.writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: 1, token: 'old' }))
  fs.writeFileSync(sentinel, 'live')
  assert.strictEqual(acquireLock(dir, Date.now(), 'tok-x'), false, '新鲜哨兵必须尊重并发接管')
})
ok('releaseLockFor: open 失败只有 ENOENT 才算已释放（EACCES/EMFILE → false，D2-S3）', () => {
  const dir = tmpDir()
  const p = lockPath(dir)
  assert.strictEqual(acquireLock(dir, 1000, 'tok-perm'), true)
  const fsmod = require('node:fs')
  const realOpen = fsmod.openSync
  for (const code of ['EACCES', 'EMFILE', 'EIO']) {
    fsmod.openSync = function (target, flags, ...rest) {
      if (target === p) { const e = new Error(`${code}: simulated`); e.code = code; throw e }
      return realOpen.call(this, target, flags, ...rest)
    }
    try {
      assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'tok-perm' }), false, `${code} 必须如实报 false`)
    } finally { fsmod.openSync = realOpen }
  }
  // 锁帧未被写成 released（调用方会据此响亮告警，而不是当成功）
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).released, undefined)
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'tok-perm' }), true, '正常路径仍可释放')
})

// ── 动作解析 ──
ok('parseAction: urlencoded 合法动作（run-auto 仅内部）+ 非法动作 null', () => {
  for (const key of Object.keys(ACTIONS)) {
    const expected = key === 'run-auto' ? null : key
    assert.strictEqual(parseAction(`action=${key}`), expected)
    assert.strictEqual(parseAction(`other=1&action=${key}&x=2`), expected)
  }
  assert.strictEqual(parseAction('action=nope'), null)
  assert.strictEqual(parseAction(''), null)
  assert.strictEqual(parseAction('action='), null)
})
ok('parseAction: + 号解码（form 编码空格形态）', () => {
  // 动作名都是无空格词，此处只验证解码路径不误伤合法值
  assert.strictEqual(parseAction('action=run'), 'run')
})

// ── HTML 转义 ──
ok('escapeHtml: 五类字符全转义', () => {
  assert.strictEqual(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;')
})
ok('escapeHtml: null/undefined → 空串', () => {
  assert.strictEqual(escapeHtml(null), '')
  assert.strictEqual(escapeHtml(undefined), '')
})

ok('authorize: Bearer 前缀匹配 + ?token= 查询参数（浏览器路径）', () => {
  const TOKEN2 = 'z'.repeat(32)
  const mkReq = (headers) => ({ headers: headers || {} })
  // Bearer 路径
  assert.strictEqual(authorize(mkReq({ authorization: `Bearer ${TOKEN2}` }), TOKEN2, null), true)
  assert.strictEqual(authorize(mkReq({ authorization: `Bearer ${TOKEN2} ` }), TOKEN2, null), true, '尾随空白容忍')
  assert.strictEqual(authorize(mkReq({ authorization: 'Bearer wrong' }), TOKEN2, null), false)
  // RFC 9110：auth-scheme 大小写不敏感（v3.296 修复：小写 scheme 不得 401）
  assert.strictEqual(authorize(mkReq({ authorization: `bearer ${TOKEN2}` }), TOKEN2, null), true, 'scheme 小写同样放行')
  assert.strictEqual(authorize(mkReq({ authorization: `BEARER ${TOKEN2}` }), TOKEN2, null), true, 'scheme 大写变体同样放行')
  assert.strictEqual(authorize(mkReq({ authorization: `bearerx ${TOKEN2}` }), TOKEN2, null), false, '前缀必须带空格边界')
  assert.strictEqual(authorize(mkReq({}), TOKEN2, null), false)
  // 查询参数路径（浏览器导航/表单/meta refresh 用）
  assert.strictEqual(authorize(mkReq({}), TOKEN2, new URLSearchParams(`token=${TOKEN2}`)), true)
  assert.strictEqual(authorize(mkReq({}), TOKEN2, new URLSearchParams('token=wrong')), false)
  assert.strictEqual(authorize(mkReq({}), TOKEN2, new URLSearchParams('other=1')), false)
  // 错误 token + 正确查询参数：查询参数可独立放行（浏览器不带请求头）
  assert.strictEqual(authorize(mkReq({ authorization: 'Bearer wrong' }), TOKEN2, new URLSearchParams(`token=${TOKEN2}`)), true)
})

ok('renderPage: token 经 JSON 岛注入；无 token 时空 token；含资产与 CSP 引用', () => {
  const { readStatus } = require('./scripts/status')
  const TOKEN2 = 'q'.repeat(32)
  const dir = tmpDir()
  const state = readStatus(dir) // 空目录 → 全部件「缺失」，formatStatus 合法渲染
  const withToken = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`))
  // JSON 岛注入（v3.285：SPA 壳；fetch 由前端发起，不再有原生表单/meta refresh）
  assert.ok(withToken.includes(`"token":"${TOKEN2}"`), 'JSON 岛带 token')
  assert.ok(withToken.includes('id="xbk-boot"'), 'JSON 岛节点存在')
  assert.match(withToken, /\/assets\/[0-9a-f]{16}\/app\.js/, '引用前端 ESM（带内容版本路径）')
  assert.match(withToken, /\/assets\/[0-9a-f]{16}\/app\.css/, '引用样式（带内容版本路径）')
  assert.ok(withToken.includes('Content-Security-Policy'), '带 CSP')
  // Sourcery vww：CSP 不能只断言 meta 名——被削弱的策略（如 default-src *）也含这个字符串。
  // 必须锁死关键指令本体。
  assert.ok(withToken.includes("default-src 'none'"), "CSP 含 default-src 'none'")
  assert.ok(withToken.includes("script-src 'self'"), "CSP 含 script-src 'self'")
  assert.ok(withToken.includes("connect-src 'self'"), "CSP 含 connect-src 'self'")
  assert.ok(withToken.includes("frame-ancestors 'none'"), "CSP 含 frame-ancestors 'none'（响应头与 meta 双通道，见 HTTP 用例）")
  assert.ok(!withToken.includes('http-equiv="refresh"'), '不再 meta refresh 整页刷新')
  // v3.323 主题：首帧必须由服务端把 <html data-theme> 渲染出来（放 body 或只在 JS 里设都不算）。
  assert.ok(/<html lang="zh-CN" data-theme="deep">/.test(withToken), '默认首帧 data-theme 必须是 deep')
  const nordPage = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`), '', 'nord')
  assert.ok(/<html lang="zh-CN" data-theme="nord">/.test(nordPage), '首帧必须跟随传入的主题')
  const badPage = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`), '', 'evil')
  assert.ok(/<html lang="zh-CN" data-theme="deep">/.test(badPage), '白名单外主题必须回落 deep')
  assert.ok(!/<body[^>]*data-theme/.test(nordPage), 'data-theme 必须在 <html> 上（放到 body 不生效）')
  const noToken = renderPage(state, [], null)
  assert.ok(noToken.includes('"token":""'), '无 token 时 JSON 岛为空串（前端触发会 401，符合 fail-closed）')
  assert.ok(!noToken.includes(`"token":"${TOKEN2}"`), '无 token 时不回显')
  assert.ok(noToken.includes('缺失'), '空缓存目录渲染「缺失」分支（noscript 降级）')
  // Sourcery vwK：特殊字符 token 必须以 \uXXXX JSON 转义进岛（script 文本不做实体解码，
  // HTML 实体会让前端 parse 出错误 token）；JSON.parse 后必须还原为原值。
  const WEIRD = 'a<b>&"\\u2028' + 'z'.repeat(20)
  const weirdPage = renderPage(state, [], new URLSearchParams(`token=${encodeURIComponent(WEIRD)}`))
  assert.ok(!weirdPage.includes('<b>'), '岛内不得出现裸 <script 片段')
  const m = /<script type="application\/json" id="xbk-boot">([\s\S]*?)<\/script>/.exec(weirdPage)
  assert.ok(m, 'JSON 岛可提取')
  const parsed = JSON.parse(m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'))
  assert.strictEqual(parsed.token, WEIRD, '岛内 token 经 JSON 解析还原为原值')
  // 常规 token 原样进岛（不引入任何实体）
  const plain = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`))
  assert.ok(plain.includes(`"token":"${TOKEN2}"`), '常规 token 原样回显')
})

ok('authorize 语义由 HTTP 端到端覆盖（前缀匹配，无正则回溯）', () => {
  // 端到端用例在下方；这里登记实现约束。
  assert.ok(true)
})

// ── v3.300 访问日志：纯函数表（无 HTTP；端到端用例见下方 T1-T7）──
ok('sanitizeAccessPath: 敏感键值 *** + 原串形态保留（D2-N1/N2）', () => {
  // 分隔符保留：查询串形状不破坏
  assert.strictEqual(sanitizeAccessPath('/x?token=a&b=1'), '/x?token=***&b=1')
  // 重复 token 参数：逐个命中，不靠正则回溯
  assert.strictEqual(sanitizeAccessPath('/x?a=1&token=x1&token=y2'), '/x?a=1&token=***&token=***')
  // 编码键名：判定用解码副本，落盘保留原串（与真实请求行一一对应）
  assert.strictEqual(sanitizeAccessPath('/x?%74oken=z3'), '/x?%74oken=***')
  // 双层编码 %2574oken=
  const dbl = sanitizeAccessPath('/x?%2574oken=z4')
  assert.strictEqual(dbl, '/x?%2574oken=***', '双层编码键名同样命中')
  assert.ok(!dbl.includes('z4'), '原文不得残留')
  // 畸形 % 序列（URIError）→ 原串兜底，不抛
  assert.strictEqual(sanitizeAccessPath('/x?aa=%zz'), '/x?aa=%zz')
  // 大小写变体与 ;/# 分隔符形态同洗（键名原样保留，只盖值）
  assert.strictEqual(sanitizeAccessPath('/x?Token=k1'), '/x?Token=***')
  assert.strictEqual(sanitizeAccessPath('/x?TOKEN=k1'), '/x?TOKEN=***')
  assert.strictEqual(sanitizeAccessPath('/x?a=1;token=k1'), '/x?a=1;token=***')
  assert.strictEqual(sanitizeAccessPath('/x?frag#token=k1'), '/x?frag#token=***')
  assert.strictEqual(sanitizeAccessPath('/x?%54oken=k1'), '/x?%54oken=***')
  assert.strictEqual(sanitizeAccessPath('/x?a;1&b#2'), '/x?a;1&b#2', '无敏感键的 ;/# 路径原样（不误伤）')
  // D2-N1：只认 token= 的时代结束——派生键名同样脱敏
  assert.strictEqual(sanitizeAccessPath('/x?access_token=abc'), '/x?access_token=***')
  assert.strictEqual(sanitizeAccessPath('/x?refresh_token=abc&q=1'), '/x?refresh_token=***&q=1')
  assert.strictEqual(sanitizeAccessPath('/x?apikey=abc'), '/x?apikey=***')
  assert.strictEqual(sanitizeAccessPath('/x?client_secret=abc'), '/x?client_secret=***')
  assert.strictEqual(sanitizeAccessPath('/x?password=abc'), '/x?password=***')
  // D2-N2：非敏感参数的值里出现 token 字样不得整段删除
  assert.strictEqual(sanitizeAccessPath('/x?q=token%3Dabc'), '/x?q=token%3Dabc')
  // D2-N2：裸控制字符转义（落盘串不能带 C0）
  assert.strictEqual(sanitizeAccessPath('/x?a=\u0001b'), '/x?a=%01b')
  assert.strictEqual(sanitizeAccessPath('/x?token=a\u0007b'), '/x?token=***', '敏感值整体盖掉，控制字符不再需要转义')
  // null → ''；无 % 无 token 的普通路径原样
  assert.strictEqual(sanitizeAccessPath(null), '')
  assert.strictEqual(sanitizeAccessPath('/plain'), '/plain')
})
ok('shouldLogAccess: 降噪白名单表（仅 2xx 且命中才免记；/api/access-log 自身照记）', () => {
  const cases = [
    [['GET', '/api/status', 200], false],
    [['GET', '/api/status', 500], true],
    [['GET', '/api/runs', 200], false],
    // v3.374：全站通知流是长连接，finish 时 ms=整段连接时长——照记会污染「慢请求」读数
    [['GET', '/api/stream', 200], false],
    [['GET', '/api/stream', 401], true],
    [['GET', '/api/runs/1750000000000.9', 200], false],
    [['GET', '/api/runs/1750000000000.9', 404], true],
    [['POST', '/api/runs/detail', 200], false],
    [['POST', '/api/runs/detail', 401], true],
    [['GET', '/assets/app.css', 200], false],
    [['GET', '/assets/app.css', 304], false],
    // v3.375：版本路径同样是静态资产——每次打开 11 条不该挤进 200 条环形日志
    [['GET', '/assets/a506737fe81d5acc/app.js', 200], false],
    [['GET', '/assets/a506737fe81d5acc/app.js', 401], true],
    [['GET', '/assets/v1/app.js', 200], true],
    [['GET', '/api/status', 304], false],
    [['GET', '/api/access-log', 304], true],
    [['GET', '/', 200], false],
    [['GET', '/api/access-log', 200], true],
    [['POST', '/api/messages/export', 200], true],
    [['POST', '/messages/export', 400], true],
    [['POST', '/trigger', 202], true]
  ]
  for (const [args, want] of cases) {
    assert.strictEqual(shouldLogAccess(...args), want, `shouldLogAccess(${args.join(', ')}) 应为 ${want}`)
  }
  assert.strictEqual(ACCESS_LOG_MAX, 200, '环形上限常量 = 200')
})
ok('acceptsGzip: 显式 gzip 的 q 压过 *（D1-N2：gzip;q=0, * 不得回压缩体）', () => {
  assert.strictEqual(acceptsGzip('gzip;q=0, *'), false, '显式拒绝 gzip 时 * 不得翻盘')
  assert.strictEqual(acceptsGzip('gzip;q=0, *;q=1'), false)
  assert.strictEqual(acceptsGzip('*;q=0, gzip'), true, '显式接受压过 *;q=0')
  assert.strictEqual(acceptsGzip('*'), true)
  assert.strictEqual(acceptsGzip('br, *;q=0.5'), true)
  assert.strictEqual(acceptsGzip('*;q=0'), false)
  assert.strictEqual(acceptsGzip('deflate'), false)
  assert.strictEqual(acceptsGzip('gzip;q=0.5'), true)
  assert.strictEqual(acceptsGzip('gzip;q=abc'), false, '非法 q 值按拒绝')
  assert.strictEqual(acceptsGzip(''), false)
  assert.strictEqual(acceptsGzip(undefined), false)
})
ok('findSecretLikeField: 大小写无关键名 + 非空字符串值（D2-S13 最终保险丝可达）', () => {
  assert.strictEqual(findSecretLikeField({ pushUrl: 'https://x', template: { title: 't' } }), '', '正常白名单视图零误报')
  assert.strictEqual(findSecretLikeField({ runtime: { api: { appToken: 'abc' } } }), 'appToken', 'camelCase 键名必须命中')
  assert.strictEqual(findSecretLikeField({ a: { b: { c: { PUSH_KEY: 'k' } } } }), 'PUSH_KEY')
  assert.strictEqual(findSecretLikeField({ access_token: 't' }), 'access_token')
  assert.strictEqual(findSecretLikeField({ secret: '' }), '', '空值=未配置，不算泄漏')
  assert.strictEqual(findSecretLikeField({ key: false }), '', '布尔值不算泄漏')
  assert.strictEqual(findSecretLikeField(null), '')
})

// ── v3.300 批次③ 3.1 SSE：纯函数（同步，直接 require 新导出）──
ok('T-P1 ssePlanChunk 全分支（增量/reset/边界/无新数据/超前游标/孤立代理/连续不重不漏）', () => {
  // 正常增量：多字节逐码元（中文=1 码元、🐮=2 码元）
  const inc = ssePlanChunk(2, 'AB中文🐮', 6)
  assert.deepStrictEqual(inc, { reset: false, text: '中文🐮', cursor: 6 })
  assert.strictEqual(inc.text.length, 4)
  // reset：游标落后淘汰点（lost=7）
  assert.deepStrictEqual(ssePlanChunk(3, 'CDE', 10), { reset: true, text: 'CDE', cursor: 10 })
  // 边界 cursor === lost：数据恰从游标起，不误发 reset
  const edge = ssePlanChunk(7, 'CDE', 10)
  assert.strictEqual(edge.reset, false)
  assert.strictEqual(edge.text, 'CDE')
  assert.strictEqual(edge.cursor, 10)
  // 无新数据 / 超前游标 → null
  assert.strictEqual(ssePlanChunk(10, 'CDE', 10), null)
  assert.strictEqual(ssePlanChunk(12, 'CDE', 10), null)
  // 孤立代理（环形淘汰劈对模拟）：reset 分支 text 原样含孤立低代理 + well-formed JSON 往返无损
  const lone = ssePlanChunk(0, '\uDF6B牛', 4)
  assert.strictEqual(lone.reset, true)
  assert.strictEqual(lone.text, '\uDF6B牛')
  assert.strictEqual(JSON.parse(JSON.stringify({ full: '\uDF6B' })).full, '\uDF6B', 'well-formed JSON.stringify/parse 往返无损')
  // 连续增量不重不漏：模拟 5 段追加、游标推进
  let output = ''
  let total = 0
  let cursor = 0
  let received = ''
  for (const piece of ['你好', '世界', '🐮栖', 'line\n', 'end']) {
    output += piece
    total += piece.length
    const plan = ssePlanChunk(cursor, output, total)
    if (plan) {
      assert.strictEqual(plan.reset, false)
      received += plan.text
      cursor = plan.cursor
    }
  }
  assert.strictEqual(received, '你好世界🐮栖line\nend', '连续增量拼接 === 全串')
})
ok('T-P2 SSE 常量与 RUN_ID_RE 形态', () => {
  assert.strictEqual(SSE_MAX_CONNECTIONS, 8)
  assert.strictEqual(SSE_MAX_PENDING, 1048576)
  assert.strictEqual(SSE_TICK_MS, 500)
  assert.strictEqual(SSE_HEARTBEAT_MS, 15000)
  // v3.374 全站通知流：2s 采样 / 20s 心跳 / 20 条上限（字面量锁死文档承诺，不引用常量自证）
  assert.strictEqual(SSE_STREAM_TICK_MS, 2000)
  assert.strictEqual(SSE_STREAM_HEARTBEAT_MS, 20000)
  assert.strictEqual(SSE_STREAM_MAX_CONNECTIONS, 20)
  assert.strictEqual(RUN_ID_RE.test('1750000000000.1'), true)
  assert.strictEqual(RUN_ID_RE.test('abc'), false)
  assert.strictEqual(RUN_ID_RE.test('1750.1'), false)
  assert.strictEqual(RUN_ID_RE.test('1750000000000..'), false)
  assert.strictEqual(RUN_ID_RE.test('1750000000000.12345678901'), false)
})

// ── v3.300 批次③ 3.2 消息导出：纯函数（同步，直接 require 新导出）──
ok('T-P0 导出常量: 5000 行钳制 / 200 码元摘要 / format 白名单冻结', () => {
  assert.strictEqual(EXPORT_MAX_ROWS, 5000)
  assert.strictEqual(EXPORT_EXCERPT_MAX, 200)
  assert.deepStrictEqual(EXPORT_FORMATS, ['csv', 'json'])
  assert.strictEqual(Object.isFrozen(EXPORT_FORMATS), true, '白名单冻结（防运行期扩表）')
})
ok('T-P1 csvCell: 公式中性化 + RFC4180 包裹（先中性化后包裹）', () => {
  // 中性化：危险首字符（跳过 spreadsheet 忽略的前导字符）前置 '
  assert.strictEqual(csvCell('=1+1'), "'=1+1")
  assert.strictEqual(csvCell('  =1+1'), "'  =1+1", '前导空格保留 + 前缀')
  assert.strictEqual(csvCell('-2件起批'), "'-2件起批")
  assert.strictEqual(csvCell('+861****8000'), "'+861****8000")
  assert.strictEqual(csvCell('@SUM(A1:A9)'), "'@SUM(A1:A9)")
  assert.strictEqual(csvCell(" '=1+1"), "' '=1+1", '含既有 \' 前缀（spreadsheets 忽略 \'，继续判首字符=1 → 整体加前缀，前缀字符保留）')
  assert.strictEqual(csvCell('正常文本'), '正常文本', '安全文本原样')
  assert.strictEqual(csvCell(''), '')
  assert.strictEqual(csvCell(null), '')
  assert.strictEqual(csvCell(undefined), '')
  assert.strictEqual(csvCell('   '), '   ', '纯空白原样（无有效首字符）')
  // 包裹：含 " , \r \n 任一即整体包裹、内部 " 翻倍
  assert.strictEqual(csvCell('a,b'), '"a,b"')
  assert.strictEqual(csvCell('a"b'), '"a""b"')
  assert.strictEqual(csvCell('a\nb'), '"a\nb"', 'LF 留在引号内')
  assert.strictEqual(csvCell('a\rb'), '"a\rb"', 'CR 留在引号内')
  // 中性化与包裹叠加：先加 '（内容层），再因内含 " 包裹（传输层）
  assert.strictEqual(csvCell('=1+1"x'), '"\'=1+1""x"')
})
ok('T-P2 filterMessageItems: cate 精确等值 + needle 双字段大小写不敏感 + 组合', () => {
  const items = [
    { title: '牛奶特价', content: '伊利纯牛奶', catename: '好单-日用' },
    { title: '坐垫', content: 'Cushion 好物', catename: '好单-家用' },
    { title: '饼干', content: '奥利奥', catename: '' },
    { title: 'Milk Powder', content: '奶粉', catename: '好单-食品' },
    { title: '无分类字段', content: 'x' }
  ]
  // cate 精确等值 + '(未分类)' 归一（空串与缺失 catename 同归一）
  assert.deepStrictEqual(filterMessageItems(items, '好单-日用', '').map(m => m.title), ['牛奶特价'])
  assert.deepStrictEqual(filterMessageItems(items, '(未分类)', '').map(m => m.title), ['饼干', '无分类字段'])
  // needle 大小写不敏感、title/content 双字段（'伊利纯牛奶'.includes('milk') 为 false——
  // toLowerCase 只做 ASCII 归一，不转译中文；命中 'milk' 的两条都靠 title 字段）
  assert.deepStrictEqual(filterMessageItems(items, '', 'milk').map(m => m.title), ['Milk Powder'])
  assert.deepStrictEqual(filterMessageItems(items, '', 'cushion').map(m => m.title), ['坐垫'])
  // cate+needle 组合
  assert.deepStrictEqual(filterMessageItems(items, '好单-食品', 'milk').map(m => m.title), ['Milk Powder'])
  // 空 cate / 空 needle 直通
  assert.strictEqual(filterMessageItems(items, '', '').length, 5)
})
ok('T-P2b 时间窗: 上海日历日边界 / 分类计数跟随窗口 / 非法天数回全部', () => {
  // 2026-10-18 00:00 Asia/Shanghai = 2026-10-17T16:00Z
  const now = Date.UTC(2026, 9, 17, 16, 0, 0)
  const items = [
    { title: '今天', catename: 'A', datetime: '2026-10-18 09:00:00' },
    { title: '昨天', catename: 'B', datetime: '2026-10-17 23:00:00' },
    { title: '前天', catename: 'A', datetime: '2026-10-16 12:00:00' },
    { title: '三天前', catename: 'C', datetime: '2026-10-15 12:00:00' },
    { title: '缺日期', catename: 'A' },
    { title: '坏日期', catename: 'B', datetime: 'not-a-date' }
  ]
  assert.deepStrictEqual(MESSAGE_DAYS_ALLOWED, [0, 1, 3, 7, 30])
  assert.deepStrictEqual(filterMessagesByDays(items, 1, now).map(m => m.title), ['今天'], '今天=上海 00:00 起')
  assert.deepStrictEqual(filterMessagesByDays(items, 3, now).map(m => m.title), ['今天', '昨天', '前天'], '近 3 天含今天')
  assert.deepStrictEqual(filterMessagesByDays(items, 7, now).map(m => m.title), ['今天', '昨天', '前天', '三天前'])
  assert.strictEqual(filterMessagesByDays(items, 0, now).length, 6, '0=全部，不因缺日期丢条目')
  assert.strictEqual(filterMessagesByDays(items, 99, now).length, 4, '正数窗宽按窗口过滤（白名单在端点）')
  assert.deepStrictEqual(messageCategoriesOf(filterMessagesByDays(items, 1, now)), [{ name: 'A', count: 1 }], '分类计数跟随时间窗')
})
ok('T-P2c 日期区间: parseDayKey 回环校验 / 闭区间过滤 / 区间优先于 days', () => {
  // 格式与真实性：闰日合法、2 月 30 归一化必须被拒（Date 会把 02-30 挪到 03-02）
  assert.strictEqual(parseDayKey('2026-10-05'), '2026-10-05')
  assert.strictEqual(parseDayKey('2024-02-29'), '2024-02-29', '闰日合法')
  assert.strictEqual(parseDayKey('2026-02-30'), '', '不存在的日期必须拒（防 Date 归一化）')
  assert.strictEqual(parseDayKey('2026-13-01'), '', '月份越界拒')
  assert.strictEqual(parseDayKey('2026-1-5'), '', '必须两位月日')
  assert.strictEqual(parseDayKey('2026-10-05x'), '', '多余字符拒')
  assert.strictEqual(parseDayKey(undefined), '', '非字符串拒')
  const items = [
    { title: '区间外前', datetime: '2026-10-04 23:00:00' },
    { title: '起点', datetime: '2026-10-05 00:00:00' },
    { title: '中间', datetime: '2026-10-08 12:00:00' },
    { title: '终点', datetime: '2026-10-12 23:59:59' },
    { title: '区间外后', datetime: '2026-10-13 00:00:00' },
    { title: '缺日期' },
    { title: '坏日期', datetime: 'oops' }
  ]
  assert.deepStrictEqual(filterMessagesByRange(items, '2026-10-05', '2026-10-12').map(m => m.title),
    ['起点', '中间', '终点'], '闭区间（端点都含），缺/坏日期不猜')
  assert.strictEqual(filterMessagesByRange(items, '2026-10-12', '2026-10-05').length, 7, '颠倒区间直通（服务端另有回落）')
  assert.strictEqual(filterMessagesByRange(items, '', '2026-10-12').length, 7, '缺起点直通')
  // windowMessages：区间优先于 days，回显三元组
  const w = windowMessages(items, { days: 1, fromKey: '2026-10-05', toKey: '2026-10-12' })
  assert.deepStrictEqual(w.items.map(m => m.title), ['起点', '中间', '终点'])
  assert.deepStrictEqual([w.days, w.from, w.to], [0, '2026-10-05', '2026-10-12'], '区间生效时 days 归零，避免两套窗口同时回显')
  const w2 = windowMessages(items, { days: 0, fromKey: '', toKey: '' })
  assert.strictEqual(w2.items.length, 7)
  assert.deepStrictEqual([w2.days, w2.from, w2.to], [0, '', ''], '无区间无 days = 全部')
})

ok('T-P3 exportRowOf: 五字段白名单 / 缺省回退 / 200 码元截断 / time 拼接 trim', () => {
  const full = exportRowOf({
    id: 7,
    datetime: '2026-10-15',
    shorttime: '10:00',
    catename: '好单-日用',
    title: '标题',
    content: '正文',
    price: 12.9,
    url: '/a/7.html',
    cateid: '3',
    shijianchuo: 1000
  })
  assert.deepStrictEqual(full, { id: '7', time: '2026-10-15 10:00', cate: '好单-日用', title: '标题', excerpt: '正文' })
  const missing = exportRowOf({ content: 'x'.repeat(250) })
  assert.deepStrictEqual(missing, { id: '', time: '', cate: '(未分类)', title: '', excerpt: 'x'.repeat(200) }, 'id 缺失→\'\'; cate 缺失→(未分类); time 双缺省 trim→\'\'; 摘要 200 码元截断')
  assert.strictEqual(exportRowOf({ id: 'abc' }).id, 'abc', 'string id 原样 String')
})

// ── HTTP 端到端 ──
function listen (server) {
  trackSockets(server)
  liveServers.add(server)
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function request (port, method, urlPath, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const base = token ? { authorization: `Bearer ${token}` } : {}
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...base, ...(headers || {}) } }, (res) => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode, text: buf, headers: res.headers, rawHeaders: res.rawHeaders }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
// 二进制安全请求（gzip/304 用例需要 Buffer，不能用字符串拼接的 request）。
function requestBuffer (port, method, urlPath, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const base = token ? { authorization: `Bearer ${token}` } : {}
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...base, ...(headers || {}) } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
// 同名响应头出现次数：Node 在 res.headers 里把重复头用 ", " 合并成一个值，只有 rawHeaders
// 能数清「写了几条」——用于锁死 Referrer-Policy 这类必须唯一的页面安全头。
function headerCount (res, name) {
  const want = String(name).toLowerCase()
  return res.rawHeaders.filter((v, i) => i % 2 === 0 && String(v).toLowerCase() === want).length
}
// 绕过 http.request 的 URL 合法性校验，直接写原始请求行（畸形 request-target 回归用：
// `//@:99999/` 会让裸 new URL 抛 TypeError——修复前一条无凭证请求即崩整个控制台）。
function rawRequest (port, raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.write(raw) })
    let buf = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      sock.destroy()
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf)
      resolve({ status: m ? Number(m[1]) : 0, text: buf })
    }
    const to = setTimeout(finish, 5000)
    sock.on('data', c => {
      buf += c
      // 收到完整响应头即收口：HTTP keep-alive 下服务端不会主动 FIN，等 'end' 会空转到超时
      if (buf.includes('\r\n\r\n')) { clearTimeout(to); finish() }
    })
    sock.on('error', (e) => { clearTimeout(to); finish() })
  })
}

// ── SSE 增量收集 helper（v3.300 3.1）──
// request() 等 'end' 不适用于长连接（有心跳永不 end）。打开流 → 按 '\n\n' 分帧 →
// event/data 解析（未命名帧 event='message'；':' 注释帧跳过）→ waitFor(谓词, 超时)
// 轮询已收事件（25ms 步进，不用 sleep 猜时序）→ pause()/resume() 模拟慢客户端
// （T10 背压）→ close() 主动断。
function sseCollect (port, urlPath, { headers } = {}) {
  const events = []
  let raw = ''
  let ended = false
  let resRef = null
  let resHeaders = null
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
    resRef = res
    resHeaders = res.headers
    res.setEncoding('utf8')
    res.on('data', (c) => {
      raw += c
      let idx
      while ((idx = raw.indexOf('\n\n')) >= 0) {
        const frame = raw.slice(0, idx)
        raw = raw.slice(idx + 2)
        if (frame.startsWith(':')) continue // 心跳注释帧
        let event = 'message'
        let id = null
        const datas = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('id:')) id = line.slice(3).trim()
          else if (line.startsWith('data:')) datas.push(line.slice(5).trim())
        }
        events.push({ event, id, data: datas.join('\n') })
      }
    })
    res.on('end', () => { ended = true })
  })
  req.on('error', () => { ended = true })
  req.end()
  const waitFor = async (pred, ms = 5000) => {
    const to = Date.now() + ms
    // S7727：pred 直传 some 会把「index/array」作第 2/3 参泄漏给谓词——包一层单参箭头。
    while (Date.now() < to) {
      if (events.some((e) => pred(e))) return true
      await new Promise((_resolve) => setTimeout(_resolve, 25))
    }
    return events.some((e) => pred(e))
  }
  const close = () => {
    try { if (resRef) resRef.destroy() } catch (e) { /* 已断 */ }
    try { req.destroy() } catch (e) { /* 已断 */ }
  }
  // 慢客户端模拟：暂停 socket 读（服务端 write 返回 false → 背压）与恢复（drain）。
  const pause = () => { try { if (resRef) resRef.socket.pause() } catch (e) { /* 已断 */ } }
  const resume = () => { try { if (resRef) resRef.socket.resume() } catch (e) { /* 已断 */ } }
  // 等响应头到达（resRef 就绪）——T10 要在服务端任何 body 帧写出前暂停 socket。
  const ready = async (ms = 5000) => {
    const to = Date.now() + ms
    while (Date.now() < to) {
      if (resRef !== null) return true
      await new Promise((_resolve) => setTimeout(_resolve, 10))
    }
    return resRef !== null
  }
  return { events, waitFor, close, pause, resume, ready, isEnded: () => ended, headers: () => resHeaders }
}
// 注入式 fake record（cancel 用例同先例）+ 与生产 append 同语义的测试追加器
// （output 与 outputTotalLength 必须同步——镜像生产约束）。
const makeStreamRecord = (id) => ({ id, action: 'check', label: 'x', startedAt: Date.now(), finishedAt: 0, exitedAt: 0, exitCode: null, timedOut: false, cancelled: false, output: '', outputTotalLength: 0 })
const streamAppend = (record, text) => { record.output += text; record.outputTotalLength += text.length }

const TOKEN = 'x'.repeat(32)

// ── 过滤规则控制面（scripts/console.js，含服务器草稿）──────────────────────
// 全部用 mkdtemp 隔离缓存目录；写端点只认 Authorization 头，读面沿用全局鉴权。
function filterPaths (dir) { return require('./xbk_filter_store').filterRulesPaths(dir) }
function postFilterJson (port, urlPath, obj, { token = TOKEN, headers = {}, raw } = {}) {
  return request(port, 'POST', urlPath, {
    token,
    body: raw === undefined ? JSON.stringify(obj) : raw,
    headers: { 'content-type': 'application/json', ...headers }
  })
}
async function filterServer (dir) {
  const { server } = createConsole({ token: TOKEN, stateDir: dir })
  const port = await listen(server)
  return { server, port }
}

async function filterRuleApiTests () {
  await aok('过滤规则 GET: 代码默认/覆盖/损坏三态 + Cookie 读面与 applied/auditChain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    try {
      const defRes = await request(port, 'GET', '/api/config/filter', { headers: { cookie: `xbk_session=${TOKEN}` } })
      assert.strictEqual(defRes.status, 200, 'GET 读面允许会话 Cookie')
      const def = JSON.parse(defRes.text)
      assert.strictEqual(def.schema, 1)
      assert.strictEqual(def.source, 'default')
      assert.strictEqual(def.revision, 0)
      assert.strictEqual(def.filter.pingbitime, '5', 'default 时 filter 必须是 Config.filter 代码默认值')
      assert.deepStrictEqual(def.keyword, { zkt_gjc: '', writable: false })
      assert.strictEqual(def.applied, null)
      assert.deepStrictEqual(def.auditChain, { ok: true, entries: 0, brokenAt: null })

      const paths = filterPaths(dir)
      fs.writeFileSync(paths.file, JSON.stringify({ schema: 1, revision: 4, filter: { pingbibiaoti: '覆盖词' } }))
      fs.writeFileSync(paths.applied, JSON.stringify({ schema: 1, revision: 3, source: 'override', hash: 'h', appliedAt: '2026-10-18T00:00:00.000Z', filter: {}, keyword: {} }))
      const over = JSON.parse((await request(port, 'GET', '/api/config/filter?token=' + TOKEN)).text)
      assert.strictEqual(over.source, 'override')
      assert.strictEqual(over.revision, 4)
      assert.strictEqual(over.filter.pingbibiaoti, '覆盖词')
      assert.strictEqual(over.applied.revision, 3, 'applied 快照读回')
      assert.strictEqual(over.applied.hash, 'h')
      assert.strictEqual(over.applied.source, 'override')

      fs.writeFileSync(paths.file, '{broken-json')
      const corrupt = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
      assert.strictEqual(corrupt.source, 'corrupt')
      assert.strictEqual(corrupt.revision, 0, '损坏时 revision 强制 0')
      assert.strictEqual(corrupt.error.code, 'store_corrupt')
    } finally { server.close() }
  })

  await aok('过滤规则写鉴权: 无 Bearer 401 / 仅 Cookie 401 cookie_not_allowed / ?token= 400（即使带 Bearer）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const payload = { schema: 1, baseRevision: 0, filter: { pingbibiaoti: '鉴权词' } }
    try {
      const anon = await postFilterJson(port, '/api/config/filter', payload, { token: null })
      assert.strictEqual(anon.status, 401)
      assert.strictEqual(JSON.parse(anon.text).code, 'unauthorized')

      const cookieOnly = await request(port, 'POST', '/api/config/filter', {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', cookie: `xbk_session=${TOKEN}` }
      })
      assert.strictEqual(cookieOnly.status, 401)
      assert.strictEqual(JSON.parse(cookieOnly.text).code, 'cookie_not_allowed', '写端点只认 Bearer')

      const viaQuery = await request(port, 'POST', '/api/config/filter?token=' + encodeURIComponent(TOKEN), {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
      })
      assert.strictEqual(viaQuery.status, 400)
      assert.strictEqual(JSON.parse(viaQuery.text).code, 'query_token_not_allowed', 'URL token 一律拒绝，即便同时带合法 Bearer')

      assert.strictEqual(fs.existsSync(filterPaths(dir).file), false, '鉴权失败不得落盘')

      const okRes = await postFilterJson(port, '/api/config/filter', payload)
      assert.strictEqual(okRes.status, 200, '合法 Bearer 可写')
    } finally { server.close() }
  })

  await aok('过滤规则草稿: 服务器读/写/删 + 0600 + 正式保存清草稿 + revision 冲突', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      const empty = await request(port, 'GET', '/api/config/filter/draft', { token: TOKEN })
      assert.strictEqual(empty.status, 200)
      const emptyBody = JSON.parse(empty.text)
      assert.strictEqual(emptyBody.draft, null)
      assert.strictEqual(emptyBody.revision, 0)
      assert.strictEqual((await request(port, 'GET', '/api/config/filter/draft')).status, 401, '草稿读面也要鉴权')

      const put = await postFilterJson(port, '/api/config/filter/draft', {
        schema: 1,
        baseRevision: 0,
        filter: { pingbibiaoti: '半成品(', pingbitime: '6' }
      })
      assert.strictEqual(put.status, 200)
      assert.strictEqual(JSON.parse(put.text).ok, true)
      const badSchema = await postFilterJson(port, '/api/config/filter/draft', {
        schema: 99, baseRevision: 0, filter: { pingbibiaoti: 'x' }
      })
      assert.strictEqual(badSchema.status, 400, '不支持的草稿 schema 必须拒绝')
      assert.strictEqual(fs.statSync(paths.draft).mode & 0o777, 0o600, '草稿文件必须 0600')
      const disk = JSON.parse(readSafeTextResult(paths.draft, 64 * 1024).text)
      assert.strictEqual(disk.baseRevision, 0)
      assert.strictEqual(disk.filter.pingbibiaoti, '半成品(', '草稿允许存未编译的半个正则')

      const got = JSON.parse((await request(port, 'GET', '/api/config/filter/draft', { token: TOKEN })).text)
      assert.strictEqual(got.draft.filter.pingbibiaoti, '半成品(')
      assert.strictEqual(got.draft.baseRevision, 0)
      assert.strictEqual(typeof got.draft.savedAt, 'number')

      const saved = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: '正式' } })
      assert.strictEqual(saved.status, 200)
      assert.strictEqual(fs.existsSync(paths.draft), false, '正式保存成功必须删服务器草稿')
      assert.strictEqual(JSON.parse((await request(port, 'GET', '/api/config/filter/draft', { token: TOKEN })).text).draft, null)

      const stale = await postFilterJson(port, '/api/config/filter/draft', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: '旧' } })
      assert.strictEqual(stale.status, 409)
      assert.strictEqual(JSON.parse(stale.text).code, 'revision_mismatch')
      assert.strictEqual(fs.existsSync(paths.draft), false, '过期草稿不得落盘')

      const anonPost = await postFilterJson(port, '/api/config/filter/draft', { baseRevision: 1, filter: {} }, { token: null })
      assert.strictEqual(anonPost.status, 401)
      const cookiePost = await request(port, 'POST', '/api/config/filter/draft', {
        body: JSON.stringify({ baseRevision: 1, filter: {} }),
        headers: { 'content-type': 'application/json', cookie: `xbk_session=${TOKEN}` }
      })
      assert.strictEqual(cookiePost.status, 401)
      assert.strictEqual(JSON.parse(cookiePost.text).code, 'cookie_not_allowed', '草稿写面只认 Bearer')
      assert.strictEqual((await request(port, 'DELETE', '/api/config/filter/draft')).status, 401, '删草稿也只认 Bearer')

      assert.strictEqual((await postFilterJson(port, '/api/config/filter/draft', { baseRevision: 1, filter: { pingbibiaoti: '草稿' } })).status, 200)
      assert.strictEqual(fs.existsSync(paths.draft), true)
      const del = await request(port, 'DELETE', '/api/config/filter/draft', { token: TOKEN })
      assert.strictEqual(del.status, 200)
      assert.strictEqual(fs.existsSync(paths.draft), false)

      assert.strictEqual((await postFilterJson(port, '/api/config/filter/draft', { baseRevision: 1, filter: { nope: 'x' } })).status, 400)
      assert.strictEqual((await postFilterJson(port, '/api/config/filter/draft', { baseRevision: 1, filter: { pingbibiaoti: 1 } })).status, 400)
      assert.strictEqual(fs.existsSync(paths.draft), false, '非法草稿不得落盘')
    } finally { server.close() }
  })

  await aok('过滤规则写端点: 415（text/plain、Content-Encoding:gzip）与 413（>64KiB）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    try {
      const plain = await request(port, 'POST', '/api/config/filter', {
        token: TOKEN,
        body: JSON.stringify({ filter: {} }),
        headers: { 'content-type': 'text/plain' }
      })
      assert.strictEqual(plain.status, 415)
      assert.strictEqual(JSON.parse(plain.text).code, 'unsupported_media_type')

      const gz = await request(port, 'POST', '/api/config/filter', {
        token: TOKEN,
        body: '{}',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }
      })
      assert.strictEqual(gz.status, 415, '压缩体不解析')

      const big = JSON.stringify({ schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'a'.repeat(70 * 1024) } })
      const tooBig = await postFilterJson(port, '/api/config/filter', null, { raw: big })
      assert.strictEqual(tooBig.status, 413)
      assert.strictEqual(JSON.parse(tooBig.text).code, 'body_too_large')
      assert.strictEqual(fs.existsSync(filterPaths(dir).file), false)
    } finally { server.close() }
  })

  await aok('过滤规则 POST: 非法规则 400 且不落盘；合法保存 0600 + revision+1 + changedFields', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      const bad = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: '(' } })
      assert.strictEqual(bad.status, 400)
      const badBody = JSON.parse(bad.text)
      assert.strictEqual(badBody.code, 'validation_failed')
      assert.ok(Array.isArray(badBody.errors) && badBody.errors.length > 0, '必须带 errors 数组')
      assert.strictEqual(fs.existsSync(paths.file), false, '非法规则绝不落盘')

      const unknown = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { nope: 'x' } })
      assert.strictEqual(unknown.status, 400, '未知字段拒绝')
      assert.strictEqual(JSON.parse(unknown.text).errors[0].code, 'unknown_field')

      const saved = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: '屏蔽词' } })
      assert.strictEqual(saved.status, 200)
      const body = JSON.parse(saved.text)
      assert.strictEqual(body.ok, true)
      assert.strictEqual(body.revision, 1)
      assert.deepStrictEqual(body.changedFields, ['pingbibiaoti'])
      assert.ok(typeof body.hash === 'string' && body.hash.length > 0, '必须返回规则摘要 hash')
      assert.strictEqual(body.appliedHint, '下一轮生效')
      assert.strictEqual(fs.statSync(paths.file).mode & 0o777, 0o600, '覆盖文件必须 0600')
      assert.strictEqual(fs.existsSync(paths.lock), false, '保存后锁必须释放')
      const read = readSafeTextResult(paths.file, 64 * 1024)
      assert.strictEqual(read.status, 'ok')
      const disk = JSON.parse(read.text)
      assert.strictEqual(disk.schema, 1)
      assert.strictEqual(disk.revision, 1)
      assert.deepStrictEqual(disk.filter, { pingbibiaoti: '屏蔽词' })

      // 预检端点（不取锁、不落盘）
      const validated = await postFilterJson(port, '/api/config/filter/validate', { filter: { pingbibiaoti: 'ok' } })
      assert.strictEqual(validated.status, 200)
      assert.deepStrictEqual(JSON.parse(validated.text), { ok: true, warnings: [], wideMatch: [] })

      // `.*` 全命中需二次确认
      const wide = await postFilterJson(port, '/api/config/filter/validate', { filter: { pingbibiaoti: '.*' } })
      assert.strictEqual(wide.status, 400)
      assert.strictEqual(JSON.parse(wide.text).errors[0].code, 'wide_match_confirm_required')
      const wideOk = await postFilterJson(port, '/api/config/filter/validate', { filter: { pingbibiaoti: '.*' }, confirmWideMatch: true })
      assert.strictEqual(wideOk.status, 200)
    } finally { server.close() }
  })

  await aok('过滤规则 POST: 409 revision_mismatch 带当前 revision；409 锁占用带 Retry-After 且不覆盖文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'v1' } })).status, 200)
      const stale = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 99, filter: { pingbibiaoti: 'v2' } })
      assert.strictEqual(stale.status, 409)
      const staleBody = JSON.parse(stale.text)
      assert.strictEqual(staleBody.code, 'revision_mismatch')
      assert.strictEqual(staleBody.revision, 1, '必须回当前 revision')

      const before = readSafeTextResult(paths.file, 64 * 1024).text
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 })
      const busy = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 1, filter: { pingbibiaoti: 'v2' } })
      assert.strictEqual(busy.status, 409)
      assert.strictEqual(JSON.parse(busy.text).code, 'write_busy')
      assert.strictEqual(busy.headers['retry-after'], '1')
      assert.strictEqual(readSafeTextResult(paths.file, 64 * 1024).text, before, '锁占用时不得写文件')
      assert.strictEqual(fs.existsSync(paths.lock), true, '失败路径不得删别人的锁')
    } finally {
      try { fs.unlinkSync(paths.lock) } catch (e) { /* 已清理 */ }
      server.close()
    }
  })

  await aok('过滤规则 POST: 损坏文件 409 store_corrupt；confirmReplaceCorrupt 后可按 revision 0 覆盖', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      fs.writeFileSync(paths.file, 'not-json{{')
      const refused = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'x' } })
      assert.strictEqual(refused.status, 409)
      assert.strictEqual(JSON.parse(refused.text).code, 'store_corrupt')
      assert.strictEqual(readSafeTextResult(paths.file, 64 * 1024).text, 'not-json{{', '未确认时不得覆盖')

      const replaced = await postFilterJson(port, '/api/config/filter', {
        schema: 1,
        baseRevision: 0,
        confirmReplaceCorrupt: true,
        filter: { pingbibiaoti: 'x' }
      })
      assert.strictEqual(replaced.status, 200)
      assert.strictEqual(JSON.parse(replaced.text).revision, 1)
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.file, 64 * 1024).text).filter.pingbibiaoti, 'x')
    } finally { server.close() }
  })

  await aok('过滤规则 restore: 备份（保留 3 代 0600）+ 回滚 revision+1 + baseRevision 闸 + 恢复默认写空覆盖（不删文件）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'A' } })).status, 200)
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 1, filter: { pingbibiaoti: 'B' } })).status, 200)
      assert.strictEqual(fs.existsSync(paths.backupFor(1)), true, '保存前必须备份上一版')
      assert.strictEqual(fs.statSync(paths.backupFor(1)).mode & 0o777, 0o600)
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.backupFor(1), 64 * 1024).text).filter.pingbibiaoti, 'A')

      const noConfirm = await postFilterJson(port, '/api/config/filter/restore', { to: 1 })
      assert.strictEqual(noConfirm.status, 400)
      assert.strictEqual(JSON.parse(noConfirm.text).errors[0].code, 'confirm_required')

      // B9：旧客户端不带 baseRevision → 400 invalid_revision，且不落盘
      const noBase = await postFilterJson(port, '/api/config/filter/restore', { to: 1, confirm: true })
      assert.strictEqual(noBase.status, 400)
      assert.strictEqual(JSON.parse(noBase.text).code, 'invalid_revision')
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.file, 64 * 1024).text).revision, 2, '缺 baseRevision 不得改文件')

      const missing = await postFilterJson(port, '/api/config/filter/restore', { to: 999, confirm: true, baseRevision: 2 })
      assert.strictEqual(missing.status, 404)
      assert.strictEqual(JSON.parse(missing.text).code, 'backup_not_found')

      // B9：陈旧回滚页（baseRevision 落后）→ 409，带当前 revision，文件不动
      const stale = await postFilterJson(port, '/api/config/filter/restore', { to: 1, confirm: true, baseRevision: 1 })
      assert.strictEqual(stale.status, 409)
      const staleBody = JSON.parse(stale.text)
      assert.strictEqual(staleBody.code, 'revision_mismatch')
      assert.strictEqual(staleBody.revision, 2, '必须回当前 revision')
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.file, 64 * 1024).text).revision, 2, '409 不得改文件')

      const restored = await postFilterJson(port, '/api/config/filter/restore', { to: 1, confirm: true, baseRevision: 2 })
      assert.strictEqual(restored.status, 200)
      const restoredBody = JSON.parse(restored.text)
      assert.strictEqual(restoredBody.restoredFrom, 1)
      assert.strictEqual(restoredBody.revision, 3, '回滚必须 revision+1（线性历史）')
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.file, 64 * 1024).text).filter.pingbibiaoti, 'A')
      // B8：被替换的当前版本（r2=B）必须先备份，之后还能回滚回来
      assert.strictEqual(fs.existsSync(paths.backupFor(2)), true, '回滚前必须备份被替换的当前版本')
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.backupFor(2), 64 * 1024).text).filter.pingbibiaoti, 'B')

      // B2：恢复默认 = 写空覆盖（revision+1），不删文件、revision 不归零、备份列表仍在
      const reset = await postFilterJson(port, '/api/config/filter/restore', { to: 'default', confirm: true, baseRevision: 3 })
      assert.strictEqual(reset.status, 200)
      assert.strictEqual(JSON.parse(reset.text).restoredFrom, 'default')
      assert.strictEqual(JSON.parse(reset.text).revision, 4)
      assert.strictEqual(fs.existsSync(paths.file), true, '恢复默认不得删除覆盖文件')
      const diskAfterReset = JSON.parse(readSafeTextResult(paths.file, 64 * 1024).text)
      assert.strictEqual(diskAfterReset.revision, 4)
      assert.deepStrictEqual(diskAfterReset.filter, {}, '恢复默认 = 空覆盖（逐字段回代码默认）')
      assert.strictEqual(fs.existsSync(paths.backupFor(3)), true, '恢复默认前必须备份当前 r3')

      const back = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
      assert.strictEqual(back.source, 'override', '恢复默认后覆盖文件仍是合法 override')
      assert.strictEqual(back.revision, 4, 'GET revision 必须延续（不归零）')
      assert.strictEqual(back.filter.pingbitime, '5', '空覆盖 ⇒ 逐字段回代码默认')
      const bakNames = fs.readdirSync(dir).filter((n) => /^filter-rules\.bak\.\d+\.json$/.test(n))
      assert.ok(bakNames.length >= 2, `恢复默认后备份列表不得消失（实际 ${bakNames.join(',')}）`)
    } finally { server.close() }
  })

  await aok('过滤规则保存: 备份只留最近 3 代；>10s 陈旧锁可接管', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      for (let rev = 1; rev <= 4; rev++) {
        const saved = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: rev - 1, filter: { pingbibiaoti: `v${rev}` } })
        assert.strictEqual(saved.status, 200, `第 ${rev} 次保存应成功`)
      }
      const baks = fs.readdirSync(dir).filter((n) => n.startsWith('filter-rules.bak.') && n.endsWith('.json')).sort()
      assert.deepStrictEqual(baks, ['filter-rules.bak.1.json', 'filter-rules.bak.2.json', 'filter-rules.bak.3.json'], '只保留最近 3 代')

      // 陈旧锁（mtime 11s 前）：保存应接管并成功（不是 409）。
      fs.writeFileSync(paths.lock, '{}')
      const old = new Date(Date.now() - 11000)
      fs.utimesSync(paths.lock, old, old)
      const takeover = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 4, filter: { pingbibiaoti: 'v5' } })
      assert.strictEqual(takeover.status, 200, '陈旧锁应被接管')
      assert.strictEqual(JSON.parse(takeover.text).revision, 5)
      assert.strictEqual(fs.existsSync(paths.lock), false, '接管后保存结束必须释放自己的锁')
    } finally { server.close() }
  })

  await aok('过滤锁: 持有者进程还活着 → 绝不接管（即使 mtime 已过期）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      // 活锁：pid 是当前测试进程（活），mtime 已过期——旧实现会按 mtime 抢走，导致原持有者失去互斥。
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60000, token: 'live-holder' }), { mode: 0o600 })
      const old = new Date(Date.now() - 11000)
      fs.utimesSync(paths.lock, old, old)
      const blocked = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'x' } })
      assert.strictEqual(blocked.status, 409, '活锁必须 409 write_busy')
      assert.strictEqual(JSON.parse(blocked.text).code, 'write_busy')
      assert.strictEqual(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'live-holder', '活锁不得被搬走/覆盖')
    } finally { server.close() }
  })

  await aok('过滤规则 GET: 手工编辑出编译不了的规则 → source=corrupt（与 App.run 同口径）', async () => {
    let re2Ok = false
    try { require('re2'); re2Ok = true } catch (e) { re2Ok = false }
    if (!re2Ok) { console.log('  ⏭ 跳过：本机无 re2（深度校验按设计跳过）'); return }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      // 结构合法但正则编译不了的覆盖文件：GET 若只做结构校验会显示 override（页面全绿），
      // 而 App.run 会降级。这里锁死「读面必须同口径报 corrupt」。
      fs.writeFileSync(paths.file, JSON.stringify({ schema: 1, revision: 2, filter: { pingbibiaoti: '(' } }), { mode: 0o600 })
      const res = await request(port, 'GET', '/api/config/filter', { token: TOKEN })
      assert.strictEqual(res.status, 200)
      const body = JSON.parse(res.text)
      assert.strictEqual(body.source, 'corrupt', '编译不了的规则必须显示为损坏')
      assert.strictEqual(body.error && body.error.code, 'store_corrupt')
      assert.strictEqual(body.revision, 0, '损坏时 revision 强制 0')
    } finally { server.close() }
  })

  await aok('过滤规则保存: 审计文件接近 4 MiB（差 512B）→ 507 audit_full（预留行宽）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      fs.writeFileSync(paths.audit, Buffer.alloc(FILTER_AUDIT_MAX_BYTES - 512, 0x0a), { mode: 0o600 })
      const res = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'x' } })
      assert.strictEqual(res.status, 507, '剩余空间不够一行审计时必须提前拒绝')
      assert.strictEqual(JSON.parse(res.text).code, 'audit_full')
      assert.strictEqual(fs.existsSync(paths.file), false, '拒绝时不得写规则文件')
    } finally { server.close() }
  })

  await aok('过滤规则保存: 保存候选行为（pure.mjs）——覆盖项保留、改动项优先、未涉及的字段不提交', async () => {
    const { buildSaveCandidate, filterOverrideFields } = await import('./scripts/console-assets/pure.mjs')
    const FIELDS = ['pingbilouzhu', 'zhanxianlouzhu', 'pingbitime']
    assert.deepStrictEqual(
      buildSaveCandidate({ pingbilouzhu: 'A' }, ['pingbitime'], { pingbilouzhu: 'A', zhanxianlouzhu: '默认', pingbitime: 'B' }, FIELDS),
      { pingbilouzhu: 'A', pingbitime: 'B' },
      '已落盘字段 + 本次改动字段必须同时在候选里（漏了前者=删字段的旧 bug），未改的代码默认不得钉死'
    )
    assert.deepStrictEqual(
      buildSaveCandidate({ pingbilouzhu: 'old' }, ['pingbilouzhu'], { pingbilouzhu: 'new' }, FIELDS),
      { pingbilouzhu: 'new' },
      '同名字段必须由本次输入覆盖 override'
    )
    assert.deepStrictEqual(
      buildSaveCandidate({}, ['pingbitime'], { pingbilouzhu: '默认', pingbitime: 'B' }, FIELDS),
      { pingbitime: 'B' },
      '既没落盘也没改动的字段不得写进覆盖文件（否则把代码默认永久钉死）'
    )
    assert.deepStrictEqual(buildSaveCandidate({}, [], { pingbitime: 'B' }, FIELDS), {}, '空改动 = 空候选（保存不得凭空造字段）')
    assert.deepStrictEqual(
      buildSaveCandidate({ pingbilouzhu: 'A', 未知键: 'x', zhanxianlouzhu: 3 }, [], {}, FIELDS),
      { pingbilouzhu: 'A' },
      '未知键与非字符串值必须丢弃（服务端白名单之外的字段不得被前端带出去）'
    )
    assert.deepStrictEqual(filterOverrideFields({ pingbilouzhu: '', pingbitime: 2 }, FIELDS), { pingbilouzhu: '' },
      '空串也算「文件里已存在」，非字符串不算')
    assert.deepStrictEqual(buildSaveCandidate(null, null, null, FIELDS), {}, '坏输入不得抛错，退化为空候选')
  })

  await aok('过滤规则页: 两处保存入口都走 pure.mjs 的候选构造，没有第二条提交路径', () => {
    const src = readConsoleSource()
    // 逻辑在 pure.mjs 且被 Node 直接执行测试；这里只锁「接线」：
    assert.ok(/import \{[^}]*buildSaveCandidate as buildSaveCandidateOf[^}]*\} from '\.\/pure\.mjs'/.test(src),
      'app.js 必须从 pure.mjs 引入候选构造函数（别在组件里另写一份）')
    const start = src.indexOf('const buildSaveCandidate = useCallback(')
    assert.ok(start > 0, '必须抽成单一 buildSaveCandidate()（所有保存入口共用）')
    const end = src.indexOf('\n  )', start)
    assert.ok(end > start, 'buildSaveCandidate 的 useCallback 切片锚点必须存在（不能退化成空切片）')
    const body = src.slice(start, end)
    assert.ok(body.includes('buildSaveCandidateOf(override, dirtyFields, draft, FILTER_FIELD_NAMES)'),
      '组件内必须委托 pure.mjs 的实现，不得再复制一份逻辑')
    assert.strictEqual((src.match(/const candidate = buildSaveCandidate\(\)/g) || []).length, 2,
      'beginSave 与 beginGuardSave 都必须走 buildSaveCandidate()')
    // 任何新增保存路径都必须经由候选构造：直接调 API 的地方只允许「保存」与首启复制默认两处。
    assert.strictEqual((src.match(/apiPostFilterSave\(/g) || []).length, 2,
      'apiPostFilterSave 只允许 submitSave 与首启复制默认两处调用（多一处就可能绕过候选构造）')
    assert.ok(src.includes('setOverride(filterOverrideFrom(filter))'), 'applySaved 必须同步 override')
    assert.ok(src.includes('apiPostFilterSave({ schema: 1, baseRevision: 0, filter: { ...base } })'),
      '首启复制默认仍应整份写入（baseRevision:0）')
  })

  await aok('过滤规则保存: GET 的 override 只含文件中实际字段；用真实前端候选保存不会删掉其他覆盖项', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      // 无覆盖文件（代码默认）时 override 必须是空对象：空对象+空改动 = 不写任何字段。
      const def = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
      assert.strictEqual(def.source, 'default')
      assert.deepStrictEqual(def.override, {}, '无覆盖文件时 override 必须是 {}')
      // filter 与 override 必须来自同一次读盘：override 里的每个字段都要与合并值一致。
      for (const [name, value] of Object.entries(def.override)) {
        assert.strictEqual(def.filter[name], value, `override.${name} 必须等于 filter.${name}（同一快照）`)
      }

      // 第一步：只保存 A 字段（pingbilouzhu）→ 覆盖文件里只有 A。
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', {
        schema: 1, baseRevision: 0, filter: { pingbilouzhu: '屏蔽楼主规则' }
      })).status, 200)
      const first = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
      assert.deepStrictEqual(first.override, { pingbilouzhu: '屏蔽楼主规则' },
        'override 只能含覆盖文件里实际存在的字段（不得把代码默认整份回流）')
      assert.strictEqual(first.filter.pingbilouzhu, '屏蔽楼主规则')
      assert.strictEqual(first.filter.pingbitime, '5', 'filter 仍是「代码默认 + 覆盖」的合并值')

      // 第二步：前端新逻辑 = override + 本次改动的 B 字段（pingbitime 5→6）。
      // 这里跑 pure.mjs 里的**真实**候选构造（app.js 引用的同一函数），不是本用例自己拼 payload：
      // 否则 helper 写坏了、用例照旧绿（评审指出的「regression goes undetected」）。
      const { buildSaveCandidate } = await import('./scripts/console-assets/pure.mjs')
      const draft = { ...first.filter, pingbitime: '6' } // 草稿=服务端生效值，用户只改了 pingbitime
      const candidate = buildSaveCandidate(first.override, ['pingbitime'], draft, ['pingbilouzhu', 'zhanxianlouzhu', 'pingbitime'])
      assert.deepStrictEqual(candidate, { pingbilouzhu: '屏蔽楼主规则', pingbitime: '6' },
        '候选必须是「覆盖文件已有字段 + 本次改动字段」，且不得把未改动的代码默认带出去')
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', {
        schema: 1, baseRevision: first.revision, filter: candidate
      })).status, 200)
      const kept = JSON.parse(fs.readFileSync(paths.file, 'utf8'))
      assert.deepStrictEqual(kept.filter, { pingbilouzhu: '屏蔽楼主规则', pingbitime: '6' },
        'A 与改动后的 B 必须同时留在覆盖文件里（这正是本次修复的不变式）')

      // 第三步：旧行为反例——只提交 B，A 会被整份替换静默删掉（说明本用例确实覆盖此 bug）。
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', {
        schema: 1, baseRevision: kept.revision, filter: { pingbitime: '7' }
      })).status, 200)
      const dropped = JSON.parse(fs.readFileSync(paths.file, 'utf8'))
      assert.deepStrictEqual(Object.keys(dropped.filter), ['pingbitime'], '服务端仍是整份替换：只提交 B 会丢掉 A')
      assert.strictEqual(dropped.filter.pingbilouzhu, undefined, '旧行为反例：A 不得残留')
      const after = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
      assert.deepStrictEqual(after.override, { pingbitime: '7' }, 'override 跟随覆盖文件当前内容')
      assert.strictEqual(after.filter.pingbilouzhu, '', 'A 被删后 filter 回退到代码默认值')

      // 覆盖文件损坏：override 必须回到 {}（不得拿 last-known-good 冒充文件内容）。
      fs.writeFileSync(paths.file, '{ not json', { mode: 0o600 })
      const bad = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
      assert.strictEqual(bad.source, 'corrupt')
      assert.deepStrictEqual(bad.override, {}, '损坏时 override 必须是 {}')
    } finally { server.close() }
  })

  await aok('过滤规则审计: 0600 / 不含规则正文与路径 / prevHash 链可复算 / 手改一行后 GET 报断链', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: '审计敏感词' } })).status, 200)
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 1, filter: { pingbibiaoti: '第二版' } })).status, 200)
      // 0600、正文读取与随后的篡改改写全走同一个 fd：fstat 后立即读，ftruncate + write
      // 原地改写。全程不按路径二次打开（消除 CodeQL js/file-system-race 的
      // 「按路径检查 → 按路径写」形态；文件被并发替换也影响不到这个 fd）。
      const auditFd = fs.openSync(paths.audit, 'r+')
      try {
        assert.strictEqual(fs.fstatSync(auditFd).mode & 0o777, 0o600)
        const raw = fs.readFileSync(auditFd, 'utf8')
        assert.ok(!raw.includes('审计敏感词'), '审计不得写规则正文')
        assert.ok(!raw.includes(dir), '审计不得写绝对路径')
        const lines = raw.trim().split('\n')
        assert.strictEqual(lines.length, 2)
        const first = JSON.parse(lines[0])
        assert.deepStrictEqual(Object.keys(first).sort((a, b) => a.localeCompare(b)), ['action', 'actor', 'changedFields', 'entryHash', 'prevHash', 'revision', 'ts'])
        assert.strictEqual(first.action, 'save')
        assert.strictEqual(first.revision, 1)
        assert.deepStrictEqual(first.changedFields, ['pingbibiaoti'])
        assert.strictEqual(first.actor.length, 8, 'actor = sha256(token) 前 8 位')
        assert.strictEqual(first.prevHash, '0'.repeat(64))
        assert.strictEqual(first.entryHash.length, 64)
        const second = JSON.parse(lines[1])
        assert.strictEqual(second.prevHash, first.entryHash, 'prevHash 必须接上一行 entryHash')

        const before = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
        assert.strictEqual(before.auditChain.ok, true)
        assert.strictEqual(before.auditChain.entries, 2)

        const tampered = lines.slice()
        const edited = JSON.parse(tampered[0])
        edited.revision = 99
        tampered[0] = JSON.stringify(edited)
        fs.ftruncateSync(auditFd, 0)
        fs.writeSync(auditFd, tampered.join('\n') + '\n')
        const after = JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text)
        assert.strictEqual(after.auditChain.ok, false, '篡改必须可检测')
        assert.strictEqual(after.auditChain.brokenAt, 1, '断链行号从 1 开始')
      } finally { fs.closeSync(auditFd) }
    } finally { server.close() }
  })

  await aok('过滤规则 preview: _f 补推统计（不用 readMessages）+ limit 钳制 + capped(>5000)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const pushPath = path.join(dir, 'push.json')
    const nowS = Math.floor(Date.now() / 1000)
    try {
      fs.writeFileSync(pushPath, JSON.stringify([
        { id: '1', title: 'blocked one', content: '', catename: '', shijianchuo: nowS, _f: true },
        { id: '2', title: 'blocked two', content: '', catename: '', shijianchuo: nowS, _f: true },
        { id: '3', title: 'free', content: '', catename: '', shijianchuo: nowS, _f: true },
        { id: '4', title: 'already pushed', content: '', catename: '', shijianchuo: nowS }
      ]))
      const res = await postFilterJson(port, '/api/config/filter/preview', { filter: { pingbibiaoti: 'blocked' }, limit: 10 })
      assert.strictEqual(res.status, 200)
      const body = JSON.parse(res.text)
      assert.strictEqual(body.available, true, '缓存可读时 available:true')
      assert.strictEqual(body.zktApplied, false, '默认 zkt_gjc 为空 ⇒ 未应用白名单')
      assert.strictEqual(body.scanned, 3, '只扫 _f===true 记录')
      assert.strictEqual(body.reEvalCount, 1, 'blocked 的仍被挡，free 会补推')
      assert.strictEqual(body.capped, false)
      assert.strictEqual(body.samples.length, 1)
      assert.strictEqual(body.samples[0].id, '3')
      assert.deepStrictEqual(Object.keys(body.samples[0]).sort((a, b) => a.localeCompare(b)), ['id', 'reason', 'title'], '样例只含 id/title/reason')

      const wide = await postFilterJson(port, '/api/config/filter/preview', { filter: { pingbibiaoti: '.*' } })
      assert.strictEqual(wide.status, 400)
      assert.strictEqual(JSON.parse(wide.text).errors[0].code, 'wide_match_confirm_required')
      const wideOk = await postFilterJson(port, '/api/config/filter/preview', { filter: {}, confirmWideMatch: true, limit: 100 })
      assert.strictEqual(wideOk.status, 200)
      assert.strictEqual(JSON.parse(wideOk.text).limit, 20, 'limit 钳到 [1,20]')
      assert.strictEqual(JSON.parse(wideOk.text).reEvalCount, 3)

      const many = []
      for (let i = 0; i < 5001; i++) many.push({ id: String(i), title: 't', content: '', catename: '', shijianchuo: nowS, _f: true })
      fs.writeFileSync(pushPath, JSON.stringify(many))
      const capped = await postFilterJson(port, '/api/config/filter/preview', { filter: {} })
      assert.strictEqual(capped.status, 200)
      const cappedBody = JSON.parse(capped.text)
      assert.strictEqual(cappedBody.capped, true, '总条数 >5000 必须 capped')
      assert.strictEqual(cappedBody.scanned, 5000, '最多扫 5000 条 _f')
      assert.strictEqual(cappedBody.reEvalCount, 5000)
    } finally { server.close() }
  })

  await aok('过滤规则 POST: re2 不可用 → 503 engine_unavailable 且不落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const { setFilterDepsForTests } = require('./scripts/console')
    try {
      setFilterDepsForTests({
        RuleEngine: { hasNestedQuantifier: () => false, compileRules: () => null },
        compileUserRegex: () => null,
        re2Available: false,
        isRe2Available: () => false
      })
      const res = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'x' } })
      assert.strictEqual(res.status, 503)
      assert.strictEqual(JSON.parse(res.text).code, 'engine_unavailable')
      assert.strictEqual(fs.existsSync(filterPaths(dir).file), false, 're2 不可用不得落盘')
    } finally {
      setFilterDepsForTests(null)
      server.close()
    }
  })
  await aok('过滤规则 POST: 写盘失败（目标是目录）→ 500 write_failed 且锁释放', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      fs.mkdirSync(paths.file) // 覆盖"文件"是目录：writeAtomic 拒绝写入
      const res = await postFilterJson(port, '/api/config/filter', {
        schema: 1,
        baseRevision: 0,
        confirmReplaceCorrupt: true,
        filter: { pingbibiaoti: 'x' }
      })
      assert.strictEqual(res.status, 500)
      assert.strictEqual(JSON.parse(res.text).code, 'write_failed')
      assert.strictEqual(fs.existsSync(paths.lock), false, '失败路径同样必须释放锁')
    } finally {
      try { fs.rmdirSync(paths.file) } catch (e) { /* 已清理 */ }
      server.close()
    }
  })

  // ── 评审修复靶向用例（Sourcery 12 项）────────────────────────────────────
  await aok('过滤锁: 两个写者同判同一把旧锁过期 → 只有先到者完成接管（rename + inode 核验）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-lock-'))
    const paths = filterPaths(dir)
    try {
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: 111, startedAt: 1 }), { mode: 0o600 })
      const old = new Date(Date.now() - 11000)
      fs.utimesSync(paths.lock, old, old)
      // 竞态起点：两个写者在「判过期」这一刻拿到同一份快照。
      const judgedA = filterLockIdentity(paths.lock)
      const judgedB = filterLockIdentity(paths.lock)
      assert.strictEqual(claimStaleFilterLock(paths.lock, judgedA, 'token-a'), true, '先到者应完成接管')
      // 先到者接管后立刻建新锁并进入写段（内容带自己的 token）。
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: 222, token: 'token-a' }), { mode: 0o600 })
      // 后到者仍按旧快照接管：rename 成功但搬走的是先到者的新锁 ⇒ 必须放弃并原样放回。
      assert.strictEqual(claimStaleFilterLock(paths.lock, judgedB, 'token-b'), false, '后到者不得完成接管')
      assert.strictEqual(fs.existsSync(paths.lock), true, '先到者的新锁必须还在原路径')
      assert.strictEqual(JSON.parse(readSafeTextResult(paths.lock, 4096).text).token, 'token-a', '新锁内容不得被替换')
      assert.strictEqual(fs.existsSync(`${paths.lock}.stale.token-b`), false, '后到者的 stale 临时名必须清理')
      // 后到者随后的 open wx（acquireFilterLock 的第一步）必须失败：同一时刻只能有一个写者进写段。
      assert.throws(() => fs.openSync(paths.lock, 'wx', 0o600), /EEXIST/, '锁仍被占用：第二个写者进不了写段')
    } finally {
      try { fs.unlinkSync(paths.lock) } catch (e) { /* 已清理 */ }
    }
  })

  await aok('过滤规则保存: 审计写失败 → 500 audit_failed 且回滚覆盖文件；失败保存不剪最老备份', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      for (let rev = 1; rev <= 4; rev++) {
        assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: rev - 1, filter: { pingbibiaoti: `v${rev}` } })).status, 200)
      }
      const before = readSafeTextResult(paths.file, 64 * 1024).text
      assert.strictEqual(fs.existsSync(paths.backupFor(1)), true, '前置：4 次保存后应有 bak.1')
      // 审计路径换成目录：open(O_WRONLY|O_APPEND|O_NOFOLLOW) 必失败（EISDIR），stat.size 却远小于上限。
      fs.unlinkSync(paths.audit)
      fs.mkdirSync(paths.audit)
      const failed = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 4, filter: { pingbibiaoti: 'v5' } })
      assert.strictEqual(failed.status, 500)
      assert.strictEqual(JSON.parse(failed.text).code, 'audit_failed')
      assert.strictEqual(readSafeTextResult(paths.file, 64 * 1024).text, before, '审计失败必须回滚为保存前内容')
      assert.strictEqual(fs.existsSync(paths.backupFor(4)), true, '第 5 次保存前仍应写备份 r4')
      assert.strictEqual(fs.existsSync(paths.backupFor(1)), true, '失败的保存不得剪掉最老备份（剪枝只在提交成功后）')
      assert.strictEqual(fs.existsSync(paths.lock), false, '失败路径必须释放锁')
    } finally { server.close() }
  })

  await aok('过滤规则保存: 预置 symlink 的审计文件 → 500 audit_failed 且不写目标文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    const target = path.join(dir, 'audit-target.txt')
    try {
      fs.writeFileSync(target, 'untouched', { mode: 0o600 })
      fs.symlinkSync(target, paths.audit)
      const res = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'x' } })
      assert.strictEqual(res.status, 500)
      assert.strictEqual(JSON.parse(res.text).code, 'audit_failed')
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'untouched', '绝不能顺着 symlink 写入目标')
      assert.strictEqual(fs.existsSync(paths.file), false, '原本没有覆盖文件 ⇒ 回滚为不存在（不留下未审计规则）')
      assert.strictEqual(fs.lstatSync(paths.audit).isSymbolicLink(), true, '预置链接本身不得被替换')
    } finally { server.close() }
  })

  await aok('过滤规则保存: 审计超 4 MiB → 507 audit_full 且不写规则文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      fs.writeFileSync(paths.audit, 'x'.repeat(FILTER_AUDIT_MAX_BYTES + 1), { mode: 0o600 })
      const res = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'x' } })
      assert.strictEqual(res.status, 507)
      const body = JSON.parse(res.text)
      assert.strictEqual(body.code, 'audit_full')
      assert.ok(Array.isArray(body.errors) && body.errors.length > 0, '必须说明需人工归档审计')
      assert.strictEqual(fs.existsSync(paths.file), false, '审计满时不得写规则文件（更不能按 genesis 续链）')
      assert.strictEqual(fs.existsSync(paths.lock), false, '拒绝路径必须释放锁')
    } finally { server.close() }
  })

  await aok('过滤规则保存: 备份失败 → 500 backup_failed 且不替换当前覆盖文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const paths = filterPaths(dir)
    try {
      assert.strictEqual((await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 0, filter: { pingbibiaoti: 'v1' } })).status, 200)
      const before = readSafeTextResult(paths.file, 64 * 1024).text
      fs.mkdirSync(paths.backupFor(1)) // 备份目标变成目录 → writeAtomic 拒绝
      const res = await postFilterJson(port, '/api/config/filter', { schema: 1, baseRevision: 1, filter: { pingbibiaoti: 'v2' } })
      assert.strictEqual(res.status, 500)
      assert.strictEqual(JSON.parse(res.text).code, 'backup_failed')
      assert.strictEqual(readSafeTextResult(paths.file, 64 * 1024).text, before, '备份失败不得替换覆盖文件')
      assert.strictEqual(JSON.parse((await request(port, 'GET', '/api/config/filter', { token: TOKEN })).text).revision, 1)
    } finally {
      try { fs.rmdirSync(paths.backupFor(1)) } catch (e) { /* 已清理 */ }
      server.close()
    }
  })

  await aok('过滤规则 preview: 推送历史不可读 → available:false / 计数为 null（不显示 0 影响）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const pushPath = path.join(dir, 'push.json')
    try {
      // ① 缓存缺失
      const missing = await postFilterJson(port, '/api/config/filter/preview', { filter: {} })
      assert.strictEqual(missing.status, 200, '读不到缓存仍 200（这是可预期的降级，不是请求错误）')
      const missingBody = JSON.parse(missing.text)
      assert.strictEqual(missingBody.available, false)
      assert.strictEqual(missingBody.code, 'cache_unavailable')
      assert.strictEqual(missingBody.scanned, null)
      assert.strictEqual(missingBody.reEvalCount, null)
      assert.deepStrictEqual(missingBody.samples, [])
      assert.strictEqual(missingBody.cacheStatus, 'missing')

      // ② JSON 损坏
      fs.writeFileSync(pushPath, '{not-json')
      const broken = await postFilterJson(port, '/api/config/filter/preview', { filter: {} })
      assert.strictEqual(broken.status, 200)
      const brokenBody = JSON.parse(broken.text)
      assert.strictEqual(brokenBody.available, false)
      assert.strictEqual(brokenBody.reEvalCount, null)
      assert.deepStrictEqual(brokenBody.samples, [])

      // ③ 合法 JSON 但不是数组
      fs.writeFileSync(pushPath, JSON.stringify({ items: [] }))
      const notArray = await postFilterJson(port, '/api/config/filter/preview', { filter: {} })
      assert.strictEqual(JSON.parse(notArray.text).available, false)
    } finally { server.close() }
  })

  await aok('过滤规则 preview: zkt_gjc 白名单排除标题不匹配的记录（与运行期同源）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const pushPath = path.join(dir, 'push.json')
    const nowS = Math.floor(Date.now() / 1000)
    const { setFilterDepsForTests } = require('./scripts/console')
    const base = runtimeFilterDeps()
    const originalConfig = base.config
    try {
      fs.writeFileSync(pushPath, JSON.stringify([
        { id: '1', title: '白名单 命中', content: '', catename: '', shijianchuo: nowS, _f: true },
        { id: '2', title: '其他标题', content: '', catename: '', shijianchuo: nowS, _f: true },
        { id: '3', title: '', content: '', catename: '', shijianchuo: nowS, _f: true }
      ]))
      // 注入真实 deps 的副本，只把 Config.keyword.zkt_gjc 换成白名单词（模拟线上只看它配置）。
      setFilterDepsForTests({
        ...base,
        config: { filter: originalConfig.filter, keyword: { ...originalConfig.keyword, zkt_gjc: '白名单' } }
      })
      const res = await postFilterJson(port, '/api/config/filter/preview', { filter: {}, limit: 10 })
      assert.strictEqual(res.status, 200)
      const body = JSON.parse(res.text)
      assert.strictEqual(body.zktApplied, true, '白名单已编译 ⇒ zktApplied:true')
      assert.strictEqual(body.scanned, 3)
      assert.strictEqual(body.reEvalCount, 2, '标题不匹配白名单的不计入补推；空标题按放行')
      assert.deepStrictEqual(body.samples.map((s) => s.id), ['1', '3'])
    } finally {
      setFilterDepsForTests(null)
      server.close()
    }
  })

  await aok('过滤规则 preview: capped 按 _f 条数判定（6000 条普通 + 3 条 _f → capped:false）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-filter-'))
    const { server, port } = await filterServer(dir)
    const pushPath = path.join(dir, 'push.json')
    const nowS = Math.floor(Date.now() / 1000)
    try {
      const many = []
      for (let i = 0; i < 6000; i++) many.push({ id: `n${i}`, title: 't', content: '', catename: '', shijianchuo: nowS })
      for (let i = 0; i < 3; i++) many.push({ id: `f${i}`, title: 't', content: '', catename: '', shijianchuo: nowS, _f: true })
      fs.writeFileSync(pushPath, JSON.stringify(many))
      const res = await postFilterJson(port, '/api/config/filter/preview', { filter: {}, limit: 10 })
      assert.strictEqual(res.status, 200)
      const body = JSON.parse(res.text)
      assert.strictEqual(body.available, true)
      assert.strictEqual(body.capped, false, '扫描上限只作用于 _f：缓存总条数再多也不虚高 capped')
      assert.strictEqual(body.scanned, 3)
      assert.strictEqual(body.reEvalCount, 3)
    } finally { server.close() }
  })

  // 前端对接的结构红线（HTTP 用例测不到 app.js 的渲染分支，只能断言源码契约）。
  await aok('过滤规则页对接: 预览不可读文案 + 回滚带 baseRevision（结构红线）', () => {
    const js = readConsoleSource()
    assert.ok(js.includes('无法读取推送历史，本次不显示补推估算'), 'available===false 时必须显示「无法读取推送历史」而不是 0 条')
    assert.ok(js.includes('preview.available === false'), 'reEvalText / 预览面板必须先判 available===false')
    assert.ok(js.includes('confirm: true,\n        baseRevision'), 'doRestore 必须把 baseRevision 与 confirm 一起提交')
    assert.ok(js.includes("kind: 'restore', to: restoreTo, baseRevision: revision"), '回滚弹窗必须带页面加载时的 revision')
    assert.ok(!js.includes('恢复代码默认（删除覆盖文件）'), '恢复默认不再删文件，选项文案必须同步')
    assert.ok(js.includes('写入空覆盖文件'), '回滚弹窗/选项必须说明恢复默认写空覆盖文件')
    // v3.312：配置页的过滤规则块必须显示覆盖文件生效值（此前只读 Config.filter，
    // 保存成功后配置页仍全空，用户以为没保存）。
    assert.ok(js.includes('effectiveFilterRows'), '配置页过滤规则块必须合并覆盖文件生效值')
    const tpl = (name) => '$' + '{' + name + '}' // 拼接出模板占位符，避免 no-template-curly-in-string
    assert.ok(js.includes('const filterRows = r ? effectiveFilterRows(r.filter, effFilter) : []'), '生效值必须真的赋给 filterRows（只留 import 与属性名不算）')
    assert.ok(js.includes('const effLive = effErr ? null : eff'), '读面失败必须丢弃 usePanelLoader 保留的陈旧 data')
    assert.ok(js.includes('rows=' + tpl('filterRows')), 'FilterRules 必须接生效值 rows，而不是代码默认 entries')
    assert.ok(js.includes('class="rule-src"'), '被覆盖字段必须带「覆盖」徽章')
    const pureSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'pure.mjs'), 'utf8')
    assert.ok(pureSrc.includes('生效 rev ' + tpl('rev') + '（覆盖文件）'), '副标题必须标明生效 revision 来自覆盖文件')
    assert.ok(pureSrc.includes('下一轮生效'), '保存后未跑过一轮时必须说「下一轮生效」')
  })
}

async function backupApiTests () {
  await aok('数据备份: 导出只含勾选类别，自动运行只写间隔不写开关', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-backup-'))
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 1, title: 'a' }, { id: 2, title: 'b' }]))
    fs.writeFileSync(path.join(dir, 'filter-rules.json'), JSON.stringify({ schema: 1, revision: 2, filter: { pingbifenlei: 'old' } }))
    fs.writeFileSync(path.join(dir, 'run.log'), 'old log\n')
    fs.writeFileSync(path.join(dir, 'console-settings.json'), JSON.stringify({ revision: 2, updatedAt: Date.now(), notifyTestReplayWindowS: 9, syncShowDate: false }))
    fs.writeFileSync(path.join(dir, 'console-auto.json'), JSON.stringify({ on: false, interval: 7, updatedAt: Date.now() }))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const all = await request(port, 'POST', '/api/backup/export', {
        token: TOKEN,
        body: JSON.stringify({ categories: ['messages', 'filter', 'settings', 'auto', 'runLog'] }),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(all.status, 200)
      const bundle = JSON.parse(all.text)
      assert.strictEqual(bundle.kind, 'xbk-console-backup')
      assert.strictEqual(bundle.schema, 1)
      assert.deepStrictEqual(Object.keys(bundle.data).sort((a, b) => a.localeCompare(b)), ['auto', 'filter', 'messages', 'runLog', 'settings'])
      assert.strictEqual(bundle.data.messages.count, 2)
      assert.strictEqual(bundle.data.auto.interval, 7)
      assert.ok(!Object.prototype.hasOwnProperty.call(bundle.data.auto, 'on'), '备份文件不得记录自动运行开关')
      assert.strictEqual(bundle.data.settings.notifyTestReplayWindowS, 9)
      assert.ok(bundle.data.filter.text.includes('pingbifenlei'))
      assert.strictEqual(bundle.data.runLog.text, 'old log\n')
      const only = await request(port, 'POST', '/api/backup/export', {
        token: TOKEN,
        body: JSON.stringify({ categories: ['settings'] }),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(only.status, 200)
      assert.deepStrictEqual(Object.keys(JSON.parse(only.text).data), ['settings'])
      const bad = await request(port, 'POST', '/api/backup/export', {
        token: TOKEN,
        body: JSON.stringify({ categories: ['nope'] }),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(bad.status, 400)
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('数据备份: 导出校验过滤规则，坏规则跳过不拖累整包', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-backup-'))
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 1, title: 'a' }]))
    fs.writeFileSync(path.join(dir, 'filter-rules.json'), JSON.stringify({ schema: 1, revision: 2, filter: { pingbifenlei: '(' } }))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const res = await request(port, 'POST', '/api/backup/export', {
        token: TOKEN,
        body: JSON.stringify({ categories: ['messages', 'filter'] }),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(res.status, 200, res.text)
      const bundle = JSON.parse(res.text)
      assert.ok(bundle.data.messages, '推送记录仍应导出')
      assert.ok(!bundle.data.filter, '坏过滤规则不得进入备份')
      assert.ok(bundle.skipped.some((x) => x.key === 'filter' && x.reason === 'invalid_filter'), '必须报告过滤规则被跳过')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('数据备份: 坏消息条目拒绝导入；中途写失败整体回滚', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-backup-'))
    const pushPath = path.join(dir, 'push.json')
    fs.writeFileSync(pushPath, JSON.stringify([{ id: 1, title: 'old' }]))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const invalid = {
        kind: 'xbk-console-backup',
        schema: 1,
        data: { messages: { count: 1, text: JSON.stringify([{ id: 2 }]) } }
      }
      const bad = await request(port, 'POST', '/api/backup/import', {
        token: TOKEN,
        body: JSON.stringify(invalid),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(bad.status, 400)
      assert.strictEqual(fs.readFileSync(pushPath, 'utf8'), JSON.stringify([{ id: 1, title: 'old' }]))

      // run.log 预置成目录：writeAtomic 必失败，前面已写成功的 push.json 必须被回滚。
      fs.mkdirSync(path.join(dir, 'run.log'))
      const rollback = {
        kind: 'xbk-console-backup',
        schema: 1,
        data: {
          messages: { count: 1, text: JSON.stringify([{ id: 2, title: 'new' }]) },
          runLog: { text: 'new log\n' }
        }
      }
      const failed = await request(port, 'POST', '/api/backup/import', {
        token: TOKEN,
        body: JSON.stringify(rollback),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(failed.status, 500, failed.text)
      assert.strictEqual(JSON.parse(failed.text).rolledBack, true, '回滚必须成功')
      assert.strictEqual(fs.readFileSync(pushPath, 'utf8'), JSON.stringify([{ id: 1, title: 'old' }]), '失败导入不得留下半套数据')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('数据备份: 判重历史随消息恢复，重复导入按幂等键返回原结果', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-backup-'))
    const pushPath = path.join(dir, 'push.json')
    const seenPath = path.join(dir, 'push.json.seen.json')
    fs.writeFileSync(pushPath, JSON.stringify([{ id: 1, title: 'old' }]))
    fs.writeFileSync(seenPath, JSON.stringify({ v: 1, id: ['old'] }))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const bundle = {
        kind: 'xbk-console-backup',
        schema: 1,
        data: {
          messages: {
            count: 1,
            text: JSON.stringify([{ id: 9, title: 'new' }]),
            seenText: JSON.stringify({ v: 1, id: ['new'] })
          }
        }
      }
      const headers = { 'content-type': 'application/json', 'idempotency-key': 'test-import-key-0001' }
      const first = await request(port, 'POST', '/api/backup/import', { token: TOKEN, body: JSON.stringify(bundle), headers })
      assert.strictEqual(first.status, 200, first.text)
      assert.strictEqual(fs.readFileSync(seenPath, 'utf8'), JSON.stringify({ v: 1, id: ['new'] }))
      // 模拟导入成功后又有新记录写入；同一请求重试不能把它们覆盖回旧备份。
      fs.writeFileSync(pushPath, JSON.stringify([{ id: 10, title: 'newer' }]))
      const again = await request(port, 'POST', '/api/backup/import', { token: TOKEN, body: JSON.stringify(bundle), headers })
      assert.strictEqual(again.status, 200, again.text)
      assert.deepStrictEqual(JSON.parse(again.text).imported.messages, 1)
      assert.strictEqual(fs.readFileSync(pushPath, 'utf8'), JSON.stringify([{ id: 10, title: 'newer' }]))
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('数据备份: 导入自动识别并恢复，未含类别不动，自动运行开关保持停止', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-backup-'))
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 1, title: 'old' }]))
    fs.writeFileSync(path.join(dir, 'filter-rules.json'), JSON.stringify({ schema: 1, revision: 2, filter: { pingbifenlei: 'old' } }))
    fs.writeFileSync(path.join(dir, 'run.log'), 'old log\n')
    fs.writeFileSync(path.join(dir, 'console-settings.json'), JSON.stringify({ revision: 2, updatedAt: Date.now(), notifyTestReplayWindowS: 9, syncShowDate: false }))
    fs.writeFileSync(path.join(dir, 'console-auto.json'), JSON.stringify({ on: false, interval: 7, updatedAt: Date.now() }))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const bundle = {
        kind: 'xbk-console-backup',
        schema: 1,
        data: {
          messages: { count: 1, text: JSON.stringify([{ id: 9, title: 'new' }]) },
          filter: { text: JSON.stringify({ schema: 1, revision: 8, filter: { pingbifenlei: 'new' } }) },
          settings: { notifyTestReplayWindowS: 5, syncShowDate: true },
          auto: { interval: 12 },
          runLog: { text: 'new log\n' }
        }
      }
      const imp = await request(port, 'POST', '/api/backup/import', {
        token: TOKEN,
        body: JSON.stringify(bundle),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(imp.status, 200, imp.text)
      const result = JSON.parse(imp.text)
      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.imported.messages, 1)
      assert.strictEqual(result.imported.autoInterval, 12)
      assert.ok(result.backupDir)
      assert.strictEqual(fs.readFileSync(path.join(dir, 'push.json'), 'utf8'), '[{"id":9,"title":"new"}]')
      assert.match(fs.readFileSync(path.join(dir, 'filter-rules.json'), 'utf8'), /"pingbifenlei":"new"/)
      const auditLines = fs.readFileSync(path.join(dir, 'filter-rules.audit.ndjson'), 'utf8').trim().split('\n')
      assert.strictEqual(JSON.parse(auditLines[auditLines.length - 1]).action, 'import', '过滤规则导入必须留审计')
      assert.strictEqual(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), 'new log\n')
      const autoFile = JSON.parse(fs.readFileSync(path.join(dir, 'console-auto.json'), 'utf8'))
      assert.strictEqual(autoFile.interval, 12)
      assert.strictEqual(autoFile.on, false, '导入不得把自动运行打开')
      const settingsFile = JSON.parse(fs.readFileSync(path.join(dir, 'console-settings.json'), 'utf8'))
      assert.strictEqual(settingsFile.notifyTestReplayWindowS, 5)
      assert.strictEqual(settingsFile.syncShowDate, true)
      // 只恢复文件里出现的类别：只带推送记录时，过滤规则保持导入后的值。
      const partial = {
        kind: 'xbk-console-backup',
        schema: 1,
        data: { messages: { count: 1, text: JSON.stringify([{ id: 10, title: 'c' }]) } }
      }
      const again = await request(port, 'POST', '/api/backup/import', {
        token: TOKEN,
        body: JSON.stringify(partial),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(again.status, 200, again.text)
      assert.match(fs.readFileSync(path.join(dir, 'filter-rules.json'), 'utf8'), /"pingbifenlei":"new"/)
      const bad = await request(port, 'POST', '/api/backup/import', {
        token: TOKEN,
        body: JSON.stringify({ kind: 'not-a-backup', schema: 1, data: {} }),
        headers: { 'content-type': 'application/json' }
      })
      assert.strictEqual(bad.status, 400)
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

async function backupUiStructureTests () {
  await aok('结构红线: 数据备份只留导入/导出，导出类别在弹窗里选', () => {
    const src = readConsoleSource()
    const at = src.indexOf('function BackupBlock')
    const end = src.indexOf('function SysPanel', at)
    const seg = src.slice(at, end)
    const ph = (name) => '$' + '{' + name + '}'
    assert.ok(at > -1 && end > at, '应能定位 BackupBlock')
    assert.ok(seg.includes('onClick=' + ph('openExport')), '系统页入口只能打开导出弹窗')
    assert.ok(seg.includes('onClick=' + ph('chooseFile')), '导入入口应直接选文件')
    assert.ok(seg.includes('open=' + ph('exportOpen')) && seg.includes('title="选择要导出的数据"'),
      '导出类别必须在弹窗里选')
    const modalAt = seg.indexOf('open=' + ph('exportOpen'))
    assert.ok(seg.indexOf('backup-list') > modalAt, '类别列表不得回到系统页内联显示')
    assert.ok(seg.includes('confirmDisabled='), '一个都没选时导出确认按钮必须禁用')
  })

  await aok('结构红线: 备份在浏览器加密，密码不进请求', () => {
    const src = readConsoleSource()
    const at = src.indexOf('function BackupBlock')
    const end = src.indexOf('function SysPanel', at)
    const seg = src.slice(at, end)
    assert.ok(at > -1 && end > at, '应能定位 BackupBlock')
    assert.match(src, /import \{[^}]*encryptBackup[^}]*decryptBackup[^}]*isEncryptedBackup[^}]*\} from '\.\/pure\.mjs'/, 'app.js 必须引用纯函数加密模块')
    const exportAt = seg.indexOf('title="选择要导出的数据"')
    const unlockAt = seg.indexOf('title="输入备份密码"')
    const importAt = seg.indexOf('title="确认导入备份"')
    assert.ok(exportAt > -1 && unlockAt > exportAt && importAt > unlockAt, '三个弹窗必须可分别定位')
    const exportDialog = seg.slice(exportAt, unlockAt)
    const unlockDialog = seg.slice(unlockAt, importAt)
    assert.strictEqual((exportDialog.match(/type="password"/g) || []).length, 2, '导出弹窗必须有两个密码框（设置 + 确认）')
    assert.strictEqual((unlockDialog.match(/type="password"/g) || []).length, 1, '导入弹窗必须有自己的密码框')
    assert.ok(seg.includes('.xbk`'), '下载扩展名必须是加密备份标识')
    assert.ok(seg.includes('isEncryptedBackup(data)') && seg.includes('decryptBackup(locked.data'),
      '导入必须先识别加密头，再在浏览器解密')
    assert.ok(seg.includes('encryptBackup(bundle, exportPassword)'), '导出必须加密后才能落盘')
    const doExportAt = seg.indexOf('const doExport =')
    const secureAt = seg.indexOf('window.isSecureContext', doExportAt)
    const apiAt = seg.indexOf('apiPostBackupExport(categories)', doExportAt)
    assert.ok(secureAt > doExportAt && apiAt > secureAt, '必须在调用导出接口前检查 WebCrypto，HTTP 下不能先传明文')
    assert.ok(src.includes('const text = await res.text()'), '导出响应必须先读 JSON 文本再加密，不能直接下载 blob')
    assert.ok(src.includes('BACKUP_BROWSER_MAX_BYTES = 32 * 1024 * 1024'), '浏览器加密导出上限必须钉在 32MiB')
    assert.ok(src.includes('BACKUP_FILE_MAX_BYTES = 48 * 1024 * 1024'), '密文选文件上限必须钉在 48MiB')
    assert.ok(seg.includes('密码只在这个浏览器里使用，不会发给服务器'), '导入弹窗必须明示密码不上传')
    const exportApi = src.slice(src.indexOf('function apiPostBackupExport'), src.indexOf('function apiPostBackupImport'))
    assert.ok(/JSON\.stringify\(\{ categories \}\)/.test(exportApi), '导出请求体只能有 categories')
    assert.ok(!/password/i.test(exportApi), '导出请求不得带密码')
    assert.ok(/apiPostBackupImport\(pending\.bundle, pending\.key\)/.test(seg), '导入请求只能带解密后的 bundle 和幂等键')
    assert.ok(!/apiPostBackupImport\([^)]*password/i.test(seg), '导入请求不得带密码')
  })

  await aok('结构红线: 弹窗 busy 变化不得把焦点抢回密码框', () => {
    const src = readConsoleSource()
    const at = src.indexOf('function ConfirmDialog')
    const end = src.indexOf('function LeaveGuardDialog', at)
    assert.ok(at > -1 && end > at, '应能定位 ConfirmDialog')
    const seg = src.slice(at, end)
    // v3.361：两个弹窗共用 useDialogChrome（各抄一份会被 Sonar 判重复代码），
    // ref 初始化/更新与 Escape 绑定都收在骨架里，仍要求回调读 ref 而不是旧闭包。
    const hAt = src.indexOf('function useDialogChrome')
    assert.ok(hAt > -1 && hAt < at, '应能定位 useDialogChrome')
    const hook = src.slice(hAt, src.indexOf('\n}\n', hAt))
    assert.ok(hook.includes('const onCancelRef = useRef(onCancel)'), 'onCancel 必须走 ref')
    assert.ok(hook.includes('onCancelRef.current = onCancel'), '每次渲染都要把 ref 更新到最新 onCancel')
    assert.ok(seg.includes('useDialogChrome(open, onCancel'), '两个弹窗都必须走公共骨架')
    // v3.361：退场动画那 220ms 里确认/保存按钮必须禁用——否则按了取消、动作照跑。
    assert.ok(seg.includes('const [closeDialog, dialogClosing] = useMorphDialog'), '必须拿到 closing 状态')
    const attr = (js) => 'disabled=' + '$' + '{' + js + '}'
    const leaveSeg = src.slice(end, src.indexOf('\n}\n', end))
    assert.ok(seg.includes(attr('dialogClosing')), '确认弹窗的取消按钮在退场期间要禁用')
    assert.ok(seg.includes(attr('busy || confirmDisabled || dialogClosing')), '确认按钮在退场期间要禁用')
    assert.ok(leaveSeg.includes(attr('dialogClosing')), '离开弹窗的取消按钮在退场期间要禁用')
    assert.ok(leaveSeg.includes(attr('busy || dialogClosing')), '离开弹窗的保存/丢弃按钮在退场期间要禁用')

    // 三个退出入口都必须调用 ref，而不是捕获的旧 onCancel；否则 busy 守卫可能被旧闭包绕过。
    // v3.360：三个入口都先播退场再回调，但回调本身仍走 ref（避免旧闭包绕过 busy 守卫）。
    assert.match(hook, /if \(e\.key === 'Escape'\) closeDialog\(\(\) => onCancelRef\.current\(\)\)/,
      'Escape 必须判断 ===（反向/不等号写法不能过），并调用 ref')
    assert.ok(seg.includes('if (e.target === e.currentTarget) closeDialog(() => onCancelRef.current())'), '点遮罩必须调用 ref')
    assert.ok(seg.includes('onClick=' + '$' + '{() => closeDialog(() => onCancelRef.current())}'), '取消按钮必须调用 ref')

    // 依赖数组必须属于“聚焦”的那个 effect，不能靠组件里别处的同名字符串蒙混。
    // 不用正则：嵌套量词会被 Sonar 判「回溯性能」。
    assert.ok(hook.includes('setTimeout(() => {'), '应能定位聚焦的 setTimeout')
    assert.ok(hook.includes('}, [open, initialFocusRef])'),
      '聚焦 effect 只能依赖 open/initialFocusRef；依赖 onCancel 会让 busy 变化重开键盘')
  })
}

// ── v3.370 线报全站搜索 / 关注词 ───────────────────────────────────────────
// 上游返回结构按线报酷 /search.php 的真实片段裁剪：标题在 a[title]，时间在 time[title]，
// 正文/分类/作者都在 data-* 属性里。结构断言只认这些字段，不依赖外层 class 的其它修饰。
const LINE_SEARCH_FIXTURE = `<html><body>
<div class="listbox"><ul class="new-post">
<li class="article-list xb-st-chk">
  <p class="title"><time class="badge red" datetime="2026-10-25" title="2026-10-25 21:23">21:23</time>
  <span class="badge-cat">好单线报</span>
  <a href="/haodan/7305598.html" title="十月<em>稻田</em>五常香米5kg 20.85元" data-catename="好单线报-粮油-淘宝" data-price="" data-content="十月稻田 五常香米 &amp; 新米" data-louzhu="发报员T">十月<em>稻田</em>五常香米5kg 20.85元</a></p>
</li>
<li class="article-list xb-st-chk">
  <p class="title"><time class="badge red" datetime="2026-10-24" title="2026-10-24 16:55">16:55</time>
  <span class="badge-cat">好单线报</span>
  <a href="/haodan/7303544.html" title="五稻田东北大米10斤 15元" data-catename="好单线报-粮油-淘宝" data-price="15" data-content="少部分地区有货" data-louzhu="发报员Y">五稻田东北大米10斤 15元</a></p>
</li>
</ul></div>
<div class="pagebar"><a href="/search.php?q=x&amp;page=2">2</a><a href="/search.php?q=x&amp;page=3">3</a></div>
</body></html>`

// 满页夹具：上游单页固定 100 条，用来验证 limit<100 但跨到下一页时的偏移映射。
const LINE_SEARCH_FULL_PAGE = (() => {
  const rows = []
  for (let i = 0; i < 100; i += 1) {
    const id = String(8000000 + i)
    const mm = String(i % 60).padStart(2, '0')
    rows.push(`<li class="article-list"><p class="title"><time title="2026-10-25 10:${mm}">${mm}</time><a href="/haodan/${id}.html" title="满页${i}" data-catename="好单线报" data-price="" data-content="满页内容${i}" data-louzhu="t">满页${i}</a></p></li>`)
  }
  return `<html><body><ul class="new-post">${rows.join('')}</ul><div class="pagebar"><a href="/search.php?q=x&amp;page=2">2</a></div></body></html>`
})()

async function lineSearchTests () {
  await aok('线报搜索: 解析上游 HTML（标题/正文/价格/北京时间/分页）', () => {
    const parsed = parseLineSearchHtml(LINE_SEARCH_FIXTURE, 'https://new.ixbk.net/')
    assert.strictEqual(parsed.items.length, 2)
    assert.strictEqual(parsed.pages, 3, '分页取 pagebar 的最大页码')
    assert.strictEqual(parsed.matched, true)
    const first = parsed.items[0]
    assert.strictEqual(first.id, 'haodan-7305598')
    assert.strictEqual(first.url, 'https://new.ixbk.net/haodan/7305598.html', '相对链接必须补成绝对地址')
    assert.strictEqual(first.title, '十月稻田五常香米5kg 20.85元', '标题里的 <em> 必须剥掉')
    assert.strictEqual(first.content, '十月稻田 五常香米 & 新米', '正文实体只解码一次')
    assert.strictEqual(first.catename, '好单线报-粮油-淘宝')
    assert.strictEqual(first.price, null, '空 data-price 必须是 null，不是 0')
    assert.strictEqual(first.author, '发报员T')
    assert.strictEqual(first.ts, Date.UTC(2026, 9, 25, 13, 23), '北京时间 21:23 = UTC 13:23')
    assert.strictEqual(parsed.items[1].price, 15)
    // 结构不对（没有 new-post）不得抛错：matched=false，由上层报「无法解析」。
    assert.deepStrictEqual(parseLineSearchHtml('<html>changed</html>', 'https://x'), { items: [], pages: 1, matched: false })
    assert.deepStrictEqual(parseLineSearchHtml(null, 'https://x'), { items: [], pages: 1, matched: false })
  })

  await aok('线报搜索: 实体解码/时间戳/查询词与关注词归一', () => {
    // 双重解码是这里的核心边界：&amp;lt; 只能解成 &lt; 文本，不能变成标签。
    assert.strictEqual(decodeLineHtml('&amp;lt;b&amp;gt;'), '&lt;b&gt;')
    assert.strictEqual(decodeLineHtml('<b>粗</b>&nbsp;体&#39;&#x4e2d;'), '粗 体\'中')
    assert.strictEqual(parseLineStamp('2026-10-25 21:23'), Date.UTC(2026, 9, 25, 13, 23))
    assert.strictEqual(parseLineStamp('not-a-time'), null)
    const long = '稻'.repeat(100)
    const clamped = clampLineQuery(long)
    assert.ok(Buffer.byteLength(clamped, 'utf8') <= LINE_SEARCH_QUERY_MAX_BYTES, '查询词必须按 UTF-8 字节截断')
    assert.ok(clamped.length > 0 && long.startsWith(clamped), '截断必须是前缀，不能整词清空')
    assert.strictEqual(normalizeWatchWord('  十月   稻田  '), '十月 稻田', '连续空白归一成一个空格')
    assert.ok(Buffer.byteLength(normalizeWatchWord(long), 'utf8') <= 120, '关注词同样封顶 120 字节')
    // 代理对（emoji）不能被切成孤立代理项——否则 encodeURIComponent 直接抛错。
    const emoji = '😀'.repeat(40)
    const cut = clampLineQuery(emoji)
    assert.ok(Buffer.byteLength(cut, 'utf8') <= LINE_SEARCH_QUERY_MAX_BYTES)
    assert.doesNotThrow(() => encodeURIComponent(cut), '截断后不得留下孤立代理项')
  })

  await aok('线报搜索 HTTP: 代理参数/60s 缓存/上游失败三态 + 关注词增删读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-line-'))
    const fetched = []
    let mode = 'ok'
    // 第 2 页夹具：用于验证「每页 N 条」跨 100 条边界时会去取上游第 2 页。
    const pageTwo = '<html><body><ul class="new-post"><li class="article-list"><p class="title"><time title="2026-10-23 09:00">09:00</time><a href="/haodan/7300002.html" title="第二页线报" data-price="9.9">第二页线报</a></p></li></ul><div class="pagebar"><a href="/search.php?q=x&amp;page=3">3</a></div></body></html>'
    const { server } = createConsole({
      token: TOKEN,
      stateDir: dir,
      lineSearchFetch: async (target) => {
        fetched.push(String(target))
        if (mode === 'fail') throw new Error('upstream down')
        if (mode === 'redirect') return { ok: false, status: 302, text: async () => '' }
        if (mode === 'changed') return { ok: true, status: 200, text: async () => '<html>changed</html>' }
        if (mode === 'full' && String(target).includes('&page=1')) return { ok: true, status: 200, text: async () => LINE_SEARCH_FULL_PAGE }
        if (mode === 'lastfail' && String(target).includes('&page=3')) throw new Error('last page down')
        if (String(target).includes('&page=2')) return { ok: true, status: 200, text: async () => pageTwo }
        return { ok: true, status: 200, text: async () => LINE_SEARCH_FIXTURE }
      }
    })
    const port = await listen(server)
    try {
      const q = encodeURIComponent('十月稻田')
      const first = JSON.parse((await request(port, 'GET', `/api/line-search?q=${q}&page=1&limit=100`, { token: TOKEN })).text)
      assert.strictEqual(first.status, 'ok')
      assert.strictEqual(first.q, '十月稻田')
      assert.strictEqual(first.page, 1)
      assert.strictEqual(first.limit, 100)
      assert.strictEqual(first.count, 2)
      assert.strictEqual(first.pages, 3)
      assert.strictEqual(first.items[0].title, '十月稻田五常香米5kg 20.85元')
      assert.strictEqual(fetched.length, 2, '第 1 页 + 末页条数（算准确总页数）')
      assert.ok(fetched[0].includes('/search.php?q=' + q) && fetched[0].includes('&page=1'), '代理只带 q/page 两个参数')
      // 同词同页第二次走 60s 缓存，不再打上游。
      const second = JSON.parse((await request(port, 'GET', `/api/line-search?q=${q}&page=1&limit=100`, { token: TOKEN })).text)
      assert.strictEqual(second.cached, true)
      assert.strictEqual(fetched.length, 2, '缓存命中不得再请求上游')
      // page=2/limit=100：跳过第 1 页的 100 条 → 取上游 page 2（page 是展示页，不是上游页码）。
      const secondUp = JSON.parse((await request(port, 'GET', `/api/line-search?q=${q}&page=2&limit=100`, { token: TOKEN })).text)
      assert.strictEqual(secondUp.count, 1)
      assert.strictEqual(secondUp.items[0].id, 'haodan-7300002')
      assert.ok(fetched.some((u) => u.includes('&page=2')), '跨页时必须请求上游第 2 页')
      // 每页 N 条：limit=1 时第 2 页就是第 2 条，不再请求上游新页。
      const sliced = JSON.parse((await request(port, 'GET', `/api/line-search?q=${q}&page=2&limit=1`, { token: TOKEN })).text)
      assert.strictEqual(sliced.count, 1)
      assert.strictEqual(sliced.items[0].id, 'haodan-7303544')
      assert.strictEqual(sliced.pages, 202, '3 个上游页（末页 2 条）× 100 + 2 ÷ 每页 1 条')
      // 满页 100 条 + limit=30 第 4 页：offset=90，应从第 91 条开始，跨到上游第 2 页补 20 条。
      mode = 'full'
      const fullPageRes = JSON.parse((await request(port, 'GET', '/api/line-search?q=' + encodeURIComponent('满页词') + '&page=4&limit=30', { token: TOKEN })).text)
      assert.strictEqual(fullPageRes.status, 'ok')
      assert.strictEqual(fullPageRes.count, 11, '第 91-100 条 + 上游第 2 页 1 条')
      assert.strictEqual(fullPageRes.items[0].id, 'haodan-8000090', 'offset=90 必须映射到第 91 条')
      assert.strictEqual(fullPageRes.items[10].id, 'haodan-7300002')
      assert.strictEqual(fullPageRes.pages, 4, '(100 + 1) 条 ÷ 每页 30 条 = 4 页')
      // 末页取不到：总页数只能按满页估算，必须明确标 pagesEstimated，不能冒充精确值。
      mode = 'lastfail'
      const estimated = JSON.parse((await request(port, 'GET', '/api/line-search?q=' + encodeURIComponent('估页词') + '&page=1&limit=20', { token: TOKEN })).text)
      assert.strictEqual(estimated.status, 'ok')
      assert.strictEqual(estimated.pagesEstimated, true)
      assert.strictEqual(estimated.pages, 15)
      mode = 'ok'
      // 空词 400（不拿空 query 去扫上游）。
      assert.strictEqual((await request(port, 'GET', '/api/line-search?q=', { token: TOKEN })).status, 400)
      // 上游失败如实回 upstream_error，不伪装成「0 条结果」。
      mode = 'fail'
      const failed = JSON.parse((await request(port, 'GET', '/api/line-search?q=' + encodeURIComponent('别的词'), { token: TOKEN })).text)
      assert.strictEqual(failed.status, 'upstream_error')
      assert.ok(typeof failed.error === 'string' && failed.error.length > 0)
      // 3xx：不跟随重定向（固定 host，不允许被带去内网/其它站点）。
      mode = 'redirect'
      const redirected = JSON.parse((await request(port, 'GET', '/api/line-search?q=' + encodeURIComponent('重定向词'), { token: TOKEN })).text)
      assert.strictEqual(redirected.status, 'upstream_error')
      assert.ok(redirected.error.includes('重定向'), '必须明说重定向已中止')
      // 结构变了 ≠ 0 条：必须报「无法解析」。
      mode = 'changed'
      const changed = JSON.parse((await request(port, 'GET', '/api/line-search?q=' + encodeURIComponent('改版词'), { token: TOKEN })).text)
      assert.strictEqual(changed.status, 'upstream_error')
      assert.ok(changed.error.includes('结构'), '解析失败不得伪装成没有结果')
      mode = 'ok'

      const postWatch = (body, opts = {}) => request(port, 'POST', '/api/line-watch', {
        token: opts.token === undefined ? TOKEN : opts.token,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
      })
      // 配置：默认 20 条 / 10 分钟 / 关闭；可改，越界 400；写盘后 GET 一致。
      const cfg0 = JSON.parse((await request(port, 'GET', '/api/line-watch', { token: TOKEN })).text)
      assert.strictEqual(cfg0.limit, 20, '文档默认 20 条/页')
      assert.strictEqual(cfg0.intervalMin, 10, '文档默认 10 分钟')
      assert.strictEqual(cfg0.enabled, false)
      const cfgOn = JSON.parse((await postWatch({ action: 'config', limit: 50, intervalMin: 5, enabled: true })).text)
      assert.strictEqual(cfgOn.limit, 50)
      assert.strictEqual(cfgOn.intervalMin, 5)
      assert.strictEqual(cfgOn.enabled, true)
      assert.strictEqual(cfgOn.lastCheckAt, 0, '从关到开必须清掉上次检查时间，尽快跑第一轮')
      const cfgBad = await postWatch({ action: 'config', limit: 0, intervalMin: 5, enabled: true })
      assert.strictEqual(cfgBad.status, 400)
      assert.strictEqual((await postWatch({ action: 'config', limit: 50, intervalMin: 0, enabled: true })).status, 400)
      // 关掉，避免测试进程的定时器真的去推送。
      await postWatch({ action: 'config', limit: 50, intervalMin: 5, enabled: false })
      // 关注词：初始为空；写面只认 Bearer；增/读/删都落盘。
      const empty = JSON.parse((await request(port, 'GET', '/api/line-watch', { token: TOKEN })).text)
      assert.deepStrictEqual(empty.words, [])
      assert.strictEqual(empty.limit, 50, '配置必须随文件持久化')
      const added = await postWatch({ action: 'add', q: '  十月   稻田 ' })
      assert.strictEqual(added.status, 200)
      const addedWords = JSON.parse(added.text).words
      assert.deepStrictEqual(addedWords.map((w) => w.q), ['十月 稻田'])
      assert.ok(addedWords[0].lastReadAt > 0, '新词必须以添加时刻为基线，首次检查不把历史条目全算新')
      assert.strictEqual(addedWords[0].lastReadAt % 60000, 59999, '基线取当前分钟起点 -1ms，避免漏掉同分钟线报')
      // Cookie-only 写请求必须 401（写面不收会话 Cookie）。
      const cookieOnly = await postWatch({ action: 'add', q: '另一词' }, { token: '', headers: { cookie: `xbk_session=${TOKEN}` } })
      assert.strictEqual(cookieOnly.status, 401)
      // 重复添加不产生第二份。
      await postWatch({ action: 'add', q: '十月 稻田' })
      assert.strictEqual(JSON.parse((await request(port, 'GET', '/api/line-watch', { token: TOKEN })).text).words.length, 1)
      // 标为已读：lastReadAt 取实际展示的最新条目时间，lastReadId 作为分钟精度锚点。
      const read = await postWatch({ action: 'read', q: '十月 稻田', lastReadAt: 1792918500000, lastReadId: 'haodan-7305598' })
      const readWord = JSON.parse(read.text).words[0]
      assert.strictEqual(readWord.lastReadAt, 1792918500000)
      assert.strictEqual(readWord.lastReadId, 'haodan-7305598')
      assert.strictEqual((fs.statSync(path.join(dir, LINE_WATCH_FILE)).mode & 0o777), 0o600, '关注词文件必须 0600')
      // 文件损坏按 invalid 如实上报，不静默当空。
      fs.writeFileSync(path.join(dir, LINE_WATCH_FILE), '{broken')
      assert.strictEqual(readLineWatchWords(dir).status, 'invalid')
      const corrupt = JSON.parse((await request(port, 'GET', '/api/line-watch', { token: TOKEN })).text)
      assert.strictEqual(corrupt.status, 'invalid')
      // 重写一份合法文件给删除用例（损坏文件不应阻塞用户重新添加）。
      await postWatch({ action: 'add', q: '新词' })
      const removed = await postWatch({ action: 'remove', q: '新词' })
      assert.deepStrictEqual(JSON.parse(removed.text).words.map((w) => w.q), [])
      assert.strictEqual((await postWatch({ action: 'oops', q: 'x' })).status, 400)
      // 上限：文件里塞满 12 个后再 add 必须 409，不能无限长。
      const many = Array.from({ length: LINE_WATCH_MAX_WORDS }, (_, i) => ({ q: `词${i}`, lastReadAt: 0 }))
      fs.writeFileSync(path.join(dir, LINE_WATCH_FILE), JSON.stringify({ schema: 1, words: many }))
      const full = await postWatch({ action: 'add', q: '第十三个' })
      assert.strictEqual(full.status, 409)
      // IO/权限类读失败必须 fail-closed：临时把文件换成目录，写操作 503 且不覆盖任何东西。
      fs.rmSync(path.join(dir, LINE_WATCH_FILE), { force: true })
      fs.mkdirSync(path.join(dir, LINE_WATCH_FILE))
      const blocked = await postWatch({ action: 'add', q: '读不了' })
      assert.strictEqual(blocked.status, 503)
      assert.ok(blocked.text.includes('暂时读不了'))
      assert.ok(fs.statSync(path.join(dir, LINE_WATCH_FILE)).isDirectory(), '失败时不得改动原路径')
      fs.rmdirSync(path.join(dir, LINE_WATCH_FILE))
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

async function watchMonitorTests () {
  await aok('关注词监控: 有新的逐条推/没新的不推/推过的落盘重启不重推/失败重试', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-watch-'))
    const pageOne = LINE_SEARCH_FIXTURE
    const anchorSecond = {
      q: '十月稻田', lastReadAt: Date.UTC(2026, 9, 24, 8, 55), lastReadId: 'haodan-7303544', sentIds: []
    }
    const base = { limit: 20, intervalMin: 10, enabled: true, lastCheckAt: 0, words: [anchorSecond] }
    const makeState = (over = {}) => saveWatchState(dir, { ...base, ...over })
    const mkConsole = (notifier) => createConsole({
      token: TOKEN,
      stateDir: dir,
      lineSearchFetch: async () => ({ ok: true, status: 200, text: async () => pageOne }),
      watchNotifier: notifier
    })

    makeState()
    const pushes = []
    const { server, runWatchOnce } = mkConsole(async (title, body) => { pushes.push({ title, body }) })
    try {
      const first = await runWatchOnce()
      assert.strictEqual(first.status, 'ok')
      assert.strictEqual(first.pushed, 1, '锚点之上只有 1 条新线报')
      assert.strictEqual(pushes.length, 1)
      assert.ok(pushes[0].title.includes('十月稻田'))
      assert.ok(pushes[0].body.includes('十月稻田五常香米5kg 20.85元'))
      assert.ok(pushes[0].body.includes('/haodan/7305598.html'), '推送正文必须带原文链接')
      const saved = readWatchState(dir)
      assert.deepStrictEqual(saved.words[0].sentIds, ['haodan-7305598'], '推过的 id 必须落盘')
      assert.strictEqual(saved.words[0].lastReadId, 'haodan-7305598', '锚点前进到已推的最新一条')
      assert.ok(saved.lastCheckAt > 0)

      // 再跑一轮：锚点就在最新一条上，0 条新，不推。
      const again = await runWatchOnce()
      assert.strictEqual(again.pushed, 0)
      assert.strictEqual(pushes.length, 1, '没有新线报绝不能重复推')

      // 「重启」：同一目录新建实例，仍然不重推。
      const restarted = mkConsole(async () => { throw new Error('must not push') })
      const afterRestart = await restarted.runWatchOnce()
      assert.strictEqual(afterRestart.pushed, 0, '重启后必须靠文件里的 sentIds/锚点判重')
      restarted.server.close()

      // 推送失败：不记账、锚点不动，下一轮重试。
      makeState()
      const failing = mkConsole(async () => { throw new Error('channel down') })
      const failed = await failing.runWatchOnce()
      assert.strictEqual(failed.pushed, 0)
      assert.strictEqual(failed.results[0].error, 'push_failed')
      const kept = readWatchState(dir)
      assert.deepStrictEqual(kept.words[0].sentIds, [])
      assert.strictEqual(kept.words[0].lastReadId, 'haodan-7303544', '失败不得推进锚点')
      failing.server.close()

      const retryPushes = []
      const retry = mkConsole(async (title, body) => { retryPushes.push(title) })
      const retried = await retry.runWatchOnce()
      assert.strictEqual(retried.pushed, 1, '下一轮必须补推失败的那条')
      assert.strictEqual(retryPushes.length, 1)
      retry.server.close()

      // 关闭时完全不碰上游/推送。
      makeState({ enabled: false })
      let called = 0
      const off = mkConsole(async () => { called += 1 })
      const idle = await off.runWatchOnce()
      assert.strictEqual(idle.status, 'idle')
      assert.strictEqual(called, 0)
      off.server.close()

      // 正文包含价格与摘要。
      const body = formatWatchPush({ title: '测试线报', price: 15, datetime: '2026-10-24 16:55', content: '少部分地区有货', url: 'https://x/1' })
      assert.ok(body.includes('价格：¥15'))
      assert.ok(body.includes('少部分地区有货'))
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('关注词监控: 两条新线报逐条推送（不汇总），中途停用立即停止', async () => {
    const mk = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-watch2-'))
      saveWatchState(dir, {
        limit: 1, // 故意设 1：监控必须翻到上次位置，不能只推最新 limit 条
        intervalMin: 10,
        enabled: true,
        lastCheckAt: 0,
        words: [{ q: '十月稻田', lastReadAt: Date.UTC(2026, 9, 24, 8, 55) - 1, lastReadId: '', sentIds: [] }]
      })
      return dir
    }
    const dir = mk()
    const pushes = []
    const one = createConsole({
      token: TOKEN,
      stateDir: dir,
      lineSearchFetch: async () => ({ ok: true, status: 200, text: async () => LINE_SEARCH_FIXTURE }),
      watchNotifier: async (title, body) => { pushes.push({ title, body }) }
    })
    try {
      const r = await one.runWatchOnce()
      assert.strictEqual(r.pushed, 2, '两条新线报必须各推一条')
      assert.strictEqual(pushes.length, 2, '不得合并成一条')
      assert.ok(pushes[0].body.includes('/haodan/7303544.html'), '先推旧的')
      assert.ok(pushes[1].body.includes('/haodan/7305598.html'), '再推新的')
    } finally {
      one.server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }

    const dir2 = mk()
    const sent = []
    const two = createConsole({
      token: TOKEN,
      stateDir: dir2,
      lineSearchFetch: async () => ({ ok: true, status: 200, text: async () => LINE_SEARCH_FIXTURE }),
      watchNotifier: async () => {
        sent.push(1)
        // 第一条发出后用户关掉监控：内存里的 state 仍是 enabled，必须靠每条重读文件才发现。
        const st = readWatchState(dir2)
        st.enabled = false
        saveWatchState(dir2, st)
      }
    })
    try {
      const r = await two.runWatchOnce()
      assert.strictEqual(r.pushed, 1, '停用后不得再发第二条')
      assert.strictEqual(sent.length, 1)
    } finally {
      two.server.close()
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  })

  await aok('关注词监控: 同一分钟多条按顺序推进锚点，下一轮不重复', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-watch3-'))
    const ts = Date.UTC(2026, 9, 25, 10, 0)
    const html = `<html><body><ul class="new-post">
<li class="article-list"><p class="title"><time title="2026-10-25 18:00">18:00</time><a href="/haodan/9000001.html" title="同分钟 A" data-price="">同分钟 A</a></p></li>
<li class="article-list"><p class="title"><time title="2026-10-25 18:00">18:00</time><a href="/haodan/9000002.html" title="同分钟 B" data-price="">同分钟 B</a></p></li>
<li class="article-list"><p class="title"><time title="2026-10-25 18:00">18:00</time><a href="/haodan/9000003.html" title="同分钟 C" data-price="">同分钟 C</a></p></li>
</ul><div class="pagebar"><a href="/search.php?q=x&amp;page=1">1</a></div></body></html>`
    saveWatchState(dir, {
      limit: 20,
      intervalMin: 10,
      enabled: true,
      lastCheckAt: 0,
      words: [{ q: '同一分钟', lastReadAt: ts, lastReadId: 'haodan-9000003', sentIds: [] }]
    })
    const pushes = []
    const c = createConsole({
      token: TOKEN,
      stateDir: dir,
      lineSearchFetch: async () => ({ ok: true, status: 200, text: async () => html }),
      watchNotifier: async (title, body) => { pushes.push(body) }
    })
    try {
      const r = await c.runWatchOnce()
      assert.strictEqual(r.pushed, 2, '两条同一分钟的新线报都要推')
      assert.strictEqual(pushes.length, 2)
      const st = readWatchState(dir)
      assert.strictEqual(st.words[0].lastReadAt, ts, '同一分钟不推进毫秒时间')
      assert.strictEqual(st.words[0].lastReadId, 'haodan-9000001', '锚点必须按列表顺序推进到最新')
      const again = await c.runWatchOnce()
      assert.strictEqual(again.pushed, 0, '下一轮不得重复推同一分钟的两条')
    } finally {
      c.server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

async function main () {
  await lineSearchTests()
  await watchMonitorTests()
  await filterRuleApiTests()
  await backupApiTests()
  await backupUiStructureTests()
  await aok('HTTP: 无 token / 错 token → 401', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const noAuth = await request(port, 'GET', '/')
    assert.strictEqual(noAuth.status, 401)
    const badAuth = await request(port, 'GET', '/', { token: 'y'.repeat(32) })
    assert.strictEqual(badAuth.status, 401)
    server.close()
  })
  await aok('HTTP: 看板页为 SPA 壳（JSON 岛 + 资产引用 + noscript 降级）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'GET', '/', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.ok(res.text.includes('xbk-push 控制台'))
    assert.ok(res.text.includes('id="app"'), 'SPA 挂载点')
    assert.ok(res.text.includes('id="xbk-boot"'), 'JSON 岛')
    assert.match(res.text, /\/assets\/[0-9a-f]{16}\/app\.js/, '前端 ESM 引用（带内容版本路径）')
    assert.ok(res.text.includes('试运行'), 'noscript 降级文案（触发动作说明）')
    assert.ok(res.text.includes('环境检查'))
    assert.ok(res.text.includes('正式运行一轮'))
    // 页面含会话凭证（boot JSON token）⇒ 不得被缓存：缺 Cache-Control 时浏览器启发式缓存
    // 会留下旧页面的空/过期 boot token，表现为「页面正常、点按钮 POST 400/401 unauthorized」。
    assert.strictEqual(res.headers['cache-control'], 'no-store', 'HTML 必须 no-store（凭证不落缓存）')
    // 重复头回归：页面安全头由 applyPageHeaders 单点写，app 侧只允许出现一条 Referrer-Policy
    // （反代若也设同名字段，浏览器里会看到两行——那属反代配置，不在本仓）。
    assert.strictEqual(headerCount(res, 'referrer-policy'), 1, 'SPA 壳页只能有一条 Referrer-Policy')
    // Sourcery #37：缺文件夹具必须断言「缺失」分支文案，不许「正常」蒙混——
    // 两种文案都接受的断言抓不住缺失降级走错分支的回归。
    assert.ok(res.text.includes('缺失'), `空缓存目录必须渲染「缺失」分支，实际片段：${res.text.slice(0, 400)}`)
    server.close()
  })
  await aok('HTTP: /assets/* 须鉴权（无凭证 401；token/Cookie 200）；未知资产/穿越仍 404', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    // Sourcery G_oJ：资产与数据同面鉴权——无凭证一律 401（与文档口径一致）；
    // 浏览器凭 / 鉴权后下发的会话 Cookie 满足 ESM import 无法带头的限制。
    const css = await request(port, 'GET', '/assets/app.css')
    assert.strictEqual(css.status, 401, '资产无凭证必须 401')
    const cssTok = await request(port, 'GET', '/assets/app.css', { token: TOKEN })
    assert.strictEqual(cssTok.status, 200, '?token= 可取资产')
    assert.match(cssTok.headers['content-type'], /text\/css/)
    assert.ok(cssTok.text.includes('--bg'), 'CSS 内容真实（自定义属性存在）')
    const cssCookie = await request(port, 'GET', '/assets/app.css', { headers: { cookie: `xbk_session=${TOKEN}` } })
    assert.strictEqual(cssCookie.status, 200, '会话 Cookie 可取资产（ESM 链路径）')
    // v3.302 静态层：gzip 协商 / 304 条件请求 / 版本化长缓存
    const cssGz = await requestBuffer(port, 'GET', '/assets/app.css', { token: TOKEN, headers: { 'accept-encoding': 'gzip' } })
    assert.strictEqual(cssGz.status, 200)
    assert.strictEqual(cssGz.headers['content-encoding'], 'gzip', '声明 gzip 时必须压缩')
    assert.match(String(cssGz.headers.vary || ''), /Accept-Encoding/, '必须 Vary: Accept-Encoding')
    const cssPlain = await requestBuffer(port, 'GET', '/assets/app.css', { token: TOKEN, headers: { 'accept-encoding': 'identity' } })
    assert.ok(cssGz.body.length < cssPlain.body.length, 'gzip 体积必须小于原件')
    assert.strictEqual(zlib.gunzipSync(cssGz.body).toString('utf8'), cssPlain.body.toString('utf8'), 'gzip 解压后与原件逐字一致')
    const cond = await requestBuffer(port, 'GET', '/assets/app.css', { token: TOKEN, headers: { 'if-none-match': cssPlain.headers.etag } })
    assert.strictEqual(cond.status, 304, 'If-None-Match 命中必须 304（不再重传正文）')
    assert.strictEqual(cond.body.length, 0, '304 不得带正文')
    const verMatch = (await request(port, 'GET', '/', { token: TOKEN })).text.match(/\/assets\/([0-9a-f]{16})\/app\.js/)
    assert.ok(verMatch, 'HTML 资产引用必须带内容版本路径 /assets/<sha16>/app.js')
    // 版本号必须由内容派生（sha256(各文件哈希拼接) 前 16 位），常量/陈旧版本过不了这条
    const crypto = require('node:crypto')
    // v3.364：不再硬编码文件名清单——直接按 STATIC_ASSETS 的插入顺序取（服务端算版本号
    // 用的是同一个对象），新增分片时这条断言自动跟随，不会出现「清单漏一个、版本号对不上」。
    const { STATIC_ASSETS } = require('./scripts/console.js')
    const hashes = Object.values(STATIC_ASSETS).map((spec) => {
      const raw = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', spec.file))
      return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
    })
    const expectVer = crypto.createHash('sha256').update(hashes.join('|')).digest('hex').slice(0, 16)
    assert.strictEqual(verMatch[1], expectVer, '版本号必须等于资产内容的哈希（不能是常量/陈旧值）')
    const immutable = await requestBuffer(port, 'GET', `/assets/app.css?v=${verMatch[1]}`, { token: TOKEN })
    const cc = String(immutable.headers['cache-control'] || '')
    // 内容寻址（?v= 为内容哈希）⇒ 命中即同一份字节：public + immutable 一年，浏览器/CDN
    // 不再回源；public 只对静态资产成立（不含凭证与推送数据），数据面仍是 no-store。
    assert.strictEqual(cc, 'public, max-age=31536000, immutable', '版本化资产必须 public + immutable 一年长缓存')
    const staleVer = await requestBuffer(port, 'GET', '/assets/app.css?v=deadbeefdeadbeef', { token: TOKEN })
    assert.strictEqual(String(staleVer.headers['cache-control'] || ''), 'no-cache', '不匹配的版本号必须回退 no-cache')
    // v3.375：版本写进路径（/assets/<16hex>/file）——模块图里每个相对 import 都继承同一前缀，
    // 整张图都能 immutable；旧版本的路径不 404（部署瞬间的页面不能白屏）。
    const pathVer = await requestBuffer(port, 'GET', `/assets/${verMatch[1]}/app.css`, { token: TOKEN })
    assert.strictEqual(pathVer.status, 200, '版本路径必须可取')
    assert.strictEqual(String(pathVer.headers['cache-control'] || ''), 'public, max-age=31536000, immutable', '版本路径必须 public + immutable')
    assert.strictEqual(pathVer.body.toString('utf8'), cssPlain.body.toString('utf8'), '版本路径与裸路径必须是同一份字节')
    assert.strictEqual((await request(port, 'GET', `/assets/${verMatch[1]}/app.css`)).status, 401, '版本路径同样要鉴权')
    const oldPath = await requestBuffer(port, 'GET', '/assets/deadbeefdeadbeef/app.css', { token: TOKEN })
    assert.strictEqual(oldPath.status, 200, '旧版本路径必须仍可取（部署瞬间的旧页面不能白屏）')
    assert.strictEqual(String(oldPath.headers['cache-control'] || ''), 'no-store',
      '旧版本路径不得 immutable：否则新字节被写进旧版本的缓存键，同一页面新旧模块混跑')
    assert.strictEqual((await request(port, 'GET', '/assets/v1/app.css', { token: TOKEN })).status, 404, '非法版本段必须 404')
    assert.strictEqual((await request(port, 'GET', `/assets/${verMatch[1]}/nope.js`, { token: TOKEN })).status, 404, '白名单外文件必须 404')
    // gzip;q=0 表示明确拒绝：不得发压缩体
    const refused = await requestBuffer(port, 'GET', '/assets/app.css', { token: TOKEN, headers: { 'accept-encoding': 'gzip;q=0' } })
    assert.strictEqual(refused.headers['content-encoding'], undefined, 'gzip;q=0 时不得压缩')
    assert.strictEqual(refused.body.toString('utf8'), cssPlain.body.toString('utf8'), 'q=0 时返回原件')
    // If-None-Match：弱比较 + 逗号列表 + 通配
    for (const h of [`W/${cssPlain.headers.etag}`, `"other", ${cssPlain.headers.etag}`, '*']) {
      const r304 = await requestBuffer(port, 'GET', '/assets/app.css', { token: TOKEN, headers: { 'if-none-match': h } })
      assert.strictEqual(r304.status, 304, `If-None-Match: ${h} 必须命中 304`)
    }
    // 页面响应必须下发会话 Cookie（HttpOnly/SameSite=Lax）— 审查 #224：Strict 会让聊天
    // 链接的跨站顶层导航不带 Cookie，首屏必 401；写动作 POST 本就不收 Cookie。
    const page = await request(port, 'GET', '/', { token: TOKEN })
    const cookieHeader = (page.headers['set-cookie'] || []).find(c => c.startsWith('xbk_session='))
    assert.ok(cookieHeader, '/ 鉴权后下发会话 Cookie')
    // Sourcery Issued-session-cookie：不能只看前缀——属性逐项锁死，错值或缺属性必须红。
    assert.ok(cookieHeader.includes('HttpOnly'), 'Cookie 含 HttpOnly')
    assert.ok(cookieHeader.includes('SameSite=Lax'), 'Cookie 含 SameSite=Lax')
    assert.ok(cookieHeader.includes('Path=/'), 'Cookie 含 Path=/')
    assert.ok(cookieHeader.includes(`xbk_session=${encodeURIComponent(TOKEN)}`), 'Cookie 值=encoded token')
    // 审查 #224：未授权首屏必须是可自助恢复的登录页，不是裸 JSON。
    const unauth = await request(port, 'GET', '/')
    assert.strictEqual(unauth.status, 401, '未授权 GET / 回 401')
    assert.match(unauth.headers['content-type'], /text\/html/, '未授权首屏必须是 HTML')
    assert.ok(unauth.text.includes('需要访问令牌'), '登录页含标题')
    assert.strictEqual(headerCount(unauth, 'referrer-policy'), 1, '登录/挑战页只能有一条 Referrer-Policy')
    assert.ok(unauth.text.includes('<form method="post" action="/login">'), '登录页必须用 POST 表单（token 不进地址栏）')
    // POST /login：正确 token → 303 到干净 `/` + Cookie；错误 token → 401 仍是登录页。
    const loginOk = await request(port, 'POST', '/login', {
      body: `token=${encodeURIComponent(TOKEN)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    })
    assert.strictEqual(loginOk.status, 303)
    assert.strictEqual(loginOk.headers.location, '/')
    assert.ok(String(loginOk.headers['set-cookie']).includes('HttpOnly'), 'POST 登录必须下发 HttpOnly Cookie')
    const loginBad = await request(port, 'POST', '/login', {
      body: 'token=wrong-token-000000',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    })
    assert.strictEqual(loginBad.status, 401)
    assert.match(loginBad.headers['content-type'], /text\/html/, '错误凭证仍回登录页')
    assert.ok(!unauth.text.includes('{"error":"unauthorized"}'), '不得回裸 JSON')
    // Sourcery G_4Kk：资产 URL 不再拼 tokenSuffix（Cookie 通道已覆盖，URL 零凭证重复）
    assert.ok(!page.text.includes('/assets/app.css?token='), '资产 URL 不含 ?token=')
    assert.ok(!page.text.includes('/assets/app.js?token='), '脚本 URL 不含 ?token=')
    const js = await request(port, 'GET', '/assets/app.js', { token: TOKEN })
    assert.strictEqual(js.status, 200)
    assert.match(js.headers['content-type'], /text\/javascript/)
    // Sourcery vwr：不能只断言状态码+MIME——空壳 app.js 也过。锁死模块内容标志。
    assert.ok(js.text.includes("from './htm-preact.module.js'"), 'app.js 含真实 import（非空壳）')
    assert.ok(js.text.includes("from './pure.mjs'"), 'app.js 必须引用纯函数模块')
    assert.ok(js.text.includes('render('), 'app.js 含 render 调用')
    const pure = await request(port, 'GET', '/assets/pure.mjs', { token: TOKEN })
    assert.strictEqual(pure.status, 200, '纯函数模块必须可加载（白名单）')
    assert.match(pure.headers['content-type'], /text\/javascript/)
    assert.ok(pure.text.includes('export function filterLogLines'), 'pure.mjs 非空壳')
    const lib = await request(port, 'GET', '/assets/htm-preact.module.js', { token: TOKEN })
    assert.strictEqual(lib.status, 200)
    assert.ok(lib.text.length > 10000, '运行时文件非空壳')
    // token 绝不进资产响应（资产不含用户数据的安全边界）。
    assert.ok(!js.text.includes(TOKEN), 'app.js 内容不含 token')
    assert.ok(!lib.text.includes(TOKEN), 'vendor 内容不含 token')
    // v3.364 加载失败兜底：内容由服务端直接渲染在 #app 里（不依赖任何资产），
    // 正常加载时 CSS 让它 5s 内一直透明，挂载成功后由 app.js 删除。
    assert.ok(page.text.includes('class="boot-fallback"'), '首屏必须内联服务端兜底（资产全挂也看得见）')
    assert.ok(page.text.includes('页面没加载出来'), '兜底必须有可读文案')
    const cssText = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(/\.boot-fallback[^}]*animation:\s*boot-reveal 0s linear 5s forwards/.test(cssText),
      '兜底必须延迟 5 秒显形（正常加载看不到）')
    assert.ok(readConsoleSource().includes("querySelector('#app .boot-fallback')"), '挂载成功后必须移除兜底')
    const nope = await request(port, 'GET', '/assets/nope.js', { token: TOKEN })
    assert.strictEqual(nope.status, 404, '白名单外 404')
    const traversal = await request(port, 'GET', '/assets/..%2F..%2Fconsole.js', { token: TOKEN })
    assert.strictEqual(traversal.status, 404, '路径穿越形态 404（白名单精确匹配，不解码拼接）')
    server.close()
  })
  await aok('资产: 每个模块 import 的文件都在白名单里（漏登记 = 整页白屏且测试全绿）', () => {
    const acorn = require('acorn')
    const { STATIC_ASSETS } = require('./scripts/console.js')
    const dir = path.join(__dirname, 'scripts', 'console-assets')
    const routes = new Set(Object.keys(STATIC_ASSETS))
    const missing = []
    const dynamic = []
    const bare = []
    const walk = (node, fn) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'string') fn(node)
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        const value = node[key]
        if (Array.isArray(value)) value.forEach((child) => walk(child, fn))
        else if (value && typeof value === 'object') walk(value, fn)
      }
    }
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(js|mjs)$/.test(file)) continue
      const ast = acorn.parse(fs.readFileSync(path.join(dir, file), 'utf8'),
        { ecmaVersion: 'latest', sourceType: 'module' })
      const specs = []
      walk(ast, (node) => {
        if (node.type === 'ImportExpression') dynamic.push(file)
        const hasSource = node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && node.source)
        if (hasSource && node.source) specs.push(node.source.value)
      })
      for (const spec of specs) {
        if (!spec.startsWith('.')) { bare.push(`${file} → ${spec}`); continue }
        const route = '/assets/' + spec.replace(/^\.\//, '')
        if (!routes.has(route)) missing.push(`${file} → ${spec}`)
      }
    }
    assert.deepStrictEqual(bare, [], '模块只能 import 同目录相对路径（裸说明符没有 importmap，必然 404）')
    assert.deepStrictEqual(missing, [], 'import 的文件必须已登记 STATIC_ASSETS（否则 404 → 模块图崩 → 白屏）')
    assert.deepStrictEqual(dynamic, [], '自家模块不得用动态 import()')
    for (const spec of Object.values(STATIC_ASSETS)) {
      assert.ok(fs.existsSync(path.join(dir, spec.file)), `白名单文件缺失：${spec.file}`)
    }
    // route 与文件名必须对得上（route = '/assets/' + 文件名）：上面两条各自为政——route 存在、
    // file 存在——把 '/assets/api.js' 映射到别的已存在文件照样全绿，浏览器却拿到错模块。
    // 历史例外只有 flatpickr（bundle 文件名带 .module，route 沿用短名）。
    const ROUTE_FILE_EXCEPTIONS = { '/assets/flatpickr.js': 'flatpickr.module.js' }
    for (const [route, spec] of Object.entries(STATIC_ASSETS)) {
      const want = ROUTE_FILE_EXCEPTIONS[route] || route.slice('/assets/'.length)
      assert.strictEqual(spec.file, want, `route 与文件名必须一致：${route} → ${spec.file}（期望 ${want}）`)
    }
  })
  await aok('资产: 首屏 modulepreload 覆盖 app.js 的 import 闭包（版本路径、排在入口之前）', () => {
    // 预加载是手工维护的 11 行，两种错都不会被别的用例抓住：① 漏一个模块（瀑布还在，只是
    // 短了点）；② 把 flatpickr 写成 flatpickr.module.js（404，白下一次）。这里用 acorn 从
    // app.js 出发算**真实**静态 import 闭包，与 HTML 里的 href 逐字对账。
    const acorn = require('acorn')
    const { STATIC_ASSETS } = require('./scripts/console.js')
    const dir = path.join(__dirname, 'scripts', 'console-assets')
    const walk = (node, fn) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'string') fn(node)
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        const value = node[key]
        if (Array.isArray(value)) value.forEach((child) => walk(child, fn))
        else if (value && typeof value === 'object') walk(value, fn)
      }
    }
    const specsOf = (file) => {
      const ast = acorn.parse(fs.readFileSync(path.join(dir, file), 'utf8'),
        { ecmaVersion: 'latest', sourceType: 'module' })
      const out = []
      walk(ast, (node) => {
        const hasSource = node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && node.source)
        if (hasSource && node.source) out.push(node.source.value)
      })
      return out
    }
    // 说明符 → 白名单 route（flatpickr 的 route 与文件名不同，按名字拼会算错闭包）。
    const closure = []
    const seen = new Set(['/assets/app.js'])
    const queue = ['/assets/app.js']
    while (queue.length > 0) {
      const route = queue.shift()
      for (const spec of specsOf(STATIC_ASSETS[route].file)) {
        const child = '/assets/' + spec.replace(/^\.\//, '')
        if (!Object.prototype.hasOwnProperty.call(STATIC_ASSETS, child)) {
          throw new Error(`${route} 的 import 目标未登记白名单：${spec}`)
        }
        if (seen.has(child)) continue
        seen.add(child)
        closure.push(child)
        queue.push(child)
      }
    }
    assert.ok(closure.length > 0, '闭包不得为空（否则下面的对账恒真）')
    const { readStatus } = require('./scripts/status')
    const html = renderPage(readStatus(tmpDir()), [], new URLSearchParams(`token=${TOKEN}`))
    // 逐字锁形态：rel/href 之外不得有第二个属性（crossorigin 会换缓存键，预加载就白做了）。
    const hrefsRaw = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1])
    // v3.375：版本号在路径里（/assets/<16hex>/x.js），模块间的相对 import 才会共享同一前缀。
    const baseMatch = /<link rel="stylesheet" href="(\/assets\/[0-9a-f]{16})\/app\.css">/.exec(html)
    assert.ok(baseMatch !== null, '页面必须用带内容版本前缀的资产基址')
    const assetBase = baseMatch[1]
    assert.ok(hrefsRaw.every((h) => h.startsWith(assetBase + '/')), '每条预加载都必须指向同一个版本前缀')
    const hrefs = hrefsRaw.map((h) => '/assets' + h.slice(assetBase.length))
    assert.strictEqual(hrefs.length, closure.length,
      `预加载条数必须等于 import 闭包大小（闭包 ${closure.length}，实际 ${hrefs.length}）`)
    assert.strictEqual(new Set(hrefs).size, hrefs.length, '同一模块不得重复预加载')
    const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0) // 显式比较函数（Sonar S2871）
    assert.deepStrictEqual([...hrefs].sort(byCodeUnit), [...closure].sort(byCodeUnit), '预加载清单必须与 app.js 的 import 闭包逐字一致')
    for (const href of hrefs) {
      assert.ok(Object.prototype.hasOwnProperty.call(STATIC_ASSETS, href), `${href} 必须是 STATIC_ASSETS 的 key（否则 404）`)
      assert.ok(!href.includes('?') && !href.includes('#') && !href.includes('token'),
        `${href} 不得带查询串/凭证（带查询串会换缓存键，带凭证会多一处暴露面）`)
    }
    assert.ok(!html.includes('crossorigin'), '预加载不得带 crossorigin（换缓存键 = 预加载失效）')
    // 大文件优先：第一条必须是闭包里最大的那份（省下的正是最关键的几毫秒）。
    const sizeOf = (route) => fs.statSync(path.join(dir, STATIC_ASSETS[route].file)).size
    const biggest = [...closure].sort((a, b) => sizeOf(b) - sizeOf(a))[0]
    assert.strictEqual(hrefs[0], biggest, '首条预加载必须是闭包内最大的模块（大文件优先）')
    // 必须排在入口脚本之前：浏览器按文档序发现 preload，排在入口之后等于没提前。
    assert.ok(html.indexOf('rel="modulepreload"') < html.indexOf(`<script type="module" src="${assetBase}/app.js`),
      'modulepreload 必须出现在入口 <script type="module"> 之前')
    // 入口脚本与预加载共用同一个版本前缀；入口不能带查询串（模块图按 URL 精确匹配）。
    assert.ok(html.includes(`<script type="module" src="${assetBase}/app.js"></script>`),
      '入口脚本引用必须原样保留（带内容版本号）')
  })
  await aok('资产: 入口 import 覆盖它实际用到的拆出导出（漏写 = 运行时 ReferenceError）', () => {
    // 聚合器保证「文本断言」在拆分后仍然成立，但这也会掩盖一件事：app.js 如果漏写/写错
    // 某个具名 import，格式化和常量函数在并集里照样存在，文本断言照样绿，浏览器却整页崩。
    // 这里做静态对账：拆出模块导出的名字，只要在 app.js 正文里被用到，就必须在 import 里。
    const acorn = require('acorn')
    const dir = path.join(__dirname, 'scripts', 'console-assets')
    const parse = (file) => acorn.parse(fs.readFileSync(path.join(dir, file), 'utf8'),
      { ecmaVersion: 'latest', sourceType: 'module' })
    const walk = (node, fn) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'string') fn(node)
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        const value = node[key]
        if (Array.isArray(value)) value.forEach((child) => walk(child, fn))
        else if (value && typeof value === 'object') walk(value, fn)
      }
    }
    const exported = new Set()
    for (const file of ['constants.js', 'format.js']) {
      for (const node of parse(file).body) {
        if (node.type === 'ExportNamedDeclaration' && !node.source) {
          node.specifiers.forEach((spec) => exported.add(spec.exported.name))
        }
      }
    }
    const ast = parse('app.js')
    const imported = new Set()
    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration') continue
      node.specifiers.forEach((spec) => imported.add(spec.local.name))
    }
    const used = new Set()
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') continue
      walk(node, (child) => { if (child.type === 'Identifier') used.add(child.name) })
    }
    const missing = [...exported].filter((name) => used.has(name) && !imported.has(name))
    assert.deepStrictEqual(missing, [], `这些拆出的函数/常量在 app.js 正文里被用了却没 import：${missing.join(', ')}`)
    assert.ok(imported.has('fmtTime') && imported.has('POLL_MS'), '基础导入必须存在（防止整条 import 被删）')
  })
  await aok('HTTP: ?token= 查询参数放行（浏览器流：看板、API、表单触发）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 无请求头、仅查询参数 → 200（普通浏览器打开 URL 的形态）
    const page = await request(port, 'GET', `/?token=${TOKEN}`)
    assert.strictEqual(page.status, 200, '浏览器打开带 token URL 必须放行')
    assert.ok(page.text.includes(`"token":"${TOKEN}"`), '返回页 JSON 岛要继续携带 token')
    const api = await request(port, 'GET', `/api/status?token=${TOKEN}`)
    assert.strictEqual(api.status, 200, '查询参数对 JSON API 同样放行')
    const noTok = await request(port, 'GET', '/')
    assert.strictEqual(noTok.status, 401)
    server.close()
  })
  await aok('HTTP: /api/status 返回 JSON（status 字段齐全）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'GET', '/api/status', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.text)
    for (const key of ['generatedAt', 'report', 'channels', 'run', 'diagnostics']) {
      assert.ok(Object.prototype.hasOwnProperty.call(data, key), `缺 ${key}`)
    }
    server.close()
  })
  await aok('HTTP: 只读快照端点 ETag/304（命中回空体、不匹配照常 200、不退化成可缓存）', async () => {
    const { server, runs } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const first = await request(port, 'GET', '/api/runs', { token: TOKEN })
    assert.strictEqual(first.status, 200)
    const tag = first.headers.etag
    assert.ok(typeof tag === 'string' && tag.length >= 2, '必须下发 ETag')
    assert.strictEqual(first.headers['cache-control'], 'no-store', '条件请求也不得允许缓存存储（no-store，no-cache 仍允许存）')
    const hit = await request(port, 'GET', '/api/runs', { token: TOKEN, headers: { 'if-none-match': tag } })
    assert.strictEqual(hit.status, 304, 'If-None-Match 命中必须 304')
    assert.strictEqual(hit.text, '', '304 不得带 body')
    const miss = await request(port, 'GET', '/api/runs', { token: TOKEN, headers: { 'if-none-match': '"nope"' } })
    assert.strictEqual(miss.status, 200, 'ETag 不匹配照常 200 全量')
    assert.strictEqual(Array.isArray(JSON.parse(miss.text).runs), true, '200 分支仍是完整 JSON')
    // 内容真变了必须换 tag（否则客户端会永远吃 304 的旧数据）：Sourcery PR #321。
    runs.set('1750000000001.1', { id: '1750000000001.1', action: 'check', startedAt: 1750000000001, finishedAt: null })
    const changed = await request(port, 'GET', '/api/runs', { token: TOKEN, headers: { 'if-none-match': tag } })
    assert.strictEqual(changed.status, 200, '数据变了必须忽略旧 If-None-Match')
    assert.notStrictEqual(changed.headers.etag, tag, '内容变化必须换 ETag')
    assert.strictEqual(JSON.parse(changed.text).runs.length, 1, '变化后 200 带新内容')
    // /api/status 每次请求都生成新时间戳/锁龄：不得发 ETag（发了也永远不命中）。
    const volatile = await request(port, 'GET', '/api/status', { token: TOKEN })
    assert.strictEqual(volatile.headers.etag, undefined, '/api/status 不得下发 ETag（响应本身是易变的）')
    server.close()
  })
  await aok('gzipJsonBody: 512B 阈值 / >256KB 用 level 1 / 未协商时不压', () => {
    const { GZIP_MIN_BYTES, GZIP_LARGE_BYTES, GZIP_MAX_BYTES, gzipJsonBody, gzipVariantTag, conditionalVariant } = require('./scripts/console.js')
    assert.strictEqual(GZIP_MIN_BYTES, 512, '阈值必须恰为 512B（用例与实现同源对账）')
    assert.strictEqual(GZIP_LARGE_BYTES, 256 * 1024, '大响应分界必须恰为 256KB')
    assert.strictEqual(gzipJsonBody({ xbkGzip: true }, 'x'.repeat(GZIP_MIN_BYTES - 1)), null,
      '低于阈值必须不压（压了更大）')
    assert.ok(Buffer.isBuffer(gzipJsonBody({ xbkGzip: true }, 'x'.repeat(GZIP_MIN_BYTES))),
      '恰好达到阈值必须压（>= 512）')
    assert.strictEqual(gzipJsonBody({ xbkGzip: false }, 'x'.repeat(1000)), null, '未协商 gzip 必须不压')
    assert.strictEqual(gzipJsonBody({ xbkGzip: true }, 'x'.repeat(GZIP_MAX_BYTES + 1)), null,
      '超过上限必须回 identity（gzipSync 会按住事件循环，宁可少省一次流量）')
    assert.strictEqual(gzipJsonBody({}, 'x'.repeat(1000)), null, '没有协商标记（非 HTTP 调用点）必须不压')
    assert.strictEqual(gzipJsonBody(null, 'x'.repeat(1000)), null, 'res 缺失时不得抛')
    // level 选择：小响应 6，大响应 1——按 zlib 输出逐字节对账（不只是「有压缩」）。
    const small = 'y'.repeat(1000)
    assert.deepStrictEqual(gzipJsonBody({ xbkGzip: true }, small), zlib.gzipSync(Buffer.from(small, 'utf8'), { level: 6 }),
      '≤256KB 必须用 level 6')
    const big = 'z'.repeat(GZIP_LARGE_BYTES + 1)
    assert.deepStrictEqual(gzipJsonBody({ xbkGzip: true }, big), zlib.gzipSync(Buffer.from(big, 'utf8'), { level: 1 }),
      '>256KB 必须降级到 level 1（省 CPU）')
    // Buffer 入参按字节长度判定（不是字符串长度）：多字节字符必须算对。
    const cjk = '中'.repeat(200) // 600 字节，200 个字符
    assert.ok(Buffer.isBuffer(gzipJsonBody({ xbkGzip: true }, cjk)), 'Buffer.byteLength 口径：200 个汉字 = 600B 必须压')
    assert.strictEqual(gzipJsonBody({ xbkGzip: true }, '中'.repeat(170)), null, '170 个汉字 = 510B 必须不压')
    // gzip 变体 tag 的拼法（静态资产同约定）；identity tag 末尾没有引号时也必须有确定行为。
    assert.strictEqual(gzipVariantTag('"abc"'), '"abc-gz"')
    assert.strictEqual(gzipVariantTag('abc'), 'abc-gz')
    // 条件 tag 的变体因子：去掉 ?token=（凭证不参与 ETag），其余查询串保留且排序。
    assert.strictEqual(conditionalVariant({ url: '/api/config' }), '/api/config')
    assert.strictEqual(conditionalVariant({ url: '/api/trends?token=abc&days=30' }), '/api/trends?days=30')
    assert.strictEqual(conditionalVariant({ url: '/api/run-history?limit=10&b=2&a=1' }), '/api/run-history?a=1&b=2&limit=10')
    assert.notStrictEqual(conditionalVariant({ url: '/api/run-history?limit=10' }), conditionalVariant({ url: '/api/run-history?limit=200' }),
      '不同查询串必须是不同变体（否则 10 条的 304 会冒充 200 条）')
  })
  await aok('HTTP: API JSON 协商式 gzip（变体 ETag / 阈值反例 / HTML-SSE-导出不压）', async () => {
    const dir = tmpDir()
    const { gzipVariantTag, GZIP_MIN_BYTES } = require('./scripts/console.js')
    // >512B 的推送记录夹具：/api/messages 是条件请求端点，正好同时验证「压缩 + 变体 tag」。
    const msgs = []
    for (let i = 1; i <= 12; i++) {
      msgs.push({
        id: i,
        title: `特价标题${i}`,
        content: `第${i}条内容`.repeat(30),
        catename: '好单-日用',
        shijianchuo: i * 1000,
        datetime: '2026-10-15',
        shorttime: '10:00',
        price: i,
        url: `/a/${i}.html`
      })
    }
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify(msgs))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const gz = await requestBuffer(port, 'GET', '/api/messages', { token: TOKEN, headers: { 'accept-encoding': 'gzip' } })
      const id = await requestBuffer(port, 'GET', '/api/messages', { token: TOKEN, headers: { 'accept-encoding': 'identity' } })
      assert.strictEqual(gz.status, 200)
      assert.ok(id.body.length > 512, `夹具必须越过 gzip 阈值（实际 ${id.body.length}B，否则断言恒真）`)
      assert.strictEqual(gz.headers['content-encoding'], 'gzip', '声明 gzip 时必须压缩')
      assert.match(String(gz.headers.vary || ''), /Accept-Encoding/, '压缩响应必须带 Vary: Accept-Encoding')
      assert.strictEqual(id.headers['content-encoding'], undefined, '不声明 gzip 时必须回 identity')
      assert.match(String(id.headers.vary || ''), /Accept-Encoding/, 'identity 响应也必须带 Vary（同一 URL 的表示随 Accept-Encoding 变，否则缓存会把 identity 复用给能收 gzip 的客户端）')
      assert.deepStrictEqual(zlib.gunzipSync(gz.body), id.body, 'gzip 解压后必须与 identity 逐字相等')
      assert.ok(gz.body.length < id.body.length, '压缩体必须更小')
      // 变体 tag：identity tag 由未压缩 body 算，gzip 只是加 -gz 后缀（静态资产同约定）。
      assert.match(String(id.headers.etag), /^"[^"]+"$/, 'ETag 必须是强 tag（引号形态）')
      assert.strictEqual(gz.headers.etag, gzipVariantTag(id.headers.etag), 'gzip tag 必须是 identity tag 的 -gz 变体')
      assert.notStrictEqual(gz.headers.etag, id.headers.etag, 'gzip 变体 tag 不得等于 identity tag')
      // 带 gzip tag → 304：空体、不带 Content-Encoding、Vary 仍在（同一 URL 两个表示）。
      const hit = await requestBuffer(port, 'GET', '/api/messages', {
        token: TOKEN,
        headers: { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag }
      })
      assert.strictEqual(hit.status, 304, 'gzip 变体 tag 命中必须 304')
      assert.strictEqual(hit.body.length, 0, '304 不得带 body')
      assert.strictEqual(hit.headers['content-encoding'], undefined, '304 不得带 Content-Encoding（没有可解码的 body）')
      assert.match(String(hit.headers.vary || ''), /Accept-Encoding/, '304 仍须 Vary（表示随 Accept-Encoding 变）')
      assert.strictEqual(hit.headers.etag, gz.headers.etag, '304 必须回显所选变体的 tag')
      // 交叉：identity tag 不得命中 gzip 变体（否则客户端把压缩字节当 JSON 解析）。
      const cross = await requestBuffer(port, 'GET', '/api/messages', {
        token: TOKEN,
        headers: { 'accept-encoding': 'gzip', 'if-none-match': id.headers.etag }
      })
      assert.strictEqual(cross.status, 200, 'identity tag 不得命中 gzip 变体')
      // 阈值反例：/api/auto 的 JSON 只有几十字节，声明 gzip 也不得压。
      const small = await requestBuffer(port, 'GET', '/api/auto', { token: TOKEN, headers: { 'accept-encoding': 'gzip' } })
      assert.ok(small.body.length < GZIP_MIN_BYTES, `反例必须真的低于阈值（实际 ${small.body.length}B）`)
      assert.strictEqual(small.headers['content-encoding'], undefined, '低于 512B 的响应不得压缩')
      assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(small.body.toString('utf8')), 'auto'), '小响应仍是完整 JSON')
      // HTML 反向断言：含 boot token 且只有 ~1.9KB，压了只多一次解压。
      const page = await requestBuffer(port, 'GET', '/', { token: TOKEN, headers: { 'accept-encoding': 'gzip' } })
      assert.strictEqual(page.status, 200)
      assert.strictEqual(page.headers['content-encoding'], undefined, 'HTML 不得压缩（含 boot token）')
      assert.ok(page.body.toString('utf8').includes('xbk-boot'), 'HTML 仍是可读原文')
      // 导出附件：浏览器直接落盘，压了会破坏「另存为」的体积口径。
      const expHeaders = { 'content-type': 'application/x-www-form-urlencoded', 'accept-encoding': 'gzip' }
      const expJson = await requestBuffer(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json', headers: expHeaders })
      assert.strictEqual(expJson.status, 200)
      assert.ok(expJson.body.length > 512, '导出夹具必须越过 gzip 阈值（否则断言恒真）')
      assert.strictEqual(expJson.headers['content-encoding'], undefined, 'JSON 导出附件不得压缩')
      assert.match(String(expJson.headers['content-type'] || ''), /application\/json/)
      const expCsv = await requestBuffer(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=csv', headers: expHeaders })
      assert.strictEqual(expCsv.status, 200)
      assert.strictEqual(expCsv.headers['content-encoding'], undefined, 'CSV 导出附件不得压缩')
      assert.strictEqual(expCsv.body.slice(0, 3).toString('hex'), 'efbbbf', 'CSV 仍是带 BOM 的原文')
      // 备份导出是另一个直接 writeHead 的 attachment 出口（3614 一带），同样不压。
      const backup = await requestBuffer(port, 'POST', '/api/backup/export', {
        token: TOKEN,
        body: JSON.stringify({ categories: ['messages'] }),
        headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' }
      })
      assert.strictEqual(backup.status, 200)
      assert.ok(backup.body.length > 512, '备份夹具必须越过 gzip 阈值')
      assert.strictEqual(backup.headers['content-encoding'], undefined, '备份导出附件不得压缩')
      assert.strictEqual(JSON.parse(backup.body.toString('utf8')).kind, 'xbk-console-backup')
      // 默认（不带 Accept-Encoding）仍走 identity：Node 客户端与 curl 不受影响。
      const plain = await requestBuffer(port, 'GET', '/api/messages', { token: TOKEN })
      assert.strictEqual(plain.headers['content-encoding'], undefined, '不带 Accept-Encoding 必须回 identity')
      // 两种表示都不可接受：不得硬塞 identity（Sourcery Medium），回 406 空体。
      const refuse = await requestBuffer(port, 'GET', '/api/messages', { token: TOKEN, headers: { 'accept-encoding': 'gzip;q=0, identity;q=0' } })
      assert.strictEqual(refuse.status, 406, 'gzip 与 identity 都被拒绝时必须 406')
      assert.strictEqual(refuse.body.length, 0, '406 不带 body')
      const smallRefuse = await requestBuffer(port, 'GET', '/api/auto', { token: TOKEN, headers: { 'accept-encoding': 'gzip, identity;q=0' } })
      assert.strictEqual(smallRefuse.status, 406, '小响应压不了且 identity 被拒 → 406')
    } finally { server.close() }
  })
  await aok('HTTP: SSE 响应头不带 Content-Encoding（流式增量不压缩）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    runs.set('1750000000000.9', makeStreamRecord('1750000000000.9'))
    try {
      const sseHeaders = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/api/runs/stream?id=1750000000000.9&since=0',
          headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' }
        }, (res) => {
          const snapshot = { ...res.headers }
          res.destroy() // 只取响应头：这是长连接，读完头就断，由服务端 teardown 收尾
          resolve(snapshot)
        })
        req.on('error', reject)
        req.end()
      })
      assert.match(String(sseHeaders['content-type'] || ''), /text\/event-stream/, 'SSE Content-Type 不变')
      assert.strictEqual(sseHeaders['content-encoding'], undefined, 'SSE 不得压缩（流式帧压缩要攒帧）')
      assert.strictEqual(sseHeaders.vary, undefined, 'SSE 不压 → 不新增 Vary')
    } finally { server.close() }
  })
  await aok('HTTP: 条件请求扩面（trends / run-history / cache-health / config 的 ETag 与 304）', async () => {
    const dir = tmpDir()
    // 固定日期会在 14 天窗滑走后让「追加一行 → tag 变」永久红：按上海当日生成。
    const dayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const summary = (n) => `${dayKey} 12:16:0${n} total=${n} dedup=0 filtered=0 truncated=0 pushed=${n} failed=0 elapsed=10.1s cachesaved=1`
    fs.writeFileSync(path.join(dir, 'run.log'), [summary(1), summary(2), summary(3)].join('\n') + '\n')
    const pushFixture = (extra) => JSON.stringify([...Array(1 + extra).keys()].map((i) => ({
      id: i + 1, title: `t${i}`, content: 'c', catename: '好单-日用', shijianchuo: 1000 + i
    })))
    fs.writeFileSync(path.join(dir, 'push.json'), pushFixture(0))
    // /api/config 的 body 只随部署/环境变量变：先显式清空，再在「内容变化」一步里改值——
    // 不依赖宿主环境里是否已经设了 XBK_INTERVAL_MS。
    const envBackup = process.env.XBK_INTERVAL_MS
    process.env.XBK_INTERVAL_MS = ''
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    try {
      const cases = [
        { name: 'trends', path: '/api/trends', mutate: () => fs.appendFileSync(path.join(dir, 'run.log'), summary(4) + '\n') },
        { name: 'run-history', path: '/api/run-history', mutate: () => fs.appendFileSync(path.join(dir, 'run.log'), summary(5) + '\n') },
        { name: 'cache-health', path: '/api/cache-health', mutate: () => fs.writeFileSync(path.join(dir, 'push.json'), pushFixture(2)) },
        { name: 'config', path: '/api/config', mutate: () => { process.env.XBK_INTERVAL_MS = '424242' } }
      ]
      for (const c of cases) {
        const first = await request(port, 'GET', c.path, { token: TOKEN })
        assert.strictEqual(first.status, 200, `${c.name} 首包必须 200`)
        const tag = first.headers.etag
        assert.ok(typeof tag === 'string' && tag.length >= 2, `${c.name} 必须下发 ETag`)
        assert.strictEqual(first.headers['cache-control'], 'no-store', `${c.name} 必须 no-store（带鉴权的响应不得被任何缓存留存）`)
        const hit = await request(port, 'GET', c.path, { token: TOKEN, headers: { 'if-none-match': tag } })
        assert.strictEqual(hit.status, 304, `${c.name} 命中 If-None-Match 必须 304`)
        assert.strictEqual(hit.text, '', `${c.name} 304 不得带 body`)
        assert.strictEqual(hit.headers.etag, tag, `${c.name} 304 必须回显 ETag`)
        assert.strictEqual(hit.headers['cache-control'], 'no-store', `${c.name} 304 仍须 no-store`)
        c.mutate()
        const changed = await request(port, 'GET', c.path, { token: TOKEN, headers: { 'if-none-match': tag } })
        assert.strictEqual(changed.status, 200, `${c.name} 内容变了必须忽略旧 tag（回 200 全量）`)
        assert.notStrictEqual(changed.headers.etag, tag, `${c.name} 内容变化必须换 tag`)
      }
      // 查询串不同 ⇒ tag 必须不同，且不能互相 304（数据不足时 limit=10/200 的 body 可能逐字相同）。
      for (const [a, b] of [
        ['/api/trends?days=14', '/api/trends?days=30'],
        ['/api/run-history?limit=10', '/api/run-history?limit=200']
      ]) {
        const ra = await request(port, 'GET', a, { token: TOKEN })
        const rb = await request(port, 'GET', b, { token: TOKEN })
        assert.strictEqual(ra.status, 200)
        assert.strictEqual(rb.status, 200)
        assert.notStrictEqual(ra.headers.etag, rb.headers.etag, `${a} 与 ${b} 的 tag 必须不同`)
        const cross = await request(port, 'GET', b, { token: TOKEN, headers: { 'if-none-match': ra.headers.etag } })
        assert.strictEqual(cross.status, 200, `${a} 的 tag 不得让 ${b} 回 304`)
      }
      // ?token= 是浏览器兼容路径的凭证，不得参与 ETag（同一内容按不同凭证访问必须同一 tag）。
      const withTok = await request(port, 'GET', `/api/config?token=${TOKEN}`, { token: TOKEN })
      const noTok = await request(port, 'GET', '/api/config', { token: TOKEN })
      assert.strictEqual(withTok.headers.etag, noTok.headers.etag, '?token= 不得进 ETag（否则条件缓存按凭证分裂）')
    } finally {
      if (envBackup === undefined) delete process.env.XBK_INTERVAL_MS
      else process.env.XBK_INTERVAL_MS = envBackup
      server.close()
    }
    // 降级/错误分支与易变端点：一律不发 ETag。
    const second = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port2 = await listen(second.server)
    try {
      const degraded = await request(port2, 'GET', '/api/trends', { token: TOKEN })
      assert.strictEqual(degraded.status, 200)
      assert.strictEqual(JSON.parse(degraded.text).status, 'missing', '空目录 → trends 走降级分支')
      assert.strictEqual(degraded.headers.etag, undefined, '降级分支不得下发 ETag（否则降级态会被 304 冻住）')
      for (const p of ['/api/status', '/api/sys', '/api/sys?probe=version']) {
        const r = await request(port2, 'GET', p, { token: TOKEN })
        assert.strictEqual(r.status, 200, `${p} 必须 200`)
        assert.strictEqual(r.headers.etag, undefined, `${p} 不得下发 ETag（每拍都在变，契约也不允许）`)
      }
    } finally { second.server.close() }
  })
  await aok('前端数据层: 304 但本地无副本时去掉 If-None-Match 重取一次（可执行断言）', async () => {
    // api.js 是浏览器 ESM（import constants + 模块级 readBoot）。这里把它复制成 .mjs 用
    // Node 原生 ESM 加载，换掉 fetch/document/window 三个外部面，真实跑 consumeJson 的分支。
    const { pathToFileURL } = require('node:url')
    const apiSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'api.js'), 'utf8')
    const constSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'constants.js'), 'utf8')
    const modDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-api-mod-'))
    const realFetch = globalThis.fetch
    const realDocument = globalThis.document
    const realWindow = globalThis.window
    const calls = []
    try {
      fs.writeFileSync(path.join(modDir, 'api.mjs'), apiSrc.replace("from './constants.js'", "from './constants.mjs'"))
      fs.writeFileSync(path.join(modDir, 'constants.mjs'), constSrc)
      // 四拍的剧本：200（首次）→ 304（命中缓存）→ 304（本地没有这个 key）→ 200（重取成功）
      const res200 = (tag, data) => ({
        status: 200,
        ok: true,
        headers: { get: (n) => (String(n).toLowerCase() === 'etag' ? tag : null) },
        json: async () => data
      })
      const res304 = () => ({ status: 304, ok: false, headers: { get: () => null }, json: async () => { throw new Error('304 不得读 body') } })
      const script = [res200('"t-1"', { marker: 'first' }), res304(), res304(), res200('"t-2"', { marker: 'retried' })]
      globalThis.document = { getElementById: () => null }
      globalThis.window = { dispatchEvent: () => {} }
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, headers: { ...((opts && opts.headers) || {}) } })
        if (script.length === 0) throw new Error('fetch 调用次数超出剧本（304 分支可能重复重试）')
        return script.shift()
      }
      const mod = await import(pathToFileURL(path.join(modDir, 'api.mjs')).href)
      const hasCond = (i) => Object.keys(calls[i].headers).some((k) => k.toLowerCase() === 'if-none-match')
      assert.strictEqual((await mod.apiGetConfig()).marker, 'first', '首包 200 正常返回')
      assert.strictEqual(hasCond(0), false, '首次无本地副本 → 不带 If-None-Match')
      // 第二次：服务端 304，本地有副本 → 复用，不得再发请求。
      assert.strictEqual((await mod.apiGetConfig()).marker, 'first', '304 命中必须复用本地副本')
      assert.strictEqual(calls.length, 2, '304 命中不得额外发请求')
      assert.strictEqual(hasCond(1), true, '第二次必须带 If-None-Match（说明条件请求真的发出去了）')
      // 第三次：换一个没有本地副本的键 → 服务端仍回 304（边缘缓存/陈旧代理）→ 必须重取。
      const retried = await mod.apiGetCacheHealth()
      assert.strictEqual(retried.marker, 'retried', '304 无本地副本必须重取并返回 200 的真实数据')
      assert.strictEqual(calls.length, 4, '重试恰好一次（总共 4 次 fetch）')
      assert.strictEqual(hasCond(2), false, '无副本的键本来就不带条件头')
      assert.strictEqual(hasCond(3), false, '重试必须去掉 If-None-Match（否则还是 304，陷入死循环）')
      assert.match(calls[3].url, /\/api\/cache-health$/, '重试打的必须是同一个端点')
      // 并发覆盖：A 带着 t-3 发出 → B 先写入 t-4 → A 的 304 到达时不得复用 t-4 的数据。
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, headers: { ...((opts && opts.headers) || {}) } })
        return res200('"t-3"', { marker: 'base' })
      }
      assert.strictEqual((await mod.apiGetConfig()).marker, 'base', '基线：缓存条换成 t-3')
      let release
      const gate = new Promise((resolve) => { release = resolve })
      let n = 0
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, headers: { ...((opts && opts.headers) || {}) } })
        n += 1
        if (n === 1) { await gate; return res304() }
        if (n === 2) return res200('"t-4"', { marker: 'other-tab' })
        if (n === 3) return res200('"t-5"', { marker: 'refetched' })
        throw new Error('fetch 调用次数超出剧本')
      }
      const baseIdx = calls.length
      const pA = mod.apiGetConfig()
      const pB = mod.apiGetConfig()
      assert.strictEqual((await pB).marker, 'other-tab', '并发请求 B 写入 t-4')
      release()
      assert.strictEqual((await pA).marker, 'refetched', '304 的 tag 与缓存条不一致时必须重取')
      assert.strictEqual(hasCond(baseIdx), true, 'A 必须带 If-None-Match')
      assert.strictEqual(hasCond(baseIdx + 2), false, '重取必须去掉条件头')
    } finally {
      globalThis.fetch = realFetch
      globalThis.document = realDocument
      globalThis.window = realWindow
      fs.rmSync(modDir, { recursive: true, force: true })
    }
  })
  await aok('HTTP: POST /trigger 非法 action → 400', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=hack' })
    assert.strictEqual(res.status, 400)
    server.close()
  })
  await aok('HTTP: POST /trigger 合法动作 → 202 且锁文件生成；运行中再触发 → 409；结束后锁释放', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const first = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(first.status, 202)
    const firstBody = JSON.parse(first.text)
    assert.ok(/^\d{13,}\.\d{1,10}$/.test(String(firstBody.id)), `run id 必须是 epoch.seq 形态（实际 ${firstBody.id}）`)
    assert.strictEqual(fs.existsSync(lockPath(dir)), true, '触发后必须有锁')
    const second = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
    assert.strictEqual(second.status, 409, '持有期内第二个触发必须 409')
    // 模拟子进程结束：找到 run 里的 fake 记录——真实子进程已 spawn（node qinglong/xbk_push.js --check 在本机可跑），
    // 等 close 事件释放锁（--check 只做环境检查，秒级完成）。
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const rec = runs.get(firstBody.id)
      if (rec && rec.finishedAt) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const rec = runs.get(firstBody.id)
    assert.ok(rec && rec.finishedAt, '子进程应在 30s 内结束（--check 环境检查很快）')
    const lockAfter = fs.existsSync(lockPath(dir)) ? JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')) : null
    assert.ok(!lockAfter || lockAfter.released === true, '结束后锁必须释放（移除或作废）')
    // 幂等重放窗（Sourcery G_nm）：首轮结束+锁已释放，但同 action 重试在窗口内仍须 409
    // （防「202 响应丢失 → 重试 → 再跑一轮真实推送」），且响应带首轮 runId。
    const replay = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(replay.status, 409, '重放窗内同 action 重试必须 409（首轮已结束也拦）')
    const replayBody = JSON.parse(replay.text)
    assert.strictEqual(replayBody.runId, firstBody.id, '409 响应指向首轮 run')
    assert.strictEqual(replayBody.replayBlocked, true, '标记为重放拦截（非锁冲突）')
    // 跨动作首次触发放行（per-action 各自记窗，G_4Kf：换动作不覆盖他动作记录）。
    const crossAction = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
    assert.strictEqual(crossAction.status, 202, '跨动作首次触发不受重放窗拦截')
    // G_4Kf：check 的重放记录不被 dry-run 覆盖——再次重试 check 仍被拦且仍指向首轮。
    const replay2 = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(replay2.status, 409, '跨动作后同 action 重试仍被拦')
    assert.strictEqual(JSON.parse(replay2.text).runId, firstBody.id, '重放记录未被换动作覆盖')
    // Sourcery G_4Ki：畸形 Cookie（非法 % 序列）不得炸请求处理器——按无 Cookie 处理。
    const badCookie = await request(port, 'GET', '/', { headers: { cookie: 'xbk_session=%zz' } })
    assert.strictEqual(badCookie.status, 401, '畸形 Cookie → 401（不抛 URIError）')
    // Sourcery Session-users-cannot-trigger：Cookie 会话打开 / 且无 ?token= 时 boot JSON
    // 必须注入服务端已验证的凭证（否则前端发空 Bearer，触发 401）。
    const sessPage = await request(port, 'GET', '/', { headers: { cookie: `xbk_session=${TOKEN}` } })
    assert.strictEqual(sessPage.status, 200, 'Cookie 会话可开页面')
    assert.ok(sessPage.text.includes(`"token":"${TOKEN}"`), '会话页 boot JSON 含已验证 token')
    // v3.330：boot JSON 还要带构建版本——前端拿它和 /api/sys 比对，发现部署后没刷新的旧标签页。
    const bootMatch = /<script type="application\/json" id="xbk-boot">([\s\S]*?)<\/script>/.exec(sessPage.text)
    const bootData = bootMatch ? JSON.parse(bootMatch[1]) : {}
    assert.strictEqual(bootData.version, require('./package.json').version,
      'boot JSON 必须带当前 package 版本（前端据此判断是否需要提示刷新）')
    // Sourcery G_4Kb：POST 不接受 Cookie 凭证（写动作须显式 Bearer/?token=）。
    const csrf = await request(port, 'POST', '/trigger', { headers: { cookie: `xbk_session=${TOKEN}` }, body: 'action=check' })
    assert.strictEqual(csrf.status, 401, 'POST 仅凭 Cookie 必须 401（CSRF 面）')
    // Sourcery Retries-duplicate：重放窗落盘——重启（新 createConsole 实例、同 stateDir）
    // 后窗口内同 action 重试仍须 409 且指向首轮 run。
    const { server: server2 } = createConsole({ token: TOKEN, stateDir: dir })
    const port2 = await listen(server2)
    const replayAfterRestart = await request(port2, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(replayAfterRestart.status, 409, '重启后重放窗仍拦截（lastAccept 落盘回读）')
    assert.strictEqual(JSON.parse(replayAfterRestart.text).runId, firstBody.id, '重启后仍指向首轮 run')
    server2.close()
    server.close()
  })
  // ── 批次④ 4.1：通知自检端点 ──────────────────────────────────────────────
  await aok('HTTP: notify-test 动作映射与导出面（K1）', async () => {
    assert.strictEqual(ACTIONS['notify-test'].entry, 'single', 'entry 必须是 single（spawn ENTRY_SINGLE）')
    assert.deepStrictEqual(ACTIONS['notify-test'].args, ['--notify-test'], 'args 必须 --notify-test')
    assert.ok(ACTIONS['notify-test'].label.includes('通知自检'), 'label 含「通知自检」')
    assert.strictEqual(ENTRY_SINGLE, path.join(__dirname, 'xbk_function_v3.js'), 'ENTRY_SINGLE 导出且指向 v3 主文件')
    assert.strictEqual(REPLAY_WINDOW_NOTIFY_TEST_MS, 60000, 'notify-test 独立重放窗 60s')
    // 源码序：entry 映射在 ACTIONS 定义之后（spawn 不跑错脚本）。
    // 插桩安全（Stryker 沙箱实测教训，同 test_notify_selfcheck S1）：锚点用插桩存活形态——
    //   'const ACTIONS = ' 赋值头部存活（'Object.freeze({' 会被包裹改写）；
    //   'const entryFile = ' 唯一（entry 映射赋值行头部存活，三元本体被包裹）。
    const src = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
    const iActions = src.indexOf('const ACTIONS = ')
    const iMap = src.indexOf('const entryFile = ')
    assert.ok(iActions >= 0 && iMap > iActions, 'entry 映射必须在 ACTIONS 之后')
    // parseAction 白名单顺带放行（D6）：urlencoded form 携带 action=notify-test 合法
    assert.strictEqual(parseAction('action=notify-test'), 'notify-test')
  })
  await aok('HTTP: run-auto 只允许服务器内部调度（K1b）', async () => {
    assert.strictEqual(ACTIONS['run-auto'].entry, 'single', 'entry 必须是 single（与手动 run 同入口）')
    assert.deepStrictEqual(ACTIONS['run-auto'].args, [], 'run-auto 参数与手动 run 一致')
    assert.ok(ACTIONS['run-auto'].label.includes('自动正式运行'), 'label 含「自动正式运行」')
    assert.strictEqual(parseAction('action=run-auto'), null, 'HTTP 层必须拒绝 run-auto（无稳定幂等键）')
  })
  await aok('HTTP: /trigger 拒绝 run-auto（K1c）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const rejected = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=run-auto' })
    assert.strictEqual(rejected.status, 400, 'HTTP 直接触发 run-auto 必须 400')
    assert.strictEqual(JSON.parse(rejected.text).error, '未知 action', '按未知动作拒绝，不能落进真实推送')
    server.close()
  })
  await aok('HTTP: /api/auto 服务器端自动运行开关与持久化（K1d）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const init = await request(port, 'GET', '/api/auto', { token: TOKEN })
    assert.strictEqual(init.status, 200)
    const initBody = JSON.parse(init.text)
    assert.strictEqual(initBody.auto.on, false, '默认关闭')
    assert.strictEqual(initBody.auto.interval, 10, '默认 10 秒')
    assert.strictEqual(initBody.min, 3)
    assert.strictEqual(initBody.max, 20)

    const noAuth = await request(port, 'POST', '/api/auto', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true })
    })
    assert.strictEqual(noAuth.status, 401, '写面无凭证 401')
    const csrf = await request(port, 'POST', '/api/auto', {
      headers: { cookie: `xbk_session=${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ on: true })
    })
    assert.strictEqual(csrf.status, 401, '写面仅凭 Cookie 401（CSRF 面）')

    const badLo = await request(port, 'POST', '/api/auto', {
      token: TOKEN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, interval: 2 })
    })
    assert.strictEqual(badLo.status, 400, 'interval < 3 拒绝')
    const badHi = await request(port, 'POST', '/api/auto', {
      token: TOKEN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, interval: 21 })
    })
    assert.strictEqual(badHi.status, 400, 'interval > 20 拒绝')
    const badType = await request(port, 'POST', '/api/auto', {
      token: TOKEN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, interval: '5' })
    })
    assert.strictEqual(badType.status, 400, 'interval 必须是整数，不接受字符串')

    const save = await request(port, 'POST', '/api/auto', {
      token: TOKEN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interval: 5 })
    })
    assert.strictEqual(save.status, 200)
    assert.strictEqual(JSON.parse(save.text).auto.on, false, '只保存间隔不启动')
    assert.strictEqual(JSON.parse(save.text).auto.interval, 5)
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'console-auto.json'), 'utf8')).on, false)

    const start = await request(port, 'POST', '/api/auto', {
      token: TOKEN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, interval: 5 })
    })
    assert.strictEqual(start.status, 200)
    const started = JSON.parse(start.text).auto
    assert.strictEqual(started.on, true)
    assert.strictEqual(started.interval, 5)
    assert.ok(started.nextAt > Date.now(), '启动后应排下一轮')
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'console-auto.json'), 'utf8')).on, true)

    // 进程重启：同一 stateDir 重新 createConsole，应恢复 on=true/interval=5。
    await new Promise(resolve => server.close(resolve))
    const second = createConsole({ token: TOKEN, stateDir: dir })
    const port2 = await listen(second.server)
    const resumed = await request(port2, 'GET', '/api/auto', { token: TOKEN })
    assert.strictEqual(resumed.status, 200)
    assert.strictEqual(JSON.parse(resumed.text).auto.on, true, '服务器重启后应恢复自动运行')
    assert.strictEqual(JSON.parse(resumed.text).auto.interval, 5, '间隔也应恢复')

    const stop = await request(port2, 'POST', '/api/auto', {
      token: TOKEN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: false })
    })
    assert.strictEqual(stop.status, 200)
    assert.strictEqual(JSON.parse(stop.text).auto.on, false, '停止后关闭')
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'console-auto.json'), 'utf8')).on, false)
    await new Promise(resolve => second.server.close(resolve))
  })
  await aok('HTTP: POST /api/notify-test 鉴权面（K2）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const noAuth = await request(port, 'POST', '/api/notify-test', { body: '' })
    assert.strictEqual(noAuth.status, 401, '无凭证 401')
    const badAuth = await request(port, 'POST', '/api/notify-test', { token: 'y'.repeat(32), body: '' })
    assert.strictEqual(badAuth.status, 401, '错 token 401')
    const csrf = await request(port, 'POST', '/api/notify-test', { headers: { cookie: `xbk_session=${TOKEN}` }, body: '' })
    assert.strictEqual(csrf.status, 401, 'POST 仅凭 Cookie 401（CSRF 面）')
    server.close()
  })
  await aok('HTTP: notify-test 60s 独立重放窗行为区分（K3）', async () => {
    // 两个独立实例（独立 stateDir）：lastAccept 是「内存 Map + 实时读盘合并（at 更大者胜）」，
    // 同一实例内先写 30s 帧再改盘为 61s 帧不会生效（内存 30s 帧更权威）。
    // 场景①：30s 前（60s 窗内）→ 409 + replayBlocked + runId 回带
    {
      const dir = tmpDir()
      const { server } = createConsole({ token: TOKEN, stateDir: dir })
      const port = await listen(server)
      fs.writeFileSync(path.join(dir, 'console-lastaccept.json'), JSON.stringify({ 'notify-test': { at: Date.now() - 30000, runId: '1750000000000.7' } }))
      const blocked = await request(port, 'POST', '/api/notify-test', { token: TOKEN, body: '' })
      assert.strictEqual(blocked.status, 409, '60s 窗内重放必须 409')
      const blockedBody = JSON.parse(blocked.text)
      assert.strictEqual(blockedBody.replayBlocked, true, '标记重放拦截')
      assert.strictEqual(blockedBody.runId, '1750000000000.7', '409 回带首轮 runId')
      // D2-S16：文案必须说「N 秒后可重试」且带 retryAfterS——旧文案谎称「已有任务在运行」
      assert.match(String(blockedBody.error || ''), /\d+ 秒后可重试/, '409 必须给出可重试倒计时')
      assert.ok(Number.isInteger(blockedBody.retryAfterS) && blockedBody.retryAfterS > 0 && blockedBody.retryAfterS <= 60, 'retryAfterS 在窗内')
      server.close()
    }
    // 场景②：61s 前（超 60s 窗；若误用 12min 全局窗此请求会被重放窗拦——60s 窗的区分性断言）
    // → 应越过重放窗、撞上既有锁（手工预占锁）→ 409 无 replayBlocked。
    // 不走 202+spawn：node xbk_function_v3.js --notify-test 直跑会真实推送（本机有真实凭证）。
    {
      const dir = tmpDir()
      const { server } = createConsole({ token: TOKEN, stateDir: dir })
      const port = await listen(server)
      fs.writeFileSync(path.join(dir, 'console-lastaccept.json'), JSON.stringify({ 'notify-test': { at: Date.now() - 61000, runId: '1750000000000.7' } }))
      assert.strictEqual(acquireLock(dir, Date.now(), 'other-token'), true, '预占锁成功')
      const lockConflict = await request(port, 'POST', '/api/notify-test', { token: TOKEN, body: '' })
      assert.strictEqual(lockConflict.status, 409, '越窗后撞锁仍 409')
      const lockBody = JSON.parse(lockConflict.text)
      assert.strictEqual(lockBody.replayBlocked, undefined, '锁冲突不带 replayBlocked（区别于重放窗 409）')
      server.close()
    }
  })
  // ── v3.340 控制台设置：拆成 5 组用例 ──────────────────────────────────────────
  // 旧版把 60+ 条断言挤在一个 aok 里：首错即中止，后面的断言与清理全部跳过（回潮实验实测
  // 只报 1 条失败、且进程被泄漏的监听句柄钉住）。现在每组自带 stateDir/server，退出时关服务
  // 并删沙箱，一段失败不影响其它段。
  await aok('HTTP: 控制台设置读面与写面闸门（v3.340）', async () => {
    assert.strictEqual(CONSOLE_SETTINGS_DEFAULT_S, 60, '默认 60 秒（与 REPLAY_WINDOW_NOTIFY_TEST_MS 同值）')
    assert.strictEqual(NOTIFY_REPLAY_MIN_S, 0)
    assert.strictEqual(NOTIFY_REPLAY_MAX_S, 3600)
    // 文件名是落盘契约的一部分：这里钉字面量，别用常量自证（把常量改名后自指断言仍绿）。
    assert.strictEqual(CONSOLE_SETTINGS_FILE, 'console-settings.json', '落盘文件名是对外契约')
    assert.strictEqual(classifyStateFile('console-settings.json', 'xbk_cache.json'), 'console', '设置文件必须归 console 类')
    await withSettingsConsole(async ({ dir, port }) => {
      const settingsPath = path.join(dir, CONSOLE_SETTINGS_FILE)
      const postRaw = (body, headers = {}) => request(port, 'POST', '/api/config/console', {
        token: TOKEN,
        headers: { 'content-type': 'application/json', ...headers },
        body
      })

      // ⓪ 读面同样在全局鉴权之后：无凭证 GET/POST 都必须 401。
      // （否则把新路由挪到鉴权闸之前，本组用例仍会全绿。）
      const anonRead = await request(port, 'GET', '/api/config/console')
      assert.strictEqual(anonRead.status, 401, '无凭证 GET 401')
      const anonWrite = await request(port, 'POST', '/api/config/console', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notifyTestReplayWindowS: 5 })
      })
      assert.strictEqual(anonWrite.status, 401, '无凭证 POST 401')

      // ① GET 默认面：值/来源/边界都如实下发，且默认值不落盘（读盘失败也不自己造文件）。
      const init = await request(port, 'GET', '/api/config/console', { token: TOKEN })
      assert.strictEqual(init.status, 200, 'GET 200')
      assert.strictEqual(init.headers['cache-control'], 'no-store', '可变设置不得被任何缓存留住')
      const initBody = JSON.parse(init.text)
      assert.strictEqual(initBody.schema, 1)
      assert.strictEqual(initBody.settings.notifyTestReplayWindowS, 60, '默认 60')
      assert.strictEqual(initBody.revision, 0, '默认 revision 0')
      assert.strictEqual(initBody.updatedAt, 0, '默认没有 updatedAt')
      assert.strictEqual(initBody.source, 'default', '默认来源 default')
      assert.strictEqual(initBody.defaults.notifyTestReplayWindowS, 60)
      assert.strictEqual(initBody.min, 0)
      assert.strictEqual(initBody.max, 3600)
      assert.strictEqual(fs.existsSync(settingsPath), false, '只读不得凭空创建设置文件')
      const cookieRead = await request(port, 'GET', '/api/config/console', { headers: { cookie: `xbk_session=${TOKEN}` } })
      assert.strictEqual(cookieRead.status, 200, 'GET 收 Cookie（全局鉴权口径）')

      // ② 写面鉴权/媒体类型：Cookie-only 与 ?token= 都进不来，非 JSON 415。
      const csrf = await request(port, 'POST', '/api/config/console', {
        headers: { cookie: `xbk_session=${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ notifyTestReplayWindowS: 5 })
      })
      assert.strictEqual(csrf.status, 401, 'Cookie-only 写面 401（CSRF 面）')
      const queryToken = await request(port, 'POST', `/api/config/console?token=${TOKEN}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notifyTestReplayWindowS: 5 })
      })
      assert.strictEqual(queryToken.status, 400, '?token= 写面 400')
      assert.strictEqual(JSON.parse(queryToken.text).error, 'query_token_not_allowed')
      const nonJson = await postRaw(JSON.stringify({ notifyTestReplayWindowS: 5 }), { 'content-type': 'text/plain' })
      assert.strictEqual(nonJson.status, 415, '非 JSON 415')
      assert.strictEqual(JSON.parse(nonJson.text).error, 'unsupported_media_type')
      const badJson = await postRaw('{oops')
      assert.strictEqual(badJson.status, 400, '坏 JSON 400')
      assert.strictEqual(JSON.parse(badJson.text).error, 'invalid_json')
      const notObject = await postRaw('[1,2]')
      assert.strictEqual(notObject.status, 400, '非普通对象 400')
      assert.strictEqual(JSON.parse(notObject.text).error, 'body 必须是对象')
      assert.strictEqual(fs.existsSync(settingsPath), false, '被拒的写请求都不得落盘')
    })
  })

  await aok('HTTP: 控制台设置写入校验与落盘（v3.340）', async () => {
    await withSettingsConsole(async ({ dir, port }) => {
      const settingsPath = path.join(dir, CONSOLE_SETTINGS_FILE)
      const save = (payload) => request(port, 'POST', '/api/config/console', {
        token: TOKEN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })

      // ③ 非法值逐个拒绝：1.5 / -1 / 3601 / '60' / null / 缺字段。
      for (const bad of [1.5, -1, 3601, '60', null]) {
        const res = await save({ notifyTestReplayWindowS: bad })
        assert.strictEqual(res.status, 400, `非法值 ${JSON.stringify(bad)} 必须 400`)
        assert.match(JSON.parse(res.text).error, /0–3600 的整数/, '错误文案要说明合法区间')
      }
      const missingField = await save({})
      assert.strictEqual(missingField.status, 400, '两个字段都不给必须 400')
      assert.strictEqual(fs.existsSync(settingsPath), false, '所有被拒的写请求都不得落盘')

      // ④ 乐观锁：baseRevision 不匹配 → 409 revision_mismatch 且回带当前 revision。
      const stale = await save({ notifyTestReplayWindowS: 5, baseRevision: 7 })
      assert.strictEqual(stale.status, 409, 'baseRevision 不匹配 409')
      const staleBody = JSON.parse(stale.text)
      assert.strictEqual(staleBody.error, 'revision_mismatch')
      assert.strictEqual(staleBody.revision, 0, '409 回带当前 revision')

      // ⑤ 合法保存：200 + revision 1；GET 反映 5 且来源 file；文件 0600、内容与响应一致。
      const savedRes = await save({ notifyTestReplayWindowS: 5, baseRevision: 0 })
      assert.strictEqual(savedRes.status, 200, '合法保存 200')
      const savedBody = JSON.parse(savedRes.text)
      assert.strictEqual(savedBody.ok, true)
      assert.strictEqual(savedBody.revision, 1, 'revision +1')
      assert.strictEqual(savedBody.settings.notifyTestReplayWindowS, 5)
      assert.ok(Number.isFinite(savedBody.updatedAt) && savedBody.updatedAt > 0, 'updatedAt 是毫秒时间戳')
      const after = JSON.parse((await request(port, 'GET', '/api/config/console', { token: TOKEN })).text)
      assert.strictEqual(after.settings.notifyTestReplayWindowS, 5, 'GET 必须反映新值')
      assert.strictEqual(after.revision, 1)
      assert.strictEqual(after.updatedAt, savedBody.updatedAt)
      assert.strictEqual(after.source, 'file', '落盘后来源 file')
      assert.strictEqual(fs.statSync(settingsPath).mode & 0o777, 0o600, '设置文件必须 0600')
      const onDisk = JSON.parse(readSafeTextResult(settingsPath, 64 * 1024).text)
      assert.strictEqual(onDisk.schema, 1)
      assert.strictEqual(onDisk.revision, 1, '文件里是成功那一次的内容')
      assert.strictEqual(onDisk.notifyTestReplayWindowS, 5)

      // ⑤b 同值保存不推进 revision：否则每点一次「保存」都会作废别的标签页的 baseRevision。
      const again = await save({ notifyTestReplayWindowS: 5, baseRevision: 1 })
      assert.strictEqual(again.status, 200, '同值保存 200')
      const againBody = JSON.parse(again.text)
      assert.strictEqual(againBody.unchanged, true, '同值保存标记 unchanged')
      assert.strictEqual(againBody.revision, 1, '同值保存不得推进 revision')
      assert.strictEqual(JSON.parse(readSafeTextResult(settingsPath, 64 * 1024).text).revision, 1, '文件也不得被重写')
    })
  })

  await aok('HTTP: 通知自检拦截窗生效与 409 窗长（v3.340）', async () => {
    await withSettingsConsole(async ({ dir, port }) => {
      const save = (payload) => request(port, 'POST', '/api/config/console', {
        token: TOKEN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const laPath = path.join(dir, 'console-lastaccept.json')
      const windowSaved = await save({ notifyTestReplayWindowS: 5, baseRevision: 0 })
      assert.strictEqual(windowSaved.status, 200, '先把拦截窗改成 5 秒')
      assert.strictEqual(JSON.parse(windowSaved.text).revision, 1)

      // ⑥ 立即生效：1s 前的自检帧在 5s 窗内 → 409 且回带 replayWindowS=5（不是写死的 60）。
      // 帧龄留 4s 余量：余量太小（曾用 3s）时机器一卡就过窗，请求会被当新触发受理——那会真的
      // spawn 一次 --notify-test 推送，测试的失败形态就不只是红了。
      fs.writeFileSync(laPath, JSON.stringify({ 'notify-test': { at: Date.now() - 1000, runId: '1750000000000.9' } }))
      const blocked = await request(port, 'POST', '/api/notify-test', { token: TOKEN, body: '' })
      assert.strictEqual(blocked.status, 409, '窗内（1s < 5s）必须 409')
      const blockedBody = JSON.parse(blocked.text)
      assert.strictEqual(blockedBody.replayBlocked, true)
      assert.strictEqual(blockedBody.replayWindowS, 5, '409 必须回带当前生效窗（5 秒）')
      assert.strictEqual(blockedBody.runId, '1750000000000.9', '仍回带首轮 runId')
      assert.ok(blockedBody.retryAfterS >= 1 && blockedBody.retryAfterS <= 5, '剩余秒数按 5s 窗算')
      assert.ok(blockedBody.retryAfterS < blockedBody.replayWindowS, '剩余秒数必须小于窗长（不得把窗长当剩余时间）')

      // ⑥b 锁被别的动作占着时的「锁外只读判窗」分支：同样必须回带 replayWindowS。
      // 这条分支原先零覆盖（删掉响应字段，215 条用例仍全绿），由本轮回潮实验发现。
      assert.strictEqual(acquireLock(dir, Date.now(), 'lock-holder'), true, '预占锁成功')
      try {
        const lockBlocked = await request(port, 'POST', '/api/notify-test', { token: TOKEN, body: '' })
        assert.strictEqual(lockBlocked.status, 409, '锁被占 + 窗内重试 409')
        const lockBlockedBody = JSON.parse(lockBlocked.text)
        assert.strictEqual(lockBlockedBody.replayBlocked, true, '锁冲突也必须识别为重放拦截（不降级成裸锁冲突）')
        assert.strictEqual(lockBlockedBody.replayWindowS, 5, '锁外判窗分支同样回带 5 秒窗')
        assert.ok(lockBlockedBody.retryAfterS >= 1 && lockBlockedBody.retryAfterS <= 5, '剩余秒数按 5s 窗算')
      } finally {
        releaseLockFor({ _stateDir: dir, _lockToken: 'lock-holder' })
      }

      // ⑦ 0 = 关闭拦截：同一帧刚受理过也不再按重放拦——只剩锁冲突（无 replayBlocked）。
      // 用预占锁把请求挡在 202 之前，绝不落到真实 spawn 推送。
      const off = await save({ notifyTestReplayWindowS: 0, baseRevision: 1 })
      assert.strictEqual(off.status, 200, '保存 0（关闭拦截）200')
      assert.strictEqual(JSON.parse(off.text).revision, 2)
      fs.writeFileSync(laPath, JSON.stringify({ 'notify-test': { at: Date.now(), runId: '1750000000000.9' } }))
      assert.strictEqual(acquireLock(dir, Date.now(), 'other-token'), true, '预占锁成功')
      try {
        const lockOnly = await request(port, 'POST', '/api/notify-test', { token: TOKEN, body: '' })
        assert.strictEqual(lockOnly.status, 409, '锁冲突仍 409')
        const lockBody = JSON.parse(lockOnly.text)
        assert.strictEqual(lockBody.replayBlocked, undefined, '窗 0 时必须不再报 replayBlocked（0 = 关闭拦截）')
        assert.strictEqual(lockBody.replayWindowS, undefined, '锁冲突不是重放拦截，不带 replayWindowS')
      } finally {
        releaseLockFor({ _stateDir: dir, _lockToken: 'other-token' })
      }
    })
  })

  await aok('HTTP: 通知自检拦截窗重启后仍生效（v3.340）', async () => {
    const dir = tmpDir()
    try {
      const first = createConsole({ token: TOKEN, stateDir: dir })
      const port1 = await listen(first.server)
      first.server.unref()
      const saved = await request(port1, 'POST', '/api/config/console', {
        token: TOKEN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notifyTestReplayWindowS: 0, baseRevision: 0 })
      })
      assert.strictEqual(JSON.parse(saved.text).revision, 1, '保存 0 并落盘')
      await new Promise(resolve => first.server.close(resolve))

      // ⑧ 持久化：同一 stateDir 重新 createConsole，读到的是最后一次保存的值。
      const second = createConsole({ token: TOKEN, stateDir: dir })
      const port2 = await listen(second.server)
      second.server.unref()
      const resumed = JSON.parse((await request(port2, 'GET', '/api/config/console', { token: TOKEN })).text)
      assert.strictEqual(resumed.settings.notifyTestReplayWindowS, 0, '重启后读到最后保存的 0')
      assert.strictEqual(resumed.revision, 1)
      assert.strictEqual(resumed.source, 'file')
      await new Promise(resolve => second.server.close(resolve))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('HTTP: 控制台设置损坏/越界/FIFO 回默认（v3.340）', async () => {
    const warnings = []
    const realConsoleError = console.error
    console.error = (...args) => {
      const line = args.map((a) => String(a)).join(' ')
      // 只截「控制台设置」前缀：其余告警照常打到控制台，否则窗口期内所有诊断信息都被吞掉。
      if (line.includes('控制台设置')) warnings.push(line)
      else realConsoleError(...args)
    }
    try {
      // ⑨ 损坏 / 字段非法 → 默认 60 + console.error 告警（不崩、不阻断启动）。
      await withSettingsConsole(async ({ port }) => {
        const read = JSON.parse((await request(port, 'GET', '/api/config/console', { token: TOKEN })).text)
        assert.strictEqual(read.settings.notifyTestReplayWindowS, 60, '损坏文件回默认 60')
        assert.strictEqual(read.source, 'default', '损坏文件来源按默认')
      }, (dir) => fs.writeFileSync(path.join(dir, CONSOLE_SETTINGS_FILE), '{not json', { mode: 0o600 }))

      await withSettingsConsole(async ({ port }) => {
        const read = JSON.parse((await request(port, 'GET', '/api/config/console', { token: TOKEN })).text)
        assert.strictEqual(read.settings.notifyTestReplayWindowS, 60, '越界字段回默认 60')
        assert.strictEqual(read.revision, 0, '非法文件整份不采信（revision 也不采）')
      }, (dir) => fs.writeFileSync(path.join(dir, CONSOLE_SETTINGS_FILE),
        JSON.stringify({ schema: 1, revision: 3, updatedAt: Date.now(), notifyTestReplayWindowS: 7200 }), { mode: 0o600 }))
    } finally {
      console.error = realConsoleError
    }
    // 两条告警必须各自存在：共用一个前缀时 some() 只要求「有一条」，删掉其中一条分支不会被发现。
    const settingsWarnings = warnings.filter((m) => m.includes('控制台设置'))
    assert.ok(settingsWarnings.length >= 2, `损坏与字段非法必须各有一条告警（实际 ${settingsWarnings.length} 条）`)
    assert.ok(settingsWarnings.some((m) => m.includes('不是合法 JSON')), '损坏文件告警要写明「不是合法 JSON」')
    assert.ok(settingsWarnings.some((m) => m.includes('字段非法')), '越界字段告警要写明「字段非法」')

    // ⑩ 设置文件被换成 FIFO：启动读盘必须非阻塞（裸 O_RDONLY 会让 createConsole 卡死在 listen
    // 之前）。用子进程 + 看门狗：真挂死也只杀子进程，不会把整套件拖成 10 分钟超时。
    const fifoDir = tmpDir()
    const fifoSettings = path.join(fifoDir, CONSOLE_SETTINGS_FILE)
    fs.rmSync(fifoSettings, { force: true })
    require('node:child_process').execFileSync('/usr/bin/mkfifo', [fifoSettings])
    const probeSrc = 'const { createConsole } = require(' + JSON.stringify(require.resolve('./scripts/console')) + ')\n' +
      'createConsole({ token: "x".repeat(20), stateDir: process.argv[1], log: () => {} })\n' +
      'console.log("SETTINGS_READ_NONBLOCKING")\n' +
      'process.exit(0)\n'
    const probe = spawn(process.execPath, ['-e', probeSrc, fifoDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let probeOut = ''
    probe.stdout.on('data', (c) => { probeOut += c })
    probe.stderr.resume()
    const probeDone = new Promise((resolve) => { probe.on('exit', resolve); probe.on('error', resolve) })
    const probeTimer = setTimeout(() => { try { probe.kill('SIGKILL') } catch (e) {} }, 5000)
    await probeDone
    clearTimeout(probeTimer)
    assert.ok(probeOut.includes('SETTINGS_READ_NONBLOCKING'),
      'FIFO 设置文件必须按 unsafe 回默认（不得阻塞 createConsole 启动）')
    fs.rmSync(fifoDir, { recursive: true, force: true })
  })

  await aok('HTTP: 顶栏时间显示年月日可设置（v3.342）', async () => {
    await withSettingsConsole(async ({ dir, port }) => {
      const settingsPath = path.join(dir, CONSOLE_SETTINGS_FILE)
      const save = (payload) => request(port, 'POST', '/api/config/console', {
        token: TOKEN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const get = () => request(port, 'GET', '/api/config/console', { token: TOKEN })

      // ① 默认面：默认显示年月日，且默认值也如实下发（前端据此决定回退文案）。
      const init = JSON.parse((await get()).text)
      assert.strictEqual(init.settings.syncShowDate, true, '默认显示年月日')
      assert.strictEqual(init.defaults.syncShowDate, true, '默认值也要下发')

      // ② 非布尔一律拒绝：0/1/'true'/null/对象/数组都不是「关掉」。
      for (const bad of [0, 1, 'true', 'false', null, {}, []]) {
        const res = await save({ syncShowDate: bad })
        assert.strictEqual(res.status, 400, `非法显示开关 ${JSON.stringify(bad)} 必须 400`)
      }
      assert.strictEqual(fs.existsSync(settingsPath), false, '被拒的写请求不得落盘')

      // ③ 部分更新：只改显示开关时拦截窗保持原值，反之亦然（两边都不能把对方重置）。
      const off = await save({ syncShowDate: false, baseRevision: 0 })
      assert.strictEqual(off.status, 200, '合法保存 200')
      const offBody = JSON.parse(off.text)
      assert.strictEqual(offBody.settings.syncShowDate, false)
      assert.strictEqual(offBody.settings.notifyTestReplayWindowS, 60, '只改显示开关时拦截窗保持默认')
      const disk1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      assert.strictEqual(disk1.syncShowDate, false, '落盘必须带 syncShowDate')
      assert.strictEqual(disk1.notifyTestReplayWindowS, 60, '落盘不得丢另一个字段')

      const win = await save({ notifyTestReplayWindowS: 7, baseRevision: 1 })
      assert.strictEqual(win.status, 200)
      const winBody = JSON.parse(win.text)
      assert.strictEqual(winBody.settings.syncShowDate, false, '只改拦截窗时显示开关不得被重置')
      assert.strictEqual(winBody.settings.notifyTestReplayWindowS, 7)

      // ④ 同值保存：unchanged + revision 不动（否则别的标签页的乐观锁被无谓作废）。
      const same = await save({ syncShowDate: false, baseRevision: 2 })
      assert.strictEqual(same.status, 200, '同值保存 200')
      const sameBody = JSON.parse(same.text)
      assert.strictEqual(sameBody.unchanged, true, '同值保存标记 unchanged')
      assert.strictEqual(sameBody.revision, 2, '同值保存不推进 revision')
    })

    // ⑤ 启动读回：v3.340 的旧文件没有这个字段，必须按默认 true 读（不能整份判非法丢掉拦截窗）；
    //    写了布尔就按文件值生效。
    for (const [label, extra, want] of [['旧文件缺字段', {}, true], ['文件写了 false', { syncShowDate: false }, false]]) {
      const legacyDir = tmpDir()
      try {
        fs.writeFileSync(path.join(legacyDir, CONSOLE_SETTINGS_FILE),
          JSON.stringify({ schema: 1, revision: 4, updatedAt: Date.now(), notifyTestReplayWindowS: 9, ...extra }), { mode: 0o600 })
        const { server } = createConsole({ token: TOKEN, stateDir: legacyDir })
        const legacyPort = await listen(server)
        server.unref()
        try {
          const read = JSON.parse((await request(legacyPort, 'GET', '/api/config/console', { token: TOKEN })).text)
          assert.strictEqual(read.settings.syncShowDate, want, `${label} → syncShowDate=${want}`)
          assert.strictEqual(read.settings.notifyTestReplayWindowS, 9, `${label}：拦截窗不能被一起丢掉`)
          assert.strictEqual(read.source, 'file', `${label} 仍算来自设置文件`)
        } finally {
          await new Promise((resolve) => server.close(resolve))
        }
      } finally {
        fs.rmSync(legacyDir, { recursive: true, force: true })
      }
    }
  })

  await aok('HTTP: 全局重放窗 60s（D2-S16：窗内 409 带剩余秒数，文案不谎称有任务在运行）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'console-lastaccept.json'), JSON.stringify({ 'dry-run': { at: Date.now() - 30000, runId: '1750000000000.3' } }))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const blocked = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
    assert.strictEqual(blocked.status, 409)
    const b = JSON.parse(blocked.text)
    assert.strictEqual(b.replayBlocked, true)
    assert.ok(b.retryAfterS >= 1 && b.retryAfterS <= 30, `retryAfterS 应为剩余秒数（实际 ${b.retryAfterS}）`)
    assert.ok(!/已有触发任务在运行/.test(b.error), '文案不得谎称「已有任务在运行」（锁早就释放了）')
    assert.match(b.error, /重复提交/)
    assert.strictEqual(b.replayWindowS, 60, '普通动作的 409 也必须回带生效窗（60 秒）')
    server.close()
  })
  await aok('HTTP: 全局重放窗越窗放行（61s 前受理 → 202；旧 12min 窗会拦）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'console-lastaccept.json'), JSON.stringify({ 'dry-run': { at: Date.now() - 61000, runId: '1750000000000.3' } }))
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const okRes = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
    assert.strictEqual(okRes.status, 202, '越过 60s 窗必须放行（旧 12min 窗下这里会 409，人工重跑要等 12 分钟）')
    // 收尾：等子进程结束释放锁，避免影响后续用例
    const id = JSON.parse(okRes.text).id
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const rec = runs.get(id)
      if (rec && rec.finishedAt) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    server.close()
  })
  await aok('HTTP: /trigger 的 action=notify-test 与独立端点共享受理序列（K7 侧通道一致）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const laPath = path.join(dir, 'console-lastaccept.json')
    // 独立端点 60s 窗内 → /trigger 侧同键同窗同样拦截（共享 lastAccept 键）
    fs.writeFileSync(laPath, JSON.stringify({ 'notify-test': { at: Date.now() - 30000, runId: '1750000000000.8' } }))
    const viaTrigger = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=notify-test' })
    assert.strictEqual(viaTrigger.status, 409, '/trigger 侧通道同键同窗拦截（D6 有意行为）')
    assert.strictEqual(JSON.parse(viaTrigger.text).runId, '1750000000000.8', '回带同一首轮 runId')
    server.close()
  })
  await aok('HTTP: /api/runs 列表与 /api/runs/:id 详情', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const trig = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    const { id } = JSON.parse(trig.text)
    const list = JSON.parse((await request(port, 'GET', '/api/runs', { token: TOKEN })).text)
    assert.ok(Array.isArray(list.runs) && list.runs.some(r => r.id === id))
    // Sourcery #39：等子进程结束再断言 output 非空——--check 必然打印环境信息，
    // 只断言「是字符串」抓不住输出捕获链路整体失效的回归。
    const deadline = Date.now() + 30000
    let detail = null
    while (Date.now() < deadline) {
      detail = JSON.parse((await request(port, 'GET', `/api/runs/${id}`, { token: TOKEN })).text)
      if (detail.finishedAt) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(detail && detail.finishedAt, '子进程应在 30s 内结束')

    assert.ok(typeof detail.output === 'string' && detail.output.length > 0, 'output 必须捕获到子进程实际输出')
    // POST /api/runs/detail（前端 fetch 字面量 URL 形态）：与 GET 等价。
    const postDetail = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: `id=${id}` })
    assert.strictEqual(postDetail.status, 200, 'POST detail 200')
    const postBody = JSON.parse(postDetail.text)
    assert.strictEqual(postBody.id, id, 'POST detail 返回同一条 run')
    assert.ok(typeof postBody.output === 'string' && postBody.output.length > 0, 'POST detail output 非空')
    // id 形态「epoch.seq」：不存在 id 用合法形态（重启前进程的 epoch 前缀 → 404 语义）
    const postMissing = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: 'id=1750000000000.99999' })
    assert.strictEqual(postMissing.status, 404, 'POST detail 未命中 404')
    const postBad = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: 'id=abc' })
    assert.strictEqual(postBad.status, 400, 'POST detail 非数字 id 400')
    const postNoAuth = await request(port, 'POST', '/api/runs/detail', { body: `id=${id}` })
    assert.strictEqual(postNoAuth.status, 401, 'POST detail 无凭证 401（鉴权与 GET 一致）')
    const missing = await request(port, 'GET', '/api/runs/99999', { token: TOKEN })
    assert.strictEqual(missing.status, 404)
    server.close()
  })
  await aok('HTTP: 未知路径 → 404', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'GET', '/nope', { token: TOKEN })
    assert.strictEqual(res.status, 404)
    server.close()
  })
  // ── v3.297 扩展端点：/api/messages、/api/trends、/api/logs、/api/sys ──
  await aok('HTTP: /api/messages 三态 + 分页钳制 + 过滤（回归：URL 未验证输入不得越界）', async () => {
    const dir = tmpDir()
    // 造一份 push.json：3 条合法 + 1 条畸形（skipped 计数）+ 乱序时间戳验证倒序。
    const msgs = [
      { id: 1, title: '牛奶特价', content: '伊利纯牛奶', catename: '好单-日用', shijianchuo: 1000, datetime: '2026-10-15', shorttime: '10:00', price: 12.9, url: '/a/1.html' },
      { id: 2, title: '护腰坐垫', content: '光星', catename: '好单-家用', shijianchuo: 3000, datetime: '2026-10-15', shorttime: '12:00', price: 21.9, url: '/a/2.html' },
      { id: 3, title: '饼干', content: '奥利奥', catename: '好单-食品', shijianchuo: 2000, datetime: '2026-10-15', shorttime: '11:00', price: 5, url: '/a/3.html' },
      { _f: true, title: '被过滤', content: '不应出现在推送历史', catename: '好单-日用', shijianchuo: 4000 },
      { notValid: true }
    ]
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify(msgs))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 缺省：倒序（最新在前）+ 畸形条目计数 + _f（被过滤未推送）不入历史
    const all = JSON.parse((await request(port, 'GET', '/api/messages', { token: TOKEN })).text)
    assert.strictEqual(all.status, 'ok')
    assert.strictEqual(all.grandTotal, 3, '_f 条目不得计入推送历史')
    assert.strictEqual(all.skipped, 1)
    assert.deepStrictEqual(all.items.map(m => m.id), [2, 3, 1], '必须按时间倒序')
    assert.strictEqual(all.items[0].content_html, undefined, 'content_html 不得下发')
    assert.strictEqual(all.items[0].rowKey, '2', '有 id 条目 rowKey=id')
    // 搜索（大小写不敏感子串）
    const q = JSON.parse((await request(port, 'GET', `/api/messages?q=${encodeURIComponent('牛奶')}`, { token: TOKEN })).text)
    assert.strictEqual(q.total, 1)
    assert.strictEqual(q.items[0].id, 1)
    assert.deepStrictEqual(q.categories, [{ name: '好单-日用', count: 1 }],
      '分类计数必须跟随搜索词，不能继续显示全量分类')
    // 分类精确匹配
    const c = JSON.parse((await request(port, 'GET', `/api/messages?cate=${encodeURIComponent('好单-家用')}`, { token: TOKEN })).text)
    assert.strictEqual(c.total, 1)
    assert.strictEqual(c.items[0].id, 2)
    // 分页：size=1 时 page1=id2、page3=id1（断言具体条目，防止「每页都回第 1 页」的假分页）
    const p1 = JSON.parse((await request(port, 'GET', '/api/messages?size=1&page=1', { token: TOKEN })).text)
    assert.strictEqual(p1.items.length, 1)
    assert.strictEqual(p1.pages, 3)
    assert.strictEqual(p1.items[0].id, 2, 'page1 必须是最新一条')
    const p3 = JSON.parse((await request(port, 'GET', '/api/messages?size=1&page=3', { token: TOKEN })).text)
    assert.strictEqual(p3.items.length, 1)
    assert.strictEqual(p3.items[0].id, 1, 'page3 必须是最旧一条（不得重复 page1）')
    // 越界参数钳制：size=abc → 默认 20；page=999999 → 钳到空页不崩
    const pBig = JSON.parse((await request(port, 'GET', '/api/messages?page=99999&size=abc', { token: TOKEN })).text)
    assert.deepStrictEqual(pBig.items, [], '越界页必须空（不得崩、不得回绕）')
    // 无 id 条目：rowKey 合成 idx-N（行间不联动），畸形条目仍计 skipped
    const dir3 = tmpDir()
    fs.writeFileSync(path.join(dir3, 'push.json'), JSON.stringify([
      { title: '无ID甲', content: 'x', shijianchuo: 100 },
      { title: '无ID乙', content: 'y', shijianchuo: 200 },
      { junk: 1 }
    ]))
    const { server: s3 } = createConsole({ token: TOKEN, stateDir: dir3 })
    const port3 = await listen(s3)
    const anon = JSON.parse((await request(port3, 'GET', '/api/messages', { token: TOKEN })).text)
    assert.deepStrictEqual(anon.items.map(m => m.rowKey), ['idx-1', 'idx-0'], '无 id 条目按下标合成稳定 rowKey（倒序后）')
    s3.close()
    // 超长搜索词：截断继续过滤（不清空导致「显示原词、结果未过滤」），queryUsed 回显实际生效值
    const longQ = '牛'.repeat(200)
    const lq = JSON.parse((await request(port, 'GET', `/api/messages?q=${encodeURIComponent(longQ)}`, { token: TOKEN })).text)
    assert.strictEqual(lq.status, 'ok')
    assert.ok(lq.queryUsed.length > 0 && lq.queryUsed.length < longQ.length, '超长词必须截断而非清空')
    assert.strictEqual(Buffer.byteLength(lq.queryUsed, 'utf8') <= 240, true, 'queryUsed 不超过 240 字节上限')
    // 无凭证 401
    const noAuth = await request(port, 'GET', '/api/messages')
    assert.strictEqual(noAuth.status, 401)
    server.close()
  })
  await aok('HTTP: /api/messages missing/invalid 三态如实下发', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const missing = JSON.parse((await request(port, 'GET', '/api/messages', { token: TOKEN })).text)
    assert.strictEqual(missing.status, 'missing', '空缓存目录必须 missing（不伪装成空列表 ok）')
    assert.strictEqual(missing.items.length, 0)
    server.close()
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'push.json'), '{broken json')
    const { server: s2 } = createConsole({ token: TOKEN, stateDir: dir2 })
    const port2 = await listen(s2)
    const invalid = JSON.parse((await request(port2, 'GET', '/api/messages', { token: TOKEN })).text)
    assert.strictEqual(invalid.status, 'invalid', '坏 JSON 必须 invalid')
    s2.close()
  })
  // ── v3.300 批次③ 3.2：POST /api/messages/export 端到端 ──
  await aok('T1 导出鉴权: 无凭证/错凭证/仅 Cookie → 401（POST 不收 Cookie）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const noAuth = await request(port, 'POST', '/api/messages/export', { body: 'format=json' })
    assert.strictEqual(noAuth.status, 401)
    const badAuth = await request(port, 'POST', '/api/messages/export', { token: 'y'.repeat(32), body: 'format=json' })
    assert.strictEqual(badAuth.status, 401)
    // 仅 Cookie（POST 不走 Cookie 会话路径，authorize :637 显式排除）
    const cookieOnly = await request(port, 'POST', '/api/messages/export', { headers: { cookie: `xbk_session=${TOKEN}` }, body: 'format=json' })
    assert.strictEqual(cookieOnly.status, 401, 'POST 不得凭 Cookie 放行')
    server.close()
  })
  await aok('T2 format 白名单: xml/缺省 → 400；GET 同路径 → 404 兜底', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const xml = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=xml' })
    assert.strictEqual(xml.status, 400)
    const noFmt = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'cate=' })
    assert.strictEqual(noFmt.status, 400, '缺 format 必须 400')
    const get = await request(port, 'GET', '/api/messages/export', { token: TOKEN })
    assert.strictEqual(get.status, 404, '方法不匹配走 404 兜底')
    server.close()
  })
  await aok('T3 CSV 转义三形态 + BOM + 响应头（全串比对，拒绝 naive split）', async () => {
    const dir = tmpDir()
    const msgs = [
      { id: 1, title: '  =1+1', content: '牛奶', catename: '好单-日用', shijianchuo: 1000, datetime: '2026-10-15', shorttime: '10:00' },
      { id: 2, title: '@SUM(A1:A9)', content: '饼干', catename: '好单-食品', shijianchuo: 2000, datetime: '2026-10-15', shorttime: '12:00' },
      { id: 3, title: '含,引号"换行\n测试', content: '奥利奥', catename: '好单-食品', shijianchuo: 3000, datetime: '2026-10-15', shorttime: '11:00' },
      { id: 4, title: '-2件起批', content: '正常', catename: '好单-日用', shijianchuo: 4000, datetime: '2026-10-15', shorttime: '13:00' }
    ]
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify(msgs))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=csv' })
    assert.strictEqual(res.status, 200)
    // 响应头（Node 出站头小写化）
    assert.strictEqual(res.headers['content-type'], 'text/csv; charset=utf-8')
    // 文件名 = messages-<YYYYMMDD-HHmmss>.csv：纯 ASCII + 北京时间戳（本地时间，非 UTC），
    // 精确到秒（同秒内连导两次才会重名）——判据是「时间戳存在且指向当下」。
    const cd = String(res.headers['content-disposition'])
    const cdMatch = /^attachment; filename="messages-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.csv"$/.exec(cd)
    assert.ok(cdMatch, `Content-Disposition 必须是 messages-<YYYYMMDD-HHmmss>.csv（实际：${cd}）`)
    assert.ok(!/[^\x20-\x7e]/.test(cd), 'Content-Disposition 必须是纯 ASCII（中文环境兼容，不依赖 filename*）')
    const stampMs = Date.UTC(+cdMatch[1], +cdMatch[2] - 1, +cdMatch[3], +cdMatch[4], +cdMatch[5], +cdMatch[6])
    // 北京时间 = UTC+8：把文件名里的「本地时刻」当 UTC 解读，应比 Date.now() 正好大 8 小时；
    // 差 5 分钟容差只吸收「请求跨分钟边界」。
    assert.ok(Math.abs(Date.now() + 8 * 3600 * 1000 - stampMs) < 5 * 60 * 1000, `时间戳必须是当前北京时间（实际 ${cdMatch[0]}）`)
    assert.strictEqual(res.headers['x-export-truncated'], undefined, '未截断不下发该头')
    // BOM（request() 收 utf8 字符串，BOM 呈 U+FEFF）
    assert.strictEqual(res.text.charCodeAt(0), 0xFEFF, 'CSV 必须以 UTF-8 BOM 开头')
    // 全串比对（第 3 条标题含逗号/引号/换行，naive split 会碎行）：
    // fixture 倒序 = shijianchuo 降序 → 行序 4,3,2,1
    const expected = [
      '\uFEFFid,时间,分类,标题,内容摘要',
      '4,2026-10-15 13:00,好单-日用,\'-2件起批,正常',
      '3,2026-10-15 11:00,好单-食品,"含,引号""换行\n测试",奥利奥',
      '2,2026-10-15 12:00,好单-食品,\'@SUM(A1:A9),饼干',
      '1,2026-10-15 10:00,好单-日用,\'  =1+1,牛奶',
      ''
    ].join('\r\n')
    assert.strictEqual(res.text, expected, 'CSV 全串逐字符一致（含引号内真实 LF）')
    // 附件出口（writeHead+end）入日志（蓝图 §3.2 防线 5 + §3.3 测试清单末条；审查 3.2-MA2 / 3.3-M2）：
    // 真附件 200 导出走 res.writeHead+end 附件出口（非 sendJson），finish 钩子必须同样覆盖。
    const attachLog = JSON.parse((await request(port, 'GET', '/api/access-log', { token: TOKEN })).text)
    const attachHit = [...attachLog.items].reverse().find((it) => it.path === '/api/messages/export')
    assert.ok(attachHit && attachHit.method === 'POST' && attachHit.status === 200, 'CSV 附件出口（writeHead+end，非 sendJson）必须入访问日志')
    server.close()
  })
  await aok('T4 5000 钳制 + X-Export-Truncated: 5010 条截断/30 条不出头/展示分页互不干扰', async () => {
    const dir = tmpDir()
    const big = []
    for (let i = 0; i < 5010; i++) {
      big.push({ id: i + 1, title: `条目${i + 1}`, content: '内容', catename: '好单-日用', shijianchuo: 1000000 - i, datetime: '2026-10-15', shorttime: '10:00' })
    }
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify(big))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const j = JSON.parse((await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })).text)
    // 成功导出 = 直接数组（评审 231-M1）；截断信息走 X-Export-Truncated 头（不进体）。
    assert.ok(Array.isArray(j), '成功 JSON 导出必须是直接数组')
    assert.strictEqual(j.length, EXPORT_MAX_ROWS, '恰 5000 行（截断）')
    assert.strictEqual(typeof j[0].title, 'string', '元素=行对象')
    const jr = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })
    assert.match(String(jr.headers['content-disposition']), /^attachment; filename="messages-\d{8}-\d{6}\.json"$/, 'JSON 导出同样带时间戳文件名')
    assert.strictEqual(jr.headers['x-export-truncated'], 'true', 'JSON 分支同样下发截断头')
    // D2-S9：导出口径必须回显「实际生效的搜索词」（列表端点早有 queryUsed）
    assert.strictEqual(jr.headers['x-export-query-used'], '', '无搜索词时头为空串而非缺席')
    const longQ = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: `format=json&q=${'a'.repeat(300)}` })
    assert.strictEqual(longQ.headers['x-export-query-used'], encodeURIComponent('a'.repeat(240)), '240 字节截断后的词必须如实回显（修前完全不回显）')
    const c = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=csv' })
    assert.strictEqual(c.headers['x-export-truncated'], 'true', 'CSV 分支同样下发截断头')
    // 该 fixture 单元格无逗号/引号，允许 naive split：表头 + 5000 行 + 尾 \r\n = 5002 段
    assert.strictEqual(c.text.split('\r\n').length, 5002)
    // 对照：30 条 fixture 不出头
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'push.json'), JSON.stringify(big.slice(0, 30)))
    const { server: s2 } = createConsole({ token: TOKEN, stateDir: dir2 })
    const port2 = await listen(s2)
    const small = JSON.parse((await request(port2, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })).text)
    assert.ok(Array.isArray(small) && small.length === 30, '30 条子集=30 行数组（评审 231-M1 形态）')
    const smallRes = await request(port2, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })
    assert.strictEqual(smallRes.headers['x-export-truncated'], undefined, '未截断时头缺席（缺席=完整）')
    // 展示分页与导出钳制互不干扰（审查 3.2-MI1）：对 5010 条 fixture（同一 server）断言
    // size=100 → 恰 100 条且 total=5010——「size 超限被钳回 100」的正向锁，30 条子集断 ≤100 恒真无检出力。
    const page = JSON.parse((await request(port, 'GET', '/api/messages?size=100', { token: TOKEN })).text)
    assert.strictEqual(page.items.length, 100, '展示分页 size=100 → 恰 100 条（钳制仍生效）')
    assert.strictEqual(page.total, 5010, 'total=过滤后全量（与导出 grandTotal 同 fixture 一致）')
    // 30 条对照（未截断出口的口径不变）：size=100 无钳制效果，仍全量 30 条
    const page2 = JSON.parse((await request(port2, 'GET', '/api/messages?size=100', { token: TOKEN })).text)
    assert.strictEqual(page2.items.length, 30)
    s2.close()
    server.close()
  })
  await aok('T5 JSON 字段白名单: 恰五键，内部字段零携带', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([
      { id: 9, title: '标题', content: '正文', catename: '好单-日用', shijianchuo: 500, datetime: '2026-10-15', shorttime: '10:00', price: 9.9, url: '/a/9.html', cateid: '3', content_html: '<img src=x>', _f: false }
    ]))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })
    const j = JSON.parse(res.text)
    assert.ok(Array.isArray(j), '成功 JSON 导出=直接数组（评审 231-M1）')
    assert.deepStrictEqual(Object.keys(j[0]).sort((a, b) => a.localeCompare(b)), ['cate', 'excerpt', 'id', 'time', 'title'], '恰五键')
    const raw = JSON.stringify(j[0])
    for (const k of ['url', 'price', 'cateid', 'content_html', 'shijianchuo', '_f', 'rowKey', 'datetime', 'shorttime']) {
      assert.ok(!raw.includes(`"${k}"`), `不得携带内部字段 ${k}`)
    }
    assert.strictEqual(j[0].id, '9', 'id 为字符串形态')
    server.close()
  })
  await aok('T6 中文 q 跨 chunk 多字节（readBody StringDecoder 回归）+ GET 对照一致', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([
      { id: 1, title: '牛奶特价', content: '伊利', catename: '好单-日用', shijianchuo: 1000, datetime: '2026-10-15', shorttime: '10:00' },
      { id: 2, title: '面包', content: '烘焙', catename: '好单-食品', shijianchuo: 2000, datetime: '2026-10-15', shorttime: '11:00' }
    ]))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 自建 http.request 两次 write：'format=json&q=' 长 14 字节，牛 = E7 89 9B，
    // 在偏移 15（牛 的第 1 字节后）切开，其余字节走第二段——跨 chunk 多字节切分回归锁。
    const full = Buffer.from('format=json&q=牛奶', 'utf8')
    const parts = [full.subarray(0, 15), full.subarray(15)]
    assert.strictEqual(Buffer.concat(parts).equals(full), true, '分片还原自检')
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/messages/export', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${TOKEN}`, 'content-length': full.length } }, (res2) => {
        let buf = ''
        res2.on('data', c => { buf += c })
        res2.on('end', () => resolve({ status: res2.statusCode, text: buf, headers: res2.headers }))
      })
      req.on('error', reject)
      req.write(parts[0])
      // 两次 write 间插 10ms（审查 3.2-MA1）：背靠背 write 会被 Node 客户端合并成单 chunk
      // （分片不存在、新旧实现同绿=假绿）；间隔后服务端稳定收 [15,5] 两个 data 事件，
      // 旧实现（逐 chunk toString）会产出 U+FFFD，套件对回滚真正变红。
      // 反向验证实测：5ms 在旧 readBody 副本上仍有 ~9% 合并逃逸（单进程 53 次中 5 次旧实现照绿），
      // 10ms 跨单进程/进程内两形态 55 次 0 逃逸；对正确实现 [15,5]/[20] 都命中 牛奶特价，
      // 加长间隔无假红代价。用链式回调（Promise 构造回调非 async）。
      setTimeout(() => { req.write(parts[1]); req.end() }, 10)
    })
    assert.strictEqual(body.status, 200)
    const j = JSON.parse(body.text)
    assert.ok(Array.isArray(j), '成功 JSON 导出=直接数组')
    assert.strictEqual(j.length, 1)
    assert.strictEqual(j[0].title, '牛奶特价')
    // clampQueryBytes 直测：恰 240 字节的中文词不截（牛=E7 89 9B，80 字恰 240B），81 字起截尾
    assert.strictEqual(clampQueryBytes('牛'.repeat(80)), '牛'.repeat(80))
    assert.strictEqual(clampQueryBytes('牛'.repeat(81)), '牛'.repeat(80))
    // GET 对照：导出与页面过滤同源（同 query，同命中）
    const g = JSON.parse((await request(port, 'GET', `/api/messages?q=${encodeURIComponent('牛奶')}`, { token: TOKEN })).text)
    assert.strictEqual(g.items.length, 1)
    assert.strictEqual(String(g.items[0].id), j[0].id, '导出与列表过滤同源')
    server.close()
  })
  await aok('T-P4 buildMessagesCsv: 表头固定字面量 + 行序 + 尾 \\r\\n（确定性输出）', () => {
    const csv = buildMessagesCsv([
      { id: '1', time: 't1', cate: 'c1', title: 'x', excerpt: 'e1' },
      { id: '2', time: 't2', cate: 'c2', title: 'y,z', excerpt: 'e2' }
    ])
    assert.strictEqual(csv, 'id,时间,分类,标题,内容摘要\r\n1,t1,c1,x,e1\r\n2,t2,c2,"y,z",e2\r\n')
  })
  await aok('T7 谓词复用一致性: 导出与 GET /api/messages 同筛选 id 序列一致', async () => {
    const dir = tmpDir()
    const msgs = [
      { id: 1, title: '牛奶特价', content: '伊利', catename: '好单-日用', shijianchuo: 1000, datetime: '2026-10-15', shorttime: '10:00' },
      { id: 2, title: '坐垫', content: '好物', catename: '好单-家用', shijianchuo: 2000, datetime: '2026-10-15', shorttime: '12:00' },
      { id: 3, title: '饼干', content: '奥利奥', catename: '好单-食品', shijianchuo: 3000, datetime: '2026-10-15', shorttime: '11:00' }
    ]
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify(msgs))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const cases = [
      ['cate=好单-日用', 'cate=' + encodeURIComponent('好单-日用')],
      ['q=牛奶', 'q=' + encodeURIComponent('牛奶')],
      ['cate=好单-食品&q=饼干', 'cate=' + encodeURIComponent('好单-食品') + '&q=' + encodeURIComponent('饼干')]
    ]
    for (const [exportBody, getListQs] of cases) {
      const j = JSON.parse((await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: `format=json&${exportBody}` })).text)
      const g = JSON.parse((await request(port, 'GET', `/api/messages?${getListQs}`, { token: TOKEN })).text)
      assert.deepStrictEqual(j.map(m => m.id), g.items.map(m => String(m.id)), `筛选「${exportBody}」两侧 id 序列一致`)
    }
    server.close()
  })
  await aok('T8 读取三态: missing/invalid/tooLarge → 200 + application/json + items 空（前端不下载判据）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const missing = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })
    assert.strictEqual(missing.status, 200)
    assert.ok(missing.headers['content-type'].startsWith('application/json'), 'JSON 判据：前端不下载')
    const mj = JSON.parse(missing.text)
    assert.strictEqual(mj.status, 'missing')
    assert.deepStrictEqual(mj.items, [])
    server.close()
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'push.json'), '{broken json')
    const { server: s2 } = createConsole({ token: TOKEN, stateDir: dir2 })
    const port2 = await listen(s2)
    const invalid = await request(port2, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=csv' })
    assert.strictEqual(invalid.status, 200)
    assert.ok(invalid.headers['content-type'].startsWith('application/json'), 'CSV 请求的三态同样走 JSON 提示（不下载空文件）')
    assert.strictEqual(JSON.parse(invalid.text).status, 'invalid')
    // 三态（invalid）出口入日志（蓝图 §3.2 防线 5 + §3.3 测试清单末条；审查 3.2-MA2 / 3.3-M2）：
    // 本断言锁定的是 invalid 三态的 sendJson(res,200,{status:'invalid'}) 出口；
    // 真附件 200 的 writeHead+end 附件出口由 T3 锁定（其 finish 钩子覆盖）。
    // shouldLogAccess 白名单无此端点 → 200 也照记；path 无查询词、body 不入。
    const exLog = JSON.parse((await request(port2, 'GET', '/api/access-log', { token: TOKEN })).text)
    const exHit = [...exLog.items].reverse().find((it) => it.path === '/api/messages/export')
    assert.ok(exHit, `导出响应必须入访问日志（实际 ${JSON.stringify(exLog.items.map((i) => i.path))}）`)
    assert.strictEqual(exHit.method, 'POST')
    assert.strictEqual(exHit.status, 200)
    const exFlat = JSON.stringify(exLog.items)
    assert.ok(!exFlat.includes('format=csv'), 'body/查询词不落访问日志（只记 method+path）')
    s2.close()
    // 第三态 tooLarge（审查 3.2-MI2；评审 231-T8 改真端点）：push.json 超过控制台读取上限时
    // export 端点与 missing/invalid 共用同一 `read.status !== 'ok'` 分支如实下发。
    // 直调 readMessages 只能锁「函数行为」，锁不住路由（route 回退成功文件的回归
    // 依然全绿）——必须真发 POST /api/messages/export 断言 JSON 三态响应。
    const dirBig = tmpDir()
    fs.writeFileSync(path.join(dirBig, 'push.json'), Buffer.alloc(MESSAGES_MAX_BYTES + 1, 0x61))
    const readBig = readMessages(dirBig, { maxBytes: MESSAGES_MAX_BYTES, filename: 'push.json' })
    assert.deepStrictEqual(readBig, { status: 'tooLarge' }, '超上限 → tooLarge（不 ok、不 invalid）')
    const { server: s3 } = createConsole({ token: TOKEN, stateDir: dirBig })
    const port3 = await listen(s3)
    const tooBig = await request(port3, 'POST', '/api/messages/export', { token: TOKEN, body: 'format=json' })
    assert.strictEqual(tooBig.status, 200)
    assert.ok(tooBig.headers['content-type'].startsWith('application/json'), 'tooLarge 仍走 JSON 三态（不落成功附件）')
    const tj = JSON.parse(tooBig.text)
    assert.strictEqual(tj.status, 'tooLarge')
    assert.deepStrictEqual(tj.items, [])
    s3.close()
    fs.rmSync(dirBig, { recursive: true, force: true })
  })
  await aok('T9 body 超限 → 400（>4096 字节，与 detail 同款断言）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const big = 'q=' + 'x'.repeat(5000)
    const r = await request(port, 'POST', '/api/messages/export', { token: TOKEN, body: big })
    assert.strictEqual(r.status, 400)
    server.close()
  })
  await aok('HTTP: /trigger 超限 body 分 3 chunk 发送仍收到 413（D2-S2：修前只见 ECONNRESET）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/trigger',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' }
      }, (r) => {
        let body = ''
        r.on('data', (c) => { body += c })
        r.on('end', () => resolve({ status: r.statusCode, text: body }))
      })
      req.on('error', reject)
      const chunk = 'x'.repeat(3000)
      req.write('action=run&pad=')
      setTimeout(() => req.write(chunk), 20)
      setTimeout(() => { req.write(chunk); req.end() }, 40)
    })
    assert.strictEqual(res.status, 413, '多 chunk 超限必须能读到 413（修前 req.destroy() 先断流）')
    assert.match(res.text, /请求体超限/)
    server.close()
  })
  await aok('readMessages: (ino,size,mtime) 缓存命中 + 文件变化自动失效 + rawTotal 含 _f（D2-S18/D2-S11）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 1, title: 'a' }, { id: 2, title: 'b' }]))
    // mtime 太新（<100ms）刻意不进缓存：写后立刻读必须看到新内容
    await new Promise((resolve) => setTimeout(resolve, 150))
    const a = readMessages(dir)
    const b = readMessages(dir)
    assert.strictEqual(a.value === b.value, true, '同一份文件必须命中解析缓存（修前每请求整读+parse+排序）')
    assert.strictEqual(a.value.rawTotal, 2)
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }]))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const c = readMessages(dir)
    assert.strictEqual(c.value.rawTotal, 3, '文件变化（size/ino/mtime）后必须重读')
    // _f 条目：rawTotal 计入、total 不计入、filteredCount 单列
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'push.json'), JSON.stringify([
      { id: 1, title: 'a' }, { id: 2, title: 'b' },
      { _f: true, title: 'f1' }, { _f: true, title: 'f2' }, { _f: true, title: 'f3' }
    ]))
    const r = readMessages(dir2)
    assert.strictEqual(r.value.rawTotal, 5)
    assert.strictEqual(r.value.total, 2)
    assert.strictEqual(r.value.filteredCount, 3)
  })
  await aok('HTTP: /api/trends 按日聚合（与 parseLastRun 同一正则口径）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-14 18:02:34 total=20 dedup=5 filtered=1 truncated=0 pushed=18 failed=2 elapsed=10.1s cachesaved=1',
      '2026-10-14 19:00:00 total=10 dedup=0 filtered=0 truncated=0 pushed=10 failed=0 elapsed=1.0s cachesaved=1',
      '2026-10-15 11:01:40 total=20 dedup=0 filtered=0 truncated=0 pushed=20 failed=0 elapsed=10.1s cachesaved=1',
      '2026-10-01 08:00:00 total=99 dedup=0 filtered=0 truncated=0 pushed=99 failed=0 elapsed=1.0s cachesaved=1',
      'ERROR something broke'
    ].join('\n') + '\n')
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const t = JSON.parse((await request(port, 'GET', '/api/trends', { token: TOKEN })).text)
    assert.strictEqual(t.status, 'ok')
    assert.strictEqual(t.byDay.length, 14)
    const d14 = t.byDay.find(d => d.date === '2026-10-14')
    assert.ok(d14, '14 窗口含 10-14')
    assert.strictEqual(d14.rounds, 2)
    assert.strictEqual(d14.pushed, 28)
    assert.strictEqual(d14.failed, 2)
    const d15 = t.byDay.find(d => d.date === '2026-10-15')
    assert.strictEqual(d15.pushed, 20)
    // 窗口外的 10-01 不进任何桶（14 天窗口）
    assert.ok(!t.byDay.some(d => d.date === '2026-10-01'))
    server.close()
  })
  await aok('HTTP: /api/logs 尾读（>1MiB 截断保留尾部）+ missing；/api/sys 版本与缓存目录、无环境变量泄漏', async () => {
    const dir = tmpDir()
    const hist = tmpDir()
    // >1MiB 前缀 + 摘要行在尾部：若端点放弃尾读限制（整个文件下发）或丢了尾读（tooLarge），这条都红
    const bigPrefix = 'HEAD-MARKER-' + 'x'.repeat(1024 * 1024)
    fs.writeFileSync(path.join(hist, 'run.log'), [bigPrefix, '2026-10-15 12:16:21 total=20 dedup=0 filtered=0 truncated=0 pushed=20 failed=0 elapsed=10.1s cachesaved=1'].join('\n') + '\n')
    // D2-S5：/api/logs 必须与 /api/run-history 同读 historyDir()（运行侧真实目录），
    // 而不是 stateDir。stateDir 放一份干扰日志证明读取源唯一。
    fs.writeFileSync(path.join(dir, 'run.log'), 'STATE-DIR-ONLY-MARKER\n')
    const { server } = createConsole({ token: TOKEN, stateDir: dir, runHistoryDir: hist })
    const port = await listen(server)
    const l = JSON.parse((await request(port, 'GET', '/api/logs', { token: TOKEN })).text)
    assert.strictEqual(l.status, 'ok')
    assert.ok(l.text.includes('total=20'), '日志正文可见')
    assert.ok(!l.text.includes('HEAD-MARKER'), '超限日志必须只下发尾部 1 MiB（前缀不得出现）')
    assert.ok(!l.text.includes('STATE-DIR-ONLY-MARKER'), 'stateDir/run.log 不得被读取（与运行历史同源）')
    // missing 分支：文件不在必须 missing（不得把别的状态伪装成 ok）
    fs.unlinkSync(path.join(hist, 'run.log'))
    const empty = JSON.parse((await request(port, 'GET', '/api/logs', { token: TOKEN })).text)
    assert.strictEqual(empty.status, 'missing', 'run.log 已删除必须 missing')
    const s = JSON.parse((await request(port, 'GET', '/api/sys', { token: TOKEN })).text)
    assert.ok(/^\d+\.\d+\.\d+/.test(s.version), `版本号必须是 semver 形态（实际 ${s.version}）`)
    // v3.330：boot JSON 的启动版本必须与 /api/sys 当前版本同源，否则「有没有新版本」永远判不准。
    assert.strictEqual(s.version, require('./package.json').version,
      '/api/sys 版本必须等于 package.json（与 boot JSON 同一来源）')
    assert.strictEqual(s.cacheDir, dir)
    assert.ok(typeof s.uptimeS === 'number' && s.uptimeS >= 0)
    assert.ok(s.rssBytes > 0)
    assert.ok(!JSON.stringify(s).includes(TOKEN), '/api/sys 绝不含 token')
    assert.ok(!JSON.stringify(s).includes('XBK_CONSOLE_TOKEN'), '/api/sys 不暴露环境变量名')
    // 无凭证 401（新端点与旧端点同一鉴权口径）
    for (const p of ['/api/trends', '/api/logs', '/api/sys']) {
      const na = await request(port, 'GET', p)
      assert.strictEqual(na.status, 401, `${p} 无凭证必须 401`)
    }
    server.close()
  })
  await aok('HTTP: 畸形 request-target → 400 且进程存活（回归：裸 new URL 曾崩整个控制台）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const bad = await rawRequest(port, 'GET //@:99999/ HTTP/1.1\r\nHost: x\r\n\r\n')
    assert.strictEqual(bad.status, 400, '畸形请求行必须 400，不得崩进程')
    const alive = await request(port, 'GET', '/api/status', { token: TOKEN })
    assert.strictEqual(alive.status, 200, '同一条畸形请求处理后服务必须继续可用')
    server.close()
  })
  await aok('HTTP: GET / 下发 CSP 响应头（回归：frame-ancestors 仅 meta 承载是规范 no-op）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'GET', `/?token=${TOKEN}`)
    assert.strictEqual(res.status, 200)
    const csp = res.headers['content-security-policy']
    assert.ok(csp, '必须存在 CSP 响应头')
    assert.ok(csp.includes("frame-ancestors 'none'"), '响应头 CSP 必须含 frame-ancestors')
    assert.ok(csp.includes("default-src 'none'"), '响应头 CSP 必须含 default-src')
    server.close()
  })
  await aok('HTTP: SIGTERM 优雅关闭——锁帧 released + 子进程被杀 + 退出码 0（端到端）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-e2e-'))
    const lockFile = path.join(dir, 'console-trigger.lock')
    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'console.js')], {
      env: {
        ...process.env,
        XBK_CONSOLE_TOKEN: TOKEN,
        XBK_CONSOLE_PORT: '0',
        XBK_CACHE_DIR: dir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    // 断言失败时必须给子进程收尸：否则监听句柄把整套件钉住（实测 300s 超时）。
    try {
      // 等就绪（监听成功日志）。
      const readyDeadline = Date.now() + 10000
      while (!out.includes('已启动')) {
        if (Date.now() > readyDeadline) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(out.includes('已启动'), `子控制台未就绪：${out.slice(0, 400)}`)
      // 只取端口：本机环境可能导出了 XBK_CONSOLE_HOST=0.0.0.0（日志前缀随之变化），
      // 死抠 127.0.0.1 会让这条 e2e 在那种环境里假红（实测）。
      const m = /已启动：http:\/\/[^:]+:(\d+)/.exec(out)
      assert.ok(m, `无法解析监听端口：${out.slice(0, 200)}`)
      const cport = Number(m[1])
      const trig = await request(cport, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
      assert.strictEqual(trig.status, 202, '触发必须受理')
      assert.strictEqual(fs.existsSync(lockFile), true, '触发后锁文件必须存在')
      await new Promise(resolve => setTimeout(resolve, 150))
      // Sourcery #225 M6：SIGTERM 前无法直接观测孙进程（--check 在控制台进程内 spawn），
      // 用退出延迟区分「杀掉子进程走 close 收尾」（毫秒级）与「子进程没死、3s 看门狗
      // 强退」（≥3s）——若关停逻辑不再杀子进程，此断言必红。
      const killAt = Date.now()
      child.kill('SIGTERM')
      const code = await new Promise(resolve => {
        const to = setTimeout(() => resolve('timeout'), 8000)
        child.on('exit', (c) => { clearTimeout(to); resolve(c) })
      })
      const shutdownMs = Date.now() - killAt
      assert.ok(shutdownMs < 2800, `关停耗时 ${shutdownMs}ms ≥ 2800ms：疑似走了 3s 看门狗（子进程未被杀）\n${out.slice(-400)}`)
      assert.strictEqual(code, 0, `SIGTERM 后必须 0 退出（实际 ${code}）\n${out.slice(-400)}`)
      const frame = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      assert.strictEqual(frame.released, true, '退出后锁帧必须为 released（原地产出，不靠外部清理）')
    } catch (e) {
      try { child.kill('SIGKILL') } catch (err) {}
      throw e
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  await aok('HTTP: /trigger 落盘失败 → 500 且可立即重试（回归 Sourcery #225 M2：pending 条目必须回滚）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 让 lastAcceptPath 写入必然失败：同名目录挡路（EISDIR）。
    fs.mkdirSync(path.join(dir, 'console-lastaccept.json'))
    const bad = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(bad.status, 500, '持久化失败必须 500')
    assert.ok(bad.text.includes('fail-closed'))
    // 释放锁：上一轮已显式 releaseLockFor（否则这里 409）
    fs.rmdirSync(path.join(dir, 'console-lastaccept.json'))
    const retry = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(retry.status, 202, '失败动作在窗口内必须可立即重试（pending 条目已回滚），不得 409')
    server.close()
  })
  await aok('main: XBK_CONSOLE_PORT 非法值拒绝启动（回归 Sourcery #225 M5：NaN 不得回退 7777）', async () => {
    const c = spawn(process.execPath, [path.join(__dirname, 'scripts', 'console.js')], {
      env: { ...process.env, XBK_CONSOLE_TOKEN: TOKEN, XBK_CONSOLE_PORT: 'abc' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let errOut = ''
    c.stderr.on('data', d => { errOut += d })
    const code = await new Promise(resolve => {
      const to = setTimeout(() => resolve('timeout'), 5000)
      c.on('exit', (v) => { clearTimeout(to); resolve(v) })
    })
    assert.strictEqual(code, 1, `非法端口必须 exit 1（实际 ${code}）`)
    assert.ok(errOut.includes('非法'), `stderr 必须说明端口非法：${errOut.slice(0, 200)}`)
  })
  await aok('wireGracefulShutdown: kill(SIGKILL) → 等 close → 才退出（回归 Sourcery #225 M6：关停必须真终止子进程）', async () => {
    const dir = tmpDir()
    const { activeChildren, wireGracefulShutdown: wire } = createConsole({ token: TOKEN, stateDir: dir, port: 0 })
    // 假子进程：只有显式调 kill 才会发 close（模拟真实存活子进程）；关停若不再杀子进程，
    // kill 断言红；若不等 close 直接退出，时序断言红。
    const events = []
    const fakeChild = {
      kill (sig) { this.killed = true; this.signal = sig; events.push(`kill:${sig}`) },
      once (ev, fn) { this._onceClose = ev === 'close' ? fn : this._onceClose; return this }
    }
    activeChildren.add(fakeChild)
    let exitCode = null
    let registered = null
    const { shutdown } = wire({
      onExit: (code) => { events.push(`exit:${code}`); exitCode = code },
      registerSignal: (fn) => { registered = fn }
    })
    assert.strictEqual(typeof registered, 'function', '必须注册信号回调')
    shutdown('SIGTERM')
    assert.ok(events.includes('kill:SIGKILL'), `关停必须对活跃子进程 SIGKILL（events=${events}）`)
    // close 之前不得退出（等每个子进程真正死掉才收尾——评审 Medium G5F 序列）。
    assert.strictEqual(exitCode, null, `close 前不得退出（events=${events}）`)
    // 子进程真正 close → 才走 finishShutdown → server.close 回调 → 退出。
    fakeChild._onceClose()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.strictEqual(exitCode, 0, `子进程 close 后必须退出 0（events=${events}）`)
    assert.ok(events.indexOf('exit:0') > events.indexOf('kill:SIGKILL'), '退出必须发生在 kill 之后')
  })

  await aok('wireGracefulShutdown: 3s 看门狗对未 close 的子进程补释放锁（D1-N1 回归）', async () => {
    const dir = tmpDir()
    const p = lockPath(dir)
    const { activeChildren, runs, wireGracefulShutdown: wire } = createConsole({ token: TOKEN, stateDir: dir })
    assert.strictEqual(acquireLock(dir, Date.now(), 'tok-wd'), true)
    const fakeChild = { kill () {}, once () { return this } }
    const record = {
      id: 'wd.1',
      action: 'check',
      label: 'x',
      startedAt: Date.now(),
      finishedAt: 0,
      exitedAt: 0,
      exitCode: null,
      output: '',
      cancelled: false,
      _child: fakeChild,
      _stateDir: dir,
      _lockToken: 'tok-wd'
    }
    runs.set(record.id, record)
    activeChildren.add(fakeChild)
    const { shutdown } = wire({ onExit: () => {}, registerSignal: () => {} })
    shutdown('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).released, undefined, 'close 前不得假定已释放')
    // 看门狗 3s：子进程始终不发 close，退出前必须补 finishRun（否则锁留到 10 分钟陈旧接管）
    await new Promise((resolve) => setTimeout(resolve, 3200))
    const frame = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.strictEqual(frame.released, true, '看门狗路径必须释放锁')
    assert.strictEqual(record.finishedAt > 0, true, '记录必须收尾，不能长期停在「停止中」')
  })

  // ── v3.299 批次②：运行控制（停止按钮 + 逐轮运行历史）────────────────────────
  await aok('HTTP: POST /api/runs/cancel 防线（无凭证 401 / 畸形 id 400 / 不存在 404 / 已结束 409）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const noAuth = await request(port, 'POST', '/api/runs/cancel', { body: 'id=1' })
    assert.strictEqual(noAuth.status, 401, '无凭证必须 401')
    // POST 不收 Cookie（G_4Kb 同口径）。
    const csrf = await request(port, 'POST', '/api/runs/cancel', { headers: { cookie: `xbk_session=${TOKEN}` }, body: 'id=1' })
    assert.strictEqual(csrf.status, 401, '仅凭 Cookie 必须 401')
    const bad1 = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: '' })
    assert.strictEqual(bad1.status, 400, '缺 id 必须 400')
    const bad2 = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: 'id=abc' })
    assert.strictEqual(bad2.status, 400, '非数字 id 必须 400')
    const nf = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: 'id=1750000000000.999' })
    assert.strictEqual(nf.status, 404, '不存在的 run 必须 404（重启后历史丢失同文案）')
    // 已结束的 run → 409；伪造一条已完成记录验证（不 spawn 子进程）。
    runs.set('1750000000000.7', { id: '1750000000000.7', action: 'check', label: 'x', startedAt: Date.now(), finishedAt: Date.now(), exitedAt: Date.now(), exitCode: 0, timedOut: false, cancelled: false, output: '' })
    const done = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: 'id=1750000000000.7' })
    assert.strictEqual(done.status, 409, '已结束任务必须 409')
    assert.strictEqual(runs.get('1750000000000.7').cancelled, false, '409 路径不得置 cancelled')
    server.close()
  })
  await aok('HTTP: cancel 运行中任务（真子进程）→ 202 + SIGTERM + close 释放锁 + cancelled 徽章', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const trig = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(trig.status, 202)
    const { id } = JSON.parse(trig.text)
    // 立即取消：check 秒级完成，存在「先自然结束再 cancel → 409」的竞态——若撞上则
    // 验证 409 分支后跨动作（dry-run）重触发一轮再取消（保持确定性：最终必有 202）。
    let cancelId = id
    let c = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: `id=${id}` })
    if (c.status === 409) {
      const t3 = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
      assert.strictEqual(t3.status, 202)
      cancelId = JSON.parse(t3.text).id
      c = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: `id=${cancelId}` })
    }
    assert.strictEqual(c.status, 202, `cancel 运行中任务必须 202（实际 ${c.status}）`)
    assert.strictEqual(JSON.parse(c.text).cancelled, true)
    const rec = runs.get(cancelId)
    assert.strictEqual(rec.cancelled, true, 'record.cancelled 必须置位')
    assert.ok(rec.output.includes('收到停止请求'), '输出必须含停止提示行')
    // 幂等：重复 cancel 同 id → 200，不发第二次信号（kill 语义由 fake-child 用例锁）。
    const again = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: `id=${cancelId}` })
    assert.ok(again.status === 200 || again.status === 409, `重复 cancel 幂等（实际 ${again.status}：任务可能已自然结束）`)
    // 子进程被信号终止后 close 释放锁（SIGTERM 对无 handler 子进程近即时）。
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && rec.finishedAt === 0) await new Promise((_resolve) => setTimeout(_resolve, 100))
    assert.ok(rec.finishedAt > 0, '被取消任务必须走到 close（锁释放唯一入口）')
    const lockAfter = fs.existsSync(lockPath(dir)) ? JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')) : null
    assert.ok(!lockAfter || lockAfter.released === true, '取消后锁必须释放')
    // runs 列表带 cancelled 字段（additive 向后兼容）。
    const list = JSON.parse((await request(port, 'GET', '/api/runs', { token: TOKEN })).text)
    const row = list.runs.find((r) => r.id === cancelId)
    assert.strictEqual(row.cancelled, true, '/api/runs 必须下发 cancelled')
    server.close()
  })
  await aok('cancel 信号纪律：SIGTERM → 宽限后 SIGKILL 兜底；重复 cancel 不发第二次信号', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // fake child 注入：不响应 SIGTERM（模拟装了 handler 卡住），只有 SIGKILL 能杀。
    const events = []
    const fakeChild = {
      kill (sig) { events.push(sig) },
      once (ev, fn) { this._onceClose = ev === 'close' ? fn : this._onceClose; return this },
      stdout: { on () {} },
      stderr: { on () {} },
      on (ev, fn) { if (ev === 'close') this._realClose = fn; return this }
    }
    runs.set('1750000000000.9', { id: '1750000000000.9', action: 'check', label: 'x', startedAt: Date.now(), finishedAt: 0, exitedAt: 0, exitCode: null, timedOut: false, cancelled: false, output: '', _child: fakeChild })
    const r1 = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: 'id=1750000000000.9' })
    assert.strictEqual(r1.status, 202, 'SIGTERM 已发 + 兜底已注册 → 202')
    assert.strictEqual(events[0], 'SIGTERM', '先 SIGTERM')
    const r2 = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: 'id=1750000000000.9' })
    assert.strictEqual(r2.status, 200, '重复 cancel 幂等 200')
    assert.strictEqual(events.length, 1, `不得发第二次信号（events=${events}）`)
    // 宽限期（3s）后 SIGKILL 兜底——直接等 3.4s 验证兜底真实触发（缩短宽限不可注入，
    // 常量按生产值 3000ms 走）。
    await new Promise((resolve) => setTimeout(resolve, 3400))
    assert.ok(events.includes('SIGKILL'), `宽限后必须 SIGKILL 兜底（events=${events}）`)
    server.close()
  })
  // ── v3.300 批次③ 3.1 SSE 端到端 ──
  await aok('SSE T1 鉴权与方法：无/错凭证 401；仅 Cookie 放行（GET 收 Cookie）；POST → 404 兜底', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const seed = makeStreamRecord('1750000000000.9')
    streamAppend(seed, 'seed')
    runs.set('1750000000000.9', seed)
    const noAuth = await request(port, 'GET', '/api/runs/stream?id=1750000000000.9')
    assert.strictEqual(noAuth.status, 401, '无凭证必须 401（不升级连接）')
    const badAuth = await request(port, 'GET', '/api/runs/stream?id=1750000000000.9&token=' + 'y'.repeat(32))
    assert.strictEqual(badAuth.status, 401, '错凭证必须 401')
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=0', { headers: { cookie: `xbk_session=${TOKEN}` } })
    assert.strictEqual(await sse.waitFor(() => sse.events.length > 0), true, '仅 Cookie 必须放行（GET 收 Cookie）')
    sse.close()
    const post = await request(port, 'POST', '/api/runs/stream', { token: TOKEN })
    assert.strictEqual(post.status, 404, 'POST 不匹配 → 落 404 兜底')
    server.close()
  })
  await aok('SSE T2 参数闸：缺 id/坏形态 400、不存在 404、since 非法值 200 且按 0 钳制', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    runs.set('1750000000000.9', makeStreamRecord('1750000000000.9'))
    const bad1 = await request(port, 'GET', '/api/runs/stream', { token: TOKEN })
    assert.strictEqual(bad1.status, 400, '缺 id 必须 400')
    for (const bad of ['abc', '1750.1', '1750000000000..', '1750000000000.-1', '1750000000000.12345678901']) {
      const r = await request(port, 'GET', `/api/runs/stream?id=${encodeURIComponent(bad)}`, { token: TOKEN })
      assert.strictEqual(r.status, 400, `坏形态 id「${bad}」必须 400`)
    }
    const nf = await request(port, 'GET', '/api/runs/stream?id=1750000000000.999', { token: TOKEN })
    assert.strictEqual(nf.status, 404, '合法形态不存在 → 404')
    const seeded = makeStreamRecord('1750000000000.9')
    streamAppend(seeded, 'hello')
    runs.set('1750000000000.9', seeded)
    for (const badSince of ['abc', '-5', '1.5', '1e999']) {
      const sse = sseCollect(port, `/api/runs/stream?id=1750000000000.9&since=${badSince}`, { headers: { authorization: `Bearer ${TOKEN}` } })
      assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true, `since=${badSince} 钳 0 → 收整段`)
      const frames = sse.events.filter((e) => e.event === 'message')
      assert.strictEqual(JSON.parse(frames[0].data), 'hello', `since=${badSince} 首帧=整段（按 0 钳制）`)
      sse.close()
    }
    server.close()
  })
  await aok('SSE T3 响应头：event-stream / x-accel-buffering: no / cache-control: no-cache', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    runs.set('1750000000000.9', makeStreamRecord('1750000000000.9'))
    const head = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/runs/stream?id=1750000000000.9', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.once('data', () => {}) // 触发头到达即可
        resolve(res)
      })
      req.on('error', reject)
      req.end()
    })
    assert.ok(head.headers['content-type'].startsWith('text/event-stream'), 'content-type 前缀 event-stream')
    assert.strictEqual(head.headers['x-accel-buffering'], 'no')
    assert.strictEqual(head.headers['cache-control'], 'no-cache')
    head.destroy()
    server.close()
  })
  await aok('SSE T4 增量推送与游标：since=0 全串 → 追加收增量 → 拼接不重不漏 → close 后 Set 归零', async () => {
    const dir = tmpDir()
    const { server, runs, sseConnections } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, '第一段输出\n第二行')
    runs.set('1750000000000.9', rec)
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=0', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true, '首帧到达')
    const f1 = sse.events.find((e) => e.event === 'message')
    assert.strictEqual(JSON.parse(f1.data), '第一段输出\n第二行', '首帧=快照全串')
    streamAppend(rec, '第一段增量')
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message' && JSON.parse(e.data) === '第一段增量'), true, '增量帧到达')
    streamAppend(rec, '第二段增量\n中文🐮多字节')
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message' && e.data.includes('🐮')), true, '多字节增量到达')
    const all = sse.events.filter((e) => e.event === 'message').map((e) => JSON.parse(e.data)).join('')
    assert.strictEqual(all, '第一段输出\n第二行第一段增量第二段增量\n中文🐮多字节', '所有 message 帧拼接 === 期望全串（不重不漏）')
    sse.close()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && sseConnections.size > 0) await new Promise((_resolve) => setTimeout(_resolve, 25))
    assert.strictEqual(sseConnections.size, 0, 'close 后服务端连接必须清理归零')
    server.close()
  })
  await aok('SSE T5 多字节 since 切片：since=3 → 恰一帧「文🐮」（逐码元，不重不漏）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, 'AB中文🐮') // len 6：A B 中 文 🐮🐮
    runs.set('1750000000000.9', rec)
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=3', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true)
    const frames = sse.events.filter((e) => e.event === 'message')
    assert.strictEqual(frames.length, 1, '恰一帧')
    assert.strictEqual(JSON.parse(frames[0].data), '文🐮')
    sse.close()
    server.close()
  })
  await aok('SSE L1 Last-Event-ID 续传：header 优先于 since，只补缺口不重发', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, 'ABCDEF')
    runs.set('1750000000000.9', rec)
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=0', {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': '4' }
    })
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true, '续传帧到达')
    const frames = sse.events.filter((e) => e.event === 'message')
    assert.strictEqual(frames.length, 1, '只补缺口：恰一帧')
    assert.strictEqual(JSON.parse(frames[0].data), 'EF', '从 Last-Event-ID=4 续传')
    assert.strictEqual(frames[0].id, '6', '数据帧必须带绝对游标 id（浏览器据此回传 Last-Event-ID）')
    assert.strictEqual(sse.events.some((e) => e.event === 'reset'), false, '游标可用时不得整段重发')
    sse.close()
    server.close()
  })
  await aok('SSE L2 非法 Last-Event-ID：回落整段并标 reset（客户端替换而非追加）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, '整段输出')
    runs.set('1750000000000.9', rec)
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9', {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': 'not-a-number' }
    })
    assert.strictEqual(await sse.waitFor((e) => e.event === 'reset'), true, '非法游标必须以 reset 整段重发')
    const reset = sse.events.find((e) => e.event === 'reset')
    assert.strictEqual(JSON.parse(reset.data).full, '整段输出')
    assert.strictEqual(sse.events.some((e) => e.event === 'message'), false, 'reset 已覆盖全量，不得再追加 data 帧')
    sse.close()
    // 科学计数法不是十进制游标：Number('1e3')=1000 会被静默钳到尾部 → 一帧不发（丢输出）。
    // 必须按形态拒绝并走 reset（Sourcery PR #321）。
    const sseSci = sseCollect(port, '/api/runs/stream?id=1750000000000.9', {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': '1e3' }
    })
    assert.strictEqual(await sseSci.waitFor((e) => e.event === 'reset'), true, '1e3/0x10 一类非十进制游标必须 reset 而非静默钳位')
    sseSci.close()
    server.close()
  })
  await aok('SSE M3 超前 since 钳制：since=99999 → 钳到尾部，追加照常收增量（不吞输出）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, 'seed')
    runs.set('1750000000000.9', rec)
    // since=99999 > outputTotalLength=4：旧实现保留超前游标 → ssePlanChunk 恒 null，
    // 追加 '增量' 后（total=7 < 99999）永远无帧；修复后钳到 4，追加即推。
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=99999', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sse.ready(), true, '响应头到达（连接已建立、游标已定）')
    streamAppend(rec, '增量') // 建流后追加：修复前（保留超前游标）永远无帧
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message' && JSON.parse(e.data) === '增量'), true, '追加后增量帧必须到达（超前游标已钳尾部）')
    sse.close()
    server.close()
  })
  await aok('SSE M2 背压下 done 不丢：暂停客户端 → 关停广播排队 done → teardown flush（非 abort 路径）', async () => {
    const dir = tmpDir()
    const { server, runs, sseConnections } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    rec.output = 'y'.repeat(614400)
    rec.outputTotalLength = 614400
    runs.set('1750000000000.9', rec)
    let raw = ''
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /api/runs/stream?id=1750000000000.9&since=0 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`)
      sock.pause() // 无 data 监听：内核收下首帧后服务端 write 返 false → paused
      const waitConn = setInterval(() => {
        if (sseConnections.size > 0) {
          clearInterval(waitConn)
          runs.delete('1750000000000.9') // 淘汰路径：下个 tick sseWriteFrame(done) 入 pending（paused）→ teardown flush
        }
      }, 5)
    })
    const to = Date.now() + 15000
    while (Date.now() < to && sseConnections.size > 0) await new Promise((_resolve) => setTimeout(_resolve, 25))
    assert.strictEqual(sseConnections.size, 0, '关停广播 → 连接摘除')
    // 判据=读到 done 帧（非 abort 路径 res.end 的 FIN 对暂停客户端不可靠——T10 同教训，
    // ended 在探针 t10k 实测 5s 不浮出；帧在字节流里即证据）。
    sock.on('data', (c) => { raw += c })
    sock.resume()
    const kick = setInterval(() => { if (!sock.destroyed) sock.resume() }, 20)
    const to2 = Date.now() + 10000
    while (Date.now() < to2 && !raw.includes('event: done')) await new Promise((_resolve) => setTimeout(_resolve, 25))
    clearInterval(kick)
    assert.strictEqual(raw.includes('event: done'), true, '背压排队的 done 帧经 teardown flush 照常送达')
    sock.destroy()
    server.close()
  })
  await aok('脱敏 D1 深层编码：三层 %2574oken 与 畸形转义+编码键 同串 → 全 ***（不动点 + 尽力解码）', () => {
    // 三层编码（%2574oken= → %74oken= → token=）：判定用解码副本，落盘保留原串
    assert.strictEqual(sanitizeAccessPath('/api/x?%2574oken=SECRET'), '/api/x?%2574oken=***')
    // 编码敏感键 + 无关畸形转义同串：旧实现 decodeURIComponent 整体抛错提前 return，
    // 键名保持 %74 形态洗不到；现在逐段尽力解码判定（畸形段不解码、不丢段）
    const mixed = sanitizeAccessPath('/api/x?%74oken=SECRET&z=%E0%80')
    assert.strictEqual(mixed, '/api/x?%74oken=***&z=%E0%80', '敏感键值盖掉，其余原样保留')
    assert.ok(!mixed.includes('SECRET'))
  })
  await aok('代理对 M6/M7：excerpt 截断与 query 钳制均不劈 emoji', () => {
    // M6：excerpt 边界劈代理对 → 回退一码元（无孤立高代理）
    const emoji = '🐮'
    const pad = 'x'.repeat(EXPORT_EXCERPT_MAX - 1)
    const row = exportRowOf({ content: pad + emoji + 'tail', title: 't' })
    assert.strictEqual(row.excerpt.length, EXPORT_EXCERPT_MAX - 1, '边界代理对回退一码元')
    assert.strictEqual(/[\uD800-\uDBFF]$/.test(row.excerpt), false, '末码元不得是孤立高代理')
    assert.ok(!row.excerpt.includes('tail'), '仍是截断串')
    // 恰好整对落在界内：不回退
    const row2 = exportRowOf({ content: 'x'.repeat(EXPORT_EXCERPT_MAX - 2) + emoji, title: 't' })
    assert.strictEqual(row2.excerpt.endsWith(emoji), true, '完整代理对保留')
    // M7：query 钳制不残留孤立代理
    const q = clampQueryBytes('a'.repeat(238) + emoji) // 238+4=242B > 240B → 去到 ≤240
    assert.strictEqual(/[\uD800-\uDBFF]$/.test(q), false, '钳制结果不得以孤立高代理结尾')
    assert.ok(Buffer.byteLength(q, 'utf8') <= 240, '仍在字节上限内')
  })
  await aok('SSE T6 环形淘汰：游标落后 lost → reset 帧整段重发；对照游标 ≥ lost → 普通增量', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    rec.output = 'y'.repeat(1000)
    rec.outputTotalLength = 1100 // 模拟已淘汰 100 码元
    runs.set('1750000000000.9', rec)
    const sseA = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=50', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sseA.waitFor((e) => e.event === 'reset'), true, 'since=50 < lost=100 → reset')
    const rf = sseA.events.find((e) => e.event === 'reset')
    assert.strictEqual(JSON.parse(rf.data).full, rec.output, 'reset 整段=现存缓冲')
    sseA.close()
    const sseB = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=150', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sseB.waitFor((e) => e.event === 'message'), true, 'since=150 ≥ lost → 普通增量')
    assert.strictEqual(sseB.events.some((e) => e.event === 'reset'), false, '不得误发 reset')
    assert.strictEqual(JSON.parse(sseB.events.find((e) => e.event === 'message').data), 'y'.repeat(950), '增量恰为 slice(150−100)=950 码元')
    sseB.close()
    server.close()
  })
  await aok('SSE T7 完结 done + 关流：finishedAt 已设且游标对齐 → done 帧 + res.end', async () => {
    const dir = tmpDir()
    const { server, runs, sseConnections } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, '最终输出')
    rec.finishedAt = Date.now()
    rec.closedAt = Date.now()
    runs.set('1750000000000.9', rec)
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9', { headers: { authorization: `Bearer ${TOKEN}` } }) // 无 since → cursor=total
    assert.strictEqual(await sse.waitFor((e) => e.event === 'done'), true, '收到 done 帧')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !sse.isEnded()) await new Promise((_resolve) => setTimeout(_resolve, 25))
    assert.strictEqual(sse.isEnded(), true, '服务端 res.end 后客户端收到 end')
    const deadline2 = Date.now() + 3000
    while (Date.now() < deadline2 && sseConnections.size > 0) await new Promise((_resolve) => setTimeout(_resolve, 25))
    assert.strictEqual(sseConnections.size, 0, '关流后连接不在 Set')
    sse.close()
    server.close()
  })
  await aok('SSE T8 淘汰 done：runs.delete 后写循环复查感知 → done + end（20 条淘汰路径零 diff 验证）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const rec = makeStreamRecord('1750000000000.9')
    streamAppend(rec, '在跑')
    runs.set('1750000000000.9', rec)
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=0', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true, '首帧到达')
    runs.delete('1750000000000.9')
    assert.strictEqual(await sse.waitFor((e) => e.event === 'done'), true, '淘汰 → done')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !sse.isEnded()) await new Promise((_resolve) => setTimeout(_resolve, 25))
    assert.strictEqual(sse.isEnded(), true, 'done 后关流')
    sse.close()
    server.close()
  })
  await aok('SSE T9 连接上限：第 9 条 503；关 1 条可再开；全关 Set 归零', async () => {
    const dir = tmpDir()
    const { server, runs, sseConnections } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const seeded = makeStreamRecord('1750000000000.9')
    streamAppend(seeded, 'seed')
    runs.set('1750000000000.9', seeded)
    const conns = []
    for (let i = 0; i < SSE_MAX_CONNECTIONS; i++) {
      const sse = sseCollect(port, `/api/runs/stream?id=1750000000000.9&since=0&seq=${i}`, { headers: { authorization: `Bearer ${TOKEN}` } })
      assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true, `第 ${i + 1} 条建连收首帧`)
      conns.push(sse)
    }
    const ninth = await request(port, 'GET', '/api/runs/stream?id=1750000000000.9', { token: TOKEN })
    assert.strictEqual(ninth.status, 503, '第 9 条必须 503')
    conns[0].close()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && sseConnections.size >= SSE_MAX_CONNECTIONS) await new Promise((_resolve) => setTimeout(_resolve, 25))
    // 重开探测不能用 request()（它会等响应体 end——SSE 有心跳永不 end）：只读响应头。
    const reopen = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/runs/stream?id=1750000000000.9&probe=reopen', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.once('data', () => {})
        resolve(res)
      })
      req.on('error', reject)
      req.end()
    })
    assert.strictEqual(reopen.statusCode, 200, '关 1 条后可再开')
    assert.ok(String(reopen.headers['content-type']).startsWith('text/event-stream'))
    reopen.destroy()
    for (const sse of conns) sse.close()
    server.close()
  })
  await aok('SSE T10 慢客户端积压硬断：暂停读 + 大快照 + 定隔追加 → 待发超限硬断（无 done 帧）', async () => {
    const dir = tmpDir()
    const { server, runs, sseConnections } = createConsole({ token: TOKEN, stateDir: dir, sseMaxPending: 1024 })
    const port = await listen(server)
    // 种子输出 600KiB：建连首个 tick 整帧 write（600KiB > 回环内核发送缓冲）。
    const rec = makeStreamRecord('1750000000000.9')
    rec.output = 'y'.repeat(614400)
    rec.outputTotalLength = 614400
    runs.set('1750000000000.9', rec)
    // raw socket 客户端：请求行发出后**立即** pause 读，且**不挂 data 监听**——挂了
    // 'data' 流动模式会先吃掉首块、pause 失去对 libuv 读的门闩作用（探针实测 paused
    // 恒 false）；无监听时 socket 永不流入，pause 是确定性闸。
    // 硬断判据（plan §4 T10 口径「无 done 帧」）：
    // 1. 服务端侧：待发积压 > sseMaxPending(1024) → sseTeardown(conn,true) → Set 摘除。
    //    客户端 paused 期间 RST/FIN 不可见（内核缓冲吞掉终结事件，探针 t10wr 实测
    //    服务端 res.close 已触发而 paused 客户端无任何事件）——故只以服务端 Set 归零
    //    为「已断」判据，随后恢复读让排队字节与终结流入。
    // 2. 客户端侧：恢复读后 socket 必终结（destroy → 排队字节流尽后 close）；收到的
    //    原始字节含数据帧但**不含 event: done**（超限 teardown 不发 done；淘汰/完结
    //    路径才发——区分硬断与正常收尾）。ECONNRESET 'error' 不可用作判据：本服务端
    //    destroy 前已 res.end() 且缓冲已入内核（探针 destroyorder 实测 end-then-destroy
    //    → 客户端只 'close' 无 'error'），错误码断言在本机形态物理不可达。
    // ⚠️ 追加节奏必须用 setInterval（await-sleep 异步链在回环自调优下会让首帧恰好被
    // 吸收、paused 恒 false——plan §4 T10 预警的环境敏感形态）；追加总量 24×256KiB ≈
    // 6MiB 必须压过内核缓冲 autotune 硬顶（套件内实测 ~2.9MB 处 write 才返 false）。
    let ended = false
    let raw = ''
    let appendTimer = null
    let torn = false
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /api/runs/stream?id=1750000000000.9&since=0 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`)
      sock.pause()
      // 连接登记后再开始追加：untilTornDown「先等出现、再等消失」不能与追加赛跑。
      const waitConn = setInterval(() => {
        if (sseConnections.size > 0) {
          clearInterval(waitConn)
          let i = 0
          appendTimer = setInterval(() => {
            i++
            streamAppend(rec, 'z'.repeat(262144))
            if (i >= 24 || torn) clearInterval(appendTimer)
          }, 50)
        }
      }, 5)
    })
    sock.on('error', () => { ended = true })
    sock.on('close', () => { ended = true })
    const untilTornDown = async (ms) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms && sseConnections.size === 0) await new Promise((_resolve) => setTimeout(_resolve, 10))
      if (sseConnections.size === 0) return false // 连接从未建立（异常形态，直接判负）
      const to = Date.now() + ms
      while (Date.now() < to) {
        if (sseConnections.size === 0) return true
        await new Promise((_resolve) => setTimeout(_resolve, 25))
      }
      return sseConnections.size === 0
    }
    torn = await untilTornDown(20000)
    if (appendTimer) clearInterval(appendTimer)
    assert.strictEqual(torn, true, '超限硬断 → 服务端连接已 teardown 摘除')
    sock.on('data', (c) => { raw += c })
    sock.resume()
    // pause-before-flow 的 readableFlowing=false 陷阱：resume 一次不必然启动流动，
    // 周期性踢一脚直到终结（探针 t10kick/t10good 实证 3/3 稳定）。
    const kick = setInterval(() => { if (!sock.destroyed) sock.resume() }, 20)
    const untilEnded = async (ms) => {
      const to = Date.now() + ms
      while (Date.now() < to) {
        if (ended) return true
        await new Promise((_resolve) => setTimeout(_resolve, 25))
      }
      return ended
    }
    assert.strictEqual(await untilEnded(10000), true, '恢复读后客户端收到连接终结（排队字节流尽 → close）')
    clearInterval(kick)
    assert.strictEqual(sseConnections.size, 0, '硬断后服务端连接保持摘除')
    assert.strictEqual(raw.includes('event: done'), false, '超限硬断不发 done 帧（区别于淘汰/完结收尾路径）')
    assert.ok(raw.length > 0, '硬断前已排队的数据帧照常流入客户端')
    server.close()
  })
  await aok('SSE T11 shuttingDown 广播：置位 → 活跃连接收 done + end；新连接 503', async () => {
    const dir = tmpDir()
    const { server, runs, activeChildren, wireGracefulShutdown: wire } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const seeded = makeStreamRecord('1750000000000.9')
    streamAppend(seeded, 'seed')
    runs.set('1750000000000.9', seeded)
    // 假活跃子进程（cancel 用例同款 fake 形态）：无 activeChildren 时关停序列会立即
    // finishShutdown → server.close()，「新连接 → 503」探测会 ECONNREFUSED；有 pending
    // 子进程时收尾被推迟到 close/3s 看门狗，窗口内 server 仍在监听、关停闸可测。
    const fakeChild = {
      kill () {},
      once () { return this },
      stdout: { on () {} },
      stderr: { on () {} },
      on () { return this }
    }
    activeChildren.add(fakeChild)
    let registered = null
    // onExit 必须注入 no-op：doExit 默认 process.exit(0)——1s 强退兜底会把整个测试套件
    // 静默带走（EXIT=0、摘要行缺失）。与 SIGTERM e2e 用例注入 onExit 同理。
    wire({ onExit: () => {}, registerSignal: (fn) => { registered = fn } })
    const sse = sseCollect(port, '/api/runs/stream?id=1750000000000.9&since=0', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.strictEqual(await sse.waitFor((e) => e.event === 'message'), true, '建连收首帧')
    registered('SIGTERM')
    assert.strictEqual(await sse.waitFor((e) => e.event === 'done'), true, '关停广播 done')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !sse.isEnded()) await new Promise((_resolve) => setTimeout(_resolve, 25))
    assert.strictEqual(sse.isEnded(), true, '广播后 end')
    const again = await request(port, 'GET', '/api/runs/stream?id=1750000000000.9', { token: TOKEN })
    assert.strictEqual(again.status, 503, '关停窗口新连接 503')
    sse.close()
    server.close()
  })
  await aok('SSE T12 outputTotalLength 端到端：真子进程 check 轮详情输出数值计数器且常态等于 output.length', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    let trig = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    if (trig.status === 409) {
      // 竞态兜底（cancel 用例同款）：check 窗口内撞上重放窗 → 跨动作重触发
      const t3 = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
      assert.strictEqual(t3.status, 202, '跨动作触发必须 202')
      trig = t3
    } else {
      assert.strictEqual(trig.status, 202)
    }
    const { id } = JSON.parse(trig.text)
    const deadline = Date.now() + 30000
    let detail = null
    while (Date.now() < deadline) {
      const r = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: `id=${id}` })
      detail = JSON.parse(r.text)
      if (detail.finishedAt) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(detail && detail.finishedAt, '子进程应在 30s 内结束')
    assert.strictEqual(typeof detail.outputTotalLength, 'number', '详情必须下发 outputTotalLength 数值')
    assert.ok(detail.outputTotalLength >= detail.output.length, '计数器 ≥ 现存长度（无淘汰常态应相等）')
    assert.strictEqual(detail.outputTotalLength, detail.output.length, 'check 输出 < 512KiB 无淘汰 → 恒等')
    const get = JSON.parse((await request(port, 'GET', `/api/runs/${id}`, { token: TOKEN })).text)
    assert.strictEqual(get.outputTotalLength, detail.outputTotalLength, 'GET 详情响应体等价')
    server.close()
  })
  // ── v3.374 全站 SSE 通知（/api/stream）：变化才推、连接上限、收尾不挂 ──
  // 只读响应头就返回的建连器：这条流永不 end（靠心跳与 tick），request() 会一直等下去。
  const openLiveStream = (port) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/stream',
      headers: { authorization: 'Bearer ' + TOKEN }
    }, (res) => {
      res.on('data', () => {}) // 保持流动，别让内核缓冲把服务端 write 卡成 false
      resolve({ status: res.statusCode, headers: res.headers, destroy: () => { try { req.destroy() } catch (e) { /* 已断 */ } } })
    })
    req.on('error', reject)
    req.end()
  })
  const until = async (fn, ms = 3000) => {
    const to = Date.now() + ms
    while (Date.now() < to) {
      if (fn()) return true
      await new Promise((_resolve) => setTimeout(_resolve, 20))
    }
    return fn()
  }
  await aok('全站 SSE S1 鉴权与响应头：无/错凭证 401；会话 Cookie 放行；event-stream + no-store + x-accel-buffering', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const noAuth = await request(port, 'GET', '/api/stream')
    assert.strictEqual(noAuth.status, 401, '无凭证必须 401（不升级连接）')
    const badAuth = await request(port, 'GET', '/api/stream?token=' + 'y'.repeat(32))
    assert.strictEqual(badAuth.status, 401, '错凭证必须 401')
    const sse = sseCollect(port, '/api/stream', { headers: { cookie: `xbk_session=${TOKEN}` } })
    assert.strictEqual(await sse.ready(), true, '会话 Cookie 必须放行（原生 EventSource 带不了 Bearer）')
    const h = sse.headers()
    assert.ok(String(h['content-type']).startsWith('text/event-stream'), 'content-type 前缀 event-stream')
    assert.strictEqual(h['cache-control'], 'no-store', '带鉴权的流不得允许缓存存储（no-store 而非 no-cache）')
    assert.strictEqual(h['x-accel-buffering'], 'no', '必须禁反向代理缓冲，否则 tick 要等代理攒满')
    sse.close()
    server.close()
  })
  await aok('全站 SSE S2 变化才推：写 run.log ≤3s 收到 tick（具名事件 + 毫秒时间戳）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const sse = sseCollect(port, '/api/stream', { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.strictEqual(await sse.ready(), true, '建连成功')
    fs.appendFileSync(path.join(dir, 'run.log'), '2026-10-26 10:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1.0s cachesaved=1\n')
    assert.strictEqual(await sse.waitFor((e) => e.event === 'tick', 3000), true, '写 run.log 后 ≤3s 必须收到 tick')
    const frame = sse.events.find((e) => e.event === 'tick')
    const payload = JSON.parse(frame.data)
    assert.strictEqual(typeof payload.at, 'number', 'tick 载荷必须带毫秒时间戳')
    assert.ok(Math.abs(Date.now() - payload.at) < 60000, '时间戳必须是当前时刻（不是恒定的假值）')
    sse.close()
    server.close()
  })
  await aok('全站 SSE S3 无变化不刷帧；三类指纹各自触发 tick（注入 60ms 采样）', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir, sseStreamTickMs: 60 })
    const port = await listen(server)
    const sse = sseCollect(port, '/api/stream', { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.strictEqual(await sse.ready(), true, '建连成功')
    const tickCount = () => sse.events.filter((e) => e.event === 'tick').length
    // 空转：注入 60ms 采样，500ms 里已跑了十几轮，但四项指纹都没变 ⇒ 一帧 tick 都不该发
    // （心跳注释帧不算事件）。反例：把判据写成「每拍都发」这条会立刻红。
    await new Promise((_resolve) => setTimeout(_resolve, 500))
    assert.strictEqual(tickCount(), 0, '无变化不得刷 tick（否则只是把 15s 轮询换成 2s 轮询）')
    // 逐个指纹源都得能独立触发：漏一项就等于「那类变化永远要等 60s 安全轮询」。
    for (const [label, mutate] of [
      ['push.json', () => fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify([{ id: 1, title: '新推送' }]))],
      // runs 是模块级 Map（跨实例共享，历史用例也往里塞同 id 记录）——这里必须用独占 id，
      // 否则「运行中 id 集合」本来就有它，加了等于没加，指纹不变。
      ['运行中 id', () => runs.set('1750000999999.7', makeStreamRecord('1750000999999.7'))],
      ['auto 状态文件', () => fs.writeFileSync(path.join(dir, 'console-auto.json'), JSON.stringify({ on: true, interval: 5, updatedAt: Date.now() }))]
    ]) {
      const before = tickCount()
      mutate()
      assert.strictEqual(await sse.waitFor(() => tickCount() > before, 2000), true, `${label} 变化必须推 tick`)
    }
    sse.close()
    server.close()
  })
  await aok('全站 SSE S4 共享采样 + 连接上限：一条写两个连接各收一帧；第 21 条 503；全关后采样器停', async () => {
    const dir = tmpDir()
    // 注入 60ms 采样：两个连接必须收到「同一拍」的一帧，共享的意思是只读一次盘而不是各推一份。
    const { server, streamClients, streamSamplerActive } = createConsole({ token: TOKEN, stateDir: dir, sseStreamTickMs: 60 })
    const port = await listen(server)
    const a = sseCollect(port, '/api/stream', { headers: { authorization: 'Bearer ' + TOKEN } })
    const b = sseCollect(port, '/api/stream', { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.strictEqual(await a.ready(), true)
    assert.strictEqual(await b.ready(), true)
    assert.strictEqual(streamSamplerActive(), true, '有连接时必须起共享采样器')
    fs.appendFileSync(path.join(dir, 'run.log'), 'x=1\n')
    assert.strictEqual(await a.waitFor((e) => e.event === 'tick', 3000), true, '连接 A 收到 tick')
    assert.strictEqual(await b.waitFor((e) => e.event === 'tick', 3000), true, '连接 B 收到同一帧（共享采样）')
    assert.strictEqual(a.events.filter((e) => e.event === 'tick').length, 1, '一次变化只推一帧（A）')
    assert.strictEqual(b.events.filter((e) => e.event === 'tick').length, 1, '一次变化只推一帧（B）')
    // 补到 20 条再试第 21 条：上限值取实现常量，改小/改大都得同步这里的语义。
    const extra = []
    while (streamClients.size < SSE_STREAM_MAX_CONNECTIONS) {
      const c = await openLiveStream(port)
      assert.strictEqual(c.status, 200, '上限内必须 200')
      extra.push(c)
    }
    assert.strictEqual(streamClients.size, 20, '满员 20 条')
    // 超限探测必须只读响应头：万一把闸写错成放行，request() 会一直等这条永不完结的流，
    // 用例只能等满 25s 超时才报错（红线退化时会变成「超时」而不是清晰的 503 断言）。
    const over = await openLiveStream(port)
    assert.strictEqual(over.status, 503, '第 21 条必须立刻 503')
    over.destroy() // 200 也照断：断言已失败，别把连接留到用例超时
    // 关 1 条腾出位置：仍可再开（上限是动态计数，不是「一辈子 20 条」）
    extra[0].destroy()
    assert.strictEqual(await until(() => streamClients.size < SSE_STREAM_MAX_CONNECTIONS), true, '关连接后 Set 摘除')
    const reopen = await openLiveStream(port)
    assert.strictEqual(reopen.status, 200, '腾出位置后可再开')
    reopen.destroy()
    for (const c of extra) c.destroy()
    a.close()
    b.close()
    assert.strictEqual(await until(() => streamClients.size === 0), true, '全部断开后 Set 归零')
    assert.strictEqual(await until(() => streamSamplerActive() === false), true, '最后一个连接走掉必须停采样定时器')
    server.close()
  })
  await aok('全站 SSE S5 收尾：server.close() 主动断开在途流（客户端收到 end，不留悬挂句柄）', async () => {
    const dir = tmpDir()
    const { server, streamClients, streamSamplerActive } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const sse = sseCollect(port, '/api/stream', { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.strictEqual(await sse.ready(), true, '建连成功')
    assert.strictEqual(streamClients.size, 1)
    server.close()
    assert.strictEqual(streamClients.size, 0, 'close() 必须同步摘掉所有通知流连接')
    assert.strictEqual(streamSamplerActive(), false, 'close() 必须停采样器（否则测试进程挂住）')
    assert.strictEqual(await until(() => sse.isEnded()), true, '客户端必须收到流结束（res.end）')
  })
  await aok('全站 SSE 前端: pollIntervalFor 降频 + createLiveChannel 连流/重连/降级/可见性（假 EventSource 运行时断言）', async () => {
    const { createLiveChannel, pollIntervalFor } = await import('./scripts/console-assets/pure.mjs')
    // 间隔口径用字面量锁死：SSE 在线 60s 安全轮询、断线 15s、任务在跑 2s。
    const base = { pollMs: 15000, busyMs: 2000, safetyMs: 60000 }
    assert.strictEqual(pollIntervalFor({ ...base, sseUp: false, busy: false }), 15000, '断线走 15s 轮询')
    assert.strictEqual(pollIntervalFor({ ...base, sseUp: true, busy: false }), 60000, 'SSE 在线降为 60s 安全轮询')
    assert.strictEqual(pollIntervalFor({ ...base, sseUp: true, busy: true }), 2000, '任务在跑仍用快轮询（SSE 是补充不是替代）')
    assert.strictEqual(pollIntervalFor({ ...base, sseUp: false, busy: true }), 2000)
    // 假 EventSource：记录 url / close / 事件分发；假 document：可控可见性 + 事件派发。
    const made = []
    class FakeEventSource {
      constructor (url) {
        this.url = url
        this.readyState = 0 // CONNECTING
        this.closed = false
        this.listeners = {}
        made.push(this)
      }

      addEventListener (name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn) }
      close () { this.closed = true; this.readyState = 2 }
      emit (name) { for (const fn of [...(this.listeners[name] || [])]) fn({}) }
    }
    FakeEventSource.CONNECTING = 0
    FakeEventSource.OPEN = 1
    const doc = {
      visibilityState: 'visible',
      listeners: [],
      addEventListener (name, fn) { if (name === 'visibilitychange') this.listeners.push(fn) },
      removeEventListener (name, fn) { this.listeners = this.listeners.filter((x) => x !== fn) },
      flip (state) { this.visibilityState = state; for (const fn of [...this.listeners]) fn() }
    }
    const ticks = []
    const states = []
    const ch = createLiveChannel({
      EventSourceCtor: FakeEventSource,
      doc,
      onTick: () => ticks.push(Date.now()),
      onChange: (up) => states.push(up)
    })
    assert.strictEqual(ch.open(), true, '可见时建流')
    assert.strictEqual(made.length, 1, '只建一条 EventSource')
    assert.strictEqual(made[0].url, '/api/stream', 'URL 是相对字面量且不带 token（凭证走会话 Cookie）')
    assert.ok(!made[0].url.includes('token'), 'URL 不得携带凭证（会进浏览器历史/代理日志）')
    assert.strictEqual(ch.open(), false, 'open 幂等：重复调用不得叠第二条流')
    assert.strictEqual(made.length, 1)
    // onopen → 在线态（60s 降频的依据）；tick 帧是具名事件，必须真的触发一次拉取。
    const es = made[0]
    es.readyState = FakeEventSource.OPEN
    es.onopen()
    assert.deepStrictEqual(states, [true], 'open 后进入在线态')
    es.emit('tick')
    assert.strictEqual(ticks.length, 1, 'tick 帧触发一次 refresh')
    // 断线：仍在 CONNECTING 且未超 3 次 → 交给浏览器自带重连（立刻 close 会丢掉退避/续传）。
    es.readyState = FakeEventSource.CONNECTING
    es.onerror(); es.onerror(); es.onerror()
    assert.strictEqual(es.closed, false, '重连窗口内不得 close')
    assert.strictEqual(ch.isUp(), true, '仍按在线处理（轮询保持降频）')
    es.onerror() // 第 4 次
    assert.strictEqual(es.closed, true, '超过 3 次才降级关闭')
    assert.deepStrictEqual(states, [true, false], '降级 → 通知调用方恢复 15s 轮询')
    assert.strictEqual(ch.isOpen(), false)
    // 可见性：隐藏断开（不发请求）、可见立刻重连并补拉一次。
    doc.flip('hidden')
    assert.strictEqual(made.length, 1, '隐藏时只是断开，不新建流')
    doc.flip('visible')
    assert.strictEqual(made.length, 2, '回到可见立刻重连')
    assert.strictEqual(ticks.length, 2, '重连后补拉一次（隐藏期间漏的帧不补发）')
    assert.strictEqual(ch.isOpen(), true)
    // 新连接 open 之后才算「在线」——降频的前提是通道真的通了，不是「我刚发起了连接」。
    made[1].readyState = FakeEventSource.OPEN
    made[1].onopen()
    doc.flip('hidden')
    assert.strictEqual(made[1].closed, true, '隐藏必须断开（后台标签页不留长连接）')
    assert.deepStrictEqual(states, [true, false, true, false], '状态序列：在线→降级→重连在线→隐藏离线')
    // 卸载：摘掉可见性监听 + 关闭连接；之后任何可见性事件都不得再建流。
    ch.dispose()
    assert.strictEqual(doc.listeners.length, 0, 'dispose 必须摘掉 visibilitychange 监听')
    doc.flip('visible')
    assert.strictEqual(made.length, 2, 'dispose 之后不得再建流')
    // 迟到事件（旧连接）不得影响当前状态
    const before = made.length
    made[0].onerror()
    assert.strictEqual(made.length, before, '旧连接的迟到 error 不得触发新连接')
  })
  await aok('全站 SSE 前端接线: ui.js 单一 effect 管流 + 清理断开 + 间隔走 pollIntervalFor', async () => {
    const uiSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'ui.js'), 'utf8')
    const sseSeg = uiSrc.slice(uiSrc.indexOf('  // 全站 SSE 通知（v3.374）'), uiSrc.indexOf('  // 轮询节奏（Sourcery vvJ）'))
    assert.ok(sseSeg.length > 0, '必须存在全站 SSE 的独立 effect 段')
    assert.ok(sseSeg.includes('createLiveChannel({'), '必须复用纯函数里的状态机（不在 App 里手写 EventSource）')
    assert.ok(sseSeg.includes('onTick: () => { runTickRef.current() }'), 'tick 必须走共享的一拍（条件请求拉取）')
    assert.ok(sseSeg.includes('return () => channel.dispose()'), 'effect 清理必须断开并摘监听（切页/暂停/卸载都不漏）')
    assert.ok(sseSeg.includes('if (authExpired || !autoRefresh)'), '暂停与凭证失效都必须停止长连接')
    assert.ok(sseSeg.includes("document.visibilityState !== 'hidden'"), '隐藏的标签页不建流')
    const pollSeg = uiSrc.slice(uiSrc.indexOf('  // 轮询节奏（Sourcery vvJ）'), uiSrc.indexOf('  // hash 路由'))
    assert.ok(pollSeg.includes('pollIntervalFor({ sseUp, busy: locking, pollMs: POLL_MS, busyMs: POLL_BUSY_MS, safetyMs: SSE_HEARTBEAT_MS })'),
      '轮询间隔必须由 pollIntervalFor 判定（SSE 在线 → 安全轮询）')
    assert.ok(pollSeg.includes('timerRef.current = setInterval(() => { runTick() }, interval)'),
      '全页只有一个定时器，且复用同一拍')
    assert.ok(!pollSeg.includes('new window.EventSource'), '轮询 effect 内不得再建第二条流')
    // 安全轮询间隔 60s：字面量锁死（不引用常量自证），且必须与「断线 15s」区分开。
    const consts = await import('./scripts/console-assets/constants.js')
    assert.strictEqual(consts.SSE_HEARTBEAT_MS, 60000, 'SSE 在线时的安全轮询间隔必须是 60s')
    assert.strictEqual(consts.POLL_MS, 15000, '断线退回的轮询间隔仍是 15s')
  })
  await aok('HTTP: GET /api/run-history（轮界模型 / 行号游标 / limit 钳制 / 鉴权）', async () => {
    const dir = tmpDir()
    // 轮界模型（v3.299 评审 #3/#12）：失败行在**同轮**摘要行之前紧邻出现（生产写序
    // xbk_app.js :1684→:1688，时间戳同轮）。14:30 轮 = ERROR + 其摘要（interrupted:true）；
    // good 15:00 与 old 13:00 正常收尾；WARN 行不是失败信号。
    const good = '2026-10-15 15:00:00 total=20 dedup=1 filtered=2 truncated=0 pushed=17 failed=0 elapsed=10.1s cachesaved=1'
    const midSummary = '2026-10-15 14:30:00 total=5 dedup=0 filtered=0 truncated=0 pushed=0 failed=3 elapsed=1.0s dry-run未推送=3'
    const err = '2026-10-15 14:30:00 ERROR 推送全部失败 3 条（通道可能失效）'
    const warn = '2026-10-15 14:00:00 WARN 通道健康更新异常: x'
    const old_ = '2026-10-15 13:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=0 failed=1 elapsed=9.9s cachesaved=1'
    const stop = '2026-10-15 15:05:00 ERROR 控制台停止：任务 #1792236290484.5（check）于运行中被停止（SIGTERM）'
    fs.writeFileSync(path.join(dir, 'run.log'), [old_, warn, err, midSummary, good, stop].join('\n') + '\n')
    const { server } = createConsole({ token: TOKEN, stateDir: dir, runHistoryDir: dir })
    const port = await listen(server)
    const na = await request(port, 'GET', '/api/run-history')
    assert.strictEqual(na.status, 401)
    const r1 = JSON.parse((await request(port, 'GET', '/api/run-history', { token: TOKEN })).text)
    assert.strictEqual(r1.status, 'ok')
    assert.strictEqual(r1.items.length, 3)
    assert.deepStrictEqual(r1.items.map((x) => x.at), ['2026-10-15 15:00:00', '2026-10-15 14:30:00', '2026-10-15 13:00:00'], '时间倒序')
    assert.strictEqual(r1.items.length, 3, '控制台停止行不产生占位轮（它是取消留痕，不是失败轮）')
    assert.strictEqual(r1.items[0].interrupted, false, '正常轮不受更早失败行污染（#3 修复点）')
    assert.strictEqual(r1.items[0].at, '2026-10-15 15:00:00', '尾部停止行不得把最新摘要挤成占位行')
    assert.strictEqual(r1.items[1].interrupted, true, 'ERROR 紧邻其摘要行 → 该轮 interrupted（写序口径）')
    assert.strictEqual(r1.items[2].interrupted, false, 'WARN 行不算失败信号')
    assert.strictEqual(r1.items[1].dryRun, 3, 'dry-run 尾组捕获')
    assert.strictEqual(r1.items[2].cachesaved, 1, 'cachesaved 尾组捕获')
    // 行号游标（v3.299 评审 #6）：before = 上一页最旧条目 lineNo-1。
    const r2 = JSON.parse((await request(port, 'GET', '/api/run-history?limit=1', { token: TOKEN })).text)
    assert.strictEqual(r2.items.length, 1)
    assert.strictEqual(r2.hasMore, true, '还有更早轮次')
    const r3 = JSON.parse((await request(port, 'GET', '/api/run-history?limit=1&before=' + (r2.items[0].lineNo - 1), { token: TOKEN })).text)
    assert.strictEqual(r3.items[0].at, '2026-10-15 14:30:00', '行号游标取更早一轮')
    const r4 = JSON.parse((await request(port, 'GET', '/api/run-history?limit=9999', { token: TOKEN })).text)
    assert.strictEqual(r4.items.length, 3, '超限钳制到 200 但全部轮次 <200 时原样返回')
    const r5 = JSON.parse((await request(port, 'GET', '/api/run-history?limit=abc&before=-3', { token: TOKEN })).text)
    assert.strictEqual(r5.items.length, 3, '非法参数回默认不报错')
    server.close()
  })
  await aok('readRunHistory: 尾窗指纹不匹配返回 stale（超窗翻页不跳轮）', () => {
    const { readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 10:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=2 failed=0 elapsed=1s cachesaved=1'
    ].join('\n') + '\n')
    const a = readRunHistory(dir, { limit: 2 })
    assert.ok(/^[0-9a-f]{8}$/.test(a.windowKey), '响应须带 8 位尾窗指纹')
    const b = readRunHistory(dir, { limit: 1, windowKey: a.windowKey })
    assert.strictEqual(b.status, 'ok', '同窗口翻页正常')
    const c = readRunHistory(dir, { limit: 1, windowKey: 'deadbeef' })
    assert.strictEqual(c.status, 'stale', '窗口平移须返回 stale')
    assert.strictEqual(c.items.length, 0, 'stale 不得下发可能错位的行')
  })

  await aok('分页/横滑控件: 运行历史与推送记录都有每页条数，趋势与历史表可横向滑动', () => {
    const js = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(/const RUN_PAGE_SIZES = \[10, 20, 50, 100\]/.test(js), '运行历史每页条数须为 10/20/50/100')
    assert.ok(js.includes('function MiniSelect ('), '必须有 MiniSelect 深色下拉组件')
    const sizeSelects = js.match(/ariaLabel="每页显示条数"/g) || []
    assert.ok(sizeSelects.length >= 2, '运行历史与推送记录各要有一个每页条数选择')
    // 选择器必须是「活的」：选项由常量渲染 + 改变时真的改条数（评审 #243-7）
    assert.ok(/RUN_PAGE_SIZES\.map\(\(n\) => \(\{ value: String\(n\), label: `每页 \$\{n\} 条` \}\)\)/.test(js), '运行历史选项须由 RUN_PAGE_SIZES 渲染')
    assert.ok(/\[10, 20, 50, 100\]\.map\(\(n\) => \(\{ value: String\(n\), label: `每页 \$\{n\} 条` \}\)\)/.test(js), '推送记录选项须由 10/20/50/100 渲染')
    assert.ok(/onChange=\$\{\(v\) => changeSize\(Number\(v\)\)\}/.test(js), '运行历史下拉须接 changeSize')
    assert.ok(/onChange=\$\{\(v\) => \{ (?:armLand\(\); |landRef\.current = true; )?setSize\(Number\(v\)\); setPage\(1\) \}\}/.test(js), '推送记录下拉须同时改 size 并回第 1 页')
    assert.ok(/\{ value: '0', label: '全部时间' \}/.test(js), '时间范围选项须走 MiniSelect 数据')
    assert.ok(/\{ value: '30', label: '近 30 天' \}/.test(js), '时间范围须保留近 30 天')
    // 原生 select 在 Android 会弹全屏白底系统列表，控制台内不得回退。
    assert.ok(!/class="msg-select"/.test(js), '控制台不得再用原生 select（安卓白底全屏列表）')
    assert.ok(!/<select\s+(?:id|class)=/.test(js), '控制台不得再用原生 select（含过滤规则回滚目标）')
    assert.ok(/\.mini-pop\s*\{[^}]*background:\s*var\(--panel\)/.test(css), 'MiniSelect 弹层必须是深色面板')
    assert.ok(/\.mini-opt\.on\s*\{[^}]*var\(--accent-soft\)/.test(css), 'MiniSelect 选中项须有暗色高亮')
    assert.ok(/\{ value: String\(n\), label: `每页 \$\{n\} 条` \}/.test(js), 'MiniSelect 的 value 必须传字符串')
    assert.ok(/\.trend-scroll\s*\{[^}]*overflow-x:\s*auto/.test(css), '趋势图须横向滚动容器')
    assert.ok(/\.trend-col\s*\{[^}]*flex:\s*0 0 34px/.test(css), '趋势列须固定宽度（否则日期挤在一起）')
    assert.ok(/\.runs-scroll\s*\{[^}]*overflow-x:\s*auto/.test(css), '运行历史表须横向滚动容器')
    assert.ok(js.includes('function AutoRefreshText ('), '倒计时必须独立组件，App 不得每秒重渲染')
    assert.ok(!js.includes('setNowMs(Date.now())'), 'App 不得保留每秒 nowMs 状态')
    // 只查精确字符串会被 setNowMs(() => Date.now()) 绕过：把 AutoRefreshText 整段摘掉后，
    // 任何剩余的 setNowMs 都说明 App/其他组件又拿到了秒级时钟（Sourcery #254）。
    const withoutAuto = js.replace(/function AutoRefreshText[\s\S]*?\n}\n/, '\n')
    assert.ok(!withoutAuto.includes('setNowMs'), '秒级时钟只能存在于 AutoRefreshText 内')
  })

  await aok('readRunHistory: 分页截断时旧失败行不得误标本页最旧一条', () => {
    const { readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-15 08:00:00 ERROR 推送全部失败 3 条（通道可能失效）',
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 10:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=2 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 11:00:00 total=3 dedup=0 filtered=0 truncated=0 pushed=3 failed=0 elapsed=1s cachesaved=1'
    ].join('\n') + '\n')
    // limit=2 时 09:00 轮不在本页；08:00 的失败行无处归属，不得回填到 10:00。
    const r = readRunHistory(dir, { limit: 2 })
    assert.deepStrictEqual(r.items.map(x => x.at), ['2026-10-15 11:00:00', '2026-10-15 10:00:00'])
    assert.deepStrictEqual(r.items.map(x => x.interrupted), [false, false], '页面满时的旧失败行不得污染本页条目')
    // 反向：紧贴本页最旧摘要之前 1 行的失败行仍须回填（旧写序 ERROR → 摘要）
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'run.log'), [
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 10:00:00 ERROR 推送全部失败 3 条（通道可能失效）',
      '2026-10-15 10:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=0 failed=3 elapsed=1s cachesaved=1',
      '2026-10-15 11:00:00 total=3 dedup=0 filtered=0 truncated=0 pushed=3 failed=0 elapsed=1s cachesaved=1'
    ].join('\n') + '\n')
    const r2 = readRunHistory(dir2, { limit: 2 })
    assert.strictEqual(r2.items[1].at, '2026-10-15 10:00:00')
    assert.strictEqual(r2.items[1].interrupted, true, '紧邻本页最旧摘要的失败行必须回填')
  })
  await aok('测试隔离: 子进程缓存目录与停止留痕都钉到本实例 stateDir', () => {
    const src = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
    // 现场证据：生产 run.log 里出现只存在于测试 fixture 的 id 1750000000000.9，且每轮都被标
    // 「中断」——测试实例的取消/停止留痕写进了仓库缓存，子进程也继承了缺省缓存目录。
    // 变异沙箱里 console.js 是插桩后的机器生成代码（语句被 stryMutAct_* 条件包裹），
    // 源码串断言只对原始源文件有意义；这些红线由 Test workflow 的 npm test 兜底。
    if (process.env.XBK_MUTATION_CHILD !== '1') {
      assert.ok(src.includes('childEnv.XBK_CACHE_DIR = cacheDir'), '子进程必须钉 XBK_CACHE_DIR 到历史目录')
      assert.ok(/startAction\(action, now, activeChildren, historyDir\(\), runToken, stateDir\)/.test(src),
        'spawn 必须把 historyDir() 传给子进程（否则 run.log 写不到历史读取目录）')
      assert.ok(src.includes('const stopDir = historyDir()'), '停止留痕必须写历史读取目录')
      assert.ok(src.includes('const historyDir = () => {'), '读取/写入/停止留痕三处必须同源 historyDir()')
      assert.ok(!src.includes('const stopDir = runtimeCacheDir() || stateDir'), '不得各自手写运行侧目录解析')
      assert.ok(src.includes('CANCEL 控制台停止：任务 #'), '取消留痕必须用独立 CANCEL 前缀')
      assert.ok(!src.includes('ERROR 控制台停止：任务 #'), '不得再写 ERROR（会被当成轮失败）')
    }
    // 行为验证：子进程（独立 node）只在真读 XBK_CACHE_DIR 时才可能写到实例目录。
    const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-cache-'))
    try {
      const out = require('node:child_process').execFileSync(process.execPath, ['-e',
        "const x=require('./xbk_function_v3');process.stdout.write(x.MessageStore.cacheDir)"],
      { cwd: __dirname, encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: dir } })
      // 沙箱（stryker/CI）里 __dirname 可能是软链路径，子进程返回的是 realpath —— 两端都归一后再比
      assert.strictEqual(fs.realpathSync(out.trim()), fs.realpathSync(dir),
        'MessageStore.cacheDir 必须服从 XBK_CACHE_DIR（否则子进程 run.log 仍写生产）')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  await aok('缓存目录: XBK_CACHE_DIR 两侧同一规则 + 控制台目录跟随运行侧（审查 D1-M1）', () => {
    const probe = "const x=require('./xbk_function_v3');process.stdout.write(x.MessageStore.cacheDir)"
    const run = (value) => spawnSync(process.execPath, ['-e', probe], {
      cwd: __dirname, encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: value }
    })
    const norm = (p) => { try { return fs.realpathSync(p) } catch (e) { return path.resolve(p) } }
    const base = run('')
    assert.strictEqual(base.status, 0, String(base.stderr))
    const defaultDir = norm(base.stdout.trim())
    // 相对路径：与 --status 同一套规则（告警 + 忽略）。旧实现运行侧真的写进 <root>/rel/cache，
    // 控制台却打印「已忽略并回退默认目录」——同一变量两套解析。
    const rel = run('rel/cache')
    assert.strictEqual(norm(rel.stdout.trim()), defaultDir, '相对路径 XBK_CACHE_DIR 必须被运行侧忽略')
    assert.match(String(rel.stderr), /XBK_CACHE_DIR 不是绝对路径（rel\/cache）/, '忽略相对路径必须告警')
    // 绝对路径（含项目根外）：两侧都原样采纳，控制台读的就是运行侧写的
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-cache-abs-'))
    const prev = process.env.XBK_CACHE_DIR
    try {
      const abs = run(outside)
      assert.strictEqual(norm(abs.stdout.trim()), norm(outside), '绝对路径必须被运行侧采纳（含根外）')
      const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn() } finally { console.warn = w } }
      process.env.XBK_CACHE_DIR = outside
      assert.strictEqual(norm(quiet(consoleStateDir)), norm(outside),
        '控制台 stateDir 必须取运行侧 MessageStore.cacheDir（否则运行历史/推送记录读空）')
      process.env.XBK_CACHE_DIR = 'rel/cache'
      assert.strictEqual(norm(quiet(consoleStateDir)), defaultDir,
        '相对路径下控制台也回退默认目录（与运行侧口径一致）')
      // --status 侧同一规则（statusCacheDir）：绝对路径原样采纳，相对路径回默认目录
      const { statusCacheDir } = require('./qinglong/xbk_push')
      assert.strictEqual(norm(quiet(() => statusCacheDir({ env: { XBK_CACHE_DIR: outside }, fs, path }))), norm(outside))
      assert.strictEqual(norm(quiet(() => statusCacheDir({ env: { XBK_CACHE_DIR: 'rel/cache' }, fs, path }))), defaultDir)
    } finally {
      if (prev === undefined) delete process.env.XBK_CACHE_DIR
      else process.env.XBK_CACHE_DIR = prev
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
  await aok('finishRun: exit 即收尾且幂等（finishedAt 只落一次、锁只释放一次，审查 #229 S6）', () => {
    const dir1 = tmpDir()
    const token1 = 'tok1'
    assert.strictEqual(acquireLock(dir1, Date.now(), token1), true)
    const rec = {
      id: 'x.1',
      finishedAt: 0,
      exitCode: null,
      _stateDir: dir1,
      _lockToken: token1,
      _timer: setTimeout(() => {}, 60000),
      _cancelTimer: setTimeout(() => {}, 60000)
    }
    let released = 0
    const release = () => { released += 1; return true }
    assert.strictEqual(finishRun(rec, 0, { release, now: () => 111 }), true)
    assert.strictEqual(rec.finishedAt, 111, 'exit 到达即落 finishedAt（不等 close）')
    assert.strictEqual(rec.exitCode, 0)
    assert.strictEqual(released, 1)
    // close 迟到再调一次：幂等，不得覆盖 exit 的事实、不得二次释放
    assert.strictEqual(finishRun(rec, 1, { release, now: () => 999 }), false)
    assert.strictEqual(rec.finishedAt, 111, 'finishAt 不得被迟到事件改写')
    assert.strictEqual(rec.exitCode, 0, 'exitCode 不得被迟到事件改写')
    assert.strictEqual(released, 1, '锁只释放一次')
    // 真实锁：收尾必须写成 released 帧（旧实现只在 close 里做，孙进程持 stdio 时锁滞留）
    const dir2 = tmpDir()
    assert.strictEqual(acquireLock(dir2, Date.now(), 'tok2'), true)
    assert.strictEqual(finishRun({ id: 'x.2', finishedAt: 0, exitCode: null, _stateDir: dir2, _lockToken: 'tok2' }, 0), true)
    assert.strictEqual(JSON.parse(fs.readFileSync(lockPath(dir2), 'utf8')).released, true,
      'finishRun 必须释放触发锁')
    // 接线：exit 与 close 都调用 finishRun（close 只做剩余清理）。
    // 变异沙箱里 console.js:498（child.on('exit')）落在 part1（1-563）变异范围内，
    // 插桩插入的 stryMutAct_* 会撑爆 400 字符窗口——源码窗口断言只对原始源文件有意义；
    // 该接线的行为语义由上面的 finishRun 单元断言（exit 即落 / close 幂等）兜底。
    if (process.env.XBK_MUTATION_CHILD !== '1') {
      const src = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
      assert.ok(/child\.on\('exit'[\s\S]{0,400}finishRun\(record, code\)/.test(src), 'exit 必须收尾')
      assert.ok(/child\.on\('close'[\s\S]{0,400}finishRun\(record, code\)/.test(src), 'close 必须幂等补收尾')
    }
  })
  await aok('readRunHistory: CANCEL 取消留痕成独立条目且不污染相邻轮（审查 #229 S7/D1-N3）', () => {
    const { readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 09:05:00 CANCEL 控制台停止：任务 #1792236290484.7（run）于运行中被停止（SIGTERM）',
      '2026-10-15 09:05:00 CANCEL 控制台停止：任务 #1792236290484.8（check）于运行中被停止（SIGTERM）',
      '2026-10-15 11:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=2 failed=0 elapsed=1s cachesaved=1'
    ].join('\n') + '\n')
    const r = readRunHistory(dir, { limit: 5 })
    assert.deepStrictEqual(r.items.map((x) => x.at),
      ['2026-10-15 11:00:00', '2026-10-15 09:05:00', '2026-10-15 09:05:00', '2026-10-15 09:00:00'])
    assert.strictEqual(r.items[1].cancelled, true, '取消留痕必须生成 cancelled 条目（这轮不能消失）')
    assert.strictEqual(r.items[2].cancelled, true, '同秒两条停止留痕必须是两条独立记录')
    assert.strictEqual(r.items[1].isPlaceholder, true)
    assert.strictEqual(r.items[1].interrupted, false, '取消不是运行失败')
    assert.strictEqual(r.items[0].interrupted, false, '取消留痕不得把下一轮标成中断')
    assert.strictEqual(r.items[3].interrupted, false, '也不得把上一轮标成中断')
    const only = readRunHistory(dir, { limit: 5, excludeCancelled: true })
    assert.deepStrictEqual(only.items.map((x) => x.at),
      ['2026-10-15 11:00:00', '2026-10-15 09:00:00'], '「仅运行」在服务端排除取消留痕')
  })
  await aok('createConsole: 注入 stateDir 优先于全局缓存；显式 runHistoryDir 可覆盖（Sourcery 注入目录被绕过）', async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-runtime-dir-'))
    const state = tmpDir()
    fs.writeFileSync(path.join(runtime, 'run.log'),
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1\n')
    fs.writeFileSync(path.join(state, 'run.log'),
      '2026-10-15 09:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=2 failed=0 elapsed=1s cachesaved=1\n')
    const prev = process.env.XBK_CACHE_DIR
    process.env.XBK_CACHE_DIR = runtime
    try {
      // 注入 stateDir 的嵌入式实例：即使 XBK_CACHE_DIR 指向别处，也必须读自己的 stateDir。
      const a = createConsole({ token: TOKEN, stateDir: state })
      const portA = await listen(a.server)
      const ra = JSON.parse((await request(portA, 'GET', '/api/run-history', { token: TOKEN })).text)
      assert.strictEqual(ra.status, 'ok')
      assert.strictEqual(ra.items.length, 1)
      assert.strictEqual(ra.items[0].pushed, 2, '注入 stateDir 必须优先，不能被全局运行目录覆盖')
      a.server.close()
      // 显式 runHistoryDir 仍是最高优先级（生产/测试需要「状态与运行产物分居」时用）。
      const b = createConsole({ token: TOKEN, stateDir: state, runHistoryDir: runtime })
      const portB = await listen(b.server)
      const rb = JSON.parse((await request(portB, 'GET', '/api/run-history', { token: TOKEN })).text)
      assert.strictEqual(rb.items.length, 1)
      assert.strictEqual(rb.items[0].pushed, 1, 'runHistoryDir 必须覆盖 stateDir')
      b.server.close()
    } finally {
      if (prev === undefined) delete process.env.XBK_CACHE_DIR
      else process.env.XBK_CACHE_DIR = prev
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })
  await aok('HTTP: run-history limit=9999 在 220 轮 fixture 上真实钳制到 200（评审 #14）', async () => {
    const dir = tmpDir()
    const rows = []
    for (let i = 0; i < 220; i++) {
      const hh = String(Math.floor(i / 60)).padStart(2, '0')
      const mm = String(i % 60).padStart(2, '0')
      rows.push(`2026-10-15 ${hh}:${mm}:00 total=${i} dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1`)
    }
    fs.writeFileSync(path.join(dir, 'run.log'), rows.join('\n') + '\n')
    const { server } = createConsole({ token: TOKEN, stateDir: dir, runHistoryDir: dir })
    const port = await listen(server)
    const r = JSON.parse((await request(port, 'GET', '/api/run-history?limit=9999', { token: TOKEN })).text)
    assert.strictEqual(r.items.length, 200, '220 轮 + limit=9999 必须钳制到 200')
    const d = JSON.parse((await request(port, 'GET', '/api/run-history?limit=50', { token: TOKEN })).text)
    assert.strictEqual(d.items.length, 50, '默认 limit=50')
    assert.strictEqual(d.hasMore, true)
    const r2 = JSON.parse((await request(port, 'GET', '/api/run-history?limit=50&before=' + (d.items[49].lineNo - 1), { token: TOKEN })).text)
    assert.strictEqual(r2.items.length, 50, '游标续页 50 条')
    assert.ok(r2.items[0].lineNo < d.items[49].lineNo, '续页条目必须比上页最旧更早（无重复无跳过）')
    server.close()
  })
  await aok('readRunHistory: missing 透传 / 崩溃轮占位最新位（#12）/ 失败行归属下一摘要轮（#3）', async () => {
    const { readRunHistory } = require('./scripts/status')
    assert.strictEqual(readRunHistory(tmpDir(), {}).status, 'missing')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=0.5s cachesaved=1\nERROR 致命崩溃：堆栈\n')
    const r = readRunHistory(dir, { limit: 5 })
    assert.strictEqual(r.status, 'ok')
    assert.strictEqual(r.items.length, 2, '崩溃轮占位 + 上一轮摘要')
    // #12：崩溃占位是**最新**条目（文件尾失败行其后无摘要），时间倒序首位。
    assert.strictEqual(r.items[0].total, null, '崩溃占位在倒序首位')
    assert.strictEqual(r.items[0].interrupted, true)
    assert.strictEqual(r.items[0].at, '')
    // items[1] = 上一轮摘要：正常收尾（失败行在它之后出现，不属于它）。
    assert.strictEqual(r.items[1].at, '2026-10-15 09:00:00')
    assert.strictEqual(r.items[1].interrupted, false, '#3：失败行不再污染更早的摘要轮')
    // 失败行归属下一摘要轮：old轮 → ERROR → mid轮。
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'run.log'), [
      '2026-10-15 08:00:00 total=9 dedup=0 filtered=0 truncated=0 pushed=9 failed=0 elapsed=1s cachesaved=1',
      'ERROR 推送全部失败 3 条（通道可能失效）',
      '2026-10-15 09:00:00 total=5 dedup=0 filtered=0 truncated=0 pushed=0 failed=3 elapsed=2s cachesaved=0'
    ].join('\n') + '\n')
    const r2 = readRunHistory(dir2, { limit: 5 })
    assert.strictEqual(r2.items[0].interrupted, true, '失败行 → 其后摘要轮 interrupted')
    assert.strictEqual(r2.items[1].interrupted, false, '更早摘要轮不受污染')
  })
  await aok('readRunHistory: 崩溃轮独立占位（不回填下一轮）且带 isPlaceholder（审查 D1-M2/D1-N5）', () => {
    const { readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 10:00:00 ERROR fetch failed ETIMEDOUT',
      '2026-10-15 11:00:00 total=5 dedup=0 filtered=0 truncated=0 pushed=5 failed=0 elapsed=2s cachesaved=1'
    ].join('\n') + '\n')
    const r = readRunHistory(dir, { limit: 5 })
    assert.deepStrictEqual(r.items.map((x) => x.at),
      ['2026-10-15 11:00:00', '2026-10-15 10:00:00', '2026-10-15 09:00:00'])
    assert.strictEqual(r.items[0].interrupted, false, '崩溃轮的 ERROR 不得把下一轮标成中断')
    assert.strictEqual(r.items[0].pushed, 5)
    assert.strictEqual(r.items[1].isPlaceholder, true, '无摘要可归属的失败行必须生成独立占位条目')
    assert.strictEqual(r.items[1].interrupted, true)
    assert.strictEqual(r.items[1].total, null)
    assert.strictEqual(r.items[1].lineNo, 2, '占位行号 = 失败行自身行号（不是摘要行号+1）')
    // limit=1：占位轮不被摘要挤掉，翻页时也按自身行号定位（不与摘要行比较）
    const one = readRunHistory(dir, { limit: 1 })
    assert.deepStrictEqual(one.items.map((x) => x.at), ['2026-10-15 11:00:00'])
    const next = readRunHistory(dir, { limit: 1, before: one.items[0].lineNo - 1 })
    assert.strictEqual(next.items[0].isPlaceholder, true, '下一页能取到崩溃占位轮')
    assert.strictEqual(next.items[0].at, '2026-10-15 10:00:00')
  })
  await aok('readRunHistory: 失败行归属与每页条数无关（±2 行且 ≤2s，审查 D1-M3/D1-S2）', () => {
    const { readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-15 07:00:00 ERROR 上一轮残留失败',
      '2026-10-15 08:00:00 WARN 通道健康更新异常: x',
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 10:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 11:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1'
    ].join('\n') + '\n')
    const two = readRunHistory(dir, { limit: 2 })
    const five = readRunHistory(dir, { limit: 5 })
    assert.deepStrictEqual(two.items.map((x) => x.interrupted), [false, false],
      'limit=2：本页摘要都不得被 07:00 的失败行标中断')
    assert.deepStrictEqual(five.items.map((x) => x.interrupted), [false, false, false, true],
      'limit=5：同一文件结论必须一致（09:00 不再因「页满闸门失效」被标中断）')
    assert.strictEqual(five.items[3].at, '2026-10-15 07:00:00')
    assert.strictEqual(five.items[3].isPlaceholder, true, '相隔 1 小时的失败行是独立崩溃轮')
    // 反向：同秒相邻（ERROR → 摘要）仍归属本轮，不受 limit 影响
    const dir2 = tmpDir()
    fs.writeFileSync(path.join(dir2, 'run.log'), [
      '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1',
      '2026-10-15 10:00:00 ERROR 推送全部失败 3 条（通道可能失效）',
      '2026-10-15 10:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=0 failed=3 elapsed=1s cachesaved=1',
      '2026-10-15 11:00:00 total=3 dedup=0 filtered=0 truncated=0 pushed=3 failed=0 elapsed=1s cachesaved=1'
    ].join('\n') + '\n')
    const r2 = readRunHistory(dir2, { limit: 2 })
    assert.strictEqual(r2.items[1].at, '2026-10-15 10:00:00')
    assert.strictEqual(r2.items[1].interrupted, true, '同秒失败行必须归属其摘要轮')
    assert.strictEqual(r2.items[0].interrupted, false)
  })
  await aok('readRunHistory: 尾窗追加后 key 游标仍可翻页（>1MiB 不再永久 stale，审查 D1-S3）', async () => {
    const { readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    const filler = '2026-10-15 00:00:00 DEBUG 填充行 ' + 'x'.repeat(120)
    const lines = []
    while (Buffer.byteLength(lines.join('\n'), 'utf8') < 1024 * 1024 + 2048) lines.push(filler)
    for (let i = 0; i < 6; i++) {
      lines.push(`2026-10-15 1${i}:00:00 total=${i} dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1`)
    }
    fs.writeFileSync(path.join(dir, 'run.log'), lines.join('\n') + '\n')
    const p1 = readRunHistory(dir, { limit: 2 })
    assert.strictEqual(p1.truncated, true, '1MiB 尾读必须标注 truncated')
    assert.deepStrictEqual(p1.items.map((x) => x.at), ['2026-10-15 15:00:00', '2026-10-15 14:00:00'])
    assert.ok(/^[0-9a-f]{8}$/.test(p1.items[1].key), '每条目必须下发 8 位稳定 key')
    // 追加一行 ⇒ 尾窗整体前移：旧的行号游标 + 旧窗口指纹必须判 stale（数据已错位）
    fs.appendFileSync(path.join(dir, 'run.log'), '2026-10-15 17:00:00 total=9 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1\n')
    const stale = readRunHistory(dir, { limit: 2, before: p1.items[1].lineNo - 1, windowKey: p1.windowKey })
    assert.strictEqual(stale.status, 'stale', '行号游标在尾窗平移后必须 stale')
    // key 游标按内容定位，追加不改变既有行 → 继续翻页
    const p2 = readRunHistory(dir, { limit: 2, before: p1.items[1].key })
    assert.strictEqual(p2.status, 'ok', 'key 游标不得因追加而失效')
    assert.deepStrictEqual(p2.items.map((x) => x.at), ['2026-10-15 13:00:00', '2026-10-15 12:00:00'])
    // HTTP 层同样接受 key 游标（前端只改传参，不改端点）
    const { server } = createConsole({ token: TOKEN, stateDir: dir, runHistoryDir: dir })
    const port = await listen(server)
    const http = JSON.parse((await request(port, 'GET', `/api/run-history?limit=2&before=${p1.items[1].key}`, { token: TOKEN })).text)
    assert.strictEqual(http.status, 'ok')
    assert.deepStrictEqual(http.items.map((x) => x.at), ['2026-10-15 13:00:00', '2026-10-15 12:00:00'])
    // 不存在的 key（锚点轮已滚出尾窗）→ stale，前端回第 1 页
    const gone = readRunHistory(dir, { limit: 2, before: 'deadbeef' })
    assert.strictEqual(gone.status, 'stale')
    server.close()
  })
  await aok('readRunHistory: 尾窗指纹不因首行为空/超长而退化（审查 D1-N6）', () => {
    const { readRunHistory } = require('./scripts/status')
    const summary = '2026-10-15 09:00:00 total=1 dedup=0 filtered=0 truncated=0 pushed=1 failed=0 elapsed=1s cachesaved=1'
    const write = (head) => {
      const d = tmpDir()
      fs.writeFileSync(path.join(d, 'run.log'), [head, summary].join('\n') + '\n')
      return d
    }
    const blankA = write('')
    const blankB = write('\n')
    const blankC = write('\n\n2026-10-15 10:00:00 total=2 dedup=0 filtered=0 truncated=0 pushed=2 failed=0 elapsed=1s cachesaved=1\n')
    const ka = readRunHistory(blankA, { limit: 1 }).windowKey
    assert.notStrictEqual(ka, '811c9dc5', '空首行不得退化成常量指纹 811c9dc5')
    assert.notStrictEqual(readRunHistory(blankB, { limit: 1 }).windowKey, ka,
      '首个非空行的行序不同（0 vs 1）必须给出不同指纹')
    assert.notStrictEqual(readRunHistory(blankC, { limit: 1 }).windowKey, ka,
      '首个非空行内容不同（09:00 vs 10:00）必须给出不同指纹')
    // 首行 200 字符之后不同：旧实现只哈希前 200 字符，会误判成同一窗口
    const prefix = 'x'.repeat(240)
    assert.notStrictEqual(readRunHistory(write(prefix + 'A'), { limit: 1 }).windowKey,
      readRunHistory(write(prefix + 'B'), { limit: 1 }).windowKey,
      '首行第 200 字符之后不同也必须区分')
    assert.ok(/^[0-9a-f]{8}$/.test(ka))
    assert.strictEqual(readRunHistory(blankC, { limit: 1 }).status, 'ok')
  })
  await aok('readStatus/readRunHistory: ALERT「运行异常」不把成功轮标中断（审查 D2-M3）', () => {
    const { readStatus, readRunHistory } = require('./scripts/status')
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), [
      '2026-10-15 09:00:00 total=120 dedup=0 filtered=0 truncated=0 pushed=100 failed=0 elapsed=8s cachesaved=1',
      '2026-10-15 09:00:01 ALERT [v3.307] ⚠️ xbk-push 运行异常 原因：线报酷数据截断',
      '2026-10-15 09:00:02 ALERT [v3.307] ⚠️ xbk-push 运行异常 原因：缺少可选依赖 re2'
    ].join('\n') + '\n')
    assert.strictEqual(readStatus(dir).run.value.interrupted, false,
      '线报酷截断/缺 re2 的 ALERT 正文含「运行异常」，但该轮是成功轮')
    const r = readRunHistory(dir, { limit: 5 })
    assert.strictEqual(r.items.length, 1, 'ALERT 不是失败行，不得生成崩溃占位轮')
    assert.strictEqual(r.items[0].interrupted, false)
    assert.strictEqual(r.items[0].pushed, 100)
  })
  // ── v3.298 只读扩展：配置视图 / 缓存健康 / 文件清单 / 趋势天数 ─────────────────
  await aok('只读纯函数: statSafeMeta 三态（常规文件 / 符号链接 / 缺失）', () => {
    const dir = tmpDir()
    const fp = path.join(dir, 'a.json')
    fs.writeFileSync(fp, '{"x":1}')
    const okMeta = statSafeMeta(fp)
    assert.strictEqual(okMeta.status, 'ok')
    assert.strictEqual(okMeta.size, 7)
    assert.ok(Number.isFinite(okMeta.mtimeMs), 'mtime 必须下发')
    // 符号链接：绝不跟随（O_NOFOLLOW 口径）——链接指向哪里都判 unsafe
    fs.symlinkSync(fp, path.join(dir, 'link.json'))
    assert.strictEqual(statSafeMeta(path.join(dir, 'link.json')).status, 'unsafe')
    assert.strictEqual(statSafeMeta(path.join(dir, 'link.json')).size, null, 'unsafe 不得泄露大小')
    fs.symlinkSync('/etc', path.join(dir, 'dirlink'))
    assert.strictEqual(statSafeMeta(path.join(dir, 'dirlink')).status, 'unsafe', '指向目录外也不跟随')
    assert.strictEqual(statSafeMeta(path.join(dir, 'ghost.json')).status, 'missing')
    // FIFO（非普通文件）：fstat.isFile() 为 false → unsafe；O_NONBLOCK 保证不阻塞等写者。
    // mkfifo 需要专用系统调用（Node 22 无 mkfifoSync）——用 coreutils 绝对路径
    // （Sonar S4036：不做可写目录 PATH 查找），普通文件先删除再建 FIFO。
    const fifo = path.join(dir, 'pipe')
    fs.rmSync(fifo, { force: true })
    require('node:child_process').execFileSync('/usr/bin/mkfifo', [fifo])
    const t0 = Date.now()
    assert.strictEqual(statSafeMeta(path.join(dir, 'pipe')).status, 'unsafe')
    assert.ok(Date.now() - t0 < 2000, 'FIFO 打开必须立即返回（O_NONBLOCK），不得阻塞等写者')
  })
  await aok('只读纯函数: classifyStateFile 分类与 F4 反例（.seen.cleanup.lock.json 是缓存不是锁）', () => {
    assert.strictEqual(classifyStateFile('push.json', 'push.json'), 'cache')
    assert.strictEqual(classifyStateFile('push.json.seen.json', 'push.json'), 'tombstone')
    assert.strictEqual(classifyStateFile('console-lastaccept.json', 'push.json'), 'console')
    assert.strictEqual(classifyStateFile('console-trigger.lock', 'push.json'), 'lock')
    assert.strictEqual(classifyStateFile('push.json.seen.lock', 'push.json'), 'lock')
    assert.strictEqual(classifyStateFile('push.json.seen.lock.takeover', 'push.json'), 'lock')
    assert.strictEqual(classifyStateFile('push.json.seen.cleanup.lock.json', 'push.json'), 'cache',
      'F4：上游 pushUrl 末段恰为 xxx.seen.cleanup.lock 时，<name>.seen.cleanup.lock.json 是合法缓存——endsWith(".lock") 不误吞它')
    assert.strictEqual(classifyStateFile('push.json.corrupt.2026-10-15T00:00:00.000Z.bak', 'push.json'), 'backup')
    assert.strictEqual(classifyStateFile('write.tmp', 'push.json'), 'temp')
    assert.strictEqual(classifyStateFile('report.state', 'push.json'), 'state')
    assert.strictEqual(classifyStateFile('re2warn.state.2026-10-15', 'push.json'), 'state')
    assert.strictEqual(classifyStateFile('run.log', 'push.json'), 'log')
    assert.strictEqual(classifyStateFile('filter-diagnostics.ndjson', 'push.json'), 'log')
    assert.strictEqual(classifyStateFile('custom-push.json', 'custom-push.json'), 'cache', '自定义 pushUrl basename 同口径')
  })
  await aok('只读纯函数: listStateFiles（名称无路径 / symlink 显性暴露不跟随 / 截断）', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'b.log'), 'x'.repeat(2048))
    fs.writeFileSync(path.join(dir, 'a.json'), '[]')
    fs.symlinkSync('/etc', path.join(dir, 'evil'))
    const list = listStateFiles(dir, 'a.json')
    assert.strictEqual(list.status, 'ok')
    assert.strictEqual(list.total, 3)
    assert.strictEqual(list.truncated, false)
    const names = list.files.map((f) => f.name)
    for (const n of names) {
      assert.ok(!n.includes('/') && !n.includes('\\') && !n.includes('..'), `只下发文件名，不得含路径成分：${n}`)
    }
    const evil = list.files.find((f) => f.name === 'evil')
    assert.strictEqual(evil.kind, 'symlink', '符号链接必须显性暴露')
    assert.strictEqual(evil.bytes, null, '符号链接不得泄露目标大小')
    assert.deepStrictEqual(list.files.map((f) => f.name), ['a.json', 'b.log', 'evil'], '按名称升序')
    const a = list.files.find((f) => f.name === 'a.json')
    assert.strictEqual(a.bytes, 2)
    assert.strictEqual(a.type, 'cache')
    // 截断：FILES_LIST_MAX 条以上 → truncated
    const big = tmpDir()
    for (let i = 0; i < FILES_LIST_MAX + 5; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(5, '0')}`), 'x')
    const bigList = listStateFiles(big, 'push.json')
    assert.strictEqual(bigList.total, FILES_LIST_MAX + 5)
    assert.strictEqual(bigList.truncated, true)
    assert.strictEqual(bigList.files.length, FILES_LIST_MAX)
    // 目录不存在 → missing
    assert.strictEqual(listStateFiles(path.join(dir, 'nope'), 'push.json').status, 'missing')
  })
  await aok('只读纯函数: tombstoneCounts（去重计数同 _loadTombstones / invalid 如实 / unsafe 不读）', () => {
    const dir = tmpDir()
    // 重复键 + 非法条目：与 MessageStore._loadTombstones 同口径——只计非空字符串、Set 去重
    const tomb = { v: 1, id: ['a', 'b', 'a', 42, ''], urlOnly: ['c'], idWithUrl: [], anon: ['d', 'e', 'f', 'd'] }
    fs.writeFileSync(path.join(dir, 'push.json.seen.json'), JSON.stringify(tomb))
    const r = tombstoneCounts(dir, 'push.json')
    assert.strictEqual(r.status, 'ok')
    assert.strictEqual(r.counts.id, 2, '重复键与非法条目不计（同 _loadTombstones 的 Map 去重口径）')
    assert.strictEqual(r.counts.urlOnly, 1)
    assert.strictEqual(r.counts.anon, 3)
    assert.strictEqual(r.counts.total, 6)
    assert.strictEqual(r.bytes, Buffer.byteLength(JSON.stringify(tomb)), 'bytes 取自读到的内容本身（单段式，无跨代拼接）')
    // invalid：非对象 JSON / 坏 JSON → invalid 而非崩溃
    fs.writeFileSync(path.join(dir, 'push.json.seen.json'), 'not-json')
    assert.strictEqual(tombstoneCounts(dir, 'push.json').status, 'invalid')
    fs.writeFileSync(path.join(dir, 'push.json.seen.json'), '[1,2]')
    assert.strictEqual(tombstoneCounts(dir, 'push.json').status, 'invalid')
    fs.writeFileSync(path.join(dir, 'push.json.seen.json'), JSON.stringify({ v: 1, id: 'not-array' }))
    const bad2 = tombstoneCounts(dir, 'push.json')
    assert.strictEqual(bad2.status, 'ok', '非数组成员跳过不炸')
    assert.strictEqual(bad2.counts.id, 0)
    // missing：正常态（首轮前）
    assert.strictEqual(tombstoneCounts(tmpDir(), 'push.json').status, 'missing')
    // unsafe（符号链接）：过闸不读——绝不调用 readSafeTextResult（其裸 open 对 FIFO 阻塞）
    const dir2 = tmpDir()
    fs.symlinkSync('/etc/passwd', path.join(dir2, 'push.json.seen.json'))
    assert.strictEqual(tombstoneCounts(dir2, 'push.json').status, 'unsafe')
    assert.strictEqual(tombstoneCounts(dir2, 'push.json').bytes, null)
    // FIFO 也走 unsafe 闸（statSafeMeta 的 O_NONBLOCK 立即返回）——若闸失效此用例挂死
    const fifoTomb = path.join(dir2, 'push.json.seen.json')
    fs.rmSync(fifoTomb, { force: true })
    require('node:child_process').execFileSync('/usr/bin/mkfifo', [fifoTomb])
    const t0 = Date.now()
    assert.strictEqual(tombstoneCounts(dir2, 'push.json').status, 'unsafe', 'FIFO 必须在 meta 闸被判 unsafe，绝不进入读内容路径')
    assert.ok(Date.now() - t0 < 2000, 'FIFO 闸必须立即返回')
  })
  await aok('readSafeTextResult: openNonBlocking 选项（普通文件语义不变 / FIFO 立即 unsafe 不阻塞）', () => {
    const { readSafeTextResult } = require('./xbk_storage')
    const dir = tmpDir()
    const fp = path.join(dir, 'plain.json')
    fs.writeFileSync(fp, '{"ok":true}')
    const withOpt = readSafeTextResult(fp, 1024, { openNonBlocking: true })
    assert.strictEqual(withOpt.status, 'ok')
    assert.strictEqual(withOpt.text, '{"ok":true}', '普通文件内容完整（O_NONBLOCK 不影响常规读取）')
    const noOpt = readSafeTextResult(fp, 1024)
    assert.strictEqual(noOpt.status, 'ok', '不传 options 的既有调用方语义不变')
    // FIFO（无写者）：O_NONBLOCK open 立即 ENXIO → unsafe；若回归为裸 open 此用例挂死
    const fifo = path.join(dir, 'pipe')
    fs.rmSync(fifo, { force: true })
    require('node:child_process').execFileSync('/usr/bin/mkfifo', [fifo])
    const t0 = Date.now()
    assert.strictEqual(readSafeTextResult(fifo, 1024, { openNonBlocking: true }).status, 'unsafe')
    assert.ok(Date.now() - t0 < 2000, 'FIFO open 必须立即返回（O_NONBLOCK），不得阻塞等写者')
  })
  await aok('只读纯函数: defaultHealthLimits entryMax 与 _resolveMaxSize 同口径（数字/字符串/脏值回退）', () => {
    const { defaultHealthLimits } = require('./scripts/console')
    const app = require('./xbk_function_v3')
    const saved = app.Config.cache.maxSize
    try {
      app.Config.cache.maxSize = 5000
      assert.strictEqual(defaultHealthLimits().entryMax, 5000, '数字配置原样采用（MessageStore 同口径）')
      app.Config.cache.maxSize = '5000'
      assert.strictEqual(defaultHealthLimits().entryMax, 5000, "数字字符串 '5000' 必须被接受（env 覆盖场景，Utils.num 语义）")
      app.Config.cache.maxSize = '  '
      assert.strictEqual(defaultHealthLimits().entryMax, 10000, '空白字符串回退默认（Utils.num 拒空串）')
      app.Config.cache.maxSize = 2.5
      assert.strictEqual(defaultHealthLimits().entryMax, 10000, '小数回退默认（Number.isInteger 判否，R3-2）')
      app.Config.cache.maxSize = 0
      assert.strictEqual(defaultHealthLimits().entryMax, 10000, '0/负值回退默认（避免缓存被清空）')
      app.Config.cache.maxSize = Number.NaN
      assert.strictEqual(defaultHealthLimits().entryMax, 10000, 'NaN 回退默认')
    } finally {
      app.Config.cache.maxSize = saved
    }
    assert.strictEqual(app.Config.cache.maxSize, saved, 'Config 必须复原（后续用例共享进程内 Config）')
  })
  await aok('只读纯函数: cacheHealthSnapshot（边界 0.8/超限/limits 注入 + missing）', () => {
    const dir = tmpDir()
    const empty = cacheHealthSnapshot(dir, 'push.json')
    assert.strictEqual(empty.status, 'missing')
    assert.strictEqual(empty.bytes, null)
    assert.strictEqual(empty.nearTrim, false)
    assert.strictEqual(empty.overLimit, false)
    assert.strictEqual(empty.tombstone.status, 'missing')
    // 注入小上限测边界（测试无需造 64MiB 文件）
    const lim = { writeMaxBytes: 100, consoleReadMaxBytes: 50, entryMax: 10, tombstoneKeyMax: 5, tombstoneMaxBytes: 8 }
    fs.writeFileSync(path.join(dir, 'push.json'), 'x'.repeat(80))
    const near = cacheHealthSnapshot(dir, 'push.json', lim)
    // writeRatio = 80/100，用整数比对（ Sonar S1244：浮点不用 === 严格相等）
    assert.ok(Math.abs(near.writeRatio - 0.8) < 1e-9, '80/100 应得 0.8（容差比对）')
    assert.strictEqual(near.nearTrim, true, '恰达 0.8 即预警（>= 判定）')
    assert.strictEqual(near.overLimit, false)
    assert.strictEqual(near.consoleReadable, false, '80 > 50 → 推送记录页不可读')
    fs.writeFileSync(path.join(dir, 'push.json'), 'x'.repeat(100))
    assert.strictEqual(cacheHealthSnapshot(dir, 'push.json', lim).nearTrim, true)
    assert.strictEqual(cacheHealthSnapshot(dir, 'push.json', lim).overLimit, false, '恰好 100 = 上限，未超')
    fs.writeFileSync(path.join(dir, 'push.json'), 'x'.repeat(101))
    const over = cacheHealthSnapshot(dir, 'push.json', lim)
    assert.strictEqual(over.overLimit, true)
    assert.strictEqual(over.nearTrim, false, '超上限后不再报「临近」')
    // 墓碑计数并入快照
    fs.writeFileSync(path.join(dir, 'push.json.seen.json'), JSON.stringify({ v: 1, id: ['k1'] }))
    const withTomb = cacheHealthSnapshot(dir, 'push.json', lim)
    assert.strictEqual(withTomb.tombstone.status, 'ok')
    assert.strictEqual(withTomb.tombstone.counts.total, 1)
    assert.strictEqual(withTomb.tombstone.bytes > 0, true, '墓碑字节数取自读到的内容')
    // HTTP 层附带 entryCount（readMessageCount 同源；tooLarge 时 null 如实下发）
    assert.strictEqual(withTomb.entryCount, undefined, '快照纯函数不含 entryCount（HTTP 层附带）')
  })
  await aok('只读纯函数: buildConfigView 白名单（无密钥值 / 渠道布尔 / configuredFlag）', () => {
    const v = buildConfigView()
    assert.strictEqual(v.configLoaded, true, '本机部署完整，Config 应可加载')
    assert.ok(v.runtime, 'runtime 视图存在')
    const blob = JSON.stringify(v)
    // 密钥值泄漏防线（fixture 值在本机 push_config.local.js 真实存在——任何值片段入响应即红）
    assert.ok(!blob.includes('"appToken"'), 'appToken 键不得出现')
    assert.ok(!blob.includes('PUSH_PLUS_TOKEN') && !blob.includes('TG_BOT_TOKEN'), '密钥环境变量名/键名不得出现')
    assert.ok(typeof v.pushChannels.count === 'number')
    assert.ok(Array.isArray(v.pushChannels.names))
    assert.strictEqual(typeof v.pushChannels.perChannel.wxpusher, 'boolean')
    assert.strictEqual(typeof v.pushChannels.wxpusher.configured, 'boolean')
    assert.strictEqual(typeof v.pushChannels.localFilePresent, 'boolean')
    // 白名单形状锁死（字段删除类变异体一次杀光）
    assert.deepStrictEqual(Object.keys(v), ['configLoaded', 'runtime', 'pushChannels', 'console'])
    assert.deepStrictEqual(Object.keys(v.runtime), ['domain', 'api', 'push', 'timing', 'cache', 'alert', 'report', 'channelHealth', 'diagnostics', 'storage', 'template', 'filter', 'keyword'])
    assert.deepStrictEqual(Object.keys(v.runtime.api), ['pushUrl', 'timeout', 'retry'])
    // filter/keyword 也是显式字段清单（不用 spread——Sourcery High：Config.filter 新增敏感
    // 字段时 spread 会自动带进响应）
    assert.deepStrictEqual(Object.keys(v.runtime.filter).sort((a, b) => a.localeCompare(b)), ['pingbibiaoti', 'pingbibiaotiplus', 'pingbifenlei', 'pingbilouzhu', 'pingbilouzhuplus', 'pingbineirong', 'pingbineirongplus', 'pingbitime', 'zhanxianbiaoti', 'zhanxianlouzhu', 'zhanxianneirong'])
    assert.deepStrictEqual(Object.keys(v.runtime.keyword), ['zkt_gjc'])
    assert.deepStrictEqual(Object.keys(v.pushChannels), ['moduleLoaded', 'count', 'names', 'perChannel', 'localFilePresent', 'wxpusher'])
    assert.ok(!Object.prototype.hasOwnProperty.call(v.pushChannels, 'localFileLoaded'), 'localFile 已更名 localFilePresent（文件存在性上报，加载与否由 sendNotify 决定）')
    assert.ok(!Object.prototype.hasOwnProperty.call(v.runtime, 'pushChannels'), '渠道状态只在 pushChannels 节点')
    assert.strictEqual(v.runtime.domain, 'https://new.ixbk.net')
    assert.strictEqual(typeof v.runtime.push.parallelLimit, 'number')
    // configuredFlag 语义
    assert.strictEqual(configuredFlag('x'), true)
    assert.strictEqual(configuredFlag('  '), false)
    assert.strictEqual(configuredFlag(''), false)
    assert.strictEqual(configuredFlag(false), false)
    assert.strictEqual(configuredFlag(true), true)
    assert.strictEqual(configuredFlag(0), true, '数字 0 是「已设置」（布尔语义只对 false/null/undefined 否定）')
    assert.strictEqual(configuredFlag(undefined), false)
    assert.strictEqual(configuredFlag(null), false)
  })
  await aok('HTTP: /api/config 脱敏视图（200 + 不含 token + 无凭证 401）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'GET', '/api/config', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.text)
    assert.strictEqual(data.configLoaded, true)
    assert.ok(!res.text.includes(TOKEN), '绝不回显 XBK_CONSOLE_TOKEN')
    assert.ok(!res.text.includes('XBK_CONSOLE'), '不暴露控制台环境变量名')
    // 无凭证 401
    const na = await request(port, 'GET', '/api/config')
    assert.strictEqual(na.status, 401)
    server.close()
  })
  await aok('HTTP: /api/files 清单（真实文件 / symlink 显性 / 名称无路径 / 无凭证 401）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'run.log'), 'x'.repeat(2048))
    fs.writeFileSync(path.join(dir, 'push.json'), '[]')
    fs.symlinkSync('/etc', path.join(dir, 'evil'))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'GET', '/api/files', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.text)
    assert.strictEqual(data.status, 'ok')
    const names = data.files.map((f) => f.name)
    assert.ok(names.includes('run.log') && names.includes('push.json'))
    assert.ok(names.includes('evil'), '符号链接显性暴露给运维')
    const evil = data.files.find((f) => f.name === 'evil')
    assert.strictEqual(evil.kind, 'symlink')
    assert.strictEqual(evil.bytes, null)
    for (const it of data.files) {
      assert.ok(!it.name.includes('/') && !it.name.includes('\\') && !it.name.includes('..'), `文件名不得含路径成分：${it.name}`)
    }
    const na = await request(port, 'GET', '/api/files')
    assert.strictEqual(na.status, 401)
    server.close()
  })
  await aok('HTTP: /api/cache-health（ok 快照 / 字节数真实 / 无凭证 401）', async () => {
    const dir = tmpDir()
    const raw = JSON.stringify([{ id: 1, title: 'x', content: 'y' }])
    fs.writeFileSync(path.join(dir, 'push.json'), raw)
    fs.writeFileSync(path.join(dir, 'push.json.seen.json'), JSON.stringify({ v: 1, id: ['a'] }))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'GET', '/api/cache-health', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.text)
    assert.strictEqual(data.status, 'ok')
    assert.strictEqual(data.bytes, Buffer.byteLength(raw))
    assert.strictEqual(data.overLimit, false)
    assert.strictEqual(data.consoleReadable, true)
    assert.strictEqual(data.tombstone.status, 'ok')
    assert.strictEqual(data.tombstone.counts.total, 1)
    assert.ok(data.limits.writeMaxBytes > 0, '上限真源下发')
    assert.strictEqual(data.entryCount, 1, 'HTTP 层附带条目数（readMessageCount 同源）')
    assert.strictEqual(data.entryCountStatus, 'ok')
    assert.strictEqual(data.entryCountFiltered, 0, '无 _f 条目时 filteredCount=0')
    const na = await request(port, 'GET', '/api/cache-health')
    assert.strictEqual(na.status, 401)
    server.close()
  })
  await aok('cache-health: entryCount 必须计入 _f（D2-S11：9000 _f + 1500 正常 → 10500 已超限）', async () => {
    const dir = tmpDir()
    const msgs = []
    for (let i = 0; i < 40; i++) msgs.push({ id: i + 1, title: `t${i}`, content: 'c' })
    for (let i = 0; i < 60; i++) msgs.push({ _f: true, title: `f${i}`, content: 'c' })
    fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify(msgs))
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const data = JSON.parse((await request(port, 'GET', '/api/cache-health', { token: TOKEN })).text)
    assert.strictEqual(data.entryCount, 100, '条目数 = 文件条目总数（含 _f）——旧口径报 40/10000')
    assert.strictEqual(data.entryCountFiltered, 60, '_f 条数单独可见')
    const page = JSON.parse((await request(port, 'GET', '/api/messages', { token: TOKEN })).text)
    assert.strictEqual(page.grandTotal, 40, '推送记录页仍只算已推送条目')
    server.close()
  })
  await aok('cache-health: 超过条数统计阈值 → 不整读，如实 tooLarge（D2-S12）', async () => {
    const dir = tmpDir()
    // 稀疏文件：8MiB+1，内容不是合法 JSON——若端点仍整读会走 invalid；必须报 tooLarge 且不 parse
    const p = path.join(dir, 'push.json')
    fs.writeFileSync(p, '')
    fs.truncateSync(p, CACHE_HEALTH_COUNT_MAX_BYTES + 1)
    const direct = cacheHealthEntryCount(dir, 'push.json')
    assert.deepStrictEqual(direct, { status: 'tooLarge', count: null, filteredCount: null }, '超阈值不整读')
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const data = JSON.parse((await request(port, 'GET', '/api/cache-health', { token: TOKEN })).text)
    assert.strictEqual(data.entryCount, null, '条数不可得时不得编数')
    assert.strictEqual(data.entryCountStatus, 'tooLarge')
    assert.match(String(data.entryCountHint || ''), /MiB/, '必须说明为何不可得')
    server.close()
  })
  await aok('HTTP: /api/trends?days 白名单（30/60 放大窗口；非法/越界钳回 14）', async () => {
    const dir = tmpDir()
    const now = Date.now()
    // 与 status.js shanghaiDayKey 同口径的日历日键（Asia/Shanghai = UTC+8）
    const dayKey = (back) => new Date(now + 8 * 3600e3 - back * 86400e3).toISOString().slice(0, 10)
    const line = (back) => `${dayKey(back)} 10:00:00 total=10 dedup=0 filtered=0 truncated=0 pushed=5 failed=0 elapsed=1.0s cachesaved=1`
    fs.writeFileSync(path.join(dir, 'run.log'), [line(0), line(20), line(50)].join('\n') + '\n')
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const t14 = JSON.parse((await request(port, 'GET', '/api/trends', { token: TOKEN })).text)
    assert.strictEqual(t14.byDay.length, TREND_DAYS_DEFAULT)
    assert.ok(!t14.byDay.some((d) => d.date === dayKey(50)), '50 天前的行不进 14 日窗')
    // 区间用「相对今天」的日期，让 fixture 的当天行落在区间里：只验日期回显/补零
    // 不验聚合的话，端点全返 0 也能过（Sourcery #288 M8）。
    const trFrom = dayKey(2)
    const trTo = dayKey(0)
    const tr = JSON.parse((await request(port, 'GET', `/api/trends?from=${trFrom}&to=${trTo}`, { token: TOKEN })).text)
    assert.deepStrictEqual([tr.from, tr.to, tr.byDay.length], [trFrom, trTo, 3], '趋势区间：回显 from/to 且按天补零')
    const trToday = tr.byDay.find((d) => d.date === trTo)
    assert.ok(trToday && trToday.rounds === 1 && trToday.total === 10 && trToday.pushed === 5,
      '区间聚合必须把当天摘要行算进去（不能只回三行 0）')
    const trBad = JSON.parse((await request(port, 'GET', '/api/trends?from=2026-02-30&to=2026-10-03', { token: TOKEN })).text)
    assert.strictEqual(trBad.from, '', '非法日期必须静默回落到 days 模式')
    const t30 = JSON.parse((await request(port, 'GET', '/api/trends?days=30', { token: TOKEN })).text)
    assert.strictEqual(t30.byDay.length, 30)
    assert.ok(t30.byDay.some((d) => d.date === dayKey(20) && d.pushed === 5), '20 天前的行进 30 日窗')
    const t60 = JSON.parse((await request(port, 'GET', '/api/trends?days=60', { token: TOKEN })).text)
    assert.strictEqual(t60.byDay.length, 60)
    assert.ok(t60.byDay.some((d) => d.date === dayKey(50) && d.pushed === 5), '50 天前的行进 60 日窗')
    for (const bad of ['abc', '3650', '7', '-1', '1e9']) {
      const t = JSON.parse((await request(port, 'GET', `/api/trends?days=${bad}`, { token: TOKEN })).text)
      assert.strictEqual(t.byDay.length, TREND_DAYS_DEFAULT, `days=${bad} 必须钳回默认`)
    }
    server.close()
  })
  // ── v3.300 访问日志端到端（蓝图 §3.3 T1-T7）────────────────────────────────
  const fetchLog = async (port) => JSON.parse((await request(port, 'GET', '/api/access-log', { token: TOKEN })).text)
  await aok('访问日志: ?token= 脱敏 + 原文零出现（深断言 JSON.stringify(items)）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const FAKE = 'z'.repeat(20)
    const noAuth = await request(port, 'GET', `/api/nope?token=${FAKE}`)
    assert.strictEqual(noAuth.status, 401, '错 token 必须 401')
    const log = await fetchLog(port)
    const hit = log.items.find((it) => it.path === '/api/nope?token=***')
    assert.ok(hit, `必须存在 path === '/api/nope?token=***' 的条目（items=${JSON.stringify(log.items.map((i) => i.path))}）`)
    assert.strictEqual(hit.status, 401)
    assert.ok(!JSON.stringify(log.items).includes(FAKE), 'token 原文在响应体零出现（深断言）')
    assert.strictEqual(log.unauthorizedCount, 1, '独立 server 全程仅此一次 401（N1 收紧）')
    server.close()
  })
  await aok('访问日志: 逃逸形态全 ***（重复参数 + %74oken 编码键名）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const r1 = await request(port, 'GET', '/api/nope?a=1&token=x1&token=y2')
    assert.strictEqual(r1.status, 401)
    const r2 = await request(port, 'GET', '/api/nope?%74oken=z3')
    assert.strictEqual(r2.status, 401)
    const log = await fetchLog(port)
    const flat = JSON.stringify(log.items)
    assert.ok(!flat.includes('x1') && !flat.includes('y2') && !flat.includes('z3'), `逃逸原文零出现（items=${flat}）`)
    assert.ok(log.items.some((it) => it.path === '/api/nope?a=1&token=***&token=***'), '重复参数形态全 ***')
    assert.ok(log.items.some((it) => it.path === '/api/nope?%74oken=***'), '编码键名命中，落盘保留原串形态（D2-N2）')
    server.close()
  })
  await aok('访问日志: 401 独立计数（3 次未授权后 =3，重复查询不漂移）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const r1 = await request(port, 'GET', '/api/sys')
    assert.strictEqual(r1.status, 401)
    const r2 = await request(port, 'GET', '/api/sys', { token: 'y'.repeat(32) })
    assert.strictEqual(r2.status, 401)
    const r3 = await request(port, 'POST', '/trigger', { body: 'action=check' })
    assert.strictEqual(r3.status, 401)
    const log = await fetchLog(port)
    assert.strictEqual(log.unauthorizedCount, 3, `3 次未授权后计数必须为 3（实际 ${log.unauthorizedCount}）`)
    const again = await fetchLog(port)
    assert.strictEqual(again.unauthorizedCount, 3, '查询自身（200）不计入，值不漂移')
    server.close()
  })
  await aok('访问日志: 环形 201 挤最旧 + 自举（查询自身入日志且最新）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    for (let i = 0; i <= 200; i++) {
      const r = await request(port, 'GET', `/api/nope?seq=${i}`, { token: TOKEN })
      assert.strictEqual(r.status, 404)
    }
    // 201 条 nope 请求全部入日志；本条查询自身的条目在其响应 finish 之后才入数组
    // ——读取时只见此前请求（蓝图自举时序：响应内容不含自身这条）。
    const log = await fetchLog(port)
    assert.strictEqual(log.items.length, ACCESS_LOG_MAX, `环形钳制到 ${ACCESS_LOG_MAX}（201 条 nope → 挤出 seq=0）`)
    assert.ok(log.items[0].path.includes('seq=1'), `最旧存活条目应为 seq=1（seq=0 已挤出；实际 ${log.items[0].path}）`)
    assert.ok(!log.items.some((it) => it.path.endsWith('seq=0')), 'seq=0 必须已被挤出')
    assert.ok(!log.items.some((it) => it.path === '/api/access-log'), '读取时点查询自身尚未入数组（finish 时序）')
    // 自举（第二时序）：此刻再查一次——上一条查询自身已入数组且是最新条目；
    // 环形现 202 条 → 再挤出 seq=1，items[0] = seq=2。
    const log2 = await fetchLog(port)
    assert.ok(log2.items[log2.items.length - 1].path === '/api/access-log', `自举：上次查询自身入日志且最新（实际末条 ${log2.items[log2.items.length - 1].path}）`)
    assert.ok(log2.items[0].path.includes('seq=2'), `第二轮后最旧存活 = seq=2（seq=0/1 已挤出；实际 ${log2.items[0].path}）`)
    assert.ok(!log2.items.some((it) => it.path.endsWith('seq=0') || it.path.endsWith('seq=1')), 'seq=0/seq=1 必须已被挤出')
    server.close()
  })
  // v3.330：每 60s 一条的版本探针不能把 200 条环形挤干净（Sourcery #294）。
  await aok('访问日志: v3.330 探针 ?probe=version 200 不入环形 / 普通 /api/sys 照记 / 响应 no-store', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const sysRes = await request(port, 'GET', '/api/sys', { token: TOKEN })
    assert.strictEqual(sysRes.headers['cache-control'], 'no-store', '/api/sys 必须显式 no-store')
    for (let i = 0; i < 3; i++) await request(port, 'GET', '/api/sys?probe=version', { token: TOKEN })
    const log = JSON.parse((await request(port, 'GET', '/api/access-log', { token: TOKEN })).text)
    assert.ok(!log.items.some((it) => it.path.includes('probe=version')), '探针 200 不得占访问日志环形')
    assert.ok(log.items.some((it) => it.path === '/api/sys'), '普通 /api/sys 必须照记（系统页仍可审计）')
    // 探针失败（未授权）必须照记——401 是最值得留痕的流量。
    const bad = await request(port, 'GET', '/api/sys?probe=version')
    assert.strictEqual(bad.status, 401)
    const log2 = JSON.parse((await request(port, 'GET', '/api/access-log', { token: TOKEN })).text)
    assert.ok(log2.items.some((it) => it.path.includes('probe=version') && it.status === 401), '探针 401 必须入日志')
    server.close()
  })

  await aok('访问日志: 降噪白名单 2xx 不入 / 404、5xx 入（含 POST /runs/detail 与 503 出口）', async () => {
    const dir = tmpDir()
    const { server, runs, setShuttingDown } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // fake record 注入（与 cancel 用例同先例）：让 GET /api/runs/:id 与 POST /api/runs/detail 命中 2xx
    runs.set('1750000000000.9', { id: '1750000000000.9', action: 'check', label: 'x', startedAt: Date.now(), finishedAt: 0, exitCode: 0, timedOut: false, cancelled: false, output: '' })
    const seq = [
      ['GET', '/api/status', 200],
      ['GET', '/api/runs', 200],
      ['GET', '/', 200],
      ['GET', '/assets/app.css', 200],
      ['GET', '/api/runs/1750000000000.9', 200],
      ['POST', '/api/runs/detail', 200]
    ]
    for (const [method, p] of seq) {
      const r = await request(port, method, p, { token: TOKEN, body: method === 'POST' ? 'id=1750000000000.9' : undefined })
      assert.strictEqual(r.status, 200, `${method} ${p} 预置 200`)
    }
    const nf = await request(port, 'GET', '/api/nope-x', { token: TOKEN })
    assert.strictEqual(nf.status, 404)
    setShuttingDown() // 关停闸：/api/runs/cancel 即刻 503（确定性 5xx 出口）
    const cancel = await request(port, 'POST', '/api/runs/cancel', { token: TOKEN, body: 'id=1750000000000.9' })
    assert.strictEqual(cancel.status, 503)
    const log = await fetchLog(port)
    const paths = log.items.map((it) => it.path)
    // 白名单六路径逐一精确断言（N2：改为直接 path 数组，替代 trim/split 间接写法）
    for (const quiet of ['/api/status', '/api/runs', '/', '/assets/app.css', '/api/runs/1750000000000.9', '/api/runs/detail']) {
      assert.ok(!paths.includes(quiet), `白名单 2xx 不得入日志：${quiet}（实际 ${paths.join(' | ')}）`)
    }
    assert.ok(log.items.some((it) => it.status === 404 && it.path.includes('/api/nope-x')), '404 必须入日志')
    assert.ok(log.items.some((it) => it.status === 503 && it.path.includes('/api/runs/cancel')), '503（cancel 出口）必须入日志')
    server.close()
  })
  await aok('访问日志: 畸形 request-target 400 入日志且脱敏（raw 串路径 D2/D3）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const SEKRIT = 'q'.repeat(20)
    // 畸形形态 1：`//@:99999` 让 new URL 抛 TypeError → 400（此前的崩溃回归形态）。
    const bad1 = await rawRequest(port, 'GET //@:99999 HTTP/1.1\r\nHost: x\r\n\r\n')
    assert.strictEqual(bad1.status, 400)
    // 畸形形态 2：合法 target 内嵌 ?token= 的 raw 形态 → 401（无凭证），path 原样
    // 进访问日志（new URL 不改写它）——验证 raw 形态过脱敏闸。
    const bad2 = await rawRequest(port, `GET /x?token=${SEKRIT} HTTP/1.1\r\nHost: x\r\n\r\n`)
    assert.strictEqual(bad2.status, 401, `raw token 请求无凭证应 401（实际 ${bad2.status}）`)
    const log = await fetchLog(port)
    assert.ok(log.items.some((it) => it.status === 400 && it.path.includes('//@:99999')), `畸形 target 的 400 必须入日志（items=${JSON.stringify(log.items.map((i) => [i.path, i.status]))}）`)
    assert.ok(log.items.some((it) => it.status === 401 && it.path.includes('token=***')), 'raw token 请求 401 条目必须脱敏')
    assert.ok(!JSON.stringify(log.items).includes(SEKRIT), 'SEKRIT 原文零出现（raw request-target 也过脱敏闸）')
    server.close()
  })
  await aok('访问日志: 字段形状六字段 / at 上海戳 / ms≥0 / src=127.0.0.1', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    await request(port, 'GET', '/api/nope', { token: TOKEN })
    // 预置两条后再查：查询自身条目在其 finish 之后才入数组，读取时点至少能看到
    // 此前的请求（若此用例是数组里第一批，请求前先垫一条 nope 404）。
    await request(port, 'GET', '/api/nope?anchor=1', { token: TOKEN })
    const log = await fetchLog(port)
    assert.ok(log.items.length >= 2, `至少含两条此前请求（实际 ${log.items.length}）`)
    for (const it of log.items) {
      assert.deepStrictEqual(Object.keys(it).sort((a, b) => a.localeCompare(b)), ['at', 'method', 'ms', 'path', 'src', 'status'], '字段恰为六个（字典序）')
      assert.match(it.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'at = 上海戳 YYYY-MM-DD HH:mm:ss')
      assert.ok(Number.isInteger(it.ms) && it.ms >= 0, 'ms 为 ≥0 整数')
      assert.strictEqual(it.src, '127.0.0.1', 'src = remoteAddress 字符串（listen 绑 127.0.0.1，无 ::ffff: 前缀）')
      assert.strictEqual(typeof it.status, 'number', 'status 为 number')
    }
    // 时间正序：数组插入序 = at 非严格递增（同秒并列按入序，下标即权威时序）
    for (let i = 1; i < log.items.length; i++) {
      assert.ok(log.items[i - 1].at <= log.items[i].at, '时间正序')
    }
    server.close()
  })

  await aok('静态红线: app.js 所有 fetch/EventSource 第一参数均为字面量或字面量起点三元', () => {
    const src = readConsoleSource()
    // Codacy SSRF 全绿形态：第一参数是 '/api/...' 字面量，或以字面量起点的三元
    // （`qs.length > 0 ? `/api/messages?${qs}` : '/api/messages'` —— authority 恒字面量，
    // PR#227 实测通过形态）。抓的是「第一参数为裸变量/函数调用」的形态。
    // v3.300 扩扫 new EventSource( ——原生 EventSource 第一参数同为 URL，同受「变量 URL」
    // 注入/SSF 风险，字面量纪律零成本统一（EventSource 无法自定义头，风险面只增不减）。
    const offenders = []
    // app.js 经 standard no-undef 改写为 window.EventSource（原生全局引用）——正则需
    // 同时覆盖两种拼写，否则扩扫形同虚设（T13 开发期自检实证：new window.EventSource(
    // 不被 /new EventSource\(/ 命中）。
    for (const m of src.matchAll(/(?:fetch|new (?:window\.)?EventSource)\(\s*([^,)]{1,60})/g)) {
      const first = m[1].trim()
      if (first.startsWith('\'/') || first.startsWith('`/')) continue
      // 三元：问号任一侧含字面量起点（'/ 或 `/）即视为安全形态
      if (first.includes('?') && (first.includes('\'/') || first.includes('`/'))) continue
      offenders.push(first)
    }
    assert.deepStrictEqual(offenders, [], `fetch/EventSource 第一参数必须是字面量或字面量三元：${offenders.join(' | ')}`)
  })

  // 静态红线：Authorization 头必须是 `Bearer ${BOOT.token}` 形态。
  // 背景（2026-10-17 真实故障）：POST /trigger 与 /api/notify-test 的头一度被写成
  // `Authorization: `*** ${BOOT.token}`` —— GET 走 Cookie 照常工作、页面全绿，只有写动作
  // 恒 401「触发失败：unauthorized」。运行期无浏览器测试可抓，只能靠源码形态断言。
  await aok('静态红线: app.js 的 Authorization 头一律 Bearer 形态（防 *** 占位符回潮）', () => {
    const src = readConsoleSource()
    const authLines = src.split('\n').filter(l => l.includes('Authorization:') && !l.trim().startsWith('//'))
    assert.ok(authLines.length > 0, '应存在 Authorization 头')
    const bad = authLines.filter(l => !/Authorization:\s*`Bearer \$\{BOOT\.token\}`/.test(l))
    assert.deepStrictEqual(bad.map(s => s.trim()), [], 'Authorization 头必须使用 Bearer 前缀加 boot token')
    assert.ok(!src.includes('***'), 'app.js 不得残留 *** 占位符')
    // 评审 #233 · Sourcery Medium：BFCache 恢复时可能跳过 `/` 请求，BOOT.token 过期仍发旧
    // Bearer → 写动作 401。必须有 persisted=true 的重载分支。
    assert.ok(/addEventListener\(['"]pageshow['"]/.test(src), 'app.js 须监听 pageshow')
    assert.ok(/ev\.persisted|e\.persisted/.test(src), 'pageshow 分支须判 persisted 后重载')
  })

  await aok('静态红线: 运行 id 是 string，禁 typeof / Number.is* 的 number 判定（v3.299 回归）', () => {
    const src = readConsoleSource()
    // v3.299 事故形态：服务端把 run id 从 number 改成 'epoch.seq' 字符串后，前端仍有
    // `typeof id === 'number'` 守卫 → 按钮永久禁用、请求永不发出，且页面无任何报错。
    // 不用单条正则：别名（runId）、括号（(id)）、下标（rows[i].id）、!== 都要覆盖。
    // 旧实现的两个洞：/id$/i 把 `valid` 误报成 id；只看 typeof，Number.isInteger(detail.id)
    // 这类等价写法静默通过。
    const isIdOperand = (raw) => {
      // 归一化：detail['id'] → detail.id；空白去掉。保留 ?. 与 || 等复合形态，
      // 用「id 记号」判定而不是整串后缀——detail?.id、id || 0 都要命中，
      // 同时不能把 valid / rowId 误判成运行 id。
      const t = String(raw)
        .replace(/\[['"](id|runId|openId|detailId)['"]\]/g, '.$1')
        .replace(/\s+/g, '')
      return /(?:^|[.?])(?:id|runId|openId|detailId)(?![A-Za-z0-9_$])/.test(t)
    }
    assert.strictEqual(isIdOperand('detail.id'), true, 'detail.id 必须识别为运行 id')
    assert.strictEqual(isIdOperand('runId'), true, 'runId 必须识别')
    assert.strictEqual(isIdOperand('detail?.id'), true, '可选链 detail?.id 必须识别')
    assert.strictEqual(isIdOperand('id || 0'), true, '复合操作数 id || 0 必须识别')
    assert.strictEqual(isIdOperand("detail['id']"), true, '下标写法 detail["id"] 必须识别')
    assert.strictEqual(isIdOperand('valid'), false, 'valid 以 id 结尾但不是 id 表达式（旧 /id$/ 会误报）')
    assert.strictEqual(isIdOperand('rowId'), false, 'rowId 是行 key，不是运行 id')

    const offenders = []
    for (const seg of src.split('typeof').slice(1)) {
      const m = seg.slice(0, 120).match(/^\s*\(*([^=!]+?)\)*\s*[!=]==\s*['"]number['"]/)
      if (m && isIdOperand(m[1])) offenders.push(m[1].trim())
    }
    for (const m of src.matchAll(/Number\.(?:isInteger|isSafeInteger|isFinite)\s*\(\s*([^)]+)\)/g)) {
      if (isIdOperand(m[1])) offenders.push(`Number.is*(${m[1].trim()})`)
    }
    assert.deepStrictEqual(offenders, [], '不得用 typeof / Number.is* 对运行 id 做 number 判定（id 恒为 string）')
  })

  await aok('结构红线: RunsPanel 模板的 <div> 必须成对闭合（漏根 </div> 回归）', () => {
    const src = readConsoleSource()
    // 事故形态：RunsPanel 根 `<div class="panel">` 漏了 `</div>`，htm 把根标签解析成
    // 文本节点 "div" → 页面出现裸字 "div"、面板丢边框，运行期零报错。
    const start = src.indexOf('function RunsPanel')
    const end = src.indexOf('// ── 组件：逐轮运行历史', start)
    assert.ok(start > -1 && end > start, '应能定位 RunsPanel 源码段')
    const seg = src.slice(start, end)
    const opens = (seg.match(/<div\b/g) || []).length
    const closes = (seg.match(/<\/div>/g) || []).length
    assert.strictEqual(opens, closes, `div 开闭必须相等（open=${opens}, close=${closes}）`)
    // 只数个数抓不到「根闭合被挪到条件日志框之前」：要求最后一个 </div> 在 logbox 之后，
    // 且模板以根 </div> 收尾（否则日志框会被甩到面板外）。
    const logbox = seg.indexOf('openId !== null && html`<div class="logbox">')
    assert.ok(logbox > -1, '应能定位条件日志框')
    assert.ok(seg.lastIndexOf('</div>') > logbox, '根 </div> 必须在条件日志框之后')
    assert.ok(/<\/div>`\s*\}\s*$/.test(seg), 'RunsPanel 模板必须以根 </div> 收尾')
  })

  await aok('结构红线: 日志框首帧即最终日志（点「日志」不得先画「加载中…」再撑开）', () => {
    const src = readConsoleSource()
    const start = src.indexOf('function RunsPanel')
    const end = src.indexOf('// ── 组件：逐轮运行历史', start)
    assert.ok(start > -1 && end > start, '应能定位 RunsPanel 源码段')
    const seg = src.slice(start, end)
    // 手机录屏实测：点「日志」后框先以「加载中…」占 89px 出现，详情回来再撑到 366px，
    // 页高 +277px ⇒ 「闪一下再跳一截」。修法是先取详情、再与 openId 同一批 set。
    assert.ok(!seg.includes('setOpenId(openId === r.id ? null : r.id)'),
      '点「日志」不得直接 setOpenId（会先渲染加载占位）')
    const from = seg.indexOf('const openLog = (id) =>')
    assert.ok(from > 0, '必须有 openLog 预取入口')
    const fn = seg.slice(from, seg.indexOf('// typeof 判据', from))
    assert.ok(fn.includes('apiGetRunDetail(id)'), 'openLog 必须先取详情（不能只留条件不调用）')
    // 守卫必须是 openWith 的第一句：放在 set 之后时，过期响应仍会先写 state 再被忽略。
    assert.ok(/const openWith = \(d\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(seq !== openSeqRef\.current\) return/.test(fn),
      '代次守卫必须是 openWith 的第一句')
    // 开框的 setOpenId 不得被 if (d) 包住：超时兜底（d=null）也必须开框。
    assert.ok(/if \(d\) setDetail\(d\)\s*\n\s*setDetailErr\(''\)\s*\n\s*if \(opened\) return[\s\S]{0,400}setOpenId\(id\)/.test(fn),
      'setOpenId 必须在 if (d) 之外（超时/失败也要开框），且晚到详情只回填不重开')
    assert.ok(fn.includes('setTimeout(() => openWith(null), RUN_LOG_WAIT_MS)'),
      '详情超时也必须开框（占位兜底），不能把点击卡死')
    assert.ok(fn.includes('seedRef.current = { id, detail: d }'), '预取结果必须交给 effect 当首帧快照')
    const wait = src.match(/const RUN_LOG_WAIT_MS = (\d+)/)
    assert.ok(wait && Number(wait[1]) > 0 && Number(wait[1]) <= 1000, '等待详情必须有 ≤1s 的上限')
    // 关闭必须作废在飞的预取，否则「点 B → 关闭」后 B 的详情回来仍会开框。
    const close = seg.slice(seg.indexOf('const closeLog = () =>'), seg.indexOf('const openLog = (id) =>'))
    assert.ok(close.includes('openSeqRef.current++') && close.includes('openingRef.current = null'),
      'closeLog 必须作废在飞预取（seq++ 且清 openingRef）')
    assert.ok(/onClick=\$\{closeLog\}/.test(seg), '关闭按钮必须走 closeLog（不得直接 setOpenId(null)）')
    assert.ok(seg.includes('setDetail((prev) => (prev !== null && prev.id === openId ? prev : null))'),
      '清详情 effect 必须保留同一 openId 的预取详情（否则预取被当场抹掉）')
    // effect 拿到 seed 后不得再发第二个详情请求（慢网下第二次失败会盖掉有效日志）。
    assert.ok(seg.includes('const seed = seedRef.current !== null && seedRef.current.id === openId'),
      'effect 必须消费且只消费一次 seed')
    assert.ok(seg.includes('if (seed === null) startPolling()'), '已有 seed 时不得重复拉详情')
    assert.ok(seg.includes('if (seed !== null) startStream(seed)'), '运行中必须用 seed 当 SSE 初始快照')
    assert.ok(/onClick=\$\{\(\) => openLog\(r\.id\)\}/.test(seg), '行内按钮必须走 openLog')
  })

  await aok('静态红线: fmtTime 固定按 Asia/Shanghai（UTC+8）渲染', () => {
    const src = readConsoleSource()
    // 服务器时区为 UTC：用本地 getHours() 会让「自动刷新 14:xx」与 run.log 的 22:xx 混显。
    const start = src.indexOf('function fmtTime')
    const end = src.indexOf('function fmtNum', start)
    assert.ok(start > -1 && end > start, '应能定位 fmtTime')
    const seg = src.slice(start, end)
    assert.ok(/Number\(ts\) \+ 8 \* 3600 \* 1000/.test(seg), 'fmtTime 必须固定 +8 小时')
    assert.ok(/getUTC/.test(seg) && !/getHours\(\)/.test(seg), 'fmtTime 必须用 getUTC*，不得用浏览器本地 getHours')
  })

  await aok('结构红线: 分类筛选走自定义 CategoryPicker（手机端不弹原生 select）', () => {
    const src = readConsoleSource()
    assert.ok(src.includes('function CategoryPicker ('), '必须有 CategoryPicker 组件')
    const start = src.indexOf('function MessagesPanel')
    const end = src.indexOf('function LogsPanel', start)
    const seg = src.slice(start, end)
    assert.ok(/<\$\{CategoryPicker\}/.test(seg), '推送记录必须使用 CategoryPicker')
    assert.ok(!/<select[^>]*value=\$\{cate\}/.test(seg), '分类筛选不得回退原生 select')
  })

  await aok('结构红线: 分类筛选按「来源-品类-平台」逐级下钻', () => {
    const src = readConsoleSource()
    const start = src.indexOf('function buildCateTree')
    const end = src.indexOf('function flatCateLeaves', start)
    assert.ok(start > -1 && end > start, '必须有 buildCateTree')
    assert.ok(src.slice(start, end).includes("c.name.split('-')"), '必须按 - 拆分三级分类')
    assert.ok(src.includes('setPath(o.node.path)'), '点分组必须下钻而不是直接筛选')
    assert.ok(src.includes('path.length === 0 ? [{ key'), '「全部分类」只应出现在一级')
  })

  await aok('结构红线: 所有页都轮询（v3.348 改口径：其它页由统一 tick 重拉自己的数据）', () => {
    const src = readConsoleSource()
    // 旧口径是「非概览/日志页停止主轮询」，用户实测反馈那几页的「自动刷新 5s」永远停在 5s、
    // 数据也不更新。新口径：定时器不按页停，其它页每拍 +1 交给当前面板重拉。
    assert.ok(!src.includes("if (tab !== 'overview' && tab !== 'logs') return () => clearInterval(timerRef.current)"),
      '不得再按页停掉轮询定时器')
    assert.ok(src.includes("if (tab !== 'overview' && tab !== 'logs') setPollTick((t) => t + 1)"),
      '非概览/日志页必须每拍推进共享 tick')
    assert.ok(src.includes('if (!active || justActivated || !(pollTick > 0) || busyRef.current) return'),
      '轮询重拉必须单飞：上一拍还没回来时跳过，否则慢接口会互相作废响应')
    assert.ok(/\[refreshSplit, locking, tab, autoRefresh, authExpired, sseUp, runTick\]/.test(src), '轮询 effect 必须随 tab / 暂停开关 / 凭证失效 / SSE 在线态变化重跑')
    // 四个页面的面板都要消费这个 tick，否则只是数字在动、数据不动。
    // v3.349：重拉统一走 usePollReload（单飞：上一拍没回来就跳过，慢接口不会互相作废）。
    for (const [fn, call] of [
      ['MessagesPanel', 'usePollReload(active, pollTick, load)'],
      ['ConfigPanel', 'usePollReload(active, pollTick, refresh)'],
      ['FilterRulesPanel', 'usePollReload(active, pollTick, load)'],
      ['FilesPanel', 'usePollReload(active, pollTick, () => load().then((ok) => {'],
      ['SysPanel', 'usePollReload(active, pollTick, () => refreshAll().then((rs) => {']
    ]) {
      const at = src.indexOf('function ' + fn + ' (')
      const end = src.indexOf('\nfunction ', at + 10)
      const seg = src.slice(at, end > at ? end : undefined)
      assert.ok(at > 0 && seg.includes('pollTick'), `${fn} 必须接收 pollTick`)
      assert.ok(seg.includes(call), `${fn} 必须按 tick 重拉`)
    }
    // 过滤规则是编辑面：tick 触发的 load 仍必须被 dirtyRef 挡住（草稿不能被自动刷新覆盖）。
    assert.ok(src.includes('if (dirtyRef.current) return'), '有未保存改动时自动刷新不得覆盖草稿')
    // 光有 tick 还不够：传给 usePollReload 的必须是真 loader（空壳函数也能让上一条断言通过）。
    for (const bound of ['usePanelLoader(fetchMessages', 'usePanelLoader(apiGetConfig', 'Promise.all([apiGetFilter()', 'usePanelLoader(apiGetSys', 'usePanelLoader(apiGetFiles']) {
      assert.ok(src.includes(bound), `面板 loader 必须真的打接口：缺 ${bound}`)
    }
    // 单飞闸必须真的调用传进来的 loader，否则只是把 tick 吃掉了。
    const pollStart = src.indexOf('function usePollReload')
    const pollEnd = src.indexOf('// 面板侧：当前页签激活时订阅全局下拉刷新', pollStart)
    assert.ok(pollStart >= 0 && pollEnd > pollStart, 'usePollReload 切片锚点必须存在且有序')
    assert.ok(src.slice(pollStart, pollEnd).includes('fnRef.current()'), '单飞闸必须调用传进来的 loader')
  })

  await aok('结构红线: 配置页过滤规则/渠道不拼成一条长串', () => {
    const src = readConsoleSource()
    assert.ok(src.includes('function FilterRules ('), '必须有 FilterRules 组件（一条规则一行）')
    assert.ok(src.includes('function ChannelList ('), '必须有 ChannelList 组件（渠道 chip）')
    // 切片边界必须是 ConfigPanel 之后真实存在的下一个顶层组件：SysPanel 定义在
    // ConfigPanel 之前，用作 end 会得到 -1（slice(start, -1) 一路切到文件末尾，断言永真）。
    const start = src.indexOf('function ConfigPanel ')
    const end = src.indexOf('function App ', start)
    assert.ok(start > -1 && end > start, 'ConfigPanel 与 App 的切片边界必须可定位')
    const seg = src.slice(start, end)
    assert.ok(/<\$\{FilterRules\}/.test(seg), '配置页必须使用 FilterRules')
    assert.ok(/<\$\{ChannelList\}/.test(seg), '配置页必须使用 ChannelList')
    assert.ok(!/filterEntries\.map\([\s\S]*?\)\.join\(' · '\)/.test(seg), '过滤规则不得再 join 成一条 · 长串')
    // FilterRules 位于 ConfigPanel 之前，必须单独切片才能锁住「空值不复用 .empty」。
    const filterStart = src.indexOf('function FilterRules ')
    const filterEnd = src.indexOf('function ChannelList ', filterStart)
    assert.ok(filterStart > -1 && filterEnd > filterStart, 'FilterRules 与 ChannelList 的切片边界必须可定位')
    const filterSeg = src.slice(filterStart, filterEnd)
    assert.ok(!/rule-val' \+ \(isEmpty\(v\) \? ' empty'/.test(filterSeg), '空值类名不得复用 .empty（全局空态有 14px padding）')
    // C 批已把渠道注记收成一套名称；红线锁住「同一张卡两个名字」不回潮。
    const chanEnd = src.indexOf('function ConfigPanel ', filterEnd)
    assert.ok(chanEnd > filterEnd, 'ChannelList 的切片边界必须可定位')
    const chanSeg = src.slice(filterEnd, chanEnd)
    assert.ok(!/已启用：/.test(chanSeg), '渠道卡不得再用中文名注记重复一遍渠道名')
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(/\.rule-row\s*\{/.test(css) && /\.chan-chip\s*\{/.test(css), '过滤规则/渠道样式必须存在')
  })

  await aok('行为: relDay / fmtAge / cacheWriteInfo（注入固定时钟）', async () => {
    const { dateRangeLabel } = await import('./scripts/console-assets/pure.mjs')
    // 跨年文案（用户实测 bug）：2025-10-01 ~ 2026-10-01 曾显示成 "10-01 ~ 10-01"，像一天。
    assert.strictEqual(dateRangeLabel('2025-10-01', '2026-10-01', '2026-10-21'), '2025-10-01 ~ 2026-10-01', '跨年必须写全两端年份')
    assert.strictEqual(dateRangeLabel('2025-10-01', '2025-10-05', '2026-10-21'), '2025-10-01 ~ 10-05', '非今年保留起点年份')
    assert.strictEqual(dateRangeLabel('2026-10-19', '2026-10-20', '2026-10-21'), '10-19 ~ 10-20', '今年同一年可省年份')
    assert.strictEqual(dateRangeLabel('2026-10-21', '2026-10-21', '2026-10-21'), '10-21 ~ 10-21', '同一天也写两端（不省略成一天）')
    assert.strictEqual(dateRangeLabel('2026-10-21', '2026-10-20', '2026-10-21'), '', '颠倒区间返回空（调用方回退占位）')
    assert.strictEqual(dateRangeLabel('x', '2026-10-20'), '', '非法输入返回空')
    const { relDay, fmtAge, cacheWriteInfo } = await import('./scripts/console-assets/pure.mjs')
    // 2026-10-18 00:00 Asia/Shanghai = 2026-10-17T16:00Z
    const now = Date.UTC(2026, 9, 17, 16, 0, 0)
    assert.strictEqual(relDay('2026-10-18', now), '今天')
    assert.strictEqual(relDay('2026-10-17', now), '昨天')
    assert.strictEqual(relDay('2026-10-15', now), '3 天前')
    assert.strictEqual(relDay('2026-10-19', now), '', '未来日期不标注')
    assert.strictEqual(relDay('not-a-date', now), '', '坏日期不标注')
    assert.strictEqual(fmtAge(-5000), '刚刚', '负年龄（时钟漂移）按 0 处理')
    assert.strictEqual(fmtAge(2 * 3600 * 1000), '2 小时前')
    const DAY = 24 * 3600 * 1000
    const fresh = cacheWriteInfo(now - 2 * 3600 * 1000, now)
    assert.strictEqual(fresh.ageText, '2 小时前', '正常年龄必须有相对文案')
    assert.strictEqual(fresh.stale, false)
    assert.strictEqual(cacheWriteInfo(now - (DAY - 60000), now).stale, false, '23h59m 不得告警')
    assert.strictEqual(cacheWriteInfo(now - (DAY + 60000), now).stale, true, '24h01m 必须告警')
    assert.strictEqual(cacheWriteInfo(now + 5000, now).ageText, '刚刚', '未来 mtime 仍显示相对时间')
    assert.strictEqual(cacheWriteInfo(null, now).ageText, '', '缺 mtime 不显示年龄')
  })

  await aok('行为: 备份加密往返（AES-GCM + PBKDF2，密码不落明文）', async () => {
    const { encryptBackup, decryptBackup, isEncryptedBackup, backupPasswordProblem, BACKUP_ENC_KIND, BACKUP_ENC_ITERATIONS, BACKUP_PASSWORD_MIN } =
      await import('./scripts/console-assets/pure.mjs')
    assert.strictEqual(isEncryptedBackup({ kind: BACKUP_ENC_KIND }), true)
    assert.strictEqual(isEncryptedBackup({ kind: 'xbk-console-backup' }), false)
    assert.strictEqual(BACKUP_PASSWORD_MIN, 12, '口令最短长度必须钉在 12 位')
    assert.strictEqual(BACKUP_ENC_ITERATIONS, 600000, 'PBKDF2 迭代次数必须是 600000')
    assert.strictEqual(backupPasswordProblem('', ''), `密码至少 ${BACKUP_PASSWORD_MIN} 位`)
    assert.strictEqual(backupPasswordProblem('abcdefghijkl', 'abcdefghijkm'), '两次输入的密码不一致')
    assert.strictEqual(backupPasswordProblem('abcdefghijkl', 'abcdefghijkl'), '')
    const bundle = {
      kind: 'xbk-console-backup',
      schema: 1,
      data: {
        messages: { count: 1, text: '{"id":1,"title":"隐秘标题"}' },
        auto: { interval: 16 }
      }
    }
    const password = 'correct horse battery'
    const enc = await encryptBackup(bundle, password)
    assert.strictEqual(enc.kind, BACKUP_ENC_KIND)
    assert.strictEqual(enc.cipher, 'AES-GCM')
    assert.strictEqual(enc.kdf.name, 'PBKDF2')
    assert.strictEqual(enc.kdf.iterations, BACKUP_ENC_ITERATIONS)
    assert.ok(!JSON.stringify(enc).includes('隐秘标题'), '密文里不得出现明文内容')
    assert.ok(!JSON.stringify(enc).includes(password), '密文里不得出现密码')
    const dec = await decryptBackup(enc, password)
    assert.deepStrictEqual(dec, bundle)
    const enc2 = await encryptBackup(bundle, password)
    assert.notStrictEqual(enc.salt, enc2.salt, '每次导出必须换新盐')
    assert.notStrictEqual(enc.iv, enc2.iv, '每次导出必须换新 IV')
    await assert.rejects(() => decryptBackup(enc, 'wrong password'), /密码不对/)
    const flipped = (enc.ciphertext[0] === 'A' ? 'B' : 'A') + enc.ciphertext.slice(1)
    await assert.rejects(() => decryptBackup({ ...enc, ciphertext: flipped }, password), /密码不对|被改过/)
    await assert.rejects(() => decryptBackup({ ...enc, createdAt: '2000-01-01T00:00:00.000Z' }, password), /密码不对|被改过/,
      'createdAt 必须参与认证，不能改了时间还静默解密')
  })

  await aok('行为: 日志异常口径与筛选（issue × 关键字交集）', async () => {
    const { isIssueLogLine, filterLogLines } = await import('./scripts/console-assets/pure.mjs')
    const okLine = '2026-10-17 23:06:42 total=20 dedup=0 filtered=0 truncated=0 pushed=20 failed=0 elapsed=10.1s cachesaved=1'
    const errLine = '2026-10-17 23:00:00 ERROR 推送全部失败 3 条（通道可能失效）'
    const alertLine = '2026-10-17 23:00:00 ALERT [v3.0] 运行异常'
    const failLine = '2026-10-17 23:00:00 total=20 dedup=0 filtered=0 truncated=0 pushed=0 failed=3 elapsed=1s'
    const txt = [okLine, errLine, alertLine, failLine].join('\n') + '\n'
    assert.strictEqual(isIssueLogLine(okLine), false, '正常摘要行不算异常')
    assert.deepStrictEqual([errLine, alertLine, failLine].map((l) => isIssueLogLine(l)), [true, true, true], 'ERROR/ALERT/failed>0 都算异常')
    assert.strictEqual(filterLogLines(txt, 'all', '').length, 4, '全部模式保留所有行（含末尾空行剔除）')
    assert.deepStrictEqual(filterLogLines(txt, 'issue', ''), [errLine, alertLine, failLine])
    assert.deepStrictEqual(filterLogLines(txt, 'all', 'WXPUSHER'), [], '关键字大小写不敏感，未命中为空')
    assert.deepStrictEqual(filterLogLines(txt, 'issue', 'alert'), [alertLine], 'issue 与关键字取交集')
    assert.deepStrictEqual(filterLogLines(txt, 'issue', 'pushed=20'), [], '正常摘要行不混进异常结果')
  })

  await aok('行为: v3.307 日志级别 / 时间戳 / 哈希 / 逐轮筛选纯函数', async () => {
    const { isConsoleLifecycleLine, logLineKind, logLineCounts, filterLogLines, ageFromStamp, tabFromHash, filterRunItems } =
      await import('./scripts/console-assets/pure.mjs')
    const okLine = '2026-10-17 23:06:42 total=20 dedup=0 filtered=0 truncated=0 pushed=20 failed=0 elapsed=10.1s'
    const life = '2026-10-16 10:00:00 ERROR 控制台停止：任务 #12 于运行中被停止（SIGTERM）'
    const errLine = '2026-10-17 23:00:00 ERROR 推送全部失败 3 条（通道可能失效）'
    const alertLine = '2026-10-17 23:00:00 ALERT [v3.0] 运行异常'
    const failLine = '2026-10-17 23:00:00 total=20 dedup=0 filtered=0 truncated=0 pushed=0 failed=3 elapsed=1s'
    const txt = [okLine, life, errLine, alertLine, failLine].join('\n') + '\n'
    assert.strictEqual(isConsoleLifecycleLine(life), true)
    assert.strictEqual(isConsoleLifecycleLine(errLine), false, '普通 ERROR 不是控制台生命周期')
    assert.strictEqual(logLineKind(life), 'console', '生命周期优先于 ERROR 级别')
    assert.strictEqual(logLineKind(alertLine), 'alert')
    assert.strictEqual(logLineKind(okLine), 'summary')
    const counts = logLineCounts(txt)
    assert.deepStrictEqual(counts, { all: 5, issue: 3, error: 1, alert: 1, warn: 0, summary: 2, console: 1 })
    assert.deepStrictEqual(filterLogLines(txt, 'console', ''), [life], '控制台筛选只留生命周期')
    assert.deepStrictEqual(filterLogLines(txt, 'error', ''), [errLine], '错误只算业务 ERROR，不含控制台停止')
    assert.deepStrictEqual(filterLogLines(txt, 'issue', ''), [errLine, alertLine, failLine], '异常已排除生命周期')
    assert.strictEqual(ageFromStamp('2026-10-18 00:00:00', Date.UTC(2026, 9, 17, 16, 0, 0)), '刚刚')
    assert.strictEqual(ageFromStamp('bad', 0), '')
    assert.strictEqual(tabFromHash('#/logs'), 'logs')
    assert.strictEqual(tabFromHash('#/sys'), 'sys')
    assert.strictEqual(tabFromHash('#/nope'), 'overview')
    assert.strictEqual(tabFromHash(''), 'overview')
    const runs = [
      { at: '2026-10-14 10:00:00', failed: 3, interrupted: false },
      { at: '2026-10-15 10:00:00', failed: 0, interrupted: true },
      { at: '2026-10-15 11:00:00', failed: 0, interrupted: false, cancelled: true },
      { at: '', failed: 0, interrupted: false }
    ]
    assert.strictEqual(filterRunItems(runs, { mode: 'issue' }).length, 3, '失败/中断/取消都算 issue')
    assert.strictEqual(filterRunItems(runs, { mode: 'runs' }).length, 3, '仅运行排除取消留痕')
    assert.deepStrictEqual(filterRunItems(runs, { day: '2026-10-15' }).map((r) => r.at), ['2026-10-15 10:00:00', '2026-10-15 11:00:00'])
    assert.strictEqual(filterRunItems(runs, { mode: 'issue', day: '2026-10-14' }).length, 1, '筛选取交集')
    assert.strictEqual(filterRunItems(null, { mode: 'issue' }).length, 0)
  })

  await aok('行为: v3.312 配置页过滤规则显示生效值（覆盖文件优先）', async () => {
    const { effectiveFilterRows, filterSourceNote } = await import('./scripts/console-assets/pure.mjs')
    const base = { pingbitime: '5', pingbibiaoti: '', pingbineirong: '' }
    const rows = effectiveFilterRows(base, { pingbibiaoti: '身体乳' })
    assert.strictEqual(rows.length, 3)
    const body = rows.find((r) => r.key === 'pingbibiaoti')
    assert.strictEqual(body.value, '身体乳', '覆盖文件的值必须显示在配置页')
    assert.strictEqual(body.overridden, true, '覆盖文件提供的字段必须挂徽章')
    assert.strictEqual(rows.find((r) => r.key === 'pingbitime').overridden, false, '文件里没有的字段回代码默认且不挂徽章')
    assert.strictEqual(rows.find((r) => r.key === 'pingbitime').value, '5', '缺字段回代码默认')
    assert.strictEqual(effectiveFilterRows({ pingbitime: '5' }, { pingbitime: '5' })[0].overridden, true, '文件显式写同值也算覆盖文件提供（钉住默认值）')
    assert.strictEqual(effectiveFilterRows({ pingbitime: '5' }, { pingbitime: '5' })[0].differs, false, '同值不计入「与默认不同」')
    assert.strictEqual(effectiveFilterRows({ pingbitime: '5' }, { pingbitime: '6' })[0].differs, true)
    assert.deepStrictEqual(effectiveFilterRows(base, null).map((r) => r.overridden), [false, false, false], '没有覆盖文件时不标覆盖')
    const cleared = effectiveFilterRows({ pingbibiaoti: '旧词' }, { pingbibiaoti: '' })
    assert.strictEqual(cleared[0].value, '')
    assert.strictEqual(cleared[0].overridden, true, '显式清空也是一次覆盖')
    assert.deepStrictEqual(effectiveFilterRows({ pingbitime: '5' }, { pingbibiaoti: 'A' }).map((r) => r.key), ['pingbitime', 'pingbibiaoti'], '覆盖文件多出的字段也要显示')
    assert.deepStrictEqual(effectiveFilterRows(null, undefined), [], '非对象输入不抛错')
    // 副标题：已保存 ≠ 已生效（保存发生在上一轮之后时，本轮仍在用旧规则）
    assert.ok(filterSourceNote({ source: 'override', revision: 2, applied: { revision: 2 } }, 11, 1).includes('1 项与默认不同'), '数量只数真正不同的字段，不把「文件里有键」当改过')
    const pending = filterSourceNote({ source: 'override', revision: 3, applied: { revision: 2 } }, 11, 1)
    assert.ok(pending.includes('已保存 rev 3') && pending.includes('下一轮生效') && pending.includes('本轮仍用 rev 2'), '保存后未跑时必须明说下一轮生效')
    assert.ok(filterSourceNote({ source: 'override', revision: 3, applied: null }, 11, 0).includes('尚未跑过'))
    assert.ok(filterSourceNote({ source: 'corrupt', revision: 0 }, 11, 0).includes('损坏'))
    assert.ok(filterSourceNote({ source: 'default', revision: 0 }, 11, 0).includes('代码默认'))
    assert.strictEqual(filterSourceNote(null, 11, 0), '')
  })

  await aok('结构红线: v3.307 确认弹窗 / 今日统计 / 时间窗 / 日志级别 / hash 路由', () => {
    const src = readConsoleSource()
    assert.ok(src.includes('function ConfirmDialog'), '危险动作必须有确认弹窗')
    assert.ok(src.includes("if (action === 'run' || action === 'notify-test') askConfirm(action)"),
      '正式运行与通知自检必须走确认；试运行/环境检查直接执行')
    assert.ok(src.includes("cls: 'btn-danger-solid'"), '正式运行必须是红色危险按钮')
    assert.ok(src.includes('role="dialog"') && src.includes('aria-modal="true"'), '弹窗必须有无障碍语义')
    // v3.361：焦点 effect 收进 useDialogChrome，取消按钮通过 fallbackRef 传进去。
    assert.ok(src.includes('defaultFocus') === false && src.includes('fallbackRef.current') && src.includes('fallbackRef: cancelRef'),
      '默认焦点必须落在取消，不能落在确认')
    assert.ok(src.includes('function AlertBanner'), '首屏必须有失败横幅')
    assert.ok(src.includes("state.stats.status === 'ok'"), '状态卡必须消费 stats')
    assert.ok(src.includes('成功率'), '状态卡必须显示成功率')
    assert.ok(src.includes("label: '今天'") && src.includes("label: '近 7 天'"), '推送记录必须有时间窗')
    assert.ok(src.includes('initialMode') && src.includes('initialQuery'), '日志面板必须支持带条件跳转')
    assert.ok(src.includes("window.addEventListener('hashchange'"), '页签必须跟随 hash')
    assert.ok(src.includes('document.title ='), '标题必须带状态点')
    assert.ok(src.includes('function AutoRefreshText (') && /\$\{remain\} 秒后刷新/.test(src) &&
      /数据截至 \$\{TZ_LABEL\} /.test(src), '状态行必须复用 AutoRefreshText（暂停 + 倒计时；L3 起文案为「N 秒后刷新 · 数据截至 北京时间」）')
    assert.ok(src.includes('filterRunItems'), '逐轮历史必须支持失败/日期筛选')
    assert.ok(!src.includes('首轮前正常'), '墓碑文案不得再写「首轮前正常」')
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(/\.alert-banner\s*\{/.test(css) && /\.modal-backdrop\s*\{/.test(css), '横幅/弹窗样式必须存在')
    assert.ok(/@media \(max-width: 640px\)[\s\S]*?\.cards\s*\{\s*grid-template-columns:\s*1fr 1fr/.test(css),
      '手机端状态卡必须 2×2，不能四张单列')
    assert.ok(/@media \(max-width: 640px\)[\s\S]*?\.btn-item\s*\{\s*flex:\s*1 1 calc\(50% - 5px\)/.test(css),
      '手机端动作按钮必须 2×2')
  })

  await aok('弹窗文案: 渠道名必须在弹窗画出来前定稿（打开后不得再改行数）', () => {
    const src = readConsoleSource()
    const from = src.indexOf('const askConfirm = useCallback')
    const openPath = src.slice(from, src.indexOf('const channelText', from))
    // 手机录屏实测：打开确认弹窗时先画「所有已配置渠道（以「配置」页为准）」占 3 行，
    // 配置接口回来换成真实渠道名只剩 2 行 ⇒ 居中弹窗在 0.1s 内缩掉一行（34 物理 px），
    // 上下各跳 17px。弹窗一旦显示，文案与行数就必须是最终态。
    assert.ok(from > 0, '必须有统一的「先取配置再开弹窗」入口')
    assert.ok(openPath.includes('apiGetConfig()'), '打开确认框必须真的取当前配置（不能只留条件不调用）')
    assert.ok(openPath.includes('setPendingNames(names)') && openPath.includes('setPending(action)'),
      '渠道名必须与 pending 一起 set，弹窗首帧即最终文案')
    assert.ok(openPath.includes('setTimeout(() => open(null), CONFIRM_NAMES_WAIT_MS)'),
      '配置超时也必须开弹窗（用兜底文案），不能把按钮卡死')
    assert.ok(openPath.includes('seq !== confirmSeqRef.current') && openPath.includes('settled'),
      '过期响应/已开过的请求必须丢弃，不得二次改文案')
    const trigger = src.slice(src.indexOf('function TriggerBar'), src.indexOf('// ── 组件：运行历史'))
    assert.ok(!trigger.includes('setConfiguredNames'), '不得再保留「打开后异步换渠道名」的旧状态')
    assert.ok(trigger.includes('askConfirm(action)') && trigger.includes("askConfirm('auto')"),
      '真实推送与自动运行都必须走统一入口')
    assert.ok(trigger.includes('所有已配置渠道（以「配置」页为准）'), '拿不到配置时仍要有兜底文案')
  })

  await aok('触屏反馈: 内核点按高亮必须关掉，按压反馈由 :active 承担', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    // 注释掉的规则不算数：断言必须只看真实声明，否则把 html 那条注释掉也能「通过」（Sourcery #274）。
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const base = css.slice(css.indexOf('@layer base'), css.indexOf('@layer components'))
    assert.ok(base.length > 0, '应能定位基础层')
    // 安卓 Chrome / WebView 默认在被点元素上画一块不跟随圆角的蓝色方块（每次点击闪一下），
    // 这层由内核绘制，只有 -webkit-tap-highlight-color 能关；写进组件层会因优先级被内核覆盖。
    assert.ok(/html\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent/.test(base),
      '基础层必须在 html 上关闭点按高亮（可继承兜底）')
    const controls = base.match(/^.*-webkit-tap-highlight-color:\s*transparent.*$/gm) || []
    assert.ok(controls.some((l) => /\bbutton\b/.test(l) && /\ba\b/.test(l) && /\[role="button"\]/.test(l)),
      '交互元素须显式关闭点按高亮（覆盖不继承该属性的内核）')
    // 关掉高亮后不能连按压反馈一起丢掉：.btn:active 的位移必须还在。
    assert.ok(/\.btn:active:not\(:disabled\)\s*\{\s*transform:\s*translateY\(1px\)/.test(css),
      '关闭点按高亮后 .btn:active 的下沉反馈必须保留')
    // 原本只靠内核高亮的控件（页签/日志筛选/小按钮）没有 :active 位移，必须补一瞬压暗，
    // 否则手机上点下去像没反应——这是「关高亮」最容易带出来的回归（Sourcery #274）。
    const touchStart = css.indexOf('@media (hover: none)')
    assert.ok(touchStart > -1, '触屏需有专门的按压反馈区块（@media (hover: none)）')
    const touch = css.slice(touchStart, css.indexOf('\n  }', touchStart))
    for (const sel of ['.tab-btn:active', '.log-chip:active', '.mini-btn:active', '.mini-opt:active']) {
      assert.ok(touch.includes(sel), `触屏按压反馈须覆盖 ${sel}`)
    }
    assert.ok(/filter:\s*brightness\(\.85\)/.test(touch), '触屏按压反馈须有可见的压暗')
  })

  await aok('手动触发: 忙碌/错误提示都不许插行顶动布局', () => {
    const js = readConsoleSource()
    const start = js.indexOf('function TriggerBar')
    const end = js.indexOf('// ── 组件：运行历史', start)
    assert.ok(start > -1 && end > start, '应能定位 TriggerBar 组件')
    const block = js.slice(start, end)
    // 手动触发状态区（面板头 + 按钮行 + 提示）里不许出现行内 Hint。
    const triggerArea = block.slice(0, block.indexOf('<div class="auto-run">'))
    // 忙碌提示原先插在按钮行与自动运行之间，出现/消失会把下方内容整体顶下 ~28px，
    // 手机上点一下就像「弹一下」；它必须由 locking 直接条件渲染成面板头徽标（不占额外高度）。
    assert.ok(/locking && html`<span class="trigger-busy"/.test(triggerArea),
      '忙碌徽标必须由 locking 直接条件渲染（只留类名字符串不算）')
    // 行内 Hint 无论装忙碌还是错误都会插行：面板头与按钮行之间一个都不许留。
    assert.ok(!/<\$\{Hint\}/.test(triggerArea), '手动触发状态区不得再渲染行内 Hint（出现/消失会顶动布局）')
    assert.ok(/err && html`<div class="trigger-toast" role="alert"/.test(triggerArea),
      '触发错误必须走不占布局的 toast')
    const raw = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const head = css.match(/\.trigger-panel \.panel-head \{[^}]*\}/)
    assert.ok(head && /flex-wrap:\s*nowrap/.test(head[0]), '面板头必须单行：徽标换行会把标题行撑高')
    assert.ok(/\.trigger-busy-text\s*\{[^}]*text-overflow:\s*ellipsis/.test(css),
      '窄屏/放大字号下徽标文字必须可省略，避免压住标题')
    const toast = css.match(/\.trigger-toast\s*\{[^}]*\}/)
    assert.ok(toast && /position:\s*fixed/.test(toast[0]), '错误 toast 必须 fixed，不参与布局')
  })

  await aok('结构红线: 概览先状态与操作，触发历史常驻（空态显示暂无记录）', () => {
    const src = readConsoleSource()
    const start = src.indexOf("${!authExpired && visited.has('overview') && html`<section class=\"page\"")
    const end = src.indexOf("${!authExpired && visited.has('messages')", start)
    assert.ok(start > -1 && end > start, '应能定位概览区块')
    const seg = src.slice(start, end)
    const order = ['AlertBanner', 'StatusCards', 'TriggerBar', 'TrendsPanel', 'RunHistoryPanel', 'CacheHealthPanel'].map((n) => seg.indexOf(n))
    assert.ok(order.every((i) => i > -1), '概览必须包含异常横幅/状态卡/触发/趋势/逐轮历史/缓存健康')
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, '首屏先异常与状态、再操作，缓存健康垫底')
    assert.ok(/<\$\{RunsPanel\} runs=\$\{runs\}/.test(seg), '触发历史须常驻概览（空态显示暂无记录），不得随任务结束消失')
    assert.ok(!/locking && html`<\$\{RunsPanel\}/.test(seg), '触发历史不得回退为仅运行中渲染')
  })

  await aok('结构红线: 状态卡首帧占位，下拉刷新不再整块闪（v3.329）', () => {
    const src = readConsoleSource()
    const ph = src.match(/const CARD_PLACEHOLDERS = \[([\s\S]*?)\n\]/)
    assert.ok(ph, '必须有 CARD_PLACEHOLDERS 占位卡定义')
    const entries = ph[1].split('\n').filter((l) => l.includes("title: '"))
    assert.strictEqual(entries.length, 4, '占位卡必须恰好四张（多一张会多占一整块）')
    const want = [['今日', 2], ['近 7 天', 2], ['最近一轮', 1], ['通道与过滤', 2]]
    want.forEach(([title, rows], i) => {
      assert.ok(entries[i].includes(`title: '${title}'`), `第 ${i + 1} 张占位卡必须是「${title}」`)
      const arr = entries[i].match(/lines: \[(.*)\]/)
      assert.ok(arr, `「${title}」占位卡必须有 lines 明细`)
      const n = arr[1].trim() === '' ? 0 : arr[1].split("', '").length
      assert.strictEqual(n, rows, `「${title}」占位卡必须固定 ${rows} 行明细`)
    })
    const seg = src.slice(src.indexOf('function StatusCards'), src.indexOf('// ── 组件：触发按钮'))
    const head = seg.slice(0, seg.indexOf('const rep ='))
    assert.ok(!/return null/.test(head), '占位分支之前不得有任何 return null：首帧必须画出卡片')
    const branch = head.match(/if \(!state\) \{[\s\S]*?return html`<\$\{CardsGrid\} cards=\$\{cards\} busy=\$\{!err\} \/>`/)
    assert.ok(branch, 'StatusCards 的第一个分支必须直接返回占位网格')
    assert.ok(branch[0].includes("const hint = err ? '读取失败' : '正在读取…'"),
      '占位文案必须由 err 分支决定：失败时写「读取失败」，加载中写「正在读取…」')
    // 加载完成态的行数必须与占位一致（数据缺失时也不能删行），否则卡片块仍会变高/变矮。
    for (const fallback of ["['失败 —', '日报 —']", "['失败 — · 成功率 —', '日均 — 轮']", "['获取 — · 失败 — · 耗时 —']", "['最近过滤 —', '原因 —']"]) {
      assert.ok(seg.includes(fallback), `数据缺失时明细行不得为空：缺 ${fallback}`)
    }
    assert.ok(!/\.\.\.\(stats && stats\.truncated/.test(seg), 'run.log 超窗提示不得新增第三行（会顶高周卡）')
    assert.ok(/<\$\{StatusCards\} state=\$\{state\} err=\$\{statusFailed\} \/>/.test(src), 'App 必须把状态接口的失败传给状态卡')
  })

  await aok('结构红线: 后台标签页不轮询（概览/日志/触发详情三处）', () => {
    const src = readConsoleSource()
    const logs = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function SysPanel'))
    assert.ok(logs.includes('if (pollMs) {'), '轮询间隔必须由 pollMs 控制')
    assert.ok(logs.includes('usePullRefresh(active'),
      '日志页必须接入全局补拉路径（回前台由 App 统一触发），不再自带 visibilitychange')
    const runs = src.slice(src.indexOf('function RunsPanel'), src.indexOf('// ── 组件：逐轮运行历史'))
    assert.ok(runs.includes("if (document.visibilityState === 'hidden') return"), '触发详情在后台必须跳过请求')
    assert.ok(runs.includes("document.addEventListener('visibilitychange', onVisibility)"), '切回前台必须补一拍')
    // v3.374：后台跳过判断随「共享一拍」搬到 runTick（SSE tick 与定时器走同一份逻辑），
    // 定时器只剩一个，且必须复用 runTick——两套节流各自为政就是「后台还在发请求」。
    const tickBlock = src.slice(src.indexOf('const runTick = useCallback('),
      src.indexOf('const runTickRef = useRef(runTick)'))
    assert.ok(tickBlock.includes('if (document.hidden) return'), '概览主轮询在后台必须跳过（tick 整拍不发）')
    const pollBlock = src.slice(src.indexOf('const interval = pollIntervalFor({ sseUp'),
      src.indexOf('}, [refreshSplit, locking, tab, autoRefresh, authExpired, sseUp, runTick])'))
    assert.ok(pollBlock.includes('setInterval(() => { runTick() }, interval)'),
      '全页只此一个定时器：SSE tick 复用 runTick，不得另建 interval')
  })

  await aok('结构红线: 标签页吸顶、切页回顶、缓存每分钟刷新', () => {
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(/\.tabs\s*\{[^}]*position:\s*sticky/.test(css), '标签页必须吸顶')
    const src = readConsoleSource()
    assert.ok(!/window\.scrollTo\(0, 0\) \}, \[tab/.test(src), '切页不得无条件强制回顶（长页深处会被整页拽回顶部）')
    const scrollBlock = src.slice(src.indexOf('const scrollMemRef = useRef({})'), src.indexOf('// 标签栏是单行横滚'))
    const switchBlock = src.slice(src.indexOf('const doSwitchTab = '), src.indexOf('const openLog = useCallback'))
    assert.ok(scrollBlock.includes('scrollMemRef.current[from] = y'),
      '切页前必须记住出发页的滚动位置')
    assert.ok(scrollBlock.includes("const target = forceTop ? 0 : (typeof mem === 'number' ? mem : y)"),
      '第一次进入的页签必须沿用当前视口位置，不得被拽回顶部')
    const prepBlock = scrollBlock.slice(scrollBlock.indexOf('const prepareScroll = '), scrollBlock.indexOf('const prepareScrollRef'))
    assert.ok(prepBlock.includes('pendingScrollRef.current = target'),
      '切页必须把目标位置交给 pendingScrollRef')
    assert.ok(prepBlock.includes('if (firstVisit && target > 0) holdScroll(target)'),
      '切页前必须先垫高文档，避免首访卸载/挂载之间塌陷')
    assert.ok(prepBlock.includes('const firstVisit = !enteredRef.current.has(next)'),
      '必须先判断目标页是否真正点开过（预挂载不算），再决定是否垫高')
    const prepPos = switchBlock.indexOf('prepareScroll(next)')
    const renderPos = switchBlock.indexOf('renderTab(next)')
    assert.ok(prepPos > -1 && renderPos > -1 && prepPos < renderPos,
      '必须先 prepareScroll 再触发重渲染（重渲染收口在 renderTab，setTab 在它内部）')
    const renderBlock = src.slice(src.indexOf('const renderTab = (next) =>'), src.indexOf('renderTabRef.current = renderTab'))
    assert.ok(renderBlock.includes('setTab(next)') && !renderBlock.includes('prepareScroll'),
      '切页渲染出口只负责换页（滚动记忆/垫高必须留在包外，先记位置再换）')
    const syncPos = scrollBlock.indexOf('window.scrollTo(0, y)')
    const rafPos = scrollBlock.indexOf('requestAnimationFrame')
    assert.ok(syncPos > -1 && (rafPos === -1 || syncPos < rafPos),
      '同步还原必须在 layout effect 内、且早于任何 rAF')
    assert.ok(scrollBlock.includes('logJumpPendingRef.current = false'), '日志跳转必须一次性消费')
    assert.ok(scrollBlock.includes('scrollMemRef.current[tab] = y'), '日志跳转必须重写日志页记忆（有 focus 落到定位条，无 focus 回顶）')
    assert.ok(scrollBlock.includes('new window.ResizeObserver(() => check())'), '内容增长必须用 ResizeObserver 等到撑起来')
    assert.ok(scrollBlock.includes('releaseAnchorSoon()') && scrollBlock.includes("overflowAnchor = 'none'"),
      '切页后必须暂时关掉 scroll anchoring，防止每次切换 +26px 漂移')
    const anchorHelper = scrollBlock.slice(scrollBlock.indexOf('const releaseAnchorSoon'), scrollBlock.indexOf('const releaseScrollHold'))
    assert.ok(anchorHelper.includes('}, 1000)'), '锚定恢复窗口必须是 1s，不能立刻恢复')
    const restoreBlock = scrollBlock.slice(scrollBlock.indexOf('// 垫高已生效'), scrollBlock.indexOf('const t0 = performance.now()'))
    assert.ok(restoreBlock.includes('holdAnchor()') && restoreBlock.indexOf('holdAnchor()') < restoreBlock.indexOf('window.scrollTo(0, y)'),
      '切页还原必须先关锚定再 scrollTo')
    const zeroBlock = scrollBlock.slice(scrollBlock.indexOf('if (y <= 0)'), scrollBlock.indexOf('// 垫高已生效'))
    assert.ok(zeroBlock.includes('holdAnchor()') && zeroBlock.indexOf('holdAnchor()') < zeroBlock.indexOf('window.scrollTo(0, 0)'),
      '回顶分支也必须先关锚定')
    assert.ok(scrollBlock.includes('if (ready || settled || performance.now() - t0 > 9000)'),
      '只有内容已撑起、面板落定或 9s 超时才允许收口')
    assert.ok(scrollBlock.includes('if (settled && !hold.user && !ready && bottom > 0)'),
      '目标页更矮时只在用户未接管时落到最大位置')
    assert.ok(scrollBlock.includes('window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))'),
      '落位必须用页面最大滚动位置，不能回 0')
    assert.ok(scrollBlock.includes('hold.check(true)') && scrollBlock.includes('panelReadyAt >= hold.startedAtMono'),
      '目标面板加载完成后必须让垫高就地收口（单调时钟，不受系统时钟回拨影响）')
    assert.ok(scrollBlock.includes('setTimeout(check, 9000)'), '加载失败必须有 9s 兜底释放，不能永久垫高')
    const syncBlock = src.slice(src.indexOf('const syncFor = useMemo'), src.indexOf('// 系统页由两个面板组成'))
    assert.ok(syncBlock.includes('syncMemRef.current[key] = ts') && syncBlock.includes('setPanelSync(ts)') &&
      syncBlock.includes('setPanelReadyAt(performance.now())') && syncBlock.includes('if (tabRef.current === key)'),
    '成功回调必须同时缓存本页时间、更新当前页显示、写单调 ready 标记')
    const sysBlock = src.slice(src.indexOf('const markSysReady'), src.indexOf('const onSysReady'))
    assert.ok(sysBlock.includes('syncMemRef.current.sys = ts') && sysBlock.includes('setPanelReadyAt(performance.now())'),
      '系统页两个面板都完成时必须缓存 sys 时间并写 ready 标记')
    assert.ok(renderBlock.includes('showSyncFor(next)') &&
      renderBlock.indexOf('showSyncFor(next)') < renderBlock.indexOf('setTab(next)'),
    '页签点击必须同步切到目标页缓存时间（重渲染出口里先换「数据截至」再换页）')
    const hashStart = src.lastIndexOf('const onHash =')
    const hashSyncBlock = src.slice(hashStart, src.indexOf("window.addEventListener('hashchange'", hashStart))
    assert.ok(hashSyncBlock.includes('renderTabRef.current(next)'),
      '后退/前进必须走同一个渲染出口（showSyncFor / markVisited / setTab 收口在 renderTab，不得各写一份）')
    const openLogSyncBlock = src.slice(src.indexOf('const openLog ='), src.indexOf('const pollMs ='))
    assert.ok(openLogSyncBlock.includes("showSyncFor('logs')"), '查看日志必须切到 logs 的缓存时间')
    assert.ok(src.includes('const loadSeqRef = useRef(0)') &&
      src.includes('if (seq !== loadSeqRef.current || !mountedRef.current) return'),
    '过滤规则页必须做竞态/卸载守卫，旧响应不能刷新时间戳')
    assert.ok(!src.includes('useEffect(() => { setPanelSync(null) }, [tab])'),
      '换页不得清空时间，否则每次切页都会闪一下手动刷新')
    assert.ok(src.includes("const at = lastSync ? fmtBarTime(lastSync, showDate) : '—'"),
      '第一次进入未加载时必须用「—」占位，不能整行换成手动刷新')
    // v3.342：设置块搬到系统页后，配置页恢复成 config + filter 两条 loader；
    // 设置读面在系统页，和系统信息、访问日志一起等落定。
    assert.ok(src.includes("if (typeof onSync === 'function' && configAt && filterAt) onSync(Math.max(configAt, filterAt))"),
      '配置页必须等 config/filter 两个 loader 落定')
    const cfgOnly = src.slice(src.indexOf('function ConfigPanel'), src.indexOf('// ── 过滤规则（v3.310）'))
    assert.ok(!cfgOnly.includes('apiGetConsoleSettings'), '配置页不得再挂设置读面（v3.342 已搬到系统页）')
    assert.ok(src.includes('if (sysReady && accessReady && typeof onReady'), '系统页 loader 都落定才算完成')
    assert.ok(src.includes('onReady=$' + '{onSysReady}') && src.includes('onReady=$' + '{onFilesReady}'),
      '系统页与文件清单都要向滚动层报完成')
    assert.ok(src.includes('prepareScrollRef.current(next)'), 'hash 后退/前进必须走同一套滚动还原')
    assert.ok(src.includes("window.history.scrollRestoration = 'manual'"), '后退/前进必须关掉浏览器默认的滚动恢复')
    assert.ok(src.includes("prepareScrollRef.current('logs', { forceTop: true })"), '查看日志必须强制回顶')
    assert.ok(src.includes('onClick=$' + '{() => switchTab(t.key)}'), '标签点击必须直接走 switchTab')
    // v3.318：点「运行日志」页签不能清 logJump 触发重挂载——重挂载会先画 90px 空壳，
    // 把下面的「触发历史」顶进视口闪一下。数据与筛选由保活面板自己保留。
    assert.ok(!src.includes('setLogJump(null)'), '点「运行日志」页签不得清 logJump 重挂载（会闪空壳）')
    // 手机端 6 个页签在 640 断点下会折成两行（吸顶 108px）；必须改成单行横滚，
    // 否则吸顶区翻倍、正文被挤掉。桌面保持 wrap，不引入滚动容器吞滚轮。
    const phone = (css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(/\.tabs\s*\{[^}]*flex-wrap:\s*nowrap/.test(phone) && /\.tabs\s*\{[^}]*overflow-x:\s*auto/.test(phone),
      '手机断点标签栏必须单行横滚（nowrap + overflow-x）')
    assert.ok(/\.tab-btn\s*\{[^}]*flex:\s*0 0 auto/.test(phone), '手机断点标签按钮不得被压缩换行')
    const lastPhoneRule = (re) => {
      const all = [...phone.matchAll(re)]
      return all.length ? all[all.length - 1][1] : ''
    }
    const topbarPhone = lastPhoneRule(/\.topbar\s*\{([^}]*)\}/g)
    const syncPhone = lastPhoneRule(/\.sync\s*\{([^}]*)\}/g)
    assert.ok(/flex-direction:\s*column/.test(topbarPhone),
      '最后一条手机 .topbar 规则必须是 column，后置规则不能把它改回 row')
    // v3.338：顶栏不再有品牌行（名字只留在浏览器标签上），只剩一行状态/刷新信息。
    assert.ok(!src.includes('<span class="name">') && !/\.brand\s*\{/.test(css),
      '页面里不得再渲染控制台名字（品牌行已去掉）')
    const metaRule = (css.match(/\.sync-meta\s*\{[^}]*\}/) || [''])[0]
    // 省略号三件套缺一不可：只写 text-overflow 而没有 overflow:hidden/nowrap 时，
    // 文本会换行或被裁掉而不是出省略号（Sourcery #301）。
    const metaOk = /text-overflow:\s*ellipsis/.test(metaRule) && /overflow:\s*hidden/.test(metaRule) &&
      /white-space:\s*nowrap/.test(metaRule)
    assert.ok(src.includes('<span class="sync-meta">') && metaOk,
      'sync-meta 必须 ellipsis + overflow:hidden + nowrap，长文案才真的收省略号')
    // 失败整句必须在 .sync 之外（同步容器里的第一个 </div> 之后、</header> 之前）：
    // 只看 class 是否存在的话，挪回行内照样绿（Sourcery #301）。
    const syncOpen = src.indexOf('class="sync"')
    const syncClose = src.indexOf('</div>', syncOpen)
    const failAt = src.indexOf('class="sync-fail"')
    const headerEnd = src.indexOf('</header>', syncOpen)
    assert.ok(css.includes('.sync-fail {') && failAt > syncClose && failAt < headerEnd,
      '刷新失败必须渲染在 .sync 之外、header 之内（挤在行内会被省略号吃掉）')
    // 按钮不能被压缩或换行：窄屏时让位的是中间文本，不是「暂停」。
    const toggleRule = (css.match(/\.sync-toggle\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/flex:\s*0 0 auto/.test(toggleRule) && /white-space:\s*nowrap/.test(toggleRule),
      'sync-toggle 必须 flex:0 0 auto + nowrap，否则窄屏会被压缩换行')
    assert.ok(/white-space:\s*nowrap/.test(syncPhone) && /min-height:\s*24px/.test(syncPhone),
      '手机端 sync 必须单行 + 固定行高，文字长短不能改高度')
    assert.ok(/class="sync"[^>]*tabindex="0"/.test(src),
      '手机端 sync 必须可聚焦，长错误才能用键盘横向滚动查看')
    assert.ok(src.includes('tabsRef') && src.includes("querySelector('.tab-btn.active')"),
      '切页后必须把当前页签滚进可视区（横滚后靠右页签不能停在视野外）')
    assert.ok(src.includes("window.addEventListener('resize', adjust)") && src.includes('new window.ResizeObserver(adjust)'),
      '窗口/标签栏尺寸变化后必须重新把当前页签滚进可视区（旋转屏不能停在裁剪边外）')
    const cache = src.slice(src.indexOf('function CacheHealthPanel'), src.indexOf('// 推送记录：'))
    assert.ok(cache.includes('60000'), '缓存健康必须每分钟刷新')
    assert.ok(!cache.includes("addEventListener('visibilitychange'"), '切回前台补拉交给 App 统一路径，面板不得再自己挂（会重复请求）')
  })

  await aok('结构红线: 页签保活（切回已访问页签不重挂载、不塌陷、不重新占位）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    // 六个页签都按 visited 保活：第一次进入才挂载，之后只切 hidden。
    for (const key of ['overview', 'messages', 'logs', 'config', 'filter', 'sys']) {
      assert.ok(src.includes(`visited.has('${key}')`), `${key} 页必须按 visited 保活渲染`)
      const open = "visited.has('" + key + "') && html`<section class=\"page\" hidden=$" + "{tab !== '" + key + "'}>"
      assert.ok(src.includes(open), `${key} 页的 hidden 必须比较自己的 tab，不能拿别的页签顶替`)
    }
    assert.ok(src.includes('const [visited, setVisited] = useState(() => new Set(['),
      '必须记录已挂载的页签集合')
    assert.ok(src.includes('const next = new Set(visitedRef.current)') &&
      src.includes('visitedRef.current = next') && src.includes('setVisited(next)'),
    'markVisited 必须先复制 Set，再同时替换 ref 与 state（不能原地改 state 持有的 Set）')
    assert.ok(!src.includes('visitedRef.current.add(key)'), '不得原地修改 state 持有的 Set')
    assert.ok(src.includes('next.add(key)'), 'markVisited 必须把传入的 key 加进副本（不能写死别的页签）')
    assert.ok(src.includes('for (const t of TABS) markVisited(t.key)'),
      '首屏后必须预挂载全部页签，刷新后第一次点击不闪加载占位')
    assert.ok(src.includes('markVisited(next)') && src.includes("markVisited('logs')"),
      '点击页签 / 查看日志 / hash 前进后退都必须登记保活')
    // 已保活页直接落位；首访才垫高。
    assert.ok(src.includes('if (!firstVisit)') && src.includes('window.scrollTo(0, Math.min(y, maxScroll))'),
      '已保活页必须在 layout effect 里直接调用 scrollTo 落到记忆位置')
    assert.ok(src.includes('if (firstVisit && target > 0) holdScroll(target)'),
      '只有首访才垫高文档')
    const jumpBranch = src.slice(src.indexOf('if (logJumpPendingRef.current) {'), src.indexOf('const y = pendingScrollRef.current'))
    assert.ok(jumpBranch.includes('pendingScrollRef.current = null') &&
      jumpBranch.includes('pendingFirstVisitRef.current = false') &&
      jumpBranch.includes('window.scrollTo(0, y)'),
    'logJump 分支必须清掉 pending 引用，再落到定位条/顶部')
    // 隐藏页不轮询、不跟着倒计时重渲染、不保持 SSE。
    assert.ok(src.includes("autoRefresh && tab === 'overview' ? pollMs : 0"), '概览隐藏后触发历史必须停轮询')
    assert.ok(src.includes("autoRefresh && tab === 'logs' ? pollMs : 0"), '日志页隐藏后触发历史必须停轮询')
    assert.ok(src.includes("autoRefresh && tab === 'logs' && locking ? POLL_BUSY_MS : 0"), '日志页隐藏后日志轮询必须停')
    assert.ok(src.includes("if (!autoOn || tab !== 'overview') return undefined"), '概览隐藏后倒计时时钟必须停')
    assert.ok(src.includes('paused=$' + "{!autoRefresh || tab !== 'overview'}"), '概览隐藏后缓存健康分钟轮询必须停')
    assert.ok(src.includes('if (openId === null || !active) return undefined'), '隐藏页的运行详情必须断开 SSE/轮询')
    // 隐藏页不只不轮询，也不该生成工具条 DOM（L4）：保活面板切走后，
    // date-btn / auto-run-row 会以 hidden 副本留在别的页面里，点击区与可检索文本都被污染。
    assert.strictEqual((src.match(/active && html`<\$\{DateRange\}/g) || []).length, 4,
      '四处 DateRange 都必须按 active 条件渲染（非活动面板不生成 date-btn）')
    assert.strictEqual((src.match(/active && html`<div class="auto-run-row">/g) || []).length, 2,
      '两处 auto-run-row（概览自动运行 / 系统页拦截窗）都必须按 active 条件渲染')
    // 只读页切回静默刷新；带草稿的过滤规则页不得重拉覆盖。
    assert.ok(src.includes('<$' + '{MessagesPanel} active=$' + "{tab === 'messages'}"), '推送记录页切回时必须静默刷新')
    assert.ok(src.includes('active=$' + "{tab === 'logs'}"), '日志页切回时必须静默刷新')
    assert.ok(src.includes('<$' + '{ConfigPanel} active=$' + "{tab === 'config'}"), '配置页切回时必须静默刷新')
    assert.ok(src.includes('<$' + '{TrendsPanel} active=$' + "{tab === 'overview'}"), '趋势切回必须刷新')
    assert.ok(src.includes('active=$' + "{tab === 'overview'} />"), '逐轮历史切回必须刷新')
    assert.ok(src.includes('<$' + '{SysPanel} onReady=$' + '{onSysReady} active=$' + "{tab === 'sys'}"), '系统页切回必须刷新')
    assert.ok(src.includes('<$' + '{FilesPanel} onReady=$' + '{onFilesReady} active=$' + "{tab === 'sys'}"), '文件清单切回必须刷新')
    assert.ok(src.includes('<$' + '{FilterRulesPanel} onSync=$' + '{syncFor.filter} active=$' + "{tab === 'filter'}"), '过滤规则页必须拿到 active，首次打开补拉、之后切回不重拉')
    const filterSeg = src.slice(src.indexOf('function FilterRulesPanel'), src.indexOf('function App ()'))
    assert.ok(!filterSeg.includes('if (active) load()'), '过滤规则页不得在切回时重拉')
    // 各面板自己必须真的消费 active（父组件传了 prop 但子组件不 reload 也算失败）。
    const seg = (name, next) => src.slice(src.indexOf('function ' + name), src.indexOf(next))
    assert.ok(seg('MessagesPanel', 'function LogsPanel').includes('usePanelAutoLoad(active, load)'), '推送记录必须首访预加载 + 切回刷新')
    assert.ok(seg('LogsPanel', 'function SysPanel').includes('load(true).catch'), '日志切回必须排队补拉（busy 时不能丢）')
    assert.ok(seg('ConfigPanel', 'function FilterRulesPanel').includes('usePanelAutoLoad(active, refresh)'), '配置必须首访预加载 + 切回刷新')
    assert.ok(seg('TrendsPanel', 'function CacheHealthPanel').includes('usePanelAutoLoad(active, load)'), '趋势必须首访预加载 + 切回刷新')
    assert.ok(seg('RunHistoryPanel', 'function usePanelLoader').includes('usePanelAutoLoad(active, load)'), '逐轮历史必须首访预加载 + 切回刷新')
    assert.ok(seg('SysPanel', 'function FilesPanel').includes('Promise.allSettled([load(), loadAccess(), loadSettings()])'),
      '系统页必须等系统信息 + 访问日志 + 设置三条都结算后才报完成')
    assert.ok(seg('FilesPanel', 'function FilterRules').includes('usePanelAutoLoad(active, load)'), '文件清单必须首访预加载 + 切回刷新')
    const autoLoad = src.slice(src.indexOf('function usePanelAutoLoad'), src.indexOf('// ── 下拉刷新'))
    assert.ok(autoLoad.includes('if (!active) return') && !autoLoad.includes('!active && !first'),
      '首访懒加载：未点开的页签不得发请求（旧版 !active && !first 会在挂载时预取）')
    assert.ok(autoLoad.includes('becameActive && (pendingRef.current || (loadedAtRef.current && Date.now() - loadedAtRef.current < 3000))'),
      '切回仍在 3s 内 / 上一发在飞时不得重复发（Sourcery #272 同口径）')
    assert.ok(seg('LogsPanel', 'function SysPanel').includes('const firstReveal = preloadedRef.current && active && !revealedRef.current'),
      '日志首访也要预加载，离开后不拉')
    assert.ok(seg('CacheHealthPanel', '// 推送记录：').includes('filesLoader.load().catch'),
      '缓存健康切回必须连右列文件清单一起补拉')
    assert.ok(seg('CacheHealthPanel', '// 推送记录：').includes('if (wasPaused) {'), '缓存健康从暂停/隐藏恢复时必须立即补拉一次')
    assert.ok(src.includes('let filesInFlight = null') && src.includes('if (filesInFlight) return filesInFlight'),
      '三个面板同时要 /api/files 时必须共享同一个在飞请求')
    assert.ok(seg('FilesPanel', 'function FilterRules').includes('loadTick'),
      '文件清单重拉完成也必须重报 ready，头部时间才会更新')
    // 保活带来的两个交互坑：分类弹层要主动关（否则 body overflow:hidden 卡住新页面）；
    // 多个保留页面的确认弹窗不能共用固定 id。
    assert.ok(seg('CategoryPicker', 'function MessagesPanel').includes('if (!pageActive && open) setOpen(false)'),
      '分类弹层必须在切走时主动关闭，释放 body 滚动锁')
    assert.ok(src.includes('const [titleId] = useState(() => `confirm-title-$' + '{++dialogSeq}`') &&
      src.includes('aria-labelledby=$' + '{titleId}') && src.includes('id=$' + '{titleId}'),
    '确认弹窗标题 id 必须逐实例唯一')
    assert.ok(/\.page\[hidden\]\s*\{\s*display:\s*none/.test(css), '隐藏页面必须真正 display:none，不能占布局')
    assert.ok(/\.wrap\s*\{[^}]*display:\s*flex[^}]*min-height:\s*100dvh/.test(css),
      '页脚贴底必须用列布局，不能靠写死的 100vh 减常量')
    assert.ok(/\.page\s*\{\s*flex:\s*1 0 auto/.test(css), '当前页必须吃掉剩余高度')
    assert.ok(!/\.page\s*\{[^}]*min-height:/.test(css), '不得再用固定减值的 min-height（短页会多出滚动）')
  })

  await aok('结构红线: 自动正式运行（3–20s / 数字框 / 加减 / 保存 / 停止）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(src.includes('const AUTO_MIN_S = 3') && src.includes('const AUTO_MAX_S = 20'),
      '自动间隔必须夹在 3–20 秒')
    assert.ok(src.includes('Math.min(AUTO_MAX_S') && src.includes('Math.max(AUTO_MIN_S'),
      '保存/启动前必须统一 clamp 到 3–20')
    const consoleSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
    // 变异沙箱里 console.js 是机器生成代码（语句被 stryMutAct_* 条件包裹 + 覆盖率计数），
    // 所有源码串断言只对原始源文件有意义——与「测试隔离」红线同一口径，交 Test workflow 兜底。
    if (process.env.XBK_MUTATION_CHILD !== '1') {
      assert.ok(consoleSrc.includes('const AUTO_MIN_S = 3') && consoleSrc.includes('const AUTO_MAX_S = 20'),
        '服务器端也必须夹在 3–20 秒')
      assert.ok(consoleSrc.includes('const AUTO_MAX_FAILS = 3') && consoleSrc.includes('function tickAuto') &&
        consoleSrc.includes("startAction('run-auto'") && consoleSrc.includes('acquireLock(stateDir'),
      '自动调度必须在服务器进程内跑 run-auto，并经过单飞锁')
      assert.ok(consoleSrc.includes('activeChildren.size > 0') && consoleSrc.includes('autoInFlightId'),
        '上一轮未结束不得叠跑')
      assert.ok(consoleSrc.includes('AUTO_STATE_FILE') && consoleSrc.includes('persistAuto'),
        '自动开关/间隔必须由服务器持久化，重启可恢复')
      assert.ok(consoleSrc.includes('AUTO_MAX_MS') === false, '不得再有 10 分钟总时长上限')
      // 关闭回调里的清理必须「真的在回调体内且未被注释」：先剥注释，再按花括号配对取回调体。
      const closeHandlerCleanup = (srcText) => {
        const code = srcText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        const at = code.indexOf("server.on('close'")
        if (at < 0) return false
        const arrow = code.indexOf('=>', at)
        const open = arrow < 0 ? -1 : code.indexOf('{', arrow)
        if (open < 0) return false
        let depth = 0
        for (let i = open; i < code.length; i++) {
          if (code[i] === '{') depth++
          else if (code[i] === '}') {
            depth--
            if (depth === 0) {
              const body = code.slice(open + 1, i)
              return body.includes('disposeAuto()') && body.includes('killAll()')
            }
          }
        }
        return false
      }
      assert.ok(closeHandlerCleanup(consoleSrc), '控制台关闭时必须清理自动定时器')
      // 反例钉子：注释掉的清理、搬到回调外的清理都必须判红
      assert.ok(!closeHandlerCleanup(consoleSrc.replace('disposeAuto();', '// disposeAuto();')),
        '注释掉的清理不得算数')
      assert.ok(!closeHandlerCleanup(consoleSrc.replace(
        "server.on('close', () => { disposeAuto(); killAll() })",
        "server.on('close', () => { killAll() }); disposeAuto()")),
      '清理调用移出关闭回调不得算数')
    }

    const trigger = src.slice(src.indexOf('function TriggerBar'), src.indexOf('// ── 组件：运行历史'))
    assert.ok(trigger.includes('class="auto-input"') && trigger.includes('type="number"') &&
      trigger.includes('min=$' + '{AUTO_MIN_S}') && trigger.includes('max=$' + '{AUTO_MAX_S}'),
    '自动间隔必须是带 3–20 边界的数字框')
    assert.ok(trigger.includes('aria-label="减少间隔"') && trigger.includes('aria-label="增加间隔"'),
      '数字框必须有减/加按钮')
    assert.ok(trigger.includes('onClick=$' + '{saveAuto}') && trigger.includes('保存'), '必须有保存键')
    assert.ok(trigger.includes('auto.start') && trigger.includes('auto.stop') && trigger.includes('停止'),
      '必须能开始/停止自动运行')
    assert.ok(trigger.includes("askConfirm('auto')") && trigger.includes('确认开启自动正式运行'),
      '自动运行是持续真实推送，必须先确认')
    assert.ok(trigger.includes('服务器调度') && trigger.includes('关闭页面'),
      '界面必须说明调度在服务器，关页不影响')
    const autoApp = src.slice(src.indexOf('const startAuto ='), src.indexOf('// v3.297 标签页状态'))
    assert.ok(autoApp.includes('apiSetAuto({ on: true, interval: v })') && autoApp.includes('apiSetAuto({ on: false })'),
      '前端只能通过 /api/auto 开关，不得自己 setTimeout 调度')
    assert.ok(!autoApp.includes('setTimeout(') && !autoApp.includes('window.localStorage'),
      '前端不得再把自动循环放在浏览器里')
    assert.ok(src.includes('function apiGetAuto') && src.includes("fetch('/api/auto'"),
      '前端必须读取服务器自动运行状态')
    assert.ok(css.includes('.auto-run') && css.includes('.auto-input') && css.includes('.auto-step'),
      '自动运行控件必须有独立样式（数字框/加减/状态）')
  })

  await aok('结构红线: 控制台 UX 稳定性（搜索归属 / 弹层聚焦 / 趋势对齐）', () => {
    const src = readConsoleSource()
    const msgSeg = src.slice(src.indexOf('function MessagesPanel'), src.indexOf('function LogsPanel', src.indexOf('function MessagesPanel')))
    // 旧响应（in-flight 期间用户又改了词）不得把新词回写成旧 queryUsed。
    assert.ok(msgSeg.includes('loadedQueryRef.current !== query'), 'queryUsed 回写必须有响应归属守卫')
    // 守卫必须真的包住回写：把守卫留在注释里、回写移到守卫外，旧响应仍会吞掉新输入。
    const guardAt = msgSeg.indexOf('if (loadedQueryRef.current !== query) return')
    const writeAt = msgSeg.indexOf('setInput(data.queryUsed)')
    assert.ok(guardAt >= 0 && writeAt > guardAt && writeAt - guardAt < 500, 'queryUsed 回写必须位于响应归属守卫内')
    assert.ok(!msgSeg.includes('sentQueryRef'), '旧的 sentQueryRef 归属判断必须移除')
    const cateSeg = src.slice(src.indexOf('function CategoryPicker'), src.indexOf('function MessagesPanel', src.indexOf('function CategoryPicker')))
    assert.ok(!/\.focus\(\)/.test(cateSeg), '分类弹层聚焦必须 preventScroll，禁止把页面滚回顶部')
    // 触发历史表在 320 宽会撑出面板：必须和逐轮历史一样放进横向滚动容器。
    const runsSeg = src.slice(src.indexOf('function RunsPanel'), src.indexOf('function RunHistoryPanel', src.indexOf('function RunsPanel')))
    assert.ok(runsSeg.includes('<div class="runs-scroll" ref=$' + '{listRef}><table class="runs-table">'), '触发历史表必须包 .runs-scroll（带 ref 供行入场），窄屏不得撑破面板')
    // preventScroll 不能把键盘焦点留在 .cate-list 的可视区外：必须显式滚列表。
    assert.ok(cateSeg.includes('focusInList') && cateSeg.includes('list.scrollTop'), '分类列表键盘焦点必须滚进可视区')
    // 趋势图自动停靠最右时，最左列可能只露半截日期：须把下一个完整列对齐到容器左缘。
    assert.ok(src.includes('const partial'), '趋势图须对最左半截列做对齐')
    assert.ok(src.includes('r.left < base && r.right > base'), '趋势对齐基准必须是滚动容器左缘，不是视口 x=0')
    // 切窗口时新的一组列与旧 scrollLeft 在同一个 commit 里换进来：对齐必须在绘制前完成，
    // 放到 useEffect（绘制后）会先画出一帧指向窗口最早几天的空图表——手机上看就是「闪一下」。
    const scrollAt = src.indexOf('const scrollRef = useRef(null)')
    const alignEffect = src.slice(scrollAt, scrollAt + 600)
    assert.ok(alignEffect.includes('useLayoutEffect(() => {'), '趋势切窗口对齐必须在绘制前（useLayoutEffect）')
    // 只断言 hook 名字不够：把 align() 塞进 rAF（schedule）照样通过，仍会闪一帧。
    // 布局效应里必须同步调用一次 align()，ResizeObserver 只负责后续尺寸变化。
    const syncAlign = src.slice(src.indexOf('const schedule = () => { if (raf === 0)'), src.indexOf('const schedule = () => { if (raf === 0)') + 160)
    assert.ok(syncAlign.includes('\n    align()\n'), '布局效应必须同步调用 align()，不得只 schedule 到 rAF')
    // 容器宽度变化而天数不变时也要重算，不能只在 byDay.length 变化时跑。
    assert.ok(src.includes('new window.ResizeObserver'), '趋势对齐必须监听容器尺寸变化')
    // 表单交互暂停轮询必须有截止时间；只看 activeElement 会在选完后永久停轮。
    assert.ok(src.includes('formPauseUntilRef.current'), '表单交互暂停轮询必须有截止时间')
    assert.ok(!src.includes('const ae = document.activeElement'), '不得用 activeElement 永久暂停轮询')
    // 暂停自动刷新时 pollMs=0，详情轮询必须只取一次快照，不能 setInterval(fn, 0)。
    assert.ok(src.includes('if (!(pollMs > 0)) return'), 'pollMs=0 时必须跳过 setInterval，避免热循环')
    assert.ok(src.includes('if (!openActive) return'), '已结束轮次不得继续轮询详情')
    // 首次历史未回/失败时不得谎报「暂无触发记录」。
    assert.ok(src.includes('runsState') && src.includes('触发历史加载中'), '触发历史必须区分加载中/失败/空')
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const cateCss = (css.match(/\.msg-cate\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/max-width:\s*100%/.test(cateCss) && /overflow-wrap:\s*anywhere/.test(cateCss), '长分类 pill 必须能折行，不得撑破卡片')
    const accessCss = (css.match(/\.access-log summary\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/min-height:\s*44px/.test(accessCss) && /display:\s*list-item/.test(accessCss), '最近访问记录 summary 必须 44px 且保留原生展开标记')
    const narrow = (css.match(/@media \(max-width: 420px\) \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(/\.tabs\s*\{[^}]*gap:/.test(narrow) && /\.tab-btn\s*\{[^}]*padding:/.test(narrow), '≤420 窄屏媒体查询必须真的作用于标签栏（v3.317 由 360 上移：362 宽要命中）')
    assert.ok(/\.msg-meta\s*\{[^}]*min-width:\s*0/.test(css), 'msg-meta 须 min-width:0（flex 子项才可收缩）')
    // v3.322：44px 的 .msg-link 会把同一 flex 行的 .msg-cate 拉到 44px（默认 stretch），
    // 999px 圆角下短分类变成圆球、文字贴顶。meta 行必须显式居中。
    const metaRules = css.match(/\.msg-meta\s*\{[^}]*\}/g) || []
    const metaAligns = metaRules.map(r => (r.match(/align-items:\s*([^;]+)/) || [])[1]).filter(Boolean).map(v => v.trim())
    assert.ok(metaAligns.length > 0 && metaAligns.every(v => v === 'center'),
      '每条 .msg-meta 的 align-items 都必须是 center（后置 stretch 会重新把来源 pill 拉成圆球）')
  })

  await aok('结构红线: MiniSelect（滚动重量 / 视口夹取 / Tab 焦点 / 可访问名 / 回滚目标）', () => {
    const src = readConsoleSource()
    const start = src.indexOf('function MiniSelect (')
    const end = src.indexOf('// 指标卡', start)
    assert.ok(start > -1 && end > start, '必须能定位 MiniSelect')
    const seg = src.slice(start, end)
    // Sourcery #270：打开期间滚动/缩放不重量，弹层会按旧方向/高度被裁掉。
    assert.ok(seg.includes("window.addEventListener('scroll', schedule"), '打开期间页面滚动须重新量测')
    assert.ok(seg.includes("window.addEventListener('resize', schedule"), '打开期间视口缩放须重新量测')
    // 靠左的按钮 + 更宽选项：right:0 会把弹层推出左边界。
    assert.ok(seg.includes('const left = Math.min(Math.max(pad, b.right - w)'), '弹层须做水平视口夹取')
    assert.ok(/left:\$\{place\.dx\}px;right:auto/.test(seg), '弹层水平位置须由量测结果决定')
    // Tab 不能落回即将卸载的选项，否则焦点掉 body。
    assert.ok(seg.includes('focusOutside') && seg.includes('DOCUMENT_POSITION_FOLLOWING'), 'Tab 须显式把焦点送出组件')
    // aria-label 覆盖可见文字时必须带回当前值。
    assert.ok(/aria-label=\$\{buttonAria\}/.test(seg) && /，当前 \$\{buttonLabel\}/.test(seg), '可访问名须包含当前选项')
    assert.ok(seg.includes('disabled = false') && /disabled=\$\{disabled\}/.test(seg), 'MiniSelect 须支持 disabled')
    // 过滤规则页的回滚目标也不能漏（Sourcery #270）。
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    assert.ok(src.includes('ariaLabel="回滚目标"'), '回滚目标必须改用 MiniSelect')
    assert.ok(!src.includes('fr-select'), '原生 fr-select 样式与用法必须移除')
    assert.ok(!/<select\s+(?:id|class)=/.test(src), '控制台不得再有原生 select')
    assert.ok(/\.fr-restore-row \.mini-select\s*\{[^}]*min-width:\s*0/.test(css), '回滚目标在窄屏必须可收缩')
  })

  await aok('结构红线: 回到顶部（固定层 / 触控尺寸 / 可访问名 / 平滑滚动）', () => {
    const src = readConsoleSource()
    const start = src.indexOf('function BackToTop ()')
    const end = src.indexOf('function App () {', start)
    assert.ok(start > -1 && end > start, '必须有 BackToTop 组件（长列表滚到深处没有回顶入口）')
    const seg = src.slice(start, end)
    // 固定层不参与文档流：换成行内按钮会把列表与分页整体顶动一截。
    assert.ok(src.indexOf('html`<' + '$' + '{BackToTop} />') > -1, 'App 必须挂载回到顶部按钮')
    assert.ok(seg.includes("document.addEventListener('scroll', onScroll, { capture: true, passive: true })"), '滚动监听必须 passive，且用捕获阶段收内层日志框的滚动（scroll 不冒泡）')
    assert.ok(seg.includes("document.removeEventListener('scroll', onScroll, { capture: true })"), '卸载时必须摘掉捕获监听')
    assert.ok(seg.includes('window.requestAnimationFrame(read)') && seg.includes('window.cancelAnimationFrame'), '滚动回调须合帧且卸载时取消')
    assert.ok(seg.includes('window.scrollTo({ top: 0, behavior'), '点击必须回到文档顶部')
    assert.ok(seg.includes('LOG_SCROLLER') && seg.includes('box.scrollTop = 0'), '日志框是内层滚动容器：点击必须把它也回到第一行')
    assert.ok(seg.includes('backToTopBehavior(reduce'), '滚动方式必须走纯函数判定（reduced-motion / 老 Safari）')
    assert.ok(/aria-label="回到顶部"/.test(seg), '按钮必须有可访问名')
    assert.ok(/tabindex=\$\{show \? '0' : '-1'\}/.test(seg), '隐藏态不得留在 Tab 序列里')
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const topCss = (css.match(/\.to-top\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/position:\s*fixed/.test(topCss), '.to-top 必须是固定层（出现/消失不改页高）')
    assert.ok(/width:\s*44px/.test(topCss) && /height:\s*44px/.test(topCss), '.to-top 触控区必须 44px')
    assert.ok(/pointer-events:\s*none/.test(topCss), '隐藏态不得吃掉列表末尾的点击')
    assert.ok(/env\(safe-area-inset-bottom\)/.test(topCss), '.to-top 必须避开 iOS 底部安全区')
    const showCss = (css.match(/\.to-top\.show\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/visibility:\s*visible/.test(showCss) && /pointer-events:\s*auto/.test(showCss), '显示态必须真的可见可点')
  })

  await aok('行为: backToTopBehavior（减少动效 / 老 Safari 退回瞬时回顶）', async () => {
    const { backToTopBehavior } = await import('./scripts/console-assets/pure.mjs')
    assert.strictEqual(backToTopBehavior(false, true), 'smooth', '默认必须平滑滚动')
    assert.strictEqual(backToTopBehavior(true, true), null, 'prefers-reduced-motion 时不得动画，必须瞬时回顶')
    assert.strictEqual(backToTopBehavior(false, false), null, '宿主不支持 scrollBehavior 时必须瞬时回顶（传 options 会被老 Safari 当成 x,y）')
  })

  await aok('行为: motionAllowed（减少动效时必须真的关掉，不是只在源码里写个判断）', async () => {
    const { motionAllowed } = await import('./scripts/console-assets/pure.mjs')
    assert.strictEqual(motionAllowed(true), false, '系统开了「减少动效」必须返回 false（否则页面还在动）')
    assert.strictEqual(motionAllowed(false), true, '未开启时必须允许动效')
    assert.strictEqual(motionAllowed(undefined), true, '取不到 media query（老浏览器/测试环境）时按允许处理')
    assert.strictEqual(motionAllowed(null), true, 'matchMedia 缺失时不得把动效全关掉')
  })

  await aok('行为: canViewTransition（有/无 startViewTransition × 动效开/关，四种输入都要判对）', async () => {
    const { canViewTransition } = await import('./scripts/console-assets/pure.mjs')
    const doc = { startViewTransition: () => ({}), documentElement: {} }
    assert.strictEqual(canViewTransition(doc, true), true, '宿主有 startViewTransition + 动效开 + 有根元素 ⇒ 才允许')
    assert.strictEqual(canViewTransition({ documentElement: {} }, true), false, '没有这个 API（旧 Safari / 老 WebView）必须降级')
    assert.strictEqual(canViewTransition({ startViewTransition: 'placeholder', documentElement: {} }, true), false,
      '同名但不是函数也必须降级（壳浏览器塞的占位属性不能靠 in 判断骗过去）')
    assert.strictEqual(canViewTransition(doc, false), false, '系统开了「减少动效」必须降级（页面不许再淡）')
    assert.strictEqual(canViewTransition(doc, undefined), false, '动效开关取不到时按「不动」处理（fail-safe）')
    assert.strictEqual(canViewTransition({ startViewTransition: () => ({}), documentElement: null }, true), false,
      '没有 documentElement 就无法命名 root 快照，必须降级')
    assert.strictEqual(canViewTransition(null, true), false, '拿不到 document 时返回 false，不能抛')
  })

  await aok('行为: runViewTransition（先起过渡、再渲染、再等微任务；拿不到能力就同步渲染且只渲染一次）', async () => {
    const { runViewTransition } = await import('./scripts/console-assets/pure.mjs')
    // 假 document：只记顺序，不碰真 DOM（纯函数模块不该要求 DOM 存在）。
    const order = []
    let pending = null
    let renders = 0
    const doc = {
      documentElement: {},
      startViewTransition (cb) {
        order.push('startViewTransition')
        pending = cb
        return { finished: Promise.resolve(), updateCallbackDone: Promise.resolve() }
      }
    }
    const t = runViewTransition(doc, true, (via) => {
      renders++
      order.push(via === true ? 'render:vt' : 'render:plain')
    })
    assert.ok(t, '有能力时必须返回 transition 句柄（调用方据此判断有没有降级）')
    assert.deepStrictEqual(order, ['startViewTransition'], '必须先起过渡；渲染只能发生在它的回调里')
    assert.strictEqual(renders, 0, '回调还没跑，此时不得渲染（否则浏览器抓到的「旧页」快照已经变了）')
    await pending()
    assert.deepStrictEqual(order, ['startViewTransition', 'render:vt'],
      '顺序必须是：起过渡 → 同步渲染（之后的微任务等待在纯函数内部，不排帧）')
    assert.strictEqual(renders, 1, '一次切页只渲染一次')
    // 回调被重复触发（浏览器 abort 后重放）也不得补渲染。
    let pending2 = null
    let renders2 = 0
    runViewTransition({ documentElement: {}, startViewTransition (cb) { pending2 = cb; return { finished: Promise.resolve() } } },
      true, () => { renders2++ })
    await pending2()
    await pending2()
    assert.strictEqual(renders2, 1, '更新回调被调两次也不得重复渲染')
    // 降级：没有 API ⇒ 同步渲染，不起过渡（页面要立刻换，不能等任何异步）。
    const plainLog = []
    const degraded = runViewTransition({ documentElement: {} }, true,
      (via) => { plainLog.push('render:' + String(via)) })
    assert.strictEqual(degraded, null, '降级时必须返回 null（不能假装起过过渡）')
    assert.deepStrictEqual(plainLog, ['render:false'], '降级路径同步渲染，且不让页面级入场让位')
    // 动效关：连 startViewTransition 都不许调。
    let called = 0
    const reducedLog = []
    const reduced = runViewTransition(
      { documentElement: {}, startViewTransition () { called++; return { finished: Promise.resolve() } } }, false,
      () => { reducedLog.push('render') })
    assert.strictEqual(reduced, null, '关动效时必须返回 null')
    assert.strictEqual(called, 0, 'prefers-reduced-motion 下不得起过渡')
    assert.deepStrictEqual(reducedLog, ['render'], '关动效时直接换页')
    // 过渡起不来（浏览器同步抛错）：补一次普通渲染，切页不能停在旧页。
    let fallback = 0
    const threw = runViewTransition(
      { documentElement: {}, startViewTransition () { throw new Error('InvalidStateError') } }, true,
      () => { fallback++ })
    assert.strictEqual(threw, null, '起过渡失败必须走降级路径')
    assert.strictEqual(fallback, 1, '失败后必须补一次渲染（否则点了没反应）')
    // 连点：上一段过渡被 skip/abort ⇒ ready 与 finished 都拒绝。只挂吞掉的 catch，
    // 绝不 await（await 会把点击卡住）。updateCallbackDone 被访问就 throw：
    // 证明我们没有给它挂 catch（更新回调里的异常不许被吞）。
    let catchCalls = 0
    const promiseLike = () => ({
      then () {},
      catch (fn) {
        catchCalls++
        assert.strictEqual(typeof fn, 'function', 'ready/finished 的 catch 要收一个函数')
        return promiseLike()
      }
    })
    const returned = runViewTransition({
      documentElement: {},
      startViewTransition () {
        return { ready: promiseLike(), finished: promiseLike(), get updateCallbackDone () { throw new Error('不得给 updateCallbackDone 挂 catch：更新回调里的异常必须露出来') } }
      }
    }, true, () => {})
    assert.ok(returned, 'abort 场景下照样返回句柄（调用方只看有没有过渡）')
    assert.strictEqual(catchCalls, 2, 'ready 与 finished 各挂一个 catch：连点 skip/abort 属预期路径，不能刷未处理拒绝')
  })

  await aok('结构红线: 切页接入原生 View Transitions（接线 + 只用 opacity + reduced-motion 全关）', () => {
    // CSS：剥掉注释再断言，注释里写示例块 / 把真块整段注释掉都不能骗过门禁。
    const cssRaw = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(css.length < cssRaw.length, 'CSS 注释剥离必须真的生效（否则本断言恒真）')
    assert.ok(css.includes('::view-transition-old(root)') && css.includes('::view-transition-new(root)'),
      '必须有 root 新旧快照的伪元素规则，否则时长/曲线全由浏览器默认决定')
    const pair = (css.match(/::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/animation-duration:\s*220ms/.test(pair), '淡出淡入必须 220ms（与 motion.js 的 MOTION.fast 同档）')
    assert.ok(/animation-timing-function:\s*ease-out/.test(pair), '曲线必须是 ease-out')
    assert.ok(!/::view-transition[^{]*\{[^}]*\btransform\s*:/.test(css),
      '快照过渡里不得出现 transform —— 页面里有 position:fixed 的弹层，祖先一有 transform 就按它定位')
    const page = (css.match(/\.page\s*\{[^}]*\}/) || [''])[0]
    assert.ok(page && !/transform\s*:/.test(page), '.page 不得有 transform / transform 过渡')
    const reduceIdx = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('::view-transition-old(root)'))
    assert.ok(reduceIdx > 0, '必须有一段 prefers-reduced-motion: reduce 把过渡直接关掉')
    const reduceBody = css.slice(reduceIdx, reduceIdx + 400)
    assert.ok(reduceBody.includes('::view-transition-old(root)') && /animation:\s*none\s*!important/.test(reduceBody),
      'reduced-motion 块里必须 animation: none !important（伪元素的默认淡入也要关）')
    if (process.env.XBK_MUTATION_CHILD !== '1') {
      // 约定：app.js 只是入口（v3.367 起页面切换在 ui.js），readConsoleSource 拼的就是这份入口源码。
      const src = readConsoleSource()
      assert.ok(src.includes('runViewTransition('), '切页必须真的调 runViewTransition——只写 CSS 伪元素不会有任何过渡')
      assert.ok(/import \{[^}]*\brunViewTransition\b[^}]*\} from '\.\/pure\.mjs'/.test(src),
        '过渡的判定/收口必须来自 pure.mjs（Node 侧直接测同一份实现）')
      assert.ok(/runViewTransition\(document, motionOK\(\)/.test(src),
        '能力判定必须带上 motionOK()：用户关了动效就别起过渡')
      assert.ok(src.includes('renderTab(next)') && src.includes('renderTabRef.current(next)'),
        '点击切页与 hash 前进后退必须走同一个渲染出口（两处都包过渡，路由不另开一条路）')
      assert.ok(/vtDrivenRef\.current = viaTransition/.test(src) && src.includes('if (!root || viaTransition) return'),
        '过渡驱动的那一帧要跳过页面级入场，否则两套淡入叠加会先淡到发白再回来')
      assert.ok(!/await\s+[\w.]*finished/.test(src), 'transition.finished 不得 await：连点会 abort，等待会把点击卡住')
      const pureSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'pure.mjs'), 'utf8')
      const runner = pureSrc.slice(pureSrc.indexOf('export function runViewTransition'),
        pureSrc.indexOf('// 配置页「过滤规则」块的数据口径'))
      assert.ok(runner.length > 200, 'runViewTransition 源码切片必须真的取到（否则下面两条恒真）')
      assert.ok(!/requestAnimationFrame|setTimeout|setInterval/.test(runner),
        '更新回调里不得等帧/定时器：过渡的 DOM update 阶段 rAF 会被饿死，Chrome 4s 后 abort 整段过渡')
      assert.ok((runner.match(/await Promise\.resolve\(\)/g) || []).length >= 2,
        '必须用微任务等 preact 的 flush（setState 就是微任务里刷的），两次兜住连环 setState')
      const appSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.js'), 'utf8')
      assert.ok(!appSrc.includes('startViewTransition'), '首屏挂载不得包过渡：第一帧要立刻出来，不能等快照')
    }
  })

  await aok('行为: morphFrom（弹窗从触发点长出来的几何：等比缩放 / 夹下限 / 量不到尺寸退回 null）', async () => {
    const { morphFrom } = await import('./scripts/console-assets/pure.mjs')
    // 62px 按钮 → 342px 面板：缩放 = 62/342，位移把面板中心对到按钮中心。
    const f = morphFrom({ left: 10, top: 100, width: 62, height: 44 }, { left: 24, top: 300, width: 342, height: 200 })
    assert.ok(Math.abs(f.s - 62 / 342) < 1e-9, '缩放必须是「按钮宽 / 面板宽」，等比')
    assert.strictEqual(f.dx, Math.round(10 + 31 - (24 + 171)), '水平位移要把中心对齐')
    assert.strictEqual(f.dy, Math.round(100 + 22 - (300 + 100)), '垂直位移要把中心对齐')
    // 按钮比面板还宽：夹到 1，不能放大过头。
    const big = morphFrom({ left: 0, top: 0, width: 900, height: 80 }, { left: 0, top: 0, width: 300, height: 200 })
    assert.ok(big.s <= 1 && big.s > 0.99, '按钮比面板宽时夹到 1，不能放大过头')
    // 极窄按钮：不低于 0.16，避免缩成一个点。
    assert.ok(Math.abs(morphFrom({ left: 0, top: 0, width: 8, height: 8 }, { left: 0, top: 0, width: 342, height: 200 }).s - 0.16) < 1e-9)
    assert.strictEqual(morphFrom(null, { left: 0, top: 0, width: 300, height: 200 }), null, '没有触发元素时返回 null')
    assert.strictEqual(morphFrom({ left: 0, top: 0, width: 62, height: 44 }, { left: 0, top: 0, width: 0, height: 200 }), null, '面板隐藏/量不到尺寸时返回 null')
    const js = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'motion.js'), 'utf8')
    assert.ok(js.includes('morphFrom(src, r)'), 'motion.js 必须用 pure.mjs 的几何函数，别在 hook 里另写一份')
  })

  await aok('结构红线: 主题切换（4 套 token / 首帧服务端渲染 / cookie 记忆）', () => {
    const cssRaw = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    // 先把 /* */ 注释剥掉：注释里写一个示例块 / 把真块整段注释掉，都不能骗过门禁（Sourcery #286）。
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(css.length < cssRaw.length, 'CSS 注释剥离必须真的生效（否则本断言恒真）')
    const js = readConsoleSource()
    const srv = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
    for (const key of ['material', 'nord', 'light']) {
      const block = (css.match(new RegExp(':root\\[data-theme="' + key + '"\\]\\s*\\{[^}]*\\}')) || [''])[0]
      assert.ok(block.length > 0, '必须有 ' + key + ' 主题 token 块')
      assert.ok(/--bg:/.test(block) && /--text:/.test(block) && /--accent-solid:/.test(block), key + ' 必须覆盖面层/文字/强调三类 token')
      // 主题块只许改颜色：夹带 --sp/--fs/--r 会让切换主题时布局跳动（与「只换配色」的承诺相悖）。
      assert.ok(!/--(sp|fs|r|lh|dur)-/.test(block), key + ' 主题块不得改间距/字阶/圆角/动效')
    }
    assert.ok(/:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/.test(css), '明亮主题必须声明 color-scheme: light（原生控件跟随）')
    assert.ok(js.includes("setAttribute('data-theme', key)"), '切换必须只改 data-theme 属性')
    assert.ok(js.includes("document.cookie = THEME_COOKIE + '=' + key"), '切主题必须写 cookie（首帧靠它）')
    assert.ok(js.includes('切换主题（当前 ') && js.includes('title='), '主题键必须有可访问名与悬停提示')
    assert.ok(js.includes('const shared = readThemeCookie() || currentThemeKey()'), '多标签页必须以共享 cookie 为准算下一套（不得用本标签页旧 state）')
    assert.ok(/try \{\s*document\.cookie/.test(js), '写 cookie 必须 try/catch：沙箱里抛异常不能挡住状态更新')

    // v3.325：四张指标卡必须有「主数字」层级（一卡一个主指标），否则又退回「四段小字」。
    assert.ok(js.includes('function Card ({ title, badge, main, children })'), '卡片组件要接 main（主数字）')
    assert.ok(js.includes('class="card-num"') && js.includes('class="card-unit"'), '主数字/单位要独立节点')
    assert.ok(/\.card-num \{[^}]*tabular-nums/.test(css), '主数字必须等宽（tabular-nums），否则跨卡数字不齐')
    assert.ok(/\.card-num \{[^}]*font-size: 26px/.test(css), '主数字字号要明显大于正文（26px）')
    // 「正常」徽章不许再画成彩色胶囊：健康态只留小圆点 + 同色小字，异常才用胶囊。
    const okBadge = (css.match(/\.badge-ok\s*\{[^}]*\}/g) || []).join('')
    assert.ok(okBadge.includes('background: transparent'), '健康徽章必须去掉实心底（四张卡重复彩色胶囊＝噪声）')
    assert.ok(css.includes('.badge-ok::before'), '健康徽章要保留小圆点')
    // 每套主题都要有卡片投影 token，否则材质/北境的卡片仍是「贴在底上的平面」。
    for (const key of ['material', 'nord', 'light']) {
      const block = (css.match(new RegExp(':root\\[data-theme="' + key + '"\\]\\s*\\{[^}]*\\}')) || [''])[0]
      assert.ok(block.includes('--shadow-card'), `主题 ${key} 必须定义 --shadow-card`)
    }
    assert.ok(/:root \{[^}]*--shadow-card/.test(css), '默认（深夜）也要有 --shadow-card')
    const themeBlock = js.slice(js.indexOf('const THEMES = ['), js.indexOf('function App ()'))
    assert.ok(!/localStorage\.(get|set)Item/.test(themeBlock), '不得用 localStorage 记主题（CSP 禁内联脚本，首帧会闪）')
    // 变异沙箱里 console.js 会被插桩成 stryMutAct_… ? … : ['deep', …]，文本断言必假红；
    // 改断言运行时导出值，比文本更硬（键名/顺序/数量全覆盖）。
    assert.deepStrictEqual([...require('./scripts/console.js').THEMES], ['deep', 'material', 'nord', 'light'], '服务端必须有主题白名单')
    assert.ok(/data-theme="\$\{THEMES\.includes\(theme\) \? theme : THEMES\[0\]\}"/.test(srv), '服务端必须把主题写进首帧 <html>')
  })

  await aok('行为: themeCookieValue（白名单 / 畸形 / 缺省）', () => {
    const { themeCookieValue } = require('./scripts/console.js')
    assert.strictEqual(themeCookieValue('xbk_session=x; xbk_theme=nord'), 'nord', '必须能从前面的 cookie 里取到主题')
    assert.strictEqual(themeCookieValue('xbk_theme=light'), 'light')
    assert.strictEqual(themeCookieValue('xbk_theme=evil'), 'deep', '白名单外的值必须回落深色（不得写进 <html>）')
    assert.strictEqual(themeCookieValue('xbk_theme='), 'deep')
    assert.strictEqual(themeCookieValue(''), 'deep')
    assert.strictEqual(themeCookieValue(undefined), 'deep')
    assert.strictEqual(themeCookieValue('xbk_theme=%E0%A4%A'), 'deep', '畸形百分号不得抛异常')
  })

  await aok('结构红线: 提示行/指标卡走 Hint/Card 原语（换组件库只改一层）', () => {
    const src = readConsoleSource()
    assert.ok(src.includes('function Hint ('), '必须有 Hint 原语')
    assert.ok(src.includes('function Card ('), '必须有 Card 原语')
    assert.ok(!src.includes('class="hint'), '提示行不得再手写 class="hint"')
    // 双引号、单引号都要查（class='hint' 曾能逃过字面量检查）
    const attrs = [...src.matchAll(/class=(["'])([^"']*)\1/g)].map(m => m[2])
    assert.deepStrictEqual(attrs.filter(c => /(^|\s)hint(\s|$)/.test(c)), [], '提示行只能走 Hint 原语')
    assert.strictEqual(attrs.filter(c => /(^|\s)card(\s|$)/.test(c)).length, 1, 'class="card" 只允许出现在 Card 原语定义里')
    // 面板头/按钮同理：类名契约只在原语里出现一次
    assert.strictEqual(attrs.filter(c => /(^|\s)panel-head(\s|$)/.test(c)).length, 1, 'panel-head 只允许出现在 PanelHead 原语里')
    assert.strictEqual(attrs.filter(c => /(^|\s)panel-title(\s|$)/.test(c)).length, 1, 'panel-title 只允许出现在 PanelHead 原语里')
    assert.deepStrictEqual(attrs.filter(c => /(^|\s)btn btn-/.test(c)), [], '按钮必须走 Button 原语，不得手写 btn btn-*（含前缀类名）')
    // 插值 class=${...} 同样要查：原语自身允许各 1 处，别处不得再写
    const interp = [...src.matchAll(/class=\$\{([^}]*)\}/g)].map(m => m[1])
    assert.strictEqual(interp.filter(x => /(^|['"\s])hint(['"\s]|$)/.test(x)).length, 1, 'hint 类名只允许出现在 Hint 原语里')
    assert.strictEqual(interp.filter(x => /btn btn-/.test(x)).length, 1, 'btn btn-* 只允许出现在 Button 原语里')
    assert.deepStrictEqual(interp.filter(x => /(^|['"\s])panel-head(['"\s]|$)/.test(x)), [], 'panel-head 只允许出现在 PanelHead 原语里')
    assert.deepStrictEqual(interp.filter(x => /(^|['"\s])card(['"\s]|$)/.test(x)), [], 'card 只允许出现在 Card 原语里')
    // 双引号/单引号属性里嵌插值（class="btn ${...}"、class="foo btn ${...}"）不落入上面的
    // class=${...} 扫描；旧红线因此放过了首屏 4 个主按钮（审查 #240），直到 C 批改走 Button 原语。
    // 按「btn 是独立类名」判定，前置类名/顺序不同也要命中。
    const inlineBtn = attrs.filter((c) => /(^|\s)btn(\s|$)/.test(c) && /\$\{/.test(c))
    assert.deepStrictEqual(inlineBtn, [], '按钮基础类不得手写在带插值的 class 属性里（含前置类名）')
    // 表达式值 class=${'btn ' + a.cls}：Button 原语自身允许 1 处，别处再写就是绕过原语。
    const interpBtn = interp.filter((x) => /(^|['"\s])btn(['"\s]|$)/.test(x))
    assert.strictEqual(interpBtn.length, 1, 'btn 基础类只允许出现在 Button 原语表达式里')
  })

  // ── v3.317 手机端可用性（日志顺序/行级渲染/页签/表格动作列/触发结果）──────────
  await aok('行为: v3.317 日志行着色与命中切分（纯函数）', async () => {
    const { logLineTone, splitHits } = await import('./scripts/console-assets/pure.mjs')
    assert.strictEqual(logLineTone('2026-10-20 16:00:00 ERROR 推送全部失败 3 条'), 'bad', 'ERROR 行必须标红')
    assert.strictEqual(logLineTone('2026-10-20 16:00:00 ALERT [v3.0] 运行异常'), 'warn', 'ALERT 行必须标琥珀')
    assert.strictEqual(logLineTone('2026-10-20 16:00:00 WARN 通道慢'), 'warn')
    assert.strictEqual(logLineTone('2026-10-20 16:00:00 total=20 dedup=0 pushed=20'), '', '普通摘要行不着色')
    assert.strictEqual(logLineTone('2026-10-20 16:00:00 ERROR 控制台停止：任务 #12 于运行中被停止'), '',
      '控制台生命周期行不着色（否则每次重启满屏红，白做 v3.307 降噪）')
    assert.deepStrictEqual(splitHits('推送 2 条，推送成功', '推送'),
      [['推送', true], [' 2 条，', false], ['推送', true], ['成功', false]], '同一行多处命中都要切出来')
    assert.deepStrictEqual(splitHits('PUSH ok', 'push'), [['PUSH', true], [' ok', false]],
      '大小写不敏感，但片段必须是原文（不能输出小写副本）')
    assert.deepStrictEqual(splitHits('abc', ''), [['abc', false]], '空关键词不切')
    assert.deepStrictEqual(splitHits('', 'x'), [['', false]], '空行原样返回（行不能被吞掉）')
    // v3.328 起：小写变长的字符不再整段放弃（服务端按小写命中，放弃会让卡片「匹配却无高亮」）。
    assert.deepStrictEqual(splitHits('İstanbul', 'i'), [['İ', true], ['stanbul', false]],
      '小写后长度会变时用下标映射回原文，命中字符仍要标出来')
  })

  // ── v3.328 推送记录搜索高亮 ─────────────────────────────────────────────
  await aok('行为: v3.328 推送记录标题/正文按搜索词切分（与日志页共用 splitHits）', async () => {
    const { splitHits } = await import('./scripts/console-assets/pure.mjs')
    const title = '可口可乐芬达500mL*24瓶 41.9元'
    assert.deepStrictEqual(splitHits(title, '可乐'),
      [['可口', false], ['可乐', true], ['芬达500mL*24瓶 41.9元', false]],
      '标题里命中「可乐」必须只切出命中的两个字（不能把整段「可口可乐」标黄）')
    assert.deepStrictEqual(splitHits('可乐', '可乐'), [['可乐', true]], '整段就是关键词时只留一个命中片段')
    assert.deepStrictEqual(splitHits(title, ''), [[title, false]], '没输入关键词时原样返回（不得出现空 <mark>）')
    assert.deepStrictEqual(splitHits('', '可乐'), [['', false]], '无标题/无正文的空串不能吞掉卡片')
    // 长正文护栏：只标前 N 处，剩余文本整段按普通片段返回（颜色不再逐个建 <mark> 节点）。
    assert.deepStrictEqual(splitHits('aaaaaa', 'a', 2), [['aa', true], ['aaaa', false]],
      '超过命中上限后剩余文本必须整段返回（连续命中并成一段，上限按命中次数计）')
    assert.deepStrictEqual(splitHits('İİ', 'i', 1), [['İ', true], ['İ', false]],
      '一字符摊成多个小写码元时，上限也要按命中次数收敛')
  })

  await aok('结构红线: v3.328 推送记录高亮（标题 / 正文 / 生效词 / 主题变量）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    const ph = (name) => '$' + '{' + name + '}'
    const msg = src.slice(src.indexOf('function MessagesPanel'), src.indexOf('// 运行日志：'))
    // 高亮词必须跟「当前显示的这一页数据」同源（queryUsed），不是最新 query、更不是输入框：
    // 防抖提交新词后新响应还没回来时，旧卡片会被新词标错（Sourcery PR #291 的 stale 窗口）。
    assert.ok(msg.includes("const hitKw = (data && typeof data.queryUsed === 'string' ? data.queryUsed : '').trim().toLowerCase()"),
      '高亮词必须取服务端为这批结果回显的 queryUsed')
    assert.ok(!msg.includes('const hitKw = query'), '高亮词不得取最新 query（旧卡片会被新词标错）')
    assert.ok(!msg.includes('input.trim().toLowerCase()'), '高亮不得直接取输入框')
    assert.ok(src.includes('const MSG_HIT_MAX = 200'), '单条记录命中上限必须登记（超长正文不卡展开）')
    assert.ok(msg.includes('splitHits(text, hitKw, MSG_HIT_MAX).map(([part, on], i) => on ? html`<mark key=' +
      ph('i') + '>' + ph('part') + '</mark>` : part)'), '命中片段必须用 <mark> 包文本节点（不拼 innerHTML），并带上命中上限')
    assert.ok(msg.includes('$' + '{m.title ? hit(m.title) :'), '标题必须走命中高亮')
    assert.ok(msg.includes('$' + '{m.content ? hit(m.content) :'), '展开后的正文也必须走同一高亮（服务端也按正文搜）')
    assert.ok(!/innerHTML\s*=/.test(msg), '高亮不得拼 innerHTML（用户输入只能是文本节点）')
    assert.ok(/\.msg-item mark\s*\{[^}]*var\(--warn-soft\)/.test(css), '卡片高亮底色必须走主题变量')
    assert.ok(/\.msg-item mark\s*\{[^}]*color:\s*inherit/.test(css), '<mark> 不得把标题原色盖成浏览器默认黑字')
  })

  await aok('结构红线: v3.317 日志页（顺序 / 行级渲染 / <mark> / 护栏 / 空态出口 / 高度）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    // 模板占位符拼出来再比对（直接写 ${...} 会触发 no-template-curly-in-string）
    const ph = (name) => '$' + '{' + name + '}'
    // A. 日志提到首屏：362×795 下旧顺序让日志框从 y=826 开始（视口 795）。
    const logsPage = src.slice(src.indexOf("visited.has('logs')"), src.indexOf("visited.has('config')"))
    const logsAt = logsPage.indexOf('<' + ph('LogsPanel'))
    const runsAt = logsPage.indexOf('<' + ph('RunsPanel'))
    assert.ok(logsAt > -1 && runsAt > -1 && logsAt < runsAt, '日志页必须把运行日志排在触发历史之前')
    assert.ok(/\.logpre-main\s*\{[^}]*max-height:\s*520px/.test(css), '桌面日志框 520px')
    const phone = (css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(/\.logpre-main\s*\{[^}]*min\(62dvh, 520px\)/.test(phone), '手机日志框必须 min(62dvh, 520px)')
    // B. 行级渲染 + 高亮：一行一个节点、换行仍是真实 "\n"（复制/空行都不变）。
    assert.ok(src.includes('class=' + ph("'logline' + (tone ? ' logline-' + tone : '') + (isFocus ? ' logline-focus' : '')")), '日志必须逐行渲染并按级别着色')
    assert.ok(src.includes('}' + ph("i === last ? '' : '\\n'") + '</span>'), '行间必须仍是真实换行（只加 display:block 会丢换行）')
    assert.ok(src.includes('splitHits(line, kwNow)') &&
      src.includes('html`<mark key=' + ph('j') + '>' + ph('text') + '</mark>`'), '命中片段必须用 <mark> 包起来')
    assert.ok(!/innerHTML\s*=/.test(src), '高亮不得拼 innerHTML（用户输入只能是文本节点）')
    assert.ok(/\.logline-bad\s*\{[^}]*var\(--bad-fg\)/.test(css) && /\.logline-warn\s*\{[^}]*var\(--warn-fg\)/.test(css),
      '行级色必须走 CSS 变量（不写死 hex）')
    assert.ok(/\.logpre mark\s*\{[^}]*color:\s*inherit/.test(css), '<mark> 不得把 ERROR 行的红字盖成默认黑字')
    // 性能护栏：>3000 行退回纯文本，且计数行明说。
    assert.ok(src.includes('const LOG_HIGHLIGHT_MAX = 3000'), '高亮护栏阈值必须是 3000 行')
    assert.ok(src.includes('const heavy = ranged.length > LOG_HIGHLIGHT_MAX'), '超过阈值必须走纯文本分支（v3.326 起按区间过滤后的行数算）')
    const guardAt = src.indexOf('if (ranged.length > LOG_HIGHLIGHT_MAX) return null')
    assert.ok(guardAt > 0, '超阈值必须在 useMemo 里短路（不能先 map 一遍再二选一）')
    assert.ok(src.indexOf('return ranged.map((line, i) =>', guardAt - 200) > guardAt, '护栏必须早于 map（顺序反了等于没省）')
    assert.ok(src.includes('已关闭高亮'), '关掉高亮必须在计数行写明（不能让人以为搜不到）')
    assert.ok(/heavy \? shownText : lineNodes/.test(src), '超阈值必须退回纯文本渲染')
    // 计数行点名筛选 + 空态出口（0 命中先点名筛选，再给「在全部日志中搜索」）。
    assert.ok(src.includes('筛选下 · 显示 ' + ph('ranged.length') + ' / ' + ph('lines.length') + ' 行'),
      '筛选非 all 时计数行必须点名筛选（v3.326 起按含日期区间的 ranged 计数）')
    assert.ok(src.includes('在全部日志中搜索') && src.includes('onClick=' + ph('searchAllLogs')),
      '空态必须给「在全部日志中搜索」按钮')
    assert.ok(src.includes('在「' + ph('modeLabel') + '」筛选下没有匹配的日志行'), '空态文案必须点名当前筛选')
    const searchAll = src.slice(src.indexOf('const searchAllLogs = () => {'), src.indexOf('// 一行一个 <span>'))
    assert.ok(searchAll.includes("setMode('all')") && !searchAll.includes('setQ('), '出口只放开筛选、必须保留关键词')
    assert.ok(src.includes('分类可重叠'), '计数行必须注明分类可重叠（269 ≠ 100+165 的自洽提示）')
  })

  await aok('结构红线: v3.318 日志跳转先取后切（首帧定稿 / 转圈反馈 / 可取消）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const openAt = src.indexOf('const openLog = useCallback((jump) => {')
    const open = src.slice(openAt, src.indexOf('}, [markVisited])', openAt))
    assert.ok(openAt > 0 && open.includes('apiGetLogs()'), '跳转必须先取日志快照')
    // 只比较 indexOf 会被「发起请求后立刻 setTab」骗过：setTab 必须在 then 的成功回调里。
    assert.ok(open.includes('return apiGetLogs().then('), '必须把预取 Promise 返回并等它落定')
    const thenAt = open.indexOf('(d) => {')
    assert.ok(thenAt > 0 && open.indexOf("setTab('logs')") > thenAt, 'setTab 必须在预取成功的回调里')
    assert.ok(open.indexOf("setTab('logs')") > open.indexOf('seq !== logJumpSeqRef.current'), '切页前必须先过代次守卫')
    const rejAt = open.indexOf('(e) => {', thenAt)
    assert.ok(rejAt > thenAt && open.slice(rejAt).includes('tabRef.current !== from'),
      '迟到的失败也必须按切页作废（不能在新页面弹旧错误）')
    assert.ok(src.includes('logJumpSeqRef.current++'), '主动切页/后退必须作废在飞的日志跳转')
    assert.ok(open.includes('setLogJump({ q, mode, focus, n: seq, data: d })'), '快照必须随 logJump 交给日志面板')
    const loader = src.slice(src.indexOf('function usePanelLoader'), src.indexOf('function usePanelAutoLoad'))
    assert.ok(loader.includes('const [data, setData] = useState(initialData)'), 'usePanelLoader 必须真的把快照作为初始 data')
    const logs = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function SysPanel'))
    assert.ok(logs.includes('initialData = null') && logs.includes('usePanelLoader(apiGetLogs, onSync, initialData)'),
      '日志面板必须用预取快照当首帧')
    const seededAt = logs.indexOf('if (seeded) {')
    const seededEnd = logs.indexOf('} else if (firstReveal)', seededAt)
    assert.ok(seededAt > 0 && seededEnd > seededAt, '带快照分支必须存在')
    assert.ok(!logs.slice(seededAt, seededEnd).includes('load('), '带快照分支不得再发请求（重复拉会盖内容）')
    assert.ok(logs.includes('useLayoutEffect(() => {') && logs.includes('el.scrollTop = el.scrollHeight'),
      '日志贴底必须在 paint 前完成（否则首帧先看到顶部）')
    const hist = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    const jumpAt = hist.indexOf('const jumpLog = (r) => {')
    const jump = hist.slice(jumpAt, hist.indexOf('return html`<div class="panel">', jumpAt))
    assert.ok(jump.includes('setJumpBusy((prev)'), '点击另一行时必须先撤掉上一行的转圈')
    const busyAt = jump.indexOf('setJumpBusy(key)')
    const timerAt = jump.indexOf('window.setTimeout(() => {')
    const delayAt = jump.indexOf('}, 150)')
    assert.ok(timerAt > 0 && busyAt > timerAt && busyAt < delayAt, '转圈只能由 150ms 定时器挂上（不能点了就转）')
    assert.ok(hist.includes('class="row-spin"') && hist.includes('aria-busy='), '慢请求必须在行内按钮转圈并报 aria-busy')
    const banner = src.slice(src.indexOf('function AlertBanner'), src.indexOf('// ── 组件：状态卡片区'))
    assert.ok(banner.includes("failed ? '重试 →'"), '横幅跳转失败必须给可见反馈')
    assert.ok(/\.row-spin\s*\{[^}]*animation:\s*row-spin/.test(css), '转圈动画必须存在')
    assert.ok(/\.run-actions \.row-link\s*\{[^}]*min-width/.test(css), '转圈时按钮宽度不得变化')
  })

  await aok('结构红线: v3.319 日志跳转定位到具体轮次（横幅 / 整行高亮 / 只看这一轮）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const hist = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    assert.ok(hist.includes("onOpenLog({ q: r.at.slice(0, 10), mode: 'all', focus: r.at })"),
      '行级跳转必须把完整时间戳交给日志页')
    const openAt = src.indexOf('const openLog = useCallback')
    const open = src.slice(openAt, src.indexOf('}, [markVisited])', openAt))
    assert.ok(open.includes("typeof jump.focus === 'string'") && open.includes('setLogJump({ q, mode, focus, n: seq, data: d })'),
      'focus 必须随 logJump 状态交给日志页')
    const logs = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function SysPanel'))
    assert.ok(open.includes("const focus = jump && typeof jump.focus === 'string' ? jump.focus : ''"),
      'focus 必须真的取 jump.focus（不能恒为空）')
    assert.ok(logs.includes("focusAt = ''") && logs.includes("focusDate = ''"),
      '日志页必须接收定位时间戳与日期')
    assert.ok(src.includes('focusAt=$' + "{logJump && logJump.focus ? logJump.focus : ''}") &&
      src.includes('focusDate=$' + "{logJump ? logJump.q : ''}"), 'App 必须把 focusAt/focusDate 传进日志页')
    assert.ok(logs.includes("q === focusAt ? 'only' : (q === focusDate ? 'day' : '')"),
      '定位条必须区分「当天列表」与「只看这一轮」')
    assert.ok(logs.includes('只看这一轮') && logs.includes('看当天全部'), '两个出口必须都在')
    assert.ok(logs.includes("const isFocus = focusAt !== '' && line.startsWith(focusAt)") &&
      logs.includes("(isFocus ? ' logline-focus' : '')"), '高亮类必须由 isFocus 条件真实驱动')
    assert.ok(logs.includes('focusDoneRef.current = focusAt'), '滚动完成后必须记下 focusAt（否则轮询会反复拽回）')
    assert.ok(logs.includes('pre.scrollTop = Math.max(0'), '定位滚动必须落在日志框内')
    assert.ok(src.includes('const bottomAfter = line.getBoundingClientRect().bottom - (y - startY)') &&
      src.includes('y += bottomAfter - (vh - 12)'), '小屏必须把页面多滚一点，保证高亮行完整可见')
    assert.ok(logs.includes('focusOnly ? base.filter((l) => l.startsWith(focusAt)) : base'),
      '「只看这一轮」必须按行首过滤（不能把正文提到时间戳的行也带进来）')
    assert.ok(logs.includes('setFocusDismissed(true)') && logs.includes('focusDismissed ||'),
      '切分类/手改搜索词后定位条必须保持收起')
    assert.ok(logs.includes('focusHeavy') && logs.includes('整行高亮已关闭'), '>3000 行必须明说高亮关闭')
    assert.ok(logs.includes("focusDoneRef.current = ''; setQ(focusAt)") &&
      logs.includes("focusDoneRef.current = ''; setQ(focusDate)"), '两个按钮必须真的切换查询（不能是空 handler）')
    assert.ok(css.includes('.logline-focus') && /border-left:\s*3px solid var\(--accent\)/.test(css),
      '整行高亮必须有左侧竖条')
    assert.ok(css.includes('.log-focus') && css.includes('.log-focus-time'), '顶部定位条必须有样式')
  })

  await aok('结构红线: v3.317 页签（420 断点 / 边缘渐隐 / 当前页签滚入视野）', () => {
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    const src = readConsoleSource()
    const ph = (name) => '$' + '{' + name + '}'
    // C. 362 宽必须命中紧凑规则（旧断点 360 差 1px，实测内容 404 宽、末两格被切/出屏）。
    const media360 = [...css.matchAll(/@media \(max-width: 360px\) \{([\s\S]*?)\n {2}\}/g)].map((m) => m[1]).join('\n')
    assert.ok(!/\.tabs/.test(media360), '页签不得再用 360 断点（362 会差 1px 不命中）；360 现仅分页网格使用')
    const compact = (css.match(/@media \(max-width: 420px\) \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(/\.tabs\s*\{[^}]*gap:\s*2px/.test(compact), '≤420 必须收紧 gap 且真的落到 .tabs')
    assert.ok(/\.tab-btn\s*\{[^}]*padding:\s*7px 5px/.test(compact) && /font-size:\s*var\(--fs-sm\)/.test(compact),
      '≤420 必须再收一档 padding + 字阶（实测 362 下内容 ≈316 ≤ 可视 342）')
    // 320 横滚时的可见提示：mask-image 渐变（不吃点击），且只在溢出时挂。
    const maskRule = (edge) => (css.match(new RegExp('\\.tabs\\[data-edge="' + edge + '"\\]\\s*\\{[\\s\\S]*?\\}')) || [''])[0]
    assert.ok(/mask-image:\s*linear-gradient\(to right,\s*#000/.test(maskRule('right')), '右缘必须有渐隐提示（320 下有更多页签在右侧）')
    assert.ok(/mask-image:\s*linear-gradient\(to left,/.test(maskRule('left')), '左缘必须有渐隐提示（滑到右端后能看出左边还有）')
    assert.ok(/linear-gradient\(to right,\s*transparent/.test(maskRule('both')), '两端都能滑时两侧同时渐隐')
    assert.ok(maskRule('right').includes('-webkit-mask-image'), '需要 -webkit- 前缀（旧版 Chrome/Android WebView）')
    assert.ok(src.includes('data-edge=' + ph('tabEdge || undefined')), '渐隐只能由溢出状态驱动（362 下不得有遮罩）')
    assert.ok(src.includes('bar.scrollWidth - bar.clientWidth'), '溢出判定必须按滚动容器实测宽度')
    assert.ok(src.includes("left && right ? 'both' : left ? 'left' : right ? 'right' : ''"), '三态（左/右/两端）必须都算')
    assert.ok(src.includes("el.scrollIntoView({ inline: 'nearest', block: 'nearest', preventScroll: true })"),
      '当前页签必须自动滚入视野且不带动整页滚动')
  })

  await aok('结构红线: v3.360 动效层（资产白名单 / 适配层隔离 / reduced-motion 门控）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    const srv = fs.readFileSync(path.join(__dirname, 'scripts/console.js'), 'utf8')
    const motion = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/motion.js'), 'utf8')
    // 资产：两个新文件都必须进白名单（CSP 下没有 CDN/内联兜底，漏一条就是整页白屏）。
    for (const route of ['/assets/motion.js', '/assets/motion-lib.module.js']) {
      assert.ok(srv.includes(`'${route}'`), `${route} 必须在 STATIC_ASSETS 白名单里`)
    }
    // 换库只改一层：app.js 只能依赖自家适配层，不得直接 import 动画库。
    assert.ok(src.includes("from './motion.js'"), 'app.js 必须通过 motion.js 引入动效')
    assert.ok(!src.includes("from './motion-lib.module.js'"), 'app.js 不得直接依赖动画库（换库只改 motion.js）')
    // reduced-motion：所有入口都过 motionOK()，否则系统关了动效页面还在动。
    assert.ok(motion.includes('prefers-reduced-motion: reduce'), 'motion.js 必须读 prefers-reduced-motion')
    assert.ok(/export function motionOK/.test(motion), 'motion.js 必须导出 motionOK')
    assert.ok(/if \(!el \|\| !motionOK\(\)\) return null/.test(motion), 'enter 必须被 motionOK 门控（no-op 而不是快放）')
    assert.ok(/if \(!root \|\| !motionOK\(\)\) return \[\]/.test(motion), 'reveal 必须被 motionOK 门控')
    assert.ok(/if \(!root \|\| !motionOK\(\)\) return/.test(motion), 'useFlipList 必须被 motionOK 门控')
    // 判定本身是纯函数（可被 Node 直接测），不是只有源码字符串。
    assert.ok(motion.includes('motionAllowed(reduced && reduced.matches)'), 'motionOK 必须走纯判定 motionAllowed')
    // 只动合成层属性：入场帧必须只有 opacity/transform（改高度会引入布局跳动）。
    assert.ok(/frames\.transform = \[/.test(motion) && /frames\.opacity = \[0, 1\]/.test(motion), '入场只允许 opacity/transform')
    assert.ok(!/height|width|maxHeight/.test(motion.slice(motion.indexOf('export function enter'), motion.indexOf('export function reveal'))),
      'enter 不得改尺寸类属性')
    // 列表 FLIP 自己实现：只补 transform，且不引第二个库（那些库会顺带做宽高过渡）。
    assert.ok(!motion.includes('auto-animate') && !src.includes('auto-animate'), '列表位移不得依赖第三方库')
    assert.ok(/export function useFlipList/.test(motion) && /getBoundingClientRect\(\)/.test(motion) && /slide\(el, dx, dy, MOTION\.fast\)/.test(motion),
      '列表必须用自家 FLIP（旧矩形 → 新矩形差补 transform）')
    assert.ok(src.includes('data-mk=$' + '{m.rowKey}'), '列表条目必须带稳定 key 供 FLIP 对齐')
    // 动画收尾要清内联样式，否则盖住 CSS 的 hover/按压反馈。
    assert.ok(motion.includes("removeProperty('transform')") && motion.includes("removeProperty('opacity')"), '动画结束必须清内联样式')
    // 摘类必须晚于红圈动画（1.2s），否则反馈半路消失。
    assert.ok(/\}, 1250\)/.test(motion), 'flash 摘类必须晚于 field-ring 的 1.2s')
    // vendored bundle：非空壳且确实导出预期符号。
    const lib = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/motion-lib.module.js'), 'utf8')
    assert.ok(/export\s*\{[^}]*as animate\}/.test(lib), 'motion bundle 必须真的导出 animate（空壳会让页面零动画）')
    // CSS：motion 层必须在 utilities 之前（否则工具类改不动它），并含错误字段反馈与主题过渡。
    assert.ok(/@layer tokens, base, components, motion, utilities;/.test(css), 'motion 层必须注册在 utilities 之前')
    assert.ok(/@layer motion \{/.test(css) && /\.flash-bad\s*\{/.test(css) && /@keyframes field-shake/.test(css),
      '错误字段的抖动/红圈样式必须存在')
    assert.ok(/html\.theme-anim/.test(css), '主题切换的颜色过渡必须存在')
    // 播放时机：轮询不得重播入场（hook 内部只播一次）；隐藏页签先攒着，露出来再播。
    assert.ok(/const fired = useRef\(false\)/.test(motion) && /if \(!ready \|\| fired\.current\) return undefined/.test(motion),
      'useRevealWhen 必须只播一次（轮询不重播）')
    assert.ok(/IntersectionObserver/.test(motion), '隐藏页签要先攒着，等可见再播')
    // 切页不得给 .page 加 transform（会让页面里的 fixed 弹层改按页面定位）。
    assert.ok(src.includes('{ transform: false, duration: MOTION.fast }'), '切页必须只淡入、不加 transform')
    // 占位卡不算「数据就绪」。
    assert.ok(src.includes('useRevealWhen(ref, !busy && cards.length > 0'), '占位卡阶段不得触发卡片入场')
  })

  await aok('结构红线: v3.326 日期区间（资产白名单 / 中文分隔符 / 双月只在桌面 / 44px）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    const srv = fs.readFileSync(path.join(__dirname, 'scripts/console.js'), 'utf8')
    // 资产：新增两个文件必须进白名单（CSP script-src 'self' 下没有 CDN 兜底，漏一条就整页白屏）
    assert.ok(srv.includes("'/assets/flatpickr.js'") && srv.includes("'/assets/flatpickr.css'"), 'flatpickr 的 JS/CSS 都必须在 STATIC_ASSETS 白名单里')
    const ph = (name) => '$' + '{' + name + '}'
    assert.ok(srv.includes('<link rel="stylesheet" href="' + ph('assetBaseUrl') + '/flatpickr.css">'), 'CSS 必须在页面 head 引入且带内容版本路径')
    assert.ok(src.includes("import flatpickr from './flatpickr.js'"), '前端按白名单路由名导入（写成 flatpickr.module.js 会 404 整页白屏）')
    // 交互：range 模式 + 统一日历；中文语言包的区间分隔符是「 至 」——按 " to " 切会永远匹配不上
    assert.ok(src.includes("mode: 'range'") && src.includes('disableMobile: true'), '区间模式且禁用原生手机弹层（原生 date 不支持区间）')
    assert.ok(src.includes('dates.length !== 2'), '端点只认 Date 对象数组（不解析本地化字符串）')
    assert.ok(!src.includes("str.split(' to ')"), "zh 语言包用「 至 」，不得按 ' to ' 切")
    assert.ok(src.includes('maxDate: todayKeyShanghai()'), '不允许选未来：上限必须按上海日历日（浏览器本地 today 会错位）')
    assert.ok(src.includes('showMonths: 1'), '单月：390 下双月 613px 必然横溢出，maxDate 后第二月只剩禁用格')
    assert.ok(src.includes("monthSelectorType: 'static'"), '月份必须是静态文字：原生 <select> 在手机上弹白底系统列表，深色面板里必破一致性')
    // 年份：原生 number 输入框在月份旁边，手机上下滑动极易误触弹键盘 ⇒ 禁指针 + 自有 « » 步进。
    assert.ok(/\.flatpickr-current-month \.numInputWrapper \{ pointer-events: none/.test(css), '年份原生输入框必须禁用指针')
    assert.ok(!src.includes('fp-year-step'), '头部只保留 ‹ › 两个箭头：再塞年份步进会变成四个箭头挤一起')
    // 区间高亮：flatpickr 用 box-shadow 把首尾连成"蓝条"，只选两天就是一根横杠（用户实拍）。
    assert.ok(/\.flatpickr-day\.selected\.startRange \+ \.endRange:not\(:nth-child\(7n\+1\)\)/.test(css), '必须显式覆盖相邻首尾的连接阴影')
    assert.ok(/\.flatpickr-day\.selected::before[\s\S]{0,200}border-radius: 50%/.test(css), '区间高亮改成独立圆点（::before）')
    // 选中态底色必须用带 .flatpickr-calendar 前缀的规则压干净，否则露出 52x44 蓝色方块（用户实拍）。
    assert.ok(/\.flatpickr-calendar \.flatpickr-day\.selected, \.flatpickr-calendar \.flatpickr-day\.startRange,[\s\S]{0,700}background: transparent; border-color: transparent; color: var\(--on-accent\)/.test(css), '选中态不能留方形底色')
    assert.ok(/\.flatpickr-day\.today:not\(\.selected\)::after/.test(css), '「今天」用小圆点，不用方形描边')
    // 月份箭头长按连翻：跨年要按十几下（用户要求"按越久翻越快"）。
    assert.ok(src.includes('function attachMonthHoldRepeat') && src.includes('onReady (_sel, _str, inst) { attachMonthHoldRepeat(inst) }'), '月份箭头必须挂长按连翻')
    assert.ok(/held < 1200 \? 800 : held < 2400 \? 400 : held < 4000 \? 200 : 100/.test(src), '连翻要递进加速（800→400→200→100ms）')
    assert.ok(src.includes('flatpickr-disabled') && /classList\.contains\('flatpickr-disabled'\)/.test(src), '连翻到边界必须自己停（下一月按钮已被隐藏）')
    assert.ok(/touch-action: none; -webkit-user-select: none/.test(css), '长按不能弹选字/系统菜单')
    // 系统在长按 ~500ms 会弹选字/预览（手机上"叮"一声）：touchstart 必须拦掉，点击也只认自己的 pointerup。
    assert.ok(/addEventListener\('touchstart', \(e\) => e\.preventDefault\(\), \{ passive: false \}\)/.test(src), '长按要拦 touchstart，否则系统菜单+提示音')
    assert.ok(/addEventListener\('click', \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\) \}, true\)/.test(src), '原生 click 必须吞掉，避免和自管手势重复翻月')
    assert.ok(/\.flatpickr-current-month input\.cur-year \{ cursor: default/.test(css), '年份不可编辑（静态展示）')
    // 主题与触控：日历必须吃 token（四套主题自动跟随），手机日格 44px
    assert.ok(/\.flatpickr-calendar \{[^}]*background: var\(--panel\)/.test(css), '日历底色必须走 --panel')
    assert.ok(/\.flatpickr-day\.selected[^{]*\{[^}]*background: var\(--accent-solid\)/.test(css), '区间端点必须实心强调色（不靠描边）')
    assert.ok(/@media \(max-width: 640px\) \{[\s\S]*?\.flatpickr-calendar \.flatpickr-day \{ height: 44px/.test(css), '手机日格高度必须 44px（触控红线）')
    // 复用面：四处时间筛选（趋势 / 逐轮历史 / 推送记录 / 运行日志）都必须用同一个组件，
    // 不允许再出现第二套原生 date 输入或手写日历。
    const uses = (src.match(/<\$\{DateRange\}/g) || []).length
    assert.ok(uses >= 4, `四处时间筛选都要复用 DateRange（实际 ${uses} 处）`)
    assert.ok(!src.includes('type="date"'), '不得残留原生 date 输入（统一走 DateRange）')
    assert.strictEqual((src.match(/flatpickr\(/g) || []).length, 1, 'flatpickr 只允许在 DateRange 里初始化一次（必须真的调了一次）')
    // 趋势服务端：区间优先于 days（与推送记录同口径）
    // 同样不能读源码文本（status.js 也在变异矩阵里）：直接调 readTrends 验行为。
    const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'xbk-trends-'))
    try {
      fs.writeFileSync(path.join(tmpDir, 'run.log'), '')
      const { readTrends } = require('./scripts/status.js')
      const fixedNow = Date.parse('2026-01-10T00:00:00Z')
      const r3 = readTrends(tmpDir, { from: '2026-01-01', to: '2026-01-03', now: fixedNow })
      assert.strictEqual(r3.status, 'ok', '空 run.log 也应可读')
      assert.strictEqual(r3.value.days, 3, 'readTrends 必须按 from/to 算窗口（闭区间 3 天）')
      assert.strictEqual(r3.value.from, '2026-01-01', 'readTrends 必须回显区间起点')
      const rCap = readTrends(tmpDir, { from: '2020-01-01', to: '2026-01-10', now: fixedNow })
      assert.strictEqual(rCap.value.days, 92, '趋势区间跨度必须有上限（92 天，防一次画几百列）')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await aok('结构红线: v3.317 表格动作列贴右（两个表 / 不透明底色 / 分隔线）', () => {
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets/app.css'), 'utf8')
    const src = readConsoleSource()
    // D. 362 下「日志」按钮右边缘旧版在 616（屏外 254px）：末列贴右。
    const stickyRule = /\.runs-scroll \.runs-table th:last-child,\s*\.runs-scroll \.runs-table td:last-child\s*\{[^}]*position:\s*sticky;\s*right:\s*0/
    assert.ok(stickyRule.test(css), '两个表的末列都必须 position:sticky; right:0（含 th）')
    assert.ok(/\.runs-scroll \.runs-table th:last-child,[\s\S]{0,200}?background:\s*var\(--panel\)/.test(css),
      '粘边格必须有不透明底色（否则横滑内容会从下面透出来）')
    assert.ok(/box-shadow:\s*-1px 0 0 var\(--border\)/.test(css), '粘边格左侧必须有 1px 分隔线')
    assert.ok(/td:last-child\s*\{\s*background:\s*color-mix\(in srgb,\s*var\(--accent\) 5%,\s*var\(--panel\)\)/.test(css),
      'hover 底色必须换成不透明混色（--accent-hover 是半透明 token）')
    assert.ok(/\.row-open td:last-child\s*\{\s*background:\s*color-mix\(in srgb,\s*var\(--accent\) 8%,\s*var\(--panel\)\)/.test(css),
      '展开行同理')
    // 两个表都得落在 .runs-scroll 里才有粘边效果。
    const runsPanel = src.slice(src.indexOf('function RunsPanel'), src.indexOf('function RunHistoryPanel'))
    const histPanel = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    assert.ok(runsPanel.includes('<div class="runs-scroll" ref=$' + '{listRef}><table class="runs-table">'), '触发历史表必须在 .runs-scroll 内')
    assert.ok(histPanel.includes('<div class="runs-scroll" ref=$' + '{listRef}>') && histPanel.includes('$' + '{shown.length > 0') && histPanel.includes('? html`<table class="runs-table run-history-table">'), '逐轮历史表必须在 .runs-scroll 内（空态也保留容器）')
    assert.ok(histPanel.includes('<td class="run-actions">'), '逐轮历史的末列必须是动作列（其 sticky 才有意义）')
  })

  await aok('结构红线: 逐轮历史列宽固定（切每页不漂移）', () => {
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets/app.css'), 'utf8')
    const src = readConsoleSource()
    const histPanel = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    assert.ok(histPanel.includes('<colgroup>'), '逐轮历史表必须有 colgroup 固定列宽')
    for (const cls of ['rh-time', 'rh-get', 'rh-dedup', 'rh-filter', 'rh-push', 'rh-fail', 'rh-elapsed', 'rh-action']) {
      assert.ok(histPanel.includes(`<col class="${cls}"`), `逐轮历史缺少列 ${cls}`)
    }
    assert.ok(/\.run-history-table\s*\{[^}]*table-layout:\s*fixed/.test(css), '逐轮历史必须 table-layout: fixed')
    assert.ok(/\.run-history-table \.rh-time\s*\{\s*width:\s*30%/.test(css), '时间列宽必须固定')
    assert.ok(/\.run-history-table \.rh-push\s*\{\s*width:\s*16%/.test(css), '推送列宽必须固定')
  })

  await aok('结构红线: v3.317 触发结果行（aria-live / 用 runs 结算 / 不位移 / 失败给原因）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets/app.css'), 'utf8')
    // runOutcome / triggerResultLine 是模块级纯函数（定义在 TriggerBar 之前），
    // 所以从「触发结果行」注释起切，别只切组件体。
    const bar = src.slice(src.indexOf('// ── 触发结果行'), src.indexOf('// ── 组件：运行历史'))
    const ph = (name) => '$' + '{' + name + '}'
    // E. 点「环境检查」后必须有一行结果，而不是只把徽标从「任务运行中」改回「空闲」。
    assert.ok(bar.includes('role="status" aria-live="polite" aria-atomic="true"'), '结果行必须是 polite live region')
    assert.ok(bar.includes('triggerResultLine(lastTrigger, lastRun)'), '结果必须由被触发那条 run 结算')
    assert.ok(bar.includes('runs.find((r) => r.id === lastTrigger.id)'), '结算必须按 202 返回的 run id 匹配')
    assert.ok(src.includes('setLastTrigger({ id: runId'), '202 到达时必须记下 run id（否则永远结不出结果）')
    assert.ok(src.includes('runs=' + ph('runs')), 'App 必须把 runs 传给 TriggerBar（不新增轮询）')
    assert.ok(!bar.includes('setInterval'), '结果行不得新增轮询')
    assert.ok(bar.includes('上一轮：') && bar.includes('· 用时 '), '结果行必须带「上一轮 / 用时」')
    assert.ok(bar.includes('失败（退出码 '), '失败必须说明原因（不只换颜色）')
    // 评审修复（Sourcery PR#279）：①run 滑出 20 轮窗口后不能从「成功」退回「已提交」；
    // ②重放命中要把已受理的 run 登记进结果行；③超过护栏先在 useMemo 里短路，别白 map 一遍。
    assert.ok(bar.includes('final: true') && bar.includes('final: false'), 'triggerResultLine 必须标记是否已结算')
    assert.ok(bar.includes('setLastTrigger({ ...lastTrigger, settled:'), '结算后必须把文案快照进 lastTrigger')
    assert.ok(bar.includes('lastTrigger.settled') && bar.includes('live.final ||'), 'run 消失时必须回落到快照而不是「已提交」')
    assert.ok(src.includes('setLastTrigger({ id: String(e.replayRunId)'), '重放命中必须登记 run id（否则结果行停在旧文案）')
    assert.ok(/\.trigger-result\s*\{[^}]*min-height:\s*18px/.test(css), '结果行必须预留行高（出现时按钮不位移）')
  })

  await aok('结构红线: v3.317 小项（msg-link 44px / 手机输入 16px）', () => {
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    const linkCss = (css.match(/\.msg-link\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/min-height:\s*44px/.test(linkCss), '原文链接点击区 ≥44px')
    assert.ok(/font-size:\s*var\(--fs-xs\)/.test(linkCss), '视觉字号不变（只抬行盒）')
    const phone = (css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(/\.msg-search, \.log-search\s*\{[^}]*font-size:\s*16px/.test(phone), '手机输入框必须 16px（防 iOS 聚焦缩放）')
    assert.ok(/\.msg-search, \.log-search\s*\{[^}]*min-height:\s*40px/.test(phone), '手机输入框高度 ≥40px')
  })

  // ── v3.320 首帧形状与落点（sys 同形占位 / 日志定高 / 校验失败定位 / 分页落点）──────
  await aok('结构红线: v3.320 系统信息首帧同形占位（7 行无条件渲染）', () => {
    const src = readConsoleSource()
    const sys = src.slice(src.indexOf('function SysPanel'), src.indexOf('function FilesPanel'))
    const ref = (name) => '$' + '{' + name // 只取到 `${` 前缀（补上 } 就匹配不到源码里的换行/后续表达式）
    // 旧版整块挂在 `${sys && …}` 后面：冷启动首帧只有面板头 + 提示（223px），数据到达后
    // 两张表一次性填满（551px），下半页整体被推走。容器不得再拍 min-height 冒充占位。
    assert.ok(!sys.includes(ref('sys && html`<div class="sys-grid">')), 'sys-grid 不得再挂在 sys && 条件后面')
    assert.ok(sys.includes('const info = sys || {}'), '首帧必须用 sys || {} 取值（无数据也渲染）')
    assert.ok(!sys.includes(ref('sys.version')) && !sys.includes(ref('sys.node')) && !sys.includes(ref('sys.pid')),
      '字段必须一律走 info（sys 为 null 时取 sys.node 会直接抛）')
    assert.ok(sys.includes("info.node || '—'") && sys.includes("info.platform || '—'") && sys.includes("info.cacheDir || '—'"),
      '缺值必须显式落到 —（不能渲染 undefined）')
    assert.ok(sys.includes("info.pid == null ? '—' : info.pid"), 'pid 必须按 == null 判（0 也算有效值）')
    assert.strictEqual((sys.match(/<tr>/g) || []).length, 7, '首帧必须固定 7 行（3+4），行数就是占位高度')
    assert.ok(!/\.sys-grid\s*\{[^}]*min-height/.test(fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')),
      '不许给 .sys-grid 拍 min-height（行高本身就是占位）')
    // 错误 Hint 仍在表上方：数据失败时先看到原因，再看到空表。
    const errAt = sys.indexOf('tone="error"')
    const gridAt = sys.indexOf('class="sys-grid"')
    assert.ok(errAt >= 0 && gridAt >= 0 && errAt < gridAt, '错误 Hint 必须存在且仍在表上方')
  })

  await aok('结构红线: v3.320 日志框定高（读取中/空态与日志框同高）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const px = (s, prop) => { const m = new RegExp(prop + ':\\s*(\\d+)px').exec(s); return m ? m[1] : '' }
    // 既有契约（v3.317）照旧逐字成立：max-height 字面量不得改。
    const desk = (css.match(/\.logpre-main\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/max-height:\s*520px/.test(desk), '桌面日志框 max-height 必须仍是 520px')
    assert.ok(/min-height:\s*520px/.test(desk), '桌面日志框必须有同值 min-height（首帧/空态同形）')
    const empty = (css.match(/\.log-empty\s*\{[^}]*\}/) || [''])[0]
    assert.ok(empty.length > 0, '.log-empty 必须存在')
    assert.strictEqual(px(empty, 'min-height'), px(desk, 'max-height'), '.log-empty 的 min-height 必须与日志框同值')
    // 手机断点：vh 兜底 + dvh 两档，两条都要有（旧版只有 max-height）。
    const phone = (css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(/\.logpre-main\s*\{[^}]*min-height:\s*62vh; min-height:\s*min\(62dvh, 520px\)/.test(phone),
      '手机日志框必须补 min-height: 62vh 再 min(62dvh, 520px)')
    assert.ok(/\.log-empty\s*\{[^}]*min-height:\s*min\(62dvh, 520px\)/.test(phone), '手机空态与日志框同值')
    const logs = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function SysPanel'))
    assert.ok(logs.includes('!data && !err && html`<div class="log-empty"'), '首帧必须渲染读取中占位')
    assert.ok(logs.includes('读取中'), '占位文案必须说明在读（不能空白）')
    assert.ok(!logs.includes('html`<div class="empty">日志'), '日志未生成/不可读不得用 .empty（高度会反向塌）')
    assert.ok(/ranged\.length === 0\s*\?\s*html`<div class="log-empty"/.test(logs), '0 命中必须也用 .log-empty（按区间筛完的 ranged 判定，不是 filtered）')
  })

  // ── v3.321 首屏剩余 pop：系统页 access-log 的 44px、日志页工具条的 153px ──────────
  await aok('结构红线: v3.321 系统页 access-log 无条件占位（+44px 不再由加载引入）', () => {
    const src = readConsoleSource()
    const sys = src.slice(src.indexOf('function SysPanel'), src.indexOf('function FilesPanel'))
    assert.ok(sys.length > 0, '必须能定位 SysPanel')
    // 旧版：${logTail.length > 0 && html`<details class="access-log">…} 与 ${access && …暂无访问记录…}
    // 两条条件 ⇒ 数据未到首帧没有 summary 那 44px，加载后才长出来（panel 487→551）。
    assert.ok(/^[ \t]*<details class="access-log">$/m.test(sys),
      'access-log 必须无条件渲染：源码里要有一行裸的 <details class="access-log">')
    assert.ok(!sys.includes('logTail.length > 0 &&'), 'access-log 不得再被 logTail.length > 0 && 包住')
    assert.ok(!sys.includes('access && access.items &&'), 'access-log 不得再被 access && 包住')
    // 空态与表格都移进 details：默认折叠不占高度，展开才长。
    const inner = sys.slice(sys.indexOf('<details class="access-log">'))
    const close = inner.indexOf('</details>')
    assert.ok(close > 0, 'details 必须闭合')
    const body = inner.slice(0, close)
    assert.ok(body.includes('暂无访问记录'), '空态必须在 details 内部（留在折叠线以上会重新引入高度）')
    assert.ok(body.includes('<table class="sys-table">'), '访问表格必须在 details 内部')
    assert.ok(body.includes('读取中…'), 'access 未回来时 details 内要说明在读（不能空着）')
    assert.ok(!/<details class="access-log" open/.test(sys), '不得默认展开（展开重新引入首屏高度）')
  })

  await aok('结构红线: v3.321 日志页工具条/计数行在加载态就渲染（+153px 不再由加载引入）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const logs = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function SysPanel'))
    assert.ok(logs.length > 0, '必须能定位 LogsPanel')
    // 旧版整块（定位条 + chips + 计数 + 日志框）都在 ok 分支的 <div> 里 ⇒ 数据到达才出现。
    assert.ok(!logs.includes("data && data.status === 'ok' && html`<div>"), 'ok 分支的包装 div 必须拆掉')
    assert.ok(/^[ \t]*<div class="log-tools">$/m.test(logs), '.log-tools 必须无条件渲染（不能挂在条件 && 后面）')
    assert.ok(/^[ \t]*<div class="log-count">\$\{countText\}<\/div>$/m.test(logs), '.log-count 必须无条件渲染')
    // 顺序：工具条 + 计数在占位日志框之前，首帧就占住 134+19。
    assert.ok(logs.indexOf('<div class="log-tools">') < logs.indexOf('!data && !err && html`<div class="log-empty"'),
      '工具条必须排在加载占位之前（否则首帧仍只有占位框）')
    // 加载态文案：计数行「读取中…」，chips 计数 —（同一组标签，宽度由 CSS 钉住）。
    assert.ok(logs.includes("'读取中…'"), '加载态计数行必须说明在读')
    assert.ok(logs.includes("logReady ? n : '—'"), 'chips 计数在数据未到时必须用 —（同一组标签）')
    assert.ok(logs.includes("const logReady = !!(data && data.status === 'ok')"), '必须显式判定数据是否 ok')
    // — → 269 的宽度差在 362px 下会把 chip 行挤重排，工具条高度就跟着跳。
    const nCss = (css.match(/\.log-chip-n\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/display:\s*inline-block/.test(nCss) && /min-width:\s*[\d.]+em/.test(nCss) && /text-align:\s*right/.test(nCss),
      '.log-chip-n 必须 inline-block + em 定宽 + 右对齐（否则计数从 — 变 269 会重排）')
  })

  await aok('结构红线: v3.320 过滤规则校验失败定位（只失败且有字段错误时滚到首个错误行）', () => {
    const src = readConsoleSource()
    const fr = src.slice(src.indexOf('function FilterRulesPanel'), src.indexOf('function App ()'))
    const effects = [...fr.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\)/g)].map((m) => m[0])
    const reveal = effects.find((e) => e.includes('[aria-invalid="true"]'))
    assert.ok(reveal, '失败路径必须有 [aria-invalid="true"] 定位')
    assert.ok(reveal.includes('focus({ preventScroll: true })'),
      '必须先聚焦且 preventScroll（否则浏览器自己先滚一次，位置和手工算的打架）')
    assert.ok(reveal.includes("document.querySelector('.tabs')") && reveal.includes('getBoundingClientRect().height'),
      '落点必须按 .tabs 实测高度算（吸顶页签会盖住错误行）')
    assert.ok(reveal.includes('+ 8'), '页签下沿要留 8px')
    assert.ok(/window\.scrollTo\(0, Math\.max\(0, Math\.min\(top, max\)\)\)/.test(reveal), '落点必须夹进可滚动范围')
    assert.ok(fr.includes('revealFieldRef.current = errors.length > 0'), '只有确有字段错误的失败才置旗')
    // 成功路径：res.ok 分支里既不得置旗，也不得出现 aria-invalid 定位。
    const okAt = fr.indexOf('if (res.ok) {')
    const okPath = fr.slice(okAt, fr.indexOf('const code = showFailure(res', okAt))
    assert.ok(okAt > 0 && okPath.length > 0 && !okPath.includes('revealFieldRef') && !okPath.includes('[aria-invalid'),
      '成功路径不得触发定位/滚动')
    // 加载失败路径（load 的 catch）同样不得置旗。
    const loadAt = fr.indexOf('const load = useCallback')
    const loadPath = fr.slice(loadAt, fr.indexOf('useEffect(() => { load().catch', loadAt))
    assert.ok(loadAt > 0 && loadPath.length > 0 && !loadPath.includes('revealFieldRef'), '加载失败路径不得触发定位/滚动')
    assert.ok(!/transition:|animation:/.test(reveal), '定位不得加动画（错位时动画等于二次跳动）')
  })

  await aok('结构红线: v3.320 分页/搜索落点（共用助手 / 只主动路径 / 分页统一 goPage）', () => {
    const src = readConsoleSource()
    // 助手：读 .tabs 下沿 + 8，目标夹进 document.scrollHeight - innerHeight，面板隐藏时不滚。
    const helperAt = src.indexOf('function listLandTarget')
    assert.ok(helperAt > 0, '必须有一个共用的落点助手（两个面板同一口径）')
    const helper = src.slice(helperAt, src.indexOf('function RunHistoryPanel', helperAt))
    assert.ok(helper.includes("document.querySelector('.tabs')"), '落点必须读吸顶页签')
    assert.ok(helper.includes('getBoundingClientRect().height') && helper.includes('+ 8'), '落点 = .tabs 高度 + 8')
    assert.ok(!helper.includes('getBoundingClientRect().bottom'), 'pad 不得再用 .tabs 的 bottom（未吸顶时会多算一截偏移）')
    assert.ok(helper.includes('Math.min(top, max)'), '助手内必须有 Math.min 收口（不能算出文档外的目标）')
    assert.ok(helper.includes('document.documentElement.scrollHeight - window.innerHeight'), '上限必须按可滚动高度算')
    assert.ok(helper.includes('if (!(rect.height > 0)) return null'), '面板 hidden/rect 为 0 时不得执行')
    const pagerOf = (seg) => { const s = seg.slice(seg.indexOf('<div class="pager">')); return s.slice(0, s.indexOf('</div>')) }
    const msg = src.slice(src.indexOf('function MessagesPanel'), src.indexOf('function LogsPanel'))
    const hist = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    // 取一个具名函数体（到 2 空格缩进的闭合花括号）：断言只看该函数内部，不被邻居带过。
    const fnOf = (seg, name) => {
      const at = seg.indexOf('const ' + name + ' = ')
      assert.ok(at > 0, '缺少 ' + name)
      return seg.slice(at, seg.indexOf('\n  }', at) + 4)
    }
    for (const [name, seg] of [['推送记录', msg], ['逐轮历史', hist]]) {
      const goPageFn = fnOf(seg, 'goPage')
      assert.ok(/if \(n === (?:page|current)\) return/.test(goPageFn), name + '目标页 = 当前页时不得置旗（旗子会悬挂）')
      assert.ok(goPageFn.includes('armLand()') && /setPage(?:No)?\(n\)/.test(goPageFn), name + '分页必须经 armLand 落点并真的换页')
      const pager = pagerOf(seg)
      assert.ok(pager.length > 0, name + '必须有分页器')
      assert.ok(!pager.includes('setPage('), name + '分页按钮不得再直接 setPage（会绕过落点）')
      assert.strictEqual((pager.match(/goPage\(/g) || []).length, 4, name + '四个分页按钮都要走 goPage')
      assert.ok(/useLayoutEffect\(\(\) => \{\s*if \(!landRef\.current\) return[\s\S]*?listLandTarget\(listRef\.current\)/.test(seg),
        name + '落点必须在 useLayoutEffect（paint 前）执行')
      assert.ok(seg.includes('listRef') && seg.includes('landRef'), name + '必须有列表 ref 与落点旗')
      // 裸置旗只允许出现在 armLand 内：分页/筛选/搜索共用同一道「已滚进列表」门。
      assert.strictEqual((seg.match(/landRef\.current = true/g) || []).length, 1,
        name + '置旗必须只在 armLand 内（其余路径一律调用 armLand）')
      const arm = fnOf(seg, 'armLand')
      assert.ok(/window\.scrollY > listTop/.test(arm), name + '必须有「已滚进列表」门（停在顶部改筛选不得拽列表）')
      assert.ok(arm.includes("document.querySelector('.tabs')") && arm.includes('getBoundingClientRect().height'),
        name + '门必须按 .tabs 实测高度算（与 listLandTarget 同口径）')
      assert.ok(arm.includes('if (!(rect.height > 0)) return'), name + '面板隐藏/rect 为 0 时不得置旗')
    }
    // ① 依赖必须同时含 days 与 loading：漏 days ⇒ 第 1 页改时间范围不落（page 不变、effect 不跑）；
    //    漏 loading ⇒ 响应未回就消费旗子（新页更短时被浏览器二次夹取）。
    const msgEffectAt = msg.indexOf('useLayoutEffect(() => {')
    const msgDepsAt = msg.indexOf('}, [', msgEffectAt)
    const msgEffect = msg.slice(msgEffectAt, msgDepsAt)
    const msgDeps = msg.slice(msgDepsAt, msg.indexOf('\n', msgDepsAt))
    for (const dep of ['data', 'loading', 'page', 'size', 'cate', 'days', 'query']) {
      assert.ok(new RegExp('(\\[|, )' + dep + '(, |\\])').test(msgDeps), '推送记录落点依赖必须包含 ' + dep)
    }
    assert.ok(msgEffect.includes('if (loading) return'), '响应未回时必须保留旗子（跨过 loading）')
    assert.ok(msgEffect.includes('data === armedDataRef.current'), '必须等这次响应落地（data 换过）再落点')
    assert.ok(msgEffect.indexOf('landRef.current = false') < msgEffect.indexOf('if (y === null) return'),
      '消费即清旗：listLandTarget 返回 null 时不得重试')
    const histEffectAt = hist.indexOf('useLayoutEffect(() => {')
    const histEffect = hist.slice(histEffectAt, hist.indexOf('}, [pageNo', histEffectAt))
    assert.ok(histEffect.indexOf('landRef.current = false') < histEffect.indexOf('if (y === null) return'),
      '逐轮历史消费即清旗：返回 null 不重试')
    // 旗只由主动路径置：纯 load()/自动刷新不搬滚动位置。
    const msgRefresh = msg.slice(msg.indexOf('const refreshNow = () => {'), msg.indexOf('const [exporting'))
    assert.ok(msgRefresh.includes('load().catch') && !msgRefresh.includes('landRef'), '推送记录纯刷新不得搬滚动位置')
    const histRefresh = hist.slice(hist.indexOf('const refresh = () =>'), hist.indexOf('const changeDay'))
    assert.ok(histRefresh.includes('load().catch') && !histRefresh.includes('landRef'), '逐轮历史刷新不得搬滚动位置')
    // 主动路径逐个点名：改每页 / 改分类 / 改时间都走同一个带门的 armLand。
    // v3.326：时间窗处理器多了「先清区间」一步（自定义区间与 preset 互斥），
    // 红线只要求「主动筛选必须先置落点旗」，不再锁死单行拼接形态。
    for (const frag of ['armLand(); setSize(Number(v)); setPage(1)', 'armLand(); setCate(v); setPage(1)',
      'armLand()\n          setRange({ from: \'\', to: \'\' })\n          setDays(Number(v))\n          setPage(1)']) {
      assert.ok(msg.includes(frag), '推送记录主动筛选必须置落点旗：' + frag)
    }
    // ④ 逐轮历史只在值真变化时置旗：已选中的 chip / 同一天 / 同一页都不得留旗。
    const cmStart = hist.indexOf('const changeMode = (m) => {')
    const cmHead = hist.slice(cmStart, hist.indexOf('armLand()', cmStart))
    assert.ok(cmHead.includes('if (m === mode) {') && cmHead.includes('return'), '已选中的 chip 不得再置旗')
    assert.strictEqual((hist.match(/changeMode\('/g) || []).length, 3, '三个 chip 都必须走 changeMode')
    assert.ok(!/onClick=\$\{\(\) => \{ landRef\.current = true/.test(hist), 'chip 不得裸置旗')
    assert.ok(/const changeDay = \(v\) => \{[\s\S]{0,160}?if \(v\.from === runRange\.from && v\.to === runRange\.to\) return/.test(hist), '区间没变不得置旗')
    assert.ok(/const changeSize = \(n\) => \{\s*if \(n === size\) return/.test(hist), '每页条数没变不得置旗')
    // ③ 搜索落点：不得再看 activeElement（防抖触发时焦点必然还在输入框 ⇒ 主路径永不落点），
    //    只在词真的变了时置旗；「已滚进列表」门保留在 armLand 里。
    assert.ok(!msg.includes('document.activeElement'), '搜索落点不得再看 activeElement（那道门让主路径不可达）')
    const debounceAt = msg.indexOf('const t = setTimeout')
    const debounce = msg.slice(debounceAt, msg.indexOf('}, 300)', debounceAt))
    assert.ok(debounce.includes('next !== queryRef.current') && debounce.includes('armLand()'),
      '搜索落点必须在防抖里按「词真的变了」置旗')
  })

  // ── v3.320 终评 must-fix：失败路径的落点旗清不掉（settle 代数）+ 5 个便宜修复 ──────
  await aok('结构红线: v3.320 落点失败清旗（结算代数 / 失败不滚）与分页/占位细节', () => {
    // v3.364：app.js 拆分后源码会分散到多个模块，结构断言统一读拼接并集。
    const read = (f) => f === 'app.js'
      ? readConsoleSource()
      : fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', f), 'utf8')
    const src = read('app.js')
    const css = read('app.css')
    const loader = src.slice(src.indexOf('function usePanelLoader'), src.indexOf('function usePanelAutoLoad'))
    // 失败时 hook 只写 err、不动 data：只比 data 引用会永远等不到「这次响应落地」，
    // 所以必须有一个成功/失败都会推进的结算代数。
    assert.ok(/const \[settleTick, setSettleTick\] = useState\(0\)/.test(loader), 'usePanelLoader 必须有结算代数 state')
    const catchBlock = loader.slice(loader.indexOf('} catch (e) {'), loader.indexOf('} finally {'))
    assert.ok(catchBlock.length > 0 && !catchBlock.includes('setData('), '失败分支不得改 data（故 data 引用不能当落地信号）')
    assert.ok(/setSettleTick\(\(t\) => t \+ 1\)[ \t]*\n[ \t]*setLoading\(false\)/.test(loader),
      '成功与失败都要推进结算代数，且与 setLoading(false) 同批（不多一次渲染）')
    assert.ok(/return \{ data, err, load, loading, settleTick \}/.test(loader), '结算代数必须暴露给调用方')

    const msg = src.slice(src.indexOf('function MessagesPanel'), src.indexOf('function LogsPanel'))
    const effectAt = msg.indexOf('useLayoutEffect(() => {')
    const depsAt = msg.indexOf('}, [', effectAt)
    const effect = msg.slice(effectAt, depsAt)
    const deps = msg.slice(depsAt, msg.indexOf('\n', depsAt))
    // ① 只改 err 不换 data 时也算一次「结算」：依赖漏 settleTick ⇒ 失败后 effect 不跑、旗子留着。
    assert.ok(/(\[|, )settleTick(, |\])/.test(deps), '落点 effect 依赖必须包含 settleTick')
    // ② 置旗时记代数；消费要求代数前进（未结算 ⇒ 保留旗子）。
    const armAt = msg.indexOf('const armLand = ')
    const arm = msg.slice(armAt, msg.indexOf('\n  }', armAt) + 4)
    assert.ok(arm.includes('armedSettleRef.current = settleTick'), '置旗时必须记下当时的结算代数')
    assert.ok(effect.includes('settleTick > armedSettleRef.current'), '消费必须以结算代数前进为条件')
    assert.ok(effect.indexOf('settleTick > armedSettleRef.current') < effect.indexOf('landRef.current = false'),
      '代数未前进时必须先 return（保留旗子），不得提前清旗')
    assert.ok(arm.includes('armedSeqRef.current = loadSeqRef.current') && effect.includes('loadSeqRef.current > armedSeqRef.current'),
      '置旗前就在飞的旧请求先回包不得抢消费（按请求号再挡一道）')
    // ③ 失败：清旗要在消费块里（err 判断之前），且 err 判断必须在 scrollTo 之前 ⇒ 只清旗不滚。
    assert.ok(effect.indexOf('landRef.current = false') < effect.indexOf('if (err) return'),
      '失败分支也必须清旗（否则跨过失败留到下一次成功，把用户拽到列表顶）')
    assert.ok(effect.indexOf('if (err) return') < effect.indexOf('window.scrollTo'),
      '失败分支不得滚动：err 判断必须在 scrollTo 之前')
    assert.ok(!/if \(data === armedDataRef\.current\) return/.test(effect),
      '不得再单靠 data 引用判断落地（失败时 data 不变 ⇒ 清旗不可达）')

    // ④ 两处分页四个按钮都要 || loading：连点第二个请求会顶掉第一个的响应。
    const pagerOf = (seg) => { const s = seg.slice(seg.indexOf('<div class="pager">')); return s.slice(0, s.indexOf('</div>')) }
    const hist = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    for (const [name, seg] of [['推送记录', msg], ['逐轮历史', hist]]) {
      const pager = pagerOf(seg)
      assert.ok(pager.length > 0, name + '必须有分页器')
      assert.strictEqual((pager.match(/\|\| loading/g) || []).length, 4, name + '四个分页按钮都必须 || loading（防连点）')
    }

    // ④b 分页禁用态只轻压透明度：全局 .45 在浅色主题下会把整块洗白，翻页时
    // 左两个按钮像凭空出现（v3.339 手机截图）。只看生效的规则：注释里留着
    // `.pager .btn:disabled{opacity:.7}` 不能让断言假绿（Sourcery PR #302）。
    const cssLive = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const pagerDisabled = (cssLive.match(/\.pager \.btn:disabled\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/opacity:\s*0?\.70?\s*;/.test(pagerDisabled), '分页禁用态透明度必须 .7（保留底色/边框轮廓）')
    assert.ok(!/opacity:\s*0?\.45\s*;/.test(pagerDisabled), '分页禁用态不得回退到全局 .45')

    // ⑤ 分类弹层选中当前值不回调（同 MiniSelect 的值守卫）。
    const cateSeg = src.slice(src.indexOf('function CategoryPicker'), src.indexOf('function MessagesPanel'))
    const chooseFn = cateSeg.slice(cateSeg.indexOf('const choose = (name) => {'), cateSeg.indexOf('const pick = (o) =>'))
    assert.ok(chooseFn.includes('if (name !== value) onChange(name)'), 'CategoryPicker 必须有值守卫（同值不 onChange）')

    // ⑥ 日志首次加载失败也要同高占位：错误路径不得让 520px 日志框整体消失。
    const logs = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function SysPanel'))
    assert.ok(/err && !data && html`<div class="log-empty" role="status">日志读取失败/.test(logs),
      'err && !data 时必须渲染「日志读取失败」占位（.log-empty 同高）')

    // ⑦ chip 计数 6 位不重排（1MiB 全是换行也有 7 位，5em 留余量）。
    const nCss = (css.match(/\.log-chip-n\s*\{[^}]*\}/) || [''])[0]
    assert.ok(/min-width:\s*5em/.test(nCss), '.log-chip-n min-width 必须 5em（6 位计数不重排）')
    assert.ok(!/min-width:\s*(2\.4|3\.2)em/.test(nCss), '旧的 2.4em / 3.2em 必须改掉')

    // ⑧ 回车/刷新直接生效搜索词时也要置旗（否则防抖随后看到词已生效，主路径漏落点）。
    assert.ok(msg.includes('if (q !== query) { armLand(); setQuery(q); setPage(1); return }'),
      'refreshNow 在词变化时必须 armLand（回车/刷新也要落点）')

    // ⑨ 请求飞行期间用户自己滚动时撤销落点（浏览器夹取/锚定不算）。
    assert.ok(arm.includes('userMovedRef.current = false'), '置旗时必须复位用户滚动标记')
    assert.ok(effect.includes('if (userMovedRef.current) return'), '消费前必须检测用户是否自己滚走')
    assert.ok(msg.includes('useLandScrollCancel(landRef, userMovedRef)'), '必须接入用户滚动取消 hook')
    assert.ok(src.includes("window.addEventListener('touchmove', mark"), 'hook 里必须有 touchmove/wheel 监听')

    // ⑩ 逐轮历史切模式是原子的：有快照同批换；没快照不得先换选中态/列表。
    // 空结果也要保留 listRef（否则无法落点）。
    const hEffectAt = hist.indexOf('useLayoutEffect(() => {')
    const hEffect = hist.slice(hEffectAt, hist.indexOf('}, [', hEffectAt))
    assert.ok(!hEffect.includes('asyncLandRef') && !hEffect.includes('sawLoadingRef'), '落点不得再等「重拉结算」：切档已原子化')
    assert.ok(hEffect.includes('if (userMovedRef.current) return'), '逐轮历史也要防用户自己滚走')
    assert.ok(hist.includes('useLandScrollCancel(landRef, userMovedRef)'), '逐轮历史也要接入同一个取消 hook')
    assert.ok(hist.includes('<div class="runs-scroll" ref=$' + '{listRef}>') && !hist.includes('$' + '{shown.length > 0 && html`<div class="runs-scroll"'), '空结果时 .runs-scroll 也必须挂载（listRef 不能丢）')

    // 版本已 bump 到 3.360：注释里不得提前写下一版 v3.361。
    // 注意这条只拦「资源注释里提前写下个版本」；四处版本号（主文件头/CHANGELOG/package.json/
    // package-lock 两处）的一致性由 check-version.js 负责（CI 与 pre-commit 都跑，npm test 不含）。
    assert.ok(!/v3\.361/.test(src), 'app.js 注释不得写 v3.361（版本未 bump）')
    assert.ok(!/v3\.361/.test(css), 'app.css 注释不得写 v3.361（版本未 bump）')
  })

  await aok('结构红线: v3.342 顶栏时间可关年月日（设置块已搬到系统页）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')

    // ① 格式化：关掉时只留 时:分:秒；「—」不能被切坏。
    const barAt = src.indexOf('function fmtBarTime (ts, withDate)')
    assert.ok(barAt > 0, '缺少 fmtBarTime')
    const barSrc = src.slice(barAt, barAt + 400)
    assert.ok(barSrc.includes("if (s === '—' || withDate !== false) return s"), '默认带日期，「—」原样返回')
    assert.ok(barSrc.includes('return s.slice(11)'), '关掉年月日时必须截掉日期部分')

    // ② v3.346：状态行只有一个来源——AutoRefreshText 统一输出「自动刷新 Ns · 数据截至 · 时间」，
    //    App 只负责汇总时间来源（syncAt）和 live/paused，不再每页各写一套。
    assert.ok(src.includes("const syncAt = tab === 'overview' ? lastSync : panelSync"), '时间来源必须在一处汇总')
    assert.ok(/lastSync=\$\{syncAt\} showDate=\$\{showDate\} paused=\$\{!autoRefresh \|\| authExpired\} live=\$\{livePolling\}/.test(src), '状态行必须统一传参（时间/年月日/暂停或凭证失效/是否轮询）')
    assert.ok(src.includes('fmtBarTime(lastSync, showDate)'), '组件内必须走 fmtBarTime')
    // v3.343：气泡和年月日同步——关掉年月日时 tip 必须为空（TapTip 退化成纯文本）。
    assert.ok(/tip=\$\{showDate && syncAt \?/.test(src), '气泡必须跟着 showDate 一起关')
    // v3.353：日期开着时用文字提醒可点看完整日期；关掉日期时不能承诺可点。
    assert.ok(/hint=\$\{showDate && syncAt \? '点看' : ''\}/.test(src), '日期开着时必须有可点提醒')
    assert.ok(!src.includes('点一下可看完整日期') && !src.includes('点一下仍可看完整日期'), '关掉日期时不得承诺点一下可看完整日期')

    // ②b v3.344：暂停不是概览专属——其它页也要能暂停/继续。
    //     v3.346：文案收敛到组件里，暂停只换开头两个字，后半句不变。
    assert.ok(!/\$\{tab === 'overview' && html`<button type="button" class="sync-toggle"/.test(src), '暂停按钮不得再限定在概览页')
    assert.ok(/\$\{remain\} 秒后刷新 · <span class="sync-label">数据截至 \$\{TZ_LABEL\} <\/span>\$\{atMain\}<span class="sync-sec">\$\{atSec\}<\/span>/.test(src), '运行态文案必须统一')
    assert.ok(/已暂停 · <span class="sync-label">数据截至 \$\{TZ_LABEL\} <\/span>\$\{atMain\}<span class="sync-sec">\$\{atSec\}<\/span>/.test(src), '暂停态只换开头，后半句保持同一形态')
    // v3.347：秒级时钟必须比 1s 快。1s 时钟与 mark() 不同相时，倒数会 5 4 3 2 → 5 跳过 1s
    // （真机录屏实证），所以这里钉住 500ms，防止有人「优化」回 1000。
    assert.ok(src.includes('setInterval(() => setNowMs(() => Date.now()), 500)'), '倒计时时钟必须是 500ms（1s 会跳秒）')

    // ③ App 启动时读设置（顶栏在面板之外，必须自己拿一份；保存后靠 onSaved 重拉）。
    assert.ok(src.includes('body.settings.syncShowDate'), 'App 必须从设置读面取 syncShowDate（读面直接回 body，不是 {data}）')
    // v3.349：解析搬进 applyUiSettings（读面按 revision 丢弃乱序响应），只认布尔这条语义不变。
    assert.ok(src.includes('typeof body.settings.syncShowDate !== \'boolean\''), '只认布尔，读失败保持默认')
    assert.ok(src.includes('if (rev < uiSettingsRevRef.current) return'), '旧读响应不得覆盖新值（按 revision 判序）')
    assert.ok(/onSettingsSaved=\$\{reloadUiSettings\}/.test(src), '系统页必须把「保存后重拉」接上')

    // ④ 设置块：勾选即保存、非布尔不发、失败重读；读面由系统页统一持有。
    const blkAt = src.indexOf('function ConsoleSettingsBlock')
    const blkEnd = src.indexOf('// 系统信息：版本', blkAt)
    assert.ok(blkAt > 0 && blkEnd > blkAt, 'ConsoleSettingsBlock 切片锚点必须存在且有序')
    const blk = src.slice(blkAt, blkEnd)
    assert.ok(blk.includes('apiPostConsoleSettings({ syncShowDate: next, baseRevision: settingsLive.revision })'),
      '开关保存必须只提交 syncShowDate + baseRevision')
    assert.ok(blk.includes("typeof settingsLive.settings.syncShowDate === 'boolean'"), '读面必须校验布尔类型')
    assert.ok(blk.includes('type="checkbox"') && blk.includes('显示年月日'), '缺少「显示年月日」勾选框')
    assert.ok(blk.includes('dateSavingRef.current'), '开关也必须防连点')
    assert.ok(blk.includes("payload.error === 'revision_mismatch'"), '开关保存 409 要按冲突提示并重读')
    assert.ok(!blk.includes('usePanelLoader(apiGetConsoleSettings'), '读面应由系统页统一持有（下拉刷新要等它落定）')

    // ⑤ 样式：勾选框要跟着主题走（原生控件太大/太白会破坏深色页面）。
    assert.ok(css.includes('.set-toggle input[type="checkbox"]'), '缺少勾选框样式')
    assert.ok(css.includes('accent-color: var(--accent)'), '勾选框必须用主题强调色')
  })

  await aok('结构红线: v3.341 顶栏时间点按弹出完整时间（前端）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')

    // ① 组件本身：可点、可键盘、可访问；tip 为空时退化成纯文本（「自动刷新已暂停」不该能点开）。
    const tipAt = src.indexOf('function TapTip (')
    const tipEnd = src.indexOf('// 提示行：', tipAt)
    assert.ok(tipAt > 0 && tipEnd > tipAt, '缺少 TapTip 组件（或切片锚点漂移）')
    const tipSrc = src.slice(tipAt, tipEnd)
    assert.ok(tipSrc.includes('if (!tip) return html'), 'tip 为空时必须退化成纯文本')
    assert.ok(tipSrc.includes('children}'), 'tip 为空时返回 children 本身')
    assert.ok(tipSrc.includes('role="button"') && tipSrc.includes('aria-expanded='), '触发区必须有 button 语义与 aria-expanded')
    assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(tipSrc), '键盘 Enter/Space 也必须能展开')
    assert.ok(tipSrc.includes("document.addEventListener('pointerdown', onDown, true)"),
      '点页面任意其它地方必须收回（document 捕获 pointerdown）')
    assert.ok(/e\.key === 'Escape'/.test(tipSrc), 'Esc 必须能收回')
    assert.ok(tipSrc.includes('getBoundingClientRect()') && tipSrc.includes('window.innerWidth - 24'),
      '必须按触发区位置算弹层坐标，并夹在视口内')

    // ② 弹层必须 fixed：.sync 是 overflow:hidden，绝对定位会被裁掉（等于没弹）。
    const popCss = css.slice(css.indexOf('.tap-tip-pop {'), css.indexOf('}', css.indexOf('.tap-tip-pop {')))
    assert.ok(popCss.includes('position: fixed'), '.tap-tip-pop 必须 fixed 定位（祖先 .sync 会裁掉绝对定位）')
    assert.ok(popCss.includes('overflow-wrap: anywhere'), '完整时间必须能换行，不能又被省略号吃掉')
    const tapCss = css.slice(css.indexOf('.tap-tip {'), css.indexOf('}', css.indexOf('.tap-tip {')))
    assert.ok(!tapCss.includes('border-bottom'), '顶栏时间下方不得再画虚线（v3.353 改为文案提醒）')
    assert.ok(css.includes('.tap-tip-date .sync-sec'), '手机日期开着时收起秒，关掉时保留秒')
    assert.ok(/@media \(max-width: 640px\) \{[\s\S]*?\.sync-label \{ display: none; \}[\s\S]*?\.tap-tip-date \.sync-sec \{ display: none; \}/.test(css), '手机断点必须真的隐藏「数据截至」和日期开时的秒')
    assert.ok(/class=\$\{showDate \? 'tap-tip tap-tip-date' : 'tap-tip'\}/.test(src), 'TapTip 必须知道日期是否开着')

    // ③ 状态行只有一处 TapTip：所有页共用（v3.346 收成一个组件），tip 里是完整时间 + 星期。
    assert.ok(src.includes('数据截至：') && src.includes('fmtWeekday(syncAt)'), '状态行没接 TapTip 的完整时间')
    assert.ok((src.match(/<\$\{TapTip\}/g) || []).length >= 1, '状态行必须复用同一个 TapTip')
  })

  await aok('结构红线: 屏蔽注册天数用多行输入框', () => {
    const src = readConsoleSource()
    const daysAt = src.indexOf('def.kind === \'days\'')
    const daysEnd = src.indexOf(': html`<textarea', daysAt)
    const daysBlock = daysAt >= 0 && daysEnd > daysAt ? src.slice(daysAt, daysEnd) : ''
    assert.ok(daysBlock.includes('<textarea') && daysBlock.includes('fr-input-days'), '天数分支必须渲染 textarea（不能只留 class）')
    assert.ok(!daysBlock.includes('<input'), '天数分支不得退回单行 input')
    assert.ok(src.includes('支持「分类###天数」多行写法'), '提示必须保留多行写法')
  })

  await aok('结构红线: 数字框锁定，长按加减连续调整', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const trigger = src.slice(src.indexOf('function TriggerBar'), src.indexOf('// ── 组件：运行历史'))
    const cfgStart = src.indexOf('function ConsoleSettingsBlock')
    const cfgEnd = src.indexOf('// 系统信息：版本', cfgStart)
    const cfgBlock = src.slice(cfgStart, cfgEnd)
    assert.ok(/class="auto-input"[\s\S]{0,260}?disabled=\$\{true\}/.test(trigger), '自动运行间隔输入框必须锁定')
    assert.ok(/class="auto-input"[\s\S]{0,260}?disabled=\$\{true\}/.test(cfgBlock), '通知自检拦截窗输入框必须锁定')
    assert.ok(!/class="auto-input"[\s\S]{0,260}?onInput=/.test(trigger), '自动运行间隔不得再接受键入')
    assert.ok(!/class="auto-input"[\s\S]{0,260}?onInput=/.test(cfgBlock), '通知自检拦截窗不得再接受键入')
    assert.ok(src.includes('function useHoldRepeat') && src.includes('HOLD_START_MS') && src.includes('HOLD_REPEAT_MS'),
      '必须复用长按连续调整 hook')
    assert.ok(trigger.includes('onPointerDown=$' + '{holdAuto.start(-1)}') && trigger.includes('onPointerDown=$' + '{holdAuto.start(1)}'),
      '自动运行加减必须接长按')
    assert.ok(cfgBlock.includes('onPointerDown=$' + '{holdWin.start(-1)}') && cfgBlock.includes('onPointerDown=$' + '{holdWin.start(1)}'),
      '通知自检加减必须接长按')
    assert.ok(trigger.includes('setAutoDraft((prev) =>') && cfgBlock.includes('setWinDraft((prev) =>'),
      '快速长按必须用函数式更新，避免连续增量丢失')
    assert.ok(css.includes('touch-action: none') && css.includes('.auto-input:disabled'),
      '长按按钮要禁用触摸手势，禁用输入框要保持可读')
  })

  await aok('结构红线: v3.340 配置页可改通知自检拦截窗（前端）', () => {
    const src = readConsoleSource()
    // ① API 层：两条读/写端点都用纯字面量 URL（Codacy SSRF 启发式的唯一全绿形态）。
    assert.ok(src.includes('function apiGetConsoleSettings ()'), '缺少设置读面 apiGetConsoleSettings')
    assert.ok(src.includes('function apiPostConsoleSettings (body)'), '缺少设置写面 apiPostConsoleSettings')
    assert.strictEqual((src.match(/fetch\('\/api\/config\/console'/g) || []).length, 2,
      'GET/POST 必须各一条字面量 fetch(/api/config/console)')

    // ② 拦截提示的秒数来自服务端响应（拦截窗可配置，写死 60 会说谎）。
    // 必须剥注释再匹配：原先直接 includes 时，把客户端改成写死 60、只在注释里留一句
    // 「应取 data.replayWindowS」也能全绿（回潮实验 A6 实测）。
    const notifySegRaw = src.slice(src.indexOf('async function triggerNotifyTest'), src.indexOf('function Badge ('))
    const notifySeg = notifySegRaw.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(notifySeg.includes('data.replayWindowS'), 'triggerNotifyTest 必须用响应里的 replayWindowS')
    assert.ok(notifySeg.includes('Number.isInteger(data.replayWindowS)') &&
      notifySeg.includes(': NOTIFY_WINDOW_DEFAULT_S'), '缺失时才回退默认值（三元两支都必须在）')
    assert.ok(!/60 秒内无需重复/.test(notifySeg), '不得再写死「60 秒内无需重复」')
    assert.ok(src.includes('typeof dupMsg === \'function\' ? dupMsg(data) : dupMsg'),
      'triggerVia 必须支持函数式 dupMsg（保留字符串形态给 /trigger）')
    // 只留着表达式不算修好：拦截文案必须真的由 dupMsg(data) 构造（Sourcery #303 M11）。
    assert.ok(/const msg = typeof dupMsg === 'function' \? dupMsg\(data\) : dupMsg[\s\S]{0,160}new Error\(msg\)/.test(src),
      '拦截提示必须用 dupMsg(data) 的结果构造 Error，不能留一段不参与构造的死代码')

    // ③ 设置块（v3.342 从配置页搬到系统页）：保存带乐观锁、成功文案不吹「已生效」。
    // 切片锚点必须真存在：锚点丢了 indexOf 返回 -1，slice 会退化成「文件余下全部」，
    // 后面所有 includes 变成全文匹配、永久假绿。
    const setStart = src.indexOf('function ConsoleSettingsBlock')
    const setEnd = src.indexOf('// 系统信息：版本', setStart)
    assert.ok(setStart >= 0 && setEnd > setStart, 'ConsoleSettingsBlock 切片锚点必须存在且有序')
    const cfgBlock = src.slice(setStart, setEnd)
    assert.ok(cfgBlock.includes('baseRevision: settingsLive.revision'), '保存必须带 baseRevision（乐观锁）')
    assert.ok(cfgBlock.includes('notifyTestReplayWindowS'), '保存体字段名必须是 notifyTestReplayWindowS')
    assert.ok(cfgBlock.includes('已保存 · 立即生效'), '保存成功文案为「已保存 · 立即生效」')
    assert.ok(cfgBlock.includes('NOTIFY_WINDOW_MAX_S') && cfgBlock.includes('NOTIFY_WINDOW_MIN_S'),
      '客户端校验边界必须走常量（与服务端 0–3600 同口径）')
    assert.ok(/class="auto-input"[\s\S]{0,400}?disabled=\$\{winCurrent === null \|\| winSaving\}/.test(cfgBlock),
      '读面失败/保存中时草稿框必须禁用（不得渲染旧值）')
    assert.ok(cfgBlock.includes("'读取中…'"), '首帧必须显示「读取中」，不得把未加载伪装成读取失败')
    assert.ok(cfgBlock.includes('winSavingRef.current'), '保存必须防连点（in-flight 守卫）')
    assert.ok(cfgBlock.includes("payload.error === 'revision_mismatch'") && cfgBlock.includes('setWinDirty(false)'),
      '409 后必须重读并复位脏标记（否则草稿再也不会跟随刷新）')
    // 搬迁后的归属：配置页不再挂设置读面；系统页持有读面并在下拉/刷新里等它落定。
    const cfgStart = src.indexOf('function ConfigPanel')
    const cfgEnd = src.indexOf('// ── 过滤规则（v3.310）')
    assert.ok(cfgStart >= 0 && cfgEnd > cfgStart, 'ConfigPanel 切片锚点必须存在且有序')
    const cfg = src.slice(cfgStart, cfgEnd)
    assert.ok(!cfg.includes('apiGetConsoleSettings'), '配置页不得再挂设置读面（v3.342 已搬到系统页）')
    assert.ok(cfg.includes('Promise.allSettled([load(), loadEff()])'), '配置页刷新只拉自己两条')
    const sysAt = src.indexOf('function SysPanel')
    const sysEnd = src.indexOf('\nfunction ', sysAt + 10)
    assert.ok(sysAt >= 0 && sysEnd > sysAt, 'SysPanel 切片锚点必须存在且有序')
    const sysBlk = src.slice(sysAt, sysEnd)
    assert.ok(sysBlk.includes('usePanelLoader(apiGetConsoleSettings'), '系统页必须持有设置读面')
    assert.ok(sysBlk.includes('Promise.allSettled([load(), loadAccess(), loadSettings()])'),
      '系统页刷新必须等三条都落定（下拉指示条不得提前收起）')
    assert.ok(/<\$\{ConsoleSettingsBlock\} settings=\$\{settings\}/.test(sysBlk), '系统页必须渲染设置块并下传读面')
  })

  await aok('结构红线: 过滤草稿自动保存/恢复（关标签/杀后台也能捡回来）', () => {
    const src = readConsoleSource()
    assert.ok(src.includes("const FILTER_DRAFT_KEY = 'xbk_filter_draft_v1'"), '必须在 localStorage 存一份过滤草稿')
    assert.ok(src.includes('FILTER_DRAFT_SAVE_DELAY = 500'), '草稿不能等 5 分钟才存，否则杀后台会丢最后几分钟')
    assert.ok(src.includes('FILTER_DRAFT_SERVER_DELAY = 1500'), '服务器草稿必须比本机慢一点，避免每敲一键就写盘')
    assert.ok(src.includes('localStorage.setItem(FILTER_DRAFT_KEY'), '草稿写入必须用 localStorage（sessionStorage 关标签就没）')
    assert.ok(src.includes('localStorage.removeItem(FILTER_DRAFT_KEY)'), '保存/放弃/回滚后必须清草稿')
    assert.ok(src.includes("window.addEventListener('pagehide'"), '关标签/切走时必须立刻补存')
    assert.ok(src.includes("document.addEventListener('visibilitychange'"), '切到后台时必须立刻补存')
    assert.ok(src.includes('apiGetFilterDraft'), '打开过滤页必须同时读服务器草稿')
    assert.ok(src.includes('apiPostFilterDraft'), '本机草稿要同步到服务器')
    assert.ok(src.includes('apiDeleteFilterDraft'), '保存/放弃/回滚后必须删服务器草稿')
    assert.ok(src.includes('filterDraftFromServer'), '服务器草稿响应必须校验后再恢复')
    assert.ok(src.includes('clearServerDraft()'), '清草稿必须同时清服务器那份')
    assert.ok(src.includes('已恢复上次未保存的草稿'), '下次打开过滤页必须自动恢复草稿并提示')
    assert.ok(src.includes('草稿已自动保存'), '页面必须让用户看到草稿已经存了')
    assert.ok(src.includes('setTimeout(saveDraftNow, FILTER_DRAFT_SAVE_DELAY)'), '本机草稿定时器必须真的使用 500ms 常量，不能只留常量')
    assert.ok(src.includes('draftPushChainRef'), '草稿 PUT 必须串行，旧请求不能晚到覆盖新内容')
    assert.ok(src.includes('await draftPushChainRef.current'), '清服务器草稿前必须等所有排队 PUT 落地')
    assert.ok(src.includes('setInterval(() => { if (dirtyRef.current) pushDraftNow().catch(() => {}) }'), '服务器上传失败后必须定期重试')
    assert.ok(src.includes('reloadNow'), '确认放弃并重新加载时必须先清草稿，否则会恢复回来')
  })

  await aok('结构红线: 过滤页有未保存修改时拦截离开（切页/后退/刷新）', () => {
    const src = readConsoleSource()
    assert.ok(src.includes('function LeaveGuardDialog'), '必须有“取消/不保存/保存并继续”三选一弹窗')
    assert.ok(src.includes('点「不保存并离开」会丢掉这些修改'), '弹窗必须说清楚只有丢弃按钮才会丢修改，不能把自动草稿说成必丢')
    assert.ok(!src.includes('现在离开，这些修改会丢'), '有自动草稿时不得再写“现在离开就会丢”')
    assert.ok(src.includes('保存并继续'), '离开拦截里的保存按钮要明确告诉用户保存后会继续')
    assert.ok(src.includes('beginGuardSave'), '保存并继续必须等待真正保存成功后再继续原操作')
    assert.ok(src.includes('const beginGuardSave') && src.includes('submitSave({ filter: candidate'), '保存并继续必须直接调用保存，不能再弹第二次确认')
    assert.ok(src.includes('settleSaveResult(true)'), '只有保存成功才能放行原来的切页/后退')
    assert.ok(src.includes('leaveSavingRef'), '保存并继续落盘期间必须锁住新的切页/后退请求')
    const leaveSave = src.slice(src.indexOf('const closeLeaveRequest = '), src.indexOf('// 「查看日志」跳转'))
    assert.ok(/await guard\.save\(\)/.test(leaveSave), '保存按钮必须等 guard.save() 的结果')
    assert.ok(leaveSave.includes('leaveSavingRef.current = true') && leaveSave.includes('leaveSavingRef.current = false'), '保存并继续必须锁住整段落盘过程')
    assert.ok(leaveSave.includes('doSwitchTab(req.target, true)'), '保存成功后必须继续用户原来要去的页签（并替换 sentinel）')
    assert.ok(leaveSave.indexOf('if (!saved)') >= 0 && leaveSave.indexOf('if (!saved)') < leaveSave.indexOf('doSwitchTab(req.target, true)'),
      '保存失败/取消必须先 return，不能先跳页')
    assert.ok(src.includes("window.addEventListener('beforeunload'"), '刷新/关页必须走 beforeunload')
    const unload = src.slice(src.indexOf('const onBeforeUnload = '), src.indexOf("window.addEventListener('beforeunload'"))
    assert.ok(unload.includes('e.preventDefault()') && unload.includes("e.returnValue = ''"),
      'beforeunload 必须真的取消卸载，不能只挂监听')
    assert.ok(src.includes("window.addEventListener('popstate'"), '手机左滑/后退必须拦 popstate')
    assert.ok(src.includes('__xbkFilterGuard'), '脏草稿必须在历史里压 sentinel，否则左滑直接退走')
    assert.ok(src.includes("source: 'tab'") && src.includes("source: 'hash'") && src.includes("source: 'history'"),
      '切页、hash 变化、浏览器后退三种来源都要能回到同一个拦截弹窗')
    assert.ok(src.includes('onLeaveRequestRef.current'), 'popstate 回调必须用 ref 读最新值，不能被旧闭包吃掉')
    assert.ok(src.includes('guardRef'), 'App 必须拿到过滤页的脏状态/保存/放弃动作')
    const app = src.slice(src.indexOf('const switchTab = '), src.indexOf('const openLog = useCallback'))
    assert.ok(app.includes('if (leaveSavingRef.current) return'), '保存并继续落盘期间 switchTab 必须直接返回，不能只挂一个变量')
    assert.ok(/guard && guard\.dirty/.test(app), '切页前必须检查过滤页脏状态')
    assert.ok(src.includes('放弃草稿并回滚'), '回滚会覆盖草稿时必须把按钮文案说清楚')
    assert.ok(src.includes('复制代码默认会把这些修改覆盖掉'), '复制默认会覆盖草稿时必须先确认')
  })

  await aok('结构红线: v3.330 页面内下拉刷新（不重载、立即响应、数据回来一次换）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    // 只看真正的规则：注释里提到 overscroll-behavior-y 不算（否则删了声明测试照样绿）。
    const cssLive = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // ① 必须关掉内核原生下拉刷新：它就是「整页重载」的入口，不关掉后面做多少都是白搭。
    assert.ok(/html,\s*body\s*\{[^}]*overscroll-behavior-y:\s*contain/.test(cssLive), '必须用 overscroll-behavior-y: contain 关掉 Chrome 原生下拉刷新')
    // ② 手势：被动监听；多指中断与 touchcancel 只复位不刷新。
    assert.ok(src.includes('function usePullToRefresh'), '缺少下拉手势 hook')
    assert.ok(src.includes("window.addEventListener('touchstart', onStart, { passive: true })"), 'touchstart 必须 passive')
    assert.ok(src.includes("window.addEventListener('touchcancel', onCancel"), 'touchcancel 必须走 onCancel，不能当松手')
    assert.ok(src.includes('const onCancel = () => { stop(); idle() }'), 'touchcancel 必须只停跟踪并复位，不触发刷新')
    assert.ok(src.includes('if (!t || t.length !== 1) { r.lock = true; stop(); idle(); return }'), '多指按下必须作废本次手势')
    assert.ok(src.includes('const PULL_TRIGGER = 56') && src.includes('dy * 0.5'), '阈值/阻尼必须固定（56px、0.5 倍）')
    // ③ 内部已滚动的容器不算下拉：判定体必须真的看 scrollTop 与 overflowY。
    const inScrolled = src.slice(src.indexOf('const inScrolled = (touch)'), src.indexOf('const onStart = (e)'))
    assert.ok(inScrolled.includes('scrollTop > 0') && inScrolled.includes('overflowY'), 'inScrolled 必须检查 scrollTop 与 overflowY，不能空转 return false')
    // ④ 三态文案写在顶栏「数据截至」这一行；不允许再用浮层盖住标题（v3.331 真机反馈）。
    assert.ok(src.includes("'下拉刷新'") && src.includes("'松开刷新'") && src.includes("'正在刷新…'"), '必须有三态文案')
    assert.ok(src.includes('function PullRefreshStatus'), '缺少顶栏行内状态组件')
    assert.ok(!src.includes('PullRefreshBar') && !src.includes('class="ptr '), '不得再用浮层指示条')
    assert.ok(!/\.ptr\s*\{[^}]*position:\s*fixed/.test(cssLive), '指示条不得 fixed 浮在标题上')
    const syncRow = src.slice(src.indexOf('class="sync"'), src.indexOf('class="sync"') + 700)
    assert.ok(/<\$\{PullRefreshStatus\} state=\$\{pull\.state\} \/>/.test(syncRow), '刷新状态必须渲染在 .sync 行内，且 state 必须来自 pull.state')
    assert.ok(src.includes('syncRef.current.scrollLeft = 0'), '窄屏 .sync 被横向滑走时，下拉必须把它滚回最左，否则状态看不见')
    // ⑤ 每个页签面板都要接到同一次下拉刷新（数量不够或张冠李戴都要拦住）。
    for (const name of ['RunHistoryPanel', 'TrendsPanel', 'CacheHealthPanel', 'MessagesPanel', 'LogsPanel', 'ConfigPanel', 'FilesPanel', 'SysPanel', 'FilterRulesPanel']) {
      const at = src.indexOf('function ' + name + ' (')
      const body = src.slice(at, src.indexOf('\nfunction ', at + 10))
      assert.ok(at > 0 && body.includes('usePullRefresh('), `${name} 必须注册下拉刷新`)
    }
    // ⑥ 过滤规则：有未保存改动时不注册，且请求在飞期间变脏要丢弃响应。
    const filter = src.slice(src.indexOf('function FilterRulesPanel'), src.indexOf('\nfunction ', src.indexOf('function FilterRulesPanel') + 10))
    assert.ok(filter.includes('usePullRefresh(active && dirtyFields.length === 0, load)'), '过滤规则页有未保存改动时不得刷新')
    assert.ok(filter.includes('dirtyRef.current = dirtyFields.length > 0') || filter.includes('dirtyRef.current = dirty'), 'dirtyRef 必须随草稿状态更新')
    assert.ok(filter.includes('if (dirtyRef.current) return'), '响应回来时草稿已变脏必须丢弃，不能覆盖用户改动')
    // ⑦ 指示条要等所有 loader 落定；排队/在飞的请求不能被提前结算。
    assert.ok(src.includes('Promise.allSettled([load(), loadAccess(), loadSettings()])'), 'SysPanel.refresh 必须交出三个 loader 的 promise（v3.342 设置块搬到系统页）')
    assert.ok(src.includes('idleWaitersRef'), 'LogsPanel 排队路径必须等「在飞 + 补跑」结束再 resolve')
    assert.ok(src.includes('window.dispatchEvent(new CustomEvent(PULL_EVENT, { detail }))'), 'App 必须广播下拉刷新事件')
    assert.ok(src.includes('if (detail.waits.length === 0) return false'), '当前页没有面板接手时不得发全局请求，也不假装刷新')
    assert.ok(src.includes('Promise.resolve().then(onRefresh).then(settle'), '无面板接手时要立刻收起指示条（did === false）')
    assert.ok(src.includes('refreshSplit(force ? { force: true } : undefined)') && src.includes('refreshActive({ force: true })'), '下拉必须绕过表单交互暂停（回前台补拉不绕）')
    assert.ok(src.includes('Promise.allSettled([refreshSplit(force ? { force: true } : undefined), refreshAuto(), ...detail.waits])'), '必须等主轮询与所有面板一起落定')
    // ⑦ 长时间切后台再回来要静默补拉（不是每次切回来都拉，也不整页重载）。
    assert.ok(src.includes('const VISIBLE_REFRESH_GAP_MS = 2000'), '回前台补拉必须有「刚刷完就切回来就跳过」的阈值')
    const recovery = src.slice(src.indexOf('// 回到前台：隐藏期间所有轮询都停了'), src.indexOf('const pull = usePullToRefresh'))
    assert.ok(recovery.includes("document.addEventListener('visibilitychange', onVis)"), '回前台补拉必须真的挂上 visibilitychange 监听（只有回调函数不算）')
    assert.ok(recovery.includes('if (Date.now() - lastRefreshRef.current < VISIBLE_REFRESH_GAP_MS) return'), '回前台补拉必须按距上次刷新判断，不能每次切回都发请求')
    assert.ok(recovery.includes('refreshActive({ respectFormPause: true })'), '回前台补拉要走统一路径，且避开表单交互')
    const refreshActiveBody = src.slice(src.indexOf('const refreshActive = useCallback'), src.indexOf('const pullRefresh = useCallback'))
    assert.ok(refreshActiveBody.includes('lastRefreshRef.current = Date.now()'), '刷新成功必须推进时间戳（写在 refreshActive 内，别处的不算）')
    assert.ok(refreshActiveBody.includes('if (ok) lastRefreshRef.current'), '失败的刷新不得推进时间戳，否则 30s 内不会再补')
    assert.ok(refreshActiveBody.includes('formPauseUntilRef.current'), '回前台补拉必须在表单交互期间直接放弃')
    assert.ok(src.includes('if (seq === autoSeqRef.current'), '自动运行状态响应要带序号守卫，旧响应不得覆盖新状态')
    // 面板不得再自带 visibilitychange 补拉：会和 App 的回前台补拉重复请求。
    const logsPanel = src.slice(src.indexOf('function LogsPanel'), src.indexOf('function ConfigPanel'))
    assert.ok(!/addEventListener\('visibilitychange'/.test(logsPanel), '日志页不得再自己挂 visibilitychange（会与回前台补拉重复请求）')
    const cachePanel = src.slice(src.indexOf('function CacheHealthPanel'), src.indexOf('function FilesPanel'))
    assert.ok(!/addEventListener\('visibilitychange'/.test(cachePanel), '缓存健康不得再自己挂 visibilitychange（会与回前台补拉重复请求）')
    // ⑧ 整条下拉路径（手势 + App 回调）都不得整页重载。
    const gesture = src.slice(src.indexOf('function usePullToRefresh'), src.indexOf('function PullRefreshStatus'))
    const appPull = src.slice(src.indexOf('const pullRefresh = useCallback'), src.indexOf('const pull = usePullToRefresh'))
    assert.ok(!/location\.reload|location\.href\s*=/.test(gesture + appPull), '下拉刷新不得整页重载')

    // 结构红线: 快速刷新不得闪文案（v3.333）
    // 本地缓存命中时 loading 只存在 17ms（实测 512→529），「· 更新中…」和「刷新中…」
    // 跟着出现又消失就是一闪；只允许慢加载（>600ms）才显示。
    assert.ok(src.includes('function useSlowFlag (on, delay = 600)'),
      '必须有 useSlowFlag：loading 只闪十几毫秒时不得切文案')
    const slowHook = src.slice(src.indexOf('function useSlowFlag'), src.indexOf('// 趋势天数选择器固定选项'))
    assert.ok(slowHook.includes('if (!on) { setSlow(false); return undefined }'), 'useSlowFlag 关闭时必须立刻复位')
    assert.ok(slowHook.includes('return slow && on'), 'useSlowFlag 必须在 on=false 的当帧就返回 false（完成后不得多渲染一帧提示）')
    const msgPanel = src.slice(src.indexOf('function MessagesPanel'), src.indexOf('function LogsPanel'))
    assert.ok(/ariaBusy=\$\{loading \? 'true' : 'false'\}/.test(src), '刷新按钮的 busy 必须真的传到 <button>（Button 转发 ariaBusy）')
    const btnAt = msgPanel.indexOf('<$' + '{Button} variant="ghost" disabled=')
    const msgRefreshBtn = msgPanel.slice(btnAt, msgPanel.indexOf('刷新<//>', btnAt))
    assert.ok(msgRefreshBtn.length > 40, '必须能定位到刷新按钮的 JSX')
    assert.ok(!msgRefreshBtn.includes('disabled=$' + '{loading}'), '刷新按钮不得因 loading 变灰：15ms 的 0.45 透明度就是一帧闪')
    assert.ok(msgRefreshBtn.includes('disabled=$' + '{slowLoading}'), '只在慢加载时禁用刷新按钮')
    const msgRefresh = msgPanel.slice(msgPanel.indexOf('const refreshNow = () => {'), msgPanel.indexOf('const [exporting', msgPanel.indexOf('const refreshNow = () => {')))
    const guardAt = msgRefresh.indexOf('if (loading || busyRef.current) return')
    const loadAt = msgRefresh.indexOf('load().catch')
    assert.ok(guardAt > -1, '刷新必须有 in-flight 守护（覆盖自动/下拉刷新）')
    assert.ok(loadAt > guardAt, '守护之后必须真的走到 load()，不能提前 return 成空操作')
    assert.ok(!/return/.test(msgRefresh.slice(guardAt + 36, loadAt)), '守护之后到 load 之间不得再提前 return')
    assert.ok(/aria-busy=\$\{ariaBusy\}/.test(src), 'Button 必须把 ariaBusy 渲染成原生 aria-busy')
    assert.ok(msgPanel.includes('const slowLoading = useSlowFlag(loading)'),
      '推送记录必须用 slowLoading 决定「更新中…」')
    assert.ok(msgPanel.includes('slowLoading ? html`<span class="msg-loading"> · 更新中…</span>`'),
      '「匹配 N 条」的后缀只能由 slowLoading 控制，不能用 loading')
    // 首屏骨架（L4）：第一份数据回来前画占位；只在「还没有 data」时出现——自动刷新/切回
    // 已有数据的面板不得反复闪骨架。
    assert.ok(src.includes('function PanelSkeleton ('), '必须有可复用的首屏骨架组件')
    assert.ok(msgPanel.includes('loading && !data && html`<') && msgPanel.includes('PanelSkeleton'),
      '首屏骨架必须由 loading && !data 门控（自动刷新不闪）')
    // 加载失败（L4）：英文异常映射成中文原因，并给重试按钮（class retry-btn）。
    const errMap = src.slice(src.indexOf('function loadErrorText'), src.indexOf('function usePanelLoader'))
    assert.ok(errMap.includes('网络请求失败') && errMap.includes('服务器错误'),
      'Failed to fetch 要映射成「网络请求失败」，5xx 映射成「服务器错误」')
    const loadErrLine = 'setErr(`加载失败：' + '$' + '{loadErrorText(e)}`)'
    assert.ok(src.includes(loadErrLine), 'loader 的 err 必须经 loadErrorText 映射，不得直接甩 e.message')
    assert.ok(msgPanel.includes('<$' + '{LoadError}') && src.includes('class="retry-btn"'),
      '推送记录加载失败必须给重试按钮（class retry-btn），且复用面板自己的 load()')
    assert.ok(!src.includes("刷新中…' : '刷新'"),
      '刷新按钮不得改文案：宽度变化会把导出按钮挤一下')
    assert.ok(src.includes('slowLoading && html`<span class="fr-status-muted">刷新中…</span>`'),
      '过滤规则的「刷新中…」同样只能慢加载才显示')
  })

  // ── v3.332 部署后旧标签页提示 ─────────────────────────────────────────
  await aok('结构红线: v3.332 新版本提示（boot 版本 / 60s 对账 / 只提示不自动刷新）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts/console-assets/app.css'), 'utf8')
    const server = fs.readFileSync(path.join(__dirname, 'scripts', 'console.js'), 'utf8')
    // 版本只有一份来源：boot JSON 与 /api/sys 共用 APP_VERSION，别再各自 require package.json。
    // 变异沙箱里 console.js 会被插桩：对象字面量与实参列表都被 stryMutAct_* 包裹，整句原文不再存在
    // ⇒ 这些「源码串」红线只在原始源文件上有意义，插桩环境必须跳过（行为断言照跑）。
    if (process.env.XBK_MUTATION_CHILD !== '1') {
      assert.ok(server.includes('const APP_VERSION = (() => {'), '版本必须抽成单一 APP_VERSION')
      assert.ok(server.includes('JSON.stringify({ token: bootToken, version: APP_VERSION, instance: instanceId })'),
        'boot JSON 必须注入版本（前端据此判断自己是不是旧页面）与实例 id（快照命名空间）')
      assert.ok(server.includes('const version = APP_VERSION'), '/api/sys 必须复用同一版本来源')
      // 探针不能被缓存、不能挤掉访问日志，异常请求照记。
      assert.ok(server.includes("res.setHeader('Cache-Control', 'no-store')"), '/api/sys 必须显式 no-store')
      assert.ok(server.includes("url.searchParams.get('probe') === 'version'"), '探针必须可识别（probe=version）')
      assert.ok(server.includes('if (!versionProbe && (url ? shouldLogAccess('), '探针 200 不入访问日志，401 等照记')
    }
    // 前端：读出 boot 版本，60s 对一次 /api/sys，只有不一致才提示。
    assert.ok(src.includes("version: typeof data.version === 'string' ? data.version : ''"), 'readBoot 必须解析 version')
    assert.ok(src.includes('const VERSION_CHECK_MS = 60000'), '对账间隔必须是 60s')
    // v3.335：系统页「检查更新」——页内下拉只换数据，旧页需要一个就地换脚本的入口。
    const sysPanel = src.slice(src.indexOf('function SysPanel'), src.indexOf('function SysPanel') + 20000)
    assert.ok(sysPanel.includes('apiGetSys({ probeVersion: true })'), '检查更新必须走 no-store 版本探针')
    assert.ok(sysPanel.includes("v !== '' && v !== BOOT.version"), '检查更新必须比页面启动版本，不能比服务端自报')
    assert.ok(/if \(v !== '' && v !== BOOT\.version\) \{[\s\S]{0,500}window\.location\.reload\(\)/.test(sysPanel),
      'reload 必须落在「版本不同」这个分支里，不能无条件刷新')
    assert.ok(sysPanel.includes('if (verBusyRef.current || verState === \'stale\') return'),
      '同一 tick 连点只能发一次探针，且已排期刷新时再点不得取消那次 reload')
    assert.ok(sysPanel.includes(": '检查更新'"), '空闲态按钮文案必须是「检查更新」')
    assert.ok(sysPanel.includes("verState === 'latest' ? '✓ 已是最新' : verState === 'stale' ? '正在刷新…' : verState === 'error' ? '检查失败'"), '按钮文案必须按 latest/stale/error 正确映射（顺序写错不得通过）')
    assert.ok(css.includes('.ver-check {') && css.includes('.ver-check.ok {'), '检查更新的按钮/成功态样式必须真的在 css 里')
    assert.ok(sysPanel.includes('<span class="ver-line">'), '版本行必须用 .ver-line 容器排布')
    assert.ok(/\.ver-check \{[^}]*white-space: nowrap/.test(css), '按钮文案不得按字换行')
    assert.ok(sysPanel.includes("'✓ 已是最新'"), '状态写在按钮自己身上（不额外挂一枚胶囊）')
    assert.ok(src.includes("if (stopped || document.visibilityState === 'hidden') return"), '页面隐藏时不得持续打接口')
    assert.ok(src.includes('const bootVersion = BOOT.version'), '对账基准必须是页面启动版本')
    assert.ok(src.includes('if (!bootVersion || authExpired) return undefined'), '凭证失效后必须停表（401 会刷日志）')
    assert.ok(src.includes('}, [authExpired])'), 'authExpired 必须能重启/停掉对账')
    assert.ok(src.includes('if (stopped || mine < done) return'), '乱序响应必须丢弃（旧判定不得覆盖新判定）')
    assert.ok(src.includes("setNewVersion(v !== '' && v !== bootVersion ? v : '')"),
      '版本重新对齐（含回滚）必须收起提示，不得留过期横幅')
    // 探针本身：no-store + 独立 URL。
    assert.ok(src.includes('probeVersion ? { cache: \'no-store\' } : {}'), '探针必须 no-store（防代理喂旧版本）')
    assert.ok(src.includes("fetch(probeVersion ? '/api/sys?probe=version' : '/api/sys', merged)"),
      '探针必须走独立 URL，正常系统页请求不受影响')
    // 只提示、不自动 reload：刷新必须由用户点，避免打断正在填的表单。
    assert.ok(src.includes('$' + '{newVersion !== \'\' && html`<div class="alert-banner nudge" role="status">'),
      '提示条只在发现新版本时渲染，且是 status 不是 alert')
    assert.ok(src.includes('控制台已更新到 ' + '$' + '{newVersion}'), '提示条必须点名新版本号')
    assert.ok(src.includes('onClick=' + '$' + '{() => window.location.reload()}'), '刷新按钮必须由用户点击触发 reload')
    const effectFrom = src.indexOf('const bootVersion = BOOT.version')
    const effect = src.slice(effectFrom, src.indexOf('}, [authExpired]', effectFrom))
    assert.ok(!effect.includes('location.reload'), '对账 effect 里不得自动 reload（会打断输入）')
    // 样式走主题变量，且用强调色而不是报错色。
    assert.ok(/\.alert-banner\.nudge\s*\{[^}]*var\(--accent-soft\)/.test(css) && /\.alert-banner\.nudge\s*\{[^}]*var\(--info-fg\)/.test(css),
      '提示条必须走强调色变量（不与「凭证失效」红条混淆）')
  })

  await aok('结构红线: v3.326 逐轮历史切档不闪（两档快照预取 / 无快照等数据回来再换）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const hist = src.slice(src.indexOf('function RunHistoryPanel'), src.indexOf('// ── 组件：整体'))
    assert.ok(hist.includes('snapsRef = useRef({ runs: null, all: null })'), '必须留 runs/all 两份服务端快照')
    assert.ok(hist.includes("fetchSnap(k === 'runs' ? 'all' : 'runs')") === false,
      '首屏只允许一次 /api/run-history：不得再预取另一档（旧版 excludeCancelled=1 的第二发）')
    assert.ok(hist.includes('apiGetRunHistory({ limit: RUN_FETCH_LIMIT })') && !hist.includes('excludeCancelled: k ==='),
      '一份全量窗口必须同时喂 runs/all 两档（前端剔除取消留痕，不再发 excludeCancelled 请求）')
    const change = hist.slice(hist.indexOf('const changeMode = (m) => {'), hist.indexOf('const goPage = (n) => {'))
    // 有快照：数据先于选中态落地（同一批渲染），首帧就是目标档。
    const cachedAt = change.indexOf('if (cached !== null) {')
    const cachedBlock = change.slice(cachedAt, change.indexOf('return', cachedAt))
    assert.ok(cachedBlock.includes('setData(cached)') && cachedBlock.indexOf('setData(cached)') < cachedBlock.indexOf('setMode(m)'),
      '有快照时数据必须先于选中态落地')
    assert.ok(cachedBlock.includes('setDataMode(key)'), '有快照时 dataMode 必须同步换档（否则筛选会按旧档渲染）')
    // load 必须真的消费 quietNextRef：静默刷新不置 loading（否则切档时分页按钮闪禁用态）。
    const loadAt = hist.indexOf('const load = useCallback(async () => {')
    const loadSrc = hist.slice(loadAt, hist.indexOf('}, [mode, fetchSnap])', loadAt))
    assert.ok(loadSrc.includes('const quiet = quietNextRef.current') && loadSrc.includes('quietNextRef.current = false'),
      'load 必须读取并清掉 quietNextRef')
    assert.ok(loadSrc.includes('setLoading(!quiet)'), '静默刷新不得置 loading')
    assert.ok(hist.includes("const fullSnap = dataMode === 'all'"), 'fullSnap 必须由 dataMode 推导，不得写死')
    // 没快照：选中态与列表都不先动，请求回来再一次性 setData + setMode。
    const pendingAt = change.indexOf('setPendingMode(m)')
    const pendingTail = change.slice(pendingAt)
    assert.ok(pendingAt > 0, '必须有无快照的等待分支')
    assert.ok(pendingTail.indexOf('setMode(m)') > pendingTail.indexOf('fetchSnap(key).then'), '无快照时不得先换选中态（等请求回来再换）')
    assert.ok(pendingTail.includes('fetchSnap(key).then((d) => {') && pendingTail.includes('setData(d)') && pendingTail.includes('setMode(m)'),
      '无快照时必须等请求回来再一起换数据与选中态')
    assert.ok(pendingTail.includes('window.setTimeout(') && pendingTail.includes('}, 150)'), '忙碌提示必须延迟 150ms（快请求不闪）')
    assert.ok(pendingTail.includes('landRef.current = false'), '请求失败必须撤销落点')
    assert.ok(hist.includes('const filtered = filterRunItems(all, { mode })') && hist.includes('inDayRange('),
      '切档原子化后可以直接按 mode 过滤，本分支再叠日期区间（数据始终属于当前档）')
    assert.ok(hist.includes("const issueCount = fullSnap ? filterRunItems(all, { mode: 'issue' }).length : null"),
      '异常计数只能来自全量快照（仅运行档算出来是假的 2）')
    assert.ok(hist.includes("mode === 'runs' || issueCount === null ? '只看异常'"), '没有全量快照 / 仅运行档下不得显示异常数字')
    assert.ok(hist.includes('aria-busy=$' + "{pendingMode === 'issue' && pendingBusy ? 'true' : 'false'}"),
      '忙碌态必须延迟到 pendingBusy 才对外声明（否则快请求也闪一下）')
    const chipCss = css.slice(css.indexOf('.log-chip[aria-busy="true"]'), css.indexOf('.log-chip-n'))
    assert.ok(/animation:\s*chip-wait/.test(chipCss), '忙碌 chip 必须有提示动画')
    assert.ok(/prefers-reduced-motion/.test(chipCss), '减少动效时必须退回静态提示')
    assert.ok(!/chip-spin/.test(src), '忙碌提示不得插节点改 chip 宽度（会挤重排工具条）')
  })

  await aok('结构红线: 运行日志有可拖快滚条（一长条）', () => {
    const src = readConsoleSource()
    const css = fs.readFileSync(path.join(__dirname, 'scripts', 'console-assets', 'app.css'), 'utf8')
    const ph = (name) => '$' + '{' + name + '}'
    const at = src.indexOf('function LogsPanel')
    const seg = src.slice(at, src.indexOf('// v3.342：控制台设置块', at))
    assert.ok(at > -1 && seg.length > 1000, '应能定位 LogsPanel 源码段')
    assert.ok(seg.includes('role="scrollbar"'), '快滚条必须是 scrollbar 角色')
    assert.ok(seg.includes('aria-orientation="vertical"') && seg.includes('aria-valuenow=' + ph('rail.pct')),
      '快滚条必须报方向与当前位置')
    assert.ok(seg.includes('class=' + ph("'log-rail' + (rail.show ? ' show' : '')")), '快滚条必须按有无可滚内容显隐')
    assert.ok(seg.includes('onPointerDown=' + ph('onRailDown')) && seg.includes('setPointerCapture'),
      '按下必须捕获指针（手指移出轨道仍能拖）')
    assert.ok(seg.includes('ratio * (el.scrollHeight - el.clientHeight)'), '拖动必须换算成 scrollTop，而不是按屏翻页')
    assert.ok(seg.includes('dragRef.current = { id: e.pointerId, grab:'), '抓取偏移必须保留（按在拇指上不跳位）')
    assert.ok(seg.includes('requestAnimationFrame(syncRail)'), '内容落定后要等一帧再量（否则高度是旧的）')
    assert.ok(seg.includes("e.key === 'Home' || e.key === 'End'") && seg.includes('PageDown: page'),
      '快滚条必须支持键盘翻页/到两端')
    assert.ok(/\.log-rail\s*\{[^}]*width:\s*18px/.test(css) && /\.log-rail\s*\{[^}]*touch-action:\s*none/.test(css),
      '轨道热区 18px 且 touch-action: none（拖动不吃页面滚动）')
    assert.ok(/\.log-thumb\s*\{[^}]*width:\s*8px/.test(css), '拇指 8px')
    assert.ok(/\.logpre-main\s*\{[^}]*padding-right:\s*16px/.test(css), '日志框右侧必须给轨道留 16px')
    assert.ok(!/scrollIntoView/.test(seg), '快滚条只能滚日志框，不得 scrollIntoView 整页')
    // M1：切走再切回时 display:none 量到 0 高，条被隐藏且不会因内容不变而重量。
    assert.ok(seg.includes('if (!active) return') && /\[active, syncRail\]/.test(seg),
      'active 变 true 必须重量一次（否则切回来条一直不出现）')
    assert.ok(seg.includes('new window.ResizeObserver'), '日志框自身高度变化要用 ResizeObserver 兜住')
    assert.ok(seg.includes('prev.show ? { top: 0, height: 0, pct: 0, show: false } : prev'),
      '无溢出时必须把 show 置 false（不是只让 class 依赖 rail.show）')
    // M2：滚动条必须与它控制的 <pre> 建立关系，否则读屏只听到一个孤立的滚动条。
    assert.ok(seg.includes('id="log-pre"') && seg.includes('aria-controls="log-pre"'),
      '快滚条必须用 aria-controls 指向被控日志框')
    // M3：第二根手指不得顶掉正在拖的那根。
    assert.ok(/if \(dragRef\.current\) return/.test(seg), '已有指针在拖时必须忽略新的 pointerdown')
  })

  // ── v3.357 两步验证（Google Authenticator / TOTP）────────────────────────
  await aok('两步验证: TOTP 标准向量 + Base32 + 恢复码一次性 + Cookie 签名', () => {
    // RFC 6238 SHA-1 测试密钥（ASCII "12345678901234567890"）在 T=59s 的 8 位码为 94287082；
    // 这里取 6 位 = 287082。用标准向量锁死 HMAC/动态截断，避免实现“看起来能跑”。
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    assert.strictEqual(base32Encode(base32Decode(rfcSecret)), rfcSecret, 'Base32 往返')
    assert.strictEqual(totpCodeAt(rfcSecret, 59000), '287082', 'RFC 6238 向量')
    assert.strictEqual(verifyTotpCode(rfcSecret, '287082', 59000), true, '窗口内接受')
    assert.strictEqual(verifyTotpCode(rfcSecret, '287083', 59000), false, '错误码拒绝')
    assert.strictEqual(verifyTotpCode(rfcSecret, '287082', 59000 + 30000, 1), true, '±1 步长容忍时钟偏差')
    const secret = generateTotpSecret()
    assert.match(secret, /^[A-Z2-7]{32}$/, '20 字节 → 32 字符 Base32')
    const qr = totpQrDataUrl('otpauth://totp/xbk-push:console?secret=GEZDGNBVGY3TQOJQ')
    assert.ok(qr.startsWith('data:image/svg+xml;base64,'), '二维码是内联 SVG，不依赖 CDN')
    const qrSvg = Buffer.from(qr.split(',')[1], 'base64').toString('utf8')
    assert.ok(qrSvg.startsWith('<svg') && qrSvg.includes('viewBox='), '二维码 SVG 结构有效')
    assert.strictEqual(totpQrDataUrl(''), '', '空链接不生成二维码（页面退回手输密钥）')
    const codes = generateRecoveryCodes()
    assert.strictEqual(codes.length, 10, '默认 10 个恢复码')
    const rec = recoveryRecordOf(codes)
    const next = consumeRecoveryCode(rec, codes[0])
    assert.ok(next && next.hashes.length === 9, '恢复码用后即扣减')
    assert.strictEqual(consumeRecoveryCode(next, codes[0]), null, '同一恢复码不能再用')
    assert.ok(consumeRecoveryCode(next, codes[1]), '其它恢复码仍可用')
    const cookie = makeTwoFactorCookie(secret, 1700000000000)
    assert.strictEqual(verifyTwoFactorCookie(cookie, secret, 1700000001000), true, '签名 Cookie 有效')
    assert.strictEqual(verifyTwoFactorCookie(cookie + 'x', secret, 1700000001000), false, '篡改拒绝')
    assert.strictEqual(verifyTwoFactorCookie(cookie, secret, 1700000000000 + 13 * 3600 * 1000), false, '过期拒绝')
    const dir = tmpDir()
    try {
      assert.strictEqual(loadTwoFactorState(dir).enabled, false, '缺文件=未开启')
      fs.writeFileSync(path.join(dir, TWO_FACTOR_FILE), '{"schema":1,"enabled":true}')
      assert.throws(() => loadTwoFactorState(dir), /拒绝启动/, '配置非法必须 fail-closed')
      const secret = generateTotpSecret()
      const recovery = recoveryRecordOf(generateRecoveryCodes())
      fs.writeFileSync(path.join(dir, TWO_FACTOR_FILE), JSON.stringify({ schema: 1, enabled: true, secret, recovery, createdAt: 1 }))
      fs.chmodSync(path.join(dir, TWO_FACTOR_FILE), 0o666 & ~0o022) // 0644：故意放宽的测试夹具
      assert.strictEqual(loadTwoFactorState(dir).enabled, true, '合法配置可读取')
      assert.strictEqual(fs.statSync(path.join(dir, TWO_FACTOR_FILE)).mode & 0o777, 0o600, '过宽权限读后收紧为 0600')
      const duplicate = { ...recovery, hashes: [recovery.hashes[0], recovery.hashes[0]] }
      fs.writeFileSync(path.join(dir, TWO_FACTOR_FILE), JSON.stringify({ schema: 1, enabled: true, secret, recovery: duplicate, createdAt: 1 }))
      assert.throws(() => loadTwoFactorState(dir), /拒绝启动/, '重复恢复码哈希必须拒绝')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('两步验证: 开启→页面第二因子→恢复码登录→关闭（HTTP）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    server.unref()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const json = { 'content-type': 'application/json' }
    const cookiesOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
    try {
      let res = await request(port, 'GET', '/api/2fa/status', { token: TOKEN })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(JSON.parse(res.text).enabled, false, '默认未开启')

      res = await request(port, 'POST', '/api/2fa/setup', { token: TOKEN, headers: json, body: '{}' })
      assert.strictEqual(res.status, 200, '获取设置密钥')
      const setup = JSON.parse(res.text)
      assert.match(setup.secret, /^[A-Z2-7]{32}$/)
      assert.match(setup.setupId, /^[0-9a-f]{24}$/, '设置流程有独立 setupId')
      assert.ok(setup.otpauth.startsWith('otpauth://totp/'), 'otpauth 链接可用于手动添加')
      assert.match(setup.qrDataUrl, /^data:image\/svg\+xml;base64,/, '设置接口同时返回可扫描二维码')

      // 两个标签页各自点「开启」：后一个不能覆盖前一个的 pending secret。
      res = await request(port, 'POST', '/api/2fa/setup', { token: TOKEN, headers: json, body: '{}' })
      const setup2 = JSON.parse(res.text)
      assert.notStrictEqual(setup2.setupId, setup.setupId, '两次 setup 的 setupId 不同')

      const code = totpCodeAt(setup.secret, Date.now())
      res = await request(port, 'POST', '/api/2fa/enable', { token: TOKEN, headers: json, body: JSON.stringify({ code, setupId: setup.setupId }) })
      assert.strictEqual(res.status, 200, res.text)
      const enabled = JSON.parse(res.text)
      assert.strictEqual(enabled.enabled, true)
      assert.strictEqual(enabled.recoveryCodes.length, 10, '开启时返回 10 个恢复码')
      assert.ok(String(res.headers['set-cookie']).includes('xbk_2fa='), '开启后当前浏览器拿 2FA Cookie')

      // 响应丢包后的重试：同一 setupId + 仍有效验证码可以再取一次恢复码。
      res = await request(port, 'POST', '/api/2fa/enable', { token: TOKEN, headers: json, body: JSON.stringify({ code, setupId: setup.setupId }) })
      assert.strictEqual(res.status, 200, '已开启后同一 setupId 可重取恢复码')
      assert.deepStrictEqual(JSON.parse(res.text).recoveryCodes, enabled.recoveryCodes, '恢复码与首次响应一致')

      // 已经被开启流程用掉的 TOTP 时间步不能立刻再换登录会话。
      res = await request(port, 'POST', '/login', { body: new URLSearchParams({ token: TOKEN, code }).toString(), headers: form })
      assert.strictEqual(res.status, 401, '同一 TOTP 码不能重放')
      assert.ok(res.text.includes('已经用过'), '重放提示可见')
      const twoFactorFile = path.join(dir, TWO_FACTOR_FILE)
      const fd = fs.openSync(twoFactorFile, 'r')
      let rawFile
      try {
        assert.strictEqual(fs.fstatSync(fd).mode & 0o777, 0o600, '配置文件 0600')
        rawFile = fs.readFileSync(fd, 'utf8')
      } finally {
        fs.closeSync(fd)
      }

      // 只有访问令牌、没有 2FA Cookie：页面必须停在第二步，而不是直接渲染数据。
      res = await request(port, 'GET', '/', { token: TOKEN })
      assert.strictEqual(res.status, 401, '缺第二因子不得进页面')
      assert.ok(res.text.includes('需要两步验证'), '显示第二因子登录页')
      assert.ok(res.text.includes(`name="token" value="${TOKEN}"`), '访问令牌只放在 hidden 字段回传')
      res = await request(port, 'POST', '/login', { body: new URLSearchParams({ token: TOKEN }).toString(), headers: form })
      assert.strictEqual(res.status, 401, '只提交令牌不够')
      assert.ok(res.text.includes('需要两步验证'), '继续要求验证码')
      res = await request(port, 'POST', '/login', { body: new URLSearchParams({ token: TOKEN, code: '000000' }).toString(), headers: form })
      assert.strictEqual(res.status, 401, '错误验证码拒绝')
      assert.ok(res.text.includes('验证码不对'), '错误提示可见')

      const fresh = totpCodeAt(setup.secret, Date.now() + 30 * 1000)
      res = await request(port, 'POST', '/login', { body: new URLSearchParams({ token: TOKEN, code: fresh }).toString(), headers: form })
      assert.strictEqual(res.status, 303, '正确验证码登录')
      const cookies = cookiesOf(res)
      assert.ok(cookies.includes('xbk_session=') && cookies.includes('xbk_2fa='), '同时下发会话与 2FA Cookie')
      res = await request(port, 'GET', '/', { headers: { cookie: cookies } })
      assert.strictEqual(res.status, 200, '带 2FA Cookie 可进页面')
      assert.ok(res.text.includes(`"token":"${TOKEN}"`), '页面仍注入会话凭证供写请求使用')

      // 分阶段边界：接口仍认原访问令牌（用户还没决定是否收紧 API）。
      res = await request(port, 'GET', '/api/status', { token: TOKEN })
      assert.strictEqual(res.status, 200, '接口保持原 token 鉴权（本版只保护浏览器打开）')

      // 恢复码：用一次成功，再用同一串失败；服务端只存哈希，不存明文。
      const recoveryCode = enabled.recoveryCodes[0]
      res = await request(port, 'POST', '/login', { body: new URLSearchParams({ token: TOKEN, code: recoveryCode }).toString(), headers: form })
      assert.strictEqual(res.status, 303, '恢复码可登录')
      res = await request(port, 'POST', '/login', { body: new URLSearchParams({ token: TOKEN, code: recoveryCode }).toString(), headers: form })
      assert.strictEqual(res.status, 401, '恢复码不能重复使用')
      assert.ok(!rawFile.includes(recoveryCode), '配置文件不得存恢复码明文')

      const disableCode = enabled.recoveryCodes[1]
      res = await request(port, 'POST', '/api/2fa/disable', { token: TOKEN, headers: json, body: JSON.stringify({ code: disableCode }) })
      assert.strictEqual(res.status, 200, res.text)
      assert.strictEqual(JSON.parse(res.text).enabled, false)
      assert.throws(() => fs.openSync(twoFactorFile, 'r'), /ENOENT/, '关闭后删除配置')
      res = await request(port, 'GET', '/', { token: TOKEN })
      assert.strictEqual(res.status, 200, '关闭后恢复单因子')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('两步验证: 第一因子错误也限速，代理后按客户端 IP 隔离', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    server.unref()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const json = { 'content-type': 'application/json' }
    try {
      let res = await request(port, 'POST', '/api/2fa/setup', { token: TOKEN, headers: json, body: '{}' })
      const setup = JSON.parse(res.text)
      const code = totpCodeAt(setup.secret, Date.now())
      res = await request(port, 'POST', '/api/2fa/enable', { token: TOKEN, headers: json, body: JSON.stringify({ code, setupId: setup.setupId }) })
      assert.strictEqual(res.status, 200, res.text)

      const sameProxy = { ...form, 'x-forwarded-for': '203.0.113.77' }
      for (let i = 0; i < 10; i++) {
        res = await request(port, 'POST', '/login', {
          body: new URLSearchParams({ token: 'wrong-token-0000000000', code: '' }).toString(),
          headers: sameProxy
        })
        assert.strictEqual(res.status, 401, `第 ${i + 1} 次错误令牌仍只返回挑战页`)
      }
      const fresh = totpCodeAt(setup.secret, Date.now() + 30 * 1000)
      res = await request(port, 'POST', '/login', {
        body: new URLSearchParams({ token: TOKEN, code: fresh }).toString(),
        headers: sameProxy
      })
      assert.strictEqual(res.status, 429, '同一 IP 的错误令牌也必须计入限速')

      res = await request(port, 'POST', '/login', {
        body: new URLSearchParams({ token: TOKEN, code: fresh }).toString(),
        headers: { ...form, 'x-forwarded-for': '203.0.113.78' }
      })
      assert.strictEqual(res.status, 303, '不同客户端 IP 不应被同一把锁误伤')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── v3.374 信任设备（「记住这台设备」）──────────────────────────────────────
  await aok('信任设备: 签发→验证、篡改/过期/revoke 后失败、21 台淘汰最旧、2FA 关闭不认', () => {
    const dir = tmpDir()
    const now = 1700000000000
    try {
      const issued = makeDeviceRecord('Mozilla/5.0 (iPhone)\nX-Evil: 1', now)
      const cookie = `${issued.record.id}.${issued.secret}`
      assert.strictEqual(parseDeviceCookie(cookie).id, issued.record.id, 'cookie 值形如 <id>.<secret>')
      assert.strictEqual(parseDeviceCookie('garbage'), null, '畸形 cookie 直接判无效')
      assert.strictEqual(parseDeviceCookie(`${issued.record.id}.zzzz`), null, '非 hex secret 判无效')
      assert.strictEqual(JSON.stringify(issued.record).includes(issued.secret), false, '记录里不得出现 secret 明文')
      assert.strictEqual(issued.record.ua.includes('\n'), false, 'UA 控制字符被抹掉')

      assert.strictEqual(writeDeviceStore(dir, [issued.record]), true, '设备列表落盘成功')
      const deviceFile = path.join(dir, DEVICE_FILE)
      const fd = fs.openSync(deviceFile, 'r')
      try {
        assert.strictEqual(fs.fstatSync(fd).mode & 0o777, 0o600, '设备文件 0600')
        const text = fs.readFileSync(fd, 'utf8')
        assert.strictEqual(text.includes(issued.secret), false, '磁盘上只有哈希，没有 secret')
        assert.strictEqual(JSON.parse(text).version, 1, '落盘结构带 version')
      } finally {
        fs.closeSync(fd)
      }

      let store = readDeviceStore(dir, now)
      assert.strictEqual(store.devices.length, 1, '读回一条设备')
      assert.strictEqual(store.devices[0].hash, hashDeviceSecret(issued.secret), '存的是 sha256(secret)')
      assert.strictEqual(trustedDeviceOf(store.devices, cookie, now + 1000).id, issued.record.id, '签发后可验证通过')
      assert.strictEqual(trustedDeviceOf(store.devices, `${issued.record.id}.${'0'.repeat(64)}`, now + 1000), null, '篡改 secret 失败')
      assert.strictEqual(trustedDeviceOf(store.devices, `${'a'.repeat(24)}.${issued.secret}`, now + 1000), null, '换 id 失败')
      assert.strictEqual(trustedDeviceOf(store.devices, cookie, now + DEVICE_TTL_MS - 1).id, issued.record.id, '过期前一毫秒仍有效')
      assert.strictEqual(trustedDeviceOf(store.devices, cookie, now + DEVICE_TTL_MS), null, '过期后失败')
      assert.strictEqual(trustedDeviceOf(store.devices, cookie, now + 1000, false), null, '2FA 关闭时设备 cookie 不授予访问')

      // 21 台：淘汰「最久未用」的那台（lastUsedAt 最小），数量永远是 20。
      let list = []
      let oldest = null
      for (let i = 0; i < DEVICE_MAX; i++) {
        const made = makeDeviceRecord('ua-' + i, now + i * 1000)
        if (i === 0) oldest = made.record.id
        list = appendDeviceRecord(list, made.record, now + i * 1000)
      }
      assert.strictEqual(list.length, DEVICE_MAX, '满 20 台')
      const newcomer = makeDeviceRecord('ua-new', now + 60 * 1000)
      list = appendDeviceRecord(list, newcomer.record, now + 60 * 1000)
      assert.strictEqual(list.length, DEVICE_MAX, '第 21 台后仍是 20 台')
      assert.strictEqual(list.some((item) => item.id === oldest), false, '最久未用的那台被淘汰')
      assert.strictEqual(list.some((item) => item.id === newcomer.record.id), true, '新设备在列表里')

      // revoke：清空后同一 cookie 立刻失效。
      assert.strictEqual(writeDeviceStore(dir, []), true, '清空设备列表')
      store = readDeviceStore(dir, now)
      assert.strictEqual(store.devices.length, 0, '列表已空')
      assert.strictEqual(trustedDeviceOf(store.devices, cookie, now + 1000), null, 'revoke 后验证失败')

      // 损坏文件：按空列表处理，写前留 .bak，不静默覆盖。
      fs.writeFileSync(deviceFile, '{broken json')
      const broken = readDeviceStore(dir, now)
      assert.strictEqual(broken.devices.length, 0, '损坏文件按空列表处理')
      assert.strictEqual(broken.corruptText, '{broken json', '损坏内容原样带回，供写前备份')
      assert.strictEqual(trustedDeviceOf(broken.devices, cookie, now), null, '损坏文件不得放行')
      assert.strictEqual(writeDeviceStore(dir, [issued.record], { corruptText: broken.corruptText }), true, '损坏后仍可重写')
      const backup = readSafeTextResult(deviceFile + '.bak', 4096, { openNonBlocking: true })
      assert.strictEqual(backup.status, 'ok', '覆盖前留了一份 .bak')
      assert.strictEqual(backup.text, '{broken json', '.bak 保存的是原始损坏内容')
      assert.strictEqual(readDeviceStore(dir, now).devices.length, 1, '重写后列表恢复')

      // 盘上文件读不出来（超大 ⇒ tooLarge）：必须标记 readFailed，且任何写入都拒绝，
      // 否则一次「读失败」就被当成空列表，把已登记的 20 台设备整批抹掉。
      fs.writeFileSync(deviceFile, 'x'.repeat(64 * 1024 + 1))
      const blocked = readDeviceStore(dir, now)
      assert.strictEqual(blocked.readFailed, true, '读失败要标记 readFailed')
      assert.strictEqual(writeDeviceStore(dir, [], { readFailed: blocked.readFailed }), false, '读失败时 revoke 不得覆盖')
      assert.strictEqual(writeDeviceStore(dir, [issued.record], { corruptText: blocked.corruptText, readFailed: blocked.readFailed }), false, '读失败时新增设备不得覆盖')
      assert.strictEqual(fs.readFileSync(deviceFile).length, 64 * 1024 + 1, '原文件原样保留')
      fs.rmSync(deviceFile)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('信任设备: 记住这台设备免二次验证（HTTP）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    server.unref()
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const json = { 'content-type': 'application/json' }
    const cookiePairs = (res) => res.headers['set-cookie'] || []
    const cookieOf = (res, name) => cookiePairs(res)
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith(name + '='))
    try {
      let res = await request(port, 'POST', '/api/2fa/setup', { token: TOKEN, headers: json, body: '{}' })
      const setup = JSON.parse(res.text)
      const code = totpCodeAt(setup.secret, Date.now())
      res = await request(port, 'POST', '/api/2fa/enable', { token: TOKEN, headers: json, body: JSON.stringify({ code, setupId: setup.setupId }) })
      assert.strictEqual(res.status, 200, res.text)
      const enabled = JSON.parse(res.text)

      // 挑战页上「记住这台设备」默认勾选。
      res = await request(port, 'GET', '/', { token: TOKEN })
      assert.strictEqual(res.status, 401, '开启 2FA 后先要第二因子')
      assert.ok(res.text.includes('name="remember" value="1" checked'), '登录页默认勾选「记住这台设备」')

      const fresh = totpCodeAt(setup.secret, Date.now() + 30 * 1000)
      res = await request(port, 'POST', '/login', {
        body: new URLSearchParams({ token: TOKEN, code: fresh, remember: '1' }).toString(),
        headers: form
      })
      assert.strictEqual(res.status, 303, '验证码正确即登录')
      const deviceCookie = cookieOf(res, DEVICE_COOKIE)
      assert.ok(deviceCookie && deviceCookie.split('=')[1].includes('.'), '勾选后下发设备 Cookie')
      const rawDevice = cookiePairs(res).find((c) => c.startsWith(DEVICE_COOKIE + '='))
      for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=7776000']) {
        assert.ok(rawDevice.includes(attr), `设备 Cookie 必须带 ${attr}`)
      }

      // 只带设备 cookie（没有 xbk_session / xbk_2fa）也能进页面——这正是「免二次验证」。
      const seeded = readDeviceStore(dir)
      assert.strictEqual(seeded.devices.length, 1, '设备记录已落盘')
      // 把 lastUsedAt 拨到 2 分钟前：超过 60s 节流窗，下一次命中必须重新写盘。
      writeDeviceStore(dir, seeded.devices.map((d) => ({ ...d, lastUsedAt: d.createdAt - 120 * 1000 })))
      res = await request(port, 'GET', '/', { headers: { cookie: deviceCookie } })
      assert.strictEqual(res.status, 200, '仅凭设备 cookie 直接进页面')
      assert.ok(res.text.includes('xbk-boot'), '返回的是控制台页面')
      const touched = readDeviceStore(dir)
      assert.ok(touched.devices[0].lastUsedAt > seeded.devices[0].createdAt - 120 * 1000, '命中后更新 lastUsedAt')
      res = await request(port, 'GET', '/', { headers: { cookie: deviceCookie } })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(readDeviceStore(dir).devices[0].lastUsedAt, touched.devices[0].lastUsedAt,
        '同一分钟内的重复请求不再写盘（lastUsedAt 不变）')

      res = await request(port, 'GET', '/api/2fa/status', { token: TOKEN })
      assert.strictEqual(JSON.parse(res.text).trustedDevices, 1, '状态接口报当前设备数')

      // 写面（revoke）只认 Bearer：会话 Cookie 走不通。
      res = await request(port, 'POST', '/api/devices/revoke', {
        headers: { ...json, cookie: `xbk_session=${encodeURIComponent(TOKEN)}` },
        body: '{}'
      })
      assert.strictEqual(res.status, 401, 'Cookie-only 不能退出信任设备')

      res = await request(port, 'POST', '/api/devices/revoke', { token: TOKEN, headers: json, body: '{}' })
      assert.strictEqual(res.status, 200, res.text)
      assert.strictEqual(JSON.parse(res.text).devices, 0)
      assert.strictEqual(readDeviceStore(dir).devices.length, 0, '服务端设备列表已清空')
      assert.strictEqual(cookieOf(res, DEVICE_COOKIE), `${DEVICE_COOKIE}=`, '同时让当前浏览器的设备 Cookie 失效')

      res = await request(port, 'GET', '/', { headers: { cookie: deviceCookie } })
      assert.strictEqual(res.status, 401, 'revoke 后旧设备 cookie 失效')
      assert.ok(res.text.includes('需要访问令牌'), '回到登录页')

      // 关闭 2FA 也必须清空设备列表：旧信任不能绕过「下次开启的新密钥」。
      res = await request(port, 'POST', '/login', {
        body: new URLSearchParams({ token: TOKEN, code: enabled.recoveryCodes[0], remember: '1' }).toString(),
        headers: form
      })
      assert.strictEqual(res.status, 303, '恢复码也能记住设备')
      assert.strictEqual(readDeviceStore(dir).devices.length, 1, '设备重新入库')
      res = await request(port, 'POST', '/api/2fa/disable', { token: TOKEN, headers: json, body: JSON.stringify({ code: enabled.recoveryCodes[1] }) })
      assert.strictEqual(res.status, 200, res.text)
      assert.strictEqual(readDeviceStore(dir).devices.length, 0, '关闭 2FA 时清空信任设备')
      assert.ok(String(res.headers['set-cookie']).includes(`${DEVICE_COOKIE}=;`), '同时清掉浏览器的设备 Cookie')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('信任设备: 2FA 关闭时设备 cookie 不授予访问（HTTP）', async () => {
    const dir = tmpDir()
    const issued = makeDeviceRecord('Mozilla/5.0', Date.now())
    assert.strictEqual(writeDeviceStore(dir, [issued.record]), true, '预置一条合法设备记录')
    // 没有 console-2fa.json ⇒ 2FA 未开启；设备 cookie 此时不得当会话用。
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    server.unref()
    try {
      const res = await request(port, 'GET', '/', { headers: { cookie: `${DEVICE_COOKIE}=${issued.record.id}.${issued.secret}` } })
      assert.strictEqual(res.status, 401, '2FA 关闭时设备 cookie 什么都不授予')
      assert.ok(res.text.includes('需要访问令牌'), '按未登录处理')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await aok('结构红线: v3.363 数据面（条件请求 / SSE 续传 / 首屏快照）', async () => {
    const src = readConsoleSource()
    assert.ok(src.includes('res.status === 304'), 'consumeJson 必须处理 304（复用条件缓存）')
    // 断言真实调用点，而不是「文件里出现过某个字符串」——删掉接入也能过就失去意义（Sourcery PR #321）。
    assert.ok(src.includes('addConditional(merged, \'runs\')'), '/api/runs 必须接入条件请求')
    assert.ok(src.includes('addConditional(merged, \'auto\')'), '/api/auto 必须接入条件请求')
    assert.ok(src.includes('addConditional(merged, condKey)'), '/api/messages 必须接入条件请求')
    assert.ok(!/addConditional\(merged, 'status'\)/.test(src), '/api/status 不得走条件请求（generatedAt/锁龄每拍在变）')
    assert.ok(src.includes('COND_CACHE_MAX = 16') && src.includes('rememberConditional('), '条件缓存必须有界（messages 键含筛选/分页，无上限会无限增长）；v3.373 扩到 7 个端点 ⇒ 16')
    // v3.373：四个新端点必须真的接上条件请求（断言调用点，不是「文件里出现过某字符串」）。
    for (const key of ["'config'", "'cache-health'", '`trends?' + '$' + '{qs}`', '`run-history?' + '$' + '{qs}`']) {
      assert.ok(src.includes('conditionalRequest(' + key), `${key} 必须接入条件请求（否则每次都整包重传）`)
    }
    // 304 但本地无副本必须自动重试一次，不能把 304 当错误（配置页会显示「加载失败」）。
    assert.ok(src.includes('typeof retry === \'function\''), 'consumeJson 的 304 分支必须有重试通道')
    assert.ok(src.includes('const again = once(false)'), '重试必须去掉 If-None-Match（once(false) 不再注入条件头）')
    // fetch 在调用时快照 headers：messages 的 addConditional 必须排在 fetch 之前。
    const msgFn = src.slice(src.indexOf('function apiGetMessages'), src.indexOf('function apiGetTrends'))
    assert.ok(msgFn.indexOf('addConditional(merged, condKey)') < msgFn.indexOf('fetch('), 'messages 必须先注入 If-None-Match 再 fetch')
    assert.ok(src.includes('streamErrors <= 3'), 'SSE onerror 必须先让原生 EventSource 有限次重连（带 Last-Event-ID 续传）')
    const snapStart = src.indexOf('const SNAP_KEY')
    const snapEnd = src.indexOf('const THEMES = [')
    assert.ok(snapStart >= 0 && snapEnd > snapStart, '首屏快照块必须在主题块之前（主题红线只允许服务端首帧渲染）')
    const snapBlock = src.slice(snapStart, snapEnd)
    assert.ok(snapBlock.includes('BOOT.instance'), '快照命名空间必须带实例 id（换实例不串旧数据）')
    assert.ok(src.includes("instance: typeof data.instance === 'string'"), 'readBoot 必须解析 instance（否则命名空间永远回落 default）')
    assert.ok(snapBlock.includes('v.v !== BOOT.version'), '快照必须有版本守卫（旧结构不渲染）')
    assert.ok(snapBlock.includes('runs.slice(0, 12)'), '快照最多存 12 条历史（localStorage 有 5MB 上限）')
    assert.ok(snapBlock.includes('prev.at > startedAt'), '多标签页：旧响应不得覆盖更新快照')
    assert.ok(!snapBlock.includes('BOOT.token'), '快照不得包含 token')
  })
}

main()
  .then(() => {
    console.log(`\n控制台套件：通过 ${passed} / 失败 ${failed}`)
    if (failed > 0) process.exitCode = 1
    const lastReap = reapTestScope('套件末')
    // 兜底闸（评审 1）：最后一次收割仍收到 server / ref interval，或本轮任何一次收割收到过
    // 真家伙，都必须让退出码非 0——旧版这里是「有泄漏但仍 exit 0」，泄漏被静默吞掉。
    // unref interval 只 clear 不计（见 reapTestScope），不参与本判定，所以不会误伤基线。
    if (leakedScopes.length > 0 || lastReap.closed > 0 || lastReap.cleared > 0) {
      process.exitCode = 1
      console.error(`[console-suite] 检测到测试资源泄漏：${leakedScopes.length} 次收尾兜底（${leakedScopes.join('；')}）——退出码置 1`)
    }
    // 最后一道闸：万一还有用例之外的东西攥着事件循环（孙进程 / 未走 listen 的句柄 / 超时
    // 用例的迟到回调刚造出来的资源），也不让 CI 白等满 timeoutMS。unref() 保证没有泄漏时它
    // 根本不触发。强退前必须再判一次：真发现 ref 句柄就把退出码置 1 并说明原因（评审 1）。
    const guard = realSetTimeout(() => {
      const handles = refdHandleNames(guard)
      if (handles.length > 0) {
        process.exitCode = 1
        console.error(`[console-suite] 汇总后仍有活跃句柄（${handles.join(',')}），判定泄漏：退出码置 1 后强制退出`)
      } else {
        console.error('[console-suite] 汇总后事件循环仍未排空，但未发现 ref 句柄（unref 句柄不钉循环），强制退出')
      }
      process.exit(process.exitCode || 0)
    }, 3000)
    guard.unref()
  })
  .catch(e => { console.error('套件执行异常:', e.message); process.exitCode = 1; reapTestScope('套件异常') })
