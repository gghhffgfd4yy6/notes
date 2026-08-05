# 🐛 真实 Bug 评估与修复记录（BUG_HUNT）

> 曾收录**未修复**的、真实触发、有实际影响（非边缘/罕见/理论/企业级）的 bug，每项经**真实验证**。
> 本文记录已真实验证的 Bug；当前已记录的问题均已修复，最新修复基线见 `package.json` / `CHANGELOG.md`。下方每项标注状态、修复方式与验证结果。

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

## 6. 8 个推送通道 API 业务失败被当成功 → 消息永久丢失 ✅ 已修复（v3.160）

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

## 10. 接口异常告警被 `process.exit(1)` 杀死 → cron 直接运行场景收不到告警 ✅ 已修复（v3.164）

- **触发场景**：接口异常（fetchData 失败）+ **直接运行**（`node xbk_function_v3.js`，cron 场景）——**正是 v3.123 告警功能的核心里程碑场景**
- **根因**：`_sendAlert` 是 fire-and-forget（`.then().catch()` 不 await，只发起 HTTP 请求）→ `App.run` catch 里 `throw error` → 主入口 `App.run().catch(e => { console.error(...); process.exit(1); })` **同步立即退出** → 未完成的告警 HTTP 请求被 `process.exit` 终止 → **告警丢失**
- **真实验证**（2026-08-03，mock got：fetchData 404 立即失败 + 延迟 50ms 的 post 模拟真实网络）：
  ```
  run reject（模拟 process.exit 时刻）: 告警已发起=1, 已完成=false
  500ms 后（若无 exit）: 告警完成=true
  → 真实网络往返 >0ms，process.exit 在发起后几微秒内同步执行 → 告警必然未完成 → 丢失
  ```
- **风险**：接口挂时（v3.123 告警的核心场景）用户**收不到告警**（只能靠 run.log ERROR 行感知，cron 用户不常翻）——告警功能在主要场景下实际失效
- **对照**：测试/被 require 场景（无 `process.exit`）→ 告警能发（v3.156/157 验证的是这种）→ **直接运行（cron 真实场景）与测试行为不一致**；推送失败告警（v3.163）不受影响（正常路径无 exit）
- **修复（v3.164）**：`_sendAlert` 返回 promise（Pusher.send 链），`App.run` catch `await this._sendAlert(errMsg)` 后再 throw（exit 前告警送达）；test_app t71 锁定（sendNotify 延迟 50ms 模拟网络）+ 变异验证
- **验证**：`run` reject 返回耗时 149ms（等告警完成）；变异（去掉 await）→ t71 红 ✓

## 11. 自制 got：响应中断永久挂起 + 慢流超时形同虚设（挂起问题）✅ 已修复（v3.165）

- **触发场景**：A) 接口响应传输中断（服务器写部分响应后断开连接——网络抖动/代理断连/服务器异常）；B) 服务器慢流响应（每 2s 发 1 字节，间隔 < timeout）
- **根因**：`node_modules/got/index.js` 的 `request()` 只监听 `res` 的 `'data'/'end'`——**未监听 `'aborted'/'error'`** → 响应中断时 `'end'` 不触发、promise 永不 settle（永久挂起）；且 `req.on('timeout')` 是 Node **空闲超时**语义——慢流（间隔 < timeout）时 socket 不空闲、timeout 事件永不触发（总时长超时形同虚设）
- **真实验证**（2026-08-03，本地 HTTP server）：
  ```
  A) 服务器 200 + 写部分响应 + 20ms 后 res.destroy() → got(timeout=3000) 40s 无 resolve/reject（永久挂起）
  B) 服务器每 2s 发 1 字节（timeout=3000）→ 3.5s 未 settle，实际 8051ms 才完成（timeout 未生效）
  ```
- **风险**：A) `fetchData` 挂起（无兜底）→ 主流程永久卡死 → cron 无限挂起/重叠 → 推送停滞（**影响所有通道**——got 是所有请求的基础）；B) 慢接口 → 单次运行时间不可控 → cron 5 分钟可能被单次运行打满（推送通道有 Pusher.send 10s 超时兜底，fetchData 无）
- **修复（v3.165）**：a) `res` 补监听 `'aborted'/'error'` → 响应中断快速 reject（不挂起）；b) 总时长超时 `timeout×3`（覆盖连接+响应全程，非空闲超时）；各完成路径 clearTimeout（防泄漏）
- **验证**：响应中断 37ms reject ✓（曾 40s 挂起）；慢流（间隔100ms<timeout200ms）732ms 总时长超时 reject ✓（曾无限拖）；变异（总时长 ×3→×30）→ 慢流测试红 ✓；aborted/error 双监听互兜底（单监听变异=等价）✓；test_filter 97 章 +2

