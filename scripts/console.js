'use strict'
// xbk-push 网页控制台（v3.298）：只读看板 + 手动触发。
//
// 设计约束（与仓库契约对齐，勿破坏）：
//   · 只依赖 node 内置模块 + scripts/status.js（零新 npm 依赖，青龙 --omit=dev 环境可用）；
//   · 状态展示与 --status 完全同源（readStatus/formatStatus），不另造解析口径；
//   · 手动触发用 spawnSync 拉起 qinglong/xbk_push.js 子进程（--dry-run / 单轮 / --check），
//     与命令行入口共享同一套门禁（ensureDependencies / nodeVersionWarning），不内嵌业务逻辑；
//   · 单飞锁：同一时刻只允许一个触发任务（跨触发模式互斥），用 run.lock（O_EXCL）实现，
//     锁文件含 pid 与启动时间，持有进程死亡后由 age 判定可安全接管；
//   · 鉴权：XBK_CONSOLE_TOKEN 必须设置且 ≥16 字符，否则服务拒启（fail-closed）；
//     token 比对用 timingSafeEqual（与 xbk_app 的先例同源）。
//
// 读取类端点只读缓存目录下的状态文件；触发类端点只 spawn 子进程并轮询其产物（stdout 捕获 + 退出码），
// 不写入任何缓存/状态文件——业务写入仍由被拉起的入口自己完成。

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { readStatus, formatStatus, readTrends, readMessages, readMessageCount, readRunHistory } = require('./status')
// v3.298 只读扩展的上限真源：xbk_utils 顶层零 require（纯常量+纯函数），控制台可安全引用；
// 墓碑计数走 readSafeTextResult 本尊（status.js 已有同款顶层依赖，无新增副作用面）。
const { MESSAGE_CACHE_MAX_BYTES, DEFAULT_MAX_SIZE, TOMBSTONE_MAX_KEYS, TOMBSTONE_MAX_BYTES } = require('../xbk_utils')
const { readSafeTextResult } = require('../xbk_storage')
const { statusCacheDir } = require('../qinglong/xbk_push')

// 推送缓存文件名：与生产 MessageStore.getFileName(Config.api.pushUrl) 同口径——pushUrl 末段
// 去查询串/hash 后清洗保留字符，非 http(s) 前缀的 url 走 bad_/default 特例（这里只关心正常形态）。
// 惰性 require 运行配置（与 qinglong/xbk_push.loadApp 同款 try/catch）：加载失败/未配置 → 'push.json'
// （默认 domain 的 pushUrl 末段就是 push.json）。自定义 pushUrl basename 的部署不再静默读错文件
// （Sourcery PR#227「Custom cache file is not shown」）。
// 站内基准域名：生产侧相对 url 用 Config.domain resolve（xbk_app urlOf 同口径）。默认
// https://new.ixbk.net（xbk_function_v3 Config 默认值）；读取失败回退默认值，前端不再硬编码错 host
// （Sourcery PR#227「Relative links use wrong host」）。
function sourceDomain () {
  try {
    const app = require('../xbk_function_v3')
    const d = app && app.Config && app.Config.domain
    return typeof d === 'string' && d.startsWith('http') ? d.trim().replace(/\/+$/, '') : 'https://new.ixbk.net'
  } catch (e) {
    return 'https://new.ixbk.net'
  }
}

// 运行侧缓存目录（Config.cache.dir 经 resolveCacheDirInRoot 的结果）：能取到则用于与控制台 stateDir
// 比对；取不到（加载失败/未配置）返回 null。仅告警用，不改变读取目录（状态文件体系仍以 stateDir 为准）。
function runtimeCacheDir () {
  try {
    const app = require('../xbk_function_v3')
    const resolved = app && app.MessageStore && app.MessageStore.cacheDir
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null
  } catch (e) {
    return null
  }
}

function messagesCacheName () {
  try {
    const app = require('../xbk_function_v3')
    const pushUrl = app && app.Config && app.Config.api && app.Config.api.pushUrl
    if (typeof pushUrl !== 'string' || pushUrl.length === 0) return 'push.json'
    let name = pushUrl.split('/').pop().split(/[?#]/)[0] || 'default'
    if (/^\.+$/.test(name)) name = 'default'
    name = name.replace(/[\\/:*?"<>|]/g, '_')
    return /\.json$/.test(name) ? name : `${name}.json`
  } catch (e) {
    return 'push.json'
  }
}

const ROOT = path.resolve(__dirname, '..')
const RUN_LOG_MAX_BYTES = 512 * 1024
const PROC_TIMEOUT_MS = 10 * 60 * 1000
const TOKEN_MIN_LEN = 16
// 消息列表（GET /api/messages）读取上限：push.json 是判重缓存主存（MESSAGE_CACHE_MAX_BYTES=64MiB
// 的生产写入上限），控制台只读展示按 32MiB 封顶——超过即 tooLarge，前端显示「记录过大不可读」，
// 与 run.log 尾读策略不同：列表必须整读才能排序/分页，半截 JSON 假装可读更危险。
const MESSAGES_MAX_BYTES = 32 * 1024 * 1024
// 日志查看（GET /api/logs）取尾部：日志消费方只关心最近的记录，与 scripts/status.js 的
// LOG_READ_OPTIONS.tail 同一口径（超限读尾 1MiB，不全拒）。
const LOG_VIEW_MAX_BYTES = 1024 * 1024
// 消息列表分页参数上限：单页条数 1–100，页码 1–10000（防御性钳制，URL 参数是未验证输入）。
const MESSAGES_PAGE_SIZE_MAX = 100
const MESSAGES_PAGE_MAX = 10000
// 搜索词长度上限（字节）：UTF-8 下 240 字节足够容纳 80 个汉字，防止超长 query 白耗 CPU。
const MESSAGES_QUERY_MAX_BYTES = 240

// ── v3.300 批次③ 3.2 消息导出常量 ───────────────────────────────────────────
// 单次导出行数上限：超出即截断 + 响应头 X-Export-Truncated: true 如实披露。
const EXPORT_MAX_ROWS = 5000
// 内容摘要截断宽度（JS 码元）：与 xbk_app.js:293 告警原因 .slice(0, 200) 同口径。
const EXPORT_EXCERPT_MAX = 200
// format 白名单：String 等值 includes，不进正则（用户输入不进正则红线）。
const EXPORT_FORMATS = Object.freeze(['csv', 'json'])
// CSV 表头（固定字面量；查询词绝不进文件名/表头）。
const EXPORT_CSV_HEADER = Object.freeze(['id', '时间', '分类', '标题', '内容摘要'])

// ── v3.298 只读扩展常量 ─────────────────────────────────────────────────────
// 取消宽限期：SIGTERM 后等子进程退出的时长，超时 SIGKILL 兜底（v3.299 批次②）。
// 单轮入口子进程未装 SIGTERM handler，实际近即时退出；宽限只为兼容未来 handler。
const CANCEL_GRACE_MS = 3000
// 运行历史单次下发上限（v3.299 批次②）：/api/run-history 的 limit 钳制区间。
const RUN_HISTORY_LIMIT_MAX = 200
const RUN_HISTORY_LIMIT_DEFAULT = 50

// ── v3.300 批次③ 3.1 SSE 常量 ───────────────────────────────────────────────
// run id 白名单（服务端常量正则，允许——与 detail/cancel body 解析、runMatch、lastAccept
// 落盘校验的同形内联正则同族；「用户输入不进正则」红线指的是用户输入参与构造/拼接的
// 正则，这里是服务端固定形态闸）。
const RUN_ID_RE = /^\d{13,}\.\d{1,10}$/
// 每连接增量 tick：轮查 runs.get(id) 存在性 / 增量 / 完结（500ms，实时感与 CPU 成本平衡）。
const SSE_TICK_MS = 500
// 心跳注释帧间隔：防代理/防火墙 idle 断连（蓝图口径 15s）。
const SSE_HEARTBEAT_MS = 15000
// 单连接「应用层待发积压」上限（UTF-8 字节）：超出直接断开该连接（慢客户端不拖垮内存）。
const SSE_MAX_PENDING = 1024 * 1024
// 每进程并发 SSE 连接上限：第 9 个 503（防 token 泄露后被刷连接拖垮控制台）。
const SSE_MAX_CONNECTIONS = 8

// /api/trends 的 days 白名单：URL 是未验证输入，只放行这三个值（非法/越界一律回默认 14，
// 向后兼容）。用固定数组 includes 而非正则（用户输入不进正则是本仓红线）。
const TREND_DAYS_ALLOWED = Object.freeze([14, 30, 60])
const TREND_DAYS_DEFAULT = 14
// /api/files 清单条目上限：正常状态目录 ≈10 个文件；截断防异常堆积（.corrupt 残留/误写）
// 拖垮响应。truncated:true 如实下发，不静默吞。
const FILES_LIST_MAX = 1000
// /api/cache-health 的「临近裁剪」判定比例：字节占用达到写入上限的 80% 即预警
// （下轮 saveBatch 将按字节裁最旧条目并落墓碑——运维该知道缓存快满了）。
const CACHE_HEALTH_NEAR_RATIO = 0.8

// ── 批次④ 4.1：通知自检的独立重放窗 ─────────────────────────────────────────
// 自检是高频调试动作，12min 太长；但也不能连点刷通知 → 60s。
// lastAccept 本就按 action 键控（per-action Map + 持久化 JSON 的 key），无需改持久化结构。
const REPLAY_WINDOW_NOTIFY_TEST_MS = 60 * 1000

// ── v3.300 访问日志常量 ─────────────────────────────────────────────────────
// 纯内存环形上限：重启即空、不写盘（README 披露）——避免日志自身成为磁盘面，
// 已有时序上更全的 run.log 留痕体系（蓝图 §3.3）。
const ACCESS_LOG_MAX = 200
// token 清洗正则：服务端常量、无用户输入参与构造（红线允许形态，先例 BEARER_PREFIX/
// sessionCookieValue 的手写解析同源纪律）。([?&;#]) 捕获保留分隔符：
// /?token=a → /?token=***（查询串形状不破坏）；键名大小写不敏感（Token=/TOKEN= 同洗——
// 「token 不进日志」不依赖键名大小写，审查 3.3-M1）；[^&;#]* 线性无回溯。
const ACCESS_TOKEN_RE = /([?&;#])[Tt][Oo][Kk][Ee][Nn]=[^&;#]*/g
// 详情轮询路径形态：与 /api/runs/:id 的 runMatch 同形的服务端常量正则
// （D4 定夺的降噪对象：GET /api/runs/<epoch.seq> 2xx 不记）。
const RUN_DETAIL_PATH_RE = /^\/api\/runs\/\d{13,}\.\d{1,10}$/

// 健康检查默认上限：entryMax 不取 DEFAULT_MAX_SIZE 常量而是运行侧 Config.cache.maxSize
// （MessageStore._resolveMaxSize 实际执行的口径）——常量在用户自定义 maxSize 时会展示
// 一个生产根本不执行的上限。Config 加载失败回退常量。
function defaultHealthLimits () {
  // entryMax 与 MessageStore._resolveMaxSize 同口径（Sourcery Medium：报出的 cap 必须等于
  // 实际强制值）。_resolveMaxSize 用 Utils.num(Config.cache.maxSize, -1) 后
  // Number.isInteger(v) && v > 0——Utils.num 接受数字字符串（env 覆盖 '5000' 场景），
  // 并拒绝空串/布尔/对象；这里逐条复刻该语义（不 require Utils：createUtils 依赖注入
  // safeRe，顶层引用会把那个耦合拖进控制台进程）。
  let entryMax = DEFAULT_MAX_SIZE
  try {
    const app = require('../xbk_function_v3')
    const ms = app && app.Config && app.Config.cache ? app.Config.cache.maxSize : null
    let n = null
    if (typeof ms === 'number' || typeof ms === 'string') {
      if (typeof ms !== 'string' || ms.trim() !== '') {
        try { n = Number(ms) } catch (e) { n = null } // Symbol/valueOf 抛错等脏配置回退默认
        if (typeof n === 'number' && !Number.isFinite(n)) n = null // NaN/Infinity 非法
      }
    }
    if (Number.isInteger(n) && n > 0) entryMax = n
  } catch (e) { /* 加载失败回退常量 */ }
  return {
    writeMaxBytes: MESSAGE_CACHE_MAX_BYTES,
    consoleReadMaxBytes: MESSAGES_MAX_BYTES,
    entryMax,
    tombstoneKeyMax: TOMBSTONE_MAX_KEYS,
    tombstoneMaxBytes: TOMBSTONE_MAX_BYTES
  }
}

// 三种触发模式 → 子进程参数。均跑一轮即退出（--dry-run 与单轮天然退出；--check 只做环境检查），
// 绝不启动常驻循环（网页服务自己就是长驻进程，嵌套常驻只会制造孤儿）。
// ⚠️ `run` 必须指向 xbk_function_v3.js（其 require.main 分支是 runSingleEntry：单轮 + 真实推送）；
// qinglong/xbk_push.js 无参数时是常驻模式——曾据此误配，Sourcery 评审指出后修正。
const ACTIONS = Object.freeze({
  'dry-run': { entry: 'qinglong', args: ['--dry-run'], label: '试运行（抓取但不推送）' },
  run: { entry: 'single', args: [], label: '正式运行一轮（真实推送）' },
  check: { entry: 'qinglong', args: ['--check'], label: '环境检查（不抓取不推送）' },
  // 批次④ 4.1：通知自检——真实推送一条固定测试消息。entry 必须是 'single'：startAction
  // 的映射是 `action.entry === 'single' ? ENTRY_SINGLE : ENTRY_QINGLONG`，任何其他值
  // 都落到 qinglong 入口（该入口不识别 --notify-test，会告警后落进常驻真实抓取）。
  'notify-test': { entry: 'single', args: ['--notify-test'], label: '通知自检（真实推送一条测试消息）' }
})
const ENTRY_QINGLONG = path.join(ROOT, 'qinglong', 'xbk_push.js')
const ENTRY_SINGLE = path.join(ROOT, 'xbk_function_v3.js')

function timingSafeEqualStr (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ba, bb)
  } catch (e) { return false }
}

// token 可用性口径（Sourcery Medium G_ot）：isValidToken 此前只看长度，但 token 要同时
// 走三条通道——Authorization 头（fetch 只接受 ByteString：非 Latin-1 直接抛错）、
// Set-Cookie（cookie-octet 禁 `;` `,` `"` `\` 与空白）、URL 查询参数。含这些字符的
// token 能启动服务却让浏览器端全部请求失败——校验前移到启动闸，fail-closed。
// 允许集：可见 ASCII（0x21–0x7e）再排除 `;` `,` `"` `\`。
// Sourcery M3Zv/Mline/Long-tokens：JS 正则的 $ 会在尾随换行（\n、\r、\u2028、\u2029）前
// 匹配成功，导致「合法 token + 尾部换行」被放行、随后污染 Cookie/URL 三通道。改用 \u0000-
// \uffff 闭区间显式断言「到串尾为止无任何字符」（[^] 不匹配空串但配合 + 语义即「至少 1 个
// 可见 ASCII 且到此为止」）。长度上限 TOKEN_MAX_LEN=200：浏览器单 Cookie 约 4KB 上限，
// 超长 token 会被静默丢弃导致资产/API 全 401，启动闸直接拒绝（fail-closed）。
const TOKEN_MAX_LEN = 200
const TOKEN_VISIBLE_ASCII_RE = /^[\x21-\x7e]+$/
// `&` `#` `+` 额外禁止（Sourcery Raw-token-URLs）：raw ?token= 打开时浏览器把 & 当参数分隔、
// # 当锚点、+ 在 URLSearchParams 里解码成空格——含这些字符的 token 让「文档里的 raw URL」
// 直接失效。对自用工具，禁掉比要求操作者 percent-encode 更可靠。
// `%` 额外禁止（Sourcery Percent-tokens）：raw ?token= 打开时 URLSearchParams 会对 %XX
// 做 decodeURIComponent——含合法 percent escape 的 token 会被浏览器改写后与配置值失配 → 401。
const TOKEN_UNSAFE_CHARS_RE = /[;,"\\&#+%]/
const TOKEN_TRAILING_JUNK_RE = /[\n\r\u2028\u2029]$/
function isValidToken (token) {
  return typeof token === 'string' && token.length >= TOKEN_MIN_LEN &&
    token.length <= TOKEN_MAX_LEN &&
    TOKEN_VISIBLE_ASCII_RE.test(token) && !TOKEN_UNSAFE_CHARS_RE.test(token) &&
    !TOKEN_TRAILING_JUNK_RE.test(token)
}

// ── 单飞锁 ─────────────────────────────────────────────────────────────────
// 锁文件写 {pid, startedAt}。接管判据：锁 age 超过 PROC_TIMEOUT_MS（与子进程超时一致）
// ⇒ 持有方已死或卡死，安全覆盖。活跃持有期内的重复触发返回 409。
function lockPath (stateDir) { return path.join(stateDir, 'console-trigger.lock') }

function writeLockAtomic (p, now, token) {
  // 独占创建 + 先写内容再占用：以 open(p,'wx') 抢占文件名（并发方在这里 EEXIST 失败），
  // 再把完整内容写进同一 fd。⚠️ 不能走 rename 覆盖路径——POSIX rename 会静默替换已存在
  // 目标，独占性名存实亡（回归教训见 test「并发获取拒绝」用例）。
  // token：进程级随机归属标识，释放/判定所有权须 pid+token 双匹配（评审 Medium：
  // 单看 pid 会被 OS 复用 pid 的后来进程误认；接管换主后也可能误删新主锁）。
  const fd = fs.openSync(p, 'wx')
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, token }))
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

function acquireLock (stateDir, now, token) {
  const p = lockPath(stateDir)
  try {
    // 第一层：直接独占创建（无锁时最常见路径）。
    writeLockAtomic(p, now, token)
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') return false
  }
  // 第二层：锁已存在——读内容判定死活。陈旧接管仍以「独占 rename 覆盖」收口：
  // rename 覆盖是原子替换，两个并发接管进程各自 prepared tmp 后同时 rename，
  // 只有一个会成功成为最终内容——但两者都已判定 takeover 并 spawn。故接管前用
  // 独占哨兵：先以 wx 创建 `<name>.takeover` 抢接管权，抢到的才允许覆盖锁。
  try {
    const raw = fs.readFileSync(p, 'utf8')
    let startedAt = 0
    let corrupted = false
    let released = false
    try {
      const parsed = JSON.parse(raw)
      startedAt = Number(parsed.startedAt)
      // released 锁（releaseLockFor 覆写作废）：语义等价无锁，立即接管，不判 age。
      released = parsed.released === true
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) corrupted = true
    } catch (err) { corrupted = true }
    // 锁内容损坏/startedAt 无效（Sourcery Medium #11）：无法判定持有方死活，fail-closed
    // 视为仍被持有，由外部人工清理（README「故障排查」节说明）。不降级为按 age 接管——
    // 那会让损坏锁在超时后被自动覆盖，重新引入「无法安全分类的锁被承认」问题。
    if (corrupted && !released) return false
    const stale = released || now - startedAt > PROC_TIMEOUT_MS
    if (!stale) return false
    // 陈旧/损坏锁接管：哨兵独占，防并发接管双跑（Sourcery High）。
    const sentinel = p + '.takeover'
    let claimed = false
    try {
      const fd = fs.openSync(sentinel, 'wx')
      fs.closeSync(fd)
      claimed = true
    } catch (err) {
      if (err.code === 'EEXIST') {
        // 哨兵已存在：看它是否也陈旧（上次接管者死了留下的）。
        try {
          const sAge = now - (fs.statSync(sentinel).mtimeMs || 0)
          if (sAge > PROC_TIMEOUT_MS) {
            fs.writeFileSync(sentinel, String(now))
            claimed = true
          }
        } catch (err2) { claimed = false }
      }
    }
    if (!claimed) return false
    // takeover 路径不能再用 open(wx) 写锁（目标存在必 EEXIST）：走「临时文件 + rename
    // 原子换代」。rename 原子替换且**换 inode**——仍握着旧 inode fd 的旧持有者，其
    // releaseLockFor 的原地覆写只会落进孤儿 inode，绝不可能盖掉新持有者的锁帧
    // （Sourcery #225 High：直写同 inode 时「旧主已 read、takeover 已覆写、旧主再 write」
    // 的窗口会让 released 帧覆盖新主锁帧，第三进程可再接管造成动作重叠）。带本进程 token。
    const tmp = `${p}.${process.pid}.${now}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: now, token }))
      fs.renameSync(tmp, p)
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch (e2) { /* tmp 未建成 */ }
      try { fs.unlinkSync(sentinel) } catch (e2) { /* 并发接管者会各自清自己的 */ }
      return false
    }
    try { fs.unlinkSync(sentinel) } catch (err) { /* 并发接管者会各自清自己的 */ }
    return true
  } catch (err) {
    return false
  }
}

// releaseLock（按路径 unlinkSync 删锁）已删除（v3.296）：本仓 CodeQL 铁律——锁类代码
// 禁止 unlinkSync 按路径删（check-then-act），释放一律走 releaseLockFor 的原地覆写作废。
// 它此前已无生产调用方，继续留在导出面就是未来的回归入口。

// ── 触发执行 ───────────────────────────────────────────────────────────────
// 子进程输出进内存缓冲（环形上限 RUN_LOG_MAX_BYTES，按 UTF-8 字节计），供看板轮询；
// 运行中即可读（增量写 record.output）。state 存进程内 Map（重启即空——锁文件在，
// 重启后第一次触发会因陈旧锁接管或等待，不会双跑）。
const runs = new Map()
// run ID = 「进程 epoch.单调序列」（Sourcery #229-1：runSeq 重启归零会让重启前的旧
// cancel/详情请求在序列复用后命中**新**任务——结构性误杀）。epoch 取控制台进程启动
// 毫秒（同进程内恒定，跨进程几乎必异），Map 键用完整 id 字符串，旧进程的 id 重启后
// 必然查无 → 404，不可能命中新记录。
const runEpoch = String(Date.now())
function makeRunId (seq) { return `${runEpoch}.${seq}` }

let runSeq = 0
function startAction (actionKey, now, activeChildren, stateDir) {
  const action = ACTIONS[actionKey]
  const id = makeRunId(++runSeq)
  const entryFile = action.entry === 'single' ? ENTRY_SINGLE : ENTRY_QINGLONG
  const record = {
    id,
    action: actionKey,
    label: action.label,
    startedAt: now,
    finishedAt: 0,
    exitedAt: 0, // exit 事件时刻（先于 close：stdout/stderr drain 中已不可取消）
    exitCode: null,
    timedOut: false,
    output: '',
    outputTotalLength: 0,
    cancelled: false
  }
  runs.set(id, record)
  if (runs.size > 20) {
    // 只保留最近 20 条：按 seq 最小的清理（id=epoch.seq，同进程 epoch 恒定，seq 单调递增）。
    const oldest = [...runs.keys()].sort((a, b) => runs.get(a).startedAt - runs.get(b).startedAt).slice(0, runs.size - 20)
    for (const k of oldest) runs.delete(k)
  }
  // 环境继承：剥离 XBK_DRY_RUN（Sourcery High：控制台自身带 XBK_DRY_RUN=1 时，
  // 「正式运行」会被子进程静默降级为 dry-run，承诺的推送不会发生）；剥离
  // XBK_CONSOLE_TOKEN（子进程及其再拉起的工具、崩溃时的 env dump 都不该带控制台凭证）。
  const childEnv = { ...process.env }
  delete childEnv.XBK_DRY_RUN
  delete childEnv.XBK_CONSOLE_TOKEN
  // 子进程缓存/日志目录钉死到本控制台实例的 stateDir（Sourcery：测试实例的临时 stateDir
  // 若不下传，子进程会回落到仓库生产缓存 → 测试触发的轮次/停止留痕混进生产 run.log）。
  if (stateDir) childEnv.XBK_CACHE_DIR = stateDir
  const child = (() => {
    try {
      return spawn(process.execPath, [entryFile, ...action.args], {
        cwd: ROOT,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      // spawn 同步抛（EMFILE 等资源极端）：runs 里已登记死记录，必须摘除后再抛，
      // 让调用侧 acceptAction 回滚重放帧与锁（Sourcery Medium：Failed spawn leaves trigger locked）。
      runs.delete(id)
      throw e
    }
  })()
  if (activeChildren) activeChildren.add(child)
  const decoder = new StringDecoder('utf8')
  const append = (chunk) => {
    // StringDecoder 处理跨 chunk 的多字节 UTF-8（Sourcery Medium：逐 chunk toString 产生替换符）。
    const produced = decoder.write(chunk) // 本 chunk 解码产物（现有 UTF-16 头部丢码元语义保留不动）
    let buf = record.output + produced
    // 上限按 UTF-8 字节计（Buffer.byteLength），超限从字节边界近似回退丢头部。
    if (Buffer.byteLength(buf, 'utf8') > RUN_LOG_MAX_BYTES) {
      let drop = Buffer.byteLength(buf, 'utf8') - RUN_LOG_MAX_BYTES
      while (drop > 0 && buf.length > 0) {
        drop -= Buffer.byteLength(buf[0], 'utf8')
        buf = buf.slice(1)
      }
    }
    record.output = buf
    // 单调总偏移计数器（v3.300 3.1）：统计「生产总量」而非现存长度——环形淘汰（上方头部
    // 丢码元）只减 output.length 不减计数器，SSE 的 reset 判据 cursor < total − 缓冲长依赖它。
    record.outputTotalLength += produced.length
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  // 取消句柄：cancel 端点只经这个对象引用发信号（内核按 spawn 时句柄定位，天然免疫
  // pid 复用）。绝不按锁帧 pid kill——那是控制台进程自己的 pid（v3.299 评审预审要点）。
  record._child = child
  child.on('error', (err) => {
    // spawn 失败（ENOENT 等）：不能让 uncaught 崩掉控制台（Sourcery Medium），
    // 也不能把 run 永久留在「运行中」。close 事件在 spawn error 后仍会触发，
    // 这里只登记原因，收尾交给 close。
    // 绕过 append 直改 output：计数器必须同步加（漏加会让 reset 判据失真，§1.3 理由）。
    const note = `\n[console] 子进程启动失败：${err && err.message ? err.message : String(err)}\n`
    record.output += note
    record.outputTotalLength += note.length
  })
  const timer = setTimeout(() => {
    record.timedOut = true
    try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
  }, PROC_TIMEOUT_MS)
  child.on('exit', () => {
    // Sourcery #229-10：exit 先于 close（输出流 drain 中）。取消判据用 exitedAt，
    // 避免「进程已退出但 close 未到」窗口里 cancel 误杀已自然完成的任务。
    record.exitedAt = Date.now()
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    // Sourcery #229-0：取消宽限定时器一并清理（子进程已死，SIGKILL 兜底失去意义）。
    if (record._cancelTimer) { clearTimeout(record._cancelTimer); record._cancelTimer = null }
    if (activeChildren) activeChildren.delete(child)
    record.exitCode = code
    record.finishedAt = Date.now()
    // Sourcery #225 M4：释放失败（磁盘/权限异常持续、或锁已换主）必须响亮上报，
    // 不许静默当作已释放——锁残留时后续触发 409 属预期，运维按 README「故障排查」处理。
    if (!releaseLockFor(record)) {
      console.error(`⚠️ 任务 #${record.id} 的触发锁释放失败（文件系统异常或锁已换主）：锁将保留到陈旧接管（约 10 分钟），期间触发 409 属预期；持续出现请按 README「故障排查」处理。`)
    }
  })
  return record
}

