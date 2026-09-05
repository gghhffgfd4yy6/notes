'use strict'

/* eslint indent: off, no-control-regex: off, no-unused-vars: off */
// Utils extracted verbatim from xbk_function_v3.js; integration remains the main
// entrypoint's responsibility. Inject the shared safeRe/cache and fs dependency.
const FILTER_FIELDS = [
  'pingbifenlei', 'pingbibiaoti', 'zhanxianbiaoti',
  'pingbibiaotiplus', 'pingbineirong', 'zhanxianneirong',
  'pingbineirongplus', 'pingbilouzhu', 'zhanxianlouzhu',
  'pingbilouzhuplus'
]
const TRACKING_QUERY_NAMES = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'mc_cid', 'mc_eid', 'igshid', '_ga', '_gl'])

// ---------- 魔法数字常量 ----------
const DAY_MS = 24 * 60 * 60 * 1000 // 一天的毫秒数
const TS_BOUND = 100_000_000_000 // 秒/毫秒时间戳分界（10位秒 / 12+位毫秒）
const MAX_CODE_POINT = 0x10FFFF // Unicode 最大码点
const SURROGATE_LO = 0xD800 // 代理区起点
const SURROGATE_HI = 0xDFFF // 代理区终点
const DEFAULT_MAX_SIZE = 10000 // 缓存默认上限（v3.120：100 → 10000）
// 状态/哈希文件体积上限：alert.state/report.state/filter.hash 均为数百字节级小文件，
// 强制大小上限防止异常膨胀文件被整读入内存（readSafeTextResult 的 maxBytes 兜底）。
const STATE_TEXT_MAX_BYTES = 64 * 1024
// 消息缓存文件体积上限：缓存默认上限 10000 条，正常体积为 MB 级；此上限作为硬兜底，
// 阻止异常膨胀的缓存文件被整读入内存（readSafeTextResult 的 maxBytes 兜底）。
const MESSAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024
// 判重身份墓碑：缓存裁剪丢弃的记录身份独立保留（见 MessageStore._tombstone*），
// 上限按每类键数约束，防止墓碑文件随裁剪无限膨胀。
const TOMBSTONE_MAX_KEYS = 5000 // 每类墓碑键上限（id/urlOnly/idWithUrl/anon 各 5000）
const TOMBSTONE_MAX_BYTES = 8 * 1024 * 1024 // 墓碑文件读取/写入体积上限
const TOMBSTONE_LOCK_STALE_MS = 10000 // 锁文件超过该年龄视为崩溃残留，可抢占

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
// 去尾部斜杠：线性扫描替代 /\/+$/（S8786 对 X+$ 型正则标记超线性回溯；配置值虽可信，
// 但改成等价线性实现可消除告警且无语义差异）
function trimTrailingSlashes (s) {
  let i = s.length
  while (i > 0 && s.codePointAt(i - 1) === 47) i-- // 47 = '/'
  return i === s.length ? s : s.slice(0, i)
}
const DEC_RE = /&#(\d+);/g
const HEX_RE = /&#[xX]([0-9a-fA-F]+);/g