## 12. Bark/PushMe 多设备「单设备失效=整体失败」→ 有效设备重复轰炸 ✅ 已修复（v3.166）

- **触发场景**：Bark 多设备（`BARK_PUSH` 用 `#` 分割多个设备码）或 PushMe 多 key（`#` 分割）——**任一设备失效**（key 错误/设备删除/API 返回 code≠200）
- **根因**：barkNotify/pushMeNotify 的设备级回调里 `reject(err)`/`reject(new Error(...))` 是**外层 reject**——一个设备失败 → 整个通道 promise rejected（其他设备成功的 `innerResolve` 无法改变已 rejected 状态）→ 若该通道为唯一通道 → sendNotify 全部失败 → 不写缓存 → **每次运行重试 → 有效设备每 5 分钟重复收到**（轰炸，且消息永不写缓存）
- **来源**：v3.160「API 级失败 reject」修复（单通道用户消息不丢）引入的副作用——没考虑多设备模式
- **真实验证**（2026-08-03，mock got）：
  ```
  修复前：Bark 双设备 dev1 成功 dev2 code=500 → 整体 reject → sendNotify 抛错 → 不写缓存 → dev1 每 5 分钟重复收到
  修复后：Bark 1 成 1 败 → 通道成功（写缓存，不重复）；全败 → reject（消息不丢重试）
  ```
- **修复（v3.166）**：设备级回调改 `innerResolve({ok})`（不再外层 reject）→ `Promise.all` 汇总「至少一个成功 = 通道成功，全部失败才 reject」——与 sendNotify 的 allSettled 哲学（至少一个通道成功=成功）一致；单设备场景行为不变
- **验证**：Bark/PushMe 1 成 1 败 → 成功 ✓；全败 → reject ✓；变异（some→every）→ 测试红 ✓；test_notify +2

## 13. `alert.intervalMs` 非法字符串 → 告警不限频轰炸 ✅ 已修复（v3.167）

- **触发场景**：`Config.alert.intervalMs` 配为非法字符串（如环境变量 `'abc'` 拼错）——v3.158 确认的环境变量字符串配置场景
- **根因**：`_sendAlert` 用 `(Config.alert.intervalMs > 0)` 判断——`'abc' > 0` 比较 false → interval=0 → **不限频**（每次接口异常都发告警轰炸）；其他数值配置（retry/parallelLimit/titleMax 等 7+ 处）均 `Utils.num` 转换回退默认，**此遗漏**
- **真实验证**（2026-08-03）：
  ```
  修复前: intervalMs='abc' → interval=0（不限频）→ 连续两次接口异常都发告警（轰炸）
  修复后: intervalMs='abc' → Utils.num 回退 3600000 → 限频 1 小时（第二次不发）
  -1/0 → 不限频语义保留 ✓；'3600000'（字符串）→ 3600000 ✓
  ```
- **修复（v3.167）**：`Utils.num(Config.alert.intervalMs, 3600000)`（与 #8 timeout 同款模式）
- **连带修复**：test_app 5 处 `getFilePath('alert.state')` 未解构（`getFilePath is not defined` 被 catch 吞 → alert.state 从未真正清理 → 残留 lastAt 限频污染后续告警测试）→ 改 `path.join(CACHE_DIR, 'alert.state')`
- **验证**：t72（第一次发/第二次限频）；变异（去掉 num 转换）→ t72 红 ✓

---

## 14. HTTP 200 + JSON `null` 响应被当作成功 → 消息永久丢失 ✅ 已修复（v3.180）

- **触发场景**：推送 API 返回 HTTP 200，但响应体解析结果为 JSON `null`。
- **根因**：部分通道在读取 `data.code` / `data.errcode` 时对 `null` 缺少判空；异常被通道内部捕获后仍 resolve，主流程因此把消息写入缓存。
- **风险**：接口实际没有确认送达，但消息被视为成功处理；下次运行判重跳过，可能永久丢失。
- **修复**：Push+、企业微信、WxPusher、息知统一增加响应对象判空和失败分支防御；异常结构按失败处理，不写缓存，后续运行重试。
- **验证**：JSON `null` 及正常失败响应均被识别为失败；正常成功响应行为不变。

## 15. `HITOKOTO` 为 `0`/非法值仍请求一言 → 增加无意义延迟 ✅ 已修复（v3.181）

