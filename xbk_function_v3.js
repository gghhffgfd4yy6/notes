//* ******* 线报酷推送脚本 v3.236 — 缓存恢复写入异常降级修复 ********

/* eslint promise/param-names: off */ // new Promise(r => ...) 短参数名为项目既有风格

/* eslint no-control-regex: off, no-new: off */ // 控制字符正则用于脱敏、new RegExp 用于配置正则合法性验证（均有意）
// 按职责分层：配置 → 工具 → 格式化 → 规则 → 过滤 → 缓存 → 网络 → 推送 → 主流程

'use strict'

// ============================================================
// ⏱️ 启动性能诊断（仅 XBK_PROFILE=3 收集，不改变默认行为）
// ============================================================
const PROFILE3 = process.env.XBK_PROFILE === '3'
const PROFILE3_BOOT_START = process.hrtime.bigint()
const PROFILE3_BOOT_MARKS = []
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
const fs = profile3Require('fs', () => require('fs'))
const { fetchJson } = profile3Require('xbk_http', () => require('./xbk_http'))
const { prewarmDns, prewarmTls } = profile3Require('xbk_agents', () => require('./xbk_agents'))
const { isRegularOrMissing, readSafeTextResult, writeAtomic } = profile3Require('xbk_storage', () => require('./xbk_storage'))
const { summarizeError } = profile3Require('xbk_failure_policy', () => require('./xbk_failure_policy'))
const path = profile3Require('path', () => require('path'))
// 版本号一致性由 package.json、文件头和 CHANGELOG 的测试自动校验
// 缺 package.json 时回退 '3.x'（移植性防御）
let PKG_VERSION = '3.x'
try { PKG_VERSION = profile3Require('package.json', () => require('./package.json')).version } catch (e) { /* package.json 缺失时用默认 */ }
profile3BootMark('module-load-complete')

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
    get pushUrl () { return `${(typeof Config.domain === 'string' ? Config.domain.trim().replace(/\/+$/, '') : '')}/plus/json/push.json` }, // v3.158: domain trim
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

  // 磁盘余量监测：仅告警，不阻断推送；不支持 statfs 的旧 Node/平台自动跳过。
  storage: {
    minFreeBytes: 50 * 1024 * 1024
  }
}

// ============================================================
// 🔧 Utils — 工具层
// ============================================================

// ---------- 过滤正则字段（compileRules/validateConfig 共用，加字段改一处） ----------
const FILTER_FIELDS = [
  'pingbifenlei', 'pingbibiaoti', 'zhanxianbiaoti',
  'pingbibiaotiplus', 'pingbineirong', 'zhanxianneirong',
  'pingbineirongplus', 'pingbilouzhu', 'zhanxianlouzhu',
  'pingbilouzhuplus'
]

// ---------- 魔法数字常量 ----------
const DAY_MS = 24 * 60 * 60 * 1000 // 一天的毫秒数
const TS_BOUND = 1e11 // 秒/毫秒时间戳分界（10位秒 / 12+位毫秒）
const MAX_CODE_POINT = 0x10FFFF // Unicode 最大码点
const SURROGATE_LO = 0xD800 // 代理区起点
const SURROGATE_HI = 0xDFFF // 代理区终点
const DEFAULT_MAX_SIZE = 10000 // 缓存默认上限（v3.120：100 → 10000）
// 状态/哈希文件体积上限：alert.state/report.state/filter.hash 均为数百字节级小文件，
// 强制大小上限防止异常膨胀文件被整读入内存（readSafeTextResult 的 maxBytes 兜底）。
const STATE_TEXT_MAX_BYTES = 64 * 1024

// ---------- HTML 实体映射（避免每次调用重建） ----------
const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&hellip;': '…',
  '&mdash;': '—',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&euro;': '€',
  '&times;': '×',
  '&divide;': '÷',
  '&middot;': '·',
  '&deg;': '°',
  '&plusmn;': '±',
  '&laquo;': '«',
  '&raquo;': '»',
  '&ndash;': '–',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&bull;': '•',
  '&sect;': '§',
  '&para;': '¶',
  '&pound;': '£',
  '&yen;': '¥',
  // v3.83 扩展：高频遗漏实体（空白变体与箭头/货币符号）
  '&ensp;': ' ',
  '&emsp;': ' ',
  '&cent;': '¢',
  '&curren;': '¤',
  '&larr;': '←',
  '&rarr;': '→',
  '&uarr;': '↑',
  '&darr;': '↓'
}
// v3.239：实体名先转义正则元字符（. * + ? ( ) [ ] { } | \ $ ^ 等）——实体名含元字符时曾产出错误/失效正则
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ENTITY_RE = new RegExp('&(?:' + Object.keys(ENTITY_MAP).map(k => escapeRe(k.slice(1, -1))).join('|') + ');', 'g') // 从 ENTITY_MAP 自动生成，加实体只改一处
const DEC_RE = /&#(\d+);/g
const HEX_RE = /&#[xX]([0-9a-fA-F]+);/g

// 键序无关规范化：递归排序对象键，避免 JSON.stringify 比较对键顺序敏感（数组顺序保留）
function normalize (o) {
  if (Array.isArray(o)) return o.map(normalize)
  if (o && typeof o === 'object') {
    const out = {}
    for (const k of Object.keys(o).sort()) Object.defineProperty(out, k, { value: normalize(o[k]), enumerable: true, writable: true, configurable: true })
    return out
  }
  return o
}

