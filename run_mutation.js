'use strict'

// 自动变异测试调度器：生成变异点 → 批量并行执行 → 失败批次递归二分 → 单点复验。
// 默认只修改临时副本，不触碰当前工作区。
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const ROOT = __dirname
const DEFAULT_FILES = [
  'xbk_function_v3.js', 'xbk_agents.js', 'xbk_http.js',
  'xbk_sendNotify_slim.js', 'xbk_storage.js', 'xbk_loop.js',
  'xbk_failure_policy.js',
  'qinglong/xbk_push.js'
]
// 变异测试使用全量单元测试入口（覆盖全部未标记 integration/mutationSkip 的单元测试套件），而非仅 test_filter.js——
// 此前只跑 test_filter.js 导致 #100/#101 新增的 1400+ 行测试对变异分数完全无效。
const DEFAULT_TEST = ['node', 'run_unit_tests.js']
// 运算符变异：同一位置可能给出多个替换候选（如 '<' → '<=' / '>'）。
const OPS = new Map([
  ['===', ['!==']], ['!==', ['===']], ['==', ['!=']], ['!=', ['==']],
  ['&&', ['||']], ['||', ['&&']],
  ['<=', ['<', '>']], ['>=', ['>', '<']], ['<', ['<=', '>']], ['>', ['>=', '<']]
])
// 布尔字面量必须按完整标识符匹配（review F10）：此前 'true'/'false' 混在 OPS 里由 startsWith 匹配，
// 于是 trueCount / falsePositive 这类标识符被改名（falseCount → ReferenceError → 测试红 → 记 killed
// 虚增分数），且标识符分支的 kind:'boolean' 永远不可达。移出 OPS 后只走下面的整词分支。
const BOOL_OPS = new Map([['true', ['false']], ['false', ['true']]])

function lineColumn (source, offset) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const last = before.lastIndexOf('\n')
  return { line, column: offset - (last < 0 ? 0 : last + 1) }
}

function isIdentStart (ch) { return /[A-Za-z_$]/.test(ch || '') }
function isIdentPart (ch) { return /[A-Za-z0-9_$]/.test(ch || '') }
function isWs (ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' }

// 正则字面量判定（review F2）：'/' 既可能是除号也可能是正则起始，词法扫描此前完全不建模正则字面量。
// xbk_sendNotify_slim.js:1366 的 /`([^`]+)`/g 正则体内含反引号，把状态机拖进模板串状态且永不闭合，
// 该文件尾部 86 个变异点（含 sendNotify 推送结果统计等高风险逻辑）被静默丢弃；正则体内的 < > 还会
// 生成伪变异（如 (?<![0-9]) → (?<=[0-9]) 的语义反转）。判定取保守口径：只有「前一有效 token 处于
// 表达式位置」才按正则处理，拿不准时仍按除号处理——宁可少认一个正则，也不吞掉后面代码区的变异点。
// PR 评审 #140 两处修正：
//   - 移除 '}'：它既可能是语句块结尾（可跟正则），也可能是对象字面量结尾（后面是除号）。
//     `({a:1} / q === r / s)` 里前一 '/' 是除号，原判分会误当正则并把中间的 === 一起吞掉（漏变异）。
//     歧义时按除号处理，与本判定的保守口径一致。
//   - 加入 '/'：除号右侧可以是正则字面量（`a / /x<y/.source`）。原判定不认，会把正则体当代码扫描，
//     为其中的 < > 生成并不存在于源码语义里的伪变异（虚增 killed）。
const REGEX_PREFIX_CHARS = '(,=:[!&|?{;+-*%^<>~/'
const REGEX_PREFIX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'await', 'yield', 'do', 'else', 'instanceof'])

function regexAllowed (prevChar, prevWord) {
  if (prevChar === null) return true
  if (REGEX_PREFIX_CHARS.includes(prevChar)) return true
  return prevWord !== null && REGEX_PREFIX_WORDS.has(prevWord)
}

// 扫描正则字面量（/.../flags）：返回结束偏移；同行内没有未转义的闭合 '/' 时返回 -1（按除号处理）。
// 字符类 [...] 内的 '/' 不是定界符；反斜杠转义整体跳过。
function scanRegexLiteral (source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return -1
    if (inClass) { if (c === ']') inClass = false; i++; continue }
    if (c === '[') { inClass = true; i++; continue }
    if (c === '/') { i++; while (i < source.length && isIdentPart(source[i])) i++; return i }
    i++
  }
  return -1
}

