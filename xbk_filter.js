'use strict'

// FilterEngine extracted verbatim from xbk_function_v3.js; integration remains the main entrypoint's responsibility.
/* eslint indent: off */
let RE2C = null
try { RE2C = require('re2') } catch (e) { RE2C = null }
function compileUserRegex (source, flags = 'i') {
  if (typeof source !== 'string' || !RE2C) return null
  try { return new RE2C(source, flags) } catch (e) { return null }
}

function createFilterEngine ({ Utils, RuleEngine, FILTER_FIELDS }) {
  if (!Utils || !RuleEngine || !Array.isArray(FILTER_FIELDS)) throw new TypeError('createFilterEngine requires Utils, RuleEngine, and FILTER_FIELDS')

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
      parts.push([f, typeof v, safeStr(v)])
    }
    let pb
    try { pb = rawCfg && rawCfg.pingbitime } catch (e) { pb = undefined }
    parts.push(['pingbitime', typeof pb, safeStr(pb)])
    return JSON.stringify(parts)
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
      // P2（审查 2026-08-15）：真值判定会把 0/false 当「字段缺失」跳过匹配，与 matchesCompiled
      // C013 契约（0/false 为有效值、参与匹配）分裂——统一为仅 undefined/null/空串视为缺失。
      if (stage.showCfg && val !== undefined && val !== null && val !== '') {
        if (RuleEngine.matchesCompiled(stage.showCfg, val, Utils.safeGet(group, 'catename'))) {
          showFlags[stage.key] = true
        }
      }
    }

    // 第二轮：屏蔽 + 强化屏蔽
    for (const stage of fieldStages) {
      const val = stage.getVal(group)
      // P2（同上）：0/false 是有效字段值，参与屏蔽/强化屏蔽匹配
      if (val === undefined || val === null || val === '') continue
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
     * 过滤决策解释：与 listfilter 共用同一编译规则和优先级，供日志/审计使用。
     * reason 表示首个实际拦截原因；protections 表示命中的强制展现；
     * skipped 表示因更高优先级保护而未执行的后续屏蔽规则。
     */
  explainFilter (group, cfg, rawCfg = null) {
    const passed = { passed: true, reason: null, protections: [], skipped: [] }
    if (!group || !cfg) return passed
    const blocked = (reason) => ({ ...passed, passed: false, reason, protections: [], skipped: [] })
    if (!cfg.__compiled) {
      let compiled
      try {
        compiled = RuleEngine.compileRules(cfg)
      } catch (e) {
        console.warn('⚠️ 过滤规则编译失败，已保守放行')
        return passed
      }
      return this.explainFilter(group, compiled, cfg)
    }
    const sourceOf = (key, matchedRule = null) => {
      try {
        if (matchedRule && typeof matchedRule.source === 'string') return matchedRule.source
        const rawValue = rawCfg && rawCfg[key]
        if (typeof rawValue === 'string') return rawValue
        const compiledValue = cfg[key]
        return compiledValue && typeof compiledValue.source === 'string' ? compiledValue.source : ''
      } catch (e) { return '' }
    }
    const reason = (stage, kind, configKey, detail = {}) => {
      const { matchedRule, ...rest } = detail
      return { stage, kind, configKey, rule: sourceOf(configKey, matchedRule), ...rest }
    }
    const matchedRule = (compiled, value, catename) => {
      if (!compiled || compiled._type !== 'multi') return null
      let text
      try { text = typeof value === 'string' ? value : String(value) } catch (e) { return null }
      return RuleEngine._firstMatchingRule(compiled.rules, catename, rule => rule.val && rule.val.test(RuleEngine._normalizeReInput(text)))
    }
    const timeMatchedRule = (compiled, group) => {
      if (!compiled || compiled._type !== 'timeMulti') return null
      const ms = Utils.parseTime(Utils.safeGet(group, 'louzhuregtime'))
      if (ms === null) return null
      const days = Utils.daysFrom(ms)
      return RuleEngine._firstMatchingRule(compiled.rules, Utils.safeGet(group, 'catename'), rule => days < rule.value)
    }

    const regTime = Utils.safeGet(group, 'louzhuregtime')
    const timeRule = cfg.pingbitime
    if (timeRule && regTime !== undefined && regTime !== null && regTime !== '' && RuleEngine.checkTimeCompiled(timeRule, group)) {
      return blocked(reason('time', 'block', 'pingbitime', { matchedRule: timeMatchedRule(timeRule, group) }))
    }

    const category = Utils.safeGet(group, 'catename')
    if (cfg.pingbifenlei && category !== undefined && category !== null && category !== '' &&
      RuleEngine.matchesCompiled(cfg.pingbifenlei, category, category)) {
      return blocked(reason('category', 'block', 'pingbifenlei', { matchedRule: matchedRule(cfg.pingbifenlei, category, category) }))
    }

    const stages = [
      { key: 'louzhu', label: 'louzhu', getVal: (g) => Utils.safeGet(g, 'louzhu'), showKey: 'zhanxianlouzhu', blockKey: 'pingbilouzhu', plusKey: 'pingbilouzhuplus', blockedBy: [] },
      { key: 'title', label: 'title', getVal: (g) => Utils.safeGet(g, 'title'), showKey: 'zhanxianbiaoti', blockKey: 'pingbibiaoti', plusKey: 'pingbibiaotiplus', blockedBy: ['louzhu'] },
      { key: 'content', label: 'content', getVal: (g) => Utils.safeGet(g, 'content'), showKey: 'zhanxianneirong', blockKey: 'pingbineirong', plusKey: 'pingbineirongplus', blockedBy: ['louzhu', 'title'] }
    ]
    const showFlags = {}
    const showMatched = {}
    for (const stage of stages) {
      const value = stage.getVal(group)
      const rule = matchedRule(cfg[stage.showKey], value, category)
      if (cfg[stage.showKey] && value !== undefined && value !== null && value !== '' &&
        RuleEngine.matchesCompiled(cfg[stage.showKey], value, category)) {
        showFlags[stage.key] = true
        showMatched[stage.key] = true
        passed.protections.push(reason(stage.label, 'show', stage.showKey, { matchedRule: rule }))
      }
    }

    for (const stage of stages) {
      const value = stage.getVal(group)
      if (value === undefined || value === null || value === '') continue
      const protectedBy = stage.blockedBy.find(key => showFlags[key])
      if (protectedBy) {
        for (const configKey of [stage.blockKey, stage.plusKey]) {
          if (cfg[configKey]) passed.skipped.push(reason(stage.label, 'skipped', configKey, { because: `${protectedBy}.show` }))
        }
        continue
      }
      if (cfg[stage.blockKey] && !showFlags[stage.key] && RuleEngine.matchesCompiled(cfg[stage.blockKey], value, category)) {
        return blocked(reason(stage.label, 'block', stage.blockKey, { matchedRule: matchedRule(cfg[stage.blockKey], value, category) }))
      }
      if (cfg[stage.plusKey] && RuleEngine.matchesCompiled(cfg[stage.plusKey], value, category)) {
        if (showMatched[stage.key]) {
          showFlags[stage.key] = false
          passed.protections = passed.protections.filter(entry => entry.configKey !== stage.showKey)
        }
        return blocked(reason(stage.label, 'plus', stage.plusKey, { matchedRule: matchedRule(cfg[stage.plusKey], value, category) }))
      }
      if (showFlags[stage.key] && cfg[stage.blockKey]) {
        passed.skipped.push(reason(stage.label, 'skipped', stage.blockKey, { because: `${stage.key}.show` }))
      }
    }
    return passed
  },

  /**
     * 主过滤函数
     * 接受编译后的规则（推荐）或原始字符串配置（兼容旧调用）
     */
  listfilter (group, cfg) {
    if (!group || !cfg) return true
    if (!cfg.__compiled) return this._legacyListfilter(group, cfg)
    return this.explainFilter(group, cfg).passed
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
    // 非字符串 keyword（对象/数字/布尔/函数/undefined/null）→ 全部放行（与 App.run 告警跳过一致）
    if (typeof keyword !== 'string') return true
    // 空/空白关键词 = 全部通过（最优先——与历史语义一致；v3.108 安全 String 化）
    if (keyword === '') return true
    let kwStr
    try { kwStr = String(keyword) } catch (e) { return true } // 嵌套 Symbol 数组 String() 崩 → 放行
    if (kwStr.trim() === '') return true
    if (!item) return false // 防御：item 缺失 = 不匹配
    const value = Utils.safeGet(item, field)
    // 仅 undefined/null/空串视为「字段缺失」→ 不参与白名单匹配但也不拦截（与 App.run 只看它保留空标题口径一致）；
    // 0/false 等已定义值作为有效内容参与匹配，修复 0 被 if(!value) 短路误判不匹配（0 应可被关键词 '0' 命中）。
    if (value === undefined || value === null || value === '') return true
    if (RuleEngine.hasNestedQuantifier(kwStr)) return true // ReDoS 防护：风险关键词不执行匹配，全部放行（与非法正则口径一致）
    // v3.239：正则编译缓存（过滤热路径，每条消息 × 每个字段都调 whitelistFilter，避免重复 new RegExp）
    let re = this._whitelistReCache.get(kwStr)
    if (re === undefined) {
      try {
        re = compileUserRegex(kwStr, 'i')
      } catch (e) {
        re = null // 非法正则缓存 null，避免每次重建；语义与下方一致
      }
      this._whitelistReCache.set(kwStr, re)
      // 超限淘汰最旧键，防动态 keyword 无限增长
      if (this._whitelistReCache.size > this._WHITELIST_RE_CACHE_MAX) {
        this._whitelistReCache.delete(this._whitelistReCache.keys().next().value)
      }
    }
    if (re === null) return true // 缺少 RE2 或非法正则：放行（宁可多推不可少推）
    // ReDoS 纵深防御：与 matchesCompiled 同口径，超长输入先截断再 .test()——即使关键词含
    // 未被子嵌套量词检测覆盖的慢回溯形态（交替/前视/大字符类 × 超长输入），单次匹配最坏耗时也有界。
    // v3.249：超长 keyword 的 V8 会把正则编译推迟到首次 .test()，此时抛 "Regular expression too
    // large"（new RegExp 不抛）——test 也需 try/catch，失败按放行处理（宁可多推不可少推）。
    try {
      return re.test(RuleEngine._normalizeReInput(typeof value === 'string' ? value : Utils.safeText(value, '')))
    } catch (e) { return true }
  }
  }
  return FilterEngine
}

module.exports = { createFilterEngine }
