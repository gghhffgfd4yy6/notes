# xbk-push

个人青龙单实例的线报抓取、过滤、去重与多通道推送脚本。

## 安装与运行

要求 Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`——这是 `re2` 原生模块的 `engines` 要求，Node 23.x、24.0–24.14、25.x 不在 re2 支持范围内，安装或重建原生模块会失败。三处校验口径各不相同：

- `package.json` 的 `engines.node` 写 `>=22.22.2`（只表达下界）。
- 青龙入口 `--check` 的 Node 闸门按该下界**完整比较**：两段/三段版本都按数值比，低于下界即判红。
- 常驻入口不硬拒启动，只在低于下界时告警；测试前置的依赖预检 `scripts/check-deps.js` 同时校验仓库与 `re2` 两处 `engines`。

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

`npm run hooks:install` 把 `core.hooksPath` 指向 `.githooks`。npm 不会自动注册仓库钩子，需在安装后显式执行一次；若你已配置过其它 `core.hooksPath`，该脚本不会覆盖。钩子文件必须可执行：noexec 挂载或无执行位的检出会以非零码拒绝安装并提示。

- **`pre-commit`** —— 五道快检：lint → 版本闸门 → 变异行段校验 → 静态扫描（v3.280 起第 4 道）→ 文档行长（v3.281 起第 5 道）。本机实测 lint 约 22s、其余各 <1s。
- **`pre-push`** —— 跑 `npm run test:filter`（约 60s，推送前拦截）。校验对象是**被推提交的内容**：`local_sha == HEAD` 且整棵工作树干净（含未跟踪文件；被 ignore 的不算）时在当前工作树跑（此时两者内容一致），否则在临时 worktree 里检出那个提交再跑、跑完清理；隔离环境建不起来即 fail-closed——绝不拿当前工作树的结果冒充被推提交的验证。
- **`commit-msg`** —— 首行须以 `fix: feat: refactor: docs: chore: style: test: perf: revert: build: ci:` 之一开头、不超过 100 字符，且**标题与正文之间要留一个空行**（没空行时 git 会把整段当标题，长度限制与 `git log --oneline` 都会失真）。`#`（或 Git 配置的 `core.commentChar`）行不自动算空行——注释行不算空行；由于 `git commit --cleanup` 可在命令行覆盖且不会把有效值传给钩子，所有 cleanup 模式都要求原始消息第二行留空。

**装完请用 `npm run hooks:verify` 自检门禁是否真的生效**（只读：生效 exit 0，未生效 exit 1 并说明是配置缺失、钩子文件缺失还是无执行位）——`hooks:install` 对「跳过/不覆盖」场景按设计仍 exit 0，不能当作「装好了」的证据。

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
| `XBK_UNIT_CONCURRENCY` | 仅 `npm run test:unit`：单元套件并发池大小（默认 8，正整数）；`XBK_MUTATION_CHILD=1`（变异评估沙箱）时该值被忽略、强制回退串行 1 |
| `XBK_PARALLEL_ID` | 仅测试分片：`Config.cache.dir` 未配置或不合法时，回退目录名改为 `xianbaoku_cache_p<id>`，让并行 worker 不撞同一缓存目录；该名仍走与生产同一套根内校验（越界继续逐级回退 `.xbk_cache_safe` → `.xbk_cache_safe_internal`）。「白名单 `[A-Za-z0-9_-]`、非法即回退 `pid`」由测试侧 `test_filter.js` 的 `sanitizeIsolationId` 负责。生产部署不需要设置 |

`--check` / `--status` / `--dry-run` 之外的参数会被忽略并告警（不改变启动行为）。

## 配置

主配置在 `xbk_function_v3.js` 顶部；本地密钥在 `push_config.local.js`。支持 Push+（PushPlus）、Server酱、Bark、PushMe、企业微信机器人、WxPusher、息知、PushDeer、Telegram 共 9 个通道。

常用通知环境变量：`PUSH_PLUS_TOKEN`、`PUSH_KEY`、`BARK_PUSH`、`QYWX_KEY`、`WX_PUSHER_APP_TOKEN`、`WX_PUSHER_TOPIC_IDS`、`WX_XIZHI_KEY`、`DEER_KEY`、`PUSHME_KEY`、`TG_BOT_TOKEN`、`TG_USER_ID`。

