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

入口为常驻模式；只运行一个实例。`XBK_INTERVAL_MS` 可设置轮询间隔。只需执行一次时用 `npm start`。

可重试错误（网络/超时/上游 5xx/限流等）不会退出常驻，按指数退避持续重试，默认 30 分钟封顶（`XBK_RETRY_BACKOFF_CAP_MS` 毫秒可调），恢复后自动回到正常轮询；仅不可恢复错误（如配置错误、认证失败）才会停止。

`re2` 缺失时入口会退出，避免过滤规则失效后继续推送。

## 配置

主配置在 `xbk_function_v3.js` 顶部；本地密钥在 `push_config.local.js`。支持 Push+、Server酱、Bark、企业微信、WxPusher、息知、PushDeer、Telegram 等通道。

常用通知环境变量：`PUSH_PLUS_TOKEN`、`PUSH_KEY`、`BARK_PUSH`、`QYWX_KEY`、`WX_PUSHER_APP_TOKEN`、`WX_PUSHER_TOPIC_IDS`、`WX_XIZHI_KEY`、`DEER_KEY`、`PUSHME_KEY`、`TG_BOT_TOKEN`、`TG_USER_ID`。

常用过滤配置：

```js
filter: {
  pingbifenlei: '美妆',
  pingbibiaoti: '京东|拼多多',
  pingbilouzhu: '广告号',
  pingbitime: '5'
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
