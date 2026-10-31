// scripts/console-assets/pages.js —— 控制台页面面板（v3.369 从 ui.js 拆出）。
// 运行历史 / 逐轮历史 / 趋势 / 缓存健康 / 推送记录 / 运行日志 / 控制台设置 / 备份 / 两步验证 /
// 系统 / 文件 / 配置 / 过滤规则。只依赖 components.js 与基础模块，不认识 App，也没有顶层副作用。
// 顺序在 ui.js 之前（App 在 ui.js 里 import 这些面板）。
import { BACKUP_FILE_MAX_BYTES, NOTIFY_WINDOW_MAX_S, NOTIFY_WINDOW_MIN_S } from './constants.js'
import { BOOT, DAY_KEY_RE, apiCancelRun, apiDeleteFilterDraft, apiGetAccessLog, apiGetCacheHealth, apiGetConfig, apiGetConsoleSettings, apiGetFiles, apiGetFilter, apiGetFilterDraft, apiGetLineWatch, apiGetLogs, apiGetMessages, apiGetRunDetail, apiGetRunHistory, apiGetSys, apiGetTrends, apiGetTwoFactorStatus, apiPostBackupExport, apiPostBackupImport, apiPostConsoleSettings, apiPostDevicesRevoke, apiPostFilterDraft, apiPostFilterPreview, apiPostFilterRestore, apiPostFilterSave, apiPostFilterValidate, apiPostLineWatch, apiPostTwoFactorDisable, apiPostTwoFactorEnable, apiPostTwoFactorSetup, apiSearchLines, timedRequest } from './api.js'
import { Badge, Button, ConfirmDialog, DateRange, Drawer, EMPTY_RANGE, Hint, LoadError, MiniSelect, PanelHead, PanelSkeleton, RUN_LOG_WAIT_MS, Reveal, channelLabel, inDayRange, placeAt, scrollIntoBox, stickyPad, useHoldRepeat } from './components.js'
import { MOTION, flash, useFlipList, useRevealWhen } from './motion.js'
import { backupImportProblem, backupPasswordProblem, buildSaveCandidate as buildSaveCandidateOf, cacheWriteInfo, decryptBackup, effectiveFilterRows, encryptBackup, filterLogLines, filterOverrideFields, filterRunItems, filterSourceNote, fmtAge, isEncryptedBackup, isTimeoutError, logLineCounts, logLineTone, searchBodyView, searchRefreshError, splitHits } from './pure.mjs'
import { fmtBytes, fmtIsoStamp, fmtLocalTime, fmtNum, fmtTime } from './format.js'
// 定位引擎（同 MiniSelect）：分类弹层的翻上/夹取/压高都交给中间件，不再自己量 below/above。
import { computePosition, flip, offset, shift, size } from './floating-ui.module.js'
// 虚拟滚动（vendored 单文件 ESM，MIT）：只导出 Virtualizer —— 日志页只挂可视窗口的行。
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from './virtual-core.module.js'
import { html, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from './htm-preact.module.js'

function RunsPanel ({ runs, status = 'ok', pollMs, onRefresh, active = true }) {
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailErr, setDetailErr] = useState('')
  // 详情日志跟随（审查 #244）：运行中标题写「实时跟随」，但输出框此前从不滚动——
  // 新行只追加在底部，用户看到的是开头几行。与运行日志页同口径：默认贴底，
  // 用户上翻后不抢位置，滚回底部自动恢复跟随。
  const logRef = useRef(null)
  const followRef = useRef(true)
  // 乱序防护（Sourcery vwI）：detail 请求领号，落后响应丢弃。
  const detailSeqRef = useRef(0)
  // onRefresh 经 ref 解引用（v3.300 3.1 §2 D7）：若直接进 effect deps，其身份不稳定
  // 会导致 SSE 每渲染重连（快照重建流）。
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  // 切换目标 run 时清旧详情（Sourcery G_oi + Old-logs-flash）：useEffect 在渲染后
  // 才跑，「新 openId + 旧 detail」会闪一帧。渲染期同步判定：detail.runId 与当前 openId
  // 不符就不显示（下方 logpre 用 detailForOpen 而非裸 detail）。effect 仍负责清状态。
  // v3.313：点「日志」改为先取详情再开框（见 openLog），预取的 detail 已属于新 openId，
  // 这里必须原样保留——无条件 setDetail(null) 会把预取结果当场抹掉，框又退回「加载中…」。
  useEffect(() => {
    setDetail((prev) => (prev !== null && prev.id === openId ? prev : null))
    setDetailErr('')
  }, [openId])
  // openRun/openActive 先声明后使用（v3.300 3.1 §1.9b）：详情跟随 effect 依赖 openActive，
  // 须在 effect 之前声明（渲染逻辑零变化）。
  const openRun = openId !== null ? runs.find((r) => r.id === openId) : null
  const openActive = !!(openRun && !openRun.finishedAt)
  // 打开日志框：先取详情、再与 openId 同一批 set，让首帧就是最终日志（v3.313）。
  // 旧实现先 setOpenId、由 effect 再拉详情：框首帧只有「加载中…」（实测高 89px），
  // 详情回来撑成整段（366px、页高 +277px）——手机上就是先闪一下再跳一截。
  // 与确认弹窗同口径：最多等 RUN_LOG_WAIT_MS；拿不到才用占位符开框，开框后原请求
  // 到达只回填正文（不再重开）。seq 作废「先点 A 再点 B」时迟到的 A；openingRef 防连点
  // 同一行反复起请求（每次重起都会把 600ms 的上限重新计时，等于越点越慢）。
  const openSeqRef = useRef(0)
  const openingRef = useRef(null)
  // 预取成功的详情只给「打开它的那次 effect」用一次：之后 openActive 翻转等重跑
  // 必须重新取快照，否则拿旧 outputTotalLength 当游标会把已有增量再推一遍。
  const seedRef = useRef(null)
  // 关闭必须同时作废在飞的预取：否则「点 B → 关闭」后 B 的详情回来还会把框打开。
  const closeLog = () => {
    openSeqRef.current++
    openingRef.current = null
    setOpenId(null)
  }
  const openLog = (id) => {
    if (openId === id) {
      closeLog()
      return
    }
    if (openingRef.current === id) return
    const seq = ++openSeqRef.current
    openingRef.current = id
    let timer = 0
    let opened = false
    const openWith = (d) => {
      // 代次守卫必须是第一句：过期响应不得在任何 set 之前漏过去。
      if (seq !== openSeqRef.current) return
      clearTimeout(timer)
      openingRef.current = null
      if (d) setDetail(d)
      setDetailErr('')
      if (opened) return // 超时已开框：晚到的详情只回填正文，不再 setOpenId
      opened = true
      if (d) seedRef.current = { id, detail: d }
      setOpenId(id)
    }
    // 正常一发几十毫秒；超时也不能把点击卡住——照旧用「加载中…」开框。
    timer = setTimeout(() => openWith(null), RUN_LOG_WAIT_MS)
    apiGetRunDetail(id).then((d) => openWith(d)).catch(() => openWith(null))
  }
  // typeof 判据必须是 'string'（v3.300 3.1 §1.9a 回归修复）：v3.299 起 run id 改为
  // 「epoch.seq」字符串下发（服务端 makeRunId 模板串），number 判据恒 false ⇒
  // detailForOpen 恒 null ⇒ 日志框永远「加载中…」。
  const detailForOpen = detail !== null && typeof detail.id === 'string' && detail.id === openId
    ? detail
    : null

  // 切换目标时恢复跟随；输出变化时若仍在底部就贴底（含 SSE 增量与轮询快照）。
  useEffect(() => { followRef.current = true }, [openId])
  useEffect(() => {
    const el = logRef.current
    if (!el || detailForOpen === null) return
    if (followRef.current) el.scrollTop = el.scrollHeight
  }, [detailForOpen])
  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // 详情跟随（v3.300 3.1）：运行中走 SSE 实时流（原生 EventSource，零依赖）；
  // 非运行中 / 快照已完结 / 流错误回退原轮询。两通道在 effect 内二选一：SSE 模式不建
  // interval，轮询模式不建 EventSource——切态必经 cleanup（dead + es.close()），无叠加。
  // SSE 不经过 inFlightRef/timedRequest（那是 5s 主轮询的互斥面），互不抢占（蓝图红线 6）。
  useEffect(() => {
    // pollMs=0 只关掉 interval；页签保活后隐藏的概览/日志仍会打开 SSE 或拉快照。
    // active=false 直接不建流：切走即断开，切回 effect 重跑会重新取快照/重连。
    if (openId === null || !active) return undefined
    // 预取成功时本轮已有完整快照：不再重复请求（慢网下第二次失败会把有效日志盖成
    // 「加载失败」）。seed 只吃一次——之后 effect 因 openActive 翻转等重跑时必须
    // 重新取快照，不能拿旧 outputTotalLength 当游标（会把已追加的增量再推一遍）。
    const seed = seedRef.current !== null && seedRef.current.id === openId ? seedRef.current.detail : null
    seedRef.current = null
    let dead = false
    let es = null
    let inflight = false
    let pollTimer = null
    const fetchOnce = async () => {
      // Sourcery Overlapping-log-polls/Slow-log-requests：详情请求慢于轮询间隔时逐 tick
      // 叠加并发请求，迟到的失败响应会把过期错误写到当前面板。与主轮询同口径：
      // 上一轮未回跳过本轮（8s 期限保证不会永久跳过）；领号防乱序保留。
      if (document.visibilityState === 'hidden') return // 后台标签页不轮询详情（切回时补一次）
      if (inflight) return
      inflight = true
      const seq = ++detailSeqRef.current
      try {
        const d = await apiGetRunDetail(openId)
        if (dead || seq !== detailSeqRef.current) return
        setDetail(d)
        setDetailErr('')
      } catch (e) {
        if (dead || seq !== detailSeqRef.current) return
        setDetailErr(`加载失败：${e.message}`)
      } finally {
        inflight = false
      }
    }
    // 切回前台立即补一拍（不依赖 interval 的下一 tick；隐藏期间已跳过所有详情请求）。
    // SSE 模式不能 fetchOnce：它会领号 ++detailSeqRef，令已建流的所有回调因代次不符被丢弃，
    // 运行中日志就此冻结（审查 #248）。SSE 模式下只需刷新 runs 徽章，详情交给流继续推。
    const onVisibility = () => {
      if (dead || document.visibilityState !== 'visible') return
      if (openActive) { onRefreshRef.current(); return }
      fetchOnce().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    const startPolling = () => {
      if (pollTimer !== null || dead) return
      // S9383：fetchOnce 内部已 try/catch 全收（不会 reject），但仍显式 .catch 兜底，
      // 不留 floating promise（与 console.js 里 readBody 的处理同口径）。
      fetchOnce().catch(() => { /* fetchOnce 不 reject，S9383 口径 */ })
      // 已结束的轮次只需要一次快照，永不建 interval（Sourcery #254：否则打开已完成的
      // 日志会按 pollMs 无限轮询详情）。运行中 SSE 回退才需要继续轮询。
      if (!openActive) return
      // pollMs=0 表示自动刷新已暂停：只取一次快照，绝不能 setInterval(fn, 0)
      // （暂停后打开已结束轮次的日志会变成热循环，持续打 /api/runs/detail）。
      if (!(pollMs > 0)) return
      pollTimer = setInterval(() => { fetchOnce().catch(() => {}) }, pollMs)
    }
    if (!openActive) {
      // 预取已拿到快照：不再发第二个详情请求（失败会覆盖有效日志）。
      if (seed === null) startPolling()
      return () => {
        dead = true
        document.removeEventListener('visibilitychange', onVisibility)
        if (pollTimer !== null) clearInterval(pollTimer)
      }
    }
    // ── SSE 模式：先取轮询快照，以快照 outputTotalLength 为初始游标建流（顺序不可倒置，
    // 快照先落 detail 再开流，快照后新增量由首个 tick 补发——不重不漏，见 §2 D5）。
    const seq = ++detailSeqRef.current
    // 流代次号（评审 231-M4）：本 effect 运行 = 新一代。旧流的排队回调（同一 run 关了
    // 又开的场景：prev.id===openId 仍命中）必须凭代次失效——seq 是闭包值，回调比对
    // detailSeqRef.current 即可判「自己是否仍是当前代」。
    const mySeq = seq
    const startStream = (d) => {
      if (dead || seq !== detailSeqRef.current) return
      setDetail(d)
      setDetailErr('')
      if (d.finishedAt) return // 快照时已完结：不开流，runs 刷新翻转 openActive 后进轮询
      const start = typeof d.outputTotalLength === 'number' ? d.outputTotalLength : (d.output || '').length
      const params = new URLSearchParams({ id: String(openId), since: String(start) })
      // EventSource 第一参数照 fetch 字面量纪律：`/api/...` 模板字面量（同源相对路径，
      // authority 恒同源），变量只进查询段（§2 D1）。不带 token：会话 Cookie 自动携带
      // （页面加载即下发，authorize GET 收 Cookie）；token 进 URL 会落浏览器历史/访问日志。
      es = new window.EventSource(`/api/runs/stream?${params.toString()}`)
      es.onmessage = (ev) => {
        // 未命名 data 帧 = 增量文本（JSON 字符串）。函数式更新 + 身份护栏（prev.id 匹配
        // + 代次守卫：陈旧流回调在「同 run 关闭重开」场景 prev.id 仍命中，必须再验
        // mySeq===detailSeqRef.current，评审 231-M4）。
        try {
          const chunk = JSON.parse(ev.data)
          if (typeof chunk === 'string' && chunk.length > 0) {
            setDetail((prev) => (prev !== null && prev.id === openId && mySeq === detailSeqRef.current ? { ...prev, output: (prev.output || '') + chunk } : prev))
          }
        } catch (e) { /* 坏帧忽略：最终快照/重拉自愈 */ }
      }
      // named event 不进 onmessage（蓝图红线）：显式注册 reset / done。
      es.addEventListener('reset', (ev) => {
        try {
          const payload = JSON.parse(ev.data)
          if (payload && typeof payload.full === 'string') {
            setDetail((prev) => (prev !== null && prev.id === openId && mySeq === detailSeqRef.current ? { ...prev, output: payload.full } : prev))
          }
        } catch (e) { /* 同上 */ }
      })
      es.addEventListener('done', () => {
        if (es !== null) { es.close(); es = null } // 防原生自动重连在流关闭后无限重试（蓝图口径）
        fetchOnce().catch(() => {}) // 最终快照补 finishedAt/exitCode
        onRefreshRef.current() // 立即刷新 runs 列表徽章（ref 解引用，防 effect 重连，§2 D7）
      })
      let streamErrors = 0
      es.onopen = () => { streamErrors = 0 }
      es.onerror = () => {
        // v3.363：先让原生 EventSource 自动重连——服务端发了 `retry: 2000`，且浏览器重连
        // 会自动带 Last-Event-ID，服务端据此只补缺口（不再是整段重拉）。连续 3 次仍连不上
        // 才 close 并回退轮询，由 fetchOnce 拿最终快照兜底。
        streamErrors += 1
        if (es !== null && es.readyState === window.EventSource.CONNECTING && streamErrors <= 3) return
        if (es !== null) { es.close(); es = null }
        fetchOnce().catch(() => {})
        startPolling()
      }
    }
    // 预取快照直接建流（省一次请求，也避免慢网下第二次失败覆盖有效日志）。
    if (seed !== null) startStream(seed)
    else apiGetRunDetail(openId).then(startStream).catch(() => { if (!dead) startPolling() }) // 快照失败 → 回退轮询（既有能力兜底）
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (es !== null) es.close()
      if (pollTimer !== null) clearInterval(pollTimer)
    }
  }, [openId, openActive, pollMs, active])

  // statusOf（Sourcery vv4）：以 finishedAt 为完成判据；
  // 「finishedAt 已设但 exitCode null」= 信号终止（含超时 SIGKILL），显示「已终止」。
  // cancelled 徽章优先于普通结果（v3.299 批次②）：被停止的轮次无论退出码如何都标「已停止」。
  const statusOf = (r) => {
    if (r.cancelled === true && !r.finishedAt) return html`<${Badge} tone='run'>停止中<//>`
    if (r.finishedAt) {
      if (r.cancelled === true) return html`<${Badge} tone='bad'>已停止<//>`
      if (r.timedOut) return html`<${Badge} tone='bad'>超时<//>`
      if (r.exitCode === 0) return html`<${Badge} tone='ok'>成功<//>`
      if (r.exitCode === null) return html`<${Badge} tone='bad'>已终止<//>`
      return html`<${Badge} tone='bad'>退出码 ${r.exitCode}<//>`
    }
    if (r.exitCode === null) return html`<${Badge} tone='run'>运行中<//>`
    return html`<${Badge} tone='bad'>已终止<//>`
  }
  // 停止按钮（v3.299 批次②）：只对未完成的轮次显示；点击后置本地 pending 态并刷新，
  // 结果徽章由下一轮轮询的 cancelled/finishedAt 驱动。
  const [cancelPending, setCancelPending] = useState(null)
  const [cancelErr, setCancelErr] = useState('')
  // 首屏行入场（只播一次；后续轮询只更新文字，不再闪）。
  const listRef = useRef(null)
  useRevealWhen(listRef, runs.length > 0, 'tbody tr', { transform: false, duration: MOTION.fast, step: 0.02, cap: 6 })
  const doCancel = async (id) => {
    setCancelPending(id)
    setCancelErr('')
    try {
      await apiCancelRun(id)
    } catch (e) {
      // v3.299 评审 #9：取消失败必须可见——成功刷新会清掉同步错误条，吞掉这里的
      // 异常会让任务在无提示下继续跑。面板内局部横幅不依赖全局轮询状态。
      setCancelErr(`停止请求失败：${e && e.message ? e.message : String(e)}（任务可能仍在运行，请重试）`)
    } finally {
      setCancelPending(null)
    }
    onRefresh()
  }

  return html`<div class="panel">
    <${PanelHead} title="触发历史" sub="最多 20 条 · 本进程内存" />
    ${cancelErr && html`<${Hint} tone="error">${cancelErr}<//>`}
    ${status === 'loading'
      ? html`<div class="empty">触发历史加载中…</div>`
      : status === 'error' && runs.length === 0
        ? html`<div class="empty">触发历史暂不可用，请稍后刷新</div>`
        : runs.length === 0
          ? html`<div class="empty">暂无触发记录</div>`
          : html`<div class="runs-scroll" ref=${listRef}><table class="runs-table">
        <thead><tr><th>#</th><th>动作</th><th>开始时间</th><th>结果</th><th></th></tr></thead>
        <tbody>
          ${runs.map((r) => html`<tr key=${r.id} class=${openId === r.id ? 'row-open' : ''}>
            <td class="mono">#${r.id}</td>
            <td>${r.label}</td>
            <td class="mono">${fmtTime(r.startedAt)}</td>
            <td>${statusOf(r)}</td>
            <td>
              ${!r.finishedAt && html`<${Button} variant=${'ghost btn-danger' + (cancelPending === r.id ? ' btn-busy' : '')} disabled=${cancelPending === r.id}
                onClick=${() => { doCancel(r.id).catch(() => {}) }} title="停止该任务（SIGTERM，3 秒后强杀；已发送但未记录的通知下轮会重推）">停止<//>`}
              <${Button} variant="ghost" onClick=${() => openLog(r.id)}>
                ${openId === r.id ? '收起' : '日志'}
              <//>
            </td>
          </tr>`)}
        </tbody>
      </table></div>`}
    ${openId !== null && html`<div class="logbox">
      <div class="logbox-head">
        <span>运行 #${openId} 输出${openActive ? '（实时跟随）' : ''}</span>
        <${Button} variant="ghost" onClick=${closeLog}>关闭<//>
      </div>
      <pre class="logpre" ref=${logRef} onScroll=${onLogScroll}>${
        detailErr ||
        (detailForOpen === null
          ? '加载中…'
          // Sourcery G_oq：detail 已加载但 output 为空串 = 该轮合法地没有任何输出，
          // 必须显示「（无输出）」而不是永远「加载中…」。
          : (typeof detailForOpen.output === 'string' && detailForOpen.output.length > 0 ? detailForOpen.output : '（无输出）'))
      }</pre>
    </div>`}
  </div>`
}

// ── 组件：逐轮运行历史（v3.307 改版）────────────────────────────────────────
// 旧版用 before 游标 + 每页 2/3/5/10 条：180 行日志要翻 30+ 页，找某天的失败轮只能一页页点。
// 现在一次取尾窗最近 200 轮（服务端上限），在前端做「只看失败/中断」「按日期」筛选与页码分页；
// 数据量小（≤200 条），换来的是「跳日期、看失败、点日志」三件事都能直接做。
// 尾窗指纹/stale 语义仍由服务端保留（本组件只发一次 limit=200，不翻游标）。
const RUN_PAGE_SIZES = [10, 20, 50, 100]
const RUN_FETCH_LIMIT = 200
// 逐轮历史的两份服务端快照：仅运行（前端剔除取消留痕）与全量（全部/只看异常共用）。
// 两份由同一次 /api/run-history 请求填充，切档不再发第二次请求。
const RUN_SNAP_KEY = (m) => (m === 'runs' ? 'runs' : 'all')

// ── 列表落点（v3.320）──────────────────────────────────────────────────────
// 推送记录 / 逐轮历史的列表都比一屏长，分页器在列表底部：用户翻页时人已经在底部，
// 新一页更短时浏览器会把 scrollY 夹进新的可滚动范围（document.scrollHeight 变小），
// 于是停在短页的中间甚至末行，看不到第一行。搜索落地同理（结果集变小）。
// 统一落点 = 列表容器顶部 − 吸顶页签高度 + 8，再夹进
// document.scrollHeight − innerHeight；返回 null 表示别滚（未挂载 / 面板隐藏时
// rect 全为 0 / 列表不在屏幕上），调用方据此跳过。
// pad 用 .tabs 的 height 而不是 bottom：页签还没吸顶时 bottom 会多算它自己的页面
// 偏移，落点比过滤定位/搜索门的「列表顶」偏低一个页签的距离。
function listLandTarget (el) {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!(rect.height > 0)) return null
  const pad = stickyPad()
  const top = rect.top + window.scrollY - pad
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  return Math.max(0, Math.min(top, max))
}

// 落点请求在飞时，只有用户自己滚动才撤销；浏览器夹取/滚动锚定不会触发这些事件。
function useLandScrollCancel (landRef, movedRef) {
  useEffect(() => {
    const mark = () => { if (landRef.current) movedRef.current = true }
    const keys = ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']
    const onKey = (e) => { if (keys.includes(e.key)) mark() }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchmove', mark, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchmove', mark)
      window.removeEventListener('keydown', onKey)
    }
  }, [landRef, movedRef])
}

function RunHistoryPanel ({ onOpenLog, active = true }) {
  const [size, setSize] = useState(10)
  // 默认只看真实轮次：取消留痕是操作审计，不该在每次打开历史时占据一半行。
  const [mode, setMode] = useState('runs')
  // v3.326：单日筛选升级为日期区间（同一个 DateRange 组件，复用组件而不是再造一个原生 date）。
  const [runRange, setRunRange] = useState(EMPTY_RANGE)
  const runRangeActive = DAY_KEY_RE.test(runRange.from) && DAY_KEY_RE.test(runRange.to)
  const [pageNo, setPageNo] = useState(1)
  const [data, setData] = useState(null)
  // data 属于哪一档（runs = 仅运行，all = 全量，供 全部/只看异常 共用）。切模式时
  // data 可能与 mode 不同步：只用来渲染手里真正有的那一档，绝不把另一档的数据硬套
  // 新筛选（v3.326）。
  const [dataMode, setDataMode] = useState('runs')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // 没有目标快照时的等待态（v3.326 评审）：选中态与列表都先不动，数据回来一次性换。
  // 快速回来（<150ms）完全不闪；更慢才在点中的胶囊上转圈。
  const [pendingMode, setPendingMode] = useState(null)
  const [pendingBusy, setPendingBusy] = useState(false)
  const pendingSeqRef = useRef(0)
  const pendingTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(pendingTimerRef.current), [])
  // v3.318：点「日志」先在原页取快照，150ms 内没回来才在按钮上转圈——快请求不闪转圈；
  // 慢请求（日志到 1 MiB 时）也不会看起来「没点上」。失败就地报错，不切页。
  const [jumpBusy, setJumpBusy] = useState('')
  const [jumpErr, setJumpErr] = useState('')
  const jumpSeqRef = useRef(0)
  const jumpTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(jumpTimerRef.current), [])
  const seqRef = useRef(0)
  // v3.320：分页/筛选后把列表顶部拉回页签下沿的落点旗（见 listLandTarget）。
  // 只有用户主动改页/改每页/改分类/改时间时置位；纯 load() 与自动刷新不置。
  const listRef = useRef(null)
  const landRef = useRef(false)
  // 首屏行入场：只播一次，翻页/轮询不再重播。
  useRevealWhen(listRef, !!(data && data.status === 'ok'), 'tbody tr', { transform: false, duration: MOTION.fast, step: 0.02, cap: 8 })
  // 置旗那一刻的位置与数据：模式切换要等自动加载的响应落地才落点；
  // 请求飞行期间用户自己滚走（非浏览器夹取）则撤销这次落点。
  const armedDataRef = useRef(undefined)
  const armedErrRef = useRef('')
  const userMovedRef = useRef(false)
  // 「已滚进列表」门：列表顶还在页签下沿之下（用户停在顶部改筛选）时不置旗——
  // 否则会把列表顶拽到页签下沿，工具条被顶出视口。口径与 listLandTarget 一致
  // （.tabs 实测高度 + 8）。
  const armLand = () => {
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!(rect.height > 0)) return
    const listTop = rect.top + window.scrollY - stickyPad()
    if (!(window.scrollY > listTop)) return
    landRef.current = true
    armedDataRef.current = data
    armedErrRef.current = err
    userMovedRef.current = false
  }
  useLandScrollCancel(landRef, userMovedRef)

  // 两档视图共用一次请求：服务端不再按 excludeCancelled 预过滤，「仅运行」由前端剔除
  // 取消留痕（filterRunItems 与渲染同口径）——旧版首屏为此多发一次 200 行的
  // /api/run-history?excludeCancelled=1（与全量一份合计 71KB）。
  // 口径差异如实记下：窗口是「最近 200 行」（含取消记录），取消很多时可见轮次会少于 200 行；
  // 换来切档零请求、零等待（同一份数据原地过滤，取代旧版「后台预取另一档」）。
  const snapsRef = useRef({ runs: null, all: null })
  const preSeqRef = useRef({ runs: 0, all: 0 })
  const quietNextRef = useRef(false)
  // 快照写入按「发起顺序」判新旧：两个档位的请求重叠时，先发的那发即使后到也不能盖掉
  // 后发的响应（Sourcery #315-4）。在飞请求也复用，切档不再多发一条（Sourcery #315-5）。
  const snapWriteRef = useRef(0)
  const snapInflightRef = useRef(null)
  const fetchSnap = useCallback((k) => {
    const seq = ++preSeqRef.current[k]
    const now = Date.now()
    if (snapInflightRef.current && now - snapInflightRef.current.at < 3000) return snapInflightRef.current.p
    const write = ++snapWriteRef.current
    const p = apiGetRunHistory({ limit: RUN_FETCH_LIMIT })
      .then((d) => {
        if (write === snapWriteRef.current && seq === preSeqRef.current[k]) {
          snapsRef.current[k] = d
          // 同一份全量窗口也满足另一档：切过去直接命中快照，不再补发请求。
          snapsRef.current[k === 'runs' ? 'all' : 'runs'] = d
        }
        return d
      })
    snapInflightRef.current = { at: now, p }
    p.then(() => { if (snapInflightRef.current && snapInflightRef.current.p === p) snapInflightRef.current = null },
      () => { if (snapInflightRef.current && snapInflightRef.current.p === p) snapInflightRef.current = null })
    return p
  }, [])
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    const m = mode
    const k = RUN_SNAP_KEY(m)
    // 切到已有快照的档位时静默刷新：不置 loading（分页按钮不闪禁用态），
    // 首帧已由 changeMode 用快照画好。
    const quiet = quietNextRef.current
    quietNextRef.current = false
    // 不再预取另一档：一份全量快照同时喂两档（fetchSnap 里同步写两个 key），
    // 切档命中快照即可，首屏也只剩一次 /api/run-history。
    // 静默刷新要顺手清掉可能还挂着的 loading（切档会顶掉上一发非静默请求，
    // 那发的 finally 因请求号过期不会再来清，否则分页按钮会一直禁用）。
    setLoading(!quiet)
    try {
      const d = await fetchSnap(k)
      if (seq !== seqRef.current) return
      setData(d)
      setDataMode(k)
      setErr('')
    } catch (e) {
      if (seq === seqRef.current) setErr(`加载失败：${e.message}`)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [mode, fetchSnap])
  // 保活后概览切回来时补拉一次；离开概览不拉。data 保留，不出现加载占位。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)

  const all = data && data.status === 'ok' && Array.isArray(data.items) ? data.items : []
  // 全量快照才含取消留痕：仅运行档算出来是假的 2（本档不显示数字，仍保险）。
  const fullSnap = dataMode === 'all'
  const issueCount = fullSnap ? filterRunItems(all, { mode: 'issue' }).length : null
  const runsCount = filterRunItems(all, { mode: 'runs' }).length
  // 切档是原子的（mode 变化时 data 已换成同一档），直接按 mode 过滤即可。
  const filtered = filterRunItems(all, { mode })
    .filter((r) => inDayRange(typeof r.at === 'string' ? r.at.slice(0, 10) : '', runRange))
  const pages = Math.max(1, Math.ceil(filtered.length / size))
  const current = Math.min(pageNo, pages)
  // 数据变少（筛选/刷新）时把页码收回有效区间；不在渲染期 setState。
  useEffect(() => { if (pageNo > pages) setPageNo(pages) }, [pageNo, pages])
  const shown = filtered.slice((current - 1) * size, current * size)
  const changeSize = (n) => {
    if (n === size) return // 值没变不置旗：旗子悬着会在下一次响应落地时替旧操作搬位置
    armLand()
    setSize(n)
    setPageNo(1)
  }
  // refresh() 是「重新加载当前页」，不搬滚动位置；只有用户主动改页/改每页/改分类/
  // 改日期才置落点旗。
  const refresh = () => { setPageNo(1); load().catch(() => {}) }
  const changeDay = (v) => {
    // 值守卫（同 MiniSelect）：区间没变就不回调，避免一次无意义的筛选重拉。
    if (v.from === runRange.from && v.to === runRange.to) return
    armLand()
    setRunRange(v)
    setPageNo(1)
  }
  const changeMode = (m) => {
    if (m === pendingMode) return // 已在等这个档位，别重复发请求
    if (m === mode) {
      if (pendingMode === null) return // 已选中的 chip 再点一次不搬位置
      // 点回当前档 = 取消还在路上的等待，留在原视图。
      clearTimeout(pendingTimerRef.current)
      pendingSeqRef.current++
      setPendingMode(null)
      setPendingBusy(false)
      return
    }
    const key = RUN_SNAP_KEY(m)
    const cached = snapsRef.current[key]
    clearTimeout(pendingTimerRef.current)
    const seq = ++pendingSeqRef.current // 取消上一次还没落地的等待
    seqRef.current++ // 作废还在飞的旧档刷新（晚到的响应会把新档数据盖掉）
    armLand() // 等待期间用户自己滚动会撤销落点
    if (cached !== null) {
      // 目标快照已在：同一批换列表与选中态，首帧就是目标数据。
      setPendingMode(null)
      setPendingBusy(false)
      setData(cached)
      setDataMode(key)
      setMode(m)
      setPageNo(1)
      quietNextRef.current = true
      return
    }
    // 没有目标快照：选中态与列表都先不动，等数据回来一次性换——绝不把旧档数据
    // 挂到新筛选下。150ms 内回来完全不闪，更慢才在点中的胶囊上转圈。
    setPendingMode(m)
    pendingTimerRef.current = window.setTimeout(() => {
      if (seq === pendingSeqRef.current) setPendingBusy(true)
    }, 150)
    fetchSnap(key).then((d) => {
      if (seq !== pendingSeqRef.current) return
      clearTimeout(pendingTimerRef.current)
      setPendingBusy(false)
      setPendingMode(null)
      setData(d)
      setDataMode(key)
      setMode(m)
      setPageNo(1)
      quietNextRef.current = true
    }).catch((e) => {
      if (seq !== pendingSeqRef.current) return
      clearTimeout(pendingTimerRef.current)
      setPendingBusy(false)
      setPendingMode(null)
      landRef.current = false // 失败不落点
      setErr(`加载失败：${e.message}`)
    })
  }
  const goPage = (n) => {
    if (n === current) return // 目标页 = 当前页：不置旗（否则残留的旗会替下一次操作落点）
    armLand()
    setPageNo(n)
  }
  // v3.320：在 paint 前落点（旧版换页后页高变化，浏览器把 scrollY 夹到新的上限，
  // 停在短页中间）。listLandTarget 在面板隐藏/列表不在时返回 null ⇒ 不滚。
  // 消费即清旗：返回 null 也不再重试（否则旗子会挂到下一次操作上）。
  useLayoutEffect(() => {
    if (!landRef.current) return
    landRef.current = false
    // 请求飞行期间用户自己滚动时撤销落点，别把人拽回列表顶（夹取/锚定不算）。
    if (userMovedRef.current) return
    const y = listLandTarget(listRef.current)
    if (y === null) return
    window.scrollTo(0, y)
  }, [data, loading, err, pageNo, size, mode, runRange.from, runRange.to])
  const jumpLog = (r) => {
    if (!onOpenLog || typeof r.at !== 'string' || r.at.length < 10) return
    const key = `${r.at}-${r.lineNo}`
    const seq = ++jumpSeqRef.current
    setJumpErr('')
    // 连点另一行时先撤掉上一行的转圈；点同一行则保持，避免转圈闪一下。
    setJumpBusy((prev) => (prev === '' || prev === key ? prev : ''))
    // 150ms 内回来的请求不显示忙碌（否则一闪而过的转圈比不转还烦）。
    clearTimeout(jumpTimerRef.current)
    jumpTimerRef.current = window.setTimeout(() => {
      if (seq === jumpSeqRef.current) setJumpBusy(key)
    }, 150)
    // 单轮「日志」= 看这一天的完整日志（含摘要/告警/错误）；带 focus 让日志页把
    // 点中的那一轮居中高亮，而不是丢进当天 14 条一模一样的时间戳里。
    Promise.resolve(onOpenLog({ q: r.at.slice(0, 10), mode: 'all', focus: r.at }))
      .then((res) => {
        if (seq !== jumpSeqRef.current) return
        if (res && res.ok === false && !res.canceled) {
          setJumpErr(`日志加载失败：${res.error || '请重试'}`)
        }
      })
      .catch((e) => {
        if (seq === jumpSeqRef.current) setJumpErr(`日志加载失败：${e && e.message ? e.message : e}`)
      })
      .finally(() => {
        if (seq !== jumpSeqRef.current) return
        clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = 0
        setJumpBusy('')
      })
  }
  return html`<div class="panel">
    <${PanelHead} title="逐轮运行历史"
      sub=${err
        ? 'run.log 读取失败'
        : (data
            ? `run.log 摘要逐轮 · 最近 ${all.length} 轮` + (data.truncated ? ' · 日志已轮转/超窗，更早轮次已丢失' : '') +
              (runRangeActive ? ` · 日期 ${runRange.from} ~ ${runRange.to}（${filtered.length} 轮）` : '')
            : 'run.log 摘要逐轮 · 加载中…')}
      right=${html`<div class="toolbar">
        <${MiniSelect} value=${String(size)} ariaLabel="每页显示条数"
          options=${RUN_PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
          onChange=${(v) => changeSize(Number(v))} />
        <${Button} variant="ghost" onClick=${refresh} disabled=${loading}>刷新<//>
      </div>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${jumpErr && html`<${Hint} tone="error">${jumpErr}<//>`}
    ${data && data.status === 'ok' && html`<div class="run-tools">
      <div class="log-chips" role="group" aria-label="逐轮筛选">
        <button type="button" class=${'log-chip' + (mode === 'all' ? ' on' : '')}
          aria-busy=${pendingMode === 'all' && pendingBusy ? 'true' : 'false'}
          aria-pressed=${mode === 'all' ? 'true' : 'false'} onClick=${() => changeMode('all')}>${mode === 'all' && fullSnap ? `全部 ${all.length}` : '全部'}</button>
        <button type="button" class=${'log-chip' + (mode === 'runs' ? ' on' : '')}
          aria-busy=${pendingMode === 'runs' && pendingBusy ? 'true' : 'false'}
          aria-pressed=${mode === 'runs' ? 'true' : 'false'} onClick=${() => changeMode('runs')}>仅运行 ${runsCount}</button>
        <button type="button" class=${'log-chip' + (mode === 'issue' ? ' on' : '')}
          aria-busy=${pendingMode === 'issue' && pendingBusy ? 'true' : 'false'}
          aria-pressed=${mode === 'issue' ? 'true' : 'false'} onClick=${() => changeMode('issue')}>${mode === 'runs' || issueCount === null ? '只看异常' : `只看异常 ${issueCount}`}</button>
      </div>
      ${active && html`<${DateRange} value=${runRange} onChange=${changeDay} label="按日期筛选轮次" />`}
      <span class="run-tools-note">${mode === 'issue' ? '只显示失败、中断或取消的轮次' : (mode === 'runs' ? '不显示取消留痕；切「全部」可查' : '点行尾「日志」跳到该日日志')}</span>
    </div>`}
    ${data && data.status && data.status !== 'ok' && html`<div class="empty">run.log${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}</div>`}
    ${!data && !err && html`<div class="empty">加载中…</div>`}
    ${data && data.status === 'ok' && html`<div class="runs-scroll" ref=${listRef}>
      ${shown.length > 0
        ? html`<table class="runs-table run-history-table">
      <colgroup>
        <col class="rh-time" /><col class="rh-get" /><col class="rh-dedup" />
        <col class="rh-filter" /><col class="rh-push" /><col class="rh-fail" />
        <col class="rh-elapsed" /><col class="rh-action" />
      </colgroup>
      <thead><tr><th>时间</th><th>获取</th><th>去重</th><th>过滤</th><th>推送</th><th>失败</th><th>耗时</th><th aria-label="操作"></th></tr></thead>
      <tbody>
        ${shown.map((r, i) => html`<tr key=${`${r.at}-${r.lineNo}-${i}`}>
          <td class="mono">${r.cancelled === true ? `${r.at || '—'} ⏹已取消` : r.interrupted ? `${r.at || '—'} ⚠️中断` : (r.at || '—')}</td>
          <td>${r.total == null ? '—' : r.total}</td>
          <td>${r.dedup == null ? '—' : r.dedup}</td>
          <td>${r.filtered == null ? '—' : r.filtered}</td>
          <td>${r.dryRun != null ? `试跑 ${r.dryRun}` : (r.pushed == null ? '—' : r.pushed)}</td>
          <td>${r.failed == null ? '—' : (r.failed > 0 ? html`<span class="sync-err">${r.failed}</span>` : r.failed)}</td>
          <td class="mono">${r.elapsed || '—'}</td>
          <td class="run-actions">${r.cachesaved === 0 ? html`<span class="run-note">未落盘</span>` : ''}
            <button type="button" class="row-link" disabled=${!r.at}
              aria-busy=${jumpBusy === `${r.at}-${r.lineNo}` ? 'true' : 'false'}
              aria-label=${jumpBusy === `${r.at}-${r.lineNo}` ? '日志加载中' : '查看该日日志'}
              onClick=${() => jumpLog(r)}>${jumpBusy === `${r.at}-${r.lineNo}`
                ? html`<span class="row-spin" aria-hidden="true"></span>`
                : '日志'}</button></td>
        </tr>`)}
      </tbody>
    </table>`
        : html`<div class="empty">${all.length === 0 ? '日志尾窗内没有摘要行' : '没有匹配的轮次'}</div>`}
    </div>`}
    ${filtered.length > 0 && html`<div class="pager">
      <${Button} disabled=${current <= 1 || loading} onClick=${() => goPage(1)}>« 首页<//>
      <${Button} disabled=${current <= 1 || loading} onClick=${() => goPage(current - 1)}>上一页<//>
      <span class="pager-info">第 ${current} / ${pages} 页 · 共 ${filtered.length} 条</span>
      <${Button} disabled=${current >= pages || loading} onClick=${() => goPage(current + 1)}>下一页<//>
      <${Button} disabled=${current >= pages || loading} onClick=${() => goPage(pages)}>末页 »<//>
    </div>`}
  </div>`
}

// ── 组件：整体 ──────────────────────────────────────────────────────────────
// v3.297 标签页：概览（原看板+触发+历史）/ 推送记录 / 运行日志 / 系统。
// 轮询只挂在概览（状态+历史要跟任务跑）；其余标签页进页时拉取 + 手动刷新，
// 不自动轮询——消息/日志读的是磁盘文件，5s 轮询只会白耗磁盘与带宽。

// 加载失败文案：fetch 抛的是英文（Failed to fetch / AbortError），直接甩给用户等于没说。
// 这里只做形态映射，不改错误语义（401 仍由全局事件让 App 停轮询）：
//   5xx → 服务器错误；4xx → 请求被拒绝；网络断/服务没起 → 网络请求失败；超时 → 超时。
// 超时判定在 pure.mjs 的 isTimeoutError（Chrome 的 TimeoutError 文案不含 abort，只认 /abort/ 会漏）。
// 认不出的原样返回——后端自定义错误本来就是中文，不要二次包装。
function loadErrorText (e) {
  const raw = e && typeof e.message === 'string' ? e.message : String(e === undefined || e === null ? '' : e)
  const http = /^HTTP (\d{3})$/.exec(raw)
  if (http) {
    const code = Number(http[1])
    if (code >= 500) return `服务器错误（HTTP ${code}）`
    if (code >= 400) return `请求被拒绝（HTTP ${code}）`
    return `请求失败（HTTP ${code}）`
  }
  if (/Failed to fetch|NetworkError|Load failed|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i.test(raw)) {
    return '网络请求失败（检查网络，或控制台服务是否在运行）'
  }
  if (isTimeoutError(e)) return '请求超时（服务器 8 秒内没有响应）'
  return raw === '' ? '未知错误' : raw
}

// 面板加载器公共骨架：data/err 状态 + load()（成功清错、失败写横幅）。
// apiFn 由调用方用 useCallback/useMemo 固定引用，避免 effect 风暴。
function usePanelLoader (apiFn, onLoaded, initialData = null) {
  // initialData：跳转前已取到的快照（v3.318）。给它就把首帧定稿，挂载后不再立刻重拉。
  const [data, setData] = useState(initialData)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // v3.320：结算代数——每次最新一次 load 收尾（成功或失败）都 +1，与 setLoading(false) 同批。
  // 失败时只写 err、data 保持旧值，调用方只比 data 引用会永远等不到「这次响应落地」；
  // 有了代数就能区分「还没结算」与「结算完但数据没变」，错误路径的旗子才清得掉。
  const [settleTick, setSettleTick] = useState(0)
  const seqRef = useRef(0) // 竞态守卫：只应用「最新一次 load」的响应（审查 Sourcery PR#227）
  const mountedRef = useRef(true) // 卸载后旧请求仍可能回包：不得再写父页时间戳（PR#253）
  useEffect(() => () => { mountedRef.current = false }, [])
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const d = await apiFn()
      if (seq !== seqRef.current || !mountedRef.current) return false // 已有更新的请求或面板已卸载，本次响应作废
      setData(d)
      setErr('')
      if (typeof onLoaded === 'function') onLoaded(Date.now())
      return true
    } catch (e) {
      if (seq !== seqRef.current || !mountedRef.current) return false
      setErr(`加载失败：${loadErrorText(e)}`)
      return false
    } finally {
      if (seq === seqRef.current && mountedRef.current) {
        setSettleTick((t) => t + 1)
        setLoading(false)
      }
    }
  }, [apiFn, onLoaded])
  return { data, err, load, loading, settleTick }
}

// 页签保活 + 首访懒加载：隐藏的页签只挂 DOM、不拉数据——第一次真正点开（active=true）
// 才发第一份请求，之后离开不拉，再切回才补一次（active 由 false 变 true）。
// 首屏停在推送记录页时，不再替概览/系统页预取 /api/trends、/api/run-history、
// /api/access-log、/api/cache-health（旧版「先拉一遍，点开就有」要 17 个请求、71KB）。
// 首帧空白由面板自己的骨架补（见 PanelSkeleton）。
// queue=true 用于日志这种自带互斥的 loader（在飞时排队，而不是丢掉这次刷新）。
function usePanelAutoLoad (active, load, { queue = false } = {}) {
  const seenRef = useRef(null)
  const loadRef = useRef(load)
  const pendingRef = useRef(false)
  const loadedAtRef = useRef(0)
  useEffect(() => {
    const first = seenRef.current === null
    const becameActive = active && seenRef.current === false
    const loadChanged = loadRef.current !== load
    seenRef.current = active
    loadRef.current = load
    // 懒加载：没进过这个页签就不发请求。
    if (!active) return
    if (!first && !becameActive && !loadChanged) return
    // 首次点开时若预加载还在飞、或刚回来不到 3s，直接用手里的/路上的数据，
    // 不再发第二发把预加载响应顶掉（Sourcery #272）。更久才点开则补一次新鲜的。
    if (becameActive && (pendingRef.current || (loadedAtRef.current && Date.now() - loadedAtRef.current < 3000))) return
    if (pendingRef.current && !loadChanged) return
    pendingRef.current = true
    const p = queue ? load(true) : load()
    Promise.resolve(p).then(() => { loadedAtRef.current = Date.now() }).catch(() => {}).finally(() => { pendingRef.current = false })
  }, [active, load, queue])
}

// ── 下拉刷新（v3.330）──────────────────────────────────────────────────────
// Chrome 的原生下拉刷新会整页重载：文档重建 → 首帧必然重新渲染，数据回得越快越像
// 「闪一下」。这里关掉原生手势（CSS overscroll-behavior-y: contain），改成页面内刷新：
// 下拉立即出指示条，松手调各面板的 loader，数据回来一次性换，不重建页面、不回顶。
const PULL_EVENT = 'xbk-pull-refresh'
const PULL_TRIGGER = 56 // 松手阈值（CSS px，手指位移按 0.5 倍阻尼折算）
const PULL_MAX = 84
const PULL_MIN_BUSY_MS = 450 // 再快也让「正在刷新…」停留一下，避免又变成一闪
// 切后台/锁屏/切走 App 时轮询全停（App 的 visibilitychange 处理）：回来时页面里的数据
// 必然是离开那一刻的，而浏览器不会替我们重拉。回前台一律静默补一轮（不显示「正在刷新…」、
// 不重建页面）；只有距上次成功刷新不足这个间隔（刚刷完就切回来）才跳过——来回切窗口
// 不该每次都打一遍接口。
const VISIBLE_REFRESH_GAP_MS = 2000

function usePollReload (active, pollTick, fn) {
  // v3.349：轮询重拉的单飞闸——上一拍还没回来就跳过这一拍。慢接口下每个新请求都会把
  // 上一个响应的 seq 作废（usePanelLoader 的竞态守卫），响应慢过间隔就永远应用不上，
  // 页面看着「在刷新」其实数据不动（Sourcery #303 M3）。
  const fnRef = useRef(fn)
  fnRef.current = fn
  const busyRef = useRef(false)
  // 首访懒加载后，激活本页的第一份数据由 usePanelAutoLoad 负责；这里跳过「active 由
  // false 变 true」那一拍，否则首访会同时打两个请求（面板 load + 轮询拍）。
  const seenActiveRef = useRef(false)
  useEffect(() => {
    const justActivated = active && !seenActiveRef.current
    seenActiveRef.current = active
    if (!active || justActivated || !(pollTick > 0) || busyRef.current) return
    busyRef.current = true
    Promise.resolve()
      .then(() => fnRef.current())
      .catch(() => {})
      .finally(() => { busyRef.current = false })
  }, [pollTick, active])
}

// 面板侧：当前页签激活时订阅全局下拉刷新，把自己的 loader 交给 App 一起等。
// 用 ref 存 loader，避免每次渲染换函数导致反复重订阅。
function usePullRefresh (active, fn) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!active) return undefined
    const onPull = (e) => {
      const p = fnRef.current()
      if (e && e.detail && Array.isArray(e.detail.waits) && p && typeof p.then === 'function') {
        e.detail.waits.push(p)
      }
    }
    window.addEventListener(PULL_EVENT, onPull)
    return () => window.removeEventListener(PULL_EVENT, onPull)
  }, [active])
}

// App 侧：手势状态机。只在页面顶部（scrollY<=0）开始跟踪；竖直位移压 0.5 倍做阻尼。
function usePullToRefresh (onRefresh, enabled = true) {
  const [state, setState] = useState('idle') // idle | pull | ready | busy
  const ref = useRef({ y0: 0, x0: 0, dy: 0, tracking: false, busy: false, lock: false })
  useEffect(() => {
    if (!enabled) return undefined
    const stop = () => { ref.current.tracking = false; ref.current.dy = 0 }
    const idle = () => setState((s) => (s === 'busy' ? s : 'idle'))
    // 手指落在自己滚动的容器里（日志框、列表）时，先让它按原生滚动走；
    // 只有当那个容器已经在顶部，才算「整页下拉」。
    const inScrolled = (touch) => {
      let el = touch && touch.target
      while (el && el !== document.documentElement) {
        if (el.scrollTop > 0 && /(auto|scroll)/.test(window.getComputedStyle(el).overflowY)) return true
        el = el.parentElement
      }
      return false
    }
    const onStart = (e) => {
      const t = e.touches
      if (ref.current.busy || !t || t.length !== 1 || window.scrollY > 0 || inScrolled(t[0])) return
      ref.current.y0 = t[0].clientY
      ref.current.x0 = t[0].clientX
      ref.current.dy = 0
      ref.current.tracking = true
      ref.current.lock = false
    }
    const onMove = (e) => {
      const r = ref.current
      if (!r.tracking || r.busy || r.lock) return
      const t = e.touches
      // 多指按下（缩放/误触）：本次手势作废，松手也不刷新。
      if (!t || t.length !== 1) { r.lock = true; stop(); idle(); return }
      const dy = t[0].clientY - r.y0
      const dx = t[0].clientX - r.x0
      // 横滑、上滑、或已经离开顶部：本次手势不再当下拉，等下一次触摸。
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) { r.lock = true; stop(); idle(); return }
      r.dy = dy
      setState(Math.min(PULL_MAX, dy * 0.5) >= PULL_TRIGGER ? 'ready' : 'pull')
    }
    const onEnd = () => {
      const r = ref.current
      if (!r.tracking) return
      const armed = r.dy * 0.5 >= PULL_TRIGGER
      stop()
      if (!armed) { idle(); return }
      r.busy = true
      setState('busy')
      const t0 = Date.now()
      const settle = (did) => {
        // 当前页没有可刷新的面板（返回 false）：立刻收起，别假装刷了一下。
        const hold = did === false ? 0 : Math.max(0, PULL_MIN_BUSY_MS - (Date.now() - t0))
        setTimeout(() => { r.busy = false; setState('idle') }, hold)
      }
      // 微任务里再开跑：先让 busy 这一帧画出来，再发请求（不然快速响应会直接跳回 idle）。
      Promise.resolve().then(onRefresh).then(settle, () => settle(true))
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    // touchcancel = 手势被打断（来电、系统手势），不是「松手」：只复位，不刷新。
    const onCancel = () => { stop(); idle() }
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [enabled, onRefresh])
  return { state }
}

// v3.331：状态写在顶栏「数据截至」这一行（.sync），不做浮层——浮层会盖住标题，
// 手机上「正在刷新…」正好压在 xbk-push 控制台上。
function PullRefreshStatus ({ state }) {
  const label = state === 'busy' ? '正在刷新…' : state === 'ready' ? '松开刷新' : '下拉刷新'
  return html`<span class=${'ptr-text ' + state} role="status" aria-live="polite">
    <span class="ptr-ring" aria-hidden="true"></span>${label}
  </span>`
}

// 慢加载才亮「更新中…」：本地缓存命中时 loading 只存在十几毫秒（实测 512ms→529ms），
// 文案跟着切两次就是一闪。超过 600ms 还没回来才算真的慢，这时提示才有意义。
function useSlowFlag (on, delay = 600) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!on) { setSlow(false); return undefined }
    const t = setTimeout(() => setSlow(true), delay)
    return () => clearTimeout(t)
  }, [on, delay])
  // 完成当帧 state 还没被 effect 清掉，这里用 on 兜底，否则会多渲染一帧「更新中…」。
  return slow && on
}

// 趋势天数选择器固定选项（与服务端白名单 TREND_DAYS_ALLOWED 对齐；14 为默认省略参数）
const TREND_DAYS = [14, 30, 60]

// 近 14 日趋势（纯 CSS 条形图，零依赖）：一格=一天，高度按当日推送条数归一。
// failed>0 的日子用红色渐变提示；0 推送的日子画灰色基线（看得见「没有数据」≠ 没画）。
function TrendsPanel ({ active = true }) {
  const [days, setDays] = useState(TREND_DAYS[0])
  const [range, setRange] = useState(EMPTY_RANGE)
  const rangeActive = DAY_KEY_RE.test(range.from) && DAY_KEY_RE.test(range.to)
  const fetchTrends = useCallback(
    () => apiGetTrends(rangeActive ? { from: range.from, to: range.to } : { days }),
    [days, rangeActive, range.from, range.to])
  const { data: trends, err, load } = usePanelLoader(fetchTrends)
  // 保活后概览切回来时补拉一次；离开概览不拉。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // 展示口径只认「响应自带的 days」：切窗口后旧响应未替换（请求中/失败）时，
  // 标题与合计必须跟随旧窗口的数据，不能拿着旧数据标新窗口。
  // 区间模式下标题显示实际区间（服务端回显，含被 92 天上限截断后的真实起点）。
  const shownRange = trends && typeof trends.from === 'string' && trends.from !== '' ? `${trends.from} ~ ${trends.to}` : ''
  const shownDays = shownRange !== ''
    ? null
    : (trends && Number.isSafeInteger(trends.days) && TREND_DAYS.includes(trends.days)
        ? trends.days
        : (trends ? null : days)) // 尚无任何响应时才用当前选择器值占位
  const byDay = trends && trends.status === 'ok' ? trends.byDay : []
  const maxPushed = Math.max(1, ...byDay.map((d) => d.pushed))
  const totalAll = byDay.reduce((acc, d) => acc + d.pushed, 0)
  const failAll = byDay.reduce((acc, d) => acc + d.failed, 0)
  // today 由服务端按 Asia/Shanghai 日历日下发（run.log 时间戳口径），浏览器本地时区不再参与
  const todayKey = trends && trends.today ? trends.today : ''
  // 点/键盘选中某天：手机没有 hover，title 提示不可达，点按展开当天明细（评审 #243-4）
  const [selDay, setSelDay] = useState(null)
  const toggleDay = (date) => setSelDay((cur) => (cur === date ? null : date))
  // 横向滚动：默认停在最右侧（最近一天），用户可直接左滑看更早日期
  // 对齐重算的触发指纹（C7-051）：旧依赖只有 byDay.length，等长窗口切换（14 天区间 → 另一段
  // 14 天区间、或 30→60→30 来回切回同样天数）时列集合全换了但 key 没变，内联 paddingRight
  // 停在上一组列算出的值 ⇒ 右端空白累积/最右几列跑出容器。列宽是固定的 34px（.trend-col），
  // 几何只由「列数 + 各自日期」决定，故指纹只取日期序列：条数变化（同一窗口的下一拍轮询）
  // 不该重跑——那会把用户左滑查看的位置强行拽回最右端。
  const alignKey = byDay.map((d) => d.date).join('|')
  const scrollRef = useRef(null)
  // 对齐必须在绘制前完成：切窗口时一组新列在同一个 commit 里换进来，
  // 若放到 useEffect（绘制后）再对齐，会先画出一帧「沿用旧 scrollLeft、指向窗口最早几天」的
  // 空图表，下一帧才跳回最右——手机上看就是趋势模块「闪一下」（v3.315）。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const trend = el.firstElementChild
    if (!trend) return undefined
    let raf = 0
    const align = () => {
      raf = 0
      // 每轮先清掉上一轮补的右 padding：14→30→60 来回切时它会累加成大块空白。
      trend.style.paddingRight = ''
      el.scrollLeft = el.scrollWidth
      // 最右停靠时最左列可能只露半截：把下一个完整列的左缘对齐到容器左缘，
      // 不够的滚动量用右 padding 补出来（只在自动停靠时做，用户手动滑动不干预）。
      // 注意基准是滚动容器的左缘（面板有内边距，视口 x=0 不是容器左缘）。
      const base = el.getBoundingClientRect().left
      const cols = [...trend.children]
      const partial = cols.find((c) => {
        const r = c.getBoundingClientRect()
        return r.left < base && r.right > base
      })
      if (!partial) return
      const next = cols[cols.indexOf(partial) + 1]
      if (!next) return
      const shift = next.getBoundingClientRect().left - base
      if (shift <= 0) return
      const max = el.scrollWidth - el.clientWidth
      const need = el.scrollLeft + shift - max
      if (need > 0) {
        const pad = parseFloat(window.getComputedStyle(trend).paddingRight) || 0
        trend.style.paddingRight = `${Math.ceil(pad + need)}px`
      }
      el.scrollLeft += shift
    }
    const schedule = () => { if (raf === 0) raf = window.requestAnimationFrame(align) }
    align()
    // 容器宽度变化（横竖屏、窗口缩放）时列集合固定，也必须重新对齐；
    // 否则会保留旧 padding/滚动位置，最右几列又跑出容器（Sourcery #254）。
    let ro = null
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(schedule)
      ro.observe(el)
    } else {
      window.addEventListener('resize', schedule)
    }
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf)
      if (ro !== null) ro.disconnect()
      else window.removeEventListener('resize', schedule)
    }
  }, [alignKey])
  return html`<div class="panel">
    <${PanelHead} title=${shownRange ? `运行趋势（${shownRange}）` : (shownDays ? `近 ${shownDays} 日运行趋势` : '运行趋势')}
      afterTitle=${html`<div class="toolbar">
        <${MiniSelect} value=${rangeActive ? '__range' : String(days)} ariaLabel="趋势窗口天数"
          options=${[
            ...(rangeActive ? [{ value: '__range', label: '自定义区间' }] : []),
            ...TREND_DAYS.map((d) => ({ value: String(d), label: `${d} 日` }))
          ]}
          onChange=${(v) => { if (v === '__range') return; setRange(EMPTY_RANGE); setDays(Number(v)) }} />
        ${active && html`<${DateRange} value=${range} label="趋势日期区间"
          onChange=${(r) => setRange(r)} />`}
      </div>`}
      sub=${'run.log 摘要按日聚合' + (trends && trends.truncated ? '（日志超限，仅统计尾部 1 MiB）' : '')}
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${trends && trends.status !== 'ok' && html`<div class="empty">日志${trends.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${trends.status}）`}</div>`}
    ${trends && trends.status === 'ok' && html`<div>
      <div class="trend-scroll" ref=${scrollRef}>
        <div class="trend">
          ${byDay.map((d) => html`<div class="trend-col" key=${d.date} role="button" tabindex="0"
            aria-label=${`${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}`}
            title=${`${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}`}
            onClick=${() => toggleDay(d.date)}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(d.date) } }}>
            <span class="trend-n">${d.pushed > 0 ? d.pushed : ''}</span>
            <div class=${'trend-bar' + (d.pushed === 0 ? ' zero' : '') + (d.failed > 0 ? ' fail' : '')} style=${`height:${Math.max(3, Math.round(d.pushed / maxPushed * 88))}px`}></div>
            <span class=${'trend-day' + (d.date === todayKey ? ' today' : '')}>${d.date.slice(5)}</span>
          </div>`)}
        </div>
      </div>
      ${selDay && (() => {
        const d = byDay.find((x) => x.date === selDay)
        return d ? html`<div class="trend-detail">${d.date}：轮次 ${d.rounds} · 抓取 ${d.total} · 推送 ${d.pushed} · 失败 ${d.failed}</div>` : ''
      })()}
      <div class="trend-meta">${shownDays || ''} 日共推送 ${totalAll} 条 · 失败 ${failAll} 条${failAll > 0 ? ' · 红柱=当日有失败' : ''} · 左右滑动查看更早日期，点柱子看每日明细</div>
    </div>`}
  </div>`
}

// 缓存健康（v3.298）：判重缓存字节占用对照两级上限 + 墓碑计数。纯只读快照，
// 进概览页拉一次 + 手动刷新，不进 5s 主轮询（墓碑解析最坏 8MiB，不与状态轮询抢盘）。
// 条数维度：服务端在响应里附带 entryCount（readMessageCount，与 /api/messages 同一
// 读取封顶与防御；tooLarge 时 null 如实显示），对照 limits.entryMax 预警。
function CacheHealthPanel ({ paused = false, active = true }) {
  const { data, err, load } = usePanelLoader(apiGetCacheHealth)
  // 右列状态文件（v3.307）：缓存健康面板原来只占左半 451px，右边 460px 空白；
  // 系统页的「缓存目录文件」在这里给一份紧凑版（前 8 项），整页仍保留全量清单。
  const filesLoader = usePanelLoader(apiGetFiles)
  // 懒加载：概览页没点开过就不打 /api/cache-health 与 /api/files（首屏在别的页签时
  // 这两条纯属浪费；60s 定时器与切回补拉仍在 active 后继续工作）。
  const seededRef = useRef(false)
  const justSeededRef = useRef(false)
  useEffect(() => {
    if (!active || seededRef.current) return
    seededRef.current = true
    justSeededRef.current = true
    load().catch(() => {})
    filesLoader.load().catch(() => {})
  }, [active, load, filesLoader.load])
  // 缓存健康随概览常开：每分钟（且切回前台时）重拉一次，避免「页面开着过夜、mtime 早已更新
  // 但面板还拿着旧快照」；1 分钟一次只读小 JSON，不与 5s 主轮询抢盘。
  const wasPausedRef = useRef(paused)
  useEffect(() => {
    const wasPaused = wasPausedRef.current
    wasPausedRef.current = paused
    if (paused) return undefined
    // 从暂停/隐藏状态回到概览时先补一拍（首帧由上面的 mount effect 拉，不重复）。
    // 右列文件清单也要一起补，否则左列新鲜、右列还是几小时前的快照。
    if (wasPaused) {
      // 首访这一拍 mount effect 刚拉过（active false→true 同一次提交里），别再补一发（Sourcery #315-10）。
      if (justSeededRef.current) justSeededRef.current = false
      else {
        load().catch(() => {})
        filesLoader.load().catch(() => {})
      }
    }
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      // C7-043：右列文件清单必须跟左列同一拍刷新。旧实现只调 load()，两列从此各自新鲜度
      // 不同步——页面开着过夜时左列 mtime 在走、右列还停在首次快照（files 数组与大小都过期）。
      // /api/files 与文件清单页共用 once('files') 的在飞去重，不会和那边的请求叠发。
      load().catch(() => {})
      filesLoader.load().catch(() => {})
    }, 60000)
    // 切回前台不再自己补拉：App 的「回前台补拉」（VISIBLE_STALE_MS）会经下拉事件
    // 通知当前页签的面板，这里再挂一个就会被拉两次（Sourcery PR #300）。
    return () => clearInterval(t)
  }, [load, paused, filesLoader.load])
  // 下拉刷新：健康面板与右列文件清单一起重拉（两者都返回 promise）。
  // 认 active 不认 paused：暂停自动刷新时手动下拉照样要能刷。
  usePullRefresh(active, () => Promise.allSettled([load(), filesLoader.load()]))
  const ok = data && data.status === 'ok'
  const ratioText = ok && data.writeRatio != null ? `${(data.writeRatio * 100).toFixed(1)}%` : '—'
  const tomb = data && data.tombstone ? data.tombstone : null
  // 最近写入：显示相对时间；超过 24 小时只陈述事实（不推断链路断没断——调度暂停同样会这样）。
  const write = ok ? cacheWriteInfo(data.mtimeMs) : { ageText: '', stale: false }
  // 控制台可读：长解释收进 title，首屏只留结论。上限取服务端下发的
  // limits.consoleReadMaxBytes（此前写死 32 MiB，服务端调到 64 MiB 后文案说谎）。
  const readCap = ok && data.limits && typeof data.limits.consoleReadMaxBytes === 'number'
    ? fmtBytes(data.limits.consoleReadMaxBytes)
    : '控制台读取上限'
  const readableText = data && data.consoleReadable
    ? `是（未超 ${readCap} 读取封顶）`
    : `否——超过 ${readCap} 读取封顶，推送记录页显示「过大不可读」（生产不受影响）`
  const readableTitle = '超限与否以推送记录页实际显示为准；JSON 损坏时该页会显示「记录不可读」'
  // 条数预警：服务端在 cache-health 响应里附带 entryCount（/api/status 同源的
  // readMessageCount；tooLarge 时 null）对照写端条目上限；接近上限时下轮保存
  // 会裁最旧条目（与字节裁剪同一出口）。
  const entryNear = ok && typeof data.entryCount === 'number' && data.entryCount >= data.limits.entryMax * 0.8
  const entryOver = ok && typeof data.entryCount === 'number' && data.entryCount >= data.limits.entryMax
  const files = filesLoader.data && Array.isArray(filesLoader.data.files) ? filesLoader.data.files : []
  return html`<div class="panel">
    <${PanelHead} title="缓存健康" sub=${(data && data.file ? data.file : 'push.json') + ' · 判重缓存占用'}
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && !ok && html`<div class="empty">${data.status === 'missing' ? '缓存尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}</div>`}
    ${ok && html`<div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>缓存大小</td><td>${fmtBytes(data.bytes)}（上限 ${fmtBytes(data.limits.writeMaxBytes)}）</td></tr>
        <tr><td>占用比例</td><td>${ratioText}${data.nearTrim ? ' · ⚠️ 临近字节裁剪' : ''}${data.overLimit ? ' · ⛔ 已超写端上限' : ''}</td></tr>
        <tr><td>条目数</td><td>${ok && typeof data.entryCount === 'number' ? `${data.entryCount} / ${data.limits.entryMax} 条上限${entryOver ? ' · ⛔ 已达上限，旧记录将被裁剪' : entryNear ? ' · ⚠️ 临近条目上限' : ''}` : `上限 ${data.limits.entryMax} 条${ok && data.entryCountStatus === 'tooLarge' ? '（当前条数不可得：缓存超控制台读取封顶）' : '（进推送记录页获取当前条数）'}`}</td></tr>
        <tr><td>控制台可读</td><td title=${readableTitle}>${readableText}</td></tr>
      </tbody></table>
      <div class="cache-side">
      <table class="sys-table"><tbody>
        <tr><td>墓碑状态</td><td>${tomb ? (tomb.status === 'ok' ? '正常' : tomb.status === 'missing' ? '尚未生成（未发生过裁剪时正常）' : `异常（${tomb.status}）`) : '—'}${tomb && tomb.status === 'ok' ? ` · ${tomb.counts.total} 键` : ''}</td></tr>
        <tr><td>最近写入</td><td>${data.mtimeMs ? `${fmtTime(data.mtimeMs)}${write.ageText ? ` · ${write.ageText}` : ''}` : '—'}${write.stale ? ' · 超过 24 小时未写入缓存' : ''}</td></tr>
      </tbody></table>
      <div class="cache-files">
        <div class="cache-files-head"><span>状态目录文件</span><button type="button" class="row-link" onClick=${filesLoader.load}>刷新</button></div>
        ${files.length === 0
          ? html`<div class="cache-files-empty">${filesLoader.err ? '文件清单加载失败' : '暂无文件'}</div>`
          : html`<table class="sys-table compact"><tbody>
            ${files.slice(0, 8).map((f) => html`<tr key=${f.name}>
              <td class="mono">${f.name}</td>
              <td>${f.kind === 'file' ? fmtBytes(f.bytes) : f.kind === 'symlink' ? '⚠️ 符号链接' : f.kind}</td>
            </tr>`)}
          </tbody></table>`}
      </div>
      </div>
    </div>`}
    ${ok && (data.nearTrim || data.overLimit || !data.consoleReadable) && html`<${Hint} style="margin-top:10px">占用达到写端上限 80% 时，下一轮保存会自动裁掉最旧条目并落墓碑——无需人工干预，但如果你希望保留更久，检查推送频率与 maxPerRun 配置。<//>`}
  </div>`
}

// 推送记录：搜索（300ms 防抖）+ 分类筛选 + 服务端分页；点标题在右侧抽屉看全文（v3.379）。
// URL 不含 content_html（服务端已裁剪）——CSP 禁外链图，贴文本才是控制台能诚实渲染的形态。
// 原文链接：相对路径拼服务端下发的 baseUrl（= 生产 Config.domain，与推送侧 resolve 同口径），
// 绝对 URL 原样；只放行 http/https（其他 scheme 不渲染链接）。
function msgHref (u, base) {
  if (u.startsWith('http://') || u.startsWith('https://')) return u
  if (u.startsWith('//')) return `https:${u}`
  const b = typeof base === 'string' && base.length > 0 ? base : 'https://new.ixbk.net'
  return `${b}${u.startsWith('/') ? u : '/' + u}`
}

function msgLink (m, base) {
  if (!(typeof m.url === 'string' && m.url.length > 0)) return ''
  const title = m.url.startsWith('http') ? `外部链接（来源站点）：${m.url}` : '外部链接（来源站点）'
  return html`<a class="msg-link" href=${msgHref(m.url, base)}
    target="_blank" rel="noopener noreferrer"
    title=${title}>原文链接 ↗</a>`
}

// 分类名是「来源-品类-平台」的三段式（如 好单线报-日用-京东）；按 '-' 建树，
// 弹层里逐级下钻，而不是把 83 个全名平铺给用户。
function buildCateTree (categories) {
  const root = { name: '', path: [], children: new Map(), count: 0, total: 0, full: '' }
  for (const c of categories) {
    if (!c || typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 300) continue
    // 按原始 '-' 段建树（不 trim/去空，避免 A-B 与 A- B 被合并）；最多 6 级，
    // 防上游塞超深分类名把渲染递归打爆。full 仍保留原始全名，筛选口径不变。
    const parts = c.name.split('-').slice(0, 6)
    if (parts.length === 0) continue
    let node = root
    for (const p of parts) {
      if (!node.children.has(p)) node.children.set(p, { name: p, path: [...node.path, p], children: new Map(), count: 0, total: 0, full: '' })
      node = node.children.get(p)
    }
    node.count += Number(c.count) || 0
    node.full = c.name
  }
  const sum = (n) => {
    let t = n.count
    for (const ch of n.children.values()) t += sum(ch)
    n.total = t
    return t
  }
  sum(root)
  return root
}
function flatCateLeaves (node, out = []) {
  for (const ch of node.children.values()) {
    if (ch.full) out.push({ name: ch.full, label: ch.path.map((s) => s.trim() || '（空）').join(' › '), count: ch.count })
    if (ch.children.size > 0) flatCateLeaves(ch, out)
  }
  return out
}

// 分类筛选：自定义弹层而不是原生 <select>。
// Android 上原生 select 会弹出全屏白底系统列表（80+ 分类、无搜索、与暗色控制台割裂），
// 这里改为暗色下拉 + 搜索，手机端贴底弹出，选中项打勾。
// 弹层高度上限：搜索框 + 面包屑 + .cate-list(300) + 脚注，旧实现写死 380。
const CATE_MAX_H = 380
function CategoryPicker ({ value, categories, total, onChange, pageActive = true }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [path, setPath] = useState([])
  const [active, setActive] = useState(0)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  // ready=false 时弹层先 visibility:hidden（.cate-pop-wait）：桌面首帧坐标还没算出来，
  // 不能先按「向下」铺一帧再翻上去。窄屏是 CSS 贴底模态，不用量测，直接可见。
  const [ready, setReady] = useState(false)
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const searchRef = useRef(null)
  const listRef = useRef(null)
  // 位置只由 computePosition 算（同 MiniSelect）：left/top 直写 DOM，不走 vdom 的 style
  // 属性——轮询每 500ms 重渲染一次，字符串 style 会把刚算好的坐标整条覆盖。方向（翻上/
  // 翻下）、视口夹取与高度上限都交给中间件，组件里不再自己量 below/above（也就没有迟滞）。
  const position = useCallback(() => {
    const btn = btnRef.current
    const pop = popRef.current
    if (!btn || !pop) return
    computePosition(btn, pop, {
      strategy: 'fixed',
      // 左缘对齐按钮（旧实现 left:0 的等价形）；flip() 翻上去时仍左缘对齐。
      placement: 'bottom-start',
      middleware: [
        offset(8),
        flip(),
        shift({ padding: 8 }),
        size({
          apply ({ availableHeight, elements }) {
            // 下限只保 1px：可用空间不足时写死更大的下限会把弹层顶出视口。
            const max = Math.max(1, Math.min(CATE_MAX_H, Math.round(availableHeight)))
            elements.floating.style.maxHeight = `${max}px`
          }
        })
      ]
    }).then(({ x, y }) => {
      if (!popRef.current) return
      placeAt(popRef.current, x, y)
      setReady(true)
    }).catch(() => {}) // 定位失败就保持原位，不打断交互（computePosition 不会 reject，兜底而已）
  }, [])
  // 打开/断点切换/滚动/缩放都重新定位（库不自带 autoUpdate，监听留在组件里；rAF 合并同帧）。
  // 必须 useLayoutEffect：坐标要赶在首帧绘制前写进 DOM，否则会先看到未定位的弹层。
  // 窄屏走 CSS 贴底模态（app.css 的 ≤640 媒体查询覆写 .cate-pop）：不量测，并把上一轮
  // 桌面写下的内联 left/top/max-height 清掉——内联值会压过媒体查询，模态会被拽到别处。
  useLayoutEffect(() => {
    if (!open) return undefined
    const pop = popRef.current
    if (narrow) {
      if (pop) {
        pop.style.left = ''
        pop.style.top = ''
        pop.style.maxHeight = ''
      }
      setReady(true)
      return undefined
    }
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => { raf = 0; position() })
    }
    position()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [open, narrow, position])
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // 每次打开都从一级分类开始；搜索词、高亮项与列表滚动一并清空（审查 #246 可选：
  // 手机端重开弹层时不能停在上次的 active 下标/滚动位置，否则容易误下钻）。
  useEffect(() => {
    if (open) {
      setPath([]); setQ(''); setActive(0)
      if (listRef.current) listRef.current.scrollTop = 0
    }
  }, [open])
  // 手机端是贴底模态弹层：锁住背景页滚动（审查 #245），否则手指滑弹层会把背后的
  // 推送记录/页面一起带动。只在本组件打开且窄屏时接管，关闭时还原原值。
  useEffect(() => {
    if (!open || !narrow) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open, narrow])
  // 页签保活后弹层不会随卸载自动关：切走时必须主动收起，否则 body 的 overflow:hidden
  // 会留在新页面上，整页滚不动（Sourcery #271）。
  useEffect(() => {
    if (!pageActive && open) setOpen(false)
  }, [pageActive, open])
  // 打开时：桌面把焦点放进搜索框；手机聚焦当前选项（不弹软键盘）。
  // 依赖 ready：桌面首帧弹层是 visibility:hidden（等坐标），此时 focus 会被忽略；
  // ready 翻真、弹层可见后再跑一次，否则首次打开焦点进不了搜索框。
  useEffect(() => {
    if (!open) return undefined
    if (narrow) {
      // 打开时 path 会在同一提交里重置为空；立刻 query 会聚焦到上一级即将被移除的节点，
      // 重置渲染后焦点就丢了。延后一拍，等新一级列表渲染完再聚焦（与 focusFirst 同口径）。
      const t = setTimeout(() => {
        const el = listRef.current && listRef.current.querySelector('.cate-opt[tabindex="0"]')
        if (el) scrollIntoBox(el, listRef.current)
      }, 0)
      return () => clearTimeout(t)
    }
    if (searchRef.current) searchRef.current.focus({ preventScroll: true })
    return undefined
  }, [open, narrow, ready])
  // 搜索词/层级变化后回到第一项，避免 active 指向已被过滤掉的项。
  useEffect(() => { setActive(0) }, [q, path])
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!rootRef.current || !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        if (btnRef.current) btnRef.current.focus({ preventScroll: true })
        return
      }
      // 手机端是带遮罩的模态弹层：Tab 在弹层内循环，不跑到背后的工具栏。
      if (e.key === 'Tab' && narrow && popRef.current) {
        const f = [...popRef.current.querySelectorAll('button, input')].filter((el) => !el.disabled && el.tabIndex !== -1)
        if (f.length === 0) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); scrollIntoBox(last, popRef.current) } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); scrollIntoBox(first, popRef.current) }
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, narrow])
  const current = categories.find((c) => c.name === value)
  const label = value === '' ? '全部分类' : `${value}${current ? `（${current.count}）` : ''}`
  // 80+ 分类建树有成本，输入/滚动重渲染时不该重做：tree 只随 categories 变。
  const tree = useMemo(() => buildCateTree(categories), [categories])
  // 当前层节点、搜索词、命中项、层级与最终选项都由 tree/path/q/total/value 派生，
  // 一次 useMemo 收口：搜索时的整树摊平与 80+ 选项对象只在输入/下钻/选中变化时重建，
  // 滚动定位这类无关重渲染直接复用同一份数组。
  const view = useMemo(() => {
    let node = tree
    for (const p of path) node = node.children.get(p) || node
    const kw = q.trim().toLowerCase()
    const leaves = kw === '' ? [] : flatCateLeaves(tree)
    const results = kw === '' ? [] : leaves.filter((l) => l.label.toLowerCase().includes(kw) || l.name.toLowerCase().includes(kw))
    const level = [...node.children.values()].sort((a, b) => b.total - a.total)
    // 分类名同时是叶子与父节点时（如 A-B 与 A-B-C 并存），父级此前只能下钻、永远选不到
    // A-B 本身（审查 #246 可选）。下钻后补一条「本级」选项，既能选自己也能继续下钻。
    const selfOption = path.length > 0 && node.full
      ? [{ key: '__self', label: `${node.name}（本级）`, count: node.count, leaf: true, name: node.full }]
      : []
    const options = kw === ''
      ? [...(path.length === 0 ? [{ key: '__all', label: '全部分类', count: typeof total === 'number' ? total : tree.total, leaf: true, name: '' }] : []),
          ...selfOption,
          ...level.map((n) => ({ key: n.path.join('-'), label: n.name, count: n.total, leaf: n.children.size === 0, name: n.full, node: n }))]
      : results.map((l) => ({ key: l.name, label: l.label, count: l.count, leaf: true, name: l.name }))
    // 选中态与 options 同源：行上的 active 类、aria-selected、✓ 都读 sel，不再各算一遍。
    for (const o of options) o.sel = o.leaf && value === o.name
    return { node, kw, results, level, options }
  }, [tree, path, q, total, value])
  const { node, kw, results, level, options } = view
  const focusFirst = () => {
    setTimeout(() => {
      const el = listRef.current && listRef.current.querySelector('.cate-opt[tabindex="0"]')
      if (el) scrollIntoBox(el, listRef.current)
    }, 0)
  }
  const choose = (name) => {
    // 值守卫（同 MiniSelect）：点中的就是当前分类时不回调，避免一次无意义的筛选重拉。
    if (name !== value) onChange(name)
    setOpen(false)
    setQ('')
    if (btnRef.current) btnRef.current.focus({ preventScroll: true })
  }
  const pick = (o) => {
    if (!o.leaf) {
      setPath(o.node.path)
      setQ('')
      setActive(0)
      // 下钻后把焦点放到新一级第一项：键盘 Enter 不会掉到 body 上。
      focusFirst()
      return
    }
    choose(o.name)
  }
  const go = (nextPath) => {
    setPath(nextPath)
    setQ('')
    setActive(0)
    // 面包屑/「‹ 上一级」会重渲染掉当前按钮，焦点必须搬回列表（审查 #246：
    // 否则返回上层后焦点掉到 body，键盘下钻中断）。
    focusFirst()
  }
  const dismiss = () => {
    setOpen(false)
    setQ('')
    if (btnRef.current) btnRef.current.focus({ preventScroll: true })
  }
  const onListKey = (e) => {
    const opts = listRef.current ? [...listRef.current.querySelectorAll('.cate-opt')] : []
    if (opts.length === 0) return
    const inSearch = e.target === searchRef.current
    // 搜索框里的 Home/End 是文本光标操作，不能被列表导航劫持（审查 #245：
    // 此前光标无法到词首/词尾）。上下键仍可从搜索框进入列表。
    if (inSearch && (e.key === 'Home' || e.key === 'End')) return
    // 搜索框按 Enter 直接选中当前高亮项（审查 #245 可选：此前必须先 ↓ 再 Enter）。
    if (inSearch && e.key === 'Enter') {
      const target = opts[Math.min(active, opts.length - 1)]
      if (target) { e.preventDefault(); target.click() }
      return
    }
    const i = opts.indexOf(document.activeElement)
    let next = -1
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(opts.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = i < 0 ? 0 : Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = opts.length - 1
    if (next >= 0) {
      e.preventDefault()
      setActive(next)
      scrollIntoBox(opts[next], listRef.current)
    }
  }
  // 重开时必须把 ready 归零：上次打开残留 true 会让弹层先按未定位的坐标可见一帧
  // （关闭时坐标还是上一轮的，页签保活/滚动后早就过期）。
  const toggle = () => {
    if (open) { setOpen(false); return }
    setReady(false)
    setOpen(true)
  }
  return html`<div class="cate-picker" ref=${rootRef}>
    <button type="button" class="cate-btn" ref=${btnRef} aria-haspopup="dialog"
      aria-expanded=${open ? 'true' : 'false'} onClick=${toggle}>
      <span class="cate-btn-label">${label}</span><span class="cate-caret" aria-hidden="true">▾</span>
    </button>
    ${open && html`<div class="cate-backdrop" aria-hidden="true" onClick=${dismiss}></div>
      <div class=${'cate-pop' + (ready ? '' : ' cate-pop-wait')} ref=${popRef} role="dialog"
        aria-modal=${narrow ? 'true' : 'false'} aria-label="分类筛选">
        <input class="cate-search" ref=${searchRef} type="search" placeholder="搜索全部分类…"
          value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onListKey} />
        ${kw === ''
          ? html`<div class="cate-crumb">
            ${path.length > 0 && html`<button type="button" class="cate-back" aria-label="上一级"
              onClick=${() => go(path.slice(0, -1))}>‹</button>`}
            <button type="button" class="cate-crumb-link" onClick=${() => go([])}>全部分类</button>
            ${path.map((p, i) => html`<span class="cate-crumb-sep">›</span>
              <button type="button" class="cate-crumb-link" onClick=${() => go(path.slice(0, i + 1))}>${p}</button>`)}
          </div>`
          : html`<div class="cate-crumb"><span class="cate-crumb-cur">搜索“${q.trim()}”</span></div>`}
        <div class="cate-list" ref=${listRef} role="listbox" aria-label="分类" onKeyDown=${onListKey}>
          ${options.map((o, i) => html`<button type="button" key=${o.key}
            class=${'cate-opt' + (o.leaf ? '' : ' group') + (o.sel ? ' active' : '')}
            role="option" aria-selected=${o.sel ? 'true' : 'false'}
            tabIndex=${i === active ? 0 : -1} onFocus=${() => setActive(i)}
            title=${o.label} onClick=${() => pick(o)}>
            <span class="cate-opt-name">${o.label}</span>
            <span class="cate-count">${o.count}</span>
            <span class="cate-check">${o.leaf ? (o.sel ? '✓' : '') : '›'}</span>
          </button>`)}
        </div>
        ${options.length === 0 && html`<div class="cate-empty">没有匹配的分类</div>`}
        <div class="cate-foot">${kw === ''
          ? (path.length === 0
              ? `${level.length + 1} 个一级分类${typeof total === 'number' ? ` · ${total} 条` : ''} · 逐级选择`
              : `${path[path.length - 1]}：${level.length} 项 · ${node.total} 条 · ${level.some((n) => n.children.size === 0) ? '点选筛选' : '逐级选择'}`)
          : `${results.length} 个匹配分类 · 点选即筛选`}</div>
      </div>`}
  </div>`
}

// v3.328：单条记录最多标 200 处命中。超长正文里同一关键词可能重复上千次，每个命中一个
// <mark> 会把「展开」卡住几秒；日志页超过 3000 行直接关高亮是同一思路（渲染上限，不改搜索口径）。
const MSG_HIT_MAX = 200

// v3.358：标题末尾常自带价格（「… 32.3元」），右侧再画一个 .msg-price 就是同一条记录两个价。
// 只认标题末尾的「数字 + 元」，且数值与 m.price 完全相等才隐藏；「32.3元起」「32.3元包邮」这类
// 尾部不是纯价格的不算（不做模糊匹配，避免把两个不同的数吞掉一个）。不匹配一律照常显示。
const TITLE_TAIL_PRICE_RE = /(\d+(?:\.\d+)?)\s*元\s*$/
function titleTailPrice (title) {
  if (typeof title !== 'string') return null
  const m = TITLE_TAIL_PRICE_RE.exec(title)
  return m ? Number(m[1]) : null
}

// 分类三段显示（L2-7）：服务端 catename 是「一级-二级-三级」整串（例：好单线报-娱乐-淘宝），
// 整串一字排开看不出层级。按 '-' 拆成每段一个 span.msg-cate-part（段间分隔/间距由 CSS 负责，
// 见 L5），可访问名保留原始整串，读屏不会只听到三段碎片。
function cateParts (name) {
  if (typeof name !== 'string' || name === '') return []
  return name.split('-').filter((part) => part !== '')
}

// 筛选状态 ↔ URL（L2-8）：刷新、收藏、分享都要带着条件回来，所以 q/cate/page/size/days/from/to
// 同步进 hash query（例：#/messages?q=耳机&page=3）。只写 hash、只认白名单值：非法/越界参数
// 一律退回默认，不在 URL 里留脏值。默认值（page=1 / size=20 / days=0）不写，链接保持短。
const MSG_SIZES = [10, 20, 50, 100]
const MSG_DAYS = [0, 1, 3, 7, 30]

// 服务端页码上限（MESSAGES_PAGE_MAX=10000）：超出的页码服务端会静默钳到 10000，前端若不钳，
// 地址栏/跳页停在 12000 时会一直显示第 10000 页却自称 12000（Sourcery #315-1）。
const MSG_PAGE_MAX = 10000

// 形状对 ≠ 是真日期：2026-02-31 / 2026-13-01 都能过 DAY_KEY_RE，而服务端会判非法区间并返回
// 未过滤结果——URL 就成了「看起来筛了、其实没筛」（Sourcery #315-2）。按 Date 回读校验。
function isValidDayKey (s) {
  if (typeof s !== 'string' || !DAY_KEY_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function parseMessagesHash (hash) {
  const out = { q: '', cate: '', page: 1, size: 20, days: 0, from: '', to: '' }
  const raw = typeof hash === 'string' ? hash : ''
  const at = raw.indexOf('?')
  if (at < 0 || !/^#\/messages\b/.test(raw.slice(0, at))) return out
  const params = new URLSearchParams(raw.slice(at + 1))
  const q = params.get('q')
  if (typeof q === 'string' && q.trim() !== '') out.q = q.trim()
  const cate = params.get('cate')
  if (typeof cate === 'string' && cate !== '') out.cate = cate
  const page = Number(params.get('page'))
  if (Number.isSafeInteger(page) && page >= 1) out.page = Math.min(page, MSG_PAGE_MAX)
  const size = Number(params.get('size'))
  if (MSG_SIZES.includes(size)) out.size = size
  const from = params.get('from')
  const to = params.get('to')
  if (isValidDayKey(from) && isValidDayKey(to) && from <= to) {
    // 自定义区间优先于「近 N 天」：两者同时出现时以区间为准（与工具栏语义一致）。
    out.from = from
    out.to = to
    out.days = 0
  } else {
    const days = Number(params.get('days'))
    if (MSG_DAYS.includes(days)) out.days = days
  }
  return out
}

function sameMsgFilters (a, b) {
  return a.q === b.q && a.cate === b.cate && a.page === b.page && a.size === b.size &&
    a.days === b.days && a.from === b.from && a.to === b.to
}

function buildMessagesHash (state) {
  const p = new URLSearchParams()
  if (state.q) p.set('q', state.q)
  if (state.cate) p.set('cate', state.cate)
  if (Number.isSafeInteger(state.page) && state.page > 1) p.set('page', String(state.page))
  if (MSG_SIZES.includes(state.size) && state.size !== 20) p.set('size', String(state.size))
  if (state.from && state.to) {
    p.set('from', state.from)
    p.set('to', state.to)
  } else if (MSG_DAYS.includes(state.days) && state.days !== 0) {
    p.set('days', String(state.days))
  }
  const qs = p.toString()
  return qs === '' ? '#/messages' : `#/messages?${qs}`
}

