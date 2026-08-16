/* eslint promise/param-names: off */ // new Promise(r => ...) 短参数名为项目既有风格
/* eslint camelcase: off */ // push_config 等 snake_case 为项目设计命名（standard 风格检查忽略）
'use strict'

// 精简版推送模块
// 仅保留：PushPlus、Server酱、Bark、PushMe、企业微信机器人、wxpusher、息知、PushDeer

const got = require('got')
const { baseRequestOptions, invalidateDnsForError, profileMs } = require('./xbk_agents')
const timeout = 15000
const REQUEST_OPTIONS = baseRequestOptions()

const requestExtras = (params) => {
  try { return params && params.signal ? { signal: params.signal } : {} } catch (e) { return {} }
}

// 配置/错误值安全字符串化：异常 toString/valueOf 不能让脱敏和错误处理路径再次崩溃。
function safeString (value) {
  try { return String(value === undefined || value === null ? '' : value) } catch (e) { return '' }
}

// 去尾部斜杠：线性扫描替代 /\/+$/（S8786 对 X+$ 型正则标记超线性回溯；配置值虽可信，
// 但改成等价线性实现可消除告警且无语义差异）
function trimTrailingSlashes (s) {
  let i = s.length
  while (i > 0 && s.codePointAt(i - 1) === 47) i-- // 47 = '/'
  return i === s.length ? s : s.slice(0, i)
}
// 日志密钥脱敏：保留前4位+后2位，中间 ***（防止 cron 日志重定向/分享时泄露密钥）
function maskKey (k) {
  const s = safeString(k)
  return s.length <= 6 ? '***' : s.slice(0, 4) + '***' + s.slice(-2)
}
// URL 脱敏：host 保留，路径/设备码段脱敏（Bark 的 api.day.app/deviceKey）
function maskUrl (u) {
  const s = safeString(u)
  const m = s.match(/^(https?:\/\/[^/]+)\/(.+)$/)
  return m ? m[1] + '/' + maskKey(m[2]) : maskKey(s)
}
// 代理对安全截断（v3.147）：按码元截断但不切断 emoji——末尾高代理退一位、孤立低代理退一位
// （Server酱 v3.126 只处理高代理；此处统一高/低代理，wxpusher summary 复用）
// v3.178：与主代码 truncateUtf16 对齐——补 ZWJ/变体选择符/组合字符退位（wxpusher summary/TG 截断
// 曾拆散 👨👩👧👦 家庭 emoji、❤️ 丢 VS16；§12-2 重复实现收敛）
function safeSlice (s, max) {
  let str
  try { str = String(s === undefined || s === null ? '' : s) } catch (e) { str = '' }
  if (str.length <= max) return str
  let cut = str.slice(0, max)
  const isModifier = (c) => c === 0x200D || (c >= 0xFE00 && c <= 0xFE0F) ||
        (c >= 0x0300 && c <= 0x036F) || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) ||
        (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F)
  while (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xD800 && last <= 0xDBFF) { cut = cut.slice(0, -1); continue } // 孤立高代理
    if (last >= 0xDC00 && last <= 0xDFFF) {
      const prev = cut.charCodeAt(cut.length - 2)
      if (!(prev >= 0xD800 && prev <= 0xDBFF)) { cut = cut.slice(0, -1); continue } // 孤立低代理
      break // 配对完整
    }
    if (last === 0x200D) { cut = cut.slice(0, -1); continue } // 末尾孤立 ZWJ
    const next = str.charCodeAt(cut.length)
    if (isModifier(next)) { cut = cut.slice(0, -1); continue } // 截断点后是修饰符 → 退位
    break
  }
  return cut
}
// 错误摘要（v3.75）：失败日志统一打摘要而非整个 err 对象——
// $.post 回调的 err 是 err.response.body（API 异常响应体，可能回显请求参数含密钥），
// 直接 console.log(err) 会在 cron 日志重定向/分享时泄露；截断 200 字符防超长刷屏
const SECRET_FIELD_RE = /(?:token|app[_-]?token|secret|password|authorization|(?:^|_)(?:key|auth)|bark_push|push_key|pushme_key|deer_key|xizhi_key|bot_token|user_id)/i

function addSecretCandidates (value, secrets) {
  const text = safeString(value)
  if (text.length < 4) return
  secrets.add(text)
  for (const part of text.split('#')) {
    if (part.length >= 4) secrets.add(part)
    const m = part.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i)
    if (m) {
      for (const segment of m[1].split(/[^A-Za-z0-9_-]+/)) {
        if (segment.length >= 4) secrets.add(segment)
      }
    }
  }
}

