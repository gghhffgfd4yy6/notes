/* eslint no-control-regex: off */
'use strict'

// ============================================================
// 🗂️ FilterStore — 过滤规则覆盖文件存储层
//
// 职责边界（规格 §3 / 计划 §3.1）：
//   · 只做「读覆盖文件 → 合并代码默认 → 生效规则」与「校验待保存规则」；
//   · 只做「写/读生效快照」与「审计/锁/备份路径」helper；
//   · **不**读规则于模块加载期（每轮由 App.run 调用 loadFilterRules 一次）；
//   · **不**缓存 activeFilter——模块级状态只有 last-known-good（损坏降级用，按 cacheDir 分槽）；
//   · **不** require xbk_function_v3（会与 xbk_app → FilterStore 形成循环依赖）；
//     RuleEngine / compileUserRegex / RE2 可用性一律由调用方经 deps 注入；
//   · 全程同步、零新依赖；读走 xbk_storage.readSafeTextResult，写走 writeAtomic（原子 + 0600）。
//
// 失败语义：本模块的任何导出都**不 throw**——校验失败返回 {ok:false,errors}，
//   读取失败走 {source:'corrupt',degraded:true} 降级并保留 last-known-good。
//   这是硬约束：loadFilterRules 在每轮 App.run 开头执行，抛穿会杀掉整轮推送。
//
// 覆盖文件形状（schema:1）：
//   { "schema": 1, "revision": <非负整数>, "filter": { <11 字段中任意子集>: "<字符串>" } }
//   缺字段 = 该字段回代码默认（**不是**置空）；显式 "" = 用户明确清空该规则。
//   合并语义依赖「字段是否存在」（hasOwnProperty），故校验结果保留「只含已提交字段」的形状。
// ============================================================

const path = require('path')
const fs = require('node:fs')
const crypto = require('node:crypto')
// 读入口经模块对象调用（`storage.readSafeTextResult`）而非解构：F4-3 的「瞬时读失败重读一次」
// 分支只能靠替换该函数来注入 replaced/ioError（真实竞态不可确定复现），解构会把模块加载时的
// 引用钉死，测试无法注入。写入口继续解构（没有注入需求）。
const storage = require('./xbk_storage')
const { writeAtomic } = storage
// 路径构造单独成模块（纯 path.join + 本文件常量名），见该文件顶部说明。
// CAPACITY_FILE：F3 容量文件名与 filterRulesPaths(dir).capacity 的单一来源（本文件不再抄字面量）。
const { filterRulesPaths, CAPACITY_FILE } = require('./scripts/filter-rules-paths')
// 权限收紧/判定单独成模块（Semgrep 对非字面量路径的 fs 调用一律报 path-traversal，单独成模块后
// 只排除该模块，不整文件排除本模块）。**必须在顶部 require**：F3 的容量文件在模块加载期
// （resolveFilterLimits → writeCapacityFile）就要用 isOwnerOnlyFile，放到文件中部的 const 会踩 TDZ。
const { enforceOwnerOnlyMode, isOwnerOnlyFile } = require('./scripts/owner-only-mode.js')

// 字段顺序沿用 xbk_utils.FILTER_FIELDS 的历史顺序（末尾追加 pingbitime），
// 必须与 Config.filter 的键集合完全一致（测试逐元素断言）。
const FILTER_RULE_FIELDS = Object.freeze([
  'pingbifenlei',
  'pingbibiaoti',
  'zhanxianbiaoti',
  'pingbibiaotiplus',
  'pingbineirong',
  'zhanxianneirong',
  'pingbineirongplus',
  'pingbilouzhu',
  'zhanxianlouzhu',
  'pingbilouzhuplus',
  'pingbitime'
])

const FILTER_RULES_SCHEMA = 1
// ── 预算的单一来源（F1 收口 · F3 动态化）──────────────────────────────────
// 历史：单字段／整份文件／请求体／草稿四条上限曾是四份手抄副本，改一处忘一处就会造出「能保存但
// 读不回」。F1 把它们收成这块单一来源；F3 再把「常数」换成**启动时算一次并钉住**的动态预算——
// 保存时绝不重算：实测 MemAvailable 4 分钟内摆动 18%，每轮重算会得出 7 个不同上限。
//
// 公式（computeFilterCapacity，纯函数：无 IO／无时钟／无随机）：
//   resourceCeiling = quantize64k(min(memBudget, diskBudget))
//     memBudget  = 0.25 × min(MemAvailable, cgroup memory headroom) / 8   # 8 = 解析/请求/副本放大
//     diskBudget = diskAvailBytes × 0.01 / 6                              # 6 份产物：override/tmp/bak/lkg/applied/audit
//   totalBytes  = clamp(min(resourceCeiling, softCap), 256 KiB, 8 MiB)
//   reserve     = Σ reserveChars(field) × 3 B = 42,432 B（8 个非 plus × 1000 + 3 个 plus × 2048）
//   mainChars   = quantize1000((totalBytes − reserve) / 主字段数 / 3)
//
// 落点：resolveFilterLimits() 在**模块加载**探测一次（/proc/meminfo 的 MemAvailable；自身 cgroup
// 上溯的 memory.max/current —— `max` 必须特判：Number('max') = NaN；fs.statfsSync(cacheDir) 的
// bavail × bsize），结果钉进 FILTER_LIMITS，并写 <缓存目录>/filter-capacity.json（0600）供 console
// 与 worker 共读；两个进程必须用同一份预算，不一致时以文件为准并告警。
//
// 覆盖：XBK_FILTER_SOFT_CAP_BYTES（整数 → 夹 [256 KiB, 8 MiB]、向下 4096 对齐；非法值回落默认
// 512 KiB 并 console.warn，不静默当 auto）。探测失败（meminfo 读不到／MemAvailable ≤ 0／cgroup
// headroom ≤ 0／statfs 抛错）→ 回落 256 KiB + 16,000 字符 + degraded:true，**绝不回落成「无限」**
// （readSafeTextResult 的 maxBytes 非正/NaN 等于不设限整读）。
const FILTER_BYTES_PER_CHAR = 3
const FILTER_MAIN_CHARS_QUANTUM = 1000
const FILTER_TOTAL_QUANTUM_BYTES = 64 * 1024
const FILTER_MIN_TOTAL_BYTES = 256 * 1024
const FILTER_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const FILTER_DEFAULT_SOFT_CAP_BYTES = 512 * 1024
const FILTER_SOFT_CAP_ALIGN_BYTES = 4096
const FILTER_SOFT_CAP_ENV = 'XBK_FILTER_SOFT_CAP_BYTES'
const FILTER_CACHE_DIR_ENV = 'XBK_CACHE_DIR'
// 文件名取自 scripts/filter-rules-paths.js 的 CAPACITY_FILE（与 filterRulesPaths(dir).capacity 同源，
// 避免两处字面量漂移）；本常量继续导出，测试与日志按它构造/点名路径。
const FILTER_CAPACITY_FILE = CAPACITY_FILE
const FILTER_CAPACITY_SCHEMA = 1
const FILTER_CAPACITY_FILE_MAX_BYTES = 64 * 1024
const FILTER_REQUEST_BODY_MARGIN_BYTES = 8192
const FILTER_READ_MARGIN_BYTES = 1024
const FILTER_MEM_BUDGET_RATIO = 0.25
const FILTER_MEM_AMPLIFICATION = 8
const FILTER_DISK_BUDGET_RATIO = 0.01
const FILTER_DISK_COPIES = 6
// 保存闸门给 revision 位数增长留的余量（整份闸门按 上限-32 判，见 validateFilterRules 闸门 5）。
const FILTER_SAVE_HEADROOM_BYTES = 32
// 单字段的**预留**字符数：plus（强化屏蔽）2048、其余 1000。它同时是 reserve 的唯一来源与
// 非主字段的单字段档位（8 个非 plus × 1000 + 3 个 plus × 2048 = 14,144 字符 = 42,432 B）。
const FILTER_FIELD_RESERVE_CHARS = 1000
const FILTER_FIELD_PLUS_RESERVE_CHARS = 2048
// 主字段：用户实际会填满的两个大字段（现网实测 屏蔽标题 15,735 / 屏蔽内容 15,636 字符），上限取
// mainChars；其余字段按预留档位钉死（小字段 1000 / plus 2048），11 个字段全满也必须落在 totalBytes 内。
const FILTER_MAIN_FIELDS = Object.freeze(['pingbibiaoti', 'pingbineirong'])
// 今日常量（F1 的数字）：既是**读端下限**（存量小字段不得被判 corrupt），也是探测失败时的回落值。
const FILTER_FIELD_MAX_LEN = 16000
const FILTER_RULES_MAX_BYTES = 256 * 1024
// LKG / applied 快照相对覆盖文件的包装预算（F4-1 R3 / P2 返工）：1024 只写这一处。
const FILTER_WRAPPER_BYTES = 1024
// 预算表里任何标量项的合法上界：整份/读硬顶 ≤ 8 MiB，请求体再多 8 KiB 的余量。
const FILTER_MAX_LIMIT_VALUE = FILTER_MAX_TOTAL_BYTES + FILTER_REQUEST_BODY_MARGIN_BYTES
// ── F2-3：### 多行规则的对象爆炸闸（只约束**保存**入参）─────────────────────
// ### 每行编译成 2 个 RE2 对象（约 3.9 KB/个）：4 MiB 全是多行规则 = 165,016 行 ≈ 33 万个对象
// ≈ 1.29 GB 内存，单进程直接 OOM。抬上限（F3/F4）之前必须先把「条目数」钉住，否则字节上限被放松
// 等于给 OOM 开门。读路径**不设**这道闸：已落盘的既有文件必须还能读回来（见 validateFilterRules 闸门 2b）。
const FILTER_MAX_RULE_LINES = 2000
// 全份预算 2000 行，单字段最多吃一半——一个字段把整份预算吃光时，其余字段的任何规则都会撞总闸。
const FILTER_MAX_RULE_LINES_PER_FIELD = 1000
// 单字段未转义 `|` 的个数上限：交替分支数与单条正则的编译/匹配代价线性相关，超限同样在保存时拒绝。
const FILTER_MAX_ALTERNATIONS_PER_FIELD = 1000
// ── F2-2：/preview 的扫描预算（默认 200 ms 或 200 条 _f 记录，先到者）──────────
// 5000 条 × 2.01 ms ≈ 11.1 s 的同步循环会把控制台事件循环占死（客户端 8 s 就超时）；
// 抬上限后是 52–107 s。预算只约束「扫多少」，不改变单条判定结果。
const FILTER_PREVIEW_BUDGET_MS = 200
const FILTER_PREVIEW_BUDGET_RECORDS = 200

const FILTER_PLUS_FIELD_SET = new Set(FILTER_RULE_FIELDS.filter(field => field.endsWith('plus')))
const FILTER_MAIN_FIELD_SET = new Set(FILTER_MAIN_FIELDS)
// 限额档位 plus 2048 的字段：3 个 plus + pingbitime。pingbitime 单独说明——它的 `分类###天数`
// 多行规则是**正则**（分类段编译成分类正则），F2-3 的交替闸要在长度闸之前可达：分类段 1001 个
// 未转义 `|` 至少 2,005 字符（'7|7|…###7'），1000 档会让交替闸在 pingbitime 上变成不可达的死闸，
// 也会拒掉既有的多行天数配置。2048 = 9 个非主字段里最大的档位，全字段按限额填满仍是 519,576 B
// ≤ totalBytes − 32（贴边），reserve 仍按 spec 的 42,432 B（pingbitime 的预留只算 1000，差额由
// reserve 的 4,680 B 余量吸收，方向保守：reserve 偏大 ⇒ mainChars 偏小）。
const FILTER_PLUS_LIMIT_FIELD_SET = new Set([...FILTER_PLUS_FIELD_SET, 'pingbitime'])

function isPositiveSafeInt (value) {
  return Number.isSafeInteger(value) && value > 0
}

