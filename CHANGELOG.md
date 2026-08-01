# 📋 更新日志

## v3.69（推送截断可配置 + desp 兜底截断修复）
> 2026-08-01

### ✨ Config.push.titleMax / contentMax（截断长度可配置）

- **背景**：截断长度硬编码（title 100 / content 3000）；注释提到 Server酱 title 限 32 字符但无法配置
- **新增**：`Config.push.titleMax`（标题，默认 100）/ `Config.push.contentMax`（内容，默认 3000）；非法值（负数/0/非数字）回退默认（负数会让 truncateUtf16 的 slice(0,-1) 误截尾字符）
- test_app t49：titleMax=5/contentMax=4 生效 + 非法值回退

### 🐛 desp 兜底截断（{Markdown内容} 从不截断的真实 bug）

- **发现**（t49 测试暴露）：原 3000 截断只作用于 pushItem.content（{内容} 占位符），而 `{Markdown内容}` 走 content_html → htmlToMarkdown 转换**从不截断**——超长 HTML（如 10 万字符）会生成超长 desp 撑爆推送 API（Server酱 32KB 上限）
- **修复**：desp 生成后兜底截断（`truncateUtf16(desp, contentMax)`），contentMax 语义统一为「推送内容最终长度」；默认 3000 下正常 desp 不受影响（<3000 不截断），超长才截断
- 现有测试零回归（默认 desp 均 <3000）

### 🧹 test_app 测试自清理正则修复

- `/^t\d{2}_/` 不匹配 `t48b_template_fallback.json`（带字母后缀的测试名）→ 缓存文件残留；改为 `/^t\d{2}[a-z]?_/`，跑完缓存目录零残留

### 🧪 测试数

**641 个全绿（单元 568 + 集成 57 + 通道 16）**

## v3.68（推送模板可配置）
> 2026-08-01

### ✨ Config.template 推送模板（功能缺口补全）

- **背景**：推送格式硬编码——标题 `'【{分类名}】{标题}'`、内容 `'{Markdown内容}'`，用户无法自定义（如把链接/日期加进标题、改用纯文本）
- **新增**：`Config.template.title` / `Config.template.content`，支持全部占位符（{分类名} {分类ID} {标题} {链接} {日期} {时间} {楼主} {类目} {价格} {商城} {品牌} {图片} {Html内容} {Markdown内容}）
- **默认值 = 历史硬编码完全一致** → 现有测试全部锁定默认行为，零回归
- **容错**：模板缺失/非字符串 → 回退默认（tuisong_replace 本身已防御非字符串模板）
- test_app 新增 t48：自定义模板生效（占位符全替换）+ 非法模板回退默认

### 🧪 测试数

**640 个全绿（单元 568 + 集成 56 + 通道 16）**

## v3.67（whitelistFilter 非法正则口径统一）
> 2026-08-01

### 🔧 whitelistFilter 非法正则 → 放行（原为拦截）

- **发现**：`whitelistFilter` 独立导出对**非法正则** catch 返回 `false`（拦截 = 只看它把全部数据滤掉，清空推送），而 **ReDoS 风险正则**返回 `true`（放行）——自相矛盾；且与 App.run 主路径口径相反（主路径 zkt_gjc 预编译失败 kwRe=null → **不过滤放行**，v3.16 锁定）
- **修复**：非法正则 → 放行（return true），与 ReDoS 分支、App.run 预编译失败口径三方统一，符合「宁可多推不可少推」哲学（配置错误 = 缺信息 = 保守放行）
- **风险**：行为变更（独立调用场景）；两个测试同步更新（「无效正则 → false」改「→ 放行」，锁定新行为）；App.run 主路径行为不变（本来就是放行）
- 决策记录已写入 REVIEW_DECISIONS

### 🧪 测试数

**639 个全绿（单元 568 + 集成 55 + 通道 16）**

## v3.66（运行日志增强：失败记录 + 大小上限）
> 2026-08-01

### 📝 run.log 增强（v3.65 功能的完整性补全）

- **失败记录**：App.run 的 catch 分支也写 `ERROR <原因>` 行（错误信息去换行避免破坏日志行）——cron 场景可回溯失败原因，此前失败运行在 run.log 中无痕
- **大小上限**：抽 `App._writeRunLog` helper（成功/失败共用）；超过 1MB 截断保留尾部 512KB（防长期运行无限增长；读-截-写都在 try-catch 内，失败静默）
- test_app 新增 t47：4xx 失败 → run 抛错 → run.log 记录 ERROR 行（测试前清文件确保断言本测试行）

### 🧪 测试数

**639 个全绿（单元 568 + 集成 55 + 通道 16）**

## v3.65（运行摘要持久化·文档同步）
> 2026-08-01

### 📝 运行摘要持久化 run.log

- **背景**：App.run 返回摘要（total/dedup/filtered/pushed/failed）只 console.log，cron 场景无法回溯历史运行/失败趋势
- **新增**：每次运行摘要追加到缓存目录 `xianbaoku_cache/run.log`（gitignore，不入库），格式 `ISO时间 total=.. dedup=.. filtered=.. pushed=.. failed=..`
- **容错**：写日志 try-catch 静默（磁盘只读/权限异常不中断推送主流程）
- test_app 新增 t46：run.log 创建 + 摘要字段完整 + pushed 数正确（测试后清理，不污染真实日志）

### 📚 文档同步

- **REVIEW_DECISIONS**：当前状态更新（638 测试/~1310 行/自主进化 4 轮）；新增「v3.62~v3.65 自主进化补充取舍」节（#29 query 口径 / #31 默认端口 / #39 哈希碰撞 / #40 拼接歧义 / #22 时区 / #15-16 类型误用——均记录不修理由）；新增「自主进化记录」节
- **FILE_INDEX**：test_filter 测试数 564→568

### 🧪 测试数

**638 个全绿（单元 568 + 集成 54 + 通道 16）**

## v3.64（运行时配置校验补全·版本一致性自检）
> 2026-08-01

### 🔧 运行时数值配置校验（#7 同款精神：函数层防御 + 配置层提示）

- **新增 App.run 启动校验**：`api.timeout`（需 >0 有限数）、`api.retry`（需 ≥0 整数）、`timing.pushInterval`/`finalWait`（需 ≥0 有限数）、`push.parallelLimit`（需 ≥0 有限数）——非法值 console.warn 提示，不改变运行行为（函数层已有防御：got timeout 归一 v3.54 / retry 负值兜底 v3.45 / parallelLimit 取整 v3.52）
- test_app 新增 t45 集成测试：5 项非法值全部警告 + 合法值不警告（stub console.warn + finally 恢复配置，防跨测试污染）

### 🔍 版本一致性自检测试（101 章）

