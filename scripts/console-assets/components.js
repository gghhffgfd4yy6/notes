// scripts/console-assets/components.js —— 控制台公用零件（v3.368 从 ui.js 拆出）。
// 状态徽章 / 提示 / 折叠 / 面板头 / 骨架 / 按钮 / 下拉 / 日期区间 / 卡片 / 状态卡 / 触发条 / 二次确认弹窗。
// 只依赖 htm-preact、pure.mjs、format.js、constants.js、api.js、flatpickr 与 floating-ui；不认识任何页面，也没有顶层副作用。
// 页面面板在 pages.js、外壳在 ui.js（顺序：本文件 → pages.js → ui.js），文本断言按 CONSOLE_MODULE_FILES 聚合读源码。
import { html, useCallback, useEffect, useLayoutEffect, useRef, useState } from './htm-preact.module.js'
import { ageFromStamp, dateRangeLabel, relDay, scrollDeltaInto } from './pure.mjs'
import flatpickr from './flatpickr.js'
// 定位引擎（vendored 单文件 ESM，MIT）：只导出 computePosition/offset/flip/shift/size。
import { computePosition, flip, offset, shift, size } from './floating-ui.module.js'
import { MOTION, useMorphDialog, useMountReveal, useRevealWhen } from './motion.js'
import { TZ_LABEL } from './constants.js'
import { fmtClock, fmtDuration, fmtLocalTime, fmtNum } from './format.js'
import { DAY_KEY_RE, apiGetConfig, trigger, triggerNotifyTest } from './api.js'

// ── 组件：状态徽章 ──────────────────────────────────────────────────────────
// tone: 'ok'=正常绿 | 'bad'=异常红 | 'warn'=有历史失败琥珀 | 'run'=中性黄（运行中/无记录）
// 显式字符串四态而非 true/false/null 魔值（CodeQL implicit null→string conversion）。
function Badge ({ tone, children }) {
  const cls = tone === 'ok'
    ? 'badge-ok'
    : (tone === 'bad' ? 'badge-bad' : (tone === 'warn' ? 'badge-warn' : 'badge-run'))
  return html`<span class="badge ${cls}">${children}</span>`
}

// 顶栏用的时间：v3.342 起「是否带年月日」可设置（默认带）。只影响显示，tip 里永远是完整时间。
function fmtBarTime (ts, withDate) {
  const s = fmtLocalTime(ts)
  if (s === '—' || withDate !== false) return s
  return s.slice(11)
}

// 顶栏状态行：所有页共用这一个组件、这一套词（v3.346）。
//  - 轮询中的页（概览/日志）秒数倒数；不轮询的页给配置的间隔，不假装在倒数。
//  - 开头写「N 秒后刷新」而不是「自动刷新 Ns」：后者会被读成刷新间隔（其实是倒计时）。
//  - 暂停时只换开头两个字，后半句「数据截至 北京时间 时间」保持同一形态。
// 独立持有 1s 时钟：避免 App 每秒重渲染整页（安卓原生 select 会闪）。
function AutoRefreshText ({ nextAt, pollMs, lastSync, showDate = true, paused = false, live = true }) {
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    // 不轮询的页不需要秒级时钟，别白建定时器。
    if (!live) return undefined
    // v3.347：500ms 而不是 1000ms。1s 的时钟和 mark() 不同相，最多落后近 1s，
    // 实测倒数会「5 4 3 2 → 5」直接跳过 1s（用户真机录屏反馈的顿挫感就来自这里）。
    const t = setInterval(() => setNowMs(() => Date.now()), 500)
    return () => clearInterval(t)
  }, [live])
  const at = lastSync ? fmtBarTime(lastSync, showDate) : '—'
  // 手机顶栏放不下「日期 + 时分秒 + 点看」：秒放进可隐藏的 span，点开仍看完整时间。
  const colon = at.lastIndexOf(':')
  const atMain = colon > 0 ? at.slice(0, colon) : at
  const atSec = colon > 0 ? at.slice(colon) : ''
  if (paused) return html`已暂停 · <span class="sync-label">数据截至 ${TZ_LABEL} </span>${atMain}<span class="sync-sec">${atSec}</span>`
  const sec = Math.max(1, Math.round(pollMs / 1000))
  const remain = live ? Math.max(0, Math.min(sec, Math.ceil(((nextAt || (Date.now() + pollMs)) - nowMs) / 1000))) : sec
  return html`${remain} 秒后刷新 · <span class="sync-label">数据截至 ${TZ_LABEL} </span>${atMain}<span class="sync-sec">${atSec}</span>`
}

// 星期几也只按北京时间取：本地 getDay() 在北京时间跨零点时会差一天，和上面的时间对不上。
function fmtWeekday (ts) {
  if (!ts) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(Number(ts) + 8 * 3600 * 1000).getUTCDay()]
}

// 两个弹层共用：computePosition 的结果直写 DOM。不走 vdom 的 style 属性——控制台每 500ms
// 重渲染一次，字符串 style 会把这里刚写好的定位值整条覆盖（旧实现为此每次滚动 setState）。
function placeAt (pop, x, y) {
  pop.style.left = `${Math.round(x)}px`
  pop.style.top = `${Math.round(y)}px`
}

// 键盘导航把列表项滚进内层滚动框（MiniSelect 与 CategoryPicker 共用，原来两处各写一遍）。
// 只调 focus({preventScroll:true}) 会把获得焦点的项停在框外（Sourcery #254）；让浏览器默认
// focus 滚动又会把整页猛地带下去。矩形比较与差值收在 pure.mjs 的 scrollDeltaInto（Node 可测），
// 这里只负责 focus 与把增量写回 scrollTop。
function scrollIntoBox (el, box) {
  if (!el) return
  el.focus({ preventScroll: true })
  if (!box || !box.contains(el)) return
  const d = scrollDeltaInto(el.getBoundingClientRect(), box.getBoundingClientRect())
  if (d !== 0) box.scrollTop += d
}

// 吸顶页签下方的落点留白 = .tabs 实测高度 + 8。列表落点、落点门（推送记录/逐轮历史）、
// 过滤规则首个错误行、日志行定位五处同口径；散着写时漏一处 +8 就整体偏 8px。
// 用 height 而不是 bottom：页签还没吸顶时 bottom 会多算它自己的页面偏移。
function stickyPad () {
  const tabs = document.querySelector('.tabs')
  return (tabs ? tabs.getBoundingClientRect().height : 0) + 8
}

// v3.341：窄屏下顶栏状态行会被省略号截断（时间只剩半截）。点一下就地弹出完整文本，点页面
// 其它任意地方/按 Esc 收回。弹层用 position: fixed：祖先 .sync 是 overflow:hidden，绝对定位
// 会被裁掉；fixed 也不受滚动容器影响（滚动时直接收回，避免跟着飘）。定位算给 @floating-ui/dom。
function TapTip ({ tip, hint, children, showDate = true }) {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const boxRef = useRef(null)
  const popRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (boxRef.current && boxRef.current.contains(e.target)) return
      if (popRef.current && popRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])
  // 定位：宽度口径不变（200～360，且不超视口 24px），方向/夹取交给 computePosition。
  // 直接写 left/top 而不是走 style 属性——顶栏每秒重渲染，字符串 style 会把这里刚写好的
  // 定位值整条覆盖（首帧先由 CSS 的 visibility:hidden 兜住，量完再显形）。
  useLayoutEffect(() => {
    if (!open) return undefined
    const box = boxRef.current
    const pop = popRef.current
    if (!box || !pop) return undefined
    pop.style.width = `${Math.min(360, Math.max(200, window.innerWidth - 24))}px`
    computePosition(box, pop, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [offset(8), flip(), shift({ padding: 8 })]
    }).then(({ x, y }) => {
      if (!popRef.current) return
      placeAt(popRef.current, x, y)
      setReady(true)
    }).catch(() => {}) // 定位失败就保持原位，不打断交互（computePosition 不会 reject，兜底而已）
    return undefined
  }, [open])
  if (!tip) return html`${children}`
  const toggle = () => {
    if (open) { setOpen(false); return }
    setReady(false)
    setOpen(true)
  }
  return html`<span class=${showDate ? 'tap-tip tap-tip-date' : 'tap-tip'} ref=${boxRef} role="button" tabindex="0"
      aria-expanded=${open ? 'true' : 'false'}
      onClick=${(e) => { e.stopPropagation(); toggle() }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle() }
      }}><span class="tap-tip-text">${children}</span>${hint && html`<span class="tap-tip-hint">${hint}</span>`}</span>
    ${open && html`<span class=${ready ? 'tap-tip-pop' : 'tap-tip-pop tap-tip-pop-wait'} ref=${popRef} role="tooltip">${tip}</span>`}`
}

// 提示行：tone='error' 红色、tone='warn' 琥珀色。页面不再拼 'hint hint-err' 字符串。
function Hint ({ tone, style, children }) {
  // 提示行随错误/成功信息出现：轻量入场，扫一眼就知道「下面多了一行」。
  const ref = useRef(null)
  useMountReveal(ref, { y: 8, duration: MOTION.fast })
  return html`<div ref=${ref} class=${tone === 'error' ? 'hint hint-err' : (tone === 'warn' ? 'hint hint-warn' : 'hint')} style=${style}>${children}</div>`
}

// 入场包装：给「条件渲染的整块内容」补一次性淡入（预览块、提示横幅）。
function Reveal ({ cls, y = 10, duration, role, ariaLive, children }) {
  const ref = useRef(null)
  useMountReveal(ref, { y, duration })
  return html`<div class=${cls} role=${role} aria-live=${ariaLive} ref=${ref}>${children}</div>`
}

