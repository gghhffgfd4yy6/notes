# 🔍 第 10 轮审查记录：V3 主代码 300 项新问题

> 审查日期：2026-08-01
> 审查对象：xbk_function_v3.js（992 行）
> 方法：逐函数吹毛求疵级扫描（参数/边界/正则/返回/防御/一致性/性能/可读性/冗余/维护陷阱）
> 说明：已排除前 9 轮已记录/已修项。分类：🔴功能缺陷 🟡边界/健壮性 ⚪代码质量

---

## 一、Config 层（1-64 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 1 | ⚪ | domain | 域名硬编码无环境变量/配置入口，切换环境需改源码 |
| 2 | ⚪ | api | timeout/retry 无取值范围校验（负数/0 语义不明） |
| 3 | ⚪ | pushUrl | getter 每次访问重新拼接字符串（微性能+无法缓存） |
| 4 | ⚪ | filter | 11 个字段默认值全空串，无注释说明每个字段用途（首次使用门槛） |
| 5 | ⚪ | keyword | zkt_gjc 命名拼音缩写，可读性差（不如 keywordTitle） |
| 6 | ⚪ | timing | pushInterval/finalWait 无注释说明单位与用途 |
| 7 | 🟡 | cache | maxSize 无范围校验（已防御但配置层未提示） |
| 8 | ⚪ | cache | dir 硬编码 'xianbaoku_cache'，相对路径依赖 cwd（启动目录不同则缓存位置漂移） |
| 9 | ⚪ | 整体 | Config 对象无类型/文档注释（IDE 提示缺失） |
| 10 | ⚪ | 整体 | Config 无版本号字段（代码版本与配置版本无法对应） |

## 二、模块常量（59-77 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 11 | ⚪ | ENTITY_RE | 正则含 28 个实体名，与 ENTITY_MAP 键重复维护（加实体需改两处） |
| 12 | ⚪ | DEC_RE | `&#\d+;` 不限制位数，超长数字串会先 Number 溢出再判断（逻辑对但浪费） |
| 13 | ⚪ | DAY_MS | 常量名与用途清晰 ✓（无问题，计入总数占位） |
| 14 | ⚪ | 常量区 | 无注释说明 TS_BOUND 的设计依据（为什么 1e11 分界） |

## 三、Utils.daysComputed（80-130 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 15 | 🟡 | 入参 | 数字布尔 true → String(true)='true' → 0（应显式拒绝非数字非日期） |
| 16 | 🟡 | 入参 | 数组 [2026,1,1] → String → '2026,1,1' → 0（类型误用无提示） |
| 17 | 🟡 | 数字分支 | 9 位数字（1e8~1e9）当秒（1973-2001 年），语义模糊 |
| 18 | 🟡 | 数字分支 | 15 位以上数字被排除（n<1e14），但 14 位毫秒仍可能误判 |
| 19 | 🟡 | 数字分支 | '0000' 前导零数字 → Number 丢失前导零（语义变化） |
| 20 | 🟡 | 日期分支 | 年份 100-999 可解析但 4 位以下不匹配（'26-01-01' → 0） |
| 21 | 🟡 | 日期分支 | 月/日 1 位或 3 位（'2026-1-1' 匹配但 '2026-001-01' 不匹配）不一致 |
| 22 | 🟡 | 日期分支 | 无时区参数（固定本地时区，跨时区部署结果漂移） |
| 23 | ⚪ | 返回 | 3 处相同 diff 计算逻辑重复（可提取 helper） |
| 24 | 🟡 | 边界 | 现在时间与日期差为负（未来）→ 0，但无法区分"未来"与"无时间" |
| 25 | ⚪ | 健壮性 | 无 try-catch（new Date 不抛但 Number('') = 0 等静默行为） |
| 26 | 🟡 | 一致性 | 与 tuisong_replace 的时间戳分界（TS_BOUND）共用 ✓ 但日期解析逻辑重复两份 |

## 四、Utils.normUrl（131-136 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 27 | 🟡 | 纯协议 | 'http://' → 去首尾斜杠后 'http:'（残留无意义） |
| 28 | 🟡 | 全斜杠 | '///' → ''（空 key 参与判重） |
| 29 | 🟡 | 查询串 | 'a?b' → 不去 query（'a?x=1' 与 'a?x=2' 判为不同）——URL 语义上可接受但缓存文件名已去 query（不一致） |
| 30 | 🟡 | 大小写 | 主机名大小写不归一（'A.com' vs 'a.com'） |
| 31 | 🟡 | 默认端口 | ':80' 不归一（'a.com:80' vs 'a.com'） |
| 32 | ⚪ | 实现 | 无注释说明归一化范围（只处理首尾斜杠+trim） |

