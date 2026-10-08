'use strict'

// v3.281 文档行长闸门（scripts/check-doc-lines.js）的「三处接线」内容断言。
//
// 为什么由一个套件来锁：闸门本体从 `npm run check` 链 / `.githooks/pre-commit` / `test.yml` 任一处
// 被摘掉，都不会让任何东西变红——「删一行接线」本身不是失败。这与 v3.280 静态闸门同族，故沿用
// 同一套路：本套件在 test_suites.js 标 mutationSkip（它要读 .githooks/，而变异沙箱 copyProject 不
// 复制该目录 ⇒ 沙箱内必 ENOENT 假红），CI 覆盖由 test.yml 的显式步骤「文档行长接线断言」承担。
// **CI 上删掉闸门步骤或本地门链，下一次 CI 必红在这里。**
//
// 纯字符串/fs/进程内函数断言，不 spawn 子进程：与 test_ci_static_gates.js 同口径，本机与变异沙箱
// 都能跑（AGENTS「本机验证盲区」登记的 execPath 子进程限制在此不适用，但保持同一纪律更稳）。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const gate = require('./scripts/check-doc-lines.js')

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
// 行匹配一律「拆成行 + 去缩进后精确判定」，不用 /^\s*…$/m：静态分析把「\s* + 行尾锚 + 可能很长的行」
// 判成潜在超线性回溯（S5852），而这里的语义本来就只是「某一行的内容等于 / 以 X 起头」。
const lineThat = (text, re) => text.split('\n').map((l) => l.trim()).find((l) => re.test(l))
const linesThat = (text, re) => text.split('\n').map((l) => l.trim()).filter((l) => re.test(l))

let checks = 0
function check (label, fn) {
  fn()
  checks++
  console.log('✅ ' + label)
}

check('package.json：check 链含文档行长闸门，且排在 npm test 之前；两条 npm 脚本在册', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.strictEqual(pkg.scripts['check:doc-lines'], 'node scripts/check-doc-lines.js',
    'check:doc-lines 必须指向 scripts/check-doc-lines.js')
  assert.strictEqual(pkg.scripts['test:doc-line-gates'], 'node test_doc_line_gates.js',
    '本套件自身的 npm 脚本（test.yml 显式步骤走它，改名即脱链）')
  assert.ok(pkg.scripts.check.includes('npm run check:doc-lines'),
    'npm run check 链必须含 check:doc-lines——从链上摘除 = 本地总门禁静默失效')
  assert.ok(pkg.scripts.check.indexOf('check:doc-lines') < pkg.scripts.check.indexOf('npm test'),
    '文档行长必须排在 npm test 之前（秒级门禁先失败）')
  assert.ok(pkg.scripts.check.indexOf('check:doc-lines') > pkg.scripts.check.indexOf('check:ci-static'),
    '顺序契约：静态扫描在前、文档行长在后（两者都是秒级，别把最贵的提前）')
})