const Utils = {
  // ==================== 时间工具 ====================
  /**
     * 统一时间解析：返回毫秒时间戳，无效返回 null。
     * v3.62 统一 daysComputed/tuisong_replace 两份重复逻辑（REVIEW_ROUND10 #26），
     * 解析口径（与 v3.46/v3.47 对齐后的行为完全一致）：
     *   空(undefined/null/'') → null
     *   纯数字：8 位 YYYYMMDD(月份/日期合法性+回读校验) > 秒/毫秒时间戳(0 或 1e8~1e14，TS_BOUND 分界)
     *           > 范围外(小数字/超大数字) → null（避免 1970-01-01/33658 误导日期）
     *   YYYY-MM-DD(1~2 位月日，锚定结尾拒绝脏前缀，回读校验拒绝 2026-02-31) > 回读失败 → null
     *   其他(含 ISO 2026-08-01T00:00:00Z、/ 分隔)：宿主解析，先原生(支持 ISO)失败再试 / 替换 → 失败 null
     * 注意：返回的 ms 可能为负（1969 年以前），由调用方决定语义。
     */
  parseTime (time) {
    if (time === undefined || time === null || time === '') return null
    let s
    try { s = String(time) } catch (e) { return null } // v3.108 fuzz：嵌套 Symbol 数组 String() 崩 → 无效
    // 纯数字：8 位日期优先于时间戳（20260731 是日期不是时间戳）
    // 数字类型（含 -1 等负值）也走数字分支——负值/范围外在下方统一判无效，
    // 避免掉进宿主解析被 new Date('-1') 解析成 2001-01-01（审查5-2 锁定）
    // v3.142：数字形态字符串（含负号/小数）也走数字分支——'-1'/'2026.5' 曾漏到宿主解析成 2001/2026-05
    if (typeof time === 'number' || /^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s)
      // 8 位 YYYYMMDD：月份 1~12 / 日期 1~31 预检 + 回读校验（拒绝 20261332 这类非法日期）
      // v3.115 时区修复：Date.UTC 解析——日期是"日粒度"概念，本地时区解析会导致跨时区部署天数差 1（Honolulu 实测）
      const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/)
      if (m8 && Number(m8[2]) >= 1 && Number(m8[2]) <= 12 && Number(m8[3]) >= 1 && Number(m8[3]) <= 31) {
        const t = new Date(Date.UTC(+m8[1], +m8[2] - 1, +m8[3]))
        if (t.getUTCFullYear() === +m8[1] && t.getUTCMonth() === +m8[2] - 1 && t.getUTCDate() === +m8[3]) return t.getTime()
        return null
      }
      // 严格八位数字优先按 YYYYMMDD 解释；非法八位日期不能继续落入 n===0 的 Unix 时间戳分支。
      if (/^\d{8}$/.test(s)) return null
      // 时间戳：0 = 1970-01-01 不应被短路；秒(1e8~TS_BOUND)/毫秒(TS_BOUND~1e14)按 TS_BOUND 分界
      if (n === 0 || (n >= 1e8 && n < 1e14)) {
        const ms = n < TS_BOUND ? n * 1000 : n
        const t = new Date(ms)
        if (!isNaN(t.getTime())) return t.getTime()
      }
      return null
    }
    // 显式解析无时区的日期时间（含单数字月日），统一按 UTC，不再落入宿主本地时区。
    const dateTime = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/)
    if (dateTime) {
      const y = +dateTime[1]; const mo = +dateTime[2]; const d = +dateTime[3]
      const hh = +dateTime[4]; const mm = +dateTime[5]; const ss = dateTime[6] === undefined ? 0 : +dateTime[6]
      const ms = dateTime[7] === undefined ? 0 : +(dateTime[7] + '00').slice(0, 3)
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null
      const t = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss, ms))
      if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d &&
                t.getUTCHours() === hh && t.getUTCMinutes() === mm && t.getUTCSeconds() === ss) {
        return t.getTime()
      }
      return null
    }

    // v3.115 时区修复：Date.UTC 解析（同 8 位日期）
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (m) {
      const y = +m[1]; const mo = +m[2]; const d = +m[3]
      const t = new Date(Date.UTC(y, mo - 1, d))
      // 回读校验：new Date 会把 2026-02-31 滚动到 03-03，回读对比即拒绝
      if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return t.getTime()
      return null
    }
    // 其他格式（含 ISO 2026-08-01T00:00:00Z、/ 分隔等）回退宿主解析；先原生（支持 ISO），失败再试 / 替换
    // v3.115：无时区标记的本地语义字符串按 UTC 补 Z（纯日期已被上方分支拦截；此处为 'YYYY/MM/DD' 等）
    let t
    if (!/[T Z]/.test(s) && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
      t = new Date(s.replace(/\//g, '-') + 'T00:00:00Z')
    } else if (!/[Zz]/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s) && (s.includes('T') || /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}/.test(s))) {
      // v3.131：ISO/空格分隔无时区标记（'2026-08-01T10:30:00' / '2026-08-01 10:30:00'）→ 补 Z
      // ——v3.115 只统一了纯日期和 / 分隔，此格式走本地解析致跨时区差 1 天（Honolulu 实测 0 vs UTC 1）
      t = new Date(s.replace(' ', 'T') + 'Z')
    } else {
      t = new Date(s)
    }
    if (isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/'))
    // v3.171：回退时 T 分隔一并转空格——'2026-8-1T10:30'（单数字月日 T 格式）曾 Invalid 返回 null，
    // 而 '2026-8-1 10:30'（空格格式）宽松解析有效——同类格式不一致；'2026/8/1 10:30' 解析有效
    if (isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/').replace('T', ' '))
    if (isNaN(t.getTime())) return null
    return t.getTime()
  },

  daysComputed (time) {
    const ms = Utils.parseTime(time)
    if (ms === null) return 0
    return Utils.daysFrom(ms)
  },

  add0 (m) {
    return m < 10 ? '0' + m : '' + m
  },

  /** 距今天数：UTC 自然日差（今天/未来返回 0）
     *  v3.170：原 24 小时整段（Math.floor((now-ms)/DAY_MS)）——注册时间带具体时刻时少算 1 天
     *  （8/1 23:00 注册 → 当前 24h 段算 1 天、自然日差 2 天，pingbitime 边界错误拦截）；
     *  改按 UTC 日期差；无时刻日期（接口实际格式）两种口径恒等，零行为变更
     */
  daysFrom (ms) {
    const nowMs = Date.now() // 保持 Date.now()（测试可 fake Date.now 固定\"今天\"）
    const now = new Date(nowMs)
    const dNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const t = new Date(ms)
    const dMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
    return dNow > dMs ? Math.floor((dNow - dMs) / DAY_MS) : 0
  },

  // ==================== URL 工具 ====================
  /** 归一化 URL 用于判重：trim + 去尾部斜杠（/foo 与 foo、foo/ 视为同一资源） */
  normUrl (u) {
    // 归一化用于判重：trim + 去首尾斜杠 + 主机名小写（/foo、foo、foo/、A.com/a vs a.com/a 视为同一资源）
    // v3.108 fuzz：String(嵌套 Symbol 的数组) 崩——统一兜底视为空
    if (u === undefined || u === null) return ''
    let s
    try { s = String(u) } catch (e) { return '' }
    s = s.trim()
    // v3.156：去 query/hash（与 getFileName 口径一致）——同一内容带跟踪参数/锚点曾判为不同，重复入库推送
    s = s.split(/[?#]/)[0]
    // 单次遍历去首尾【斜杠|空白】（原多轮 do-while 对交替空格/斜杠长串是 O(n²)，
    // 脏数据 10 万字符实测 ~12-18s 拖垮判重；语义等价：只剥首尾 \s/ 直到稳定）
    s = s.replace(/^[\s/]+|[\s/]+$/g, '')
    // 含协议时协议+主机名转小写（路径大小写敏感保留）
    const m = s.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/]+)(.*)$/i)
    if (m) s = m[1].toLowerCase() + m[2].toLowerCase() + m[3]
    return s
  },

  /**
     * 用户/接口 URL 的统一安全字符串入口：仅接受非空字符串且拒绝危险协议。
     * 只负责类型、空白和协议安全；是否参与身份判重由 validUrl 决定。
     */
  safeUrl (u) {
    if (typeof u !== 'string') return ''
    const value = u.replace(/[\r\n]+/g, '').trim()
    // 换行历史上按既有契约剥离；其余 ASCII 控制字符不能进入 Markdown/JSON/缓存身份。
    if (/[\u0000-\u001F\u007F]/.test(value)) return ''
    if (!value) return ''
    // 兼容早期错误缓存：非字符串 URL 曾被 String() 写成这些伪值，不能继续参与身份判重。
    if (/^(?:\[object\s+(?:object|array)\]|undefined|null|true|false)$/i.test(value)) return ''
    // 统一先经过危险协议判定：实体编码、内部控制空白和大小写变体都必须在同一入口拒绝。
    if (this.isDangerousUrl(value)) return ''
    return value
  },

  /**
     * 可用于身份判重的 URL：仅接受字符串、可归一化且非危险协议。
     * 非字符串 URL（对象/数组/数字/Symbol）不能通过 String() 变成判重键，
     * 否则不同脏数据会共同落到 `[object Object]` 等伪 URL，造成静默丢消息。
     */
  validUrl (u) {
    const safe = this.safeUrl(u)
    if (!safe) return ''
    const normalized = this.normUrl(safe)
    // v3.246 P0：normUrl 会剥掉前导斜杠，`//javascript:...`/`//data:...` 可绕过 safeUrl
    // 的危险协议检查并成为判重键。归一化后再复检，确保危险协议永不进入身份判重。
    if (this.isDangerousUrl(normalized)) return ''
    return normalized || ''
  },

  /** 判断 URL 是否为危险协议（先解码实体，兼容 javascript&#58; 等编码绕过） */
  isDangerousUrl (url) {
    if (url === undefined || url === null) return false
    let s
    try { s = String(url) } catch (e) { return false }
    // v3.245 P0(XSS)：浏览器解析 href/src 时会解码命名实体——&colon;→':'、&Tab;→'\t'、
    // &NewLine;/&Newline;/&NewLine → '\n'、&nbsp;→'\u00A0'。decodeHtmlEntities 的 ENTITY_MAP
    // 不含这些，故在安全校验链路上单独解码，防止 javascript&colon;alert(1) 绕过黑名单。
    // 注意：只在此链路解码，不污染 ENTITY_MAP（消息正文渲染口径不变）。
    s = s.replace(/&(?:colon|Tab|NewLine|Newline|nbsp);/gi, m => ({ '&colon;': ':', '&Tab;': '\t', '&NewLine;': '\n', '&Newline;': '\n', '&nbsp;': '\u00A0' })[m] || '')
    // 去除 ASCII 控制空白，防止 `java\nscript:`/`java\tscript:` 等内部空白绕过协议检查
    // v3.245 P0：同时清理 \u00A0(nbsp 解码产物) 与 \u200B 等零宽，防 java\u00A0script: 变体
    s = this.decodeHtmlEntities(s).replace(/[\u0000-\u0020\u00A0\u200B-\u200D\uFEFF]+/g, '').toLowerCase()
    return /^(javascript|vbscript|data):/.test(s)
  },

  /** 清洗 HTML href/src 中的危险协议，保留标签和普通文本 */
  sanitizeHtmlUrls (html) {
    if (html === undefined || html === null) return ''
    try { html = String(html) } catch (e) { return '' }
    const cleanAttr = (name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`
    html = html.replace(/\b(href|src)\s*=\s*(["'])([\s\S]*?)\2/gi, (_, name, quote, value) => cleanAttr(name, quote, value))
    html = html.replace(/\b(href|src)\s*=\s*([^\s"'<>`]+)/gi, (_, name, value) => this.isDangerousUrl(value) ? `${name}=""` : `${name}=${value}`)
    // v3.251 P0(XSS)：未闭合引号属性绕过——`<a href="javascript:alert(1)` 无闭合引号时
    // 上面两个正则均不匹配（成对引号/无引号值），危险协议保留并被执行。这里单独处理
    // 未闭合引号形态：引号后到标签边界(< 或行尾)之间【不含相同闭合引号】的值才处理，
    // 避免误伤已闭合的合法 href（此前会多补引号并吞掉后续属性）。
    html = html.replace(/\b(href|src)\s*=\s*(["'])((?:[^"']|(?!\2)[\s\S])*?)(?=<|$)/gi, (_, name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`)
    return html
  },

  /** 实体解码后再次清理主动 HTML/事件属性，防止 &lt;script&gt; 重新形成可执行标签 */
  sanitizeDecodedHtml (html) {
    if (html === undefined || html === null) return ''
    try { html = String(html) } catch (e) { return '' }
    // HTML tokenizer 将 NUL 替换为 U+FFFD；先移除可被用来拆散属性名的 NUL，
    // 让 `on\u0000error` 收敛为 `onerror` 后进入统一事件属性清理。
    html = html.replace(/\u0000/g, '')
    html = this.sanitizeHtmlUrls(html)
    // 成对和未闭合的主动标签都处理：不依赖恶意输入自觉补齐闭合标签。
      .replace(/<(?:script|style|iframe|object|svg|math)\b[\s\S]*?<\/(?:script|style|iframe|object|svg|math)\s*>/gi, '')
      .replace(/<(?:script|style|iframe|object|embed|svg|math)\b[^>]*>/gi, '')
      .replace(/<\/(?:script|style|iframe|object|svg|math)\s*>/gi, '')
    // 基础/外链/刷新标签可改变文档导航或加载外部资源，HTML 推送不需要它们。
      .replace(/<(?:base|link|meta)\b[^>]*>/gi, '')
      .replace(/(?:\s|\/)on[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    html = html
    // 覆盖 href/src 之外的可导航/可加载属性（xlink:href、formaction、poster 等）。
      .replace(/\b(xlink:href|formaction|action|poster|cite|background|dynsrc|lowsrc)\s*=\s*(["'])([\s\S]*?)\2/gi,
        (_, name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`)
      .replace(/\b(xlink:href|formaction|action|poster|cite|background|dynsrc|lowsrc)\s*=\s*([^\s"'<>`]+)/gi,
        (_, name, value) => this.isDangerousUrl(value) ? `${name}=""` : `${name}=${value}`)
    // srcset 可在候选项中藏危险协议；检测到任意危险候选即清空整个属性。
      .replace(/\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi, (_, quote, value) => {
        const v = this.decodeHtmlEntities(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase()
        return /(?:^|[,])(?:javascript|vbscript|data):/.test(v) ? `srcset=${quote}${quote}` : `srcset=${quote}${value}${quote}`
      })
      .replace(/\bsrcset\s*=\s*([^\s"'<>`]+)/gi, (_, value) => {
        const v = this.decodeHtmlEntities(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase()
        return /^(?:javascript|vbscript|data):/.test(v) ? 'srcset=""' : `srcset=${value}`
      })
    // CSS url()/expression()/behavior 可形成主动加载或脚本执行路径；不需要保留这类 style。
      .replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_, quote, value) => {
        const v = this.decodeHtmlEntities(value).toLowerCase()
        return /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/.test(v)
          ? `style=${quote}${quote}`
          : `style=${quote}${value}${quote}`
      })
      .replace(/\bstyle\s*=\s*([^\s"'<>`]+)/gi, (_, value) => {
        const v = this.decodeHtmlEntities(value).toLowerCase()
        return /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/.test(v)
          ? 'style=""'
          : `style=${value}`
      })
    return html
  },

  // ==================== 安全访问/文本 ====================
  /**
     * 安全读取用户/接口对象字段：代理 getter 或异常 getter 不能中断主流程。
     */
  safeGet (object, key, fallback = undefined) {
    try {
      return object && object[key] !== undefined ? object[key] : fallback
    } catch (e) {
      return fallback
    }
  },

  /**
     * 安全写入用户/接口对象字段：只把可写字段归一化，setter 异常不影响整批处理。
     */
  safeSet (object, key, value) {
    try {
      if (object && (typeof object === 'object' || typeof object === 'function')) object[key] = value
      return true
    } catch (e) {
      return false
    }
  },

  /**
     * 安全浅复制对象：逐字段读取并隔离异常 getter，不让脏字段破坏模板、推送或缓存事务。
     * 使用 defineProperty 写入，避免 __proto__ 等键触发原型 setter。
     */
  safeObjectCopy (object) {
    const out = {}
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return out
    let keys
    try { keys = Object.keys(object) } catch (e) { return out }
    for (const key of keys) {
      try {
        Object.defineProperty(out, key, {
          value: object[key], enumerable: true, configurable: true, writable: true
        })
      } catch (e) { /* 异常 getter/代理字段跳过 */ }
    }
    return out
  },

  /**
     * 用户字段安全文本化：模板/日志路径不能把 Symbol、异常 toString、循环对象带入主流程。
     * 字符串/数字/布尔/BigInt 保持可读；Symbol、函数和不可序列化对象保守置空。
     */
  safeText (value, fallback = '') {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'symbol' || typeof value === 'function') return fallback
    let text
    try {
      if (typeof value === 'object') {
        text = JSON.stringify(value)
        if (text === undefined) return fallback
      } else {
        text = String(value)
      }
    } catch (e) {
      return fallback
    }
    try { return this.sanitizeSurrogates(text) } catch (e) { return fallback }
  },

  safeErrorText (error, fallback = '') {
    // v3.245 P1：字符串 error（如 throw 'xxx'）直接返回内容——safeGet 对原始字符串取
    // message/code 均为 undefined，此前会丢内容落到 fallback，异常信息不可见。
    if (typeof error === 'string' && error.trim() !== '') return this.safeText(error, fallback)
    const message = this.safeGet(error, 'message')
    if (message !== undefined && message !== null && message !== '') return this.safeText(message, fallback)
    const code = this.safeGet(error, 'code')
    if (code !== undefined && code !== null && code !== '') return this.safeText(code, fallback)
    return fallback
  },

  // 清洗孤立代理（v3.110 fuzz 发现）：encodeURIComponent 对孤立代理抛 URIError → 推送失败。
  // 孤立高/低代理替换为 U+FFFD（完整代理对保留）；脏数据/截断 emoji 的真实防御
  sanitizeSurrogates (s) {
    try { s = String(s === undefined || s === null ? '' : s) } catch (e) { return '' }
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
  },

  /** 数字实体解码统一：NUL 过滤 / 代理区与超范围保留原文 */
  _decodeNumeric (n, original) {
    if (n === 0) return ''
    return (n > 0 && n <= MAX_CODE_POINT && !(n >= SURROGATE_LO && n <= SURROGATE_HI))
      ? String.fromCodePoint(n)
      : original
  },

  // ==================== 身份/去重 ====================
  /**
     * 生成统一消息身份：id 优先，随后是有效 URL，最后是稳定匿名合成键。
     * 所有判重、缓存、截断和成功状态路径必须复用该函数，避免各入口各自拼 key。
     */
  getMessageIdentity (message) {
    if (!this.isValidItem(message)) return { valid: false, kind: 'invalid', key: '', idKey: '', url: '' }
    if (this.hasValidId(message)) {
      const id = this.safeGet(message, 'id')
      const idKey = typeof id === 'string' ? id.trim() : String(id)
      const url = this.validUrl(this.safeGet(message, 'url'))
      // 兼容历史 App 生成的匿名 id：让它与旧缓存中仍无 id/URL 的同一条消息保持同一身份。
      // 仅当该 id 确为「本消息自身字段」的历史合成键时才降级为匿名：旧版 App 曾把
      // anonKey(自身 title/content/…) 写入 id 字段落缓存。真实消息的 id 即便形如
      // 'anon:abc123'（全十六进制），也与自身内容哈希不同 → 保持 id/url 权威判重，
      // 不再被误降级而丢失 id/url 判重（v3.247 修复）。
      if (/^anon:[0-9a-f]+$/i.test(idKey) && !url) {
        const selfAnon = this.anonKey(
          this.safeGet(message, 'title'),
          this.safeGet(message, 'content'),
          this.safeGet(message, 'posttime'),
          this.safeGet(message, 'shijianchuo'),
          this.safeGet(message, 'pic'),
          this.safeGet(message, 'mall_name'),
          this.safeGet(message, 'price'),
          this.safeGet(message, 'brand'),
          this.safeGet(message, 'catename'),
          this.safeGet(message, 'louzhu')
        )
        // 自内容哈希须与 id 一致，且非「全空字段退化键」(anon:1505) 才视为历史匿名合成键
        if (selfAnon !== this.anonKey() && selfAnon === idKey) {
          return { valid: true, kind: 'anon', key: idKey, idKey: '', url: '', anonKey: idKey }
        }
      }
      return { valid: true, kind: 'id', key: `id:${idKey}`, idKey, url }
    }
    const url = this.validUrl(this.safeGet(message, 'url'))
    if (url) return { valid: true, kind: 'url', key: `url:${url}`, idKey: '', url }
    const anon = this.anonKey(
      this.safeGet(message, 'title'),
      this.safeGet(message, 'content'),
      this.safeGet(message, 'posttime'),
      this.safeGet(message, 'shijianchuo'),
      this.safeGet(message, 'pic'),
      this.safeGet(message, 'mall_name'),
      this.safeGet(message, 'price'),
      this.safeGet(message, 'brand'),
      this.safeGet(message, 'catename'),
      this.safeGet(message, 'louzhu')
    )
    // 全字段为空时 anonKey 哈希空串退化为固定键(anon:1505)，会使所有此类消息判为同一身份而互相吞掉。
    // 退化为无效身份，让每条无标识消息各自独立、不再参与匿名判重。
    if (anon === this.anonKey()) return { valid: false, kind: 'invalid', key: '', idKey: '', url: '' }
    return { valid: true, kind: 'anon', key: anon, idKey: '', url: '', anonKey: anon }
  },

  /**
     * 统一判重关系：保留 id 权威 + 有效 URL 双向 fallback，同时支持匿名合成键。
     * 支持预计算身份传入（a=left 身份, b=right 身份）：循环判重时避免对同一消息重复计算。
     */
  sameMessageIdentity (left, right, a, b) {
    if (!a) a = this.getMessageIdentity(left)
    if (!b) b = this.getMessageIdentity(right)
    if (!a.valid || !b.valid) return false
    if (a.kind === 'id') {
      return a.idKey === b.idKey || (b.kind !== 'id' && !!a.url && !!b.url && a.url === b.url)
    }
    if (a.url) return !!b.url && a.url === b.url
    return b.kind === 'anon' && a.key === b.key
  },

  /** 零分配浅层相等（忽略顶层 timestamp）：仅比较原始值/相同引用是否一致。
      任一侧存在对象/数组值时不能据此断定相等，返回 false 交由调用方退回深排——用于去重
      更新路径的快速短路，避免对内容未变的大消息做两次深度 normalize+JSON.stringify。 */
  shallowEqualIgnoringTimestamp (a, b) {
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const keysA = []
    const keysB = []
    for (const k of Object.keys(a)) if (k !== 'timestamp') keysA.push(k)
    for (const k of Object.keys(b)) if (k !== 'timestamp') keysB.push(k)
    if (keysA.length !== keysB.length) return false
    for (let i = 0; i < keysA.length; i++) {
      const k = keysA[i]
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false
      let va, vb
      try {
        va = a[k]
        vb = b[k]
      } catch (e) {
        // getter/proxy 抛错：不能断定相等，退回慢路径按"已变更"处理（与深排口径一致）
        return false
      }
      // 对象/数组 → 引用不同不代表内容不同，交由慢路径判定
      if ((typeof va === 'object' && va !== null) || (typeof vb === 'object' && vb !== null)) return false
      if (va !== vb) return false
    }
    return true
  },

  /** 有效数据条目：对象且非数组（排除 null/原始值/嵌套数组） */
  isValidItem (m) {
    return !!(m && typeof m === 'object' && !Array.isArray(m))
  },

  hasValidId (m) {
    // v3.107 fuzz 发现：m 本身缺失/非对象时 m.id 会抛 TypeError；异常 getter 也按无效 id 处理。
    // 与 isValidItem 口径一致：排除数组（带自定义 id 属性的数组不视为有效条目）。
    if (m === undefined || m === null || typeof m !== 'object' || Array.isArray(m)) return false
    const id = this.safeGet(m, 'id')
    if (id === undefined || id === null) return false
    const t = typeof id
    if (t === 'string') return id.trim() !== ''
    if (t === 'number') return Number.isFinite(id) // 数字 id 有效（含 0，语义依数据源）
    return false // 布尔/对象/数组/Symbol 等脏数据 id 一律无效
  },

  /** 无 id 无 url 数据的稳定合成 id：基于 title+content 哈希，跨运行可去重。
      v3.248：由单一 32 位 djb2 升级为两路独立 32 位 djb2 拼接（64 位碰撞空间），降低不同内容
      消息哈希碰撞被判同一身份而互相吞掉的风险（P3）。仍输出 anon:hex，格式与测试锁定一致；
      判重键由缓存内容重算，跨运行稳定。 */
  anonKey (...parts) {
    // 过滤空值：避免全空字段导致不同数据撞同一个 key
    // v3.108 fuzz 发现：String(Symbol()) 抛 TypeError——Symbol 字段视为无效过滤
    // str 只执行一次（原 filter 与 map 各跑一遍、每字段 3 次正则 replace 属轻微浪费，P3）
    const str = (p) => {
      if (typeof p === 'symbol') return ''
      try { return String(p).replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\|/g, '%7C') } catch (e) { return '' }
    }
    let s = ''
    for (const p of parts) {
      if (p === undefined || p === null) continue
      const t = str(p)
      if (t.trim() !== '') s = s === '' ? t : s + '|' + t
    }
    let h1 = 5381, h2 = 52711
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      h1 = ((h1 * 33) ^ c) >>> 0
      h2 = ((h2 * 31) + c + i) >>> 0
    }
    return 'anon:' + h1.toString(16) + h2.toString(16)
  },

  /** 共享身份索引写入：Map<key, Set<index>>，空 key 跳过，重复 index 由 Set 天然去重。
      _buildIdentityIndex 与 saveBatch 共用此定义，避免两份重复实现漂移。 */
  addIndex (map, key, i) {
    if (!key) return
    let set = map.get(key)
    if (!set) { set = new Set(); map.set(key, set) }
    set.add(i)
  },

  /** v3.159：过滤规则稳定哈希（过滤字段固定顺序 + 只看它关键词）——规则变更时用于失效「过滤写入」缓存 */
  filterHash (filterCfg, zktGjc) {
    const parts = []
    const rawStr = (v) => {
      if (v === undefined || v === null || typeof v === 'symbol') return ''
      try { return String(v) } catch (e) { return '' }
    }
    // 与 compileRules 归一化口径对齐：字段值先 trim，避免纯空白/格式微调（'abc ' vs 'abc'）误失效「过滤写入」缓存
    const safeStr = (v) => {
      if (v === undefined || v === null || typeof v === 'symbol') return ''
      try { return String(v).trim() } catch (e) { return '' }
    }
    for (const f of FILTER_FIELDS) {
      const v = filterCfg && filterCfg[f]
      parts.push(f + '=' + safeStr(v))
    }
    // v3.161：补 pingbitime——曾漏（FILTER_FIELDS 不含它），改宽 pingbitime 后「过滤写入」缓存不失效，
    // 被天数过滤的旧条目不重推（#7，与 v3.159 #2 同 class 疏漏）。
    // 简单数字形式再按 compileRules 做 Number 归一：'5'/'05'/'5.0'/' 5 ' 同编译为 value 5；
    // 非法/负数 → ''（compileRules 编译为 null，无时间过滤）；### 多行形式仅整体 trim，保留行内格式。
    let pb = safeStr(filterCfg && filterCfg.pingbitime)
    let timeActive = false
    if (pb) {
      if (/###/.test(pb)) {
        timeActive = true // 多行天数规则可能 >0，时间过滤生效
      } else {
        const n = Number(pb)
        if (Number.isFinite(n) && n >= 0) {
          pb = String(n)
          timeActive = n > 0 // 0 天永不拦截，无时间依赖
        } else {
          pb = ''
        }
      }
    }
    parts.push('pingbitime=' + pb)
    // zkt_gjc 保持原样：只看它过滤实际用 new RegExp(kw) 未 trim，空白在语义上有意义；若 trim，
    // 真实语义变更（如 'abc'→' abc'）不会失效缓存而漏推——故不能按 compileRules 同款 trim（compileRules 不处理 zkt_gjc）。
    parts.push('zkt_gjc=' + rawStr(zktGjc))
    // P3：pingbitime 天数过滤结果随注册天数增长（daysFrom 逐日 UTC 日期差）而变化，静态配置哈希不会变——
    // 已 _f 标记的旧条目因「缓存失效仅由静态哈希触发」而永不重评、长期漏推（老化过阈值后本应补推）。
    // pingbitime 启用时把当前 UTC 日期折进哈希：跨天即失效 _f 缓存 → 老化过阈值的条目被重新评估/推送；
    // 未启用则无时间依赖，不折入日期，避免无谓的每日全量重评。
    if (timeActive) {
      const d = new Date()
      parts.push('date=' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'))
    }
    const s = parts.join('\u0001')
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
    return String(h)
  },

  // ==================== 转换/系统 ====================
  /**
     * 数值配置统一转换（v3.158）：环境变量/配置文件传入的数字都是字符串——Number.isFinite('5')=false
     * 曾全部回退默认(api.retry/parallelLimit/titleMax 等 7 处失效)；'5'→5，'abc'/undefined→默认
     */
  num (v, def) {
    // 空值/空白/布尔值不是有效数值配置：避免 alert.intervalMs='' 被 Number('') 转成 0，
    // 从而意外关闭限频；显式字符串 '0' 仍保留 0 的特殊语义。
    if (v === undefined || v === null || typeof v === 'boolean') return def
    // P3：仅接受 number 与数字字符串——数组([]→0/[5]→5)与带 valueOf 的对象会经 Number() 隐式
    // 转换绕过守卫，导致 alert.intervalMs 等意外变 0 而非回退默认。
    if (typeof v !== 'number' && typeof v !== 'string') return def
    if (typeof v === 'string' && v.trim() === '') return def
    let n
    try { n = Number(v) } catch (e) { return def } // Symbol / valueOf 抛错等脏配置回退默认，不中断主流程
    return Number.isFinite(n) ? n : def
  },

  /** 返回路径所在文件系统的容量信息；平台/Node 不支持时返回 null，不影响主流程。 */
  diskSpace (targetPath) {
    const statfs = fs.statfsSync
    if (typeof statfs !== 'function') return null
    try {
      const st = statfs(targetPath)
      const bsize = Number(st.bsize || st.frsize || 0)
      const bavail = Number(st.bavail)
      const blocks = Number(st.blocks)
      if (!Number.isFinite(bsize) || bsize <= 0 || !Number.isFinite(bavail) || bavail < 0) return null
      return {
        freeBytes: bsize * bavail,
        totalBytes: Number.isFinite(blocks) && blocks >= 0 ? bsize * blocks : null
      }
    } catch (e) {
      return null
    }
  },

  /**
     * UTF-16 安全截断：按码元截断但不在代理对中间切断（避免半个 emoji 乱码）
     * 末尾高代理→退一位；末尾低代理且前一位非高代理(孤立)→退一位；配对完整低代理→保留
     * v3.175：ZWJ 序列/变体选择符/组合字符同样不切断——👨👩👧👦 截断曾拆散家庭 emoji、
     * ❤️ 丢 VS16、é 丢重音；统一循环退位（代理对 + 修饰符 + 末尾 ZWJ）
     */
  truncateUtf16 (s, max) {
    try { s = String(s === undefined || s === null ? '' : s) } catch (e) { s = '' } // v3.108 fuzz：嵌套 Symbol 数组 String() 崩 → 空
    // 防御（R1）：非法 max（undefined/NaN/0/负数）不截断——内部调用均传合法值，零行为变更；
    // 否则 slice(0, undefined) 意外整串返回 / slice(0,0) 空串 / slice(0,-N) 误截尾字符
    if (!Number.isFinite(max) || max <= 0) return s
    if (s.length <= max) return s
    let cut = s.slice(0, max)
    // 修饰符判定：作用于前一字符的 Unicode 修饰符（ZWJ/变体选择符/组合音标/组合符号）；
    // v3.185：补充平面修饰符（肤色 U+1F3FB–1F3FF / VS 补充 U+E0100–E01EF / 区域指示符 U+1F1E6–1F1FF）
    // 也纳入判定（用 codePointAt 读取码点，避免截断拆散 👍🏽 等补充平面 emoji）
    const isModifier = (c) => c === 0x200D || (c >= 0xFE00 && c <= 0xFE0F) ||
            (c >= 0x0300 && c <= 0x036F) || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) ||
            (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F) ||
            (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0100 && c <= 0xE01EF) || (c >= 0x1F1E6 && c <= 0x1F1FF)
    // 补充平面修饰符专用判定：紧随补充平面基符的修饰符（不含 ZWJ，避免拆散 👨👩👧👦 首个完整 emoji）
    const isSupplementaryModifier = (c) =>
            (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0100 && c <= 0xE01EF) || (c >= 0x1F1E6 && c <= 0x1F1FF)
    while (cut.length > 0) {
      const last = cut.charCodeAt(cut.length - 1)
      // 代理对：完整低代理对保留；高代理/孤立低代理退位；
      // 完整对后若是补充平面修饰符则退位（不拆散基底代理对，如 👍🏽 / 🇨🇳）
      if (last >= SURROGATE_LO && last <= SURROGATE_HI) {
        if (last >= 0xDC00) {
          const prev = cut.charCodeAt(cut.length - 2)
          if (prev >= SURROGATE_LO && prev <= 0xDBFF) {
            if (isSupplementaryModifier(s.codePointAt(cut.length))) { cut = cut.slice(0, -1); continue }
            break // 配对完整，保留
          }
        }
        cut = cut.slice(0, -1)
        continue
      }
      // 末尾 ZWJ 本身退位（连接符不应做结尾）
      if (last === 0x200D) { cut = cut.slice(0, -1); continue }
      // 截断点后是作用于上一字符的修饰符 → 退位（避免拆散 ❤️ / é）
      const next = s.codePointAt(cut.length)
      if (isModifier(next)) { cut = cut.slice(0, -1); continue }
      break
    }
    return cut
  },

  /** 解码常见 HTML 实体 */
  decodeHtmlEntities (str) {
    if (str === undefined || str === null) return ''
    try { str = String(str) } catch (e) { return '' } // v3.108 fuzz：嵌套 Symbol 数组 String() 崩 → 视为空
    if (!str) return str
    // 递归解码（v3.105）：真实接口存在双重转义（&amp;amp; → &amp; → &，真机验证发现 2/20 条），
    // 单轮解码会残留 &amp; 破坏 URL 参数（链接 key 参数错乱）；最多 8 轮防死循环，收敛即停
    for (let i = 0; i < 8; i++) {
      const next = str
        .replace(ENTITY_RE, m => ENTITY_MAP[m] || m)
        .replace(DEC_RE, (_, code) => this._decodeNumeric(Number(code), `&#${code};`))
        .replace(HEX_RE, (_, hex) => this._decodeNumeric(parseInt(hex, 16), `&#x${hex};`))
      if (next === str) break
      str = next
    }
    return str
  }
}

// ============================================================
// 🔄 Formatter — 格式化层（纯函数，不修改输入参数）
// ============================================================
const Formatter = {
  /** Markdown 收尾：合并连续换行 + 去首尾空白（短路与正常路径共用） */
  _finalizeMd (s) {
    // v3.245 P1：非 string 输入（undefined/null/对象/Symbol）String() 兜底，此前直接
    // s.replace 抛 TypeError 无防护。
    // v3.249：undefined/null/空串直接返回空——String(undefined)→'undefined' 会泄漏成字面文本
    if (s === undefined || s === null || s === '') return ''
    try { s = String(s) } catch (e) { return '' }
    return s.replace(/\n{3,}/g, '\n\n').trim()
  },

  htmlToMarkdown (shuju) {
    shuju = Utils.safeObjectCopy(shuju || {})
    let html = (typeof shuju.content_html === 'string')
      ? shuju.content_html
      : (shuju.content_html === undefined || shuju.content_html === null ? '' : '') // 非字符串内容视为空（避免 [object Object]）
        // URL 文本/目标统一使用 safeUrl：非字符串、空值、伪 URL、危险协议和换行都不生成 Markdown 链接。
    const urlText = Utils.safeUrl(shuju && shuju.url)
    const safeUrl = urlText
    // url 含 Markdown 特殊字符(空格/括号/])时用 <> 包裹（短路与正常路径共用）
    const mdUrl = safeUrl && /[\s()[\]]/.test(safeUrl) ? `<${safeUrl}>` : safeUrl
    // 无标签内容短路：跳过整个替换链（性能优化）
    if (!html.includes('<')) {
      html = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(html))
      return this._finalizeMd(mdUrl ? html + `\n\n原文链接：[${urlText}](${mdUrl})` : html)
    }
    html = html
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, c) => '#'.repeat(lv) + ' ' + c + '\n\n')
      .replace(/<a\s*[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
        const cleanHref = Utils.safeUrl(href)
        return cleanHref ? `[${txt}](${cleanHref})` : txt
      })
      .replace(/<a\s+[^>]*?href\s*=\s*([^\s"'>]+)[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
        const cleanHref = Utils.safeUrl(href)
        return cleanHref ? `[${txt}](${cleanHref})` : txt
      })
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const srcM = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || tag.match(/\bsrc\s*=\s*([^\s"'<>`]+)/i)
        if (!srcM) return tag // 无 src 不转换
        const src = Utils.safeUrl(srcM[1])
        if (!src) return tag.replace(/\bsrc\s*=\s*(?:(["'])[^"']*\1|[^\s"'<>`]+)/i, '') // 空/危险 src 不生成可执行图片链接
        const altM = tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || tag.match(/\balt\s*=\s*([^\s"'<>`]+)/i)
        // alt 截断（真实接口 alt 可长达 250+ 字符拖累推送）——代理对安全
        const alt = altM ? Utils.truncateUtf16(altM[1], 50) : ''
        // 注：img URL 不包裹 <>——此处早于标签剥离，<url> 会被 /<[^>]+>/g 当标签剥掉成空 ![]()
        //     （a 链接的 <> 包裹安全是因为在最后拼接）；含空格/括号 URL 保持原样
        return `\n\n![${alt}](${src})\n\n`
      })
      .replace(/<br\s*\/?>|<\/br>\s*/gi, '\n\n')
      .replace(/<\/?p[^>]*>/gi, '\n\n')
      .replace(/<\/?div[^>]*>/gi, '\n\n') // div 为块级元素：真实接口数据常见，缺换行会粘连
    // 列表/粗体/斜体转 Markdown（在标签剥离前）：<li> → - 项、<b>/<strong> → **、<i>/<em> → *
    // v3.171：短标签正则加 \b 词边界——`<img>/<input>/<iframe>` 曾被 `<i` 前缀误当斜体、
    // `<blockquote>/<bdo>` 被 `<b` 误当粗体、`<link>` 被 `<li` 误当列表项，输出 */**/- 垃圾
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li\b>/gi, '\n')
      .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
      .replace(/<\/?(?:b|strong)\b[^>]*>/gi, '**')
      .replace(/<\/?(?:i|em)\b[^>]*>/gi, '*')
    // 表格：单元格 | 分隔、行/表换行（曾全部粘连成"甲乙丙丁"）
      .replace(/<td\b[^>]*>/gi, ' | ')
      .replace(/<th\b[^>]*>/gi, ' | ')
      .replace(/<tr\b[^>]*>/gi, '\n')
      .replace(/<table\b[^>]*>/gi, '\n\n')
      .replace(/<script[\s\S]*?<\/script>/gi, '') // 脚本内容整体移除
      .replace(/<style[\s\S]*?<\/style>/gi, '') // 样式内容整体移除
    // v3.173：删除 /<{2,}|>{2,}/g 剥离——曾把合法文本的 >>/<< 误删（'5>>3'→'53'、'价格<<100'→'价格100'）；
    // 标签形态由上方 <[^>]+> 剥离处理（'<<a>' 被剥），孤立 < / > 文本保留（Markdown 渲染为普通文本）
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
    // 先移除真实 HTML 标签，再解码实体；实体解码可能重新形成标签，需再次清理主动内容/危险属性。
    html = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(html))
    const result = html + (mdUrl ? `\n\n原文链接：[${urlText}](${mdUrl})` : '')
    // 模板拼接后再次合并连续换行（内容尾部 \n\n + 模板 \n\n 会拼出 3+ 连换行）
    return this._finalizeMd(result)
  },

  tuisong_replace (text, shuju) {
    // 防御：模板缺失/非字符串时转空串或字符串化，避免 text.includes 崩溃
    // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 视为空模板
    try { text = text === undefined || text === null ? '' : String(text) } catch (e) { text = '' }
    const data = Utils.safeObjectCopy(shuju)

    if (data.category_name) data.catename = data.category_name
    if (data.category_id) data.cateid = data.category_id // 与 category_name→catename 对称（修复 {分类ID} 恒空）

    const timeSource = (data.posttime !== undefined && data.posttime !== null && data.posttime !== '')
      ? data.posttime
      : (data.shijianchuo !== undefined && data.shijianchuo !== null && data.shijianchuo !== '' ? data.shijianchuo : undefined)
    if (timeSource !== undefined && !data.datetime) {
      // 统一解析（v3.62 与 daysComputed 共用 parseTime，消除重复逻辑）：
      // 秒/毫秒时间戳、8 位日期、YYYY-MM-DD、ISO 全部同一口径
      const t = Utils.parseTime(timeSource)
      if (t === null || t < 0) {
        // 非法/负时间戳：不生成日期（留空），避免回退当前时间或 1969 误导
        data.datetime = undefined
        data.shorttime = undefined
      } else {
        const dt = new Date(t)
        // v3.115 时区统一：与 parseTime 的 UTC 解析口径一致——getUTC* 保证跨时区部署
        // 日期时间显示一致；顺带修复 getHours 无 add0（+8 时区输出 '1:30' 而非 '01:30'）
        data.datetime = `${dt.getUTCFullYear()}-${Utils.add0(dt.getUTCMonth() + 1)}-${Utils.add0(dt.getUTCDate())}`
        data.shorttime = `${Utils.add0(dt.getUTCHours())}:${Utils.add0(dt.getUTCMinutes())}`
      }
    }

    // 惰性计算：只有模板里真正用到 {Html内容} / {Markdown内容} 时才跑一遍替换/正则，
    // 避免像 App.run 里那样对同一条数据分别调用 tuisong_replace 生成 text/desp 时，
    // 没用到 Markdown 的那次也白白算一遍 htmlToMarkdown
    // url 做 HTML 转义，避免特殊字符破坏 <a href="..."> 结构；换行先剥离（v3.85，与 linkText 口径一致）；非字符串视为无链接（R6-1）
    const rawUrl = Utils.safeUrl(Utils.safeGet(data, 'url'))
    const safeHtmlUrl = rawUrl
    const escUrl = safeHtmlUrl
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 与 htmlToMarkdown 口径一致：非字符串 content_html 视为空（避免 [object Object] 泄漏）
    // {Html内容} 会在 wxpusher 等通道以 HTML 类型渲染；实体解码后再次清理主动标签、事件属性和危险 URL，
    // 防止接口 content_html 中的 <script>/onerror 或 &lt;script&gt; 进入客户端渲染。
    const rawHtml = (typeof data.content_html === 'string')
      ? Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(data.content_html))
      : ''
    // {链接} 占位符 Markdown 安全化（v3.74）：与 htmlToMarkdown 的 mdUrl 同口径——
    // 含空格/括号/] 用 <> 包裹、剥离换行（原样输出会在 Markdown 链接场景破坏）
    const linkText = () => {
      // R6-1：非字符串视为无链接（与 htmlToMarkdown urlText 同口径）
      const u = Utils.safeUrl(Utils.safeGet(data, 'url'))
      return u && /[\s()[\]]/.test(u) ? `<${u}>` : u
    }
    const getContentHtml = () => safeHtmlUrl
      ? `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="${escUrl}" target="_blank">${escUrl}</a><br>&nbsp;<br>&nbsp;<br>`
      : `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：${escUrl}<br>&nbsp;<br>&nbsp;<br>`

    const map = {
      '{标题}': data.title,
      '{内容}': data.content,
      '{Html内容}': text.includes('{Html内容}') ? getContentHtml() : undefined,
      '{Markdown内容}': text.includes('{Markdown内容}') ? this.htmlToMarkdown(data) : undefined,
      '{分类名}': data.catename,
      '{分类ID}': data.cateid,
      '{链接}': text.includes('{链接}') ? linkText() : undefined,
      '{日期}': data.datetime,
      '{时间}': data.shorttime,
      '{楼主}': data.louzhu,
      '{类目}': data.catename, // 与 {分类名} 统一来源（归一化后 catename 恒有值）
      '{价格}': data.price,
      '{商城}': data.mall_name,
      '{品牌}': data.brand,
      '{图片}': data.pic
    }

    for (const [key, val] of Object.entries(map)) {
      // v3.237：字面量替换（split/join）替代 new RegExp(key)——占位符是固定文本而非正则模式，
      // 避免每次调用重建 14 个正则对象 + 消除占位符含正则元字符（$ ( [ 等）时的隐式陷阱。
      // 语义等价：replace(/X/g, fn) 对字面量 X ≡ split('X').join(fn())。
      text = text.split(key).join(Utils.safeText(val))
    }
    // v3.110：输出统一清洗孤立代理（encodeURIComponent 会崩；所有模板路径受益）
    return Utils.sanitizeSurrogates(text)
  }
}

