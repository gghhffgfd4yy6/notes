# 系统契约

适用范围：个人青龙**单实例**部署。代码和测试是实现依据；以下规则改动前必须评估并补回归测试。

## 核心原则

1. 宁可重复推送，不可因失败提前写缓存而漏推。
2. 仅成功推送的消息进入缓存；失败消息下轮可重试。
3. 外部脏输入、安全风险和资源异常应防御；不为多实例等超出单实例边界的场景增加复杂度。

## 不变量

- **身份与去重**：身份只能由 `Utils.getMessageIdentity` 计算——有效 ID 优先，无 ID 用归一化后的有效 URL，两者皆无才用稳定匿名键；全部字段为空即无效身份，直接跳过。批内索引、磁盘缓存、墓碑与成功写入必须复用同一身份**及其等价判定**（`sameMessageIdentity` 等），不得在调用点另写一套比较规则。
- **缓存**：统一 `writeAtomic`（唯一临时文件 + `wx` 独占 + 0600 + rename，失败清理临时文件并回滚内存）；**写成功后才更新内存快照**；规则变更使过滤标记（`_f`）失效并重评，`filter.hash` 读失败或清理失败不得推进；被裁剪的身份在磁盘写成功后落墓碑；目录缺失可递归重建，初始化必须独占创建，不得以空数组覆盖并发写入。墓碑淘汰必须保证推进：无法通过淘汰达到字节上限时返回空、放弃本次持久化并告警，不得原地死循环。
- **缓存目录**：目录解析统一走 `xbk_message_store.resolveCacheDirInRoot`（无副作用、`fs`/`path` 由调用方注入），生产 getter 与青龙 `--status` 共用同一实现。候选目录须逐个通过根内校验（词法在根内 + 回溯到已存在层级并 realpath 校验，且该层级必须是目录），失败按默认目录 → `.xbk_cache_safe` → `.xbk_cache_safe_internal` 逐级回退，不得静默写穿项目根；`--status` 必须打印生效缓存目录，并在未采纳 `XBK_CACHE_DIR` 时提示「已自定义 `Config.cache.dir`」的部署用绝对路径指向该目录。
- **判重索引与缓存文件名**：身份索引的 O(1) 失效检查只看引用/长度/首元素引用，调用方**原地**改写非首元素它看不见（`missVerified` 会粘滞成 `has()` 恒 false）；未命中路径必须有界**旋转抽查**（引用层窗宽 32、身份层窗宽 2，n ≤ 8 时两窗覆盖全表、首次未命中即精确）并在本数组版本首次未命中时重建一次，但**不得每次未命中都全量复检**（5000 条批量判重会退化成 O(n²)）；自愈期间方向是「多推」，符合核心原则。启动清理只按**精确锁形状**匹配残留锁——`<缓存文件>.seen.lock`、精确相等的 `.seen.cleanup.lock`、`/^\.seen\.cleanup\.lock\.\d+\.\d+\.reclaim$/`——**绝不用子串包含**：否则合法缓存文件 `<name>.seen.cleanup.lock.json`（上游 pushUrl 末段恰为该名，`getFileName` 只补 `.json`）会被当作残锁静默删除，整份判重记录丢失、下轮全量重推。缓存文件名 `getFileName` 按来源分派转义使「URL 末段 → 文件名」单射（`.`-来源 → `url_`+名；`url_`-来源未带 `.json` → `url_`+名+`#`；`#` 先被 `/[?#]/` 截断，故不可能再作为来源参与映射），`getFilePath` 再对 >200 字节的名字附**全名摘要**（`Utils.anonKey`），使「长名 → 路径」单射（否则仅第 200 字节之后不同的两个 URL 会互相覆盖判重缓存）。
- **过滤与配置**：用户配置正则只允许经 RE2（`compileUserRegex`）；re2 缺失或模式不被 RE2 支持时该规则**跳过并告警**（每日一次），禁止回退 V8。新数值配置统一走 `Utils.num`（只做校验与回退默认，**范围与取整由调用点负责**）。新增过滤字段须同步 `FILTER_FIELDS` 与 `filterHash`（含 `pingbitime`、`zkt_gjc` 与时间过滤启用时的 UTC 日期）。过滤入口只接受编译产物：`checkFields` 收整份 `__compiled` 产物，`checkCategory`/`checkRegisterTime` 收字段级规则（`_type` 为字符串），形状不符一律**显式告警并保守放行**（不得静默全放行或误拦）；字段值非字符串时统一 `String()` 化（与 `matchesCompiled` 同口径），模式中检出零宽字符时告警。
- **推送**：无通道配置不得静默成功；部分通道成功即视为本轮成功；模板和链接必须走统一安全入口（`safeUrl` 与出口 HTML 清洗）；敏感信息不得进入日志；推送整体超时 10s，超时不写缓存、下轮重推，且超时错误顶层带 `code='PUSH_TIMEOUT'`。推送正文有 100000 字符硬上限：超出按 UTF-16 安全截断（不得按码元切断代理对）并告警，`push.contentMax` 不能越过该上限。推送层提供**可选**契约 `params.inFlightTracker`：`xbk_sendNotify_slim` 在启动各通道任务**前**写入 pending（未结算通道名数组）、每个通道 settle（含同步抛错）时移除；**不传该参数时零副作用**。Pusher 的 10s 整体超时归因必须**优先**取在飞清单（只标真正未结算的通道），空数组是有效状态（全部已结算），与「调用方不支持该契约」严格区分；两者都拿不到时才回退静态配置清单并补告警。HTML 清洗走 **HTML5 词法状态机**（标签起始须 `<`+ASCII 字母或 `/`；`</`+字母为端标签并**与普通起始标签同样解析属性、会记属性值开启引号**；`</`+非字母与 `<!`/`<?` 前缀**整段按文本跳过**——不进属性状态机、不记引号），不再用引号奇偶启发式——否则伪注释段内的引号能伪造「可保护属性对」，把真实 `onerror` 藏进占位符原样出网；事件属性与危险 URL 的剥离必须在**解码之后**，且出口门槛（`looksLikeHtmlEnvelope`，与渲染侧 contentType 判定同源、取宽松包络 fail-closed）与清洗必须作用于**同一份**串——`slim` 追加一言（HITOKOTO）之后的串才是清洗对象（此前出口看到追加前的纯文本→判非 HTML 不清洗，渲染侧看到追加后的串→判 HTML 并 contentType=2 原文送出）。
- **错误处理**：可重试错误保留重试机会；永久配置/权限/参数错误直接失败；终态 3xx（300–399）按**永久**归类（got 默认跟随重定向，外层可见的终态 3xx 只有 `followRedirect:false`、响应无 `Location`、304 三种情形，重试同一 URL 结果不变），且必须在数字 `code`、`providerCode`、`HTTP_` 前缀与 `statusCode` 四种承载字段上口径一致——不得同一状态码在两条路径上分类相反；空响应体（2xx 空体、仅 BOM、纯空白）单列 `ERR_EMPTY_BODY` 并按**可重试**归类（上游连上后未写体即结束属瞬时故障），非空但非 JSON 仍是 `ERR_BODY_NOT_JSON`（永久），两者不得共用一个码；请求层的不可重试判定必须同时看 HTTP 状态码**与错误码**：`PERMANENT_CODES`（JSON 契约/证书/URL 参数类）与请求层单列的确定性失败码（响应体超限 `EBODYLIMIT`，重试同一请求不会改变结果）在首次失败即抛，不得退避重试满 `api.retry`；未知错误码保持「保守重试」口径不变；重试退避必须先看服务端 `Retry-After`，且只认 RFC 9110 §10.2.1 明列的合法形态——`delta-seconds`（非负整数，且 ≤ 2^31-1 秒——超出与 `Infinity` 一律按非法形态处理）与三种 HTTP-date（IMF-fixdate、rfc850-date、asctime-date；asctime 无时区标记，必须补 GMT 再解析，且与 IMF-fixdate 一样交叉校验 day-name 与日期一致；**rfc850 是例外**：2 位年按 ECMAScript 的 50 年切点解释，既不交叉校验星期，也不校验真实日历日（`31-Feb-94` 这类不存在的日期被 `Date.parse` 溢出滚动接受）——既定遗留工单 T2，勿误读为「已校验」）；其余形态（空串、小数、负数、非日期文本、ISO-8601 等）一律回落指数退避，且**日志不得标注「按 Retry-After」**（不得把无效头谎报成有效来源）。命中时按其指示等待、不叠加抖动，与指数退避两条路径统一受 30s 上限保护，不得只按固定指数退避反复撞限流；告警、日报、日志、通道健康失败不得影响主流程，并**尽力**留痕到 `run.log`——日志路径非普通文件时写入被拒绝、底层写失败被静默吞掉，此时不保证留痕（见边界）。`summarizeError` 对调用方**承诺不抛异常**：自引用/超深失败结构按祖先环守卫与深度上限截断为可读标记，`failureInfo` 透传同样经过脱敏、折叠换行与截断。脱敏必须覆盖书写形态差异：`key=value`、`<关键字> = "值"`（含单引号）、`Authorization: Bearer|basic <凭据>`、JSON 引号形态（`"appToken":"…"`，值内含转义引号/反斜杠也要整体抹掉）、URL query 形态与非字符串 JSON 值；关键字表含 `password/pwd/session/cookie/credential` 等常见凭据键。**凭据值以 `\s,;}&]` 为边界**（逗号/分号/& 之后视为下一个参数，`token=a,b` 只抹 `a`）；无关键字的裸 `Bearer|Basic` 要求凭据 ≥8 个凭据字符，以免误抹普通英文句子。聚合摘要「本轮有无失败」只由 `failed` 决定，`total` 不参与该判定（缺失/非数字不得把失败读成成功）。
- **时间**：无时区日期按 UTC 解析。运行日志、台账与告警的时间戳固定按 `Asia/Shanghai` 输出（`YYYY-MM-DD HH:mm:ss`），与日报日界同口径，不随部署进程时区变化；RE2 缺 re2 提醒标记的保留期（7 天）同样按上海自然日计算，标记名与 cutoff 必须同基。
- **资源**：定时器可清理；异步任务有错误处理；临时文件失败清理；响应体累计上限 20 MiB；`run.log` 超 1 MiB 保留最新 512 KiB 尾部；ERROR 行只把 `errMsg` 段截断到 512 字符（时间戳与前缀不计入该上限，整行可超过 512）。数值型请求超时必须先校验再交给 HTTP 层：只接受 ≥100ms 的**整数**并钳到 `[100, 2147483647]` 毫秒，非整数、亚 100ms 与非正值一律回落默认 5000 并告警——Node 定时器会把 0/小数/超界值归一到约 1ms（每次请求瞬间超时），而亚 100ms 的值几乎只可能来自「想写秒却按毫秒填」的单位误填。`xbk_http.fetchJson` 在调用方未显式传 `timeout` 时注入默认 30000 ms 上限（显式值优先，对象形态原样透传）——got@11 默认 `timeout:{}` 且共享 Agent 不带超时，服务端半开时请求会永久挂起。常驻循环的等待与单轮刷新超时毫秒（`xbk_loop` 的 `clampTimerMs`）同样在交给 `setTimeout` 前钳到 `[0, 2147483647]`，且只接受真正具备 `addEventListener` 的 `signal`。
- **文件安全**：读路径防符号链接（`O_NOFOLLOW` + 读后 dev/ino 复检 + 缓存目录 realpath 校验 + basename 清洗），且内容读取与大小判定走同一 fd（有界读取，读取字节数不得超过 `fstat` 观测值）；写路径拒绝非普通文件，并用唯一临时文件 + `wx` + fsync + rename（rename 后再尽力 fsync 父目录）；**写路径存在已记录、接受不修的 TOCTOU 窗口**（校验与实际写入之间，见边界）。读失败时写侧 fail-closed，不得以空状态覆盖。空字符串路径显式判为不安全并拒绝（不得依赖 `lstatSync('')` 的 ENOENT 判成「不存在即安全」）；`readSafeText` 必须把 `maxBytes` 透传给 `readSafeTextResult`；`maxBytes` 只接受正的安全整数，其余值（含 0/负数/字符串数字）沿用「不设限」语义但**必须告警**，不得静默。
- **入口**：青龙入口 `--dry-run` 只跑一轮即退出（一次性诊断，退出码 0=单轮成功 / 1=单轮失败，**不做退避重试**；要「常驻但不推送」用不带本参数的环境变量 `XBK_DRY_RUN=1`）；`--status` 刻意不加载应用配置——入口顶层与 `xbk_message_store`、`xbk_failure_policy`、`xbk_loop`、`scripts/status`、`xbk_storage` 均不 require `got`/`re2`，缺依赖时仍可用，`--check` 对 `got`/`re2` 可加载性的探测属检查项本身（缺依赖即报 ❌ 并置退出码 1）；未识别参数只告警、不拒绝启动。

