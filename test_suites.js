'use strict'
const fs = require('node:fs') // 仅供下方「注册表自身不得含用例」的加载期扫描（读自身源码）
// 测试套件清单：run_tests.js 和 run_unit_tests.js 共用
//
// C5-074（命名口径）：本文件名形如 test_*.js，但它**不是测试套件** —— 0 断言、只导出 SUITES，故在
// test_suite_registry.js 的 REGISTRY_EXEMPTIONS 里以「注册表自身」显式豁免。改名要同步 7 处 require
// （run_tests / run_unit_tests / run_mutation / test_ci_skip_suites / test_suite_registry /
// stryker.tap.config / scripts/tap-shim）+ run_mutation.js 的两处字面文件名清单，代价与收益不成比例
// ⇒ 保留名字，改用下方「注册表不得含用例」的加载期门禁让豁免前提自证（0 断言这件事由代码而非注释保证）。
// integration: true 表示集成测试（慢/可能有网络），单元测试入口（run_unit_tests.js）会跳过
// mutationSkip: true 表示在 Stryker 沙箱内无法运行（被 --mutate 目标插桩后行数膨胀，
//   导致 test_mutation_ranges/check-mutation-ranges 的行段元校验误报），同样由单元入口跳过
//
// ⚠️ 被标记 integration / mutationSkip 的套件不会进入 run_unit_tests.js，
//    因此必须在 .github/workflows/test.yml 中显式列出对应步骤，否则将脱离 CI 门禁
//    （相关代码回归可通过 PR，历史上多次发生）。反之，未标记的套件由 run_unit_tests.js
//    统一执行，CI 中即便不再单独列出也不会漏网。
const SUITES = [
  { name: '依赖预检', file: 'test_check_deps.js', desc: 'checkDependencies 缺失/损坏分支' },
  { name: '常驻循环', file: 'test_loop.js', desc: '长驻调度、单轮异常隔离、停止信号', integration: true },
  { name: '循环工具函数', file: 'test_loop_utils.js', desc: 'sleep 信号/超时边界 + runLoop TypeError/错误隔离' },
  { name: '安全文件存储', file: 'test_storage.js', desc: '原子写入/独占创建/安全读取/符号链接拦截' },
  { name: '常驻失败策略', file: 'test_failure_policy.js', desc: '网络/永久错误分类、持续退避重试、摘要失败和恢复' },
  { name: 'DNS失效回归', file: 'test_dns_cache.js', desc: '连接错误后清除主机 DNS 缓存并重新解析', integration: true },
  { name: 'TLS预热回归', file: 'test_tls_prewarm.js', desc: 'TLS 预热 aggregate ok 与连接成功数保持一致', integration: true },
  { name: '延迟加载回归', file: 'test_lazy_notify.js', desc: '验证接口请求先于推送模块加载', integration: true },
  { name: 'Agent辅助函数', file: 'test_agents.js', desc: 'DNS 失效判定/profile 计时/请求选项/缓存清理' },
  { name: '网络重试', file: 'test_network.js', desc: 'fetchData 重试/4xx 例外/retry 非法值兜底' },
  { name: 'HTTP封装', file: 'test_http.js', desc: 'fetchJson 响应体限流/HTTP 错误/JSON 解析' },
  { name: '推送工具函数', file: 'test_sendnotify_utils.js', desc: 'mdToPlain/脱敏/安全截断/通道统计 + 失败聚合形状/channelError 状态码优先级/WxPusher 退避算术与时间窗边界/abort 监听器卫生' },
  { name: '推送层Pusher', file: 'test_pusher.js', desc: 'createPusher 超时分支+failures构造 + htmlTagNameEnd/isTagNameBoundary 纯函数边界' },
  { name: '青龙命令行', file: 'test_cli.js', desc: '--check/--dry-run/--status 参数和诊断逻辑', integration: true },
  { name: '青龙工具函数', file: 'test_qinglong_utils.js', desc: '退避/刷新计数/间隔/依赖恢复边界/缓存目录' },
  { name: '青龙常驻', file: 'test_qinglong_resident.js', desc: 'refreshConnections DNS/TLS 预热 mock + runResident 正常/permanent/可重试退避', integration: true },
  { name: '青龙诊断', file: 'test_qinglong_runcheck.js', desc: 'runCheck 全部通过/过滤警告/init失败/无通道/无方法 五种返回码', integration: true },
  { name: '状态面板', file: 'test_status.js', desc: '--status 只读聚合运行状态', integration: true },
  { name: '状态报告解析', file: 'test_status_report.js', desc: 'scripts/status.js parseLastRun 多行取最后匹配 + parseDiagnostics 跳过损坏行 + formatStatus 降级' },
  { name: '规则引擎校验', file: 'test_rules.js', desc: 'xbk_rules.js 嵌套量词检测/pingbitime 首尾空白/缺少分隔符' },
  // C5-073（口径登记，**不合并套件**）：套件边界按**文件**切而非按职责切 —— 本文件与 test_utils_pure.js
  // 同测 xbk_utils.js。「每条门禁起进程」只在**套件**粒度成立（run_tests.js / run_unit_tests.js 每个套件
  // 一个子进程；本文件自身 0 次 spawn、131 行）。实测 37 条断言，其中约 11 条为本套件独有（8 条无引号
  // srcset 多候选 + 3 条 CSS 转义上下文），其余与 test_utils_pure.js 重叠。合并两套件必须同步
  // stryker.tap.config.js 的 testFiles 显式清单（逐元素含顺序），而收益只是每轮少一个子进程
  // ⇒ 保留现状并在此登记口径（desc 不再写「9 个纯函数分支」这种与实际断言数无关的说法）。
  { name: '工具函数', file: 'test_utils.js', desc: 'xbk_utils.js 37 条断言（parseTime 11/CSS 转义 6/无引号 srcset 多候选 8/safeErrorText 3/filterHash 9）；与 test_utils_pure.js 重叠约 26 条，独有约 11 条' },
  { name: '工具函数纯函数扩展', file: 'test_utils_pure.js', desc: 'xbk_utils.js add0/daysFrom/num/safeText/safeGet/truncateUtf16/isDangerousUrl/validUrl/normUrl/anonKey 等纯函数边界（提升变异分数）' },
  { name: '格式化器', file: 'test_formatter.js', desc: 'xbk_formatter.js HTML→Markdown转换+模板替换+内部方法边界（提升变异分数）' },
  { name: '规则引擎扩展', file: 'test_rules_extended.js', desc: 'xbk_rules.js compileRules/matchesCompiled/checkTimeCompiled/validateConfig 边界（提升变异分数）' },
  { name: '消息存储纯函数', file: 'test_message_store_utils.js', desc: 'xbk_message_store.js getFilePath/getFileName 路径安全与URL提取边界（提升变异分数）' },
  { name: '通知纯函数', file: 'test_sendnotify_pure.js', desc: 'xbk_sendNotify_slim.js 纯函数边界 + 九通道响应判定/传输错误/结构异常/限频窗口与退避/profile 归因（提升变异分数）' },
  { name: '推送响应体上限', file: 'test_sendnotify_bodylimit.js', desc: 'xbk_sendNotify_slim.js $.post 流式响应体上限（EBODYLIMIT/销毁流）+ 无 stream 替身回退 promise 路径 + 官方 got 回环端到端' },
  { name: '单元测试', file: 'test_filter.js', desc: '主代码导出函数逐函数逻辑' },
  { name: '变异报告读取', file: 'test_mutation_json.js', desc: '超大 mutation.json 剥离 statusReason 解析（v3.264）' },
  { name: '变异报告渲染', file: 'test_mutation_report.js', desc: 'render 函数 markdown 输出快照（v3.266 重构验证）' },
  { name: '本地变异禁令', file: 'test_local_mutation_guard.js', desc: 'npm/直跑入口 fail-closed、放行开关与文档禁令（用户指示本机不跑变异）' },
  { name: '变异报告CLI', file: 'test_mutation_report_cli.js', desc: 'scripts/mutation-report.js main() 入口：无参数/不存在目录/有效目录 3种子进程场景' },
  // 审查 F6：.github/analyze-artifacts.js 此前无任何测试/CI 覆盖，失效常量（硬编码行数阈值）无人守护
  { name: '变异产物分析', file: 'test_analyze_artifacts.js', desc: '.github/analyze-artifacts.js 子进程：目录缺失/空目录/坏报告/合法报告 + V3 存活统计与实际行数' },
  { name: '变异调度器', file: 'test_run_mutation.js', desc: 'generateMutants 词法扫描/注释字符串跳过 + extractTestSummary 输出解析' },
  { name: '变异内部函数', file: 'test_run_mutation_internal.js', desc: 'lineColumn/isIdent/lineTriple/numberBefore/numberAfter/mapLimit/saveCheckpoint/loadCheckpoint/copyProject/applyMutants 11个内部函数' },
  { name: '变异运行时', file: 'test_run_mutation_cli.js', desc: 'run_mutation.js runTests（通过/失败/超时）+ evaluate（复制项目→应用变异→运行测试→清理）' },
  { name: '变异超时竞态', file: 'test_run_mutation_race.js', desc: 'runTests 超时兜底/close 透传注入式回归' },
  { name: '变异范围校验', file: 'test_check_mutation_ranges.js', desc: 'check-mutation-ranges.js 子进程：全覆盖/漏测/不连续/越界 exit code', mutationSkip: true },
  { name: '变异范围', file: 'test_mutation_ranges.js', desc: '生产模块及行段必须完整纳入 mutation 矩阵', mutationSkip: true },
  { name: 'CI跳过清单对账', file: 'test_ci_skip_suites.js', desc: 'SKIP_SUITES ↔ test.yml 显式步骤双向一致 + 入口过滤/summary 行为 + test_app.js --only 过滤契约' },
  { name: '注册表对账', file: 'test_suite_registry.js', desc: '根目录 test_*.js ↔ SUITES 双向一致（漏注册/幽灵条目/白名单陈旧）' },
  { name: '主机干净度接线', file: 'test_host_clean_gates.js', desc: 'check:host-clean 入口 guard（run_tests + run_unit_tests）+ 子进程跳过/过期沙箱/reparent 判据不回退 + 挂死夹具 90s 有界自杀' },
  // mutationSkip（v3.280）：本套件断言 .githooks/pre-commit、pre-push 与 test.yml 的接线内容，
  // 而变异沙箱（copyProject）不复制 .githooks/ ⇒ 沙箱内必 ENOENT 假红（同 test_install_hooks 的
  // 登记先例）。CI 覆盖由 test.yml 的显式步骤「静态扫描接线断言」承担。
  { name: '静态扫描接线', file: 'test_ci_static_gates.js', desc: 'check:ci-static 三处接线（check 链 / pre-commit 第4道 / test.yml 步骤）内容断言 + 首轮扫描修复不回退', mutationSkip: true },
  // mutationSkip（v3.281）：同 test_ci_static_gates 的理由——本套件断言 `.githooks/pre-commit` 与
  // `test.yml` 的接线内容，而变异沙箱不复制 `.githooks/` ⇒ 沙箱内必 ENOENT 假红。
  // CI 覆盖由 test.yml 的显式步骤「文档行长接线断言」承担。
  { name: '文档行长接线', file: 'test_doc_line_gates.js', desc: 'check:doc-lines 三处接线（check 链 / pre-commit 第5道 / test.yml 步骤）内容断言 + 阈值与空扫描面 fail-closed 口径不回退', mutationSkip: true },
  // mutationSkip（PR #156 起）：本套件的 pre-push 端到端用例要读**仓库的** `.githooks/pre-push`
  // 并真跑 npm + git worktree，而变异沙箱（run_mutation.copyProject）只复制 scripts/qinglong/.github
  // 与各 test_*.js/xbk_*.js，不复制 `.githooks/` ⇒ 在沙箱内必然 ENOENT，使「沙箱内单元测试应整体通过」
  // 断言假红（test_run_mutation_cli.js）。同时本套件不覆盖任何被变异文件（它只测 scripts/install-hooks.js），
  // 每个变异批次都跑一遍纯属白耗时间，故按本文件的 mutationSkip 语义排除；CI 覆盖由 test.yml 的显式步骤承担。
  { name: 'Hooks 自检', file: 'test_install_hooks.js', desc: 'scripts/install-hooks.js --verify 只读自检 + pre-push 门禁对象端到端用例（快路径/隔离/fail-closed）', mutationSkip: true },
  { name: 'Release tag 校验', file: 'test_tag_validator.js', desc: 'tag semver 正则与 release.yml 逐字同源断言' },
  { name: '版本闸门', file: 'test_check_version.js', desc: 'check-version.js 四方一致性 + 补丁段必须 .0（qodo #143-4 回归，夹具驱动）' },
  // v3.172：集成测试走并行调度器（worker 独立缓存目录 + 失败片串行重跑）。
  // 需要完整串行验证时直接 node test_app.js（CI 即如此）
  { name: '集成测试', file: 'test_app_p.js', desc: 'App.run 完整主流程(并行调度,失败自动重跑)', integration: true },
  // C5-008 登记（有此条即口径，勿再当「漏接线」重开）：本套件是 1600 行 integration 套件，被
  // run_unit_tests.js（UNIT_SUITES 过滤 integration/mutationSkip）与 TAP 档的显式清单（同口径过滤）
  // 两档排除 ⇒ **对变异门禁零贡献**，只在 test.yml 的显式步骤「通道测试（test_notify.js）」里跑。
  // 这是有意的测试集边界（同 test_app.js / test_app_p.js 不进变异集，已知边界见 AGENTS.md），不是接线漏项。
  // 代价：本套件独有的通道分支零变异覆盖 —— 新增/改动通道判定时，请在 test_sendnotify_pure.js 补等价
  // 单元断言（先例：isCode 的 String 侧由 SNB-09 在单元档击杀，不依赖本套件）。
  { name: '通道测试', file: 'test_notify.js', desc: '推送通道请求构造+脱敏', integration: true },
  // v3.276 补：xbk_app.js 此前无任何单元套件（test_app.js 是集成套件、不进变异测试集），
  // 其报告/状态簇的存活变异体无人认领。本套件在**进程内**用最小桩构造 createApp(...) 后直接
  // 调用目标方法（不走子进程 ⇒ 可被变异测试的 perTest 覆盖归因）。
  // C5-083（口径）：desc 此前只列 3 个方法（_isValidReportDate/_loadReportState/_normalizeReportState），
  // 与套件的真实覆盖严重不符 —— 实测 243 例，覆盖报告/状态、日志写入、告警/模板三大簇 + RE2 警告标记
  // 生命周期 + 通道健康降级 + 覆盖文件按轮生效。desc 按簇列出，避免读者把它当成「只测 3 个方法」。
  { name: '应用状态与日报单元', file: 'test_app_unit.js', desc: 'xbk_app.js 进程内 243 例：报告/状态簇（_isValidReportDate/_blankReportState/_safeCounter/_normalizeReportState/_loadReportState/_reportToday/_persistReportState）+ 日志写入簇（_writeRunLog/_warnLowDisk/_writeState/_writeTextAtomic/_isRegularOrMissing/_localStamp）+ 告警/模板簇（_enabledFlag/_validateTplConfig/_accumulateReport/_sendCrossDayReport/_updateReport/_sendAlert）+ RE2 警告标记生命周期/通道健康降级/PID 复用/覆盖文件按轮生效 FR-1..3/DR-1 dry-run' },
  // G11：scripts/audit-gate.js 是 fail-closed 安全门禁（v3.276 续 / PR #194 引入），此前**零测试**
  // ——只在 test.yml:218 被 `node scripts/audit-gate.js` 调用过，仓库里没有任何断言指向它。
  // 于是「豁免只针对 GHSA-CH52-4W7C-C8XP、其余高危一律拦」这条契约无人守护：放宽 ALLOWED_ADVISORIES、
  // 把 every 写成 some、把「schema 漂移即拒」改成静默放行，CI 都不会红。
  // 注册口径：不设 integration / mutationSkip ⇒ 进 run_unit_tests.js 与 TAP 变异测试集；本套件是
  // 约 10 次 spawn 的子进程夹具套件（≈2-3s，照 test_analyze_artifacts.js 先例），增量可接受。
  // ⚠️ 但它测的 audit-gate.js 不是 mutation 矩阵的 mutate 目标、子进程断言也拿不到 TAP perTest 归因
  // ⇒ 这 10 条买的是「门禁不被静默改坏」的回归保护，**不是**变异分数（该口径在套件文件头同样登记）。
  { name: '安全审计门禁', file: 'test_audit_gate.js', desc: 'scripts/audit-gate.js 子进程：夹具缺失/非法 JSON/schema 漂移四态/大小写 severity/豁免显形带理由/间接链三类断链/every 口径/GHSA 归一' },
  // v3.284：scripts/console.js 网页控制台。同 G11 先例——console.js 不在 mutation 矩阵
  // （只读编排层，无核心算法；HTTP/spawn 编排对变异测试价值低），本套件买的是行为契约回归保护。
  // 不设 integration：触发用例拉起的是 `--check`（只做环境检查、秒级、不碰网络业务），
  // 单元入口可跑。不设 mutationSkip：套件不读 mutation.yml/.githooks，沙箱内可运行。
  { name: '网页控制台', file: 'test_console.js', desc: 'scripts/console.js token fail-closed/单飞锁（损坏锁保守+陈旧接管）/动作解析/HTML 转义/HTTP 端到端（401/看板降级/202/409/锁生命周期/404）' },
  { name: '通知自检', file: 'test_notify_selfcheck.js', desc: '--notify-test 直跑自检：argv/env 互斥/HITOKOTO 抑制与恢复/单次广播/消息固定形态/退出码 0 与 1/脱敏出口形态（进程内 mock 注入，零真实网络）' },
  // S1-store：过滤规则覆盖文件存储层（xbk_filter_store.js）。纯同步、临时 cacheDir 驱动，
  // 不 require xbk_function_v3、不触碰 Config.filter ⇒ 进单元入口与 TAP 变异测试集。
  { name: '过滤规则存储', file: 'test_filter_store.js', desc: '覆盖文件校验五道闸（白名单/schema/revision/长度/控制字符、### 行语法、嵌套量词与 RE2、编译对账、整份字节预算；末道只约束保存入参）+ 默认合并/last-known-good 降级/生效快照往返/路径 helper' }
]

