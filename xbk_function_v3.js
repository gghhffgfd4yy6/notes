//* ******* 线报酷推送脚本 v3.322 — 控制台推送记录来源 pill 不再被 44px 原文链接拉伸 *********

/* eslint promise/param-names: off */ // new Promise(r => ...) 短参数名为项目既有风格

/* eslint no-control-regex: off, no-new: off */ // 控制字符正则用于脱敏、new RegExp 用于配置正则合法性验证（均有意）
// 按职责分层：配置 → 工具 → 格式化 → 规则 → 过滤 → 缓存 → 网络 → 推送 → 主流程

'use strict'

const crypto = require('node:crypto') // SonarCloud S7772：优先 node: 前缀内置模块
const os = require('node:os') // 内置模块零副作用，不影响「加载链零写盘」（批次④ 4.1：通知自检消息带主机名）

// ============================================================
// ⏱️ 启动性能诊断（仅 XBK_PROFILE=3 收集，不改变默认行为）
// ============================================================
const PROFILE3 = process.env.XBK_PROFILE === '3'
const PROFILE3_BOOT_START = process.hrtime.bigint()
const PROFILE3_BOOT_MARKS = []

// ReDoS 防护：优先用 Google RE2（线性时间无回溯）；不支持反向引用等特性时回落原生 RegExp。
let RE2C = null
try { RE2C = require('re2') } catch (e) { RE2C = null }
const _reCache = new Map()
// P1-04（收尾）：RE2 → V8 回落不再无声。safeRe 在生产热路径上被每条内部正则调用，逐条打印会刷屏，
// 故进程内只在**首次**回落时告警一次，内容含模式源码与失败原因，运维据此定位哪条模式失去线性防护。
// 通道沿用 RE2_MISSING_WARNING 的 console.warn；模式串与原因经既有脱敏通道
// xbk_failure_policy.summarizeError（redact 屏蔽凭据 + 折叠换行 + 截断）后再输出。
let _re2FallbackWarned = false
function warnRe2Fallback (src, error) {
  if (_re2FallbackWarned) return
  _re2FallbackWarned = true
  try {
    const pick = (value) => { const info = summarizeError(value); return typeof info.message === 'string' ? info.message.slice(0, 200) : '' }
    console.warn(`⚠️ RE2 编译失败，已回落 V8 原生 RegExp（RE2 的线性时间防护对该模式不成立）——模式：${pick(src)}；原因：${pick(error) || '未知原因'}`)
  } catch (e) { /* 告警自身失败不得影响回落路径 */ }
}
const safeRe = (src, flags) => {
  const k = src + '\u0000' + flags
  let r = _reCache.get(k)
  if (r) return r
  if (RE2C) { try { r = new RE2C(src, flags); _reCache.set(k, r); return r } catch (e) { warnRe2Fallback(src, e) /* 反向引用等不支持特性：回落 V8，但留一次告警 */ } }
  r = new RegExp(src, flags)
  _reCache.set(k, r)
  return r
}

// 用户配置正则不允许在缺少 RE2 时回退到 V8 原生 RegExp：复杂模式可能阻塞单线程事件循环。
// 内部固定正则仍由 safeRe() 处理；这里仅作为用户配置正则的编译闸门。
// ⚠️ RE2 兼容性（取舍说明）：RE2 为线性时间、无回溯，因此不支持 V8 的部分语法——
// 反向引用（/(a)\1/）、lookbehind（/(?<=x)/）、命名捕获组的部分写法等。
// 装了 re2 后，原本在 V8 下可用的这类用户正则可能编译失败被跳过（有告警），
// 表现为规则静默不生效；这是「防 ReDoS 卡死事件循环」的刻意取舍。
// 注意：未安装 re2 时用户配置正则同样会被跳过（不会回退 V8），不存在“不装就能用
// 反向引用/lookbehind”的选项——使用这些特性只能改写为 RE2 兼容语法。
function compileUserRegex (source, flags = 'i') {
  if (typeof source !== 'string' || !RE2C) return null
  try { return new RE2C(source, flags) } catch (e) { return null }
}

function isRe2Available () {
  return Boolean(RE2C)
}

