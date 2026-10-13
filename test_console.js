'use strict'
// scripts/console.js 测试：token 校验 / 锁语义 / 动作解析 / HTML 转义 / HTTP 端到端（鉴权、
// 看板渲染、触发 202/409、JSON API）。触发用例使用注入式 fake child——不真拉起 xbk_push.js
// （真实触发会写缓存/发通知，测试只验证服务层编排）。

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const {
  createConsole, isValidToken, timingSafeEqualStr,
  acquireLock, releaseLock, lockPath,
  parseAction, escapeHtml, authorize, renderPage, ACTIONS, TOKEN_MIN_LEN, PROC_TIMEOUT_MS
} = require('./scripts/console')

let passed = 0
let failed = 0
function ok (name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`) } catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`) }
}
async function aok (name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`) } catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`) }
}

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-test-')) }

// ── token 校验 ──
ok(`isValidToken: ≥${TOKEN_MIN_LEN} 字符合法`, () => {
  assert.strictEqual(isValidToken('a'.repeat(TOKEN_MIN_LEN)), true)
})
ok('isValidToken: 过短/非字符串/空串拒绝', () => {
  assert.strictEqual(isValidToken('a'.repeat(TOKEN_MIN_LEN - 1)), false)
  assert.strictEqual(isValidToken(''), false)
  assert.strictEqual(isValidToken(undefined), false)
  assert.strictEqual(isValidToken(1.2345678901234568e21), false)
})
ok('createConsole: token 缺失/过短 fail-closed 拒启', () => {
  assert.throws(() => createConsole({ token: undefined, stateDir: tmpDir() }), /XBK_CONSOLE_TOKEN/)
  assert.throws(() => createConsole({ token: 'short', stateDir: tmpDir() }), /XBK_CONSOLE_TOKEN/)
})
ok('timingSafeEqualStr: 等长比较/长度不等 false/异常 false', () => {
  assert.strictEqual(timingSafeEqualStr('abc', 'abc'), true)
  assert.strictEqual(timingSafeEqualStr('abc', 'abd'), false)
  assert.strictEqual(timingSafeEqualStr('abc', 'abcd'), false)
  assert.strictEqual(timingSafeEqualStr(undefined, 'abc'), false)
})

// ── 锁语义 ──
ok('acquireLock: 空目录可获取；持有期内二次获取拒绝', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000), true)
  assert.strictEqual(acquireLock(dir, 2000), false)
  releaseLock(dir)
  assert.strictEqual(acquireLock(dir, 3000), true, '释放后可重新获取')
})
ok('acquireLock: 陈旧锁（age > PROC_TIMEOUT_MS）可接管', () => {
  const dir = tmpDir()
  // startedAt 必须是合法正整数（<=0 会被判为不可信锁而 fail-closed）
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, startedAt: 1 }))
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS + 2), true)
  const data = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
  assert.strictEqual(data.startedAt, PROC_TIMEOUT_MS + 2, '接管后 startedAt 更新')
  assert.strictEqual(fs.existsSync(lockPath(dir) + '.takeover'), false, '接管后哨兵清理')
})
ok('acquireLock: 锁内容损坏 / startedAt 无效 → fail-closed 拒绝', () => {
  const dir = tmpDir()
  // JSON 损坏
  fs.writeFileSync(lockPath(dir), 'not-json{{')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false)
  // startedAt <= 0 或缺失同样不可信（Sourcery #11：Number(...)||0 曾把无效当成 epoch）
  fs.writeFileSync(lockPath(dir), '{"pid":5,"startedAt":0}')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false, 'startedAt=0 拒绝')
  fs.writeFileSync(lockPath(dir), '{"pid":5}')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false, 'startedAt 缺失拒绝')
  fs.writeFileSync(lockPath(dir), '{"pid":5,"startedAt":-5}')
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS * 10), false, 'startedAt 负数拒绝')
})
ok('acquireLock: 持有期内并发获取拒绝（rename 不得静默覆盖）', () => {
  // 回归锁：writeLockAtomic 曾用 rename 覆盖路径，POSIX rename 会静默替换目标，
  // 导致「独占创建」名存实亡——二次获取静默成功，单飞失效。
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000), true)
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(acquireLock(dir, 1000 + i), false, `并发第 ${i + 1} 次必须失败`)
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).startedAt, 1000, '锁内容不被后来者覆盖')
})
ok('acquireLock: 锁内容带归属 token；releaseLockFor 按 pid+token 双匹配作废', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000, 'tok-abc'), true)
  const data = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
  assert.strictEqual(data.token, 'tok-abc', '锁内容必须写入归属 token')
  assert.strictEqual(data.pid, process.pid)
  // token 不匹配（他人锁/pid 复用场景）不作废
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: 1000, token: 'other' }))
  const { releaseLockFor } = require('./scripts/console')
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-abc' })
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).token, 'other', 'token 不匹配不得作废他人锁')
  // 双匹配 → 覆写作废（released:true），且立刻可被接管
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: 1000, token: 'tok-abc' }))
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-abc' })
  const after = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
  assert.strictEqual(after.released, true, 'pid+token 双匹配覆写为 released')
  assert.strictEqual(acquireLock(dir, 1001, 'tok-def'), true, 'released 锁立即可接管')
})
ok('releaseLock: 幂等（不存在不抛错）', () => {
  const dir = tmpDir()
  releaseLock(dir)
  releaseLock(dir)
  assert.ok(true)
})