另有 `PUSH_PLUS_USER`、`WX_PUSHER_CHANNELS`（多应用分流）、`QYWX_ORIGIN`、`DEER_URL`、`PUSHME_URL`、`TG_API_HOST`、`HITOKOTO`，以及 Bark 扩展参数 `BARK_ARCHIVE`/`BARK_GROUP`/`BARK_SOUND`/`BARK_ICON`/`BARK_LEVEL`/`BARK_URL`（配置键原名 `WX_pusher_appToken`/`WX_pusher_topicIds`/`WX_pusher_channels` 同样可用）。同名环境变量存在但为空或纯空白时**不会**覆盖本地配置。

### 配置项速查

| 配置段 | 字段（默认值） | 说明 |
|---|---|---|
| `domain` | `'https://new.ixbk.net'` | 接口域名，`api.pushUrl` 由其拼出 |
| `api` | `timeout: 5000`、`retry: 2` | 接口超时与重试次数（超时只接受 ≥100ms 的整数并钳到 100~2^31-1 毫秒；非整数、亚 100ms（疑似按毫秒填了秒）与非正值回落 5000 并告警。可重试响应（408/409/425/429 与 5xx）带合法的 `Retry-After` 时按其等待，否则指数退避，两条路径上限 30s） |
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

缓存自愈（v3.277）：读到**超限**（>64 MiB）/ **JSON 损坏** / **合法 JSON 非数组** / **非普通文件**（目录、符号链接等）的缓存文件时，不再「拒绝写入直到人工删文件」（那会让每一轮都整轮零推送），而是**只隔离不删除** + 重建：

- **隔离**：原件改名为 `<缓存名>.corrupt.<ISO时间戳>.bak` 保留备查；同一毫秒重复隔离时追加序号 `<缓存名>.corrupt.<ISO时间戳>.1.bak`，绝不覆盖上一份备份。
- **重建**：超限件从文件尾部恢复最新 N 条，其余判据重建空缓存；原路径当场恢复可用。
- **留痕**：随后本轮照常推送，`run.log` 留一行 WARN 点名备份路径。
- **方向**：宁可重推——尾部窗口之前读不到的旧身份不落墓碑，会被重新推送。
- **清理**：确认无需备查后自行删除 `.corrupt.*.bak`。

**触发面只限「确定性不可恢复」判据**：

- 仅**瞬时**读失败一律保持保守的写闸门（本轮跳过推送、不动文件，等条件消失后自动恢复）——包括权限/IO 错误、缓存缺失且初始化失败，以及**读窗口内被并发替换/删除**（`replaced`：另一进程（cron 重叠 / 常驻 loop + cron）在读的同时原子写入了新缓存；此时 `readMessages` 返回空并置闸门，但**绝不**把对方刚写入的有效缓存改名搬走）。
- **每类隔离判据在真正改名之前都会复核自己的前提**：非普通文件复核「此刻还是非普通文件吗」、超限复核「此刻仍确实超限吗」、解析失败/非数组复核「重读一次后内容仍不可用吗」——任一复核不成立即按瞬时读失败处理（不隔离、保持闸门）。

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

`npm test`（`run_tests.js`）顺序执行全部 **50** 个套件：

- **35** 个单元套件 + **10** 个集成套件 + **5** 个「变异沙箱跳过」套件（2 个变异行段元校验 + `test_ci_static_gates.js` + `test_doc_line_gates.js` + `test_install_hooks.js`）。
- 前置跑一遍依赖预检 `scripts/check-deps.js`：探测清单由 `package.json` 的 `dependencies`/`optionalDependencies` 派生（声明了却没装即失败，不再只认硬编码的 `got`/`re2`），区分「未安装」与「已安装但不可用」并输出根因，同时校验运行时 Node 版本是否满足 `engines.node` 与 `re2` 自身的（更严的）`engines.node`，任一不满足即退出。
- 该脚本也可直接执行（`node scripts/check-deps.js`，按检查结果 exit 0/1）。
- 集成套件多数已 mock，个别仍可能受运行环境/网络影响。

