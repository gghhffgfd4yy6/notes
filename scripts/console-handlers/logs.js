'use strict'
// 控制台 logs / backup 域 HTTP handler（D1 路由拆分）：运行日志、趋势、运行历史、数据备份导入导出。
// 依赖一律经路由表的 ctx 显式注入；不 require scripts/console.js（避免循环依赖）。
const fs = require('node:fs')
const path = require('node:path')

// v3.533：`/api/logs` 默认窗口（尾部 ≤2000 行且 ≤256 KiB）。perf 取证（opt-api ③）：
// 旧口径整段尾部 1 MiB —— 实测单次 675,579 B / 6,260 行；日志页运行期 2 s 一轮 ≈ 1.17 GB/h
// identity，是全站最大的单项流量；identity 客户端（SSH 隧道/直连）在 <700 kbps 链路上每轮都
// 撞 8 s 超时，于是每 2 s 重传 675 KB、永远成功不了。
// 2000 行够看清最近几十轮 + 报错上下文；256 KiB 让「过 Caddy br6」的首屏稳定在几十 KB 内。
// 读盘量也随之从 1 MiB 降到 256 KiB + 一行余量（约 4× 更少的字节）。
const LOG_TAIL_MAX_LINES = 2000
// 256 KiB 是**响应整体**（identity JSON）的预算，不是正文的上界：JSON 里每个换行要转义成 `\n`
// 两个字节（2000 行 ⇒ 至多 +2000 B），加上 lines/bytes/paged/tail/truncated/maxLines/maxBytes
// 等元数据约 200 B。留 4 KiB 余量（比最坏开销大一倍）给正文，实测长行夹具 263,104 → 259,xxx B。
const LOG_TAIL_MAX_BYTES = 256 * 1024
const LOG_TAIL_TEXT_BYTES = LOG_TAIL_MAX_BYTES - 4096
// 多读一行余量：尾读从任意字节切起，首行是半行必须丢掉，否则窗口会白少一行。
const LOG_TAIL_READ_BYTES = LOG_TAIL_TEXT_BYTES + 8192

// 从尾部按「整行」累加，凑到 ≤maxLines 且 ≤maxBytes 的窗口（v3.533）。
// **不得按字节切**：UTF-8 多字节字符被切开会变成 U+FFFD；这里先按 '\n' 切（JS 字符串层，永不落
// 在字符中间），再从末尾往前收整行，累计字节超限就停。tailCut = 尾读窗口本身切掉了更早的行
// （readSafeTextResult 的 truncated）——首行一律丢弃，它既不是完整行，也可能是半个多字节字符。
function logTailWindow (text, tailCut, maxLines = LOG_TAIL_MAX_LINES, maxBytes = LOG_TAIL_TEXT_BYTES) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n')
  if (tailCut && lines.length > 0) lines.shift()
  // 文件以换行结尾时 split 会多出一个空串：它不是一行内容，丢掉（否则行数恒多 1）。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const kept = []
  let bytes = 0
  let cut = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // 行间换行也算进窗口字节（join('\n') 的真实大小）。
    const size = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (kept.length >= maxLines || bytes + size > maxBytes) { cut = true; break }
    kept.push(line)
    bytes += size
  }
  kept.reverse()
  return { text: kept.join('\n'), lines: kept.length, bytes, truncated: cut || tailCut === true }
}