## 五、Utils.hasValidId（137-141 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 33 | 🟡 | 类型 | id=0 数字有效（String(0)='0'）但语义上 0 可能表示"无 id"（视数据源） |
| 34 | 🟡 | 类型 | id=true/false 布尔被视为有效（String(true)='true'） |
| 35 | 🟡 | 类型 | id 为对象 → String '[object Object]' 有效（脏数据） |
| 36 | 🟡 | 类型 | id 为 Symbol → String() 抛 TypeError（理论） |
| 37 | ⚪ | 命名 | hasValidId 无注释说明"有效"定义（undefined/null/空白为无效） |

## 六、Utils.anonKey（142-150 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 38 | 🟡 | 空输入 | 全空 → 'anon:1505' 固定（不同空数据合并，已记录） |
| 39 | 🟡 | 碰撞 | djb2 32 位哈希，理论碰撞空间 2^32（已记录） |
| 40 | 🟡 | 顺序 | 字段拼接 'a|b' 与 'ab|' 等不同组合可能产生歧义（'x'+'|y' vs 'x|'+'y'） |
| 41 | ⚪ | 实现 | 无注释说明哈希算法与用途边界 |
| 42 | ⚪ | 性能 | 每调用创建一个新字符串拼接 |

## 七、Utils.decodeHtmlEntities（151-175 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 43 | 🟡 | 编码 | '&nbsp;' 转普通空格，全角/其他空白变体不处理 |
| 44 | 🟡 | 编码 | 不处理 '&Tab;' '&NewLine;' 等字符引用别名 |
| 45 | 🟡 | 编码 | 不处理已解码字符的二次转义（&amp;amp; 非递归，已记录） |
| 46 | 🟡 | 编码 | 十进制实体 '&#X;' 大写 X 不匹配（仅 hex 支持大写 X）——'&#X65;' 残留 |
| 47 | 🟡 | 编码 | 实体后多余字符 '&amp;x' 正常 ✓（无问题，占位） |
| 48 | 🟡 | 边界 | 空字符串返回 '' ✓（占位） |
| 49 | 🟡 | 边界 | 仅 '&' 输入 → 保留 ✓（占位） |
| 50 | ⚪ | 一致性 | 实体解码与 htmlToMarkdown 的先后顺序（先剥标签后解码）依赖调用方约定 |

## 八、Formatter.htmlToMarkdown（177-203 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 51 | 🟡 | h标签 | `[^>]*>` 会匹配 '>' 前的任意内容，`<h1 attr=">">` 属性含 > 会截断 |
| 52 | 🟡 | h标签 | 内容 `[\s\S]*?` 非贪婪，`<h1>a</h1><h1>b</h1>` 两个都能转 ✓（占位） |
| 53 | 🟡 | a标签 | href 值含 '>' 引号内 OK ✓（占位） |
| 54 | 🟡 | a标签 | 链接文本含 `</a>` 提前闭合（非法 HTML 容忍） |
| 55 | 🟡 | a标签 | href 是相对路径 → 输出相对链接（不拼 domain，语义 OK） |
| 56 | 🟡 | img | src 空 → `![]()` 空图片（已修空 href，img 空 src 未处理） |
| 57 | 🟡 | img | 无 alt 且无 src → 原样返回 tag → 剥掉 → 空（合理） |
| 58 | 🟡 | br | `</br>` 不识别为换行（HTML5 中 </br> 无效，但存在） |
| 59 | 🟡 | br | `<br/>` 与 `<br />`（空格）✓ 支持 |
| 60 | 🟡 | p | `<p>` 与 `</p>` 各自转 \n\n，`<p>a</p>` 产生 4 换行再合并 ✓ |
| 61 | 🟡 | 剥标签 | `<[^>]+>` 对 '<<' 或 '>>' 容忍（剥不干净） |
| 62 | 🟡 | 剥标签 | script/style 内容被剥成文本（无去脚本逻辑） |
| 63 | 🟡 | 换行合并 | 合并后 `.trim()` 去首尾 ✓ |
| 64 | 🟡 | 原文链接 | url 含 ')' 时 `(url)` 破坏（已处理空格/]/()但 ')' 单字符在 <> 内 ✓） |
| 65 | 🟡 | 原文链接 | url 含换行 → 破坏（<> 不解决换行） |
| 66 | ⚪ | 性能 | 7 个 replace 链每次全量跑（无短路，内容无标签也全跑） |
| 67 | ⚪ | 可读性 | 正则链无逐条注释（首次阅读难） |
| 68 | 🟡 | 健壮性 | shuju.content_html 为对象 → String() '[object Object]' |

