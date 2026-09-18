# Changelog

完整历史以 Git 提交记录为准。

## v3.269

- 增强告警留痕、可重试失败退避与通道即时重试。
- 修正相关评审问题并通过完整测试。

## v3.270

- 常驻模式：可重试错误不再连续 3 轮退出，改为指数退避持续重试（默认 30 分钟封顶，`XBK_RETRY_BACKOFF_CAP_MS` 可调），仅不可恢复错误退出，消除对外部重启器的依赖。
- 变异测试：V3 重拆 5 段、sendnotify 补齐尾部，修复 4495-4924 约 430 行静默漏测；新增 `scripts/check-mutation-ranges.js` 行段覆盖校验并纳入 `npm run check`，文件增长后 CI 自动拦截。

## v3.271

- 判重 URL 归一化修正：去 hash，只忽略 `utm_*`/`fbclid` 等跟踪参数，业务 query 保留（此前整段 query 被去掉，带业务参数的同一资源被判为不同而重复推送）。
- HTML 转 Markdown 只读取标签真实属性层：`title`/`data-*` 等属性值里形似 `href`/`src` 的文本不再被误当链接或图片。
- `push_config.local.js` 加载失败不再回显原始异常信息（可能带密钥片段），改为固定提示。
- 日报状态 `date` 字段非法时保留原文件并跳过更新（避免累计状态被重置）。
- WxPusher profile 日志不再泄露短 appToken。

## v3.272

- 日报新增当天运行轮数统计与展示，继续采用原子状态写入和跨天重试语义。
- 新增按通道记录的连续失败、限频异常告警与恢复提醒；健康告警不参与健康统计，且失败不会影响主推送、缓存和重试。

## v3.273

- 新增 `--status` 只读运行状态命令：汇总最近运行、日报、通道健康与过滤诊断；不加载推送依赖、不抓取、不推送、不写文件（缓存目录可用绝对路径 `XBK_CACHE_DIR` 指定）。
- 新增过滤诊断日志 `filter-diagnostics.ndjson`：每轮一条 `type: "run"` 汇总，外加被过滤/被强制展现保护的明细；默认每轮最多 100 条、日志超 1 MiB 时保留最新尾部，可在 `diagnostics.filterLog` 调整。
- 青龙入口先检查/恢复依赖再加载应用：`got`/`re2` 缺失时不再在加载阶段失败，并给出部署命令；仅在显式设置 `XBK_AUTO_INSTALL_DEPS=1` 时自动安装与重建 re2。
- 推送安全：PushPlus 正文与 wxpusher 等 HTML 渲染通道统一共用出口清洗（实体编码的主动 HTML 不再还原成活标签）；模板占位符改为单趟替换（数据值中的字面占位符不再被二次替换）；Markdown 链接目标含 `<`/`>` 时按 URL 编码，避免链接被提前截断。
- 通道配置：Bark 扩展参数（archive/group/sound/icon/level/url）与 `QYWX_ORIGIN` 支持环境变量覆盖（此前只认 `push_config.local.js`）；「已配置通道」判定统一（空白值/`0`/`false` 不再计为可用通道，消除自检报有通道而主流程零通道漏推）。
- 稳定性：一言请求关闭 got 内置重试（不再吃满 10 秒推送预算导致整轮取消）；一言文本拼接后再清洗孤立代理（避免通道每轮 URIError）；WxPusher 取消不再被误判为限频逐个重试；emoji 修饰符截断与主实现对齐。
- 可观测性：dry-run 不再报「N 条失败，下次运行重试」（未推送条数另记）；身份无效条目单独计数（终端与 `run.log`）；`run.log` 回显清洗控制字符，防止接口字段伪造日志行；一言获取失败的日志改经 `safeErr` 脱敏（不再原样打印异常 message）；日报/通道健康整体异常补 WARN 留痕；告警留痕的版本号改为入口注入（缺 `package.json` 的部署不再静默失效）。
- 性能：HTML 转 Markdown 的未知标签闭合探测与 URL 归一化改为线性算法/单次预扫描，消除单条长消息可触发的 O(n²) 阻塞。

