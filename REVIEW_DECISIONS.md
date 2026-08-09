# 📋 xbk 项目代码审查决策记录

> 记录每一轮代码审查中「为什么修」「为什么不修」的完整决策
> 目的：让后人（包括未来的自己）知道每个取舍背后的理由，避免重复争论或误改
> 早期条目中的“自制 got”仅描述当时的历史实现；当前代码已使用官方 `got@11.8.6`，历史条目不改写。

---

## 一、审查轮次概览

| 轮次 | 审查对象 | 修复数 | 核心内容 |
|---|---|---|---|
| v3.14 审查 | 主流程 | 2 | saveBatch 判重对齐、seenInBatch key 兜底 |
| v3.15 审查 | 全文件 | 5 | save 判重、失败重抛、validateConfig 'i'、数字实体、keyword 预编译 |
| v3.16 审查 | 全文件 | 3 | keyword 非法正则、原子写入、版本号 |
| v3.18 审查 | 主流程 | 3 | 推送后写缓存、匿名合成 id、{类目} 统一 |
| v3.18 二轮 | 主流程 | 3 | 统计区分成败、anonKey 多字段、数组校验 |
| v3.20 审查 | 全文件 | 7 | 坏链接、id 判重收紧、数组元素、getFileName、日期确定性、emoji、a 标签 |
| v3.21 审查 | 全文件 | 14 | 非法日期、0 时间戳、空白 id、实体扩展、缓存容错等 |
| v3.22 审查 | 全文件 | 18 | ISO/毫秒、元素容错、img 统一、路径防逃逸、url 归一化等 |
| 通读复查 | 全文件 | 3 | validateConfig 单换行误报、判重口径统一、版本号 |
| 自我审查 2 | 跨函数 | 2 | 空白 url 数据丢失、批内 url 归一化 |
| 自我审查 3 | 边缘 | 3 | 协议兼容、h 跨行、空白关键词 |
| 自我审查 4 | 全文件 | 6 | 429 重试、纯点串怪名、嵌套数组、trim、ahref、版本号 |
| v3.34 审查 | 推送+测试 | 2 | sendNotify 死通道(Server酱/Push+/PushMe 从未发送)、test_notify.js 假通过框架(断言从未执行) |
| v3.35 审查 | ReDoS | 1 | 嵌套量词灾难性回溯防护(hasNestedQuantifier，覆盖 compileRules/validateConfig/whitelistFilter/App.run) |
| v3.36 审查 | 配置+测试 | 2 | validateConfig `\r` 分隔符口径(与 _splitLines 一致)、测试套件结尾自清理 |
| v3.37 审查 | 格式化+got | 2 | `{Html内容}` 对象泄漏 `[object Object]`、自制 got 无直测盲区(本地 server 5 项) |
| v3.38 审查 | 统计 | 1 | 顺序模式(默认)successCount 不累加 → run() 摘要 pushed/failed 恒错 |
| v3.39 审查 | 类型防御 | 1 | urlOf 对象 url 崩溃整个 run |
| v3.40 审查 | 推送 | 1 | 一言 one() `JSON.parse(已解析对象)` 静默失败 → 永不生效 |
| v3.41 审查 | got | 1 | 协议相对重定向拼错 `origin//host/x` → 404 |
| v3.42 审查 | Unicode | 1 | 推送截断 `slice` 切断 emoji 代理对 → 半个乱码 |
| v3.43 审查 | 判重 | 1 | 布尔/对象/Symbol id 被判有效 → 不同数据误合并 |
| v3.44 审查 | 配置+映射 | 2 | 密钥加载静默失败、category_id→cateid 映射缺失 |
| v3.45 审查 | catch 审计 | 3 | 静默吞异常审计(JSON.parse/compileRules 注释、throw lastErr 防御) |
| v3.46 审查 | 时间 | 1 | tuisong ISO 时间字符串解析失败({日期}/{时间}恒空) |
| v3.47 审查 | 时间 | 3 | tuisong 8位日期当秒/超大数字无上限/小数字误导(与 daysComputed 对齐) |
| v3.48 审查 | HTML | 1 | htmlToMarkdown 列表粘连/粗斜体丢失 |
| v3.49 审查 | 通道 | 1 | TG 死配置(配置项存在从未实现,只配 TG 报未配置) |
| v3.50 审查 | 测试 | 1 | 非 JSON 响应重试路径未测(mock .json() 永不抛掩盖) |
| v3.51 审查 | HTML | 1 | 表格单元格粘连(未主动编辑改动,两次对比验证正确) |
| v3.52 审查 | 并发 | 1 | parallelLimit 小数产生空批 |
| v3.53 审查 | 配置 | 1 | push.mode 非法值静默降级顺序 |
| v3.54 审查 | 异常批量 | 5 | got timeout 0/负数归一 + 未知占位符/对象字段/重定向循环/连接拒绝批量测试 |
| v3.55 审查 | 故障注入 | 1 | readMessages 双故障(read+write)崩溃(_ensureFileExists/_resetCache 逃逸) |
| v3.56 审查 | 安全 | 1 | 日志密钥脱敏(Bark/PushMe 完整 key 泄露) |
| v3.57 审查 | 依赖 | 1 | 自制 got 响应体无限读入内存(加 maxBody 上限) |
| v3.58 审查 | 边界 | 0 | 边界精确值批量锁定(TS_BOUND/normUrl/pingbitime/编码)——行为正确无 bug |
| v3.59 审查 | 安全 | 1 | wxpusher/息知日志打整个响应对象(异常回显 token 风险→摘要) |
| v3.60 审查 | 故障注入 | 1 | 循环引用 message 序列化崩溃(saveMessages/_upsert) |
| v3.61 审查 | 内存 | 1 | _memoryCache 按文件名无限累积(加 100 上限) |
| v3.145 审查 | 日志 | 1 | 告警"已发送"误报(sendNotify reject 仍同步打印) |
| v3.145 审查 | 统计 | 1 | maxPerRun 截断未计入统计(差值凭空消失) |
| v3.146 审查 | 日志 | 1 | 日报"已发送"误报(与告警同类,每天触发) |
| v3.147 审查 | Unicode | 1 | wxpusher summary substring(0,90) 切断 emoji |
| v3.148 审查 | 通道 | 1 | Server酱 \n\n 整体加倍成 \n\n\n\n |
| v3.149 审查 | 通道 | 1 | mdToPlain HTML 残留属性({Html内容}+Push+/Bark) |
| v3.150 审查 | 通道 | 1 | mdToPlain 斜体误伤(5*3*2cm 变 532cm) |
| v3.151 审查 | 通道 | 1 | 一言无 timeout 推送延迟 15s |
| v3.152 审查 | 推送 | 1 | 长 desp 截断丢原文链接 |
| v3.153 审查 | 通道 | 1 | 原文链接 text===url 重复显示 |
| v3.159 审查 | BUG_HUNT | 5 | wxpusher HTML 内容自动切 contentType=2 / 过滤规则变更失效过滤写入缓存 / pingbitime 接口缺字段警告 / 告警日报换行统一 / 模板占位符有效性警告 |
| v3.176 系统审查 | 全文件 | 10 | cache.maxSize 字符串层间不一致 / 批内 vs 跨运行判重口径分裂 / 日报失败今日数据错标 / getFilePath 对象文件名垃圾文件+测试参数颠倒 / 垃圾 url 归一为空误判重 / anonKey 漏 louzhu / 通道 key 数字 TypeError / run.log 时间戳本地化 / 统计双计与 report 缺 truncated / 默认配置外置（美妆） |
| v3.177 系统验证 | 推送截断 | 1 | 极端 contentMax 下链接补回可能超限 |
| v3.178 系统验证 | 推送/日志/got | 3 | 通道截断统一、run.log UTF-8 边界、重定向响应消费 |
| v3.179 系统验证 | 判重性能 | 1 | 判重索引化，避免海量数据 O(N×M) 扫描 |
| v3.180 P1 审查 | 推送通道 | 1 | HTTP 200 + JSON null 响应不得被当作成功 |
| v3.181 配置审查 | 推送开关 | 1 | HITOKOTO 的 0/非法值误启用一言请求 |
| v3.182 网络审查 | 自制 got | 2 | 路径相对重定向错误 / 非法重定向异常未转为 reject |
| v3.183 API 审查 | 缓存接口 | 1 | saveBatch 非数组输入进入 for...of 崩溃 |
| v3.184 安全审查 | 缓存/URL | 2 | cache.dir 路径逃逸 / 危险 URL 内部控制空白绕过 |
| v3.185 系统审查 | 状态/日志/过滤 | 3 | filter.hash 时序 / 状态文件原子写 / 异常响应敏感字段日志泄露 |
| v3.186 深度审查 | 缓存/日报/HTML | 3 | 符号链接缓存逃逸 / 损坏日报状态 / 实体编码主动 HTML |
| v3.187 联合路径审查 | 配置/日志 | 2 | filterHash 脏值崩溃 / 已配置密钥进入错误摘要 |
| v3.231 扫描审查 | 静态扫描（osv-scanner/semgrep/eslint/knip 最严格模式） | 3+1 | GHA 固定 SHA(P4) / cleanUrlAttr 死代码(P5) / 冗余转义×3(P6)；另修复 catch 日志 resp 对象泄露（logErr 脱敏） |

