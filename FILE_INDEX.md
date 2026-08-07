# 📁 文件索引 / FILE_INDEX(最详细版)

> 本文件记录仓库内每个文件是干什么的、里面有什么、怎么用。
> 覆盖粒度:模块结构 → 关键函数 → 配置项 → 测试章节 → 使用命令 → 注意事项。

---

## 一、运行相关

### `xbk_function_v3.js` — 主代码(推送脚本核心)

**定位**:唯一的主程序，通过 `npm start` 运行。职责分层架构。

**运行流程**(`App.run()` 主流程):
```
校验配置 → 预编译规则 → filterHash 比对(规则变更失效过滤缓存)
→ 拉取数据 + 并行预热 WxPusher DNS → 缓存/批内索引化判重 → 字段归一化+过滤(_f 标记) → 只看它
→ maxPerRun 截断 → 推送(顺序/滑动窗口并行) → 写缓存(成功才写) → 统计
→ 运行日志 + 告警/日报 → 失败重抛(exit 1)
```

**性能诊断**:`XBK_PROFILE=1` 输出阶段摘要；`XBK_PROFILE=2` 额外输出 DNS 预热、TLS 预取、预处理、缓存写入、收尾等待及每个 WxPusher 请求的 wait/dns/tcp/tls/request/firstByte/download 分阶段耗时。`XBK_DNS_FAMILY=4/6` 可强制对比 IPv4/IPv6 路径（默认自动）。启动时并行预热 WxPusher DNS，并用 HEAD 请求在后台预建与并发窗口对齐的 HTTPS 连接（默认 10 个，不阻塞推送）。

**分层结构**:

| 层 | 内容 | 关键内容 |
|---|---|---|
| **Config** | 全部配置 | domain/api(超时/重试)/filter(过滤字段)/keyword/timing/push(顺序并行)/cache(maxSize)/storage(磁盘余量告警) |
| **常量** | 魔法数 | DAY_MS/TS_BOUND/MAX_CODE_POINT/SURROGATE/DEFAULT_MAX_SIZE/FILTER_FIELDS |
| **Utils** | 工具函数 | daysComputed(日期/时间戳/ISO/紧凑日期)/normUrl(归一化+幂等)/hasValidId/isValidItem/anonKey(合成id)/decodeHtmlEntities(实体+数字+emoji)/daysFrom/_decodeNumeric |
| **Formatter** | 格式化纯函数 | htmlToMarkdown(正则链+短路)/tuisong_replace(占位符替换+惰性)/_finalizeMd |
| **RuleEngine** | 规则引擎 | _splitLines/_parseLine/compileRules(预编译)/matchesCompiled/checkTimeCompiled/validateConfig(警告)/_compileCatRe/_validateCatRe/_catMatches/_anyRule |
| **FilterEngine** | 过滤引擎 | checkRegisterTime(注册天数)/checkCategory(分类)/checkFields(三级屏蔽优先级)/listfilter/whitelistFilter/_passIfMissing |
| **MessageStore** | 缓存管理 | _findDedupIndex(判重)/_upsert/_resetCache/save/saveBatch(复用)/has/readMessages/saveMessages(原子写)/getFileName/getFilePath(防逃逸) |
| **Network** | 网络层 | fetchData(4xx不重试/429重试/jitter/UA/Accept) |
| **Pusher** | 推送层 | send(超时,抛错由主流程处理) |
| **App** | 主流程 | run(含并行/顺序推送双模式) |
| **导出** | 供测试 | 导出 + Pusher + Config |

