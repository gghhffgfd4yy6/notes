'use strict'
// 控制台 runs 域 HTTP handler（D1 路由拆分）：触发/自检、运行列表、SSE 流、详情、取消。
// 依赖一律经路由表的 ctx 显式注入；不 require scripts/console.js（避免循环依赖）。
const fs = require('node:fs')
const path = require('node:path')

function createRunsHandlers (ctx) {
  const { sendJson, sendJsonConditional, readBody, logCaught } = ctx.http
  const { runs, streamClients, sseConnections, isShuttingDown } = ctx.state
  const { historyDir } = ctx.paths
  const { parseSseCursor } = ctx.data
  const { acceptAction } = ctx.actions
  const { streamWrite, streamTeardown, startStreamSampler, sseTick, sseTeardown, sseFlushPending } = ctx.runs
  const {
    SSE_STREAM_MAX_CONNECTIONS, SSE_STREAM_HEARTBEAT_MS, SSE_MAX_CONNECTIONS, SSE_TICK_MS,
    CANCEL_GRACE_MS, RUN_ID_RE
  } = ctx.consts
  return {
    postTrigger (req, res, url) {
      acceptAction(req, res, {})
    },
    // 批次④ 4.1：通知自检——一次真实推送动作，语义上是「另一种动作」，复用触发全套防线
    // （鉴权 401 / shuttingDown 503 / 重放窗 60s / 单飞锁），零 body。子进程 =
    // spawn(node, [ENTRY_SINGLE, '--notify-test'])（entry:'single' 映射，见 ACTIONS 行）。
    postNotifyTest (req, res, url) {
      acceptAction(req, res, { fixedAction: 'notify-test' })
    },
    getRuns (req, res, url) {
      const list = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((r) => ({
        id: r.id,
        action: r.action,
        label: r.label,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        cancelled: r.cancelled === true
      }))
      sendJsonConditional(req, res, { runs: list })
    },
    // GET /api/stream（v3.374）：全站数据变化通知流。只发「变了」这一个信号
    // （event: tick + {"at":<ms>}），正文由前端用既有条件请求拉（ETag/304）——一条长连接
    // 不承载数据，重连也就不需要补帧。鉴权零代码：继承上方全局闸（原生 EventSource 带不了
    // 自定义头 → Bearer 不可用；GET 收会话 Cookie，?token= 供 API/测试用，与 runs/stream 同口径）。
    getStream (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭' }); return }
      // 连接数闸：第 21 个立刻 503（不排队、不先建流再断）。
      if (streamClients.size >= SSE_STREAM_MAX_CONNECTIONS) { sendJson(res, 503, { error: 'SSE 连接数已达上限' }); return }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-store 而不是 no-cache：这条流带鉴权语义，浏览器不得把任何一帧存下来复用。
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no', // 禁 nginx 类反向代理按块缓冲（否则 tick 要等代理攒满）
        Connection: 'keep-alive'
      })
      res.flushHeaders()
      const client = { res, closed: false, timer: null }
      // 每连接只挂一个心跳定时器（20s 注释帧）；指纹采样是共享的，连接再多也只读一次盘。
      client.timer = setInterval(() => { streamWrite(client, ': ping\n\n') }, SSE_STREAM_HEARTBEAT_MS)
      if (typeof client.timer.unref === 'function') client.timer.unref()
      streamClients.add(client)
      res.on('close', () => streamTeardown(client))
      res.on('error', () => streamTeardown(client))
      startStreamSampler()
    },
    // GET /api/runs/stream（v3.300 批次③ 3.1）：运行中任务输出的 SSE 实时流。
    // ?id=<epoch.seq>&since=<offset>。鉴权零代码（继承上方全局闸）：原生 EventSource
    // 不能带自定义头 → Bearer 不可用；GET 收会话 Cookie（authorize 内 GET 分支），前端走
    // Cookie；API/测试可用 ?token=（浏览器流同款）。端点与前端统一 id= 键名（蓝图口径）。
    getRunsStream (req, res, url) {
      // 关停闸：与 /trigger/cancel 同哲学——关停窗口不新开长连接（setShuttingDown 已置位，
      // 活跃连接由 shutdown 序列广播 done，见 wireGracefulShutdown）。
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭' }); return }
      const id = url.searchParams.get('id')
      if (typeof id !== 'string' || id.length === 0) { sendJson(res, 400, { error: '缺少 id（epoch.seq 数字形态）' }); return }
      if (!RUN_ID_RE.test(id)) { sendJson(res, 400, { error: 'id 必须是 epoch.seq 数字形态' }); return }
      const record = runs.get(id)
      if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
      // 连接数闸：第 9 个 503（蓝图防线 3；Set 登记 + close 必清理在上方连接管理块）。
      if (sseConnections.size >= SSE_MAX_CONNECTIONS) { sendJson(res, 503, { error: 'SSE 连接数已达上限' }); return }
      // since 钳制（蓝图红线：Number + 整数 + 非负）：非法一律钳 0 → 客户端收整段，自愈。
      // 越界（> outputTotalLength）钳到当前尾部（评审 231-M3）：保留超前游标会让
      // ssePlanChunk 恒 null，后续真实输出被吞到游标追上为止——客户端错过内容。
      // 缺省 = 从当前快照尾部开始（绝对偏移 = outputTotalLength，增量只发新数据）。
      let cursor
      // Last-Event-ID 优先（v3.363）：EventSource 断线重连会自动带上「最后收到的 id」，
      // 服务端据此只补缺口；since 只在首次建连/手工探测时使用。两者共用同一套钳制。
      const lastEventId = req.headers['last-event-id']
      const resumedByHeader = typeof lastEventId === 'string' && lastEventId.length > 0
      if (resumedByHeader) {
        const n = parseSseCursor(lastEventId)
        cursor = n === null ? 0 : Math.min(n, record.outputTotalLength)
      } else if (url.searchParams.has('since')) {
        const n = parseSseCursor(url.searchParams.get('since'))
        cursor = n === null ? 0 : Math.min(n, record.outputTotalLength)
      } else {
        cursor = record.outputTotalLength
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', // 禁 nginx 类反向代理缓冲（蓝图口径）
        Connection: 'keep-alive'
      })
      res.flushHeaders()
      const conn = {
        id,
        res,
        cursor, // 绝对偏移（UTF-16 code units），与 ssePlanChunk 同单位
        // 重连但游标不可用（非法/0）：客户端手里已有旧内容，只能整段替换——否则会追加重复。
        forceReset: resumedByHeader && cursor === 0,
        pending: '', // 背压期间的应用层待发帧串（有序）
        pendingBytes: 0, // 待发积压（UTF-8 字节），超 ssePendingLimit 硬断
        paused: false,
        closed: false,
        lastPingAt: Date.now(),
        timer: null
      }
      sseConnections.add(conn)
      conn.timer = setInterval(() => sseTick(conn), SSE_TICK_MS)
      if (typeof conn.timer.unref === 'function') conn.timer.unref() // 蓝图防线 5
      res.on('drain', () => { conn.paused = false; sseFlushPending(conn) })
      res.on('close', () => sseTeardown(conn))
      res.on('error', () => sseTeardown(conn))
      sseTick(conn) // 建连即补发一次：since=0 / 落后游标 → 本 tick 出增量或 reset
    },
    // POST /api/runs/detail：详情查询的 POST 形态（body: id=...）。与 GET /api/runs/:id
    // 等价（同响应体）；提供 POST 形态是因为前端 fetch 的 URL 必须是字面量（Codacy SSRF
    // 规则不接受任何含变量的 URL 第一参数，GET /:id 形态无法满足），id 改走请求体。
    // 只读、无副作用，鉴权与 GET 完全一致（Cookie 会话对 POST 无效——G_4Kb 收紧口径不变，
    // 会话用户由 boot JSON 提供显式 Bearer 凭证）。
    postRunsDetail (req, res, url) {
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          const m = /(?:^|&)id=(\d{13,}\.\d{1,10})$/.exec(body)
          if (!m) { sendJson(res, 400, { error: '缺少合法 id（epoch.seq 数字形态）' }); return }
          const record = runs.get(m[1])
          if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
          sendJson(res, 200, {
            id: record.id,
            action: record.action,
            label: record.label,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            exitCode: record.exitCode,
            timedOut: record.timedOut,
            cancelled: record.cancelled === true,
            output: record.output,
            // 绝对偏移游标数据源（v3.300 3.1）：环形淘汰后 output.length ≠ 绝对偏移，
            // 前端初始游标必须用 outputTotalLength（§2 D5）。两详情响应体保持等价。
            outputTotalLength: record.outputTotalLength
          })
        })
        .catch((e) => { logCaught('runs/detail', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    },
    // POST /api/runs/cancel（v3.299 批次②）：停止运行中的触发任务。body: id=...，
    // 与 /api/runs/detail 同形态（前端 fetch 首参必须是字面量 URL——Codacy SSRF 规则，
    // GET /:id/cancel 形态无法满足）。
    //
    // 安全设计（评审预审）：
    // - 杀进程只经 record._child 对象引用（内核句柄绑定 spawn 时进程，免疫 pid 复用）；
    //   锁帧 pid 是控制台自身，绝不作为 kill 目标。
    // - 信号纪律：SIGTERM → 3s 宽限（unref 定时器）→ SIGKILL 兜底，与既有超时/关停
    //   路径同一套「杀→等 close→锁由 close 释放」机器。
    // - 锁零操作：不 unlink（CodeQL 铁律）、不覆写、不碰 lastAccept——取消后重放窗保留，
    //   同动作 ≈12min 冷却，阻断「取消后误重推已送达未记录条目」（半推送披露见 README）。
    // - 幂等：已完成 409；已取消 200 返回现状（防重复按钮发第二次信号）。
    postRunsCancel (req, res, url) {
      if (isShuttingDown()) {
        sendJson(res, 503, { error: '控制台正在关闭，动作未执行' })
        return
      }
      readBody(req)
        .then(({ body, aborted, over }) => {
          // 关停竞态兜底：readBody 期间收到 SIGTERM 时，关停序列即将 SIGKILL 全部子进程，
          // 这里再发信号会与关停机器打架——拒绝（与 /trigger 同款双查）。
          if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          // id 形态 = 「epoch.seq」全数字段（Sourcery #229-1）：跨进程结构性失配，
          // 旧 id 在新进程必然 404，不存在「序列复用误命中」。
          const m = /(?:^|&)id=(\d{13,}\.\d{1,10})$/.exec(body)
          if (!m) { sendJson(res, 400, { error: '缺少合法 id（epoch.seq 数字形态）' }); return }
          const record = runs.get(m[1])
          if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
          if (record.cancelled) {
            // 幂等先于 finishedAt（Sourcery #229-8）：已受理过取消的任务之后无论是否
            // 已结束，重复 cancel 都返回 200 现状——不因时序在 200/409 间漂移。
            sendJson(res, 200, { id: record.id, action: record.action, cancelled: true, finishedAt: record.finishedAt || null })
            return
          }
          if (record.exitedAt || record.finishedAt) {
            // exitedAt（Sourcery #229-10）：exit 事件先于 close（stdout/stderr drain 中）
            // 的窗口里任务已不可取消——以「进程已退出」为准，而不是等 close 落 finishedAt。
            sendJson(res, 409, { error: '该任务已结束，无需停止' })
            return
          }
          record.cancelled = true
          record.cancelRequestedAt = Date.now()
          // 绕过 append 直改 output：计数器必须同步加（§1.3 理由同上）。
          const note = '\n[console] 收到停止请求，正在终止子进程…\n'
          record.output += note
          record.outputTotalLength += note.length
          // 审查 #229 S7 / D1-N3：停止留痕进 run.log——被停任务不会有自然收尾的摘要行，
          // 控制台补一行 **CANCEL** 前缀的取消留痕（上海时区戳与写入侧 _localStamp 同形态）。
          // readRunHistory 把 CANCEL 行识别成「cancelled 占位条目」，既让这轮在历史里可见，
          // 又不参与 interrupted 判定（旧实现写 ERROR → 被回填成「下一轮中断」；#241 去掉
          // 回填后该轮又彻底消失，两种都错）。
          try {
            const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            const stamp = stampFmt.format(new Date())
            const stopDir = historyDir()
            fs.appendFileSync(path.join(stopDir, 'run.log'), `${stamp} CANCEL 控制台停止：任务 #${record.id}（${record.action}）于运行中被停止（SIGTERM）\n`, 'utf8')
          } catch (e) { /* 留痕失败静默：内存 record.cancelled 已是权威 */ }
          try {
            record._child && record._child.kill('SIGTERM')
          } catch (e) { /* 子进程句柄已失效：close 即将到来，兜底无害 */ }
          // SIGKILL 兜底：宽限期后 close 仍未来（SIGTERM handler 卡住等）→ 强杀。
          // 不依赖 kill 返回值（Node 不保证其反映进程状态）：已死进程上再签 SIGKILL
          // 是无害 no-op，漏签才会让卡死任务挂到 PROC_TIMEOUT_MS。
          // Sourcery #229-0：close 一到就 clearTimeout——子进程已死后再发的 SIGKILL
          // 理论上不会命中复用 pid（kill 走句柄不走裸 pid，但句柄在子进程退出后发信号
          // 本就是无意义动作），清理定时器让事件循环不留 3s 悬挂句。
          const cancelChild = record._child
          record._cancelTimer = setTimeout(() => {
            try { cancelChild.kill('SIGKILL') } catch (e) { /* 已退出 */ }
          }, CANCEL_GRACE_MS)
          if (typeof record._cancelTimer.unref === 'function') record._cancelTimer.unref()
          sendJson(res, 202, { id: record.id, action: record.action, cancelled: true })
        })
        .catch((e) => { logCaught('runs/cancel', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    },
    // GET /api/runs/:id：等价的读取形态（前端 fetch 必须字面量 URL ⇒ 详情走 POST，本形态给 API/测试用）。
    runById (req, res, url, match) {
      const record = runs.get(match[1])
      if (!record) { sendJson(res, 404, { error: 'not found（进程重启后历史丢失）' }); return }
      sendJson(res, 200, {
        id: record.id,
        action: record.action,
        label: record.label,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        exitCode: record.exitCode,
        timedOut: record.timedOut,
        cancelled: record.cancelled === true,
        output: record.output,
        outputTotalLength: record.outputTotalLength // 与 POST detail 等价（v3.300 3.1）
      })
    }
  }
}

module.exports = { createRunsHandlers }