// ============================================================
// 📐 RuleEngine — 规则引擎层
// ============================================================
const RuleEngine = {
  /** 解析单行规则：split('###') + trim，返回 { cat, val, parts } */
  _parseLine (line) {
    // v3.245 P1：String(line) 对嵌套 Symbol 数组抛 TypeError——catch 兜底返回空规则。
    let parts
    try { parts = String(line).split('###') } catch (e) { parts = [] }
    return {
      cat: (parts[0] || '').trim(),
      val: (parts[1] || '').trim(),
      parts
    }
  },

  /** 编译分类正则，失败返回 null（调用方决定跳过） */
  _compileCatRe (cat) {
    // v3.245 P1：null/undefined 显式返回 null——此前 new RegExp(undefined) 隐式编译
    // /undefined/i 字面量正则，会静默匹配含 "undefined" 文本的字段，行为与预期不符。
    if (cat === null || cat === undefined) return null
    if (this.hasNestedQuantifier(cat)) return null // ReDoS 防护：嵌套量词直接跳过
    try { return new RegExp(String(cat), 'i') } catch (e) { return null }
  },

  /**
     * 检测正则模式是否含「嵌套无限量词」（灾难性回溯 ReDoS 高风险，如 (a+)+、(a*)*、(a+)*、(?:a+)+）
     * 原理：分组内容以无限量词(+ * {n,})结尾，且该分组紧跟无限量词 → 匹配回溯呈指数级
     * 有界量词(?、{n}、{n,m})不参与灾难性回溯，不判危险；字符类/转义内的括号与量词忽略
     * 返回 true = 高风险（编译方应跳过/警告，避免卡死主线程）
     */
  hasNestedQuantifier (pattern) {
    // v3.108 fuzz：String(Symbol) 抛 TypeError；嵌套 Symbol 的数组 String() 也崩——统一兜底
    if (pattern === undefined || pattern === null || typeof pattern === 'symbol') return false
    let s
    try { s = String(pattern) } catch (e) { return false }
    // 位置 i 起是否为无限量词（+ * {n,}），返回其长度（0=不是）
    const infQuantLen = (i) => {
      const ch = s[i]
      if (ch === '+' || ch === '*') return 1
      if (ch === '{') {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(s.slice(i))
        if (m && m[2] === '') return m[0].length // {n,} 无上限=无限；{n}/{n,m} 有界
      }
      return 0
    }
    const stack = [{ inf: false, alt: false }] // 栈顶=当前分组：inf=组内最后 token 是否以无限量词结尾；alt=组内是否含 |（交替）
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      const cur = stack[stack.length - 1]
      if (ch === '\\') { i++; cur.inf = false; continue } // 转义（含 \\( \\) \\d 等）视为普通 token
      if (ch === '[') {
        let j = i + 1
        if (s[j] === '^') j++
        if (s[j] === ']') j++ // 空类 ] 开头
        while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++ }
        i = j; cur.inf = false; continue // 字符类整体视为普通 token
      }
      if (ch === '(') { stack.push({ inf: false, alt: false }); continue }
      if (ch === '|') { cur.alt = true; cur.inf = false; continue } // v3.174：交替标记（歧义回溯候选）
      if (ch === ')') {
        if (stack.length === 1) { cur.inf = false; continue } // 多余右括号
        const closed = stack.pop()
        const parent = stack[stack.length - 1]
        const ql = infQuantLen(i + 1)
        if (closed.inf && ql > 0) return true // 组以无限量词结尾 + 组后无限量词 → 灾难性
        // v3.174：组内含交替 + 组后无限量词 → 歧义交替灾难性回溯（(a|aa)+ 曾漏检，
        // '^(a|aa)+b$' 对 30a 已 156ms/40a 2.5s/50a+ 指数爆炸卡死）；保守拦截（宁可误拦多推）
        if (closed.alt && ql > 0) return true
        if (ql > 0) { parent.inf = true; i += ql } else { parent.inf = false }
        continue
      }
      const ql = infQuantLen(i)
      if (ql > 0) { cur.inf = true; i += ql - 1 } else if (ch === '?') { cur.inf = true } else { cur.inf = false } // 普通字符 / {n} / {n,m} 视为有界；? 可变量词：组内以 ? 结尾组可匹配空串，配合组后无限量词同样灾难性（如 (a?)+）
    }
    return false
  },

  /** 验证分类正则合法性，无效则追加警告 */
  _validateCatRe (cat, field, warnings) {
    // v3.246：null/undefined 显式警告并跳过——此前 new RegExp(null) 隐式编译 /null/i
    // 字面量正则，会静默匹配含 "null"/"undefined" 文本的字段且无警告，行为与预期不符。
    if (cat === null || cat === undefined) {
      warnings.push(`⚠️ 配置「${field}」分类正则为空，该行将被忽略`)
      return
    }
    if (this.hasNestedQuantifier(cat)) {
      warnings.push(`⚠️ 配置「${field}」分类正则含嵌套量词，可能导致灾难性回溯，该行将被忽略：「${cat}」`)
      return
    }
    try { new RegExp(cat, 'i') } catch (e) {
      warnings.push(`⚠️ 配置「${field}」分类正则无效：「${cat}」`)
    }
  },

  /** 解析多行配置（<br> / \n\n 分割），返回行数组 */
  _splitLines (configStr) {
    // v3.108 fuzz：/###/.test(Symbol) 隐式 String() 抛 TypeError——Symbol 视为无配置
    if (configStr === undefined || configStr === null || typeof configStr === 'symbol') return []
    let s
    try { s = String(configStr) } catch (e) { return [] } // 嵌套 Symbol 数组 String() 崩 → 无配置
    configStr = s
    if (!configStr) return []
    if (!/###/.test(configStr)) return null // 简单模式（测试锁定契约；调用方均有 /###/ 守卫才调用）
    return configStr.split(/<br\s*\/?>|\r\n|\r|\n/) // R2：支持 <br/> 自闭合（与 htmlToMarkdown br 口径一致）
  },

  /**
     * 编译过滤规则 —— 启动时执行一次
     * 将 Config.filter 中的字符串预编译为 RegExp / 结构化规则
     * 后续过滤直接使用编译后的规则，不再 new RegExp()
     */
  compileRules (rawCfg) {
    rawCfg = rawCfg || {}
    const compiled = {}

    // 编译简单的正则字段（不含 ### 时）
    for (const field of FILTER_FIELDS) {
      // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 该字段置 null（跳过）
      let val = rawCfg[field]
      if (val === undefined || val === null || typeof val === 'symbol') {
        compiled[field] = null
        continue
      }
      try { val = String(val) } catch (e) { compiled[field] = null; continue }
      if (!val) {
        compiled[field] = null
        continue
      }

      if (field === 'pingbifenlei' && /###/.test(val)) {
        // pingbifenlei 不支持 ### 多行，跳过
        compiled[field] = null
        continue
      }
      if (/###/.test(val)) {
        // 多行多分类模式：预分割并编译每行
        const lines = this._splitLines(val)
        const rules = []
        for (const line of lines) {
          const { cat, val, parts } = this._parseLine(line)
          if (parts.length >= 2) {
            if (!val) continue // 值正则为空 → 跳过（避免永真规则）
            let catRe = null
            if (cat) {
              catRe = this._compileCatRe(cat)
              if (!catRe) continue
            }
            let valRe = null
            if (this.hasNestedQuantifier(val)) continue // ReDoS 防护：嵌套量词跳过
            try { valRe = new RegExp(val, 'i') } catch (e) {
              console.warn(`⚠️ 规则「${String(field)}」包含非法正则「${String(val)}」，已跳过（v3.239 口径统一：validateConfig 与 compileRules 均告警）`)
              continue
            }
            if (valRe) rules.push({ cat: catRe, val: valRe })
          }
        }
        compiled[field] = { _type: 'multi', rules }
      } else {
        // 简单模式：直接编译为 RegExp
        // v3.156：先 trim——空白配置('   ')曾编译成 /   /i 假过滤（validateConfig 说忽略但实际生效）
        val = val.trim()
        if (!val) { compiled[field] = null; continue }
        if (this.hasNestedQuantifier(val)) { compiled[field] = null; continue } // ReDoS 防护
        try {
          compiled[field] = { _type: 're', re: new RegExp(val, 'i') }
        } catch (e) {
          console.warn(`⚠️ 规则「${String(field)}」包含非法正则「${String(val)}」，已跳过（v3.239 口径统一：validateConfig 与 compileRules 均告警）`)
          compiled[field] = null // 非法正则置 null 跳过（validateConfig 已警告）
        }
      }
    }

    // 编译 pingbitime（特殊处理）
    // v3.156：先 trim——空白('   ')曾 Number→0 静默关闭时间过滤
    let pbRaw = ''
    try { pbRaw = rawCfg.pingbitime === undefined || rawCfg.pingbitime === null ? '' : String(rawCfg.pingbitime).trim() } catch (e) { pbRaw = '' } // 脏配置无法转字符串时忽略规则，不让启动崩溃
    if (pbRaw) {
      rawCfg.pingbitime = pbRaw
      if (/###/.test(rawCfg.pingbitime)) {
        const lines = this._splitLines(rawCfg.pingbitime)
        const rules = []
        for (const line of lines) {
          const { cat, val, parts } = this._parseLine(line)
          if (!val) continue // 空值跳过（与 pingbifenlei 惯例一致；否则 Number('')=0 静默生成 0 天规则，v3.238）
          if (parts.length >= 2) {
            let catRe = null
            if (cat) {
              catRe = this._compileCatRe(cat)
              if (!catRe) continue
            }
            const value = Number(val)
            if (Number.isFinite(value) && value >= 0) rules.push({ cat: catRe, value })
          }
        }
        compiled.pingbitime = { _type: 'timeMulti', rules }
      } else {
        const value = Number(rawCfg.pingbitime)
        // v3.157：非法数值(如 'abc')→ null 不编译（曾落 value:0 静默关闭时间过滤；空白已 v3.156 处理）
        compiled.pingbitime = (Number.isFinite(value) && value >= 0) ? { _type: 'time', value } : null
      }
    } else {
      compiled.pingbitime = null
    }

    compiled.__compiled = true
    return compiled
  },

  // ReDoS 纵深防御：matchesCompiled 正则在热路径对输入长度设上限。配置侧 hasNestedQuantifier
  // 已在编译期拦截「嵌套无限量词」这一主要灾难性回溯来源，但仍有其他慢回溯形态（交替/前视/
  // 超大字符类 × 超长输入）可能卡住主线程。对超长输入先截断再 .test()，限界单次匹配最坏耗时。
  // 取舍：超过 _RE_INPUT_MAX 的长文本只在前缀段参与过滤（罕见且可控），换取匹配复杂度有界。
  _RE_INPUT_MAX: 4096,
  /** 截断超长输入到 _RE_INPUT_MAX（避免 .test() 对超长串灾难性回溯） */
  _capReInput (s) {
    return s.length > this._RE_INPUT_MAX ? s.slice(0, this._RE_INPUT_MAX) : s
  },

  /** 多行规则分类匹配：无 cat 限制(匹配所有)或有 cat 且 catename 匹配 */
  _catMatches (rule, catename) {
    if (!rule.cat) return true
    if (!catename) return false
    try {
      const value = typeof catename === 'string' ? catename : String(catename)
      return rule.cat.test(this._capReInput(value))
    } catch (e) {
      return false
    }
  },

  /** 多行规则任意匹配：分类匹配 + 断言成立即返回 true（matchesCompiled/checkTimeCompiled 共用） */
  _anyRule (rules, catename, predicate) {
    if (!Array.isArray(rules)) return false
    for (const rule of rules) {
      if (this._catMatches(rule, catename) && predicate(rule)) return true
    }
    return false
  },

  /** 使用编译后的规则进行匹配（单条） */
  matchesCompiled (compiled, fieldValue, catename) {
    if (!compiled || !fieldValue) return false
    let value
    try { value = typeof fieldValue === 'string' ? fieldValue : String(fieldValue) } catch (e) { return false } // 脏字段 toString/Symbol 失败时保守放行，不让整批 run 崩溃

    if (compiled._type === 're') {
      // 简单正则
      if (!compiled.re || typeof compiled.re.test !== 'function') return false
      return compiled.re.test(this._capReInput(value))
    }

    if (compiled._type === 'multi') {
      // 多行多分类：任意一行匹配即匹配
      if (!Array.isArray(compiled.rules) || compiled.rules.length === 0) return false
      return this._anyRule(compiled.rules, catename, r => r.val.test(this._capReInput(value)))
    }

    return false
  },

  /** 编译后的天数规则检查 */
  checkTimeCompiled (compiled, group) {
    const regTime = Utils.safeGet(group, 'louzhuregtime')
    if (!compiled || !group || regTime === undefined || regTime === null || regTime === '') return null // null = 不拦截；0 时间戳视为有效
    // 脏/无效注册时间（非空但 parseTime 失败，如非法格式）与"缺失"口径一致放行（return null）——
    // 曾因 daysComputed 归 0 天被误判为老号而拦截（parseTime 失败 → days=0 → value>0 拦截）
    const ms = Utils.parseTime(regTime)
    if (ms === null) return null
    const days = Utils.daysFrom(ms)

    if (compiled._type === 'time') {
      return compiled.value > days // true = 拦截
    }

    if (compiled._type === 'timeMulti') {
      return this._anyRule(compiled.rules, Utils.safeGet(group, 'catename'), r => r.value > days)
    }

    return false
  },

  /** 验证配置合法性（与 compileRules 共享解析逻辑） */
  validateConfig (cfg) {
    cfg = cfg || {}
    const warnings = []

    // v3.108 fuzz：配置值 String(嵌套 Symbol 数组) 崩 → 跳过该字段
    const safeStr = (v) => {
      if (v === undefined || v === null || typeof v === 'symbol') return ''
      try { return String(v) } catch (e) { return '' }
    }

    // pingbifenlei 不支持 ### 多行分类语法，给明确警告
    if (safeStr(cfg.pingbifenlei) && /###/.test(safeStr(cfg.pingbifenlei))) {
      warnings.push('⚠️ 配置「pingbifenlei」不支持 ### 多行分类语法，该规则将被忽略\n   如需按分类屏蔽，请直接写分类名正则，例如：微博|赚客吧')
    }

    for (const field of FILTER_FIELDS) {
      const val = safeStr(cfg[field])
      if (!val) continue
      // 多行模式：逐行验证
      if (/###/.test(val)) {
        const lines = val.split(/<br\s*\/?>|\r\n|\r|\n/) // 与 _splitLines 口径一致(含单独 \r、<br/>，R2)
        for (const line of lines) {
          const t = line.trim()
          if (!t) continue
          const { cat, val, parts } = this._parseLine(line)
          if (parts.length < 2) {
            warnings.push(`⚠️ 配置「${field}」行缺少 ### 分隔符，该行将被忽略：「${t}」`)
            continue
          }
          if (parts.length > 2) {
            warnings.push(`⚠️ 配置「${field}」行包含多个 ###，仅前两段生效：「${t}」`)
          }
          if (!val) {
            warnings.push(`⚠️ 配置「${field}」值正则为空，该行将被忽略（避免永真规则）：「${t}」`)
            continue
          }
          if (cat) this._validateCatRe(cat, field, warnings)
          if (this.hasNestedQuantifier(val)) {
            warnings.push(`⚠️ 配置「${field}」值正则含嵌套量词，可能导致灾难性回溯，该行将被忽略：「${val}」`)
            continue
          }
          try { new RegExp(val, 'i') } catch (e) {
            warnings.push(`⚠️ 配置「${field}」值正则无效：「${val}」`)
          }
        }
      } else {
        if (String(val).trim() === '') {
          warnings.push(`⚠️ 配置「${field}」为空白字符，将被忽略`)
          continue
        }
        if (this.hasNestedQuantifier(val)) {
          warnings.push(`⚠️ 配置「${field}」的正则含嵌套量词，可能导致灾难性回溯，该规则将被忽略：「${val}」`)
          continue
        }
        // 与 compileRules 的 'i' 保持一致
        try { new RegExp(val, 'i') } catch (e) { warnings.push(`⚠️ 配置「${field}」包含无效的正则表达式：「${val}」\n   原因：${e.message}`) }
      }
    }

    // 验证 zkt_gjc（只看它关键词，与 App.run 预编译口径一致）
    // R11-1：非字符串（对象/数字等脏配置）→ 显式警告（String 化会把 '[object Object]' 当合法正则，静默怪行为）
    if (cfg.zkt_gjc !== undefined && cfg.zkt_gjc !== null && typeof cfg.zkt_gjc !== 'string') {
      warnings.push(`⚠️ 配置「zkt_gjc」应为字符串，当前为 ${typeof cfg.zkt_gjc}，已忽略只看它过滤`)
    } else if (cfg.zkt_gjc && String(cfg.zkt_gjc).trim() !== '') {
      if (this.hasNestedQuantifier(cfg.zkt_gjc)) {
        warnings.push('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤')
      } else {
        try { new RegExp(cfg.zkt_gjc, 'i') } catch (e) { warnings.push(`⚠️ 配置「zkt_gjc」包含无效的正则表达式：「${cfg.zkt_gjc}」`) }
      }
    }

    // 验证 pingbitime
    // v3.156：空白配置('   ')警告（曾静默当 0 关闭时间过滤，复制粘贴带空格常见）
    let pbStr = ''
    try { pbStr = cfg.pingbitime === undefined || cfg.pingbitime === null ? '' : String(cfg.pingbitime) } catch (e) { pbStr = ''; warnings.push('⚠️ 配置「pingbitime」无法转换为字符串，已忽略') }
    // v3.156：空白/首尾空格警告（多行 ### 不警告——行内分类已 trim，整串首尾空格是格式不是错误）
    if (pbStr.trim() === '' && pbStr !== '') {
      warnings.push('⚠️ 配置「pingbitime」为空白字符，将被忽略')
    } else if (!/###/.test(pbStr) && pbStr.trim() !== '' && pbStr !== pbStr.trim()) {
      warnings.push('⚠️ 配置「pingbitime」含首尾空白，已按去空格后的值处理')
    }
    if (pbStr.trim()) {
      if (/###/.test(pbStr)) {
        const lines = pbStr.split(/<br\s*\/?>|\r\n|\r|\n/) // 与 _splitLines 口径一致(含单独 \r、<br/>，R2)
        for (const line of lines) {
          const { cat, val, parts } = this._parseLine(line)
          if (parts.length >= 2) {
            if (cat) this._validateCatRe(cat, 'pingbitime', warnings)
            const tNum = Number(val)
            if (!Number.isFinite(tNum) || tNum < 0) {
              warnings.push(`⚠️ 配置「pingbitime」的天数值「${(parts[1] || '').trim()}」不是有效数字（需 ≥0 的有限数）`)
            }
          }
        }
      } else {
        // 使用已经安全转换的 pbStr，避免 Symbol/valueOf 异常值再次进入 Number() 或模板插值。
        const tv = Number(pbStr)
        if (!Number.isFinite(tv) || tv < 0) {
          warnings.push(`⚠️ 配置「pingbitime」的值「${pbStr}」不是有效数字（需 ≥0 的有限数）`)
        } else if (!Number.isInteger(tv)) {
          warnings.push(`⚠️ 配置「pingbitime」的值「${pbStr}」是小数，已按整数处理（建议使用整数天数）`)
        }
      }
    }
    // 校验 cache.maxSize（#7）：MessageStore 函数层已回退默认，配置层补提示。
    // 兼容传入完整 Config（cfg.cache.maxSize）或平铺（cfg.maxSize）两种形态
    // v3.175：字符串 maxSize（'10000' 环境变量）曾误报——用 Utils.num 口径
    const maxSizeVal = cfg.cache ? cfg.cache.maxSize : cfg.maxSize
    const msNum = Utils.num(maxSizeVal, -1)
    if (maxSizeVal !== undefined && (!Number.isInteger(msNum) || msNum <= 0)) {
      warnings.push(`⚠️ 配置「cache.maxSize」为「${safeStr(maxSizeVal)}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`)
    }
    return [...new Set(warnings)]
  }
}

