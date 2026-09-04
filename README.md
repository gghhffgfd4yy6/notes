# xbk-push

个人青龙单实例的线报抓取、过滤、去重与多通道推送脚本。

## 安装与运行

```bash
npm install --ignore-scripts
npm run rebuild --prefix node_modules/re2
node -e "const RE2=require('re2'); if (!new RE2('^ok$').test('ok')) process.exit(1)"
cp push_config.local.js.example push_config.local.js
npm start
```

`push_config.local.js` 含密钥，不能提交。可用环境变量覆盖配置。

## 青龙

先安装生产依赖并构建 `re2`：

```bash
npm ci --omit=dev --ignore-scripts
npm run rebuild --prefix node_modules/re2
node qinglong/xbk_push.js
```

启动前可只做环境诊断，不抓取也不推送：

```bash
node qinglong/xbk_push.js --check
```

调整过滤规则时可运行抓取和处理流程但不调用通知接口，也不写成功缓存：

```bash
node qinglong/xbk_push.js --dry-run
```

入口为常驻模式；只运行一个实例。`XBK_INTERVAL_MS` 可设置轮询间隔。只需执行一次时用 `npm start`。

可重试错误（网络/超时/上游 5xx/限流等）不会退出常驻，按指数退避持续重试，默认 30 分钟封顶（`XBK_RETRY_BACKOFF_CAP_MS` 毫秒可调），恢复后自动回到正常轮询；仅不可恢复错误（如配置错误、认证失败）才会停止。

`re2` 缺失时入口会退出，避免过滤规则失效后继续推送。

## 配置

主配置在 `xbk_function_v3.js` 顶部；本地密钥在 `push_config.local.js`。支持 Push+、Server酱、Bark、企业微信、WxPusher、息知、PushDeer、Telegram 等通道。

常用通知环境变量：`PUSH_PLUS_TOKEN`、`PUSH_KEY`、`BARK_PUSH`、`QYWX_KEY`、`WX_PUSHER_APP_TOKEN`、`WX_PUSHER_TOPIC_IDS`、`WX_XIZHI_KEY`、`DEER_KEY`、`PUSHME_KEY`、`TG_BOT_TOKEN`、`TG_USER_ID`。

### 运行日报与通道健康

默认日报会在跨天后的下一轮发送，包含运行轮数、获取、去重、过滤、待推送、成功和失败统计。`Config.report.enabled = false` 可关闭日报。

`Config.channelHealth` 默认开启：某个已配置通道连续失败 3 次时发一次异常提醒，恢复后发一次恢复提醒；同一通道异常默认限频 1 小时。健康状态写入 `channel-health.state`；告警本身不计入健康统计，且健康监测/告警失败绝不影响线报推送、成功缓存或重试语义。

```js
channelHealth: {
  enabled: true,
  consecutiveFailures: 3,
  intervalMs: 3600000
}
```

常用过滤配置：

```js
filter: {
  pingbifenlei: '美妆',
  pingbibiaoti: '京东|拼多多',
  pingbilouzhu: '广告号',
  pingbitime: '5'
}
```

## 过滤诊断日志

默认会在缓存目录（默认 `xianbaoku_cache/`）追加 `filter-diagnostics.ndjson`。它是“一行一条 JSON”的多轮诊断日志：每次运行写一条 `type: "run"` 汇总，以及被过滤或被强制展现保护的条目明细，可用于查询每条为何屏蔽、命中了哪项配置及哪些后续规则被跳过。

默认最多记录每轮 100 条明细，并在日志超过 1 MiB 时自动保留最新尾部。可在 `xbk_function_v3.js` 的 `diagnostics.filterLog` 中调整：

```js
diagnostics: {
  filterLog: {
    enabled: true,
    maxDetailsPerRun: 100,
    includePassed: false // true 时连普通放行条目也写入
  }
}
```

## 测试

```bash
npm test
npm run test:filter
npm run test:app
npm run test:notify
npm run test:mutation
```

## 维护

- 行为约束：[`SYSTEM_CONTRACT.md`](SYSTEM_CONTRACT.md)
- 版本历史：[`CHANGELOG.md`](CHANGELOG.md)
- 安全报告：[`SECURITY.md`](SECURITY.md)
- 代码修改规则：[`AGENTS.md`](AGENTS.md)
