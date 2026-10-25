# xbk-push

青龙线报抓取与推送工具：自动获取线报，按规则过滤、去重，再推送到你选择的通知渠道。

## 快速开始

### 1. 安装依赖

需要以下受支持的 Node.js 版本之一：**22.22.2 及以上的 22.x、24.15.0 及以上的 24.x，或 26.x 及以上**。

Node.js 23.x、25.x 和 24.0–24.14 不受 `re2` 原生模块支持。安装前可先检查：

```bash
node --version
```

```bash
npm ci --ignore-scripts
npm rebuild re2
```

`--ignore-scripts` 用于避免安装依赖时自动执行第三方生命周期脚本。随后单独运行 `npm rebuild re2`，只执行 re2 官方安装脚本：优先下载并校验预编译模块，失败时回退到 node-gyp 源码构建。若预编译包不可用且系统没有 Python 与 C/C++ 工具链，源码 fallback 会失败。

### 2. 设置通知渠道

复制配置模板：

```bash
cp push_config.local.js.example push_config.local.js
```

编辑 `push_config.local.js`，填入至少一个通知渠道的密钥。常用渠道包括：

- PushPlus
- Server酱
- Bark
- PushMe
- 企业微信机器人
- WxPusher
- 息知
- PushDeer
- Telegram

模板中已列出各渠道的配置名称和示例。没有使用的渠道可以保持注释。

> WxPusher 支持「点击通知直达」：推送时带上原文链接（`WX_pusher_clickUrl` = `deal`/`detail`/`off`），在 App 里把「我的 → 通用 → 通知点击设置」设为「原文链接」后，点通知可直接打开对应商品或线报页。

> `push_config.local.js` 含有密钥，已被忽略，不要提交到 Git 或发给别人。

### 3. 运行

```bash
node qinglong/xbk_push.js
```

程序会持续运行并按默认间隔抓取、过滤和推送。

## 青龙使用

依赖安装和升级只在首次部署或更新版本时执行，不要放进每次定时调度的任务脚本：

```bash
cd /项目目录
npm ci --omit=dev --ignore-scripts
npm rebuild re2
```

执行 `--check` 前，必须先配置至少一个完整通知渠道。使用本地配置时编辑项目根目录的 `push_config.local.js`；使用青龙环境变量时，先创建一个暂不启用的青龙任务（或先不配置定时），填入渠道变量，并暂时使用以下检查命令：

```bash
cd /项目目录
node qinglong/xbk_push.js --check
```

手动运行该任务并确认检查通过后，把任务命令改为常驻启动，再启用任务：

```bash
cd /项目目录
node qinglong/xbk_push.js
```

该入口会持续运行，青龙中只应保持一个实例，不要再用其他定时任务重复启动。各渠道的环境变量名称请参考 `push_config.local.js.example`。

配置至少一个完整通知渠道后，可先运行环境检查：

```bash
node qinglong/xbk_push.js --check
```

`--check` 只检查 Node.js、依赖和配置，不会抓取或推送。

## 常用操作

### 查看运行状态

```bash
node qinglong/xbk_push.js --status
```

可查看最近运行、日报、通知渠道健康状态和过滤情况。它只读状态文件，不会抓取或推送。

### 试运行

```bash
node qinglong/xbk_push.js --dry-run
```

试运行会抓取并处理数据，但不会发送通知，也不会写入成功去重记录。

### 只运行一次

```bash
npm start
```

`npm start` 只执行一轮，适合手动测试；需要持续运行请使用上面的 `node qinglong/xbk_push.js`。

### 通知自检

```bash
node xbk_function_v3.js --notify-test
```

向全部已配置渠道各发一条固定测试消息（标题「xbk-push 通知自检」，正文含版本号、上海时间与主机名），改完 `push_config` 后不用等真实线报即可验证渠道通不通。发送成功（至少一个渠道送达）退出码 0，全失败/无渠道/超时退出码 1；失败原因已脱敏（不泄露密钥）。注意：

