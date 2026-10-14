// scripts/console-assets/index.js —— 控制台前端资产元数据。
//
// 设计约束：
// · 零 npm 依赖（运行时文件入库，不用 CDN，离线可开）；
// · 唯一第三方文件 htm-preact.module.js（preact 10.24.3 + hooks + htm 3.1.1
//   standalone 内联版，13KB，无外部 import）来自 npmmirror 文件直链；
// · /assets/* 由 console.js 仅从 console-assets 目录白名单精确映射（鉴权：无有效
//   凭证一律 401——页面通过鉴权后下发 HttpOnly 会话 Cookie，浏览器对同源 ESM
//   import/静态请求自动携带；此前「免 token」的口径已废弃），路径穿越不可能；
// · 页面本体（app.js）也是纯静态 ESM，无构建步骤，node 直接伺服。
//
// CSP：connect-src 'self'（轮询只打本源 API）；script-src 'self'（无内联脚本，
// token 经 JSON 岛传给 ESM）；style-src 'unsafe-inline'（noscript 降级块的内联样式）。

module.exports = {
  // 供 test_console.js 校验文件存在与字节数下限（防止入库被清空）。
  assets: {
    'htm-preact.module.js': { minBytes: 10000 }
  },
  // 前端轮询间隔（毫秒）——也写死在 app.js，此处仅供测试断言一致性。
  POLL_MS: 5000
}