## v3.274

- 时间口径：运行日志与台账时间戳固定为 `Asia/Shanghai`（格式不变），不再随部署时区变化，与日报日界统一（此前 CI/容器以 UTC 运行时，日志行日期可能比日报早一天）。
- 接口超时钳制：`api.timeout` 统一取整并钳到 `[1, 2147483647]` 毫秒（小数向上取整），非正或非法值回落默认 5000；此前 `0.5` 或超界值会被 Node 定时器归一到约 1ms，导致每次请求瞬间超时。
- 缓存安全：空字符串路径显式判为不安全并拒绝写入（此前会在进程 CWD 落一个含内容的临时文件）；`readSafeText(filePath, maxBytes)` 支持透传读取上限。
- 过滤：白名单过滤对非字符串字段值统一 `String()` 化（与 `matchesCompiled` 同口径，不再按对象 JSON 化/函数置空）；`checkFields`/`checkCategory`/`checkRegisterTime` 收到未编译或错形状参数时显式告警并保守放行，规则编译失败同样补告警；配置校验对含零宽字符的正则与超上限的 `pingbitime` 补告警，并改为逐字段安全读取（抛错 getter 只告警并跳过该字段，不再中断整轮校验）。
- 推送：HTML 正文超过 100000 字符改用 UTF-16 安全截断（不再按码元切出半个 emoji）并打告警；整体超时的错误对象顶层补 `code='PUSH_TIMEOUT'`，配置通道清单不可得时告警留痕。
- 模板与清洗：`{Html内容}` 在无 url 时不再输出悬空的「原文链接：」，url 被 `safeUrl` 过滤但原始值非空时保留纯文本提示、不生成 href；Markdown 链接/图片的闭合点按 `(…)` 配平扫描（URL 内含 `)` 不再残留 `.jpg)`），配平失败回退「首个 `)`」而不是放弃整段。
- 常驻循环与失败归类：未传 `onError`/`onIntervalError` 时分别由独立默认处理器打诊断日志（单轮失败与性能预热失败不再互相误标、也不再静默吞错）；`summarizeError` 递归加祖先环守卫与深度上限（自引用结构不再抛 `RangeError`），`failureInfo` 透传前同样脱敏/折叠换行/截断，全部通道可重试时聚合原因细分标为 `ALL_CHANNELS_RETRYABLE`。
- 预热与墓碑缓存：`prewarmTls` 的 `count` 非有限值钳为 1（此前 NaN 静默报成功、Infinity 抛 `RangeError`）；墓碑淘汰在无法达标时返回 `null` 并放弃持久化（此前死循环挂起进程），墓碑读取失败与写入门径失败补告警。
- 清理：移除死代码——`xbk_agents` 的 `DNS_CACHE` 死导出、`xbk_rules` 未被调用的正则编译包装、`xbk_utils._parseFallback` 不可达的 `/` 分隔日期分支、`xbk_message_store` 的死状态 `_nowInc`。
- 接口响应：带 UTF-8 BOM 的合法 JSON 不再被判 `ERR_BODY_NOT_JSON`（此前会让常驻循环按永久错误停推）；`XBK_PROFILE=3` 的请求日志 URL 只保留 origin（非末段密钥不再进日志）；响应体非法时不再回显响应体内容、只报长度。
- 入口与状态：青龙入口未识别参数、`XBK_CACHE_DIR` 非绝对路径、Node 低于 `engines` 要求均补告警（不再静默），依赖恢复改用现行等价的 `--omit=dev`，`--check` 失败项带上原因、DNS/TLS 预热统计按任务类型绑定（TLS 不再计入 DNS 计数）；`--status` 的 `run.log` 摘要解析锚定行首（噪声行不再误命中）、`report.state` 缺字段不再整表判 invalid，输出补「待推送（截断）」「截断」「耗时」。
- 门禁与工具链：单元入口新增每套件硬超时 `XBK_UNIT_TIMEOUT`（默认 10 分钟，超时 SIGKILL 并按失败结算）；`check-version.js` / `run_unit_tests.js` 改用 `process.exitCode` 收尾（管道场景不丢错误详情）；变异日报对预期之外/重复分段 fail-loud、报告顶层非对象时报带上下文的错误；行段校验补 `start > end`、非末段越过 EOF 与全文件形式的幽灵目标三类 fail-loud，对 `MUTATION_WORKFLOW_TEXT` 注入打告警（区分注入与真实文件读取），变异报告 JSON 读取失败补路径上下文；`install-hooks.js` 读取 `core.hooksPath` 出错时 exit 1 且不写配置（保留 git 的 stderr），空串值按未配置处理并写入 `.githooks`；`isValidVersion` 补 `typeof` 守卫；`xbk_sendNotify_slim.js` 段二行段随行数同步为 `751-1505`。

