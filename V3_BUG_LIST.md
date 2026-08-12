# V3 修复 Bug 完整清单 (v3.245 → v3.256)

> 生成时间: 2026-08-11 | 范围: 12 个修复提交 | 修复点总数: 124

## 严重级别统计

| 级别 | 数量 |
|------|------|
| P0 | 4 |
| P1 | 20 |
| P2 | 52 |
| P3 | 48 |

## 各版本分布

| 版本 | 数量 |
|------|------|
| v3.245 | 10 |
| v3.246 | 17 |
| v3.247 | 8 |
| v3.248 | 25 |
| v3.249 | 3 |
| v3.250 | 1 |
| v3.251 | 18 |
| v3.252 | 2 |
| v3.253 | 1 |
| v3.254 | 4 |
| v3.255 | 17 |
| v3.256 | 18 |

## 完整修复清单

| # | 版本 | 提交 | 级别 | 函数 | 修复内容 |
|---|------|------|------|------|----------|
| 1 | v3.245 | d326e16 | P0 | isDangerousUrl | decode &colon; 实体绕过 (javascript&colon;alert(1)) |
| 2 | v3.245 | d326e16 | P0 | isDangerousUrl | decode &Tab;/&NewLine;/&nbsp; 实体绕过 |
| 3 | v3.245 | d326e16 | P0 | isDangerousUrl | strip unicode 空白字符 |
| 4 | v3.245 | d326e16 | P1 | safeErrorText | string 类型守卫(非字符串错误) |
| 5 | v3.245 | d326e16 | P1 | _compileCatRe | null 守卫 |
| 6 | v3.245 | d326e16 | P1 | _finalizeMd/_parseLine | stringify 守卫(String(undefined)泄漏) |
| 7 | v3.245 | d326e16 | P1 | _legacyListfilter | 递归守卫 |
| 8 | v3.245 | d326e16 | P1 | _upsert | non-array 守卫 |
| 9 | v3.245 | d326e16 | P1 | init | rethrow 异常传播 |
| 10 | v3.245 | d326e16 | P1 | _writeTextAtomic | defensive catch |
| 11 | v3.246 | bcfb037 | P2 | normUrl | O(n) 去重优化 |
| 12 | v3.246 | bcfb037 | P2 | validUrl | normalize 后复查危险协议 |
| 13 | v3.246 | bcfb037 | P2 | identity | 空 key 去重 |
| 14 | v3.246 | bcfb037 | P2 | memoSet | key normalize + warn 限流 |
| 15 | v3.246 | bcfb037 | P2 | findDedupIndex | 短路优化 |
| 16 | v3.246 | bcfb037 | P2 | regtime | dirty 透传 |
| 17 | v3.246 | bcfb037 | P2 | checkCategory | 守卫 |
| 18 | v3.246 | bcfb037 | P2 | whitelistFilter | falsy + regex 缓存上限 |
| 19 | v3.246 | bcfb037 | P2 | getFilePath | 200B 不变量 |
| 20 | v3.246 | bcfb037 | P2 | ensureFileExists | 去重 |
| 21 | v3.246 | bcfb037 | P2 | save | no-rewrite |
| 22 | v3.246 | bcfb037 | P2 | identityIndex | O(1) 查询 |
| 23 | v3.246 | bcfb037 | P2 | writeRunLog | truncate |
| 24 | v3.246 | bcfb037 | P2 | writeState | array 拒绝 |
| 25 | v3.246 | bcfb037 | P2 | readSafeText | O_NOFOLLOW TOCTOU |
| 26 | v3.246 | bcfb037 | P2 | getFileName | empty-after-clean |
| 27 | v3.246 | bcfb037 | P2 | validateCatRe | warn |
| 28 | v3.247 | 9925b74 | P2 | _upsert | no-rewrite/dirty-msg/compare 优化 |
| 29 | v3.247 | 9925b74 | P2 | init | cacheDir 单次求值 |
| 30 | v3.247 | 9925b74 | P2 | resetCache | direct memo delete |
| 31 | v3.247 | 9925b74 | P2 | matchesCompiled | 输入上限(ReDoS 防御) |
| 32 | v3.247 | 9925b74 | P2 | anonKey | id 前缀 no-degrade + compat |
| 33 | v3.247 | 9925b74 | P2 | anonKey | escape % 特殊字符(防碰撞) |
| 34 | v3.247 | 9925b74 | P2 | memoSet | LRU |
| 35 | v3.247 | 9925b74 | P2 | getFilePath | byte 截断 |
| 36 | v3.248 | 34bdfa2 | P3 | anonKey | dual-hash+single-str |
| 37 | v3.248 | 34bdfa2 | P3 | hasValidId | array 守卫 |
| 38 | v3.248 | 34bdfa2 | P3 | filterHash | trim+date-fold |
| 39 | v3.248 | 34bdfa2 | P3 | num | primitive 守卫 |
| 40 | v3.248 | 34bdfa2 | P3 | warnLowDisk | throttle-first+NaN |
| 41 | v3.248 | 34bdfa2 | P3 | checkCategory | catename |
| 42 | v3.248 | 34bdfa2 | P3 | legacyListfilter | compile 缓存 |
| 43 | v3.248 | 34bdfa2 | P3 | whitelist | ReDoS 上限 |
| 44 | v3.248 | 34bdfa2 | P3 | has | isValidItem+no-reset |
| 45 | v3.248 | 34bdfa2 | P3 | save | empty-identity |
| 46 | v3.248 | 34bdfa2 | P3 | getFileName | fallback |
| 47 | v3.248 | 34bdfa2 | P3 | isRegularOrMissing | string 守卫 |
| 48 | v3.248 | 34bdfa2 | P3 | readSafeText | maxBytes |
| 49 | v3.248 | 34bdfa2 | P3 | writeRunLog | lock |
| 50 | v3.248 | 34bdfa2 | P3 | memoSet | O(1) counter |
| 51 | v3.248 | 34bdfa2 | P3 | ENTITY_RE | metachar escape |
| 52 | v3.248 | 34bdfa2 | P3 | whitelistFilter | regex 缓存 |
| 53 | v3.248 | 34bdfa2 | P3 | invalid-regex 警告 | 统一化 |
| 54 | v3.248 | 34bdfa2 | P3 | truncated-message alert | push |
| 55 | v3.248 | 34bdfa2 | P3 | getFileName | NUL filter |
| 56 | v3.248 | 34bdfa2 | P3 | identity | trim |
| 57 | v3.248 | 34bdfa2 | P3 | identity | precompute |
| 58 | v3.248 | 34bdfa2 | P3 | html decode | rounds 3->8 |
| 59 | v3.248 | 34bdfa2 | P3 | key-order | normalize |
| 60 | v3.248 | 34bdfa2 | P3 | filter.hash | warn |
| 61 | v3.249 | 4c9b062 | P1 | _finalizeMd | undefined/null 守卫 |
| 62 | v3.249 | 4c9b062 | P1 | whitelistFilter | .test() try/catch (V8 lazy compile) |
| 63 | v3.249 | 4c9b062 | P1 | saveBatch | _readFailed 守卫(防覆盖损坏缓存) |
| 64 | v3.250 | b7a0ec5 | P1 | saveBatch | _readFailed timing hole(检查在read之前) |
| 65 | v3.251 | a567091 | P0 | sanitizeHtmlUrls | unclosed-quote XSS(href=javascript绕过) |
| 66 | v3.251 | a567091 | P2 | normalize | __proto__ 键防护 |
| 67 | v3.251 | a567091 | P2 | maxRetry | cap |
| 68 | v3.251 | a567091 | P2 | normalizeState | pending |
| 69 | v3.251 | a567091 | P2 | acc | numeric |
| 70 | v3.251 | a567091 | P2 | titleMax/contentMax | floor |
| 71 | v3.251 | a567091 | P2 | pushOne | keep |
| 72 | v3.251 | a567091 | P2 | addIndex | dedupe |
| 73 | v3.251 | a567091 | P2 | isModifier | supplementary plane |
| 74 | v3.251 | a567091 | P2 | limit | hard cap |
| 75 | v3.251 | a567091 | P3 | shallowEqual | 忽略时间戳 |
| 76 | v3.251 | a567091 | P3 | profile3Require | 修复 |
| 77 | v3.251 | a567091 | P3 | linkText | lazy 求值 |
| 78 | v3.251 | a567091 | P3 | identityIndex | stale 清理 |
| 79 | v3.251 | a567091 | P3 | NOW | monotonic |
| 80 | v3.251 | a567091 | P3 | safeCounter | int |
| 81 | v3.251 | a567091 | P3 | checkpoint | single-clock |
| 82 | v3.251 | a567091 | P3 | pushMode/keyOf/itemLogText | 修复 |
| 83 | v3.252 | 9a89e6a | P2 | sanitizeHtmlUrls | unclosed-quote 正则要求无匹配闭合引号 |
| 84 | v3.252 | 9a89e6a | P2 | NOW | monotonic 提升到 MessageStore 层 |
| 85 | v3.253 | 0932986 | P1 | NOW | _nowInc 残余 bug(时钟前进时 1002->1001 回滚) |
| 86 | v3.254 | 25fa4c8 | P0 | sanitizeHtmlUrls | onerror no-space XSS(引号闭合属性清理) |
| 87 | v3.254 | 25fa4c8 | P1 | htmlToMarkdown | 100KB 输入上限(ReDoS O(n^2)) |
| 88 | v3.254 | 25fa4c8 | P1 | hasNestedQuantifier | nested-group/[^]/bounded-repeats 检测 |
| 89 | v3.254 | 25fa4c8 | P1 | _updateReport | sync pending persist 先于 fire-and-forget send |
| 90 | v3.255 | 0909d90 | P2 | saveBatch | CAS 多进程 |
| 91 | v3.255 | 0909d90 | P2 | saveBatch | per-item serialize 隔离 |
| 92 | v3.255 | 0909d90 | P2 | saveBatch | identity cache 复用 |
| 93 | v3.255 | 0909d90 | P2 | saveBatch | timestamp 契约 |
| 94 | v3.255 | 0909d90 | P2 | _updateReport | MAX_SAFE_INTEGER |
| 95 | v3.255 | 0909d90 | P2 | cacheDir | lazy 初始化 |
| 96 | v3.255 | 0909d90 | P2 | tuisong_replace | lazy rawHtml |
| 97 | v3.255 | 0909d90 | P2 | readMessages | 64MB 上限 |
| 98 | v3.255 | 0909d90 | P2 | htmlToMarkdown | md-escape + nested-a strip |
| 99 | v3.255 | 0909d90 | P2 | validateConfig | maxSize/zkt_gjc/pingbifenlei 对齐 |
| 100 | v3.255 | 0909d90 | P2 | compileRules | ### 警告 |
| 101 | v3.255 | 0909d90 | P2 | compileRules | frozen-safe |
| 102 | v3.255 | 0909d90 | P2 | compileRules | sticky-re O(n) |
| 103 | v3.255 | 0909d90 | P2 | compileRules | pingbitime floor |
| 104 | v3.255 | 0909d90 | P2 | _finalizeMd | md-escape |
| 105 | v3.255 | 0909d90 | P2 | normalize | depth cap |
| 106 | v3.255 | 0909d90 | P2 | contentChanged | BigInt |
| 107 | v3.256 | 7a7d3a9 | P3 | sendAlert | lastAt finite |
| 108 | v3.256 | 7a7d3a9 | P3 | legacyCompileKey | JSON key |
| 109 | v3.256 | 7a7d3a9 | P3 | compileRules | type guard + pingbitime cap |
| 110 | v3.256 | 7a7d3a9 | P3 | validateConfig | ### warn + dedup keep + string guard |
| 111 | v3.256 | 7a7d3a9 | P3 | saveBatch | saveMessages check |
| 112 | v3.256 | 7a7d3a9 | P3 | saveBatch | ownKeys catch |
| 113 | v3.256 | 7a7d3a9 | P3 | saveBatch | C0 filename |
| 114 | v3.256 | 7a7d3a9 | P3 | readMessages | verified-flag |
| 115 | v3.256 | 7a7d3a9 | P3 | updateReport | truncated label + enabled case-insensitive |
| 116 | v3.256 | 7a7d3a9 | P3 | normalize | depth cap |
| 117 | v3.256 | 7a7d3a9 | P3 | capReInput | codepoint |
| 118 | v3.256 | 7a7d3a9 | P3 | contentChanged | BigInt |
| 119 | v3.256 | 7a7d3a9 | P3 | removeIdentityIndexes | map cleanup |
| 120 | v3.256 | 7a7d3a9 | P3 | writeState | guard |
| 121 | v3.256 | 7a7d3a9 | P3 | identity | precompute |
| 122 | v3.256 | 7a7d3a9 | P3 | html decode | rounds |
| 123 | v3.256 | 7a7d3a9 | P3 | getFileName | NUL |
| 124 | v3.256 | 7a7d3a9 | P3 | pingbitime | cap |

