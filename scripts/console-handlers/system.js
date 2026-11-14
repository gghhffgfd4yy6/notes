'use strict'
// 控制台 system 域 HTTP handler（D1：dispatchRequest 拆成「薄 ingress + 有序路由表 + 按域 handler」）。
// 依赖一律经路由表的 ctx 显式注入（ctx 形状见 scripts/console.js 的 buildRouteContext），
// 本文件不 require scripts/console.js（避免循环依赖），也不持有任何模块级可变状态。
const fs = require('node:fs')

function createSystemHandlers (ctx) {
  const { sendJson, sendJsonConditional } = ctx.http
  const { stateDir, messagesFile, lockPath } = ctx.paths
  const { startedAtMs, accessLog, unauthorizedCount } = ctx.state
  const { readStatus, cacheHealthSnapshot, cacheHealthEntryCount, listStateFiles } = ctx.data
  const { PROC_TIMEOUT_MS, CACHE_HEALTH_COUNT_MAX_BYTES, APP_VERSION } = ctx.consts
  return {
    getStatus (req, res, url) {
      // Sourcery Other-instance-idle：runs 历史是进程内存，另一实例持锁时本进程看不到。
      // 锁文件在共享 stateDir——把「锁被持有且未超时」附进 status，前端空闲徽章参考。
      const st = readStatus(stateDir)
      try {
        const lp = lockPath(stateDir)
        // CodeQL js/file-system-race（High）：statSync 后再 readFileSync 存在 TOCTOU——
        // 两次调用之间锁可能被释放/接管，stat 的 mtime 与 read 的内容来自不同代的锁帧。
        // 单次 readFileSync，时间与状态全部取自同一帧内容（锁帧/released 帧都写 startedAt）。
        // 损坏/0 字节锁（D2-S1）不能报成「空闲」：看板显示空闲而按钮一直 409 正是这条
        // finding。按 mtime 判陈旧：陈旧的损坏锁本次触发会被接管（held:false 且
        // state:'corrupted-stale'），新鲜的损坏锁仍在阻止触发（held:true）。
        let lockAge = 0
        let lockBody = null
        let corrupted = false
        // Codacy/Opengrep pathtraversal（本文件三处：下面的 readFileSync(lp)、statSync(lp)、
        // statSync(lp + '.takeover')）：该规则只放行字符串字面量首参，而 lp 必然是变量——它是
        // lockPath(stateDir)，stateDir 由启动方显式传入（默认项目根内的固定状态目录 / XBK_CACHE_DIR
        // 解析结果），锁文件名与哨兵后缀都是本仓字面量，路径里没有任何请求派生片段（请求只决定
        // 「读不读」，不参与拼路径）。故三行各加行内裸 `// nosemgrep`，口径同 xbk_storage.js:17。
        try {
          lockBody = JSON.parse(fs.readFileSync(lp, 'utf8')) // nosemgrep（lp = lockPath(stateDir)：stateDir 为启动方传入的常量目录、锁文件名为本仓字面量，不来自请求）
          // "null"/标量帧（被外部写坏）同样按损坏处理：下面 lockBody.startedAt 会抛，
          // 不能让它冒到外层 catch 把 st.lock 留成 undefined。
          if (!lockBody || typeof lockBody !== 'object') throw new TypeError('lock frame is not an object')
        } catch (e2) {
          if (e2 && e2.code === 'ENOENT') {
            st.lock = { held: false, ageMs: 0, state: 'absent', corrupted: false, takeoverInMs: 0 }
          } else {
            corrupted = true
          }
        }
        // 与 acquireLock 同一分类：缺 startedAt / 非正整数的帧也算损坏（否则看板说
        // 「陈旧可抢」，acquireLock 却对新鲜损坏帧 fail-closed，两处结论相反）。
        if (lockBody && lockBody.released !== true && !(Number.isSafeInteger(lockBody.startedAt) && lockBody.startedAt > 0)) corrupted = true
        if (corrupted) {
          let mtimeAge
          try { mtimeAge = Math.max(0, Date.now() - fs.statSync(lp).mtimeMs) } catch (e2) { mtimeAge = PROC_TIMEOUT_MS } // nosemgrep（lp 同上：lockPath(stateDir) 常量派生，不来自请求；此处只取 mtime）
          const held = mtimeAge <= PROC_TIMEOUT_MS
          st.lock = {
            held,
            ageMs: mtimeAge,
            state: held ? 'corrupted' : 'corrupted-stale',
            corrupted: true,
            takeoverInMs: held ? Math.max(0, PROC_TIMEOUT_MS - mtimeAge) : 0
          }
        } else if (lockBody) {
          const startedAt = typeof lockBody.startedAt === 'number' ? lockBody.startedAt : 0
          const released = lockBody.released === true
          lockAge = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : PROC_TIMEOUT_MS
          const held = !released && lockAge < PROC_TIMEOUT_MS
          st.lock = {
            held,
            ageMs: lockAge,
            state: released ? 'released' : (held ? 'running' : 'stale'),
            corrupted: false,
            takeoverInMs: held ? Math.max(0, PROC_TIMEOUT_MS - lockAge) : 0
          }
        }
        // 残留 .takeover 哨兵（上一次接管者崩溃的产物）：陈旧哨兵会阻塞接管，必须让运维
        // 一眼看到它是「残留」而不是「正在接管」（D2-S5）。
        try {
          const sst = fs.statSync(lp + '.takeover') // nosemgrep（lp 同上 + 本文件字面量哨兵后缀，路径非请求派生）
          const sAge = Math.max(0, Date.now() - sst.mtimeMs)
          st.lock.sentinel = { present: true, ageMs: sAge, stale: sAge > PROC_TIMEOUT_MS }
        } catch (e2) { /* 无哨兵 */ }
      } catch (e) {
        if (!st.lock) st.lock = { held: false, ageMs: 0, state: 'unknown', corrupted: false, takeoverInMs: 0 }
      }
      sendJson(res, 200, st)
    },
    // GET /api/access-log（v3.300 §3.3）：系统页可查的内存环形访问日志。
    // 鉴权与其余读取端点一致（上方 authorize 闸已过）。时间正序 = 数组插入序
    // （push 尾=最新）；slice() 浅拷贝防外部持有内部引用改写（条目对象 push 后
    // 只读不变，浅拷贝足够——蓝图防线 3「数组本身必须干净」）。unauthorizedCount
    // 是进程启动以来全部 401 的独立计数（可大于环形窗内条数，不环形截断）。
    getAccessLog (req, res, url) {
      sendJson(res, 200, { items: accessLog.slice(), unauthorizedCount: unauthorizedCount() })
    },
    // ── v3.298 只读扩展端点：缓存健康 / 文件清单 / 配置视图 ─────────────────────
    // 全部无副作用（不写盘、不 spawn），鉴权与既有读取端点同一全局闸。
    getCacheHealth (req, res, url) {
      const snap = cacheHealthSnapshot(stateDir, messagesFile)
      // 条目数对照（Sourcery Medium「条目上限无预警」/ D2-S11 / D2-S12）：
      // ① count 用 rawTotal（含 _f 条目）——_f 一样占缓存额度，旧口径漏计会让超限预警不响；
      // ② 超过 CACHE_HEALTH_COUNT_MAX_BYTES 不整读（同步 parse 20MB 实测阻塞 232ms），
      //    如实报 null + tooLarge，不编数；阈值内走 readMessages 的解析缓存。
      const cnt = cacheHealthEntryCount(stateDir, messagesFile)
      snap.entryCount = cnt.status === 'ok' ? cnt.count : null
      snap.entryCountStatus = cnt.status
      snap.entryCountFiltered = cnt.status === 'ok' ? cnt.filteredCount : null
      if (cnt.status === 'tooLarge') snap.entryCountHint = `缓存超过 ${Math.round(CACHE_HEALTH_COUNT_MAX_BYTES / (1024 * 1024))}MiB，不在请求路径上整读计数（推送记录页的 grandTotal 仍可查）`
      sendJsonConditional(req, res, snap)
    },
    getFiles (req, res, url) {
      const list = listStateFiles(stateDir, messagesFile)
      sendJson(res, 200, list)
    },
    getSys (req, res, url) {
      // 系统信息：版本四方来源 package.json（与 check-version.js 的唯一真源一致）+
      // 进程/宿主只读信息。不暴露路径之外的任何环境变量（token 等凭证绝不入响应）。
      const version = APP_VERSION
      // v3.331：显式禁缓存。版本对账拿不到「现在的」版本就永远提示不了刷新，
      // 不能被浏览器/代理的启发式缓存喂旧值（Sourcery #294）。
      res.setHeader('Cache-Control', 'no-store')
      let rss = 0
      try { rss = process.memoryUsage().rss } catch (e) { rss = 0 }
      sendJson(res, 200, {
        version,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        pid: process.pid,
        uptimeS: Math.floor(process.uptime()),
        rssBytes: rss,
        cacheDir: stateDir,
        startedAt: startedAtMs
      })
    }
  }
}

module.exports = { createSystemHandlers }
