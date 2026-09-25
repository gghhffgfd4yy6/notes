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

;(async () => {
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

  // ===== ensureDependencies：更多边界分支 =====
  // 统一 mock 构造器：消除 7 个用例间重复的 requireFn/spawnSyncFn 样板
  // spawnCallCount：记录 spawnSyncFn 被调用次数，用于负向断言——依赖正常时不得触发安装/重建
  // spawnCalls：记录每次调用的参数，用于断言实际执行的 npm 子命令（QX-04）
  // lockExists：默认 true，令恢复命令固定为 npm ci（不依赖跑测试时仓库根是否存在锁文件）
  const makeDepsMock = ({ gotError = null, re2Error = null, installResult = { status: 0 }, rebuildResult = { status: 0 }, autoInstall = true, lockExists = () => true } = {}) => {
    const mock = {
      spawnCallCount: 0,
      spawnCalls: [],
      requireFn: (id) => {
        const base = path.basename(id)
        if (base === 'got' && gotError) throw gotError
        if (base === 're2' && re2Error) throw re2Error
        return {}
      },
      spawnSyncFn: (cmd, args) => {
        mock.spawnCallCount += 1
        mock.spawnCalls.push({ cmd, args })
        return args[0] === 'run' && args[1] === 'rebuild' ? rebuildResult : installResult
      },
      env: autoInstall ? { XBK_AUTO_INSTALL_DEPS: '1' } : {},
      lockExists
    }
    return mock
  }
  const modNotFound = () => { const e = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; return e }
  const dlopenFailed = () => { const e = new Error('Native mismatch'); e.code = 'ERR_DLOPEN_FAILED'; return e }

  // 1. got 和 re2 都可加载 → 返回 undefined（不抛错），且不得触发 spawnSync（安装/重建）
  const normalMock = makeDepsMock()
  assert.strictEqual(ensureDependencies(normalMock), undefined, '两个依赖都可加载时应返回 undefined')
  assert.strictEqual(normalMock.spawnCallCount, 0, '依赖正常时不得触发 spawnSync（安装/重建）——负向断言，防未来重排漏判')

  // 2. 不可恢复错误（非 MODULE_NOT_FOUND/ERR_DLOPEN_FAILED）直接 throw，不尝试安装
  const unrecoverable = new Error('Unexpected runtime error')
  unrecoverable.code = 'E_RANDOM'
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: unrecoverable })), /Unexpected runtime error/, '不可恢复错误应直接抛出，不尝试自动安装')

  // 3. 可恢复错误但未设置自动安装 → 抛明确提示错误
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound(), autoInstall: false })), /got 依赖或原生模块未完整安装/, '未设置 XBK_AUTO_INSTALL_DEPS 时应抛提示错误')

  // 4. npm install 失败（status != 0）→ throw
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound(), installResult: { status: 1 } })), /npm ci 失败/, '安装退出码非 0 应抛错（有锁文件时为 npm ci）')

  // 5. install 成功但 re2 rebuild 失败 → throw
  assert.throws(() => ensureDependencies(makeDepsMock({ re2Error: dlopenFailed(), rebuildResult: { status: 1 } })), /re2 原生模块构建失败/, 'rebuild 退出码非 0 应抛错')

  // 6. 安装+rebuild 都成功但恢复后仍不可用 → throw（got 始终不可加载模拟恢复失败）
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound() })), /依赖恢复后 got 仍不可用/, '恢复后仍不可用应抛错')

  // 7. spawnSync 返回 error 对象 → throw install.error
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound(), installResult: { error: new Error('spawn ENOENT'), status: null } })), /spawn ENOENT/, 'spawnSync 返回 error 应抛出该错误')

  // ===== QX-01 回归：依赖探测与 Node 常规解析同口径 =====
  // 常规解析可用（require('got')/require('re2') 成功）、而固定路径 ROOT/node_modules/<pkg> 不可用时，
  // 必须判为「可用」——既不抛错，也不触发 npm 安装。旧实现只探测固定路径：同一 mock 下会走
  // 自动安装 + re2 重建后仍失败，最终抛「依赖恢复后 got 仍不可用」。
  const resolutionOnly = {
    spawnCallCount: 0,
    requireFn: (id) => {
      if (id === 'got' || id === 're2') return {}
      const e = new Error(`Cannot find module '${id}'`)
      e.code = 'MODULE_NOT_FOUND'
      throw e
    },
    spawnSyncFn: () => { resolutionOnly.spawnCallCount += 1; return { status: 0 } },
    env: { XBK_AUTO_INSTALL_DEPS: '1' },
    lockExists: () => true
  }
  assert.strictEqual(ensureDependencies(resolutionOnly), undefined, '常规解析可用时不得判为依赖缺失（QX-01 回归）')
  assert.strictEqual(resolutionOnly.spawnCallCount, 0, '常规解析可用时不得触发 npm 安装/重建')

  // 反向兜底仍在：常规解析不可用、固定路径可用 → 同样判为可用且不安装
  const fixedPathOnly = {
    spawnCallCount: 0,
    requireFn: (id) => {
      if (path.isAbsolute(id)) return {}
      const e = new Error(`Cannot find module '${id}'`)
      e.code = 'MODULE_NOT_FOUND'
      throw e
    },
    spawnSyncFn: () => { fixedPathOnly.spawnCallCount += 1; return { status: 0 } },
    env: {},
    lockExists: () => true
  }
  assert.strictEqual(ensureDependencies(fixedPathOnly), undefined, '固定路径兜底应仍然有效（常规解析失败时回退）')
  assert.strictEqual(fixedPathOnly.spawnCallCount, 0, '固定路径命中时不得触发安装')

  // ===== QX-04：依赖恢复命令必须冻结（有锁文件 → npm ci；无锁文件 → install --no-package-lock）=====
  // installed 翻转模拟「安装后依赖变为可加载」，让 ensureDependencies 走完整条恢复路径。
  const makeInstallMock = (lockExists) => {
    const mock = {
      installed: false,
      calls: [],
      requireFn: (id) => {
        const base = path.basename(id)
        if (base === 'got' || base === 're2') {
          if (mock.installed) return {}
          const e = new Error(`Cannot find module '${id}'`)
          e.code = 'MODULE_NOT_FOUND'
          throw e
        }
        return {}
      },
      spawnSyncFn: (cmd, args) => {
        mock.calls.push({ cmd, args })
        if (args[0] === 'ci' || args[0] === 'install') mock.installed = true
        return { status: 0 }
      },
      env: { XBK_AUTO_INSTALL_DEPS: '1' },
      lockExists
    }
    return mock
  }

  const ciMock = makeInstallMock(() => true)
  assert.strictEqual(ensureDependencies(ciMock), undefined, '恢复成功应返回 undefined')
  assert.strictEqual(ciMock.calls.length, 1, '恢复只应触发一次安装（re2 安装后即可加载，无需重建）')
  assert.strictEqual(ciMock.calls[0].args[0], 'ci', '有 package-lock.json 时必须用冻结安装 npm ci（QX-04 回归）')
  assert.ok(!ciMock.calls[0].args.includes('--no-package-lock'), 'npm ci 不应再带 --no-package-lock')
  assert.ok(ciMock.calls[0].args.includes('--omit=dev') && ciMock.calls[0].args.includes('--ignore-scripts'), 'ci 仍须保留 --omit=dev / --ignore-scripts')

  const noLockMock = makeInstallMock(() => false)
  assert.strictEqual(ensureDependencies(noLockMock), undefined, '无锁文件时退回 install 也应能恢复')
  assert.strictEqual(noLockMock.calls[0].args[0], 'install', '无锁文件时退回 npm install')
  assert.ok(noLockMock.calls[0].args.includes('--no-package-lock'), '退回 install 时必须带 --no-package-lock（不再在部署目录生成/改写锁文件）')

  // ===== QX-02：--dry-run 一次性执行 =====
  // runDryRunOnce 只跑一轮：成功 → 0，全失败 → 1（不做常驻退避重试）。
  const origLog = console.log
  const origErr = console.error
  console.log = () => {}
  console.error = () => {}
  let dryRunCalls = 0
  let dryRunCode
  let dryRunFailCode
  try {
    dryRunCode = await runDryRunOnce({ run: async () => { dryRunCalls += 1; return { total: 3, filtered: 1, pushed: 0, failed: 0 } } })
    dryRunFailCode = await runDryRunOnce({ run: async () => ({ total: 1, pushed: 0, failed: 1, failures: [{ code: 'E_NET', statusCode: 503 }] }) })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  assert.strictEqual(dryRunCalls, 1, 'dry-run 只能调用 app.run() 一次（一次性执行）')
  assert.strictEqual(dryRunCode, 0, '单轮成功应返回退出码 0')
  assert.strictEqual(dryRunFailCode, 1, '单轮全失败应返回退出码 1')

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

  // ===== QX-06：常驻路径的 Node 版本告警文案 =====
  assert.strictEqual(nodeVersionWarning('22.22.2'), null, '恰为 engines 下界不应告警')
  assert.strictEqual(nodeVersionWarning('24.18.0'), null, '高于下界不应告警')
  assert.match(String(nodeVersionWarning('22.21.0')), /低于 package\.json engines 要求（>=22\.22\.2）/, '低于下界应给出与 engines 对齐的告警')
  assert.match(String(nodeVersionWarning('20.11.0')), /低于 package\.json engines 要求/, '主版本低于 22 同样应告警')

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

  // ④ CLI 端到端：未设置 XBK_CACHE_DIR 时 --status 必须成功（不加载 got/re2）并显式暴露生效目录，
  //    避免 Config.cache.dir 指向其它根内目录时静默读错目录（QX-08 的后半的一半）。
  {
    const env = { ...process.env }
    delete env.XBK_CACHE_DIR
    const r = spawnSync(process.execPath, [path.join(__dirname, 'qinglong', 'xbk_push.js'), '--status'], {
      cwd: __dirname, encoding: 'utf8', env
    })
    assert.strictEqual(r.status, 0, `--status 应独立于 got/re2 成功退出，实际 status=${r.status} stderr=${r.stderr}`)
    assert.match(String(r.stdout), /缓存目录：\S+（未使用 XBK_CACHE_DIR；/, `--status 应显式暴露生效缓存目录与配置口径，实际 stdout=${r.stdout}`)
    assert.match(String(r.stdout), /xbk-push 运行状态/, '--status 仍应输出状态面板')
  }

  console.log('test_qinglong_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })

// ===== 追加：qinglong/xbk_push.js「入口」契约回归（QX-02/QX-04/QX-05/QX-08/QX-09）=====
// 断言对着 SYSTEM_CONTRACT.md 的「入口」条：退出码语义、失败文案、可恢复判定、恢复命令、
// 包名白名单 fail-closed、缓存目录口径。可观测输出（console 三路/退出码）一律在独立子进程取，
// 避免与既有套件并发共享 console/process.stdout 造成捕获串扰；不依赖时区/网络/遍历顺序。
;(async () => {
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
    if (step.after === 'eaccesGot') bare.got = { code: 'EACCES' }
    return step.result || { status: 0 }
  }
  const r = await cap(() => mod.ensureDependencies({
    requireFn: requireFn,
    spawnSyncFn: spawnSyncFn,
    env: { XBK_AUTO_INSTALL_DEPS: '1' },
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
  const out = { root: ROOT, nodeModules: NODE_MODULES, dry: [], deps: [], cache: [], backoff: [], version: [] }
  for (let i = 0; i < dryCases.length; i += 1) out.dry.push(await cap(() => mod.runDryRunOnce({ run: async () => dryCases[i] })))
  out.deps.push(await deps({ bare: { got: 'ok', re2: 'ok' } }))
  out.deps.push(await deps({ bare: { got: 'nf', re2: 'nf' }, fixed: { got: 'ok', re2: 'ok' } }))
  out.deps.push(await deps({ bare: { got: { code: 'ERR_DLOPEN_FAILED', message: 'dlopen failed' }, re2: 'ok' } }))
  out.deps.push(await deps({ nullThrow: true }))
  out.deps.push(await deps({ bare: { got: 'nf', re2: 'ok' } }))
  out.deps.push(await deps({ bare: { got: 'nf', re2: 'ok' }, lock: false }))
  out.deps.push(await deps({ bare: { got: 'ok', re2: 'dlopen' } }))
  out.deps.push(await deps({ bare: { got: 'ok', re2: { code: 'EACCES', message: 'permission denied' } } }))
  out.deps.push(await deps({ bare: { got: 'ok', re2: 'dlopen' }, plan: [{}, { result: { error: { message: 'EBOOM' } } }] }))
  out.deps.push(await deps({ bare: { got: 'ok', re2: 'dlopen' }, plan: [{}, { result: { status: 7 } }] }))
  out.deps.push(await deps({ bare: { got: 'nf', re2: 'ok' }, plan: [{ after: 'eaccesGot' }] }))
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
  assert.strictEqual(d.deps[0].thrown, null, '依赖齐备不得抛错')
  assert.deepStrictEqual(d.deps[0].calls, ['got', 're2'], '两模块均可解析时只做裸解析（与 --check 同口径）')
  assert.deepStrictEqual(d.deps[0].spawns, [], '已完整安装时不得触发安装')
  assert.strictEqual(d.deps[1].thrown, null, '固定路径解析成功即视为已恢复')
  assert.deepStrictEqual(d.deps[1].calls, ['got', path.join(NODE_MODULES, 'got'), 're2', path.join(NODE_MODULES, 're2')], '裸解析失败后必须回退到固定 node_modules 直接子路径')
  assert.deepStrictEqual(d.deps[1].spawns, [], '固定路径命中时不得安装')
  assert.deepStrictEqual(d.deps[2].calls, ['got', 're2', 're2', 'got', 're2'], '非 MODULE_NOT_FOUND 说明模块已定位，不得回退固定路径')
  assert.strictEqual(d.deps[2].spawns.length, 1, 'ERR_DLOPEN_FAILED 属可恢复，必须触发一次恢复安装')
  assert.deepStrictEqual(d.deps[2].warns, [OK_MSG], '恢复前必须打印与 --check 同源的恢复告警')
  assert.strictEqual(d.deps[3].thrown, null, 'load 的非模块错误判定必须先看 error 本身，不得解引用 null.code')
  assert.strictEqual(d.deps[3].spawns.length, 0, '抛非对象错误时不得进入安装')

  // --- 恢复命令：有锁文件用冻结 npm ci，缺锁文件退化为 install --no-package-lock，恢复后仍失败则忠实报错 ---
  assert.strictEqual(d.deps[4].thrown && d.deps[4].thrown.message, `依赖恢复后 got 仍不可用：Cannot find module '${path.join(NODE_MODULES, 'got')}'`, '恢复后仍不可用必须抛出带失败模块名的错误')
  assert.strictEqual(d.deps[4].spawns.length, 1, '缺 got 只安装一次，不得多余重建')
  assert.strictEqual(d.deps[4].spawns[0].cmd, 'npm', '恢复命令必须是 npm（非 win32 平台）')
  assert.deepStrictEqual(d.deps[4].spawns[0].args, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', ROOT], '有 package-lock.json 时必须用冻结的 npm ci 且参数完整')
  assert.strictEqual(d.deps[4].spawns[0].cwd, ROOT, '安装必须在项目根执行')
  assert.strictEqual(d.deps[4].spawns[0].timeout, 120000, '安装必须有超时')
  assert.deepStrictEqual(d.deps[4].warns, [OK_MSG], '有锁文件时不得输出退化 install 告警')
  assert.deepStrictEqual(d.deps[5].warns, [OK_MSG, '未找到 package-lock.json，退化为 npm install --no-package-lock（建议按 README 用 npm ci 部署以冻结依赖版本）'], '缺锁文件必须显式告警退化')
  assert.deepStrictEqual(d.deps[5].spawns[0].args, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', ROOT, '--no-package-lock'], '缺锁文件时必须 install 且不得生成新锁文件')
  assert.strictEqual(d.deps[6].spawns.length, 2, 're2 安装后仍不可加载才构建，且只构建一次')
  assert.deepStrictEqual(d.deps[6].spawns[1].args, ['run', 'rebuild', '--prefix', path.join(NODE_MODULES, 're2')], 're2 构建必须在固定 node_modules/re2 下执行重建')
  assert.strictEqual(d.deps[6].thrown && d.deps[6].thrown.message, '依赖恢复后 re2 仍不可用：dlopen failed', 're2 仍不可用必须以 re2 忠实命名')
  assert.strictEqual(d.deps[7].spawns.length, 0, '不可恢复错误不得进入恢复流程')
  assert.deepStrictEqual(d.deps[7].warns, [], '未进入恢复流程不得打印恢复告警')
  assert.strictEqual(d.deps[7].thrown && d.deps[7].thrown.code, 'EACCES', '不可恢复错误必须原样抛出（只认 MODULE_NOT_FOUND/ERR_DLOPEN_FAILED）')
  assert.strictEqual(d.deps[8].thrown && d.deps[8].thrown.message, 'EBOOM', '重建子进程自身失败必须原样抛出')
  assert.strictEqual(d.deps[9].thrown && d.deps[9].thrown.message, 're2 原生模块构建失败，退出码 7', '重建非零退出必须带真实退出码')
  assert.strictEqual(d.deps[10].thrown && d.deps[10].thrown.message, '依赖恢复后 got 仍不可用：[object Object]', '无 message 的错误必须退化为 String(error)')

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
  assert.deepStrictEqual(d.version, [null, null, '⚠️ 当前 Node 22.22.1 低于 package.json engines 要求（>=22.22.2），re2 等原生依赖可能不可用', '⚠️ 当前 Node 22 低于 package.json engines 要求（>=22.22.2），re2 等原生依赖可能不可用'], 'engines 闸门按完整数值比较，缺段按 0 补齐')

  // --- 入口参数白名单（KNOWN_ARGS）：已知参数不得告警；未知参数只告警不改变行为（QX-09）---
  const env = Object.assign({}, process.env, { XBK_CACHE_DIR: ROOT, TZ: 'UTC' })
  const known = spawnSync(process.execPath, [ENTRY, '--status'], { encoding: 'utf8', env, timeout: 120000 })
  assert.strictEqual(known.status, 0, `--status 必须成功退出：${known.stderr}`)
  assert.strictEqual(known.stderr, '', '--status 是已知参数，不得输出任何 stderr（含未识别参数告警）')
  assert.strictEqual(known.stdout.length > 0, true, '--status 必须输出状态报告')
  const unknown = spawnSync(process.execPath, [ENTRY, '--status', '--dryrun'], { encoding: 'utf8', env, timeout: 120000 })
  assert.strictEqual(unknown.status, 0, '未知参数只告警不改变行为，--status 仍应成功退出')
  assert.strictEqual(unknown.stderr, '⚠️ 未识别参数已忽略：--dryrun（可用参数：--status / --check / --dry-run）\n', '未知参数必须按精确文案告警')

  console.log('test_qinglong_utils OK (entry contract)')
})().catch((e) => { fs.writeSync(2, 'entry-contract FAIL: ' + (e && e.stack ? e.stack : String(e)) + '\n'); process.exit(1) })
