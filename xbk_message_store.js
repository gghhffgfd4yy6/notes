/* eslint no-control-regex: off */ // 控制字符正则用于路径清洗

'use strict'

// 缓存目录解析：项目根内校验 + 多级兜底。**生产 getter 与青龙 `--status` 命令共用本实现**（QX-08）：
// `--status` 此前把默认目录硬编码成 path.join(ROOT, 'xianbaoku_cache')，于是生产会拒绝并回退的目录
// （被普通文件占位、realpath 逃出根目录、已存在层级不是目录）仍被照读——状态其实写在备用目录时
// `--status` 静默报「缺失」。抽成无副作用函数后两侧口径恒等；fs/path 由调用方注入，本模块因此
// 不 require 任何模块，`--status` 复用它**不需要**加载 got/re2，原设计（缺依赖也能诊断）不受影响。
function resolveCacheDirInRoot ({ fs, path, root, raw, fallback }) {
  const candidate = path.resolve(root, raw)
  const realInsideRoot = (p) => {
    const lexicalInside = p !== root && p.startsWith(root + path.sep)
    if (!lexicalInside) return false
    // 逐级回溯到已存在目录，再 realpath 校验；防止项目内符号链接指向项目外部。
    let probe = p
    try {
      while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe)
      // 已存在的路径层级必须是目录；否则 cache.dir 指向普通文件时，
      // 后续拼接缓存文件会得到 ENOTDIR，而校验却错误放行。
      if (!fs.lstatSync(probe).isDirectory()) return false
      const realProbe = fs.realpathSync(probe)
      const resolved = path.resolve(realProbe, path.relative(probe, p))
      return resolved !== root && resolved.startsWith(root + path.sep)
    } catch (e) {
      return false
    }
  }
  // P2 防御：cache.dir 不能通过 ..、绝对路径或符号链接逃出项目根目录；越界配置回退默认目录。
  if (realInsideRoot(candidate)) return candidate
  const safeFallback = path.resolve(root, fallback)
  if (realInsideRoot(safeFallback)) return safeFallback
  // 默认目录本身若被替换成外部符号链接，也不能原样返回；使用项目根内的应急目录。
  const emergencyFallback = path.join(root, '.xbk_cache_safe')
  // C022：应急目录同样校验 realpath；被替换成外部符号链接时不能原样返回。
  if (realInsideRoot(emergencyFallback)) return emergencyFallback
  // 校验失败回退到根目录下唯一安全路径（固定新目录名，不跟随外部符号链接）。
  // P2（审查 2026-08-15）：最末兜底目录同样校验 realpath——若该固定名已存在且被替换为
  // 指向项目外的符号链接，写入会逃出根目录（前两级候选均先过 realInsideRoot，唯独此级曾直接返回）。
  const internalFallback = path.join(root, '.xbk_cache_safe_internal')
  if (realInsideRoot(internalFallback)) return internalFallback
  // 所有候选目录（含应急目录）均不可用：说明项目根目录层级已被外部符号链接劫持，
  // 继续返回任意路径都会逃出根目录——显式抛错，由 init()/App.run 的 try/catch 暴露，禁止静默写穿。
  throw new Error('缓存目录安全检查失败：所有候选目录（含 .xbk_cache_safe_internal）均不可用，可能被符号链接劫持')
}

// F-02 残留闭合（R6）：稳态未命中路径的**有界**自愈抽查（实现见 MessageStore._probeIndexMiss）。
// 索引的 O(1) 失效检查只看「引用 / 长度 / 首元素引用」，调用方**在原地**改写非首元素它看不见：
// 「每个数组版本首次未命中重建一次」只覆盖那一刻，之后再原地写入的新身份会永久查不到
// （missVerified 粘滞，R6 实测 `has()` 恒定 false 且不再自愈）。故未命中路径补两条旋转抽查窗：
//   · 引用层宽窗（纯指针比较，~ns/位置）：原位换成**另一个元素对象**——V6/W2 反例的主要形态，
//     新身份在索引里根本没有下标；宽窗几乎不花钱，自愈上界 ceil(n/REF_WINDOW) 次未命中。
//   · 身份层窄窗（每个位置要重算 getMessageIdentity，~µs/位置）：同一对象上改 id/url 字段
//     （引用不变）；窄窗宽度直接决定每次未命中的额外代价，自愈上界 ceil(n/IDENTITY_WINDOW)。
// 两条窗都是 O(1) 位置数，不做 O(n) 全表扫描——「每次未命中都全量复检」实测把热路径打成 O(n²)。
const IDENTITY_INDEX_REF_PROBE_WINDOW = 32
const IDENTITY_INDEX_IDENTITY_PROBE_WINDOW = 2
// n 不超过该阈值时两条窗都覆盖全表：抽查等价于全量复检，**首次未命中即精确**（测试与真实缓存的小
// 数组都落在这里），代价上界 8 个位置；更大的数组才退回固定窗口（代价与 n 无关，有界自愈）。
const IDENTITY_INDEX_PROBE_FULL_MAX = 8

