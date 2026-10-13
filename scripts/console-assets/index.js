// scripts/console-page.js —— 控制台前端资产。
//
// 设计约束：
// · 零 npm 依赖（运行时文件入库，不用 CDN，离线可开）；
// · 唯一第三方文件 htm-preact.module.js（preact 10.24.3 + hooks + htm 3.1.1
//   standalone 内联版，13KB，无外部 import）来自 npmmirror 文件直链，
//   版本写死在本注释与 package.json console.assets 元数据中；
// · /assets/* 由 console.js 仅从 console-assets 目录白名单映射，路径穿越不可能；
// · 页面本体（app.js）也是纯静态 ESM，无构建步骤，node 直接伺服。
//
// CSP：connect-src 'self'（轮询只打本源 API）；script-src 'self'（无内联脚本，
// token 经 window 注入的 JSON 岛传给 ESM）；style-src 'unsafe-inline'（内联样式表）。

module.exports = {
  // 供 test_console.js 校验文件存在与字节数下限（防止入库被清空）。
  assets: {
    'htm-preact.module.js': { minBytes: 10000 }
  },
  // 前端轮询间隔（毫秒）——也写死在 app.js，此处仅供测试断言一致性。
  POLL_MS: 5000
}