## 边界

- 多实例不保证最多推送一次；这是单实例项目的明确限制（缓存数据文件无跨进程锁，仅墓碑、`run.log`、RE2 缺依赖标记、通道健康状态四处有互斥锁）。这四处锁的陈旧回收必须复核持有进程存活：`lock文件` 的 mtime 超龄**且**持有进程已确认退出（`/proc` 启动时钟可验则防 PID 复用）才可抢占，持有进程仍存活时绝不回收；临界区内不得跨越网络 await——通道健康告警发送与状态清零在锁外进行，锁内只做「读-判-写」。通道**恢复**告警在锁内以**唯一认领令牌 + 60s 租约**原子认领：重叠运行见到租约内的认领不得重复入队且须原样保留认领字段，发送失败在锁内释放认领（保留 pending，下一轮即刻可重发，不必等租约到期），确认送达后清零时令牌必须仍属本次尝试（迟到的成功不得清掉后继尝试重新认领的 pending），超租约的陈旧认领可被接管。
- 超时结果不确定时允许重推，优先避免漏推。
- 内存快照为权威：仅在首次命中时探测一次外部删除并尝试原子恢复；外部内容修改不感知。
- 原子写的持久性边界：`writeAtomic` 在 rename 前 fsync 临时文件、rename 后**尽力** fsync 父目录（目录 fsync 不被文件系统支持时只告警，不判失败）；文件 fsync 失败 fail-closed（删 tmp、返回 false）。文件系统若不诚实回报 fsync（如部分 FUSE/外置卡），掉电持久性仍无保证。
- `writeAtomicIfAbsent` 的残余风险：`wx` 直写真实路径、无原子提交点（本机 FUSE 不支持硬链接，无法用 tmp+link 提交），写失败会删除本次调用创建的残骸（**必须先 close 本进程持有的 fd 再 unlink**：Windows 上句柄仍打开时 unlink 抛 EPERM/EBUSY，残骸留在缓存路径会被消费侧 `existsSync` 当成「已初始化」而永久不自愈；close 后置 `fd=-1`，避免 finally 兜底二次 close 关掉被复用的无关 fd）；但进程被 SIGKILL 在写入中途杀死时仍可能留下半写文件，且下次调用无法区分「他人有效文件」与「自己的残骸」（消费侧 `_ensureFileExists` 按「存在即已初始化」早退），仍需人工删除。
- 写路径接受 TOCTOU 窗口：`isRegularOrMissing` 校验与 `renameSync` 之间、以及缓存目录 realpath 校验与每次写入之间均存在竞态，中间目录在窗口内被替换为符号链接时可指向项目根外；攻击者需先具备项目根/缓存目录写权限，单实例 cron 信任本地文件系统，代码内已明确记录为「已知取舍，不修」（`xbk_storage.js`）。
- 日志没有兜底 sink：日志路径被判定为非普通文件、或写入因只读/权限失败时，记录会被静默丢弃（不影响主流程）。
- 缓存目录权限：`xbk_storage.ensureParent` 新建目录显式 `0o700`（与文件 `0o600` 同口径，不再随 umask）；已存在的目录不做 `chmod`（部署侧既有权限不被本模块改写），且 `xbk_message_store` 首建缓存目录的独立分支不在本口径内（跨模块权限模型另行处理）。
- 顺序推送末条等待等微小开销不为优化而改变行为。
- 常驻循环默认只记录、不抛出：调用方未提供 `onError` 时按「单轮失败」打日志，未提供 `onIntervalError` 时按「性能预热失败」打日志，两者不得互相回落归因（预热失败不得被标成单轮失败）。
- 单轮 `run()` 既无单轮超时也不接收 `signal`：单轮挂起时 `runLoop` 无法响应停止信号（已登记，引入看门狗属推送结果语义决策）。
- 线报接口的 DNS 预热不接取消信号；缓存/pending key 含**影响结果选择的选项**——`hostname|family|hints|order`（`dnsCacheKey`）；选项超出建模范围（未知键、非法 family/hints/order 取值）时该调用**不读也不写缓存**、按调用方原选项直接解析，宁可少一次命中也不复用按别的选项筛选/排序过的地址。预热经 `productionLookupOptions()` 与真实请求**同源取值**（family 未指定 → `hints=dns.ADDRCONFIG`，指定 → family 4|6 且 `hints=0`），故三种部署模式下预热与真实请求同 key；`all` 只决定回调形状、不进 key。**不得**为「让预热命中」而把 key 收敛回 `hostname|family`：条目里存的是按调用方选项筛选/排序后的地址，key 少选项会让真实请求在 TTL 内复用不匹配的地址（选择逻辑不再执行，还可能选中本应排除的地址）；也不在 JS 侧复现 getaddrinfo 语义（平台 AI_ADDRCONFIG 与 `os.networkInterfaces()` 结果不一致，无法忠实复现）。`readMessages` 返回内部权威数组的同一引用，调用方必须视为只读。

