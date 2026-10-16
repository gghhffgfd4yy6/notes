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

## 常用环境变量

| 变量 | 作用 |
|---|---|
| `XBK_INTERVAL_MS` | 抓取间隔，单位为毫秒，默认 `10000` |
| `XBK_DRY_RUN=1` | 对常驻和单轮入口都生效：不发送通知、不写入成功缓存；常驻入口持续运行，`npm start` 只执行一轮 |
| `XBK_CACHE_DIR` | `--status` 使用的状态目录，必须是绝对路径 |
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

## 网页控制台

在浏览器里查看运行状态、手动触发一轮抓取（可选试运行），适合不想敲命令的场景：

```bash
XBK_CONSOLE_TOKEN=请换成至少16位的随机字符串 npm run console
```

- 默认地址 `http://127.0.0.1:7777`。两种鉴权方式：命令行/API 用请求头 `Authorization: Bearer <XBK_CONSOLE_TOKEN>`；浏览器直接打开 `http://127.0.0.1:7777/?token=<XBK_CONSOLE_TOKEN>`（页面内的 fetch 请求通过 Authorization: Bearer 请求头携带 token，URL 不再复述凭证；看板每 5 秒自动刷新，任务运行期间加密到 2 秒）。token 未设置或短于 16 字符时服务直接拒绝启动。
- ⚠️ `?token=` 会留在浏览器历史与访问日志里；`XBK_CONSOLE_HOST` 绑定非回环地址时 token 以明文过网（HTTP 无加密），请仅在受信内网使用，跨网访问务必前置 TLS 反代（nginx/caddy 终止 TLS 后转发本端口）。
- 「试运行」抓取但不推送、不写去重记录（等价 `--dry-run`）；「正式运行一轮」会**真实推送通知**；「通知自检」向全部已配置渠道各发一条固定测试消息（真实推送，`POST /api/notify-test`，无 body）。同一时刻只允许一个触发任务，重复触发返回 409；锁残留（进程被 kill -9 等留下损坏锁文件）时人工删除缓存目录下的 `console-trigger.lock` 即可恢复。
- 触发有**幂等重放窗**：同一动作在窗口内的重复提交返回 409（响应带首轮 runId，`replayBlocked: true`），防止「提交成功但响应丢失 → 重试 → 再跑一轮真实推送」的重复推送；跨动作不受影响，确需重跑同一动作请等窗口过后再触发。通知自检的重放窗为 60 秒（高频调试动作防连点），其余动作为 12 分钟。
- 浏览器会话：以 `?token=` 打开看板成功后服务端下发 `xbk_session` Cookie（HttpOnly、SameSite=Strict、有效期 1 天，过期后重新打开 `?token=` 链接即续期），此后同源请求（含 ESM/静态资产）自动携带，`/assets/*` 无凭证返回 401。`XBK_CONSOLE_TOKEN` 仅允许可见 ASCII 字符（长度 16–200，禁空格与 `; , " \\ & # + %`）——含这些字符时服务拒绝启动（它们会让 raw URL 打开、Cookie 传输或 URL 解码失配，浏览器端必然失败）。
- ⚠️ 已知边界：控制台触发锁只约束「控制台触发的任务」，不感知青龙定时任务/常驻进程——定时任务正在推送时再从控制台触发一轮，可能出现重复推送。避免在定时任务运行窗口内手动触发。
- 只读部分与 `--status` 同源：日报计数、最近一轮、通道健康、过滤诊断（缓存目录解析逻辑与 `--status` 完全一致）。
- 页面顶部标签页：**概览**（近 N 日运行趋势（14/30/60 天可切换）+ 缓存健康 + 状态卡片 + 手动触发 + 触发历史）、**推送记录**（判重缓存 `push.json` 的已推送消息：关键词搜索、分类筛选、分页浏览，点标题展开正文）、**运行日志**（`run.log` 尾部 1 MiB 在线查看，任务运行中自动跟随）、**配置**（运行配置脱敏视图：推送模式/上限/开关/过滤规则原值展示，推送渠道只显示「已配置/未配置」——**所有推送密钥的值永不出现在页面或接口响应中**）、**系统**（版本、Node、进程内存、运行时长、缓存目录 + 缓存目录文件清单：大小/类型/异常符号链接提示）。推送记录/日志/配置/系统为只读视图，进页加载 + 手动刷新，不自动轮询。
- 只读 API 一览（均需鉴权，与页面同一 token）：`/api/status`、`/api/messages`、`/api/trends`（可选 `?days=14|30|60`）、`/api/logs`、`/api/run-history`（逐轮运行历史，可选 `?limit=&before=` 分页）、`/api/cache-health`（判重缓存字节占用与两级上限、临近裁剪预警、墓碑计数）、`/api/files`（状态目录文件清单）、`/api/config`（脱敏配置视图）、`/api/sys`。写操作 API：`/trigger`（手动触发）、`/api/notify-test`（通知自检，真实推送一条测试消息）、`/api/runs/cancel`（停止运行中的触发任务）。其他：`GET /api/runs/stream?id=&since=`（运行中任务输出的 SSE 实时流：每进程连接上限 8、单连接待发积压上限 1MiB 超限断开、15s 心跳、任务完结或被淘汰时服务端收尾关流；`/api/messages/export` 按分类导出 CSV/JSON）、`GET /api/access-log`（最近 200 条访问日志 + 未授权计数，仅本进程内存、重启即空）。
- 触发历史仅保存在控制台进程内存（最多 20 条，重启即空）；持久记录仍以缓存目录的状态文件与 `run.log` 为准（概览页「逐轮运行历史」面板直接解析 run.log 摘要行，支持「加载更早轮次」；run.log 超 1 MiB 后更早轮次已物理轮转，`truncated` 如实标注）。控制台停止时会终止由它拉起的子进程。
- 触发历史里运行中的任务可点**「停止」**：控制台对子进程先 SIGTERM、3 秒宽限后 SIGKILL。两个如实披露：①被停止的任务若已推送部分通知但尚未写缓存，这些条目**下轮会重推**（与任务超时被杀的语义一致）；②取消后同一动作的重放冷却窗（12 分钟）照常生效——这是防止「手滑停止后误触重推」的保护，确需立即重跑请等窗口过后再触发。
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
4. 查看实际运行缓存目录中的 `run.log`：常驻/单轮运行的目录由 `Config.cache.dir` 决定，必须位于项目根内；绝对路径、`..` 或符号链接越出项目根时会回退到默认或安全目录。`XBK_CACHE_DIR` **只影响 `--status` 读取的目录**，不会改变常驻/单轮运行或 `run.log` 的写入位置。运行 `--status` 时它会打印实际读取目录；若未设置该变量且自定义了 `Config.cache.dir`，请把该根内绝对路径通过 `XBK_CACHE_DIR` 传给 `--status`；若设置了绝对 `XBK_CACHE_DIR`，以输出中的该路径为准；

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
