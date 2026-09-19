'use strict'
// 读取并解析 stryker mutation.json（支持超大文件）：
// command runner 会把整段测试输出写进每个变异体的 statusReason——单个文件可达 500MB+，
// 超过 V8 字符串上限（0x1fffffe8 ≈ 536MB）后 JSON.parse 直接抛错（日报该段显示 ❌）。
// statusReason 日报用不到，解析前按字节剥离：Buffer 无字符串长度限制。
// 注意：整文件读入 + Buffer.concat 会短暂翻倍内存（600MB 级报告峰值约 1.2GB，CI 7GB 内存下安全）。
// F-04（落盘侧）：只做读侧剥离意味着每份落盘报告/上传 artifact/增量缓存永久带着这份废重
// （实测占报告 99.89%）——writeStrippedReport 补上「剥离后写回磁盘」这一半，读写两侧共用同一份
// 剥离实现（stripStatusReason）与同一份读取护栏（readGuardedBytes）。
const fs = require('node:fs')
const path = require('node:path')
const { constants: bufferConstants } = require('node:buffer')

const KEY = Buffer.from('"statusReason"')
const PLACEHOLDER = Buffer.from(':""')
const MAX_STRING_LENGTH = 512 * 1024 * 1024 - 24 // V8 单字符串最大字符数（0x1fffffe8 ≈ 512MiB；表达式写法规避 Codacy PMD InnaccurateNumericLiteral 误报）
// F1（返工）：读取前的**策略**上限。上一版默认取 buffer.constants.MAX_LENGTH（≈8 PiB）——那不是策略，
// 只是把 readFileSync 自己的 ERR_OUT_OF_RANGE 换了个带路径/尺寸的文案，而两个生产调用方
// （scripts/mutation-report.js / .github/analyze-artifacts.js）都不注入 options，于是
// `stat.size > maxFileBytes` 这条分支在生产中恒假（独立验证 V3 打回）。现在：
//   * 默认 2 GiB：本文件头部声明的真实报告可达 500MB+（整段测试输出写进 statusReason），2 GiB 留足
//     余量；同时对病态输入（未剥离的百 GB 级文件）在**付出整份分配之前**失败，而不是把 CI runner 读 OOM；
//   * XBK_MUTATION_REPORT_MAX_BYTES 可覆盖（正整数；`off` = 只保留 Buffer 能表示的边界）；
//   * 非法/非正值回落默认——绝不静默变成「无上限」（readReportJson 的 maxFileBytes 形参仍供测试注入小夹具）。
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_BUFFER_BYTES = bufferConstants.MAX_LENGTH
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d])

// F1（返工）：策略上限解析是纯函数（不读环境变量 → 测试 hermetic）；调用点显式把环境变量传进来。
function resolveMaxReportBytes (raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_FILE_BYTES
  const text = String(raw).trim().toLowerCase()
  if (text === 'off') return MAX_BUFFER_BYTES // 显式关闭策略上限：退回 Buffer 能表示的边界
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_FILE_BYTES // 配置笔误不得把上限变成无穷
  return Math.min(n, MAX_BUFFER_BYTES)
}

// 从 i 起跳过空白，返回首个非空白位置
function skipWhitespace (buf, i) {
  while (i < buf.length && WHITESPACE.has(buf[i])) i++
  return i
}

// 若 buf[i] 是字符串起始引号，返回字符串结束后的位置；否则返回 -1
// （逐字节跳过 \" 转义，避免把值内的引号误判为结束）
function stringEnd (buf, i) {
  if (buf[i] !== 0x22 /* " */) return -1
  let j = i + 1
  while (j < buf.length) {
    const c = buf[j]
    if (c === 0x5c /* \\ */) { j += 2; continue }
    if (c === 0x22 /* " */) return j + 1
    j++
  }
  return -1
}