- **触发场景**：通过环境变量或本地配置将 `HITOKOTO` 设置为数字 `0`、字符串 `'0'`、空值或其他非法字符串。
- **根因**：旧判断仅排除字符串 `'false'`；除 `'false'` 外的所有值都会进入一言请求分支。
- **影响**：一言是可选装饰功能，误配置时仍会额外发起网络请求；接口慢或超时会增加每次推送的等待时间。
- **修复**：仅显式布尔值 `true` 或字符串 `'true'`（大小写不敏感）启用一言；其余值关闭。
- **验证**：新增回归测试覆盖 `false`、`0`、`'0'`、`'false'`、空值、非法字符串和正常 `'true'` 场景。

## 16. 自制 got 路径相对重定向错误 / 非法地址异常 ✅ 已修复（v3.182）

- **触发场景 1**：服务端返回 `Location: next` 等路径相对重定向。
- **根因 1**：旧实现直接拼接 `origin + location`，会生成错误地址，未按当前 URL 的路径上下文解析。
- **触发场景 2**：服务端返回无法解析的非法 `Location`。
- **根因 2**：异步响应回调内直接执行 `new URL()`，异常没有转换为请求 Promise 的 reject。
- **影响**：正常的路径相对重定向可能失败；异常重定向可能造成未捕获异常或请求生命周期异常。
- **修复**：使用 `new URL(location, currentUrl)` 统一解析；解析失败时消费响应体并 reject。
- **验证**：新增路径相对重定向和非法重定向地址回归测试。

## 17. `saveBatch()` 非数组输入导致 `for...of` 崩溃 ✅ 已修复（v3.183）

- **触发场景**：外部调用 `saveBatch()` 时传入对象、数字、布尔值、Symbol 或字符串，而不是消息数组。
- **根因**：旧入口只判断空值和 `length === 0`，对象、数字等值继续进入 `for...of`，抛出 `newMessages is not iterable`。
- **影响**：公开缓存 API 在脏输入下直接抛异常；虽然主流程传入数组，但独立调用和测试/集成场景可能触发。
- **修复**：入口统一使用 `Array.isArray()` 校验；非数组输入安全返回。
- **验证**：新增非数组输入回归测试，正常数组写入路径保持不变。

## 18. 缓存路径逃逸与危险 URL 控制空白绕过 ✅ 已修复（v3.184）

- **缓存路径逃逸**：`cache.dir` 使用 `..` 或绝对路径时，旧逻辑可能把缓存、日志和状态文件写到项目根目录之外；现在解析后强制限制在项目根目录内，越界配置回退默认目录。
- **危险 URL 绕过**：`java\\nscript:`、`java\\tscript:`、`java\\rscript:` 等协议中间控制空白旧逻辑可能生成 Markdown 链接；现在协议判断前统一移除 ASCII 控制空白。
- **验证**：新增路径逃逸和换行/制表符/回车绕过回归测试。

## 19. 过滤哈希时序、状态文件半写与异常响应敏感字段日志泄露 ✅ 已修复（v3.185）

- **过滤哈希时序**：过滤缓存清理写入失败时旧 `_f` 条目可能保留；现在只有清理成功才推进 `filter.hash`，失败会在下次运行重试。
- **状态文件半写**：`alert.state` 与 `report.state` 原先直接写目标文件；现在统一临时文件 + rename，写入失败清理临时文件并保留旧状态。
- **日志敏感字段**：WxPusher/息知等异常路径原先对未知响应完整序列化；现在仅输出白名单错误摘要字段。
- **验证**：覆盖缓存 rename 失败、异常响应含 token/key 和状态写入调用路径。

## 20. 符号链接缓存逃逸、损坏日报状态与实体编码主动 HTML ✅ 已修复（v3.186）

- **符号链接缓存逃逸**：项目内缓存路径通过符号链接指向项目外时，旧词法检查无法识别；现在逐级 realpath 校验并越界回退。
- **损坏日报状态**：`report.state` 为非对象或计数字段异常时，旧逻辑可能静默失效；现在统一归一化安全状态。
- **实体编码主动 HTML**：实体编码解码后可能重新形成 script、iframe、事件属性或危险 URL；现在解码后再次清理。
- **验证**：新增三类回归测试和对应变异测试，旧逻辑变异均被捕获。

## 21. 过滤 hash 脏值联合崩溃与已配置密钥回显 ✅ 已修复（v3.187）

