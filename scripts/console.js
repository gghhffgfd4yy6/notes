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
const { readSafeTextResult, writeAtomic } = require('../xbk_storage')
// 过滤规则覆盖文件存储层（纯同步、零新依赖、不 require xbk_function_v3）：
// 路径/合并/校验/生效快照复用 store 的单一实现，控制台只做 HTTP 装配与写流程。
const FilterStore = require('../xbk_filter_store')
const { statusCacheDir } = require('../qinglong/xbk_push')

// 控制台版本（package.json 是唯一真源）：/api/sys 与页面 boot JSON 共用一份，别两处各 require——
// 前端靠「boot 里的版本 ≠ /api/sys 的版本」判断部署后旧标签页需要刷新（v3.332）。
const APP_VERSION = (() => {
  try { return String(require('../package.json').version || '') } catch (e) { return '' }
})()

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

// 控制台 stateDir（审查 #241 M1）：以运行侧 MessageStore.cacheDir（runtimeCacheDir）为
// 唯一来源——面板读的目录必须就是运行侧真实写入的目录（run.log / report.state / push.json）。
// 否则设根外绝对 XBK_CACHE_DIR 时控制台读 A、运行写 B，运行历史与推送记录永远读空。
// 取不到运行侧解析结果（应用配置加载失败）才退回 XBK_CACHE_DIR / 默认目录。
function consoleStateDir () {
  return runtimeCacheDir() || statusCacheDir()
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
// 消息列表（GET /api/messages）读取上限：push.json 是判重缓存主存（生产写入上限
// MESSAGE_CACHE_MAX_BYTES = 64MiB）。旧口径按 32MiB 封顶（D2-N11）：介于两者之间的**合法**
// 缓存会被永久判 tooLarge——缓存健康页报「不可读」，但生产侧一切正常。现与写端对齐到 64MiB；
// 单次解析成本由 status.readMessages 的 (ino,size,mtime) 缓存摊薄（D2-S18），不再每请求整读。
const MESSAGES_MAX_BYTES = 64 * 1024 * 1024
// 数据备份：一个 JSON 文件包含用户勾选的类别；导入只恢复文件里实际存在的类别。
// 自动运行只备份 interval，不备份 on/off——导入永远不会把自动运行打开。
const BACKUP_KIND = 'xbk-console-backup'
const BACKUP_SCHEMA = 1
const BACKUP_MAX_BYTES = 128 * 1024 * 1024
const BACKUP_RUN_LOG_MAX_BYTES = 16 * 1024 * 1024
const BACKUP_CATEGORIES = ['messages', 'filter', 'settings', 'auto', 'runLog']
// cache-health 的条数统计阈值（D2-S12）：这个端点在 HTTP 事件循环上同步整读 + parse，
// 20MB/29704 条实测 232ms 阻塞。超过阈值就不整读——条数如实报 null + tooLarge（前端显示
// 「当前条数不可得」），需要精确条数时去推送记录页看 grandTotal。阈值内的文件走
// readMessages 的 (ino,size,mtime) 缓存，重复请求不再 parse。
const CACHE_HEALTH_COUNT_MAX_BYTES = 8 * 1024 * 1024
// 日志查看（GET /api/logs）取尾部：日志消费方只关心最近的记录，与 scripts/status.js 的
// LOG_READ_OPTIONS.tail 同一口径（超限读尾 1MiB，不全拒）。
const LOG_VIEW_MAX_BYTES = 1024 * 1024
// 消息列表分页参数上限：单页条数 1–100，页码 1–10000（防御性钳制，URL 参数是未验证输入）。
const MESSAGES_PAGE_SIZE_MAX = 100
const MESSAGES_PAGE_MAX = 10000
// 搜索词长度上限（字节）：UTF-8 下 240 字节足够容纳 80 个汉字，防止超长 query 白耗 CPU。
const MESSAGES_QUERY_MAX_BYTES = 240
// 推送记录时间窗（v3.307）：0=全部；1=今天；3/7/30=近 N 个上海日历日（含今天）。
// 与 run.log 同口径用 Asia/Shanghai 日历日，避免宿主 UTC 时 00:00–08:00 归错天。
const MESSAGE_DAYS_ALLOWED = Object.freeze([0, 1, 3, 7, 30])

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
// 自检是高频调试动作，不能连点刷通知 → 60s。通用动作窗 D2-S16 后同为 60s，但常量保持
// 独立：语义不同（自检每次都真实推送），将来若要再区分，不必重拆通用窗。
// lastAccept 本就按 action 键控（per-action Map + 持久化 JSON 的 key），无需改持久化结构。
const REPLAY_WINDOW_NOTIFY_TEST_MS = 60 * 1000

// ── v3.340：通知自检的重复提交拦截窗可在线改（配置页 → 保存即生效）────────────
// REPLAY_WINDOW_NOTIFY_TEST_MS 仍是「默认值」锚点（沿用既有常量，语义不变）；运行期生效值
// 存在 runtimeSettings 里，由 <stateDir>/console-settings.json 恢复、由配置页写回。
// 0 = 关闭拦截：判定式 `now - prev.at < 0` 天然为假，不需要特殊分支（连点会重复真实发送）。
const NOTIFY_REPLAY_MIN_S = 0
const NOTIFY_REPLAY_MAX_S = 3600
const CONSOLE_SETTINGS_FILE = 'console-settings.json'
const CONSOLE_SETTINGS_DEFAULT_S = 60
// 设置文件读取上限：正常只有几十字节；超限按损坏处理（防误放的巨文件把控制台读卡死）。
const CONSOLE_SETTINGS_MAX_BYTES = 64 * 1024

// 自动正式运行：HTTP 不接受该动作，只由服务器调度器内部触发。
// 服务器端自动正式运行：调度在控制台进程内，不依赖浏览器页面。
const AUTO_MIN_S = 3
const AUTO_MAX_S = 20
const AUTO_DEFAULT_S = 10
const AUTO_MAX_FAILS = 3
const AUTO_STATE_FILE = 'console-auto.json'
function clampAutoSeconds (v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return AUTO_DEFAULT_S
  return Math.min(AUTO_MAX_S, Math.max(AUTO_MIN_S, n))
}

// ── v3.300 访问日志常量 ─────────────────────────────────────────────────────
// 纯内存环形上限：重启即空、不写盘（README 披露）——避免日志自身成为磁盘面，
// 已有时序上更全的 run.log 留痕体系（蓝图 §3.3）。
const ACCESS_LOG_MAX = 200
// 访问日志的敏感参数键（D2-N1）：旧实现只认 `token=`，`access_token=`/`key=`/`secret=`
// 原样入日志并展示。这里用「键名包含」判定（键名先解码到不动点再小写），覆盖
// access_token / refresh_token / appkey / api_key / secret / password 等派生形态；
// 判定对象是键名而不是整条 URL——值里恰好出现 "token" 字样不得导致整段删除（D2-N2）。
// 键名列表是服务端常量，用户输入只作为 String 被 includes，不进正则构造。
const SECRET_PARAM_HINTS = Object.freeze(['token', 'secret', 'password', 'passwd', 'key', 'credential'])
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
  // 自动模式与手动 run 跑同一个入口/参数，只是独立的幂等重放键（3s 窗），
  // 否则 60s 窗会把自动循环挡掉；运行中仍由同一把单飞锁互斥。
  'run-auto': { entry: 'single', args: [], label: '自动正式运行（真实推送）' },
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
  // 独占创建 = 「临时文件写全 + link 占名」：内容先完整落盘，再用 linkSync 原子占名
  // （link 目标已存在即 EEXIST，不会覆盖——独占语义与 open(p,'wx') 等价，但不会暴露
  // 「文件名已占、内容还没写」的窗口）。旧实现 open(p,'wx') 后写内容：进程在这两步之间
  // 崩溃就留下 0 字节锁，读取侧无法解析 ⇒ fail-closed 永久拒绝触发（D2-S1）。
  // ⚠️ 不能走 rename 覆盖路径——POSIX rename 会静默替换已存在目标，独占性名存实亡
  // （回归教训见 test「并发获取拒绝」用例）。
  // token：进程级随机归属标识，释放/判定所有权须 pid+token 双匹配（评审 Medium：
  // 单看 pid 会被 OS 复用 pid 的后来进程误认；接管换主后也可能误删新主锁）。
  const frame = JSON.stringify({ pid: process.pid, startedAt: now, token })
  const tmp = `${p}.${process.pid}.${now}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, frame, { flag: 'wx' })
  try {
    fs.linkSync(tmp, p)
  } catch (e) {
    // 不支持硬链接的文件系统（少数网络卷/容器层）回退到旧的独占创建 + 写内容；
    // EEXIST 原样上抛给 acquireLock 的「锁已存在」分支。
    if (!e || e.code === 'EEXIST') throw e
    if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(e.code)) {
      const fd = fs.openSync(p, 'wx')
      try { fs.writeFileSync(fd, frame); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      return
    }
    throw e
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) { /* 已被 link 消费或并发清理 */ }
  }
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
    // 锁内容损坏/startedAt 无效（Sourcery Medium #11）：无法判定持有方死活。旧实现一律
    // fail-closed ⇒ 0 字节锁（旧写入路径在 open 与 write 之间崩溃的产物）让触发永久 409，
    // 只能人工删文件（D2-S1）。现在给一条自救路径：锁文件 mtime 已陈旧（超过单轮超时，
    // 说明没有任何进程在维护它）时允许接管；新鲜损坏锁仍 fail-closed（可能正被写入）。
    let corruptedStale = false
    if (corrupted && !released) {
      let mtimeAge = null
      try { mtimeAge = now - fs.statSync(p).mtimeMs } catch (e) { mtimeAge = null }
      if (!(typeof mtimeAge === 'number' && mtimeAge > PROC_TIMEOUT_MS)) return false
      corruptedStale = true
    }
    const stale = released || (corrupted ? corruptedStale : (now - startedAt > PROC_TIMEOUT_MS))
    if (!stale) return false
    // 陈旧/损坏锁接管：哨兵独占，防并发接管双跑（Sourcery High）。
    const sentinel = p + '.takeover'
    let claimed = false
    for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
      try {
        const fd = fs.openSync(sentinel, 'wx')
        fs.closeSync(fd)
        claimed = true
      } catch (err) {
        if (!err || err.code !== 'EEXIST') break
        // 哨兵已存在：可能是上一次接管者崩溃后留下的残留（它会让后续触发连续 10 分钟 409，
        // D2-S5）。陈旧 ⇒ 先 unlink 再重抢；重抢必须走 open(wx) —— 旧实现的
        // stat→writeFileSync 是 check-then-write，两个实例可同时 claimed。
        let sentinelStale = false
        try {
          const st = fs.statSync(sentinel)
          sentinelStale = now - st.mtimeMs > PROC_TIMEOUT_MS
        } catch (e2) { sentinelStale = true /* 哨兵刚消失：重抢 */ }
        if (!sentinelStale) break
        try { fs.unlinkSync(sentinel) } catch (e2) { /* 已被并发接管者清掉 */ }
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
// 子进程收尾（审查 #229 S6）：exit 与 close 都调用，幂等。旧实现只挂 close——孙进程继承
// stdout/stderr 时 close 要等所有持有者关闭管道（实测父进程 211ms 退出、close 4032ms 才到），
// 期间看板长时间显示「停止中」，触发锁也不释放。exit 一到就落 finishedAt + 释放锁；
// close 只做剩余清理（exitCode 兜底、activeChildren 摘除、取消定时器）。
function finishRun (record, code, { release = releaseLockFor, now = Date.now } = {}) {
  if (!record || record.finishedAt) return false
  if (Number.isInteger(code)) record.exitCode = code
  record.finishedAt = now()
  if (record._cancelTimer) { clearTimeout(record._cancelTimer); record._cancelTimer = null }
  if (record._timer) { clearTimeout(record._timer); record._timer = null }
  // 只有真正持有过锁的运行才释放（spawn 前就失败的记录没有 _stateDir/_lockToken）
  if (record._stateDir && record._lockToken && !release(record)) {
    console.error(`⚠️ 任务 #${record.id} 的触发锁释放失败（文件系统异常或锁已换主）：锁将保留到陈旧接管（约 10 分钟），期间触发 409 属预期；持续出现请按 README「故障排查」处理。`)
  }
  return true
}