**当前基线以 `package.json`、文件头和 `CHANGELOG.md` 的版本一致性为准；测试结果以 `npm test` 实际输出为准，本文件不维护测试数量。**

---

## 二、设计取舍：为什么不修

> 这些项经过评估确认为「设计取舍」而非缺陷，维持现状。每项给出理由。

### 1. 不冻结 Config（Object.freeze）
- **建议**：冻结 Config 防止运行时误改
- **为什么不修**：会破坏集成测试（测试用 `defineProperty` 覆盖 `pushUrl`、修改 `Config.filter`）和用户改配置的核心用法。收益（防误改）远低于成本（失去灵活性）
- **出处**：v3.15 审查 5.1

### 2. 内存缓存不做 LRU/失效机制
- **建议**：_memoryCache 长期运行会增长，加 LRU
- **为什么不修**：`maxSize=100` 已限制缓存文件大小；内存缓存 key 是文件名（通常 <5 个）；脚本单进程短周期运行，无实际问题。外部改文件不感知是「内存缓存」的固有代价，属于刻意设计
- **出处**：v3.15 5.1b、v3.16、v3.21 #12

### 3. 字段归一化不改为不可变（.map 新建数组）
- **建议**：`xbkdata.map(...)` 创建新数组，不原地修改
- **为什么不修**：`fetchData` 返回一次性新数组，无外部引用，原地修改无副作用。改不可变需要连带改多处引用，收益低
- **出处**：v3.15 5.2、v3.16

### 4. 非 JSON 响应不友好提示
- **建议**：502 返回 HTML 时给出友好错误
- **为什么不修**：收益低、难以测试，got 抛错不会导致崩溃（错误信息虽不友好但明确）
- **出处**：v3.15 5.3、v3.16

### 5. 匿名数据全空字段合并
- **建议**：anonKey 全空时所有记录撞同一 key
- **为什么不修**：全空记录（无任何可识别字段）本质无法区分，**合并去重反而是合理行为**（垃圾数据不重复推送）。强行区分需要随机数，会破坏跨运行稳定性
- **出处**：v3.21 #4

### 6. 缺 catename/louzhuregtime 时静默放行
- **建议**：字段缺失时分类黑名单/天数过滤失效
- **为什么不修**：**保守放行设计**——缺信息时不误杀。宁多推不可少推是推送脚本的哲学。已有测试锁定该行为
- **出处**：v3.21 #19/#20

### 7. 链接文本嵌套标签样式丢失
- **建议**：`<a><strong>加粗</strong></a>` 内样式被剥
- **为什么不修**：文本保留、仅丢样式，是 HTML→Markdown 转换的固有局限，覆盖成本高
- **出处**：v3.21 #9

### 8. saveBatch 并发覆盖（无文件锁）
- **建议**：cron 重叠时两次进程读-改-写互相覆盖
- **为什么不修**：触发条件苛刻（运行间隔 < 单次运行时长）；已有原子写入防「半写损坏」；文件锁会引入锁残留/死锁/跨平台复杂度。**单实例场景概率极低，收益不抵成本**
- **出处**：v3.18 二轮 #4

### 9. 空串/0 不参与匹配
- **建议**：matchesCompiled/whitelistFilter 无法匹配空字符串/0
- **为什么不修**：**保守设计**——空字段不参与过滤（`if (!fieldValue) return false`），避免空值误匹配。与「字段值为空 → 跳过过滤」的既有测试一致
- **出处**：v3.22 #17

### 10. 异常 URL 撞名 default.json
- **建议**：多个异常 URL 压成同一缓存文件名
- **为什么不修**：缓存名来自固定 `pushUrl`，异常输入罕见；getFileName 已清洗非法字符
- **出处**：v3.21 #15、v3.22 #10

