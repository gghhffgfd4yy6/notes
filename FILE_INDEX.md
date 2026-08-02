# 📁 文件索引 / FILE_INDEX(最详细版)

> 本文件记录仓库内每个文件是干什么的、里面有什么、怎么用。
> 覆盖粒度:模块结构 → 关键函数 → 配置项 → 测试章节 → 使用命令 → 注意事项。

---

## 一、运行相关

### `xbk_function_v3.js` — 主代码(推送脚本核心)

**定位**:唯一的主程序,`node xbk_function_v3.js` 直接运行。约 1390 行,9 层职责分层架构。

**运行流程**(`App.run()` 主流程):
```
校验配置 → 预编译规则 → 拉取数据 → 字段归一化+去重 → 过滤 → 只看它
→ 推送(顺序/并行) → 写缓存 → 统计 → 失败重抛(exit 1)
```

**9 层结构**:

| 层 | 内容 | 关键内容 |
|---|---|---|
| **Config**(1-90 行) | 全部配置 | domain/api(超时5s/重试2)/filter(11个过滤字段)/keyword/timing/push(顺序并行)/cache(maxSize100) |
| **常量**(90-110) | 魔法数 | DAY_MS/TS_BOUND/MAX_CODE_POINT/SURROGATE/DEFAULT_MAX_SIZE/FILTER_FIELDS |
| **Utils**(~110-240) | 工具函数 | daysComputed(日期/时间戳/ISO/8位)/normUrl(归一化+幂等)/hasValidId/isValidItem/anonKey(合成id)/decodeHtmlEntities(28实体+数字+emoji)/daysFrom/_decodeNumeric |
| **Formatter**(~240-330) | 格式化纯函数 | htmlToMarkdown(正则链+短路)/tuisong_replace(占位符替换+惰性)/_finalizeMd |
| **RuleEngine**(~330-520) | 规则引擎 | _splitLines/_parseLine/compileRules(预编译)/matchesCompiled/checkTimeCompiled/validateConfig(警告)/_compileCatRe/_validateCatRe/_catMatches/_anyRule |
| **FilterEngine**(~520-620) | 过滤引擎 | checkRegisterTime(注册天数)/checkCategory(分类)/checkFields(三级屏蔽优先级)/listfilter/whitelistFilter/_passIfMissing |
| **MessageStore**(~620-780) | 缓存管理 | _findDedupIndex(判重)/_upsert/_resetCache/save/saveBatch(复用)/has/readMessages/saveMessages(原子写)/getFileName/getFilePath(防逃逸) |
| **Network**(~780-810) | 网络层 | fetchData(4xx不重试/429重试/jitter/UA/Accept) |
| **Pusher**(~810-820) | 推送层 | send(10s超时,抛错由主流程处理) |
| **App**(~820-960) | 主流程 | run(含并行/顺序推送双模式) |
| **导出**(~960-1200) | 供测试 | 33 个导出 + Pusher + Config |

**关键设计**:
- 推送成功才写缓存(失败下次重试,不永久丢失)
- 判重三处统一(has/save/saveBatch → `_findDedupIndex`)
- 原子写入(tmp+rename)、路径防逃逸(basename)
- 合成 id(anonKey)支持无 id 无 url 数据跨运行去重

**配置项速查**:
```js
Config.domain              // 接口域名
Config.api.timeout/retry   // 网络超时(5s)/重试次数(2=最多3次)
Config.filter.*            // 11 个过滤规则(屏蔽/展现/强化)
Config.keyword.zkt_gjc     // 只看它关键词
Config.timing.pushInterval // 顺序模式条间间隔(100ms)
Config.push.mode           // 'sequential'顺序 | 'parallel'并行
Config.push.parallelLimit  // 并行并发上限(0=不限)
Config.push.titleMax       // 推送标题截断长度(默认100,非法回退)
Config.push.contentMax     // 推送内容最终长度上限(默认3000,含Markdown转换结果,非法回退)
Config.template.title      // 推送标题模板(默认【{分类名}】{标题},支持全部占位符)
Config.template.content    // 推送内容模板(默认{Markdown内容})
Config.cache.maxSize       // 缓存上限(10000条,滚动淘汰)
```