function collectConfiguredSecrets (value, fieldName, secrets, seen) {
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    // 环境变量 WX_PUSHER_CHANNELS 可能仍是 JSON 字符串，先尝试展开嵌套 appToken。
    if (/channels/i.test(fieldName || '') && /^[[{]/.test(value.trim())) {
      try {
        const parsed = JSON.parse(value)
        collectConfiguredSecrets(parsed, fieldName, secrets, seen)
      } catch (e) { /* 不是 JSON 时继续按普通密钥文本处理 */ }
    }
    if (SECRET_FIELD_RE.test(fieldName || '')) addSecretCandidates(value, secrets)
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectConfiguredSecrets(item, fieldName, secrets, seen)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    collectConfiguredSecrets(child, key, secrets, seen)
  }
}

function configuredSecrets () {
  const secrets = new Set()
  try {
    const seen = new WeakSet()
    for (const [key, value] of Object.entries(push_config)) {
      collectConfiguredSecrets(value, key, secrets, seen)
    }
  } catch (e) { /* 配置脏值不影响日志输出 */ }
  return [...secrets].sort((a, b) => b.length - a.length)
}

function redactSecrets (text) {
  let out = safeString(text)
  try {
    for (const candidate of configuredSecrets()) {
      out = out.split(candidate).join(maskKey(candidate))
    }
  } catch (e) { /* 配置异常不影响错误摘要输出 */ }
  return out
}

function safeErr (e) {
  if (e === undefined || e === null) return ''
  if (typeof e === 'string') {
    const s = redactSecrets(e)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  }
  if (e && typeof e === 'object') {
    let message
    try { message = e.message } catch (err) { message = undefined }
    if (message) {
      const s = redactSecrets(message)
      return s.length > 200 ? s.slice(0, 200) + '…' : s
    }
  }
  // 只保留协议错误摘要字段，禁止把服务端完整响应（可能回显 token/key/请求体）写入日志。
  // 未知结构不再 JSON.stringify 全对象，避免敏感字段通过兜底路径泄露。
  if (typeof e === 'object') {
    const fields = ['code', 'errno', 'errcode', 'error_code', 'statusCode', 'message', 'msg', 'errmsg', 'description', 'error']
    const summary = {}
    for (const key of fields) {
      try {
        if (e[key] !== undefined && e[key] !== null) summary[key] = redactSecrets(e[key])
      } catch (err) { /* getter 异常字段跳过 */ }
    }
    let s
    try { s = Object.keys(summary).length ? JSON.stringify(summary) : '[响应结构异常]' } catch (err) { s = '[响应结构异常]' }
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  }
  return redactSecrets(e).slice(0, 200)
}

function channelError (error, channel, response = null, providerCode = '') {
  const message = safeErr(error) || `${channel} 发送失败`
  const result = new Error(message)
  const source = error && typeof error === 'object' ? error : null
  const statusCode = response && Number.isInteger(response.statusCode)
    ? response.statusCode
    : source && source.response && Number.isInteger(source.response.statusCode)
      ? source.response.statusCode
      : source && Number.isInteger(source.statusCode) ? source.statusCode : null
  if (source && source.code !== undefined && source.code !== null) result.code = source.code
  if (statusCode !== null) result.statusCode = statusCode
  if (providerCode !== undefined && providerCode !== null && providerCode !== '') result.providerCode = providerCode
  result.channel = channel
  return result
}

function aggregateChannelError (channel, message, failures = []) {
  const result = channelError(new Error(message), channel)
  result.failures = failures.filter(Boolean)
  result.code = `CHANNEL_${safeString(channel).toUpperCase()}_FAILED`
  return result
}

// 部分通道/API 代理会把数字业务码序列化成字符串；成功语义允许两种 JSON 类型。
function isCode (value, expected) {
  return value === expected || value === String(expected)
}

const push_config = {
  // 以下真实密钥由 push_config.local.js 提供（已被 .gitignore 忽略，不入库）

  HITOKOTO: 'false', // 启用一言（随机句子）

  // BARK_PUSH：Bark 地址或设备码，例：https://api.day.app/DxHcxxxxxRxxxxxxcm/
  // 用 # 分隔多个设备码，例如：deviceKey1#deviceKey2#https://api.day.app/deviceKey3
  BARK_PUSH: '',
  BARK_ARCHIVE: '', // bark 推送是否存档
  BARK_GROUP: '', // bark 推送分组
  BARK_SOUND: '', // bark 推送声音
  BARK_ICON: '', // bark 推送图标
  BARK_LEVEL: '', // bark 推送时效性
  BARK_URL: '', // bark 推送跳转URL

  // 推送到个人QQ：http://127.0.0.1/send_private_msg
  // 群：http://127.0.0.1/send_group_msg
  // 推送到个人QQ 填入 user_id=个人QQ
  // 群 填入 group_id=QQ群

  PUSH_KEY: '', // server 酱的 PUSH_KEY(原真实key已移除,请自行配置), 兼容旧版与 Turbo 版

  DEER_KEY: '', // PushDeer 的 PUSHDEER_KEY
  DEER_URL: '', // PushDeer 的 PUSHDEER_URL

  // 官方文档：http://www.pushplus.plus/
  PUSH_PLUS_TOKEN: '', // push+ 微信推送的用户令牌
  PUSH_PLUS_USER: '', // push+ 微信推送的群组编码

  // wxpusher 文档：https://wxpusher.zjiecode.com/docs/
  // 注意wxpusher填写的是主题ID，而不是用户ID
  WX_pusher_appToken: '', // wxpusher appToken(真实token已移除,请自行配置)
  WX_pusher_topicIds: '', // wxpusher 主题ID(真实ID已移除)
  // 多应用分流：[{ appToken: '...', topicIds: '主题ID' }]；为空时兼容上面单应用配置
  WX_pusher_channels: [],

  // 息知文档：https://xz.qqoq.net/
  // 推送地址示例：https://xizhi.qqoq.net/xxxxxxxxxxxxx.send
  WX_XIZHI_KEY: '',

  // Pushme 安卓APP 官方文档：https://push.i-i.me
  PUSHME_URL: 'https://push.i-i.me',
  PUSHME_KEY: '', // PushMe 的 PUSHME_KEY(真实key已移除,请自行配置)，多个用#分割

  // MeoW 文档：https://www.chuckfang.com/MeoW/api_doc.html
  // 用户昵称，例如这里面的昵称 http://api.chuckfang.com/昵称/
  // 用 # 分隔多个用户ID，例如：user1#user2#user3

  // 微加机器人，官方网站：https://www.weplusbot.com/

  QYWX_ORIGIN: 'https://qyapi.weixin.qq.com', // 企业微信代理地址
  // 企业微信应用/企业家校推送
  /*
      此处QYWX_AM填你企业微信应用消息的值 https://new.xianbao.fun/jiaocheng/505380.html  https://new.xianbao.fun/jiaocheng/566777.html
      微信应用推送(第四个参数为yy)： QYWX_AM依次填入 企业ID,应用Agentld,应用Secret,yy
      微信家校推送(第四个参数为jx)： QYWX_AM依次填入 企业ID,应用Agentld,应用Secret,jx
      如需推送多个企业微信应用，请增加一项json
      */

  // 企业微信应用/企业家校推送

  QYWX_KEY: '', // 企业微信机器人的 webhook(详见文档 https://work.weixin.qq.com/api/doc/90000/90136/91770)，例如：693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa

  TG_BOT_TOKEN: '', // tg 机器人的 TG_BOT_TOKEN，例：1407203283:AAG9rt-6RDaaX0HBLZQq0laNOh898iFYaRQ
  TG_USER_ID: '', // tg 机器人的 TG_USER_ID，例：1434078534
  TG_API_HOST: 'https://api.telegram.org', // tg 代理 api
  TG_PROXY_AUTH: '', // tg 代理认证参数
  TG_PROXY_HOST: '', // tg 机器人的 TG_PROXY_HOST
  TG_PROXY_PORT: '' // tg 机器人的 TG_PROXY_PORT

  // CHRONOCAT API https://chronocat.vercel.app/install/docker/official/

}

// 加载本地推送配置（含真实密钥，不入库）：若 push_config.local.js 存在则覆盖默认空配置
// 文件不存在 = 正常（默认空配置，克隆者需自行创建）；存在但加载失败 = 显式警告（避免密钥静默失效）
const fs = require('fs')
const path = require('path')
const localPath = path.join(__dirname, 'push_config.local.js')
if (fs.existsSync(localPath)) {
  try {
    const localCfg = require(localPath)
    if (localCfg && typeof localCfg === 'object') {
      Object.assign(push_config, localCfg)
    } else {
      console.warn('⚠️ push_config.local.js 导出格式异常（应为对象），推送密钥可能未生效')
    }
  } catch (e) {
    console.warn('⚠️ push_config.local.js 加载失败（推送密钥可能未生效）:', e && e.message ? e.message : String(e))
  }
}

// 青龙面板环境变量覆盖本地配置：本地开发可用 push_config.local.js，
// 青龙无需把密钥写进仓库，直接在环境变量中配置即可。
const ENV_ALIASES = {
  PUSH_PLUS_TOKEN: ['PUSH_PLUS_TOKEN'],
  PUSH_PLUS_USER: ['PUSH_PLUS_USER'],
  PUSH_KEY: ['PUSH_KEY'],
  BARK_PUSH: ['BARK_PUSH'],
  QYWX_KEY: ['QYWX_KEY'],
  WX_pusher_appToken: ['WX_pusher_appToken', 'WX_PUSHER_APP_TOKEN'],
  WX_pusher_topicIds: ['WX_pusher_topicIds', 'WX_PUSHER_TOPIC_IDS'],
  WX_pusher_channels: ['WX_pusher_channels', 'WX_PUSHER_CHANNELS'],
  WX_XIZHI_KEY: ['WX_XIZHI_KEY'],
  DEER_KEY: ['DEER_KEY'],
  DEER_URL: ['DEER_URL'],
  PUSHME_KEY: ['PUSHME_KEY'],
  PUSHME_URL: ['PUSHME_URL'],
  TG_BOT_TOKEN: ['TG_BOT_TOKEN'],
  TG_USER_ID: ['TG_USER_ID'],
  TG_API_HOST: ['TG_API_HOST'],
  HITOKOTO: ['HITOKOTO']
}
for (const [configKey, names] of Object.entries(ENV_ALIASES)) {
  // v3.234：存在但为空的 env 不覆盖本地配置——QingLong 面板留空/误删值时，
  // 空字符串覆盖有效 token 会导致单通道用户推送失效（消息丢失）
  const envName = names.find(name => {
    const raw = process.env[name]
    return raw !== undefined && String(raw).trim() !== ''
  })
  if (envName !== undefined) push_config[configKey] = process.env[envName]
}

async function one () {
  const url = 'https://v1.hitokoto.cn/'
  // v3.151：3s 短超时——一言是推送装饰，API 慢/挂时不应阻塞推送（曾默认 15s，启用 HITOKOTO 用户每次推送延迟）
  const res = await got.get(url, { ...REQUEST_OPTIONS, timeout: 3000 })
  // body 兼容：官方 got 已自动解析 JSON；字符串响应时保留原文
  const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
  // 防御（v3.86）：响应结构异常（缺 hitokoto/from）→ 抛错走 sendNotify 的 catch 跳过，
  // 避免输出 'undefined    ----undefined' 垃圾文本
  if (!body || typeof body.hitokoto !== 'string' || !body.hitokoto) {
    throw new Error('一言响应结构异常')
  }
  return `${body.hitokoto}    ----${body.from || ''}` // v3.87: from 缺失不输出 undefined 残尾
}

const $ = {
  post: (params, callback) => {
    const { url, ...others } = params
    got.post(url, others).then(
      (res) => {
        let body = res.body
        try {
          body = JSON.parse(body)
        } catch (error) {
          // 预期路径：非 JSON 响应（HTML/文本）保留原始字符串，供各通道按需解析
        }
        callback(null, res, body, res.timings)
      },
      (err) => {
        // v3.75：失败时传 Error 对象而非响应体——API 异常响应体可能回显请求参数（含密钥），
        // 且各通道失败日志已统一 safeErr 摘要（打 message 不含响应内容）
        invalidateDnsForError(err, url)
        callback(err || new Error('请求失败'), null, null, err && err.timings)
      }
    )
  },
  get: (params, callback) => {
    const { url, ...others } = params
    got.get(url, others).then(
      (res) => {
        let body = res.body
        try {
          body = JSON.parse(body)
        } catch (error) {
          // 预期路径：非 JSON 响应（HTML/文本）保留原始字符串，供各通道按需解析
        }
        callback(null, res, body)
      },
      (err) => {
        // v3.75：失败时传 Error 对象而非响应体——API 异常响应体可能回显请求参数（含密钥），
        // 且各通道失败日志已统一 safeErr 摘要（打 message 不含响应内容）
        invalidateDnsForError(err, url)
        callback(err || new Error('请求失败'))
      }
    )
  },
  logErr: console.log
}

function pushPlusNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { PUSH_PLUS_TOKEN, PUSH_PLUS_USER } = push_config
    if (PUSH_PLUS_TOKEN) {
      desp = mdToPlain(desp) // v3.128：Push+ 默认 html，markdown 符号会原样显示
      // v3.262：先归一化 \r\n → \n，避免 Windows 换行被逐字符替换成两个 <br>（多余空行）
      desp = desp.replaceAll('\r\n', '\n').replaceAll('\n', '<br>').replaceAll('\r', '<br>') // 默认为html, 不支持plaintext
      const body = {
        token: `${PUSH_PLUS_TOKEN}`,
        title: `${text}`,
        content: `${desp}`,
        topic: `${PUSH_PLUS_USER}`
      }
      const options = {
        ...REQUEST_OPTIONS,
        ...requestExtras(params),
        url: 'https://www.pushplus.plus/send',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json'
        },
        timeout
      }
      $.post(options, (err, resp, data) => {
        try {
          if (err) {
            const failure = channelError(err, 'pushplus', resp)
            reject(failure)
            console.log(
                            `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                            }通知消息失败😞\n`,
                            safeErr(failure)
            )
          } else {
            // v3.180：data 判空防御——HTTP 200 + 响应体 JSON null 时 data.code 曾抛
            // TypeError → catch 只记日志 → finally resolve(data) 虚假成功 → 主流程写缓存
            // → 消息永久丢失（系统验证实测确认，P1）
            if (data && isCode(data.code, 200)) {
              console.log(
                                `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                                }通知消息完成🎉\n`
              )
            } else {
              console.log(
                                `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                                }通知消息异常 ${data && data.msg ? safeErr(data.msg) : ''}\n`
              ) // v3.180：data.msg 也判空——null 时模板访问曾二次抛错走 catch→虚假成功
              // v3.160：API 级失败(code≠200) reject（与 wxpusher v3.154 同口径）——曾静默 resolve，
              // 单通道用户主流程写缓存 → 消息永久丢失
              const failure = channelError(
                new Error(data && data.msg ? safeErr(data.msg) : 'Push+ 发送失败'),
                'pushplus',
                resp,
                data && data.code
              )
              reject(failure)
            }
          }
        } catch (e) {
          // 响应结构异常（含 getter 抛错）必须按通道失败处理；否则 finally 的 resolve 会把消息误记为成功。
          const failure = channelError(e, 'pushplus', resp)
          reject(failure)
          $.logErr(safeErr(failure))
        } finally {
          resolve(data)
        }
      })
    } else {
      resolve()
    }
  })
}

function serverNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { PUSH_KEY } = push_config
    if (PUSH_KEY) {
      // v3.176：PUSH_KEY 数字/对象脏配置 → String 化（曾 .includes 抛 TypeError 通道静默失败）
      const pushKey = String(PUSH_KEY)
      // v3.126：Server酱 title 上限 32 字符——主代码 titleMax=100 不满足，此处通道层精准截断
      // （安全处理代理对：末尾高代理退一位，避免切坏 emoji）
      if (text.length > 32) {
        let cut = text.slice(0, 32)
        const last = cut.charCodeAt(cut.length - 1)
        if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1)
        text = cut
      }
      // 微信server酱推送通知一个\n不会换行，需要两个\n才能换行，故做此替换
      // v3.148：只加倍"单个 \n"——\n\n（Markdown 段落分隔）已是 Server酱换行格式，曾整体加倍成 \n\n\n\n 大段空白
      desp = desp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1\n\n')
      const options = {
        ...REQUEST_OPTIONS,
        ...requestExtras(params),
        url: pushKey.includes('SCT')
          ? `https://sctapi.ftqq.com/${pushKey}.send`
          : `https://sc.ftqq.com/${pushKey}.send`,
        body: `text=${encodeURIComponent(text)}&desp=${encodeURIComponent(desp)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout
      }
      $.post(options, (err, resp, data) => {
        try {
          if (err) {
            reject(err)
            console.log('Server 酱发送通知调用API失败😞\n', safeErr(err))
          } else {
            // server酱和Server酱·Turbo版的返回json格式不太一样
            // 响应防御：Server酱/Turbo 返回结构不同，且异常时可能缺字段
            const rawErrno = data && (data.errno !== undefined ? data.errno : (data.data && data.data.errno))
            const errno = rawErrno === '0' || rawErrno === 0
              ? 0
              : (rawErrno === '1024' || rawErrno === 1024 ? 1024 : rawErrno)
            if (errno === 0) {
              console.log('Server 酱发送通知消息成功🎉\\n')
            } else if (errno === 1024) {
              // 一分钟内发送相同的内容会触发（内容已送达，视为成功不重试）
              console.log(`Server 酱发送通知消息异常 ${safeErr(data && data.errmsg)}\n`)
            } else {
              console.log(`Server 酱发送通知消息异常 ${safeErr(data)}\n`)
              // v3.160：API 级失败(errno≠0/1024) reject——曾静默 resolve 致单通道用户消息丢失
              const failure = channelError(
                new Error(data && data.errmsg ? safeErr(data.errmsg) : 'Server酱 发送失败'),
                'server酱',
                resp,
                rawErrno
              )
              reject(failure)
            }
          }
        } catch (e) {
          // 响应结构异常（含 getter 抛错）必须按通道失败处理；否则 finally 的 resolve 会把消息误记为成功。
          reject(e)
          $.logErr(safeErr(e))
        } finally {
          resolve(data)
        }
      })
    } else {
      resolve()
    }
  })
}

function barkNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const {
      BARK_PUSH,
      BARK_ICON,
      BARK_SOUND,
      BARK_GROUP,
      BARK_LEVEL,
      BARK_ARCHIVE,
      BARK_URL
    } = push_config

    if (!BARK_PUSH) {
      return resolve()
    }
    desp = mdToPlain(desp) // v3.128：Bark iOS 纯文本，markdown 符号会原样显示

    // 分割多个设备码
    // v3.176：BARK_PUSH 数字/对象脏配置 → String 化（曾 .split 抛 TypeError 通道静默失败）
    const deviceKeys = String(BARK_PUSH).split('#').filter(key => key.trim())
    if (deviceKeys.length === 0) {
      return resolve()
    }

    // 处理所有设备推送
    const pushPromises = deviceKeys.map(deviceKey => {
      let pushUrl = deviceKey.trim()
      // 兼容BARK本地用户只填写设备码的情况
      if (!/^https?:\/\//i.test(pushUrl)) {
        pushUrl = `https://api.day.app/${pushUrl}`
      }

      const options = {
        ...REQUEST_OPTIONS,
        ...requestExtras(params),
        url: pushUrl,
        json: {
          title: text,
          body: desp,
          icon: BARK_ICON,
          sound: BARK_SOUND,
          group: BARK_GROUP,
          isArchive: BARK_ARCHIVE,
          level: BARK_LEVEL,
          url: BARK_URL
        },
        headers: {
          'Content-Type': 'application/json'
        },
        timeout
      }

      return new Promise((innerResolve) => {
        $.post(options, (err, resp, data) => {
          try {
            if (err) {
              const failure = channelError(err, 'bark', resp)
              console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 失败😞\n`, safeErr(failure))
              innerResolve({ ok: false, error: failure })
            } else {
              // data 判空：HTTP 200 + JSON null 时不依赖 catch 兜底，避免 TypeError 噪音
              if (data && isCode(data.code, 200)) {
                console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 成功🎉\n`)
                innerResolve({ ok: true })
              } else {
                const failure = channelError(
                  new Error(data && data.message ? safeErr(data.message) : 'Bark 发送失败'),
                  'bark',
                  resp,
                  data && data.code
                )
                console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 异常 ${safeErr(failure)}\n`)
                // v3.166：单设备失败不拖垮整体——多设备（# 分割）一个失效时，
                // 曾外层 reject → 有效设备已收到但通道整体失败 → 不写缓存 → 每次运行重试 → 有效设备重复轰炸
                innerResolve({ ok: false, error: failure })
              }
            }
          } catch (e) {
            const failure = channelError(e, 'bark', resp)
            $.logErr(safeErr(failure))
            innerResolve({ ok: false, error: failure })
          } finally {
            innerResolve({ ok: false })
          }
        })
      })
    })

    // 等待所有推送完成
    // v3.166：至少一个设备成功 = 通道成功（与 sendNotify allSettled 哲学一致）——全部失败才 reject
    Promise.all(pushPromises).then(results => {
      if (results.some(r => r && r.ok)) resolve()
      else reject(aggregateChannelError('bark', 'Bark 全部设备发送失败', results.map(r => r && r.error)))
    })
  })
}

function pushMeNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { PUSHME_KEY, PUSHME_URL } = push_config

    if (!PUSHME_KEY) {
      return resolve()
    }

    // 分割多个推送KEY
    // v3.176：PUSHME_KEY 数字/对象脏配置 → String 化（曾 .split 抛 TypeError 通道静默失败）
    const pushKeys = String(PUSHME_KEY).split('#').filter(key => key.trim())
    if (pushKeys.length === 0) {
      return resolve()
    }

    // 处理所有推送请求
    const pushPromises = pushKeys.map(pushKey => {
      const trimmedKey = pushKey.trim()
      const options = {
        ...REQUEST_OPTIONS,
        ...requestExtras(params),
        url: PUSHME_URL || 'https://push.i-i.me',
        json: {
          push_key: trimmedKey,
          title: text,
          content: desp,
          type: 'markdown'
        },
        headers: {
          'Content-Type': 'application/json'
        },
        timeout
      }

      return new Promise((innerResolve) => {
        $.post(options, (err, resp, data) => {
          try {
            if (err) {
              const failure = channelError(err, 'pushme', resp)
              console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 失败😞\n`, safeErr(failure))
              innerResolve({ ok: false, error: failure })
            } else {
              if (data === 'success') {
                console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 成功🎉\n`)
                innerResolve({ ok: true })
              } else {
                const failure = channelError(
                  new Error('PushMe 发送失败'),
                  'pushme',
                  resp,
                  data && (data.code !== undefined ? data.code : data.error_code || data.errno)
                )
                console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 异常: ${safeErr(failure)}\n`)
                // v3.166：单 key 失败不拖垮整体——多 key（# 分割）一个失效时，
                // 曾外层 reject → 有效 key 已收到但通道整体失败 → 不写缓存 → 每次运行重试 → 有效 key 重复轰炸
                innerResolve({ ok: false, error: failure })
              }
            }
          } catch (e) {
            const failure = channelError(e, 'pushme', resp)
            $.logErr(safeErr(failure))
            innerResolve({ ok: false, error: failure })
          } finally {
            innerResolve({ ok: false })
          }
        })
      })
    })

    // 等待所有推送完成
    // v3.166：至少一个 key 成功 = 通道成功（与 sendNotify allSettled 哲学一致）——全部失败才 reject
    Promise.all(pushPromises).then(results => {
      if (results.some(r => r && r.ok)) resolve()
      else reject(aggregateChannelError('pushme', 'PushMe 全部 key 发送失败', results.map(r => r && r.error)))
    })
  })
}

function qywxBotNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { QYWX_ORIGIN, QYWX_KEY } = push_config
    const options = {
      ...REQUEST_OPTIONS,
      ...requestExtras(params),
      url: `${trimTrailingSlashes(String(QYWX_ORIGIN || 'https://qyapi.weixin.qq.com'))}/cgi-bin/webhook/send?key=${QYWX_KEY}`, // v3.138：去尾斜杠防双斜杠
      json: {
        // v3.127：msgtype 'text' → 'markdown'——desp 是 Markdown 内容，text 模式会显示 ** 等原始符号（企微支持 markdown）
        msgtype: 'markdown',
        markdown: {
          // v3.130：企微 markdown 不支持图片——真实接口 desp 全含 ![]()，剥成 alt 文本（保留粗体/链接等其他语法）
          // v3.139：企微 markdown content 上限约 4096 字节——contentMax=3000 字符(中文 9000 字节)可能超，按字节截断(代理对安全)
          content: truncateBytes(desp ? `${text}\n\n${mdImagesToPlain(String(desp), '(图片)')}` : text, 4096)
        }
      },
      headers: {
        'Content-Type': 'application/json'
      },
      timeout
    }
    if (QYWX_KEY) {
      $.post(options, (err, resp, data) => {
        try {
          if (err) {
            reject(err)
            console.log('企业微信发送通知消息失败😞\n', safeErr(err))
          } else {
            // v3.180：data 判空防御（同 Push+，HTTP 200 + JSON null 曾虚假成功）
            if (data && isCode(data.errcode, 0)) {
              console.log('企业微信发送通知消息成功🎉。\n')
            } else {
              console.log(`企业微信发送通知消息异常 ${data && data.errmsg ? safeErr(data.errmsg) : ''}\n`) // v3.180：errmsg 判空（同 Push+ else 分支）
              // v3.160：API 级失败(errcode≠0) reject——曾静默 resolve 致单通道用户消息丢失
              const failure = channelError(
                new Error(data && data.errmsg ? safeErr(data.errmsg) : '企业微信 发送失败'),
                '企业微信',
                resp,
                data && data.errcode
              )
              reject(failure)
            }
          }
        } catch (e) {
          // 响应结构异常（含 getter 抛错）必须按通道失败处理；否则 finally 的 resolve 会把消息误记为成功。
          reject(e)
          $.logErr(safeErr(e))
        } finally {
          resolve(data)
        }
      })
    } else {
      resolve()
    }
  })
}