const RE2_MISSING_WARNING = '⚠️ 当前环境未安装可用的 re2，用户过滤正则将被跳过，以避免 V8 原生 RegExp 阻塞事件循环。建议执行：npm install re2'

// 跨进程防重：re2 缺失提醒用按天命名的状态文件 + wx 独占创建（cron 每次运行为新进程，
// 仅靠进程内 flag 防不住每天多次提醒）；文件已存在 = 今天已提醒过，同一环境最多每天提醒一次。
const RE2_WARN_STATE_FILE = 're2warn.state'

function profile3NowMs () {
  return Number(process.hrtime.bigint() - PROFILE3_BOOT_START) / 1e6
}
function profile3BootMark (name) {
  if (PROFILE3) PROFILE3_BOOT_MARKS.push({ name, ms: profile3NowMs() })
}
function profile3Require (name, loader) {
  if (!PROFILE3) return loader()
  const started = profile3NowMs()
  const value = loader()
  const now = profile3NowMs()
  PROFILE3_BOOT_MARKS.push({ name: `require:${name}`, ms: now, deltaMs: now - started })
  return value
}

// ============================================================
// 📦 外部依赖
// ============================================================
const fs = profile3Require('fs', () => require('node:fs'))
const { fetchJson } = profile3Require('xbk_http', () => require('./xbk_http'))
const { prewarmDns, prewarmTls } = profile3Require('xbk_agents', () => require('./xbk_agents'))
const { isRegularOrMissing, readSafeTextResult, writeAtomic, writeAtomicIfAbsent } = profile3Require('xbk_storage', () => require('./xbk_storage'))
const { summarizeError, RETRYABLE_CODES } = profile3Require('xbk_failure_policy', () => require('./xbk_failure_policy'))
const path = profile3Require('path', () => require('path'))
// 版本号一致性由 package.json、文件头和 CHANGELOG 的测试自动校验
// 缺 package.json、坏 JSON 或 version 字段非法（null/空串/非字符串且非有限数值）时回退 '3.x'（移植性防御）
let PKG_VERSION = '3.x'
try { const v = profile3Require('package.json', () => require('./package.json')).version; PKG_VERSION = (typeof v === 'string' && v.trim() !== '') ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '3.x') } catch (e) { /* package.json 缺失/坏 JSON 时用默认 */ }

// 推送模块（xbk_sendNotify_slim → got）是启动最重的依赖（约 300ms）。
// 主流程只在真正推送前才用到它——延迟到接口返回后再加载（首推前），
// 与接口拉取并行进行，减少冷启动路径上的串行等待。
// 测试（test_app/test_filter）在 require 主模块前预置 require.cache mock——
// 若模块尚未加载，延迟加载会在推送阶段才命中 mock 缓存（require.cache 已就绪），
// 语义一致；这里保留顶层同步 require 兼容性探测：同步加载过的直接复用。
let notify = null
let notifyLoading = null
function getNotify () {
  if (notify) return Promise.resolve(notify)
  if (!notifyLoading) {
    // 只检查已加载的缓存，不能用 require() 探测：require() 本身会同步执行模块，
    // 那样会在接口请求发出前加载推送模块，直接抵消延迟加载收益。
    let notifyPath
    try {
      notifyPath = require.resolve('./xbk_sendNotify_slim')
    } catch (e) {
      // v3.235：模块缺失时不在此同步抛（曾导致 getNotify() 同步崩溃、.catch 来不及接住，
      // 主流程中断）——与旧行为一致，延迟到推送阶段以 promise 形式真实报错。
      notifyLoading = Promise.resolve().then(() => profile3Require('xbk_sendNotify_slim', () => require('./xbk_sendNotify_slim')))
        .then((mod) => { notify = mod; return notify })
        .catch((err) => { notifyLoading = null; throw err })
      return notifyLoading
    }
    const cached = require.cache[notifyPath]
    if (cached && cached.loaded && cached.exports) {
      notify = cached.exports
      return Promise.resolve(notify)
    }
    // 真实模式：接口请求已发出后再在微任务中同步 require，加载与网络并行；
    // 主流程不等待它（首推前 await getNotify() 才汇合）。
    notifyLoading = Promise.resolve().then(() => profile3Require('xbk_sendNotify_slim', () => require(notifyPath)))
      .then((mod) => { notify = mod; return notify })
      .catch((e) => { notifyLoading = null; throw e })
  }
  return notifyLoading
}

