// scripts/console-assets/motion.js —— 控制台动效适配层（唯一接触动画库的文件）。
//
// 设计约束（改这里之前先读）：
// 1) 只动 opacity / transform：两者在合成层完成，不触发 reflow，滚动中也不会掉帧。
//    高度/宽度类动画一律不做——控制台多处注释记录过「页面高度突跳」的事故。
// 2) 所有入口先过 motionOK()：用户在系统里关掉动效时一律 no-op，页面直接落到终态。
// 3) 轮询重渲染不得重播入场：只在「挂载」「首次拿到数据」「切页」这些一次性时机触发，
//    hook 内部用 ref 防重复；否则每 5s 整页闪一下。
// 4) 换库只改本文件：app.js 只认 MOTION / enter / reveal / flash 与三个 hook。
import { useLayoutEffect, useRef } from './htm-preact.module.js'
import { animate } from './motion-lib.module.js'
import autoAnimate from './auto-animate.module.js'

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

export function motionOK () {
  return !(reduced && reduced.matches)
}

// 单个元素入场：淡入 + 位移 + 轻微缩放。返回 Motion 的控制句柄（可 cancel），失败返回 null。
export function enter (el, opts = {}) {
  if (!el || !motionOK()) return null
  if (el.getClientRects && el.getClientRects().length === 0) return null
  const y = opts.y === undefined ? MOTION.rise : opts.y
  const x = opts.x === undefined ? 0 : opts.x
  const scale = opts.scale === undefined ? 1 : opts.scale
  const delay = opts.delay === undefined ? 0 : opts.delay
  const duration = opts.duration === undefined ? MOTION.base : opts.duration
  const from = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
  const frames = {}
  if (opts.transform !== false) frames.transform = [from, 'translate3d(0px, 0px, 0px) scale(1)']
  if (opts.fade !== false) frames.opacity = [0, 1]
  // 不套 try/catch：frames 是常量、元素已确认可见，唯一现实失败是 UA 不支持
  // WAAPI——先探一下能力直接返回，避免把 Promise 放进 try（Sonar S4822）。
  if (typeof el.animate !== 'function') return null
  const ctl = animate(el, frames, { duration, delay, ease: EASE })
  // 动画结束后清掉内联 opacity/transform：否则 WAAPI 留下的 `transform: none`
  // 会盖住 CSS 的 hover 抬升/按压反馈（内联样式优先于样式表）。
  // 用序号防止上一段动画的收尾回调清掉后来者的内联值。
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
    flashTimers.set(el, setTimeout(() => {
      el.classList.remove(cls)
      flashTimers.delete(el)
    }, 820))
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
export function useRevealWhen (ref, ready, selector, opts = {}) {
  const fired = useRef(false)
  useLayoutEffect(() => {
    if (!ready || fired.current) return
    fired.current = true
    reveal(ref.current, selector, opts)
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

// 列表增删/移动的 FLIP（推送记录、消息列表）。reduced-motion 由库自己尊重。
export function useListMotion (ref, deps = []) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !motionOK()) return undefined
    try {
      const ctl = autoAnimate(el, { duration: 200, easing: 'ease-out' })
      return () => { if (ctl && typeof ctl.destroy === 'function') ctl.destroy() }
    } catch (e) {
      return undefined
    }
  }, deps)
}