// v3.159：wxpusher 内容类型自适应——contentType=3(Markdown) 不渲染 HTML 源码（{Html内容} 模板时内容裸露 <br>/<a href>）
// 含真实 HTML 标签时自动切 contentType=2(HTML 渲染)；标签白名单避免误判 Markdown 的 <https://...> autolink
function looksHtml (s) {
  if (!s || typeof s !== 'string') return false
  // 与主流程 Pusher 的最终出口保持同一口径：不能只识别有限白名单，
  // 否则 input/form 等真实 HTML 会被当 Markdown 原样发送。
  // S8786：原 /<\s*\/?\s*[A-Za-z][A-Za-z0-9-]*(?=\s|\/?>)[^>]*>/i 在大量 "<tag" 且无 ">"
  // 的对抗输入上呈 O(n²) 回溯；改为线性扫描：< → 可选空白/斜杠 → 字母开头标签名 →
  // 名字后须跟空白、> 或 />（排除 <https://...> autolink）→ 其后存在 > 即判定为 HTML。
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) return false
    const k = looksHtmlTagAt(s, lt) // 标签名结束位；-1 表示本处非完整标签
    if (k === -1) { i = lt + 1; continue }
    if (s.includes('>', k)) return true
    return false // 本处起剩余串无 >：完整标签必然需要结束 >，后续不可能再命中
  }
  return false
}

// < 后可选空白/斜杠 → 字母开头标签名 → 名字后跟空白、> 或 />（排除 autolink）→ 其后存在 >
// 返回标签名结束位 k（数字）；本处非完整标签返回 -1（继续找下一个 <）。调用方检查 k 之后
// 是否存在 >：有则命中 HTML，无则剩余串再无 >，可直接判定非 HTML——避免每个 < 位置都对
// 剩余串重复 includes 全扫，回到 O(n²)（S3516：统一返回数字类型，避免 bool/string 混用）
function looksHtmlTagAt (s, lt) {
  const n = s.length
  // \s 语义（含 U+00A0 等 Unicode 空白）——与原 /<\s*.../ 正则口径一致（CodeRabbit 完整审核）
  const isWs = (ch) => /\s/.test(ch)
  const isNameChar = (ch) => /[A-Za-z0-9-]/.test(ch)
  let j = lt + 1
  while (j < n && isWs(s[j])) j++
  if (j < n && s[j] === '/') {
    j++
    while (j < n && isWs(s[j])) j++
  }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1
  let k = j + 1
  while (k < n && isNameChar(s[k])) k++
  const c = k < n ? s[k] : ''
  const nameOk = isWs(c) || c === '>' || (c === '/' && s[k + 1] === '>')
  return nameOk ? k : -1
}

// WxPusher 默认窗口：每个 appToken 单独维护，避免多应用分流时把两个额度混成一个。
const WXPUSHER_WINDOW_MS = 10000
// 服务端窗口存在边界/传输时序误差，留一个请求安全余量，减少真实并发时的 1001 限频响应。
const WXPUSHER_WINDOW_LIMIT = 19
const wxPusherWindows = new Map()
let wxPusherRoundRobin = 0
let wxPusherChannelSignature = ''
let wxPusherSelectionTail = Promise.resolve()
let wxPusherParsedConfigKey = null
let wxPusherParsedChannels = []
// XBK_PROFILE=3 专用：按实际 WxPusher API 尝试聚合统计；默认运行不记录。
const wxPusherProfileStats = new Map()

function parseWxPusherChannels () {
  const configuredRaw = push_config.WX_pusher_channels
  let configKey
  try {
    configKey = JSON.stringify({
      channels: configuredRaw,
      appToken: push_config.WX_pusher_appToken,
      topicIds: push_config.WX_pusher_topicIds
    })
  } catch (e) { configKey = '<unserializable>' }
  if (configKey === wxPusherParsedConfigKey) return wxPusherParsedChannels

  let raw = configuredRaw
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (e) { raw = [] }
  }
  const list = Array.isArray(raw) ? raw : []
  const channels = list.map((item) => {
    if (!item || typeof item !== 'object') return null
    const appToken = safeString(item.appToken || item.app_token || item.WX_pusher_appToken).trim()
    const topicIds = safeString(item.topicIds || item.topic_ids || item.WX_pusher_topicIds)
      .split(',').map(s => s.trim()).filter(Boolean)
    return appToken && topicIds.length ? { appToken, topicIds } : null
  }).filter(Boolean)
  if (channels.length) {
    wxPusherParsedConfigKey = configKey
    wxPusherParsedChannels = channels
    return channels
  }
  const appToken = safeString(push_config.WX_pusher_appToken).trim()
  const topicIds = safeString(push_config.WX_pusher_topicIds).split(',').map(s => s.trim()).filter(Boolean)
  // 兼容旧测试/配置：历史实现允许只填 appToken，topicIds 为空时仍按 API 请求发送。
  wxPusherParsedConfigKey = configKey
  wxPusherParsedChannels = appToken ? [{ appToken, topicIds }] : []
  return wxPusherParsedChannels
}

function hasWxPusherConfigured () {
  return parseWxPusherChannels().length > 0
}

function wxPusherChannelKey (channel) {
  // 限频按 appToken 归属；同一应用配置多个主题时不能错误地各算一份额度。
  return channel.appToken
}

function wxPusherWindow (channel) {
  const key = wxPusherChannelKey(channel)
  let timestamps = wxPusherWindows.get(key)
  if (!timestamps) { timestamps = []; wxPusherWindows.set(key, timestamps) }
  return timestamps
}

async function reserveWxPusherOrder (channels) {
  let release
  const previous = wxPusherSelectionTail
  wxPusherSelectionTail = new Promise(resolve => { release = resolve })
  await previous
  try {
    const start = wxPusherRoundRobin
    wxPusherRoundRobin = (start + 1) % channels.length
    return channels.map((_, i) => channels[(start + i) % channels.length])
  } finally {
    release()
  }
}

