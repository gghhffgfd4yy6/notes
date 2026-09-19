# xbk-push

个人青龙单实例的线报抓取、过滤、去重与多通道推送脚本。

## 安装与运行

要求 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`（`re2` 原生模块的 `engines` 要求；`package.json` 的 `engines.node` 写 `>=22.22.2`，青龙入口 `--check` 的 Node 闸门按该下界完整比较——两段/三段版本都按数值比，低于下界即判红；常驻入口不硬拒启动，只在低于下界时告警；测试前置的依赖预检 `scripts/check-deps.js` 同时校验仓库与 `re2` 两处 `engines`。Node 23.x、24.0–24.14、25.x 不在 re2 支持范围内，安装或重建原生模块会失败）。

```bash
npm install --ignore-scripts
npm run hooks:install
npm run rebuild --prefix node_modules/re2
node -e 'const RE2=require("re2"); if (!(new RE2("^ok$")).test("ok")) process.exit(1)'
cp push_config.local.js.example push_config.local.js
npm start
```

上面的 `node -e` 校验命令用单引号包裹：交互式 bash 会对双引号里的 `!new` 做历史展开（`bash: !new: event not found`）。

`npm run rebuild --prefix node_modules/re2` 走 node-gyp 源码构建，需要 python3 与 C/C++ 工具链；容器里缺工具链时改用 `npm rebuild re2`——它执行 re2 官方 install 脚本，优先使用带 SHA-256 校验的预编译包（与 CI 同路径），失败才回退源码构建。

`npm run hooks:install` 会把 `core.hooksPath` 指向 `.githooks`：`pre-commit` 跑 lint / 版本闸门 / 变异行段校验（约 20s），`pre-push` 跑 `npm run test:filter`（约 60s，推送前拦截）——门禁针对**被推提交的内容**：`local_sha == HEAD` 且整棵工作树干净（含未跟踪文件；被 ignore 的不算）时在当前工作树跑（此时两者内容一致），否则在临时 worktree 里检出那个提交再跑、跑完清理，隔离环境建不起来就 fail-closed（不会拿工作树结果冒充被推提交），`commit-msg` 要求首行以 `fix: feat: refactor: docs: chore: style: test: perf: revert: build: ci:` 之一开头且不超过 100 字符。npm 不会自动注册仓库钩子，需在安装后显式执行一次；若你已配置过其它 `core.hooksPath`，该脚本不会覆盖。钩子文件必须可执行：noexec 挂载或无执行位的检出会以非零码拒绝安装并提示。**装完请用 `npm run hooks:verify` 自检门禁是否真的生效**（只读：生效 exit 0，未生效 exit 1 并说明是配置缺失、钩子文件缺失还是无执行位）——`hooks:install` 对「跳过/不覆盖」场景按设计仍 exit 0，不能当作「装好了」的证据。

`push_config.local.js` 含密钥，已被 `.gitignore` 忽略。**通知通道**配置可用环境变量覆盖（见「配置」）；主配置（过滤、日报、通道健康、缓存目录等）不支持环境变量覆盖，需直接改 `xbk_function_v3.js`。

## 青龙

先安装生产依赖并构建 `re2`：

```bash
npm ci --omit=dev --ignore-scripts
npm run rebuild --prefix node_modules/re2
node qinglong/xbk_push.js
```

启动前可只做环境诊断，不抓取也不推送（会创建缓存目录）：

```bash
node qinglong/xbk_push.js --check
```

查看最近运行、日报、通道健康和过滤诊断的只读汇总：

```bash
node qinglong/xbk_push.js --status
```

`--status` 默认读取项目根目录下的 `xianbaoku_cache/`（与当前工作目录无关），并与生产共用同一套根内解析与多级回退（默认目录不可用时落到 `.xbk_cache_safe`）；**未采纳 `XBK_CACHE_DIR` 覆盖时首行打印生效缓存目录**（并提示 `--status` 未使用该覆盖），采纳绝对路径覆盖后不再打印该行（此时首行即状态标题）。四个状态文件都缺失时同样返回 0、只报「缺失」。若状态文件写在别处，可用**绝对路径**覆盖：

```bash
XBK_CACHE_DIR=/path/to/cache node qinglong/xbk_push.js --status
```

相对路径会被忽略。`XBK_CACHE_DIR` 只影响 `--status`；常驻/单轮运行的缓存目录由 `Config.cache.dir` 决定，且必须位于项目根内（绝对路径、`..` 或符号链接逃逸会被拒绝并回退默认目录）。`--status` 刻意不加载应用配置（缺 `got`/`re2` 时仍要可用），因此把 `Config.cache.dir` 改成根内其它目录后，需用 `XBK_CACHE_DIR` 指向该绝对路径才能读到同一目录。

`--status` 只读取缓存目录中的状态文件，不加载推送依赖、不抓取、不推送、不修复或写入任何文件。输出含日报的「待推送（截断）」及最近一轮的「截断」「耗时」字段；`report.state` 缺字段按「未累计」处理（不整表判 invalid）。

调整过滤规则时可运行抓取和处理流程但不调用通知接口，也不写成功缓存：

```bash
node qinglong/xbk_push.js --dry-run
```

青龙入口下同样要求 `got`/`re2` 就绪；dry-run 仍会写 `run.log` 与过滤诊断日志，只是不写成功缓存、不发通知。`--dry-run` 是**一次性**执行：跑完一轮即退出（退出码 0 表示该轮成功、1 表示该轮失败），不进入常驻循环；需要「常驻但不推送」时改用环境变量 `XBK_DRY_RUN=1`（不带 `--dry-run` 参数），主模块也认该变量，可绕过青龙入口直接生效。

入口为常驻模式；只运行一个实例。`XBK_INTERVAL_MS` 可设置轮询间隔（毫秒，默认 10000，非法值回退 10000，`0` 表示不等待）。只需执行一次时用 `npm start`。

可重试错误（网络/超时/上游 5xx/限流等）不会退出常驻，按指数退避持续重试，默认 30 分钟封顶（`XBK_RETRY_BACKOFF_CAP_MS` 毫秒可调，默认 1800000，小于 1 视为无效并回退默认），恢复后自动回到正常轮询；每次重试的实际等待 = 退避时间 + 轮询间隔。仅不可恢复错误（如配置错误、认证失败）才会停止。该语义只属于常驻入口；单轮 `npm start` 失败即以非零退出码结束。

青龙常驻入口在 `got`/`re2` 缺失或原生模块不可加载时会直接退出并提示部署命令，设置 `XBK_AUTO_INSTALL_DEPS=1` 可改为运行期自动安装与重建。单轮入口 `npm start` 缺 `got` 会直接崩溃，缺 `re2` 时**不退出**——用户配置正则会被跳过（不回退 V8），仅每天最多告警一次。

### 进阶环境变量

| 变量 | 作用 |
|---|---|
| `XBK_INTERVAL_MS` | 常驻轮询间隔（毫秒，默认 10000） |
| `XBK_RETRY_BACKOFF_CAP_MS` | 可重试失败退避上限（毫秒，默认 1800000） |
| `XBK_CACHE_DIR` | 仅 `--status`：状态文件所在目录（绝对路径） |
| `XBK_DRY_RUN=1` | 常驻干跑：不推送、不写成功缓存（`--dry-run` 参数则是一次性单轮后退出） |
| `XBK_AUTO_INSTALL_DEPS=1` | 仅青龙入口：依赖缺失时自动安装并重建 re2 |
| `XBK_PROFILE` | `1` 输出每轮耗时剖面，`2` 追加预热/预处理明细，`3` 再追加启动与运行检查点 |
| `XBK_DNS_FAMILY` | `4`/`6` 强制 DNS 预热与解析走 IPv4/IPv6，默认 auto |
| `XBK_UNIT_TIMEOUT` | 仅 `npm run test:unit`（`run_unit_tests.js`）：每套件硬超时毫秒数（默认 600000），正整数，非法值回退默认；超时以 `SIGKILL` 强杀并按失败结算 |

`--check` / `--status` / `--dry-run` 之外的参数会被忽略并告警（不改变启动行为）。

## 配置

主配置在 `xbk_function_v3.js` 顶部；本地密钥在 `push_config.local.js`。支持 Push+（PushPlus）、Server酱、Bark、PushMe、企业微信机器人、WxPusher、息知、PushDeer、Telegram 共 9 个通道。

常用通知环境变量：`PUSH_PLUS_TOKEN`、`PUSH_KEY`、`BARK_PUSH`、`QYWX_KEY`、`WX_PUSHER_APP_TOKEN`、`WX_PUSHER_TOPIC_IDS`、`WX_XIZHI_KEY`、`DEER_KEY`、`PUSHME_KEY`、`TG_BOT_TOKEN`、`TG_USER_ID`。

另有 `PUSH_PLUS_USER`、`WX_PUSHER_CHANNELS`（多应用分流）、`QYWX_ORIGIN`、`DEER_URL`、`PUSHME_URL`、`TG_API_HOST`、`HITOKOTO`，以及 Bark 扩展参数 `BARK_ARCHIVE`/`BARK_GROUP`/`BARK_SOUND`/`BARK_ICON`/`BARK_LEVEL`/`BARK_URL`（配置键原名 `WX_pusher_appToken`/`WX_pusher_topicIds`/`WX_pusher_channels` 同样可用）。同名环境变量存在但为空或纯空白时**不会**覆盖本地配置。

### 配置项速查

| 配置段 | 字段（默认值） | 说明 |
|---|---|---|
| `domain` | `'https://new.ixbk.net'` | 接口域名，`api.pushUrl` 由其拼出 |
| `api` | `timeout: 5000`、`retry: 2` | 接口超时与重试次数（超时只接受 ≥100ms 的整数并钳到 100~2147483647 毫秒；非整数、亚 100ms（疑似按毫秒填了秒）与非正值回落 5000 并告警。可重试响应（408/409/425/429 与 5xx）带合法的 `Retry-After` 时按其等待，否则指数退避，两条路径上限 30s） |
| `filter` | 全部 `''`，`pingbitime: '5'` | 过滤规则；变更会失效「过滤写入」缓存并重评 |
| `keyword` | `zkt_gjc: ''` | 只看它关键词 |
| `timing` | `pushInterval: 0`、`finalWait: 0` | 推送间隔与收尾等待（毫秒） |
| `push` | `mode: 'parallel'`、`parallelLimit: 10`、`titleMax: 100`、`contentMax: 3000`、`maxPerRun: 100` | 推送模式、并发、截断长度与单轮上限 |
| `template` | `title: '【{分类名}】{标题}'`、`content: '{Markdown内容}'` | 推送模板 |
| `cache` | `maxSize: 10000`、`dir: 'xianbaoku_cache'` | 去重缓存上限与目录（必须位于项目根内） |
| `alert` | `enabled: true`、`intervalMs: 3600000` | 接口异常告警与限频 |
| `report` | `enabled: true` | 运行日报开关 |
| `channelHealth` | `enabled: true`、`consecutiveFailures: 3`、`intervalMs: 3600000` | 通道健康监测与告警限频 |
| `diagnostics.filterLog` | `enabled: true`、`maxDetailsPerRun: 100`、`includePassed: false` | 过滤诊断日志 |
| `storage` | `minFreeBytes: 52428800`（50 MiB） | 磁盘余量告警阈值（仅告警，不阻断推送） |

模板占位符：`{分类名}` `{分类ID}` `{标题}` `{链接}` `{日期}` `{时间}` `{楼主}` `{类目}` `{内容}` `{价格}` `{商城}` `{品牌}` `{图片}` `{Html内容}` `{Markdown内容}`。

### 运行日报与通道健康

默认日报会在跨天后的下一轮发送，包含运行轮数、获取、去重、过滤、待推送、成功和失败统计；仅当上一日累计计数非 0 时才发送，「待推送」只在被 `push.maxPerRun` 截断时出现。`Config.report.enabled = false` 可关闭日报。状态文件 `report.state` 损坏或读取失败时会跳过本轮更新以保留原文件。

`Config.channelHealth` 默认开启：某个已配置通道连续失败 3 次（按运行轮计）时发一次异常提醒，恢复后发一次恢复提醒；同一通道异常默认限频 1 小时，恢复提醒不受限频约束。健康状态写入 `channel-health.state`；告警本身不计入健康统计，且健康监测/告警失败绝不影响线报推送、成功缓存或重试语义。

```js
channelHealth: {
  enabled: true,
  consecutiveFailures: 3,
  intervalMs: 3600000
}
```

常用过滤配置示例（默认全部为空串，`pingbitime` 默认 `'5'`；v3.176 起不再内置个人规则，需自行配置）：

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

默认最多记录每轮 100 条明细（配置上限 1000），并在文件超过 1 MiB 时自动保留最新尾部（约 512 KiB，按换行对齐）；`run.log` 使用同一截尾规则。可在 `xbk_function_v3.js` 的 `diagnostics.filterLog` 中调整：

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

`npm test` 顺序执行全部 45 个套件（33 个单元 + 10 个集成 + 2 个变异行段元校验），前置跑一遍依赖预检 `scripts/check-deps.js`：探测清单由 `package.json` 的 `dependencies`/`optionalDependencies` 派生（声明了却没装即失败，不再只认硬编码的 `got`/`re2`），区分「未安装」与「已安装但不可用」并输出根因，同时校验运行时 Node 版本是否满足 `engines.node` 与 `re2` 自身的（更严的）`engines.node`，任一不满足即退出；该脚本也可直接执行（`node scripts/check-deps.js`，按检查结果 exit 0/1）。集成套件多数已 mock，个别仍可能受运行环境/网络影响。`npm run test:unit` 只跑 33 个单元套件（跳过集成与变异行段元校验）。

```bash
npm run check                 # 总门禁：lint → 版本四方一致 → 变异行段校验 → npm test
npm test
npm run test:unit
npm run test:filter
npm run test:app              # 集成测试并行调度（默认并发 8，失败片自动串行重跑）
npm run test:app:serial       # 完整串行集成测试（并行失败兜底/定位问题时用）
npm run test:notify
npm run test:mutation         # Stryker 变异测试（需 devDependencies，耗时长）
npm run test:mutation-ranges  # 单独校验 mutation.yml 行段覆盖
```

测试与变异链路的环境变量：`XBK_TEST_TIMEOUT`（`run_tests.js` 的每套件硬超时毫秒数，默认 600000，超时以 `SIGKILL` 强杀并按失败结算）、`XBK_MUTATION_REPORT_MAX_BYTES`（`scripts/mutation-json.js` 读取 `mutation.json` 前的预读上限，默认 2 GiB，`off` 表示只保留 Buffer 能表示的边界）、`MUTATION_REPORT_MAX_SKEW_MS`（`scripts/mutation-report.js` 的陈旧（缓存回填）报告闸门阈值，默认 12h，`off`/`≤0` 关闭）。

定位单个集成用例：`node test_app.js --only=<名称子串>`（也接受空格形式 `--only <子串>`）。只运行名称含该子串的用例，其余跳过且**不计失败**。输出末尾会打印「实际执行 N 例，过滤跳过 M 例」，用来确认过滤确实生效。（v3.276 前 `--only=<子串>` 写法不生效、会照跑全部用例，空格形式才生效。）

## 维护

- 行为约束：[`SYSTEM_CONTRACT.md`](SYSTEM_CONTRACT.md)
- 版本历史：[`CHANGELOG.md`](CHANGELOG.md)
- 安全报告：[`SECURITY.md`](SECURITY.md)
- 代码修改规则：[`AGENTS.md`](AGENTS.md)