// 面板头：标题 + 说明 + 右侧操作（右侧自动左推）。含 select 等复杂头部仍可手写。
// 标题用真 heading 元素（读屏可按标题层级跳转）：默认 h2，页面主面板传 level=${1} 变成 h1。
// 换成 h1/h2 后浏览器默认外边距会把面板头顶高，行内 margin:0 抵掉——视觉密度与旧的 span 完全一致
// （字号/字重/单行/不伸缩都由 .panel-title 既有规则决定，不在这里写样式）。
function PanelHead ({ title, sub, right, afterTitle, level = 2 }) {
  const titleTag = level === 1 ? 'h1' : 'h2'
  return html`<div class="panel-head">
    <${titleTag} class="panel-title" style="margin:0">${title}</${titleTag}>
    ${afterTitle}
    ${sub && html`<span class="panel-sub">${sub}</span>`}
    ${right && html`<span class="panel-right">${right}</span>`}
  </div>`
}

// 首屏骨架：第一份数据回来前先按最终版式占位（记数行 + 3 行列表），不再是一片空白。
// 只在「首次加载且还没有任何数据」时用（调用方条件 loading && !data）——自动刷新、
// 切回已看过的面板时 data 还在，条件不成立，所以不会反复闪骨架。
// 结构在这里，样式（背景色/圆角/动画）由 app.css 的 .skeleton/.skel-* 负责。
function PanelSkeleton ({ label = '正在加载…', rows = 3 }) {
  return html`<div class="skeleton" role="status" aria-label=${label}>
    <div class="skel-top" aria-hidden="true"><span class="skel-bar skel-bar-count"></span></div>
    ${Array.from({ length: rows }, (_v, i) => html`<div class="skel-row" key=${i} aria-hidden="true">
      <span class="skel-bar skel-bar-title"></span>
      <span class="skel-bar skel-bar-meta"></span>
    </div>`)}
  </div>`
}

// 加载失败条：一句中文原因 + 重试按钮（.retry-btn）。重试动作由面板传进来（同一条 load()），
// 不另建请求路径；busy 时禁用，避免连点叠加。
function LoadError ({ text, onRetry, busy = false }) {
  return html`<div class="load-error" role="alert">
    <span class="load-error-text">${text}</span>
    <button type="button" class="retry-btn" disabled=${busy} onClick=${onRetry}>重试</button>
  </div>`
}

// 按钮：variant 生成 `btn btn-<variant>`；修饰词（btn-danger/btn-busy）可拼进 variant。
function Button ({ variant = 'secondary', disabled, onClick, title, buttonRef, ariaBusy, children }) {
  return html`<button ref=${buttonRef} class=${'btn btn-' + variant} disabled=${disabled} onClick=${onClick} title=${title} aria-busy=${ariaBusy}>${children}</button>`
}

// 深色小下拉：趋势窗口/每页条数/时间范围共用。
// 不用原生 <select>：Android Chrome 会弹全屏白底系统列表，和暗色控制台完全割裂
// （分类筛选已因此改 CategoryPicker）。这里保留锚定弹层：选项少时不铺满屏幕，
// 空间不足向上翻，键盘/触屏同一套交互。
// 定位交给 @floating-ui/dom（floating-ui.module.js）：strategy 固定 + offset/flip/shift/size，
// 自家只留「什么时候重量」与键盘/焦点。SELECT_MAX_H 是弹层上限（旧实现写死 320）。
const SELECT_MAX_H = 320

function MiniSelect ({ value, options, onChange, ariaLabel, disabled = false }) {
  const list = Array.isArray(options) ? options : []
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [ready, setReady] = useState(false)
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const focusedRef = useRef(false)

  const selIdx = Math.max(0, list.findIndex((o) => o.value === value))
  const current = list[selIdx]

  const focusOpt = (i) => {
    const pop = popRef.current
    if (!pop) return
    const el = pop.querySelector(`[data-idx="${i}"]`)
    if (!el) return
    // preventScroll + 手工把项滚进弹层可视区（共用 scrollIntoBox）：弹层在页面下部时，
    // 浏览器默认 focus 会把整页猛地滚下去。
    scrollIntoBox(el, pop)
  }

  // 位置只由 computePosition 算：left/top 直写 DOM，size 阶段写 max-height/min-width。
  // 不走 vdom 的 style 属性——预加载轮询每 500ms 重渲染一次，字符串 style 会把这里刚写好的
  // 定位值整条覆盖；直写也就不需要为「滚一下」而 setState。
  const position = useCallback(() => {
    const btn = btnRef.current
    const pop = popRef.current
    if (!btn || !pop) return
    computePosition(btn, pop, {
      strategy: 'fixed',
      // 右缘对齐按钮（旧实现 right:0 的等价形）；flip 翻上去时仍是右缘对齐。
      placement: 'bottom-end',
      middleware: [
        offset(6),
        flip(),
        shift({ padding: 8 }),
        size({
          apply ({ availableHeight, rects, elements }) {
            const max = Math.max(48, Math.min(SELECT_MAX_H, Math.round(availableHeight)))
            elements.floating.style.maxHeight = `${max}px`
            elements.floating.style.minWidth = `${Math.round(rects.reference.width)}px`
          }
        })
      ]
    }).then(({ x, y }) => {
      if (!popRef.current) return
      placeAt(popRef.current, x, y)
      setReady(true)
    }).catch(() => {}) // 定位失败就保持原位，不打断交互（computePosition 不会 reject，兜底而已）
  }, [])

  // 先量再显示：首帧 visibility:hidden，避免先按「向下」铺一帧再翻到上方。
  // 打开期间滚动/缩放要重量（否则页面滚走后弹层停在旧位置的空白处）：rAF 合并同帧事件。
  useLayoutEffect(() => {
    if (!open) return undefined
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
  }, [open, position])

  useEffect(() => {
    if (!open) { focusedRef.current = false; return undefined }
    if (!ready || focusedRef.current) return undefined
    focusedRef.current = true
    setActive(selIdx)
    focusOpt(selIdx)
    return undefined
  }, [open, ready, selIdx])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // busy/loading 时按钮 disabled；必须允许按钮本身失焦，不能再接键盘动作。
  useEffect(() => { if (disabled && open) setOpen(false) }, [disabled, open])

  const openMenu = () => {
    if (disabled) return
    setReady(false)
    setActive(Math.max(0, list.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const close = (refocus) => {
    setOpen(false)
    if (refocus && btnRef.current) btnRef.current.focus({ preventScroll: true })
  }
  const choose = (i) => {
    const o = list[i]
    close(true)
    if (o && o.value !== value) onChange(o.value)
  }
  const move = (i) => {
    if (list.length === 0) return
    const next = Math.max(0, Math.min(list.length - 1, i))
    setActive(next)
    focusOpt(next)
  }
  // Tab 必须显式把焦点送到组件外的下一个/上一个可聚焦控件：只 close 再放行默认行为，
  // 浏览器可能落在即将卸载的选项上，焦点会掉到 body。
  const focusOutside = (dir) => {
    const root = rootRef.current
    const btn = btnRef.current
    if (!root || !btn) return null
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const els = [...document.querySelectorAll(sel)].filter((el) => !root.contains(el) && el.getClientRects().length > 0)
    if (dir < 0) {
      for (let i = els.length - 1; i >= 0; i--) {
        if (btn.compareDocumentPosition(els[i]) & window.Node.DOCUMENT_POSITION_PRECEDING) return els[i]
      }
    } else {
      for (const el of els) {
        if (btn.compareDocumentPosition(el) & window.Node.DOCUMENT_POSITION_FOLLOWING) return el
      }
    }
    return null
  }
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); close(true); return }
    if (!open) {
      if (!disabled && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(active + 1); break
      case 'ArrowUp': e.preventDefault(); move(active - 1); break
      case 'Home': e.preventDefault(); move(0); break
      case 'End': e.preventDefault(); move(list.length - 1); break
      case 'Enter':
      case ' ': e.preventDefault(); choose(active); break
      case 'Tab': {
        e.preventDefault()
        const target = focusOutside(e.shiftKey ? -1 : 1)
        close(false)
        if (target) target.focus({ preventScroll: true })
        else if (btnRef.current) btnRef.current.focus({ preventScroll: true })
        break
      }
    }
  }

  const buttonLabel = current ? current.label : ''
  const buttonAria = current ? `${ariaLabel}，当前 ${buttonLabel}` : ariaLabel
  return html`<span class="mini-select" ref=${rootRef} onKeyDown=${onKeyDown}>
    <button type="button" class="mini-btn" ref=${btnRef} disabled=${disabled}
      aria-haspopup="listbox" aria-expanded=${open ? 'true' : 'false'} aria-label=${buttonAria}
      onClick=${() => { if (open) close(true); else openMenu() }}>
      <span class="mini-label">${buttonLabel}</span>
      <span class="mini-caret" aria-hidden="true">▾</span>
    </button>
    ${open && html`<div class=${ready ? 'mini-pop' : 'mini-pop mini-pop-wait'} ref=${popRef} role="listbox" aria-label=${ariaLabel}>
      ${list.map((o, i) => html`<button type="button" key=${o.value} data-idx=${i}
        class=${'mini-opt' + (o.value === value ? ' on' : '')}
        role="option" aria-selected=${o.value === value ? 'true' : 'false'}
        tabIndex=${i === active ? 0 : -1}
        onFocus=${() => setActive(i)}
        onClick=${() => choose(i)}>
        <span>${o.label}</span>${o.value === value ? html`<span class="mini-check" aria-hidden="true">✓</span>` : ''}
      </button>`)}
    </div>`}
  </span>`
}

// 指标卡：标题 + 右上角徽章 + 若干行文本。换卡片实现（或组件库）只改这里。
// v3.325：卡片加「主数字」——之前四张卡都是同一档小字，扫读时分不出主次。
// main = { num, unit, hint }：数字单独放大 + 等宽数字（tabular-nums），标签压回小字。
// ── 组件：日期区间（v3.326）──────────────────────────────────────────────────
// 所有「按时间筛」的地方共用这一个：推送记录（服务端区间）、运行日志（按行首日期）、
// 逐轮历史（按轮次日期）、趋势（服务端区间）。flatpickr 挂在 1px 隐形 input 上，
// 弹层对齐按钮（positionElement）；只认 Date 数组不解析本地化字符串——zh 语言包的
// 区间分隔符是「 至 」，按 " to " 切永远匹配不上（实测踩过）。
const EMPTY_RANGE = { from: '', to: '' }

// 上海日历日（与 run.log / 服务端同口径）：按钮文案按它判断「是不是今年」。
function todayKeyShanghai () {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function fmtDayKey (d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 月份箭头长按连翻（v3.326）：跨年要按十几下，用户要求按住就能一直翻、按越久翻越快。
// 单击仍旧只翻一个月（原生 click 负责），长按 420ms 后由这里接管自动重复。
function attachMonthHoldRepeat (inst) {
  const pick = (delta) => inst.calendarContainer.querySelector(delta < 0 ? '.flatpickr-prev-month' : '.flatpickr-next-month')
  const bind = (delta) => {
    const el = pick(delta)
    if (!el || el.dataset.holdBound === '1') return
    el.dataset.holdBound = '1'
    let timer = null
    let startTs = 0
    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const step = () => {
      const arrow = pick(delta)
      if (!arrow || arrow.classList.contains('flatpickr-disabled')) return stop()
      inst.changeMonth(delta, true)
      // 越按越快（用户口径：起手约一秒一格，按住越久越快）：
      // 1.2s 内 800ms/格 ≈ 1 格/秒；2.4s 内 400ms；4s 内 200ms；之后 100ms ≈ 10 格/秒。
      const held = Date.now() - startTs
      timer = setTimeout(step, held < 1200 ? 800 : held < 2400 ? 400 : held < 4000 ? 200 : 100)
    }
    // 手势全部自己接管：系统在长按 ~500ms 时会弹选字/预览菜单（手机会"叮"一声），
    // 所以 touchstart / pointerdown 都 preventDefault，点击也只认我们自己的 pointerup。
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation() }, true)
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false })
    el.addEventListener('pointerdown', (e) => {
      if (typeof e.button === 'number' && e.button > 0) return
      e.preventDefault()
      stop()
      startTs = Date.now()
      timer = setTimeout(step, 420)
    })
    el.addEventListener('pointerup', () => {
      const held = Date.now() - startTs
      stop()
      // 没到连翻阈值就是单击：自己翻一格（原生 click 已被吞掉）。
      if (held < 420 && !pick(delta).classList.contains('flatpickr-disabled')) inst.changeMonth(delta, true)
    })
    for (const ev of ['pointerleave', 'pointercancel', 'blur']) el.addEventListener(ev, stop)
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  bind(-1)
  bind(1)
}

