// scripts/console-assets/motion.js —— 控制台动效适配层（唯一接触动画库的文件）。
//
// 设计约束（改这里之前先读）：
// 1) 只动 opacity / transform：两者在合成层完成，不触发 reflow，滚动中也不会掉帧。
//    高度/宽度类动画一律不做——控制台多处注释记录过「页面高度突跳」的事故。
// 2) 所有入口先过 motionOK()：用户在系统里关掉动效时一律 no-op，页面直接落到终态。
// 3) 轮询重渲染不得重播入场：只在「挂载」「首次拿到数据」「切页」这些一次性时机触发，
//    hook 内部用 ref 防重复；否则每 5s 整页闪一下。
// 4) 换库只改本文件：app.js 只认 MOTION / enter / reveal / flash 与四个 hook。
// 5) 列表位移自己做 FLIP（只补 transform），不引第三方列表动画库：那些库会顺带
//    做宽高过渡，正好踩中第 1 条。
/* global IntersectionObserver */
import { useLayoutEffect, useRef } from './htm-preact.module.js'
import { animate } from './motion-lib.module.js'
import { motionAllowed } from './pure.mjs'

// 时长与曲线集中在这里。曲线是 easeOutQuint 的近似：起步快、收尾软，不弹、不生硬。
export const MOTION = Object.freeze({
  press: 0.12,
  fast: 0.18,
  base: 0.26,
  slow: 0.42,
  rise: 10,
  step: 0.028,
  cap: 6
})

const EASE = [0.22, 1, 0.36, 1]
const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null
const flashTimers = new WeakMap()
const flipRects = new WeakMap()

export function motionOK () {
  return motionAllowed(reduced && reduced.matches)
}

// 统一出口：能力探测 + 收尾清理。清理是必需的——WAAPI 结束后留下的内联
// `transform: none` 会盖掉 CSS 的 hover 抬升/按压反馈（内联样式优先于样式表）。
// 序号防止上一段动画的收尾回调清掉后来者的内联值。
// 不套 try/catch：frames 是常量，唯一现实失败是 UA 不支持 WAAPI——先探测直接返回，
// 免得把 Promise 放进 try（Sonar S4822）。
function play (el, frames, opts) {
  if (!el || typeof el.animate !== 'function') return null
  const ctl = animate(el, frames, opts)
  if (ctl && typeof ctl.then === 'function') {
    const seq = (el.__xbkMotionSeq || 0) + 1
    el.__xbkMotionSeq = seq
    ctl.then(() => {
      if (el.__xbkMotionSeq !== seq) return
      el.style.removeProperty('transform')
      el.style.removeProperty('opacity')
    }).catch(() => {})
  }
  return ctl
}