- `--notify-test` 只支持直跑入口 `node xbk_function_v3.js --notify-test`；**不要**经 `qinglong/xbk_push.js` 传该参数——它不在青龙入口白名单内，会被当作未知参数告警并进入常驻真实抓取模式。
- 与 `--dry-run` 互斥：同时传两个参数会报错拒绝（退出码 1）。
- 自检消息内容固定（不抓一言、不抓线报），不写缓存、不写运行日志。

### 调整轮询间隔

常驻入口默认每 10 秒检查一次。需要调整时设置毫秒数，例如每 30 秒检查一次：

```bash
XBK_INTERVAL_MS=30000 node qinglong/xbk_push.js
```

## 配置过滤规则

主要配置在 `xbk_function_v3.js` 顶部的 `Config` 中，常用部分如下：

```js
filter: {
  pingbifenlei: '美妆',       // 过滤分类
  pingbibiaoti: '京东|拼多多', // 过滤标题
  pingbilouzhu: '广告号',     // 过滤发布人
  pingbitime: '5'             // 时间范围
}
```

不需要的规则留空即可。修改配置后重新启动程序。

### 覆盖文件（v3.310，推荐用控制台改）

上面的 `Config.filter` 是**代码默认层**。运行时可被缓存目录里的覆盖文件 `<缓存目录>/filter-rules.json` 逐字段覆盖（默认 `<项目根>/xianbaoku_cache/filter-rules.json`，权限 0600，内容为 `schema:1` + `revision` + 11 个过滤字段的纯 JSON）：

- **缺字段 = 用代码默认**（不是置空）；显式写 `""` 才表示「这条规则明确清空」。文件不存在时完全按代码默认运行，不会自动生成。
- **每轮读一次**：`App.run` 在每轮开头读取并构造本轮局部的生效规则；正在跑的一轮不换规则，控制台触发的新进程或常驻的下一轮才生效。每轮写 `filter-rules.applied.json` 快照（revision/source/hash/appliedAt）供控制台显示「已生效」。
- **推荐走控制台「过滤规则」页**：保存时做四道校验（字段白名单/长度 → 行语法 → RE2 与嵌套量词 → 编译对账），非法规则直接 400 拒绝、不落盘；手改文件没有这层保护，写坏后按下面的降级处理。
- **损坏降级**：文件解析失败/不可读/超限时优先沿用进程内上一次合法规则，仅首次加载即坏才回退代码默认；降级轮**不清 `_f`、不推进 `filter.hash`**，所以不会把历史被过滤条目重评补推，也不会放宽规则，并在 `console.warn`、`run.log` WARN 与控制台红条三处告警。
- **回滚/恢复默认**：控制台保存前自动备份 `filter-rules.bak.<revision>.json`（保留最近 3 代），可回滚到任一备份，或恢复代码默认（写空覆盖文件 `filter:{}`，`revision+1`，**不删文件**——删文件会让 revision 归零、备份列表消失）。两者都以 `revision+1` 写入，审计链保持线性；回滚请求必须带页面加载时的 `baseRevision`（不一致返回 409 `revision_mismatch`，防止陈旧页面覆盖新版本）。审计在 `filter-rules.audit.ndjson`（append-only，只记动作/字段名/revision 与 hash，不记规则正文），并发写用 `filter-rules.lock` 串行化。

## 常用环境变量