function isPositiveFinite (value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// 单字段的预留档位（plus 2048、其余 1000）。pingbitime 也在 1000 档：纯天数字段实测只有个位数，
// 但 `分类###天数` 多行规则要放得下（16 字符会拒掉既有配置）。
function reserveCharsOf (field) {
  return FILTER_PLUS_FIELD_SET.has(field) ? FILTER_FIELD_PLUS_RESERVE_CHARS : FILTER_FIELD_RESERVE_CHARS
}

// 单字段的**限额**档位：主字段取 mainChars，plus 档（含 pingbitime）2048，其余 1000。
function limitCharsOf (field, mainChars) {
  if (FILTER_MAIN_FIELD_SET.has(field)) return mainChars
  return FILTER_PLUS_LIMIT_FIELD_SET.has(field) ? FILTER_FIELD_PLUS_RESERVE_CHARS : FILTER_FIELD_RESERVE_CHARS
}

// reserve = 11 个字段的预留字符数 × 3 B（= spec 的 (8 小字段 × 1000 + 3 plus × 2048) × 3 = 42,432）。
const FILTER_RESERVE_BYTES = FILTER_RULE_FIELDS.reduce((sum, field) => sum + reserveCharsOf(field), 0) * FILTER_BYTES_PER_CHAR

function quantizeDown (value, quantum) {
  return Math.floor(value / quantum) * quantum
}

function clampInt (value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * 覆盖值 XBK_FILTER_SOFT_CAP_BYTES：只认十进制非负整数；夹 [256 KiB, 8 MiB]、向下 4096 对齐。
 * 非法值（空串以外的任何非整数形态）回落默认 512 KiB 并 console.warn——**不静默当 auto**：
 * 用户显式设了值却没生效，必须能在日志里看到原因。
 * @returns {{bytes:number, explicit:boolean, invalid:boolean}}
 */
function parseSoftCapBytes (raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim()
  if (text === '') return { bytes: FILTER_DEFAULT_SOFT_CAP_BYTES, explicit: false, invalid: false }
  if (!/^\d+$/.test(text)) return { bytes: FILTER_DEFAULT_SOFT_CAP_BYTES, explicit: true, invalid: true }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return { bytes: FILTER_DEFAULT_SOFT_CAP_BYTES, explicit: true, invalid: true }
  return {
    bytes: clampInt(quantizeDown(value, FILTER_SOFT_CAP_ALIGN_BYTES), FILTER_MIN_TOTAL_BYTES, FILTER_MAX_TOTAL_BYTES),
    explicit: true,
    invalid: false
  }
}

/**
 * 把 totalBytes 摊成完整预算表：computeFilterCapacity 与「以容量文件为准」共用同一套派生，
 * 保证两个进程对同一个 totalBytes 得到逐字段相同的 perField 与读/写旋钮。
 * readMaxBytes 只在 max(totalBytes, 当前文件字节数) 之上再加 1024——「当前文件字节数」进公式是为了
 * 杜绝「保存成功但下一轮读端判 tooLarge」。
 */
function layoutFilterCapacity (totalBytes, {
  fileBytes = 0, source = 'probe', degraded = false, degradedReasons = [],
  softCapBytes = FILTER_DEFAULT_SOFT_CAP_BYTES
} = {}) {
  const mainChars = Math.max(
    FILTER_MAIN_CHARS_QUANTUM,
    quantizeDown((totalBytes - FILTER_RESERVE_BYTES) / FILTER_MAIN_FIELDS.length / FILTER_BYTES_PER_CHAR, FILTER_MAIN_CHARS_QUANTUM)
  )
  const perField = {}
  for (const field of FILTER_RULE_FIELDS) {
    perField[field] = Object.freeze({ chars: limitCharsOf(field, mainChars) })
  }
  const currentFileBytes = isPositiveSafeInt(fileBytes) ? fileBytes : 0
  return {
    totalBytes,
    perField: Object.freeze(perField),
    mainChars,
    reserveBytes: FILTER_RESERVE_BYTES,
    rulesFileMaxBytes: totalBytes,
    readMaxBytes: Math.min(Math.max(totalBytes, currentFileBytes) + FILTER_READ_MARGIN_BYTES, FILTER_MAX_TOTAL_BYTES),
    requestBodyMaxBytes: totalBytes + FILTER_REQUEST_BODY_MARGIN_BYTES,
    saveHeadroomBytes: FILTER_SAVE_HEADROOM_BYTES,
    // 与预算无关、但同表下发的旋钮：包装预算与条目闸（console 的 GET limits 也从这里取）。
    lastgoodWrapperBytes: FILTER_WRAPPER_BYTES,
    appliedWrapperBytes: FILTER_WRAPPER_BYTES,
    maxRuleLines: FILTER_MAX_RULE_LINES,
    maxRuleLinesPerField: FILTER_MAX_RULE_LINES_PER_FIELD,
    maxAlternationsPerField: FILTER_MAX_ALTERNATIONS_PER_FIELD,
    softCapBytes,
    source,
    degraded,
    degradedReasons: Object.freeze(degradedReasons.slice())
  }
}

/**
 * 纯函数：把本机资源探测结果换算成过滤规则预算（无 IO／无时钟／无随机 ⇒ 同一入参连调两次的
 * JSON 逐字节相等，这是容量文件跨进程共读的前提）。
 * @param {{memAvailableBytes?:number|null, cgroupHeadroomBytes?:number|null, diskAvailBytes?:number|null,
 *          fileBytes?:number, softCapBytes?:number, probeErrors?:string[]}} [input]
 *   null／非正／非有限 = 该项探测失败。四类失败（meminfo 读不到／MemAvailable ≤ 0／cgroup
 *   headroom ≤ 0／statfs 抛错）一律整体回落 256 KiB + 16,000 字符 + degraded:true。
 *   cgroupHeadroomBytes 传 Infinity = cgroup 无上限（只剩 MemAvailable 一个约束），不算失败。
 * @returns {{totalBytes:number, perField:Object, mainChars:number, reserveBytes:number,
 *            readMaxBytes:number, requestBodyMaxBytes:number, rulesFileMaxBytes:number,
 *            saveHeadroomBytes:number, softCapBytes:number, source:string, degraded:boolean,
 *            degradedReasons:string[]}}
 */
function computeFilterCapacity (input) {
  const opts = input && typeof input === 'object' ? input : {}
  const softCapBytes = isPositiveSafeInt(opts.softCapBytes)
    ? clampInt(quantizeDown(opts.softCapBytes, FILTER_SOFT_CAP_ALIGN_BYTES), FILTER_MIN_TOTAL_BYTES, FILTER_MAX_TOTAL_BYTES)
    : FILTER_DEFAULT_SOFT_CAP_BYTES
  const reasons = Array.isArray(opts.probeErrors) ? opts.probeErrors.filter(reason => typeof reason === 'string' && reason) : []
  const memAvailableBytes = isPositiveFinite(opts.memAvailableBytes) ? opts.memAvailableBytes : null
  if (memAvailableBytes === null) reasons.push('meminfo 的 MemAvailable 不可用')
  const cgroupHeadroomBytes = opts.cgroupHeadroomBytes === Infinity
    ? Infinity
    : (isPositiveFinite(opts.cgroupHeadroomBytes) ? opts.cgroupHeadroomBytes : null)
  if (cgroupHeadroomBytes === null) reasons.push('cgroup memory headroom 不可用或 ≤ 0')
  const diskAvailBytes = isPositiveFinite(opts.diskAvailBytes) ? opts.diskAvailBytes : null
  if (diskAvailBytes === null) reasons.push('statfs 可用空间不可用')
  if (reasons.length > 0) {
    // fail-closed：回落今日常量（256 KiB / 16,000）。方向永远是「更严」，绝不回落成无限。
    const base = layoutFilterCapacity(FILTER_RULES_MAX_BYTES, {
      fileBytes: opts.fileBytes, source: 'fallback', degraded: true, degradedReasons: reasons, softCapBytes
    })
    const perField = {}
    for (const field of FILTER_RULE_FIELDS) perField[field] = Object.freeze({ chars: FILTER_FIELD_MAX_LEN })
    return { ...base, perField: Object.freeze(perField), mainChars: FILTER_FIELD_MAX_LEN }
  }
  const memLimitBytes = cgroupHeadroomBytes === Infinity ? memAvailableBytes : Math.min(memAvailableBytes, cgroupHeadroomBytes)
  const memBudget = (FILTER_MEM_BUDGET_RATIO * memLimitBytes) / FILTER_MEM_AMPLIFICATION
  const diskBudget = (diskAvailBytes * FILTER_DISK_BUDGET_RATIO) / FILTER_DISK_COPIES
  const resourceCeiling = quantizeDown(Math.min(memBudget, diskBudget), FILTER_TOTAL_QUANTUM_BYTES)
  const totalBytes = clampInt(Math.min(resourceCeiling, softCapBytes), FILTER_MIN_TOTAL_BYTES, FILTER_MAX_TOTAL_BYTES)
  return layoutFilterCapacity(totalBytes, { fileBytes: opts.fileBytes, softCapBytes })
}

function readTextFile (readFileSync, filePath) {
  try {
    const text = readFileSync(filePath, 'utf8')
    return typeof text === 'string' ? text : String(text)
  } catch (e) {
    return null
  }
}

/**
 * /proc/meminfo 的 MemAvailable（字节）。读不到／格式不符返回 null（⇒ 预算整体回落 degraded）。
 */
function probeMemAvailableBytes ({ readFileSync = fs.readFileSync, meminfoPath = '/proc/meminfo' } = {}) {
  const text = readTextFile(readFileSync, meminfoPath)
  if (text === null) return null
  const match = /^MemAvailable:\s*(\d+)\s*kB/m.exec(text)
  if (!match) return null
  const kb = Number(match[1])
  return isPositiveSafeInt(kb) ? kb * 1024 : null
}

/**
 * 自身 cgroup 的 memory headroom（字节）。从 /proc/self/cgroup 找 memory 层级路径，逐级上溯读
 * memory.max / memory.current，取**所有有限层级里最小的 headroom**（v2 里某级写 `max` 只表示该级
 * 无限制，父级仍可能有限制）。`max` 必须特判：Number('max') = NaN，漏了它预算会变成 NaN 或被静默
 * 夹成 0。
 *
 * 路径一律 path.posix.join：cgroup 层级路径恒为 POSIX——层级与挂载点都是内核接口（仅 Linux），
 * 内核只认 '/'；平台 path.join 在 Windows 上会拼出 '\'，而这条探测链在非 Linux 上根本不成立。
 * （副作用是也不再落入 path-traversal 规则对 path.join(形参, …) 的形态匹配：base/relPath 全部
 * 来自 /proc 文本与固定挂载点，不含任何外部输入。）
 * @returns {{status:('ok'|'unlimited'|'unavailable'|'invalid'), headroomBytes?:number}}
 */
function probeCgroupHeadroomBytes ({
  readFileSync = fs.readFileSync, procCgroupPath = '/proc/self/cgroup', cgroupRoot = '/sys/fs/cgroup'
} = {}) {
  const text = readTextFile(readFileSync, procCgroupPath)
  if (text === null) return { status: 'unavailable' }
  let rel = null
  let v1 = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const v2 = /^\d+::(.*)$/.exec(trimmed)
    if (v2) { rel = v2[1]; v1 = false; break }
    const legacy = /^\d+:memory:(.*)$/.exec(trimmed)
    if (legacy) { rel = legacy[1]; v1 = true }
  }
  if (rel === null) return { status: 'unavailable' }
  const base = v1 ? path.posix.join(cgroupRoot, 'memory') : cgroupRoot
  const relPaths = []
  let cursor = rel === '' ? '/' : rel
  for (let depth = 0; depth < 64; depth++) {
    relPaths.push(cursor)
    if (cursor === '/' || cursor === '.') break
    const parent = path.posix.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  let headroom = Infinity
  let sawLimit = false
  for (const relPath of relPaths) {
    const dir = path.posix.join(base, relPath)
    const maxText = readTextFile(readFileSync, path.posix.join(dir, 'memory.max'))
    if (maxText === null) continue
    const trimmed = maxText.trim()
    if (trimmed === 'max') continue // 该级无限制：继续上溯，父级仍可能有界
    const max = Number(trimmed)
    if (!Number.isFinite(max) || max <= 0) continue
    const currentText = readTextFile(readFileSync, path.posix.join(dir, 'memory.current'))
    const current = currentText === null ? 0 : Number(currentText.trim())
    const used = Number.isFinite(current) && current >= 0 ? current : 0
    headroom = Math.min(headroom, max - used)
    sawLimit = true
  }
  if (!sawLimit) return { status: 'unlimited' }
  return headroom > 0 ? { status: 'ok', headroomBytes: headroom } : { status: 'invalid' }
}

/**
 * fs.statfsSync(dir) 的可用字节（bavail × bsize）。抛错／非正返回 null（⇒ 预算整体回落 degraded）。
 */
function probeDiskAvailBytes ({ statfsSync = fs.statfsSync, dir = process.cwd() } = {}) {
  try {
    const stats = statfsSync(String(dir))
    const avail = Number(stats.bavail) * Number(stats.bsize)
    return Number.isFinite(avail) && avail > 0 ? Math.floor(avail) : null
  } catch (e) {
    return null
  }
}

// 当前覆盖文件字节数（readMaxBytes 的输入之一）：读不到按 0——只影响读硬顶的下界，不影响预算。
function statRulesFileBytes (filePath) {
  if (typeof filePath !== 'string' || filePath === '') return 0
  try {
    const meta = storage.statSafeMeta(filePath)
    return meta.status === 'ok' && isPositiveSafeInt(meta.size) ? meta.size : 0
  } catch (e) {
    return 0
  }
}

// 容量目录：只认绝对路径（与 XBK_CACHE_DIR 的既有规则一致：相对路径忽略，见 SYSTEM_CONTRACT 缓存目录条）。
function resolveCapacityDir (explicit, env) {
  for (const candidate of [explicit, safeGet(env, FILTER_CACHE_DIR_ENV)]) {
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (text !== '' && path.isAbsolute(text)) return text
  }
  return null
}

/**
 * 读共读的容量文件（<缓存目录>/filter-capacity.json）。任何不合规形态返回 null（= 没有文件），绝不
 * 部分采用：这份文件决定 console 与 worker 的预算，读到半份就等于两边各用一套。
 * @returns {{totalBytes:number, perField:Object, mainChars:number, source:string,
 *            degraded:boolean, at:number, softCapBytes:(number|null)}|null}
 */
function readCapacityFile (filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null
  try {
    const read = storage.readSafeTextResult(filePath, FILTER_CAPACITY_FILE_MAX_BYTES, { openNonBlocking: true })
    if (!read || read.status !== 'ok' || typeof read.text !== 'string') return null
    let data
    try { data = JSON.parse(read.text) } catch (e) { return null }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    if (data.schema !== FILTER_CAPACITY_SCHEMA) return null
    if (!isPositiveSafeInt(data.totalBytes) || data.totalBytes < FILTER_MIN_TOTAL_BYTES || data.totalBytes > FILTER_MAX_TOTAL_BYTES) return null
    if (typeof data.source !== 'string' || data.source === '') return null
    if (typeof data.degraded !== 'boolean') return null
    if (typeof data.at !== 'number' || !Number.isFinite(data.at)) return null
    if (!data.perField || typeof data.perField !== 'object' || Array.isArray(data.perField)) return null
    const perField = {}
    for (const field of FILTER_RULE_FIELDS) {
      const entry = safeGet(data.perField, field)
      const chars = entry && typeof entry === 'object' ? safeGet(entry, 'chars') : undefined
      if (!isPositiveSafeInt(chars)) return null
      perField[field] = Object.freeze({ chars })
    }
    const mainCharEntry = safeGet(perField, FILTER_MAIN_FIELDS[0])
    return {
      totalBytes: data.totalBytes,
      perField: Object.freeze(perField),
      mainChars: mainCharEntry.chars,
      source: data.source,
      degraded: data.degraded,
      at: data.at,
      softCapBytes: isPositiveSafeInt(data.softCapBytes) ? data.softCapBytes : null
    }
  } catch (e) {
    return null
  }
}

function sameFieldChars (a, b) {
  for (const field of FILTER_RULE_FIELDS) {
    const left = a && typeof a === 'object' ? safeGet(a, field) : undefined
    const right = b && typeof b === 'object' ? safeGet(b, field) : undefined
    if (!left || !right || left.chars !== right.chars) return false
  }
  return true
}

/**
 * 写容量文件（0600，writeAtomic 原子提交）。预算没变时**不重写**并保留原 `at`——worker 每 5 秒
 * spawn 一次单轮进程，每轮重写等于把「启动钉住」换成新的写放大；`at` 只在预算真的变化时前进。
 * @returns {boolean} 是否落盘成功（失败只告警，绝不阻断模块加载）
 */
function writeCapacityFile (filePath, capacity, nowMs) {
  if (typeof filePath !== 'string' || filePath === '') return false
  try {
    const prev = readCapacityFile(filePath)
    if (prev && prev.totalBytes === capacity.totalBytes && prev.source === capacity.source &&
        prev.degraded === capacity.degraded && prev.softCapBytes === capacity.softCapBytes &&
        prev.mainChars === capacity.mainChars && sameFieldChars(prev.perField, capacity.perField) &&
        isOwnerOnlyFile(filePath)) {
      return true
    }
    const payload = {
      schema: FILTER_CAPACITY_SCHEMA,
      totalBytes: capacity.totalBytes,
      perField: capacity.perField,
      mainChars: capacity.mainChars,
      source: capacity.source,
      degraded: capacity.degraded,
      softCapBytes: capacity.softCapBytes,
      at: Math.floor(Number.isFinite(nowMs) ? nowMs : Date.now())
    }
    const ok = writeAtomic(filePath, JSON.stringify(payload), '过滤规则容量')
    if (!ok) {
      console.warn(`⚠️ 过滤规则容量文件写入失败（本进程仍用已钉住的预算，但 console/worker 可能各算一份）：${filePath}`)
    }
    return ok
  } catch (e) {
    console.warn(`⚠️ 过滤规则容量文件写入异常（本进程仍用已钉住的预算）：${filePath}：${safeErrorMessage(e)}`)
    return false
  }
}

// 以容量文件为准时的派生：totalBytes/perField/mainChars 用文件的，readMaxBytes 按**当前**文件字节数
// 重算（只会更大，方向安全——读端不得比写端更严）。
function adoptSharedCapacity (shared, { fileBytes, softCapBytes }) {
  const base = layoutFilterCapacity(shared.totalBytes, {
    fileBytes,
    source: shared.source,
    degraded: shared.degraded,
    degradedReasons: ['沿用容量文件（以文件为准）'],
    softCapBytes: softCapBytes === null ? FILTER_DEFAULT_SOFT_CAP_BYTES : softCapBytes
  })
  return { ...base, perField: shared.perField, mainChars: shared.mainChars }
}

/**
 * 解析本进程的过滤规则预算：探测一次 → 与容量文件对齐（跨进程共读）→（必要时）写回容量文件。
 * **只在模块加载调用一次**；保存路径绝不重算。注入点只给测试用（生产走 /proc、/sys、fs 与 process.env）。
 * 优先级：显式 XBK_FILTER_SOFT_CAP_BYTES（用户显式覆盖，且会重写容量文件）＞ 容量文件（启动钉住，
 * 两进程同预算）＞ 本进程探测。
 * @returns {Object} computeFilterCapacity 形状的冻结对象
 */
function resolveFilterLimits (options) {
  const opts = options && typeof options === 'object' ? options : {}
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env
  const readFileSync = typeof opts.readFileSync === 'function' ? opts.readFileSync : fs.readFileSync
  const statfsSync = typeof opts.statfsSync === 'function' ? opts.statfsSync : fs.statfsSync
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const rawSoftCap = safeGet(env, FILTER_SOFT_CAP_ENV)
  const softCap = parseSoftCapBytes(rawSoftCap)
  if (softCap.invalid) {
    console.warn(`⚠️ ${FILTER_SOFT_CAP_ENV}=${String(rawSoftCap)} 不是十进制整数，已回落默认 ${FILTER_DEFAULT_SOFT_CAP_BYTES} 字节（要自动探测就不要设置它）`)
  }
  try {
    const cacheDir = resolveCapacityDir(opts.cacheDir, env)
    const probeErrors = []
    const memAvailableBytes = probeMemAvailableBytes({ readFileSync })
    const cgroup = probeCgroupHeadroomBytes({ readFileSync })
    // 'unavailable'（无 /proc/self/cgroup 或没有 memory 层级）与 'unlimited'（所有层级都写 max）都是
    // **没有 cgroup 上限**，不是探测失败：此时只剩 MemAvailable 一个约束（否则裸机会被误判成 degraded）。
    // 只有 'invalid'（max ≤ current，进程已贴着上限）算失败——那时 memBudget 会算出 0 或负数。
    if (cgroup.status === 'invalid') probeErrors.push('cgroup memory headroom ≤ 0（max ≤ current）')
    const diskAvailBytes = probeDiskAvailBytes({ statfsSync, dir: cacheDir || process.cwd() })
    const fileBytes = statRulesFileBytes(cacheDir ? filterRulesPaths(cacheDir).file : null)
    const local = computeFilterCapacity({
      memAvailableBytes,
      cgroupHeadroomBytes: cgroup.status === 'ok' ? cgroup.headroomBytes : Infinity,
      diskAvailBytes,
      fileBytes,
      softCapBytes: softCap.bytes,
      probeErrors
    })
    // 路径构造统一走 filterRulesPaths（本模块不自行拼运行期目录）：capacity 与其余覆盖文件同源，
    // 也让「运行期目录 + 字面量文件名」这一类 path.join 只存在于被 .codacy.yml 排除的纯路径模块里。
    const capacityPath = cacheDir ? filterRulesPaths(cacheDir).capacity : null
    let capacity = local
    if (capacityPath) {
      const shared = readCapacityFile(capacityPath)
      if (shared) {
        if (softCap.explicit) {
          // 显式覆盖优先：否则「可覆盖」在第二个进程上就失效（文件是上一次的钉住值）。
          if (shared.totalBytes !== local.totalBytes) {
            console.warn(`⚠️ 容量文件（${capacityPath}）记录 totalBytes=${shared.totalBytes}，与本次 ${FILTER_SOFT_CAP_ENV}=${softCap.bytes} 算出的 ${local.totalBytes} 不一致：以显式覆盖为准并重写容量文件`)
          }
        } else if (shared.totalBytes !== local.totalBytes || shared.source !== local.source) {
          console.warn(`⚠️ 本进程探测到 totalBytes=${local.totalBytes}（${local.source}），与容量文件（${capacityPath}）的 ${shared.totalBytes}（${shared.source}）不一致：以文件为准（启动钉住，console 与 worker 必须用同一份预算）`)
          capacity = adoptSharedCapacity(shared, { fileBytes, softCapBytes: shared.softCapBytes })
        }
      }
      writeCapacityFile(capacityPath, capacity, now())
    }
    return Object.freeze(capacity)
  } catch (e) {
    // 模块加载期绝不抛穿：任何意外都回落今日常量（degraded），否则整轮推送起不来。
    console.warn(`⚠️ 过滤规则预算解析异常，已回落 ${FILTER_RULES_MAX_BYTES} 字节 / ${FILTER_FIELD_MAX_LEN} 字符：${safeErrorMessage(e)}`)
    return Object.freeze(computeFilterCapacity({ probeErrors: ['预算解析异常'] }))
  }
}

const LIMIT_SCALAR_KEYS = Object.freeze([
  'rulesFileMaxBytes', 'readMaxBytes', 'requestBodyMaxBytes', 'saveHeadroomBytes',
  'lastgoodWrapperBytes', 'appliedWrapperBytes',
  'maxRuleLines', 'maxRuleLinesPerField', 'maxAlternationsPerField'
])
// 今日常量（fail-closed 兜底）：探测失败与「表里某项被改坏」都回落这一组，数值与 F1 逐字相同
// ——与 FILTER_LIMITS 的构造共用上面那几个常量，同一批数字不再写两遍。
const LIMIT_FALLBACKS = Object.freeze({
  totalBytes: FILTER_RULES_MAX_BYTES,
  perField: Object.freeze(Object.fromEntries(FILTER_RULE_FIELDS.map(field => [field, Object.freeze({ chars: FILTER_FIELD_MAX_LEN })]))),
  rulesFileMaxBytes: FILTER_RULES_MAX_BYTES,
  readMaxBytes: FILTER_RULES_MAX_BYTES,
  requestBodyMaxBytes: FILTER_RULES_MAX_BYTES,
  saveHeadroomBytes: FILTER_SAVE_HEADROOM_BYTES,
  lastgoodWrapperBytes: FILTER_WRAPPER_BYTES,
  appliedWrapperBytes: FILTER_WRAPPER_BYTES,
  maxRuleLines: FILTER_MAX_RULE_LINES,
  maxRuleLinesPerField: FILTER_MAX_RULE_LINES_PER_FIELD,
  maxAlternationsPerField: FILTER_MAX_ALTERNATIONS_PER_FIELD
})

/**
 * 加载期校验预算表：不合格的项逐项回落 LIMIT_FALLBACKS 并 console.warn（fail-closed）。
 * 为什么必须有这道闸：xbk_storage.resolveMaxBytes 在 maxBytes 非正/NaN 时返回 null = **不设限整读**
 * （xbk_storage.js:204），一次笔误就会把「有界读」变成「无界读」。所有闸门读的都是本函数产出的
 * 冻结对象，故 NaN/0/负数永远到不了 readSafeTextResult。
 * 两条结构不变式在这里兜住：① 11 个字段的 perField 必须齐全（fieldMaxLenOf 的 0 只留给**未知**字段）；
 * ② 写入接受阈值（rulesFileMaxBytes − saveHeadroomBytes）必须 ≤ 读硬顶 readMaxBytes——否则就是
 * 「保存成功但下一轮读端判超限 → 整份降级」。
 * @param {{totalBytes?:number, perField?:Object, [key:string]:number}} [limits]
 * @returns {{totalBytes:number, perField:Object, fieldMaxLen:Object, [key:string]:number}}
 */
function normalizeFilterLimits (limits) {
  const bad = []
  const source = limits && typeof limits.perField === 'object' && limits.perField !== null ? limits.perField : {}
  const perField = {}
  const fieldMaxLen = {}
  for (const field of FILTER_RULE_FIELDS) {
    const entry = safeGet(source, field)
    const value = entry && typeof entry === 'object' ? safeGet(entry, 'chars') : undefined
    const fallbackChars = LIMIT_FALLBACKS.perField[field].chars
    if (isPositiveSafeInt(value)) {
      perField[field] = Object.freeze({ chars: value })
      fieldMaxLen[field] = value
    } else {
      bad.push(`perField.${field}.chars=${String(value)}`)
      perField[field] = Object.freeze({ chars: fallbackChars })
      fieldMaxLen[field] = fallbackChars
    }
  }
  const normalized = { perField: Object.freeze(perField), fieldMaxLen: Object.freeze(fieldMaxLen) }
  const totalBytes = limits ? limits.totalBytes : undefined
  if (isPositiveSafeInt(totalBytes) && totalBytes >= FILTER_MIN_TOTAL_BYTES && totalBytes <= FILTER_MAX_TOTAL_BYTES) {
    normalized.totalBytes = totalBytes
  } else {
    bad.push(`totalBytes=${String(totalBytes)}`)
    normalized.totalBytes = LIMIT_FALLBACKS.totalBytes
  }
  for (const key of LIMIT_SCALAR_KEYS) {
    const value = limits ? limits[key] : undefined
    if (isPositiveSafeInt(value) && value <= FILTER_MAX_LIMIT_VALUE) normalized[key] = value
    else {
      bad.push(`${key}=${String(value)}`)
      normalized[key] = LIMIT_FALLBACKS[key]
    }
  }
  // ③ 整份预算不得大于 totalBytes（spec：整份 ≤ totalBytes − 32；反向不设下限，方向只会更严）。
  if (normalized.rulesFileMaxBytes > normalized.totalBytes) {
    bad.push(`rulesFileMaxBytes=${normalized.rulesFileMaxBytes} 大于 totalBytes=${normalized.totalBytes}`)
    normalized.rulesFileMaxBytes = normalized.totalBytes
  }
  // ④ 请求体预算必须容得下整份预算——否则「预算填满」的文件按请求体就被 413，等于白抬上限。
  const minRequestBodyMaxBytes = Math.min(normalized.totalBytes + FILTER_REQUEST_BODY_MARGIN_BYTES, FILTER_MAX_LIMIT_VALUE)
  if (normalized.requestBodyMaxBytes < minRequestBodyMaxBytes) {
    bad.push(`requestBodyMaxBytes=${normalized.requestBodyMaxBytes} 小于 totalBytes+${FILTER_REQUEST_BODY_MARGIN_BYTES}=${minRequestBodyMaxBytes}`)
    normalized.requestBodyMaxBytes = minRequestBodyMaxBytes
  }
  const acceptMaxBytes = normalized.rulesFileMaxBytes - normalized.saveHeadroomBytes
  if (acceptMaxBytes > normalized.readMaxBytes) {
    bad.push(`readMaxBytes=${normalized.readMaxBytes} 小于写入接受阈值 ${acceptMaxBytes}`)
    normalized.readMaxBytes = Math.min(normalized.rulesFileMaxBytes, FILTER_MAX_TOTAL_BYTES)
  }
  if (bad.length) {
    console.warn(`⚠️ FILTER_LIMITS 非法（${bad.join('、')}），已 fail-closed 回落到今日常量`)
  }
  return normalized
}

// 模块加载时探测一次并钉住（console 与 worker 通过 <缓存目录>/filter-capacity.json 共读同一份）。
const RESOLVED_CAPACITY = resolveFilterLimits()

// 冻结的预算表：全仓唯一的取值入口（console 也从这里取 readMaxBytes / requestBodyMaxBytes）。
// perField[field].chars 是**按 11 个字段全覆盖的表**（主字段 mainChars、plus 2048、小字段 1000）；
// fieldMaxLen 是同一份数据的扁平视图（兼容既有调用方）。未知字段由 fieldMaxLenOf 返回 0，绝不回落成「无限」。
const FILTER_LIMITS = Object.freeze({
  ...normalizeFilterLimits(RESOLVED_CAPACITY),
  source: RESOLVED_CAPACITY.source,
  degraded: RESOLVED_CAPACITY.degraded
})

// 保存路径的单字段上限：以 FILTER_LIMITS.fieldMaxLen 为准；**未知字段返回 0**（一律拒绝），
// 绝不回落成无限——那等于给每个新增的未知字段开一条绕过长度闸门的通道。
function fieldMaxLenOf (field) {
  return hasOwn(FILTER_LIMITS.fieldMaxLen, field) ? FILTER_LIMITS.fieldMaxLen[field] : 0
}

// 读路径的单字段上限：max(今日单字段上限, fieldMaxLenOf(field))——读端必须能读回存量文件：
// F3 把非主字段的写预算收到 1000/2048，但存量里可能有 16,000 字符的老字段，判 corrupt 等于让规则
// 静默失效（比保存被拒严重得多）。故读端永远不严于今日的 16,000。
function readFieldMaxLen (field) {
  return Math.max(FILTER_FIELD_MAX_LEN, fieldMaxLenOf(field))
}

/**
 * LKG / 生效快照的读上限 = 读硬顶 + 包装预算，并在加载期做**形态与上界**校验：预算可被外部覆盖，
 * 派生值不得变成 NaN 或被静默溢出（NaN 传给 readSafeTextResult = 无界读；比上限还大则等于放开读端）。
 * @param {{readMaxBytes?:number, lastgoodWrapperBytes?:number, appliedWrapperBytes?:number}} [input]
 * @returns {{lastgoodMaxBytes:number, appliedMaxBytes:number, fallback:boolean}}
 */
function computeDerivedReadLimits (input) {
  const opts = input && typeof input === 'object' ? input : {}
  const hardCap = FILTER_MAX_TOTAL_BYTES + FILTER_WRAPPER_BYTES
  let fallback = false
  const sumOf = (base, wrapper, label) => {
    const total = isPositiveSafeInt(base) && isPositiveSafeInt(wrapper) ? base + wrapper : NaN
    if (isPositiveSafeInt(total) && total <= hardCap) return total
    fallback = true
    console.warn(`⚠️ 派生读上限 ${label} 非法（readMaxBytes=${String(base)} + 包装 ${String(wrapper)}），已 fail-closed 回落到 ${hardCap} 字节`)
    return hardCap
  }
  return {
    lastgoodMaxBytes: sumOf(opts.readMaxBytes, opts.lastgoodWrapperBytes, 'LASTGOOD_MAX_BYTES'),
    appliedMaxBytes: sumOf(opts.readMaxBytes, opts.appliedWrapperBytes, 'APPLIED_MAX_BYTES'),
    fallback
  }
}

/**
 * /preview 的扫描预算（F2-2）：最多扫 budgetMs 毫秒或 maxRecords 条 _f 记录，先到者停。
 * 为什么必须：保存前必调 preview，5000 条 × 2.01 ms ≈ 11.1 s，而客户端 FETCH_TIMEOUT_MS = 8 s
 * ——现在就已经超时；抬上限后是 52–107 s，且这个同步循环会把控制台的事件循环占死。
 * 语义：capped:true 只表示「还有记录没扫到」，调用方**不得**把 reEvalCount 当成完整补推数（atLeast）；
 * 小样本（条数 ≤ 预算且未超时）照旧完整返回，逐条判定结果与无预算时逐字相同。
 * 预算逻辑放这里（而不是 console.js）：console 的变异分片只剩个位数余量，且这段是纯函数，可直接单测。
 * @param {{records:Array<Object>, limit:number, evaluate:Function, whitelistKeeps?:Function,
 *          budgetMs?:number, maxRecords?:number, maxScan?:number, now?:Function}} opts
 *   evaluate(entry) → {passed:boolean, reason?:string} | null（抛错按 null = 未通过处理）
 *   whitelistKeeps(entry) → boolean（默认全部保留；运行期 zkt_gjc 白名单从这里接）
 * @returns {{scanned:number, capped:boolean, cappedBy:('records'|'time'|'max'|null), budgetMs:number,
 *            reEvalCount:number, samples:Array, elapsedMs:number}}
 */
function scanPreviewRecords ({
  records, limit, evaluate, whitelistKeeps = null,
  budgetMs = FILTER_PREVIEW_BUDGET_MS, maxRecords = FILTER_PREVIEW_BUDGET_RECORDS,
  maxScan = Infinity, now = Date.now
} = {}) {
  const list = Array.isArray(records) ? records : []
  const sampleLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0
  const startedAt = now()
  let scanned = 0
  let reEvalCount = 0
  let cappedBy = null
  const samples = []
  for (const entry of list) {
    // 三个上限的顺序：硬上限（历史 5000 条）→ 条数预算 → 时间预算。任一条触发都只停「继续扫」，
    // 已扫到的结果照常返回。
    if (scanned >= maxScan) { cappedBy = 'max'; break }
    if (scanned >= maxRecords) { cappedBy = 'records'; break }
    if (now() - startedAt >= budgetMs) { cappedBy = 'time'; break }
    scanned++
    let verdict = null
    try { verdict = evaluate(entry) } catch (e) { verdict = null }
    if (!verdict || verdict.passed !== true) continue
    if (whitelistKeeps && whitelistKeeps(entry) !== true) continue
    reEvalCount++
    if (samples.length < sampleLimit) {
      samples.push({
        id: entry.id === undefined ? null : entry.id,
        title: typeof entry.title === 'string' ? entry.title : '',
        reason: verdict.reason === undefined ? null : verdict.reason
      })
    }
  }
  return {
    scanned,
    capped: cappedBy !== null,
    cappedBy,
    budgetMs,
    reEvalCount,
    samples,
    elapsedMs: now() - startedAt
  }
}

/**
 * GET /api/config/filter 的 limits / usage 块（F2-5）。
 * 前端要显示余量与文案，但此前的响应里没有任何上限信息，前端只能写死 256 KiB（pages.js:4846）。
 * 这里把 FILTER_LIMITS（全仓唯一取值入口）与当前用量一起下发；F3 起前端已接：字段计数器显示
 * 「已用 / 上限」（取 perField[name].chars），413 文案用 limits.requestBodyMaxBytes。
 * 规则文件字节数：缺失按 0，其它读不到的情况如实报 null——不把「不知道」说成 0。
 * 元数据走 storage.statSafeMeta（xbk_storage.js 的唯一元数据原语，O_NOFOLLOW + 普通文件断言），
 * 不走 fs.statSync：后者会跟随末级符号链接（大小取自链接目标，等于泄露目标的信息），
 * 对目录/FIFO 也会报出一个「字节数」。statSafeMeta 只有 status==='ok' 才有 size，
 * unsafe（符号链接/非普通文件）/ioError 一律 null ⇒ 口径不变、语义只强不弱（不再跟随链接）。
 * @param {string} cacheDir
 * @param {Object} [filter] 当前生效规则（11 字段合并结果），用于各字段字符数
 * @returns {{limits:Object, usage:{rulesFileBytes:(number|null), fieldChars:Object}}}
 */
function filterLimitsReport (cacheDir, filter) {
  const paths = filterRulesPaths(cacheDir)
  const meta = storage.statSafeMeta(paths.file)
  const rulesFileBytes = meta.status === 'ok' ? meta.size : (meta.status === 'missing' ? 0 : null)
  const fieldChars = {}
  for (const field of FILTER_RULE_FIELDS) {
    const value = safeGet(filter, field)
    fieldChars[field] = typeof value === 'string' ? value.length : 0
  }
  return {
    limits: {
      // totalBytes：本机钉住的整份预算（perField 与两个旋钮都由它派生）。
      totalBytes: FILTER_LIMITS.totalBytes,
      // perField[field].chars 是 spec 口径（单字段码元上限）；fieldMaxLen 是同一份数据的扁平视图。
      // 两者都是**拷贝**：响应对象要被 JSON 序列化，直接下发进程内的冻结表会让引用泄漏（少一层边界）。
      perField: Object.fromEntries(FILTER_RULE_FIELDS.map(field => [field, { chars: FILTER_LIMITS.perField[field].chars }])),
      fieldMaxLen: { ...FILTER_LIMITS.fieldMaxLen },
      rulesFileMaxBytes: FILTER_LIMITS.rulesFileMaxBytes,
      requestBodyMaxBytes: FILTER_LIMITS.requestBodyMaxBytes,
      readMaxBytes: FILTER_LIMITS.readMaxBytes,
      saveHeadroomBytes: FILTER_LIMITS.saveHeadroomBytes,
      maxRuleLines: FILTER_LIMITS.maxRuleLines,
      maxRuleLinesPerField: FILTER_LIMITS.maxRuleLinesPerField,
      maxAlternationsPerField: FILTER_LIMITS.maxAlternationsPerField,
      // 预算从哪来（probe／fallback）与是否降级：控制台据此显示「本机上限」的口径。
      source: FILTER_LIMITS.source,
      degraded: FILTER_LIMITS.degraded
    },
    usage: { rulesFileBytes, fieldChars }
  }
}

// 持久 LKG 的读上限（F4-1 返工 R3）：LKG 是覆盖文件的**再包装**——`{schema,revision,hash,override}`
// 比覆盖文件的 `{schema,revision,filter}` 多出 `"hash":"<64 位十六进制>",`（74 字节）与
// `"override"`/`"filter"` 的键名差（+2），实测 +76 字节。若读写共用 FILTER_RULES_MAX_BYTES，
// 则覆盖文件落在 (MAX-76, MAX] 这段（控制台保存闸门允许 ≤ MAX-32，手改可到 MAX）时，写出的 LKG
// 必然 > MAX ⇒ readSafeTextResult 判 tooLarge ⇒ readLastGood 返回 null ⇒ 新进程降级回代码默认，
// 而写入侧仍返回 true（「写成功但读不回」，与 C9-012 同类的阈值差几字节缺陷，只是差在包装层）。
// 读上限 = 读硬顶（FILTER_LIMITS.readMaxBytes）+ 包装预算；写入侧（writeLastGoodFile）用同一常量预检，
// 绝不产出读不回的文件。派生值的形态/上界校验由 computeDerivedReadLimits 兜住（预算可被外部覆盖，
// NaN 传给 readSafeTextResult 等于无界读）。
const DERIVED_READ_LIMITS = computeDerivedReadLimits(FILTER_LIMITS)
const LASTGOOD_MAX_BYTES = DERIVED_READ_LIMITS.lastgoodMaxBytes
// 生效快照（filter-rules.applied.json）的读上限：它是覆盖文件的**超集**，不能直接复用
// FILTER_RULES_MAX_BYTES。比覆盖文件多出：11 个白名单字段按合并结果**补齐**（覆盖文件缺的字段
// 也要写成 ""）、`source`/`hash`/`appliedAt`/`lastGoodUsed` 四个诊断字段、以及 `keyword` 包装
// ——空字段夹具实测 +179 字节（hash 取 64 位十六进制、appliedAt 取完整 ISO 时间）。
// 若读写共用覆盖文件上限：控制台保存闸门只留 32 字节余量（serializedBytes ≤ MAX-32），覆盖文件
// 落在 (MAX-179, MAX-32] 时写出的 applied.json 必然 > MAX ⇒ readSafeTextResult 判 tooLarge
// ⇒ readAppliedSnapshot 恒 ioError ⇒「内容一致跳过写盘」永不生效、控制台永远显示「尚未生效」
// （与 LKG 的 R3 同一类缺陷：写成功但读不回）。故读上限 = 覆盖文件上限 + 包装预算；
// 写入侧（writeAppliedSnapshot）用同一常量预检，绝不落一个自己读不回的快照。
const APPLIED_MAX_BYTES = DERIVED_READ_LIMITS.appliedMaxBytes
// pingbitime 天数上限：与 xbk_rules.compileRules / validateConfig 的 PINGBITIME_MAX_DAYS 同值。
// 超上限的行会被运行期静默丢弃 ⇒ 编译对账必然失败，这里提前给出明确错误码。
const PINGBITIME_MAX_DAYS = 3650000

// 控制字符：允许 \t(09) \n(0A) \r(0D)，其余 C0 与 DEL 一律拒绝。
// （禁止的是把终端控制序列/截断符写进规则正文，不是禁止多行规则。）
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
// 行分隔口径必须与运行期 RuleEngine._splitLines / validateConfig 完全一致（含 <br> 与单独 \r）。
const LINE_SPLIT_RE = /<br\s*\/?>|\r\n|\r|\n/

// v3.391：保存时按行去重（大小写不敏感，保留首次出现的写法与顺序）。
// 用户习惯整段粘贴关键词列表——重复项不改变判定结果，却会让规则文件膨胀、编译与 ReDoS 扫描
// 白扫一遍，也让人看不出到底有多少条在真正生效。空行一并丢弃（运行期本来就忽略空行）。
function dedupeRuleLines (value) {
  const lines = String(value).split(LINE_SPLIT_RE)
  const seen = new Set()
  const kept = []
  let removed = 0
  for (const line of lines) {
    if (line.trim() === '') continue // 空行运行期本就忽略，顺手丢掉
    // 比较键 trim+小写：运行期编译时同样 trim、正则又带 i 标志，这两类差别不产生新语义。
    const key = line.trim().toLowerCase()
    if (seen.has(key)) { removed += 1; continue }
    seen.add(key)
    kept.push(line) // 保留首次出现的原样文本（含用户写的空格），不擅自改写规则
  }
  return { value: kept.join('\n'), removed }
}
// 未转义 `|` 的个数（F2-3）：`\|` 是字面竖线，`\\|` 是「转义反斜杠 + 交替」。从每个 `|` 往回数
// 连续反斜杠，偶数个（含 0）才算交替。逐字符线性扫描——不能用 replace 去转义序列，那会把
// `\\|` 里的交替一起吞掉（左分支是字符类里的反斜杠，右分支才是交替）。
function countUnescapedAlternations (value) {
  const text = typeof value === 'string' ? value : ''
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '|') continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++
    if (backslashes % 2 === 0) count++
  }
  return count
}
// 全命中：trim 后等于这两个字面量即视为「放行一切」，console 需二次确认。
const WIDE_MATCH_VALUES = new Set(['.*', '^.*$'])
const FIELD_SET = new Set(FILTER_RULE_FIELDS)

