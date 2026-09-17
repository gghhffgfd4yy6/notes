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

- ReDoS 防护 `hasNestedQuantifier`：取反字符类 `[^...]` 改为扫描到未转义的类结束符（此前只判 `^` 后一个字符，类体被当普通模式解析——`[^(a+)+]x` 被误拦、`(x[^)]+)+` 因 `)` 被吞进类体而漏检；`[^]` 非空字符类语义不变）。
- 常驻循环 `sleep`：`signal` 加 `typeof` 守卫（此前传入非 AbortSignal 的真值对象会先抛 `TypeError`，定时器回调里再抛一次成为未捕获异常终止进程）；毫秒值统一经 `clampTimerMs` 钳到 `[0, 2147483647]` 再交给 `setTimeout`（此前 `1e12` 被 Node 静默降为 1ms，「等一天」变成立即返回）。
- 失败归类：`classifySummary` 的「本轮有无失败」只由 `failed` 决定（此前 `total` 缺失/非数字时 `Number(total)||0` 使有失败的摘要返回 `null`，被调度器读成成功）；企业微信 `93000`（invalid webhook key）与文本兜底 `invalid [webhook|access|api] token|key|parameter` 判为永久配置错误（此前落 `UNKNOWN`，常驻对已失效 webhook 无限退避重试）。
- 脱敏：`redact` 补齐 `Authorization: Bearer|basic <凭据>`、JSON 引号形态 `"appToken":"…"`、单引号/带引号关键字/非字符串 JSON 值/URL query 形态与裸 `Bearer|Basic <凭据>`，关键字表补 `password/pwd/session/cookie/credential`（此前这些形态的凭据原样进日志与告警，只抹掉 scheme）。凭据值以 `\s,;}&]` 为边界；裸 scheme 要求凭据 ≥8 字符，避免误抹普通英文句子（`the bearer of good news`）。
- TLS 预热：`prewarmTls` 的 `count` 补上界（钳到 64）——此前 `1e10`/`2^32` 让 `Array.from({length})` 抛 `RangeError` 整体 reject，略小的值则真的发起海量并发连接。
- 时间口径：运行异常告警正文的时间、RE2 缺 re2 提醒标记的保留期 cutoff 统一 `Asia/Shanghai`（此前前者随进程时区，后者与标记名基准被拆开，CI 的 UTC 下与 run.log/日报错开一天）。
- 变异工具链：报告 JSON 的 V8 字符串上限判定移到 `Buffer.concat` 之前（此前先付出分配峰值才发现放不下，且该护栏长期无法被测试触及）；变异日报段内容校验补 `files` 映射缺失/类型非法、`mutants` 非数组、零变异体三类 fail-loud（此前缓存回填的陈旧 artifact 会被当成 0 变异体的满分日报发布），`validateSegments` 的错误逐段带上原因；CLI 集成测试夹具改为真 stryker schema（补齐 `schemaVersion`/`thresholds`/`source`，并用 ajv 对齐厂商 schema 逐条自校），断言收紧到合计/分段统计值。
- 独立对抗审查跟进：脱敏再补引号包裹/带引号关键字/单引号/非字符串 JSON 值/URL query 等漏抹形态与关键字表（`password/pwd/session/cookie/credential`），并收掉本批新引入的 `the bearer of good news` 假阳性；变异体 `status` 改按厂商 schema 的 `MutantStatus` enum 校验（此前只要求「非空字符串」，`'Bogus'` 会被静默计入 `total`）；`refreshTimeoutError` 的归因按实际分支改写（NaN→回落默认、负值→按下界，不再一律说成「超出上限钳制」）；`sleep` 摘除侧守卫补断言（此前后变异掉也不会变红）；APP-05 用例改为快照-恢复，不再删掉共享缓存目录里的既有 `re2warn.state.*` 标记。