### 11. 其他低风险记录（评估后不修）
| 项 | 理由 |
|---|---|
| 统计「获取」数含被跳过元素 | 获取=接口返回总条数，语义如此 |
| add0 负数 | 内部只传非负值（月/日/分钟），不可达 |
| 8 位数字日期 `20260731` 误判 0 | 罕见格式，返回 0 保守（视为新号） |
| 原子写入 .tmp 残留 | 仅 rename 失败（崩溃/权限）时残留，无功能影响 |
| whitelistFilter 数组/对象关键词 | 隐式 String 转换，边缘输入 |
| 批量判重与单条判重分别实现 | 已通过共用逻辑保持口径一致 |

### 12. Telegram Markdown 特殊字符问题（历史决策，已处理）
- **历史问题**：早期 `tgNotify` 使用 `parse_mode: 'Markdown'` 时，消息中的 `* _ [ ]` 等特殊字符可能导致渲染异常或发送失败。
- **历史候选**：改用 `parse_mode: 'HTML'` 并转义 `& < >`，或继续转义 Markdown 特殊字符。
- **当前决策**：v3.132 已切换为 `parse_mode: 'HTML'`，并通过 `mdToPlain(..., false)` 保留 Telegram HTML 所需的尖括号后再进行转义；本条不再是待处理事项。

---

## 三、修复意图：为什么这样修

> 每类关键修复背后的设计理由，防止后人「简化」时误伤

### 1. 推送成功后才写缓存（v3.18）
- **理由**：消息未推送成功就写缓存 = 下次运行不再推送 = **消息永久丢失**。这是业务正确性核心
- **机制**：只缓存「被过滤数据 + 推送成功数据」，失败的下次运行自动重试

### 2. 判重逻辑统一（v3.14 ~ v3.22 多轮）
- **理由**：id/url 缺失、类型漂移、形态差异都会导致「同一数据推两次」或「不同数据误合并」
- **统一口径**：有效 id 优先（类型归一 `String` 比较）→ url 兜底（`normUrl` 归一化首尾斜杠/空白）→ 无标识用合成 id（title+content 等多字段 hash）
- **三处必须一致**：`has()`、`save()`、`saveBatch()` + 主流程 `seenInBatch` key

### 3. 原子写入（v3.16）
- **理由**：直接 writeFileSync 在并发/崩溃时可能半写损坏缓存 → 先写 `.tmp` 再 `renameSync`（原子替换）

### 4. 失败重新抛出 + exit(1)（v3.15/v3.16）
- **理由**：catch 吞错 → cron 认为成功（exit 0）→ 静默失败。重抛 + 非 0 退出让调度感知

### 5. 防御性输入处理（v3.20 ~ v3.22）
- **理由**：接口数据不可信——null/空白/类型漂移/非法值都要有兜底，不崩溃不误判
- **覆盖**：数组校验、元素校验、id 有效性、url 协议、日期合法性、正则非法、路径逃逸

### 6. 绝对 URL 不拼前缀（v3.22）
- **理由**：`Config.domain + 'https://...'` 会拼坏绝对地址；含协议或 `//` 开头原样，相对路径才拼 domain

### 7. 429 限流重试（v3.26）
- **理由**：限流是瞬时状态，重试往往成功；与其他 4xx（永久错误）区别对待

### 8. 双保险校验（数组元素两处）
- **理由**：归一化循环 + 去重循环各有一道 `Array.isArray` 校验——一处变异/遗漏时另一处兜底，防御冗余是刻意的

---

## 三.5 审查六轮：推送模块与 got 的关键发现

- **硬编码密钥**：推送模块原含真实 Server酱/wxpusher/PushMe key 且被 git 跟踪——已清除为占位符。教训：敏感凭证绝不进源码/仓库
- **通道静默成功**：notify 内部吞错 + 无通道时也 resolve → 主流程 v3.18 的"失败重试"在 notify 层失效。已修：无通道时 reject
- **表单编码**：Server酱/PushDeer 原未 URL 编码（内容含 & 破坏请求）→ encodeURIComponent
- **一言失败中断**：HITOKOTO 一言 API 异常曾中断全部推送 → try-catch
- **got 自制模块**：chunk 字符串累加导致 UTF-8 跨 chunk 乱码 → Buffer.concat

## 四、重大事故记录（Git 对象误删）

### 2026-08-01：误删 `.l2s.tmp_obj_*` 致仓库损坏

- **经过**：验证回滚机制时执行 `find .git/objects -name ".l2s.tmp_obj*" -delete` 清理"疑似临时文件"——但这些文件是环境对象存储中活跃 git 对象的**唯一副本**（临时名形式），删除导致 448 对象缺失（含全部最新提交与 HEAD），git 完全不可用
- **影响**：166 条提交历史元数据丢失；工作区代码/测试/文档**一行未丢**（632 测试全绿为证）
- **恢复**：备份损坏 `.git`（`.git.corrupt_backup/`，已 gitignore）→ 重建仓库 → 提交基线 `ac380f5`（11 文件 9593 行，v3.61 完整状态）
- **教训（红线）**：
  0. **操作前先备份**（用户明确指示）：涉及 `.git`、删除、破坏性操作，先 `cp`/`mv` 完整副本再执行——备份是第一条防线
  1. **`.git/objects` 内部文件绝不凭文件名判断"临时"就删除**——必须先 `git cat-file`/`git fsck` 验证对象引用
  2. 回滚/清理验证的正确方式：`git stash` / `git checkout` / 工作区层面演练，**不触碰 `.git` 内部**
  3. 涉及 `.git` 的任何删除操作前，先 `git fsck` + `git cat-file` 确认对象被引用
- **后续影响**：git 历史从 166 条变为 1 条基线；内容完整可继续开发
- **备份归档**：损坏仓库备份 `.git.corrupt_backup/` 于 v3.72 后经 `git fsck` 确认健康后 `mv` 至 `/tmp/.git.corrupt_backup_archived`（可逆移动，非删除）

---

## V3 统一契约收敛决策（v3.230）

本轮采用底层契约收敛，而不是针对九个触发点分别在业务入口打补丁，原因是这些问题共同集中在消息身份、URL 安全、异常文本、失败摘要和持久化边界。

- **消息身份统一**：App、MessageStore、`saveBatch`、截断排除和成功缓存必须共享同一身份函数；否则批内与跨运行会再次分裂。
- **URL 安全统一**：URL 类型校验、危险协议检查和最终补链不能由 Formatter、App 和通道分别维护；所有出口都调用同一安全入口。
- **递归脱敏**：配置可能是数组、嵌套对象、分隔字符串或环境变量 JSON，顶层 `Object.values()` 不足以覆盖未来通道配置。
- **递归失败分类**：聚合错误的顶层摘要可能与子通道原因不同，必须先看子错误；可重试因素优先于永久因素，符合宁可重复不可丢失原则。
- **传输参数隔离**：`signal` 属于 HTTP 生命周期控制，不属于第三方业务数据；使用白名单提取而不是把内部参数扩散进 body。
- **缓存失败保守处理**：读取/重置失败不能伪造“空缓存”状态；只有成功落盘才能改变内存权威，避免消息被错误判重。
- **单次/常驻语义一致**：`App.run()` 保留结构化摘要兼容性，入口层负责把全部失败转换为调度可感知的非零退出码。
- **日期显式 UTC**：无时区输入不能依赖宿主时区，否则同一接口数据在不同部署环境会得到不同天数和显示结果。


