'use strict'
/* 加载失败兜底（v3.364）
 *
 * 为什么需要它：前端是浏览器原生 ES module，入口 app.js 静态 import 若干分片。任何一片
 * 404 / 401 / 解析失败，整个模块图 instantiate 失败 → 入口一行都不会执行 → #app 一直是空的，
 * 而 <noscript> 不会渲染（JS 是开着的），用户只看到白屏，连「刷新一下」都不知道。
 *
 * 约束：CSP 是 script-src 'self'，禁止内联脚本，所以这段必须是独立的外链文件；
 * 它本身不能 import 任何东西（否则又会成为新的加载失败点）。
 */
;(function () {
  const TIMEOUT_MS = 5000
  let shown = false

  function booted () {
    return window.__XBK_BOOTED === true
  }

  function show (why) {
    if (shown || booted()) return
    shown = true
    const host = document.getElementById('app')
    if (!host) return
    const box = document.createElement('div')
    box.className = 'boot-fail'
    box.setAttribute('role', 'alert')

    const title = document.createElement('p')
    title.className = 'boot-fail-title'
    title.textContent = '页面没加载出来'

    const hint = document.createElement('p')
    hint.className = 'boot-fail-hint'
    hint.textContent = '多半是网络断了一下，或者刚更新过页面。刷新一下（下拉刷新，或重新点开链接）通常就好。'

    const code = document.createElement('p')
    code.className = 'boot-fail-code'
    code.textContent = '错误码：' + why

    box.appendChild(title)
    box.appendChild(hint)
    box.appendChild(code)
    host.textContent = ''
    host.appendChild(box)
  }

  // 资源加载失败（script/link）在 window 上以 capture 阶段冒泡，target 是元素本身。
  window.addEventListener('error', function (event) {
    const el = event && event.target
    if (el && (el.tagName === 'SCRIPT' || el.tagName === 'LINK')) show('asset')
  }, true)

  // 模块求值期间抛错：error 事件已经经过，这里兜住 promise 形态（动态 import / 顶层 await）。
  window.addEventListener('unhandledrejection', function () {
    if (!booted()) show('promise')
  })

  // 最后一道：脚本请求挂住（弱网、代理吞包）时，5 秒后给用户一句人话。
  window.setTimeout(function () { show('timeout') }, TIMEOUT_MS)

  // 供测试与排障读取，不参与业务。
  window.__XBK_BOOT_GUARD_TIMEOUT_MS = TIMEOUT_MS
})()
