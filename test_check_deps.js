'use strict'
// checkDependencies 单元测试：验证「缺少依赖」与「已安装但不可用」分支的判定与提示。
// 通过注入 mock 的 resolve/load 模拟不同环境，不依赖本机实际安装状态。
// 另有一组「直接执行脚本」的沙箱用例：在临时目录里复制真实实现 + 自造 node_modules，
// 走默认参数（生产路径）与 CLI 退出码，不受本机依赖树影响。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkDependencies } = require('./scripts/check-deps')

// 沙箱：<dir>/package.json（可控声明清单）+ <dir>/scripts/check-deps.js（复制真实实现）
// + <dir>/node_modules/<name>/{package.json,index.js}。ROOT 由实现自算为 <dir>。
function makeCheckDepsSandbox ({ manifest, deps = [], brokenDeps = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-sandbox-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(path.join(__dirname, 'scripts', 'check-deps.js'), path.join(dir, 'scripts', 'check-deps.js'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  for (const name of deps) {
    const pkgDir = path.join(dir, 'node_modules', name)
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {}\n')
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

function runCheckDepsSandbox (dir) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-deps.js')], { encoding: 'utf8', cwd: dir })
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

console.log('========================================')
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