## v3.275

- 常驻循环 `sleep`：`signal` 加 `typeof` 守卫（此前传入非 AbortSignal 的真值对象会先抛 `TypeError`，定时器回调里再抛一次成为未捕获异常终止进程）；毫秒值统一经 `clampTimerMs` 钳到 `[0, 2147483647]` 再交给 `setTimeout`（此前 `1e12` 被 Node 静默降为 1ms，「等一天」变成立即返回）。
- 失败归类：`classifySummary` 的「本轮有无失败」只由 `failed` 决定（此前 `total` 缺失/非数字时 `Number(total)||0` 使有失败的摘要返回 `null`，被调度器读成成功）；企业微信 `93000`（invalid webhook key）与文本兜底 `invalid [webhook|access|api] token|key|parameter` 判为永久配置错误（此前落 `UNKNOWN`，常驻对已失效 webhook 无限退避重试）。
- 脱敏：`redact` 补齐 `Authorization: Bearer|basic <凭据>`、JSON 引号形态 `"appToken":"…"`、单引号/带引号关键字/非字符串 JSON 值/URL query 形态与裸 `Bearer|Basic <凭据>`，关键字表补 `password/pwd/session/cookie/credential`（此前这些形态的凭据原样进日志与告警，只抹掉 scheme）。凭据值以 `\s,;}&]` 为边界；裸 scheme 要求凭据 ≥8 字符，避免误抹普通英文句子（`the bearer of good news`）。
- TLS 预热：`prewarmTls` 的 `count` 补上界（钳到 64）——此前 `1e10`/`2^32` 让 `Array.from({length})` 抛 `RangeError` 整体 reject，略小的值则真的发起海量并发连接。
- 时间口径：运行异常告警正文的时间、RE2 缺 re2 提醒标记的保留期 cutoff 统一 `Asia/Shanghai`（此前前者随进程时区，后者与标记名基准被拆开，CI 的 UTC 下与 run.log/日报错开一天）。
- 变异工具链：报告 JSON 的 V8 字符串上限判定移到 `Buffer.concat` 之前（此前先付出分配峰值才发现放不下，且该护栏长期无法被测试触及）；变异日报段内容校验补 `files` 映射缺失/类型非法、`mutants` 非数组、零变异体三类 fail-loud（此前缓存回填的陈旧 artifact 会被当成 0 变异体的满分日报发布），`validateSegments` 的错误逐段带上原因；CLI 集成测试夹具改为真 stryker schema（补齐 `schemaVersion`/`thresholds`/`source`，并用 ajv 对齐厂商 schema 逐条自校），断言收紧到合计/分段统计值。
- 独立对抗审查跟进：脱敏再补引号包裹/带引号关键字/单引号/非字符串 JSON 值/URL query 等漏抹形态与关键字表（`password/pwd/session/cookie/credential`），并收掉本批新引入的 `the bearer of good news` 假阳性；变异体 `status` 改按厂商 schema 的 `MutantStatus` enum 校验（此前只要求「非空字符串」，`'Bogus'` 会被静默计入 `total`）；`refreshTimeoutError` 的归因按实际分支改写（NaN→回落默认、负值→按下界，不再一律说成「超出上限钳制」）；`sleep` 摘除侧守卫补断言（此前后变异掉也不会变红）；APP-05 用例改为快照-恢复，不再删掉共享缓存目录里的既有 `re2warn.state.*` 标记。

