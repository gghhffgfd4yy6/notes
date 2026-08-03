# 🐛 真实 Bug 评估与修复记录（BUG_HUNT）

> 曾收录**未修复**的、真实触发、有实际影响（非边缘/罕见/理论/企业级）的 bug，每项经**真实验证**。
> **9 项已修复（v3.163，2026-08-03）**——下方每项标注状态、修复方式与验证结果。

---

## 1. `{Html内容}` 模板 + Markdown 通道 → HTML 源码裸露 ✅ 已修复（v3.159）

- **触发场景**：用户配置 `{Html内容}` 模板 + wxpusher / Server酱（Markdown 渲染通道）
- **真实验证**（2026-08-03，真实接口数据）：
  ```
  {Html内容} 输出: "京东APP 我的 优惠券--为你精选...<br>京东app搜索...<br><a href=\"https://u.jd.com/\"..."
  含 HTML 标签: ✅ 确认
  ```
- **风险**：推送内容显示 `<br>`、`<a href="...">` 等 **HTML 源码**，内容难读（wxpusher contentType=3 Markdown 不渲染 HTML）。当前用户唯一通道就是 wxpusher，若用 `{Html内容}` 模板必触发。
- **修复（v3.159）**：wxpusher 检测内容含 HTML 标签（白名单 br/a/img/p/div/strong/b/i/em/u/s/table/tr/td/th/ul/ol/li/h1-6/span/font/blockquote/code/pre/hr）→ 自动切 contentType=2（HTML 渲染）；白名单避免误判 Markdown `<url>` autolink。test_notify 新增 2 测试（含 HTML 切 2 / autolink 保持 3）。
- **验证**：真实 `{Html内容}` → 判 HTML ✓；真实 `{Markdown内容}` → 不误判 ✓

## 2. 过滤条件变更后旧条目不重新推送（需手动清缓存）✅ 已修复（v3.159）

- **触发场景**：用户**改宽过滤条件**（如原来屏蔽"京东"，改为不屏蔽）
- **真实验证**：被过滤的条目**已写入缓存**（设计：过滤=已处理）→ 改宽后这些条目被缓存判重跳过 → 不再推送
- **风险**：用户改配置后以为会收到新内容，实际旧条目不出现（需 `rm xianbaoku_cache/push.json`，README 有说明但用户易踩）
- **修复（v3.159）**：缓存记录 `_f` 过滤标记 + `filter.hash` 规则哈希比对——规则/只看它变更时清除「过滤写入」缓存条目（之前被过滤的重新评估，改宽即重推）；推送成功清除标记；「推送成功」缓存不受影响（防重复推送）。test_app t67 覆盖全链路。
- **验证**：屏蔽→改宽→旧条目重新推送 ✓；缓存 `_f` 无残留 ✓

## 3. 真实接口 `louzhuregtime` 缺失 → pingbitime 配置几乎不生效无提示 ✅ 已修复（v3.159）

- **触发场景**：用户配置 `pingbitime`（楼主注册天数过滤）
- **真实验证**（2026-08-03，真实接口）：
  ```
  真实数据 louzhuregtime 缺失: 20/20（接口基本不提供该字段）
  配 pingbitime=5 拦截: 0/20（几乎永不拦截）
  ```
- **风险**：用户配了天数过滤但**实际从不生效**（接口不提供该字段），且**无任何提示**——用户以为在过滤，实际没有
- **修复（v3.159）**：运行期统计 louzhuregtime 缺失率，配置 pingbitime 且缺失率 >50% 时 console.warn「接口可能不提供该字段，pingbitime 过滤基本不会生效」。test_app 覆盖。
- **验证**：真实缺失 20/20 >50% → 警告触发 ✓

## 4. 告警/日报 desp 全部单个 `\n`（wxpusher Markdown 未适配）✅ 已修复（v3.159）

- **触发场景**：接口异常（告警默认开启）或跨天（日报默认开启）+ wxpusher 通道
- **真实验证**（2026-08-03）：
  ```
  告警 desp: "接口/推送异常，请检查。\n时间：2026/8/3 03:02:41\n原因：ECONNREFUSED"（全单 \n）
  日报 desp: "推送 3 条 | 失败 0 条\n获取 5 | 去重 1 | 过滤 1"（全单 \n）
  ```
