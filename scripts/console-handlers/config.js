'use strict'
// 控制台 config 域 HTTP handler（D1 路由拆分）：配置视图、过滤规则读面、控制台设置、自动运行开关。
// 依赖一律经路由表的 ctx 显式注入；不 require scripts/console.js（避免循环依赖）。
function createConfigHandlers (ctx) {
  const { sendJson, sendJsonConditional, readJsonObjectBody, logCaught } = ctx.http
  const { token, runtimeSettings, auto, isShuttingDown, settingsSource, setSettingsSource, hasAutoInFlight } = ctx.state
  const { settingsPath } = ctx.paths
  const { writeAtomic, buildConfigView, findSecretLikeField, buildPushChannelsView } = ctx.data
  const { handleFilterGet, handleFilterDraftGet, writeAuthVerdict } = ctx.actions
  const { filterMediaAllowed } = ctx.twofa
  const { persistAuto, scheduleAuto, autoNextDelay, stopAuto, autoSnapshot, normalizeAutoSchedule } = ctx.auto
  const {
    CONSOLE_SETTINGS_DEFAULT_S, NOTIFY_REPLAY_MIN_S, NOTIFY_REPLAY_MAX_S,
    AUTO_MIN_S, AUTO_MAX_S, AUTO_MAX_FAILS, AUTO_SCHEDULE_MAX, AUTO_SCHEDULE_MAX_S
  } = ctx.consts
  return {
    getConfig (req, res, url) {
      // 脱敏在 buildConfigView 内逐字段白名单完成；这里只做最终保险丝：万一未来白名单
      // 意外混入凭证形态字段，响应前整体拦一道（fail-closed 降级为不含 runtime 的骨架）。
      // D2-S13：旧实现拿「大写环境变量名」去匹配小写化后的 JSON，两个形态永不相交，这段
      // 防线不可达；且降级响应的键名写成 localFileLoaded（前端读 localFilePresent），
      // 前端把「保险丝触发」误显示成「模块缺失」。现在按键名语义递归扫描 + 统一键名。
      const view = buildConfigView()
      const leaked = findSecretLikeField(view)
      if (leaked) {
        sendJson(res, 200, {
          configLoaded: false,
          runtime: null,
          pushChannels: { moduleLoaded: false, count: 0, names: [], perChannel: {}, localFilePresent: buildPushChannelsView().localFilePresent },
          console: { env: {} },
          redacted: true,
          redactedField: leaked
        })
        return
      }
      sendJsonConditional(req, res, view)
    },
    // GET /api/config/filter：过滤规则读面（全局鉴权已通过，Cookie/Bearer 均可）。
    getFilter (req, res, url) {
      handleFilterGet(req, res)
    },
    getFilterDraft (req, res, url) {
      handleFilterDraftGet(req, res)
    },
    // ── v3.340 控制台设置：通知自检的重复提交拦截窗（配置页可读写）──────────────
    // GET 走全局鉴权（Cookie/Bearer 均可读）；POST 只认 Bearer + JSON（写面防 CSRF）。
    // 落盘 <stateDir>/console-settings.json（0600 原子写），内存即时更新 ⇒ 下一次触发判定就生效。
    getConsoleSettings (req, res, url) {
      // 可变设置不许被任何中间层/浏览器启发式缓存：保存后刷新必须拿到刚写入的值。
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, {
        schema: 1,
        revision: runtimeSettings.revision,
        updatedAt: runtimeSettings.updatedAt,
        source: settingsSource(),
        settings: { notifyTestReplayWindowS: runtimeSettings.notifyTestReplayWindowS, syncShowDate: runtimeSettings.syncShowDate },
        defaults: { notifyTestReplayWindowS: CONSOLE_SETTINGS_DEFAULT_S, syncShowDate: true },
        min: NOTIFY_REPLAY_MIN_S,
        max: NOTIFY_REPLAY_MAX_S
      })
    },
    postConsoleSettings (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      if (!filterMediaAllowed(req)) {
        sendJson(res, 415, { error: 'unsupported_media_type', code: 'unsupported_media_type' })
        return
      }
      readJsonObjectBody(req)
        .then((read) => {
          if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
          if (!read.ok) { sendJson(res, read.status, read.body); return }
          const payload = read.payload
          // v3.342：两字段都是可选的「部分更新」，但至少要给一个；给了就必须严格合法——
          // 字符串 '60' / 1.5 / null / 越界 / 非布尔的显示开关全部拒绝，含糊接受会让
          // 「保存成功但生效值不是用户以为的那个」变成静默事故。
          const hasWin = Object.prototype.hasOwnProperty.call(payload, 'notifyTestReplayWindowS')
          const hasDate = Object.prototype.hasOwnProperty.call(payload, 'syncShowDate')
          if (!hasWin && !hasDate) {
            sendJson(res, 400, { error: '至少要提供 notifyTestReplayWindowS 或 syncShowDate 之一' })
            return
          }
          if (hasWin && (typeof payload.notifyTestReplayWindowS !== 'number' ||
            !Number.isInteger(payload.notifyTestReplayWindowS) ||
            payload.notifyTestReplayWindowS < NOTIFY_REPLAY_MIN_S ||
            payload.notifyTestReplayWindowS > NOTIFY_REPLAY_MAX_S)) {
            sendJson(res, 400, { error: `notifyTestReplayWindowS 必须是 ${NOTIFY_REPLAY_MIN_S}–${NOTIFY_REPLAY_MAX_S} 的整数` })
            return
          }
          if (hasDate && typeof payload.syncShowDate !== 'boolean') {
            sendJson(res, 400, { error: 'syncShowDate 必须是布尔值' })
            return
          }
          // 可选乐观锁：带了就必须是当前 revision，防两个标签页/两个人在设置页互相覆盖。
          if (Object.prototype.hasOwnProperty.call(payload, 'baseRevision') &&
            (typeof payload.baseRevision !== 'number' || !Number.isSafeInteger(payload.baseRevision) ||
              payload.baseRevision < 0 || payload.baseRevision !== runtimeSettings.revision)) {
            sendJson(res, 409, { error: 'revision_mismatch', revision: runtimeSettings.revision })
            return
          }
          const nextWin = hasWin ? payload.notifyTestReplayWindowS : runtimeSettings.notifyTestReplayWindowS
          const nextDate = hasDate ? payload.syncShowDate : runtimeSettings.syncShowDate
          // 同值保存不推进 revision、不重写文件：否则每点一次「保存」都会把别的标签页/手机上的
          // baseRevision 作废，它们下一次保存只能吃 409（页面还会显示「已被别处改过」）。
          if (nextWin === runtimeSettings.notifyTestReplayWindowS && nextDate === runtimeSettings.syncShowDate) {
            sendJson(res, 200, {
              ok: true,
              unchanged: true,
              revision: runtimeSettings.revision,
              updatedAt: runtimeSettings.updatedAt,
              settings: { notifyTestReplayWindowS: runtimeSettings.notifyTestReplayWindowS, syncShowDate: runtimeSettings.syncShowDate }
            })
            return
          }
          // 落盘成功才改内存：写失败（磁盘/权限）时内存保持旧值，页面不会显示一个
          // 重启后就消失的「已保存」。
          const next = {
            schema: 1,
            revision: runtimeSettings.revision + 1,
            updatedAt: Date.now(),
            notifyTestReplayWindowS: nextWin,
            syncShowDate: nextDate
          }
          if (!writeAtomic(settingsPath, JSON.stringify(next), '控制台设置')) {
            sendJson(res, 500, { error: '设置保存失败（磁盘/权限）' })
            return
          }
          runtimeSettings.revision = next.revision
          runtimeSettings.updatedAt = next.updatedAt
          runtimeSettings.notifyTestReplayWindowS = next.notifyTestReplayWindowS
          runtimeSettings.syncShowDate = next.syncShowDate
          setSettingsSource('file')
          sendJson(res, 200, {
            ok: true,
            revision: next.revision,
            updatedAt: next.updatedAt,
            settings: { notifyTestReplayWindowS: next.notifyTestReplayWindowS, syncShowDate: next.syncShowDate }
          })
        })
        .catch((e) => { logCaught('console/settings', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    },
    // 服务器端自动正式运行：状态/开关/间隔。GET 走全局鉴权；POST 只认 Bearer（写面防 CSRF）。
    getAuto (req, res, url) {
      sendJsonConditional(req, res, {
        auto: autoSnapshot(),
        min: AUTO_MIN_S,
        max: AUTO_MAX_S,
        maxFails: AUTO_MAX_FAILS,
        scheduleMax: AUTO_SCHEDULE_MAX,
        scheduleMaxSeconds: AUTO_SCHEDULE_MAX_S
      })
    },
    postAuto (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      readJsonObjectBody(req)
        .then((read) => {
          if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
          if (!read.ok) { sendJson(res, read.status, read.body); return }
          const payload = read.payload
          let on = auto.on
          if (Object.prototype.hasOwnProperty.call(payload, 'on')) {
            if (typeof payload.on !== 'boolean') { sendJson(res, 400, { error: 'on 必须是布尔值' }); return }
            on = payload.on
          }
          let interval = auto.interval
          if (Object.prototype.hasOwnProperty.call(payload, 'interval')) {
            if (typeof payload.interval !== 'number' || !Number.isInteger(payload.interval) ||
              payload.interval < AUTO_MIN_S || payload.interval > AUTO_MAX_S) {
              sendJson(res, 400, { error: `interval 必须是 ${AUTO_MIN_S}–${AUTO_MAX_S} 的整数` })
              return
            }
            interval = payload.interval
          }
          let schedule = auto.schedule
          const writesSchedule = Object.prototype.hasOwnProperty.call(payload, 'schedule')
          if (writesSchedule) {
            // 乐观并发：两个标签页各改一份再保存时，后提交者不得静默覆盖先提交者的窗口。
            // 客户端带上读取时的 updatedAt；可选参数，老客户端/脚本不带也能写（兼容）。
            if (typeof payload.baseUpdatedAt === 'number' && payload.baseUpdatedAt !== auto.updatedAt) {
              sendJson(res, 409, { error: 'schedule_conflict', message: '另一个标签页刚改过分时段，请刷新后再保存', auto: autoSnapshot() })
              return
            }
            const parsed = normalizeAutoSchedule(payload.schedule)
            if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return }
            schedule = parsed.value
          }
          if (on) {
            auto.interval = interval
            auto.schedule = schedule
            if (!auto.on) {
              auto.on = true
              auto.startedAt = Date.now()
              auto.runs = 0
              auto.fails = 0
              auto.degraded = false
              auto.spawnFails = 0
              auto.lastError = ''
            }
            if (!persistAuto()) {
              sendJson(res, 500, { error: '自动运行配置落盘失败，请检查缓存目录权限/磁盘' })
              return
            }
            // 有在途轮次时不重排；它结束后按新间隔排下一轮。
            if (!hasAutoInFlight()) scheduleAuto(autoNextDelay())
          } else {
            auto.interval = interval
            auto.schedule = schedule
            stopAuto('')
            if (!persistAuto()) {
              sendJson(res, 500, { error: '自动运行配置落盘失败，请检查缓存目录权限/磁盘' })
              return
            }
          }
          sendJson(res, 200, {
            auto: autoSnapshot(),
            min: AUTO_MIN_S,
            max: AUTO_MAX_S,
            maxFails: AUTO_MAX_FAILS,
            scheduleMax: AUTO_SCHEDULE_MAX,
            scheduleMaxSeconds: AUTO_SCHEDULE_MAX_S
          })
        })
        .catch((e) => { logCaught('auto/config', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    }
  }
}

module.exports = { createConfigHandlers }
