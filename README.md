# 📡 线报酷推送脚本（xbk-push）

> **定时拉取线报酷接口数据 → 规则过滤 → 多通道推送** 的 Node.js 脚本。
> 使用官方 got HTTP 客户端、单文件主程序、完整测试体系与系统契约文档——**个人使用、青龙单实例场景**的成熟方案。

- 版本演进见 [CHANGELOG.md](CHANGELOG.md)；版本一致性由文件头、`CHANGELOG.md` 和 `package.json` 的自动测试校验（README 不维护版本号）
- 设计理念 / 系统不变量 / 各模块契约 / 设计边界见 **[SYSTEM_CONTRACT.md](SYSTEM_CONTRACT.md)**（改代码前必读）
- 文件级索引见 [FILE_INDEX.md](FILE_INDEX.md)；修/不修决策记录见 [REVIEW_DECISIONS.md](REVIEW_DECISIONS.md)

---

## ✨ 特性

**数据获取与解析**
- 自动拉取 + 失败重试（4xx 不重试 / 429 限流重试 / 指数退避 + 随机抖动）
- HTML 转 Markdown（表格/列表/粗斜体/图片/链接安全化）、HTML 实体解码（含双重转义）、代理对安全截断

**规则过滤**
- 分类/标题/内容/楼主**三级屏蔽 + 强制展现 + 强化屏蔽**（`###` 多行语法，分类限定）
- **只看它**：关键词白名单过滤（zkt_gjc）；**注册天数过滤**：楼主注册 < N 天不推（pingbitime）
- 规则预编译一次 + ReDoS 防护（嵌套量词/歧义交替检测，防正则卡死）

**去重缓存（判重契约）**
- 推送**成功才写缓存**，失败下次自动重试（防丢失）；被过滤/只看它滤掉的标记 `_f`，**规则变更自动失效重评**（无需手动清缓存）
- 判重口径统一（id 权威 + url 双向 fallback + 匿名合成 id），批内与跨运行完全一致
- 海量数据判重索引化 O(N+M)（接口异常返回 10 万条不卡死）；原子写入 + 路径防逃逸 + 缓存上限滚动淘汰

**多通道推送**
- Push+ / Server酱（Turbo 兼容）/ Bark（多设备）/ PushMe / 企业微信 / wxpusher / 息知 / PushDeer / Telegram
- 顺序逐条 / 并行滑动窗口（限并发）双模式；标题/内容模板可配置；截断长度可调
- 无通道配置拒绝静默成功；多通道部分成功即成功（失败的通道不重试防轰炸）；API 级失败可感知

**运行保障**
- 接口异常告警（限频 + 静默）；跨天运行日报（本地日期 + 失败重试 + 今日数据暂存不丢失）
- 缓存所在磁盘余量监测（低于阈值告警，不阻断推送；平台不支持时自动跳过）
- 运行日志 `run.log`（成功摘要 / ERROR 行，1MB 自动截断）；日志密钥脱敏
- 用户特定配置外置（`push_config.local.js` 含真实密钥，绝不入库）

---

## 🚀 快速开始

```bash
# ① 安装官方 HTTP 客户端依赖
npm install --ignore-scripts

# ② 配置推送密钥（本地文件，不入库，已 gitignore）
cp push_config.local.js.example push_config.local.js
#    编辑填入你的通道 key（PUSH_KEY / BARK_PUSH / TG_BOT_TOKEN 等）

# ③ 运行（真实拉取 + 推送）
npm start                      # 运行推送脚本

# ④ 可选：修改过滤规则等配置（xbk_function_v3.js 顶部 Config）
```

## 🐉 青龙面板部署

项目提供独立入口 `qinglong/xbk_push.js`，会自动定位项目根目录，因此青龙任务不依赖当前工作目录。

### 推荐方式：环境变量配置密钥

在青龙面板的环境变量中配置推送密钥，例如 WxPusher：

```text
WX_PUSHER_APP_TOKEN=你的 appToken
WX_PUSHER_TOPIC_IDS=主题ID（多个用逗号分隔）
```

需要两个 WxPusher 应用自动分流时，在未入库的 `push_config.local.js` 中配置：

```js
WX_pusher_channels: [
    { appToken: '应用1 appToken', topicIds: '主题ID1' },
    { appToken: '应用2 appToken', topicIds: '主题ID2' },
]
```

每条消息只发送到一个应用，按轮询分流；每个应用独立维护发送窗口，收到明确限频响应时才切换另一个应用重试。两个主题应由同一批接收者订阅。环境变量方式仍适用于单应用配置。

也支持 `PUSH_PLUS_TOKEN`、`PUSH_KEY`、`BARK_PUSH`、`QYWX_KEY`、`WX_XIZHI_KEY`、`DEER_KEY`、`PUSHME_KEY`、`TG_BOT_TOKEN`、`TG_USER_ID` 等变量。环境变量优先于 `push_config.local.js`。

### 青龙任务命令

仓库拉取到青龙脚本目录后，任务命令使用：

