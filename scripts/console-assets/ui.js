// scripts/console-assets/ui.js —— 控制台外壳层（v3.367 从 app.js 拆出，v3.369 再拆出 pages.js）。
// 这里只剩：App 组件、主题切换、首屏快照、回到顶部；各页面面板在 pages.js（顺序在前）。
// 入口 app.js 只 import App。依赖方向单向，无循环引用。
import { AUTO_DEFAULT_S, AlertBanner, AutoRefreshText, Badge, Button, LeaveGuardDialog, StatusCards, TapTip, TriggerBar, clampAutoSeconds, fmtWeekday, stickyPad } from './components.js'
import { BOOT, apiGetAuto, apiGetConsoleSettings, apiGetLogs, apiGetRuns, apiGetStatus, apiGetSys, apiSetAuto } from './api.js'
import { BUSY_FALLBACK_MS, POLL_BUSY_MS, POLL_MS, SSE_HEARTBEAT_MS, TZ_LABEL, VERSION_CHECK_MS } from './constants.js'
import { MOTION, enter, motionOK } from './motion.js'
import { backToTopBehavior, createLiveChannel, partBroken, pollIntervalFor, runViewTransition, tabFromHash } from './pure.mjs'
import { fmtLocalTime } from './format.js'
import { Component, html, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from './htm-preact.module.js'
// 页面面板（pages.js）
import { CacheHealthPanel, ConfigPanel, FilesPanel, FilterRulesPanel, LOG_SCROLLER, LogsPanel, MessagesPanel, PULL_EVENT, PullRefreshStatus, RunHistoryPanel, RunsPanel, SearchPanel, SysPanel, TOP_SHOW_INNER, TOP_SHOW_Y, TrendsPanel, VISIBLE_REFRESH_GAP_MS, usePullToRefresh } from './pages.js'

function BackToTop () {
  const [show, setShow] = useState(false)
  const rafRef = useRef(0)
  useEffect(() => {
    const read = () => {
      rafRef.current = 0
      const box = document.querySelector(LOG_SCROLLER)
      const next = (window.scrollY || 0) > TOP_SHOW_Y || Boolean(box && box.scrollTop > TOP_SHOW_INNER)
      setShow((prev) => (prev === next ? prev : next))
    }
    const onScroll = () => {
      // rAF 合并：手机惯性滚动一帧能来好几个 scroll 事件，别每个都 setState。
      if (rafRef.current) return
      rafRef.current = window.requestAnimationFrame(read)
    }
    read()
    // scroll 不冒泡：捕获阶段才收得到 .logpre-main 的滚动，否则日志框滚到底也不出按钮。
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    }
  }, [])
  const toTop = () => {
    // 回顶后按钮自己隐藏：先把焦点交给当前页签，否则键盘/读屏用户的焦点会掉到 body。
    const activeTab = document.querySelector('.tab-btn.active')
    if (activeTab && typeof activeTab.focus === 'function') activeTab.focus({ preventScroll: true })
    // 日志页：内层日志框一起回到第一行，只滚整页的话用户仍停在日志末尾。
    const box = document.querySelector(LOG_SCROLLER)
    if (box) box.scrollTop = 0
    const reduce = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    // 老 Safari 没有 scrollBehavior，传 options 会被当成 (x, y) 静默失败。
    const behavior = backToTopBehavior(reduce, 'scrollBehavior' in document.documentElement.style)
    if (behavior) window.scrollTo({ top: 0, behavior })
    else window.scrollTo(0, 0)
  }
  return html`<button type="button" class=${'to-top' + (show ? ' show' : '')}
    aria-label="回到顶部" title="回到顶部" tabindex=${show ? '0' : '-1'}
    aria-hidden=${show ? 'false' : 'true'} onClick=${toTop}>↑</button>`
}

// ── 首屏快照（v3.363）────────────────────────────────────────────────────────
// 上次成功轮询的 status/runs 落在 localStorage：冷启动与弱网时先用它渲染（不再白屏等
// 网络），随后被真实轮询覆盖。只存展示字段、不含 token；版本不符或结构异常直接丢弃
// （旧结构渲染会崩，宁可退回骨架屏）。
// 与主题区分：主题必须服务端首帧渲染（否则闪色），数据快照允许首帧先用旧值——这是
// 「旧数字」而不是「错误主题」，且卡片上本来就标着「数据截至」时间。
const SNAP_KEY = `xbk-console:snapshot:v1:${BOOT.instance || 'default'}`
function readSnapshot () {
  try {
    const raw = window.localStorage.getItem(SNAP_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || v.v !== BOOT.version || typeof v.at !== 'number') return null
    if (!v.status || typeof v.status !== 'object' || Array.isArray(v.status)) return null
    if (!Array.isArray(v.runs)) return null
    return v
  } catch (e) { return null }
}
function writeSnapshot (status, runs, startedAt) {
  try {
    // 多标签页（Sourcery PR #321）：若别的标签页在本请求发出之后写过更新的快照，
    // 本次响应即便后落地也更旧——跳过，避免把新数据顶回旧值。
    const prev = readSnapshot()
    if (prev && typeof startedAt === 'number' && prev.at > startedAt) return
    window.localStorage.setItem(SNAP_KEY, JSON.stringify({
      v: BOOT.version,
      at: Date.now(),
      status,
      runs: Array.isArray(runs) ? runs.slice(0, 12) : []
    }))
  } catch (e) { /* 隐私模式 / 超限：静默降级，数据面不受影响 */ }
}
const SNAPSHOT = readSnapshot()

// ── 主题（v3.323）──────────────────────────────────────────────────────────
// 4 套配色只换 token（见 app.css 的 data-theme 块），不动布局。首帧由服务端把
// cookie 里的选择写进 <html data-theme>——CSP 是 script-src 'self'，不能在 head
// 里内联读 localStorage，否则浅色主题每次加载都会先闪一帧深色。
const THEMES = [
  { key: 'deep', label: '深夜' },
  { key: 'material', label: '材质' },
  { key: 'nord', label: '北境' },
  { key: 'light', label: '明亮' }
]
const THEME_COOKIE = 'xbk_theme'
function currentThemeKey () {
  const t = document.documentElement.getAttribute('data-theme')
  return THEMES.some((x) => x.key === t) ? t : 'deep'
}
function readThemeCookie () {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(THEME_COOKIE + '='))
  const value = hit ? hit.slice(THEME_COOKIE.length + 1) : ''
  return THEMES.some((x) => x.key === value) ? value : ''
}
function applyThemeKey (key) {
  document.documentElement.setAttribute('data-theme', key)
  // theme-color 跟着切：Android 的系统栏不跟着变的话，切到亮色主题后顶部还是旧色。
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const bg = window.getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    if (bg) meta.setAttribute('content', bg)
  }
  try {
    document.cookie = THEME_COOKIE + '=' + key + '; Path=/; Max-Age=31536000; SameSite=Lax'
  } catch (e) {
    // 沙箱/禁用 Cookie 的上下文（opaque origin）会在这里抛：本页照样能切，
    // 只是刷新后回到服务端默认。绝不能让它挡住下面的 setTheme。
  }
}

// v3.385 渲染错误边界：任一面板 render 抛错时，旧版整棵树直接卸载成白屏（服务端字段类型
// 变化、弱网下 detail 结构异常都踩得到）。这里保住外壳：渲染「页面出错了 + 重新加载」面板，
// 并把错误摘要打到 console（手机上打不开 devtools 时，这是唯一能捞到的原因）。
// 只兜渲染期异常——事件回调/异步里的错走各自面板的 catch（那本来就有可见反馈）。
class ErrorBoundary extends Component {
  state = { failed: false, detail: '' }

  componentDidCatch (e) {
    const detail = e && typeof e.message === 'string' && e.message !== '' ? e.message : String(e)
    console.error('[xbk-console] 页面渲染失败：', e)
    this.setState({ failed: true, detail })
  }

  render () {
    if (!this.state.failed) return this.props.children
    return html`<div class="err-boundary" role="alert">
      <p class="boot-fail-title">页面出错了</p>
      <p class="err-boundary-detail">${this.state.detail}</p>
      <p class="boot-fail-hint">渲染这一屏时出错（多半是数据形状异常或临时故障）。点下面重新加载；仍打不开就重新打开带 token 的链接。</p>
      <${Button} variant="primary" onClick=${() => window.location.reload()}>重新加载<//>
    </div>`
  }
}

