'use strict'
// checkDependencies 单元测试：验证「缺少依赖」与「已安装但不可用」分支的判定与提示。
// 通过注入 mock 的 resolve/load 模拟不同环境，不依赖本机实际安装状态。
const { checkDependencies } = require('./scripts/check-deps')

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
      resolve: () => '/mock/path',
      load: (name) => {
        if (name === 'got') throw new Error('MODULE_NOT_FOUND: got')
        return fakeRe2Class()
      }
    })
    if (ok !== false) throw new Error(`期望 false，实际 ${ok}`)
  })
  if (!out.includes('缺少依赖：got')) throw new Error(`应提示缺少 got: ${out}`)
  if (!out.includes('npm ci --ignore-scripts')) throw new Error(`应提示 npm ci: ${out}`)
  if (out.includes('npm run rebuild --prefix node_modules/re2')) throw new Error(`仅缺 got 时不应提示 rebuild: ${out}`)
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