function waitWithAbort (ms, signal) {
  return new Promise((resolve, reject) => {
    let timer // eslint-disable-line prefer-const -- 声明与赋值分离（setTimeout 回填），let 语义清晰
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const onAbort = () => {
      cleanup()
      const error = new Error('WxPusher 限频等待已取消')
      error.code = 'ABORT_ERR'
      reject(error)
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function acquireWxPusherSlot (channels, tried, signal = null) {
  for (;;) {
    if (signal && signal.aborted) {
      const error = new Error('WxPusher 限频等待已取消')
      error.code = 'ABORT_ERR'
      throw error
    }
    const now = Date.now()
    let nextRelease = Infinity
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i]
      if (tried.has(wxPusherChannelKey(channel))) continue
      const timestamps = wxPusherWindow(channel)
      while (timestamps.length && timestamps[0] <= now - WXPUSHER_WINDOW_MS) timestamps.shift()
      if (timestamps.length < WXPUSHER_WINDOW_LIMIT) {
        timestamps.push(now)
        return channel
      }
      nextRelease = Math.min(nextRelease, timestamps[0] + WXPUSHER_WINDOW_MS)
    }
    // 所有未尝试应用都满窗时再等最早释放；若只有已尝试应用，交给调用方结束重试。
    if (!Number.isFinite(nextRelease)) return null
    await waitWithAbort(Math.max(20, nextRelease - now + 10), signal)
  }
}

function wxPusherRateLimited (err) {
  if (err && (err.code === 1001 || err.code === '1001')) return true
  const text = safeString(err && err.message ? err.message : err)
  return /1001|速度太快|10秒内访问超过20次|限流|限频/i.test(text)
}

function wxPusherProfileStat (channel, outcome) {
  if (process.env.XBK_PROFILE !== '3') return
  const key = safeString(channel.appToken)
  let stat = wxPusherProfileStats.get(key)
  if (!stat) {
    stat = { app: `***${key.slice(-4)}`, attempts: 0, success: 0, failed: 0, rateLimited: 0, networkError: 0, apiError: 0 }
    wxPusherProfileStats.set(key, stat)
  }
  stat.attempts++
  if (outcome === 'success') stat.success++
  else {
    stat.failed++
    if (outcome === 'rate_limited') stat.rateLimited++
    else if (outcome === 'network_error') stat.networkError++
    else stat.apiError++
  }
}

function getWxPusherProfileSummary () {
  if (process.env.XBK_PROFILE !== '3') return []
  return [...wxPusherProfileStats.values()].map(stat => ({ ...stat }))
}

function printWxPusherProfileSummary () {
  if (process.env.XBK_PROFILE !== '3' || wxPusherProfileStats.size === 0) return
  const summary = getWxPusherProfileSummary()
  console.log('  [profile wxpusher summary]')
  for (const stat of summary) {
    console.log(`    app=${stat.app} attempts=${stat.attempts} success=${stat.success} failed=${stat.failed} rateLimited=${stat.rateLimited} networkError=${stat.networkError} apiError=${stat.apiError}`)
  }
}

function wxPusherProfile (channel, outcome, started, timings) {
  if (process.env.XBK_PROFILE !== '2' && process.env.XBK_PROFILE !== '3') return
  wxPusherProfileStat(channel, outcome)
  const elapsedMs = Date.now() - started
  console.log(`[profile wxpusher] app=***${safeString(channel.appToken).slice(-4)} outcome=${outcome} elapsedMs=${elapsedMs}`)
  if (timings && timings.phases) {
    const p = timings.phases
    console.log(`[profile wxpusher timing] app=***${safeString(channel.appToken).slice(-4)} wait=${profileMs(p.wait)} dns=${profileMs(p.dns)} tcp=${profileMs(p.tcp)} tls=${profileMs(p.tls)} request=${profileMs(p.request)} firstByte=${profileMs(p.firstByte)} download=${profileMs(p.download)} total=${profileMs(p.total)}`)
  }
}

// v3.262：把 wxpusher 业务失败转成带 providerCode/channel 的通道错误（failure_policy 的
// wxpusher 专用分支才不是死代码）。独立成函数：回调只负责分发，同时压住回调认知复杂度。
function wxPusherBusinessError (data) {
  const sourceErr = new Error(data?.msg ? safeErr(data.msg) : 'wxpusher 发送失败')
  // 保留结构化业务码：限频响应可能没有 msg，不能只靠错误文本判断是否切换备用应用。
  if (data?.code != null) sourceErr.code = data.code
  return channelError(sourceErr, 'wxpusher', null, sourceErr.code ? String(sourceErr.code) : '')
}

function wxPusherPost (channel, text, desp, params = {}) {
  const started = Date.now()
  if (process.env.XBK_PROFILE === '2' || process.env.XBK_PROFILE === '3') console.log(`[profile wxpusher] app=***${safeString(channel.appToken).slice(-4)} outcome=start`)
  return new Promise((resolve, reject) => {
    const options = {
      ...REQUEST_OPTIONS,
      ...requestExtras(params),
      url: 'https://wxpusher.zjiecode.com/api/send/message',
      json: {
        appToken: channel.appToken,
        content: desp,
        summary: safeSlice(text, 90),
        // v3.159：内容含 HTML 标签时用 contentType=2（HTML 渲染）——Markdown(3) 会把 <br>/<a> 当纯文本裸露
        contentType: looksHtml(desp) ? 2 : 3, // 1文字 2HTML 3Markdown
        topicIds: channel.topicIds
      },
      headers: { 'Content-Type': 'application/json' },
      timeout
    }
    $.post(options, (err, resp, data, timings) => {
      try {
        if (err) {
          wxPusherProfile(channel, 'network_error', started, timings)
          console.log('WxPusher发送通知消息失败😞\n', safeErr(err))
          reject(err)
        } else if (data && isCode(data.code, 1000)) {
          wxPusherProfile(channel, 'success', started, timings)
          console.log('WxPusher发送通知消息成功🎉。\n')
          resolve(data)
        } else {
          const outcome = data && isCode(data.code, 1001) ? 'rate_limited' : 'api_error'
          wxPusherProfile(channel, outcome, started, timings)
          console.log('WxPusher发送通知消息异常\n')
          console.log(safeErr(data))
          reject(wxPusherBusinessError(data))
        }
      } catch (e) {
        reject(e)
        $.logErr(safeErr(e))
      }
    })
  })
}

async function wxPusherNotify (text, desp, params = {}) {
  const channels = parseWxPusherChannels()
  if (!channels.length) return
  const signature = channels.map(channel => `${channel.appToken}\0${channel.topicIds.join(',')}`).join('\n')
  if (signature !== wxPusherChannelSignature) {
    wxPusherChannelSignature = signature
    wxPusherRoundRobin = 0
  }
  let lastErr
  const tried = new Set()
  // 每条消息只选一个主题；只有明确收到限频拒绝时才换下一个应用重试，避免重复通知。
  const ordered = await reserveWxPusherOrder(channels)
  const signal = params && params.signal ? params.signal : null
  for (let attempt = 0; attempt < channels.length; attempt++) {
    const selected = await acquireWxPusherSlot(ordered, tried, signal)
    if (!selected) break
    tried.add(wxPusherChannelKey(selected))
    try {
      await wxPusherPost(selected, text, desp, params)
      return
    } catch (e) {
      lastErr = e
      if (!wxPusherRateLimited(e)) throw e
    }
  }
  throw lastErr || new Error('wxpusher 发送失败')
}

function wxXiZhiNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { WX_XIZHI_KEY } =
            push_config

    const options = {
      ...REQUEST_OPTIONS,
      ...requestExtras(params),
      url: WX_XIZHI_KEY,
      json: {
        title: text,
        content: desp
      },
      headers: {
        'Content-Type': 'application/json'
      },
      timeout
    }

    if (WX_XIZHI_KEY) {
      $.post(options, (err, resp, data) => {
        try {
          if (err) {
            reject(err)
            console.log('息知发送通知消息失败😞\n', safeErr(err))
          } else {
            // v3.180：data 判空防御（同 Push+，HTTP 200 + JSON null 曾虚假成功）
            if (data && isCode(data.code, 200)) {
              console.log('息知发送通知消息成功🎉。\n')
            } else {
              console.log('息知发送通知消息异常 \n')
              // 打印响应摘要（不打印完整对象——异常响应可能回显请求参数）
              console.log(safeErr(data))
              // v3.160：API 级失败(code≠200) reject——曾静默 resolve 致单通道用户消息永久丢失
              const failure = channelError(
                new Error(data && data.msg ? safeErr(data.msg) : '息知 发送失败'),
                '息知',
                resp,
                data && (data.code !== undefined ? data.code : data.errcode)
              )
              reject(failure)
            }
          }
        } catch (e) {
          // 响应结构异常（含 getter 抛错）必须按通道失败处理；否则 finally 的 resolve 会把消息误记为成功。
          reject(e)
          $.logErr(safeErr(e))
        } finally {
          resolve(data)
        }
      })
    } else {
      resolve()
    }
  })
}

function pushDeerNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { DEER_KEY, DEER_URL } = push_config
    if (DEER_KEY) {
      // PushDeer 建议对消息内容进行 urlencode（encodeURI 不编码 & = #，需 encodeURIComponent）
      const enc = (s) => encodeURIComponent(s)
      const options = {
        ...REQUEST_OPTIONS,
        ...requestExtras(params),
        url: DEER_URL || 'https://api2.pushdeer.com/message/push',
        body: `pushkey=${enc(DEER_KEY)}&text=${enc(text)}&desp=${enc(desp)}&type=markdown`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout
      }
      $.post(options, (err, resp, data) => {
        try {
          if (err) {
            reject(err)
            console.log('PushDeer 通知调用API失败😞\n', safeErr(err))
          } else {
            // 通过返回的result的长度来判断是否成功（响应防御：异常时可能缺 content/result 字段）
            if (
              data && data.content && data.content.result &&
                            data.content.result.length !== undefined &&
                            data.content.result.length > 0
            ) {
              console.log('PushDeer 发送通知消息成功🎉\n')
            } else {
              console.log(
                                `PushDeer 发送通知消息异常😞 ${safeErr(data)}\n`
              )
              // v3.160：API 级失败(result 空) reject——曾静默 resolve 致单通道用户消息丢失
              const failure = channelError(
                new Error('PushDeer 发送失败'),
                'pushdeer',
                resp,
                data && (data.code !== undefined ? data.code : data.error_code || data.errno)
              )
              reject(failure)
            }
          }
        } catch (e) {
          // 响应结构异常（含 getter 抛错）必须按通道失败处理；否则 finally 的 resolve 会把消息误记为成功。
          reject(e)
          $.logErr(safeErr(e))
        } finally {
          resolve(data)
        }
      })
    } else {
      resolve()
    }
  })
}

// 模块级：TG_PROXY 未实现警告只提示一次（防每次推送刷屏）
let tgProxyWarned = false

function tgNotify (text, desp, params = {}) {
  return new Promise((resolve, reject) => {
    const { TG_BOT_TOKEN, TG_USER_ID, TG_API_HOST } = push_config
    // TG_PROXY_* 保留配置项：当前项目未接入 HTTP 代理（v3.76 一次性警告防误配静默失效）
    if (!tgProxyWarned && (push_config.TG_PROXY_HOST || push_config.TG_PROXY_PORT)) {
      tgProxyWarned = true
      console.warn('⚠️ 配置了 TG_PROXY_HOST/PORT，但当前项目未接入 HTTP 代理，该配置不生效；需要代理请改用 TG_API_HOST 指向代理网关')
    }
    if (TG_BOT_TOKEN && TG_USER_ID) {
      // v3.132：parse_mode 'Markdown' → 'HTML'——真实接口 20 条中 19 条含 markdown 特殊字符、
      // 1 条含未配对 *（TG Markdown 对未配对 * 报错发送失败）；改 HTML 模式 + 剥 markdown 符号
      // + 转义 & < >（HTML 只对这 3 个敏感，无报错、无乱码，纯文本显示）
      const tgText = mdToPlain(text, false)
      const tgDesp = mdToPlain(desp, false) // v3.136：TG 保留 < >（HTML 转义），不剥 autolink
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // v3.139：TG 消息上限 4096 字符——内容超长截断（v3.178：统一 safeSlice——曾内联只处理
      // 高代理，孤立低代理/ZWJ/VS16 会残留乱码；§12-4 重复实现收敛）
      const tgFull = esc(tgDesp ? `${tgText}\n\n${tgDesp}` : tgText)
      const tgSafe = tgFull.length > 4000 ? safeSlice(tgFull, 4000) : tgFull
      const options = {
        ...REQUEST_OPTIONS,
        ...requestExtras(params),
        url: `${trimTrailingSlashes(String(TG_API_HOST || 'https://api.telegram.org'))}/bot${TG_BOT_TOKEN}/sendMessage`, // v3.138：去尾斜杠防双斜杠
        json: {
          chat_id: TG_USER_ID,
          text: tgSafe,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        },
        headers: {
          'Content-Type': 'application/json'
        },
        timeout
      }
      $.post(options, (err, resp, data) => {
        try {
          if (err) {
            reject(err)
            console.log('Telegram 发送通知消息失败😞\n', safeErr(err))
          } else {
            if (data && data.ok === true) {
              console.log('Telegram 发送通知消息成功🎉\n')
            } else {
              console.log(`Telegram 发送通知消息异常 ${safeErr(data)}\n`)
              // v3.160：API 级失败(ok≠true) reject——曾静默 resolve 致单通道用户消息丢失
              const failure = channelError(
                new Error(data && data.description ? safeErr(data.description) : 'Telegram 发送失败'),
                'telegram',
                resp,
                data && data.error_code
              )
              reject(failure)
            }
          }
        } catch (e) {
          // 响应结构异常（含 getter 抛错）必须按通道失败处理；否则 finally 的 resolve 会把消息误记为成功。
          reject(e)
          $.logErr(safeErr(e))
        } finally {
          resolve(data)
        }
      })
    } else {
      resolve()
    }
  })
}

// 按 UTF-8 字节截断（v3.139：企微 markdown content 4096 字节上限；代理对安全——末尾高代理退一位）
function truncateBytes (s, maxBytes) {
  const str = String(s === undefined || s === null ? '' : s)
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str
  let cut = str.slice(0, maxBytes) // 近似（UTF-8 多字节可能超）
  while (Buffer.byteLength(cut, 'utf8') > maxBytes) cut = cut.slice(0, -1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1) // 高代理退位
  return cut
}

// markdown → 纯文本（v3.128：Bark/Push+ 不支持 markdown 渲染，desp 会显示 ** 等原始符号）
// v3.136：剥 <url> autolink 尖括号（stripAngle 默认 true）；TG 传 false（保留 < > 给 HTML 转义）
// v3.149：HTML 标签（含属性）整体剥空——{Html内容} 模板产物曾残留 'a href="..." target="_blank"' 垃圾文本；
// S8786：原 /\[([^\]]+)\]\(([^)]+)\)/ 在大量未配对 "[" 上呈 O(n²) 回溯；线性扫描等价替换：
// [text](url) → text (url)（text===url 原文链接只显示一次；text/url 空或未闭合保持原样）
// 注意：失败路径必须推进或终止——`[text](` 后无 ")" 时剩余串不可能再有完整链接，直接保留
// 剩余并终止；若每块只推进到 "]" 就重扫 indexOf(')')，大量未闭合块会退化为 O(n²)（v3.264 修复）。
function mdLinksToPlain (s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('[', i)
    if (open === -1) { out += s.slice(i); break }
    const close = s.indexOf(']', open + 1)
    if (close === -1) { out += s.slice(i); break } // 未闭合 ]：剩余不可能再有完整链接
    const t = s.slice(open + 1, close)
    if (t === '' || s[close + 1] !== '(') { out += s.slice(i, close + 1); i = close + 1; continue }
    const end = s.indexOf(')', close + 2)
    if (end === -1) { out += s.slice(i); break } // 未闭合 )：剩余串无 ")"，不可能再有完整 [text](url)
    const u = s.slice(close + 2, end)
    if (u === '') { out += s.slice(i, end + 1); i = end + 1; continue } // url 空：原样保留
    out += s.slice(i, open) + (t === u ? t : `${t} (${u})`)
    i = end + 1
  }
  return out
}