**注意**:文件头版本号(v3.136)需人工维护,但已有 101 章版本一致性测试自动校验(文件头/CHANGELOG 最新/package.json/README 四方一致);`require.main === module` 时才自动运行(被 require 时不跑)。

---

### `xbk_sendNotify_slim.js` — 推送模块(各通道实现)

**定位**:主代码依赖的推送实现,约 673 行。实现 9 个推送通道的请求构造与发送(Push+/Server酱/Bark/PushMe/企业微信/wxpusher/息知/PushDeer/Telegram),sendNotify 并行发送全部已配置通道。

**结构**:
| 部分 | 内容 |
|---|---|
| `push_config`(9-90 行) | 各通道配置项(BARK_PUSH/PUSH_KEY/PUSHME_KEY/WX_pusher/DEER/QYWX…) |
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
- wxpusher:topicIds 数组、contentType 3(Markdown)

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

**内容**:`push.json`(运行缓存,最多 100 条,滚动淘汰)+ 测试运行时产生的临时文件(可清理)。

**机制**:推送成功后写缓存(失败不写,下次重试)→ 下次运行同 id/url 判重跳过。

**注意**:缓存有上限(100 条)不会无限增长;目录可随时清空(下次运行重建)。

---

## 二、测试相关

### `test_filter.js` — 单元测试(约 586 个)

**定位**:主测试文件(约 5049 行),涵盖 20+ 种测试手段,按章节组织。

**章节结构**(📂 编号):

| 章节 | 手段 | 内容 |
|---|---|---|
| 1-28 | 行为测试 | listfilter/过滤/天数/多行/只看它/边界/组合 |
| 27-28 | 冲突覆盖 | 三级屏蔽优先级全排列 |
| 29-43 | 更多覆盖 | saveBatch/缓存/惰性/Config/fetchData/内部方法 |
| 44-61 | 变异盲区修复 | 历轮变异测试发现的盲区补齐(逐轮编号) |
| 62-70 | 审查修复 | v3.14-v3.22 审查的修复测试 |
| 71-81 | 复查/批量 | 通读复查 + 300项清单高价值修复测试 |
| **82** | **性质测试** | 不变量(daysComputed非负/decode只缩短/normUrl幂等/anonKey确定/标签不残留/占位符全替换/getFileName后缀/compileRules契约) |
| **83** | **契约测试** | 33 个导出键存在+类型正确+bind 生效+判重口径一致 |
| **84** | **快照测试** | 6 个完整输出锁定(htmlToMarkdown/tuisong_replace) |
| **85** | **性能基准** | htmlToMarkdown 1000次<500ms/tuisong 1000次<300ms/listfilter 5000次<500ms |
| **86** | **分支覆盖** | 关键 if 两方向显式验证(7 个) |
| **87** | **安全测试** | 原型污染(3)+输出注入(2,抓到 javascript: XSS 注入面) |
| **88** | **稳定性/时间旅行/竞态** | 内存不增长/fake Date 确定性/并发原子写/内存缓存上限 |
| **89** | **配置矩阵** | 2^10 组合 listfilter 不崩 |
| **90** | **死代码检测** | 导出全被引用/内部 helper 都被调用 |
| **91** | **Unicode 深度** | emoji 代理对/全角/组合/零宽 + truncateUtf16 代理对安全截断 |
| **92** | **故障注入** | fs.writeFileSync/readFileSync/renameSync/mkdirSync/readdirSync 抛错 + 双故障(read+write) + 循环引用序列化 |
| **93** | **深度嵌套压力** | 100 层 HTML/100 条规则 |
| **94** | **兼容/契约/一致性** | 旧缓存兼容/默认值全量契约/内存磁盘一致 |
| **95** | **ReDoS 防护** | 嵌套量词灾难性回溯检测(hasNestedQuantifier)+compileRules/validateConfig/whitelistFilter/App.run 全入口拦截+端到端不卡死 |
| **96** | **一致性修复** | validateConfig 多行分隔符含单独 `\r`(与 _splitLines 口径一致)，4 种分隔符(<br>/\n/\r\n/\r)解析一致 |
| **97** | **自制 got 直测** | 本地 HTTP server：302 重定向/协议相对 `//` 重定向/4xx 带 statusCode/ETIMEDOUT 超时/POST JSON body/UTF-8 跨 chunk 不乱码/响应体超限 EBODYLIMIT |
| **98** | **异常路径批量** | 未知占位符保留/对象字段不崩/重定向循环停止/连接拒绝 ECONNREFUSED/timeout 归一 |
| **99** | **边界精确值** | TS_BOUND 精确分界/normUrl 极端/pingbitime 0-极大-负数/编码大小写-超范围-代理区-NUL |
| **100** | **审查项 #56/#65/#7/#链接** | img 空 src/url 换行/maxSize 校验/{链接} Markdown 安全化 |
| **101** | **版本一致性** | 文件头 ↔ CHANGELOG ↔ package.json ↔ README 四方一致（防版本号过时） |
| **102** | **配置防御/实体扩展** | cache.dir 非字符串回退/实体扩展(36 个)/href 换行剥离 |
| **103** | **低风险修复批次** | R1-R6/R9：truncateUtf16 非法max/getFileName 非字符串/_splitLines <br\/\>/domain 防御/maxSize 整数化/retry 有界/原型键/url 三处统一/title 类型/zkt_gjc 对象防御（v3.106 第11轮审查 15 项） |

