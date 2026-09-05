/* eslint indent: off */

// ============================================================
// 📐 RuleEngine — 规则引擎层
// ============================================================
function createRuleEngine ({ Utils, FILTER_FIELDS, compileUserRegex, isRe2Available }) {
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
      return compileUserRegex(String(cat), 'i')
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
          const mre = /\{(\d+)(?:,(\d*))?\}/y
          mre.lastIndex = i
          const m = mre.exec(s)
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
          // v3.254 P1：`[^]` 是「非空字符类」——^ 后的 ] 是类成员而非结束符（JS 中 [^] 匹配任意
          // 字符）。此前把 [^] 的 ] 当结束符跳过，会把后续 (a+)+ 整体吞进字符类而漏检 ReDoS。
          if (s[j] === '^') {
            j++
            if (s[j] === ']') { j++; if (s[j] === ']') j++; else { /* [^] 已结束于第二个 ] */ } }
          } else if (s[j] === ']') {
            j++ // 空类 ] 开头（[]] 场景），但 []] 中第一个 ] 是成员——严格说需再判断，保守按字符类整体跳过
            while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++ }
          } else {
            while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++ }
          }
          if (j < s.length && s[j] === ']') j++ // 正常类结束（[^] 后无多余 ] 时 j 已指向结束后的字符）
          i = j - 1; cur.inf = false; continue // 字符类整体视为普通 token
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
          // v3.254 P1：`((a+))+` 嵌套分组漏检——中间组 `(a+)` 闭合时其后是 `)` 非量词，
          // 旧代码 parent.inf=false 把「组内含无限量词」信息丢失，外层 `)` 闭合时无法识别。
          // 改为：组内含无限量词（closed.inf 或 parent 已有）就传播给外层，不因中间无量化丢失。
          // 同时 alt（交替歧义）同样向上传播：`((a|aa))+` 嵌套交替也是灾难性回溯。
          if (closed.inf || parent.inf) parent.inf = true
          if (closed.alt || parent.alt) parent.alt = true
          // (a|aa){n} 有界重复+组内交替/无限量词：组内歧义 × 重复仍可指数回溯（(a|aa){30} 对
          // ~60 字符输入实测 8-12s 卡死），有界量词本身不危险，但组内含交替/无限量词时重复
          // 放大回溯——保守拦截。
          // P1（审查 2026-08-15）：阈值曾为 ≥100（如 {500}）——实测 V8 对小重复的优化仅对
          // ≤~10 成立，{20}-{99} 区间（(a+){20}/(\d+){1,20}/(a|aa){30}）对 40-200 字符输入
          // 即指数级卡死主线程，全部漏检。下调到 ≥10：覆盖 20-99 爆炸区间，且不误伤已测试
          // 锁定安全的 {1,3}/{2,3} 等小次数配置。
          if (closed.alt || closed.inf) {
            const bqmr = /\{\d+(?:,\d*)?\}/y
            bqmr.lastIndex = i + 1
            const bqm = bqmr.exec(s)
            if (bqm) {
              const [lo, hi] = bqm[0].slice(1, -1).split(',').map(x => x === '' ? Infinity : Number(x))
              if (lo >= 10 || (hi !== undefined && hi >= 10)) return true
            }
          }
          if (ql > 0) { parent.inf = true; i += ql }
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
      if (isRe2Available() && !compileUserRegex(String(cat), 'i')) {
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
        if (typeof val === 'number' || typeof val === 'object' || typeof val === 'boolean' || typeof val === 'bigint' || typeof val === 'function') {
        // v3.257：与 validateConfig 的字符串守卫口径对齐（非字符串一律拒绝），
        // 数字/对象/布尔/BigInt 等非字符串值 String 化后会变成误导性字面量正则（如 0 → /0/i、true → /true/i），直接跳过
          console.warn(`⚠️ 规则「${String(field)}」的值必须为字符串（当前为 ${typeof val}），已跳过`)
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
            if (parts.length > 2) {
            // v3.239 口径统一：与 validateConfig 一致，行内多余 ### 仅前两段生效时告警
              console.warn(`⚠️ 配置「${String(field)}」行包含多个 ###，仅前两段生效：「${String(line)}」`)
            }
            if (parts.length >= 2) {
              if (!val) continue // 值正则为空 → 跳过（避免永真规则）
              let catRe = null
              if (cat) {
                catRe = this._compileCatRe(cat)
                if (!catRe) continue
              }
              let valRe = null
              if (this.hasNestedQuantifier(val)) continue // ReDoS 防护：嵌套量词跳过
              valRe = compileUserRegex(val, 'i')
              if (!valRe && isRe2Available()) {
                console.warn(`⚠️ 规则「${String(field)}」包含非法正则「${String(val)}」，已跳过（v3.239 口径统一：validateConfig 与 compileRules 均告警）`)
                continue
              }
              if (!valRe) continue
              rules.push({ cat: catRe, val: valRe, source: line.trim() }) // valRe 恒真（失败已 continue）
            }
          }
          compiled[field] = { _type: 'multi', rules }
        } else {
        // 简单模式：直接编译为 RegExp
        // v3.156：先 trim——空白配置('   ')曾编译成 /   /i 假过滤（validateConfig 说忽略但实际生效）
          val = val.trim()
          if (!val) { compiled[field] = null; continue }
          if (this.hasNestedQuantifier(val)) { compiled[field] = null; continue } // ReDoS 防护
          const re = compileUserRegex(val, 'i')
          if (re) {
            compiled[field] = { _type: 're', re, source: val }
          } else {
            if (!isRe2Available()) {
              compiled[field] = null
              continue
            }
            console.warn(`⚠️ 规则「${String(field)}」无法使用安全正则引擎，已跳过`)
            compiled[field] = null // 非法正则置 null 跳过（validateConfig 已警告）
          }
        }
      }

      // 编译 pingbitime（特殊处理）
      // v3.156：先 trim——空白('   ')曾 Number→0 静默关闭时间过滤
      // v3.x：pingbitime 天数加上限 PINGBITIME_MAX_DAYS（3650000 天≈10000 年），
      // 超过视为无效（置 null 不编译）——巨大值(如 1e20)会让注册年龄永远达不到上限，等效永久拦截新账号。
      const PINGBITIME_MAX_DAYS = 3650000
      let pbRaw = ''
      try { pbRaw = rawCfg.pingbitime === undefined || rawCfg.pingbitime === null ? '' : String(rawCfg.pingbitime).trim() } catch (e) { pbRaw = '' } // 脏配置无法转字符串时忽略规则，不让启动崩溃
      if (pbRaw) {
        if (/###/.test(pbRaw)) {
          const lines = this._splitLines(pbRaw)
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
              const value = Math.floor(Number(val))
              if (Number.isFinite(value) && value >= 0 && value <= PINGBITIME_MAX_DAYS) {
                rules.push({ cat: catRe, value, source: line.trim() })
              } else if (Number.isFinite(value) && value >= 0 && value > PINGBITIME_MAX_DAYS) {
                console.warn(`⚠️ 配置「pingbitime」的天数值「${(parts[1] || '').trim()}」超过上限 ${PINGBITIME_MAX_DAYS} 天，已忽略`)
              }
            }
          }
          compiled.pingbitime = { _type: 'timeMulti', rules }
        } else {
          const value = Math.floor(Number(pbRaw))
          // v3.157：非法数值(如 'abc')→ null 不编译（曾落 value:0 静默关闭时间过滤；空白已 v3.156 处理）
          // v3.x：数值超过 PINGBITIME_MAX_DAYS 上限同样置 null 不编译（同下界处理）
          if (Number.isFinite(value) && value >= 0 && value <= PINGBITIME_MAX_DAYS) {
            compiled.pingbitime = { _type: 'time', value, source: pbRaw }
          } else {
            if (Number.isFinite(value) && value >= 0 && value > PINGBITIME_MAX_DAYS) {
              console.warn(`⚠️ 配置「pingbitime」的值「${pbRaw}」超过上限 ${PINGBITIME_MAX_DAYS} 天，已忽略`)
            }
            compiled.pingbitime = null
          }
        }
      } else {
        compiled.pingbitime = null
      }

      compiled.__compiled = true
      return compiled
    },

    // RE2 本身保证线性时间；完整匹配归一化后的输入，避免关键词位于长文本后半段时漏匹配。
    _normalizeReInput (s) {
    // 过滤链路与 URL 安全链路口径一致，匹配前剥离零宽字符。
      return s.replace(/[\u200B-\u200D\uFEFF]+/g, '')
    },

    /** 多行规则分类匹配：无 cat 限制(匹配所有)或有 cat 且 catename 匹配 */
    _catMatches (rule, catename) {
      if (!rule.cat) return true
      if (catename === undefined || catename === null || catename === '') return false
      try {
        const value = typeof catename === 'string' ? catename : String(catename)
        return rule.cat.test(this._normalizeReInput(value))
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

    /** 返回首个命中的多行规则（供可解释过滤复用；无命中返回 null） */
    _firstMatchingRule (rules, catename, predicate) {
      if (!Array.isArray(rules)) return null
      for (const rule of rules) {
        if (this._catMatches(rule, catename) && predicate(rule)) return rule
      }
      return null
    },

    /** 使用编译后的规则进行匹配（单条） */
    matchesCompiled (compiled, fieldValue, catename) {
      if (!compiled || fieldValue === undefined || fieldValue === null || fieldValue === '') return false
      let value
      try { value = typeof fieldValue === 'string' ? fieldValue : String(fieldValue) } catch (e) { return false } // 脏字段 toString/Symbol 失败时保守放行，不让整批 run 崩溃

      if (compiled._type === 're') {
      // 简单正则
        if (!compiled.re || typeof compiled.re.test !== 'function') return false
        return compiled.re.test(this._normalizeReInput(value))
      }

      if (compiled._type === 'multi') {
      // 多行多分类：任意一行匹配即匹配
        if (!Array.isArray(compiled.rules) || compiled.rules.length === 0) return false
        return this._anyRule(compiled.rules, catename, r => r.val.test(this._normalizeReInput(value)))
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
      // 非字符串（对象/数组/数字等脏配置）→ 显式警告（String 化会把 '[object Object]' 当合法正则，静默怪行为），与 zkt_gjc 口径一致
        if (cfg[field] !== undefined && cfg[field] !== null && typeof cfg[field] !== 'string') {
          warnings.push(`⚠️ 配置「${field}」应为字符串，当前为 ${typeof cfg[field]}，已忽略该字段过滤`)
          continue
        }
        const val = safeStr(cfg[field])
        if (!val) continue
        // pingbifenlei 不支持 ### 多行语法，已在上面给出明确警告，跳过以避免逐行告警（与 compileRules 口径一致）
        if (field === 'pingbifenlei' && /###/.test(val)) continue
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
            if (isRe2Available() && !compileUserRegex(val, 'i')) {
              warnings.push(`⚠️ 配置「${field}」值正则无效或当前环境不支持：「${val}」`)
            }
          }
        } else {
          if (String(val).trim() === '') {
            warnings.push(`⚠️ 配置「${field}」为空白字符，将被忽略`)
            continue
          }
          const trimmedVal = val.trim() // C048：简单模式与 compileRules 一致，用 trim 后值校验
          if (this.hasNestedQuantifier(trimmedVal)) {
            warnings.push(`⚠️ 配置「${field}」的正则含嵌套量词，可能导致灾难性回溯，该规则将被忽略：「${trimmedVal}」`)
            continue
          }
          // 与 compileRules 的 'i' 保持一致
          if (isRe2Available() && !compileUserRegex(trimmedVal, 'i')) {
            warnings.push(`⚠️ 配置「${field}」包含无效或当前环境不支持的正则表达式：「${trimmedVal}」`)
          }
        }
      }

      // 验证 zkt_gjc（只看它关键词，与 App.run 预编译口径一致）
      // R11-1：非字符串（对象/数字等脏配置）→ 显式警告（String 化会把 '[object Object]' 当合法正则，静默怪行为）
      if (cfg.zkt_gjc !== undefined && cfg.zkt_gjc !== null && typeof cfg.zkt_gjc !== 'string') {
        warnings.push(`⚠️ 配置「zkt_gjc」应为字符串，当前为 ${typeof cfg.zkt_gjc}，已忽略只看它过滤`)
      } else if (cfg.zkt_gjc && String(cfg.zkt_gjc).trim() === '') {
      // 与 App.run 口径一致：纯空白关键词为误配置，显式告警并忽略只看它过滤
        warnings.push('⚠️ 配置「zkt_gjc」为空白字符，已忽略只看它过滤')
      } else if (cfg.zkt_gjc && String(cfg.zkt_gjc).trim() !== '') {
      // P2（审查 2026-08-15）：zkt_gjc 首尾空白地雷——hash 与 App.run 均按字面正则匹配（不能 trim，
      // 空白在正则语义中有意义），' abc' 与 'abc' 行为完全不同；「只看它」是白名单语义，误配空格会
      // 静默全量滤空且无告警（pingbitime 已有同款告警，此处补齐低成本保险）。
        if (String(cfg.zkt_gjc) !== String(cfg.zkt_gjc).trim()) {
          warnings.push('⚠️ 配置「zkt_gjc」含首尾空白，将按字面正则匹配（不会被 trim）；若非有意配置请去除首尾空格')
        }
        if (this.hasNestedQuantifier(cfg.zkt_gjc)) {
          warnings.push('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤')
        } else {
          if (isRe2Available() && !compileUserRegex(cfg.zkt_gjc, 'i')) {
            warnings.push(`⚠️ 配置「zkt_gjc」包含无效或当前环境不支持的正则表达式：「${cfg.zkt_gjc}」`)
          }
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
          const PINGBITIME_MAX_DAYS = 3650000 // 与 compileRules 口径一致：超过上限视为无效
          const lines = pbStr.split(/<br\s*\/?>|\r\n|\r|\n/) // 与 _splitLines 口径一致(含单独 \r、<br/>，R2)
          for (const line of lines) {
            const { cat, val, parts } = this._parseLine(line)
            if (parts.length >= 2) {
              if (cat) this._validateCatRe(cat, 'pingbitime', warnings)
              if (val === '') {
                warnings.push(`⚠️ 配置「pingbitime」的行「${String(line).trim()}」天数值为空，已忽略该行`)
                continue
              }
              const tNum = Number(val)
              if (!Number.isFinite(tNum) || tNum < 0) {
                warnings.push(`⚠️ 配置「pingbitime」的天数值「${(parts[1] || '').trim()}」不是有效数字（需 ≥0 的有限数）`)
              } else if (!Number.isInteger(tNum)) {
                warnings.push(`⚠️ 配置「pingbitime」的天数值「${(parts[1] || '').trim()}」是小数，已按整数处理（建议使用整数天数）`)
              } else if (tNum > PINGBITIME_MAX_DAYS) {
                warnings.push(`⚠️ 配置「pingbitime」的天数值「${(parts[1] || '').trim()}」超过上限 ${PINGBITIME_MAX_DAYS} 天，已忽略`)
              }
            } else if (String(line).trim() !== '') {
              warnings.push(`⚠️ 配置「pingbitime」的行「${String(line).trim()}」缺少「###」分类/数值分隔符，已忽略该行`)
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
      // cache.maxSize 校验统一由 App.run（Config.cache.maxSize）负责；validateConfig 只接收 Config.filter，无此字段，
      // 此处不做双形态（cfg.cache.maxSize / cfg.maxSize）校验，避免死代码与口径矛盾。
      // v3.257：恢复去重，与清单声称的 "dedup keep" 一致；同一配置缺陷只警告一次。
      return [...new Set(warnings)]
    }
  }
  return RuleEngine
}

module.exports = { createRuleEngine }