// 轻量 JS 词法扫描：只在代码区生成条件/逻辑变异，跳过注释、字符串、模板文本和正则字面量。
function generateMutants (file, source) {
  const out = []
  let i = 0
  let state = 'code'
  let quote = ''
  let quoteStart = -1
  // `${...}` 栈（review F2）：模板串里的 ${} 是代码不是文本，且可嵌套模板，必须按代码扫描并在匹配的
  // } 处回到模板文本。每层记当前花括号深度与 `${` 起始偏移。此前把整段模板当文本跳过，既漏掉
  // `${a && b}` 这类真实变异点，又会被嵌套模板的内层反引号带偏状态（xbk_app.js:1442 的
  // `${... ? 'x' : `${a}/${b} y`} ...` 会让尾部引号失配）。
  const substStack = []
  // 上一个有效 token，仅用于正则字面量判定：符号记其字符（如 ')'），标识符/数字记整词（如 'return'），
  // 字符串/模板/正则等「值」统一记 ')'（其后的 '/' 是除号）。行首/文件首为 null。
  let prevChar = null
  let prevWord = null
  const add = (start, end, original, replacement, kind) => {
    const lc = lineColumn(source, start)
    out.push({ file, start, end, original, replacement, kind, line: lc.line, column: lc.column })
  }
  while (i < source.length) {
    const c = source[i]
    const n = source[i + 1]
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2 } else i++; continue }
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (quote === '`' && c === '$' && n === '{') {
        substStack.push({ depth: 0, start: i })
        quote = ''
        prevChar = null
        prevWord = null
        i += 2
        continue
      }
      if (c === quote) { quote = ''; prevChar = ')'; prevWord = null; i++; continue }
      i++
      continue
    }
    if (isWs(c)) { i++; continue }
    if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
    if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
    if (substStack.length) {
      const frame = substStack[substStack.length - 1]
      if (c === '{') { frame.depth++; prevChar = '{'; prevWord = null; i++; continue }
      if (c === '}') {
        if (frame.depth === 0) { substStack.pop(); quote = '`'; i++; continue }
        frame.depth--
        prevChar = '}'
        prevWord = null
        i++
        continue
      }
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; quoteStart = i; i++; continue }
    if (c === '/' && regexAllowed(prevChar, prevWord)) {
      const end = scanRegexLiteral(source, i)
      if (end > 0) { i = end; prevChar = ')'; prevWord = null; continue }
    }
    let matched = false
    for (const [op, replacements] of OPS) {
      if (source.startsWith(op, i)) {
        for (const replacement of replacements) add(i, i + op.length, op, replacement, 'operator')
        prevChar = source[i + op.length - 1]; prevWord = null
        i += op.length; matched = true; break
      }
    }
    if (matched) continue
    if (isIdentStart(c)) {
      let j = i + 1
      while (isIdentPart(source[j])) j++
      const word = source.slice(i, j)
      if (BOOL_OPS.has(word)) for (const replacement of BOOL_OPS.get(word)) add(i, j, word, replacement, 'boolean')
      prevChar = word[word.length - 1]; prevWord = word
      i = j; continue
    }
    // '++' / '--' 之后是「值」（自增自减表达式），其后的 '/' 是除号：a++ / b 不能被误判为正则起始。
    prevChar = (c === '+' || c === '-') && prevChar === c ? ')' : c
    prevWord = null
    i++
  }
  // 走到文件尾仍是未闭合的引号/模板串（或未闭合的 ${）：说明扫描状态已经错乱（历史 F2 的静默丢弃
  // 源头），响亮失败并给出文件与行号，绝不让尾部变异点被静默吞掉。合法 JS 源码不会走到这里。
  if (quote || substStack.length) {
    const at = quote ? quoteStart : substStack[substStack.length - 1].start
    const lc = lineColumn(source, at)
    const what = quote ? `未闭合的 ${quote} 字符串` : '未闭合的 ${ 模板替换'
    throw new Error(`generateMutants: ${file} 第 ${lc.line} 行有${what} —— 词法扫描异常（正则字面量未被识别？），拒绝静默丢弃尾部变异点`)
  }
  return out
}

