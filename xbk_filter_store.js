/* eslint no-control-regex: off */
'use strict'

// ============================================================
// 🗂️ FilterStore — 过滤规则覆盖文件存储层
//
// 职责边界（规格 §3 / 计划 §3.1）：
//   · 只做「读覆盖文件 → 合并代码默认 → 生效规则」与「校验待保存规则」；
//   · 只做「写/读生效快照」与「审计/锁/备份路径」helper；
//   · **不**读规则于模块加载期（每轮由 App.run 调用 loadFilterRules 一次）；
//   · **不**缓存 activeFilter——模块级状态只有 last-known-good（损坏降级用，按 cacheDir 分槽）；
//   · **不** require xbk_function_v3（会与 xbk_app → FilterStore 形成循环依赖）；
//     RuleEngine / compileUserRegex / RE2 可用性一律由调用方经 deps 注入；
//   · 全程同步、零新依赖；读走 xbk_storage.readSafeTextResult，写走 writeAtomic（原子 + 0600）。
//
// 失败语义：本模块的任何导出都**不 throw**——校验失败返回 {ok:false,errors}，
//   读取失败走 {source:'corrupt',degraded:true} 降级并保留 last-known-good。
//   这是硬约束：loadFilterRules 在每轮 App.run 开头执行，抛穿会杀掉整轮推送。
//
// 覆盖文件形状（schema:1）：
//   { "schema": 1, "revision": <非负整数>, "filter": { <11 字段中任意子集>: "<字符串>" } }
//   缺字段 = 该字段回代码默认（**不是**置空）；显式 "" = 用户明确清空该规则。
//   合并语义依赖「字段是否存在」（hasOwnProperty），故校验结果保留「只含已提交字段」的形状。
// ============================================================

const path = require('path')
const { readSafeTextResult, writeAtomic } = require('./xbk_storage')
// 路径构造单独成模块（纯 path.join + 本文件常量名），见该文件顶部说明。
const { filterRulesPaths } = require('./scripts/filter-rules-paths')

// 字段顺序沿用 xbk_utils.FILTER_FIELDS 的历史顺序（末尾追加 pingbitime），
// 必须与 Config.filter 的键集合完全一致（测试逐元素断言）。
const FILTER_RULE_FIELDS = Object.freeze([
  'pingbifenlei',
  'pingbibiaoti',
  'zhanxianbiaoti',
  'pingbibiaotiplus',
  'pingbineirong',
  'zhanxianneirong',
  'pingbineirongplus',
  'pingbilouzhu',
  'zhanxianlouzhu',
  'pingbilouzhuplus',
  'pingbitime'
])

const FILTER_RULES_SCHEMA = 1
// 单字段正文上限：4000 个 UTF-16 码元（与文档行长闸门的 String.length 口径一致）。
// 覆盖文件整体上限 64 KiB：与 console 的 body 上限同源，避免「能保存但读不回」。
const FILTER_FIELD_MAX_LEN = 4000
const FILTER_RULES_MAX_BYTES = 64 * 1024
// pingbitime 天数上限：与 xbk_rules.compileRules / validateConfig 的 PINGBITIME_MAX_DAYS 同值。
// 超上限的行会被运行期静默丢弃 ⇒ 编译对账必然失败，这里提前给出明确错误码。
const PINGBITIME_MAX_DAYS = 3650000

// 控制字符：允许 \t(09) \n(0A) \r(0D)，其余 C0 与 DEL 一律拒绝。
// （禁止的是把终端控制序列/截断符写进规则正文，不是禁止多行规则。）
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
// 行分隔口径必须与运行期 RuleEngine._splitLines / validateConfig 完全一致（含 <br> 与单独 \r）。
const LINE_SPLIT_RE = /<br\s*\/?>|\r\n|\r|\n/
// 全命中：trim 后等于这两个字面量即视为「放行一切」，console 需二次确认。
const WIDE_MATCH_VALUES = new Set(['.*', '^.*$'])
const FIELD_SET = new Set(FILTER_RULE_FIELDS)

