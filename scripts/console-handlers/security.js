'use strict'
// 控制台 security 域 HTTP handler（D1 路由拆分）：两步验证（状态/开启/关闭）与信任设备退出。
// 依赖一律经路由表的 ctx 显式注入；不 require scripts/console.js（避免循环依赖）。
const fs = require('node:fs')

function createSecurityHandlers (ctx) {
  const { sendJson, readJsonObjectBody, logCaught } = ctx.http
  const {
    token, twoFactor, usedTotpSteps, lastEnableResult, setLastEnableResult,
    deletePendingTwoFactor, resetTwoFactorRuntime, isShuttingDown
  } = ctx.state
  const {
    hasPendingTwoFactor, rememberPendingTwoFactor, findPendingTwoFactor, verifySecondFactor,
    verifyTotpCode, totpStepAt, generateTotpSecret, generateRecoveryCodes, recoveryRecordOf,
    persistTwoFactorState, revokeTrustedDevices, trustedDeviceCount, loginThrottled,
    noteLoginFailure, clearLoginFailures, twoFactorCookieHeader, clearTwoFactorCookieHeader,
    clearDeviceCookieHeader, totpQrDataUrl, filterMediaAllowed
  } = ctx.twofa
  const { writeAuthVerdict } = ctx.actions
  const { BODY_DEFAULT_MAX_BYTES, TOTP_PERIOD_S, TOTP_DIGITS, TWO_FACTOR_ENABLE_RESULT_TTL_MS } = ctx.consts
  return {
    // ── v3.357 两步验证（Google Authenticator / TOTP）──────────────────────────
    // 只保护浏览器页面；API 仍走原访问令牌。配置写面只认 Bearer（与其它写端点同口径）。
    getTwoFactorStatus (req, res, url) {
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, {
        enabled: twoFactor.enabled,
        pending: hasPendingTwoFactor(),
        recoveryRemaining: twoFactor.recovery ? twoFactor.recovery.hashes.length : 0,
        // 信任设备数（v3.374）：系统页的「退出所有信任设备」按钮靠它显示「现在记住了几台」。
        trustedDevices: twoFactor.enabled ? trustedDeviceCount() : 0
      })
    },
    // 退出所有信任设备（v3.374）：写面只认 Bearer（与其它写端点同口径，Cookie-only 401）。
    // 同时清掉当前浏览器的设备 Cookie——否则页面上「已退出」，这台机器下次仍能免验证进来。
    postDevicesRevoke (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      req.resume() // 不需要 body；显式排空，避免 keep-alive 连接里残留字节污染下一个请求
      if (!revokeTrustedDevices()) {
        sendJson(res, 500, { error: 'write_failed', message: '设备列表清空失败，请稍后再试' })
        return
      }
      res.setHeader('Set-Cookie', clearDeviceCookieHeader())
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, { revoked: true, devices: 0 })
    },
    postTwoFactorSetup (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      if (twoFactor.enabled) { sendJson(res, 409, { error: 'already_enabled', message: '两步验证已经开启' }); return }
      // 该端点不读 body（只生成密钥）；显式排空，避免 keep-alive 连接里残留 body
      // 被下一次请求当成请求行解析。前端仍会发一个空 JSON 对象。
      req.resume()
      const secret = generateTotpSecret()
      const pending = rememberPendingTwoFactor(secret)
      const label = encodeURIComponent('xbk-push:console')
      const issuer = encodeURIComponent('xbk-push')
      const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, { setupId: pending.id, secret, otpauth, qrDataUrl: totpQrDataUrl(otpauth), account: 'xbk-push:console', issuer: 'xbk-push', period: TOTP_PERIOD_S, digits: TOTP_DIGITS })
    },
    postTwoFactorEnable (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      if (!filterMediaAllowed(req)) { sendJson(res, 415, { error: 'unsupported_media_type', code: 'unsupported_media_type' }); return }
      readJsonObjectBody(req, BODY_DEFAULT_MAX_BYTES).then((read) => {
        if (!read.ok) { sendJson(res, read.status, read.body); return }
        const payload = read.payload
        const code = typeof payload.code === 'string' ? payload.code.trim() : ''
        const setupId = typeof payload.setupId === 'string' ? payload.setupId : ''
        if (twoFactor.enabled) {
          // 成功响应丢包时允许同一 setupId + 仍有效的验证码重取一次恢复码（短时、只存内存）。
          const receipt = lastEnableResult()
          const fresh = receipt && Date.now() - receipt.createdAt < TWO_FACTOR_ENABLE_RESULT_TTL_MS
          if (fresh && setupId !== '' && receipt.setupId === setupId && verifyTotpCode(receipt.secret, code)) {
            res.setHeader('Set-Cookie', twoFactorCookieHeader(req, twoFactor.secret))
            res.setHeader('Cache-Control', 'no-store')
            sendJson(res, 200, { enabled: true, recoveryCodes: receipt.recoveryCodes, recoveryRemaining: receipt.recoveryCodes.length })
            return
          }
          sendJson(res, 409, { error: 'already_enabled', message: '两步验证已经开启' })
          return
        }
        if (loginThrottled(req)) {
          sendJson(res, 429, { error: 'too_many_attempts', message: '尝试次数过多，请 5 分钟后再试' })
          return
        }
        const pending = findPendingTwoFactor(setupId, code)
        if (!pending) {
          sendJson(res, 400, { error: 'setup_required', message: '请先获取新的设置密钥（二维码/密钥）' })
          return
        }
        if (!verifyTotpCode(pending.secret, code)) {
          noteLoginFailure(req)
          sendJson(res, 400, { error: 'invalid_code', message: '验证码不对，请确认手机时间准确后重试' })
          return
        }
        const recoveryCodes = generateRecoveryCodes()
        const recovery = recoveryRecordOf(recoveryCodes)
        // 重配 2FA = 换了一把新钥匙：先作废旧设备信任，清不掉就整体失败（否则旧 cookie
        // 仍能绕过新密钥；Sourcery High「Old trusted devices bypass new 2FA」）。
        if (!revokeTrustedDevices()) {
          sendJson(res, 500, { error: 'revoke_failed', message: '旧设备信任清理失败，未开启两步验证' })
          return
        }
        if (!persistTwoFactorState(twoFactor.file, pending.secret, recovery)) {
          sendJson(res, 500, { error: 'write_failed', message: '两步验证配置保存失败' })
          return
        }
        twoFactor.enabled = true
        twoFactor.secret = pending.secret
        twoFactor.recovery = recovery
        twoFactor.createdAt = Date.now()
        deletePendingTwoFactor(pending.id)
        // 开启时用的那一步也记入已用集合：同一码不能在 30 秒内再换一次登录 Cookie。
        const setupStep = totpStepAt(pending.secret, code)
        if (setupStep !== null) usedTotpSteps.set(setupStep, (setupStep + 2) * TOTP_PERIOD_S * 1000)
        setLastEnableResult({ setupId: pending.id, secret: pending.secret, recoveryCodes, createdAt: Date.now() })
        clearLoginFailures(req)
        res.setHeader('Set-Cookie', twoFactorCookieHeader(req, twoFactor.secret))
        res.setHeader('Cache-Control', 'no-store')
        sendJson(res, 200, { enabled: true, recoveryCodes, recoveryRemaining: recoveryCodes.length })
      }).catch((e) => { logCaught('2fa/enable', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    },
    postTwoFactorDisable (req, res, url) {
      if (isShuttingDown()) { sendJson(res, 503, { error: '控制台正在关闭，动作未执行' }); return }
      const verdict = writeAuthVerdict(req, url.searchParams, token)
      if (!verdict.ok) { sendJson(res, verdict.status, verdict.body); return }
      if (!filterMediaAllowed(req)) { sendJson(res, 415, { error: 'unsupported_media_type', code: 'unsupported_media_type' }); return }
      readJsonObjectBody(req, BODY_DEFAULT_MAX_BYTES).then((read) => {
        if (!read.ok) { sendJson(res, read.status, read.body); return }
        const payload = read.payload
        const code = typeof payload.code === 'string' ? payload.code.trim() : ''
        if (!twoFactor.enabled) {
          res.setHeader('Set-Cookie', clearTwoFactorCookieHeader(req))
          sendJson(res, 200, { enabled: false })
          return
        }
        if (loginThrottled(req)) {
          sendJson(res, 429, { error: 'too_many_attempts', message: '尝试次数过多，请 5 分钟后再试' })
          return
        }
        // 关闭时要先核验、再删文件；恢复码只在删文件成功后才算消耗（persistRecovery:false）。
        const check = verifySecondFactor(code, { persistRecovery: false })
        if (!check.ok) {
          noteLoginFailure(req)
          const why = check.error === 'replay'
            ? '这个验证码已经用过，请等手机上的数字刷新后再试；也可以用恢复码。'
            : '验证码不对，未关闭'
          sendJson(res, 400, { error: 'invalid_code', message: why })
          return
        }
        // 先清设备信任、再删配置：清不掉就保持 2FA 开启，避免留下「已关 2FA 但旧设备还能进」的状态。
        if (!revokeTrustedDevices()) {
          sendJson(res, 500, { error: 'revoke_failed', message: '信任设备清理失败，未关闭两步验证' })
          return
        }
        try {
          fs.rmSync(twoFactor.file, { force: true })
        } catch (e) {
          sendJson(res, 500, { error: 'remove_failed', message: '两步验证配置删除失败' })
          return
        }
        twoFactor.enabled = false
        twoFactor.secret = ''
        twoFactor.recovery = null
        twoFactor.createdAt = 0
        resetTwoFactorRuntime()
        clearLoginFailures(req)
        res.setHeader('Set-Cookie', [clearTwoFactorCookieHeader(req), clearDeviceCookieHeader()])
        sendJson(res, 200, { enabled: false })
      }).catch((e) => { logCaught('2fa/disable', e); sendJson(res, 500, { error: '读取请求体失败' }) })
    }
  }
}

module.exports = { createSecurityHandlers }