- **过滤 hash 联合路径**：单函数配置校验和规则编译都能安全处理嵌套 Symbol，但 App.run 的过滤 hash 仍可能在字符串化时崩溃；现在 hash 与其他配置入口统一安全归一化。
- **密钥回显联合路径**：异常响应白名单字段本身可能包含已配置 token/key；现在摘要字段也经过密钥脱敏，不改变错误码和诊断信息。
- **验证**：新增 App.run + filterHash 联合回归测试，以及异常响应摘要密钥回归测试。

## 22. 通道错误摘要在 reject/告警链路中回显已配置密钥 ✅ 已修复（v3.190）

- **触发场景**：第三方推送接口 HTTP 200 但业务失败，响应的 `msg`/`errmsg`/`description` 回显 token/key；通道日志路径已脱敏，但 reject 错误继续携带原始字段。
- **影响**：`sendNotify()` 汇总错误后，主流程会把错误写入 `run.log`，并可能通过异常告警再次发送；敏感凭证可能进入持久日志或告警消息。
- **修复**：通道日志与 reject 错误统一经过 `safeErr()`；URL 型配置额外脱敏路径中的 token 段，保留错误码/诊断文本。
- **验证**：新增通道 reject 错误信息脱敏测试；删除 WxPusher reject 脱敏的变异可被测试捕获；全量测试通过。

## 23. PushMe 纯文本错误响应日志仍可回显 key ✅ 已修复（v3.191）

- **触发场景**：PushMe 返回纯文本错误响应，文本中包含设备 key。
- **根因**：异常日志路径直接使用 `${data}`，没有经过 `safeErr()`；上一轮只修了结构化响应和 reject 错误摘要。
- **影响**：PushMe key 可能进入运行日志或被日志收集系统记录。
- **修复**：异常日志统一改用 `safeErr(data)`。
- **验证**：新增纯文本错误响应测试；删除 `safeErr(data)` 的变异会导致测试失败；全量测试通过。

## 24. `{Html内容}` 主动 HTML 经过 HTML 渲染通道进入客户端 ✅ 已修复（v3.192）

- **触发场景**：接口 `content_html` 含 `<script>`、事件属性、实体编码主动标签等内容，用户使用 `{Html内容}` 模板并通过 HTML 渲染通道发送。
- **根因**：`{Html内容}` 路径只清洗危险 URL，没有复用实体解码后的主动 HTML 清理链路；`htmlToMarkdown` 路径虽有防御，但不能保护 `{Html内容}`。
- **影响**：恶意或被污染的线报内容可能在支持 HTML 渲染的客户端中触发脚本/事件属性；属于高风险内容安全问题，具体严重级别取决于客户端实际 HTML 隔离能力。
- **修复**：实体解码后统一调用 `sanitizeDecodedHtml()`，清理 script/style/iframe/object/embed/svg/math、事件属性、危险 URL 以及 xlink/formaction/srcset/style 等加载路径，并覆盖带引号、无引号、斜杠分隔和 NUL 拆散属性。
- **验证**：新增主动标签、事件属性和实体编码测试；删除新清理链路的变异会导致测试失败；全量测试通过。

## 25. 最终推送出口 HTML 形态检测漏掉非白名单元素 ✅ 已修复（v3.193）

- **触发场景**：自定义模板（例如 `{内容}`）产生 `<input>`、`<form>` 等不在原检测白名单中的真实 HTML 标签，并通过支持 HTML 渲染的推送通道发送。
- **根因**：`Pusher.send()` 的最终主动 HTML 清理只在有限标签白名单命中时执行；非白名单元素可能绕过出口清理，事件属性等危险内容继续进入通道。
- **影响**：接口内容或自定义模板内容可能携带主动 HTML；最终出口防护不完整，实际风险取决于客户端的 HTML 渲染能力。
- **修复**：改为识别一般字母开头的 HTML 标签形态，再进入统一的实体解码和主动 HTML 清理链路；不含真实标签的纯文本 `onerror=`、实体字面量等仍不被过度清洗。
- **验证**：补充 `<input autofocus onfocus=...>` 集成回归测试；全量测试通过。

## 26. v3.194 批量审查修复 ✅

### 26.1 过滤字段脏对象转换异常

- **触发**：标题、楼主、内容或分类字段的 `toString()` 抛异常。
- **影响**：公开过滤 API 或主流程可能直接抛错，中断整批处理。
- **修复**：正则匹配和分类限定匹配统一安全字符串化；转换失败按保守放行处理。

### 26.2 `validateConfig()` 的 `pingbitime` 脏值崩溃

