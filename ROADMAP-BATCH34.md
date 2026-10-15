# 控制台扩展路线图——批次③④待办（v3.300+ 规划）

> 2026-10-16 整理。批次①（v3.298，PR #228）、批次②（v3.299，PR #229）已合入 main 并上线。
> 本文档是批次③④的实现蓝图：每项写清「做什么 / 怎么做 / 防线 / 测试 / 验收」。
> 总红线沿用两批次已验证的纪律，见 §0；全部零新 npm 依赖、不新增生产文件。

---

## 0. 沿用红线（批次③④逐条自查）

- 前端 fetch 第一参数必须是**纯字面量 URL**（查询参数经 URLSearchParams 后只进模板字符串查询段；变量/查表第一参数都红，PR #227 实测）。
- 用户输入**不进正则**；查询参数 Number + 整数 + 白名单/区间钳制。
- 符号链接/非常规文件防御与 `readSafeTextResult` 同口径（O_NOFOLLOW、fstat 复检 dev+ino、replaced ≠ unsafe）；读 FIFO 场景开 `openNonBlocking`。
- 配置/凭证脱敏必须**显式逐字段白名单**（禁止 Object.keys / JSON.stringify 泛型拷贝）；URL 中 `?token=` 不得原样进任何日志、响应或错误消息。
- 凭证值绝不离开 sendNotify 作用域（批次④尤其注意）。
- run id = 「epoch.seq」形态（v3.299）；新增引用 run 的端点一律按此形态校验。
- 触发类端点不写文件（批次②已按「运行控制动作留痕」单一例外口径执行，批次③④不再扩例）。
- 文档三处同步：README / CHANGELOG（正序，test_filter 取最后一个 `## vX.Y`）/ SYSTEM_CONTRACT.md；版本四处同步（xbk_function_v3.js 首行、CHANGELOG、package.json、package-lock.json）；commit 首行 `feat:` ≤100 字符；PR 过四套扫描器，评审逐条真修 → GraphQL resolve 线程 → mergeState=CLEAN 才合。

---

## 批次③ 观测面（3 个功能，v3.300 单 PR）

### 3.1 SSE 实时输出流（GET /api/runs/stream）

**做什么**：运行中任务的子进程输出（`record.output`）从「2–5s 轮询」升级为服务端推送——运行中打开详情即实时滚动，任务结束流自动关闭。

**怎么做**：
- 端点：`GET /api/runs/stream?id=<epoch.seq>`（鉴权：与页面同款 `?token=` 查询参数——原生 EventSource 不能带自定义头，Bearer 不可用；Cookie 仍不收。端点与前端统一 `id=` 键名，杜绝两侧口径分叉）。
- 响应 `Content-Type: text/event-stream`，禁代理缓冲（`X-Accel-Buffering: no`）；心跳注释行 `: ping` 每 15s 防 idle 断连。
- 事件负载只发**增量**：偏移单位统一用 **JS 字符串偏移（UTF-16 code units）**，量取、切片、下发三处同单位（不用「字节」描述，杜绝多字节文本偏移错位）；服务端记每个连接已发偏移 + **单调总偏移计数器**（record 侧维护 `outputTotalLength` 只增不减——环形缓冲淘汰后 `record.output.length` 封顶不再反映新数据，连接游标一旦落后于「总偏移 − 当前缓冲长度」即判过期，发 `event: reset` + `data: {"full":"…"}` 整段重发）。
- **重连/续传语义**：新连接一律从「当前快照尾部」开始（URL 带 `since=<offset>` 可选参数）；前端打开详情时先拿到轮询快照，再以快照长度为初始游标建流——既有输出不会重复追加；断线自动重连的 EventSource 由前端 `onerror` 显式 `close()` 后走整段重拉（快照兜底），不带过期游标复连。
- **背压闸**：每次 `res.write()` 检查返回值，false 时暂停该连接的推送（记待发，writeable 回调恢复）；待发积压超 `SSE_MAX_PENDING = 1MiB` 直接断开该连接（慢客户端不拖垮控制台内存）。
- record 从 runs Map 删除（20 条上限淘汰）或 finishedAt 已设且增量发完 → 发 `event: done` 后 `res.end()`。
- **named event 前端必配监听**：`reset`/`done` 都是 named event（原生 EventSource 不进 onmessage）——前端必须 `es.addEventListener('reset', …)`、`addEventListener('done', …)` 显式注册；done 回调里 `es.close()`（防原生自动重连在流已关闭后无限重试）。
- 关停联动：`shuttingDown` 置位时立即给所有活跃 SSE 连接发 done 并 end（wireGracefulShutdown 已有活跃子进程终止钩子，顺路清理）。
- **连接上限**：每进程并发 SSE ≤ 8（超出直接 503，防 token 泄露后被刷连接拖垮控制台）；响应对象登记进模块级 Set，close 事件必清理。
- 前端：RunsPanel 详情展开态时若 `!finishedAt` 改走 EventSource（原生 API，零依赖）；打开流前先取轮询快照、以快照长度为初始游标；onmessage 追加；onerror 显式 `close()` 并整段重拉一次后退回轮询；done/reset 走 addEventListener。