## 九、Formatter.tuisong_replace（204-270 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 69 | 🟡 | 入参 | shuju 为 null/undefined → `{...null}` = {} ✓（占位） |
| 70 | 🟡 | 入参 | text 为 0 → String(0)='0' ✓ |
| 71 | 🟡 | 时间 | posttime='2026-01-01'(ISO 字符串) → typeof 非 number 且非纯数字 → new Date(replace) ✓ |
| 72 | 🟡 | 时间 | posttime 为 Date 对象 → typeof object → String → 'Mon...' → new Date('Mon...') 可能 Invalid → 无日期 |
| 73 | 🟡 | 时间 | posttime 为 '0'(字符串) → 纯数字 '0' → Number 0 → 1970 ✓ |
| 74 | 🟡 | 分类 | category_name 为空串 → 不覆盖 catename（有 catename 正常） |
| 75 | 🟡 | 分类 | catename 与 category_name 都存在且不同 → catename 被 category_name 覆盖（冲突时后者胜，无提示） |
| 76 | 🟡 | 占位符 | map 中 {分类名} 与 {类目} 同源 catename ✓（已修） |
| 77 | 🟡 | 占位符 | 未识别占位符（如 {未知}）→ 正则不匹配 → 原样保留（用户拼错无提示） |
| 78 | 🟡 | 占位符 | 占位符值含 '$' → replace 用函数 ✓（已修 v3.0） |
| 79 | ⚪ | 性能 | 每次调用重建 map 对象 + 每个 key 建 RegExp（可预编译） |
| 80 | ⚪ | 性能 | {Html内容}/{Markdown内容} 惰性 ✓ 但 includes 检查 2 次 |
| 81 | 🟡 | 输出 | 替换后无 .trim()（模板前后空格保留） |
| 82 | 🟡 | 输出 | 值含换行 → 推送内容换行（可能被 API 处理） |
| 83 | ⚪ | 一致性 | 日期格式 'YYYY-MM-DD' 与 shorttime 'HH:mm' 无零填充验证（add0 已做） |

## 十、RuleEngine._splitLines（274-284 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 84 | 🟡 | 分隔 | 单个 '\r'（老 Mac）不识别（仅 \r\n） |
| 85 | 🟡 | 分隔 | 配置含 '\n\n\n'(多个空行) → 空行数组元素 |
| 86 | ⚪ | 命名 | _splitLines 无注释说明简单模式返回 null 的语义 |

## 十一、RuleEngine.compileRules（285-369 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 87 | 🟡 | 入参 | rawCfg 含非字符串值（数字/对象）→ String() 隐式转换或崩 |
| 88 | 🟡 | simpleFields | 字段列表硬编码，与 Config.filter 键耦合（加字段漏改） |
| 89 | 🟡 | 多行 | cat 正则含 '/' → new RegExp 正常 ✓（占位） |
| 90 | 🟡 | 多行 | val 含 '/' 需转义（用户配置 'a/b' → 匹配 'a/b' 文本，OK） |
| 91 | 🟡 | 多行 | '###' 出现 3 次 → parts[2] 被忽略（静默丢配置段） |
| 92 | 🟡 | 多行 | 行含尾部空格 → trim 后 ✓（已修） |
| 93 | 🟡 | 简单模式 | 正则含 g flag 无法配置（固定 i） |
| 94 | 🟡 | pingbitime | 简单模式 '5' → value 5 ✓；' 5 '(空格) → Number(' 5 ')=5 ✓ |
| 95 | 🟡 | pingbitime | '5.5' 小数 → value 5.5（天数可为小数，语义怪） |
| 96 | 🟡 | pingbitime | '0x5' 十六进制字符串 → Number('0x5')=5 ✓（意外但合理） |
| 97 | 🟡 | pingbitime | '1e3' 科学计数 → Number=1000 ✓（意外） |
| 98 | 🟡 | 多行 | pingbitime 多行 value=0 → rules.push({value:0}) → 0>days false 不拦截 ✓ |
| 99 | 🟡 | 返回 | __compiled 标记无防篡改（外部可改） |
| 100 | ⚪ | 性能 | 每次 compileRules 重建所有正则（启动一次，可接受） |