// ── 推送记录：条目详情抽屉（v3.379）────────────────────────────────────────
// 行内展开会把下面的条目顶走：读一条正文，列表就换了位置，想接着看下一条还得重新找。
// 改成右侧抽屉后列表原地不动（滚动位置不跳），抽屉宽度 520 与列表并排做对照。
// 抽屉里只有「标签 + 值」的行，布局走最小内联样式——键值表只在抽屉里出现一次，
// 故不复用列表卡片的 .msg-meta（那是横向 pill 行，不是键值表）。
function DetailRow ({ label, children }) {
  return html`<div style=${{ display: 'flex', gap: '10px', alignItems: 'baseline', marginTop: '8px' }}>
    <span style=${{ flex: 'none', width: '4.5em', color: 'var(--text-dim)', fontSize: 'var(--fs-xs)' }}>${label}</span>
    <span style=${{ flex: '1 1 auto', minWidth: '0', overflowWrap: 'anywhere', fontSize: 'var(--fs-sm)' }}>${children}</span>
  </div>`
}

// 详情里的时间：datetime + shorttime 拼接（与列表同口径），空值不占位。
function msgTimeText (m) {
  const parts = [m.datetime, m.shorttime].filter((s) => typeof s === 'string' && s !== '')
  return parts.length > 0 ? parts.join(' ') : '（无时间）'
}