function App () {
  const [state, setState] = useState(SNAPSHOT ? SNAPSHOT.status : null)
  const [runs, setRuns] = useState(SNAPSHOT ? SNAPSHOT.runs : [])
  // 主题：初值取服务端写进 <html data-theme> 的键（非法值回落 deep）。
  const [theme, setTheme] = useState(currentThemeKey)
  // 触发历史是否已经成功加载过：首次请求未回/失败时不能显示「暂无触发记录」，
  // 否则会把「还不知道」谎报成「确实没有」（Sourcery #254）。
  const [runsState, setRunsState] = useState(SNAPSHOT ? 'ok' : 'loading') // loading | ok | error
  const [busy, setBusy] = useState(false)
  // 服务器端自动运行状态：调度/持久化都在控制台进程，页面只读展示。
  const [autoState, setAutoState] = useState(null)
  const [autoNow, setAutoNow] = useState(Date.now())
  const [lastSync, setLastSync] = useState(SNAPSHOT ? SNAPSHOT.at : null)
  // 非概览页的「数据截至」按页签缓存：每个页签只认自己的成功加载时间，
  // 切回已来过的页签先显示上次时间，首次进入/加载失败显示「数据截至 · —」。
  const [panelSync, setPanelSync] = useState(null)
  // 单调时钟：本次成功加载的时刻，只用于释放滚动垫高；不受系统时钟回拨影响。
  const [panelReadyAt, setPanelReadyAt] = useState(0)
  const [syncErr, setSyncErr] = useState('')
  // 「状态接口本身失败」要立刻反映到状态卡的占位文案上：/api/runs 可能还在路上，
  // 不能等 Promise.allSettled 两边都落定才把「正在读取…」改成「读取失败」。
  const [statusFailed, setStatusFailed] = useState(false)
  // 标签页写 hash（v3.307）：刷新/后退不丢当前页；初始值从 hash 读，非法值回概览。
  // v3.310「过滤规则」新增为第六个页签。pure.mjs 的 tabFromHash 只认 v3.307 的五个键
  // （该模块本批不改），这里补一层本文件内的白名单，保持 hash 路由对新页签同样生效
  // （刷新/后退不丢当前页；非法值仍回概览）。v3.370 的 search 已进 TAB_KEYS。
  // 推送记录页会把筛选条件写进 hash query（#/messages?q=…&page=3，见 buildMessagesHash）：
  // 解析页签前先剥掉 query，否则带参数的地址会被判成非法值、刷新后掉回概览。
  const resolveTab = (hash) => {
    const raw = typeof hash === 'string' ? hash.split('?')[0] : ''
    return /^#\/filter$/.test(raw) ? 'filter' : tabFromHash(raw)
  }
  const [tab, setTab] = useState(() => resolveTab(window.location.hash))
  // 切页入场（v3.360）：只动新页的 opacity/transform，不动高度 ⇒ 不改变滚动锚点、
  // 不会把首屏内容顶走。tab 变化只在真正切页时发生，轮询不触发。
  // v3.374：能上原生 View Transitions 时由浏览器做整页交叉淡入淡出，这一帧的页面级
  // 入场要让位（vtDrivenRef），否则两套淡入叠加会先淡到发白再回来。
  const wrapRef = useRef(null)
  const vtDrivenRef = useRef(false)
  // 切页渲染出口（renderTab）定义在下方，hash 监听是挂载期注册的一次性 effect，
  // 走 ref 取最新闭包（与 prepareScrollRef 同一套办法）。
  const renderTabRef = useRef(null)
  useLayoutEffect(() => {
    const root = wrapRef.current
    // 先取值再清零：本次渲染是否由过渡驱动，只对这一帧有效。
    const viaTransition = vtDrivenRef.current
    vtDrivenRef.current = false
    if (!root || viaTransition) return
    // 只淡入、完全不加 transform：页面里可能有 position:fixed 的弹层（分类选择器/
    // 提示气泡），祖先一旦有 transform 就会改成按它定位，弹层会跳位。
    enter(root.querySelector('.page:not([hidden])'), { transform: false, duration: MOTION.fast })
  }, [tab])
  // 主题切换的临时过渡类：只在这 320ms 内让颜色属性走 transition，避免常驻 transition
  // 让所有 hover/选中态变慢。
  const themeTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(themeTimerRef.current), [])
  // 过滤页草稿守卫：脏状态、保存、放弃由面板写进这个 ref，App 只在切页/后退前问一句。
  // 不用 state 是因为每敲一个字都 dirty，App 不需要跟着重渲染。
  const [leaveRequest, setLeaveRequest] = useState(null)
  // 「保存并继续」正在落盘：期间忽略新的切页/后退请求，避免保存成功后又被
  // 第二次点击挂出一个旧拦截弹窗（手机上会出现「目标页 + 弹窗」的错位）。
  const leaveSavingRef = useRef(false)
  const filterGuardRef = useRef(null)
  const requestFilterLeave = useCallback((req) => {
    if (leaveSavingRef.current) return
    setLeaveRequest((cur) => cur || req)
  }, [])
  // 页签保活：第一次进入才挂载，之后切走只加 hidden、不卸载。切回已看过的页签时
  // 面板与数据都还在，文档高度不会在「卸载→挂载」的两帧之间塌成视口高。
  // 这是网关（WorkBuddy）切换丝滑的原因：它也是所有 page 常驻、只 toggle 可见性。
  const [visited, setVisited] = useState(() => new Set([resolveTab(window.location.hash)]))
  const visitedRef = useRef(visited)
  // 「真正点开过」的页签（用于滚动锚定）。预加载会把六个页签都挂上，但没点开过的页
  // 仍要按首访处理：先垫高，等内容/预加载落定再落位，避免点击瞬间文档变矮被夹到顶部
  // （Sourcery #272）。
  const enteredRef = useRef(new Set([resolveTab(window.location.hash)]))
  const markVisited = useCallback((key) => {
    if (visitedRef.current.has(key)) return
    // 不能先改 visitedRef.current 再交给 setVisited：那样 ref 与 state 是同一个 Set，
    // 更新器里 prev.has(key) 恒为真，会返回旧集合，state 实际上没换新（只靠 setTab
    // 顺带重渲染才碰巧能看见）。这里先复制，再同时替换 ref 与 state。
    const next = new Set(visitedRef.current)
    next.add(key)
    visitedRef.current = next
    setVisited(next)
  }, [])
  // 跳日志请求：{q, mode, n}。n 只用来做 key，重复点同一行也能强制重挂载。
  const [logJump, setLogJump] = useState(null)
  // 自动刷新开关（v3.307）：默认开；暂停后顶部倒计时停住，手动「继续」恢复。
  const [autoRefresh, setAutoRefresh] = useState(true)
  // v3.342：顶栏时间是否带年月日。值存在服务端 console-settings.json（系统页「设置」里改），
  // 这里只缓存一份给顶栏渲染；保存后由 onSettingsSaved 重拉。
  const [showDate, setShowDate] = useState(true)
  // 设置读面：并发读可能乱序（首帧读还在飞、保存后又读一次），旧响应不得覆盖新值。
  // 用 revision 判定：revision 更小的响应一律丢弃（Sourcery #303 M7/M9）。
  const uiSettingsRevRef = useRef(-1)
  const applyUiSettings = useCallback((body) => {
    if (!body || !body.settings || typeof body.settings.syncShowDate !== 'boolean') return
    const rev = Number.isSafeInteger(body.revision) ? body.revision : uiSettingsRevRef.current
    if (rev < uiSettingsRevRef.current) return
    uiSettingsRevRef.current = rev
    setShowDate(body.settings.syncShowDate)
  }, [])
  const reloadUiSettings = useCallback(() => {
    // consumeJson 直接回 body（不是 { ok, data }），别按写面 consumeJsonResult 的形状取。
    apiGetConsoleSettings().then((body) => {
      applyUiSettings(body)
    }).catch(() => {})
  }, [applyUiSettings])
  useEffect(() => { reloadUiSettings() }, [reloadUiSettings])
  // 凭证失效（审查 #224）：任一 API 401 ⇒ 停轮询并显示自助恢复提示，不再每 5s 空打。
  const [authExpired, setAuthExpired] = useState(false)
  const [nextAt, setNextAt] = useState(0)
  // v3.348：共享轮询节拍。非概览/日志页的数据在各面板里，App 每拍 +1，当前面板据此重拉。
  const [pollTick, setPollTick] = useState(0)
  // 全站 SSE 通知（v3.374）：服务端推 tick，收到就走 refreshSplit（有条件请求，命中 304 时
  // 零正文）。sseUp 只表示「通知流真的连上了」——它决定下面的轮询间隔（15s → 60s 安全轮询）；
  // 断线/隐藏/暂停都会让它回到 false，轮询随即恢复 15s。两条通道互不依赖。
  const [sseUp, setSseUp] = useState(false)
  // v3.332：部署后旧标签页仍在跑旧脚本，数据轮询却照常更新 ⇒ 用户以为「改了没生效」。
  // boot 里带页面启动版本；每 60s 与 /api/sys 对一次，不一致就提示刷新。
  const [newVersion, setNewVersion] = useState('')
  useEffect(() => {
    const bootVersion = BOOT.version
    // 凭证失效后不再探针：每次 401 都会派发 auth-expired 事件并多记一条未授权访问日志。
    if (!bootVersion || authExpired) return undefined
    let stopped = false
    let seq = 0
    let done = 0
    const check = () => {
      if (stopped || document.visibilityState === 'hidden') return
      const mine = ++seq
      apiGetSys({ probeVersion: true }).then((s) => {
        if (stopped || mine < done) return // 乱序响应：旧请求不得覆盖新判定
        done = mine
        const v = s && typeof s.version === 'string' ? s.version : ''
        // 与启动版本重新对齐（回滚也算）就收起提示，别留一条过期横幅。
        setNewVersion(v !== '' && v !== bootVersion ? v : '')
      }).catch(() => {})
    }
    check()
    const timer = setInterval(check, VERSION_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [authExpired])
  // 首屏渲染完就把六个页签全部挂上（隐藏），但**不替它们拉数据**：各面板的
  // usePanelAutoLoad / 自己的 active 门控负责「第一次点开才发第一份请求」。
  // 只挂 DOM 的好处是切页只是 toggle hidden，不会「现挂载 + 现请求」闪一下；
  // 数据请求数则从 17 个降到当前页 + 顶栏那几条（见 L4 首屏去重）。
  useEffect(() => {
    if (authExpired) return
    for (const t of TABS) markVisited(t.key)
  }, [authExpired, markVisited])
  // 表单交互暂停轮询的截止时间（见下方 focusin/change/input 监听）。不能只看
  // activeElement：用户选完下拉后焦点仍停在 select 上，会永久冻住自动刷新。
  const formPauseUntilRef = useRef(0)
  const timerRef = useRef(null)
  // 最近一次「数据真的刷新过」的时间：回前台补拉、轮询、下拉都更新它。
  const lastRefreshRef = useRef(Date.now())
  // 回前台后的静默窗（时间戳）：补拉已经覆盖了这一拍，定时器若正好到期不该再叠一发。
  const resumeQuietUntilRef = useRef(0)
  const tabsRef = useRef(null)
  // 标签栏边缘渐隐状态（v3.317）：'' | 'left' | 'right' | 'both'。只在真的溢出时挂
  // data-edge，362 宽（6 个页签全部放得下）保持零遮罩——否则最后一格会被误读成被裁掉。
  const [tabEdge, setTabEdge] = useState('')
  const seqRef = useRef(0)
  // 轮询互斥（Sourcery G_oY）：上一轮未完成时跳过本轮 tick，不在途中叠加新请求
  // （fetch 有 8s 期限，跳过最多让数据晚 2-5s 更新，换来零堆积）。
  const inFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  // busy 由哪一次提交引起（Sourcery G_nv：解锁判据是「提交的那一轮出现在历史里」，
  // 不管它现在是否已结束——否则任务秒完成时按钮锁到 11 分钟兜底才开）。
  const busyRunIdRef = useRef(null)
  // 首次刷新完成前不判「无活跃任务」（启动时 runs 尚空，会把丢失响应的 busy 立刻清掉）。
  const refreshedOnceRef = useRef(false)
  // 首屏那一发不受暂停开关影响（暂停也要先把页面填上）；之后暂停期间的 effect 重跑
  // （切页签 / locking 翻转）不再补发请求（C7-040）。
  const bootFetchedRef = useRef(false)

  // 每个页签记住自己的「数据截至」：切回已来过的页签时先显示上次时间，
  // 不再先闪一下「手动刷新」再跳成时间。第一次进入才显示占位符。
  const syncMemRef = useRef({})

  // 切页的滚动策略（修 #260 的二次跳动）：
  // 1) 每个页签记住自己的 scrollY；第一次进入的页签沿用当前视口位置（#260 的初衷：
  //    切页不把整页拽回顶部），只有「查看日志」才强制回顶。
  // 2) 返回已来过的页签时，切页前先给 #app 垫一个 min-height = y + innerHeight。
  //    旧面板卸载、新面板还在 loading 的那一帧文档不会塌陷，scrollY 也就不会被
  //    浏览器夹到 0；随后在 useLayoutEffect（绘制前）同步 scrollTo(y)。垫高一直
  //    留到新面板真正撑到目标高度（ResizeObserver 盯着内容增长，慢加载也不提前撤），
  //    这样全程没有「先回顶、再弹回去」的两段跳。目标页比记忆位置矮时，等它报加载
  //    完成再落到它自己的最大滚动位置，不空等 4s。
  // 3) 「查看日志」（logJump）是一次性的强制回顶；消费掉之后，后续切页仍按记忆还原。
  const scrollMemRef = useRef({})
  const pendingScrollRef = useRef(null)
  // 本次切页是否为「首访」：首访要等面板加载、内容长高，才需要垫高文档；
  // 已来过的页签整棵面板都还在 DOM 里，切过去高度是现成的，直接落位即可。
  const pendingFirstVisitRef = useRef(false)
  const scrollHoldRef = useRef(null)
  const logJumpPendingRef = useRef(false)
  // 日志跳转代次：主动切页/后退/新的跳转都会 ++，迟到的 /api/logs 响应据此作废。
  const logJumpSeqRef = useRef(0)
  const tabRef = useRef(tab)
  tabRef.current = tab
  // 每个面板只接受「自己这一页」的完成回调：切走后旧请求再回包，不碰新页的垫高。
  const syncFor = useMemo(() => {
    const make = (key) => (ts) => {
      if (typeof ts === 'number') syncMemRef.current[key] = ts
      if (tabRef.current === key) {
        setPanelSync(ts)
        setPanelReadyAt(performance.now())
      }
    }
    return { messages: make('messages'), search: make('search'), logs: make('logs'), config: make('config'), filter: make('filter') }
  }, [])
  // 切页时同步换成目标页签自己的时间（没有就占位），同一帧内完成，不闪上一页/手动刷新。
  const showSyncFor = useCallback((next) => {
    const ts = syncMemRef.current[next]
    setPanelSync(typeof ts === 'number' ? ts : null)
  }, [])
  // 系统页由两个面板组成（SysPanel + FilesPanel）；两边都落定才允许释放垫高。
  const sysReadyRef = useRef(null)
  const markSysReady = useCallback((key) => {
    if (tabRef.current !== 'sys') return
    if (!sysReadyRef.current) sysReadyRef.current = new Set()
    sysReadyRef.current.add(key)
    if (sysReadyRef.current.size < 2) return
    const ts = Date.now()
    syncMemRef.current.sys = ts
    setPanelSync(ts)
    setPanelReadyAt(performance.now())
  }, [])
  // v3.349：系统页的「数据截至」只在本拍两块数据都成功时才推进——
  // 一块失败时停在上一轮完整刷新，别把半个新数据冒充整页新数据（Sourcery #303 M4）。
  const freshRef = useRef({ tick: -1, ok: {} })
  const onFresh = useCallback((key, ok, tick) => {
    const r = freshRef.current
    if (r.tick !== tick) { r.tick = tick; r.ok = {} }
    r.ok[key] = !!ok
    if (r.ok.sys && r.ok.files) {
      const ts = Date.now()
      syncMemRef.current.sys = ts
      setPanelSync(ts)
    }
  }, [])
  const onSysReady = useCallback(() => markSysReady('sys'), [markSysReady])
  const onFilesReady = useCallback(() => markSysReady('files'), [markSysReady])
  const holdScroll = (y) => {
    const el = document.getElementById('app')
    if (!el) return
    el.style.minHeight = y > 0 ? `${y + window.innerHeight}px` : ''
  }
  // 切页后的 1s 内关掉 scroll anchoring：新面板常分几批长高，锚定会把
  // scrollY 每次往上补一截（实测日志↔配置每来回一次 +26px，越切越往下漂）。
  // 只关这一小段，页面稳定后恢复，避免横幅/告警插入时正文跟着上下滑。
  const anchorTimerRef = useRef(0)
  const holdAnchor = () => {
    if (anchorTimerRef.current) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = 0
    document.documentElement.style.overflowAnchor = 'none'
  }
  const releaseAnchorSoon = () => {
    if (anchorTimerRef.current) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = 0
      document.documentElement.style.overflowAnchor = ''
    }, 1000)
  }
  const releaseScrollHold = () => {
    const hold = scrollHoldRef.current
    if (hold) {
      scrollHoldRef.current = null
      if (hold.raf) window.cancelAnimationFrame(hold.raf)
      if (hold.timer) window.clearTimeout(hold.timer)
      if (hold.ro) hold.ro.disconnect()
      window.removeEventListener('wheel', hold.onUser, true)
      window.removeEventListener('touchstart', hold.onUser, true)
      window.removeEventListener('pointerdown', hold.onUser, true)
      window.removeEventListener('keydown', hold.onUser, true)
    }
    // 过渡期临时关掉滚动锚定：旧面板卸载时它在背后微调 scrollY，
    // 会把「用户自己滚走了」的判据误触发。切页后 1s 再恢复。
    releaseAnchorSoon()
    const el = document.getElementById('app')
    if (el) el.style.minHeight = ''
  }
  // 切页前统一登记：保存出发页位置、决定目标页位置、需要时先垫高。
  // 只改 ref 与 #app 的临时样式，不触发 React 渲染；调用方随后 setTab。
  const prepareScroll = (next, { forceTop = false } = {}) => {
    const from = tabRef.current
    const y = window.scrollY
    if (from && from !== next) scrollMemRef.current[from] = y
    const firstVisit = !enteredRef.current.has(next)
    enteredRef.current.add(next)
    const mem = scrollMemRef.current[next]
    // 第一次进入沿用当前视口；只有 forceTop（查看日志）才回 0。
    const target = forceTop ? 0 : (typeof mem === 'number' ? mem : y)
    pendingScrollRef.current = target
    pendingFirstVisitRef.current = firstVisit
    sysReadyRef.current = null
    releaseScrollHold()
    // 只有首访的页面还处在「正在挂载/加载」状态，才需要先垫高；已保活的页面
    // 整棵 DOM 都在，切过去就是最终高度，垫高反而会把视口钉在空白处。
    if (firstVisit && target > 0) holdScroll(target)
  }
  const prepareScrollRef = useRef(prepareScroll)
  prepareScrollRef.current = prepareScroll
  useLayoutEffect(() => {
    if (logJumpPendingRef.current) {
      logJumpPendingRef.current = false
      // openLog 已经把 pendingScrollRef 置 0、pendingFirstVisitRef 置 true；这里直接
      // 回顶后必须一并清掉，否则之后清 logJump 让 effect 重跑时会消费这个 stale 0，
      // 把已在日志页滚动的用户再拽回顶部（审查 must-fix #3）。
      pendingScrollRef.current = null
      pendingFirstVisitRef.current = false
      // v3.319：行级跳转不再死回顶部——滚到定位条下方，保证被高亮的那一轮在首屏可见。
      // 日志框最高 520px，手机上框底会伸到视口外；只把框内滚到中间，行仍可能在屏幕外。
      let y = 0
      if (logJump && logJump.focus) {
        const banner = document.querySelector('.log-focus')
        if (banner) {
          const pad = stickyPad()
          const startY = window.scrollY
          y = Math.max(0, banner.getBoundingClientRect().top + startY - pad)
          // 末尾几轮贴在日志框底部：只把定位条顶到 tabs 下，高亮行仍可能露在屏幕外。
          const line = document.querySelector('.logline-focus')
          if (line) {
            const bottomAfter = line.getBoundingClientRect().bottom - (y - startY)
            const vh = window.innerHeight || document.documentElement.clientHeight
            if (bottomAfter > vh - 12) y += bottomAfter - (vh - 12)
          }
        }
      }
      scrollMemRef.current[tab] = y
      holdAnchor()
      releaseScrollHold()
      window.scrollTo(0, y)
      return
    }
    const y = pendingScrollRef.current
    pendingScrollRef.current = null
    const firstVisit = pendingFirstVisitRef.current
    pendingFirstVisitRef.current = false
    if (typeof y !== 'number') return
    if (y <= 0) {
      // 回顶也要挡住锚定：新面板内容若在顶部上方插入，浏览器会把你从 0 挪走。
      holdAnchor()
      releaseScrollHold()
      window.scrollTo(0, 0)
      return
    }
    // 已保活的页签：目标页整棵 DOM 还在，文档高度就是最终高度，绘制前直接落到
    // 记忆位置（比内容矮时落到它的最大滚动位置）。没有挂载/加载窗口，也就没有
    // 需要垫高的塌陷，不需要 hold。
    if (!firstVisit) {
      holdAnchor()
      releaseScrollHold()
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo(0, Math.min(y, maxScroll))
      releaseAnchorSoon()
      return
    }
    // 垫高已生效：这里同步还原，绘制前就到位，不会先出现塌陷后的 0。
    holdAnchor()
    window.scrollTo(0, y)
    const t0 = performance.now()
    const hold = { y, user: false, raf: 0, timer: 0, ro: null, onUser: null, check: null, startedAtMono: performance.now() }
    hold.onUser = () => { hold.user = true; if (hold.check) hold.check() }
    window.addEventListener('wheel', hold.onUser, { capture: true, passive: true })
    window.addEventListener('touchstart', hold.onUser, { capture: true, passive: true })
    window.addEventListener('pointerdown', hold.onUser, { capture: true, passive: true })
    window.addEventListener('keydown', hold.onUser, true)
    const check = (settled = false) => {
      if (scrollHoldRef.current !== hold) return
      // 用户接管后不再钉住位置；但垫高先留着，等内容长到能接住当前视口再撤，
      // 否则撤早了浏览器会把 scrollY 夹回 0，用户的滚动直接丢。
      if (!hold.user && Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y)
      const foot = document.querySelector('.foot')
      const bottom = foot ? foot.getBoundingClientRect().bottom + window.scrollY : 0
      const need = (hold.user ? window.scrollY : y) + window.innerHeight
      const ready = bottom >= need
      // settled：目标面板已确认所有首批请求都结束。内容仍撑不到记忆位置时收口；
      // 用户自己已经滚过就不替他改位置，只撤垫高（浏览器会按内容高度自然夹取）。
      if (ready || settled || performance.now() - t0 > 9000) {
        if (settled && !hold.user && !ready && bottom > 0) {
          window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
        }
        releaseScrollHold()
      }
    }
    hold.check = check
    hold.ro = window.ResizeObserver ? new window.ResizeObserver(() => check()) : null
    const wrap = document.querySelector('.wrap')
    if (hold.ro && wrap) hold.ro.observe(wrap)
    scrollHoldRef.current = hold
    check()
    // 加载失败/永远撑不起来时，到点释放，避免一直留着一块空白。
    // 9s 比 fetch 的 8s 超时略长：正常响应（哪怕很慢）一定先报 settled。
    if (scrollHoldRef.current === hold) hold.timer = window.setTimeout(check, 9000)
    // 没有 ResizeObserver 的老环境：用 rAF 轮询兜底（9s 到点后 check 会自停）。
    if (!hold.ro) {
      const loop = () => {
        hold.raf = 0
        if (scrollHoldRef.current !== hold) return
        check()
        if (scrollHoldRef.current === hold) hold.raf = window.requestAnimationFrame(loop)
      }
      hold.raf = window.requestAnimationFrame(loop)
    }
  }, [tab, logJump])

  useEffect(() => () => {
    if (anchorTimerRef.current) window.clearTimeout(anchorTimerRef.current)
    document.documentElement.style.overflowAnchor = ''
  }, [])

  // 目标面板报「加载完成」后，如果它的内容撑不到记忆位置，就地落到最大滚动位置；
  // 只认切页后新面板写入的 panelReadyAt（单调时钟）：缓存时间/上一页在途响应
  // 都不会把垫高提前撤掉，系统时钟回拨也不影响。
  useEffect(() => {
    const hold = scrollHoldRef.current
    if (hold && panelReadyAt >= hold.startedAtMono) hold.check(true)
  }, [panelReadyAt])

  // 标签栏是单行横滚：切页、旋转屏幕或改窗口宽度后都要把当前页签滚进可视区，
  // 否则活动页签会停在滚动容器的裁剪边之外（Sourcery #260）。只改 .tabs 的
  // scrollLeft，不碰页面滚动；sticky 栏本身始终在视口里。
  // v3.317：改由 scrollIntoView({inline:'nearest', preventScroll:true}) 做同一件事
  // （浏览器只在需要时挪最近的滚动容器），并顺带刷新左右渐隐状态。
  const syncTabEdge = useCallback(() => {
    const bar = tabsRef.current
    if (!bar) return
    const max = bar.scrollWidth - bar.clientWidth
    if (max <= 1) { setTabEdge(''); return }
    const left = bar.scrollLeft > 1
    const right = bar.scrollLeft < max - 1
    setTabEdge(left && right ? 'both' : left ? 'left' : right ? 'right' : '')
  }, [])
  useLayoutEffect(() => {
    const bar = tabsRef.current
    if (!bar) return undefined
    const adjust = () => {
      const el = bar.querySelector('.tab-btn.active')
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ inline: 'nearest', block: 'nearest', preventScroll: true })
      }
      syncTabEdge()
    }
    adjust()
    window.addEventListener('resize', adjust)
    bar.addEventListener('scroll', syncTabEdge, { passive: true })
    const ro = window.ResizeObserver ? new window.ResizeObserver(adjust) : null
    if (ro) ro.observe(bar)
    return () => {
      window.removeEventListener('resize', adjust)
      bar.removeEventListener('scroll', syncTabEdge)
      if (ro) ro.disconnect()
    }
  }, [tab, syncTabEdge])

  // vwD：逐请求独立收口——status 失败时 runs 结果仍可用（反之亦然）；
  // 并行发出（Sourcery G_n6）：串行 await 会让慢端点拖住另一端点的更新。
  // 乱序防护（Sourcery vwE）：每次 refresh 领号，落后响应直接丢弃（落后 ≠ 失败，
  // 落后者静默丢弃不报错——Sourcery vwB：报「刷新失败」是误导）。
  const refreshSplit = useCallback(async (opts = {}) => {
    // 表单交互暂停期间不发起刷新；已在途的响应也会在下方 apply 前被丢弃。
    // 下拉刷新是明确的手势意图，传 { force: true } 跨过这段暂停。
    if (!(opts && opts.force) && Date.now() < formPauseUntilRef.current) return false
    if (inFlightRef.current) {
      // 切回概览时若上一轮还在路上，标记一次补刷，等 finally 再跑。
      pendingRefreshRef.current = true
      return false
    }
    inFlightRef.current = true
    const seq = ++seqRef.current
    // 快照写入的「新鲜度截点」（Sourcery PR #321）：本请求发出时刻。多标签页并发时，
    // 后落地的旧响应不得覆盖别的标签页在它之后写下的更新快照。
    const startedAt = Date.now()
    const errs = []
    const paused = () => !(opts && opts.force) && Date.now() < formPauseUntilRef.current
    const applyStatus = (s) => { if (seq === seqRef.current && !paused()) { setState(s); setSyncErr(''); setStatusFailed(false) } }
    const applyRuns = (r) => {
      if (seq === seqRef.current && !paused()) {
        setRuns(r.runs || [])
        setLastSync(Date.now())
        setRunsState('ok')
      }
    }
    try {
      // 状态请求单独挂一个拒绝分支：/api/runs 还慢着的时候也要立刻把占位卡改成「读取失败」，
      // 不能等两边都落定（Sourcery PR #292）。
      const statusP = apiGetStatus().then(
        (v) => { if (seq === seqRef.current && !paused()) { setStatusFailed(false) }; return v },
        (e) => { if (seq === seqRef.current && !paused()) { setStatusFailed(true) }; throw e }
      )
      const [sRes, rRes] = await Promise.allSettled([
        statusP,
        apiGetRuns()
      ])
      if (sRes.status === 'fulfilled') applyStatus(sRes.value)
      else errs.push(`状态 ${sRes.reason && sRes.reason.message ? sRes.reason.message : sRes.reason}`)
      if (rRes.status === 'fulfilled') applyRuns(rRes.value)
      else {
        errs.push(`历史 ${rRes.reason && rRes.reason.message ? rRes.reason.message : rRes.reason}`)
        if (seq === seqRef.current) setRunsState((s) => (s === 'ok' ? 'ok' : 'error'))
      }
      // 首屏快照（v3.363）：两边都拿到才写——缺一半的旧数据没有展示价值。
      if (sRes.status === 'fulfilled' && rRes.status === 'fulfilled' && seq === seqRef.current) {
        writeSnapshot(sRes.value, rRes.value && rRes.value.runs, startedAt)
      }
      if (seq !== seqRef.current || paused()) return false
      refreshedOnceRef.current = true
      if (errs.length > 0) setSyncErr(`刷新失败：${errs.join('；')}（自动重试中）`)
      else setSyncErr('')
      // 只有两边都落定才算「刷新成功」：调用方（回前台补拉）据此决定要不要推进时间戳。
      // 轮询成功也记一笔：否则「刚轮询完就切回前台」会被当成很久没刷新而多发一轮（Sourcery #315-11）。
      if (errs.length === 0) lastRefreshRef.current = Date.now()
      return errs.length === 0
    } finally {
      inFlightRef.current = false
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        refreshSplit()
      }
    }
  }, [])

  // 共享一拍（v3.374）：15s/60s 定时器与 SSE tick 走同一份逻辑，避免两套节流各自为政
  // （一套跳过隐藏页、一套不跳，就是「明明在后台却一直发请求」）。隐藏页不发请求、
  // 表单交互与回前台静默窗内跳过——这些判断只写这一遍。
  const markRef = useRef(null)
  const runTick = useCallback(() => {
    if (document.hidden) return
    if (Date.now() < resumeQuietUntilRef.current) return
    if (Date.now() < formPauseUntilRef.current) return
    refreshSplit()
    if (tab !== 'overview' && tab !== 'logs') setPollTick((t) => t + 1)
    if (markRef.current) markRef.current()
  }, [refreshSplit, tab])
  // SSE 回调挂在 effect 上，不能随每次渲染换身份——否则连一次 tick 就要重建连接。用 ref 解引用。
  const runTickRef = useRef(runTick)
  useEffect(() => { runTickRef.current = runTick }, [runTick])

  // 全站 SSE 通知（v3.374）：可见且宿主支持 EventSource 时连 /api/stream。隐藏断开、可见
  // 立刻重连并补拉一次（隐藏期间漏的帧不补发）；暂停/凭证失效同样断开。整个生命周期只有
  // 这一个 EventSource——open() 幂等，清理走 dispose（摘监听 + close），不会叠出第二条流。
  useEffect(() => {
    if (authExpired || !autoRefresh) { setSseUp(false); return undefined }
    const Ctor = typeof window === 'undefined' ? undefined : window.EventSource
    if (typeof Ctor !== 'function') return undefined // 老浏览器：老实走 15s 轮询
    const channel = createLiveChannel({
      EventSourceCtor: Ctor,
      doc: document,
      onChange: (up) => setSseUp(up),
      onTick: () => { runTickRef.current() }
    })
    // 首帧：隐藏的标签页不建流（SSE 也是一条长连接，后台常驻没有意义）。
    if (document.visibilityState !== 'hidden') channel.open()
    return () => channel.dispose()
  }, [authExpired, autoRefresh])

  // 轮询节奏（Sourcery vvJ）：任务在跑时必须用快轮询——以 locking（而非 busy）为节奏源，
  // 避免「busy 在 active 确认后被清 → 退回慢轮询」的窗口。
  // Sourcery Other-instance-idle：另一实例持锁时本进程 runs 历史是空的，此前显示「空闲」
  // 并允许触发（会被服务端 409 拒绝）。status.lock.held（共享 stateDir 的锁文件）参与判定。
  const active = runs.some((r) => !r.finishedAt) || !!(state && state.lock && state.lock.held === true)
  const locking = busy || active
  // 轮询间隔只在这一处算（C7-059）：定时器、顶栏倒计时、面板自轮询全部用这同一个值。
  // 同一个表达式写两遍就会漂移——改了一处忘了另一处，就是「倒计时说 4 秒、定时器按 60 秒走」。
  // 判定在 pure.mjs 里（pollIntervalFor），Node 侧可直接断言。
  const interval = pollIntervalFor({ sseUp, busy: locking, pollMs: POLL_MS, busyMs: POLL_BUSY_MS, safetyMs: SSE_HEARTBEAT_MS })

  useEffect(() => {
    const onAuth = () => setAuthExpired(true)
    window.addEventListener('xbk-auth-expired', onAuth)
    return () => window.removeEventListener('xbk-auth-expired', onAuth)
  }, [])

  // 表单交互期间短暂暂停整页轮询：用户的焦点会一直停在下拉/输入框上，
  // 只按 activeElement 判断会永久停轮；这里用截止时间兜底，最长 10s 后恢复。
  // 选择器展开到选择完成通常 <10s；change/input 后 1.5s 再恢复，避免选完立刻重绘。
  useEffect(() => {
    const isForm = (el) => el && (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    const bump = (ms) => { formPauseUntilRef.current = Date.now() + ms }
    const onFocus = (e) => { if (isForm(e.target)) bump(10000) }
    // 部分安卓 WebView 的原生下拉在 focus 之前就展开；pointerdown 先兜一层。
    const onPointerDown = (e) => { if (isForm(e.target)) bump(10000) }
    const onDone = (e) => {
      const tag = e.target && e.target.tagName
      if (tag === 'SELECT') { if (e.type === 'change') bump(1500) } else if (tag === 'INPUT' || tag === 'TEXTAREA') bump(1500)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('change', onDone)
    document.addEventListener('input', onDone)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('change', onDone)
      document.removeEventListener('input', onDone)
    }
  }, [])

  useEffect(() => {
    if (authExpired) return undefined
    // 只有「首屏」与「真的在自动刷新」才补这一发：暂停时切页签 / locking 翻转同样会让本
    // effect 重跑，无条件 refreshSplit() 等于按了暂停还在打接口（C7-040）。首屏例外——
    // 否则暂停着重开页面就是一片空白。
    if (autoRefresh || !bootFetchedRef.current) {
      bootFetchedRef.current = true
      refreshSplit()
    }
    clearInterval(timerRef.current)
    // v3.348：所有页都轮询（用户要求：推送记录/配置/过滤规则/系统 的「自动刷新」必须真的在跑）。
    // 概览/日志拉状态与历史；其余页由统一 tick 让当前面板重拉自己的数据。
    // 页面在后台时不轮询（切回前台立即补一次）：控制台标签页常驻也不该整夜打接口。
    // 暂停（autoRefresh=false）同样不建定时器；恢复时本 effect 重跑并立即补一次。
    if (!autoRefresh) return () => clearInterval(timerRef.current)
    // v3.374：SSE 在线 → 60s 安全轮询（tick 才是主通道）；断线自动回到 15s；任务在跑仍按
    // POLL_BUSY_MS 快轮询。间隔取上面唯一那次 pollIntervalFor 的结果（见「轮询节奏」块）。
    const mark = () => setNextAt(Date.now() + interval)
    // 只在这一个地方持定时器：SSE tick 不另建 interval，它复用 runTick（顺带复位倒计时）。
    markRef.current = mark
    timerRef.current = setInterval(() => { runTick() }, interval)
    mark()
    // 回前台只重排下一拍（别刚回来就补一发，补拉由下面的「回到前台」effect 统一发：
    // 那里还会通知当前面板一起刷新，重复请求会翻倍）。
    const onVis = () => {
      if (document.hidden) return
      resumeQuietUntilRef.current = Date.now() + interval
      mark()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timerRef.current)
      markRef.current = null
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refreshSplit, locking, tab, autoRefresh, authExpired, sseUp, runTick])

  // hash 路由（v3.307）：首次进入补 #/overview；前进/后退跟着切页。
  useEffect(() => {
    // 后退/前进的滚动位置由本页的 per-tab 记忆负责；浏览器默认的
    // scrollRestoration='auto' 会在 layout effect 之后再按历史条目恢复一次，
    // 把刚还原好的位置覆盖掉（实测 forward 回到长页被压回旧位置）。
    const prevRestoration = window.history.scrollRestoration
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    const onHash = () => {
      // 保存并继续落盘期间：锁住页面，别在保存完成前因为第二次点击/后退切走。
      if (leaveSavingRef.current) {
        if (window.location.hash !== '#/filter') window.history.replaceState(null, '', '#/filter')
        return
      }
      const next = resolveTab(window.location.hash)
      if (next === tabRef.current) return
      // 过滤页有未保存草稿：先把地址改回去，再问「保存 / 不保存 / 取消」。
      // 手机左滑/浏览器后退通常会先撞到面板压的 sentinel，这里是第二道保险。
      if (next !== 'filter' && tabRef.current === 'filter') {
        const guard = filterGuardRef.current
        if (guard && guard.dirty) {
          window.history.replaceState(null, '', '#/filter')
          setLeaveRequest((cur) => cur || { target: next, source: 'hash' })
          return
        }
      }
      // 后退/前进也算主动切页：作废在飞的日志跳转，迟到的响应不得再改页。
      logJumpSeqRef.current++
      // 系统页每次进入都重新等两个面板，不能拿上一次的 ready 集合提前收口。
      if (next === 'sys') sysReadyRef.current = null
      // 后退/前进也走同一套记忆与垫高，不再绕过 switchTab 丢失还原。
      prepareScrollRef.current(next)
      renderTabRef.current(next)
    }
    if (!window.location.hash) window.history.replaceState(null, '', '#/overview')
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      if ('scrollRestoration' in window.history) window.history.scrollRestoration = prevRestoration
    }
  }, [])

  // 标题状态点（v3.307）：标签页在后台时也能一眼看出「有失败/在跑」。
  // 只在拿到状态后着色；未加载用灰点，不谎报「正常」。
  useEffect(() => {
    const run = state && state.run && state.run.status === 'ok' ? state.run.value : null
    const stats = state && state.stats && state.stats.status === 'ok' ? state.stats.value : null
    // 部件「损坏/超限」同样是异常（C7-033）：invalid/tooLarge 没有 value，下面的判定只看
    // failed / interrupted ⇒ bad=false ⇒ 标题点还是绿的，把损坏显示成健康。
    const broken = partBroken(state && state.run) || partBroken(state && state.report)
    const bad = broken || !!(stats && stats.today && stats.today.failed > 0) || !!(run && (run.failed > 0 || run.interrupted))
    const dot = authExpired ? '🔴' : !state ? '⚪' : locking ? '🟡' : bad ? '🔴' : '🟢'
    document.title = `${dot} xbk-push 控制台`
  }, [state, locking, authExpired])

  // vwU/vv2：busy 提交成功后启动兜底闹钟；active 确认或超时即清。
  // Sourcery Old-run-unlocks-new-trigger：兜底清 busy 时必须同步清 busyRunIdRef——
  // 只清 busy 留 ref，旧 runId 若随后进历史，会在「下一次提交 setBusy(true) 后、
  // 其 202 未写 ref 前」被解锁 effect 撞上，把新提交的 busy 提前清掉。
  useEffect(() => {
    if (!busy) return undefined
    const t = setTimeout(() => {
      busyRunIdRef.current = null
      setBusy(false)
    }, BUSY_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [busy])

  // 正常解锁路径（Sourcery G_nv）：busy 期间每次刷新比对「提交的那一轮是否已进历史」
  // ——不管它现在运行中还是已结束，出现即解锁。秒完成的任务不再锁到兜底超时。
  useEffect(() => {
    if (!busy) return
    if (busyRunIdRef.current === null) {
      // Sourcery Trigger-busy-after-lost-response：202 已受理但响应体丢失（无 runId 可归属）
      // 时，等「无任何活跃任务」即解锁——2s 快轮询保证任务结束后最多 2s 恢复，不再等 11min 兜底。
      if (refreshedOnceRef.current && !active) {
        setBusy(false)
      }
      return
    }
    if (runs.some((r) => r.id === busyRunIdRef.current)) {
      busyRunIdRef.current = null
      setBusy(false)
    }
  }, [busy, runs, active])

  const handleTriggered = useCallback((runId) => {
    // run id 形态「epoch.seq」字符串（v3.299 评审：进程 epoch 防重启后序列复用误命中）
    if (typeof runId === 'string' && /^\d{13,}\.\d{1,10}$/.test(runId)) busyRunIdRef.current = runId
    refreshSplit()
  }, [refreshSplit])

  // 自动运行状态（/api/auto）的轮询：概览页 2s 一拍（见下面的 effect）。
  // C7-006：旧实现每拍都 ++autoSeqRef 领新号，落地判据却是「这一发还是不是最后发出的」
  // （seq === autoSeqRef.current）。接口 RTT 超过一拍（2s）时，每一发都会在下一拍被自己
  // 判废 ⇒ 实测 12s 内 6 发 0 落地，autoState 停在 null，自动运行中面板连「停止」按钮都不渲染。
  // 两道修：① 在飞就复用同一发（不领新号、不叠请求）；② 判据改成「最后收到」——只要没有
  // 更新的响应已经落地，这一发就允许写状态（真正的旧响应仍被更大的 autoLandedRef 挡掉）。
  // 刻意不借用主轮询的 inFlightRef：两条轮询节奏不同（2s vs 15s/60s），共用一个互斥会互相拖住。
  const autoSeqRef = useRef(0)
  const autoLandedRef = useRef(0)
  const autoFlightRef = useRef(null)
  const refreshAuto = useCallback(() => {
    // 在飞：把手头这一发交给调用方一起等，绝不另领一个更大的号把上一发判废。
    if (autoFlightRef.current) return autoFlightRef.current
    const seq = ++autoSeqRef.current
    const flight = (async () => {
      try {
        const data = await apiGetAuto()
        if (seq > autoLandedRef.current) {
          autoLandedRef.current = seq
          if (data && data.auto) setAutoState(data.auto)
        }
      } catch (e) { /* 轮询失败保留上次状态；401 由全局事件处理 */ }
    })()
    autoFlightRef.current = flight
    // 落定就放开（成功/失败都放）：否则一次异常会把自动运行状态永久冻住。
    flight.then(() => { autoFlightRef.current = null }, () => { autoFlightRef.current = null })
    return flight
  }, [])

  // 下拉刷新（v3.330）：不出页面、不重建 DOM。先广播给当前页签的面板收集各自 loader，
  // 再等主轮询（状态+轮次）、自动运行状态与所有面板一起落定，指示条才收起。
  const refreshActive = useCallback(async (opts = {}) => {
    const force = opts.force === true
    // 回前台补拉要避开表单交互（原生下拉展开时整页重渲染会卡住选择器）；
    // 下拉手势是明确意图，传 force 跨过这段暂停。
    if (opts.respectFormPause && Date.now() < formPauseUntilRef.current) return false
    const detail = { waits: [] }
    window.dispatchEvent(new CustomEvent(PULL_EVENT, { detail }))
    // 没有任何面板接手（如过滤规则页有未保存改动）：连全局请求也不发，下拉就当无事。
    if (detail.waits.length === 0) return false
    const [sRes] = await Promise.allSettled([refreshSplit(force ? { force: true } : undefined), refreshAuto(), ...detail.waits])
    const ok = sRes.status === 'fulfilled' && sRes.value === true
    // 失败不推进时间戳：否则接下来 30s 内都不会再补，数据一直停在旧值。
    if (ok) lastRefreshRef.current = Date.now()
    return ok
  }, [refreshSplit, refreshAuto])
  const pullRefresh = useCallback(() => refreshActive({ force: true }), [refreshActive])
  // 回到前台：隐藏期间所有轮询都停了（主轮询 tick、面板自己的 interval、/api/auto），
  // 数据必然停在离开那一刻，浏览器不会替我们重拉。回来立刻静默补一轮（不显示
  // 「正在刷新…」、不重建页面）：走和下拉完全相同的刷新路径，当前页签的面板自己决定
  // 拉什么（有未保存草稿时它们不接，这里也就什么都不发）。
  // 只有「刚刷完就切回来」（距上次成功刷新 < VISIBLE_REFRESH_GAP_MS）才跳过——
  // 来回切窗口不该每次都打一遍接口。
  useEffect(() => {
    // 注意：暂停自动刷新只是停轮询。这里是一次性的「回来补一刀」，不受暂停影响——
    // 用户切回来最想看到的就是最新数据，而不是「已暂停」四个字。
    if (authExpired) return undefined
    const onVis = () => {
      if (document.hidden) return
      if (Date.now() - lastRefreshRef.current < VISIBLE_REFRESH_GAP_MS) return
      refreshActive({ respectFormPause: true }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refreshActive, authExpired])
  const pull = usePullToRefresh(pullRefresh, !authExpired)
  // 手机窄屏 .sync 是横向可滚动的：用户把它滑到右边时，行内状态会被裁在视口外。
  // 下拉一开始就把它滚回最左（状态就在第一个位置），保证反馈看得见。
  const syncRef = useRef(null)
  useEffect(() => {
    if (pull.state !== 'idle' && syncRef.current) syncRef.current.scrollLeft = 0
  }, [pull.state])

  // 概览页才轮询状态，避免非概览页每 2s 重渲染（与主轮询同纪律）。
  useEffect(() => {
    if (tab !== 'overview') return undefined
    let alive = true
    // 后台标签页同样不轮询：这条 2s 轮询不在主轮询 effect 里，此前一直照跑，
    // 是「隐藏 15s 仍有请求」的主因。切回前台由「回到前台」effect 统一补拉（连带 refreshAuto）。
    const load = () => { if (alive && !document.hidden) refreshAuto() }
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [tab, refreshAuto])

  const autoOn = !!(autoState && autoState.on)

  // 倒计时显示 tick：纯展示，不参与服务器调度。概览不在前台时不 tick，
  // 否则保活的所有页签会跟着每秒重渲染一遍。
  useEffect(() => {
    if (!autoOn || tab !== 'overview') return undefined
    const t = setInterval(() => setAutoNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [autoOn, tab])

  const saveAutoInterval = useCallback(async (value) => {
    const v = clampAutoSeconds(value)
    const data = await apiSetAuto({ interval: v })
    if (data && data.auto) setAutoState(data.auto)
    return v
  }, [])
  const startAuto = useCallback(async (value) => {
    const v = clampAutoSeconds(value)
    const data = await apiSetAuto({ on: true, interval: v })
    if (data && data.auto) { setAutoState(data.auto); setAutoNow(Date.now()) }
    return v
  }, [])
  const stopAuto = useCallback(async () => {
    const data = await apiSetAuto({ on: false })
    if (data && data.auto) setAutoState(data.auto)
  }, [])

  // v3.297 标签页状态：概览 / 推送记录 / 日志 / 系统。非概览页不跑主轮询，
  // 避免每 5s 的 App 重渲染让推送记录/配置页「闪一下」（刷新记录页有自己的加载）。
  const TABS = [
    { key: 'overview', label: '概览' },
    { key: 'messages', label: '推送记录' },
    { key: 'search', label: '线报搜索' },
    { key: 'logs', label: '运行日志' },
    { key: 'config', label: '配置' },
    { key: 'filter', label: '过滤规则' },
    { key: 'sys', label: '系统' }
  ]
  // 切页回到顶部（v3.306）：手机从概览滚到底部再点「推送记录」，此前会停在
  // 新页面的中段/底部（window.scrollY 被保留），看起来像页面缺了开头。
  // v3.307 同步写 hash：刷新/后退能回到同一页。
  // 切页的统一渲染出口（v3.374）：能上原生 View Transitions 就让浏览器包住这次重渲染做
  // 整页淡入淡出，不支持（或用户关了动效）就静默降级成直接换页——没有 polyfill、没有新依赖。
  // 只包「引起主内容重渲染」的那一下；prepareScroll / 写 hash 都留在包外：它们要读出发页的
  // scrollY，也不能因为过渡回调是异步的而晚一拍。hash 前进后退走同一个出口。
  const renderTab = (next) => {
    runViewTransition(document, motionOK(), (viaTransition) => {
      vtDrivenRef.current = viaTransition
      markVisited(next)
      showSyncFor(next)
      setTab(next)
      tabRef.current = next
    })
  }
  renderTabRef.current = renderTab
  // 真正切页：调用方已经确认没有需要拦截的过滤页草稿。
  const doSwitchTab = (next, replace = false) => {
    if (next === tabRef.current) return
    // 任何主动切页都作废在飞的日志跳转：即使只切走再切回概览（tabRef 仍是 from），
    // 迟到的响应也不得把用户再拽去日志页。
    logJumpSeqRef.current++
    if (next === 'sys') sysReadyRef.current = null
    // 统一走 prepareScroll：保存出发页位置、决定目标页位置、首访时先垫高。
    // 第一次进入沿用当前视口，不把整页拽回顶部；只有「查看日志」走 forceTop。
    prepareScroll(next)
    renderTab(next)
    if (replace) {
      // 过滤页的 sentinel 是压进来的同地址记录；离开时直接替换成目标页，
      // 否则从目标页按后退会回到一个「已经没有草稿」的过滤页旧记录。
      window.history.replaceState({ ...(window.history.state || {}), __xbkFilterGuard: false }, '', `#/${next}`)
    } else if (window.location.hash !== `#/${next}`) {
      window.location.hash = `#/${next}`
    }
  }
  // 切页前先问过滤页：有未保存草稿就不要静默丢掉。
  const switchTab = (next) => {
    if (leaveSavingRef.current) return
    if (next === tab) return
    if (next !== 'filter' && tabRef.current === 'filter') {
      const guard = filterGuardRef.current
      if (guard && guard.dirty) {
        setLeaveRequest({ target: next, source: 'tab' })
        return
      }
    }
    doSwitchTab(next)
  }
  // history 来源的「不保存并离开」：后退一次可能只退到另一条同地址过滤记录
  // （取消时 restoreHistory 会再压 sentinel），继续退到真正离开过滤页为止；最多 5 步。
  const leaveHistory = () => {
    let tries = 0
    const step = () => {
      if (tries++ >= 5) return
      window.history.back()
      window.setTimeout(() => {
        if (resolveTab(window.location.hash) === 'filter') step()
      }, 220)
    }
    step()
  }
  // 离开拦截三选一。history 来源不能直接切页：用户是在后退，保存/放弃后要让浏览器继续走完。
  const closeLeaveRequest = async (mode) => {
    const req = leaveRequest
    if (!req) return
    const guard = filterGuardRef.current
    if (mode === 'save') {
      setLeaveRequest(null)
      leaveSavingRef.current = true
      let saved = false
      try {
        saved = guard && typeof guard.save === 'function' ? await guard.save() : false
      } catch (e) {
        saved = false
      } finally {
        leaveSavingRef.current = false
      }
      // 保存期间用户可能又点过页签；成功/失败都先清掉可能挂出的第二次拦截。
      setLeaveRequest(null)
      // 用户在保存确认里取消，或校验/保存失败：留在过滤页，草稿还在。
      // history 来源的 sentinel 已被这次后退消费掉，取消时要补压一条，下一次左滑仍能拦。
      if (!saved) {
        if (req.source === 'history' && guard && typeof guard.restoreHistory === 'function') guard.restoreHistory()
        return
      }
      // 只有真正保存成功，才继续点「概览」/后退之前的离开动作。
      if (req.source === 'history') leaveHistory()
      else if (req.target) doSwitchTab(req.target, true)
      setLeaveRequest(null)
      return
    }
    if (mode === 'discard') {
      setLeaveRequest(null)
      if (guard && typeof guard.discard === 'function') guard.discard()
      if (req.source === 'history') leaveHistory()
      else if (req.target) doSwitchTab(req.target, true)
      return
    }
    setLeaveRequest(null)
    if (guard && typeof guard.restoreHistory === 'function') guard.restoreHistory()
  }
  // 「查看日志」跳转（v3.318）：先在原页取日志快照，取到再切页。重挂载的 LogsPanel
  // 直接拿这份快照当首帧，不再先 paint 一个 90px 空壳（否则下面的「触发历史」会
  // 顶进视口闪一下）。seq 守卫保证晚到的响应不会把已切走的用户拽回日志页。
  const openLog = useCallback((jump) => {
    const q = jump && jump.q ? jump.q : ''
    const mode = jump && jump.mode ? jump.mode : 'all'
    // 行级跳转带完整时间戳（YYYY-MM-DD HH:MM:SS）；页签/横幅跳转没有，日志页显示整天。
    const focus = jump && typeof jump.focus === 'string' ? jump.focus : ''
    const seq = ++logJumpSeqRef.current
    const from = tabRef.current
    return apiGetLogs().then(
      (d) => {
        if (seq !== logJumpSeqRef.current) return { ok: false, canceled: true }
        // 等待期间用户已切到别的页签：这次跳转作废，不能过一会儿再把人拽回来。
        if (tabRef.current !== from) return { ok: false, canceled: true }
        const at = Date.now()
        // 数据截至直接记这次预取的落盘时间，切页后首帧就显示正确时间。
        syncMemRef.current.logs = at
        prepareScrollRef.current('logs', { forceTop: true })
        markVisited('logs')
        logJumpPendingRef.current = true
        setLogJump({ q, mode, focus, n: seq, data: d })
        showSyncFor('logs')
        setTab('logs')
        tabRef.current = 'logs'
        if (window.location.hash !== '#/logs') window.location.hash = '#/logs'
        return { ok: true }
      },
      (e) => {
        // 迟到的失败同样要作废：用户已经切走时不能在他的新页面上弹旧错误。
        if (seq !== logJumpSeqRef.current || tabRef.current !== from) return { ok: false, canceled: true }
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    )
  }, [markVisited])
  // 循环切主题：一次点击换下一套，按钮上直接显示当前主题名（不弹菜单，手机少一次点按）。
  const cycleTheme = () => {
    // 多标签页：cookie 才是共享偏好——先读它再算下一位，别拿本标签页的旧 state
    // 把另一个标签页刚改的主题覆盖回去（Sourcery #286）。
    const shared = readThemeCookie() || currentThemeKey()
    const at = THEMES.findIndex((t) => t.key === shared)
    const next = THEMES[(at + 1) % THEMES.length]
    // 颜色过渡只在切换窗口内生效（v3.360）：常驻 transition 会让所有 hover/选中变慢。
    const root = document.documentElement
    root.classList.add('theme-anim')
    clearTimeout(themeTimerRef.current)
    themeTimerRef.current = window.setTimeout(() => root.classList.remove('theme-anim'), 320)
    // 先落 React 状态再写 cookie：写 cookie 抛异常时不会出现「CSS 变了、按钮还是旧名」。
    setTheme(next.key)
    applyThemeKey(next.key)
  }
  const themeLabel = (THEMES.find((t) => t.key === theme) || THEMES[0]).label
  const nextThemeLabel = (THEMES[(THEMES.findIndex((t) => t.key === theme) + 1) % THEMES.length] || THEMES[0]).label
  // 顶栏倒计时与面板自轮询都用这个值，必须与真实定时器同源（v3.374）：SSE 在线时是 60s，
  // 写死 15s 就会出现「4 秒后刷新」却 60 秒才动一次的假信息。值来自上面唯一那次
  // pollIntervalFor（C7-059：同一文件算两遍容易漂移），这里只起个与用途同名的别名。
  const pollMs = interval
  // 顶栏徽章只在「概览/日志 + 自动刷新开」时是活状态；其它情况（暂停、推送记录/配置/系统）
  // 主轮询已停，徽章显示的是离开时的快照——必须注明，不能永久挂着「任务运行中」（审查 #246）。
  // 顶栏徽章只在「自动刷新开 + 未失效」时是活状态；所有页都轮询（v3.348），
  // 不再有「（快照）」后缀——数据新旧看后面的时间。
  const livePolling = !authExpired && autoRefresh
  const badgeText = authExpired
    ? '凭证失效'
    : locking ? '任务运行中' : '空闲'
  // 顶栏状态行：所有页同一套词，只有时间来源不同（概览看最近刷新，其它页看本页拉到数据的时间）。
  const syncAt = tab === 'overview' ? lastSync : panelSync
  return html`<div class="wrap" ref=${wrapRef}>
    <header class="topbar">
      <div class="sync" ref=${syncRef} role="group" aria-label="状态与刷新" tabindex="0">
        <${Badge} tone=${authExpired ? 'bad' : locking ? 'run' : 'ok'}>${badgeText}<//>
        <span class="sync-meta">
          ${pull.state !== 'idle'
            ? html`<${PullRefreshStatus} state=${pull.state} />`
            : html`<${TapTip} showDate=${showDate} tip=${showDate && syncAt ? `数据截至：${fmtLocalTime(syncAt)} ${fmtWeekday(syncAt)}（${TZ_LABEL}）` : ''} hint=${showDate && syncAt ? '点看' : ''}><${AutoRefreshText} nextAt=${nextAt} pollMs=${pollMs} lastSync=${syncAt} showDate=${showDate} paused=${!autoRefresh || authExpired} live=${livePolling} /><//>`}
        </span>
        <button type="button" class="sync-toggle" aria-pressed=${autoRefresh ? 'true' : 'false'}
          onClick=${() => { setAutoRefresh((v) => !v) }}>${autoRefresh ? '暂停' : '继续'}</button>
        <button type="button" class="sync-toggle theme-btn" onClick=${cycleTheme}
          aria-label=${'切换主题（当前 ' + themeLabel + '，下一套 ' + nextThemeLabel + '）'}
          title=${'主题：' + themeLabel + ' → ' + nextThemeLabel}>◐ ${themeLabel}</button>
      </div>
      ${syncErr ? html`<div class="sync-fail" role="status">${syncErr}</div>` : ''}
    </header>

    ${newVersion !== '' && html`<div class="alert-banner nudge" role="status">
      <div class="alert-main">
        <strong>控制台已更新到 ${newVersion}</strong>
        <span class="alert-sub">当前页面还在跑启动时的旧脚本，刷新后生效；正在填的表单会丢，先复制再刷。</span>
      </div>
      <button type="button" class="alert-action" onClick=${() => window.location.reload()}>刷新页面</button>
    </div>`}

    ${authExpired && html`<div class="alert-banner bad" role="alert">
      <div class="alert-main">
        <strong>凭证已失效，控制台已停止自动刷新</strong>
        <span class="alert-sub">请用带 <code>?token=</code> 的完整链接重新打开；若链接已过期，从部署环境重新获取 XBK_CONSOLE_TOKEN。</span>
      </div>
      <a class="alert-action" href="/">重新登录</a>
    </div>`}

    <nav class="tabs" ref=${tabsRef} data-edge=${tabEdge || undefined} onScroll=${syncTabEdge}>
      ${TABS.map((t) => html`<button key=${t.key} class=${'tab-btn' + (tab === t.key ? ' active' : '')}
        aria-current=${tab === t.key ? 'page' : undefined}
        onClick=${() => switchTab(t.key)}>${t.label}</button>`)}
    </nav>

    <main class="main" id="main">

    ${!authExpired && visited.has('overview') && html`<section class="page" hidden=${tab !== 'overview'}>
      <div>
      <${AlertBanner} state=${state} onOpenLog=${openLog} />
      <${StatusCards} state=${state} err=${statusFailed} />
      <${TriggerBar} onTriggered=${handleTriggered} locking=${locking} setBusy=${setBusy} runs=${runs} active=${tab === 'overview'}
        auto=${{ on: autoOn, interval: autoState && Number.isInteger(autoState.interval) ? autoState.interval : AUTO_DEFAULT_S, runs: autoState && autoState.runs ? autoState.runs : 0, err: autoState && autoState.lastError ? autoState.lastError : '', nextAt: autoState && autoState.nextAt ? autoState.nextAt : 0, now: autoNow, start: startAuto, stop: stopAuto, save: saveAutoInterval }} />
      <${RunsPanel} runs=${runs} status=${runsState} active=${tab === 'overview'} pollMs=${autoRefresh && tab === 'overview' ? pollMs : 0} onRefresh=${refreshSplit} />
      <${TrendsPanel} active=${tab === 'overview'} />
      <${RunHistoryPanel} onOpenLog=${openLog} active=${tab === 'overview'} />
      <${CacheHealthPanel} paused=${!autoRefresh || tab !== 'overview'} active=${tab === 'overview'} />
      </div>
    </section>`}
    ${!authExpired && visited.has('messages') && html`<section class="page" hidden=${tab !== 'messages'}>
      <${MessagesPanel} active=${tab === 'messages'} onSync=${syncFor.messages} pollTick=${pollTick} />
    </section>`}
    ${!authExpired && visited.has('search') && html`<section class="page" hidden=${tab !== 'search'}>
      <${SearchPanel} active=${tab === 'search'} onSync=${syncFor.search} />
    </section>`}
    ${!authExpired && visited.has('logs') && html`<section class="page" hidden=${tab !== 'logs'}>
      <div>
      ${/* 日志在前、触发历史在后（v3.317）：362×795 下旧顺序让日志框从 y=826 开始，
           首屏一行日志都看不到；排障时日志才是主内容，触发历史滚下去看。 */ ''}
      <${LogsPanel} key=${logJump ? logJump.n : 'base'} active=${tab === 'logs'}
        pollMs=${autoRefresh && tab === 'logs' && locking ? POLL_BUSY_MS : 0}
        initialQuery=${logJump ? logJump.q : ''} initialMode=${logJump ? logJump.mode : 'all'}
        focusAt=${logJump && logJump.focus ? logJump.focus : ''}
        focusDate=${logJump ? logJump.q : ''}
        initialData=${logJump ? logJump.data : null} onSync=${syncFor.logs} />
      ${runs.length > 0 && html`<${RunsPanel} runs=${runs} status=${runsState} active=${tab === 'logs'} pollMs=${autoRefresh && tab === 'logs' ? pollMs : 0} onRefresh=${refreshSplit} />`}
      </div>
    </section>`}
    ${!authExpired && visited.has('config') && html`<section class="page" hidden=${tab !== 'config'}>
      <${ConfigPanel} active=${tab === 'config'} onSync=${syncFor.config} pollTick=${pollTick} />
    </section>`}
    ${!authExpired && visited.has('filter') && html`<section class="page" hidden=${tab !== 'filter'}>
      <${FilterRulesPanel} onSync=${syncFor.filter} active=${tab === 'filter'} pollTick=${pollTick}
        guardRef=${filterGuardRef} onLeaveRequest=${requestFilterLeave} />
    </section>`}
    ${!authExpired && visited.has('sys') && html`<section class="page" hidden=${tab !== 'sys'}>
      <div>
      <${SysPanel} onReady=${onSysReady} active=${tab === 'sys'} onSettingsSaved=${reloadUiSettings} pollTick=${pollTick} onFresh=${onFresh} onSettings=${applyUiSettings} />
      <${FilesPanel} onReady=${onFilesReady} active=${tab === 'sys'} pollTick=${pollTick} onFresh=${onFresh} />
      </div>
    </section>`}

    </main>

    <footer class="foot">
      ⚠️ 「正式运行一轮」会真实推送，触发前二次确认 · 试运行只抓取不推送 · 同一时刻只能有一个触发任务
    </footer>
    ${!authExpired && html`<${BackToTop} />`}
    ${leaveRequest && html`<${LeaveGuardDialog} open=${true}
      count=${filterGuardRef.current && filterGuardRef.current.count ? filterGuardRef.current.count : 1}
      busy=${!!(filterGuardRef.current && filterGuardRef.current.busy)}
      onCancel=${() => closeLeaveRequest('cancel')}
      onSave=${() => closeLeaveRequest('save')}
      onDiscard=${() => closeLeaveRequest('discard')} />`}
  </div>`
}

export { App, ErrorBoundary }
