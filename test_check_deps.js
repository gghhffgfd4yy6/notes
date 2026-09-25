'use strict'
// checkDependencies 单元测试：验证「缺少依赖」与「已安装但不可用」分支的判定与提示。
// 通过注入 mock 的 resolve/load 模拟不同环境，不依赖本机实际安装状态。
// 另有一组「直接执行脚本」的沙箱用例：在临时目录里复制真实实现 + 自造 node_modules，
// 走默认参数（生产路径）与 CLI 退出码，不受本机依赖树影响。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkDependencies, satisfiesNodeRange } = require('./scripts/check-deps')

// 沙箱：<dir>/package.json（可控声明清单）+ <dir>/scripts/check-deps.js（复制真实实现）
// + <dir>/node_modules/<name>/{package.json,index.js}。ROOT 由实现自算为 <dir>。
// marker（F5 返工）：给每个依赖的 index.js 注入「被加载即记账」——在隔离树上取证「检查真的跑了、
// 且经 ROOT 基准解析并加载了声明清单里的包」。只断言「status 0 且零输出」时，基线源码（无
// require.main 守卫、直接执行只加载模块）的空跑也恰好满足该条件（不可证伪）。
function makeCheckDepsSandbox ({ manifest, deps = [], brokenDeps = [], marker = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-sandbox-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(path.join(__dirname, 'scripts', 'check-deps.js'), path.join(dir, 'scripts', 'check-deps.js'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  for (const name of deps) {
    const pkgDir = path.join(dir, 'node_modules', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), marker
      ? `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + '\\n')\nmodule.exports = {}\n`
      : 'module.exports = {}\n')
  }
  // brokenDeps：落在 <dir>/scripts/node_modules/ 下——同名包在「以 scripts/ 为基准」的
  // 解析下会先命中且 require 即抛错，用于固定「解析基准必须与 resolve 同为项目根」这条契约。
  for (const name of brokenDeps) {
    const pkgDir = path.join(dir, 'scripts', 'node_modules', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'throw new Error("BROKEN_IN_SCRIPTS_TREE")\n')
  }
  return dir
}

function runCheckDepsSandbox (dir, env = {}) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-deps.js')], {
    encoding: 'utf8', cwd: dir, env: { ...process.env, ...env }
  })
}

// RT-08 沙箱：复制**真实**run_tests.js + 真实 scripts/check-deps.js，配一个最小桩套件与可控的
// devDependencies 清单——用真实入口（而不是读源码文本）证明前置门确实按 devDependencies 拦下缺失包。
function makeRunTestsSandbox ({ dependencies, devDependencies, presentDeps = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-sandbox-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(path.join(__dirname, 'scripts', 'check-deps.js'), path.join(dir, 'scripts', 'check-deps.js'))
  fs.copyFileSync(path.join(__dirname, 'run_tests.js'), path.join(dir, 'run_tests.js'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', version: '1.0.0', dependencies, devDependencies }))
  for (const name of presentDeps) {
    const pkgDir = path.join(dir, 'node_modules', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {}\n')
  }
  fs.writeFileSync(path.join(dir, 'test_suites.js'),
    "module.exports = { SUITES: [{ name: '桩', file: 'stub_suite.js', desc: 'RT-08 沙箱桩套件' }] }\n")
  fs.writeFileSync(path.join(dir, 'stub_suite.js'), "console.log('stub suite ok')\nprocess.exit(0)\n")
  return dir
}

function runRunTestsSandbox (dir) {
  return spawnSync(process.execPath, [path.join(dir, 'run_tests.js')], { encoding: 'utf8', cwd: dir })
}

function fakeRe2Class ({ ok = true } = {}) {
  return class MockRE2 {
    constructor (pattern) { this.pattern = pattern }
    test () { return ok }
  }
}

function captureErrorOutput (fn) {
  const lines = []
  const orig = console.error
  console.error = (...args) => { lines.push(args.join(' ')) }
  try {
    fn()
  } finally {
    console.error = orig
  }
  return lines.join('\n')
}

const tests = []

function test (name, fn) {
  tests.push({ name, fn })
}

test('全部依赖正常 → 返回 true 且无错误输出', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      resolve: () => '/mock/path',
      load: (name) => name === 're2' ? fakeRe2Class() : {}
    })
    if (ok !== true) throw new Error(`期望 true，实际 ${ok}`)
  })
  if (out !== '') throw new Error(`期望无输出，实际: ${out}`)
})

test('got 缺失 → 归为 missing，仅提示 npm ci，不提示 rebuild', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      // F3：缺失的判定口径是「resolve 不到」——真的没装 got 时 require.resolve 先失败，
      // 夹具必须复刻这一点（此前夹具让 resolve 成功、只让 load 抛错，那其实是「已安装但不可用」）。
      resolve: (name, opts) => {
        if (name === 'got') throw new Error("Cannot find module 'got'")
        return '/mock/path'
      },
      load: (name) => fakeRe2Class()
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('缺少依赖：got')) throw new Error(`应提示缺少 got: ${out}`)
  if (!out.includes('npm ci --ignore-scripts')) throw new Error(`应提示 npm ci: ${out}`)
  if (out.includes('npm run rebuild --prefix node_modules/re2')) throw new Error(`仅缺 got 时不应提示 rebuild: ${out}`)
})

// F3 回归：got「已安装但不可用」（got 12+ 为 ESM、内部依赖缺失、包损坏等）此前被 catch 一律
// 归入 missing → 输出「缺少 got」并只给 npm ci，根因（ERR_REQUIRE_ESM 等）被整个吞掉。
// 回退该改动后本条变红：输出会变成「缺少依赖：got」且不含 ERR_REQUIRE_ESM。
test('F3 got 可解析但加载抛错 → 归为 broken，输出根因与重装指引（不误报“缺少”）', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      resolve: () => '/mock/path',
      load: (name) => {
        if (name === 'got') {
          const err = new Error('require() of ES Module /x/node_modules/got/dist/source/index.js not supported')
          err.code = 'ERR_REQUIRE_ESM'
          throw err
        }
        return fakeRe2Class()
      }
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (out.includes('缺少依赖')) throw new Error(`「已安装但不可用」不得报成缺少依赖: ${out}`)
  if (!out.includes('依赖已安装但不可用：got')) throw new Error(`应提示不可用: ${out}`)
  if (!out.includes('ERR_REQUIRE_ESM')) throw new Error(`根因 error.code 必须进入输出: ${out}`)
  if (!out.includes('require() of ES Module')) throw new Error(`根因 message 必须进入输出: ${out}`)
  if (!out.includes('npm ci --ignore-scripts')) throw new Error(`got 不可用应给重装指引: ${out}`)
  if (out.includes('npm run rebuild --prefix node_modules/re2')) throw new Error(`got 不可用不应给 re2 的 rebuild 指引: ${out}`)
})

// RT-08：注册套件 test_filter.js 裸 require('fast-check')（devDependency），只探运行时清单时缺它
// 要在套件运行时才炸。前置门可按需把 devDependencies 纳入探测——默认关闭（运行时调用方语义不变），
// 只有测试入口显式打开。
test('RT-08 includeDevDependencies 打开后必须发现缺失的 devDependency（默认关闭时不误报）', () => {
  const pkg = { dependencies: { got: '11.8.6' }, devDependencies: { 'ghost-dev': '1.0.0' } }
  const resolve = (name) => {
    if (name === 'ghost-dev') throw new Error("Cannot find module 'ghost-dev'")
    return '/mock/path'
  }
  const base = { manifest: () => pkg, resolve, load: () => fakeRe2Class() }
  // 默认：运行时清单口径 —— devDependency 缺失不得让运行时预检变红
  const defaultOut = captureErrorOutput(() => {
    if (checkDependencies(base) !== true) throw new Error('默认不应把 devDependencies 计入运行时预检')
  })
  if (defaultOut.includes('ghost-dev')) throw new Error(`默认调用不得探测 devDependencies: ${defaultOut}`)
  // 打开开关：缺失的 devDependency 必须被发现并点名
  const out = captureErrorOutput(() => {
    if (checkDependencies({ ...base, includeDevDependencies: true }) !== false) throw new Error('打开开关后必须报缺失')
  })
  if (!out.includes('缺少依赖：ghost-dev')) throw new Error(`必须点名缺失的 devDependency: ${out}`)
})

