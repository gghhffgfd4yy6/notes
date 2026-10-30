// scripts/console-assets/app.js —— 控制台入口（preact + htm standalone，无构建步骤）。
// v3.367 起视图层在 ui.js：本文件只做三件事——挂载 App、BFCache 恢复、清理服务端失败兜底。
// vendor 锚点（v3.296 补）：./htm-preact.module.js = preact 10.24.3 + hooks + htm 3.1.1
// standalone 内联版（npmmirror 文件直链入库，sha256 =
// 2aeaa3232ca84a7ad7ac0bef39bad3223dbd2173bee6ce4554b77be2f7f271b3）。重取/升级必须核对该值；
// CVE-2026-22028 影响 preact ≥10.26.5，升级越过该版本前先确认修复态。
import { html, render } from './htm-preact.module.js'
// v3.385：App 外面套一层渲染错误边界（ui.js 的 ErrorBoundary，class 组件 + componentDidCatch）。
// 边界必须挂在入口这一层：挂在 App 内部就只能兜子面板，App 自己抛错仍整页白屏。
import { App, ErrorBoundary } from './ui.js'
// 入口 import 面（C7-054：deferred，未解决——勿当成死 import 清掉）：这五个名字在本文件里注定不被引用，
// 但 test_console 的两条既有断言读的就是本文件的 import 声明本身（钉「入口确实接上了自家模块」，不是它们的用处）：
//   · test_console.js:2654「备份在浏览器加密」结构红线：对拼接源码跑正则，要求 pure.mjs 的具名导入里
//     encryptBackup、decryptBackup、isEncryptedBackup 三者按这个顺序出现（中间不夹 `}`）；
//   · test_console.js:3751「基础导入必须存在（防止整条 import 被删）」：acorn 解析后断言 imported 集合
//     同时含 fmtTime 与 POLL_MS。
// 删掉任何一行 import，这两条既有断言立刻变红；而清理这一条不允许改测试，所以它仍是未解决项（deferred），
// 不是「换个豁免就修好了」。真要做完，得把这两条判据挪到测试侧或换判据，属另一条目。
// 同名绑定在 pages.js / ui.js 里使用；ESM 同一模块实例，重复 import 不产生额外请求或副作用。
/* eslint-disable no-unused-vars -- 入口 import 面是 test_console 锁死的契约面，绑定在 pages.js/ui.js 使用 */
import { encryptBackup, decryptBackup, isEncryptedBackup } from './pure.mjs'
import { fmtTime } from './format.js'
import { POLL_MS } from './constants.js'
/* eslint-enable no-unused-vars */

// BFCache 恢复（评审 #233 · Sourcery Medium）：浏览器从往返缓存恢复页面时会跳过 `/` 请求，
// BOOT.token 可能已随服务重启/轮换而过期——GET 靠 Cookie 仍正常，但写动作会 401。
// persisted=true 即非首次加载，强制重载拿当前凭证（no-store 不保证 BFCache 驱逐）。
window.addEventListener('pageshow', (ev) => { if (ev.persisted) window.location.reload() })

render(html`<${ErrorBoundary}><${App} /><//>`, document.getElementById('app'))
// v3.364：挂载成功就移除服务端渲染的失败兜底（CSS 让它 5s 后才显形，正常路径永远看不到）。
const bootFallback = document.querySelector('#app .boot-fallback')
if (bootFallback) bootFallback.remove()
