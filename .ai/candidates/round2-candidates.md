# Round2 候选裁判表（55 候选 → 聚类 45 → 裁判六类）

> 依据 .ai/README.md 规范：观察者只读报告（8 份，.ai/reports/round-2/）→ 聚类 → 中央裁判（源码+实测）

## CONFIRMED（14 个，进入修复队列）

| 候选 | 级别 | 函数 | 问题 | 实测证据 |
|------|------|------|------|---------|
| C-001 | P1 | sanitizeDecodedHtml | 事件属性清洗单次 replace 残留后续 on* 属性 | `<img onerror="a"onclick="b">` → onclick 残留 |
| C-005 | P1/P2 | readMessages | 损坏/不可读缓存返回 [] → 判重放行 + save 拒写 → 重复推送轰炸 | 损坏 JSON 实测返回 [] |
| C-008 | P1/P2 | htmlToMarkdown | anchor/alt 文本未转义 → Markdown 注入 | `[foo](javascript:alert(1))](https://x.com)` |
| C-002 | P2 | sanitizeDecodedHtml | 主动标签正则 O(n²) ReDoS | 2 万字符 `<script ` 耗时 8.1s |
| C-006 | P2 | getMessageIdentity/safeObjectCopy | 继承属性 id 判重 vs 落盘丢 id → 重复入库 | Object.create({id}) 实测 has 不命中 |
| C-007 | P2 | _legacyCompileKey | 字符串/对象同缓存键击穿（compileRules 类型守卫后） | 先字符串后对象：对象被错误拦截 |
| C-009 | P2 | isDangerousUrl | &Colon;/&COLON;/&amp;colon; 变体绕过危险协议检查 | safeUrl 实测放行 |
| C-010 | P2/P3 | sanitizeDecodedHtml | style CSS 转义（u\72l/expression）绕过黑名单 | style="u\72l(javascript:…)" 残留 |
| C-011 | P2 | tuisong_replace | eager rawHtml（模板无 {Html内容} 仍全量清洗） | 5 万字符 8.7s（= round1 声称未实现的 lazy 修复） |
| C-013 | P3 | matchesCompiled | 字段值 0/false 视为缺失（与 whitelistFilter 不一致） | matchesCompiled(c, 0) 不匹配 /0/ |
| C-015 | P3 | filterHash | 类型归一与 compileRules 不一致 → 缓存不失效 | 代码核对 |
| C-016 | P3 | _sendAlert/_updateReport | alert/report enabled 口径不一致（精确 vs trim+lower） | 代码核对 |
| C-017 | P3 | parseTime | 时区/斜杠日期走宿主解析 → 非法日期口径不一致 | 代码核对 |
| C-018 | P3 | truncateUtf16 | ZWJ 二次删除 | 'a\u200Db',2 → ''（应为 'a'） |
| C-022 | P3 | cacheDir | 应急路径 .xbk_cache_safe 无 realpath 校验（符号链接逃逸） | 代码核对 |
| C-024 | P3 | saveBatch | 内容一致仍刷新 timestamp + 落盘（与 _upsert 不一致） | 代码核对 |
| C-025 | P3 | _upsert/saveBatch | timestamp 不共享单调状态 | 代码核对 |
| C-030 | P3 | Pusher.send | htmlLike 正则 O(n²) | 4 万字符 5.3s |
| C-036 | P3 | safeErrorText | throw 0/false/Symbol 原始值被吞 | 代码核对 |
| C-038 | P3 | 过滤链路 | 零宽字符未归一（URL 链路已剥离，过滤未） | 代码核对 |
| C-040 | P3 | App.run | SUPPORTED_TPL_KEYS 缺 {价格} 等（误报警告） | 代码核对 |
| C-041 | P3 | App.run | it._f 直接赋值（frozen 对象抛错，他处用 safeSet） | 代码核对 |
| C-042 | P3 | App.run | MessageStore.init() 在 try 外（异常跳过 finally） | 代码核对 |
| C-043 | P3 | _writeRunLog | 异常消息无长度截断 | 代码核对 |
| C-045 | P3 | htmlToMarkdown | [^>]* 遇引号内 > 截断标签 | `<h1 title="a>b">` → `# b">text` |
| C-046 | P3 | htmlToMarkdown | 100k 截断无代理对保护 | 代码核对 |
| C-047 | P3 | compileRules | 类型守卫漏 function | 代码核对 |
| C-048 | P3 | validateConfig/compileRules | trim 口径不一致 | 代码核对 |
| C-049 | P3 | pingbitime 多行 | 校验与编译三处口径差 | 代码核对 |
| C-050 | P3 | whitelistFilter | 非字符串 keyword 与 App.run 不一致 | 代码核对 |
| C-051 | P3 | whitelistFilter/App.run | 空标题语义不一致 | 代码核对 |

## DESIGN（架构边界/设计取舍，记录不修）
C-019（alert/report state 无跨进程锁）、C-023（getFileName 末段缓存名设计）、C-031（retry 9999 配置边界）、C-034（出口统一 HTML 清洗误伤 Markdown 代码块——安全设计）、C-037（循环引用 deep 比较——既有取舍）、C-039（告警共用限频桶）、C-044（日报 fire-and-forget——pending 持久化兜底）

## REJECTED / LOW_VALUE（未复现或影响极小）
C-004（V8 26 未复现 lazy-compile 抛错）、C-020（anonKey hex 拼接纯理论）、C-026/027/028/029（MessageStore 防御性理论项）、C-032（Retry-After 增强）、C-033（timeout 正数校验）、C-035（Pusher String() 防御）、C-052（compileRules 静默忽略——validateConfig 已告警）

## DUPLICATE
C-012（_capReInput 截断语义 = round1 DESIGN-001）