function collectMutants (files) {
  const all = []
  for (const file of files) {
    const full = path.join(ROOT, file)
    const source = fs.readFileSync(full, 'utf8')
    for (const mutant of generateMutants(file, source)) all.push(mutant)
  }
  return all.map((m, index) => ({ ...m, id: index + 1 }))
}

// node_modules 挂载（#136 review F3）：node_modules 属必选输入，symlinkSync 不校验目标是否存在，
// 缺依赖时会留下悬空链接 → 沙箱内套件必然失败 → 每个变异体被判 killed → 分数虚高且 exit 0（不响亮的假绿）。
// 从 copyProject 抽出为独立可调用点（dir = symlink 落点；sourceRoot = 依赖来源项目根，生产路径恒为 ROOT）：
// 原先该判定埋在 copyProject 内部，测试只能用「本机有没有 node_modules」猜分支——CI 在 npm ci 之后
// 必然存在 node_modules，缺依赖分支在 CI 中永不执行（删掉本处 throw，CI 依然全绿）。
// 抽成依赖注入点后，测试可自带一个确实没有 node_modules 的临时目录当来源根，使该分支在任何环境都必被执行。
function linkNodeModules (dir, sourceRoot = ROOT) {
  const nodeModules = path.join(sourceRoot, 'node_modules')
  // existsSync 跟随链接：node_modules 自身即是悬空链接时同样返回 false，一并按缺依赖响亮抛错
  if (!fs.existsSync(nodeModules)) throw new Error('copyProject 缺少 node_modules（沙箱内测试必然失败并被误判为「变异体已检出」）：请先 npm ci')
  const link = path.join(dir, 'node_modules')
  fs.symlinkSync(nodeModules, link, 'dir')
  return link
}

