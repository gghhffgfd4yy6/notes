// v3.281 文档行长闸门：仓库内任何被跟踪/在树的 markdown 都不允许出现超过 1200 字符的单行。
//
// 为什么存在：本仓 prose 的自然退化方向是「往一条 bullet 里追加」——AGENTS.md 在 v3.276~v3.280
// 期间长到单行 8132 字符、CHANGELOG 4788 字符，读者无法扫读、diff 一行改动=整行重写、评审只能
// 放弃逐字核对。v3.280 的文档同步把巨行重切成子弹后，没有任何东西阻止它再长回去：README /
// SYSTEM_CONTRACT 的**内容**同步本来就没门禁（check-version.js 只校验 CHANGELOG 的版本标题），
// 所以这里至少把「行长」这一维固化成硬校验：npm run check、pre-commit、CI quality job 三处同链。
//
// 口径：行长 = JS String.length（UTF-16 码元数）。中文一字算一个，emoji 代理对算两个——阈值留了
// 一倍余量（现值最长 885），这点差异不影响判定。不做按文件例外名单：一旦开了名单，名单本身
// 就是下一个「静默失效」的入口（与 v3.280「新增钩子/workflow 不得假定没被扫描」同口径）。
//
// fail-closed 三处：① 扫描面为空（0 个 md）判红；② 扫描面里某个目录读不下去 ⇒ 遍历当场抛错、
// main 判红（「没扫全」不等于「全绿」，静默 omit 一个目录就是下一个静默豁免的入口）；③ 单文件读盘
// 失败判红。与 zizmor JSON 解析不出来按不可判定=红、CI 缺扫描器=红同族。
//
// 用法：node scripts/check-doc-lines.js [--selftest] [--max N]
//   --selftest：纯函数断言（扫描面收集、行长判定、空扫描面判定），不依赖任何外部工具。
'use strict'

const fs = require('fs')
const path = require('path')

const MAX_DOC_LINE = 1200
// 只跳「不是源码树」的目录：依赖、构建/测试产物、以及 .local/ 这类明确未入库的本机工作树。
// 注意 .local 在册而 .github 不在册：PR 模板与 ISSUE_TEMPLATE 的 md 同样受约束。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.local', '.ai', '.tools', '.stryker-tmp', '.nyc_output',
  'reports', 'coverage'
])
// 缓存目录族是运行时产物（名字带 pid/分片后缀），与 test_ci_skip_suites.js 的遍历口径一致
const SKIP_PREFIXES = ['xianbaoku_cache', '.xbk_cache_safe']

function isSkippedDir (name) {
  if (SKIP_DIRS.has(name)) return true
  return SKIP_PREFIXES.some((p) => name.startsWith(p))
}

// 收集扫描面：返回排序后的相对路径（POSIX 分隔）。确定性排序是断言可复现的前提。
// fail-closed：非跳过目录读不下去 ⇒ **抛出**而非静默 omit——扫描面不完整时 main 必须判红，
// 否则「少扫了一个目录」与「全绿」在输出里长得一样（与 v3.280「新增钩子/workflow 不得假定没被
// 扫描」同口径）。opts.readdir 仅供 --selftest / 门禁注入「读不到」这一情形：以 root 跑时 chmod 000
// 不产生 EACCES，靠真实权限造不出来，故这里留出注入口而不是假装测过了。
function findMarkdownFiles (rootDir, opts) {
  const readdir = (opts && opts.readdir) || ((d) => fs.readdirSync(d, { withFileTypes: true }))
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = readdir(dir)
    } catch (e) {
      throw new Error('扫描面读取失败：目录 ' + (rel || dir) + ' 读不下去（' + ((e && e.code) || (e && e.message) || 'unknown') + '）')
    }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (isSkippedDir(e.name)) continue
        walk(path.join(dir, e.name), childRel)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(childRel)
      }
    }
  }
  walk(rootDir, '')
  // 显式比较器：默认 sort 会把元素 toString 后按 UTF-16 码元字典序排（此处正是想要的稳定顺序），
  // 但把口径写出来才能让「为什么是这个顺序」可见（Sonar S2879）。
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// 换行符不是正文：统一剥掉 CRLF 的行尾 `\r`，保留 String.length 的 UTF-16 码元口径。
function splitLines (text) {
  return String(text).split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
}

// 纯函数：给文本与上限，返回超限的行（行号 1 起）。上限判定是「>」而非「>=」——恰好等于不算红。
function scanOffenders (text, max) {
  const lines = splitLines(text)
  const bad = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > max) bad.push({ line: i + 1, len: lines[i].length })
  }
  return bad
}

