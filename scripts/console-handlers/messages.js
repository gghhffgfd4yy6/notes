'use strict'
// 控制台 messages 域 HTTP handler（D1 路由拆分）：推送记录列表/导出、线报全站搜索、关注词。
// 依赖一律经路由表的 ctx 显式注入；不 require scripts/console.js（避免循环依赖）。
function createMessagesHandlers (ctx) {
  const { sendJson, sendJsonConditional, readBody, logCaught } = ctx.http
  const { stateDir, messagesFile } = ctx.paths
  const { isShuttingDown } = ctx.state
  const {
    readMessages, windowMessages, parseDayKey, filterMessageItems, messageCategoriesOf,
    clampQueryBytes, exportRowOf, exportStamp, buildMessagesCsv, sourceDomain, readWatchState
  } = ctx.data
  const { handleLineSearch, handleLineWatchWrite } = ctx.actions
  const {
    MESSAGES_MAX_BYTES, MESSAGES_PAGE_SIZE_MAX, MESSAGES_PAGE_MAX, MESSAGE_DAYS_ALLOWED,
    EXPORT_FORMATS, EXPORT_MAX_ROWS, LINE_WATCH_MAX_WORDS
  } = ctx.consts
  return {
    // ── v3.297 控制台扩展：推送记录 / 趋势 / 日志 / 系统 ─────────────────────────
    // 全部只读（读缓存目录已有文件 + 进程自身信息），不 spawn、不写任何文件；
    // 鉴权与其余读取端点一致（Bearer / ?token= / Cookie 会话）。
    getMessages (req, res, url) {
      const read = readMessages(stateDir, { maxBytes: MESSAGES_MAX_BYTES, filename: messagesFile })
      if (read.status !== 'ok') {
        // missing = 缓存还没建（首轮未跑）；invalid/tooLarge = 数据坏了/过大——
        // 三态如实下发，前端按 partTone 同口径显示，不伪装成「暂无记录」。
        // cacheDirHint：本页读 stateDir + messagesCacheName()（与 /api/status、run.log 同源目录，
        // XBK_CACHE_DIR 可改）；运行侧 Config.cache.dir / pushUrl 指到别处时缓存不在这里——
        // 把目录与文件名口径都告诉运维（Sourcery PR#227「Custom cache records stay hidden」）。
        sendJson(res, 200, {
          status: read.status,
          total: 0,
          page: 1,
          pageSize: 0,
          items: [],
          categories: [],
          cacheDirHint: stateDir,
          cacheFileHint: messagesFile
        })
        return
      }
      const q = url.searchParams
      // 分页参数钳制（URL 是未验证输入）：非法值回退默认，不 400——自用工具宽容输入，
      // 但永远不会越界（page*size 超大切片会复制数组，钳制后上限 100 * 10001 条仍有界）。
      let size = Number(q.get('size'))
      if (!Number.isSafeInteger(size) || size < 1) size = 20
      if (size > MESSAGES_PAGE_SIZE_MAX) size = MESSAGES_PAGE_SIZE_MAX
      let page = Number(q.get('page'))
      if (!Number.isSafeInteger(page) || page < 1) page = 1
      if (page > MESSAGES_PAGE_MAX) page = MESSAGES_PAGE_MAX
      // 过滤：分类精确匹配 + 关键词子串（title / content，大小写不敏感的 ASCII 归一）。
      // 用 includes 而非正则（用户输入直接进正则有 ReDoS 面，本仓正则防护红线）。
      const cate = typeof q.get('cate') === 'string' ? q.get('cate') : ''
      // 超长 query 按 UTF-8 字节截断（而非清空）：清空会让前端仍显示原词、结果却未过滤，
      // 造成「搜了等于没搜」的假象（审查 Sourcery PR#227）。截断后用截断值过滤并回显 queryUsed。
      // （中文按字符截到字节边界：从尾部丢弃不完整多字节序列。）
      let query = typeof q.get('q') === 'string' ? q.get('q').trim() : ''
      query = clampQueryBytes(query)
      const needle = query.length > 0 ? query.toLowerCase() : ''
      // 时间窗（v3.307）：白名单外的值一律回「全部」（宽松输入，不 400）。
      const daysRaw = Number(q.get('days'))
      const days = MESSAGE_DAYS_ALLOWED.includes(daysRaw) ? daysRaw : 0
      // v3.326：自定义日期区间优先于「近 N 天」；非法区间静默回落到 days/全部。
      const win = windowMessages(read.value.items, {
        days, fromKey: parseDayKey(q.get('from')), toKey: parseDayKey(q.get('to'))
      })
      const windowed = win.items
      const items = filterMessageItems(windowed, cate, needle)
      // 行键必须按「条目对象」取原始 keys：过滤/时间窗会改变下标，继续用 start+i 会把
      // 旧行的 rowKey 贴到新行上（展开状态/React key 联动错位）。
      const keyByItem = new Map(read.value.items.map((m, i) => [m, read.value.keys[i]]))
      // 下发字段裁剪：content_html 不出（体积大且含外链 img，CSP 下也渲染不了）；
      // 列表给 title/content 摘要 + 元数据；详情字段由前端展开 content 全文。
      const total = items.length
      const start = (page - 1) * size
      // rowKey：无 id 条目用数组下标合成（与 readMessages 的排序后位置一致——排序稳定，
      // slice 后下标 = 原数组下标）。前端行键/展开用它，匿名条目不再联动。
      const pageItems = items.slice(start, start + size).map((m, i) => ({
        id: typeof m.id === 'number' || typeof m.id === 'string' ? m.id : '',
        // rowKey：readMessages 按「原始数组下标」合成的稳定行键（与 keys 数组对齐取）。
        // 排序/分页不改变键；无 id 的匿名条目也不再共用 '' 导致展开联动。
        rowKey: keyByItem.get(m) !== undefined
          ? keyByItem.get(m)
          : String(m.id !== undefined && m.id !== null ? m.id : `idx-${start + i}`),
        title: typeof m.title === 'string' ? m.title : '',
        // content 全文下发（前端列表自行截断显示）：列表只有 ≤100 条，截到 500 反而让
        // 「展开正文」读不到全文（审查 Sourcery PR#227）。
        content: typeof m.content === 'string' ? m.content : '',
        datetime: typeof m.datetime === 'string' ? m.datetime : '',
        shorttime: typeof m.shorttime === 'string' ? m.shorttime : '',
        shijianchuo: typeof m.shijianchuo === 'number' ? m.shijianchuo : null,
        cateid: typeof m.cateid === 'string' || typeof m.cateid === 'number' ? String(m.cateid) : '',
        catename: typeof m.catename === 'string' && m.catename.length > 0 ? m.catename : '(未分类)',
        price: typeof m.price === 'number' ? m.price : null,
        url: typeof m.url === 'string' ? m.url : ''
      }))
      sendJsonConditional(req, res, {
        status: 'ok',
        total,
        page,
        pageSize: size,
        pages: Math.max(1, Math.ceil(total / size)),
        grandTotal: read.value.total,
        skipped: read.value.skipped,
        // queryUsed：超限截断后实际生效的搜索词（前端据此回显，避免「显示原词、结果未过滤」）
        queryUsed: query,
        // baseUrl：相对 url 的拼接前缀（= 生产 Config.domain，去尾斜杠），前端不再硬编码
        baseUrl: sourceDomain(),
        // 时间窗：0=全部；>0 时 categories 也只统计窗口内条目（筛选器计数要跟手）。
        // 搜索词同样要参与分类计数：否则「搜某某」后仍显示全量分类条数，点进去是空的
        // （Sourcery 分类计数忽略搜索）。
        days: win.days,
        from: win.from,
        to: win.to,
        categories: needle.length > 0
          ? messageCategoriesOf(filterMessageItems(win.days > 0 || win.from !== '' ? windowed : read.value.items, '', needle))
          : (win.days > 0 || win.from !== '' ? messageCategoriesOf(windowed) : read.value.categories),
        items: pageItems
      })
    },
    // POST /api/messages/export（v3.300 批次③ 3.2）：推送记录导出下载。body:
    // format=csv|json&cate=&q=（URLSearchParams；与 /api/runs/detail 同款 POST+body 形态
    // ——fetch 字面量红线 + 筛选词不落访问日志 URL）。page/size 参数按蓝图签名容忍存在但
    // 刻意不读取：导出=筛选结果全量（展示分页是另一口径，蓝图明说「不走 page-size 钳制」；
    // 若按起点偏移切片，「截断到 5000」的 X-Export-Truncated 判据将失去唯一参照）。
    // 无 shuttingDown 闸（定夺见规划 §2.1）：与 /api/runs/detail 同为纯读 POST，detail 无此闸。
    postMessagesExport (req, res, url) {
      readBody(req)
        .then(({ body, aborted, over }) => {
          if (aborted || over) { sendJson(res, 400, { error: '请求中断或超限' }); return }
          const params = new URLSearchParams(body)
          const format = params.get('format')
          if (!EXPORT_FORMATS.includes(format)) { sendJson(res, 400, { error: 'format 必须是 csv 或 json' }); return }
          const cate = typeof params.get('cate') === 'string' ? params.get('cate') : ''
          const query = clampQueryBytes(typeof params.get('q') === 'string' ? params.get('q').trim() : '')
          const needle = query.length > 0 ? query.toLowerCase() : ''
          const daysRaw = Number(params.get('days'))
          const days = MESSAGE_DAYS_ALLOWED.includes(daysRaw) ? daysRaw : 0
          const read = readMessages(stateDir, { maxBytes: MESSAGES_MAX_BYTES, filename: messagesFile })
          if (read.status !== 'ok') {
            // missing/invalid/tooLarge 三态如实下发（与 /api/messages 同形态同哲学）：
            // 不伪装成空 CSV/空 JSON 让用户导出「成功却没数据」的文件；前端按 Content-Type 识别
            // 后展示提示而非下载。
            sendJson(res, 200, { status: read.status, total: 0, items: [], cacheDirHint: stateDir, cacheFileHint: messagesFile })
            return
          }
          const windowedExport = windowMessages(read.value.items, {
            days, fromKey: parseDayKey(params.get('from')), toKey: parseDayKey(params.get('to'))
          }).items
          const filtered = filterMessageItems(windowedExport, cate, needle)
          const truncated = filtered.length > EXPORT_MAX_ROWS
          const rows = (truncated ? filtered.slice(0, EXPORT_MAX_ROWS) : filtered).map(exportRowOf)
          // 截断回显（D2-S9）：列表端点有 queryUsed，导出此前没有——搜索词超过 240 字节被
          // 静默截断时，用户会以为「导出的是我搜的那个词的结果」。JSON 保持裸数组契约
          // （不改成 {items,...} 对象），CSV 也不插注释行，统一走响应头：percent-encoded
          // UTF-8，非 ASCII 安全；未截断也下发，消费方可据此判断词是否被接受。
          const exportMeta = { 'X-Export-Query-Used': encodeURIComponent(query) }
          // 文件名 = messages-<YYYYMMDD-HHmm>.<ext>（北京时间）：同一目录里多次导出不再互相
          // 覆盖，打开就知道是哪一批。名字里只有时间戳，不含查询词/分类——它们可能含 token
          // 形态字符串，绝不回显进头（蓝图防线）；纯 ASCII 见 exportStamp 注释。
          const stamp = exportStamp()
          if (format === 'json') {
            // 仅截断时下发该头；未截断不下发（缺席=完整，测试断言 undefined）。
            if (truncated) res.setHeader('X-Export-Truncated', 'true')
            // 成功导出=直接数组（文档口径「JSON 形态直出数组」，评审 231-M1）：消费方
            // JSON.parse 即得行数组，无需剥 items。截断信息走 X-Export-Truncated 头，
            // 不进响应体（形态纯度优先；三态响应才是 {status,...} 对象，前端按
            // Array.isArray 区分成功/三态——评审 231-H1）。
            const body = JSON.stringify(rows)
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="messages-${stamp}.json"` }, exportMeta))
            res.end(body)
            return
          }
          const head = Object.assign({
            'Content-Type': 'text/csv; charset=utf-8',
            // 只拼本地生成的时间戳：查询词可能含 token 形态字符串，绝不回显进头（蓝图防线）。
            'Content-Disposition': `attachment; filename="messages-${stamp}.csv"`
          }, exportMeta)
          if (truncated) head['X-Export-Truncated'] = 'true'
          // BOM EF BB BF：Excel 无 BOM 按本地代码页解析会乱码中文（蓝图硬性要求）。
          res.writeHead(200, head)
          res.end(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(buildMessagesCsv(rows), 'utf8')]))
        })
        .catch((e) => { logCaught('messages/export', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    },
    // ── v3.370 线报全站搜索 / 关注词（只读代理 + 本机关注词文件）─────────────
    getLineSearch (req, res, url) {
      handleLineSearch(req, res, url).catch((e) => {
        logCaught('line-search', e)
        if (!res.headersSent) sendJson(res, 200, { status: 'upstream_error', error: '线报酷搜索暂不可用，稍后再试' })
      })
    },
    getLineWatch (req, res, url) {
      const stored = readWatchState(stateDir)
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, {
        status: stored.status,
        words: stored.words,
        limit: stored.limit,
        intervalMin: stored.intervalMin,
        enabled: stored.enabled,
        lastCheckAt: stored.lastCheckAt,
        max: LINE_WATCH_MAX_WORDS
      })
    },
    postLineWatch (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      handleLineWatchWrite(req, res, url)
    }
  }
}

module.exports = { createMessagesHandlers }