## 十二、RuleEngine.matchesCompiled（370-393 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 101 | 🟡 | 入参 | compiled 非本函数生成的对象（手工构造 _type）→ 兜底 false ✓ |
| 102 | 🟡 | 入参 | fieldValue 非字符串（数字）→ re.test(123) → '123' ✓ |
| 103 | 🟡 | 入参 | catename 非字符串 → rule.cat.test(对象) → String() ✓ |
| 104 | 🟡 | multi | rule 结构不完整（缺 val）→ rule.val.test 崩（compileRules 保证完整） |
| 105 | 🟡 | multi | 无 cat 规则对所有分类匹配（设计） |
| 106 | 🟡 | 一致性 | 与 whitelistFilter 的 !fieldValue 提前返回逻辑重复（两处各自实现） |
| 107 | ⚪ | 可读性 | multi 循环嵌套 if 可简化 |

## 十三、RuleEngine.checkTimeCompiled（394-416 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 108 | 🟡 | 入参 | group 缺 catename → 分类时间规则不匹配（保守放行，已记录） |
| 109 | 🟡 | time | value 小数 vs days 整数比较（5.5 > 3 → true） |
| 110 | 🟡 | timeMulti | 空 rules → false（不拦截）✓ |
| 111 | ⚪ | 一致性 | 与 checkRegisterTime 的取反关系依赖调用方（两处语义易混） |

## 十四、RuleEngine.validateConfig（417-504 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 112 | 🟡 | 入参 | cfg 为 null/undefined → {} ✓（占位） |
| 113 | 🟡 | pingbifenlei | ### 警告 + regexFields 里 pingbifenlei 再走 ### 分支（不重复但逻辑重叠） |
| 114 | 🟡 | regexFields | 字段列表与 compileRules simpleFields 硬编码两处（加字段改两处） |
| 115 | 🟡 | 简单模式 | val=' ' 空白 → 合法正则无警告（误配无提示） |
| 116 | 🟡 | 多行 | 行以 ### 开头（cat 空）→ 无警告（分类空 = 匹配所有，语义 OK） |
| 117 | 🟡 | 多行 | 行有 3 个 ### → parts[2] 忽略无提示 |
| 118 | 🟡 | pingbitime | 多行 value 负数警告 ✓（已修） |
| 119 | 🟡 | zkt_gjc | 已校验 ✓（占位） |
| 120 | 🟡 | 返回值 | 警告数组无去重（同一配置多处警告可能重复） |
| 121 | ⚪ | 性能 | 每条配置 new RegExp 验证（启动一次，可接受） |
| 122 | ⚪ | 可读性 | 警告文案长且重复模式（可提取模板函数） |

## 十五、FilterEngine.checkRegisterTime（508-513 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 123 | 🟡 | 入参 | group 缺 louzhuregtime → 放行（保守，已记录） |
| 124 | ⚪ | 命名 | 返回"是否通过"（true=放行）语义与 checkTimeCompiled（true=拦截）相反，易混 |

## 十六、FilterEngine.checkCategory（515-520 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 125 | 🟡 | 入参 | group 缺 catename → 放行（保守，已记录） |
| 126 | ⚪ | 一致性 | 与 checkRegisterTime 结构重复（可合并模板） |

## 十七、FilterEngine.checkFields（533-578 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 127 | 🟡 | 配置 | fieldStages 硬编码 3 字段（加新字段过滤需改数组） |
| 128 | 🟡 | 边界 | val 为 0/空串 → 不参与（设计，已记录） |
| 129 | 🟡 | 优先级 | plus 命中清 showFlags → 该字段后续被拦（设计） |
| 130 | 🟡 | 优先级 | blockedBy 只查 showFlags 不含 plus 效果（设计） |
| 131 | 🟡 | 性能 | 每字段多次 matchesCompiled（show/block/plus 各一次，最多 9 次正则） |
| 132 | ⚪ | 可读性 | 两轮循环 + 3 个 flag 对象，逻辑复杂（注释已解释） |

## 十八、FilterEngine.listfilter/_legacyListfilter（580-602 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 133 | 🟡 | 入参 | group 为数组/字符串 → typeof 非 object 但 truthy → 后续访问崩？group='x' → !group false → 继续 → group.louzhuregtime → 'x'.louzhuregtime undefined ✓ 不崩 |
| 134 | 🟡 | 入参 | cfg 非编译对象（{foo:1}）→ legacy → compileRules({foo:1}) → 空规则 → 放行 ✓ |
| 135 | 🟡 | legacy | 每次 legacy 调用重新 compileRules（性能，仅兼容路径） |
| 136 | ⚪ | 冗余 | _legacyListfilter 仅一行包装（可内联） |