---

## 审查勘误（2026-08-12，124-agent 子代理审查结果）

> 用 git show 对照每个提交的真实 diff 后，以下条目的「版本/提交」归属与事实不符或有虚构，仅供后续参考时注意。

### A. 归类错误（改动实际在更早提交，非清单标注的提交）

| 编号 | 清单标注 | 实际来源 |
|------|---------|---------|
| 033 | v3.247 9925b74 anonKey escape % | v3.243 59b7a0d（%5C/%7C 转义） |
| 035 | v3.247 9925b74 getFilePath byte 截断 | 9925b74 无此 hunk；截断逻辑在更早提交 |
| 051 | v3.248 34bdfa2 ENTITY_RE metachar escape | 34bdfa2 无此 hunk |
| 052 | v3.248 34bdfa2 whitelistFilter regex 缓存 | v3.239 8611206 引入 |
| 053 | v3.248 34bdfa2 invalid-regex 警告统一化 | v3.239 口径 |
| 055 | v3.248 34bdfa2 getFileName NUL filter | 父提交已存在（6bdc8a3 v3.242 相关） |
| 057 | v3.248 34bdfa2 identity precompute | 34bdfa2 无此 hunk |
| 058 | v3.248 34bdfa2 html decode rounds 3->8 | v3.242 6bdc8a3 |
| 093 | v3.255 0909d90 saveBatch timestamp 契约 | NOW 单调在 v3.252 9a89e6a / v3.253 0932986 |
| 094 | v3.255 0909d90 _updateReport MAX_SAFE_INTEGER | v3.251 a567091 |