// 纯函数：扫描面为空的判定。返回红/绿的字符串状态，由调用方负责退出码。
function decideEmptyScan (fileCount) {
  return fileCount > 0 ? 'ok' : 'fail'
}

// 汇总单文件结果：读盘失败按「不可判定 = 红」处理，绝不跳过当通过。
function checkOne (rootDir, rel, max) {
  let text
  try {
    text = fs.readFileSync(path.join(rootDir, rel), 'utf8')
  } catch (e) {
    return { rel, ok: false, reason: '读取失败：' + ((e && e.code) || (e && e.message) || 'unknown'), offenders: [] }
  }
  const offenders = scanOffenders(text, max)
  // 最长行**迭代**求，不用 Math.max(0, ...lines.map(len))：spread 把每个行长度当一个实参压栈，
  // 本机实测 100k 行 OK、150k 行 RangeError: Maximum call stack size exceeded —— 一个长 md 会让
  // 闸门当场崩（而不是判红），门禁的可用性不该取决于被扫文件的行数。
  const lines = splitLines(text)
  let longest = 0
  for (const l of lines) if (l.length > longest) longest = l.length
  return { rel, ok: offenders.length === 0, offenders, longest }
}

function selftest () {
  const assert = require('assert')
  // —— 行长判定的边界：恰好等于上限不红，多一个字符就红
  assert.deepStrictEqual(scanOffenders('a'.repeat(1200), 1200), [], '恰好 1200 字符不算超限')
  assert.deepStrictEqual(scanOffenders('a'.repeat(1201), 1200), [{ line: 1, len: 1201 }], '1201 字符必须红且给出行号与长度')
  assert.deepStrictEqual(scanOffenders('a'.repeat(1200) + '\r\n', 1200), [], 'CRLF 的 CR 不属于正文，不得把恰好 1200 字符判红')
  assert.deepStrictEqual(scanOffenders('a'.repeat(1201) + '\r\n', 1200), [{ line: 1, len: 1201 }], 'CRLF 下真正超过 1200 字符仍必须红')
  // —— 行号从 1 起、多行只报超限的那些（不误伤短行）
  assert.deepStrictEqual(scanOffenders('短行\n' + 'b'.repeat(1500) + '\n又一短行', 1200), [{ line: 2, len: 1500 }])
  // —— 空文本 / 只有换行：0 个超限，且不崩
  assert.deepStrictEqual(scanOffenders('', 1200), [])
  assert.deepStrictEqual(scanOffenders('\n\n', 1200), [])
  // —— 中文按字符计：1000 个汉字 = 1000 长度（不是 3000 字节）
  assert.strictEqual(scanOffenders('汉'.repeat(1000), 1200).length, 0, '中文行长按字符而非字节计')
  // —— 扫描面为空的 fail-closed 判定
  assert.strictEqual(decideEmptyScan(0), 'fail', '一个 md 都没扫到 = 不可判定 = 红')
  assert.strictEqual(decideEmptyScan(7), 'ok')
  // —— 跳过名单：依赖与本机工作树不进门禁，prose 与 .github 进
  assert.strictEqual(isSkippedDir('node_modules'), true)
  assert.strictEqual(isSkippedDir('.local'), true, '.local 明确未入库，不得当作扫描面')
  assert.strictEqual(isSkippedDir('xianbaoku_cache_p123'), true, '缓存目录族按前缀跳过（与 test_ci_skip_suites.js 同口径）')
  assert.strictEqual(isSkippedDir('.github'), false, '.github 下的 md（PR 模板等）必须受约束')
  assert.strictEqual(isSkippedDir('docs'), false)
  // —— 临时树：验证收集/超限/排序都是真的在干活（不依赖仓库内容）
  const os = require('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-doclines-'))
  try {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'vendored.md'), 'z'.repeat(5000))
    fs.mkdirSync(path.join(tmp, '.local'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.local', 'scratch.md'), 'z'.repeat(5000))
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'b.md'), 'q')
    fs.writeFileSync(path.join(tmp, 'a.md'), 'w'.repeat(1300))
    const files = findMarkdownFiles(tmp)
    assert.deepStrictEqual(files, ['a.md', 'docs/b.md'], '扫描面必须排序确定，且不含 node_modules/.local')
    const r = checkOne(tmp, 'a.md', MAX_DOC_LINE)
    assert.strictEqual(r.ok, false)
    assert.deepStrictEqual(r.offenders, [{ line: 1, len: 1300 }])
    assert.strictEqual(checkOne(tmp, 'docs/b.md', MAX_DOC_LINE).ok, true)
    // —— 读盘失败不可判定 = 红（不得当成「没有超限」）
    const missing = checkOne(tmp, '没有这个文件.md', MAX_DOC_LINE)
    assert.strictEqual(missing.ok, false)
    assert.match(missing.reason, /读取失败/)
    // —— 目录读不下去 = 扫描面不完整 = 必须抛（旧实现在此静默 omit，main 仍报「全绿」）
    assert.throws(() => findMarkdownFiles(path.join(tmp, '没有这个目录')), /扫描面读取失败/)
    const boom = (d) => {
      if (d === path.join(tmp, 'docs')) {
        const err = new Error('EACCES')
        err.code = 'EACCES'
        throw err
      }
      return fs.readdirSync(d, { withFileTypes: true })
    }
    // 注入口是必需的：以 root 跑时 chmod 000 不产生 EACCES，真实权限造不出这一情形
    assert.throws(() => findMarkdownFiles(tmp, { readdir: boom }), /扫描面读取失败：目录 docs .*EACCES/)
    // 跳过名单不受影响：被跳过的目录根本不 open，读不到也不报错
    assert.deepStrictEqual(findMarkdownFiles(tmp, {
      readdir: (d) => {
        if (d === path.join(tmp, 'node_modules')) throw new Error('不该被读到')
        return fs.readdirSync(d, { withFileTypes: true })
      }
    }), ['a.md', 'docs/b.md'], '跳过名单的目录不得参与遍历，也不得因注入的读取失败而报错')
    // —— 超长文件不得靠 spread 求最长行（150k 行会让 Math.max(...args) 当场 RangeError）
    const hugeRel = 'huge.md'
    fs.writeFileSync(path.join(tmp, hugeRel), Array.from({ length: 200000 }, () => 'x').join('\n'))
    const huge = checkOne(tmp, hugeRel, MAX_DOC_LINE)
    assert.strictEqual(huge.longest, 1, '200k 行文件的最长行必须算得出来（迭代求最大，不是 spread）')
    assert.strictEqual(huge.ok, true, '200k 行但每行 1 字符 ⇒ 绿')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  // —— 本仓真实扫描面必须非空（若哪天脚本被挪动导致 root 算错，这里就该红）
  const real = findMarkdownFiles(path.join(__dirname, '..'))
  assert.ok(real.length >= 7, '本仓至少应有 7 个 md 在册，实得 ' + real.length)
  assert.ok(real.includes('README.md') && real.includes('AGENTS.md') && real.includes('.github/pull_request_template.md'))
  console.log('✅ check-doc-lines --selftest 全部通过（28 断言）')
}

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    selftest()
    return 0
  }
  const maxIdx = argv.indexOf('--max')
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : MAX_DOC_LINE
  if (!Number.isInteger(max) || max <= 0) {
    console.log('❌ --max 必须是正整数，实得 ' + JSON.stringify(argv[maxIdx + 1]))
    return 1
  }
  const root = path.join(__dirname, '..')
  let files
  try {
    files = findMarkdownFiles(root)
  } catch (e) {
    console.log('❌ ' + ((e && e.message) || String(e)))
    console.log('   「扫描面不完整」不等于「全部通过」：与「空扫描面=红」「单文件读盘失败=红」同一条 fail-closed 口径')
    return 1
  }
  console.log('🔍 文档行长闸门：阈值 ' + max + ' 字符/行，扫描面 ' + files.length + ' 个 markdown')
  if (decideEmptyScan(files.length) === 'fail') {
    console.log('❌ 扫描面为空（一个 markdown 都没收集到）＝不可判定＝红；绝不把「没扫到」当「全绿」')
    return 1
  }
  let red = false
  let longest = 0
  for (const rel of files) {
    const r = checkOne(root, rel, max)
    if (typeof r.longest === 'number' && r.longest > longest) longest = r.longest
    if (!r.ok) {
      red = true
      if (r.offenders.length === 0) {
        console.log('❌ ' + rel + '：' + r.reason)
      } else {
        console.log('❌ ' + rel + '：' + r.offenders.length + ' 行超限（阈值 ' + max + '）')
        for (const o of r.offenders.slice(0, 5)) {
          console.log('   L' + o.line + ' = ' + o.len + ' 字符 → 按语义拆成子弹/表格（拆完跑逐字守恒核对）')
        }
        if (r.offenders.length > 5) console.log('   …另有 ' + (r.offenders.length - 5) + ' 行')
      }
    }
  }
  if (red) {
    console.log('❌ 文档行长未通过：把超限的行拆开，不要调大阈值——阈值放宽=闸门形同虚设')
    return 1
  }
  console.log('✅ 文档行长全部通过（' + files.length + ' 个文件，最长 ' + longest + ' 字符）')
  return 0
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { MAX_DOC_LINE, isSkippedDir, findMarkdownFiles, scanOffenders, decideEmptyScan, checkOne }