## V3.231 收尾决策

- **异常 getter 统一隔离**：对象字段读取、模板复制、推送构造和缓存写回都使用安全浅复制/安全读取；异常字段按缺失处理，不让已成功推送进入失败路径。
- **部分成功不熔断**：一条消息只要至少一个配置通道成功，就视为该消息处理成功；失败通道不对同一条消息立即重试，避免重复轰炸。只有整轮全部失败才交给单次/常驻失败分类。
- **URL 控制字符**：保留历史换行剥离兼容；NUL、制表符和其余 ASCII 控制字符拒绝进入 URL 输出和身份判重。



```
主代码:  xbk_function_v3.js（分层架构）
测试:    结果以 `npm test` 实际输出为准；集成测试推荐并行入口
审查:    历轮审查记录见上文概览表（修复/不修项均记录在案）
状态:    维护阶段；只处理真实问题，不主动引入高风险结构性改动
```

当前资源生命周期、HTTP 连接、堆内存和并行测试残留验证记录见 `BUG_AUDIT.md` 的最新资源验证节；结果以实际运行命令为准。

### v3.62~v3.65 自主进化补充取舍（2026-08-01）

- **#29 normUrl 判重不去 query vs 缓存文件名去 query 不一致**——不修：文件名去 query 是**存储位置**优化（避免文件爆炸），判重 key 不去 query 是**判重语义**（不同 query 视为不同资源，宁可多推不可少推）。同一文件内不同 key 可共存，无实际冲突
- **#31 默认端口 :80 不归一**——不修：判重过严（a.com:80 vs a.com 不同）符合"宁可多推"哲学；实际接口 URL 固定，风险为零
- **#39 anonKey djb2 32 位哈希碰撞**——不修：2^32 空间 + 匿名数据量级小，碰撞概率可忽略；换强哈希需迁移旧缓存 key，跨运行去重失效一次，收益不抵成本
- **#40 anonKey 字段拼接歧义（'a|b' vs 'ab|'）**——不修：改变拼接格式会改变合成 id 算法 → 旧缓存匿名 key 全部失效 → 已推数据可能重推一次；歧义仅在字段值含分隔符的极端场景，且后果只是误合并（宁可不推？不，是少推一条），保守保留
- **#22 日期无时区参数（本地时区漂移）**——不修：部署环境通常固定时区，引入时区配置需贯穿 daysComputed/tuisong_replace/parseTime 全链路，复杂度高；cron 场景可自行 TZ 环境变量控制
- **#15/#16 布尔/数组时间输入静默转 0**——不修：parseTime 已统一为 null 判无效（不崩溃、不留误导日期）；daysComputed 高频调用，对脏数据告警会产生噪音且无实际收益

## 六、自主进化记录（v3.62~v3.100）

- **v3.62**：#26 日期解析统一——daysComputed/tuisong_replace 共用 Utils.parseTime 单例（消除重复逻辑；数字类型含 -1 统一判无效，修掉 new Date('-1')→2001 怪异行为）
- **v3.63**：#56 img 空 src 不生成 ![]() 空图片；#65 url 换行剥离保护 Markdown 链接；#7 maxSize 配置层双保险校验
- **v3.64**：运行时数值配置校验补全（timeout/retry/pushInterval/finalWait/parallelLimit）；101 章版本一致性自检（文件头 vs CHANGELOG 顶部）
- **v3.65**：运行摘要持久化 run.log；文档同步（本文件当前状态 + FILE_INDEX）
- **v3.66**：run.log 增强——失败 ERROR 记录 + 1MB 大小上限截断（抽 _writeRunLog helper）
- **v3.67**：whitelistFilter 非法正则 → 放行（原拦截；与 ReDoS 分支/App.run 预编译失败口径统一，宁可多推）
- **v3.68**：推送模板可配置（Config.template.title/content，默认=历史硬编码，非法回退默认）
- **v3.69**：推送截断可配置（push.titleMax/contentMax）；desp 兜底截断（{Markdown内容} 原从不截断会撑爆 API）；test_app 清理正则修复（t48b 残留）
- **v3.70**：text 推送标题兜底截断（分类名+标题拼接超 titleMax 的漏网，与 desp 同口径）
- **v3.71**：工程化收尾（package.json + README 首次引入）；变异测试验证（7 变异零盲区）；101 章扩展 package.json 版本三方一致
- **v3.72**：push_config.local.js.example 密钥配置示例模板（新用户配置入口）
- **v3.73**：domain 配置层校验；推送模块一言日志非 Error 兜底；.git.corrupt_backup 归档 /tmp（fsck 确认后 mv）
- **v3.74**：{链接} 占位符 Markdown 安全化（<> 包裹+换行剥离，与 htmlToMarkdown 同口径）；一言失败测试；文档测试数统一
- **v3.75**：推送模块密钥泄露修复（严重）——$.post/get 失败传 Error 而非响应体（防回显）；safeErr 摘要统一 5 通道失败日志；脱敏测试扩展 + 变异验证（改回旧行为 2 红）
- **v3.76**：TG_PROXY_* 一次性警告（防误配静默失效，提示改用 TG_API_HOST）；CHANNEL_KEYS 补 TG_PROXY 字段
- **v3.77**：失败日志 safeErr 全通道统一（Bark/PushMe/wxpusher/息知 v3.75 漏网收尾）+ 对应脱敏测试
- **v3.78**：got Content-Type 大小写不敏感；Server酱/PushDeer/Telegram 异常分支日志 safeErr 截断
- **v3.79**：101 章扩展 README 版本一致性（四方：文件头/CHANGELOG/package.json/README）；run.log 文档说明
- **v3.80**：cache.dir 非字符串崩溃修复（path.join TypeError）；template 配置层校验
- **v3.81**：CLI 入口 catch 非 Error 兜底（内部已有 v3.31，入口是漏网）
- **v3.82**：UA 版本化（读 package.json，服务端可区分版本）
- **v3.83**：实体映射扩展（ensp/emsp/cent/curren/箭头，28→36）
- **v3.84**：并行模式+模板/截断组合测试（t50）
- **v3.85**：{Html内容} href 换行剥离（escUrl，v3.74 只修了 Markdown 路径）
- **v3.86**：一言响应结构防御（缺 hitokoto → 抛错跳过，不输出 undefined 垃圾文本）
- **v3.87**：一言 from 缺失防御（----undefined 残尾 → 出处留空）
- **v3.88**：run.log 摘要加 elapsed 耗时字段
- **v3.89**：README run.log 示例补 elapsed 说明
- **v3.90**：t01 增强——锁定 App.run 真实链路中 htmlToMarkdown 的 Markdown 转换结果（粗体）
- **v3.91**：test_app reset() 恢复运行配置默认值（防未来测试跨污染）
- **v3.92**：README 测试数/分工/一致性说明同步（654/575/58/21/四方）
- **v3.93**：FILE_INDEX 章节表补 100-102 章；CHANGELOG 版本连续性确认
- **v3.94**：pushUrl 双斜杠防御（domain 尾斜杠 → 404，getter 去尾斜杠）
- **v3.95**：配置矩阵防御测试（t51，全部非法值并行模式不崩）
- **v3.96**：README 目录结构同步；example 补 TG_PROXY 说明
- **v3.97**：template/push 新配置默认值契约测试；记录 TG parse_mode 候选方案（后续由 v3.132 落地 HTML 模式）
- **v3.98**：REVIEW_DECISIONS 自主进化记录标题同步（v3.62~v3.97）
- **v3.99**：example 补 Bark 扩展参数/PUSHME_URL/DEER_URL；变异抽检（saveMessages 容错 2 红）
- **v3.100**：里程碑——最终全量回归(657)+变异抽检 3 项+版本四方一致（自主进化 38 轮收官）
- **v3.101**：REVIEW_DECISIONS 当前状态节同步（657/1357 行/38 轮）
- **v3.102**：README 测试数最终同步（657/577/59）
- **v3.103**：FILE_INDEX 推送模块行数同步（646→673）
- **v3.106**：第11轮审查低风险批次 15 项——非法 max/非字符串兜底/非 Error 日志/<br/> 闭合/domain 防御/maxSize 整数化/retry 有界防死循环/原型键防御/url 三处统一/title 类型/zkt_gjc 对象防御；测试 658→674，17/17 变异全检测；新增决策 #46（validateConfig 与 App.run 的 zkt_gjc 校验路径分裂——不修，双路径防御均有效）

