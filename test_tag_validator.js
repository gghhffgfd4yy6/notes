'use strict'

// release.yml 的 tag semver 校验回归测试（#131 qodo #8）。
// release.yml 的「校验 tag 版本号格式（semver）」步骤用 bash 内联正则判定 v* tag 是否合法；sourcery
// 已修复该正则（禁止前导零、禁止空后缀组件），但当时无自动化测试固化。本套件从 scripts/validate-release-tag.js
// 复用同一套正则与校验函数，逐字断言合法/非法 tag 集合——测试与 workflow 同源，防止语义再漂移。
// 定位一律按**内容**：全文扫描 `[[ "$VERSION" =~ … ]]` 断言（不只看第一处），命中行的行号由命中下标
// 现算、并把该行原文打进诊断信息，故本文件任何地方都不写死 release.yml 行号——workflow 增删行
// （加步骤、改注释）不会让锚点或诊断失真。每一处命中还须处于 `!` 取反形态（`if ! [[ … ]]`），
// 见 isNegatedAt（#138 review Qodo #3：锚点放宽后「把取反写成正向」的语义反转一度无人拦）。
// 运行方式：node test_tag_validator.js（exit 0 = 通过）。
const assert = require('node:assert')
const fs = require('node:fs')
const { SEMVER_RE, isValidVersion } = require('./scripts/validate-release-tag.js')

// 双保险：脚本里的正则必须与 release.yml 步骤里 bash 内联的正则逐字一致（否则测试固化的不是
// CI 实际运行的判断）。从 release.yml 提取**全部** `[[ "$VERSION" =~ <正则> ]]` 断言（matchAll 全局
// 扫描，不再只取第一处）后逐个比对。
const releaseYml = fs.readFileSync('.github/workflows/release.yml', 'utf8')
const VERSION_ASSERT_RE = /\[\[ "\$VERSION" =~ (\S+) \]\]/g
const versionAsserts = [...releaseYml.matchAll(VERSION_ASSERT_RE)]
  .map(m => ({ index: m.index, bashRegexSource: m[1] }))
assert.ok(versionAsserts.length > 0, 'release.yml 应包含 semver 校验正则（=~ 判断）')
// 诊断按内容定位：用命中下标现算行号 + 该行原文（不写死行号，release.yml 增删行也不失真）
function describeAt (index) {
  const lineNo = releaseYml.slice(0, index).split('\n').length
  return `release.yml 第 ${lineNo} 行「${releaseYml.split('\n')[lineNo - 1].trim()}」`
}

// 取反形态判定（#138 review Qodo #3）：该断言必须写成 `if ! [[ "$VERSION" =~ … ]]`。
// 上一提交把锚点从「带 ! 的旧正则」放宽为不要求 !，于是「把取反写成正向条件」这种**语义反转**
// （合法 tag 被拒、畸形 tag 反而放行）本测试发现不了——文本层面只差一个 `!`，逐字同源断言毫无察觉。
// 判定同样不写死行号：取命中下标所在行、`[[` 之前的那段前缀，要求它以 `!`（作用于紧随命令的取反算子）
// 收尾——`if ! [[ … ]]`、`elif ! [[ … ]]`、`&& ! [[ … ]]` 均成立，而正向条件 `if [[ … ]]` 命中即红。
function isNegatedAt (index) {
  const lineStart = releaseYml.lastIndexOf('\n', index) + 1
  return /(?:^|\s)!\s*$/.test(releaseYml.slice(lineStart, index))
}

// 处数完备性：锚点只认 `[[ "$VERSION" =~ …`，故另一种取反写法 `if [[ ! "$VERSION" =~ … ]]`
// （`!` 挪进 `[[` 之内）会让该处**从 versionAsserts 里消失**，逐处断言静默少校验一处。
// 这里用与 `!` 位置无关的独立计数锚核对：每一处 `"$VERSION" =~` 判断都必须落在锚点扫描内。
const versionTildeCount = [...releaseYml.matchAll(/"\$VERSION"\s*=~/g)].length
assert.strictEqual(versionTildeCount, versionAsserts.length,
  'release.yml 里每一处 `"$VERSION" =~` 判断都必须落在 `[[ "$VERSION" =~ … ]]` 锚点内，不得有绕开逐处校验的写法')