// 进程内 last-known-good：**只**保存最近一次合法覆盖文件的 {filter, revision}，
// 且按 cacheDir 分槽（键 = 覆盖文件所在目录）。一个进程可能读多个缓存目录（测试/控制台/多实例），
// 用单个槽位会让「A 目录的合法规则」在「B 目录损坏」时代入，把 B 的过滤面悄悄改成 A 的（A2）。
// 键取 path.dirname(filterRulesPaths(cacheDir).file)，而不是给 filterRulesPaths 增加 dir 字段——
// 后者被 console/qinglong 共用，为一行取值扩大公共契约不划算。
// 不是 activeFilter 缓存——每轮 loadFilterRules 仍重新读盘、重新合并、返回新对象。
const lastGoodByDir = new Map()

function cacheDirKey (cacheDir) {
  // filterRulesPaths 对非法 cacheDir 已退化为 '.'（不抛错），dirname 恒为字符串。
  return path.dirname(filterRulesPaths(cacheDir).file)
}

function safeGet (obj, key) {
  // 脏对象/Proxy 的抛错 getter 不得抛穿（与 xbk_rules.readField 同口径）。
  try { return obj === null || obj === undefined ? undefined : obj[key] } catch (e) { return undefined }
}

function safeString (value) {
  if (value === undefined || value === null || typeof value === 'symbol') return ''
  try { return String(value) } catch (e) { return '' }
}

function safeErrorMessage (error, fallback = '未知错误') {
  // 不直接读 e.message：它本身可能是会抛的 getter。
  const message = safeGet(error, 'message')
  return typeof message === 'string' && message ? message : fallback
}

function hasOwn (obj, key) {
  try { return Object.prototype.hasOwnProperty.call(obj, key) } catch (e) { return false }
}

function normalizeKeyword (keyword, { forSnapshot = false } = {}) {
  // 规格 §4.1：keyword 只读、v1 不开放写入，但仍随生效规则一起返回，
  // 避免运行侧出现「规则走覆盖、关键词走代码」的分裂。
  const raw = safeGet(keyword, 'zkt_gjc')
  if (raw === undefined || raw === null) return { zkt_gjc: '' }
  // 生效快照是落盘产物，必须可 JSON 化 ⇒ 一律字符串化。
  if (forSnapshot) return { zkt_gjc: safeString(raw) }
  // 运行侧必须保留原始类型：非字符串（对象/数字/布尔）由 App.run 显式告警并跳过「只看它」；
  // 若在此 String 化，对象会变成 '[object Object]' 正则（字符类），静默把全部条目滤掉（R11-1 回归）。
  // 正常配置（字符串）逐字符不变，故这是纯扩大信息量的透传，不改变合法输入的语义。
  return { zkt_gjc: raw }
}

/**
 * 合并生效规则：覆盖文件逐字段覆盖代码默认，缺字段回默认（规格 §4.1 / 计划 §2）。
 * 返回值每轮新建；字符串不可变，故不存在跨轮共享可变引用。
 */
function mergeActiveFilter ({ defaults, keyword, override } = {}) {
  const base = defaults && typeof defaults === 'object' ? defaults : {}
  const over = override && typeof override === 'object' ? override : {}
  const filter = {}
  for (const field of FILTER_RULE_FIELDS) {
    const overValue = safeGet(over, field)
    if (hasOwn(over, field) && typeof overValue === 'string') {
      filter[field] = overValue
    } else {
      filter[field] = safeString(safeGet(base, field))
    }
  }
  return { filter, keyword: normalizeKeyword(keyword) }
}

/**
 * 覆盖文件里「实际存在」的字段（只含白名单内的字符串值）。
 * 与 mergeActiveFilter 的区别：这里**不补代码默认**，只回原文——读面据此告诉前端
 * 「本次没改、但已落盘」的字段，避免整份替换的保存把它们静默删掉。
 * 与 filter 同源（同一次读盘的结果），不得各自再读一遍文件。
 */
function overrideFieldsOf (override) {
  const over = override && typeof override === 'object' ? override : {}
  const out = {}
  for (const field of FILTER_RULE_FIELDS) {
    const value = safeGet(over, field)
    if (hasOwn(over, field) && typeof value === 'string') out[field] = value
  }
  return out
}

function addError (errors, field, code, message) {
  errors.push({ field, code, message })
}