// 进程内 last-known-good：**只**保存最近一次合法覆盖文件的 {filter, revision}，
// 且按 cacheDir 分槽（键 = 覆盖文件所在目录）。一个进程可能读多个缓存目录（测试/控制台/多实例），
// 用单个槽位会让「A 目录的合法规则」在「B 目录损坏」时代入，把 B 的过滤面悄悄改成 A 的（A2）。
// 键取 path.dirname(filterRulesPaths(cacheDir).file)，而不是给 filterRulesPaths 增加 dir 字段——
// 后者被 console/qinglong 共用，为一行取值扩大公共契约不划算。
// 不是 activeFilter 缓存——每轮 loadFilterRules 仍重新读盘、重新合并、返回新对象。
const lastGoodByDir = new Map()

function cacheDirKey (cacheDir) {
  // filterRulesPaths 对非法 cacheDir 已退化为 '.'（不抛错），dirname 恒为字符串。
  return path.dirname(filterRulesPaths(cacheDir).file)
}

function safeGet (obj, key) {
  // 脏对象/Proxy 的抛错 getter 不得抛穿（与 xbk_rules.readField 同口径）。
  try { return obj === null || obj === undefined ? undefined : obj[key] } catch (e) { return undefined }
}

function safeString (value) {
  if (value === undefined || value === null || typeof value === 'symbol') return ''
  try { return String(value) } catch (e) { return '' }
}

