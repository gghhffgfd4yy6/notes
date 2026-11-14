'use strict'
// scripts/console-routes.js 的靶向套件（D1：dispatchRequest 拆成「薄 ingress + 有序路由表 + 按域 handler」）。
//
// 断言对象是**路由清单与真实 HTTP 行为**，不是 console.js 的源码文本——搬文件/挪实现不该让本套件红，
// 改接口（路径、方法、状态码、鉴权口径、404 形态）才该红：
//   ① 路由表：与拆分前 dispatchRequest 的 endpoint 清单一一对应（顺序 = 原 if 链顺序）、无重复/冲突；
//   ② 匹配语义：method 先比、精确 path 与正则、先命中先返回、未命中返回 null；
//   ③ 端到端：代表性读端点 / 写端点（含 Bearer-only 拒绝路径）/ 动态路径端点 / 未匹配 404。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { createConsole } = require('./scripts/console')
const {
  ROUTE_TABLE, RUN_DETAIL_PATH, createConsoleRoutes, validateRouteTable, matchRoute
} = require('./scripts/console-routes')

const TOKEN = 'console-routes-token-0123456789'
let passed = 0
let failed = 0

function ok (name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.log(`  ❌ ${name}: ${e.message}`)
  }
}

async function aok (name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.log(`  ❌ ${name}: ${e.message}`)
  }
}

// ── 拆分前的 endpoint 清单（逐条抄自 origin/main 的 dispatchRequest，顺序即原 if 链顺序）──
// 少一条 = 某个端点从路由表里掉了；多一条 = 悄悄新增了没人评审的入口；顺序变了 = 命中顺序变了。
const EXPECTED_ROUTES = [
  ['GET', '/api/status'],
  ['GET', '/api/access-log'],
  ['GET', '/api/messages'],
  ['GET', '/api/line-search'],
  ['GET', '/api/line-watch'],
  ['POST', '/api/line-watch'],
  ['POST', '/api/backup/export'],
  ['POST', '/api/backup/import'],
  ['POST', '/api/messages/export'],
  ['GET', '/api/trends'],
  ['GET', '/api/run-history'],
  ['GET', '/api/logs'],
  ['GET', '/api/cache-health'],
  ['GET', '/api/files'],
  ['GET', '/api/config'],
  ['GET', '/api/config/filter'],
  ['GET', '/api/config/filter/draft'],
  ['GET', '/api/sys'],
  ['GET', '/api/2fa/status'],
  ['POST', '/api/devices/revoke'],
  ['POST', '/api/2fa/setup'],
  ['POST', '/api/2fa/enable'],
  ['POST', '/api/2fa/disable'],
  ['GET', '/api/auto'],
  ['POST', '/api/auto'],
  ['GET', '/api/config/console'],
  ['POST', '/api/config/console'],
  ['POST', '/trigger'],
  ['POST', '/api/notify-test'],
  ['GET', '/api/runs'],
  ['GET', '/api/stream'],
  ['GET', '/api/runs/stream'],
  ['POST', '/api/runs/detail'],
  ['POST', '/api/runs/cancel'],
  ['GET', /^\/api\/runs\/(\d{13,}\.\d{1,10})$/]
]

function tableKey (matcher) {
  return typeof matcher === 'string' ? matcher : String(matcher)
}

// ── HTTP 夹具（每个用例自建实例，退出即关服务器 + 删沙箱目录，避免 check-host-clean 的过期沙箱）──
function request (port, method, pathname, { token = '', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ connection: 'close' }, headers)
    if (token !== '') h.authorization = `Bearer ${token}`
    if (body !== '') {
      if (!h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded'
      h['content-length'] = Buffer.byteLength(body)
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch (e) { /* 非 JSON 出口按原文断言 */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.setTimeout(10000, () => req.destroy(new Error(`请求超时：${method} ${pathname}`)))
    req.on('error', reject)
    if (body !== '') req.write(body)
    req.end()
  })
}

