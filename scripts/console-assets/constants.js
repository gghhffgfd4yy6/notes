// scripts/console-assets/constants.js —— 页面级常量（v3.365，拆自 app.js 顶部）。
// 零依赖、零顶层副作用：只导出数字/字符串，Node 测试可直接 import 取值做行为断言。

// 轮询间隔：5s → 15s。三个接口每拍约 16KB（/api/messages 14.4KB + 状态 + 历史），
// 5s 一轮就是 ~11MB/小时——控制台常驻开着也看不完这么新的数据。手动刷新、下拉刷新、
// 切回前台都不受这个间隔约束（走一次性补拉）；任务在跑时仍用 POLL_BUSY_MS 快轮询。
const POLL_MS = 15000
const POLL_BUSY_MS = 2000
// 部署后旧标签页仍跑旧脚本（数据照常轮询，看起来「在线」却看不到新 UI）。每 60s 对一次
// /api/sys 的版本，不一致就挂一条「刷新后生效」的提示——不自动 reload，避免打断正在填的表单。
// 边界（Sourcery #294）：只覆盖本版之后打开的页面。部署那一刻已经开着的旧页拿不到这段代码，
// 服务端也无法给旧页注入逻辑——那些页仍需手动刷一次；此后每次部署都有提示。
const VERSION_CHECK_MS = 60000
// 提交成功后按钮锁定的最长兜底时长（Sourcery vwU/vv2：轮询竞态/请求挂起时不能永久锁死；
// 上限 = 服务端 PROC_TIMEOUT_MS(10min) + 提交往返余量，取 11 分钟）。
const BUSY_FALLBACK_MS = 11 * 60 * 1000
// fetch 请求期限（Sourcery G_n6）：挂起连接不得阻塞刷新链路；超时由 AbortController 取消，
// 走正常 reject 路径（「刷新失败」可见），不会堆积请求。
const FETCH_TIMEOUT_MS = 8000
// 备份是「整包上传/下载」，不能套 8 秒的普通 API 期限：慢网络下大文件会被误判失败。
const BACKUP_FETCH_TIMEOUT_MS = 120000
// 通知自检重复提交拦截窗的客户端边界（与 console.js NOTIFY_REPLAY_MIN_S/MAX_S 同口径）：
// 这层只负责「非法值不发请求」，服务端仍是唯一权威（越界/类型错一律 400）。
const NOTIFY_WINDOW_MIN_S = 0
const NOTIFY_WINDOW_MAX_S = 3600
const NOTIFY_WINDOW_DEFAULT_S = 60

// 控制台里所有时间都按北京时间（Asia/Shanghai，固定 UTC+8）显示，不跟浏览器时区走。
// 服务器时区是 UTC，推送列表里的时间也是 CST 文本；顶栏「数据截至」此前用浏览器本地时区，
// UTC 客户端会在同一屏上看到两个钟（列表 22:41 / 顶栏 14:41），像数据停在 8 小时前。
// 上海无夏令时，固定 +8 即可。时区只在顶栏标一次（TZ_LABEL）：全屏同钟，标一处就够。
const TZ_LABEL = '北京时间'

// 浏览器端加密要同时持有明文、密文和 base64 三份数据；服务端明文上限 256MiB 不代表手机扛得住。
// 这里给浏览器导出设 32MiB 明文上限（密文约 43MiB），选文件上限 48MiB。
// 明文备份仍会被服务端 256MiB 闸拦住，不会因为前端放宽就写坏缓存。
const BACKUP_BROWSER_MAX_BYTES = 32 * 1024 * 1024
const BACKUP_FILE_MAX_BYTES = 48 * 1024 * 1024

export { POLL_MS, POLL_BUSY_MS, VERSION_CHECK_MS, BUSY_FALLBACK_MS, FETCH_TIMEOUT_MS, BACKUP_FETCH_TIMEOUT_MS, BACKUP_BROWSER_MAX_BYTES, BACKUP_FILE_MAX_BYTES, NOTIFY_WINDOW_MIN_S, NOTIFY_WINDOW_MAX_S, NOTIFY_WINDOW_DEFAULT_S, TZ_LABEL }