- **不一致**：Server酱已适配（单 `\n` 加倍）、Bark/Push+ 走 mdToPlain——**wxpusher 是 Markdown 原样**，单个 `\n` 渲染依赖实现（可能挤成一行），与主推送（`\n\n` 段落分隔）格式不一致
- **修复（v3.159）**：_sendAlert/_updateReport 的 desp 改 `\n\n` 段落分隔（与主推送同口径）。t56/t57 断言增强。
- **验证**：告警 desp 含 `\n\n时间：` ✓；日报 desp 含 `条\n\n获取` ✓

## 5. 模板占位符 `{价格}/{商城}/{品牌}/{图片}` 在真实接口恒空 ✅ 已修复（v3.159）

- **触发场景**：用户模板使用 `{价格}` `{商城}` `{品牌}` `{图片}` 占位符
- **真实验证**（2026-08-03，真实接口）：
  ```
  真实接口全部字段: cateid, catename, comments, content, content_html, datetime, id,
                     louzhu, louzhuregtime, shijianchuo, shorttime, title, url  (13个)
  字段 price: 0/20 | mall_name: 0/20 | brand: 0/20 | pic: 0/20（接口无此字段）
  {价格}/{商城} 模板输出: "价格: 商城:"（恒空）
  ```
- **风险**：用户配了模板但占位符永远为空（推送显示"价格: 商城:"），无任何提示——配置无效不感知
- **修复（v3.159）**：启动检查模板（title/content）含不支持的占位符 → 警告（支持列表 11 个：分类名/分类ID/标题/链接/日期/时间/楼主/类目/内容/Html内容/Markdown内容）。test_app 覆盖。
- **验证**：`{价格}` 模板 → 启动警告 ✓ 推送正常（占位符替换为空）✓

## 6. 7 个推送通道 API 业务失败被当成功 → 消息永久丢失 ✅ 已修复（v3.160）

- **触发场景**：任一通道 API 返回**业务失败码**（HTTP 200 + code≠成功）——key 失效/被限流/参数错误（配置常见错误）
- **真实验证**（2026-08-03，mock 各通道业务失败响应）：
  ```
  修复前：Push+/Server酱/Bark/企微/息知/PushDeer/PushMe/TG 全部「静默成功」（sendNotify 不抛错）
         仅 wxpusher 正确 reject（v3.154 已修同 class 问题）
  端到端：单息知通道 + key 无效(code=500) → 修复前 pushed:1、消息写入缓存；
         修复后 pushed:0、failed:1、缓存不写（下次运行重试，消息不丢）
  ```
- **风险**：单通道用户 → 主流程写缓存 → 下次去重跳过 → **消息永久丢失且无感知**（run.log 显示 pushed=N、无告警、无失败日志）；
  多通道用户更隐蔽——息知「假成功」掩盖 wxpusher「真失败」（allSettled 判定至少一个成功 → 写缓存）
- **修复（v3.160）**：8 通道 API 级失败统一 reject（与 wxpusher v3.154 同口径）；Server酱 errno=1024（一分钟内重复内容=已送达）保持视为成功；
  日志脱敏不受影响（reject 消息取 data.msg/description，不打印完整响应）
- **验证**：8 通道业务失败 8/8 抛错 ✓（verify_api_fail.js）；端到端息知失败缓存不写 ✓；test_notify 39/39（mock 按 URL 返回业务成功码 + 新增 2 测试锁定）

## 7. `pingbitime` 变更不失效「过滤写入」缓存 → 放宽后旧条目不重推 ✅ 已修复（v3.161）