function safeErrorMessage (error, fallback = '未知错误') {
  // 不直接读 e.message：它本身可能是会抛的 getter。
  const message = safeGet(error, 'message')
  return typeof message === 'string' && message ? message : fallback
}

function hasOwn (obj, key) {
  try { return Object.prototype.hasOwnProperty.call(obj, key) } catch (e) { return false }
}

function normalizeKeyword (keyword, { forSnapshot = false } = {}) {
  // 规格 §4.1：keyword 只读、v1 不开放写入，但仍随生效规则一起返回，
  // 避免运行侧出现「规则走覆盖、关键词走代码」的分裂。
  const raw = safeGet(keyword, 'zkt_gjc')
  if (raw === undefined || raw === null) return { zkt_gjc: '' }
  // 生效快照是落盘产物，必须可 JSON 化 ⇒ 一律字符串化。
  if (forSnapshot) return { zkt_gjc: safeString(raw) }
  // 运行侧必须保留原始类型：非字符串（对象/数字/布尔）由 App.run 显式告警并跳过「只看它」；
  // 若在此 String 化，对象会变成 '[object Object]' 正则（字符类），静默把全部条目滤掉（R11-1 回归）。
  // 正常配置（字符串）逐字符不变，故这是纯扩大信息量的透传，不改变合法输入的语义。
  return { zkt_gjc: raw }
}