// 💾 MessageStore — 缓存管理层（从 xbk_function_v3.js 独立准备，暂不接入主入口）
// 依赖全部由组合根注入；不反向 require 主入口，不复制共享单例。
function createMessageStore ({
  Config,
  Utils,
  fs,
  path,
  crypto,
  normalize,
  storage,
  constants
}) {
  const tokenMatches = (actual, expected) => {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false
    const actualBytes = Buffer.from(actual, 'utf8')
    const expectedBytes = Buffer.from(expected, 'utf8')
    if (actualBytes.length !== expectedBytes.length) return false
    try { return typeof crypto?.timingSafeEqual === 'function' && crypto.timingSafeEqual(actualBytes, expectedBytes) } catch (e) { return false }
  }

  const { readSafeTextResult, writeAtomic, writeAtomicIfAbsent } = storage
  const {
    DEFAULT_MAX_SIZE,
    MESSAGE_CACHE_MAX_BYTES,
    TOMBSTONE_MAX_KEYS,
    TOMBSTONE_MAX_BYTES,
    TOMBSTONE_LOCK_STALE_MS
  } = constants

  const MessageStore = {
  // v3.172：cache.dir 非法回退时支持并行 worker 隔离（test_app_parallel 用 XBK_PARALLEL_ID 分片，
  // 回退硬编码 'xianbaoku_cache' 会让 t51 等非法配置测试撞共享目录竞态）
    get cacheDir () {
      const fallback = process.env.XBK_PARALLEL_ID ? `xianbaoku_cache_p${process.env.XBK_PARALLEL_ID}` : 'xianbaoku_cache'
      const raw = typeof Config.cache.dir === 'string' && Config.cache.dir ? Config.cache.dir : fallback
      // P2/P3/C022 的根内校验与多级兜底统一实现于模块顶部的 resolveCacheDirInRoot；
      // 青龙 `--status` 复用同一函数（QX-08），两侧口径不再各写一份。
      return resolveCacheDirInRoot({ fs, path, root: path.resolve(__dirname), raw, fallback })
    },
    _memoryCache: {},
    // 内存缓存实际键数（与 _memoryCache 同步维护，替代热路径上每次新键写都 Object.keys O(n)）
    _memoCount: 0,
    // 身份索引缓存：WeakMap 按“权威内存缓存数组引用”绑定预计算身份索引，批量 has 判重 O(1)，
    // 避免对同一文件反复线性扫描；权威数组每次变更都是新对象引用（_memoSet 全量替换），
    // 数组被 GC 回收时索引随之自动释放，无需手动失效。
    _identityIndex: new WeakMap(),
    // 判重身份墓碑（按缓存文件路径）：字节/条数裁剪丢弃记录的紧凑身份键（Map 保插入序，
    // 超 TOMBSTONE_MAX_KEYS 丢最旧）。主判重闸门与 has/save/saveBatch 统一并入查询，
    // 防上游重放被裁记录时重复推送；过滤未推（_f）记录不落墓碑，规则改宽后仍可重新评估。
    // P3（审查 2026-09-15）键上限口径：下方 _tombstones/_tombstoneLoaded/_readFailed/_verified
    // 均以「缓存文件路径」为键，条目数由 pushUrl 集合规模决定（单实例部署下规模稳定，磁盘缓存
    // 为权威且可重建），与 _MEMO_MAX 覆盖的内存快照数组不是同一维度，故当前不加 LRU/键上限；
    // 若未来 pushUrl 数量级增长，需按与 _MEMO_MAX 同口径补键上限（本注释锁定该判定）。
    _tombstones: new Map(),
    _tombstoneLoaded: new Set(),
    // 墓碑最近一次读盘结果（按缓存文件路径）：仅用于区分「确认缺失」与「读取失败」，
    // 决定 _tombstoneLoaded 是否置位（missing/ok 置位，其余保留重试窗口）。
    _tombstoneLoadStatus: {},
    // 内存缓存 key 上限（防御：pushUrl 变化等场景下防止无限增长泄漏；磁盘缓存为权威可重建）
    _MEMO_MAX: 100,
    // 磁盘读取失败标记（按缓存文件路径记录）：ioError/unsafe 读取失败时置位，
    // 供 save 等写入口保守处理——不基于“未读到的空数组”全量覆写磁盘，避免覆盖丢失存量。
    _readFailed: {},
    // 磁盘已验证标记（按缓存文件路径记录）：内存命中时是否已对该文件做过一次 existsSync+恢复检查。
    // 消除热路径上每次内存命中都同步 stat 的磁盘 IO；saveMessages 直写后清除，使下次命中重新检查。
    _verified: new Set(),

    /** 带上限的内存缓存写入：超限时淘汰最旧键（磁盘不受影响），防理论无限增长；返回是否写入成功 */
    _memoSet (filePath, val) {
    // 键归一化：非字符串键（Symbol/数字等）统一 String 化，保证可被 Object.keys 枚举并参与淘汰，
    // 避免 Symbol 键永不淘汰，也让 toString/valueOf 等原型键走一致的字符串键路径。
      const key = typeof filePath === 'string' ? filePath : String(filePath)
      // R5-2：hasOwnProperty 判断（__proto__ 等原型键不会被 in 误判/直写污染对象原型）
      if (!Object.prototype.hasOwnProperty.call(this._memoryCache, key)) {
      // 用维护的 _memoCount 判断是否打满：热路径每次新键写只需 O(1)，不再全量 Object.keys。
      // 容量上限 100，仅在打满后（每次淘汰最旧键）才需要 Object.keys 定位最旧键，成本被封顶。
        if (this._memoCount >= this._MEMO_MAX) {
        // 超限时淘汰最旧键：普通字符串键按插入顺序，keys[0] 即最早写入的键；无需整体重置
          const keys = Object.keys(this._memoryCache)
          if (keys.length === 0) return false // 上限非正且缓存为空时无可淘汰，拒绝写入
          // 只对字符串键淘汰：数字样键会被 Object.keys 按数值序排列，keys[0] 并非最旧，
          // 故跳过数组索引样键，取首个普通字符串键；全部为索引键时退回 keys[0]。
          // P3（审查 2026-08-15）：数字样键分支为防御性死代码——_memoryCache 键恒为 getFilePath
          // 产物（绝对路径字符串），绝不可能是数字样键；保留以防未来键来源变化（注释锁定）。
          // P3（审查 2026-08-15，v3.260 回归）：正则误写成 \\d（匹配字面反斜杠+d）导致数字样键
          // 不再被识别为索引键、会被当「最旧键」淘汰（行为翻转）；恢复 \d 语义。
          const oldest = keys.find(k => typeof k === 'string' && !/^(?:0|[1-9]\d*)$/.test(k)) ?? keys[0]
          try { delete this._memoryCache[oldest] } catch (e) { /* 忽略 */ }
          // 淘汰后按实际键数校准计数（防御外部直删导致的漂移；新增键由下方统一自增）。
          // P3（审查 2026-08-15）：依赖 delete 一定成功——当前实现 delete 永不抛错（自身属性可配置），
          // 属理论防御；若未来键为不可配置属性，此处计数会与键数脱钩（注释锁定）。
          this._memoCount = keys.length - 1
          // warn 降频：容量打满后不再每次新键写都提示，仅在从“未满”首次进入“打满淘汰”时提醒一次
          if (!this._memoWarned) {
            console.warn(`内存缓存达到上限(${this._MEMO_MAX})，已淘汰最旧键: ${oldest}（磁盘缓存不受影响）`)
            this._memoWarned = true
          }
        } else {
        // 缓存仍有空间 → 重置降频标记，下次打满时再提醒一次
          this._memoWarned = false
        }
        // 新键写入后计数 +1（打满分支已在上方校准到“淘汰后键数”，此处统一补上新增的这一个）
        this._memoCount++
      }
      // 原型键（__proto__/constructor/prototype）用 defineProperty 写入，避免 `obj['__proto__']=val` 修改对象原型
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        Object.defineProperty(this._memoryCache, key, { value: val, enumerable: true, configurable: true, writable: true })
      } else {
        this._memoryCache[key] = val
      }
      return true
    },

    /** MessageStore 级 NOW()：saveBatch 与 _upsert 共享同一单调时钟状态（_nowLastTs） */
    _now () {
    // v3.251 g5：lastTs 提升为 MessageStore 级（_nowLastTs），跨 saveBatch/_upsert
    // 调用保持全局单调——此前每次调用重置导致跨批次时间戳回退乱序（1002→1001）。
    // P3（审查 2026-09-15）：删除死状态 _nowInc 的三处赋值——返回值只由 _nowLastTs 决定，
    // 全仓无读取点，原注释称其参与单调时钟与实现不符（跨批次单调性不变）。
      const t = Date.now()
      if (this._nowLastTs === undefined) this._nowLastTs = 0
      if (t > this._nowLastTs) {
      // 系统时钟前进：以真实时间戳为准
        this._nowLastTs = t
      } else {
      // 同毫秒或时钟回拨：在上一已返回值上严格 +1，保证全局严格单调
        this._nowLastTs += 1
      }
      return new Date(this._nowLastTs).toISOString()
    },

    /** 统一更新/追加：命中则更新(含覆盖提示)，未命中追加；返回是否发生数据变更（无变更则不落盘） */
    _upsert (messages, message, filename) {
    // v3.245 P1：非数组 messages 直接返回 false（不推送）——此前 messages.push 抛 TypeError 崩溃。
      if (!Array.isArray(messages)) return false
      // 脏 message（非有效数据对象）不写入：避免 `{ ...safeObjectCopy(message), timestamp }` 把无效/未规范化
      // 条目带 timestamp 塞进缓存（与 save 入口的 isValidItem 口径一致；此前 _upsert 仅判数组、不判消息）。
      if (!Utils.isValidItem(message)) return false
      // P3：拒绝空对象/空身份——isValidItem 只保证"对象且非数组"，空对象 {} 或缺失 id/url/key 的条目
      // 会被 anonKey 退化为恒定键；这里与 saveBatch 的 identity.valid 口径一致，避免把无意义条目
      // 带 timestamp 塞进缓存（此前 _findDedupIndex 对无效身份返回 -1，会走 else 分支无脑 push）。
      if (!Utils.getMessageIdentity(message).valid) return false
      const idx = this._findDedupIndex(messages, message)
      if (idx >= 0) {
      // v3.156：比较排除 timestamp（同 saveBatch 主路径口径）——否则 oldM 带 timestamp、
      // message 无 timestamp 而内容相同也必报"更新缓存记录"并刷新 timestamp。
      // P3 优化：先做零分配的浅层快速相等检查（内容未变的常见去重路径直接短路，避免深排），
      // 未命中再退回键序无关规范化深排；循环引用等失败时按"已更新"处理不崩溃。
        if (!this._contentChangedIgnoringTs(messages[idx], message)) return false // 内容完全一致：不更新、不刷新 timestamp、不触发落盘
        console.log(`更新缓存记录: ${filename}`)
        messages[idx] = { ...Utils.safeObjectCopy(message), timestamp: this._now() }
      } else {
      // P4（CodeAnt）：身份已在墓碑（曾被裁剪且已推送过）→ 视为已判重，不重复收录/推送
        if (this._tombstoneHasIdentity(this.getFilePath(filename), message)) return false
        messages.push({ ...Utils.safeObjectCopy(message), timestamp: this._now() })
      }
      return true
    },

    /** 判重内容比较：排除顶层 timestamp、键序无关，判断两消息内容是否实际变更。
      P3 优化：先做零分配的浅层快速相等检查（内容未变的去重路径直接短路，避免对整条大消息
      做两次 deep normalize+JSON.stringify），未命中再退回既有键序无关规范化序列化比较，
      语义与旧实现完全一致（循环引用/异常按"已变更"处理）。 */
    _contentChangedIgnoringTs (oldM, message) {
      if (Utils.shallowEqualIgnoringTimestamp(oldM, message)) return false
      const stripTs = (o) => { if (!o || typeof o !== 'object') return o; const c = { ...o }; delete c.timestamp; return c }
      const canon = (o) => { try { return JSON.stringify(normalize(stripTs(o))) } catch (e) { return null } }
      const a = canon(oldM)
      const b = canon(message)
      if (a === null || b === null) return true
      return a !== b
    },

    /** 统一判重：所有入口复用 Utils.sameMessageIdentity，避免单条/批内/缓存逻辑分裂 */
    _findDedupIndex (messages, message) {
      if (!Array.isArray(messages)) return -1
      // 新消息身份只计算一次；身份无效则不可能命中任何有效缓存，直接返回 -1（不再全量扫描）
      const b = Utils.getMessageIdentity(message)
      if (!b.valid) return -1
      // 预计算每条缓存消息身份传入（a），避免 sameMessageIdentity 逐条重复求值；命中即返回
      for (let i = 0; i < messages.length; i++) {
        const a = Utils.getMessageIdentity(messages[i])
        if (Utils.sameMessageIdentity(messages[i], message, a, b)) return i
      }
      return -1
    },

    init () {
      try {
      // 昂贵的 cacheDir getter（含 realpath 校验）只求值一次；existsSync 守卫保留，
      // 避免目录已存在时调用 mkdirSync（故障注入测试依赖该守卫）。
        const dir = this.cacheDir
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        this._cleanupResidualTombstoneLocks(dir)
      } catch (e) {
      // v3.245 P1：目录创建失败必须暴露——此前只 console.error 吞错，后续所有缓存写
      // 操作（save/saveBatch）都会因目录缺失而连锁失败且原因不明。
      // P3（审查 2026-09-15）：catch 内再求值 cacheDir getter 可能二次抛错（该 getter 在
      // 安全检查全失败时显式 throw，见上方 realInsideRoot 兜底分支）——原写法会让诊断日志
      // 永不打印、且暴露给调用方的原始异常被替换成 getter 的异常。改为先安全取值再拼日志，
      // 原始异常照常抛出（错误语义与调用方契约不变）。
        let dirText
        try { dirText = this.cacheDir } catch { dirText = '<cacheDir 求值失败>' }
        console.error(`缓存目录创建失败: ${dirText}`, (e && e.message) || e)
        throw e
      }
    },

    _tombstoneLocksCleaned: new Set(),

    /** 启动清理可确认属于已退出进程的陈旧墓碑锁；活跃锁和新锁一律保留。
   *  P3（审查 2026-09-15）：清理范围从 `.seen.lock` 扩到「墓碑锁 + 目录级哨兵」两类：
   *  1) `<file>.seen.lock` —— 串行化单文件墓碑读-改-写；
   *  2) `.seen.cleanup.lock`（含 `.reclaim` 中间态）—— 目录级启动清理/墓碑写入门径的哨兵。
   *  原实现只匹配 `.seen.lock`，哨兵一旦被强杀进程留下且 mtime 陈旧，就再没有任何回收路径
   *  （_acquireTombstoneCleanupGuard 只有在能读 token 且判存活失败时才认领），墓碑写入门径
   *  永久不可用。两类都按同一「陈旧 + 进程已退出」双条件回收，活跃进程持有的锁照旧保留。
   *  已知取舍（未变，本批次不改）：xbk_storage.writeAtomic 的 <目标>.<pid>.<ts>.<hex>.tmp
   *  残留仍无回收路径——回收需在 xbk_storage.js 导出临时文件命名口径（该文件属另一批次，
   *  跨文件改动已按协同口径登记为待办）。 */
    _cleanupResidualTombstoneLocks (dir) {
      if (this._tombstoneLocksCleaned.has(dir)) return
      const guard = this._acquireTombstoneCleanupGuard(dir)
      if (guard === null) return
      let names
      try {
        names = fs.readdirSync(dir)
        this._tombstoneLocksCleaned.add(dir)
        for (const name of names) {
          if (!this._isResidualTombstoneLockName(name)) continue
          const lockPath = path.join(dir, name)
          try {
            const st = fs.statSync(lockPath)
            if (Date.now() - st.mtimeMs <= TOMBSTONE_LOCK_STALE_MS) continue
            if (this._isTombstoneLockProcessAlive(lockPath)) continue
            fs.unlinkSync(lockPath)
            console.warn(`清理启动残留墓碑锁：${name}`)
          } catch (e) {
            console.warn(`启动清理墓碑锁失败，跳过：${name}`)
          }
        }
      } catch (e) {
        return
      } finally {
        this._releaseTombstoneCleanupGuard(dir, guard)
      }
    },

    /** 启动清理的候选名判定：覆盖单文件墓碑锁、目录级清理哨兵与其 .reclaim 中间态。
   *  **只按精确形状匹配，绝不用子串包含**（F4 回归，V6 实锤）：旧实现第三条判据是
   *  `name.includes('.seen.cleanup.lock.')`，于是**合法缓存文件** `<name>.seen.cleanup.lock.json`
   *  （上游 pushUrl 末段恰为 `xxx.seen.cleanup.lock`，getFileName 只补 `.json` 后缀）也被当作残留锁；
   *  它的 mtime 一旦陈旧、内容又不是锁 token（PID 解析失败 → 视为「进程已退出」），
   *  就会被启动清理静默 unlink——直接丢失该 pushUrl 的整份判重记录，下一轮全量重推。
   *  三条判据各自的形状来源：
   *    1) `<缓存文件>.seen.lock` —— _acquireTombstoneLock 的锁路径；
   *    2) `.seen.cleanup.lock` —— _acquireTombstoneCleanupGuard 的哨兵（精确相等）；
   *    3) `.seen.cleanup.lock.<pid>.<ts>.reclaim` —— 同上哨兵的原子认领中间态（命名逐字段对齐：
   *       十进制进程号 + 十进制毫秒时间戳 + 字面 .reclaim）。
   *  纯函数，供测试直接锁定名单。 */
    _isResidualTombstoneLockName (name) {
      if (typeof name !== 'string') return false
      if (name.endsWith('.seen.lock')) return true
      if (name === '.seen.cleanup.lock') return true
      return /^\.seen\.cleanup\.lock\.\d+\.\d+\.reclaim$/.test(name)
    },

    /** 目录级非阻塞哨兵：串行化启动清理与墓碑锁创建，覆盖检查-删除竞态。 */
    _acquireTombstoneCleanupGuard (dir) {
      const guardPath = path.join(dir, '.seen.cleanup.lock')
      const token = this._newTombstoneLockToken()
      try {
        fs.writeFileSync(guardPath, token, { flag: 'wx' })
        return token
      } catch (e) {
        if (e.code !== 'EEXIST') {
          // P3（审查 2026-09-15）：EEXIST 只是哨兵被占用（正常竞争，静默）；其余都是环境/IO
          // 故障——原实现静默 return null，会让启动清理与墓碑写入门径失效却无任何诊断
          // （与 _acquireTombstoneLock 的 console.error 诊断口径对齐）。失败语义不变。
          console.warn(`墓碑清理哨兵创建失败（本次跳过清理/墓碑写入）${guardPath}:`, e?.message || e)
          return null
        }
        if (this._isTombstoneLockProcessAlive(guardPath)) return null
        // 原子认领旧哨兵；不要在 liveness 检查后按原路径 unlink，避免误删后来创建的新哨兵。
        const reclaimPath = `${guardPath}.${process.pid}.${Date.now()}.reclaim`
        try { fs.renameSync(guardPath, reclaimPath) } catch (renameError) { return null }
        try {
          if (this._isTombstoneLockProcessAlive(reclaimPath)) return null
          fs.unlinkSync(reclaimPath)
        } catch (reclaimError) {
          try { fs.unlinkSync(reclaimPath) } catch (ignored) {}
          return null
        }
        try {
          fs.writeFileSync(guardPath, token, { flag: 'wx' })
          return token
        } catch (retryError) {
          return null
        }
      }
    },

    _releaseTombstoneCleanupGuard (dir, token) {
      const guardPath = path.join(dir, '.seen.cleanup.lock')
      this._releaseTombstoneLock(guardPath, token)
    },

    /**
   * 锁 token 含 PID 与 Linux 进程启动时钟；PID 复用但启动时钟不同即视为旧锁。
   * 无法读取身份时保守保留锁，旧格式 token 仍按 PID 兼容判断。
   */
    _isTombstoneLockProcessAlive (lockPath) {
      let token
      try { token = fs.readFileSync(lockPath, 'utf8') } catch (e) { return true }
      const parts = String(token).split(':')
      const pid = Number(parts[0])
      if (!Number.isSafeInteger(pid) || pid <= 0) return false
      let alive
      try {
        process.kill(pid, 0)
        alive = true
      } catch (e) {
        alive = e && e.code === 'EPERM' // EPERM = 进程存在但无权限，视为活跃；ESRCH = 进程不存在
      }
      if (!alive) return false
      const expectedStart = parts[1]
      // 非 Linux / 旧格式 token 无有效启动时钟：无法验证进程 incarnation，只能按 PID 存活兜底。
      // Linux 且有合法 start 时才对比启动时钟，防 PID 复用误判。
      if (!expectedStart || !/^[0-9]+$/.test(expectedStart)) return true
      const actualStart = this._getTombstoneProcessStart(pid)
      return actualStart === null || actualStart === expectedStart
    },

    _getTombstoneProcessStart (pid) {
    // 仅 Linux 提供 /proc/PID/stat 的进程启动时钟（starttime）。
    // 非 Linux（macOS/Windows）无法读取 → 返回 null，调用方按
    // “PID 存活即活跃”的保守口径处理：无法识别 PID 复用，宁可保留陈旧锁。
      if (process.platform !== 'linux') return null
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        if (close < 0) return null
        const fields = stat.slice(close + 1).trim().split(/\s+/)
        return /^[0-9]+$/.test(fields[19] || '') ? fields[19] : null
      } catch (e) {
        return null
      }
    },

    getFilePath (filename) {
    // 路径安全：只取 basename 并清洗，外部传 ../ 或绝对路径无法逃出缓存目录
    // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 视为空文件名
      let fnStr
      try { fnStr = String(filename || '') } catch (e) { fnStr = '' }
      // v3.248：NUL（\u0000）不在非法字符正则内，会被保留进路径导致 fs 抛
      // ERR_INVALID_ARG_VALUE——一并清洗，避免 getFilePath 产物触发 fs 报错。
      let safe = path.basename(fnStr).replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
      // v3.176：非信息文件名（对象/布尔 String 化产物）回退 default.json——与 getFileName 口径一致
      // （曾产生 xianbaoku_cache/[object Object] 垃圾文件：test_filter 参数颠倒 + 此处无防御）
      if (!safe || safe === '.' || safe === '..' || safe === '[object Object]' || safe === 'undefined' || safe === 'null' || safe === 'true' || safe === 'false') safe = 'default.json'
      // 按 UTF-8 字节截断且不切半代理对：返回不超过 maxBytes 的最长前缀，且末尾
      // 不会残留孤代理（避免输出乱码）。多字节字符不能按字符索引截断，故二分。
      const truncateByBytes = (s, maxBytes) => {
        if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
        let lo = 0
        let hi = s.length
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid
          else hi = mid - 1
        }
        // 末位若是高位代理，说明切在代理对中间，回退一格丢弃半个码点（不留孤代理）
        if (lo > 0) {
          const cu = s.charCodeAt(lo - 1)
          if (cu >= 0xd800 && cu <= 0xdbff) lo -= 1
        }
        return s.slice(0, lo)
      }
      // 截断结果为空时保留首个完整码点（避免空名与孤代理）
      const keepOne = (s) => s || (() => {
        const f = safe.codePointAt(0)
        return safe.slice(0, f > 0xffff ? 2 : 1)
      })()
      // 文件名超长截断：先尝试保留扩展名，保证总字节 <= 200。
      // F7 回归（R4/V6）：单纯截断会让「仅第 200 字节之后不同」的两个长名映射到同一路径——
      // 生产 cacheName 直接来自 getFileName(pushUrl)，两个不同 pushUrl 的判重缓存会互相覆盖。
      // 因此截断结果附带**全名**的确定性摘要（anonKey 64 位拼接，只保留字母数字，不引入新的
      // 路径保留字符），使「长名 → 路径」保持单射；不超过 200 字节的名字不进此分支，行为不变。
      if (Buffer.byteLength(safe, 'utf8') > 200) {
        const digest = String(Utils.anonKey(safe)).replace(/[^0-9a-z]/gi, '')
        const dot = safe.lastIndexOf('.')
        const ext = dot > 0 ? safe.slice(dot) : ''
        let suffix = `-${digest}${ext}`
        let maxBase = 200 - Buffer.byteLength(suffix, 'utf8')
        if (maxBase < 1) { suffix = `-${digest}`; maxBase = 200 - Buffer.byteLength(suffix, 'utf8') } // 扩展名本身超长：放弃保留
        if (maxBase < 1) { suffix = ''; maxBase = 200 } // 摘要超长（不可能发生）：退回纯截断
        const base = truncateByBytes(dot > 0 ? safe.slice(0, dot) : safe, maxBase)
        safe = keepOne(base) + suffix
      }
      // 兜底校验：截断后仍可能超 200 字节（如扩展名超长且首字符为多字节、Math.max(1) 强保
      // 字符时），放弃扩展名整体再按字节截断，保证不变量成立。
      if (Buffer.byteLength(safe, 'utf8') > 200) {
        safe = keepOne(truncateByBytes(safe, 200))
      }
      return path.join(this.cacheDir, safe)
    },

    _ensureFileExists (filePath) {
    // 空路径早退：writeAtomic 对空路径会留下无法重命名的残留 .tmp，直接跳过。
      if (!filePath) return false
      // 父目录创建与原子初始化交给 writeAtomic（内部已 ensureParent），避免冗余 stat。
      // P1（审查 2026-08-15）：返回初始化是否成功——readMessages 据此区分「文件缺失但初始化
      // 成功（正常空缓存）」与「缺失且初始化失败（磁盘满/目录只读/EACCES，须置 _readFailed
      // 防主流程按空缓存全量重推）」。
      try {
      // v3.263（CodeAnt）：初始化用独占创建替代 writeAtomic——tmp+rename 会无条件替换目标文件，
      // 检查与写入之间另一进程若已创建有效缓存会被覆盖成 [] 丢失判重记录；wx 语义并发创建不覆盖。
        if (!fs.existsSync(filePath)) return writeAtomicIfAbsent(filePath, '[]', '缓存初始化')
        return true
      } catch (e) {
        console.error(`缓存初始化失败 ${filePath}:`, e.message)
        return false
      }
    },

    readMessages (filePath) {
    // R5-2：hasOwnProperty 读取（'__proto__' 直读会返回 Object.prototype 而非缓存值）
      if (Object.prototype.hasOwnProperty.call(this._memoryCache, filePath)) {
      // 常驻进程保护：外部误删缓存文件时，内存中的权威快照继续用于判重，
      // 并尝试原子恢复磁盘文件；恢复失败时保留旧快照，不写入空数组。
      // v3.x：按文件记录“已验证”标记——仅首次内存命中未验证时做一次 existsSync+恢复检查，
      // 后续命中直接返回内存快照，不再同步 stat 磁盘，消除热路径退化磁盘 IO。
        if (!this._verified.has(filePath)) {
          let exists
          try { exists = fs.existsSync(filePath) } catch (e) { exists = true }
          let restored = false
          if (!exists) {
          // v3.236：恢复写入抛错（磁盘满/权限）时同样降级保留内存快照，不向外传播破坏判重流程
            try {
              restored = this.saveMessages(filePath, this._memoryCache[filePath])
              if (!restored) console.warn(`缓存文件缺失且恢复失败，继续使用内存缓存：${filePath}`)
            } catch (e) {
              console.warn(`缓存文件缺失且恢复异常，继续使用内存缓存：${filePath} (${String((e && e.message) || e)})`)
            }
          }
          // v3.257：恢复失败不固化“已验证”，保留重试窗口；内存快照仍为权威（判重不受影响）。
          // 仅当磁盘文件已存在或恢复成功时才视为已验证；注意恢复调用的 saveMessages 会清除本标记，
          // 故成功/已存在时在此重新置位，后续命中直接返回内存快照。
          if (exists || restored) {
            try { this._verified.add(filePath) } catch (e) { /* 忽略 */ }
          }
          // P3（审查 2026-09-15）标注：本内存命中路径会清除 _readFailed[filePath]，
        }
        // 内存快照为权威读取：清除该文件的读取失败标记（后续 save 可安全基于快照落盘）
        try { delete this._readFailed[filePath] } catch (e) { /* 忽略 */ }
        // P3（审查 2026-09-15）只读契约：返回值是内部权威数组的同一引用（元素对象亦同一），
        // 且该引用被 has() 用作 _identityIndex(WeakMap) 的键——调用方必须视为只读，
        // 任何原地增删改元素都会让已缓存的身份索引与实际内容不一致而静默误判为「已存在」。
        // 磁盘读取成功路径（下方返回 clean 前 _memoSet）同样是同一引用。
        // 本轮保留引用返回的既有性能取舍，仅在此显式声明只读契约（未加 Object.freeze）。
        return this._memoryCache[filePath]
      }
      const initialized = this._ensureFileExists(filePath)
      const result = readSafeTextResult(filePath, MESSAGE_CACHE_MAX_BYTES)
      if (result.status !== 'ok') {
        const detail = result.error && result.error.message ? result.error.message : result.status
        if (result.status === 'unsafe') console.error(`拒绝读取非普通缓存文件 ${filePath}`)
        else if (result.status === 'ioError') console.error(`缓存读取失败 ${filePath}:`, detail)
        else if (result.status === 'tooLarge') console.error(`缓存文件过大，拒绝整读入内存 ${filePath}:`, detail)
        // missing/ioError/unsafe/tooLarge 都不能缓存空数组；后续恢复后仍应重新读取磁盘。
        // ioError/unsafe/tooLarge 读取失败时记录失败标记：返回 [] 供判重/调用方降级，但绝不允许
        // 后续 save 据此全量覆写磁盘（会把未读到的存量数据覆盖丢失）。
        if (result.status === 'ioError' || result.status === 'unsafe' || result.status === 'tooLarge') {
          try { this._readFailed[filePath] = true } catch (e) { /* 忽略 */ }
        }
        // P1（审查 2026-08-15）：缓存缺失且初始化写入失败（磁盘满/目录只读/EACCES）时与
        // ioError 同口径置 _readFailed——此前 missing 不置位，主流程按「空缓存」放行全量
        // 重推且 saveBatch 落盘同样失败 → 每轮重复轰炸（与 v3.259 修复的损坏缓存重复推送
        // 同类但未被覆盖）；磁盘恢复后初始化成功自动解除。
        if (result.status === 'missing' && !initialized) {
          try { this._readFailed[filePath] = true } catch (e) { /* 忽略 */ }
        }
        return []
      }
      let data
      try {
        data = JSON.parse(result.text || '[]')
      } catch (e) {
      // 不再重置文件为 []：那会销毁磁盘上的去重缓存，且未标记 _readFailed，
      // 使 has() 误判 false 并放行同一条消息重复入库。改为与 ioError/unsafe 一致的
      // 保守处理——保留异常文件供恢复，并标记 _readFailed 让 save() 拒绝覆写。
        console.error(`缓存 JSON 解析失败，跳过写入以保护数据 ${filePath}:`, e.message)
        try { this._readFailed[filePath] = true } catch (err) { /* 忽略 */ }
        return []
      }
      if (Array.isArray(data)) {
      // 过滤非对象元素（null/原始值），避免后续 has/save 访问 m.id 崩溃
      // v3.157：排除数组元素（typeof object 含数组——数组元素 m.id 访问异常、判重混乱）
        const clean = data.filter(m => m && typeof m === 'object' && !Array.isArray(m))
        // 成功读取 → 清除该文件读取失败标记
        try { delete this._readFailed[filePath] } catch (e) { /* 忽略 */ }
        this._memoSet(filePath, clean)
        // 磁盘读取成功并记忆化：直接标记已验证，避免下次内存命中再白做一次 stat。
        try { this._verified.add(filePath) } catch (e) { /* 忽略 */ }
        return clean
      }
      // 合法 JSON 但非数组（对象等）→ 不再重置：保留原文件并标记读取失败，
      // 避免误判空缓存导致同一条消息重复入库；save() 会因 _readFailed 拒绝覆写。
      console.error(`缓存格式异常（非数组），跳过写入以保护数据 ${filePath}`)
      try { this._readFailed[filePath] = true } catch (e) { /* 忽略 */ }
      return []
    },

    saveMessages (filePath, messages) {
    // 记录写入前的内存缓存：落盘失败时不能把未持久化的新状态伪装成已保存。
      const hadMemo = Object.prototype.hasOwnProperty.call(this._memoryCache, filePath)
      const memoBefore = hadMemo ? this._memoryCache[filePath] : undefined
      const restoreMemo = () => {
        if (hadMemo) this._memoSet(filePath, memoBefore)
        else {
          try { delete this._memoryCache[filePath] } catch (e) { /* 忽略 */ }
        }
      }
      // P2（审查 2026-08-15）：非数组入参曾退化为「写空数组」——会在未读取磁盘的情况下把去重
      // 缓存整体覆写为 []，违背「损坏缓存重置失败不得缓存空数组」铁律（当前调用方均传数组，属防御加固）。
      if (!Array.isArray(messages)) {
        console.error(`缓存写入拒绝：messages 必须为数组 ${filePath}`)
        return false
      }
      // 拷贝后再截断：不原地修改调用方传入的数组（外部复用场景）
      const toSave = [...messages]
      // maxSize 防御：非正整数回退默认（R3-2 整数化——小数 2.5 会让 splice 的 ToInteger 截断产生模糊条数；0/负值避免缓存被清空）
      // v3.176：Utils.num 口径——'5000'(环境变量字符串) 曾 Number.isInteger 判否 → 静默回退 10000
      // （validateConfig 按 v3.175 口径判合法不警告 → 层间不一致，用户以为 5000 生效实际 10000）
      const maxSize = (() => { const v = Utils.num(Config.cache.maxSize, -1); return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_SIZE })()
      // P4（CodeAnt Round2）：被裁剪记录先收集、缓存原子写盘成功后才统一落墓碑——
      // 写盘失败（序列化/单条超限/rename 失败）时记录并未真正从磁盘缓存移除，
      // 提前落墓碑会把仍在缓存中的身份误判为已判重（消息被永久跳过）。
      const droppedAll = []
      if (toSave.length > maxSize) {
        console.warn(`缓存超出上限(${maxSize})，裁剪掉最早 ${toSave.length - maxSize} 条`)
        const dropped = toSave.splice(0, toSave.length - maxSize)
        droppedAll.push(...dropped)
      }
      let text
      // 序列化防御：循环引用等无法 JSON.stringify 时容错（内存缓存保留，不落盘不崩溃）
      try {
      // P3（审查 2026-08-15）：紧凑输出替代美化缩进——缓存文件体积 -30~50%，万条级序列化内存峰值更低
        text = JSON.stringify(toSave)
      } catch (e) {
        console.error(`缓存序列化失败 ${filePath}（可能含循环引用）:`, e.message)
        text = null
      }
      if (text === null) {
      // 序列化失败：记录未被持久化，不落墓碑（墓碑只收录「已成功裁剪并落盘」的记录，
      // 异常路径上记录未真正丢弃，重放时缓存自身仍会判重/重新评估）
        restoreMemo()
        return false
      }
      // P1（审查 2026-08-15）：写端字节上限与读端 MESSAGE_CACHE_MAX_BYTES 对齐——此前仅按条数
      // （maxSize）裁剪，单条 >6.7KB（base64 图/长 HTML 常见）时 10000 条即可超 64MB，读端判
      // tooLarge → 置 _readFailed → 写端被 _readFailed 拒绝覆写 → 永久自锁直至人工删文件。
      try {
        text = this._trimCacheByBytes(text, toSave, filePath, MESSAGE_CACHE_MAX_BYTES, droppedAll)
      } catch (e) {
      // 评审 qodo（v3.267）：裁剪阶段意外异常（如极端不可序列化元素）也不崩溃进程，与序列化失败同口径 fail-open
        console.error(`缓存裁剪失败 ${filePath}:`, e.message)
        text = null
      }
      if (text === null) {
      // 单条即超读端上限，无法裁剪出可读文件：跳过落盘，保留磁盘原状（避免写出超限文件触发自锁）
      // 同样不落墓碑——未发生实际裁剪，旧身份仍在磁盘缓存中，无需墓碑兜底
        restoreMemo()
        return false
      }
      // 统一安全原子写入：普通文件检查、唯一临时文件、失败清理和错误日志集中处理。
      const saved = writeAtomic(filePath, text, '缓存')
      if (!saved) {
        restoreMemo()
        return false
      }
      this._memoSet(filePath, toSave)
      // v3.x：磁盘刚被直写，外部删除可能在后续发生；清除“已验证”标记，
      // 使下次 readMessages 内存命中重新做一次 existsSync+恢复检查（保持外部删除恢复测试语义）。
      try { this._verified.delete(filePath) } catch (e) { /* 忽略 */ }
      // 缓存写盘成功：被裁剪记录才真正退出磁盘缓存，此时落墓碑防重放（防重复推送）
      if (droppedAll.length > 0) this._tombstoneDropped(filePath, droppedAll)
      return true
    },

    /** 写端字节上限裁剪：二分查找「最新 k 条序列化后不超读端上限」的最大 k（O(log n) 次序列化），
   *  至少保留最新 1 条；不超限原样返回；连最新单条都超限时返回 null（调用方跳过落盘）。
   *  maxBytes 仅供测试缩限（生产恒为 MESSAGE_CACHE_MAX_BYTES）。
   *  本方法不写墓碑：被裁剪记录追加到 droppedOut（与条数裁剪统一），
   *  由 saveMessages 在缓存原子写盘成功后一并落墓碑（CodeAnt Round2 时序修复）。 */
    _trimCacheByBytes (text, toSave, filePath, maxBytes = MESSAGE_CACHE_MAX_BYTES, droppedOut = null) {
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
      if (toSave.length <= 1) {
        console.warn(`缓存单条消息即超过读端上限(${maxBytes} 字节)，无法裁剪：${filePath}`)
        return null
      }
      // v3.267：预计算每条消息序列化字节（每条仅 stringify 一次），二分不再重复 JSON.stringify，避免 O(log n) 次全量序列化
      // 数组序列化口径：不可序列化元素（undefined/函数/Symbol/toJSON→undefined）在整体 JSON.stringify 时写为 null，
      // 单条 stringify 返回 undefined 会令 Buffer.byteLength 抛 TypeError——统一按 'null' 计字节（评审 qodo/coderabbit）
      const sizes = toSave.map((m) => {
        const s = JSON.stringify(m)
        return Buffer.byteLength(s === undefined ? 'null' : s, 'utf8')
      })
      // v3.267（评审建议）：后缀和数组——sizeOfLast(count) 从 O(count) 线性求和降为 O(1)，大数组二分不再重复累加
      const suffix = new Array(toSave.length + 1).fill(0)
      for (let i = toSave.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sizes[i]
      const sizeOfLast = (count) => { // 最后 count 条的数组序列化字节 = [] 开销 2 + (count-1) 个逗号 + 后缀和
        return 2 + (count > 1 ? count - 1 : 0) + suffix[toSave.length - count]
      }
      let lo = 1
      let hi = toSave.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (sizeOfLast(mid) <= maxBytes) lo = mid
        else hi = mid - 1
      }
      // 评审 coderabbit（v3.267）：key-sensitive toJSON 时根级估算可能低估数组内真实字节
      // （根级 key='' vs 数组内 key=索引，toJSON 可返回不同长度，实测可低估 10 倍）——
      // 收敛后做一次真实数组口径校验，超限则线性回退（极罕见场景，正常路径零额外开销），防写盘超限触发读端 tooLarge 自锁
      while (lo > 1 && Buffer.byteLength(JSON.stringify(toSave.slice(-lo)), 'utf8') > maxBytes) lo--
      // 二分收敛到 lo=1 时校验最新单条本身（真实数组口径）：仍超限则无法裁剪，与单条路径同口径跳过落盘（防自锁）
      if (lo === 1 && Buffer.byteLength(JSON.stringify(toSave.slice(-1)), 'utf8') > maxBytes) {
        console.warn(`缓存单条消息即超过读端上限(${maxBytes} 字节)，无法裁剪：${filePath}`)
        // 未实际裁剪任何记录：不产生丢弃（与单条超限路径同口径，见 saveMessages）
        return null
      }
      const dropped = toSave.length - lo
      console.warn(`缓存字节超上限(${maxBytes} 字节)，裁剪掉最早 ${dropped} 条（防读端 tooLarge 自锁）`)
      const droppedMsgs = toSave.splice(0, dropped)
      if (droppedOut) droppedOut.push(...droppedMsgs)
      return JSON.stringify(toSave)
    },

    /** 读取/初始化某缓存文件的墓碑身份集；缺失/损坏按空集处理，不阻断主流程。
   *  有意设计：损坏文件只在本进程内按空集使用（_tombstoneLoaded 防重复读盘），
   *  进程重启后会重新读取外部修复/替换的文件，不永久丢弃。
   *  P3（审查 2026-09-15）补：置位时机改为「读到内容」或「确认缺失」，只有真正的读取
   *  失败（ioError/unsafe/tooLarge）才不置位。
   *  原实现无条件先置位再读盘，一次瞬时读失败会被永久记忆成「空集」——防重放身份在本进程内
   *  静默丢失且不再重试。但「一律不置位」也不可行：墓碑文件不存在是**常态**（每个缓存文件
   *  首次判重都走这里），不置位会让每次判重都重新陷入同步磁盘 IO——实测 5000 条批量写入
   *  里 _readTombstoneData 被调用 3000 次、耗时从 0.25s 涨到 1.5s。
   *  故按结果分流：missing（文件确实不存在，读盘已给出确定答案）与读到内容都置位并缓存；
   *  仅 ioError/unsafe/tooLarge 不置位，下次调用重试（_readTombstoneData 已对这些补了告警）。 */
    _loadTombstones (filePath) {
      if (this._tombstoneLoaded.has(filePath)) return this._tombstones.get(filePath)
      const ts = { id: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anon: new Map() }
      this._tombstones.set(filePath, ts)
      const data = this._readTombstoneData(filePath)
      const fill = (map, arr) => { if (Array.isArray(arr)) for (const k of arr) if (typeof k === 'string' && k !== '') map.set(k, true) }
      // data === null 时区分「确认缺失」与「读取失败」：后者不置位，保留下次重试窗口。
      if (data) {
        fill(ts.id, data.id)
        fill(ts.urlOnly, data.urlOnly)
        fill(ts.idWithUrl, data.idWithUrl)
        fill(ts.anon, data.anon)
        this._tombstoneLoaded.add(filePath)
      } else if (this._tombstoneLoadStatus[filePath] === 'missing') {
        this._tombstoneLoaded.add(filePath)
      }
      return ts
    },

    /** 读墓碑文件并解析；缺失/损坏/非对象统一返回 null（调用方按空集处理）。
   *  损坏仅警告一次（每进程每文件首次加载），不抛异常不阻断主流程。
   *  P3（审查 2026-09-15）：missing（正常空集）静默；ioError/unsafe/tooLarge 属瞬时/环境故障，
   *  按空集使用会静默丢失防重放身份，补一条含状态与路径的告警便于观测。仍不改变「按空集处理」
   *  的既有语义，也不改动 _loadTombstones 的 _tombstoneLoaded 置位时机（失败后是否重试属
   *  墓碑状态机口径：读失败返回空集，并把本次结果记入 _tombstoneLoadStatus，
   *  由 _loadTombstones 决定是否置位 _tombstoneLoaded（仅 missing 与成功置位，
   *  ioError/unsafe/tooLarge 保留下次重试窗口）。 */
    _readTombstoneData (filePath) {
      try {
        const result = readSafeTextResult(filePath + '.seen.json', TOMBSTONE_MAX_BYTES)
        this._tombstoneLoadStatus[filePath] = result.status
        if (result.status !== 'ok') {
          if (result.status !== 'missing') {
            const detail = result.error && result.error.message ? ': ' + result.error.message : ''
            console.warn(`墓碑读取失败（按空集处理，下次调用重试）${filePath}.seen.json: ${result.status}${detail}`)
          }
          return null
        }
        if (!result.text) return null
        const data = JSON.parse(result.text)
        if (!data || typeof data !== 'object') return null
        return data
      } catch (e) {
        this._tombstoneLoadStatus[filePath] = 'ioError'
        console.warn(`墓碑读取异常，按空集处理（下次调用重试）${filePath}.seen.json:`, e?.message)
        return null
      }
    },

    /** 持久化墓碑文件（原子写）。超 TOMBSTONE_MAX_BYTES 时按各 Map 最旧键继续淘汰到
   *  体积达标，不直接放弃（避免重启后丢全部新墓碑）。写失败仅影响旧身份防重放，不阻断主流程。
   *  maxBytes 仅供测试缩限。 */
    _saveTombstones (filePath, ts, maxBytes = TOMBSTONE_MAX_BYTES) {
      try {
        const text = this._evictTombstonesToSize(ts, maxBytes)
        if (text === null) {
          console.warn(`墓碑文件超限且无法通过淘汰达标，放弃持久化 ${filePath}.seen.json`)
          return false
        }
        return writeAtomic(filePath + '.seen.json', text, '墓碑')
      } catch (e) {
        console.error(`墓碑持久化失败 ${filePath}.seen.json:`, e?.message)
        return false
      }
    },

    /** 序列化墓碑四集合；超 maxBytes 时按各 Map 最旧键淘汰到达标，返回最终文本；
   *  无法达标（淘汰到空仍超限）返回 null（调用方放弃持久化）。 */
    _evictTombstonesToSize (ts, maxBytes) {
      const maps = [ts.id, ts.urlOnly, ts.idWithUrl, ts.anon]
      const serialize = () => JSON.stringify({ v: 1, id: [...ts.id.keys()], urlOnly: [...ts.urlOnly.keys()], idWithUrl: [...ts.idWithUrl.keys()], anon: [...ts.anon.keys()] })
      let text = serialize()
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
      // 超限：先按超限比例批量淘汰最旧键（体积≈线性于键数），再逐轮精修到达标。
      // 四类轮流取各自最旧键，保证最旧身份先丢、最新身份保留。
      const totalKeys = maps.reduce((n, m) => n + m.size, 0)
      const toDrop = Math.ceil(((Buffer.byteLength(text, 'utf8') - maxBytes) / Buffer.byteLength(text, 'utf8')) * totalKeys)
      this._evictOldestKeys(maps, toDrop, totalKeys)
      text = serialize()
      // 精修：比例估算偏差导致的少量超限，继续逐键淘汰直到达标
      while (Buffer.byteLength(text, 'utf8') > maxBytes) {
        const before = text
        this._evictOldestKeys(maps, 1, 1)
        text = serialize()
        // P3（审查 2026-09-15）：进展守卫——四类 Map 全空时 _evictOldestKeys 无键可删
        // （evicted=false 立即 break），serialize() 恒返回同一空序列化文本（53 字节）；
        // maxBytes 小于该长度时原「全空后必然达标」假设不成立，会永久死循环挂起进程。
        // 此处如实上报「无法达标」返回 null，由调用方 _saveTombstones 放弃持久化，
        // 与上方 docstring 契约一致；合法入参（maxBytes ≥ 空序列化长度）下每轮必删键、
        // text 严格变短，不会走到该出口。
        if (text === before) return null
      }
      return text
    },

    /** 从四类墓碑 Map 各删一个最旧键，循环至删够 count 或全部清空 */
    _evictOldestKeys (maps, count, guardMax) {
      let guard = 0
      while (count > 0 && guard <= guardMax) {
        let evicted = false
        for (const map of maps) {
          if (count <= 0) break
          if (map.size === 0) continue
          map.delete(map.keys().next().value)
          count--
          evicted = true
        }
        if (!evicted) break
        guard++
      }
    },

    /** 墓碑锁：以 .seen.lock 独占创建实现互斥，串行化「读-改-写」。
   *  启动阶段只清理已退出进程的陈旧锁；运行中遇到 EEXIST 立即放弃本次墓碑写入。 */
    _withTombstoneLock (filePath, fn) {
      const dir = path.dirname(filePath)
      const guard = this._acquireTombstoneCleanupGuard(dir)
      if (guard === null) return false
      const lockPath = filePath + '.seen.lock'
      const token = this._acquireTombstoneLock(lockPath)
      if (typeof token !== 'string') {
        this._releaseTombstoneCleanupGuard(dir, guard)
        return false
      }
      try {
        return fn(lockPath, token)
      } finally {
        this._releaseTombstoneLock(lockPath, token)
        this._releaseTombstoneCleanupGuard(dir, guard)
      }
    },

    /** 独占创建锁文件（wx），内容写入 owner token（PID:随机串）；EEXIST 立即返回 null。 */
    _acquireTombstoneLock (lockPath) {
      const token = this._newTombstoneLockToken()
      try {
        fs.writeFileSync(lockPath, token, { flag: 'wx' })
        return token
      } catch (e) {
        if (e.code !== 'EEXIST') {
          console.error(`墓碑锁创建失败 ${lockPath}:`, e?.message)
        }
        // 单实例模式不等待其他进程持锁：残留锁已在启动时清理，运行中遇锁直接放弃本次墓碑写入。
        // 这样保留现有锁/原子写结构，同时绝不阻塞 Node.js 事件循环。
        return null
      }
    },

    /** 生成锁 owner token：PID + 进程启动时钟识别进程 incarnation，UUID 便于排查归属。
   * Linux 才有 /proc 启动时钟；非 Linux 平台省略 start 字段（保持 pid::uuid 三段结构），
   * 由 _isTombstoneLockProcessAlive 回退为仅按 PID 存活判断——避免写入无法解析的
   * 占位值（如 unknown）导致 PID 复用时残留锁永不回收。
   * 不用 Math.random（SonarCloud S2245 伪随机安全告警）。 */
    _newTombstoneLockToken () {
      const start = this._getTombstoneProcessStart(process.pid)
      return process.pid + ':' + (start || '') + ':' + crypto.randomUUID()
    },

    /** 释放墓碑锁：仅当锁内容仍是自己写入的 token 时才删除；ENOENT 视为正常。 */
    _releaseTombstoneLock (lockPath, token) {
      try {
        if (tokenMatches(fs.readFileSync(lockPath, 'utf8'), token)) fs.unlinkSync(lockPath)
      } catch (e) {
        if (e && e.code !== 'ENOENT') { /* 其余错误同样忽略，锁清理非关键 */ }
      }
    },

    /** 写盘前校验锁仍归当前进程持有；锁被替换或删除时放弃本次写入。 */
    _isTombstoneLockOwner (lockPath, token) {
      try {
        return tokenMatches(fs.readFileSync(lockPath, 'utf8'), token)
      } catch {
        return false
      }
    },

    /** 记录被裁剪消息的身份到墓碑；过滤未推（_f）记录不记录——它们从未推送，
   *  规则变更失效后须能重新评估/推送。与 _buildIdentityIndex 四集合同构：
   *  id 记录记 idKey（+url 入 idWithUrl）、url 记录记 urlOnly、anon 记 anonKey。
   *  写前强制重读磁盘合并其他进程已写入的身份（配合跨进程锁，消除覆盖竞态）。 */
    _tombstoneDropped (filePath, dropped) {
    // 拿锁成功：串行读-改-写；拿锁失败（IO 错误/锁忙）：放弃本次墓碑写入——
    // 无锁读-改-写仍可能覆盖并发进程已写入的身份（CodeAnt Round3 Major），
    // 放弃的代价仅是本次裁剪身份在重放时可能重复推送（与墓碑机制引入前行为一致）。
    // P3（审查 2026-09-15）：_withTombstoneLock 仅在「清理哨兵/墓碑锁未拿到」时返回 false
    // （成功路径返回 _recordTombstoneDrops 的 undefined），补一条诊断让失败可观测；
    // 失败语义不变（仍放弃本次墓碑写入，不重试、不阻塞主流程）。
      const locked = this._withTombstoneLock(filePath, (lockPath, token) => this._recordTombstoneDrops(filePath, dropped, lockPath, token))
      if (locked === false) console.warn(`墓碑写入未获锁，本次裁剪身份未落墓碑（重放时可能重复推送）：${filePath}`)
    },

    /** 写路径绕过 _tombstoneLoaded 缓存：重读磁盘并与本次新增合并后原子写回，
   *  避免「各自加载快照→后写覆盖先写」丢失其他进程已收录的身份。
   *  在临时副本上完成合并/淘汰，仅当 owner 校验通过且 .seen.json 原子写成功后才
   *  提交到内存缓存——锁被抢占或写盘失败时当前内存状态保持与磁盘一致（CodeAnt Round6）。
   *  过滤未推（_f）记录不记录——它们从未推送，规则变更失效后须能重新评估/推送。 */
    _recordTombstoneDrops (filePath, dropped, lockPath, token) {
    // 写盘前（进入读-改-写前）先确认锁仍归当前进程：被抢占/替换后立即放弃，
    // 不重读不合并不修改内存墓碑（CodeAnt Round5 Major：避免覆盖抢占者已写入的身份）
      if (!this._isTombstoneLockOwner(lockPath, token)) return
      this._tombstoneLoaded.delete(filePath)
      const next = this._cloneTombstones(this._loadTombstones(filePath))
      let changed = false
      for (const m of dropped) {
        if (!m || typeof m !== 'object' || m._f === true) continue
        changed = this._applyTombstoneIdentity(next, Utils.getMessageIdentity(m)) || changed
      }
      if (!changed) return
      this._trimTombstoneMaps(next)
      // 写盘瞬间再次确认锁仍归当前进程：读-改-写期间若被误判 stale 抢占/替换，
      // 静默放弃本次写入，避免基于旧快照的原子替换覆盖抢占者已合并的身份
      if (!this._isTombstoneLockOwner(lockPath, token)) return
      if (!this._saveTombstones(filePath, next)) return
      // 原子写成功后才提交内存缓存，避免「内存命中、磁盘未落盘」不一致
      this._tombstones.set(filePath, next)
      this._tombstoneLoaded.add(filePath)
    },

    /** 复制墓碑四集合：读改写全程在副本上进行，写盘失败/锁失效时当前缓存不被污染 */
    _cloneTombstones (ts) {
      return {
        id: new Map(ts.id),
        urlOnly: new Map(ts.urlOnly),
        idWithUrl: new Map(ts.idWithUrl),
        anon: new Map(ts.anon)
      }
    },

    /** 把单条消息身份写入墓碑对应集合；返回是否新增（_f 由调用方过滤） */
    _applyTombstoneIdentity (ts, ident) {
      if (!ident.valid) return false
      if (ident.kind === 'id') {
        let changed = false
        if (!ts.id.has(ident.idKey)) { ts.id.set(ident.idKey, true); changed = true }
        if (ident.url && !ts.idWithUrl.has(ident.url)) { ts.idWithUrl.set(ident.url, true); changed = true }
        return changed
      }
      if (ident.url) {
        if (!ts.urlOnly.has(ident.url)) { ts.urlOnly.set(ident.url, true); return true }
        return false
      }
      if (!ts.anon.has(ident.key)) { ts.anon.set(ident.key, true); return true }
      return false
    },

    /** 四类墓碑 Map 超 TOMBSTONE_MAX_KEYS 时丢最旧键 */
    _trimTombstoneMaps (ts) {
      for (const map of [ts.id, ts.urlOnly, ts.idWithUrl, ts.anon]) {
        while (map.size > TOMBSTONE_MAX_KEYS) {
          const oldest = map.keys().next().value
          if (oldest === undefined) break
          map.delete(oldest)
        }
      }
    },

    /** 墓碑身份命中查询（预计算身份版）：与 _indexHasIdentity 的匹配关系同构——
   *  id 查询命中 id 墓碑同 idKey，或纯 url 墓碑同 url；
   *  url 查询命中纯 url 墓碑同 url，或带 url 的 id 墓碑同 url；anon 按匿名合成键。 */
    _tombstoneSetsHas (filePath, b) {
      const ts = this._loadTombstones(filePath)
      if (b.kind === 'id') return ts.id.has(b.idKey) || (!!b.url && ts.urlOnly.has(b.url))
      if (b.kind === 'url') return (!!b.url && ts.urlOnly.has(b.url)) || (!!b.url && ts.idWithUrl.has(b.url))
      return ts.anon.has(b.key)
    },

    /** 墓碑身份命中查询：与 _indexHasIdentity 的匹配关系同构（统一入口，供 has/save/saveBatch/App 闸门复用） */
    _tombstoneHasIdentity (filePath, message) {
      const b = Utils.getMessageIdentity(message)
      if (!b.valid) return false
      return this._tombstoneSetsHas(filePath, b)
    },

    /** 预计算某缓存文件的身份索引：与 sameMessageIdentity 的匹配关系同构（见 has），
     仅构建一次并在批量 has 间复用，避免每次全量线性扫描 + 逐条重算身份。 */
    _buildIdentityIndex (messages) {
      const idx = { idByKey: new Map(), urlOnly: new Map(), idWithUrl: new Map(), anonByKey: new Map() }
      for (let i = 0; i < messages.length; i++) {
        const ident = Utils.getMessageIdentity(messages[i])
        if (!ident.valid) continue
        if (ident.kind === 'id') {
        // id 消息：按 idKey 匹配（对 id 查询），也按 url 匹配（对 url 查询的双向 fallback）
          Utils.addIndex(idx.idByKey, ident.idKey, i)
          if (ident.url) Utils.addIndex(idx.idWithUrl, ident.url, i)
        } else if (ident.kind === 'url') {
        // 纯 url 消息：对 id/url 查询均按 url 匹配
          Utils.addIndex(idx.urlOnly, ident.url, i)
        } else {
        // anon 消息：仅按匿名合成键匹配
          Utils.addIndex(idx.anonByKey, ident.key, i)
        }
      }
      return idx
    },

    /** 基于预计算身份索引的判重查询：精确复刻 sameMessageIdentity(cacheMsg, message) 的匹配关系。
   *  F-02（V6 实锤，漏推方向）：索引只按「引用 / 长度 / 首元素引用」做 O(1) 失效检查，
   *  调用方原地改写**非首元素**（换元素或改 id/url 字段）不会触发重建，旧索引会把已经不存在的
   *  身份判为「已存在」→ 主流程跳过推送（漏推，与 SYSTEM_CONTRACT「宁可多推」相反）。
   *  因此**传入 messages 时，索引层命中的每个候选下标都要按当前元素复算身份才算命中**
   *  （复用 _indexPositionMatches，与 _indexHasIdentityDirect 的 oracle 逐位语义一致）。
   *  成本只随命中候选数增长（通常 1 个），不做逐位全表复检（实测每次 ~20ms 会打死热路径）；
   *  不传 messages 时退化为纯索引判定（仅供不需要复检的调用方）。 */
    _indexHasIdentity (idx, message, messages) {
      const b = Utils.getMessageIdentity(message)
      if (!b.valid) return false
      const hit = (sets) => {
        for (const set of sets) {
          if (!set || set.size === 0) continue
          if (!messages) return true
          for (const i of set) {
            if (this._indexPositionMatches(messages, i, message, b)) return true
          }
        }
        return false
      }
      if (b.kind === 'id') {
      // id 查询：命中 id 缓存同 idKey；或纯 url 缓存同 url
        return hit([idx.idByKey.get(b.idKey), b.url ? idx.urlOnly.get(b.url) : null])
      }
      if (b.kind === 'url') {
      // url 查询：命中纯 url 缓存同 url；或带 url 的 id 缓存同 url
        return hit([b.url ? idx.urlOnly.get(b.url) : null, b.url ? idx.idWithUrl.get(b.url) : null])
      }
      // anon 查询：命中匿名合成键相同的 anon 缓存
      return hit([idx.anonByKey.get(b.key)])
    },

    /** 命中的索引下标必须用**当前**元素复算身份才算命中（F-02）：索引下标可能因调用方原地改写
   *  而指向别的元素（越界/被换/字段被改）。与 _indexHasIdentityDirect 的同位逻辑逐行同构，
   *  保证「索引判重」与「线性扫描 oracle」在同一输入下给出同一答案。 */
    _indexPositionMatches (messages, i, message, b) {
      if (!Number.isInteger(i) || i < 0 || i >= messages.length) return false
      const a = Utils.getMessageIdentity(messages[i])
      return Utils.sameMessageIdentity(messages[i], message, a, b)
    },

    /** 身份索引缓存失效检查（P3 审查 2026-09-15）。
   *  缓存条目形如 { ref, head, len, idx, missVerified, posRefs, refCursor, identityCursor }：ref 是权威
   *  数组引用、head 是首个元素引用、len 是元素数、idx 是预计算身份索引、missVerified 与 posRefs /
   *  refCursor / identityCursor 见 has 的「未命中复检/抽查」口径与 _probeIndexMiss。
   *
   *  为什么不能只用「数组引用」作键：readMessages 返回的是内部权威数组的同一引用，
   *  调用方原地删改元素不会换引用，旧索引会让 has() 静默误判为「已存在」。
   *
   *  为什么键里不能放「全部元素引用的数组」：_identityIndex 是 WeakMap，把数组当键会让
   *  每次 has() 都构造一个新键、get 必然落空 → 每次都全量重建索引（实测 2000 次 has()
   *  从 23ms 退化到 29s）。
   *
   *  为什么不能每次做「逐位置身份复检」：那要遍历索引里的每个下标并重算 getMessageIdentity，
   *  实测每次约 20ms（3000 条缓存），同样把热路径打死。F-02 的替代方案见 _indexHasIdentity
   *  （只复检命中的候选下标）、has 的「首次未命中复检一次」与 _probeIndexMiss 的两条旋转抽查窗。
   *
   *  最终口径：O(1) 失效检查（引用 / 首元素 / 长度）+ 命中候选复检（F-02）+ 未命中抽查（每数组
   *  版本首次未命中重建一次 + 每次未命中旋转抽查引用层 32 个 / 身份层 2 个位置）+
   *  针对性的「下标越界加固」，另提供 _indexHasIdentityDirect 作为零索引的正确性对照入口
   *  （慢路径 / 测试用）。 */
    _identityIndexIsStale (entry, messages) {
      if (!entry || entry.ref !== messages) return true
      if (entry.len !== messages.length) return true
      return entry.head !== messages[0]
    },

    /** 取该权威数组当前可用的索引条目（必要时重建）。 */
    _identityIndexEntry (messages) {
      const entry = this._identityIndex.get(messages)
      if (this._identityIndexIsStale(entry, messages)) return this._storeIdentityEntry(messages)
      return entry
    },

    /** 从**当前**数组内容重建索引条目并写回 WeakMap（重建即与数组对齐）。 */
    _storeIdentityEntry (messages) {
      const entry = {
        ref: messages,
        head: messages[0],
        len: messages.length,
        idx: this._buildIdentityIndex(messages),
        // 该数组版本是否已做过「未命中后的全量复检」：见 has。
        missVerified: false,
        // 元素引用快照（_probeIndexMiss 引用层宽窗用；只存引用，不复制元素内容）。
        posRefs: messages.slice(),
        // 两条旋转抽查游标（该数组版本内单调推进，重建即归零）。
        refCursor: 0,
        identityCursor: 0
      }
      this._identityIndex.set(messages, entry)
      return entry
    },

    /** 抽查用：位置 i 是否在索引里按 ident 的**全部**维度登记。
   *  与 _buildIdentityIndex 的写入维度一一对应（id → idByKey，另带 url 时 → idWithUrl；纯 url →
   *  urlOnly；anon → anonByKey）。任一应登记的维度缺位即说明「当前元素」与索引不一致——调用方
   *  在原位置换了元素或改了 id/url 字段，而索引还是旧的。 */
    _indexHasPosition (idx, ident, i) {
      const at = (set) => !!set && set.has(i)
      if (ident.kind === 'id') return at(idx.idByKey.get(ident.idKey)) && (!ident.url || at(idx.idWithUrl.get(ident.url)))
      if (ident.kind === 'url') return at(idx.urlOnly.get(ident.url))
      return at(idx.anonByKey.get(ident.key))
    },

    /** 未命中后的**有界**抽查（F-02 残留闭合，R6）：数组被调用方原地改写（换元素 / 改 id、url
   *  字段）时引用、长度、首元素引用都不变，O(1) 失效检查与「命中候选复检」都看不见——索引里根本
   *  没有新身份的下标，候选集为空。这里用两条旋转游标窗，每窗位置数恒定（**不做** O(n) 全表扫描）：
   *    · 引用层宽窗（IDENTITY_INDEX_REF_PROBE_WINDOW，纯指针比较 ~ns）：原位换成另一个元素对象，
   *      此时索引里的下标指向的是**旧对象**、新身份根本没登记 ⇒ diverged；
   *    · 身份层窄窗（IDENTITY_INDEX_IDENTITY_PROBE_WINDOW，每位置重算 getMessageIdentity ~µs）：
   *      同一对象上改 id/url 字段（引用不变）；同时兼任正命中通道（与 _indexHasIdentityDirect
   *      同序调用 sameMessageIdentity，命中即真）。
   *  自愈上界：引用层 ceil(n/REF)、身份层 ceil(n/IDENTITY) 次未命中走完一轮抽查；两条窗都覆盖 n
   *  时（小数组）首次未命中即精确。期间方向为「多推」（SYSTEM_CONTRACT 允许），且不会比修复前更差。
   *  安全性：本函数只可能**触发重建**（重建即与当前数组对齐、答案仍由逐候选复检给出）或直接给出
   *  正命中，因此不会让 has() 返回与线性扫描 oracle 相反的答案。 */
    _probeIndexMiss (entry, messages, message) {
      const n = messages.length
      if (n === 0) return { hit: false, diverged: false }
      const b = Utils.getMessageIdentity(message)
      if (!b.valid) return { hit: false, diverged: false }
      // ① 引用层宽窗：廉价，先跑（一次指针比较就能发现整块换元素）。
      const refs = entry.posRefs
      const full = n <= IDENTITY_INDEX_PROBE_FULL_MAX
      if (refs && refs.length === n) {
        const width = full ? n : Math.min(n, IDENTITY_INDEX_REF_PROBE_WINDOW)
        const from = this._probeCursorOf(entry, 'refCursor', n)
        for (let step = 0; step < width; step++) {
          const i = (from + step) % n
          if (messages[i] !== refs[i]) {
            entry.refCursor = (i + 1) % n
            return { hit: false, diverged: true }
          }
        }
        entry.refCursor = (from + width) % n
      }
      // ② 身份层窄窗：需重算身份，宽度决定每次未命中的额外代价。
      const width = full ? n : Math.min(n, IDENTITY_INDEX_IDENTITY_PROBE_WINDOW)
      const from = this._probeCursorOf(entry, 'identityCursor', n)
      for (let step = 0; step < width; step++) {
        const i = (from + step) % n
        const a = Utils.getMessageIdentity(messages[i])
        if (Utils.sameMessageIdentity(messages[i], message, a, b)) {
          entry.identityCursor = (i + 1) % n
          return { hit: true, diverged: false }
        }
        if (a.valid && !this._indexHasPosition(entry.idx, a, i)) {
          entry.identityCursor = (i + 1) % n
          return { hit: false, diverged: true }
        }
      }
      entry.identityCursor = (from + width) % n
      return { hit: false, diverged: false }
    },

    /** 读旋转抽查游标（缺失/越界/非整数一律归零，便于重建后从 0 起扫）。 */
    _probeCursorOf (entry, key, n) {
      const v = entry[key]
      return (Number.isInteger(v) && v >= 0 && v < n) ? v : 0
    },

    /** Ensure 预计算索引可用：命中且未失效直接复用，否则重建并写回。
   *  保留此入口（返回 idx）供既有调用方使用；需要未命中复检的调用方走 _identityIndexEntry。 */
    _cachedIndexFor (messages) {
      return this._identityIndexEntry(messages).idx
    },

    /** 判重正确性对照入口（无索引）：线性扫描 + 逐条身份比较，语义与 _indexHasIdentity 等价。
   *  O(n) 且不做任何索引缓存，专供测试/诊断在「索引可能陈旧」的场景下取得权威答案
   *  （见 _identityIndexIsStale 的失效边界说明）。热路径仍走 _cachedIndexFor。 */
    _indexHasIdentityDirect (messages, message) {
      const b = Utils.getMessageIdentity(message)
      if (!b.valid) return false
      for (let i = 0; i < messages.length; i++) {
        const a = Utils.getMessageIdentity(messages[i])
        if (Utils.sameMessageIdentity(messages[i], message, a, b)) return true
      }
      return false
    },

    has (message, filename) {
    // 与 save 一致：先做条目有效性校验，无效 message（null/原始值/数组）直接判不存在，
    // 不依赖 getMessageIdentity 的隐式容错。
      if (!Utils.isValidItem(message)) return false
      const filePath = this.getFilePath(filename)
      const messages = this.readMessages(filePath)
      // F-02：索引命中必须按**当前**元素复检（_indexHasIdentity 传 messages），否则调用方原地
      // 改写非首元素后 has() 会把已不存在的身份判为「已存在」→ 漏推。
      let entry = this._identityIndexEntry(messages)
      if (this._indexHasIdentity(entry.idx, message, messages)) return true
      // 未命中：先做**有界抽查**（_probeIndexMiss，O(min(n, W))）。命中候选复检只覆盖「索引里仍
      // 登记着的」身份；「原地写入的新身份」在索引里没有下标（候选集为空），只能靠抽查/重建兜住。
      const probe = this._probeIndexMiss(entry, messages, message)
      if (probe.hit) return true
      // 索引层命中但候选复检失配、或抽查发现当前元素与索引不一致（diverged）⇒ 数组被原地改写、
      // 索引已陈旧：立刻重建（自愈），否则后续查询会继续拿陈旧索引给答案；本数组版本**首次**未命中
      // 同样重建一次，覆盖另一侧陈旧（原地写入的新身份在旧索引里查不到，只会多推，但同样与线性
      // 扫描不一致）。
      // 代价：每个数组版本至多一次 O(n) 重建 + 每次未命中一次 O(W) 抽查（重建次数上界由
      // test_filter/test_message_store_utils 的 builds <= 2 守位）。改为「每次未命中都重建」会让
      // 5000 条批量判重退化成 O(n²)——即 B8 实测的打死热路径形态，故刻意不做。
      if (probe.diverged || this._indexHasIdentity(entry.idx, message) || !entry.missVerified) {
        entry = this._storeIdentityEntry(messages)
        entry.missVerified = true
        if (this._indexHasIdentity(entry.idx, message, messages)) return true
      }
      // P4（CodeAnt）：消息数组未命中时查墓碑——被裁剪记录的判重身份不丢
      return this._tombstoneHasIdentity(filePath, message)
    },

    save (message, filename) {
    // 单条写入走同一统一身份/事务路径，同时保留 _upsert 作为单条缓存 API 的可达实现。
      if (!Utils.isValidItem(message)) return false
      // P3：拒绝空对象/空身份——isValidItem 只保证"对象且非数组"，空对象 {} 或缺失 id/url/key 的
      // 条目会被 anonKey 退化为恒定键；这里在入口一并拒绝（与 saveBatch/_upsert 的 identity.valid
      // 口径一致），既避免把无意义条目带 timestamp 写进缓存，也避免在读盘/落盘前多一次磁盘 IO。
      if (!Utils.getMessageIdentity(message).valid) return false
      const filePath = this.getFilePath(filename)
      const messages = [...this.readMessages(filePath)]
      // 读失败保守处理：磁盘缓存读取失败（ioError/unsafe）时返回的是 []，若直接落盘会把
      // 未读到的存量数据全量覆盖丢失；此时拒绝写入并提示，等待下次成功读取后恢复。
      if (this._readFailed[filePath]) {
        console.error(`缓存读取失败，跳过写入以保护存量数据 ${filePath}`)
        return false
      }
      // 内容未变化（判重命中且数据一致）时不重写磁盘、不刷新 timestamp。
      if (!this._upsert(messages, message, filename)) return true
      return this.saveMessages(filePath, messages)
    },

    /** 批量写入：一次性 append 多条消息，只触发一次磁盘写入（用于单次运行内的多条新数据）
   *  P3（审查 2026-09-15）返回值口径已统一：与 save/saveMessages 一致返回布尔。
   *  true  = 本次变更已落盘（或无需落盘：空入参/无有效新增/内容未变）；
   *  false = 因保护性拒绝（读失败闸门/写入被拒）或落盘失败，本次变更未持久化。
   *  调用方不得再用「无返回值」推断成功——落盘失败同时有 console.warn 可观测。 */
    saveBatch (newMessages, filename) {
    // 公开 API 防御：批量输入必须是数组；对象/数字/Symbol 等不可迭代值不能直接进入 for·of。
      if (!Array.isArray(newMessages) || newMessages.length === 0) return true
      const filePath = this.getFilePath(filename)
      // readMessages 可能返回进程内内存缓存权威数组；先复制，避免落盘失败前原地污染内存缓存。
      const messages = [...this.readMessages(filePath)]
      // v3.249：与 save 同口径——缓存读取失败（ioError/unsafe/_readFailed）时拒绝覆写，
      // 避免把未读到的存量数据全量覆盖销毁去重缓存。注意：必须先 readMessages 再检查
      // _readFailed（置位发生在 readMessages 内部），检查必须在读取之后，否则首次调用
      // 会绕过守卫直接覆写损坏文件（此前先判后读的时序漏洞）。
      if (this._readFailed[filePath]) {
        console.error(`缓存读取失败，跳过批量写入以保护存量数据 ${filePath}`)
        return false
      }
      // 统一身份索引：每个键保存可能命中的 index 集合；更新时保留历史候选，查询时按当前身份校验，
      // 避免复杂的删除/重建逻辑在同 id/同 URL 脏缓存场景下产生索引分裂。
      // [PERF-C1] identity 是 message 的确定性纯函数：单批内按位置顺序逐个登记并缓存身份
      // （下方 messages.forEach 是顺序写入，不是并行），firstIndex 候选匹配直接读缓存，
      // 避免对同一存量消息重复走 validUrl 校验链。
      // 不变量：identOf[i] 恒等于 getMessageIdentity(messages[i])。任何改写 messages[i] 的路径
      // （更新/新增）都必须经 setPosition/pushRegistered 写入，让缓存与索引集合同步；漏登记会让候选匹配
      // 读到旧身份（静默误判为「新消息」而重复收录）。该不变量由 test_filter.js「同批内身份缓存同步」
      // 三条用例确定性锁定：先更新位置后匹配 / 先新增位置后匹配 / urlOnlyMap 候选（c2 分支），
      // 用例名均以「（identOf 漂移必失败）」结尾。随机对比用例（「saveBatch 索引判重 vs 逐条 upsert」
      // 单批 60 条、「30 轮随机」多批每批 ≤11 条）批内同样会发生「写位置 → 再匹配」，只能概率性咬住；
      // 纯跨批用例（「更新后索引维护（id 变化/url 失效）」）咬不住——每次 saveBatch 都按 messages
      // 重建 identOf，漂移不跨批传播。
      const identOf = new Array(messages.length)
      const firstIndex = (map, key, match) => {
        const set = map.get(key)
        if (!set) return undefined
        let first
        for (const i of set) {
          if (i < 0 || i >= messages.length) continue
          if (!match(messages[i], i)) continue
          if (first === undefined || i < first) first = i
        }
        return first
      }
      const idMap = new Map()
      const urlMap = new Map()
      const urlOnlyMap = new Map()
      const identityMap = new Map()
      // 身份登记唯一入口：identOf 缓存与四类索引在此一并更新（不写 messages），
      // 避免各处各写一遍导致「缓存与 messages 漂移」。承诺边界须收窄到「identOf 必须与 messages
      // 同步」这条真正承重的不变量（回归用例锁定的也只有它）；四类索引只是查询加速器——删除路径
      // 漏删留下的陈旧候选会被 firstIndex 回调里按 identOf 的复检滤掉，属可自愈的性能问题、
      // 行为不可观测，故不为「索引陈旧」补行为断言（那种断言只能靠耦合私有实现才咬得住）。
      const addIdentityIndexes = (message, i) => {
        const identity = Utils.getMessageIdentity(message)
        identOf[i] = identity
        if (!identity.valid) return
        Utils.addIndex(identityMap, identity.key, i)
        if (identity.kind === 'id') Utils.addIndex(idMap, identity.idKey, i)
        if (identity.url) Utils.addIndex(urlMap, identity.url, i)
        if (identity.kind === 'url') Utils.addIndex(urlOnlyMap, identity.url, i)
      }
      // 写入路径的唯一位置入口（更新走这里，新增走下方 pushRegistered）：messages[i] 与其身份
      // 登记一次写完，让「identOf[i] 恒等于 getMessageIdentity(messages[i])」由构造保证——
      // 写入路径只要走这里，就不可能「改了 messages 却忘了登记」。
      const setPosition = (i, message) => {
        messages[i] = message
        addIdentityIndexes(message, i)
      }
      // 追加写入唯一入口：先 push 再登记末尾位置（push 之后 messages.length - 1 即新位置）。
      const pushRegistered = (message) => {
        messages.push(message)
        addIdentityIndexes(message, messages.length - 1)
      }
      // [PERF-C1] 删除索引所需身份直接取调用点已缓存的位置身份：不变量保证 identOf[i] 与
      // getMessageIdentity(messages[i]) 等价，不再重算（免去对同一条存量消息第二次走最贵的
      // validUrl 校验链）。缓存对象只被读（valid/key/idKey/url/kind），不被修改。
      // 合法调用点不可能命中下方守卫：i 恒落在 [0, messages.length)——存量位置由下方 messages.forEach
      // 全量登记、批内改写位置由 setPosition/pushRegistered 重新登记，且 getMessageIdentity 恒返回
      // 对象，故 identOf[i] 要么是「已登记的身份对象」，要么就是登记路径被改坏后的 undefined，
      // 没有第三种（messages 来自 JSON.parse 与构造写入，不存在空洞位置）。
      // 显式守卫而不兜底（identOf[i] || {}、?? {}）：兜底会把「漏登记」静默降级成「按无效身份跳过
      // 删索引」，让 test_filter.js「同批内身份缓存同步（identOf 漂移必失败）」用例失去咬合力——
      // 身份缓存漏刷新不再是响亮失败，而是静默误判为「新消息」重复收录，正是本项目明确要避免的
      // 「静默兜底导致假绿」形态。故此处须响亮失败，且错误信息指向不变量本身：否则抛出的 TypeError
      // 堆栈会停在 removeIdentityIndexes 内部，把排查方向引偏。
      const removeIdentityIndexes = (i) => {
        const identity = identOf[i]
        if (!identity) throw new Error('[PERF-C1] identOf 与 messages 不同步：位置 ' + i + ' 缺少身份缓存')
        if (!identity.valid) return
        const del = (map, key) => {
          const s = map.get(key)
          if (s) {
            s.delete(i)
            if (s.size === 0) map.delete(key)
          }
        }
        del(identityMap, identity.key)
        if (identity.kind === 'id') del(idMap, identity.idKey)
        if (identity.url) del(urlMap, identity.url)
        if (identity.kind === 'url') del(urlOnlyMap, identity.url)
      }
      // 存量位置在此一次性登记（只读路径，不写 messages）：更新/新增两条写入路径共用上方
      // setPosition/pushRegistered，不变量由构造保证。
      messages.forEach((message, i) => addIdentityIndexes(message, i))
      const NOW = () => this._now()
      let changedAny = false
      let updatedCount = 0 // P3：批内逐条日志降频——改为批尾一条汇总（大批次曾刷屏）
      for (const message of newMessages) {
      // 元素级校验：非对象元素跳过（避免访问 message.id 崩溃）
        if (!Utils.isValidItem(message)) continue
        const identity = Utils.getMessageIdentity(message)
        if (!identity.valid) continue
        let idx = -1
        if (identity.kind === 'id') {
          const c1 = firstIndex(idMap, identity.idKey, (mm, ii) => {
            const ci = identOf[ii]
            return ci.kind === 'id' && ci.idKey === identity.idKey
          })
          const c2 = identity.url
            ? firstIndex(urlOnlyMap, identity.url, (mm, ii) => {
              const ci = identOf[ii]
              return ci.kind === 'url' && ci.url === identity.url
            })
            : undefined
          const cands = [c1, c2].filter(x => x !== undefined)
          if (cands.length) idx = Math.min(...cands)
        } else if (identity.kind === 'url') {
          const u = firstIndex(urlMap, identity.url, (mm, ii) => {
            const ci = identOf[ii]
            return !!ci.url && ci.url === identity.url
          })
          if (u !== undefined) idx = u
        } else {
          const a = firstIndex(identityMap, identity.key, (mm, ii) => identOf[ii].key === identity.key)
          if (a !== undefined) idx = a
        }
        if (idx === undefined) idx = -1
        if (idx >= 0) {
          const oldM = messages[idx]
          // v3.156：比较排除 timestamp——曾因 oldM 有 timestamp、message 无而内容相同也必报"更新缓存记录"
          // P3 优化：复用 _contentChangedIgnoringTs（先浅层短路、后键序无关深排），与 _upsert 口径一致
          const changed = this._contentChangedIgnoringTs(oldM, message)
          if (!changed) continue // 内容完全一致：不更新、不刷新 timestamp、不触发落盘（与 _upsert 口径一致）
          updatedCount++
          changedAny = true
          removeIdentityIndexes(idx)
          setPosition(idx, { ...Utils.safeObjectCopy(message), timestamp: NOW() })
        } else {
        // P4（CodeAnt）：身份已在墓碑（曾被裁剪且已推送过）→ 不重复收录，防重放
          if (this._tombstoneHasIdentity(filePath, message)) continue
          changedAny = true
          // [PERF-C1] 新位置与更新路径共用同一写入入口 setPosition/pushRegistered，
          // identOf 与索引集合不会各写一遍而漂移。
          pushRegistered({ ...Utils.safeObjectCopy(message), timestamp: NOW() })
        }
      }
      if (!changedAny) return true
      // v3.x q9：捕获落盘结果——saveMessages 在序列化/写入失败时返回 false，
      // 忽略返回值会让落盘失败被静默吞掉，仅保留内存快照。
      const saved = this.saveMessages(filePath, messages)
      if (!saved) {
      // P3（审查 2026-08-15）：原文案「仅保留内存快照」误导——saveMessages 失败路径实际把内存
      // 快照回滚到写入前状态，本批变更既不落盘也不在内存；改为如实描述。
        console.warn('缓存落盘失败，本次变更已回滚（内存与磁盘均保持旧快照） ' + filePath)
      } else if (updatedCount > 0) {
      // P3：批尾一条汇总日志替代逐条刷屏（大批次场景）——落盘成功后再报（CodeRabbit：失败不报"已更新"）
        console.log(`缓存批量更新: ${filename} 更新 ${updatedCount} 条`)
      }
      return saved
    },

    getFileName (url) {
    // 防御（R1）：非字符串 url → 可区分坏源(数字/布尔)哈希命名；无信息(空串/对象)保持 default.json
    // v3.157：数字/布尔 String 化可区分（123 vs 456），曾与空串/对象共用 default.json 互相误判重
      if (typeof url !== 'string') {
        let badStr
        try { badStr = String(url) } catch (e) { return 'default.json' }
        if (!badStr || badStr === '[object Object]' || badStr === 'undefined' || badStr === 'null' || badStr === 'true' || badStr === 'false') return 'default.json'
        // v3.249：bad_ 名内嵌坏源字节长 + anonKey(64位) 双重区分——单纯哈希不同坏源存在理论碰撞
        // 会产出同名缓存互相覆盖（P3）；anonKey 已由 32 位升级为两路 djb2 拼接(64位)，再附字节长
        // 进一步把碰撞面收窄到「同长+同哈希」，并让文件名自描述便于排查。开销仅数个字节，
        // getFileName 产物后续经 getFilePath 200 字节截断，不影响路径安全不变量。
        return 'bad_' + Buffer.byteLength(badStr, 'utf8') + '_' + Utils.anonKey(badStr) + '.json'
      }
      if (!url) return 'default.json'
      const parts = url.split('/')
      let name = parts[parts.length - 1].split(/[?#]/)[0] // 去掉查询参数与 hash
      if (!name || /^\.+$/.test(name)) name = 'default' // 空/纯点串兜底，避免 '..' → '...json'
      name = name.replace(/[\\/:*?"<>|]/g, '_') // 清洗文件系统保留字符（P3：补 ? 与 getFilePath 口径对齐）
      name = name.replace(/[\u0000-\u001f]/g, '') // 过滤控制字符
      if (!name) name = 'default' // 清洗后复检空串：末段全为控制字符时避免生成隐藏文件 '.json'
      // P3（审查 2026-09-15）：末段字面以点开头（如 URL 末段 '.json'/'.hidden'）不命中上方
      // 兜底分支，会经 getFilePath 在缓存目录生成隐藏文件（文件名以点开头，ls 不可见、运维
      // 排查易漏）。补前缀 'url_' 落地防护；这只改变这些 URL 的缓存文件名，不改判重语义
      // （判重身份来自消息内容/URL 本身，与缓存文件名无关），已存在的隐藏文件由启动清理
      // 的残留回收与下一次写入自然迁移。
      // F7 回归（R4/V6）：只给「以点开头」的名字加前缀会与该前缀自身的合法名字撞名——
      // getFileName('https://x/.json') 与 getFileName('https://x/url_.json') 都是 'url_.json'
      // → 两个不同 pushUrl 共用同一缓存文件（互相覆盖判重记录）。两条前缀规则合并为
      // 「以 . 或 url_ 开头 ⇒ 前置 url_」：该映射是单射——像集恒以 'url_' 开头，
      // '.'-来源 → 'url_.' + …，'url_'-来源 → 'url_url_' + …，二者不相交，且不以 'url_'
      // 开头的普通名字不会落进像集。
      if (name.startsWith('.') || name.startsWith('url_')) name = 'url_' + name
      if (!name.endsWith('.json')) name += '.json'
      return name
    }
  }

  return MessageStore
}

module.exports = {
  createMessageStore,
  resolveCacheDirInRoot,
  IDENTITY_INDEX_REF_PROBE_WINDOW,
  IDENTITY_INDEX_IDENTITY_PROBE_WINDOW
}