## 七、行为变更记录（语义调整）

- **v3.67 whitelistFilter 非法正则**：原 `catch → false`（拦截，只看它清空推送）改为 `catch → true`（放行）。理由：①App.run 主路径对非法 zkt_gjc 从来就是放行（v3.16），独立导出不应矛盾；②ReDoS 风险正则已放行，非法正则却拦截——自相矛盾；③配置错误 = 缺信息 = 保守放行（项目哲学）。代价：独立调用场景的"非法正则拦截"语义消失，由调用方自行校验（validateConfig 已负责警告）。

> 一句话哲学：**「宁可多推不可少推」+「处理完的才记，没成功的下次再试」+「缺信息保守放行」+「每个取舍都写下来」**

### 13. 阶段3 功能候选评估（2026-08-01，规划-阶段3）

| 候选 | 评估 | 决策 |
|---|---|---|
| 推送失败单条重试 | 条内立即重发可能触发 Server酱 1024「一分钟内相同内容」限流——反效果；现状「下次运行重试」更合理 | **不做** |
| Telegram HTML 渲染模式 | v3.132 已完成代码切换；仍可按需进行真机显示验收 | **已实现，真机验收可选** |
| 多数据源 | 高风险（架构级改动） | **需明确需求** |
| 失败告警通道 | 需要确认告警触发条件/接收通道 | **需明确需求** |

**结论**：当前无低风险高收益的功能可自主加——功能应由真实使用场景驱动，需用户输入需求。

### 14. 阶段4 架构拆分评估（2026-08-01，规划-阶段4）

- **候选**：主代码 1357 行单文件 → 按 9 层拆 `modules/` 子模块（Config/Utils/Formatter/RuleEngine/FilterEngine/MessageStore/Network/Pusher/App）
- **保护**：657 测试（含契约测试锁定 33 导出 + test_app 的 require.cache mock 时序）
- **风险**：中——test_app 需在 require 主模块前替换 got/notify 的 require.cache；拆分后主文件 require 子模块，若子模块加载顺序变化会破坏 mock；33 导出 re-export 需保持
- **收益**：可维护性（单文件 1357 行 → 分层文件）
- **决策**：代码已稳定（阶段 2 零遗留）；拆分是结构性重构，**收益主要在长期维护**，短期无功能收益——建议在功能需求稳定后（阶段 3 输入）再执行，避免拆完又要为功能改动

### 15. anon 身份与 id 身份不互认（AI 审查发现，2026-08-09，不修）
- **发现**：Qodo Merge 审查指出——有 id 消息不匹配无 id/url 的 anon 缓存条目，API 在有无 id 间波动时可能重推
- **不修**：真实接口恒有 id（低概率）；两身份不互认是判重契约语义（§4.1）；互认破坏判重确定性（I8）；符合"宁可多推"
- **出处**：PR_AGENT_GUIDE 工具 10 提交真实审查

### 16. WxPusher 推送耗时优化（2026-08-06，v3.209~v3.217）

- **现象**：直连网络下 20 条推送仍出现单请求 0.4~6 秒波动，阶段测速显示波动集中在 DNS（最高 4.4s）与 TLS（最高 3s），`firstByte` 反而稳定在约 0.4s。
- **根因确认**：曾使用梯子/VPN 时，DNS 与 TLS 都经过代理链路，是此前推送慢的主要原因；关闭梯子后基线已大幅改善。
- **已实施优化**（按证据驱动，非盲目调参）：
  1. 滑动窗口并发推送（并发上限默认 10，补位间隔 10ms）——100 条瞬时并发限频 31/48 次 → 滑窗 2 次，成功 100/100；
  2. WxPusher 并发轮询预占——修复并发启动时全部集中打第一个应用（真实分布 13/4/3 → 7/7/6）；
  3. 推送超时 AbortController 取消底层 got 请求——释放超时请求占用的连接；
  4. 进程内 DNS 缓存 + 并发合并（60s TTL，失败 1s）——同进程并发请求共享一次解析；
  5. WxPusher DNS 与线报接口请求并行预热——冷启动推送阶段 DNS 从约 600ms 降到约 20ms；
  6. HTTP 分阶段测速（XBK_PROFILE=2）——wait/dns/tcp/tls/request/firstByte/download 逐阶段可观测；
  7. IPv4/IPv6 强制对比开关（XBK_DNS_FAMILY=4/6）——实测当前环境 IPv4 并不更快且曾 ECONNRESET，**保持自动**。