- **触发**：`pingbitime` 是嵌套 Symbol 数组或自定义 `toString()` 抛错对象。
- **影响**：配置校验阶段直接异常，主流程无法继续。
- **修复**：字符串转换统一捕获异常，返回警告并忽略该值。

### 26.3 模板循环引用对象崩溃

- **触发**：模板占位符对应字段包含循环引用对象。
- **影响**：占位符替换中的 `JSON.stringify()` 抛错，单条推送流程中断。
- **修复**：对象序列化失败时安全替换为空字符串。

### 26.4 无引号图片属性丢失

- **触发**：合法 HTML 写法 `<img src=https://... alt=...>`。
- **影响**：图片标签未转换，随后被标签清理，推送中图片静默丢失。
- **修复**：补充无引号 `src` 和 `alt` 属性解析，并保留危险 URL 防护。

### 26.5 Server 酱字符串错误码兼容性

- **触发**：服务端返回 `errno: "0"` 或 `errno: "1024"`。
- **影响**：成功或“重复内容已送达”被误判为失败，导致不必要重试；严重时可能重复推送。
- **修复**：字符串/数字错误码统一按数值语义判断。

### 26.6 WxPusher HTML 检测与主流程口径分裂

- **触发**：内容包含 `<input>`、`<form>` 等非原白名单 HTML 元素。
- **影响**：主流程虽已清理，但 WxPusher 仍按 Markdown 类型发送，HTML 内容可能裸露；且检测逻辑与主流程不一致。
- **修复**：统一识别一般 HTML 标签，同时排除 `<https://...>` Markdown autolink 误判。

## 27. v3.195 批量审查修复 ✅

### 27.1 空值数值配置被隐式转换

- **触发**：`alert.intervalMs` 等数值配置为 `''`、`null` 或布尔值。
- **影响**：JavaScript `Number()` 隐式转换为 `0`/`1`，可能把告警限频变成不限频或产生错误配置语义。
- **修复**：无效空值和布尔值回退默认；显式字符串 `'0'` 仍保留特殊值语义。

### 27.2 `compileRules()` 的 `pingbitime` 脏值崩溃

- **触发**：`pingbitime` 对象无法转换为字符串。
- **影响**：规则编译阶段直接抛错，主流程无法启动。
- **修复**：转换失败安全忽略该规则。

### 27.3 官方 got 迁移后的原始 JSON 语义

- **触发**：接口响应 JSON 为数字、布尔值或 `null`。
- **影响**：`.json()` 只接受 object；数字/布尔值会被误判为非 JSON，甚至触发 `.slice()` 类型异常。
- **修复**：除字符串响应外，其余已解析 JSON 原始值直接返回。

### 27.4 `safeErr()` 被异常 `message` getter 再次打崩

- **触发**：错误对象的 `message` 属性 getter 抛异常。
- **影响**：错误处理和日志脱敏路径可能二次抛错，掩盖原始故障。
- **修复**：读取 `message` 时单独捕获异常，继续提取安全错误字段。

### 27.5 Bark 大写协议地址被错误拼接

- **触发**：配置 `HTTPS://api.day.app/...` 或 `HTTP://...`。
- **影响**：大小写合法的绝对 URL 被误认为设备码，变成错误地址。
- **修复**：协议判断改为大小写不敏感。

### 27.6 通道成功码数字/字符串类型不兼容

- **触发**：Push+、Bark、企业微信、WxPusher、息知返回字符串形式的成功码。
- **影响**：实际成功被误判为失败，触发不必要重试；某些场景会造成重复推送。
- **修复**：统一兼容数字和字符串形式的业务成功码。

## 附：验证方法（可复现）

```bash
# 候选1：{Html内容} 模板输出
node -e "require('./xbk_function_v3.js').fetchData().then(d => console.log(require('./xbk_function_v3.js').tuisong_replace('{Html内容}', d[0]).slice(0,100)))"
# 候选3：pingbitime 有效性
node -e "const x=require('./xbk_function_v3.js');x.fetchData().then(d=>{const c=x.compileRules({pingbitime:'5'});console.log('拦截',d.filter(i=>!x.listfilter(i,c)).length,'/',d.length)})"
```

---

## 状态说明
- 已记录的问题均**真实验证触发**、风险明确，且已有对应修复与验证记录
- **历史问题已持续收敛至 v3.180**：v3.159～v3.167 修复前 13 项真实问题；v3.180 又补齐 HTTP 200 + JSON `null` 响应结构异常的 P1 防御。
- 测试覆盖：对应集成测试、通道测试和 got/输入防御测试均已补齐；全量结果以 `node run_tests.js` 实际输出为准。

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