const scriptSource = SEMVER_RE.source
// 处数口径：**至少 1 处 + 每一处都与 SEMVER_RE 逐字同源**，而不是「恰好 1 处」：
//   ① 本断言的价值是「CI 里判定 tag 的每一处正则都与脚本同源」。同源的重复断言（将来另一个 job/步骤
//      复用同一判断、或把该步骤拆成两次断言）属合法演进，「恰好 1 处」会误伤，且报错会红在「处数」
//      而不是「不同源」上，诊断指向错误的原因；
//   ② 逐处 strictEqual 保证只要多出**任何一处不同源**的正则（形如 `$VERSION =~ <别的正则>`）就一定
//      失败，即「release.yml 中该断言的集合与脚本正则同源」被完整强制，不会静默只校验第一处。
for (const { index, bashRegexSource } of versionAsserts) {
  const where = describeAt(index)
  // 先钉取反形态再比正则：丢掉 `!` 是**语义反转**，且文本层面只差一个字符，
  // 逐字同源断言对它完全无感（#138 review Qodo #3）。
  assert.ok(isNegatedAt(index),
    `${where} 的 =~ 判断必须处于取反形态（if ! [[ "$VERSION" =~ … ]]）：写成正向条件会反转判定语义——合法 tag 被拒、畸形 tag 反而放行`)
  // 归一化：bash 正则的 `$` 与脚本 `/.../` 字面等价，故连 `^...$` 边界一起逐字比对
  assert.ok(bashRegexSource.startsWith('^') && bashRegexSource.endsWith('$'),
    `${where} 的 semver 正则应有 ^...$ 边界`)
  // bash 正则体里的 `\` 转义序列与 JS 正则源码字符串一致（都不含 / 分隔符转义）
  assert.strictEqual(scriptSource, bashRegexSource,
    `${where}：scripts/validate-release-tag.js 的 SEMVER_RE 必须与 release.yml 的 bash 内联正则逐字一致`)
}

// ── 交集语法约束：逐字一致只防文本漂移，不防语义分叉 ──
// bash ERE 与 JS RegExp 语法集合不同（\d \w \s \b \B \D \W \S 简写类、反向引用、(?= (?<= (?! (?<!
// 前瞻/后顾、\p{...} Unicode 属性——两边要么一方不支持、要么语义不同）：若未来把正则扩展进这类写法，
// 上面的逐字断言照样通过，但 CI（bash）与本地（JS）行为分叉。下面用禁用 token / 禁用形态黑名单
// 强制执行「只会用两方言语义交集的子集」这一约束（详见 validate-release-tag.js 头部说明），命中即红。
// 黑名单强制的是下列**已列出**形态（不穷举所有方言差异，边界见 validate-release-tag.js 头部）：
//   1) 字面简写类 / 前瞻后顾 / Unicode 属性：\d \w \s \b \B \D \W \S、(?、(?= (?<= (?! (?<!、\p{
//   2) 数字反向引用：\1 \12 …（正则探测，非逐字 includes）
//   3) JS 专有转义：\n \t \r \f \v \0 \xHH \uHHHH \cX
//   4) POSIX 字符类：[[:digit:]] 等
//   5) GNU 扩展：词边界 \< \>、无上界/无下界量词 {n,} {,n}
const FORBIDDEN_TOKENS = ['\\d', '\\w', '\\s', '\\b', '\\B', '\\D', '\\W', '\\S', '(?', '\\p{']
for (const token of FORBIDDEN_TOKENS) {
  assert.ok(!scriptSource.includes(token),
    `SEMVER_RE 不得含 bash/JS 语义分歧写法 ${JSON.stringify(token)}（交集语法约束）`)
  for (const { index, bashRegexSource } of versionAsserts) {
    assert.ok(!bashRegexSource.includes(token),
      `${describeAt(index)} 的 bash 正则不得含 bash/JS 语义分歧写法 ${JSON.stringify(token)}（交集语法约束）`)
  }
}