**防线清单**：
1. 鉴权失败 401（不升级连接）。
2. id 白名单形态 `^\d{13,}\.\d{1,10}$`（用户输入不进正则——这条是**服务端**白名单常量正则，允许；404 不存在）。
3. 连接数闸 ≤8；请求关闭时 Set 清理（防泄漏）。
4. 输出增量按字符串长度切片，`RUN_LOG_MAX_BYTES` 环形淘汰后 since 语义仍自洽（淘汰发生时发 `event: reset` 让前端整段重拉）。
5. 心跳定时器 unref；连接 close 时 clearInterval。
6. SSE 不进 5s 主轮询互斥（独立通道，不抢 inFlightRef）。

**测试（test_console.js 新增）**：
- 401 / 404 / id 形态 400 / id 键名缺失 400。
- fake child 场景：连上后向 record.output 追加内容，断言收到的 data 增量正确；环形淘汰触发 reset（named event）+ 整段重发；record 完结后收到 done 且连接关闭。
- 多字节断言：含中文/emoji 输出的增量偏移一致（不重不漏）。
- 连接上限：第 9 个连接 503。
- 慢客户端：write 返回 false + 待发超限 → 连接被断开。
- shuttingDown → 活跃连接全部收 done。

**验收**：运行一轮 dry-run，详情页实时滚动输出，任务结束流关闭、页面回退轮询无报错。

### 3.2 消息导出 CSV/JSON（POST /api/messages/export）

**做什么**：推送记录页可导出当前筛选结果为 CSV 或 JSON 文件下载。

**怎么做**：
- 端点用 **POST** `/api/messages/export`（body: `format=csv|json&page=&size=&cate=&q=`）——与 /api/runs/cancel、/api/runs/detail 同款 POST+body 形态，绕开 fetch 字面量红线对 GET 查询串的依赖，且筛选词不落访问日志 URL。
- 服务端**不走** /api/messages 的 page-size 分页钳制（那是展示分页口径）——导出走独立的全量扫描：复用 readMessages 的过滤谓词但循环翻页取全，直到 `EXPORT_MAX_ROWS = 5000` 或取尽（超出钳制 + 响应头 `X-Export-Truncated: true` 如实标注）。
- CSV 列固定：id / 时间 / 分类 / 标题 / 内容摘要（内容截 200 字符）。**防公式注入**（CWE-1236）：对**每个**单元格先去前导空白/tab/`'` 等 spreadsheet 忽略前缀后再判首字符，命中 `= + - @ \t` 即前置 `'` 中性化（Excel/Sheets 惯例）；CRLF 全部转义；单元格内 `"` 翻倍。文件头补 **UTF-8 BOM**（Excel 无 BOM 时按本地代码页解析会乱码中文）。
- 响应头：CSV → `Content-Type: text/csv; charset=utf-8` + `Content-Disposition: attachment; filename="messages-export.csv"`（文件名固定，不带查询词——查询词可能含 token 形态字符串，绝不回显进头）；JSON → application/json。
- 前端：MessagesPanel 工具行加「导出 CSV / 导出 JSON」按钮——fetch 后 `response.blob()` + `URL.createObjectURL` + 临时 `<a download>` 点击（不拼服务端下载 URL，凭证不出现在 href）。

