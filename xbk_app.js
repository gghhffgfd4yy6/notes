function createApp ({
  Config, Utils, Formatter, RuleEngine, FilterEngine, MessageStore, Network, Pusher,
  fs, path, crypto, readSafeTextResult, writeAtomic, isRegularOrMissing,
  STATE_TEXT_MAX_BYTES, DEFAULT_MAX_SIZE, RE2C, RE2_WARN_STATE_FILE, RE2_MISSING_WARNING,
  summarizeError, PROFILE3, PROFILE3_BOOT_MARKS, prewarmDns, prewarmTls,
  getNotify, PKG_VERSION, trimTrailingSlashes, compileUserRegex
}) {
  const tokenMatches = (actual, expected) => {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false
    const actualBytes = Buffer.from(actual, 'utf8')
    const expectedBytes = Buffer.from(expected, 'utf8')
    if (actualBytes.length !== expectedBytes.length) return false
    try { return typeof crypto?.timingSafeEqual === 'function' && crypto.timingSafeEqual(actualBytes, expectedBytes) } catch (e) { return false }
  }

  const App = {
  // v3.176：运行日志时间戳本地化（与日报/告警本地口径一致）——曾 toISOString（UTC），
  // UTC+8 用户凌晨 cron 排查时 UTC 行与本地日期混排易误判（系统审查 #9）
    _localStamp () {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    },

    // 文件级安全检查：缓存目录安全并不等于目录内的单个文件安全。
    // 拒绝符号链接/目录作为文件目标，避免 filter.hash/run.log 等路径跟随链接逃逸。
    _isRegularOrMissing (filePath) {
      return isRegularOrMissing(filePath)
    },

    // 状态/哈希文件安全读取：保持 readSafeTextResult 的 status 区分（missing/ioError/
    // unsafe/tooLarge），并强制大小上限，杜绝异常膨胀文件被整读入内存。
    _readSafeState (filePath) {
      return readSafeTextResult(filePath, STATE_TEXT_MAX_BYTES)
    },

    _writeTextAtomic (filePath, text) {
    // v3.245 P1：writeAtomic 内部有 try/catch 正常不抛；此处再加一层防御（如 text 含
    // Symbol 等 String 化异常），任何意外不向调用链冒泡。
      try { return writeAtomic(filePath, text, '缓存文件') } catch (e) { return false }
    },

    // 状态文件统一原子写入（tmp + rename）：避免进程中断留下半写 JSON，导致告警限频/日报累计状态损坏。
    _writeState (filePath, state) {
    // v3.179：类型守卫——state 为 undefined/null/非对象时 JSON.stringify 会静默产出
    // "null"/undefined 文本或抛错，明确告警并拒绝写入，避免状态文件被污染
    // v3.246：数组 typeof 'object' 同样穿透守卫被序列化写入（产出 '[]'），一并拒绝
      if (state === undefined || state === null || typeof state !== 'object' || Array.isArray(state)) {
        const kind = Array.isArray(state) ? 'array' : (state === null ? 'null' : typeof state)
        console.warn(`_writeState: state 必须是非空对象, 实际为 ${kind}, 拒绝写入 ${filePath}`)
        return false
      }
      let text
      try { text = JSON.stringify(state) } catch (e) {
        console.error(`状态序列化失败 ${filePath}:`, e.message)
        return false
      }
      return this._writeTextAtomic(filePath, text)
    },

    // 运行日志：追加一行到缓存目录 run.log（成功摘要/失败 ERROR 共用），超过 1MB 截断保留尾部（防无限增长；写失败静默不中断）
    // v3.xxx P3 并发安全：appendFileSync 在单进程内全程同步无交错；真正竞态在跨进程（重叠 cron/
    // 常驻实例共用同一 cacheDir）——进程 A「追加→读尾→原子改写」的读改写间隙里，B 刚追加的行会被
    // A 的整文件覆盖冲掉（丢日志）。修复：用 run.log.lock（O_EXCL）把「追加 + 超限截尾」包成互斥
    // 临界区；拿不到锁（竞争/陈旧锁/异常）时 fail-open 只追加不截尾，日志绝不因锁而丢。
    // 日志记录名仅接受文件基名，防未来调用传入 ../ 或绝对路径写出缓存目录。
    _writeRunLog (line, filename = 'run.log') {
      try {
        const safeFilename = typeof filename === 'string' && path.basename(filename) === filename ? filename : 'run.log'
        const logPath = path.join(MessageStore.cacheDir, safeFilename)
        if (!this._isRegularOrMissing(logPath)) {
          console.error(`拒绝写入非普通运行日志文件 ${logPath}`)
          return
        }
        const lockPath = logPath + '.lock'
        let lockFd = -1
        try {
        // 跨进程互斥锁：O_EXCL 原子创建，带短退避重试与陈旧锁兜底；崩溃遗留的锁靠 mtime 超龄抢占
          const LOCK_STALE_MS = 10000
          const lockDeadline = Date.now() + 3000
          const waiter = new Int32Array(new SharedArrayBuffer(4))
          for (;;) {
            try {
              lockFd = fs.openSync(lockPath, 'wx')
              try { fs.writeSync(lockFd, `${process.pid}\n`) } catch (e) { /* 锁文件内容仅供排查，失败不影响 */ }
              break
            } catch (e) {
              if (e.code !== 'EEXIST') break // 权限等异常：拿不到锁也继续（fail-open，只追加）
              let stale = false
              try {
                const ls = fs.statSync(lockPath)
                stale = Date.now() - ls.mtimeMs > LOCK_STALE_MS
              } catch (e2) { stale = true } // 锁文件刚被释放/删除：当作空位重试
              if (stale) {
                try { fs.unlinkSync(lockPath) } catch (e2) { /* 抢占失败则下一轮重试 */ }
                continue
              }
              if (Date.now() >= lockDeadline) break // 超时：fail-open，仅追加不截尾
              try { Atomics.wait(waiter, 0, 0, 10) } catch (e2) { /* 非主线程/受限时退避失败，直接重试 */ }
            }
          }
          // C043：ERROR 行 errMsg 截断到 512 字符（与日志行口径一致），防止超长异常 message 撑爆日志行
          let out = line
          const errSep = line.indexOf(' ERROR ')
          if (errSep >= 0 && line.length > 512) {
            const prefix = line.slice(0, errSep + 7)
            let rest = line.slice(errSep + 7)
            const trailingNl = rest.endsWith('\n')
            if (trailingNl) rest = rest.slice(0, -1)
            out = prefix + Utils.truncateUtf16(rest, 512) + (trailingNl ? '\n' : '')
          }
          fs.appendFileSync(logPath, out, 'utf8')
          const st = fs.statSync(logPath)
          const LIMIT = 1024 * 1024
          // v3.257：截尾（读改写）仅在有锁时执行——锁失败/超时 fail-open 分支只追加，
          // 与注释口径一致（无锁的读改写会在跨进程竞态下冲掉并发追加的行）。
          if (lockFd >= 0 && st.size > LIMIT) {
          // v3.246：只读取并保留尾部，替代全量 readFileSync+重写——避免每次超限都做
          // O(n) 全量读入 + 512KB 重写的读写放大（每次追加超 1MB 反复全读）
            const KEEP = 512 * 1024
            const fd = fs.openSync(logPath, 'r+')
            try {
              const readLen = Math.min(KEEP, st.size)
              const buf = Buffer.alloc(readLen)
              fs.readSync(fd, buf, 0, readLen, st.size - readLen) // 只读末尾 KEEP 字节
              let trimmed = buf.toString('utf8')
              // v3.178：尾部切片可能切在代理对中间（首字符为孤立低代理/尾字符为孤立高代理）→
              // 写回后文件含非法 UTF-8 序列，下次读取显示 U+FFFD（§10-C）——退位到完整字符
              const first = trimmed.charCodeAt(0)
              if (first >= 0xDC00 && first <= 0xDFFF) trimmed = trimmed.slice(1) // 开头孤立低代理（高代理被切掉）
              const last = trimmed.charCodeAt(trimmed.length - 1)
              if (last >= 0xD800 && last <= 0xDBFF) trimmed = trimmed.slice(0, -1) // 结尾孤立高代理（低代理被切掉）
              const nl = trimmed.indexOf('\n')
              // 原子写入（tmp + rename）覆盖原文件，避免中断留下半写日志
              this._writeTextAtomic(logPath, nl >= 0 ? trimmed.slice(nl + 1) : trimmed)
            } finally {
              fs.closeSync(fd)
            }
          }
        } finally {
          if (lockFd >= 0) {
            try { fs.closeSync(lockFd) } catch (e) { /* 锁 fd 关闭失败忽略 */ }
            try { fs.unlinkSync(lockPath) } catch (e) { /* 锁文件已被抢删等，忽略 */ }
          }
        }
      } catch (e) { /* 日志写失败静默（磁盘只读/权限等，不中断推送） */ }
    },

    _writeFilterDiagnostics (records) {
      if (!Array.isArray(records) || records.length === 0) return
      const cfg = Config.diagnostics && Config.diagnostics.filterLog
      if (!this._enabledFlag(cfg)) return
      const lines = []
      for (const record of records) {
        try { lines.push(JSON.stringify(record)) } catch (e) { /* 单条异常不阻断整轮 */ }
      }
      if (lines.length > 0) this._writeRunLog(lines.join('\n') + '\n', 'filter-diagnostics.ndjson')
    },

    _diskWarningAt: 0,
    _alertLastAtByPath: new Map(),
    _reportMemoryStateByPath: new Map(),

    // 磁盘余量只告警不阻断：statfs 不可用或读取失败时静默跳过。
    // 配置启用开关解析（v3.173 口径，供 _sendAlert/_updateReport 共用，v3.258 提取）：
    // !enabled（数字0/空串）或 'false'/'0' 字符串均关闭；'0' 字符串是 truthy 曾漏；
    // C016：trim + 小写，空格/大小写变体也关闭
    _enabledFlag (cfg) {
    // v3.267：纯空白字符串（' '）此前被误判为启用（trim 后为空串但原值 truthy），与 C016 注释矛盾；统一关闭
    // v3.267（评审建议）：移除原始 truthiness 与规范化条件的重叠——Boolean(en) 兜底原始 falsy（0/false/''/NaN），
    // 规范化 s 兜底空白变体与 'false'/'0' 字符串，各关闭条件仅出现一次
      if (!cfg) return false
      const en = cfg.enabled
      const s = en == null ? '' : String(en).trim().toLowerCase()
      return Boolean(en) && s !== '' && s !== 'false' && s !== '0'
    },

    // v3.258 提取：磁盘阈值解析（行为不变，供测试直接打纯函数）
    // Utils.num 口径：字符串配置（'5000'）有效；非有限/<=0 视为未配置（不告警）
    _diskMinFree (cfg) {
      const minFree = Utils.num(cfg && cfg.storage && cfg.storage.minFreeBytes, 50 * 1024 * 1024)
      return Number.isFinite(minFree) && minFree > 0 ? minFree : null
    },

    // v3.258 提取：模板配置校验（占位符支持列表），返回警告消息数组（行为不变）
    _validateTplConfig () {
      const warns = []
      // 模板校验（v3.80）：非字符串回退默认（pushOne 已有回退，配置层补提示）
      if (typeof Config.template.title !== 'string' || typeof Config.template.content !== 'string') {
        warns.push('⚠️ 配置「template.title/content」应为字符串，已回退默认模板')
      }
      // v3.159：模板占位符有效性检查——{价格}/{商城}/{品牌}/{图片} 已由 tuisong_replace 实际支持
      const SUPPORTED_TPL_KEYS = ['分类名', '分类ID', '标题', '链接', '日期', '时间', '楼主', '类目', '内容', '价格', '商城', '品牌', '图片', 'Html内容', 'Markdown内容']
      for (const tplName of ['title', 'content']) {
        const tpl = Config.template[tplName]
        if (typeof tpl !== 'string') continue
        const used = new Set()
        const tplRe = /\{([^{}]+)\}/g
        let tplM
        while ((tplM = tplRe.exec(tpl))) used.add(tplM[1])
        for (const k of used) {
          if (!SUPPORTED_TPL_KEYS.includes(k)) {
            warns.push(`⚠️ 模板「template.${tplName}」含占位符「{${k}}」——接口真实字段不提供该数据，将输出为空。支持占位符：{${SUPPORTED_TPL_KEYS.join('} {')}}`)
          }
        }
      }
      return warns
    },

    _warnLowDisk () {
      const minFree = this._diskMinFree(Config)
      if (minFree === null) return
      const now = Date.now()
      // 同一进程最多每小时提示一次，避免磁盘低时刷屏；限流前置，避免高频写入时每次都无谓同步 statfs 阻塞事件循环。
      if (now - this._diskWarningAt < 3600000) return
      const info = Utils.diskSpace(MessageStore.cacheDir)
      // freeBytes 需有限性校验：NaN 时 >=minFree 为 false 会误入告警并在 toFixed 抛 RangeError。
      if (!info || !Number.isFinite(info.freeBytes) || info.freeBytes >= minFree) return
      this._diskWarningAt = now
      const freeMiB = (info.freeBytes / 1024 / 1024).toFixed(1)
      const minMiB = (minFree / 1024 / 1024).toFixed(1)
      console.warn(`⚠️ 缓存所在磁盘余量不足：${freeMiB} MiB（告警阈值 ${minMiB} MiB），写入状态/缓存可能失败`)
    },

    // 接口异常告警（v3.123）：限频 + 静默——不影响主流程；告警也走推送通道（通道挂了就静默，无解）
    _sendAlert (errMsg) {
      try {
      // v3.258：启用判断提取到 _enabledFlag（口径不变，供测试直接打纯函数）
        if (!this._enabledFlag(Config.alert)) return
        const statePath = path.join(MessageStore.cacheDir, 'alert.state')
        const alertMemory = this._alertLastAtByPath.get(statePath)
        let lastAt = alertMemory ? alertMemory.lastAt : 0
        // 状态文件被外部删除时，已持久化的旧内存状态不应继续生效；写失败的内存状态仍用于本进程限频。
        if (alertMemory && alertMemory.persisted && !fs.existsSync(statePath)) {
          this._alertLastAtByPath.delete(statePath)
          lastAt = 0
        }
        const stateResult = this._readSafeState(statePath)
        if (stateResult.status === 'ok') {
          try { lastAt = Math.max(lastAt, JSON.parse(stateResult.text).lastAt || 0) } catch (e) { /* 损坏状态=忽略 */ }
        } else if (stateResult.status !== 'missing') {
        // ioError/unsafe/tooLarge：无法确认真实限频状态。若按"无状态文件"处理会重置
        // lastAt 导致限频失效、重复推送；保守跳过本次告警，下次运行再重试。
          console.error(`告警限频状态读取失败(${stateResult.status})，跳过本次告警以免限频被重置导致重复推送 ${statePath}`)
          return
        }
        // v3.251：校验 lastAt——NaN/Infinity 或未来时间戳会令限频失效或告警永久静默，视为 0 以恢复正常限频
        lastAt = Number.isFinite(lastAt) && lastAt <= Date.now() ? lastAt : 0
        const intervalMs = Utils.num(Config.alert.intervalMs, 3600000) // v3.167: 非法字符串'abc'曾>0比较false→0不限频轰炸（其他数值配置均num回退）
        const interval = intervalMs > 0 ? intervalMs : 0 // <=0(含-1) = 不限频（每次异常都发）
        if (interval > 0 && Date.now() - lastAt < interval) return // 限频：间隔内不重复轰炸
        const alertText = '⚠️ xbk-push 运行异常'
        const safeReason = Utils.safeErrorText(errMsg, '未知错误')
        // v3.159：段落分隔 \n\n（与主推送/日报口径一致）——wxpusher Markdown 渲染单个 \n 可能挤成一行
        const alertDesp = `接口/推送异常，请检查。\n\n时间：${new Date().toLocaleString('zh-CN')}\n\n原因：${safeReason.slice(0, 500)}`
        // v3.156：发送成功才写状态+打印——曾先写 lastAt（发送失败也限频，60s 内挡住重试，信息丢失）
        // v3.157：走 Pusher.send（曾直接 notify.sendNotify——无 10s 超时、无 surrogate 清洗，与主推送不一致）
        // v3.164：返回 promise 供 App.run catch await——曾 fire-and-forget，接口异常时主入口同步 process.exit(1)
        // 杀死未完成的告警 HTTP（cron 直接运行收不到告警，#10）
        // R1（v3.269）：告警本地留痕——发送前先写一行摘要到 run.log（无论成败），
        // 这样告警通道挂掉/退出连败时仍有痕可查；发送失败时下方 catch 再补一行原因。
        this._writeRunLog(`${this._localStamp()} ALERT [v${require('./package.json').version}] ${alertText.slice(0, 100)} 原因：${safeReason.replace(/[\r\n]+/g, ' ').slice(0, 200)}\n`)
        return Pusher.send(alertText, alertDesp)
          .then(() => {
            const sentAt = Date.now()
            const persisted = this._writeState(statePath, { lastAt: sentAt })
            this._alertLastAtByPath.set(statePath, { lastAt: sentAt, persisted })
            if (!persisted) {
              this._warnLowDisk()
              console.warn('⚠️ 运行异常告警已发送，但 alert.state 持久化失败；本进程将继续使用内存限频')
            } else {
              console.log('已发送运行异常告警（限频 ' + Math.ceil(interval / 60000) + ' 分钟）')
            }
            return true // 发送成功
          })
          .catch((sendError) => {
          // R1（v3.269）：仅在告警通道失败时本地留痕，避免成功告警被误记为失败。
            const reason = Utils.safeErrorText(sendError || errMsg, safeReason).replace(/[\r\n]+/g, ' ').slice(0, 200)
            // J1（v3.269 审查）：留痕写日志自身也可能抛错（磁盘/权限），必须包住——
            // 否则 handler 自身 reject，_sendAlert 不会返回 false，调用方 await 会中断。
            try {
              this._writeRunLog(`${this._localStamp()} ALERT [v${require('./package.json').version}] ${alertText.slice(0, 100)} 原因：${reason}\n`)
            } catch (logError) { /* 留痕失败静默 */ }
            /* v3.135：告警通道也挂了，静默（防 unhandledRejection）；不写状态→下次可重试 */
            return false // 发送失败（供 _warnMissingRe2 等调用方决定是否撤销标记/重试）
          })
      } catch (e) {
      // F1（v3.269 审查）：同步异常（run.log 写失败 / Pusher.send 同步抛错）时
      // 不能只静默——补写失败原因留痕并返回 false，让调用方能区分
      // “发送失败”(false)与“跳过”(undefined：禁用/限频/状态读取失败)。
        const reason = Utils.safeErrorText(e || errMsg, '未知错误').replace(/[\r\n]+/g, ' ').slice(0, 200)
        try {
          this._writeRunLog(`${this._localStamp()} ALERT [v${require('./package.json').version}] ⚠️ xbk-push 运行异常 原因：${reason}\n`)
        } catch (logError) { /* 留痕失败静默 */ }
        return false
      }
    },

    // 当前日期标记原子写入（J2：临时文件 + rename，避免 writeFileSync 半写留下截断 JSON，
    // 导致 _isRe2WarnMarkerStale 无法解析而永久压制当天提醒）。
    // 调用方必须在 per-date 锁内调用：Windows 上 rename 到已存在目标会失败（EEXIST/EPERM），
    // 此时先删目标再 rename——锁内无并发，删除窗口不构成竞态（Sourcery 第十二轮）。
    _writeRe2WarnMarkerAtomic (statePath, text) {
      const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`
      try {
        fs.writeFileSync(tmp, text, { flag: 'wx' })
        try {
          fs.renameSync(tmp, statePath)
        } catch (renameError) {
        // Windows：目标已存在时 rename 失败，先移除目标再重试；
        // 其他平台 rename 天然覆盖，不会进此分支。
          try { fs.unlinkSync(statePath) } catch (unlinkError) { /* 目标已被删/不存在则忽略 */ }
          fs.renameSync(tmp, statePath)
        }
        return true
      } catch (e) {
        try { fs.unlinkSync(tmp) } catch (ignored) { /* 清理失败临时文件 */ }
        return false
      }
    },

    // 发送完成（成功/跳过）后把标记置 completed：加锁 + 校验仍是自己的 token + 原子写。
    // 放在锁内执行，与创建/回收共用同一 per-date 锁，避免锁外写导致并发交错（Sourcery 第十二轮）。
    _completeRe2WarnMarker (statePath, token) {
      const acquired = this._acquireRe2WarnLock(statePath)
      if (!acquired) return
      try {
        try {
          if (tokenMatches(fs.readFileSync(statePath, 'utf8'), token)) {
            const completed = JSON.parse(token)
            completed.status = 'completed'
            this._writeRe2WarnMarkerAtomic(statePath, JSON.stringify(completed))
          }
        } catch (ignore) { /* 读取/解析失败不影响主流程 */ }
      } finally {
        this._releaseRe2WarnLock(statePath, acquired)
      }
    },

    // 发送失败后删除自己的 pending 标记（锁内 + 完整 token 校验，防误删并发进程的标记）。
    _removeRe2WarnMarker (statePath, token) {
      const acquired = this._acquireRe2WarnLock(statePath)
      if (!acquired) return
      try {
        try {
          if (tokenMatches(fs.readFileSync(statePath, 'utf8'), token)) fs.unlinkSync(statePath)
        } catch (ignore) { /* 删除失败不影响主流程 */ }
      } finally {
        this._releaseRe2WarnLock(statePath, acquired)
      }
    },

    async _warnMissingRe2 () {
    // Sourcery 第八轮：RE2C 可用时也要顺带清理残留旧标记文件，否则安装 re2 后堆积文件永不清理。
      if (RE2C) {
        this._cleanupStaleRe2WarnMarkers()
        return
      }
      // 跨进程防重（终版）：按天命名的标记文件 + per-date 互斥锁。
      // 锁串行化「读-判-写」标记，杜绝并发创建/回收竞态（CodeRabbit F2/第七轮）；
      // 标记记录 pid + 进程启动时钟（incarnation）+ 状态（pending/completed）：
      // 已完成的标记永不回收，只有 pending（崩溃未完成）才允许回收（CodeRabbit 第八轮）。
      const stamp = this._localStamp().slice(0, 10) // YYYY-MM-DD
      const statePath = path.join(MessageStore.cacheDir, `${RE2_WARN_STATE_FILE}.${stamp}`)
      const token = JSON.stringify({
        warnedAt: Date.now(),
        pid: process.pid,
        start: MessageStore._getTombstoneProcessStart(process.pid) || '', // Linux 启动时钟；非 Linux 为空
        status: 'pending'
      })
      const acquired = this._acquireRe2WarnLock(statePath)
      if (!acquired) return // 拿不到锁（并发竞争/超时）：跳过本次
      let shouldWarn = false
      try {
      // 锁内重读标记：缺失→创建；残留(pending+已退出)→删除重建；活跃/已完成→跳过
        let exists = false
        try { exists = fs.existsSync(statePath) } catch (e) { exists = false }
        if (!exists) {
          shouldWarn = this._writeRe2WarnMarkerAtomic(statePath, token)
        } else {
          if (this._isRe2WarnMarkerStale(statePath)) {
            try {
              fs.unlinkSync(statePath)
              shouldWarn = this._writeRe2WarnMarkerAtomic(statePath, token)
            } catch (e) { shouldWarn = false }
          } else {
            shouldWarn = false // 活跃标记或已完成：今天已处理过
          }
        }
      } finally {
        this._releaseRe2WarnLock(statePath, acquired)
      }
      if (!shouldWarn) return
      // 锁外：清理 7 天前旧文件 + 提醒 + 发送（发送不在锁内，避免长 HTTP 阻塞其他进程拿锁）
      this._cleanupStaleRe2WarnMarkers()
      console.warn(RE2_MISSING_WARNING)
      this._writeRunLog(`${this._localStamp()} WARN ${RE2_MISSING_WARNING}\n`)
      // 发送结果三态：true 成功 / false 失败删标记重试 /
      // undefined 跳过（禁用/限频）——成功与跳过都视为当天已处理，标记置 completed（CodeRabbit 第八轮：
      // 防止正常进程退出后被误判为残留造成同一天重复提醒）。
      const sent = await this._sendAlert(RE2_MISSING_WARNING)
      if (sent === false) {
      // 发送失败：锁内删除自己的 pending 标记（完整 token 校验），下次运行可重试
        this._removeRe2WarnMarker(statePath, token)
      } else {
      // 成功或跳过：锁内把标记置 completed（防止正常进程退出后被误判残留导致同一天重复提醒）
        this._completeRe2WarnMarker(statePath, token)
      }
    },

    // 单个日期标记的跨进程互斥锁（O_EXCL 独占创建 + 短退避 + 陈旧锁抢占）：
    // 把「读-判-写」标记串行化，使同一时刻只有一个进程能创建/回收当天的标记。
    _acquireRe2WarnLock (statePath) {
      const lockPath = statePath + '.lock'
      const LOCK_STALE_MS = 10000
      const deadline = Date.now() + 3000
      const waiter = new Int32Array(new SharedArrayBuffer(4))
      const lockToken = `${process.pid}:${MessageStore._getTombstoneProcessStart(process.pid) || ''}`
      for (;;) {
        try {
          const fd = fs.openSync(lockPath, 'wx')
          try { fs.writeSync(fd, lockToken) } catch (e) { /* 锁内容仅供排查 */ }
          return { lockPath, fd }
        } catch (e) {
          if (e.code !== 'EEXIST') return null // 权限等异常：无法加锁，放弃本次
          let stale = false
          try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS } catch (e2) { stale = true }
          if (stale && !MessageStore._isTombstoneLockProcessAlive(lockPath)) {
          // 年龄超限且持有进程已确认退出（含损坏/无主锁）才回收；
          // 进程仍存活（如被暂停>10s）绝不回收，避免双进程同时进入临界区（CodeRabbit 第十一轮）。
            try { fs.unlinkSync(lockPath) } catch (e2) { /* 抢占失败则下一轮重试 */ }
            continue
          }
          if (Date.now() >= deadline) return null // 超时：放弃本次（避免阻塞事件循环）
          try { Atomics.wait(waiter, 0, 0, 10) } catch (e2) { /* 受限环境退避失败直接重试 */ }
        }
      }
    },

    _releaseRe2WarnLock (statePath, acquired) {
      if (!acquired) return
      try { fs.closeSync(acquired.fd) } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(acquired.lockPath) } catch (e) { /* 锁已被外部清理时忽略 */ }
    },

    // 清理超过保留期的 re2 标记文件（best-effort；仅删除严格早于 cutoff 的日期）：
    // - re2warn.state.YYYY-MM-DD（正常按天标记）
    // - re2warn.state.YYYY-MM-DD.<pid>.<time>.reclaim（F3：崩溃残留的认领临时文件，
    //   进程在 rename 后、删除前退出会遗留；同样按日期兜底清理，避免永久累积）
    _cleanupStaleRe2WarnMarkers () {
      try {
        const cacheDir = MessageStore.cacheDir
        const prefix = RE2_WARN_STATE_FILE + '.'
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 保留 7 天
        const cutoffStamp = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
        for (const name of fs.readdirSync(cacheDir)) {
          if (!name.startsWith(prefix)) continue
          const markerStamp = name.slice(prefix.length).split('.')[0] // 取日期段，忽略 .pid.time.reclaim 后缀
          try {
            if (/^\d{4}-\d{2}-\d{2}$/.test(markerStamp) && markerStamp < cutoffStamp) {
              fs.unlinkSync(path.join(cacheDir, name))
            }
          } catch (ignore) { /* best effort */ }
        }
      } catch (ignore) { /* best effort */ }
    },

    // re2 提醒标记是否属于可回收的崩溃残留（CodeRabbit 第八轮）：
    // - 仅当标记为 pending（未完成发送）且持有进程已退出时才允许回收；
    //   completed（已成功发送/跳过）即使进程退出也永不回收，避免同一天重复提醒。
    // - PID 不存在 → pending 即残留；PID 存活但启动时钟不一致（PID 复用）→ 残留
    // - 无法解析/PID 无效/状态非 pending → 保守保留
    _isRe2WarnMarkerStale (statePath) {
      let content
      try { content = fs.readFileSync(statePath, 'utf8') } catch (e) { return false }
      let parsed
      try { parsed = JSON.parse(content) } catch (e) { return false }
      if (!parsed || parsed.status !== 'pending') return false // completed/未知：不回收
      const pid = Number.isInteger(parsed.pid) ? parsed.pid : 0
      if (pid <= 0) return false
      let alive
      try {
        process.kill(pid, 0)
        alive = true
      } catch (err) {
        alive = err && err.code === 'EPERM' // EPERM=存在但无权限；ESRCH=不存在
      }
      if (!alive) return true // PID 不存在 = 崩溃残留
      // PID 存活时用启动时钟识别 incarnation：标记里的 start 与当前进程实际 start 不一致 = PID 被复用
      const expectedStart = parsed.start
      if (expectedStart && /^[0-9]+$/.test(expectedStart)) {
        const actualStart = MessageStore._getTombstoneProcessStart(pid)
        if (actualStart !== null && actualStart !== expectedStart) return true
      }
      return false
    },

    // v3.258 提取：日报状态归一化（行为不变，供测试直接打纯函数）
    _blankReportState () {
      return { date: '', runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
    },
    _safeCounter (v) {
      if (typeof v === 'symbol') return 0 // Number(Symbol) 抛 TypeError（子代理审查 commit-12）
      const n = Number(v)
      return typeof v !== 'boolean' && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0
    },
    _isValidReportDate (value) {
      if (value === '') return true
      if (typeof value !== 'string') return false
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      if (!m) return false
      const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3])
      if (year < 1 || month < 1 || month > 12 || day < 1) return false
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      return day <= days[month - 1]
    },
    _normalizeReportState (raw) {
      const blank = () => this._blankReportState()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blank()
      const st = blank()
      st.date = typeof raw.date === 'string' ? raw.date : ''
      for (const k of ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) st[k] = this._safeCounter(raw[k])
      if (raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending)) {
        st.pending = blank()
        for (const k of ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) st.pending[k] = this._safeCounter(raw.pending[k])
      } else if (raw.pending) {
      // pending 存在但非普通对象（状态文件损坏/结构异常）：不能静默丢弃跨天累计，
      // 保留其占位并大声告警，让下游按 blankState 处理而不崩溃。
        console.warn('⚠️ report.state 的 pending 字段格式异常，已重置为空累计（原值被丢弃）')
        st.pending = blank()
      }
      return st
    },

    // 运行日报（v3.125）：跨天时发"昨日日报"，当天累加统计；静默不影响主流程
    _reportToday () {
      const d = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
      return d
    },

    _persistReportState (statePath, state) {
      const normalized = this._normalizeReportState(state)
      const ok = this._writeState(statePath, normalized)
      // 状态写失败时保留进程内已知状态；重启后仍会重试并发出低磁盘告警。
      this._reportMemoryStateByPath.set(statePath, { state: normalized, persisted: ok })
      if (!ok) {
        this._warnLowDisk()
        console.warn('⚠️ 日报发送/累计状态持久化失败；本进程将继续使用内存状态')
      }
      return ok
    },

    _loadReportState (statePath) {
      let memoryState = this._reportMemoryStateByPath.get(statePath)
      if (memoryState && memoryState.persisted && !fs.existsSync(statePath)) {
        this._reportMemoryStateByPath.delete(statePath)
        memoryState = null
      }
      if (memoryState) return this._normalizeReportState(memoryState.state)

      const stateResult = this._readSafeState(statePath)
      if (stateResult.status === 'ok') {
        try {
          const raw = JSON.parse(stateResult.text)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('日报状态顶层必须是对象')
          }
          if (raw.date !== undefined && !this._isValidReportDate(raw.date)) {
            throw new Error('日报状态 date 字段无效')
          }
          for (const k of ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
            if (raw[k] !== undefined && (!Number.isSafeInteger(raw[k]) || raw[k] < 0)) {
              throw new Error(`日报状态字段 ${k} 无效`)
            }
          }
          if (raw.pending !== undefined) {
            if (!raw.pending || typeof raw.pending !== 'object' || Array.isArray(raw.pending)) {
              throw new Error('日报状态 pending 字段无效')
            }
            for (const k of ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) {
              if (raw.pending[k] !== undefined && (!Number.isSafeInteger(raw.pending[k]) || raw.pending[k] < 0)) {
                throw new Error(`日报 pending 字段 ${k} 无效`)
              }
            }
          }
          return this._normalizeReportState(raw)
        } catch (e) {
          console.error(`日报累计状态损坏，跳过本次日报更新以保留原文件 ${statePath}: ${Utils.safeErrorText(e, '解析失败')}`)
          return null
        }
      }
      if (stateResult.status !== 'missing') {
        console.error(`日报累计状态读取失败(${stateResult.status})，跳过本次日报更新以免累计状态被重置 ${statePath}`)
        return null
      }
      return this._blankReportState()
    },

    _accumulateReport (state, summary) {
      const add = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0 }
      state.runs += 1
      state.total += add(summary.total)
      state.dedup += add(summary.dedup)
      state.filtered += add(summary.filtered)
      state.pushed += add(summary.pushed)
      state.failed += add(summary.failed)
      state.truncated += add(summary.truncated)
    },

    async _sendCrossDayReport (statePath, state, summary, today) {
      const reportText = `📊 xbk-push 日报（${state.date}）`
      const pending = state.pending || this._blankReportState()
      const pendingState = { ...state, pending: { ...pending } }
      this._accumulateReport(pendingState.pending, summary)
      const reportBody = `运行 ${state.runs} 轮 | 推送 ${state.pushed} 条 | 失败 ${state.failed} 条\n\n获取 ${state.total} | 去重 ${state.dedup} | 过滤 ${state.filtered}${state.truncated ? ` | 待推送 ${state.truncated}` : ''}${pendingState.pending.runs || pendingState.pending.total || pendingState.pending.dedup || pendingState.pending.filtered || pendingState.pending.pushed || pendingState.pending.failed || pendingState.pending.truncated ? `\n\n今日待结转：运行 ${pendingState.pending.runs} 轮 | 推送 ${pendingState.pending.pushed} 条 | 失败 ${pendingState.pending.failed} 条\n获取 ${pendingState.pending.total} | 去重 ${pendingState.pending.dedup} | 过滤 ${pendingState.pending.filtered}${pendingState.pending.truncated ? ` | 待推送 ${pendingState.pending.truncated}` : ''}` : ''}`
      const pendingSaved = this._persistReportState(statePath, pendingState)
      if (!pendingSaved) console.warn('⚠️ 日报待发送状态未持久化，继续发送但失败时将保留旧状态')
      try {
      // 单次青龙入口会在 App.run 返回后退出，必须等待日报发送完成。
        await Pusher.send(reportText, reportBody)
        const nextState = {
          date: today,
          runs: pendingState.pending.runs || 0,
          total: pendingState.pending.total || 0,
          dedup: pendingState.pending.dedup || 0,
          filtered: pendingState.pending.filtered || 0,
          pushed: pendingState.pending.pushed || 0,
          failed: pendingState.pending.failed || 0,
          truncated: pendingState.pending.truncated || 0
        }
        const nextSaved = this._persistReportState(statePath, nextState)
        if (nextSaved) console.log('已发送昨日运行日报')
        else console.warn('⚠️ 昨日日报已发送，但最终状态未持久化，重启后可能重复发送')
      } catch (e) {
      // 失败保留旧日期和 pending，下一次运行继续重试；记录脱敏后的摘要便于排查。
        console.error('发送昨日运行日报失败:', Utils.safeErrorText(e, '未知错误'))
      }
    },

    // 运行日报更新：跨天日报发送完成后才返回，失败不影响主推送结果。
    async _updateReport (summary) {
      try {
        if (!this._enabledFlag(Config.report)) return
        const statePath = path.join(MessageStore.cacheDir, 'report.state')
        const state = this._loadReportState(statePath)
        if (!state) return
        const today = this._reportToday()
        if (state.date && state.date !== today) {
          const reportKeys = ['runs', 'total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']
          const hasCounters = value => Boolean(value && reportKeys.some(k => value[k] > 0))
          if (hasCounters(state) || hasCounters(state.pending)) {
            await this._sendCrossDayReport(statePath, state, summary, today)
            return
          }
          const pending = state.pending
          const nextState = { date: today, runs: 0, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 }
          if (pending) {
            Object.assign(nextState, {
              runs: pending.runs || 0,
              total: pending.total || 0,
              dedup: pending.dedup || 0,
              filtered: pending.filtered || 0,
              pushed: pending.pushed || 0,
              failed: pending.failed || 0,
              truncated: pending.truncated || 0
            })
          }
          this._accumulateReport(nextState, summary)
          this._persistReportState(statePath, nextState)
          return
        }
        if (!state.date) state.date = today
        this._accumulateReport(state, summary)
        this._persistReportState(statePath, state)
      } catch (e) { /* 日报失败静默，不影响主流程 */ }
    },

    async _updateChannelHealth (outcome) {
      let lockFd = -1
      let lockPath = ''
      try {
        if (!this._enabledFlag(Config.channelHealth)) return
        const statePath = path.join(MessageStore.cacheDir, 'channel-health.state')
        lockPath = statePath + '.lock'
        try {
          lockFd = fs.openSync(lockPath, 'wx')
        } catch (e) {
          let stale = false
          if (e && e.code === 'EEXIST') {
            try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > 10000 } catch (e2) { stale = true }
          }
          if (stale) {
            try { fs.unlinkSync(lockPath); lockFd = fs.openSync(lockPath, 'wx') } catch (e2) { /* 竞争者已接管，按跳过处理 */ }
          }
          if (lockFd < 0) {
          // 单实例仍可能因手工重复启动/重叠 cron 短暂重入；宁可本轮跳过健康观测，也不能覆盖另一轮状态。
            console.warn(`通道健康状态正由另一轮更新，跳过本轮健康更新 ${statePath}`)
            return
          }
        }
        const stateResult = this._readSafeState(statePath)
        if (stateResult.status !== 'ok' && stateResult.status !== 'missing') {
          console.error(`通道健康状态读取失败(${stateResult.status})，跳过本轮健康更新 ${statePath}`)
          return
        }
        let state = {}
        if (stateResult.status === 'ok') {
          try {
            state = JSON.parse(stateResult.text)
            if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('状态顶层必须是对象')
          } catch (e) {
            console.error(`通道健康状态损坏，跳过本轮健康更新以保留原文件 ${statePath}`)
            return
          }
        }
        const succeeded = new Set(Array.isArray(outcome && outcome.successfulChannels) ? outcome.successfulChannels.filter(x => typeof x === 'string' && x) : [])
        const failures = Array.isArray(outcome && outcome.failures) ? outcome.failures : []
        const failed = new Map()
        for (const failure of failures) {
          const channel = failure && typeof failure.channel === 'string' ? failure.channel : ''
          if (channel) failed.set(channel, summarizeError(failure))
        }
        const threshold = Math.max(1, Math.floor(Utils.num(Config.channelHealth.consecutiveFailures, 3)))
        const interval = Math.max(0, Utils.num(Config.channelHealth.intervalMs, 3600000))
        const now = Date.now()
        const alerts = []
        for (const channel of succeeded) {
          const entry = state[channel]
          if (entry && this._safeCounter(entry.consecutiveFailures) >= threshold) {
            alerts.push({ type: 'recovered', channel })
          }
          state[channel] = { consecutiveFailures: 0, lastFailureAt: 0, lastAlertAt: 0, lastRecoveredAt: now }
        }
        for (const [channel, failure] of failed) {
          if (succeeded.has(channel)) continue
          const entry = state[channel] && typeof state[channel] === 'object' ? state[channel] : {}
          const count = this._safeCounter(entry.consecutiveFailures) + 1
          const lastAlertAt = this._safeCounter(entry.lastAlertAt)
          state[channel] = { consecutiveFailures: count, lastFailureAt: now, lastAlertAt }
          if (count >= threshold && (!interval || now - lastAlertAt >= interval)) alerts.push({ type: 'failed', channel, count, failure })
        }
        if (!this._writeState(statePath, state)) return
        for (const alert of alerts) {
          try {
            const text = alert.type === 'recovered' ? '✅ xbk-push 通道恢复' : '⚠️ xbk-push 通道异常'
            const desp = alert.type === 'recovered'
              ? `通道：${alert.channel}\n\n已恢复正常推送。`
              : `通道：${alert.channel}\n\n连续失败：${alert.count} 次\n\n原因：${Utils.safeErrorText(alert.failure && alert.failure.message, '未知错误').slice(0, 300)}`
            await Pusher.send(text, desp)
            if (alert.type === 'failed' && state[alert.channel]) {
              state[alert.channel].lastAlertAt = Date.now()
              this._writeState(statePath, state)
            }
          } catch (e) { /* 健康告警失败不得影响主推送、缓存或下一次重试 */ }
        }
      } catch (e) { /* 健康监测仅作观测，不得影响主流程 */ } finally {
        if (typeof lockFd === 'number' && lockFd >= 0) {
          try { fs.closeSync(lockFd) } catch (e) { /* 忽略 */ }
          try { fs.unlinkSync(lockPath) } catch (e) { /* 忽略 */ }
        }
      }
    },

    async run () {
      const runStart = Date.now()
      const detailedProfile = process.env.XBK_PROFILE === '2' || PROFILE3
      const checkpointProfile = PROFILE3
      const runMarks = []
      let lastRunMarkMs = runStart
      const checkpoint = (name, extra = '') => {
        if (!checkpointProfile) return
        const now = Date.now()
        runMarks.push({ name, atMs: now - runStart, deltaMs: now - lastRunMarkMs, extra })
        lastRunMarkMs = now
      }
      const dumpCheckpoints = () => {
        if (!checkpointProfile) return
        console.log('  [profile checkpoints]')
        for (const mark of runMarks) {
          console.log(`    ${mark.name}: +${mark.atMs}ms (delta ${mark.deltaMs}ms)${mark.extra ? ` ${mark.extra}` : ''}`)
        }
        console.log('  [profile boot]')
        for (const mark of PROFILE3_BOOT_MARKS) {
          const delta = mark.deltaMs === undefined ? '' : ` (delta ${Math.round(mark.deltaMs)}ms)`
          console.log(`    ${mark.name}: +${Math.round(mark.ms)}ms${delta}`)
        }
      }
      let fetchMs = null
      let preprocessMs = null
      let cacheMs = null
      let dnsWarmup = null
      let tlsWarmup = null
      let dnsWarmupSettled = false
      let tlsWarmupSettled = false
      let warmupController = null
      let warmupCancelled = false // v3.233：主流程先于 getNotify() resolve 结束时置位，防止预热在 run 结束后启动
      const dryRun = process.env.XBK_DRY_RUN === '1'
      const preview = (text, desp) => {
        if (!dryRun) return false
        console.log(`🧪 预览：${text}\n${desp}`)
        return true
      }
      console.debug('开始获取线报酷数据...')
      checkpoint('run-start')
      // ③ 拉取数据：仅在实际配置 WxPusher 时预解析域名并后台预建 HTTPS 连接。
      // 预热可被主流程结束时取消，避免“未 await”仍因活动 socket 延长进程退出。
      const warmupPromise = getNotify().then((notifyModule) => {
      // dry-run 只保留主数据抓取；通知通道的 DNS/TLS 预热也会发起外部连接，必须跳过。
        if (dryRun) {
          dnsWarmup = { ok: true, skipped: true }
          tlsWarmup = { ok: true, skipped: true, okCount: 0, count: 0 }
          dnsWarmupSettled = true
          tlsWarmupSettled = true
          checkpoint('warmup-skipped', 'dry-run')
          return null
        }
        const hasWxPusher = Boolean(notifyModule && typeof notifyModule.hasWxPusherConfigured === 'function' &&
                    notifyModule.hasWxPusherConfigured())
        if (!hasWxPusher) {
          dnsWarmup = { ok: true, skipped: true }
          tlsWarmup = { ok: true, skipped: true, okCount: 0, count: 0 }
          dnsWarmupSettled = true
          tlsWarmupSettled = true
          checkpoint('warmup-skipped', 'wxpusher=unconfigured')
          return null
        }
        // v3.233：主流程已结束（finally 置位）但 getNotify() 此刻才 resolve——不再启动预热，
        // 否则 controller 刚创建而 run 已退出，无人取消请求会拖住进程。
        if (warmupCancelled) {
          dnsWarmup = { ok: true, skipped: true }
          tlsWarmup = { ok: true, skipped: true, okCount: 0, count: 0 }
          dnsWarmupSettled = true
          tlsWarmupSettled = true
          checkpoint('warmup-cancelled', 'run-finished-before-load')
          return null
        }
        warmupController = typeof AbortController === 'function' ? new AbortController() : null
        const signal = warmupController ? warmupController.signal : null
        const dnsWarmupPromise = Promise.resolve(prewarmDns('wxpusher.zjiecode.com', signal))
          .then((result) => { dnsWarmup = result; dnsWarmupSettled = true; return result })
          .catch((error) => { dnsWarmup = { ok: false, error: String(error) }; dnsWarmupSettled = true; return dnsWarmup })
        const prewarmCount = (() => {
          const pl = Utils.num(Config.push.parallelLimit, 10)
          const maxPerRun = Utils.num(Config.push.maxPerRun, 100)
          const window = pl > 0 ? Math.min(Math.floor(pl), 10) : 10
          const batch = Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : 100
          return Math.max(1, Math.min(window, batch))
        })()
        // HEAD 预取：连接数与并发窗口对齐；signal 允许主流程结束/失败时取消未完成请求。
        const tlsWarmupPromise = Promise.resolve(prewarmTls('wxpusher.zjiecode.com', 5000, prewarmCount, signal))
          .then((result) => { tlsWarmup = result; tlsWarmupSettled = true; return result })
          .catch((error) => { tlsWarmup = { ok: false, okCount: 0, count: prewarmCount, error: String(error) }; tlsWarmupSettled = true; return tlsWarmup })
        checkpoint('warmup-started', `tlsCount=${prewarmCount}`)
        return Promise.all([dnsWarmupPromise, tlsWarmupPromise])
      }).catch((error) => {
        dnsWarmup = { ok: false, error: String(error) }
        tlsWarmup = { ok: false, okCount: 0, count: 0, error: String(error) }
        dnsWarmupSettled = true
        tlsWarmupSettled = true
        return null
      })
      // 显式接住后台预热 Promise；主流程不等待它。
      warmupPromise.catch(() => {})
      try {
        MessageStore.init()
        checkpoint('cache-init')
        if (!dryRun) await this._warnMissingRe2()
        this._warnLowDisk()
        checkpoint('disk-check')

        // ① 校验配置
        const warnings = RuleEngine.validateConfig({ ...Config.filter, zkt_gjc: Config.keyword.zkt_gjc })
        // CodeRabbit：zkt_gjc 在 Config.keyword 下（validateConfig 只收 filter 配置时该字段恒为 undefined，
        // 首尾空白/非法正则告警在正常执行时永不触发）——显式传入 active 配置使告警生效
        for (const w of warnings) console.warn(w)

        // 配置告警显示统一安全字符串化：脏值（Symbol / 异常 valueOf）不能让告警路径再次崩溃。
        const safeConfigText = (value) => {
          try { return String(value) } catch (e) { return '<不可转换值>' }
        }

        // 校验缓存 maxSize（#7）：函数层已回退默认，配置层补提示（validateConfig 只接收 filter，此处兜底完整 Config）
        // v3.175：字符串 maxSize（'10000' 环境变量）曾误报——用 Utils.num 口径
        if (!Number.isInteger(Utils.num(Config.cache.maxSize, -1)) || Utils.num(Config.cache.maxSize, -1) <= 0) {
          console.warn(`⚠️ 配置「cache.maxSize」为「${safeConfigText(Config.cache.maxSize)}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`)
        }

        // 域名校验（v3.73）：非法 URL 会让 fetchData 重试耗尽才报错，配置层提前提示
        // v3.265：先 trim 再校验——与 baseUrl/pushUrl 的 trimTrailingSlashes(trim()) 使用口径一致，
        // 避免「带首尾空格的合法 domain」被误报非法（CodeAnt PR24 完整审核）
        if (typeof Config.domain !== 'string' || !/^https?:\/\//.test(Config.domain.trim())) {
          console.warn(`⚠️ 配置「domain」为「${safeConfigText(Config.domain)}」不是 http(s):// 开头的合法地址`)
        }

        // 模板校验（v3.80 + v3.159）：v3.258 提取到 _validateTplConfig（口径不变，返回警告数组）
        for (const w of this._validateTplConfig()) console.warn(w)

        // 运行时数值配置校验（函数层已有防御，配置层补提示——#7 同款精神，v3.64）
        // v3.175：校验用 Utils.num 口径——字符串配置（'5000' 环境变量场景）曾误报「不是有效值」
        // （Number.isFinite('5000')=false，但 Utils.num 已生效——假警告误导用户）
        const numConfig = [
          ['api.timeout', Config.api.timeout, (v) => Utils.num(v, -1) > 0],
          ['api.retry', Config.api.retry, (v) => { const n = Utils.num(v, -1); return Number.isInteger(n) && n >= 0 }],
          ['timing.pushInterval', Config.timing.pushInterval, (v) => Utils.num(v, -1) >= 0],
          ['timing.finalWait', Config.timing.finalWait, (v) => Utils.num(v, -1) >= 0],
          ['push.parallelLimit', Config.push.parallelLimit, (v) => Utils.num(v, -1) >= 0],
          ['push.maxPerRun', Config.push.maxPerRun, (v) => { const n = Utils.num(v, -1); return Number.isInteger(n) && n > 0 }]
        ]
        for (const [name, val, ok] of numConfig) {
          if (!ok(val)) {
            let display
            try { display = String(val) } catch (e) { display = '<不可转换值>' }
            console.warn(`⚠️ 配置「${name}」为「${display}」不是有效值，已按内部防御逻辑处理（建议修正）`)
          }
        }
        checkpoint('config-validated')

        // ② 预编译规则（只执行一次）
        const compiledRules = RuleEngine.compileRules(Config.filter)
        checkpoint('rules-compiled')

        const fetchStart = Date.now()
        const xbkdata = await Network.fetchData()
        fetchMs = Date.now() - fetchStart
        checkpoint('api-fetch-complete', `items=${Array.isArray(xbkdata) ? xbkdata.length : 'invalid'} fetchMs=${fetchMs}`)
        checkpoint('dns-warmup-observed', dnsWarmupSettled && dnsWarmup ? `ok=${dnsWarmup.ok} elapsedMs=${dnsWarmup.elapsedMs}` : 'pending')
        if (!Array.isArray(xbkdata)) {
        // 接口返回格式异常时不盲跑 for 循环，抛错让调度感知
          throw new Error(`接口返回数据格式异常：期望数组，实际为 ${xbkdata === null ? 'null' : typeof xbkdata}`)
        }

        // ③b 字段归一化 + ④ 去重/全局过滤（合并为一次遍历，顺序保证：校验→归一化→判重）
        let items = []
        let dedupCount = 0
        let filteredCount = 0
        let truncatedCount = 0 // v3.145：maxPerRun 截断数计入统计（曾凭空消失）
        const cacheName = MessageStore.getFileName(Config.api.pushUrl)
        // v3.159：过滤规则哈希比对——规则变更时失效「过滤写入」缓存（改宽过滤后旧条目重新评估/推送，
        // 无需手动清缓存；「推送成功」缓存不受影响，防重复推送）
        {
          const filterHash = Utils.filterHash(Config.filter, Config.keyword.zkt_gjc)
          const hashPath = path.join(MessageStore.cacheDir, 'filter.hash')
          let lastFile = ''
          let lastHash = ''
          let filterStateReady = true
          const hashResult = this._readSafeState(hashPath)
          if (hashResult.status === 'ok') {
          // v3.262 P2：filter.hash 记录「上次清理的缓存文件名 + 规则哈希」两行。
          // 切 pushUrl 后旧缓存文件的 _f 条目也能被重新评估——此前全局 hash 被别的源
          // 推进后，旧文件 _f 永久失效（改宽规则静默漏推）。兼容旧格式（单行纯 hash）：
          // 文件名段视为与当前不符，触发一次安全重评（宁可多推）。
            const parts = (hashResult.text || '').trim().split('\n')
            lastFile = (parts[0] || '').trim()
            lastHash = (parts[1] || '').trim()
          } else if (hashResult.status !== 'missing') {
          // ioError/unsafe/tooLarge：读不到已存 hash。若当"无 hash"处理会静默跳过规则
          // 变更检测且立即覆写 hash；保守视为未就绪，本次不检测也不推进 hash，下次重试。
            console.error(`过滤规则 hash 读取失败(${hashResult.status})，跳过本次规则变更检测 ${hashPath}`)
            filterStateReady = false
          }
          // 规则哈希变化（正常失效）或「上次清理的文件 ≠ 当前缓存文件」（切源后回到本文件也重评）
          const hashKnown = hashResult.status === 'ok' && lastFile !== '' && lastHash !== ''
          if (!hashKnown || lastHash !== filterHash || lastFile !== cacheName) {
            const fp = MessageStore.getFilePath(cacheName)
            const msgs = MessageStore.readMessages(fp)
            const kept = msgs.filter(m => !(m && typeof m === 'object' && m._f === true))
            if (kept.length !== msgs.length) {
              filterStateReady = MessageStore.saveMessages(fp, kept)
              if (filterStateReady) {
                console.warn(`⚠️ 检测到过滤规则/只看它变更或缓存文件切换（${(lastHash || lastFile || '?').slice(0, 8)} → ${filterHash.slice(0, 8)}），已清除 ${msgs.length - kept.length} 条「过滤写入」缓存——之前被过滤的条目将重新评估（改宽后即重新推送）`)
              } else {
                console.warn('⚠️ 过滤缓存失效写入失败，本次不更新 filter.hash，下次运行将继续重试规则变更处理')
              }
            }
          }
          // 只有过滤缓存清理成功后才推进 hash；否则下次运行必须继续重试，避免旧 _f 永久失效。
          // P2（审查 2026-08-15）：缓存读失败时 readMessages 返回 [] 且置 _readFailed，kept.length===msgs.length
          // （0===0）不会进清理分支，filterStateReady 保持 true 曾导致 hash 照常覆写——缓存修复后规则变更
          // 检测永不再次触发（改宽过滤规则后旧条目永远不再重新评估/推送）。与 hash 读失败同口径：不推进，下轮重试。
          if (filterStateReady && !MessageStore._readFailed[MessageStore.getFilePath(cacheName)]) {
            this._writeTextAtomic(hashPath, `${cacheName}\n${filterHash}`)
          }
        }
        const newMessages = []
        // v3.179：缓存索引化——曾逐条 MessageStore.has()（每条 O(M) findIndex，共 O(N×M)）：
        // 接口异常返回海量数据（maxPerRun 想防的同一场景）时判重卡死——实测 N=2万/M=1万 → 11.6s，
        // 外推 N=10万 → ~60s（cron 长时间挂起）。改为循环前一次性构建缓存三索引（O(M)），
        // 与批内三索引合并判重 → 全程 O(N+M)。三个 Set 与 _findDedupIndex 三条件同构，
        // 等价性由属性测试证明（800 轮含缓存非空场景，0 失配）
        const cacheFilePath = MessageStore.getFilePath(cacheName)
        const cacheMsgs = MessageStore.readMessages(cacheFilePath)
        if (MessageStore._readFailed[cacheFilePath]) {
          console.error('缓存读取失败，跳过本轮推送以防重复轰炸')
          // P1（审查 2026-08-15）：此路径曾直接 return undefined——退出码 0 + 零告警 + 零日志，
          // 缓存持续损坏时 cron 每次「绿色成功」却零推送零告警，静默漏推。与 catch 路径同口径可观测：
          // 写 run.log ERROR + 告警（测试默认关 alert 不污染推送计数）+ 返回带失败语义的摘要，
          // 使 classifySummary 判可重试失败 → runSingleEntry 置非零退出码，调度感知失败。
          this._writeRunLog(`${this._localStamp()} ERROR 缓存读取失败，跳过本轮推送（防重复轰炸）${cacheFilePath}\n`)
          try { await this._sendAlert(`缓存读取失败，本轮推送已跳过（防重复轰炸）：${cacheFilePath}`) } catch (e) { /* 告警失败不阻塞 */ }
          return {
            total: xbkdata.length,
            dedup: 0,
            filtered: 0,
            truncated: 0,
            pushed: 0,
            failed: xbkdata.length,
            failures: []
          }
        }
        const cacheIds = new Set() // 缓存中有 id 条目的 String(id)
        const cacheUrls = new Set() // 缓存中所有有 URL 条目的 validUrl
        const cacheNoIdUrls = new Set() // 缓存中无 id 有 URL 条目的 validUrl
        const cacheAnonKeys = new Set() // 缓存中无 id/URL 条目的 anonKey
        for (const m of cacheMsgs) {
          const identity = Utils.getMessageIdentity(m)
          if (!identity.valid) continue
          if (identity.kind === 'id') cacheIds.add(identity.idKey)
          if (identity.url) {
            cacheUrls.add(identity.url)
            if (identity.kind === 'url') cacheNoIdUrls.add(identity.url)
          }
          if (identity.kind === 'anon') cacheAnonKeys.add(identity.key)
        }
        // P4（CodeAnt）：并入墓碑身份——字节/条数裁剪丢弃的记录身份仍参与判重，防重放重复推送。
        // 统一走 MessageStore._tombstoneSetsHas（与 has/save/saveBatch 同一判重接口，避免语义漂移）
        // v3.228：批内与跨运行统一使用 getMessageIdentity；保留 id/url 的双向 fallback，
        // 另为无标识数据维护 anonKey 集合，避免各入口各自拼接 url:/id: 键。
        const batchIds = new Set()
        const batchUrls = new Set()
        const batchNoIdUrls = new Set()
        const batchAnonKeys = new Set()

        const filterDiagnostics = []
        const filterReasonCounts = {}
        const filterExplanations = new Map()
        const filterLogCfg = Config.diagnostics && Config.diagnostics.filterLog
        const includePassedDiagnostics = this._enabledFlag({ enabled: filterLogCfg && filterLogCfg.includePassed })
        const maxDiagnosticDetails = (() => {
          const value = Utils.num(filterLogCfg && filterLogCfg.maxDetailsPerRun, 100)
          return Number.isInteger(value) && value > 0 ? Math.min(value, 1000) : 100
        })()
        const diagnosticItem = (item, decision, explanation) => ({
          type: 'item',
          at: this._localStamp(),
          decision,
          id: Utils.safeText(Utils.safeGet(item, 'id'), ''),
          title: Utils.truncateUtf16(Utils.safeText(Utils.safeGet(item, 'title'), ''), 200),
          category: Utils.truncateUtf16(Utils.safeText(Utils.safeGet(item, 'catename'), ''), 100),
          reason: explanation.reason,
          protections: explanation.protections,
          skipped: explanation.skipped
        })
        let badElementCount = 0 // v3.157：非对象元素单独统计（曾混入 filteredCount，诊断不清）
        let regTimePresent = 0 // v3.159：louzhuregtime 有值统计（pingbitime 有效性警告用）
        for (const item of xbkdata) {
        // 元素级校验：非对象元素跳过（v3.176：不再计入 filteredCount——「过滤屏蔽」专指规则过滤，
        // 非对象元素有独立「非对象元素」行，曾双计误导诊断）
          if (!Utils.isValidItem(item)) { badElementCount++; continue }
          // 字段归一化：通过安全 getter 读取别名字段，避免脏 getter 破坏整批一致性。
          const categoryName = Utils.safeGet(item, 'catename')
          const categoryAlias = Utils.safeGet(item, 'category_name')
          if (!categoryName && categoryAlias) Utils.safeSet(item, 'catename', categoryAlias)
          const categoryId = Utils.safeGet(item, 'cateid')
          const categoryIdAlias = Utils.safeGet(item, 'category_id')
          if (!categoryId && categoryIdAlias) Utils.safeSet(item, 'cateid', categoryIdAlias)
          const louzhuRegTime = Utils.safeGet(item, 'louzhuregtime')
          if (louzhuRegTime !== undefined && louzhuRegTime !== null && louzhuRegTime !== '') regTimePresent++

          const identity = Utils.getMessageIdentity(item)
          if (!identity.valid) continue
          let dup = false
          if (identity.kind === 'id') {
            dup = cacheIds.has(identity.idKey) || (identity.url && cacheNoIdUrls.has(identity.url)) ||
                       batchIds.has(identity.idKey) || (identity.url && batchNoIdUrls.has(identity.url)) ||
                       MessageStore._tombstoneSetsHas(cacheFilePath, identity)
          } else if (identity.kind === 'url') {
            dup = cacheUrls.has(identity.url) || batchUrls.has(identity.url) ||
                       MessageStore._tombstoneSetsHas(cacheFilePath, identity)
          } else {
            dup = cacheAnonKeys.has(identity.key) || batchAnonKeys.has(identity.key) ||
                       MessageStore._tombstoneSetsHas(cacheFilePath, identity)
          }
          if (dup) { dedupCount++; continue }
          // 收录进批内索引，字段身份与 MessageStore/saveBatch 完全相同。
          if (identity.kind === 'id') batchIds.add(identity.idKey)
          if (identity.url) {
            batchUrls.add(identity.url)
            if (identity.kind === 'url') batchNoIdUrls.add(identity.url)
          }
          if (identity.kind === 'anon') batchAnonKeys.add(identity.key)
          const explanation = FilterEngine.explainFilter(item, compiledRules, Config.filter)
          filterExplanations.set(item, explanation)
          if (explanation.passed) {
            items.push(item)
            if ((explanation.protections.length > 0 || explanation.skipped.length > 0 || includePassedDiagnostics) && filterDiagnostics.length < maxDiagnosticDetails) {
              filterDiagnostics.push(diagnosticItem(item, 'passed', explanation))
            }
          } else {
            filteredCount++
            Utils.safeSet(item, '_f', true) // v3.159：过滤写入标记（规则变更时失效）
            const reasonKey = `${explanation.reason.stage}.${explanation.reason.kind}.${explanation.reason.configKey}`
            filterReasonCounts[reasonKey] = (filterReasonCounts[reasonKey] || 0) + 1
            if (filterDiagnostics.length < maxDiagnosticDetails) filterDiagnostics.push(diagnosticItem(item, 'filtered', explanation))
          }
          newMessages.push(item)
        }

        // v3.159：接口未提供注册时间字段时 pingbitime 过滤不生效——运行期警告（配置无效不感知）
        const pbCfg = Config.filter && Config.filter.pingbitime
        const pbText = Utils.safeText(pbCfg, '')
        if (pbCfg !== undefined && pbCfg !== null && pbText.trim() !== '' && xbkdata.length > 0) {
          const missing = xbkdata.length - regTimePresent
          if (missing / xbkdata.length > 0.5) {
            console.warn(`⚠️ 接口返回「louzhuregtime」注册时间字段缺失 ${missing}/${xbkdata.length} 条（>50%）——配置的「pingbitime」过滤基本不会生效（接口可能不提供该字段）`)
          }
        }

        // ⑤ 只看它过滤（独立白名单函数，keyword 正则预编译一次）
        const beforeKwd = items.length
        const kw = Config.keyword.zkt_gjc
        // R11-1：非字符串 zkt_gjc（对象/数字脏配置）→ 警告并跳过过滤（String 化会把 '[object Object]' 当正则，静默怪行为）
        if (kw !== undefined && kw !== null && typeof kw !== 'string') {
          console.warn(`⚠️ 配置「zkt_gjc」应为字符串，当前为 ${typeof kw}，已忽略只看它过滤`)
        } else if (kw) {
          if (String(kw).trim() === '') {
          // 空白关键词 = 误配置，忽略过滤（避免只推含空格的标题）
            console.warn('⚠️ 配置「zkt_gjc」为空白字符，已忽略只看它过滤')
          } else {
            let kwRe = null
            if (RuleEngine.hasNestedQuantifier(kw)) {
              console.warn('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤')
            } else {
              try {
                kwRe = compileUserRegex(kw, 'i')
              } catch (e) {
              }
              if (!kwRe) console.warn('⚠️ 配置「zkt_gjc」包含无效或当前环境不支持的正则表达式，已忽略只看它过滤')
            }
            if (kwRe) {
            // 只看它过滤：统一走 FilterEngine.whitelistFilter（P2 审查 2026-08-15：消除两套漂移实现——
            // 内联版曾 0/false 标题一律放行、无 4096 长输入截断、无正则缓存；whitelistFilter 均覆盖：
            // 仅 undefined/null/空串视为字段缺失，0/false 参与匹配、完整输入归一化、正则缓存复用）
            // CodeRabbit：单次遍历评估 + 标记被拒项（曾 filter+includes 为 O(n²)），行为等价
              const kept = []
              for (const it of items) {
                if (FilterEngine.whitelistFilter(it, 'title', kw)) {
                  kept.push(it)
                } else {
                  Utils.safeSet(it, '_f', true) // v3.159：只看它滤掉的同样标记（规则变更失效）
                  const whitelistReason = { stage: 'title', kind: 'whitelist', configKey: 'zkt_gjc', rule: kw }
                  const reasonKey = `${whitelistReason.stage}.${whitelistReason.kind}.${whitelistReason.configKey}`
                  filterReasonCounts[reasonKey] = (filterReasonCounts[reasonKey] || 0) + 1
                  if (filterDiagnostics.length < maxDiagnosticDetails) {
                    const explanation = filterExplanations.get(it) || { protections: [], skipped: [] }
                    filterDiagnostics.push(diagnosticItem(it, 'filtered', {
                      reason: whitelistReason,
                      protections: explanation.protections,
                      skipped: explanation.skipped
                    }))
                  }
                }
              }
              items = kept
            }
          // 非法正则时 kwRe 为 null：items 不过滤，继续正常推送（避免静默清空）
          }
        }
        filteredCount += (beforeKwd - items.length)
        this._writeFilterDiagnostics([
          {
            type: 'run',
            at: this._localStamp(),
            total: xbkdata.length,
            dedup: dedupCount,
            filtered: filteredCount,
            passed: items.length,
            // 不能从受 maxDetailsPerRun 截断的明细反算，否则汇总会少计。
            byReason: filterReasonCounts,
            detailCount: filterDiagnostics.length
          },
          ...filterDiagnostics
        ])
        checkpoint('data-processed', `items=${items.length} dedup=${dedupCount} filtered=${filteredCount} bad=${badElementCount}`)

        // v3.129：单次推送上限（防接口异常返回海量 → 推送风暴/8 分钟运行；正常 ~20 条无影响）
        // maxPerRun 必须是正整数；小数先取整可能变成 0（如 0.5），会静默跳过全部推送，非法值统一回退默认
        const maxPerRun = (() => { const v = Utils.num(Config.push.maxPerRun, -1); return Number.isInteger(v) && v > 0 ? v : 100 })()
        let truncatedKeys = new Set()
        if (items.length > maxPerRun) {
          truncatedCount = items.length - maxPerRun
          console.warn(`⚠️ 单次待推送 ${items.length} 条超过上限 ${maxPerRun}，只推前 ${maxPerRun} 条（防接口异常推送风暴；调整 Config.push.maxPerRun）`)
          // v3.239：截断告警推送（复用 alert 限频，防轰炸）——静默丢失曾无感知，手机端可及时发现
          // v3.240：await 告警（v3.164 曾修复 fire-and-forget 导致告警 HTTP 未送达被杀，子代理审查发现本轮修复回归该模式）
          // v3.241：文案改为「已暂存待补推」（下轮接口重放时补推，非永久丢弃；子代理审查提示避免误导）
          // P3（审查 2026-08-15）：再修正——截断条目并未暂存（不入缓存、无任何持久化），仅依赖接口下轮重放，
          // 「已暂存」仍会误导用户以为已持久化；改为如实描述「待下轮接口重放时补推」
          if (!dryRun) {
            try { await this._sendAlert(`⚠️ 线报酷截断：单次待推送 ${items.length} 条超上限 ${maxPerRun}，截断 ${truncatedCount} 条待下轮接口重放时补推（防推送风暴）`) } catch (e) { /* 告警失败不阻塞主流程 */ }
          }
          // v3.134：截断掉的不写缓存——否则下次运行去重跳过导致静默丢失（缓存当"已处理"）；下次运行推剩余
          // keyOf 在 ⑥ 才定义，此处用同口径（id 优先 + url 归一）构造截断 key
          truncatedKeys = new Set(items.slice(maxPerRun).map(it => Utils.getMessageIdentity(it).key))
          items = items.slice(0, maxPerRun)
        }

        // ⑥ 推送（sequential=顺序逐条 / parallel=并行滑动窗口；失败不中断、不写缓存，下次重试）
        const pushModeForProfile = (() => {
        // v3.250：Config.push 缺失/未配置 mode 时 String(undefined) 会产出字面量 "undefined"；
        // 显式回退默认顺序模式，仅用于 push-start 日志（不改变实际推送语义）
          try { const m = Config.push && Config.push.mode; return (m == null || m === '') ? 'sequential' : String(m) } catch (e) { return '<不可转换值>' }
        })()
        checkpoint('push-start', `count=${items.length} mode=${pushModeForProfile}`)
        const startTime = Date.now()
        preprocessMs = startTime - runStart - (fetchMs || 0)
        // v3.250：预计算每条 items 的 identity key 并缓存（含 newMessages 惰性缓存），
        // keyOf 复用，避免 getMessageIdentity 对同一对象反复重算（pushedKeys/itemsKeys/toCache 均调用）
        const itemKeyCache = new Map(items.map(it => [it, Utils.getMessageIdentity(it).key]))
        const keyOf = (it) => {
          if (!itemKeyCache.has(it)) itemKeyCache.set(it, Utils.getMessageIdentity(it).key)
          return itemKeyCache.get(it)
        }
        // domain 去尾斜杠后与相对路径统一拼接（避免 'https://x.com//rel' 双斜杠）
        // R2：非字符串 domain（脏配置）→ 空串 baseUrl（相对路径不拼前缀，避免 .replace 崩溃）
        const baseUrl = (typeof Config.domain === 'string') ? trimTrailingSlashes(Config.domain.trim()) : '' // v3.158: trim
        // url 类型防御：非字符串(null/undefined/对象/数字)视为无链接——避免 .includes 崩溃或 [object Object]
        // 与 htmlToMarkdown 的 content_html 口径一致（非字符串视为空）
        const urlOf = (it) => {
          const u = Utils.safeUrl(it && it.url)
          if (!u) return ''
          // 含协议或协议相对(//)不拼前缀；相对路径拼 domain（补斜杠）
          return (u.includes('://') || u.startsWith('//') ? u : baseUrl + (u.startsWith('/') ? u : '/' + u))
        }
        const pushedKeys = new Set()
        const failureInfos = []
        const readItemField = (item, field) => {
          try { return item && item[field] } catch (e) { return undefined }
        }
        // v3.250：日志边界——超长字段值（脏数据/整段内容/大对象 JSON）原样入日志会撑爆日志行；
        // 与推送内容截断同口径，仅限制日志显示长度，不影响实际推送内容
        const ITEM_LOG_MAX = 100
        const itemLogText = (item, field, fallback = '') => {
          const text = Utils.safeText(readItemField(item, field), fallback)
          return typeof text === 'string' && text.length > ITEM_LOG_MAX ? Utils.truncateUtf16(text, ITEM_LOG_MAX) : text
        }

        // 推送模板（v3.68 可配置）：非法/缺失回退默认（默认值与历史硬编码完全一致，现有测试锁定）
        const titleTpl = (typeof Config.template.title === 'string' && Config.template.title) ? Config.template.title : '【{分类名}】{标题}'
        const contentTpl = (typeof Config.template.content === 'string' && Config.template.content) ? Config.template.content : '{Markdown内容}'
        // 推送截断长度（v3.69 可配置）：非正数/非数字回退默认（负数会让 slice(0,-1) 误截尾字符）
        const titleMax = (() => { const v = Math.floor(Utils.num(Config.push.titleMax, 100)); return v > 0 ? v : 100 })()
        const contentMax = (() => { const v = Math.floor(Utils.num(Config.push.contentMax, 3000)); return v > 0 ? v : 3000 })()

        // 单条推送（两种模式共用）：成功返回 {ok:true} 并记录；失败警告且不写缓存(下次重试)
        const pushOne = async (item, notifyModule) => {
        // 推送内容截断：避免超长标题/内容被推送 API 拒绝（长度可配置，默认 100/3000）
        // 用 UTF-16 安全截断（不切断 emoji 代理对）
        // R9：title/content 非字符串（对象等脏数据）→ 空标题占位/空内容（避免 '[object Object]' 泄漏）
          const pushItem = {
            ...Utils.safeObjectCopy(item),
            url: urlOf(item),
            // v3.110：孤立代理清洗（encodeURIComponent 对孤立代理抛 URIError → 推送失败）
            // R9/审查9-C 语义保留：非字符串或空串 title → (无标题) 占位；content 空串置空
            title: (() => {
              const value = readItemField(item, 'title')
              return Utils.truncateUtf16(Utils.sanitizeSurrogates(typeof value === 'string' && value !== '' ? value : '(无标题)'), titleMax)
            })(),
            content: (() => {
              const value = readItemField(item, 'content')
              return Utils.truncateUtf16(Utils.sanitizeSurrogates(typeof value === 'string' ? value : ''), contentMax)
            })()
          }
          // 标题兜底截断（v3.70）：text 由「分类名+标题」拼接，分类名超长时整体可超 titleMax——
          // 与 desp 同口径，titleMax 语义统一为「推送标题最终长度上限」
          const text = Utils.truncateUtf16(Formatter.tuisong_replace(titleTpl, pushItem), titleMax)
          // desp 兜底截断：contentMax 统一作用于推送内容最终长度（v3.69 修复——原只截断 {内容} 字段，
          // {Markdown内容} 走 content_html 转换从不截断，超长 HTML 会撑爆推送 API）
          // v3.110：desp 也清洗孤立代理（content_html 可能含脏代理）
          const rawDesp = Formatter.tuisong_replace(contentTpl, pushItem)
          let desp = Utils.truncateUtf16(Utils.sanitizeSurrogates(rawDesp), contentMax)
          // v3.152：长内容截断曾把尾部"原文链接"截掉（用户看不到链接）——检测并保留
          const rawClean = Utils.sanitizeSurrogates(rawDesp)
          const safePushUrl = Utils.safeUrl(pushItem.url)
          if (rawClean.includes('原文链接') && !desp.includes('原文链接') && safePushUrl) {
            const link = `原文链接：[${safePushUrl}](<${safePushUrl}>)`
            // 链接本身超过 contentMax 时不保留（尊重截断配置）；否则内容截短补链接（仍 ≤ contentMax）
            // v3.177：边界修正——link 接近 contentMax 时 contentMax-link-2 曾 ≤0，truncateUtf16 对非正
            // max 返回原串 → desp 全量+链接显著超限（系统验证反证 #3）；改为「链接+分隔符完整容纳
            // 才补」+ keep≥1 保证总长 ≤ contentMax（link+2 == contentMax 时 keep=0 会触发上述缺陷）
            if (link.length + 2 < contentMax) {
              const keep = contentMax - link.length - 2
              desp = Utils.truncateUtf16(desp, keep) + '\n\n' + link
            }
          }
          if (preview(text, desp)) return { item, ok: false, preview: true }
          try {
            const sent = await Pusher.send(text, desp, notifyModule)
            pushedKeys.add(keyOf(item))
            // v3.159：推送成功 → 清除过滤写入标记（否则 _f 随对象写回缓存，下次规则变更又误清）
            // 标记属性异常不能把已送达消息改判为失败；即使无法删除，后续缓存仍按成功处理。
            try { delete item._f } catch (e) { /* 非可配置脏属性不影响已成功推送 */ }
            return { item, ok: true, sent }
          } catch (e) {
          // 非 Error 兜底（R1）：notify 抛字符串等非 Error 时避免 e.message undefined（与 v3.31/73/81 口径一致）
            const failure = summarizeError(e)
            failureInfos.push(failure)
            console.log(`⚠️ 推送失败（不写入缓存，下次运行重试）: ${itemLogText(item, 'title', '(无标题)')}【${itemLogText(item, 'catename')}】 ${failure.message || Utils.safeText(e)}`)
            return { item, ok: false, failure }
          }
        }

        // v3.223：推送模块（含 got）已与接口并行加载，首推前确保完成（接口快时最多等剩余加载时间）
        const notifyModule = await getNotify()
        checkpoint('notify-module-loaded')

        let successCount = 0
        const pushResults = []
        // push.mode 非法值提示（防静默降级：用户配 'PARALLEL' 等会按顺序执行）
        if (Config.push && Config.push.mode && Config.push.mode !== 'sequential' && Config.push.mode !== 'parallel') {
          console.warn(`⚠️ 配置「push.mode」值无效：「${safeConfigText(Config.push.mode)}」（应为 sequential/parallel），已按顺序模式执行`)
        }
        if (Config.push && Config.push.mode === 'parallel') {
        // 并行推送：滑动窗口限并发；任意一条完成后立即补下一条。
        // parallelLimit 防御：小数取整（0.5 取 0 后回退 1）、0/负数回退全量、空 items 兜底 1。
          const MAX_PARALLEL_WORKERS = 50 // 并行推送硬性上限：防超大 parallelLimit/大批量瞬时拉起海量 worker
          const limit = (() => {
            const pl = Utils.num(Config.push.parallelLimit, 0)
            // 有效正数取整；0/负数/非法回退全量 items；二者均受硬性上限约束，空 items 兜底 1
            const base = pl > 0 ? Math.floor(pl) : items.length
            return Math.min(base, MAX_PARALLEL_WORKERS)
          })() || 1
          const pushInterval = Utils.num(Config.timing.pushInterval, 0)
          const results = new Array(items.length)
          let nextIndex = 0
          const worker = async () => {
            while (true) {
              const index = nextIndex++
              if (index >= items.length) return
              results[index] = await pushOne(items[index], notifyModule)
              // 保留可配置的补位间隔（per-worker 语义：每个 worker 完成一条后等 pushInterval 再补下一条，
              // 并行全局速率 = parallelLimit × interval；已知取舍，量小+重试兜底不改），pushInterval=0 即完成即补。
              if (pushInterval > 0 && nextIndex < items.length) {
                await new Promise(resolve => setTimeout(resolve, pushInterval))
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
          pushResults.push(...results)
          // 按原顺序输出成功日志（并发完成顺序不定，日志保持数据顺序）
          for (const r of results) {
            if (r && r.ok) console.log(`发现到新数据：${itemLogText(r.item, 'title', '(无标题)')}【${itemLogText(r.item, 'catename')}】${urlOf(r.item)}`)
          }
          successCount = results.filter(r => r && r.ok && !r.preview).length
        } else {
        // 顺序推送（默认）：逐条 await；仅在显式配置正间隔时等待。
          const pushInterval = Utils.num(Config.timing.pushInterval, 0)
          for (const item of items) {
            const r = await pushOne(item, notifyModule)
            pushResults.push(r)
            if (r.ok) { successCount++; console.log(`发现到新数据：${itemLogText(item, 'title', '(无标题)')}【${itemLogText(item, 'catename')}】${urlOf(item)}`) }
            if (pushInterval > 0) await new Promise(resolve => setTimeout(resolve, pushInterval))
          }
        }
        checkpoint('push-complete', `success=${successCount} failed=${items.length - successCount}`)
        if (PROFILE3 && notifyModule && typeof notifyModule.printWxPusherProfileSummary === 'function') {
          notifyModule.printWxPusherProfileSummary()
        }

        // ⑦ 写缓存：只收录「被过滤的数据」+「推送成功的数据」
        //    推送失败的排除在外 → 下次运行重新推送（避免消息永久丢失）
        const channelSuccessful = new Set()
        const channelFailures = []
        const recordChannelOutcome = (result) => {
          if (!result) return
          const sent = result.sent
          if (sent && Array.isArray(sent.successfulChannels)) {
            for (const channel of sent.successfulChannels) channelSuccessful.add(channel)
          }
          if (sent && Array.isArray(sent.failures)) channelFailures.push(...sent.failures)
          if (result.failure) {
            if (Array.isArray(result.failure.successfulChannels)) {
              for (const channel of result.failure.successfulChannels) channelSuccessful.add(channel)
            }
            if (Array.isArray(result.failure.failures)) channelFailures.push(...result.failure.failures)
          }
        }
        for (const result of pushResults) recordChannelOutcome(result)
        // 健康观测在成功缓存持久化后执行；其自身失败被完全隔离：绝不改变推送成功语义。
        const itemsKeys = new Set(items.map(keyOf))
        // v3.134：排除截断未推的（下次运行推剩余，防静默丢失）
        const toCache = dryRun
          ? []
          : newMessages.filter(m => !truncatedKeys.has(keyOf(m)) && (!itemsKeys.has(keyOf(m)) || pushedKeys.has(keyOf(m))))
        const cacheStart = Date.now()
        MessageStore.saveBatch(toCache, cacheName)
        cacheMs = Date.now() - cacheStart
        checkpoint('cache-write-complete', `cached=${toCache.length} cacheMs=${cacheMs}`)
        await this._updateChannelHealth({ successfulChannels: [...channelSuccessful], failures: channelFailures })

        // 预取收尾：只观察已完成结果，不等待后台预取，避免它拖慢主流程退出。
        checkpoint('tls-warmup-observed', tlsWarmupSettled && tlsWarmup
          ? `ok=${tlsWarmup.ok} okCount=${tlsWarmup.okCount || 0}/${tlsWarmup.count || 0} elapsedMs=${tlsWarmup.elapsedMs}`
          : 'pending')

        // ⑧ 统计
        const pushMs = Date.now() - startTime
        const elapsed = (pushMs / 1000).toFixed(1)
        console.log('\n══════════ 本次运行 ══════════')
        console.log(`  获取:     ${xbkdata.length} 条`)
        console.log(`  去重跳过:  ${dedupCount} 条`)
        console.log(`  过滤屏蔽:  ${filteredCount} 条`)
        if (truncatedCount > 0) console.log(`  截断待推:  ${truncatedCount} 条（下次运行推送，防推送风暴）`)
        if (badElementCount > 0) console.log(`  非对象元素: ${badElementCount} 条（接口脏数据，已跳过）`)
        console.log(`  推送:     ${successCount} 条${successCount < items.length ? `（${items.length - successCount} 条失败，下次运行重试）` : ''}`)
        console.log(`  耗时:     ${elapsed}s`)
        if (process.env.XBK_PROFILE === '1' || detailedProfile) {
          const totalMs = Date.now() - runStart
          console.log(`  [profile] 接口: ${fetchMs === null ? 'n/a' : (fetchMs / 1000).toFixed(3) + 's'} | 推送: ${(pushMs / 1000).toFixed(3) + 's'} | 总计: ${(totalMs / 1000).toFixed(3) + 's'}`)
          if (detailedProfile) {
            const warmupText = dnsWarmup ? `${dnsWarmup.ok ? '成功' : '失败'} ${(dnsWarmup.elapsedMs / 1000).toFixed(3)}s${dnsWarmup.family ? ` IPv${dnsWarmup.family}` : ''}` : 'n/a'
            const tlsText = tlsWarmup ? `${tlsWarmup.okCount}/${tlsWarmup.count} 成功 ${(tlsWarmup.elapsedMs / 1000).toFixed(3)}s` : 'n/a'
            console.log(`  [profile detail] DNS预热: ${warmupText} | TLS预取: ${tlsText} | 预处理: ${(Math.max(0, preprocessMs || 0) / 1000).toFixed(3)}s | 缓存写入: ${(cacheMs || 0) / 1000}s | 收尾等待: ${(Utils.num(Config.timing.finalWait, 0) / 1000).toFixed(3)}s`)
          }
        }
        dumpCheckpoints()
        console.log('══════════════════════════════')
        await new Promise(resolve => setTimeout(resolve, Utils.num(Config.timing.finalWait, 0)))

        // v3.163：#9 推送全部失败无告警（v3.123 声称覆盖密钥失效但只实现接口挂）——
        // 补告警推送（限频复用 alert.state，防轰炸）+ run.log ERROR 行（cron 翻日志可见）
        // v3.170：await 告警完成（与 catch 路径 v3.164 同口径）——曾 fire-and-forget，
        // run() 返回后进程退出时序不确定（虽然内部 .catch 兜底不丢，但行为不一致）
        if (!dryRun && items.length > 0 && successCount === 0) {
          try { await this._sendAlert(`推送全部失败（${items.length} 条）：推送通道可能失效（key/限流/API）`) } catch (e) { /* 告警失败不阻塞主流程 */ }
          this._writeRunLog(`${this._localStamp()} ERROR 推送全部失败 ${items.length} 条（通道可能失效）\n`)
        }
        // 运行摘要持久化到缓存目录 run.log（cron 场景回溯/失败趋势；写失败不影响主流程）
        this._writeRunLog(`${this._localStamp()} total=${xbkdata.length} dedup=${dedupCount} filtered=${filteredCount} truncated=${truncatedCount} pushed=${successCount} failed=${items.length - successCount} elapsed=${elapsed}s\n`)

        // v3.125：运行日报（跨天发昨日汇总 + 当天累加；静默）
        const summary = {
          total: xbkdata.length,
          dedup: dedupCount,
          filtered: filteredCount,
          truncated: truncatedCount, // v3.145：截断数（下次推送）
          pushed: successCount,
          failed: dryRun ? 0 : items.length - successCount,
          failures: failureInfos
        }
        if (!dryRun) await this._updateReport(summary)

        // 返回运行摘要（供外部/测试观测，cron 可据此判断）
        return summary
      } catch (error) {
      // 非 Error 抛出（如字符串）时兜底，避免 error.message undefined
        const errMsg = Utils.safeErrorText(error, Utils.safeText(error, '未知错误'))
        if (error && error.response) {
          console.log('请求失败，状态码:', error.response.statusCode)
        } else if (error && error.code === 'ETIMEDOUT') {
          console.log('请求超时:', errMsg)
        } else {
          console.log('请求错误:', errMsg)
        }
        dumpCheckpoints()
        // 失败也写运行日志（cron 可回溯失败原因；错误信息去换行避免破坏日志行）
        this._writeRunLog(`${this._localStamp()} ERROR ${String(errMsg).replace(/[\r\n]+/g, ' ')}\n`)
        // v3.123：接口异常告警（限频 + 静默，不影响主流程）
        // v3.164：await 告警完成——主入口 process.exit(1) 前需确保告警 HTTP 送达（#10）
        // dry-run 不允许任何通知副作用；失败仍重抛给调用方/调度器。
        if (!dryRun) {
          try { await this._sendAlert(errMsg) } catch (e) { /* 告警失败不阻塞重抛 */ }
        }
        throw error // 重新抛出，让外层/调度感知失败（cron 场景 exit code 非 0）
      } finally {
      // 后台 DNS/TLS 预热不是业务结果，运行结束或失败时取消未完成请求，避免拖住进程退出。
      // v3.233：flag 兜底 getNotify() 未 resolve 的竞态——controller 尚未创建时主流程已结束，
      // then 回调稍后凭 flag 跳过启动，防止预热请求拖住退出。
        warmupCancelled = true
        if (warmupController) warmupController.abort()
      }
    }
  }
  return App
}

module.exports = { createApp }
