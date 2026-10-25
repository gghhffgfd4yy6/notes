// scripts/console-assets/format.js —— 时间/字节格式化（v3.365，拆自 app.js）。
// 全是纯函数：只依赖 Date 与入参，不碰 DOM、不读全局状态。时间一律固定 UTC+8（见 constants.js 的 TZ_LABEL）。

// ── 工具 ────────────────────────────────────────────────────────────────────

function fmtTime (ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

function fmtNum (n) {
  return (n === undefined || n === null) ? '—' : String(n)
}

// 浏览器侧时间戳（lastSync = Date.now()）同样按北京时间渲染：顶栏与列表必须同屏同钟。
// 保留这个名字是因为它的语义是「客户端时钟」而不是「本地时区」——改用 fmtTime 之后，
// UTC 客户端看到的时间与列表、与 run.log 一致（此前差 8 小时）。
function fmtLocalTime (ts) {
  return fmtTime(ts)
}

// 只取时分秒（Asia/Shanghai）：触发结果行要与 run.log 的时间对照，口径必须与 fmtTime 一致。
function fmtClock (ts) {
  const s = fmtTime(ts)
  return s === '—' ? '—' : s.slice(11)
}

// 轮次用时：<1s 用 ms（避免「0.0s」），其余一位小数秒。未知返回 '—'（不编 0）。
function fmtDuration (startedAt, finishedAt) {
  const a = Number(startedAt)
  const b = Number(finishedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—'
  const ms = b - a
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// 「多久以前」（缓存写入停滞判断）与日报相对日期见 pure.mjs——纯函数便于行为测试。

// 字节人性化（v3.298 上提为模块级：系统信息与缓存健康面板共用）；0 字节是真实大小，
// 显式显示「0 B」而不是「—」（— 意为未知/不适用，会掩盖 0 字节文件的异常）。
function fmtBytes (b) {
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '—'
  if (b === 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

// 生效快照的 appliedAt 是服务端 ISO 串（writeAppliedSnapshot 写 toISOString），
// 与 run.log 时间戳同口径按 Asia/Shanghai 展示；解析失败原样显示，不吞成「—」。
function fmtIsoStamp (iso) {
  if (!iso) return '—'
  if (typeof iso === 'number') return fmtTime(iso)
  const t = Date.parse(String(iso))
  return Number.isFinite(t) ? fmtTime(t) : String(iso)
}

export { fmtTime, fmtNum, fmtLocalTime, fmtClock, fmtDuration, fmtBytes, fmtIsoStamp }
