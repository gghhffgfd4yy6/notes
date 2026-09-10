'use strict'
// 测试套件清单：run_tests.js 和 run_unit_tests.js 共用
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
  { name: '推送工具函数', file: 'test_sendnotify_utils.js', desc: 'mdToPlain/脱敏/安全截断/通道统计' },
  { name: '推送层Pusher', file: 'test_pusher.js', desc: 'createPusher 超时分支+failures构造 + htmlTagNameEnd/isTagNameBoundary 纯函数边界' },
  { name: '青龙命令行', file: 'test_cli.js', desc: '--check/--dry-run/--status 参数和诊断逻辑', integration: true },
  { name: '青龙工具函数', file: 'test_qinglong_utils.js', desc: '退避/刷新计数/间隔/依赖恢复边界/缓存目录' },
  { name: '青龙常驻', file: 'test_qinglong_resident.js', desc: 'refreshConnections DNS/TLS 预热 mock + runResident 正常/permanent/可重试退避', integration: true },
  { name: '青龙诊断', file: 'test_qinglong_runcheck.js', desc: 'runCheck 全部通过/过滤警告/init失败/无通道/无方法 五种返回码', integration: true },
  { name: '状态面板', file: 'test_status.js', desc: '--status 只读聚合运行状态', integration: true },
  { name: '状态报告解析', file: 'test_status_report.js', desc: 'scripts/status.js parseLastRun 多行取最后匹配 + parseDiagnostics 跳过损坏行 + formatStatus 降级' },
  { name: '规则引擎校验', file: 'test_rules.js', desc: 'xbk_rules.js 嵌套量词检测/pingbitime 首尾空白/缺少分隔符' },
  { name: '工具函数', file: 'test_utils.js', desc: 'xbk_utils.js 日期解析/CSS转义/safeErrorText/filterHash 9个纯函数分支' },
  { name: '工具函数纯函数扩展', file: 'test_utils_pure.js', desc: 'xbk_utils.js add0/daysFrom/num/safeText/safeGet/truncateUtf16/isDangerousUrl/validUrl/normUrl/anonKey 等72项纯函数边界（提升变异分数）' },
  { name: '格式化器', file: 'test_formatter.js', desc: 'xbk_formatter.js HTML→Markdown转换+模板替换+内部方法边界（47项，提升变异分数）' },
  { name: '规则引擎扩展', file: 'test_rules_extended.js', desc: 'xbk_rules.js compileRules/matchesCompiled/checkTimeCompiled/validateConfig 29项边界（提升变异分数）' },
  { name: '消息存储纯函数', file: 'test_message_store_utils.js', desc: 'xbk_message_store.js getFilePath/getFileName 27项路径安全与URL提取边界（提升变异分数）' },
  { name: '通知纯函数', file: 'test_sendnotify_pure.js', desc: 'xbk_sendNotify_slim.js maskKey/maskUrl/safeSlice/safeErr/mdLinksToPlain/mdImagesToPlain/mdToPlain/looksHtml/stripAngleTags 63项纯函数边界（提升变异分数）' },
  { name: '单元测试', file: 'test_filter.js', desc: '主代码导出函数逐函数逻辑' },
  { name: '变异报告读取', file: 'test_mutation_json.js', desc: '超大 mutation.json 剥离 statusReason 解析（v3.264）' },
  { name: '变异报告渲染', file: 'test_mutation_report.js', desc: 'render 函数 markdown 输出快照（v3.266 重构验证）' },
  { name: '变异报告CLI', file: 'test_mutation_report_cli.js', desc: 'scripts/mutation-report.js main() 入口：无参数/不存在目录/有效目录 3种子进程场景' },
  { name: '变异调度器', file: 'test_run_mutation.js', desc: 'generateMutants 词法扫描/注释字符串跳过 + extractTestSummary 输出解析' },
  { name: '变异内部函数', file: 'test_run_mutation_internal.js', desc: 'lineColumn/isIdent/lineTriple/numberBefore/numberAfter/mapLimit/saveCheckpoint/loadCheckpoint/copyProject/applyMutants 11个内部函数' },
  { name: '变异运行时', file: 'test_run_mutation_cli.js', desc: 'run_mutation.js runTests（通过/失败/超时）+ evaluate（复制项目→应用变异→运行测试→清理）' },
  { name: '变异范围校验', file: 'test_check_mutation_ranges.js', desc: 'check-mutation-ranges.js 子进程：全覆盖/漏测/不连续/越界 exit code', mutationSkip: true },
  { name: '变异范围', file: 'test_mutation_ranges.js', desc: '生产模块及行段必须完整纳入 mutation 矩阵', mutationSkip: true },
  // v3.172：集成测试走并行调度器（worker 独立缓存目录 + 失败片串行重跑）。
  // 需要完整串行验证时直接 node test_app.js（CI 即如此）
  { name: '集成测试', file: 'test_app_p.js', desc: 'App.run 完整主流程(并行调度,失败自动重跑)', integration: true },
  { name: '通道测试', file: 'test_notify.js', desc: '推送通道请求构造+脱敏', integration: true }
]

module.exports = { SUITES }