- **背景**：v3.35 曾出现 CHANGELOG「v3.8（当前最新）」过时误导——版本号靠人工维护易漏
- **新增测试**：读 `xbk_function_v3.js` 文件头版本号与 `CHANGELOG.md` 顶部版本号，断言一致（跑测试即自动检查）

### 🧪 测试数

**637 个全绿（单元 568 + 集成 53 + 通道 16）**

## v3.63（审查项 #56/#65/#7 批量）
> 2026-08-01

### 🐛 #56：img 空 src 生成 `![]()` 空图片

- `<img src="">` / `<img src="   ">`（纯空白）曾生成 `![]()` 空图片链接
- **修复**：src trim 后为空 → 不转换（与无 src 同口径，标签被剥离为空白）；src 首尾空白 trim 后使用
- 100 章新增测试（空/纯空白不生成、正常/带空白 src 正常转换）

### 🐛 #65：url 含换行破坏 Markdown 链接

- url 含 `\n`/`\r\n` 时链接文本 `[url]` 与目标 `(url)` 均被裸换行破坏（原 `<>` 包裹不解决换行）
- **修复**：`htmlToMarkdown` 开头统一剥离 urlText 换行（`[\r\n]+` → ''），链接文本与目标共用干净的 urlText（剥离后通常不再触发 `<>` 包裹）
- 100 章新增测试（LF/CRLF 剥离、无换行不受影响）

### 🔧 #7：cache.maxSize 配置层无校验

- v3.31 只在 MessageStore 函数层回退默认 100，配置层无提示（用户配错静默）
- **修复（双保险）**：`validateConfig` 支持 `cfg.cache.maxSize`/`cfg.maxSize` 校验（非正整数 → 警告）；App.run 启动时对 `Config.cache.maxSize` 兜底警告（validateConfig 只接收 filter 的路径）
- 100 章新增测试（负数/0/小数/非数字警告、正整数不警告）

### 🧪 测试数

**635 个全绿（单元 567 + 集成 52 + 通道 16）**

## v3.62（日期解析统一·消除重复逻辑）
> 2026-08-01

### 🔧 REVIEW_ROUND10 #26：daysComputed / tuisong_replace 日期解析两份重复逻辑统一

- **背景**：`daysComputed`（天数组件）与 `tuisong_replace`（占位符组件）各自实现了一份时间解析，v3.46/v3.47 为对齐两者反复打补丁（ISO/8位日期/范围），本质是重复代码在漂移——第 3 次不一致只是时间问题
- **修复**：抽 `Utils.parseTime(time)` 单例（返回毫秒时间戳，无效返回 null），两份组件共用同一口径：
  - 空 → null；纯数字/数字类型：8 位 YYYYMMDD（月份日期合法性+回读校验）> 秒/毫秒时间戳（0 或 1e8~1e14，TS_BOUND 分界）> 范围外 → null
  - YYYY-MM-DD（1~2 位月日，锚定结尾，回读校验拒绝 2026-02-31）> 回读失败 → null
  - ISO/其他（宿主解析，先原生支持 ISO 再退 / 分隔）> 失败 → null
- **行为对齐细节**：数字类型（含 -1 等负值）统一走数字分支判无效——原 `tuisong_replace` 对 `-1`（number）留空但 `daysComputed` 对 `-1` 会掉进宿主解析被 `new Date('-1')` 解析成 2001-01-01（怪异行为），现统一为无效（0/留空），无测试锁定旧行为
- **调用方映射**：`daysComputed` 把 null → 0；`tuisong_replace` 把 null/负 ms → 日期留空（不生成 1969/2001 误导日期）
- **验证**：632 个测试全绿（单元 564 + 集成 52 + 通道 16），重构前先备份（/tmp/xbk_function_v3.js.bak_v361_pre_parseDate）

### 🧪 测试数

**632 个全绿（单元 564 + 集成 52 + 通道 16）**

## v3.61（内存泄漏防御·当前最新）
> 2026-08-01

### 🐛 _memoryCache 理论无限增长

- **`_memoryCache` 按文件名无限累积**（REVIEW #2 已知取舍：真实场景 pushUrl 固定仅 1 个 key；但 pushUrl 变化等边界会增长）
- **压测实证**：100 次 run +0.3MB / 10000 次格式化 +0.1MB（无泄漏）；1000 个不同文件 +0.7MB（增长面确认）
- **修复**：新增 `_memoSet` 带 **100 上限**（超限整体重置，磁盘缓存为权威不受影响），应用于全部 4 处写入
- 新增内存缓存上限测试

### 🧪 测试数

**632 个全绿（单元 564 + 集成 52 + 通道 16）**

## v3.60（故障注入·序列化崩溃修复）
> 2026-08-01

### 🐛 循环引用 message 序列化崩溃

- **`saveMessages` 的 `JSON.stringify` 在 try 块外** + **`_upsert` 的 `JSON.stringify` 比较**——循环引用 message 曾直接崩溃（`Converting circular structure to JSON`）
- **修复**：序列化失败容错（内存缓存保留、不落盘不崩溃）/ 比较失败按"已更新"处理
- 92 章新增循环引用注入测试（saveMessages + saveBatch）
- got 非法 URL 已确认异步 reject（通道层容错 ✓）

### 🧪 测试数

**631 个全绿（单元 563 + 集成 52 + 通道 16）**

## v3.59（日志脱敏全覆盖）
> 2026-08-01

### 🔐 日志脱敏全覆盖

- **wxpusher/息知异常日志曾打整个响应对象**：异常响应可能回显请求参数（含 token）→ 改为摘要（`msg` 或 `JSON.stringify` 截断 200）
- **新增真实路径脱敏测试**：stub `console.log` + 4 通道配置（Server酱/wxpusher/息知/Bark），断言完整 key/token/设备码/URL **不出现在日志** + Bark 出现脱敏形式（`api.day.app/DEVI***ET`）
- 全通道日志逐一核查：Bark/PushMe 脱敏、wxpusher/息知摘要、其余打 err/msg/description 均无密钥

### 🧪 测试数

**630 个全绿（单元 562 + 集成 52 + 通道 16）**

## v3.58（边界精确值批量）
> 2026-08-01

### 🧪 99 章：边界精确值锁定（4 个测试）