// ============================================================
// 🎯 FilterEngine — 过滤引擎层
// ============================================================
const FilterEngine = {
  // v3.239：whitelistFilter 正则编译缓存（热路径复用，避免每条消息 × 字段重复 new RegExp）
  _whitelistReCache: new Map(),
  // 缓存容量上限：keyword 可来自外部/动态输入（消息字段等），理论上无限增长；
  // 带上限 + 淘汰最旧键（Map 保持插入序 ≈ LRU），防内存无限泄漏。
  _WHITELIST_RE_CACHE_MAX: 1000,
  // v3.249 P3：_legacyListfilter 编译结果缓存（热路径复用，避免同配置反复 compileRules 重复 new RegExp）。
  // 键 = rawCfg 各过滤字段的安全 String+trim 归一（与 compileRules 口径对齐）：内容变更→键变更，
  // 天然防止脏缓存；同配置对象/同值配置共享一次编译结果。
  _legacyCompileCache: new Map(),
  _LEGACY_COMPILE_CACHE_MAX: 1000,
  /** 编译缓存键：仅按 compileRules 真正消费的字段归一，保证「编译结果相同 ⇒ 键相同」 */
  _legacyCompileKey (rawCfg) {
    const safeStr = (v) => {
      if (v === undefined || v === null || typeof v === 'symbol') return ''
      try { return String(v).trim() } catch (e) { return '' }
    }
    const parts = []
    for (const f of FILTER_FIELDS) {
      let v
      try { v = rawCfg && rawCfg[f] } catch (e) { v = undefined }
      parts.push(f + '=' + safeStr(v))
    }
    let pb
    try { pb = safeStr(rawCfg && rawCfg.pingbitime) } catch (e) { pb = '' }
    parts.push('pingbitime=' + pb)
    return parts.join('\u0001')
  },
  /** 缺字段保守放行统一：compiled/group 缺失或字段缺失 → true；否则取反执行检查 */
  _passIfMissing (group, field, compiled, checkFn) {
    if (!compiled || !group) return true
    const v = Utils.safeGet(group, field)
    if (v === undefined || v === null || v === '') return true
    try {
      return !checkFn(compiled, group)
    } catch (e) {
      return true // 检查过程异常保守放行，不让整批 run 崩溃
    }
  },

  /** 注册天数过滤（使用编译后的规则） */
  checkRegisterTime (group, compiled) {
    // 显式判断缺失：0 时间戳(1970)视为有效，走 checkTimeCompiled 解析（口径统一）
    return this._passIfMissing(group, 'louzhuregtime', compiled, (c, g) => RuleEngine.checkTimeCompiled(c, g))
  },

  /** 分类屏蔽（使用编译后的规则） */
  checkCategory (group, compiled) {
    return this._passIfMissing(group, 'catename', compiled, (c, g) => {
      const catename = Utils.safeGet(g, 'catename')
      // multi 型规则按行内「分类###值」匹配：分类判定与值判定都基于本条 catename，
      // 传入 null 会导致带分类限制的多行规则永不命中，分类屏蔽失效（P3 修复）。
      return RuleEngine.matchesCompiled(c, catename, catename)
    })
  },

  /**
     * 楼主/标题/内容三级过滤（全部使用编译后的规则）
     *
     * 【优先级（高→低）】
     *   1. 楼主强制展现（zhanxianlouzhu）→ 标题/内容的屏蔽、强化屏蔽整体跳过
     *   2. 标题强制展现（zhanxianbiaoti）→ 内容的屏蔽、强化屏蔽整体跳过
     *   3. 同字段强化屏蔽（plusCfg）→ 可抵消同字段的强制展现（showFlags）
     *   4. 同字段强制展现（showCfg）→ 优先于同字段普通屏蔽
     *   5. 同字段普通屏蔽（blockCfg）
     *
     * 注意：楼主/标题的白名单会"越权"免疫后面字段的强化屏蔽，
     *       这是刻意设计，配置时需留意。
     */
  checkFields (group, compiled) {
    const fieldStages = [
      { key: 'louzhu', getVal: (g) => Utils.safeGet(g, 'louzhu'), showCfg: compiled.zhanxianlouzhu, blockCfg: compiled.pingbilouzhu, plusCfg: compiled.pingbilouzhuplus, blockedBy: [] },
      { key: 'title', getVal: (g) => Utils.safeGet(g, 'title'), showCfg: compiled.zhanxianbiaoti, blockCfg: compiled.pingbibiaoti, plusCfg: compiled.pingbibiaotiplus, blockedBy: ['louzhu'] },
      { key: 'content', getVal: (g) => Utils.safeGet(g, 'content'), showCfg: compiled.zhanxianneirong, blockCfg: compiled.pingbineirong, plusCfg: compiled.pingbineirongplus, blockedBy: ['louzhu', 'title'] }
    ]

    const showFlags = {}
    const blockFlags = {}
    const blockPlusFlags = {}

    // 第一轮：强制展现
    for (const stage of fieldStages) {
      const val = stage.getVal(group)
      if (stage.showCfg && val) {
        if (RuleEngine.matchesCompiled(stage.showCfg, val, Utils.safeGet(group, 'catename'))) {
          showFlags[stage.key] = true
        }
      }
    }

    // 第二轮：屏蔽 + 强化屏蔽
    for (const stage of fieldStages) {
      const val = stage.getVal(group)
      if (!val) continue
      const blocked = stage.blockedBy.some(k => showFlags[k])

      if (stage.blockCfg && !blocked && !showFlags[stage.key]) {
        if (RuleEngine.matchesCompiled(stage.blockCfg, val, Utils.safeGet(group, 'catename'))) {
          blockFlags[stage.key] = true
        }
      }
      if (stage.plusCfg && !blocked && !blockFlags[stage.key]) {
        if (RuleEngine.matchesCompiled(stage.plusCfg, val, Utils.safeGet(group, 'catename'))) {
          blockPlusFlags[stage.key] = true
          showFlags[stage.key] = false
        }
      }
      if (blockFlags[stage.key] || blockPlusFlags[stage.key]) return false
    }
    return true
  },

  /**
     * 主过滤函数
     * 接受编译后的规则（推荐）或原始字符串配置（兼容旧调用）
     */
  listfilter (group, cfg) {
    if (!group) return true
    if (!cfg) return true

    // 自动适配：如果传入的是原始字符串配置（非编译格式），走旧路径
    if (!cfg.__compiled) {
      return this._legacyListfilter(group, cfg)
    }

    if (!this.checkRegisterTime(group, cfg.pingbitime)) return false
    if (!this.checkCategory(group, cfg.pingbifenlei)) return false
    return this.checkFields(group, cfg)
  },

  /** 兼容旧调用的备用路径（直接编译传入的原始字符串） */
  _legacyListfilter (group, rawCfg) {
    // v3.245 P1：compileRules 对脏输入（Symbol/嵌套 Symbol 数组等）可能抛异常——兜底返回 true
    // 保守放行，避免异常冒泡；同时防止 compileRules 结果异常时 listfilter 再走 _legacyListfilter
    // 造成无限递归（旧路径判定 !cfg.__compiled 是启发式，异常对象可能缺失该标记）。
    let compiled
    // v3.249 P3：热路径避免每次重新编译——按配置内容归一化键命中缓存；仅缓存有效编译结果。
    const key = this._legacyCompileKey(rawCfg)
    compiled = this._legacyCompileCache.get(key)
    if (compiled === undefined) {
      try { compiled = RuleEngine.compileRules(rawCfg) } catch (e) { return true }
      if (!compiled || typeof compiled !== 'object' || !compiled.__compiled) return true
      this._legacyCompileCache.set(key, compiled)
      // 超限淘汰最旧键（Map 保持插入序 ≈ LRU），防动态/外部配置无限增长。
      if (this._legacyCompileCache.size > this._LEGACY_COMPILE_CACHE_MAX) {
        this._legacyCompileCache.delete(this._legacyCompileCache.keys().next().value)
      }
    }
    return this.listfilter(group, compiled)
  },

  /**
     * 只看它过滤 —— 独立语义，不依赖 listfilter
     * 直接判断指定字段是否匹配关键词
     */
  /** 向后兼容：只看它过滤（等同于 whitelistFilter(item, 'title', keyword)） */
  filterByKeyword (item, keyword) {
    return this.whitelistFilter(item, 'title', keyword)
  },

  whitelistFilter (item, field, keyword) {
    // 空/空白关键词 = 全部通过（最优先——与历史语义一致；v3.108 安全 String 化）
    if (keyword === undefined || keyword === null || keyword === '') return true
    let kwStr
    try { kwStr = String(keyword) } catch (e) { return true } // 嵌套 Symbol 数组 String() 崩 → 放行
    if (kwStr.trim() === '') return true
    if (!item) return false // 防御：item 缺失 = 不匹配
    const value = Utils.safeGet(item, field)
    // 仅 undefined/null 视为「字段缺失」→ 不匹配；0/空串/false 等已定义值作为有效内容参与匹配，
    // 修复 0 被 if(!value) 短路误判不匹配（0 应可被关键词 '0' 命中）；空串对非空关键词天然不命中，
    // 语义不受影响但不再被短路拦截。
    if (value === undefined || value === null) return false
    if (RuleEngine.hasNestedQuantifier(kwStr)) return true // ReDoS 防护：风险关键词不执行匹配，全部放行（与非法正则口径一致）
    // v3.239：正则编译缓存（过滤热路径，每条消息 × 每个字段都调 whitelistFilter，避免重复 new RegExp）
    let re = this._whitelistReCache.get(kwStr)
    if (re === undefined) {
      try {
        re = new RegExp(kwStr, 'i')
      } catch (e) {
        re = null // 非法正则缓存 null，避免每次重建；语义与下方一致
      }
      this._whitelistReCache.set(kwStr, re)
      // 超限淘汰最旧键，防动态 keyword 无限增长
      if (this._whitelistReCache.size > this._WHITELIST_RE_CACHE_MAX) {
        this._whitelistReCache.delete(this._whitelistReCache.keys().next().value)
      }
    }
    if (re === null) return true // 非法正则：放行（与 App.run 的 zkt_gjc 预编译失败 kwRe=null 不过滤口径一致；宁可多推不可少推）
    // ReDoS 纵深防御：与 matchesCompiled 同口径，超长输入先截断再 .test()——即使关键词含
    // 未被子嵌套量词检测覆盖的慢回溯形态（交替/前视/大字符类 × 超长输入），单次匹配最坏耗时也有界。
    // v3.249：超长 keyword 的 V8 会把正则编译推迟到首次 .test()，此时抛 "Regular expression too
    // large"（new RegExp 不抛）——test 也需 try/catch，失败按放行处理（宁可多推不可少推）。
    try {
      return re.test(RuleEngine._capReInput(typeof value === 'string' ? value : Utils.safeText(value, '')))
    } catch (e) { return true }
  }
}

