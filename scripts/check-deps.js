'use strict'
// 依赖预检：按 package.json 的运行时声明（dependencies + optionalDependencies）逐项探测，
// 含 re2 原生绑定探针；区分「未安装」与「已安装但不可用」两种情况并输出对应修复指引与失败根因。
// 另校验运行时 Node 版本是否满足 package.json 的 engines.node 与 re2 自身的 engines.node
// （re2 的口径更严，见 README：23.x / 24.0–24.14 / 25.x 都不在其支持范围内）。
// 支持注入 resolve/load/manifest 以便测试（默认使用 Node 的 require 体系与 ROOT/package.json）。
// 已修的两条口径缺口（本轮审查 F5/F6）：默认 load 与 resolve 统一以 ROOT 为基准（scripts/ 下
// 出现同名包不再可能「resolve 一个实例、require 另一个」）；默认参数（生产路径）已有沙箱断言。
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')

// re2 是唯一需要「重建原生绑定」这一步的依赖：它的修复指引与普通依赖不同（见输出分支）
const NATIVE_DEP = 're2'

// F1：探测清单必须来自 package.json 的运行时声明。此前清单硬编码在代码里
// （load('got') + resolve('re2')），声明清单变化或新增运行时依赖时预检零覆盖（依赖漂移不可见）。
function readPackageManifest () {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

// 运行时声明清单：dependencies + optionalDependencies（devDependencies 是测试/工具链，不参与运行时预检）
function declaredRuntimeDependencies (pkg) {
  const names = []
  for (const field of ['dependencies', 'optionalDependencies']) {
    const group = pkg && pkg[field]
    if (!group || typeof group !== 'object') continue
    for (const name of Object.keys(group)) if (!names.includes(name)) names.push(name)
  }
  return names
}

// F3：把被吞掉的根因提取成一行摘要（带 error.code），只取首行避免把 require 栈整段刷进输出。
function dependencyFailureReason (error) {
  const message = error && error.message ? String(error.message) : String(error)
  const code = error && error.code ? `${error.code}: ` : ''
  return `${code}${message.split('\n')[0]}`
}

// ---- F4：Node 版本闸门 ----
// 极简范围判定：只支持 `||` 分隔的候选区间 + 空白分隔的比较器（>= > <= < = ^ ~ 与裸版本）。
// 本仓库 engines.node 与 re2 的 engines.node 都是这种写法（re2 为 `^22.22.2 || ^24.15.0 || >=26.0.0`），
// 故不引入 semver 依赖；看不懂的写法一律返回 null，由调用方降级为告警（不误红）。
function parseVersion (value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareVersion (a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function satisfiesComparator (version, token) {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(token)
  if (!m) return null
  const op = m[1] || '='
  const low = [Number(m[2]), Number(m[3] || 0), Number(m[4] || 0)]
  if (op === '>=') return compareVersion(version, low) >= 0
  if (op === '>') return compareVersion(version, low) > 0
  if (op === '<=') return compareVersion(version, low) <= 0
  if (op === '<') return compareVersion(version, low) < 0
  if (op === '=') return compareVersion(version, low) === 0
  // ^ 与 ~ 的上界按 npm 口径：^1.2.3 → <2.0.0、^0.2.3 → <0.3.0、^0.0.3 → <0.0.4、~1.2.3 → <1.3.0
  const high = op === '^'
    ? (low[0] > 0 ? [low[0] + 1, 0, 0] : (low[1] > 0 ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1]))
    : [low[0], low[1] + 1, 0]
  return compareVersion(version, low) >= 0 && compareVersion(version, high) < 0
}

// 返回 true（满足）/ false（不满足）/ null（范围写法不认识，调用方降级告警）
function satisfiesNodeRange (versionText, range) {
  const version = parseVersion(versionText)
  if (!version) return null
  const alternates = String(range).trim().split('||')
  for (const alternate of alternates) {
    const tokens = alternate.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return null
    let matched = true
    for (const token of tokens) {
      const result = satisfiesComparator(version, token)
      if (result === null) return null
      if (!result) { matched = false; break }
    }
    if (matched) return true
  }
  return false
}

// re2 自身的 engines.node（比本仓库严）：re2 没装或没写 engines 时返回 null（缺失由依赖探测分支负责）
function readNativeEngineRange () {
  try {
    const manifestPath = require.resolve(`${NATIVE_DEP}/package.json`, { paths: [ROOT] })
    const nativePkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return nativePkg && nativePkg.engines ? nativePkg.engines.node : null
  } catch (error) {
    return null
  }
}

// 收集所有不满足的 Node 版本要求（repo engines + re2 engines）
function nodeVersionProblems (pkg, currentVersion) {
  const problems = []
  if (!parseVersion(currentVersion)) return problems
  const checks = [['package.json 的 engines.node', pkg && pkg.engines ? pkg.engines.node : null]]
  const nativeRange = readNativeEngineRange()
  if (nativeRange) checks.push([`${NATIVE_DEP} 的 engines.node`, nativeRange])
  for (const [label, range] of checks) {
    if (!range || typeof range !== 'string') continue
    const satisfied = satisfiesNodeRange(currentVersion, range)
    if (satisfied === null) {
      console.warn(`⚠️ 无法解析 ${label} 的版本范围「${range}」，跳过该项 Node 版本闸门`)
      continue
    }
    if (!satisfied) problems.push({ label, required: range })
  }
  return problems
}

// F6：默认 load 也以 ROOT 为基准。此前默认值是裸 `require`（以本文件所在目录 scripts/ 为基准），
// 与 probe 侧的 resolve(name, { paths: [ROOT] }) 口径不一致：scripts/ 下一旦出现同名包，
// 就会「resolve 到一个实例、require 到另一个实例」，探针与真实加载各测一个（潜在不一致）。
function loadFromRoot (name) {
  return require(require.resolve(name, { paths: [ROOT] }))
}

function checkDependencies ({ resolve = require.resolve, load = loadFromRoot, manifest = readPackageManifest } = {}) {
  const missing = []
  const broken = []
  const versionProblems = []

  let pkg = null
  try {
    pkg = manifest()
  } catch (error) {
    // package.json 读不到/解析失败：如实告警并退回内置清单——预检本身不得因此退化成「零检查」
    console.warn(`⚠️ 无法读取 package.json（${dependencyFailureReason(error)}），退回内置清单 got/re2`)
  }
  const declared = declaredRuntimeDependencies(pkg)
  const targets = declared.length > 0 ? declared : ['got', NATIVE_DEP]

  // F4：此前完全不校验 Node 版本（无 process.versions.node / engines 判定），而 re2 的 engines
  // 严于本仓库 engines——README 明示 Node 23.x、24.0–24.14、25.x 上装/重建 re2 必然失败。
  versionProblems.push(...nodeVersionProblems(pkg, process.versions.node))

  for (const name of targets) {
    // F3：两段判定——resolve 失败才是「缺少」；resolve 成功而加载抛错（ERR_REQUIRE_ESM、
    // 内部依赖缺失、原生绑定损坏等）是「已安装但不可用」，此前一律按 missing 报「缺少 got」。
    try {
      resolve(name, { paths: [ROOT] })
    } catch (error) {
      missing.push(name)
      continue
    }

    try {
      const mod = load(name)
      // re2 原生绑定探针只对 re2 生效：能加载不等于绑定可用（跨 Node 版本编译的 .node 会加载失败）
      if (name === NATIVE_DEP) {
        const RE2 = mod // standard new-cap：构造器名须大写开头
        const probe = new RE2('^re2$')
        if (!probe.test('re2')) throw new Error('re2 native binding probe failed')
      }
    } catch (error) {
      broken.push({ name, reason: dependencyFailureReason(error) })
    }
  }

  if (missing.length === 0 && broken.length === 0 && versionProblems.length === 0) return true

  // F4：Node 版本不满足时先把要求摆出来（含 re2 更严的那一条），再报依赖问题，
  // 避免用户在「re2 装不上」的现场先看到一堆与版本无关的指引。
  if (versionProblems.length > 0) {
    console.error(`❌ Node 版本不满足要求（当前 ${process.version}）：`)
    for (const p of versionProblems) console.error(`  - ${p.label} 要求 ${p.required}`)
  }

  if (missing.length > 0) {
    console.error(`❌ 缺少依赖：${missing.join(', ')}`)
    console.error('请先在项目根目录执行：')
    console.error('  npm ci --ignore-scripts')
    // 仅 re2 缺失时才提示重建原生模块；只缺 got 时该目录可能尚未创建，避免误导
    if (missing.includes(NATIVE_DEP)) {
      console.error(`  npm run rebuild --prefix node_modules/${NATIVE_DEP}`)
    }
  }
  if (broken.length > 0) {
    console.error(`❌ 依赖已安装但不可用：${broken.map(b => b.name).join(', ')}`)
    // F3：根因入输出——此前 catch 完全丢弃 error，只留下「缺少 got」这类误判文案。
    for (const b of broken) console.error(`  - ${b.name}: ${b.reason}`)
    // re2 的修复动作含「切换 Node 版本」（其 engines 比本仓库严，见上方版本闸门），故带上当前版本对照
    if (broken.some(b => b.name === NATIVE_DEP)) {
      console.error(`请重建原生模块或切换 Node 版本（当前 ${process.version}）：`)
      console.error(`  npm run rebuild --prefix node_modules/${NATIVE_DEP}`)
    }
    // 指引按实际不可用的依赖给出：非原生依赖（got）走重装，rebuild re2 对它没有意义。
    if (broken.some(b => b.name !== NATIVE_DEP)) {
      console.error(`请重新安装依赖（当前 ${process.version}）：`)
      console.error('  npm ci --ignore-scripts')
    }
  }
  return false
}

module.exports = { checkDependencies, satisfiesNodeRange }

// F2：此前没有 CLI 守卫——`node scripts/check-deps.js` 只加载模块、不执行任何检查，
// 于是「直接执行」这个入口永远 exit 0 且零输出（fail-open：把它挂进脚本链/CI 步骤时会静默放行）。
// 直接执行时跑一次检查并把结果落到退出码（用 process.exitCode 而非 process.exit，管道场景不丢输出）；
// 失败原因已由检查自身写到 stderr，成功路径保持静默（成功不产出噪声）。
if (require.main === module) {
  process.exitCode = checkDependencies() ? 0 : 1
}