- **TS_BOUND(1e11) 精确分界**：10 位秒(2001)/11 位秒(≈3171 年未来→0)/1e11 本身(1973 毫秒)/12-13 位毫秒
- **normUrl 极端**：`http://` 残留(#27 已知)/`///`→空/query 保留(#29 已知)/首尾斜杠
- **pingbitime 边界**：0 不拦截/99999 拦截所有/负数→value0
- **编码边界**：hex 大小写/最大码点 0x10FFFF/超范围保留/代理区保留/NUL 过滤

行为全部正确（无 bug），批量补测试锁定。

### 🧪 测试数

**629 个全绿（单元 562 + 集成 52 + 通道 15）**

## v3.57（依赖安全·响应体上限）
> 2026-08-01

### 🔐 自制 got 响应体大小限制

- **恶意/异常接口超大响应曾无限读入内存**（内存暴涨风险）；新增 `maxBody` 限制（默认 20MB，可配 `options.maxBody`），超限报 `EBODYLIMIT`
- 97 章新增响应体超限测试
- 依赖面确认：**零第三方依赖**（node_modules 仅自制 got，只用 http/https 内置模块）→ npm 供应链漏洞面为零

### 🧪 测试数

**625 个全绿（单元 558 + 集成 52 + 通道 15）**

## v3.56（安全·日志密钥脱敏）
> 2026-08-01

### 🔐 日志密钥脱敏（信息泄露修复）

- **Bark 日志曾打印完整 `pushUrl`**（含 deviceKey）、**PushMe 日志曾打印明文 KEY**——cron 日志重定向/分享时会泄露密钥
- **新增 `maskKey`（保留首尾+`***`）/ `maskUrl`（host 保留+设备码段脱敏）**，应用于 Bark/PushMe 日志
- 其余 7 通道日志已逐通道核查无密钥
- 导出 `maskKey`/`maskUrl` + 脱敏测试（test_notify 15 个）

### 🧪 测试数

**624 个全绿（单元 557 + 集成 52 + 通道 15）**

## v3.55（错误注入双故障修复）
> 2026-08-01

### 🐛 readMessages 双故障崩溃

- **read+write 同时故障曾崩溃**：`_ensureFileExists`（文件不存在时 `writeFileSync` 抛错）在 readMessages 的 try 块**外**逃逸；`_resetCache` 的 `writeFileSync` 抛错同样逃逸——磁盘故障+IO 故障叠加时整个读缓存路径崩
- **修复**：`_ensureFileExists` 与 `_resetCache` 内部均容错（打印错误不逃逸），双故障下仍返回 `[]`
- **92 章扩展 4 个故障注入测试**：双故障 / `renameSync` 抛错（tmp 清理）/ `mkdirSync` 抛错（init）/ `readdirSync` 抛错（清理）

### 🧪 测试数

**623 个全绿（单元 557 + 集成 52 + 通道 14）**

## v3.54（异常路径批量）
> 2026-08-01

### 🔧 got timeout 归一防御

- **`timeout=0/负数/非数字` 回退默认 15s**：`options.timeout || 15000` 的 falsy 分支语义不清（0 若传 http.request 表示无超时，误配会挂死）；改为 `Number.isFinite && > 0` 显式归一

### 🧪 98 章：异常路径批量测试（5 个）

- **未知占位符 `{不存在}` 保留原文**（不误替换）
- **对象字段不崩**（category_name JSON 化 / louzhuregtime→0 / posttime→空 / url String 化）
- **重定向循环停止**（redirects 耗尽返回 3xx，不无限循环）
- **连接拒绝 ECONNREFUSED**（供 fetchData 重试）
- **timeout=0/负数/非数字归一**（正常响应不受影响）

### 🧪 测试数

**619 个全绿（单元 553 + 集成 52 + 通道 14）**

## v3.53（push.mode 防静默降级）
> 2026-08-01

### 🔧 push.mode 非法值防静默降级

- **`'PARALLEL'`/拼错等曾静默走顺序模式**：无警告、无测试——用户以为并行实际顺序（配置意图被静默违背）
- 加 `console.warn` 提示（应为 sequential/parallel，已按顺序执行）
- 新增测试：非法值按顺序推送全部且**不修改用户配置**

### 🧪 测试数

**614 个全绿（单元 548 + 集成 52 + 通道 14）**

## v3.52（parallelLimit 防御）
> 2026-08-01

### 🔧 parallelLimit 小数防御

- **小数 `parallelLimit`（如 0.5）曾产生大量空批**：`items.slice(i, i+0.5)` 的 ToInteger 截断 → 空批 + 批间等待（功能不丢数据但性能差）；已取整（`Math.floor`）
- 0/负数回退全量、空 items 兜底 1
- 新增 `parallelLimit=2.5` 测试（取整为 2、5 条全推、摘要正确，51 个）

### 🧪 测试数

**613 个全绿（单元 548 + 集成 51 + 通道 14）**

## v3.51（表格转换·数字修正）
> 2026-08-01

### ✨ htmlToMarkdown 表格转换

- **`<td>`/`<th>` 单元格 ` | ` 分隔、`<tr>` 行换行、`<table>` 双换行**——曾全部粘连成"甲乙丙丁"无分隔
- 新增表格转换测试（td/th 分隔、行分离、无标签残留）

### 🧪 测试

- **listfilter 旧调用兼容测试**（字符串配置走 `_legacyListfilter` 自动编译）
- **修正测试撞名**：「楼主强化屏蔽不匹配 → 强制展现生效」×2 改名为精确描述（两处覆盖不同子场景）
- **数字修正**：test_filter 546 → **548**、总计 **612**（此前记录 610 为旧数）

**612 个全绿（单元 548 + 集成 50 + 通道 14）**

## v3.50（非 JSON 响应重试测试）
> 2026-08-01

### 🧪 测试盲区补齐

- **非 JSON 接口响应重试路径**：真实 got 的 `.json()` 对非 JSON body（如 HTML 502 页）会抛错 → fetchData 重试；test_app 的 mock `.json()` 曾永不抛，掩盖该行为
- mock 加 `failNonJson` 模式 + 新增测试（接口首次返回非 JSON → 重试 → 成功推送，50 个）

### 🧪 测试数

**610 个全绿（单元 546 + 集成 50 + 通道 14）**

## v3.49（Telegram 通道实现）
> 2026-08-01

### ✨ Telegram 通道（曾为死配置）

- **TG_BOT_TOKEN/TG_USER_ID 等配置项存在但从未实现/调用**：用户只配 TG → 报「未配置任何推送通道」（与 v3.34 死通道同类）；现已实现 `tgNotify`
- **实现**：Telegram Bot API `sendMessage`（chat_id / text 标题+内容 / parse_mode=Markdown / 禁网页预览 / TG_API_HOST 自定义 / TG_PROXY_* 保留说明）
- **hasChannel 与 Promise.all 接入**（token+chat_id 需齐备才算通道）
- **test_notify CHANNEL_KEYS 补 TG_\***（修复跨测试泄漏）+ 新增 2 个 TG 测试（12 → 14）
- **通道数：8 → 9**

### 🧪 测试数

**609 个全绿（单元 546 + 集成 49 + 通道 14）**

## v3.48（htmlToMarkdown 列表/粗体/斜体）
> 2026-08-01

### ✨ htmlToMarkdown 结构转换补齐

- **`<li>` 列表项曾粘连**：`<li>苹果</li><li>香蕉</li>` → `苹果香蕉`（无分隔，可读性差）；现转 `- ` 前缀列表
- **`<b>/<strong>` → `**粗体**`、`<i>/<em>` → `*斜体*`**（曾剥成纯文本丢样式）
- `<ul>/<ol>` → 换行分隔
- 新增转换测试 + 更新「Markdown内容」快照（`<b>粗</b>` → `**粗**`）

### 🧪 测试数

**607 个全绿（单元 546 + 集成 49 + 通道 12）**

## v3.47（tuisong 时间解析口径对齐）
> 2026-08-01

### 🐛 tuisong_replace 时间解析三处不一致（与 daysComputed 对齐）

- **8 位日期 `20260731` 曾当秒时间戳 → `'1970-08-23'`**（daysComputed 正确解析为 2026-07-31）——补 8 位 YYYYMMDD 分支（含非法日期校验）
- **超大数字（≥1e14）无范围限制 → `'33658-09-27'`**（daysComputed 有 1e14 上限）
- **小数字（<1e8）当秒 → `'1970-01-01'` 误导日期**（daysComputed 视为无效）
- 修复：与 daysComputed 口径一致（8 位日期优先 / `0` 或 `1e8~1e14` 时间戳范围 / 其余视为无效）
- 更新「{时间}」测试（原 `posttime:60` 当秒的旧行为修正为有效时间戳）+ 新增 8 位/范围测试

### 🧪 测试数

**606 个全绿（单元 545 + 集成 49 + 通道 12）**

## v3.46（tuisong ISO 时间解析）
> 2026-08-01

### 🐛 tuisong_replace ISO 时间字符串解析失败

- **`{日期}`/`{时间}` 对 ISO 恒空**：`new Date(s.replace(/-/g,'/'))` 把 `2026-08-01T00:00:00Z` 破坏成 `2026/08/01T00:00:00Z` → 解析失败（v3.22 修过 `daysComputed` 的 ISO，`tuisong_replace` 是独立路径漏了）
- **修复**：先原生 `new Date(s)`（支持 ISO），失败再退 `/` 分隔（与 daysComputed 口径一致）
- **测试**：ISO / ISO+Z（UTC）/ `/` 分隔三种格式

### 🧪 测试数

**605 个全绿（单元 544 + 集成 49 + 通道 12）**

## v3.45（消除静默吞异常）
> 2026-08-01

### 🔧 catch 全面审计（原则：不静默吞异常）

- **`$.post`/`$.get` 的 `JSON.parse` 失败**：补注释明确为预期路径（非 JSON 响应保留原始字符串供通道解析）
- **`compileRules` 非法正则 catch**：补注释（预期：规则跳过，`validateConfig` 已负责警告）
- **`fetchData` 重试耗尽 `throw lastErr`**：补防御——`retry` 为负时循环不执行 → `lastErr` undefined → 曾 `throw undefined`；改为 `throw lastErr || new Error('请求失败（未知错误）')`
- 其余 catch 审计确认：全部为「记录日志」「重新抛出」或「有注释的预期路径」（缓存重置/推送失败/一言失败/CLI exit(1) 等）

### 🧪 测试数

**604 个全绿（单元 543 + 集成 49 + 通道 12）**

## v3.44（密钥加载警示·字段映射对称）
> 2026-08-01

### 🐛 push_config.local.js 加载失败静默吞错

- **语法错误/导出异常的 local 文件被 `catch{}` 吞掉 → 密钥全失效且无提示**（用户以为配好推送，实际全部失败且难定位）；改为**文件存在才加载 + 失败显式警告**（文件不存在仍静默 = 克隆者未配置的正常场景）

### 🐛 category_id → cateid 映射缺失

- **`{分类ID}` 占位符恒空**：归一化只做 `category_name → catename`，接口若返回 `category_id` 则 `cateid` 从未映射（不对称）；已在 tuisong_replace 与 App.run 两处补齐
- test_app 新增 category_id 映射测试（49 个）

### 🧪 测试数

**604 个全绿（单元 543 + 集成 49 + 通道 12）**

## v3.43（id 判重收紧）
> 2026-08-01

### 🐛 布尔/对象/Symbol id 误合并

- **`String(false)='false'` 非空被判有效 id**：`hasValidId` 曾对布尔/对象/数组/Symbol/NaN id 一律判有效 → 两条不同数据（url/title 均不同）因 id 同为 `false` 被**误合并成 1 条**——v3.20 修的 `id:null` 是同类问题的漏网，顺带解决 REVIEW_ROUND10 #34（布尔）/ #35（对象）/ #36（Symbol）
- **修复**：`hasValidId` 仅接受非空字符串与有限数字（`Number.isFinite`），其余类型一律无效 → 走 url 判重
- **测试**：布尔/对象/Symbol id 各存 1 条不误合并；数字 0/字符串仍有效；NaN/空串无效

### 🧪 测试数

**603 个全绿（单元 543 + 集成 48 + 通道 12）**

## v3.42（UTF-16 安全截断）
> 2026-08-01

### 🐛 推送截断切断 emoji 代理对

- **`slice(0,100)`/`slice(0,3000)` 在奇数码元处切断代理对**：title/content 截断按 UTF-16 码元切，遇到 emoji（代理对）可能切出**孤立高代理 → 半个乱码字符**（91 章 Unicode 测试覆盖了解码/判重但漏了截断边界）
- **新增 `truncateUtf16`**：代理对感知截断（末尾高代理→退一位；孤立低代理→退一位；配对完整→保留），应用于 pushOne 的 title(100)/content(3000)
- **测试**：Unicode 截断测试（奇/偶码元、中文 BMP、不超限）；导出 33 键（契约 32→33）

### 🧪 测试数

**602 个全绿（单元 542 + 集成 48 + 通道 12）**

## v3.41（got 重定向隐蔽缺陷）
> 2026-08-01

### 🐛 got 协议相对重定向缺陷（自制模块）

- **`Location: //host/x` 被拼成 `origin//host/x` → 404**：重定向处理只识别 `http(s)` 开头，协议相对 URL 被错误拼接；且修复后 `new URL('//x')` 无 base 会抛 `Invalid URL`——补 `http:` 前缀
- **97 章新增协议相对重定向测试**（本机 server 验证 200 跟随）

### 🧪 测试数

**601 个全绿（单元 541 + 集成 48 + 通道 12）**

## v3.40（一言修复·息知测试）
> 2026-08-01

### 🐛 一言 `one()` 永远不生效的 bug

- **`JSON.parse(res.body)` 对已解析对象崩溃**：自制 got 自动 JSON 解析，真实环境下 `res.body` 已是对象 → `JSON.parse(对象)` 抛 `Unexpected token o` → 被 sendNotify 的 try-catch 静默吞掉 → **一言功能实际从不生效**（每次都被吞，无任何提示）
- **修复**：body 兼容字符串/对象两种形态
- **test_notify 增强**：HITOKOTO 测试改为断言一言内容真实追加到 desp（mock 一言接口返回对象 body 模拟真实 got）

### 🧪 息知通道测试（曾从未被测试）

- WX_XIZHI_KEY 作为 URL + JSON body（title/content）断言

### 🧪 测试数

**600 个全绿（单元 540 + 集成 48 + 通道 12）**

## v3.39（url 类型防御）
> 2026-08-01

### 🐛 urlOf 对象 url 崩溃修复

- **非字符串 url 视为无链接**：脏数据 `url: {a:1}` 时 `urlOf` 的 `it.url.includes` 直接抛 `TypeError` → **整个 run 崩溃**（连累已推送数据中断，违反元素级容错哲学）；已防御 null/undefined/对象/数字均视为无链接（与 htmlToMarkdown 的 content_html 口径一致）
- **test_app 7.19 新增 2 个**：对象/空 url 不崩溃且无垃圾文本、协议相对 `//` 开头 URL 不拼前缀

### 🧪 测试数

**599 个全绿（单元 540 + 集成 48 + 通道 11）**

## v3.38（顺序模式统计修复·盲区补齐）
> 2026-08-01

### 🐛 顺序模式统计 bug（默认模式！）

- **`successCount` 从未累加**：v3.30 新增的 `run()` 返回摘要 `{total,dedup,filtered,pushed,failed}` 在**顺序模式（默认）下 pushed 恒为 0、failed 恒为全部**——并行分支有 `results.filter(...)` 统计但顺序分支只 `console.log` 未计数；被补摘要断言挖出（此前 test_app 从不验证返回值）
- **修复**：顺序分支成功时 `successCount++`
- **完善**：t44 增强为断言并行/顺序两模式 `run()` 摘要**全字段一致**；变异验证（去掉 `successCount++` → t01/t20/t44 三测试变红）确认修复被测试锁定

### 🧪 测试盲区补齐

- **test_app t01/t20 断言 `run()` 返回摘要契约**（total/dedup/filtered/pushed/failed 全字段）
- **test_notify 新增 2 个**（9 → 11）：一言 `HITOKOTO` 分支（启用时先请求一言再推送）、Bark 扩展参数传递（ARCHIVE/GROUP/SOUND/LEVEL/ICON/URL）

### 🧪 测试数

**597 个全绿（单元 540 + 集成 46 + 通道 11）**

## v3.37（格式化防御·got 直测）
> 2026-08-01

### 🐛 {Html内容} 路径对象泄漏修复

- **`getContentHtml` 非字符串 `content_html` 置空**：`{Html内容}` 占位符曾把对象泄漏为 `[object Object]` 文本（v3.33 只修了 `htmlToMarkdown` 即 `{Markdown内容}` 路径，`getContentHtml` 是独立路径漏了同样防御）；已统一口径，null/undefined/数字/数组/布尔均置空

### 🧪 97 章：自制 got 模块直测（本地 HTTP server，5 个）

- **302 重定向跟随 + JSON 解析**、**4xx 抛错带 `response.statusCode`/`code=HTTP_404`**、**超时抛 `ETIMEDOUT`**、**POST JSON body 正确发送**、**UTF-8 跨 chunk 不乱码**（逐字节分块模拟 4 字节 emoji 拆分，验证 v3.28 的 Buffer.concat 修复）

### 🧪 测试数

**595 个全绿（单元 540 + 集成 46 + 通道 9）**

## v3.36（口径一致性·测试自清理）
> 2026-08-01

### 🔧 配置解析口径一致性

- **validateConfig 多行分隔符补单独 `\r`**：与 `_splitLines` 口径统一（原缺 `\r`，配置用 `\r` 分隔多行时会误报「多个 ###」警告，而 compileRules 实际正常拆分——校验与编译口径脱节）
- **新增 96 章 3 个一致性测试**：`\r` 分隔的 filter/pingbitime 配置校验零警告 + 4 种分隔符（`<br>`/`\n`/`\r\n`/`\r`）解析结果一致
- **hasNestedQuantifier 补判 `(a?)+` 类模式**：组以 `?` 结尾（可匹配空串）+ 组后无限量词同为灾难性回溯（如 OWASP `(a|a?)+` 类），49 个正则用例全对；95 章测试补充

### 🧹 测试自清理

- **test_filter/test_app 结尾统一清理**本套件产生的缓存测试文件（保留真实运行缓存 `push.json`），修复 test_filter 清理代码 `path` 未定义被 `catch` 吞掉的静默失败（ReferenceError 无声无息）；三套件跑完缓存目录零残留（原 131 个测试垃圾文件）
- **L3592 超长文件名测试加 finally 自清理**（消除 bbbbb... 残留）

### 🧪 测试数

**589 个全绿（单元 534 + 集成 46 + 通道 9）**

## v3.35（ReDoS 防护）
> 2026-08-01

### 🛡️ 灾难性回溯防护（审查10轮 #240，唯一遗留"高"价值项）

- **`hasNestedQuantifier` 检测**：扫描正则模式识别「嵌套无限量词」（`(a+)+`、`(a*)*`、`(a+)*`、`(?:a+)+` 等）——灾难性回溯（ReDoS）的主要触发源，匹配呈指数级卡死主线程
- **有界量词不误报**：`?`、`{n}`、`{n,m}`、字符类/转义内的括号与量词均正确排除（`(a+){1,3}`、`(a|b)+`、`[()]+`、`\(a+\)+` 不判危险）
- **全入口拦截**：compileRules（简单/多行/分类正则）、validateConfig（警告）、whitelistFilter、App.run 的 zkt_gjc 全部接入——风险规则一律跳过/忽略，**绝不执行**，与「非法正则 → 警告并忽略」口径一致
- **测试**：test_filter.js 新增 95 章 7 个测试（25 种正则模式判定 + 编译拦截 + 警告 + 端到端不卡死），test_app.js 新增 2 个集成测试；**589 个测试全绿（单元 534 + 集成 46 + 通道 9）**
- **导出**：新增 `hasNestedQuantifier` 导出（契约测试 31 → 32 键）

### 📋 文档同步

- **REVIEW_DECISIONS.md**：测试数 479 → 586、主代码行数 ~950 → ~1167、审查轮次 12 → 14、新增 v3.34/v3.35 审查行
- **CHANGELOG.md**：版本结构梳理——v3.8 标题下堆叠的 18 个审查子节（v3.15~v3.33）提升为独立版本标题并倒序排列，消除「v3.8（当前最新）」过时误导

## v3.34（通道死代码修复）
> 2026-08-01

### 🐛 推送通道死代码修复（sendNotify 只实际发送 5/8 通道）

- **sendNotify 接入 3 个"死通道"**：`serverNotify`(Server酱)/`pushPlusNotify`(Push+)/`pushMeNotify`(PushMe) 定义但从未被 `Promise.all` 调用，配置了密钥也永远不会推送（本地 PUSH_KEY/PUSHME_KEY 此前一直无效）；已接入实际发送
- **hasChannel 检查补全**：原只认 Bark/企微/wxpusher/息知/PushDeer，漏 `PUSH_KEY`/`PUSH_PLUS_TOKEN`/`PUSHME_KEY`，只配这些通道时误抛「未配置任何推送通道」
- **响应防御加固**：`serverNotify` 的 `data.data.errno`、`pushDeerNotify` 的 `data.content.result` 深层访问加空值防护（API 异常返回格式时不再打印崩溃堆栈）

### 🧪 test_notify.js 测试框架修复（假通过 → 真通过）

- **test() 不 await async fn（严重）**：断言从未执行就 `passed++` 报 ✅，原 7/7 假通过（修正框架后真实为 1/6 失败）；已改为 async + await，现在真实 **9/9**
- **withChannels 测试隔离**：每个测试先清空全部通道再只配被测通道，消除本地密钥(`push_config.local.js`)与上一个测试残留配置对 `gotCalls`/断言的污染
- **断言失败后恢复配置**：`try/finally` 保证 cfg 恢复（原断言抛错会导致行尾 `cfg.X=''` 清理不执行、密钥泄漏到后续测试）
- **新增 PushMe / Push+ 测试**：7 个 → 9 个，覆盖新接入的通道

## v3.33 审查十轮批量修复（20 项）
> 2026-08-01

- script/style 内容移除 / content_html 对象置空 / `<\/br>` 识别 / 尖括号剥离
- `_splitLines` 单 `\r` 分隔 / pingbitime 小数警告 / 空白配置警告 / 三个 `###` 段警告 / 警告去重
- init mkdirSync try / 超长文件名截断 / tmp 残留清理 / 缓存写入失败容错
- 缓存裁剪提示 / 重复 id 覆盖提示 / 推送标题内容截断
- fetchData 加 UA/Accept / 重试 jitter / 导出 Pusher / htmlToMarkdown 无标签短路 / normUrl 主机名大小写归一

## v3.32 审查十轮高价值修复（3 项，300 项清单见 REVIEW_ROUND10.md）
> 2026-08-01

- **saveBatch 元素校验**：非对象元素跳过（此前 null/字符串混入会崩溃）
- **只看它过滤保留空标题**：空标题数据不再被关键词过滤掉（与推送占位一致）
- **相对 URL 统一拼接**：domain 去尾斜杠 + 补斜杠（修复 `//rel` 双斜杠与无斜杠拼贴）

## v3.31 审查九轮修复（文档项升级 4 项）
> 2026-08-01

- **魔法数字常量化**：DAY_MS/TS_BOUND/MAX_CODE_POINT/SURROGATE/DEFAULT_MAX_SIZE（可维护性）
- **maxSize 防御**：0/负值回退默认 100（避免缓存被清空）
- **空标题占位**：title 为空推送时显示 `(无标题)`（避免空消息）
- **catch 非 Error 兜底**：字符串异常不再输出 `error.message undefined`

## v3.30 审查八轮修复（文档项升级 6 项）
> 2026-08-01

- **推送整体超时**：Pusher.send 加 10s 超时，慢通道不再把整批推送拖到数分钟（此前单条最坏 15s×N 条）
- **对象字段 JSON 化**：`{价格}` 等字段为对象时显示 JSON 而非 `[object Object]`
- **8 位日期支持**：`YYYYMMDD` 格式可解析（此前误判为 0）
- **实体 map/正则模块级常量**：decodeHtmlEntities 不再每次调用重建（性能+清晰）
- **run 返回摘要**：App.run 返回 `{total,dedup,filtered,pushed,failed}` 供外部/测试观测
- 标题截断评估后记录（各推送 API 限制不一，交用户配置）

## v3.29 审查七轮修复（主代码 3 项 + 47 项记录）
> 2026-08-01

- **whitelistFilter 空白关键词**：函数层与 App.run 防护统一（空白=全通过，不再匹配含空格标题）
- **空 href 不生成空链接**：`[text]()` → 仅保留文本
- **原文链接 url Markdown 转义**：url 含空格/括号/] 时用 `<>` 包裹（不再破坏链接）
- 47 项新角度记录：合成id内容漂移/无整体超时/魔法数字/字段耦合/响应体上限/Symbol id/markdown未转义等（详见 REVIEW_DECISIONS）