`npm run test:unit`（`run_unit_tests.js`）只跑那 35 个单元套件（跳过集成与 5 个变异沙箱跳过套件）。自 v3.278 起它按**并发池**执行（默认并发 8，`XBK_UNIT_CONCURRENCY` 可调），每套件仍是独立子进程、逐套件判定结果与串行版一致，只是把「N 个套件串行合计」压到「最长套件」；`XBK_MUTATION_CHILD=1`（stryker 与 `run_mutation.js` 的变异评估沙箱）时强制回退串行 1，以保持变异评估的 `PERF_MS` 性能断言口径不被并发扰动。

```bash
npm run check                 # 总门禁：lint → 版本四方一致 → 变异行段校验 → 静态扫描 → 文档行长 → npm test
npm run verify                # `npm run check` 的别名
npm run check:ci-static       # 只跑静态扫描（shellcheck 扫 .githooks/* + zizmor 扫 .github/workflows/）
npm run check:doc-lines       # 只跑文档行长闸门（任何 markdown 单行 > 1200 字符即红）
npm test
npm run test:unit
npm run test:filter
npm run test:ci-static-gates  # 静态扫描「三处接线」的内容断言（摘掉任一处接线，下一次 CI 必红在这里）
npm run test:doc-line-gates # 文档行长「三处接线」的内容断言（同上，含阈值 1200 不许偷偷放宽）
npm run test:app              # 集成测试并行调度（默认并发 8，`CONCURRENCY` 可调，失败片自动串行重跑）
npm run test:app:serial       # 完整串行集成测试（并行失败兜底/定位问题时用）
npm run test:notify
npm run test:mutation         # Stryker 变异测试（需 devDependencies，耗时长；本地走 command 档 stryker.config.js）
npm run test:mutation-ranges  # 单独校验 mutation.yml 行段覆盖
```

文档行长闸门（v3.281）：

- 仓库内所有被扫描的 markdown（含 `.github/` 下的 PR 模板）都**不允许出现超过 1200 字符的单行**，超了直接红——巨行的实际代价不是难看，而是评审放弃逐字核对、diff 一行改动等于整行重写。
- 三处接线同一阈值：`npm run check`、`pre-commit` 第 5 道、CI `quality-gate` 显式步骤；接线内容由 `test_doc_line_gates.js` 锁死（含「阈值 1200 不许偷偷放宽」「`.github` 不得被跳过」）。
- 三处 fail-closed：扫描面为 0 个 md 判红、**扫描面里某个目录读不下去当场抛错并判红**、单文件读盘失败判红——「没扫到」和「扫不到」都不等于「全绿」。最长行按迭代求，不用 `Math.max(0, ...lines)`（spread 把每个行长度当实参压栈，实测 150k 行直接 RangeError ⇒ 闸门当场崩而不是判红）。
- 没有按文件的例外名单。**处理办法是拆行**（按语义分成子弹/表格），不是调大阈值；改完跑 `npm run check:doc-lines` 自查。

变异测试档位与墙钟（CI 侧口径，逐段选 runner，见 `.github/workflows/mutation.yml` 矩阵的 `config` 字段）：

- 本地 `npm run test:mutation` 走 **command 档** `stryker.config.js`；CI 矩阵 19 段中 **15 段走 TAP 档** `stryker.tap.config.js`，`v3-entry` / `storage` / `qinglong-push` / `check-deps` **四段保留 command 档**（原因与各段口径差异见 AGENTS.md 的「TAP 档已知限制」）。
- 墙钟实测（按矩阵档位区分，别把三者混着比）：
  - 全 19 段 TAP 基线（spike，head `cb247c9`）≈**71min**；瓶颈 `utils` 70.25min（**段内 step 口径**）。⚠️ 该 run 整体结论为 **failure**——`storage` 段按设计触发 fail-closed 守卫判红，**非 timeout**。
  - PR-1（= PR #162，TAP 迁移落地提交 `b05e323`）的 16 TAP + 3 command 矩阵：**86.0min**（head `ca63e71` 分支 push run，2026-09-21T19:47:10Z→21:13:12Z）；瓶颈 = command 档 `qinglong-push` 85.3min。
  - 15 TAP + 4 command 首跑（head `01c0ef89` main push run，2026-09-23T06:30:47Z→08:01:34Z）：**90.8min**；瓶颈 = command 档 `qinglong-push` **90.1min**，`v3-entry` 实测 35.1min ⇒ 原先「墙钟不变」的预估不成立。
