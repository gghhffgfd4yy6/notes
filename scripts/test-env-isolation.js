'use strict'
// 测试侧环境隔离（backlog C3-002）：把外部部署开关 XBK_CACHE_DIR 挡在测试进程之外。
//
// 背景与边界：
//   · 生产契约**不变**——`xbk_message_store.cacheDir` 仍无条件采纳绝对 XBK_CACHE_DIR（含项目根外
//     路径）并跳过根内校验，这是 SYSTEM_CONTRACT「缓存目录」一条明写的三方同源契约（读 / 写 /
//     控制台必须解析到同一目录）。本模块**只**处理测试侧。
//   · 真实缺陷在测试入口：run_tests.js / run_unit_tests.js 派生子进程时不传 env（继承 shell），
//     全仓也没有任何一处删除该变量 ⇒ 在 export 过它的 shell 里跑测试，夹具会写进**部署缓存目录**
//     并把真实 push.json 判重主存覆盖掉（test_filter / test_app / 本组 F1 夹具都按
//     Config.cache.dir 隔离，而 env 优先级更高，隔离当场失效）。
//
// 用法（两类，口径一致）：
//   · 测试入口：`stripCacheDirEnv(process.env)` 得到剥离后的 env 交给 spawn/exec，绝不改父进程环境；
//   · 套件夹具：`isolateProcessCacheDirEnv()` 在**加载期**（早于任何 Config.cache.dir 赋值与首次
//     写盘）清掉 process.env 中的该变量，并响亮提示一次。
const CACHE_DIR_ENV = 'XBK_CACHE_DIR'

// 返回 { env, cleared }：env 是入参的浅拷贝（**不原地修改**，调用方可能传 process.env），
// cleared 是被清除的原值（未设置/空串时为 ''），供入口打印一次性提示。
function stripCacheDirEnv (env = process.env) {
  const next = { ...(env || {}) }
  const raw = typeof next[CACHE_DIR_ENV] === 'string' ? next[CACHE_DIR_ENV] : ''
  delete next[CACHE_DIR_ENV]
  return { env: next, cleared: raw }
}

// 直接在 process.env 上清除（仅供套件夹具加载期调用）。返回被清除的原值（无则 ''）。
// opts.log 可注入（测试用），默认 console.warn —— 静默清除会让「带 env 跑测试」变成不可见的
// 行为差异，排障时必须能一眼看到「这次运行的缓存目录与 shell 里设的不一样」。
function isolateProcessCacheDirEnv (opts = {}) {
  const log = opts && typeof opts.log === 'function' ? opts.log : console.warn
  const raw = typeof process.env[CACHE_DIR_ENV] === 'string' ? process.env[CACHE_DIR_ENV] : ''
  if (CACHE_DIR_ENV in process.env) delete process.env[CACHE_DIR_ENV]
  if (raw) {
    log(`⚠️ 测试夹具已忽略外部 XBK_CACHE_DIR（${raw}）：一律使用 Config.cache.dir 指向的私有目录，绝不写部署缓存`)
  }
  return raw
}

module.exports = { CACHE_DIR_ENV, stripCacheDirEnv, isolateProcessCacheDirEnv }
