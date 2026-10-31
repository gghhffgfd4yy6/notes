'use strict'

// 青龙 --check 诊断入口：runCheck 函数的各种通过/失败场景
const assert = require('assert')
const path = require('node:path')
const Module = require('node:module')
const { runCheck } = require('./qinglong/xbk_push')

// 通过 require.cache mock xbk_sendNotify_slim（runCheck 内部动态 require）
const notifyPath = require.resolve('./xbk_sendNotify_slim')
const origNotify = require.cache[notifyPath]

function mockNotify (count) {
  require.cache[notifyPath] = { exports: { configuredChannelCount: () => count } }
}

function restoreNotify () {
  // 幂等：无论调用多少次，require.cache 都回到套件加载时的状态。
  // 兜底口径（用例间状态猎杀 #198 后续）：restore 不依赖每个用例顺序调用到位——
  // 任何用例断言失败走 catch 时也会先执行 restoreNotify 再退出，坏桩不驻留。
  require.cache[notifyPath] = origNotify
}

// 环境探测 mock：runCheck 内部真实校验 Node 版本 / got / re2（qinglong/xbk_push.js），
// 裸环境（Node<engines 或缺 got/re2）下"全部通过"用例必然返回 1。这里临时伪装成健康环境，
// 只覆盖 runCheck 的返回码聚合逻辑，使该用例在裸环境可确定性通过；返回后完整还原。
// nodeVersion 默认 '22.22.2'：恰为 package.json engines 下界（QX-06 起 --check 按完整版本比较，
// 旧 fixture '22.0.0' 已不再是"健康环境"）。
function withHealthyEnv (fn, nodeVersion = '22.22.2') {
  const origRequire = Module.prototype.require
  const versionsDesc = Object.getOwnPropertyDescriptor(process, 'versions')
  Module.prototype.require = function (id, ...rest) {
    if (id === 'got') return {}
    if (id === 're2') return class { test () { return true } }
    return origRequire.call(this, id, ...rest)
  }
  Object.defineProperty(process, 'versions', { value: { ...versionsDesc.value, node: nodeVersion }, configurable: true })
  try {
    return fn()
  } finally {
    Module.prototype.require = origRequire
    Object.defineProperty(process, 'versions', versionsDesc)
  }
}

// #26 修复：捕获 runCheck 的 console.log 输出，用于区分具体哪个检查失败（而非只断返回码）
function captureRunCheck (app) {
  const lines = []
  const origLog = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    const code = runCheck(app)
    return { code, output: lines.join('\n') }
  } finally {
    console.log = origLog
  }
}

function makeApp (overrides = {}) {
  return {
    validateConfig: overrides.validateConfig || (() => []),
    init: overrides.init || (() => {}),
    // C3-010：--check 现在打印 MessageStore.cacheDir（生效值）；桩不注入时按「未回退」口径走配置值。
    MessageStore: overrides.MessageStore,
    Config: {
      filter: overrides.filter || {},
      keyword: { zkt_gjc: overrides.zkt_gjc || '' },
      cache: { dir: overrides.cacheDir || path.join(__dirname, '.test-cache') }
    }
  }
}