function releaseLockFor (record) {
  // 只有仍持有锁的本次运行才释放：锁被陈旧接管后 pid 换人，此时不误删。
  // 归属判定 pid + token 双匹配（单看 pid 会被 OS pid 复用/接管换主绕过，评审 Medium）。
  // 竞态收口（Sourcery #225 High）：takeover 已走 tmp+rename 原子换代，这里再加一道
  // **inode 一致性闸**（fstat(fd) vs stat(path)）——不一致即锁已被接管换名，直接放弃
  // 覆写；旧 fd 的任何写入都只落在孤儿 inode 上，碰不到新持有者的锁帧。
  // TOCTOU 收口（评审 Medium G5K + CodeQL js/file-system-race）：全程不 unlink 锁路径，
  // 释放动作本身保持原地覆写（rename 释放是无条件替换，反而会重新打开覆写新主的窗口）。
  // 返回值（Sourcery #225 M3）：true = 锁已释放（released 帧已写 / 已是 released / 不存在）；
  // false = 锁仍处于持有态（写失败 / 已归他人且未释放）——调用方必须对 false 响亮处理，
  // 不许静默当作已释放。
  const p = lockPath(record._stateDir)
  let fd = null
  try {
    fd = fs.openSync(p, 'r+')
  } catch (e) {
    return true // 锁已不在：无事可释放
  }
  try {
    const raw = fs.readFileSync(fd, 'utf8')
    const data = JSON.parse(raw)
    if (data.pid === process.pid && data.token === record._lockToken) {
      // inode 一致性闸：两代不一致 = 已被 tmp+rename 接管换名，本 fd 只指向孤儿
      // inode——不覆写，锁归接管方负责（返回 false 如实上报）。
      let pathIno = 0
      try { pathIno = fs.statSync(p).ino } catch (e) { return true /* 锁路径已消失 */ }
      if (fs.fstatSync(fd).ino !== pathIno) return false
      // 归属成立：原地单次 writeSync 覆写为 released 短帧（同 inode，无 unlink）。
      // released 帧必须**不大于**原帧（ASCII 锁帧下恒成立）：writeSync 定长覆写不会
      // 追长文件，短出的字节以空格补到原长（JSON 尾部空白合法）——任意时刻读到的
      // 要么是完整旧锁、要么是完整 released 帧，跨扇区半旧半新窗消失（v3.296 前
      // released 帧含 pid/startedAt/token，恒比原帧长，「补空格」分支是死代码，
      // 半旧半新承诺未兑现——三轮审查修正）。归属判定已完成，pid/startedAt/token
      // 无保留价值，短帧正是补空格分支生效的前提。
      const releasedFrame = Buffer.from('{"released":true}', 'utf8')
      const origLen = Buffer.byteLength(raw, 'utf8')
      let payload = releasedFrame
      if (origLen > releasedFrame.length) {
        payload = Buffer.concat([releasedFrame, Buffer.alloc(origLen - releasedFrame.length, 0x20)])
      }
      // 短写收口（Sourcery #225 M1）：writeSync 可能少写（信号中断/磁盘紧张），残尾
      // 旧字节会让 JSON.parse 失败 → fail-closed 10 分钟。按返回字节数循环补写到位。
      let off = 0
      while (off < payload.length) {
        off += fs.writeSync(fd, payload, off, payload.length - off, off)
      }
      fs.fsyncSync(fd)
      return true
    }
    // 不是我们的锁：已是 released 帧视为已释放；仍是活的他人锁则如实返回 false
    // （由持有方负责释放，我们不碰）。
    return data.released === true
  } catch (e) {
    return false
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (e) { /* 已关 */ } }
  }
}

// ── 静态资产（前端现代化 v3.285）────────────────────────────────────────────
// 前端是零依赖 preact+htm standalone（scripts/console-assets/，无构建、无 CDN）。
// 仅伺服白名单内的静态文件：路径映射写死，不存在用户输入拼接（无路径穿越面）。
const ASSETS_DIR = path.join(__dirname, 'console-assets')
const STATIC_ASSETS = Object.freeze({
  '/assets/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/htm-preact.module.js': { file: 'htm-preact.module.js', type: 'text/javascript; charset=utf-8' }
})

// 资产存储（v3.302）：启动时一次性读盘成快照（raw/gzip/ETag 常驻内存，三文件 < 100KB）。
// 版本号 = 三文件内容哈希的 sha16，renderPage 以 ?v=<sha16> 引用；带当前版本的 URL 可长缓存
// （private + immutable），裸 URL 仍 no-cache（测试与旧页面兼容）。部署 = systemd restart。
//
// 一致性（评审 #236 · Sourcery Medium）：读盘前后各取一次 (mtime,size) 快照，不一致说明
// 部署正在替换资产 ⇒ 重试一次，仍不一致则 fail-closed，绝不把两个版本的资产拼在同一快照里。
let assetStore = null