## v3.28 审查六轮修复（10 项，首次覆盖推送模块与 got）
> 2026-07-31

- **🔴 移除硬编码真实密钥**：Server酱/wxpusher/PushMe 真实 key 全部清除（原被 git 跟踪，任何人拿到仓库可盗用）
- **🔴 无通道时 reject**：未配置任何推送通道 → sendNotify 抛错（不再静默成功导致主流程误写缓存）
- **🔴 Server酱表单 URL 编码**：text/desp 用 encodeURIComponent（含 & 不再破坏请求）
- **🔴 PushDeer 全字段编码**：encodeURI → encodeURIComponent（& = # 正确转义）
- **🔴 一言失败不中断**：one() try-catch，一言 API 异常不再挂掉整个推送
- **PushPlus Content-Type 空格**：' application/json' → 'application/json'
- **got chunk 乱码修复**：字符串累加 → Buffer.concat（UTF-8 多字节跨 chunk 不乱码）
- **代理区字符过滤**：`&#xD800;` 等孤立代理保留原文（避免乱码）
- 版本号 v3.26 → v3.27

## v3.27 审查五轮修复（5 项）
> 2026-07-31

- **非法 posttime 不再回退当前时间**：非法字符串日期留空（避免误导性日期）
- **负时间戳不再生成 1969**：负数日期留空
- **validateConfig 校验 zkt_gjc**：与 App.run 预编译口径一致，非法正则启动即警告
- **NUL 空字符过滤**：`&#0;` 解码为空（避免 NUL 注入下游）
- **文件头版本号**：v3.25 → v3.26