// 注册表自身的加载期形状校验：本文件被 run_tests.js / run_unit_tests.js / run_mutation.js 与
// stryker.tap.config.js 直接 require，加载即执行。test_suite_registry.js 的「漏注册 / 幽灵条目」双向对账
// 只比 file **集合**，看不见另外两类漏网情形——① 条目缺 name/desc（汇总行会渲染成 undefined，且
// 不进变异 testFiles 对账的 file 维度：它按 file 推导，仍会「通过」）；② 重复注册同一文件/同名套件
// （同一套件被跑两次、汇总/日报无法区分）。这两类必须在注册表加载处响亮失败——照抄对照
// stryker.tap.config.js 的加载期 throw 口径（不一致即 throw，而非静默少跑/重跑）。
{
  const badShape = SUITES.filter(s => !s || typeof s.name !== 'string' || !s.name ||
    typeof s.file !== 'string' || !/^test_.*\.js$/.test(s.file) || typeof s.desc !== 'string' || !s.desc)
  if (badShape.length) {
    throw new Error('test_suites.js 注册表条目缺字段：每条必须同时有非空 name/file/desc 且 file 形如 test_*.js；' +
      `问题条目：${badShape.map(s => (s && s.file) || JSON.stringify(s)).join(', ')}`)
  }
  const files = SUITES.map(s => s.file)
  const dupFiles = [...new Set(files.filter((f, i) => files.indexOf(f) !== i))]
  if (dupFiles.length) throw new Error(`test_suites.js 重复注册同一文件（该套件会被执行两次）：${dupFiles.join(', ')}`)
  const names = SUITES.map(s => s.name)
  const dupNames = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  if (dupNames.length) throw new Error(`test_suites.js 存在重复的套件名（汇总/日报无法区分）：${dupNames.join(', ')}`)
}