// 单个元素入场：淡入 + 位移 + 轻微缩放。返回控制句柄（可 cancel），不可播返回 null。
export function enter (el, opts = {}) {
  if (!el || !motionOK()) return null
  if (el.getClientRects && el.getClientRects().length === 0) return null
  const y = opts.y === undefined ? MOTION.rise : opts.y
  const x = opts.x === undefined ? 0 : opts.x
  const scale = opts.scale === undefined ? 1 : opts.scale
  const delay = opts.delay === undefined ? 0 : opts.delay
  const duration = opts.duration === undefined ? MOTION.base : opts.duration
  const frames = {}
  if (opts.transform !== false) {
    frames.transform = [
      `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
      'translate3d(0px, 0px, 0px) scale(1)'
    ]
  }
  if (opts.fade !== false) frames.opacity = [0, 1]
  return play(el, frames, { duration, delay, ease: EASE })
}

// 列表位移补间（FLIP 的后半段）：从旧位置滑回原位，只动 transform。
function slide (el, dx, dy, duration) {
  return play(el, {
    transform: [`translate3d(${dx}px, ${dy}px, 0)`, 'translate3d(0px, 0px, 0px)']
  }, { duration, ease: EASE })
}

// 一组子元素依次入场。延迟按 index 递增并在 cap 处封顶：
// 20 条列表不会等到第 0.56 秒才动，也不会只有前 6 条有动画。
export function reveal (root, selector, opts = {}) {
  if (!root || !motionOK()) return []
  const items = Array.from(root.querySelectorAll(selector))
  const step = opts.step === undefined ? MOTION.step : opts.step
  const cap = opts.cap === undefined ? MOTION.cap : opts.cap
  const out = []
  items.forEach((el, i) => {
    const ctl = enter(el, { ...opts, delay: (opts.delay || 0) + Math.min(i, cap) * step })
    if (ctl) out.push(ctl)
  })
  return out
}

// 校验失败等场景的「看得见」反馈：抖动 + 红圈脉冲。重复调用会重播。
export function flash (el, tone = 'bad') {
  if (!el || !motionOK()) return
  const cls = tone === 'ok' ? 'flash-ok' : 'flash-bad'
  el.classList.remove('flash-ok', 'flash-bad')
  const prev = flashTimers.get(el)
  if (prev) clearTimeout(prev)
  // 下一帧再加类：同一元素连续两次失败也能从头重播（不必读布局强制重排）。
  const seq = (el.__xbkFlashSeq || 0) + 1
  el.__xbkFlashSeq = seq
  window.requestAnimationFrame(() => {
    if (el.__xbkFlashSeq !== seq || !el.isConnected) return
    el.classList.add(cls)
    // 动画总长 1.2s（field-ring），摘类必须晚于它，否则红圈会半路消失。
    flashTimers.set(el, setTimeout(() => {
      el.classList.remove(cls)
      flashTimers.delete(el)
    }, 1250))
  })
}

// 挂载即入场（弹窗、横幅、提示行、预览块）。
export function useMountReveal (ref, opts = {}) {
  useLayoutEffect(() => {
    enter(ref.current, opts)
    // 只在挂载时跑一次：opts 每次渲染都是新对象，不能进依赖
  }, [])
}

// 数据首次就绪时整块 stagger（卡片、表格行、表单分组）。
// ready 一旦为 true 就只播一次；轮询带来的后续渲染不再触发。
// 若此刻所在页签是隐藏的（display:none 量不到尺寸），先不算播过——等它真正
// 露出来再播，否则用户切过去只会看到一块已经到位的静态内容。
export function useRevealWhen (ref, ready, selector, opts = {}) {
  const fired = useRef(false)
  useLayoutEffect(() => {
    if (!ready || fired.current) return undefined
    const root = ref.current
    if (!root) return undefined
    const tryPlay = () => {
      if (fired.current) return true
      if (reveal(root, selector, opts).length === 0) return false
      fired.current = true
      return true
    }
    if (tryPlay()) return undefined
    if (typeof IntersectionObserver !== 'function') return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && tryPlay()) io.disconnect()
    })
    io.observe(root)
    return () => io.disconnect()
  }, [ready])
}

// 打开时入场（弹窗：组件常驻、open 翻转；关闭仍是立即卸载，不做退场排队）。
export function useEnterOnOpen (ref, open, opts = {}) {
  const was = useRef(false)
  useLayoutEffect(() => {
    if (open && !was.current) enter(ref.current, opts)
    was.current = !!open
  }, [open])
}

// 列表增删/重排的 FLIP：上一次布局的矩形存在 WeakMap 里，新布局量一次，位移差
// 用 transform 补回去（新增条目淡入 + 轻推）。只碰 transform/opacity；条目自身
// 变高变矮不参与动画——不会把页面高度带着一起跳。
// deps 省略 = 每次渲染后都校正一次（FLIP 只在矩形真的变了才动，轮询空跑无动画）。
export function useFlipList (ref, deps) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || !motionOK()) return
    const box = root.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) {
      flipRects.delete(root)
      return
    }
    const prev = flipRects.get(root) || new Map()
    const next = new Map()
    let i = 0
    for (const el of root.children) {
      const idx = i++
      const key = el.getAttribute('data-mk') || `#${idx}`
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      next.set(key, r)
      const old = prev.get(key)
      if (!old) {
        enter(el, { y: 6, duration: MOTION.fast, delay: Math.min(idx, 5) * 0.02 })
        continue
      }
      const dx = old.left - r.left
      const dy = old.top - r.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      slide(el, dx, dy, MOTION.fast)
    }
    flipRects.set(root, next)
  }, deps)
}