## v3.26 审查四轮修复（6 项）
> 2026-07-31

- **429 限流重试**：4xx 中排除 429（限流可能瞬时，值得重试）；4xx 无 statusCode 不再误抛
- **getFileName 纯点串兜底**：URL 尾部 `..` / `.` 不再生成 `...json` 怪名
- **嵌套数组元素排除**：`Array.isArray` 校验，数组元素不再被当对象处理
- **validateConfig pingbitime 分类 trim**：与 regexFields 口径一致
- **`<ahref=` 无空格支持**：a 标签正则 `\s+` → `\s*`
- **文件头版本号**：v3.22 → v3.25

## v3.25 审查三轮修复（3 项）
> 2026-07-31

- **URL 协议兼容**：`ftp://`、协议相对 `//` 不再被拼坏（仅 http/https 拼 domain）
- **h 标签跨行**：多行标题 `<h2>第一行\n第二行</h2>` 正确转为 Markdown `##`
- **空白关键词防护**：`zkt_gjc` 为空白字符时警告并忽略过滤（避免只推含空格的标题）

## v3.24 审查二轮修复（2 项）
> 2026-07-31

- **空白 url 数据丢失修复（较高）**：无 id + 空白/空 url 的数据不再生成 `key='url:  '` 误判重复——空白 url 也走合成 id，多条不同数据全部保留（实证：修复前 3 条只推 1 条）
- **批内 url 归一化（中等）**：seenInBatch/keyOf 的 url 键统一 `normUrl`，与缓存判重口径一致（同资源不同 url 形态批内不再重复推送；实证：修复前推 2 条）

