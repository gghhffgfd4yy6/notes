'use strict'

// CI 跳过清单一致性 + run_unit_tests.js 的 SKIP_SUITES / GITHUB_STEP_SUMMARY 行为回归。
// 背景：test.yml 的 SKIP_SUITES 与「显式步骤」是两份必须手工同步的清单——
//   漏写 = 重复跑（浪费），多写 = 漏跑（门禁盲区），拼错 = 静默失效（等于没跳过）。
//   本套件把「清单 ↔ 显式步骤」的双向对账与入口行为固定在门禁里，防止再次回归。
// 另含测试入口参数契约（EXEC-D T10）：test_app.js 的 `--only=<子串>` 必须真的过滤——
//   过滤静默失效时，用户照并行调度器（test_app_p.js）的定位提示串行重跑，反而触发全量用例。
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SUITES } = require('./test_suites')

// 仓库根固定路径：本套件以仓库根为 cwd 运行（CI 的 npm run test:unit、copyProject 沙箱、stryker 沙箱
// 都在仓库/沙箱根启动），故统一用字面量相对路径——不动态拼路径，静态分析也就没有误报空间。
assert.ok(fs.existsSync('package.json'), '请在仓库根目录运行本套件（CI 与沙箱均由仓库根启动）')
const testYml = fs.readFileSync('.github/workflows/test.yml', 'utf8')
const mutationYml = fs.readFileSync('.github/workflows/mutation.yml', 'utf8')
const pkg = require('./package.json')

// ── 缓存身份门禁：定义与正向调用**前移**到本文件顶部（审查 finding R3-F1 的修法）────────────
// 为什么必须前移：下方 `try {` … `} finally {`（只有 finally、**没有 catch**）块里的失败是**致命**的——
//   本机（Android/Termux）的 process.execPath 指向 linker64，凡 execFileSync(process.execPath, …) 形式的
//   子进程调用必失败 ⇒ 该块的第一条断言（「SKIP_SUITES 含未知套件须点名」）在本机必然先炸、进程当场退出，
//   其后的断言在本机**零覆盖**。而下面这两条门禁是**纯字符串**断言：只读已读入内存的 mutationYml，
//   既不 spawn 子进程、也不依赖任何本机环境 ⇒ 前移到那条环境失败之前，缓存身份一旦被改坏，红的是
//   **它自己**的断言文案，而不会被一个本机环境失败顶掉、无声无息地滑过去。
// CI 行为不变：这两条断言原本就在同一条同步执行流上**无条件执行**，只是提前了几百行。
// 边界（不得误读）：本机仍会在那条环境失败处退出，其后的断言（含下方 7 个靶向反例）在本机依旧零覆盖——
//   本前移**没有**、也**不声称**扩大任何断言的覆盖范围。
const indentOf = line => line.length - line.trimStart().length
const yamlOnly = text => text.split('\n').filter(l => !l.trim().startsWith('#'))

// (1)「恢复增量缓存」：key 与 restore-keys 必须是**回退后 + 带档位 + 带依赖**的形态——不含测试指纹段，
//     而是 `stryker-<段>-cfg-<matrix.config 档位>-<配置指纹>-deps-<依赖指纹>`，源指纹只进主 key。
//     抽成函数是为了让紧随其后的反例在**同一套提取 + 断言代码**上跑真实 workflow 的变异副本：把 key
//     改回含测试指纹的形态 ⇒ 必须立刻红。
const assertCacheStep = (ymlText) => {
  const cacheAt = ymlText.indexOf('- name: 恢复增量缓存')
  assert.ok(cacheAt >= 0, 'mutation.yml 必须存在「恢复增量缓存」步骤（缓存策略无从核对即视为回归）')
  const cacheEnd = ymlText.indexOf('- name: 清理缓存回填的旧报告', cacheAt)
  assert.ok(cacheEnd > cacheAt, '「恢复增量缓存」之后应紧跟「清理缓存回填的旧报告」步骤')
  const cacheLines = yamlOnly(ymlText.slice(cacheAt, cacheEnd))
  const keyLine = cacheLines.find(l => /^\s*key:\s/.test(l))
  assert.ok(keyLine, '「恢复增量缓存」必须声明 key')
  // key 必须逐字等于**档位名 + 配置指纹 + 依赖指纹 + 源指纹**形态：
  //   stryker-<段>-cfg-<matrix.config 档位>-<两份 stryker 配置 + scripts/tap-shim.js 指纹>-deps-<package-lock.json 指纹>-src-<源指纹>。
  // 源指纹固定用 matrix.src + run_mutation.js：mutate 里的范围字面量如 "xbk_function_v3.js:1-442" 不能作 hashFiles 参数，
  // 会得到空指纹、使 range 段缓存永不过期。
  // 配置指纹（stryker.config.js + stryker.tap.config.js + scripts/tap-shim.js）与**档位名 `matrix.config`** 都必须同时出现在
  // key 与兜底前缀里：主 key 未命中时 core 会对恢复进来的 inc **零校验**，兜底前缀若不含配置指纹就会把
  // 另一档 runner 的旧 inc 当本轮结果复用（qodo High / sourcery 评审发现，实测 http 段 6/133 复用、
  // NC 13→7）；而**两份配置的 hashFiles 对 19 段是同一个常量**（档位只体现在各段的 `config:` 字段上），
  // 故只放配置指纹还不够——某段只改 `config:` 而不动配置文件时 key 与兜底前缀会逐字节不变、跨档继承
  // 从主 key 与兜底两条路径一起复活（审查 A1·D2）。档位名进 key/兜底后，`config:` 一变即换缓存身份。
  // **依赖指纹（package-lock.json）必须同时进主 key 与兜底前缀**（本轮新不变式：兜底前缀 = 缓存身份里
  // 除源指纹以外的全部段 ⇒ 兜底只允许跨**源文件**变化）：缺陷实测（run 35775812104 / issue #167）——
  // dependabot 把 fast-check 4.10.0→4.10.1 后 package-lock.json 变了、主 key 因含依赖指纹而未命中，但
  // 旧形态把依赖只放在主 key 里、兜底前缀不含 deps ⇒ 兜底把旧 inc 原样复原，而 stryker 的
  // incremental-differ 只按**文件内容** diff、不认识依赖版本 ⇒ 19/19 段 100% 复用，依赖升级从未重算。
  const open = '${'
  assert.strictEqual(keyLine.trim(),
    'key: stryker-' + open + '{ matrix.name }}-cfg-' + open + '{ matrix.config }}-' + open + "{ hashFiles('stryker.config.js', 'stryker.tap.config.js', 'scripts/tap-shim.js') }}-deps-" + open + "{ hashFiles('package-lock.json') }}-src-" + open + "{ hashFiles('run_mutation.js', matrix.src) }}",
    '缓存 key 必须逐字等于 stryker-<段>-cfg-<档位 matrix.config>-<配置指纹 = 两份 stryker 配置 + scripts/tap-shim.js>' +
    '-deps-<依赖指纹 = package-lock.json>-src-<源指纹 = run_mutation.js + matrix.src>（不含 -tests- ' +
    '测试指纹段）：PR #156 的「测试指纹强制全量」已回退——它拦不住真根因（假 Killed 来自共享缓存的并发' +
    '串扰，基线全程是绿的）、跑不完（app/utils/message-store 真全量在 --concurrency 8 下仍需 ~7h/~6.5h/' +
    '~4.5h，必撞 step 330min，而失败段不保存缓存进度 ⇒ 永久红），且当前**无分数门禁** ⇒ 复用不构成门禁' +
    '风险（有意接受的取舍）。依赖指纹必须进 key：dependabot 升 fast-check 4.10.0→4.10.1 时' +
    'package-lock.json 变化必须换掉缓存身份，否则 19/19 段 100% 复用（实测 run 35775812104 / issue #167）')
  assert.ok(!keyLine.includes('-tests-') && !keyLine.includes('test_*.js'),
    '缓存 key 不得再含测试指纹（`-tests-` / `test_*.js`）：一旦改回含指纹形态，本条断言立即红')
  const restoreIdx = cacheLines.findIndex(l => /^\s*restore-keys:/.test(l))
  assert.ok(restoreIdx >= 0, '「恢复增量缓存」必须声明 restore-keys')
  const restoreIndent = indentOf(cacheLines[restoreIdx])
  const restoreKeys = []
  for (let i = restoreIdx + 1; i < cacheLines.length; i++) {
    if (cacheLines[i].trim() === '' || indentOf(cacheLines[i]) <= restoreIndent) break
    restoreKeys.push(cacheLines[i].trim().replace(/^-\s*/, ''))
  }
  assert.deepStrictEqual(restoreKeys, ['stryker-' + '${' + '{ matrix.name }}-cfg-' + '${' + '{ matrix.config }}-' + '${' + "{ hashFiles('stryker.config.js', 'stryker.tap.config.js', 'scripts/tap-shim.js') }}-deps-" + '${' + "{ hashFiles('package-lock.json') }}-"],
    'restore-keys 必须是**带档位名 + 配置指纹 + 依赖指纹**（含 scripts/tap-shim.js 与 package-lock.json）的兜底前缀 `stryker-' + '${' + '{ matrix.name }}-cfg-<matrix.config 档位>-<配置指纹>-deps-<package-lock.json 指纹>-`：' +
    '同档配置内可跨 src 变更兜底复用；跨档（runner / tap.testFiles / coverageAnalysis 变化，或只改某段的 ' +
    'config:）不再互相继承——档位名与配置指纹都在前缀里，任一变化前缀即变；不含测试指纹（PR #156 那版已回退）。' +
    '**依赖指纹必须在兜底前缀里**（本轮新不变式：兜底前缀 = 缓存身份里除源指纹以外的**全部**段 ⇒ 兜底只允许' +
    '跨源文件变化）：旧形态把 package-lock.json 只放在主 key 里，dependabot 升 fast-check 4.10.0→4.10.1 后' +
    '主 key 未命中、兜底却把旧 inc 原样复原，而 incremental-differ 只按文件内容 diff、**不认识依赖版本** ⇒ ' +
    '19/19 段 100% 复用、依赖升级从未重算（实测 run 35775812104 / issue #167）')
}
assertCacheStep(mutationYml)

