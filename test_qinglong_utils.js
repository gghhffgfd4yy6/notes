'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  shouldAutoInstallDependencies,
  ensureDependencies,
  intervalMs,
  retryBackoffMs,
  runDryRunOnce,
  nodeVersionWarning
} = require('./qinglong/xbk_push')

// console 三路的**唯二**允许改写点（C5-063）：基线在这里取一次，捕获函数必须在 finally 里还原到基线。
// 旧写法在两个并发的顶层 IIFE 里各改一次 console，前半段的静音正好罩住后半段的同步前缀 ⇒ 后半段的
// 完成行与失败输出被吞掉（实测：整套只打印一条 OK）。
const NATIVE_CONSOLE = Object.freeze({ log: console.log, warn: console.warn, error: console.error })
async function captureConsole (fn) {
  const logs = []
  const warns = []
  const errs = []
  console.log = (...a) => { logs.push(a.join(' ')) }
  console.warn = (...a) => { warns.push(a.join(' ')) }
  console.error = (...a) => { errs.push(a.join(' ')) }
  let value
  try {
    value = await fn()
  } finally {
    console.log = NATIVE_CONSOLE.log
    console.warn = NATIVE_CONSOLE.warn
    console.error = NATIVE_CONSOLE.error
  }
  return { value, logs, warns, errs }
}

