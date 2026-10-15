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
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { readStatus, formatStatus, readTrends, readMessages, readMessageCount } = require('./status')
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

// ── v3.298 只读扩展常量 ─────────────────────────────────────────────────────
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

// 健康检查默认上限：entryMax 不取 DEFAULT_MAX_SIZE 常量而是运行侧 Config.cache.maxSize
// （MessageStore._resolveMaxSize 实际执行的口径）——常量在用户自定义 maxSize 时会展示
// 一个生产根本不执行的上限。Config 加载失败回退常量。
function defaultHealthLimits () {
  let entryMax = DEFAULT_MAX_SIZE
  try {
    const app = require('../xbk_function_v3')
    const ms = app && app.Config && app.Config.cache ? app.Config.cache.maxSize : null
    if (Number.isSafeInteger(ms) && ms > 0) entryMax = ms
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
  check: { entry: 'qinglong', args: ['--check'], label: '环境检查（不抓取不推送）' }
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
let runSeq = 0
// run ID = 单调序列，Map 重启即清空；「重启后旧 URL 命中新记录」的窗口由
// /api/runs/:id 的 404 文案（「进程重启后历史丢失」）向用户说明，不做持久化映射。

function startAction (actionKey, now, activeChildren) {
  const action = ACTIONS[actionKey]
  const id = ++runSeq
  const entryFile = action.entry === 'single' ? ENTRY_SINGLE : ENTRY_QINGLONG
  const record = {
    id,
    action: actionKey,
    label: action.label,
    startedAt: now,
    finishedAt: 0,
    exitCode: null,
    timedOut: false,
    output: ''
  }
  runs.set(id, record)
  if (runs.size > 20) {
    // 只保留最近 20 条：按 id 最小的清理（id 单调递增即最旧）。
    const oldest = [...runs.keys()].sort((a, b) => a - b).slice(0, runs.size - 20)
    for (const k of oldest) runs.delete(k)
  }
  // 环境继承：剥离 XBK_DRY_RUN（Sourcery High：控制台自身带 XBK_DRY_RUN=1 时，
  // 「正式运行」会被子进程静默降级为 dry-run，承诺的推送不会发生）；剥离
  // XBK_CONSOLE_TOKEN（子进程及其再拉起的工具、崩溃时的 env dump 都不该带控制台凭证）。
  const childEnv = { ...process.env }
  delete childEnv.XBK_DRY_RUN
  delete childEnv.XBK_CONSOLE_TOKEN
  const child = spawn(process.execPath, [entryFile, ...action.args], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (activeChildren) activeChildren.add(child)
  const decoder = new StringDecoder('utf8')
  const append = (chunk) => {
    // StringDecoder 处理跨 chunk 的多字节 UTF-8（Sourcery Medium：逐 chunk toString 产生替换符）。
    let buf = record.output + decoder.write(chunk)
    // 上限按 UTF-8 字节计（Buffer.byteLength），超限从字节边界近似回退丢头部。
    if (Buffer.byteLength(buf, 'utf8') > RUN_LOG_MAX_BYTES) {
      let drop = Buffer.byteLength(buf, 'utf8') - RUN_LOG_MAX_BYTES
      while (drop > 0 && buf.length > 0) {
        drop -= Buffer.byteLength(buf[0], 'utf8')
        buf = buf.slice(1)
      }
    }
    record.output = buf
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.on('error', (err) => {
    // spawn 失败（ENOENT 等）：不能让 uncaught 崩掉控制台（Sourcery Medium），
    // 也不能把 run 永久留在「运行中」。close 事件在 spawn error 后仍会触发，
    // 这里只登记原因，收尾交给 close。
    record.output += `\n[console] 子进程启动失败：${err && err.message ? err.message : String(err)}\n`
  })
  const timer = setTimeout(() => {
    record.timedOut = true
    try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
  }, PROC_TIMEOUT_MS)
  child.on('close', (code) => {
    clearTimeout(timer)
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

function serveStatic (res, spec) {
  let body
  try {
    body = fs.readFileSync(path.join(ASSETS_DIR, spec.file))
  } catch (e) {
    sendJson(res, 500, { error: '控制台前端资产缺失（仓库不完整？）' })
    return
  }
  res.writeHead(200, {
    'Content-Type': spec.type,
    // 资产更新随部署走：浏览器缓存但每次部署后 ETag 变化即失效。
    'Cache-Control': 'no-cache',
    ETag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
  })
  res.end(body)
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
<link rel="stylesheet" href="/assets/app.css">
<link rel="modulepreload" href="/assets/htm-preact.module.js">
</head><body>
<div id="app"><noscript>
<section style="max-width:60rem;margin:2rem auto;font-family:system-ui,sans-serif">
<h2>xbk-push 控制台（无脚本降级）</h2>
<pre>${statusLines.join('\n')}</pre>
<p>前端需要启用 JavaScript 才能使用触发与实时刷新。可用动作：试运行（抓取但不推送）、正式运行一轮（真实推送）、环境检查（不抓取不推送）。</p>
</section>
</noscript></div>
<script type="application/json" id="xbk-boot">${bootJson}</script>
<script type="module" src="/assets/app.js"></script>
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

function readBody (req, maxBytes = 4096) {
  return new Promise((resolve) => {
    let buf = ''
    let over = false
    let aborted = false
    req.on('data', (c) => {
      if (over) { req.destroy(); return } // Sourcery Medium：超限即断流，不再吸收内存
      buf += c.toString('utf8')
      if (buf.length > maxBytes) over = true
    })
    req.on('end', () => resolve({ body: buf, over, aborted }))
    // Sourcery Medium：error 时标记 aborted——残缺 body 不允许触发动作。
    req.on('error', () => { aborted = true; resolve({ body: buf, over, aborted }) })
    req.on('aborted', () => { aborted = true; resolve({ body: buf, over, aborted }) })
  })
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
  const read = readSafeTextResult(p, TOMBSTONE_MAX_BYTES)
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
  const all = []
  for (const d of dirents) {
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
  // 截断在排序前做：异常堆积目录（数千条目）先钳到上限再排序/保留，同步工作量有界
  // （截断按 readdir 序，纯展示面不保证「保留哪一千个」——truncated:true 已如实标注）。
  const truncated = all.length > FILES_LIST_MAX
  const kept = truncated ? all.slice(0, FILES_LIST_MAX) : all
  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { status: 'ok', total: all.length, truncated, files: kept }
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

function createConsole ({ token, stateDir, port = 0, host = '127.0.0.1', log = console.log, lockToken, messagesFile = 'push.json' }) {
  // Sourcery Missing-assets：资产文件缺失时服务照常启动 → 用户拿到可打开但永远白屏的
  // 控制台（JS 引入失败）。启动闸逐个校验白名单资产可读，缺任何一个 fail-closed 拒启。
  for (const [route, spec] of Object.entries(STATIC_ASSETS)) {
    const fp = path.join(ASSETS_DIR, spec.file)
    try {
      if (!fs.statSync(fp).isFile()) throw new Error('not a regular file')
      fs.accessSync(fp, fs.constants.R_OK)
    } catch (e) {
      throw new Error(`控制台前端资产缺失或不可读：${route} → ${spec.file}（仓库不完整？），拒绝启动（fail-closed）`)
    }
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
          if (v && typeof v === 'object' && typeof v.at === 'number' && typeof v.runId === 'number') {
            out.push([k, { at: v.at, runId: v.runId }])
          }
        }
      }
      return out
    } catch (e) { return [] }
  }
  // Sourcery Retries-duplicate x2：lastAccept 只在内存，重启后窗口失效 → 重试穿透再跑一轮。
  // 落盘到 stateDir/console-lastaccept.json（readStatus 同目录），受理时同步写、启动时回读。
  // 写入失败不阻断受理（主链路是单飞锁，落盘只是重放窗的持久化增强）。
  const lastAcceptPath = path.join(stateDir, 'console-lastaccept.json')
  try {
    for (const [k, v] of readLastAccept(lastAcceptPath)) lastAccept.set(k, v)
  } catch (e) { /* 文件不存在/损坏 = 空窗口，正常 */ }

  const server = http.createServer((req, res) => {
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
      serveStatic(res, STATIC_ASSETS[url.pathname])
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
      while (Buffer.byteLength(query, 'utf8') > MESSAGES_QUERY_MAX_BYTES) query = query.slice(0, -1)
      const needle = query.length > 0 ? query.toLowerCase() : ''
      let items = read.value.items
      if (cate.length > 0) {
        items = items.filter((m) => (typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)') === cate)
      }
      if (needle.length > 0) {
        items = items.filter((m) =>
          (typeof m.title === 'string' && m.title.toLowerCase().includes(needle)) ||
          (typeof m.content === 'string' && m.content.toLowerCase().includes(needle)))
      }
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
          const action = parseAction(body)
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
          // 受理顺序改为「实时读盘合并 → 记 pending 帧 → 同步落盘（失败即拒绝）→ acquireLock
          // → startAction → 补写真实 runId → 再落盘」。pending 帧（runId=0）本身就能拦截
          // 窗口内重试；spawn 前记录已持久化，进程在 spawn 后崩溃也有完整重放记录。
          const persisted = readLastAccept(lastAcceptPath)
          for (const [k, v] of persisted) {
            if (!lastAccept.has(k) || lastAccept.get(k).at < v.at) lastAccept.set(k, v)
          }
          const prev = lastAccept.get(action)
          if (prev && now - prev.at < REPLAY_WINDOW_MS) {
            sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试', runId: prev.runId > 0 ? prev.runId : undefined, replayBlocked: true })
            return
          }
          if (!acquireLock(stateDir, now, ownerToken)) {
            sendJson(res, 409, { error: '已有触发任务在运行（或锁未过期），请稍后再试' })
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
          const record = startAction(action, now, activeChildren)
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
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const list = [...runs.values()].sort((a, b) => b.id - a.id).map((r) => ({
        id: r.id,
        action: r.action,
        label: r.label,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        exitCode: r.exitCode,
        timedOut: r.timedOut
      }))
      sendJson(res, 200, { runs: list })
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
          const m = /(?:^|&)id=(\d+)/.exec(body)
          if (!m) { sendJson(res, 400, { error: '缺少数字 id' }); return }
          const record = runs.get(Number(m[1]))
          if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
          sendJson(res, 200, {
            id: record.id,
            action: record.action,
            label: record.label,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            exitCode: record.exitCode,
            timedOut: record.timedOut,
            output: record.output
          })
        })
        .catch(() => sendJson(res, 500, { error: '读取请求体失败' }))
      return
    }
    const runMatch = /^\/api\/runs\/(\d+)$/.exec(url.pathname)
    if (req.method === 'GET' && runMatch) {
      const record = runs.get(Number(runMatch[1]))
      if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
      sendJson(res, 200, {
        id: record.id,
        action: record.action,
        label: record.label,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        exitCode: record.exitCode,
        timedOut: record.timedOut,
        output: record.output
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
  return { server, runs, activeChildren, setShuttingDown, ownerToken, wireGracefulShutdown }
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
  TREND_DAYS_ALLOWED,
  TREND_DAYS_DEFAULT,
  FILES_LIST_MAX,
  CACHE_HEALTH_NEAR_RATIO
}
