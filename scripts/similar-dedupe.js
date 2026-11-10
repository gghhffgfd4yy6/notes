'use strict'

// 近似去重（v3.397 起，v3.399 收紧）：同一楼主把一句话改几个字重发（如「如果出现负数就跑吧」→「负数就跑」），
// 帖子 ID、URL、标题精确去重都拦不住。这里用开源库 fuzzball（fuzzywuzzy 的 JS 移植）做标题相似度，
// 时间窗内相似度达到阈值即视为重复；正文只在标题中等相似时做二次确认。
//
// 为什么不用 SimHash：短标题特征太少，实测这一对重复帖 SimHash 汉明距离 15/64，常规阈值 ≤3 抓不到。
// 为什么是 fuzzball：字符级 ratio 对中文标题直接可用（实测重复对 0.800、不相关 0.000），
// 且是纯 CJS、无原生依赖。

const fuzz = require('fuzzball')

// v3.399：窗口保持 10 分钟。真正会吞掉「同款二次好价」的是价格差异，不是时间——价格护栏已经挡住降价/改价，
// 同价重复即使隔 5~10 分钟也还是同一条线报，缩窗口只会漏拦（评审：5 分钟会让 5~10 分钟内的重复重新推一遍）
const WINDOW_MS = 10 * 60 * 1000
const THRESHOLD = 0.78 // 实测重复对 0.80，不相关 0.00
const CONTENT_THRESHOLD = 0.95 // 正文二次确认阈值：正文几乎一字不差
const CONTENT_TITLE_MIN = 0.5 // 正文确认的前提：标题至少中等相似（防止同一模板套不同商品的误判）
const MAX_ENTRIES = 300 // 上限，防止缓存文件无限增长
const MIN_LEN = 10 // 归一化后短于 10 字的标题不参与近似判重（短标题特征少、极易误判）
const CONTENT_MAX_LEN = 200 // 正文只留前 200 字，够判模板/口令，也控住缓存体积

// 标题归一化：去空白/标点/符号、统一小写、截断到 120 字
function normalizeTitle (title) {
  if (typeof title !== 'string') return ''
  return title.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase().slice(0, 120)
}

// 正文归一化：先去掉链接/邮箱（模板里最常见的相同片段），再去标点空白、小写、截 200 字
function normalizeContent (content) {
  if (typeof content !== 'string') return ''
  return content
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
    .slice(0, CONTENT_MAX_LEN)
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
  // 先整体去空白、统一各种连字符，再匹配；正则里不带 \s*（避免 Sonar 的 super-linear 回溯告警）。
  // 同时认「满1000减150」与「1000-150」两种写法（含全角/长破折号）。
  const compact = String(text).replace(/\s+/g, '').replace(/[–—－]/g, '-')
  const out = []
  const re = /满?(\d+)减(\d+)|(\d+)-(\d+)/g
  let m = re.exec(compact)
  while (m !== null) {
    out.push(m[1] !== undefined ? `${m[1]}-${m[2]}` : `${m[3]}-${m[4]}`)
    m = re.exec(compact)
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')
}

// 价格签名（如 59.9元、19.9r、5块）：两边都写了价格且不同 → 是不同报价（常见于降价/改价），不能判重
function priceSignature (text) {
  const out = []
  const re = /(\d+(?:\.\d+)?)\s*(?:元|r|R|块)/g
  let m = re.exec(String(text))
  while (m !== null) {
    out.push(Number(m[1]))
    m = re.exec(String(text))
  }
  const uniq = [...new Set(out.filter(n => Number.isFinite(n)))].sort((a, b) => a - b)
  return uniq.join(',')
}

// v3.410：与时间窗内已推内容近似重复时返回**命中的那一条** recent 条目（含 t/p/c/x 等字段），
// 未命中返回 null。判定逻辑就是原来 isSimilarTitle 的那一份，一个字都没改——新增这个入口只为
// 「拦了哪两条」留痕（见 xbk_app.js 的 similar-blocked.ndjson），不参与任何判定口径。
function findSimilarTitle (title, entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : WINDOW_MS
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : THRESHOLD
  const key = normalizeTitle(title)
  if (!key || key.length < MIN_LEN) return null
  const keyCoupon = couponRange(title)
  const keyPrice = priceSignature(title)
  const keyContent = normalizeContent(opts.content)
  const recent = pruneRecent(entries, now, windowMs)
  for (const e of recent) {
    if (e.t.length < MIN_LEN) continue
    // 档位冲突直接不判重：实测「1000-150有价券」与「斯凯奇1000-120有价券」相似度 0.81，
    // 但它们是不同面额的券；只有两边都写了档位且不同才排除，避免漏掉「带价格/不带价格」的真重复
    const otherCoupon = typeof e.c === 'string' ? e.c : ''
    if (keyCoupon && otherCoupon && keyCoupon !== otherCoupon) continue
    // 价格冲突同理：两边都写了价格且不同（59.9 vs 49.9），更可能是降价/改价，宁可再推一次
    const otherPrice = typeof e.p === 'string' ? e.p : ''
    if (keyPrice && otherPrice && keyPrice !== otherPrice) continue
    const titleScore = similarity(key, e.t)
    if (titleScore >= threshold) return e
    // 正文二次确认：标题中等相似 + 正文几乎一致（文字游戏式改写，标题相似度会漏）
    if (keyContent && typeof e.x === 'string' && e.x && titleScore >= CONTENT_TITLE_MIN && similarity(keyContent, e.x) >= CONTENT_THRESHOLD) return e
  }
  return null
}

// 是否与时间窗内已推内容近似重复。opts.content 可选：标题不够像时用正文二次确认。
// v3.410：改为 `findSimilarTitle(...) !== null`——同一份匹配逻辑，结论逐字节等价。
function isSimilarTitle (title, entries, opts = {}) {
  return findSimilarTitle(title, entries, opts) !== null
}

// 追加一条已推标题（可选正文），返回新数组（不修改入参）
function appendRecent (entries, title, now, content) {
  const at = Number.isFinite(now) ? now : Date.now()
  const key = normalizeTitle(title)
  const list = pruneRecent(entries, at)
  // 短标题不会被 isSimilarTitle 比较，存进来只会挤占上限、把有用历史顶掉
  if (!key || key.length < MIN_LEN) return list
  return list.concat([{
    t: key,
    at,
    c: couponRange(title), // 满减/券档位（原始标题上提取，归一化会去掉连字符）
    p: priceSignature(title), // 价格签名
    x: normalizeContent(content) // 正文摘要（前 200 字）
  }]).slice(-MAX_ENTRIES)
}

module.exports = {
  WINDOW_MS,
  THRESHOLD,
  CONTENT_THRESHOLD,
  CONTENT_TITLE_MIN,
  MAX_ENTRIES,
  MIN_LEN,
  normalizeTitle,
  normalizeContent,
  couponRange,
  priceSignature,
  similarity,
  pruneRecent,
  findSimilarTitle,
  isSimilarTitle,
  appendRecent
}