// Esc 关闭日历（L2-5）：flatpickr 4.6 只在 _input 与 calendarContainer 上监听 keydown，
// 从 .date-btn 打开时焦点留在按钮上，按键到不了实例 ⇒ 日历关不掉（实测 inst.isOpen 仍为
// true）。打开期间在 document 捕获阶段补一层：命中后关闭并把焦点还给触发按钮；关闭时
// （选完日期 / 点外面 / Esc）立刻解绑，不常驻全局监听。
function bindEscClose (inst, restoreFocus) {
  const onKey = (e) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return
    if (!inst.isOpen) return
    e.preventDefault()
    inst.close()
    if (restoreFocus) restoreFocus()
  }
  document.addEventListener('keydown', onKey, true)
  return () => document.removeEventListener('keydown', onKey, true)
}

function DateRange ({ value, onChange, label = '日期区间', disabled = false }) {
  const from = value && typeof value.from === 'string' ? value.from : ''
  const to = value && typeof value.to === 'string' ? value.to : ''
  const active = DAY_KEY_RE.test(from) && DAY_KEY_RE.test(to)
  const anchorRef = useRef(null)
  const instRef = useRef(null)
  const btnRef = useRef(null)
  const cbRef = useRef(onChange)
  cbRef.current = onChange
  useEffect(() => {
    const el = anchorRef.current
    if (!el) return undefined
    // Esc 监听只在「日历打开期间」挂着（见 bindEscClose），关闭/卸载都要解绑。
    let offEsc = null
    const dropEsc = () => { if (offEsc) { offEsc(); offEsc = null } }
    const inst = flatpickr(el, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      // 只到今天（上海日历日）：数据都按上海日聚合，用浏览器本地 'today' 会在
      // 时差区和上海跨零点后错位（选不到今天 / 选到未来得到空结果，Sourcery #288 M6）。
      maxDate: todayKeyShanghai(),
      disableMobile: true,
      // 单月：双月在 390 宽必然溢出；maxDate 之后第二个月也只剩禁用格。
      showMonths: 1,
      // 月份不用原生 <select>：它弹出的是系统选择器（手机上是白底系统弹层，CSS 改不了），
      // 在深色面板里必然破一致性。改成静态文字 + 左右箭头翻月，年份仍可直接改。
      monthSelectorType: 'static',
      positionElement: btnRef.current || el,
      onReady (_sel, _str, inst) { attachMonthHoldRepeat(inst) },
      // 面板可能开着跨过上海零点：每次打开按当下上海日重设上限。
      onOpen (_d, _s, inst) {
        inst.set('maxDate', todayKeyShanghai())
        dropEsc()
        offEsc = bindEscClose(inst, () => { if (btnRef.current) btnRef.current.focus({ preventScroll: true }) })
      },
      onClose () { dropEsc() },

      onChange (dates) {
        if (!Array.isArray(dates) || dates.length !== 2) return
        const f = fmtDayKey(dates[0])
        const t = fmtDayKey(dates[1])
        if (!DAY_KEY_RE.test(f) || !DAY_KEY_RE.test(t) || f > t) return
        if (cbRef.current) cbRef.current({ from: f, to: t })
        inst.close()
      }
    })
    instRef.current = inst
    return () => { dropEsc(); inst.destroy(); instRef.current = null }
  }, [])
  // 受控值外部变化（清除 ×、切预设、跳转重置）时同步 flatpickr 的选中态：
  // 实例只在挂载时建一次，不同步的话日历仍高亮上一个区间（Sourcery #288 M7）。
  useEffect(() => {
    const inst = instRef.current
    if (!inst) return
    const want = active ? [from, to] : []
    const cur = (inst.selectedDates || []).map(fmtDayKey)
    if (cur.join('|') === want.join('|')) return
    if (want.length === 2) inst.setDate(want, false, 'Y-m-d')
    else inst.clear()
  }, [from, to, active])
  const clear = () => { if (cbRef.current) cbRef.current({ ...EMPTY_RANGE }) }
  return html`<span class="date-range">
    <button type="button" ref=${btnRef} class=${active ? 'date-btn on' : 'date-btn'} disabled=${disabled}
      aria-label=${active ? `${label} ${from} 至 ${to}` : label}
      onClick=${() => { const inst = instRef.current; if (inst) inst.open() }}>
      ${active ? dateRangeLabel(from, to, todayKeyShanghai()) : label}
    </button>
    ${active && html`<button type="button" class="date-clear" aria-label=${`清除${label}`} onClick=${clear}>×</button>`}
    <input ref=${anchorRef} class="fp-anchor" type="text" tabIndex=${-1} aria-hidden="true" readOnly />
  </span>`
}

// 按区间过滤「带 datetime/at 前缀」的条目（客户端侧复用：日志行、逐轮历史）。
function inDayRange (day, range) {
  if (!range || !DAY_KEY_RE.test(range.from) || !DAY_KEY_RE.test(range.to)) return true
  return typeof day === 'string' && day >= range.from && day <= range.to
}

function Card ({ title, badge, main, children }) {
  return html`<div class="card">
    <div class="card-head">
      <span class="card-title">${title}</span>
      ${badge}
    </div>
    ${main
      ? html`<div class="card-main">
          <span class="card-num">${main.num}</span><span class="card-unit">${main.unit}</span>
        </div>
        ${main.hint ? html`<div class="card-hint">${main.hint}</div>` : null}`
      : null}
    <div class="card-lines">${children}</div>
  </div>`
}

// ── 状态归类（Sourcery vvy/vv4/vvX/vwc/vvG：错误态/中断态/畸形条目/失败数不得伪装成健康）──

// 部件三态判定（Sourcery G_od/G_oY）：readStatus 对「文件还没建」返回 truthy status
// （'missing'）且无 value——缺失 ≠ 异常，应中性；「存在但不可读/超限/校验失败」
// （'invalid'/'tooLarge'/...）才是异常，必须标红，不得伪装成「暂无记录」。
// 返回：'ok'（绿）| 'bad'（红）| 'run'（中性）。
function partTone (part, isOk) {
  if (!part) return 'run'
  if (part.status === 'ok') return isOk ? 'ok' : 'bad'
  // ok 之外的显式 status：missing → 中性；invalid/tooLarge 等 → 异常
  if (part.status === 'missing') return 'run'
  return 'bad'
}

// runOk：最近一轮必须「status=ok 且未中断且 failed=0」才算绿（Sourcery vvG：failed>0 不得绿）。
function runIsOk (state) {
  if (!state || !state.run) return false
  if (state.run.status !== 'ok') return false
  const v = state.run.value || {}
  if (v.interrupted === true) return false
  return !(typeof v.failed === 'number' && v.failed > 0)
}