function startAction (actionKey, now, activeChildren, cacheDir, lockToken, lockDir) {
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
    closedAt: 0, // close 事件时刻（stdio 全部 drain 完；SSE 只在此后发 done）
    exitCode: null,
    timedOut: false,
    output: '',
    outputTotalLength: 0,
    cancelled: false,
    // 锁归属（startAction 内登记，exit 可能早于调用方后续赋值：收尾必须能直接释放锁）。
    // lockDir = 锁文件所在目录（控制台 stateDir）；cacheDir = 子进程 run.log 写入目录。
    _stateDir: lockDir || cacheDir,
    _lockToken: lockToken
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
  // 子进程缓存/日志目录钉死到 historyDir()（Sourcery：测试实例的临时目录若不下传，子进程
  // 会回落到仓库生产缓存 → 测试触发的轮次/停止留痕混进生产 run.log；生产侧它与运行侧
  // MessageStore.cacheDir 同源，读写一致）。
  if (cacheDir) childEnv.XBK_CACHE_DIR = cacheDir
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
  record._timer = timer
  child.on('exit', (code) => {
    // Sourcery #229-10：exit 先于 close（输出流 drain 中）。取消判据用 exitedAt，
    // 避免「进程已退出但 close 未到」窗口里 cancel 误杀已自然完成的任务。
    record.exitedAt = Date.now()
    // 审查 #229 S6：exit 即收尾（finishedAt + 释放锁）。close 可能因孙进程持有 stdio
    // 迟到数秒，不能把「任务已结束」和「锁已释放」押在 close 上。
    finishRun(record, code)
  })
  child.on('close', (code) => {
    // 剩余清理：exit 未触发的极端路径（spawn error 后仅 close）在这里补收尾；幂等。
    // closedAt 必须先于 finishRun：SSE 的 done 以「stdio 已 drain」为准，exit 时提前
    // 发 done 会丢掉 exit 后、close 前到达的尾段输出（Sourcery SSE 丢最后一段日志）。
    record.closedAt = Date.now()
    finishRun(record, code)
    if (record.exitCode === null && Number.isInteger(code)) record.exitCode = code
    if (activeChildren) activeChildren.delete(child)
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
    // 只有 ENOENT 才是「锁已不在，无事可释放」；EACCES/EMFILE/EIO 等是「读不到/打不开」——
    // 旧实现一律 return true 会让调用方以为锁已释放，实际锁仍挂在盘上（D2-S3）。
    // 返回 false 让调用方响亮告警（finishRun / 受理失败分支都已有告警文案）。
    return !!e && e.code === 'ENOENT'
  }
  try {
    const raw = fs.readFileSync(fd, 'utf8')
    const data = JSON.parse(raw)
    if (data.pid === process.pid && data.token === record._lockToken) {
      // inode 一致性闸：两代不一致 = 已被 tmp+rename 接管换名，本 fd 只指向孤儿
      // inode——不覆写，锁归接管方负责（返回 false 如实上报）。
      let pathIno = 0
      try { pathIno = fs.statSync(p).ino } catch (e) { return !!e && e.code === 'ENOENT' /* 锁路径已消失 */ }
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
  '/assets/pure.mjs': { file: 'pure.mjs', type: 'text/javascript; charset=utf-8' },
  '/assets/htm-preact.module.js': { file: 'htm-preact.module.js', type: 'text/javascript; charset=utf-8' },
  // v3.326 日期区间：flatpickr 4.6.13 的 ESM 单文件 bundle（esbuild 打包，含 zh 语言包）
  // 与官方 CSS。两者都随白名单伺服，CSP script-src 'self' 覆盖，无 CDN。
  '/assets/flatpickr.js': { file: 'flatpickr.module.js', type: 'text/javascript; charset=utf-8' },
  '/assets/flatpickr.css': { file: 'flatpickr.css', type: 'text/css; charset=utf-8' }
})

// 资产存储（v3.302）：启动时一次性读盘成快照（raw/gzip/ETag 常驻内存，各文件 < 100KB）。
// 版本号 = 各文件内容哈希拼接后的 sha16，renderPage 以 ?v=<sha16> 引用；带当前版本的 URL 可长缓存
// （private + immutable），裸 URL 仍 no-cache（测试与旧页面兼容）。部署 = systemd restart。
// 注：app.js 内部 `import './pure.mjs'` 不带版本号，走裸 URL 的 no-cache + ETag 协商（内容哈希仍参与
// 全站版本号，因此任一资产变更都会让页面引用的 app.js?v= 一起失效）。
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
// 优先级（D1-N2）：显式 gzip 的 q 永远压过 * —— `gzip;q=0, *` 是「明确拒绝 gzip，其余随你」，
// 旧实现按出现顺序先命中 `*`（无 q ⇒ 视为接受）就返回 true，仍回压缩体。
// 无显式 gzip 时才落 *；两者都没有 = 不接受 gzip。非法 q 值按 0（不接受）处理。
function acceptsGzip (header) {
  let explicit = null
  let wildcard = null
  for (const part of String(header || '').split(',')) {
    const segs = part.trim().toLowerCase().split(';')
    const token = segs[0].trim()
    if (token !== 'gzip' && token !== '*') continue
    const qseg = segs.slice(1).map((x) => x.trim()).find((x) => x.startsWith('q='))
    let q = 1
    if (qseg) {
      const val = Number(qseg.slice(2))
      q = Number.isFinite(val) ? val : 0
    }
    if (token === 'gzip') explicit = q
    else wildcard = q
  }
  if (explicit !== null) return explicit > 0
  if (wildcard !== null) return wildcard > 0
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

// 敏感键名判定：把键名里的 %XX 逐层解到不动点再小写（堵 %74oken= / %2574oken= 等
// 编码键名；16 轮上限防病态深嵌套）。
function isSecretParamKey (key) {
  let s = String(key == null ? '' : key)
  for (let round = 0; round < 16; round++) {
    let d
    try { d = decodeURIComponent(s) } catch (e) { d = bestEffortDecode(s) }
    if (d === s) break
    s = d
  }
  const lower = s.toLowerCase()
  return SECRET_PARAM_HINTS.some((hint) => lower.includes(hint))
}

// 原串里的裸控制字符转成 %XX：请求行本不该含它们，但 sanitize 的输出会进 JSON/页面，
// 不能把 C0/C1 原样留在日志里（D2-N2）。
function escapeControlChars (s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i)
    out += (cp < 0x20 || cp === 0x7f) ? `%${cp.toString(16).toUpperCase().padStart(2, '0')}` : s[i]
  }
  return out
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
  // 脱敏硬闸（蓝图防线 1 / D2-N1 / D2-N2）：
  // ① 判定用「解码到不动点」的键名（堵 %74oken= / %2574oken= 与 access_token= 等派生键）；
  // ② 落盘用**原串**逐段改写——旧实现返回解码后的整条 URL，既可能含 %0A 解出的控制字符，
  //    也与真实请求行不再一一对应（排障时按日志无法定位请求）；
  // ③ 只替换命中键的**值**：非敏感参数的值原样保留（值里出现 "token" 字样不等于它就是
  //    凭证，不得整段删除）；
  // ④ 畸形 % 序列不抛错（bestEffortDecode 逐段解），先例口径同 sessionCookieValue。
  const src = typeof raw === 'string' ? raw : String(raw == null ? '' : raw)
  const parts = src.split(/([?&;#])/)
  let out = ''
  for (const part of parts) {
    if (part === '?' || part === '&' || part === ';' || part === '#') { out += part; continue }
    const eq = part.indexOf('=')
    if (eq < 0) { out += part; continue }
    const key = part.slice(0, eq)
    out += isSecretParamKey(key) ? `${key}=***` : part
  }
  return escapeControlChars(out)
}

function shouldLogAccess (method, pathname, statusCode) {
  // 降噪白名单（蓝图「记什么」）：2xx/304 且命中白名单才免记；其余（含 401/404/5xx）全记。
  // 304（D2-S10）是浏览器缓存的正常命中——静态资产每次协商都 304，旧实现把它们全塞进
  // 200 条环形，把真正的可疑请求挤掉。304 只对白名单路径免记（非白名单 304 仍记）。
  // 白名单 = GET / 页面、GET /api/status、GET /api/runs 列表、GET /api/runs/:id 详情、
  // POST /api/runs/detail（D4：前端实际形态，响应体与 GET /:id 等价）、静态三资产、
  // GET /api/runs/stream（v3.300 3.1：SSE 连接分钟级，finish 时 ms=整段连接时长，
  // 照记会污染「慢请求」读数；非 2xx 照记）。
  // /api/access-log 自身 200 不在名单 → 入日志（自举，蓝图防线 3）。
  const okStatus = (statusCode >= 200 && statusCode <= 299) || statusCode === 304
  if (!okStatus) return true
  const m = method === 'GET'
  const p = String(pathname || '')
  if (m && (p === '/' || p === '/api/status' || p === '/api/runs' || p === '/api/runs/stream' ||
    Object.prototype.hasOwnProperty.call(STATIC_ASSETS, p))) return false
  if (m && RUN_DETAIL_PATH_RE.test(p)) return false // D4：GET 详情轮询
  if (method === 'POST' && p === '/api/runs/detail') return false // D4：POST 详情轮询（前端实际形态）
  return true
}

function renderPage (state, runsList, query, sessionToken, theme) {
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
  const bootJson = JSON.stringify({ token: bootToken, version: APP_VERSION })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<!doctype html>
<html lang="zh-CN" data-theme="${THEMES.includes(theme) ? theme : THEMES[0]}"><head><meta charset="utf-8"><title>xbk-push 控制台</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP_HEADER}">
<link rel="stylesheet" href="/assets/flatpickr.css${assetQuery()}">
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

// 未授权首屏（审查 #224）：从聊天点开链接时 SameSite=Strict 的 Cookie 不会随跨站
// 导航发出，旧实现只回裸 JSON {"error":"unauthorized"}，用户看不出该怎么恢复。
// 这里给一个无脚本的最小登录页；token 只经 GET 表单回填，不写日志、不预填。
function renderUnauthorizedPage () {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要访问令牌 · xbk-push 控制台</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1420; color: #e6edf7; font: 15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width: min(420px, calc(100vw - 32px)); background: #171e2e; border: 1px solid #2a3550; border-radius: 12px; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #9aa8c0; margin: 0 0 16px; }
  label { display: block; font-size: 13px; color: #9aa8c0; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #33405f; background: #0f1420; color: #e6edf7; font: inherit; }
  button { margin-top: 12px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #356fd6; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .hint { font-size: 12px; margin: 14px 0 0; }
</style></head>
<body><main>
  <h1>需要访问令牌</h1>
  <p>会话未携带有效凭证（链接可能来自聊天/书签，或 Cookie 已过期）。输入部署时设置的 <code>XBK_CONSOLE_TOKEN</code> 继续。</p>
  <form method="post" action="/login">
    <label for="token">访问令牌（至少 16 字符）</label>
    <input id="token" name="token" type="password" autocomplete="current-password" minlength="16" required autofocus>
    <button type="submit">打开控制台</button>
  </form>
  <p class="hint">令牌只用于本次登录；成功后写入 HttpOnly 会话 Cookie，地址栏不会保留令牌。请勿把登录链接或令牌转发给他人。</p>
</main></body></html>`
}
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
// 主题记忆（v3.323）：只影响配色。CSP 是 script-src 'self'（禁内联脚本），前端无法在
// 首帧前读 localStorage，所以选择放 Cookie，由服务端写进 <html data-theme>；前端切换时
// 只改属性 + 写 cookie，下次打开首帧就是对的（浅色不会先闪一帧深色）。
const THEME_COOKIE = 'xbk_theme'
const THEMES = ['deep', 'material', 'nord', 'light']
function themeCookieValue (cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return THEMES[0]
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() !== THEME_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    return THEMES.includes(value) ? value : THEMES[0]
  }
  return THEMES[0]
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

// 超限后的排空上限（D2-S2）：客户端若只发一半就挂住，不能让连接无限期占着事件循环。
const BODY_DRAIN_TIMEOUT_MS = 10 * 1000
function readBody (req, maxBytes = 4096) {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8')
    let buf = ''
    let over = false
    let aborted = false
    let settled = false
    let drainTimer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
      resolve({ body: over ? '' : buf, over, aborted })
    }
    req.on('data', (c) => {
      if (over) return // 已超限：只排空，不再累积
      buf += decoder.write(c)
      if (buf.length > maxBytes) {
        // 超限后**不能**先 destroy：多 chunk 客户端只会看到 ECONNRESET，413 分支永远
        // 到不了（D2-S2）。改为停止累积 + resume() 排空剩余字节，等 'end' 再回 413。
        over = true
        buf = ''
        req.resume()
        drainTimer = setTimeout(() => {
          try { req.destroy() } catch (e) { /* 已断开 */ }
          finish()
        }, BODY_DRAIN_TIMEOUT_MS)
        if (drainTimer.unref) drainTimer.unref()
      }
    })
    req.on('end', () => { if (!over) buf += decoder.end(); finish() })
    // Sourcery Medium：error 时标记 aborted——残缺 body 不允许触发动作。
    req.on('error', () => { aborted = true; finish() })
    req.on('aborted', () => { aborted = true; finish() })
  })
}

// ── 过滤规则覆盖文件控制面（规格 §3/§4；计划 §3.3）─────────────────────────
// 固定路径端点：GET 读规则 / GET 读草稿 / POST 保存 / POST 预检 / POST 预览 /
// POST 回滚 / POST 写草稿 / DELETE 删草稿。写端点在全局 authorize 之前分流，且
// **只认 Authorization 头**（草稿 DELETE 同）：
//   · 全局闸接受 ?token=，POST 又不收 Cookie——直接复用会让「URL 带 token」与
//     「仅 Cookie」都落到同一条 401，无法给出规格要求的专属 code。
// 规则正文绝不进访问日志/审计：审计只记 action/revision/changedFields 与 prevHash 链。
const FILTER_BODY_MAX_BYTES = 64 * 1024
const FILTER_AUDIT_MAX_BYTES = 4 * 1024 * 1024
const FILTER_LOCK_STALE_MS = 10 * 1000
const FILTER_BACKUP_KEEP = 3
const FILTER_PREVIEW_SCAN_MAX = 5000
const FILTER_PREVIEW_SAMPLE_DEFAULT = 5
const FILTER_PREVIEW_SAMPLE_MAX = 20
const FILTER_PREVIEW_MAX_BYTES = 64 * 1024 * 1024
const FILTER_AUDIT_GENESIS = '0'.repeat(64)
// 草稿是「没点保存的整页规则」，与正式覆盖文件分开存；不参与备份/审计/锁。
const FILTER_DRAFT_SCHEMA = 1
const FILTER_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FILTER_DRAFT_FIELD_MAX_LEN = 4000
const FILTER_DRAFT_FIELD_SET = new Set(FilterStore.FILTER_RULE_FIELDS)
// 控制字符：允许 \t(09) \n(0A) \r(0D)，其余 C0 与 DEL 一律拒绝。
function hasFilterDraftControlChar (value) {
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 127) return true
  }
  return false
}
// 全命中字面量（trim 后等值）：与 xbk_filter_store 的 WIDE_MATCH_VALUES 同口径。
const FILTER_WIDE_MATCH = new Set(['.*', '^.*$'])
// 写端点固定路径白名单（无动态后缀；非白名单路径继续走全局 404/鉴权）。
const FILTER_WRITE_PATHS = new Set([
  '/api/config/filter',
  '/api/config/filter/validate',
  '/api/config/filter/preview',
  '/api/config/filter/restore',
  '/api/config/filter/draft'
])

function sha256Hex (text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// 惰性依赖：xbk_function_v3 顶层会 require got/re2，不能在 console 顶层加载。
// 首次过滤 API 调用时才取 RuleEngine（v3 导出的已绑定 compileRules/hasNestedQuantifier）、
// explainFilter/filterHash 与 Config；re2 可用性按「能否 require('re2')」判定，
// compileUserRegex 与 v3 内部同实现（new RE2 + 'i'，失败返回 null）。
let filterDepsOverride = null
let filterDepsCache = null
function runtimeFilterDeps () {
  if (filterDepsOverride) return filterDepsOverride
  if (filterDepsCache) return filterDepsCache
  let v3 = null
  try { v3 = require('../xbk_function_v3') } catch (e) { v3 = null }
  let RE2 = null
  try { RE2 = require('re2') } catch (e) { RE2 = null }
  const compileUserRegex = (source, flags = 'i') => {
    if (typeof source !== 'string' || !RE2) return null
    try { return new RE2(source, flags) } catch (e) { return null }
  }
  const ruleEngine = v3 && typeof v3.compileRules === 'function' && typeof v3.hasNestedQuantifier === 'function'
    ? {
        hasNestedQuantifier: v3.hasNestedQuantifier,
        compileRules: v3.compileRules,
        // 预览白名单与运行期同口径：先剥零宽字符再 test（缺导出时退化为原串）。
        _normalizeReInput: typeof v3._normalizeReInput === 'function' ? v3._normalizeReInput : undefined
      }
    : null
  filterDepsCache = {
    v3,
    config: v3 && v3.Config ? v3.Config : null,
    RuleEngine: ruleEngine,
    compileUserRegex,
    re2Available: Boolean(RE2),
    isRe2Available: () => Boolean(RE2),
    explainFilter: v3 && typeof v3.explainFilter === 'function' ? v3.explainFilter : null,
    filterHash: v3 && typeof v3.filterHash === 'function' ? v3.filterHash : null
  }
  return filterDepsCache
}

// 仅测试：注入确定性 deps（如 re2Available:false 验 503）；传 null 恢复真实惰性依赖。
function setFilterDepsForTests (deps) {
  filterDepsOverride = deps && typeof deps === 'object' ? deps : null
}

function filterValidationDeps (deps) {
  return {
    RuleEngine: deps && deps.RuleEngine,
    compileUserRegex: deps && deps.compileUserRegex,
    re2Available: deps && deps.re2Available === true,
    isRe2Available: deps && typeof deps.isRe2Available === 'function' ? deps.isRe2Available : undefined
  }
}

function filterEngineUnavailable (errors) {
  return Array.isArray(errors) && errors.some((e) => e && (e.code === 'engine_unavailable' || e.code === 'deps_invalid'))
}

// 写端点鉴权顺序（规格 §4.2）：
// ① URL 带 token → 400（即使同时带合法 Bearer 也拒绝，避免凭证进日志/历史）；
// ② Authorization: <scheme> <token> 合法 → 放行；
// ③ 仅会话 Cookie → 401 cookie_not_allowed（Cookie 不能用于写，CSRF 面）；
// ④ 其余 → 401 unauthorized。
function writeAuthVerdict (req, urlQuery, token) {
  if (urlQuery instanceof URLSearchParams && urlQuery.has('token')) {
    return { ok: false, status: 400, body: { error: 'query_token_not_allowed', code: 'query_token_not_allowed' } }
  }
  const header = req.headers && req.headers.authorization
  if (typeof header === 'string' && header.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX_LOWER) {
    const value = header.slice(BEARER_PREFIX.length)
    if (value.length > 0 && timingSafeEqualStr(value.trim(), token)) return { ok: true, actorToken: token }
  }
  const cookie = sessionCookieValue(req.headers && req.headers.cookie)
  if (cookie !== null && timingSafeEqualStr(cookie, token)) {
    return { ok: false, status: 401, body: { error: 'cookie_not_allowed', code: 'cookie_not_allowed' } }
  }
  return { ok: false, status: 401, body: { error: 'unauthorized', code: 'unauthorized' } }
}

// 媒体类型闸：只收 application/json（允许 ;charset=...），Content-Encoding 只允许 identity/缺省。
// 字符串前缀判定（用户输入不进正则）。
function filterMediaAllowed (req) {
  const rawType = req.headers && req.headers['content-type']
  const type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : ''
  const jsonType = type === 'application/json' || type.startsWith('application/json;')
  if (!jsonType) return false
  const rawEncoding = req.headers && req.headers['content-encoding']
  const encoding = typeof rawEncoding === 'string' ? rawEncoding.trim().toLowerCase() : ''
  return encoding === '' || encoding === 'identity'
}

function filterAuditCanonical (entry) {
  // 固定键序 + 只含白名单字段：审计行可复算、且不可能夹带规则正文/路径/token。
  return JSON.stringify({
    ts: entry.ts,
    actor: entry.actor,
    action: entry.action,
    revision: entry.revision,
    changedFields: entry.changedFields
  })
}

function filterAuditEntryHash (prevHash, entry) {
  return sha256Hex(`${prevHash}\n${filterAuditCanonical(entry)}`)
}

// 逐行重算审计链。brokenAt 为 1 基行号；坏 JSON / prevHash 断裂 / entryHash 不匹配
// 都算断链（可检测静默删除与篡改，但不声称能防 root）。
function readFilterAuditChain (auditPath) {
  // openNonBlocking：审计路径被替换成 FIFO 时立即判 unsafe，不阻塞 GET/save。
  const read = readSafeTextResult(auditPath, FILTER_AUDIT_MAX_BYTES, { openNonBlocking: true })
  if (read.status === 'missing') return { ok: true, entries: 0, brokenAt: null, lastHash: FILTER_AUDIT_GENESIS }
  if (read.status !== 'ok') return { ok: false, entries: 0, brokenAt: 0, lastHash: FILTER_AUDIT_GENESIS }
  const lines = read.text.split('\n')
  let lastHash = FILTER_AUDIT_GENESIS
  let entries = 0
  let brokenAt = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    entries++
    let entry
    try { entry = JSON.parse(line) } catch (e) { brokenAt = i + 1; break }
    const shapeOk = entry && typeof entry === 'object' && !Array.isArray(entry) &&
      typeof entry.ts === 'string' && typeof entry.actor === 'string' &&
      typeof entry.action === 'string' && Number.isSafeInteger(entry.revision) &&
      Array.isArray(entry.changedFields)
    if (!shapeOk || entry.prevHash !== lastHash || entry.entryHash !== filterAuditEntryHash(lastHash, entry)) {
      brokenAt = i + 1
      break
    }
    lastHash = entry.entryHash
  }
  return { ok: brokenAt === null, entries, brokenAt, lastHash }
}

// 审计文件达到上限（>4 MiB）后无法再安全续写：readFilterAuditChain 会把超限文件读成「不可读 ⇒
// genesis」，在其后按 genesis 续写会让整条链被判成断链。写入方必须先 stat 大小，超限即拒绝保存（507），
// 规则文件一个字节都不动，等人工归档后再继续。
function filterAuditAtLimit (auditPath) {
  try {
    const st = fs.lstatSync(auditPath)
    // symlink 不在这里判 507：统一交给 append 的 O_NOFOLLOW 失败路径（500 audit_failed），
    // 避免同一个链接因目标大小不同而报 507/500 两种结果。
    if (st.isSymbolicLink()) return false
    // 预留一行审计的宽度（entryHash 64 hex + 时间戳 + 字段名，实测 < 512B）：
    // 只判 size > MAX 会让「最后一次 append 恰好越界」，随后读取按 tooLarge 判假断链。
    return st.size + 1024 > FILTER_AUDIT_MAX_BYTES
  } catch (e) {
    return false // 不存在/不可 stat：交给 append 的真实失败路径（保存侧按审计失败回滚）
  }
}

// append-only + 0600：每次从头复算链尾（文件上限 4MiB，控制台写频率极低）。
// 打开时带 O_NOFOLLOW 且 fstat 必须是普通文件：预置的 symlink/FIFO/目录一律拒绝，否则
// 「fchmod + append」会顺着链接改写别的可写文件。失败返回 false，由调用方回滚规则文件并报
// 500 audit_failed——审计不落地就不能让调用方看到成功。
function appendFilterAudit ({ auditPath, actor, action, revision, changedFields }) {
  try {
    if (filterAuditAtLimit(auditPath)) {
      console.error('⚠️ 过滤规则审计已到 4 MiB 上限，拒绝续写（需人工归档后重试）')
      return false
    }
    const chain = readFilterAuditChain(auditPath)
    const prevHash = chain.lastHash || FILTER_AUDIT_GENESIS
    const entry = {
      ts: new Date().toISOString(),
      actor,
      action,
      revision,
      changedFields: Array.isArray(changedFields) ? changedFields.slice() : []
    }
    entry.prevHash = prevHash
    entry.entryHash = filterAuditEntryHash(prevHash, entry)
    const line = `${JSON.stringify(entry)}\n`
    // O_NOFOLLOW 在非 POSIX 平台可能缺省（undefined），按位或会把它当 0 从而丢掉整组 flag。
    // O_NONBLOCK：审计路径被预置成 FIFO 时 open 立即返回（ENXIO），而不是阻塞整个事件循环。
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
      (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
    const fd = fs.openSync(auditPath, flags, 0o600)
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('审计路径不是普通文件')
      fs.fchmodSync(fd, 0o600)
      fs.writeSync(fd, line)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (e) {
    console.error(`⚠️ 过滤规则审计写入失败：${e && e.message ? e.message : e}`)
    return false
  }
}

// 审计失败时把覆盖文件回滚为保存前内容：原本有文件（含损坏文件）就原子写回原文，
// 原本没有就删掉本次新建的文件——绝不留下「规则已生效但审计缺失」的状态。
function rollbackFilterOverride (paths, previousText) {
  // 有保存前原文：只尝试写回，失败就如实报 rolledBack:false，绝不删文件（删除会把
  // 「保存前规则」变成「代码默认」，是比留下旧规则更大的语义跳变）。
  if (typeof previousText === 'string') {
    try {
      if (writeAtomic(paths.file, previousText, '过滤规则覆盖文件（审计失败回滚）')) return { ok: true, mode: 'restored' }
    } catch (e) { /* 落到下面如实上报 */ }
    return { ok: false, mode: 'restore_failed' }
  }
  // 原本没有覆盖文件（本次新建）：删掉才回到保存前状态。
  try {
    fs.unlinkSync(paths.file)
    return { ok: true, mode: 'removed' }
  } catch (e) {
    return { ok: false, mode: 'remove_failed' }
  }
}

// 字段级 diff：只报字段名（顺序与 FILTER_RULE_FIELDS 一致），值绝不入响应/日志。
function diffFilterFields (before, after) {
  const out = []
  const prev = before && typeof before === 'object' ? before : {}
  const next = after && typeof after === 'object' ? after : {}
  for (const field of FilterStore.FILTER_RULE_FIELDS) {
    const a = typeof prev[field] === 'string' ? prev[field] : ''
    const b = typeof next[field] === 'string' ? next[field] : ''
    if (a !== b) out.push(field)
  }
  return out
}

// GET 的 wideMatch 提示：与 store 的确认口径一致（单行 = 整值 trim；多行 = 任一行 trim）。
function wideMatchFields (filter) {
  const out = []
  const src = filter && typeof filter === 'object' ? filter : {}
  for (const field of FilterStore.FILTER_RULE_FIELDS) {
    if (field === 'pingbitime') continue
    const value = src[field]
    if (typeof value !== 'string' || value === '') continue
    if (!value.includes('###')) {
      if (FILTER_WIDE_MATCH.has(value.trim())) out.push(field)
      continue
    }
    const lines = value.split(/<br\s*\/?>|\r\n|\r|\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // 多行规则的判定值在 ### 之后（与 RuleEngine._parseLine 的 val 同口径）。
      const val = trimmed.includes('###') ? trimmed.split('###')[1].trim() : trimmed
      if (FILTER_WIDE_MATCH.has(val)) { out.push(field); break }
    }
  }
  return out
}

function filterHashOf (deps, filter, keyword) {
  const zkt = keyword && typeof keyword.zkt_gjc === 'string' ? keyword.zkt_gjc : ''
  try {
    if (deps && typeof deps.filterHash === 'function') {
      const hash = deps.filterHash(filter, zkt)
      if (typeof hash === 'string' && hash.length > 0) return hash
    }
  } catch (e) { /* 回退 sha256（deps 注入/Config 异常时仍给出稳定摘要） */ }
  return sha256Hex(JSON.stringify(filter))
}

function actorOf (token) {
  return sha256Hex(typeof token === 'string' ? token : '').slice(0, 8)
}

// 预览用的 zkt_gjc 白名单编译：与运行期 App.run 同口径——非字符串/空串/纯空白/嵌套量词/非法
// 正则一律「不启用白名单」（宁可多算补推，也不虚报少推）。返回 null 表示本次未应用（zktApplied:false）。
function previewWhitelistRegex (deps, keyword) {
  const kw = keyword && typeof keyword.zkt_gjc === 'string' ? keyword.zkt_gjc : null
  if (kw === null || kw === '' || kw.trim() === '') return null
  if (!deps || typeof deps.compileUserRegex !== 'function') return null
  if (deps.RuleEngine && typeof deps.RuleEngine.hasNestedQuantifier === 'function' && deps.RuleEngine.hasNestedQuantifier(kw)) return null
  try {
    return deps.compileUserRegex(kw, 'i')
  } catch (e) {
    return null
  }
}

// 白名单放行判定（对齐 FilterEngine.whitelistFilter 的 title 口径）：标题 undefined/null/空串
// 视为放行（运行期同款「字段缺失不拦截」），其余按正则匹配；任何异常按放行处理（宁可多算）。
function previewWhitelistKeeps (entry, regex, normalize) {
  if (!regex) return true
  const raw = entry && entry.title !== undefined ? entry.title : undefined
  if (raw === undefined || raw === null || raw === '') return true
  let subject = typeof raw === 'string' ? raw : String(raw)
  // 与运行期 FilterEngine.whitelistFilter 同口径：test 前先剥零宽字符（\u200B-\u200D\uFEFF）。
  if (typeof normalize === 'function') {
    try { subject = normalize(subject) } catch (e) { /* 归一失败按原串（宁可多算补推） */ }
  }
  try {
    return regex.test(subject)
  } catch (e) {
    return true
  }
}

// 锁文件身份快照：陈旧判定用 mtimeMs，接管后的归属核验用 dev+ino（bigint，避免大 inode 丢精度）。
// lstat 不跟随链接：锁文件本身必须是它自己，不是指向别处的链接。
function filterLockIdentity (lockPath) {
  const st = fs.lstatSync(lockPath, { bigint: true })
  return { dev: st.dev, ino: st.ino, mtimeMs: Number(st.mtimeMs) }
}

// 读锁文件里的持有者 pid（写失败/不可解析 ⇒ null，按孤儿锁处理）。
function filterLockHolderPid (lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const data = JSON.parse(raw)
    return Number.isSafeInteger(data && data.pid) && data.pid > 0 ? data.pid : null
  } catch (e) {
    return null
  }
}

// pid 是否活着：EPERM 说明进程存在但无权限探测 ⇒ 视为活。
function isProcessAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

// 接管一把「已判定过期」的锁。互斥不靠 rename（把活锁搬走会让原持有者失去互斥），
// 而是用一个 O_EXCL 的 takeover 标记把接管串行化：只有建标记成功的人能进临界区，
// 进区后重新 stat 锁文件，dev/ino/mtime 与判定时一致才 unlink（期间被别人释放/重建就放弃）。
// 标记本身带 mtime 兜底：持有标记的进程崩溃后，STALE 之后可被下一个接管者清掉。
function claimStaleFilterLock (lockPath, judged) {
  const marker = `${lockPath}.takeover`
  let fd
  try {
    fd = fs.openSync(marker, 'wx', 0o600)
  } catch (e) {
    // 标记被占：可能是并发接管（放弃本轮，回 409）或上次崩溃的残留（过期即清）。
    try {
      if (Date.now() - fs.lstatSync(marker).mtimeMs > FILTER_LOCK_STALE_MS) fs.unlinkSync(marker)
    } catch (e2) { /* 已消失/无法判定：保持 fail-closed */ }
    return false
  }
  try {
    let now
    try { now = filterLockIdentity(lockPath) } catch (e) { return false } // 已被释放
    if (now.dev !== judged.dev || now.ino !== judged.ino || now.mtimeMs !== judged.mtimeMs) return false
    try { fs.unlinkSync(lockPath) } catch (e) { return false }
    return true
  } finally {
    try { fs.closeSync(fd) } catch (e) { /* 已关闭 */ }
    try { fs.unlinkSync(marker) } catch (e) { /* 已被清理 */ }
  }
}

// 锁：O_EXCL + 0600；EEXIST 时按 mtime 判陈旧（>10s 才尝试接管），否则让调用方回 409。
// 锁内容带随机 token，释放时校验，避免陈旧接管后误删别人的锁。
function acquireFilterLock (cacheDir) {
  const lockPath = FilterStore.filterRulesPaths(cacheDir).lock
  const token = crypto.randomBytes(12).toString('hex')
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null
      let judged
      try {
        judged = filterLockIdentity(lockPath)
      } catch (e2) {
        if (e2 && e2.code === 'ENOENT') continue // 刚被释放：重试一次
        return null
      }
      if (!(Date.now() - judged.mtimeMs > FILTER_LOCK_STALE_MS)) return null
      // 持有者还活着就绝不接管（mtime 过期只说明写得久，不代表进程死了）：
      // 搬走活锁会让原持有者失去互斥，两人同时进写段。孤儿锁（pid 不可解析/进程已死）才允许接管。
      const holderPid = filterLockHolderPid(lockPath)
      if (holderPid !== null && isProcessAlive(holderPid)) return null
      // 无论接管成败都进入下一轮重判：成功 ⇒ open 自己的锁；失败（别人先抢到/锁已释放）⇒
      // 看到别人的新锁后放弃、或直接 open 成功。
      claimStaleFilterLock(lockPath, judged)
      continue
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }))
      fs.fchmodSync(fd, 0o600)
      fs.closeSync(fd)
    } catch (e) {
      // 写入/授权/关闭失败：自己刚创建的锁文件必须清掉，否则后续 10s 内全是假 write_busy。
      // closeSync 之后抛错时 fd 可能已关闭——重复 close 的 EBADF 直接吞掉，不影响清理。
      try { fs.closeSync(fd) } catch (e2) { /* 已关闭 */ }
      try { fs.unlinkSync(lockPath) } catch (e3) { /* 已被清理 */ }
      return null
    }
    return { path: lockPath, token }
  }
  return null
}

function releaseFilterLock (lock) {
  if (!lock || typeof lock.path !== 'string') return
  try {
    const text = fs.readFileSync(lock.path, 'utf8')
    if (!text.includes(lock.token)) return // 已被陈旧接管：绝不删别人的锁
    fs.unlinkSync(lock.path)
  } catch (e) { /* 锁已释放/被接管：幂等 */ }
}

// 备份只保留最近 FILTER_BACKUP_KEEP 代（按 revision 数值降序）。
// 注意调用时机：必须在新的覆盖文件提交成功**之后**才剪枝——失败的保存不该剪掉最老备份。
function pruneFilterBackups (paths) {
  let names
  try { names = fs.readdirSync(path.dirname(paths.file)) } catch (e) { return }
  const revisions = []
  for (const name of names) {
    const prefix = 'filter-rules.bak.'
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
    const raw = name.slice(prefix.length, -'.json'.length)
    if (!/^\d+$/.test(raw)) continue
    const rev = Number(raw)
    if (Number.isSafeInteger(rev) && rev >= 0) revisions.push(rev)
  }
  revisions.sort((a, b) => b - a)
  for (const rev of revisions.slice(FILTER_BACKUP_KEEP)) {
    try { fs.unlinkSync(paths.backupFor(rev)) } catch (e) { /* 已被清理 */ }
  }
}

// 只写备份、返回是否成功（不剪枝：剪枝由调用方在提交后执行）。
// 返回 false 时调用方必须放弃本次保存——备份是回滚的唯一来源，不能「备份失败也照写」。
function backupFilterFile (paths, revision, text) {
  if (typeof text !== 'string' || text === '') return false
  try {
    return writeAtomic(paths.backupFor(revision), text, '过滤规则备份') === true
  } catch (e) {
    return false
  }
}

// 备份文件的结构读取（字段白名单/正则合法性仍交给 validateFilterRules）。
function parseFilterFile (text) {
  let data
  try { data = JSON.parse(text) } catch (e) { return { ok: false, message: '不是合法 JSON' } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, message: '根节点必须是对象' }
  if (data.schema !== FilterStore.FILTER_RULES_SCHEMA) return { ok: false, message: 'schema 不匹配' }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) return { ok: false, message: 'revision 必须是非负整数' }
  if (!data.filter || typeof data.filter !== 'object' || Array.isArray(data.filter)) return { ok: false, message: 'filter 必须是对象' }
  return { ok: true, revision: data.revision, filter: data.filter }
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

// 推送记录时间窗过滤（v3.307）：按条目的 datetime（生产写入的上海本地时间）前缀比较，
// 不解析时分秒——页面只提供「今天/近 N 天」粗粒度，日期边界由字符串前缀天然满足。
// datetime 缺失/非法的条目在时间窗模式下不展示（无法证明它属于窗口，不猜）。
function filterMessagesByDays (items, days, now = Date.now()) {
  if (!(Number.isSafeInteger(days) && days > 0)) return items
  const offsetMs = 8 * 3600 * 1000
  const todayKey = new Date(now + offsetMs).toISOString().slice(0, 10)
  const startKey = new Date(now - (days - 1) * 86400000 + offsetMs).toISOString().slice(0, 10)
  return items.filter((m) => {
    if (typeof m.datetime !== 'string' || m.datetime.length < 10) return false
    const day = m.datetime.slice(0, 10)
    return day >= startKey && day <= todayKey
  })
}

// 自定义日期区间（v3.326）：from/to 为上海日历日 YYYY-MM-DD，闭区间，前缀比较与 days 同口径。
// 非法格式/不存在的日期/颠倒区间一律忽略（宽松输入，与 days 越界回「全部」同一哲学，不 400）。
// 正则无嵌套量词、定长锚定，无 ReDoS 面（本仓正则红线）。
function parseDayKey (v) {
  if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return ''
  const t = new Date(v + 'T00:00:00Z')
  // 回环校验：2026-02-30 会被 Date 归一化成 03-02，必须与输入不等即拒。
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== v) return ''
  return v
}

function filterMessagesByRange (items, from, to) {
  if (from === '' || to === '' || from > to) return items
  return items.filter((m) => {
    if (typeof m.datetime !== 'string' || m.datetime.length < 10) return false
    const day = m.datetime.slice(0, 10)
    // 存储里的畸形前缀（如 2026-02-30）在字典序上会落进区间，必须先回环校验是真日期
    // 再比较（与 parseDayKey 同口径，Sourcery #288 M4）。
    if (day < from || day > to) return false
    return parseDayKey(day) === day
  })
}

// 时间窗统一入口：区间优先于「近 N 天」（两者同时出现时以区间为准，days 视作 0）。
// 返回 { items, days, from, to } —— days/from/to 三个回显字段由调用方原样下发。
function windowMessages (items, { days, fromKey, toKey }) {
  // 显式区间：合法就按闭区间；非法/颠倒一律按「无窗口」返回全量，不回落到 days——
  // 否则调用方以为在看区间，实际拿到的是「最近 N 天」子集（Sourcery #288 M3）。
  if (fromKey !== '' || toKey !== '') {
    if (fromKey !== '' && toKey !== '' && fromKey <= toKey) {
      return { items: filterMessagesByRange(items, fromKey, toKey), days: 0, from: fromKey, to: toKey }
    }
    return { items, days: 0, from: '', to: '' }
  }
  return { items: days > 0 ? filterMessagesByDays(items, days) : items, days, from: '', to: '' }
}

// 分类计数（v3.307）：时间窗筛选后分类下拉的计数必须跟随窗口，否则「今天」里会显示
// 全量 83 个分类的条数，看起来像筛选没生效。无窗口时仍用 readMessages 的预聚合结果。
function messageCategoriesOf (items) {
  const counts = new Map()
  for (const m of items) {
    const name = typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)'
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
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
  // run-auto 只给服务器调度器内部用：HTTP 侧没有稳定幂等键，窗外的重试会重复真实推送。
  if (v === 'run-auto') return null
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
// 控制台读端 64MiB，D2-N11：两者同值，介于 32–64MiB 的合法缓存不再被误报「过大不可读」），
// nearTrim/overLimit/consoleReadable 三位预警 + 墓碑计数。
// 条数在 cacheHealthEntryCount 里读，但先过 CACHE_HEALTH_COUNT_MAX_BYTES 闸（超闸报
// tooLarge，不整读）——整读大文件会与轮询抢盘。
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

// 缓存健康页的条目数（D2-S11/D2-S12）：先 stat，超阈值不整读；否则复用 readMessages 缓存。
function cacheHealthEntryCount (stateDir, messagesFile) {
  const meta = statSafeMeta(path.join(stateDir, messagesFile))
  if (meta.status !== 'ok') return { status: meta.status, count: null, filteredCount: null }
  if (meta.size > CACHE_HEALTH_COUNT_MAX_BYTES) return { status: 'tooLarge', count: null, filteredCount: null }
  return readMessageCount(stateDir, { filename: messagesFile, maxBytes: MESSAGES_MAX_BYTES })
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
  if (name === CONSOLE_SETTINGS_FILE) return 'console'
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

// 最终保险丝（D2-S13）：递归扫描响应里的键名，任一键名含 token/key/secret/password 且值
// 是非空字符串即视为泄漏形态（白名单结构最深 4 层，深度上限 6 足够且防环）。返回命中的键名，
// 空串表示干净。纯函数（导出给单测：这段防线必须可被执行到，而不是不可达的死代码）。
const SECRET_KEY_RE = /token|key|secret|password|passwd/i
function findSecretLikeField (value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return ''
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) return k
    if (v && typeof v === 'object') {
      const hit = findSecretLikeField(v, depth + 1)
      if (hit) return hit
    }
  }
  return ''
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
  // 运行历史目录（审查 #241 S1）：run.log 的写入方是运行侧 MessageStore.cacheDir，而控制台
  // stateDir 可能因配置/注入与之不同。读取历史、spawn 子进程（决定它把 run.log 写哪）、
  // 停止留痕三处必须同源，否则 Config.cache.dir 漂移时 cron 轮次从历史里消失（无提示）。
  // 运行产物目录：显式 runHistoryDir（测试/嵌入）> 调用方注入的 stateDir。
  // 生产 main 传入的 stateDir 就是 consoleStateDir()（与运行侧 MessageStore.cacheDir 同源），
  // 因此这里不能再优先全局 runtimeCacheDir——嵌入式实例传了隔离 stateDir 时会被绕过，
  // 读状态用 A、跑子进程写 B（Sourcery 注入目录被忽略）。
  const historyDir = () => {
    return runHistoryDir || stateDir
  }
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
  // 窗口长度（D2-S16）：旧口径 PROC_TIMEOUT_MS + 2min ≈ 12min —— 首轮早已结束、锁也
  // 释放了，人工重跑仍被当成「重复提交」拦 12 分钟，文案还说「已有任务在运行」（假话）。
  // 防的是「202 响应丢失后的自动重试」，60s 足够覆盖；超窗即视为新的手动触发。
  const REPLAY_WINDOW_MS = 60 * 1000
  const lastAccept = new Map()
  // ── v3.340 通知自检拦截窗：运行期设置（配置页在线改，保存后下一次判定就生效）──────
  // 落盘 <stateDir>/console-settings.json（writeAtomic，0600 原子写）。读盘语义：
  //   缺文件 = 默认 60；损坏 / 字段非法 = 默认 60 + console.error 告警（不阻断启动）。
  // settingsSource 只进读面，让前端如实区分「值来自文件」与「还在用默认值」。
  const settingsPath = path.join(stateDir, CONSOLE_SETTINGS_FILE)
  const runtimeSettings = {
    revision: 0,
    updatedAt: 0,
    notifyTestReplayWindowS: CONSOLE_SETTINGS_DEFAULT_S,
    // v3.342：顶栏「数据截至」是否带年月日（只影响显示，不影响任何判定）。
    syncShowDate: true
  }
  let settingsSource = 'default'
  const loadStoredSettings = () => {
    // openNonBlocking：设置文件被换成 FIFO 时裸 O_RDONLY 会永久阻塞（createConsole 卡在 listen
    // 之前，整个控制台起不来）。与 audit/tombstone 两条读面同口径：非普通文件按 unsafe 回默认。
    const read = readSafeTextResult(settingsPath, CONSOLE_SETTINGS_MAX_BYTES, { openNonBlocking: true })
    if (read.status === 'missing') return
    if (read.status !== 'ok') {
      console.error(`⚠️ 控制台设置读取失败（${read.status}），按默认值运行：notifyTestReplayWindowS=${CONSOLE_SETTINGS_DEFAULT_S}`)
      return
    }
    let raw
    try {
      raw = JSON.parse(read.text)
    } catch (e) {
      console.error(`⚠️ 控制台设置不是合法 JSON，按默认值运行：${e && e.message ? e.message : e}`)
      return
    }
    const valid = raw && typeof raw === 'object' && !Array.isArray(raw) &&
      Number.isInteger(raw.notifyTestReplayWindowS) &&
      raw.notifyTestReplayWindowS >= NOTIFY_REPLAY_MIN_S && raw.notifyTestReplayWindowS <= NOTIFY_REPLAY_MAX_S &&
      // v3.340 的旧文件没有这个字段：允许缺省（按默认 true），但写了就必须是布尔。
      (raw.syncShowDate === undefined || typeof raw.syncShowDate === 'boolean') &&
      // 必须是「安全整数」且留出 +1 余量：超过 MAX_SAFE_INTEGER 时 +1 不再改变数值，
      // 乐观锁会永远放行同一份 revision（Sourcery #303 M2）。
      Number.isSafeInteger(raw.revision) && raw.revision >= 0 && raw.revision < Number.MAX_SAFE_INTEGER &&
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    if (!valid) {
      console.error(`⚠️ 控制台设置字段非法，按默认值运行：notifyTestReplayWindowS=${CONSOLE_SETTINGS_DEFAULT_S}、syncShowDate=true（${CONSOLE_SETTINGS_FILE}）`)
      return
    }
    runtimeSettings.revision = raw.revision
    runtimeSettings.updatedAt = raw.updatedAt
    runtimeSettings.notifyTestReplayWindowS = raw.notifyTestReplayWindowS
    if (typeof raw.syncShowDate === 'boolean') runtimeSettings.syncShowDate = raw.syncShowDate
    settingsSource = 'file'
  }
  loadStoredSettings()
  // 生效窗（毫秒）：每次判定现取 —— 保存后无需重启，下一次触发就用新值。
  const notifyReplayWindowMs = () => runtimeSettings.notifyTestReplayWindowS * 1000
  // 进程启动时刻（/api/sys 展示「已运行」用）：createConsole 被调用的瞬间。
  const startedAtMs = Date.now()

  // ── 服务器端自动正式运行 ──────────────────────────────────────────────────
  // 调度器常驻控制台进程：不依赖浏览器页面，关页/切后台/锁屏都不影响。
  // 持久化只存 {on, interval}：进程重启后若 on=true 会继续；点「停止」才落盘关闭。
  const autoPath = path.join(stateDir, AUTO_STATE_FILE)
  const auto = {
    on: false,
    interval: AUTO_DEFAULT_S,
    startedAt: 0,
    nextAt: 0,
    runs: 0,
    fails: 0,
    lastError: '',
    lastRunId: null
  }
  try {
    const raw = JSON.parse(fs.readFileSync(autoPath, 'utf8'))
    if (raw && typeof raw === 'object') {
      if (raw.on === true) auto.on = true
      if (raw.interval !== undefined) auto.interval = clampAutoSeconds(raw.interval)
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      console.error(`⚠️ 自动运行状态读取失败，按停止处理：${e && e.message ? e.message : e}`)
    }
  }
  let autoTimer = null
  let autoWaitTimer = null
  let autoInFlightId = null

  const autoSnapshot = () => ({
    on: auto.on,
    interval: auto.interval,
    startedAt: auto.startedAt,
    nextAt: auto.nextAt,
    runs: auto.runs,
    fails: auto.fails,
    lastError: auto.lastError,
    lastRunId: auto.lastRunId
  })
  const persistAuto = () => {
    try {
      fs.writeFileSync(autoPath, JSON.stringify({ on: auto.on, interval: auto.interval, updatedAt: Date.now() }))
    } catch (e) {
      console.error(`⚠️ 自动运行状态落盘失败（进程内仍生效）：${e && e.message ? e.message : e}`)
    }
  }
  const clearAutoTimer = () => {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
  }
  const disposeAuto = () => {
    clearAutoTimer()
    if (autoWaitTimer) { clearInterval(autoWaitTimer); autoWaitTimer = null }
  }
  function stopAuto (reason = '') {
    clearAutoTimer()
    auto.on = false
    auto.nextAt = 0
    auto.lastError = reason
    persistAuto()
  }
  function scheduleAuto (delayMs) {
    clearAutoTimer()
    if (!auto.on || shuttingDown) return
    auto.nextAt = Date.now() + delayMs
    autoTimer = setTimeout(() => {
      autoTimer = null
      auto.nextAt = 0
      tickAuto()
    }, delayMs)
    if (typeof autoTimer.unref === 'function') autoTimer.unref()
  }
  function tickAuto () {
    if (!auto.on || shuttingDown) return
    // 手动/上一次自动运行还没结束：不叠跑，按间隔再试。
    if (autoInFlightId || activeChildren.size > 0) {
      scheduleAuto(auto.interval * 1000)
      return
    }
    const now = Date.now()
    const runToken = crypto.randomBytes(12).toString('hex')
    if (!acquireLock(stateDir, now, runToken)) {
      // 青龙/另一控制台实例持锁：不抢跑，也不计失败。
      scheduleAuto(auto.interval * 1000)
      return
    }
    let record
    try {
      record = startAction('run-auto', now, activeChildren, historyDir(), runToken, stateDir)
    } catch (e) {
      releaseLockFor({ _stateDir: stateDir, _lockToken: runToken })
      auto.fails += 1
      auto.lastError = `启动失败：${e && e.message ? e.message : e}`
      if (auto.fails >= AUTO_MAX_FAILS) stopAuto(`连续 ${AUTO_MAX_FAILS} 次启动失败，已停止`)
      else scheduleAuto(auto.interval * 1000)
      return
    }
    record._lockAt = now
    autoInFlightId = record.id
    auto.runs += 1
    auto.lastRunId = record.id
    auto.nextAt = 0
    autoWaitTimer = setInterval(() => {
      if (!record.finishedAt) return
      clearInterval(autoWaitTimer)
      autoWaitTimer = null
      if (autoInFlightId !== record.id) return
      autoInFlightId = null
      const failed = record.exitCode !== 0 || record.timedOut || record.cancelled
      if (failed) {
        auto.fails += 1
        auto.lastError = `最近一轮失败（exit ${record.exitCode}）`
        if (auto.fails >= AUTO_MAX_FAILS) {
          stopAuto(`连续 ${AUTO_MAX_FAILS} 轮失败，已停止`)
          return
        }
      } else {
        auto.fails = 0
        auto.lastError = ''
      }
      if (auto.on) scheduleAuto(auto.interval * 1000)
    }, 250)
    if (typeof autoWaitTimer.unref === 'function') autoWaitTimer.unref()
  }
  if (auto.on) {
    auto.startedAt = Date.now()
    scheduleAuto(auto.interval * 1000)
  }
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
    } else if (record.closedAt && !conn.paused) {
      // 完结且增量发完 → done + res.end()（蓝图 done 条件②；①淘汰在上分支）。
      // 用 closedAt 而不是 finishedAt：exit 先到、stdio 还在 drain 时不能发 done，
      // 否则 close 前最后一段输出无处可去（Sourcery SSE 尾段丢失）。
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
        // 审查 D2-M1（#225）：ownerToken 不能整个进程复用——前驱运行的 close 迟到时，
        // 会把后继运行的活锁误认成「自己的」并覆写成 released，第三个触发随即接管，
        // 造成两个真实推送并发。每次受理生成独立锁 token；归属判定 pid+token 双匹配。
        const runToken = crypto.randomBytes(12).toString('hex')
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
        // v3.340：窗长只算一次——自检取运行期设置（配置页可改，0 = 关闭拦截），
        // 其余动作仍用 REPLAY_WINDOW_MS。replayWindowS 是同一口径的秒数，进 409 响应体
        // 让前端提示「N 秒内无需重复」时不必再写死 60。
        const windowMs = action === 'notify-test' ? notifyReplayWindowMs() : REPLAY_WINDOW_MS
        // 必须从 windowMs 派生（而不是再读一次设置）：否则窗长算错时 409 仍会回带一个
        // 「看起来对」的秒数，把矛盾藏起来（retryAfterS 与 replayWindowS 会自相矛盾）。
        const replayWindowS = Math.round(windowMs / 1000)
        if (!acquireLock(stateDir, now, runToken)) {
          // readLastAccept 返回 [key, value] 数组（非 Map），用 find 取当前动作记录。
          const persistedPre = readLastAccept(lastAcceptPath)
          const prevPrePair = persistedPre.find(([k]) => k === action)
          const prevPre = prevPrePair ? prevPrePair[1] : lastAccept.get(action)
          // 窗口为 0 = 明确关闭拦截；时钟回拨（now < prev.at）时差值变成负数，若照常比较会
          // 把小负数也判成「还在窗内」，用户要等时钟追上来才能再触发——所以两个条件都要显式排除。
          if (prevPre && windowMs > 0 && now >= prevPre.at && now - prevPre.at < windowMs) {
            const rid = prevPre.runId
            const remainS = Math.max(1, Math.ceil((windowMs - (now - prevPre.at)) / 1000))
            sendJson(res, 409, { error: `重复提交已拦截（该动作刚受理过，${remainS} 秒后可重试）`, runId: (typeof rid === 'string' && rid.includes('.')) ? rid : undefined, replayBlocked: true, retryAfterS: remainS, replayWindowS })
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
        // notify-test 窗取自运行期设置（默认 60s，配置页可改 0–3600s）、其余动作 60s
        // （D2-S16：普通动作不再用 12min——那只拦得到人工重跑，拦不到
        // 真正的重复提交；运行中互斥由单飞锁负责）。/trigger 的 action=notify-test 与独立
        // 端点共享同一 lastAccept 键与窗长（有意行为）。run-auto 不接受 HTTP 触发。
        const winMs = windowMs
        if (prev && winMs > 0 && now >= prev.at && now - prev.at < winMs) {
          // runId = epoch.seq 字符串（v3.299 评审）：0 是 pending 帧哨兵（数字），
          // 真实 runId 只在 startAction 之后落盘——用「数字 0」判 pending，其余原样下发。
          const rid = prev.runId
          // D2-N3：这一处此前丢弃 releaseLockFor 的返回值，锁释放失败无人知晓（另两处
          // 同款分支都有响亮告警）。统一成同款文案。
          const replayReleasedOk = releaseLockFor({ _stateDir: stateDir, _lockToken: runToken })
          if (!replayReleasedOk) console.error(`⚠️ 触发锁释放失败（stateDir=${stateDir}，重放拦截分支）：锁将保留到陈旧接管（约 10 分钟），期间触发 409 属预期。`)
          const remainS = Math.max(1, Math.ceil((winMs - (now - prev.at)) / 1000))
          sendJson(res, 409, { error: `重复提交已拦截（该动作刚受理过，${remainS} 秒后可重试）`, runId: (typeof rid === 'string' && rid.includes('.')) ? rid : undefined, replayBlocked: true, retryAfterS: remainS, replayWindowS })
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
          const releasedOk = releaseLockFor({ _stateDir: stateDir, _lockToken: runToken })
          if (!releasedOk) console.error(`⚠️ 触发锁释放失败（stateDir=${stateDir}）：磁盘/权限异常仍未恢复，锁将保留到陈旧接管（约 10 分钟）。后续触发 409 属预期。`)
          lastAccept.delete(action)
          sendJson(res, 500, { error: '重放记录持久化失败，动作未执行（fail-closed）' })
          return
        }
        let record
        try {
          record = startAction(action, now, activeChildren, historyDir(), runToken, stateDir)
        } catch (e) {
          // startAction 同步抛（spawn 资源极端，Sourcery Medium）：回滚重放帧与锁，
          // 让用户可重试，而不是被卡到陈旧接管。恢复 pending 前值语义同落盘失败分支。
          lastAccept.delete(action)
          // 关键：pending 帧已落盘（runId=0），只删内存会让下一次请求重读旧帧 → 整个
          // 重放窗都 409「重复提交」，但实际没有子进程跑过。这里把删除后的 Map 重新落盘；
          // 落盘失败只能告警（内存已回滚，本进程内可重试，重启后可能重现 409）。
          try {
            fs.writeFileSync(lastAcceptPath, JSON.stringify(Object.fromEntries(lastAccept)))
          } catch (persistErr) {
            console.error(`⚠️ ${action} 启动失败后清理重放帧失败：${persistErr && persistErr.message ? persistErr.message : persistErr}`)
          }
          const releasedOk = releaseLockFor({ _stateDir: stateDir, _lockToken: runToken })
          if (!releasedOk) console.error(`⚠️ 触发锁释放失败（stateDir=${stateDir}）：锁将保留到陈旧接管（约 10 分钟）。`)
          console.error(`⚠️ ${action} 启动失败（spawn）：${e && e.message ? e.message : e}`)
          sendJson(res, 500, { error: '动作启动失败，已回滚，可稍后重试' })
          return
        }
        record._lockAt = now
        lastAccept.set(action, { at: now, runId: record.id })
        try {
          fs.writeFileSync(lastAcceptPath, JSON.stringify(Object.fromEntries(lastAccept)))
        } catch (e) { /* 二次落盘失败：pending 帧已持久化（runId=0），重试仍被窗口拦截 */ }
        sendJson(res, 202, { id: record.id, action, label: record.label })
      })
      .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
  }

  // ── 过滤规则控制面（规格 §3/§4；计划 §3.3）──────────────────────────────
  // 代码默认层（Config.filter / Config.keyword）只读：惰性 require，取不到时退化为空对象。
  const filterDefaults = () => {
    const deps = runtimeFilterDeps()
    const cfg = deps.config && typeof deps.config === 'object' ? deps.config : {}
    return {
      filter: cfg.filter && typeof cfg.filter === 'object' ? cfg.filter : {},
      keyword: cfg.keyword && typeof cfg.keyword === 'object' ? cfg.keyword : {}
    }
  }

  const loadCurrentFilter = () => {
    const defaults = filterDefaults()
    // 与 App.run 同口径传 deps：手工编辑的覆盖文件若含编译不了的规则，GET 必须报 corrupt
    // （否则页面全绿、运行侧却在降级，A1 承诺的红条永远不出现）。
    return FilterStore.loadFilterRules({
      cacheDir: stateDir,
      defaults: defaults.filter,
      keyword: defaults.keyword,
      deps: filterValidationDeps(runtimeFilterDeps())
    })
  }

  const sendFilterValidation = (res, errors, code = 'validation_failed') => {
    sendJson(res, 400, {
      ok: false,
      error: 'validation_failed',
      code,
      errors: Array.isArray(errors) ? errors : []
    })
  }

  // 请求体：415/413 在鉴权之后、解析之前；aborted 与解析失败都收敛成 400 validation_failed。
  const readFilterJson = (req) => {
    return readBody(req, FILTER_BODY_MAX_BYTES).then(({ body, over, aborted }) => {
      if (over) return { error: { status: 413, body: { error: 'body_too_large', code: 'body_too_large' } } }
      if (aborted) {
        return { error: { status: 400, body: { error: 'validation_failed', code: 'validation_failed', errors: [{ field: 'body', code: 'aborted', message: '请求体不完整' }] } } }
      }
      if (Buffer.byteLength(body, 'utf8') > FILTER_BODY_MAX_BYTES) {
        return { error: { status: 413, body: { error: 'body_too_large', code: 'body_too_large' } } }
      }
      let value
      try {
        value = JSON.parse(body)
      } catch (e) {
        return { error: { status: 400, body: { error: 'validation_failed', code: 'validation_failed', errors: [{ field: 'body', code: 'invalid_json', message: '请求体不是合法 JSON' }] } } }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: { status: 400, body: { error: 'validation_failed', code: 'validation_failed', errors: [{ field: 'body', code: 'invalid_body', message: '请求体必须是对象' }] } } }
      }
      return { value }
    })
  }

  const validateCandidate = (deps, candidate) => {
    return FilterStore.validateFilterRules(
      { schema: candidate && candidate.schema, filter: candidate && candidate.filter },
      filterValidationDeps(deps)
    )
  }

  const wideConfirmErrors = (wideMatch) => {
    return wideMatch.map((field) => ({
      field,
      code: 'wide_match_confirm_required',
      message: `字段「${field}」是 .* 全命中规则，需 confirmWideMatch:true 二次确认`
    }))
  }

  const respondValidationFailure = (res, result) => {
    if (filterEngineUnavailable(result.errors)) {
      sendJson(res, 503, { error: 'engine_unavailable', code: 'engine_unavailable' })
      return
    }
    sendFilterValidation(res, result.errors)
  }

  // ── 过滤规则草稿（服务器侧兜底）──────────────────────────────────────────
  // 草稿只存 11 个字段的原文，不做正则编译：用户打到一半的 `(` 也要能存下来。
  // 与正式覆盖文件分开：不取过滤锁、不进备份/审计，正式保存成功后才删。
  const filterDraftPaths = () => FilterStore.filterRulesPaths(stateDir)
  const clearFilterDraftFile = () => {
    const paths = filterDraftPaths()
    try {
      fs.unlinkSync(paths.draft)
      return true
    } catch (e) {
      return e && e.code === 'ENOENT'
    }
  }
  const currentFilterRevision = () => {
    const loaded = loadCurrentFilter()
    return loaded.source === 'corrupt' ? 0 : loaded.revision
  }
  const normalizeFilterDraft = (raw) => {
    const errors = []
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: [{ field: 'filter', code: 'invalid_filter', message: 'filter 必须是对象' }] }
    }
    let keys
    try { keys = Object.keys(raw) } catch (e) { keys = null }
    if (keys === null) {
      return { ok: false, errors: [{ field: 'filter', code: 'invalid_filter', message: 'filter 不是可枚举对象' }] }
    }
    for (const field of keys) {
      if (!FILTER_DRAFT_FIELD_SET.has(field)) {
        errors.push({ field, code: 'unknown_field', message: `未知字段「${field}」不允许写入草稿` })
      }
    }
    const filter = {}
    for (const field of FilterStore.FILTER_RULE_FIELDS) {
      const value = raw[field]
      if (value === undefined) continue
      if (typeof value !== 'string') {
        errors.push({ field, code: 'not_string', message: `字段「${field}」必须是字符串（当前 ${typeof value}）` })
        continue
      }
      if (value.length > FILTER_DRAFT_FIELD_MAX_LEN) {
        errors.push({ field, code: 'too_long', message: `字段「${field}」长度 ${value.length} 超过上限 ${FILTER_DRAFT_FIELD_MAX_LEN}` })
        continue
      }
      if (hasFilterDraftControlChar(value)) {
        errors.push({ field, code: 'control_char', message: `字段「${field}」含控制字符（仅允许 \\n \\r \\t）` })
        continue
      }
      filter[field] = value
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, filter }
  }
  const handleFilterDraftGet = (req, res) => {
    const revision = currentFilterRevision()
    const paths = filterDraftPaths()
    const read = readSafeTextResult(paths.draft, FILTER_BODY_MAX_BYTES)
    if (read.status === 'missing') {
      sendJson(res, 200, { ok: true, revision, draft: null })
      return
    }
    if (read.status !== 'ok') {
      // 读取窗口被替换/瞬时 IO 错误都不能当成「草稿损坏」删掉：
      // 那会把另一台设备刚写好的有效草稿清空（Sourcery Medium）。
      sendJson(res, 200, { ok: true, revision, draft: null })
      return
    }
    let saved
    try { saved = JSON.parse(read.text) } catch (e) { saved = null }
    const savedAt = saved && Number(saved.savedAt)
    const normalized = saved && normalizeFilterDraft(saved.filter)
    if (!saved || saved.schema !== FILTER_DRAFT_SCHEMA || !Number.isFinite(savedAt) || savedAt <= 0 ||
        !normalized.ok || !Number.isSafeInteger(saved.baseRevision) || saved.baseRevision < 0) {
      sendJson(res, 200, { ok: true, revision, draft: null })
      return
    }
    if (Date.now() - savedAt > FILTER_DRAFT_MAX_AGE_MS) {
      sendJson(res, 200, { ok: true, revision, draft: null })
      return
    }
    sendJson(res, 200, {
      ok: true,
      revision,
      draft: { filter: normalized.filter, baseRevision: saved.baseRevision, savedAt }
    })
  }
  const handleFilterDraftSave = (req, res) => {
    readFilterJson(req).then((parsed) => {
      if (parsed.error) { sendJson(res, parsed.error.status, parsed.error.body); return }
      const body = parsed.value
      // 未带 schema 的旧客户端按 1 处理；显式带其他版本必须拒绝（Sourcery Medium）。
      const schema = body.schema === undefined ? FILTER_DRAFT_SCHEMA : body.schema
      if (schema !== FILTER_DRAFT_SCHEMA) {
        sendFilterValidation(res, [{ field: 'schema', code: 'unsupported_schema', message: `只支持草稿 schema ${FILTER_DRAFT_SCHEMA}` }])
        return
      }
      const baseRevision = body.baseRevision === undefined ? 0 : body.baseRevision
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        sendFilterValidation(res, [{ field: 'baseRevision', code: 'invalid_revision', message: 'baseRevision 必须是非负整数' }])
        return
      }
      const normalized = normalizeFilterDraft(body.filter)
      if (!normalized.ok) { sendFilterValidation(res, normalized.errors); return }
      const current = currentFilterRevision()
      if (baseRevision !== current) {
        sendJson(res, 409, {
          ok: false,
          error: 'revision_mismatch',
          code: 'revision_mismatch',
          revision: current
        })
        return
      }
      const paths = filterDraftPaths()
      const payload = {
        schema: FILTER_DRAFT_SCHEMA,
        baseRevision,
        savedAt: Date.now(),
        filter: normalized.filter
      }
      if (!writeAtomic(paths.draft, JSON.stringify(payload), '过滤规则草稿')) {
        sendJson(res, 500, { ok: false, error: 'write_failed', code: 'write_failed' })
        return
      }
      // 写完再看一眼正式 revision：若期间正式保存已经把草稿删掉并升了版，
      // 这次晚到的草稿不能留——但不能直接按路径删，可能删掉另一台设备刚写的新草稿。
      // 保留文件、由读面按 baseRevision 过滤，下一次合法写入会覆盖它。
      const after = currentFilterRevision()
      if (after !== baseRevision) {
        sendJson(res, 409, {
          ok: false,
          error: 'revision_mismatch',
          code: 'revision_mismatch',
          revision: after
        })
        return
      }
      sendJson(res, 200, { ok: true, revision: baseRevision, savedAt: payload.savedAt })
    }).catch(() => sendJson(res, 500, { ok: false, error: 'write_failed', code: 'write_failed' }))
  }
  const handleFilterDraftDelete = (req, res) => {
    if (!clearFilterDraftFile()) {
      sendJson(res, 500, { ok: false, error: 'write_failed', code: 'write_failed' })
      return
    }
    sendJson(res, 200, { ok: true })
  }

  // ── 数据备份 / 恢复（v3.354）──────────────────────────────────────────────
  // 导出：用户勾选类别，打包成一个 JSON；导入：读取文件里实际存在的类别并恢复，
  // 不再让用户二次勾选。自动运行只写 interval，绝不写 on/off。
  const readBackupFile = (filePath, maxBytes) => readSafeTextResult(filePath, maxBytes, { openNonBlocking: true })
  const backupStamp = () => new Date().toISOString().replace(/[:.]/g, '-')
  const backupPathFor = (dir, name) => path.join(dir, name)
  const copyForImportBackup = (src, dir, name) => {
    try {
      const st = fs.lstatSync(src)
      if (!st.isFile()) return false
      fs.copyFileSync(src, backupPathFor(dir, name))
      return true
    } catch (e) {
      if (e && e.code === 'ENOENT') return false
      throw e
    }
  }
  const handleBackupExport = (req, res) => {
    readBody(req, 16 * 1024).then(({ body, over, aborted }) => {
      if (over || aborted) { sendJson(res, over ? 413 : 400, { error: '请求体不完整或超限' }); return }
      let selected = BACKUP_CATEGORIES.slice()
      if (body && body.trim() !== '') {
        let parsed
        try { parsed = JSON.parse(body) } catch (e) { sendJson(res, 400, { error: 'invalid_json' }); return }
        if (!parsed || !Array.isArray(parsed.categories)) { sendJson(res, 400, { error: 'categories 必须是数组' }); return }
        selected = parsed.categories
      }
      if (!selected.every((k) => BACKUP_CATEGORIES.includes(k))) {
        sendJson(res, 400, { error: 'unknown_category' })
        return
      }
      if (selected.length === 0) { sendJson(res, 400, { error: '至少选择一项' }); return }
      const data = {}
      const skipped = []
      if (selected.includes('messages')) {
        const read = readMessages(stateDir, { maxBytes: MESSAGES_MAX_BYTES, filename: messagesFile })
        const raw = read.status === 'ok' ? readBackupFile(path.join(stateDir, messagesFile), MESSAGES_MAX_BYTES) : null
        if (read.status === 'ok' && raw && raw.status === 'ok') {
          data.messages = { filename: messagesFile, count: read.value.items.length, text: raw.text }
        } else {
          skipped.push({ key: 'messages', reason: read.status === 'ok' ? raw.status : read.status })
        }
      }
      if (selected.includes('filter')) {
        const paths = FilterStore.filterRulesPaths(stateDir)
        const read = readBackupFile(paths.file, FILTER_BODY_MAX_BYTES)
        if (read.status === 'ok') {
          let parsed
          try { parsed = JSON.parse(read.text) } catch (e) { parsed = null }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            data.filter = { text: read.text }
          } else {
            skipped.push({ key: 'filter', reason: 'invalid_json' })
          }
        } else {
          skipped.push({ key: 'filter', reason: read.status })
        }
      }
      if (selected.includes('settings')) {
        data.settings = {
          notifyTestReplayWindowS: runtimeSettings.notifyTestReplayWindowS,
          syncShowDate: runtimeSettings.syncShowDate
        }
      }
      if (selected.includes('auto')) {
        data.auto = { interval: auto.interval }
      }
      if (selected.includes('runLog')) {
        const read = readBackupFile(path.join(historyDir(), 'run.log'), BACKUP_RUN_LOG_MAX_BYTES)
        if (read.status === 'ok') data.runLog = { text: read.text }
        else skipped.push({ key: 'runLog', reason: read.status })
      }
      const bundle = {
        kind: BACKUP_KIND,
        schema: BACKUP_SCHEMA,
        exportedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        data,
        skipped
      }
      const bodyText = JSON.stringify(bundle)
      const fileName = `xbk-backup-${backupStamp()}.json`
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Backup-Skipped': skipped.map((s) => s.key).join(','),
        'Cache-Control': 'no-store'
      })
      res.end(bodyText)
    }).catch(() => sendJson(res, 500, { error: '导出失败' }))
  }
  const handleBackupImport = (req, res) => {
    readBody(req, BACKUP_MAX_BYTES).then(({ body, over, aborted }) => {
      if (over) { sendJson(res, 413, { error: '备份文件太大', code: 'backup_too_large' }); return }
      if (aborted) { sendJson(res, 400, { error: '备份文件上传不完整', code: 'invalid_body' }); return }
      let bundle
      try { bundle = JSON.parse(body) } catch (e) { sendJson(res, 400, { error: '备份文件不是合法 JSON', code: 'invalid_json' }); return }
      if (!bundle || bundle.kind !== BACKUP_KIND || bundle.schema !== BACKUP_SCHEMA) {
        sendJson(res, 400, { error: '这不是控制台备份文件', code: 'invalid_backup' })
        return
      }
      const data = bundle.data && typeof bundle.data === 'object' && !Array.isArray(bundle.data) ? bundle.data : null
      if (!data) { sendJson(res, 400, { error: '备份文件没有数据', code: 'invalid_backup' }); return }
      const plans = {}
      const errors = []
      if (data.messages !== undefined) {
        const m = data.messages
        if (!m || typeof m.text !== 'string' || m.text.length > MESSAGES_MAX_BYTES) {
          errors.push({ field: 'messages', code: 'invalid_messages', message: '推送记录备份格式不正确或过大' })
        } else {
          let items
          try { items = JSON.parse(m.text) } catch (e) { items = null }
          if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
            errors.push({ field: 'messages', code: 'invalid_messages', message: '推送记录必须是对象数组' })
          } else {
            plans.messages = { text: m.text, count: items.length }
          }
        }
      }
      if (data.filter !== undefined) {
        const f = data.filter
        if (!f || typeof f.text !== 'string' || f.text.length > FILTER_BODY_MAX_BYTES) {
          errors.push({ field: 'filter', code: 'invalid_filter', message: '过滤规则备份格式不正确或过大' })
        } else {
          let parsed
          try { parsed = JSON.parse(f.text) } catch (e) { parsed = null }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.filter || typeof parsed.filter !== 'object') {
            errors.push({ field: 'filter', code: 'invalid_filter', message: '过滤规则备份格式不正确' })
          } else {
            const result = validateCandidate(runtimeFilterDeps(), parsed)
            if (!result.ok) errors.push({ field: 'filter', code: 'invalid_filter', message: result.errors.map((x) => x.message).join('；') })
            else plans.filter = { result, previousText: f.text }
          }
        }
      }
      if (data.settings !== undefined) {
        const s = data.settings
        const win = s && s.notifyTestReplayWindowS
        const date = s && s.syncShowDate
        if (!s || !Number.isInteger(win) || win < NOTIFY_REPLAY_MIN_S || win > NOTIFY_REPLAY_MAX_S ||
            typeof date !== 'boolean') {
          errors.push({ field: 'settings', code: 'invalid_settings', message: '控制台设置备份无效' })
        } else {
          plans.settings = { notifyTestReplayWindowS: win, syncShowDate: date }
        }
      }
      if (data.auto !== undefined) {
        const interval = data.auto && data.auto.interval
        if (!Number.isInteger(interval) || interval < AUTO_MIN_S || interval > AUTO_MAX_S) {
          errors.push({ field: 'auto', code: 'invalid_auto', message: '自动运行间隔备份无效' })
        } else {
          plans.auto = { interval }
        }
      }
      if (data.runLog !== undefined) {
        const text = data.runLog && data.runLog.text
        if (typeof text !== 'string' || text.length > BACKUP_RUN_LOG_MAX_BYTES) {
          errors.push({ field: 'runLog', code: 'invalid_run_log', message: '运行日志备份无效或过大' })
        } else {
          plans.runLog = { text }
        }
      }
      if (Object.keys(plans).length === 0) {
        sendJson(res, 400, { error: '备份文件里没有可恢复的数据', code: 'empty_backup', errors })
        return
      }
      if (errors.length > 0) {
        sendJson(res, 400, { error: '备份文件里有数据格式不对，未恢复', code: 'backup_validation_failed', errors })
        return
      }
      const lockToken = crypto.randomBytes(12).toString('hex')
      if (!acquireLock(stateDir, Date.now(), lockToken)) {
        res.setHeader('Retry-After', '1')
        sendJson(res, 409, { error: 'busy', code: 'busy', message: '有任务正在运行，等结束再导入' })
        return
      }
      let filterLock = null
      const backupDir = path.join(stateDir, 'backup', `pre-import-${backupStamp()}-${crypto.randomBytes(3).toString('hex')}`)
      try {
        if (plans.filter) {
          filterLock = acquireFilterLock(stateDir)
          if (!filterLock) {
            res.setHeader('Retry-After', '1')
            sendJson(res, 409, { error: 'filter_busy', code: 'filter_busy', message: '过滤规则正在保存，稍后再导入' })
            return
          }
        }
        fs.mkdirSync(backupDir, { recursive: true })
        try {
          copyForImportBackup(path.join(stateDir, messagesFile), backupDir, messagesFile)
          copyForImportBackup(FilterStore.filterRulesPaths(stateDir).file, backupDir, 'filter-rules.json')
          copyForImportBackup(settingsPath, backupDir, CONSOLE_SETTINGS_FILE)
          copyForImportBackup(autoPath, backupDir, AUTO_STATE_FILE)
          copyForImportBackup(path.join(historyDir(), 'run.log'), backupDir, 'run.log')
        } catch (e) {
          sendJson(res, 500, { error: 'backup_failed', code: 'backup_failed' })
          return
        }
        const imported = {}
        if (plans.messages) {
          if (!writeAtomic(path.join(stateDir, messagesFile), plans.messages.text, '推送记录恢复')) {
            sendJson(res, 500, { error: 'write_failed', code: 'write_failed', field: 'messages' })
            return
          }
          imported.messages = plans.messages.count
        }
        if (plans.filter) {
          const paths = FilterStore.filterRulesPaths(stateDir)
          const current = currentFilterRevision()
          const nextFile = {
            schema: FilterStore.FILTER_RULES_SCHEMA,
            revision: current + 1,
            filter: plans.filter.result.value
          }
          if (!writeAtomic(paths.file, JSON.stringify(nextFile), '过滤规则恢复')) {
            sendJson(res, 500, { error: 'write_failed', code: 'write_failed', field: 'filter' })
            return
          }
          clearFilterDraftFile()
          imported.filter = true
          imported.filterRevision = nextFile.revision
        }
        if (plans.settings) {
          const next = {
            revision: runtimeSettings.revision + 1,
            updatedAt: Date.now(),
            notifyTestReplayWindowS: plans.settings.notifyTestReplayWindowS,
            syncShowDate: plans.settings.syncShowDate
          }
          if (!writeAtomic(settingsPath, JSON.stringify(next), '控制台设置恢复')) {
            sendJson(res, 500, { error: 'write_failed', code: 'write_failed', field: 'settings' })
            return
          }
          runtimeSettings.revision = next.revision
          runtimeSettings.updatedAt = next.updatedAt
          runtimeSettings.notifyTestReplayWindowS = next.notifyTestReplayWindowS
          runtimeSettings.syncShowDate = next.syncShowDate
          settingsSource = 'file'
          imported.settings = true
        }
        if (plans.auto) {
          auto.interval = plans.auto.interval
          persistAuto()
          imported.autoInterval = plans.auto.interval
        }
        if (plans.runLog) {
          const dir = historyDir()
          fs.mkdirSync(dir, { recursive: true })
          if (!writeAtomic(path.join(dir, 'run.log'), plans.runLog.text, '运行日志恢复')) {
            sendJson(res, 500, { error: 'write_failed', code: 'write_failed', field: 'runLog' })
            return
          }
          imported.runLogBytes = Buffer.byteLength(plans.runLog.text, 'utf8')
        }
        sendJson(res, 200, {
          ok: true,
          imported,
          backupDir: path.relative(stateDir, backupDir) || backupDir
        })
      } finally {
        if (filterLock) releaseFilterLock(filterLock)
        releaseLockFor({ _stateDir: stateDir, _lockToken: lockToken })
      }
    }).catch(() => sendJson(res, 500, { error: '导入失败' }))
  }

  // GET /api/config/filter：读面，沿用全局鉴权（Cookie / Bearer / ?token= 均可）。
  // 损坏时 revision 强制 0（即便进程内有 last-known-good，那是运行侧降级，不是覆盖文件版本）。
  const handleFilterGet = (req, res) => {
    const loaded = loadCurrentFilter()
    const corrupt = loaded.source === 'corrupt'
    const appliedRead = FilterStore.readAppliedSnapshot(stateDir)
    // 原样返回生效快照（readAppliedSnapshot 的 snapshot），UI 读 revision/appliedAt/hash；
    // 不在这里二次裁剪，避免与运行侧写入形状漂移。
    const applied = appliedRead.status === 'ok' ? appliedRead.snapshot : null
    const chain = readFilterAuditChain(FilterStore.filterRulesPaths(stateDir).audit)
    const payload = {
      schema: FilterStore.FILTER_RULES_SCHEMA,
      revision: corrupt ? 0 : loaded.revision,
      source: loaded.source,
      filter: loaded.filter,
      keyword: {
        zkt_gjc: loaded.keyword && loaded.keyword.zkt_gjc !== undefined ? loaded.keyword.zkt_gjc : '',
        writable: false
      },
      wideMatch: wideMatchFields(loaded.filter),
      applied,
      auditChain: { ok: chain.ok, entries: chain.entries, brokenAt: chain.brokenAt }
    }
    if (corrupt) {
      payload.error = {
        code: 'store_corrupt',
        message: loaded.error && loaded.error.message ? loaded.error.message : '覆盖文件损坏'
      }
    }
    sendJson(res, 200, payload)
  }

  // POST /api/config/filter：保存。鉴权/媒体类型已由调用方处理。
  // 锁内顺序：读当前 → CAS → 损坏确认 → 备份 → 原子写 → 审计 → 释放（全程同步）。
  const handleFilterSave = (req, res, actorToken) => {
    readFilterJson(req).then((parsed) => {
      if (parsed.error) { sendJson(res, parsed.error.status, parsed.error.body); return }
      const body = parsed.value
      const deps = runtimeFilterDeps()
      const defaults = filterDefaults()
      const baseRevision = body.baseRevision === undefined ? 0 : body.baseRevision
      const result = validateCandidate(deps, body)
      if (result.ok && result.wideMatch.length > 0 && body.confirmWideMatch !== true) {
        sendFilterValidation(res, wideConfirmErrors(result.wideMatch))
        return
      }
      if (!result.ok) { respondValidationFailure(res, result); return }
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        sendFilterValidation(res, [{ field: 'baseRevision', code: 'invalid_revision', message: 'baseRevision 必须是非负整数' }])
        return
      }
      const lock = acquireFilterLock(stateDir)
      if (!lock) {
        // 锁被占：显式 Retry-After（sendJson 只写 Content-Type，先用 setHeader 合并）。
        res.setHeader('Retry-After', '1')
        sendJson(res, 409, { error: 'write_busy', code: 'write_busy' })
        return
      }
      try {
        const paths = FilterStore.filterRulesPaths(stateDir)
        const loaded = loadCurrentFilter()
        const corrupt = loaded.source === 'corrupt'
        const curRevision = corrupt ? 0 : loaded.revision
        if (baseRevision !== curRevision) {
          sendJson(res, 409, {
            error: 'revision_mismatch',
            code: 'revision_mismatch',
            revision: curRevision,
            errors: [{ field: 'baseRevision', code: 'revision_mismatch', message: `当前 revision 为 ${curRevision}，请重新加载后再保存` }]
          })
          return
        }
        if (corrupt && body.confirmReplaceCorrupt !== true) {
          sendJson(res, 409, {
            error: 'store_corrupt',
            code: 'store_corrupt',
            errors: [{ field: 'confirmReplaceCorrupt', code: 'store_corrupt', message: '覆盖文件已损坏，需 confirmReplaceCorrupt:true 才能覆盖' }]
          })
          return
        }
        // 审计已满（>4 MiB）时链无法安全续写：先拒绝保存，规则文件一个字节都不动。
        if (filterAuditAtLimit(paths.audit)) {
          sendJson(res, 507, {
            error: 'audit_full',
            code: 'audit_full',
            errors: [{ field: 'audit', code: 'audit_full', message: '审计文件已达 4 MiB 上限，需人工归档 filter-rules.audit.ndjson 后才能继续保存' }]
          })
          return
        }
        // 保存前快照：合法覆盖文件既写备份（回滚用），也留原文给审计失败回滚；
        // 损坏文件不备份（不是可回滚的代），但仍留原文，审计失败时原样写回。
        let previousText = null
        if (loaded.source === 'override' || corrupt) {
          const raw = readSafeTextResult(paths.file, FILTER_BODY_MAX_BYTES)
          if (raw.status === 'ok') previousText = raw.text
          // 合法 override 必须能备份：备份失败就不能替换（否则这一代永久失去回滚点）。
          if (loaded.source === 'override' && !backupFilterFile(paths, curRevision, previousText)) {
            sendJson(res, 500, { error: 'backup_failed', code: 'backup_failed' })
            return
          }
        }
        const nextRevision = curRevision + 1
        const nextFile = {
          schema: FilterStore.FILTER_RULES_SCHEMA,
          revision: nextRevision,
          filter: result.value
        }
        if (!writeAtomic(paths.file, JSON.stringify(nextFile), '过滤规则覆盖文件')) {
          sendJson(res, 500, { error: 'write_failed', code: 'write_failed' })
          return
        }
        const nextActive = FilterStore.mergeActiveFilter({
          defaults: defaults.filter,
          keyword: defaults.keyword,
          override: result.value
        })
        const changedFields = diffFilterFields(loaded.filter, nextActive.filter)
        const hash = filterHashOf(deps, nextActive.filter, nextActive.keyword)
        if (!appendFilterAudit({
          auditPath: paths.audit,
          actor: actorOf(actorToken),
          action: 'save',
          revision: nextRevision,
          changedFields
        })) {
          // 审计不落地 ⇒ 本次保存整体作废（回滚覆盖文件），绝不报成功。
          const rolled = rollbackFilterOverride(paths, previousText)
          sendJson(res, 500, {
            error: 'audit_failed',
            code: 'audit_failed',
            rolledBack: rolled.ok,
            rollbackMode: rolled.mode
          })
          return
        }
        // 剪枝只在整个保存（含审计）成功后才执行：任何失败路径都不得剪掉最老备份。
        pruneFilterBackups(paths)
        // 正式保存成功：没保存的草稿已经失去意义，删掉避免下次误恢复。
        clearFilterDraftFile()
        sendJson(res, 200, {
          ok: true,
          revision: nextRevision,
          changedFields,
          hash,
          appliedHint: '下一轮生效'
        })
      } finally {
        releaseFilterLock(lock)
      }
    }).catch(() => sendJson(res, 500, { error: 'write_failed', code: 'write_failed' }))
  }

  // POST /api/config/filter/validate：只预检，不取锁、不落盘。
  const handleFilterValidate = (req, res) => {
    readFilterJson(req).then((parsed) => {
      if (parsed.error) { sendJson(res, parsed.error.status, parsed.error.body); return }
      const body = parsed.value
      const deps = runtimeFilterDeps()
      const result = validateCandidate(deps, body)
      if (result.ok && result.wideMatch.length > 0 && body.confirmWideMatch !== true) {
        sendFilterValidation(res, wideConfirmErrors(result.wideMatch))
        return
      }
      if (!result.ok) { respondValidationFailure(res, result); return }
      sendJson(res, 200, { ok: true, warnings: [], wideMatch: result.wideMatch })
    }).catch(() => sendJson(res, 500, { error: 'write_failed', code: 'write_failed' }))
  }

  // POST /api/config/filter/preview：候选规则对 push.json 中 _f===true 记录试算补推数。
  // 直接 readSafeTextResult + JSON.parse（**不能**用 status.readMessages：它会丢弃 _f）。
  const handleFilterPreview = (req, res) => {
    readFilterJson(req).then((parsed) => {
      if (parsed.error) { sendJson(res, parsed.error.status, parsed.error.body); return }
      const body = parsed.value
      const deps = runtimeFilterDeps()
      const defaults = filterDefaults()
      const result = validateCandidate(deps, body)
      if (result.ok && result.wideMatch.length > 0 && body.confirmWideMatch !== true) {
        sendFilterValidation(res, wideConfirmErrors(result.wideMatch))
        return
      }
      if (!result.ok) { respondValidationFailure(res, result); return }
      if (!deps.RuleEngine || typeof deps.explainFilter !== 'function') {
        sendJson(res, 503, { error: 'engine_unavailable', code: 'engine_unavailable' })
        return
      }
      const candidate = FilterStore.mergeActiveFilter({
        defaults: defaults.filter,
        keyword: defaults.keyword,
        override: result.value
      }).filter
      let compiled
      try {
        compiled = deps.RuleEngine.compileRules(candidate)
      } catch (e) {
        sendJson(res, 503, { error: 'engine_unavailable', code: 'engine_unavailable' })
        return
      }
      const limitRaw = Number(body.limit)
      const limit = Number.isFinite(limitRaw)
        ? Math.min(FILTER_PREVIEW_SAMPLE_MAX, Math.max(1, Math.floor(limitRaw)))
        : FILTER_PREVIEW_SAMPLE_DEFAULT
      const read = readSafeTextResult(path.join(stateDir, messagesFile), FILTER_PREVIEW_MAX_BYTES)
      let records = null
      if (read.status === 'ok') {
        try {
          const data = JSON.parse(read.text)
          if (Array.isArray(data)) records = data
        } catch (e) { records = null }
      }
      // 读不到缓存（缺失/超限/坏 JSON/非数组）不能显示成「0 条影响」——那是把未知说成确定。
      // 200 + available:false，计数一律 null，前端显示「无法读取推送历史，本次不显示补推估算」。
      if (records === null) {
        sendJson(res, 200, {
          ok: true,
          available: false,
          code: 'cache_unavailable',
          scanned: null,
          capped: false,
          reEvalCount: null,
          atLeast: false,
          limit,
          samples: [],
          cacheStatus: read.status,
          zktApplied: false
        })
        return
      }
      // 扫描上限只作用于 _f 记录：capped 必须按 _f 条数判定（缓存总条数与补推估算无关）。
      const fRecords = records.filter((entry) => entry && typeof entry === 'object' && entry._f === true)
      const capped = fRecords.length > FILTER_PREVIEW_SCAN_MAX
      // zkt_gjc 白名单与运行期同源（Config.keyword.zkt_gjc）：标题不匹配白名单的记录即使过了
      // 候选规则也不会补推，必须从估算里排除；拿不到编译能力时按「未应用」如实标注。
      const zktRegex = previewWhitelistRegex(deps, defaults.keyword)
      const zktApplied = zktRegex !== null
      let scanned = 0
      let reEvalCount = 0
      const samples = []
      for (const entry of fRecords) {
        if (scanned >= FILTER_PREVIEW_SCAN_MAX) break
        scanned++
        let verdict = null
        try { verdict = deps.explainFilter(entry, compiled, candidate) } catch (e) { verdict = null }
        if (!verdict || verdict.passed !== true) continue
        if (!previewWhitelistKeeps(entry, zktRegex, deps.RuleEngine && deps.RuleEngine._normalizeReInput)) continue
        reEvalCount++
        if (samples.length < limit) {
          samples.push({
            id: entry.id === undefined ? null : entry.id,
            title: typeof entry.title === 'string' ? entry.title : '',
            reason: verdict.reason === undefined ? null : verdict.reason
          })
        }
      }
      sendJson(res, 200, {
        ok: true,
        available: true,
        scanned,
        capped,
        reEvalCount,
        atLeast: capped,
        limit,
        samples,
        cacheStatus: read.status,
        zktApplied
      })
    }).catch(() => sendJson(res, 500, { error: 'write_failed', code: 'write_failed' }))
  }

  // POST /api/config/filter/restore：备份回滚或恢复代码默认——两者都写 revision+1 的覆盖文件。
  // 恢复默认写 `{filter:{}}`（等价于代码默认）而**不再删除文件**：删文件会让 revision 归零、
  // 备份列表消失、陈旧客户端还能拿旧 baseRevision 过 CAS。
  const handleFilterRestore = (req, res, actorToken) => {
    readFilterJson(req).then((parsed) => {
      if (parsed.error) { sendJson(res, parsed.error.status, parsed.error.body); return }
      const body = parsed.value
      if (body.confirm !== true) {
        sendFilterValidation(res, [{ field: 'confirm', code: 'confirm_required', message: '回滚/恢复默认需 confirm:true' }], 'confirm_required')
        return
      }
      const to = body.to
      const toDefault = to === 'default'
      if (!toDefault && (!Number.isSafeInteger(to) || to < 0)) {
        sendFilterValidation(res, [{ field: 'to', code: 'invalid_target', message: "to 必须是非负整数 revision 或 'default'" }])
        return
      }
      // 契约变更：回滚必须带页面加载时的 revision，否则陈旧回滚页会覆盖新版本。
      const baseRevision = body.baseRevision
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        sendFilterValidation(res, [{ field: 'baseRevision', code: 'invalid_revision', message: 'baseRevision 必须是非负整数（取页面加载时的 revision）' }], 'invalid_revision')
        return
      }
      const deps = runtimeFilterDeps()
      const defaults = filterDefaults()
      const paths = FilterStore.filterRulesPaths(stateDir)
      let restoredFilter = null
      if (!toDefault) {
        const read = readSafeTextResult(paths.backupFor(to), FILTER_BODY_MAX_BYTES)
        if (read.status === 'missing') {
          sendJson(res, 404, { error: 'backup_not_found', code: 'backup_not_found' })
          return
        }
        if (read.status !== 'ok') {
          sendJson(res, 500, { error: 'write_failed', code: 'write_failed' })
          return
        }
        const backup = parseFilterFile(read.text)
        if (!backup.ok) {
          sendFilterValidation(res, [{ field: 'to', code: 'invalid_backup', message: `备份文件不可用：${backup.message}` }])
          return
        }
        const result = validateCandidate(deps, backup)
        if (!result.ok) { respondValidationFailure(res, result); return }
        restoredFilter = result.value
      }
      const lock = acquireFilterLock(stateDir)
      if (!lock) {
        res.setHeader('Retry-After', '1')
        sendJson(res, 409, { error: 'write_busy', code: 'write_busy' })
        return
      }
      try {
        const loaded = loadCurrentFilter()
        const curRevision = loaded.source === 'corrupt' ? 0 : loaded.revision
        if (baseRevision !== curRevision) {
          sendJson(res, 409, {
            error: 'revision_mismatch',
            code: 'revision_mismatch',
            revision: curRevision,
            errors: [{ field: 'baseRevision', code: 'revision_mismatch', message: `当前 revision 为 ${curRevision}，请重新加载后再回滚` }]
          })
          return
        }
        if (filterAuditAtLimit(paths.audit)) {
          sendJson(res, 507, {
            error: 'audit_full',
            code: 'audit_full',
            errors: [{ field: 'audit', code: 'audit_full', message: '审计文件已达 4 MiB 上限，需人工归档 filter-rules.audit.ndjson 后才能继续回滚' }]
          })
          return
        }
        // 改文件前先备份当前配置：被替换的这一代必须仍能从备份列表回滚回来。
        let previousText = null
        if (loaded.source === 'override' || loaded.source === 'corrupt') {
          const raw = readSafeTextResult(paths.file, FILTER_BODY_MAX_BYTES)
          if (raw.status === 'ok') previousText = raw.text
          if (loaded.source === 'override' && !backupFilterFile(paths, curRevision, previousText)) {
            sendJson(res, 500, { error: 'backup_failed', code: 'backup_failed' })
            return
          }
        }
        const nextRevision = curRevision + 1
        const nextFile = {
          schema: FilterStore.FILTER_RULES_SCHEMA,
          revision: nextRevision,
          filter: toDefault ? {} : restoredFilter
        }
        if (!writeAtomic(paths.file, JSON.stringify(nextFile), '过滤规则覆盖文件')) {
          sendJson(res, 500, { error: 'write_failed', code: 'write_failed' })
          return
        }
        const nextActive = toDefault
          ? FilterStore.mergeActiveFilter({ defaults: defaults.filter, keyword: defaults.keyword })
          : FilterStore.mergeActiveFilter({
            defaults: defaults.filter,
            keyword: defaults.keyword,
            override: restoredFilter
          })
        const changedFields = diffFilterFields(loaded.filter, nextActive.filter)
        if (!appendFilterAudit({
          auditPath: paths.audit,
          actor: actorOf(actorToken),
          action: toDefault ? 'reset_default' : 'restore',
          revision: nextRevision,
          changedFields
        })) {
          const rolled = rollbackFilterOverride(paths, previousText)
          sendJson(res, 500, {
            error: 'audit_failed',
            code: 'audit_failed',
            rolledBack: rolled.ok,
            rollbackMode: rolled.mode
          })
          return
        }
        // 剪枝只在整个回滚（含审计）成功后才执行。
        pruneFilterBackups(paths)
        // 回滚/恢复默认也是一次正式写入，草稿随之作废。
        clearFilterDraftFile()
        const payload = {
          ok: true,
          revision: nextRevision,
          restoredFrom: toDefault ? 'default' : to,
          changedFields
        }
        if (!toDefault) payload.hash = filterHashOf(deps, nextActive.filter, nextActive.keyword)
        sendJson(res, 200, payload)
      } finally {
        releaseFilterLock(lock)
      }
    }).catch(() => sendJson(res, 500, { error: 'write_failed', code: 'write_failed' }))
  }

  // 写端点入口：Bearer-only 闸 → 媒体类型 → 按固定路径分派。
  const handleFilterWrite = (req, res, url) => {
    const verdict = writeAuthVerdict(req, url.searchParams, token)
    if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
    if (!filterMediaAllowed(req)) {
      sendJson(res, 415, { error: 'unsupported_media_type', code: 'unsupported_media_type' })
      return
    }
    if (url.pathname === '/api/config/filter/validate') { handleFilterValidate(req, res); return }
    if (url.pathname === '/api/config/filter/preview') { handleFilterPreview(req, res); return }
    if (url.pathname === '/api/config/filter/restore') { handleFilterRestore(req, res, verdict.actorToken); return }
    if (url.pathname === '/api/config/filter/draft') { handleFilterDraftSave(req, res); return }
    handleFilterSave(req, res, verdict.actorToken)
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
        // v3.332：每 60s 一次的版本探针（?probe=version）200 不入环形——否则一个前台标签页
        // 一分钟一条，三小时就把 200 条真实请求历史挤干净（Sourcery #294）。401 等异常照记。
        const versionProbe = url && url.pathname === '/api/sys' &&
          url.searchParams.get('probe') === 'version' && status === 200
        if (!versionProbe && (url ? shouldLogAccess(req.method, url.pathname, status) : true)) {
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
    // 登录表单只收 POST body（审查 #224 / Sourcery High）：GET 表单会把 token 带进
    // 地址栏与浏览器历史、Referer 与中间代理日志；POST 校验成功后 303 到干净 `/`，
    // 只下发 HttpOnly Cookie。直接打开 `?token=` 的分享链接仍兼容（见下方 authorize）。
    if (req.method === 'POST' && url.pathname === '/login') {
      readBody(req, 2048).then(({ body, aborted, over }) => {
        if (aborted || over) {
          sendJson(res, over ? 413 : 400, { error: over ? '登录请求过大' : '登录请求不完整' })
          return
        }
        const submitted = new URLSearchParams(body).get('token') || ''
        if (!timingSafeEqualStr(submitted, token)) {
          res.setHeader('Content-Security-Policy', CSP_HEADER)
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderUnauthorizedPage())
          return
        }
        res.setHeader('Set-Cookie',
          `xbk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`)
        res.setHeader('Cache-Control', 'no-store')
        res.writeHead(303, { Location: '/' })
        res.end()
      }).catch(() => sendJson(res, 400, { error: '登录请求读取失败' }))
      return
    }
    // 过滤规则写端点：必须在全局 authorize 之前分流。全局闸对 POST 接受 ?token= 且
    // 对 Cookie 统一回 unauthorized——只有专属入口才能给出 query_token_not_allowed /
    // cookie_not_allowed 两个规格要求的 code（写面仅 Bearer）。
    if (req.method === 'POST' && FILTER_WRITE_PATHS.has(url.pathname)) {
      handleFilterWrite(req, res, url)
      return
    }
    // 删除草稿也走写面鉴权（Bearer-only）：GET 读面仍可 Cookie/?token=。
    if (req.method === 'DELETE' && url.pathname === '/api/config/filter/draft') {
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      handleFilterDraftDelete(req, res)
      return
    }
    if (!authorize(req, token, url.searchParams)) {
      // 审查 #224：GET / 未授权时给可自助恢复的登录页，而不是裸 JSON；API/静态资源仍回 JSON。
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Security-Policy', CSP_HEADER)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderUnauthorizedPage())
        return
      }
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
      // SameSite=Lax（审查 #224：Strict 会让「从聊天点链接」的跨站顶层导航不带 Cookie，
      // 首屏必 401；Lax 对同源子请求照常携带，而写动作 POST /trigger 本就不收 Cookie，
      // 因此不扩大 CSRF 面）、Path=/；token 本身就是会话凭证，无需另发随机值。
      // Max-Age 30 天：自用工具，过期后重新打开 ?token= 链接即续期。
      // Sourcery 3x High（Cookie 无 Secure）：本服务部署在明文 HTTP 上（无 TLS 终结点），
      // Secure 属性会让浏览器拒绝在 http:// 上发送/存储 Cookie，控制台直接不可用——
      // 这是部署形态的固有权衡，不是代码缺陷可修；上 HTTPS（反代/自签）后应第一时间
      // 补 Secure + __Host- 前缀。缓解：HttpOnly（XSS 拿不走）+ SameSite=Lax（跨站顶层
      // 导航可带，但 POST 不收 Cookie）+ Max-Age 从 30 天收窄到 1 天 + Referrer-Policy（见下）。
      res.setHeader('Set-Cookie',
        `xbk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // Sourcery Session-users-cannot-trigger x2：用户经 Cookie 会话（无 ?token=）打开页面时，
      // boot JSON 的 token 为空 → 前端发空 Bearer → POST /trigger 401。把本次请求实际
      // 使用的凭证（authorize 已通过的 token 值）交给 renderPage 注入 boot，会话用户
      // 无需再拼 ?token= 即可触发。
      res.end(renderPage(state, runsList, url.searchParams, token, themeCookieValue(req.headers && req.headers.cookie)))
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
        // 损坏/0 字节锁（D2-S1）不能报成「空闲」：看板显示空闲而按钮一直 409 正是这条
        // finding。按 mtime 判陈旧：陈旧的损坏锁本次触发会被接管（held:false 且
        // state:'corrupted-stale'），新鲜的损坏锁仍在阻止触发（held:true）。
        let lockAge = 0
        let lockBody = null
        let corrupted = false
        try {
          lockBody = JSON.parse(fs.readFileSync(lp, 'utf8'))
          // "null"/标量帧（被外部写坏）同样按损坏处理：下面 lockBody.startedAt 会抛，
          // 不能让它冒到外层 catch 把 st.lock 留成 undefined。
          if (!lockBody || typeof lockBody !== 'object') throw new TypeError('lock frame is not an object')
        } catch (e2) {
          if (e2 && e2.code === 'ENOENT') {
            st.lock = { held: false, ageMs: 0, state: 'absent', corrupted: false, takeoverInMs: 0 }
          } else {
            corrupted = true
          }
        }
        // 与 acquireLock 同一分类：缺 startedAt / 非正整数的帧也算损坏（否则看板说
        // 「陈旧可抢」，acquireLock 却对新鲜损坏帧 fail-closed，两处结论相反）。
        if (lockBody && lockBody.released !== true && !(Number.isSafeInteger(lockBody.startedAt) && lockBody.startedAt > 0)) corrupted = true
        if (corrupted) {
          let mtimeAge
          try { mtimeAge = Math.max(0, Date.now() - fs.statSync(lp).mtimeMs) } catch (e2) { mtimeAge = PROC_TIMEOUT_MS }
          const held = mtimeAge <= PROC_TIMEOUT_MS
          st.lock = {
            held,
            ageMs: mtimeAge,
            state: held ? 'corrupted' : 'corrupted-stale',
            corrupted: true,
            takeoverInMs: held ? Math.max(0, PROC_TIMEOUT_MS - mtimeAge) : 0
          }
        } else if (lockBody) {
          const startedAt = typeof lockBody.startedAt === 'number' ? lockBody.startedAt : 0
          const released = lockBody.released === true
          lockAge = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : PROC_TIMEOUT_MS
          const held = !released && lockAge < PROC_TIMEOUT_MS
          st.lock = {
            held,
            ageMs: lockAge,
            state: released ? 'released' : (held ? 'running' : 'stale'),
            corrupted: false,
            takeoverInMs: held ? Math.max(0, PROC_TIMEOUT_MS - lockAge) : 0
          }
        }
        // 残留 .takeover 哨兵（上一次接管者崩溃的产物）：陈旧哨兵会阻塞接管，必须让运维
        // 一眼看到它是「残留」而不是「正在接管」（D2-S5）。
        try {
          const sst = fs.statSync(lp + '.takeover')
          const sAge = Math.max(0, Date.now() - sst.mtimeMs)
          st.lock.sentinel = { present: true, ageMs: sAge, stale: sAge > PROC_TIMEOUT_MS }
        } catch (e2) { /* 无哨兵 */ }
      } catch (e) {
        if (!st.lock) st.lock = { held: false, ageMs: 0, state: 'unknown', corrupted: false, takeoverInMs: 0 }
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
      // 时间窗（v3.307）：白名单外的值一律回「全部」（宽松输入，不 400）。
      const daysRaw = Number(q.get('days'))
      const days = MESSAGE_DAYS_ALLOWED.includes(daysRaw) ? daysRaw : 0
      // v3.326：自定义日期区间优先于「近 N 天」；非法区间静默回落到 days/全部。
      const win = windowMessages(read.value.items, {
        days, fromKey: parseDayKey(q.get('from')), toKey: parseDayKey(q.get('to'))
      })
      const windowed = win.items
      const items = filterMessageItems(windowed, cate, needle)
      // 行键必须按「条目对象」取原始 keys：过滤/时间窗会改变下标，继续用 start+i 会把
      // 旧行的 rowKey 贴到新行上（展开状态/React key 联动错位）。
      const keyByItem = new Map(read.value.items.map((m, i) => [m, read.value.keys[i]]))
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
        rowKey: keyByItem.get(m) !== undefined
          ? keyByItem.get(m)
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
        // 时间窗：0=全部；>0 时 categories 也只统计窗口内条目（筛选器计数要跟手）。
        // 搜索词同样要参与分类计数：否则「搜某某」后仍显示全量分类条数，点进去是空的
        // （Sourcery 分类计数忽略搜索）。
        days: win.days,
        from: win.from,
        to: win.to,
        categories: needle.length > 0
          ? messageCategoriesOf(filterMessageItems(win.days > 0 || win.from !== '' ? windowed : read.value.items, '', needle))
          : (win.days > 0 || win.from !== '' ? messageCategoriesOf(windowed) : read.value.categories),
        items: pageItems
      })
      return
    }
    // POST /api/backup/export：把勾选的数据类别打包成一个 JSON 下载。
    if (req.method === 'POST' && url.pathname === '/api/backup/export') {
      handleBackupExport(req, res)
      return
    }
    // POST /api/backup/import：读取备份文件里实际存在的类别并恢复（导入不再让用户勾选）。
    if (req.method === 'POST' && url.pathname === '/api/backup/import') {
      handleBackupImport(req, res)
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
          const daysRaw = Number(params.get('days'))
          const days = MESSAGE_DAYS_ALLOWED.includes(daysRaw) ? daysRaw : 0
          const read = readMessages(stateDir, { maxBytes: MESSAGES_MAX_BYTES, filename: messagesFile })
          if (read.status !== 'ok') {
            // missing/invalid/tooLarge 三态如实下发（与 /api/messages 同形态同哲学）：
            // 不伪装成空 CSV/空 JSON 让用户导出「成功却没数据」的文件；前端按 Content-Type 识别
            // 后展示提示而非下载。
            sendJson(res, 200, { status: read.status, total: 0, items: [], cacheDirHint: stateDir, cacheFileHint: messagesFile })
            return
          }
          const windowedExport = windowMessages(read.value.items, {
            days, fromKey: parseDayKey(params.get('from')), toKey: parseDayKey(params.get('to'))
          }).items
          const filtered = filterMessageItems(windowedExport, cate, needle)
          const truncated = filtered.length > EXPORT_MAX_ROWS
          const rows = (truncated ? filtered.slice(0, EXPORT_MAX_ROWS) : filtered).map(exportRowOf)
          // 截断回显（D2-S9）：列表端点有 queryUsed，导出此前没有——搜索词超过 240 字节被
          // 静默截断时，用户会以为「导出的是我搜的那个词的结果」。JSON 保持裸数组契约
          // （不改成 {items,...} 对象），CSV 也不插注释行，统一走响应头：percent-encoded
          // UTF-8，非 ASCII 安全；未截断也下发，消费方可据此判断词是否被接受。
          const exportMeta = { 'X-Export-Query-Used': encodeURIComponent(query) }
          if (format === 'json') {
            // 仅截断时下发该头；未截断不下发（缺席=完整，测试断言 undefined）。
            if (truncated) res.setHeader('X-Export-Truncated', 'true')
            // 成功导出=直接数组（文档口径「JSON 形态直出数组」，评审 231-M1）：消费方
            // JSON.parse 即得行数组，无需剥 items。截断信息走 X-Export-Truncated 头，
            // 不进响应体（形态纯度优先；三态响应才是 {status,...} 对象，前端按
            // Array.isArray 区分成功/三态——评审 231-H1）。
            const body = JSON.stringify(rows)
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="messages-export.json"' }, exportMeta))
            res.end(body)
            return
          }
          const head = Object.assign({
            'Content-Type': 'text/csv; charset=utf-8',
            // 文件名硬编码字面量：查询词可能含 token 形态字符串，绝不回显进头（蓝图防线）。
            'Content-Disposition': 'attachment; filename="messages-export.csv"'
          }, exportMeta)
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
      // v3.326：自定义区间优先于 days（与推送记录同一口径：非法/颠倒区间静默回落）。
      const trendFrom = parseDayKey(url.searchParams.get('from'))
      const trendTo = parseDayKey(url.searchParams.get('to'))
      const t = readTrends(stateDir, { days, from: trendFrom, to: trendTo })
      if (t.status !== 'ok') {
        sendJson(res, 200, { status: t.status, byDay: [], days })
        return
      }
      sendJson(res, 200, {
        status: 'ok',
        days: t.value.days,
        from: t.value.from,
        to: t.value.to,
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
      // before 游标（审查 D1-S3）：数字 = 旧的行号游标；条目 key 游标 = 8 位十六进制，
      // 同内容重复行的第 2..n 条带 `-<序号>` 后缀（D2-S4 复核：两条相同摘要行用同一个
      // key 会让 `before` 命中较新一条 → 翻页反复返回同一页）。其它形态一律当未传。
      const rawBefore = String(url.searchParams.get('before') || '')
      let before = 0
      if (/^[0-9a-f]{8}(?:-\d{1,4})?$/.test(rawBefore)) before = rawBefore
      else if (/^\d{1,9}$/.test(rawBefore) && Number(rawBefore) > 0) before = Number(rawBefore)
      // 尾窗指纹（评审 #243-1）：8 位十六进制；其它形态一律当「没带」，不做截断猜测
      const rawWin = String(url.searchParams.get('win') || '')
      const windowKey = /^[0-9a-f]{8}$/.test(rawWin) ? rawWin : ''
      // 「仅运行」：服务端先剔除 CANCEL 留痕再套 limit，避免取消记录挤掉真实轮次。
      const excludeCancelled = url.searchParams.get('excludeCancelled') === '1'
      // Sourcery #229-4 / 审查 #241 S1：run.log 的写入方是运行侧 MessageStore.cacheDir
      // （xbk_app _writeRunLog → MessageStore.cacheDir），不是控制台 stateDir——Config.cache.dir
      // 指向别处时两个目录分居。读取源与 spawn/停止留痕同走 historyDir()（运行侧真实目录优先）。
      const h = readRunHistory(historyDir(), { limit, before, windowKey, excludeCancelled })
      sendJson(res, 200, h)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      // 运行日志在线查看：run.log 尾部 1MiB（与 status.js LOG_READ_OPTIONS.tail 同口径）。
      // 读取源与 /api/run-history、/api/status 同走 historyDir()（D2-S5 复核）：run.log 由
      // 运行侧 MessageStore.cacheDir 写入，Config.cache.dir/XBK_CACHE_DIR 漂移或嵌入式注入
      // 时与 stateDir 分居——旧实现读 stateDir/run.log，日志页在那种部署里恒为空。
      const { readSafeTextResult } = require('../xbk_storage')
      const safe = readSafeTextResult(path.join(historyDir(), 'run.log'), LOG_VIEW_MAX_BYTES, { tail: true })
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
      // 条目数对照（Sourcery Medium「条目上限无预警」/ D2-S11 / D2-S12）：
      // ① count 用 rawTotal（含 _f 条目）——_f 一样占缓存额度，旧口径漏计会让超限预警不响；
      // ② 超过 CACHE_HEALTH_COUNT_MAX_BYTES 不整读（同步 parse 20MB 实测阻塞 232ms），
      //    如实报 null + tooLarge，不编数；阈值内走 readMessages 的解析缓存。
      const cnt = cacheHealthEntryCount(stateDir, messagesFile)
      snap.entryCount = cnt.status === 'ok' ? cnt.count : null
      snap.entryCountStatus = cnt.status
      snap.entryCountFiltered = cnt.status === 'ok' ? cnt.filteredCount : null
      if (cnt.status === 'tooLarge') snap.entryCountHint = `缓存超过 ${Math.round(CACHE_HEALTH_COUNT_MAX_BYTES / (1024 * 1024))}MiB，不在请求路径上整读计数（推送记录页的 grandTotal 仍可查）`
      sendJson(res, 200, snap)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const list = listStateFiles(stateDir, messagesFile)
      sendJson(res, 200, list)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      // 脱敏在 buildConfigView 内逐字段白名单完成；这里只做最终保险丝：万一未来白名单
      // 意外混入凭证形态字段，响应前整体拦一道（fail-closed 降级为不含 runtime 的骨架）。
      // D2-S13：旧实现拿「大写环境变量名」去匹配小写化后的 JSON，两个形态永不相交，这段
      // 防线不可达；且降级响应的键名写成 localFileLoaded（前端读 localFilePresent），
      // 前端把「保险丝触发」误显示成「模块缺失」。现在按键名语义递归扫描 + 统一键名。
      const view = buildConfigView()
      const leaked = findSecretLikeField(view)
      if (leaked) {
        sendJson(res, 200, {
          configLoaded: false,
          runtime: null,
          pushChannels: { moduleLoaded: false, count: 0, names: [], perChannel: {}, localFilePresent: buildPushChannelsView().localFilePresent },
          console: { env: {} },
          redacted: true,
          redactedField: leaked
        })
        return
      }
      sendJson(res, 200, view)
      return
    }
    // GET /api/config/filter：过滤规则读面（全局鉴权已通过，Cookie/Bearer/?token= 均可）。
    if (req.method === 'GET' && url.pathname === '/api/config/filter') {
      handleFilterGet(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/config/filter/draft') {
      handleFilterDraftGet(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/sys') {
      // 系统信息：版本四方来源 package.json（与 check-version.js 的唯一真源一致）+
      // 进程/宿主只读信息。不暴露路径之外的任何环境变量（token 等凭证绝不入响应）。
      const version = APP_VERSION
      // v3.331：显式禁缓存。版本对账拿不到「现在的」版本就永远提示不了刷新，
      // 不能被浏览器/代理的启发式缓存喂旧值（Sourcery #294）。
      res.setHeader('Cache-Control', 'no-store')
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
    // 服务器端自动正式运行：状态/开关/间隔。GET 走全局鉴权；POST 只认 Bearer（写面防 CSRF）。
    if (req.method === 'GET' && url.pathname === '/api/auto') {
      sendJson(res, 200, { auto: autoSnapshot(), min: AUTO_MIN_S, max: AUTO_MAX_S, maxFails: AUTO_MAX_FAILS })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/auto') {
      if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
          if (aborted) { sendJson(res, 400, { error: '请求中断，动作未执行' }); return }
          if (over) { sendJson(res, 413, { error: '请求体超限' }); return }
          let payload
          try { payload = JSON.parse(body || '{}') } catch (e) { sendJson(res, 400, { error: 'invalid_json' }); return }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            sendJson(res, 400, { error: 'body 必须是对象' })
            return
          }
          let on = auto.on
          if (Object.prototype.hasOwnProperty.call(payload, 'on')) {
            if (typeof payload.on !== 'boolean') { sendJson(res, 400, { error: 'on 必须是布尔值' }); return }
            on = payload.on
          }
          let interval = auto.interval
          if (Object.prototype.hasOwnProperty.call(payload, 'interval')) {
            if (typeof payload.interval !== 'number' || !Number.isInteger(payload.interval) ||
              payload.interval < AUTO_MIN_S || payload.interval > AUTO_MAX_S) {
              sendJson(res, 400, { error: `interval 必须是 ${AUTO_MIN_S}–${AUTO_MAX_S} 的整数` })
              return
            }
            interval = payload.interval
          }
          if (on) {
            auto.interval = interval
            if (!auto.on) {
              auto.on = true
              auto.startedAt = Date.now()
              auto.runs = 0
              auto.fails = 0
              auto.lastError = ''
            }
            persistAuto()
            // 有在途轮次时不重排；它结束后按新间隔排下一轮。
            if (!autoInFlightId) scheduleAuto(auto.interval * 1000)
          } else {
            auto.interval = interval
            stopAuto('')
          }
          sendJson(res, 200, { auto: autoSnapshot(), min: AUTO_MIN_S, max: AUTO_MAX_S, maxFails: AUTO_MAX_FAILS })
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
      return
    }
    // ── v3.340 控制台设置：通知自检的重复提交拦截窗（配置页可读写）──────────────
    // GET 走全局鉴权（Cookie/Bearer/?token= 均可读）；POST 只认 Bearer + JSON（写面防 CSRF）。
    // 落盘 <stateDir>/console-settings.json（0600 原子写），内存即时更新 ⇒ 下一次触发判定就生效。
    if (req.method === 'GET' && url.pathname === '/api/config/console') {
      // 可变设置不许被任何中间层/浏览器启发式缓存：保存后刷新必须拿到刚写入的值。
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, {
        schema: 1,
        revision: runtimeSettings.revision,
        updatedAt: runtimeSettings.updatedAt,
        source: settingsSource,
        settings: { notifyTestReplayWindowS: runtimeSettings.notifyTestReplayWindowS, syncShowDate: runtimeSettings.syncShowDate },
        defaults: { notifyTestReplayWindowS: CONSOLE_SETTINGS_DEFAULT_S, syncShowDate: true },
        min: NOTIFY_REPLAY_MIN_S,
        max: NOTIFY_REPLAY_MAX_S
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/config/console') {
      if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      if (!filterMediaAllowed(req)) {
        sendJson(res, 415, { error: 'unsupported_media_type', code: 'unsupported_media_type' })
        return
      }
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (shuttingDown) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
          if (aborted) { sendJson(res, 400, { error: '请求中断，动作未执行' }); return }
          if (over) { sendJson(res, 413, { error: '请求体超限' }); return }
          let payload
          try { payload = JSON.parse(body || '{}') } catch (e) { sendJson(res, 400, { error: 'invalid_json' }); return }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            sendJson(res, 400, { error: 'body 必须是对象' })
            return
          }
          // v3.342：两字段都是可选的「部分更新」，但至少要给一个；给了就必须严格合法——
          // 字符串 '60' / 1.5 / null / 越界 / 非布尔的显示开关全部拒绝，含糊接受会让
          // 「保存成功但生效值不是用户以为的那个」变成静默事故。
          const hasWin = Object.prototype.hasOwnProperty.call(payload, 'notifyTestReplayWindowS')
          const hasDate = Object.prototype.hasOwnProperty.call(payload, 'syncShowDate')
          if (!hasWin && !hasDate) {
            sendJson(res, 400, { error: '至少要提供 notifyTestReplayWindowS 或 syncShowDate 之一' })
            return
          }
          if (hasWin && (typeof payload.notifyTestReplayWindowS !== 'number' ||
            !Number.isInteger(payload.notifyTestReplayWindowS) ||
            payload.notifyTestReplayWindowS < NOTIFY_REPLAY_MIN_S ||
            payload.notifyTestReplayWindowS > NOTIFY_REPLAY_MAX_S)) {
            sendJson(res, 400, { error: `notifyTestReplayWindowS 必须是 ${NOTIFY_REPLAY_MIN_S}–${NOTIFY_REPLAY_MAX_S} 的整数` })
            return
          }
          if (hasDate && typeof payload.syncShowDate !== 'boolean') {
            sendJson(res, 400, { error: 'syncShowDate 必须是布尔值' })
            return
          }
          // 可选乐观锁：带了就必须是当前 revision，防两个标签页/两个人在设置页互相覆盖。
          if (Object.prototype.hasOwnProperty.call(payload, 'baseRevision') &&
            (typeof payload.baseRevision !== 'number' || !Number.isSafeInteger(payload.baseRevision) ||
              payload.baseRevision < 0 || payload.baseRevision !== runtimeSettings.revision)) {
            sendJson(res, 409, { error: 'revision_mismatch', revision: runtimeSettings.revision })
            return
          }
          const nextWin = hasWin ? payload.notifyTestReplayWindowS : runtimeSettings.notifyTestReplayWindowS
          const nextDate = hasDate ? payload.syncShowDate : runtimeSettings.syncShowDate
          // 同值保存不推进 revision、不重写文件：否则每点一次「保存」都会把别的标签页/手机上的
          // baseRevision 作废，它们下一次保存只能吃 409（页面还会显示「已被别处改过」）。
          if (nextWin === runtimeSettings.notifyTestReplayWindowS && nextDate === runtimeSettings.syncShowDate) {
            sendJson(res, 200, {
              ok: true,
              unchanged: true,
              revision: runtimeSettings.revision,
              updatedAt: runtimeSettings.updatedAt,
              settings: { notifyTestReplayWindowS: runtimeSettings.notifyTestReplayWindowS, syncShowDate: runtimeSettings.syncShowDate }
            })
            return
          }
          // 落盘成功才改内存：写失败（磁盘/权限）时内存保持旧值，页面不会显示一个
          // 重启后就消失的「已保存」。
          const next = {
            schema: 1,
            revision: runtimeSettings.revision + 1,
            updatedAt: Date.now(),
            notifyTestReplayWindowS: nextWin,
            syncShowDate: nextDate
          }
          if (!writeAtomic(settingsPath, JSON.stringify(next), '控制台设置')) {
            sendJson(res, 500, { error: '设置保存失败（磁盘/权限）' })
            return
          }
          runtimeSettings.revision = next.revision
          runtimeSettings.updatedAt = next.updatedAt
          runtimeSettings.notifyTestReplayWindowS = next.notifyTestReplayWindowS
          runtimeSettings.syncShowDate = next.syncShowDate
          settingsSource = 'file'
          sendJson(res, 200, {
            ok: true,
            revision: next.revision,
            updatedAt: next.updatedAt,
            settings: { notifyTestReplayWindowS: next.notifyTestReplayWindowS, syncShowDate: next.syncShowDate }
          })
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
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
          // 审查 #229 S7 / D1-N3：停止留痕进 run.log——被停任务不会有自然收尾的摘要行，
          // 控制台补一行 **CANCEL** 前缀的取消留痕（上海时区戳与写入侧 _localStamp 同形态）。
          // readRunHistory 把 CANCEL 行识别成「cancelled 占位条目」，既让这轮在历史里可见，
          // 又不参与 interrupted 判定（旧实现写 ERROR → 被回填成「下一轮中断」；#241 去掉
          // 回填后该轮又彻底消失，两种都错）。
          try {
            const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            const stamp = stampFmt.format(new Date())
            const stopDir = historyDir()
            fs.appendFileSync(path.join(stopDir, 'run.log'), `${stamp} CANCEL 控制台停止：任务 #${record.id}（${record.action}）于运行中被停止（SIGTERM）\n`, 'utf8')
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
  server.on('close', () => { disposeAuto(); killAll() })
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
        // 看门狗（D1-N1）：3s 内没等到 close ≠ 锁已释放——finishRun 只在 exit/close 里跑。
        // 孙进程持有 stdio 时 close 可能迟到数秒，而看门狗会先退出进程，锁就留到 10 分钟
        // 陈旧接管（重启后第一次触发 409）。这里对仍未收尾的记录补一次 finishRun：
        // 锁按 pid+token 双匹配作废，释放失败会走 finishRun 内的响亮告警。
        setTimeout(() => {
          for (const child of pending) {
            for (const record of runs.values()) {
              if (record._child === child && !record.finishedAt) finishRun(record, null)
            }
          }
          finishShutdown()
        }, 3000).unref()
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
  // v3.308（审查 #241 M1）：以运行侧 MessageStore.cacheDir 为唯一来源——控制台状态体系
  // （run.log / report.state / push.json / 锁）读的目录必须与运行侧真实写入目录一致；
  // 仅当应用配置加载失败、无法解析运行侧目录时退回 statusCacheDir()。
  const stateDir = consoleStateDir()
  if (!runtimeCacheDir()) {
    console.warn(`⚠️ 无法解析运行侧缓存目录（应用配置加载失败），控制台按 ${stateDir} 读取；` +
      '推送记录与运行历史可能不在该目录。')
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
  consoleStateDir,
  finishRun,
  renderUnauthorizedPage,
  isValidToken,
  timingSafeEqualStr,
  acquireLock,
  releaseLockFor,
  lockPath,
  parseAction,
  sessionCookieValue,
  themeCookieValue,
  SESSION_COOKIE,
  THEMES,
  escapeHtml,
  formatMs,
  renderPage,
  authorize,
  ACTIONS,
  TOKEN_MIN_LEN,
  RUN_LOG_MAX_BYTES,
  PROC_TIMEOUT_MS,
  // v3.326 日期区间：解析/过滤/统一时间窗入口（纯函数，非 HTTP 单测可达）
  parseDayKey,
  filterMessagesByRange,
  windowMessages,
  // v3.298 只读扩展：纯函数/常量导出（非 HTTP 单测 + 变异测试可达性）
  MESSAGES_MAX_BYTES,
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
  acceptsGzip,
  ACCESS_LOG_MAX,
  // D2-S13：最终保险丝（必须可被单测执行，否则又是一段不可达的死代码）
  findSecretLikeField,
  // D2-S12：cache-health 条数阈值（用例按同一常量构造夹具）
  CACHE_HEALTH_COUNT_MAX_BYTES,
  cacheHealthEntryCount,
  // v3.300 批次③ 3.2 消息导出：纯函数/常量导出（非 HTTP 单测 + 变异测试可达性）
  filterMessageItems,
  filterMessagesByDays,
  messageCategoriesOf,
  MESSAGE_DAYS_ALLOWED,
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
  ENTRY_SINGLE,
  // v3.340 控制台设置：常量导出（HTTP 用例用同一真源对账，避免测试自己写死 0/3600）
  CONSOLE_SETTINGS_FILE,
  CONSOLE_SETTINGS_DEFAULT_S,
  NOTIFY_REPLAY_MIN_S,
  NOTIFY_REPLAY_MAX_S,
  // 过滤规则控制面：常量/写鉴权/测试注入口（HTTP 用例 + 非 HTTP 断言）
  FILTER_BODY_MAX_BYTES,
  FILTER_PREVIEW_SCAN_MAX,
  FILTER_AUDIT_MAX_BYTES,
  FILTER_BACKUP_KEEP,
  writeAuthVerdict,
  setFilterDepsForTests,
  // 惰性依赖取用器（测试注入 zkt_gjc 等 Config 覆盖时以真实 deps 为基底）
  runtimeFilterDeps,
  // 陈旧锁接管的原子性单测入口（rename + inode 归属核验，见 claimStaleFilterLock 注释）
  filterLockIdentity,
  claimStaleFilterLock,
  previewWhitelistRegex,
  previewWhitelistKeeps
}