// 数字反向引用（\1、\12 …）：上面 FORBIDDEN_TOKENS 用 includes 逐字匹配，覆盖不了「反斜杠+数字」
// 这一形态（'\\d' 字符串不含 '\1'，且多位数无法枚举）——#132 review Q2 漏网项。bash ERE 中
// \1 是后向引用，JS 正则里无对应捕获组时 \1 为八进制字面量，两边语义同样分叉，纳入禁用：
// 用正则探测「反斜杠+数字」形态（含 \1..\9 与多位数）。
const BACKREF_RE = /[\\][1-9][0-9]*/
assert.ok(!BACKREF_RE.test(scriptSource), 'SEMVER_RE 不得含数字反向引用（\\1、\\12 等，bash/JS 语义分叉）')
for (const { index, bashRegexSource } of versionAsserts) {
  assert.ok(!BACKREF_RE.test(bashRegexSource),
    `${describeAt(index)} 的 bash 正则不得含数字反向引用（\\1、\\12 等，bash/JS 语义分叉）`)
}

// 上两条覆盖不到的真实分歧形态（#132 review 补充）：JS 专有转义、POSIX 字符类、GNU 扩展。
// 与 FORBIDDEN_TOKENS 一样对「脚本正则源」和「release.yml 内联正则源」双向断言。
// 反斜杠形态一律用**完整形状**（\xHH / \uHHHH / \cX）而非裸 `\x`/`\u`：JS 正则字面量里不完整的 \x、\u
// 自身就是语法错误、不可能出现在 source 中，完整形状已覆盖所有可表示的该类写法（宁可少加规则）。
// 逐 token 核对：当前 SEMVER_RE.source 与 release.yml 内联正则逐字一致，反斜杠**只出现在 `\.`**（4 处），
// 且不含 `[[:` 与任何 `{`，故下列 4 条在现有正则上均不触发、不会误伤。
const FORBIDDEN_PATTERNS = [
  { re: /[\\](?:[ntrfv0]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|c[A-Za-z])/, desc: 'JS 专有转义（\\n \\t \\r \\f \\v \\0 \\xHH \\uHHHH \\cX——bash ERE 对普通字符前的反斜杠按字面处理）' },
  { re: /\[\[:/, desc: 'POSIX 字符类（[[:digit:]] 等——bash 是字符类，JS 是字符集合 + 字面 ]）' },
  { re: /[\\][<>]/, desc: 'GNU 词边界（\\< \\>——bash 是词首/词尾，JS 是字面 < >）' },
  { re: /\{[0-9]+,\}|\{,[0-9]+\}/, desc: '无上界/无下界量词（{n,} {,n}——非 POSIX ERE 保证形态，bash(glibc) 与 JS 支持度不一）' }
]
for (const { re, desc } of FORBIDDEN_PATTERNS) {
  assert.ok(!re.test(scriptSource),
    `SEMVER_RE 不得含 ${desc}（交集语法约束）`)
  for (const { index, bashRegexSource } of versionAsserts) {
    assert.ok(!re.test(bashRegexSource),
      `${describeAt(index)} 的 bash 正则不得含 ${desc}（交集语法约束）`)
  }
}

// 合法 tag 集合（语义：v数字.数字[.数字][-prerelease][+build]；禁止前导零；后缀组件非空）
const validTags = [
  'v3.272', // 两段（CHANGELOG 风格）
  'v3.272.0', // 三段（package.json 风格）
  'v0.1.0', // 前导数字 0 合法
  'v1.2.3-rc.1', // prerelease 多组件
  'v1.2.3+build.5', // build 多组件
  'v1.2.3-rc.1+build.2' // prerelease + build 同时存在
]
for (const tag of validTags) {
  const version = tag.slice(1) // 去 v 前缀，对应 workflow 的 ${GITHUB_REF#refs/tags/v}
  assert.strictEqual(isValidVersion(version), true, `合法 tag ${tag} 应通过校验`)
}

// 非法 tag 集合（必须 reject）
const invalidTags = [
  'vfoo', // 非数字
  'v1', // 只一个数字组件
  'v03.272', // 前导零
  'v3.272-alpha.', // prerelease 以 . 结尾（空组件）
  'v1.2.3.4', // 四段（多一个数字组件）
  'v1.2.3-rc..1', // 相邻空组件
  'v01.2.3', // 前导零
  'v1.2.3-', // 连字符后为空
  'v1.2.3+' // + 后为空
]
for (const tag of invalidTags) {
  const version = tag.slice(1)
  assert.strictEqual(isValidVersion(version), false, `非法 tag ${tag} 不应通过校验`)
}

// ── isValidVersion 的类型守卫（audit low/info：`typeof version !== 'string'` 早退）────────────
// RegExp.test 会先把非字符串入参 String() 化（1.2 → '1.2'、['1.2.3'] → '1.2.3'、带 toString 的对象
// 同理），于是「类型非法」被静默判成「版本号合法」：CI 里 version 来自 shell 变量（恒为字符串）时无感，
// 但本模块是被 require 的库（注释里写明「供 test_tag_validator.js 直接 require 断言」），调用方喂错类型
// 就是一处静默放行。生产改动加了 `if (typeof version !== 'string') return false`，这里逐类型钉死。
// 反证（本机实测）：删掉该守卫后，下面带 ★ 的四条会红——String() 化分别得到 '1.2' / '3.272' /
// '1.2.3' / '1.2.3'，个个命中 SEMVER_RE。
const nonStringInputs = [
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: '数字 1.2', value: 1.2 }, // ★ String() → '1.2'
  { label: '数字 3.272', value: 3.272 }, // ★ String() → '3.272'
  { label: '0', value: 0 },
  { label: '布尔 true', value: true },
  { label: '布尔 false', value: false },
  { label: '数组 ["1.2.3"]', value: ['1.2.3'] }, // ★ String() → '1.2.3'
  { label: '数组 [3, 272]', value: [3, 272] }, // String() → '3,272'（本来就不匹配）
  { label: '带 toString 的对象', value: { toString () { return '1.2.3' } } }, // ★ String() → '1.2.3'
  { label: '普通对象 {}', value: {} }
]
for (const { label, value } of nonStringInputs) {
  assert.strictEqual(isValidVersion(value), false,
    `非字符串入参 ${label} 必须返回 false（不得 String() 化后当成合法版本号放行）`)
}
// 守卫不得误伤合法字符串入参：上面的 validTags 循环已覆盖 6 种合法形态，此处再补一个「守卫加在
// RegExp.test 之前、不改变字符串分支行为」的直证（合法字符串仍须 true）。
assert.strictEqual(isValidVersion('3.272.0'), true, '字符串入参 3.272.0 必须仍判合法（类型守卫不得误伤字符串分支）')

console.log(`✅ tag 校验通过：${validTags.length} 个合法 / ${invalidTags.length} 个非法（与 release.yml 同源）`)
console.log(`✅ isValidVersion 类型守卫通过：${nonStringInputs.length} 个非字符串入参全部拒绝`)

// ── release.yml 步骤级回归（#136 review）─────────────────────────────────────────
// 教训：只断言 exit code 会漏掉「内容类」错误 —— notes 步骤曾 exit 0 却只写出标题行（9 字节），
// CHANGELOG 的要点从不进入 Release 正文。故这里把 release.yml 的 run: 块里那段 node 载荷抽出来
// 实际执行，并断言产出内容而不只是退出码；闸门则用「package.json × tag」矩阵锁定逐段一致性。
// 注意：执行载荷用子进程 + process.execPath（不调用 shell）。CI 上一切正常；Android 上
// process.execPath 指向 linker64，需 NODE_OPTIONS=--require <shim> 预加载 execpath-shim
// （与 test_check_mutation_ranges.js / test_ci_skip_suites.js 同一前提）。
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 抽取指定步骤的 run: 块（按 10 空格基准收敛缩进，保留块内相对缩进）
function extractRunBlock (yml, stepName) {
  const lines = yml.split('\n')
  const nameIdx = lines.findIndex(l => l.includes('name: ' + stepName))
  assert.ok(nameIdx !== -1, 'release.yml 应包含步骤「' + stepName + '」')
  const runIdx = lines.findIndex((l, i) => i > nameIdx && l.trim().startsWith('run: |'))
  assert.ok(runIdx !== -1, '步骤「' + stepName + '」应有 run: | 块')
  const indent = lines[runIdx].length - lines[runIdx].trimStart().length + 2
  const body = []
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { body.push(''); continue }
    if (line.length - line.trimStart().length < indent) break
    body.push(line.slice(indent))
  }
  assert.ok(body.length > 0, '步骤「' + stepName + '」的 run: 块不应为空')
  return body.join('\n')
}