// ============================================================
// ⚙️ Config — 配置层
// ============================================================
const Config = {
  domain: 'https://new.ixbk.net',

  api: {
    // v3.94：domain 尾斜杠防御——`https://x.com/` + 路径曾拼成 `//plus/...` 双斜杠 404
    // R2：domain 非字符串（数字/对象脏配置）→ 空串（避免 getter 内 .replace 崩溃）
    get pushUrl () { return `${(typeof Config.domain === 'string' ? trimTrailingSlashes(Config.domain.trim()) : '')}/plus/json/push.json` }, // v3.158: domain trim
    timeout: 5000,
    retry: 2
  },

  filter: {
    // v3.176：默认不再携带个人过滤配置（'美妆' 曾硬编码于此——克隆用户意外继承屏蔽）。
    // 需要屏蔽分类请自行配置，例如：pingbifenlei: '美妆'
    pingbifenlei: '',
    pingbibiaoti: '',
    zhanxianbiaoti: '',
    pingbibiaotiplus: '',
    pingbineirong: '',
    zhanxianneirong: '',
    pingbineirongplus: '',
    pingbilouzhu: '',
    zhanxianlouzhu: '',
    pingbilouzhuplus: '',
    pingbitime: '5'
  },

  keyword: {
    zkt_gjc: ''
  },

  timing: {
    // pushInterval：推送间隔（毫秒）。顺序模式=全局逐条间隔；并行模式=每 worker 完成后的补位间隔
    // （并行全局速率 = parallelLimit × interval；20 条量级 + 自动重试兜底，不构成频控问题——已知取舍）
    pushInterval: 0,
    finalWait: 0
  },

  // 推送模式：sequential=顺序逐条 | parallel=并行滑动窗口(默认)
  // parallelLimit：并发上限；并行模式下完成一条立即补下一条，0=按消息总数作为窗口
  // titleMax/contentMax：推送截断长度（v3.69 可配置；各通道 API 限制不一，如 Server酱 title 限 32 字符）
  push: {
    mode: 'parallel',
    parallelLimit: 10,
    titleMax: 100,
    contentMax: 3000,
    // v3.129：单次推送上限（防接口异常返回海量 → 推送风暴/长时间运行；正常 ~20 条无影响）
    maxPerRun: 100
  },

  // 推送模板（v3.68 可配置）：title=标题、content=内容；默认值与历史硬编码完全一致。
  // 支持占位符：{分类名} {分类ID} {标题} {链接} {日期} {时间} {楼主} {类目} {价格} {商城} {品牌} {图片} {Html内容} {Markdown内容}
  template: {
    title: '【{分类名}】{标题}',
    content: '{Markdown内容}'
  },

  cache: {
    // v3.120 上限 100 → 10000：真实接口 N 固定 ~20 条，查询量 N×M=20 万次可接受（实测 35ms）
    maxSize: 10000,
    dir: 'xianbaoku_cache'
  },

  // v3.123：接口异常告警——接口挂/密钥失效时主动通知本人（防"跑了但没推没人知道"）
  // enabled: 开关；intervalMs: 限频（同错误间隔内不重复轰炸，默认 1 小时）
  alert: {
    enabled: true,
    intervalMs: 3600000
  },

  // v3.125：运行日报——每天一条推送汇总（前一天统计），不用翻 run.log
  report: {
    enabled: true
  },

  // 通道健康：仅记录正常线报推送的通道结果；健康告警自身不反哺状态，避免告警递归。
  channelHealth: {
    enabled: true,
    consecutiveFailures: 3,
    intervalMs: 3600000
  },

  // 过滤诊断：每轮将屏蔽/保护决策追加到缓存目录的 NDJSON 文件，供跨轮排查。
  diagnostics: {
    filterLog: {
      enabled: true,
      maxDetailsPerRun: 100,
      includePassed: false
    }
  },

  // 磁盘余量监测：仅告警，不阻断推送；不支持 statfs 的旧 Node/平台自动跳过。
  storage: {
    minFreeBytes: 50 * 1024 * 1024
  }
}