// 定位 idx 处 statusReason 字段的字符串值：返回值结束位置；非该字段/值非字符串时返回 -1
// （indexOf 命中的未必是字段名：某字符串值的引号+内容也可能构成同一字节序列——
//   如 {"replacement":"statusReason"} 命中于值位置；故须再校验紧随 KEY 的冒号
//   才能确认是字段，冒号检查才是剥离正确性的依据，而非引号位置）
function statusReasonValueEnd (buf, idx) {
  const afterKey = skipWhitespace(buf, idx + KEY.length)
  if (buf[afterKey] !== 0x3a /* : */) return -1
  return stringEnd(buf, skipWhitespace(buf, afterKey + 1))
}

// 追加 [pos, idx) 原文 + KEY + 空串占位（单次变参 push，S7778）
function appendWithPlaceholder (chunks, buf, pos, idx) {
  chunks.push(buf.subarray(pos, idx), KEY, PLACEHOLDER)
}

// 全 buffer 扫描：任意嵌套层级的字符串型 statusReason 一律改写为空串，返回替换后的字节块与剥离后总长。
// 返回**块**而不是 Buffer 是刻意的：调用方必须在 Buffer.concat（一次整份分配）**之前**用 strippedLength
// 判 V8 上限（本文件 F1 修复），先比后分配的顺序不能被封装掉——读/写两条路径共用同一份实现与同一顺序。
// 剥离是无条件的；返回值不携带「已改写」标记，调用方无法区分「被改写为空串」与「本来就是空串」。
function stripStatusReason (buf) {
  const chunks = []
  let pos = 0
  // F1：边扫边累计剥离后的字节数。原先只在 Buffer.concat **之后**才比 MAX_STRING_LENGTH，
  // 那时整份报告已被复制一遍（分配峰值）；累计长度让上限判定落在 concat 之前，
  // 超限输入在读完之后、分配峰值之前就带路径快速失败。
  let strippedLength = buf.length
  let idx = buf.indexOf(KEY, pos)
  while (idx !== -1) {
    const valueEnd = statusReasonValueEnd(buf, idx)
    if (valueEnd === -1) {
      // 非字段命中一律原文保留：值非字符串（null/数字/对象/数组），或命中恰是内容为
      // statusReason 的字符串值本身（相似键名 statusReason2 不含带引号的 KEY，不会命中）
      chunks.push(buf.subarray(pos, idx + KEY.length))
      pos = idx + KEY.length
    } else {
      // 丢弃 [idx+KEY.length, valueEnd) 共 (valueEnd-idx)-KEY.length 字节，改写为 2 字节占位
      strippedLength -= (valueEnd - idx) - KEY.length - PLACEHOLDER.length
      appendWithPlaceholder(chunks, buf, pos, idx)
      pos = valueEnd
    }
    idx = buf.indexOf(KEY, pos)
  }
  chunks.push(buf.subarray(pos))
  return { chunks, strippedLength }
}

