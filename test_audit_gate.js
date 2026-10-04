'use strict'

// scripts/audit-gate.js 的子进程回归（G11）：该脚本是 v3.276 续新增的 **fail-closed 安全门禁**，
// 只在 .github/workflows/test.yml:218 被 `node scripts/audit-gate.js` 调用过，仓库内此前
// 零测试（grep audit-gate --include=test_*.js 为空、SUITES 里没有对应套件）——于是「豁免只针对
// GHSA-CH52-4W7C-C8XP、其余高危一律拦」这条契约完全无人守护：把 ALLOWED_ADVISORIES 放宽、
// 把 every 写成 some、或把「schema 漂移即拒」改成静默放行，CI 都不会红。
//
// 为什么走子进程：它是顶层执行式 CLI（`main()` 在 require 时即跑完并可能 process.exit(1)），
// 没有可单测的导出；且读的是 **cwd 相对路径** `audit-result.json`。进程内测需要 process.chdir
// （全局状态泄漏，本仓 #198/#199 刚专门修过这类），更会在仓库根留下未跟踪的 audit-result.json
// —— 该文件名不在 .gitignore，会让 pre-push 门禁的快路径失效（未跟踪文件算脏树）并有被误提交的风险。
// 故夹具一律写在 mkdtemp 私有目录里、以该目录为 cwd 拉起子进程，与 CI 的真实调用同路径。
//
// ⚠️ 口径如实登记：scripts/audit-gate.js **不是** mutation 矩阵的 mutate 目标（矩阵里没有它），
// 子进程断言也拿不到 TAP perTest 归因 ⇒ 本套件买的是「门禁不被静默改坏」的回归保护，不是变异分数。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.resolve(__dirname, 'scripts', 'audit-gate.js')
// 与 scripts/audit-gate.js 的 ALLOWED_ADVISORIES 同源：唯一豁免条目
const EXEMPT_URL = 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp'
const OTHER_URL = 'https://github.com/advisories/GHSA-zzzz-zzzz-zzzz'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-audit-gate-'))
// 清理兜底（照 test_storage.js:19 的写法）：断言失败走 process.exit 时末尾 rmSync 会被跳过，
// exit 钩子在 process.exit 时同步执行，rmSync 幂等（与末尾显式清理重复也无害）。
process.once('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } })

// raw 为字符串时按原文写入（用于「非法 JSON」这类夹具），否则 JSON.stringify
// 用例目录名用**自增计数**而不是 Math.random()：既避免 Sonar/Codacy 的「弱随机数用于路径」告警
// （CWE-330：伪随机数不可用于需要唯一性/不可预测性的场合），又让同一进程内的目录名可复现。
let caseSeq = 0
function run (raw) {
  caseSeq += 1
  // 夹具目录一律走 mkdtemp 私有目录（不在公共可写目录里用固定名），路径由本函数独占构造：
  // 唯一的“动态”来源是内部计数器与 mkdtemp 随机后缀，不接受任何外部输入 ⇒ Codacy 的
  // pathtraversal-non-literal-fs-filename 在本模块是结构性误报（同 xbk_storage.js 文件头说明）。
  const dir = fs.mkdtempSync(path.join(tmp, `case${caseSeq}-`)) // nosemgrep
  if (raw !== undefined && raw !== null) {
    fs.writeFileSync(path.join(dir, 'audit-result.json'), typeof raw === 'string' ? raw : JSON.stringify(raw)) // nosemgrep
  }
  // timeout 必须有：AG-08 的成环夹具在「环检测被改坏」时会让门禁自己无限循环，
  // 没有 timeout 的 spawnSync 会永久阻塞 ⇒ 整个套件挂到 CI 作业超时（而不是明确失败）。
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' })
  if (r.error || r.status === null) {
    throw new Error(`子进程未正常收场（error=${r.error && r.error.code} signal=${r.signal}）` +
      '：门禁自身挂死/被强杀必须让本套件明确失败，不得静默等外层超时')
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

// 直接 advisory 型高危条目（via 里带 url）
function direct (name, severity, urls) {
  return {
    [name]: {
      name,
      severity,
      via: urls.map(u => ({ source: 1, name, title: 'test advisory', url: u, severity })),
      range: '>=1.0.0',
      dependencies: [name]
    }
  }
}

// 间接链型高危条目（via 全是依赖名字字符串），链尾 root 携带 advisories
function indirect (chain) {
  const out = {}
  chain.forEach((hop, i) => {
    const isRoot = i === chain.length - 1
    out[hop.name] = {
      name: hop.name,
      severity: hop.severity || 'high',
      via: isRoot
        ? hop.advisories.map(u => ({ source: 1, name: hop.name, title: 'root advisory', url: u, severity: 'high' }))
        : [chain[i + 1].name],
      range: '>=1.0.0',
      dependencies: hop.deps || [i + 1 < chain.length ? chain[i + 1].name : hop.name]
    }
  })
  return out
}

let pass = 0
let fail = 0
function check (name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.error(`  ❌ ${name}: ${e && e.message ? e.message : e}`)
    process.exitCode = 1
  }
}

const ok0 = (r, why) => assert.strictEqual(r.status, 0, `必须 exit 0（${why}）｜stderr: ${r.stderr.trim().slice(0, 200)}`)
const ok1 = (r, why) => assert.strictEqual(r.status, 1, `必须 exit 1（${why}）｜stdout: ${r.stdout.trim().slice(0, 200)}`)

console.log('test_audit_gate（scripts/audit-gate.js 的 fail-closed 契约）')

check('AG-01 夹具缺失 → exit 1 并说明读不到 audit-result.json（不得当成“无漏洞”放行）', () => {
  const r = run(null)
  ok1(r, '读不到审计结果文件时必须拒绝放行')
  assert.match(r.stderr, /无法读取 audit-result\.json/, `stderr 必须指名读取失败（实际：${r.stderr.trim().slice(0, 200)}）`)
  assert.doesNotMatch(r.stdout, /安全审计通过/, '绝不输出“通过”字样')
})

check('AG-02 非法 JSON → exit 1 且与“文件不存在”区分开', () => {
  const r = run('{ this is not json')
  ok1(r, 'JSON 解析失败必须 fail-closed')
  assert.match(r.stderr, /不是合法 JSON/, '必须说明是 schema/解析问题')
  assert.doesNotMatch(r.stderr, /无法读取/, '读取失败与解析失败两条诊断不得混用')
})

check('AG-03 schema 漂移四态一律 exit 1（缺字段 / null / 数组 / 字符串）', () => {
  const drift = [
    ['缺 vulnerabilities 字段', { auditReportVersion: 2, metadata: {} }],
    ['vulnerabilities 为 null', { vulnerabilities: null }],
    ['vulnerabilities 为数组', { vulnerabilities: [] }],
    ['vulnerabilities 为字符串', { vulnerabilities: 'high' }]
  ]
  for (const [label, raw] of drift) {
    const r = run(raw)
    ok1(r, `${label}：npm audit 异常/输出形态漂移时必须拒绝放行`)
    assert.match(r.stderr, /缺少 vulnerabilities 字段|fail-closed/, `${label} 必须给出 schema 漂移诊断（实际：${r.stderr.trim().slice(0, 200)}）`)
  }
  // 空对象是合法形态（真没漏洞），必须与上面四类区分：不得误拒
  const empty = run({ vulnerabilities: {} })
  ok0(empty, 'vulnerabilities 为空对象是合法输入')
})

check('AG-04 无高危及以上 → exit 0 + 明确通过文案（low/moderate 不拦）', () => {
  const r = run({ vulnerabilities: Object.assign({}, direct('a', 'low', [OTHER_URL]), direct('b', 'moderate', [OTHER_URL]), direct('c', 'info', [OTHER_URL])) })
  ok0(r, '非高危不得拦')
  assert.match(r.stdout, /安全审计通过：无高危及以上漏洞/, '通过结论必须显式打印（供 CI 日志取证）')
})

check('AG-05 severity 大小写变体仍判高危（HIGH/Critical 不得被静默放行）', () => {
  for (const sev of ['HIGH', 'Critical', 'High', 'CRITICAL']) {
    const r = run({ vulnerabilities: direct('pkg-case', sev, [OTHER_URL]) })
    ok1(r, `severity=${sev} 必须计入高危（归一化防御）`)
    assert.match(r.stderr, /未豁免的高危漏洞：pkg-case/, `severity=${sev} 必须点名被拦的包`)
  }
})

check('AG-06 未豁免的高危 → exit 1 且点名具体包名（不得只给汇总）', () => {
  const r = run({ vulnerabilities: Object.assign({}, direct('evil-a', 'high', [OTHER_URL]), direct('evil-b', 'critical', [OTHER_URL])) })
  ok1(r, '未豁免高危必须拦')
  assert.match(r.stderr, /安全审计失败：存在未豁免的高危漏洞：evil-a, evil-b/, `两个包都要出现在点名列表（实际：${r.stderr.trim().slice(0, 200)}）`)
  assert.doesNotMatch(r.stdout, /安全审计通过/, '拦下时不得同时打印通过结论')
})

check('AG-07 命中豁免 → exit 0 + ::warning 注解显形 + 带理由（不静默）', () => {
  const r = run({ vulnerabilities: direct('http-cache-semantics', 'high', [EXEMPT_URL]) })
  ok0(r, '唯一豁免条目 GHSA-CH52-4W7C-C8XP 必须放行')
  assert.match(r.stdout, /^::warning title=安全审计豁免显形::/m, '必须以 GitHub Actions warning 注解显形')
  assert.match(r.stdout, /http-cache-semantics\(GHSA-CH52-4W7C-C8XP\) 被显式豁免/, '注解必须指名包名与 GHSA')
  assert.match(r.stdout, /got@11 传递依赖已停更/, '注解必须带上 ALLOWED_ADVISORIES 里的豁免理由，供审计追溯')
  assert.match(r.stdout, /✅ 安全审计通过（豁免条目已上方显形/, '放行结论必须说明“上方有豁免”')
})

check('AG-08 间接链溯源的三类断链一律 exit 1（空 via / 成环 / 指向不存在条目）', () => {
  const cases = [
    ['via 为空数组（链断，无法证明来源）', { vulnerabilities: { broken: { name: 'broken', severity: 'high', via: [], range: '1.0.0', dependencies: ['broken'] } } }],
    ['via 指向 vulnerabilities 里不存在的条目', { vulnerabilities: { ghost: { name: 'ghost', severity: 'high', via: ['not-listed'], range: '1.0.0', dependencies: ['not-listed'] } } }]
  ]
  const brokenChain = run(cases[0][1])
  ok1(brokenChain, `${cases[0][0]}：保守 block`)
  assert.match(brokenChain.stderr, /未豁免的高危漏洞：broken/, '断链必须点名，不得静默放行')
  const ghostChain = run(cases[1][1])
  ok1(ghostChain, `${cases[1][0]}：保守 block`)
  assert.match(ghostChain.stderr, /未豁免的高危漏洞：ghost/, '幽灵 via 必须点名 block')
  // 成环：手工造 a → b → a（indirect 助手造不出回边，故直接给原始对象）
  const cyclic = run({
    vulnerabilities: {
      'chain-a': { name: 'chain-a', severity: 'high', via: ['chain-b'], range: '1.0.0', dependencies: ['chain-b'] },
      'chain-b': { name: 'chain-b', severity: 'high', via: ['chain-a'], range: '1.0.0', dependencies: ['chain-a'] }
    }
  })
  ok1(cyclic, 'via 成环（a → b → a）：保守 block')
  assert.match(cyclic.stderr, /未豁免的高危漏洞：/, '环上条目必须被拦下（不得因“链上全是豁免名”而放行）')
})

check('AG-09 根节点 advisory 必须“全部在豁免清单”才放行（钉住 every，写成 some 立刻红）', () => {
  // got ← cacheable-request 的既有形态：链尾根节点同时挂「被豁免」与「未豁免」两条 advisory
  const mixed = run({
    vulnerabilities: indirect([
      { name: 'got' },
      { name: 'cacheable-request', advisories: [EXEMPT_URL, OTHER_URL] }
    ])
  })
  ok1(mixed, '根节点含任意未豁免 advisory 时必须 block（部分豁免 ≠ 全部豁免）')
  assert.match(mixed.stderr, /未豁免的高危漏洞：got/, '必须点名链首的包')
  // 对照组：同一链只挂被豁免的那一条 ⇒ 必须放行，证明上一条不是因为夹具坏才红
  const clean = run({
    vulnerabilities: indirect([
      { name: 'got' },
      { name: 'cacheable-request', advisories: [EXEMPT_URL] }
    ])
  })
  ok0(clean, '全部 advisory 在豁免清单的间接链必须放行')
  assert.match(clean.stdout, /⚠️ 豁免：got/, '间接链放行也要显形')
})

check('AG-10 GHSA 归一：小写 id 仍命中豁免；非 GHSA 形态 URL 保守 block', () => {
  const lower = run({ vulnerabilities: direct('semver-ish', 'high', ['https://github.com/advisories/GHSA-ch52-4w7c-c8xp'.toLowerCase()]) })
  ok0(lower, 'URL 里的小写 GHSA id 必须归一后命中豁免（大小写不匹配不得变成“漏豁免”）')
  assert.match(lower.stdout, /\(GHSA-CH52-4W7C-C8XP\) 被显式豁免/, '显形时必须用归一后的大写 id（与 ALLOWED_ADVISORIES 一致）')
  const weird = run({ vulnerabilities: direct('noidea', 'high', ['https://example.com/vuln/no-ghsa-id']) })
  ok1(weird, 'URL 提不出 GHSA id 时信息不足，保守 block')
  assert.match(weird.stderr, /未豁免的高危漏洞：noidea/, '提取失败必须点名，绝不静默放行')
})

check('AG-11 直接挂 advisory 的高危包：部分豁免不得放行（钉住 audit-gate.js:79 的 every）', () => {
  // 与 AG-09 的区别：AG-09 走的是「间接链根节点」那处 every（audit-gate.js:70）；
  // 这里的高危包 via 里**直接**带 advisory 对象，命中的是 audit-gate.js:79 的另一处 every。
  // 两处是彼此独立的判定，只钉一处等于另一半没有守卫：把 79 行的 every 写成 some，
  // 「同一包同时挂被豁免项与未豁免项」就会被整体放行，且未豁免项还会被打印成「⚠️ 豁免：」。
  const mixed = { vulnerabilities: direct('evil-pkg', 'high', [EXEMPT_URL, OTHER_URL]) }
  const r = run(mixed)
  ok1(r, '同一包上存在任意未豁免 advisory 时必须 block（部分豁免 ≠ 全部豁免）')
  assert.match(r.stderr, /未豁免的高危漏洞：evil-pkg/, `必须点名被拦的包：${r.stderr.trim().slice(0, 200)}`)
  assert.doesNotMatch(r.stdout, /豁免：evil-pkg\(GHSA-ZZZZ-ZZZZ-ZZZZ\)/,
    `未豁免的 advisory 绝不得被打印成“豁免”（some 化的典型症状）：${r.stdout.slice(0, 240)}`)
  // 反向对照：同一包只挂被豁免那一条 ⇒ 必须放行，证明上面的红来自 every 而不是夹具写坏
  const onlyExempt = { vulnerabilities: direct('evil-pkg', 'high', [EXEMPT_URL]) }
  ok0(run(onlyExempt), '同一包全部 advisory 均在豁免清单时必须放行')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '🎉' : '⚠️'} test_audit_gate.js 通过 ${pass}/${pass + fail} 项${fail > 0 ? `，失败 ${fail} 项` : '，全部通过'}`)
process.exit(fail === 0 ? 0 : 1)