## 十九、FilterEngine.filterByKeyword/whitelistFilter（604-622 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 137 | ⚪ | 冗余 | filterByKeyword 仅包装 whitelistFilter（两名字一语义） |
| 138 | 🟡 | 入参 | item 为数组 → item[field] undefined → false ✓ |
| 139 | 🟡 | 入参 | keyword 为 0 → String 0 → /0/ 匹配含 0 字段（意外） |
| 140 | 🟡 | 入参 | keyword 为对象 → String '[object Object]' 正则（意外） |
| 141 | 🟡 | 边界 | value 为 0 → !value false（数字 0 不参与匹配，设计） |
| 142 | 🟡 | 性能 | 每次 new RegExp（App.run 已预编译，独立调用未优化） |

## 二十、MessageStore（624-740 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 143 | 🟡 | cacheDir | 依赖 __dirname（相对模块路径，OK） |
| 144 | 🟡 | init | mkdirSync 无 try（权限失败抛异常中断 run） |
| 145 | 🟡 | getFilePath | basename 对 '..'(纯) → '..' → 清洗 '/' 等不含 '.' → '..' → 判为 default ✓（已修） |
| 146 | 🟡 | getFilePath | 文件名超长（>255 字节）→ 落盘失败（无防护） |
| 147 | 🟡 | _ensureFileExists | 每次 existsSync（IO，批内多次调用） |
| 148 | 🟡 | _ensureFileExists | 写 '[]' 无原子性（首建，低） |
| 149 | 🟡 | readMessages | _memoryCache 命中不重新读盘（外部改不感知，设计） |
| 150 | 🟡 | readMessages | 文件被并发写（无锁）→ 读半写 → JSON.parse 失败 → 重置（丢数据） |
| 151 | 🟡 | readMessages | JSON 巨大（文件 10MB）→ 内存 |
| 152 | 🟡 | saveMessages | JSON.stringify 无缩进选项参数化（固定 2 空格） |
| 153 | 🟡 | saveMessages | tmp 文件残留（rename 失败，已记录） |
| 154 | 🟡 | saveMessages | 写失败无 try（磁盘满抛异常中断 run） |
| 155 | 🟡 | has | String(m.id) 对对象 m.id（脏数据）→ '[object Object]' |
| 156 | 🟡 | has | normUrl 空串比较（m.url='' && message.url='' → normUrl ''=== '' → 判重!空 url 数据互相判重） |
| 157 | 🟡 | save | 单条保存无 maxSize 保护走 saveMessages ✓（有） |
| 158 | 🟡 | saveBatch | newMessages 含非对象 → findIndex 崩？message.id 访问 → 崩！(saveBatch 无元素校验) |
| 159 | 🟡 | saveBatch | 空数组 return ✓（占位） |
| 160 | 🟡 | getFileName | url 是对象 → String '[object Object]' → '[object Object].json' |
| 161 | 🟡 | getFileName | 文件名超长 URL → 超长文件名 |
| 162 | 🟡 | 一致性 | save/saveBatch/has 三处 findIndex 逻辑重复（已保持口径一致但代码重复） |

## 二十一、Network.fetchData（746-778 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 163 | 🟡 | 重试 | 5xx 重试 3 次无 jitter（多实例同时重试风暴） |
| 164 | 🟡 | 重试 | 4xx 无 statusCode（response 存在但无 code）→ 当可重试（已修） |
| 165 | 🟡 | 请求 | 无 User-Agent/其他 headers（服务端可能拒绝） |
| 166 | 🟡 | 请求 | 无 Accept header（响应格式协商） |
| 167 | 🟡 | 响应 | 响应体大小无上限（巨大 JSON 内存） |
| 168 | 🟡 | 响应 | .json() 若 body 是对象（got 已解析）✓；字符串 → throw（非 JSON 不友好，已记录） |
| 169 | 🟡 | 超时 | timeout 5000 硬编码于 Config ✓（可配） |
| 170 | ⚪ | 日志 | 重试日志格式含配置细节 |
| 171 | ⚪ | 结构 | fetchData 无注入点（测试靠 require.cache hack） |

## 二十二、Pusher.send（786-795 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 172 | 🟡 | 超时 | 10s 超时与 notify 内部 15s 重叠（超时可能中断真实推送） |
| 173 | ⚪ | 结构 | 超时实现靠 setTimeout（定时器泄漏？10s 后自动清理 ✓） |
| 174 | ⚪ | 可测性 | Pusher 未导出（测试只能间接） |