// 从 run: 块里取出 node 载荷文本，并按 bash 双引号规则还原转义（bash 在双引号内只对反斜杠、
// 美元符、双引号、反引号与行尾续行特殊处理，其余反斜杠按字面保留）。这里不执行 shell：按名调用
// bash 会触发 SonarCloud S4036（PATH 规则，#136），且不执行 shell 也就没有 shell 注入面。
function extractNodePayload (block) {
  const start = block.indexOf('node -e "')
  assert.ok(start !== -1, 'run: 块应包含 node 载荷')
  const bodyStart = block.indexOf('\n', start) + 1
  const bodyEnd = block.indexOf('\n" "$VERSION"', bodyStart)
  assert.ok(bodyEnd !== -1, 'run: 块应包含 node 载荷的结束标记')
  const raw = block.slice(bodyStart, bodyEnd)
  assert.ok(raw.trim().length > 0, 'node 载荷不应为空')
  const BS = String.fromCharCode(92) // 反斜杠：用码点构造，避免本文件里出现层层叠加的转义序列
  const BT = String.fromCharCode(96) // 反引号
  const specials = [BS, '$', '"', BT]
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === BS && i + 1 < raw.length && specials.includes(raw[i + 1])) { out += raw[i + 1]; i++ } else out += raw[i]
  }
  return out
}