check('pre-commit：第 5 道 run_gate 接线存在，道数计数与真实调用数一致', () => {
  const hook = read('.githooks/pre-commit')
  // 行首锚定命令行形态（沿用 CodeRabbit #207 的口径）：注释里提到命令不算接线。
  assert.ok(linesThat(hook, /^run_gate "文档行长闸门/).some((l) => l.includes('npm run check:doc-lines')),
    'pre-commit 缺文档行长 run_gate 行 = 提交时刻不再拦 prose 回长')
  const gates = linesThat(hook, /^run_gate "/).length
  const CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  assert.ok(hook.includes(`${gates} 道快检`) && hook.includes(`${CN[gates]}道快检`),
    `pre-commit 的道数文案必须等于真实 run_gate 调用数（应为「${gates} 道」与「${CN[gates]}道」）`)
})

check('test.yml：闸门步骤与接线断言步骤都在，且走同一条 npm 链', () => {
  const yml = read('.github/workflows/test.yml')
  assert.ok(lineThat(yml, /^- name: 文档行长闸门（1200 字符\/行）$/),
    'test.yml 缺闸门步骤 = CI 上没人跑它（本套件将在兜底步骤里变红）')
  assert.ok(lineThat(yml, /^run: npm run check:doc-lines$/),
    'CI 必须走与本地同一条 npm 链，禁止 CI 侧自拼命令造成口径分叉')
  assert.ok(lineThat(yml, /^- name: 文档行长接线断言（test_doc_line_gates\.js）$/),
    '接线断言步骤被删 = 本套件脱门（再删闸门步骤就彻底无人看守）')
  assert.ok(lineThat(yml, /^run: npm run test:doc-line-gates$/),
    '接线断言步骤必须真跑本套件')
  // test.yml 不跑 npm run check（只有 release.yml 跑整链）——这句是「为什么必须在此显式列步骤」的
  // 前提，前提变了就该重新评估接线位置，故锁住。
  assert.ok(!lineThat(yml, /^npm run check$/),
    'test.yml 里出现整链 `npm run check` 说明接线位置需要重新评估（本套件的显式步骤前提变了）')
})

check('阈值与 fail-closed 口径不回退（1200 字符 / 空扫描面=红 / 无例外名单）', () => {
  assert.strictEqual(gate.MAX_DOC_LINE, 1200,
    '阈值被改动即红：调大=闸门形同虚设，调小=CI 常红最终被人摘掉。要改必须同时改三处接线与本断言')
  assert.deepStrictEqual(gate.scanOffenders('a'.repeat(1200), gate.MAX_DOC_LINE), [],
    '恰好等于上限不算超限（边界必须是 >）')
  assert.deepStrictEqual(gate.scanOffenders('a'.repeat(1201), gate.MAX_DOC_LINE), [{ line: 1, len: 1201 }],
    '多一个字符必须红，且给出行号与长度（否则修复者无从下手）')
  assert.strictEqual(gate.decideEmptyScan(0), 'fail',
    '「一个 markdown 都没扫到」必须是红——与「没跑过不等于通过」同一族 fail-closed 口径')
  assert.strictEqual(gate.isSkippedDir('.local'), true,
    '.local 是明确未入库的本机工作树，不进扫描面')
  assert.strictEqual(gate.isSkippedDir('.github'), false,
    '.github 下的 md（PR 模板/议题模板）必须受约束，不得留目录级豁免')
})

check('扫描面覆盖全部 prose 文档，且此刻全绿（闸门不该因存量问题常红）', () => {
  const files = gate.findMarkdownFiles(__dirname)
  for (const must of [
    'README.md', 'AGENTS.md', 'CHANGELOG.md', 'SYSTEM_CONTRACT.md',
    'CONTRIBUTING.md', 'SECURITY.md', '.github/pull_request_template.md'
  ]) {
    assert.ok(files.includes(must), `扫描面缺 ${must}：从遍历里悄悄掉出去一个文件 = 静默豁免`)
  }
  const red = []
  for (const rel of files) {
    const bad = gate.scanOffenders(read(rel), gate.MAX_DOC_LINE)
    if (bad.length) red.push(`${rel} L${bad[0].line}=${bad[0].len}`)
  }
  assert.deepStrictEqual(red, [],
    '闸门本身对当前仓库为红（本套件会先于此变红，逼着当场处理而不是留给 CI）：' + red.join(' '))
})

check('扫描面读取失败 = 红（review #211：不得静默 omit 读不到的目录）', () => {
  // ① 遍历本身把读取失败抛出来（旧实现 `catch { return }` 会让「少扫了一个目录」输出成「全绿」）
  assert.throws(() => gate.findMarkdownFiles(path.join(__dirname, '这个目录不存在')), /扫描面读取失败/)
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-docgate-'))
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'a.md'), 'ok\n')
    const boom = (d) => {
      if (d === path.join(tmp, 'docs')) {
        const e = new Error('EACCES')
        e.code = 'EACCES'
        throw e
      }
      return fs.readdirSync(d, { withFileTypes: true })
    }
    // 注入口是必需的：本仓 CI/开发机常以 root 跑，chmod 000 不产生 EACCES，真实权限造不出该情形
    assert.throws(() => gate.findMarkdownFiles(tmp, { readdir: boom }), /扫描面读取失败：目录 docs .*EACCES/)
    // ② 跳过名单一字未动：被跳过的目录根本不 open，注入读取失败也不得影响扫描面
    assert.deepStrictEqual(gate.findMarkdownFiles(tmp, {
      readdir: (d) => {
        if (d === path.join(tmp, 'node_modules')) throw new Error('不该被读到')
        return fs.readdirSync(d, { withFileTypes: true })
      }
    }), ['docs/a.md'])
    // ③ main 的接线：读取失败必须被接住、响亮报红并返回 1（本套件不 spawn，故按字面量锚定）
    const src = read('scripts/check-doc-lines.js')
    assert.ok(src.includes('files = findMarkdownFiles(root)'), 'main 里对 findMarkdownFiles 的调用形态不得漂移')
    assert.ok(src.includes('「扫描面不完整」不等于「全部通过」'),
      'main 缺遍历失败的 fail-closed 分支 = 读不到目录时闸门照样绿')
    const silentOmit = src.split('\n').some((line, i, lines) =>
      line.trim() === 'catch {' && lines[i + 1] && lines[i + 1].includes('读不到的目录不参与判定'))
    assert.ok(!silentOmit,
      '旧「静默 omit」形态回潮：读不到的目录又被当成不用判定')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('最长行不得用 spread 求（review #211：150k 行会让 Math.max(...args) 当场 RangeError）', () => {
  const src = read('scripts/check-doc-lines.js')
  // 只看可执行行：脚本里的注释本身要解释「为什么不用 spread」，按全文匹配会自己咬自己
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/Math\.max\(0,/.test(code), 'checkOne 又用回 Math.max(0, ...lines)：长文件会崩而不是判红')
  assert.ok(lineThat(code, /^return \{ rel, ok: offenders\.length === 0, offenders, longest \}$/),
    'checkOne 的返回形态不得漂移（longest 仍是数字、offenders 仍在）')
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-docgate-max-'))
  try {
    // 200k 行、其中一行超限：必须算出 longest 且判定正常（spread 形态在此必抛 RangeError）
    const lines = Array.from({ length: 200000 }, () => 'x')
    lines[100000] = 'y'.repeat(gate.MAX_DOC_LINE + 1)
    fs.writeFileSync(path.join(tmp, 'huge.md'), lines.join('\n'))
    const r = gate.checkOne(tmp, 'huge.md', gate.MAX_DOC_LINE)
    assert.strictEqual(r.longest, gate.MAX_DOC_LINE + 1, 'longest 必须是最长行的真实长度')
    assert.deepStrictEqual(r.offenders, [{ line: 100001, len: gate.MAX_DOC_LINE + 1 }], '超限行号与长度必须给全')
    assert.strictEqual(r.ok, false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

console.log(`✅ test_doc_line_gates 全部通过（${checks} 检查）`)