function assetStatSignature () {
  return Object.entries(STATIC_ASSETS)
    .map(([, spec]) => {
      const st = fs.statSync(path.join(ASSETS_DIR, spec.file))
      return `${spec.file}:${st.size}:${st.mtimeMs}`
    })
    .join('|')
}

function buildAssetStore () {
  const table = new Map()
  const hashes = []
  for (const [route, spec] of Object.entries(STATIC_ASSETS)) {
    const raw = fs.readFileSync(path.join(ASSETS_DIR, spec.file))
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
    table.set(route, {
      spec,
      raw,
      gzip: zlib.gzipSync(raw, { level: 9 }),
      etag: `"${hash}"`,
      gzipEtag: `"${hash}-gz"`
    })
    hashes.push(hash)
  }
  return {
    table,
    version: crypto.createHash('sha256').update(hashes.join('|')).digest('hex').slice(0, 16)
  }
}

function loadAssets () {
  if (assetStore) return assetStore
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = assetStatSignature()
    const built = buildAssetStore()
    if (before === assetStatSignature()) {
      assetStore = built
      return assetStore
    }
  }
  throw new Error('控制台前端资产在读取期间被替换（部署进行中？），拒绝以混合版本继续')
}

function assetQuery () {
  try {
    return `?v=${loadAssets().version}`
  } catch (e) {
    // createConsole 的启动闸已保证资产可读；这里兜底成裸 URL，页面仍可用（只是没有长缓存）。
    return ''
  }
}

// Accept-Encoding：按 RFC 9110 只认「显式接受且 q>0」的 gzip（含 * 通配）。
function acceptsGzip (header) {
  const parts = String(header || '').split(',')
  for (const part of parts) {
    const segs = part.trim().toLowerCase().split(';')
    const token = segs[0].trim()
    if (token !== 'gzip' && token !== '*') continue
    const q = segs.slice(1).map(x => x.trim()).find(x => x.startsWith('q='))
    if (!q) return true
    const val = Number(q.slice(2))
    if (Number.isFinite(val) && val > 0) return true
  }
  return false
}

// If-None-Match：支持 *、逗号列表与弱比较（GET 语义）。
function etagMatches (header, etag) {
  const raw = String(header || '').trim()
  if (!raw) return false
  if (raw === '*') return true
  const strip = (v) => v.trim().replace(/^W\//, '')
  const mine = strip(etag)
  return raw.split(',').some(candidate => strip(candidate) === mine)
}

function serveStatic (req, res, route, spec) {
  let store
  try {
    store = loadAssets()
  } catch (e) {
    sendJson(res, 500, { error: '控制台前端资产缺失（仓库不完整？）' })
    return
  }
  const entry = store.table.get(route)
  const useGzip = acceptsGzip(req.headers['accept-encoding'])
  const etag = useGzip ? entry.gzipEtag : entry.etag
  let versioned = false
  try {
    versioned = new URL(req.url, 'http://localhost').searchParams.get('v') === store.version
  } catch (e) { /* 畸形 URL 交给上层校验；这里按裸 URL 处理 */ }
  const headers = {
    'Content-Type': spec.type,
    // 资产与数据同面鉴权（无凭证 401）：只能进浏览器私有缓存，绝不能让共享缓存
    // 把一次带凭证的响应复用给未鉴权调用方（评审 #236 · Sourcery Medium）。
    'Cache-Control': versioned ? 'private, max-age=31536000, immutable' : 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding'
  }
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  if (useGzip) headers['Content-Encoding'] = 'gzip'
  res.writeHead(200, headers)
  res.end(useGzip ? entry.gzip : entry.raw)
}

// ── HTML 看板 ──────────────────────────────────────────────────────────────
function escapeHtml (s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function formatMs (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 100) / 10
  return `${s}s`
}

// ── 访问日志（v3.300）──────────────────────────────────────────────────────
let accessStampFmt = null
function accessStamp () {
  // 惰性单例 + 兜底（D7）：sv-SE + Asia/Shanghai 与 run.log 留痕戳同参同输出；
  // 顶层惰性而非 require 期构造——防 ICU 异常炸 import。at 是展示字段
  // （数组下标即权威时序），格式 YYYY-MM-DD HH:mm:ss。
  if (!accessStampFmt) {
    try {
      accessStampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    } catch (e) { return new Date().toISOString() }
  }
  try { return accessStampFmt.format(new Date()) } catch (e) { return new Date().toISOString() }
}

function washTokens (s) {
  // 迭代到不动点：堵重复 token 参数逃逸（?a=1&token=x&token=y 这类拼接形态）。
  // g 标志单轮即全量替换，但迭代写法对任意拼接形态都收口到不动点，成本恒为零或一轮。
  let prev = null
  while (prev !== s) { prev = s; s = s.replace(ACCESS_TOKEN_RE, '$1token=***') }
  return s
}

// 尽力解码（评审 231-555）：decodeURIComponent 全串版对任何畸形 % 序列整体抛错，
// 导致「编码 token 键 + 无关畸形转义」同串时 token 洗不掉。逐段解码：可解的 %xx
// 解开，非法序列原样保留——不抛错、不丢段。
function bestEffortDecode (s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '%') { out += c; continue }
    const hex = s.slice(i + 1, i + 3)
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16))
      i += 2
    } else {
      out += c
    }
  }
  return out
}

function sanitizeAccessPath (raw) {
  // 脱敏硬闸（蓝图防线 1）：先原串洗，再「解码→复洗」至不动点（D6，堵 %74oken= /
  // %2574oken= 及更深编码键名；上限 16 轮防病态深嵌套，URL 编码超过 16 层无实际形态）。
  // 解码失败（畸形 % 序列抛 URIError）不再提前 return（评审 231-555：那会放过同串的
  // 编码 token 键）——改用逐段尽力解码后继续洗；全失败也保有已洗串。
  // 先例口径：sessionCookieValue 对畸形 Cookie 按「无有效值」处理，绝不炸主链路。
  // 注意：解码后若洗出了 token，返回的是解码形态路径（内容已 *** 化，泄露面为零）。
  let s = washTokens(String(raw == null ? '' : raw))
  for (let round = 0; round < 16; round++) {
    let d
    try { d = decodeURIComponent(s) } catch (e) { d = bestEffortDecode(s) }
    if (d === s) return s
    s = washTokens(d)
  }
  return s
}

function shouldLogAccess (method, pathname, statusCode) {
  // 降噪白名单（蓝图「记什么」）：仅 2xx 且命中白名单才免记；非 2xx（含 401/404/5xx）全记。
  // 白名单 = GET / 页面、GET /api/status、GET /api/runs 列表、GET /api/runs/:id 详情、
  // POST /api/runs/detail（D4：前端实际形态，响应体与 GET /:id 等价）、静态三资产、
  // GET /api/runs/stream（v3.300 3.1：SSE 连接分钟级，finish 时 ms=整段连接时长，
  // 照记会污染「慢请求」读数；非 2xx 照记）。
  // /api/access-log 自身 200 不在名单 → 入日志（自举，蓝图防线 3）。
  if (!(statusCode >= 200 && statusCode <= 299)) return true
  const m = method === 'GET'
  const p = String(pathname || '')
  if (m && (p === '/' || p === '/api/status' || p === '/api/runs' || p === '/api/runs/stream' ||
    Object.prototype.hasOwnProperty.call(STATIC_ASSETS, p))) return false
  if (m && RUN_DETAIL_PATH_RE.test(p)) return false // D4：GET 详情轮询
  if (method === 'POST' && p === '/api/runs/detail') return false // D4：POST 详情轮询（前端实际形态）
  return true
}

function renderPage (state, runsList, query, sessionToken) {
  const statusText = formatStatus(state)
  const statusLines = statusText.split('\n').map(escapeHtml)
  // 浏览器流（Sourcery High）：fetch/ESM 也带不了页内凭证之外的上下文，token 经
  // 查询参数进入页面后由 JSON 岛交给前端 fetch。仅在本请求本身通过鉴权后才回显
  // （token 已验证合法，原样传递；不新增任何存储）。
  // 兼容语义：<noscript> 环境保留纯 HTML 降级（状态文本 + 提示），核心信息不丢。
  // Sourcery G_4Kk：资产 URL 不再拼 tokenSuffix——资产鉴权已由会话 Cookie 覆盖
  // （页面响应下发 xbk_session，同源请求自动携带），URL 里重复凭证只会多日志暴露面。
  // Sourcery Authenticated-page-boots-bad-credentials：query.get('token') 是未验证输入
  // （请求可能靠 Cookie/Bearer 通过鉴权、却带了垃圾 ?token=）——boot 必须用「本次请求实际
  // 通过验证的凭证」（sessionToken，由调用方传入 authorize 的通过值），query token 仅在
  // 没有 sessionToken 时作为兼容回退。
  const bootToken = (typeof sessionToken === 'string' && sessionToken.length > 0)
    ? sessionToken
    : ((query instanceof URLSearchParams && query.get('token')) ? query.get('token') : '')
  // JSON 岛（<script type="application/json"> 的文本内容）：script 文本不做 HTML 实体解码，
  // escapeHtml 的 &quot; 会原样留在 JSON 里被前端 parse 成错误 token（Sourcery vwK）。
  // 只需防 </script> 逃逸与注释/CDATA 攻击：把 < 和控制字符转成 \uXXXX JSON 转义
  // （JSON.parse 会还原成原字符；/ 也转义防 </script> 序列被拼出）。
  const bootJson = JSON.stringify({ token: bootToken })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>xbk-push 控制台</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP_HEADER}">