**关键设计**:
- 推送成功才写缓存(失败下次重试,不永久丢失);被过滤/只看它滤掉的标记 `_f`(规则变更自动失效重评)
- **判重一处语义、三处同构**：`_findDedupIndex`（缓存判重）、App.run 批内+缓存索引判定与 saveBatch 索引必须保持同构——批内判重 ≡ 跨运行判重（属性测试锁定）
- **判重索引化 O(N+M)**（v3.179）：缓存三索引 + 批内三索引合并，避免海量接口数据触发逐条 `has()` 的 O(N×M) 扫描
- 原子写入(tmp+rename)、路径防逃逸(basename)、maxSize 滚动淘汰(字符串配置经 Utils.num 生效)
- 合成 id(anonKey)支持无 id 无 url 数据跨运行去重(含 title/content/posttime/pic/mall/price/brand/cate/louzhu)

**配置项速查**:完整配置（含默认值）见代码顶部 Config——不在此重复维护（避免与代码不同步）：
```js
Config.domain              // 接口域名
Config.api.timeout/retry   // 网络超时/重试次数
Config.filter.*            // 过滤规则(屏蔽/展现/强化)
Config.keyword.zkt_gjc     // 只看它关键词
Config.timing.pushInterval // 顺序模式条间间隔
Config.push.mode           // 'sequential'顺序 | 'parallel'并行（当前默认并行）
Config.push.parallelLimit  // 并行并发上限(0=不限)
Config.push.titleMax       // 推送标题截断长度(非法回退默认)
Config.push.contentMax     // 推送内容最终长度上限(非法回退默认)
Config.template.title      // 推送标题模板(默认【{分类名}】{标题},支持全部占位符)
Config.template.content    // 推送内容模板(默认{Markdown内容})
Config.cache.maxSize       // 缓存上限(滚动淘汰)
Config.storage.minFreeBytes // 磁盘余量告警阈值（只告警，不阻断推送）
```

**注意**:文件头版本号由版本一致性测试自动校验（与 CHANGELOG 最新/package.json 的一致性自动校验）——版本更新时无需手动核对文档;`require.main === module` 时才自动运行(被 require 时不跑)。

---

### `xbk_storage.js` — 安全文件与状态存储基础设施

**定位**:统一普通文件检查、安全原子写入、受保护文本读取；消息缓存、运行日志和告警/日报状态共用同一套文件安全边界。

**安全约束**:
- 拒绝符号链接和目录作为写入目标；
- 使用唯一临时文件和原子 `rename`；
- 写入失败清理临时文件并返回失败，不伪装成持久化成功；
- 文本读取只接受普通文件。

---

### `stryker.config.js` — StrykerJS 变异测试配置

**定位**:正式变异测试入口。使用 Stryker 的 command runner 执行完整单元测试命令，并限制生产源码变异范围；并发数通过 `STRYKER_CONCURRENCY` 调整，默认按当前设备能力取安全上限。

**测试命令**:
```bash
# 先安装/准备 StrykerJS，再执行
npm run test:mutation
```

**边界**:
- `test_filter.js` 作为一个自定义测试命令运行，内部覆盖完整单元测试集；
- `coverageAnalysis` 关闭，避免自定义测试命令被错误拆分；
- 变异在 Stryker 临时目录中执行，不修改工作区源文件。

---

### `xbk_sendNotify_slim.js` — 推送模块(各通道实现)

**定位**:主代码依赖的推送实现。实现推送通道的请求构造与发送(Push+/Server酱/Bark/PushMe/企业微信/wxpusher/息知/PushDeer/Telegram),sendNotify 并行发送全部已配置通道。

**结构**:
| 部分 | 内容 |
|---|---|
| `push_config` | 各通道配置项(BARK_PUSH/PUSH_KEY/PUSHME_KEY/WX_pusher/WX_pusher_channels/DEER/QYWX…) |
| `push_config.local.js` 加载 | 自动加载本地密钥覆盖默认空值(不入库) |
| `one()` | 一言(随机句子)获取,失败不中断 |
| `$` 对象 | got.post/get 封装(JSON 解析 + 回调风格) |
| 各 notify 函数 | pushPlusNotify/serverNotify(Server酱)/barkNotify/PushMe/qywxBot/wxPusher/息知/pushDeer |
| `sendNotify` | 主入口:无通道时 reject(不静默成功);并行发所有已配置通道 |

