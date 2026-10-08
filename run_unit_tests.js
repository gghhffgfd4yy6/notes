'use strict'
// ============================================================
// 单元测试入口：只跑快速单元测试，排除集成测试（慢/可能有网络）
// 用法：node run_unit_tests.js   （或 npm run test:unit）
// 用途：CI 门禁 + 变异测试 runner，确保新增测试文件不会漏网
// ============================================================
const { spawn } = require('child_process')
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
// v3.283 主机干净度前置检查：孤儿测试桩 / 被 reparent 到 1 的孤儿套件 / 过期 /tmp/xbk-* 沙箱会把墙钟
// 基准拖红（实测 300ms 跑出 878ms），脏机器不启动。缺脚本时**响亮跳过**——最小工作树（如
// test_ci_skip_suites.js 的 RT-08 夹具只复制 run_tests.js）不得因此崩；其它异常照常抛出，不吞。
let hostClean = null
try {
  hostClean = require('./scripts/check-host-clean.js')
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e
  console.log('⚠️ 未找到 scripts/check-host-clean.js，跳过主机干净度前置检查（不影响本次运行）')
}
if (hostClean && hostClean.guardOrExit(process.env)) process.exit(1)

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

// len 占位数组在下方并发池处声明（完成乱序，按 SUITES 顺序占位）
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

// 并发度（v3.278）：套件间彼此独立（各自子进程 + 独立临时目录/端口/pid 隔离落点），
// 仿 test_app_p.js 的并行调度模式并发执行，会把「N 个套件串行合计」压到「最长套件」。实测收益：
//   · CI 常规全量（run_unit_tests.js / SKIP_SUITES 场景）：21 个小套件 ~10s → 并行后约 3s；
//   · 变异评估沙箱内全量（test_run_mutation_cli.js 的 evaluate 场景）串行保持（见下）。
// ⚠️ 变异评估必须保持串行：Stryker 沙箱（--concurrency 8 的 8 个 worker 共用同一 cwd）与
//    run_mutation.js 的评估沙箱里，run_unit_tests.js 由 XBK_MUTATION_CHILD=1 标记（该位由
//    run_mutations 的 runTests spawn 与 mutation.yml 的 step env 注入），此环境下强制回退并发 1——
//    否则「8 个 worker × 内部 8 并发 = 64 个套件进程」会互相争抢 CPU 并改变 test_filter.js 性能断言
//    （PERF_MS=3000 按既有并发口径校准）的判定，把本应 killed 的变异体误记 survived/killed（分数失真）。
//    XBK_UNIT_CONCURRENCY 仅在生产非变异场景显式调大（如 16 核真机），变异场景依旧被上面的回退覆盖。
const CONCURRENCY = (() => {
  const forced = process.env.XBK_MUTATION_CHILD === '1' ? 1 : null
  if (forced !== null) return forced
  return positiveIntEnv('XBK_UNIT_CONCURRENCY', 8)
})()

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

