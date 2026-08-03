# 📡 线报酷推送脚本（xbk-push）

定时拉取线报酷接口数据 → 规则过滤 → 多通道推送的 Node.js 脚本。零第三方依赖（自制精简 HTTP 模块），测试体系完备（详见下方「测试」章节）。

> 版本演进见 [CHANGELOG.md](CHANGELOG.md)；当前版本以 [package.json](package.json) 为准（版本一致性测试自动校验三方一致，不会过时）

---

## ✨ 特性

- **规则过滤**：分类/标题/内容/楼主三级屏蔽 + 强制展现 + 强化屏蔽（`###` 多行语法）
- **只看它**：关键词白名单过滤（zkt_gjc）
- **注册天数过滤**：楼主注册 < N 天不推（pingbitime）
- **推送通道**：Push+/Server酱/Bark/PushMe/企业微信/wxpusher/息知/PushDeer/Telegram
- **去重缓存**：推送成功才写缓存，失败下次自动重试；原子写入 + 路径防逃逸
- **可配置推送模板**：标题/内容模板自由组合占位符，截断长度可调
- **运行日志**：每次运行摘要 + 失败原因持久化到 `xianbaoku_cache/run.log`
- **健壮性**：ReDoS 防护、日志密钥脱敏、UTF-16 安全截断、故障注入测试、高行覆盖

---

## 🚀 快速开始

```bash
# 配置推送密钥（本地文件，不入库，已 gitignore）
cp push_config.local.js.example push_config.local.js
#    编辑填入你的通道 key（PUSH_KEY / BARK_PUSH / TG_BOT_TOKEN 等）

# 运行（真实拉取 + 推送）
node xbk_function_v3.js

# 或（有 npm 的环境）
npm start
```

## 🧪 测试

```bash
# 一键执行三套测试 + 汇总报告（推荐）
npm test            # 或 node run_tests.js

# 单套执行
node test_filter.js && node test_app.js && node test_notify.js
```

三套件分工：`test_filter.js`（单元测试，含 Fuzz 随机冒烟 + 性能基准）→ `test_app.js`（集成测试，mock 完整主流程）→ `test_notify.js`（通道测试）。测试数量不在此维护（以 `node run_tests.js` 实际输出为准）。**版本一致性自动校验文件头/CHANGELOG/package.json 三方一致**（test_filter 章节；README 不含版本号，无需同步）。

**CI**：`.github/workflows/test.yml`——push/PR 自动跑三套（Node 多版本矩阵），全部 PASS 才可合并。**Fuzz 章节**（固定 seed 随机脏数据多轮）曾抓到 `hasValidId` 崩溃 bug。

## ⏰ cron 定时（示例）

```cron
# 示例：按需设置运行间隔（注意路径用绝对路径，缓存目录基于脚本位置不受 cwd 影响）
*/N * * * * cd /path/to/xbk-push && node xbk_function_v3.js >> /var/log/xbk-push.log 2>&1
```

## 📝 运行日志

每次运行自动追加到 `xianbaoku_cache/run.log`（gitignore，不入库）：

```
<运行时间> total=N dedup=N filtered=N pushed=N failed=N elapsed=Ns
<运行时间> ERROR <原因>
```

- **成功行**：`total` 拉取总数 / `dedup` 去重跳过 / `filtered` 过滤屏蔽 / `pushed` 推送成功 / `failed` 失败数（下次运行重试）/ `elapsed` 运行耗时
- **失败行**：`ERROR <原因>`（cron 场景回溯失败趋势）
- 超过上限自动截断保留尾部（防无限增长）

## ⚙️ 配置

完整配置（含默认值）见 `xbk_function_v3.js` 顶部 Config——不在此重复维护（避免与代码不同步）。

**占位符**：`{分类名} {分类ID} {标题} {链接} {日期} {时间} {楼主} {类目} {价格} {商城} {品牌} {图片} {Html内容} {Markdown内容}`

## 📁 目录结构

```
xbk_function_v3.js        主代码（分层架构：Config→Utils→Formatter→RuleEngine→FilterEngine→MessageStore→Network→Pusher→App）
xbk_sendNotify_slim.js    推送模块（通道实现）
push_config.local.js      本地密钥（不入库！）
push_config.local.js.example  密钥配置示例模板（可入库）
xianbaoku_cache/          去重缓存 + run.log（不入库）
node_modules/got/         自制精简 HTTP 模块（唯一依赖，被 git 追踪）
test_filter.js            单元测试
test_app.js               集成测试
test_notify.js            通道测试
package.json              工程入口（npm start / npm test）
README.md                 本文件
FILE_INDEX.md             文件索引（最详细）
REVIEW_DECISIONS.md       审查决策记录（为什么修/为什么不修）
CHANGELOG.md              版本演进
```

## ⚠️ 安全红线（重要）

- `push_config.local.js` **绝不提交**（含真实密钥，已 gitignore）
- 涉及 `.git` 内部 / 删除 / 破坏性操作前**必须先备份**（cp/mv 副本）
- `.git/objects` 下文件**绝不凭文件名判断"临时"就删除**——先 `git cat-file` / `git fsck` 验证