// 在临时目录里执行载荷（夹具文件按需落盘，绝不写仓库），argv[1] 与 CI 一致 = 去掉 v 的版本号
function runBlock (block, tag, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel136-'))
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  const res = spawnSync(process.execPath, ['-e', extractNodePayload(block), tag], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000
  })
  const notesPath = path.join(dir, 'release-notes.md')
  const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { status: res.status, stderr: res.stderr, notes }
}

const pkgJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const pkgCore = String(pkgJson.version).split('-')[0].split('+')[0]
const pkgBase = pkgCore.split('.').slice(0, 2).join('.')
// pkgBase 含 `.`（正则会当通配符），用于首行判定前必须转义
const escBase = pkgBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ① notes 必须包含 CHANGELOG 的要点正文，不能只有标题行
//    （回归点：match 正则带 'm' 时结尾的 $ 在行尾成立 → 惰性匹配止于标题行）
const notesBlock = extractRunBlock(releaseYml, '提取 Release Notes')
const notesRun = runBlock(notesBlock, pkgBase,
  { 'CHANGELOG.md': fs.readFileSync('CHANGELOG.md', 'utf8') })
assert.strictEqual(notesRun.status, 0, 'notes 提取应成功（stderr: ' + notesRun.stderr + '）')
// 首行不得只做前缀匹配：`'## v3.272.1…'.startsWith('## v3.272')` 为真，用 startsWith 时「取错三位标题
// 那一节」照样绿。改为「两段版本 + 其后不是 .数字」，既挡住三位续写，又保留 `## v3.272（日期）`、
// `## v3.272 摘要` 这类 release.yml 明确容忍的合法形态（下方夹具 A 亦按整行相等收紧）。
assert.ok(new RegExp('^## v' + escBase + '(?!\\.\\d)').test(String(notesRun.notes).split('\n')[0]),
  'Release Notes 首行应为 ## v' + pkgBase + '（不得只做前缀匹配、不得取三位标题节），实际: ' + JSON.stringify(notesRun.notes))
assert.ok(String(notesRun.notes).split('\n').filter(l => l.startsWith('- ')).length > 0,
  'Release Notes 必须含 CHANGELOG 要点正文（行首 -），不能只有标题行；实际: ' + JSON.stringify(notesRun.notes))

