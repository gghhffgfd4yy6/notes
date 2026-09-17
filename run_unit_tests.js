'use strict'
// ============================================================
// 单元测试入口：只跑快速单元测试，排除集成测试（慢/可能有网络）
// 用法：node run_unit_tests.js   （或 npm run test:unit）
// 用途：CI 门禁 + 变异测试 runner，确保新增测试文件不会漏网
// ============================================================
const { execFileSync } = require('child_process')
const path = require('path')
const { SUITES } = require('./test_suites')

// 中文名按显示宽度对齐：String.prototype.padEnd 按 UTF-16 码元计数，中文每字占 2 列，
// 直接 padEnd 会导致汇总行错位；此处按终端显示宽度补齐。
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
function displayWidth (str) {
  let width = 0
  for (const ch of str) width += WIDE_RE.test(ch) ? 2 : 1
  return width
}
function padEndWidth (str, width) {
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)))
}

// SKIP_SUITES：显式列出需跳过的套件文件名（逗号分隔，可选）。
// 用途：CI 中显式步骤已单独跑过的套件，全量兜底时跳过避免重复（失败仍由显式步骤独立报错）。
// 清单与 test.yml 的显式步骤必须双向一致（漏写=重复跑，多写=漏跑）——不一致由 test_ci_skip_suites.js 拦截。
// 变异评估场景（run_mutation.js 子进程）必须保持全量 —— run_mutation.js spawn 时会清除该变量；
// CI 变异任务走 stryker（不经 run_mutation.js），由 mutation.yml 的 step env 设 XBK_MUTATION_CHILD=1。
const skipSuites = new Set((process.env.SKIP_SUITES || '').split(',').map(s => s.trim()).filter(Boolean))
// 拼错的条目会「静默不生效」（等于没跳过，重复跑且无人知道），因此必须在入口处炸出来。
const unknownSkips = [...skipSuites].filter(file => !SUITES.some(s => s.file === file))
if (unknownSkips.length) {
  console.error(`❌ SKIP_SUITES 含不存在的套件：${unknownSkips.join(', ')}（请对照 test_suites.js 修正）`)
  // 此 exit(1) 在变异场景同样生效（设计使然）：run_mutation.js 的 spawn 会强制清空 SKIP_SUITES，不受影响；
  // 但本地直跑 stryker（npm run test:mutation）会继承 shell 环境变量。仅补充提示，不改变校验行为。
  console.error('💡 若在本地变异场景遇到此错误，请确认未在环境变量中设置 SKIP_SUITES（变异评估要求全量；run_mutation.js 的子进程会自动清空，直跑 stryker 会继承你的 shell 环境）')
  process.exit(1)
}
// 无效条目（套件本就不进本入口，如 integration/mutationSkip）不致命，但意味着清单与显式步骤口径漂移。
for (const file of skipSuites) {
  const suite = SUITES.find(s => s.file === file)
  if (suite && (suite.integration || suite.mutationSkip)) {
    console.warn(`⚠️ SKIP_SUITES 的 ${file} 本就不在本入口（integration/mutationSkip），该条无效`)
  }
}
const UNIT_SUITES = SUITES.filter(s => !s.integration && !s.mutationSkip && !skipSuites.has(s.file))
// mutationSkip：ranges 行数元校验在 Stryker 沙箱内误报（CI run #120 根因）——同一次运行里
// 两类行数扰动叠加：
//   ① 被 --mutate 的目标文件被插桩注入，行数大幅膨胀（如 426→704，主因）；
//   ② Stryker 默认注入的 "// @ts-nocheck" 头部使每个文件多 +1/+2 行（如 426→427）。
//   故在沙箱内跳过这两个元校验套件（① 的主修复）；它们仍由 npm test（run_tests.js 全量清单）
//   逐个执行，CI 门禁不降级。② 另在 stryker.config.js 用 disableTypeChecks:false 关闭（双保险）。

// 零套件不等于通过：SKIP_SUITES 覆盖全部套件（含 test_ci_skip_suites.js 这类守护对账套件自身）或注册表
// 为空时，results 为空 → allOk 初值 true → 打印「全部通过 🎉」并 exit 0，门禁整步假绿且无人告警。
if (!UNIT_SUITES.length) {
  console.error(`❌ 过滤后没有可执行的单元套件（SKIP_SUITES=${skipSuites.size ? [...skipSuites].join(',') : '未设置'}）`)
  console.error('   零套件不等于通过：请检查 SKIP_SUITES 是否覆盖过广，以及 test_suites.js 注册表是否为空')
  process.exit(1)
}

const results = []
console.log('══════════════════════════════════════════════')
console.log('  xbk-push 单元测试入口（排除集成测试）')
console.log(`  共 ${UNIT_SUITES.length} 个套件`)
console.log('══════════════════════════════════════════════\n')