```bash
node qinglong/xbk_push.js
```

该入口会在依赖缺失时自动执行不带生命周期脚本的生产依赖安装；依赖已经存在时不会每轮重复安装。缓存、运行日志和状态文件仍写入项目根目录下的 `xianbaoku_cache/`，不会受青龙任务当前工作目录影响。

该入口现在是**常驻模式**：进程启动时加载一次主程序、got、Agent、DNS 缓存和连接池；每轮完成后等待配置间隔，再重新拉取接口。每完成一组轮询后，会在等待期间后台刷新线报接口和 WxPusher 的 DNS，并预热少量 TLS 连接；刷新任务有独立超时和停止信号边界，不会无限阻塞下一轮或安全停止。单轮失败会按错误类型处理：网络抖动、超时、限流和服务端暂时故障有限重试；明确的配置、权限、参数、地址或响应格式错误立即停止并返回非零退出状态；推送全部失败时也会进入同一分类流程。部分通道成功仍按成功处理，成功一轮会清零连续失败状态。DNS/TLS 性能预热失败只记录，不触发业务熔断。收到青龙停止信号（SIGTERM/SIGINT）时，会在当前轮完成后安全停止，不强杀正在进行的推送。

默认间隔可通过环境变量覆盖：

```bash
XBK_INTERVAL_MS=你的间隔毫秒数 node qinglong/xbk_push.js
```

如果只需要执行一次，仍使用：

```bash
npm start
```

常驻模式应在青龙中只运行一个实例，避免多个进程同时推送同一批数据。

## 🧪 测试与系统验证

```bash
# 一键执行三套测试 + 汇总报告（推荐）
npm test            # 全量测试（推荐）

# 单套执行
npm run test:filter
npm run test:app
npm run test:notify
```

- **三套件分工**：`test_filter.js`（单元/属性/Fuzz/性能基准/版本一致性）→ `test_app.js`（集成测试 worker，mock 完整主流程）→ `test_notify.js`（通道请求构造 + 密钥脱敏）；推荐入口 `npm run test:app` 由 `test_app_p.js` 并行调度，需串行完整验证时使用 `npm run test:app:serial`
- **测试数量不在此维护**（以 `npm test` 实际输出为准）；版本一致性由文件头、CHANGELOG 和 package.json 自动校验（README 不含版本号）
- **系统验证**：判重等价性/缓存不变量经**固定种子属性测试**（双路径逐条比对 + 已知答案锚点，零失配）；连续运行稳定性验收；故障注入 / 变异测试 / ReDoS 全入口防护均有测试锁定
- **CI**：`.github/workflows/test.yml` 在 push/PR 时执行三套测试；`.workflow/master-pipeline.yml` 提供分阶段的单元、并行集成、通道测试和汇总步骤。
- **静态安全扫描**（工作区本地工具，不入库）：osv-scanner（依赖漏洞）/ Semgrep（静态安全）/ ESLint（严格规则）/ Knip（死代码）可一键最严格运行，工具位置、命令要点与结果判定见 FILE_INDEX 的 `.tools/code-audit/` 条目

## ⏰ cron 定时（示例）

```cron
# 示例：按需设置运行间隔（注意路径用绝对路径，缓存目录基于脚本位置不受 cwd 影响）
*/N * * * * cd /path/to/xbk-push && npm start >> /var/log/xbk-push.log 2>&1
```

## 📝 运行日志与告警/日报

每次运行自动追加到 `xianbaoku_cache/run.log`（gitignore，不入库）：

```
<本地时间> total=N dedup=N filtered=N pushed=N failed=N elapsed=Ns
<本地时间> ERROR <原因>
```

- **成功行**：`total` 拉取总数 / `dedup` 去重跳过 / `filtered` 过滤屏蔽 / `pushed` 推送成功 / `failed` 失败数（下次运行重试）/ `elapsed` 运行耗时
- **失败行**：`ERROR <原因>`（cron 场景回溯失败趋势）；超过上限自动截断保留尾部
- **告警**（Config.alert，默认开）：接口挂/密钥失效/推送全失败时主动推送通知本人，同错误 1 小时限频；状态写入失败时本进程继续内存限频
- **运行日报**（Config.report，默认开）：每天一条昨日汇总推送，跨天自动发送、失败次日重试；状态写入失败时本进程保留日报状态

## ⚙️ 配置

完整配置（含默认值）见 `xbk_function_v3.js` 顶部 Config——不在此重复维护（避免与代码不同步）。所有数值配置支持环境变量字符串（`'5000'` 自动识别）。

**推送模板占位符**：`{分类名} {分类ID} {标题} {链接} {日期} {时间} {楼主} {类目} {价格} {商城} {品牌} {图片} {Html内容} {Markdown内容}`

**常用配置示例**：