// 来源渠道 = 分类三段式（来源-品类-平台）的第一段；单段分类时整串就是来源。
function msgSourceOf (name) {
  const parts = cateParts(name)
  return parts.length > 0 ? parts[0] : ''
}

function MessagesPanel ({ onSync, active = true, pollTick = 0 }) {
  // 首帧从 hash query 还原筛选（L2-8）：只解析一次，之后 state 是唯一真相。
  const [boot] = useState(() => parseMessagesHash(window.location.hash))
  const [page, setPage] = useState(boot.page)
  const [size, setSize] = useState(boot.size)
  // v3.358：跳页输入（受控，'' = 没输入）。只在 Enter/失焦时生效，不随每次按键换页。
  const [jump, setJump] = useState('')
  const [cate, setCate] = useState(boot.cate)
  const [days, setDays] = useState(boot.days)
  // 自定义日期区间（v3.326）：两项都非空才生效，否则退回「近 N 天」。
  const [range, setRange] = useState({ from: boot.from, to: boot.to })
  const rangeActive = range.from !== '' && range.to !== ''
  const [input, setInput] = useState(boot.q)
  const [query, setQuery] = useState(boot.q)
  // v3.379：详情改右侧抽屉。detail 存「打开那一刻的条目快照」而不是 rowKey——
  // 抽屉开着时轮询/换页会换掉整页 items，按 rowKey 反查会让正在读的正文当场消失。
  const [detail, setDetail] = useState(null)
  // 关闭后把焦点还给触发的按钮（列表重渲染后旧节点可能已卸载，isConnected 兜底）。
  const detailBtnRef = useRef(null)
  // 响应归属（问题5）：请求发出时记下的 query 会在 in-flight 期间过期——旧响应的
  // queryUsed 会把刚打的新词清空（搜索吞字）。改为：loadSeqRef 给每次请求领号，
  // loadedQueryRef 只在「最新一次请求」回包时记录它对应的 query。
  const loadedQueryRef = useRef('')
  const loadSeqRef = useRef(0)
  // v3.320：列表落点（见 listLandTarget）。listRef 指列表外层容器，landRef 只由用户
  // 主动改页/改每页/改分类/改时间/搜索词落地时置位；queryRef 供防抖里判断词真变了。
  const listRef = useRef(null)
  const landRef = useRef(false)
  // 置旗那一刻的 data：服务端分页要等「这次请求的响应」落地才落点，不能拿旧页的
  // 高度先滚一次（新页更短时浏览器还会二次夹取）。data 引用变了才算落地。
  // 失败时 data 引用不变，故同时记「结算代数」：load 收尾（成功或失败）才 +1，
  // 代数没前进就是响应还没来——旗子必须留着，不能拿旧数据先滚一次。
  const armedDataRef = useRef(undefined)
  const armedSettleRef = useRef(0)
  const userMovedRef = useRef(false)
  // 置旗那一刻已发出的请求号（fetchMessages 里自增）：只有当「置旗后才发出的请求」结算时
  // 才允许消费——否则置旗前就在飞的旧请求先回包，会拿旧筛选的结果抢着落点。
  const armedSeqRef = useRef(0)
  const queryRef = useRef(query)
  queryRef.current = query
  const dataRef = useRef(null)
  // 落点门（v3.320）：只有用户已经滚进列表（列表顶已在页签下沿之上）才置旗——
  // 停在顶部改筛选/搜索时把列表顶拽到页签下沿，工具条会被顶出视口。
  // 面板隐藏/列表不在（rect 为 0）⇒ 不置旗。口径与 listLandTarget 一致。
  const armLand = () => {
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!(rect.height > 0)) return
    const listTop = rect.top + window.scrollY - stickyPad()
    if (!(window.scrollY > listTop)) return
    landRef.current = true
    armedDataRef.current = dataRef.current
    armedSettleRef.current = settleTick
    armedSeqRef.current = loadSeqRef.current
    userMovedRef.current = false
  }
  useLandScrollCancel(landRef, userMovedRef)
  // 搜索防抖：输入停 300ms 才真正改 query；页码重置跟随 query 的真实变化。
  // 落点旗只能在这里置：防抖触发时焦点必然还在输入框（原先看 activeElement 会让
  // 主路径永不落点），所以只按「已滚进列表」判断，滚动等这次响应落地后再做。
  useEffect(() => {
    const t = setTimeout(() => {
      const next = input.trim()
      if (next !== queryRef.current) {
        armLand()
        setQuery(next)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [input])
  // 只有 query 真的变了才回第 1 页；只加/减空白时 query 不变，刷新不应把用户踢回首页。
  // 首帧例外：page 可能是 URL 恢复来的（#/messages?page=3），不能在挂载时打回第 1 页。
  const firstQueryRef = useRef(true)
  useEffect(() => {
    if (firstQueryRef.current) { firstQueryRef.current = false; return }
    setPage(1)
  }, [query])
  // 筛选状态写回地址栏（L2-8）：只 replaceState，绝不 pushState——改一次筛选多一条
  // 历史记录的体验（手机左滑要滑十几下才退出）不能接受。非本页签时不写，切走时
  // 由 App 的 hash 路由接管。
  const urlHash = buildMessagesHash({ q: query, cate, page, size, days, from: range.from, to: range.to })
  // 只在「语义真的不一样」时改写：参数顺序不同、或显式写了默认值（?size=20）都不重写，
  // 避免刷新一次就凭空多一条 replaceState。
  const hashMatches = () => sameMsgFilters(parseMessagesHash(window.location.hash), parseMessagesHash(urlHash))
  useEffect(() => {
    if (!active) return
    if (hashMatches()) return
    window.history.replaceState(window.history.state, '', urlHash)
  }, [active, urlHash])
  // 点「推送记录」当前页签时 App 会把 hash 直接赋成裸 #/messages（switchTab），筛选
  // 参数会掉；只要地址仍指向本页，就补回参数——同样 replaceState，不新增历史条目。
  useEffect(() => {
    if (!active) return undefined
    const onHash = () => {
      if (!/^#\/messages(\?|$)/.test(window.location.hash)) return
      if (hashMatches()) return
      // 带参数的 hash = 浏览器后退/前进到了另一组筛选：跟地址栏走，别把用户拽回当前筛选
      // （Sourcery #315-3）。裸 #/messages（App 切页签时写的）才是要补回参数的场景。
      if (window.location.hash.includes('?')) {
        const h = parseMessagesHash(window.location.hash)
        setQuery(h.q)
        setCate(h.cate)
        setPage(h.page)
        setSize(h.size)
        setDays(h.days)
        setRange({ from: h.from, to: h.to })
        return
      }
      window.history.replaceState(window.history.state, '', urlHash)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [active, urlHash])
  const fetchMessages = useCallback(
    () => {
      const requested = query
      const seq = ++loadSeqRef.current
      return apiGetMessages({ page, size, cate, q: requested, days: rangeActive ? 0 : days, from: range.from, to: range.to }).then((d) => {
        if (seq === loadSeqRef.current) loadedQueryRef.current = requested
        return d
      })
    },
    [page, size, cate, query, days, rangeActive, range.from, range.to])
  const { data, err, load, loading, settleTick } = usePanelLoader(fetchMessages, onSync)
  const slowLoading = useSlowFlag(loading)
  // 分页器禁用态的「在飞」部分延迟 120ms 才置位（C7-041，见下面 renderPager）：一次翻页的
  // loading 常常只存在十几毫秒（条件请求命中 304 / 本地缓存快），整排按钮立刻压到 .7 透明度
  // 再弹回来，就是一闪（与 v3.334 刷新按钮同一教训）。双击/连点的间隔约 200ms，120ms 后才
  // 禁用仍挡得住；只有「快到看不见」的请求不再让分页器闪一帧。
  const pagerSlow = useSlowFlag(loading, 120)
  // armLand 需要「点击那一刻的 data」做前后对比；渲染期同步，避免闭包拿到旧值。
  dataRef.current = data
  // 保活后每次切回本页都静默拉一次新数据：旧列表留在原地（loading 不会清 data），
  // 只更新内容，不出现「加载中…」占位。离开本页时不拉。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // v3.348：App 的统一轮询节拍（后台/暂停时不涨），本页在前台就跟着重拉。
  usePollReload(active, pollTick, load)
  // 结果集缩小后旧页码可能超过新页数（服务端按请求页切片，回空 items）。收到响应后把
  // 页码钳到最后一页并重拉，避免「在后面的页点刷新，整页空白」。
  useEffect(() => {
    if (data && data.status === 'ok' && Number.isSafeInteger(data.pages) && data.pages >= 1 && page > data.pages) {
      setPage(data.pages)
    }
  }, [data, page])
  // v3.320：主动操作后（paint 前）把列表顶部落到吸顶页签下沿——旧版换页时页高变化，
  // 浏览器把 scrollY 夹到新的上限，用户停在短页中间/底部。纯 load()、自动刷新、不置旗 ⇒ 不搬用户的位置。
  // 服务端分页：置旗那一帧 data 还是旧页，先落点会在新页更短时被浏览器二次夹取；
  // 旗子跨过 loading 保留，等这次响应结算（settleTick 前进 + loading=false）再消费一次。
  // 失败时 data 引用不变，只比 data 会永远等下去（旗子跨过失败留到下一次成功 = 把用户拽到列表顶）。
  useLayoutEffect(() => {
    if (!landRef.current) return
    if (loading) return // 响应未回：保留旗子
    if (!(settleTick > armedSettleRef.current)) return // 这次响应还没结算：继续等（含失败前）
    if (!(loadSeqRef.current > armedSeqRef.current)) return // 结算的是置旗前的旧请求：不能拿它落点
    if (data === armedDataRef.current && !err) return // 仍是置旗前那份数据：继续等
    landRef.current = false
    armedDataRef.current = undefined
    if (err) return // 请求失败：新数据不会来了，清旗不重试，更不滚动
    // 请求飞行期间用户自己滚动时撤销落点（夹取/锚定不算）。
    if (userMovedRef.current) return
    const y = listLandTarget(listRef.current)
    if (y === null) return
    window.scrollTo(0, y)
  }, [data, loading, err, settleTick, page, size, cate, days, query])
  // 分页统一入口：只有用户点分页才置落点旗；目标页 = 当前页不置（否则旗子悬挂）。
  const goPage = (n) => {
    if (n === page) return
    armLand()
    setPage(n)
  }
  // 跳页（v3.358）：只认数字，越界夹到 [1, pages]。换页仍走 goPage（统一的落点旗 + 同页守卫），
  // 所以这里不直接 setPage；先清空输入，避免下一次失焦拿旧值再跳一遍。
  const jumpTo = (raw) => {
    const text = String(raw == null ? '' : raw).trim()
    setJump('')
    if (text === '') return
    const n = Math.trunc(Number(text))
    if (!Number.isFinite(n)) return
    const pages = data && Number.isSafeInteger(data.pages) && data.pages > 0 ? data.pages : 1
    goPage(Math.min(Math.max(n, 1), pages))
  }
  // 搜索框回车 / 刷新前先把未落地的输入立刻生效，避免「刚打完字点刷新，还是旧结果」。
  // 只有搜索词变了才回第 1 页；没改词时刷新当前页，不应把用户踢回首页（审查 #246 可选）。
  // v3.334：按钮不再因为 loading 变灰——缓存命中时 loading 只有 15ms，
  // disabled 会把按钮压到 0.45 透明度再弹回来，这就是那下闪。改成只在慢加载时禁用。
  const busyRef = useRef(false)
  const refreshNow = () => {
    // 搜索词先落地：请求在飞时改词 + 回车不能被节流到 300ms 后再发。
    const q = input.trim()
    if (q !== query) { armLand(); setQuery(q); setPage(1); return }
    // loading 覆盖自动刷新/下拉刷新发起的请求，busyRef 挡同一 tick 的连点。
    if (loading || busyRef.current) return
    busyRef.current = true
    load().catch(() => {}).finally(() => { busyRef.current = false })
  }
  const [exporting, setExporting] = useState('') // '' | 'csv' | 'json'：加载态防连点（两按钮共用一闸）
  const [exportErr, setExportErr] = useState('')
  const [exportNote, setExportNote] = useState('')

  // 导出下载（v3.300 3.2）：POST /api/messages/export（字面量第一参数 + 筛选词只进 body）
  // → response.blob() → URL.createObjectURL → 临时 <a download> 点击 → revokeObjectURL。
  // 不拼服务端下载 URL：凭证不出现在 href（蓝图红线）。
  const doExport = useCallback(async (format) => {
    if (exporting !== '') return
    setExporting(format)
    setExportErr('')
    setExportNote('')
    const body = new URLSearchParams({ format })
    if (typeof cate === 'string' && cate.length > 0) body.set('cate', cate)
    if (typeof query === 'string' && query.length > 0) body.set('q', query)
    if (Number.isSafeInteger(days) && days > 0) body.set('days', String(days))
    if (rangeActive) { body.set('from', range.from); body.set('to', range.to) }
    // page/size 不发送：导出=筛选结果全量（服务端亦不读取）。
    const merged = timedRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${BOOT.token}`
      },
      body
    })
    let url = ''
    try {
      const res = await fetch('/api/messages/export', merged)
      if (!res.ok) { setExportErr(`导出失败：HTTP ${res.status}`); return }
      const ct = String(res.headers.get('content-type') || '')
      const blob = await res.blob()
      if (ct.startsWith('application/json')) {
        // application/json 两种含义（评审 231-H1）：三态（missing/invalid/tooLarge）=
        // {status,...} 对象 → 不下载、如实提示；成功导出 = 行数组 → 照常下载。
        // 按 Array.isArray 区分（成功形态 231-M1 已改为直接数组）。
        let parsed = null
        try { parsed = JSON.parse(await blob.text()) } catch (e) { parsed = null }
        if (!Array.isArray(parsed)) {
          const status = parsed && typeof parsed.status === 'string' ? parsed.status : 'unknown'
          setExportErr(`记录暂不可导出（${status}）`)
          return
        }
        if (res.headers.get('x-export-truncated') === 'true') setExportNote('匹配结果超过上限，导出已截断')
        url = URL.createObjectURL(new Blob([JSON.stringify(parsed)], { type: 'application/json' }))
      } else {
        if (res.headers.get('x-export-truncated') === 'true') setExportNote('匹配结果超过上限，导出已截断')
        url = URL.createObjectURL(blob)
      }
      const a = document.createElement('a')
      a.href = url
      // 文件名以服务端 Content-Disposition 为准（v3.360 起带北京时间戳）：blob URL 下载时
      // 浏览器只看 a.download，固定名会把服务端的带戳名覆盖掉（Sourcery #315-6）。
      const cd = String(res.headers.get('content-disposition') || '')
      const cdName = /filename="?([^";]+)"?/.exec(cd)
      a.download = cdName ? cdName[1] : (format === 'csv' ? 'messages-export.csv' : 'messages-export.json')
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      setExportErr(`导出失败：${e && e.message ? e.message : e}`)
    } finally {
      // revoke 延迟到 click 之后一拍（评审 231-M5）：浏览器解析下载是异步的，同步
      // revoke 会让 deferred download 拿不到 blob。1 分钟后回收（URL 规范建议的
      // 「延迟 revoke」口径，内存占用一次性、不累积）。
      if (url !== '') setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { /* 已回收 */ } }, 60000)
      setExporting('')
    }
  }, [exporting, cate, query, days, rangeActive, range.from, range.to])
  const items = data && Array.isArray(data.items) ? data.items : []
  // 列表 FLIP（v3.360）：翻页/增删时卡片在位置上滑过去，而不是瞬间重排。
  // 依赖「列表是否存在」：列表首次出现时挂载控制器，轮询更新不重建。
  const motionRef = useRef(null)
  useFlipList(motionRef)
  const categories = data && Array.isArray(data.categories) ? data.categories : []
  // 分类弹层的「全部分类」计数必须跟时间窗走（服务端 days>0 时 categories 已按窗口重算）；
  // 直接用 grandTotal 会在「今天」里显示全量 374，看起来像筛选没生效。
  const cateTotal = data && Array.isArray(data.categories)
    ? data.categories.reduce((sum, c) => sum + (typeof c.count === 'number' ? c.count : 0), 0)
    : null
  // v3.328：搜索结果高亮——标题与正文里的命中片段套 <mark>。
  // 高亮词必须与「当前显示的这一页数据」同源：data.queryUsed 是服务端为这批结果实际生效的词。
  // 防抖提交新词后、新响应回来前 data 仍是上一轮的，用 query 会拿新词去标旧卡片
  // （PR #291 Sourcery：Old results get wrong highlights）。
  const hitKw = (data && typeof data.queryUsed === 'string' ? data.queryUsed : '').trim().toLowerCase()
  // 列表里的 <mark> 由 .msg-item mark 上色（app.css）；详情抽屉不在 .msg-item 里，
  // 同一组主题变量改由行内样式带进去——否则深色主题下退化成浏览器默认的黄底黑字。
  const hitMarkStyle = { background: 'var(--warn-soft)', color: 'inherit', borderRadius: '2px', boxShadow: 'inset 0 0 0 1px var(--warn-line)' }
  const hit = (text, markStyle) => (typeof text === 'string'
    ? splitHits(text, hitKw, MSG_HIT_MAX).map(([part, on], i) => on ? html`<mark key=${i} style=${markStyle}>${part}</mark>` : part)
    : text)
  // 服务端对超长搜索词按字节截断——回显以 queryUsed（实际生效值）为准，
  // 但只在「响应确实属于当前查询、且用户没有继续输入」时回写；
  // 否则旧响应会把刚打的新词覆盖回旧值（搜索像没生效）。
  useEffect(() => {
    if (!data || typeof data.queryUsed !== 'string') return
    // 只接受「本次响应确实对应当前 query」的回写：旧 data 的 queryUsed 不能把刚输入的新词清空。
    if (loadedQueryRef.current !== query) return
    if (data.queryUsed !== query && input.trim() === query) {
      setInput(data.queryUsed)
      setQuery(data.queryUsed)
    }
  }, [data, input, query])
  // 抽屉开关：打开时记住触发的按钮，关闭后把焦点还给它（键盘用户接着往下看）。
  // preventScroll：焦点还给列表里的按钮时不得把页面滚一下（背后列表的位置要原地不动）。
  const openDetail = (m, btn) => {
    detailBtnRef.current = btn || null
    setDetail(m)
  }
  const closeDetail = () => {
    const btn = detailBtnRef.current
    detailBtnRef.current = null
    setDetail(null)
    if (btn && typeof btn.focus === 'function' && btn.isConnected) btn.focus({ preventScroll: true })
  }
  // 切到别的页签就收起抽屉：面板是保活挂载的，抽屉是 fixed 层、背景滚动也还锁着，
  // 留着会漏到别页（与 CategoryPicker 的「非本页即关」同口径）。这里不走 closeDetail——
  // 焦点不该被拽回一个已经隐藏的面板里。
  useEffect(() => {
    if (active) return
    detailBtnRef.current = null
    setDetail(null)
  }, [active])
  // 抽屉「分类」只画细分路径（来源之后那几段）：来源已经在上一行，整串再画一遍等于
  // 同一句话写两次。aria-label 仍带完整分类名（读屏与筛选口径都不受裁剪影响）。
  const detailCate = detail ? cateParts(detail.catename) : []
  const detailCateSub = detailCate.slice(1)
  // v3.358：列表标题是真 <button>（原 span[role=button][tabindex=0]）。原生 button 自带
  // Enter/空格 ⇒ 合成 click，再手写 onKeyDown 会双触发（keydown 展开 + click 收起 = 看起来没反应），
  // 故删掉手写键盘处理。v3.379 起它打开的是右侧抽屉：aria-haspopup 声明弹出的是对话框，
  // 行内展开的 aria-expanded / caret 一起退场（展开态不再是行内状态）。
  // 分页器视图（C7-041）：形参 loading 是「延迟后的在飞态」——一次翻页的请求常常十几毫秒就
  // 回来，4 个按钮同时压到 .7 透明度再弹回就是一帧闪。边界（page / 页数）实时算，与延迟门
  // 无关；超过 120ms 的请求仍然禁用，连点跳页照旧被挡。
  const renderPager = (loading) => html`<div class="pager">
        <${Button} disabled=${page <= 1 || loading} onClick=${() => goPage(1)}>« 首页<//>
        <${Button} disabled=${page <= 1 || loading} onClick=${() => goPage(page - 1)}>上一页<//>
        <span class="pager-info">第 ${data.page} / ${data.pages} 页</span>
        <span class="pager-jump">
          <span class="pager-jump-label" aria-hidden="true">跳至</span>
          <input class="pager-jump-input" type="number" inputmode="numeric" min="1" max=${data.pages}
            value=${jump} aria-label="跳到第几页"
            onInput=${(e) => setJump(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); jumpTo(jump) } }}
            onBlur=${() => jumpTo(jump)} />
          <span class="pager-jump-label" aria-hidden="true">页</span>
        </span>
        <${Button} disabled=${page >= data.pages || loading} onClick=${() => goPage(page + 1)}>下一页<//>
        <${Button} disabled=${page >= data.pages || loading} onClick=${() => goPage(data.pages)}>末页 »<//>
      </div>`
  return html`<div class="panel">
    <${PanelHead} title="推送记录" level=${1} sub="判重缓存 push.json（已抓取并推送的消息）" />
    <div class="msg-toolbar">
      <input class="msg-search" type="search" aria-label="搜索标题或内容" placeholder="搜索标题 / 内容…" value=${input}
        onInput=${(e) => setInput(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); refreshNow() } }} />
      <${CategoryPicker} value=${cate} categories=${categories}
        total=${cateTotal} pageActive=${active}
        onChange=${(v) => { armLand(); setCate(v); setPage(1) }} />
      <${MiniSelect} value=${rangeActive ? '__range' : String(days)} ariaLabel="时间范围"
        options=${[
          ...(rangeActive ? [{ value: '__range', label: '自定义区间' }] : []),
          { value: '0', label: '全部时间' },
          { value: '1', label: '今天' },
          { value: '3', label: '近 3 天' },
          { value: '7', label: '近 7 天' },
          { value: '30', label: '近 30 天' }
        ]}
        onChange=${(v) => {
          if (v === '__range') return
          armLand()
          setRange({ from: '', to: '' })
          setDays(Number(v))
          setPage(1)
        }} />
      ${/* 推送记录页未激活时不生成日期按钮（L4）：保活挂载的面板会在别的页留下
           hidden 的 .date-btn 副本；range 由本组件 state 持有，切回照旧。 */ ''}
      ${active && html`<${DateRange} value=${range} onChange=${(r) => { armLand(); setRange(r); setDays(0); setPage(1) }} />`}
      <${MiniSelect} value=${String(size)} ariaLabel="每页显示条数"
        options=${[10, 20, 50, 100].map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
        onChange=${(v) => { armLand(); setSize(Number(v)); setPage(1) }} />
      <${Button} variant="ghost" disabled=${slowLoading} ariaBusy=${loading ? 'true' : 'false'} onClick=${refreshNow}>刷新<//>
      <${Button} variant="ghost" disabled=${exporting !== ''} onClick=${() => doExport('csv')}>${exporting === 'csv' ? '导出中…' : '导出 CSV'}<//>
      <${Button} variant="ghost" disabled=${exporting !== ''} onClick=${() => doExport('json')}>${exporting === 'json' ? '导出中…' : '导出 JSON'}<//>
    </div>
    ${err && html`<${LoadError} text=${err} busy=${loading} onRetry=${() => { load().catch(() => {}) }} />`}
    ${exportErr && html`<${Hint} tone="error">${exportErr}<//>`}
    ${exportNote && html`<${Hint}>${exportNote}<//>`}
    ${loading && !data && html`<${PanelSkeleton} label="正在加载推送记录" />`}
    ${data && data.status !== 'ok' && html`<div class="empty">记录${data.status === 'missing' ? '尚未生成（跑一轮后这里就有数据）' : `不可读（${data.status}）`}${data.cacheDirHint ? html`<${Hint}>正在读取目录：${data.cacheDirHint}（若运行缓存在别处，请让 XBK_CACHE_DIR 与运行侧 Config.cache.dir 一致）<//>` : ''}</div>`}
    ${data && data.status === 'ok' && html`<div ref=${listRef}>
      <div class="msg-count" aria-live="polite">匹配 ${data.total} 条${(query.length > 0 || cate.length > 0) && data.grandTotal !== data.total ? ` / 共 ${data.grandTotal} 条` : ''}${slowLoading ? html`<span class="msg-loading"> · 更新中…</span>` : ''}</div>
      ${items.length === 0
        ? html`<div class="empty">没有匹配的记录</div>`
        : html`<div class="msg-list" role="list" ref=${motionRef}>
          ${items.map((m) => html`<div class="msg-item" role="listitem" key=${m.rowKey} data-mk=${m.rowKey}
            onClick=${(e) => {
              // 手机上拇指落点是整张卡片，不是标题那 22px 一行：卡片空白处也要能开详情。
              // 原文链接是卡片里唯一的跳转入口，点它必须是跳转（e.target.closest('a') 提前放行）。
              if (e.target.closest('a')) return
              openDetail(m, e.currentTarget.querySelector('.msg-title'))
            }}>
            <div class="msg-item-head">
              <button type="button" class="msg-title"
                aria-haspopup="dialog"
                title="查看详情"
                onClick=${(e) => { e.stopPropagation(); openDetail(m, e.currentTarget) }}>
                ${m.title ? hit(m.title) : '（无标题）'}
              </button>
              ${m.price !== null && titleTailPrice(m.title) !== m.price
                ? html`<span class="msg-price">¥${m.price}</span>`
                : ''}
              <span class="msg-chev" aria-hidden="true">›</span>
            </div>
            <div class="msg-meta">
              <span class="msg-cate" aria-label=${m.catename || undefined}>${cateParts(m.catename).map((part, i) => html`<span class="msg-cate-part" key=${i}>${part}</span>`)}</span>
              <span class="mono">${m.datetime} ${m.shorttime}</span>
              ${msgLink(m, data.baseUrl)}
            </div>
          </div>`)}
        </div>`}
      ${renderPager(loading && pagerSlow)}
    </div>`}
    ${/* v3.379：条目详情抽屉。列表留在背后做对照（滚动位置不动），宽度 520 与抽屉默认值一致，
         手机上由 Drawer 自己铺满整屏。detail 是打开那一刻的快照，轮询换掉 items 也不影响阅读。 */ ''}
    ${detail && html`<${Drawer} open=${true} width=${520}
      title=${detail.title ? hit(detail.title, hitMarkStyle) : '（无标题）'}
      sub=${msgTimeText(detail)}
      onClose=${closeDetail}>
      <${DetailRow} label="来源渠道">${msgSourceOf(detail.catename) || '（未分类）'}<//>
      <${DetailRow} label="分类">${detailCateSub.length > 0
        ? html`<span class="msg-cate" aria-label=${detail.catename}>${detailCateSub.map((part, i) => html`<span class="msg-cate-part" key=${i}>${part}</span>`)}</span>`
        : (detailCate.length === 0 ? '（未分类）' : '（无细分分类）')}<//>
      <${DetailRow} label="链接">${detail.url ? msgLink(detail, data && data.baseUrl) : '（无原文链接）'}<//>
      <div style=${{ marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--border)' }}>
        <div style=${{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', marginBottom: '6px' }}>正文</div>
        <div style=${{ fontSize: 'var(--fs-sm)', lineHeight: '1.7', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          ${detail.content ? hit(detail.content, hitMarkStyle) : '（无正文）'}
        </div>
      </div>
    </${Drawer}>`}
  </div>`
}

// ── 线报全站搜索（v3.370）────────────────────────────────────────────────
// 搜的是线报酷全站（含没推给你的线报），服务端代理 /search.php 并解析成 JSON。
// 关注词存在缓存目录：点某个词 = 搜它；「检查更新」逐词拉第 1 页，与 lastReadAt
// 比出「N 条新」；打开某个关注词后把它标为已读（新条目仍带「新」角标到本次离开）。
const LS_PAGE_MAX = 1000
const LS_QUERY_MAX_BYTES = 120 // 与服务端 LINE_SEARCH_QUERY_MAX_BYTES 同口径，避免回显 q 被截断后对不上
function clampSearchText (raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = new TextEncoder().encode(ch).length
    if (used + n > LS_QUERY_MAX_BYTES) break
    out += ch
    used += n
  }
  return out
}
function parseSearchHash (hash) {
  const out = { q: '', page: 1 }
  const raw = typeof hash === 'string' ? hash : ''
  const at = raw.indexOf('?')
  if (at < 0 || !/^#\/search\b/.test(raw.slice(0, at))) return out
  const params = new URLSearchParams(raw.slice(at + 1))
  const q = params.get('q')
  if (typeof q === 'string' && q.trim() !== '') out.q = clampSearchText(q)
  const page = Number(params.get('page'))
  if (Number.isSafeInteger(page) && page >= 1) out.page = Math.min(page, LS_PAGE_MAX)
  return out
}
function buildSearchHash ({ q, page }) {
  const p = new URLSearchParams()
  if (typeof q === 'string' && q !== '') p.set('q', q)
  if (Number.isSafeInteger(page) && page > 1) p.set('page', String(page))
  const qs = p.toString()
  return qs === '' ? '#/search' : `#/search?${qs}`
}

function watchAtText (ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ')
}

function SearchPanel ({ onSync, active = true }) {
  const [boot] = useState(() => parseSearchHash(window.location.hash))
  const [input, setInput] = useState(boot.q)
  // req 是唯一真源：n 让「同一个词再按一次搜索」也能强制重拉；mark 只在「点关注词」时为真
  // ——普通搜索/刷新页面不把关注词标成已读，否则一进页面「新」角标就被自己吃掉了。
  const [req, setReq] = useState({ q: boot.q, page: boot.page, n: 0, since: null, mark: false })
  const [watch, setWatch] = useState([])
  const [watchStatus, setWatchStatus] = useState('')
  const [watchErr, setWatchErr] = useState('')
  const [cfg, setCfg] = useState({ limit: 20, intervalMin: 10, enabled: false, lastCheckAt: 0 })
  const [cfgReady, setCfgReady] = useState(false)
  const [cfgDraft, setCfgDraft] = useState({ limit: 20, intervalMin: 10, enabled: false })
  // 保存设置的提示同一个 span 承载三态：中性（保存中…）/ 成功 / 失败。
  // 旧实现 CSS 写死 color: var(--ok-fg)，失败文案也用成功绿（C7-035）。
  const [cfgMsg, setCfgMsg] = useState('')
  const [cfgMsgTone, setCfgMsgTone] = useState('')
  const showCfgMsg = (text, tone = '') => { setCfgMsg(text); setCfgMsgTone(tone) }
  const cfgDirty = useRef(false)
  const [checking, setChecking] = useState(false)
  const [newCounts, setNewCounts] = useState({})
  const markedRef = useRef('')
  // 关注词列表的版本号：读写并发时，旧 GET/旧检查结果不得覆盖新状态（Sourcery #328）。
  const watchEpoch = useRef(0)

  const fetchSearch = useCallback(() => {
    if (req.q === '') return Promise.resolve({ status: 'empty', q: '', page: 1, pages: 1, count: 0, items: [] })
    return apiSearchLines({ q: req.q, page: req.page, limit: cfg.limit })
  }, [req, cfg.limit])
  const { data, err, load, loading } = usePanelLoader(fetchSearch, onSync)
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // 条数改了：回到第 1 页重拉（旧页码是按旧条数算的，不能沿用）。
  // 首次拿到配置（默认 20 → 用户设的 50）不算「用户改条数」，否则刷新后 page 参数会被吃掉。
  const prevLimit = useRef(null)
  useEffect(() => {
    if (!cfgReady) return
    if (prevLimit.current === null) {
      prevLimit.current = cfg.limit
      return
    }
    if (prevLimit.current === cfg.limit) return
    prevLimit.current = cfg.limit
    if (req.q !== '') setReq((r) => ({ ...r, page: 1, n: r.n + 1 }))
  }, [cfgReady, cfg.limit, req.q])

  const loadWatch = useCallback(() => {
    const seq = watchEpoch.current
    return apiGetLineWatch().then((d) => {
      if (watchEpoch.current !== seq) return // 期间有增删/已读：这份旧快照作废
      setWatch(Array.isArray(d.words) ? d.words : [])
      setWatchStatus(typeof d.status === 'string' ? d.status : 'ok')
      const nextCfg = {
        limit: Number.isSafeInteger(d.limit) && d.limit > 0 ? d.limit : 20,
        intervalMin: Number.isSafeInteger(d.intervalMin) && d.intervalMin > 0 ? d.intervalMin : 10,
        enabled: d.enabled === true,
        lastCheckAt: Number.isSafeInteger(d.lastCheckAt) && d.lastCheckAt > 0 ? d.lastCheckAt : 0
      }
      setCfg(nextCfg)
      setCfgReady(true)
      if (!cfgDirty.current) {
        setCfgDraft({ limit: nextCfg.limit, intervalMin: nextCfg.intervalMin, enabled: nextCfg.enabled })
      }
      setWatchErr('')
    }).catch((e) => setWatchErr(`关注词读取失败：${loadErrorText(e)}`))
  }, [])
  useEffect(() => { if (active) loadWatch().catch(() => {}) }, [active, loadWatch])

  const submit = (q, page, since = null, mark = false) => {
    const next = typeof q === 'string' ? clampSearchText(q) : input.trim()
    if (next === '') return
    setInput(next)
    setReq({
      q: next,
      page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
      n: req.n + 1,
      since: Number.isFinite(since) ? since : null,
      mark: mark === true
    })
  }
  const searchWatch = (w) => {
    // lastReadAt=0 表示从未读过：保留 0 作基线，本次结果全部带「新」（与检查更新的口径一致）。
    submit(w.q, 1, w.lastReadAt > 0 ? w.lastReadAt : 0, true)
  }
  const addWatch = () => {
    const q = req.q
    if (q === '') return
    watchEpoch.current += 1
    apiPostLineWatch({ action: 'add', q }).then((d) => {
      watchEpoch.current += 1
      setWatch(Array.isArray(d.words) ? d.words : [])
      setWatchErr('')
    }).catch((e) => setWatchErr(e.message))
  }
  const removeWatch = (q) => {
    watchEpoch.current += 1
    apiPostLineWatch({ action: 'remove', q }).then((d) => {
      watchEpoch.current += 1
      setWatch(Array.isArray(d.words) ? d.words : [])
      setNewCounts((prev) => {
        const next = { ...prev }
        delete next[q]
        return next
      })
    }).catch((e) => setWatchErr(e.message))
  }
  const editCfg = (patch) => {
    cfgDirty.current = true
    showCfgMsg('')
    setCfgDraft((d) => ({ ...d, ...patch }))
  }
  const saveCfg = () => {
    const limit = Number(cfgDraft.limit)
    const intervalMin = Number(cfgDraft.intervalMin)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { showCfgMsg('条数要 1–100', 'bad'); return }
    if (!Number.isSafeInteger(intervalMin) || intervalMin < 1 || intervalMin > 1440) { showCfgMsg('间隔要 1–1440 分钟', 'bad'); return }
    showCfgMsg('保存中…')
    watchEpoch.current += 1
    apiPostLineWatch({ action: 'config', limit, intervalMin, enabled: cfgDraft.enabled === true }).then((d) => {
      watchEpoch.current += 1
      const next = {
        limit: Number.isSafeInteger(d.limit) ? d.limit : limit,
        intervalMin: Number.isSafeInteger(d.intervalMin) ? d.intervalMin : intervalMin,
        enabled: d.enabled === true,
        lastCheckAt: Number.isSafeInteger(d.lastCheckAt) ? d.lastCheckAt : 0
      }
      cfgDirty.current = false
      setCfg(next)
      setCfgDraft({ limit: next.limit, intervalMin: next.intervalMin, enabled: next.enabled })
      showCfgMsg('已保存', 'ok')
      if (Array.isArray(d.words)) setWatch(d.words)
    }).catch((e) => showCfgMsg(`保存失败：${e.message}`, 'bad'))
  }
  const checkWatch = async () => {
    if (checking || watch.length === 0) return
    setChecking(true)
    setWatchErr('')
    const epoch = watchEpoch.current
    const next = { ...newCounts }
    let failed = 0
    try {
      // 先拉一次最新关注词状态：监控可能在页面开着时已经推进过锚点，
      // 用旧快照算「N 条新」会把已推过的条目又标成新。
      let current = watch
      try {
        const fresh = await apiGetLineWatch()
        if (fresh && Array.isArray(fresh.words)) {
          current = fresh.words
          if (watchEpoch.current === epoch) setWatch(fresh.words)
        }
      } catch (e) {}
      for (const w of current) {
        try {
          // 和监控用同一套范围：从第 1 页往回翻到锚点所在页（最多 5 页），
          // 不能只数第 1 页——新增超过一页时角标会少报。
          const since = w.lastReadAt > 0 ? w.lastReadAt : Date.now()
          let count = 0
          for (let page = 1; page <= 5; page += 1) {
            const d = await apiSearchLines({ q: w.q, page, limit: 100 })
            if (!d || d.status !== 'ok' || !Array.isArray(d.items)) throw new Error('check failed')
            if (d.items.length === 0) break
            // 优先用「上次读到的最新条目标识」做锚点：上游时间只有分钟精度，仅靠 ts 会漏掉
            // 同一分钟内发布的新线报。锚点不在当前页时按 ts 比较，并继续往前翻。
            const idx = w.lastReadId ? d.items.findIndex((it) => it.id === w.lastReadId) : -1
            if (idx >= 0) { count += idx; break }
            const allNew = d.items.every((it) => typeof it.ts === 'number' && it.ts > since)
            count += d.items.filter((it) => typeof it.ts === 'number' && it.ts > since).length
            if (!allNew) break
            if (page >= Math.min(Number(d.pages) || 1, 5)) break
          }
          next[w.q] = count
        } catch (e) {
          failed += 1 // 单个词失败不拖累其它词，保留它上次的角标
        }
      }
      if (watchEpoch.current !== epoch) return // 期间已读/增删：旧检查结果作废
      setNewCounts(next)
      if (failed > 0) setWatchErr(`有 ${failed} 个关注词检查失败，保留上次角标，稍后再试`)
    } finally {
      setChecking(false)
    }
  }
  // 打开关注词后标为已读：只在「这次响应属于本次关注词点击」时写一次；
  // 普通搜索/刷新页面（mark=false）不写，否则新角标还没来得及看就被清掉。
  useEffect(() => {
    if (!data || data.status !== 'ok' || req.q === '' || req.mark !== true) return
    if (data.q !== req.q) return // 旧结果还没换掉：不能用 A 的结果把 B 标成已读
    const key = `${req.q}\n${req.n}`
    if (markedRef.current === key) return
    if (!watch.some((w) => w.q === req.q)) return
    markedRef.current = key
    const newest = (Array.isArray(data.items) ? data.items : []).reduce((max, it) => (
      typeof it.ts === 'number' && it.ts > max ? it.ts : max
    ), 0)
    watchEpoch.current += 1
    apiPostLineWatch({
      action: 'read',
      q: req.q,
      lastReadAt: newest > 0 ? newest : Date.now(),
      lastReadId: data.items && data.items[0] ? data.items[0].id : ''
    }).then((d) => {
      watchEpoch.current += 1
      if (Array.isArray(d.words)) setWatch(d.words)
      setNewCounts((prev) => {
        if (!Object.hasOwn(prev, req.q)) return prev
        const next = { ...prev }
        delete next[req.q]
        return next
      })
    }).catch(() => {})
  }, [data, req, watch])

  // 地址栏跟随筛选（只 replaceState，不新增历史记录）；刷新/后退能回到同一页。
  useEffect(() => {
    if (!active) return
    const hash = buildSearchHash({ q: req.q, page: req.page })
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash)
  }, [active, req.q, req.page])
  useEffect(() => {
    if (!active) return undefined
    const onHash = () => {
      if (!/^#\/search(\?|$)/.test(window.location.hash)) return
      const h = parseSearchHash(window.location.hash)
      if (h.q === req.q && h.page === req.page) return
      setInput(h.q)
      setReq({ q: h.q, page: h.page, n: req.n + 1, since: null, mark: false })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [active, req.q, req.page, req.n])

  const watched = watch.some((w) => w.q === req.q)
  // 只认「本次请求」的结果：切关注词时 usePanelLoader 会暂留上一份 data，
  // 不校验 q 就会把 A 的条目挂在 B 下面，甚至用 A 的结果把 B 标成已读。
  const live = data && (data.status !== 'ok' || data.q === req.q) ? data : null
  // C7-002：换词/翻页时结果区不再整块卸载。`live` 的 q 校验一个字没动（它守的是数据归属：
  // A 的条目不得挂到 B 下面，也不能用 A 的结果把 B 标成已读）；这里另存一份「上次真正画出来的
  // 成功结果」，只在本轮响应落地前占位（stale-while-revalidate），不参与已读标记/越界回页。
  // 旧实现只有一个数据源：req 一变 live 立刻为 null，五个渲染分支一个都不命中 → 结果区整块
  // 消失（先一帧空白、再 3 行骨架），长列表塌成三行，移动端滚动位置被夹回去。
  const lastShownRef = useRef(null)
  if (live && live.status === 'ok') lastShownRef.current = live
  const view = searchBodyView({ q: req.q, live, prev: lastShownRef.current, loading, err })
  // C7-002（B2 返工 a1）：同 q 的刷新/翻页失败时 loader 保留旧 data ⇒ live 仍是上一份 ok 结果，
  // 于是 view 仍是 'results'、`view === 'error'` 的 LoadError（含重试）永远走不到。失败必须另有
  // 出口：在 results 上方补 err 提示 + 重试，否则翻页失败既无提示也无重试入口。
  const refreshErr = searchRefreshError({ live, err })
  const stale = view === 'stale'
  const shown = view === 'results' ? live : (stale ? lastShownRef.current : null)
  const kw = shown && typeof shown.q === 'string' ? shown.q.trim().toLowerCase() : ''
  const hit = (text) => (typeof text === 'string' && kw.length > 0
    ? splitHits(text, kw, 8).map(([part, on], i) => on ? html`<mark key=${i}>${part}</mark>` : part)
    : text)
  const items = shown && Array.isArray(shown.items) ? shown.items : []
  const pages = shown && Number.isSafeInteger(shown.pages) && shown.pages >= 1 ? Math.min(shown.pages, LS_PAGE_MAX) : 1
  // 页码超出总数（比如改了每页条数后旧链接 page=19）：自动回最后一页。
  useEffect(() => {
    if (!live || live.status !== 'ok') return
    if (live.count === 0 && live.page > pages && typeof live.q === 'string' && live.q !== '') {
      submit(live.q, pages)
    }
  }, [live, pages])
  let body
  if (view === 'prompt') {
    body = html`<div class="empty">输入关键词搜线报酷全站（含没推给你的线报）。试试「十月稻田」。</div>`
  } else if (view === 'skeleton') {
    // 只有「一份结果都没有」（首次搜索）才出骨架；换词/翻页期间由 .ls-results 的 min-height 占位。
    body = html`<div class="ls-results"><${PanelSkeleton} label="正在搜索线报" /></div>`
  } else if (view === 'error') {
    body = html`<${LoadError} text=${err} busy=${loading} onRetry=${() => { load().catch(() => {}) }} />`
  } else if (view === 'upstream') {
    body = html`<${Hint} tone="error">${live.error || '线报酷搜索暂不可用，稍后再试'}<//>`
  } else {
    body = html`<div class="ls-results">
      ${refreshErr && html`<${Hint} tone="error">${err}${' '}<button type="button" class="ls-follow" onClick=${() => { load().catch(() => {}) }}>重试<//><//>`}
      ${stale && html`<div class="msg-count msg-loading">正在搜索「${req.q}」… 下面还是「${shown.q}」的结果</div>`}
      <div class="msg-count" aria-live="polite">本页 ${shown.count} 条 · 第 ${shown.page} / ${pages} 页${shown.pagesEstimated ? ' · 页数为估算' : ''}${shown.cached ? ' · 60s 内缓存' : ''}${!stale && !watched ? html` <button type="button" class="ls-follow" onClick=${addWatch}>关注「${req.q}」</button>` : ''}</div>
      ${items.length === 0
        ? html`<div class="empty">没有匹配的线报</div>`
        : html`<div class="msg-list" role="list">
          ${items.map((it, i) => html`<div class="msg-item" role="listitem" key=${it.id || i}>
            <div class="msg-item-head">
              <a class="msg-title ls-title" href=${it.url} target="_blank" rel="noopener noreferrer" title=${`打开线报酷原文：${it.title}`}>${hit(it.title)}</a>
              ${typeof it.price === 'number' ? html`<span class="msg-price">¥${it.price}</span>` : ''}
              ${!stale && req.since !== null && typeof it.ts === 'number' && it.ts > req.since ? html`<span class="ls-new">新</span>` : ''}
            </div>
            <div class="msg-meta">
              ${it.catename ? html`<span class="msg-cate" aria-label=${it.catename}>${cateParts(it.catename).map((part, j) => html`<span class="msg-cate-part" key=${j}>${part}</span>`)}</span>` : ''}
              <span class="mono">${it.datetime || '—'}</span>
              ${it.author ? html`<span>${it.author}</span>` : ''}
              <a class="msg-link" href=${it.url} target="_blank" rel="noopener noreferrer">原文链接 ↗</a>
            </div>
            ${it.content ? html`<div class="ls-excerpt">${hit(it.content)}</div>` : ''}
          </div>`)}
        </div>`}
      <div class="pager">
        <${Button} disabled=${stale || !!err || req.page <= 1 || loading} onClick=${() => submit(req.q, 1, req.since)}>« 首页<//>
        <${Button} disabled=${stale || !!err || req.page <= 1 || loading} onClick=${() => submit(req.q, req.page - 1, req.since)}>上一页<//>
        <span class="pager-info">第 ${shown.page} / ${pages} 页</span>
        <${Button} disabled=${stale || !!err || req.page >= pages || loading} onClick=${() => submit(req.q, req.page + 1, req.since)}>下一页<//>
        <${Button} disabled=${stale || !!err || req.page >= pages || loading} onClick=${() => submit(req.q, pages, req.since)}>末页 »<//>
      </div>
    </div>`
  }
  return html`<div class="panel">
    <${PanelHead} title="线报搜索" level=${1} sub="搜线报酷全站 · 关注词有新线报会标出来" />
    <div class="msg-toolbar">
      <input class="msg-search" type="search" aria-label="搜索全站线报" placeholder="搜线报，如：十月稻田" value=${input}
        onInput=${(e) => setInput(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(input, 1) } }} />
      <${Button} disabled=${loading || input.trim() === ''} ariaBusy=${loading ? 'true' : 'false'} onClick=${() => submit(input, 1)}>搜索<//>
    </div>
    <details class="ls-config">
      <summary>监控设置：搜索页每页 ${cfg.limit} 条 · 每 ${cfg.intervalMin} 分钟检查 · ${cfg.enabled ? '已开启' : '已关闭'}</summary>
      <div class="ls-config-body">
        <label class="ls-cfg-field">搜索页每页
          <input type="number" min="1" max="100" inputmode="numeric" value=${cfgDraft.limit}
            onInput=${(e) => editCfg({ limit: Number(e.target.value) })} /> 条
        </label>
        <label class="ls-cfg-field">每
          <input type="number" min="1" max="1440" inputmode="numeric" value=${cfgDraft.intervalMin}
            onInput=${(e) => editCfg({ intervalMin: Number(e.target.value) })} /> 分钟检查
        </label>
        <label class="ls-cfg-toggle">
          <input type="checkbox" checked=${cfgDraft.enabled}
            onChange=${(e) => editCfg({ enabled: e.target.checked })} /> 自动检查并推送新线报
        </label>
        <${Button} variant="ghost" onClick=${saveCfg}>保存设置<//>
        ${cfgMsg && html`<span class=${'ls-cfg-msg' + (cfgMsgTone ? ' is-' + cfgMsgTone : '')}>${cfgMsg}</span>`}
      </div>
      <div class="ls-cfg-help">「搜索页每页」只管搜索页翻页，不影响监控。开启监控后，每 ${cfgDraft.intervalMin} 分钟看一次关注词：上次检查之后多出来的线报，每条单独推送；没有新的就不推。监控会从最新往回翻到上次检查的位置（最多 5 页），不会因为超过一页的条数就漏推。推过的会记在文件里，重启不重推。</div>
      ${cfg.enabled && cfg.lastCheckAt > 0 && html`<div class="ls-cfg-help">上次检查时间：${watchAtText(cfg.lastCheckAt)}（北京时间）</div>`}
    </details>
    <div class="ls-watch">
      <div class="ls-watch-head">
        <span class="ls-watch-title">关注词</span>
        ${watch.length > 0 && html`<${Button} variant="ghost" disabled=${checking} onClick=${checkWatch}>${checking ? '检查中…' : '检查更新'}<//>`}
        ${watchStatus !== '' && watchStatus !== 'ok' && html`<span class="ls-watch-warn">关注词文件读取失败（${watchStatus}），暂时不能保存</span>`}
      </div>
      ${watch.length === 0
        ? html`<div class="ls-watch-empty">还没有关注词。搜到想要的词后点「关注」，下次进来点「检查更新」看有没有新线报。</div>`
        : html`<div class="ls-chips">
          ${watch.map((w) => html`<span class="ls-chip-wrap" key=${w.q}>
            <button type="button" class="ls-chip${w.q === req.q ? ' on' : ''}" onClick=${() => searchWatch(w)}>${w.q}${newCounts[w.q] > 0 ? html`<span class="ls-chip-n">${newCounts[w.q]} 条新</span>` : ''}</button>
            <button type="button" class="ls-chip-x" aria-label=${`取消关注 ${w.q}`} title="取消关注" onClick=${() => removeWatch(w.q)}>×</button>
          </span>`)}
        </div>`}
      ${watchErr && html`<${Hint} tone="error">${watchErr}<//>`}
    </div>
    ${body}
  </div>`
}

// 运行日志：run.log 尾部（服务端 1MiB 上限），启动预加载 + 手动/切回刷新；有任务在跑时跟随轮询。
// 异常口径与筛选在 pure.mjs（isIssueLogLine / filterLogLines），组件与测试共用。
// ── 日志行渲染（v3.317）────────────────────────────────────────────────────
// 旧版把整段尾部文本塞进一个 <pre>：ERROR/ALERT 与普通行同色；搜「推送」命中 53 行
// 却 0 处高亮。现在一行一个 <span>（仍是 <pre> 内的行内节点 ⇒ pre-wrap/等宽/复制
// 换行都不变），按级别着色，命中片段用 <mark> 包起来。
// 高亮上限：超过 3000 行退回纯文本（每行一个节点 + mark 在手机上明显掉帧），
// 计数行必须明说「已关闭高亮」，不能让用户以为搜不到。
const LOG_HIGHLIGHT_MAX = 3000
// 虚拟滚动（v3.385）：只挂可视窗口 ± overscan 的行，整段日志的总高度由 virtual-core 算。
// 行高先按 12px × 1.6（--fs-xs × --lh-code）估；真实高度由库量到后覆盖——长行在手机上会
// 折行，估不准，只能以量到的为准（否则滚到底部会差出一大截）。
const LOG_ROW_ESTIMATE_PX = 19
const LOG_ROW_OVERSCAN = 8
// virtual-core 的 DOM 适配四件套：库只带算法，滚动/尺寸观察由适配层注入（React/Vue 适配器
// 内部就是这三个函数）。少给任何一个，scrollToIndex 就会抛 scrollToFn is not a function。
const VIRT_ADAPTER = { observeElementRect, observeElementOffset, scrollToFn: elementScroll }

function LogsPanel ({ pollMs, initialQuery = '', initialMode = 'all', initialData = null, focusAt = '', focusDate = '', onSync, active = true }) {
  const { data, err, load: loadRaw, loading } = usePanelLoader(apiGetLogs, onSync, initialData)
  // v3.318：跳转前预取的快照只用于本次挂载——首帧即最终日志，且不再立刻重拉一次。
  const seededRef = useRef(initialData !== null)
  const preRef = useRef(null)
  // v3.319：行级跳转把「点中的那一轮」滚到框中部、加底色；只做一次，之后轮询不抢滚动。
  const focusDoneRef = useRef('')
  const stickRef = useRef(true)
  const prevTextRef = useRef('')
  // 虚拟器（v3.385）：virtual-core 不带 preact 绑定，实例自己持有；onChange 只在
  // 「可视区间真的变了」时触发（库内部 memo 过），setState 让窗口跟着滚动走。
  const [, bumpVirt] = useState(0)
  const [virt] = useState(() => new Virtualizer({
    ...VIRT_ADAPTER,
    count: 0,
    enabled: false,
    overscan: LOG_ROW_OVERSCAN,
    estimateSize: () => LOG_ROW_ESTIMATE_PX,
    getScrollElement: () => preRef.current,
    onChange: () => bumpVirt((n) => n + 1)
  }))
  // v3.351：日志框右侧「快滚条」——一长条轨道，按住拖动可快速掠过整段日志。
  // 手机浏览器不显示原生滚动条，长日志只能一屏屏甩；这里补一条可拖的条，点轨道直接跳。
  const railRef = useRef(null)
  const dragRef = useRef(null)
  const [rail, setRail] = useState({ top: 0, height: 0, pct: 0, show: false })
  const syncRail = useCallback(() => {
    const el = preRef.current
    const box = railRef.current
    if (!el || !box) return
    const track = box.clientHeight
    const max = el.scrollHeight - el.clientHeight
    if (track <= 0 || max <= 8) {
      setRail((prev) => (prev.show ? { top: 0, height: 0, pct: 0, show: false } : prev))
      return
    }
    const h = Math.max(28, Math.round(track * (el.clientHeight / el.scrollHeight)))
    const top = Math.round((track - h) * (el.scrollTop / max))
    const pct = Math.round((el.scrollTop / max) * 100)
    setRail((prev) => (prev.show && prev.top === top && prev.height === h && prev.pct === pct
      ? prev
      : { top, height: h, pct, show: true }))
  }, [])
  // 手指落在轨道空白处：以拇指高度折半起算，落到哪跳到哪；落在拇指上：保持抓取偏移，拖动不跳。
  const railScrollTo = useCallback((clientY, grab) => {
    const el = preRef.current
    const box = railRef.current
    if (!el || !box) return
    const track = box.clientHeight
    const h = Math.max(28, Math.round(track * (el.clientHeight / el.scrollHeight)))
    const usable = Math.max(1, track - h)
    const y = clientY - box.getBoundingClientRect().top - grab
    const ratio = Math.min(1, Math.max(0, y / usable))
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    syncRail()
  }, [syncRail])
  const onRailDown = (e) => {
    const el = preRef.current
    const box = railRef.current
    if (!el || !box) return
    // 多指并发（Sourcery #305 M3）：第二根手指按下时第一根还在拖——只认先按下的那根。
    // 否则 dragRef 被覆盖，第一根的 move/up 全被 id 过滤掉，松手后条还粘在旧抓取点。
    if (dragRef.current) return
    const track = box.clientHeight
    const h = Math.max(28, Math.round(track * (el.clientHeight / el.scrollHeight)))
    const thumbTop = box.getBoundingClientRect().top + rail.top
    const onThumb = e.clientY >= thumbTop - 2 && e.clientY <= thumbTop + h + 2
    dragRef.current = { id: e.pointerId, grab: onThumb ? e.clientY - thumbTop : h / 2 }
    // 捕获失败（合成事件 / 指针已抬起）不影响这次跳转：先记下抓取点，能捕获就捕获。
    if (typeof box.setPointerCapture === 'function') {
      try { box.setPointerCapture(e.pointerId) } catch (err) {}
    }
    e.preventDefault()
    railScrollTo(e.clientY, dragRef.current.grab)
  }
  const onRailMove = (e) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    e.preventDefault()
    railScrollTo(e.clientY, d.grab)
  }
  const onRailUp = (e) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    const box = railRef.current
    if (box && typeof box.releasePointerCapture === 'function') {
      try { box.releasePointerCapture(e.pointerId) } catch (err) {}
    }
  }
  // 键盘等价操作：上下 48px、翻页 0.9 屏、Home/End 到两端。
  const onRailKey = (e) => {
    const el = preRef.current
    if (!el) return
    const page = Math.max(80, el.clientHeight * 0.9)
    const map = { ArrowDown: 48, ArrowUp: -48, PageDown: page, PageUp: -page }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      el.scrollTop = e.key === 'Home' ? 0 : el.scrollHeight
    } else if (e.key in map) {
      e.preventDefault()
      el.scrollTop = Math.max(0, el.scrollTop + map[e.key])
    } else {
      return
    }
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    syncRail()
  }
  // 轮询互斥（审查 #231 前端项）：任务运行时每 2s 拉 1 MiB，上一请求未回时再叠一发
  // 只会让服务端并发读盘、后到的响应还可能盖掉新结果。手动刷新同样走这把闸。
  const busyRef = useRef(false)
  const pendingRef = useRef(false)
  // 排队等待者：下拉指示条要等「在飞那一轮 + 它触发的补跑」都结束才收。
  const idleWaitersRef = useRef([])
  const load = useCallback(async (queue = false) => {
    // 手动刷新撞上在飞请求时不丢这次意图：记 pending，当前请求结束后再补一轮。
    // 轮询/可见性补拉不排队（queue=false），避免慢请求把轮询变成背靠背重试。
    if (busyRef.current) {
      if (queue) {
        pendingRef.current = true
        await new Promise((resolve) => { idleWaitersRef.current.push(resolve) })
      }
      return
    }
    busyRef.current = true
    try {
      do {
        pendingRef.current = false
        await loadRaw()
      } while (pendingRef.current)
    } finally {
      busyRef.current = false
      pendingRef.current = false
      const waiters = idleWaitersRef.current
      idleWaitersRef.current = []
      for (const done of waiters) done()
    }
  }, [loadRaw])
  // 下拉刷新走排队路径：在飞的手动刷新结束后再补一轮，不丢这次意图。
  usePullRefresh(active, () => load(true))
  // 日志筛选（v3.307）：run.log 尾部最多 1 MiB，排障时先按级别收窄；纯客户端过滤，
  // 不发新请求。默认「异常」已排除控制台生命周期行（旧口径 123 条异常里 119 条是它）。
  const [mode, setMode] = useState(initialMode)
  const [q, setQ] = useState(initialQuery)
  // v3.319：用户切分类/手改搜索词即视为收起定位条，切回「全部」也不再自动弹出。
  const [focusDismissed, setFocusDismissed] = useState(false)
  useEffect(() => { setMode(initialMode); setQ(initialQuery); setFocusDismissed(false) }, [initialMode, initialQuery])
  const preloadedRef = useRef(false)
  const revealedRef = useRef(active)
  const dataAtRef = useRef(0)
  useEffect(() => { if (data) dataAtRef.current = Date.now() }, [data])
  useEffect(() => {
    // 首访预加载：页签还没点开也先把日志拉下来；之后离开不拉，切回再补。
    if (!active && preloadedRef.current) return undefined
    const firstReveal = preloadedRef.current && active && !revealedRef.current
    const seeded = seededRef.current
    seededRef.current = false
    preloadedRef.current = true
    revealedRef.current = active
    // v3.318：跳转前 openLog 已取到快照，首帧就用它定稿，不再立刻重拉——慢网下
    // 第二次请求失败还会把有效日志盖成错误。之后切走再回来仍走下面的补拉。
    if (seeded) {
      // 快照已就位，本次挂载不发请求。
    } else if (firstReveal) {
      // 第一次点开时直接用预加载结果；只有预加载失败（没 data 也没在飞）或数据已超过
      // 5s 才补一发，避免点击瞬间再发请求把预加载响应顶掉（Sourcery #272）。
      const stale = !loading && (!data || Date.now() - dataAtRef.current > 5000)
      if (stale) load(true).catch(() => {})
    } else {
      // 切回本页时若上一发还在飞，load(true) 会排队补拉；load() 会直接丢弃这次刷新，
      // 保活后就会出现「回来了但日志是离开那刻的旧快照」（Sourcery #271）。
      load(true).catch(() => {})
    }
    if (!active) return undefined
    // 页面在后台时不轮询（切回前台由 App 统一补拉）：控制台常驻标签页也不该整夜每 5s 读盘。
    // 保活后离开本页即清掉定时器：隐藏的日志页不跟着刷。
    let t = null
    if (pollMs) {
      const tick = () => { if (document.visibilityState !== 'hidden') load().catch(() => {}) }
      t = setInterval(tick, pollMs)
    }
    return () => { if (t !== null) clearInterval(t) }
  }, [load, pollMs, active])
  const rawText = data && data.status === 'ok' && typeof data.text === 'string' ? data.text : ''
  // 1 MiB 文本的 split/lowercase 只在输入变化时做一次（审查 #248 可选：此前每次渲染
  // 3 次全量 split + 2 次 lowercase，手机输入关键字会掉帧）。
  const lines = useMemo(() => filterLogLines(rawText, 'all', ''), [rawText])
  const counts = useMemo(() => logLineCounts(rawText), [rawText])
  const kw = q.trim().toLowerCase()
  // v3.319：「只看这一轮」必须按行首时间戳收窄——普通关键字搜索会把正文里
  // 提到同一时间戳的其他行也带进来，看起来像「这一轮」有多行。
  // 用户已用「清除定位 / 选区间 / 改搜索」把定位条收起了，就不能再按 focusAt 收窄——
  // 否则选了区间也只剩那一轮的行（Sourcery #288 M5）。
  const focusOnly = focusAt !== '' && focusDate !== '' && q === focusAt && mode === 'all' && !focusDismissed
  // v3.326：按日期区间筛日志（客户端侧，行首时间戳前缀；不重拉 /api/logs）。
  const [logRange, setLogRange] = useState(EMPTY_RANGE)
  const logRangeActive = DAY_KEY_RE.test(logRange.from) && DAY_KEY_RE.test(logRange.to)
  const filtered = useMemo(() => {
    const base = filterLogLines(rawText, mode, q)
    return focusOnly ? base.filter((l) => l.startsWith(focusAt)) : base
  }, [rawText, mode, q, focusOnly, focusAt])
  const ranged = useMemo(
    () => (logRangeActive ? filtered.filter((l) => inDayRange(l.slice(0, 10), logRange)) : filtered),
    [filtered, logRangeActive, logRange.from, logRange.to])
  const shownText = useMemo(() => ranged.join('\n'), [ranged])
  // 高亮节点上限（v3.319）：超过 3000 行退回纯文本，定位也不再假装有高亮。
  const heavy = ranged.length > LOG_HIGHLIGHT_MAX
  // 虚拟窗口（v3.385）：setOptions 是**整份替换**（库内 defaults + 传入项），所以每次都
  // 给全量；heavy 时 count 归零并 disabled，纯文本分支不挂滚动监听、也不维护窗口。
  virt.setOptions({
    ...VIRT_ADAPTER,
    count: heavy ? 0 : ranged.length,
    enabled: !heavy,
    overscan: LOG_ROW_OVERSCAN,
    estimateSize: () => LOG_ROW_ESTIMATE_PX,
    getScrollElement: () => preRef.current,
    onChange: () => bumpVirt((n) => n + 1)
  })
  const virtItems = virt.getVirtualItems()
  const virtTotal = virt.getTotalSize()
  // v3.319：行级跳转的定位状态。day = 当天列表 + 高亮该轮；only = 只看该轮。
  // 用户切了分类/自己改了搜索词就收起定位条，避免和当前筛选打架。
  const focusHits = useMemo(() => (focusAt ? lines.filter((l) => l.startsWith(focusAt)).length : 0), [lines, focusAt])
  const focusHeavy = focusAt !== '' && mode === 'all' && q === focusDate && heavy && !focusDismissed
  const focusMode = focusDismissed || mode !== 'all' || focusAt === '' || focusHits === 0 || heavy
    ? ''
    : (q === focusAt ? 'only' : (q === focusDate ? 'day' : ''))
  const focusMiss = !focusDismissed && mode === 'all' && focusAt !== '' && focusHits === 0 && q === focusDate
  const LOG_MODES = [
    ['all', '全部', counts.all],
    ['issue', '异常', counts.issue],
    ['error', '错误', counts.error],
    ['alert', '告警', counts.alert],
    ['summary', '摘要', counts.summary],
    ['console', '控制台', counts.console]
  ]
  // virtual-core 的两步（官方 adapter 同款）：挂载时 _didMount（返回清理函数），
  // 之后每次 render 后 _willUpdate（重算区间 + 重挂 scroll/尺寸观察者）。
  useLayoutEffect(() => virt._didMount(), [])
  useLayoutEffect(() => { virt._willUpdate() })
  // 首屏与「原本就在底部」时跟随最新日志；用户上翻查看历史时不抢滚动位置。
  // 手动「刷新」与日志从不可读恢复时强制回到底部，避免「刷新后仍停在旧位置」。
  // v3.318：改用 layout effect——跳转时快照已在首帧，若等 paint 后再贴底，
  // 会先看到日志顶部再被拽到底部（一帧闪动）。
  useLayoutEffect(() => {
    const el = preRef.current
    if (!el || !data) return
    if (data.status !== 'ok') { stickRef.current = true; prevTextRef.current = ''; return }
    if (stickRef.current || prevTextRef.current === '') el.scrollTop = el.scrollHeight
    prevTextRef.current = shownText
    syncRail()
    // virtTotal 变化（新行进来、折行高度被量出来）也要重贴一次底：容器高度先变，
    // 不重贴就会停在「距底部正好差新增那几行」的位置。
  }, [data, mode, q, shownText, syncRail, virtTotal])
  // 日志/筛选变化后等一帧再量轨道（<pre> 高度落定后再算）；窗口尺寸变化同理。
  useEffect(() => {
    const id = window.requestAnimationFrame(syncRail)
    return () => window.cancelAnimationFrame(id)
  }, [data, mode, q, shownText, syncRail])
  useEffect(() => {
    const onResize = () => syncRail()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [syncRail])
  // 面板被切走时 display:none ⇒ 量到 0 高、条被隐藏；切回来不一定伴随 resize 或内容变化
  // （Sourcery #305 M1），所以 active 变 true 时必须重量一次，否则条一直不出现。
  useEffect(() => {
    if (!active) return
    const id = window.requestAnimationFrame(syncRail)
    return () => window.cancelAnimationFrame(id)
  }, [active, syncRail])
  // 日志框自身高度变化（视口转屏、字号/行高变化）不触发 window resize，用 ResizeObserver 兜住。
  useEffect(() => {
    const el = preRef.current
    if (!el || typeof window.ResizeObserver !== 'function') return
    const ro = new window.ResizeObserver(() => syncRail())
    ro.observe(el)
    return () => ro.disconnect()
  }, [data, syncRail])
  // v3.319：行级跳转把点中的那一轮滚到日志框中部；只做一次，轮询不抢用户滚动。
  // 用 useLayoutEffect：与贴底同一帧完成，首帧就是定位后的位置，不会先闪顶部/底部。
  useLayoutEffect(() => {
    if (!focusAt || focusDoneRef.current === focusAt) return
    if (heavy) return // 纯文本分支没有窗口，定位条此时已明说「高亮已关闭」
    // 行可能不在当前窗口里（虚拟滚动只挂可视区那几十行），所以按**索引**让虚拟器居中，
    // 不再量 focusRef 的矩形——那条路只在「这一行已经渲染出来」时才成立。
    const idx = ranged.findIndex((l) => l.startsWith(focusAt))
    if (idx < 0) return
    stickRef.current = false
    focusDoneRef.current = focusAt
    virt.scrollToIndex(idx, { align: 'center' })
  }, [data, focusAt, q, ranged, heavy, virt])
  const onLogScroll = () => {
    const el = preRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    syncRail()
  }
  const refreshNow = () => {
    stickRef.current = true
    load(true).catch(() => {})
  }
  const pickMode = (next) => {
    stickRef.current = true
    if (next !== mode) setFocusDismissed(true)
    setMode(next)
  }
  // v3.317：计数行/空态都必须点名筛选——只说「没有匹配的日志行」时，用户会以为
  // 关键词搜不到，其实是上一个 chip 还开着（实测：先点「控制台」再搜「推送」= 0 行）。
  const modeLabel = (LOG_MODES.find((m) => m[0] === mode) || ['', '全部'])[1]
  const countLine = [
    mode !== 'all'
      ? `在「${modeLabel}」筛选下 · 显示 ${ranged.length} / ${lines.length} 行`
      : ((kw !== '' || logRangeActive) ? `显示 ${ranged.length} / ${lines.length} 行` : `共 ${lines.length} 行`),
    (mode === 'issue' || mode === 'error') ? '已排除控制台停止记录' : '',
    heavy ? `行数过多（>${LOG_HIGHLIGHT_MAX}），已关闭高亮` : '',
    logRangeActive ? `日期 ${logRange.from} ~ ${logRange.to}` : '',
    mode === 'all' ? '分类可重叠' : ''
  ].filter(Boolean).join(' · ')
  const emptyText = lines.length === 0
    ? '（空）'
    : mode !== 'all'
      ? `在「${modeLabel}」筛选下没有匹配的日志行${kw !== '' ? `（关键词「${q.trim()}」）` : ''}`
      : '（没有匹配的日志行）'
  // 空态里的出口：把筛选交回「全部」，关键词保留（用户本来要搜的就是这个词）。
  const searchAllLogs = () => {
    stickRef.current = true
    setMode('all')
  }
  // 只渲染可视窗口（v3.385）：一行一个**块级** <span>，纵向位置由虚拟器给（transform，
  // 不触发布局），外层容器高度 = 全部行的总高（滚动条长度与真实行数一致）。块级行复制出来
  // 天然一行一条，不再靠 "\n" 文本节点；命中片段仍只作为 <mark> 的文本子节点，不拼 innerHTML。
  // heavy（>3000 行）时返回 null，走纯文本分支——护栏行为与 v3.320 一致。
  let lineNodes = null
  if (!heavy) {
    lineNodes = html`<span class="log-virt" style=${{ height: virtTotal + 'px' }}>${
      virtItems.map((it) => {
        const line = ranged[it.index]
        const tone = logLineTone(line)
        // v3.319：点中的那一轮加底色（只会在行首时间戳匹配）。
        const isFocus = focusAt !== '' && line.startsWith(focusAt)
        return html`<span class=${'logline' + (tone ? ' logline-' + tone : '') + (isFocus ? ' logline-focus' : '')}
          key=${it.index} data-index=${it.index} style=${{ transform: 'translateY(' + it.start + 'px)' }}
          ref=${virt.measureElement}>${
          splitHits(line, kw).map(([text, hit], j) => hit ? html`<mark key=${j}>${text}</mark>` : text)
        }</span>`
      })}</span>`
  }
  // v3.320：工具条与计数行不再等数据。旧版整块挂在 ok 分支里：首帧只有「读取中」占位
  // （panel 583），数据到达后筛选栏凭空插进来（+134）再加计数行（+19），日志框连下半页
  // 一起被推走 153px。现在 chips 用同一组标签、计数先显示 —，计数行显示「读取中…」。
  const logReady = !!(data && data.status === 'ok')
  const countText = logReady ? countLine : ((data || err) ? '—' : '读取中…')
  return html`<div class="panel">
    <${PanelHead} title="运行日志" level=${1} sub=${'run.log 尾部 1 MiB' + (pollMs ? ' · 任务运行中，实时跟随' : '')}
      right=${html`<${Button} variant="ghost" onClick=${refreshNow}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${/* v3.320：首帧就按最终高度占位（.log-empty 与 .logpre-main 同高）。旧版首帧只有
         90px，数据到达后 .logpre 一次性出现（776px），文档高度突跳一次。 */ ''}
    ${logReady && focusMode === 'day' && html`<div class="log-focus" role="status">
      <span class="log-focus-text">已定位：<span class="log-focus-time">${focusAt}</span> 这一轮${focusHits > 1 ? `（同秒 ${focusHits} 行，均已高亮）` : ''}</span>
      <button type="button" class="log-chip" onClick=${() => { focusDoneRef.current = ''; setQ(focusAt) }}>只看这一轮</button>
    </div>`}
    ${logReady && focusMode === 'only' && html`<div class="log-focus" role="status">
      <span class="log-focus-text">只看：<span class="log-focus-time">${focusAt}</span> 这一轮</span>
      <button type="button" class="log-chip" onClick=${() => { focusDoneRef.current = ''; setQ(focusDate) }}>看当天全部</button>
    </div>`}
    ${logReady && focusMiss && html`<div class="log-focus log-focus-miss" role="status">
      <span class="log-focus-text">这一轮不在当前日志尾部（可能已轮转），下面只显示当天其他轮次</span>
    </div>`}
    ${logReady && focusHeavy && html`<div class="log-focus log-focus-miss" role="status">
      <span class="log-focus-text">当天日志超过 ${LOG_HIGHLIGHT_MAX} 行，整行高亮已关闭</span>
      <button type="button" class="log-chip" onClick=${() => { stickRef.current = true; setQ(focusAt) }}>只看这一轮</button>
    </div>`}
    <div class="log-tools">
      <div class="log-chips" role="group" aria-label="日志筛选">
        ${LOG_MODES.map(([key, label, n]) => html`
          <button type="button" key=${key} class=${'log-chip' + (mode === key ? ' on' : '')}
            aria-pressed=${mode === key ? 'true' : 'false'} onClick=${() => pickMode(key)}>${label} <span class="log-chip-n">${logReady ? n : '—'}</span></button>`)}
      </div>
      ${active && html`<${DateRange} value=${logRange} onChange=${(r) => { stickRef.current = true; setFocusDismissed(true); setLogRange(r) }} />`}
      <input class="msg-search log-search" type="search" placeholder="搜索日志…" aria-label="搜索日志"
        value=${q} onInput=${(e) => { stickRef.current = true; setFocusDismissed(true); setQ(e.target.value) }} />
    </div>
    <div class="log-count">${countText}</div>
    ${!data && !err && html`<div class="log-empty" role="status">日志读取中…</div>`}
    ${/* v3.320：首次加载就失败时也给同高占位。旧版错误路径只有顶部 Hint，520px 日志框
         整个消失，跳转/切页后页面高度反向塌一次。 */ ''}
    ${err && !data && html`<div class="log-empty" role="status">日志读取失败</div>`}
    ${data && data.status !== 'ok' && html`<div class="log-empty">日志${data.status === 'missing' ? '尚未生成' : `不可读（${data.status}）`}</div>`}
    ${logReady && (ranged.length === 0
      ? html`<div class="log-empty" role="status">
        <div class="log-empty-text">${emptyText}</div>
        ${mode !== 'all' && html`<button type="button" class="log-chip" onClick=${searchAllLogs}>在全部日志中搜索</button>`}
      </div>`
      : html`<div class="log-wrap">
        <pre id="log-pre" class="logpre logpre-main" ref=${preRef} onScroll=${onLogScroll}>${heavy ? shownText : lineNodes}</pre>
        <div class=${'log-rail' + (rail.show ? ' show' : '')} ref=${railRef} role="scrollbar"
          aria-label="日志快速滚动条" aria-controls="log-pre" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow=${rail.pct} tabindex="0" onPointerDown=${onRailDown} onPointerMove=${onRailMove}
          onPointerUp=${onRailUp} onPointerCancel=${onRailUp} onKeyDown=${onRailKey}>
          <span class="log-thumb" style=${{ top: rail.top + 'px', height: rail.height + 'px' }}></span>
        </div>
      </div>`)}
  </div>`
}

// v3.342：控制台设置块（v3.340 在配置页，v3.342 搬到系统页「设置」）。
// 一条读面 + 两个写面：通知自检拦截窗、顶栏时间是否显示年月日。读面失败只影响本块。
function ConsoleSettingsBlock ({ settings, settingsErr, loadSettings, onSaved, active = true }) {
  // 拦截窗草稿：数字框是锁定只读的（手机端滚动/误触点一下就弹键盘，整行被挡住），
  // 调整只有「−/+」这一条路径：单击步进、长按连续加减，两端在 adjustWin 里夹到常量范围。
  // 不支持直接键入，所以这里也没有「非法输入」要拦——C7-046：旧注释声称可自由键入、
  // 保存前统一校验，而框是永久 disabled，那层校验永远进不去（已删）。
  // 用户正在改（dirty）时刷新回来的生效值不覆盖草稿，避免「改到一半被定时重拉吃掉」。
  const [winDraft, setWinDraft] = useState('')
  const [winDirty, setWinDirty] = useState(false)
  const [winErr, setWinErr] = useState('')
  const [winSaved, setWinSaved] = useState(false)
  const [winSaving, setWinSaving] = useState(false)
  const winSavingRef = useRef(false)
  const winSavedTimerRef = useRef(0)
  const [dateErr, setDateErr] = useState('')
  const [dateSaved, setDateSaved] = useState(false)
  const [dateSaving, setDateSaving] = useState(false)
  const dateSavingRef = useRef(false)
  const dateSavedTimerRef = useRef(0)
  useEffect(() => () => {
    clearTimeout(winSavedTimerRef.current)
    clearTimeout(dateSavedTimerRef.current)
  }, [])
  // 读面失败时显式丢弃旧值：绝不让「读取失败」的页面继续显示一个可能已经过期的生效值。
  const settingsLive = settingsErr ? null : settings
  // 「还没读到」与「读失败」在数据上都是 null，但含义相反：把首帧的加载中渲染成
  // 「读取失败 + 全部禁用」，设置块一打开就在报一个不存在的错误（网络慢时持续到超时）。
  const settingsPending = settingsLive === null && !settingsErr
  const winCurrent = settingsLive && settingsLive.settings && Number.isInteger(settingsLive.settings.notifyTestReplayWindowS)
    ? settingsLive.settings.notifyTestReplayWindowS
    : null
  const winSourceLabel = settingsPending
    ? '读取中…'
    : (settingsLive === null ? '读取失败' : (settingsLive.source === 'file' ? '来自设置文件' : '默认值'))
  const showDate = settingsLive && settingsLive.settings && typeof settingsLive.settings.syncShowDate === 'boolean'
    ? settingsLive.settings.syncShowDate
    : null
  // 只在生效值真的变了时回写草稿：保存成功会把 winDirty 由 true 拨回 false，也会触发本 effect，
  // 而那一刻 settings 还是旧值——无条件回写会把刚写入的新值改回旧值（重读失败时长期停在旧值）。
  const winSyncedRef = useRef(null)
  // 保存时提交「开始编辑那一刻」的 revision：草稿期间别的标签页改了值，
  // 轮询会把 settingsLive.revision 推到新值；若仍提交新 revision，服务端会以
  // 为是同一次修改而静默覆盖对方（Sourcery #303 M1）。钉住编辑起点才能收到 409。
  const winBaseRevRef = useRef(null)
  useEffect(() => {
    if (!winDirty) { winBaseRevRef.current = null; return }
    if (winBaseRevRef.current === null && settingsLive) winBaseRevRef.current = settingsLive.revision
  }, [winDirty, settingsLive])
  useEffect(() => {
    if (winDirty || winCurrent === null) return
    if (winSyncedRef.current === winCurrent) return
    winSyncedRef.current = winCurrent
    setWinDraft(String(winCurrent))
  }, [winCurrent, winDirty])
  // 草稿只可能来自下面同步 effect 的回填，或本函数上一次的夹取结果，必是 0–3600 的整数；
  // 首帧 effect 还没跑（草稿为空串）时以生效值为基准。夹取在写入时完成，保存端不再校验。
  const adjustWin = (delta) => {
    if (winCurrent === null || winSavingRef.current) return
    setWinDraft((prev) => {
      const base = prev === '' ? winCurrent : Number(prev)
      const next = Math.min(NOTIFY_WINDOW_MAX_S, Math.max(NOTIFY_WINDOW_MIN_S, base + delta))
      return String(next)
    })
    setWinDirty(true)
    setWinSaved(false)
    setWinErr('')
  }
  const holdWin = useHoldRepeat(adjustWin, winCurrent === null || winSaving)
  // 保存：草稿只会由 ± / 长按产生，写入时已经夹在 NOTIFY_WINDOW_MIN_S–NOTIFY_WINDOW_MAX_S，
  // 客户端没有「非法值」要拦（旧的那层校验对着永远 disabled 的框，永远进不去——C7-046 已删）。
  // 带 baseRevision 做乐观锁，别处改过就 409，这里重读让用户看清当前值再决定。
  const saveWin = async () => {
    setWinErr('')
    // 连点两次会各带同一个 baseRevision 发两次 POST，第二次必然 409——那是自己造的冲突，
    // 页面却会同时出现「已保存」和「设置已被别处改过」。入口与按钮双守卫。
    if (winSavingRef.current) return
    if (!settingsLive || winCurrent === null) { setWinErr('当前生效值未读到，先刷新再改'); return }
    // 首帧同步 effect 还没跑时草稿仍为空串：保存的就是生效值本身（不是 Number('') 的 0）。
    const next = winDraft === '' ? winCurrent : Number(winDraft)
    winSavingRef.current = true
    setWinSaving(true)
    try {
      const res = await apiPostConsoleSettings({ notifyTestReplayWindowS: next, baseRevision: winBaseRevRef.current === null ? settingsLive.revision : winBaseRevRef.current })
      const payload = res.data && typeof res.data === 'object' ? res.data : {}
      if (!res.ok) {
        if (payload.error === 'revision_mismatch') {
          setWinErr('设置已被别处改过（revision 不一致），已重新读取，请确认后再保存')
          // 必须复位 dirty：否则本页草稿再也不会跟随刷新，只能整页重载才能回到可保存状态。
          setWinDirty(false)
          await loadSettings()
          return
        }
        setWinErr(`保存失败：${payload.error || `HTTP ${res.status}`}`)
        return
      }
      const saved = payload.settings && Number.isInteger(payload.settings.notifyTestReplayWindowS)
        ? payload.settings.notifyTestReplayWindowS
        : next
      setWinDraft(String(saved))
      setWinDirty(false)
      setWinSaved(true)
      clearTimeout(winSavedTimerRef.current)
      winSavedTimerRef.current = setTimeout(() => setWinSaved(false), 1500)
      await loadSettings()
      if (typeof onSaved === 'function') onSaved()
    } catch (e) {
      setWinErr(`保存失败：${e && e.message ? e.message : e}`)
    } finally {
      winSavingRef.current = false
      setWinSaving(false)
    }
  }
  // 显示开关：勾一下就保存（不再要一次「保存」）；失败重读并报错，勾选状态跟随服务端。
  const toggleShowDate = async (next) => {
    setDateErr('')
    if (dateSavingRef.current) return
    if (!settingsLive || showDate === null) { setDateErr('当前设置未读到，先刷新再改'); return }
    if (next === showDate) return
    dateSavingRef.current = true
    setDateSaving(true)
    try {
      const res = await apiPostConsoleSettings({ syncShowDate: next, baseRevision: settingsLive.revision })
      const payload = res.data && typeof res.data === 'object' ? res.data : {}
      if (!res.ok) {
        setDateErr(payload.error === 'revision_mismatch'
          ? '设置已被别处改过（revision 不一致），已重新读取'
          : `保存失败：${payload.error || `HTTP ${res.status}`}`)
        await loadSettings()
        return
      }
      await loadSettings()
      if (typeof onSaved === 'function') onSaved()
      setDateSaved(true)
      clearTimeout(dateSavedTimerRef.current)
      dateSavedTimerRef.current = setTimeout(() => setDateSaved(false), 1500)
    } catch (e) {
      setDateErr(`保存失败：${e && e.message ? e.message : e}`)
    } finally {
      dateSavingRef.current = false
      setDateSaving(false)
    }
  }
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">通知自检</span>
      <span class="cfg-block-sub">重复提交拦截窗 · ${winSourceLabel}</span>
    </div>
    ${/* 系统页未激活时不生成这一排工具条（L4 同 TriggerBar）：保活挂载的面板
         不应在别的页留下 hidden 的 auto-run-row 副本；winDraft 等草稿由本组件
         state 持有，切走再回来不会丢。 */ ''}
    ${active && html`<div class="auto-run-row">
      <button type="button" class="auto-step" aria-label="减少" disabled=${winCurrent === null || winSaving}
        onPointerDown=${holdWin.start(-1)} onPointerUp=${holdWin.stop} onPointerLeave=${holdWin.stop}
        onPointerCancel=${holdWin.stop} onLostPointerCapture=${holdWin.stop}
        onContextMenu=${holdWin.contextMenu} onClick=${holdWin.click(-1)}>−</button>
      <input class="auto-input" type="number" inputmode="numeric"
        min=${NOTIFY_WINDOW_MIN_S} max=${NOTIFY_WINDOW_MAX_S} step="1"
        aria-label="通知自检拦截窗（秒）" value=${winCurrent === null ? '' : winDraft} disabled=${true} />
      <span class="auto-unit">秒</span>
      <button type="button" class="auto-step" aria-label="增加" disabled=${winCurrent === null || winSaving}
        onPointerDown=${holdWin.start(1)} onPointerUp=${holdWin.stop} onPointerLeave=${holdWin.stop}
        onPointerCancel=${holdWin.stop} onLostPointerCapture=${holdWin.stop}
        onContextMenu=${holdWin.contextMenu} onClick=${holdWin.click(1)}>+</button>
      <${Button} variant="secondary" disabled=${winCurrent === null || winSaving} onClick=${saveWin}>保存<//>
      ${winSaved && html`<span class="cfg-block-sub" role="status" aria-live="polite">已保存 · 立即生效</span>`}
    </div>`}
    <div class="cfg-text">${settingsPending
      ? '正在读取当前生效值…'
      : winCurrent === null
        ? `当前生效值读取失败，暂不可修改（点右上「刷新」重试）：${settingsErr || '未知错误'}`
        : `当前生效 ${winCurrent} 秒 · 0 = 关闭拦截（连点会重复真实发送）· 点 ± 调整、长按连续加减（输入框锁定，不支持直接键入）· 保存后下一次触发立即生效`}</div>
    ${winErr && html`<${Hint} tone="error">${winErr}<//>`}
    <div class="cfg-block-head set-head">
      <span class="cfg-block-title">顶栏时间</span>
      <span class="cfg-block-sub">「数据截至 / 自动刷新」后面那个时间</span>
    </div>
    <label class="set-toggle">
      <input type="checkbox" checked=${showDate === true} disabled=${showDate === null || dateSaving}
        onChange=${(e) => toggleShowDate(e.target.checked)} />
      <span>显示年月日</span>
      <span class="cfg-block-sub" role=${dateSaved ? 'status' : undefined} aria-live=${dateSaved ? 'polite' : undefined}>${dateSaving
        ? '保存中…'
        : dateSaved
          ? '已保存 · 立即生效'
          : showDate === null
            ? (settingsPending ? '读取中…' : '读取失败')
            : (showDate ? '关掉后只显示 时:分:秒' : '当前只显示 时:分:秒')}</span>
    </label>
    ${dateErr && html`<${Hint} tone="error">${dateErr}<//>`}
  </div>`
}

// 系统信息：版本 / 运行环境 / 进程 / 缓存目录。只读；下面另挂「设置」块（可写）。
// 数据备份：导出时勾选类别；导入时不勾，文件里有什么就恢复什么。
const BACKUP_CATEGORY_OPTIONS = [
  { key: 'messages', label: '推送记录', desc: '历史消息（会覆盖当前推送记录）' },
  { key: 'filter', label: '过滤规则', desc: '覆盖文件与过滤设置' },
  { key: 'settings', label: '控制台设置', desc: '拦截窗、顶栏时间显示' },
  { key: 'auto', label: '自动运行间隔', desc: '只恢复间隔，不会打开自动运行' },
  { key: 'runLog', label: '运行日志', desc: 'run.log 运行记录' }
]

function backupFileSummary (data) {
  const parts = []
  if (data && data.messages) {
    const n = Number.isInteger(data.messages.count) ? data.messages.count : null
    parts.push(`推送记录${n === null ? '' : ` ${n} 条`}`)
    if (data.messages.seenText) parts.push('判重历史')
  }
  if (data && data.filter) parts.push('过滤规则')
  if (data && data.settings) parts.push('控制台设置')
  if (data && data.auto) parts.push(`自动运行间隔 ${data.auto.interval} 秒`)
  if (data && data.runLog) parts.push(`运行日志约 ${fmtBytes((data.runLog.text || '').length)}`)
  return parts
}

// 同一次「选文件→确认导入」的重试沿用同一个幂等键；成功后弹窗关闭，下次重新生成。
let backupImportSeq = 0
function newBackupImportKey () {
  try {
    const c = globalThis.crypto
    if (c && typeof c.getRandomValues === 'function') {
      const b = new Uint32Array(4)
      c.getRandomValues(b)
      return `xbk-import-${Array.from(b, (n) => n.toString(16).padStart(8, '0')).join('')}`
    }
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  } catch (e) { /* 非安全上下文/老浏览器：退回时间戳+进程内序号 */ }
  backupImportSeq += 1
  return `xbk-import-${Date.now().toString(36)}-${backupImportSeq}`
}

// 数据备份 / 恢复整块流程收在右侧抽屉里：系统页只留一个入口按钮 + 一行摘要（上次导出/导入）。
// 导出类别、密码、导入选文件与解密都在抽屉内完成；导入的最终确认仍是短弹窗（ConfirmDialog）。
// 安全边界不变：导出必须在 HTTPS 下、在浏览器内加密（window.isSecureContext 检查排在调用导出接口之前），
// 密码只留在页面内存；导入沿用同一次「选文件 → 确认」的幂等键，重复提交由服务端按 key 返回原结果。
function backupEntrySummary (last) {
  if (!last || !Number.isFinite(last.at)) return '加密导出（需 HTTPS）· 导入前自动备份当前数据'
  const d = new Date(last.at)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${last.kind === 'import' ? '上次导入' : '上次导出'} ${stamp}${last.detail ? ` · ${last.detail}` : ''}`
}

function BackupBlock ({ onImported }) {
  const [selected, setSelected] = useState(() => {
    const out = {}
    for (const item of BACKUP_CATEGORY_OPTIONS) out[item.key] = true
    return out
  })
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(null)
  const [open, setOpen] = useState(false)
  const [last, setLast] = useState(null)
  const [locked, setLocked] = useState(null)
  const [exportPassword, setExportPassword] = useState('')
  const [exportPassword2, setExportPassword2] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const fileRef = useRef(null)
  const unlockRef = useRef(null)
  const allSelected = BACKUP_CATEGORY_OPTIONS.every((item) => selected[item.key])
  const hasSelected = BACKUP_CATEGORY_OPTIONS.some((item) => selected[item.key])
  const passwordProblem = backupPasswordProblem(exportPassword, exportPassword2)
  // 只用于提示；真正的硬校验仍在 doExport 里、且在调用导出接口之前。
  const canEncrypt = !!(window.isSecureContext && window.crypto && window.crypto.subtle)
  const toggleAll = () => {
    const next = {}
    for (const item of BACKUP_CATEGORY_OPTIONS) next[item.key] = !allSelected
    setSelected(next)
  }
  const toggleOne = (key) => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }))
  }
  // 加密备份需要用户输入口令：抽屉里出现密码框时把焦点放进去（只依赖 open/locked，busy 变化不抢焦点）。
  useEffect(() => {
    if (open && locked && unlockRef.current) unlockRef.current.focus({ preventScroll: true })
  }, [open, locked])
  const doExport = async () => {
    if (busy !== '') return
    const categories = BACKUP_CATEGORY_OPTIONS.filter((item) => selected[item.key]).map((item) => item.key)
    if (categories.length === 0) { setErr('至少勾选一项再导出'); return }
    if (passwordProblem !== '') { setErr(passwordProblem); return }
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
      setErr('当前页面不是 HTTPS，浏览器无法加密备份；请用 https:// 打开控制台')
      return
    }
    setBusy('export'); setErr(''); setNote('')
    let url = ''
    try {
      const res = await apiPostBackupExport(categories)
      let bundle
      try {
        bundle = JSON.parse(res.text)
      } catch (e) {
        throw new Error('服务器返回的备份不是有效 JSON')
      }
      if (!bundle || bundle.kind !== 'xbk-console-backup' || bundle.schema !== 1 || !bundle.data) {
        throw new Error('服务器返回的备份格式不对')
      }
      const packed = await encryptBackup(bundle, exportPassword)
      const blob = new Blob([JSON.stringify(packed)], { type: 'application/json' })
      url = URL.createObjectURL(blob)
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      const a = document.createElement('a')
      a.href = url
      a.download = `xbk-backup-${stamp}.xbk`
      document.body.appendChild(a)
      a.click()
      a.remove()
      const skipped = res && res.skipped ? res.skipped : []
      setExportPassword(''); setExportPassword2('')
      setLast({ kind: 'export', at: Date.now(), detail: fmtBytes(blob.size) })
      setNote(`已导出${categories.length}类加密备份${skipped.length > 0 ? `；另有 ${skipped.length} 类当前没有可导出的内容` : ''}`)
    } catch (e) {
      setErr(`导出失败：${e && e.message ? e.message : e}`)
    } finally {
      if (url !== '') setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { /* 已回收 */ } }, 60000)
      setBusy('')
    }
  }
  const openDrawer = () => {
    setErr(''); setOpen(true)
  }
  // 抽屉关闭统一走这里：导入/导出/解密进行中（busy）一律不关；关掉时清掉只属于本次的密码与提示。
  const closeDrawer = () => {
    if (busy !== '') return
    setOpen(false)
    setPending(null)
    setLocked(null)
    setUnlockPassword('')
    setExportPassword('')
    setExportPassword2('')
    setErr('')
    setNote('')
  }
  const chooseFile = () => {
    if (busy === '') fileRef.current && fileRef.current.click()
  }
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // 允许重复选同一个文件
    if (!file) return
    setErr(''); setNote('')
    if (file.size > BACKUP_FILE_MAX_BYTES) { setErr('备份文件太大（上限 48MB）'); return }
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (isEncryptedBackup(data)) {
        if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
          throw new Error('加密备份需要在 HTTPS 页面打开')
        }
        setPending(null)
        setLocked({ data, name: file.name })
        setUnlockPassword('')
        return
      }
      if (!data || data.kind !== 'xbk-console-backup' || data.schema !== 1 || !data.data || typeof data.data !== 'object') {
        throw new Error('这不是控制台备份文件')
      }
      const parts = backupFileSummary(data.data)
      if (parts.length === 0) throw new Error('备份文件里没有可恢复的数据')
      setLocked(null)
      setPending({ bundle: data, summary: parts, key: newBackupImportKey(), encrypted: false })
    } catch (e) {
      setErr(`读取备份失败：${e && e.message ? e.message : e}`)
    }
  }
  const doUnlock = async () => {
    if (!locked || busy !== '') return
    if (unlockPassword === '') { setErr('请输入备份密码'); return }
    setBusy('unlock'); setErr('')
    try {
      const bundle = await decryptBackup(locked.data, unlockPassword)
      const parts = backupFileSummary(bundle.data)
      if (parts.length === 0) throw new Error('备份文件里没有可恢复的数据')
      setPending({ bundle, summary: parts, key: newBackupImportKey(), encrypted: true })
      setLocked(null)
      setUnlockPassword('')
    } catch (e) {
      setErr(`解密失败：${e && e.message ? e.message : e}`)
    } finally {
      setBusy('')
    }
  }
  const closeUnlock = () => {
    if (busy === 'unlock') return
    setLocked(null); setUnlockPassword(''); setErr('')
  }
  const doImport = async () => {
    if (!pending || busy !== '') return
    setBusy('import'); setErr('')
    try {
      const res = await apiPostBackupImport(pending.bundle, pending.key)
      // consumeJsonResult 对非 2xx 只回 { ok:false, status, data }，不抛错：409 busy /
      // 400 校验失败 / 507 审计满原本都会走进成功分支并提示「导入完成」。先过这一道；
      // 抛错时 pending 不清 ⇒ 确认弹窗仍开着、错误显示在弹窗里，可直接改完重试。
      const problem = backupImportProblem(res)
      if (problem !== '') throw new Error(problem)
      setPending(null)
      const result = res && res.data ? res.data : (res || {})
      const imported = result.imported ? result.imported : {}
      const bits = []
      if (Number.isInteger(imported.messages)) bits.push(`推送记录 ${imported.messages} 条`)
      if (imported.dedup) bits.push('判重历史')
      if (imported.filter) bits.push('过滤规则')
      if (imported.settings) bits.push('控制台设置')
      if (Number.isInteger(imported.autoInterval)) bits.push(`自动运行间隔 ${imported.autoInterval} 秒`)
      if (Number.isInteger(imported.runLogBytes)) bits.push('运行日志')
      setLast({ kind: 'import', at: Date.now(), detail: bits.length > 0 ? `${bits.length} 类数据` : '' })
      setNote(`导入完成${bits.length > 0 ? `：${bits.join('、')}` : ''}${result.backupDir ? `。当前数据已先备份到 ${result.backupDir}` : ''}`)
      if (typeof onImported === 'function') Promise.resolve(onImported()).catch(() => {})
    } catch (e) {
      setErr(`导入失败：${e && e.message ? e.message : e}`)
    } finally {
      setBusy('')
    }
  }
  return html`<div class="cfg-block backup-block">
    <div class="backup-actions backup-actions-main">
      <${Button} variant="secondary" onClick=${openDrawer}>数据备份与恢复<//>
      <span class="cfg-block-sub">${backupEntrySummary(last)}</span>
    </div>
    <${Drawer} open=${open} title="数据备份与恢复" sub="加密导出 · 导入前自动备份当前数据" width=${520} busy=${busy !== '' || !!pending} onClose=${closeDrawer}>
      <div class="cfg-block-head">
        <span class="cfg-block-title">导出</span>
        <span class="cfg-block-sub">勾选类别，在本机加密后下载</span>
      </div>
      <div class="backup-pick-head">
        <label class="backup-check"><input type="checkbox" checked=${allSelected} onChange=${toggleAll} /> 全选</label>
        <span class="cfg-block-sub">只导出勾选的类别</span>
      </div>
      <div class="backup-list">
        ${BACKUP_CATEGORY_OPTIONS.map((item) => html`<label class="backup-item" key=${item.key}>
          <input type="checkbox" checked=${selected[item.key] === true} onChange=${() => toggleOne(item.key)} />
          <span class="backup-item-main">${item.label}</span>
          <span class="cfg-block-sub">${item.desc}</span>
        </label>`)}
      </div>
      <div class="backup-pass-box">
        <label class="backup-pass-row">设置备份密码
          <input class="fr-input" type="password" value=${exportPassword} autocomplete="new-password" onInput=${(e) => setExportPassword(e.target.value)} />
        </label>
        <label class="backup-pass-row">再输一次
          <input class="fr-input" type="password" value=${exportPassword2} autocomplete="new-password" onInput=${(e) => setExportPassword2(e.target.value)} />
        </label>
        <div class="cfg-block-sub">至少 12 位；建议用一句长口令或密码管理器生成的随机密码。密码忘了，这份备份就打不开；密码只在浏览器里使用，不会发给服务器。</div>
        ${exportPassword !== '' && passwordProblem !== '' && html`<${Hint} tone="error">${passwordProblem}<//>`}
      </div>
      <div class="backup-actions">
        <${Button} variant="primary" disabled=${busy !== '' || !hasSelected} onClick=${doExport}>${busy === 'export' ? '加密中…' : '加密并下载'}<//>
      </div>
      ${canEncrypt ? null : html`<${Hint} tone="warn">当前页面不是 HTTPS，浏览器无法加密备份；请用 https:// 打开控制台。<//>`}
      <div class="modal-note">自动运行只备份间隔，不记录开关状态；导入时不会把自动运行打开。浏览器加密导出最多 32MB；更大的备份请减少勾选类别。</div>
      ${!pending && err && html`<${Hint} tone="error">${err}<//>`}
      ${note && html`<${Hint}>${note}<//>`}
      <div class="cfg-block-head set-head">
        <span class="cfg-block-title">导入</span>
        <span class="cfg-block-sub">选择 .xbk 加密备份或旧的明文 .json；导入前自动备份当前数据</span>
      </div>
      <div class="backup-actions backup-actions-main">
        <${Button} variant="secondary" disabled=${busy !== ''} onClick=${chooseFile}>选择备份文件<//>
        <input class="backup-file" ref=${fileRef} type="file" accept=".xbk,.json,application/json" onChange=${onFile} />
      </div>
      ${locked && html`<div class="backup-pass-box">
        <div>这是加密备份：${locked.name}</div>
        <label class="backup-pass-row">备份密码
          <input class="fr-input" ref=${unlockRef} type="password" value=${unlockPassword} autocomplete="current-password" onInput=${(e) => setUnlockPassword(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && unlockPassword !== '' && busy === '') doUnlock().catch(() => {}) }} />
        </label>
        ${err && html`<${Hint} tone="error">${err}<//>`}
        <div class="backup-actions">
          <${Button} variant="primary" disabled=${busy !== '' || unlockPassword === ''} onClick=${doUnlock}>${busy === 'unlock' ? '解密中…' : '解密'}<//>
          <${Button} variant="ghost" disabled=${busy !== ''} onClick=${closeUnlock}>取消<//>
        </div>
        <div class="modal-note">密码只在这个浏览器里使用，不会发给服务器。解密后再确认导入。</div>
      </div>`}
      <div class="modal-note">导入会覆盖当前对应的数据；导入前会先把当前数据另存一份。自动运行开关不会被打开，仍保持导入前的状态。导入期间请先停掉外部定时任务，避免它用旧缓存覆盖刚恢复的记录。</div>
      <${ConfirmDialog} open=${!!pending} title="确认导入备份" confirmLabel=${busy === 'import' ? '导入中…' : '确认导入'} busy=${busy === 'import'} onCancel=${() => { if (busy !== 'import') setPending(null) }} onConfirm=${doImport}>
        <div>文件里检测到：${pending ? pending.summary.join('、') : ''}</div>
        ${pending && pending.encrypted && html`<${Hint}>已在本机解密；密码没有发给服务器。<//>`}
        ${pending && !pending.encrypted && html`<${Hint} tone="warn">这是未加密的旧备份，文件里是明文；可以用，但建议以后导出加密备份。<//>`}
        <div class="modal-note">导入会覆盖当前对应的数据；自动运行开关保持导入前的状态。导入期间请先停掉外部定时任务。</div>
        ${pending && err && html`<${Hint} tone="error">${err}<//>`}
      <//>
    <//>
  </div>`
}

// 复制兜底（v3.385）：navigator.clipboard 只在安全上下文（https / localhost）存在——手机用
// http://192.168.x.x 打开控制台时它是 undefined，两步验证的「复制」会 100% 失败。
// execCommand('copy') 虽已废弃，但正是这种场景下唯一还能用的接口（Chrome/Safari/Firefox 都保留），
// 用完即删 textarea，不往页面留节点、也不改选中态。
function copyViaTextarea (text) {
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '') // 只读：iOS 不弹键盘
  el.style.position = 'fixed'
  el.style.top = '-1000px'
  document.body.appendChild(el)
  let ok = false
  try {
    el.select()
    // iOS Safari 只认 setSelectionRange（单靠 select() 复制出来是空串）。
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, String(text).length)
    ok = typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch (e) {
    ok = false
  } finally {
    if (el.parentNode) el.parentNode.removeChild(el)
  }
  return ok
}

// 两步验证（v3.357）：系统页里的可选开关。二维码由服务端 qrcode-generator 生成
// （SVG data URI，不引 CDN/不增加前端构建），同时保留手动密钥兜底；确认后服务端只回一次
// 恢复码，页面如实提示「只显示一次」。
function TwoFactorBlock ({ active = true }) {
  const [status, setStatus] = useState(null)
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableCode, setDisableCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    setErr('')
    return apiGetTwoFactorStatus().then(setStatus).catch((e) => {
      setErr(`两步验证状态读取失败：${e && e.message ? e.message : e}`)
    })
  }, [])
  // 系统页没显示时不拉：面板挂在页签容器里，未激活时打 /api/two-factor/status 纯属浪费（Sourcery #315-9）。
  useEffect(() => {
    if (!active) return
    load().catch(() => {})
  }, [active, load])

  const messageOf = (res) => {
    const data = res && res.data ? res.data : {}
    if (data.message) return data.message
    if (data.error) return data.error
    return `HTTP ${res && res.status ? res.status : '?'}`
  }
  const startSetup = async () => {
    if (busy !== '') return
    setBusy('setup'); setErr(''); setNote(''); setRecoveryCodes([])
    try {
      const res = await apiPostTwoFactorSetup()
      if (!res.ok) throw new Error(messageOf(res))
      setSetup(res.data || null)
      setCode('')
    } catch (e) {
      setErr(`生成设置密钥失败：${e && e.message ? e.message : e}`)
    } finally {
      setBusy('')
    }
  }
  const enable = async () => {
    if (busy !== '' || !setup || code.trim().length < 6) return
    setBusy('enable'); setErr(''); setNote('')
    try {
      const res = await apiPostTwoFactorEnable(code.trim(), setup.setupId)
      if (!res.ok) throw new Error(messageOf(res))
      const data = res.data || {}
      setRecoveryCodes(Array.isArray(data.recoveryCodes) ? data.recoveryCodes : [])
      setStatus({ enabled: true, pending: false, recoveryRemaining: data.recoveryRemaining || 0 })
      setSetup(null)
      setCode('')
      setNote('两步验证已开启。下次打开控制台要再输一次手机上的 6 位数字。')
    } catch (e) {
      setErr(`确认开启失败：${e && e.message ? e.message : e}`)
    } finally {
      setBusy('')
    }
  }
  const disable = async () => {
    if (busy !== '' || disableCode.trim() === '') return
    setBusy('disable'); setErr(''); setNote('')
    try {
      const res = await apiPostTwoFactorDisable(disableCode.trim())
      if (!res.ok) throw new Error(messageOf(res))
      setStatus({ enabled: false, pending: false, recoveryRemaining: 0 })
      setDisableOpen(false)
      setDisableCode('')
      setRecoveryCodes([])
      setNote('两步验证已关闭。')
    } catch (e) {
      setErr(`关闭失败：${e && e.message ? e.message : e}`)
    } finally {
      setBusy('')
    }
  }
  // 「退出所有信任设备」（v3.374）：清空服务端列表并让这台浏览器的设备 Cookie 失效，
  // 之后每台设备（包括当前这台）下次打开都要重新输验证码。
  const revokeDevices = async () => {
    if (busy !== '') return
    setBusy('revoke'); setErr(''); setNote('')
    try {
      const res = await apiPostDevicesRevoke()
      if (!res.ok) throw new Error(messageOf(res))
      setStatus((prev) => ({ ...(prev || {}), trustedDevices: 0 }))
      setNote('所有信任设备都已退出。下次在任何设备上打开控制台，都要重新输验证码。')
    } catch (e) {
      setErr(`退出信任设备失败：${e && e.message ? e.message : e}`)
    } finally {
      setBusy('')
    }
  }
  const copyText = async (text) => {
    let err = null
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
      } else {
        err = new Error('浏览器不支持剪贴板接口')
      }
    } catch (e) {
      err = e
    }
    // 异步剪贴板不可用 / 被拒（非安全上下文、没拿到用户激活、权限策略）→ 退回 execCommand。
    // 两条都失败才报错：http://局域网 IP 打开时这是唯一能用的那条路。
    if (err === null || copyViaTextarea(text)) {
      setNote('已复制到剪贴板。')
      setErr('') // 上一次失败的红条要一起撤掉，否则「复制失败」和「已复制」同屏
      return
    }
    setErr(`复制失败：${err && err.message ? err.message : err}；请手动选中密钥复制。`)
  }
  const secretGroups = setup && typeof setup.secret === 'string'
    ? setup.secret.replace(/(.{4})/g, '$1 ').trim()
    : ''
  return html`<div class="cfg-block twofa-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">两步验证</span>
      <span class="cfg-block-sub">Google Authenticator · 可选</span>
    </div>
    ${status === null && !err && html`<div class="empty" role="status">读取中…</div>`}
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${note && html`<${Hint}>${note}<//>`}
    ${status && !status.enabled && !setup && html`<div class="twofa-row">
      <div class="cfg-block-sub">还没开启。开启后，打开控制台要先过访问令牌，再输入手机上的 6 位数字。</div>
      <${Button} variant="secondary" disabled=${busy !== ''} onClick=${startSetup}>${busy === 'setup' ? '生成中…' : '开启两步验证'}<//>
    </div>`}
    ${setup && html`<div class="twofa-setup">
      <div class="twofa-step">1. 打开 Google Authenticator，点右下角 “+”。</div>
      ${setup.qrDataUrl && html`<div class="twofa-qr"><img src=${setup.qrDataUrl} alt="两步验证二维码，用 Google Authenticator 扫描" width="200" height="200" /></div>`}
      <div class="twofa-step">${setup.qrDataUrl ? '2. 能扫码就选“扫描二维码”；扫不了就选“输入设置密钥”，' : '2. 选“输入设置密钥”，'}账户名填 <code>xbk-push</code>，把下面这串密钥粘进去（不区分大小写）：</div>
      <div class="twofa-secret"><code>${secretGroups}</code><${Button} variant="ghost" disabled=${busy !== ''} onClick=${() => copyText(setup.secret)}>复制<//></div>
      <div class="twofa-step">3. 输入 App 里显示的 6 位数字，确认开启：</div>
      <div class="twofa-code-row">
        <input class="fr-input" aria-label="Google Authenticator 6 位验证码" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value=${code} onInput=${(e) => setCode(e.target.value)} placeholder="000000" />
        <${Button} variant="primary" disabled=${busy !== '' || code.trim().length < 6} onClick=${enable}>${busy === 'enable' ? '确认中…' : '确认开启'}<//>
        <${Button} variant="ghost" disabled=${busy !== ''} onClick=${() => { setSetup(null); setCode('') }}>取消<//>
      </div>
      <div class="cfg-block-sub">这串密钥等同于第二把钥匙，别发到聊天里；确认后恢复码只显示一次。</div>
    </div>`}
    ${status && status.enabled && html`<div class="twofa-row">
      <div><span class="twofa-on">已开启</span> <span class="cfg-block-sub">恢复码剩余 ${status.recoveryRemaining || 0} 个</span></div>
      <${Button} variant="danger" disabled=${busy !== ''} onClick=${() => { setDisableOpen(true); setDisableCode('') }}>关闭两步验证<//>
    </div>`}
    ${status && status.enabled && html`<div class="twofa-row">
      <div class="cfg-block-sub">已记住 ${status.trustedDevices || 0} 台设备。勾了「记住这台设备」的浏览器，90 天内打开控制台不用再输验证码；最多记 20 台，满了自动把最久没用的挤掉。</div>
      <${Button} variant="secondary" disabled=${busy !== '' || !(status.trustedDevices > 0)} onClick=${revokeDevices}>${busy === 'revoke' ? '退出中…' : '退出所有信任设备'}<//>
    </div>`}
    ${disableOpen && html`<div class="twofa-setup">
      <div class="twofa-step">关闭前先输一次当前验证码（或恢复码）：</div>
      <div class="twofa-code-row">
        <input class="fr-input" aria-label="关闭两步验证的验证码" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="24" value=${disableCode} onInput=${(e) => setDisableCode(e.target.value)} placeholder="6 位数字或恢复码" />
        <${Button} variant="danger" disabled=${busy !== '' || disableCode.trim() === ''} onClick=${disable}>${busy === 'disable' ? '关闭中…' : '确认关闭'}<//>
        <${Button} variant="ghost" disabled=${busy !== ''} onClick=${() => { setDisableOpen(false); setDisableCode('') }}>取消<//>
      </div>
    </div>`}
    ${recoveryCodes.length > 0 && html`<div class="twofa-recovery">
      <div class="twofa-step">恢复码（只显示这一次，请抄到离线地方；每串只能用一次）：</div>
      <div class="twofa-codes">${recoveryCodes.map((c) => html`<code key=${c}>${c}</code>`)}</div>
      <${Button} variant="ghost" disabled=${busy !== ''} onClick=${() => copyText(recoveryCodes.join('\n'))}>复制全部<//>
    </div>`}
    <${Hint}>两步验证只保护浏览器打开控制台；接口仍使用访问令牌。手机丢了用恢复码，恢复码丢了只能让部署者删除 <code>console-2fa.json</code> 后重配。<//>
  </div>`
}

function SysPanel ({ onReady, active = true, onSettingsSaved, pollTick = 0, onFresh, onSettings }) {
  // 访问日志（v3.300 §3.3）：第二个 loader 并列拉取；「刷新」按钮同日 load 两个。
  // 近窗未授权尝试数 = 服务端独立 401 计数（进程启动以来、不随环形窗截断）。
  // 两个请求可能一成一败：本页不认「数据截至」，避免半套数据被标成完整刷新（Sourcery PR#253）。
  // 保活后 data 不会清空，ready 也一直为真：必须等同一次刷新里的两个请求都结算，
  // 才能报「数据截至」；只跟其中一个会在访问日志还是旧快照时提前更新时间（Sourcery #272）。
  const { data: sys, err, load } = usePanelLoader(apiGetSys)
  // v3.335：系统页「检查更新」——页内下拉只刷数据、不换脚本，旧标签页得有个就地入口。
  // 比对的是页面启动版本（BOOT.version）与服务端当前版本；不一致就刷新整页。
  const [verState, setVerState] = useState('') // '' | 'checking' | 'latest' | 'stale' | 'error'
  const verTimerRef = useRef(0)
  const verSeqRef = useRef(0)
  const verBusyRef = useRef(false) // 同步闸：同一 tick 连点只发一次探针（state 要等重渲染）
  useEffect(() => () => clearTimeout(verTimerRef.current), [])
  const checkVersion = () => {
    // stale：已经判定有新版本、刷新已排期——这时再点不得取消那次刷新。
    if (verBusyRef.current || verState === 'stale') return
    verBusyRef.current = true
    const seq = ++verSeqRef.current
    clearTimeout(verTimerRef.current)
    setVerState('checking')
    apiGetSys({ probeVersion: true }).then((s) => {
      if (seq !== verSeqRef.current) return // 乱序响应：旧探针不得覆盖新判定
      const v = s && typeof s.version === 'string' ? s.version : ''
      clearTimeout(verTimerRef.current)
      if (v !== '' && v !== BOOT.version) {
        setVerState('stale')
        verTimerRef.current = setTimeout(() => window.location.reload(), 600)
        return // stale 不放开闸：刷新已排期，等 reload
      }
      verBusyRef.current = false
      setVerState('latest')
      verTimerRef.current = setTimeout(() => setVerState(''), 2500)
    }).catch(() => {
      if (seq !== verSeqRef.current) return
      verBusyRef.current = false
      clearTimeout(verTimerRef.current)
      setVerState('error')
      verTimerRef.current = setTimeout(() => setVerState(''), 2500)
    })
  }
  const { data: access, err: accessErr, load: loadAccess } = usePanelLoader(apiGetAccessLog)
  // v3.342：设置块（拦截窗 + 顶栏时间）的读面由本页统一持有——下拉/刷新必须等它一起落定，
  // 否则指示条会在设置块还在读的时候就收起（v3.330 的「所有 loader 落定」同一条规矩）。
  const { data: settings, err: settingsErr, load: loadSettings } = usePanelLoader(apiGetConsoleSettings)
  const [readyTick, setReadyTick] = useState(0)
  const seenRef = useRef(null)
  const pendingRef = useRef(false)
  const loadedAtRef = useRef(0)
  useEffect(() => {
    const becameActive = active && seenRef.current === false
    seenRef.current = active
    // 懒加载（同 usePanelAutoLoad）：系统页没点开过就不发这三条请求
    // （/api/sys + /api/access-log + /api/config/console），首次进入才算首访。
    if (!active) return
    // 首次点开时上一发还在飞/刚回来不到 3s，直接用手里的数据；更久才点开则补一次。
    if (becameActive && (pendingRef.current || (loadedAtRef.current && Date.now() - loadedAtRef.current < 3000))) return
    if (pendingRef.current) return
    pendingRef.current = true
    Promise.allSettled([load(), loadAccess(), loadSettings()]).then(() => {
      pendingRef.current = false
      loadedAtRef.current = Date.now()
      setReadyTick((v) => v + 1)
    }).catch(() => {})
  }, [active, load, loadAccess, loadSettings])
  // 设置块每次读到（含轮询）就同步给 App 的顶栏缓存：别的标签页改了 syncShowDate，
  // 这边最多一个轮询周期就跟上，不用等用户手动保存（Sourcery #303 M6）。
  useEffect(() => {
    if (typeof onSettings === 'function' && settings && !settingsErr) onSettings(settings)
  }, [settings, settingsErr, onSettings])
  // 两个 loader 都落定才通知滚动层收口；只报第一个会在下半页还空着时提前释放垫高。
  const sysReady = !!(sys || err)
  const accessReady = !!(access || accessErr)
  useEffect(() => {
    if (sysReady && accessReady && typeof onReady === 'function') onReady()
  }, [sysReady, accessReady, readyTick, onReady])
  const refreshAll = () => {
    return Promise.allSettled([load(), loadAccess(), loadSettings()]).then((rs) => {
      loadedAtRef.current = Date.now()
      setReadyTick((v) => v + 1)
      return rs
    }).catch(() => [])
  }
  // 下拉刷新与「刷新」按钮同一条路径（两表 + 就绪 tick）。
  usePullRefresh(active, refreshAll)
  // v3.348：统一轮询节拍——本页在前台时每拍重拉（含访问日志与设置）。
  // v3.349：只有三份数据全部成功才推进「数据截至」，半个失败不得冒充整页新数据。
  usePollReload(active, pollTick, () => refreshAll().then((rs) => {
    if (typeof onFresh === 'function') onFresh('sys', rs.every((r) => r.status === 'fulfilled'), pollTick)
  }))
  const fmtUptime = (s) => {
    if (!(typeof s === 'number' && s >= 0)) return '—'
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d} 天 ${h} 时 ${m} 分` : h > 0 ? `${h} 时 ${m} 分` : `${m} 分`
  }
  const logItems = access && Array.isArray(access.items) ? access.items : []
  const logTail = logItems.slice(-20).reverse()
  // v3.320：首帧同形占位——数据到达前也按最终行数（3+4）把两张表画出来，值用 —。
  // 旧版整块 sys-grid 挂在 `${sys && …}` 后面：冷启动首帧只有面板头 + 提示（223px），
  // 75–137ms 后两张表一次性填满（551px），文档 795→1644，下半页整体被推走。
  // 不给容器拍 min-height（行高本身就是占位）。
  // v3.320：access-log 的 details 也无条件渲染——summary 的 44px 就是占位。旧版整块挂在
  // 「有访问记录」条件后面（空态另挂一条 condition），数据到达前首帧没有这一行，加载后凭空
  // 多出 44px（panel 487→551，留在 ≤25px 的残差里）。空态与表格一起移进 details：默认折叠
  // 不占高度，展开才长，首帧与加载后同形。
  const info = sys || {}
  return html`<div class="panel">
    <${PanelHead} title="系统信息" level=${1} right=${html`<${Button} variant="ghost" onClick=${refreshAll}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    <div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>脚本版本</td><td><span class="ver-line"><span class="ver-num">${info.version ? `v${info.version}` : '—'}</span><button type="button" class=${'ver-check ' + (verState === 'latest' ? 'ok' : verState === 'stale' ? 'warn' : verState === 'error' ? 'bad' : '')} disabled=${verState === 'checking'} onClick=${checkVersion}>${verState === 'checking' ? '检查中…' : verState === 'latest' ? '✓ 已是最新' : verState === 'stale' ? '正在刷新…' : verState === 'error' ? '检查失败' : '检查更新'}</button></span></td></tr>
        <tr><td>Node.js</td><td>${info.node || '—'}</td></tr>
        <tr><td>平台</td><td>${info.platform || '—'}</td></tr>
      </tbody></table>
      <table class="sys-table"><tbody>
        <tr><td>控制台已运行</td><td>${fmtUptime(info.uptimeS)}</td></tr>
        <tr><td>内存占用</td><td>${fmtBytes(info.rssBytes)}</td></tr>
        <tr><td>进程 PID</td><td>${info.pid == null ? '—' : info.pid}</td></tr>
        <tr><td>缓存目录</td><td>${info.cacheDir || '—'}</td></tr>
      </tbody></table>
    </div>
    <div class="set-title">设置<span class="cfg-block-sub">改动立即生效 · 落盘 console-settings.json</span></div>
    <${ConsoleSettingsBlock} settings=${settings} settingsErr=${settingsErr} loadSettings=${loadSettings} onSaved=${onSettingsSaved} active=${active} />
    <${BackupBlock} onImported=${refreshAll} />
    <${TwoFactorBlock} active=${active} />
    <${Hint} style="margin-top:12px">近窗未授权尝试（401）：${access && Number.isSafeInteger(access.unauthorizedCount) ? access.unauthorizedCount : '—'} 次（服务启动以来累计；下方环形日志最多 200 条、重启即清空、不写盘；路径中 token 已由服务端脱敏）。<//>
    ${accessErr && html`<${Hint} tone="error">访问日志加载失败：${accessErr.message || accessErr}<//>`}
    <details class="access-log">
      <summary>最近访问记录（最多 20 条，新在上）</summary>
      ${!accessReady
        ? html`<div class="empty" role="status">读取中…</div>`
        : logTail.length === 0
          ? html`<div class="empty">${accessErr ? '访问日志读取失败' : '暂无访问记录（轮询端点与静态资产的成功请求不记入）'}</div>`
          : html`<table class="sys-table"><tbody>
          ${logTail.map((it, i) => html`<tr key=${`${i}|${it.at}|${it.method}|${it.path}|${it.status}|${it.ms}`}><td>${it.at}</td><td>${it.method} ${it.path} → ${it.status} · ${it.ms}ms</td></tr>`)}
        </tbody></table>`}
    </details>
    <${Hint} style="margin-top:12px">数据说明：推送记录来自判重缓存 push.json（服务端已裁剪正文 HTML）；趋势解析 run.log 摘要行；日志取尾部 1 MiB。<//>
  </div>`
}

// 状态目录文件清单（v3.298）：启动预加载 + 切回系统页刷新 + 手动刷新。符号链接/目录作为异常条目显性
// 展示（bytes 为 ——— 意为「不适用」，服务端不跟随符号链接、不泄露目标元数据）。
function FilesPanel ({ onReady, active = true, pollTick = 0, onFresh }) {
  const [loadTick, setLoadTick] = useState(0)
  const bumpTick = useCallback(() => setLoadTick((v) => v + 1), [])
  const { data, err, load } = usePanelLoader(apiGetFiles, bumpTick)
  // 保活后系统页切回来时补拉一次；离开不拉。data 保留，不出现加载占位。
  usePanelAutoLoad(active, load)
  usePullRefresh(active, load)
  // v3.348：统一轮询节拍——文件清单也跟着刷新。
  usePollReload(active, pollTick, () => load().then((ok) => {
    if (typeof onFresh === 'function') onFresh('files', ok === true, pollTick)
  }))
  // 文件清单是系统页的下半截；它落定前不能释放切页垫高。loadTick 让切回重拉完成
  // 后也再报一次，否则 ready 首访后就一直为 true，头部「数据截至」不会更新。
  const ready = !!(data || err)
  useEffect(() => { if (ready && typeof onReady === 'function') onReady() }, [ready, loadTick, onReady])
  const files = data && Array.isArray(data.files) ? data.files : []
  return html`<div class="panel">
    <${PanelHead} title="缓存目录文件"
      sub=${data ? `${data.total} 项${data.truncated ? '（超出展示上限，已截断）' : ''}` : ''}
      right=${html`<${Button} variant="ghost" onClick=${load}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && data.status !== 'ok' && html`<div class="empty">${data.status === 'missing' ? '目录尚未生成' : `不可读（${data.status}）`}</div>`}
    ${data && data.status === 'ok' && html`<table class="sys-table"><tbody>
      ${files.map((f) => html`<tr key=${f.name}>
        <td>${f.name}</td>
        <td>${f.kind === 'file' ? `${fmtBytes(f.bytes)} · ${f.type}` : f.kind === 'symlink' ? '⚠️ 符号链接（异常，请排查）' : f.kind}</td>
      </tr>`)}
    </tbody></table>`}
    <${Hint} style="margin-top:10px">文件类型：cache=判重缓存 · tombstone=墓碑 · log/state=日志与状态 · lock=锁帧 · backup/temp=异常残留备份。出现 symlink/dir 即目录被异常写入，值得人工排查。<//>
  </div>`
}