function isValidDays (value) {
  const days = Number(value)
  // 必须是整数：运行期 compileRules 对天数做 Math.floor，保存 1.9 实际按 1 天跑，
  // 「保存值」与「生效值」不一致且无任何告警（A5）。上下限口径不变。
  return Number.isFinite(days) && Number.isInteger(days) && days >= 0 && days <= PINGBITIME_MAX_DAYS
}

function engineAvailable (deps) {
  // 注入形状：deps.re2Available:boolean 或 deps.isRe2Available():boolean（任选其一）。
  // 两者都未声明时按「可用」处理：真正的编译失败仍会由 compileUserRegex 返回 null
  // 并落到 invalid_category_regex / invalid_value_regex（调用方契约要求显式声明）。
  if (typeof deps.isRe2Available === 'function') {
    try { return deps.isRe2Available() === true } catch (e) { return false }
  }
  if (typeof deps.re2Available === 'boolean') return deps.re2Available
  return true
}

function compileOk (deps, source) {
  try { return Boolean(deps.compileUserRegex(source, 'i')) } catch (e) { return false }
}

/**
 * 校验待保存/待预检的过滤规则（四道闸，规格 §3 / 计划 §3.3）。
 *
 * @param {{schema?:number, revision?:number, filter:Object}} input
 *   revision 省略按 0 处理（`/validate` 允许只带 filter）；**显式传 null/''/字符串等非法值一律拒绝**。
 *   filter 只接受 11 个白名单字段的字符串值；未出现的字段不参与覆盖（回代码默认）。
 * @param {{RuleEngine:Object, compileUserRegex:Function, re2Available?:boolean, isRe2Available?:Function}} deps
 * @returns {{ok:true, value:Object, wideMatch:string[]}|{ok:false, errors:Array<{field:string, code:string, message:string}>}}
 */