| 变量 | 作用 |
|---|---|
| `XBK_INTERVAL_MS` | 抓取间隔，单位为毫秒，默认 `10000` |
| `XBK_DRY_RUN=1` | 对常驻和单轮入口都生效：不发送通知、不写入成功缓存；常驻入口持续运行，`npm start` 只执行一轮 |
| `XBK_CACHE_DIR` | 缓存目录覆盖（`--status`、控制台与常驻/单轮运行共用），必须是绝对路径，相对路径告警后忽略。已部署实例不要修改：`push.json` 判重主存随目录迁移、旧记录不自动搬家，会导致重复推送 |
| `XBK_CONSOLE_TOKEN` | 网页控制台访问令牌（≥16 字符；未设置则控制台拒绝启动） |
| `XBK_CONSOLE_PORT` | 网页控制台端口，默认 `7777`（设 `0` 则绑定随机可用端口；非 0–65535 整数拒绝启动） |
| `XBK_CONSOLE_HOST` | 网页控制台绑定地址，默认 `127.0.0.1` |
| `XBK_AUTO_INSTALL_DEPS=1` | 应急选项：青龙常驻入口运行时联网安装和构建缺失依赖；默认关闭，优先在部署阶段完成依赖初始化 |
| `PUSH_PLUS_TOKEN` | PushPlus Token，可代替本地配置 |
| `PUSH_KEY` | Server酱 Key，可代替本地配置 |
| `BARK_PUSH` | Bark 地址，可代替本地配置 |
| `TG_BOT_TOKEN` / `TG_USER_ID` | Telegram Bot 配置 |

更多通知渠道配置请直接参考 `push_config.local.js.example`。

## 常用命令

```bash
npm start                         # 启动程序
node qinglong/xbk_push.js --check # 检查环境
node qinglong/xbk_push.js --status # 查看状态
node qinglong/xbk_push.js --dry-run # 试运行
node xbk_function_v3.js --notify-test # 通知自检（真实发送一条测试消息到全部已配置渠道）
npm run lint                      # 检查代码格式
npm test                          # 运行测试
npm run console                   # 启动网页控制台（需先设置 XBK_CONSOLE_TOKEN）
```

青龙入口目前只支持 `--check`、`--status` 和 `--dry-run`。其他参数会被忽略并发出警告；不要把 `--help` 或拼写错误的参数当作安全检查命令。`--notify-test` 通知自检走直跑入口 `node xbk_function_v3.js --notify-test`（见「常用操作 → 通知自检」），不在此白名单内。

### 变异测试（超时治理）

变异测试只在 CI 跑（`.github/workflows/mutation.yml`，本机入口 fail-closed）。触发面只有三种：**main 上改动本工作流的 push、手动 dispatch、每日两次定时（UTC 16:17 主跑 / 04:17 补偿）**；不接 `pull_request`——PR 分支照常跑 `test.yml` 的完整门禁，变异本体不占评审时间。单次等待上限按段下发：`console-part1..9` 是 **60s**，其余 20 段 **300s**——取值写进矩阵的 `timeout_ms`，再由「变异测试」步骤用 CLI `--timeoutMS` 覆盖配置文件的 300000ms（只改等待上限，不进缓存身份，合并后不需要一次性全量重跑）。

- 段耗时的头号来源不是「变异体真的跑不动」，而是**测试进程收尾泄漏**：`test_console.js` 的 server 在 `listen` 时登记、`finally` 里统一收割，每条用例再挂一层看门狗——断言提前失败也不会留下监听句柄把事件循环钉住。否则进程打印完汇总照样不退出，tap-runner 只能等满上限才杀，一段白等几小时。
- `Timeout` 仍计入 detected（`分数` = (被杀 + 超时) / 全部变异体），**分数口径不变**；变的是「慢但通过」的变异体被判成超时的那部分，所以读分要与日报的 `真挂死` / `上限触发` 两列一起看。
- 段 job 的守卫（`scripts/mutation-guard.js`）在剥离 `statusReason` **之前**按前缀分类，把 `timeout-stats.json` 写到报告同目录并随 artifact 上传；日报据此分列 `超时上限` / `真挂死` / `上限触发`，第三类「其他超时」在 `超时` 格里注明，取证缺失显示 `—` 而不是 0。

## 网页控制台