function copyProject (dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  // 变异测试运行 run_unit_tests.js（全量单元测试入口），需复制其依赖的全部文件：
  //   - 测试入口与套件清单：run_unit_tests.js / test_suites.js
  //   - 所有 test_*.js（单元测试会 require 对应 xbk_*.js 源文件）
  //   - 所有 xbk_*.js 生产源文件（测试依赖；变异目标 files 也在其中）
  //   - run_mutation.js 自身（test_filter.js / test_run_mutation*.js 等单元套件顶层 require 它）
  //   - package.json（版本一致性用例读取）
  //   - CHANGELOG.md（test_filter.js 的“文件头版本 ↔ CHANGELOG 最新”用例会 readFileSync 它）
  //   - scripts/ 与 qinglong/ 目录（部分测试依赖）
  // 此前只复制 test_filter.js 但运行 run_unit_tests.js，导致临时目录 MODULE_NOT_FOUND，
  // evaluate 恒返回 fail，行为断言无法建立（#15 根因）。
  // 注：漏拷 CHANGELOG.md 会使 test_filter.js 版本一致性用例 ENOENT → 同样令 evaluate 恒 fail，
  // 故“测试会读取的项目根文件”须逐一纳入，切勿遗漏。
  const entries = fs.readdirSync(ROOT)
  const testFiles = entries.filter(f => /^test_.*\.js$/.test(f))
  const srcFiles = entries.filter(f => /^xbk_.*\.js$/.test(f))
  const extraTop = ['run_unit_tests.js', 'test_suites.js', 'run_tests.js', 'run_mutation.js', 'package.json', 'CHANGELOG.md']
  // 固定清单（extraTop + 调用方传入的 files + DEFAULT_FILES）属必选：缺失须响亮报错，不能静默 continue——
  // 漏拷文件会留下沙箱 MODULE_NOT_FOUND/ENOENT → evaluate 恒 fail 的不响亮回归（#120/#122 一类根因）。
  // DEFAULT_FILES 在此无条件纳入（D3）：main() 已不再 existsSync 预过滤，缺任一变异目标源文件时由本处响亮报错。
  // 动态清单（testFiles/srcFiles 来自 readdirSync，必已存在）保持 continue 兜底。
  const required = new Set([...extraTop, ...files, ...DEFAULT_FILES])
  for (const name of [...required, ...testFiles, ...srcFiles]) {
    // 信任边界防护：拒绝目录穿越/绝对路径，确保只复制 ROOT 内文件
    if (name.includes('..') || path.isAbsolute(name)) throw new Error(`copyProject 拒绝越界路径: ${name}`)
    const src = path.join(ROOT, name)
    if (!fs.existsSync(src)) {
      if (required.has(name)) throw new Error(`copyProject 缺少必要文件: ${name}`)
      continue
    }
    const dst = path.join(dir, name)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  // 目录整体复制：scripts/ 与 qinglong/ 是部分测试的依赖；.github/ 是 CI 清单
  // （test_ci_skip_suites.js 要读 test.yml 与 mutation.yml 对账，缺一个就 ENOENT 误判失败，同 #120/#122 口径）
  // 三者同为必选（D3）：此前的 if (fs.existsSync) 是静默可选，目录一旦丢失同样留下 evaluate 恒 fail 的
  // 不响亮回归，与文件清单的必选口径不一致——现改为缺失即 throw。
  for (const sub of ['scripts', 'qinglong', '.github']) {
    const srcDir = path.join(ROOT, sub)
    if (!fs.existsSync(srcDir)) throw new Error(`copyProject 缺少必要目录: ${sub}`)
    fs.cpSync(srcDir, path.join(dir, sub), { recursive: true })
  }
  // node_modules 同为必选（#136 review F3）：判定与挂载见 linkNodeModules（生产路径恒以 ROOT 为来源根，
  // 缺依赖时的报错文案与调用时机均不变）。
  linkNodeModules(dir)
}

function applyMutants (dir, mutants) {
  const grouped = new Map()
  for (const m of mutants) {
    if (!grouped.has(m.file)) grouped.set(m.file, [])
    grouped.get(m.file).push(m)
  }
  const applied = []
  for (const [file, list] of grouped) {
    const full = path.join(dir, file)
    let source = fs.readFileSync(full, 'utf8')
    // 同偏移候选互斥（review F3）：'<'/'>'/'<='/'>=' 会在同一 [start,end) 生成两个替换候选
    // （如 '<' → '<=' 与 '>'），逐条套用会把两个都写进去，产出既非原码也非「原码+任一变异」的
    // 第三种代码（'a < b' → 'a >= b'；'if (a<b)' → 'if (a>)' 语法错），批级判定因此不可信。
    // 按 start 降序套用，并跳过与已套用区间重叠的候选：同一偏移只保留先套用的那一个（候选顺序
    // 由调用方列表决定，确定性）。
    let appliedFrom = Infinity
    for (const m of [...list].sort((a, b) => b.start - a.start || b.end - a.end)) {
      if (m.end > appliedFrom) continue
      source = source.slice(0, m.start) + m.replacement + source.slice(m.end)
      appliedFrom = m.start
      applied.push(m.id)
    }
    fs.writeFileSync(full, source, 'utf8')
  }
  // 返回值（评审 #143-2）：只有这些候选真正进了沙箱，批级结果只对它们成立；
  // 被跳过的重叠候选必须由调用方另行评估，不能继承同批结果。
  return applied
}

// 批次构造（评审 #143-2）：同一文件内区间重叠的候选互斥，不能进同一批——applyMutants 只会套用
// 其中一个，而批级结果（pass/killed）会被记到整批候选头上。典型场景：'<' 生成 '<=' 与 '>' 两个
// 同区间候选，若第一个被套用后测试通过，而第二个本会失败，两者都会被记成 survived（killed 记 alive）。
// 贪心装填：按 (file, start, end) 排序后取互不重叠的候选，单批上限 batchSize；不同文件不混批
// （重叠判定是文件内概念，混批还会让偏移区间失去可比性）。
function buildBatches (mutants, batchSize) {
  const byFile = new Map()
  for (const m of mutants) {
    if (!byFile.has(m.file)) byFile.set(m.file, [])
    byFile.get(m.file).push(m)
  }
  const batches = []
  for (const list of byFile.values()) {
    let cur = []
    let curEnd = -Infinity
    const flush = () => { if (cur.length) batches.push(cur); cur = []; curEnd = -Infinity }
    for (const m of [...list].sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (cur.length && (m.start < curEnd || cur.length >= batchSize)) flush()
      cur.push(m)
      if (m.end > curEnd) curEnd = m.end
    }
    flush()
  }
  return batches
}

function runTests (dir, timeoutMs) {
  return new Promise(resolve => {
    // 变异评估必须跑全量套件 —— 清除 SKIP_SUITES，防止 CI 显式步骤的跳过清单继承到子进程使变异分数失真。
    const child = spawn(DEFAULT_TEST[0], DEFAULT_TEST.slice(1), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XBK_MUTATION_CHILD: '1', SKIP_SUITES: '' } })
    let output = ''
    // 超时竞态修复：此前 setTimeout 回调里 kill 后立即 resolve，但此时 close 尚未触发、closeSignal 必为 null，
    // 且 stdout/stderr 还在继续排空——resolve 时既拿不到真实 signal（竞态），也拿不到最终完整 output，
    // 后续 close 回调的 resolve 因 Promise 已 resolve 被忽略（#131 qodo #3）。现改为：超时分支只标记 timedOut
    // 并 kill，真正的 resolve 一律收敛到 close 回调（close 时信号/输出已定稿），再叠加一个兜底保险定时器
    // 防止 kill 后 close 永不触发（异常文件描述符/僵尸进程）导致 Promise 悬空。
    // 契约要点（D1）：timedOut 只是「已过超时线」的标记，不是最终结论——结论一律由 close 携带的
    // 真实 code 决定。timeout 形态只覆盖两种：（a）已过超时线且 close 无 code（被我们的 SIGKILL
    // 杀死）、（b）close 悬空（由兜底定时器结算）。未过超时线却收到无 code 的 close（外部 kill /
    // OOM）不在其列，走 else 分支按 fail 记为 killed（#136 review：原注释漏了 timedOut 前提，
    // 与实现 if (timedOut && (code === null || code === undefined)) 不符）。
    let timedOut = false
    let falloutTimer = null
    child.stdout.on('data', d => { output += d })
    child.stderr.on('data', d => { output += d })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // 兜底保险：kill 后若 close 迟迟不触发（极端情况），仍要 resolve 不让 Promise 悬空——
      // 用当前已 collect 的输出，signal 回退 'SIGKILL'（真实 close signal 已无从得知）。
      // 正常 kill 会在毫秒级触发 close，此保险不会与 close 的 resolve 竞争（close 到达即
      // clearTimeout(falloutTimer)，无论是否已置 timedOut，一律以 close 的真实结论为准）。
      falloutTimer = setTimeout(() => {
        resolve({ status: 'timeout', code: null, signal: 'SIGKILL', output, summary: extractTestSummary(output) })
      }, 2000)
    }, timeoutMs)
    // 子进程 spawn 失败（如 PATH 里没有 node → ENOENT）只发 'error' 且不触发 'close'：未监听会抛
    // uncaughtException 让整轮调度器崩溃，Promise 也会一直悬到 2000ms 兜底定时器（review F5）。
    // 监听后按 fail 结算，并清掉超时/兜底两个定时器（90s 超时定时器不清理会无谓拖住进程）。
    // Promise 已 resolve 后 close 即使到达也只是被忽略，不会重复结算。
    child.on('error', error => {
      clearTimeout(timer)
      if (falloutTimer) clearTimeout(falloutTimer)
      resolve({ status: 'fail', code: null, signal: null, error: error.message, output, summary: extractTestSummary(output) })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (falloutTimer) clearTimeout(falloutTimer)
      if (timedOut && (code === null || code === undefined)) {
        // 已过超时线且 close 没给真实退出码（被信号杀死，如我们的 SIGKILL）：退出码不可知、
        // 输出不完整 → 维持 timeout 形态，signal 用 close 收到的真实值（拿不到才回退 'SIGKILL'）。
        resolve({ status: 'timeout', code: null, signal: signal || 'SIGKILL', output, summary: extractTestSummary(output) })
      } else {
        // 正常路径，以及「超时线已过但进程在 kill 生效前已自然退出」（close 携带真实 code）：
        // 一律按真实退出码判定 pass/fail，signal 透传（自然退出为 null）。此前该分支被并进 timeout
        // 形态，谎报 code: null + signal: 'SIGKILL'（D1）：把「刚好赶上超时窗口的正常完成」记为
        // timeout → main() 的 report.timeout 使本地运行误红，且与 scripts/mutation-report.js:103
        // 的 (killed + timeout) / total 同口径地把超时计入已检出，虚增分数、掩盖真实存活。
        resolve({ status: code === 0 ? 'pass' : 'fail', code, signal, output, summary: extractTestSummary(output) })
      }
    })
  })
  // 退出码口径披露（低，仅注释，不改行为）：上面的 D1 判定把「超时线已过、但进程在 kill 生效前
  // 自然非零退出」由 timeout 改写为 fail/killed。对 main() 而言二者不等价——timeout 计入
  // report.timeout 并让 process.exitCode 置 1，而 killed 只是「已检出」、不单独影响退出码。
  // 故手工运行 `node run_mutation.js` 时，落在同一超时窗口内的跑法可能出现退出码由 1 变 0：
  // 这是「按真实退出码判定」的预期结果（超时不再虚增已检出、也不再单独拉红），不是回归。
  // 影响范围仅限手工运行：run_mutation.js 不被任何 workflow / npm script 直接调用
  // （mutation.yml 与 stryker.config.js 的入口是 run_unit_tests.js），CI 退出码口径不受此改动影响。
}