## v3.23 通读复查修复（3 项）
> 2026-07-31

- **validateConfig pingbitime 分隔符统一**：单 `\n` 分隔的 pingbitime 多行配置不再误报"天数值不是有效数字"（与 compileRules/_splitLines 一致）
- **checkRegisterTime 0 时间戳口径统一**：显式判断缺失（0=1970 视为有效），与 checkTimeCompiled 结论一致，消除两个入口逻辑矛盾
- **文件头版本号**：v3.16 → v3.22

## v3.22 审查报告修复（18 项）
> 2026-07-31

- **时间解析**：ISO 时间串原生解析、12 位毫秒不再误乘 1000、tuisong posttime 兼容秒/毫秒/ISO
- **缓存容错**：readMessages 过滤非对象元素（null 元素不再崩）
- **HTML 转换**：img 统一回调（单引号/属性顺序/有无 alt）、a 标签支持多行链接文本
- **实体解码**：支持 `&#X` 大写十六进制、实体扩展 10 个（ndash/bull/yen 等）
- **路径安全**：getFilePath 只取 basename 并清洗（`../`、绝对路径无法逃出缓存目录）、getFileName 去 hash
- **规则解析**：支持单个 `\n` 分隔、无 ### 行/空值规则警告提示、parts trim、pingbitime 拒绝负数/Infinity
- **匹配逻辑**：checkTimeCompiled 的 louzhuregtime=0 视为有效（不再当缺失）
- **URL 处理**：绝对 URL 不再拼 domain 前缀、url 归一化判重（首尾斜杠/空白）