**防线清单**：
1. 鉴权 401；format 白名单（非 csv/json 400）。
2. 分页参数与 /api/messages 同款钳制；q/cate 不进正则（readMessages 既有过滤逻辑复用）。
3. 公式注入中性化逐单元格执行（含分类/标题——它们来自线报源站，不可信）。
4. 行数上限 5000 截断 + 响应头披露。
5. 导出响应不落访问日志（3.3 的日志器对 /api/messages/export 记录 method+path，不记 body）。

**测试**：
- 401 / format 非法 400。
- CSV 断言：`"  =1+1"`（前导空白+公式）中性化、`@SUM(...)` 中性化、含逗号/引号/换行的标题正确转义、文件头 BOM 字节（EF BB BF）存在。
- 5000 行钳制 + X-Export-Truncated 头（fixture >100 条，验证跨页取全不受展示分页 100 条钳制影响）。
- JSON 形态：字段白名单（id/time/cate/title/excerpt），不携带判重身份/推送渠道等内部字段。

**验收**：导出的 CSV 用 Excel 打开无公式执行、无串列；JSON 可被 jq 解析。

### 3.3 访问日志（内存环形 + ?token= 脱敏）

**做什么**：控制台把每个请求的 method/路径/状态码/耗时/来源记进环形访问日志，系统页可查（GET /api/access-log），方便排查「谁在什么时候碰了控制台」。

**怎么做**：
- **纯内存环形数组** `ACCESS_LOG_MAX = 200` 条（重启即空，README 披露）——不写盘：避免「日志自身成为磁盘面」引新的符号链接/并发写问题，且已有时序上更全的 run.log 留痕体系。
- 记录字段：`at`（上海戳）、`method`、`path`、`status`、`ms`、`src`（socket.remoteAddress）。
- **脱敏硬闸**（本功能核心）：写日志前对 path 做**迭代式全量清洗**——循环执行 `[?&]token=([^&]*)` → `token=***` 直到无变化（防重复 token 参数逃逸单次替换），且对 `URL.parse` 解码后的 path 再洗一遍（防 `%74oken=` 编码键名形态）。这是**允许的常量正则**（服务端、无用户输入参与构造）。响应体绝不入日志；Authorization 头绝不入日志。
- **记什么**：记录点统一在响应出口钩子（`res.on('finish')` 一次性装配，覆盖 sendJson / 附件流 / 页面全部出口——导出等非 sendJson 路由不再漏记）。**降噪白名单**：常规轮询端点（/api/status、/api/runs）**成功**请求不记（只记非 2xx/3xx）——否则 5s 轮询 ≈24 条/分钟，9 分钟就冲掉整个 200 环形窗，把真正有信息量的访问事件挤出；静态资产 200 不记；401 全记且单独计数。系统页显示「近窗未授权尝试 N 次」。
- 端点：`GET /api/access-log`（鉴权同款；返回 `{items, unauthorizedCount}`，时间正序）。

**防线清单**：
1. token 脱敏在**进入日志数组之前**（不是展示时才滤——数组本身必须干净，防将来别的消费方读到原文）；迭代清洗 + 解码后复洗，堵编码键名/重复参数两种逃逸形态。
2. 环形上限 200：超限丢最旧（双端队列语义，Array + shift 或游标环形）。
3. /api/access-log 自身的请求也记录（日志器可观测自身），但它响应里只含脱敏后内容——自举无泄漏。
4. src 只记 IP 字符串，不记 socket 对象（防引用泄漏）。
5. 记录点用 res.on('finish') 单点装配，任何响应路径（JSON/附件/页面）统一覆盖，无旁路。

**测试**：
- 带 `?token=xxx` 的请求 → 日志里 token=***（原文零出现，深断言 JSON.stringify(items) 不含真实 token）。
- 逃逸形态：`?a=1&token=x&token=y`、`?%74oken=z` → 全部 `***`。
- 401 计数：3 次无凭证请求后 unauthorizedCount=3。
- 环形钳制：201 条后最早一条被挤出。
- 静态资产与 200 页面不入日志；/api/status、/api/runs 的 200 不入日志；它们的 5xx 入日志。
- 导出附件响应（非 sendJson 出口）有访问记录。