## v3.276
- 钩子分层：`test:filter`（本机 ~60s，占原 pre-commit 耗时 72%）从 `pre-commit` 迁到新增的 `pre-push`，提交前阻塞由 ≈82s 降到 ≈23s；**门禁覆盖未减少**（同命令、同退出码、仍在推送前强制拦截）。`pre-commit` 保留 lint / 版本闸门（四方）/ 变异行段校验三道，并统一为「成功安静、失败原样回显 + 逐门禁计时」；新增 `npm run hooks:verify` 只读自检门禁是否真的生效（`hooks:install` 对跳过场景按设计仍 exit 0，不能当装好的证据）。

- 清洗链按 HTML5 词法状态判定（`xbk_utils._htmlTagSpans`）：只在 `<` 后紧跟字母（开始标签）或 `/`（结束标签）时才开启标签区间——此前未配对的 `<`（`1 < 2`、`价格 <100 元`）会把区间一直延伸到串尾，把后方纯文本里的 `name="…"` 误判成「标签内属性」；同时增记 `valueQuotes`（正扫时处于引号外状态遇到的引号位置），只有真正开启属性值的引号才允许整段占位，杂散引号拼出的伪属性对不再屏蔽其后的 `on*` 事件属性（安全缺口）。
- 清洗链补全 HTML5 的「非普通标签起始」（同上 `_htmlTagSpans`）：标签起始集合由 `[A-Za-z/!?]` 收窄为 `[A-Za-z/]`——`</` 后跟字母走标签名态，`</` 后跟非字母按 HTML5 bogus comment 吃到下一个 `>`，`<!`、`<?`、空白、数字、`=` 一律按文本处理；这三类区域**一律不记 `valueQuotes`**。此前它们被当成普通起始标签跑属性状态机，`</x='><img src=x onerror=alert(1)>'` 这类「伪注释/端标签前缀」里的杂散引号因此被记成「属性值开启引号」，回扫出的伪属性对被整段占位、段内真实 `<img>` 的 `onerror` 逃过 `_stripEventAttrs` 原样出网（`</x=`、`</ x=`、`<! x=`、`<? x=` 四条载荷同源；修复后四条在 domino 与 parse5 双解析器下均已关闭，定向差分 207,360 条存活由 810 降到 0，良性语料 200,015 条仅该恶意载荷一条输出改变）。
- 属性值引号只在 `=` 之后定界（`xbk_formatter._quotedAttrSpans`，与 `_readTagAttrValue` 同口径）：未加引号的属性值里的撇号（`<img alt=it's>`）不再被当成引号起点、吞掉其后的 `<a>`/`<h1>`；`=` 之后（可含空白）的引号仍是属性值区间。
- 清洗链内部正则 RE2 兼容：href/src、`_cleanNavAttrs`、`_cleanSrcsetAttrs`、`_cleanStyleAttrs` 四处含反向引用（`\1`/`\2`）的成对引号正则改写为「双引号支 | 单引号支」等价形态（href/src 一并改经 `safeRe` 编译），`sanitizeSurrogates` 去掉 lookaround——此前这些内部模式在 RE2 下不被支持，清洗会在启用 re2 的部署上降级。
- `safeRe` 回落留痕：`new RE2(...)` 编译失败回落原生 `RegExp` 时按**进程一次**告警（模式串与失败原因都经既有 `summarizeError` 脱敏/截断）——此前该分支是空 `catch`，「RE2 静默降级」与「线性防护对该模式不成立」这件事在日志里没有任何痕迹。同一进程只报一次（热路径内部正则都过 `safeRe`，逐条打印会刷屏）。
- ReDoS 防护 `hasNestedQuantifier`：取反字符类 `[^...]` 改为扫描到未转义的类结束符（此前只判 `^` 后一个字符，类体被当普通模式解析——`[^(a+)+]x` 被误拦、`(x[^)]+)+` 因 `)` 被吞进类体而漏检；`[^]` 非空字符类语义不变）。
- 出口清洗时序：一言文本拼接后再补一次出口清洗，消除「清洗作用于 append 之前、`contentType` 判定作用于 append 之后」的不同步——此前 slim 追加的一段一言 HTML 未经清洗即出网。
- 推送出口响应体上限：slim 的 `$.post`/`$.get` 补 20MB 流式响应体上限（复用 `xbk_http.DEFAULT_MAX_BODY`：官方 got 走流式限长读取、超限报 `EBODYLIMIT` 并销毁流，无 `stream` 的 got 替身仍走原 promise 路径），此前会把整段响应体读进内存；流式请求入口 `streamRequest` 补 method 白名单闸门（只放行 `post`/`get` 并静态分派，其余 fail-closed 抛错，不再按非静态数据取 `got.stream[method]`）。
- `WX_pusher_channels` 丢弃告警：多应用分流配置被丢弃（非法 JSON、数组项同时缺 `appToken`/`topicIds`、形状不是数组）时显式告警并给出原因，此前静默回退旧字段，用户看到「推送成功」却少推其余应用；空串与显式空数组不告警。
- 失败归类 · 终态 3xx 判永久：HTTP 层对终态 3xx/304 带真实状态码抛出（此前只看 `>= 400`，3xx 落进 JSON 解析分支报 `ERR_BODY_NOT_JSON`，错误码既误导又随响应体形态漂移），失败策略在数字 `code`、`providerCode`、`HTTP_` 前缀与 `statusCode` 四种承载字段上按 300–399 区间统一判 permanent——此前同一 3xx 在错误码路径落 UNKNOWN（可重试）、在状态码路径却判永久，分类相反。
- 失败归类 · 空响应体单列 `ERR_EMPTY_BODY`：2xx 空体、剥离 BOM 后的空体与纯空白体不再与「返回了内容但不是 JSON」共用一个码，改判**可重试**（上游连上后未写体即结束是典型瞬时故障），并显式列入 `RETRYABLE_CODES`（归类理由即本码本身，不靠 UNKNOWN 兜底）；非空但非 JSON 仍是 `ERR_BODY_NOT_JSON`（永久），两者互不放松。
- 失败归类 · 4xx 与子级仲裁：408/409/425/429 在数字 `code`、`providerCode`、`HTTP_` 前缀与 `statusCode` 四种形态下同判可重试（此前数字 `code`/`providerCode` 路径一律 permanent，与状态码路径相反）；子级仲裁同时认 `error.failures` 与 `failureInfo.failures`（青龙形状），父级标了 `failureKind: 'permanent'` 也不再压掉子级的 retryable。
- 请求层不可重试判定补错误码维度：`PERMANENT_CODES`（JSON 契约/证书/URL 参数类）与请求层单列的确定性失败码 `EBODYLIMIT`（响应体超限）命中即首次失败即抛，不再退避重试满 `api.retry`（此前只认 HTTP 状态码，这类错误白跑 1s+2s+… 退避）；未知错误码保持保守重试口径。
- 请求超时口径：`api.timeout` 只接受 ≥100ms 的整数并钳到 `[100, 2147483647]`，非整数、亚 100ms（单位误填，如按毫秒写「5 秒」）与非正值一律回落默认 5000 并告警（越上界同样留痕）——此前小数被向上取整、小值原样传出，会让每次请求瞬间超时，且现象是「请求超时」而非「配置有问题」；`xbk_http.fetchJson` 在调用方未显式传 `timeout` 时注入默认 30000 ms（显式值优先），此前 got@11 默认 `timeout:{}` 且共享 Agent 不带超时，服务端半开会让请求永久挂起。
- 重试退避遵守 `Retry-After`：只认 RFC 9110 §10.2.1 的合法形态——`delta-seconds`（非负整数、上界 2^31−1）与三种 HTTP-date（IMF-fixdate、rfc850-date、asctime-date；后两者为 obs-date，asctime 无时区标记故显式按 GMT 解析，IMF-fixdate/asctime 再交叉校验 day-name 与日期一致——rfc850 因 2 位年的 50 年切点口径不做该校验，也不校验真实日历日，属既定遗留工单 T2），空串/`1.5`/`-5`/非日期文本/ISO-8601 等一律回落指数退避且日志不得标注「按 Retry-After」；命中时按服务端指示等待、不叠加抖动，与指数退避两条路径统一受 30s 上限保护。此前 `Date.parse` 的接受面过宽，会把「已过期」的非法头钳成 0 后谎报来源，而外层退避曾完全不读该头、在限流窗口内按固定指数退避反复撞墙。
- DNS 与预热：`prewarmDns` 与真实请求共用同一缓存条目，key 为 `hostname|family|hints|order`（`all` 只决定回调形状、不入 key）——此前把 Node 传入的 `hints`/`all`/`verbatim` 全文编进 key，预热写进一个永不被读的条目、默认配置下 DNS 预热完全无效；只收敛到 `hostname|family` 又反向出错：缓存的是「解析器按调用方选项筛选/排序后」的地址，带 `hints`（如 `ADDRCONFIG` 剔除 AAAA）或自定义 `order` 的真实请求会在 TTL 内复用不匹配的地址，故 `hints`/`order` 重新入 key，且 `prewarmDns` 经 `productionLookupOptions()` 与生产**同源取值**（未指定 family 时 `hints=dns.ADDRCONFIG`、指定时 `hints=0`）；底层统一按 `all:true` 解析、按各调用方 `all` 适配回调形状；`ETIMEDOUT` 计入 DNS 失效码（重试窗口远短于 60s TTL），证书主机名不匹配不再计入；预热结果补 `kind:'dns'|'tls'` 可按字段区分；got 替身缺 `stream` 时 `prewarmTls` 报 `ok:false`，不再未建连却报成功。
- 推送超时按在飞通道归因（可选契约 `params.inFlightTracker`）：Pusher 把追踪器交给投递层，slim 在启动通道任务前写入 pending（未结算通道名数组）、每通道 settle（含同步抛错）时移除，**不传该参数零副作用**。10s 整体超时归因改为优先取在飞清单——此前一律按静态配置清单把**所有**通道标成 `PUSH_TIMEOUT`（含已送达通道），污染通道健康统计与下轮重试判断；空数组是有效状态（全部已结算），与「无该能力」严格区分，两者都拿不到时才补「failures 为空」的告警。
- 通道健康告警：失败告警改为按「告警尝试」计时（排入告警时即落盘 `lastAlertAt`，发送成功与否不影响 `intervalMs` 限频）——此前只在发送成功后回填，告警通道不可用时限频完全失效、每轮重发；恢复告警改为确认送达后才清零（新增 `recoverAlertPending`），发送失败保留 pending、下一轮重发，此前发送失败即永久丢失恢复通知；恢复告警的发送改为在健康状态锁内**原子认领**（唯一令牌 `recoverAlertClaim` + 60s 租约），重叠运行的第二轮看到仍在租约内的认领只跳过、不再各发一条重复通知，只有令牌匹配的送达才清零（迟到的成功不会清掉后继尝试已重新认领的 pending），失败在锁内释放认领、下一轮无需等租约即可重发，超租约的陈旧认领可被接管。
- 单条推送渲染异常按单条失败：pushOne 的渲染段（对象安全复制、链接提取、模板替换、代理对清洗、UTF-16 安全截断、链接保留与 dry-run 预览）纳入 try，渲染期异常按「单条推送失败」处理（警告 + 不写缓存 + 下轮重试），不再冒泡中止整轮并跳过缓存写入。
- 缓存与判重：`_identityIndex` 加失效检查（数组引用 + 首元素 + 长度，陈旧即重建并复检当前元素），消除 `has` 因索引陈旧而漏推；未命中路径再补两条**有界旋转抽查窗**（引用层 32 个位置 / 身份层 2 个位置，每数组版本首次未命中同样重建一次），闭合 `missVerified` 粘滞——此前索引一旦标为「已核实未命中」就不再自愈，被调用方原地改写的数组会让 `has()` 恒判 false、同一批消息每轮重复推送；`_tombstoneLoaded` 改为「读到内容」或「确认缺失」才置位（ioError/unsafe/tooLarge 下次重试，此前一次读故障即永久停用墓碑）；启动清理只按精确锁形状匹配（覆盖 `.seen.cleanup.lock`/`.reclaim`），不再误删 `.seen.cleanup.lock.json`；`saveBatch` 全部出口返回布尔（`true` = 已落盘/无需落盘，`false` = 拒绝或落盘失败）并把落盘结果进摘要与 `run.log`；缓存文件名/路径单射化（`getFileName` 按来源分派：`.` 开头的末段 → `url_`+原名（不再生成隐藏文件）；`url_` 开头且已带 `.json` → `url_`+原名；`url_` 开头但未带 `.json` → `url_`+原名+`#` 再补后缀——三支像集互不相交，`#` 又不可能出现在清洗后的末段里，`https://x/.json`、`https://x/url_`、`https://x/url_.json` 三个不同 pushUrl 因此不再互相覆盖判重记录（上一版对两类统一前置 `url_`，`url_` 与 `url_.json` 仍撞名）；`getFilePath` 的 200 字节截断改为附全名摘要，消除「仅第 200 字节之后不同」的两个长名互相覆盖）；`filterHash` 折入「规则是否实际编译生效」维度，re2 从不可用到可用（或反之）不再让已过滤记录跳过重评。
- 存储与文件安全：`writeAtomic` 在 rename 前 fsync 临时文件、rename 后**尽力** fsync 父目录（目录 fsync 不被文件系统支持时只告警，文件 fsync 失败 fail-closed）；`writeAtomicIfAbsent` 写失败清理本次调用创建的半写残骸（不删他人文件）——先 `closeSync` 再 `unlinkSync`、关完置 `fd = -1`（Windows 上文件句柄未关时 unlink 抛 EPERM/EBUSY，残骸留在缓存路径会被消费侧 `existsSync` 当成「已初始化」永久不自愈；置 -1 避免对复用的 fd 号二次 close）；内容读取与大小判定走同一 fd（`readFdRange` 单次分配的有界读取，读取字节数不超过 `fstat` 观测值）；`maxBytes` 只接受正的安全整数，其余值沿用「不设限」语义但必须告警；`ensureParent` 新建目录显式 `0o700`，已存在目录不 chmod。
- 状态、锁与青龙入口：跨进程锁（`run.log` 与通道健康）的陈旧回收改为「mtime 超龄**且**持有进程已确认退出」，锁内改写 `pid:starttime` 令牌供存活复核与 PID 复用判别——此前只看 mtime，被暂停 >10s 的存活进程锁会被第二个进程抢占；通道健康告警的网络 await 移出临界区（锁内只读改写、锁外发送），告警发送失败不再让其他轮次跳过健康更新。`--status` 复用生产的 `resolveCacheDirInRoot` 解析并打印生效目录（含根内校验与多级回退），此前硬编码默认目录，生产会拒绝并回退的状态被静默读成「缺失」；`--status` 对超限 `run.log`/诊断日志读尾部（不再整体不可见）、保留最近一轮时间戳并对中断轮标记「未正常结束」、`report.state` 的 `date` 按真实日期校验、`pending` 段按生产 `_loadReportState` 同口径校验（非法即判「状态损坏」，此前完全不看 `pending`，生产已判损坏并跳过日报更新的文件在 `--status` 里被读成健康）、通道健康逐条容错。青龙入口 `--dry-run` 改为一次性单轮执行（跑完即退出，0/1 对应本轮成败），依赖探测按 Node 解析口径、恢复改用冻结 `npm ci`、依赖名经 npm 包名白名单清洗后才拼入固定 `node_modules` 路径（非法名 fail-closed 抛错，消除把输入拼进 `path.join` 的形态），`--check` 的 Node 闸门按 `engines` 完整数值比较且常驻路径同源告警；单次入口的失败分类异常补诊断输出，8 个本地模块 `require` 纳入 `XBK_PROFILE=3` 画像。
- 变异与 CI 工具链：`scripts/mutation-json.js` 改为**单次 `open` + `fstat` 按 fd** 预检大小与文件类型再读（超限/非普通文件带路径拒绝，消除 `statSync`→`readFileSync` 的 check-then-use 竞态；此前尺寸守卫落在 `Buffer.concat` 分配峰值之后），预读上限改为生产策略值 2 GiB 并由 `XBK_MUTATION_REPORT_MAX_BYTES` 覆盖（`off` = 只留 Buffer 边界）；`scripts/mutation-report.js` 补陈旧（缓存回填）闸门（以本批报告最新 mtime 为基准，偏差超过 `MUTATION_REPORT_MAX_SKEW_MS`（默认 12h）的段判陈旧并拒绝发布，另加 wall-clock 年龄与本轮运行起点两层判定）与去重列表查询整体容错（含 15s `AbortSignal` 超时）；`run_mutation.js` 断点绑定指纹、缺失/不等即响亮丢弃——指纹覆盖「变异集 + 被变异源文件原文 + 参与判定的测试文件内容」三块输入（后两者本轮补入：只改测试文件、或等长改源码同样会让断点失效，避免旧断点的 killed/survived 被错记到别的候选；清单排序用显式码元序比较器而非随宿主 locale 变序的 `localeCompare`，指纹跨机器稳定）、未判定变异体计入非零退出、超时改杀整个进程组、默认变异目标补齐到与 CI 矩阵一致并加入三方对账门禁、沙箱注入 `PERF_MS=3000`；`scripts/check-deps.js` 探测清单改由 `package.json` 运行时声明派生、判定改「先 resolve 后 load」（区分「缺少」与「已安装但不可用」并输出根因）、补 Node 版本闸门（仓库与 re2 两处 `engines`，含 X-range 语义）与 `require.main` 守卫、`load` 与 `resolve` 统一以项目根为基准；`run_tests.js` 每套件硬超时（套件以 `detached` 自成进程组，超时按 `kill(-pid)` **整组杀伤**、派生后代一并清掉——此前只杀直接子进程，孤儿后代继续跑；超时按失败结算）、测试入口前置门纳入 `devDependencies`、两个入口汇总行补三数字格式；`scripts/install-hooks.js` 新增只读自检 `--verify`；`xbk_function_v3.js`/`xbk_sendNotify_slim.js` 变异行段同步重拆至 442 行（1 段全覆盖 `1-442`）/1634 行（`1-750` + `751-1634`，与 `.github/workflows/mutation.yml` 一致），行段回归用例改从矩阵自取行数。
- 文档与契约：版本闸门 `check-version.js` 升级为**四方一致**——基准取主文件头，`CHANGELOG.md` 最新、`package.json` 与新增的 `package-lock.json` 两处根元数据（顶层 `version` 与 `packages[""].version`）任一不符即红；锁文件两处字段缺失/形态异常 fail-closed（不给「字段读不到就跳过」留口），并显式要求补丁段为 `.0`（主文件头/CHANGELOG 处在 `x.y` 而 `package.json` 写成 `x.y.5` 这类「同 base 不同 patch」的漂移必须红）；「CHANGELOG 最新」改取版本号**最大值**（数值比较），倒序/顶插不再误红；订正 DNS 缓存 key 注释为 `hostname|family|hints|order`、`xbk_app` 不可达分支契约注释、`stryker.config.js` 里 html 报告的 Stryker 默认路径（`reports/mutation/mutation.html`）；README 同步 `--dry-run` 一次性语义、`--status` 缓存目录口径、Node 版本闸门与依赖预检口径、`api.timeout` 新口径与变异工具链环境变量。