const IN_CI = Boolean(process.env.GITHUB_STEP_SUMMARY)
const summaryLines = ['| 套件 | 文件 | 结果 | 耗时 |', '|---|---|---|---|']
// CI 下 stdout 走 pipe 收进内存（失败时打包重显），故必须显式放大上限：execFileSync 默认 maxBuffer=1MiB，
// 超限会抛 ENOBUFS——触发按失败处理（fail-loud，见下方 catch 的注解）；实测最大套件 test_filter.js 约 75KB，
// 8MiB 上限余量充足，「成功路径」不会误触。注意该上限并不约束失败回显：ENOBUFS 时 e.stdout 含触发块
// （回显量约 MAX_BUFFER + 单块），故 catch 里统一用 clipForLog 按同一上限裁剪并标注省略量（UT-06）。
// XBK_UNIT_MAX_BUFFER 仅用于测试注入（构造超限场景），生产不设。
const MAX_BUFFER = Number(process.env.XBK_UNIT_MAX_BUFFER) || 8 * 1024 * 1024

// 环境变量正整数解析（与 run_mutation.js 的 positiveIntEnv 同口径；不 require 该文件，避免把变异入口
// 及其依赖拉进本进程）：非法值（NaN / 负数 / 非整数 / 空串）一律告警并回退默认。
function positiveIntEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`⚠️  环境变量 ${name}=${raw} 非法（应为正整数），已回退默认值 ${fallback}`)
    return fallback
  }
  return value
}

// 每套件硬超时（UT-03）：套件挂死（死循环 / 等待不会到来的输入 / 遗留句柄）时 execFileSync 永不返回，
// 本入口既不汇总也不退出，CI 只能等作业级超时——整步既无结论也无红测定位。此处补上与 run_mutation.js
// 的 MUTATION_TIMEOUT 同口径的兜底；killSignal 用 SIGKILL（同 run_mutation.js），SIGTERM 可能被忽略。
// 默认 600s：本机全量基线最慢单元套件实测 132.2s（test_run_mutation_cli.js），Stryker 插桩沙箱下需留
// 足余量以免误杀（stryker.config.js 的 timeoutMS 亦按 300000 量级的加法偏移留量）。XBK_UNIT_TIMEOUT
// 仅供测试注入/本机调参，生产不设。
const UNIT_TIMEOUT = positiveIntEnv('XBK_UNIT_TIMEOUT', 10 * 60 * 1000)

// 失败回显裁剪（UT-06）：失败时回显的是子进程 stdout，其唯一约束来自 maxBuffer，而 ENOBUFS 恰恰是
// 「已超出该上限」——故超限路径的回显量并不受 MAX_BUFFER 约束（约 MAX_BUFFER + 单块）。此处按同一上限
// 裁剪并显式标注省略量（不静默丢弃）；输出未超限的正常失败逐字保留，行为不变。
// CodeRabbit PR #147：maxBuffer 是**字节**上限，而字符串 length 数的是 UTF-16 码元——多字节输出
// （中文/emoji）可能在 length 未超限时字节已超限。故这里接收原始 Buffer，按字节裁剪，并在
// 字节边界上回退到 UTF-8 字符起始处，避免把多字节字符切成半个（输出乱码）。
function clipForLog (buf, limit) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf == null ? '' : buf), 'utf8')
  if (bytes.length <= limit) return bytes.toString('utf8')
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end-- // 回退到 UTF-8 字符首字节
  return `${bytes.subarray(0, end).toString('utf8')}\n…（失败回显已省略 ${bytes.length - end} 字节：回显按 MAX_BUFFER=${limit} 上限裁剪，完整输出见套件自身日志）`
}