function validateFilterRules (input, deps) {
  const errors = []
  const engine = deps && deps.RuleEngine
  if (!engine || typeof engine.hasNestedQuantifier !== 'function' || typeof engine.compileRules !== 'function' ||
      typeof (deps && deps.compileUserRegex) !== 'function') {
    return {
      ok: false,
      errors: [{ field: 'filter', code: 'deps_invalid', message: '缺少注入的 RuleEngine.hasNestedQuantifier/compileRules 或 compileUserRegex' }]
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'filter', code: 'invalid_input', message: '请求体必须是对象' }] }
  }

  // ---------- 闸门 1：schema / revision / 字段白名单 / 字符串 / 长度 / 控制字符 ----------
  const schemaRaw = safeGet(input, 'schema')
  if (hasOwn(input, 'schema') && schemaRaw !== undefined && schemaRaw !== FILTER_RULES_SCHEMA) {
    addError(errors, 'schema', 'schema_mismatch', `schema 必须为 ${FILTER_RULES_SCHEMA}（当前 ${safeString(schemaRaw)}）`)
  }
  // revision：缺省=0；显式出现则必须是非负安全整数（空串/null/负值/小数/数字字符串全部拒绝）。
  const revisionRaw = safeGet(input, 'revision')
  if (hasOwn(input, 'revision') && revisionRaw !== undefined) {
    if (!Number.isSafeInteger(revisionRaw) || revisionRaw < 0) {
      addError(errors, 'revision', 'invalid_revision', 'revision 必须是非负整数（空值/字符串/小数均不接受）')
    }
  }
  let rawFilter
  try { rawFilter = input.filter } catch (e) { rawFilter = undefined }
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    addError(errors, 'filter', 'invalid_filter', 'filter 必须是对象')
    return { ok: false, errors }
  }

  const filter = {}
  let filterKeys
  try { filterKeys = Object.keys(rawFilter) } catch (e) { filterKeys = null }
  if (filterKeys === null) {
    addError(errors, 'filter', 'invalid_filter', 'filter 不是可枚举对象')
    return { ok: false, errors }
  }
  for (const field of filterKeys) {
    if (!FIELD_SET.has(field)) {
      addError(errors, field, 'unknown_field', `未知字段「${field}」不允许写入`)
      continue
    }
    const value = safeGet(rawFilter, field)
    if (value === undefined) continue // 与 JSON 语义一致：undefined 视同未提供
    if (typeof value !== 'string') {
      addError(errors, field, 'not_string', `字段「${field}」必须是字符串（当前 ${typeof value}）`)
      continue
    }
    if (value.length > FILTER_FIELD_MAX_LEN) {
      addError(errors, field, 'too_long', `字段「${field}」长度 ${value.length} 超过上限 ${FILTER_FIELD_MAX_LEN}`)
      continue
    }
    if (CONTROL_CHAR_RE.test(value)) {
      addError(errors, field, 'control_char', `字段「${field}」含控制字符（仅允许 \\n \\r \\t）`)
      continue
    }
    filter[field] = value
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 闸门 2：行语法（### 最多两段 / 值不能空 / pingbifenlei 不允许 ###）----------
  const ruleLines = [] // 多行规则的每一有效行：{ field, cat, val }
  const simpleRules = [] // 简单规则：{ field, val }
  const multilineCount = new Map()
  for (const field of FILTER_RULE_FIELDS) {
    if (!hasOwn(filter, field)) continue
    const value = filter[field]
    if (value === '') continue
    if (field === 'pingbifenlei' && value.includes('###')) {
      addError(errors, field, 'multiline_not_supported', 'pingbifenlei 不支持 ### 多行分类语法')
      continue
    }
    if (value.includes('###')) {
      let count = 0
      for (const line of value.split(LINE_SPLIT_RE)) {
        const trimmed = line.trim()
        if (!trimmed) continue // 空行与运行期一致：直接忽略
        const parts = trimmed.split('###')
        if (parts.length > 2) {
          addError(errors, field, 'too_many_segments', `行「${trimmed}」含多个 ###，最多两段（分类###正则）`)
          continue
        }
        if (parts.length < 2) {
          addError(errors, field, 'missing_separator', `行「${trimmed}」缺少 ### 分隔符`)
          continue
        }
        const cat = safeString(parts[0]).trim()
        const val = safeString(parts[1]).trim()
        if (!val) {
          addError(errors, field, 'empty_value', `行「${trimmed}」的正则值为空`)
          continue
        }
        if (field === 'pingbitime' && !isValidDays(val)) {
          addError(errors, field, 'invalid_number', `行「${trimmed}」的天数必须是 0..${PINGBITIME_MAX_DAYS} 的整数`)
          continue
        }
        ruleLines.push({ field, cat, val })
        count++
      }
      multilineCount.set(field, count)
    } else {
      const val = value.trim()
      if (!val) {
        addError(errors, field, 'empty_value', `字段「${field}」为空白字符，等同空值`)
        continue
      }
      if (field === 'pingbitime' && !isValidDays(val)) {
        addError(errors, field, 'invalid_number', `pingbitime 的天数必须是 0..${PINGBITIME_MAX_DAYS} 的整数`)
        continue
      }
      simpleRules.push({ field, val })
    }
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 闸门 3：嵌套量词（ReDoS）+ RE2 可用性 + 正则语法 ----------
  for (const rule of ruleLines) {
    if (rule.cat && engine.hasNestedQuantifier(rule.cat)) {
      addError(errors, rule.field, 'nested_quantifier', `分类正则含嵌套量词：「${rule.cat}」`)
    }
    if (engine.hasNestedQuantifier(rule.val)) {
      addError(errors, rule.field, 'nested_quantifier', `正则含嵌套量词：「${rule.val}」`)
    }
  }
  for (const rule of simpleRules) {
    if (engine.hasNestedQuantifier(rule.val)) {
      addError(errors, rule.field, 'nested_quantifier', `正则含嵌套量词：「${rule.val}」`)
    }
  }
  if (errors.length) return { ok: false, errors }

  // 仅含 pingbitime 的规则不需要 RE2（运行期用 Number 解析天数）——只有真正要编译正则的
  // 目标才触发 engine_unavailable，避免「仅时间规则」在缺 re2 的环境被误拒。
  const hasRegexTarget = simpleRules.some(rule => rule.field !== 'pingbitime') ||
    ruleLines.some(rule => rule.field !== 'pingbitime' || Boolean(rule.cat))
  if (hasRegexTarget && !engineAvailable(deps)) {
    // re2 不可用时**不落盘**（console 映射 503 engine_unavailable）：静默跳过正则会让规则面变宽。
    return { ok: false, errors: [{ field: 'filter', code: 'engine_unavailable', message: 'RE2 不可用，拒绝校验/保存过滤规则' }] }
  }
  for (const rule of ruleLines) {
    if (rule.cat && !compileOk(deps, rule.cat)) {
      addError(errors, rule.field, 'invalid_category_regex', `分类正则无法编译：「${rule.cat}」`)
    }
    if (rule.field !== 'pingbitime' && !compileOk(deps, rule.val)) {
      addError(errors, rule.field, 'invalid_value_regex', `正则无法编译：「${rule.val}」`)
    }
  }
  for (const rule of simpleRules) {
    // C9-010：pingbitime 运行期用 Number 解析天数、不需要正则引擎——闸门 3 的 hasRegexTarget
    // 已为「仅时间规则」放行，这里的编译循环必须同一口径（上方 ruleLines 的循环已有该守卫）。
    // 否则缺 re2 的环境（compileUserRegex 恒 null）会把用户唯一还能用的时间规则判成
    // invalid_value_regex 直接拒掉。
    if (rule.field === 'pingbitime') continue
    if (!compileOk(deps, rule.val)) {
      addError(errors, rule.field, 'invalid_value_regex', `正则无法编译：「${rule.val}」`)
    }
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 闸门 4：编译结果对账（与运行期 compileRules 同源，防口径漂移）----------
  const fullCfg = {}
  for (const field of FILTER_RULE_FIELDS) fullCfg[field] = hasOwn(filter, field) ? filter[field] : ''
  let compiled
  try {
    compiled = engine.compileRules(fullCfg)
  } catch (e) {
    return { ok: false, errors: [{ field: 'filter', code: 'compile_error', message: `规则编译异常：${safeErrorMessage(e)}` }] }
  }
  if (!compiled || typeof compiled !== 'object') {
    return { ok: false, errors: [{ field: 'filter', code: 'compile_mismatch', message: 'compileRules 未返回编译结果对象' }] }
  }
  for (const field of FILTER_RULE_FIELDS) {
    if (!hasOwn(filter, field) || filter[field] === '') continue
    const multi = filter[field].includes('###')
    const expectedType = field === 'pingbitime'
      ? (multi ? 'timeMulti' : 'time')
      : (multi ? 'multi' : 're')
    const node = safeGet(compiled, field)
    const actualType = node && typeof node === 'object' ? safeGet(node, '_type') : null
    if (actualType !== expectedType) {
      addError(errors, field, 'compile_mismatch', `编译结果应为 ${expectedType}，实际 ${safeString(actualType) || 'null'}（该规则会在运行期被跳过）`)
      continue
    }
    if (multi) {
      const rules = safeGet(node, 'rules')
      const expectedCount = multilineCount.get(field) || 0
      if (!Array.isArray(rules) || rules.length !== expectedCount) {
        addError(errors, field, 'compile_mismatch', `多行规则编译出 ${Array.isArray(rules) ? rules.length : 0} 条，有效行数为 ${expectedCount}`)
      }
    }
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 全命中提示：`.*` / `^.*$`（trim 后）----------
  const wideMatch = []
  for (const field of FILTER_RULE_FIELDS) {
    if (field === 'pingbitime' || !hasOwn(filter, field) || filter[field] === '') continue
    if (!filter[field].includes('###')) {
      if (WIDE_MATCH_VALUES.has(filter[field].trim())) wideMatch.push(field)
      continue
    }
    // 多行的某一行全命中同样意味着「该分类下放行一切」，一并提示。
    if (ruleLines.some(rule => rule.field === field && WIDE_MATCH_VALUES.has(rule.val))) wideMatch.push(field)
  }

  return { ok: true, value: filter, wideMatch }
}

function parseStoredRules (text) {
  // 覆盖文件的**结构**校验（与用户输入的四道闸分开）：JSON / schema / revision / 字段白名单 /
  // 字符串 / 长度 / 控制字符。刻意不做正则编译与嵌套量词检查——那需要 RE2，且读路径必须
  // 在缺依赖时仍可用（否则一次缺 re2 就会把**合法**覆盖文件判成损坏并降级）。
  let data
  try { data = JSON.parse(text) } catch (e) {
    return { ok: false, message: '覆盖文件不是合法 JSON' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: '覆盖文件根节点必须是对象' }
  }
  if (data.schema !== FILTER_RULES_SCHEMA) {
    return { ok: false, message: `覆盖文件 schema 必须为 ${FILTER_RULES_SCHEMA}` }
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) {
    return { ok: false, message: '覆盖文件 revision 必须是非负整数' }
  }
  const rawFilter = data.filter
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    return { ok: false, message: '覆盖文件 filter 必须是对象' }
  }
  let keys
  try { keys = Object.keys(rawFilter) } catch (e) { keys = null }
  if (keys === null) return { ok: false, message: '覆盖文件 filter 不是可枚举对象' }
  const filter = {}
  for (const field of keys) {
    if (!FIELD_SET.has(field)) return { ok: false, message: `覆盖文件含未知字段「${field}」` }
    const value = safeGet(rawFilter, field)
    if (typeof value !== 'string') return { ok: false, message: `覆盖文件字段「${field}」必须是字符串` }
    if (value.length > FILTER_FIELD_MAX_LEN) return { ok: false, message: `覆盖文件字段「${field}」超长` }
    if (CONTROL_CHAR_RE.test(value)) return { ok: false, message: `覆盖文件字段「${field}」含控制字符` }
    filter[field] = value
  }
  return { ok: true, filter, revision: data.revision }
}

/**
 * 覆盖文件权限收紧：覆盖文件由外部工具/手工创建时可能带 group/other 位，
 * 读取时装作遵守 0600 会让「同机其他用户可写你的过滤规则」变成无声事实（A3）。
 * 有宽位就先收紧到 0600；收紧失败按损坏处理（不改用一份权限不可控的规则）。
 * 实现放在 scripts/owner-only-mode.js：Semgrep 对非字面量路径的 fs 调用一律报
 * path-traversal，单独成模块后可只排除该模块（不整文件排除本模块）。
 */
const { enforceOwnerOnlyMode } = require('./scripts/owner-only-mode.js')

/**
 * 读路径是否具备「深度校验」条件：需要注入完整 deps 且引擎可用。
 * 缺 RE2 时 compileUserRegex 恒返回 null，深校验会把**合法**文件全部判损坏；
 * 读路径的既有契约是「缺依赖也能读合法文件」，故引擎不可用直接跳过（A1）。
 */
function canDeepValidate (deps) {
  if (!deps || typeof deps !== 'object') return false
  const engine = deps.RuleEngine
  if (!engine || typeof engine.hasNestedQuantifier !== 'function' || typeof engine.compileRules !== 'function') return false
  if (typeof deps.compileUserRegex !== 'function') return false
  return engineAvailable(deps) === true
}

/**
 * 对「结构已合法」的覆盖文件再做一次四道闸校验（A1）。
 * 结构校验只证明形状合法：手工编辑写入的非法正则/嵌套量词会被运行期 compileRules 静默跳过，
 * 而 App.run 仍推进 filter.hash 并清 _f ⇒ 被过滤记录被补推且无任何损坏告警。
 * @returns {string|null} 失败描述（首条错误的 field+message），通过返回 null
 */
function deepValidationError (parsed, deps) {
  if (!canDeepValidate(deps)) return null
  const result = validateFilterRules({
    schema: FILTER_RULES_SCHEMA,
    revision: parsed.revision,
    filter: parsed.filter
  }, deps)
  if (result && result.ok === true) return null
  const first = result && Array.isArray(result.errors) ? result.errors[0] : null
  const field = first ? safeString(safeGet(first, 'field')) : ''
  const detail = first ? safeString(safeGet(first, 'message')) : ''
  if (!field && !detail) return '覆盖文件规则深度校验失败'
  return `覆盖文件规则深度校验失败（${field || 'filter'}：${detail || '未知原因'}）`
}

function corruptResult (defaults, keyword, message, key) {
  // 损坏降级：优先本目录的 last-known-good；只有「本进程从未在该目录成功读过合法文件」才回代码默认。
  // 两种情形都标记 degraded:true + source:'corrupt'，由运行侧做三处告警并跳过 _f 清理/hash 推进。
  const lastGood = key === undefined ? null : lastGoodByDir.get(key)
  if (lastGood) {
    const merged = mergeActiveFilter({ defaults, keyword, override: lastGood.filter })
    return {
      ...merged,
      // 文件本身不可用：读面不得拿 last-known-good 冒充「文件里有的字段」。
      override: {},
      source: 'corrupt',
      revision: lastGood.revision,
      degraded: true,
      lastGoodUsed: true,
      error: { code: 'store_corrupt', message }
    }
  }
  const merged = mergeActiveFilter({ defaults, keyword })
  return {
    ...merged,
    override: {},
    source: 'corrupt',
    revision: 0,
    degraded: true,
    lastGoodUsed: false,
    error: { code: 'store_corrupt', message }
  }
}

function loadFilterRulesImpl ({ cacheDir, defaults, keyword, deps }) {
  const paths = filterRulesPaths(cacheDir)
  const key = path.dirname(paths.file)
  // 明确上限：覆盖文件是外部可编辑的输入，禁止无界整读（64 KiB 与 console body 上限同源）。
  const read = readSafeTextResult(paths.file, FILTER_RULES_MAX_BYTES)
  if (read.status === 'missing') {
    // 文件被删除 = 用户恢复代码默认：本目录的 last-known-good 随之作废。
    // 否则「删文件 → 之后又出现畸形文件」会把早已废弃的旧规则复活成生效规则（A4）。
    lastGoodByDir.delete(key)
    const merged = mergeActiveFilter({ defaults, keyword })
    return { ...merged, override: {}, source: 'default', revision: 0, degraded: false, lastGoodUsed: false }
  }
  if (read.status !== 'ok') {
    // unsafe / replaced / tooLarge / ioError：全部按损坏处理（安全读已保证不泄露非普通文件内容）。
    return corruptResult(defaults, keyword, `覆盖文件不可读（${read.status}）`, key)
  }
  const modeCheck = enforceOwnerOnlyMode(paths.file)
  if (!modeCheck.ok) return corruptResult(defaults, keyword, modeCheck.message, key)
  const parsed = parseStoredRules(read.text)
  if (!parsed.ok) return corruptResult(defaults, keyword, parsed.message, key)
  const deepError = deepValidationError(parsed, deps)
  if (deepError) return corruptResult(defaults, keyword, deepError, key)

  // 只有通过（结构 + 可选深度）校验的文件才更新本目录的 last-known-good；损坏读绝不覆盖它。
  lastGoodByDir.set(key, { filter: { ...parsed.filter }, revision: parsed.revision })
  const merged = mergeActiveFilter({ defaults, keyword, override: parsed.filter })
  return {
    ...merged,
    // 与 filter 同源（同一份 parsed.filter）：读面两者必须描述同一次读盘的快照。
    override: overrideFieldsOf(parsed.filter),
    source: 'override',
    revision: parsed.revision,
    degraded: false,
    lastGoodUsed: false
  }
}

/**
 * 读取覆盖文件并返回本轮的生效规则（每轮 App.run 开头调用一次）。
 * 任何异常都不得抛穿；文件不存在 → source:'default'、revision:0、filter 为代码默认深拷贝。
 * @param {{cacheDir:string, defaults:Object, keyword:Object,
 *   deps?:{RuleEngine:Object, compileUserRegex:Function, re2Available?:boolean, isRe2Available?:Function}}} options
 *   deps 可选：提供且引擎可用时，读路径在结构校验之后再跑 validateFilterRules 的四道闸（A1）；
 *   不提供时保持「只做结构校验」的既有契约（console/qinglong 等调用方无需改造）。
 * @returns {{filter:Object, override:Object, keyword:{zkt_gjc:string}, source:'override'|'default'|'corrupt',
 *   revision:number, degraded:boolean, lastGoodUsed:boolean, error?:{code:string,message:string}}}
 *   filter = 代码默认 + 覆盖的合并值；override = 覆盖文件里**实际存在**的字段（不补默认，
 *   无文件/损坏时为 {}），读面用它避免「整份替换保存」删掉未改动字段。
 */
function loadFilterRules (options) {
  const opts = options && typeof options === 'object' ? options : {}
  const key = cacheDirKey(opts.cacheDir)
  try {
    return loadFilterRulesImpl({
      cacheDir: opts.cacheDir,
      defaults: opts.defaults,
      keyword: opts.keyword,
      deps: opts.deps
    })
  } catch (e) {
    // 兜底：读盘/解析/合并的任何未预期异常都收敛成降级结果（绝不杀整轮 run）。
    return corruptResult(opts.defaults, opts.keyword, `覆盖文件读取异常：${safeErrorMessage(e)}`, key)
  }
}

/**
 * 写生效快照 <cacheDir>/filter-rules.applied.json（0600 由 writeAtomic 保证）。
 * 快照是诊断/验收用：证明「本轮实际生效的是哪一版规则」，不参与规则读取。
 * @returns {boolean} 写入是否成功（失败只返回 false，不抛错）
 */
function writeAppliedSnapshot ({ cacheDir, filter, keyword, revision, source, hash } = {}) {
  const paths = filterRulesPaths(cacheDir)
  const snapshotFilter = {}
  for (const field of FILTER_RULE_FIELDS) snapshotFilter[field] = safeString(safeGet(filter, field))
  const snapshot = {
    schema: FILTER_RULES_SCHEMA,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    source: source === 'override' || source === 'corrupt' ? source : 'default',
    hash: safeString(hash),
    appliedAt: new Date().toISOString(),
    filter: snapshotFilter,
    keyword: normalizeKeyword(keyword, { forSnapshot: true })
  }
  return writeAtomic(paths.applied, JSON.stringify(snapshot), '过滤规则生效快照')
}

/**
 * 读回生效快照。状态机：missing / invalid / ioError / ok（不抛错）。
 * @returns {{status:'ok',snapshot:Object}|{status:'missing'}|{status:'invalid',error:Object}|{status:'ioError',error:Object}}
 */
function readAppliedSnapshot (cacheDir) {
  let read
  try {
    read = readSafeTextResult(filterRulesPaths(cacheDir).applied, FILTER_RULES_MAX_BYTES)
  } catch (e) {
    return { status: 'ioError', error: { code: 'read_failed', message: safeErrorMessage(e) } }
  }
  if (read.status === 'missing') return { status: 'missing' }
  if (read.status !== 'ok') {
    return { status: 'ioError', error: { code: read.status, message: `生效快照不可读（${read.status}）` } }
  }
  let snapshot
  try { snapshot = JSON.parse(read.text) } catch (e) {
    return { status: 'invalid', error: { code: 'invalid_json', message: '生效快照不是合法 JSON' } }
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照根节点必须是对象' } }
  }
  if (snapshot.schema !== FILTER_RULES_SCHEMA) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: `生效快照 schema 必须为 ${FILTER_RULES_SCHEMA}` } }
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 revision 必须是非负整数' } }
  }
  if (typeof snapshot.appliedAt !== 'string' || snapshot.appliedAt === '') {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照缺少 appliedAt' } }
  }
  if (!snapshot.filter || typeof snapshot.filter !== 'object' || Array.isArray(snapshot.filter)) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 filter 必须是对象' } }
  }
  if (!snapshot.keyword || typeof snapshot.keyword !== 'object' || Array.isArray(snapshot.keyword)) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 keyword 必须是对象' } }
  }
  return { status: 'ok', snapshot }
}

// 仅测试：清空进程内 last-known-good（全部 cacheDir 槽位）。生产代码不得调用（每轮 run 由真实读盘决定）。
function resetStoreStateForTests () {
  lastGoodByDir.clear()
}

module.exports = {
  FILTER_RULE_FIELDS,
  FILTER_RULES_SCHEMA,
  filterRulesPaths,
  validateFilterRules,
  mergeActiveFilter,
  loadFilterRules,
  writeAppliedSnapshot,
  readAppliedSnapshot,
  resetStoreStateForTests
}
