'use strict'

/* eslint indent: off */
function createFilterEngine ({ Utils, RuleEngine, FILTER_FIELDS, compileUserRegex }) {
  if (!Utils || !RuleEngine || !Array.isArray(FILTER_FIELDS) || typeof compileUserRegex !== 'function') throw new TypeError('createFilterEngine requires Utils, RuleEngine, FILTER_FIELDS, and compileUserRegex')

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
  /** 缺字段保守放行统一：compiled/group 缺失或字段缺失 → true；否则取反执行检查
   *  参数形状：compiled 为 compileRules 产出的字段级规则对象；allowedTypes 由调用方给出该字段
   *  合法的判别式集合（分类用 re/multi，天数用 time/timeMulti），载荷字段按判别式固定。 */
  _passIfMissing (group, field, compiled, checkFn, allowedTypes) {
    if (!compiled || !group) return true
    // FILTER-03：形状守卫——只接受 compileRules 产出的**匹配本调用方**的字段级规则。
    // 传原始配置/错形状参数时下游 matchesCompiled/checkTimeCompiled 会静默返回「不拦截」，
    // 与同级入口 :131/:231/:246 的 __compiled 守卫口径分裂；此处显式告警后保守放行（合法输入行为不变）。
    // CodeRabbit PR #147：只判 `typeof _type === 'string'` 太宽——把 time/timeMulti 形状误传给分类检查
    // （或反之）时下游返回 false、本函数取反成 true，会**静默全放行且无告警**；故按调用方给的
    // allowedTypes 校验判别式，并要求对应载荷字段存在（re→re / time→value / multi|timeMulti→rules）。
    let ruleShape = false
    try {
      // 注意：本函数开头已有 `if (!compiled || !group) return true`，故此处 compiled 必为真值，
      // 不需要也不能再写 `compiled !== null`（恒真——CodeQL 会报 "Comparison between inconvertible types"）。
      const type = typeof compiled === 'object' ? compiled._type : null
      const payloadKey = type === 're' ? 're' : type === 'time' ? 'value' : (type === 'multi' || type === 'timeMulti') ? 'rules' : null
      ruleShape = typeof type === 'string' && payloadKey !== null &&
        (allowedTypes === undefined || allowedTypes.includes(type)) &&
        compiled[payloadKey] !== undefined && compiled[payloadKey] !== null
    } catch (e) { ruleShape = false }
    if (!ruleShape) {
      console.warn('⚠️ 过滤检查收到与本调用方不匹配或缺载荷的规则对象（应为 compileRules 产物），已保守放行')
      return true
    }
    const v = Utils.safeGet(group, field)
    if (v === undefined || v === null || v === '') return true
    try {
      return !checkFn(compiled, group)
    } catch (e) {
      return true // 检查过程异常保守放行，不让整批 run 崩溃
    }
  },

  /** 注册天数过滤（使用编译后的规则）
   *  参数形状：compiled = compileRules().pingbitime（_type 'time'/'timeMulti'），null/缺失 → 放行 */
  checkRegisterTime (group, compiled) {
    // 显式判断缺失：0 时间戳(1970)视为有效，走 checkTimeCompiled 解析（口径统一）
    return this._passIfMissing(group, 'louzhuregtime', compiled, (c, g) => RuleEngine.checkTimeCompiled(c, g), ['time', 'timeMulti'])
  },

  /** 分类屏蔽（使用编译后的规则）
   *  参数形状：compiled = compileRules().pingbifenlei（_type 're'/'multi'），null/缺失 → 放行 */
  checkCategory (group, compiled) {
    return this._passIfMissing(group, 'catename', compiled, (c, g) => {
      const catename = Utils.safeGet(g, 'catename')
      // multi 型规则按行内「分类###值」匹配：分类判定与值判定都基于本条 catename，
      // 传入 null 会导致带分类限制的多行规则永不命中，分类屏蔽失效（P3 修复）。
      return RuleEngine.matchesCompiled(c, catename, catename)
    }, ['re', 'multi'])
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
     *
     * 参数形状：compiled = compileRules(...) 的整份产物（__compiled === true），
     *           与 checkCategory/checkRegisterTime 接收字段级规则（_type）不同；缺失 → 放行。
     */
  checkFields (group, compiled) {
    // FILTER-03：形状守卫——本入口接收整份编译产物（__compiled === true）。传原始配置或错形状
    // 参数时下游 matchesCompiled 对未知 _type 一律返回 false → 静默「全部放行」且无任何留痕；
    // 此处与同级 __compiled 守卫口径统一：显式告警后保守放行（合法输入行为不变）。
    let cfgShape = false
    try { cfgShape = typeof compiled === 'object' && compiled !== null && compiled.__compiled === true } catch (e) { cfgShape = false }
    if (!cfgShape) {
      if (compiled) console.warn('⚠️ checkFields 收到未编译的配置或错形状参数，已保守放行')
      return true
    }
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
    for (const stage of stages) {
      const value = stage.getVal(group)
      const rule = matchedRule(cfg[stage.showKey], value, category)
      if (cfg[stage.showKey] && value !== undefined && value !== null && value !== '' &&
        RuleEngine.matchesCompiled(cfg[stage.showKey], value, category)) {
        showFlags[stage.key] = true
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
        // FILTER-05：不再改写 passed.protections/showFlags——blocked() 会把 protections/skipped
        // 整表清空，紧随其后的 return 丢弃所有改写（原为不可达死代码）；「保护被 plus 抵消」
        // 由 reason.kind === 'plus' 承载（测试锁定同字段抵消后 protections 为空）。
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
      try {
        compiled = RuleEngine.compileRules(rawCfg)
      } catch (e) {
        // FILTER-06：与 explainFilter 的编译失败留痕口径一致（原先此处静默 return true，
        // 故障不可观测）；保守放行语义不变，仍避免异常冒泡与无限递归。
        // qodo #147-6：不得用模板插值 `${e}` ——配置 getter 抛出 Symbol/Symbol 包装值时会抛
        // TypeError，等于在 catch 里再抛、中断过滤链而非保守放行。改为显式安全取值 + 拼接。
        let detail = '(异常值无法转换为文本)'
        try { detail = e && e.message ? String(e.message) : String(e) } catch (err) { /* 保持兜底文案 */ }
        console.warn('⚠️ 过滤规则编译失败，已保守放行：' + detail)
        return true
      }
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
    // ReDoS 纵深防御：与 matchesCompiled 同口径——字段值非字符串时统一 String() 化（不再走
    // Utils.safeText 的「对象 JSON 化 / 函数置空」口径），输入仅由 _normalizeReInput 剥离零宽
    // 字符、不做任何长度截断（v3.270 起长文本完整匹配；安全性由 RE2 线性时间 + 上方关键词
    // hasNestedQuantifier 闸门保证，而非截断）。
    // v3.249：超长 keyword 的 V8 会把正则编译推迟到首次 .test()，此时抛 "Regular expression too
    // large"（new RegExp 不抛）——test 也需 try/catch，失败按放行处理（宁可多推不可少推）。
    try {
      return re.test(RuleEngine._normalizeReInput(typeof value === 'string' ? value : String(value)))
    } catch (e) { return true }
  }
  }
  return FilterEngine
}

module.exports = { createFilterEngine }