## v3.21 审查报告修复（14 项）
> 2026-07-31

- **非法日期拒绝**：2026-02-31 等不存在的日期回读校验后返回 0（不再滚动到下月）
- **日期锚定**：严格匹配完整 YYYY-MM-DD，拒绝 `2026-07-31abc` 脏前缀
- **0 时间戳不短路**：daysComputed/tuisong 支持数字时间戳（0=1970），不再被 `!time` 跳过
- **空白 id 无效**：hasValidId 排除空白串
- **合成 id 条件放宽**：null/''/空白 id 且无 url 也生成合成 id（不再落 `url:undefined`）
- **无 url 空链接修复**：url 缺失时不再输出 `原文链接：[]()` 空壳
- **getContentHtml url 转义**：HTML 特殊字符转义，保护 `<a href>` 结构
- **h 标签支持属性**：`<h2 class="x">` 等带属性标题可转换
- **实体覆盖扩展**：新增 hellip/mdash/copy/reg/trade/euro/times/divide 等 12 个常见实体
- **缓存非数组容错**：合法 JSON 但非数组时重置为空数组，不再 `.some()` 崩溃
- **saveMessages 不原地改数组**：拷贝后截断，外部复用不受影响
- **getFileName 清洗**：去查询参数 + 替换文件系统保留字符
- **判重增强**：旧 url-only 缓存 + 新 id 数据判重；id 类型漂移（1 vs "1"）归一化判重
- **内存缓存一致性**：saveMessages 缓存裁剪后的结果

## v3.20 审查报告修复（7 项）
> 2026-07-31

- **坏链接修复（High）**：有 id 无 url 时推送链接不再拼出 `https://...undefined`，缺失时置空
- **id 判重收紧（High）**：`null`/`''` 不再视为有效 id（`hasValidId`），避免 `id:null`/`id:''` 误合并不同记录；has/save/saveBatch/主流程 key 全部统一
- **数组元素校验（High）**：归一化与去重循环跳过非对象元素，不再因 `item.catename` 访问崩溃
- **getFileName 空名兜底**：空 url / 尾部 `/` 时返回 `default.json`，避免 `.json` 撞名
- **daysComputed 确定性解析**：`YYYY-MM-DD` 手动解析为本地时间，不依赖宿主字符串解析的时区/格式歧义
- **数字实体支持超 BMP**：`String.fromCharCode` → `String.fromCodePoint`（emoji 等高位码点正确解码），非法码点保留原文
- **a 标签正则增强**：支持单引号 href 与任意属性顺序

## v3.18 第二轮审查修复（3 项）
> 2026-07-31

- **统计/日志区分成功与失败**：推送成功才输出"发现到新数据"，失败单独告警；统计"推送"显示实际成功数（含失败提示，下次运行重试）
- **匿名数据合成 id 增加辅助字段**：anonKey 基于 title+content+posttime+pic+mall_name 等多字段并过滤空值，降低"同标题同内容不同条目"误合并风险
- **接口返回数组校验**：`fetchData` 后 `Array.isArray` 校验，非数组时抛友好错误（"期望数组，实际为 xxx"），不再以晦涩的 "not iterable" 中断

## v3.18 审查报告修复（3 项）
> 2026-07-31

- **推送成功后写缓存（High）**：缓存从"推送前"移到"推送后"，只收录被过滤数据 + 推送成功数据；推送失败的消息不写缓存，下次运行自动重试，不再永久丢失。Pusher.send 改为抛出异常由主流程逐条处理
- **匿名数据稳定去重（Medium）**：无 id 无 url 数据基于 title+content 生成稳定合成 id（`anon:hash`），跨运行可去重，替代仅批内有效的 anonCounter
- **{类目} 字段统一（Medium）**：与 {分类名} 统一读 catename（归一化后恒有值），不再混用 category_name

## v3.16 审查报告修复（3 项）
> 2026-07-31

- **keyword 非法正则警告**（高优先级）：`zkt_gjc` 非法正则时不再静默清空 items，改为 console.warn 提示并继续正常推送
- **缓存原子写入**（中优先级）：saveMessages 先写 `.tmp` 再 `renameSync` 原子替换，并发/崩溃不损坏缓存
- **文件头版本号**：v3.6 → v3.16

## v3.15 审查报告修复（5 项）
> 2026-07-31

