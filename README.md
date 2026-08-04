# 📡 线报酷推送脚本（xbk-push）

> **定时拉取线报酷接口数据 → 规则过滤 → 多通道推送** 的 Node.js 脚本。
> 零第三方依赖（自制精简 HTTP 模块）、单文件主程序、完整测试体系与系统契约文档——**个人使用、青龙单实例场景**的成熟方案。

- 版本演进见 [CHANGELOG.md](CHANGELOG.md)；当前版本以 [package.json](package.json) 为准（版本一致性测试自动校验三方一致，不会过时）
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

**多通道推送（9 通道）**
- Push+ / Server酱（Turbo 兼容）/ Bark（多设备）/ PushMe / 企业微信 / wxpusher / 息知 / PushDeer / Telegram
- 顺序逐条 / 并行批量（限并发）双模式；标题/内容模板可配置（14 种占位符）；截断长度可调
- 无通道配置拒绝静默成功；多通道部分成功即成功（失败的通道不重试防轰炸）；API 级失败可感知

**运行保障**
- 接口异常告警（限频 + 静默）；跨天运行日报（本地日期 + 失败重试 + 今日数据暂存不丢失）
- 运行日志 `run.log`（成功摘要 / ERROR 行，1MB 自动截断）；日志密钥脱敏
- 用户特定配置外置（`push_config.local.js` 含真实密钥，绝不入库）

---

## 🚀 快速开始

```bash
# ① 配置推送密钥（本地文件，不入库，已 gitignore）
cp push_config.local.js.example push_config.local.js
#    编辑填入你的通道 key（PUSH_KEY / BARK_PUSH / TG_BOT_TOKEN 等）

# ② 运行（真实拉取 + 推送）
node xbk_function_v3.js        # 或 npm start

# ③ 可选：修改过滤规则等配置（xbk_function_v3.js 顶部 Config）
```

## 🧪 测试与系统验证

```bash
# 一键执行三套测试 + 汇总报告（推荐）
npm test            # 或 node run_tests.js

# 单套执行
node test_filter.js && node test_app_parallel.js && node test_notify.js
```

- **三套件分工**：`test_filter.js`（单元/属性/Fuzz/性能基准/版本一致性）→ `test_app.js`（集成，mock 完整主流程，经并行调度器）→ `test_notify.js`（通道请求构造 + 密钥脱敏）
- **测试数量不在此维护**（以 `node run_tests.js` 实际输出为准）；版本一致性三方自动校验（README 不含版本号）
- **系统验证**：判重等价性/缓存不变量经**固定种子属性测试**（双路径逐条比对 + 已知答案锚点，零失配）；1000 轮连续运行稳定性验收；故障注入 / 变异测试 / ReDoS 全入口防护均有测试锁定
- **CI**：`.github/workflows/test.yml`——push/PR 自动跑三套，全部 PASS 才可合并；Gitee Go 流水线分步骤标红失败环节

## ⏰ cron 定时（示例）

```cron
# 示例：按需设置运行间隔（注意路径用绝对路径，缓存目录基于脚本位置不受 cwd 影响）
*/N * * * * cd /path/to/xbk-push && node xbk_function_v3.js >> /var/log/xbk-push.log 2>&1
```

## 📝 运行日志与告警/日报

每次运行自动追加到 `xianbaoku_cache/run.log`（gitignore，不入库）：

```
<本地时间> total=N dedup=N filtered=N pushed=N failed=N elapsed=Ns
<本地时间> ERROR <原因>
```

- **成功行**：`total` 拉取总数 / `dedup` 去重跳过 / `filtered` 过滤屏蔽 / `pushed` 推送成功 / `failed` 失败数（下次运行重试）/ `elapsed` 运行耗时
- **失败行**：`ERROR <原因>`（cron 场景回溯失败趋势）；超过上限自动截断保留尾部
- **告警**（Config.alert，默认开）：接口挂/密钥失效/推送全失败时主动推送通知本人，同错误 1 小时限频
- **运行日报**（Config.report，默认开）：每天一条昨日汇总推送，跨天自动发送、失败次日重试

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
    mode: 'parallel',           // 或 'sequential'（默认）
    maxPerRun: 100,             // 单次推送上限（防推送风暴）
    titleMax: 100, contentMax: 3000,
},
```

## 📁 目录结构

```
xbk_function_v3.js        主代码（分层架构：Config→Utils→Formatter→RuleEngine→FilterEngine→MessageStore→Network→Pusher→App）
xbk_sendNotify_slim.js    推送模块（9 通道实现 + 密钥脱敏）
push_config.local.js      本地密钥（不入库！）
push_config.local.js.example  密钥配置示例模板（可入库）
xianbaoku_cache/          去重缓存 + run.log + 状态文件（不入库）
node_modules/got/         自制精简 HTTP 模块（唯一依赖，被 git 追踪）
test_filter.js            单元测试（属性/Fuzz/性能基准/版本一致性）
test_app.js               集成测试（mock 完整主流程）
test_app_parallel.js      集成测试并行调度器
test_notify.js            通道测试
run_tests.js              一键全量测试入口
package.json              工程入口（npm start / npm test）
README.md                 本文件（展示页）
SYSTEM_CONTRACT.md        系统契约（设计理念/不变量/契约/设计边界）
FILE_INDEX.md             文件索引（最详细）
REVIEW_DECISIONS.md       审查决策记录（为什么修/为什么不修）
CHANGELOG.md              版本演进
```

## 📚 文档导航（新人看这里）

| 文档 | 用途 |
|---|---|
| **README.md** | 快速上手（本页） |
| **SYSTEM_CONTRACT.md** | 想改代码 / 想理解设计 → 先读：设计哲学、系统不变量 I1-I9、判重/缓存/推送契约、设计边界（不修项） |
| **FILE_INDEX.md** | 想找某个函数/配置/测试在哪个文件哪一行 |
| **REVIEW_DECISIONS.md** | 想知道某个问题为什么修/为什么不修 |
| **CHANGELOG.md** | 版本演进史 |

## ⚠️ 安全红线（重要）

- `push_config.local.js` **绝不提交**（含真实密钥，已 gitignore）
- 涉及 `.git` 内部 / 删除 / 破坏性操作前**必须先备份**（cp/mv 副本）
- `.git/objects` 下文件**绝不凭文件名判断"临时"就删除**——先 `git cat-file` / `git fsck` 验证
- 本脚本**设计为单实例运行**（青龙单实例）：多实例并发不保证"最多推送一次"（见 SYSTEM_CONTRACT §10）