// RT-08：devDependency 里存在 ESM-only 包（@stryker-mutator/core 等）——require 必抛
// ERR_REQUIRE_ESM。若对它们走 load，正常安装会被误报「已安装但不可用」→ 前置门假红。故只做 resolve。
test('RT-08 devDependency 只做 resolve 探测：可解析但 require 抛错不得误报 broken', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      manifest: () => ({ dependencies: { got: '11.8.6' }, devDependencies: { 'esm-only-dev': '1.0.0' } }),
      resolve: () => '/mock/path',
      load: (name) => {
        if (name === 'esm-only-dev') {
          const err = new Error('require() of ES Module not supported')
          err.code = 'ERR_REQUIRE_ESM'
          throw err
        }
        return fakeRe2Class()
      },
      includeDevDependencies: true
    })
    if (ok !== true) throw new Error(`ESM-only devDependency 已安装不得判失败，实际 ${ok}`)
  })
  if (out.includes('不可用')) throw new Error(`不得把 devDependency 的 ESM-only 加载失败判为「已安装但不可用」: ${out}`)
})

// RT-08（接线，行为级）：用**真实入口** run_tests.js 验证它确实打开了 includeDevDependencies——
// 读源码文本的断言不算；沙箱里复制真实 run_tests.js + 真实 scripts/check-deps.js，配一个最小桩套件，
// 声明一个不存在的 devDependency：入口必须非 0 退出并点名它（回退那行接线 → 桩套件跑通 → exit 0 → 红）。
test('RT-08 真实入口 run_tests.js 的前置门覆盖 devDependencies（缺 fast-check 类依赖必须拦下）', () => {
  const ghost = 'xbk-ghost-dev-xyz'
  const dir = makeRunTestsSandbox({
    dependencies: { got: '11.8.6' },
    devDependencies: { [ghost]: '1.0.0' },
    presentDeps: ['got']
  })
  const ctl = makeRunTestsSandbox({
    dependencies: { got: '11.8.6' },
    devDependencies: { 'xbk-dev-present-xyz': '1.0.0' },
    presentDeps: ['got', 'xbk-dev-present-xyz']
  })
  try {
    const r = runRunTestsSandbox(dir)
    if (r.status === 0) {
      throw new Error(`devDependency 缺失时入口必须非 0 退出，实际 0；stdout=${JSON.stringify(r.stdout)}`)
    }
    if (!String(r.stderr).includes(ghost)) {
      throw new Error(`stderr 必须点名缺失的 devDependency，实际: ${JSON.stringify(r.stderr)}`)
    }
    // 对照组：devDependencies 齐全时入口正常跑完（证明拦截来自缺失的 devDependency，而非别处）
    const ok = runRunTestsSandbox(ctl)
    if (ok.status !== 0) {
      throw new Error(`devDependencies 齐全时入口应通过，实际 status=${ok.status}，stderr=${JSON.stringify(ok.stderr)}`)
    }
    if (!String(ok.stdout).includes('全部通过')) throw new Error(`对照组应跑完并汇总通过：${JSON.stringify(ok.stdout)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(ctl, { recursive: true, force: true })
  }
})

test('re2 完全缺失（resolve 失败）→ 归为 missing，提示 npm ci + rebuild', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      resolve: (name) => {
        if (name === 're2') throw new Error('MODULE_NOT_FOUND: re2')
        return '/mock/path'
      },
      load: (name) => name === 're2' ? fakeRe2Class() : {}
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('缺少依赖：re2')) throw new Error(`应提示缺少 re2: ${out}`)
  if (!out.includes('npm ci --ignore-scripts')) throw new Error(`应提示 npm ci: ${out}`)
  if (!out.includes('npm run rebuild --prefix node_modules/re2')) throw new Error(`缺 re2 时应提示 rebuild: ${out}`)
})

test('re2 可 resolve 但 require 抛错（binding 损坏）→ 归为 broken，提示 rebuild 不提示 npm ci', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      resolve: () => '/mock/path',
      load: (name) => {
        if (name === 're2') {
          const err = new Error('The module re2.node was compiled against a different Node.js version')
          err.code = 'ERR_DLOPEN_FAILED'
          throw err
        }
        return {}
      }
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('依赖已安装但不可用：re2')) throw new Error(`应提示不可用: ${out}`)
  if (!out.includes('npm run rebuild --prefix node_modules/re2')) throw new Error(`应提示 rebuild: ${out}`)
  if (out.includes('npm ci --ignore-scripts')) throw new Error(`binding 损坏时不应提示 npm ci: ${out}`)
})

test('re2 探针匹配失败（test 返回 false）→ 归为 broken', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      resolve: () => '/mock/path',
      load: (name) => name === 're2' ? fakeRe2Class({ ok: false }) : {}
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('依赖已安装但不可用：re2')) throw new Error(`探针失败应提示不可用: ${out}`)
})

// F2 回归：脚本此前没有 require.main 守卫——`node scripts/check-deps.js` 只加载模块、不跑检查，
// 于是「直接执行」永远 exit 0 且零输出（挂进脚本链就是一条假绿步骤）。沙箱里的依赖名刻意不存在
// （也不存在于任何祖先 node_modules），保证「缺依赖 → 非 0 退出 + stderr 有原因」可被确定性断言。
test('F2 直接执行脚本：缺依赖必须非 0 退出并输出原因（此前恒 exit 0 且零输出）', () => {
  const dir = makeCheckDepsSandbox({
    manifest: { name: 'sandbox', version: '1.0.0', dependencies: { 'xbk-missing-dep-xyz': '1.0.0' } }
  })
  try {
    const r = runCheckDepsSandbox(dir)
    if (r.status === 0) throw new Error(`缺依赖必须非 0 退出（此前无守卫恒 0），实际 status=${r.status}`)
    if (!String(r.stderr).includes('缺少依赖：xbk-missing-dep-xyz')) {
      throw new Error(`stderr 必须点名 package.json 里声明的缺失依赖，实际: ${JSON.stringify(r.stderr)}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// F1 回归：探测清单此前硬编码（load('got') + resolve('re2')），与 package.json 的声明清单无关，
// 于是「声明了但没装」的运行时依赖永远发现不了（依赖漂移零覆盖）。回退该改动 → 清单退回硬编码
// → ghost-dep 不被探测 → 返回 true，本条变红。
test('F1 探测清单由 package.json 派生：声明但未安装的依赖必须报缺失', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      manifest: () => ({ dependencies: { got: '11.8.6', 'ghost-dep': '1.0.0' } }),
      resolve: (name) => {
        if (name === 'ghost-dep') throw new Error("Cannot find module 'ghost-dep'")
        return '/mock/path'
      },
      load: (name) => fakeRe2Class()
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('缺少依赖：ghost-dep')) throw new Error(`声明清单里的缺失依赖必须被发现: ${out}`)
})

// F1 另一面：未被声明的依赖不参与探测（清单即口径，不靠硬编码猜）。
test('F1 未被声明的依赖不参与探测', () => {
  const probed = []
  const ok = checkDependencies({
    manifest: () => ({ dependencies: { 'only-dep': '1.0.0' } }),
    resolve: (name) => { probed.push(`resolve:${name}`); return '/mock/path' },
    load: (name) => { probed.push(`load:${name}`); return {} }
  })
  if (ok !== true) throw new Error(`期望 true，实际 ${ok}`)
  if (probed.join(',') !== 'resolve:only-dep,load:only-dep') {
    throw new Error(`只应探测声明清单里的依赖，实际探测序列: ${probed.join(',')}`)
  }
})

// F1 兜底：package.json 读不到时不得退化成「零检查」（退回内置清单 got/re2 并告警）。
test('F1 package.json 不可读 → 告警并退回内置清单，不静默零检查', () => {
  const warns = []
  const probed = []
  const originalWarn = console.warn
  let ok
  try {
    console.warn = (...args) => { warns.push(args.join(' ')) }
    ok = checkDependencies({
      manifest: () => { throw new Error('EACCES: permission denied') },
      resolve: (name) => { probed.push(name); return '/mock/path' },
      load: (name) => fakeRe2Class()
    })
  } finally {
    console.warn = originalWarn
  }
  if (ok !== true) throw new Error(`期望 true（内置清单两项都可用），实际 ${ok}`)
  if (probed.join(',') !== 'got,re2') throw new Error(`应退回内置清单 got/re2，实际探测: ${probed.join(',')}`)
  if (!warns.some(w => w.includes('package.json'))) throw new Error(`读失败必须告警，实际 warns=${JSON.stringify(warns)}`)
})

// F4 回归：此前完全没有 Node 版本判定（无 process.versions.node / engines 读取）。
// 第一层是纯函数表：本仓库 engines `>=22.22.2` 与 README 明示的 re2 engines
// `^22.22.2 || ^24.15.0 || >=26.0.0` ——后者更严，23.x / 24.0–24.14 / 25.x 都不在其支持范围内。
test('F4 satisfiesNodeRange：repo engines 与 re2 更严的 engines 都按 npm 口径判定', () => {
  const cases = [
    ['22.22.2', '>=22.22.2', true],
    ['22.22.1', '>=22.22.2', false],
    ['24.18.0', '>=22.22.2', true],
    // re2 的 engines：23.x / 24.0-24.14 / 25.x 均不被支持
    ['22.22.2', '^22.22.2 || ^24.15.0 || >=26.0.0', true],
    ['22.23.0', '^22.22.2 || ^24.15.0 || >=26.0.0', true],
    ['23.5.0', '^22.22.2 || ^24.15.0 || >=26.0.0', false],
    ['24.10.0', '^22.22.2 || ^24.15.0 || >=26.0.0', false],
    ['24.15.0', '^22.22.2 || ^24.15.0 || >=26.0.0', true],
    ['24.18.0', '^22.22.2 || ^24.15.0 || >=26.0.0', true],
    ['25.0.0', '^22.22.2 || ^24.15.0 || >=26.0.0', false],
    ['26.0.0', '^22.22.2 || ^24.15.0 || >=26.0.0', true],
    // 带 prerelease 后缀/前导 v 的运行时版本仍可解析（只取前三段）
    ['v24.18.0-nightly20250101', '>=22.22.2', true],
    // 复合区间、^/~ 上界、精确匹配
    ['24.18.0', '>=22.22.2 <25', true],
    ['26.0.0', '>=22.22.2 <25', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['24.18.0', '=24.18.0', true],
    // 看不懂的写法返回 null（调用方降级告警，不误红）；可解析的候选区间先命中就先满足
    ['24.18.0', 'latest', null],
    ['24.18.0', '^24 || next', true],
    ['24.18.0', 'next || ^24', null]
  ]
  for (const [version, range, expected] of cases) {
    const actual = satisfiesNodeRange(version, range)
    if (actual !== expected) throw new Error(`satisfiesNodeRange(${version}, ${range}) 期望 ${expected}，实际 ${actual}`)
  }
})

// F4 返工：**缺段比较器的 npm X-range 真值表**。修复前的极简解析器只把缺失的段补 0 再比较，
// 于是 `~1` 的上界算成 <1.1.0（npm: <2.0.0）、`~0` 算成 <0.1.0（npm: <1.0.0）、`^0` 算成 <0.0.1
// （npm: <1.0.0）、`1` 被当成精确 =1.0.0（npm: >=1.0.0 <2.0.0）——对一个**自称支持**的写法静默错判。
// 表内每一行的期望值由 semver@7 生成（`node -e "console.log(require('semver').satisfies(v,r))"`），
// 不以本实现为口径。任一行不符即断言红。
test('F4 返工 satisfiesNodeRange：缺段写法必须按 npm X-range 语义（真值表对照 semver@7）', () => {
  const rows = [
    // ~（仅主版本的 tilde 上界正是被打回的形态）
    ['1.9.0', '~1', true], ['0.5.0', '~0', true], ['1.0.0', '~1', true], ['2.0.0', '~1', false],
    ['1.2.9', '~1.2', true], ['1.3.0', '~1.2', false], ['0.2.5', '~0.2', true], ['0.3.0', '~0.2', false],
    // ^（缺段按 X-range 展开：^0 是 <1.0.0 而不是 <0.0.1）
    ['1.9.0', '^1', true], ['2.0.0', '^1', false], ['0.5.0', '^0', true], ['1.0.0', '^0', false],
    ['0.0.9', '^0', true], ['0.5.0', '^0.2', false], ['0.2.9', '^0.2', true], ['0.0.3', '^0.0', true],
    ['0.1.0', '^0.0', false], ['24.18.0', '^24.15.0', true], ['24.10.0', '^24.15.0', false],
    // 裸版本 / = ：缺段是 X-range，不是精确单点
    ['1.2.5', '=1.2', true], ['1.3.0', '=1.2', false], ['2.0.0', '=1', false], ['1.5.0', '=1', true],
    // > / <= ：缺段时比较对象是 X-range 的边界
    ['1.2.5', '>1.2', false], ['1.3.0', '>1.2', true], ['1.5.0', '>1', false], ['2.0.0', '>1', true],
    ['1.2.5', '<=1.2', true], ['1.3.0', '<=1.2', false], ['1.5.0', '<=1', true], ['2.0.0', '<=1', false],
    // < / >= 与 npm 同口径（缺段补 0）
    ['1.2.0', '<1.2', false], ['1.1.9', '<1.2', true], ['2.0.0', '<1', false], ['0.9.9', '<1', true]
  ]
  for (const [version, range, expected] of rows) {
    const actual = satisfiesNodeRange(version, range)
    if (actual !== expected) throw new Error(`satisfiesNodeRange(${version}, ${JSON.stringify(range)}) 期望 ${expected}（npm 口径），实际 ${actual}`)
  }
})

// F4 返工（分支覆盖）：re2 的 engines 比本仓库严，但本机 node_modules/re2 是 V8 替身（无 engines 字段），
// 于是 readNativeEngineRange 的整条生产分支在仓库树上零覆盖。这里在沙箱里放一个自带 engines 的假 re2
// （真实包形状：package.json.engines + 可构造的 RE2 类），直接驱动「re2 engines 更严 → 版本门禁拦下」。
test('F4 返工：re2 自身 engines 更严时纳入版本门禁（沙箱假 re2 驱动该分支）', () => {
  const dir = makeCheckDepsSandbox({
    manifest: { name: 'sandbox', version: '1.0.0', dependencies: { re2: '1.0.0' } },
    deps: ['re2']
  })
  const re2Dir = path.join(dir, 'node_modules', 're2')
  try {
    // 假 re2：可构造且探针通过，只有 engines 参与判定
    fs.writeFileSync(path.join(re2Dir, 'index.js'), 'module.exports = class RE2 { constructor (p) { this.p = p } test () { return true } }\n')
    fs.writeFileSync(path.join(re2Dir, 'package.json'),
      JSON.stringify({ name: 're2', version: '1.0.0', main: 'index.js', engines: { node: '>99.0.0' } }))
    const blocked = runCheckDepsSandbox(dir)
    if (blocked.status === 0) throw new Error(`re2 engines 不满足必须非 0 退出，实际 status=0，stdout=${JSON.stringify(blocked.stdout)}`)
    const err = String(blocked.stderr)
    if (!err.includes('re2 的 engines.node') || !err.includes('>99.0.0')) {
      throw new Error(`stderr 必须点名 re2 的 engines 要求，实际: ${JSON.stringify(err)}`)
    }
    // 对照组：同一份假 re2 换成当前运行时满足的区间 → 必须放行
    // （证伪「拦截来自别的分支」：只有 engines 变了）
    fs.writeFileSync(path.join(re2Dir, 'package.json'),
      JSON.stringify({ name: 're2', version: '1.0.0', main: 'index.js', engines: { node: `>=${process.versions.node.replace(/^v/, '')}` } }))
    const allowed = runCheckDepsSandbox(dir)
    if (allowed.status !== 0) throw new Error(`engines 满足时必须放行，实际 status=${allowed.status}，stderr=${JSON.stringify(allowed.stderr)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// F4 回归（集成）：repo engines 不满足时必须判失败并输出要求与当前版本。
test('F4 repo engines 不满足 → 返回 false 且输出要求', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies({
      manifest: () => ({ dependencies: { got: '11.8.6' }, engines: { node: '>=99.0.0' } }),
      resolve: () => '/mock/path',
      load: () => fakeRe2Class()
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('Node 版本不满足要求')) throw new Error(`必须报版本不满足: ${out}`)
  if (!out.includes('>=99.0.0')) throw new Error(`必须给出 engines 要求: ${out}`)
  if (!out.includes(process.version)) throw new Error(`必须给出当前版本: ${out}`)
})

// F4 兜底：engines 写法不认识 → 告警跳过，不得误红（也不得静默）
test('F4 engines 写法无法解析 → 告警跳过而非误判失败', () => {
  const warns = []
  const originalWarn = console.warn
  let ok
  try {
    console.warn = (...args) => { warns.push(args.join(' ')) }
    ok = checkDependencies({
      manifest: () => ({ dependencies: { got: '11.8.6' }, engines: { node: 'latest' } }),
      resolve: () => '/mock/path',
      load: () => fakeRe2Class()
    })
  } finally {
    console.warn = originalWarn
  }
  if (ok !== true) throw new Error(`无法解析的范围不得判失败，实际 ${ok}`)
  if (!warns.some(w => w.includes('无法解析') && w.includes('latest'))) {
    throw new Error(`无法解析必须告警，实际 warns=${JSON.stringify(warns)}`)
  }
})

// F4 生产路径：本机（CI 矩阵 22.22.2 / 24）应满足真实 engines，无参调用不得因此变红
test('F4 真实 package.json engines 在本机运行时上通过（无参调用 → true）', () => {
  const out = captureErrorOutput(() => {
    const ok = checkDependencies()
    if (ok !== true) throw new Error(`本机 ${process.version} 应满足真实 engines，实际 ${ok}`)
  })
  if (out !== '') throw new Error(`不应有错误输出，实际: ${out}`)
})

// F6 回归：默认解析基准必须统一到项目根。此前默认 load 是裸 `require`（以 scripts/ 为基准），
// 而探测用的 resolve 以 ROOT 为基准——scripts/ 下出现同名包时会 resolve 到根树、require 到脚本树
// （两个模块实例，探针判定与实际加载各测一个）。沙箱刻意造出这种「双树不同实例」：
// <dir>/node_modules/<dep> 可用、<dir>/scripts/node_modules/<dep> require 即抛错。
// 回退 F6 → 直接执行脚本时 require 命中脚本树 → 「依赖已安装但不可用」→ 非 0 退出，本条变红。
test('F6 默认 load 以项目根为基准：scripts/ 下同名坏包不得影响判定', () => {
  const dep = 'xbk-shadow-dep-xyz'
  const dir = makeCheckDepsSandbox({
    manifest: { name: 'sandbox', version: '1.0.0', dependencies: { [dep]: '1.0.0' } },
    deps: [dep],
    brokenDeps: [dep]
  })
  try {
    const r = runCheckDepsSandbox(dir)
    if (r.status !== 0) {
      throw new Error(`应以项目根 node_modules 为准（status 0），实际 status=${r.status}，stderr=${JSON.stringify(r.stderr)}`)
    }
    if (String(r.stderr).includes('BROKEN_IN_SCRIPTS_TREE')) {
      throw new Error(`不得加载 scripts/node_modules 下的同名包: ${JSON.stringify(r.stderr)}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// F5 回归（返工）：默认参数就是生产路径（run_tests.js 的 checkDependencies() 无参调用），此前
// test_check_deps.js 每条用例都显式注入 resolve/load，默认分支零断言。上一版只断言「无参调用
// status 0 且 stdout/stderr 为空」——但基线源码没有 require.main 守卫，直接执行只加载模块、什么
// 都不检查，也恰好满足这两条（空跑假绿，独立验证 V3 实测在基线上仍绿）。
// 返工后断言锚定「检查真的跑了」：每个依赖的 index.js 在被**加载**时往记账文件追加自己的名字，
// 只有真正走完「默认 manifest → 默认 resolve/load（ROOT 基准）」的检查才会留下两条记账。
// → 靶向移除 CLI 守卫（= 基线形态）或让清单退回硬编码，本条立刻红。
test('F5 无参调用（默认 manifest/resolve/load）在隔离依赖树上真的完成检查且静默通过', () => {
  const marker = path.join(os.tmpdir(), `check-deps-run-marker-${process.pid}-${Date.now()}.log`)
  const dir = makeCheckDepsSandbox({
    manifest: { name: 'sandbox', version: '1.0.0', dependencies: { 'xbk-default-path-a': '1.0.0' }, optionalDependencies: { 'xbk-default-path-b': '1.0.0' } },
    deps: ['xbk-default-path-a', 'xbk-default-path-b'],
    marker
  })
  try {
    const r = runCheckDepsSandbox(dir)
    if (r.status !== 0) {
      throw new Error(`无参调用应静默通过，实际 status=${r.status}，stderr=${JSON.stringify(r.stderr)}`)
    }
    if (String(r.stdout) !== '' || String(r.stderr) !== '') {
      throw new Error(`成功路径应零输出，实际 stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    }
    // 关键的证伪锚点：默认路径真的加载了声明清单里的两个包（不检查就没有记账）
    if (!fs.existsSync(marker)) {
      throw new Error('默认参数的检查没有真正执行：依赖一次都没被加载（基线无 CLI 守卫时的空跑形态——silent exit 0 会被空跑满足）')
    }
    const ran = fs.readFileSync(marker, 'utf8')
    for (const name of ['xbk-default-path-a', 'xbk-default-path-b']) {
      if (!ran.includes(name)) {
        throw new Error(`默认清单漏探了 ${name}（依赖漂移零覆盖）：实际记账=${JSON.stringify(ran)}`)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(marker, { force: true })
  }
})

console.log('========================================')
// ============================================================================
// 补充回归测试（靶向 check-deps 存活变异体）。断言对准 README「测试」小节与
// SYSTEM_CONTRACT.md「修改检查」的三条口径：
//   ① 探测清单必须由 package.json 派生（dependencies + optionalDependencies）——F1；
//   ② 必须区分「未安装（resolve 失败）」与「已安装但不可用（load 抛错）」——F3；
//   ③ Node 版本闸门含 npm X-range 语义（`^`/`~`/`>=`/`<=`/`>`/`<`/精确与缺段写法）——F4。
// 未导出的内部纯函数（parseVersion/compareVersion/satisfiesComparator/…）通过「读源码 +
// 追加一行内部导出」在隔离 Module 中编译后直接断言——磁盘上的 scripts/check-deps.js 一字不动。
// ============================================================================
const Module = require('node:module')
const { strictEqual, deepStrictEqual } = require('node:assert/strict')

const NATIVE_NAME = 're2'
const INTERNAL_EXPORTS = '\nmodule.exports.__internals = { parseVersion, compareVersion, satisfiesComparator, dependencyFailureReason, nodeVersionProblems, readNativeEngineRange, declaredRuntimeDependencies, declaredDevDependencies, readPackageManifest }\n'

// 在独立 Module 中编译 check-deps.js 的**当前磁盘内容**（含变异体）+ 内部导出。
// require.main 不等于该 Module ⇒ CLI 分支不触发（无副作用、不走 exitCode）。
function internalsOf (rootDir) {
  const filename = path.join(rootDir, 'scripts', 'check-deps.js')
  const m = new Module(filename, null)
  m.filename = filename
  m.paths = Module._nodeModulePaths(path.dirname(filename))
  m._compile(fs.readFileSync(filename, 'utf8') + INTERNAL_EXPORTS, filename)
  return m.exports.__internals
}

// 内部函数沙箱：真实实现副本（ROOT = 临时目录）+ 可控 package.json + 可选 re2 清单/engines
function makeInternalsSandbox ({ manifest, withRe2 = false, re2Engines }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-internals-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(path.join(__dirname, 'scripts', 'check-deps.js'), path.join(dir, 'scripts', 'check-deps.js'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  if (withRe2) {
    const pkgDir = path.join(dir, 'node_modules', NATIVE_NAME)
    fs.mkdirSync(pkgDir, { recursive: true })
    const re2Pkg = { name: NATIVE_NAME, version: '1.0.0', main: 'index.js' }
    if (re2Engines !== undefined) re2Pkg.engines = { node: re2Engines }
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(re2Pkg))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {}\n')
  }
  return dir
}

// 同时捕获 stderr 与 warn（版本闸门告警走 console.warn，退清单告警也走 warn）
function captureAllOutput (fn) {
  const lines = []
  const origError = console.error
  const origWarn = console.warn
  console.error = (...args) => { lines.push(args.join(' ')) }
  console.warn = (...args) => { lines.push(args.join(' ')) }
  try {
    fn()
  } finally {
    console.error = origError
    console.warn = origWarn
  }
  return lines.join('\n')
}

const A = internalsOf(__dirname)

// ---- parseVersion / compareVersion ----
// 杀 parseVersion 的条件表达式（true/false 两侧）、正则锚点（`^`）与三段判定；
// 杀 compareVersion 的逐段比较与 -1/1 分支（`22.9.0` vs `22.22.2` 必须按数值，不是字典序）。
test('F4 parseVersion：三段/两段、v 前缀与首尾空白、预发布后缀、非法写法为 null', () => {
  deepStrictEqual(A.parseVersion('22.22.2'), [22, 22, 2])
  deepStrictEqual(A.parseVersion('v24.15.0'), [24, 15, 0])
  deepStrictEqual(A.parseVersion('  22.9.0  '), [22, 9, 0])
  deepStrictEqual(A.parseVersion('22.22.2-beta.1'), [22, 22, 2])
  strictEqual(A.parseVersion('22.9'), null)
  strictEqual(A.parseVersion('x22.1.2'), null)
  strictEqual(A.parseVersion(''), null)
})

test('F4 compareVersion：逐段数值比较、三态返回（-1/0/1）', () => {
  strictEqual(A.compareVersion([22, 9, 0], [22, 22, 2]), -1)
  strictEqual(A.compareVersion([22, 22, 2], [22, 9, 0]), 1)
  strictEqual(A.compareVersion([22, 22, 2], [22, 22, 2]), 0)
  strictEqual(A.compareVersion([1, 0, 0], [0, 9, 9]), 1)
  strictEqual(A.compareVersion([0, 9, 9], [1, 0, 0]), -1)
})

// ---- satisfiesComparator ----
// 每个比较器分支都给「边界三连」（n-1 / n / n+1）的真假两侧，杀条件表达式取反、
// 比较符边界与 X-range 上界计算（`~1`→<2.0.0、`=1`→[1.0.0,2.0.0)、`>1`→>=2.0.0）。
test('F4 satisfiesComparator：精确/>=/<=/>/< 的边界三连（n-1、n、n+1）', () => {
  const t = (version, token, expected) => strictEqual(A.satisfiesComparator(A.parseVersion(version), token), expected, `${version} 应 ${expected} 于 ${token}`)
  t('22.22.2', '22.22.2', true)
  t('22.22.1', '22.22.2', false)
  t('22.22.3', '22.22.2', false)
  t('22.22.2', '=22.22.2', true)
  t('22.22.3', '=22.22.2', false)
  t('22.22.2', '>=22.22.2', true)
  t('22.22.1', '>=22.22.2', false)
  t('22.22.2', '<=22.22.2', true)
  t('22.22.3', '<=22.22.2', false)
  t('22.22.3', '>22.22.2', true)
  t('22.22.2', '>22.22.2', false)
  t('22.22.1', '<22.22.2', true)
  t('22.22.2', '<22.22.2', false)
})

test('F4 satisfiesComparator：缺段写法是 X-range，不是补 0 单点（>=1.2 / <=1.2 / >1 / >1.2）', () => {
  const t = (version, token, expected) => strictEqual(A.satisfiesComparator(A.parseVersion(version), token), expected, `${version} 应 ${expected} 于 ${token}`)
  t('1.2.0', '>=1.2', true)
  t('1.1.9', '>=1.2', false)
  t('1.2.9', '<=1.2', true)
  t('1.3.0', '<=1.2', false)
  t('1.9.9', '>1', false)
  t('2.0.0', '>1', true)
  t('1.2.9', '>1.2', false)
  t('1.3.0', '>1.2', true)
  t('1.9.9', '<=1', true)
  t('2.0.0', '<=1', false)
})

test('F4 satisfiesComparator：^ 的上界（含 0.x 三档）与 ~ 的上界（~1 → <2.0.0）', () => {
  const t = (version, token, expected) => strictEqual(A.satisfiesComparator(A.parseVersion(version), token), expected, `${version} 应 ${expected} 于 ${token}`)
  t('22.22.2', '^22.22.2', true)
  t('22.99.0', '^22.22.2', true)
  t('22.22.1', '^22.22.2', false)
  t('23.0.0', '^22.22.2', false)
  t('1.9.9', '^1', true)
  t('2.0.0', '^1', false)
  t('0.9.9', '^0', true)
  t('1.0.0', '^0', false)
  t('0.0.9', '^0.0', true)
  t('0.1.0', '^0.0', false)
  t('0.2.9', '^0.2', true)
  t('0.3.0', '^0.2', false)
  t('0.2.3', '^0.2.3', true)
  t('0.2.99', '^0.2.3', true)
  t('0.3.0', '^0.2.3', false)
  t('0.0.3', '^0.0.3', true)
  t('0.0.4', '^0.0.3', false)
  t('1.9.9', '~1', true)
  t('2.0.0', '~1', false)
  t('0.9.9', '~0', true)
  t('1.0.0', '~0', false)
  t('1.2.0', '~1.2', true)
  t('1.2.99', '~1.2', true)
  t('1.3.0', '~1.2', false)
  t('1.2.99', '~1.2.3', true)
  t('1.3.0', '~1.2.3', false)
})

test('F4 satisfiesComparator：`=` 与裸版本按 X-range 语义（=1 → [1.0.0,2.0.0)），未知写法为 null', () => {
  const t = (version, token, expected) => strictEqual(A.satisfiesComparator(A.parseVersion(version), token), expected, `${version} 应 ${expected} 于 ${token}`)
  t('1.5.0', '=1', true)
  t('1.9.9', '=1', true)
  t('2.0.0', '=1', false)
  t('0.9.0', '=1', false)
  t('1.2.5', '=1.2', true)
  t('1.3.0', '=1.2', false)
  strictEqual(A.satisfiesComparator([22, 22, 2], '*'), null)
  strictEqual(A.satisfiesComparator([22, 22, 2], 'latest'), null)
  strictEqual(A.satisfiesComparator([22, 22, 2], ''), null)
})

// ---- 补测 PlanB：版本解析/比较的剩余存活靶子（父代理逐 id 定位后补齐）----
// 反例（改动前）：下列 8 个变异体在既有用例下全部存活——既有用例覆盖了主路径，但这些「形态边界」没有对样例。

// id 4 @L36 StringLiteral（readPackageManifest 里 fs.readFileSync 的 'utf8' → ''）
// 只断言「读到了 package.json 且能解析出 version」不够——要证明**真的按 utf8 解码**：
// 用沙箱 manifest 写一个含非 ASCII 的值，若编码参数被改成 ''（Buffer）则 JSON.parse 会拿到 Buffer 文本而抛/失真。
test('PlanB readPackageManifest：必须以 utf8 读取（含非 ASCII 值仍能正确解析）', () => {
  const I = internalsOf(makeInternalsSandbox({ manifest: { version: '1.0.0', 备注: '中文值' } }))
  const pkg = I.readPackageManifest()
  strictEqual(pkg.备注, '中文值', '非 ASCII 值必须按 utf8 正确解码（编码参数被改坏即红）')
  strictEqual(pkg.version, '1.0.0')
})

// id 18 @L44 ConditionalExpression（`!group || typeof group !== 'object'` → false）
// 杀「形状守卫被强制为 false」：live 的认非对象 group 会让 Object.keys 抛 TypeError。
test('PlanB declaredRuntimeDependencies：非对象 group 必须跳过而非崩溃（形状守卫）', () => {
  strictEqual(internalsOf(makeInternalsSandbox({ manifest: { dependencies: {} } })).declaredRuntimeDependencies({ dependencies: 'nope', optionalDependencies: 42 }).length, 0,
    '字符串/数字形状的 group 必须被守卫跳过（守卫置 false 会 Object.keys 抛错）')
  deepStrictEqual(internalsOf(makeInternalsSandbox({ manifest: {} })).declaredRuntimeDependencies({ dependencies: { got: '11' } }), ['got'],
    '正常对象形状仍要正确取键（反向对照）')
})

// id 55 @L71 Regex（`/^v?(\d+)\.(\d+)\.(\d+)/` → 末段量词被削成 \d）
// 杀「第三段只取一位」：`22.22.10` 与 `22.22.1` 必须区分。
test('PlanB parseVersion：第三段必须完整取位（数字量词 + 而非单字符）', () => {
  const P = A.parseVersion
  deepStrictEqual(P('22.22.10'), [22, 22, 10], '第三段两位数必须整体取出')
  deepStrictEqual(P('1.0.100'), [1, 0, 100], '第三段三位数同理')
  deepStrictEqual(P('1.0.1'), [1, 0, 1], '反向对照：一位数')
})

// id 61 @L76 EqualityOperator（`i < 3` → `i <= 3`）
// 杀「循环多跑一轮」：a/b 同为长度 3 时第 4 次比较 a[3]===b[3] 皆 undefined 而提前 return 0 ⇒ 不可观测，
// 故必须构造**长度不同**的输入让越界可观测。
test('PlanB compareVersion：长度不等时不得因越界比较而误判相等', () => {
  const C = A.compareVersion
  // 实测语义（已用纯函数独立复算核对）：某节为 undefined 时 `undefined < x` 恒 false ⇒ **两个方向都返回 1**，
  // 这是该函数在「长度不等」上的固有不对称（X-range 语义由 satisfiesComparator 另行处理，不在此函数）。
  // 本用例的可判别点因此只有一个：**不得返回 0**（`i <= 3` 的变异体会在越界那一轮把它读成相等）。
  strictEqual(C([22, 22], [22, 22, 2]) !== 0, true, '缺段 vs 有值段不得被判为相等（i<=3 越界多跑一轮即会返回 0）')
  strictEqual(C([22, 22, 2], [22, 22]) !== 0, true, '反向同样不得判相等')
  strictEqual(C([1, 0], [1, 0, 0]), 1, '实测形态固定为 1（如需变更须连同本断言一起复核）')
  strictEqual(C([1, 0, 0], [1, 0, 0]), 0, '反向对照：完全相等必须返回 0')
})

// id 70 @L77 EqualityOperator（`a[i] < b[i] ? -1 : 1` → `a[i] <= b[i] ? -1 : 1`）
// 杀「等值分支被判成 -1」：必须让某一节**相等**才能区分——a[i]===b[i] 时正确实现返回 1（因为前面已排除 !==）。
test('PlanB compareVersion：某一节相等时方向判定不得反转', () => {
  const C = A.compareVersion
  strictEqual(C([1, 5, 0], [1, 4, 0]), 1, '第二节更大 ⇒ 1（等号被改成 <= 会得 -1）')
  strictEqual(C([1, 4, 0], [1, 5, 0]), -1, '反向')
})

// id 74/75/84 @L92 Regex（satisfiesComparator 的 token 正则三处变异）
// 杀「锚点/可选段/字符类」被削：必须覆盖 `$` 锚点（尾随垃圾须不匹配）、三段的可选性、以及 `^`/`~` 字符类成员。
test('PlanB satisfiesComparator：token 正则的锚点、可选段与字符类成员', () => {
  const S = (v, token) => A.satisfiesComparator(A.parseVersion(v), token)
  strictEqual(S('1.2.3', '>=1.2.3junk'), null, '尾随垃圾必须因 `$` 锚点而不匹配（锚点被删即红）')
  strictEqual(S('1.2.3', '1.2.3'), true, '三段精确写法仍须匹配（可选段不得被削成必选）')
  strictEqual(S('1.2.3', '~1.2'), true, '`~` 必须仍在字符类里（字符类被削即 return null）')
  strictEqual(S('1.2.3', '^1.2'), true, '`^` 同理')
  strictEqual(S('1.2.3', '<1.2'), false, '`<` 同理（反向对照）')
})

// ---- satisfiesNodeRange（公开导出）----
// 杀 `||` 分隔、tokens 拆分、matched=false+break、`result === null` 降级与收尾 return false。
test('F4 satisfiesNodeRange：|| 多段任一命中为真、全不命中为假、空/未知写法为 null', () => {
  const R = '^22.22.2 || ^24.15.0 || >=26.0.0'
  strictEqual(satisfiesNodeRange('22.22.2', R), true)
  strictEqual(satisfiesNodeRange('24.15.0', R), true)
  strictEqual(satisfiesNodeRange('26.0.0', R), true)
  strictEqual(satisfiesNodeRange('27.3.1', R), true)
  strictEqual(satisfiesNodeRange('22.22.1', R), false)
  strictEqual(satisfiesNodeRange('23.0.0', R), false)
  strictEqual(satisfiesNodeRange('24.14.9', R), false)
  strictEqual(satisfiesNodeRange('25.9.9', R), false)
  strictEqual(satisfiesNodeRange('22.22.2', '>=22.0.0 <23.0.0'), true)
  strictEqual(satisfiesNodeRange('23.0.0', '>=22.0.0 <23.0.0'), false)
  strictEqual(satisfiesNodeRange('21.9.9', '>=22.0.0 <23.0.0'), false)
  strictEqual(satisfiesNodeRange('  v22.22.2  ', '  ^22.22.2  '), true)
  strictEqual(satisfiesNodeRange('bad-version', '>=1.0.0'), null)
  strictEqual(satisfiesNodeRange('22.22.2', ''), null)
  strictEqual(satisfiesNodeRange('22.22.2', 'x'), null)
})

// ---- nodeVersionProblems / readNativeEngineRange ----
// 杀 `!satisfied` 取反、`satisfied === null` 的降级告警、typeof 守卫、`pkg && pkg.engines`
// 三元与 `if (nativeRange)` 块、以及 re2 更严闸门的 label 文案。
test('F4 nodeVersionProblems：不满足时的精确 label/required、满足与不可解析时为空的降级路径', () => {
  const I = internalsOf(makeInternalsSandbox({ manifest: {} }))
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '>=22.0.0' } }, '22.22.2'), [])
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '>=26.0.0' } }, '22.22.2'),
    [{ label: 'package.json 的 engines.node', required: '>=26.0.0' }])
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '^24.15.0' } }, '24.15.0'), [])
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '^24.15.0' } }, '24.14.9'),
    [{ label: 'package.json 的 engines.node', required: '^24.15.0' }])
  deepStrictEqual(I.nodeVersionProblems({}, '22.22.2'), [])
  deepStrictEqual(I.nodeVersionProblems(null, '22.22.2'), [])
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: 22 } }, '30.0.0'), [])
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '>=26.0.0' } }, 'not-a-node'), [])
  const out = captureAllOutput(() => {
    deepStrictEqual(I.nodeVersionProblems({ engines: { node: 'garbage' } }, '22.22.2'), [])
  })
  if (!out.includes('无法解析 package.json 的 engines.node 的版本范围「garbage」')) throw new Error(`不可解析的范围应降级告警: ${out}`)
})

test('F4 readNativeEngineRange/nodeVersionProblems：re2 更严的 engines 进闸门并如实标注，缺失时为 null', () => {
  const RE2_RANGE = '^22.22.2 || ^24.15.0 || >=26.0.0'
  const I = internalsOf(makeInternalsSandbox({ manifest: {}, withRe2: true, re2Engines: RE2_RANGE }))
  strictEqual(I.readNativeEngineRange(), RE2_RANGE)
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '>=20.0.0' } }, '23.0.0'),
    [{ label: 're2 的 engines.node', required: RE2_RANGE }])
  deepStrictEqual(I.nodeVersionProblems({ engines: { node: '>=20.0.0' } }, '22.22.2'), [])
  const noEngines = internalsOf(makeInternalsSandbox({ manifest: {}, withRe2: true }))
  strictEqual(noEngines.readNativeEngineRange(), null)
  deepStrictEqual(noEngines.nodeVersionProblems({ engines: { node: '>=20.0.0' } }, '23.0.0'), [])
  strictEqual(internalsOf(makeInternalsSandbox({ manifest: {} })).readNativeEngineRange(), null)
})

// ---- 清单派生：readPackageManifest / declaredRuntimeDependencies / declaredDevDependencies ----
// 杀 F1 的清单派生：字段来源（deps+optional，devDeps 不参与运行时）、Object.keys 顺序、
// `!names.includes` 去重、`!group` 与 `typeof !== 'object'` 守卫、ROOT 路径拼接。
test('F1 readPackageManifest：从 ROOT 读取并解析 package.json（探测清单的派生源）', () => {
  const manifest = { name: 'internals-sandbox', version: '1.0.0', dependencies: { got: '^14.0.0' } }
  deepStrictEqual(internalsOf(makeInternalsSandbox({ manifest })).readPackageManifest(), manifest)
})

test('F1/F3 declaredRuntimeDependencies/declaredDevDependencies：字段、顺序、去重与类型守卫', () => {
  const I = internalsOf(makeInternalsSandbox({ manifest: {} }))
  deepStrictEqual(I.declaredRuntimeDependencies({
    dependencies: { got: '1' }, optionalDependencies: { re2: '1' }, devDependencies: { 'fast-check': '1' }
  }), ['got', 're2'])
  deepStrictEqual(I.declaredRuntimeDependencies({ dependencies: { a: '1' }, optionalDependencies: { a: '1', b: '1' } }), ['a', 'b'])
  deepStrictEqual(I.declaredRuntimeDependencies({ optionalDependencies: { only: '1' } }), ['only'])
  deepStrictEqual(I.declaredRuntimeDependencies({}), [])
  deepStrictEqual(I.declaredRuntimeDependencies(null), [])
  deepStrictEqual(I.declaredRuntimeDependencies({ dependencies: null, optionalDependencies: 5 }), [])
  deepStrictEqual(I.declaredDevDependencies({ devDependencies: { a: '1', b: '1' } }), ['a', 'b'])
  deepStrictEqual(I.declaredDevDependencies({ dependencies: { a: '1' } }), [])
  deepStrictEqual(I.declaredDevDependencies({ devDependencies: null }), [])
  deepStrictEqual(I.declaredDevDependencies({ devDependencies: 'ab' }), [])
  deepStrictEqual(I.declaredDevDependencies(null), [])
})

// ---- dependencyFailureReason ----
// 杀 error.code 前缀拼接、`error && error.message` 的双侧三元与 `&&`→`||`、首行截取与模板顺序。
test('F3 dependencyFailureReason：error.code 前缀 + 仅首行摘要，非 Error 值如实降级', () => {
  const I = internalsOf(makeInternalsSandbox({ manifest: {} }))
  strictEqual(I.dependencyFailureReason(Object.assign(new Error('first line\nsecond line'), { code: 'ERR_REQUIRE_ESM' })), 'ERR_REQUIRE_ESM: first line')
  strictEqual(I.dependencyFailureReason(new Error('plain\nsecond')), 'plain')
  strictEqual(I.dependencyFailureReason(Object.assign(new Error('no code here'), { code: '' })), 'no code here')
  strictEqual(I.dependencyFailureReason({ message: 'only message' }), 'only message')
  strictEqual(I.dependencyFailureReason('boom'), 'boom')
  strictEqual(I.dependencyFailureReason(null), 'null')
  strictEqual(I.dependencyFailureReason(undefined), 'undefined')
})

// ---- checkDependencies（公开 API，注入 resolve/load/manifest）----
test('F1/F3 checkDependencies：全部可解析可加载 → true 且零输出（fail-open 回归）', () => {
  const out = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: () => '/mock/path',
      load: (name) => name === NATIVE_NAME ? fakeRe2Class({ ok: true }) : {}
    }), true)
  })
  strictEqual(out, '')
})

test('F1/F3 checkDependencies：resolve 失败 → missing；仅 re2 缺失才提示 rebuild', () => {
  const both = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: (name) => { throw new Error(`Cannot find module '${name}'`) },
      load: () => ({})
    }), false)
  })
  deepStrictEqual(both.split('\n'), [
    '❌ 缺少依赖：got, re2',
    '请先在项目根目录执行：',
    '  npm ci --ignore-scripts',
    '  npm run rebuild --prefix node_modules/re2'
  ])
  const gotOnly = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: (name) => { if (name === 'got') throw new Error('nope'); return '/mock/path' },
      load: () => fakeRe2Class({ ok: true })
    }), false)
  })
  if (!gotOnly.split('\n').includes('❌ 缺少依赖：got')) throw new Error(gotOnly)
  if (gotOnly.includes('rebuild')) throw new Error(`仅缺 got 时不应提示 rebuild: ${gotOnly}`)
})

test('F3 checkDependencies：可解析但加载抛错 → broken（根因入输出），指引按原生/非原生分流', () => {
  const gotBroken = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: () => '/mock/path',
      load: (name) => {
        if (name === 'got') throw Object.assign(new Error('require() of ES Module\nmore detail'), { code: 'ERR_REQUIRE_ESM' })
        return fakeRe2Class({ ok: true })
      }
    }), false)
  })
  if (!gotBroken.split('\n').includes('❌ 依赖已安装但不可用：got')) throw new Error(gotBroken)
  if (!gotBroken.split('\n').includes('  - got: ERR_REQUIRE_ESM: require() of ES Module')) throw new Error(gotBroken)
  if (!gotBroken.includes('请重新安装依赖')) throw new Error(gotBroken)
  if (gotBroken.includes('请重建原生模块') || gotBroken.includes('缺少依赖')) throw new Error(gotBroken)
  const re2Broken = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: () => '/mock/path',
      load: (name) => { if (name === NATIVE_NAME) throw new Error('binding missing'); return {} }
    }), false)
  })
  if (!re2Broken.split('\n').includes('❌ 依赖已安装但不可用：re2')) throw new Error(re2Broken)
  if (!re2Broken.includes('请重建原生模块或切换 Node 版本')) throw new Error(re2Broken)
  if (re2Broken.includes('请重新安装依赖')) throw new Error(re2Broken)
})

test('F3 checkDependencies：re2 可加载但原生绑定探针不过 → broken；探针只对 re2 生效', () => {
  const probeFail = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: () => '/mock/path',
      load: (name) => name === NATIVE_NAME ? fakeRe2Class({ ok: false }) : {}
    }), false)
  })
  if (!probeFail.split('\n').includes('  - re2: re2 native binding probe failed')) throw new Error(probeFail)
  const out = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1' } }),
      resolve: () => '/mock/path',
      load: () => fakeRe2Class({ ok: false })
    }), true)
  })
  strictEqual(out, '')
})

test('F1 checkDependencies：manifest 读不到 → 告警并回落内置 got/re2（不得退化成零检查）', () => {
  const out = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => { throw new Error('bad manifest') },
      resolve: (name) => { throw new Error(`Cannot find module '${name}'`) },
      load: () => ({})
    }), false)
  })
  if (!out.includes('无法读取 package.json（bad manifest）')) throw new Error(out)
  if (!out.includes('退回内置清单 got/re2')) throw new Error(out)
  if (!out.split('\n').includes('❌ 缺少依赖：got, re2')) throw new Error(out)
  const emptyDeclared = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: {} }),
      resolve: (name) => { if (name === 'got') throw new Error('nope'); return '/mock/path' },
      load: () => fakeRe2Class({ ok: true })
    }), false)
  })
  if (!emptyDeclared.split('\n').includes('❌ 缺少依赖：got')) throw new Error(emptyDeclared)
  const onlyGot = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1' } }),
      resolve: () => { throw new Error('nope') },
      load: () => ({})
    }), false)
  })
  if (!onlyGot.split('\n').includes('❌ 缺少依赖：got')) throw new Error(onlyGot)
  if (onlyGot.includes('re2')) throw new Error(`声明清单未含 re2 时不得探测 re2: ${onlyGot}`)
})

test('RT-08 checkDependencies：includeDevDependencies 只做 resolve，且不与运行时清单重复', () => {
  const esmOnly = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1' }, devDependencies: { 'fast-check': '1' } }),
      resolve: () => '/mock/path',
      load: (name) => { if (name === 'fast-check') throw new Error('ERR_REQUIRE_ESM'); return {} },
      includeDevDependencies: true
    }), true)
  })
  strictEqual(esmOnly, '')
  const missingDev = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1' }, devDependencies: { 'fast-check': '1' } }),
      resolve: (name) => { if (name === 'fast-check') throw new Error('nope'); return '/mock/path' },
      load: () => ({}),
      includeDevDependencies: true
    }), false)
  })
  if (!missingDev.split('\n').includes('❌ 缺少依赖：fast-check')) throw new Error(missingDev)
  const devOff = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1' }, devDependencies: { 'fast-check': '1' } }),
      resolve: (name) => { if (name === 'fast-check') throw new Error('nope'); return '/mock/path' },
      load: () => ({})
    }), true)
  })
  strictEqual(devOff, '')
  const dup = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1' }, devDependencies: { got: '1' } }),
      resolve: () => { throw new Error('nope') },
      load: () => ({}),
      includeDevDependencies: true
    }), false)
  })
  if (!dup.split('\n').includes('❌ 缺少依赖：got')) throw new Error(`重复探测导致清单重复: ${dup}`)
})

test('F4 checkDependencies：Node 版本不满足 → false 并先报版本闸门（X-range 语义），满足时静默', () => {
  const bad = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ engines: { node: '>=99.0.0' }, dependencies: { got: '1' } }),
      resolve: () => '/mock/path',
      load: () => ({})
    }), false)
  })
  if (!bad.split('\n').includes('  - package.json 的 engines.node 要求 >=99.0.0')) throw new Error(bad)
  if (!bad.split('\n').some(l => l.startsWith('❌ Node 版本不满足要求（当前 '))) throw new Error(bad)
  const both = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ engines: { node: '>=99.0.0' }, dependencies: { got: '1' } }),
      resolve: () => { throw new Error('nope') },
      load: () => ({})
    }), false)
  })
  if (both.indexOf('❌ Node 版本不满足要求') > both.indexOf('❌ 缺少依赖')) throw new Error(`版本问题应先于依赖问题: ${both}`)
  const good = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ engines: { node: '>=0.0.1' }, dependencies: { got: '1' } }),
      resolve: () => '/mock/path',
      load: () => ({})
    }), true)
  })
  strictEqual(good, '')
})

test('F3 checkDependencies：missing 与 broken 同时存在 → 两段文案都出（不是二选一）', () => {
  const out = captureAllOutput(() => {
    strictEqual(checkDependencies({
      manifest: () => ({ dependencies: { got: '1', re2: '1' } }),
      resolve: (name) => { if (name === 'got') throw new Error('nope'); return '/mock/path' },
      load: (name) => { if (name === NATIVE_NAME) throw new Error('binding gone'); return {} }
    }), false)
  })
  if (!out.split('\n').includes('❌ 缺少依赖：got')) throw new Error(out)
  if (!out.split('\n').includes('❌ 依赖已安装但不可用：re2')) throw new Error(out)
  if (!out.split('\n').includes('  - re2: binding gone')) throw new Error(out)
})

console.log('  🧪 依赖预检测试（checkDependencies）')
console.log('========================================\n')

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed++
    console.log(`  ✅ ${t.name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${t.name}\n     ${e.message}`)
  }
}

console.log('\n========================================')
console.log(`  依赖预检测试: ${passed} 通过, ${failed} 失败`)
console.log('========================================')
process.exit(failed > 0 ? 1 : 0)