// 提取测试汇总数字："全部通过！N/M" 或 "N 通过, M 失败, 共 K"
// S8786：数字组后接空白量词（\d+\s*）会被标超线性回溯，改用纯线性扫描。
// CodeAnt 审查：indexOf 取全文首个关键字会被无关日志（如测试名「…全部通过」）干扰；
// 汇总行位于输出末尾——从末行向上逐行匹配「全部通过！N/M」或「通过/失败/共」三数字齐全
// 的行；CodeAnt 复审：「全部通过」正则原先在行扫描前全文匹配，会被更早的无关「全部通过！1/1」
// 日志抢答——现与关键字检查同属逐行扫描，噪声日志不影响。
function extractTestSummary (output) {
  const lines = output.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const all = /全部通过！(\d+)\/(\d+)/.exec(lines[i])
    if (all) return [all[1], all[2]]
    const triple = lineTriple(lines[i])
    if (triple) return triple
  }
  return []
}

// 单行内找「K 通过, M 失败, 共 N」：取最后一个「共 N」，再向左取最近的「M 失败」「K 通过」。
// CodeAnt 复审：同一行前置无关「通过/失败/共」文本（如「检查通过：…」「之前失败 0」）不得抢答。
function lineTriple (s) {
  let total = null
  let totalPos = -1
  for (let i = 0; (i = s.indexOf('共', i)) !== -1; i += 1) {
    const n = numberAfter(s, i, 1)
    if (n !== null) {
      total = n
      totalPos = i
    }
  }
  if (total === null) return null
  let fail = null
  let failPos = -1
  for (let i = 0; (i = s.indexOf('失败', i)) !== -1 && i < totalPos; i += 1) {
    const n = numberBefore(s, i)
    if (n !== null) {
      fail = n
      failPos = i
    }
  }
  if (fail === null) return null
  let pass = null
  for (let i = 0; (i = s.indexOf('通过', i)) !== -1 && i < failPos; i += 1) {
    const n = numberBefore(s, i)
    if (n !== null) pass = n
  }
  if (pass === null) return null
  return [pass, fail, total]
}