// ①' 章节边界「诱饵」夹具（#138 review Qodo #1）：
// 上面 ① 只用仓库真实 CHANGELOG.md，而真实文件里没有三位标题，于是 notes 步骤那个专为拒绝
// 「base=3.272 误命中三位标题 ## v3.272.1」而加的 `(?![.][0-9])` 边界即使被删掉/削弱，① 照样绿——
// 「取错章节」这件事本测试发现不了。下面两个夹具把这层边界钉死。标题按 package.json 现算成
// `## v<base>.1`（不写死 3.272，仓库升版后夹具自动跟随；与 ① 的 pkgBase 口径一致）：
//   夹具 A：三位标题出现在目标两段标题**之前**，内容故意不同 → 必须取到两段那一节、且不混入诱饵正文；
//   夹具 B：只有三位标题、没有两段标题 → 必须 fail-loud（非零退出 + 报「未找到 ## v<base> 章节」），
//          而不是静默把三位标题那一节当成本版正文发出去。
const decoyTitle = '## v' + pkgBase + '.1'
const realTitle = '## v' + pkgBase
const decoyBody = '- 三位标题节的诱饵要点（绝不能进入 Release Notes）'
const realBody = '- 两段标题节的要点正文'
const decoyBefore = runBlock(notesBlock, pkgBase, {
  'CHANGELOG.md': [
    '# Changelog', '', decoyTitle, '', decoyBody, '',
    realTitle, '', realBody, '',
    '## v0.0', '', '- 更早一节', ''
  ].join('\n')
})
assert.strictEqual(decoyBefore.status, 0, '夹具 A 应成功（stderr: ' + decoyBefore.stderr + '）')
// 标题必须**整行相等**、不能只 startsWith：`'## v3.272.1…'.startsWith('## v3.272')` 为真，
// 用 startsWith 的话「取错节」照样绿——这正是本夹具要抓的失效，断言本身不能留同一个坑。
assert.strictEqual(String(decoyBefore.notes).split('\n')[0], realTitle,
  '夹具 A：三位标题在前时 notes 首行仍须是「' + realTitle + '」（不得取错节），实际: ' + JSON.stringify(decoyBefore.notes))
assert.ok(String(decoyBefore.notes).includes(realBody), '夹具 A：notes 必须含两段标题节的正文')
assert.ok(!String(decoyBefore.notes).includes(decoyBody),
  '夹具 A：notes 不得混入三位标题节的内容，实际: ' + JSON.stringify(decoyBefore.notes))

const decoyOnly = runBlock(notesBlock, pkgBase, {
  'CHANGELOG.md': ['# Changelog', '', decoyTitle, '', decoyBody, ''].join('\n')
})
assert.notStrictEqual(decoyOnly.status, 0,
  '夹具 B：CHANGELOG 只有三位标题时 notes 步骤必须 fail-loud（非零退出），实际 exit ' + decoyOnly.status +
  '（产出: ' + JSON.stringify(decoyOnly.notes) + '）')
assert.ok(String(decoyOnly.stderr).includes('未找到 ## v' + pkgBase + ' 章节'),
  '夹具 B：应报「未找到 ## v' + pkgBase + ' 章节」，实际 stderr: ' + JSON.stringify(decoyOnly.stderr))
assert.strictEqual(decoyOnly.notes, null, '夹具 B：fail-loud 时不得写出 release-notes.md')

// ② tag 漂移闸门：逐段一致才放行（覆盖 package.json 补丁段非 0 的两个失效方向）
const gateBlock = extractRunBlock(releaseYml, '校验 tag 与 package.json 版本一致')
const gateCases = [
  { version: pkgCore, tag: pkgBase, expect: 0, why: '两段式 tag = 补丁段为 0 的 package.json（仓库口径）' },
  { version: pkgCore, tag: pkgCore, expect: 0, why: '完全一致' },
  { version: pkgCore, tag: pkgBase + '.1', expect: 1, why: '补丁段漂移必须拦下' },
  { version: pkgBase + '.1', tag: pkgBase + '.1', expect: 0, why: 'package.json 补丁段非 0 时完全一致的 tag 必须放行（早期实现误拦）' },
  { version: pkgBase + '.1', tag: pkgBase, expect: 1, why: 'package.json 补丁段非 0 时两段式 tag 属漂移（早期实现误放行）' },
  { version: pkgBase + '.1', tag: pkgBase + '.0', expect: 1, why: '同上，显式补 0 仍是漂移' },
  { version: pkgCore, tag: pkgBase + '.0.5', expect: 1, why: '四段式 tag 不得因前缀相同而放行' },
  { version: pkgBase + '.1', tag: pkgBase + '.2', expect: 1, why: '补丁段不同' }
]
for (const c of gateCases) {
  const res = runBlock(gateBlock, c.tag, { 'package.json': JSON.stringify({ ...pkgJson, version: c.version }) })
  assert.strictEqual(res.status, c.expect,
    'package.json=' + c.version + ' + tag v' + c.tag + ' 应 exit ' + c.expect + '（' + c.why + '），实际 ' + res.status + '（stderr: ' + res.stderr + '）')
}