**通道细节**:
- Server酱:SCT 前缀走 Turbo 版 URL,表单 `text/desp` URL 编码
- Bark:设备码 `#` 分割、非 http 前缀自动补 `https://api.day.app/`
- PushMe:多 key 分割、`type: 'markdown'`
- PushDeer:全字段 encodeURIComponent
- 企业微信:webhook URL + key
- wxpusher:topicIds 数组、contentType 3(Markdown)；支持 `WX_pusher_channels` 多应用按消息分流和限频后切换

**注意**:**含真实密钥的 `push_config.local.js` 不入库**(`.gitignore` 忽略),密钥只存在于本地。推送失败会被主流程感知(无通道 reject / 抛错)。

---

### `push_config.local.js` — 本地推送密钥(不入库)

**定位**:存放真实推送密钥的本地配置文件。由 `xbk_sendNotify_slim.js` 自动加载并覆盖默认空值。

**内容**:`module.exports = { PUSH_KEY, WX_pusher_appToken, WX_pusher_topicIds, PUSHME_KEY }`。

**安全**:已被 `.gitignore` 忽略,**绝不提交到仓库**。密钥从 git 历史找回后写入此文件(第 6 轮审查发现硬编码密钥的安全问题后改为本方案)。

**注意**:此文件只存在于你的工作区;别人克隆仓库后需自行创建(参考 `push_config.local.js.example` 示例模板)并填自己的 key。

### `push_config.local.js.example` — 密钥配置示例模板(可入库)

**定位**:新用户配置密钥的示例模板(全字段占位注释,无真实密钥)。复制为 `push_config.local.js` 后填入自己的 key。README 快速开始引用。

---

### `xianbaoku_cache/` — 运行缓存目录(不入库)

**定位**:去重缓存目录(自动生成)。`.gitignore` 忽略。

**内容**:`push.json`(运行缓存,有上限,滚动淘汰)+ 测试运行时产生的临时文件(可清理)。

**机制**:推送成功后写缓存(失败不写,下次重试)→ 下次运行同 id/url 判重跳过。

**注意**:缓存有上限不会无限增长;目录可随时清空(下次运行重建)。

---

## 二、测试相关

### `test_filter.js` — 单元测试

**定位**:主测试文件,涵盖多种测试手段,按章节组织。

**章节结构**:

| 手段 | 内容 |
|---|---|---|
| 行为测试 | listfilter/过滤/天数/多行/只看它/边界/组合 |
| 冲突覆盖 | 三级屏蔽优先级全排列 |
| 更多覆盖 | saveBatch/缓存/惰性/Config/fetchData/内部方法 |
| 变异盲区修复 | 历轮变异测试发现的盲区补齐(逐轮编号) |
| 审查修复 | 历轮审查的修复测试 |
| 复查/批量 | 通读复查 + 高价值修复测试 |
|  **性质测试** | 不变量(daysComputed非负/decode只缩短/normUrl幂等/anonKey确定/标签不残留/占位符全替换/getFileName后缀/compileRules契约) |
|  **契约测试** | 导出键存在+类型正确+bind 生效+判重口径一致 |
|  **快照测试** | 完整输出锁定(htmlToMarkdown/tuisong_replace) |
|  **性能基准** | htmlToMarkdown/tuisong/listfilter 性能阈值（具体值见 test_filter.js） |
|  **分支覆盖** | 关键 if 两方向显式验证 |
|  **安全测试** | 原型污染 + 输出注入(抓到 javascript: XSS 注入面) |
|  **稳定性/时间旅行/竞态** | 内存不增长/fake Date 确定性/并发原子写/内存缓存上限 |
|  **配置矩阵** | 配置组合 listfilter 不崩 |
|  **死代码检测** | 导出全被引用/内部 helper 都被调用 |
|  **Unicode 深度** | emoji 代理对/全角/组合/零宽 + truncateUtf16 代理对安全截断 |
|  **故障注入** | fs.writeFileSync/readFileSync/renameSync/mkdirSync/readdirSync 抛错 + 双故障(read+write) + 循环引用序列化 |
|  **深度嵌套压力** | 深层 HTML/多条规则 |
|  **兼容/契约/一致性** | 旧缓存兼容/默认值全量契约/内存磁盘一致 |
|  **ReDoS 防护** | 嵌套量词灾难性回溯检测(hasNestedQuantifier)+compileRules/validateConfig/whitelistFilter/App.run 全入口拦截+端到端不卡死 |
|  **一致性修复** | validateConfig 多行分隔符含单独 `\r`(与 _splitLines 口径一致), 分隔符(<br>/\n/\r\n/\r)解析一致 |
|  **官方 got 直测** | 本地 HTTP server：重定向/4xx 响应/超时/POST JSON body/UTF-8 跨 chunk/原始 JSON/连接失败/官方 timeout 与响应体读取 |
|  **异常路径批量** | 未知占位符保留/对象字段不崩/重定向循环停止/连接拒绝 ECONNREFUSED/timeout 归一 |
|  **边界精确值** | TS_BOUND 精确分界/normUrl 极端/pingbitime 边界值/编码大小写-超范围-代理区-NUL |
|  **审查项 #56/#65/#7/#链接** | img 空 src/url 换行/maxSize 校验/{链接} Markdown 安全化 |
|  **版本一致性** | 文件头 ↔ CHANGELOG 最新 ↔ package.json 三方一致（防版本号过时；README 不维护版本号） |
|  **配置防御/实体扩展** | cache.dir 非字符串回退/实体映射扩展/href 换行剥离 |
|  **低风险修复批次** | R1-R6/R9：truncateUtf16 非法max/getFileName 非字符串/_splitLines <br\/\>/domain 防御/maxSize 整数化/retry 有界/原型键/url 三处统一/title 类型/zkt_gjc 对象防御（v3.106 第11轮审查 15 项） |

**运行**:`npm run test:filter`,退出码 0=全绿。

---

### `test_app.js` — 集成测试

**定位**:mock got/notify 验证 App.run 完整主流程。

**覆盖场景**:
- 拉取→推送完整链路、缓存去重、空数据、字段归一化
- 批内去重(id/url/匿名合成 id)
- 过滤生效、只看它、keyword 非法/空白
- fetchData 重试(5xx/429/超时)、4xx 不重试、非数组、非 Error 异常
- 推送失败不写缓存、部分失败只缓存成功的
- **并行推送模式**:parallel 全推/parallelLimit 限并发/部分失败/与 sequential 一致性
- **ReDoS 防护**:zkt_gjc/filter 配置嵌套量词正则 → 警告+忽略+不卡死
- **url 类型防御**:对象/空 url 不崩溃、协议相对 `//` 不拼前缀
- 绝对 URL/协议/ftp/相对 URL 拼接
- UA/Accept 请求头

**机制**:在 require 主模块**前**替换 `require.cache` 的 got/notify(模块加载时引用固定,测试中再改无效——这是反复踩过的坑)。

**运行**:`npm run test:app`（默认推荐；需要与 CI 完全一致时使用 `npm run test:app:serial`）。

---

### `test_notify.js` — 推送通道适配器测试

**定位**:mock got 验证各推送通道的**请求构造**(URL/body/headers/编码/设备分割)。