- **实测结论**（三轮同口径 20 条真实推送）：冷 DNS 603ms → 45ms；单请求平均 531ms → 153ms；总耗时 2.1s → 0.8s。剩余最大头是 `firstByte`（服务端响应），客户端无法继续压。
- **明确不做的优化**：持久化 DNS 到磁盘（CDN/IP 变化风险）；继续提高并发（限频/TLS 错误风险）。
- **后续验证（v3.218/3.219）**：
  - `finalWait` 默认归零——推送/告警/日报/run.log 均已 await 完成，末尾固定 200ms 纯等待无必要，每次运行省 0.2s；
  - WxPusher TLS 并行预取——与线报接口请求重叠建连；预取**不 await**（后台并行，推送不等预取，推送结束后才收尾）。预取请求用 **HEAD**（无响应体，只建连+响应头）：10 个连接约 0.5s（GET 需 1.2s），快于接口返回，推送开始时全部连接就绪，第一批请求全部复用（tls=0），且无阻塞、无收尾等待（实测总计 0.85s，20 条全推）。HEAD 被服务端拒绝时回退 GET 建连；预取失败不阻断主流程。教训：预取数量要与并发窗口对齐（10），但必须用 HEAD 控制建连成本，await 式预取会产生固定等待延迟（曾实测 1.53s）。
  - 剩余最大头为 `firstByte`（WxPusher 服务端响应），客户端无法继续压。



- **现象**：8/2 跑测试突然 7 个天数过滤测试变红（8/1 全绿）
- **根因链**：
  1. 天数过滤测试写死「注册日期」`'2026-07-28'` 而非「注册 N 天前」
  2. 相对天数随真实日期推进：8/1 时 = 4 天（4<5 拦截 ✓），8/2 = 5 天（5>5 不拦截 ✗）——**恰好卡在 pingbitime 阈值边界，推进 1 天即翻转**
  3. 当初写测试用「今天附近日期」方便手算，单次运行思维，未考虑隔天重跑
- **为什么只红 7 个**：只有「期望拦截 + 日期在阈值边界」的测试受影响；非负断言/相对比较/动态反推/超老日期（2026-01-01 距 213 天）的测试即使漂移也稳定
- **对策（写死日期测试的规范）**：
  1. **依赖"今天"的测试用 `daysAgo(n)` 相对日期**（今天-n 天，永不漂移）——v3.111 已替换 34 处
  2. **断言具体天数的测试用 fake Date**（88 章已 mock Date.now，如 '61天前应=61' 受保护）
  3. 允许的超老固定日期：2020-01-01/2026-01-01（距离阈值安全边际大，且只用于"老号/不依赖天数"场景）
- **价值**：此根因只有 CI/隔天重跑才能暴露——单次运行永远全绿，印证持续集成的必要性（v3.107 引入 CI 的决策正确）

## 静态安全扫描决策（2026-08-09）

> 背景：用户要求用最严格方式运行工作区内的静态扫描工具（osv-scanner / semgrep / eslint / knip，位于 `.tools/code-audit/`），全部使用工具自带 CLI 选项（未引入新配置文件/脚本/文档）。结果按真实问题与误报分类后修复。

### 修复项（含定级）

| 项 | 定级 | 问题 | 修复 | 验证 |
|---|---|---|---|---|
| A | **P4** | CI 供应链：`actions/checkout@v4`、`actions/setup-node@v4` 用可变 tag，上游可重新指向注入攻击代码（semgrep github-actions 规则） | 固定完整 commit SHA（GitHub API 验证 v4 tag 直指该 commit，行为零变化） | semgrep 复扫：该类发现 2→0 |
| B | **P5** | 死代码：`sanitizeDecodedHtml` 中 `cleanUrlAttr` 定义未使用（eslint no-unused-vars 抓到，豁免 catch 参数后仅剩此项） | 删除（后续为内联等价实现） | eslint 复扫清零 |
| C | **P6** | 冗余转义 ×3：字符类内 `\[`/`\{` 不必要（eslint no-useless-escape） | 简化（`/[\s()\[\]]/`→`/[\s()[\]]/`、`/^[\[]{/`→`/^[[{]/`） | 行为等价 6-7 样本验证 + 全量测试 |

**定级理由**：A 无当前实际触发（需上游官方 action tag 被攻陷，概率极低），属低概率高影响的加固项；B/C 行为零变化，属整洁/风格档。均不构成 P1/P2（无消息丢失/轰炸/挂死/泄露/崩溃的当前缺陷）。

### 误报与设计取舍（不要当 bug 改）

- **eslint no-control-regex ×5**：均为**有意的安全防护**——`safeUrl` 拒绝 ASCII 控制字符、危险协议判定前清理控制空白、`sanitizeDecodedHtml` 移除 NUL。正是"URL 控制字符拒绝"契约（v3.231）的实现。
- **eslint no-unused-vars（catch 参数）×87**：`catch (e) { /* 静默 */ }` 是有意设计（告警/日报失败静默等），配置 `caughtErrors: 'none'` 豁免（ESLint 认可做法）。
- **eslint no-unmodified-loop-condition**：`while (!(signal && signal.aborted))` 中 `signal.aborted` 是 AbortSignal 响应式属性，由外部 `abort()` 修改，静态分析误报。
- **semgrep detect-non-literal-regexp ×8**：配置驱动的过滤正则（`compileRules`），已有 `hasNestedQuantifier` ReDoS 防护 + 非法正则跳过（§1.4 防御输入），属设计取舍。
- **semgrep unsafe-formatstring ×10**：`console.log` 模板拼接不解析格式说明符（非 `util.format` 风格），且内容为脱敏摘要，误报。
- **semgrep using-http-server ×18 / rest-http-client / XSS 测试字符串 / bash IFS / TG 注释示例 token**：测试基建（本地 http server）、一次性脚本或注释占位示例，非生产风险。
- **knip 22 项（unused files/exports）**：`test_*.js`/`run_tests.js`/`xbk_loop.js` 等是 npm scripts 直接运行的入口；模块导出经 `profile3Require(name, () => require(...))` 延迟加载，knip 静态分析解析不了该 require 形式，误报全部导出为 unused。项目自身的死代码测试（导出全被引用）才是权威。

### 遗留说明

- 静态扫描工具位于 `.tools/code-audit/`（已 gitignore，不入库）；本轮未新增任何配置文件或脚本，命令为一次性 CLI 参数。
- 扫描结果中的历史数字（规则数/发现数）仅为本轮快照，后续以实际运行输出为准。

---

## 16. AI 审查工具（Qodo Merge / PR-Agent）使用决策（2026-08-09）

### 16.1 受控验证：小范围审查有效（结论：工具可信）