在浏览器里查看运行状态、手动触发一轮抓取（可选试运行），适合不想敲命令的场景：

```bash
XBK_CONSOLE_TOKEN=请换成至少16位的随机字符串 npm run console
```

- 默认地址 `http://127.0.0.1:7777`。两种鉴权方式：命令行/API 用请求头 `Authorization: Bearer <XBK_CONSOLE_TOKEN>`；浏览器直接打开 `http://127.0.0.1:7777/?token=<XBK_CONSOLE_TOKEN>`（页面内的 fetch 请求通过 Authorization: Bearer 请求头携带 token，URL 不再复述凭证；看板每 5 秒自动刷新，任务运行期间加密到 2 秒）。token 未设置或短于 16 字符时服务直接拒绝启动。
- 前端资产按内容哈希做版本号（`?v=<sha8>`）：带版本的 URL 走 `immutable` 长缓存，裸 URL 仍 `no-cache` + ETag（命中 `If-None-Match` 返回 304）；并按 `Accept-Encoding` 提供 gzip（首屏 JS 77KB → 约 26KB）。页面 HTML 始终 `no-store`（含会话凭证）。
- 数据面（v3.363）：轮询仍是主通道（15s / 任务运行 2s），但 `GET /api/runs`、`/api/messages`、`/api/auto` 支持 `ETag` + `If-None-Match`——内容没变时服务端回 304 空体，前端复用内存里的上一份（`no-store`，连缓存存储都不允许；`/api/status` 因为带 `generatedAt`/锁龄，明确不发 ETag）。运行中日志的 SSE 帧带 `id:`，断线重连由浏览器回传 `Last-Event-ID`，服务端只补缺口（游标不可用时回 `event: reset` 整段替换）。最近一次成功的状态与历史另存 `localStorage`（按实例 id + 版本守卫、多标签页不倒退），冷启动/弱网先用它渲染首屏再被真实轮询覆盖，不含 token。
- 前端模块（v3.365 起分批拆）：`app.js` 是入口 + App 组件，常量在 `constants.js`、时间/字节格式化在 `format.js`、HTTP 端点与凭证（`BOOT`）在 `api.js`；全部浏览器原生 ESM，无打包步骤。新增模块必须同时登记 `STATIC_ASSETS`，否则闭包用例直接红。
- 加载兜底（v3.364）：前端是浏览器原生 ES module，任一分片 404/401 都会让模块图崩掉、整页白屏且没有任何提示。兜底内容由服务端直接渲染进 `#app`（`div.boot-fallback`），CSS 延迟 5 秒显形、挂载成功后删除——它不依赖任何 JS 或资产，所以「连兜底脚本都取不到」的死角也能看见提示。新增分片必须同时登记 `STATIC_ASSETS`——测试会用 acorn 解析每个模块的 import 逐条对账。
- 动效层（v3.360，v3.361 起弹窗从触发点展开/缩回）：切页淡入、卡片/表格行/表单分组依次入场、弹窗从触发按钮的位置等比放大到原位（取消/点遮罩/Esc 沿原路缩回按钮后再卸载，退场期间按钮禁用）、校验失败字段抖动+红圈、推送记录翻页/增删的位置补间（FLIP）、主题切换颜色过渡。只动 `opacity`/`transform`（合成层，不触发重排），动画结束即清内联样式；入场只在挂载/首次拿到数据/真正切页时播一次，5 秒轮询不重播。系统开了「减少动效」（`prefers-reduced-motion: reduce`）时全部关闭、直接到终态。动画库是 vendored 单文件（motion/mini，MIT），走 `/assets` 白名单，无 CDN。
- ⚠️ `?token=` 会留在浏览器历史与访问日志里；`XBK_CONSOLE_HOST` 绑定非回环地址时 token 以明文过网（HTTP 无加密），请仅在受信内网使用，跨网访问务必前置 TLS 反代（nginx/caddy 终止 TLS 后转发本端口）。
- 「试运行」抓取但不推送、不写去重记录（等价 `--dry-run`）；「正式运行一轮」会**真实推送通知**；「通知自检」向全部已配置渠道各发一条固定测试消息（真实推送，`POST /api/notify-test`，无 body）。同一时刻只允许一个触发任务，重复触发返回 409；锁残留（进程被 kill -9 等留下损坏锁文件）时人工删除缓存目录下的 `console-trigger.lock` 即可恢复。
- 「自动正式运行」：在手动触发区把间隔调到 3–20 秒（数字框 + 加减 + 保存），点「开始」并二次确认后按「上一轮结束后等待 N 秒」循环正式运行。调度在**控制台服务器进程内**，关闭页面、切后台、锁屏都不影响，只有点「停止」或连续失败 3 次才停；控制台重启后若仍处于开启状态会恢复。独立动作 `run-auto` 共用同一把单飞锁，不会与手动/自动轮次叠跑；间隔与开关落盘到缓存目录 `console-auto.json`，运行轮数/错误只存内存。
- 触发有**幂等重放窗**：同一动作在窗口内的重复提交返回 409（响应带首轮 runId，`replayBlocked: true`），防止「提交成功但响应丢失 → 重试 → 再跑一轮真实推送」的重复推送；跨动作不受影响，确需重跑同一动作请等窗口过后再触发。通知自检的重复提交拦截窗默认 60 秒，可在「系统」页的设置块里 0–3600 秒内调整（0 = 关闭拦截，立即生效），同一处还能关掉顶栏时间的年月日（只显示 时:分:秒），普通动作的重放窗为 60 秒；自动调度由服务器内部直接触发，不经 HTTP 重放窗，轮间互斥由单飞锁保证。
- 浏览器会话：以 `?token=` 打开看板成功后服务端下发 `xbk_session` Cookie（HttpOnly、SameSite=Lax、有效期 1 天，过期后重新打开 `?token=` 链接即续期），此后同源请求（含 ESM/静态资产）自动携带，`/assets/*` 无凭证返回 401。`XBK_CONSOLE_TOKEN` 仅允许可见 ASCII 字符（长度 16–200，禁空格与 `; , " \\ & # + %`）——含这些字符时服务拒绝启动（它们会让 raw URL 打开、Cookie 传输或 URL 解码失配，浏览器端必然失败）。
- 两步验证（v3.357）：系统页「两步验证」可开启 Google Authenticator。开启时显示二维码（也可手动输入密钥，账户名 `xbk-push`），确认 6 位码后下发 10 个一次性恢复码；之后打开控制台要先过访问令牌、再输手机上的 6 位数字（或恢复码），验证通过才发 12 小时 `xbk_2fa` Cookie。配置存 `<stateDir>/console-2fa.json`（0600，损坏时控制台拒启）；恢复码只存哈希、只显示一次。**本版只保护浏览器打开页面，接口仍用访问令牌**；登录失败按来源 IP 限速。控制台按**单实例**部署（systemd 先停旧再起新），2FA 配置在进程启动时加载；不要把启用 2FA 的实例和旧版本实例同时挂在负载均衡后面。
- ⚠️ 已知边界：控制台触发锁只约束「控制台触发的任务」，不感知青龙定时任务/常驻进程——定时任务正在推送时再从控制台触发一轮，可能出现重复推送。避免在定时任务运行窗口内手动触发。
- 只读部分与 `--status` 同源：日报计数、最近一轮、通道健康、过滤诊断（缓存目录解析逻辑与 `--status` 完全一致）。
- 页面顶部标签页：**概览**（近 N 日运行趋势（14/30/60 天可切换）+ 缓存健康 + 状态卡片 + 手动触发/自动正式运行 + 触发历史）、**推送记录**（判重缓存 `push.json` 的已推送消息：关键词搜索、分类筛选、分页浏览，点标题展开正文）、**运行日志**（`run.log` 尾部 1 MiB 在线查看，任务运行中自动跟随）、**配置**（运行配置脱敏视图：推送模式/上限/开关/过滤规则的实际生效值——覆盖文件优先、文件里显式提供的字段带「覆盖」徽章，推送渠道只显示「已配置/未配置」——**所有推送密钥的值永不出现在页面或接口响应中**）、**系统**（版本、Node、进程内存、运行时长、缓存目录 + 缓存目录文件清单：大小/类型/异常符号链接提示）、**过滤规则**（v3.310：过滤规则覆盖文件的编辑面，见下条）。推送记录/日志/配置/系统为只读视图，进页加载 + 手动刷新，不自动轮询。
- v3.307 运维工作台：概览首屏四卡回答「今日 / 近 7 天 / 最近一轮 / 通道与过滤」，有失败时顶部红色横幅可一键跳到带日期与异常筛选的日志；「正式运行一轮」「通知自检」触发前二次确认并列出真实推送渠道；运行日志按 全部/异常/错误/告警/摘要/控制台 分级（异常与错误默认排除控制台停止记录）；逐轮历史默认「仅运行」隐藏取消留痕，可切「全部 / 只看异常」，支持按日期筛选与页码；推送记录与导出生效「今天 / 近 3/7/30 天」时间窗；页签写 hash（刷新/后退不丢）、标题带状态点、自动刷新可暂停。
- v3.310「过滤规则」页：按判定顺序分组（时间 → 分类 → 楼主 → 标题 → 内容）编辑覆盖文件，`zhanxian*` 标注「保护（命中即保留）」、`pingbitime` 标注「屏蔽注册不足 N 天」；顶部显示来源（代码默认 / 覆盖文件 rN / 损坏降级）、已生效 revision 与时间、未保存修改。保存前先回放最近 N 条给出「将重评 N 条历史被过滤记录（超过 5000 条显示 ≥5000），后续每轮最多补推 `Config.push.maxPerRun`（默认 100）条」；`.*` 全命中与「覆盖损坏文件」需二次确认；revision 冲突返回 409 并提示重新加载合并。写操作只认 `Authorization: Bearer`（仅 Cookie 或 URL 里的 token 会被拒），保存后下一轮生效，可回滚备份或恢复代码默认。
- 只读 API 一览（均需鉴权，与页面同一 token）：`/api/status`、`/api/messages`、`/api/trends`（可选 `?days=14|30|60`）、`/api/logs`、`/api/run-history`（逐轮运行历史，可选 `?limit=&before=` 分页）、`/api/cache-health`（判重缓存字节占用与两级上限、临近裁剪预警、墓碑计数）、`/api/files`（状态目录文件清单）、`/api/config`（脱敏配置视图）、`/api/sys`。写操作 API：`/trigger`（手动触发）、`/api/notify-test`（通知自检，真实推送一条测试消息）、`/api/runs/cancel`（停止运行中的触发任务）、`/api/config/filter`（保存过滤规则，仅 Bearer）、`/api/config/filter/validate`（预检）、`/api/config/filter/preview`（回放补推数）、`/api/config/filter/restore`（回滚/恢复默认，仅 Bearer）。过滤规则读面：`GET /api/config/filter`（来源/revision/合并后的生效规则/`override`＝覆盖文件里实际存在的字段原文/已生效快照/审计链状态）。其他：`GET /api/runs/stream?id=&since=`（运行中任务输出的 SSE 实时流：每进程连接上限 8、单连接待发积压上限 1MiB 超限断开、15s 心跳、任务完结或被淘汰时服务端收尾关流；`/api/messages/export` 按分类导出 CSV/JSON）、`GET /api/access-log`（最近 200 条访问日志 + 未授权计数，仅本进程内存、重启即空）。
- 触发历史仅保存在控制台进程内存（最多 20 条，重启即空）；持久记录仍以缓存目录的状态文件与 `run.log` 为准（概览页「逐轮运行历史」直接解析 run.log 摘要行，取尾窗最近 200 轮，默认「仅运行」隐藏取消留痕，支持「全部 / 只看异常」与日期筛选、页码跳转、行尾「日志」直达；run.log 超 1 MiB 后更早轮次已物理轮转，`truncated` 如实标注）。控制台停止时会终止由它拉起的子进程。
- 触发历史里运行中的任务可点**「停止」**：控制台对子进程先 SIGTERM、3 秒宽限后 SIGKILL。两个如实披露：①被停止的任务若已推送部分通知但尚未写缓存，这些条目**下轮会重推**（与任务超时被杀的语义一致）；②取消后同一动作的重放冷却窗照常生效（普通动作 60 秒）——这是防止「手滑停止后误触重推」的保护，确需立即重跑请等窗口过后再触发。自动运行不接受 HTTP 触发，没有外部冷却窗。
- 相关变量：`XBK_CONSOLE_PORT`（默认 `7777`）、`XBK_CONSOLE_HOST`（默认 `127.0.0.1`，对外暴露需显式修改并自行做好访问控制）。