**覆盖**:
- Server酱:URL 含 key、表单 URL 编码、SCT 前缀走 Turbo 版
- Bark:多设备 `#` 分割、设备码补全 https
- PushDeer:全字段 encodeURIComponent(& 转义)
- 企业微信:webhook URL+key、msgtype
- wxpusher:topicIds 数组、contentType 3
- PushMe:多 key `#` 分割、type markdown
- Push+:token + JSON body、换行转 `<br>`
- 一言 HITOKOTO:启用时先请求一言再推送（断言内容追加到 desp）
- 日志脱敏:完整 key/token/设备码/URL 不出现在日志 + Bark 脱敏形式
- 息知:WX_XIZHI_KEY 作为 URL + JSON body
- Telegram:bot token+chat_id+Markdown+自定义 host+缺 chat_id 不影响其他通道
- Bark 扩展参数:ARCHIVE/GROUP/SOUND/LEVEL/ICON/URL 传递
- 无通道时 reject 且零请求

**注意**:每个测试用 withChannels 清空全部通道只配被测通道(防本地密钥/跨测试污染);test() 必须 await async fn(曾因不 await 导致 7/7 假通过)。

**独立文件原因**:需在 require `xbk_sendNotify_slim.js` 前替换 got(模块加载时引用固定)。

**运行**:`npm run test:notify`。

---

## 三、文档相关

### `FILE_INDEX.md` — 本文件(文件用途索引)

仓库内每个文件的定位、结构、内容、用法、注意事项。

### `BUG_AUDIT.md` — Bug、P1/P2 审计与验证记录

**定位**：合并真实 Bug 记录与 P1/P2 深度审计，覆盖问题触发、影响面、修复方式、资源生命周期、HTTP 连接、内存和稳定性验证。

### `REVIEW_DECISIONS.md` — 审查决策记录

**定位**:记录历轮代码审查中「为什么修」「为什么不修」的完整取舍。

**内容**:
- 历轮审查概览(修复数+核心内容)
- **设计取舍(不修项)**:多项,每项含「问题→为什么不修→出处」(Config 不冻结/内存缓存不失效/缺字段保守放行/并发无锁/空值不匹配…)
- **修复意图**:多类关键修复背后的设计理由(推送成功才写缓存/判重统一/原子写入/失败重抛/防御输入…)
- 核心哲学:宁可多推不可少推 / 处理完的才记 / 缺信息保守放行 / 每个取舍都写下来

**用途**:防止未来有人把设计取舍当 bug 改掉;快速理解每个决定的依据。

### `CHANGELOG.md` — 变更日志

版本演进记录(见 [CHANGELOG.md](CHANGELOG.md)),每轮修复/重构/功能变更的摘要。

---

## 四、配置/依赖

### `.gitignore` — 忽略规则

```
node_modules/        # npm 依赖（全部由 npm install 按 package.json 生成）
xianbaoku_cache*/    # 运行缓存（含测试/多实例隔离目录）
push_config.local.js # 本地密钥(必须忽略!)
```

注意：`node_modules/` 整体忽略，官方 got 及其传递依赖均由 `npm install --ignore-scripts` 按 `package.json` / `package-lock.json` 生成，不提交依赖源码。

### `node_modules/got/` — 官方 got HTTP 客户端

**定位**:官方 CommonJS got 客户端，版本由 `package.json` / `package-lock.json` 管理；项目部署和 CI 通过 `npm install --ignore-scripts` 生成依赖，不把 `node_modules` 纳入 Git。

**功能**:官方重定向、JSON 解析、HTTP 错误响应、请求超时、重试、Keep-Alive/连接复用和 GET/POST。

**注意**:首次部署或 CI 需先执行 `npm install --ignore-scripts`；测试通过 `require.resolve('got')` 注入 mock，不再依赖自制模块的固定 `index.js` 路径。

### `xbk_http.js` — 官方 got 薄封装

**定位**:不重新实现 HTTP，只在官方 got 之上补项目契约：流式累计响应体大小、超过上限时终止请求、解析 JSON、保留 HTTP 错误状态。

**使用**:主接口拉取通过 `fetchJson()` 调用；推送通道仍直接使用官方 got。

---

## 五、使用入口速查