**运行**:`node test_filter.js`(约 1.6s),退出码 0=全绿。

---

### `test_app.js` — 集成测试(约 67 个)

**定位**:mock got/notify 验证 App.run 完整主流程(约 1252 行)。

**覆盖场景**:
- 拉取→推送完整链路、缓存去重、空数据、字段归一化
- 批内去重(id/url/匿名合成 id)
- 过滤生效、只看它、keyword 非法/空白
- fetchData 重试(5xx/429/超时)、4xx 不重试、非数组、非 Error 异常
- 推送失败不写缓存、部分失败只缓存成功的
- **并行推送模式**(t41-44):parallel 全推/parallelLimit 限并发/部分失败/与 sequential 一致性
- **ReDoS 防护**(t41-42):zkt_gjc/filter 配置嵌套量词正则 → 警告+忽略+不卡死
- **url 类型防御**(t43-44):对象/空 url 不崩溃、协议相对 `//` 不拼前缀
- 绝对 URL/协议/ftp/相对 URL 拼接
- UA/Accept 请求头

**机制**:在 require 主模块**前**替换 `require.cache` 的 got/notify(模块加载时引用固定,测试中再改无效——这是反复踩过的坑)。

**运行**:`node test_app.js`(约 26s,含重试等待场景)。

---

### `test_notify.js` — 推送通道适配器测试(21 个)

**定位**:mock got 验证各推送通道的**请求构造**(URL/body/headers/编码/设备分割),约 232 行。

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

**运行**:`node test_notify.js`。

---

## 三、文档相关

### `FILE_INDEX.md` — 本文件(文件用途索引)

仓库内每个文件的定位、结构、内容、用法、注意事项。

### `REVIEW_DECISIONS.md` — 审查决策记录

**定位**:记录历轮代码审查中「为什么修」「为什么不修」的完整取舍。