// ============================================================
// 🔧 Utils — 工具层
// ============================================================
const {
  FILTER_FIELDS,
  DEFAULT_MAX_SIZE,
  STATE_TEXT_MAX_BYTES,
  MESSAGE_CACHE_MAX_BYTES,
  TOMBSTONE_MAX_KEYS,
  TOMBSTONE_MAX_BYTES,
  TOMBSTONE_LOCK_STALE_MS,
  trimTrailingSlashes,
  normalize,
  createUtils
} = profile3Require('xbk_utils', () => require('./xbk_utils'))
const Utils = createUtils({ fs, safeRe })
// Utils 内部调用链（含 _decodeNumeric）由此单例承载；_decodeNumeric 仍由 Utils.decodeHtmlEntities 调用。

// ============================================================
// 🔄 Formatter — 格式化层（纯函数，不修改输入参数）
// ============================================================
const { createFormatter } = profile3Require('xbk_formatter', () => require('./xbk_formatter'))
const Formatter = createFormatter({ Utils, safeRe })

// ============================================================
// 📐 RuleEngine — 规则引擎层
// ============================================================
const { createRuleEngine } = profile3Require('xbk_rules', () => require('./xbk_rules'))
const RuleEngine = createRuleEngine({ Utils, FILTER_FIELDS, compileUserRegex, isRe2Available })

// ============================================================
// 🎯 FilterEngine — 过滤引擎层
// ============================================================
const { createFilterEngine } = profile3Require('xbk_filter', () => require('./xbk_filter'))
const FilterEngine = createFilterEngine({ Utils, RuleEngine, FILTER_FIELDS, compileUserRegex })

// ============================================================
// 💾 MessageStore — 缓存管理层
// ============================================================
const { createMessageStore } = profile3Require('xbk_message_store', () => require('./xbk_message_store'))
const MessageStore = createMessageStore({
  Config,
  Utils,
  fs,
  path,
  crypto,
  normalize,
  storage: { readSafeTextResult, writeAtomic, writeAtomicIfAbsent, isRegularOrMissing },
  constants: {
    DEFAULT_MAX_SIZE,
    MESSAGE_CACHE_MAX_BYTES,
    TOMBSTONE_MAX_KEYS,
    TOMBSTONE_MAX_BYTES,
    TOMBSTONE_LOCK_STALE_MS
  }
})

// ============================================================
// 🌐 Network — 网络请求层
// ============================================================
const { createNetwork } = profile3Require('xbk_network', () => require('./xbk_network'))
const Network = createNetwork({
  Config,
  Utils,
  fetchJson,
  prewarmDns,
  getNotify,
  crypto,
  RETRYABLE_CODES,
  PKG_VERSION,
  PROFILE3,
  logger: console
})

// ============================================================
// 📤 Pusher — 推送层
// ============================================================
const { createPusher, looksLikeHtmlLinear } = profile3Require('xbk_pusher', () => require('./xbk_pusher'))
const Pusher = createPusher({ Utils, getNotify, looksLikeHtmlLinear })
// ============================================================
// 🗂️ FilterStore — 过滤规则覆盖文件存储层
// ============================================================
// 只读存储层（不反向 require 本文件，避免循环依赖）；App.run 每轮调用一次 loadFilterRules。
const FilterStore = profile3Require('xbk_filter_store', () => require('./xbk_filter_store'))

// ============================================================
// 🚀 App — 主流程层
// ============================================================
const { createApp } = profile3Require('xbk_app', () => require('./xbk_app'))
const App = createApp({
  Config,
  Utils,
  Formatter,
  RuleEngine,
  FilterEngine,
  MessageStore,
  FilterStore,
  Network,
  Pusher,
  fs,
  path,
  crypto,
  readSafeTextResult,
  writeAtomic,
  isRegularOrMissing,
  STATE_TEXT_MAX_BYTES,
  DEFAULT_MAX_SIZE,
  RE2C,
  RE2_WARN_STATE_FILE,
  RE2_MISSING_WARNING,
  summarizeError,
  PROFILE3,
  PROFILE3_BOOT_MARKS,
  prewarmDns,
  prewarmTls,
  getNotify,
  PKG_VERSION,
  trimTrailingSlashes,
  compileUserRegex
})
profile3BootMark('module-load-complete') // 时点：全部本地模块 require 与工厂构造之后（此前放在文件头版本兜底处，会让 boot 画像漏计这段装配耗时）