<link rel="stylesheet" href="/assets/app.css${assetQuery()}">
</head><body>
<div id="app"><noscript>
<section style="max-width:60rem;margin:2rem auto;font-family:system-ui,sans-serif">
<h2>xbk-push 控制台（无脚本降级）</h2>
<pre>${statusLines.join('\n')}</pre>
<p>前端需要启用 JavaScript 才能使用触发与实时刷新。可用动作：试运行（抓取但不推送）、正式运行一轮（真实推送）、环境检查（不抓取不推送）、通知自检（真实推送一条测试消息）。</p>
</section>
</noscript></div>
<script type="application/json" id="xbk-boot">${bootJson}</script>
<script type="module" src="/assets/app.js${assetQuery()}"></script>
</body></html>`
}

// ── HTTP 服务 ──────────────────────────────────────────────────────────────
// 鉴权：Authorization: Bearer *** 或 ?token=***（Sourcery High：浏览器导航、原生表单、
// meta refresh 都带不了自定义请求头，只有查询参数能让浏览器直接打开看板）。
// 单用户自用工具，恒定 token 已足够；timingSafeEqual 防时序侧信道。
// 解析不用正则（CodeQL js/polynomial-redos：`Bearer ` + 大量空白会让 `\s+(.+)$` 回溯）：
// 手写前缀匹配 + 切片，线性且语义等价（`Bearer ` 后取剩余全部，trim 一次容忍尾随空白）。
// ⚠️ ?token= 会进访问日志/浏览器历史：README 明确建议只在受信网络或 TLS 代理后使用。
const BEARER_PREFIX = 'Bearer '
// RFC 9110：auth-scheme 大小写不敏感——`bearer <token>` 同样合法，客户端按规范
// 发小写 scheme 不得被 401（v3.296 修正）。仍走手写前缀匹配 + 切片（不引入正则）。
const BEARER_PREFIX_LOWER = 'bearer '
// CSP 完整指令（v3.296：frame-ancestors 只能经 HTTP 响应头下发——<meta http-equiv>
// 形态被浏览器按规范忽略，此前仅 meta 承载的 frame-ancestors 'none' 是 no-op）。
// GET / 以响应头下发完整 CSP；HTML 内 meta 保留同串兜底（中间层剥头时仍有约束）。
const CSP_HEADER = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
// 会话 Cookie 名（Sourcery G_oJ：ESM import/静态资产请求无法带 Authorization 头，
// 页面鉴权后下发 HttpOnly Cookie，浏览器同源请求自动携带）。
const SESSION_COOKIE = 'xbk_session'
// 从 Cookie 头取会话值：手写解析（分号分段 + 首个 = 切分），不用正则
// （CodeQL js/polynomial-redos：cookie 值虽是自产 token，解析仍保持线性）。
// Sourcery Critical G_4Ki：decodeURIComponent 对畸形序列（如 %）会抛 URIError——
// 任何畸形 Cookie 都不能炸请求处理器：解析异常一律按「无有效 Cookie」处理。
function sessionCookieValue (cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim()
      if (value.length === 0) return null
      try { return decodeURIComponent(value) } catch (e) { return null }
    }
  }
  return null
}
function authorize (req, token, urlQuery) {
  const header = req.headers.authorization || ''
  if (typeof header === 'string' && header.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX_LOWER) {
    const value = header.slice(BEARER_PREFIX.length)
    if (value.length > 0 && timingSafeEqualStr(value.trim(), token)) return true
  }
  // 浏览器路径：?token=xxx（urlQuery 由调用方传 URLSearchParams；单独接收以便测试）
  const supplied = urlQuery instanceof URLSearchParams ? urlQuery.get('token') : null
  if (typeof supplied === 'string' && supplied.length > 0 && timingSafeEqualStr(supplied, token)) return true
  // 会话 Cookie 路径（Sourcery G_oJ）：仅用于「读取面」——GET 页面与静态资产。
  // 写动作（POST /trigger）不接受 Cookie：SameSite=Strict 挡不住同站子域/同源注入页
  // 的表单伪造（Sourcery High G_4Kb Forged push actions），POST 保持显式凭证
  // （Bearer 头或 ?token=，两者都要求请求方真实持有 token）。
  if (req.method !== 'POST') {
    const cookie = sessionCookieValue(req.headers && req.headers.cookie)
    if (cookie !== null && timingSafeEqualStr(cookie, token)) return true
  }
  return false
}

function sendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

// SSE 增量规划（纯函数，模块级——非 HTTP 单测 + 变异可达，照导出先例）。
// cursor = 已发游标，**绝对偏移**，单位 = JS 字符串偏移（UTF-16 code units）——量取、切片、
// 下发三处同单位（蓝图红线：不用「字节」描述，杜绝多字节文本偏移错位）。
// output = 环形缓冲现存串；outputTotalLength = 生产总量单调计数器（只增）；
// lost = outputTotalLength − output.length = 已被环形淘汰的头部码元数。
// 分支：cursor < lost ⇒ 游标落后淘汰点（数据已不完整）→ reset + 整段重发；
//       lost ≤ cursor < total ⇒ 正常增量 output.slice(cursor − lost)；
//       cursor ≥ total ⇒ 无新数据（含 cursor > total 的超前/伪造游标，静默对齐为等新数据）。
// 多字节正确性论证：cursor 恒落在「某次 append 边界」= StringDecoder.write() 整段解码边界，
// 4 字节 UTF-8（代理对）整对解码追加、不会被 cursor 切半；环形淘汰的头部丢码元（append 的
// buf.slice(1)）可把代理对劈成孤立代理——只影响 reset 分支的整段 text，JSON.stringify
// （ES2019 well-formed，Node 22）会把孤立代理转义为 \uD8XX，JSON.parse 原样还原，传输无损。
function ssePlanChunk (cursor, output, outputTotalLength) {
  const lost = outputTotalLength - output.length
  if (cursor < lost) return { reset: true, text: output, cursor: outputTotalLength }
  if (cursor < outputTotalLength) return { reset: false, text: output.slice(cursor - lost), cursor: outputTotalLength }
  return null
}

function readBody (req, maxBytes = 4096) {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8')
    let buf = ''
    let over = false
    let aborted = false
    req.on('data', (c) => {
      if (over) { req.destroy(); return } // Sourcery Medium：超限即断流，不再吸收内存
      buf += decoder.write(c)
      if (buf.length > maxBytes) over = true
    })
    req.on('end', () => resolve({ body: buf + decoder.end(), over, aborted }))
    // Sourcery Medium：error 时标记 aborted——残缺 body 不允许触发动作。
    req.on('error', () => { aborted = true; resolve({ body: buf, over, aborted }) })
    req.on('aborted', () => { aborted = true; resolve({ body: buf, over, aborted }) })
  })
}

// 超长 query 按 UTF-8 字节从尾截断（中文按字符截到字节边界）——/api/messages 与
// /api/messages/export 共用同一钳制口径，防两端「截断后搜的词不一样」。
function clampQueryBytes (query) {
  while (Buffer.byteLength(query, 'utf8') > MESSAGES_QUERY_MAX_BYTES) query = query.slice(0, -1)
  return query
}

// 消息过滤谓词（v3.300 3.2 从 /api/messages 抽出，两处复用——变异测试只打一处）。
// cate 精确等值（'(未分类)' 归一，与列表端点两处口径一致）；needle 为已 trim+toLowerCase 的
// 子串（title/content 双字段）。q/cate 全程不进正则（ReDoS 红线）：只用 includes 与 String 等值。
function filterMessageItems (items, cate, needle) {
  let out = items
  if (cate.length > 0) {
    out = out.filter((m) => (typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)') === cate)
  }
  if (needle.length > 0) {
    out = out.filter((m) =>
      (typeof m.title === 'string' && m.title.toLowerCase().includes(needle)) ||
      (typeof m.content === 'string' && m.content.toLowerCase().includes(needle)))
  }
  return out
}

// CSV 单元格转义（CWE-1236 防公式注入）。顺序定夺：①中性化（内容层）在前、②引号包裹（传输层）在后。
// 理由：RFC 4180 的引号包裹是解析器会撤销的传输编码，电子表格求值发生在解析之后——中性化必须
// 作用于「解析后的内容」，故先对原始值做，再包裹；若先包裹，被包裹单元格首字符恒为 "，首字符
// 判定失真。Excel/Sheets 惯例：前置 '（text prefix）使其后内容按文本求值。
// ① 公式中性化：跳过 spreadsheet 求值忽略的前导字符（空格/\t/\r/\n/'）找到首个有效字符，
//    命中 = + - @ \t 即整体前置 '（前缀字符本身保留，不删数据）。
// ② RFC 4180 引号包裹：含 " , \r \n 任一即整体用 " 包裹、内部 " 翻倍；CR/LF 留在引号内
//    （RFC 4180 §2.6 标准转义，Excel/Sheets 正确解析；这是「CRLF 转义」的落实形态）。
function csvCell (value) {
  let s = value === undefined || value === null ? '' : String(value)
  let i = 0
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n' || s[i] === "'")) i++
  if (i < s.length) {
    const c = s[i]
    if (c === '=' || c === '+' || c === '-' || c === '@' || c === '\t') s = "'" + s
  }
  if (s.includes('"') || s.includes(',') || s.includes('\r') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// 截断到 max 码元且不在代理对中间落刀（评审 231-M6）：slice 后若末码元是孤立高代理
// （D800-DBFF 且后无低代理），回退一码元。纯函数。
function excerptTruncated (text, max) {
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1)
  return cut
}

// 导出行白名单映射（v3.300 3.2）：id/time/cate/title/excerpt 五字段，绝不透传原始条目对象
// （readMessages 返回的 items 是未裁剪条目，url/price/cateid/content_html/判重身份一律不带走）。
function exportRowOf (m) {
  return {
    // id：number|string → String；缺失回 ''（与 /api/messages 下发裁剪口径一致）
    id: typeof m.id === 'number' || typeof m.id === 'string' ? String(m.id) : '',
    // time：datetime + shorttime 拼接（页面展示口径）；两端 trim，双缺省得 ''
    time: `${typeof m.datetime === 'string' ? m.datetime : ''} ${typeof m.shorttime === 'string' ? m.shorttime : ''}`.trim(),
    // cate：'(未分类)' 归一（与列表端点一致）
    cate: typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)',
    title: typeof m.title === 'string' ? m.title : '',
    // 内容摘要：200 码元截断（xbk_app.js:293 先例口径；蓝图未要求字节级更严）。
    // 截断点落在代理对中间（末码元是孤立高代理）时回退一码元——劈开的 emoji 经
    // JSON.stringify 转义为孤立代理（ES2019 well-formed），CSV UTF-8 编码则变 U+FFFD，
    // 消费方拿到的是半个字符（评审 231-M6）。
    excerpt: typeof m.content === 'string' ? excerptTruncated(m.content, EXPORT_EXCERPT_MAX) : ''
  }
}

// CSV 装配：表头 + 数据行，行分隔 \r\n（RFC 4180），尾行也带 \r\n（确定性输出便于测试全串比对）。
function buildMessagesCsv (rows) {
  const lines = [EXPORT_CSV_HEADER.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push([r.id, r.time, r.cate, r.title, r.excerpt].map(csvCell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

function parseAction (body) {
  // application/x-www-form-urlencoded 或裸 action=xxx
  const m = /(?:^|&)action=([^&]*)/.exec(body)
  if (!m) return null
  let v = m[1]
  try { v = decodeURIComponent(v.replace(/\+/g, ' ')) } catch (e) { return null }
  return Object.prototype.hasOwnProperty.call(ACTIONS, v) ? v : null
}

// ── v3.298 只读扩展：配置视图 / 缓存健康 / 文件清单 ──────────────────────────
// 三者均无用户输入（无 query 参数或白名单参数），零写盘、零 spawn，纯元数据展示。
// 暴露面论证：所有信息都在同一 token 鉴权之后；文件清单只给名字/大小/mtime（不含内容、
// 不含路径前缀），敏感度严格低于既有 /api/logs（整份 run.log 正文）。

// 元数据安全探针：逐行镜像 readSafeTextResult 的入口防御（xbk_storage.js 同一 flags 组合
// O_RDONLY|O_NOFOLLOW）——符号链接 ELOOP 判 unsafe、非普通文件判 unsafe，绝不跟随。
// 额外带 O_NONBLOCK：裸 O_RDONLY 打开 FIFO 会阻塞等写者（一条恶意替换的命名管道就能
// 挂死读取端点），非阻塞下 open 立即返回、fstat.isFile() 照样把 FIFO 判 unsafe（对普通
// 文件 O_NONBLOCK 无语义影响）。
// 只 stat 不读内容（无读窗口 ⇒ 无 TOCTOU 承重面；观测快照允许毫秒级陈旧）。
function statSafeMeta (p) {
  let fd
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return { status: 'unsafe', size: null, mtimeMs: null }
    return { status: 'ok', size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', size: null, mtimeMs: null }
    if (e && e.code === 'ELOOP') return { status: 'unsafe', size: null, mtimeMs: null }
    return { status: 'ioError', size: null, mtimeMs: null }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch (e) { /* 忽略 */ } }
  }
}

// 墓碑键计数：形状 {v:1, id:[...], urlOnly:[...], idWithUrl:[...], anon:[...]}（MessageStore
// 四类身份键）。只回计数、绝不回显键内容（键是 id/url，敏感度低于已下发的 /api/messages 全文）。
// 与 MessageStore._loadTombstones 同口径：只计非空字符串键、按 Set 去重（原始数组长度会把
// 重复键/非法条目一起计入，虚报活跃墓碑数）。
// 安全序：先用 statSafeMeta（O_NONBLOCK，FIFO 立即返回）做闸——unsafe 一律不读。readSafeTextResult
// 的裸 O_RDONLY 打开 FIFO 会阻塞等写者（同步挂死 HTTP 事件循环），绝不能对未过闸的路径调用。
// 元数据（bytes）取自读到的内容本身（Buffer.byteLength），不做「stat 一次 + 读一次」的两段式
// ——原子替换发生在两段之间时会把旧文件的大小配新文件的计数（跨代拼接的假快照）。
// 残余边界（登记）：meta 过闸后、read 开打前纳米级窗口内被换成 FIFO 仍会阻塞——该原语
// （readSafeTextResult）被全部读取端点共用，在其内部加 O_NONBLOCK 属跨切面改动（影响 F1
// 恢复链与既有变异基线），不在本 PR 范围；观测面已被 meta 闸收窄到「替换竞态」。
function tombstoneCounts (stateDir, messagesFile) {
  const p = path.join(stateDir, `${messagesFile}.seen.json`)
  const counts = { id: 0, urlOnly: 0, idWithUrl: 0, anon: 0, total: 0 }
  const meta = statSafeMeta(p)
  if (meta.status === 'unsafe' || meta.status === 'ioError') {
    return { status: meta.status, bytes: null, counts }
  }
  // FIFO TOCTOU（Sourcery High）：meta 闸与读之间路径可被换成 FIFO——readSafeTextResult
  // 开 openNonBlocking，open 立即返回（普通文件不变，FIFO→unsafe），绝不阻塞等写者。
  const read = readSafeTextResult(p, TOMBSTONE_MAX_BYTES, { openNonBlocking: true })
  if (read.status !== 'ok') return { status: read.status, bytes: null, counts }
  const bytes = Buffer.byteLength(String(read.text || ''), 'utf8')
  try {
    const parsed = JSON.parse(read.text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of ['id', 'urlOnly', 'idWithUrl', 'anon']) {
        const arr = parsed[k]
        if (Array.isArray(arr)) {
          const uniq = new Set()
          for (const key of arr) if (typeof key === 'string' && key !== '') uniq.add(key)
          counts[k] = uniq.size
          counts.total += uniq.size
        }
      }
    } else {
      return { status: 'invalid', bytes, counts }
    }
  } catch (e) {
    return { status: 'invalid', bytes, counts }
  }
  return { status: 'ok', bytes, counts }
}

// 缓存健康快照（GET /api/cache-health）：push.json 字节占用对照两级上限（生产写端 64MiB /
// 控制台读端 32MiB），nearTrim/overLimit/consoleReadable 三位预警 + 墓碑计数。
// 条数不在此读（数条数要 32MiB 整读，与轮询不兼容）——前端用 /api/messages 的 grandTotal
// 对照 limits.entryMax 自行预警。
function cacheHealthSnapshot (stateDir, messagesFile, limits) {
  const lim = limits || defaultHealthLimits()
  const meta = statSafeMeta(path.join(stateDir, messagesFile))
  const tomb = tombstoneCounts(stateDir, messagesFile)
  const bytes = meta.status === 'ok' ? meta.size : null
  const writeRatio = bytes !== null && lim.writeMaxBytes > 0
    ? Math.round((bytes / lim.writeMaxBytes) * 10000) / 10000
    : null
  return {
    status: meta.status,
    file: messagesFile,
    bytes,
    mtimeMs: meta.status === 'ok' ? meta.mtimeMs : null,
    limits: lim,
    writeRatio,
    nearTrim: writeRatio !== null && writeRatio >= CACHE_HEALTH_NEAR_RATIO && writeRatio <= 1,
    overLimit: bytes !== null && bytes > lim.writeMaxBytes,
    consoleReadable: bytes !== null && bytes <= lim.consoleReadMaxBytes,
    tombstone: { status: tomb.status, bytes: tomb.bytes, counts: tomb.counts }
  }
}

// 状态目录文件清单（GET /api/files）：readdir + lstat（Dirent 天然不跟随末级符号链接——
// O_NOFOLLOW 的元数据等价物）。普通文件的元数据同样用 lstat（statSync 会跟随「readdir 与
// stat 之间被替换成符号链接」的竞态，泄露目标元数据；lstat + isFile() 双重判定把该窗口
// 收窄为「条目按 symlink 展示」）。lstat 竞态消失（ENOENT/EACCES）→ 跳过该条：best-effort
// 快照。
function listStateFiles (stateDir, messagesFile) {
  let dirents
  try {
    dirents = fs.readdirSync(stateDir, { withFileTypes: true })
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', total: 0, truncated: false, files: [] }
    return { status: 'ioError', total: 0, truncated: false, files: [] }
  }
  // 提前截断（Sourcery Medium：异常堆积目录逐条 lstat+存储+排序无界）：readdir 是单次
  // 系统调用本身有界，O(n) 同步工作量在逐条 lstat——只对前 FILES_LIST_MAX 个条目做
  // lstat/建对象/排序，其余仅计数。total 仍报目录真实条目数；保留哪一千个按 readdir 序，
  // 纯展示面不承诺「保留哪个」——truncated:true 已如实标注。
  const truncated = dirents.length > FILES_LIST_MAX
  const keptDirents = truncated ? dirents.slice(0, FILES_LIST_MAX) : dirents
  const all = []
  for (const d of keptDirents) {
    if (!d.isFile()) {
      // symlink/dir/other：只报类型不给大小（不跟随、不泄露目标元数据）
      all.push({ name: d.name, kind: d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'other', bytes: null, mtimeMs: null, type: 'other' })
      continue
    }
    try {
      // lstat 不跟随：条目在 readdir 与 lstat 之间被换成符号链接时，isFile() 为 false
      // → 按 symlink 异常条目展示，绝不返回目标的 size/mtime。
      const st = fs.lstatSync(path.join(stateDir, d.name), { throwIfNoEntry: false })
      if (!st) continue
      if (!st.isFile()) {
        all.push({ name: d.name, kind: st.isSymbolicLink() ? 'symlink' : 'other', bytes: null, mtimeMs: null, type: 'other' })
        continue
      }
      all.push({ name: d.name, kind: 'file', bytes: st.size, mtimeMs: Math.round(st.mtimeMs), type: classifyStateFile(d.name, messagesFile) })
    } catch (e) { /* 竞态消失：跳过 */ }
  }
  // （提前截断见循环前注释；此处 truncated 已在上方按 dirents.length 判定）。
  const kept = all
  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  // total = readdir 所见条目数（含未 lstat 的被截断条目与竞态消失条目）；files 才是明细。
  return { status: 'ok', total: dirents.length, truncated, files: kept }
}

// 文件用途分类（按序精确匹配/前后缀，无正则）。遵循 F4 教训：精确形状，不用子串包含——
// `xxx.seen.cleanup.lock.json` 是合法缓存文件，`endsWith('.lock')` 不会误吞它（含 .json 后缀）。
function classifyStateFile (name, messagesFile) {
  if (name === messagesFile) return 'cache'
  if (name === `${messagesFile}.seen.json`) return 'tombstone'
  // F4 教训：上游 pushUrl 末段恰为 `xxx.seen.cleanup.lock` 时，缓存名 = `xxx.seen.cleanup.lock.json`
  // ——这是**合法缓存文件**，绝不能因为名字含 .lock 被归进 lock（暗示异常）。
  if (name.endsWith('.seen.cleanup.lock.json')) return 'cache'
  if (name === 'console-lastaccept.json') return 'console'
  if (name === 'console-trigger.lock' || name === '.seen.cleanup.lock' ||
    name.endsWith('.lock') || name.endsWith('.takeover') || name.endsWith('.reclaim')) return 'lock'
  if (name.endsWith('.bak')) return 'backup'
  if (name.endsWith('.tmp')) return 'temp'
  if (name === 'report.state' || name === 'channel-health.state' || name === 'alert.state' ||
    name === 'filter.hash' || name.startsWith('re2warn.state.')) return 'state'
  if (name === 'run.log' || name === 'filter-diagnostics.ndjson') return 'log'
  return 'other'
}

// 「已配置」布尔判定（配置视图专用）：值绝不进入响应对象，只允许布尔判定经过这里。
// boolean 原样返回（false 就是未启用）；字符串 trim 后非空才算（空白串=未配置）；
// 其余类型只否定 null/undefined（数字 0 视为「已设置」）。
function configuredFlag (v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.trim().length > 0
  return v != null
}

// 运行配置脱敏视图（GET /api/config）：**显式逐字段白名单**——禁止泛型拷贝
// （Object.keys/JSON.stringify(Config) 会让未来新增的密钥字段自动泄漏，白名单必须逐字段手写，
// 加字段时人工过一遍敏感面）。推送密钥值永不进响应：只经 sendNotify 已导出的
// configuredChannelCount/configuredChannelNames/hasWxPusherConfigured 做布尔/计数判定，
// 值不落任何中间对象。两个 require 都 try/catch 懒加载：加载失败 → loaded:false，
// 端点仍 200（与 sourceDomain 同款，缺 got 的残部署不 500）。
function buildConfigView () {
  let cfg = null
  let configLoaded = false
  try {
    const app = require('../xbk_function_v3')
    if (app && app.Config && typeof app.Config === 'object') { cfg = app.Config; configLoaded = true }
  } catch (e) { /* 残部署降级 */ }
  const pushUrl = configLoaded && cfg.api ? String(cfg.api.pushUrl) : ''
  const dirEffective = runtimeCacheDir()
  // 缓存目录生效值：优先运行侧解析结果，取不到回退原始配置值
  const dirConfigured = configLoaded && cfg.cache ? String(cfg.cache.dir) : ''
  const effDir = dirEffective || dirConfigured
  const view = {
    configLoaded,
    runtime: configLoaded
      ? {
          domain: String(cfg.domain),
          api: { pushUrl, timeout: cfg.api.timeout, retry: cfg.api.retry },
          push: { mode: String(cfg.push.mode), parallelLimit: cfg.push.parallelLimit, titleMax: cfg.push.titleMax, contentMax: cfg.push.contentMax, maxPerRun: cfg.push.maxPerRun },
          timing: { pushInterval: cfg.timing.pushInterval, finalWait: cfg.timing.finalWait },
          cache: { maxSize: cfg.cache.maxSize, dirConfigured, dirEffective: effDir },
          alert: { enabled: configuredFlag(cfg.alert.enabled), intervalMs: cfg.alert.intervalMs },
          report: { enabled: configuredFlag(cfg.report.enabled) },
          channelHealth: { enabled: configuredFlag(cfg.channelHealth.enabled), consecutiveFailures: cfg.channelHealth.consecutiveFailures, intervalMs: cfg.channelHealth.intervalMs },
          diagnostics: { filterLog: { enabled: configuredFlag(cfg.diagnostics.filterLog.enabled), maxDetailsPerRun: cfg.diagnostics.filterLog.maxDetailsPerRun, includePassed: configuredFlag(cfg.diagnostics.filterLog.includePassed) } },
          storage: { minFreeBytes: cfg.storage.minFreeBytes },
          template: { title: String(cfg.template.title), content: String(cfg.template.content) },
          // 过滤规则与关键词也是**显式字段清单**（不用 spread）——与顶层同一白名单纪律：
          // 未来有人往 Config.filter 加敏感字段时，spread 会把它自动带进响应。
          filter: {
            pingbifenlei: String(cfg.filter.pingbifenlei),
            pingbibiaoti: String(cfg.filter.pingbibiaoti),
            zhanxianbiaoti: String(cfg.filter.zhanxianbiaoti),
            pingbibiaotiplus: String(cfg.filter.pingbibiaotiplus),
            pingbineirong: String(cfg.filter.pingbineirong),
            zhanxianneirong: String(cfg.filter.zhanxianneirong),
            pingbineirongplus: String(cfg.filter.pingbineirongplus),
            pingbilouzhu: String(cfg.filter.pingbilouzhu),
            zhanxianlouzhu: String(cfg.filter.zhanxianlouzhu),
            pingbilouzhuplus: String(cfg.filter.pingbilouzhuplus),
            pingbitime: String(cfg.filter.pingbitime)
          },
          keyword: { zkt_gjc: String(cfg.keyword.zkt_gjc) }
        }
      : null,
    pushChannels: buildPushChannelsView(),
    console: {
      env: {
        // 只报「是否设置了」，值绝不入响应（XBK_INTERVAL_MS 等非密钥，但口径从严统一）
        intervalMs: configuredFlag(process.env.XBK_INTERVAL_MS),
        cacheDir: configuredFlag(process.env.XBK_CACHE_DIR),
        dryRun: configuredFlag(process.env.XBK_DRY_RUN)
      }
    }
  }
  return view
}

// 推送渠道配置状态：只经 sendNotify 已导出的布尔/计数接口（configuredChannelNames 的
// canonical 名与 perChannel 键一一对应），密钥值全程不离开 sendNotify 模块作用域。
function buildPushChannelsView () {
  const view = { moduleLoaded: false, count: 0, names: [], perChannel: {}, localFilePresent: false }
  try {
    const notify = require('../xbk_sendNotify_slim')
    view.moduleLoaded = true
    const names = notify.configuredChannelNames()
    view.count = typeof notify.configuredChannelCount() === 'number' ? notify.configuredChannelCount() : 0
    view.names = names
    view.perChannel = {
      pushplus: names.includes('pushplus'),
      serverchan: names.includes('server酱'),
      bark: names.includes('bark'),
      wecom: names.includes('企业微信'),
      wxpusher: names.includes('wxpusher'),
      xizhi: names.includes('息知'),
      pushdeer: names.includes('pushdeer'),
      pushme: names.includes('pushme'),
      telegram: names.includes('telegram')
    }
    // wxpusher 只报「已配置」布尔（应用条数内部接口未导出，不伸手进内部结构拿值）
    view.wxpusher = { configured: notify.hasWxPusherConfigured() === true }
  } catch (e) { /* 模块加载失败（如缺 got）：如实 moduleLoaded:false */ }
  // 只报「本地配置文件存在」（existsSync 语义）——sendNotify 对「文件存在但导出格式异常」
  // 会拒绝应用并告警，控制台无法从外部区分，绝不谎报「已加载」（值本身也绝不读取）。
  try {
    view.localFilePresent = fs.existsSync(path.join(__dirname, '..', 'push_config.local.js'))
  } catch (e) { /* existsSync 异常按不存在 */ }
  return view
}

function createConsole ({ token, stateDir, port = 0, host = '127.0.0.1', log = console.log, lockToken, messagesFile = 'push.json', runHistoryDir, sseMaxPending } = {}) {
  // Sourcery Missing-assets：资产文件缺失时服务照常启动 → 用户拿到可打开但永远白屏的
  // 控制台（JS 引入失败）。启动闸逐个校验白名单资产可读，缺任何一个 fail-closed 拒启。
  // 启动即做一次一致快照：既校验资产可读（缺失即拒启），也把版本号钉死在进程生命周期内
  // ——避免「首个请求时才读盘、恰好撞上部署替换」的混合版本窗口。
  try {
    loadAssets()
  } catch (e) {
    throw new Error(`控制台前端资产缺失或不可读（仓库不完整？）：${e.message}，拒绝启动（fail-closed）`)
  }
  if (!isValidToken(token)) {
    throw new Error(`XBK_CONSOLE_TOKEN 未设置、短于 ${TOKEN_MIN_LEN} 字符，或含浏览器无法传输的字符（仅允许可见 ASCII，禁 ; , " \\ 与空白），控制台拒绝启动（fail-closed）`)
  }
  fs.mkdirSync(stateDir, { recursive: true })
  // 活跃子进程登记（Sourcery High：控制台关闭时子进程要一并终止，否则触发任务
  // 会在控制服务消失后继续抓取/推送）。close 回调里自行从集合摘除。
  const activeChildren = new Set()
  // 锁归属 token：调用方传入（main 生成，SIGTERM 释放时须双匹配）；未传则随机。
  // 测试可直接传固定值断言锁内容。
  const ownerToken = typeof lockToken === 'string' && lockToken.length > 0 ? lockToken : crypto.randomBytes(12).toString('hex')
  // 关停闸（评审 High：SIGTERM 后 readBody 回调仍可能 acquireLock/startAction）：
  // 置位后 /trigger 一律 503，不认动作。由 main 的 shutdown 回调置位。
  let shuttingDown = false
  const setShuttingDown = () => { shuttingDown = true }
  // 幂等重放窗（Sourcery G_nm + G_4Kf）：受理时按 action 记录首轮
  // lastAccept[action] = { at, runId }。per-action 存储：换动作不会覆盖前一个动作的
  // 重放记录（「先 run 后重试 check 再重试 run」仍被拦）；进程内存语义 = 重启清空，
  // 重启后窗口失效是已知边界（锁与 runs 历史同样在内存，重启后本就没有「上一轮」）。
  // 窗口 > PROC_TIMEOUT_MS（子进程最长生命周期）：首轮结束后锁已释放，但重放
  // 窗仍拦截——这正是修复点。超窗不受影响，人工重跑语义保留。
  const REPLAY_WINDOW_MS = PROC_TIMEOUT_MS + 2 * 60 * 1000
  const lastAccept = new Map()
  // 进程启动时刻（/api/sys 展示「已运行」用）：createConsole 被调用的瞬间。
  const startedAtMs = Date.now()
  // 读取持久化重放记录：返回合法条目的键值对数组（文件不存在/损坏返回空）。
  // 每次受理前实时调用（Sourcery High：多进程共享 stateDir 时，启动时读的快照会过期）。
  const readLastAccept = (p) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      const out = []
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          // runId 形态（v3.299 评审）：数字 0 = pending 帧哨兵；字符串「epoch.seq」= 已 spawn。
          const ridOk = v && typeof v.at === 'number' &&
            (v.runId === 0 || (typeof v.runId === 'string' && /^\d{13,}\.\d{1,10}$/.test(v.runId)))
          if (ridOk) out.push([k, { at: v.at, runId: v.runId }])
        }
      }
      return out
    } catch (e) { return [] }
  }
  // ── v3.300 访问日志（内存环形，蓝图 §3.3）：闭包态，access-log 端点与 finish 钩子共用。
  const accessLog = []
  let unauthorizedCount = 0
  // Sourcery Retries-duplicate x2：lastAccept 只在内存，重启后窗口失效 → 重试穿透再跑一轮。
  // 落盘到 stateDir/console-lastaccept.json（readStatus 同目录），受理时同步写、启动时回读。
  // 写入失败不阻断受理（主链路是单飞锁，落盘只是重放窗的持久化增强）。
  const lastAcceptPath = path.join(stateDir, 'console-lastaccept.json')
  try {
    for (const [k, v] of readLastAccept(lastAcceptPath)) lastAccept.set(k, v)
  } catch (e) { /* 文件不存在/损坏 = 空窗口，正常 */ }

  // ── SSE 连接管理（v3.300 3.1）────────────────────────────────────────────
  // 按实例隔离（createConsole 闭包内，非模块级）：测试会创建多个 console 实例，
  // 模块级 Set 会跨实例泄漏连接数（第 9 个 503 误伤）；runs/startAction 模块级是既有
  // 形态，不据此扩散。Set 不进 module.exports，经 createConsole 返回值暴露给测试。
  const sseConnections = new Set()
  // 每连接「应用层待发积压」上限：createConsole 可注入 sseMaxPending（测试注小值用），
  // 未注入/非法值回退默认。命名用 ssePendingLimit 避免与解构参数同名（同名 const 会
  // SyntaxError: Identifier has already been declared）。
  const ssePendingLimit = typeof sseMaxPending === 'number' && sseMaxPending > 0 ? sseMaxPending : SSE_MAX_PENDING

  // 幂等清理：clearInterval + 摘除登记 + res.end()。res 'close'/'error'/积压超限/关停
  // 广播/完结收尾全走这里（蓝图防线 5：close 必清理，防 Set 泄漏）。
  // 正常路径（done/对端关闭/关停广播）end 前先 flush pending——done 帧可能刚被
  // sseWriteFrame 排进队列（背压分支），不 flush 客户端就收不到终结事件（评审 231-M2）；
  // abort=true（积压超限）不 flush：待发积压本就超限，flush 只会继续喂慢客户端，
  // 直接 end + destroy——慢客户端硬断（蓝图「直接断开」），onerror → 整段重拉自愈。
  const sseTeardown = (conn, abort = false) => {
    if (conn.closed) return
    conn.closed = true
    clearInterval(conn.timer)
    sseConnections.delete(conn)
    if (!abort && conn.pending.length > 0) {
      try { conn.res.write(conn.pending) } catch (e) { /* 已断开，end 兜底 */ }
      conn.pending = ''
      conn.pendingBytes = 0
    }
    try { conn.res.end() } catch (e) { /* 已断开 */ }
    if (abort) { try { conn.res.socket && conn.res.socket.destroy() } catch (e) { /* 已断开 */ } }
  }

  // 帧写出唯一出口（背压闸）。Node 语义：res.write() 无论返回值都会把帧入队，
  // 返回 false 只表示「内部缓冲超高水位」——所以只在**已暂停**时入应用层待发队列，
  // 绝不把同一帧既 write 又记 pending（会重复）。
  const sseWriteFrame = (conn, frame) => {
    if (conn.closed) return
    if (conn.paused) {
      conn.pending += frame
      conn.pendingBytes += Buffer.byteLength(frame, 'utf8')
      if (conn.pendingBytes > ssePendingLimit) sseTeardown(conn, true) // 慢客户端硬断
      return
    }
    let ok = false
    try { ok = conn.res.write(frame) } catch (e) { sseTeardown(conn); return }
    if (!ok) conn.paused = true // 帧已入 Node 缓冲，仅暂停后续推送，等 drain
  }

  // drain 回调：待发串一次性交给 Node（无论返回值都已入队），按返回值决定是否保持暂停。
  const sseFlushPending = (conn) => {
    if (conn.closed || conn.pending.length === 0) return
    let ok = false
    try { ok = conn.res.write(conn.pending) } catch (e) { sseTeardown(conn); return }
    conn.pending = ''
    conn.pendingBytes = 0
    conn.paused = !ok
    if (ok) conn.lastPingAt = Date.now()
  }

  // 连接 tick（单一 500ms 定时器，unref；同时承担 15s 心跳——蓝图「心跳定时器 unref +
  // close 时 clearInterval」由本定时器与 sseTeardown 落实）。写循环复查 runs.get(id)
  // 感知淘汰与完结（蓝图口径：非事件驱动，对注入式测试友好——见 §2 D3）。
  // ⚠️ 背压期间的 tick 仍运行，但只把新帧写入 conn.pending（sseWriteFrame 暂停分支），
  // 不直接 write——积压超限断开的判据（SSE_MAX_PENDING）由此才能真实触发（蓝图口径
  // 「记待发，超限断开」：待发必须持续累积，而不是暂停期整帧丢弃）。
  const sseTick = (conn) => {
    if (conn.closed) return
    const record = runs.get(conn.id)
    if (!record) {
      // 20 条上限淘汰（startAction）或进程内丢失 → done + 关流。
      // 背压中未发的待发帧随连接丢弃：客户端 EventSource onerror → 整段重拉自愈（§2 D3）。
      sseWriteFrame(conn, 'event: done\ndata: {}\n\n')
      sseTeardown(conn)
      return
    }
    const plan = ssePlanChunk(conn.cursor, record.output, record.outputTotalLength)
    if (plan) {
      // 帧格式：data 单行（JSON.stringify 转义换行/引号，多字节经转义无损传输）；
      // named event reset/done 前端必须 addEventListener（onmessage 不收 named——蓝图红线）。
      const frame = plan.reset
        ? `event: reset\ndata: ${JSON.stringify({ full: plan.text })}\n\n`
        : `data: ${JSON.stringify(plan.text)}\n\n`
      sseWriteFrame(conn, frame)
      conn.cursor = plan.cursor
    } else if (record.finishedAt && !conn.paused) {
      // 完结且增量发完 → done + res.end()（蓝图 done 条件②；①淘汰在上分支）。
      // !conn.paused 守卫（蕴含 pending 空）：背压未恢复前不发 done——否则帧入 pending
      // 后被 teardown 丢弃，客户端收 RST 而非 done。暂停中则下轮 tick（drain 后）再发。
      sseWriteFrame(conn, 'event: done\ndata: {}\n\n')
      sseTeardown(conn)
      return
    }
    if (Date.now() - conn.lastPingAt >= SSE_HEARTBEAT_MS) {
      sseWriteFrame(conn, ': ping\n\n')
      conn.lastPingAt = Date.now()
    }
  }

  // ── 批次④ 4.1：触发受理序列共享（/trigger 与 POST /api/notify-test）─────────
  // 序列：shuttingDown 入口查 → readBody（统一 aborted 400 / over 413 / 关停竞态兜底）
  //   → 实时读盘合并 lastAccept → 重放窗（notify-test 独立 60s，其余 12min）→ 单飞锁
  //   → pending 帧 → 同步落盘（失败 fail-closed 500 + 释放锁 + 回滚）→ startAction
  //   → 补写真实 runId → 再落盘 → 202。
  // fixedAction 传值时跳过 body 解析（动作已在端点定死，body 仅排水丢弃）；否则 parseAction。
  function acceptAction (req, res, { fixedAction = null } = {}) {
    if (shuttingDown) {
      sendJson(res, 503, { error: '控制台正在关闭，动作未执行' })
      return
    }
    // S9383：promise 必须显式收尾——readBody 以 resolve 收口不会 reject，但仍接 .catch
    // 把意外异常转成 500，不留 floating promise。
    readBody(req)
      .then(({ body, aborted, over }) => {
        // 关停竞态兜底：readBody 期间收到 SIGTERM 时，此刻不能再 acquireLock/startAction
        // （评审 High：关停已清完 activeChildren，新 spawn 会逃过清理并留锁）。
        if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
        // Sourcery Medium：请求中断（error 后 resolve）时 body 可能已含 action=run，
        // 客户端却已放弃——绝不能凭残缺请求启动真实推送；超限同理拒绝。
        if (aborted) { sendJson(res, 400, { error: '请求中断，动作未执行' }); return }
        if (over) { sendJson(res, 413, { error: '请求体超限' }); return }
        const action = fixedAction || parseAction(body)
        if (!action) {
          sendJson(res, 400, { error: '未知 action' })
          return
        }
        const now = Date.now()
        // 幂等重放窗（Sourcery G_nm + G_4Kf）：提交 202 后响应丢失 → 用户重试 →
        // 首轮已结束释放锁 → 重试被当作新触发再跑一轮真实推送。per-action 记录：
        // 同 action 在窗口内的重复提交返回 409 + 首轮 run id（前端把它当「已在跑」
        // 呈现，不再发起新一轮）；换动作不覆盖他动作的记录。
        // Sourcery High Retries-duplicate x2（多进程 stale map / 落盘晚于 spawn）：
        // 受理顺序为「acquireLock → 持锁后实时读盘合并 → 判窗 → 记 pending 帧 → 同步落盘
        // （失败即拒绝）→ startAction → 补写真实 runId → 再落盘」。读盘-判窗-落盘全程
        // 持锁（Sourcery Medium：先读后锁存在 stale map 窗口——另一进程在此间落盘的话
        // 本进程会用陈旧记录放行重复动作），pending 帧（runId=0）本身就能拦截窗口内重试；
        // spawn 前记录已持久化，进程在 spawn 后崩溃也有完整重放记录。
        // 例外：锁被其他动作占着时（acquireLock 失败）先做一次锁外只读判窗——窗口内重试
        // 即使撞上他动作运行中也按「重放拦截」回（带首轮 runId），不降级成裸锁冲突
        // （G_4Kf 用例语义；竞态由锁内二次判窗兜底，锁外这层只是报错形态优化）。
        const winMsPre = action === 'notify-test' ? REPLAY_WINDOW_NOTIFY_TEST_MS : REPLAY_WINDOW_MS
        if (!acquireLock(stateDir, now, ownerToken)) {
          // readLastAccept 返回 [key, value] 数组（非 Map），用 find 取当前动作记录。
          const persistedPre = readLastAccept(lastAcceptPath)
          const prevPrePair = persistedPre.find(([k]) => k === action)
          const prevPre = prevPrePair ? prevPrePair[1] : lastAccept.get(action)
          if (prevPre && now - prevPre.at < winMsPre) {
            const rid = prevPre.runId
            sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试', runId: (typeof rid === 'string' && rid.includes('.')) ? rid : undefined, replayBlocked: true })
            return
          }
          sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试' })
          return
        }
        const persisted = readLastAccept(lastAcceptPath)
        for (const [k, v] of persisted) {
          if (!lastAccept.has(k) || lastAccept.get(k).at < v.at) lastAccept.set(k, v)
        }
        const prev = lastAccept.get(action)
        // 60s 独立窗：notify-test 用短窗（高频调试动作防连点刷通知），其余动作维持 12min。
        // /trigger 的 action=notify-test 与独立端点共享同一 lastAccept 键与窗长（有意行为）。
        const winMs = action === 'notify-test' ? REPLAY_WINDOW_NOTIFY_TEST_MS : REPLAY_WINDOW_MS
        if (prev && now - prev.at < winMs) {
          // runId = epoch.seq 字符串（v3.299 评审）：0 是 pending 帧哨兵（数字），
          // 真实 runId 只在 startAction 之后落盘——用「数字 0」判 pending，其余原样下发。
          const rid = prev.runId
          releaseLockFor({ _stateDir: stateDir, _lockToken: ownerToken })
          sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试', runId: (typeof rid === 'string' && rid.includes('.')) ? rid : undefined, replayBlocked: true })
          return
        }
        lastAccept.set(action, { at: now, runId: 0 })
        try {
          fs.writeFileSync(lastAcceptPath, JSON.stringify(Object.fromEntries(lastAccept)))
        } catch (e) {
          // 落盘失败 = 无持久重放记录，为满足「重试不得重复推送」必须拒绝受理（Sourcery High）。
          // 此时锁刚拿到、子进程未启动（activeChildren 无登记，close 回调无从释放）——
          // 必须显式释放（Sourcery #225 M3/M4：releaseLockFor 返回 false = 文件系统
          // 同样写不进锁 → 响亮告警给运维排查线索；恢复 pending 前值，失败动作可在
          // 窗口内重试，不再被 409 拦到窗口过期）。
          const releasedOk = releaseLockFor({ _stateDir: stateDir, _lockToken: ownerToken })
          if (!releasedOk) console.error(`⚠️ 触发锁释放失败（stateDir=${stateDir}）：磁盘/权限异常仍未恢复，锁将保留到陈旧接管（约 10 分钟）。后续触发 409 属预期。`)
          lastAccept.delete(action)
          sendJson(res, 500, { error: '重放记录持久化失败，动作未执行（fail-closed）' })
          return
        }
        let record
        try {
          record = startAction(action, now, activeChildren, stateDir)
        } catch (e) {
          // startAction 同步抛（spawn 资源极端，Sourcery Medium）：回滚重放帧与锁，
          // 让用户可重试，而不是被卡到陈旧接管。恢复 pending 前值语义同落盘失败分支。
          lastAccept.delete(action)
          const releasedOk = releaseLockFor({ _stateDir: stateDir, _lockToken: ownerToken })
          if (!releasedOk) console.error(`⚠️ 触发锁释放失败（stateDir=${stateDir}）：锁将保留到陈旧接管（约 10 分钟）。`)
          console.error(`⚠️ ${action} 启动失败（spawn）：${e && e.message ? e.message : e}`)
          sendJson(res, 500, { error: '动作启动失败，已回滚，可稍后重试' })
          return
        }
        record._stateDir = stateDir
        record._lockAt = now
        record._lockToken = ownerToken
        lastAccept.set(action, { at: now, runId: record.id })
        try {
          fs.writeFileSync(lastAcceptPath, JSON.stringify(Object.fromEntries(lastAccept)))
        } catch (e) { /* 二次落盘失败：pending 帧已持久化（runId=0），重试仍被窗口拦截 */ }
        sendJson(res, 202, { id: record.id, action, label: record.label })
      })
      .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
  }

  const server = http.createServer((req, res) => {
    // ── v3.300 访问日志装配：单点 res.on('finish')，覆盖 sendJson/静态/页面全部响应出口
    // （全文件原本无任何 res.on 监听）。挂回调第一行 ⇒ 畸形 request-target 的 400
    // （下方 sendJson(…,400) 也在覆盖内；malformed 是最值得记录的可疑流量，D3 定夺）。
    // 闭包引用下方 let url：finish 异步触发时回调体已同步执行完，TDZ 已解除。
    // - ms = finish 时刻 − 回调入口时刻；SSE（3.1 落地后）为整段连接时长，如实记录零特判（D5）。
    // - finish vs close：客户端中途断连、响应未 end 的请求无 finish → 不入日志
    //  （记录口径 =「完成的响应」，蓝图 R3 接受）。
    // - 脱敏在入数组之前（蓝图防线 1）：数组本身干净，非展示时过滤。
    // - src 只存字符串，不存 socket 引用（蓝图防线 4）；每个 res 一个监听器、res 随请求 GC。
    const reqStart = Date.now()
    const reqSrc = String((req.socket && req.socket.remoteAddress) || '')
    res.on('finish', () => {
      try {
        const status = res.statusCode
        if (status === 401) unauthorizedCount++ // 环形外的独立计数器（蓝图：401 全记且单独计数）
        if (url ? shouldLogAccess(req.method, url.pathname, status) : true) {
          accessLog.push({
            at: accessStamp(),
            method: String(req.method || ''),
            path: sanitizeAccessPath(String(req.url || '')),
            status,
            ms: Date.now() - reqStart,
            src: reqSrc
          })
          if (accessLog.length > ACCESS_LOG_MAX) accessLog.shift() // 丢最旧（D1）
        }
      } catch (e) { /* 装配失败静默：观测面绝不反噬主链路（finish 监听器抛错会炸进程） */ }
    })
    // 畸形请求行防御：req.url 是原始请求行目标（客户端可发任意垃圾，如 `//@:99999/`），
    // new URL 对非法形态抛 TypeError——此处位于鉴权之前，一条无凭证请求即可崩掉整个
    // 控制台进程（触发锁残留到陈旧接管、看板下线）。解析失败一律 400 拒绝。
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch (e) {
      sendJson(res, 400, { error: 'malformed request target' })
      return
    }
    // 静态资产路由（Sourcery G_oJ：资产也须鉴权——此前免鉴权的理由（ESM import 无法带头）
    // 已被 Cookie 方案解决：页面通过鉴权后下发 HttpOnly 会话 Cookie，浏览器对同源
    // ESM import/静态请求自动带 Cookie。无凭证请求一律 401，与文档口径一致。
    // 白名单精确匹配（STATIC_ASSETS）保留：无路径穿越面。
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_ASSETS, url.pathname)) {
      if (!authorize(req, token, url.searchParams)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      serveStatic(req, res, url.pathname, STATIC_ASSETS[url.pathname])
      return
    }
    if (!authorize(req, token, url.searchParams)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/') {
      // Sourcery referrer x2：?token= 打开的页面在发起同源子请求时默认把完整 URL
      // （含 query 里的 token）作为 Referer 发出，反向代理/访问日志可能落盘。no-referrer
      // 从根上掐断（该页所有子请求一律不带 Referer）；启动页本身在浏览器地址栏的历史
      // 记录仍含 token，这是 raw-URL 方案的已知暴露面（README 已提醒可重置）。
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Content-Security-Policy', CSP_HEADER)
      // HTML 里含本次会话凭证（boot JSON 的 token），绝不能被浏览器缓存：无 Cache-Control
      // 时浏览器启发式缓存会留下旧页面（旧 boot token 为空/过期）——页面照常渲染、GET 靠
      // Cookie 正常，但点按钮 POST 报 unauthorized（真实故障：2026-10-17 通知自检 401）。
      // no-store 同时禁掉 bfcache 与磁盘缓存，保证每次打开都拿到当前凭证。
      res.setHeader('Cache-Control', 'no-store')
      const state = readStatus(stateDir)
      const runsList = [...runs.values()].sort((a, b) => b.id - a.id)
      // 鉴权通过后下发会话 Cookie（Sourcery G_oJ）：HttpOnly（JS 不可读，XSS 拿不走）、
      // SameSite=Strict（跨站请求不携带）、Path=/；token 本身就是会话凭证，无需另发随机值。
      // Max-Age 30 天：自用工具，过期后重新打开 ?token= 链接即续期。
      // Sourcery 3x High（Cookie 无 Secure）：本服务部署在明文 HTTP 上（无 TLS 终结点），
      // Secure 属性会让浏览器拒绝在 http:// 上发送/存储 Cookie，控制台直接不可用——
      // 这是部署形态的固有权衡，不是代码缺陷可修；上 HTTPS（反代/自签）后应第一时间
      // 补 Secure + __Host- 前缀。缓解：HttpOnly（XSS 拿不走）+ SameSite=Strict（跨站不带）
      // + Max-Age 从 30 天收窄到 1 天（凭证下线窗口 30d → 1d）+ Referrer-Policy（见下）。
      res.setHeader('Set-Cookie',
        `xbk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // Sourcery Session-users-cannot-trigger x2：用户经 Cookie 会话（无 ?token=）打开页面时，
      // boot JSON 的 token 为空 → 前端发空 Bearer → POST /trigger 401。把本次请求实际
      // 使用的凭证（authorize 已通过的 token 值）交给 renderPage 注入 boot，会话用户
      // 无需再拼 ?token= 即可触发。
      res.end(renderPage(state, runsList, url.searchParams, token))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      // Sourcery Other-instance-idle：runs 历史是进程内存，另一实例持锁时本进程看不到。
      // 锁文件在共享 stateDir——把「锁被持有且未超时」附进 status，前端空闲徽章参考。
      const st = readStatus(stateDir)
      try {
        const lp = lockPath(stateDir)
        // CodeQL js/file-system-race（High）：statSync 后再 readFileSync 存在 TOCTOU——
        // 两次调用之间锁可能被释放/接管，stat 的 mtime 与 read 的内容来自不同代的锁帧。
        // 单次 readFileSync，时间与状态全部取自同一帧内容（锁帧/released 帧都写 startedAt）。
        let lockAge = 0
        let released = false
        try {
          const lockBody = JSON.parse(fs.readFileSync(lp, 'utf8'))
          const startedAt = typeof lockBody.startedAt === 'number' ? lockBody.startedAt : 0
          lockAge = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : PROC_TIMEOUT_MS
          released = lockBody.released === true
        } catch (e2) { st.lock = { held: false, ageMs: 0 }; throw e2 }
        st.lock = { held: !released && lockAge < PROC_TIMEOUT_MS, ageMs: lockAge }
      } catch (e) {
        if (!st.lock) st.lock = { held: false, ageMs: 0 }
      }
      sendJson(res, 200, st)
      return
    }
    // GET /api/access-log（v3.300 §3.3）：系统页可查的内存环形访问日志。
    // 鉴权与其余读取端点一致（上方 authorize 闸已过）。时间正序 = 数组插入序
    // （push 尾=最新）；slice() 浅拷贝防外部持有内部引用改写（条目对象 push 后
    // 只读不变，浅拷贝足够——蓝图防线 3「数组本身必须干净」）。unauthorizedCount
    // 是进程启动以来全部 401 的独立计数（可大于环形窗内条数，不环形截断）。
    if (req.method === 'GET' && url.pathname === '/api/access-log') {
      sendJson(res, 200, { items: accessLog.slice(), unauthorizedCount })
      return
    }
    // ── v3.297 控制台扩展：推送记录 / 趋势 / 日志 / 系统 ─────────────────────────
    // 全部只读（读缓存目录已有文件 + 进程自身信息），不 spawn、不写任何文件；
    // 鉴权与其余读取端点一致（Bearer / ?token= / Cookie 会话）。
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const read = readMessages(stateDir, { maxBytes: MESSAGES_MAX_BYTES, filename: messagesFile })
      if (read.status !== 'ok') {
        // missing = 缓存还没建（首轮未跑）；invalid/tooLarge = 数据坏了/过大——
        // 三态如实下发，前端按 partTone 同口径显示，不伪装成「暂无记录」。
        // cacheDirHint：本页读 stateDir + messagesCacheName()（与 /api/status、run.log 同源目录，
        // XBK_CACHE_DIR 可改）；运行侧 Config.cache.dir / pushUrl 指到别处时缓存不在这里——
        // 把目录与文件名口径都告诉运维（Sourcery PR#227「Custom cache records stay hidden」）。
        sendJson(res, 200, {
          status: read.status,
          total: 0,
          page: 1,
          pageSize: 0,
          items: [],
          categories: [],
          cacheDirHint: stateDir,
          cacheFileHint: messagesFile
        })
        return
      }
      const q = url.searchParams
      // 分页参数钳制（URL 是未验证输入）：非法值回退默认，不 400——自用工具宽容输入，
      // 但永远不会越界（page*size 超大切片会复制数组，钳制后上限 100 * 10001 条仍有界）。
      let size = Number(q.get('size'))
      if (!Number.isSafeInteger(size) || size < 1) size = 20
      if (size > MESSAGES_PAGE_SIZE_MAX) size = MESSAGES_PAGE_SIZE_MAX
      let page = Number(q.get('page'))
      if (!Number.isSafeInteger(page) || page < 1) page = 1
      if (page > MESSAGES_PAGE_MAX) page = MESSAGES_PAGE_MAX
      // 过滤：分类精确匹配 + 关键词子串（title / content，大小写不敏感的 ASCII 归一）。
      // 用 includes 而非正则（用户输入直接进正则有 ReDoS 面，本仓正则防护红线）。
      const cate = typeof q.get('cate') === 'string' ? q.get('cate') : ''
      // 超长 query 按 UTF-8 字节截断（而非清空）：清空会让前端仍显示原词、结果却未过滤，
      // 造成「搜了等于没搜」的假象（审查 Sourcery PR#227）。截断后用截断值过滤并回显 queryUsed。
      // （中文按字符截到字节边界：从尾部丢弃不完整多字节序列。）
      let query = typeof q.get('q') === 'string' ? q.get('q').trim() : ''
      query = clampQueryBytes(query)
      const needle = query.length > 0 ? query.toLowerCase() : ''
      const items = filterMessageItems(read.value.items, cate, needle)
      // 下发字段裁剪：content_html 不出（体积大且含外链 img，CSP 下也渲染不了）；
      // 列表给 title/content 摘要 + 元数据；详情字段由前端展开 content 全文。
      const total = items.length
      const start = (page - 1) * size
      // rowKey：无 id 条目用数组下标合成（与 readMessages 的排序后位置一致——排序稳定，
      // slice 后下标 = 原数组下标）。前端行键/展开用它，匿名条目不再联动。
      const pageItems = items.slice(start, start + size).map((m, i) => ({
        id: typeof m.id === 'number' || typeof m.id === 'string' ? m.id : '',
        // rowKey：readMessages 按「原始数组下标」合成的稳定行键（与 keys 数组对齐取）。
        // 排序/分页不改变键；无 id 的匿名条目也不再共用 '' 导致展开联动。
        rowKey: read.value.keys[start + i] !== undefined
          ? read.value.keys[start + i]
          : String(m.id !== undefined && m.id !== null ? m.id : `idx-${start + i}`),
        title: typeof m.title === 'string' ? m.title : '',
        // content 全文下发（前端列表自行截断显示）：列表只有 ≤100 条，截到 500 反而让
        // 「展开正文」读不到全文（审查 Sourcery PR#227）。
        content: typeof m.content === 'string' ? m.content : '',
        datetime: typeof m.datetime === 'string' ? m.datetime : '',
        shorttime: typeof m.shorttime === 'string' ? m.shorttime : '',
        shijianchuo: typeof m.shijianchuo === 'number' ? m.shijianchuo : null,
        cateid: typeof m.cateid === 'string' || typeof m.cateid === 'number' ? String(m.cateid) : '',
        catename: typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)',
        price: typeof m.price === 'number' ? m.price : null,
        url: typeof m.url === 'string' ? m.url : ''
      }))
      sendJson(res, 200, {
        status: 'ok',
        total,
        page,
        pageSize: size,
        pages: Math.max(1, Math.ceil(total / size)),
        grandTotal: read.value.total,
        skipped: read.value.skipped,
        // queryUsed：超限截断后实际生效的搜索词（前端据此回显，避免「显示原词、结果未过滤」）
        queryUsed: query,
        // baseUrl：相对 url 的拼接前缀（= 生产 Config.domain，去尾斜杠），前端不再硬编码
        baseUrl: sourceDomain(),
        categories: read.value.categories,
        items: pageItems
      })
      return
    }
    // POST /api/messages/export（v3.300 批次③ 3.2）：推送记录导出下载。body:
    // format=csv|json&cate=&q=（URLSearchParams；与 /api/runs/detail 同款 POST+body 形态
    // ——fetch 字面量红线 + 筛选词不落访问日志 URL）。page/size 参数按蓝图签名容忍存在但
    // 刻意不读取：导出=筛选结果全量（展示分页是另一口径，蓝图明说「不走 page-size 钳制」；
    // 若按起点偏移切片，「截断到 5000」的 X-Export-Truncated 判据将失去唯一参照）。
    // 无 shuttingDown 闸（定夺见规划 §2.1）：与 /api/runs/detail 同为纯读 POST，detail 无此闸。
    if (req.method === 'POST' && url.pathname === '/api/messages/export') {
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          const params = new URLSearchParams(body)
          const format = params.get('format')
          if (!EXPORT_FORMATS.includes(format)) { sendJson(res, 400, { error: 'format 必须是 csv 或 json' }); return }
          const cate = typeof params.get('cate') === 'string' ? params.get('cate') : ''
          const query = clampQueryBytes(typeof params.get('q') === 'string' ? params.get('q').trim() : '')
          const needle = query.length > 0 ? query.toLowerCase() : ''
          const read = readMessages(stateDir, { maxBytes: MESSAGES_MAX_BYTES, filename: messagesFile })
          if (read.status !== 'ok') {
            // missing/invalid/tooLarge 三态如实下发（与 /api/messages 同形态同哲学）：
            // 不伪装成空 CSV/空 JSON 让用户导出「成功却没数据」的文件；前端按 Content-Type 识别
            // 后展示提示而非下载。
            sendJson(res, 200, { status: read.status, total: 0, items: [], cacheDirHint: stateDir, cacheFileHint: messagesFile })
            return
          }
          const filtered = filterMessageItems(read.value.items, cate, needle)
          const truncated = filtered.length > EXPORT_MAX_ROWS
          const rows = (truncated ? filtered.slice(0, EXPORT_MAX_ROWS) : filtered).map(exportRowOf)
          if (format === 'json') {
            // 仅截断时下发该头；未截断不下发（缺席=完整，测试断言 undefined）。
            if (truncated) res.setHeader('X-Export-Truncated', 'true')
            // 成功导出=直接数组（文档口径「JSON 形态直出数组」，评审 231-M1）：消费方
            // JSON.parse 即得行数组，无需剥 items。截断信息走 X-Export-Truncated 头，
            // 不进响应体（形态纯度优先；三态响应才是 {status,...} 对象，前端按
            // Array.isArray 区分成功/三态——评审 231-H1）。
            const body = JSON.stringify(rows)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="messages-export.json"' })
            res.end(body)
            return
          }
          const head = {
            'Content-Type': 'text/csv; charset=utf-8',
            // 文件名硬编码字面量：查询词可能含 token 形态字符串，绝不回显进头（蓝图防线）。
            'Content-Disposition': 'attachment; filename="messages-export.csv"'
          }
          if (truncated) head['X-Export-Truncated'] = 'true'
          // BOM EF BB BF：Excel 无 BOM 按本地代码页解析会乱码中文（蓝图硬性要求）。
          res.writeHead(200, head)
          res.end(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(buildMessagesCsv(rows), 'utf8')]))
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/trends') {
      // 近 N 日运行趋势：run.log 摘要行按日聚合（scripts/status.js readTrends，与 parseLastRun
      // 同一正则口径）。days 走白名单（14/30/60），非法/缺省/越界一律回默认 14——向后兼容；
      // readTrends 对 days 无内部钳制，这里的白名单是唯一防线。
      const rawDays = Number(url.searchParams.get('days'))
      const days = TREND_DAYS_ALLOWED.includes(rawDays) ? rawDays : TREND_DAYS_DEFAULT
      const t = readTrends(stateDir, { days })
      if (t.status !== 'ok') {
        sendJson(res, 200, { status: t.status, byDay: [], days })
        return
      }
      sendJson(res, 200, {
        status: 'ok',
        days: t.value.days,
        byDay: t.value.byDay,
        // today：Asia/Shanghai 日历日（run.log 时间戳口径），前端「今天」高亮用它；
        // truncated：run.log 超限只统计了尾部（前端副标题如实注明）
        today: t.value.today,
        truncated: t.value.truncated === true
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/run-history') {
      // 逐轮运行历史（v3.299 批次②）：直接解析 run.log 摘要行（零新文件零写盘——
      // run.log 是仓内既定的持久逐轮记录，CHANGELOG v3.289 口径）。limit/before 钳制：
      // URL 是未验证输入，Number + 整数 + 区间钳制，用户输入不进正则。
      let limit = Number(url.searchParams.get('limit'))
      if (!Number.isSafeInteger(limit) || limit < 1) limit = RUN_HISTORY_LIMIT_DEFAULT
      if (limit > RUN_HISTORY_LIMIT_MAX) limit = RUN_HISTORY_LIMIT_MAX
      let before = Number(url.searchParams.get('before'))
      if (!Number.isSafeInteger(before) || before < 0) before = 0
      // Sourcery #229-4：run.log 的写入方是运行侧 MessageStore.cacheDir（xbk_app
      // _writeRunLog → MessageStore.cacheDir），不是控制台 stateDir——Config.cache.dir
      // 指向别处时两个目录分居。读取源对齐运行侧解析结果（取不到回退 stateDir），
      // 与启动时「目录漂移」警告同一口径。
      const historyDir = runHistoryDir || (runtimeCacheDir() || stateDir)
      const h = readRunHistory(historyDir, { limit, before })
      sendJson(res, 200, h)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      // 运行日志在线查看：run.log 尾部 1MiB（与 status.js LOG_READ_OPTIONS.tail 同口径）。
      const { readSafeTextResult } = require('../xbk_storage')
      const safe = readSafeTextResult(path.join(stateDir, 'run.log'), LOG_VIEW_MAX_BYTES, { tail: true })
      if (safe.status === 'missing') {
        sendJson(res, 200, { status: 'missing', text: '' })
        return
      }
      if (safe.status !== 'ok') {
        sendJson(res, 200, { status: safe.status, text: '' })
        return
      }
      sendJson(res, 200, { status: 'ok', text: safe.text })
      return
    }
    // ── v3.298 只读扩展端点：缓存健康 / 文件清单 / 配置视图 ─────────────────────
    // 全部无副作用（不写盘、不 spawn），鉴权与既有读取端点同一全局闸。
    if (req.method === 'GET' && url.pathname === '/api/cache-health') {
      const snap = cacheHealthSnapshot(stateDir, messagesFile)
      // 条目数对照（Sourcery Medium「条目上限无预警」）：条数维度由 /api/status 同源数据
      // 提供——这里顺带读一次（readMessages 复用同一 32MiB 封顶，tooLarge 时 count:null，
      // 前端显示「—」不编数）。缓存健康是进页/手动刷新拉取，不在 5s 轮询里，读放大可控。
      const cnt = readMessageCount(stateDir, { filename: messagesFile })
      snap.entryCount = cnt.status === 'ok' ? cnt.count : null
      snap.entryCountStatus = cnt.status
      sendJson(res, 200, snap)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const list = listStateFiles(stateDir, messagesFile)
      sendJson(res, 200, list)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      // 脱敏在 buildConfigView 内逐字段白名单完成；这里只做最终保险丝：
      // 万一未来白名单意外混入凭证形态字段，响应前整体拦一道（fail-closed 降级为不含
      // runtime 的骨架）。检测纯字符串形态匹配（键名小写 includes，无正则、无用户输入）。
      const view = buildConfigView()
      const blob = JSON.stringify(view).toLowerCase()
      const SECRET_MARKERS = ['appToken', 'PUSH_PLUS_TOKEN', 'PUSH_KEY', 'BARK_PUSH', 'QYWX_KEY', 'WX_XIZHI_KEY', 'DEER_KEY', 'PUSHME_KEY', 'TG_BOT_TOKEN', 'TG_USER_ID']
      let leaked = false
      for (const marker of SECRET_MARKERS) {
        // 值泄漏形态 = 「"字段名":"非空值"」整段出现（perChannel 布尔不含引号值，不误伤）
        if (blob.includes(`"${marker.toLowerCase()}":"`)) { leaked = true; break }
      }
      if (leaked) {
        sendJson(res, 200, { configLoaded: false, runtime: null, pushChannels: { moduleLoaded: false, count: 0, names: [], perChannel: {}, localFileLoaded: false }, console: { env: {} }, redacted: true })
        return
      }
      sendJson(res, 200, view)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/sys') {
      // 系统信息：版本四方来源 package.json（与 check-version.js 的唯一真源一致）+
      // 进程/宿主只读信息。不暴露路径之外的任何环境变量（token 等凭证绝不入响应）。
      let version = ''
      try { version = String(require('../package.json').version || '') } catch (e) { version = '' }
      let rss = 0
      try { rss = process.memoryUsage().rss } catch (e) { rss = 0 }
      sendJson(res, 200, {
        version,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        pid: process.pid,
        uptimeS: Math.floor(process.uptime()),
        rssBytes: rss,
        cacheDir: stateDir,
        startedAt: startedAtMs
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/trigger') {
      acceptAction(req, res, {})
      return
    }
    // 批次④ 4.1：通知自检——一次真实推送动作，语义上是「另一种动作」，复用触发全套防线
    // （鉴权 401 / shuttingDown 503 / 重放窗 60s / 单飞锁），零 body。子进程 =
    // spawn(node, [ENTRY_SINGLE, '--notify-test'])（entry:'single' 映射，见 ACTIONS 行）。
    if (req.method === 'POST' && url.pathname === '/api/notify-test') {
      acceptAction(req, res, { fixedAction: 'notify-test' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const list = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((r) => ({
        id: r.id,
        action: r.action,
        label: r.label,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        cancelled: r.cancelled === true
      }))
      sendJson(res, 200, { runs: list })
      return
    }
    // GET /api/runs/stream（v3.300 批次③ 3.1）：运行中任务输出的 SSE 实时流。
    // ?id=<epoch.seq>&since=<offset>。鉴权零代码（继承上方全局闸）：原生 EventSource
    // 不能带自定义头 → Bearer 不可用；GET 收会话 Cookie（authorize 内 GET 分支），前端走
    // Cookie；API/测试可用 ?token=（浏览器流同款）。端点与前端统一 id= 键名（蓝图口径）。
    if (req.method === 'GET' && url.pathname === '/api/runs/stream') {
      // 关停闸：与 /trigger/cancel 同哲学——关停窗口不新开长连接（setShuttingDown 已置位，
      // 活跃连接由 shutdown 序列广播 done，见 wireGracefulShutdown）。
      if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭' }); return }
      const id = url.searchParams.get('id')
      if (typeof id !== 'string' || id.length === 0) { sendJson(res, 400, { error: '缺少 id（epoch.seq 数字形态）' }); return }
      if (!RUN_ID_RE.test(id)) { sendJson(res, 400, { error: 'id 必须是 epoch.seq 数字形态' }); return }
      const record = runs.get(id)
      if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
      // 连接数闸：第 9 个 503（蓝图防线 3；Set 登记 + close 必清理在上方连接管理块）。
      if (sseConnections.size >= SSE_MAX_CONNECTIONS) { sendJson(res, 503, { error: 'SSE 连接数已达上限' }); return }
      // since 钳制（蓝图红线：Number + 整数 + 非负）：非法一律钳 0 → 客户端收整段，自愈。
      // 越界（> outputTotalLength）钳到当前尾部（评审 231-M3）：保留超前游标会让
      // ssePlanChunk 恒 null，后续真实输出被吞到游标追上为止——客户端错过内容。
      // 缺省 = 从当前快照尾部开始（绝对偏移 = outputTotalLength，增量只发新数据）。
      let cursor
      if (url.searchParams.has('since')) {
        const n = Number(url.searchParams.get('since'))
        cursor = Number.isSafeInteger(n) && n >= 0 ? Math.min(n, record.outputTotalLength) : 0
      } else {
        cursor = record.outputTotalLength
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', // 禁 nginx 类反向代理缓冲（蓝图口径）
        Connection: 'keep-alive'
      })
      res.flushHeaders()
      const conn = {
        id,
        res,
        cursor, // 绝对偏移（UTF-16 code units），与 ssePlanChunk 同单位
        pending: '', // 背压期间的应用层待发帧串（有序）
        pendingBytes: 0, // 待发积压（UTF-8 字节），超 ssePendingLimit 硬断
        paused: false,
        closed: false,
        lastPingAt: Date.now(),
        timer: null
      }
      sseConnections.add(conn)
      conn.timer = setInterval(() => sseTick(conn), SSE_TICK_MS)
      if (typeof conn.timer.unref === 'function') conn.timer.unref() // 蓝图防线 5
      res.on('drain', () => { conn.paused = false; sseFlushPending(conn) })
      res.on('close', () => sseTeardown(conn))
      res.on('error', () => sseTeardown(conn))
      sseTick(conn) // 建连即补发一次：since=0 / 落后游标 → 本 tick 出增量或 reset
      return
    }
    // POST /api/runs/detail：详情查询的 POST 形态（body: id=...）。与 GET /api/runs/:id
    // 等价（同响应体）；提供 POST 形态是因为前端 fetch 的 URL 必须是字面量（Codacy SSRF
    // 规则不接受任何含变量的 URL 第一参数，GET /:id 形态无法满足），id 改走请求体。
    // 只读、无副作用，鉴权与 GET 完全一致（Cookie 会话对 POST 无效——G_4Kb 收紧口径不变，
    // 会话用户由 boot JSON 提供显式 Bearer 凭证）。
    if (req.method === 'POST' && url.pathname === '/api/runs/detail') {
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          const m = /(?:^|&)id=(\d{13,}\.\d{1,10})$/.exec(body)
          if (!m) { sendJson(res, 400, { error: '缺少合法 id（epoch.seq 数字形态）' }); return }
          const record = runs.get(m[1])
          if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
          sendJson(res, 200, {
            id: record.id,
            action: record.action,
            label: record.label,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            exitCode: record.exitCode,
            timedOut: record.timedOut,
            cancelled: record.cancelled === true,
            output: record.output,
            // 绝对偏移游标数据源（v3.300 3.1）：环形淘汰后 output.length ≠ 绝对偏移，
            // 前端初始游标必须用 outputTotalLength（§2 D5）。两详情响应体保持等价。
            outputTotalLength: record.outputTotalLength
          })
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
      return
    }
    // POST /api/runs/cancel（v3.299 批次②）：停止运行中的触发任务。body: id=...，
    // 与 /api/runs/detail 同形态（前端 fetch 首参必须是字面量 URL——Codacy SSRF 规则，
    // GET /:id/cancel 形态无法满足）。
    //
    // 安全设计（评审预审）：
    // - 杀进程只经 record._child 对象引用（内核句柄绑定 spawn 时进程，免疫 pid 复用）；
    //   锁帧 pid 是控制台自身，绝不作为 kill 目标。
    // - 信号纪律：SIGTERM → 3s 宽限（unref 定时器）→ SIGKILL 兜底，与既有超时/关停
    //   路径同一套「杀→等 close→锁由 close 释放」机器。
    // - 锁零操作：不 unlink（CodeQL 铁律）、不覆写、不碰 lastAccept——取消后重放窗保留，
    //   同动作 ≈12min 冷却，阻断「取消后误重推已送达未记录条目」（半推送披露见 README）。
    // - 幂等：已完成 409；已取消 200 返回现状（防重复按钮发第二次信号）。
    if (req.method === 'POST' && url.pathname === '/api/runs/cancel') {
      if (shuttingDown) {
        sendJson(res, 503, { error: '控制台正在关闭，动作未执行' })
        return
      }
      readBody(req)
        .then(({ body, aborted, over }) => {
          // 关停竞态兜底：readBody 期间收到 SIGTERM 时，关停序列即将 SIGKILL 全部子进程，
          // 这里再发信号会与关停机器打架——拒绝（与 /trigger 同款双查）。
          if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          // id 形态 = 「epoch.seq」全数字段（Sourcery #229-1）：跨进程结构性失配，
          // 旧 id 在新进程必然 404，不存在「序列复用误命中」。
          const m = /(?:^|&)id=(\d{13,}\.\d{1,10})$/.exec(body)
          if (!m) { sendJson(res, 400, { error: '缺少合法 id（epoch.seq 数字形态）' }); return }
          const record = runs.get(m[1])
          if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
          if (record.cancelled) {
            // 幂等先于 finishedAt（Sourcery #229-8）：已受理过取消的任务之后无论是否
            // 已结束，重复 cancel 都返回 200 现状——不因时序在 200/409 间漂移。
            sendJson(res, 200, { id: record.id, action: record.action, cancelled: true, finishedAt: record.finishedAt || null })
            return
          }
          if (record.exitedAt || record.finishedAt) {
            // exitedAt（Sourcery #229-10）：exit 事件先于 close（stdout/stderr drain 中）
            // 的窗口里任务已不可取消——以「进程已退出」为准，而不是等 close 落 finishedAt。
            sendJson(res, 409, { error: '该任务已结束，无需停止' })
            return
          }
          record.cancelled = true
          record.cancelRequestedAt = Date.now()
          // 绕过 append 直改 output：计数器必须同步加（§1.3 理由同上）。
          const note = '\n[console] 收到停止请求，正在终止子进程…\n'
          record.output += note
          record.outputTotalLength += note.length
          // Sourcery #229-11：停止留痕进 run.log——被停任务不会有自然收尾的摘要行，
          // 控制台补一行 ERROR 强失败标记（上海时区戳与写入侧 _localStamp 同形态），
          // readRunHistory 的新轮界模型把它识别为「尾端失败行 → 崩溃轮占位」，
          // 重启后运行历史仍能看到这轮被停过。追加失败静默（与写入侧留痕口径一致）。
          try {
            const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            const stamp = stampFmt.format(new Date())
            const stopDir = stateDir
            fs.appendFileSync(path.join(stopDir, 'run.log'), `${stamp} ERROR 控制台停止：任务 #${record.id}（${record.action}）于运行中被停止（SIGTERM）\n`, 'utf8')
          } catch (e) { /* 留痕失败静默：内存 record.cancelled 已是权威 */ }
          try {
            record._child && record._child.kill('SIGTERM')
          } catch (e) { /* 子进程句柄已失效：close 即将到来，兜底无害 */ }
          // SIGKILL 兜底：宽限期后 close 仍未来（SIGTERM handler 卡住等）→ 强杀。
          // 不依赖 kill 返回值（Node 不保证其反映进程状态）：已死进程上再签 SIGKILL
          // 是无害 no-op，漏签才会让卡死任务挂到 PROC_TIMEOUT_MS。
          // Sourcery #229-0：close 一到就 clearTimeout——子进程已死后再发的 SIGKILL
          // 理论上不会命中复用 pid（kill 走句柄不走裸 pid，但句柄在子进程退出后发信号
          // 本就是无意义动作），清理定时器让事件循环不留 3s 悬挂句。
          const cancelChild = record._child
          record._cancelTimer = setTimeout(() => {
            try { cancelChild.kill('SIGKILL') } catch (e) { /* 已退出 */ }
          }, CANCEL_GRACE_MS)
          if (typeof record._cancelTimer.unref === 'function') record._cancelTimer.unref()
          sendJson(res, 202, { id: record.id, action: record.action, cancelled: true })
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
      return
    }
    const runMatch = /^\/api\/runs\/(\d{13,}\.\d{1,10})$/.exec(url.pathname)
    if (req.method === 'GET' && runMatch) {
      const record = runs.get(runMatch[1])
      if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
      sendJson(res, 200, {
        id: record.id,
        action: record.action,
        label: record.label,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        exitCode: record.exitCode,
        timedOut: record.timedOut,
        cancelled: record.cancelled === true,
        output: record.output,
        outputTotalLength: record.outputTotalLength // 与 POST detail 等价（v3.300 3.1）
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  // Sourcery High：关闭时终止所有活跃子进程（SIGKILL），避免控制台停了触发任务还在跑。
  // 覆写 close：先杀子进程再走原生 close；'close' 事件再兜底清一次。
  const killAll = () => {
    for (const child of activeChildren) {
      try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
    }
  }
  const origClose = server.close.bind(server)
  server.close = (cb) => {
    killAll()
    return origClose(cb)
  }
  server.on('close', killAll)
  // ── 优雅关闭装配（v3.297 自 main 抽出，Sourcery #225 M6：原实现不可测——测试无法
  // 确认「关停真的 SIGKILL 了子进程、并等 close 后才退出」）。依赖注入 onExit/registerSignal：
  // 测试传假子进程 + 假 exit 即可确定性断言序列；生产 main 无参调用即等价旧行为。
  const wireGracefulShutdown = ({ onExit, registerSignal } = {}) => {
    let exitDone = false
    const doExit = (code) => {
      if (exitDone) return
      exitDone = true
      if (onExit) onExit(code)
      else process.exit(code)
    }
    const shutdown = (signal) => {
      setShuttingDown() // 关停闸：/trigger 即刻 503，readBody 回调不得再 spawn（评审 High）
      // SSE 关停广播（v3.300 3.1）：置位即给所有活跃连接发 done 并 end。
      // ⚠️ 正确性要求而非体验优化（§A5）：不主动 end 的话 SSE 属「在途连接」，
      // closeIdleConnections() 不动它，500ms 的 closeAllConnections() 会硬断——
      // 客户端收到 RST 而非 done 帧；且 server.close() 回调会一直等 SSE 结束，
      // 悬挂到 1s 强退兜底。done 帧经 sseWriteFrame（背压安全）+ sseTeardown（幂等 end）。
      for (const conn of sseConnections) {
        sseWriteFrame(conn, 'event: done\ndata: {}\n\n')
        sseTeardown(conn)
      }
      console.log(`收到 ${signal}，关闭控制台：终止触发子进程并释放锁…`)
      for (const child of activeChildren) {
        try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
      }
      // 锁释放时机（评审 Medium G5F/G5K）：不能在 SIGKILL 后立刻 unlink（子进程还没死，
      // 别的实例会立刻拿锁与垂死子进程重叠），也不能「读-判-删」（TOCTOU：判定后锁被
      // 接管换主，unlink 误删新主锁）。正确序列：杀子进程 → 等每个子进程真正 close
      // （close 回调里 releaseLockFor 已按 pid+token 双匹配释放）→ 全部收完才退出。
      // activeChildren.clear() 不能提前——清了就收不到 close 计数。
      const pending = [...activeChildren]
      let exited = 0
      const maybeFinish = () => {
        exited++
        if (exited >= pending.length) finishShutdown()
      }
      let finished = false
      const finishShutdown = () => {
        if (finished) return
        finished = true
        server.close(() => doExit(0))
        // close 只挡新连接，既有 keep-alive/在途连接要显式收尾：空闲连接立即排空，
        // 在途请求给 500ms 完成窗口（本地看板端点毫秒级）后强断，1s 强退兜底——
        // 不排空会让客户端收到 ERR_EMPTY_RESPONSE、挂起的 keep-alive 得不到关闭帧。
        server.closeIdleConnections()
        setTimeout(() => { server.closeAllConnections() }, 500).unref()
        setTimeout(() => doExit(0), 1000).unref()
      }
      if (pending.length === 0) {
        finishShutdown()
      } else {
        for (const child of pending) {
          // close 在子进程真正死后触发（SIGKILL 毫秒级）；同时兜底 3s 强制收尾，
          // 防个别子进程 close 事件丢失导致控制台挂住不退。
          child.once('close', maybeFinish)
        }
        setTimeout(finishShutdown, 3000).unref()
      }
    }
    if (registerSignal) registerSignal(shutdown)
    else {
      process.on('SIGTERM', () => shutdown('SIGTERM'))
      process.on('SIGINT', () => shutdown('SIGINT'))
    }
    return { shutdown }
  }
  return { server, runs, activeChildren, setShuttingDown, ownerToken, wireGracefulShutdown, sseConnections }
}

// ── 启动入口 ───────────────────────────────────────────────────────────────
function main () {
  const token = process.env.XBK_CONSOLE_TOKEN
  // Sourcery #225 M5：XBK_CONSOLE_PORT 非空但非法（非数字/超范围）时 Number() 得 NaN，
  // 旧 || 7777 会把合法的 0（随机端口）一起吞掉；先区分「未设置」与「设了但坏」——
  // 坏值 fail-closed 拒启并说明，不静默回退默认端口（用户以为改了端口实际没有）。
  const rawPort = process.env.XBK_CONSOLE_PORT
  let port = 7777
  if (rawPort != null && rawPort !== '') {
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`❌ XBK_CONSOLE_PORT 非法：「${rawPort}」不是 0–65535 的整数端口，控制台拒绝启动（fail-closed）`)
      process.exit(1)
    }
  }
  const host = process.env.XBK_CONSOLE_HOST || '127.0.0.1'
  // Sourcery Medium：与生产入口 / --status 同源解析缓存目录（含安全回退），
  // 不再手写默认值——否则 .xbk_cache_safe 生效时看板会读错目录。
  const stateDir = statusCacheDir()
  // 显式化运行侧缓存目录漂移（Sourcery PR#227「Custom cache records stay hidden」）：
  // 控制台状态体系（run.log / report.state / 锁）以 stateDir 为准；若运行侧 Config.cache.dir
  // 解析到别处，推送缓存与状态文件就分居两目录——启动时高声警告，而不是让「推送记录」页静默 missing。
  const runtimeDir = runtimeCacheDir()
  if (runtimeDir && path.resolve(runtimeDir) !== path.resolve(stateDir)) {
    console.error(`⚠️ 运行侧缓存目录（Config.cache.dir → ${runtimeDir}）与控制台目录（${stateDir}）不一致：` +
      `推送记录页将读不到 push.json。请把 XBK_CACHE_DIR 设为 ${runtimeDir}，或让两处配置一致。`)
  }
  // 锁归属 token（评审 Medium：pid 复用会让「pid===process.pid」误认他人锁为自有；
  // takeover 换主后 unlink 竞态也可能误删新主的锁）。锁内容带 token，释放须双匹配。
  const lockToken = crypto.randomBytes(12).toString('hex')
  const { server, wireGracefulShutdown } = createConsole({ token, stateDir, port, host, lockToken, messagesFile: messagesCacheName() })
  // 优雅关闭：装配逻辑在 createConsole.wireGracefulShutdown（v3.297 抽出以便依赖注入
  // 测试，Sourcery #225 M6）。生产路径无注入 = process.exit + 全局信号监听，与抽取前等价。
  wireGracefulShutdown()
  server.listen(port, host, () => {
    console.log(`xbk-push 控制台已启动：http://${host}:${server.address().port}（缓存目录：${stateDir}）`)
    console.log(`鉴权：请求头 Authorization: Bearer <XBK_CONSOLE_TOKEN>，或浏览器打开 http://${host}:${server.address().port}/?token=<XBK_CONSOLE_TOKEN>；token 未设置或过短则拒绝启动`)
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      // Sourcery High：非回环绑定 = token 明文过网（HTTP 无 TLS）。此处只告警不强拒——
      // 内网受信环境是 README 认可的用法，但必须让操作者知道风险与缓解手段。
      console.warn('⚠️ XBK_CONSOLE_HOST 绑定的是非回环地址：Bearer/查询参数 token 将以明文传输（HTTP）。')
      console.warn('   仅在受信内网使用；跨网访问请前置 TLS 反代（nginx/caddy 终止 TLS 后转发本端口）。')
    }
  })
}

if (require.main === module) main()

module.exports = {
  createConsole,
  isValidToken,
  timingSafeEqualStr,
  acquireLock,
  releaseLockFor,
  lockPath,
  parseAction,
  sessionCookieValue,
  SESSION_COOKIE,
  escapeHtml,
  formatMs,
  renderPage,
  authorize,
  ACTIONS,
  TOKEN_MIN_LEN,
  RUN_LOG_MAX_BYTES,
  PROC_TIMEOUT_MS,
  // v3.298 只读扩展：纯函数/常量导出（非 HTTP 单测 + 变异测试可达性）
  statSafeMeta,
  tombstoneCounts,
  cacheHealthSnapshot,
  listStateFiles,
  classifyStateFile,
  buildConfigView,
  configuredFlag,
  defaultHealthLimits,
  TREND_DAYS_ALLOWED,
  TREND_DAYS_DEFAULT,
  FILES_LIST_MAX,
  CACHE_HEALTH_NEAR_RATIO,
  // v3.300 访问日志：纯函数/常量导出（非 HTTP 单测 + 变异测试可达性）
  sanitizeAccessPath,
  shouldLogAccess,
  ACCESS_LOG_MAX,
  // v3.300 批次③ 3.2 消息导出：纯函数/常量导出（非 HTTP 单测 + 变异测试可达性）
  filterMessageItems,
  clampQueryBytes,
  csvCell,
  exportRowOf,
  buildMessagesCsv,
  EXPORT_MAX_ROWS,
  EXPORT_EXCERPT_MAX,
  EXPORT_FORMATS,
  // v3.300 批次③ 3.1 SSE：纯函数/常量导出（非 HTTP 单测 + 变异测试可达性）
  RUN_ID_RE,
  ssePlanChunk,
  SSE_TICK_MS,
  SSE_HEARTBEAT_MS,
  SSE_MAX_PENDING,
  SSE_MAX_CONNECTIONS,
  // v3.301 批次④ 4.1 通知自检：常量/入口导出（spawn entry 映射断言 + 重放窗断言）
  REPLAY_WINDOW_NOTIFY_TEST_MS,
  ENTRY_SINGLE
}
