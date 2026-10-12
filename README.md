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
npm run lint                      # 检查代码格式
npm test                          # 运行测试
```

青龙入口目前只支持 `--check`、`--status` 和 `--dry-run`。其他参数会被忽略并发出警告；不要把 `--help` 或拼写错误的参数当作安全检查命令。

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