;(async () => {
  // ===== 全部通过 → 返回 0 =====
  // Node 版本/got/re2 三项环境探测用 mock 伪装为健康环境，避免裸环境（Node<22、无 got/re2）下必然失败
  mockNotify(1)
  const code0 = withHealthyEnv(() => runCheck(makeApp()))
  assert.strictEqual(code0, 0, '全部检查通过应返回 0')
  restoreNotify()

  // ===== QX-06 回归：Node 不满足 re2 engines 范围 → 返回 1，且该项为 ❌ =====
  // 旧实现只看主版本（Number(node.split('.')[0]) >= 22），22.21.0 会被放行（本用例必红）。
  mockNotify(1)
  const rNodeLow = withHealthyEnv(() => captureRunCheck(makeApp()), '22.21.0')
  assert.strictEqual(rNodeLow.code, 1, 'Node 低于 engines 下界应返回 1')
  assert.ok(rNodeLow.output.includes('❌ Node.js 版本'), '失败项应为"Node.js 版本"，输出应含 ❌ Node.js 版本')
  assert.ok(rNodeLow.output.includes('不满足 re2/package.json engines 要求：^22.22.2 || ^24.15.0 || >=26.0.0'), '失败详情应给出完整的 re2 engines 要求')
  restoreNotify()

  // prerelease 不能因截掉后缀而冒充稳定受支持版本。
  mockNotify(1)
  const rNodePrerelease = withHealthyEnv(() => captureRunCheck(makeApp()), '24.15.0-rc.1')
  assert.strictEqual(rNodePrerelease.code, 1, '不支持的 prerelease Node 应令 --check 失败')
  assert.ok(rNodePrerelease.output.includes('❌ Node.js 版本'), 'prerelease 应被 Node.js 版本检查标红')
  restoreNotify()

  // 边界对照：恰好下界 / 高于下界 → 该项通过（防"一律判红"让上面的断言失去鉴别力）
  mockNotify(1)
  assert.strictEqual(withHealthyEnv(() => runCheck(makeApp()), '22.22.2'), 0, '恰为 engines 下界应通过')
  assert.strictEqual(withHealthyEnv(() => runCheck(makeApp()), '24.18.0'), 0, '高于下界应通过')
  restoreNotify()

  // ===== validateConfig 返回警告 → 返回 1，且输出中"过滤配置"为 ❌ =====
  mockNotify(1)
  const rWarn = captureRunCheck(makeApp({ validateConfig: () => ['warning1', 'warning2'] }))
  assert.strictEqual(rWarn.code, 1, '过滤配置有警告应返回 1')
  assert.ok(rWarn.output.includes('❌ 过滤配置'), '失败项应为"过滤配置"，输出应含 ❌ 过滤配置')
  assert.ok(rWarn.output.includes('2 条警告'), '应显示 2 条警告')
  restoreNotify()

  // ===== init() 抛错 → 返回 1，且输出中"缓存目录"为 ❌ =====
  mockNotify(1)
  const rInitFail = captureRunCheck(makeApp({ init: () => { throw new Error('cache init failed') } }))
  assert.strictEqual(rInitFail.code, 1, '缓存目录初始化失败应返回 1')
  assert.ok(rInitFail.output.includes('❌ 缓存目录'), '失败项应为"缓存目录"，输出应含 ❌ 缓存目录')
  assert.ok(rInitFail.output.includes('cache init failed'), '应包含 init 错误信息')
  restoreNotify()

  // ===== 通知通道为 0 → 返回 1，且输出中"通知通道"为 ❌ =====
  mockNotify(0)
  const rNoChannel = captureRunCheck(makeApp())
  assert.strictEqual(rNoChannel.code, 1, '无可用通知通道应返回 1')
  assert.ok(rNoChannel.output.includes('❌ 通知通道'), '失败项应为"通知通道"，输出应含 ❌ 通知通道')
  assert.ok(rNoChannel.output.includes('未检测到完整通道配置'), '应显示未检测到通道配置')
  restoreNotify()

  // ===== notify 无 configuredChannelCount 方法 → 返回 1（count=0）=====
  // 与其他失败用例同口径：必须在 withHealthyEnv 里跑并断言「通知通道」为 ❌——否则在
  // Node<engines 或缺 got/re2 的裸环境下 runCheck 会因环境检查先失败返回 1，
  // 断言因错误的原因通过（假绿），区分不出「无通道」这条检查本身。
  require.cache[notifyPath] = { exports: {} }
  const rNoMethod = withHealthyEnv(() => captureRunCheck(makeApp()))
  assert.strictEqual(rNoMethod.code, 1, 'notify 无 configuredChannelCount 方法应返回 1')
  assert.ok(rNoMethod.output.includes('❌ 通知通道'), '失败项应为"通知通道"，输出应含 ❌ 通知通道')
  assert.ok(rNoMethod.output.includes('未检测到完整通道配置'), '应显示未检测到通道配置')
  restoreNotify()

  // ===== C3-010：--check 的「缓存目录」必须打印**生效值**，回退时必须点明原因 =====
  // 旧实现只打印 app.Config.cache.dir：cache.dir 被根内安全检查拒绝时生产已静默回退到
  // .xbk_cache_safe，而 --check 仍显示 ✅ 配置值 ⇒ 运维以为判重主存写在配置位置
  // （实际写在别处：缓存「丢失」/重复推送的误判来源）。
  mockNotify(1)
  const fallbackDir = path.join(__dirname, '.xbk_cache_safe')
  // 回退判定改由 MessageStore 给出（Codacy path-join-resolve-traversal 收口）：桩提供生产
  // MessageStore 在回退时记录的 { raw, chosen }，--check 只负责显示，不再自己用 path.resolve 重算。
  const configuredDir = path.join(__dirname, '.test-cache')
  const rFallback = withHealthyEnv(() => captureRunCheck(makeApp({
    MessageStore: { cacheDir: fallbackDir, cacheDirFallback: { raw: configuredDir, chosen: fallbackDir } }
  })))
  assert.strictEqual(rFallback.code, 0, '回退本身不是失败（生产口径），但必须可见')
  assert.ok(rFallback.output.includes(`✅ 缓存目录：${fallbackDir}`),
    `--check 必须打印生效目录而非配置值：${rFallback.output}`)
  assert.ok(rFallback.output.includes(`配置值 ${configuredDir} 未通过根内安全检查，已回退到 ${fallbackDir}`),
    `--check 必须点明「配置值未生效、回退到哪」：${rFallback.output}`)
  // 对照：未回退（cacheDirFallback = null）时不加任何赘述（否则「已回退」会变成永远为真的噪声）
  const rSame = withHealthyEnv(() => captureRunCheck(makeApp({ MessageStore: { cacheDir: configuredDir, cacheDirFallback: null } })))
  assert.ok(rSame.output.includes(`✅ 缓存目录：${configuredDir}\n`),
    `生效值等于配置值时只打印路径：${rSame.output}`)
  assert.ok(!rSame.output.includes('已回退'), '未回退时不得出现「已回退」说明')
  // XBK_CACHE_DIR 覆盖时点明来源（与 statusCacheDir 同源口径）
  process.env.XBK_CACHE_DIR = fallbackDir
  try {
    const rEnv = withHealthyEnv(() => captureRunCheck(makeApp()))
    assert.ok(rEnv.output.includes('由 XBK_CACHE_DIR 覆盖'), `环境变量覆盖必须显形：${rEnv.output}`)
  } finally {
    delete process.env.XBK_CACHE_DIR
  }
  // 对照（C3-010 返工）：相对路径 / 纯空白会被 MessageStore 与 statusCacheDir 忽略（模块自己告警
  // 「不是绝对路径，已忽略」），--check 不得把它说成「由 XBK_CACHE_DIR 覆盖，配置值 <同一值>」——
  // 同一份诊断自相矛盾，运维会以为读写落在 env 目录（本条修复的目的正是「别让目录判断说反话」）。
  const defaultConfigured = path.join(__dirname, '.test-cache')
  for (const ignoredEnv of ['relative/cache', '   ']) {
    process.env.XBK_CACHE_DIR = ignoredEnv
    try {
      const rIgnored = withHealthyEnv(() => captureRunCheck(makeApp()))
      assert.ok(!rIgnored.output.includes('由 XBK_CACHE_DIR 覆盖'),
        `被忽略的 XBK_CACHE_DIR（${JSON.stringify(ignoredEnv)}）不得说成已覆盖：${rIgnored.output}`)
      assert.ok(rIgnored.output.includes(`✅ 缓存目录：${defaultConfigured}`),
        `必须打印实际生效的配置目录：${rIgnored.output}`)
      if (ignoredEnv.trim()) {
        assert.ok(rIgnored.output.includes('已忽略'), `相对路径必须点明「已忽略」：${rIgnored.output}`)
      }
    } finally {
      delete process.env.XBK_CACHE_DIR
    }
  }
  restoreNotify()

  console.log('test_qinglong_runcheck OK')
})().catch((e) => { try { restoreNotify() } catch (_) { /* 还原本身不得吞掉原始错误 */ } console.error(e); process.exit(1) })