console.log('✅ release.yml 步骤级回归通过：notes 含要点正文 + 章节边界诱饵夹具 2 组；闸门 ' + gateCases.length + ' 组用例全部符合预期')

// ── CLI 文案/退出码回归（audit low/info：文案不再无条件加 v 前缀）──────────────────────────
// 旧实现把两处文案都写成 `v${version}`（version = 去掉 v 后的裸版本号）：入参自带 v 时看不出差别
// （'v3.272' 的 version 是 '3.272'，拼回去恰好等于入参），但 CLI 明确接受**无 v 前缀**的裸版本号
// （见 validate-release-tag.js 的 `tag.startsWith('v') ? tag.slice(1) : tag`），此时旧文案会凭空补一个 v
// ——打印的 tag 与真实入参不符（'3.272' 打成 'v3.272'、'01.2.3' 打成 'v01.2.3'）。
// 故鉴别力全在「裸版本号」这组入参上；带 v 的入参两版实现输出相同，只作「回显的是 tag 原文」的补充。
// 本文件已有的 spawnSync 跑的是 release.yml 里的 node 载荷；本 CLI 分支由下面这段直接以子进程覆盖
// （cwd 固定 __dirname，不写绝对路径），覆盖 exit 0/1/2 三个退出码与两处文案。
const TAG_CLI = path.join(__dirname, 'scripts', 'validate-release-tag.js')
function runTagCli (...args) {
  const res = spawnSync(process.execPath, [TAG_CLI, ...args], { cwd: __dirname, encoding: 'utf8', timeout: 20000 })
  assert.strictEqual(res.error, undefined,
    'tag CLI 子进程应能启动（本机需 NODE_OPTIONS=--require .local/execpath-shim.js）：' + (res.error && res.error.message))
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

// ① 合法裸版本号（无 v）：成功文案必须原样回显入参；旧实现此处打成 v3.272
const barePass = runTagCli('3.272')
assert.strictEqual(barePass.status, 0,
  '裸版本号 3.272 合法，应 exit 0，实际 ' + barePass.status + '（stderr: ' + JSON.stringify(barePass.stderr) + '）')
assert.strictEqual(barePass.stdout.trim(), '版本号格式校验通过：3.272',
  '成功文案必须原样回显入参 tag（旧实现写 v + version，这里会打成「版本号格式校验通过：v3.272」），实际: ' + JSON.stringify(barePass.stdout))

// ② 非法裸版本号（无 v）：失败文案里的 tag 名同样不得补 v；旧实现此处打成 v01.2.3
const bareFail = runTagCli('01.2.3')
assert.strictEqual(bareFail.status, 1,
  '非法 tag 01.2.3 应 exit 1，实际 ' + bareFail.status + '（stderr: ' + JSON.stringify(bareFail.stderr) + '）')
assert.ok(bareFail.stderr.startsWith("❌ tag 名称 '01.2.3' 不是合法版本号"),
  '失败文案必须原样回显入参 tag（旧实现写 v + version，这里会打成「tag 名称 \'v01.2.3\'」），实际 stderr: ' + JSON.stringify(bareFail.stderr))

// ③ 带 v 入参仍原样回显：钉住「回显的是 tag 原文」而非别的变量（若实现改成回显 version，此处会红）
assert.strictEqual(runTagCli('v3.272').stdout.trim(), '版本号格式校验通过：v3.272',
  '带 v 的入参应原样回显（回显 tag 原文，而非去掉 v 的 version）')

// ④ 无参（用法错误）：exit 2 + 用法提示，且不得输出成功文案。
// audit 指出该分支此前没有任何断言（改错退出码/删掉用法提示都不会被发现）。
const noArg = runTagCli()
assert.strictEqual(noArg.status, 2,
  '未提供 tag 应 exit 2（用法错误，与「非法 tag」的 exit 1 区分），实际 ' + noArg.status)
assert.ok(noArg.stderr.includes('用法') && noArg.stderr.includes('validate-release-tag.js'),
  '无参应输出用法提示，实际 stderr: ' + JSON.stringify(noArg.stderr))
assert.strictEqual(noArg.stdout, '', '无参不得输出成功文案，实际 stdout: ' + JSON.stringify(noArg.stdout))

console.log('✅ validate-release-tag.js CLI 回归通过：裸版本号不补 v（成功/失败两处文案）+ 带 v 原样回显 + 无参 exit 2')