// ============================================================
// 💾 MessageStore — 缓存管理层
// ============================================================
const MessageStore = {
  // v3.172：cache.dir 非法回退时支持并行 worker 隔离（test_app_parallel 用 XBK_PARALLEL_ID 分片，
  // 回退硬编码 'xianbaoku_cache' 会让 t51 等非法配置测试撞共享目录竞态）
  get cacheDir () {
    const fallback = process.env.XBK_PARALLEL_ID ? `xianbaoku_cache_p${process.env.XBK_PARALLEL_ID}` : 'xianbaoku_cache'
    const raw = typeof Config.cache.dir === 'string' && Config.cache.dir ? Config.cache.dir : fallback
    const root = path.resolve(__dirname)
    const candidate = path.resolve(root, raw)
    const realInsideRoot = (p) => {
      const lexicalInside = p !== root && p.startsWith(root + path.sep)
      if (!lexicalInside) return false
      // 逐级回溯到已存在目录，再 realpath 校验；防止项目内符号链接指向项目外部。
      let probe = p
      try {
        while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe)
        // 已存在的路径层级必须是目录；否则 cache.dir 指向普通文件时，
        // 后续拼接缓存文件会得到 ENOTDIR，而校验却错误放行。
        if (!fs.lstatSync(probe).isDirectory()) return false
        const realProbe = fs.realpathSync(probe)
        const resolved = path.resolve(realProbe, path.relative(probe, p))
        return resolved !== root && resolved.startsWith(root + path.sep)
      } catch (e) {
        return false
      }
    }
    // P2 防御：cache.dir 不能通过 ..、绝对路径或符号链接逃出项目根目录；越界配置回退默认目录。
    if (realInsideRoot(candidate)) return candidate
    const safeFallback = path.resolve(root, fallback)
    if (realInsideRoot(safeFallback)) return safeFallback
    // 默认目录本身若被替换成外部符号链接，也不能原样返回；使用项目根内的应急目录。
    return path.join(root, '.xbk_cache_safe')
  },
  _memoryCache: {},
  // 内存缓存实际键数（与 _memoryCache 同步维护，替代热路径上每次新键写都 Object.keys O(n)）
  _memoCount: 0,
  // 身份索引缓存：WeakMap 按“权威内存缓存数组引用”绑定预计算身份索引，批量 has 判重 O(1)，
  // 避免对同一文件反复线性扫描；权威数组每次变更都是新对象引用（_memoSet 全量替换），
  // 数组被 GC 回收时索引随之自动释放，无需手动失效。
  _identityIndex: new WeakMap(),
  // 内存缓存 key 上限（防御：pushUrl 变化等场景下防止无限增长泄漏；磁盘缓存为权威可重建）
  _MEMO_MAX: 100,
  // 磁盘读取失败标记（按缓存文件路径记录）：ioError/unsafe 读取失败时置位，
  // 供 save 等写入口保守处理——不基于“未读到的空数组”全量覆写磁盘，避免覆盖丢失存量。
  _readFailed: {},

  /** 带上限的内存缓存写入：超限时淘汰最旧键（磁盘不受影响），防理论无限增长；返回是否写入成功 */
  _memoSet (filePath, val) {
    // 键归一化：非字符串键（Symbol/数字等）统一 String 化，保证可被 Object.keys 枚举并参与淘汰，
    // 避免 Symbol 键永不淘汰，也让 toString/valueOf 等原型键走一致的字符串键路径。
    const key = typeof filePath === 'string' ? filePath : String(filePath)
    // R5-2：hasOwnProperty 判断（__proto__ 等原型键不会被 in 误判/直写污染对象原型）
    if (!Object.prototype.hasOwnProperty.call(this._memoryCache, key)) {
      // 用维护的 _memoCount 判断是否打满：热路径每次新键写只需 O(1)，不再全量 Object.keys。
      // 容量上限 100，仅在打满后（每次淘汰最旧键）才需要 Object.keys 定位最旧键，成本被封顶。
      if (this._memoCount >= this._MEMO_MAX) {
        // 超限时淘汰最旧键：普通字符串键按插入顺序，keys[0] 即最早写入的键；无需整体重置
        const keys = Object.keys(this._memoryCache)
        if (keys.length === 0) return false // 上限非正且缓存为空时无可淘汰，拒绝写入
        // 只对字符串键淘汰：数字样键会被 Object.keys 按数值序排列，keys[0] 并非最旧，
        // 故跳过数组索引样键，取首个普通字符串键；全部为索引键时退回 keys[0]。
        const oldest = keys.find(k => typeof k === 'string' && !/^(?:0|[1-9]\d*)$/.test(k)) ?? keys[0]
        try { delete this._memoryCache[oldest] } catch (e) { /* 忽略 */ }
        // 淘汰后按实际键数校准计数（防御外部直删导致的漂移；新增键由下方统一自增）
        this._memoCount = keys.length - 1
        // warn 降频：容量打满后不再每次新键写都提示，仅在从“未满”首次进入“打满淘汰”时提醒一次
        if (!this._memoWarned) {
          console.warn(`内存缓存达到上限(${this._MEMO_MAX})，已淘汰最旧键: ${oldest}（磁盘缓存不受影响）`)
          this._memoWarned = true
        }
      } else {
        // 缓存仍有空间 → 重置降频标记，下次打满时再提醒一次
        this._memoWarned = false
      }
      // 新键写入后计数 +1（打满分支已在上方校准到“淘汰后键数”，此处统一补上新增的这一个）
      this._memoCount++
    }
    // 原型键（__proto__/constructor/prototype）用 defineProperty 写入，避免 `obj['__proto__']=val` 修改对象原型
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      Object.defineProperty(this._memoryCache, key, { value: val, enumerable: true, configurable: true, writable: true })
    } else {
      this._memoryCache[key] = val
    }
    return true
  },

  /** 统一更新/追加：命中则更新(含覆盖提示)，未命中追加；返回是否发生数据变更（无变更则不落盘） */
  _upsert (messages, message, filename) {
    // v3.245 P1：非数组 messages 直接返回 false（不推送）——此前 messages.push 抛 TypeError 崩溃。
    if (!Array.isArray(messages)) return false
    // 脏 message（非有效数据对象）不写入：避免 `{ ...safeObjectCopy(message), timestamp }` 把无效/未规范化
    // 条目带 timestamp 塞进缓存（与 save 入口的 isValidItem 口径一致；此前 _upsert 仅判数组、不判消息）。
    if (!Utils.isValidItem(message)) return false
    // P3：拒绝空对象/空身份——isValidItem 只保证"对象且非数组"，空对象 {} 或缺失 id/url/key 的条目
    // 会被 anonKey 退化为恒定键；这里与 saveBatch 的 identity.valid 口径一致，避免把无意义条目
    // 带 timestamp 塞进缓存（此前 _findDedupIndex 对无效身份返回 -1，会走 else 分支无脑 push）。
    if (!Utils.getMessageIdentity(message).valid) return false
    const idx = this._findDedupIndex(messages, message)
    if (idx >= 0) {
      // v3.156：比较排除 timestamp（同 saveBatch 主路径口径）——否则 oldM 带 timestamp、
      // message 无 timestamp 而内容相同也必报"更新缓存记录"并刷新 timestamp。
      // P3 优化：先做零分配的浅层快速相等检查（内容未变的常见去重路径直接短路，避免深排），
      // 未命中再退回键序无关规范化深排；循环引用等失败时按"已更新"处理不崩溃。
      if (!this._contentChangedIgnoringTs(messages[idx], message)) return false // 内容完全一致：不更新、不刷新 timestamp、不触发落盘
      console.log(`更新缓存记录: ${filename}`)
      messages[idx] = { ...Utils.safeObjectCopy(message), timestamp: new Date().toISOString() }
    } else {
      messages.push({ ...Utils.safeObjectCopy(message), timestamp: new Date().toISOString() })
    }
    return true
  },

  /** 判重内容比较：排除顶层 timestamp、键序无关，判断两消息内容是否实际变更。
      P3 优化：先做零分配的浅层快速相等检查（内容未变的去重路径直接短路，避免对整条大消息
      做两次 deep normalize+JSON.stringify），未命中再退回既有键序无关规范化序列化比较，
      语义与旧实现完全一致（循环引用/异常按"已变更"处理）。 */
  _contentChangedIgnoringTs (oldM, message) {
    if (Utils.shallowEqualIgnoringTimestamp(oldM, message)) return false
    const stripTs = (o) => { if (!o || typeof o !== 'object') return o; const c = { ...o }; delete c.timestamp; return c }
    const canon = (o) => { try { return JSON.stringify(normalize(stripTs(o))) } catch (e) { return null } }
    const a = canon(oldM)
    const b = canon(message)
    if (a === null || b === null) return true
    return a !== b
  },

  /** 统一判重：所有入口复用 Utils.sameMessageIdentity，避免单条/批内/缓存逻辑分裂 */
  _findDedupIndex (messages, message) {
    if (!Array.isArray(messages)) return -1
    // 新消息身份只计算一次；身份无效则不可能命中任何有效缓存，直接返回 -1（不再全量扫描）
    const b = Utils.getMessageIdentity(message)
    if (!b.valid) return -1
    // 预计算每条缓存消息身份传入（a），避免 sameMessageIdentity 逐条重复求值；命中即返回
    for (let i = 0; i < messages.length; i++) {
      const a = Utils.getMessageIdentity(messages[i])
      if (Utils.sameMessageIdentity(messages[i], message, a, b)) return i
    }
    return -1
  },

  init () {
    try {
      // 昂贵的 cacheDir getter（含 realpath 校验）只求值一次；existsSync 守卫保留，
      // 避免目录已存在时调用 mkdirSync（故障注入测试依赖该守卫）。
      const dir = this.cacheDir
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    } catch (e) {
      // v3.245 P1：目录创建失败必须暴露——此前只 console.error 吞错，后续所有缓存写
      // 操作（save/saveBatch）都会因目录缺失而连锁失败且原因不明。
      console.error(`缓存目录创建失败: ${this.cacheDir}`, e && e.message || e)
      throw e
    }
  },

  getFilePath (filename) {
    // 路径安全：只取 basename 并清洗，外部传 ../ 或绝对路径无法逃出缓存目录
    // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 视为空文件名
    let fnStr
    try { fnStr = String(filename || '') } catch (e) { fnStr = '' }
    // v3.248：NUL（\u0000）不在非法字符正则内，会被保留进路径导致 fs 抛
    // ERR_INVALID_ARG_VALUE——一并清洗，避免 getFilePath 产物触发 fs 报错。
    let safe = path.basename(fnStr).replace(/[\\/:*?"<>|\u0000]/g, '')
    // v3.176：非信息文件名（对象/布尔 String 化产物）回退 default.json——与 getFileName 口径一致
    // （曾产生 xianbaoku_cache/[object Object] 垃圾文件：test_filter 参数颠倒 + 此处无防御）
    if (!safe || safe === '.' || safe === '..' || safe === '[object Object]' || safe === 'undefined' || safe === 'null' || safe === 'true' || safe === 'false') safe = 'default.json'
    // 按 UTF-8 字节截断且不切半代理对：返回不超过 maxBytes 的最长前缀，且末尾
    // 不会残留孤代理（避免输出乱码）。多字节字符不能按字符索引截断，故二分。
    const truncateByBytes = (s, maxBytes) => {
      if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
      let lo = 0
      let hi = s.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid
        else hi = mid - 1
      }
      // 末位若是高位代理，说明切在代理对中间，回退一格丢弃半个码点（不留孤代理）
      if (lo > 0) {
        const cu = s.charCodeAt(lo - 1)
        if (cu >= 0xd800 && cu <= 0xdbff) lo -= 1
      }
      return s.slice(0, lo)
    }
    // 截断结果为空时保留首个完整码点（避免空名与孤代理）
    const keepOne = (s) => s || (() => {
      const f = safe.codePointAt(0)
      return safe.slice(0, f > 0xffff ? 2 : 1)
    })()
    // 文件名超长截断：先尝试保留扩展名，保证总字节 <= 200
    if (Buffer.byteLength(safe, 'utf8') > 200) {
      const dot = safe.lastIndexOf('.')
      let ext = dot > 0 ? safe.slice(dot) : ''
      let maxBase = 200 - Buffer.byteLength(ext, 'utf8')
      if (maxBase < 1) { ext = ''; maxBase = 200 } // 扩展名本身超长：放弃保留扩展名
      const base = truncateByBytes(dot > 0 ? safe.slice(0, dot) : safe, maxBase)
      safe = keepOne(base) + ext
    }
    // 兜底校验：截断后仍可能超 200 字节（如扩展名超长且首字符为多字节、Math.max(1) 强保
    // 字符时），放弃扩展名整体再按字节截断，保证不变量成立。
    if (Buffer.byteLength(safe, 'utf8') > 200) {
      safe = keepOne(truncateByBytes(safe, 200))
    }
    return path.join(this.cacheDir, safe)
  },

  _ensureFileExists (filePath) {
    // 空路径早退：writeAtomic 对空路径会留下无法重命名的残留 .tmp，直接跳过。
    if (!filePath) return
    // 父目录创建与原子初始化交给 writeAtomic（内部已 ensureParent），避免冗余 stat。
    // 容错：文件不存在时 writeFile 抛错不逃逸（双故障下 readMessages 仍可返回 []）
    try {
      if (!fs.existsSync(filePath)) writeAtomic(filePath, '[]', '缓存初始化')
    } catch (e) {
      console.error(`缓存初始化失败 ${filePath}:`, e.message)
    }
  },

  readMessages (filePath) {
    // R5-2：hasOwnProperty 读取（'__proto__' 直读会返回 Object.prototype 而非缓存值）
    if (Object.prototype.hasOwnProperty.call(this._memoryCache, filePath)) {
      // 常驻进程保护：外部误删缓存文件时，内存中的权威快照继续用于判重，
      // 并尝试原子恢复磁盘文件；恢复失败时保留旧快照，不写入空数组。
      let exists = true
      try { exists = fs.existsSync(filePath) } catch (e) { exists = true }
      if (!exists) {
        // v3.236：恢复写入抛错（磁盘满/权限）时同样降级保留内存快照，不向外传播破坏判重流程
        try {
          const restored = this.saveMessages(filePath, this._memoryCache[filePath])
          if (!restored) console.warn(`缓存文件缺失且恢复失败，继续使用内存缓存：${filePath}`)
        } catch (e) {
          console.warn(`缓存文件缺失且恢复异常，继续使用内存缓存：${filePath} (${String((e && e.message) || e)})`)
        }
      }
      // 内存快照为权威读取：清除该文件的读取失败标记（后续 save 可安全基于快照落盘）
      try { delete this._readFailed[filePath] } catch (e) { /* 忽略 */ }
      return this._memoryCache[filePath]
    }
    this._ensureFileExists(filePath)
    const result = readSafeTextResult(filePath)
    if (result.status !== 'ok') {
      const detail = result.error && result.error.message ? result.error.message : result.status
      if (result.status === 'unsafe') console.error(`拒绝读取非普通缓存文件 ${filePath}`)
      else if (result.status === 'ioError') console.error(`缓存读取失败 ${filePath}:`, detail)
      // missing/ioError/unsafe 都不能缓存空数组；后续恢复后仍应重新读取磁盘。
      // ioError/unsafe 读取失败时记录失败标记：返回 [] 供判重/调用方降级，但绝不允许
      // 后续 save 据此全量覆写磁盘（会把未读到的存量数据覆盖丢失）。
      if (result.status === 'ioError' || result.status === 'unsafe') {
        try { this._readFailed[filePath] = true } catch (e) { /* 忽略 */ }
      }
      return []
    }
    let data
    try {
      data = JSON.parse(result.text || '[]')
    } catch (e) {
      // 不再重置文件为 []：那会销毁磁盘上的去重缓存，且未标记 _readFailed，
      // 使 has() 误判 false 并放行同一条消息重复入库。改为与 ioError/unsafe 一致的
      // 保守处理——保留异常文件供恢复，并标记 _readFailed 让 save() 拒绝覆写。
      console.error(`缓存 JSON 解析失败，跳过写入以保护数据 ${filePath}:`, e.message)
      try { this._readFailed[filePath] = true } catch (err) { /* 忽略 */ }
      return []
    }
    if (Array.isArray(data)) {
      // 过滤非对象元素（null/原始值），避免后续 has/save 访问 m.id 崩溃
      // v3.157：排除数组元素（typeof object 含数组——数组元素 m.id 访问异常、判重混乱）
      const clean = data.filter(m => m && typeof m === 'object' && !Array.isArray(m))
      // 成功读取 → 清除该文件读取失败标记
      try { delete this._readFailed[filePath] } catch (e) { /* 忽略 */ }
      this._memoSet(filePath, clean)
      return clean
    }
    // 合法 JSON 但非数组（对象等）→ 不再重置：保留原文件并标记读取失败，
    // 避免误判空缓存导致同一条消息重复入库；save() 会因 _readFailed 拒绝覆写。
    console.error(`缓存格式异常（非数组），跳过写入以保护数据 ${filePath}`)
    try { this._readFailed[filePath] = true } catch (e) { /* 忽略 */ }
    return []
  },

  saveMessages (filePath, messages) {
    // 记录写入前的内存缓存：落盘失败时不能把未持久化的新状态伪装成已保存。
    const hadMemo = Object.prototype.hasOwnProperty.call(this._memoryCache, filePath)
    const memoBefore = hadMemo ? this._memoryCache[filePath] : undefined
    const restoreMemo = () => {
      if (hadMemo) this._memoSet(filePath, memoBefore)
      else {
        try { delete this._memoryCache[filePath] } catch (e) { /* 忽略 */ }
      }
    }
    // 拷贝后再截断：不原地修改调用方传入的数组（外部复用场景）
    const toSave = Array.isArray(messages) ? [...messages] : []
    // maxSize 防御：非正整数回退默认（R3-2 整数化——小数 2.5 会让 splice 的 ToInteger 截断产生模糊条数；0/负值避免缓存被清空）
    // v3.176：Utils.num 口径——'5000'(环境变量字符串) 曾 Number.isInteger 判否 → 静默回退 10000
    // （validateConfig 按 v3.175 口径判合法不警告 → 层间不一致，用户以为 5000 生效实际 10000）
    const maxSize = (() => { const v = Utils.num(Config.cache.maxSize, -1); return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_SIZE })()
    if (toSave.length > maxSize) {
      console.warn(`缓存超出上限(${maxSize})，裁剪掉最早 ${toSave.length - maxSize} 条`)
      toSave.splice(0, toSave.length - maxSize)
    }
    const text = (() => {
      // 序列化防御：循环引用等无法 JSON.stringify 时容错（内存缓存保留，不落盘不崩溃）
      try {
        return JSON.stringify(toSave, null, 2)
      } catch (e) {
        console.error(`缓存序列化失败 ${filePath}（可能含循环引用）:`, e.message)
        return null
      }
    })()
    if (text === null) {
      restoreMemo()
      return false
    }
    // 统一安全原子写入：普通文件检查、唯一临时文件、失败清理和错误日志集中处理。
    const saved = writeAtomic(filePath, text, '缓存')
    if (!saved) {
      restoreMemo()
      return false
    }
    this._memoSet(filePath, toSave)
    return true
  },

  /** 预计算某缓存文件的身份索引：与 sameMessageIdentity 的匹配关系同构（见 has），
     仅构建一次并在批量 has 间复用，避免每次全量线性扫描 + 逐条重算身份。 */
  _buildIdentityIndex (messages) {
    const idx = { idByKey: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anonByKey: new Map() }
    for (let i = 0; i < messages.length; i++) {
      const ident = Utils.getMessageIdentity(messages[i])
      if (!ident.valid) continue
      if (ident.kind === 'id') {
        // id 消息：按 idKey 匹配（对 id 查询），也按 url 匹配（对 url 查询的双向 fallback）
        Utils.addIndex(idx.idByKey, ident.idKey, i)
        if (ident.url) Utils.addIndex(idx.idWithUrl, ident.url, i)
      } else if (ident.kind === 'url') {
        // 纯 url 消息：对 id/url 查询均按 url 匹配
        Utils.addIndex(idx.urlOnly, ident.url, i)
      } else {
        // anon 消息：仅按匿名合成键匹配
        Utils.addIndex(idx.anonByKey, ident.key, i)
      }
    }
    return idx
  },

  /** 基于预计算身份索引的判重查询：精确复刻 sameMessageIdentity(cacheMsg, message) 的匹配关系 */
  _indexHasIdentity (idx, message) {
    const b = Utils.getMessageIdentity(message)
    if (!b.valid) return false
    if (b.kind === 'id') {
      // id 查询：命中 id 缓存同 idKey；或纯 url 缓存同 url
      return idx.idByKey.has(b.idKey) || (!!b.url && idx.urlOnly.has(b.url))
    }
    if (b.kind === 'url') {
      // url 查询：命中纯 url 缓存同 url；或带 url 的 id 缓存同 url
      return (!!b.url && idx.urlOnly.has(b.url)) || (!!b.url && idx.idWithUrl.has(b.url))
    }
    // anon 查询：命中匿名合成键相同的 anon 缓存
    return idx.anonByKey.has(b.key)
  },

  has (message, filename) {
    // 与 save 一致：先做条目有效性校验，无效 message（null/原始值/数组）直接判不存在，
    // 不依赖 getMessageIdentity 的隐式容错。
    if (!Utils.isValidItem(message)) return false
    const messages = this.readMessages(this.getFilePath(filename))
    // 预计算身份索引按数组引用缓存：同文件重复 has 直接 O(1) 命中，不再对整数组线性扫描。
    let idx = this._identityIndex.get(messages)
    if (!idx) {
      idx = this._buildIdentityIndex(messages)
      this._identityIndex.set(messages, idx)
    }
    return this._indexHasIdentity(idx, message)
  },

  save (message, filename) {
    // 单条写入走同一统一身份/事务路径，同时保留 _upsert 作为单条缓存 API 的可达实现。
    if (!Utils.isValidItem(message)) return false
    // P3：拒绝空对象/空身份——isValidItem 只保证"对象且非数组"，空对象 {} 或缺失 id/url/key 的
    // 条目会被 anonKey 退化为恒定键；这里在入口一并拒绝（与 saveBatch/_upsert 的 identity.valid
    // 口径一致），既避免把无意义条目带 timestamp 写进缓存，也避免在读盘/落盘前多一次磁盘 IO。
    if (!Utils.getMessageIdentity(message).valid) return false
    const filePath = this.getFilePath(filename)
    const messages = [...this.readMessages(filePath)]
    // 读失败保守处理：磁盘缓存读取失败（ioError/unsafe）时返回的是 []，若直接落盘会把
    // 未读到的存量数据全量覆盖丢失；此时拒绝写入并提示，等待下次成功读取后恢复。
    if (this._readFailed[filePath]) {
      console.error(`缓存读取失败，跳过写入以保护存量数据 ${filePath}`)
      return false
    }
    // 内容未变化（判重命中且数据一致）时不重写磁盘、不刷新 timestamp。
    if (!this._upsert(messages, message, filename)) return true
    return this.saveMessages(filePath, messages)
  },

  /** 批量写入：一次性 append 多条消息，只触发一次磁盘写入（用于单次运行内的多条新数据） */
  saveBatch (newMessages, filename) {
    // 公开 API 防御：批量输入必须是数组；对象/数字/Symbol 等不可迭代值不能直接进入 for...of。
    if (!Array.isArray(newMessages) || newMessages.length === 0) return
    const filePath = this.getFilePath(filename)
    // readMessages 可能返回进程内内存缓存权威数组；先复制，避免落盘失败前原地污染内存缓存。
    const messages = [...this.readMessages(filePath)]
    // v3.249：与 save 同口径——缓存读取失败（ioError/unsafe/_readFailed）时拒绝覆写，
    // 避免把未读到的存量数据全量覆盖销毁去重缓存。注意：必须先 readMessages 再检查
    // _readFailed（置位发生在 readMessages 内部），检查必须在读取之后，否则首次调用
    // 会绕过守卫直接覆写损坏文件（此前先判后读的时序漏洞）。
    if (this._readFailed[filePath]) {
      console.error(`缓存读取失败，跳过批量写入以保护存量数据 ${filePath}`)
      return
    }
    // 统一身份索引：每个键保存可能命中的 index 集合；更新时保留历史候选，查询时按当前身份校验，
    // 避免复杂的删除/重建逻辑在同 id/同 URL 脏缓存场景下产生索引分裂。
    const firstIndex = (map, key, match) => {
      const set = map.get(key)
      if (!set) return undefined
      let first
      for (const i of set) {
        if (i < 0 || i >= messages.length) continue
        if (!match(messages[i])) continue
        if (first === undefined || i < first) first = i
      }
      return first
    }
    const idMap = new Map()
    const urlMap = new Map()
    const urlOnlyMap = new Map()
    const identityMap = new Map()
    const addIdentityIndexes = (message, i) => {
      const identity = Utils.getMessageIdentity(message)
      if (!identity.valid) return
      Utils.addIndex(identityMap, identity.key, i)
      if (identity.kind === 'id') Utils.addIndex(idMap, identity.idKey, i)
      if (identity.url) Utils.addIndex(urlMap, identity.url, i)
      if (identity.kind === 'url') Utils.addIndex(urlOnlyMap, identity.url, i)
    }
    const removeIdentityIndexes = (message, i) => {
      const identity = Utils.getMessageIdentity(message)
      if (!identity.valid) return
      const del = (map, key) => { const s = map.get(key); if (s) s.delete(i) }
      del(identityMap, identity.key)
      if (identity.kind === 'id') del(idMap, identity.idKey)
      if (identity.url) del(urlMap, identity.url)
      if (identity.kind === 'url') del(urlOnlyMap, identity.url)
    }
    messages.forEach(addIdentityIndexes)
    const NOW = () => {
      // v3.251 g5：lastTs/inc 提升为 MessageStore 级（_nowLastTs/_nowInc），跨 saveBatch
      // 调用保持全局单调——此前每次调用重置导致跨批次时间戳回退乱序（1002→1001）。
      let t = Date.now()
      if (this._nowLastTs === undefined) this._nowLastTs = 0
      if (this._nowInc === undefined) this._nowInc = 0
      if (t > this._nowLastTs) {
        // 系统时钟前进：以真实时间戳为准
        this._nowLastTs = t
        this._nowInc = 0
      } else {
        // 同毫秒或时钟回拨：在上一已返回值上严格 +1，保证全局严格单调
        this._nowLastTs += 1
        this._nowInc = 0
      }
      return new Date(this._nowLastTs).toISOString()
    }
    for (const message of newMessages) {
      // 元素级校验：非对象元素跳过（避免访问 message.id 崩溃）
      if (!Utils.isValidItem(message)) continue
      const identity = Utils.getMessageIdentity(message)
      if (!identity.valid) continue
      let idx = -1
      if (identity.kind === 'id') {
        const c1 = firstIndex(idMap, identity.idKey, mm => {
          const i = Utils.getMessageIdentity(mm)
          return i.kind === 'id' && i.idKey === identity.idKey
        })
        const c2 = identity.url
          ? firstIndex(urlOnlyMap, identity.url, mm => {
            const i = Utils.getMessageIdentity(mm)
            return i.kind === 'url' && i.url === identity.url
          })
          : undefined
        const cands = [c1, c2].filter(x => x !== undefined)
        if (cands.length) idx = Math.min(...cands)
      } else if (identity.kind === 'url') {
        const u = firstIndex(urlMap, identity.url, mm => {
          const i = Utils.getMessageIdentity(mm)
          return !!i.url && i.url === identity.url
        })
        if (u !== undefined) idx = u
      } else {
        const a = firstIndex(identityMap, identity.key, mm => Utils.getMessageIdentity(mm).key === identity.key)
        if (a !== undefined) idx = a
      }
      if (idx === undefined) idx = -1
      if (idx >= 0) {
        const oldM = messages[idx]
        // v3.156：比较排除 timestamp——曾因 oldM 有 timestamp、message 无而内容相同也必报"更新缓存记录"
        // P3 优化：复用 _contentChangedIgnoringTs（先浅层短路、后键序无关深排），与 _upsert 口径一致
        const changed = this._contentChangedIgnoringTs(oldM, message)
        if (changed) console.log(`更新缓存记录: ${filename}`)
        removeIdentityIndexes(oldM, idx)
        messages[idx] = { ...Utils.safeObjectCopy(message), timestamp: NOW() }
        addIdentityIndexes(messages[idx], idx)
      } else {
        messages.push({ ...Utils.safeObjectCopy(message), timestamp: NOW() })
        const i = messages.length - 1
        const newIdentity = Utils.getMessageIdentity(messages[i])
        if (newIdentity.valid) {
          Utils.addIndex(identityMap, newIdentity.key, i)
          if (newIdentity.kind === 'id') Utils.addIndex(idMap, newIdentity.idKey, i)
          if (newIdentity.url) Utils.addIndex(urlMap, newIdentity.url, i)
          if (newIdentity.kind === 'url') Utils.addIndex(urlOnlyMap, newIdentity.url, i)
        }
      }
    }
    this.saveMessages(filePath, messages)
  },

  getFileName (url) {
    // 防御（R1）：非字符串 url → 可区分坏源(数字/布尔)哈希命名；无信息(空串/对象)保持 default.json
    // v3.157：数字/布尔 String 化可区分（123 vs 456），曾与空串/对象共用 default.json 互相误判重
    if (typeof url !== 'string') {
      let badStr
      try { badStr = String(url) } catch (e) { return 'default.json' }
      if (!badStr || badStr === '[object Object]' || badStr === 'undefined' || badStr === 'null' || badStr === 'true' || badStr === 'false') return 'default.json'
      // v3.249：bad_ 名内嵌坏源字节长 + anonKey(64位) 双重区分——单纯哈希不同坏源存在理论碰撞
      // 会产出同名缓存互相覆盖（P3）；anonKey 已由 32 位升级为两路 djb2 拼接(64位)，再附字节长
      // 进一步把碰撞面收窄到「同长+同哈希」，并让文件名自描述便于排查。开销仅数个字节，
      // getFileName 产物后续经 getFilePath 200 字节截断，不影响路径安全不变量。
      return 'bad_' + Buffer.byteLength(badStr, 'utf8') + '_' + Utils.anonKey(badStr) + '.json'
    }
    if (!url) return 'default.json'
    const parts = url.split('/')
    let name = parts[parts.length - 1].split(/[?#]/)[0] // 去掉查询参数与 hash
    if (!name || /^\.+$/.test(name)) name = 'default' // 空/纯点串兜底，避免 '..' → '...json'
    name = name.replace(/[\\/:*"<>|]/g, '_') // 清洗文件系统保留字符
    name = name.replace(/[\u0000-\u001f]/g, '') // 过滤控制字符
    if (!name) name = 'default' // 清洗后复检空串：末段全为控制字符时避免生成隐藏文件 '.json'
    if (!name.endsWith('.json')) name += '.json'
    return name
  }
}

// ============================================================
// 🌐 Network — 网络请求层
// ============================================================
const Network = {
  /**
     * 拉取数据，失败自动重试
     * 官方 got 自带 retry；这里显式关闭内置重试，由主流程统一实现重试、退避和 4xx 例外语义
     */
  async fetchData () {
    let lastErr
    // v3.223：延迟加载推送模块（含 got）——与接口请求并行，主流程不必先等模块加载完成
    getNotify().catch(() => { /* 加载失败由推送阶段真实报错，这里不阻塞接口 */ })
    // 线报接口 DNS 与实际请求共用 xbk_agents.dnsLookup：提前启动解析，
    // 若请求随后进入同一主机，dnsLookup 会合并到同一个 pending 查询，
    // 不增加额外 HTTP 请求，也不阻塞请求启动。
    try {
      const apiHost = new URL(Config.api.pushUrl).hostname
      if (apiHost) {
        Promise.resolve(prewarmDns(apiHost))
          .then((result) => {
            if (PROFILE3) console.log(`[profile api dns-prewarm] host=${apiHost} ok=${result.ok} elapsedMs=${result.elapsedMs} family=${result.family || 'auto'}`)
            return result
          })
          .catch((error) => {
            if (PROFILE3) console.log(`[profile api dns-prewarm] host=${apiHost} ok=false error=${Utils.safeErrorText(error, 'unknown')}`)
            return null
          })
      }
    } catch (e) {
      if (PROFILE3) console.log(`[profile api dns-prewarm] skipped reason=${Utils.safeErrorText(e, 'unknown')}`)
    }
    // R4-1：retry 非法值有界兜底——Infinity 会让 `attempt <= retry` 死循环重试（validateConfig 只警告不阻止）；

    // NaN → 意外只跑 1 次；小数 → 次数模糊。合法整数（默认 2）行为零变更
    // v3.158：Utils.num 转换——'5'(环境变量字符串) → 5（曾 Number.isFinite('5')=false 回退 2）
    const maxRetry = (() => { const r = Utils.num(Config.api.retry, 2); return Number.isInteger(r) && r >= 0 ? Math.min(r, 9999) : 2 })()
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      if (PROFILE3) console.log(`[profile api attempt] start=${attempt + 1}/${maxRetry + 1}`)
      try {
        // retry: { limit: 0 } 关闭 got 内置重试，完全交给外层手写逻辑
        const result = await fetchJson(Config.api.pushUrl, {

          timeout: Utils.num(Config.api.timeout, 5000), // v3.162：字符串'5000'→5000（v3.158 转换 7 处漏了 timeout，曾回退 15s）
          retry: { limit: 0 },
          headers: {
            'User-Agent': `xbk-push-script/${PKG_VERSION}`,
            Accept: 'application/json'
          }
        })
        if (PROFILE3) console.log(`[profile api attempt] success=${attempt + 1}/${maxRetry + 1}`)
        return result
      } catch (e) {
        lastErr = e

        // 4xx 客户端错误：重试也没用，直接抛出（429 限流除外——限流可能瞬时，值得重试）
        if (e.response) {
          const sc = e.response.statusCode
          if (sc !== undefined && sc < 500 && sc !== 429 && sc !== 408 && sc !== 409) throw e // v3.158: 408/409 临时性也重试
        }

        if (attempt < maxRetry) { // v3.157：用兜底后的 maxRetry（曾用原始 Config.api.retry，非法类型时与实际重试不一致）
          // 退避等待：1s、2s、3s...（加 0-500ms 随机抖动，避免多实例同时重试）
          const wait = 1000 * (attempt + 1) + Math.floor(Math.random() * 500)
          console.log(`请求失败（${Utils.safeErrorText(e, 'unknown')}），${wait / 1000}s 后重试（第 ${attempt + 1}/${maxRetry} 次）...`) // R5-1：显示兜底后次数
          await new Promise(r => setTimeout(r, wait))
        }
      }
    }
    // 重试耗尽后抛出；防御 retry 为负等异常配置（循环可能一次都不执行 → lastErr undefined）
    throw lastErr || new Error('请求失败（未知错误）')
  }
}

// ============================================================
// 📤 Pusher — 推送层
// ============================================================
const Pusher = {
  // notifyModule：可选推送模块实例（延迟加载）；未传时按需加载（保持兼容/测试兜底）
  async send (text, desp, notifyModule) {
    // R4-2：非字符串归一——undefined/null → 空串（避免模板串输出 'undefined' 文本）；数字等 String() 化
    text = text === undefined || text === null ? '' : String(text)
    desp = desp === undefined || desp === null ? '' : String(desp)
    // 最终推送出口再清理一次：自定义 {内容} 模板可能绕过 Formatter 的 {Html内容} 专用清理，
    // 而 WxPusher HTML 通道会直接渲染 desp；统一出口防止任意模板把主动 HTML 带入客户端。
    // 仅当 desp 呈 HTML 形态（将触发 wxpusher 等 HTML 渲染通道）时清洗：
    // 纯 Markdown/纯文本（默认 {Markdown内容}、{内容} 普通文本）不清洗，
    // 避免破坏 Markdown 代码块、技术讨论文本（onerror= 等字面量）与排版实体。
    const htmlLike = /<\s*\/?\s*[A-Za-z][A-Za-z0-9-]*(?=\s|\/?>)[^>]*>/i.test(desp)
    if (htmlLike) {
      desp = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(desp))
    }
    // 抛异常由主流程处理：推送失败的消息不写缓存，下次运行重试（避免永久丢失）
    // 加整体超时：单通道最坏 15s，避免慢通道把整批推送拖到数分钟
    // v3.121：clearTimeout 清除超时定时器——Promise.race 完成后定时器仍挂着会导致
    // 进程退出延迟（事件循环被 keep-alive）+ 多次推送定时器堆积（资源泄漏）
    let timer
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const notifyMod = notifyModule || (notify || await getNotify())
    try {
      await Promise.race([
        notifyMod.sendNotify(text, desp, controller ? { signal: controller.signal } : {}),
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            if (controller) controller.abort()
            rej(new Error('推送超时(10s)'))
          }, 10000)
        })
      ])
    } finally {
      clearTimeout(timer)
      if (controller) controller.abort()
    }
  }
}

