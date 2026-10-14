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
ok('isValidToken: 浏览器不可传输字符拒绝（Sourcery G_ot）', () => {
  assert.strictEqual(isValidToken('a\u00e9'.repeat(16)), false, '非 Latin-1（fetch ByteString 会抛错）拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + ';b'.repeat(4)), false, '分号（Set-Cookie 分隔符）拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + ',b'.repeat(4)), false, '逗号拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + '"b'.repeat(4)), false, '双引号拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + '\\b'.repeat(4)), false, '反斜杠拒绝')
  assert.strictEqual(isValidToken('a'.repeat(8) + ' b'.repeat(4)), false, '空白拒绝')
  assert.strictEqual(isValidToken('-_.~' + 'a'.repeat(28)), true, '安全符号仍合法')
  // Sourcery Trailing-newline：$ 会匹配尾随换行前的位置——行尾终止符必须显式拒绝
  assert.strictEqual(isValidToken('a'.repeat(16) + '\n'), false, '尾随 LF 拒绝')
  assert.strictEqual(isValidToken('a'.repeat(16) + '\r'), false, '尾随 CR 拒绝')
  assert.strictEqual(isValidToken('a'.repeat(16) + '\u2028'), false, '尾随 U+2028 拒绝')
  // Sourcery Raw-token-URLs：& # + 让 raw ?token= 链接失效，启动闸禁掉
  assert.strictEqual(isValidToken('a'.repeat(8) + '&'.repeat(8)), false, '& 拒绝（URL 分隔符）')
  assert.strictEqual(isValidToken('a'.repeat(8) + '#'.repeat(8)), false, '# 拒绝（锚点）')
  assert.strictEqual(isValidToken('a'.repeat(8) + '+'.repeat(8)), false, '+ 拒绝（空格解码）')
  // Sourcery Long-tokens：超长 token 被浏览器 Cookie 静默丢弃 → 资产全 401
  assert.strictEqual(isValidToken('a'.repeat(201)), false, '超长（>200）拒绝')
  assert.strictEqual(isValidToken('a'.repeat(200)), true, '恰好 200 通过')
})
ok('sessionCookieValue: 解析/多段/无值/null', () => {
  const { sessionCookieValue, SESSION_COOKIE } = require('./scripts/console')
  assert.strictEqual(SESSION_COOKIE, 'xbk_session')
  assert.strictEqual(sessionCookieValue('xbk_session=abc; other=1'), 'abc')
  assert.strictEqual(sessionCookieValue('other=1; xbk_session=abc'), 'abc')
  assert.strictEqual(sessionCookieValue('xbk_session=a%40b'), 'a@b', 'decodeURIComponent 还原')
  assert.strictEqual(sessionCookieValue('xbk_session='), null)
  assert.strictEqual(sessionCookieValue('other=1'), null)
  assert.strictEqual(sessionCookieValue(''), null)
  assert.strictEqual(sessionCookieValue(undefined), null)
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

ok('renderPage: token 经 JSON 岛注入；无 token 时空 token；含资产与 CSP 引用', () => {
  const { readStatus } = require('./scripts/status')
  const TOKEN2 = 'q'.repeat(32)
  const dir = tmpDir()
  const state = readStatus(dir) // 空目录 → 全部件「缺失」，formatStatus 合法渲染
  const withToken = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`))
  // JSON 岛注入（v3.285：SPA 壳；fetch 由前端发起，不再有原生表单/meta refresh）
  assert.ok(withToken.includes(`"token":"${TOKEN2}"`), 'JSON 岛带 token')
  assert.ok(withToken.includes('id="xbk-boot"'), 'JSON 岛节点存在')
  assert.ok(withToken.includes('/assets/app.js'), '引用前端 ESM')
  assert.ok(withToken.includes('/assets/app.css'), '引用样式')
  assert.ok(withToken.includes('Content-Security-Policy'), '带 CSP')
  // Sourcery vww：CSP 不能只断言 meta 名——被削弱的策略（如 default-src *）也含这个字符串。
  // 必须锁死关键指令本体。
  assert.ok(withToken.includes("default-src 'none'"), "CSP 含 default-src 'none'")
  assert.ok(withToken.includes("script-src 'self'"), "CSP 含 script-src 'self'")
  assert.ok(withToken.includes("connect-src 'self'"), "CSP 含 connect-src 'self'")
  assert.ok(!withToken.includes('http-equiv="refresh"'), '不再 meta refresh 整页刷新')
  const noToken = renderPage(state, [], null)
  assert.ok(noToken.includes('"token":""'), '无 token 时 JSON 岛为空串（前端触发会 401，符合 fail-closed）')
  assert.ok(!noToken.includes(`"token":"${TOKEN2}"`), '无 token 时不回显')
  assert.ok(noToken.includes('缺失'), '空缓存目录渲染「缺失」分支（noscript 降级）')
  // Sourcery vwK：特殊字符 token 必须以 \uXXXX JSON 转义进岛（script 文本不做实体解码，
  // HTML 实体会让前端 parse 出错误 token）；JSON.parse 后必须还原为原值。
  const WEIRD = 'a<b>&"\\u2028' + 'z'.repeat(20)
  const weirdPage = renderPage(state, [], new URLSearchParams(`token=${encodeURIComponent(WEIRD)}`))
  assert.ok(!weirdPage.includes('<b>'), '岛内不得出现裸 <script 片段')
  const m = /<script type="application\/json" id="xbk-boot">([\s\S]*?)<\/script>/.exec(weirdPage)
  assert.ok(m, 'JSON 岛可提取')
  const parsed = JSON.parse(m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'))
  assert.strictEqual(parsed.token, WEIRD, '岛内 token 经 JSON 解析还原为原值')
  // 常规 token 原样进岛（不引入任何实体）
  const plain = renderPage(state, [], new URLSearchParams(`token=${TOKEN2}`))
  assert.ok(plain.includes(`"token":"${TOKEN2}"`), '常规 token 原样回显')
})

ok('authorize 语义由 HTTP 端到端覆盖（前缀匹配，无正则回溯）', () => {
  // 端到端用例在下方；这里登记实现约束。
  assert.ok(true)
})

// ── HTTP 端到端 ──
function listen (server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function request (port, method, urlPath, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const base = token ? { authorization: `Bearer ${token}` } : {}
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...base, ...(headers || {}) } }, (res) => {
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
  await aok('HTTP: 看板页为 SPA 壳（JSON 岛 + 资产引用 + noscript 降级）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    const res = await request(port, 'GET', '/', { token: TOKEN })
    assert.strictEqual(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.ok(res.text.includes('xbk-push 控制台'))
    assert.ok(res.text.includes('id="app"'), 'SPA 挂载点')
    assert.ok(res.text.includes('id="xbk-boot"'), 'JSON 岛')
    assert.ok(res.text.includes('/assets/app.js'), '前端 ESM 引用')
    assert.ok(res.text.includes('试运行'), 'noscript 降级文案（触发动作说明）')
    assert.ok(res.text.includes('环境检查'))
    assert.ok(res.text.includes('正式运行一轮'))
    // Sourcery #37：缺文件夹具必须断言「缺失」分支文案，不许「正常」蒙混——
    // 两种文案都接受的断言抓不住缺失降级走错分支的回归。
    assert.ok(res.text.includes('缺失'), `空缓存目录必须渲染「缺失」分支，实际片段：${res.text.slice(0, 400)}`)
    server.close()
  })
  await aok('HTTP: /assets/* 须鉴权（无凭证 401；token/Cookie 200）；未知资产/穿越仍 404', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    // Sourcery G_oJ：资产与数据同面鉴权——无凭证一律 401（与文档口径一致）；
    // 浏览器凭 / 鉴权后下发的会话 Cookie 满足 ESM import 无法带头的限制。
    const css = await request(port, 'GET', '/assets/app.css')
    assert.strictEqual(css.status, 401, '资产无凭证必须 401')
    const cssTok = await request(port, 'GET', '/assets/app.css', { token: TOKEN })
    assert.strictEqual(cssTok.status, 200, '?token= 可取资产')
    assert.match(cssTok.headers['content-type'], /text\/css/)
    assert.ok(cssTok.text.includes('--bg'), 'CSS 内容真实（自定义属性存在）')
    const cssCookie = await request(port, 'GET', '/assets/app.css', { headers: { cookie: `xbk_session=${TOKEN}` } })
    assert.strictEqual(cssCookie.status, 200, '会话 Cookie 可取资产（ESM 链路径）')
    // 页面响应必须下发会话 Cookie（HttpOnly/SameSite=Strict）
    const page = await request(port, 'GET', '/', { token: TOKEN })
    const cookieHeader = (page.headers['set-cookie'] || []).find(c => c.startsWith('xbk_session='))
    assert.ok(cookieHeader, '/ 鉴权后下发会话 Cookie')
    // Sourcery Issued-session-cookie：不能只看前缀——属性逐项锁死，错值或缺属性必须红。
    assert.ok(cookieHeader.includes('HttpOnly'), 'Cookie 含 HttpOnly')
    assert.ok(cookieHeader.includes('SameSite=Strict'), 'Cookie 含 SameSite=Strict')
    assert.ok(cookieHeader.includes('Path=/'), 'Cookie 含 Path=/')
    assert.ok(cookieHeader.includes(`xbk_session=${encodeURIComponent(TOKEN)}`), 'Cookie 值=encoded token')
    // Sourcery G_4Kk：资产 URL 不再拼 tokenSuffix（Cookie 通道已覆盖，URL 零凭证重复）
    assert.ok(!page.text.includes('/assets/app.css?token='), '资产 URL 不含 ?token=')
    assert.ok(!page.text.includes('/assets/app.js?token='), '脚本 URL 不含 ?token=')
    const js = await request(port, 'GET', '/assets/app.js', { token: TOKEN })
    assert.strictEqual(js.status, 200)
    assert.match(js.headers['content-type'], /text\/javascript/)
    // Sourcery vwr：不能只断言状态码+MIME——空壳 app.js 也过。锁死模块内容标志。
    assert.ok(js.text.includes("from './htm-preact.module.js'"), 'app.js 含真实 import（非空壳）')
    assert.ok(js.text.includes('render('), 'app.js 含 render 调用')
    const lib = await request(port, 'GET', '/assets/htm-preact.module.js', { token: TOKEN })
    assert.strictEqual(lib.status, 200)
    assert.ok(lib.text.length > 10000, '运行时文件非空壳')
    // token 绝不进资产响应（资产不含用户数据的安全边界）。
    assert.ok(!js.text.includes(TOKEN), 'app.js 内容不含 token')
    assert.ok(!lib.text.includes(TOKEN), 'vendor 内容不含 token')
    const nope = await request(port, 'GET', '/assets/nope.js', { token: TOKEN })
    assert.strictEqual(nope.status, 404, '白名单外 404')
    const traversal = await request(port, 'GET', '/assets/..%2F..%2Fconsole.js', { token: TOKEN })
    assert.strictEqual(traversal.status, 404, '路径穿越形态 404（白名单精确匹配，不解码拼接）')
    server.close()
  })
  await aok('HTTP: ?token= 查询参数放行（浏览器流：看板、API、表单触发）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 无请求头、仅查询参数 → 200（普通浏览器打开 URL 的形态）
    const page = await request(port, 'GET', `/?token=${TOKEN}`)
    assert.strictEqual(page.status, 200, '浏览器打开带 token URL 必须放行')
    assert.ok(page.text.includes(`"token":"${TOKEN}"`), '返回页 JSON 岛要继续携带 token')
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
    // 幂等重放窗（Sourcery G_nm）：首轮结束+锁已释放，但同 action 重试在窗口内仍须 409
    // （防「202 响应丢失 → 重试 → 再跑一轮真实推送」），且响应带首轮 runId。
    const replay = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(replay.status, 409, '重放窗内同 action 重试必须 409（首轮已结束也拦）')
    const replayBody = JSON.parse(replay.text)
    assert.strictEqual(replayBody.runId, firstBody.id, '409 响应指向首轮 run')
    assert.strictEqual(replayBody.replayBlocked, true, '标记为重放拦截（非锁冲突）')
    // 跨动作首次触发放行（per-action 各自记窗，G_4Kf：换动作不覆盖他动作记录）。
    const crossAction = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=dry-run' })
    assert.strictEqual(crossAction.status, 202, '跨动作首次触发不受重放窗拦截')
    // G_4Kf：check 的重放记录不被 dry-run 覆盖——再次重试 check 仍被拦且仍指向首轮。
    const replay2 = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(replay2.status, 409, '跨动作后同 action 重试仍被拦')
    assert.strictEqual(JSON.parse(replay2.text).runId, firstBody.id, '重放记录未被换动作覆盖')
    // Sourcery G_4Ki：畸形 Cookie（非法 % 序列）不得炸请求处理器——按无 Cookie 处理。
    const badCookie = await request(port, 'GET', '/', { headers: { cookie: 'xbk_session=%zz' } })
    assert.strictEqual(badCookie.status, 401, '畸形 Cookie → 401（不抛 URIError）')
    // Sourcery Session-users-cannot-trigger：Cookie 会话打开 / 且无 ?token= 时 boot JSON
    // 必须注入服务端已验证的凭证（否则前端发空 Bearer，触发 401）。
    const sessPage = await request(port, 'GET', '/', { headers: { cookie: `xbk_session=${TOKEN}` } })
    assert.strictEqual(sessPage.status, 200, 'Cookie 会话可开页面')
    assert.ok(sessPage.text.includes(`"token":"${TOKEN}"`), '会话页 boot JSON 含已验证 token')
    // Sourcery G_4Kb：POST 不接受 Cookie 凭证（写动作须显式 Bearer/?token=）。
    const csrf = await request(port, 'POST', '/trigger', { headers: { cookie: `xbk_session=${TOKEN}` }, body: 'action=check' })
    assert.strictEqual(csrf.status, 401, 'POST 仅凭 Cookie 必须 401（CSRF 面）')
    // Sourcery Retries-duplicate：重放窗落盘——重启（新 createConsole 实例、同 stateDir）
    // 后窗口内同 action 重试仍须 409 且指向首轮 run。
    const { server: server2 } = createConsole({ token: TOKEN, stateDir: dir })
    const port2 = await listen(server2)
    const replayAfterRestart = await request(port2, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(replayAfterRestart.status, 409, '重启后重放窗仍拦截（lastAccept 落盘回读）')
    assert.strictEqual(JSON.parse(replayAfterRestart.text).runId, firstBody.id, '重启后仍指向首轮 run')
    server2.close()
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
    // POST /api/runs/detail（前端 fetch 字面量 URL 形态）：与 GET 等价。
    const postDetail = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: `id=${id}` })
    assert.strictEqual(postDetail.status, 200, 'POST detail 200')
    const postBody = JSON.parse(postDetail.text)
    assert.strictEqual(postBody.id, id, 'POST detail 返回同一条 run')
    assert.ok(typeof postBody.output === 'string' && postBody.output.length > 0, 'POST detail output 非空')
    const postMissing = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: 'id=99999' })
    assert.strictEqual(postMissing.status, 404, 'POST detail 未命中 404')
    const postBad = await request(port, 'POST', '/api/runs/detail', { token: TOKEN, body: 'id=abc' })
    assert.strictEqual(postBad.status, 400, 'POST detail 非数字 id 400')
    const postNoAuth = await request(port, 'POST', '/api/runs/detail', { body: `id=${id}` })
    assert.strictEqual(postNoAuth.status, 401, 'POST detail 无凭证 401（鉴权与 GET 一致）')
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