/**
 * 合并生效规则：覆盖文件逐字段覆盖代码默认，缺字段回默认（规格 §4.1 / 计划 §2）。
 * 返回值每轮新建；字符串不可变，故不存在跨轮共享可变引用。
 */
function mergeActiveFilter ({ defaults, keyword, override } = {}) {
  const base = defaults && typeof defaults === 'object' ? defaults : {}
  const over = override && typeof override === 'object' ? override : {}
  const filter = {}
  for (const field of FILTER_RULE_FIELDS) {
    const overValue = safeGet(over, field)
    if (hasOwn(over, field) && typeof overValue === 'string') {
      filter[field] = overValue
    } else {
      filter[field] = safeString(safeGet(base, field))
    }
  }
  return { filter, keyword: normalizeKeyword(keyword) }
}

/**
 * 覆盖文件里「实际存在」的字段（只含白名单内的字符串值）。
 * 与 mergeActiveFilter 的区别：这里**不补代码默认**，只回原文——读面据此告诉前端
 * 「本次没改、但已落盘」的字段，避免整份替换的保存把它们静默删掉。
 * 与 filter 同源（同一次读盘的结果），不得各自再读一遍文件。
 */
function overrideFieldsOf (override) {
  const over = override && typeof override === 'object' ? override : {}
  const out = {}
  for (const field of FILTER_RULE_FIELDS) {
    const value = safeGet(over, field)
    if (hasOwn(over, field) && typeof value === 'string') out[field] = value
  }
  return out
}

// 逐字段错误：{field, code, message} +（长度/字节这类闸门）{limit, actual}——前端要显示
// 「已用／上限」与「本机上限 N、当前 M」，只给一句话文案就得再解析字符串。
function addError (errors, field, code, message, extra) {
  const item = { field, code, message }
  if (extra && typeof extra === 'object') {
    if (Number.isSafeInteger(extra.limit)) item.limit = extra.limit
    if (Number.isSafeInteger(extra.actual)) item.actual = extra.actual
  }
  errors.push(item)
}

function isValidDays (value) {
  const days = Number(value)
  // 必须是整数：运行期 compileRules 对天数做 Math.floor，保存 1.9 实际按 1 天跑，
  // 「保存值」与「生效值」不一致且无任何告警（A5）。上下限口径不变。
  return Number.isFinite(days) && Number.isInteger(days) && days >= 0 && days <= PINGBITIME_MAX_DAYS
}

function engineAvailable (deps) {
  // 注入形状：deps.re2Available:boolean 或 deps.isRe2Available():boolean（任选其一）。
  // 两者都未声明时按「可用」处理：真正的编译失败仍会由 compileUserRegex 返回 null
  // 并落到 invalid_category_regex / invalid_value_regex（调用方契约要求显式声明）。
  if (typeof deps.isRe2Available === 'function') {
    try { return deps.isRe2Available() === true } catch (e) { return false }
  }
  if (typeof deps.re2Available === 'boolean') return deps.re2Available
  return true
}

function compileOk (deps, source) {
  try { return Boolean(deps.compileUserRegex(source, 'i')) } catch (e) { return false }
}

/**
 * 校验待保存/待预检的过滤规则（五道闸：schema/字段白名单/长度 → 行语法 → RE2 与嵌套量词 →
 * 编译对账 → 整份字节预算；最后一道只约束保存入参，读路径以 options.fromDisk 跳过。规格 §3 / 计划 §3.3）。
 *
 * @param {{schema?:number, revision?:number, filter:Object}} input
 *   revision 省略按 0 处理（`/validate` 允许只带 filter）；**显式传 null/''/字符串等非法值一律拒绝**。
 *   filter 只接受 11 个白名单字段的字符串值；未出现的字段不参与覆盖（回代码默认）。
 * @param {{RuleEngine:Object, compileUserRegex:Function, re2Available?:boolean, isRe2Available?:Function}} deps
 * @param {{fromDisk?:boolean}} [options] fromDisk=true 表示「校验的是已落盘的覆盖文件」：闸门 5
 *   （整份文件字节预算）只约束**保存入参**，读路径一律不跑（见闸门 5 处注释）。
 * @returns {{ok:true, value:Object, wideMatch:string[]}|{ok:false, errors:Array<{field:string, code:string, message:string}>}}
 */
function validateFilterRules (input, deps, options) {
  const errors = []
  const engine = deps && deps.RuleEngine
  if (!engine || typeof engine.hasNestedQuantifier !== 'function' || typeof engine.compileRules !== 'function' ||
      typeof (deps && deps.compileUserRegex) !== 'function') {
    return {
      ok: false,
      errors: [{ field: 'filter', code: 'deps_invalid', message: '缺少注入的 RuleEngine.hasNestedQuantifier/compileRules 或 compileUserRegex' }]
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'filter', code: 'invalid_input', message: '请求体必须是对象' }] }
  }

  // ---------- 闸门 1：schema / revision / 字段白名单 / 字符串 / 长度 / 控制字符 ----------
  const schemaRaw = safeGet(input, 'schema')
  if (hasOwn(input, 'schema') && schemaRaw !== undefined && schemaRaw !== FILTER_RULES_SCHEMA) {
    addError(errors, 'schema', 'schema_mismatch', `schema 必须为 ${FILTER_RULES_SCHEMA}（当前 ${safeString(schemaRaw)}）`)
  }
  // revision：缺省=0；显式出现则必须是非负安全整数（空串/null/负值/小数/数字字符串全部拒绝）。
  const revisionRaw = safeGet(input, 'revision')
  if (hasOwn(input, 'revision') && revisionRaw !== undefined) {
    if (!Number.isSafeInteger(revisionRaw) || revisionRaw < 0) {
      addError(errors, 'revision', 'invalid_revision', 'revision 必须是非负整数（空值/字符串/小数均不接受）')
    }
  }
  let rawFilter
  try { rawFilter = input.filter } catch (e) { rawFilter = undefined }
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    addError(errors, 'filter', 'invalid_filter', 'filter 必须是对象')
    return { ok: false, errors }
  }

  const filter = {}
  let filterKeys
  try { filterKeys = Object.keys(rawFilter) } catch (e) { filterKeys = null }
  if (filterKeys === null) {
    addError(errors, 'filter', 'invalid_filter', 'filter 不是可枚举对象')
    return { ok: false, errors }
  }
  for (const field of filterKeys) {
    if (!FIELD_SET.has(field)) {
      addError(errors, field, 'unknown_field', `未知字段「${field}」不允许写入`)
      continue
    }
    const value = safeGet(rawFilter, field)
    if (value === undefined) continue // 与 JSON 语义一致：undefined 视同未提供
    if (typeof value !== 'string') {
      addError(errors, field, 'not_string', `字段「${field}」必须是字符串（当前 ${typeof value}）`)
      continue
    }
    // 单字段闸门：保存路径按**写预算**（perField[field].chars），读路径（fromDisk，deepValidationError
    // 复用）按**读预算** readFieldMaxLen（不低于今日常量的 16,000）——读端不得比写端更严，否则存量里
    // 合法的大字段会被判 too_long → 整份降级（「能保存但读不回」的镜像）。
    const fieldMaxLen = options && options.fromDisk === true ? readFieldMaxLen(field) : fieldMaxLenOf(field)
    if (value.length > fieldMaxLen) {
      addError(errors, field, 'too_long', `字段「${field}」长度 ${value.length} 超过上限 ${fieldMaxLen}`, { limit: fieldMaxLen, actual: value.length })
      continue
    }
    if (CONTROL_CHAR_RE.test(value)) {
      addError(errors, field, 'control_char', `字段「${field}」含控制字符（仅允许 \\n \\r \\t）`)
      continue
    }
    filter[field] = value
  }
  if (errors.length) return { ok: false, errors }

  // v3.391：自动去重（同一字段内重复行只留第一次，大小写不敏感）。只改落盘/回显的规则正文，
  // 判定语义不变：运行期本来就按 | 连接这些行，重复项等价于同一条规则写了两遍。
  const deduped = {}
  for (const field of Object.keys(filter)) {
    const result = dedupeRuleLines(filter[field])
    // 整段只有空白时保持原样：交给闸门 2 按既有口径报 empty_value，
    // 不能被「去重后变成空串」悄悄放行成一条空规则。
    if (result.value === '') continue
    filter[field] = result.value
    if (result.removed > 0) deduped[field] = result.removed
  }

  // ---------- 闸门 2：行语法（### 最多两段 / 值不能空 / pingbifenlei 不允许 ###）----------
  const ruleLines = [] // 多行规则的每一有效行：{ field, cat, val }
  const simpleRules = [] // 简单规则：{ field, val }
  const multilineCount = new Map()
  const alternationCount = new Map()
  for (const field of FILTER_RULE_FIELDS) {
    if (!hasOwn(filter, field)) continue
    const value = filter[field]
    if (value === '') continue
    // F2-3：交替数按**字段**统计（多行字段的每一行各是一条正则，分支数逐行累加）。
    // pingbitime 不含 ### 时值是纯天数（运行期 Number 解析，不编译正则）→ 整字段豁免；
    // 含 ### 时 `分类` 段**会**被 compileRules 编译成分类正则，所以分类段的交替数在下面的
    // 行解析里逐行累加（见 `@pingbitime-cat-alts`）。整字段豁免会让 `1001 个 |###7` 这种
    // 可编译的形状从闸门侧面溜过去（与「单字段未转义 | >1000 返回 400」的契约相反）。
    if (field !== 'pingbitime') {
      const alternations = countUnescapedAlternations(value)
      if (alternations > 0) alternationCount.set(field, alternations)
    }
    if (field === 'pingbifenlei' && value.includes('###')) {
      addError(errors, field, 'multiline_not_supported', 'pingbifenlei 不支持 ### 多行分类语法')
      continue
    }
    if (value.includes('###')) {
      let count = 0
      for (const line of value.split(LINE_SPLIT_RE)) {
        const trimmed = line.trim()
        if (!trimmed) continue // 空行与运行期一致：直接忽略
        const parts = trimmed.split('###')
        if (parts.length > 2) {
          addError(errors, field, 'too_many_segments', `行「${trimmed}」含多个 ###，最多两段（分类###正则）`)
          continue
        }
        if (parts.length < 2) {
          addError(errors, field, 'missing_separator', `行「${trimmed}」缺少 ### 分隔符`)
          continue
        }
        const cat = safeString(parts[0]).trim()
        const val = safeString(parts[1]).trim()
        if (field === 'pingbitime') {
          // @pingbitime-cat-alts：`分类###天数` 的分类段会被 compileRules 编译成正则，天数段只做
          // Number 解析 ⇒ 只统计分类段的交替数（纯 `天数` 仍整字段豁免，见上方整字段统计处）。
          // 按字段累加，与其它字段「整字段值」的口径一致（多行各是一条分类正则）。
          const catAlternations = countUnescapedAlternations(cat)
          if (catAlternations > 0) alternationCount.set(field, (alternationCount.get(field) || 0) + catAlternations)
        }
        if (!val) {
          addError(errors, field, 'empty_value', `行「${trimmed}」的正则值为空`)
          continue
        }
        if (field === 'pingbitime' && !isValidDays(val)) {
          addError(errors, field, 'invalid_number', `行「${trimmed}」的天数必须是 0..${PINGBITIME_MAX_DAYS} 的整数`)
          continue
        }
        ruleLines.push({ field, cat, val })
        count++
      }
      multilineCount.set(field, count)
    } else {
      const val = value.trim()
      if (!val) {
        addError(errors, field, 'empty_value', `字段「${field}」为空白字符，等同空值`)
        continue
      }
      if (field === 'pingbitime' && !isValidDays(val)) {
        addError(errors, field, 'invalid_number', `pingbitime 的天数必须是 0..${PINGBITIME_MAX_DAYS} 的整数`)
        continue
      }
      simpleRules.push({ field, val })
    }
  }
  // ---------- 闸门 2b：条目数（### 行数 / 单字段未转义 | 数；F2-3）----------
  // 只约束**保存**入参：读路径（fromDisk）必须能读回抬上限之前落盘的既有文件——把读端也卡住等于
  // 让「以前存得下」的规则文件突然变 corrupt，规则被静默降级（比保存被拒严重得多）。
  // 位置必须在闸门 4 的 compileRules 之前：33 万个 RE2 对象正是在那一步生成的，闸门放到后面就晚了。
  if (!(options && options.fromDisk === true)) {
    let totalLines = 0
    for (const count of multilineCount.values()) totalLines += count
    if (totalLines > FILTER_LIMITS.maxRuleLines) {
      addError(errors, 'filter', 'too_many_lines', `多行规则共 ${totalLines} 行 ### 规则，超过上限 ${FILTER_LIMITS.maxRuleLines} 行（每行会编译成 2 个正则对象，超限会耗尽内存），请删减后再保存`)
    }
    for (const [field, count] of multilineCount) {
      if (count > FILTER_LIMITS.maxRuleLinesPerField) {
        addError(errors, field, 'too_many_lines', `字段「${field}」有 ${count} 行 ### 规则，超过单字段上限 ${FILTER_LIMITS.maxRuleLinesPerField} 行（全份上限 ${FILTER_LIMITS.maxRuleLines} 行），请删减后再保存`)
      }
    }
    for (const [field, count] of alternationCount) {
      if (count > FILTER_LIMITS.maxAlternationsPerField) {
        addError(errors, field, 'too_many_lines', `字段「${field}」含 ${count} 个未转义 | 交替，超过单字段上限 ${FILTER_LIMITS.maxAlternationsPerField} 个（交替分支越多，编译与匹配代价越大），请改用更具体的规则后再保存`)
      }
    }
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 闸门 3：灾难性回溯结构（ReDoS；错误码仍为 nested_quantifier，勿改）+ RE2 可用性 + 正则语法 ----------
  for (const rule of ruleLines) {
    if (rule.cat && engine.hasNestedQuantifier(rule.cat)) {
      addError(errors, rule.field, 'nested_quantifier', `分类正则含灾难性回溯结构（嵌套量词，或组内交替/无限量词 + 组后重复，如 (a+)+、(a|aa)+）：「${rule.cat}」`)
    }
    if (engine.hasNestedQuantifier(rule.val)) {
      addError(errors, rule.field, 'nested_quantifier', `正则含灾难性回溯结构（嵌套量词，或组内交替/无限量词 + 组后重复，如 (a+)+、(a|aa)+）：「${rule.val}」`)
    }
  }
  for (const rule of simpleRules) {
    if (engine.hasNestedQuantifier(rule.val)) {
      addError(errors, rule.field, 'nested_quantifier', `正则含灾难性回溯结构（嵌套量词，或组内交替/无限量词 + 组后重复，如 (a+)+、(a|aa)+）：「${rule.val}」`)
    }
  }
  if (errors.length) return { ok: false, errors }

  // 仅含 pingbitime 的规则不需要 RE2（运行期用 Number 解析天数）——只有真正要编译正则的
  // 目标才触发 engine_unavailable，避免「仅时间规则」在缺 re2 的环境被误拒。
  const hasRegexTarget = simpleRules.some(rule => rule.field !== 'pingbitime') ||
    ruleLines.some(rule => rule.field !== 'pingbitime' || Boolean(rule.cat))
  if (hasRegexTarget && !engineAvailable(deps)) {
    // re2 不可用时**不落盘**（console 映射 503 engine_unavailable）：静默跳过正则会让规则面变宽。
    return { ok: false, errors: [{ field: 'filter', code: 'engine_unavailable', message: 'RE2 不可用，拒绝校验/保存过滤规则' }] }
  }
  for (const rule of ruleLines) {
    if (rule.cat && !compileOk(deps, rule.cat)) {
      addError(errors, rule.field, 'invalid_category_regex', `分类正则无法编译：「${rule.cat}」`)
    }
    if (rule.field !== 'pingbitime' && !compileOk(deps, rule.val)) {
      addError(errors, rule.field, 'invalid_value_regex', `正则无法编译：「${rule.val}」`)
    }
  }
  for (const rule of simpleRules) {
    // C9-010：pingbitime 运行期用 Number 解析天数、不需要正则引擎——闸门 3 的 hasRegexTarget
    // 已为「仅时间规则」放行，这里的编译循环必须同一口径（上方 ruleLines 的循环已有该守卫）。
    // 否则缺 re2 的环境（compileUserRegex 恒 null）会把用户唯一还能用的时间规则判成
    // invalid_value_regex 直接拒掉。
    if (rule.field === 'pingbitime') continue
    if (!compileOk(deps, rule.val)) {
      addError(errors, rule.field, 'invalid_value_regex', `正则无法编译：「${rule.val}」`)
    }
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 闸门 4：编译结果对账（与运行期 compileRules 同源，防口径漂移）----------
  const fullCfg = {}
  for (const field of FILTER_RULE_FIELDS) fullCfg[field] = hasOwn(filter, field) ? filter[field] : ''
  let compiled
  try {
    compiled = engine.compileRules(fullCfg)
  } catch (e) {
    return { ok: false, errors: [{ field: 'filter', code: 'compile_error', message: `规则编译异常：${safeErrorMessage(e)}` }] }
  }
  if (!compiled || typeof compiled !== 'object') {
    return { ok: false, errors: [{ field: 'filter', code: 'compile_mismatch', message: 'compileRules 未返回编译结果对象' }] }
  }
  for (const field of FILTER_RULE_FIELDS) {
    if (!hasOwn(filter, field) || filter[field] === '') continue
    const multi = filter[field].includes('###')
    const expectedType = field === 'pingbitime'
      ? (multi ? 'timeMulti' : 'time')
      : (multi ? 'multi' : 're')
    const node = safeGet(compiled, field)
    const actualType = node && typeof node === 'object' ? safeGet(node, '_type') : null
    if (actualType !== expectedType) {
      addError(errors, field, 'compile_mismatch', `编译结果应为 ${expectedType}，实际 ${safeString(actualType) || 'null'}（该规则会在运行期被跳过）`)
      continue
    }
    if (multi) {
      const rules = safeGet(node, 'rules')
      const expectedCount = multilineCount.get(field) || 0
      if (!Array.isArray(rules) || rules.length !== expectedCount) {
        addError(errors, field, 'compile_mismatch', `多行规则编译出 ${Array.isArray(rules) ? rules.length : 0} 条，有效行数为 ${expectedCount}`)
      }
    }
  }
  if (errors.length) return { ok: false, errors }

  // ---------- 全命中提示：`.*` / `^.*$`（trim 后）----------
  const wideMatch = []
  for (const field of FILTER_RULE_FIELDS) {
    if (field === 'pingbitime' || !hasOwn(filter, field) || filter[field] === '') continue
    if (!filter[field].includes('###')) {
      if (WIDE_MATCH_VALUES.has(filter[field].trim())) wideMatch.push(field)
      continue
    }
    // 多行的某一行全命中同样意味着「该分类下放行一切」，一并提示。
    if (ruleLines.some(rule => rule.field === field && WIDE_MATCH_VALUES.has(rule.val))) wideMatch.push(field)
  }

  // ---------- 闸门 5：整份规则文件的字节预算（C9-012）----------
  // 读端按 FILTER_LIMITS.readMaxBytes 硬上限读覆盖文件，超限即 tooLarge ⇒ 视为损坏，降级到上次合法
  // 规则/代码默认。而闸门 1 只限**单字段**（FILTER_LIMITS.perField[field].chars）：11 个字段全填满中文
  // （UTF-8 3 字节/字）就能堆出 516 KB 以上——保存返回 200，规则却在下一轮整份被判超限丢弃（用户看到
  // 「保存成功但规则不生效」）。这里按**实际落盘形状** {schema, revision, filter} 量字节，留 32 字节给
  // revision 位数增长。
  //
  // **只对保存入参生效**（评审 C9-012）：读路径（deepValidationError）复用本函数时必须跳过此闸——
  // 已落盘文件是经 readSafeTextResult(FILTER_LIMITS.readMaxBytes) 有界读进来的，能读到就必然 ≤ 读端上限，
  // 再按「落盘形状重新序列化」量一遍字节，会把 (接受阈值, readMaxBytes] 这段**合法且可读**的存量
  // 覆盖文件判成 corrupt（落盘形状只比请求体多约 13 字节包装，手改/旧版可落到 readMaxBytes ⇒ 该区间是
  // 真实存量），于是每轮降级、规则静默不生效，也与 SYSTEM_CONTRACT「超限（> readMaxBytes）」口径相反。
  if (!(options && options.fromDisk === true)) {
    let serializedBytes
    try {
      serializedBytes = Buffer.byteLength(JSON.stringify({ schema: FILTER_RULES_SCHEMA, revision: 0, filter }), 'utf8')
    } catch (e) {
      return { ok: false, errors: [{ field: 'filter', code: 'serialize_failed', message: `规则无法序列化为 JSON：${safeErrorMessage(e)}` }] }
    }
    // 判定阈值与文案必须是**同一个数**：acceptMaxBytes = 整份预算 − revision 余量。文案里再给整份
    // 预算与读硬顶，用户按提示删到阈值以下就一定能保存（旧文案引用读硬顶，F3 两旋钮分道后会指错）。
    const acceptMaxBytes = FILTER_LIMITS.rulesFileMaxBytes - FILTER_LIMITS.saveHeadroomBytes
    if (serializedBytes > acceptMaxBytes) {
      return {
        ok: false,
        errors: [{
          field: 'filter',
          code: 'too_large',
          limit: acceptMaxBytes,
          actual: serializedBytes,
          message: `规则文件共 ${serializedBytes} 字节，超过本机保存预算 ${acceptMaxBytes} 字节（整份上限 ${FILTER_LIMITS.rulesFileMaxBytes} − revision 余量 ${FILTER_LIMITS.saveHeadroomBytes}；读硬顶 ${FILTER_LIMITS.readMaxBytes}），请删减规则后再保存`
        }]
      }
    }
  }

  return { ok: true, value: filter, wideMatch, deduped }
}

/**
 * 校验「覆盖字段对象」：白名单字段 + 必须是字符串 + 单字段长度 + 控制字符。
 * 覆盖文件与持久 LKG 共用同一套口径（LKG 也要按覆盖文件的严格度复验，否则损坏/被改写的
 * LKG 会把非法规则代入降级轮）。
 * @returns {{ok:true,filter:Object}|{ok:false,message:string}}
 */
function parseOverrideFields (rawFilter) {
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    return { ok: false, message: '必须是对象' }
  }
  let keys
  try { keys = Object.keys(rawFilter) } catch (e) { keys = null }
  if (keys === null) return { ok: false, message: '不是可枚举对象' }
  const filter = {}
  for (const field of keys) {
    if (!FIELD_SET.has(field)) return { ok: false, message: `含未知字段「${field}」` }
    const value = safeGet(rawFilter, field)
    if (typeof value !== 'string') return { ok: false, message: `字段「${field}」必须是字符串` }
    if (value.length > readFieldMaxLen(field)) return { ok: false, message: `字段「${field}」超长` }
    if (CONTROL_CHAR_RE.test(value)) return { ok: false, message: `字段「${field}」含控制字符` }
    filter[field] = value
  }
  return { ok: true, filter }
}