// C5-074：注册表自身**不得**含用例（fail-closed）。这条门禁让 test_suite_registry.js 白名单里
// 「注册表自身，不是测试套件（0 断言）」这个豁免前提由代码保证，而不是靠注释自觉：
//   * run_tests.js / run_unit_tests.js 只跑 SUITES 里 file 指向的文件；stryker.tap.config.js 的
//     tap.testFiles 是同一份推导 ⇒ 本文件里的任何用例**永远不会被执行**；
//   * 而 test_suite_registry.js 又把它列进 REGISTRY_EXEMPTIONS（不注册自己）⇒ 没人会红。
// 也就是说「往注册表里加个用例」= 静默零运行。扫描用的是**行首**判定（trim 后以用例注册器开头），
// 不会命中本块自身或注释：真实的用例文件里调用也都在行首/缩进首位。
{
  const CASE_LINE_RE = /^\s*(?:await\s+)?(?:check|checkAsync|test|describe|it)\s*\(/
  const caseLines = fs.readFileSync(__filename, 'utf8').split(/\r?\n/) // nosemgrep（读的是本文件自身，非外部输入）
    .map((text, i) => ({ text: text.trim(), no: i + 1 }))
    .filter(x => CASE_LINE_RE.test(x.text))
  if (caseLines.length) {
    throw new Error('test_suites.js 是**注册表**不是测试套件（它被 test_suite_registry.js 白名单豁免，' +
      '也不在任何 runner 的执行清单里）⇒ 把用例写在这里永远不会被执行，等于静默零运行。' +
      '请把用例挪到独立的 test_*.js 并注册进 SUITES。命中的用例行：' +
      caseLines.map(x => `:${x.no} ${x.text.slice(0, 60)}`).join(' / '))
  }
}

module.exports = { SUITES }
