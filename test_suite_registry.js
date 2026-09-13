'use strict'

// 注册表元校验（C5）：根目录每个 test_*.js 都必须在 test_suites.js 的 SUITES 中注册。
// 背景：run_tests.js / run_unit_tests.js 都只遍历 SUITES —— 新增一个 test_*.js 却忘记注册，
// CI 永远不会执行它，且没有任何东西会报警（#131 的 test_tag_validator.js 就这样「测了等于没测」，
// 直到下一个提交 #132 才补进 SUITES）。本套件把「新文件必须注册」变成 CI 会执行、失败会红的门禁。
// 运行方式：node test_suite_registry.js（exit 0 = 通过；断言抛出即非 0 退出）。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { SUITES } = require('./test_suites')

// 仓库根 = 本文件所在目录（__dirname）：不依赖 cwd，CI 直跑、run_unit_tests.js 子进程、
// run_mutation.js 的 copyProject 沙箱（会把全部 test_*.js 与 test_suites.js 复制到沙箱根）三种场景都成立。
const ROOT = path.resolve(__dirname)
// 与 copyProject（run_mutation.js:101 `/^test_.*\.js$/`）同一口径的「根目录测试文件」判定
const TEST_FILE_RE = /^test_.*\.js$/

// 白名单：有意不注册进 SUITES 的根目录 test_*.js。当前只需要这 2 个，请保持最小。
// ⚠️ 新增白名单条目必须在本数组内用注释写明理由（为什么它由别处覆盖 / 为什么它不属于本门禁）；
//    白名单不是「静默忽略」——「新增文件但忘了注册」一定红，只有显式加名才放行；条目一旦陈旧
//    （文件不存在，或该文件已注册进 SUITES）本套件会报错要求删除，防止留下永久盲区。
const REGISTRY_EXEMPTIONS = [
  // test_app.js：由 CI 显式步骤覆盖 —— .github/workflows/test.yml 的「集成测试（串行完整版，
  // 仅并行失败时兜底运行）」步骤跑 `npm run test:app:serial`（package.json 中该脚本 = node test_app.js）；
  // SUITES 里的 test_app_p.js 是它的并行调度版（integration: true），见 test_suites.js 该条目上方注释。
  'test_app.js',
  // test_suites.js：注册表自身，不是测试套件（只导出 SUITES，无断言可跑），要求它注册自己属于自指。
  'test_suites.js'
]

// 双向对账（纯函数：exists 由调用方注入，真实运行查磁盘，自测注入合成结果，避免两份口径漂移）
function reconcile (diskTestFiles, registeredFiles, exemptions, exists) {
  const registeredSet = new Set(registeredFiles)
  const exemptSet = new Set(exemptions)
  return {
    // ① 磁盘上有、SUITES 里没有、也不在白名单 → 漏注册（本门禁的核心，必须红）
    unregistered: diskTestFiles.filter(f => !registeredSet.has(f) && !exemptSet.has(f)),
    // ② SUITES 里有、磁盘上找不到 → 幽灵条目（执行时必然 ENOENT，而报错不会指明是清单漂移）
    ghosts: registeredFiles.filter(f => !exists(f)),
    // ③ 白名单条目已失效（文件不存在，或已注册进 SUITES）→ 陈旧白名单，白名单必须保持最小
    staleExemptions: exemptions.filter(f => !diskTestFiles.includes(f) || registeredSet.has(f))
  }
}

// 漏注册的失败信息：列出文件名 + 可直接照抄的条目 + 「请把 X 加入 test_suites.js」提示
function unregisteredHint (files) {
  return '以下根目录测试文件未在 test_suites.js 的 SUITES 中注册，CI 永远不会执行（测了等于没测）：\n' +
    files.map(f => `  - ${f}：请把 { name: '…', file: '${f}', desc: '…' } 加入 test_suites.js 的 SUITES`).join('\n') +
    '\n（若确实有意不注册，必须在本文件 REGISTRY_EXEMPTIONS 显式加名并写明理由，不得静默放行）'
}

const byName = (a, b) => a.localeCompare(b) // 显式比较函数：默认 sort 的字符串序不保证稳定可预期
const diskTestFiles = fs.readdirSync(ROOT).filter(f => TEST_FILE_RE.test(f)).sort(byName)
const registeredFiles = [...new Set(SUITES.map(s => s.file))]
assert.ok(registeredFiles.length > 0, 'SUITES 不应为空（test_suites.js 需导出已注册套件清单）')

const { unregistered, ghosts, staleExemptions } =
  reconcile(diskTestFiles, registeredFiles, REGISTRY_EXEMPTIONS, f => fs.existsSync(path.join(ROOT, f)))

// ① 漏注册：新文件忘记注册时在这里红，并给出文件名与「请加入 test_suites.js」提示
assert.deepStrictEqual(unregistered, [], unregisteredHint(unregistered))