function parseStoredRules (text) {
  // 覆盖文件的**结构**校验（与用户输入的五道闸分开）：JSON / schema / revision / 字段白名单 /
  // 字符串 / 长度 / 控制字符。刻意不做正则编译与嵌套量词检查——那需要 RE2，且读路径必须
  // 在缺依赖时仍可用（否则一次缺 re2 就会把**合法**覆盖文件判成损坏并降级）。
  let data
  try { data = JSON.parse(text) } catch (e) {
    return { ok: false, message: '覆盖文件不是合法 JSON' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: '覆盖文件根节点必须是对象' }
  }
  if (data.schema !== FILTER_RULES_SCHEMA) {
    return { ok: false, message: `覆盖文件 schema 必须为 ${FILTER_RULES_SCHEMA}` }
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) {
    return { ok: false, message: '覆盖文件 revision 必须是非负整数' }
  }
  const fields = parseOverrideFields(data.filter)
  if (!fields.ok) return { ok: false, message: `覆盖文件 filter ${fields.message}` }
  return { ok: true, filter: fields.filter, revision: data.revision }
}

/**
 * 覆盖文件权限收紧：覆盖文件由外部工具/手工创建时可能带 group/other 位，
 * 读取时装作遵守 0600 会让「同机其他用户可写你的过滤规则」变成无声事实（A3）。
 * 有宽位就先收紧到 0600；收紧失败按损坏处理（不改用一份权限不可控的规则）。
 * 实现放在 scripts/owner-only-mode.js：Semgrep 对非字面量路径的 fs 调用一律报
 * path-traversal，单独成模块后可只排除该模块（不整文件排除本模块）。
 * 两个函数的 require 在**文件顶部**（加载期容量文件要用 isOwnerOnlyFile，见那里的注释）。
 */

/**
 * 读路径是否具备「深度校验」条件：需要注入完整 deps 且引擎可用。
 * 缺 RE2 时 compileUserRegex 恒返回 null，深校验会把**合法**文件全部判损坏；
 * 读路径的既有契约是「缺依赖也能读合法文件」，故引擎不可用直接跳过（A1）。
 */
function canDeepValidate (deps) {
  if (!deps || typeof deps !== 'object') return false
  const engine = deps.RuleEngine
  if (!engine || typeof engine.hasNestedQuantifier !== 'function' || typeof engine.compileRules !== 'function') return false
  if (typeof deps.compileUserRegex !== 'function') return false
  return engineAvailable(deps) === true
}

/**
 * 对「结构已合法」的覆盖文件再做一次五道闸校验（A1；整份字节预算闸只约束保存入参，这里按
 * options.fromDisk 跳过——已能读回的文件不得因「重新序列化后比阈值大 32 字节」被判损坏）。
 * 结构校验只证明形状合法：手工编辑写入的非法正则/嵌套量词会被运行期 compileRules 静默跳过，
 * 而 App.run 仍推进 filter.hash 并清 _f ⇒ 被过滤记录被补推且无任何损坏告警。
 * @returns {string|null} 失败描述（首条错误的 field+message），通过返回 null
 */
function deepValidationError (parsed, deps) {
  if (!canDeepValidate(deps)) return null
  const result = validateFilterRules({
    schema: FILTER_RULES_SCHEMA,
    revision: parsed.revision,
    filter: parsed.filter
  }, deps, { fromDisk: true })
  if (result && result.ok === true) return null
  const first = result && Array.isArray(result.errors) ? result.errors[0] : null
  const field = first ? safeString(safeGet(first, 'field')) : ''
  const detail = first ? safeString(safeGet(first, 'message')) : ''
  if (!field && !detail) return '覆盖文件规则深度校验失败'
  return `覆盖文件规则深度校验失败（${field || 'filter'}：${detail || '未知原因'}）`
}