```js
// xbk_function_v3.js 顶部 Config
filter: {
    pingbifenlei: '美妆',        // 屏蔽分类（正则）
    pingbibiaoti: '京东|拼多多',  // 屏蔽标题
    pingbilouzhu: '广告号',      // 屏蔽楼主
    pingbitime: '5',            // 楼主注册 < 5 天不推
    // 多行规则：'分类###值正则<br/>分类2###值2'
},
push: {
    mode: 'parallel',           // 或 'sequential'（当前默认并行）
    maxPerRun: 100,             // 单次推送上限（防推送风暴）
    titleMax: 100, contentMax: 3000,
},
```

## 🧬 变异测试（StrykerJS）

项目提供 `stryker.config.js` 和 `npm run test:mutation` 入口。StrykerJS 作为独立开发工具使用，不参与默认 `npm test`，避免把变异测试的长耗时带入普通回归。

准备好 StrykerJS 后执行：

```bash
STRYKER_CONCURRENCY=2 npm run test:mutation
```

该入口使用 `node test_filter.js` 作为自定义测试命令；Stryker 会在临时目录中生成和执行变异，不直接修改当前工作区源码。`STRYKER_CONCURRENCY` 可按设备资源调整。


```
xbk_function_v3.js        主代码（分层架构：Config→Utils→Formatter→RuleEngine→FilterEngine→MessageStore→Network→Pusher→App）
xbk_sendNotify_slim.js    推送模块（多通道实现 + 密钥脱敏）
push_config.local.js      本地密钥（不入库！）
push_config.local.js.example  密钥配置示例模板（可入库）
xianbaoku_cache/          去重缓存 + run.log + 状态文件（不入库）
node_modules/got/         官方 got HTTP 客户端（版本由 package.json 管理）
xbk_http.js              官方 got 薄封装（JSON 解析 + 响应体大小上限）
xbk_storage.js           统一安全文件读取与原子写入基础设施
stryker.config.js        StrykerJS 变异测试配置（自定义 test_filter 入口）
test_filter.js            单元测试（属性/Fuzz/性能基准/版本一致性）
test_app.js               集成测试 worker（mock 完整主流程）
test_app_p.js               集成测试并行调度器
test_notify.js            通道测试
run_tests.js              一键全量测试入口
qinglong/xbk_push.js      青龙面板直接执行入口（自动定位根目录/补齐依赖）
package.json              工程入口（npm start / npm test）
README.md                 本文件（展示页）
SYSTEM_CONTRACT.md        系统契约（设计理念/不变量/契约/设计边界）
FILE_INDEX.md             文件索引（最详细）
REVIEW_DECISIONS.md       审查决策记录（为什么修/为什么不修）
BUG_AUDIT.md              Bug、P1/P2 审计与验证记录
CHANGELOG.md              版本演进
PR_AGENT_GUIDE.md         Qodo Merge（PR-Agent）终端 AI 审查使用指南（不入库的审查工具链文档）
```

## 📚 文档导航（新人看这里）

| 文档 | 用途 |
|---|---|
| **README.md** | 快速上手（本页） |
| **SYSTEM_CONTRACT.md** | 想改代码 / 想理解设计 → 先读：设计哲学、系统不变量 I1-I9、判重/缓存/推送契约、设计边界（不修项） |
| **FILE_INDEX.md** | 想找某个函数/配置/测试在哪个文件哪一行 |
| **REVIEW_DECISIONS.md** | 想知道某个问题为什么修/为什么不修 |
| **BUG_AUDIT.md** | 想查看 Bug、P1/P2 审计和验证记录 |
| **CHANGELOG.md** | 版本演进史 |
| **PR_AGENT_GUIDE.md** | 终端 AI 代码审查工具（Qodo Merge / PR-Agent）安装、配置与使用指南 |

## ⚠️ 安全红线（重要）

- `push_config.local.js` **绝不提交**（含真实密钥，已 gitignore）
- 涉及 `.git` 内部 / 删除 / 破坏性操作前**必须先备份**（cp/mv 副本）
- `.git/objects` 下文件**绝不凭文件名判断"临时"就删除**——先 `git cat-file` / `git fsck` 验证
- 本脚本**设计为单实例运行**（青龙单实例）：多实例并发不保证"最多推送一次"（见 SYSTEM_CONTRACT §10）

**性能诊断**：`XBK_PROFILE=1` 输出接口/推送/总计；`XBK_PROFILE=2` 输出 DNS 预热、TLS 预取、预处理、缓存写入、收尾等待和每个 WxPusher 请求的 wait/dns/tcp/tls/request/firstByte/download 分阶段耗时；`XBK_PROFILE=3` 在此基础上增加启动模块加载、配置校验、规则编译、接口拉取、数据处理、推送、缓存写入和预热收尾等生命周期检查点，并输出线报接口的响应/首数据/下载/解析阶段信息（均不改变默认运行行为）。`XBK_DNS_FAMILY=4/6` 可强制对比 IPv4/IPv6 路径，默认自动。启动时并行预热 WxPusher DNS，并在后台用 HEAD 请求预建与并发窗口对齐的 HTTPS 连接（默认 10 个，不阻塞推送），推送时直接复用，减少冷启动 DNS/TLS 等待。