async function runSingleEntry (app = App) {
  const summary = await app.run()
  // 单次入口与常驻入口统一失败语义：App.run 保持返回摘要兼容，
  // 但待推送项全部失败时设置非零退出码，不能让调度器误认为成功。
  try {
    const { classifySummary } = require('./xbk_failure_policy')
    const decision = classifySummary(summary)
    if (decision) {
      console.error(`程序运行失败（${decision.reason}）：${decision.kind === 'permanent' ? '不可恢复' : '可重试'}`)
      process.exitCode = 1
    }
  } catch (e) {
    // 失败分类模块异常时保守设置非零，避免全失败被静默吞掉。
    // P3（审查 2026-09-15）：原实现只置非零、不输出任何信息，调度器只能看到「退出码 1
    // 但日志里没有失败原因」，无法与「确实失败」区分。与非零退出码同点补一条诊断。
    console.error('失败分类判定异常，保守置非零退出码:', Utils.safeErrorText(e, Utils.safeText(e, '未知错误')))
    process.exitCode = 1
  }
  return summary
}

// provider 返回的错误文本即使经过 safeErr 脱敏仍可能含 ANSI/OSC 终端控制序列（可清屏、
// 改标题）——自检在终端跑，所有打印前必须剥掉。D2-S14：旧实现只剥了成功路径的
// `✅/❌` 行，main guard 的 catch（失败汇总）原样打印，provider 仍能控制终端。
// 模块级而非 runNotifyTest 内局部：失败路径也要用同一实现。
const stripTerminalCtrl = (s) => String(s)
  // OSC 序列：ESC ] … 直到 BEL 或 ST（ESC \）
  .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
  // CSI 序列：ESC [ 参数字节…终止字节
  .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  // 残余 C0/C1 控制字符（TAB/换行除外）
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')

// ── 通知自检（批次④ 4.1）：纯推送面动作，绝不触发抓取/写缓存/写 run.log ──
// 只允许出现在直跑入口 main guard 的早退分支；落入 runSingleEntry 会真跑一轮。
// args 参数化（默认 process.argv.slice(2)）供进程内测试注入，避免改全局 argv。
async function runNotifyTest (args = process.argv.slice(2)) {
  // 防线7 互斥（fail-closed）：自检是真实发送，拒绝在 dry-run 语义下执行。
  // argv 与 env 双查：qinglong 入口以 XBK_DRY_RUN=1 表达 dry-run，一并拒绝防语义混淆。
  // D2-S15：环境变量判据必须与真实运行同一口径（xbk_app.js 只在 === '1' 时进 dry-run）。
  // 旧实现把任何非空串（XBK_DRY_RUN=0/false/no）都当 dry-run，于是「显式关闭 dry-run」
  // 的部署反而自检被拒、普通运行却真跑——同一变量两种语义。
  if (args.includes('--dry-run') || process.env.XBK_DRY_RUN === '1') {
    console.error('❌ --notify-test 与 --dry-run 互斥：通知自检是真实发送动作，拒绝执行（fail-closed）')
    process.exitCode = 1
    return
  }
  const notify = await getNotify() // 缺 got 时以 promise reject 冒泡 → 顶层 catch（脱敏后提示部署命令）
  // 固定测试消息：标题 + 版本 + 上海戳（与 xbk_app._localStamp 同款 sv-SE/Asia/Shanghai 口径，
  // console.js cancel 留痕同形态）+ 主机名——用户可核对到达时间与来源机器。
  const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const title = 'xbk-push 通知自检'
  const desp = `版本 v${PKG_VERSION}\n时间：${stampFmt.format(new Date())}（Asia/Shanghai）\n主机：${os.hostname()}\n\n收到本条仅代表该渠道送达（--notify-test 会对每个渠道各发一条；其他渠道是否成功以命令行汇总为准）。内容固定，不含线报数据。`
  // 防线4 HITOKOTO 抑制：开关只读模块级 push_config.HITOKOTO（slim 开启条件 true/'true'），
  // 临时置禁 + finally 恢复；自检消息必须内容固定且零额外外部请求。push_config 是 slim 导出的同一活对象。
  const savedHitokoto = notify.push_config.HITOKOTO
  notify.push_config.HITOKOTO = 'false'
  let result
  try {
    // 防线3 单次广播：sendNotify 一次调用 allSettled 并发全渠道，每渠道恰一份。
    // 逐渠道循环 Pusher.send 会让每渠道收 N 份——绝不可循环。
    result = await Pusher.send(title, desp)
  } finally {
    notify.push_config.HITOKOTO = savedHitokoto
  }
  // 结果汇总（防线5）：successfulChannels/failures 直接送渠道粒度（sendNotify 返回形态），
  // failures[].message 已是 slim safeErr 脱敏产物；禁止 console.log(e)/JSON.stringify(e)。
  const okChannels = Array.isArray(result && result.successfulChannels) ? result.successfulChannels : []
  const failures = Array.isArray(result && result.failures) ? result.failures : []
  console.log(`通知自检完成：成功 ${okChannels.length} 个渠道，失败 ${failures.length} 个渠道`)
  for (const ch of okChannels) console.log(`  ✅ ${stripTerminalCtrl(ch)}`)
  for (const f of failures) {
    const status = f && f.statusCode ? `（HTTP ${f.statusCode}）` : ''
    console.log(`  ❌ ${stripTerminalCtrl((f && f.channel) || '未知渠道')}：${stripTerminalCtrl((f && (f.message || f.code)) || '发送失败')}${status}`)
  }
  // 退出码口径 D3：≥1 渠道成功 → 0；否则 1（全失败路径走不到这里——sendNotify 抛
  // ALL_CHANNELS_FAILED/NO_CHANNEL_CONFIG → 顶层 catch；此处兜底空数组形态）。
  process.exitCode = okChannels.length > 0 ? 0 : 1
}