// 过滤规则：按「一行一条」渲染，空规则默认折叠。
// 旧版把 11 条键值对拼成一行（k=v · k=v…），手机端只能从单词中间硬断，挤成一团；
// 规则再多页面会成一条无限长的“毛线”。这里每条独立成行，空值默认隐藏。
// v3.312：rows 来自 effectiveFilterRows（覆盖文件 > 代码配置），被覆盖字段带「覆盖」徽章——
// 配置页原先只读 Config.filter，保存覆盖文件后两页对不上（「已保存」但配置页全空）。
function FilterRules ({ rows, sub }) {
  const [showEmpty, setShowEmpty] = useState(false)
  const list = Array.isArray(rows) ? rows : []
  const isEmpty = (v) => v === undefined || v === null || String(v).length === 0
  const emptyCount = list.filter((row) => isEmpty(row.value)).length
  const shown = showEmpty ? list : list.filter((row) => !isEmpty(row.value))
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">过滤规则</span>
      <span class="cfg-block-sub">${sub || `${list.length} 项${emptyCount > 0 ? ` · ${emptyCount} 项为空` : ''}`}</span>
    </div>
    ${shown.length === 0
      ? html`<div class="empty">暂无已设置的过滤规则${emptyCount > 0 ? `（${emptyCount} 项为空）` : ''}</div>`
      : html`<div class="rule-list">
        ${shown.map((row) => html`<div class="rule-row" key=${row.key}>
          <code class="rule-key">${row.key}</code>
          <span class=${'rule-val' + (isEmpty(row.value) ? ' rule-empty' : '')}>${isEmpty(row.value) ? '（空）' : String(row.value)}</span>
          ${row.overridden && html`<span class="rule-src" title="该字段由覆盖文件提供">覆盖</span>`}
        </div>`)}
      </div>`}
    ${emptyCount > 0 && html`<button type="button" class="cfg-toggle" aria-expanded=${showEmpty} onClick=${() => setShowEmpty(!showEmpty)}>
      ${showEmpty ? '▾ 收起空规则' : `▸ 显示 ${emptyCount} 个空规则`}
    </button>`}
  </div>`
}

function ChannelList ({ pc }) {
  const raw = pc && pc.perChannel
  const map = raw && !Array.isArray(raw) ? raw : {}
  const legacy = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  const names = Object.keys(map).length > 0 ? Object.keys(map) : (Array.isArray(pc.names) ? pc.names : legacy)
  const isOn = (k) => Object.hasOwn(map, k)
    ? !!map[k]
    : (Array.isArray(pc.names) && pc.names.includes(k)) || legacy.includes(k)
  const on = names.filter(isOn)
  return html`<div class="cfg-block">
    <div class="cfg-block-head">
      <span class="cfg-block-title">推送渠道</span>
      <span class="cfg-block-sub">已配置 ${on.length} / ${names.length} · 绿色为已配置</span>
    </div>
    ${!pc.moduleLoaded
      ? html`<div class="empty">配置模块加载失败（检查依赖）</div>`
      : names.length === 0
        ? html`<div class="empty">未配置任何渠道</div>`
        : html`<div class="chan-grid">
          ${names.map((k) => html`<span key=${k} class=${'chan-chip' + (isOn(k) ? ' on' : '')}
            role="img" aria-label=${`${channelLabel(k)}：${isOn(k) ? '已配置' : '未配置'}`}>
            <span class="chan-dot" aria-hidden="true"></span>${channelLabel(k)}
          </span>`)}
        </div>`}
  </div>`
}

// 运行配置脱敏视图（v3.298）：推送密钥只显示「已配置/未配置」，值永不下发（服务端白名单
// + 响应前保险丝双道防线）。进配置页加载 + 手动刷新。
// v3.312：过滤规则块改为「实际生效值」——另拉 GET /api/config/filter（覆盖文件结果），
// 与代码默认按字段合并并给覆盖文件提供的字段打「覆盖」徽章。此前只读 Config.filter，保存
// 覆盖文件后两页对不上（用户看到「已保存」但配置页仍然全空）。
function ConfigPanel ({ onSync, active = true, pollTick = 0 }) {
  const [configAt, setConfigAt] = useState(0)
  const [filterAt, setFilterAt] = useState(0)
  const { data, err, load } = usePanelLoader(apiGetConfig, setConfigAt)
  const { data: eff, err: effErr, load: loadEff } = usePanelLoader(apiGetFilter, setFilterAt)
  // 两个 loader 都回过一次才算「配置页加载完成」；只报第一个会让滚动垫高
  // 在第二块还没渲染时就收口（Sourcery #263）。
  useEffect(() => {
    if (typeof onSync === 'function' && configAt && filterAt) onSync(Math.max(configAt, filterAt))
  }, [configAt, filterAt, onSync])
  const refresh = useCallback(() => Promise.allSettled([load(), loadEff()]), [load, loadEff])
  // 启动预加载；保活后每次切回本页静默重拉（旧值留在原地），离开本页不拉。
  usePanelAutoLoad(active, refresh)
  usePullRefresh(active, refresh)
  // v3.348：统一轮询节拍——配置页每拍重拉（只读视图，不会覆盖任何草稿）。
  usePollReload(active, pollTick, refresh)
  const r = data && data.runtime ? data.runtime : null
  // 配置块入场：首次读到数据时轻推一次，之后每 5s 的轮询重渲染不再动。
  const panelRef = useRef(null)
  useRevealWhen(panelRef, !!r, '.cfg-block', { y: 12, duration: MOTION.fast, step: 0.035, cap: 4 })
  const pc = data && data.pushChannels ? data.pushChannels : null
  // 读面失败时 usePanelLoader 仍保留上一次的 data（不清空），这里必须显式丢弃，
  // 否则页面会一边报「读取失败、显示代码默认值」一边渲染旧的覆盖值（Sourcery #257）。
  const effLive = effErr ? null : eff
  // 生效值口径与 FilterStore.mergeActiveFilter 一致：覆盖文件优先、缺字段回代码默认。
  const effFilter = effLive && effLive.filter && typeof effLive.filter === 'object' ? effLive.filter : null
  const filterRows = r ? effectiveFilterRows(r.filter, effFilter) : []
  const changedCount = filterRows.filter((row) => row.differs).length
  const filterSub = filterSourceNote(effLive, filterRows.length, changedCount)
  return html`<div class="panel" ref=${panelRef}>
    <${PanelHead} title="运行配置" level=${1} sub="脱敏视图 · 推送密钥只显示是否已配置"
      right=${html`<${Button} variant="ghost" onClick=${refresh}>刷新<//>`} />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${data && !r && html`<div class="empty">运行配置不可读（模块加载失败——检查部署完整性）</div>`}
    ${r && html`<div class="sys-grid">
      <table class="sys-table"><tbody>
        <tr><td>站点域名</td><td>${r.domain}</td></tr>
        <tr><td>推送接口</td><td>${r.api.pushUrl}</td></tr>
        <tr><td>接口超时 / 重试</td><td>${r.api.timeout}ms / ${r.api.retry} 次</td></tr>
        <tr><td>推送模式</td><td>${r.push.mode}${r.push.mode === 'parallel' ? ` · 并发上限 ${r.push.parallelLimit}` : ''}</td></tr>
        <tr><td>单轮上限 / 截断</td><td>${r.push.maxPerRun} 条 · 标题 ${r.push.titleMax} / 正文 ${r.push.contentMax} 字符</td></tr>
        <tr><td>缓存上限</td><td>${r.cache.maxSize} 条 · 目录 ${r.cache.dirEffective || r.cache.dirConfigured || '—'}</td></tr>
      </tbody></table>
      <table class="sys-table"><tbody>
        <tr><td>接口异常告警</td><td>${r.alert.enabled ? `开（同错误限频 ${Math.round(r.alert.intervalMs / 60000)} 分钟）` : '关'}</td></tr>
        <tr><td>运行日报</td><td>${r.report.enabled ? '开' : '关'}</td></tr>
        <tr><td>通道健康监测</td><td>${r.channelHealth.enabled ? `开（连续失败 ${r.channelHealth.consecutiveFailures} 次告警）` : '关'}</td></tr>
        <tr><td>过滤诊断日志</td><td>${r.diagnostics.filterLog.enabled ? `开（每轮最多 ${r.diagnostics.filterLog.maxDetailsPerRun} 条）` : '关'}</td></tr>
        <tr><td>磁盘余量告警</td><td>${r.storage.minFreeBytes >= 0 ? `低于 ${fmtBytes(r.storage.minFreeBytes)} 时告警` : '—'}</td></tr>
        <tr><td>运行环境变量</td><td>${data.console && data.console.env ? [['intervalMs', 'XBK_INTERVAL_MS'], ['cacheDir', 'XBK_CACHE_DIR'], ['dryRun', 'XBK_DRY_RUN']].filter(([k]) => data.console.env[k]).map(([, label]) => `${label} 已设置`).join('，') || '无覆盖' : '—'}</td></tr>
      </tbody></table>
    </div>`}
    ${r && html`<div class="cfg-block">
      <div class="cfg-block-head"><span class="cfg-block-title">推送模板</span></div>
      <div class="tpl-row"><span>标题</span><code>${r.template.title}</code></div>
      <div class="tpl-row"><span>正文</span><code>${r.template.content}</code></div>
    </div>`}
    ${r && filterRows.length > 0 && html`<${FilterRules} rows=${filterRows} sub=${filterSub} />`}
    ${r && effErr && html`<${Hint} tone="error">过滤规则覆盖层读取失败：${effErr}（本块显示代码默认值）<//>`}
    ${r && effLive && effLive.source === 'corrupt' && html`<${Hint} tone="error">覆盖文件损坏，当前按降级值运行${effLive.error && effLive.error.message ? `：${effLive.error.message}` : ''}。请到「过滤规则」标签回滚或重新保存。<//>`}
    ${r && html`<${Hint}>本块显示实际生效值：覆盖文件优先于代码默认，带「覆盖」标记的字段由覆盖文件提供。修改请到「过滤规则」标签。<//>`}
    ${r && html`<div class="cfg-block">
      <div class="cfg-block-head"><span class="cfg-block-title">关键词订阅</span></div>
      <div class="cfg-text">${r.keyword.zkt_gjc && String(r.keyword.zkt_gjc).length > 0 ? r.keyword.zkt_gjc : '（未设置）'}</div>
    </div>`}
    ${pc && html`<${ChannelList} pc=${pc} />`}
    ${pc && html`<div class="cfg-block">
      <div class="cfg-block-head"><span class="cfg-block-title">本地配置文件</span></div>
      <div class="cfg-text">${pc.localFilePresent ? 'push_config.local.js 存在（sendNotify 启动时加载；格式异常会在运行日志告警。密钥不入库不入页面）' : '未找到（用环境变量或该文件配置推送）'}</div>
    </div>`}
    <${Hint} style="margin-top:12px">本页为脱敏视图：所有推送密钥（appToken / BOT token 等）的值永不出现在页面或接口响应中，只显示「已配置 / 未配置」。修改配置请编辑 push_config.local.js 或环境变量后重启。<//>
  </div>`
}

// ── 过滤规则（v3.310）：覆盖文件编辑面 ─────────────────────────────────────
// 语义红线（规格 §2.8/§3）：zhanxian* 是「保护」——命中即保留、优先于屏蔽，绝不写成
// 「展示 / 只看」；pingbitime 是「屏蔽注册不足 N 天的楼主」，不是「只看最近 N 天」。
// 分组顺序 = 运行侧判定顺序：时间 → 分类 → 楼主 → 标题 → 内容。
const FILTER_GROUPS = [
  {
    key: 'time',
    title: '时间',
    note: '第 1 步 · 先按楼主注册天数判定',
    fields: [
      {
        name: 'pingbitime',
        label: '屏蔽注册不足 N 天的楼主',
        kind: 'days',
        hint: '填天数（整数）。留空 = 不启用；支持「分类###天数」多行写法。'
      }
    ]
  },
  {
    key: 'category',
    title: '分类',
    note: '第 2 步 · 分类名命中即屏蔽',
    fields: [
      { name: 'pingbifenlei', label: '屏蔽分类', hint: '分类名正则（如 美妆|数码），不支持 ### 多行语法。' }
    ]
  },
  {
    key: 'author',
    title: '楼主',
    note: '第 3 步 · 保护优先于屏蔽，强化屏蔽可抵消同字段保护',
    fields: [
      { name: 'pingbilouzhu', label: '屏蔽楼主', hint: '一行一条；支持「分类###关键词」。命中即过滤。' },
      { name: 'zhanxianlouzhu', label: '保护楼主', protect: true, hint: '保护（命中即保留，优先于屏蔽）。' },
      { name: 'pingbilouzhuplus', label: '强化屏蔽楼主', hint: '强化屏蔽：命中即过滤，并可抵消同字段的保护。' }
    ]
  },
  {
    key: 'title',
    title: '标题',
    note: '第 4 步 · 楼主已屏蔽时不再看标题',
    fields: [
      { name: 'pingbibiaoti', label: '屏蔽标题', hint: '一行一条；支持「分类###关键词」。命中即过滤。' },
      { name: 'zhanxianbiaoti', label: '保护标题', protect: true, hint: '保护（命中即保留，优先于屏蔽）。' },
      { name: 'pingbibiaotiplus', label: '强化屏蔽标题', hint: '强化屏蔽：命中即过滤，并可抵消同字段的保护。' }
    ]
  },
  {
    key: 'content',
    title: '内容',
    note: '第 5 步 · 楼主/标题已屏蔽时不再看内容',
    fields: [
      { name: 'pingbineirong', label: '屏蔽内容', hint: '一行一条；支持「分类###关键词」。命中即过滤。' },
      { name: 'zhanxianneirong', label: '保护内容', protect: true, hint: '保护（命中即保留，优先于屏蔽）。' },
      { name: 'pingbineirongplus', label: '强化屏蔽内容', hint: '强化屏蔽：命中即过滤，并可抵消同字段的保护。' }
    ]
  }
]

const FILTER_FIELD_NAMES = FILTER_GROUPS.reduce((acc, g) => acc.concat(g.fields.map((f) => f.name)), [])

// 保存复核抽屉里的「改动字段」用中文标签：给用户看的是「屏蔽楼主」，不是 pingbilouzhu。
const FILTER_FIELD_LABELS = FILTER_GROUPS.reduce((acc, g) => {
  for (const f of g.fields) acc[f.name] = f.label
  return acc
}, {})

// 过滤规则草稿：改了但没保存的内容先落在浏览器本地，关标签/杀后台/浏览器退出后
// 下次打开还能捡回来。只存规则字段，不存 token；同一浏览器只保留最近一份。
const FILTER_DRAFT_KEY = 'xbk_filter_draft_v1'
const FILTER_DRAFT_SCHEMA = 1
const FILTER_DRAFT_SAVE_DELAY = 500
const FILTER_DRAFT_SERVER_DELAY = 1500
const FILTER_DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000

function readFilterDraft () {
  try {
    const raw = window.localStorage.getItem(FILTER_DRAFT_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || obj.schema !== FILTER_DRAFT_SCHEMA || !obj.filter || typeof obj.filter !== 'object' || !Number.isFinite(obj.savedAt)) {
      clearFilterDraft()
      return null
    }
    if (Date.now() - obj.savedAt > FILTER_DRAFT_MAX_AGE) {
      clearFilterDraft()
      return null
    }
    return obj
  } catch (e) {
    return null
  }
}

function writeFilterDraft (filter, baseRevision, savedAt) {
  try {
    window.localStorage.setItem(FILTER_DRAFT_KEY, JSON.stringify({
      schema: FILTER_DRAFT_SCHEMA,
      filter,
      baseRevision: Number.isSafeInteger(baseRevision) ? baseRevision : null,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now()
    }))
    return true
  } catch (e) {
    // 隐私模式/配额满：不影响编辑，但调用方必须知道这次没写成功，不能显示「已保存」。
    return false
  }
}

function clearFilterDraft () {
  try { window.localStorage.removeItem(FILTER_DRAFT_KEY) } catch (e) { /* 忽略 */ }
}

// 全命中判定与服务端 wideMatchFields 同口径：trim 后等于 .* 或 ^.*$。
const FILTER_WIDE_PATTERNS = ['.*', '^.*$']

function isWideMatchValue (v) {
  const s = v === undefined || v === null ? '' : String(v).trim()
  return FILTER_WIDE_PATTERNS.includes(s)
}

function wideFieldsOf (filter) {
  const src = filter && typeof filter === 'object' ? filter : {}
  return FILTER_FIELD_NAMES.filter((name) => isWideMatchValue(src[name]))
}

// GET 返回的 filter 只含 11 个服务端字段；缺字段按空串（不把 undefined 塞进 textarea）。
function filterDraftFrom (data) {
  const src = data && data.filter && typeof data.filter === 'object' ? data.filter : {}
  const out = {}
  for (const name of FILTER_FIELD_NAMES) {
    out[name] = src[name] === undefined || src[name] === null ? '' : String(src[name])
  }
  return out
}

// GET 返回的 override：覆盖文件里实际存在的字段（服务端已按白名单裁剪）。
// 保存是整份替换 ⇒ 本次没改但已落盘的字段必须原样带回，否则会被静默删掉退回代码默认。
function filterOverrideFrom (data) {
  return filterOverrideFields(data, FILTER_FIELD_NAMES)
}

// 服务器草稿响应 → 与本地草稿同形；坏的/缺字段的响应当没有，不能让他覆盖页面。
function filterDraftFromServer (data) {
  if (!data || data.ok !== true || !data.draft || typeof data.draft !== 'object') return null
  const savedAt = Number(data.draft.savedAt)
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null
  return {
    filter: filterDraftFrom({ filter: data.draft.filter }),
    baseRevision: Number.isSafeInteger(data.draft.baseRevision) ? data.draft.baseRevision : null,
    savedAt,
    source: 'server'
  }
}

// 服务端 errors 是 [{field, code, message}]；body/baseRevision 这类非字段错误汇总在顶部 Hint。
function fieldErrorMap (errors) {
  const map = {}
  if (!Array.isArray(errors)) return map
  for (const item of errors) {
    if (item && typeof item.field === 'string' && FILTER_FIELD_NAMES.includes(item.field)) {
      map[item.field] = item.message || item.code || '校验失败'
    }
  }
  return map
}

// 补推口径（规格 §4.4）：最多扫 5000 条 _f 记录，超过显示「≥5000」。
// 缓存读不到时服务端回 available:false（scanned/reEvalCount 为 null）——此时显示「未知」，
// 不能把 null 格式化成 0 条（那等于把「读不到」说成「没有影响」）。
function reEvalText (preview) {
  if (preview && preview.available === false) return '无法读取推送历史，本次不显示补推估算'
  const n = preview && preview.capped === true ? '≥5000' : fmtNum(preview ? preview.reEvalCount : null)
  return `将重评 ${n} 条历史被过滤记录，后续每轮最多补推 Config.push.maxPerRun（默认 100）条。`
}

// 备份下拉：/api/files 的清单里筛 filter-rules.bak.<rev>.json（最多 3 代）。
// 清单不可读时退化为「最近 3 代候选」——缺失的 revision 由服务端 404 backup_not_found 如实提示。
function backupRevisionsOf (files, revision) {
  const list = files && Array.isArray(files.files) ? files.files : null
  if (!list) {
    const out = []
    for (let r = revision - 1; r >= 1 && out.length < 3; r--) out.push(r)
    return out
  }
  return list
    .map((f) => /^filter-rules\.bak\.(\d+)\.json$/.exec(f && typeof f.name === 'string' ? f.name : ''))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((r) => Number.isSafeInteger(r) && r >= 0 && r < revision)
    .sort((a, b) => b - a)
    .slice(0, 3)
}

// 单个规则字段：label/for 绑定、当前值、脏标记、逐字段错误。
function FilterField ({ def, value, saved, error, onChange }) {
  const id = `filter-rule-${def.name}`
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  const shown = value === undefined || value === null ? '' : String(value)
  const prev = saved === undefined || saved === null ? '' : String(saved)
  const dirty = shown !== prev
  const describedBy = error ? `${hintId} ${errId}` : hintId
  return html`<div class=${'fr-field' + (def.protect ? ' fr-field-protect' : '')}>
    <div class="fr-field-head">
      <label class="fr-label" for=${id}>${def.label}</label>
      ${def.protect && html`<span class="fr-protect">保护（命中即保留，优先于屏蔽）</span>`}
      ${dirty && html`<span class="fr-dirty">未保存</span>`}
      <code class="fr-key">${def.name}</code>
    </div>
    ${def.kind === 'days'
      ? html`<textarea id=${id} class="fr-input fr-textarea fr-input-days" rows="2" spellcheck="false"
          value=${shown} aria-describedby=${describedBy} aria-invalid=${error ? 'true' : 'false'}
          onInput=${(e) => onChange(def.name, e.target.value)}></textarea>`
      : html`<textarea id=${id} class="fr-input fr-textarea" rows="2" spellcheck="false"
          value=${shown} aria-describedby=${describedBy} aria-invalid=${error ? 'true' : 'false'}
          onInput=${(e) => onChange(def.name, e.target.value)}></textarea>`}
    <div class="fr-field-hint" id=${hintId}>${def.hint}</div>
    ${error && html`<div class="fr-field-err" id=${errId} role="alert">${error}</div>`}
  </div>`
}

function FilterRulesPanel ({ onSync, active = true, pollTick = 0, guardRef, onLeaveRequest }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [base, setBase] = useState(null)
  // 覆盖文件里已落盘的字段（GET 的 override）。保存是整份替换 ⇒ 本次没改的这些字段
  // 必须一起提交，否则会被静默删掉、回退到代码默认。
  const [override, setOverride] = useState({})
  const [backups, setBackups] = useState([])
  const [backupListKnown, setBackupListKnown] = useState(false)
  const [restoreTo, setRestoreTo] = useState('default')
  // 表单入场（v3.360）：分组先到、字段随后到，只播一次（轮询重拉不重播）。
  const formRef = useRef(null)
  useRevealWhen(formRef, !!draft, '.fr-group', { y: 16, step: 0.055, cap: 4 })
  useRevealWhen(formRef, !!draft, '.fr-field', { y: 10, duration: MOTION.fast, step: 0.022, cap: 8 })
  const [loading, setLoading] = useState(false)
  const slowLoading = useSlowFlag(loading)
  const [busy, setBusy] = useState('') // '' | validate | preview | save | copy | restore
  const [err, setErr] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [preview, setPreview] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [draftSavedAt, setDraftSavedAt] = useState(0)
  const [draftSyncedAt, setDraftSyncedAt] = useState(0)
  // 竞态/卸载守卫：只应用最新一次 load 的响应；旧响应不能刷新时间戳或覆盖草稿。
  const loadSeqRef = useRef(0)
  const mountedRef = useRef(true)
  // v3.320：校验失败的定位旗（见下方 useLayoutEffect）。只有「确有字段错误」的失败
  // 提交会置它，成功路径与加载失败路径不碰。
  const revealFieldRef = useRef(false)
  // 「保存并继续」的等待者：只有真正保存成功才 resolve(true)；取消/失败/卸载 resolve(false)。
  const saveResultRef = useRef(null)
  const settleSaveResult = useCallback((ok) => {
    const pending = saveResultRef.current
    saveResultRef.current = null
    if (pending) pending.resolve(ok === true)
  }, [])
  useEffect(() => () => {
    mountedRef.current = false
    if (saveResultRef.current) {
      saveResultRef.current.resolve(false)
      saveResultRef.current = null
    }
  }, [])

  const applyLoaded = useCallback((d, files, serverDraft) => {
    const revision = d && Number.isSafeInteger(d.revision) ? d.revision : 0
    const next = filterDraftFrom(d)
    const list = backupRevisionsOf(files, revision)
    const localSaved = readFilterDraft()
    const local = localSaved
      ? {
          filter: filterDraftFrom({ filter: localSaved.filter }),
          baseRevision: Number.isSafeInteger(localSaved.baseRevision) ? localSaved.baseRevision : null,
          savedAt: localSaved.savedAt,
          source: 'local'
        }
      : null
    const remote = filterDraftFromServer(serverDraft)
    // 同一份草稿可能本机和服务器都有：先排除基于旧 revision 的草稿，再按时间取新。
    // 否则「本机旧草稿但时间更新」会挡住「服务器上基于当前 revision 的可用草稿」。
    const candidates = [local, remote].filter(Boolean)
    const usable = candidates.filter((x) => !Number.isSafeInteger(x.baseRevision) || x.baseRevision === revision)
    // 全部草稿都基于旧 revision 时宁可丢掉，也不恢复旧内容：
    // 否则保存会把当前服务端规则覆盖回旧版本（Sourcery High）。
    const pool = usable
    const saved = pool.length > 0
      ? pool.reduce((a, b) => (Number(b.savedAt) > Number(a.savedAt) ? b : a), pool[0])
      : null
    let restored = null
    let restoreNotice = null
    if (saved) {
      const savedDraft = filterDraftFrom({ filter: saved.filter })
      const changed = FILTER_FIELD_NAMES.filter((n) => String(savedDraft[n]) !== String(next[n]))
      if (changed.length > 0) {
        restored = savedDraft
        const baseRev = Number.isSafeInteger(saved.baseRevision) ? saved.baseRevision : null
        const sourceText = saved.source === 'server' ? '服务器' : '本机'
        restoreNotice = {
          tone: 'warn',
          text: `已恢复上次未保存的草稿（${sourceText}，${fmtAge(Date.now() - Number(saved.savedAt))}，${changed.length} 个字段）${baseRev !== null && baseRev !== revision ? `；草稿基于 r${baseRev}，当前 r${revision}` : ''}。保存后才会生效。`
        }
        setDraftSavedAt(saved.savedAt)
        setDraftSyncedAt(saved.source === 'server' ? saved.savedAt : 0)
        // 服务器草稿也要在本机留一份：断网/服务挂掉时还能从 localStorage 捡回来。
        if (saved.source === 'server') writeFilterDraft(savedDraft, baseRev, saved.savedAt)
      } else {
        clearFilterDraft()
        setDraftSavedAt(0)
        setDraftSyncedAt(0)
        // 草稿和正式规则一样，已经没有任何可恢复的内容：把服务器那份也清掉。
        if (remote) apiDeleteFilterDraft().catch(() => {})
      }
    } else {
      setDraftSavedAt(0)
      setDraftSyncedAt(0)
    }
    setData(d)
    setDraft(restored || next)
    setBase(next)
    setOverride(filterOverrideFrom(d && d.override))
    setPreview(null)
    setFieldErrors({})
    if (restoreNotice) setNotice(restoreNotice)
    setBackups(list)
    setBackupListKnown(!!(files && Array.isArray(files.files)))
    setRestoreTo(list.length > 0 ? String(list[0]) : 'default')
  }, [])

  // 渲染期同步的「有未保存改动」标记：load 的回调闭包里读它，避免拿到旧值。
  const dirtyRef = useRef(false)
  // 自动草稿：ref 里永远是最新值，pagehide/visibilitychange 来不及等 React 重渲染也能写。
  const draftRef = useRef(null)
  const baseRef = useRef(null)
  const dataRef = useRef(null)
  // 所有草稿 PUT 串行执行：旧请求不能晚到并覆盖新内容；清草稿时等整条链落地再 DELETE。
  const draftPushChainRef = useRef(Promise.resolve())
  const draftEpochRef = useRef(0)
  draftRef.current = draft
  baseRef.current = base
  dataRef.current = data
  const saveDraftNow = useCallback(() => {
    if (!draftRef.current || !baseRef.current) return false
    const d = dataRef.current
    const ok = writeFilterDraft(draftRef.current, d && Number.isSafeInteger(d.revision) ? d.revision : null)
    if (ok) {
      setDraftSavedAt(Date.now())
    } else {
      setDraftSavedAt(0)
      setNotice({ tone: 'warn', text: '本机草稿写不进去（可能是隐私模式或存储已满）；请点保存或检查浏览器存储。' })
    }
    return ok
  }, [])
  const pushDraftNow = useCallback(({ keepalive = false } = {}) => {
    if (!draftRef.current || !baseRef.current) return Promise.resolve(false)
    const filter = draftRef.current
    const d = dataRef.current
    const baseRevision = d && Number.isSafeInteger(d.revision) ? d.revision : 0
    const epoch = draftEpochRef.current
    // 串行化：前一笔 PUT 落地后才发下一笔，避免旧内容晚到覆盖新内容。
    const task = draftPushChainRef.current
      .catch(() => false)
      .then(() => {
        if (epoch !== draftEpochRef.current) return false
        return apiPostFilterDraft(filter, baseRevision, { keepalive })
          .then((res) => {
            // 发出去以后又改了/已经放弃：这次响应不能把状态改回「已同步」。
            if (epoch !== draftEpochRef.current || draftRef.current !== filter) return false
            if (res && res.ok) {
              setDraftSyncedAt(Date.now())
              return true
            }
            return false
          })
          .catch(() => false)
      })
    draftPushChainRef.current = task.catch(() => false)
    return task
  }, [])
  // 放弃/保存/回滚时同时清服务器草稿。先让所有已排队的 PUT 落地，再 DELETE；
  // 否则晚到的 PUT 会把刚删掉的草稿又写回来。
  const clearServerDraft = useCallback(async () => {
    draftEpochRef.current++
    setDraftSyncedAt(0)
    await draftPushChainRef.current.catch(() => false)
    const res = await apiDeleteFilterDraft().catch(() => null)
    if (!res || (!res.ok && res.status !== 404)) {
      setNotice({ tone: 'warn', text: '服务器草稿清理失败；旧草稿可能被下次打开恢复，请稍后重试。' })
      return false
    }
    return true
  }, [])
  // 离开拦截：allowLeaveRef 表示用户已经明确「不保存」，此时 beforeunload/popstate 都放行。
  // guardPushedRef 防止每次输入都往历史里再压一条 sentinel。
  const allowLeaveRef = useRef(false)
  const guardPushedRef = useRef(false)
  const onLeaveRequestRef = useRef(onLeaveRequest)
  onLeaveRequestRef.current = onLeaveRequest
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setErr('')
    try {
      // 备份清单/服务器草稿与规则读取并行：/api/files 只是下拉数据，草稿读不到
      // 也不能阻断规则编辑；两者失败都退化为 null。
      const [d, files, serverDraft] = await Promise.all([apiGetFilter(), apiGetFiles().catch(() => null), apiGetFilterDraft().catch(() => null)])
      if (seq !== loadSeqRef.current || !mountedRef.current) return
      // 响应在飞期间用户改了草稿：这次结果不能覆盖（下拉刷新也不例外）。
      if (dirtyRef.current) return
      applyLoaded(d, files, serverDraft)
      if (typeof onSync === 'function') onSync(Date.now())
    } catch (e) {
      if (seq !== loadSeqRef.current || !mountedRef.current) return
      setErr(`加载失败：${e.message}`)
    } finally {
      if (seq === loadSeqRef.current && mountedRef.current) setLoading(false)
    }
  }, [applyLoaded, onSync])

  useEffect(() => { load().catch(() => {}) }, [load])
  // 首访预加载后规则文件可能已经变了：第一次真正点开本页时静默补一次（旧数据留在
  // 原地，不闪加载）。只在第一次打开时补；之后再切回不重拉，避免覆盖未保存草稿。
  const openedRef = useRef(active)
  useEffect(() => {
    if (!active || openedRef.current) return
    openedRef.current = true
    load().catch(() => {})
  }, [active, load])

  const dirtyFields = useMemo(() => {
    if (!draft || !base) return []
    return FILTER_FIELD_NAMES.filter((n) => String(draft[n]) !== String(base[n]))
  }, [draft, base])
  const draftWide = useMemo(() => wideFieldsOf(draft), [draft])
  const dirty = dirtyFields.length > 0
  // 保存候选 = 覆盖文件里已存在的字段 + 本次改动的字段。
  // 两者都不是的字段仍然不提交：缺字段的语义是「回代码默认」，把当前生效值整份写进
  // 覆盖文件会把代码默认永久钉死（后续版本改默认时这台实例收不到）。
  // 只提交 dirtyFields 也不行：保存是整份替换，覆盖文件里原有的其他字段会被静默删掉。
  // 所有保存入口（普通保存 / 离开拦截的「保存并继续」）都必须走这个函数。
  const buildSaveCandidate = useCallback(
    () => buildSaveCandidateOf(override, dirtyFields, draft, FILTER_FIELD_NAMES),
    [override, dirtyFields, draft]
  )
  dirtyRef.current = dirty
  // 下拉刷新不碰有未保存改动的草稿：一次下拉不能静默丢掉用户刚改的规则。
  usePullRefresh(active && dirtyFields.length === 0, load)
  // v3.348：统一轮询节拍。load 自己会在 dirtyRef 为真时丢弃响应，
  // 所以有未保存改动时自动刷新不会覆盖草稿（下拉刷新之外的第二道保险）。
  usePollReload(active, pollTick, load)

  // 自动草稿：改完 500ms 就写 localStorage，不等 5 分钟——等 5 分钟再存的话，
  // 改完立刻杀后台会丢掉最后 5 分钟的修改。draft 为空时不能清，否则会把上次
  // 尚未恢复的草稿在首帧抹掉。
  useEffect(() => {
    if (!draft || !base) return undefined
    if (!dirty) {
      clearFilterDraft()
      setDraftSavedAt(0)
      return undefined
    }
    const t = window.setTimeout(saveDraftNow, FILTER_DRAFT_SAVE_DELAY)
    return () => window.clearTimeout(t)
  }, [dirty, draft, base, data, saveDraftNow])

  // 服务器草稿比本机慢一点（1.5s），避免一边打字一边高频写盘；页面切走/关掉时
  // 下面的 flush 会立刻补发。服务器成功前本机草稿已经落盘，断网也不丢。
  useEffect(() => {
    if (!dirty) return undefined
    const t = window.setTimeout(() => { pushDraftNow().catch(() => {}) }, FILTER_DRAFT_SERVER_DELAY)
    return () => window.clearTimeout(t)
  }, [dirty, draft, base, data, pushDraftNow])

  // 离线时服务器写失败：网络回来且仍有未保存改动，补推一次。
  useEffect(() => {
    const retry = () => { if (dirtyRef.current) pushDraftNow().catch(() => {}) }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [pushDraftNow])

  // 服务器写失败（离线/接口挂）：保持本机草稿，并每 10 秒重试一次，直到同步成功。
  // 之前只靠 online 事件；网络没断但服务器 502/超时时永远不会再试（Sourcery Medium）。
  useEffect(() => {
    if (!dirty || draftSyncedAt > 0) return undefined
    const t = window.setInterval(() => { if (dirtyRef.current) pushDraftNow().catch(() => {}) }, 10000)
    return () => window.clearInterval(t)
  }, [dirty, draftSyncedAt, pushDraftNow])

  // 改回和正式规则一致（或手动清空）时，服务器草稿也要删；
  // 否则下次打开会把这份「已撤销的修改」又恢复出来（Sourcery Medium）。
  useEffect(() => {
    if (dirty || draftSyncedAt <= 0) return
    clearServerDraft().catch(() => {})
  }, [dirty, draftSyncedAt, clearServerDraft])

  // 切后台/关标签/刷新：立刻补一发，不能等 500ms 定时器。
  useEffect(() => {
    if (!dirty) return undefined
    const flush = () => {
      if (allowLeaveRef.current) return
      saveDraftNow()
      pushDraftNow({ keepalive: true }).catch(() => {})
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [dirty, saveDraftNow])

  // 刷新/关页：先把最新草稿写进 localStorage，再让浏览器弹原生提示。
  // 自定义弹窗在 beforeunload 里出不来，文案由浏览器决定。
  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (e) => {
      if (allowLeaveRef.current) return
      saveDraftNow()
      pushDraftNow({ keepalive: true }).catch(() => {})
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty, saveDraftNow, pushDraftNow])

  // 手机左滑/浏览器后退：脏草稿时在历史里压一条同地址 sentinel。第一次后退会退到
  // 这条 sentinel（同页、不卸载），popstate 里再问「保存 / 不保存 / 取消」。取消时
  // App 调 restoreHistory() 重新压一条，保证下一次左滑还能拦。
  useEffect(() => {
    if (!dirty) {
      guardPushedRef.current = false
      return undefined
    }
    allowLeaveRef.current = false
    if (!guardPushedRef.current) {
      window.history.pushState({ ...(window.history.state || {}), __xbkFilterGuard: true }, '', window.location.href)
      guardPushedRef.current = true
    }
    const onPop = () => {
      if (!dirtyRef.current || allowLeaveRef.current) return
      if (onLeaveRequestRef.current) onLeaveRequestRef.current({ source: 'history' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [dirty])

  const setFieldValue = useCallback((name, value) => {
    setDraft((cur) => (cur ? { ...cur, [name]: value } : cur))
    setDraftSyncedAt(0)
    setFieldErrors((cur) => {
      if (!cur[name]) return cur
      const next = { ...cur }
      delete next[name]
      return next
    })
  }, [])

  const applySaved = useCallback((filter, revision, copy) => {
    const rev = Number.isSafeInteger(revision) ? revision : null
    const next = filterDraftFrom({ filter })
    // 同步把脏标记放掉：保存成功后的 doSwitchTab 可能在 React 重渲染前就触发
    // hashchange，不能让旧的 guard.dirty 再挂出一个离开拦截。
    dirtyRef.current = false
    if (guardRef && guardRef.current) {
      guardRef.current.dirty = false
      guardRef.current.count = 0
    }
    clearFilterDraft()
    setDraftSavedAt(0)
    clearServerDraft().catch(() => {})
    setData((cur) => (cur
      ? { ...cur, revision: rev === null ? cur.revision : rev, source: 'override', filter: { ...filter }, wideMatch: wideFieldsOf(filter) }
      : cur))
    setDraft(next)
    setBase(next)
    // 覆盖文件现在就是这份 filter（整份替换）：同步 override，否则下一次保存会把
    // 这次刚写进去的字段当成「没改过」再删一遍。
    setOverride(filterOverrideFrom(filter))
    setFieldErrors({})
    setPreview(null)
    setDialog(null)
    setNotice({ tone: 'ok', text: `${copy ? '已把当前规则复制到覆盖文件' : '已保存'}${rev === null ? '' : ` r${rev}`}，下一轮生效（当前轮不换规则）。` })
  }, [])

  // 备份清单单独刷新：保存会新增一代备份，下拉必须跟着更新（不重读规则，避免覆盖草稿）。
  const refreshBackups = useCallback(async (revision) => {
    try {
      const files = await apiGetFiles()
      const list = backupRevisionsOf(files, revision)
      setBackups(list)
      setBackupListKnown(!!(files && Array.isArray(files.files)))
      setRestoreTo((cur) => (cur !== 'default' && list.includes(Number(cur))
        ? cur
        : (list.length > 0 ? String(list[0]) : 'default')))
    } catch (e) { /* 清单读取失败：保留旧下拉，不阻断保存结果 */ }
  }, [])

  // 错误体 → 统一文案 + 逐字段错误。返回值供调用方决定是否开二次确认弹窗。
  const showFailure = useCallback((res, fallback) => {
    const payload = res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {}
    const code = typeof payload.code === 'string' ? payload.code : ''
    const errors = Array.isArray(payload.errors) ? payload.errors : []
    const fail = (text) => {
      setNotice(null) // 失败时清掉上一条成功提示，避免「已保存」与错误同屏
      // v3.320：确有逐字段错误时才置定位旗——没有字段错误的失败（401/503/写入忙…）
      // 顶部 Hint 就在原地，不该拽页面。旗子由下面的 useLayoutEffect 消费。
      revealFieldRef.current = errors.length > 0
      setFieldErrors(fieldErrorMap(errors))
      setErr(text)
    }
    if (res.status === 401) { fail('凭证已失效（401），写操作被拒绝；请用带 token 的完整链接重新打开控制台。'); return 'unauthorized' }
    if (code === 'engine_unavailable' || res.status === 503) { fail('安全正则引擎（re2）暂不可用，本次不落盘；请检查部署后重试。'); return 'engine_unavailable' }
    if (code === 'body_too_large' || res.status === 413) { fail('规则内容超过 64 KiB 上限，请精简后再保存。'); return 'body_too_large' }
    if (code === 'unsupported_media_type' || res.status === 415) { fail('请求格式不被接受（写端点要求 application/json）。'); return 'unsupported_media_type' }
    if (code === 'write_busy') { fail(`另一个写入正在进行，请 1 秒后重试（Retry-After: ${res.retryAfter || '1'}）。`); return 'write_busy' }
    if (code === 'store_corrupt') { fail('覆盖文件已损坏：保存需要确认覆盖（确认后损坏内容不可回滚）。'); return 'store_corrupt' }
    if (code === 'revision_mismatch') {
      const cur = Number.isSafeInteger(payload.revision) ? payload.revision : null
      setFieldErrors({})
      setErr(`保存冲突：${cur === null ? '服务端 revision 已变化' : `服务端当前为 r${cur}`}，你基于 r${data ? data.revision : '?'}。请先「重新加载」合并后再保存。`)
      return 'revision_mismatch'
    }
    if (code === 'backup_not_found' || res.status === 404) { fail('备份不存在（backup_not_found），可能已被清理；请重新加载备份列表。'); return 'backup_not_found' }
    if (code === 'validation_failed' || res.status === 400) {
      const lines = errors.map((x) => `${x && x.field ? x.field : ''}${x && x.message ? `：${x.message}` : ''}`).filter(Boolean)
      fail(lines.length > 0 ? `${fallback}：${lines.join('；')}` : `${fallback}：规则未通过校验`)
      return 'validation_failed'
    }
    fail(`${fallback}：${payload.error || payload.code || `HTTP ${res.status}`}`)
    return code || `http_${res.status}`
  }, [data])

  // v3.320：校验失败时反馈在视口外——顶部汇总 Hint 与每字段错误行都插在动作区上方，
  // 屏幕内只看到按钮被推下 74px。这里在状态提交后（paint 前）把第一个 aria-invalid
  // 字段滚到吸顶页签下沿并聚焦：先 focus({ preventScroll: true }) 拿焦点，再按
  // .tabs 高度 + 8 手工算 scrollTo（不居中，避免把错误行顶出屏幕上沿）。
  // 只由上面的 fail() 置旗 ⇒ 成功路径、加载失败路径都不会触发。
  useLayoutEffect(() => {
    if (!revealFieldRef.current) return
    revealFieldRef.current = false
    const el = document.querySelector('[aria-invalid="true"]')
    if (!el) return
    // 面板被 section[hidden] 隐藏时 rect 全为 0：不在这里拽页面。
    if (!el.getBoundingClientRect().height) return
    el.focus({ preventScroll: true })
    // 视口里「哪一行错了」要一眼看见：聚焦后补一次抖动 + 红圈脉冲。
    flash(el, 'bad')
    const pad = stickyPad()
    const top = el.getBoundingClientRect().top + window.scrollY - pad
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    window.scrollTo(0, Math.max(0, Math.min(top, max)))
  }, [fieldErrors])

  // 保存前两次预检：/validate（逐字段语法）→ /preview（补推条数），再开二次确认弹窗。
  const beginSave = async () => {
    if (!data || !draft || busy) return false
    setErr('')
    setFieldErrors({})
    setNotice(null)
    // 只提交「覆盖文件已有字段 + 本次改动字段」：把没动过的「当前生效值」也整份写进
    // 覆盖文件，等于把代码默认永久钉死——后续版本改默认时这台实例收不到（评审 Medium）。
    // 但也不能只提交 dirtyFields：保存是整份替换，覆盖文件里原有的其他字段会被静默删掉
    // （v3.359 修）。缺字段的语义本来就是「回代码默认」，所以两者都不是的字段仍然省略。
    const candidate = buildSaveCandidate()
    setBusy('validate')
    try {
      // confirmWideMatch:true 只关掉服务端的「宽匹配需确认」闸；真正的二次确认由本页弹窗
      // 负责（用户必须在弹窗里看到 .* 字段与补推条数后才会发出保存）。
      const checked = await apiPostFilterValidate({ schema: 1, filter: candidate, confirmWideMatch: true })
      if (!checked.ok) { showFailure(checked, '校验未通过'); return false }
      setBusy('preview')
      const pv = await apiPostFilterPreview({ schema: 1, filter: candidate, confirmWideMatch: true })
      if (!pv.ok) { showFailure(pv, '补推预览失败'); return false }
      setPreview(pv.data)
      // 抽屉里要列出「这次到底改了哪些字段」：draft 与 base 逐字段比对（与表单上的
      // 「未保存」徽标同源），标签转中文，值取即将落盘的候选值。
      const changed = dirtyFields.map((name) => ({
        name,
        label: FILTER_FIELD_LABELS[name] || name,
        value: candidate[name] !== undefined && candidate[name] !== null ? String(candidate[name]) : ''
      }))
      setDialog({ kind: 'save', filter: candidate, baseRevision: data.revision, preview: pv.data, wide: wideFieldsOf(candidate), changed })
      return true
    } catch (e) {
      setErr(`保存前检查失败：${e.message}`)
      return false
    } finally {
      setBusy('')
    }
  }

  // 离开拦截里的「保存并继续」：直接落盘，不弹第二次保存确认。
  // 只有 submitSave 真正成功才 resolve(true)；取消/失败/卸载都 resolve(false)，App 不跳页。
  // 实现放在 submitSave 之后，避免在初始化前引用它。

  const runPreview = async () => {
    if (!draft || busy) return
    setErr('')
    setFieldErrors({})
    setNotice(null)
    setBusy('preview')
    try {
      const res = await apiPostFilterPreview({ schema: 1, filter: { ...draft }, confirmWideMatch: true })
      if (!res.ok) { showFailure(res, '预览失败'); return }
      setPreview(res.data)
    } catch (e) {
      setErr(`预览失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  const submitSave = async ({ filter, baseRevision, confirmWideMatch, confirmReplaceCorrupt, copy }) => {
    setBusy('save')
    setErr('')
    try {
      const res = await apiPostFilterSave({
        schema: 1,
        baseRevision,
        filter,
        confirmWideMatch: confirmWideMatch === true,
        confirmReplaceCorrupt: confirmReplaceCorrupt === true
      })
      if (res.ok) {
        const payload = res.data && typeof res.data === 'object' ? res.data : {}
        applySaved(filter, payload.revision, copy === true)
        // 保存并继续：真正落盘成功后才放行原来的切页/后退动作。
        settleSaveResult(true)
        refreshBackups(Number.isSafeInteger(payload.revision) ? payload.revision : data.revision)
        return
      }
      const code = showFailure(res, copy ? '复制默认规则失败' : '保存失败')
      const errors = res.data && Array.isArray(res.data.errors) ? res.data.errors : []
      if (code === 'store_corrupt') {
        // 直接保存并继续时：保持等待者，用户确认覆盖并成功后还能继续原切页。
        // 取消由 closeDialog() 统一 resolve(false)。
        setDialog({ kind: 'corrupt', filter, baseRevision, confirmWideMatch })
        return
      }
      if (code === 'validation_failed' && errors.some((x) => x && x.code === 'wide_match_confirm_required')) {
        // 同理：让保存请求保持 pending，确认后成功再放行；不能提前 resolve(false)。
        setDialog({ kind: 'copyWide', filter, baseRevision, copy: copy === true })
        return
      }
      // 其余失败（revision_mismatch / write_busy / validation_failed / 503…）关掉确认弹窗，
      // 让顶部错误文案可见；草稿与 baseRevision 保留，用户可重新加载后再存。
      settleSaveResult(false)
      setDialog(null)
    } catch (e) {
      setErr(`保存请求失败：${e.message}`)
      settleSaveResult(false)
    } finally {
      setBusy('')
    }
  }

  // 离开拦截里的「保存并继续」：直接落盘，不再走 beginSave 的二次确认。
  // 先挂等待者，再复用 submitSave；成功 resolve(true)，失败/需要覆盖确认时 resolve(false)。
  // 这样点「保存并继续」只出现离开拦截自己的确认，不会再弹「确认保存过滤规则」。
  const beginGuardSave = useCallback(() => {
    if (saveResultRef.current) saveResultRef.current.resolve(false)
    const pending = new Promise((resolve) => { saveResultRef.current = { resolve } })
    if (!data || !draft || busy) {
      settleSaveResult(false)
      return pending
    }
    const candidate = buildSaveCandidate()
    if (Object.keys(candidate).length === 0) {
      settleSaveResult(false)
      return pending
    }
    setErr('')
    setFieldErrors({})
    setNotice(null)
    // confirmWideMatch 先给 false：真有 .* 规则时让服务端拦下并开覆盖确认，
    // 不能静默把所有记录都命中。
    submitSave({ filter: candidate, baseRevision: data.revision, confirmWideMatch: false }).catch(() => {
      settleSaveResult(false)
    })
    return pending
  }, [data, draft, busy, dirtyFields, buildSaveCandidate, submitSave, settleSaveResult])

  // 首启：把 GET 到的代码默认整份写进覆盖文件（baseRevision:0）。不自动写，必须点按钮。
  const copyDefaults = async () => {
    if (!data || !base || busy) return
    setDialog(null)
    setBusy('copy')
    setErr('')
    setFieldErrors({})
    setNotice(null)
    try {
      const res = await apiPostFilterSave({ schema: 1, baseRevision: 0, filter: { ...base } })
      if (res.ok) {
        const payload = res.data && typeof res.data === 'object' ? res.data : {}
        applySaved(base, payload.revision, true)
        refreshBackups(Number.isSafeInteger(payload.revision) ? payload.revision : data.revision)
        return
      }
      const code = showFailure(res, '复制默认规则失败')
      const errors = res.data && Array.isArray(res.data.errors) ? res.data.errors : []
      if (code === 'validation_failed' && errors.some((x) => x && x.code === 'wide_match_confirm_required')) {
        setDialog({ kind: 'copyWide', filter: { ...base }, baseRevision: 0, copy: true })
        setNotice({ tone: 'warn', text: '代码默认里含 .* 全命中字段，复制前需要二次确认。' })
      }
    } catch (e) {
      setErr(`复制失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  // 复制默认会拿 base 覆盖 draft；有脏草稿时先问一句，别让一个按钮把编辑内容吃掉。
  const askCopyDefaults = () => {
    if (!data || !base || busy) return
    if (dirtyFields.length > 0) {
      setDialog({ kind: 'copyDefaults' })
      return
    }
    copyDefaults().catch(() => {})
  }

  // 用户明确选择「不保存并离开」：把草稿退回 base，并立刻关掉拦截（历史后退不会等 React 重渲染）。
  const discardDraft = useCallback(() => {
    allowLeaveRef.current = true
    guardPushedRef.current = false
    dirtyRef.current = false
    clearFilterDraft()
    setDraftSavedAt(0)
    clearServerDraft().catch(() => {})
    if (guardRef && guardRef.current) {
      guardRef.current.dirty = false
      guardRef.current.count = 0
    }
    if (base) setDraft({ ...base })
    setFieldErrors({})
    setPreview(null)
    setDialog(null)
    setNotice({ tone: 'warn', text: '已放弃未保存的修改。' })
  }, [base, guardRef])

  // 取消/去保存后重新压一条 sentinel，下一次左滑仍然能拦。当前已经是 sentinel 就不重复压。
  const restoreHistory = useCallback(() => {
    allowLeaveRef.current = false
    if (window.history.state && window.history.state.__xbkFilterGuard) {
      guardPushedRef.current = true
      return
    }
    guardPushedRef.current = true
    window.history.pushState({ ...(window.history.state || {}), __xbkFilterGuard: true }, '', window.location.href)
  }, [])

  const doRestore = async (to, baseRevision) => {
    setBusy('restore')
    setErr('')
    try {
      const res = await apiPostFilterRestore({
        to: to === 'default' ? 'default' : Number(to),
        confirm: true,
        baseRevision
      })
      if (!res.ok) {
        const code = showFailure(res, '回滚失败')
        setDialog(null)
        // 陈旧页面（baseRevision 与服务端不一致）：自动重新加载，让用户在新版本上重试。
        if (code === 'revision_mismatch') { try { await load() } catch (e) { /* 顶部错误已提示 */ } }
        return
      }
      const payload = res.data && typeof res.data === 'object' ? res.data : {}
      const revText = Number.isSafeInteger(payload.revision) ? ` r${payload.revision}` : ''
      setDialog(null)
      setFieldErrors({})
      // 回滚成功后服务端已经换了规则：同步放开脏标记，否则随后的 load() 会被
      // dirtyRef 守卫丢掉，页面继续显示回滚前的旧草稿（Sourcery High）。
      dirtyRef.current = false
      if (guardRef && guardRef.current) {
        guardRef.current.dirty = false
        guardRef.current.count = 0
      }
      clearFilterDraft()
      setDraftSavedAt(0)
      await clearServerDraft()
      setNotice({
        tone: 'ok',
        text: to === 'default'
          ? `已恢复代码默认（写入空覆盖文件 filter:{}，revision${revText || ' 已递增'}），下一轮生效。`
          : `已回滚到备份 r${to}，写入新 revision${revText}，下一轮生效。`
      })
      // 回滚/恢复默认成功后重新 GET：来源/生效状态/备份列表都以服务端为准。
      await load()
    } catch (e) {
      setDialog(null)
      setErr(`回滚请求失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  const askReload = () => {
    if (busy) return
    if (dirtyFields.length > 0) {
      setDialog({ kind: 'reload' })
      return
    }
    clearFilterDraft()
    setDraftSavedAt(0)
    load().catch(() => {})
  }

  // 用户确认「放弃并重新加载」：先清本地草稿、把 dirtyRef 放行，等服务器草稿删除
  // 落地后再 load；否则 GET 可能抢在 DELETE 前面把旧草稿又拉回来。
  const reloadNow = async () => {
    if (busy) return
    clearFilterDraft()
    setDraftSavedAt(0)
    dirtyRef.current = false
    allowLeaveRef.current = true
    if (base) setDraft({ ...base })
    setFieldErrors({})
    setPreview(null)
    setDialog(null)
    setNotice(null)
    await clearServerDraft()
    load().catch(() => {})
  }

  const closeDialog = () => {
    if (busy) return
    // 「保存并继续」后用户没确认保存：别把等待者一直挂着，也不能跳页。
    if (dialog && (dialog.kind === 'save' || dialog.kind === 'corrupt' || dialog.kind === 'copyWide')) settleSaveResult(false)
    setDialog(null)
  }

  const dialogNode = () => {
    if (!dialog) return null
    if (dialog.kind === 'save') {
      // 保存前复核是「核对」不是「确认」：改动字段 + 补推影响 + 命中样本都可能很长，
      // 弹窗会把背后的表单挡死、用户没法对照着看哪个字段写成了什么。改成右侧抽屉
      // （宽 560，含 .* 全命中规则时 640），表单留在背后做对照。
      // 短确认（未保存离开的三选一）仍走居中弹窗：那类内容一屏就够，弹窗更省视线移动。
      const wide = Array.isArray(dialog.wide) ? dialog.wide : []
      const changed = Array.isArray(dialog.changed) ? dialog.changed : []
      const preview = dialog.preview && typeof dialog.preview === 'object' ? dialog.preview : {}
      const samples = Array.isArray(preview.samples) ? preview.samples : []
      const saving = busy === 'save'
      return html`<${Drawer} open=${true} title="确认保存过滤规则"
        sub=${`${changed.length} 个字段有改动 · 保存后写入覆盖文件，下一轮生效`}
        width=${wide.length > 0 ? 640 : 560}
        busy=${saving}
        onClose=${closeDialog}
        footer=${html`<${Button} variant="secondary" disabled=${saving} onClick=${closeDialog}>取消<//>
          <${Button} variant="primary" disabled=${saving}
            onClick=${() => submitSave({ filter: dialog.filter, baseRevision: dialog.baseRevision, confirmWideMatch: wide.length > 0 })}>${saving ? '保存中…' : '保存'}<//>`}>
        <div class="fr-preview">
          <div class="fr-preview-head">补推影响</div>
          <div class="fr-preview-main">${reEvalText(preview)}</div>
          ${preview.available === false
            ? html`<div class="fr-preview-meta">缓存读取 ${preview.cacheStatus || '—'}（${preview.code || 'cache_unavailable'}）</div>`
            : html`<div class="fr-preview-meta">已扫描 ${fmtNum(preview.scanned)} 条历史被过滤记录${preview.capped ? '（超过 5000 条，实际可能更多）' : ''}</div>`}
        </div>
        ${wide.length > 0 && html`<div class="fr-wide-warn" role="alert">
          含 .* 全命中规则：${wide.join('、')}。保存后几乎所有记录都会被命中，因此需要二次确认（confirmWideMatch:true）。
        </div>`}
        <div class="fr-restore">
          <div class="fr-restore-head">改动字段（${changed.length}）</div>
          <ul class="fr-samples">
            ${changed.map((f) => html`<li key=${f.name}><span class="fr-sample-title">${f.label}</span><span class="fr-sample-id">${f.value === '' ? '（留空）' : f.value}</span></li>`)}
          </ul>
          <div class="fr-field-hint">表单仍在背后，逐条对一遍再保存；取消或关闭不写盘，草稿仍保留。</div>
        </div>
        <div class="fr-restore">
          <div class="fr-restore-head">命中样本（${samples.length}）</div>
          ${samples.length > 0
            ? html`<ul class="fr-samples">
              ${samples.map((s, i) => html`<li key=${s && s.id !== null && s.id !== undefined ? String(s.id) : `review-sample-${i}`}>
                <span class="fr-sample-title">${s && s.title ? s.title : '（无标题）'}</span>
                ${s && s.id !== null && s.id !== undefined && html`<span class="fr-sample-id">${String(s.id)}</span>`}
              </li>`)}
            </ul>`
            : html`<div class="fr-field-hint">本次预览没有命中样本。</div>`}
          <div class="fr-field-hint">预览只在内存试算，不落盘、不推进过滤 hash、不触发推送。</div>
        </div>
        <div class="modal-note">保存后写入覆盖文件，<strong>下一轮生效</strong>；当前正在跑的一轮不换规则。</div>
      <//>`
    }
    if (dialog.kind === 'corrupt') {
      return html`<${ConfirmDialog} open=${true} title="覆盖已损坏的规则文件？"
        confirmLabel=${busy === 'save' ? '覆盖中…' : '确认覆盖'} busy=${busy === 'save'}
        onCancel=${closeDialog}
        onConfirm=${() => submitSave({ filter: dialog.filter, baseRevision: dialog.baseRevision, confirmWideMatch: dialog.confirmWideMatch, confirmReplaceCorrupt: true })}>
        <div class="fr-dialog-line">覆盖文件已损坏，不能作为可回滚版本。确认后用当前编辑内容重建覆盖文件（confirmReplaceCorrupt:true）。</div>
        <div class="modal-note">重建后同样下一轮生效；损坏内容不会被保留。</div>
      <//>`
    }
    if (dialog.kind === 'copyWide') {
      return html`<${ConfirmDialog} open=${true} title="含 .* 全命中字段"
        confirmLabel=${busy === 'save' ? (dialog.copy ? '复制中…' : '保存中…') : (dialog.copy ? '确认复制' : '确认保存')} busy=${busy === 'save'}
        onCancel=${closeDialog}
        onConfirm=${() => submitSave({ filter: dialog.filter, baseRevision: dialog.baseRevision, confirmWideMatch: true, copy: dialog.copy === true })}>
        <div class="fr-dialog-line">以下字段 trim 后是 .* / ^.*$：${wideFieldsOf(dialog.filter).join('、') || '（未知）'}。保存后几乎所有记录都会被命中。</div>
        <div class="modal-note">确认后以 confirmWideMatch:true 写入覆盖文件；同样下一轮生效。</div>
      <//>`
    }
    if (dialog.kind === 'copyDefaults') {
      return html`<${ConfirmDialog} open=${true} title="复制默认规则会覆盖草稿"
        confirmLabel=${busy === 'copy' ? '复制中…' : '放弃草稿并复制'} busy=${busy === 'copy'}
        onCancel=${closeDialog}
        onConfirm=${() => { setDialog(null); copyDefaults().catch(() => {}) }}>
        <div class="fr-dialog-line">当前有 ${dirtyFields.length} 个字段未保存；复制代码默认会把这些修改覆盖掉。</div>
        <div class="modal-note">复制后写入覆盖文件，下一轮生效。</div>
      <//>`
    }
    if (dialog.kind === 'restore') {
      return html`<${ConfirmDialog} open=${true} title="确认回滚过滤规则"
        confirmLabel=${busy === 'restore' ? '回滚中…' : dirtyFields.length > 0 ? '放弃草稿并回滚' : '确认回滚'} busy=${busy === 'restore'}
        onCancel=${closeDialog}
        onConfirm=${() => doRestore(dialog.to, dialog.baseRevision)}>
        <div class="fr-dialog-line">${dialog.to === 'default'
          ? '写入空覆盖文件（filter:{}、revision+1）恢复代码默认，不删除文件——revision 与备份列表保持连续。'
          : `用备份 r${dialog.to} 的内容写入新 revision（revision 只增不减，线性历史）。`}</div>
        ${dirtyFields.length > 0 && html`<div class="fr-wide-warn" role="alert">当前有 ${dirtyFields.length} 个字段未保存；回滚会用服务端版本覆盖草稿。</div>`}
        <div class="modal-note">回滚前会先备份当前配置（r${dialog.baseRevision}）；同样下一轮生效，当前正在跑的一轮不换规则。</div>
      <//>`
    }
    if (dialog.kind === 'reload') {
      return html`<${ConfirmDialog} open=${true} title="放弃未保存的修改？"
        confirmLabel="放弃并重新加载" busy=${false}
        onCancel=${closeDialog}
        onConfirm=${() => { setDialog(null); reloadNow().catch(() => {}) }}>
        <div class="fr-dialog-line">当前有 ${dirtyFields.length} 个字段尚未保存，重新加载会丢弃这些修改。</div>
      <//>`
    }
    return null
  }

  useEffect(() => () => { if (guardRef) guardRef.current = null }, [guardRef])
  if (guardRef) {
    guardRef.current = {
      dirty,
      count: dirtyFields.length,
      busy: !!busy,
      save: beginGuardSave,
      discard: discardDraft,
      restoreHistory
    }
  }

  const revision = data && Number.isSafeInteger(data.revision) ? data.revision : 0
  const applied = data && data.applied && typeof data.applied === 'object' ? data.applied : null
  const appliedRev = applied && Number.isSafeInteger(applied.revision) ? applied.revision : null
  const appliedAt = applied && applied.appliedAt ? fmtIsoStamp(applied.appliedAt) : ''
  const pendingNext = appliedRev !== null && revision > appliedRev
  const corrupt = !!(data && data.source === 'corrupt')
  const auditBroken = !!(data && data.auditChain && data.auditChain.ok === false)
  const sourceBadge = !data
    ? null
    : data.source === 'corrupt'
      ? html`<${Badge} tone="bad">覆盖文件损坏（降级）<//>`
      : data.source === 'override'
        ? html`<${Badge} tone="ok">覆盖文件 r${revision}<//>`
        : html`<${Badge} tone="warn">代码默认<//>`

  return html`<div class="panel">
    <${PanelHead} title="过滤规则" level=${1} sub="覆盖文件编辑 · 保存后在下一轮生效，当前轮不换规则" />
    ${err && html`<${Hint} tone="error">${err}<//>`}
    ${notice && html`<${Hint} tone=${notice.tone}>${notice.text}<//>`}
    ${loading && !data && html`<div class="empty">加载中…</div>`}
    ${!loading && !data && html`<div class="empty">暂无可显示的规则（上方为错误详情）</div>`}
    ${data && html`<div>
      <div class="fr-status">
        <span class="fr-status-item"><span class="fr-status-k">来源</span>${sourceBadge}</span>
        <span class="fr-status-item"><span class="fr-status-k">已生效</span>${appliedRev === null
          ? html`<span class="fr-status-muted">尚未生效</span>`
          : html`<span class="fr-status-v">r${appliedRev}${appliedAt ? ` · ${appliedAt}` : ''}</span>`}</span>
        ${pendingNext && html`<span class="fr-status-item"><${Badge} tone="warn">r${revision} 待下一轮<//></span>`}
        ${dirtyFields.length > 0 && html`<span class="fr-status-item"><${Badge} tone="warn">有未保存修改<//></span>`}
        ${dirty && (draftSavedAt > 0 || draftSyncedAt > 0) && html`<span class="fr-status-item"><span class="fr-status-muted">草稿已自动保存 · ${draftSavedAt > 0
          ? (draftSyncedAt > 0 ? '本机+服务器' : '本机（服务器未同步，重试中）')
          : '服务器'} · ${fmtLocalTime(draftSyncedAt > 0 ? draftSyncedAt : draftSavedAt).slice(11)}</span></span>`}
        ${slowLoading && html`<span class="fr-status-muted">刷新中…</span>`}
      </div>

      ${(corrupt || auditBroken) && html`<div class="alert-banner" role="alert">
        <span class="alert-dot" aria-hidden="true"></span>
        <div class="alert-main">
          <strong>${corrupt ? '过滤规则覆盖文件损坏，运行侧已降级' : '过滤规则审计链断链'}</strong>
          <span class="alert-sub">${corrupt
            ? `运行侧优先使用进程内 last-known-good，首次加载即损坏才回退代码默认（不清 _f、不推进过滤 hash）。${data.error && data.error.message ? `原因：${data.error.message}` : ''}`
            : `审计链在${data.auditChain.brokenAt === null || data.auditChain.brokenAt === undefined ? '未知位置' : `第 ${data.auditChain.brokenAt} 条`}断开，可能存在静默删除/篡改（只保证可检测，不声称防 root）。`}
            <br />本轮不换规则、下一轮生效：这里保存的修改从下一轮开始生效，正在跑的一轮继续用已生效规则。</span>
        </div>
      </div>`}

      ${data.source === 'default' && html`<div class="fr-firstrun">
        <div class="fr-firstrun-title">当前使用代码默认</div>
        <div class="fr-firstrun-text">还没有覆盖文件。保存任意修改会自动创建；也可以先把当前代码默认整份复制成第一版，之后的修改都写覆盖文件（不自动写，避免不知情地产生第一版）。</div>
        <${Button} variant="primary" disabled=${!!busy || loading} onClick=${askCopyDefaults}>把当前规则复制到覆盖文件<//>
      </div>`}

      <div class="fr-form" role="group" aria-label="过滤规则表单" ref=${formRef}>
        ${FILTER_GROUPS.map((g) => html`<fieldset class="fr-group" key=${g.key}>
          <legend class="fr-group-title">${g.title}</legend>
          <div class="fr-group-note">${g.note}</div>
          ${g.fields.map((f) => html`<${FilterField} key=${f.name} def=${f}
            value=${draft ? draft[f.name] : ''} saved=${base ? base[f.name] : ''}
            error=${fieldErrors[f.name] || ''} onChange=${setFieldValue} />`)}
        </fieldset>`)}
      </div>

      <div class="fr-readonly">
        <div class="fr-field-head">
          <span class="fr-label">只看它关键词（v1 不开放写入）</span>
          <code class="fr-key">zkt_gjc</code>
        </div>
        <div class="fr-readonly-val">${data.keyword && data.keyword.zkt_gjc ? String(data.keyword.zkt_gjc) : '（未设置）'}</div>
        <div class="fr-field-hint">值来自代码配置 Config.keyword.zkt_gjc；v1 只读，不接受写入。修改需改代码并重启。</div>
      </div>

      ${preview && html`<${Reveal} cls="fr-preview" ariaLive="polite" y=${8}>
        <div class="fr-preview-head">补推影响预览</div>
        <div class="fr-preview-main">${reEvalText(preview)}</div>
        ${preview.available === false
          ? html`<div class="fr-preview-meta">缓存读取 ${preview.cacheStatus || '—'}（${preview.code || 'cache_unavailable'}）</div>`
          : html`<div class="fr-preview-meta">已扫描 ${fmtNum(preview.scanned)} 条历史被过滤记录${preview.capped ? '（被过滤记录超过 5000 条，实际可能更多）' : ''}${preview.zktApplied === true ? ' · 已按 zkt_gjc 白名单排除不匹配标题' : ''} · 缓存读取 ${preview.cacheStatus || '—'}</div>`}
        ${Array.isArray(preview.samples) && preview.samples.length > 0 && html`<ul class="fr-samples">
          ${preview.samples.map((s, i) => html`<li key=${s && s.id !== null && s.id !== undefined ? String(s.id) : `sample-${i}`}>
            <span class="fr-sample-title">${s && s.title ? s.title : '（无标题）'}</span>
            ${s && s.id !== null && s.id !== undefined && html`<span class="fr-sample-id">${String(s.id)}</span>`}
          </li>`)}
        </ul>`}
        <div class="fr-field-hint">预览只在内存试算，不落盘、不推进过滤 hash、不触发推送。</div>
      <//>`}

      <div class="fr-actions">
        <${Button} variant="primary" disabled=${dirtyFields.length === 0 || !!busy || loading} onClick=${beginSave}>
          ${busy === 'validate' ? '校验中…' : busy === 'preview' ? '预览补推中…' : '校验并保存'}<//>
        <${Button} disabled=${!!busy || loading} onClick=${runPreview}>预览最近记录<//>
        <${Button} disabled=${!!busy || loading} onClick=${askReload}>重新加载<//>
        <span class="fr-actions-note">${dirtyFields.length > 0
          ? `${dirtyFields.length} 个字段有未保存修改${draftWide.length > 0 ? `（含 ${draftWide.length} 个 .* 全命中）` : ''}`
          : '没有未保存修改'}</span>
      </div>

      <div class="fr-restore">
        <div class="fr-restore-head">回滚 / 恢复默认</div>
        <div class="fr-restore-row">
          <span class="fr-label">回滚目标</span>
          <${MiniSelect} value=${restoreTo} ariaLabel="回滚目标" disabled=${!!busy || loading}
            options=${[
              { value: 'default', label: '恢复代码默认（写入空覆盖文件）' },
              ...backups.map((r) => ({ value: String(r), label: `备份 r${r}` }))
            ]}
            onChange=${setRestoreTo} />
          <${Button} variant="danger" disabled=${!!busy || loading} onClick=${() => setDialog({ kind: 'restore', to: restoreTo, baseRevision: revision })}>回滚<//>
        </div>
        <div class="fr-field-hint">${backups.length > 0
          ? `可用备份：${backups.map((r) => `r${r}`).join('、')}（保存前备份上一版，最多保留 3 代）`
          : (backupListKnown ? '没有可用备份（每次保存前会备份上一版，最多保留 3 代）' : '文件清单不可读，按最近 3 代候选列出；缺失的备份会在回滚时提示 404')}。回滚写入新 revision（历史不回退），同样下一轮生效。</div>
      </div>
    </div>`}
    ${dialogNode()}
  </div>`
}

// ── 回到顶部（v3.321）──────────────────────────────────────────────────────
// 推送记录/逐轮历史/日志都远超一屏，手机滚到深处后没有回顶入口（iOS 可点状态栏，
// Android 只能一路往回拖）。固定按钮：不参与文档流 ⇒ 出现/消失都不改页高；超过
// TOP_SHOW_Y 才出现，回到顶部后自己消失。z-index 35 在吸顶页签(30)之上、浮层(45)/
// 确认弹窗遮罩(80)之下，展开选择器或弹窗时不会盖住它们；隐藏态连 pointer-events 一并
// 关掉，免得一个看不见的按钮吃掉列表末尾的点击。
const TOP_SHOW_Y = 320
// 日志页的日志框是内层滚动容器：页面停在顶部时只在框里滚，window.scrollY 一直是 0，
// 只看整页滚动就不出按钮（Sourcery #284）。内层滚过一屏的 1/8 也算「滚深了」。
const TOP_SHOW_INNER = 80
const LOG_SCROLLER = '.logpre-main'

export {
  CacheHealthPanel,
  ConfigPanel,
  FilesPanel,
  FilterRulesPanel,
  LOG_SCROLLER,
  LogsPanel,
  MessagesPanel,
  PULL_EVENT,
  PullRefreshStatus,
  RunHistoryPanel,
  RunsPanel,
  SearchPanel,
  SysPanel,
  TOP_SHOW_INNER,
  TOP_SHOW_Y,
  TrendsPanel,
  VISIBLE_REFRESH_GAP_MS,
  usePullToRefresh
}