// ============================================================
// F4-1：持久 LKG（filter-rules.lastgood.json）
//
// 为什么需要：进程内 `lastGoodByDir` 只能救「同一进程的下一轮」，而控制台 auto-run 每 5 秒
// spawn 一个**新进程**跑单轮（scripts/console.js）⇒ 新进程的 Map 恒为空，覆盖文件瞬时不可读时
// `corruptResult` 直接回退**代码默认规则**——规则被悄悄放宽（漏推/误推），控制台却仍显示
// 「沿用上次合法规则」。把最近一次成功加载的 override 落盘，新进程才能在降级轮沿用它。
//
// 与 filter-rules.applied.json 的分工（不能拿它当 LKG）：
//   · applied 每轮**无条件**覆盖，连降级轮也写，且内容是「默认 + 覆盖」的合并结果；
//   · lastgood 只在**成功加载 override** 时写，内容是覆盖文件里实际存在的字段原文（与
//     `override` 同形状），因此恢复出来的合并结果与上次合法轮逐字段相等。
//
// 安全口径：写入走 writeAtomic（0600 + 原子 rename）；读取走 readSafeTextResult（O_NONBLOCK +
// 普通文件 + 上限），且按覆盖文件同口径复验（白名单/schema/revision/字符串/长度/控制字符）并
// 校验内容哈希——任何一项不符都当「没有 LKG」，绝不放宽规则。
// ============================================================
function lastGoodHash (filter, revision) {
  // 规范化：只取白名单字符串字段（顺序固定），revision 归一到非负安全整数 ⇒ 同一份规则恒定同哈希。
  const canonical = JSON.stringify({
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    filter: overrideFieldsOf(filter)
  })
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

const lastGoodWarned = new Set()
function warnLastGoodWrite (filePath, detail) {
  // LKG 写失败不阻断本轮（规则照常生效），但持续失败会让下一个进程失去降级兜底 ⇒ 必须留痕。
  // 每个路径只告警一次，避免常驻控制台/循环模式按轮刷屏。
  if (lastGoodWarned.has(filePath)) return
  lastGoodWarned.add(filePath)
  console.warn(`⚠️ 过滤规则 LKG 写入失败（本轮规则照常生效，但下一个进程降级时只能回代码默认）：${filePath}：${detail}`)
}

function writeLastGoodFile (filePath, filter, revision) {
  if (typeof filePath !== 'string' || filePath === '') return false
  try {
    const override = overrideFieldsOf(filter)
    const revisionValue = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
    const hash = lastGoodHash(override, revisionValue)
    const payload = {
      schema: FILTER_RULES_SCHEMA,
      revision: revisionValue,
      hash,
      override
    }
    // F2-1：内容没变就不写盘。旧实现每轮（约 5 s）无条件原子重写一次：81 KB × 17,280 轮/天
    // ≈ 1.4 GB/天写放大，抬到 512 KiB 变 8.8 GB/天、1 MiB 变 18 GB/天。
    // 判据与 applied 同源：先按**内容**比（readLastGood 已复验 hash，故 hash 相等 ⇔ 内容相等），
    // 再确认目标仍是 0600——跳过写盘等于放弃「每轮自愈权限」，一份 0644 的 LKG（含用户全部规则
    // 正文，目录被拷贝/解包/手工 chmod 的常见结果）会永久留着，故权限不符一律落到写盘分支。
    // 文件不存在/损坏时 readLastGood 返回 null ⇒ 必然重写（自愈），不会把坏文件当成「已是最新」。
    const prev = readLastGood(filePath)
    if (prev && lastGoodHash(prev.filter, prev.revision) === hash && isOwnerOnlyFile(filePath)) return true
    const text = JSON.stringify(payload)
    // 写侧与读侧同口径（读上限 LASTGOOD_MAX_BYTES）：超出就**不写**并留痕，绝不落一个「写成功但
    // readLastGood 永远读不回」的文件。正常形状下这里恒不触发（覆盖文件能读回就 ≤ 上限，包装 +76）；
    // 它守的是「以后改包装/改上限时不会静默退化」——否则降级兜底会无声失效，writeLastGoodFile 还返回 true。
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > LASTGOOD_MAX_BYTES) {
      warnLastGoodWrite(filePath, `序列化后 ${bytes} 字节超过 LKG 读上限 ${LASTGOOD_MAX_BYTES} 字节（写出去也读不回，本轮不落盘）`)
      return false
    }
    const ok = writeAtomic(filePath, text, '过滤规则 LKG')
    if (!ok) warnLastGoodWrite(filePath, 'writeAtomic 返回 false')
    return ok
  } catch (e) {
    warnLastGoodWrite(filePath, safeErrorMessage(e))
    return false
  }
}

/**
 * 读持久 LKG。任何异常/不合格形态一律返回 null（= 没有 LKG），绝不抛错、绝不部分采用。
 * 读上限用 LASTGOOD_MAX_BYTES（FILTER_LIMITS.readMaxBytes + 包装预算）：拿读硬顶直接读会把
 * 「自身合法、只是多了包装」的 LKG 判成 tooLarge ⇒ 静默失效（F4-1 返工 R3）。
 * @returns {{filter:Object, revision:number}|null}
 */
function readLastGood (filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null
  try {
    const read = storage.readSafeTextResult(filePath, LASTGOOD_MAX_BYTES, { openNonBlocking: true })
    if (!read || read.status !== 'ok' || typeof read.text !== 'string') return null
    let data
    try { data = JSON.parse(read.text) } catch (e) { return null }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    if (data.schema !== FILTER_RULES_SCHEMA) return null
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) return null
    const fields = parseOverrideFields(data.override)
    if (!fields.ok) return null
    if (typeof data.hash !== 'string' || data.hash !== lastGoodHash(fields.filter, data.revision)) return null
    return { filter: fields.filter, revision: data.revision }
  } catch (e) {
    return null
  }
}

function removeLastGood (filePath) {
  if (typeof filePath !== 'string' || filePath === '') return
  try {
    fs.rmSync(filePath, { force: true })
  } catch (e) {
    // 删不掉只影响「删覆盖文件后旧规则是否会在降级轮复活」这一条兜底语义，不阻断本轮；
    // 但它是「删文件 = 恢复默认」承诺的破坏项，必须留痕。
    console.warn(`⚠️ 过滤规则 LKG 清理失败（删除覆盖文件后旧规则仍可能在降级轮被沿用）：${filePath}：${safeErrorMessage(e)}`)
  }
}

// ============================================================
// F4-3：瞬时读失败不得折叠成「规则文件损坏」
//
// `replaced`（读后复检发现 dev/ino 或类型变了）与 `ioError`（读瞬间的 EIO/EBUSY 等）都是**瞬时**
// 并发事实，不是「这份文件永久不可用」：控制台保存用原子 rename，另一进程在 rename 前后的一瞬
// 就能让读失败。旧实现一律按损坏降级 ⇒ 白丢一轮合法规则、控制台亮红条（还可被当成「已降级」）。
// 现在：这两类先退避 50ms 重读一次，仍失败才降级；`unsafe`（确定性非普通文件）与 `tooLarge`
// 不做重读、直接降级，且**不隔离**（本模块从不移动/改名任何文件）。
// ============================================================
const TRANSIENT_READ_RETRY_MS = 50

function sleepMs (ms) {
  // 本模块读路径全同步（loadFilterRules 在 App.run 开头同步调用），不能 await；Atomics.wait 是
  // Node 主线程可用的同步睡眠，不占 CPU（忙等会让 50ms 退避变成一次 CPU 尖峰）。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch (e) {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 极端环境（无 SharedArrayBuffer）下的忙等兜底 */ }
  }
}

function isTransientReadStatus (status) {
  return status === 'replaced' || status === 'ioError'
}

function readRulesFile (filePath) {
  return storage.readSafeTextResult(filePath, FILTER_LIMITS.readMaxBytes, { openNonBlocking: true })
}

function corruptResult (defaults, keyword, message, key, lastGoodFile) {
  // 损坏降级：优先本目录的 last-known-good（先进程内缓存，其次持久 LKG 文件——后者是「新进程」场景
  // 的唯一来源）；两者都没有才回代码默认。
  // 两种情形都标记 degraded:true + source:'corrupt'，由运行侧做三处告警并跳过 _f 清理/hash 推进。
  let lastGood = key === undefined ? null : lastGoodByDir.get(key)
  if (!lastGood) {
    const persisted = readLastGood(lastGoodFile)
    if (persisted) {
      // 读到的持久 LKG 与成功加载同样可信（同口径复验 + 哈希校验）：顺手回填进程内缓存，
      // 免得同一进程的后续轮次每轮重读。损坏读绝不会覆盖进程内已有的合法值（上面的 if 已挡住）。
      lastGood = persisted
      if (key !== undefined) lastGoodByDir.set(key, { filter: { ...persisted.filter }, revision: persisted.revision })
    }
  }
  if (lastGood) {
    const merged = mergeActiveFilter({ defaults, keyword, override: lastGood.filter })
    return {
      ...merged,
      // 文件本身不可用：读面不得拿 last-known-good 冒充「文件里有的字段」。
      override: {},
      source: 'corrupt',
      revision: lastGood.revision,
      degraded: true,
      lastGoodUsed: true,
      error: { code: 'store_corrupt', message }
    }
  }
  const merged = mergeActiveFilter({ defaults, keyword })
  return {
    ...merged,
    override: {},
    source: 'corrupt',
    revision: 0,
    degraded: true,
    lastGoodUsed: false,
    error: { code: 'store_corrupt', message }
  }
}

function loadFilterRulesImpl ({ cacheDir, defaults, keyword, deps, persistLastGood }) {
  const paths = filterRulesPaths(cacheDir)
  const key = path.dirname(paths.file)
  // 明确上限：覆盖文件是外部可编辑的输入，禁止无界整读（FILTER_LIMITS.readMaxBytes 与 console body 上限同源）。
  // 两条「不跟随符号链接」的闸门一前一后（C10-019）：读走 readSafeTextResult（O_NOFOLLOW + fstat
  // + 读后复检 inode，末级是链接直接判 unsafe），收紧走 enforceOwnerOnlyMode（O_NOFOLLOW 打开、
  // 对比 lstat 的 dev/ino、只在已校验的 fd 上 fchmod 并按同一 fd 复检）——任一处被换成链接都不会读到、
  // 更不会 chmod 到链接目标。
  // F4-2：openNonBlocking —— 裸 O_RDONLY 打开无写者的 FIFO 会同步阻塞（无日志、无退出码），
  // 控制台每 5 秒 spawn 的单轮进程会永久挂死；O_NONBLOCK 下 open FIFO 立刻 ENXIO ⇒ unsafe，
  // 随后的 fstat 普通文件校验同样拒绝一切非普通文件。下同（applied / LKG 读取）。
  let read = readRulesFile(paths.file)
  if (isTransientReadStatus(read.status)) {
    // F4-3：replaced / ioError 是瞬时并发事实（另一进程原子 rename 覆盖文件的那一瞬），
    // 退避 50ms 重读一次再判降级——否则会白丢一轮合法规则并误报损坏。
    sleepMs(TRANSIENT_READ_RETRY_MS)
    read = readRulesFile(paths.file)
  }
  if (read.status === 'missing') {
    // 文件被删除 = 用户恢复代码默认：本目录的 last-known-good 随之作废（进程内缓存 + 持久 LKG 一起清）。
    // 否则「删文件 → 之后又出现畸形文件」会把早已废弃的旧规则复活成生效规则（A4）。
    // R1-5：控制台读面（persistLastGood:false）连这一步也不做——删除同样是写盘，而「删文件=恢复默认」
    // 由运行侧下一轮加载负责；读面代删会让 GET /api/config/filter 变成写操作（SYSTEM_CONTRACT:56 零写盘）。
    lastGoodByDir.delete(key)
    if (persistLastGood !== false) removeLastGood(paths.lastgood)
    const merged = mergeActiveFilter({ defaults, keyword })
    return { ...merged, override: {}, source: 'default', revision: 0, degraded: false, lastGoodUsed: false }
  }
  if (read.status !== 'ok') {
    // unsafe（open ELOOP / fstat 非普通文件，确定性）与 tooLarge（确定性）不做重读、直接降级，
    // 且**不隔离**：本模块从不移动/改名任何文件（覆盖文件是用户资产，隔离它等于替用户做决定）；
    // replaced / ioError 已在上面重读过一次，到这里说明仍未恢复。
    return corruptResult(defaults, keyword, `覆盖文件不可读（${read.status}）`, key, paths.lastgood)
  }
  const modeCheck = enforceOwnerOnlyMode(paths.file)
  if (!modeCheck.ok) return corruptResult(defaults, keyword, modeCheck.message, key, paths.lastgood)
  const parsed = parseStoredRules(read.text)
  if (!parsed.ok) return corruptResult(defaults, keyword, parsed.message, key, paths.lastgood)
  const deepError = deepValidationError(parsed, deps)
  if (deepError) return corruptResult(defaults, keyword, deepError, key, paths.lastgood)

  // 只有通过（结构 + 可选深度）校验的文件才更新本目录的 last-known-good；损坏读绝不覆盖它。
  lastGoodByDir.set(key, { filter: { ...parsed.filter }, revision: parsed.revision })
  // F4-1：同步落盘一份持久 LKG——控制台 auto-run 每 5 秒 spawn 单轮进程，进程内 Map 对新进程等于不存在。
  // 写失败只告警（本轮规则照常生效，降级兜底质量下降），绝不抛穿本轮。
  // R1-5：控制台的 GET 读面（/api/config/filter、/draft）也走本函数，但它是**纯读**端点
  // （SYSTEM_CONTRACT:27/:56：控制台读取面零写盘）。若在这里无条件落盘，每拍 GET 都会新建/重写
  // filter-rules.lastgood.json，缓存目录对控制台只读时还会每次刷一条「LKG 写入失败」错误。
  // 故写入由调用方显式声明：persistLastGood=false 时一个字节都不写（含删除），运行侧保持默认 true。
  if (persistLastGood !== false) writeLastGoodFile(paths.lastgood, parsed.filter, parsed.revision)
  const merged = mergeActiveFilter({ defaults, keyword, override: parsed.filter })
  return {
    ...merged,
    // 与 filter 同源（同一份 parsed.filter）：读面两者必须描述同一次读盘的快照。
    override: overrideFieldsOf(parsed.filter),
    source: 'override',
    revision: parsed.revision,
    degraded: false,
    lastGoodUsed: false
  }
}

/**
 * 读取覆盖文件并返回本轮的生效规则（每轮 App.run 开头调用一次）。
 * 任何异常都不得抛穿；文件不存在 → source:'default'、revision:0、filter 为代码默认深拷贝。
 * @param {{cacheDir:string, defaults:Object, keyword:Object, persistLastGood?:boolean,
 *   deps?:{RuleEngine:Object, compileUserRegex:Function, re2Available?:boolean, isRe2Available?:Function}}} options
 *   persistLastGood=false（R1-5）：纯读模式——不写/不删 <缓存目录>/filter-rules.lastgood.json，
 *   供控制台读面（GET /api/config/filter、GET /api/config/filter/draft）使用；缺省 true（运行侧）。
 *   deps 可选：提供且引擎可用时，读路径在结构校验之后再跑 validateFilterRules 的五道闸（A1；
 *   其中「整份字节预算」闸不作用于读路径，`fromDisk` 跳过）；
 *   不提供时保持「只做结构校验」的既有契约（console/qinglong 等调用方无需改造）。
 * @returns {{filter:Object, override:Object, keyword:{zkt_gjc:string}, source:'override'|'default'|'corrupt',
 *   revision:number, degraded:boolean, lastGoodUsed:boolean, error?:{code:string,message:string}}}
 *   filter = 代码默认 + 覆盖的合并值；override = 覆盖文件里**实际存在**的字段（不补默认，
 *   无文件/损坏时为 {}），读面用它避免「整份替换保存」删掉未改动字段。
 */
function loadFilterRules (options) {
  const opts = options && typeof options === 'object' ? options : {}
  const key = cacheDirKey(opts.cacheDir)
  try {
    return loadFilterRulesImpl({
      cacheDir: opts.cacheDir,
      defaults: opts.defaults,
      keyword: opts.keyword,
      deps: opts.deps,
      persistLastGood: opts.persistLastGood
    })
  } catch (e) {
    // 兜底：读盘/解析/合并的任何未预期异常都收敛成降级结果（绝不杀整轮 run）。
    let lkgFile = ''
    try { lkgFile = filterRulesPaths(opts.cacheDir).lastgood } catch (e2) { lkgFile = '' }
    return corruptResult(opts.defaults, opts.keyword, `覆盖文件读取异常：${safeErrorMessage(e)}`, key, lkgFile)
  }
}