async function withConsole (fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-routes-test-'))
  let server = null
  try {
    server = createConsole(Object.assign({ token: TOKEN, stateDir: dir }, options)).server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return await fn({ port: server.address().port, dir })
  } finally {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve)
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function main () {
  console.log('▶ 路由表：清单 / 顺序 / 冲突检测')
  ok('路由清单与拆分前 dispatchRequest 的 endpoint 一一对应（含顺序）', () => {
    const actual = ROUTE_TABLE.map(([method, matcher]) => [method, matcher instanceof RegExp ? tableKey(matcher) : matcher])
    const expected = EXPECTED_ROUTES.map(([method, matcher]) => [method, matcher instanceof RegExp ? tableKey(matcher) : matcher])
    // 逐元素比较：数量、method、路径/正则源、顺序全都算判据（顺序 = 命中顺序 = 行为）
    assert.deepStrictEqual(actual, expected)
    assert.strictEqual(ROUTE_TABLE.length, EXPECTED_ROUTES.length, '路由条数与 endpoint 清单必须一致')
  })

  ok('路由表本身通过重复/冲突校验（当前清单无同 method + 同 path）', () => {
    assert.strictEqual(validateRouteTable(ROUTE_TABLE), ROUTE_TABLE, '校验不得改动或复制清单')
  })

  ok('重复检测：同 method + 同 path 直接抛错（不许静默遮蔽后一项）', () => {
    assert.throws(() => validateRouteTable([
      ['GET', '/api/status', 'a'],
      ['GET', '/api/status', 'b']
    ]), /路由表重复/, '同 path 必须判重复')
    // 正则按 source 判重：同一 pattern 的两种写法（字面量与 sourced 正则）也应撞上
    assert.throws(() => validateRouteTable([
      ['GET', RUN_DETAIL_PATH, 'a'],
      ['GET', new RegExp(RUN_DETAIL_PATH.source), 'b']
    ]), /路由表重复/, '同 pattern 源必须判重复')
    // 不同 method 的同 path 是合法的（GET/POST /api/auto 就是这种形态）
    assert.doesNotThrow(() => validateRouteTable([
      ['GET', '/api/auto', 'a'],
      ['POST', '/api/auto', 'b']
    ]))
  })

  ok('坏条目：缺 method / 匹配器非法 / 缺 handler 名 一律抛错', () => {
    assert.throws(() => validateRouteTable([['', '/x', 'h']]), /缺 method/)
    assert.throws(() => validateRouteTable([['GET', 42, 'h']]), /必须是字符串或正则/)
    assert.throws(() => validateRouteTable([['GET', '/x', '']]), /缺 handler 名/)
    assert.throws(() => validateRouteTable([['GET', '/x']]), /三元组/)
  })

  console.log('▶ matchRoute：匹配语义')
  ok('method 先比；精确 path 严格等值；正则返回 match；未命中返回 null', () => {
    const routes = [
      { method: 'GET', path: '/a', handler: () => 'get-a' },
      { method: 'POST', path: '/a', handler: () => 'post-a' },
      { method: 'GET', pattern: /^\/r\/(\d+)$/, handler: () => 'run' }
    ]
    assert.strictEqual(matchRoute(routes, 'GET', '/a').handler(), 'get-a', '同 path 不同 method 不得串台')
    assert.strictEqual(matchRoute(routes, 'POST', '/a').handler(), 'post-a')
    assert.strictEqual(matchRoute(routes, 'GET', '/A'), null, 'path 必须精确匹配（大小写敏感）')
    assert.strictEqual(matchRoute(routes, 'GET', '/a/'), null, '尾斜杠不得被吞')
    assert.strictEqual(matchRoute(routes, 'GET', '/nope'), null)
    const m = matchRoute(routes, 'GET', '/r/42')
    assert.ok(m && m.match && m.match[1] === '42', '正则命中必须把 match 交给 handler（动态 id 靠它）')
    assert.strictEqual(matchRoute(routes, 'DELETE', '/r/42'), null, 'method 不匹配时正则也不得命中')
  })

  ok('先命中先返回：普通 path 段优先于同方法的正则段（顺序即优先级）', () => {
    const routes = [
      { method: 'GET', pattern: /^\/x\/(.*)$/, handler: () => 'pattern' },
      { method: 'GET', path: '/x/1', handler: () => 'exact' }
    ]
    assert.strictEqual(matchRoute(routes, 'GET', '/x/1').handler(), 'pattern', '排在前的先命中（与旧 if 链一致）')
    const reversed = routes.slice().reverse()
    assert.strictEqual(matchRoute(reversed, 'GET', '/x/1').handler(), 'exact', '调换顺序即改命中结果（顺序真的是判据）')
  })

  console.log('▶ HTTP：代表性 endpoint 的 method/path/status')
  await aok('GET /api/status：200 + JSON（读端点经路由表命中）', async () => {
    await withConsole(async ({ port }) => {
      const r = await request(port, 'GET', `/api/status?token=${TOKEN}`)
      assert.strictEqual(r.status, 200)
      assert.ok(r.json && typeof r.json === 'object', '必须回 JSON 对象')
      assert.ok('generatedAt' in r.json, 'status 快照必须带 generatedAt（与拆分前同形）')
      assert.strictEqual(r.json.report.status, 'missing', '空缓存目录的 report 段必须是 missing')
    })
  })

  await aok('POST /trigger?token=：ingress 写面闸 400 query_token_not_allowed（Bearer-only）', async () => {
    await withConsole(async ({ port }) => {
      const query = await request(port, 'POST', `/trigger?token=${TOKEN}`, { body: 'action=check' })
      assert.strictEqual(query.status, 400, 'URL 里的 token 不得用于写端点')
      assert.strictEqual(query.json.error, 'query_token_not_allowed')
      // 对照：同一条路由收 Bearer 时才放行（会被重放窗/锁拒，但绝不是 401/400 鉴权错）
      const bearer = await request(port, 'POST', '/trigger', { token: TOKEN, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=NOPE' })
      assert.strictEqual(bearer.status, 400, '未知 action 由 handler 拒（证明请求已过鉴权闸进入路由）')
      assert.strictEqual(bearer.json.error, '未知 action')
    })
  })

  await aok('POST /api/auto?token=：handler 内写面复判 400（Bearer-only，与 ingress 同口径）', async () => {
    await withConsole(async ({ port }) => {
      const r = await request(port, 'POST', `/api/auto?token=${TOKEN}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: false })
      })
      assert.strictEqual(r.status, 400)
      assert.strictEqual(r.json.error, 'query_token_not_allowed')
      // 只读 GET 仍接受 ?token=（读写口径不同这一点不许被路由化改掉）
      const read = await request(port, 'GET', `/api/auto?token=${TOKEN}`)
      assert.strictEqual(read.status, 200)
      assert.ok(read.json && read.json.auto, 'GET /api/auto 必须回 auto 快照')
    })
  })

  await aok('动态路径：GET /api/runs/:id 命中与 404；POST /api/runs/detail 坏 body 400', async () => {
    await withConsole(async ({ port }) => {
      const miss = await request(port, 'GET', `/api/runs/1700000000000.1?token=${TOKEN}`)
      assert.strictEqual(miss.status, 404, '不存在的 run 必须 404')
      assert.match(miss.json.error, /not found/, 'run 不存在与「路由不存在」是两种 404，文案不同')
      // 形态不对的 id 不应命中动态路由 → 落到「路由不存在」的 404
      const badShape = await request(port, 'GET', `/api/runs/not-an-id?token=${TOKEN}`)
      assert.strictEqual(badShape.status, 404)
      assert.strictEqual(badShape.json.error, 'not found', 'id 形态不符时不得进 handler（回通用 404）')
      const detail = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: 'id=abc' })
      assert.strictEqual(detail.status, 400)
      assert.match(detail.json.error, /缺少合法 id/)
    })
  })

  await aok('未匹配：未知路径 / method 不匹配都回原 404 形态（{error:"not found"}）', async () => {
    await withConsole(async ({ port }) => {
      const unknown = await request(port, 'GET', `/api/definitely-not-a-route?token=${TOKEN}`)
      assert.strictEqual(unknown.status, 404)
      assert.deepStrictEqual(unknown.json, { error: 'not found' })
      // /trigger 只有 POST：GET 不得命中（旧实现也是落到 404）
      const wrongMethod = await request(port, 'GET', `/trigger?token=${TOKEN}`)
      assert.strictEqual(wrongMethod.status, 404)
      assert.deepStrictEqual(wrongMethod.json, { error: 'not found' })
      // 已存在的路径用错 method 同样 404（不是 405——保持拆分前行为）
      const wrongMethod2 = await request(port, 'POST', '/api/status', { token: TOKEN, body: '' })
      assert.strictEqual(wrongMethod2.status, 404)
    })
  })

  await aok('未授权：路由表不接管鉴权（无凭证一律 401，页面给登录页）', async () => {
    await withConsole(async ({ port }) => {
      const api = await request(port, 'GET', '/api/status')
      assert.strictEqual(api.status, 401, 'API 无凭证必须 401')
      assert.strictEqual(api.json.error, 'unauthorized')
      const page = await request(port, 'GET', '/')
      assert.strictEqual(page.status, 401, '页面无凭证必须 401（HTML 登录页）')
      assert.match(page.text, /<html/i, '页面出口必须是 HTML，不是 JSON')
    })
  })

  console.log('▶ createConsoleRoutes：工厂形状')
  await aok('createConsole 启动即建表（工厂可用；handler 全为函数且条数与清单一致）', async () => {
    await withConsole(async () => {
      // 建表发生在 createConsole 内部：实例能启动就说明 validateRouteTable + handler 名对账都过了。
      // 这里再对「清单条数 = 路由条数」做一次硬断言，防止有人把某个 endpoint 从表里注释掉却仍能起服务。
      assert.strictEqual(ROUTE_TABLE.length, EXPECTED_ROUTES.length)
      assert.ok(typeof createConsoleRoutes === 'function')
    })
  })

  console.log(`\n控制台路由套件：通过 ${passed} / 失败 ${failed}`)
  if (failed > 0) {
    console.log('失败用例：')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('❌ 套件异常：', e && e.stack ? e.stack : e)
  process.exitCode = 1
})
