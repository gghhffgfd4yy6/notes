'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  shouldAutoInstallDependencies,
  ensureDependencies,
  intervalMs,
  retryBackoffMs,
  runDryRunOnce
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
  const pushSource = fs.readFileSync(path.join(__dirname, 'qinglong', 'xbk_push.js'), 'utf8')
  assert.match(pushSource, /if\s*\(\s*hasArg\(\s*['"]--dry-run['"]\s*\)\s*\)\s*\{[\s\S]*?runDryRunOnce\(app\)[\s\S]*?return\s*\}/,
    '--dry-run 必须接线到一次性 runDryRunOnce 并在其后 return（不得落入常驻循环）')
  assert.match(pushSource, /await\s+runResident\(app,\s*controller\)/, '常驻路径必须仍然存在（防"删掉常驻"式假修复）')

  console.log('test_qinglong_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