**验收**：线上正常轮询 10 分钟后 /api/access-log 有记录、无一条含真实 token、无静态资产噪音。

### 批次③交付物与顺序

1. `feat/console-observability-batch3` 分支（自 main）。
2. 实现顺序：3.3 访问日志（改动最小、独立）→ 3.2 导出 → 3.1 SSE（改动最大：连接管理 + 关停联动）。
3. 版本 bump v3.300 四处 + README（新增 3 个端点一句话 + SSE 连接上限/访问日志不落盘披露）+ SYSTEM_CONTRACT.md（SSE 生命周期、导出防注入、脱敏闸三点）+ CHANGELOG 正序插入。
4. test_console.js 每功能独立 aok 用例；`npm run lint` + `node test_console.js` 本地全绿 → sudo 全量 → sudo push → PR → 评审循环 → CLEAN。

---

## 批次④ 通知渠道自检（1 个功能，v3.301 单 PR，最重）

### 4.1 --notify-test 实测推送

**做什么**：给推送链路加「自检」入口——用户改完 push_config 后不用等真实线报触发，跑一次 `node xbk_function_v3.js --notify-test` 即向所有已配置渠道各发一条固定测试消息，并在控制台系统页提供同款按钮（POST /api/notify-test）。

**现状盘点（实现前先复核）**：
- 推送入口：`Pusher.send(text, desp, notifyModule)`（xbk_function_v3.js 推送段）；渠道配置来自 `Config.push` + push_config.local.js；dry-run 语义 = 全链路走完但不发通知（APP2-04 口径）。
- **关键约束**：`--notify-test` **必须无视 dry-run**（它本身就是「真实发一条」的自检），但必须**绝不写缓存、绝不写判重墓碑、绝不触发任何抓取/接口请求**——它是纯推送面动作。

**怎么做**：
1. **CLI 形态**：xbk_function_v3.js **主入口 main guard 里、runSingleEntry()/run() 调度之前**（与 --status 的分发位置对齐——注意 --status 实际分发在 qinglong/xbk_push.js 入口，本分支必须在 xbk_function_v3.js 自己的 main guard 里早退，否则会掉进 runSingleEntry() 触发完整抓取/推送/缓存流程）新增 `--notify-test` 互斥早退分支：
   - 组装固定测试消息：标题「xbk-push 通知自检」+ 正文含版本号、时间戳（上海戳）、主机名——用户可核对到达时间。
   - **单次广播发送**：sendNotify 是「一次调用广播到所有已配置渠道」的语义——逐渠道循环 Pusher.send 会让每个渠道收到 N 份重复。正确形态：**只调一次** Pusher.send（全部渠道各收一份），结果按 sendNotify 返回的渠道粒度如实汇报；无法拿到渠道粒度结果时汇总口径只报「已发送/发送失败」，不伪造逐渠道成功表。
   - **HITOKOTO 副作用抑制**：sendNotify 在 HITOKOTO 开启时会抓一言 API 并拼进消息——自检路径显式跳过（自检消息必须内容固定可核对，且「纯推送面动作」不得引入额外外部请求；实现按 sendNotify 的 hitokoto 开关传参或临时置禁，不改动其默认行为）。
   - 输出汇总表到 stdout（exit 0 = 发送成功；exit 1 = 发送失败）；控制台触发的同款动作结果进触发历史（见下），**不写 run.log**。
2. **控制台形态**：`POST /api/notify-test`（无 body）：
   - 复用触发类端点全套防线（鉴权 401 / shuttingDown 503 / 重放窗 lastAccept action='notify-test' / console-trigger.lock 单飞）——它是一次真实推送动作，语义上就是「另一种动作」。
   - 子进程 = `spawn(process.execPath, [ENTRY_SINGLE, '--notify-test'])`——startAction 的 entry 映射只认 `'single'` → ENTRY_SINGLE，ACTIONS 表新行必须用 `entry: 'single'`（写 `entry: 'main'` 之类会被映射进 qinglong 入口，跑错脚本）。
   - run id / 触发历史 / 停止按钮全部自动复用（startAction 已参数化 entry；ACTIONS 表加一行 action='notify-test'，label=「通知自检」）。
   - **并发/窗口语义**：与既有动作共享同一把触发锁（同一时刻只能有一个触发任务，notify-test 不例外）；重放窗建议单独 60s（比 12min 短——自检是高频调试动作，但也不能连点刷通知）。
   - **零新增持久写**：自检不写 run.log（§0「触发类端点不写文件」不扩例——批次②的取消留痕是「既有任务被外力中止」的补记，自检是全新动作面，其结果已完整进触发历史内存记录，无需落盘）。