```bash
# 青龙面板任务入口（不依赖当前工作目录，依赖缺失时自动补齐）
node qinglong/xbk_push.js

# 运行推送(真实拉取+推送)
npm start

# 跑全部测试
npm test
# 或分别运行：
npm run test:filter
npm run test:app
npm run test:notify

# 切换并行推送(主代码 Config.push.mode = 'parallel')
# 配置推送密钥(编辑 push_config.local.js,不入库)
# 清缓存(rm xianbaoku_cache/push.json,下次运行重建)
```

### `README.md` — 项目首页(快速上手)

**定位**:仓库最外层说明——项目简介、特性、快速开始(含密钥配置)、测试、cron 示例、配置速查、目录结构、安全红线。新人第一入口。

### `SYSTEM_CONTRACT.md` — 系统契约

**定位**:规范描述（normative）——设计理念(宁可多推不可少推等五大原则)、系统不变量(I1-I9)、判重三条件契约、缓存写入时机、时间口径约定、配置传播契约(Utils.num/filterHash/FILTER_FIELDS 耦合)、设计边界与已知取舍(多实例/超时歧义等不修项)。**改代码前必读**；代码位置仅作参考，契约文字不随版本过时。

### `package.json` — 工程化入口

**定位**:`npm start`(运行推送)/`npm test`(经 run_tests.js 一键三套件+汇总报告)/`npm run test:filter`/`npm run test:app`/`npm run test:app:serial`/`npm run test:notify`；官方 got 依赖声明。版本一致性测试校验其 version 与文件头一致。

### `run_tests.js` — 统一测试入口

**定位**:一键执行三套测试 + 汇总报告（✅/❌/耗时/退出码）——`npm test` 指向它。CI 与本地统一入口。

### `test_app_p.js` — test_app 并行调度器

**定位**：test_app 集成测试并行调度器（独立进程、worker 独立缓存目录、精确名单分片、失败片串行重跑）——`npm run test:app`。并发可通过 `CONCURRENCY=N npm run test:app` 调整；需要与 CI 一致的串行完整验证时使用 `npm run test:app:serial`。

### `.github/workflows/test.yml` — GitHub Actions CI 配置

**定位**：GitHub Actions——push/PR 自动安装官方 got 依赖，并按工作流配置执行单元、通道和串行集成测试；全部 PASS 才可合并。

### `qinglong/xbk_push.js` — 青龙面板常驻执行入口

**定位**：不依赖当前工作目录，自动定位项目根目录并补齐依赖；启动一次后在同一进程内循环执行 `App.run()`，复用主模块、got、Agent、DNS 缓存和 Keep-Alive 连接池。

**行为**：每轮完成后等待配置间隔再拉取；定期在等待期间后台刷新接口/WxPusher DNS 并预热少量 TLS 连接，不阻塞下一轮；单轮异常记录后继续下一轮；收到 SIGTERM/SIGINT 时在当前轮结束后安全停止。通过 `XBK_INTERVAL_MS` 覆盖轮询间隔。单次运行仍使用 `npm start`。

### `xbk_loop.js` — 常驻循环调度器

**定位**：提供可测试的长驻循环、间隔等待、AbortSignal 停止和单轮错误隔离。青龙入口使用它，测试通过 `test_loop.js` 锁定异常不中断和优雅停止语义。

### `.workflow/master-pipeline.yml` — 分阶段流水线配置

**定位**：按阶段执行单元测试、并行集成测试、通道测试和最终汇总；命令与 `package.json` 的 npm scripts 保持一致。

---

## 六、数据关系图

```push_config.local.js ──加载──> xbk_sendNotify_slim.js <──依赖── xbk_function_v3.js
     (密钥,不入库)              (推送通道)                  (主代码)
                                                              │
        test_notify.js ──测──> xbk_sendNotify_slim.js        │ require
        test_app.js ────测──> xbk_function_v3.js <───────────┘
        test_filter.js ──测──> xbk_function_v3.js
                     (全部经 require.cache mock got/notify)
```
