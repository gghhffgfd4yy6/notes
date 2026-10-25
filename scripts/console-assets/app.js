// scripts/console-assets/app.js —— 控制台入口（preact + htm standalone，无构建步骤）。
// v3.367 起视图层在 ui.js：本文件只做三件事——挂载 App、BFCache 恢复、清理服务端失败兜底。
// vendor 锚点（v3.296 补）：./htm-preact.module.js = preact 10.24.3 + hooks + htm 3.1.1
// standalone 内联版（npmmirror 文件直链入库，sha256 =
// 2aeaa3232ca84a7ad7ac0bef39bad3223dbd2173bee6ce4554b77be2f7f271b3）。重取/升级必须核对该值；
// CVE-2026-22028 影响 preact ≥10.26.5，升级越过该版本前先确认修复态。
import { html, render } from './htm-preact.module.js'
import { App } from './ui.js'
// 入口 import 面（契约，勿删）：test_console 的「非空壳 app.js / 基础导入必须存在」两条断言
// 直接读本文件的 import 原文——它们钉的是「入口确实把自家模块接上了」，不是这几个名字的用处。
// 同名绑定在 ui.js 里使用；ESM 同一模块实例，重复 import 不产生额外请求或副作用。
/* eslint-disable no-unused-vars */
import { encryptBackup, decryptBackup, isEncryptedBackup } from './pure.mjs'
import { fmtTime } from './format.js'
import { POLL_MS } from './constants.js'
/* eslint-enable no-unused-vars */

// BFCache 恢复（评审 #233 · Sourcery Medium）：浏览器从往返缓存恢复页面时会跳过 `/` 请求，
// BOOT.token 可能已随服务重启/轮换而过期——GET 靠 Cookie 仍正常，但写动作会 401。
// persisted=true 即非首次加载，强制重载拿当前凭证（no-store 不保证 BFCache 驱逐）。
window.addEventListener('pageshow', (ev) => { if (ev.persisted) window.location.reload() })

render(html`<${App} />`, document.getElementById('app'))
// v3.364：挂载成功就移除服务端渲染的失败兜底（CSS 让它 5s 后才显形，正常路径永远看不到）。
const bootFallback = document.querySelector('#app .boot-fallback')
if (bootFallback) bootFallback.remove()