- **触发场景**：用户**调整 `pingbitime`**（注册天数过滤，默认开启 `'5'`）——如从 30 放宽到 5，之前被 `pingbitime` 过滤的条目应重新评估推送
- **根因**：`Utils.filterHash` 只哈希 `FILTER_FIELDS`（10 个字段）+ `zkt_gjc`，**漏了 `pingbitime`**（`FILTER_FIELDS` 第 97 行无 pingbitime，filterHash 第 264 行遍历它）→ `filter.hash` 不变 → 「过滤写入」缓存（`_f` 标记）不失效 → 被 `pingbitime` 过滤的条目改宽后**永远不重新评估**
- **真实验证**（2026-08-03，mock got 完整 App.run 两轮）：
  ```
  运行1: pingbitime=30 → 注册5天的条目被过滤 → 缓存写 _f 标记(1条)
  运行2: pingbitime=3（放宽，应推送）→ filter.hash 变化: 否
         → 条目被缓存判重跳过（pushed=0, dedup=1）→ 不重推 ❌
  ```
- **风险**：v3.159 修复 #2（过滤条件变更 → 失效「过滤写入」缓存）时只覆盖 10 个 FILTER_FIELDS + zkt_gjc，**漏了 pingbitime 这一路过滤**（`checkRegisterTime` 也是 `listfilter` 的过滤维度，被它拦的同样写 `_f`）——用户改宽 pingbitime 后旧条目不出现，需手动 `rm xianbaoku_cache/push.json`（与 #2 同 class 的疏漏）
- **修复（v3.161）**：`filterHash` 补入 `pingbitime`（哈希原始字符串，含多行 `###` 形式）；test_app t68 锁定（pingbitime 变更 → 清除 _f → 放宽重推）
- **验证**：修复后两轮运行 `filter.hash` 变化 + `pushed=1`（放宽重推）✓；变异（去掉 pingbitime）→ t68 红 ✓

## 8. `api.timeout` 字符串配置不生效（v3.158 遗漏的第 8 处）→ 超时回退 15s + 警告误导 ✅ 已修复（v3.162）

- **触发场景**：用户通过环境变量/配置文件把 `Config.api.timeout` 配为**字符串**（如 `'5000'`）——v3.158 自己确认的真实场景（「环境变量/配置文件传值全是字符串」）
- **根因**：v3.158 用 `Utils.num` 统一转换了 7 处数值配置（retry/parallelLimit/maxPerRun/titleMax/contentMax/pushInterval/finalWait），**漏了 `api.timeout`**——`fetchData`（第 1264 行）原样传 `Config.api.timeout` 给 got，而 got（`node_modules/got/index.js` 第 23 行）对非数字 `Number.isFinite('5000')=false` → **回退 15000ms**
- **真实验证**（2026-08-03）：
  ```
  Config.api.timeout = '5000'（字符串）→ got 实际使用 15000ms（预期 5000ms）
  且 App.run 第 1449 行校验警告「已按内部防御逻辑处理」→ 误导（实际是忽略+回退 15s，不是处理为 5000）
  对比 v3.158 修过的 retry: Utils.num('2',2) = 2（生效）
  ```
- **风险**：用户配置 5s 超时实际 15s → 接口慢/挂时单次运行等待 3×15s=45s（vs 预期 15s）→ cron 5 分钟间隔可能被单次运行打满 → 调度重叠；配置不生效且警告文案误导（「已处理」实为「忽略」）
- **修复（v3.162）**：`fetchData` 里 `timeout: Utils.num(Config.api.timeout, 5000)`（与 retry 同款转换）；test_app t69 锁定；变异验证
- **验证**：`'5000'`→5000 ✓、`'abc'`→5000 回退 ✓、数字 3000→3000 ✓；变异（去掉转换）→ t69 红 ✓

## 9. 推送通道持续失败（key 失效）→ 无告警 + exit 0 → 用户无感知 ✅ 已修复（v3.163）

- **触发场景**：推送通道持续失败（wxpusher key 失效 / 被限流 / 通道 API 挂）——**v3.123 注释声称「接口挂/密钥失效时主动通知本人（防'跑了但没推没人知道'）」，但密钥失效路径未实现**
- **根因**：`_sendAlert` 只在 `App.run` 的 catch（**fetchData 失败**）路径调用；**推送失败**（`pushOne` 内部 catch → `return {ok:false}` → 不抛错）→ 主流程正常返回 → 无告警、`process.exit(0)`（cron 认为成功）
- **真实验证**（2026-08-03，mock got：fetchData 成功 + wxpusher 返回 code=1300）：
  ```
  运行摘要: {total:1, pushed:0, failed:1}
  alert.state 文件: 不存在（_sendAlert 未触发）
  run.log: "total=1 ... pushed=0 failed=1 elapsed=0.1s"（普通成功行，非 ERROR 行）
  主流程正常返回 → exit 0
  ```