// ---------- 并发执行 ----------
// 原实现按 SUITES 顺序 execFileSync 串行（每套件独立子进程，灵长类慢在于最长套件之前的小套件之和）；
// v3.278 改为并发池：results 按 SUITES 顺序占位（完成乱序不影响汇总表顺序），
// 每套件仍是独立子进程 —— 与串行版唯一的语义差异是「并发执行」，判定结果逐套件不变。
// 输出契约逐字保留：IN_CI 的 ::group:://::endgroup::（单套件完成时一次性打印，组内原子无交错）、
// 成功/失败人读行、::error title= 失败归因（输出超限/套件超时/失败套件）、clipForLog 裁剪、汇总行三数字格式。
function runSuite (s) {
  return new Promise((resolve) => {
    // s.file 来自 test_suites.js 的静态 SUITES 注册表（仓库自管，非用户输入），
    // path.join 只拼出仓库根下既有测试文件（Codacy Security 污点误报，行内抑制见下行）
    const file = path.join(__dirname, s.file) // nosemgrep
    const t0 = Date.now()
    // CI（GITHUB_STEP_SUMMARY 存在）下 stdout/stderr 均 pipe 收集：并发套件完成时**一次性**
    // 输出完整 `::group::…::endgroup::`（组开/关不跨套件交错，避免 GitHub Actions 日志分组
    // 归因错误——串行实现组标记实时输出无此问题，并发下必须先收集后整组打出）；stdout 仍用于
    // ENOBUFS 检测与失败回显。本地保持 inherit 直通（无 group、与串行版逐字一致，
    // UT-07 沙箱回归依赖本地模式子进程输出直通调用方 stdout）。
    const collect = IN_CI
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let overflowed = false
    let timedOut = false
    let finished = false
    let child
    try {
      child = spawn(process.execPath, [file], {
        cwd: __dirname,
        // stderr 直通（inherit）：CI 下随组收集并在组内回放；本地保持 inherit（与旧 execFileSync 同口径）
        stdio: ['ignore', collect ? 'pipe' : 'inherit', collect ? 'pipe' : 'inherit']
      })
    } catch (e) {
      // spawn 同步失败（ENOENT 等）：按失败处理，与 execFileSync 抛错同语义
      settle({ ok: false, ms: Date.now() - t0, error: e })
      return
    }
    const kill = () => { try { child.kill('SIGKILL') } catch (e) { /* 进程已退出 */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, UNIT_TIMEOUT)
    if (collect) {
      child.stdout.on('data', (chunk) => {
        if (overflowed) return
        out = Buffer.concat([out, chunk])
        if (out.length > MAX_BUFFER) { overflowed = true; kill() } // ENOBUFS 语义：超限即 kill（fail-loud）
      })
      child.stderr.on('data', (chunk) => {
        // stderr 只收集不判定（与串行版 stderr inherit 无上限口径一致；上限仅防进程异常刷屏撑爆内存）
        if (err.length < MAX_BUFFER) err = Buffer.concat([err, chunk])
      })
    }
    child.on('error', (e) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      settle({ ok: false, ms: Date.now() - t0, error: e })
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      settle({
        ok: !overflowed && !timedOut && code === 0,
        ms: Date.now() - t0,
        code,
        overflowed,
        timedOut,
        out,
        err
      })
    })
    function settle ({ ok, ms, error, code, overflowed: ovf, timedOut: tout, out: childOut, err: childErr }) {
      try {
        if (IN_CI) {
          // 🔒 组生命周期只在单次输出内完成（start + 内容 + end 连续打出）：
          // 并发套件完成顺序不定，若组开/关跨输出点交错，GitHub Actions 会把先完成的
          // ::endgroup:: 误关到后启动的组上（Sourcery broader_impact 审查指出的日志归因错误）。
          // 成功全量回放 stdout+stderr；失败组内回放 stderr 与裁剪后的 stdout，归因行在组外。
          if (ok) {
            const body = [childOut ? childOut.toString() : '', childErr ? childErr.toString() : ''].join('')
            console.log(`::group::${s.name}（${s.file}）`)
            console.log(body)
            console.log('::endgroup::')
            console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`)
          } else {
            console.log(`::group::${s.name}（${s.file}）`)
            if (childErr) console.log(clipForLog(childErr, MAX_BUFFER))
            console.log('::endgroup::')
            console.log(ovf
              ? `::error title=输出超限：${s.name}::${s.file} 的 stdout 超过 ${MAX_BUFFER} 字节上限（输出超限按失败处理 fail-loud：超限本身非测试断言失败，但流程仍以 exit 1 收尾）`
              : tout
                ? `::error title=套件超时：${s.name}::${s.file} 超过每套件上限 ${UNIT_TIMEOUT}ms（已按 killSignal=SIGKILL 强杀，按失败处理）`
                : `::error title=失败套件：${s.name}::${s.file}`)
            // 失败必须全量炸出（归因行组外），拿回具体红测上下文
            console.log(clipForLog(childOut, MAX_BUFFER))
            console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s${tout ? `，超过每套件上限 ${UNIT_TIMEOUT}ms 已强杀` : ''}）\n`)
          }
        } else {
          // 本地 inherit 直通：子进程输出实时到终端/调用方管道，这里只补汇总行
          console.log(`  ${ok ? '✅' : '❌'} ${s.name} ${ok ? '通过' : '失败'}（${(ms / 1000).toFixed(1)}s${tout ? `，超过每套件上限 ${UNIT_TIMEOUT}ms 已强杀` : ''}）\n`)
        }
        results[idxOf(s)] = { ...s, ok, ms }
      } catch (e) {
        // 失败归因/回显自身不得让汇总流程崩溃（如 childOut 含不可编码内容）
        results[idxOf(s)] = { ...s, ok: false, ms }
        console.log(`  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s）\n`)
      }
      resolve()
    }
  })
}
const results = new Array(UNIT_SUITES.length)
const idxOf = (s) => UNIT_SUITES.indexOf(s)
;(async () => {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, UNIT_SUITES.length)) }, async () => {
    while (true) {
      const i = next++
      if (i >= UNIT_SUITES.length) return
      await runSuite(UNIT_SUITES[i])
    }
  })
  await Promise.all(workers)
  finish()
})().catch(e => { console.error(e); process.exitCode = 1 })

function finish () {
  console.log('══════════════════════════════════════════════')
  console.log('  汇总报告')
  console.log('══════════════════════════════════════════════')
  let allOk = true
  const nameWidth = results.reduce((max, r) => Math.max(max, displayWidth(r.name)), 6)
  for (const r of results) {
    const mark = r.ok ? '✅' : '❌'
    console.log(`  ${mark} ${padEndWidth(r.name, nameWidth)} ${r.file.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`)
    if (!r.ok) allOk = false
    // 表格行与汇总报告同序（SUITES 顺序，与串行版输出一致；并行完成顺序不影响表格）
    summaryLines.push(`| ${r.name} | \`${r.file}\` | ${r.ok ? '✅' : '❌'} | ${(r.ms / 1000).toFixed(1)}s |`)
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
  // 结束，Node 会 flush 完管道再退出，退出码语义不变。此处无遗留句柄（spawn 子进程均已 close 收尾）。
  process.exitCode = allOk ? 0 : 1
}