// repOk：日报 status=ok 且 failed=0（同上口径）。
function repIsOk (state) {
  if (!state || !state.report || state.report.status !== 'ok') return false
  const v = state.report.value || {}
  return !(typeof v.failed === 'number' && v.failed > 0)
}

// 通道条目合法性（Sourcery vvC + G_oE：与 scripts/status.js 的 validChannelEntry 同口径——
// 三个计数字段必须同时为非负安全整数，服务端以 lastAlertAt 为必需字段，前端镜像；
// 缺任一字段或负数视为畸形条目，不进展示与健康判定）。
function validCounter (v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}
function validChannelEntry (name, entry) {
  // 空 key 不判畸形（与后端 status.js validChannels 同口径：后端只验 entry 结构，
  // 不验 key 名）——否则同一份 channel-health 后端判 ok、前端标红，两处结论相反。
  return typeof name === 'string' &&
    entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
    validCounter(entry.consecutiveFailures) &&
    validCounter(entry.lastFailureAt) &&
    validCounter(entry.lastAlertAt)
}

// 渠道 id → 展示名：配置页/状态卡不再把 `serverchan` 这种内部键直接端给用户。
const CHANNEL_LABELS = {
  pushplus: 'PushPlus',
  serverchan: 'Server酱',
  bark: 'Bark',
  wecom: '企业微信',
  wxpusher: 'WxPusher',
  xizhi: '息知',
  pushdeer: 'PushDeer',
  pushme: 'PushMe',
  telegram: 'Telegram'
}
function channelLabel (k) {
  return CHANNEL_LABELS[k] || k
}

function channelInfo (state) {
  // Sourcery G_oY：先看部件 status 再看 value——
  //   missing（文件还没建）→ 中性「暂无记录」；
  //   invalid/tooLarge 等坏读 → 红「状态异常」，不得伪装成暂无记录；
  //   ok 但 value 缺失 → 异常（服务端 ok 必带 value，缺失即契约破坏）。
  if (!state || !state.channels) return { tone: 'run', entries: [], note: '暂无记录' }
  if (state.channels.status === 'missing') return { tone: 'run', entries: [], note: '暂无记录' }
  if (state.channels.status !== 'ok') return { tone: 'bad', entries: [], note: '状态异常' }
  const raw = state.channels.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tone: 'bad', entries: [], note: '状态异常' }
  }
  const allKeys = Object.keys(raw)
  const entries = allKeys
    .filter((k) => validChannelEntry(k, raw[k]))
    .map((k) => ({ name: k.length > 0 ? channelLabel(k) : '(空名)', failures: raw[k].consecutiveFailures }))
  // Sourcery Corrupt-channels x2：合法条目全健康但存在畸形条目时，此前 filter 掉畸形后
  // 整卡仍显示绿色「正常」——数据损坏被吞。只要 valid 条目数 < 总键数即标红，
  // 提示「部分通道数据异常」，畸形条目名一并列出。
  const corruptKeys = allKeys.filter((k) => !validChannelEntry(k, raw[k]))
  if (corruptKeys.length > 0) {
    return { tone: 'bad', entries, note: `部分通道数据异常：${corruptKeys.join('、')}` }
  }
  // 空表 ≠ 未配置：只显示中性「暂无记录」（Sourcery vwc）。
  if (entries.length === 0) return { tone: 'run', entries, note: '暂无记录' }
  const tone = entries.every((e) => e.failures === 0) ? 'ok' : 'bad'
  return { tone, entries, note: '' }
}

// 过滤诊断卡片（Sourcery Filter-diagnostics x3）：readStatus 返回 state.diagnostics
// （{status, value}），此前 SPA 从未渲染——无脚本降级版有此信息，JS 版反而丢失。
// 口径与 formatStatus 一致：missing=中性暂无；invalid=红；ok 时展示最近时间与原因分布。
function diagCard (state) {
  if (!state || !state.diagnostics) return []
  const d = state.diagnostics
  if (d.status === 'missing') {
    return [{ title: '过滤诊断', tone: 'run', lines: ['暂无记录'] }]
  }
  if (d.status !== 'ok') {
    return [{ title: '过滤诊断', tone: 'bad', lines: [`状态异常（${d.status}）`] }]
  }
  const v = d.value || {}
  if (!v || typeof v !== 'object') {
    return [{ title: '过滤诊断', tone: 'bad', lines: ['状态异常'] }]
  }
  const reasons = v.byReason && typeof v.byReason === 'object' && !Array.isArray(v.byReason)
    ? Object.entries(v.byReason).map(([k, n]) => `${k}=${typeof n === 'number' ? n : '?'}`).join('，')
    : ''
  return [{
    title: '过滤诊断',
    tone: 'ok',
    lines: [
      `最近 ${fmtNum(v.at)}`,
      `原因分布 ${reasons || '无'}`
    ]
  }]
}

// ── 组件：首屏异常横幅（v3.307）────────────────────────────────────────────
// 只在「最近一轮失败/中断」或「近 7 天有失败」时出现：用户打开控制台第一眼就知道
// 有没有需要处理的事，并可直接跳到带筛选的日志（不再靠逐页翻逐轮历史）。
function AlertBanner ({ state, onOpenLog }) {
  // v3.318：横幅的「查看日志」也走先取后切；150ms 后才显示「加载中…」，失败变「重试 →」。
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const jumpSeqRef = useRef(0)
  const jumpTimerRef = useRef(0)
  useEffect(() => () => clearTimeout(jumpTimerRef.current), [])
  if (!state) return null
  const run = state.run && state.run.value ? state.run.value : null
  const stats = state.stats && state.stats.status === 'ok' ? state.stats.value : null
  const lastFail = stats ? stats.lastFailure : null
  const orphan = run && typeof run.orphanFailures === 'number' ? run.orphanFailures : 0
  const runBad = !!(run && (run.interrupted === true || (typeof run.failed === 'number' && run.failed > 0) || orphan > 0))
  // 周失败只在「今天/昨天」置顶：三天前的失败仍留在「近 7 天」卡里，但不再每天红着脸占首屏。
  // 运行级异常（最近一轮失败/中断/孤儿失败）始终置顶，不受日期限制。
  const failRel = lastFail ? relDay(lastFail.date) : ''
  const recentFail = !!(lastFail && (failRel === '今天' || failRel === '昨天'))
  if (!runBad && !recentFail) return null
  const at = orphan > 0 && run.orphanFailureAt ? run.orphanFailureAt : (runBad && run.at ? run.at : (lastFail ? lastFail.at : ''))
  const text = orphan > 0 && !(run && (run.interrupted === true || run.failed > 0))
    ? `运行日志有 ${orphan} 条失败行未归属任何轮次（独立崩溃，最近 ${run.orphanFailureAt || '时间未知'}）`
    : (runBad
        ? (run.failed > 0
            ? `最近一轮推送失败 ${run.failed} 条（${run.at || '时间未知'}）`
            : `最近一轮异常中断（${run.at || '时间未知'}）`)
        : `近 7 天有失败：${lastFail.date} 推送失败 ${lastFail.failed} 条`)
  const openJump = () => {
    if (!onOpenLog) return
    const seq = ++jumpSeqRef.current
    setFailed(false)
    clearTimeout(jumpTimerRef.current)
    jumpTimerRef.current = window.setTimeout(() => {
      if (seq === jumpSeqRef.current) setBusy(true)
    }, 150)
    Promise.resolve(onOpenLog({ q: at.slice(0, 10), mode: 'issue' }))
      .then((res) => {
        if (seq !== jumpSeqRef.current) return
        if (res && res.ok === false && !res.canceled) setFailed(true)
      })
      .catch(() => {
        if (seq === jumpSeqRef.current) setFailed(true)
      })
      .finally(() => {
        if (seq !== jumpSeqRef.current) return
        clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = 0
        setBusy(false)
      })
  }
  return html`<div class="alert-banner" role="alert">
    <span class="alert-dot" aria-hidden="true"></span>
    <span class="alert-text">${text}</span>
    <button type="button" class="alert-link" aria-busy=${busy ? 'true' : 'false'}
      title=${failed ? '日志加载失败，点此重试' : '查看该日日志'}
      onClick=${openJump}>${busy ? '加载中…' : (failed ? '重试 →' : '查看日志 →')}</button>
  </div>`
}

// ── 组件：状态卡片区 ────────────────────────────────────────────────────────
// v3.307 信息层级：今日 / 近 7 天 / 最近一轮 / 通道与过滤。旧版「最近日报」与「最近一轮」
// 两张卡都在讲最近一次，缺「今天怎么样、成功率多少」；现在日报压成今日卡的一行，
// 过滤诊断并入通道卡，四张卡各答一个问题。
// v3.329：首屏（以及下拉刷新触发的整页重载）在 /api/status 回来前，四张卡必须已经按最终
// 形态占位。此前 !state 直接 return null，卡片块整块缺席，下面的「手动触发」先顶到页签下；
// 状态回来后再插入一块 340px 高的卡片，手机上就是整屏一闪（360×795 实测「手动触发」顶部
// 180 → 536.5，跳 356.5px）。占位只写「—」不写 0/「正常」，不谎报数据。
const CARD_PLACEHOLDERS = [
  { title: '今日', tone: 'run', badge: '—', main: { num: '—', unit: '', hint: '正在读取…' }, lines: ['失败 —', '日报 —'] },
  { title: '近 7 天', tone: 'run', badge: '—', main: { num: '—', unit: '', hint: '正在读取…' }, lines: ['失败 — · 成功率 —', '日均 — 轮'] },
  { title: '最近一轮', tone: 'run', badge: '—', main: { num: '—', unit: '', hint: '正在读取…' }, lines: ['获取 — · 失败 — · 耗时 —'] },
  { title: '通道与过滤', tone: 'run', badge: '—', main: { num: '—', unit: '条被过滤', hint: '正在读取…' }, lines: ['最近过滤 —', '原因 —'] }
]