- **风险**：推送脚本核心功能（推送）全部失败但**用户完全无感知**——无告警推送、run.log 无 ERROR 行、exit 0（cron 不告警）。v3.160 修复了「key 失效静默成功→消息丢失」（#6），但「失败无感知」残留：每天 ~288 次运行全部 failed 也无人知晓，除非用户主动翻 run.log
- **对比**：v3.15/v3.16 哲学「catch 吞错 → cron 认为成功（exit 0）→ 静默失败；重抛 + 非 0 退出让调度感知」——**推送失败路径吞错未遵守**；v3.123 声称覆盖「密钥失效」告警但只实现了「接口挂」
- **修复（v3.163）**：a) 推送全部失败（items>0 && successCount===0）→ `_sendAlert`（限频复用 alert.state）；b) run.log 追加 ERROR 行；c) 连续失败阈值（防瞬时抖动）暂未做（限频已防轰炸）
- **验证**：推送全失败 → _sendAlert 触发 + run.log ERROR 行 ✓；变异（去掉）→ t70 红 ✓（注：告警通道与推送同一通道，通道挂时告警也发不出——v3.135 静默处理，无解）

---

## 附：验证方法（可复现）

```bash
# 候选1：{Html内容} 模板输出
node -e "require('./xbk_function_v3.js').fetchData().then(d => console.log(require('./xbk_function_v3.js').tuisong_replace('{Html内容}', d[0]).slice(0,100)))"
# 候选3：pingbitime 有效性
node -e "const x=require('./xbk_function_v3.js');x.fetchData().then(d=>{const c=x.compileRules({pingbitime:'5'});console.log('拦截',d.filter(i=>!x.listfilter(i,c)).length,'/',d.length)})"
```

---

## 状态说明
- 九个候选均**真实验证触发**、风险明确、收益中-高、修复难度低-中
- **v3.162 已修复 8 项**（2026-08-03），修复顺序：1（wxpusher 当前唯一通道，易触发）→ 2（配置变更体验，缓存语义）→ 3（配置无效无提示）→ 4（格式统一）→ 5（模板配置提示）→ 6（7 通道 API 业务失败静默 → 消息丢失）→ 7（filterHash 漏 pingbitime，改宽不重推）→ 8（v3.158 漏 timeout 字符串转换）
- **#9 已修复**（v3.163）：推送通道失败无告警 + exit 0（v3.123 声称的「密钥失效告警」未实现）→ 补告警 + run.log ERROR
- 测试：test_app +5（t67 过滤变更/pingbitime 警告/占位符警告 + t68 pingbitime 变更重推 + t69 timeout 字符串）、test_notify +4（wxpusher HTML/autolink + v3.160 息知失败/全通道失败）——**770 全绿**

## 4b. 真实验证补充（非 bug，记录排除）

- 真实数据 20 条：7 条含 emoji（desp 无孤立代理 ✓）、无全角/实体残留、无 4+ 连续换行、无 HTML 残留——内容质量正常
- 真实标题最长 35 字符（summary 90 截断不触发，safeSlice 保护已就位）
- 多行过滤规则（`分类###正则`）真实数据逻辑正确（cat 匹配分类）

## 5b. 真实验证补充（非 bug，排除）

- **推送失败重试完整验证**（wxpusher 限流 → 不写缓存 → 恢复后重试成功，消息不丢）✓
- **真实告警推送**（接口失败 → 告警真实送达 wxpusher + 状态正确，v3.156/157 生效）✓
- 告警 errMsg 内容安全（无密钥/敏感信息，单行）✓
- 真实内容质量（emoji 完整/无孤立代理/无 HTML 残留/无 4+ 连续换行）✓
- 多行过滤规则真实逻辑正确 ✓