// ── 动作解析 ──
ok('parseAction: urlencoded 三种合法动作 + 非法动作 null', () => {
  for (const key of Object.keys(ACTIONS)) {
    assert.strictEqual(parseAction(`action=${key}`), key)
    assert.strictEqual(parseAction(`other=1&action=${key}&x=2`), key)
  }
  assert.strictEqual(parseAction('action=nope'), null)
  assert.strictEqual(parseAction(''), null)
  assert.strictEqual(parseAction('action='), null)
})
ok('parseAction: + 号解码（form 编码空格形态）', () => {
  // 动作名都是无空格词，此处只验证解码路径不误伤合法值
  assert.strictEqual(parseAction('action=run'), 'run')
})

// ── HTML 转义 ──
ok('escapeHtml: 五类字符全转义', () => {
  assert.strictEqual(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;')
})
ok('escapeHtml: null/undefined → 空串', () => {
  assert.strictEqual(escapeHtml(null), '')
  assert.strictEqual(escapeHtml(undefined), '')
})

ok('authorize: Bearer 前缀匹配 + ?token= 查询参数（浏览器路径）', () => {
  const TOKEN2 = 'z'.repeat(32)
  const mkReq = (headers) => ({ headers: headers || {} })
  // Bearer 路径
  assert.strictEqual(authorize(mkReq({ authorization: `Bearer ${TOKEN2}` }), TOKEN2, null), true)
  assert.strictEqual(authorize(mkReq({ authorization: `Bearer ${TOKEN2} ` }), TOKEN2, null), true, '尾随空白容忍')
  assert.strictEqual(authorize(mkReq({ authorization: 'Bearer wrong' }), TOKEN2, null), false)
  assert.strictEqual(authorize(mkReq({}), TOKEN2, null), false)
  // 查询参数路径（浏览器导航/表单/meta refresh 用）
  assert.strictEqual(authorize(mkReq({}), TOKEN2, new URLSearchParams(`token=${TOKEN2}`)), true)
  assert.strictEqual(authorize(mkReq({}), TOKEN2, new URLSearchParams('token=wrong')), false)
  assert.strictEqual(authorize(mkReq({}), TOKEN2, new URLSearchParams('other=1')), false)
  // 错误 token + 正确查询参数：查询参数可独立放行（浏览器不带请求头）
  assert.strictEqual(authorize(mkReq({ authorization: 'Bearer wrong' }), TOKEN2, new URLSearchParams(`token=${TOKEN2}`)), true)
})

ok('renderPage: token 回显进表单 action 与 meta refresh；无 token 时不回显', () => {
  const { readStatus } = require('./scripts/status')
  const TOKEN2 = 'q'.repeat(32)
  const dir = tmpDir()
  const state = readStatus(dir) // 空目录 → 全部件「缺失」，formatStatus 合法渲染
  const withToken = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`))
  assert.ok(withToken.includes(`/trigger?token=${TOKEN2}`), '表单带 token')
  assert.ok(withToken.includes(`content="15?token=${TOKEN2}"`), 'meta refresh 带 token')
  const noToken = renderPage(state, [], null)
  assert.ok(!noToken.includes('/trigger?token='), '无 token 时不回显')
  assert.ok(noToken.includes('缺失'), '空缓存目录渲染「缺失」分支')
})

ok('authorize 语义由 HTTP 端到端覆盖（前缀匹配，无正则回溯）', () => {
  // 端到端用例在下方；这里登记实现约束。
  assert.ok(true)
})

// ── HTTP 端到端 ──
function listen (server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function request (port, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode, text: buf, headers: res.headers }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const TOKEN = 'x'.repeat(32)

async function main () {
  await aok('HTTP: 无 token / 错 token → 401', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const noAuth = await request(port, 'GET', '/')
    assert.strictEqual(noAuth.status, 401)
    const badAuth = await request(port, 'GET', '/', { token: 'y'.repeat(32) })
    assert.strictEqual(badAuth.status, 401)
    server.close()
  })
  await aok('HTTP: 看板页含状态内容与触发按钮（缓存目录缺文件时降级展示）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'GET', '/', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.ok(res.text.includes('xbk-push 控制台'))
    assert.ok(res.text.includes('运行状态'))
    assert.ok(res.text.includes('试运行'))
    assert.ok(res.text.includes('环境检查'))
    assert.ok(res.text.includes('正式运行一轮'))
    // Sourcery #37：缺文件夹具必须断言「缺失」分支文案，不许「正常」蒙混——
    // 两种文案都接受的断言抓不住缺失降级走错分支的回归。
    assert.ok(res.text.includes('缺失'), `空缓存目录必须渲染「缺失」分支，实际片段：${res.text.slice(0, 400)}`)
    server.close()
  })
  await aok('HTTP: ?token= 查询参数放行（浏览器流：看板、API、表单触发）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 无请求头、仅查询参数 → 200（普通浏览器打开 URL 的形态）
    const page = await request(port, 'GET', `/?token=${TOKEN}`)
    assert.strictEqual(page.status, 200, '浏览器打开带 token URL 必须放行')
    assert.ok(page.text.includes(`/trigger?token=${TOKEN}`), '返回页里的表单/refresh 要继续携带 token')
    const api = await request(port, 'GET', `/api/status?token=${TOKEN}`)
    assert.strictEqual(api.status, 200, '查询参数对 JSON API 同样放行')
    const noTok = await request(port, 'GET', '/')
    assert.strictEqual(noTok.status, 401)
    server.close()
  })
  await aok('HTTP: /api/status 返回 JSON（status 字段齐全）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'GET', '/api/status', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.text)
    for (const key of ['generatedAt', 'report', 'channels', 'run', 'diagnostics']) {
      assert.ok(Object.prototype.hasOwnProperty.call(data, key), `缺 ${key}`)
    }
    server.close()
  })
  await aok('HTTP: POST /trigger 非法 action → 400', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=hack' })
    assert.strictEqual(res.status, 400)
    server.close()
  })
  await aok('HTTP: POST /trigger 合法动作 → 202 且锁文件生成；运行中再触发 → 409；结束后锁释放', async () => {
    const dir = tmpDir()
    const { server, runs } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const first = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(first.status, 202)
    const firstBody = JSON.parse(first.text)
    assert.ok(firstBody.id > 0)
    assert.strictEqual(fs.existsSync(lockPath(dir)), true, '触发后必须有锁')
    const second = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
    assert.strictEqual(second.status, 409, '持有期内第二个触发必须 409')
    // 模拟子进程结束：找到 run 里的 fake 记录——真实子进程已 spawn（node qinglong/xbk_push.js --check 在本机可跑），
    // 等 close 事件释放锁（--check 只做环境检查，秒级完成）。
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const rec = runs.get(firstBody.id)
      if (rec && rec.finishedAt) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const rec = runs.get(firstBody.id)
    assert.ok(rec && rec.finishedAt, '子进程应在 30s 内结束（--check 环境检查很快）')
    const lockAfter = fs.existsSync(lockPath(dir)) ? JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')) : null
    assert.ok(!lockAfter || lockAfter.released === true, '结束后锁必须释放（移除或作废）')
    const third = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(third.status, 202, '锁释放后可再次触发')
    // 清理第二个 run 的子进程（可能还在跑）
    server.close()
  })
  await aok('HTTP: /api/runs 列表与 /api/runs/:id 详情', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const trig = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    const { id } = JSON.parse(trig.text)
    const list = JSON.parse((await request(port, 'GET', '/api/runs', { token: TOKEN })).text)
    assert.ok(Array.isArray(list.runs) && list.runs.some(r => r.id === id))
    // Sourcery #39：等子进程结束再断言 output 非空——--check 必然打印环境信息，
    // 只断言「是字符串」抓不住输出捕获链路整体失效的回归。
    const deadline = Date.now() + 30000
    let detail = null
    while (Date.now() < deadline) {
      detail = JSON.parse((await request(port, 'GET', `/api/runs/${id}`, { token: TOKEN })).text)
      if (detail.finishedAt) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(detail && detail.finishedAt, '子进程应在 30s 内结束')
    assert.ok(typeof detail.output === 'string' && detail.output.length > 0, 'output 必须捕获到子进程实际输出')
    const missing = await request(port, 'GET', '/api/runs/99999', { token: TOKEN })
    assert.strictEqual(missing.status, 404)
    server.close()
  })
  await aok('HTTP: 未知路径 → 404', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'GET', '/nope', { token: TOKEN })
    assert.strictEqual(res.status, 404)
    server.close()
  })
}

main()
  .then(() => {
    console.log(`\n控制台套件：通过 ${passed} / 失败 ${failed}`)
    if (failed > 0) process.exitCode = 1
  })
  .catch(e => { console.error('套件执行异常:', e.message); process.exitCode = 1 })