// 线性剥离 Markdown 图片语法：![alt](url) → alt（url 至少 1 字符才成立；未闭合 ]/) 保持原样）。
// 替代原 /!\[([^\]]*)\]\(([^)]+)\)/ 替换——该正则在大量未配对 "![" 上 O(n²) 回溯（v3.264 修复）。
// emptyAlt：alt 为空时的替换文本（企微用 '(图片)'，mdToPlain 用 ''）
function mdImagesToPlain (s, emptyAlt = '') {
  let out = ''
  let i = 0
  while (i < s.length) {
    const bang = s.indexOf('![', i)
    if (bang === -1) { out += s.slice(i); break }
    const close = s.indexOf(']', bang + 2)
    if (close === -1) { out += s.slice(i); break } // 未闭合 ]：剩余不可能再有完整图片语法
    const alt = s.slice(bang + 2, close)
    if (s[close + 1] !== '(') { out += s.slice(i, close + 1); i = close + 1; continue }
    const end = s.indexOf(')', close + 2)
    if (end === -1) { out += s.slice(i); break } // 未闭合 )：剩余串无 ")"，不可能再有完整图片语法
    const u = s.slice(close + 2, end)
    if (u === '') { out += s.slice(i, end + 1); i = end + 1; continue } // url 空：原样保留
    out += s.slice(i, bang) + (alt === '' ? emptyAlt : alt)
    i = end + 1
  }
  return out
}

// S8786：原 /<([^>]+)>/ 在无 ">" 的对抗输入上呈 O(n²) 回溯；线性扫描等价替换：
// stripAngle=true 时剥掉 HTML 标签、<url> autolink 保留内容；false 时（TG）整体保留
function stripAngleTags (s, stripAngle) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { out += s.slice(i); break }
    const gt = s.indexOf('>', lt + 1)
    if (gt === -1) { out += s.slice(i); break }
    const inner = s.slice(lt + 1, gt)
    if (!stripAngle || inner === '') { out += s.slice(i, gt + 1); i = gt + 1; continue }
    const t = inner.trim()
    out += s.slice(i, lt) + (/^https?:(\/\/)?/i.test(t) ? t : '')
    i = gt + 1
  }
  return out
}

//          <url> autolink（http 开头）保留内容；&nbsp; 等实体解码为空格
function mdToPlain (s, stripAngle = true) {
  let out = String(s === undefined || s === null ? '' : s)
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **粗体** → 粗体
    .replace(/(?<![0-9])\*([^*\n]+?)(?<![0-9])\*(?!\*)/g, '$1') // *斜体* → 斜体（v3.150：数字前后 * 不算斜体——'5*3*2cm' 曾误剥成 '532cm'）
  out = mdImagesToPlain(out) // ![alt](url) → alt（v3.264：原正则大量未配对 ![ 上 O(n²)，改线性）
  out = mdLinksToPlain(out) // [text](url) → text (url)；v3.153：text===url(原文链接) 只显示一次
  return stripAngleTags(
    out
      .replace(/^#{1,6}\s+/gm, '') // # 标题
      .replace(/`([^`]+)`/g, '$1'), // `代码` → 代码
    stripAngle
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&') // & 最后解码：防 &amp;lt; 二次解码成 <（CodeQL js/double-escaping）
}

// 孤立代理清洗（v3.110）：encodeURIComponent 对孤立代理抛 URIError——推送前统一处理
function cleanSurrogates (s) {
  try { s = String(s === undefined || s === null ? '' : s) } catch (e) { return '' }
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

async function sendNotify (text, desp, params = {}) {
  // v3.110：入口统一清洗孤立代理（encodeURIComponent 对孤立代理抛 URIError → 通道发送失败）
  text = cleanSurrogates(text)
  desp = cleanSurrogates(desp)
  // 通道配置检查：一个都没配 → 拒绝（避免"静默成功"让主流程以为推送完成并写缓存）
  // 注意：这里必须与下方 Promise.all 实际调用的通道一一对应，漏一个就会让已配置的通道静默失效。
  // 分隔型配置（Bark/PushMe）还要排除只有分隔符/空白的值，否则通道函数会无请求地 resolve，
  // configuredFlags 又把它计为已配置，最终出现「无实际设备却虚假成功」的 P1。
  const nonEmpty = (v) => {
    if (!v) return false
    try { return String(v).trim() !== '' } catch (e) { return false }
  }
  const delimitedNonEmpty = (v) => {
    if (!v) return false
    try { return String(v).split('#').some(s => s.trim() !== '') } catch (e) { return false }
  }
  const configuredFlags = [
    nonEmpty(push_config.PUSH_PLUS_TOKEN), nonEmpty(push_config.PUSH_KEY), delimitedNonEmpty(push_config.BARK_PUSH),
    nonEmpty(push_config.QYWX_KEY), parseWxPusherChannels().length > 0, nonEmpty(push_config.WX_XIZHI_KEY),
    nonEmpty(push_config.DEER_KEY), delimitedNonEmpty(push_config.PUSHME_KEY),
    nonEmpty(push_config.TG_BOT_TOKEN) && nonEmpty(push_config.TG_USER_ID)
  ]
  if (!configuredFlags.some(Boolean)) {
    const error = new Error('未配置任何推送通道（Push+/Server酱/Bark/企业微信/wxpusher/息知/PushDeer/PushMe/Telegram）')
    error.code = 'NO_CHANNEL_CONFIG'
    throw error
  }
  // 一言开关按显式 true 开启；false/0/空值及其他非法值均关闭，兼容环境变量字符串。
  // 旧逻辑仅排除字符串 'false'，导致 HITOKOTO=0/'0'/undefined 时仍请求一言并额外增加延迟。
  const hitokotoEnabled = push_config.HITOKOTO === true ||
        (typeof push_config.HITOKOTO === 'string' && push_config.HITOKOTO.toLowerCase() === 'true')
  if (hitokotoEnabled) {
    if (typeof one === 'function') {
      try { desp += '\n\n' + (await one()) } catch (e) { console.log('一言获取失败，跳过:', e && e.message ? e.message : String(e)) }
    }
  }
  // 只启动已配置通道：未配置通道原本虽会立即 resolve，但每条消息仍会创建函数/Promise/对象。
  // 保持数组顺序与 configuredFlags 一致，便于失败统计和后续扩展。
  const channelTasks = [
    [configuredFlags[0], 'pushplus', () => pushPlusNotify(text, desp, params)],
    [configuredFlags[1], 'server酱', () => serverNotify(text, desp, params)],
    [configuredFlags[2], 'bark', () => barkNotify(text, desp, params)],
    [configuredFlags[3], '企业微信', () => qywxBotNotify(text, desp, params)],
    [configuredFlags[4], 'wxpusher', () => wxPusherNotify(text, desp, params)],
    [configuredFlags[5], '息知', () => wxXiZhiNotify(text, desp, params)],
    [configuredFlags[6], 'pushdeer', () => pushDeerNotify(text, desp, params)],
    [configuredFlags[7], 'pushme', () => pushMeNotify(text, desp, params)],
    [configuredFlags[8], 'telegram', () => tgNotify(text, desp, params)]
  ]
  const enabledTasks = channelTasks.filter(([enabled]) => enabled)
  const results = await Promise.allSettled(
    enabledTasks.map(([, , task]) => task())
  )
  results.forEach((result, index) => {
    if (result.status === 'rejected' && result.reason && typeof result.reason === 'object' &&
            !result.reason.channel) {
      try { result.reason.channel = enabledTasks[index][1] } catch (e) { /* 只读错误对象不影响失败结果 */ }
    }
  })
  const attempted = results
  const okCount = attempted.filter(r => r.status === 'fulfilled').length
  if (attempted.length > 0 && okCount === 0) {
    const failures = attempted
      .filter(r => r.status === 'rejected')
      .map(r => r.reason)
      .filter(Boolean)
    const reasons = failures.map(reason => reason && reason.message ? reason.message : String(reason || '')).filter(Boolean).join('; ')
    const error = new Error('所有推送通道失败: ' + reasons.slice(0, 200))
    error.code = 'ALL_CHANNELS_FAILED'
    error.failures = failures
    throw error
  }
}

module.exports = { sendNotify, push_config, hasWxPusherConfigured, maskKey, maskUrl, safeSlice, safeErr, getWxPusherProfileSummary, printWxPusherProfileSummary, mdLinksToPlain, mdImagesToPlain, mdToPlain, looksHtml, stripAngleTags }