## 常见问题

### 提示 `Cannot find module 're2'` 或原生模块加载失败

确认 Node.js 版本满足要求，然后执行（不要改用会自动执行生命周期脚本的裸 `npm ci`）：

```bash
npm ci --ignore-scripts
npm rebuild re2
```

`npm rebuild re2` 会先尝试 re2 官方校验预编译包，失败时才源码构建；若走到源码构建 fallback，系统需要 Python 与 C/C++ 工具链。网络可用只解决预编译包下载，不能替代源码构建所需工具链。

### 没有收到通知

按顺序检查：

1. `push_config.local.js` 是否填写正确；
2. 是否至少配置了一个完整的通知渠道；
3. 运行 `node qinglong/xbk_push.js --check` 检查依赖；
4. 查看实际运行缓存目录中的 `run.log`：缓存目录由 `Config.cache.dir` 决定（默认 `<项目根>/xianbaoku_cache`，必须位于项目根内；绝对路径、`..` 或符号链接越出项目根时会回退到默认或安全目录）。`XBK_CACHE_DIR`（必须是绝对路径，相对路径告警后忽略）会覆盖 `Config.cache.dir`，并同时决定 `--status`、控制台与常驻/单轮运行（含 `run.log`、`report.state`、`push.json`）使用的目录——读取位置与写入位置因此永远一致。**已部署实例不要修改它**：`push.json` 是判重主存，改目录不会迁移旧记录，下一轮会把已推送条目当新条目重推；确需迁移时请连同目录内文件一起搬。运行 `--status` 时它会打印实际读取目录；若未设置该变量且自定义了 `Config.cache.dir`，请把该根内绝对路径通过 `XBK_CACHE_DIR` 传给 `--status` 与控制台；若设置了绝对 `XBK_CACHE_DIR`，以输出中的该路径为准；

5. 用 `--dry-run` 确认抓取和过滤是否正常。

### 重复推送或不推送

程序使用 `xianbaoku_cache/` 保存去重记录。不要在多个相互独立的实例之间共用同一个缓存目录；如果缓存损坏，先备份该目录，再根据日志处理。

## 安全提醒

- 不要把 `push_config.local.js`、Token、Bot 密钥提交到 Git。
- 不要把包含密钥的日志或配置截图发到公开地方。
- 使用 `--dry-run` 调整规则，可以避免误发通知。

## 相关文件

- `push_config.local.js.example`：通知渠道配置模板
- `xbk_function_v3.js`：主要配置和运行逻辑
- `qinglong/xbk_push.js`：青龙入口
- `SYSTEM_CONTRACT.md`：更完整的行为说明
- `CHANGELOG.md`：版本记录
- `SECURITY.md`：安全问题报告说明
