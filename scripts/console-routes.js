'use strict'
// 控制台有序路由表（D1）：`dispatchRequest` 只保留 ingress —— 访问日志、畸形 request-target 防御、
// 静态资产、`POST /login`、2FA 页面闸、过滤规则写端点、`STATE_CHANGING_PATHS` 的 Bearer-only 复判、
// 全局鉴权与 SPA 壳。这些是安全边界，顺序与状态码都不许动；**全局鉴权之后**的 endpoint 全部由
// 本表接管。
//
// 约定（改表前必读）：
//   · 表项 = ['METHOD', 路径或正则, handler 名]；`path` 精确匹配，`pattern` 正则（handler 多收一个 match）。
//   · **顺序即命中顺序**，等于原 dispatchRequest 里 if 链的顺序；重排等于改行为，别为了「好看」动它。
//   · handler 一律 `(req, res, url, match)`，依赖经 `createConsoleRoutes(ctx)` 的 ctx 显式注入
//     （不 require scripts/console.js，避免循环依赖）。
//   · 建表时做重复/冲突检测：同 method + 同 path/pattern 直接抛错，避免后一项静默遮蔽前一项。
const { createSystemHandlers } = require('./console-handlers/system')
const { createLogsHandlers } = require('./console-handlers/logs')
const { createMessagesHandlers } = require('./console-handlers/messages')
const { createConfigHandlers } = require('./console-handlers/config')
const { createSecurityHandlers } = require('./console-handlers/security')
const { createRunsHandlers } = require('./console-handlers/runs')

// 运行时 id 形态：epoch(13+ 位) + '.' + seq（与原 dispatchRequest 末尾那条正则逐字一致）。
const RUN_DETAIL_PATH = /^\/api\/runs\/(\d{13,}\.\d{1,10})$/

// 有序路由清单。新增 endpoint 追加在末尾（原 if 链也是追加式演进），并把 handler 放进对应域文件。
const ROUTE_TABLE = [
  ['GET', '/api/status', 'getStatus'],
  ['GET', '/api/access-log', 'getAccessLog'],
  ['GET', '/api/messages', 'getMessages'],
  ['GET', '/api/line-search', 'getLineSearch'],
  ['GET', '/api/line-watch', 'getLineWatch'],
  ['POST', '/api/line-watch', 'postLineWatch'],
  ['POST', '/api/backup/export', 'postBackupExport'],
  ['POST', '/api/backup/import', 'postBackupImport'],
  ['POST', '/api/messages/export', 'postMessagesExport'],
  ['GET', '/api/trends', 'getTrends'],
  ['GET', '/api/run-history', 'getRunHistory'],
  ['GET', '/api/logs', 'getLogs'],
  ['GET', '/api/cache-health', 'getCacheHealth'],
  ['GET', '/api/files', 'getFiles'],
  ['GET', '/api/config', 'getConfig'],
  ['GET', '/api/config/filter', 'getFilter'],
  ['GET', '/api/config/filter/draft', 'getFilterDraft'],
  ['GET', '/api/sys', 'getSys'],
  ['GET', '/api/2fa/status', 'getTwoFactorStatus'],
  ['POST', '/api/devices/revoke', 'postDevicesRevoke'],
  ['POST', '/api/2fa/setup', 'postTwoFactorSetup'],
  ['POST', '/api/2fa/enable', 'postTwoFactorEnable'],
  ['POST', '/api/2fa/disable', 'postTwoFactorDisable'],
  ['GET', '/api/auto', 'getAuto'],
  ['POST', '/api/auto', 'postAuto'],
  ['GET', '/api/config/console', 'getConsoleSettings'],
  ['POST', '/api/config/console', 'postConsoleSettings'],
  ['POST', '/trigger', 'postTrigger'],
  ['POST', '/api/notify-test', 'postNotifyTest'],
  ['GET', '/api/runs', 'getRuns'],
  ['GET', '/api/stream', 'getStream'],
  ['GET', '/api/runs/stream', 'getRunsStream'],
  ['POST', '/api/runs/detail', 'postRunsDetail'],
  ['POST', '/api/runs/cancel', 'postRunsCancel'],
  ['GET', RUN_DETAIL_PATH, 'runById']
]

function routeKey (method, matcher) {
  return `${method} ${typeof matcher === 'string' ? matcher : matcher.source}`
}

// 纯校验（导出给 test_console_routes.js 直接喂反例）：method / 匹配器 / handler 名必须合法且不重复。
function validateRouteTable (table) {
  const seen = new Set()
  for (const entry of table) {
    if (!Array.isArray(entry) || entry.length !== 3) throw new Error('路由表条目必须是 [method, path|pattern, handler] 三元组')
    const [method, matcher, handler] = entry
    if (typeof method !== 'string' || method === '') throw new Error(`路由表条目缺 method（${JSON.stringify(entry)}）`)
    if (typeof matcher !== 'string' && !(matcher instanceof RegExp)) {
      throw new Error(`路由表条目 ${method} 的 path/pattern 必须是字符串或正则`)
    }
    if (typeof handler !== 'string' || handler === '') throw new Error(`路由表条目 ${routeKey(method, matcher)} 缺 handler 名`)
    const key = routeKey(method, matcher)
    if (seen.has(key)) throw new Error(`路由表重复：${key}（同 method + 同 path 会静默遮蔽后一项，必须显式改名）`)
    seen.add(key)
  }
  return table
}

// handler 名跨域必须唯一：合并成一张表时同名会被静默覆盖（后建的域赢），现象是「某端点走了别的域」。
function buildHandlers (ctx) {
  const groups = [
    createSystemHandlers(ctx),
    createLogsHandlers(ctx),
    createMessagesHandlers(ctx),
    createConfigHandlers(ctx),
    createSecurityHandlers(ctx),
    createRunsHandlers(ctx)
  ]
  const handlers = {}
  for (const group of groups) {
    for (const [name, fn] of Object.entries(group || {})) {
      if (Object.prototype.hasOwnProperty.call(handlers, name)) {
        throw new Error(`handler 名重复：${name}（跨域同名会静默覆盖，先改名）`)
      }
      if (typeof fn !== 'function') throw new Error(`handler ${name} 不是函数`)
      handlers[name] = fn
    }
  }
  return handlers
}

// 工厂：返回**有序数组** [{ method, path|pattern, handler }]，供 dispatchRequest 逐项匹配。
function createConsoleRoutes (ctx) {
  const handlers = buildHandlers(ctx)
  validateRouteTable(ROUTE_TABLE)
  return ROUTE_TABLE.map(([method, matcher, name]) => {
    const handler = handlers[name]
    if (!handler) throw new Error(`路由表引用了不存在的 handler：${name}（${routeKey(method, matcher)}）`)
    return typeof matcher === 'string'
      ? { method, path: matcher, handler }
      : { method, pattern: matcher, handler }
  })
}

// 有序查找：method 先比，命中精确 path 或正则即返回；未命中返回 null（由 dispatchRequest 回 404）。
function matchRoute (routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue
    if (route.path !== undefined) {
      if (route.path === pathname) return { handler: route.handler, match: null }
      continue
    }
    const match = route.pattern.exec(pathname)
    if (match) return { handler: route.handler, match }
  }
  return null
}

module.exports = {
  createConsoleRoutes,
  matchRoute,
  validateRouteTable,
  ROUTE_TABLE,
  RUN_DETAIL_PATH
}