- **save() 判重对齐**：与 saveBatch/has 统一为 id 优先 + url fallback，无 id 不同 url 不再互相覆盖
- **App.run 失败重新抛出**：catch 后 `throw error`，require.main 分支 `process.exit(1)`，cron/调度可感知失败
- **validateConfig 补 'i'**：简单模式正则校验与 compileRules 一致
- **decodeHtmlEntities 数字实体**：支持 `&#39;` / `&#x41;` 十进制与十六进制数字实体
- **只看它正则预编译**：zkt_gjc 关键词正则只编译一次，不再逐条 new RegExp

## v3.8（测试完备版）
> 2026-07-31

### 🧪 测试体系（0 → 406 个）

- **单元测试** `test_filter.js`：391 个，覆盖过滤引擎/规则编译/格式化/缓存全部纯函数
- **集成测试** `test_app.js`：15 个，mock got/notify 验证 App.run 完整主流程（拉取→归一化→去重→过滤→只看它→推送→错误分支）
- **行覆盖率 99.6%**：243/244 可执行行，唯一未覆盖为 `require.main` CLI 入口（正常）
- **变异测试**：16 种算子 × 近全行，存活变异全部甄别为等价变异，无遗留真盲区
- **导出 `run`**：主模块新增 `App.run` 导出，供集成测试 mock 调用

### 🐛 Bug 修复（fuzz 属性测试发现）

- **htmlToMarkdown 拼接处 3 连换行残留**：`\n{3,}` 合并发生在模板拼接之前，内容尾部 `\n\n` + 模板 `\n\n原文链接` 会拼出 4 连换行；修复为拼接后再次合并
- **入口防御加固**（增强属性测试发现）：`tuisong_replace` 模板缺失/非字符串崩溃、`whitelistFilter` item 缺失崩溃、`checkRegisterTime`/`checkCategory` group 缺失崩溃，全部加防御
- **saveBatch 判重与 has() 对齐**（代码审查发现）：`findIndex` 只按 id 判重导致无 id 数据互相覆盖（`undefined===undefined` 误判），改为 id 优先 + url fallback，无 id 无 url 保守收录
- **seenInBatch 匿名兜底**（代码审查发现）：无 id 无 url 数据 key 变为 `"url:undefined"` 被误判重复，改为 id > url > 匿名计数器，批内不误丢

### 🔬 方法论
- 变异测试实证驱动补测：每轮变异→甄别盲区→补精确断言→回跑验证
- 覆盖：add0边界/实体解码输入/未来日期/空标签/换行合并/正则大小写/多行解析/白名单越权/未知类型兜底/缓存顺序/占位符残留/逐字段验证/错误分支

---

## v3.7（性能与健壮性）
> 2026-07-30

- **惰性计算**：`{Html内容}`/`{Markdown内容}` 只在模板用到时才计算
- **saveBatch 批量写**：单次运行内多条新数据一次性落盘
- **seenInBatch 防重**：同一批接口数据内重复 id/url 不重复收录
- **网络层手动重试**：got 不支持 retry，退避重试（1s/2s/3s）+ 4xx 不重试
- **字段归一化**：`category_name` 自动映射到 `catename`（过滤/推送/去重统一取值）
- **MessageStore 自给自足**：`_ensureFileExists` 自动建父目录，save/has 脱离 init 可用

## v3.6（规则预编译 + 白名单重构）
> 2026-07-30

- **规则预编译**：过滤规则启动时编译为 RegExp，运行时不再 `new RegExp()`
- **只看它封装**：`whitelistFilter(item, field, keyword)` 独立白名单语义
- **HTML 实体解码**：`decodeHtmlEntities` 解码常见实体（&amp; &lt; 等）
- **pingbifenlei 明确警告**：不支持 ### 多行分类语法时提示

## v3.0（测试完备版前置·整合条目）
> 2026-07-30

> 2026-07-30

### 🆕 新增功能

- **只看它封装**：`filterByKeyword(item, keyword)` 替代黑魔法传参
- **配置校验**：`validateConfig(cfg)` 启动时检查正则和天数配置是否合法
- **内存缓存**：避免每次去重都读写文件
- **时间兼容**：同时支持 `posttime` 和 `shijianchuo` 两种时间戳字段
- **精简推送模块**：57KB → 18KB，只保留 8 个低门槛通道，加载更快
- **推送不等待**：`sendNotify` 改为 fire-and-forget，主流程不等推送结果
- **推送渠道**：从 PushPlus 换为 Server酱（微信推送）
- **推送格式**：从 `{Html内容}` 改为 `{Markdown内容}`，适配 Server酱 格式
- **原始推送模块**：删除 57KB `xbk_sendNotify.js`，仅保留精简版
- **HTTPS**：默认使用 `https://new.ixbk.net`，省去 301 重定向

### 🐛 Bug 修复

- **`$` 符号被错误解释**：标题含 `$&`、`` $` `` 等特殊字符时推送内容被篡改，改用箭头函数修复
- **htmlToMarkdown 换行符字面量**：`\\n\\n` 改为 `\n\n`，Markdown 推送通道现在能正确换行
- **Ntfy 未配置提示**：多余的 `console.log` 注释掉，输出更清爽

### 🔧 优化

- **listfilter 参数对象化**：12 个散装参数改为 `(group, cfg)` 配置对象
- **主流程 async/await**：取代 `.then()` 回调嵌套，线性可读
- **配置表驱动过滤**：用 `fieldStages` 数组 + 两轮循环，替代楼主/标题/内容三段重复代码
- **推送格式优化**：标题显示 `【分类】标题`，内容使用 HTML 格式支持图片显示
- **缩短超时**：`timeout` 从 10s 改为 5s，异常时更快返回
- **性能优化**：运行时间从 1.32s 降至 0.81s（快 38%）
- **全局变量泄漏修复**：`'use strict'` + `let`，`for` 循环变量不再泄漏到全局
- **require 条件执行**：`require.main === module`，被导入时不自动运行

### 🧪 测试

- 测试覆盖从 0 → **135 个**（性能测试另计）
- 覆盖范围：listfilter、filterByKeyword、validateConfig、tuisong_replace、htmlToMarkdown、缓存管理、极端值、HTML标签
- 测试文件直测 `xbk_function_v3.js`，不复制代码

---

## v2.0（极致解耦版 v3 初始）
> 2026-07-30

### 相对于 v2 的改动

- 过滤引擎用配置表 + 两轮循环彻底解耦
- 主流程改用 `async/await`
- 增加内存缓存层
- 修复全局变量泄漏
- 全面中文注释

---

## v2.0（重构版）
> 前期版本

### 改动

- 代码格式化，拆分为正常缩进
- 修复全局变量泄漏
- 优化正则写法
- 增加 `'use strict'`

---

## v1.0（原版）
> 初始版本

- 原始线报酷推送脚本
- 所有过滤逻辑挤在一行
- 12 个散装参数
- `.then()` 回调嵌套
- 全局变量泄漏