- **实验**：在 `Utils.getMessageIdentity` 故意去掉 `String(id)` 归一化（数字 1 与字符串 '1' 不再判重，v3.14/v3.43 修过的真实 bug 类型），提交后让 AI 审单提交
- **结果**：37 秒抓到，且理由完整（"类型漂移 → idKey 数字/字符串不一致 → 破坏判重与缓存查找，应保留 String coercion"），零误报
- **结论**：单提交/小范围 AI 审查是可靠的第三道防线（与 `.tools/code-audit/` 静态扫描、`npm test` 行为验证互补）

### 16.2 大范围审查不可行（不要当需求提）

- 50 次提交 diff 148K tokens：`review` 8 分钟+ 未完成（模型对每个文件/hunk 串行调用，时间随 diff 线性增长）；`ask` 单次调用也超时（请求过大）
- 且 50 次提交的历史已被多轮人工系统审查覆盖，边际价值低
- **决策**：AI 审查只用于小范围（单提交 / HEAD~N 取小 / 刚提交的新变更）；大范围改用分组或聚焦

### 16.3 工具链事实（环境相关，变更需同步）

- 2026-02 项目从 Qodo 独立，官方仓库迁移至 `The-PR-Agent/pr-agent`（qodo-ai 旧地址重定向）
- **PyPI 停更**（停在 0.39.0），0.40+ 需源码安装；源码安装版本自报 0.41.0（官方坑）
- v0.42.0 新增 `CONFIG__OUTPUT_RUN_DETAILS=true`（审查输出 token/耗时/调用次数明细），已启用
- `LITELLM_LOCAL_MODEL_COST_MAP=True` 跳过启动时拉 GitHub 价格表的超时等待（每次省约 5s），已写入 .bashrc
- 耗时构成：启动 ~11s（Python+litellm 固定成本）+ 模型串行调用（每次 3-6s）——小 diff 约 40s 属正常

---

## 17. 企业微信瞬时错误分类修复（AI 审查发现，2026-08-09，P2 已修）

### 17.1 发现与定性

- **发现途径**：Qodo Merge（PR-Agent）AI 审查 `d3e7923`（fix: preserve retryable mixed push failures）单提交，104 秒完成，报告"Misclassification"
- **问题**：`xbk_failure_policy.js` 企业微信分支将除 45009（频控）外**所有 providerCode 判为永久**——`providerCode: 500`（系统繁忙）等瞬时错误被误判永久 → 常驻模式停止重试 → **消息丢失**（违反 I2 失败应重试 + "宁可多推"哲学）
- **定级 P2**：瞬时误判永久导致停止重试，推送消息永久丢失（不影响代码正确性但影响消息投递可靠性）

### 17.2 修复决策

- **修复**：永久范围收窄为明确配置类错误（40014/41001/42001/45001/130101：key/token 无效、缺 token、无权限、webhook 未找到），其余落回通用分类（5xx → retryable、4xx → permanent）
- **为什么收窄而非枚举所有可重试码**：宁可让不确定错误走"可重试"（多试一次/多推，符合"宁可多推"），不冒"瞬时误判永久丢消息"风险
- **为什么只修企业微信**：AI 仅报告该通道（有明确证据：45009 特判 vs 其余全永久）；wxpusher 分支模式类似但错误码语义未经确认，保持现状避免引入新风险（如需修需先确认 wxpusher 错误码语义）
- **验证**：新增回归测试（企业微信 500 → retryable、45001 → permanent），还原旧写法即变红；全量测试 26.7s 全绿
- **版本**：v3.231 → v3.232（三方一致）

---

## 18. 预热冗余 GET 与取消竞态修复（AI 审查发现，2026-08-09，P3 已修）

### 18.1 发现与定性（AI 审 18650cb 提交报告）

- **冗余 GET**（xbk_agents.js prewarmTls）：HEAD 返回 ≥400 后的 GET 若抛异常，会落到外层 catch **再发一次 GET**——同一主机连续两次建连。多余网络调用 + 错误处理混乱。**P3**（无丢失/轰炸，仅浪费一次请求）。
- **预热取消竞态**（xbk_function_v3.js）：warmupController 只在 `getNotify().then()` 回调内创建——主流程提前结束（异常/快速返回）时 finally 看到 null 不取消，`getNotify()` 稍后 resolve 后预热仍启动且无人取消 → pending 请求拖住进程退出（最长 5s）。与 v3.224/18650cb 的"运行结束取消预热"目标矛盾。**P3**（退出延迟最多 5s，非常驻挂死）。

### 18.2 修复决策

- 冗余 GET：GET 独立 try/catch，失败直接返回 error（不回落到外层 catch 重试）——语义变化：HEAD≥400 且 GET 失败时不再"外层 catch 再 GET 一次"（本就是重复请求）。
- 竞态：新增 `warmupCancelled` flag——finally 置位，then 回调凭 flag 跳过启动（含 checkpoint 标记）。不依赖 controller 是否已创建，从根上消除竞态。
- **未修项**：wxpusher 分支"非 1001 全永久"分类模式类似（v3.232 企业微信修复时评估过）——wxpusher 错误码语义未确认，保持现状（避免引入新风险）。

### 18.3 验证

- 全量测试 27.6s 全绿（含 test_lazy_notify 预热跳过/取消回归、test_tls_prewarm 建连计数）。
- 版本 v3.232 → v3.233（三方一致）。

### 18.4 工具链优化（本次审查附带）

- **审查慢的根因**：deepseek-v4-flash 是推理模型，review 时思考无上限（out tokens 1.6K~10.8K 随机波动，耗时 18s~300s+）。修复：pr-agent 包代码将 `deepseek-v4-flash` 加入 `SUPPORT_REASONING_EFFORT_MODELS` + `CONFIG__REASONING_EFFORT=low` + handler 补 `allowed_openai_params`（包修改需在升级后重打，见 PR_AGENT_GUIDE）。
- 实测效果：18650cb 审查从 300s 超时 → **74.7s 完成**。

### 18.5 复核修正（AI 审 v3.233 修复提交发现，2026-08-09）

- **问题**：v3.233 修复 1（GET 独立捕获）的内层 catch 未检查 `signal.aborted`——GET 被取消时返回 error 而非 `cancelled: true`（此前外层 catch 会识别 abort），取消语义回归。
- **影响评估**：当前无消费方消费 `cancelled`（仅 prewarmTls 内部自洽），属语义一致性回归（P3 偏下），但未来消费方会踩坑，修复成本极低。
- **修复**：内层 catch 补 `if (signal && signal.aborted) return { cancelled: true, ... }`。
- **闭环**：AI 发现 → 修复 → AI 复核修复 → 发现修复的回归 → 再修正——两轮复核链条完整。

### 18.6 复核误报记录（AI 审 v3.232+v3.233 合集，2026-08-09）