// ② 幽灵条目：清单指向不存在的文件（拼错/重命名/删除后忘了改清单）
assert.deepStrictEqual(ghosts, [],
  `test_suites.js 注册了不存在的文件（幽灵条目，执行时必然 ENOENT）：${ghosts.join(', ')}\n` +
  '请修正这些条目：改回真实文件名，或从 SUITES 删除')

// ③ 陈旧白名单：重命名/已注册后必须删除对应条目，否则白名单会越攒越大而失去意义
assert.deepStrictEqual(staleExemptions, [],
  `REGISTRY_EXEMPTIONS 含陈旧条目（文件不存在，或该文件已注册进 SUITES）：${staleExemptions.join(', ')}\n` +
  '白名单必须尽可能小，请删除这些条目')

// 校验逻辑自测：用合成数据把三个失败方向固定在门禁里（本机无法实跑，等价于对真实场景的推演固化）。
// ⚠️ exists 桩的语义必须与用例语境一致，否则 ghosts 会被桩本身污染（曾经用 () => false 笼统表示
//    「无文件」，结果所有已注册文件都被判成幽灵——本块桩全部显式命名语义，判断式桩只用于制造幽灵的用例）。
{
  const allExists = () => true // 桩：注册文件都在磁盘上（用于「不报幽灵」的语境）
  // 情形②：假设新增 test_foo.js 未注册 → 必须报漏注册；文件都存在时不得误报幽灵
  const missing = reconcile(['test_suites.js', 'test_foo.js'], ['test_suites.js'], ['test_suites.js'], allExists)
  assert.deepStrictEqual(missing.unregistered, ['test_foo.js'], '未注册的新增 test_*.js 必须报漏注册')
  assert.deepStrictEqual(missing.ghosts, [], '文件都存在时不应报幽灵条目')

  // 情形③：假设 SUITES 有一条指向不存在的文件 → 必须报幽灵条目
  // （判断式桩：只有 test_suites.js 真实存在，test_gone.js 不存在 → 该条目必被判幽灵）
  const ghost = reconcile(['test_suites.js'], ['test_suites.js', 'test_gone.js'], ['test_suites.js'],
    f => f === 'test_suites.js')
  assert.deepStrictEqual(ghost.ghosts, ['test_gone.js'], '指向不存在文件的条目必须报幽灵')
  assert.deepStrictEqual(ghost.unregistered, [], '磁盘文件都已注册时不应报漏注册')

  // 情形①：全部已注册（磁盘上的测试文件都在清单内，其余走显式白名单）→ 三项均空 = 通过
  const allOk = reconcile(['test_app.js', 'test_suites.js', 'test_x.js'], ['test_x.js'],
    ['test_app.js', 'test_suites.js'], allExists)
  assert.deepStrictEqual(allOk.unregistered, [], '全部已注册（白名单外的文件都在清单里）时不应报漏注册')
  assert.deepStrictEqual(allOk.ghosts, [], '全部已注册且文件都存在时不应报幽灵')
  assert.deepStrictEqual(allOk.staleExemptions, [], '有效的白名单条目不应报陈旧')

  // 白名单语义：只对显式加名放行，且必须保持最小 —— 文件被注册进 SUITES 后条目即刻陈旧，
  // 文件被重命名/删除后条目同样陈旧（两种都要报错要求删除）。
  const exempted = reconcile(['test_app.js'], [], ['test_app.js'], allExists)
  assert.deepStrictEqual(exempted.unregistered, [], '显式白名单的文件不报漏注册')
  assert.deepStrictEqual(reconcile(['test_app.js'], ['test_app.js'], ['test_app.js'], allExists).staleExemptions,
    ['test_app.js'], '已注册进 SUITES 的白名单条目必须报陈旧（白名单保持最小）')
  // 白名单里的文件已不存在（重命名/删除）：diskTestFiles 里没有它 → 必须报陈旧
  assert.deepStrictEqual(reconcile(['test_suites.js'], [], ['test_renamed.js'], allExists).staleExemptions,
    ['test_renamed.js'], '白名单里的文件不存在（重命名/删除）必须报陈旧')

  // 桩语义自检：判断式桩返回 false 时该注册条目必须被判为幽灵 ——
  // 固化「ghosts 由注入的 exists 决定」，防止再写出桩与期望自相矛盾的用例
  assert.deepStrictEqual(reconcile(['test_x.js'], ['test_x.js'], [], () => false).ghosts, ['test_x.js'],
    'exists 桩返回 false 时该注册条目必须被判为幽灵（桩语义自检）')
  console.log('✅ 校验逻辑自测通过（漏注册 / 幽灵条目 / 白名单陈旧 三个失败方向）')
}

console.log(`✅ 根目录 ${diskTestFiles.length} 个 test_*.js 与 SUITES ${registeredFiles.length} 条注册双向一致（白名单 ${REGISTRY_EXEMPTIONS.length} 个：${REGISTRY_EXEMPTIONS.join(', ')}）`)
