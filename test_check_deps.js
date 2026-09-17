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