// 关键字起点 idx 前紧邻的整数字符串（允许空白间隔），找不到返回 null
function numberBefore (s, idx) {
  let end = idx
  while (end > 0 && /\s/.test(s[end - 1])) end--
  let start = end
  while (start > 0 && s[start - 1] >= '0' && s[start - 1] <= '9') start--
  return start < end ? s.slice(start, end) : null
}

// 关键字终点（idx + kwLen）后紧邻的整数字符串（允许空白间隔），找不到返回 null
function numberAfter (s, idx, kwLen) {
  let start = idx + kwLen
  while (start < s.length && /\s/.test(s[start])) start++
  let end = start
  while (end < s.length && s[end] >= '0' && s[end] <= '9') end++
  return start < end ? s.slice(start, end) : null
}

async function evaluate (mutants, files, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-mutant-'))
  try {
    copyProject(dir, files)
    const appliedIds = applyMutants(dir, mutants)
    const result = await runTests(dir, timeoutMs)
    return { ...result, mutants: mutants.map(m => m.id), appliedIds }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function mapLimit (items, limit, fn) {
  // 零/负并发会让 Array.from({length: limit}) 得到空数组 → 一个 worker 都不启动、结果恒为空，
  // 调用方 while (pending.length) 便永久空转（review F9）。入口已校验，这里再断言一次，
  // 避免绕过入口（直接调用导出函数）时静默零进展。
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`mapLimit 并发度必须是正整数，收到 ${limit}`)
  const results = []
  let cursor = 0
  async function worker () {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function saveCheckpoint (file, state) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function loadCheckpoint (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

// 正整数环境变量解析（review F9）：MUTATION_BATCH=-1 会让批次循环 i += batchSize 变成 i 递减，
// 无限 push 空数组直到 OOM；MUTATION_CONCURRENCY=-1 会让 mapLimit 零并发空转，并且在此之前已经
// 把未判定的断点写进仓库根。统一在此校验：缺省/空串回落默认值，非法值（非正整数）回落默认值并告警
// ——绝不静默按非法值运行。
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

// 基线首跑（review F1）：沙箱整体红（工作区本来就有红的套件 / 环境断言 / flake）时，每个批次都会 fail，
// 二分到单点后全部记 killed → survived=0、timeout=0 → exit 0，还会打印 total=killed 的 100% 分数并写出
// mutation-report.json。这是本项目最典型的假绿：工作区越坏，变异分数越漂亮。故在写断点、进入批次循环
// 之前先跑一次未套变异的基线（与 stryker 的 initial run 同口径）；基线不通过即非零退出并打印原因，
// 不把「沙箱本来就红」归因给变异体。返回 null 表示基线通过，否则返回失败的运行结果。
async function ensureBaselinePass (files, timeoutMs, runEvaluation) {
  const result = await runEvaluation([], files, timeoutMs)
  return result && result.status === 'pass' ? null : result
}

async function main (deps) {
  // 依赖注入点（默认生产实现 evaluate）：测试可用 fake evaluate 覆盖基线与批次行为，
  // 无需真实沙箱与 node_modules（与 linkNodeModules/copyProject 的注入口径一致）。
  const runEvaluation = (deps && deps.evaluate) || evaluate
  const batchSize = positiveIntEnv('MUTATION_BATCH', 50)
  const concurrency = positiveIntEnv('MUTATION_CONCURRENCY', Math.max(1, Math.min(os.cpus().length, 8)))
  const timeoutMs = positiveIntEnv('MUTATION_TIMEOUT', 90000)
  const checkpointFile = process.env.MUTATION_CHECKPOINT || path.join(ROOT, 'mutation-progress.json')
  // D3：不再 existsSync 预过滤（会把缺失的 DEFAULT_FILES 静默剔除，使 copyProject 的必选校验不可达，
  // 且 collectMutants 会先抛出裸 ENOENT）。缺文件属工作区损坏，按 main() 既有风格响亮报错 + 退出码 1，
  // 而不是「少变异一个文件后仍报成功」。
  const missingSources = DEFAULT_FILES.filter(f => !fs.existsSync(path.join(ROOT, f)))
  if (missingSources.length) {
    console.error(`❌ 缺少变异目标源文件：${missingSources.join('、')}（请检查工作区完整性后重试）`)
    process.exitCode = 1
    return
  }
  const files = DEFAULT_FILES
  // 基线首跑（review F1）：必须在写断点/进入批次循环之前，且失败即中止——否则沙箱整体红会被
  // 逐批误判为「变异体已检出」（假绿 100%）。
  const baselineFailure = await ensureBaselinePass(files, timeoutMs, runEvaluation)
  if (baselineFailure) {
    console.error('❌ 基线运行失败（未套用任何变异体）：沙箱整体红，变异分数不可信，已中止本轮。')
    console.error(`   状态：status=${baselineFailure.status} code=${baselineFailure.code} signal=${baselineFailure.signal}` +
      (baselineFailure.error ? ` error=${baselineFailure.error}` : ''))
    console.error(`   摘要：${(baselineFailure.summary || []).join(',') || '(无)'}`)
    if (baselineFailure.output) console.error(`   输出末尾：\n${baselineFailure.output.slice(-2000)}`)
    process.exitCode = 1
    return
  }
  const mutants = collectMutants(files)
  const byId = new Map(mutants.map(m => [m.id, m]))
  const old = loadCheckpoint(checkpointFile)
  const killed = new Map((old && old.killed) || [])
  const survived = new Map((old && old.survived) || [])
  const compileErrors = new Map((old && old.compileErrors) || [])
  const resolved = new Set([...killed.keys(), ...survived.keys(), ...compileErrors.keys()].map(Number))
  const allBatches = buildBatches(mutants, batchSize)
  const pending = old && Array.isArray(old.pending)
    ? old.pending.map(ids => ids.map(Number).map(id => byId.get(id)).filter(Boolean)).filter(b => b.length)
    : allBatches
  for (let i = pending.length - 1; i >= 0; i--) {
    pending[i] = pending[i].filter(m => !resolved.has(m.id))
    if (!pending[i].length) pending.splice(i, 1)
  }
  console.log(`变异点：${mutants.length} 个；批次：${batchSize}；并发：${concurrency}；待判定：${mutants.length - resolved.size}`)
  const persist = () => saveCheckpoint(checkpointFile, {
    total: mutants.length,
    batchSize,
    killed: [...killed.entries()],
    survived: [...survived.entries()],
    compileErrors: [...compileErrors.entries()],
    pending: pending.map(batch => batch.map(m => m.id))
  })
  persist()
  while (pending.length) {
    const round = pending.splice(0, concurrency)
    const results = await mapLimit(round, concurrency, batch => runEvaluation(batch, files, timeoutMs))
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const batch = round[i]
      if (result.status === 'pass') {
        // 只把 pass 记到真正参与本次运行的候选头上（评审 #143-2）：同区间候选互斥，被跳过者若照旧
        // 记 survivor，会把「本会被杀死」的变异记成存活（分数虚高、假绿）。buildBatches 已保证批次
        // 内无重叠，这里兜底外部注入的 evaluate（测试）或将来新增的重叠来源——未套用者重新入队。
        const applied = new Set(Array.isArray(result.appliedIds) ? result.appliedIds : batch.map(m => m.id))
        const skipped = []
        for (const m of batch) {
          if (applied.has(m.id)) survived.set(m.id, { status: 'survived', batch: batch.map(x => x.id) })
          else skipped.push(m)
        }
        if (skipped.length) {
          console.log(`批次含重叠候选：${skipped.length} 个未参与运行，重新入队`)
          pending.push(skipped)
        }
        continue
      }
      if (batch.length === 1) {
        const id = batch[0].id
        const status = result.status === 'timeout' ? 'timeout' : 'killed';
        (status === 'timeout' ? compileErrors : killed).set(id, { status, summary: result.summary || [] })
        console.log(`单点 ${id}: ${status}`)
        continue
      }
      const mid = Math.ceil(batch.length / 2)
      pending.push(batch.slice(0, mid), batch.slice(mid))
    }
    persist()
    console.log(`进度：已判定 ${killed.size + survived.size + compileErrors.size}/${mutants.length}，待拆分 ${pending.length}`)
  }
  const report = {
    total: mutants.length,
    killed: killed.size,
    survived: survived.size,
    timeout: compileErrors.size,
    mutants: mutants.map(m => ({ ...m, result: killed.get(m.id) || survived.get(m.id) || compileErrors.get(m.id) || { status: 'pending' } }))
  }
  const reportFile = path.join(ROOT, 'mutation-report.json')
  saveCheckpoint(reportFile, report)
  try { fs.unlinkSync(checkpointFile) } catch (e) { /* 完成后没有断点文件也不影响报告 */ }
  console.log(`完成：total=${report.total} killed=${report.killed} survived=${report.survived} timeout=${report.timeout}`)
  process.exitCode = report.survived || report.timeout ? 1 : 0
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
module.exports = { generateMutants, collectMutants, extractTestSummary, lineColumn, isIdentStart, isIdentPart, isWs, regexAllowed, scanRegexLiteral, positiveIntEnv, ensureBaselinePass, main, lineTriple, numberBefore, numberAfter, mapLimit, saveCheckpoint, loadCheckpoint, copyProject, linkNodeModules, applyMutants, buildBatches, runTests, evaluate }