function CardsGrid ({ cards, busy }) {
  const ref = useRef(null)
  // 占位卡也算 .card：等真实数据（busy 结束）再播，别把入场浪费在「正在读取…」上。
  useRevealWhen(ref, !busy && cards.length > 0, '.card', { y: 18, step: 0.05, cap: 5 })
  return html`<div class="cards" ref=${ref} aria-busy=${busy ? 'true' : undefined}>
    ${cards.map((c) => html`<${Card} key=${c.title} title=${c.title} main=${c.main}
      badge=${html`<${Badge} tone=${c.tone}>${c.badge}<//>`}>
      ${c.lines.map((l) => html`<div key=${l}>${l}</div>`)}
    <//>`)}
  </div>`
}

function StatusCards ({ state, err }) {
  // 占位文案只区分「正在读」与「读取失败」两种，都是一行，不改变预留高度。
  if (!state) {
    const hint = err ? '读取失败' : '正在读取…'
    const cards = CARD_PLACEHOLDERS.map((c) => ({ ...c, main: { ...c.main, hint } }))
    return html`<${CardsGrid} cards=${cards} busy=${!err} />`
  }
  const rep = state.report && state.report.value ? state.report.value : null
  const repTone = partTone(state.report, repIsOk(state))
  const run = state.run && state.run.value ? state.run.value : null
  const runTone = partTone(state.run, runIsOk(state))
  const runDry = run && run.dryRun != null
  const runBad = run && (run.interrupted === true || run.failed > 0)
  const chan = channelInfo(state)
  const stats = state.stats && state.stats.status === 'ok' ? state.stats.value : null
  const today = stats ? stats.today : null
  const week = stats ? stats.week : null
  const diag = diagCard(state)[0] || null
  const diagTone = diag ? diag.tone : 'run'
  const diagLines = diag ? diag.lines : ['暂无记录']
  // v3.325：通道卡的「主数字」用被过滤条数（有信息量），连续失败放 hint。
  const diagRaw = state.diagnostics && state.diagnostics.status === 'ok' ? state.diagnostics.value : null
  const diagReasons = diagRaw && diagRaw.byReason && typeof diagRaw.byReason === 'object'
    ? Object.entries(diagRaw.byReason).map(([k, n]) => `${k} ${typeof n === 'number' ? n : '?'}`).join('，')
    : ''
  const filteredCount = diagRaw && diagRaw.byReason && typeof diagRaw.byReason === 'object'
    ? Object.values(diagRaw.byReason).reduce((a, n) => a + (typeof n === 'number' ? n : 0), 0)
    : null
  const diagAt = diagRaw ? diagRaw.at : null
  const chanMax = chan.entries.length > 0 ? Math.max(...chan.entries.map((e) => e.failures)) : 0
  const repRel = rep ? relDay(rep.date) : ''
  const rateText = (r) => (r && typeof r.successRate === 'number' ? `${(r.successRate * 100).toFixed(1)}%` : '—')
  const todayTone = !today ? 'run' : (today.failed > 0 ? 'bad' : (today.rounds > 0 ? 'ok' : 'run'))
  // 周失败用琥珀色而非红色：它仍是「过去 7 天」的事实，但不应让三天前的故障长期染红首屏。
  const weekTone = !week ? 'run' : (week.failed > 0 ? 'warn' : (week.rounds > 0 ? 'ok' : 'run'))
  const chanTone = (chan.tone === 'bad' || diagTone === 'bad') ? 'bad' : (chan.tone === 'ok' ? 'ok' : 'run')
  const runAge = run ? ageFromStamp(run.at) : ''
  const cards = [
    {
      title: '今日',
      tone: todayTone,
      badge: !today ? '—' : (today.failed > 0 ? '异常' : (today.rounds > 0 ? '正常' : '—')),
      main: today
        ? { num: fmtNum(today.pushed), unit: '条推送', hint: `轮次 ${today.rounds} · 成功率 ${rateText(today)}` }
        : { num: '—', unit: '', hint: '暂无 run.log 数据' },
      lines: today
        ? [
            `失败 ${fmtNum(today.failed)}${today.failed > 0 ? ' ⚠️' : ''}`,
            // 「正常」不再重复写在日报行：右上角状态点已经表达，重复反而每次都要读两遍。
            `日报 ${rep ? `${rep.date || '—'}${repRel ? `（${repRel}）` : ''}${repTone === 'ok' ? '' : repTone === 'bad' ? ' · 异常' : ' · 暂无'}` : '暂无'}`
          ]
        // 没有 run.log 数据时也要占满两行：行数随数据增减会让卡片块在加载完成的瞬间长高/变矮，
        // 把下面的面板整体推走（Sourcery PR #292：首帧占位必须与加载完成态同高）。
        : ['失败 —', '日报 —']
    },
    {
      title: '近 7 天',
      tone: weekTone,
      badge: !week ? '—' : (week.failed > 0 ? '有失败' : (week.rounds > 0 ? '正常' : '—')),
      main: week
        ? { num: fmtNum(week.pushed), unit: '条推送', hint: `轮次 ${week.rounds}${stats && stats.truncated ? ' · 仅统计尾部' : ''}` }
        : { num: '—', unit: '', hint: '暂无数据' },
      lines: week
        ? [
            `失败 ${fmtNum(week.failed)} · 成功率 ${rateText(week)}`,
            `日均 ${(week.rounds / 7).toFixed(1)} 轮`
          ]
        : ['失败 — · 成功率 —', '日均 — 轮']
    },
    {
      title: '最近一轮',
      tone: runDry ? (runBad ? 'bad' : 'warn') : runTone,
      badge: !run
        ? '—'
        : (run.cancelled === true
            ? '已取消'
            : (runDry ? (runBad ? '试跑异常' : '试跑') : (runBad ? '异常' : '正常'))),
      main: run
        ? {
            num: fmtNum(runDry ? run.dryRun : run.pushed),
            unit: runDry ? '条未推送' : '条推送',
            hint: `${runAge || '时间未知'}${run.at ? ` · ${run.at.slice(5, 16)}` : ''}`
          }
        : { num: '—', unit: '', hint: '暂无数据' },
      lines: run
        ? [
            `获取 ${fmtNum(run.total)} · 失败 ${fmtNum(run.failed)} · 耗时 ${fmtNum(run.elapsed)}${run.cancelled === true ? ' · ⏹ 已取消' : run.interrupted ? ' · ⚠️ 中断' : ''}`
          ]
        : ['获取 — · 失败 — · 耗时 —']
    },
    {
      title: '通道与过滤',
      tone: chanTone,
      badge: chanTone === 'bad' ? '异常' : (chanTone === 'ok' ? '正常' : '—'),
      // 主数字换成「被过滤条数」：连续失败 0 当大字没意义（0 太抢且不是成绩）。
      main: {
        num: filteredCount === null ? '—' : fmtNum(filteredCount),
        unit: '条被过滤',
        hint: `${chan.entries.length > 0 ? chan.entries.map((e) => e.name).join('、') : (chan.note || '暂无记录')}${chanMax > 0 ? ` · 连续失败 ${chanMax}` : ' · 连续失败 0'}`
      },
      lines: diagLines.length > 0
        ? [`最近过滤 ${fmtNum(diagAt)}`, `原因 ${diagReasons || '无'}`]
        : ['最近过滤 —', '原因 —']
    }
  ]
  return html`<${CardsGrid} cards=${cards} />`
}

// ── 组件：触发按钮 ──────────────────────────────────────────────────────────
// 自动正式运行由服务器调度；前端只负责输入/保存/开关与展示状态。
const AUTO_MIN_S = 3
const AUTO_MAX_S = 20
// 打开确认弹窗前等配置接口的上限：正常一发几十毫秒；超时就先用兜底文案开，
// 绝不为了等渠道名把按钮卡住，也绝不在弹窗显示后再换文案（会缩一行）。
const CONFIRM_NAMES_WAIT_MS = 600
const AUTO_DEFAULT_S = 10
const AUTO_MAX_FAILS = 3
// 数字输入框统一禁用，只允许用加减按钮调整；按住 450ms 后连续变化，
// 越按越快（最多 50/次），避免从 10 调到 3600 要点几百下。
const HOLD_START_MS = 450
const HOLD_REPEAT_MS = 110
const HOLD_ACCEL_MS = 1000
const HOLD_MAX_STEP = 50
function useHoldRepeat (onStep, disabled = false) {
  const timerRef = useRef(0)
  const activeRef = useRef(false)
  const startedAtRef = useRef(0)
  const stepRef = useRef(onStep)
  stepRef.current = onStep
  const stop = useCallback(() => {
    activeRef.current = false
    clearTimeout(timerRef.current)
  }, [])
  useEffect(() => {
    if (disabled) stop()
    return stop
  }, [disabled, stop])
  const start = (delta) => (e) => {
    if (disabled || activeRef.current) return
    if (e && e.pointerType === 'mouse' && e.button !== 0) return
    if (e && e.cancelable) e.preventDefault()
    activeRef.current = true
    startedAtRef.current = Date.now()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    stepRef.current(delta)
    const tick = () => {
      if (!activeRef.current) return
      const elapsed = Date.now() - startedAtRef.current
      const mult = elapsed < HOLD_ACCEL_MS
        ? 1
        : Math.min(HOLD_MAX_STEP, 1 + Math.floor((elapsed - HOLD_ACCEL_MS) / 250))
      stepRef.current(delta * mult)
      timerRef.current = setTimeout(tick, HOLD_REPEAT_MS)
    }
    timerRef.current = setTimeout(tick, HOLD_START_MS)
  }
  const click = (delta) => (e) => {
    // 鼠标/触摸的第一次变化在 pointerdown 已做；键盘（detail=0）和读屏仍走 click。
    if (!disabled && e && e.detail === 0) stepRef.current(delta)
  }
  const contextMenu = (e) => e.preventDefault()
  return { start, stop, click, contextMenu }
}
function clampAutoSeconds (v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return AUTO_DEFAULT_S
  return Math.min(AUTO_MAX_S, Math.max(AUTO_MIN_S, n))
}
const ACTION_DEFS = [
  { key: 'dry-run', label: '试运行', desc: '抓取但不推送', cls: 'btn-secondary' },
  { key: 'run', label: '正式运行一轮', desc: '抓取并真实推送', cls: 'btn-danger-solid' },
  { key: 'check', label: '环境检查', desc: '不抓取不推送', cls: 'btn-secondary' },
  { key: 'notify-test', label: '通知自检', desc: '向全部渠道发一条测试消息（真实推送）', cls: 'btn-secondary' }
]

// ── 组件：危险动作二次确认（v3.307）────────────────────────────────────────
// 「正式运行一轮」「通知自检」会真实推送，之前是蓝色主按钮一键触发、警示文案在页脚
// （桌面隔 1100px、手机更远）。现在弹窗列出真实目的地，默认焦点在「取消」。
// 每个弹窗实例一个唯一标题 id：页签保活后多个页面可能同时留着一个未关闭的弹窗，
// 固定 id 会让无障碍名称重复（Sourcery #271）。
let dialogSeq = 0

// 原生 <dialog> 接管这层遮罩：顶层（top layer）、焦点陷阱、背景 inert、关闭后把焦点还给
// 触发元素都由浏览器实现，组件不再手写。只留两件浏览器不管的事：
//   ① showModal() 必须早于量尺寸——未打开的 dialog 是 display:none，量出来全是 0；
//   ② 退场动画播完才 close()——close() 会立刻把面板抽出顶层，先调就没有缩回/滑出的动画。
// open 由父级持有（关闭即卸载），所以打开与兜底关闭落在同一个 layout effect 里。
function useNativeDialog (ref, open) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return undefined
    if (!el.open) {
      // 老浏览器（iOS < 15.4）没有 showModal：退回 open 属性，视觉仍是原来那层 fixed
      // 遮罩（.modal-backdrop/.drawer-backdrop 自带定位），只是没有顶层与焦点陷阱。
      if (typeof el.showModal === 'function') el.showModal()
      else el.setAttribute('open', '')
    }
    // 父级直接切走（不走关闭动画）时补一次 close()：否则顶层与焦点链留在原地。
    return () => { if (el.open) el.close() }
  }, [open])
  // 退场动画结束时调用；close() 顺带把焦点还给打开前的元素（原生 focus restoration）。
  return useCallback(() => {
    const el = ref.current
    if (el && el.open) el.close()
  }, [])
}

// 两个弹窗共用的关闭/焦点骨架：onCancel 每次渲染存进 ref（busy 守卫不被旧闭包绕过），
// Esc 与「打开时聚焦」只写一遍——两份弹窗各抄一份会被 Sonar 判重复代码。
// 焦点陷阱与背景 inert 已交给原生 dialog，这里不再挂 document 级 keydown。
function useDialogChrome (open, onCancel, { initialFocusRef = null, fallbackRef = null, closeDialog }) {
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => {
      const target = (initialFocusRef && initialFocusRef.current) || (fallbackRef && fallbackRef.current)
      if (target) target.focus()
    }, 0)
    return () => { clearTimeout(t) }
  }, [open, initialFocusRef])
  // Escape：浏览器先派发 cancel 再决定要不要自己关。preventDefault 拦住默认关闭，改走与
  // 「取消」按钮同一条退场路径（动画结束才 close()），否则面板会「啪」一下消失。
  const onCancelEvent = (e) => {
    e.preventDefault()
    closeDialog(() => onCancelRef.current())
  }
  return [onCancelRef, onCancelEvent]
}

function ConfirmDialog ({ open, title, confirmLabel, busy, confirmDisabled = false, initialFocusRef = null, onConfirm, onCancel, children }) {
  const cancelRef = useRef(null)
  const [titleId] = useState(() => `confirm-title-${++dialogSeq}`)
  // 弹窗「从哪来回哪去」：从触发按钮的位置放大展开，取消/遮罩/Esc 时缩回按钮再卸载。
  const backRef = useRef(null)
  const boxRef = useRef(null)
  const closeNative = useNativeDialog(backRef, open)
  const [closeDialog, dialogClosing] = useMorphDialog(backRef, boxRef, open)
  // 退场动画播完才 close()：先关就没有缩回动画，焦点也来不及回到触发按钮。
  const dismiss = (done) => closeDialog(() => { closeNative(); done() })
  // 回调每次渲染都是新函数；若把它放进 focus effect 的依赖，busy 变化会重新聚焦密码框，
  // 手机上表现为点「解密」后键盘又弹一下。ref 在 useDialogChrome 里更新。
  const [onCancelRef, onCancelEvent] = useDialogChrome(open, onCancel, { initialFocusRef, fallbackRef: cancelRef, closeDialog: dismiss })
  if (!open) return null
  // 遮罩与面板合成一个 <dialog>：浏览器负责顶层、焦点陷阱与背景 inert，视觉仍由
  // .modal-backdrop / .modal 两条规则决定（class 名与选择器不变）。
  return html`<dialog class="modal-backdrop" ref=${backRef} role="dialog" aria-modal="true"
    aria-labelledby=${titleId} oncancel=${onCancelEvent}
    onClick=${(e) => { if (e.target === e.currentTarget) dismiss(() => onCancelRef.current()) }}>
    <div class="modal" ref=${boxRef}>
      <div class="modal-title" id=${titleId}>${title}</div>
      <div class="modal-body">${children}</div>
      <div class="modal-actions">
        <${Button} variant="secondary" buttonRef=${cancelRef} disabled=${dialogClosing} onClick=${() => dismiss(() => onCancelRef.current())}>取消<//>
        <${Button} variant="danger-solid" disabled=${busy || confirmDisabled || dialogClosing} onClick=${onConfirm}>${confirmLabel}<//>
      </div>
    </div>
  </dialog>`
}

// 未保存草稿的离开拦截：三选一（取消 / 不保存并离开 / 保存并继续），默认焦点在取消。
// 「保存并继续」会走正常的保存确认；只有真正保存成功，App 才继续原来的切页/后退动作。
function LeaveGuardDialog ({ open, count, busy, onCancel, onSave, onDiscard }) {
  const cancelRef = useRef(null)
  const [titleId] = useState(() => `leave-title-${++dialogSeq}`)
  const backRef = useRef(null)
  const boxRef = useRef(null)
  const closeNative = useNativeDialog(backRef, open)
  const [closeDialog, dialogClosing] = useMorphDialog(backRef, boxRef, open)
  const dismiss = (done) => closeDialog(() => { closeNative(); done() })
  const [onCancelRef, onCancelEvent] = useDialogChrome(open, onCancel, { fallbackRef: cancelRef, closeDialog: dismiss })
  if (!open) return null
  return html`<dialog class="modal-backdrop" ref=${backRef} role="dialog" aria-modal="true"
    aria-labelledby=${titleId} oncancel=${onCancelEvent}
    onClick=${(e) => { if (e.target === e.currentTarget) dismiss(() => onCancelRef.current()) }}>
    <div class="modal" ref=${boxRef}>
      <div class="modal-title" id=${titleId}>有未保存的过滤规则</div>
      <div class="modal-body">
        <div class="fr-dialog-line">当前有 ${count} 个字段还没保存。</div>
        <div class="fr-dialog-line">点「不保存并离开」会丢掉这些修改；直接关闭页面或切到后台，草稿会自动保留。</div>
        <div class="modal-note">「保存并继续」会直接保存，保存成功后自动继续刚才的离开操作；「取消」继续编辑。</div>
      </div>
      <div class="modal-actions">
        <${Button} variant="secondary" buttonRef=${cancelRef} disabled=${dialogClosing} onClick=${() => dismiss(() => onCancelRef.current())}>取消<//>
        <${Button} variant="danger-solid" disabled=${busy || dialogClosing} onClick=${onDiscard}>不保存并离开<//>
        <${Button} variant="primary" disabled=${busy || dialogClosing} onClick=${onSave}>保存并继续<//>
      </div>
    </div>
  </dialog>`
}

// ── 组件：右侧抽屉（v3.378）──────────────────────────────────────────────
// 用法边界（按「内容少用弹窗 / 要对照用抽屉 / 彻底换流程用整页」）：
//   列表点开一条、改完还要接着看下一条 ⇒ 抽屉（背后列表保持不动，滚动位置不跳）；
//   短确认、二选一 ⇒ ConfirmDialog；长表单、深流程 ⇒ 整页。
// 宽度 520 起步：桌面留出左侧列表做对照；≤640px 铺满（手机上没有并排对照的余地）。
// 与弹窗共用 useDialogChrome：打开时焦点落在关闭按钮；Esc、点遮罩、关闭按钮三条路径都走
// requestClose。焦点陷阱与「关闭后焦点回到触发元素」由原生 <dialog> 负责。
function Drawer ({ open, title, sub = '', width = 520, busy = false, onClose, children, footer = null }) {
  const backRef = useRef(null)
  const closeRef = useRef(null)
  const [titleId] = useState(() => `drawer-title-${++dialogSeq}`)
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef(null)
  const closeNative = useNativeDialog(backRef, open)
  // 关闭动画期间禁止重复触发；父级 busy（例如保存中）时直接忽略关闭请求，避免半截状态。
  // 滑出动画（.drawer-closing）播完才 close()：close 会立刻把面板抽出顶层，先关就没有滑出。
  const requestClose = useCallback(() => {
    if (busy) return
    setClosing(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { closeNative(); setClosing(false); if (typeof onClose === 'function') onClose() }, 170)
  }, [busy, onClose, closeNative])
  const onCloseRef = useRef(requestClose)
  onCloseRef.current = requestClose
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    if (!open) return undefined
    // Escape 走原生 dialog 的 cancel 事件（见模板里的 oncancel），不再手写 document keydown。
    const t = setTimeout(() => { if (closeRef.current) closeRef.current.focus() }, 0)
    // 抽屉打开时锁住页面滚动：背后列表还在，滚动会带着抽屉一起动。原生 dialog 只管顶层与
    // 背景 inert，不负责锁滚动（iOS Safari 尤其不锁），所以这一层必须留。
    const root = document.documentElement
    const prevOverflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      clearTimeout(t)
      root.style.overflow = prevOverflow
    }
  }, [open])
  if (!open) return null
  // 遮罩与面板合成一个 <dialog>：顶层、焦点陷阱、背景 inert、关闭后还焦点都由浏览器做，
  // 视觉仍由 .drawer-backdrop / .drawer 决定（class 名与选择器不变）。
  return html`<dialog class="drawer-backdrop" ref=${backRef} role="dialog" aria-modal="true"
      aria-labelledby=${titleId} oncancel=${(e) => { e.preventDefault(); onCloseRef.current() }}
      onClick=${(e) => { if (e.target === e.currentTarget) onCloseRef.current() }}>
    <section class=${'drawer' + (closing ? ' drawer-closing' : '')} style=${{ '--drawer-w': `${width}px` }}>
      <header class="drawer-head">
        <div class="drawer-head-text">
          <h2 class="drawer-title" id=${titleId}>${title}</h2>
          ${sub ? html`<div class="drawer-sub">${sub}</div>` : null}
        </div>
        <button type="button" class="drawer-x" ref=${closeRef} aria-label="关闭" onClick=${() => onCloseRef.current()}>×</button>
      </header>
      <div class="drawer-body">${children}</div>
      ${footer ? html`<footer class="drawer-foot">${footer}</footer>` : null}
    </section>
  </dialog>`
}

// ── 触发结果行（v3.317）─────────────────────────────────────────────────────
// 触发返回 202 后旧界面只把面板头徽标从「任务运行中」改回「空闲」：手机上看不出
// 「刚才那次到底成没成」。这里用 App 已有的 runs（被触发那条 run 的结算）拼一行结果，
// 不新增轮询、不引入新接口。文案：上一轮：环境检查 · 成功 · 16:13:11 · 用时 1.2s
// 这一行在面板里**常驻**（空态也占着 min-height），出现时只换文字，按钮位置不动。
function runOutcome (run) {
  if (run.cancelled === true) return { text: '已停止', tone: 'warn' }
  if (run.timedOut) return { text: '超时', tone: 'bad' }
  if (run.exitCode === null) return { text: '已终止', tone: 'bad' }
  if (run.exitCode === 0) return { text: '成功', tone: 'ok' }
  return { text: `失败（退出码 ${run.exitCode}）`, tone: 'bad' }
}

function triggerResultLine (trig, run) {
  if (!trig) return { text: '', tone: '', final: false }
  const label = trig.label || '任务'
  if (!run) return { text: `上一轮：${label} · 已提交 · ${fmtClock(trig.at)}`, tone: '', final: false }
  if (!run.finishedAt) return { text: `上一轮：${label} · 运行中 · ${fmtClock(run.startedAt)}`, tone: '', final: false }
  const o = runOutcome(run)
  return {
    text: `上一轮：${label} · ${o.text} · ${fmtClock(run.finishedAt)} · 用时 ${fmtDuration(run.startedAt, run.finishedAt)}`,
    tone: o.tone,
    final: true
  }
}

function TriggerBar ({ onTriggered, locking, setBusy, auto, runs = [], active = true }) {
  const [err, setErr] = useState('')
  // 最近一次「提交成功」的触发（202 那一刻记下 id/label/at）；结果由 runs 结算。
  const [lastTrigger, setLastTrigger] = useState(null)
  const lastRun = lastTrigger && lastTrigger.id ? runs.find((r) => r.id === lastTrigger.id) : null
  const live = triggerResultLine(lastTrigger, lastRun)
  // 结算过的结果必须留住（Sourcery：Settled outcomes regress）。服务端只保留最近 20 轮，
  // 被触发那条 run 滑出窗口后 lastRun 变 null、live 退回「已提交」——用户会看到一条已经
  // 跑完（成功 · 用时 1.2s）的记录倒退成「已提交」。所以第一次拿到 final 结果时把文案快照
  // 进 lastTrigger（同一个触发的快照不再覆盖），run 消失后继续用快照渲染。
  useEffect(() => {
    if (!live.final || !lastTrigger || lastTrigger.settled) return
    setLastTrigger({ ...lastTrigger, settled: { text: live.text, tone: live.tone } })
  }, [live.final, live.text, live.tone, lastTrigger])
  const result = live.final || !(lastTrigger && lastTrigger.settled) ? live : lastTrigger.settled
  // 错误走固定的 toast（不占布局）：出现/消失都不许把页面顶动，10s 后自动收起，点按也能关。
  useEffect(() => {
    if (!err) return
    const t = setTimeout(() => setErr(''), 10000)
    return () => clearTimeout(t)
  }, [err])
  // 待确认的真实推送动作（null = 无弹窗）；dry-run/check 不弹窗，直接执行。
  const [pending, setPending] = useState(null)
  // 确认框里的渠道名必须来自「当前配置」，不能拿 channel-health 历史凑数——配置改过之后
  // 历史里可能是已删除的渠道（Sourcery 确认框列错渠道）。
  // 文案还必须在弹窗「画出来之前」定稿：先画模糊文案、配置回来再换成真实渠道名，会让
  // 正文少一行 ⇒ 居中的弹窗在打开后缩一截、上下各跳半行（手机上就是「弹一下」）。
  // 所以每次打开都先取一次配置（最多等 CONFIRM_NAMES_WAIT_MS），把渠道名和 pending
  // 一起 set：首帧就是最终文案；拿不到（失败/超时）才用兜底文案，绝不在显示后改。
  const [pendingNames, setPendingNames] = useState(null)
  const confirmSeqRef = useRef(0)
  // C7-001：这个确认弹窗渲染在概览那一段 <section hidden> 内部。弹窗打开时按浏览器后退
  // （hashchange → 切页）或点别的页签，section 会被置 display:none，而 dialog 仍是 open/:modal
  // ⇒ 弹窗塌成 0×0、整页继续 inert：桌面还能按 Esc，手机上只能刷新页面。
  // 修法＝切页即按「取消」收口（与 onCancel 同一条 setPending(null)，不是只 dialog.close()），
  // 并作废还在路上的 askConfirm——配置 600ms 后才回来的话，不得把弹窗重新弹到隐藏页里。
  // open 另用 active 门控（见下面的 ConfirmDialog）：关闭与切页落在同一次提交，不留坏帧。
  useEffect(() => {
    if (active) return
    confirmSeqRef.current++
    setPending(null)
  }, [active])
  const askConfirm = useCallback((action) => {
    const seq = ++confirmSeqRef.current
    let timer = 0
    let settled = false
    const open = (names) => {
      if (settled || seq !== confirmSeqRef.current) return
      settled = true
      clearTimeout(timer)
      setPendingNames(names)
      setPending(action)
    }
    timer = setTimeout(() => open(null), CONFIRM_NAMES_WAIT_MS)
    apiGetConfig().then((v) => {
      open(v && v.pushChannels && Array.isArray(v.pushChannels.names) ? v.pushChannels.names : [])
    }).catch(() => open(null))
  }, [])
  const channelText = Array.isArray(pendingNames)
    ? (pendingNames.length > 0 ? pendingNames.join('、') : '未配置任何渠道')
    : '所有已配置渠道（以「配置」页为准）'
  // 自动间隔草稿：输入框可自由键入，保存/开始时统一夹到 3–20；运行状态由 App 持有。
  const [autoDraft, setAutoDraft] = useState(String(auto.interval))
  const [autoSaved, setAutoSaved] = useState(false)
  const autoSavedTimerRef = useRef(0)
  useEffect(() => { setAutoDraft(String(auto.interval)) }, [auto.interval])
  useEffect(() => () => clearTimeout(autoSavedTimerRef.current), [])
  const adjustAuto = (delta) => {
    setAutoDraft((prev) => String(clampAutoSeconds(Number(prev) + delta)))
    setAutoSaved(false)
  }
  const holdAuto = useHoldRepeat(adjustAuto)
  const flashAutoSaved = () => {
    setAutoSaved(true)
    clearTimeout(autoSavedTimerRef.current)
    autoSavedTimerRef.current = setTimeout(() => setAutoSaved(false), 1500)
  }
  const saveAuto = async () => {
    setErr('')
    try {
      const v = await auto.save(autoDraft)
      setAutoDraft(String(v))
      flashAutoSaved()
    } catch (e) {
      setErr(`保存失败：${e && e.message ? e.message : e}`)
    }
  }
  const stopAuto = async () => {
    setErr('')
    try { await auto.stop() } catch (e) { setErr(`停止失败：${e && e.message ? e.message : e}`) }
  }
  const doTrigger = useCallback(async (action) => {
    setErr('')
    setBusy(true)
    try {
      // 202 响应带首轮 runId（epoch.seq 字符串，v3.299）——交给 App 登记为 busy 归属
      // （G_nv 解锁判据）。Sourcery Medium：makeRunId 返回字符串，这里不能按数字过滤，
      // 否则 busy 状态丢 run 关联（自检 202 的 string id 被误判为 null）。
      const data = action === 'notify-test' ? await triggerNotifyTest() : await trigger(action)
      const runId = data && typeof data.id === 'string' ? data.id : null
      // 结果行与 busy 归属用同一份数据：202 的 id 还没进 runs 时显示「已提交」，
      // 主轮询把它带进 runs 后自动改成「成功/失败 · 用时」。
      const def = ACTION_DEFS.find((a) => a.key === action)
      setLastTrigger({ id: runId, label: def ? def.label : ((data && data.label) || '任务'), at: Date.now() })
      onTriggered(runId)
      // busy 不在此处清零（Sourcery vvo）：202 只代表已受理，子进程还在跑；App 的
      // 「提交轮进历史」派生 + BUSY_FALLBACK 兜底负责解锁。
    } catch (e) {
      // 幂等重放窗命中（服务端 replayBlocked）：首轮已受理，提示后立即刷新历史
      // 并解锁——这与「提交失败」不同，不该锁按钮。
      if (e && e.replayRunId) {
        setErr(`${e.message}（运行 #${e.replayRunId}）`)
        setBusy(false)
        // 重放命中 = 首轮已受理：把那条 run 登记为结果行来源，否则结果行停在空白/上一次的
        // 旧文案（Sourcery：Replay leaves result line stale）。run.id 是字符串，这里统一转。
        const replayDef = ACTION_DEFS.find((a) => a.key === action)
        setLastTrigger({ id: String(e.replayRunId), label: replayDef ? replayDef.label : '任务', at: Date.now() })
        // Sourcery Old-run-unlocks-new-trigger：这里不能把 prevRunId 登记为 busy 归属
        // （onTriggered 会写 busyRunIdRef）——旧轮通常已在历史里，下一次新提交 setBusy(true)
        // 后、其 202 未返回前，「busy 且 busyRunIdRef 在历史」的解锁 effect 会立即把新提交
        // 的 busy 清掉（按钮提前解锁）。只刷新历史，不登记归属（传 null）。
        onTriggered(null)
        return
      }
      setErr(e.message === '已有触发任务在运行（或锁未过期），请稍后再试'
        ? '已有任务在运行，请等它结束'
        : `触发失败：${e.message}`)
      setBusy(false) // 只有「提交失败」才立即解锁；提交成功的解锁交给「进历史」派生
    }
  }, [onTriggered, setBusy])

  const ask = (action) => {
    setErr('')
    // 只有真实推送需要确认；试运行与环境检查立即执行
    if (action === 'run' || action === 'notify-test') askConfirm(action)
    else doTrigger(action)
  }
  // 自动运行是持续真实推送，必须先确认；确认后用当前草稿值启动。
  const askAuto = () => {
    setErr('')
    setAutoDraft(String(clampAutoSeconds(autoDraft)))
    askConfirm('auto')
  }
  const confirmPending = async () => {
    const action = pending
    setPending(null)
    if (action === 'auto') {
      try {
        const v = await auto.start(autoDraft)
        setAutoDraft(String(v))
      } catch (e) {
        setErr(`启动失败：${e && e.message ? e.message : e}`)
      }
      return
    }
    if (action) doTrigger(action)
  }
  return html`<div class="panel trigger-panel">
    <${PanelHead} title="手动触发" level=${1}
      right=${locking && html`<span class="trigger-busy" role="status" aria-live="polite"
        aria-label="任务进行中，完成后自动解锁" title="任务进行中，完成后自动解锁"><span class="spin"></span><span class="trigger-busy-text">任务进行中…</span></span>`} />
    <div class="btn-row">
      ${ACTION_DEFS.map((a) => html`<div class="btn-item" key=${a.key}>
        <${Button} variant=${a.cls.replace(/^btn-/, '')} disabled=${locking} onClick=${() => ask(a.key)}>${a.label}<//>
        <span class="btn-desc">${a.desc}</span>
      </div>`)}
    </div>
    <div class=${'trigger-result' + (result.tone ? ' ' + result.tone : '')}
      role="status" aria-live="polite" aria-atomic="true">${result.text}</div>
    ${err && html`<div class="trigger-toast" role="alert" title="点按关闭"
      onClick=${() => setErr('')}>${err}</div>`}
    <div class="auto-run">
      <div class="auto-run-head">
        <span class="auto-run-title">自动正式运行</span>
        <span class="auto-run-tag">真实推送</span>
        <span class="auto-run-tag">服务器调度</span>
        ${auto.on && html`<span class="auto-run-live">运行中</span>`}
      </div>
      ${/* 隐藏页签不生成工具条 DOM（L4）：概览保活挂载时，这一排 date-btn/auto-run-row
           会以 hidden 副本留在其它页的 DOM 里；只在 active 时渲染，切走即移除，
           草稿/按住加减等状态都由组件 state 保留，切回不会丢。 */ ''}
      ${active && html`<div class="auto-run-row">
        <button type="button" class="auto-step" aria-label="减少间隔"
          onPointerDown=${holdAuto.start(-1)} onPointerUp=${holdAuto.stop} onPointerLeave=${holdAuto.stop}
          onPointerCancel=${holdAuto.stop} onLostPointerCapture=${holdAuto.stop}
          onContextMenu=${holdAuto.contextMenu} onClick=${holdAuto.click(-1)}>−</button>
        <input class="auto-input" type="number" inputmode="numeric" min=${AUTO_MIN_S} max=${AUTO_MAX_S} step="1"
          aria-label="自动运行间隔（秒）" value=${autoDraft} disabled=${true} />
        <span class="auto-unit">秒</span>
        <button type="button" class="auto-step" aria-label="增加间隔"
          onPointerDown=${holdAuto.start(1)} onPointerUp=${holdAuto.stop} onPointerLeave=${holdAuto.stop}
          onPointerCancel=${holdAuto.stop} onLostPointerCapture=${holdAuto.stop}
          onContextMenu=${holdAuto.contextMenu} onClick=${holdAuto.click(1)}>+</button>
        <${Button} variant="secondary" onClick=${saveAuto}>保存<//>
        ${auto.on
          ? html`<${Button} variant="danger" onClick=${stopAuto}>停止<//>`
          : html`<${Button} variant="danger-solid" onClick=${askAuto}>开始<//>`}
      </div>`}
      <div class="auto-run-note">每轮结束后等待 ${auto.interval} 秒；可调 ${AUTO_MIN_S}–${AUTO_MAX_S} 秒（输入框已锁，长按加减可快速调整）；由服务器常驻运行，关闭页面、切后台、锁屏都不影响，点「停止」才停；连续失败 ${AUTO_MAX_FAILS} 次会自动停止。</div>
      ${auto.on && html`<div class="auto-run-status">${auto.nextAt > 0 ? `下一轮 ${Math.max(0, Math.ceil((auto.nextAt - auto.now) / 1000))} 秒` : '本轮进行中'} · 已自动运行 ${auto.runs} 轮</div>`}
      ${!auto.on && html`<div class="auto-run-status">${autoSaved ? '间隔已保存' : ''}</div>`}
      ${auto.err && html`<${Hint} tone="error">${auto.err}<//>`}
    </div>
    <${ConfirmDialog} open=${pending !== null && active}
      title=${pending === 'run' ? '确认正式运行一轮？' : pending === 'auto' ? '确认开启自动正式运行？' : '确认发送通知自检？'}
      confirmLabel=${pending === 'run' ? '确认真实推送' : pending === 'auto' ? '开始自动运行' : '确认发送'}
      busy=${locking} onConfirm=${confirmPending} onCancel=${() => setPending(null)}>
      ${pending === 'run'
        ? html`<div>将抓取线报并<b>真实推送</b>到：${channelText}。</div><div class="modal-note">推送发出后无法撤回；只想验证抓取流程请用「试运行」（不推送）。</div>`
        : pending === 'auto'
          ? html`<div>将每轮结束后等待 <b>${clampAutoSeconds(autoDraft)} 秒</b>，自动再次<b>正式运行</b>（真实推送）到：${channelText}。</div><div class="modal-note">最低 3 秒、最高 20 秒；运行在服务器上，关闭页面/切后台/锁屏都不影响；点「停止」才停；连续失败 3 次会自动停止。</div>`
          : html`<div>将向全部渠道发送一条<b>真实测试消息</b>：${channelText}。</div><div class="modal-note">这条消息会出现在你的微信/推送客户端里。</div>`}
    <//>
  </div>`
}

// ── 组件：运行历史 ──────────────────────────────────────────────────────────
// 点「日志」时等详情接口的上限（同确认弹窗的 CONFIRM_NAMES_WAIT_MS 口径）：
// 正常一发几十毫秒；超时就先用「加载中…」开框，绝不把点击卡住。
const RUN_LOG_WAIT_MS = 600

export {
  AUTO_DEFAULT_S,
  AlertBanner,
  AutoRefreshText,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  DateRange,
  EMPTY_RANGE,
  Hint,
  LeaveGuardDialog,
  LoadError,
  MiniSelect,
  PanelHead,
  PanelSkeleton,
  RUN_LOG_WAIT_MS,
  Reveal,
  StatusCards,
  TapTip,
  TriggerBar,
  channelLabel,
  clampAutoSeconds,
  fmtWeekday,
  inDayRange,
  placeAt,
  scrollIntoBox,
  stickyPad,
  useHoldRepeat
}