**内容**:
- 12 轮审查概览(修复数+核心内容)
- **设计取舍(不修项)**:18+ 项,每项含「问题→为什么不修→出处」(Config 不冻结/内存缓存不失效/缺字段保守放行/并发无锁/空值不匹配…)
- **修复意图**:8 类关键修复背后的设计理由(推送成功才写缓存/判重统一/原子写入/失败重抛/防御输入…)
- 核心哲学:宁可多推不可少推 / 处理完的才记 / 缺信息保守放行 / 每个取舍都写下来

**用途**:防止未来有人把设计取舍当 bug 改掉;快速理解每个决定的依据。

### `CHANGELOG.md` — 变更日志

版本演进记录(v3.0 → v3.136),每轮修复/重构/功能变更的摘要。

---

## 四、配置/依赖

### `.gitignore` — 忽略规则

```
node_modules/        # 依赖(除 got)
xianbaoku_cache/     # 运行缓存
push_config.local.js # 本地密钥(必须忽略!)
```

注意:`!node_modules/got/` 是反向规则——**自制 got 模块被刻意追踪**(修复 4xx 未提交的历史问题)。

### `node_modules/got/index.js` — 自制精简 HTTP 模块

**定位**:替代真实 got 的自制实现(约 100 行),被 git 追踪。

**功能**:重定向(301/302/303/307/308)、JSON 自动解析、4xx/5xx 抛错带 response、超时(ETIMEDOUT)、.json() 方法、get/post。

**细节**:chunk 用 Buffer.concat(修复 UTF-8 跨 chunk 乱码);body 类型在 JSON 解析后变为对象。

**注意**:这是自制代码,有自身测试(通过 fetchData/通道测试间接覆盖)。

---

## 五、使用入口速查

```bash
# 运行推送(真实拉取+推送)
node xbk_function_v3.js

# 跑全部测试
node test_filter.js && node test_app.js && node test_notify.js

# 切换并行推送(主代码 Config.push.mode = 'parallel')
# 配置推送密钥(编辑 push_config.local.js,不入库)
# 清缓存(rm xianbaoku_cache/push.json,下次运行重建)
```

### `README.md` — 项目首页(快速上手)

**定位**:仓库最外层说明——项目简介、特性、快速开始(含密钥配置)、测试、cron 示例、配置速查、目录结构、安全红线。新人第一入口。

### `package.json` — 工程化入口(v3.71 新增)

**定位**:`npm start`(运行推送)/`npm test`(经 run_tests.js 一键三套件+汇总报告,退出码 0=全绿)/engines node>=14/零依赖声明。101 章版本一致性测试校验其 version 与文件头一致。

### `run_tests.js` — 统一测试入口(v3.107 新增)

**定位**:一键执行三套测试 + 汇总报告（✅/❌/耗时/退出码）——`npm test` 指向它。CI 与本地统一入口。

### `test_app_parallel.js` — test_app 并行调度器(v3.122 新增)

**定位**:test_app 70 个集成测试并行 fork（独立进程，无全局污染）——`node test_app_parallel.js`，46s → 11s（4 倍）。慢测真实等待、快测 QUICK 加速、run.log 测试独占串行。**并发可配**：`CONCURRENCY=32 node test_app_parallel.js`（真机加速，沙箱默认 8 稳定）。

### `.github/workflows/test.yml` — CI 配置(v3.107 新增)

**定位**:GitHub Actions——push/PR 自动跑三套测试（Node 16/18/20 矩阵），全部 PASS 才可合并。零依赖无需 npm install（自制 got 已入库）。

---

## 六、数据关系图

```
push_config.local.js ──加载──> xbk_sendNotify_slim.js <──依赖── xbk_function_v3.js
     (密钥,不入库)              (推送通道)                  (主代码)
                                                              │
        test_notify.js ──测──> xbk_sendNotify_slim.js        │ require
        test_app.js ────测──> xbk_function_v3.js <───────────┘
        test_filter.js ──测──> xbk_function_v3.js
                     (全部经 require.cache mock got/notify)
```