- 分数**当前不是门禁**：`stryker.config.js` 的 `thresholds.break = null`（停用理由与重新标定条件见 AGENTS.md）；假绿通道由段级 **fail-closed 守卫**兜底（报告缺失、零有效变异体或全程 RuntimeError 即红）。日报逐段标注「本轮全量 / 复用 N/M」与复用来源，读数前先确认那一段是不是全量重算。

测试与变异链路的环境变量：

| 变量 | 归属 | 语义与默认值 |
|---|---|---|
| `XBK_TEST_TIMEOUT` | `run_tests.js` | 每套件硬超时毫秒数（默认 600000）；超时以 `SIGKILL` 强杀并按失败结算 |
| `XBK_UNIT_TIMEOUT` | `run_unit_tests.js` | 同上，作用于单元套件（默认 600000） |
| `XBK_UNIT_CONCURRENCY` | `run_unit_tests.js` | 并发池大小（默认 8，正整数）；`XBK_MUTATION_CHILD=1` 时被忽略 |
| `XBK_UNIT_MAX_BUFFER` | `run_unit_tests.js` | 单套件输出缓冲**字节**上限（默认 8 MiB）；仅供测试注入超限场景，生产不设 |
| `XBK_MUTATION_CHILD=1` | 变异评估沙箱 | 由 stryker 侧与 `run_mutation.js` 注入，令 `run_unit_tests.js` 回退串行 1 |
| `XBK_PARALLEL_ID` | 缓存目录分片 | 测试并行分片用的缓存目录后缀（详见「进阶环境变量」） |
| `XBK_MUTATION_REPORT_MAX_BYTES` | `scripts/mutation-json.js` | 读取 `mutation.json` 前的预读上限（默认 2 GiB）；`off` 表示只保留 Buffer 能表示的边界 |
| `MUTATION_REPORT_MAX_SKEW_MS` | `scripts/mutation-report.js` | 陈旧（缓存回填）报告闸门阈值（默认 12h）；`off`/`≤0` 关闭 |

定位单个集成用例：`node test_app.js --only=<名称子串>`（也接受空格形式 `--only <子串>`）。只运行名称含该子串的用例，其余跳过且**不计失败**。输出末尾会打印「实际执行 N 例，过滤跳过 M 例」，用来确认过滤确实生效。（v3.276 前 `--only=<子串>` 写法不生效、会照跑全部用例，空格形式才生效。）

### 本机能不能当判据：先探宿主

最终判据是 **CI**（`test.yml` 的 quality-gate + 变异矩阵），但「本机跑不跑得起来」取决于宿主，别把任何一句当通用结论——先跑这两条探针：

```bash
node -e "console.log(process.execPath)"     # 真 node？还是 linker64？
node -e "require('re2'); console.log('re2 ok')"   # 原生绑定在不在？
```

- **装好真 node 与 `re2` 的 Linux 容器**：整条 `npm run check`（50 个套件）可以本机跑完。若环境注入了 `NODE_OPTIONS=--require=<dns-compat.cjs>`（DNS 兼容层，起动时替换 `dns.lookup`），`test_agents.js` 的「`dns.lookup` 未被猴补」前置检查会红，并连带 `test_run_mutation_cli.js`（它的 `evaluate` 场景要在沙箱跑全量单元）——那是**环境噪声不是回归**，加 `DSHA_DNS_MODE=native`（该兼容层自带开关）或 `env -u NODE_OPTIONS` 再跑：
  ```bash
  DSHA_DNS_MODE=native npm run check
  ```

  带该开关后本机汇总**不是固定值**：48 套件那版实测过 **48/0**、**47/1**，不带开关是 **46/2**；v3.281（49 套件）三轮 **47/2**、**48/1**、**48/1**。波动源一直是 `test_run_mutation_cli.js`，而它与注入无关——旧语义只有一条 180s **墙钟总长**线，在慢机器上区分不了「跑得慢但仍在推进」与「挂死」：旧语义下合计 **10 次观测 = 3 绿 7 红**（红 193–205s、绿 171.1–171.3s，失败文本逐字相同「沙箱内单元测试应整体通过，实际 timeout」），把文档全部回退到上一版内容再跑、红绿分布不变 ⇒ 非回归。**v3.282 起这条不再抖**：挂死改由静默线判定（连续 `MUTATION_IDLE_MS`＝180s 无任何输出即 SIGKILL），总上限只作兜底，改后连续两轮 **199s / 196s 绿**——这两轮在旧语义下都会红。另有一条 `test_filter.js` 曾在慢轮次红在 `基准: tuisong_replace 1000次 < 300ms`（实测 878ms），**根因已定位**：前序被 `job_kill` / `timeout` 中断的运行留下了 detached 心跳桩进程与 `/tmp/xbk-*` 沙箱，把墙钟基准拖红。清场后同一断言 **276ms** 通过、全链 **49/49 绿**（674.9s）。所以本机跑测试前先看这两条是否干净：`pgrep -fal "stub_heartbeat|test_stub_tree"`、`ls -d "$(node -e 'console.log(require("os").tmpdir())")/xbk-*`（Linux 上即 `/tmp/xbk-*`）。**报本机结果必须带轮次与耗时**，跨环境的最终判据是 CI。
