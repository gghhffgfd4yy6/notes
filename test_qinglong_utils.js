'use strict'

const assert = require('assert')
const path = require('path')
const {
  shouldAutoInstallDependencies,
  ensureDependencies,
  intervalMs,
  retryBackoffMs
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
  const makeDepsMock = ({ gotError = null, re2Error = null, installResult = { status: 0 }, rebuildResult = { status: 0 }, autoInstall = true } = {}) => {
    const mock = {
      spawnCallCount: 0,
      requireFn: (id) => {
        const base = path.basename(id)
        if (base === 'got' && gotError) throw gotError
        if (base === 're2' && re2Error) throw re2Error
        return {}
      },
      spawnSyncFn: (cmd, args) => {
        mock.spawnCallCount += 1
        return args[0] === 'run' && args[1] === 'rebuild' ? rebuildResult : installResult
      },
      env: autoInstall ? { XBK_AUTO_INSTALL_DEPS: '1' } : {}
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
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound(), installResult: { status: 1 } })), /npm install 失败/, 'npm install 退出码非 0 应抛错')

  // 5. install 成功但 re2 rebuild 失败 → throw
  assert.throws(() => ensureDependencies(makeDepsMock({ re2Error: dlopenFailed(), rebuildResult: { status: 1 } })), /re2 原生模块构建失败/, 'rebuild 退出码非 0 应抛错')

  // 6. 安装+rebuild 都成功但恢复后仍不可用 → throw（got 始终不可加载模拟恢复失败）
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound() })), /依赖恢复后 got 仍不可用/, '恢复后仍不可用应抛错')

  // 7. spawnSync 返回 error 对象 → throw install.error
  assert.throws(() => ensureDependencies(makeDepsMock({ gotError: modNotFound(), installResult: { error: new Error('spawn ENOENT'), status: null } })), /spawn ENOENT/, 'spawnSync 返回 error 应抛出该错误')

  console.log('test_qinglong_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