## 修改检查

- 改判重、缓存、过滤、推送、网络、配置或文件存储：补针对性测试并运行 `npm run check`（= lint → 版本闸门 → 变异行段校验 → `npm test`）。
- 改 `xbk_function_v3.js` / `xbk_sendNotify_slim.js` 等带行段的文件：同步重拆 `.github/workflows/mutation.yml` 行段并跑 `node scripts/check-mutation-ranges.js`。
- 改 CI 变异运行方式：`mutation.yml` 的矩阵按段选 runner（`config` 字段）——16 段 `stryker.tap.config.js`（TAP + `coverageAnalysis:'perTest'`，报告落 stryker 默认 `reports/mutation/`），**仅 `storage` 段留 `stryker.config.js`**（command）。原因：TAP 档下「变异体导致被测进程崩溃」（`xbk_storage.js` 的 `fd = -1` 哨兵被 UnaryOperator 改成 `+1` ⇒ finally 里 `closeSync(1)` 关掉 stdout）会被 tap-runner 记为 **RuntimeError** 而非 Killed，是该 runner 的语义损失，不得用 shim 包装 `closeSync` 掩盖；这 3 段 score 因此与其余 16 段**不同口径**（未覆盖计入 Survived 而非 NoCoverage），跨段比较必须排除。改 tap 配置或矩阵时同步 `test_ci_skip_suites.js` 的缓存 key 断言并跑 `node scripts/check-mutation-ranges.js`（矩阵解析器允许条目有额外字段）。
- 增删 `test_*.js` 或改 `test.yml` 显式步骤：同步 `test_suites.js` 与 `SKIP_SUITES`（由 `test_suite_registry.js`、`test_ci_skip_suites.js` 对账）。
- 改版本：同步主文件头**首行**、`CHANGELOG.md`（最新取版本号**最大值**，不按文件位置）、`package.json`（补丁段必须为 `.0`）、`package-lock.json` 的**两个**根版本字段（顶层 `version` 与 `packages[""].version`）——现为**四方一致**，任一缺失或形态异常即 fail-closed，不允许「字段读不到就跳过」绕过门禁（`node check-version.js` 闸门）。
- 改行为/配置/契约：同步更新 `README.md` 与本文件，避免文档与实现漂移。
- 破坏性 Git 操作先备份；密钥与本地配置绝不提交。