// ============================================================
// 🚀 App — 主流程层
// ============================================================
const App = {
  // v3.176：运行日志时间戳本地化（与日报/告警本地口径一致）——曾 toISOString（UTC），
  // UTC+8 用户凌晨 cron 排查时 UTC 行与本地日期混排易误判（系统审查 #9）
  _localStamp () {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  },

  // 文件级安全检查：缓存目录安全并不等于目录内的单个文件安全。
  // 拒绝符号链接/目录作为文件目标，避免 filter.hash/run.log 等路径跟随链接逃逸。
  _isRegularOrMissing (filePath) {
    return isRegularOrMissing(filePath)
  },

  // 状态/哈希文件安全读取：保持 readSafeTextResult 的 status 区分（missing/ioError/
  // unsafe/tooLarge），并强制大小上限，杜绝异常膨胀文件被整读入内存。
  _readSafeState (filePath) {
    return readSafeTextResult(filePath, STATE_TEXT_MAX_BYTES)
  },

  _writeTextAtomic (filePath, text) {
    // v3.245 P1：writeAtomic 内部有 try/catch 正常不抛；此处再加一层防御（如 text 含
    // Symbol 等 String 化异常），任何意外不向调用链冒泡。
    try { return writeAtomic(filePath, text, '缓存文件') } catch (e) { return false }
  },

  // 状态文件统一原子写入（tmp + rename）：避免进程中断留下半写 JSON，导致告警限频/日报累计状态损坏。
  _writeState (filePath, state) {
    // v3.179：类型守卫——state 为 undefined/null/非对象时 JSON.stringify 会静默产出
    // "null"/undefined 文本或抛错，明确告警并拒绝写入，避免状态文件被污染
    // v3.246：数组 typeof 'object' 同样穿透守卫被序列化写入（产出 '[]'），一并拒绝
    if (state === undefined || state === null || typeof state !== 'object' || Array.isArray(state)) {
      const kind = Array.isArray(state) ? 'array' : (state === null ? 'null' : typeof state)
      console.warn(`_writeState: state 必须是非空对象, 实际为 ${kind}, 拒绝写入 ${filePath}`)
      return false
    }
    let text
    try { text = JSON.stringify(state) } catch (e) {
      console.error(`状态序列化失败 ${filePath}:`, e.message)
      return false
    }
    return this._writeTextAtomic(filePath, text)
  },

  // 运行日志：追加一行到缓存目录 run.log（成功摘要/失败 ERROR 共用），超过 1MB 截断保留尾部（防无限增长；写失败静默不中断）
  // v3.xxx P3 并发安全：appendFileSync 在单进程内全程同步无交错；真正竞态在跨进程（重叠 cron/
  // 常驻实例共用同一 cacheDir）——进程 A「追加→读尾→原子改写」的读改写间隙里，B 刚追加的行会被
  // A 的整文件覆盖冲掉（丢日志）。修复：用 run.log.lock（O_EXCL）把「追加 + 超限截尾」包成互斥
  // 临界区；拿不到锁（竞争/陈旧锁/异常）时 fail-open 只追加不截尾，日志绝不因锁而丢。
  _writeRunLog (line) {
    try {
      const logPath = path.join(MessageStore.cacheDir, 'run.log')
      if (!this._isRegularOrMissing(logPath)) {
        console.error(`拒绝写入非普通运行日志文件 ${logPath}`)
        return
      }
      const lockPath = logPath + '.lock'
      let lockFd = -1
      try {
        // 跨进程互斥锁：O_EXCL 原子创建，带短退避重试与陈旧锁兜底；崩溃遗留的锁靠 mtime 超龄抢占
        const LOCK_STALE_MS = 10000
        const lockDeadline = Date.now() + 3000
        const waiter = new Int32Array(new SharedArrayBuffer(4))
        for (;;) {
          try {
            lockFd = fs.openSync(lockPath, 'wx')
            try { fs.writeSync(lockFd, `${process.pid}\n`) } catch (e) { /* 锁文件内容仅供排查，失败不影响 */ }
            break
          } catch (e) {
            if (e.code !== 'EEXIST') break // 权限等异常：拿不到锁也继续（fail-open，只追加）
            let stale = false
            try {
              const ls = fs.statSync(lockPath)
              stale = Date.now() - ls.mtimeMs > LOCK_STALE_MS
            } catch (e2) { stale = true } // 锁文件刚被释放/删除：当作空位重试
            if (stale) {
              try { fs.unlinkSync(lockPath) } catch (e2) { /* 抢占失败则下一轮重试 */ }
              continue
            }
            if (Date.now() >= lockDeadline) break // 超时：fail-open，仅追加不截尾
            try { Atomics.wait(waiter, 0, 0, 10) } catch (e2) { /* 非主线程/受限时退避失败，直接重试 */ }
          }
        }
        fs.appendFileSync(logPath, line, 'utf8')
        const st = fs.statSync(logPath)
        const LIMIT = 1024 * 1024
        if (st.size > LIMIT) {
          // v3.246：只读取并保留尾部，替代全量 readFileSync+重写——避免每次超限都做
          // O(n) 全量读入 + 512KB 重写的读写放大（每次追加超 1MB 反复全读）
          const KEEP = 512 * 1024
          const fd = fs.openSync(logPath, 'r+')
          try {
            const readLen = Math.min(KEEP, st.size)
            const buf = Buffer.alloc(readLen)
            fs.readSync(fd, buf, 0, readLen, st.size - readLen) // 只读末尾 KEEP 字节
            let trimmed = buf.toString('utf8')
            // v3.178：尾部切片可能切在代理对中间（首字符为孤立低代理/尾字符为孤立高代理）→
            // 写回后文件含非法 UTF-8 序列，下次读取显示 U+FFFD（§10-C）——退位到完整字符
            const first = trimmed.charCodeAt(0)
            if (first >= 0xDC00 && first <= 0xDFFF) trimmed = trimmed.slice(1) // 开头孤立低代理（高代理被切掉）
            const last = trimmed.charCodeAt(trimmed.length - 1)
            if (last >= 0xD800 && last <= 0xDBFF) trimmed = trimmed.slice(0, -1) // 结尾孤立高代理（低代理被切掉）
            const nl = trimmed.indexOf('\n')
            // 原子写入（tmp + rename）覆盖原文件，避免中断留下半写日志
            this._writeTextAtomic(logPath, nl >= 0 ? trimmed.slice(nl + 1) : trimmed)
          } finally {
            fs.closeSync(fd)
          }
        }
      } finally {
        if (lockFd >= 0) {
          try { fs.closeSync(lockFd) } catch (e) { /* 锁 fd 关闭失败忽略 */ }
          try { fs.unlinkSync(lockPath) } catch (e) { /* 锁文件已被抢删等，忽略 */ }
        }
      }
    } catch (e) { /* 日志写失败静默（磁盘只读/权限等，不中断推送） */ }
  },

  _diskWarningAt: 0,
  _alertLastAtByPath: new Map(),
  _reportMemoryStateByPath: new Map(),

  // 磁盘余量只告警不阻断：statfs 不可用或读取失败时静默跳过。
  _warnLowDisk () {
    const minFree = Utils.num(Config.storage && Config.storage.minFreeBytes, 50 * 1024 * 1024)
    if (!Number.isFinite(minFree) || minFree <= 0) return
    const now = Date.now()
    // 同一进程最多每小时提示一次，避免磁盘低时刷屏；限流前置，避免高频写入时每次都无谓同步 statfs 阻塞事件循环。
    if (now - this._diskWarningAt < 3600000) return
    const info = Utils.diskSpace(MessageStore.cacheDir)
    // freeBytes 需有限性校验：NaN 时 >=minFree 为 false 会误入告警并在 toFixed 抛 RangeError。
    if (!info || !Number.isFinite(info.freeBytes) || info.freeBytes >= minFree) return
    this._diskWarningAt = now
    const freeMiB = (info.freeBytes / 1024 / 1024).toFixed(1)
    const minMiB = (minFree / 1024 / 1024).toFixed(1)
    console.warn(`⚠️ 缓存所在磁盘余量不足：${freeMiB} MiB（告警阈值 ${minMiB} MiB），写入状态/缓存可能失败`)
  },

  // 接口异常告警（v3.123）：限频 + 静默——不影响主流程；告警也走推送通道（通道挂了就静默，无解）
  _sendAlert (errMsg) {
    try {
      // v3.173/174：!enabled（数字0/空串）或 'false'/'0' 字符串均关闭（'0' 字符串是 truthy，曾漏）
      const en = Config.alert && Config.alert.enabled
      if (!Config.alert || !en || en === 'false' || en === '0') return
      const statePath = path.join(MessageStore.cacheDir, 'alert.state')
      const alertMemory = this._alertLastAtByPath.get(statePath)
      let lastAt = alertMemory ? alertMemory.lastAt : 0
      // 状态文件被外部删除时，已持久化的旧内存状态不应继续生效；写失败的内存状态仍用于本进程限频。
      if (alertMemory && alertMemory.persisted && !fs.existsSync(statePath)) {
        this._alertLastAtByPath.delete(statePath)
        lastAt = 0
      }
      const stateResult = this._readSafeState(statePath)
      if (stateResult.status === 'ok') {
        try { lastAt = Math.max(lastAt, JSON.parse(stateResult.text).lastAt || 0) } catch (e) { /* 损坏状态=忽略 */ }
      } else if (stateResult.status !== 'missing') {
        // ioError/unsafe/tooLarge：无法确认真实限频状态。若按"无状态文件"处理会重置
        // lastAt 导致限频失效、重复推送；保守跳过本次告警，下次运行再重试。
        console.error(`告警限频状态读取失败(${stateResult.status})，跳过本次告警以免限频被重置导致重复推送 ${statePath}`)
        return
      }
      const intervalMs = Utils.num(Config.alert.intervalMs, 3600000) // v3.167: 非法字符串'abc'曾>0比较false→0不限频轰炸（其他数值配置均num回退）
      const interval = intervalMs > 0 ? intervalMs : 0 // <=0(含-1) = 不限频（每次异常都发）
      if (interval > 0 && Date.now() - lastAt < interval) return // 限频：间隔内不重复轰炸
      const alertText = '⚠️ xbk-push 运行异常'
      // v3.159：段落分隔 \n\n（与主推送/日报口径一致）——wxpusher Markdown 渲染单个 \n 可能挤成一行
      const alertDesp = `接口/推送异常，请检查。\n\n时间：${new Date().toLocaleString('zh-CN')}\n\n原因：${String(errMsg).slice(0, 500)}`
      // v3.156：发送成功才写状态+打印——曾先写 lastAt（发送失败也限频，60s 内挡住重试，信息丢失）
      // v3.157：走 Pusher.send（曾直接 notify.sendNotify——无 10s 超时、无 surrogate 清洗，与主推送不一致）
      // v3.164：返回 promise 供 App.run catch await——曾 fire-and-forget，接口异常时主入口同步 process.exit(1)
      // 杀死未完成的告警 HTTP（cron 直接运行收不到告警，#10）
      return Pusher.send(alertText, alertDesp)
        .then(() => {
          const sentAt = Date.now()
          const persisted = this._writeState(statePath, { lastAt: sentAt })
          this._alertLastAtByPath.set(statePath, { lastAt: sentAt, persisted })
          if (!persisted) {
            this._warnLowDisk()
            console.warn('⚠️ 运行异常告警已发送，但 alert.state 持久化失败；本进程将继续使用内存限频')
          } else {
            console.log('已发送运行异常告警（限频 ' + Math.ceil(interval / 60000) + ' 分钟）')
          }
        })
        .catch(() => { /* v3.135：告警通道也挂了，静默（防 unhandledRejection）；不写状态→下次可重试 */ })
    } catch (e) { /* 告警失败静默（通道也挂了，无解） */ }
  },

  // 运行日报（v3.125）：跨天时发"昨日日报"，当天累加统计；静默不影响主流程
  _updateReport (summary) {
    try {
      // v3.173/174：!enabled（数字0/空串）或 'false'/'0' 字符串均关闭（'0' 字符串是 truthy，曾漏）
      const en = Config.report && Config.report.enabled
      if (!Config.report || !en || en === 'false' || en === '0') return
      const statePath = path.join(MessageStore.cacheDir, 'report.state')
      const blankState = () => ({ date: '', total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 })
      const safeCounter = (v) => {
        const n = Number(v)
        return typeof v !== 'boolean' && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0
      }
      const normalizeState = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blankState()
        const st = blankState()
        st.date = typeof raw.date === 'string' ? raw.date : ''
        for (const k of ['total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) st[k] = safeCounter(raw[k])
        if (raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending)) {
          st.pending = blankState()
          for (const k of ['total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) st.pending[k] = safeCounter(raw.pending[k])
        } else if (raw.pending) {
          // pending 存在但非普通对象（状态文件损坏/结构异常）：不能静默丢弃跨天累计，
          // 保留其占位并大声告警，让下游按 blankState 处理而不崩溃。
          console.warn('⚠️ report.state 的 pending 字段格式异常，已重置为空累计（原值被丢弃）')
          st.pending = blankState()
        }
        return st
      }
      const persistReportState = (next) => {
        const normalized = normalizeState(next)
        const ok = this._writeState(statePath, normalized)
        // 状态写失败时保留进程内已知状态，避免同一进程重复发送日报；重启后仍会重试并发出低磁盘告警。
        this._reportMemoryStateByPath.set(statePath, { state: normalized, persisted: ok })
        if (!ok) {
          this._warnLowDisk()
          console.warn('⚠️ 日报发送/累计状态持久化失败；本进程将继续使用内存状态')
        }
        return ok
      }
      let memoryState = this._reportMemoryStateByPath.get(statePath)
      if (memoryState && memoryState.persisted && !fs.existsSync(statePath)) {
        this._reportMemoryStateByPath.delete(statePath)
        memoryState = null
      }
      let state = memoryState ? normalizeState(memoryState.state) : blankState()
      if (!memoryState) {
        const stateResult = this._readSafeState(statePath)
        if (stateResult.status === 'ok') {
          try { state = normalizeState(JSON.parse(stateResult.text)) } catch (e) { /* 损坏状态=重置为安全状态 */ }
        } else if (stateResult.status !== 'missing') {
          // ioError/unsafe/tooLarge：读不到累计状态。若按"无状态文件"处理会把已累计的
          // 日报/告警累计状态静默重置、可能重复推送；保守跳过本次日报更新，下次再重试。
          console.error(`日报累计状态读取失败(${stateResult.status})，跳过本次日报更新以免累计状态被重置 ${statePath}`)
          return
        }
        // status === 'missing' → state 保持 blankState()（首次）
      }
      // v3.155：日报日期用本地时区（原 UTC——中国用户凌晨 cron 时本地已跨天但 UTC 未跨，日报日期错位一天）
      const _d = new Date()
      const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
      const acc = (st) => {
        const add = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0 }
        st.total += add(summary.total)
        st.dedup += add(summary.dedup)
        st.filtered += add(summary.filtered)
        st.pushed += add(summary.pushed)
        st.failed += add(summary.failed)
        st.truncated += add(summary.truncated) // v3.176：截断数也入日报（曾只有 run.log 有）
      }
      if (state.date && state.date !== today) {
        // 新的一天：发昨日日报（若有数据）
        if (state.total > 0 || state.failed > 0) {
          const t = `📊 xbk-push 日报（${state.date}）`
          // v3.159：段落分隔 \n\n（与主推送口径一致）——wxpusher Markdown 渲染单个 \n 可能挤成一行
          const d = `推送 ${state.pushed} 条 | 失败 ${state.failed} 条\n\n获取 ${state.total} | 去重 ${state.dedup} | 过滤 ${state.filtered}${state.truncated ? ` | 截断 ${state.truncated}` : ''}`
          // v3.156：发送成功才重置日期——曾先写 state.date（日报失败也跨天，昨日日报丢失）
          // v3.157：走 Pusher.send（曾直接 notify.sendNotify——无 10s 超时、无 surrogate 清洗）
          Pusher.send(t, d)
            .then(() => {
              // v3.176：昨日日报发送成功 → 重置为今日；取出「昨日日报失败期间的今日累计」
              // （pending），与本次数据一并计入新的一天（曾直接丢弃——今日数据丢失）
              const pend = state.pending || { total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
              state = { date: today, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
              acc(state) // 本次数据计入新的一天
              state.total += pend.total || 0
              state.dedup += pend.dedup || 0
              state.filtered += pend.filtered || 0
              state.pushed += pend.pushed || 0
              state.failed += pend.failed || 0
              state.truncated += pend.truncated || 0
              persistReportState(state)
              console.log('已发送昨日运行日报')
            })
            .catch(() => {
              // v3.176：失败 → date 不重置（下次运行重试昨日日报）；本次（今日）数据暂存
              // pending，不污染昨日统计——曾 acc 进旧 state：今日数据被错标进「昨日日报」
              // 重复发送（系统审查 #4）
              const pend = state.pending || { total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
              pend.total += summary.total || 0
              pend.dedup += summary.dedup || 0
              pend.filtered += summary.filtered || 0
              pend.pushed += summary.pushed || 0
              pend.failed += summary.failed || 0
              pend.truncated += summary.truncated || 0
              state.pending = pend
              persistReportState(state)
            })
          return
        }
        // 昨日无数据：直接跨天（pending 若有则并入今日——防御，正常路径无）
        const pend = state.pending
        state = { date: today, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
        if (pend) {
          state.total += pend.total || 0; state.dedup += pend.dedup || 0
          state.filtered += pend.filtered || 0; state.pushed += pend.pushed || 0
          state.failed += pend.failed || 0; state.truncated += pend.truncated || 0
        }
      }
      if (!state.date) state.date = today
      acc(state)
      persistReportState(state)
    } catch (e) { /* 日报失败静默 */ }
  },

  async run () {
    const runStart = Date.now()
    const detailedProfile = process.env.XBK_PROFILE === '2' || PROFILE3
    const checkpointProfile = PROFILE3
    const runMarks = []
    let lastRunMarkMs = runStart
    const checkpoint = (name, extra = '') => {
      if (!checkpointProfile) return
      const now = Date.now()
      runMarks.push({ name, atMs: now - runStart, deltaMs: now - lastRunMarkMs, extra })
      lastRunMarkMs = now
    }
    const dumpCheckpoints = () => {
      if (!checkpointProfile) return
      console.log('  [profile checkpoints]')
      for (const mark of runMarks) {
        console.log(`    ${mark.name}: +${mark.atMs}ms (delta ${mark.deltaMs}ms)${mark.extra ? ` ${mark.extra}` : ''}`)
      }
      console.log('  [profile boot]')
      for (const mark of PROFILE3_BOOT_MARKS) {
        const delta = mark.deltaMs === undefined ? '' : ` (delta ${Math.round(mark.deltaMs)}ms)`
        console.log(`    ${mark.name}: +${Math.round(mark.ms)}ms${delta}`)
      }
    }
    let fetchMs = null
    let preprocessMs = null
    let cacheMs = null
    let dnsWarmup = null
    let tlsWarmup = null
    let dnsWarmupSettled = false
    let tlsWarmupSettled = false
    let warmupController = null
    let warmupCancelled = false // v3.233：主流程先于 getNotify() resolve 结束时置位，防止预热在 run 结束后启动
    console.debug('开始获取线报酷数据...')
    checkpoint('run-start')
    // ③ 拉取数据：仅在实际配置 WxPusher 时预解析域名并后台预建 HTTPS 连接。
    // 预热可被主流程结束时取消，避免“未 await”仍因活动 socket 延长进程退出。
    const warmupPromise = getNotify().then((notifyModule) => {
      const hasWxPusher = Boolean(notifyModule && typeof notifyModule.hasWxPusherConfigured === 'function' &&
                    notifyModule.hasWxPusherConfigured())
      if (!hasWxPusher) {
        dnsWarmup = { ok: true, skipped: true }
        tlsWarmup = { ok: true, skipped: true, okCount: 0, count: 0 }
        dnsWarmupSettled = true
        tlsWarmupSettled = true
        checkpoint('warmup-skipped', 'wxpusher=unconfigured')
        return null
      }
      // v3.233：主流程已结束（finally 置位）但 getNotify() 此刻才 resolve——不再启动预热，
      // 否则 controller 刚创建而 run 已退出，无人取消请求会拖住进程。
      if (warmupCancelled) {
        dnsWarmup = { ok: true, skipped: true }
        tlsWarmup = { ok: true, skipped: true, okCount: 0, count: 0 }
        dnsWarmupSettled = true
        tlsWarmupSettled = true
        checkpoint('warmup-cancelled', 'run-finished-before-load')
        return null
      }
      warmupController = typeof AbortController === 'function' ? new AbortController() : null
      const signal = warmupController ? warmupController.signal : null
      const dnsWarmupPromise = Promise.resolve(prewarmDns('wxpusher.zjiecode.com'))
        .then((result) => { dnsWarmup = result; dnsWarmupSettled = true; return result })
        .catch((error) => { dnsWarmup = { ok: false, error: String(error) }; dnsWarmupSettled = true; return dnsWarmup })
      const prewarmCount = (() => {
        const pl = Utils.num(Config.push.parallelLimit, 10)
        const maxPerRun = Utils.num(Config.push.maxPerRun, 100)
        const window = pl > 0 ? Math.min(Math.floor(pl), 10) : 10
        const batch = Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : 100
        return Math.max(1, Math.min(window, batch))
      })()
      // HEAD 预取：连接数与并发窗口对齐；signal 允许主流程结束/失败时取消未完成请求。
      const tlsWarmupPromise = Promise.resolve(prewarmTls('wxpusher.zjiecode.com', 5000, prewarmCount, signal))
        .then((result) => { tlsWarmup = result; tlsWarmupSettled = true; return result })
        .catch((error) => { tlsWarmup = { ok: false, okCount: 0, count: prewarmCount, error: String(error) }; tlsWarmupSettled = true; return tlsWarmup })
      checkpoint('warmup-started', `tlsCount=${prewarmCount}`)
      return Promise.all([dnsWarmupPromise, tlsWarmupPromise])
    }).catch((error) => {
      dnsWarmup = { ok: false, error: String(error) }
      tlsWarmup = { ok: false, okCount: 0, count: 0, error: String(error) }
      dnsWarmupSettled = true
      tlsWarmupSettled = true
      return null
    })
    // 显式接住后台预热 Promise；主流程不等待它。
    warmupPromise.catch(() => {})
    MessageStore.init()
    checkpoint('cache-init')
    this._warnLowDisk()
    checkpoint('disk-check')

    try {
      // ① 校验配置
      const warnings = RuleEngine.validateConfig(Config.filter)
      for (const w of warnings) console.warn(w)

      // 配置告警显示统一安全字符串化：脏值（Symbol / 异常 valueOf）不能让告警路径再次崩溃。
      const safeConfigText = (value) => {
        try { return String(value) } catch (e) { return '<不可转换值>' }
      }

      // 校验缓存 maxSize（#7）：函数层已回退默认，配置层补提示（validateConfig 只接收 filter，此处兜底完整 Config）
      // v3.175：字符串 maxSize（'10000' 环境变量）曾误报——用 Utils.num 口径
      if (!Number.isInteger(Utils.num(Config.cache.maxSize, -1)) || Utils.num(Config.cache.maxSize, -1) <= 0) {
        console.warn(`⚠️ 配置「cache.maxSize」为「${safeConfigText(Config.cache.maxSize)}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`)
      }

      // 域名校验（v3.73）：非法 URL 会让 fetchData 重试耗尽才报错，配置层提前提示
      if (typeof Config.domain !== 'string' || !/^https?:\/\//.test(Config.domain)) {
        console.warn(`⚠️ 配置「domain」为「${safeConfigText(Config.domain)}」不是 http(s):// 开头的合法地址`)
      }

      // 模板校验（v3.80）：非字符串回退默认（pushOne 已有回退，配置层补提示）
      if (typeof Config.template.title !== 'string' || typeof Config.template.content !== 'string') {
        console.warn('⚠️ 配置「template.title/content」应为字符串，已回退默认模板')
      }
      // v3.159：模板占位符有效性检查——{价格}/{商城}/{品牌}/{图片} 等接口真实字段不提供，输出恒空且无提示
      const SUPPORTED_TPL_KEYS = ['分类名', '分类ID', '标题', '链接', '日期', '时间', '楼主', '类目', '内容', 'Html内容', 'Markdown内容']
      for (const tplName of ['title', 'content']) {
        const tpl = Config.template[tplName]
        if (typeof tpl !== 'string') continue
        const used = new Set()
        const tplRe = /\{([^{}]+)\}/g
        let tplM
        while ((tplM = tplRe.exec(tpl))) used.add(tplM[1])
        for (const k of used) {
          if (!SUPPORTED_TPL_KEYS.includes(k)) {
            console.warn(`⚠️ 模板「template.${tplName}」含占位符「{${k}}」——接口真实字段不提供该数据，将输出为空。支持占位符：{${SUPPORTED_TPL_KEYS.join('} {')}}`)
          }
        }
      }

      // 运行时数值配置校验（函数层已有防御，配置层补提示——#7 同款精神，v3.64）
      // v3.175：校验用 Utils.num 口径——字符串配置（'5000' 环境变量场景）曾误报「不是有效值」
      // （Number.isFinite('5000')=false，但 Utils.num 已生效——假警告误导用户）
      const numConfig = [
        ['api.timeout', Config.api.timeout, (v) => Utils.num(v, -1) > 0],
        ['api.retry', Config.api.retry, (v) => { const n = Utils.num(v, -1); return Number.isInteger(n) && n >= 0 }],
        ['timing.pushInterval', Config.timing.pushInterval, (v) => Utils.num(v, -1) >= 0],
        ['timing.finalWait', Config.timing.finalWait, (v) => Utils.num(v, -1) >= 0],
        ['push.parallelLimit', Config.push.parallelLimit, (v) => Utils.num(v, -1) >= 0],
        ['push.maxPerRun', Config.push.maxPerRun, (v) => { const n = Utils.num(v, -1); return Number.isInteger(n) && n > 0 }]
      ]
      for (const [name, val, ok] of numConfig) {
        if (!ok(val)) {
          let display
          try { display = String(val) } catch (e) { display = '<不可转换值>' }
          console.warn(`⚠️ 配置「${name}」为「${display}」不是有效值，已按内部防御逻辑处理（建议修正）`)
        }
      }
      checkpoint('config-validated')

      // ② 预编译规则（只执行一次）
      const compiledRules = RuleEngine.compileRules(Config.filter)
      checkpoint('rules-compiled')

      const fetchStart = Date.now()
      const xbkdata = await Network.fetchData()
      fetchMs = Date.now() - fetchStart
      checkpoint('api-fetch-complete', `items=${Array.isArray(xbkdata) ? xbkdata.length : 'invalid'} fetchMs=${fetchMs}`)
      checkpoint('dns-warmup-observed', dnsWarmupSettled && dnsWarmup ? `ok=${dnsWarmup.ok} elapsedMs=${dnsWarmup.elapsedMs}` : 'pending')
      if (!Array.isArray(xbkdata)) {
        // 接口返回格式异常时不盲跑 for 循环，抛错让调度感知
        throw new Error(`接口返回数据格式异常：期望数组，实际为 ${xbkdata === null ? 'null' : typeof xbkdata}`)
      }

      // ③b 字段归一化 + ④ 去重/全局过滤（合并为一次遍历，顺序保证：校验→归一化→判重）
      let items = []
      let dedupCount = 0
      let filteredCount = 0
      let truncatedCount = 0 // v3.145：maxPerRun 截断数计入统计（曾凭空消失）
      const cacheName = MessageStore.getFileName(Config.api.pushUrl)
      // v3.159：过滤规则哈希比对——规则变更时失效「过滤写入」缓存（改宽过滤后旧条目重新评估/推送，
      // 无需手动清缓存；「推送成功」缓存不受影响，防重复推送）
      {
        const filterHash = Utils.filterHash(Config.filter, Config.keyword.zkt_gjc)
        const hashPath = path.join(MessageStore.cacheDir, 'filter.hash')
        let lastHash = ''
        let filterStateReady = true
        const hashResult = this._readSafeState(hashPath)
        if (hashResult.status === 'ok') {
          lastHash = (hashResult.text || '').trim()
        } else if (hashResult.status !== 'missing') {
          // ioError/unsafe/tooLarge：读不到已存 hash。若当"无 hash"处理会静默跳过规则
          // 变更检测且立即覆写 hash；保守视为未就绪，本次不检测也不推进 hash，下次重试。
          console.error(`过滤规则 hash 读取失败(${hashResult.status})，跳过本次规则变更检测 ${hashPath}`)
          filterStateReady = false
        }
        if (lastHash && lastHash !== filterHash) {
          const fp = MessageStore.getFilePath(cacheName)
          const msgs = MessageStore.readMessages(fp)
          const kept = msgs.filter(m => !(m && typeof m === 'object' && m._f === true))
          if (kept.length !== msgs.length) {
            filterStateReady = MessageStore.saveMessages(fp, kept)
            if (filterStateReady) {
              console.warn(`⚠️ 检测到过滤规则/只看它变更（${lastHash.slice(0, 8)} → ${filterHash.slice(0, 8)}），已清除 ${msgs.length - kept.length} 条「过滤写入」缓存——之前被过滤的条目将重新评估（改宽后即重新推送）`)
            } else {
              console.warn('⚠️ 过滤缓存失效写入失败，本次不更新 filter.hash，下次运行将继续重试规则变更处理')
            }
          }
        }
        // 只有过滤缓存清理成功后才推进 hash；否则下次运行必须继续重试，避免旧 _f 永久失效。
        if (filterStateReady) {
          this._writeTextAtomic(hashPath, filterHash)
        }
      }
      const newMessages = []
      // v3.179：缓存索引化——曾逐条 MessageStore.has()（每条 O(M) findIndex，共 O(N×M)）：
      // 接口异常返回海量数据（maxPerRun 想防的同一场景）时判重卡死——实测 N=2万/M=1万 → 11.6s，
      // 外推 N=10万 → ~60s（cron 长时间挂起）。改为循环前一次性构建缓存三索引（O(M)），
      // 与批内三索引合并判重 → 全程 O(N+M)。三个 Set 与 _findDedupIndex 三条件同构，
      // 等价性由属性测试证明（800 轮含缓存非空场景，0 失配）
      const cacheMsgs = MessageStore.readMessages(MessageStore.getFilePath(cacheName))
      const cacheIds = new Set() // 缓存中有 id 条目的 String(id)
      const cacheUrls = new Set() // 缓存中所有有 URL 条目的 validUrl
      const cacheNoIdUrls = new Set() // 缓存中无 id 有 URL 条目的 validUrl
      const cacheAnonKeys = new Set() // 缓存中无 id/URL 条目的 anonKey
      for (const m of cacheMsgs) {
        const identity = Utils.getMessageIdentity(m)
        if (!identity.valid) continue
        if (identity.kind === 'id') cacheIds.add(identity.idKey)
        if (identity.url) {
          cacheUrls.add(identity.url)
          if (identity.kind === 'url') cacheNoIdUrls.add(identity.url)
        }
        if (identity.kind === 'anon') cacheAnonKeys.add(identity.key)
      }
      // v3.228：批内与跨运行统一使用 getMessageIdentity；保留 id/url 的双向 fallback，
      // 另为无标识数据维护 anonKey 集合，避免各入口各自拼接 url:/id: 键。
      const batchIds = new Set()
      const batchUrls = new Set()
      const batchNoIdUrls = new Set()
      const batchAnonKeys = new Set()

      let badElementCount = 0 // v3.157：非对象元素单独统计（曾混入 filteredCount，诊断不清）
      let regTimePresent = 0 // v3.159：louzhuregtime 有值统计（pingbitime 有效性警告用）
      for (const item of xbkdata) {
        // 元素级校验：非对象元素跳过（v3.176：不再计入 filteredCount——「过滤屏蔽」专指规则过滤，
        // 非对象元素有独立「非对象元素」行，曾双计误导诊断）
        if (!Utils.isValidItem(item)) { badElementCount++; continue }
        // 字段归一化：通过安全 getter 读取别名字段，避免脏 getter 破坏整批一致性。
        const categoryName = Utils.safeGet(item, 'catename')
        const categoryAlias = Utils.safeGet(item, 'category_name')
        if (!categoryName && categoryAlias) Utils.safeSet(item, 'catename', categoryAlias)
        const categoryId = Utils.safeGet(item, 'cateid')
        const categoryIdAlias = Utils.safeGet(item, 'category_id')
        if (!categoryId && categoryIdAlias) Utils.safeSet(item, 'cateid', categoryIdAlias)
        const louzhuRegTime = Utils.safeGet(item, 'louzhuregtime')
        if (louzhuRegTime !== undefined && louzhuRegTime !== null && louzhuRegTime !== '') regTimePresent++

        const identity = Utils.getMessageIdentity(item)
        if (!identity.valid) continue
        let dup = false
        if (identity.kind === 'id') {
          dup = cacheIds.has(identity.idKey) || (identity.url && cacheNoIdUrls.has(identity.url)) ||
                       batchIds.has(identity.idKey) || (identity.url && batchNoIdUrls.has(identity.url))
        } else if (identity.kind === 'url') {
          dup = cacheUrls.has(identity.url) || batchUrls.has(identity.url)
        } else {
          dup = cacheAnonKeys.has(identity.key) || batchAnonKeys.has(identity.key)
        }
        if (dup) { dedupCount++; continue }
        // 收录进批内索引，字段身份与 MessageStore/saveBatch 完全相同。
        if (identity.kind === 'id') batchIds.add(identity.idKey)
        if (identity.url) {
          batchUrls.add(identity.url)
          if (identity.kind === 'url') batchNoIdUrls.add(identity.url)
        }
        if (identity.kind === 'anon') batchAnonKeys.add(identity.key)
        if (FilterEngine.listfilter(item, compiledRules)) {
          items.push(item)
        } else {
          filteredCount++
          Utils.safeSet(item, '_f', true) // v3.159：过滤写入标记（规则变更时失效）
        }
        newMessages.push(item)
      }

      // v3.159：接口未提供注册时间字段时 pingbitime 过滤不生效——运行期警告（配置无效不感知）
      const pbCfg = Config.filter && Config.filter.pingbitime
      const pbText = Utils.safeText(pbCfg, '')
      if (pbCfg !== undefined && pbCfg !== null && pbText.trim() !== '' && xbkdata.length > 0) {
        const missing = xbkdata.length - regTimePresent
        if (missing / xbkdata.length > 0.5) {
          console.warn(`⚠️ 接口返回「louzhuregtime」注册时间字段缺失 ${missing}/${xbkdata.length} 条（>50%）——配置的「pingbitime」过滤基本不会生效（接口可能不提供该字段）`)
        }
      }

      // ⑤ 只看它过滤（独立白名单函数，keyword 正则预编译一次）
      const beforeKwd = items.length
      const kw = Config.keyword.zkt_gjc
      // R11-1：非字符串 zkt_gjc（对象/数字脏配置）→ 警告并跳过过滤（String 化会把 '[object Object]' 当正则，静默怪行为）
      if (kw !== undefined && kw !== null && typeof kw !== 'string') {
        console.warn(`⚠️ 配置「zkt_gjc」应为字符串，当前为 ${typeof kw}，已忽略只看它过滤`)
      } else if (kw) {
        if (String(kw).trim() === '') {
          // 空白关键词 = 误配置，忽略过滤（避免只推含空格的标题）
          console.warn('⚠️ 配置「zkt_gjc」为空白字符，已忽略只看它过滤')
        } else {
          let kwRe = null
          if (RuleEngine.hasNestedQuantifier(kw)) {
            console.warn('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤')
          } else {
            try {
              kwRe = new RegExp(kw, 'i')
            } catch (e) {
              console.warn('⚠️ 配置「zkt_gjc」包含无效的正则表达式，已忽略只看它过滤')
            }
          }
          if (kwRe) {
            // 空标题保留（与推送占位一致，避免"只看它"把无标题数据滤掉）
            const kept = items.filter(it => {
              const rawTitle = Utils.safeGet(it, 'title')
              if (!rawTitle) return true
              const title = Utils.safeText(rawTitle, '')
              try { return kwRe.test(title) } catch (e) { return true } // 转换/匹配异常按保守放行
            })
            for (const it of items) { if (!kept.includes(it)) it._f = true } // v3.159：只看它滤掉的同样标记（规则变更失效）
            items = kept
          }
          // 非法正则时 kwRe 为 null：items 不过滤，继续正常推送（避免静默清空）
        }
      }
      filteredCount += (beforeKwd - items.length)
      checkpoint('data-processed', `items=${items.length} dedup=${dedupCount} filtered=${filteredCount} bad=${badElementCount}`)

      // v3.129：单次推送上限（防接口异常返回海量 → 推送风暴/8 分钟运行；正常 ~20 条无影响）
      // maxPerRun 必须是正整数；小数先取整可能变成 0（如 0.5），会静默跳过全部推送，非法值统一回退默认
      const maxPerRun = (() => { const v = Utils.num(Config.push.maxPerRun, -1); return Number.isInteger(v) && v > 0 ? v : 100 })()
      let truncatedKeys = new Set()
      if (items.length > maxPerRun) {
        truncatedCount = items.length - maxPerRun
        console.warn(`⚠️ 单次待推送 ${items.length} 条超过上限 ${maxPerRun}，只推前 ${maxPerRun} 条（防接口异常推送风暴；调整 Config.push.maxPerRun）`)
        // v3.239：截断告警推送（复用 alert 限频，防轰炸）——静默丢失曾无感知，手机端可及时发现
        // v3.240：await 告警（v3.164 曾修复 fire-and-forget 导致告警 HTTP 未送达被杀，子代理审查发现本轮修复回归该模式）
        // v3.241：文案改为「已暂存待补推」（下轮接口重放时补推，非永久丢弃；子代理审查提示避免误导）
        try { await this._sendAlert(`⚠️ 线报酷截断：单次待推送 ${items.length} 条超上限 ${maxPerRun}，已暂存 ${truncatedCount} 条待下轮补推（防推送风暴）`) } catch (e) { /* 告警失败不阻塞主流程 */ }
        // v3.134：截断掉的不写缓存——否则下次运行去重跳过导致静默丢失（缓存当"已处理"）；下次运行推剩余
        // keyOf 在 ⑥ 才定义，此处用同口径（id 优先 + url 归一）构造截断 key
        truncatedKeys = new Set(items.slice(maxPerRun).map(it => Utils.getMessageIdentity(it).key))
        items = items.slice(0, maxPerRun)
      }

      // ⑥ 推送（sequential=顺序逐条 / parallel=并行滑动窗口；失败不中断、不写缓存，下次重试）
      const pushModeForProfile = (() => {
        // v3.250：Config.push 缺失/未配置 mode 时 String(undefined) 会产出字面量 "undefined"；
        // 显式回退默认顺序模式，仅用于 push-start 日志（不改变实际推送语义）
        try { const m = Config.push && Config.push.mode; return (m == null || m === '') ? 'sequential' : String(m) } catch (e) { return '<不可转换值>' }
      })()
      checkpoint('push-start', `count=${items.length} mode=${pushModeForProfile}`)
      const startTime = Date.now()
      preprocessMs = startTime - runStart - (fetchMs || 0)
      // v3.250：预计算每条 items 的 identity key 并缓存（含 newMessages 惰性缓存），
      // keyOf 复用，避免 getMessageIdentity 对同一对象反复重算（pushedKeys/itemsKeys/toCache 均调用）
      const itemKeyCache = new Map(items.map(it => [it, Utils.getMessageIdentity(it).key]))
      const keyOf = (it) => {
        if (!itemKeyCache.has(it)) itemKeyCache.set(it, Utils.getMessageIdentity(it).key)
        return itemKeyCache.get(it)
      }
      // domain 去尾斜杠后与相对路径统一拼接（避免 'https://x.com//rel' 双斜杠）
      // R2：非字符串 domain（脏配置）→ 空串 baseUrl（相对路径不拼前缀，避免 .replace 崩溃）
      const baseUrl = (typeof Config.domain === 'string') ? Config.domain.trim().replace(/\/+$/, '') : '' // v3.158: trim
      // url 类型防御：非字符串(null/undefined/对象/数字)视为无链接——避免 .includes 崩溃或 [object Object]
      // 与 htmlToMarkdown 的 content_html 口径一致（非字符串视为空）
      const urlOf = (it) => {
        const u = Utils.safeUrl(it && it.url)
        if (!u) return ''
        // 含协议或协议相对(//)不拼前缀；相对路径拼 domain（补斜杠）
        return (u.includes('://') || u.startsWith('//') ? u : baseUrl + (u.startsWith('/') ? u : '/' + u))
      }
      const pushedKeys = new Set()
      const failureInfos = []
      const readItemField = (item, field) => {
        try { return item && item[field] } catch (e) { return undefined }
      }
      // v3.250：日志边界——超长字段值（脏数据/整段内容/大对象 JSON）原样入日志会撑爆日志行；
      // 与推送内容截断同口径，仅限制日志显示长度，不影响实际推送内容
      const ITEM_LOG_MAX = 100
      const itemLogText = (item, field, fallback = '') => {
        const text = Utils.safeText(readItemField(item, field), fallback)
        return typeof text === 'string' && text.length > ITEM_LOG_MAX ? Utils.truncateUtf16(text, ITEM_LOG_MAX) : text
      }

      // 推送模板（v3.68 可配置）：非法/缺失回退默认（默认值与历史硬编码完全一致，现有测试锁定）
      const titleTpl = (typeof Config.template.title === 'string' && Config.template.title) ? Config.template.title : '【{分类名}】{标题}'
      const contentTpl = (typeof Config.template.content === 'string' && Config.template.content) ? Config.template.content : '{Markdown内容}'
      // 推送截断长度（v3.69 可配置）：非正数/非数字回退默认（负数会让 slice(0,-1) 误截尾字符）
      const titleMax = (() => { const v = Math.floor(Utils.num(Config.push.titleMax, 100)); return v > 0 ? v : 100 })()
      const contentMax = (() => { const v = Math.floor(Utils.num(Config.push.contentMax, 3000)); return v > 0 ? v : 3000 })()

      // 单条推送（两种模式共用）：成功返回 {ok:true} 并记录；失败警告且不写缓存(下次重试)
      const pushOne = async (item, notifyModule) => {
        // 推送内容截断：避免超长标题/内容被推送 API 拒绝（长度可配置，默认 100/3000）
        // 用 UTF-16 安全截断（不切断 emoji 代理对）
        // R9：title/content 非字符串（对象等脏数据）→ 空标题占位/空内容（避免 '[object Object]' 泄漏）
        const pushItem = {
          ...Utils.safeObjectCopy(item),
          url: urlOf(item),
          // v3.110：孤立代理清洗（encodeURIComponent 对孤立代理抛 URIError → 推送失败）
          // R9/审查9-C 语义保留：非字符串或空串 title → (无标题) 占位；content 空串置空
          title: (() => {
            const value = readItemField(item, 'title')
            return Utils.truncateUtf16(Utils.sanitizeSurrogates(typeof value === 'string' && value !== '' ? value : '(无标题)'), titleMax)
          })(),
          content: (() => {
            const value = readItemField(item, 'content')
            return Utils.truncateUtf16(Utils.sanitizeSurrogates(typeof value === 'string' ? value : ''), contentMax)
          })()
        }
        // 标题兜底截断（v3.70）：text 由「分类名+标题」拼接，分类名超长时整体可超 titleMax——
        // 与 desp 同口径，titleMax 语义统一为「推送标题最终长度上限」
        const text = Utils.truncateUtf16(Formatter.tuisong_replace(titleTpl, pushItem), titleMax)
        // desp 兜底截断：contentMax 统一作用于推送内容最终长度（v3.69 修复——原只截断 {内容} 字段，
        // {Markdown内容} 走 content_html 转换从不截断，超长 HTML 会撑爆推送 API）
        // v3.110：desp 也清洗孤立代理（content_html 可能含脏代理）
        const rawDesp = Formatter.tuisong_replace(contentTpl, pushItem)
        let desp = Utils.truncateUtf16(Utils.sanitizeSurrogates(rawDesp), contentMax)
        // v3.152：长内容截断曾把尾部"原文链接"截掉（用户看不到链接）——检测并保留
        const rawClean = Utils.sanitizeSurrogates(rawDesp)
        const safePushUrl = Utils.safeUrl(pushItem.url)
        if (rawClean.includes('原文链接') && !desp.includes('原文链接') && safePushUrl) {
          const link = `原文链接：[${safePushUrl}](<${safePushUrl}>)`
          // 链接本身超过 contentMax 时不保留（尊重截断配置）；否则内容截短补链接（仍 ≤ contentMax）
          // v3.177：边界修正——link 接近 contentMax 时 contentMax-link-2 曾 ≤0，truncateUtf16 对非正
          // max 返回原串 → desp 全量+链接显著超限（系统验证反证 #3）；改为「链接+分隔符完整容纳
          // 才补」+ keep≥1 保证总长 ≤ contentMax（link+2 == contentMax 时 keep=0 会触发上述缺陷）
          if (link.length + 2 < contentMax) {
            const keep = contentMax - link.length - 2
            desp = Utils.truncateUtf16(desp, keep) + '\n\n' + link
          }
        }
        try {
          await Pusher.send(text, desp, notifyModule)
          pushedKeys.add(keyOf(item))
          // v3.159：推送成功 → 清除过滤写入标记（否则 _f 随对象写回缓存，下次规则变更又误清）
          // 标记属性异常不能把已送达消息改判为失败；即使无法删除，后续缓存仍按成功处理。
          try { delete item._f } catch (e) { /* 非可配置脏属性不影响已成功推送 */ }
          return { item, ok: true }
        } catch (e) {
          // 非 Error 兜底（R1）：notify 抛字符串等非 Error 时避免 e.message undefined（与 v3.31/73/81 口径一致）
          const failure = summarizeError(e)
          failureInfos.push(failure)
          console.log(`⚠️ 推送失败（不写入缓存，下次运行重试）: ${itemLogText(item, 'title', '(无标题)')}【${itemLogText(item, 'catename')}】 ${failure.message || Utils.safeText(e)}`)
          return { item, ok: false, failure }
        }
      }

      // v3.223：推送模块（含 got）已与接口并行加载，首推前确保完成（接口快时最多等剩余加载时间）
      const notifyModule = await getNotify()
      checkpoint('notify-module-loaded')

      let successCount = 0
      // push.mode 非法值提示（防静默降级：用户配 'PARALLEL' 等会按顺序执行）
      if (Config.push && Config.push.mode && Config.push.mode !== 'sequential' && Config.push.mode !== 'parallel') {
        console.warn(`⚠️ 配置「push.mode」值无效：「${safeConfigText(Config.push.mode)}」（应为 sequential/parallel），已按顺序模式执行`)
      }
      if (Config.push && Config.push.mode === 'parallel') {
        // 并行推送：滑动窗口限并发；任意一条完成后立即补下一条。
        // parallelLimit 防御：小数取整（0.5 取 0 后回退 1）、0/负数回退全量、空 items 兜底 1。
        const MAX_PARALLEL_WORKERS = 50 // 并行推送硬性上限：防超大 parallelLimit/大批量瞬时拉起海量 worker
        const limit = (() => {
          const pl = Utils.num(Config.push.parallelLimit, 0)
          // 有效正数取整；0/负数/非法回退全量 items；二者均受硬性上限约束，空 items 兜底 1
          const base = pl > 0 ? Math.floor(pl) : items.length
          return Math.min(base, MAX_PARALLEL_WORKERS)
        })() || 1
        const pushInterval = Utils.num(Config.timing.pushInterval, 0)
        const results = new Array(items.length)
        let nextIndex = 0
        const worker = async () => {
          while (true) {
            const index = nextIndex++
            if (index >= items.length) return
            results[index] = await pushOne(items[index], notifyModule)
            // 保留可配置的补位间隔（per-worker 语义：每个 worker 完成一条后等 pushInterval 再补下一条，
            // 并行全局速率 = parallelLimit × interval；已知取舍，量小+重试兜底不改），pushInterval=0 即完成即补。
            if (pushInterval > 0 && nextIndex < items.length) {
              await new Promise(r => setTimeout(r, pushInterval))
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
        // 按原顺序输出成功日志（并发完成顺序不定，日志保持数据顺序）
        for (const r of results) {
          if (r && r.ok) console.log(`发现到新数据：${itemLogText(r.item, 'title', '(无标题)')}【${itemLogText(r.item, 'catename')}】${urlOf(r.item)}`)
        }
        successCount = results.filter(r => r && r.ok).length
      } else {
        // 顺序推送（默认）：逐条 await；仅在显式配置正间隔时等待。
        const pushInterval = Utils.num(Config.timing.pushInterval, 0)
        for (const item of items) {
          const r = await pushOne(item, notifyModule)
          if (r.ok) { successCount++; console.log(`发现到新数据：${itemLogText(item, 'title', '(无标题)')}【${itemLogText(item, 'catename')}】${urlOf(item)}`) }
          if (pushInterval > 0) await new Promise(r2 => setTimeout(r2, pushInterval))
        }
      }
      checkpoint('push-complete', `success=${successCount} failed=${items.length - successCount}`)
      if (PROFILE3 && notifyModule && typeof notifyModule.printWxPusherProfileSummary === 'function') {
        notifyModule.printWxPusherProfileSummary()
      }

      // ⑦ 写缓存：只收录「被过滤的数据」+「推送成功的数据」
      //    推送失败的排除在外 → 下次运行重新推送（避免消息永久丢失）
      const itemsKeys = new Set(items.map(keyOf))
      // v3.134：排除截断未推的（下次运行推剩余，防静默丢失）
      const toCache = newMessages.filter(m => !truncatedKeys.has(keyOf(m)) && (!itemsKeys.has(keyOf(m)) || pushedKeys.has(keyOf(m))))
      const cacheStart = Date.now()
      MessageStore.saveBatch(toCache, cacheName)
      cacheMs = Date.now() - cacheStart
      checkpoint('cache-write-complete', `cached=${toCache.length} cacheMs=${cacheMs}`)

      // 预取收尾：只观察已完成结果，不等待后台预取，避免它拖慢主流程退出。
      checkpoint('tls-warmup-observed', tlsWarmupSettled && tlsWarmup
        ? `ok=${tlsWarmup.ok} okCount=${tlsWarmup.okCount || 0}/${tlsWarmup.count || 0} elapsedMs=${tlsWarmup.elapsedMs}`
        : 'pending')

      // ⑧ 统计
      const pushMs = Date.now() - startTime
      const elapsed = (pushMs / 1000).toFixed(1)
      console.log('\n══════════ 本次运行 ══════════')
      console.log(`  获取:     ${xbkdata.length} 条`)
      console.log(`  去重跳过:  ${dedupCount} 条`)
      console.log(`  过滤屏蔽:  ${filteredCount} 条`)
      if (truncatedCount > 0) console.log(`  截断待推:  ${truncatedCount} 条（下次运行推送，防推送风暴）`)
      if (badElementCount > 0) console.log(`  非对象元素: ${badElementCount} 条（接口脏数据，已跳过）`)
      console.log(`  推送:     ${successCount} 条${successCount < items.length ? `（${items.length - successCount} 条失败，下次运行重试）` : ''}`)
      console.log(`  耗时:     ${elapsed}s`)
      if (process.env.XBK_PROFILE === '1' || detailedProfile) {
        const totalMs = Date.now() - runStart
        console.log(`  [profile] 接口: ${fetchMs === null ? 'n/a' : (fetchMs / 1000).toFixed(3) + 's'} | 推送: ${(pushMs / 1000).toFixed(3) + 's'} | 总计: ${(totalMs / 1000).toFixed(3) + 's'}`)
        if (detailedProfile) {
          const warmupText = dnsWarmup ? `${dnsWarmup.ok ? '成功' : '失败'} ${(dnsWarmup.elapsedMs / 1000).toFixed(3)}s${dnsWarmup.family ? ` IPv${dnsWarmup.family}` : ''}` : 'n/a'
          const tlsText = tlsWarmup ? `${tlsWarmup.okCount}/${tlsWarmup.count} 成功 ${(tlsWarmup.elapsedMs / 1000).toFixed(3)}s` : 'n/a'
          console.log(`  [profile detail] DNS预热: ${warmupText} | TLS预取: ${tlsText} | 预处理: ${(Math.max(0, preprocessMs || 0) / 1000).toFixed(3)}s | 缓存写入: ${(cacheMs || 0) / 1000}s | 收尾等待: ${(Utils.num(Config.timing.finalWait, 0) / 1000).toFixed(3)}s`)
        }
      }
      dumpCheckpoints()
      console.log('══════════════════════════════')
      await new Promise(r => setTimeout(r, Utils.num(Config.timing.finalWait, 0)))

      // v3.163：#9 推送全部失败无告警（v3.123 声称覆盖密钥失效但只实现接口挂）——
      // 补告警推送（限频复用 alert.state，防轰炸）+ run.log ERROR 行（cron 翻日志可见）
      // v3.170：await 告警完成（与 catch 路径 v3.164 同口径）——曾 fire-and-forget，
      // run() 返回后进程退出时序不确定（虽然内部 .catch 兜底不丢，但行为不一致）
      if (items.length > 0 && successCount === 0) {
        try { await this._sendAlert(`推送全部失败（${items.length} 条）：推送通道可能失效（key/限流/API）`) } catch (e) { /* 告警失败不阻塞主流程 */ }
        this._writeRunLog(`${this._localStamp()} ERROR 推送全部失败 ${items.length} 条（通道可能失效）\n`)
      }
      // 运行摘要持久化到缓存目录 run.log（cron 场景回溯/失败趋势；写失败不影响主流程）
      this._writeRunLog(`${this._localStamp()} total=${xbkdata.length} dedup=${dedupCount} filtered=${filteredCount} truncated=${truncatedCount} pushed=${successCount} failed=${items.length - successCount} elapsed=${elapsed}s\n`)

      // v3.125：运行日报（跨天发昨日汇总 + 当天累加；静默）
      const summary = {
        total: xbkdata.length,
        dedup: dedupCount,
        filtered: filteredCount,
        truncated: truncatedCount, // v3.145：截断数（下次推送）
        pushed: successCount,
        failed: items.length - successCount,
        failures: failureInfos
      }
      this._updateReport(summary)

      // 返回运行摘要（供外部/测试观测，cron 可据此判断）
      return summary
    } catch (error) {
      // 非 Error 抛出（如字符串）时兜底，避免 error.message undefined
      const errMsg = Utils.safeErrorText(error, Utils.safeText(error, '未知错误'))
      if (error && error.response) {
        console.log('请求失败，状态码:', error.response.statusCode)
      } else if (error && error.code === 'ETIMEDOUT') {
        console.log('请求超时:', errMsg)
      } else {
        console.log('请求错误:', errMsg)
      }
      dumpCheckpoints()
      // 失败也写运行日志（cron 可回溯失败原因；错误信息去换行避免破坏日志行）
      this._writeRunLog(`${this._localStamp()} ERROR ${String(errMsg).replace(/[\r\n]+/g, ' ')}\n`)
      // v3.123：接口异常告警（限频 + 静默，不影响主流程）
      // v3.164：await 告警完成——主入口 process.exit(1) 前需确保告警 HTTP 送达（#10）
      try { await this._sendAlert(errMsg) } catch (e) { /* 告警失败不阻塞重抛 */ }
      throw error // 重新抛出，让外层/调度感知失败（cron 场景 exit code 非 0）
    } finally {
      // 后台 DNS/TLS 预热不是业务结果，运行结束或失败时取消未完成请求，避免拖住进程退出。
      // v3.233：flag 兜底 getNotify() 未 resolve 的竞态——controller 尚未创建时主流程已结束，
      // then 回调稍后凭 flag 跳过启动，防止预热请求拖住退出。
      warmupCancelled = true
      if (warmupController) warmupController.abort()
    }
  }
}

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
    process.exitCode = 1
  }
  return summary
}

if (require.main === module) {
  runSingleEntry().catch(e => {
    console.error('程序运行失败:', Utils.safeErrorText(e, Utils.safeText(e, '未知错误')))
    process.exitCode = 1
  })
}

// ============================================================
// 📤 导出（供测试用）
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    listfilter: FilterEngine.listfilter.bind(FilterEngine),
    filterByKeyword: FilterEngine.filterByKeyword.bind(FilterEngine),
    validateConfig: RuleEngine.validateConfig.bind(RuleEngine),
    tuisong_replace: Formatter.tuisong_replace.bind(Formatter),
    htmlToMarkdown: Formatter.htmlToMarkdown.bind(Formatter),
    isMessageInFile: MessageStore.has.bind(MessageStore),
    appendMessageToFile: MessageStore.save.bind(MessageStore),
    getFileName: MessageStore.getFileName.bind(MessageStore),
    fetchData: Network.fetchData.bind(Network),
    // 主流程（集成测试用）
    run: App.run.bind(App),
    runSingleEntry,
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
    anonKey: Utils.anonKey.bind(Utils),
    hasValidId: Utils.hasValidId.bind(Utils),
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
    // ReDoS 防护检测（嵌套量词）
    hasNestedQuantifier: RuleEngine.hasNestedQuantifier.bind(RuleEngine),
    // 缓存内部方法
    getFilePath: MessageStore.getFilePath.bind(MessageStore),
    _ensureFileExists: MessageStore._ensureFileExists.bind(MessageStore),
    readMessages: MessageStore.readMessages.bind(MessageStore),
    saveMessages: MessageStore.saveMessages.bind(MessageStore),
    Config
  }
}