if (require.main === module) {
  const cliArgs = process.argv.slice(2)
  // 审查 D2-M2（#232）：旧实现只认精确的 `--notify-test`，`--notify-test=1` 这类近似写法
  // 会静默落进 runSingleEntry() —— 生产上就是真抓取 + 真推送 + 写缓存。改为前缀分发；
  // 其余未识别的 `--` 参数一律 fail-closed，绝不让拼写错误变成一次真实运行。
  const notifyArg = cliArgs.find((a) => a === '--notify-test' || a.startsWith('--notify-test='))
  if (notifyArg) {
    // 批次④ 4.1：通知自检早退分支——必须在 runSingleEntry() 之前分发，
    // 否则掉进完整抓取/推送/缓存流程（自检变成真跑一轮）。
    runNotifyTest(cliArgs).catch(e => {
      // 统一脱敏出口：summarizeError 承诺不抛且 message 已 redact + 截断；
      // 绝不 console.log(e)/JSON.stringify(e)（error.options/response 可能带 URL query 凭证）。
      const { summarizeError } = require('./xbk_failure_policy')
      const info = summarizeError(e)
      console.error(`通知自检失败：${stripTerminalCtrl(info.message || '未知错误')}`)
      if (Array.isArray(info.failures)) {
        for (const f of info.failures) {
          const status = f && f.statusCode ? `（HTTP ${f.statusCode}）` : ''
          console.error(`  ❌ ${stripTerminalCtrl((f && f.channel) || '未知渠道')}：${stripTerminalCtrl((f && (f.message || f.code)) || '发送失败')}${status}`)
        }
      }
      if (info.name === 'MODULE_NOT_FOUND' || /Cannot find module/.test(info.message || '')) {
        console.error('依赖缺失：请先执行 npm ci --omit=dev --ignore-scripts')
      }
      process.exitCode = 1
    })
  } else if (cliArgs.some((a) => a.startsWith('--'))) {
    const unknown = cliArgs.filter((a) => a.startsWith('--'))
    console.error(`❌ 未识别参数：${unknown.join(' ')}；直跑入口仅支持 --notify-test（试运行请用 XBK_DRY_RUN=1 环境变量），拒绝执行（fail-closed）`)
    process.exitCode = 1
  } else {
    runSingleEntry().catch(e => {
      console.error('程序运行失败:', Utils.safeErrorText(e, Utils.safeText(e, '未知错误')))
      process.exitCode = 1
    })
  }
}