// (1b) **档位名 + 依赖指纹必须参与缓存身份**（档位审查 A1·D2；依赖 issue #167）：key 与兜底前缀里都要有
//      `${{ matrix.config }}` 与 `-deps-${{ hashFiles('package-lock.json') }}-`，且兜底前缀不得含 `-src-`。
//      为什么单靠「配置指纹」不够：两份配置文件的 hashFiles 对 19 段是**同一个常量**（实测 19 条 key 里
//      cfg 取值只有 1 个），档位只由各段自己的 `config:` 字段体现。于是「某段只改 `config:`、不动任何配置
//      文件」时 key 与兜底前缀**逐字节不变** ⇒ 该段仍会命中/恢复**旧档**的 inc（core 对 inc 零校验），
//      「跨档不再互相继承」被绕过。把档位名放进 key 与兜底后，`config:` 一变即换缓存身份。
//      为什么依赖必须同时在兜底里（本轮新不变式：兜底前缀 = 缓存身份里除源指纹以外的全部段 ⇒ 兜底**只**
//      允许跨源文件变化）：dependabot 升 fast-check 4.10.0→4.10.1 后 package-lock.json 变化、主 key miss，
//      但旧形态兜底前缀不含 deps ⇒ 旧 inc 被原样复原，而 incremental-differ 只按文件内容 diff、不认识依赖
//      版本 ⇒ 19/19 段 100% 复用（实测 run 35775812104 / issue #167）。兜底前缀带 `-src-` 则另一极端：
//      永不兜底或跨源继承。
//      抽成独立函数（而不是塞进 assertCacheStep）：assertCacheStep 的首条断言是 key 的逐字 strictEqual，
//      任何 key 变异都会先在那里红，这里的几个方向就永远走不到；独立后各条反例各由本函数自己拦截。
const assertCacheConfigIdentity = (ymlText) => {
  const cacheAt = ymlText.indexOf('- name: 恢复增量缓存')
  assert.ok(cacheAt >= 0, 'mutation.yml 必须存在「恢复增量缓存」步骤（档位缓存身份无从核对即视为回归）')
  const cacheEnd = ymlText.indexOf('- name: 清理缓存回填的旧报告', cacheAt)
  assert.ok(cacheEnd > cacheAt, '「恢复增量缓存」之后应紧跟「清理缓存回填的旧报告」步骤')
  const cacheLines = yamlOnly(ymlText.slice(cacheAt, cacheEnd))
  const keyLine = cacheLines.find(l => /^\s*key:\s/.test(l))
  const restoreIdx = cacheLines.findIndex(l => /^\s*restore-keys:/.test(l))
  assert.ok(keyLine && restoreIdx >= 0, '「恢复增量缓存」必须同时声明 key 与 restore-keys')
  assert.match(keyLine, /-cfg-\$\{\{\s*matrix\.config\s*\}\}-\$\{\{\s*hashFiles\(/,
    '缓存 key 的档位段必须是 `-cfg-$' + '{' + '{ matrix.config }}-$' + '{' + '{ hashFiles(…`：配置指纹对 19 段' +
    '是同一个常量，档位只由 matrix.config 体现；缺了它，只改某段的 config: 而**不动任何配置文件**时 key ' +
    '逐字节不变 ⇒ 该段仍命中旧档 inc，跨档继承从主 key 路径复活（A1·D2）')
  assert.match(keyLine, /hashFiles\('stryker\.config\.js', 'stryker\.tap\.config\.js', 'scripts\/tap-shim\.js'\)/,
    '缓存 key 的配置指纹必须含 `scripts/tap-shim.js`（A6）：TAP 档的**覆盖归因结果**由 tap-shim 决定' +
    '（stryker.tap.config.js 的 `tap.nodeArgs` 预加载它），只改 shim 而不动配置文件时旧 inc（按旧归因算出的' +
    'killed/survived）会被当成新结果复用 ⇒ shim 必须与两份 stryker 配置在同一段 hashFiles 里')
  assert.match(keyLine, /-deps-\$\{\{\s*hashFiles\('package-lock\.json'\)\s*\}\}-/,
    '缓存 key 必须含 `-deps-$' + '{' + '{ hashFiles(\'package-lock.json\') }}-` 依赖指纹段：dependabot 升 ' +
    'fast-check 4.10.0→4.10.1 后依 package-lock.json 变化必须换掉缓存身份，否则主 key 未命中也会被兜底复原' +
    '（实测 run 35775812104 / issue #167：19/19 段 100% 复用、依赖升级从未重算）')
  const restoreIndent = indentOf(cacheLines[restoreIdx])
  const restoreKeys = []
  for (let i = restoreIdx + 1; i < cacheLines.length; i++) {
    if (cacheLines[i].trim() === '' || indentOf(cacheLines[i]) <= restoreIndent) break
    restoreKeys.push(cacheLines[i].trim().replace(/^-\s*/, ''))
  }
  assert.strictEqual(restoreKeys.length, 1,
    '「恢复增量缓存」的 restore-keys 应恰有一条兜底前缀（多/少都视为缓存策略漂移）')
  assert.match(restoreKeys[0], /-cfg-\$\{\{\s*matrix\.config\s*\}\}-\$\{\{\s*hashFiles\(/,
    '兜底前缀的档位段必须是 `-cfg-$' + '{' + '{ matrix.config }}-$' + '{' + '{ hashFiles(…`：主 key 未命中时' +
    '由兜底恢复 inc，只把档位名加进 key 不够——缺了它，只改 config: 时兜底前缀也逐字节不变 ⇒ 跨档继承从' +
    '兜底路径复活（A1·D2）')
  assert.match(restoreKeys[0], /hashFiles\('stryker\.config\.js', 'stryker\.tap\.config\.js', 'scripts\/tap-shim\.js'\)/,
    '兜底前缀的配置指纹必须含 `scripts/tap-shim.js`（A6）：主 key 未命中时由兜底恢复 inc，只把 shim 加进 key' +
    '不够——缺了它，shim 变更后兜底仍会把按旧归因算出的 inc 恢复进来复用')
  assert.match(restoreKeys[0], /-deps-\$\{\{\s*hashFiles\('package-lock\.json'\)\s*\}\}-/,
    '兜底前缀必须含与 key **同一个** `-deps-$' + '{' + '{ hashFiles(\'package-lock.json\') }}-` 依赖指纹段' +
    '（本轮新不变式：兜底前缀 = 缓存身份里除源指纹以外的全部段 ⇒ 兜底只允许跨源文件变化）：旧形态只把 ' +
    'package-lock.json 放进主 key，dependabot 升 fast-check 4.10.0→4.10.1 后主 key miss、兜底把旧 inc 复原，' +
    '而 incremental-differ 只按文件内容 diff、不认识依赖版本 ⇒ 19/19 段 100% 复用（实测 run 35775812104 / issue #167）')
  assert.ok(!restoreKeys[0].includes('-src-'),
    '兜底前缀不得含 `-src-` 源指纹段：兜底存在的意义是**只**跨源文件变化复用（incremental-differ 按文件内容 diff），' +
    '带上 src 段就等于永不兜底（主 key miss 时无可恢复）或按旧形态跨源继承；配置（matrix.config 档位 / ' +
    'stryker.config.js / stryker.tap.config.js / scripts/tap-shim.js）与依赖（package-lock.json）的任何变化 ' +
    '都必须同时换掉主 key 与兜底身份，即缓存身份里**除源指纹以外的全部段**都必须出现在兜底前缀里。' +
    '`run_mutation.js` 是**本地**运行器：CI 的变异任务走 stryker（`scripts/mutation-child.js` → ' +
    '`run_unit_tests.js`），**不经 run_mutation.js**（见 run_unit_tests.js 顶部说明），故它与 matrix.src ' +
    '同属源指纹、只进主 key 不进兜底；测试侧文件（test_suites.js / run_unit_tests.js / scripts/mutation-child.js / ' +
    'test_*.js）则**有意不入任何身份段**（PR #158 的取舍）⇒ 只改它们时缓存身份逐字节不变、command 档 4 段' +
    '仍会复用旧结果（当前为 `thresholds.break = null`，无分数门禁；复用状态另有日报可视化兜住）')
}
assertCacheConfigIdentity(mutationYml)

console.log('✅ 缓存身份门禁（assertCacheStep / assertCacheConfigIdentity）正向通过：纯字符串断言、不 spawn 子进程')

// ── 1. 清单自身必须干净 ─────────────────────────────────────
// 清单解析走字符串切片而非正则：`\S.*$` 这类重叠量词会被静态分析判为可回溯超线性（Sonar S8786）
const skipLine = testYml.split('\n').map(line => line.trim()).find(line => line.startsWith('SKIP_SUITES:'))
assert.ok(skipLine, 'test.yml 应声明 SKIP_SUITES')
const skips = skipLine.slice('SKIP_SUITES:'.length).split(',').map(s => s.trim()).filter(Boolean)
assert.ok(skips.length > 0, 'SKIP_SUITES 不应为空')

const byFile = new Map(SUITES.map(s => [s.file, s]))
for (const file of skips) {
  // 拼错的条目在 run_unit_tests.js 里已改为直接失败，这里再固化一次（错误更早暴露）
  assert.ok(byFile.has(file), `SKIP_SUITES 含不存在的套件 ${file}（拼错即静默失效）`)
  const suite = byFile.get(file)
  assert.ok(!suite.integration && !suite.mutationSkip,
    `SKIP_SUITES 的 ${file} 本就不进单元入口（integration/mutationSkip），该条无效`)
}

// ── 2. 与显式步骤双向对账 ───────────────────────────────────
const unitFiles = SUITES.filter(s => !s.integration && !s.mutationSkip).map(s => s.file)
// 显式步骤按「step 块」解析：带 if: 的步骤可能在本次运行中根本不执行（如「集成测试（串行完整版）」
// 仅在并行失败时跑），不能算作门禁覆盖——否则把某个套件的步骤挂上 `if: false` 也能骗过对账。
// 解析器对 YAML 排版变化保持稳健（本文件是门禁意图：红=提醒人工同步，常规排版变化不应误红）：
//   ① 步骤起点：`- name:` / `- uses:` / `- run:` / `- if:`（YAML 允许省略 name）均视为新 step 块；
//      `-` 后允许 1 个及以上空格（YAML 合法排版 `-  name:` / `-   run:`）；若只认恰好一个空格，
//      这类新 step 会被并进上一步，其后更深缩进的 `if:` 还会把「上一步」误标成 conditional → 对账误红；
//   ② run: 支持多行形式（块指示符 `|` / `>` 及其 chomp/显式缩进变体 `|-` `>-` `|+` `>-2` `|2` `|2-` `>1+` 等，
//      或 run: 后跟缩进更深的续行），命令文本合并后只提取
//      `npm run <script>` 命令名——解析不出命令名仍会红（那才是真正的门禁缺口），排版变化不再误红；
//   ③ 步骤内其它字段（uses/with/env/id/continue-on-error 等）不参与命令提取，也不破坏步骤归属；
//   ④ if: 仅在缩进比当前 step 起点更深时视为步骤级条件——job 级 if:（缩进更浅）不属任何 step，
//      避免把已覆盖的步骤误标为条件步骤而被对账忽略。
// 从命令文本中提取 `npm run <script>` 命令名（脚本名取首个 token，排除 shell 元字符，避免跨行吞并）；
// 提取不出任何命令名时该步骤对 explicitFiles 无贡献——缺失的覆盖最终仍会被下面对账断言拦下（保持红），
// 这里只负责「正常排版变化不误红」。
// 从命令文本中剔除引号段与行内注释，返回线性扫描后的命令串：
// 引号内的文本（echo "参考: npm run x" 这类诊断输出）不是命令；`#` 后的行内注释也不是。
// 用逐字符扫描而非 `"[^"]*"|'[^']*'` 交替正则——后者对含大量引号的输入存在超线性回溯面（Sonar S8786）。
function stripQuotesAndComment (line) {
  let out = ''
  let quote = ''
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      break
    } else {
      out += ch
    }
  }
  return out
}
function collectNpmScripts (step, commandText) {
  // 只认真实命令：注释行（`# npm run x`）与行内注释（`npm run foo # 说明` 的 # 后部分）不是命令，
  // 引号内的文本（echo "参考: npm run x" 这类诊断输出）也不是命令——提取前剔除，避免对账被虚假满足。
  for (const raw of commandText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const cmd = stripQuotesAndComment(line)
    for (const m of cmd.matchAll(/\bnpm run ([A-Za-z0-9_.:@/-]+)/g)) step.scripts.push(m[1])
  }
}

// 把 test.yml 的「步骤 → npm run 脚本名」解析抽成可复用函数：主流程对账与下面 dummy 文本的
// 回归断言共用同一解析器，避免两份口径漂移。#131 qodo #2 要求对 runLines 多行块 / EOF 补结算 /
// 注释剔除补齐回归覆盖。
function parseWorkflowSteps (text) {
  const steps = []
  let curStep = null
  let runLines = null // 正在累积的 run: 多行块内容（null = 不在块内）
  let runIndent = -1 // 进入块模式时 run: 键的缩进；续行缩进必须更深，回退到 <= runIndent 即块结束
  // YAML 块标量指示符 = [|>] + 可选显式缩进数字(1-9) + 可选 chomp [-+]，两种顺序都合法：
  //   chomp 在前 `|` `>` `|-` `>-` `|+` `>-2` …；数字在前 `|2` `|2-` `>1+` …。
  //   #132 review Q1：旧正则 /^[|>][-+]?\d*$/ 只认 chomp 在前，`|2-` `>1+` 这类数字在前的
  //   变体被当普通行 → 后续命令行丢失（对账误报）。显式缩进指示符按 YAML 规范仅单数字（1-9）：
  //   两个分支都收窄到 [1-9]（chomp 可选、数字可选，但顺序只有 <chomp><数字> 与 <数字><chomp>），
  //   多位数与 `0` 一律不进块模式——旧码 `[-+]?\d*` 会 MATCH `|-12` `|+20` `|0`，与上述口径矛盾。
  // 识别不进块模式的形态一律按单行命令文本处理——单行文本提取不出命令名时该步骤不贡献 scripts，
  // 对账保持红（宁红勿绿）：任何未识别变体只会加重门禁，不会静默放行。
  const blockIndicatorRe = /^[|>](?:[-+]?[1-9]?|[1-9][-+]?)$/
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const indent = line.length - line.trimStart().length
    if (runLines !== null) {
      if (indent > runIndent) { // run: 多行块的续行
        runLines.push(trimmed)
        continue
      }
      collectNpmScripts(curStep, runLines.join('\n')) // 缩进回退：块结束，结算已收集的命令
      runLines = null
    }
    if (/^- +(?:name|uses|run|if):/.test(trimmed)) {
      curStep = { indent, conditional: /^- +if:/.test(trimmed), scripts: [] }
      steps.push(curStep)
      const inlineRun = trimmed.match(/^- +run: ?(.+)$/)
      if (inlineRun) {
        // 捕获组先 trim 并剔除行内注释：`- run:   |`（run: 后多个空格）旧码不 trim，前导空格使块指示符
        // 判定失败 → 后续命令行丢失（对账误报）；`- run: | # 注释`（指示符 + 行内注释）同一路径。
        const inlineRest = stripQuotesAndComment(inlineRun[1]).trim()
        if (blockIndicatorRe.test(inlineRest)) {
          // 紧凑块写法 `- run: |` / `- run: >` 及其 chomp/显式缩进变体（`|-` `>-` `|+` `>-2` 等）：
          // 块模式此前只认 '|' / '>' 两个字面值，`- run: |-` 之类会把后续命令行当普通行忽略 →
          // 命令丢失（对账误报）。统一用块指示符正则判定；不匹配的 rest 走单行命令文本（宁红勿绿）。
          runLines = []
          runIndent = indent
        } else {
          collectNpmScripts(curStep, inlineRest) // `- run: npm run X` 单行简写也识别
        }
      }
      continue
    }
    if (!curStep) continue
    if (trimmed.startsWith('if:') && indent > curStep.indent) curStep.conditional = true
    if (trimmed.startsWith('run:')) {
      // rest 先剔除行内注释再 trim：`run: | # 注释` 旧码拿到 `| # 注释` → 判定不是块指示符 →
      // 后续命令行丢失（对账误报）。空值判定仍用剔除前的 rawRest：`run: # 注释`（无指示符、仅注释）
      // 不因此从「按单行处理」变成块模式——不扩大放行面（宁红勿绿）。
      const rawRest = trimmed.slice('run:'.length).trim()
      const rest = stripQuotesAndComment(rawRest).trim()
      if (!rawRest || blockIndicatorRe.test(rest)) {
        // 键形式 `run:`：rest 为空（纯块）或为块指示符（含 `|-` `>-` 等变体，而非仅 '|' / '>'）→ 块模式；
        // rest 为具体命令（如 `npm run X`）仍按单行处理；未识别的 rest 形态按单行 → 提取不出命令即保持红
        runLines = [] // 块模式：后续缩进更深的行均为命令文本
        runIndent = indent
      } else {
        collectNpmScripts(curStep, rest)
      }
    }
  }
  // 文件末尾的 run: 多行块：循环内只在缩进回退时结算，最后一步是块时必须在此补一次结算
  if (runLines !== null) collectNpmScripts(curStep, runLines.join('\n'))
  return steps
}

const steps = parseWorkflowSteps(testYml)
const explicitFiles = new Set()
for (const step of steps) {
  if (step.conditional) continue
  for (const script of step.scripts) {
    const cmd = pkg.scripts[script]
    const file = cmd && cmd.match(/node (\S+\.js)/)
    if (file) explicitFiles.add(path.basename(file[1]))
  }
}
assert.ok(explicitFiles.size > 0, '应从 test.yml 解析出显式测试步骤')
const byName = (a, b) => a.localeCompare(b) // 显式比较函数：默认 sort 的字符串序不保证稳定可预期（Sonar S2871）
assert.deepStrictEqual(skips.slice().sort(byName), unitFiles.filter(f => explicitFiles.has(f)).sort(byName),
  'SKIP_SUITES 必须等于「显式步骤已覆盖的单元套件」：漏写会重复跑，多写会漏跑（门禁盲区）')

// #131 qodo #2：runLines 多行块 / EOF 补结算 / 注释剔除的回归断言。
// 用 dummy workflow 文本驱动同一解析器 parseWorkflowSteps，验证 scripts 收集正确——不依赖真实
// test.yml（那是主对账的输入，这里专测解析边界）：
//   1. `run: |` 块内两行各提取一个 npm run（多行块内逐行提取）
//   2. 注释行（`# npm run ghost`）与行内注释（`npm run ... # 说明`）不进 scripts
//   3. 引号内的文本（echo "npm run notcmd"）不进 scripts
//   4. `run: |` 块放在文本真正末尾、且无尾随换行（EOF 补结算路径）仍能收集齐其命令
//      ——必须保持「末尾块」地位：#132 review Q3 把该用例移回 dummy 真正末尾（此前 SA-B 把
//      新步骤追加在它后面，最后一步成了不进块模式的 `|+bad`——EOF 补结算分支根本没被走到，
//      该分支被删/破坏时测试照样绿，回归失去意义）
//   5. `run: >` 折叠块、`if:` 条件步骤标记正确（conditional）以备对账忽略
// #131 审查遗留（问题4）：块指示符变体的回归用例——
//   6. `- run: |-` 行内 chomp 块：块内注释/引号剔除，只收真实命令
//   7. `run: >-` 键形式折叠 chomp 块：命令仍被提取
//   8. `- run: >+2` 显式缩进指示符变体：命令仍被提取
// #132 review Q1：数字在前、chomp 在后的指示符变体（YAML 规范允许两种顺序，旧正则漏识别）——
//   9. `- run: |2-`（行内数字+chomp）与 `run: >1+`（键形式数字+chomp 折叠块）各一个：
//      命令仍被提取，块内注释/引号剔除仍生效
//   10. 失败方向安全：无法识别的指示符（`- run: |+bad`）按单行命令文本处理、不进入块模式，
//       提取不出命令名即该步骤 scripts 为空（宁红勿绿——缺失的覆盖仍会被主对账断言拦下）
{
  const dummy = [
    'name: dummy',
    'on: push',
    'jobs:',
    '  test:',
    '    steps:',
    '      - name: 多行块',
    '        run: |',
    '          npm run test:unit',
    '          # npm run ghost',
    '          npm run test:notify # 行内说明',
    '          echo "npm run quoted-not-cmd"',
    '      - name: 折叠块',
    '        run: >',
    '          npm run test:app',
    '      - if: false',
    '        run: npm run test:loop',
    '      - run: |-',
    '          npm run test:rules',
    '          # npm run ghost2',
    '          echo "npm run quoted-not-cmd2"',
    '      - name: 键折叠chomp块',
    '        run: >-',
    '          npm run test:app_p',
    '      - run: >+2',
    '          npm run test:status',
    '      - run: |2-',
    '          npm run test:digitchomp',
    '          # npm run ghost-digitchomp',
    '          echo "npm run quoted-digitchomp"',
    '      - name: 数字前chomp折叠块',
    '        run: >1+',
    '          npm run test:folddigitchomp',
    '          # npm run ghost-folddigitchomp',
    '      - run: |+bad',
    '          npm run test:ghost3',
    '      - name: 末尾块无尾随换行',
    '        run: |',
    '          npm run test:filter'
  ].join('\n') // 故意不补末尾 \n：验证 EOF 补结算（本用例必须是真正最后一个步骤）
  const dummySteps = parseWorkflowSteps(dummy)
  // 步骤数：name多行块 / 折叠块 / if条件 / 行内chomp块 / 键折叠chomp块 / 显式缩进指示符块 /
  // 数字在前chomp变体(|2- >1+)x2 / 未识别指示符(宁红勿绿) / 末尾块(EOF补结算) = 10
  assert.strictEqual(dummySteps.length, 10, 'dummy 应解析出 10 个步骤')
  assert.deepStrictEqual(dummySteps[0].scripts, ['test:unit', 'test:notify'],
    'run:| 块应逐行提取脚本，注释行(# npm run ghost)与行内注释(npm run test:notify #…)与引号文本均剔除')
  assert.deepStrictEqual(dummySteps[1].scripts, ['test:app'], 'run:> 折叠块应提取 test:app')
  assert.strictEqual(dummySteps[2].conditional, true, 'if: 步骤应标记 conditional（对账时忽略）')
  assert.deepStrictEqual(dummySteps[2].scripts, ['test:loop'], '条件步骤仍应解析出其脚本')
  assert.deepStrictEqual(dummySteps[3].scripts, ['test:rules'],
    '- run: |- 行内 chomp 块应提取真实命令，块内注释(# npm run ghost2)与引号文本(echo "npm run quoted-not-cmd2")剔除')
  assert.deepStrictEqual(dummySteps[4].scripts, ['test:app_p'], 'run: >- 键形式折叠 chomp 块应提取 test:app_p')
  assert.deepStrictEqual(dummySteps[5].scripts, ['test:status'], '- run: >+2 显式缩进指示符变体应提取 test:status')
  assert.deepStrictEqual(dummySteps[6].scripts, ['test:digitchomp'],
    '- run: |2- 数字在前 chomp 在后变体应进入块模式并提取命令，块内注释/引号剔除仍生效')
  assert.deepStrictEqual(dummySteps[7].scripts, ['test:folddigitchomp'],
    'run: >1+ 键形式数字在前 chomp 在后变体应进入块模式并提取命令，块内注释剔除仍生效')
  assert.deepStrictEqual(dummySteps[8].scripts, [],
    '未识别的块指示符(- run: |+bad)不得进入块模式，其后行不收集 → scripts 为空（宁红勿绿）')
  assert.deepStrictEqual(dummySteps[9].scripts, ['test:filter'],
    '真正位于文本末尾的 run:| 块（无尾随换行）应经 EOF 补结算提取 test:filter')
  // 注释/引号不应污染任何步骤的 scripts
  const allScripts = dummySteps.flatMap(s => s.scripts)
  assert.ok(!allScripts.includes('ghost'), '注释中的命令名不应进入 scripts')
  assert.ok(!allScripts.includes('ghost2'), 'chomp 块内注释中的命令名不应进入 scripts')
  assert.ok(!allScripts.includes('ghost-digitchomp'), '|2- 块内注释中的命令名不应进入 scripts')
  assert.ok(!allScripts.includes('ghost-folddigitchomp'), '>1+ 块内注释中的命令名不应进入 scripts')
  assert.ok(!allScripts.includes('quoted-not-cmd'), '引号内的文本不应进入 scripts')
  assert.ok(!allScripts.includes('quoted-not-cmd2'), 'chomp 块内引号中的文本不应进入 scripts')
  assert.ok(!allScripts.includes('quoted-digitchomp'), '|2- 块内引号中的文本不应进入 scripts')
  assert.ok(!allScripts.includes('ghost3'), '未识别指示符的后继行不得进入 scripts（宁红勿绿）')
  console.log('✅ dummy workflow 解析断言通过（多行块/EOF补结算/注释剔除/if条件/chomp与显式缩进指示符/数字在前变体）')
}

// S4 追加块：B5/D4 两处修复的定点回归。
// 上方 dummy 的 10 个 step 在「修复前 / 修复后」判定完全一致（全是 `- ` 单空格、rest 无 `#`、指示符全是
// chomp 在前的合法单数字形态），因此锁不住本次改动——把 `- +` 改回 `- `、把 `[1-9]` 改回 `\d*`，上面所有
// 断言依旧全绿。本块另起一份独立 mini 文本（不改动上方 dummy 的文本、步骤数、索引与末尾块 EOF 地位）专锁：
//   ① D4：`-` 后 2/3 空格的步骤起点必须被识别（旧码只认恰好一个空格 → 前 10 个 step 全无归属，
//      整段只解析出 5 个 step，且这 10 个块里的命令行全部丢失）；
//   ② B5：`- run:   |`（run: 后 3 空格，内联捕获组需 trim）与 `run: | # 注释`（键形式 + 行内注释）必须进块模式；
//   ③ B5：`|-12` `|+20` `|0` 必须不进块模式（旧码 MATCH → 会把其后的命令行收进来 = 静默放行方向）；
//   ④ 正向锁定 10 种仍须 MATCH 的指示符：| > |- >- |+ >+2 >-2 |2 |2- >1+；
//   ⑤ `run: # 注释`（无指示符、仅注释）必须保持「按单行处理」——锁的是「未来把空值判定从 rawRest 放宽回
//      rest」这类放宽型回归（放宽后该 step 会进块模式并收走下方命令）。
{
  const mini = [
    'jobs:',
    '  t:',
    '    steps:',
    '      -  run:   |',
    '          npm run mini:block-pipe',
    '      -   run: >',
    '          npm run mini:block-fold',
    '      -  run: |-',
    '          npm run mini:block-pipe-strip',
    '      -   run: >-',
    '          npm run mini:block-fold-strip',
    '      -  run: |+',
    '          npm run mini:block-pipe-keep',
    '      -   run: >+2',
    '          npm run mini:block-fold-keep2',
    '      -  run: >-2',
    '          npm run mini:block-fold-strip2',
    '      -   run: |2',
    '          npm run mini:block-pipe2',
    '      -  run: |2-',
    '          npm run mini:block-pipe2-strip',
    '      -   run: >1+',
    '          npm run mini:block-fold1-keep',
    '      - name: 键形式指示符带行内注释',
    '        run: | # 指示符后的行内注释',
    '          npm run mini:block-key-comment',
    '      - name: 仅注释无指示符（不得进块模式）',
    '        run: # 行内注释',
    '          npm run mini:must-not-collect',
    '      - run: |-12',
    '          npm run mini:ghost-12',
    '      - run: |+20',
    '          npm run mini:ghost-20',
    '      - run: |0',
    '          npm run mini:ghost-0'
  ].join('\n')
  const miniSteps = parseWorkflowSteps(mini)
  // 逐 step 期望值：前 10 个是 10 种指示符变体（各自进块并收集 1 条命令），第 11 个是键形式 + 行内注释
  // （进块），第 12 个「仅注释」与第 13-15 个多位数/0 都不进块 → scripts 为空，其后命令行不得被收集。
  const miniCases = [
    { form: '-  run:   |', scripts: ['mini:block-pipe'] },
    { form: '-   run: >', scripts: ['mini:block-fold'] },
    { form: '-  run: |-', scripts: ['mini:block-pipe-strip'] },
    { form: '-   run: >-', scripts: ['mini:block-fold-strip'] },
    { form: '-  run: |+', scripts: ['mini:block-pipe-keep'] },
    { form: '-   run: >+2', scripts: ['mini:block-fold-keep2'] },
    { form: '-  run: >-2', scripts: ['mini:block-fold-strip2'] },
    { form: '-   run: |2', scripts: ['mini:block-pipe2'] },
    { form: '-  run: |2-', scripts: ['mini:block-pipe2-strip'] },
    { form: '-   run: >1+', scripts: ['mini:block-fold1-keep'] },
    { form: 'run: | # 行内注释（键形式）', scripts: ['mini:block-key-comment'] },
    { form: 'run: # 行内注释（无指示符）', scripts: [] },
    { form: '- run: |-12', scripts: [] },
    { form: '- run: |+20', scripts: [] },
    { form: '- run: |0', scripts: [] }
  ]
  assert.strictEqual(miniSteps.length, 15,
    'mini dummy 应解析出 15 个步骤（10 种指示符变体 + 键形式带注释 + 仅注释 + 3 个应拒绝的非法指示符）')
  miniCases.forEach((c, i) => {
    assert.deepStrictEqual(miniSteps[i].scripts, c.scripts,
      `mini step ${i}（${c.form}）的 scripts 应为 ${JSON.stringify(c.scripts)}；不进块模式时其后命令行不得被收集（宁红勿绿）`)
  })
  const miniAll = miniSteps.flatMap(s => s.scripts)
  assert.ok(!miniAll.includes('mini:must-not-collect'),
    '`run: # 注释`（无指示符、仅注释）必须按单行处理，不得进块模式收走后续命令')
  assert.ok(!miniAll.includes('mini:ghost-12'), '多位数指示符 |-12 不得进块模式（旧码会误收其后命令 → 已收紧）')
  assert.ok(!miniAll.includes('mini:ghost-20'), '多位数指示符 |+20 不得进块模式（旧码会误收其后命令 → 已收紧）')
  assert.ok(!miniAll.includes('mini:ghost-0'), '缩进指示符 |0 非法（仅 1-9），不得进块模式（旧码会误收其后命令 → 已收紧）')
  console.log('✅ mini 定点回归通过（D4 多空格起点 / B5 指示符 rest trim+剔注释 / 多位数与 0 拒绝 / 10 种指示符正向锁定）')
}

// 2b. integration/mutationSkip 套件被 run_unit_tests.js 排除，只能靠显式步骤进门禁 ——
//     漏一个就是门禁盲区（test_suites.js 注释写明「历史上多次发生」）
const excluded = SUITES.filter(s => s.integration || s.mutationSkip).map(s => s.file)
const uncovered = excluded.filter(f => !explicitFiles.has(f))
assert.deepStrictEqual(uncovered, [],
  `以下 integration/mutationSkip 套件没有 CI 显式步骤，脱离门禁：${uncovered.join(', ')}`)

// ── 2c. test.yml 的 push `paths-ignore` 不得收缩门禁（EXEC-D T3）──────
// 动机：docs-only push 此前也会跑满整条链（~6.5min × 2 runner）。放宽 push 触发范围可以让纯文档
// 提交不再触发，但**硬约束**是：paths-ignore 只能放行「改了它也绝不可能影响测试结果」的路径。
// 本仓库最容易被一刀切忽略掉的门禁输入是 CHANGELOG.md——`**/*.md` 会连它一起忽略，而它是
// check-version.js 的版本一致性闸门、test_filter.js 第 101 章、test_tag_validator.js 的输入。
// 故本段把口径固定为断言：任何门禁输入被 paths-ignore 覆盖即红（防后人顺手写回 `**/*.md`）。
{
  // 解析 `on.push.paths-ignore`（行式解析 + 响亮失败：排版一变就红，不会静默放行）
  const lines = testYml.split('\n')
  const pushIdx = lines.findIndex(l => l === '  push:')
  assert.ok(pushIdx >= 0, 'test.yml 应声明 push 触发（缩进 2 空格的 `  push:`）')
  let piIdx = -1
  const pathsIgnore = []
  for (let i = pushIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= 2) break // 离开 push 块
    if (piIdx < 0) {
      if (!line.trim().startsWith('paths-ignore:')) continue
      piIdx = i
      continue
    }
    const item = line.trim()
    if (!item.startsWith('- ')) break // paths-ignore 列表结束
    let val = item.slice(2).trim()
    // 去行内注释与引号（路径里不会出现 '#' 或引号）
    const hash = val.indexOf(' #')
    if (hash > 0) val = val.slice(0, hash).trim()
    val = val.replace(/^(['"])(.*)\1$/, '$2')
    assert.ok(val !== '', `paths-ignore 条目不应为空: ${JSON.stringify(line)}`)
    pathsIgnore.push(val)
  }
  assert.ok(pathsIgnore.length > 0, 'push 触发应有非空 paths-ignore（否则本断言失去守护对象）')

  // gitignore/minimatch 子集匹配器（只需支持本仓库实际会用的形态：字面路径、`**/*.ext`、`dir/**`）
  const toRe = (p) => {
    let re = ''
    for (let i = 0; i < p.length; i++) {
      const c = p[i]
      if (c === '*') {
        if (p[i + 1] === '*') { // `**` → 任意层级
          if (p[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2 } else { re += '.*'; i += 1 }
        } else re += '[^/]*'
      } else if (c === '?') re += '[^/]'
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp('^' + re + '$')
  }
  const matchers = pathsIgnore.map(p => ({ p, re: toRe(p) }))
  const matchedBy = (rel) => matchers.filter(m => m.re.test(rel)).map(m => m.p)

  // 匹配器自身的正向对照（防恒假：判据必须能认出 `**/*.md` 会命中 CHANGELOG.md）
  assert.deepStrictEqual(matchedBy('CHANGELOG.md'), [],
    'paths-ignore 不得命中 CHANGELOG.md：它是 check-version.js 版本闸门与 test_filter.js 第 101 章的输入')
  assert.ok(toRe('**/*.md').test('CHANGELOG.md') && toRe('**/*.md').test('docs/a.md'),
    '匹配器对照：`**/*.md` 必须能命中 CHANGELOG.md（否则本断言恒真、形同虚设）')
  assert.ok(!toRe('dir/**').test('dir') && toRe('dir/**').test('dir/a/b.js'), '匹配器对照：`dir/**` 应命中目录内部文件')

  // 显式「允许被忽略」清单：纯文档（无任何脚本/测试读取）+ 未入库的本机目录 + 议题模板
  const PROSE_DOCS = new Set([
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SYSTEM_CONTRACT.md',
    '.github/pull_request_template.md'
  ])
  const ALLOWED_PREFIXES = ['.local/', '.github/ISSUE_TEMPLATE/']
  // 允许出现的 paths-ignore 条目白名单：新增条目必须同时改这里（有意为之的 fail-loud）——
  // 否则一个手滑的 `**/*.js` 会静默把整条门禁关掉。
  const ALLOWED_PATTERNS = new Set([...PROSE_DOCS, '.github/ISSUE_TEMPLATE/**', '.local/**'])
  for (const p of pathsIgnore) {
    assert.ok(ALLOWED_PATTERNS.has(p),
      `paths-ignore 出现未登记的条目 ${JSON.stringify(p)}：请先确认改了该路径不可能影响测试结果，` +
      '并同步本套件的 ALLOWED_PATTERNS（源码/测试/工作流/门禁输入一律不得放行）')
  }

  // 遍历仓库文件（跳过依赖与运行产物），要求：**除允许清单外，没有任何文件被 paths-ignore 命中**
  const SKIP_DIRS = new Set(['node_modules', '.git', 'reports', 'coverage', '.stryker-tmp', '.tools', '.ai'])
  const walk = (dir, rel, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('xianbaoku_cache') || e.name.startsWith('.xbk_cache_safe')) continue
        walk(path.join(dir, e.name), rel + e.name + '/', out)
      } else if (e.isFile()) out.push(rel + e.name)
    }
    return out
  }
  const files = walk(__dirname, '', [])
  assert.ok(files.includes('test_ci_skip_suites.js') && files.includes('CHANGELOG.md'),
    '仓库遍历应包含已知门禁输入（遍历失败会让本断言恒真）')
  const allowed = (f) => PROSE_DOCS.has(f) || ALLOWED_PREFIXES.some(pre => f.startsWith(pre))
  const violators = files.filter(f => !allowed(f) && matchedBy(f).length > 0)
  assert.deepStrictEqual(violators, [],
    `paths-ignore 命中了非文档路径（门禁盲区）：${violators.slice(0, 10).map(f => `${f} ← ${matchedBy(f).join(',')}`).join(' | ')}`)
  console.log(`✅ push paths-ignore（${pathsIgnore.length} 项）只覆盖纯文档/议题模板/本机目录，未命中任何门禁输入（${files.length} 个文件已核对）`)
}

// ── 3. 入口行为（子进程 + 跳过全部套件，秒级） ───────────────
const baseEnv = { ...process.env }
delete baseEnv.SKIP_SUITES
delete baseEnv.XBK_MUTATION_CHILD
function runEntry (env) {
  return spawnSync(process.execPath, [path.join(__dirname, 'run_unit_tests.js')],
    { encoding: 'utf8', cwd: __dirname, env: { ...baseEnv, ...env } })
}
const skipAll = unitFiles.join(',') // 跳过全部单元套件 → 零套件守卫直接非 0（见 3f），不执行任何套件
// 只留一个免依赖的快套件（test_check_deps.js）：需要「真的跑一个套件」的用例（summary 写入、输出超限）
// 用它秒级收尾——过滤后为零套件已被 3f 固定为非 0，不能再拿它当「快速跑完」的挡箭牌。
const skipAllButOne = unitFiles.filter(f => f !== 'test_check_deps.js').join(',')

// ── 并发假杀隔离：summary 落点必须按进程唯一（PR #158）──────────────────────────
// Stryker 一次 run 只建**一个**沙箱目录：`--concurrency 8` 时 8 个测试 worker 共用同一份 cwd，于是任何
// **仓库相对**的共享可写路径都会被并发 worker 写→读→删互相踩。本段原先用固定的「reports/ + 固定名」做
// summary 落点（子进程写入 → 本进程立即读回 → finally 删除），CI 实测（C=8）出现过：
//   Error: ENOENT: no such file or directory, open '<那个固定落点>'（读回处）
// 逐字成因：同族 worker 的 finally 删除落在本 worker 的「写完 → 读回」之间。套件因此崩、命令 runner 按
// 退出码判 Killed，把与该变异体**无关**的结果打成假 Killed。
// 修法与 test_filter.js / test_app.js 的 `xianbaoku_cache_p<XBK_PARALLEL_ID|pid>` 同源：落点按进程唯一。
// **断言语义一字不改**——断的是「写入 → 读回 → 删除」的行为与内容（前缀 `## 单元测试结果`、`共 1 套件`），
// 不是文件名；下面没有任何断言依赖固定文件名。「唯一后缀必须还在」这件事由本段末尾的并发回归 + 断言锁定。
// 唯一化规则的**单点定义**：真实落点与下方并发回归夹具都从这一个模板派生——把 `.p<pid>` 去掉会让两边
// 同时退回共享路径，回归因此真红。占位符用 `<stem>`/`<pid>` 而不是 `${…}`：后者写在字符串里会被 standard 的
// no-template-curly-in-string 判红（不是靠 eslint-disable 压规则）。
const CI_SUMMARY_PATH_TEMPLATE = 'reports/<stem>.p<pid>.md'
const ciSummaryPath = (pid, stem) => CI_SUMMARY_PATH_TEMPLATE.replace('<stem>', stem).replace('<pid>', String(pid))
const ciSummaryCheck = ciSummaryPath(process.pid, '.ci-summary-check') // reports/.ci-summary-check.p<pid>.md
const ciSummaryOverflow = ciSummaryPath(process.pid, '.ci-summary-overflow') // reports/.ci-summary-overflow.p<pid>.md
// 3c 的反面夹具要指到一个**不存在**的目录（真去写就 ENOENT）：同样带 pid 后缀——否则并发 worker 遗留的
// 同名目录会让「没写」这条断言静默失去意义（夹具自身失效 ⇒ 断言恒真）。
const ciMissingFile = `reports/.ci-missing-dir.p${process.pid}/.ci-summary-child.md`

fs.mkdirSync('reports', { recursive: true }) // reports/ 已被 .gitignore 忽略，用作 summary 落点
try {
  // 3a 拼错的条目必须炸（修复前是静默照跑全量）
  const unknown = runEntry({ SKIP_SUITES: 'test_not_exist.js' })
  assert.notStrictEqual(unknown.status, 0, 'SKIP_SUITES 含未知套件必须非 0 退出')
  assert.match(unknown.stderr, /test_not_exist\.js/, '错误应点名未知套件')

  // 3b CI 下写 summary（验证过滤生效：跳过其余套件 → 只剩 test_check_deps.js 一个）
  const filtered = runEntry({ SKIP_SUITES: skipAllButOne, GITHUB_STEP_SUMMARY: ciSummaryCheck })
  assert.strictEqual(filtered.status, 0, filtered.stderr || filtered.stdout)
  assert.match(filtered.stdout, /共 1 个套件/, '只剩一个套件时应报告 1 个')
  const summary = fs.readFileSync(ciSummaryCheck, 'utf8')
  assert.match(summary, /^## 单元测试结果/m, 'CI 下应写入 job summary')
  assert.match(summary, /共 1 套件/, 'summary 套件数应与实际执行数一致')

  // 3c 变异子进程必须不写 summary：把落点指到不存在的目录，真去写就会 ENOENT 崩掉 ——
  //    因此「exit 0 且 stderr 无 ENOENT」即证明没有发生写入
  assert.ok(!fs.existsSync(path.dirname(ciMissingFile)),
    `夹具前提：${path.dirname(ciMissingFile)} 不应存在（它存在就让「没写 summary」这条断言恒真）`)
  const child = runEntry({
    SKIP_SUITES: skipAllButOne,
    GITHUB_STEP_SUMMARY: ciMissingFile,
    XBK_MUTATION_CHILD: '1'
  })
  assert.strictEqual(child.status, 0, child.stderr || child.stdout)
  assert.ok(!/ENOENT/.test(child.stderr || ''), 'XBK_MUTATION_CHILD=1 时不得尝试写 job summary')

  // 3e 输出超限（ENOBUFS）必须标注为「输出超限」而不是普通测试失败：
  //    XBK_UNIT_MAX_BUFFER 仅测试注入；留一个必输出内容的套件、把上限压到 1 字节
  const overflow = runEntry({
    SKIP_SUITES: skipAllButOne,
    GITHUB_STEP_SUMMARY: ciSummaryOverflow,
    XBK_UNIT_MAX_BUFFER: '1'
  })
  assert.notStrictEqual(overflow.status, 0, '输出超过 maxBuffer 的套件应判定失败')
  assert.match(overflow.stdout, /::error title=输出超限/, '失败原因必须标注为输出超限（非测试失败）')

  // 3f 零套件必须非 0（UT-01 守卫回归）：SKIP_SUITES 覆盖全部单元套件时，修复前入口报
  //    「共 0 个套件 / 全部通过 🎉」并 exit 0，连本套件（唯一的 SKIP_SUITES 对账守护）都会被同一变量
  //    一起跳过而无人告警——这正是门禁整步假绿的形态，必须固定为失败。
  const zero = runEntry({ SKIP_SUITES: skipAll })
  assert.notStrictEqual(zero.status, 0, 'SKIP_SUITES 过滤后为空必须非 0 退出（零套件不等于通过）')
  assert.match(zero.stderr, /没有可执行的单元套件/, '错误应点名「过滤后没有可执行的单元套件」')
  assert.ok(!/全部通过/.test(zero.stdout), '零套件时不得输出「全部通过」')
} finally {
  // 只删**本进程自己的**落点（并发 worker 的落点文件名不同，互不可见）——清理不漏、也不误删别人
  fs.rmSync(ciSummaryCheck, { force: true })
  fs.rmSync(ciSummaryOverflow, { force: true })
}

// ── 3b-并发回归：共享落点的并发争抢必须被结构性排除（PR #158 的靶向锁）──────────────
// 真并发：1 个编排进程同时拉起 4 个 hammer 进程，各自用**上面同一份唯一化模板** + 自己的 pid 展开落点，
// 循环做「写 → 立即读回 → 删」（与本段 3b/finally 同构，只是轮次更多、窗口被抖动放大）：
//   · 唯一化在位 ⇒ 每条路径只属于一个进程，读回必然拿到自己写的内容（确定性绿，与调度无关）；
//   · 唯一化被去掉（模板退回共享路径）⇒ 4 个进程写/删同一条路径，读回撞上兄弟进程的删除 ⇒
//     ENOENT / 内容被覆盖（靶向回退实测真红；与 CI 在 C=8 下的残余假杀同一成因）。
// 不能用「同一进程内两份并发实例」：本套件是同步脚本、Node 单线程，同进程内做不出真并发；故用真实子进程。
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-ci-summary-probe-'))
  try {
    const hammer = [
      "'use strict'",
      "const fs = require('node:fs')",
      'const spec = JSON.parse(process.env.XBK_CI_SUMMARY_PROBE)',
      "const file = spec.template.replace('<stem>', spec.stem).replace('<pid>', String(process.pid))",
      'let failures = 0',
      'for (let i = 0; i < spec.rounds; i++) {',
      '  fs.writeFileSync(file, "pid=" + process.pid + " round=" + i + "\\n") // ← 3b：写 summary',
      '  // 抖动（相位按 pid 错开）：把「写完→读回」的窗口撑开，好让兄弟进程的删除/覆盖落进来',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (i * 7 + (process.pid % 5)) % spec.jitterMs)',
      '  try {',
      "    const back = fs.readFileSync(file, 'utf8') // ← 3b：立即读回（共享路径下这里就是 ENOENT 现场）",
      '    if (!back.startsWith("pid=" + process.pid + " ")) throw new Error("summary 被兄弟进程覆盖: " + back.trim())',
      '  } catch (e) {',
      '    failures++',
      '    if (failures === 1) console.error("[probe pid=" + process.pid + " round=" + i + "] " + (e.code || "ERR") + " " + e.message)',
      '  }',
      '  fs.rmSync(file, { force: true }) // ← finally：删自己的落点',
      '}',
      'process.exit(failures === 0 ? 0 : 1)',
      ''
    ].join('\n')
    fs.writeFileSync(path.join(probeDir, 'hammer.js'), hammer)
    // 编排进程：同时拉起 4 个 hammer 并聚合退出码（本套件是同步脚本、无 top-level await，故由被 spawn 的
    // 编排进程聚合）。hammer 走 process.execPath + 继承 env，与本文件其它 spawn 同口径。
    const runner = [
      "'use strict'",
      "const { spawn } = require('node:child_process')",
      'const procs = Number(process.env.XBK_CI_SUMMARY_PROCS) || 4',
      "let left = procs, failed = 0, firstErr = ''",
      'for (let k = 0; k < procs; k++) {',
      "  const p = spawn(process.execPath, [process.argv[1]], { stdio: ['ignore', 'ignore', 'pipe'] })",
      "  let err = ''",
      "  p.stderr.on('data', d => { err += d })",
      '  p.on("exit", (code, signal) => {',
      '    if (code !== 0) { failed++; if (!firstErr) firstErr = err.trim() || ("exit=" + code + " signal=" + signal) }',
      '    if (--left === 0) { if (firstErr) console.error(firstErr); process.exit(failed === 0 ? 0 : 1) }',
      '  })',
      '  p.on("error", e => { failed++; if (!firstErr) firstErr = e.message; if (--left === 0) process.exit(1) })',
      '}',
      ''
    ].join('\n')
    // rounds/jitter 取「回退必红、在位必绿」的最小成本档：本机实测共享路径下 5/5 真红（内容被覆盖或 ENOENT），
    // 唯一路径下恒绿；成本主要是 4 个子进程的 node 启动，与轮次基本无关，故不放大轮次（stryker 逐变异体都跑本套件）。
    const spec = JSON.stringify({ template: CI_SUMMARY_PATH_TEMPLATE, stem: '.ci-summary-check', rounds: 10, jitterMs: 2 })
    const probeRun = spawnSync(process.execPath, ['-e', runner, path.join(probeDir, 'hammer.js')], {
      encoding: 'utf8',
      cwd: __dirname,
      env: { ...baseEnv, XBK_CI_SUMMARY_PROBE: spec, XBK_CI_SUMMARY_PROCS: '4' }
    })
    assert.ok(!probeRun.error, `并发探针未能启动: ${probeRun.error && probeRun.error.message}`)
    assert.strictEqual(probeRun.status, 0,
      '多个并发进程在 summary 落点上发生争抢：落点必须按进程唯一。共享路径下的三种现场都算红——' +
      '① 读回 ENOENT（兄弟进程删了它，CI 的原始假杀形态）；② 内容被兄弟进程覆盖；③ 读回时撞上并发 unlink ' +
      '而崩（Node/libuv 在 ReadFileUtf8 上 abort，退出码非 0）\n' +
      `${probeRun.stderr || probeRun.stdout}`)
    assert.ok(!/ENOENT/.test(probeRun.stderr || ''), '并发争抢的现场证据里不得出现 ENOENT')
    console.log('✅ 并发隔离：4 进程 × 10 轮「写→读回→删」，0 争抢（落点模板 ' + CI_SUMMARY_PATH_TEMPLATE + '）')
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
  // 唯一性 + 静态双保险：真实落点必须带本进程 pid；固定共享字面量不得再出现（回退即红）。
  assert.ok(ciSummaryCheck.includes(`.p${process.pid}.md`) && ciSummaryOverflow.includes(`.p${process.pid}.md`),
    'summary 落点必须带 `.p<pid>.md` 唯一后缀（不带 = 退回共享路径 = 并发 worker 互相删读 ⇒ ENOENT 假 Killed）')
  assert.notStrictEqual(ciSummaryCheck, ciSummaryOverflow, '同进程内两个落点也必须互不相同')
  assert.ok(ciSummaryCheck !== ciSummaryPath(process.pid + 1, '.ci-summary-check'),
    '落点必须随 pid 变化（把 pid 从模板里去掉会让这条断言与并发探针同时红）')
  {
    const selfSrc = fs.readFileSync(__filename, 'utf8')
    // 拼出来而不是写字面量：否则「禁止的固定路径」会把自己所在的这一行判成违规（假红）
    const fixedPaths = ['reports/.ci-summary-check', 'reports/.ci-summary-overflow'].map(p => p + '.md')
    fixedPaths.push('reports/.ci-missing-dir' + '/')
    for (const fixed of fixedPaths) {
      assert.ok(!selfSrc.includes(fixed),
        `summary 落点不得退回固定共享路径 \`${fixed}\`：Stryker 一个 run 只建一个沙箱、--concurrency 8 时 ` +
        '8 个 worker 共用同一份 cwd，固定路径会被并发删读 ⇒ ENOENT 假 Killed')
    }
  }
}

// 3g run_tests.js 的零套件守卫（RT-01）、失败原因诊断（RT-02）与每套件超时（RT-03）回归：该入口全量跑
//    41 个套件（含网络/常驻），不能直接驱动；故在临时目录里搭一个最小沙箱（桩 test_suites.js + 桩
//    scripts/check-deps.js + 桩套件），只复制入口自身——与 test_run_mutation_internal.js 的
//    copyProject 手法同源。
function makeRunTestsSandbox (suites, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-run-tests-'))
  fs.copyFileSync(path.join(__dirname, 'run_tests.js'), path.join(dir, 'run_tests.js'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.writeFileSync(path.join(dir, 'scripts', 'check-deps.js'), 'module.exports = { checkDependencies: () => true }\n')
  fs.writeFileSync(path.join(dir, 'test_suites.js'), `module.exports = { SUITES: ${JSON.stringify(suites)} }\n`)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}
function runRunTestsIn (dir, env = {}, extra = {}) {
  return spawnSync(process.execPath, [path.join(dir, 'run_tests.js')], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, ...env },
    ...extra
  })
}
// 汇总行 ↔ run_mutation.js 解析口径的跨文件契约（UT-07），3g2 与 3h 共用同一解析实现
// （不另写一份正则，避免测试与生产口径漂移）。
const { extractTestSummary } = require('./run_mutation')

// 3g1 空注册表（SUITES=[]）必须非 0：修复前 allOk 初值 true → 「全部通过 🎉」并 exit 0（门禁假绿）
const emptyDir = makeRunTestsSandbox([])
try {
  const empty = runRunTestsIn(emptyDir)
  assert.notStrictEqual(empty.status, 0, 'SUITES 为空必须非 0 退出（零套件不等于通过）')
  assert.match(empty.stderr, /SUITES 为空/, '错误应点名 SUITES 为空')
  assert.ok(!/全部通过/.test(empty.stdout), 'SUITES 为空时不得输出「全部通过 🎉」')
} finally {
  fs.rmSync(emptyDir, { recursive: true, force: true })
}

// 3g2 失败原因必须落到输出（RT-02）：静默非零（exit 7）与被信号杀死（SIGKILL）在修复前都只有一行
//     「❌ … 失败」，两者无法区分；现要求 status / signal 进输出。
const diagDir = makeRunTestsSandbox(
  [
    { name: '静默非零', file: 'test_stub_exit7.js', desc: '不输出即 exit 7' },
    { name: '信号击杀', file: 'test_stub_sigkill.js', desc: '被 SIGKILL 杀死' }
  ],
  {
    'test_stub_exit7.js': 'process.exit(7)\n',
    'test_stub_sigkill.js': "process.kill(process.pid, 'SIGKILL')\n"
  }
)
try {
  const diag = runRunTestsIn(diagDir)
  assert.notStrictEqual(diag.status, 0, '失败套件必须非 0 退出')
  assert.match(diag.stdout, /status=7/, '静默非零退出（exit 7）必须把退出码打进输出')
  assert.match(diag.stdout, /signal=SIGKILL/, '被信号杀死的套件必须把 signal 打进输出')
  // RT-02/UT-07 同源锁定：run_tests.js 的汇总行也必须带「K 通过, M 失败, 共 N」三数字，
  // 否则 extractTestSummary 会命中更早的内层行（此沙箱里没有诱饵，修复前返回空数组）。
  assert.deepStrictEqual(extractTestSummary(diag.stdout), ['0', '2', '2'],
    'run_tests.js 汇总行必须被 extractTestSummary 识别（0 通过, 2 失败, 共 2）')
} finally {
  fs.rmSync(diagDir, { recursive: true, force: true })
}

// 3g3 每套件硬超时（RT-03）：套件挂死（死循环/等待不会到来的输入）时 execFileSync 永不返回，
//     入口既不汇总也不退出——CI 只能等作业级超时且没有红测定位。现要求入口按 XBK_TEST_TIMEOUT
//     强杀（killSignal=SIGKILL）并以失败收尾，且失败输出点名「超过每套件上限」（与断言红区分）。
//     测试侧仍加 30s spawnSync 兜底：修复被回退（无超时）时子进程会永久挂住，必须让本断言失败
//     而不是把整套件挂到作业级超时。
const hangDir = makeRunTestsSandbox(
  [{ name: '挂死套件', file: 'test_stub_hang.js', desc: '死循环永不退出' }],
  { 'test_stub_hang.js': 'while (true) {}\n' }
)
try {
  const t0 = Date.now()
  const hang = runRunTestsIn(hangDir, { XBK_TEST_TIMEOUT: '300' }, { timeout: 30000 })
  const elapsed = Date.now() - t0
  assert.strictEqual(hang.signal, null,
    '入口必须自行结束：被测试侧 30s 兜底杀掉（signal 非 null）说明每套件超时失效，入口仍在永久阻塞')
  assert.notStrictEqual(hang.status, 0, '挂死套件必须让入口以非 0 退出（零假绿）')
  assert.match(hang.stdout, /超过每套件上限 300ms 已强杀/, '失败输出必须点名每套件超时（与断言红区分）')
  assert.ok(elapsed < 20000, `入口应在每套件上限后很快结束（实测 ${elapsed}ms）`)
} finally {
  fs.rmSync(hangDir, { recursive: true, force: true })
}

// 3g4 每套件超时后的「整组杀伤」（F6）：3g3 只保证入口自身收敛，不保证套件派生的后代也停下。
//     桩套件 fork 一个继承 fd1 的孙进程（与 test_app_p.js 的并行调度同形：非 detached、stdio 继承 fd1），
//     自身挂死触发每套件超时。修复前只 kill 直接子进程 → 孙进程存活并继续持有继承的 stdout/stderr：
//     入口虽已退出，孤儿仍在跑（占 CPU / 端口 / 临时目录，污染后续套件），且**以管道捕获本入口**的调用方
//     （CI runner 收输出、spawnSync('pipe')、其它入口以 stdio:'pipe' 拉起）要等这个孤儿退出才拿到 close
//     ——实测父进程被拖到 30s 兜底才返回。故断言：入口退出后心跳文件不再增长（后代已被整组 SIGKILL 清掉）。
//     本用例把入口的 stdout/stderr 接到**真实文件**而不是管道，原因有二：① 管道会被孤儿持有，本用例在
//     修复前会挂到测试侧兜底超时（那是同一 bug 的另一个症状，但断言会退化成「超时」而非可读的失败）；
//     ② 文件 fd 仍如实复现「孙进程持有继承的 fd1」这一前提。
const treeDir = makeRunTestsSandbox(
  [{ name: '挂死套件（带孙进程）', file: 'test_stub_tree.js', desc: 'fork 继承 fd1 的孙进程后自身挂死' }],
  {
    'test_stub_tree.js': [
      "const { fork } = require('child_process')",
      "const path = require('path')",
      "fork(path.join(__dirname, 'stub_heartbeat.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })",
      'setInterval(() => {}, 1000)',
      ''
    ].join('\n'),
    'stub_heartbeat.js': [
      "const fs = require('fs')",
      "const path = require('path')",
      "const out = path.join(__dirname, 'heartbeat.txt')",
      "fs.writeFileSync(out, String(process.pid) + '\\n')",
      "setInterval(() => fs.appendFileSync(out, 'X'), 50)",
      ''
    ].join('\n')
  }
)
const treeOutPath = path.join(treeDir, 'entry.stdout.txt')
// CodeQL js/file-system-race（本仓库的**必需检查**）：同一条路径上「先 open（check）… 再按路径操作（use）」
// 是 check-then-use —— 检查与使用之间该路径可被换成另一个对象。该查询的 use 集合显式含 open/openSync 本身
// （见 codeql 查询 FileSystemRace.ql 的 FileUse：readFile(Sync)/writeFile(Sync)/appendFile(Sync)/open(Sync)），
// 所以「关掉写端后再 openSync(path,'r') 按路径二次打开、然后按新 fd 读」仍构成同一对（只是告警位置前移），
// 唯一清得掉判据的形态是：**全流程对这条路径只有一次按路径的访问**。故一次 open 用 'w+'（读写的同一个 fd）：
// 子进程继承的 fd1 仍是**真实文件**（3g4 的「孙进程持有继承 fd1」前提不变），之后只对 fd 做 fstatSync/readSync
// ——与 scripts/mutation-json.js 的「一次 open + 只对 fd 判定与读取」同口径。
const treeOutFd = fs.openSync(treeOutPath, 'w+')
const treeErrFd = fs.openSync(path.join(treeDir, 'entry.stderr.txt'), 'w')
let treePid = 0
try {
  let tree
  let treeOut
  const t0 = Date.now()
  try {
    tree = runRunTestsIn(treeDir, { XBK_TEST_TIMEOUT: '1500' }, { timeout: 30000, stdio: ['ignore', treeOutFd, treeErrFd] })
  } finally {
    // 子进程已退出且不再写：先按 fd 取真实大小，再从**位置 0** 显式读回。位置必须显式给 0——子进程继承的是
    // 同一个打开文件描述（dup），写完共享偏移停在 EOF，readFileSync(fd) 会从当前位置读回空串（本机实测）。
    // 分配量由 fstat 观测值决定、按 fd 有界读取，与 xbk_storage.js 的 readFdRange / scripts/mutation-json.js
    // 同口径；写入方已全部退出，读到的就是完整输出（断言语义不变）。
    try {
      const treeOutSize = fs.fstatSync(treeOutFd).size
      const treeOutBuf = Buffer.allocUnsafe(treeOutSize)
      let treeOutRead = 0
      while (treeOutRead < treeOutSize) {
        const n = fs.readSync(treeOutFd, treeOutBuf, treeOutRead, treeOutSize - treeOutRead, treeOutRead)
        if (n <= 0) break
        treeOutRead += n
      }
      treeOut = treeOutBuf.subarray(0, treeOutRead).toString('utf8')
    } finally {
      fs.closeSync(treeOutFd)
      fs.closeSync(treeErrFd)
    }
  }
  const elapsed = Date.now() - t0
  assert.strictEqual(tree.signal, null,
    `入口必须自行结束（被测试侧 30s 兜底杀掉说明入口未收敛，实测 ${elapsed}ms）`)
  assert.notStrictEqual(tree.status, 0, '超时的套件必须让入口以非 0 退出（fail-closed 语义不变）')
  assert.deepStrictEqual(extractTestSummary(treeOut), ['0', '1', '1'],
    '超时仍按失败结算：汇总三数字应与修复前一致（0 通过, 1 失败, 共 1）')
  assert.match(treeOut, /超过每套件上限 1500ms 已强杀/, '失败输出必须仍点名每套件超时（RT-03 口径不变）')
  const hb = path.join(treeDir, 'heartbeat.txt')
  treePid = Number(fs.readFileSync(hb, 'utf8').split('\n')[0])
  assert.ok(Number.isInteger(treePid) && treePid > 0, '孙进程应已写出自己的 pid（夹具自身生效的前提）')
  const sizeAfterExit = fs.statSync(hb).size
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700)
  const sizeLater = fs.statSync(hb).size
  assert.strictEqual(sizeLater, sizeAfterExit,
    `入口退出后孙进程仍在写心跳（${sizeAfterExit} → ${sizeLater} 字节）：每套件超时只杀了直接子进程，孤儿后代存活（F6）`)
  console.log(`✅ 每套件超时的整组杀伤：入口 ${elapsed}ms 收敛，退出后孙进程（pid ${treePid}）心跳停在 ${sizeAfterExit} 字节`)
} finally {
  // 孙进程若仍存活（修复被回退时）必须由本用例清掉，否则会污染后续套件与整轮测试
  if (treePid > 0) {
    try { process.kill(treePid, 'SIGKILL') } catch (e) { /* 已随进程组退出（ESRCH）：正常路径 */ }
  }
  fs.rmSync(treeDir, { recursive: true, force: true })
}

// 3h run_unit_tests.js 的汇总行必须能被 run_mutation.js 的 extractTestSummary 识别（UT-07）：
//    变异评估下内层套件 stdout 与本入口共用同一捕获管道，若本入口汇总行不含「K 通过, M 失败, 共 N」
//    三数字，extractTestSummary 会继续向上扫描并命中内层套件的同名行（如 test_filter.js:8746 的
//    「🎉 全部通过！785/785」）→ 逐变异体 summary 误归属内层套件。此处用诱饵行复现：内层桩套件打印
//    「全部通过！7/7」，外层只跑 1 个套件，断言取到外层的 1/0/1 而不是诱饵的 7/7。
function makeUnitTestsSandbox (suites, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-unit-tests-'))
  fs.copyFileSync(path.join(__dirname, 'run_unit_tests.js'), path.join(dir, 'run_unit_tests.js'))
  fs.writeFileSync(path.join(dir, 'test_suites.js'), `module.exports = { SUITES: ${JSON.stringify(suites)} }\n`)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}
const summaryDir = makeUnitTestsSandbox(
  [{ name: '内层诱饵', file: 'test_stub_decoy.js', desc: '打印可被 extractTestSummary 命中的诱饵行' }],
  { 'test_stub_decoy.js': "console.log('🎉 全部通过！7/7  100%')\nprocess.exit(0)\n" }
)
try {
  const unitEnv = { ...baseEnv }
  delete unitEnv.GITHUB_STEP_SUMMARY
  const unitRun = spawnSync(process.execPath, [path.join(summaryDir, 'run_unit_tests.js')],
    { encoding: 'utf8', cwd: summaryDir, env: unitEnv })
  assert.strictEqual(unitRun.status, 0, unitRun.stderr || unitRun.stdout)
  assert.match(unitRun.stdout, /全部通过！7\/7/, '夹具自身应先出现内层诱饵行（否则本回归形同虚设）')
  assert.deepStrictEqual(extractTestSummary(unitRun.stdout), ['1', '0', '1'],
    '本入口汇总行必须被 extractTestSummary 识别为本入口的数字（1 套件全通过），不得被内层套件的「全部通过！7/7」抢答')
} finally {
  fs.rmSync(summaryDir, { recursive: true, force: true })
}

// 3d CI 变异任务走 stryker（不经 run_mutation.js 的 spawn），必须由 step env 抑制 summary 追加
const strykerIdx = mutationYml.indexOf('npx stryker run')
assert.ok(strykerIdx > 0, 'mutation.yml 应包含 stryker 运行步骤')
assert.match(mutationYml.slice(strykerIdx, strykerIdx + 1500), /XBK_MUTATION_CHILD:\s*'1'/,
  'mutation.yml 的变异测试 step 必须设 XBK_MUTATION_CHILD=1（否则重复整表 append，几百次即撞 1MiB 上限）')

// 3e 变异 job 的三条 CI 硬约束：① 缓存 key/restore-keys 必须是**回退后**的形态（PR #156 的「测试指纹
//    强制全量」改动已于 2026-09-19 回退，用户拍板）；② 剥离步不得再碰 reports/inc-*.json；
//    ③ artifact 收窄到 reports/mutation/ 并 fail-loud。
// 三处都是评审判定为真问题的位置，靠注释兜不住——每条都做成「改回旧形态立刻红」的靶向断言。
// ① 的方向已反转，理由（为什么回退；旧说法「测试一变就必须全量重跑」已不保留）：
//    该改动 ⓐ **拦不住真根因**——假 Killed 来自**共享缓存的并发串扰**，发生在**变异体运行期**、基线全程是绿的；
//    测试没变时测试指纹不变、主 key 依旧命中，故它对真根因完全无效。
//    ⓑ **跑不完**——真正全量下 app(2651) / utils(2402) / message-store(1692) 在 --concurrency 8 下仍需
//    ~7h / ~6.5h / ~4.5h，必然撞「变异测试」step 的 330min 被 杀；而 actions/cache 的保存是 post-if: success()
//    ⇒ **失败段不保存进度** ⇒ 那几段每轮从零开始、永久红。
//    ⓒ **前提已消失**——stryker.config.js 的 thresholds.break 已改 null（当前**无分数门禁**）⇒ 陈旧增量复用
//    不再能误导任何门禁，「为保护分数门禁而强制全量」这个理由本身就不成立。这是**有意接受的取舍**，不是遗漏。
// 断言只读**真实 YAML 行**（剔除注释行）：否则把证据写进注释、代码改回去也能骗过门禁，等于没修。
{
  // 注：indentOf / yamlOnly 与 assertCacheStep / assertCacheConfigIdentity 的**定义与正向调用**已前移到本文件
  //     顶部（见 `const mutationYml` 之后的「缓存身份门禁」段）——原因见那段注释：本机那条环境失败是致命的，
  //     纯字符串门禁留在本块内永远跑不到。下方 7 个反例仍调用外层作用域里的同一个函数（断言语义一字未改）。
  // 从一个 step 的文本里取出 `run: |` 之后的 shell 正文（缩进深于 run: 的行），注释一律不算证据。
  // 注释行必须在这里剔除：只按缩进截断的话，把活动命令整行改成 `# node scripts/…` 后正文里仍带着
  // 命令原文，`includes('node scripts/mutation-report.js --strip')` 会被注释满足——CI 实际不再剥离、
  // 套件却全绿（本段旧实现正是如此，反例见下方 (2) 的端到端回归）。
  const shellBodyOf = (stepText) => {
    const lines = stepText.split('\n')
    const runAt = lines.findIndex(l => l.trim() === 'run: |')
    if (runAt < 0) return null
    const runIndent = indentOf(lines[runAt])
    const body = []
    for (let i = runAt + 1; i < lines.length; i++) {
      if (lines[i].trim() === '' || indentOf(lines[i]) <= runIndent) break
      if (lines[i].trim().startsWith('#')) continue // shell 注释不是证据
      body.push(lines[i])
    }
    return body.join('\n')
  }
  const stepEndIn = (text, at, nameLen) => {
    const next = text.indexOf('\n      - name: ', at + nameLen)
    return next > 0 ? next : text.length
  }
  const stepEndAfter = (at, nameLen) => stepEndIn(mutationYml, at, nameLen)

  // (1b 反例·正交多变体) 分别把 key / 兜底里的档位段、deps 段去掉，或把 src 段塞回兜底
  //     ⇒ assertCacheConfigIdentity 必须红。每个变体各自只动一行，且带「夹具真的改到了目标行」的前置断言；
  //     每条 assert.throws 都锚在该变体真正触发的那条断言的正则上。
  {
    const cfgSeg = '${' + '{ matrix.config }}-'
    const depsSeg = '-deps-${' + "{ hashFiles('package-lock.json') }}-"
    // 变体 C：只去掉 key 里的档位段 ⇒ 「缓存 key 的档位段必须…」必须红
    {
      const keyOnly = mutationYml.replace(/^([ \t]*)key: (stryker-\$\{\{ matrix\.name \}\}-cfg-)\$\{\{ matrix\.config \}\}-/m, '$1key: $2')
      assert.notStrictEqual(keyOnly, mutationYml,
        '变体 C 夹具必须真的从 key 行去掉了档位段（没改成本回归形同虚设）')
      const keyLineC = keyOnly.split('\n').find(l => /^[ \t]*key:\s/.test(l))
      assert.ok(keyLineC && !keyLineC.includes(cfgSeg) && keyLineC.includes('-cfg-$' + '{' + '{ hashFiles('),
        '变体 C 夹具中 key 行应已无档位段、但仍保留 -cfg- 与配置指纹（否则反例证明的不是「档位名被锁」）')
      const restoreLineC = keyOnly.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(restoreLineC && restoreLineC.includes(cfgSeg),
        '变体 C 夹具不得改动兜底前缀（否则它就不是「只动 key」的正交变体）')
      assert.throws(() => assertCacheConfigIdentity(keyOnly), /缓存 key 的档位段必须是/,
        '只从缓存 key 里去掉 matrix.config 档位段后必须红：否则只改 config: 时 key 逐字节不变、跨档继承复活')
    }
    // 变体 D：只去掉兜底前缀里的档位段 ⇒ 「兜底前缀的档位段必须…」必须红
    {
      const restoreOnly = mutationYml.replace(/^([ \t]*)(stryker-\$\{\{ matrix\.name \}\}-cfg-)\$\{\{ matrix\.config \}\}-/m, '$1$2')
      assert.notStrictEqual(restoreOnly, mutationYml,
        '变体 D 夹具必须真的从兜底前缀去掉了档位段（没改成本回归形同虚设）')
      const restoreLineD = restoreOnly.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(restoreLineD && !restoreLineD.includes(cfgSeg) && restoreLineD.includes('-cfg-$' + '{' + '{ hashFiles('),
        '变体 D 夹具中兜底前缀应已无档位段、但仍保留 -cfg- 与配置指纹')
      const keyLineD = restoreOnly.split('\n').find(l => /^[ \t]*key:\s/.test(l))
      assert.ok(keyLineD && keyLineD.includes(cfgSeg),
        '变体 D 夹具不得改动 key 行（否则它就不是「只动兜底」的正交变体）')
      assert.throws(() => assertCacheConfigIdentity(restoreOnly), /兜底前缀的档位段必须是/,
        '只从兜底前缀里去掉 matrix.config 档位段后必须红：兜底路径同样会恢复另一档的 inc，只锁 key 不够')
    }
    // 变体 E：只去掉 key 指纹里的 `scripts/tap-shim.js` ⇒ 「缓存 key 的配置指纹必须含…」必须红
    {
      const SHIM = ", 'scripts/tap-shim.js'"
      const lines = mutationYml.split('\n')
      const ki = lines.findIndex(l => /^[ \t]*key: stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(ki >= 0, '变体 E 必须能在真实 mutation.yml 里定位到 key 行')
      const keyNoShim = lines[ki].replace(SHIM, '')
      assert.notStrictEqual(keyNoShim, lines[ki], '变体 E 夹具必须真的从 key 指纹里删掉了 scripts/tap-shim.js')
      const linesE = lines.slice()
      linesE[ki] = keyNoShim
      const ymlE = linesE.join('\n')
      assert.ok(ymlE.includes('scripts/tap-shim.js'), '变体 E 只动 key 行，兜底指纹仍应保留 shim（保证正交）')
      assert.throws(() => assertCacheConfigIdentity(ymlE), /缓存 key 的配置指纹必须含/,
        '只把 scripts/tap-shim.js 从 key 指纹里删掉后必须红：否则 shim 变更不会让缓存失效、旧覆盖归因被复用')
    }
    // 变体 F：只去掉兜底指纹里的 `scripts/tap-shim.js` ⇒ 「兜底前缀的配置指纹必须含…」必须红
    {
      const SHIM = ", 'scripts/tap-shim.js'"
      const lines = mutationYml.split('\n')
      const ri = lines.findIndex(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-.*hashFiles\(/.test(l))
      assert.ok(ri >= 0, '变体 F 必须能在真实 mutation.yml 里定位到兜底前缀行')
      const restoreNoShim = lines[ri].replace(SHIM, '')
      assert.notStrictEqual(restoreNoShim, lines[ri], '变体 F 夹具必须真的从兜底指纹里删掉了 scripts/tap-shim.js')
      const linesF = lines.slice()
      linesF[ri] = restoreNoShim
      const ymlF = linesF.join('\n')
      assert.ok(ymlF.includes('scripts/tap-shim.js'), '变体 F 只动兜底行，key 指纹仍应保留 shim（保证正交）')
      assert.throws(() => assertCacheConfigIdentity(ymlF), /兜底前缀的配置指纹必须含/,
        '只把 scripts/tap-shim.js 从兜底指纹里删掉后必须红：主 key 未命中时兜底仍会恢复按旧归因算出的 inc')
    }
    // 变体 G：只从 key 去掉 deps 段 ⇒ 「缓存 key 必须含 -deps-…」必须红（兜底保持原样，保证正交）
    {
      const lines = mutationYml.split('\n')
      const ki = lines.findIndex(l => /^[ \t]*key: stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(ki >= 0, '变体 G 必须能在真实 mutation.yml 里定位到 key 行')
      const keyNoDeps = lines[ki].replace(depsSeg, '')
      assert.notStrictEqual(keyNoDeps, lines[ki],
        '变体 G 夹具必须真的从 key 行删掉了 deps 段（没改成本回归形同虚设）')
      const linesG = lines.slice()
      linesG[ki] = keyNoDeps
      const ymlG = linesG.join('\n')
      const keyLineG = ymlG.split('\n').find(l => /^[ \t]*key:\s/.test(l))
      assert.ok(keyLineG && !keyLineG.includes('-deps-') && keyLineG.includes(cfgSeg) && keyLineG.includes('scripts/tap-shim.js'),
        '变体 G 夹具中 key 行应已无 deps 段、但仍保留 -cfg- 档位段与配置指纹')
      const restoreLineG = ymlG.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(restoreLineG && restoreLineG.includes(depsSeg),
        '变体 G 夹具不得改动兜底前缀（否则它就不是「只动 key」的正交变体）')
      assert.throws(() => assertCacheConfigIdentity(ymlG), /缓存 key 必须含/,
        '只从缓存 key 里去掉 deps 段后必须红：否则 package-lock.json 变化（依赖升级）不会换掉缓存身份')
    }
    // 变体 H：只从兜底前缀去掉 deps 段 ⇒ 「兜底前缀必须含与 key…」必须红（key 行保持不动，保证正交）
    {
      const lines = mutationYml.split('\n')
      const ri = lines.findIndex(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-.*hashFiles\(/.test(l))
      assert.ok(ri >= 0, '变体 H 必须能在真实 mutation.yml 里定位到兜底前缀行')
      const restoreNoDeps = lines[ri].replace(depsSeg, '')
      assert.notStrictEqual(restoreNoDeps, lines[ri],
        '变体 H 夹具必须真的从兜底前缀删掉了 deps 段（没改成本回归形同虚设）')
      const linesH = lines.slice()
      linesH[ri] = restoreNoDeps
      const ymlH = linesH.join('\n')
      const restoreLineH = ymlH.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(restoreLineH && !restoreLineH.includes('-deps-') && restoreLineH.includes(cfgSeg) && restoreLineH.includes('scripts/tap-shim.js'),
        '变体 H 夹具中兜底前缀应已无 deps 段、但仍保留 -cfg- 档位段与配置指纹')
      const keyLineH = ymlH.split('\n').find(l => /^[ \t]*key:\s/.test(l))
      assert.ok(keyLineH && keyLineH.includes(depsSeg),
        '变体 H 夹具不得改动 key 行（否则 assert.throws 可能命中 key 半边的文案，反例就不再证明兜底被锁）')
      assert.throws(() => assertCacheConfigIdentity(ymlH), /兜底前缀必须含与 key/,
        '只从兜底前缀里去掉 deps 段后必须红：主 key miss 时兜底仍把旧 inc 复原，而 differ 不认识依赖版本 ⇒ ' +
        '依赖升级被静默 100% 复用（实测 run 35775812104 / issue #167）')
    }
    // 变体 I：把 src 段塞回兜底前缀（旧形态的反向退化）⇒ 「兜底前缀不得含 -src-」必须红
    {
      const srcSeg = '-src-${' + "{ hashFiles('run_mutation.js', matrix.src) }}-"
      const lines = mutationYml.split('\n')
      const ri = lines.findIndex(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-.*hashFiles\(/.test(l))
      assert.ok(ri >= 0, '变体 I 必须能在真实 mutation.yml 里定位到兜底前缀行')
      const srcBack = lines[ri].replace(/-[ \t]*$/, '') + srcSeg
      assert.notStrictEqual(srcBack, lines[ri], '变体 I 夹具必须真的把 src 段塞回了兜底前缀')
      const linesI = lines.slice()
      linesI[ri] = srcBack
      const ymlI = linesI.join('\n')
      const restoreLineI = ymlI.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
      assert.ok(restoreLineI && restoreLineI.includes('-src-') && restoreLineI.includes(depsSeg),
        '变体 I 夹具中兜底前缀应含 -src- 且仍保留 deps 段（否则它触发的就不是「不得含 -src-」那条）')
      const keyLineI = ymlI.split('\n').find(l => /^[ \t]*key:\s/.test(l))
      assert.ok(keyLineI && keyLineI.includes(depsSeg),
        '变体 I 夹具不得改动 key 行（否则 assert.throws 可能命中 key 半边的文案，反例就不再证明兜底不得带 src）')
      assert.throws(() => assertCacheConfigIdentity(ymlI), /兜底前缀不得含/,
        '把源指纹段塞回兜底前缀后必须红：兜底带 src 就等于永不兜底（主 key miss 时无可恢复）或跨源继承')
    }
  }

  // (1 反例·靶向) 拆成**两个正交变体**，各自只动一个目标行。为什么必须拆：旧夹具用一条
  //     `/^([ \t]*)key: stryker-${{ matrix.name }}-.*$/m` 把 key 整行改写成 `-tests-` 形态（`-cfg-`
  //     连同配置指纹一起被删掉），于是紧随其后那条 `^[ \t]*stryker-${{ matrix.name }}-cfg-.*$` 的兜底替换
  //     **匹配不到**、夹具里兜底仍是原样；而 `assert.throws(…, /不含 -tests-/)` 靠 key 半边照样通过
  //     ⇒ 那条反例只证明了 key 被锁、**没有**证明兜底被锁（兜底实际由正向 deepStrictEqual 兜住，
  //     但「反例覆盖两个方向」这件事此前是假的）。拆开后每个变体都带「夹具真的改到了目标行」的前置断言。
  {
    const open = '${'
    // 变体 A：**只**把 key 改回 PR #156 的含测试指纹形态 ⇒ key 断言必须红（兜底保持原样，保证正交）
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-cache-key-'))
      try {
        const fixture = path.join(dir, 'mutation.yml')
        const fingerprintKey = 'key: stryker-' + open + '{ matrix.name }}-tests-' + open + "{ hashFiles('test_*.js') }}-src-" + open + "{ hashFiles('package-lock.json', 'stryker.config.js', 'run_mutation.js', matrix.src) }}"
        const keyRegressed = mutationYml.replace(/^([ \t]*)key: stryker-\$\{\{ matrix\.name \}\}-.*$/m, (m, ind) => ind + fingerprintKey)
        assert.notStrictEqual(keyRegressed, mutationYml,
          '变体 A 夹具必须真的把 key 改成了含测试指纹的形态（没改成本回归形同虚设）')
        const keyLineA = keyRegressed.split('\n').find(l => /^[ \t]*key:\s/.test(l))
        assert.ok(keyLineA && keyLineA.includes('-tests-'),
          '变体 A 夹具中 key 行必须带 -tests- 段（否则反例证明的不是「改回指纹形态会红」）')
        const restoreLineA = keyRegressed.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-cfg-/.test(l))
        assert.ok(restoreLineA,
          '变体 A 夹具不得改动兜底前缀（否则它就不是「只动 key」的正交变体，也就证明不了 key 半边被锁）')
        fs.writeFileSync(fixture, keyRegressed)
        assert.throws(() => assertCacheStep(fs.readFileSync(fixture, 'utf8')),
          /不含 -tests-/,
          '只把缓存 key 改回含测试指纹的形态后必须红：断言锁定的就是「key 不含测试指纹」这一形态')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    // 变体 B：**只**把兜底前缀退回裸 `stryker-<段>-` ⇒ 兜底 deepStrictEqual 必须红。
    //           key 行保持不动 ⇒ 不可能再靠 key 半边的 `-tests-` 文案蒙混过关，这条反例只可能由兜底断言来红。
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-cache-restore-'))
      try {
        const fixture = path.join(dir, 'mutation.yml')
        const bareRestore = 'stryker-' + open + '{ matrix.name }}-'
        const restoreRegressed = mutationYml.replace(/^([ \t]*)stryker-\$\{\{ matrix\.name \}\}-cfg-.*$/m, (m, ind) => ind + bareRestore)
        assert.notStrictEqual(restoreRegressed, mutationYml,
          '变体 B 夹具必须真的把兜底前缀退回了裸前缀形态（没改成本回归形同虚设）')
        const restoreLineB = restoreRegressed.split('\n').find(l => /^[ \t]*stryker-\$\{\{ matrix\.name \}\}-$/.test(l))
        assert.ok(restoreLineB,
          '变体 B 夹具中兜底前缀应是裸的 `stryker-$' + '{' + '{ matrix.name }}-`（否则反例证明的不是「兜底被锁」）')
        const keyLineB = restoreRegressed.split('\n').find(l => /^[ \t]*key:\s/.test(l))
        assert.ok(keyLineB && !keyLineB.includes('-tests-'),
          '变体 B 夹具不得改动 key 行（否则 assert.throws 可能命中 key 的 `不含 -tests-` 文案，反例就不再证明兜底被锁）')
        fs.writeFileSync(fixture, restoreRegressed)
        assert.throws(() => assertCacheStep(fs.readFileSync(fixture, 'utf8')),
          /restore-keys 必须是/,
          '只把兜底前缀退回裸 `stryker-<段>-` 后必须红：裸前缀会让 TAP 段恢复 command 档遗留 inc（core 对 inc ' +
          '零校验），而旧反例完全看不见这一方向——它把 key 一起改掉后，兜底替换根本匹配不到')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  }

  // (2) 剥离步不得再把 reports/inc-*.json 塞回去：inc 是**下一次运行** incremental-differ 的复用输入，
  //     statusReason 会被原样透传进新产出的 JSON/HTML；在这里置空串，等于让「被复用的变异体为什么
  //     存活/报错」永久丢失（与既有「不动 mutation.html」完全同一条理由）。只允许剥机器报告 mutation.json。
  //     抽成按文本取用的函数，是为了让紧随其后的反例在**同一套提取+断言代码**上跑真实 workflow 的变异副本。
  const assertStripStep = (ymlText) => {
    const stripName = '- name: 剥离报告中的 statusReason（artifact/缓存瘦身）'
    const stripAt = ymlText.indexOf(stripName)
    assert.ok(stripAt >= 0, 'mutation.yml 必须存在「剥离报告中的 statusReason」步骤')
    const stripStep = ymlText.slice(stripAt, stepEndIn(ymlText, stripAt, stripName.length))
    const stripScript = shellBodyOf(stripStep)
    assert.ok(stripScript !== null, '剥离步骤必须以 `run: |` 执行 shell（否则无从核对剥离目标）')
    assert.ok(stripScript.includes('reports/mutation/mutation.json'),
      '剥离 shell 必须仍覆盖 `reports/mutation/mutation.json`（该字段的机器报告冗余照旧剥离，消费方语义零变化）')
    assert.ok(!stripScript.includes('reports/inc-'),
      '剥离 shell 不得再出现 `reports/inc-*.json`（重新塞回去即红）：inc 是下一次运行的增量复用输入，' +
      '把 statusReason 置空会让被复用变异体的存活/报错原因永久丢失（Qodo Medium / Observability）')
    assert.ok(stripScript.includes('node scripts/mutation-report.js --strip'),
      '剥离必须经生产 CLI（node scripts/mutation-report.js --strip）执行，不得内联脚本')
  }
  assertStripStep(mutationYml)

  // (2 反例·端到端) 注释不能当证据：把真实 mutation.yml 里**活动**的剥离命令整行改成 shell 注释
  //     （注释文本原样保留命令），落成临时文件再读回，仍走上面同一套提取+断言 ⇒ 必须抛
  //     「剥离必须经生产 CLI」。过滤注释的那一步若被去掉，本反例会变红（断言骗得过门禁）。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-strip-comment-'))
    try {
      const fixture = path.join(dir, 'mutation.yml')
      const commented = mutationYml.replace(/(^[ \t]*)node scripts\/mutation-report\.js --strip/m,
        '$1# node scripts/mutation-report.js --strip')
      assert.notStrictEqual(commented, mutationYml,
        '反例夹具必须真的把活动命令行改成了注释（没改成本回归形同虚设）')
      assert.ok(/^[ \t]*# node scripts\/mutation-report\.js --strip/m.test(commented) &&
        !/^[ \t]*node scripts\/mutation-report\.js --strip/m.test(commented),
      '夹具中该命令应只剩注释形态（否则反例证明的不是「注释骗不过去」）')
      fs.writeFileSync(fixture, commented)
      assert.throws(() => assertStripStep(fs.readFileSync(fixture, 'utf8')),
        /剥离必须经生产 CLI/,
        '活动命令被改成注释后必须红：注释行不得再满足正向断言（旧实现只按缩进截断，注释里的命令原文照样入选）')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // (3) 「上传变异报告」的 path 必须收窄为 reports/mutation/ 并 fail-loud：reports/ 会把**未剥离**的
  //     inc-*.json 一起打包（artifact 侧无消费方，纯白带体积），而 stryker 没产出报告时还会静默上传一个
  //     只含 inc 的 artifact，把「缺段」拖到汇总 job 才暴露。
  const uploadName = '- name: 上传变异报告'
  const uploadAt = mutationYml.indexOf(uploadName)
  assert.ok(uploadAt >= 0, 'mutation.yml 必须存在「上传变异报告」步骤')
  const uploadLines = yamlOnly(mutationYml.slice(uploadAt, stepEndAfter(uploadAt, uploadName.length)))
  const uploadPath = uploadLines.find(l => /^\s*path:/.test(l))
  assert.ok(uploadPath, '「上传变异报告」必须声明 path')
  assert.strictEqual(uploadPath.trim(), 'path: reports/mutation/',
    '「上传变异报告」的 path 必须是 `reports/mutation/`：改回 `reports/` 会把未剥离的 inc-*.json 一起打包' +
    '（artifact 侧无消费方），同时失去「stryker 没产出报告 ⇒ 上传响亮变红」的 fail-loud 语义')
  const noFiles = uploadLines.find(l => /^\s*if-no-files-found:/.test(l))
  assert.ok(noFiles && noFiles.trim() === 'if-no-files-found: error',
    '「上传变异报告」必须带 `if-no-files-found: error`：stryker 崩溃/未产出报告时不得静默上传一个只含 inc 的 artifact')

  // (4) fail-closed 守卫 step 必须存在、带 if: always()、经生产 CLI 调用，且位于 stryker 之后、上传之前。
  //     撤回分数门禁（thresholds.break = null）后，守卫是唯一的恒常判据：把它删掉/挪到上传之后/改成内联脚本，
  //     都会让「全 RuntimeError / 空报告 / 报告缺失」重新变成静默假绿——而门禁自身没有门禁，所以在这里锁死。
  {
    const guardName = '- name: 变异报告 fail-closed 守卫（' + '${' + '{ matrix.name }}）'
    const guardAt = mutationYml.indexOf(guardName)
    assert.ok(guardAt >= 0,
      'mutation.yml 必须存在「变异报告 fail-closed 守卫」step：它是撤回分数门禁后唯一的恒常判据，被删掉即静默假绿')
    const guardText = mutationYml.slice(guardAt, stepEndAfter(guardAt, guardName.length))
    const guardLines = yamlOnly(guardText)
    assert.ok(guardLines.some(l => /^\s*if:\s*always\(\)/.test(l)),
      '守卫 step 必须带 `if: always()`：stryker 失败/超时时同样要判一遍（否则最该判的场合反而不判）')
    assert.ok(guardLines.some(l => l.includes('node scripts/mutation-guard.js')),
      '守卫必须经生产 CLI `node scripts/mutation-guard.js` 调用，不得内联脚本（内联逻辑会与用例/文档漂移）')
    assert.ok(/--segment\s+"?\$\{\{\s*matrix\.name\s*\}\}"?/.test(guardText),
      '守卫必须带 --segment "$' + '{' + '{ matrix.name }}"：失败输出要能直接指出是哪一段')
    assert.ok(guardAt > strykerIdx && guardAt < uploadAt,
      '守卫必须位于 stryker step 之后、上传 artifact 之前（stryker 之前无报告可判；上传之后失败已无意义）')
  }
}
console.log('✅ mutation.yml：缓存 key/兜底前缀为**回退后**形态（不含测试指纹；靶向反例已锁），剥离不含 inc，artifact 收窄为 reports/mutation/ 且 fail-loud')

// 3i PR-1（CI 切 TAP 档）接线契约：报告路径 + 矩阵逐段 runner 档位。
// 为什么必须锁死（不是形式主义）：tap 配置把报告路径**显式**写成 stryker 默认值（stryker.tap.config.js 的
// jsonReporter/htmlReporter），而「报告 = reports/mutation/mutation.json|.html」是**五处**的共同前提——
// mutation.yml 的 fail-closed 守卫、紧随缓存恢复的 `rm -rf reports/mutation`、「记录本段增量复用状态」的
// reuse.json 落盘闸门、artifact（path: reports/mutation/ + if-no-files-found: error）与
// .github/workflows/analyze-artifacts.yml。谁把 tap 配置的报告路径改成子目录（如 reports/mutation/tap/），
// CI 会**静默**坏掉（守卫读不到报告 ⇒ 段 job 判红；artifact 变空 ⇒ 汇总缺段），而现有用例全绿
// ⇒ 在门禁里锁住，并配靶向反例（改回去立刻红）。
{
  const TAP_CONFIG = 'stryker.tap.config.js'
  const COMMAND_CONFIG = 'stryker.config.js'
  const DEFAULT_JSON = 'reports/mutation/mutation.json'
  const DEFAULT_HTML = 'reports/mutation/mutation.html'

  // (1) tap 配置**解析后**必须指向 stryker 默认报告路径。逐字 strictEqual（不做前缀/包含判断）：
  //     'reports/mutation/tap/mutation.json' 这类「默认路径的子目录」必须红——它正是 canary 专用形态，
  //     带进生产会让上面那五处全部失配。
  const assertReportPaths = (cfg) => {
    assert.ok(cfg && typeof cfg === 'object', 'stryker.tap.config.js 必须导出配置对象')
    assert.ok(cfg.jsonReporter && typeof cfg.jsonReporter.fileName === 'string',
      'stryker.tap.config.js 必须显式声明 jsonReporter.fileName（不得依赖省略后的 schema 默认：路径是守卫/artifact/日报的共同前提，必须可见可断言）')
    assert.strictEqual(cfg.jsonReporter.fileName, DEFAULT_JSON,
      'tap 档的 json 报告必须落 stryker **默认路径** ' + DEFAULT_JSON +
      '：mutation.yml 的 fail-closed 守卫与 artifact（path: reports/mutation/）按它对齐，改路径 ⇒ 守卫读不到报告/artifact 变空')
    assert.ok(cfg.htmlReporter && typeof cfg.htmlReporter.fileName === 'string',
      'stryker.tap.config.js 必须显式声明 htmlReporter.fileName（同上：路径必须可见可断言）')
    assert.strictEqual(cfg.htmlReporter.fileName, DEFAULT_HTML,
      'tap 档的 html 报告必须落 stryker **默认路径** ' + DEFAULT_HTML + '（给人看的明细留档，artifact 按它打包）')
  }
  assertReportPaths(require('./' + TAP_CONFIG))

  // (1 反例·靶向) 把报告路径改成 canary 用的子目录形态 ⇒ 同一套断言必须红
  //     （证明断言不是「只看有没有这个键」，而是真的锁住了默认路径本身）。
  {
    const cfg = require('./' + TAP_CONFIG)
    const mutated = { ...cfg, jsonReporter: { fileName: 'reports/mutation/tap/mutation.json' } }
    assert.notStrictEqual(mutated.jsonReporter.fileName, cfg.jsonReporter.fileName,
      '反例夹具必须真的把报告路径改成了子目录形态（没改成本回归形同虚设）')
    assert.throws(() => assertReportPaths(mutated), /默认路径/,
      '把报告路径改成 reports/mutation/tap/ 后必须红：否则「路径必须默认」这条前提被静默破坏而套件仍全绿')
  }

  // (1b) tap 配置的 **runner 契约**（审查 A1·D5）：只锁报告路径不够——把 `testRunner` 换成 command、
  //      把 `coverageAnalysis` 从 perTest 改成 off、或把 `tap` 键名写成 `tapRunner`，报告路径与矩阵声明都
  //      照样成立，CI 却已经静默变了语义（分别退化成 command runner / 每变异体跑整套件 / testFiles 落回
  //      默认 glob ⇒ dry run 0 文件、"No tests were executed"）。故这三项必须显式锁定。
  //      `tap.testFiles` 的**内容与顺序**由 stryker.tap.config.js 的加载期断言对账 test_suites.js（不一致即
  //      throw），本处只锁「tap 是对象且 testFiles 是非空数组」这一形状。
  const assertTapRunnerContract = (cfg) => {
    assert.ok(cfg && typeof cfg === 'object', 'stryker.tap.config.js 必须导出配置对象')
    assert.strictEqual(cfg.testRunner, 'tap',
      'stryker.tap.config.js 的 testRunner 必须是 \'tap\'：退回 command runner 后 perTest 不可用、' +
      '每个变异体都要跑整套件（实测 34-37× 的提速与 CI 墙钟前提一起消失），而矩阵里 15 段的 config: 仍指向它')
    assert.strictEqual(cfg.coverageAnalysis, 'perTest',
      'stryker.tap.config.js 的 coverageAnalysis 必须是 \'perTest\'：command runner 只支持 \'off\'，' +
      '静默退化成「每个变异体跑整套件」；这一项坏掉不会立刻红，只会让 CI 墙钟暴涨（晚些时候才炸）')
    assert.ok(cfg.tap && typeof cfg.tap === 'object' && !Array.isArray(cfg.tap),
      'stryker.tap.config.js 必须声明 `tap` 对象（键名必须逐字是 `tap`：tap-runner@10 读的是 options.tap.*，' +
      '写成 `tapRunner` 会被 stryker 当未知选项**静默忽略**⇒ testFiles 落回默认 glob、dry run 0 文件）')
    assert.ok(Array.isArray(cfg.tap.testFiles) && cfg.tap.testFiles.length > 0,
      'stryker.tap.config.js 的 tap.testFiles 必须是非空数组（显式清单；内容/顺序与 test_suites.js 的对账由' +
      '本文件的加载期断言负责，这里锁住「键名对了、清单在」这一形状）')
  }
  assertTapRunnerContract(require('./' + TAP_CONFIG))

  // (1b 反例·靶向) 三个方向各跑一次：testRunner 退回 command、coverageAnalysis 退回 off、`tap` 键名写错
  //     （`tapRunner`）⇒ 同一套断言必须各自红。每条都带「夹具真的改到了目标字段」的前置断言。
  {
    const real = require('./' + TAP_CONFIG)
    const misspelled = { ...real }
    misspelled.tapRunner = misspelled.tap
    delete misspelled.tap
    const variants = [
      { name: 'testRunner 退回 command', mutated: { ...real, testRunner: 'command' }, want: /testRunner 必须是/, probe: c => c.testRunner },
      { name: 'coverageAnalysis 退回 off', mutated: { ...real, coverageAnalysis: 'off' }, want: /coverageAnalysis 必须是/, probe: c => c.coverageAnalysis },
      { name: 'tap 键名写成 tapRunner', mutated: misspelled, want: /必须声明 `tap` 对象/, probe: c => c.tap }
    ]
    for (const v of variants) {
      assert.notStrictEqual(v.probe(v.mutated), v.probe(real),
        '反例夹具（' + v.name + '）必须真的改掉了目标字段（没改成本回归形同虚设）')
      assert.throws(() => assertTapRunnerContract(v.mutated), v.want,
        v.name + ' 后必须红：否则 tap 档的语义静默退化（command runner / 整套件重跑 / testFiles 落回默认 glob）' +
        '而报告路径与矩阵声明仍全绿')
    }
  }

  // (2)(3) 矩阵逐段 runner 档位：从**真实 YAML 行**解析（注释一律不算证据），
  //     抽成函数是为了让紧随其后的两条反例在**同一套提取 + 断言代码**上跑真实 workflow 的变异副本。
  const parseMatrixConfigs = (ymlText) => {
    const lines = ymlText.split('\n')
    const includeAt = lines.findIndex(l => /^\s*include:\s*$/.test(l))
    assert.ok(includeAt >= 0, 'mutation.yml 的 matrix 必须有 include 块（逐段 runner 档位无从核对即视为回归）')
    const includeIndent = lines[includeAt].match(/^\s*/)[0].length
    const entries = []
    let cur = null
    for (let i = includeAt + 1; i < lines.length; i++) {
      const raw = lines[i]
      if (raw.trim() === '') continue
      const indent = raw.match(/^\s*/)[0].length
      // include 块结束：回到 steps: 等同级键（缩进不深于 include:）
      if (/^\s*[A-Za-z_][\w-]*:/.test(raw) && indent <= includeIndent) break
      if (raw.trim().startsWith('#')) continue // 注释不是证据
      let body = raw.trim()
      if (body.startsWith('-')) {
        const rest = body.slice(1).trim()
        if (rest === '' || rest.startsWith('#')) continue
        cur = { name: null, config: null }
        entries.push(cur)
        body = rest
      }
      if (!cur) continue
      const colon = body.indexOf(':')
      if (colon <= 0) continue
      const key = body.slice(0, colon).trim()
      if (key !== 'name' && key !== 'config') continue
      let value = body.slice(colon + 1).trim()
      if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1)
      const hash = value.indexOf('#') // 裸标量：行内注释从 # 开始
      if (hash !== -1) value = value.slice(0, hash).trim()
      cur[key] = value
    }
    return entries
  }

  const assertMatrixConfigs = (ymlText) => {
    const entries = parseMatrixConfigs(ymlText)
    assert.ok(entries.length > 0, 'mutation.yml 的 matrix include 必须解析出条目')
    const missing = entries.filter(e => !e.config).map(e => e.name || '(未命名)')
    assert.deepStrictEqual(missing, [],
      '矩阵每个条目都必须声明 config:（逐段选 runner）——缺字段时 stryker 会收到空配置名，job 启动即红')
    // (2) config 值必须是仓库里真实存在的文件：写成不存在的配置名 ⇒ stryker 启动即失败，在这里提前拦下。
    for (const e of entries) {
      assert.ok(fs.existsSync(path.join(__dirname, e.config)),
        '矩阵「' + e.name + '」的 config 指向不存在的文件：' + e.config + '（job 会在 npx stryker run 时立刻失败）')
    }
    // (3) 档位分布：**恰有这 4 段**用 command 档，其余全部 TAP 档。顺序按矩阵 include 的实际顺序取值
    //     （v3-entry 是矩阵第一条），所以这里写死的是**矩阵顺序**而非任意集合顺序。
    //     为什么锁分布而不是「至少有一段」：留下的每一段都有实测根因（见 mutation.yml 的 matrix 注释
    //     ①②③ 与 AGENTS.md）——① storage：TAP 档下「变异体导致被测进程崩溃」被记成 RuntimeError 而非
    //     Killed（`fd = -1` 哨兵被 UnaryOperator 改成 `+1` ⇒ closeSync(1) 关掉 stdout）；② qinglong-push /
    //     check-deps：变异目标只在子进程里执行、文本断言不产生覆盖 ⇒ perTest 归因不到 ⇒ NoCoverage 且不跑
    //     任何测试；③ v3-entry：`test_utils_pure.js:449` 的 `execFileSync(node, ['-e', probe])` 同手法，
    //     A5 逐变异体 replay 量化其 TAP 档丢 **19** 个击杀（旧 command 全量里全是 Killed）。把任一段挪回
    //     TAP 会静默丢检出，把别的段落到 command 档则那段重新变成「真全量跑不完 ⇒ 靠复用」的老问题。
    //     两个方向都要红；本断言与 mutation.yml 的 `readMatrixRunnerConfigs()` 消费方（日报档位标注）也一致。
    assert.deepStrictEqual(entries.filter(e => e.config === COMMAND_CONFIG).map(e => e.name),
      ['v3-entry', 'storage', 'qinglong-push', 'check-deps'],
      '必须**恰有** v3-entry / storage / qinglong-push / check-deps 这 4 段（按矩阵顺序）用 command 档 ' +
      COMMAND_CONFIG + '：① v3-entry：`test_utils_pure.js` 的 `-e` 子进程 probe 使 perTest 归因不到 ⇒ TAP 档' +
      '静默丢 19 个击杀（A5 replay 量化）；② storage：TAP 档下变异体导致的进程崩溃被记成 RuntimeError 而非' +
      'Killed；③ qinglong-push / check-deps：变异目标只在子进程里被执行，perTest 覆盖图看不见 ⇒ TAP 档判' +
      'NoCoverage 且不运行任何测试，静默丢失检出能力。见 mutation.yml matrix 注释与 AGENTS.md；其余段必须' +
      '走 TAP 档，否则回到「真全量跑不完 ⇒ 靠复用」的老问题')
    const unknown = [...new Set(entries.map(e => e.config))].filter(c => c !== TAP_CONFIG && c !== COMMAND_CONFIG)
    assert.deepStrictEqual(unknown, [],
      '矩阵的 config 只允许 ' + TAP_CONFIG + '（TAP 档）或 ' + COMMAND_CONFIG + '（command 档）：多出第三档必须显式登记')
  }
  assertMatrixConfigs(mutationYml)

  // (4) **消费点**：真正决定跑哪一档的不是 matrix 的 `config:` 字段（那只是声明），而是「变异测试」step 里
  //     `npx stryker run <configFile>` 这一行——Stryker 10 的 configFile 是**位置参数**（无 --configFile 选项，
  //     见 mutation.yml 该 step 上方注释）。只锁声明不锁消费 ⇒ 把这一行写死成 stryker.tap.config.js 时，
  //     4 段 command 档全部静默走 TAP（正是本 PR 明令禁止的形态：v3-entry 的 `-e` 子进程 probe、storage 的
  //     `fd = -1` 哨兵被改成 `+1` 后 closeSync(1) 关掉 stdout ⇒ 进程崩溃被 tap-runner 记 RuntimeError ⇒
  //     该段被 fail-closed 守卫判常红；qinglong-push / check-deps 的变异目标只在子进程里执行、perTest 覆盖
  //     图看不见 ⇒ NoCoverage 且**不运行任何测试**、静默丢检出），而当时整套门禁（含 3i 的矩阵声明断言）
  //     **全绿**。故在门禁里逐字锁定消费点，并配「写死配置 ⇒ 红」的靶向反例。
  const assertStrykerRunConsumption = (ymlText) => {
    // 只认**活动**行：`run:` 前不允许出现 `#`，注释里写命令原文一律不算证据。
    const active = ymlText.split('\n').filter(l => /^[ \t]*run:\s*npx stryker run\b/.test(l))
    assert.strictEqual(active.length, 1,
      'mutation.yml 必须有**且仅有**一行活动 `run: npx stryker run …`（注释不算证据）：它是逐段 runner 的' +
      '唯一消费点，0 行（命令被删/被注释）或多行（多出一处没人核对的 stryker 调用）都必须红')
    const rest = active[0].replace(/^[ \t]*run:\s*npx stryker run\b[ \t]*/, '')
    assert.match(rest, /^\$\{\{\s*matrix\.config\s*\}\}([ \t]|$)/,
      '变异测试 step 的 run 行必须逐字使用 matrix.config 作为 configFile 位置参数' +
      '（`npx stryker run $' + '{' + '{ matrix.config }} …`）：matrix 的 config: 字段只是**声明**，真正决定' +
      '跑哪一档的是这一行；把它写死（如 stryker.tap.config.js）会让 v3-entry/storage/qinglong-push/check-deps 的逐段' +
      'runner 静默失效——v3-entry/storage 被 fail-closed 守卫判常红、另两段 NoCoverage 且不跑任何测试（静默丢检出）')
  }
  assertStrykerRunConsumption(mutationYml)

  // (4 反例·靶向) 把消费点写死成 stryker.tap.config.js（= 4 段 command 档全部被 TAP 覆盖）⇒ 必须红。
  //     这条反例就是该缺口的直接证据：修复前，同一处改动下 `node test_ci_skip_suites.js` 是 **exit 0 全绿**。
  {
    const hardcoded = mutationYml.replace(
      /^([ \t]*)run: npx stryker run[ \t]+\$\{\{\s*matrix\.config\s*\}\}/m,
      '$1run: npx stryker run stryker.tap.config.js')
    assert.notStrictEqual(hardcoded, mutationYml,
      '反例夹具必须真的把消费点的 configFile 参数写死（没改成本回归形同虚设）')
    const fixtureRunLines = hardcoded.split('\n').filter(l => /^[ \t]*run:\s*npx stryker run\b/.test(l))
    assert.strictEqual(fixtureRunLines.length, 1, '夹具中活动 run 行应恰有一行')
    assert.ok(/stryker\.tap\.config\.js/.test(fixtureRunLines[0]) && !/matrix\.config/.test(fixtureRunLines[0]),
      '夹具中活动 run 行应已写死 stryker.tap.config.js（否则反例证明的不是「消费点被锁」）')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-stryker-consume-'))
    try {
      const fixture = path.join(dir, 'mutation.yml')
      fs.writeFileSync(fixture, hardcoded)
      assert.throws(() => assertStrykerRunConsumption(fs.readFileSync(fixture, 'utf8')),
        /逐字使用 matrix\.config/,
        '把消费点写死成某一档后必须红：否则矩阵的 config: 退化为纯装饰，CI 会静默用错档而整套门禁全绿')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // (2 反例·靶向) 把某段 config 改成不存在的文件名 ⇒ 必须红
  {
    const mutated = mutationYml.replace(/^([ \t]*)config: "stryker\.tap\.config\.js"[ \t]*$/m,
      '$1config: "stryker.typo.config.js"')
    assert.notStrictEqual(mutated, mutationYml, '反例夹具必须真的改掉了某段的 config（没改成本回归形同虚设）')
    assert.throws(() => assertMatrixConfigs(mutated), /不存在的文件/,
      '把 config 改成不存在的文件名后必须红：否则矩阵写错配置名要等 CI job 启动才暴露')
  }
  // (3 反例·靶向) 把 4 段 command 档（v3-entry / storage / qinglong-push / check-deps）全切到 TAP 档 ⇒ 分布断言必须红
  {
    const mutated = mutationYml.replace(/^([ \t]*)config: "stryker\.config\.js"[ \t]*$/gm,
      '$1config: "stryker.tap.config.js"')
    assert.notStrictEqual(mutated, mutationYml, '反例夹具必须真的改掉了 command 档条目的 config')
    assert.deepStrictEqual(parseMatrixConfigs(mutated).filter(e => e.config === COMMAND_CONFIG).map(e => e.name), [],
      '夹具中应已无 command 档条目（否则反例证明的不是「分布被锁住」）')
    assert.throws(() => assertMatrixConfigs(mutated), /command 档/,
      '把 command 档段全部切到 TAP 档后必须红：v3-entry/storage 会被 fail-closed 守卫判常红（语义损失）、' +
      '另两段会静默丢检出，且分布漂移必须有人看见')
  }
}
console.log('✅ stryker.tap.config.js：报告路径为 stryker 默认、runner 契约（testRunner=tap / coverageAnalysis=perTest / tap.testFiles 非空）均已锁（靶向反例已锁）；mutation.yml 矩阵逐段 config 齐备、文件真实存在、恰 v3-entry/storage/qinglong-push/check-deps 四段 command 档，且消费点逐字用 $' + '{' + '{ matrix.config }}（靶向反例已锁）')

// ── 4. test_app.js 的 `--only` 过滤契约（EXEC-D T10）──────────
// 背景：test_app.js 的 `--only=<子串>` 曾**静默失效**——旧实现用 process.argv.indexOf('--only')
// 定位，等号写法下没有独立的 '--only' 元素 → 返回 -1 → 不过滤、照跑全部用例；而 test_app_p.js
// 并行失败时打印的定位提示正是这个等号写法，于是「最需要快速定位的时刻」反而触发全量重跑。
// 过滤失效此前无门禁可拦，是因为跳过同样计入 passed（passed 恒等于用例总数）⇒ 过滤静默失效时
// 输出与「正常全量跑」完全同形。test_app.js 现已打印「实际执行 N 例，过滤跳过 M 例」，
// 本段据此把契约固定为可证伪断言：等号形式**真的只跑匹配用例**，其余跳过且不计失败。
{
  const appSrc = fs.readFileSync('test_app.js', 'utf8')
  // 期望值由 test_app.js 源码现算（与 test_app_p.js 同名提取口径），不写死用例数：
  // 增删用例不会误红，而「--only 被忽略」会把实际执行数放大到 total → 立即红。
  const allNames = [...appSrc.matchAll(/await test\((['"])(.*?)\1,/g)].map(m => m[2])
  const FILTER = '空数据'
  const matched = allNames.filter(n => n.includes(FILTER)).length
  const total = allNames.length
  assert.ok(total > 1, `test_app.js 应提取到多条用例（实得 ${total}）`)
  assert.ok(matched >= 1, `作为过滤契约样本的子串「${FILTER}」必须至少匹配一条用例（消失即断言失去意义，需换样本）`)
  assert.ok(matched < total, `过滤样本须非全体匹配（matched=${matched} / total=${total}），否则断言区分不出过滤是否生效`)
  // XBK_PARALLEL_ID：让被测进程走独立缓存目录。`--only` 模式按设计跳过自清理（避免删掉并行进程
  // 正在用的缓存），故必须在此收尾删除，避免污染仓库 xianbaoku_cache 影响后续套件。
  const probeId = `only_probe_${process.pid}_${Date.now()}`
  const probeCache = path.join(__dirname, `xianbaoku_cache_p${probeId}`)
  let run
  try {
    run = spawnSync(process.execPath, [path.join(__dirname, 'test_app.js'), `--only=${FILTER}`],
      { encoding: 'utf8', cwd: __dirname, timeout: 300000, env: { ...baseEnv, XBK_PARALLEL_ID: probeId } })
  } finally {
    fs.rmSync(probeCache, { recursive: true, force: true })
  }
  assert.ok(!run.error, `test_app.js --only= 子进程未能正常退出: ${run.error && run.error.message}`)
  assert.strictEqual(run.status, 0,
    `node test_app.js --only=${FILTER} 应 exit 0（其余用例跳过，不计失败）:\n${run.stdout}\n${run.stderr}`)
  const stat = /实际执行 (\d+) 例，过滤跳过 (\d+) 例/.exec(run.stdout || '')
  assert.ok(stat, '--only= 过滤未生效：输出缺少「实际执行 N 例，过滤跳过 M 例」统计' +
    `（等号写法被忽略时会照跑全部 ${total} 例）:\n${(run.stdout || '').slice(-800)}`)
  assert.strictEqual(Number(stat[1]), matched, `--only=${FILTER} 实际执行数应等于源码中匹配的用例数`)
  assert.strictEqual(Number(stat[2]), total - matched, '过滤跳过数应为用例总数减匹配数')
  console.log('✅ test_app.js `--only=<子串>` 过滤契约：等号形式只跑匹配用例，其余跳过不计失败')
}

console.log(`✅ SKIP_SUITES（${skips.length} 项）与 test.yml 显式步骤双向一致，且未知条目会失败`)
console.log('✅ 零套件守卫：SKIP_SUITES 全覆盖（run_unit_tests.js）与空注册表（run_tests.js）均非 0 退出')
console.log('✅ 变异路径（run_mutation.js 子进程 + CI stryker step）均抑制 summary 重复追加')