- **AI 报告**：`['40014','41001','42001','45001','130101'].includes(providerCode)` 严格相等——若 providerCode 为数字（数字 API 响应）则匹配失败，配置类错误落回通用分类。
- **实测证伪**：`classifyFailure` 开头 `const providerCode = String(info.providerCode || '').toUpperCase()` 已先转字符串，includes 匹配前 providerCode 恒为字符串；数字/字符串输入均正确分类（40014→permanent、45009→retryable、500→retryable）。
- **结论**：误报（AI 未注意到函数顶部已 String 化）。不修代码；后续 AI 再报同类问题可引用本条。

---

## 19. QingLong 空环境变量覆盖配置修复（AI 审查发现，2026-08-09，P2 已修）

### 19.1 发现与定性（AI 审 1163a11 提交报告）

- **问题**：ENV_ALIASES 覆盖逻辑用 `process.env[name] !== undefined` 判断存在——**空字符串（''）不算 undefined**，QingLong 面板中环境变量留空/误删值时，空值覆盖 `push_config.local.js` 的有效 token → 单通道用户推送通道失效（**消息丢失**）。
- **定级 P2**：触发条件为"环境变量存在但为空"（QingLong 面板常见：新增变量留空、误删值、模板默认空）；后果为静默配置破坏 + 推送失效。
- **发现途径**：Qodo Merge（PR-Agent）AI 审查 1163a11（feat: QingLong direct execution entry，55.1s）。

### 19.2 修复决策

- **修复**：`names.find()` 过滤空白值（`raw !== undefined && String(raw).trim() !== ''`）——空 env 不覆盖，保留本地配置。非空 env 行为不变。
- **为什么过滤空白而非仅空串**：面板常见值含空格（误输入），trim 后为空的同样不应覆盖。
- **验证**：新增回归测试（空 env 不覆盖、非空 env 覆盖，模块重载隔离避免 require 缓存污染）；全量测试 28.2s 全绿（通道测试 62/62）。
- **版本**：v3.233 → v3.234（三方一致）。
- **备注**：测试过程中发现 node_modules 缺 got 依赖（中间被清理），已 `npm install` 恢复（+1 package），不影响代码。

---

## 20. getNotify 模块缺失同步崩溃修复（AI 审查发现，2026-08-09，P2 已修）

### 20.1 发现与定性（AI 审 ef1116e 提交报告）

- **问题**：ef1116e（懒加载重叠保留）将缓存探测从 `try { require(...) } catch` 改为 `require.resolve()`（try-catch 外）——xbk_sendNotify_slim.js 缺失（部署不完整）时 getNotify() **同步抛 MODULE_NOT_FOUND**，调用方 `getNotify().catch()` 来不及接住 → 主流程中断（接口请求未发出即崩）。
- **定级 P2**：触发条件为推送模块文件缺失（安装/部署失误）；后果为主流程中断（比旧行为"延迟到推送阶段优雅报错"更糟）。
- **发现途径**：Qodo Merge（PR-Agent）AI 审查 ef1116e（75.2s）。

### 20.2 修复决策

- **修复**：`require.resolve` 包 try-catch——缺失时走延迟加载路径（promise 化报错），与旧行为一致。
- **验证**：新回归测试（patch Module._resolveFilename 模拟缺失，断言接口请求仍发出 fetched=true；修复前 fetched=false）；全量测试 26.6s 全绿。
- **版本**：v3.234 → v3.235（三方一致）。

### 20.3 本批审查误报记录（30 条范围内小提交）

| 提交 | AI 报告 | 结论 |
|---|---|---|
| 628ef54 | barkNotify/pushMeNotify params spread 被移除（Functional Regression）| **误报（幻觉+归因错误）**：移除发生在 63a939b（统一契约加固，body 字段收敛为配置驱动是有意设计，v3.231 已验证）；628ef54 的 diff 无相关代码；params 仍用于请求级 extras |
| 37de6b1 | PROFILE3 未定义 → ReferenceError | **误报**：PROFILE3 定义于 xbk_function_v3.js 第 9 行（AI 未见文件顶部）；双重检查冗余但无害（防御性写法）|
| 122e5d0 | ABORT_ERR 触发 onIntervalError（优雅停止虚假错误）| **真实但设计边界不修**：逻辑确凿，但 xbk_loop.js 仅被 test_loop 使用，主代码不经过该路径；记录待主代码接入 runLoop 时处理 |

### 20.4 审查速度优化：reasoning_effort=none 验证通过（2026-08-09）

- **动机**：用户反馈审查仍慢（low 模式完整 review 40-190s）。
- **对照实验**（已知 P2 d3e7923 简化 diff）：flash+low 13.9s / **flash+none 3.0s**（均抓到 P2）/ minimax-m2.7 22.1s / kimi-k2.7-code 10.0s。
- **端到端验证**（完整 review 18650cb，已知 P3×2）：**none 14.2s 抓到与 low（74.7s）完全相同的 2 个真 bug**——速度 5.3 倍、质量不降。
- **决策**：`CONFIG__REASONING_EFFORT` 由 low 改为 **none**（已写入 .bashrc）。找 bug 任务的准确性由模型能力保证（flash 本身强），思考预算削减不损失此类任务的表现；若未来遇到需深层推理的场景可临时切回 low/medium。
- **附带验证**：none 审 d3e7923 报的 classifySummary issue 经确认是误报（pushed>0 → null 是 v3.231"部分成功不熔断"契约，设计正确），不修。

---

## 21. 缓存恢复写入异常降级修复（AI 审查发现，2026-08-09，P3 已修）

### 21.1 发现与定性（AI 审 b22f7d6 提交报告）

- **问题**：MessageStore.readMessages 的"文件缺失恢复写入"路径未包 try-catch——外部误删缓存文件 + 恢复写入抛错（磁盘满/权限）时异常传播出 readMessages → 判重流程崩溃。正常流程不触发（需"外部删文件 + 写入失败"叠加）。
- **定级 P3**：边界场景崩溃（无消息丢失/轰炸，仅恢复路径）。
- **发现途径**：Qodo Merge（PR-Agent）AI 审查 b22f7d6（reasoning_effort=none，17.9s）。

### 21.2 修复决策

- 恢复写入包 try-catch，抛错时降级保留内存快照（与 `!restored` 路径一致）。
- 版本 v3.235 → v3.236（三方一致），全量测试 33.8s 全绿。
- **同批误报/设计边界**：b22f7d6 另 2 条（app.num 契约保证传入、sleep 双重 resolve 不存在——done 内 removeEventListener 双保险）均为误报；be614c6 3 条、13d099a 2 条均为安全加固的有意副作用（设计边界不修）。