// ============================================================
// 📤 导出（供测试用）
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    listfilter: FilterEngine.listfilter.bind(FilterEngine),
    explainFilter: FilterEngine.explainFilter.bind(FilterEngine),
    filterByKeyword: FilterEngine.filterByKeyword.bind(FilterEngine),
    validateConfig: RuleEngine.validateConfig.bind(RuleEngine),
    tuisong_replace: Formatter.tuisong_replace.bind(Formatter),
    htmlToMarkdown: Formatter.htmlToMarkdown.bind(Formatter),
    looksLikeHtmlLinear,
    isMessageInFile: MessageStore.has.bind(MessageStore),
    appendMessageToFile: MessageStore.save.bind(MessageStore),
    getFileName: MessageStore.getFileName.bind(MessageStore),
    fetchData: Network.fetchData.bind(Network),
    // 主流程（集成测试用）
    run: App.run.bind(App),
    runSingleEntry,
    runNotifyTest,
    // 推送层（测试/扩展用）
    Pusher,
    // 补充导出（供更全面的测试）
    whitelistFilter: FilterEngine.whitelistFilter.bind(FilterEngine),
    compileRules: RuleEngine.compileRules.bind(RuleEngine),
    matchesCompiled: RuleEngine.matchesCompiled.bind(RuleEngine),
    checkTimeCompiled: RuleEngine.checkTimeCompiled.bind(RuleEngine),
    saveBatch: MessageStore.saveBatch.bind(MessageStore),
    init: MessageStore.init.bind(MessageStore),
    decodeHtmlEntities: Utils.decodeHtmlEntities.bind(Utils),
    filterHash: Utils.filterHash.bind(Utils),
    anonKey: Utils.anonKey.bind(Utils),
    hasValidId: Utils.hasValidId.bind(Utils),
    getMessageIdentity: Utils.getMessageIdentity.bind(Utils),
    normUrl: Utils.normUrl.bind(Utils),
    safeUrl: Utils.safeUrl.bind(Utils),
    validUrl: Utils.validUrl.bind(Utils),
    daysComputed: Utils.daysComputed.bind(Utils),
    // 过滤子方法
    checkRegisterTime: FilterEngine.checkRegisterTime.bind(FilterEngine),
    checkCategory: FilterEngine.checkCategory.bind(FilterEngine),
    checkFields: FilterEngine.checkFields.bind(FilterEngine),
    // 规则解析内部方法
    _splitLines: RuleEngine._splitLines.bind(RuleEngine),
    // UTF-16 安全截断（代理对感知）
    truncateUtf16: Utils.truncateUtf16.bind(Utils),
    // 统一数值配置转换（供常驻入口复用，保持字符串环境变量与主流程同一语义）
    num: Utils.num.bind(Utils),
    safeText: Utils.safeText.bind(Utils),
    safeErrorText: Utils.safeErrorText.bind(Utils),
    sanitizeDecodedHtml: Utils.sanitizeDecodedHtml.bind(Utils),
    // ReDoS 防护检测（嵌套量词）
    hasNestedQuantifier: RuleEngine.hasNestedQuantifier.bind(RuleEngine),
    // 过滤规则覆盖文件的读路径深度校验（console GET / qinglong --check 与 App.run 同口径）
    compileUserRegex,
    _normalizeReInput: RuleEngine._normalizeReInput.bind(RuleEngine),
    // 缓存内部方法
    getFilePath: MessageStore.getFilePath.bind(MessageStore),
    _ensureFileExists: MessageStore._ensureFileExists.bind(MessageStore),
    readMessages: MessageStore.readMessages.bind(MessageStore),
    saveMessages: MessageStore.saveMessages.bind(MessageStore),
    Config,
    // v3.258：导出 App 供测试直接打内部方法（_enabledFlag 等纯函数）
    App,
    // P4（CodeAnt）：导出 MessageStore 供墓碑身份一致性测试直接验证四类身份 × 各判重入口
    MessageStore
  }
}