// 键序无关规范化：递归排序对象键，避免 JSON.stringify 比较对键顺序敏感（数组顺序保留）
const NORMALIZE_MAX_DEPTH = 32
function normalize (o, depth = 0) {
  if (depth > NORMALIZE_MAX_DEPTH) return o
  if (Array.isArray(o)) return o.map(x => normalize(x, depth + 1))
  if (o instanceof Date || o instanceof RegExp) return o
  if (o && typeof o === 'object') {
    const out = {}
    for (const k of Object.keys(o).sort((a, b) => a.localeCompare(b))) Object.defineProperty(out, k, { value: normalize(o[k], depth + 1), enumerable: true, writable: true, configurable: true })
    return out
  }
  return o
}
function createUtils (options = {}) {
  const fs = options.fs || require('node:fs')
  const safeRe = options.safeRe
  if (typeof safeRe !== 'function') throw new TypeError('createUtils requires the shared safeRe function')
  const ENTITY_RE = safeRe('&(?:' + Object.keys(ENTITY_MAP).map(k => escapeRe(k.slice(1, -1))).join('|') + ');', 'g') // 从 ENTITY_MAP 自动生成，加实体只改一处

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
    // v3.259：格式分支提取为子函数降圈复杂度（行为不变）；返回约定：undefined=未匹配，null=非法，数字=毫秒
    if (typeof time === 'number' || /^-?\d+(\.\d+)?$/.test(s)) {
      return this._parseNumericTime(s)
    }
    let r = this._parseDateTimeNoTz(s)
    if (r !== undefined) return r
    r = this._parseDashDate(s)
    if (r !== undefined) return r
    r = this._parseSlashDate(s)
    if (r !== undefined) return r
    r = this._parseIsoZ(s)
    if (r !== undefined) return r
    return this._parseFallback(s)
  },

  // v3.259 提取（parseTime 子函数，行为不变）：数字形态（8 位日期 > 时间戳）
  _parseNumericTime (s) {
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
      if (!Number.isNaN(t.getTime())) return t.getTime()
    }
    return null
  },

  // v3.259 提取：显式解析无时区的日期时间（含单数字月日），统一按 UTC，不再落入宿主本地时区。
  _parseDateTimeNoTz (s) {
    const dateTime = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/)
    if (!dateTime) return undefined
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
  },

  // v3.259 提取：YYYY-MM-DD（v3.115 时区修复：Date.UTC 解析，同 8 位日期）
  _parseDashDate (s) {
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (!m) return undefined
    const y = +m[1]; const mo = +m[2]; const d = +m[3]
    const t = new Date(Date.UTC(y, mo - 1, d))
    // 回读校验：new Date 会把 2026-02-31 滚动到 03-03，回读对比即拒绝
    if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return t.getTime()
    return null
  },

  // v3.259 提取：'YYYY/MM/DD' 显式分支（与 'YYYY-MM-DD' 同口径回读校验，拒绝 2026/02/31 等宿主滚动）
  _parseSlashDate (s) {
    const slash = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
    if (!slash) return undefined
    const y = +slash[1]; const mo = +slash[2]; const d = +slash[3]
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    const t = new Date(Date.UTC(y, mo - 1, d))
    if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return t.getTime()
    return null
  },

  // v3.259 提取：带时区 ISO 显式分支——先尝试宿主解析；仅对原生 Invalid 的合法单数字月/日
  // 做补零回退；任何路径都先做年月日回读校验，拒绝 2026-02-31T00:00:00Z 等宿主滚动。
  _parseIsoZ (s) {
    const isoZ = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i)
    if (!isoZ) return undefined
    const y = +isoZ[1]; const mo = +isoZ[2]; const d = +isoZ[3]
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    const t = new Date(Date.UTC(y, mo - 1, d))
    const dateOk = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    if (dateOk) {
      const r = new Date(s)
      if (!Number.isNaN(r.getTime())) return r.getTime()
      // 宿主解析不接受非补零 ISO（如 '2026-8-1T00:00:00Z'）：补零后仍按原格式解析。
      const normalized = s.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})/, (_, yy, mm, dd) => `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`)
      const r2 = new Date(normalized)
      if (!Number.isNaN(r2.getTime())) return r2.getTime()
    }
    return null
  },

  // v3.259 提取：其他格式回退宿主解析（含 ISO 2026-08-01T00:00:00Z、/ 分隔等）
  _parseFallback (s) {
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
    if (Number.isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/'))
    // v3.171：回退时 T 分隔一并转空格——'2026-8-1T10:30'（单数字月日 T 格式）曾 Invalid 返回 null，
    // 而 '2026-8-1 10:30'（空格格式）宽松解析有效——同类格式不一致；'2026/8/1 10:30' 解析有效
    if (Number.isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/').replace('T', ' '))
    if (Number.isNaN(t.getTime())) return null
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
  _trimUrlEdges (value) {
    const isTrimChar = (ch) => ch === '/' || /\s/.test(ch)
    let lo = 0; let hi = value.length
    while (lo < hi && isTrimChar(value[lo])) lo++
    while (hi > lo && isTrimChar(value[hi - 1])) hi--
    return lo === 0 && hi === value.length ? value : value.slice(lo, hi)
  },
  _normalizeUrlAuthority (value) {
    const m = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)
    if (!m) return value
    const rest = value.slice(m[0].length)
    const slash = rest.indexOf('/')
    const host = slash === -1 ? rest : rest.slice(0, slash)
    if (host === '') return value
    const at = host.lastIndexOf('@')
    const normalizedHost = at === -1 ? host.toLowerCase() : host.slice(0, at + 1) + host.slice(at + 1).toLowerCase()
    return m[0].toLowerCase() + normalizedHost + (slash === -1 ? '' : rest.slice(slash))
  },
  _isTrackingQueryName (rawName) {
    let name = rawName.toLowerCase()
    try { name = decodeURIComponent(rawName.replace(/\+/g, '%20')).toLowerCase() } catch (e) { /* 保留无法解码的业务参数 */ }
    return name.startsWith('utm_') || TRACKING_QUERY_NAMES.has(name)
  },
  /** 归一化 URL 用于判重：trim + 去尾部斜杠（/foo 与 foo/ 视为同一资源） */
  normUrl (u) {
    if (u === undefined || u === null) return ''
    let s
    try { s = String(u).trim() } catch (e) { return '' }
    const hashIndex = s.indexOf('#')
    if (hashIndex !== -1) s = s.slice(0, hashIndex)
    const queryIndex = s.indexOf('?')
    const rawQuery = queryIndex === -1 ? '' : s.slice(queryIndex + 1)
    if (queryIndex !== -1) s = s.slice(0, queryIndex)
    s = this._trimUrlEdges(s)
    s = this._normalizeUrlAuthority(s)
    if (rawQuery) {
      const kept = rawQuery.split('&').filter(part => !this._isTrackingQueryName(part.split('=', 1)[0]))
      if (kept.length) s += '?' + kept.join('&')
    }
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
    // v3.258 C009：named 实体替换改为大小写不敏感查表（&Colon;/&COLON; 等变体统一收敛）。
    // 双编码防护：decodeHtmlEntities 后再跑一次 named 替换，确保 &amp;colon; → &colon; → ':' 被识别。
    const decodeNamed = (str) => str.replace(/&(?:colon|Tab|NewLine|Newline|nbsp);/gi, m => ({ '&colon;': ':', '&tab;': '\t', '&newline;': '\n', '&nbsp;': '\u00A0' })[m.toLowerCase()] || '')
    s = decodeNamed(s)
    s = this.decodeHtmlEntities(s)
    s = decodeNamed(s)
    // 去除 ASCII 控制空白，防止 `java\nscript:`/`java\tscript:` 等内部空白绕过协议检查
    // v3.245 P0：同时清理 \u00A0(nbsp 解码产物) 与 \u200B 等零宽，防 java\u00A0script: 变体
    const compact = s.replace(/[\u0000-\u0020\u00A0\u200B-\u200D\uFEFF]+/g, '').toLowerCase()
    if (/^(javascript|vbscript|data):/.test(compact)) return true
    // v3.258 C009：命名实体解码出的控制空白若紧跟在协议关键字后，浏览器归一化后仍可能
    // 构成 `javascript\n:...` 危险协议，这里同样拦截（如 `javascript&Newline;x`）。
    return /^(?:javascript|vbscript|data)[\u0000-\u0020\u00A0\u200B-\u200D\uFEFF]/.test(s.toLowerCase())
  },

  /** 清洗 HTML href/src 中的危险协议，保留标签和普通文本 */
  sanitizeHtmlUrls (html) {
    if (html === undefined || html === null) return ''
    try { html = String(html) } catch (e) { return '' }
    const cleanAttr = (name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`
    // 成对引号 href/src：值域禁止含 `<`（[^<]*?）——未闭合引号若与后续属性引号跨标签配对，
    // 会把中间标签吞掉并遗留危险文本（子代理审查发现：`<a href="javascript:x><b><a href="javascript:y>`
    // 输出 `<a href=""javascript:y>` 残留 javascript）。含 `<` 的"成对"实为未闭合，
    // 由下方 _cleanUnclosedUrlAttrs 线性处理（值内 `<` 是标签边界，合法 URL 值不含裸 `<`）。
    html = html.replace(/\b(href|src)\s*=\s*(["'])([^<]*?)\2/gi, (_, name, quote, value) => cleanAttr(name, quote, value))
    html = html.replace(/\b(href|src)\s*=\s*([^\s"'<>`]+)/gi, (_, name, value) => this.isDangerousUrl(value) ? `${name}=""` : `${name}=${value}`)
    // v3.251 P0(XSS)：未闭合引号属性绕过——`<a href="javascript:alert(1)` 无闭合引号时
    // 上面两个正则均不匹配（成对引号/无引号值），危险协议保留并被执行。这里单独处理
    // 未闭合引号形态：引号后到标签边界(< 或行尾)之间【不含相同闭合引号】的值才处理，
    // 避免误伤已闭合的合法 href（此前会多补引号并吞掉后续属性）。
    html = this._cleanUnclosedUrlAttrs(html)
    return html
  },

  // v3.260：未闭合引号 href/src 清洗（线性扫描替代回溯正则，语义与 v3.251 等价）
  // 匹配 `href="value`（引号后到 < 或行尾之间无同引号）→ 危险协议清空，否则补闭合引号。
  // 已闭合（同引号在 < 前出现）→ 跳过（由成对引号正则处理），不重复处理。
  _cleanUnclosedUrlAttrs (html) {
    const re = /\b(href|src)\s*=\s*(["'])/gi
    let m
    let out = ''
    let last = 0
    while ((m = re.exec(html)) !== null) {
      const name = m[1].toLowerCase()
      const quote = m[2]
      const valueStart = re.lastIndex
      const lt = html.indexOf('<', valueStart)
      const end = lt === -1 ? html.length : lt
      const closeQuote = html.indexOf(quote, valueStart)
      if (closeQuote !== -1 && closeQuote < end) {
        re.lastIndex = closeQuote + 1
        continue
      }
      // CodeAnt 审查（PR #27/#28）：仅处理标签内的 href/src——普通文本
      // 「see href='x」不是属性，不应被合成修复（htmlToMarkdown 会对无标签内容调用本函数）。
      // PR #28 Critical 修复：标签边界判断必须尊重引号属性——`<a title=">" href='javascript:...`
      // 的 > 在引号内不算标签结束（lastIndexOf 会误判为标签外而跳过危险 URL）。
      // 线性回扫：引号内跳过 >；未引号的 > 表示标签已结束；< 表示在标签内。
      if (!this._isInHtmlTag(html, m.index)) {
        re.lastIndex = valueStart
        continue
      }
      const value = html.slice(valueStart, end)
      // CodeAnt 审查（PR #27）：非危险分支补闭合引号（与 v3.251 语义一致，
      // 原实现漏尾部 quote 会产出畸形 HTML，浏览器吞并后续 markup）
      out += html.slice(last, m.index) + (this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`)
      last = end
      re.lastIndex = end
    }
    return out + html.slice(last)
  },

  // v3.260：判断 pos 是否位于 HTML 标签内（线性回扫，尊重引号属性）
  // 引号内 > 不算标签结束（`<a title=">" href=...` 的 > 是属性值）；
  // 未引号的 > 标签已结束；< 即标签开始；越界视为普通文本。
  _isInHtmlTag (html, pos) {
    let i = pos - 1
    let quote = ''
    while (i >= 0) {
      const ch = html[i]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        return false
      } else if (ch === '<') {
        return true
      }
      i--
    }
    return false
  },

  /** CSS 转义全量解码：十六进制（\\XXXXXX）、\\uXXXX 兼容形态、行延续（\\换行）与恒等转义
      （\\r → r）。P1（审查 2026-08-15）：C010 只解十六进制，u\\rl(javascript:) 的恒等转义在
      浏览器 CSS 解析时还原为 url(...)，绕过 style 黑名单；解码后再跑黑名单即可拦截。 */
  _decodeCssEscapes (value) {
    try { value = String(value) } catch (e) { return '' }
    return value.replace(
      safeRe(String.raw`\\u([0-9a-fA-F]{1,6})|\\([0-9a-fA-F]{1,6})[\s]?|\\([\n\r\u0000])|\\([^0-9a-fA-F\n\r\u0000])`, 'g'),
      (m, a, b, nl, ident) => {
        if (a !== undefined || b !== undefined) {
          const cp = Number.parseInt(a || b, 16)
          return (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : m
        }
        if (ident !== undefined) return ident // CSS 恒等转义：\r → r（随后黑名单拦截 url(...)/expression(...)）
        return '' // \\ 后接换行/CR/NUL：CSS 行延续/无效转义 → 移除
      }
    )
  },

  /** 实体解码后再次清理主动 HTML/事件属性，防止 &lt;script&gt; 重新形成可执行标签 */
  sanitizeDecodedHtml (html) {
    if (html === undefined || html === null) return ''
    try { html = String(html) } catch (e) { return '' }
    // 与 htmlToMarkdown 的 100k 截断口径对齐，防止未闭合主动标签堆叠导致回溯式 ReDoS。
    if (html.length > 100000) html = html.slice(0, 100000)
    // HTML tokenizer 将 NUL 替换为 U+FFFD；先移除可被用来拆散属性名的 NUL，
    // 让 `on\u0000error` 收敛为 `onerror` 后进入统一事件属性清理。
    html = html.replace(safeRe('\\u0000', 'g'), '')
    html = this.sanitizeHtmlUrls(html)
    // 成对和未闭合的主动标签都处理；不再做全局引号保护——全局引号保护会把文本中的
    // "<iframe src=x>" 也保护为占位符，导致文本中的真实主动标签漏网（验证 agent 复核发现）。
    html = this._removeActiveTags(html)
    html = this._protectAndCleanEventAttrs(html)
    html = this._cleanNavAttrs(html)
    html = this._cleanSrcsetAttrs(html)
    html = this._cleanStyleAttrs(html)
    return html
  },

  /** 移除成对/未闭合的主动标签（script/style/iframe/object/embed/svg/math）与导航标签（base/link/meta）。
   *  Round2 C002 终修：恢复宽松 [\s\S]*?（HTML 语义：script 内容中第一个 </script> 即闭合，
   *  与浏览器解析一致；闭合后残留的标签由未闭合移除与事件属性清洗链兜底）。
   *  性能：入口 100k 截断使最坏回溯有界（10 万字符实测 ~270ms）。 */
  _removeActiveTags (html) {
    // P4（CodeAnt）：开/闭标签用独立交替会跨标签名配对——`<script>content</iframe>` 会把
    // 中间有效内容整段删除。改为逐标签名成对移除（`<tag>...</tag>`），错配的闭合标签交给
    // 下方未闭合/孤立闭合规则兜底。不用反向引用 `<\1`：RE2 不支持，且 `[\s\S]*?<\/\1`
    // 无法做字面量快速搜索，畸形输入（大量无闭合 `<script`）会退化为 O(n²) 回溯。
    let out = html
    // 外层守卫：无任何主动标签时整轮跳过（热路径常见纯文本/无主动标签内容，省 6 次正则）
    if (safeRe(String.raw`<(?:script|style|iframe|object|svg|math)\b`, 'i').test(out)) {
      for (const tag of ['script', 'style', 'iframe', 'object', 'svg', 'math']) {
        // 逐标签快速预检：无该标签时跳过整轮 replace
        if (safeRe(String.raw`<${tag}\b`, 'i').test(out)) {
          out = out.replace(safeRe(String.raw`<${tag}\b[\s\S]*?<\/${tag}\s*>`, 'gi'), '')
        }
      }
    }
    return out
      .replace(safeRe('<(?:script|style|iframe|object|embed|svg|math)\\b(?:[^<>]|"[^"]*"|\'[^\']*\')*>', 'gi'), '')
      .replace(safeRe('<\\/(?:script|style|iframe|object|svg|math)\\s*>', 'gi'), '')
      .replace(safeRe('<(?:base|link|meta)\\b[^<>]*>', 'gi'), '')
  },

  /** 事件属性（on*）清洗（v3.254 P0(XSS)：事件属性名前的分隔符允许引号，`src="x"onerror=` 是
   *  合法事件属性；完整删除事件属性，测试锁定 `\bon[a-z]*\s*=` 不残留）。
   *  v3.257 修正：先把非事件属性对（attr="value"，含值内 onxxx= 字样）整体占位保护，
   *  事件属性（on*）不保护，再清洗引号外的事件属性，最后还原——值内的 onxxx= 不再暴露给
   *  清洗正则，无空格恶意形态的闭合引号随保护占位符边界保留。 */
  _protectAndCleanEventAttrs (html) {
    const { html: protectedHtml, attrStore } = this._protectAttrPairs(html)
    html = this._stripEventAttrs(protectedHtml)
    html = html.replace(safeRe(String.raw`\u0001(\d+)\u0001`, 'g'), (_, i) => attrStore[Number(i)])
    // 清理清洗后残留的孤立占位符边界（原无空格恶意形态的闭合引号被删除后遗留）
    return html.replace(safeRe(String.raw`[\u0001\u0002]`, 'g'), '')
  },

  /** 非事件属性对整体占位（v3.261 P1(ReDoS)：原贪心名称前缀在长词串上逐位回溯找 = 呈 O(n²)，
   *  改为线性扫描先定位 =["']（前缀无量词天然线性），再回扫确认属性名与引号值闭合）。 */
  _protectAttrPairs (html) {
    const attrStore = []
    const attrValueRe = safeRe(String.raw`=\s*(["'])`, 'gi')
    let attrOut = ''
    let attrPos = 0
    let attrM
    while ((attrM = attrValueRe.exec(html)) !== null) {
      const valueStart = attrValueRe.lastIndex
      const seg = this._attrSegAt(html, attrM, valueStart)
      if (seg === null) {
        // 无闭合引号：本处及之后不再有可完整保护的属性对，剩余原样保留（与原正则无匹配一致）
        attrOut += html.slice(attrPos)
        attrPos = html.length
        break
      }
      const segText = html.slice(seg.segStart, seg.closeEnd)
      // on* 事件属性不保护（留待下一步清洗）；其余属性对整体保护
      if (seg.name !== '' && !/^on[a-z]/i.test(seg.name)) {
        attrStore.push(segText)
        attrOut += html.slice(attrPos, seg.segStart) + '\u0001' + (attrStore.length - 1) + '\u0001'
      } else {
        attrOut += html.slice(attrPos, seg.closeEnd)
      }
      attrPos = seg.closeEnd
      attrValueRe.lastIndex = seg.closeEnd // 跳过已消费的引号值，避免值内 = 被重复扫描
    }
    if (attrPos < html.length) attrOut += html.slice(attrPos)
    return { html: attrOut, attrStore }
  },

  /** 解析 =["'] 属性段：返回 {name, segStart, closeEnd}；引号未闭合返回 null。
   *  回扫确认属性名：= 前允许空白；名字 [a-zA-Z_:][\w:.-]*（语义与原正则一致，仅用于 on* 判定与段边界）。 */
  _attrSegAt (html, attrM, valueStart) {
    const eqPos = attrM.index
    const quote = attrM[1]
    const closeRel = html.indexOf(quote, valueStart)
    if (closeRel === -1) return null
    const closeEnd = closeRel + 1
    let i = eqPos - 1
    while (i >= 0 && /\s/.test(html[i])) i--
    const runEnd = i + 1
    while (i >= 0 && /[\w:.-]/.test(html[i])) i--
    const run = html.slice(i + 1, runEnd)
    const nameStartInRun = run.search(/[a-zA-Z_:]/)
    const name = nameStartInRun === -1 ? '' : run.slice(nameStartInRun)
    const segStart = nameStartInRun === -1 ? eqPos : i + 1 + nameStartInRun
    return { name, segStart, closeEnd }
  },

  /** 逐轮剥除事件属性（v3.257 后补充 C001：单次 replace 会连分隔引号一起消费，导致后续相邻
   *  on* 属性失去引号分隔符无法匹配；do-while 每轮至少删除一个，字符串必然变短并收敛）。
   *  保留属性名前的分隔符（空格/引号/占位符边界是 HTML 语法必需），删除整个 onxxx="值" 段。 */
  _stripEventAttrs (html) {
    let prev
    do {
      prev = html
      html = html.replace(safeRe(String.raw`(?:\s|\/|["\'\u0001\u0002])(on[a-z][a-z0-9_-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`, 'gi'), (m) => {
        const c = m[0][0]
        if (c === '\u0001' || c === '\u0002') return c
        return c === '"' || c === "'" ? c : ' '
      })
    } while (html !== prev)
    return html
  },

  /** 覆盖 href/src 之外的可导航/可加载属性（xlink:href、formaction、poster 等）清洗。 */
  _cleanNavAttrs (html) {
    return html
      .replace(safeRe(String.raw`\b(xlink:href|formaction|action|poster|cite|background|dynsrc|lowsrc)\s*=\s*(["'])([\s\S]*?)\2`, 'gi'),
        (_, name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`)
      .replace(safeRe(String.raw`\b(xlink:href|formaction|action|poster|cite|background|dynsrc|lowsrc)\s*=\s*([^\s"'<>\`]+)`, 'gi'),
        (_, name, value) => this.isDangerousUrl(value) ? `${name}=""` : `${name}=${value}`)
  },

  /** srcset 可在候选项中藏危险协议；检测到任意危险候选即清空整个属性。 */
  _cleanSrcsetAttrs (html) {
    const compact = (value) => this.decodeHtmlEntities(value).replace(safeRe(String.raw`[\u0000-\u0020]+`, 'g'), '').toLowerCase()
    return html
      .replace(safeRe('\\bsrcset\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'gi'), (_, quote, value) => {
        const v = compact(value)
        return /(?:^|[,])(?:javascript|vbscript|data):/.test(v) ? `srcset=${quote}${quote}` : `srcset=${quote}${value}${quote}`
      })
      .replace(safeRe('\\bsrcset\\s*=\\s*([^\\s"\'<>`]+)', 'gi'), (_, value) => {
        const v = compact(value)
        return /^(?:javascript|vbscript|data):/.test(v) ? 'srcset=""' : `srcset=${value}`
      })
  },

  /** CSS url()/expression()/behavior 可形成主动加载或脚本执行路径；不需要保留这类 style。
   *  C010 + P1（审查 2026-08-15）：先解 CSS 转义（十六进制 u\72l→url、恒等转义 u\rl→url 等），
   *  再跑现有黑名单。 */
  _cleanStyleAttrs (html) {
    const unsafeStyle = (value) => {
      const v = this._decodeCssEscapes(this.decodeHtmlEntities(value)).toLowerCase()
      return /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/.test(v)
    }
    return html
      .replace(safeRe(String.raw`\bstyle\s*=\s*(["'])([\s\S]*?)\1`, 'gi'), (_, quote, value) => unsafeStyle(value) ? `style=${quote}${quote}` : `style=${quote}${value}${quote}`)
      .replace(safeRe(String.raw`\bstyle\s*=\s*([^\s"'<>\x60]+)`, 'gi'), (_, value) => unsafeStyle(value) ? 'style=""' : `style=${value}`)
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
    if (typeof error === 'number' || typeof error === 'boolean') return this.safeText(error, fallback)
    if (typeof error === 'symbol') {
      try { return this.safeText(Symbol.prototype.toString.call(error), fallback) } catch (e) { return fallback }
    }
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
    return s.replace(safeRe('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]', 'g'), '\uFFFD')
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
    let ownId = false
    try { ownId = Object.prototype.hasOwnProperty.call(message, 'id') } catch (e) { ownId = false }
    const id = ownId ? this.safeGet(message, 'id') : undefined
    let ownUrl = false
    try { ownUrl = Object.prototype.hasOwnProperty.call(message, 'url') } catch (e) { ownUrl = false }
    if (id !== undefined && id !== null && (typeof id === 'string' ? id.trim() !== '' : (typeof id === 'number' && Number.isFinite(id)))) {
      const idKey = typeof id === 'string' ? id.trim() : String(id)
      const url = this.validUrl(ownUrl ? this.safeGet(message, 'url') : undefined)
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
    const url = this.validUrl(ownUrl ? this.safeGet(message, 'url') : undefined)
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
    // P3（审查 2026-08-15）：顶层 Date/Map/Set（无可枚举键）会被误判相等——当前管道消息均为
    // JSON 纯对象，不可达；若未来接入特殊对象需在此加 a.constructor === Object 前提（注释锁定）。
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const keysA = []
    const keysB = []
    try {
      for (const k of Object.keys(a)) if (k !== 'timestamp') keysA.push(k)
    } catch (e) {
      return false
    }
    try {
      for (const k of Object.keys(b)) if (k !== 'timestamp') keysB.push(k)
    } catch (e) {
      return false
    }
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
      // P3（审查 2026-08-15）：同值/同引用（含同引用对象——内容必相同）直接短路为未变更，
      // 曾置于对象检查之后导致同引用对象仍走深排慢路径（浪费）；移到最前真正生效
      if (va === vb) continue
      // 任何非同值（含不同引用对象、BigInt、不同原始值）都不短路：统一交由慢路径（深排）判定
      return false
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
      try { return String(p).replace(safeRe('%', 'g'), '%25').replace(safeRe('\\\\', 'g'), '%5C').replace(safeRe('\\|', 'g'), '%7C') } catch (e) { return '' }
    }
    let s = ''
    for (const p of parts) {
      if (p === undefined || p === null) continue
      const t = str(p)
      if (t.trim() !== '') s = s === '' ? t : s + '|' + t
    }
    let h1 = 5381; let h2 = 52711
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
    // C015：非字符串值加 typeof 前缀，避免 0 与 '0'、true 与 'true' 等类型归一与 compileRules 不一致导致过滤缓存不失效
    const safeStr = (v) => {
      if (v === undefined || v === null || typeof v === 'symbol') return ''
      try { return (typeof v === 'string' ? '' : typeof v + ':') + String(v).trim() } catch (e) { return '' }
    }
    for (const f of FILTER_FIELDS) {
      // P3（审查 2026-08-15）：属性访问套 safeGet——getter/proxy 抛错不崩 App.run
      const v = Utils.safeGet(filterCfg, f)
      parts.push(f + '=' + safeStr(v))
    }
    // v3.161：补 pingbitime——曾漏（FILTER_FIELDS 不含它），改宽 pingbitime 后「过滤写入」缓存不失效，
    // 被天数过滤的旧条目不重推（#7，与 v3.159 #2 同 class 疏漏）。
    // 简单数字形式再按 compileRules 做 Number 归一：'5'/'05'/'5.0'/' 5 ' 同编译为 value 5；
    // 非法/负数 → ''（compileRules 编译为 null，无时间过滤）；### 多行形式仅整体 trim，保留行内格式。
    // C015：pingbitime 用 rawStr 而非 safeStr——compileRules 对 pingbitime 不拒绝 number，String 化后同样编译；
    // 此处若带 typeof 前缀会导致 Number('number:5')=NaN 而误判无时间过滤（安全侧保持一致）。
    let pb = rawStr(Utils.safeGet(filterCfg, 'pingbitime')).trim()
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
    // P1（审查 2026-08-15）：与 C015 同款类型归一（typeof 前缀，不 trim）——zkt_gjc 在字符串↔
    // 非字符串间切换（'0'→0、'true'→true、'[object Object]'→{}）时，App.run 对非字符串直接
    // 跳过只看它过滤（R11-1）、字符串则执行并标记 _f；此前 rawStr 无类型前缀 → 哈希不变 →
    // 改宽/取消只看它过滤后旧 _f 条目永不重评、静默漏推（与 C015 已修的 FILTER_FIELDS 同类疏漏）。
    const typedRawStr = (v) => {
      if (v === undefined || v === null || typeof v === 'symbol') return ''
      try { return (typeof v === 'string' ? '' : typeof v + ':') + String(v) } catch (e) { return '' }
    }
    parts.push('zkt_gjc=' + typedRawStr(zktGjc))
    // P3：pingbitime 天数过滤结果随注册天数增长（daysFrom 逐日 UTC 日期差）而变化，静态配置哈希不会变——
    // 已 _f 标记的旧条目因「缓存失效仅由静态哈希触发」而永不重评、长期漏推（老化过阈值后本应补推）。
    // pingbitime 启用时把当前 UTC 日期折进哈希：跨天即失效 _f 缓存 → 老化过阈值的条目被重新评估/推送；
    // 未启用则无时间依赖，不折入日期，避免无谓的每日全量重评。
    if (timeActive) {
      const d = new Date()
      parts.push('date=' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'))
    }
    const s = parts.join('\u0001')
    // P2（审查 2026-08-15）：由单一 32 位 djb2 升级为两路独立 32 位 djb2 拼接（64 位碰撞空间），
    // 与 anonKey（v3.248）同款——32 位下配置变更哈希碰撞 → 「过滤写入」缓存不失效 → 改宽过滤后
    // 旧条目静默漏推。仍输出确定性十进制串，仅用于相等比较，格式变更无兼容问题。
    let h1 = 5381; let h2 = 52711
    for (let i = 0; i < s.length; i++) {
      // S7758：codePointAt 对代理对返回完整码点（BMP 字符与 charCodeAt 等价，ASCII 配置哈希值不变）
      const c = s.codePointAt(i)
      h1 = ((h1 * 33) ^ c) >>> 0
      h2 = ((h2 * 31) + c + i) >>> 0
    }
    return String(h1) + '-' + String(h2)
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
    // v3.185：补充平面修饰符（肤色 U+1F3FB–1F3FF / VS 补充 U+E0100–E01EF）也纳入判定
    // （用 codePointAt 读取码点，避免截断拆散 👍🏽 等补充平面 emoji）
    // 注意：区域指示符 U+1F1E6–1F1FF 不纳入修饰符判定——旗帜由两个区域指示符组成，
    // 每个区域指示符是独立码点；作为"前一字符的修饰符"退位会误删其前面的正常字符（A🇨🇳→空）。
    const isModifier = (c) => c === 0x200D || (c >= 0xFE00 && c <= 0xFE0F) ||
            (c >= 0x0300 && c <= 0x036F) || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) ||
            (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F) ||
            (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0100 && c <= 0xE01EF)
    // 补充平面修饰符专用判定：紧随补充平面基符的修饰符（不含 ZWJ，避免拆散 👨👩👧👦 首个完整 emoji）
    const isSupplementaryModifier = (c) =>
      (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0100 && c <= 0xE01EF)
    while (cut.length > 0) {
      const last = cut.charCodeAt(cut.length - 1)
      // 代理对：完整低代理对保留；高代理/孤立低代理退位；
      // 完整对后若是补充平面修饰符则退位（不拆散基底代理对，如 👍🏽）
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
      // 末尾 ZWJ 本身退位（连接符不应做结尾）；删除后 continue，
      // 不再把截断点后同一 ZWJ 当修饰符二次回退
      if (last === 0x200D) { cut = cut.slice(0, -1); continue }
      // 截断点后是作用于上一字符的修饰符 → 退位（避免拆散 ❤️ / é）；
      // ZWJ 已并入上面删除分支，此处不再按修饰符回退
      const next = s.codePointAt(cut.length)
      if (next !== 0x200D && isModifier(next)) { cut = cut.slice(0, -1); continue }
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
        .replace(HEX_RE, (_, hex) => this._decodeNumeric(Number.parseInt(hex, 16), `&#x${hex};`))
      if (next === str) break
      str = next
    }
    return str
  }
  }

  return Utils
}

module.exports = {
  FILTER_FIELDS,
  trimTrailingSlashes,
  normalize,
  DAY_MS,
  TS_BOUND,
  MAX_CODE_POINT,
  SURROGATE_LO,
  SURROGATE_HI,
  DEFAULT_MAX_SIZE,
  STATE_TEXT_MAX_BYTES,
  MESSAGE_CACHE_MAX_BYTES,
  TOMBSTONE_MAX_KEYS,
  TOMBSTONE_MAX_BYTES,
  TOMBSTONE_LOCK_STALE_MS,
  createUtils
}