// 第一段：纯函数 + ensureDependencies 的进程内断言（依赖恢复的边界分支在文末的子进程探针里）。
const runUnitChecks = async () => {
  // 导出面守卫（C5-060 去重后仍需要这个符号：真正调用它的是文末的子进程探针，这里是「本套件确实在测它」的
  // 显式声明，删掉导出一行即红——否则误删 import 后本套件会安静地只剩探针那一侧）。
  assert.strictEqual(typeof ensureDependencies, 'function', 'ensureDependencies 必须由 qinglong/xbk_push 导出')

  // ===== shouldAutoInstallDependencies =====
  assert.strictEqual(shouldAutoInstallDependencies({ XBK_AUTO_INSTALL_DEPS: '1' }), true, '设置为 1 应返回 true')
  assert.strictEqual(shouldAutoInstallDependencies({ XBK_AUTO_INSTALL_DEPS: '0' }), false, '设置为 0 应返回 false')
  assert.strictEqual(shouldAutoInstallDependencies({ XBK_AUTO_INSTALL_DEPS: '' }), false, '空串应返回 false')
  assert.strictEqual(shouldAutoInstallDependencies({}), false, '未设置应返回 false')
  assert.ok(!shouldAutoInstallDependencies(null), 'null env 应返回 falsy（env && 短路）')
  // 注：不传参数（undefined）会触发默认参数 process.env，依赖宿主机环境，
  // 故不单独测；`{}` 已覆盖"未设置该变量时返回 false"的语义。

  // ===== intervalMs(num) =====
  // num(envValue, defaultValue) 模拟
  assert.strictEqual(intervalMs(() => 5000), 5000, '有效值应直接返回')
  assert.strictEqual(intervalMs(() => 0), 0, '0 应返回 0（>= 0）')
  assert.strictEqual(intervalMs(() => Number.NaN), 10000, 'NaN 应回退默认 10000')
  assert.strictEqual(intervalMs(() => Infinity), 10000, 'Infinity 应回退默认')
  assert.strictEqual(intervalMs(() => -1), 10000, '负值应回退默认')
  assert.strictEqual(intervalMs(() => 'abc'), 10000, '字符串应回退默认')

  // ===== retryBackoffMs(count, env) =====
  // 公式：min(cap, 1000 * 2^(min(count,31)-1))
  assert.strictEqual(retryBackoffMs(1), 1000, 'count=1 → 1000*2^0=1000')
  assert.strictEqual(retryBackoffMs(2), 2000, 'count=2 → 1000*2^1=2000')
  assert.strictEqual(retryBackoffMs(3), 4000, 'count=3 → 1000*2^2=4000')
  assert.strictEqual(retryBackoffMs(4), 8000, 'count=4 → 8000')
  assert.strictEqual(retryBackoffMs(10), 512000, 'count=10 → 1000*2^9=512000')
  // 默认 cap = 30*60*1000 = 1800000
  assert.strictEqual(retryBackoffMs(31), 1800000, 'count=31 → 1000*2^30 远超 cap，应被 cap 限制为 1800000')
  assert.strictEqual(retryBackoffMs(100), 1800000, 'count 很大应被 cap 限制')
  // 自定义 cap
  assert.strictEqual(retryBackoffMs(5, { XBK_RETRY_BACKOFF_CAP_MS: '2000' }), 2000, '自定义 cap=2000 应限制 count=5（32000）到 2000')
  assert.strictEqual(retryBackoffMs(2, { XBK_RETRY_BACKOFF_CAP_MS: '2000' }), 2000, 'count=2=2000 不超过 cap=2000')
  assert.strictEqual(retryBackoffMs(1, { XBK_RETRY_BACKOFF_CAP_MS: '500' }), 500, 'count=1=1000 超过 cap=500 应限制')
  // 无效 cap 回退默认
  assert.strictEqual(retryBackoffMs(2, { XBK_RETRY_BACKOFF_CAP_MS: 'abc' }), 2000, '无效 cap 应回退默认')
  assert.strictEqual(retryBackoffMs(2, { XBK_RETRY_BACKOFF_CAP_MS: '0' }), 2000, 'cap=0 应回退默认（<1）')
  assert.strictEqual(retryBackoffMs(2, null), 2000, 'null env 应回退默认')

  // ===== ensureDependencies：唯一 harness = 子进程探针（C5-060 去重） =====
  // 这里原先还有一份「进程内 mock 直调」的副本（~120 行），与文件末尾的子进程探针各覆盖一遍同一个
  // ensureDependencies，两份的断言维度不同：直调能断言返回值/调用序，探针能看 spawns/console/退出码，
  // 而它们各自漏掉的分支不会互相提醒（实测：把生产里的「未设置 XBK_AUTO_INSTALL_DEPS 即抛错」整段删掉，
  // 只留探针的版本仍全绿）。去重口径＝**先迁维度、再删副本**：直调独有的两条（未开自动安装、npm 安装
  // 非零退出）已并入探针的 deps.autoInstallOff / deps.installFails，其余维度由 deps.* 具名场景逐条覆盖
  // （okBoth / fixedFallback 锁 QX-01 的「常规解析优先 + 固定路径兜底」，missingGotWithLock /
  // missingGotNoLock 锁 QX-04 的「有锁 ci、无锁 install --no-package-lock」）。断言一条没少。

  // ===== QX-02：--dry-run 一次性执行 =====
  // runDryRunOnce 只跑一轮：成功 → 0，全失败 → 1（不做常驻退避重试）。
  // 输出用 captureConsole 局部捕获（C5-063）：旧写法直接 `console.log = () => {}` 静音整个进程，
  // 在 `await` 窗口里连并发段的输出一起吞掉；现在只包住这两次调用，finally 还原到模块加载时的基线。
  let dryRunCalls = 0
  const dryRun = await captureConsole(async () => {
    const code = await runDryRunOnce({ run: async () => { dryRunCalls += 1; return { total: 3, filtered: 1, pushed: 0, failed: 0 } } })
    const failCode = await runDryRunOnce({ run: async () => ({ total: 1, pushed: 0, failed: 1, failures: [{ code: 'E_NET', statusCode: 503 }] }) })
    return { code, failCode }
  })
  const dryRunCode = dryRun.value.code
  const dryRunFailCode = dryRun.value.failCode
  assert.strictEqual(dryRunCalls, 1, 'dry-run 只能调用 app.run() 一次（一次性执行）')
  assert.strictEqual(dryRunCode, 0, '单轮成功应返回退出码 0')
  assert.strictEqual(dryRunFailCode, 1, '单轮全失败应返回退出码 1')
  assert.deepStrictEqual(dryRun.logs, ['dry-run 单轮完成：共 3 条，过滤 1 条，未推送、未写成功缓存'],
    '捕获范围内必须能看到成功轮的完成行（证明捕获确实包住了被测调用，且没漏到宿主 stdout）')
  assert.strictEqual(dryRun.errs.length, 1, '失败轮必须经 console.error 报一条根因')
  assert.strictEqual(console.log, NATIVE_CONSOLE.log, 'captureConsole 必须把 console.log 还原到基线（不得泄漏到后续代码）')

  // 接线断言（与 test_cli.js:31 同一种源码级手法）：main() 的 --dry-run 分支必须调用 runDryRunOnce
  // 并 return，绝不能继续落到 runResident(...)。回退旧行为（只设 XBK_DRY_RUN=1 即常驻）时本断言必红。
  // **变异沙箱兼容（PR #154，两次实测订正）**：Stryker 插桩会把条件改写成
  // `if (stryNS_9fa48() || hasArg('--dry-run'))`，并会在语句之间插入**任意长度**的辅助代码。因此：
  //   ① 不能要求 `if (` 与条件紧邻（第一版写法，沙箱必红）；
  //   ② 也**不能设任何字符距离上限**（第二版写法 `oneShotIdx - guardIdx < 600`，沙箱里插桩后必然超限）；
  //   ③ 更不能断言任何**带引号的字面量邻接**（第三版写法 `includes("hasArg('--dry-run')")`，沙箱必红）
  //      —— Stryker 的 StringLiteral 变异器会把字符串字面量本身改写成
  //      `(stryMutAct_9fa48(...) ? "" : "--dry-run")` 形态，于是 `hasArg('--dry-run')` 这种原文序列不复存在。
  // 唯一稳定可用的是「**标识符/调用的存在性与相对顺序**」（标识符不被变异、语句间插入代码不影响 indexOf）：
  // 要求 `runDryRunOnce(app)` 存在，且其后的 `return` 出现在 `runResident(` 之前。删掉该一次性分支、
  // 删掉那个 return、或让它继续落到常驻循环，本断言都会红。
  const pushSource = fs.readFileSync(path.join(__dirname, 'qinglong', 'xbk_push.js'), 'utf8')
  const oneShotIdx = pushSource.indexOf('runDryRunOnce(app)')
  assert.ok(oneShotIdx >= 0, '--dry-run 分支必须调用一次性 runDryRunOnce(app)（不得落入常驻循环）')
  const tail = pushSource.slice(oneShotIdx)
  const retIdx = tail.indexOf('return')
  const residentIdx = tail.indexOf('runResident(')
  assert.ok(retIdx >= 0 && (residentIdx === -1 || retIdx < residentIdx),
    'runDryRunOnce(app) 之后必须在遇到 runResident( 之前 return（不得落入常驻循环）')
  // 常驻路径仍被调用（防"删掉常驻"式假修复）。用文本匹配而非正则：`runResident(app` 只命中**调用**
  // （定义处是 `runResident (app, controller)`，带空格），且不受插桩插入代码/换行差异影响。
  assert.ok(pushSource.includes('runResident(app'), '常驻路径必须仍然存在（防"删掉常驻"式假修复）')

  // ===== QX-06：完整 re2 engines 范围的 Node 版本告警 =====
  assert.strictEqual(nodeVersionWarning('22.22.2'), null, '22.x engines 下界不应告警')
  assert.strictEqual(nodeVersionWarning('24.15.0'), null, '24.x engines 下界不应告警')
  assert.strictEqual(nodeVersionWarning('26.0.0'), null, '26.x 及以上不应告警')
  assert.strictEqual(nodeVersionWarning('v26.1.2+build.7'), null, '合法 build metadata 不应改变稳定版本范围判定')
  for (const version of ['24.15.0-rc.1', '26.0.0-nightly20261008abcdef', '22.22.2-beta.1', '26.0', 'not-a-version']) {
    assert.match(String(nodeVersionWarning(version)), /不满足 re2\/package\.json engines 要求/, `${version} 不满足稳定 Node engines 时必须告警`)
  }
  assert.match(String(nodeVersionWarning('23.0.0')), /不满足 re2\/package\.json engines 要求/, '23.x 不在 re2 支持范围内应告警')
  assert.match(String(nodeVersionWarning('25.0.0')), /不满足 re2\/package\.json engines 要求/, '25.x 不在 re2 支持范围内应告警')
  assert.match(String(nodeVersionWarning('24.14.0')), /不满足 re2\/package\.json engines 要求/, '24.0–24.14 不满足下界应告警')
  assert.match(String(nodeVersionWarning('22.22.1')), /不满足 re2\/package\.json engines 要求/, '低于 22.x 下界应告警')
  assert.match(String(nodeVersionWarning('20.11.0')), /不满足 re2\/package\.json engines 要求/, '主版本低于 22 应告警')

  // ===== QX-08：--status 的缓存目录必须与生产同源（不再硬编码 path.join(ROOT,'xianbaoku_cache')）=====
  // 反例（改动前）：生产在默认目录被普通文件占位 / realpath 逃出根目录时会回退 .xbk_cache_safe，
  // 而 --status 照读默认目录 → 状态实际写在备用目录时静默报「缺失」。这里用假 fs 不触碰真实文件
  // 系统，直接对拍「--status 解析结果 === 生产 resolveCacheDirInRoot 结果」；把 resolveCacheDirInRoot
  // 调用换成硬编码 join 后本断言必红。
  const { resolveCacheDirInRoot } = require('./xbk_message_store')
  const { statusCacheDir } = require('./qinglong/xbk_push')
  const CACHE_ROOT = __dirname
  const defaultCachePath = path.join(CACHE_ROOT, 'xianbaoku_cache')
  const safeCachePath = path.join(CACHE_ROOT, '.xbk_cache_safe')
  const makeStatusFs = (map) => ({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(map, p),
    lstatSync: (p) => ({ isDirectory: () => map[p] === 'dir' }),
    realpathSync: (p) => (map[p] && typeof map[p] === 'object' && map[p].real ? map[p].real : p)
  })
  const shared = (fsImpl) => resolveCacheDirInRoot({ fs: fsImpl, path, root: CACHE_ROOT, raw: 'xianbaoku_cache', fallback: 'xianbaoku_cache' })

  // ① 未设置 XBK_CACHE_DIR：与生产同源（含「默认目录被文件占位 → 回退 .xbk_cache_safe」这一分支）
  const shadowed = makeStatusFs({ [CACHE_ROOT]: 'dir', [defaultCachePath]: 'file' })
  const statusShadowed = statusCacheDir({ env: {}, fs: shadowed, path, root: CACHE_ROOT })
  assert.strictEqual(statusShadowed, safeCachePath, '默认目录被普通文件占位时 --status 应回退 .xbk_cache_safe（硬编码实现在此处返回默认目录）')
  assert.strictEqual(statusShadowed, shared(shadowed), '--status 解析必须与生产同一实现逐值一致')
  const normalFs = makeStatusFs({ [CACHE_ROOT]: 'dir', [defaultCachePath]: 'dir' })
  assert.strictEqual(statusCacheDir({ env: {}, fs: normalFs, path, root: CACHE_ROOT }), defaultCachePath, '默认目录正常时仍读默认目录')
  assert.strictEqual(statusCacheDir({ env: {}, fs: normalFs, path, root: CACHE_ROOT }), shared(normalFs), '正常路径同样必须与生产一致')

  // ② XBK_CACHE_DIR 为绝对路径：文档契约（README「状态文件写在别处」）允许指向根外，原样采纳
  const outside = path.join(path.sep, 'mnt', 'elsewhere', 'cache')
  assert.strictEqual(statusCacheDir({ env: { XBK_CACHE_DIR: outside }, fs: normalFs, path, root: CACHE_ROOT }), outside,
    '绝对路径覆盖必须原样采纳（不被根内校验改写）')

  // ②b 尾随空格（D2-S7）：MessageStore 对 XBK_CACHE_DIR 做 trim 后才判绝对路径，
  // --status 不 trim 会让读写两侧解析成不同目录（运行写 A、状态读 B）。
  const padded = `  ${outside}  `
  assert.strictEqual(statusCacheDir({ env: { XBK_CACHE_DIR: padded }, fs: normalFs, path, root: CACHE_ROOT }), outside,
    '尾随/前导空格必须 trim 后与运行侧同源（修前会把带空格的串当另一个目录）')

  // ③ XBK_CACHE_DIR 为相对路径：告警 + 按同源规则解析默认目录（告警文案仍带生效目录）
  const relativeFs = makeStatusFs({ [CACHE_ROOT]: 'dir', [defaultCachePath]: 'file' })
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => { warns.push(args.join(' ')) }
  let relativeDir
  try {
    relativeDir = statusCacheDir({ env: { XBK_CACHE_DIR: 'relative/cache' }, fs: relativeFs, path, root: CACHE_ROOT })
  } finally { console.warn = origWarn }
  assert.strictEqual(relativeDir, safeCachePath, '相对路径被忽略后应回退同源解析出的默认目录')
  assert.ok(warns.some(w => w.includes('XBK_CACHE_DIR 不是绝对路径') && w.includes('relative/cache') && w.includes(safeCachePath)),
    `相对路径应告警并带上生效目录，实际告警：${JSON.stringify(warns)}`)

  // ④ CLI 端到端：未设置覆盖时显示默认目录；设置绝对覆盖时也必须显示被读取的自定义目录。
  {
    const env = { ...process.env }
    delete env.XBK_CACHE_DIR
    const r = spawnSync(process.execPath, [path.join(__dirname, 'qinglong', 'xbk_push.js'), '--status'], {
      cwd: __dirname, encoding: 'utf8', env
    })
    assert.strictEqual(r.status, 0, `--status 应独立于 got/re2 成功退出，实际 status=${r.status} stderr=${r.stderr}`)
    assert.match(String(r.stdout), /缓存目录：\S+（未使用 XBK_CACHE_DIR；/, `--status 应显式暴露默认缓存目录与配置口径，实际 stdout=${r.stdout}`)
    assert.match(String(r.stdout), /xbk-push 运行状态/, '--status 仍应输出状态面板')
  }
  {
    const statusDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xbk-status-override-'))
    try {
      const report = { date: '2041-09-23', runs: 37, pushed: 41 }
      fs.writeFileSync(path.join(statusDir, 'report.state'), JSON.stringify(report))
      const r = spawnSync(process.execPath, [path.join(__dirname, 'qinglong', 'xbk_push.js'), '--status'], {
        cwd: __dirname, encoding: 'utf8', env: { ...process.env, XBK_CACHE_DIR: statusDir }
      })
      assert.strictEqual(r.status, 0, `绝对覆盖下 --status 应成功，实际 status=${r.status} stderr=${r.stderr}`)
      assert.ok(String(r.stdout).includes(`缓存目录：${statusDir}（使用 XBK_CACHE_DIR）`), `--status 必须显示被采纳的绝对路径，实际 stdout=${r.stdout}`)
      assert.ok(String(r.stdout).includes('日报：正常 | 2041-09-23 | 37 轮 | 推送成功：41 条'),
        `--status 必须从 XBK_CACHE_DIR 读取 report.state，而不只是打印覆盖路径，实际 stdout=${r.stdout}`)
    } finally { fs.rmSync(statusDir, { recursive: true, force: true }) }
  }

  console.log('test_qinglong_utils OK')
}

