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
  assert.strictEqual(shouldAutoInstallDependencies(undefined), false, 'undefined env 触发默认 process.env，应返回 false')

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
  // 1. got 和 re2 都可加载 → 返回 undefined（不抛错）
  assert.strictEqual(ensureDependencies({
    requireFn: () => ({}),
    env: {}
  }), undefined, '两个依赖都可加载时应返回 undefined')

  // 2. 不可恢复错误（非 MODULE_NOT_FOUND/ERR_DLOPEN_FAILED）直接 throw，不尝试安装
  const unrecoverable = new Error('Unexpected runtime error')
  unrecoverable.code = 'E_RANDOM'
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 'got') throw unrecoverable
      return {}
    },
    spawnSyncFn: () => { throw new Error('不应调用 spawnSync') },
    env: { XBK_AUTO_INSTALL_DEPS: '1' }
  }), /Unexpected runtime error/, '不可恢复错误应直接抛出，不尝试自动安装')

  // 3. 可恢复错误但未设置自动安装 → 抛明确提示错误
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 'got') {
        const e = new Error('Cannot find module')
        e.code = 'MODULE_NOT_FOUND'
        throw e
      }
      return {}
    },
    env: {}
  }), /got 依赖或原生模块未完整安装/, '未设置 XBK_AUTO_INSTALL_DEPS 时应抛提示错误')

  // 4. npm install 失败（status != 0）→ throw
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 'got') {
        const e = new Error('Cannot find module')
        e.code = 'MODULE_NOT_FOUND'
        throw e
      }
      return {}
    },
    spawnSyncFn: () => ({ status: 1 }),
    env: { XBK_AUTO_INSTALL_DEPS: '1' }
  }), /npm install 失败/, 'npm install 退出码非 0 应抛错')

  // 5. install 成功但 re2 rebuild 失败 → throw
  const re2Ready5 = false
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 're2' && !re2Ready5) {
        const e = new Error('Native mismatch')
        e.code = 'ERR_DLOPEN_FAILED'
        throw e
      }
      return {}
    },
    spawnSyncFn: (cmd, args) => {
      if (args[0] === 'run' && args[1] === 'rebuild') return { status: 1 }
      return { status: 0 }
    },
    env: { XBK_AUTO_INSTALL_DEPS: '1' }
  }), /re2 原生模块构建失败/, 'rebuild 退出码非 0 应抛错')

  // 6. 安装+rebuild 都成功但恢复后仍不可用 → throw
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      // got 始终不可加载（模拟恢复失败）
      if (path.basename(id) === 'got') {
        const e = new Error('Cannot find module')
        e.code = 'MODULE_NOT_FOUND'
        throw e
      }
      return {}
    },
    spawnSyncFn: () => ({ status: 0 }),
    env: { XBK_AUTO_INSTALL_DEPS: '1' }
  }), /依赖恢复后 got 仍不可用/, '恢复后仍不可用应抛错')

  // 7. spawnSync 返回 error 对象 → throw install.error
  assert.throws(() => ensureDependencies({
    requireFn: (id) => {
      if (path.basename(id) === 'got') {
        const e = new Error('Cannot find module')
        e.code = 'MODULE_NOT_FOUND'
        throw e
      }
      return {}
    },
    spawnSyncFn: () => ({ error: new Error('spawn ENOENT'), status: null }),
    env: { XBK_AUTO_INSTALL_DEPS: '1' }
  }), /spawn ENOENT/, 'spawnSync 返回 error 应抛出该错误')

  console.log('test_qinglong_utils OK')
})().catch((e) => { console.error(e); process.exit(1) })
