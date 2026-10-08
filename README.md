# xbk-push

青龙线报抓取与推送工具：自动获取线报，按规则过滤、去重，再推送到你选择的通知渠道。

## 快速开始

### 1. 安装依赖

需要 **Node.js 22.22.2 及以上**。

```bash
npm ci
```

如果安装后提示 `re2` 无法加载，再执行：

```bash
npm rebuild re2
```

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
npm start
```

程序会持续运行并按默认间隔抓取、过滤和推送。

## 青龙使用

在青龙中创建一个 Node.js 脚本任务，进入项目目录后执行：

```bash
npm ci --omit=dev
npm rebuild re2
node qinglong/xbk_push.js
```

建议先检查环境：

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

### 调整轮询间隔

默认每 10 秒检查一次。需要调整时设置毫秒数，例如每 30 秒检查一次：

```bash
XBK_INTERVAL_MS=30000 npm start
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
| `XBK_DRY_RUN=1` | 常驻运行但不发送通知、不写入成功缓存 |
| `XBK_CACHE_DIR` | `--status` 使用的状态目录，必须是绝对路径 |
| `XBK_AUTO_INSTALL_DEPS=1` | 青龙入口缺少依赖时尝试自动安装和构建 |
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

## 常见问题

### 提示 `Cannot find module 're2'` 或原生模块加载失败

确认 Node.js 版本满足要求，然后执行：

```bash
npm rebuild re2
```

如果仍然失败，检查系统是否有编译工具，或在网络正常的环境重新执行 `npm ci`。

### 没有收到通知

按顺序检查：

1. `push_config.local.js` 是否填写正确；
2. 是否至少配置了一个完整的通知渠道；
3. 运行 `node qinglong/xbk_push.js --check` 检查依赖；
4. 查看 `xianbaoku_cache/run.log`；
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