/**
 * 判断「磁盘上的旧快照」与「本轮要写的新快照」的规则内容是否完全一致（appliedAt 不参与）。
 *
 * v3.411：为什么需要它——旧实现每轮都生成新 appliedAt 并整份重写 applied.json（约 73 KB），
 * 而规则通常整月不变（实测 12 轮采样里 10 轮在重写，约 1 GB/天）。规则没变时这份写入是纯浪费。
 *
 * 比较必须是纯函数式：filter 只比 FILTER_RULE_FIELDS 白名单、逐字段比字符串，**不依赖对象键顺序**
 * （快照可能是手改/旧版本写出的，键序不可信）；缺字段按空串比（与 readAppliedSnapshot / parseStoredRules
 * 的「缺字段视同空」同口径）。
 * lastGoodUsed 也参与比较：它是控制台读的「本轮是否沿用了上次合法规则」，只把它当非内容字段跳过，
 * 会让降级→恢复翻转时快照继续宣称「沿用上次」。
 * @returns {boolean} true = 内容一致，可以跳过写盘
 */
function sameAppliedContent (prev, next) {
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return false
  if (!next || typeof next !== 'object') return false
  // schema 不必比：readAppliedSnapshot 只让 schema === FILTER_RULES_SCHEMA 的快照到达这里。
  if (prev.revision !== next.revision) return false
  if (prev.source !== next.source) return false
  if (prev.hash !== next.hash) return false
  if (prev.lastGoodUsed !== next.lastGoodUsed) return false
  for (const field of FILTER_RULE_FIELDS) {
    if (safeString(safeGet(prev.filter, field)) !== next.filter[field]) return false
  }
  return safeString(safeGet(prev.keyword, 'zkt_gjc')) === next.keyword.zkt_gjc
}

const appliedWarned = new Set()
function warnAppliedWrite (filePath, detail) {
  // 生效快照只用于诊断/「已生效」展示，写失败不阻断本轮（规则照常生效）；但「写了却读不回」
  // 会让控制台永远显示「尚未生效」，属于必须留痕的静默退化。每个路径只告警一次，避免常驻
  // 控制台/循环模式按轮刷屏。
  if (appliedWarned.has(filePath)) return
  appliedWarned.add(filePath)
  console.warn(`⚠️ 过滤规则生效快照写入失败（本轮规则照常生效，控制台可能一直显示「尚未生效」）：${filePath}：${detail}`)
}

/**
 * 写生效快照 <cacheDir>/filter-rules.applied.json（0600 由 writeAtomic 保证）。
 * 快照是诊断/验收用：证明「本轮实际生效的是哪一版规则」，不参与规则读取。
 *
 * v3.411：规则内容与磁盘上的旧快照完全一致时**不写盘**（保留旧 appliedAt）并返回 true。
 * 判据只看内容字段（revision/source/hash/filter/keyword + lastGoodUsed），见 sameAppliedContent；
 * 但跳过前还必须确认目标文件**本身仍是 0600**——旧实现每轮 writeAtomic 等于每轮把权限修回 0600，
 * 跳过之后一份 0644 快照（缓存目录被整体拷贝/解包、备份恢复、手工 chmod）会永久留着，而快照里
 * 有用户全部过滤规则正文。权限不符或 stat 失败一律落到写盘分支自愈（见 isOwnerOnlyFile）。
 * 每轮都读一次旧快照：进程可能多开（控制台 spawn + 常驻运行），进程内缓存会互相看不见，禁止用它绕过读盘。
 * @returns {boolean} 写入是否成功（失败只返回 false，不抛错）
 */
function writeAppliedSnapshot ({ cacheDir, filter, keyword, revision, source, hash, lastGoodUsed } = {}) {
  const paths = filterRulesPaths(cacheDir)
  const snapshotFilter = {}
  for (const field of FILTER_RULE_FIELDS) snapshotFilter[field] = safeString(safeGet(filter, field))
  const snapshot = {
    schema: FILTER_RULES_SCHEMA,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    source: source === 'override' || source === 'corrupt' ? source : 'default',
    hash: safeString(hash),
    appliedAt: new Date().toISOString(),
    // F4-1：本轮是否沿用了持久 LKG。这是控制台 GET 的唯一口径来源——控制台进程自己的
    // lastGood 与运行侧无关，不得用它冒充「运行侧这轮用了什么」。
    lastGoodUsed: lastGoodUsed === true,
    filter: snapshotFilter,
    keyword: normalizeKeyword(keyword, { forSnapshot: true })
  }
  // 只有 status==='ok'（文件存在、合法 JSON、schema/revision/filter/keyword 全过校验）才可能判定「内容一致」；
  // missing / invalid / ioError 一律照常重写——损坏的快照要自愈，不能因为「比不出来」就留着。
  // 权限也参与判据：内容一致但目标不是 0600 时不得跳过（理由见函数头注释），直接落到 writeAtomic 重写。
  const prev = readAppliedSnapshot(cacheDir)
  if (prev.status === 'ok' && sameAppliedContent(prev.snapshot, snapshot) && isOwnerOnlyFile(paths.applied)) {
    return true
  }
  const text = JSON.stringify(snapshot)
  // 写侧与读侧同口径（读上限 APPLIED_MAX_BYTES）：超出就**不写**并留痕，绝不落一个自己读不回的快照。
  // 正常形状下这里不触发（快照只比覆盖文件多约 179 字节包装，而预算是 1024）；它守的是「以后改字段/
  // 改上限时不会静默退化」——否则 readAppliedSnapshot 恒 ioError、控制台永远显示「尚未生效」，而本函数
  // 还返回 true（与 LKG 的 R3 同类：写成功但读不回）。
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > APPLIED_MAX_BYTES) {
    warnAppliedWrite(paths.applied, `序列化后 ${bytes} 字节超过生效快照读上限 ${APPLIED_MAX_BYTES} 字节（写出去也读不回，本轮不落盘）`)
    return false
  }
  return writeAtomic(paths.applied, text, '过滤规则生效快照')
}

/**
 * 运行侧口径的 lastGoodUsed：只认**本轮生效快照**（applied.json）。
 * 控制台进程读文件时自己也会产出 LKG（同一份 filter-rules.lastgood.json），但那是「下一次降级
 * 可以用什么」，与「上一轮运行实际用了什么」是两件事——GET 不得拿它冒充运行侧状态。
 * 判据与运行侧写入口径一致：只有 source==='corrupt' 且 lastGoodUsed===true 才算「本轮沿用了 LKG」。
 * @returns {boolean}
 */
function appliedLastGoodUsed (snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  return snapshot.source === 'corrupt' && snapshot.lastGoodUsed === true
}

/**
 * 读回生效快照。状态机：missing / invalid / ioError / ok（不抛错）。
 * 读上限用 APPLIED_MAX_BYTES（FILTER_LIMITS.readMaxBytes + 包装预算）：快照是覆盖文件的超集（11 字段补齐 +
 * source/hash/appliedAt/lastGoodUsed + keyword 包装，实测 +179 字节）。直接拿读硬顶
 * 读会把「自身合法、只是多了包装」的快照判成 tooLarge ⇒ 恒 ioError ⇒「内容一致跳过写盘」永不生效、
 * 控制台永远显示「尚未生效」（F4-1 R3 / LKG 同型缺陷）。写侧用同一常量预检。
 * @returns {{status:'ok',snapshot:Object}|{status:'missing'}|{status:'invalid',error:Object}|{status:'ioError',error:Object}}
 */
function readAppliedSnapshot (cacheDir) {
  let read
  try {
    read = storage.readSafeTextResult(filterRulesPaths(cacheDir).applied, APPLIED_MAX_BYTES, { openNonBlocking: true })
  } catch (e) {
    return { status: 'ioError', error: { code: 'read_failed', message: safeErrorMessage(e) } }
  }
  if (read.status === 'missing') return { status: 'missing' }
  if (read.status !== 'ok') {
    return { status: 'ioError', error: { code: read.status, message: `生效快照不可读（${read.status}）` } }
  }
  let snapshot
  try { snapshot = JSON.parse(read.text) } catch (e) {
    return { status: 'invalid', error: { code: 'invalid_json', message: '生效快照不是合法 JSON' } }
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照根节点必须是对象' } }
  }
  if (snapshot.schema !== FILTER_RULES_SCHEMA) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: `生效快照 schema 必须为 ${FILTER_RULES_SCHEMA}` } }
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 revision 必须是非负整数' } }
  }
  if (typeof snapshot.appliedAt !== 'string' || snapshot.appliedAt === '') {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照缺少 appliedAt' } }
  }
  // lastGoodUsed 是 v3.406 起写入的字段：旧快照缺省按 false 读（向后兼容），出现则必须是布尔。
  if (snapshot.lastGoodUsed !== undefined && typeof snapshot.lastGoodUsed !== 'boolean') {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 lastGoodUsed 必须是布尔值' } }
  }
  if (!snapshot.filter || typeof snapshot.filter !== 'object' || Array.isArray(snapshot.filter)) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 filter 必须是对象' } }
  }
  // C9-019：只校验「filter 是对象」时，字段被写成对象/数字/数组也照读 ok，而覆盖文件的读路径
  // （parseStoredRules）对同一批字段要求「白名单内 + 必须是字符串」——两条读路径口径不一致，
  // 快照一旦被写坏，控制台就会把非字符串当成规则正文显示/回填。这里按 parseStoredRules 同口径
  // 收紧：存在即必须是白名单字段且为字符串（未提供的字段与读覆盖文件一样视同空，不强制补齐）。
  let snapshotKeys
  try { snapshotKeys = Object.keys(snapshot.filter) } catch (e) { snapshotKeys = null }
  if (snapshotKeys === null) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 filter 不是可枚举对象' } }
  }
  for (const field of snapshotKeys) {
    if (!FIELD_SET.has(field)) {
      return { status: 'invalid', error: { code: 'invalid_schema', message: `生效快照含未知字段「${field}」` } }
    }
    if (typeof safeGet(snapshot.filter, field) !== 'string') {
      return { status: 'invalid', error: { code: 'invalid_schema', message: `生效快照字段「${field}」必须是字符串` } }
    }
  }
  if (!snapshot.keyword || typeof snapshot.keyword !== 'object' || Array.isArray(snapshot.keyword)) {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 keyword 必须是对象' } }
  }
  // keyword 写入侧恒为 {zkt_gjc: 字符串}；出现非字符串说明快照被改坏（控制台会照原样显示）。
  const snapshotKeyword = safeGet(snapshot.keyword, 'zkt_gjc')
  if (snapshotKeyword !== undefined && typeof snapshotKeyword !== 'string') {
    return { status: 'invalid', error: { code: 'invalid_schema', message: '生效快照 keyword.zkt_gjc 必须是字符串' } }
  }
  return { status: 'ok', snapshot }
}

// 仅测试：清空进程内 last-known-good（全部 cacheDir 槽位）**并删除对应的持久 LKG**。
// 生产代码不得调用（每轮 run 由真实读盘决定）。为什么连持久 LKG 一起删：`lastGoodByDir` 的键
// 就是各目录，测试用本函数模拟「全新进程」；F4-1 之后全新进程仍能从 lastgood.json 恢复，
// 不删文件会让「清空即无 LKG」的既有用例（以及后续用例的隔离前提）失真。
function resetStoreStateForTests () {
  for (const dir of lastGoodByDir.keys()) {
    const lkgFile = filterRulesPaths(dir).lastgood
    try {
      fs.rmSync(lkgFile, { force: true })
    } catch (e) {
      console.warn(`⚠️ 测试清空 LKG 失败（可能影响后续用例隔离）：${lkgFile}：${safeErrorMessage(e)}`)
    }
  }
  lastGoodByDir.clear()
}

module.exports = {
  FILTER_RULE_FIELDS,
  FILTER_RULES_SCHEMA,
  // 预算单一来源（F1 收口 / F3 动态化）：读硬顶 / 写预算 / 各字段上限的唯一取值入口。
  // 全字段都是正整数安全整数（加载期 normalizeFilterLimits 已 fail-closed 校验），
  // 任何代码都不得把 NaN/0 传给 readSafeTextResult（= 无界读）。
  FILTER_LIMITS,
  // F3：预算的纯函数与加载期解析（探测一次 → 与容量文件对齐 → 写回），以及加载期 fail-closed 校验。
  // computeFilterCapacity 无 IO/时钟/随机，导出是为了让测试直接注入「资源探测结果」而不依赖本机。
  computeFilterCapacity,
  resolveFilterLimits,
  normalizeFilterLimits,
  computeDerivedReadLimits,
  readCapacityFile,
  FILTER_CAPACITY_FILE,
  FILTER_SOFT_CAP_ENV,
  FILTER_CACHE_DIR_ENV,
  FILTER_MAIN_FIELDS,
  FILTER_MIN_TOTAL_BYTES,
  // 今日常量（F1 的数字）：读端单字段下限、探测失败时的回落值。测试要按它断「回落成 16,000」。
  FILTER_FIELD_MAX_LEN,
  FILTER_MAX_TOTAL_BYTES,
  FILTER_DEFAULT_SOFT_CAP_BYTES,
  FILTER_RESERVE_BYTES,
  // 保存路径的单字段上限（未知字段 0）与读路径的单字段上限（max(今日常量, 字段值)）
  fieldMaxLenOf,
  readFieldMaxLen,
  // LKG 包装层的读上限（仅测试用：断言「写出的 LKG 必须 ≤ 读上限」这条不变式）
  LASTGOOD_MAX_BYTES,
  // F2-2 / F2-3：/preview 的扫描预算与条目数上限（console 的 /preview 与 GET limits 都从这里取）
  FILTER_PREVIEW_BUDGET_MS,
  FILTER_PREVIEW_BUDGET_RECORDS,
  scanPreviewRecords,
  countUnescapedAlternations,
  filterLimitsReport,
  // 生效快照的读上限（仅测试用：断言「写出的 applied 必须 ≤ 读上限」以及贴上限的覆盖文件仍读得回）
  APPLIED_MAX_BYTES,
  filterRulesPaths,
  validateFilterRules,
  mergeActiveFilter,
  loadFilterRules,
  // 仅供测试直调（生产代码只经 loadFilterRules / corruptResult 使用）：验证「写侧不得产出读不回的文件」
  writeLastGoodFile,
  readLastGood,
  writeAppliedSnapshot,
  appliedLastGoodUsed,
  readAppliedSnapshot,
  resetStoreStateForTests
}