function createLogsHandlers (ctx) {
  const { sendJson, sendJsonConditional } = ctx.http
  const { stateDir, historyDir } = ctx.paths
  const { readTrends, readRunHistory, parseDayKey } = ctx.data
  const { handleBackupExport, handleBackupImport } = ctx.actions
  const {
    TREND_DAYS_ALLOWED, TREND_DAYS_DEFAULT, RUN_HISTORY_LIMIT_DEFAULT, RUN_HISTORY_LIMIT_MAX
  } = ctx.consts
  return {
    getLogs (req, res, url) {
      // 运行日志在线查看：run.log 尾部 1MiB（与 status.js LOG_READ_OPTIONS.tail 同口径）。
      // 读取源与 /api/run-history、/api/status 同走 historyDir()（D2-S5 复核）：run.log 由
      // 运行侧 MessageStore.cacheDir 写入，Config.cache.dir/XBK_CACHE_DIR 漂移或嵌入式注入
      // 时与 stateDir 分居——旧实现读 stateDir/run.log，日志页在那种部署里恒为空。
      // v3.403：新增 ?list=1（列出当周 + 历史周）与 ?file=&page=&size=（按页读）；
      // 不带这些参数时保持旧的「尾部 1MiB 全文」口径，老前端与测试不受影响。
      const LogArchive = require('../log-archive')
      const dir = historyDir()
      const pageRaw = url.searchParams.get('page')
      const fileRaw = url.searchParams.get('file')
      if (url.searchParams.get('list') === '1') {
        const cur = []
        for (const name of ['run.log', 'filter-diagnostics.ndjson']) {
          let st = null
          // Codacy/Opengrep 的 pathtraversal 规则只放行字符串字面量首参，故本行加行内裸
          // `// nosemgrep`（本仓既有口径，见 xbk_storage.js:17）：name 取自本函数上方写死的
          // 两个日志文件名，dir = historyDir()（运行侧缓存目录，非请求派生），二者都不来自请求。
          try { st = fs.statSync(path.join(dir, name)) } catch (e) {} // nosemgrep（name 取自本函数上方写死的两个日志文件名，dir = historyDir() 常量派生，均不来自请求）
          if (st) cur.push({ file: name, key: 'current', size: st.size, mtimeMs: st.mtimeMs, kind: 'plain', current: true })
        }
        const files = cur.concat(LogArchive.listArchives(dir, 'run.log'), LogArchive.listArchives(dir, 'filter-diagnostics.ndjson'))
        sendJson(res, 200, { status: 'ok', files })
        return
      }
      if (fileRaw || pageRaw) {
        const file = String(fileRaw || 'run.log')
        const ok = file === 'run.log' || file === 'filter-diagnostics.ndjson' ||
          /^logs\/(run|diag)-\d{8}-\d{8}\.log(\.gz)?$/.test(file)
        if (!ok) { sendJson(res, 400, { status: 'bad_file', error: '未知日志文件' }); return }
        const page = Math.max(1, parseInt(pageRaw || '1', 10) || 1)
        const size = Math.min(500, Math.max(50, parseInt(url.searchParams.get('size') || '200', 10) || 200))
        // 本行的 file 已由上方日志名白名单 + 周档正则拦住（非法值直接 400），白名单就是这条
        // 路径的防护，断言不放松；dir = historyDir() 常量派生。故加行内裸 `// nosemgrep`。
        const abs = path.join(dir, file) // nosemgrep（file 已由上方日志名白名单 + 周档正则校验，非法值走 400；dir = historyDir() 常量派生）
        let out = null
        let exists = false
        try { exists = fs.existsSync(abs) } catch (e) {} // nosemgrep（abs 即上一行的 path.join(dir, file)，同一份日志名白名单校验；dir = historyDir() 常量派生）
        try {
          out = file.endsWith('.gz') ? LogArchive.readGzPage(abs, page, size) : LogArchive.readPlainPage(abs, page, size)
        } catch (e) { out = null }
        if (!out) {
          // 文件在但读/解压失败 → corrupt（别伪装成 missing 让控制台静默）；确实没有才 missing。
          sendJson(res, 200, { status: exists ? 'corrupt' : 'missing', file, page, pages: 1, total: 0, lines: [] })
          return
        }
        sendJson(res, 200, { status: 'ok', file, page: out.page, pages: out.pages, total: out.total, size, lines: out.lines })
        return
      }
      // v3.533：默认分支（无 list/file/page 参数）只回「尾部 ≤2000 行且 ≤256 KiB」的窗口，
      // 并走 sendJsonConditional（内容哈希 ETag + 304 空体）：日志没变时 2 s 一拍也只剩响应头。
      // 字段向后兼容：status / text 原样保留（老前端与既有测试按 text 取正文），新增
      // lines / bytes / paged / tail / truncated / maxLines / maxBytes 元数据。
      // 更早的行不丢在磁盘上：翻页仍走上面的 ?file=&page=&size=（周档/当周按页读，行为不变），
      // 「跳到最新」由前端回到本分支（尾部窗口）。
      const { readSafeTextResult } = require('../../xbk_storage')
      const safe = readSafeTextResult(path.join(historyDir(), 'run.log'), LOG_TAIL_READ_BYTES, { tail: true, openNonBlocking: true })
      if (safe.status === 'missing') {
        sendJson(res, 200, { status: 'missing', text: '' })
        return
      }
      if (safe.status !== 'ok') {
        sendJson(res, 200, { status: safe.status, text: '' })
        return
      }
      const window = logTailWindow(safe.text, safe.truncated === true)
      sendJsonConditional(req, res, {
        status: 'ok',
        text: window.text,
        lines: window.lines,
        bytes: window.bytes,
        paged: false,
        tail: true,
        truncated: window.truncated,
        maxLines: LOG_TAIL_MAX_LINES,
        maxBytes: LOG_TAIL_MAX_BYTES
      })
    },
    getTrends (req, res, url) {
      // 近 N 日运行趋势：run.log 摘要行按日聚合（scripts/status.js readTrends，与 parseLastRun
      // 同一正则口径）。days 走白名单（14/30/60），非法/缺省/越界一律回默认 14——向后兼容；
      // readTrends 对 days 无内部钳制，这里的白名单是唯一防线。
      const rawDays = Number(url.searchParams.get('days'))
      const days = TREND_DAYS_ALLOWED.includes(rawDays) ? rawDays : TREND_DAYS_DEFAULT
      // v3.326：自定义区间优先于 days（与推送记录同一口径：非法/颠倒区间静默回落）。
      const trendFrom = parseDayKey(url.searchParams.get('from'))
      const trendTo = parseDayKey(url.searchParams.get('to'))
      const t = readTrends(stateDir, { days, from: trendFrom, to: trendTo })
      if (t.status !== 'ok') {
        sendJson(res, 200, { status: t.status, byDay: [], days })
        return
      }
      sendJsonConditional(req, res, {
        status: 'ok',
        days: t.value.days,
        from: t.value.from,
        to: t.value.to,
        byDay: t.value.byDay,
        // today：Asia/Shanghai 日历日（run.log 时间戳口径），前端「今天」高亮用它；
        // truncated：run.log 超限只统计了尾部（前端副标题如实注明）
        today: t.value.today,
        truncated: t.value.truncated === true
      })
    },
    getRunHistory (req, res, url) {
      // 逐轮运行历史（v3.299 批次②）：直接解析 run.log 摘要行（零新文件零写盘——
      // run.log 是仓内既定的持久逐轮记录，CHANGELOG v3.289 口径）。limit/before 钳制：
      // URL 是未验证输入，Number + 整数 + 区间钳制，用户输入不进正则。
      let limit = Number(url.searchParams.get('limit'))
      if (!Number.isSafeInteger(limit) || limit < 1) limit = RUN_HISTORY_LIMIT_DEFAULT
      if (limit > RUN_HISTORY_LIMIT_MAX) limit = RUN_HISTORY_LIMIT_MAX
      // before 游标（审查 D1-S3）：数字 = 旧的行号游标；条目 key 游标 = 8 位十六进制，
      // 同内容重复行的第 2..n 条带 `-<序号>` 后缀（D2-S4 复核：两条相同摘要行用同一个
      // key 会让 `before` 命中较新一条 → 翻页反复返回同一页）。其它形态一律当未传。
      const rawBefore = String(url.searchParams.get('before') || '')
      let before = 0
      if (/^[0-9a-f]{8}(?:-\d{1,4})?$/.test(rawBefore)) before = rawBefore
      else if (/^\d{1,9}$/.test(rawBefore) && Number(rawBefore) > 0) before = Number(rawBefore)
      // 尾窗指纹（评审 #243-1）：8 位十六进制；其它形态一律当「没带」，不做截断猜测
      const rawWin = String(url.searchParams.get('win') || '')
      const windowKey = /^[0-9a-f]{8}$/.test(rawWin) ? rawWin : ''
      // 「仅运行」：服务端先剔除 CANCEL 留痕再套 limit，避免取消记录挤掉真实轮次。
      const excludeCancelled = url.searchParams.get('excludeCancelled') === '1'
      // Sourcery #229-4 / 审查 #241 S1：run.log 的写入方是运行侧 MessageStore.cacheDir
      // （xbk_app _writeRunLog → MessageStore.cacheDir），不是控制台 stateDir——Config.cache.dir
      // 指向别处时两个目录分居。读取源与 spawn/停止留痕同走 historyDir()（运行侧真实目录优先）。
      const h = readRunHistory(historyDir(), { limit, before, windowKey, excludeCancelled })
      sendJsonConditional(req, res, h)
    },
    // POST /api/backup/export：把勾选的数据类别打包成一个 JSON 下载。
    postBackupExport (req, res, url) {
      handleBackupExport(req, res)
    },
    // POST /api/backup/import：读取备份文件里实际存在的类别并恢复（导入不再让用户勾选）。
    postBackupImport (req, res, url) {
      handleBackupImport(req, res)
    }
  }
}

module.exports = { createLogsHandlers }