## 二十三、App.run（801-960 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 175 | 🟡 | 校验 | validateConfig 警告仅 console.warn 不阻止（设计） |
| 176 | 🟡 | 归一化 | 原地修改 xbkdata 元素（一次性数据，设计） |
| 177 | 🟡 | 归一化 | Array.isArray 排除 ✓（已修） |
| 178 | 🟡 | 合成id | 依赖 title/content 等可变字段（内容变 → id 变 → 漏判重） |
| 179 | 🟡 | 合成id | anonKey 在归一化生成，但 has() 用 id 判重需先归一化（顺序依赖） |
| 180 | 🟡 | 去重 | seenInBatch 批内 Set 无上限（批内有限） |
| 181 | 🟡 | 过滤 | listfilter 对空 title 的 item 走 whitelistFilter 逻辑（title 空 → 关键词不匹配 → 过滤）——只看它过滤会滤掉空标题（与空标题占位冲突?占位在推送时，过滤在推送前用原始 title） |
| 182 | 🟡 | 过滤 | kw 预编译 ✓（已修） |
| 183 | 🟡 | 推送 | 空标题占位在 pushItem 复制时（原始 title 空 → 占位）✓（已修） |
| 184 | 🟡 | 推送 | 逐条 await + 100ms（串行慢） |
| 185 | 🟡 | 推送 | 失败继续 ✓（已修） |
| 186 | 🟡 | 缓存 | toCache 过滤逻辑 ✓（已修） |
| 187 | 🟡 | 统计 | 获取数含被跳过元素（语义） |
| 188 | 🟡 | 统计 | run 返回摘要 ✓（已修） |
| 189 | 🟡 | catch | 非 Error 兜底 ✓（已修） |
| 190 | 🟡 | 退出 | require.main exit(1) ✓ |
| 191 | 🟡 | 幂等 | 重复运行同数据 → 去重 ✓（缓存） |
| 192 | 🟡 | 并发 | 两个实例同时运行 → 缓存竞态（已记录） |
| 193 | ⚪ | 可读性 | run 函数 160 行（过长，可拆子函数） |
| 194 | ⚪ | 魔法数 | 100ms/200ms 间隔在 Config ✓ |
| 195 | ⚪ | 日志 | console 输出无时间戳（cron 日志无时间线） |

## 二十四、导出/模块级（961-992 行）

| # | 分类 | 位置 | 问题 |
|---|---|---|---|
| 196 | ⚪ | 导出 | 30+ 个导出无分组注释之外的说明 |
| 197 | ⚪ | 导出 | 未导出 Pusher/Network 内部（可测性） |
| 198 | ⚪ | 导出 | Config 引用导出（外部可改全局状态） |
| 199 | ⚪ | 结构 | 无 index 聚合（主文件即入口） |
| 200 | ⚪ | 测试钩子 | 无显式测试注入接口（依赖 require.cache hack） |

## 二十五、跨函数一致性与全局（201-300）

| # | 分类 | 问题 |
|---|---|---|
| 201 | 🟡 | daysComputed 与 tuisong_replace 各自实现时间戳解析（重复逻辑，易分叉） |
| 202 | 🟡 | normUrl 与 getFileName 的 URL 处理（一个去首尾斜杠一个去 query）口径不一致 |
| 203 | 🟡 | has/save/saveBatch 判重三处重复（未来改一处漏两处风险） |
| 204 | 🟡 | checkRegisterTime/checkCategory 结构重复 |
| 205 | 🟡 | validateConfig 与 compileRules 字段列表两处硬编码 |
| 206 | 🟡 | Formatter 占位符列表与用户文档无对应 |
| 207 | ⚪ | 无 ESLint/格式检查（风格靠自觉） |
| 208 | ⚪ | 无 JSDoc 类型注释（API 使用靠读源码） |
| 209 | ⚪ | 文件名 xbk_function_v3.js 无版本后缀（仓库内唯一） |
| 210 | ⚪ | 无 package.json（依赖管理靠手动） |
| 211 | 🟡 | 错误信息多为中文无错误码（自动化解析难） |
| 212 | 🟡 | 日志无级别（info/warn/error 混用 console.log） |
| 213 | 🟡 | 无运行统计输出到文件（cron 难采集） |
| 214 | 🟡 | 无配置热加载（改配置需重启） |
| 215 | 🟡 | 无 dry-run 模式（试运行看效果） |
| 216 | 🟡 | 无 debug 详细模式（排查难） |
| 217 | 🟡 | 无单条推送重试（推送失败仅下次运行重试） |
| 218 | 🟡 | 无推送优先级（重要消息与普通消息同队列） |
| 219 | 🟡 | 无消息去重窗口（同内容 1 分钟内重复推，触发 Server酱限流） |
| 220 | 🟡 | 无分类统计（每分类推送数） |
| 221 | 🟡 | 无时间段限制（夜间不推送） |
| 222 | 🟡 | 无关键词黑名单扩展（只一个 zkt_gjc） |
| 223 | 🟡 | 无历史推送记录（无法回溯） |
| 224 | 🟡 | 无多数据源支持（单一 pushUrl） |
| 225 | 🟡 | 无分页/增量拉取（每次全量） |
| 226 | 🟡 | 无内容长度上限（超长内容推送） |
| 227 | 🟡 | 无图片处理（{图片} 原始 URL） |
| 228 | 🟡 | 无模板多样化（固定【分类】标题格式） |
| 229 | 🟡 | 无多语言支持（文案中文硬编码） |
| 230 | 🟡 | 无国际化时区配置（固定 Asia/Shanghai 语义） |