- **主机干净度门禁**：`npm test` / `npm run test:unit` 以及直接运行 `test_filter.js` 前会检查孤儿测试桩、父进程消失的孤儿套件和过期 `<os.tmpdir()>/xbk-*` 沙箱；先判断是否存在过期沙箱候选，没有候选时不读取所有进程 cwd，因此无关的 `/proc` 项不会阻塞启动；有候选但活动沙箱 cwd 保护信号无法扫描时按 fail-closed 拒绝启动，不生成清理命令。发生 cwd 读取失败时仅输出 PID、errno、proc 状态和 UID 等诊断元数据，不输出 cwd 路径或命令行。普通文件/符号链接不会被列入清理命令。变异评估子进程以 `XBK_MUTATION_CHILD=1` 跳过该检查。

- **Android/Termux 宿主**：`process.execPath` 指向 `linker64` ⇒ 凡 `execFileSync(process.execPath, […])` 的子进程断言必炸；`re2` 缺失 ⇒ 用户过滤正则一律被跳过（代码刻意不回退 V8），`test:filter` 的 regex 断言两个方向都失真。这类机器上只有**不 spawn 子进程**的那五道闸门可当判据：

  ```bash
  npm run lint
  node check-version.js                       # 版本四方一致
  node scripts/check-mutation-ranges.js       # 变异行段覆盖与连续性
  npm run check:ci-static                     # 静态扫描（缺工具时显眼跳过，见下）
  node scripts/check-ci-static.js --selftest  # 该闸门自身的 15 条纯函数断言，不需要任何外部工具
  npm run check:doc-lines                     # 文档行长闸门（纯 fs 遍历，同样不依赖外部工具）
  ```

无论哪种宿主，**别拿「本机跑不了」当免除验证的理由**，也别拿本机的部分红绿冒充 CI 的结论。另：别在这台机器上跑变异评估（`npm run test:mutation`）——生产每批总上限 `MUTATION_TIMEOUT` 默认 90s，而本机跑完整套单元要 170–205s，会批量超时、分数不可信；真要本地跑就把两个预算一起抬：`MUTATION_TIMEOUT=600000 MUTATION_IDLE_MS=180000 npm run test:mutation`（v3.282 起挂死由静默线判定，慢但推进的子进程不再被误杀）。

静态扫描需要两个外部工具：`shellcheck`（如 `apt install shellcheck`）与 `zizmor`（如 `pipx install zizmor`；CI 钉 **1.30.1** = 本仓基线，升级须同步 workflow 与本文件口径）。本机缺工具时闸门**显眼提示并跳过**——不阻塞开发，但绝不假装扫描过；CI（env `CI=true`）或显式加 `--require-tools` 时缺工具即红。

## 维护

- 行为约束：[`SYSTEM_CONTRACT.md`](SYSTEM_CONTRACT.md)
- 版本历史：[`CHANGELOG.md`](CHANGELOG.md)
- 安全报告：[`SECURITY.md`](SECURITY.md)
- 代码修改规则：[`AGENTS.md`](AGENTS.md)