for (const s of UNIT_SUITES) {
  const file = path.join(__dirname, s.file)
  const t0 = Date.now()
  // CI 下用 ::group:: 折叠各套件输出（463KB 的 test_filter 不再刷爆日志页）；stderr 直通组内（成功套件
  // 的警告也保留），pipe 仅收 stdout 用于失败时打包重显；本地保持 inherit 逐行直出
  if (IN_CI) console.log(`::group::${s.name}（${s.file}）`)
  try {
    // cwd 固定为 __dirname（与上面的 __dirname 定位套件同口径）：套件按 cwd 读 package.json /
    // .github/workflows/*.yml / CHANGELOG.md（test_ci_skip_suites.js、test_tag_validator.js），
    // 从非仓库根调用时不设 cwd 会假红，或在同构副本目录里对账到别的仓库而假绿。
    const childOut = execFileSync(process.execPath, [file], { cwd: __dirname, stdio: IN_CI ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: MAX_BUFFER, timeout: UNIT_TIMEOUT, killSignal: 'SIGKILL' })
    if (IN_CI) {
      console.log(childOut.toString())
      console.log('::endgroup::')
    }
    const ms = Date.now() - t0
    results.push({ ...s, ok: true, ms })
    summaryLines.push(`| ${s.name} | \`${s.file}\` | ✅ | ${(ms / 1000).toFixed(1)}s |`)
    console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`)
  } catch (e) {
    // 输出超限（ENOBUFS）按失败处理（fail-loud 有意设计）：超限本身不是测试断言失败，
    // 但流程仍以失败收尾（exit 1）——这里的区分只是给排查者的注解（「话多」红 ≠ 断言红），并非放行。
    const overflow = e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message || ''))
    // 超时由 execFileSync 抛 ETIMEDOUT（套件已按 killSignal=SIGKILL 强杀，见 UNIT_TIMEOUT）：与断言红
    // 区分开，否则排查者只看到一行「失败」，不知道套件是被每套件上限掐掉的（UT-03）。
    const timedOut = e.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(e.message || ''))
    if (IN_CI) {
      // 失败必须全量炸出（默认组），拿回具体红测上下文（stderr 已直通，此处补 stdout）
      console.log('::endgroup::')
      console.log(overflow
        ? `::error title=输出超限：${s.name}::${s.file} 的 stdout 超过 ${MAX_BUFFER} 字节上限（输出超限按失败处理 fail-loud：超限本身非测试断言失败，但流程仍以 exit 1 收尾）`
        : timedOut
          ? `::error title=套件超时：${s.name}::${s.file} 超过每套件上限 ${UNIT_TIMEOUT}ms（已按 killSignal=SIGKILL 强杀，按失败处理）`
          : `::error title=失败套件：${s.name}::${s.file}`)
      console.log(clipForLog(e.stdout, MAX_BUFFER))
    }
    const ms = Date.now() - t0
    results.push({ ...s, ok: false, ms })
    summaryLines.push(`| ${s.name} | \`${s.file}\` | ❌ | ${(ms / 1000).toFixed(1)}s |`)
    console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s${timedOut ? `，超过每套件上限 ${UNIT_TIMEOUT}ms 已强杀` : ''}）\n`)
  }
}

console.log('══════════════════════════════════════════════')
console.log('  汇总报告')
console.log('══════════════════════════════════════════════')
let allOk = true
const nameWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.name)), 6)
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  console.log(`  ${mark} ${padEndWidth(r.name, nameWidth)} ${r.file.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`)
  if (!r.ok) allOk = false
}
const totalMs = results.reduce((a, r) => a + r.ms, 0)
const passCount = results.filter(r => r.ok).length
const failCount = results.length - passCount
console.log(`  总耗时: ${(totalMs / 1000).toFixed(1)}s`)
// ⚠️ 汇总行格式是跨文件契约（UT-07）：run_mutation.js 的 extractTestSummary（:374-383）逐行向上匹配
// 「全部通过！N/M」或「K 通过, M 失败, 共 N」三数字行。此前本行是「全部通过 🎉」——两种格式都不匹配，
// 于是非 CI 下内层套件 stdout 直通同一捕获管道时（如 test_filter.js:8746 的「🎉 全部通过！785/785」），
// 逐变异体 summary 会命中内层套件的那一行而误归属到内层套件。现统一为三数字格式并保留人读文案；
// run_tests.js 姊妹入口同步同款格式。该契约由 test_ci_skip_suites.js 的沙箱回归固定：内层桩套件打印
// 诱饵「全部通过！7/7」，断言取到的是外层本入口自己的数字。
console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}｜${passCount} 通过, ${failCount} 失败, 共 ${results.length}`)
console.log('══════════════════════════════════════════════')

// CI 下把套件结果表写入 $GITHUB_STEP_SUMMARY（run 页可直接看，失败一眼定位）
// 只在「本入口的调用方不是变异评估子进程」时写：run_mutation.js 的 spawn 会带 XBK_MUTATION_CHILD=1
// （它会在临时目录里反复运行本入口，若允许追加会产生重复块，且子进程套件数与顶层不同）。
// CI 变异任务走 stryker 的 commandRunner（不经过 run_mutation.js），由 mutation.yml 的 step env 设同一位
// ——否则「初始运行 + 每个变异体」各 append 一次整表，几百次就撞 GitHub 1MiB/step 上限被截断。
if (IN_CI && process.env.XBK_MUTATION_CHILD !== '1') {
  require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## 单元测试结果（${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}，共 ${results.length} 套件，${(totalMs / 1000).toFixed(1)}s）\n\n${summaryLines.join('\n')}\n`)
}

// 用 process.exitCode 收尾而非 process.exit()（UT-04）：CI 下 stdout 是 pipe，process.exit() 不等待
// 异步写入完成，汇总表/失败回显的尾部可能被截断丢失（管道写入是异步的）；置 exitCode 后事件循环自然
// 结束，Node 会 flush 完管道再退出，退出码语义不变。此处无遗留句柄（execFileSync/appendFileSync 均为
// 同步调用），不会把进程挂住。
process.exitCode = allOk ? 0 : 1