// 读取前的护栏 + 整文件读入。readReportJson 与 writeStrippedReport **共用这一份实现**：写侧不得绕过
// 「非普通文件拒绝」与「预读上限」中的任何一条防线（两条都在这里，写侧无法绕过）。
//
// TOCTOU（CodeQL js/file-system-race）：早先的实现是「statSync(abs) 判类型/大小 → readFileSync(abs)
// 按同一路径二次查找」。检查与使用之间文件可被替换（换 inode、换类型、或替换成更大/更小的文件），
// 于是「检查看到的」与「实际读到的」可以不是同一个文件。改为**一次 openSync + 只对 fd 判定与读取**：
// 路径到对象的绑定只发生一次，类型/大小判定与整份读取作用于同一个 inode，不存在「检查后被换」的窗口。
// O_NONBLOCK：FIFO 单独以 O_RDONLY 打开会阻塞到出现写端（旧实现用 statSync 先拒绝，不会阻塞）；
// 加 O_NONBLOCK 让 open 立即返回，随后 fstat 判为非常规文件而拒绝。对常规文件无副作用。
function readGuardedBytes (abs, maxFileBytes) {
  const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
  let fd
  try {
    fd = fs.openSync(abs, openFlags)
  } catch (err) {
    // open 阶段失败（ENOENT/EACCES/ENOTDIR 等）原生异常消息不含被读路径，这里补上上下文
    throw new Error(`无法读取 ${abs}：${err.message}`)
  }
  let buf
  let stat
  try {
    try {
      stat = fs.fstatSync(fd)
    } catch (err) {
      throw new Error(`无法读取 ${abs}：${err.message}`)
    }
    if (!stat.isFile()) {
      throw new Error(`无法读取 ${abs}：不是普通文件（目录/FIFO/socket 一律拒绝整文件读入）`)
    }
    if (stat.size > maxFileBytes) {
      // 上限语义与带路径/尺寸的报错口径保持不变（上限仍是策略值 maxFileBytes，尺寸取自同一个 fd）
      throw new Error(`报告文件 ${abs} 为 ${stat.size} 字节，超过预读上限 ${maxFileBytes} 字节：拒绝整文件读入`)
    }
    try {
      // 按 fd 读（不再按路径二次查找）：读到的就是上面 fstat 判定的那个对象，Buffer 读取绕开字符串长度上限
      buf = fs.readFileSync(fd)
    } catch (err) {
      // 读取阶段失败（EACCES/EBADF 等）原生异常消息不含被读路径，这里补上上下文
      throw new Error(`无法读取 ${abs}：${err.message}`)
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch (err) {
      // 关闭失败不得覆盖主流程的错误/结果；仅 fd 泄漏一种后果，且进程随后退出。
    }
  }
  return { buf, stat }
}

function readReportJson (reportPath, options = {}) {
  // F1：V8 字符串上限可被调用侧覆盖（默认 MAX_STRING_LENGTH）。生产调用方一律不传，
  // 该形参只为测试构造「剥离后仍超限」的输入——否则验证这条护栏需要一个 512MiB 级夹具。
  const maxStringLength = Number.isFinite(options && options.maxStringLength) ? options.maxStringLength : MAX_STRING_LENGTH
  // F1（返工）：预读大小上限默认取**生产策略值**（2 GiB，见 DEFAULT_MAX_FILE_BYTES）；生产调用方
  // 经 XBK_MUTATION_REPORT_MAX_BYTES 注入，测试注入小夹具值。
  const maxFileBytes = Number.isFinite(options && options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES
  // nosemgrep: 工具脚本按 CLI 传入路径读取报告，路径非用户净输入
  // Trust Model（v3.266 强化）：readReportJson 是内部 API，期望 reportPath
  //   来自已校验目录——scripts/mutation-report.js 链中 fs.statSync(dir)
  //   + isDirectory() 是前置条件；.github/analyze-artifacts.js 只对 reportsRoot
  //   做 existsSync 存在性检查（未校验 isDirectory），其报告路径来自该目录的
  //   readdir 枚举（CI 仓库内目录，本地夹具可经 argv 覆盖），非不可信输入。
  //   公开 export 仅为测试复用与工具内嵌，不是给不可信输入使用。Codacy CRITICAL
  //   标"动态构造路径"在以上内部调用链上不成立（旧注释称"三个调用方 dir 入口
  //   已先校验"对 analyze-artifacts.js 并不成立，此处据实修正口径）。
  // Codacy MEDIUM：path.resolve() 防御性 normalize（公开 API，不假设上游已校验）
  const abs = path.resolve(reportPath)
  // F1：读取前的护栏（拿到真实大小与文件类型后才决定是否整文件读入）与整文件读入都在
  // readGuardedBytes 里——写侧（writeStrippedReport）共用同一份实现，两条防线不会在读/写之间漂移。
  const { buf } = readGuardedBytes(abs, maxFileBytes)
  const { chunks, strippedLength } = stripStatusReason(buf)
  // 剥离后仍超上限：快速失败并给出可行动报错（V8 原生异常不含文件上下文）
  if (strippedLength > maxStringLength) {
    throw new Error(`JSON 剥离 statusReason 后仍为 ${strippedLength} 字节，超过 V8 字符串上限 ${maxStringLength}：${abs}`)
  }
  const stripped = Buffer.concat(chunks)
  try {
    return JSON.parse(stripped.toString('utf8'))
  } catch (err) {
    // 带上文件路径与剥离前后尺寸，便于定位（报告文件损坏时原始异常不含上下文）
    throw new Error(`解析 ${abs} 失败（原始 ${buf.length} 字节，剥离后 ${stripped.length} 字节）：${err.message}`)
  }
}

/**
 * 就地剥离落盘报告里的 statusReason（artifact / actions/cache 瘦身）。
 *
 * 背景（REV-CI F-04 落盘侧）：stryker 的 command runner 把每个变异体的**整段测试输出**写进 statusReason，
 * 实测占 mutation-report.json 的 99.89%（103,101,102 → 116,206 字节）；而全仓两个消费方
 * （scripts/mutation-report.js 的聚合与闸门）都经 readReportJson **只在内存里**剥掉它、从不写回，
 * 于是每份落盘报告/上传 artifact/增量缓存都白背这份废重。本函数补上「剥离后落盘」这一半。
 *
 * 语义保证（不得改变任何消费方读到的内容）：剥离只把字符串型 statusReason 改写为空串，其余字节逐字不变，
 * 而 readReportJson 对内存里的报告**本来就把同一字段置为空串** ⇒ 剥离前后「消费方读到的报告对象」逐字段相同
 * （等价性由 test_mutation_report.js 的深度相等断言锁死）。
 *
 * 失败路径刻意 fail-closed：
 *   * 非普通文件（符号链接/目录/FIFO/socket）一律拒写——写回是「同目录临时文件 + rename」，若目标是
 *     符号链接，rename 会把链接本身换成普通文件、真实报告不被改写（静默写错对象）；
 *   * 复用 readGuardedBytes：预读上限（默认 2 GiB / XBK_MUTATION_REPORT_MAX_BYTES）与非普通文件拒绝
 *     与本文件读侧逐字一致，写侧无法绕过；
 *   * 落盘前先把剥离结果 JSON.parse 一遍（剥离后通常只剩几百 KB，代价可忽略），解析不过就**绝不写盘**；
 *     这条校验对「有变化」与「无变化」两条路径**一视同仁**：无变化只说明没有可剥离的字节，不代表文件
 *     本身是合法 JSON（见 writeStrippedReport 内联注释）；
 *   * 同目录临时文件 → fsync → renameSync 原子替换：中途失败清理临时文件并抛出，绝不留下半份报告
 *     （报告是 validateSegments / validateFreshness 的门禁输入，静默写出半份比直接失败危险得多）。
 *
 * @param {string} reportPath 待剥离的报告路径
 * @param {{maxStringLength?: number, maxFileBytes?: number}} [options] 仅供测试注入的护栏上限
 * @returns {{path: string, before: number, after: number, saved: number, changed: boolean}}
 * @throws {Error} 非普通文件 / 超过预读上限 / 输入本身不是合法 JSON（无可剥离内容）/ 剥离后 JSON 非法 / 写回或校验失败时抛出
 */
function writeStrippedReport (reportPath, options = {}) {
  const maxStringLength = Number.isFinite(options && options.maxStringLength) ? options.maxStringLength : MAX_STRING_LENGTH
  const maxFileBytes = Number.isFinite(options && options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES
  const abs = path.resolve(reportPath)
  // 符号链接防御：先 lstat（不跟随）确认目标是常规文件本身。写回走 rename，跟随符号链接的写法会把链接
  // 换成普通文件而真实目标不变——这里明确拒绝，fail-closed（与「不是普通文件一律拒绝」同一口径）。
  let lst
  try {
    lst = fs.lstatSync(abs)
  } catch (err) {
    throw new Error(`无法写入 ${abs}：${err.message}`)
  }
  if (!lst.isFile()) {
    throw new Error(`无法写入 ${abs}：不是普通文件（符号链接/目录/FIFO/socket 一律拒写）`)
  }
  const { buf, stat } = readGuardedBytes(abs, maxFileBytes)
  const { chunks, strippedLength } = stripStatusReason(buf)
  if (strippedLength > maxStringLength) {
    throw new Error(`JSON 剥离 statusReason 后仍为 ${strippedLength} 字节，超过 V8 字符串上限 ${maxStringLength}：${abs}`)
  }
  // 占位符与原文逐字节等长（`"statusReason":""` 本就 17 字节），故 strippedLength === buf.length
  // 当且仅当剥离结果与原文逐字相同（替换只会等长或变短）⇒ 无变化时不落盘、不动 mtime
  // （mtime 是新鲜度闸门的判据）。
  const changed = strippedLength !== buf.length
  // 无变化时不再 Buffer.concat：剥离结果与原文逐字节相同，直接校验输入 buf 本身即可（省掉一次整份分配）。
  // 性能：走无变化分支的输入本就「没有可剥离的 statusReason」，而 stryker 报告里 statusReason 实测占
  // 99.89% 字节 ⇒ 这类文件很小，多出的这次 JSON.parse 代价可忽略——这里省的不是校验，只是一次 concat。
  const stripped = changed ? Buffer.concat(chunks) : buf
  // fail-closed：解析不过就不落盘——绝不把半份/损坏的报告写进磁盘。
  // 无变化路径**同样必须校验**：`strippedLength === buf.length` 只说明「没有可剥离的字节」，并不说明
  // 文件本身是合法 JSON。损坏/截断的报告（如内容只有 `{`）里没有非空字符串 statusReason，于是
  // strippedLength === buf.length —— 旧实现据此直接 return changed:false，CLI 打印「无 statusReason 可剥」
  // 并 exit 0，把「文件已损坏」当成「无须改写」的成功。报告是 validateSegments / validateFreshness 的
  // 门禁输入，静默放行一个不可解析的输入比直接失败危险得多，故两条路径同一口径：解析不过就抛出。
  try {
    JSON.parse(stripped.toString('utf8'))
  } catch (err) {
    // 两条路径文案分开：无变化时并没有「剥离后」的东西，沿用同一句会误导排障方向
    throw new Error(changed
      ? `剥离 ${abs} 后 JSON 非法，拒绝落盘（原始 ${buf.length} 字节，剥离后 ${stripped.length} 字节）：${err.message}`
      : `报告 ${abs} 不是合法 JSON（无可剥离内容，原始 ${buf.length} 字节）：拒绝按「无需改写」放行、不落盘：${err.message}`)
  }
  if (!changed) {
    return { path: abs, before: buf.length, after: buf.length, saved: 0, changed: false }
  }
  // 原子替换：同目录（同一文件系统，rename 才是原子的）+ 隐藏随机名，避免与报告发现逻辑/并发调用撞名
  const tmpPath = path.join(path.dirname(abs), `.${path.basename(abs)}.strip-${process.pid}-${Date.now().toString(36)}.tmp`)
  try {
    const fd = fs.openSync(tmpPath, 'wx', stat.mode & 0o7777)
    try {
      fs.writeFileSync(fd, stripped)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // open 的 mode 会被 umask 掩掉，显式 chmod 回原权限位（artifact 里是 0644）
    fs.chmodSync(tmpPath, stat.mode & 0o7777)
    fs.renameSync(tmpPath, abs)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch (cleanupErr) {
      // 临时文件清理失败不得覆盖主错误；残留物是隐藏 .tmp，且本次调用已抛出（响亮）
    }
    throw new Error(`剥离 ${abs} 写回失败（原文件未被改动）：${err.message}`)
  }
  // 落盘后按尺寸复核，读回不一致即响亮失败（不静默接受可疑结果）
  const after = fs.statSync(abs).size
  if (after !== stripped.length) {
    throw new Error(`剥离 ${abs} 落盘尺寸不一致：期望 ${stripped.length}，实际 ${after}`)
  }
  return { path: abs, before: buf.length, after, saved: buf.length - after, changed: true }
}

module.exports = { readReportJson, writeStrippedReport, resolveMaxReportBytes, DEFAULT_MAX_FILE_BYTES, MAX_BUFFER_BYTES }