// ===== 追加：qinglong/xbk_push.js「入口」契约回归（QX-02/QX-04/QX-05/QX-08/QX-09）=====
// 断言对着 SYSTEM_CONTRACT.md 的「入口」条：退出码语义、失败文案、可恢复判定、恢复命令、
// 包名白名单 fail-closed、缓存目录口径。可观测输出（console 三路/退出码）一律在独立子进程取——
// 本段确实不读宿主 console，但**上面那一段会临时改写 console**，所以两段必须串行（见文件末尾的
// runUnitChecks().then(runEntryContractChecks)）：并发时本段的同步前缀会落在上一段的捕获窗口里，
// 完成行与失败诊断都会被吞掉（C5-063 实测）。
const runEntryContractChecks = async () => {
  // 宿主 console 基线核对（C5-063）：上面那段用 captureConsole 临时换掉三路 console，必须在它 resolve
  // 之前还原。这条断言是「两段串行 + 捕获成对」的可执行判据——两段重新并发时它会立刻红（实测于旧结构）。
  assert.strictEqual(console.log, NATIVE_CONSOLE.log, '上一段的 console 捕获必须在 await 前后成对还原（C5-063）')
  assert.strictEqual(console.error, NATIVE_CONSOLE.error, '上一段的 console.error 捕获必须已还原（C5-063）')
  const ENTRY = path.join(__dirname, 'qinglong', 'xbk_push.js')
  const CHILD = `'use strict'
const path = require('path')
const mod = require('./qinglong/xbk_push')
const ROOT = path.resolve(__dirname)
const NODE_MODULES = path.join(ROOT, 'node_modules')
const OK_MSG = '检测到 Node.js 依赖或 re2 原生模块未完整安装，已按 XBK_AUTO_INSTALL_DEPS=1 执行恢复...'
const brief = (e) => (e ? { message: e.message, code: e.code, name: e.name } : null)
const cap = async (fn) => {
  const logs = []
  const warns = []
  const errs = []
  const rl = console.log
  const rw = console.warn
  const re = console.error
  console.log = (...a) => logs.push(a.join(' '))
  console.warn = (...a) => warns.push(a.join(' '))
  console.error = (...a) => errs.push(a.join(' '))
  let value = null
  let thrown = null
  try { value = await fn() } catch (e) { thrown = e } finally { console.log = rl; console.warn = rw; console.error = re }
  return { value: value === undefined ? null : value, thrown: brief(thrown), logs: logs, warns: warns, errs: errs }
}
const mknf = (n) => Object.assign(new Error("Cannot find module '" + n + "'"), { code: 'MODULE_NOT_FOUND' })
const mkdl = () => Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' })
const mkspec = (v, k) => {
  if (v === 'ok') return 'ok'
  if (v === 'nf') return mknf(k)
  if (v === 'dlopen') return mkdl()
  return Object.assign(new Error(v.message), { code: v.code })
}
const deps = async (spec) => {
  const calls = []
  const spawns = []
  let n = 0
  const bare = {}
  const fixed = {}
  Object.keys(spec.bare || {}).forEach((k) => { bare[k] = mkspec(spec.bare[k], k) })
  Object.keys(spec.fixed || {}).forEach((k) => { fixed[k] = mkspec(spec.fixed[k], k) })
  const plan = spec.plan || []
  const requireFn = (name) => {
    if (spec.nullThrow) throw null
    calls.push(name)
    const sep = 'node_modules' + path.sep
    const isFixed = name.indexOf(sep) >= 0
    const key = isFixed ? name.split(sep).pop() : name
    const table = isFixed ? fixed : bare
    const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
    if (hit === 'ok') return {}
    throw hit || mknf(name)
  }
  const spawnSyncFn = (cmd, args, opts) => {
    spawns.push({ cmd: cmd, args: args, cwd: opts && opts.cwd, stdio: opts && opts.stdio, timeout: opts && opts.timeout })
    const step = plan[n] || {}
    n += 1
    // after: 安装/重建之后被测代码会再 load 一次——用它模拟「装完就好了」与「装完变成另一种错误」。
    if (step.after === 'eaccesGot') bare.got = { code: 'EACCES' }
    if (step.after === 'installed') { bare.got = 'ok'; bare.re2 = 'ok' }
    return step.result || { status: 0 }
  }
  const r = await cap(() => mod.ensureDependencies({
    requireFn: requireFn,
    spawnSyncFn: spawnSyncFn,
    // autoInstall:false 模拟「未设置 XBK_AUTO_INSTALL_DEPS」的部署（C5-060 迁移自旧直调副本的唯一维度之一）
    env: spec.autoInstall === false ? {} : { XBK_AUTO_INSTALL_DEPS: '1' },
    lockExists: () => spec.lock !== false
  }))
  r.calls = calls
  r.spawns = spawns
  return r
}
;(async () => {
  const okOf = (f, extra) => Object.assign({ failed: f.length || 1, pushed: 0, total: 1, failures: f }, extra || {})
  const dryCases = [
    { pushed: 1, failed: 0, total: 5, filtered: 2 },
    { pushed: 1, failed: 0, total: 'abc' },
    okOf([]),
    okOf([{ message: 'M1', code: 'ECODE', providerCode: 'P1', statusCode: 403, channel: 'CH1' }]),
    okOf([{ message: 'M2' }]),
    okOf([{ channel: 'CH9', message: 'M3' }]),
    okOf([{ statusCode: 502, message: 'M4' }]),
    okOf([{ message: 'MA' }, { code: 'CODEONLY' }, { providerCode: 'PONLY' }]),
    okOf([{ message: '', code: '' }])
  ]
  const out = { root: ROOT, nodeModules: NODE_MODULES, dry: [], deps: {}, cache: [], backoff: [], version: [] }
  for (let i = 0; i < dryCases.length; i += 1) out.dry.push(await cap(() => mod.runDryRunOnce({ run: async () => dryCases[i] })))
  // 场景一律具名（C5-062）：下标只是 push 顺序，不是契约。新增场景插在中间时，
  // 父进程的断言按名字取用，不会静默换人。
  out.deps.okBoth = await deps({ bare: { got: 'ok', re2: 'ok' } })
  out.deps.fixedFallback = await deps({ bare: { got: 'nf', re2: 'nf' }, fixed: { got: 'ok', re2: 'ok' } })
  out.deps.dlopenGot = await deps({ bare: { got: { code: 'ERR_DLOPEN_FAILED', message: 'dlopen failed' }, re2: 'ok' } })
  out.deps.nullThrow = await deps({ nullThrow: true })
  out.deps.missingGotWithLock = await deps({ bare: { got: 'nf', re2: 'ok' } })
  out.deps.missingGotNoLock = await deps({ bare: { got: 'nf', re2: 'ok' }, lock: false })
  out.deps.dlopenRe2 = await deps({ bare: { got: 'ok', re2: 'dlopen' } })
  out.deps.unrecoverableRe2 = await deps({ bare: { got: 'ok', re2: { code: 'EACCES', message: 'permission denied' } } })
  out.deps.rebuildSpawnError = await deps({ bare: { got: 'ok', re2: 'dlopen' }, plan: [{}, { result: { error: { message: 'EBOOM' } } }] })
  out.deps.rebuildExit7 = await deps({ bare: { got: 'ok', re2: 'dlopen' }, plan: [{}, { result: { status: 7 } }] })
  out.deps.gotEaccesAfterInstall = await deps({ bare: { got: 'nf', re2: 'ok' }, plan: [{ after: 'eaccesGot' }] })
  // C5-060：旧直调副本里有两个维度是子进程探针原先没覆盖的（auto-install 未开、npm 安装非零退出）。
  // 去重前先把它们迁进来，否则删掉副本就等于丢覆盖（实测：把生产里的「未设置自动安装即抛错」整段删掉，
  // 只留探针的版本仍然全绿）。
  out.deps.autoInstallOff = await deps({ bare: { got: 'nf', re2: 'ok' }, autoInstall: false })
  out.deps.installFails = await deps({ bare: { got: 'nf', re2: 'ok' }, plan: [{ result: { status: 4 } }] })
  // C5-060：安装子进程**自身**失败（spawn ENOENT，连退出码都没有）是 install.status 之外的另一条出口，
  // 生产用 if (install.error) throw install.error 单独兜住这条出口，与下面的非零退出分支是两条独立断言。旧直调副本用 installResult:{error} 锁的就是这条；
  // 只覆盖「非零退出」时，删掉那句 throw 后套件仍绿（实测变异体存活）。
  out.deps.installSpawnError = await deps({ bare: { got: 'nf', re2: 'ok' }, plan: [{ result: { error: { message: 'spawn ENOENT' } } }] })
  // 恢复**成功**的出口（QX-04 的正常路径）：装完依赖可加载 ⇒ 必须静默返回 undefined，既不 rebuild 也不报错。
  // 旧直调副本用 installed 翻转锁的就是这条出口；只留「装完仍不可用」的场景时，「装完一律报错」的变异体无一能杀。
  out.deps.installRecovers = await deps({ bare: { got: 'nf', re2: 'ok' }, plan: [{ after: 'installed' }] })
  out.deps.installRecoversNoLock = await deps({ bare: { got: 'nf', re2: 'ok' }, lock: false, plan: [{ after: 'installed' }] })
  out.cache.push(await cap(() => mod.statusCacheDir({ env: { XBK_CACHE_DIR: path.join(ROOT, 'abs-cache') } })))
  out.cache.push(await cap(() => mod.statusCacheDir({ env: {} })))
  out.cache.push(await cap(() => mod.statusCacheDir({ env: { XBK_CACHE_DIR: 'rel/cache' } })))
  out.backoff.push(mod.retryBackoffMs(1, { XBK_RETRY_BACKOFF_CAP_MS: '1' }))
  out.backoff.push(mod.retryBackoffMs(31, { XBK_RETRY_BACKOFF_CAP_MS: '1' }))
  out.backoff.push(mod.retryBackoffMs(1, { XBK_RETRY_BACKOFF_CAP_MS: '0.5' }))
  out.backoff.push(mod.retryBackoffMs(1, { XBK_RETRY_BACKOFF_CAP_MS: 'abc' }))
  out.version.push(mod.nodeVersionWarning('22.22.2'))
  out.version.push(mod.nodeVersionWarning('23.0.0'))
  out.version.push(mod.nodeVersionWarning('22.22.1'))
  out.version.push(mod.nodeVersionWarning('22'))
  process.stdout.write(JSON.stringify(out))
})().catch((e) => { process.stderr.write('CHILD_FAIL ' + (e && e.stack) + '\\n'); process.exit(1) })
`
  const probe = spawnSync(process.execPath, ['-'], {
    input: CHILD,
    encoding: 'utf8',
    cwd: __dirname,
    env: Object.assign({}, process.env, { TZ: 'UTC' }),
    timeout: 120000
  })
  assert.strictEqual(probe.status, 0, `子进程探针必须成功退出：status=${probe.status} err=${probe.error && probe.error.message} stdout=${String(probe.stdout).slice(0, 400)} stderr=${String(probe.stderr).slice(0, 400)}`)
  const d = JSON.parse(probe.stdout)
  const OK_MSG = '检测到 Node.js 依赖或 re2 原生模块未完整安装，已按 XBK_AUTO_INSTALL_DEPS=1 执行恢复...'
  const NODE_MODULES = d.nodeModules
  const ROOT = d.root

  // 用例表必须以**具名 key** 暴露（C5-062）：旧写法是 `d.deps[N]`，下标即契约——在中间插一条新场景，
  // 后面 30 多条断言会静默指向别的场景，且报错文案（`d.deps[7].thrown.code`）照样通顺，最难查。
  // 这条断言先于所有 deps 断言执行：本套件任何一次「按下标取场景」的回潮都会在这里红。
  assert.ok(d.deps && !Array.isArray(d.deps) && typeof d.deps === 'object',
    `ensureDependencies 用例表必须是以场景名称为 key 的对象（不得再用 d.deps[N] 的 push 顺序），实际类型：${Array.isArray(d.deps) ? 'Array' : typeof d.deps}`)

  // --- runDryRunOnce：退出码与一次性语义（--dry-run 单轮成功 0 / 失败 1，不做退避重试）---
  assert.strictEqual(d.dry[0].value, 0, '--dry-run 单轮成功必须返回退出码 0')
  assert.deepStrictEqual(d.dry[0].logs, ['dry-run 单轮完成：共 5 条，过滤 2 条，未推送、未写成功缓存'], '成功文案必须精确（杀 success 文案变异体）')
  assert.deepStrictEqual(d.dry[0].errs, [], '成功轮不得输出错误')
  assert.deepStrictEqual(d.dry[1].logs, ['dry-run 单轮完成：共 0 条，过滤 0 条，未推送、未写成功缓存'], 'total/filtered 非数值必须回退 0（杀 Number/||0 变异体）')
  assert.strictEqual(d.dry[2].value, 1, '单轮失败必须返回退出码 1')
  assert.deepStrictEqual(d.dry[2].logs, [], '失败轮不得落到成功分支（杀 !resultFailure 条件变异体）')

  // --- describeFailure 文案分支（信息只能来自 info.message / info.failures 的子项）---
  assert.deepStrictEqual(d.dry[2].errs, ['dry-run 单轮失败（ALL_PUSH_FAILED_UNKNOWN）：推送全部失败（原因未结构化）'], '聚合 info.message 必须落到文案')
  assert.deepStrictEqual(d.dry[3].errs, ['dry-run 单轮失败（PUSH_HAS_ONLY_PERMANENT_FAILURES）：CH1：M1（HTTP 403）'], '通道/原因/HTTP 状态必须按 channel：reason（HTTP n）拼接')
  assert.deepStrictEqual(d.dry[4].errs, ['dry-run 单轮失败（PUSH_HAS_RETRYABLE_FAILURE）：M2'], '仅有 message 的子失败不得被 || 变异体吞掉')
  assert.deepStrictEqual(d.dry[5].errs, ['dry-run 单轮失败（PUSH_HAS_RETRYABLE_FAILURE）：CH9：M3'], '无 statusCode 时不得拼出状态段')
  assert.deepStrictEqual(d.dry[6].errs, ['dry-run 单轮失败（PUSH_HAS_RETRYABLE_FAILURE）：M4（HTTP 502）'], '无 channel 时不得拼出通道段')
  assert.deepStrictEqual(d.dry[7].errs, ['dry-run 单轮失败（PUSH_HAS_RETRYABLE_FAILURE）：MA；[object Object]；[object Object]'], '多条失败必须以；连接且逐条保留')
  const mEmpty = /^dry-run 单轮失败（([^）]*)）：([\s\S]*)$/u.exec(d.dry[8].errs[0] || '')
  assert.notStrictEqual(mEmpty, null, '失败文案必须符合「dry-run 单轮失败（原因）：详情」格式')
  const emptyReason = mEmpty ? mEmpty[1] : ''
  const emptyDetail = mEmpty ? mEmpty[2] : ''
  for (const bad of ['', 'undefined', 'true', 'false', 'dry-run 单轮失败', `Error: ${emptyReason}`]) {
    assert.notStrictEqual(emptyDetail, bad, `空 parts 兜底不得输出占位符 ${JSON.stringify(bad)}`)
  }

  // --- ensureDependencies：Node 解析口径优先，解析不到才回退固定 node_modules 子路径 ---
  assert.strictEqual(d.deps.okBoth.thrown, null, '依赖齐备不得抛错')
  assert.deepStrictEqual(d.deps.okBoth.calls, ['got', 're2'], '两模块均可解析时只做裸解析（与 --check 同口径）')
  assert.deepStrictEqual(d.deps.okBoth.spawns, [], '已完整安装时不得触发安装')
  assert.strictEqual(d.deps.fixedFallback.thrown, null, '固定路径解析成功即视为已恢复')
  assert.deepStrictEqual(d.deps.fixedFallback.calls, ['got', path.join(NODE_MODULES, 'got'), 're2', path.join(NODE_MODULES, 're2')], '裸解析失败后必须回退到固定 node_modules 直接子路径')
  assert.deepStrictEqual(d.deps.fixedFallback.spawns, [], '固定路径命中时不得安装')
  assert.deepStrictEqual(d.deps.dlopenGot.calls, ['got', 're2', 're2', 'got', 're2'], '非 MODULE_NOT_FOUND 说明模块已定位，不得回退固定路径')
  assert.strictEqual(d.deps.dlopenGot.spawns.length, 1, 'ERR_DLOPEN_FAILED 属可恢复，必须触发一次恢复安装')
  assert.deepStrictEqual(d.deps.dlopenGot.warns, [OK_MSG], '恢复前必须打印与 --check 同源的恢复告警')
  assert.strictEqual(d.deps.nullThrow.thrown, null, 'load 的非模块错误判定必须先看 error 本身，不得解引用 null.code')
  assert.strictEqual(d.deps.nullThrow.spawns.length, 0, '抛非对象错误时不得进入安装')

  // --- 恢复命令：有锁文件用冻结 npm ci，缺锁文件退化为 install --no-package-lock，恢复后仍失败则忠实报错 ---
  assert.strictEqual(d.deps.missingGotWithLock.thrown && d.deps.missingGotWithLock.thrown.message, `依赖恢复后 got 仍不可用：Cannot find module '${path.join(NODE_MODULES, 'got')}'`, '恢复后仍不可用必须抛出带失败模块名的错误')
  assert.strictEqual(d.deps.missingGotWithLock.spawns.length, 1, '缺 got 只安装一次，不得多余重建')
  assert.strictEqual(d.deps.missingGotWithLock.spawns[0].cmd, 'npm', '恢复命令必须是 npm（非 win32 平台）')
  assert.deepStrictEqual(d.deps.missingGotWithLock.spawns[0].args, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', ROOT], '有 package-lock.json 时必须用冻结的 npm ci 且参数完整')
  assert.strictEqual(d.deps.missingGotWithLock.spawns[0].cwd, ROOT, '安装必须在项目根执行')
  assert.strictEqual(d.deps.missingGotWithLock.spawns[0].timeout, 120000, '安装必须有超时')
  assert.deepStrictEqual(d.deps.missingGotWithLock.warns, [OK_MSG], '有锁文件时不得输出退化 install 告警')
  assert.deepStrictEqual(d.deps.missingGotNoLock.warns, [OK_MSG, '未找到 package-lock.json，退化为 npm install --no-package-lock（建议按 README 用 npm ci 部署以冻结依赖版本）'], '缺锁文件必须显式告警退化')
  assert.deepStrictEqual(d.deps.missingGotNoLock.spawns[0].args, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', ROOT, '--no-package-lock'], '缺锁文件时必须 install 且不得生成新锁文件')
  assert.strictEqual(d.deps.dlopenRe2.spawns.length, 2, '先冻结安装，再只对仍不可用的 re2 执行一次 install-script 恢复')
  assert.strictEqual(d.deps.dlopenRe2.spawns[1].cmd, 'npm', 're2 恢复必须调用 npm')
  assert.deepStrictEqual(d.deps.dlopenRe2.spawns[1].args, ['rebuild', 're2'], 're2 恢复必须执行官方 install 生命周期以优先获取预编译包')
  assert.strictEqual(d.deps.dlopenRe2.thrown && d.deps.dlopenRe2.thrown.message, '依赖恢复后 re2 仍不可用：dlopen failed', 're2 仍不可用必须以 re2 忠实命名')
  assert.strictEqual(d.deps.unrecoverableRe2.spawns.length, 0, '不可恢复错误不得进入恢复流程')
  assert.deepStrictEqual(d.deps.unrecoverableRe2.warns, [], '未进入恢复流程不得打印恢复告警')
  assert.strictEqual(d.deps.unrecoverableRe2.thrown && d.deps.unrecoverableRe2.thrown.code, 'EACCES', '不可恢复错误必须原样抛出（只认 MODULE_NOT_FOUND/ERR_DLOPEN_FAILED）')
  assert.strictEqual(d.deps.rebuildSpawnError.thrown && d.deps.rebuildSpawnError.thrown.message, 'EBOOM', '重建子进程自身失败必须原样抛出')
  assert.strictEqual(d.deps.rebuildExit7.thrown && d.deps.rebuildExit7.thrown.message, 're2 原生模块恢复失败，退出码 7', '重建非零退出必须带真实退出码')
  assert.strictEqual(d.deps.gotEaccesAfterInstall.thrown && d.deps.gotEaccesAfterInstall.thrown.message, '依赖恢复后 got 仍不可用：[object Object]', '无 message 的错误必须退化为 String(error)')

  // --- 迁移自旧直调副本的两个维度（C5-060）：未开自动安装必须给部署提示且零 spawn；npm 安装非零退出必须带真实退出码 ---
  assert.match(String(d.deps.autoInstallOff.thrown && d.deps.autoInstallOff.thrown.message),
    /^检测到 got 依赖或原生模块未完整安装；请在部署阶段依次执行：npm ci --omit=dev --ignore-scripts && npm rebuild re2。如确需在本次运行时安装，请显式设置 XBK_AUTO_INSTALL_DEPS=1。/,
    '未设置 XBK_AUTO_INSTALL_DEPS 时必须抛出带部署命令（npm ci --omit=dev --ignore-scripts && npm rebuild re2）的提示错误')
  assert.strictEqual(d.deps.autoInstallOff.spawns.length, 0, '未设置自动安装时不得触发任何 npm 子进程')
  assert.deepStrictEqual(d.deps.autoInstallOff.warns, [], '未设置自动安装时不得打印「已执行恢复」告警')
  assert.strictEqual(d.deps.installFails.thrown && d.deps.installFails.thrown.message, 'npm ci 失败，退出码 4', '安装非零退出必须报 npm ci 失败并带真实退出码')
  assert.strictEqual(d.deps.installFails.spawns.length, 1, '安装失败必须立刻中止，不得继续 rebuild')
  assert.strictEqual(d.deps.installSpawnError.thrown && d.deps.installSpawnError.thrown.message, 'spawn ENOENT', '安装子进程自身失败（error 而非退出码）必须原样抛出，不得退化成「退出码 undefined」')
  assert.strictEqual(d.deps.installSpawnError.spawns.length, 1, '安装子进程失败必须立刻中止，不得继续 rebuild')
  assert.strictEqual(d.deps.installRecovers.thrown, null, '安装后依赖可加载时必须静默返回（恢复成功不得报错）')
  assert.strictEqual(d.deps.installRecovers.spawns.length, 1, '恢复成功只应触发一次安装（re2 已可加载 ⇒ 不 rebuild）')
  assert.deepStrictEqual(d.deps.installRecovers.spawns[0].args, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', ROOT], '有锁文件时恢复成功走的仍是冻结 npm ci')
  assert.deepStrictEqual(d.deps.installRecovers.warns, [OK_MSG], '恢复成功只允许一条「已执行恢复」告警')
  assert.strictEqual(d.deps.installRecoversNoLock.thrown, null, '无锁文件时 install 后依赖可加载同样必须静默返回')
  assert.deepStrictEqual(d.deps.installRecoversNoLock.spawns[0].args, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', ROOT, '--no-package-lock'], '无锁文件的恢复成功路径必须是 install --no-package-lock')

  // --- retryBackoffMs / statusCacheDir / nodeVersionWarning ---
  assert.deepStrictEqual(d.backoff, [1, 1, 1000, 1000], 'cap=1 是合法下界必须生效，非法 cap 回退默认 30 分钟封顶（1000 起步）')
  assert.strictEqual(d.cache[0].value, path.join(ROOT, 'abs-cache'), '绝对路径的 XBK_CACHE_DIR 必须原样采纳')
  assert.deepStrictEqual(d.cache[0].warns, [], '绝对路径不得告警')
  assert.deepStrictEqual(d.cache[1].warns, [], '未配置 XBK_CACHE_DIR 时不得告警')
  assert.strictEqual(path.isAbsolute(d.cache[1].value), true, '默认缓存目录必须是绝对路径')
  assert.strictEqual(d.cache[2].value, d.cache[1].value, '相对路径必须回退到与未配置时相同的默认缓存目录')
  assert.notStrictEqual(d.cache[2].value, 'rel/cache', '相对路径不得被当作生效目录')
  assert.strictEqual(d.cache[2].warns.length, 1, '相对路径必须恰好告警一次')
  assert.strictEqual(d.cache[2].warns[0].startsWith('⚠️ XBK_CACHE_DIR 不是绝对路径（rel/cache），已忽略并回退默认缓存目录：'), true, '相对路径告警文案必须精确并含被忽略的原始值')
  assert.deepStrictEqual(d.version, [null, '⚠️ 当前 Node 23.0.0 不满足 re2/package.json engines 要求（^22.22.2 || ^24.15.0 || >=26.0.0），原生依赖可能不可用', '⚠️ 当前 Node 22.22.1 不满足 re2/package.json engines 要求（^22.22.2 || ^24.15.0 || >=26.0.0），原生依赖可能不可用', '⚠️ 当前 Node 22 不满足 re2/package.json engines 要求（^22.22.2 || ^24.15.0 || >=26.0.0），原生依赖可能不可用'], 'engines 闸门按完整范围比较，缺段按 0 补齐')

  // --- 入口参数白名单（KNOWN_ARGS）：已知参数不得告警；未知参数 fail-closed（审查 D2-M2）---
  const env = Object.assign({}, process.env, { XBK_CACHE_DIR: ROOT, TZ: 'UTC' })
  const known = spawnSync(process.execPath, [ENTRY, '--status'], { encoding: 'utf8', env, timeout: 120000 })
  assert.strictEqual(known.status, 0, `--status 必须成功退出：${known.stderr}`)
  assert.strictEqual(known.stderr, '', '--status 是已知参数，不得输出任何 stderr（含未识别参数告警）')
  assert.strictEqual(known.stdout.length > 0, true, '--status 必须输出状态报告')
  const unknown = spawnSync(process.execPath, [ENTRY, '--status', '--dryrun'], { encoding: 'utf8', env, timeout: 120000 })
  assert.strictEqual(unknown.status, 1, '未知参数必须 fail-closed，不得继续执行 --status')
  assert.strictEqual(unknown.stderr, '❌ 未识别参数：--dryrun（可用参数：--status / --check / --dry-run），拒绝执行（fail-closed）\n', '未知参数必须按精确文案报错')
  assert.strictEqual(unknown.stdout, '', '未知参数不得输出状态报告')

  console.log('test_qinglong_utils OK (entry contract)')
}

// 两段**串行**执行（C5-063）：旧写法是两个并发的顶层 IIFE，第一段在 `await runDryRunOnce` 的窗口里
// 把 console.log/error 换成空函数，第二段的同步前缀（构造子进程脚本 + spawnSync 探针 + 全部断言）
// 正好整段落在那个窗口里 ⇒ 它的完成行与失败诊断被吞掉，且两段的断言顺序不可预期。
// 串行后：第一段的捕获在 captureConsole 的 finally 里还原（第二段开工前那条 console 基线断言会核对），
// 任一段抛错都走同一个 catch（打栈 + exit 1），不再各自抢着 process.exit。
runUnitChecks()
  .then(runEntryContractChecks)
  .catch((e) => { fs.writeSync(2, 'test_qinglong_utils FAIL: ' + (e && e.stack ? e.stack : String(e)) + '\n'); process.exit(1) })