### B. 虚构条目（声称的改动在当前代码中不存在）

| 编号 | 声称 | 现状 |
|------|------|------|
| 090 | saveBatch CAS 多进程 | 当前 saveBatch 仍为 readMessages→合并→saveMessages 全量覆写，无 CAS/锁 |
| 091 | saveBatch per-item serialize 隔离 | 无 |
| 092 | saveBatch identity cache 复用 | saveBatch 每次自建批内索引，未复用 _identityIndex |
| 095 | cacheDir lazy 初始化 | 无 _cacheDir 字段 |
| 096 | tuisong_replace lazy rawHtml | L1043 仍急切求值 |

### C. 子代理误报（实测不复现 / 已被后续提交修复）

| 编号 | 说明 |
|------|------|
| 065 | 实测合法闭合 href 不受影响（v3.252 已修正则） |
| 084 | 当前代码已是 v3.253 严格单调版 |

### D. 真实代码问题（已在 v3.257 修复 3 项，其余待评估）

| 编号 | 级别 | 问题 | 状态 |
|------|------|------|------|
| 089 | P1 | _updateReport 发送成功后今日统计双重计数 | ✅ v3.257 ee740f4 修复 |
| 086 | P2 | sanitizeDecodedHtml 误伤引号值内 on 开头合法 URL | ✅ v3.257 ee740f4 修复 |
| 049 | P2 | writeRunLog 锁失败仍截尾（与 fail-open 注释不符） | ✅ v3.257 ee740f4 修复 |
| 073 | P3 | truncateUtf16 区域指示符误删旗帜 emoji（A🇨🇳→''） | ✅ 已修复（子代理，v3.257） |
| 018 | P3 | whitelistFilter 空串被 '.*' 等正则命中 | ✅ 已修复（子代理，v3.257） |
| 098 | P3 | htmlToMarkdown nested-a 剥离误删字面 &lt;a&gt; 文本 | ✅ 已修复（子代理，v3.257） |
| 110 | P3 | validateConfig 移除去重（与声称的 dedup keep 相反） | ✅ 已修复（子代理，v3.257） |
| 114 | P3 | _verified 恢复失败也标记已验证（不再重试恢复） | ✅ 已修复（子代理，v3.257） |
| 109 | P3 | compileRules 类型守卫漏 boolean/bigint（与 validateConfig 不一致） | ✅ 已修复（子代理，v3.257） |
| 031 | P3 | _capReInput 截断改变超长文本 $ 锚点/关键词匹配语义 | 设计取舍（ReDoS 防御） |
| 036 | P3 | anonKey 64 位破坏旧 32 位缓存身份 → 升级一次性重复推送 | 设计取舍（碰撞率 vs 稳定键） |
| 041 | P3 | checkCategory 传 catename 修复不可达（pingbifenlei 永不编译 multi） | 改动无害，问题在上游已禁用 |
| 025 | P2 | readSafeText O_NOFOLLOW 后按路径重读（TOCTOU 未根除） | xbk_storage.js 既有边界，需 fd 方案 |