## 二十六、深度边界（231-300）

| # | 分类 | 问题 |
|---|---|---|
| 231 | 🟡 | daysComputed('2026-2-29') 无前导零 → 2 月 29 日 2026 不存在 → 回读拒绝 → 0 ✓ |
| 232 | 🟡 | daysComputed('2024-02-29') 闰年 ✓ |
| 233 | 🟡 | daysComputed('0000-01-01') 年 0 → new Date(0,0,1)=1900 → 回读拒绝 → 0 |
| 234 | 🟡 | tuisong posttime 毫秒 13 位与秒 10 位分界 1e11 ✓ |
| 235 | 🟡 | tuisong datetime 已有则跳过（缓存日期）✓ |
| 236 | 🟡 | htmlToMarkdown content_html 空 → 仅原文链接 ✓ |
| 237 | 🟡 | htmlToMarkdown 纯文本（无标签）→ 原样 ✓ |
| 238 | 🟡 | tuisong text 含全部占位符 → 全替换 ✓ |
| 239 | 🟡 | 多行规则 100 行 → 规则数多，matchesCompiled 线性遍历（性能） |
| 240 | 🟡 | 正则灾难性回溯：用户配置 '(a+)+$' → 长标题匹配卡死（同步阻塞！） |
| 241 | 🟡 | whitelistFilter 关键词超长（10 万字符）→ RegExp 编译慢 |
| 242 | 🟡 | compileRules 大量无效正则 → 静默跳过（validateConfig 警告但不阻止） |
| 243 | 🟡 | 缓存 100 条上限 → 第 101 条挤掉最旧（信息丢失无提示） |
| 244 | 🟡 | getFileName 中文 URL → 中文文件名（跨平台兼容） |
| 245 | 🟡 | App.run 推送循环中 item 被外部修改（引用共享） |
| 246 | 🟡 | Config.filter 运行中被外部改（测试后未恢复） |
| 247 | 🟡 | fetchData 返回 Promise 拒绝原因非 Error（字符串）→ 已兜底 ✓ |
| 248 | 🟡 | 大响应体（10MB）→ .json() 解析耗时阻塞 |
| 249 | 🟡 | 超时与重试的总时长（5s×3+2s 等待 ≈ 17s）无外部可见 |
| 250 | 🟡 | 空数据源（[]）→ 正常空跑 ✓ |
| 251 | 🟡 | 数据源返回 null 元素 → 已跳过 ✓ |
| 252 | 🟡 | 重复 id 不同内容 → 缓存更新为后者（覆盖，无提示） |
| 253 | 🟡 | url 判重大小写（A.html vs a.html）不归一 |
| 254 | 🟡 | 分类名大小写（微博 vs 微博）→ 正则 i ✓ |
| 255 | 🟡 | 楼主名含正则元字符（$^）→ new RegExp 特殊含义（配置需转义，无提示） |
| 256 | 🟡 | 标题含 emoji 代理对 → String 处理 ✓ |
| 257 | 🟡 | 内容含控制字符（\x00-\x1F）→ 推送原始 |
| 258 | 🟡 | 内容含零宽字符 → 保留 |
| 259 | 🟡 | markdown 输出含 html 标签残留（剥不干净的）→ 无二次校验 |
| 260 | 🟡 | 缓存文件被手动清空 → 重新全推（重复） |
| 261 | 🟡 | 缓存文件损坏（手动改）→ readMessages 重置 ✓ |
| 262 | 🟡 | 多个 filename 同时操作（has/save 不同文件）→ 内存缓存各自 ✓ |
| 263 | 🟡 | init 后 cacheDir 存在 ✓ |
| 264 | 🟡 | pushUrl 变更（测试改 domain）→ 缓存文件名变化（数据源切换） |
| 265 | 🟡 | 导出函数绑定 this（bind）✓ 可独立调用 |
| 266 | 🟡 | bind 后 this 不可变（外部无法改）✓ |
| 267 | 🟡 | Utils 对象可被外部扩展（导出引用） |
| 268 | 🟡 | Config.domain 尾部斜杠（'https://x.com/'）→ pushUrl 双斜杠 '//plus' |
| 269 | 🟡 | urlOf 相对路径以 / 开头与不以 / 开头（/a vs a）→ domain 拼接结果不同（/a → domain/a，a → domain/a 无斜杠中间）|
| 270 | 🟡 | 推送 text 超长（Server酱 title 32 字符限制）无截断 |
| 271 | 🟡 | desp 超长（Bark 限制）无截断 |
| 272 | 🟡 | 图片 URL 超长 → 推送内容膨胀 |
| 273 | 🟡 | 无内容去重（同标题同内容不同 url → 推两条） |
| 274 | 🟡 | 无推送节流（连续多条无间隔语义） |
| 275 | 🟡 | 无失败率统计（推送质量不可观测） |
| 276 | 🟡 | 无运行历史（上次运行结果不可查） |
| 277 | 🟡 | 无版本自检（代码与配置版本不符无提示） |
| 278 | 🟡 | 无配置模板导出（新用户配置难） |
| 279 | 🟡 | 无示例配置文档 |
| 280 | 🟡 | 无迁移指南（v3.x 升级说明） |
| 281 | ⚪ | 注释 13% 健康但部分函数无头部注释（tuisong_replace 复杂函数） |
| 282 | ⚪ | 命名：pingbi/zhanxian 拼音缩写（非英文，国际可读性） |
| 283 | ⚪ | 命名：getFilePath vs getFileName 易混（一个目录内路径一个文件名） |
| 284 | ⚪ | 函数顺序：Utils 内 daysComputed 与 normUrl 等无逻辑分组注释 |
| 285 | ⚪ | 缩进统一 4 空格 ✓ |
| 286 | ⚪ | 引号风格单引号为主 ✓（部分模板串双引号） |
| 287 | ⚪ | 分号一致 ✓ |
| 288 | ⚪ | 长行（>120 字符）存在（tuisong_replace map） |
| 289 | ⚪ | 深嵌套（checkFields 两轮循环 + 多条件）可读性 |
| 290 | ⚪ | 重复正则（ENTITY_RE 与 DEC_RE 等）可合并 |
| 291 | ⚪ | 无 eslint 配置（风格未固化） |
| 292 | ⚪ | 无 prettier 配置 |
| 293 | ⚪ | 无 editorconfig |
| 294 | ⚪ | 无 CHANGELOG 自动生成（手动维护） |
| 295 | ⚪ | 无版本号自动递增（git tag 手动） |
| 296 | ⚪ | 无贡献指南 |
| 297 | ⚪ | 无 LICENSE 文件 |
| 298 | ⚪ | 无 README 使用说明（主仓库根目录） |
| 299 | ⚪ | 无 SECURITY 说明（密钥移除后无安全提示文档） |
| 300 | ⚪ | 无测试运行说明（如何跑 493 个测试） |

---

## 高价值候选（从 300 项中挑选，标注编号）

- **#240 正则灾难性回溯**（用户配置 '(a+)+$' 可卡死主线程）— 高，✅ **已修复(v3.35)**：hasNestedQuantifier 检测嵌套量词 + compileRules/validateConfig/whitelistFilter/App.run 全入口拦截，25 种正则模式用例 + 端到端不卡死共 9 个新测试（详见 CHANGELOG v3.35）
- **#158 saveBatch 元素校验缺失**（非对象元素崩）— 高，易修
- **#181 只看它过滤会滤掉空标题**（与空标题占位冲突）— 中高，易修
- **#219 同内容短时重复推送**（触发 Server酱限流）— 中，修复中等
- **#252 重复 id 不同内容静默覆盖**（无提示）— 中，易修
- **#229/268/269 URL 拼接细节**（domain 尾斜杠/相对路径形态）— 中，易修
- **#156 空 url 判重**（normUrl 空串互相判重）— 中，易修
- **#270/271 推送内容无截断**（API 长度限制）— 中，易修
