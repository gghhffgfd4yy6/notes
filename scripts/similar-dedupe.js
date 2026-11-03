'use strict'

// v3.397 近似去重：同一楼主/不同楼主把一句话改几个字重发（如「如果出现负数就跑吧」→「负数就跑」），
// 帖子 ID、URL、标题精确去重都拦不住。这里用开源库 fuzzball（fuzzywuzzy 的 JS 移植）做标题相似度，
// 时间窗内相似度达到阈值即视为重复。
//
// 为什么不用 SimHash：短标题特征太少，实测这一对重复帖 SimHash 汉明距离 15/64，常规阈值 ≤3 抓不到。
// 为什么是 fuzzball：字符级 ratio 对中文标题直接可用（实测重复对 0.800、不相关 0.000、
// 同商品不同价 0.79~0.88），且是纯 CJS、无原生依赖。

const fuzz = require('fuzzball')

const WINDOW_MS = 10 * 60 * 1000 // 只看最近 10 分钟推过的标题
const THRESHOLD = 0.78 // 实测重复对 0.80，不相关 0.00；阈值低到 0.78 会多判同商品不同价
const MAX_ENTRIES = 300 // 上限，防止缓存文件无限增长
const MIN_LEN = 10 // 归一化后短于 10 字的标题不参与近似判重（短标题特征少、极易误判）

// 归一化：去空白/标点/符号、统一小写、截断到 120 字（超长正文式标题尾部对相似度贡献很低）
function normalizeTitle (title) {
  if (typeof title !== 'string') return ''
  return title.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase().slice(0, 120)
}

// 0~1 的相似度；任一侧为空返回 0（避免空串互判重复）
function similarity (a, b) {
  if (!a || !b) return 0
  return fuzz.ratio(a, b) / 100
}

// 丢掉过期与非法条目，保留最近 MAX_ENTRIES 条
function pruneRecent (entries, now, windowMs = WINDOW_MS) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter(e => e && typeof e.t === 'string' && e.t !== '' && Number.isFinite(e.at) && Math.abs(now - e.at) <= windowMs)
    .slice(-MAX_ENTRIES)
}

// 满减/券档位（如 1000-150、200-20）：两边都有但档位不同，说明是不同活动/不同券，不能判重
function couponRange (text) {
  const m = String(text).match(/\d+\s*-\s*\d+/g)
  return m ? m.map(x => x.replace(/\s+/g, '')).sort().join(',') : ''
}

// 是否与时间窗内已推标题近似重复
function isSimilarTitle (title, entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_MS
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : THRESHOLD
  const key = normalizeTitle(title)
  if (!key || key.length < MIN_LEN) return false
  const keyCoupon = couponRange(title)
  const recent = pruneRecent(entries, now, windowMs)
  return recent.some(e => {
    if (e.t.length < MIN_LEN) return false
    // 档位冲突直接不判重：实测「1000-150有价券」与「斯凯奇1000-120有价券」相似度 0.81，
    // 但它们是不同面额的券；只有两边都写了档位且不同才排除，避免漏掉「带价格/不带价格」的真重复
    const otherCoupon = typeof e.c === 'string' ? e.c : ''
    if (keyCoupon && otherCoupon && keyCoupon !== otherCoupon) return false
    return similarity(key, e.t) >= threshold
  })
}

// 追加一条已推标题，返回新数组（不修改入参）
function appendRecent (entries, title, now) {
  const at = Number.isFinite(now) ? now : Date.now()
  const key = normalizeTitle(title)
  const list = pruneRecent(entries, at)
  // 短标题不会被 isSimilarTitle 比较，存进来只会挤占 300 条上限、把有用历史顶掉
  if (!key || key.length < MIN_LEN) return list
  // c = 满减/券档位（原始标题上提取，归一化会去掉连字符）
  return list.concat([{ t: key, at, c: couponRange(title) }]).slice(-MAX_ENTRIES)
}

module.exports = {
  WINDOW_MS,
  THRESHOLD,
  MAX_ENTRIES,
  MIN_LEN,
  normalizeTitle,
  couponRange,
  similarity,
  pruneRecent,
  isSimilarTitle,
  appendRecent
}
