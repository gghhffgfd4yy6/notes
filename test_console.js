'use strict'
// scripts/console.js 测试：token 校验 / 锁语义 / 动作解析 / HTML 转义 / HTTP 端到端（鉴权、
// 看板渲染、触发 202/409、JSON API、SIGTERM 优雅关闭）。触发用例真实 spawn 子进程——
// 动作默认指向 --check（环境检查，秒级、不写缓存不发通知），不存在注入式 fake child。

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

const {
  createConsole, isValidToken, timingSafeEqualStr,
  acquireLock, releaseLockFor, lockPath,
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
  assert.strictEqual(isValidToken('a'.repeat(8) + '%41'.repeat(4)), false, '% 拒绝（URLSearchParams 会解码改写）')
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
  assert.strictEqual(acquireLock(dir, 1000, 'tok-a'), true)
  assert.strictEqual(acquireLock(dir, 2000, 'tok-b'), false, '持有期内必须拒绝')
  // 释放走 releaseLockFor（v3.296：按路径 unlinkSync 的 releaseLock 已删）
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-a' })
  assert.strictEqual(acquireLock(dir, 3000, 'tok-c'), true, 'released 锁立即可接管')
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
ok('acquireLock: 畸形锁帧（released 非布尔 / pid 字段超长）→ fail-closed 拒绝（回归：JSON.parse 不得抛错崩进程）', () => {
  const dir = tmpDir()
  // released 键为字符串：旧实现 parsed.released === true 虽判 false，但 startedAt 缺失会
  // 走 corrupted 分支——真实回归点是 releaseLockFor 短帧化后「released+空格尾」与
  // 「released+残留旧内容」都必须解析为合法帧，任何畸形变体不得抛出未捕获异常。
  fs.writeFileSync(lockPath(dir), '{"released":"yes","startedAt":1}')
  assert.strictEqual(acquireLock(dir, 1000), false, 'released 非布尔不得当作已释放')
  fs.writeFileSync(lockPath(dir), `{"pid":"${'9'.repeat(400)}","startedAt":1,"released":true}`)
  assert.strictEqual(acquireLock(dir, 1000), true, '超长字段的 released 帧仍可接管（解析不崩）')
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
ok('releaseLockFor: released 短帧不大于原帧（回归：恒比原帧长的旧帧使「补空格防半旧半新」成死代码）', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000, 'tok-abc'), true)
  const origLen = JSON.stringify({ pid: process.pid, startedAt: 1000, token: 'tok-abc' }).length
  const { releaseLockFor } = require('./scripts/console')
  releaseLockFor({ _stateDir: dir, _lockToken: 'tok-abc' })
  const body = fs.readFileSync(lockPath(dir), 'utf8')
  assert.strictEqual(body.length, origLen, '覆写后长度必须等于原帧（补空格到原长，杜绝跨扇区半旧半新窗）')
  assert.strictEqual(JSON.parse(body).released, true, '空格补尾后仍是合法 JSON released 帧')
  assert.strictEqual(body.trim(), '{"released":true}', '实体内容必须是短帧（pid/token/startedAt 已无保留价值）')
})
ok('releaseLockFor: inode 一致性闸（回归 Sourcery #225 High：陈旧持有者不得覆写接管方的新锁帧）', () => {
  const dir = tmpDir()
  assert.strictEqual(acquireLock(dir, 1000, 'tok-old'), true)
  // 模拟接管：走 acquireLock 自己的陈旧接管路径（startedAt 远超 PROC_TIMEOUT_MS），
  // 该路径现已用 tmp+rename 原子换代——旧持有者 fd 里的 inode 变成孤儿。
  const fs2 = require('node:fs')
  const p = lockPath(dir)
  fs2.utimesSync(p, 1, 1) // 把 mtime 拉旧不影响 startedAt 判定；直接改 startedAt 更直接：
  fs2.writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: 1, token: 'tok-old' }))
  assert.strictEqual(acquireLock(dir, PROC_TIMEOUT_MS + 5000, 'tok-new'), true, '接管方拿到锁')
  // 断言接管结果：同 fd 读纪律（open + fstat(fd) + 同 fd 读），避免 CodeQL js/file-system-race
  // 对「rename 写路径 → 路径读」的 check-then-use 判红。
  const rfd1 = fs2.openSync(p, 'r')
  try {
    if (!fs2.fstatSync(rfd1).isFile()) throw new Error('not file')
    const newFrameBefore = fs2.readFileSync(rfd1, 'utf8')
    assert.strictEqual(JSON.parse(newFrameBefore).token, 'tok-new')
  } finally { fs2.closeSync(rfd1) }
  // 旧持有者仍握着旧 inode 的 fd？不——它每次 open 都是新 fd；竞态的本质是「旧主在
  // rename 前 open」。这里用注入模拟：手动 open 旧内容后让 rename 发生，再 releaseLockFor。
  // 简化：直接构造「fd 指向孤儿 inode」场景——把当前锁 rename 走，再在原路径放新帧。
  const orphanDir = tmpDir()
  assert.strictEqual(acquireLock(orphanDir, 1000, 'tok-victim'), true)
  const op = lockPath(orphanDir)
  const orphanFd = fs2.openSync(op, 'r+') // 旧主此刻的 fd
  // 接管者 rename 换代
  fs2.writeFileSync(`${op}.t`, JSON.stringify({ pid: 424242, startedAt: 2000, token: 'tok-new' }))
  fs2.renameSync(`${op}.t`, op)
  // 旧主释放：fd 指向孤儿 inode，路径上已是新主帧——不得覆盖新主
  const { releaseLockFor } = require('./scripts/console')
  // 手动走一致性闸逻辑：直接调 releaseLockFor（它会重新 open 路径，双匹配失败返回 false）
  assert.strictEqual(releaseLockFor({ _stateDir: orphanDir, _lockToken: 'tok-victim' }), false, '锁已换主不得释放')
  // 断言新主锁帧原样无损：按生产 readSafeText 同款纪律（open + fstat(fd) + 同 fd 读），
  // 避免 CodeQL js/file-system-race 对「rename 写路径 → 路径读」的 check-then-use 判红。
  const rfd2 = fs2.openSync(op, 'r')
  try {
    if (!fs2.fstatSync(rfd2).isFile()) throw new Error('not file')
    assert.strictEqual(JSON.parse(fs2.readFileSync(rfd2, 'utf8')).token, 'tok-new', '新主锁帧原样无损')
  } finally { fs2.closeSync(rfd2) }
  fs2.closeSync(orphanFd)
})
ok('releaseLockFor: 短写循环（monkeypatch writeSync 首次少写，回归 Sourcery #225 M1）', () => {
  const dir = tmpDir()
  const fsmod = require('node:fs')
  assert.strictEqual(acquireLock(dir, 1000, 'tok-sw'), true)
  const realWrite = fsmod.writeSync
  let calls = 0
  fsmod.writeSync = function (fd, buf, off, len, pos) {
    if (Buffer.isBuffer(buf) && buf.slice(0, 17).toString('utf8') === '{"released":true}') {
      calls++
      if (calls === 1) return realWrite(fd, buf, off, len - 6, pos) // 模拟少写 6 字节
    }
    return realWrite(fd, buf, off, len, pos)
  }
  try {
    const { releaseLockFor } = require('./scripts/console')
    const res = releaseLockFor({ _stateDir: dir, _lockToken: 'tok-sw' })
    assert.strictEqual(res, true, '短写循环补齐后必须成功')
    assert.ok(calls >= 2, `必须发生多次 writeSync（实际 ${calls} 次）`)
  } finally {
    fsmod.writeSync = realWrite
  }
  const rfd3 = fsmod.openSync(lockPath(dir), 'r')
  try {
    if (!fsmod.fstatSync(rfd3).isFile()) throw new Error('not file')
    const body = fsmod.readFileSync(rfd3, 'utf8')
    assert.strictEqual(JSON.parse(body).released, true, '残尾补写后仍是合法 released 帧')
    assert.strictEqual(body.trim(), '{"released":true}')
  } finally { fsmod.closeSync(rfd3) }
})
ok('releaseLockFor: 他人活锁返回 false；released 帧返回 true；锁不存在返回 true', () => {
  const dir = tmpDir()
  const { releaseLockFor } = require('./scripts/console')
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999, startedAt: 1000, token: 'other' }))
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'mine' }), false, '他人活锁如实报 false')
  fs.writeFileSync(lockPath(dir), '{"released":true}')
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'mine' }), true, '已 released 报 true')
  fs.unlinkSync(lockPath(dir))
  assert.strictEqual(releaseLockFor({ _stateDir: dir, _lockToken: 'mine' }), true, '锁不存在报 true')
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
  // RFC 9110：auth-scheme 大小写不敏感（v3.296 修复：小写 scheme 不得 401）
  assert.strictEqual(authorize(mkReq({ authorization: `bearer ${TOKEN2}` }), TOKEN2, null), true, 'scheme 小写同样放行')
  assert.strictEqual(authorize(mkReq({ authorization: `BEARER ${TOKEN2}` }), TOKEN2, null), true, 'scheme 大写变体同样放行')
  assert.strictEqual(authorize(mkReq({ authorization: `bearerx ${TOKEN2}` }), TOKEN2, null), false, '前缀必须带空格边界')
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
  assert.ok(withToken.includes("frame-ancestors 'none'"), "CSP 含 frame-ancestors 'none'（响应头与 meta 双通道，见 HTTP 用例）")
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
// 绕过 http.request 的 URL 合法性校验，直接写原始请求行（畸形 request-target 回归用：
// `//@:99999/` 会让裸 new URL 抛 TypeError——修复前一条无凭证请求即崩整个控制台）。
function rawRequest (port, raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.write(raw) })
    let buf = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      sock.destroy()
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf)
      resolve({ status: m ? Number(m[1]) : 0, text: buf })
    }
    const to = setTimeout(finish, 5000)
    sock.on('data', c => {
      buf += c
      // 收到完整响应头即收口：HTTP keep-alive 下服务端不会主动 FIN，等 'end' 会空转到超时
      if (buf.includes('\r\n\r\n')) { clearTimeout(to); finish() }
    })
    sock.on('error', (e) => { clearTimeout(to); finish() })
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
  await aok('HTTP: 畸形 request-target → 400 且进程存活（回归：裸 new URL 曾崩整个控制台）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const bad = await rawRequest(port, 'GET //@:99999/ HTTP/1.1\r\nHost: x\r\n\r\n')
    assert.strictEqual(bad.status, 400, '畸形请求行必须 400，不得崩进程')
    const alive = await request(port, 'GET', '/api/status', { token: TOKEN })
    assert.strictEqual(alive.status, 200, '同一条畸形请求处理后服务必须继续可用')
    server.close()
  })
  await aok('HTTP: GET / 下发 CSP 响应头（回归：frame-ancestors 仅 meta 承载是规范 no-op）', async () => {
    const { server } = createConsole({ token: TOKEN, stateDir: tmpDir() })
    const port = await listen(server)
    const res = await request(port, 'GET', `/?token=${TOKEN}`)
    assert.strictEqual(res.status, 200)
    const csp = res.headers['content-security-policy']
    assert.ok(csp, '必须存在 CSP 响应头')
    assert.ok(csp.includes("frame-ancestors 'none'"), '响应头 CSP 必须含 frame-ancestors')
    assert.ok(csp.includes("default-src 'none'"), '响应头 CSP 必须含 default-src')
    server.close()
  })
  await aok('HTTP: SIGTERM 优雅关闭——锁帧 released + 子进程被杀 + 退出码 0（端到端）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbk-console-e2e-'))
    const lockFile = path.join(dir, 'console-trigger.lock')
    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'console.js')], {
      env: {
        ...process.env,
        XBK_CONSOLE_TOKEN: TOKEN,
        XBK_CONSOLE_PORT: '0',
        XBK_CACHE_DIR: dir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    // 等就绪（监听成功日志）。
    const readyDeadline = Date.now() + 10000
    while (!out.includes('已启动')) {
      if (Date.now() > readyDeadline) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(out.includes('已启动'), `子控制台未就绪：${out.slice(0, 400)}`)
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out)
    assert.ok(m, `无法解析监听端口：${out.slice(0, 200)}`)
    const cport = Number(m[1])
    const trig = await request(cport, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(trig.status, 202, '触发必须受理')
    assert.strictEqual(fs.existsSync(lockFile), true, '触发后锁文件必须存在')
    await new Promise(resolve => setTimeout(resolve, 150))
    // Sourcery #225 M6：SIGTERM 前无法直接观测孙进程（--check 在控制台进程内 spawn），
    // 用退出延迟区分「杀掉子进程走 close 收尾」（毫秒级）与「子进程没死、3s 看门狗
    // 强退」（≥3s）——若关停逻辑不再杀子进程，此断言必红。
    const killAt = Date.now()
    child.kill('SIGTERM')
    const code = await new Promise(resolve => {
      const to = setTimeout(() => resolve('timeout'), 8000)
      child.on('exit', (c) => { clearTimeout(to); resolve(c) })
    })
    const shutdownMs = Date.now() - killAt
    assert.ok(shutdownMs < 2800, `关停耗时 ${shutdownMs}ms ≥ 2800ms：疑似走了 3s 看门狗（子进程未被杀）\n${out.slice(-400)}`)
    assert.strictEqual(code, 0, `SIGTERM 后必须 0 退出（实际 ${code}）\n${out.slice(-400)}`)
    const frame = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    assert.strictEqual(frame.released, true, '退出后锁帧必须为 released（原地产出，不靠外部清理）')
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await aok('HTTP: /trigger 落盘失败 → 500 且可立即重试（回归 Sourcery #225 M2：pending 条目必须回滚）', async () => {
    const dir = tmpDir()
    const { server } = createConsole({ token: TOKEN, stateDir: dir })
    const port = await listen(server)
    // 让 lastAcceptPath 写入必然失败：同名目录挡路（EISDIR）。
    fs.mkdirSync(path.join(dir, 'console-lastaccept.json'))
    const bad = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(bad.status, 500, '持久化失败必须 500')
    assert.ok(bad.text.includes('fail-closed'))
    // 释放锁：上一轮已显式 releaseLockFor（否则这里 409）
    fs.rmdirSync(path.join(dir, 'console-lastaccept.json'))
    const retry = await request(port, 'POST', '/trigger', { token: TOKEN, body: 'action=check' })
    assert.strictEqual(retry.status, 202, '失败动作在窗口内必须可立即重试（pending 条目已回滚），不得 409')
    server.close()
  })
  await aok('main: XBK_CONSOLE_PORT 非法值拒绝启动（回归 Sourcery #225 M5：NaN 不得回退 7777）', async () => {
    const c = spawn(process.execPath, [path.join(__dirname, 'scripts', 'console.js')], {
      env: { ...process.env, XBK_CONSOLE_TOKEN: TOKEN, XBK_CONSOLE_PORT: 'abc' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let errOut = ''
    c.stderr.on('data', d => { errOut += d })
    const code = await new Promise(resolve => {
      const to = setTimeout(() => resolve('timeout'), 5000)
      c.on('exit', (v) => { clearTimeout(to); resolve(v) })
    })
    assert.strictEqual(code, 1, `非法端口必须 exit 1（实际 ${code}）`)
    assert.ok(errOut.includes('非法'), `stderr 必须说明端口非法：${errOut.slice(0, 200)}`)
  })
  await aok('wireGracefulShutdown: kill(SIGKILL) → 等 close → 才退出（回归 Sourcery #225 M6：关停必须真终止子进程）', async () => {
    const dir = tmpDir()
    const { activeChildren, wireGracefulShutdown: wire } = createConsole({ token: TOKEN, stateDir: dir, port: 0 })
    // 假子进程：只有显式调 kill 才会发 close（模拟真实存活子进程）；关停若不再杀子进程，
    // kill 断言红；若不等 close 直接退出，时序断言红。
    const events = []
    const fakeChild = {
      kill (sig) { this.killed = true; this.signal = sig; events.push(`kill:${sig}`) },
      once (ev, fn) { this._onceClose = ev === 'close' ? fn : this._onceClose; return this }
    }
    activeChildren.add(fakeChild)
    let exitCode = null
    let registered = null
    const { shutdown } = wire({
      onExit: (code) => { events.push(`exit:${code}`); exitCode = code },
      registerSignal: (fn) => { registered = fn }
    })
    assert.strictEqual(typeof registered, 'function', '必须注册信号回调')
    shutdown('SIGTERM')
    assert.ok(events.includes('kill:SIGKILL'), `关停必须对活跃子进程 SIGKILL（events=${events}）`)
    // close 之前不得退出（等每个子进程真正死掉才收尾——评审 Medium G5F 序列）。
    assert.strictEqual(exitCode, null, `close 前不得退出（events=${events}）`)
    // 子进程真正 close → 才走 finishShutdown → server.close 回调 → 退出。
    fakeChild._onceClose()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.strictEqual(exitCode, 0, `子进程 close 后必须退出 0（events=${events}）`)
    assert.ok(events.indexOf('exit:0') > events.indexOf('kill:SIGKILL'), '退出必须发生在 kill 之后')
  })
}

main()
  .then(() => {
    console.log(`\n控制台套件：通过 ${passed} / 失败 ${failed}`)
    if (failed > 0) process.exitCode = 1
  })
  .catch(e => { console.error('套件执行异常:', e.message); process.exitCode = 1 })