3. **凭证安全**（本批次最高优先级防线）：自检代码路径**只允许调用 Pusher.send**；渠道 token/appSecret 等凭证值在自检路径的任何日志、返回值、错误消息中只允许以「渠道名 + 成功/失败 + HTTP 状态码（若有）」形态出现——错误对象必须过 summarizeError 同款脱敏（xbk_push.js 既有口径），绝不 e.message 原样输出（got 的错误 message 可能含 URL query 里的 key）。
4. **文档**：README「快速开始」加自检用法；SYSTEM_CONTRACT.md 增补「notify-test 是 dry-run 的对偶（专用真实发送），其互斥约束清单」。

**防线清单**：
1. --notify-test 早退分支在 xbk_function_v3.js **自己的 main guard** 里、runSingleEntry()/run() 之前——落到别的入口或晚于调度都会触发完整抓取/推送/缓存流程（自检变成真跑一轮）。
2. 不写缓存：自检路径不 new MessageStore 写动作、不碰 push.json / 墓碑 / filter.hash；**不写 run.log**（触发类动作零新增持久写）。
3. 单次广播：只调一次 Pusher.send——逐渠道循环会让每渠道收 N 份重复；结果汇报不伪造渠道粒度。
4. HITOKOTO 抑制：自检消息内容固定，不抓一言 API（纯推送面 = 零额外外部请求）。
5. 凭证零泄漏：错误消息统一脱敏；触发历史自检行只含「发送成功/失败」结论。
6. 控制台端点全套触发防线 + 60s 独立重放窗；ACTIONS 表 entry 必须是 `'single'`。
7. dry-run 与 notify-test 互斥：同时传两个参数时 notify-test 拒绝执行并报错（fail-closed，防语义混淆）。

**测试**：
- 单测：参数解析（xbk_function_v3.js 直跑 --notify-test 早退，**不触发抓取/写缓存**——用注入 fs 桩断言零写调用）；与 dry-run 同时出现 → 报错。
- 发送语义：注入 fake Pusher 断言 send 只被调**一次**；HITOKOTO 开启时自检不发外部一言请求。
- 退出码：成功 0 / 失败 1。
- 控制台：POST /api/notify-test 无凭证 401、重放窗 409（60s 内二次）、ACTIONS 映射断言 spawn 的 entry 文件是 ENTRY_SINGLE、触发历史出现 notify-test 记录、停止按钮可停掉自检子进程（复用 cancel 用例形态）。
- **不**做真实推送的集成测试（无凭证环境；真实验证靠用户线上点一次）。

**验收**：本机 `node xbk_function_v3.js --notify-test` 实发一条到用户真实渠道（用户确认收到）；控制台按钮同效；全程无缓存写入（cache-health 前后对比字节数不变）。

### 批次④风险与代价（提前说明）

- 动 xbk_function_v3.js（大文件）：参数解析段 + 推送段各一小块，不进 run() 主循环——变异矩阵全量 ≈71–91min，跑一次兜底。
- 推送语义改动：仅新增独立早退分支，不改 Pusher.send 既有行为——但「真实发送」动作进控制台按钮，评审可能被 scanner 盯防滥用面（重放窗 + 单飞锁 + 鉴权三闸已在设计内）。
- 用户实测依赖：最后一步需要用户手机确认收到测试消息。

---

## 批次节奏备忘

- 批次③：1 个 PR、3 功能、改动集中在 scripts/（console.js + app.js + status.js 基本不动）——预期评审面比批次②小（无轮界类语义重构）。
- 批次④：1 个 PR、1 功能、动大文件——单独走，评审后手动全量变异矩阵兜底。
- 每批次开工前照例派只读子代理做前置分析（批次③：SSE 与 Node http 原生服务器的接缝 + 导出编码细节；批次④：参数解析段与 Pusher 现状盘点）。
