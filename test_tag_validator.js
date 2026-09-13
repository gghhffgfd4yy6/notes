'use strict'

// release.yml 的 tag semver 校验回归测试（#131 qodo #8）。
// release.yml 的「校验 tag 版本号格式（semver）」步骤用 bash 内联正则（位于
// .github/workflows/release.yml 第 43 行）判定 v* tag 是否合法；sourcery 已修复该正则
// （禁止前导零、禁止空后缀组件），但当时无自动化测试固化。本套件从 scripts/validate-release-tag.js
// 复用同一套正则与校验函数，逐字断言合法/非法 tag 集合——测试与 workflow 同源，防止语义再漂移。
// 运行方式：node test_tag_validator.js（exit 0 = 通过）。
const assert = require('node:assert')
const fs = require('node:fs')
const { SEMVER_RE, isValidVersion } = require('./scripts/validate-release-tag.js')

// 双保险：脚本里的正则必须与 release.yml 步骤里 bash 内联的正则逐字一致（否则测试固化的不是
// CI 实际运行的判断）。从 release.yml 提取 `=~ <正则>` 的 bash 正则体，归一化后比对。
const releaseYml = fs.readFileSync('.github/workflows/release.yml', 'utf8')
const match = releaseYml.match(/! \[\[ "\$VERSION" =~ (\^.+?\$) \]\]/, '')
assert.ok(match, 'release.yml 应包含 semver 校验正则（=~ 判断）')
// 归一化：bash 正则的 `$` 与脚本的 `/.../` 字面等价，去掉 bash 正则里的 `^...$` 边界做正则源比对
const bashRegexSource = match[1]
assert.ok(bashRegexSource.startsWith('^') && bashRegexSource.endsWith('$'),
  'release.yml 的 semver 正则应有 ^...$ 边界')
const scriptSource = SEMVER_RE.source
// bash 正则体里的 `\` 转义序列与 JS 正则源码字符串一致（都不含 / 分隔符转义）
assert.strictEqual(scriptSource, bashRegexSource,
  'scripts/validate-release-tag.js 的 SEMVER_RE 必须与 release.yml 的 bash 内联正则逐字一致')

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
  assert.ok(!bashRegexSource.includes(token),
    `release.yml 的 bash 正则不得含 bash/JS 语义分歧写法 ${JSON.stringify(token)}（交集语法约束）`)
}

// 数字反向引用（\1、\12 …）：上面 FORBIDDEN_TOKENS 用 includes 逐字匹配，覆盖不了「反斜杠+数字」
// 这一形态（'\\d' 字符串不含 '\1'，且多位数无法枚举）——#132 review Q2 漏网项。bash ERE 中
// \1 是后向引用，JS 正则里无对应捕获组时 \1 为八进制字面量，两边语义同样分叉，纳入禁用：
// 用正则探测「反斜杠+数字」形态（含 \1..\9 与多位数）。
const BACKREF_RE = /[\\][1-9][0-9]*/
assert.ok(!BACKREF_RE.test(scriptSource), 'SEMVER_RE 不得含数字反向引用（\\1、\\12 等，bash/JS 语义分叉）')
assert.ok(!BACKREF_RE.test(bashRegexSource),
  'release.yml 的 bash 正则不得含数字反向引用（\\1、\\12 等，bash/JS 语义分叉）')

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
  assert.ok(!re.test(bashRegexSource),
    `release.yml 的 bash 正则不得含 ${desc}（交集语法约束）`)
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

console.log(`✅ tag 校验通过：${validTags.length} 个合法 / ${invalidTags.length} 个非法（与 release.yml 同源）`)

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

// ① notes 必须包含 CHANGELOG 的要点正文，不能只有标题行
//    （回归点：match 正则带 'm' 时结尾的 $ 在行尾成立 → 惰性匹配止于标题行）
const notesRun = runBlock(extractRunBlock(releaseYml, '提取 Release Notes'), pkgBase,
  { 'CHANGELOG.md': fs.readFileSync('CHANGELOG.md', 'utf8') })
assert.strictEqual(notesRun.status, 0, 'notes 提取应成功（stderr: ' + notesRun.stderr + '）')
assert.ok(notesRun.notes && notesRun.notes.startsWith('## v' + pkgBase),
  'Release Notes 应以 ## v' + pkgBase + ' 开头，实际: ' + JSON.stringify(notesRun.notes))
assert.ok(String(notesRun.notes).split('\n').filter(l => l.startsWith('- ')).length > 0,
  'Release Notes 必须含 CHANGELOG 要点正文（行首 -），不能只有标题行；实际: ' + JSON.stringify(notesRun.notes))

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

console.log('✅ release.yml 步骤级回归通过：notes 含要点正文；闸门 ' + gateCases.length + ' 组用例全部符合预期')
