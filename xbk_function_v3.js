//******** 线报酷推送脚本 v3.207 — WxPusher 多应用分流 ********
// 按职责分层：配置 → 工具 → 格式化 → 规则 → 过滤 → 缓存 → 网络 → 推送 → 主流程

'use strict';

// ============================================================
// 📦 外部依赖
// ============================================================
const notify = require('./xbk_sendNotify_slim');
const fs = require('fs');
const { fetchJson } = require('./xbk_http');
const path = require('path');
// 版本号一致性由 package.json、文件头和 CHANGELOG 的测试自动校验
// 缺 package.json 时回退 '3.x'（移植性防御）
let PKG_VERSION = '3.x';
try { PKG_VERSION = require('./package.json').version; } catch (e) { /* package.json 缺失时用默认 */ }

// ============================================================
// ⚙️ Config — 配置层
// ============================================================
const Config = {
    domain: 'https://new.ixbk.net',

    api: {
        // v3.94：domain 尾斜杠防御——`https://x.com/` + 路径曾拼成 `//plus/...` 双斜杠 404
        // R2：domain 非字符串（数字/对象脏配置）→ 空串（避免 getter 内 .replace 崩溃）
        get pushUrl() { return `${(typeof Config.domain === 'string' ? Config.domain.trim().replace(/\/+$/, '') : '')}/plus/json/push.json`; }, // v3.158: domain trim
        timeout: 5000,
        retry: 2,
    },

    filter: {
        // v3.176：默认不再携带个人过滤配置（'美妆' 曾硬编码于此——克隆用户意外继承屏蔽）。
        // 需要屏蔽分类请自行配置，例如：pingbifenlei: '美妆'
        pingbifenlei: '',
        pingbibiaoti: '',
        zhanxianbiaoti: '',
        pingbibiaotiplus: '',
        pingbineirong: '',
        zhanxianneirong: '',
        pingbineirongplus: '',
        pingbilouzhu: '',
        zhanxianlouzhu: '',
        pingbilouzhuplus: '',
        pingbitime: '5',
    },

    keyword: {
        zkt_gjc: '',
    },

    timing: {
        pushInterval: 100,
        finalWait: 200,
    },

    // 推送模式：sequential=顺序逐条 | parallel=并行一次推送(默认)
    // parallelLimit：并行并发上限，0=不限制(全量一次发出)，N>0=每批 N 条
    // titleMax/contentMax：推送截断长度（v3.69 可配置；各通道 API 限制不一，如 Server酱 title 限 32 字符）
    push: {
        mode: 'parallel',
        parallelLimit: 0,
        titleMax: 100,
        contentMax: 3000,
        // v3.129：单次推送上限（防接口异常返回海量 → 推送风暴/长时间运行；正常 ~20 条无影响）
        maxPerRun: 100,
    },

    // 推送模板（v3.68 可配置）：title=标题、content=内容；默认值与历史硬编码完全一致。
    // 支持占位符：{分类名} {分类ID} {标题} {链接} {日期} {时间} {楼主} {类目} {价格} {商城} {品牌} {图片} {Html内容} {Markdown内容}
    template: {
        title: '【{分类名}】{标题}',
        content: '{Markdown内容}',
    },

    cache: {
        // v3.120 上限 100 → 10000：真实接口 N 固定 ~20 条，查询量 N×M=20 万次可接受（实测 35ms）
        maxSize: 10000,
        dir: 'xianbaoku_cache',
    },

    // v3.123：接口异常告警——接口挂/密钥失效时主动通知本人（防"跑了但没推没人知道"）
    // enabled: 开关；intervalMs: 限频（同错误间隔内不重复轰炸，默认 1 小时）
    alert: {
        enabled: true,
        intervalMs: 3600000,
    },

    // v3.125：运行日报——每天一条推送汇总（前一天统计），不用翻 run.log
    report: {
        enabled: true,
    },

    // 磁盘余量监测：仅告警，不阻断推送；不支持 statfs 的旧 Node/平台自动跳过。
    storage: {
        minFreeBytes: 50 * 1024 * 1024,
    },
};

// ============================================================
// 🔧 Utils — 工具层
// ============================================================
// ============ 过滤正则字段(compileRules/validateConfig 共用，加字段改一处) ============
const FILTER_FIELDS = [
    'pingbifenlei', 'pingbibiaoti', 'zhanxianbiaoti',
    'pingbibiaotiplus', 'pingbineirong', 'zhanxianneirong',
    'pingbineirongplus', 'pingbilouzhu', 'zhanxianlouzhu',
    'pingbilouzhuplus',
];

// ============ 魔法数字常量 ============
const DAY_MS = 24 * 60 * 60 * 1000;           // 一天的毫秒数
const TS_BOUND = 1e11;                         // 秒/毫秒时间戳分界（10位秒 / 12+位毫秒）
const MAX_CODE_POINT = 0x10FFFF;               // Unicode 最大码点
const SURROGATE_LO = 0xD800;                   // 代理区起点
const SURROGATE_HI = 0xDFFF;                   // 代理区终点
const DEFAULT_MAX_SIZE = 10000;                 // 缓存默认上限（v3.120：100 → 10000）

// 实体映射与正则提升为模块级常量（避免每次调用重建）
const ENTITY_MAP = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    '&hellip;': '…', '&mdash;': '—', '&copy;': '©', '&reg;': '®', '&trade;': '™',
    '&euro;': '€', '&times;': '×', '&divide;': '÷', '&middot;': '·', '&deg;': '°',
    '&plusmn;': '±', '&laquo;': '«', '&raquo;': '»',
    '&ndash;': '–', '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”',
    '&bull;': '•', '&sect;': '§', '&para;': '¶', '&pound;': '£', '&yen;': '¥',
    // v3.83 扩展：高频遗漏实体（空白变体与箭头/货币符号）
    '&ensp;': ' ', '&emsp;': ' ', '&cent;': '¢', '&curren;': '¤',
    '&larr;': '←', '&rarr;': '→', '&uarr;': '↑', '&darr;': '↓',
};
const ENTITY_RE = new RegExp('&(?:' + Object.keys(ENTITY_MAP).map(k => k.slice(1, -1)).join('|') + ');', 'g'); // 从 ENTITY_MAP 自动生成，加实体只改一处
const DEC_RE = /&#(\d+);/g;
const HEX_RE = /&#[xX]([0-9a-fA-F]+);/g;

const Utils = {
    /**
     * 统一时间解析：返回毫秒时间戳，无效返回 null。
     * v3.62 统一 daysComputed/tuisong_replace 两份重复逻辑（REVIEW_ROUND10 #26），
     * 解析口径（与 v3.46/v3.47 对齐后的行为完全一致）：
     *   空(undefined/null/'') → null
     *   纯数字：8 位 YYYYMMDD(月份/日期合法性+回读校验) > 秒/毫秒时间戳(0 或 1e8~1e14，TS_BOUND 分界)
     *           > 范围外(小数字/超大数字) → null（避免 1970-01-01/33658 误导日期）
     *   YYYY-MM-DD(1~2 位月日，锚定结尾拒绝脏前缀，回读校验拒绝 2026-02-31) > 回读失败 → null
     *   其他(含 ISO 2026-08-01T00:00:00Z、/ 分隔)：宿主解析，先原生(支持 ISO)失败再试 / 替换 → 失败 null
     * 注意：返回的 ms 可能为负（1969 年以前），由调用方决定语义。
     */
    parseTime(time) {
        if (time === undefined || time === null || time === '') return null;
        let s;
        try { s = String(time); } catch (e) { return null; } // v3.108 fuzz：嵌套 Symbol 数组 String() 崩 → 无效
        // 纯数字：8 位日期优先于时间戳（20260731 是日期不是时间戳）
        // 数字类型（含 -1 等负值）也走数字分支——负值/范围外在下方统一判无效，
        // 避免掉进宿主解析被 new Date('-1') 解析成 2001-01-01（审查5-2 锁定）
        // v3.142：数字形态字符串（含负号/小数）也走数字分支——'-1'/'2026.5' 曾漏到宿主解析成 2001/2026-05
        if (typeof time === 'number' || /^-?\d+(\.\d+)?$/.test(s)) {
            const n = Number(s);
            // 8 位 YYYYMMDD：月份 1~12 / 日期 1~31 预检 + 回读校验（拒绝 20261332 这类非法日期）
            // v3.115 时区修复：Date.UTC 解析——日期是"日粒度"概念，本地时区解析会导致跨时区部署天数差 1（Honolulu 实测）
            const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
            if (m8 && Number(m8[2]) >= 1 && Number(m8[2]) <= 12 && Number(m8[3]) >= 1 && Number(m8[3]) <= 31) {
                const t = new Date(Date.UTC(+m8[1], +m8[2] - 1, +m8[3]));
                if (t.getUTCFullYear() === +m8[1] && t.getUTCMonth() === +m8[2] - 1 && t.getUTCDate() === +m8[3]) return t.getTime();
                return null;
            }
            // 严格八位数字优先按 YYYYMMDD 解释；非法八位日期不能继续落入 n===0 的 Unix 时间戳分支。
            if (/^\d{8}$/.test(s)) return null;
            // 时间戳：0 = 1970-01-01 不应被短路；秒(1e8~TS_BOUND)/毫秒(TS_BOUND~1e14)按 TS_BOUND 分界
            if (n === 0 || (n >= 1e8 && n < 1e14)) {
                const ms = n < TS_BOUND ? n * 1000 : n;
                const t = new Date(ms);
                if (!isNaN(t.getTime())) return t.getTime();
            }
            return null;
        }
        // 严格匹配完整 YYYY-MM-DD（1~2 位月日；锚定结尾，拒绝 2026-07-31abc 脏前缀）
        // v3.115 时区修复：Date.UTC 解析（同 8 位日期）
        const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) {
            const y = +m[1], mo = +m[2], d = +m[3];
            const t = new Date(Date.UTC(y, mo - 1, d));
            // 回读校验：new Date 会把 2026-02-31 滚动到 03-03，回读对比即拒绝
            if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return t.getTime();
            return null;
        }
        // 其他格式（含 ISO 2026-08-01T00:00:00Z、/ 分隔等）回退宿主解析；先原生（支持 ISO），失败再试 / 替换
        // v3.115：无时区标记的本地语义字符串按 UTC 补 Z（纯日期已被上方分支拦截；此处为 'YYYY/MM/DD' 等）
        let t;
        if (!/[T Z]/.test(s) && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
            t = new Date(s.replace(/\//g, '-') + 'T00:00:00Z');
        } else if (!/[Zz]/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s) && (s.includes('T') || /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}/.test(s))) {
            // v3.131：ISO/空格分隔无时区标记（'2026-08-01T10:30:00' / '2026-08-01 10:30:00'）→ 补 Z
            // ——v3.115 只统一了纯日期和 / 分隔，此格式走本地解析致跨时区差 1 天（Honolulu 实测 0 vs UTC 1）
            t = new Date(s.replace(' ', 'T') + 'Z');
        } else {
            t = new Date(s);
        }
        if (isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/')); 
        // v3.171：回退时 T 分隔一并转空格——'2026-8-1T10:30'（单数字月日 T 格式）曾 Invalid 返回 null，
        // 而 '2026-8-1 10:30'（空格格式）宽松解析有效——同类格式不一致；'2026/8/1 10:30' 解析有效
        if (isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/').replace('T', ' '));
        if (isNaN(t.getTime())) return null;
        return t.getTime();
    },

    daysComputed(time) {
        const ms = Utils.parseTime(time);
        if (ms === null) return 0;
        return Utils.daysFrom(ms);
    },

    add0(m) {
        return m < 10 ? '0' + m : '' + m;
    },

    /** 距今天数：UTC 自然日差（今天/未来返回 0）
     *  v3.170：原 24 小时整段（Math.floor((now-ms)/DAY_MS)）——注册时间带具体时刻时少算 1 天
     *  （8/1 23:00 注册 → 当前 24h 段算 1 天、自然日差 2 天，pingbitime 边界错误拦截）；
     *  改按 UTC 日期差；无时刻日期（接口实际格式）两种口径恒等，零行为变更
     */
    daysFrom(ms) {
        const nowMs = Date.now(); // 保持 Date.now()（测试可 fake Date.now 固定\"今天\"）
        const now = new Date(nowMs);
        const dNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const t = new Date(ms);
        const dMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
        return dNow > dMs ? Math.floor((dNow - dMs) / DAY_MS) : 0;
    },

    /** 归一化 URL 用于判重：trim + 去尾部斜杠（/foo 与 foo、foo/ 视为同一资源） */
    normUrl(u) {
        // 归一化用于判重：trim + 去首尾斜杠 + 主机名小写（/foo、foo、foo/、A.com/a vs a.com/a 视为同一资源）
        // v3.108 fuzz：String(嵌套 Symbol 的数组) 崩——统一兜底视为空
        if (u === undefined || u === null) return '';
        let s;
        try { s = String(u); } catch (e) { return ''; }
        s = s.trim();
        // v3.156：去 query/hash（与 getFileName 口径一致）——同一内容带跟踪参数/锚点曾判为不同，重复入库推送
        s = s.split(/[?#]/)[0];
        // 交替去首尾斜杠与 trim 直到稳定（保证幂等：斜杠挡住的尾空格需多轮去除）
        let prev;
        do {
            prev = s;
            s = s.replace(/^\/+|\/+$/g, '').trim();
        } while (s !== prev);
        // 含协议时协议+主机名转小写（路径大小写敏感保留）
        const m = s.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/]+)(.*)$/i);
        if (m) s = m[1].toLowerCase() + m[2].toLowerCase() + m[3];
        return s;
    },

    /** 有效数据条目：对象且非数组（排除 null/原始值/嵌套数组） */
    isValidItem(m) {
        return !!(m && typeof m === 'object' && !Array.isArray(m));
    },

    /** 是否拥有有效 id：仅接受非空字符串与有限数字（布尔/对象/数组/Symbol/NaN 视为无效，避免误合并） */
    hasValidId(m) {
        // v3.107 fuzz 发现：m 本身缺失/非对象时 m.id 会抛 TypeError（公开导出应防御）
        if (m === undefined || m === null || typeof m !== 'object') return false;
        if (m.id === undefined || m.id === null) return false;
        const t = typeof m.id;
        if (t === 'string') return m.id.trim() !== '';
        if (t === 'number') return Number.isFinite(m.id); // 数字 id 有效（含 0，语义依数据源）
        return false; // 布尔/对象/数组/Symbol 等脏数据 id 一律无效
    },

    /** 无 id 无 url 数据的稳定合成 id：基于 title+content 哈希，跨运行可去重 */
    anonKey(...parts) {
        // 过滤空值：避免全空字段导致不同数据撞同一个 key
        // v3.108 fuzz 发现：String(Symbol()) 抛 TypeError——Symbol 字段视为无效过滤
        const str = (p) => {
            if (typeof p === 'symbol') return '';
            try { return String(p); } catch (e) { return ''; }
        };
        const s = parts.filter(p => p !== undefined && p !== null && str(p).trim() !== '').map(str).join('|');
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return 'anon:' + h.toString(16);
    },

    /** v3.159：过滤规则稳定哈希（过滤字段固定顺序 + 只看它关键词）——规则变更时用于失效「过滤写入」缓存 */
    filterHash(filterCfg, zktGjc) {
        const parts = [];
        const safeStr = (v) => {
            if (v === undefined || v === null || typeof v === 'symbol') return '';
            try { return String(v); } catch (e) { return ''; }
        };
        for (const f of FILTER_FIELDS) {
            const v = filterCfg && filterCfg[f];
            parts.push(f + '=' + safeStr(v));
        }
        // v3.161：补 pingbitime——曾漏（FILTER_FIELDS 不含它），改宽 pingbitime 后「过滤写入」缓存不失效，
        // 被天数过滤的旧条目不重推（#7，与 v3.159 #2 同 class 疏漏）；哈希原始字符串（含多行###形式）
        const pb = filterCfg && filterCfg.pingbitime;
        parts.push('pingbitime=' + safeStr(pb));
        parts.push('zkt_gjc=' + safeStr(zktGjc));
        const s = parts.join('\u0001');
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return String(h);
    },

    /** 数字实体解码统一：NUL 过滤 / 代理区与超范围保留原文 */
    _decodeNumeric(n, original) {
        if (n === 0) return '';
        return (n > 0 && n <= MAX_CODE_POINT && !(n >= SURROGATE_LO && n <= SURROGATE_HI))
            ? String.fromCodePoint(n) : original;
    },

    /**
     * UTF-16 安全截断：按码元截断但不在代理对中间切断（避免半个 emoji 乱码）
     * 末尾高代理→退一位；末尾低代理且前一位非高代理(孤立)→退一位；配对完整低代理→保留
     * v3.175：ZWJ 序列/变体选择符/组合字符同样不切断——👨👩👧👦 截断曾拆散家庭 emoji、
     * ❤️ 丢 VS16、é 丢重音；统一循环退位（代理对 + 修饰符 + 末尾 ZWJ）
     */
    truncateUtf16(s, max) {
        try { s = String(s === undefined || s === null ? '' : s); } catch (e) { s = ''; } // v3.108 fuzz：嵌套 Symbol 数组 String() 崩 → 空
        // 防御（R1）：非法 max（undefined/NaN/0/负数）不截断——内部调用均传合法值，零行为变更；
        // 否则 slice(0, undefined) 意外整串返回 / slice(0,0) 空串 / slice(0,-N) 误截尾字符
        if (!Number.isFinite(max) || max <= 0) return s;
        if (s.length <= max) return s;
        let cut = s.slice(0, max);
        // 修饰符判定：作用于前一字符的 Unicode 修饰符（ZWJ/变体选择符/组合音标/组合符号）
        const isModifier = (c) => c === 0x200D || (c >= 0xFE00 && c <= 0xFE0F)
            || (c >= 0x0300 && c <= 0x036F) || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF)
            || (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F);
        while (cut.length > 0) {
            const last = cut.charCodeAt(cut.length - 1);
            // 代理对：完整低代理对保留；高代理/孤立低代理退位
            if (last >= SURROGATE_LO && last <= SURROGATE_HI) {
                if (last >= 0xDC00) {
                    const prev = cut.charCodeAt(cut.length - 2);
                    if (prev >= SURROGATE_LO && prev <= 0xDBFF) break; // 配对完整，保留
                }
                cut = cut.slice(0, -1);
                continue;
            }
            // 末尾 ZWJ 本身退位（连接符不应做结尾）
            if (last === 0x200D) { cut = cut.slice(0, -1); continue; }
            // 截断点后是作用于上一字符的修饰符 → 退位（避免拆散 ❤️ / é）
            const next = s.charCodeAt(cut.length);
            if (isModifier(next)) { cut = cut.slice(0, -1); continue; }
            break;
        }
        return cut;
    },

    // 清洗孤立代理（v3.110 fuzz 发现）：encodeURIComponent 对孤立代理抛 URIError → 推送失败。
    // 孤立高/低代理替换为 U+FFFD（完整代理对保留）；脏数据/截断 emoji 的真实防御
    sanitizeSurrogates(s) {
        try { s = String(s === undefined || s === null ? '' : s); } catch (e) { return ''; }
        return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
    },

    /**
     * 数值配置统一转换（v3.158）：环境变量/配置文件传入的数字都是字符串——Number.isFinite('5')=false
     * 曾全部回退默认(api.retry/parallelLimit/titleMax 等 7 处失效)；'5'→5，'abc'/undefined→默认
     */
    num(v, def) {
        // 空值/空白/布尔值不是有效数值配置：避免 alert.intervalMs='' 被 Number('') 转成 0，
        // 从而意外关闭限频；显式字符串 '0' 仍保留 0 的特殊语义。
        if (v === undefined || v === null || typeof v === 'boolean') return def;
        if (typeof v === 'string' && v.trim() === '') return def;
        let n;
        try { n = Number(v); }
        catch (e) { return def; } // Symbol / valueOf 抛错等脏配置回退默认，不中断主流程
        return Number.isFinite(n) ? n : def;
    },

    /** 返回路径所在文件系统的容量信息；平台/Node 不支持时返回 null，不影响主流程。 */
    diskSpace(targetPath) {
        const statfs = fs.statfsSync;
        if (typeof statfs !== 'function') return null;
        try {
            const st = statfs(targetPath);
            const bsize = Number(st.bsize || st.frsize || 0);
            const bavail = Number(st.bavail);
            const blocks = Number(st.blocks);
            if (!Number.isFinite(bsize) || bsize <= 0 || !Number.isFinite(bavail) || bavail < 0) return null;
            return {
                freeBytes: bsize * bavail,
                totalBytes: Number.isFinite(blocks) && blocks >= 0 ? bsize * blocks : null,
            };
        } catch (e) {
            return null;
        }
    },

    /** 判断 URL 是否为危险协议（先解码实体，兼容 javascript&#58; 等编码绕过） */
    isDangerousUrl(url) {
        if (url === undefined || url === null) return false;
        let s;
        try { s = String(url); } catch (e) { return false; }
        // 去除 ASCII 控制空白，防止 `java\nscript:`/`java\tscript:` 等内部空白绕过协议检查
        s = this.decodeHtmlEntities(s).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
        return /^(javascript|vbscript|data):/.test(s);
    },

    /** 清洗 HTML href/src 中的危险协议，保留标签和普通文本 */
    sanitizeHtmlUrls(html) {
        if (html === undefined || html === null) return '';
        try { html = String(html); } catch (e) { return ''; }
        const cleanAttr = (name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`;
        html = html.replace(/\b(href|src)\s*=\s*(["'])([\s\S]*?)\2/gi, (_, name, quote, value) => cleanAttr(name, quote, value));
        return html.replace(/\b(href|src)\s*=\s*([^\s"'<>`]+)/gi, (_, name, value) => this.isDangerousUrl(value) ? `${name}=""` : `${name}=${value}`);
    },

    /** 实体解码后再次清理主动 HTML/事件属性，防止 &lt;script&gt; 重新形成可执行标签 */
    sanitizeDecodedHtml(html) {
        if (html === undefined || html === null) return '';
        try { html = String(html); } catch (e) { return ''; }
        // HTML tokenizer 将 NUL 替换为 U+FFFD；先移除可被用来拆散属性名的 NUL，
        // 让 `on\u0000error` 收敛为 `onerror` 后进入统一事件属性清理。
        html = html.replace(/\u0000/g, '');
        html = this.sanitizeHtmlUrls(html)
            // 成对和未闭合的主动标签都处理：不依赖恶意输入自觉补齐闭合标签。
            .replace(/<(?:script|style|iframe|object|svg|math)\b[\s\S]*?<\/(?:script|style|iframe|object|svg|math)\s*>/gi, '')
            .replace(/<(?:script|style|iframe|object|embed|svg|math)\b[^>]*>/gi, '')
            .replace(/<\/(?:script|style|iframe|object|svg|math)\s*>/gi, '')
            // 基础/外链/刷新标签可改变文档导航或加载外部资源，HTML 推送不需要它们。
            .replace(/<(?:base|link|meta)\b[^>]*>/gi, '')
            .replace(/(?:\s|\/)on[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        const cleanUrlAttr = (name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`;
        html = html
            // 覆盖 href/src 之外的可导航/可加载属性（xlink:href、formaction、poster 等）。
            .replace(/\b(xlink:href|formaction|action|poster|cite|background|dynsrc|lowsrc)\s*=\s*(["'])([\s\S]*?)\2/gi,
                (_, name, quote, value) => this.isDangerousUrl(value) ? `${name}=${quote}${quote}` : `${name}=${quote}${value}${quote}`)
            .replace(/\b(xlink:href|formaction|action|poster|cite|background|dynsrc|lowsrc)\s*=\s*([^\s"'<>`]+)/gi,
                (_, name, value) => this.isDangerousUrl(value) ? `${name}=""` : `${name}=${value}`)
            // srcset 可在候选项中藏危险协议；检测到任意危险候选即清空整个属性。
            .replace(/\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi, (_, quote, value) => {
                const v = this.decodeHtmlEntities(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
                return /(?:^|[,])(?:javascript|vbscript|data):/.test(v) ? `srcset=${quote}${quote}` : `srcset=${quote}${value}${quote}`;
            })
            .replace(/\bsrcset\s*=\s*([^\s"'<>`]+)/gi, (_, value) => {
                const v = this.decodeHtmlEntities(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
                return /^(?:javascript|vbscript|data):/.test(v) ? 'srcset=""' : `srcset=${value}`;
            })
            // CSS url()/expression()/behavior 可形成主动加载或脚本执行路径；不需要保留这类 style。
            .replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_, quote, value) => {
                const v = this.decodeHtmlEntities(value).toLowerCase();
                return /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/.test(v)
                    ? `style=${quote}${quote}` : `style=${quote}${value}${quote}`;
            })
            .replace(/\bstyle\s*=\s*([^\s"'<>`]+)/gi, (_, value) => {
                const v = this.decodeHtmlEntities(value).toLowerCase();
                return /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/.test(v)
                    ? 'style=""' : `style=${value}`;
            });
        return html;
    },

    /** 解码常见 HTML 实体 */
    decodeHtmlEntities(str) {
        if (str === undefined || str === null) return '';
        try { str = String(str); } catch (e) { return ''; } // v3.108 fuzz：嵌套 Symbol 数组 String() 崩 → 视为空
        if (!str) return str;
        // 递归解码（v3.105）：真实接口存在双重转义（&amp;amp; → &amp; → &，真机验证发现 2/20 条），
        // 单轮解码会残留 &amp; 破坏 URL 参数（链接 key 参数错乱）；最多 3 轮防死循环，收敛即停
        for (let i = 0; i < 3; i++) {
            const next = str
                .replace(ENTITY_RE, m => ENTITY_MAP[m] || m)
                .replace(DEC_RE, (_, code) => this._decodeNumeric(Number(code), `&#${code};`))
                .replace(HEX_RE, (_, hex) => this._decodeNumeric(parseInt(hex, 16), `&#x${hex};`));
            if (next === str) break;
            str = next;
        }
        return str;
    },
};

// ============================================================
// 🔄 Formatter — 格式化层（纯函数，不修改输入参数）
// ============================================================
const Formatter = {
    /** Markdown 收尾：合并连续换行 + 去首尾空白（短路与正常路径共用） */
    _finalizeMd(s) {
        return s.replace(/\n{3,}/g, '\n\n').trim();
    },

    htmlToMarkdown(shuju) {
        shuju = shuju || {};
        let html = (typeof shuju.content_html === 'string') ? shuju.content_html
            : (shuju.content_html === undefined || shuju.content_html === null ? '' : ''); // 非字符串内容视为空（避免 [object Object]）
        // url 文本与链接目标统一：非字符串视为无链接（与 urlOf 口径一致，避免 '[object Object]' 泄漏）、剥离换行（Markdown 链接文本/目标内的裸换行都会破坏链接，#65）
        const urlText = (typeof shuju.url === 'string') ? shuju.url.replace(/[\r\n]+/g, '') : '';
        // v3.170：url 危险协议过滤（与 a href 的 javascript:/vbscript:/data: 检查同口径）——
        // 曾 {链接}/原文链接 对接口 url 无协议过滤；正常链接/相对路径不受影响
        const safeUrl = urlText && !Utils.isDangerousUrl(urlText) ? urlText : '';
        // url 含 Markdown 特殊字符(空格/括号/])时用 <> 包裹（短路与正常路径共用）
        const mdUrl = safeUrl && /[\s()\[\]]/.test(safeUrl) ? `<${safeUrl}>` : safeUrl;
        // 无标签内容短路：跳过整个替换链（性能优化）
        if (!html.includes('<')) {
            html = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(html));
            return this._finalizeMd(mdUrl ? html + `\n\n原文链接：[${urlText}](${mdUrl})` : html);
        }
        html = html
            .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, c) => '#'.repeat(lv) + ' ' + c + '\n\n')
            .replace(/<a\s*[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
                // 空 href 不生成空链接；危险协议(javascript:/vbscript:/data:)仅保留文本，防 XSS
                // v3.143：href 先解码实体再检查——'javascript&#58;' 曾绕过（decode 在 a 转换后）
                return (href.trim() && !Utils.isDangerousUrl(href)) ? `[${txt}](${href})` : txt;
            })
            // v3.170：无引号 href（HTML 合法写法，`<a href=https://x.com>`）曾不匹配 → 链接丢失变纯文本——
            // 追加处理（带引号的已被上方替换吃掉，此处只处理剩余的无引号形式）
            .replace(/<a\s+[^>]*?href\s*=\s*([^\s"'>]+)[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
                return (href.trim() && !Utils.isDangerousUrl(href)) ? `[${txt}](${href})` : txt;
            })
            .replace(/<img\b[^>]*>/gi, (tag) => {
                const srcM = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || tag.match(/\bsrc\s*=\s*([^\s"'<>`]+)/i);
                if (!srcM) return tag; // 无 src 不转换
                const src = srcM[1].trim();
                if (!src || Utils.isDangerousUrl(src)) return tag.replace(/\bsrc\s*=\s*(?:(["'])[^"']*\1|[^\s"'<>`]+)/i, ''); // 空/危险 src 不生成可执行图片链接
                const altM = tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || tag.match(/\balt\s*=\s*([^\s"'<>`]+)/i);
                // alt 截断（真实接口 alt 可长达 250+ 字符拖累推送）——代理对安全
                const alt = altM ? Utils.truncateUtf16(altM[1], 50) : '';
                // 注：img URL 不包裹 <>——此处早于标签剥离，<url> 会被 /<[^>]+>/g 当标签剥掉成空 ![]()
                //     （a 链接的 <> 包裹安全是因为在最后拼接）；含空格/括号 URL 保持原样
                return `\n\n![${alt}](${src})\n\n`;
            })
            .replace(/<br\s*\/?>|<\/br>\s*/gi, '\n\n')
            .replace(/<\/?p[^>]*>/gi, '\n\n')
            .replace(/<\/?div[^>]*>/gi, '\n\n') // div 为块级元素：真实接口数据常见，缺换行会粘连
            // 列表/粗体/斜体转 Markdown（在标签剥离前）：<li> → - 项、<b>/<strong> → **、<i>/<em> → *
            // v3.171：短标签正则加 \b 词边界——`<img>/<input>/<iframe>` 曾被 `<i` 前缀误当斜体、
            // `<blockquote>/<bdo>` 被 `<b` 误当粗体、`<link>` 被 `<li` 误当列表项，输出 */**/- 垃圾
            .replace(/<li\b[^>]*>/gi, '\n- ')
            .replace(/<\/li\b>/gi, '\n')
            .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
            .replace(/<\/?(?:b|strong)\b[^>]*>/gi, '**')
            .replace(/<\/?(?:i|em)\b[^>]*>/gi, '*')
            // 表格：单元格 | 分隔、行/表换行（曾全部粘连成"甲乙丙丁"）
            .replace(/<td\b[^>]*>/gi, ' | ')
            .replace(/<th\b[^>]*>/gi, ' | ')
            .replace(/<tr\b[^>]*>/gi, '\n')
            .replace(/<table\b[^>]*>/gi, '\n\n')
            .replace(/<script[\s\S]*?<\/script>/gi, '')   // 脚本内容整体移除
            .replace(/<style[\s\S]*?<\/style>/gi, '')     // 样式内容整体移除
            // v3.173：删除 /<{2,}|>{2,}/g 剥离——曾把合法文本的 >>/<< 误删（'5>>3'→'53'、'价格<<100'→'价格100'）；
            // 标签形态由上方 <[^>]+> 剥离处理（'<<a>' 被剥），孤立 < / > 文本保留（Markdown 渲染为普通文本）
            .replace(/<[^>]+>/g, '')
            .replace(/\n{3,}/g, '\n\n');
        // 先移除真实 HTML 标签，再解码实体；实体解码可能重新形成标签，需再次清理主动内容/危险属性。
        html = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(html));
        let result = html + (mdUrl ? `\n\n原文链接：[${urlText}](${mdUrl})` : '');
        // 模板拼接后再次合并连续换行（内容尾部 \n\n + 模板 \n\n 会拼出 3+ 连换行）
        return this._finalizeMd(result);
    },

    tuisong_replace(text, shuju) {
        // 防御：模板缺失/非字符串时转空串或字符串化，避免 text.includes 崩溃
        // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 视为空模板
        try { text = text === undefined || text === null ? '' : String(text); } catch (e) { text = ''; }
        const data = { ...shuju };

        if (data.category_name) data.catename = data.category_name;
        if (data.category_id) data.cateid = data.category_id; // 与 category_name→catename 对称（修复 {分类ID} 恒空）

        const timeSource = (data.posttime !== undefined && data.posttime !== null && data.posttime !== '')
            ? data.posttime
            : (data.shijianchuo !== undefined && data.shijianchuo !== null && data.shijianchuo !== '' ? data.shijianchuo : undefined);
        if (timeSource !== undefined && !data.datetime) {
            // 统一解析（v3.62 与 daysComputed 共用 parseTime，消除重复逻辑）：
            // 秒/毫秒时间戳、8 位日期、YYYY-MM-DD、ISO 全部同一口径
            const t = Utils.parseTime(timeSource);
            if (t === null || t < 0) {
                // 非法/负时间戳：不生成日期（留空），避免回退当前时间或 1969 误导
                data.datetime = undefined;
                data.shorttime = undefined;
            } else {
                const dt = new Date(t);
                // v3.115 时区统一：与 parseTime 的 UTC 解析口径一致——getUTC* 保证跨时区部署
                // 日期时间显示一致；顺带修复 getHours 无 add0（+8 时区输出 '1:30' 而非 '01:30'）
                data.datetime = `${dt.getUTCFullYear()}-${Utils.add0(dt.getUTCMonth() + 1)}-${Utils.add0(dt.getUTCDate())}`;
                data.shorttime = `${Utils.add0(dt.getUTCHours())}:${Utils.add0(dt.getUTCMinutes())}`;
            }
        }

        // 惰性计算：只有模板里真正用到 {Html内容} / {Markdown内容} 时才跑一遍替换/正则，
        // 避免像 App.run 里那样对同一条数据分别调用 tuisong_replace 生成 text/desp 时，
        // 没用到 Markdown 的那次也白白算一遍 htmlToMarkdown
        // url 做 HTML 转义，避免特殊字符破坏 <a href="..."> 结构；换行先剥离（v3.85，与 linkText 口径一致）；非字符串视为无链接（R6-1）
        const rawUrl = (typeof data.url === 'string' ? data.url : '').replace(/[\r\n]+/g, '');
        const safeHtmlUrl = rawUrl && !Utils.isDangerousUrl(rawUrl) ? rawUrl : '';
        const escUrl = safeHtmlUrl
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // 与 htmlToMarkdown 口径一致：非字符串 content_html 视为空（避免 [object Object] 泄漏）
        // {Html内容} 会在 wxpusher 等通道以 HTML 类型渲染；实体解码后再次清理主动标签、事件属性和危险 URL，
        // 防止接口 content_html 中的 <script>/onerror 或 &lt;script&gt; 进入客户端渲染。
        const rawHtml = (typeof data.content_html === 'string')
            ? Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(data.content_html))
            : '';
        // {链接} 占位符 Markdown 安全化（v3.74）：与 htmlToMarkdown 的 mdUrl 同口径——
        // 含空格/括号/] 用 <> 包裹、剥离换行（原样输出会在 Markdown 链接场景破坏）
        const linkText = (() => {
            // R6-1：非字符串视为无链接（与 htmlToMarkdown urlText 同口径）
            const u = (typeof data.url === 'string') ? data.url.replace(/[\r\n]+/g, '') : '';
            // v3.170：危险协议过滤（与 htmlToMarkdown safeUrl 同口径）——{链接} 曾对 javascript: 等无拦截
            const safeU = u && !Utils.isDangerousUrl(u) ? u : '';
            return safeU && /[\s()\[\]]/.test(safeU) ? `<${safeU}>` : safeU;
        })();
        const getContentHtml = () => safeHtmlUrl
            ? `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="${escUrl}" target="_blank">${escUrl}</a><br>&nbsp;<br>&nbsp;<br>`
            : `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：${escUrl}<br>&nbsp;<br>&nbsp;<br>`;

        const map = {
            '{标题}': data.title,
            '{内容}': data.content,
            '{Html内容}': text.includes('{Html内容}') ? getContentHtml() : undefined,
            '{Markdown内容}': text.includes('{Markdown内容}') ? this.htmlToMarkdown(data) : undefined,
            '{分类名}': data.catename,
            '{分类ID}': data.cateid,
            '{链接}': linkText,
            '{日期}': data.datetime,
            '{时间}': data.shorttime,
            '{楼主}': data.louzhu,
            '{类目}': data.catename, // 与 {分类名} 统一来源（归一化后 catename 恒有值）
            '{价格}': data.price,
            '{商城}': data.mall_name,
            '{品牌}': data.brand,
            '{图片}': data.pic,
        };

        for (const [key, val] of Object.entries(map)) {
            text = text.replace(new RegExp(key, 'g'), () => {
                if (val === undefined || val === null) return '';
                if (typeof val !== 'object') return val;
                try { return JSON.stringify(val); }
                catch (e) { return ''; } // 循环引用等脏字段不应让整条推送流程崩溃
            });
        }
        // v3.110：输出统一清洗孤立代理（encodeURIComponent 会崩；所有模板路径受益）
        return Utils.sanitizeSurrogates(text);
    },
};

// ============================================================
// 📐 RuleEngine — 规则引擎层
// ============================================================
const RuleEngine = {
    /** 解析单行规则：split('###') + trim，返回 { cat, val, parts } */
    _parseLine(line) {
        const parts = String(line).split('###');
        return {
            cat: (parts[0] || '').trim(),
            val: (parts[1] || '').trim(),
            parts,
        };
    },

    /** 编译分类正则，失败返回 null（调用方决定跳过） */
    _compileCatRe(cat) {
        if (this.hasNestedQuantifier(cat)) return null; // ReDoS 防护：嵌套量词直接跳过
        try { return new RegExp(cat, 'i'); } catch (e) { return null; }
    },

    /**
     * 检测正则模式是否含「嵌套无限量词」（灾难性回溯 ReDoS 高风险，如 (a+)+、(a*)*、(a+)*、(?:a+)+）
     * 原理：分组内容以无限量词(+ * {n,})结尾，且该分组紧跟无限量词 → 匹配回溯呈指数级
     * 有界量词(?、{n}、{n,m})不参与灾难性回溯，不判危险；字符类/转义内的括号与量词忽略
     * 返回 true = 高风险（编译方应跳过/警告，避免卡死主线程）
     */
    hasNestedQuantifier(pattern) {
        // v3.108 fuzz：String(Symbol) 抛 TypeError；嵌套 Symbol 的数组 String() 也崩——统一兜底
        if (pattern === undefined || pattern === null || typeof pattern === 'symbol') return false;
        let s;
        try { s = String(pattern); } catch (e) { return false; }
        // 位置 i 起是否为无限量词（+ * {n,}），返回其长度（0=不是）
        const infQuantLen = (i) => {
            const ch = s[i];
            if (ch === '+' || ch === '*') return 1;
            if (ch === '{') {
                const m = /^\{(\d+)(?:,(\d*))?\}/.exec(s.slice(i));
                if (m && m[2] === '') return m[0].length; // {n,} 无上限=无限；{n}/{n,m} 有界
            }
            return 0;
        };
        const stack = [{ inf: false, alt: false }]; // 栈顶=当前分组：inf=组内最后 token 是否以无限量词结尾；alt=组内是否含 |（交替）
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            const cur = stack[stack.length - 1];
            if (ch === '\\') { i++; cur.inf = false; continue; } // 转义（含 \\( \\) \\d 等）视为普通 token
            if (ch === '[') {
                let j = i + 1;
                if (s[j] === '^') j++;
                if (s[j] === ']') j++; // 空类 ] 开头
                while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++; }
                i = j; cur.inf = false; continue; // 字符类整体视为普通 token
            }
            if (ch === '(') { stack.push({ inf: false, alt: false }); continue; }
            if (ch === '|') { cur.alt = true; cur.inf = false; continue; } // v3.174：交替标记（歧义回溯候选）
            if (ch === ')') {
                if (stack.length === 1) { cur.inf = false; continue; } // 多余右括号
                const closed = stack.pop();
                const parent = stack[stack.length - 1];
                const ql = infQuantLen(i + 1);
                if (closed.inf && ql > 0) return true; // 组以无限量词结尾 + 组后无限量词 → 灾难性
                // v3.174：组内含交替 + 组后无限量词 → 歧义交替灾难性回溯（(a|aa)+ 曾漏检，
                // '^(a|aa)+b$' 对 30a 已 156ms/40a 2.5s/50a+ 指数爆炸卡死）；保守拦截（宁可误拦多推）
                if (closed.alt && ql > 0) return true;
                if (ql > 0) { parent.inf = true; i += ql; } else { parent.inf = false; }
                continue;
            }
            const ql = infQuantLen(i);
            if (ql > 0) { cur.inf = true; i += ql - 1; }
            else if (ch === '?') { cur.inf = true; } // ? 可变量词：组内以 ? 结尾时组可匹配空串，配合组后无限量词同样灾难性（如 (a?)+）
            else { cur.inf = false; } // 普通字符 / {n} / {n,m} 视为有界
        }
        return false;
    },

    /** 验证分类正则合法性，无效则追加警告 */
    _validateCatRe(cat, field, warnings) {
        if (this.hasNestedQuantifier(cat)) {
            warnings.push(`⚠️ 配置「${field}」分类正则含嵌套量词，可能导致灾难性回溯，该行将被忽略：「${cat}」`);
            return;
        }
        try { new RegExp(cat, 'i'); } catch (e) {
            warnings.push(`⚠️ 配置「${field}」分类正则无效：「${cat}」`);
        }
    },

    /** 解析多行配置（<br> / \n\n 分割），返回行数组 */
    _splitLines(configStr) {
        // v3.108 fuzz：/###/.test(Symbol) 隐式 String() 抛 TypeError——Symbol 视为无配置
        if (configStr === undefined || configStr === null || typeof configStr === 'symbol') return [];
        let s;
        try { s = String(configStr); } catch (e) { return []; } // 嵌套 Symbol 数组 String() 崩 → 无配置
        configStr = s;
        if (!configStr) return [];
        if (!/###/.test(configStr)) return null; // 简单模式
        return configStr.split(/<br\s*\/?>|\r\n|\r|\n/); // R2：支持 <br/> 自闭合（与 htmlToMarkdown br 口径一致）
    },

    /**
     * 编译过滤规则 —— 启动时执行一次
     * 将 Config.filter 中的字符串预编译为 RegExp / 结构化规则
     * 后续过滤直接使用编译后的规则，不再 new RegExp()
     */
    compileRules(rawCfg) {
        rawCfg = rawCfg || {};
        const compiled = {};

        // 编译简单的正则字段（不含 ### 时）
        for (const field of FILTER_FIELDS) {
            // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 该字段置 null（跳过）
            let val = rawCfg[field];
            if (val === undefined || val === null || typeof val === 'symbol') {
                compiled[field] = null;
                continue;
            }
            try { val = String(val); } catch (e) { compiled[field] = null; continue; }
            if (!val) {
                compiled[field] = null;
                continue;
            }

            if (field === 'pingbifenlei' && /###/.test(val)) {
                // pingbifenlei 不支持 ### 多行，跳过
                compiled[field] = null;
                continue;
            }
            if (/###/.test(val)) {
                // 多行多分类模式：预分割并编译每行
                const lines = this._splitLines(val);
                const rules = [];
                for (const line of lines) {
                    const { cat, val, parts } = this._parseLine(line);
                    if (parts.length >= 2) {
                        if (!val) continue; // 值正则为空 → 跳过（避免永真规则）
                        let catRe = null;
                        if (cat) {
                            catRe = this._compileCatRe(cat);
                            if (!catRe) continue;
                        }
                        let valRe = null;
                        if (this.hasNestedQuantifier(val)) continue; // ReDoS 防护：嵌套量词跳过
                        try { valRe = new RegExp(val, 'i'); } catch (e) { continue; } // 预期：非法正则该行跳过（validateConfig 已警告）
                        if (valRe) rules.push({ cat: catRe, val: valRe });
                    }
                }
                compiled[field] = { _type: 'multi', rules };
            } else {
                // 简单模式：直接编译为 RegExp
                // v3.156：先 trim——空白配置('   ')曾编译成 /   /i 假过滤（validateConfig 说忽略但实际生效）
                val = val.trim();
                if (!val) { compiled[field] = null; continue; }
                if (this.hasNestedQuantifier(val)) { compiled[field] = null; continue; } // ReDoS 防护
                try {
                    compiled[field] = { _type: 're', re: new RegExp(val, 'i') };
                } catch (e) {
                    compiled[field] = null; // 预期：非法正则置 null 跳过（validateConfig 已警告）
                }
            }
        }

        // 编译 pingbitime（特殊处理）
        // v3.156：先 trim——空白('   ')曾 Number→0 静默关闭时间过滤
        let pbRaw = '';
        try { pbRaw = rawCfg.pingbitime === undefined || rawCfg.pingbitime === null ? '' : String(rawCfg.pingbitime).trim(); }
        catch (e) { pbRaw = ''; } // 脏配置无法转字符串时忽略规则，不让启动崩溃
        if (pbRaw) {
            rawCfg.pingbitime = pbRaw;
            if (/###/.test(rawCfg.pingbitime)) {
                const lines = this._splitLines(rawCfg.pingbitime);
                const rules = [];
                for (const line of lines) {
                    const { cat, val, parts } = this._parseLine(line);
                    if (parts.length >= 2) {
                        let catRe = null;
                        if (cat) {
                            catRe = this._compileCatRe(cat);
                            if (!catRe) continue;
                        }
                        const value = Number(val);
                        if (Number.isFinite(value) && value >= 0) rules.push({ cat: catRe, value });
                    }
                }
                compiled.pingbitime = { _type: 'timeMulti', rules };
            } else {
                const value = Number(rawCfg.pingbitime);
                // v3.157：非法数值(如 'abc')→ null 不编译（曾落 value:0 静默关闭时间过滤；空白已 v3.156 处理）
                compiled.pingbitime = (Number.isFinite(value) && value >= 0) ? { _type: 'time', value } : null;
            }
        } else {
            compiled.pingbitime = null;
        }

        compiled.__compiled = true;
        return compiled;
    },

    /** 多行规则分类匹配：无 cat 限制(匹配所有)或有 cat 且 catename 匹配 */
    _catMatches(rule, catename) {
        if (!rule.cat) return true;
        if (!catename) return false;
        try {
            const value = typeof catename === 'string' ? catename : String(catename);
            return rule.cat.test(value);
        } catch (e) {
            return false;
        }
    },

    /** 多行规则任意匹配：分类匹配 + 断言成立即返回 true（matchesCompiled/checkTimeCompiled 共用） */
    _anyRule(rules, catename, predicate) {
        for (const rule of rules) {
            if (this._catMatches(rule, catename) && predicate(rule)) return true;
        }
        return false;
    },

    /** 使用编译后的规则进行匹配（单条） */
    matchesCompiled(compiled, fieldValue, catename) {
        if (!compiled || !fieldValue) return false;
        let value;
        try { value = typeof fieldValue === 'string' ? fieldValue : String(fieldValue); }
        catch (e) { return false; } // 脏字段 toString/Symbol 失败时保守放行，不让整批 run 崩溃

        if (compiled._type === 're') {
            // 简单正则
            return compiled.re.test(value);
        }

        if (compiled._type === 'multi') {
            // 多行多分类：任意一行匹配即匹配
            return this._anyRule(compiled.rules, catename, r => r.val.test(value));
        }

        return false;
    },

    /** 编译后的天数规则检查 */
    checkTimeCompiled(compiled, group) {
        if (!compiled || !group || group.louzhuregtime === undefined || group.louzhuregtime === null || group.louzhuregtime === '') return null; // null = 不拦截；0 时间戳视为有效
        const days = Utils.daysComputed(group.louzhuregtime);

        if (compiled._type === 'time') {
            return compiled.value > days; // true = 拦截
        }

        if (compiled._type === 'timeMulti') {
            return this._anyRule(compiled.rules, group.catename, r => r.value > days);
        }

        return false;
    },

    /** 验证配置合法性（与 compileRules 共享解析逻辑） */
    validateConfig(cfg) {
        cfg = cfg || {};
        const warnings = [];

        // v3.108 fuzz：配置值 String(嵌套 Symbol 数组) 崩 → 跳过该字段
        const safeStr = (v) => {
            if (v === undefined || v === null || typeof v === 'symbol') return '';
            try { return String(v); } catch (e) { return ''; }
        };

        // pingbifenlei 不支持 ### 多行分类语法，给明确警告
        if (safeStr(cfg.pingbifenlei) && /###/.test(safeStr(cfg.pingbifenlei))) {
            warnings.push('⚠️ 配置「pingbifenlei」不支持 ### 多行分类语法，该规则将被忽略\n   如需按分类屏蔽，请直接写分类名正则，例如：微博|赚客吧');
        }

        for (const field of FILTER_FIELDS) {
            const val = safeStr(cfg[field]);
            if (!val) continue;
            // 多行模式：逐行验证
            if (/###/.test(val)) {
                const lines = val.split(/<br\s*\/?>|\r\n|\r|\n/); // 与 _splitLines 口径一致(含单独 \r、<br/>，R2)
                for (const line of lines) {
                    const t = line.trim();
                    if (!t) continue;
                    const { cat, val, parts } = this._parseLine(line);
                    if (parts.length < 2) {
                        warnings.push(`⚠️ 配置「${field}」行缺少 ### 分隔符，该行将被忽略：「${t}」`);
                        continue;
                    }
                    if (parts.length > 2) {
                        warnings.push(`⚠️ 配置「${field}」行包含多个 ###，仅前两段生效：「${t}」`);
                    }
                    if (!val) {
                        warnings.push(`⚠️ 配置「${field}」值正则为空，该行将被忽略（避免永真规则）：「${t}」`);
                        continue;
                    }
                    if (cat) this._validateCatRe(cat, field, warnings);
                    if (this.hasNestedQuantifier(val)) {
                        warnings.push(`⚠️ 配置「${field}」值正则含嵌套量词，可能导致灾难性回溯，该行将被忽略：「${val}」`);
                        continue;
                    }
                    try { new RegExp(val, 'i'); } catch (e) {
                        warnings.push(`⚠️ 配置「${field}」值正则无效：「${val}」`);
                    }
                }
            } else {
                if (String(val).trim() === '') {
                    warnings.push(`⚠️ 配置「${field}」为空白字符，将被忽略`);
                    continue;
                }
                if (this.hasNestedQuantifier(val)) {
                    warnings.push(`⚠️ 配置「${field}」的正则含嵌套量词，可能导致灾难性回溯，该规则将被忽略：「${val}」`);
                    continue;
                }
                try { new RegExp(val, 'i'); } // 与 compileRules 的 'i' 保持一致
                catch (e) { warnings.push(`⚠️ 配置「${field}」包含无效的正则表达式：「${val}」\n   原因：${e.message}`); }
            }
        }

        // 验证 zkt_gjc（只看它关键词，与 App.run 预编译口径一致）
        // R11-1：非字符串（对象/数字等脏配置）→ 显式警告（String 化会把 '[object Object]' 当合法正则，静默怪行为）
        if (cfg.zkt_gjc !== undefined && cfg.zkt_gjc !== null && typeof cfg.zkt_gjc !== 'string') {
            warnings.push(`⚠️ 配置「zkt_gjc」应为字符串，当前为 ${typeof cfg.zkt_gjc}，已忽略只看它过滤`);
        } else if (cfg.zkt_gjc && String(cfg.zkt_gjc).trim() !== '') {
            if (this.hasNestedQuantifier(cfg.zkt_gjc)) {
                warnings.push('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤');
            } else {
                try { new RegExp(cfg.zkt_gjc, 'i'); }
                catch (e) { warnings.push(`⚠️ 配置「zkt_gjc」包含无效的正则表达式：「${cfg.zkt_gjc}」`); }
            }
        }

        // 验证 pingbitime
        // v3.156：空白配置('   ')警告（曾静默当 0 关闭时间过滤，复制粘贴带空格常见）
        let pbStr = '';
        try { pbStr = cfg.pingbitime === undefined || cfg.pingbitime === null ? '' : String(cfg.pingbitime); }
        catch (e) { pbStr = ''; warnings.push('⚠️ 配置「pingbitime」无法转换为字符串，已忽略'); }
        // v3.156：空白/首尾空格警告（多行 ### 不警告——行内分类已 trim，整串首尾空格是格式不是错误）
        if (pbStr.trim() === '' && pbStr !== '') {
            warnings.push('⚠️ 配置「pingbitime」为空白字符，将被忽略');
        } else if (!/###/.test(pbStr) && pbStr.trim() !== '' && pbStr !== pbStr.trim()) {
            warnings.push('⚠️ 配置「pingbitime」含首尾空白，已按去空格后的值处理');
        }
        if (pbStr.trim()) {
            if (/###/.test(pbStr)) {
                const lines = pbStr.split(/<br\s*\/?>|\r\n|\r|\n/); // 与 _splitLines 口径一致(含单独 \r、<br/>，R2)
                for (const line of lines) {
                    const { cat, val, parts } = this._parseLine(line);
                    if (parts.length >= 2) {
                        if (cat) this._validateCatRe(cat, 'pingbitime', warnings);
                        const tNum = Number(val);
                        if (!Number.isFinite(tNum) || tNum < 0) {
                            warnings.push(`⚠️ 配置「pingbitime」的天数值「${(parts[1] || '').trim()}」不是有效数字（需 ≥0 的有限数）`);
                        }
                    }
                }
            } else {
                // 使用已经安全转换的 pbStr，避免 Symbol/valueOf 异常值再次进入 Number() 或模板插值。
                const tv = Number(pbStr);
                if (!Number.isFinite(tv) || tv < 0) {
                    warnings.push(`⚠️ 配置「pingbitime」的值「${pbStr}」不是有效数字（需 ≥0 的有限数）`);
                } else if (!Number.isInteger(tv)) {
                    warnings.push(`⚠️ 配置「pingbitime」的值「${pbStr}」是小数，已按整数处理（建议使用整数天数）`);
                }
            }
        }
        // 校验 cache.maxSize（#7）：MessageStore 函数层已回退默认，配置层补提示。
        // 兼容传入完整 Config（cfg.cache.maxSize）或平铺（cfg.maxSize）两种形态
        // v3.175：字符串 maxSize（'10000' 环境变量）曾误报——用 Utils.num 口径
        const maxSizeVal = cfg.cache ? cfg.cache.maxSize : cfg.maxSize;
        const msNum = Utils.num(maxSizeVal, -1);
        if (maxSizeVal !== undefined && (!Number.isInteger(msNum) || msNum <= 0)) {
            warnings.push(`⚠️ 配置「cache.maxSize」为「${safeStr(maxSizeVal)}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`);
        }
        return [...new Set(warnings)];
    },
};

// ============================================================
// 🎯 FilterEngine — 过滤引擎层
// ============================================================
const FilterEngine = {
    /** 缺字段保守放行统一：compiled/group 缺失或字段缺失 → true；否则取反执行检查 */
    _passIfMissing(group, field, compiled, checkFn) {
        if (!compiled || !group) return true;
        const v = group[field];
        if (v === undefined || v === null || v === '') return true;
        return !checkFn(compiled, group);
    },

    /** 注册天数过滤（使用编译后的规则） */
    checkRegisterTime(group, compiled) {
        // 显式判断缺失：0 时间戳(1970)视为有效，走 checkTimeCompiled 解析（口径统一）
        return this._passIfMissing(group, 'louzhuregtime', compiled, (c, g) => RuleEngine.checkTimeCompiled(c, g));
    },

    /** 分类屏蔽（使用编译后的规则） */
    checkCategory(group, compiled) {
        return this._passIfMissing(group, 'catename', compiled, (c, g) => RuleEngine.matchesCompiled(c, g.catename, null));
    },

    /**
     * 楼主/标题/内容三级过滤（全部使用编译后的规则）
     *
     * 【优先级（高→低）】
     *   1. 楼主强制展现（zhanxianlouzhu）→ 标题/内容的屏蔽、强化屏蔽整体跳过
     *   2. 标题强制展现（zhanxianbiaoti）→ 内容的屏蔽、强化屏蔽整体跳过
     *   3. 同字段强化屏蔽（plusCfg）→ 可抵消同字段的强制展现（showFlags）
     *   4. 同字段强制展现（showCfg）→ 优先于同字段普通屏蔽
     *   5. 同字段普通屏蔽（blockCfg）
     *
     * 注意：楼主/标题的白名单会"越权"免疫后面字段的强化屏蔽，
     *       这是刻意设计，配置时需留意。
     */
    checkFields(group, compiled) {
        const fieldStages = [
            { key: 'louzhu',  getVal: (g) => g.louzhu,  showCfg: compiled.zhanxianlouzhu,  blockCfg: compiled.pingbilouzhu,  plusCfg: compiled.pingbilouzhuplus,  blockedBy: [] },
            { key: 'title',   getVal: (g) => g.title,   showCfg: compiled.zhanxianbiaoti,   blockCfg: compiled.pingbibiaoti,   plusCfg: compiled.pingbibiaotiplus,   blockedBy: ['louzhu'] },
            { key: 'content', getVal: (g) => g.content, showCfg: compiled.zhanxianneirong,  blockCfg: compiled.pingbineirong,  plusCfg: compiled.pingbineirongplus,  blockedBy: ['louzhu', 'title'] },
        ];

        const showFlags = {};
        const blockFlags = {};
        const blockPlusFlags = {};

        // 第一轮：强制展现
        for (const stage of fieldStages) {
            const val = stage.getVal(group);
            if (stage.showCfg && val) {
                if (RuleEngine.matchesCompiled(stage.showCfg, val, group.catename)) {
                    showFlags[stage.key] = true;
                }
            }
        }

        // 第二轮：屏蔽 + 强化屏蔽
        for (const stage of fieldStages) {
            const val = stage.getVal(group);
            if (!val) continue;
            const blocked = stage.blockedBy.some(k => showFlags[k]);

            if (stage.blockCfg && !blocked && !showFlags[stage.key]) {
                if (RuleEngine.matchesCompiled(stage.blockCfg, val, group.catename)) {
                    blockFlags[stage.key] = true;
                }
            }
            if (stage.plusCfg && !blocked && !blockFlags[stage.key]) {
                if (RuleEngine.matchesCompiled(stage.plusCfg, val, group.catename)) {
                    blockPlusFlags[stage.key] = true;
                    showFlags[stage.key] = false;
                }
            }
            if (blockFlags[stage.key] || blockPlusFlags[stage.key]) return false;
        }
        return true;
    },

    /**
     * 主过滤函数
     * 接受编译后的规则（推荐）或原始字符串配置（兼容旧调用）
     */
    listfilter(group, cfg) {
        if (!group) return true;
        if (!cfg) return true;

        // 自动适配：如果传入的是原始字符串配置（非编译格式），走旧路径
        if (!cfg.__compiled) {
            return this._legacyListfilter(group, cfg);
        }

        if (!this.checkRegisterTime(group, cfg.pingbitime)) return false;
        if (!this.checkCategory(group, cfg.pingbifenlei)) return false;
        return this.checkFields(group, cfg);
    },

    /** 兼容旧调用的备用路径（直接编译传入的原始字符串） */
    _legacyListfilter(group, rawCfg) {
        return this.listfilter(group, RuleEngine.compileRules(rawCfg));
    },

    /**
     * 只看它过滤 —— 独立语义，不依赖 listfilter
     * 直接判断指定字段是否匹配关键词
     */
    /** 向后兼容：只看它过滤（等同于 whitelistFilter(item, 'title', keyword)） */
    filterByKeyword(item, keyword) {
        return this.whitelistFilter(item, 'title', keyword);
    },

    whitelistFilter(item, field, keyword) {
        // 空/空白关键词 = 全部通过（最优先——与历史语义一致；v3.108 安全 String 化）
        if (keyword === undefined || keyword === null || keyword === '') return true;
        let kwStr;
        try { kwStr = String(keyword); } catch (e) { return true; } // 嵌套 Symbol 数组 String() 崩 → 放行
        if (kwStr.trim() === '') return true;
        if (!item) return false; // 防御：item 缺失 = 不匹配
        const value = item[field];
        if (!value) return false;
        if (RuleEngine.hasNestedQuantifier(kwStr)) return true; // ReDoS 防护：风险关键词不执行匹配，全部放行（与非法正则口径一致）
        try {
            return new RegExp(kwStr, 'i').test(value);
        } catch (e) {
            // 非法正则：放行（与 App.run 的 zkt_gjc 预编译失败 kwRe=null 不过滤口径一致；宁可多推不可少推）
            return true;
        }
    },
};

// ============================================================
// 💾 MessageStore — 缓存管理层
// ============================================================
const MessageStore = {
    // v3.172：cache.dir 非法回退时支持并行 worker 隔离（test_app_parallel 用 XBK_PARALLEL_ID 分片，
    // 回退硬编码 'xianbaoku_cache' 会让 t51 等非法配置测试撞共享目录竞态）
    get cacheDir() {
        const fallback = process.env.XBK_PARALLEL_ID ? `xianbaoku_cache_p${process.env.XBK_PARALLEL_ID}` : 'xianbaoku_cache';
        const raw = typeof Config.cache.dir === 'string' && Config.cache.dir ? Config.cache.dir : fallback;
        const root = path.resolve(__dirname);
        const candidate = path.resolve(root, raw);
        const realInsideRoot = (p) => {
            const lexicalInside = p !== root && p.startsWith(root + path.sep);
            if (!lexicalInside) return false;
            // 逐级回溯到已存在目录，再 realpath 校验；防止项目内符号链接指向项目外部。
            let probe = p;
            try {
                while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe);
                const realProbe = fs.realpathSync(probe);
                const resolved = path.resolve(realProbe, path.relative(probe, p));
                return resolved !== root && resolved.startsWith(root + path.sep);
            } catch (e) {
                return false;
            }
        };
        // P2 防御：cache.dir 不能通过 ..、绝对路径或符号链接逃出项目根目录；越界配置回退默认目录。
        if (realInsideRoot(candidate)) return candidate;
        const safeFallback = path.resolve(root, fallback);
        return realInsideRoot(safeFallback) ? safeFallback : path.join(root, 'xianbaoku_cache');
    },
    _memoryCache: {},
    // 内存缓存 key 上限（防御：pushUrl 变化等场景下防止无限增长泄漏；磁盘缓存为权威可重建）
    _MEMO_MAX: 100,

    /** 带上限的内存缓存写入：超限时整体重置（磁盘不受影响），防理论无限增长 */
    _memoSet(filePath, val) {
        // R5-2：hasOwnProperty 判断（__proto__ 等原型键不会被 in 误判/直写污染对象原型）
        if (!Object.prototype.hasOwnProperty.call(this._memoryCache, filePath) && Object.keys(this._memoryCache).length >= this._MEMO_MAX) {
            this._memoryCache = {};
            console.warn(`内存缓存达到上限(${this._MEMO_MAX})，已重置（磁盘缓存不受影响）`);
        }
        // 原型键（__proto__/constructor/prototype）用 defineProperty 写入，避免 `obj['__proto__']=val` 修改对象原型
        if (filePath === '__proto__' || filePath === 'constructor' || filePath === 'prototype') {
            Object.defineProperty(this._memoryCache, filePath, { value: val, enumerable: true, configurable: true, writable: true });
        } else {
            this._memoryCache[filePath] = val;
        }
    },

    /** 统一更新/追加：命中则更新(含覆盖提示)，未命中追加 */
    _upsert(messages, message, filename) {
        const idx = this._findDedupIndex(messages, message);
        if (idx >= 0) {
            // 序列化比较（循环引用等失败时按"已更新"处理，不崩溃）
            // v3.156：排除 timestamp（同 saveBatch 主路径口径）
            const stripTs = (o) => { if (!o || typeof o !== 'object') return o; const c = { ...o }; delete c.timestamp; return c; };
            let changed = false;
            try { changed = JSON.stringify(stripTs(messages[idx])) !== JSON.stringify(stripTs(message)); } catch (e) { changed = true; }
            if (changed) {
                console.log(`更新缓存记录: ${filename}`);
            }
            messages[idx] = { ...message, timestamp: new Date().toISOString() };
        } else {
            messages.push({ ...message, timestamp: new Date().toISOString() });
        }
    },

    /** 统一判重：有效 id 优先（类型归一 + 有效 url 兜底，兼容旧 url-only 缓存与 id 类型漂移），否则 url fallback */
    _findDedupIndex(messages, message) {
        const messageUrl = message && message.url ? Utils.normUrl(message.url) : '';
        return messages.findIndex(m => {
            const cachedUrl = m && m.url ? Utils.normUrl(m.url) : '';
            const sameValidUrl = !!(messageUrl && cachedUrl && messageUrl === cachedUrl);
            return (Utils.hasValidId(message) && (String(m.id) === String(message.id) || (!Utils.hasValidId(m) && sameValidUrl))) ||
                (!Utils.hasValidId(message) && sameValidUrl);
        });
    },

    init() {
        try {
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }
        } catch (e) {
            console.error(`缓存目录创建失败: ${this.cacheDir}`, e.message);
        }
    },

    getFilePath(filename) {
        // 路径安全：只取 basename 并清洗，外部传 ../ 或绝对路径无法逃出缓存目录
        // v3.108 fuzz：String(嵌套 Symbol 数组) 崩 → 视为空文件名
        let fnStr;
        try { fnStr = String(filename || ''); } catch (e) { fnStr = ''; }
        let safe = path.basename(fnStr).replace(/[\\/:*?"<>|]/g, '');
        // v3.176：非信息文件名（对象/布尔 String 化产物）回退 default.json——与 getFileName 口径一致
        // （曾产生 xianbaoku_cache/[object Object] 垃圾文件：test_filter 参数颠倒 + 此处无防御）
        if (!safe || safe === '.' || safe === '..' || safe === '[object Object]' || safe === 'undefined' || safe === 'null' || safe === 'true' || safe === 'false') safe = 'default.json';
        // 文件名超长截断（避免 >255 字节落盘失败）
        if (Buffer.byteLength(safe, 'utf8') > 200) {
            const ext = safe.includes('.') ? safe.slice(safe.lastIndexOf('.')) : '';
            safe = safe.slice(0, Math.max(1, 200 - Buffer.byteLength(ext))) + ext;
        }
        return path.join(this.cacheDir, safe);
    },

    _ensureFileExists(filePath) {
        // 确保父目录存在，让 save/has 脱离 App.run() 单独调用也能自给自足
        // 容错：文件不存在时 mkdir/writeFile 抛错不逃逸（双故障下 readMessages 仍可返回 []）
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
        } catch (e) {
            console.error(`缓存初始化失败 ${filePath}:`, e.message);
        }
    },

    /** 重置缓存文件为空数组（写 '[]' 并更新内存缓存；写失败也容错——双故障时 readMessages 不崩） */
    _resetCache(filePath) {
        try {
            fs.writeFileSync(filePath, '[]', 'utf8');
        } catch (e) {
            console.error(`缓存重置失败 ${filePath}:`, e.message);
        }
        this._memoSet(filePath, []);
    },

    readMessages(filePath) {
        // R5-2：hasOwnProperty 读取（'__proto__' 直读会返回 Object.prototype 而非缓存值）
        if (Object.prototype.hasOwnProperty.call(this._memoryCache, filePath)) return this._memoryCache[filePath];
        this._ensureFileExists(filePath);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
            if (Array.isArray(data)) {
                // 过滤非对象元素（null/原始值），避免后续 has/save 访问 m.id 崩溃
                // v3.157：排除数组元素（typeof object 含数组——数组元素 m.id 访问异常、判重混乱）
                const clean = data.filter(m => m && typeof m === 'object' && !Array.isArray(m));
                this._memoSet(filePath, clean);
                return clean;
            }
            // 合法 JSON 但非数组（对象等）→ 重置，避免后续 .some()/.findIndex() 崩溃
            console.error(`缓存格式异常（非数组），重置文件 ${filePath}`);
            this._resetCache(filePath);
            return [];
        } catch (e) {
            console.error(`JSON解析错误，重置文件 ${filePath}:`, e.message);
            this._resetCache(filePath);
            return [];
        }
    },

    saveMessages(filePath, messages) {
        // 记录写入前的内存缓存：落盘失败时不能把未持久化的新状态伪装成已保存。
        const hadMemo = Object.prototype.hasOwnProperty.call(this._memoryCache, filePath);
        const memoBefore = hadMemo ? this._memoryCache[filePath] : undefined;
        const restoreMemo = () => {
            if (hadMemo) this._memoSet(filePath, memoBefore);
            else {
                try { delete this._memoryCache[filePath]; } catch (e) { /* 忽略 */ }
            }
        };
        // 拷贝后再截断：不原地修改调用方传入的数组（外部复用场景）
        const toSave = Array.isArray(messages) ? [...messages] : [];
        // maxSize 防御：非正整数回退默认（R3-2 整数化——小数 2.5 会让 splice 的 ToInteger 截断产生模糊条数；0/负值避免缓存被清空）
        // v3.176：Utils.num 口径——'5000'(环境变量字符串) 曾 Number.isInteger 判否 → 静默回退 10000
        // （validateConfig 按 v3.175 口径判合法不警告 → 层间不一致，用户以为 5000 生效实际 10000）
        const maxSize = (() => { const v = Utils.num(Config.cache.maxSize, -1); return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_SIZE; })();
        if (toSave.length > maxSize) {
            console.warn(`缓存超出上限(${maxSize})，裁剪掉最早 ${toSave.length - maxSize} 条`);
            toSave.splice(0, toSave.length - maxSize);
        }
        const text = (() => {
            // 序列化防御：循环引用等无法 JSON.stringify 时容错（内存缓存保留，不落盘不崩溃）
            try {
                return JSON.stringify(toSave, null, 2);
            } catch (e) {
                console.error(`缓存序列化失败 ${filePath}（可能含循环引用）:`, e.message);
                return null;
            }
        })();
        if (text === null) {
            restoreMemo();
            return false;
        }
        // 原子写入：先写 tmp 再 rename，避免并发/崩溃时半写文件损坏缓存
        const tmpFile = filePath + '.tmp';
        let saved = true;
        try {
            fs.writeFileSync(tmpFile, text, 'utf8');
            fs.renameSync(tmpFile, filePath);
        } catch (e) {
            saved = false;
            // 写失败/rename 失败：清理 tmp 残留，不中断；恢复写入前内存快照，避免未落盘消息被判重吞掉。
            try { fs.unlinkSync(tmpFile); } catch (e2) { /* 忽略 */ }
            restoreMemo();
            console.error(`缓存写入失败 ${filePath}:`, e.message);
        }
        if (saved) this._memoSet(filePath, toSave);
        return saved;
    },

    has(message, filename) {
        return this._findDedupIndex(this.readMessages(this.getFilePath(filename)), message) >= 0;
    },

    save(message, filename) {
        // 单条是批量的特例：复用 saveBatch（含元素校验/统一 upsert/原子写）
        return this.saveBatch([message], filename);
    },

    /** 批量写入：一次性 append 多条消息，只触发一次磁盘写入（用于单次运行内的多条新数据） */
    saveBatch(newMessages, filename) {
        // 公开 API 防御：批量输入必须是数组；对象/数字/Symbol 等不可迭代值不能直接进入 for...of。
        if (!Array.isArray(newMessages) || newMessages.length === 0) return;
        const filePath = this.getFilePath(filename);
        // readMessages 可能返回进程内内存缓存权威数组；先复制，避免落盘失败前原地污染内存缓存。
        const messages = [...this.readMessages(filePath)];
        // v3.118 性能：逐条 _upsert 的 findIndex 是 O(N×M)（缓存 100 条 + 新 N 条累积 → O(N²)，
        // 实测 5000 条 2475ms）。构建 id/url 索引 O(1) 判重定位，维护 O(1)。
        // 判重口径与 _findDedupIndex 完全一致：有 id 匹配 String(id)（或 m 无 id 时 url）；
        // 无 id 匹配 url；findIndex 顺序语义 = 最小 index（addKey 用"更小覆盖"维护首个）
        const addKey = (map, key, i) => {
            const e = map.get(key);
            if (e === undefined || i < e) map.set(key, i); // 首个 = 最小 index（与 findIndex 顺序一致）
        };
        const idMap = new Map();      // String(id) -> 首个 index（有 id 的 m）
        const urlMap = new Map();     // normUrl(url) -> 首个 index（所有有 url 的 m）
        const urlOnlyMap = new Map(); // normUrl(url) -> 首个 index（无 id 有 url 的 m）
        messages.forEach((m, i) => {
            if (!m || typeof m !== 'object') return;
            if (Utils.hasValidId(m)) addKey(idMap, String(m.id), i);
            const u = m.url ? Utils.normUrl(m.url) : '';
            if (u) addKey(urlMap, u, i);
            if (!Utils.hasValidId(m) && u) addKey(urlOnlyMap, u, i);
        });
        const NOW = () => new Date().toISOString();
        // 删除后扫描 idx 之后重建次小 index（保 findIndex 顺序语义；脏缓存同 key 多条时正确）
        const scanNext = (map, key, fromIdx, match) => {
            for (let j = fromIdx + 1; j < messages.length; j++) {
                const mm = messages[j];
                if (mm && typeof mm === 'object' && match(mm)) { addKey(map, key, j); break; }
            }
        };
        // 更新后维护索引：先加新键（同 id/url 时自动恢复，跳过扫描）→ 再处理旧键（删+扫描次小）
        const reindex = (idx, oldM) => {
            const m = messages[idx];
            const newUrl = m && typeof m === 'object' && m.url ? Utils.normUrl(m.url) : '';
            if (m && typeof m === 'object') {
                if (Utils.hasValidId(m)) addKey(idMap, String(m.id), idx);
                if (newUrl) addKey(urlMap, newUrl, idx);
                if (!Utils.hasValidId(m) && newUrl) addKey(urlOnlyMap, newUrl, idx);
            }
            if (oldM && typeof oldM === 'object') {
                if (Utils.hasValidId(oldM)) {
                    const k = String(oldM.id);
                    if (idMap.get(k) === idx && !(m && Utils.hasValidId(m) && String(m.id) === k)) {
                        idMap.delete(k);
                        scanNext(idMap, k, idx, (mm) => Utils.hasValidId(mm) && String(mm.id) === k);
                    }
                }
                if (oldM.url) {
                    const k = Utils.normUrl(oldM.url);
                    if (k && urlMap.get(k) === idx && !(m && newUrl === k)) {
                        urlMap.delete(k);
                        scanNext(urlMap, k, idx, (mm) => mm.url && Utils.normUrl(mm.url) === k);
                    }
                }
                if (!Utils.hasValidId(oldM) && oldM.url) {
                    const k = Utils.normUrl(oldM.url);
                    if (k && urlOnlyMap.get(k) === idx && !(m && !Utils.hasValidId(m) && newUrl === k)) {
                        urlOnlyMap.delete(k);
                        scanNext(urlOnlyMap, k, idx, (mm) => !Utils.hasValidId(mm) && mm.url && Utils.normUrl(mm.url) === k);
                    }
                }
            }
        };
        for (const message of newMessages) {
            // 元素级校验：非对象元素跳过（避免访问 message.id 崩溃）
            if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
            let idx = -1;
            if (Utils.hasValidId(message)) {
                const c1 = idMap.get(String(message.id));
                const c2 = message.url ? urlOnlyMap.get(Utils.normUrl(message.url)) : undefined;
                const cands = [c1, c2].filter(x => x !== undefined);
                if (cands.length) idx = Math.min(...cands); // findIndex 顺序语义：取最早出现
            } else if (message.url) {
                const u = urlMap.get(Utils.normUrl(message.url));
                if (u !== undefined) idx = u;
            }
            if (idx >= 0) {
                const oldM = messages[idx];
                // v3.156：比较排除 timestamp——曾因 oldM 有 timestamp、message 无而内容相同也必报"更新缓存记录"
                const stripTs = (o) => { if (!o || typeof o !== 'object') return o; const c = { ...o }; delete c.timestamp; return c; };
                let changed = false;
                try { changed = JSON.stringify(stripTs(oldM)) !== JSON.stringify(stripTs(message)); } catch (e) { changed = true; }
                if (changed) console.log(`更新缓存记录: ${filename}`);
                messages[idx] = { ...message, timestamp: NOW() };
                reindex(idx, oldM);
            } else {
                messages.push({ ...message, timestamp: NOW() });
                const i = messages.length - 1;
                if (Utils.hasValidId(message)) addKey(idMap, String(message.id), i);
                const newUrl = message.url ? Utils.normUrl(message.url) : '';
                if (newUrl) addKey(urlMap, newUrl, i);
                if (!Utils.hasValidId(message) && newUrl) addKey(urlOnlyMap, newUrl, i);
            }
        }
        this.saveMessages(filePath, messages);
    },

    getFileName(url) {
        // 防御（R1）：非字符串 url → 可区分坏源(数字/布尔)哈希命名；无信息(空串/对象)保持 default.json
        // v3.157：数字/布尔 String 化可区分（123 vs 456），曾与空串/对象共用 default.json 互相误判重
        if (typeof url !== 'string') {
            let badStr;
            try { badStr = String(url); } catch (e) { return 'default.json'; }
            if (!badStr || badStr === '[object Object]' || badStr === 'undefined' || badStr === 'null') return 'default.json';
            return 'bad_' + Utils.anonKey(badStr) + '.json';
        }
        if (!url) return 'default.json';
        const parts = url.split('/');
        let name = parts[parts.length - 1].split(/[?#]/)[0]; // 去掉查询参数与 hash
        if (!name || /^\.+$/.test(name)) name = 'default'; // 空/纯点串兜底，避免 '..' → '...json'
        name = name.replace(/[\\/:*"<>|]/g, '_'); // 清洗文件系统保留字符
        if (!name.endsWith('.json')) name += '.json';
        return name;
    },
};

// ============================================================
// 🌐 Network — 网络请求层
// ============================================================
const Network = {
    /**
     * 拉取数据，失败自动重试
     * 官方 got 自带 retry；这里显式关闭内置重试，由主流程统一实现重试、退避和 4xx 例外语义
     */
    async fetchData() {
        let lastErr;
        // R4-1：retry 非法值有界兜底——Infinity 会让 `attempt <= retry` 死循环重试（validateConfig 只警告不阻止）；
        // NaN → 意外只跑 1 次；小数 → 次数模糊。合法整数（默认 2）行为零变更
        // v3.158：Utils.num 转换——'5'(环境变量字符串) → 5（曾 Number.isFinite('5')=false 回退 2）
        const maxRetry = (() => { const r = Utils.num(Config.api.retry, 2); return Number.isInteger(r) && r >= 0 ? r : 2; })();
        for (let attempt = 0; attempt <= maxRetry; attempt++) {
            try {
                // retry: { limit: 0 } 关闭 got 内置重试，完全交给外层手写逻辑
                return await fetchJson(Config.api.pushUrl, {
                    timeout: Utils.num(Config.api.timeout, 5000), // v3.162：字符串'5000'→5000（v3.158 转换 7 处漏了 timeout，曾回退 15s）
                    retry: { limit: 0 },
                    headers: {
                        'User-Agent': `xbk-push-script/${PKG_VERSION}`,
                        'Accept': 'application/json',
                    },
                });
            } catch (e) {
                lastErr = e;

                // 4xx 客户端错误：重试也没用，直接抛出（429 限流除外——限流可能瞬时，值得重试）
                if (e.response) {
                    const sc = e.response.statusCode;
                    if (sc !== undefined && sc < 500 && sc !== 429 && sc !== 408 && sc !== 409) throw e; // v3.158: 408/409 临时性也重试
                }

                if (attempt < maxRetry) { // v3.157：用兜底后的 maxRetry（曾用原始 Config.api.retry，非法类型时与实际重试不一致）
                    // 退避等待：1s、2s、3s...（加 0-500ms 随机抖动，避免多实例同时重试）
                    const wait = 1000 * (attempt + 1) + Math.floor(Math.random() * 500);
                    console.log(`请求失败（${(e && (e.code || e.message)) || String(e)}），${wait / 1000}s 后重试（第 ${attempt + 1}/${maxRetry} 次）...`); // R5-1：显示兜底后次数
                    await new Promise(r => setTimeout(r, wait));
                }
            }
        }
        // 重试耗尽后抛出；防御 retry 为负等异常配置（循环可能一次都不执行 → lastErr undefined）
        throw lastErr || new Error('请求失败（未知错误）');
    },
};

// ============================================================
// 📤 Pusher — 推送层
// ============================================================
const Pusher = {
    async send(text, desp) {
        // R4-2：非字符串归一——undefined/null → 空串（避免模板串输出 'undefined' 文本）；数字等 String() 化
        text = text === undefined || text === null ? '' : String(text);
        desp = desp === undefined || desp === null ? '' : String(desp);
        // 最终推送出口再清理一次：自定义 {内容} 模板可能绕过 Formatter 的 {Html内容} 专用清理，
        // 而 WxPusher HTML 通道会直接渲染 desp；统一出口防止任意模板把主动 HTML 带入客户端。
        // 仅当 desp 呈 HTML 形态（将触发 wxpusher 等 HTML 渲染通道）时清洗：
        // 纯 Markdown/纯文本（默认 {Markdown内容}、{内容} 普通文本）不清洗，
        // 避免破坏 Markdown 代码块、技术讨论文本（onerror= 等字面量）与排版实体。
        const htmlLike = /<\s*\/?\s*[A-Za-z][A-Za-z0-9-]*(?=\s|\/?>)[^>]*>/i.test(desp);
        if (htmlLike) {
            desp = Utils.sanitizeDecodedHtml(Utils.decodeHtmlEntities(desp));
        }
        // 抛异常由主流程处理：推送失败的消息不写缓存，下次运行重试（避免永久丢失）
        // 加整体超时：单通道最坏 15s，避免慢通道把整批推送拖到数分钟
        // v3.121：clearTimeout 清除超时定时器——Promise.race 完成后定时器仍挂着会导致
        // 进程退出延迟（事件循环被 keep-alive）+ 多次推送定时器堆积（资源泄漏）
        let timer;
        try {
            await Promise.race([
                notify.sendNotify(text, desp),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('推送超时(10s)')), 10000); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    },
};

// ============================================================
// 🚀 App — 主流程层
// ============================================================
const App = {
    // v3.176：运行日志时间戳本地化（与日报/告警本地口径一致）——曾 toISOString（UTC），
    // UTC+8 用户凌晨 cron 排查时 UTC 行与本地日期混排易误判（系统审查 #9）
    _localStamp() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    },

    // 状态文件统一原子写入（tmp + rename）：避免进程中断留下半写 JSON，导致告警限频/日报累计状态损坏。
    _writeState(filePath, state) {
        let text;
        try { text = JSON.stringify(state); } catch (e) {
            console.error(`状态序列化失败 ${filePath}:`, e.message);
            return false;
        }
        const tmpFile = filePath + '.tmp';
        try {
            fs.writeFileSync(tmpFile, text, 'utf8');
            fs.renameSync(tmpFile, filePath);
            return true;
        } catch (e) {
            try { fs.unlinkSync(tmpFile); } catch (e2) { /* 忽略 */ }
            console.error(`状态写入失败 ${filePath}:`, e.message);
            return false;
        }
    },

    // 运行日志：追加一行到缓存目录 run.log（成功摘要/失败 ERROR 共用），超过 1MB 截断保留尾部（防无限增长；写失败静默不中断）
    _writeRunLog(line) {
        try {
            const logPath = path.join(MessageStore.cacheDir, 'run.log');
            fs.appendFileSync(logPath, line, 'utf8');
            const st = fs.statSync(logPath);
            if (st.size > 1024 * 1024) {
                const all = fs.readFileSync(logPath, 'utf8');
                let trimmed = all.slice(-512 * 1024);
                // v3.178：slice 可能切在代理对中间（首字符为孤立低代理/尾字符为孤立高代理）→
                // 写回后文件含非法 UTF-8 序列，下次读取显示 U+FFFD（§10-C）——退位到完整字符
                const first = trimmed.charCodeAt(0);
                if (first >= 0xDC00 && first <= 0xDFFF) trimmed = trimmed.slice(1); // 开头孤立低代理（高代理被切掉）
                const last = trimmed.charCodeAt(trimmed.length - 1);
                if (last >= 0xD800 && last <= 0xDBFF) trimmed = trimmed.slice(0, -1); // 结尾孤立高代理（低代理被切掉）
                const nl = trimmed.indexOf('\n');
                fs.writeFileSync(logPath, nl >= 0 ? trimmed.slice(nl + 1) : trimmed, 'utf8');
            }
        } catch (e) { /* 日志写失败静默（磁盘只读/权限等，不中断推送） */ }
    },

    _diskWarningAt: 0,
    _alertLastAtByPath: new Map(),
    _reportMemoryStateByPath: new Map(),

    // 磁盘余量只告警不阻断：statfs 不可用或读取失败时静默跳过。
    _warnLowDisk() {
        const minFree = Utils.num(Config.storage && Config.storage.minFreeBytes, 50 * 1024 * 1024);
        if (!Number.isFinite(minFree) || minFree <= 0) return;
        const info = Utils.diskSpace(MessageStore.cacheDir);
        if (!info || info.freeBytes >= minFree) return;
        const now = Date.now();
        // 同一进程最多每小时提示一次，避免磁盘低时刷屏。
        if (now - this._diskWarningAt < 3600000) return;
        this._diskWarningAt = now;
        const freeMiB = (info.freeBytes / 1024 / 1024).toFixed(1);
        const minMiB = (minFree / 1024 / 1024).toFixed(1);
        console.warn(`⚠️ 缓存所在磁盘余量不足：${freeMiB} MiB（告警阈值 ${minMiB} MiB），写入状态/缓存可能失败`);
    },

    // 接口异常告警（v3.123）：限频 + 静默——不影响主流程；告警也走推送通道（通道挂了就静默，无解）
    _sendAlert(errMsg) {
        try {
            // v3.173/174：!enabled（数字0/空串）或 'false'/'0' 字符串均关闭（'0' 字符串是 truthy，曾漏）
            const en = Config.alert && Config.alert.enabled;
            if (!Config.alert || !en || en === 'false' || en === '0') return;
            const statePath = path.join(MessageStore.cacheDir, 'alert.state');
            const alertMemory = this._alertLastAtByPath.get(statePath);
            let lastAt = alertMemory ? alertMemory.lastAt : 0;
            // 状态文件被外部删除时，已持久化的旧内存状态不应继续生效；写失败的内存状态仍用于本进程限频。
            if (alertMemory && alertMemory.persisted && !fs.existsSync(statePath)) {
                this._alertLastAtByPath.delete(statePath);
                lastAt = 0;
            }
            try { lastAt = Math.max(lastAt, JSON.parse(fs.readFileSync(statePath, 'utf8')).lastAt || 0); } catch (e) { /* 无状态文件=首次 */ }
            const intervalMs = Utils.num(Config.alert.intervalMs, 3600000); // v3.167: 非法字符串'abc'曾>0比较false→0不限频轰炸（其他数值配置均num回退）
            const interval = intervalMs > 0 ? intervalMs : 0; // <=0(含-1) = 不限频（每次异常都发）
            if (interval > 0 && Date.now() - lastAt < interval) return; // 限频：间隔内不重复轰炸
            const alertText = '⚠️ xbk-push 运行异常';
            // v3.159：段落分隔 \n\n（与主推送/日报口径一致）——wxpusher Markdown 渲染单个 \n 可能挤成一行
            const alertDesp = `接口/推送异常，请检查。\n\n时间：${new Date().toLocaleString('zh-CN')}\n\n原因：${String(errMsg).slice(0, 500)}`;
            // v3.156：发送成功才写状态+打印——曾先写 lastAt（发送失败也限频，60s 内挡住重试，信息丢失）
            // v3.157：走 Pusher.send（曾直接 notify.sendNotify——无 10s 超时、无 surrogate 清洗，与主推送不一致）
            // v3.164：返回 promise 供 App.run catch await——曾 fire-and-forget，接口异常时主入口同步 process.exit(1)
            // 杀死未完成的告警 HTTP（cron 直接运行收不到告警，#10）
            return Pusher.send(alertText, alertDesp)
                .then(() => {
                    const sentAt = Date.now();
                    const persisted = this._writeState(statePath, { lastAt: sentAt });
                    this._alertLastAtByPath.set(statePath, { lastAt: sentAt, persisted });
                    if (!persisted) {
                        this._warnLowDisk();
                        console.warn('⚠️ 运行异常告警已发送，但 alert.state 持久化失败；本进程将继续使用内存限频');
                    } else {
                        console.log('已发送运行异常告警（限频 ' + Math.ceil(interval / 60000) + ' 分钟）');
                    }
                })
                .catch(() => { /* v3.135：告警通道也挂了，静默（防 unhandledRejection）；不写状态→下次可重试 */ });
        } catch (e) { /* 告警失败静默（通道也挂了，无解） */ }
    },

    // 运行日报（v3.125）：跨天时发"昨日日报"，当天累加统计；静默不影响主流程
    _updateReport(summary) {
        try {
            // v3.173/174：!enabled（数字0/空串）或 'false'/'0' 字符串均关闭（'0' 字符串是 truthy，曾漏）
            const en = Config.report && Config.report.enabled;
            if (!Config.report || !en || en === 'false' || en === '0') return;
            const statePath = path.join(MessageStore.cacheDir, 'report.state');
            const blankState = () => ({ date: '', total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 });
            const safeCounter = (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 0 ? n : 0;
            };
            const normalizeState = (raw) => {
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blankState();
                const st = blankState();
                st.date = typeof raw.date === 'string' ? raw.date : '';
                for (const k of ['total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) st[k] = safeCounter(raw[k]);
                if (raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending)) {
                    st.pending = blankState();
                    for (const k of ['total', 'dedup', 'filtered', 'pushed', 'failed', 'truncated']) st.pending[k] = safeCounter(raw.pending[k]);
                }
                return st;
            };
            const persistReportState = (next) => {
                const normalized = normalizeState(next);
                const ok = this._writeState(statePath, normalized);
                // 状态写失败时保留进程内已知状态，避免同一进程重复发送日报；重启后仍会重试并发出低磁盘告警。
                this._reportMemoryStateByPath.set(statePath, { state: normalized, persisted: ok });
                if (!ok) {
                    this._warnLowDisk();
                    console.warn('⚠️ 日报发送/累计状态持久化失败；本进程将继续使用内存状态');
                }
                return ok;
            };
            let memoryState = this._reportMemoryStateByPath.get(statePath);
            if (memoryState && memoryState.persisted && !fs.existsSync(statePath)) {
                this._reportMemoryStateByPath.delete(statePath);
                memoryState = null;
            }
            let state = memoryState ? normalizeState(memoryState.state) : blankState();
            if (!memoryState) {
                try { state = normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch (e) { /* 无状态或损坏状态=首次 */ }
            }
            // v3.155：日报日期用本地时区（原 UTC——中国用户凌晨 cron 时本地已跨天但 UTC 未跨，日报日期错位一天）
            const _d = new Date();
            const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
            const acc = (st) => {
                st.total += summary.total || 0;
                st.dedup += summary.dedup || 0;
                st.filtered += summary.filtered || 0;
                st.pushed += summary.pushed || 0;
                st.failed += summary.failed || 0;
                st.truncated += summary.truncated || 0; // v3.176：截断数也入日报（曾只有 run.log 有）
            };
            if (state.date && state.date !== today) {
                // 新的一天：发昨日日报（若有数据）
                if (state.total > 0 || state.failed > 0) {
                    const t = `📊 xbk-push 日报（${state.date}）`;
                    // v3.159：段落分隔 \n\n（与主推送口径一致）——wxpusher Markdown 渲染单个 \n 可能挤成一行
                    const d = `推送 ${state.pushed} 条 | 失败 ${state.failed} 条\n\n获取 ${state.total} | 去重 ${state.dedup} | 过滤 ${state.filtered}${state.truncated ? ` | 截断 ${state.truncated}` : ''}`;
                    // v3.156：发送成功才重置日期——曾先写 state.date（日报失败也跨天，昨日日报丢失）
                    // v3.157：走 Pusher.send（曾直接 notify.sendNotify——无 10s 超时、无 surrogate 清洗）
                    Pusher.send(t, d)
                        .then(() => {
                            // v3.176：昨日日报发送成功 → 重置为今日；取出「昨日日报失败期间的今日累计」
                            // （pending），与本次数据一并计入新的一天（曾直接丢弃——今日数据丢失）
                            const pend = state.pending || { total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 };
                            state = { date: today, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 };
                            acc(state); // 本次数据计入新的一天
                            state.total += pend.total || 0;
                            state.dedup += pend.dedup || 0;
                            state.filtered += pend.filtered || 0;
                            state.pushed += pend.pushed || 0;
                            state.failed += pend.failed || 0;
                            state.truncated += pend.truncated || 0;
                            persistReportState(state);
                            console.log('已发送昨日运行日报');
                        })
                        .catch(() => {
                            // v3.176：失败 → date 不重置（下次运行重试昨日日报）；本次（今日）数据暂存
                            // pending，不污染昨日统计——曾 acc 进旧 state：今日数据被错标进「昨日日报」
                            // 重复发送（系统审查 #4）
                            const pend = state.pending || { total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 };
                            pend.total += summary.total || 0;
                            pend.dedup += summary.dedup || 0;
                            pend.filtered += summary.filtered || 0;
                            pend.pushed += summary.pushed || 0;
                            pend.failed += summary.failed || 0;
                            pend.truncated += summary.truncated || 0;
                            state.pending = pend;
                            persistReportState(state);
                        });
                    return;
                }
                // 昨日无数据：直接跨天（pending 若有则并入今日——防御，正常路径无）
                const pend = state.pending;
                state = { date: today, total: 0, dedup: 0, filtered: 0, pushed: 0, failed: 0, truncated: 0 };
                if (pend) {
                    state.total += pend.total || 0; state.dedup += pend.dedup || 0;
                    state.filtered += pend.filtered || 0; state.pushed += pend.pushed || 0;
                    state.failed += pend.failed || 0; state.truncated += pend.truncated || 0;
                }
            }
            if (!state.date) state.date = today;
            acc(state);
            persistReportState(state);
        } catch (e) { /* 日报失败静默 */ }
    },

    async run() {
        const runStart = Date.now();
        let fetchMs = null;
        console.debug('开始获取线报酷数据...');

        MessageStore.init();
        this._warnLowDisk();

        try {
            // ① 校验配置
            const warnings = RuleEngine.validateConfig(Config.filter);
            for (const w of warnings) console.warn(w);

            // 配置告警显示统一安全字符串化：脏值（Symbol / 异常 valueOf）不能让告警路径再次崩溃。
            const safeConfigText = (value) => {
                try { return String(value); } catch (e) { return '<不可转换值>'; }
            };

            // 校验缓存 maxSize（#7）：函数层已回退默认，配置层补提示（validateConfig 只接收 filter，此处兜底完整 Config）
            // v3.175：字符串 maxSize（'10000' 环境变量）曾误报——用 Utils.num 口径
            if (!Number.isInteger(Utils.num(Config.cache.maxSize, -1)) || Utils.num(Config.cache.maxSize, -1) <= 0) {
                console.warn(`⚠️ 配置「cache.maxSize」为「${safeConfigText(Config.cache.maxSize)}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`);
            }

            // 域名校验（v3.73）：非法 URL 会让 fetchData 重试耗尽才报错，配置层提前提示
            if (typeof Config.domain !== 'string' || !/^https?:\/\//.test(Config.domain)) {
                console.warn(`⚠️ 配置「domain」为「${safeConfigText(Config.domain)}」不是 http(s):// 开头的合法地址`);
            }

            // 模板校验（v3.80）：非字符串回退默认（pushOne 已有回退，配置层补提示）
            if (typeof Config.template.title !== 'string' || typeof Config.template.content !== 'string') {
                console.warn('⚠️ 配置「template.title/content」应为字符串，已回退默认模板');
            }
            // v3.159：模板占位符有效性检查——{价格}/{商城}/{品牌}/{图片} 等接口真实字段不提供，输出恒空且无提示
            const SUPPORTED_TPL_KEYS = ['分类名', '分类ID', '标题', '链接', '日期', '时间', '楼主', '类目', '内容', 'Html内容', 'Markdown内容'];
            for (const tplName of ['title', 'content']) {
                const tpl = Config.template[tplName];
                if (typeof tpl !== 'string') continue;
                const used = new Set();
                const tplRe = /\{([^{}]+)\}/g;
                let tplM;
                while ((tplM = tplRe.exec(tpl))) used.add(tplM[1]);
                for (const k of used) {
                    if (!SUPPORTED_TPL_KEYS.includes(k)) {
                        console.warn(`⚠️ 模板「template.${tplName}」含占位符「{${k}}」——接口真实字段不提供该数据，将输出为空。支持占位符：{${SUPPORTED_TPL_KEYS.join('} {')}}`);
                    }
                }
            }

            // 运行时数值配置校验（函数层已有防御，配置层补提示——#7 同款精神，v3.64）
            // v3.175：校验用 Utils.num 口径——字符串配置（'5000' 环境变量场景）曾误报「不是有效值」
            // （Number.isFinite('5000')=false，但 Utils.num 已生效——假警告误导用户）
            const numConfig = [
                ['api.timeout', Config.api.timeout, (v) => Utils.num(v, -1) > 0],
                ['api.retry', Config.api.retry, (v) => { const n = Utils.num(v, -1); return Number.isInteger(n) && n >= 0; }],
                ['timing.pushInterval', Config.timing.pushInterval, (v) => Utils.num(v, -1) >= 0],
                ['timing.finalWait', Config.timing.finalWait, (v) => Utils.num(v, -1) >= 0],
                ['push.parallelLimit', Config.push.parallelLimit, (v) => Utils.num(v, -1) >= 0],
                ['push.maxPerRun', Config.push.maxPerRun, (v) => { const n = Utils.num(v, -1); return Number.isInteger(n) && n > 0; }],
            ];
            for (const [name, val, ok] of numConfig) {
                if (!ok(val)) {
                    let display;
                    try { display = String(val); } catch (e) { display = '<不可转换值>'; }
                    console.warn(`⚠️ 配置「${name}」为「${display}」不是有效值，已按内部防御逻辑处理（建议修正）`);
                }
            }

            // ② 预编译规则（只执行一次）
            const compiledRules = RuleEngine.compileRules(Config.filter);

            // ③ 拉取数据
            const fetchStart = Date.now();
            const xbkdata = await Network.fetchData();
            fetchMs = Date.now() - fetchStart;
            if (!Array.isArray(xbkdata)) {
                // 接口返回格式异常时不盲跑 for 循环，抛错让调度感知
                throw new Error(`接口返回数据格式异常：期望数组，实际为 ${xbkdata === null ? 'null' : typeof xbkdata}`);
            }

            // ③b 字段归一化 + ④ 去重/全局过滤（合并为一次遍历，顺序保证：校验→归一化→判重）
            let items = [];
            let dedupCount = 0;
            let filteredCount = 0;
            let truncatedCount = 0; // v3.145：maxPerRun 截断数计入统计（曾凭空消失）
            const cacheName = MessageStore.getFileName(Config.api.pushUrl);
            // v3.159：过滤规则哈希比对——规则变更时失效「过滤写入」缓存（改宽过滤后旧条目重新评估/推送，
            // 无需手动清缓存；「推送成功」缓存不受影响，防重复推送）
            {
                const filterHash = Utils.filterHash(Config.filter, Config.keyword.zkt_gjc);
                const hashPath = path.join(MessageStore.cacheDir, 'filter.hash');
                let lastHash = '';
                try { lastHash = fs.readFileSync(hashPath, 'utf8').trim(); } catch (e) { /* 首次运行无状态 */ }
                let filterStateReady = true;
                if (lastHash && lastHash !== filterHash) {
                    const fp = MessageStore.getFilePath(cacheName);
                    const msgs = MessageStore.readMessages(fp);
                    const kept = msgs.filter(m => !(m && typeof m === 'object' && m._f === true));
                    if (kept.length !== msgs.length) {
                        filterStateReady = MessageStore.saveMessages(fp, kept);
                        if (filterStateReady) {
                            console.warn(`⚠️ 检测到过滤规则/只看它变更（${lastHash.slice(0, 8)} → ${filterHash.slice(0, 8)}），已清除 ${msgs.length - kept.length} 条「过滤写入」缓存——之前被过滤的条目将重新评估（改宽后即重新推送）`);
                        } else {
                            console.warn('⚠️ 过滤缓存失效写入失败，本次不更新 filter.hash，下次运行将继续重试规则变更处理');
                        }
                    }
                }
                // 只有过滤缓存清理成功后才推进 hash；否则下次运行必须继续重试，避免旧 _f 永久失效。
                if (filterStateReady) {
                    try { fs.writeFileSync(hashPath, filterHash, 'utf8'); } catch (e) { /* 写失败静默（下次运行重新比对） */ }
                }
            }
            const newMessages = [];
            // v3.179：缓存索引化——曾逐条 MessageStore.has()（每条 O(M) findIndex，共 O(N×M)）：
            // 接口异常返回海量数据（maxPerRun 想防的同一场景）时判重卡死——实测 N=2万/M=1万 → 11.6s，
            // 外推 N=10万 → ~60s（cron 长时间挂起）。改为循环前一次性构建缓存三索引（O(M)），
            // 与批内三索引合并判重 → 全程 O(N+M)。三个 Set 与 _findDedupIndex 三条件同构，
            // 等价性由属性测试证明（800 轮含缓存非空场景，0 失配）
            const cacheMsgs = MessageStore.readMessages(MessageStore.getFilePath(cacheName));
            const cacheIds = new Set();      // 缓存中有 id 条目的 String(id)
            const cacheUrls = new Set();     // 缓存中所有有 url 条目的 normUrl
            const cacheNoIdUrls = new Set(); // 缓存中无 id 有 url 条目的 normUrl
            for (const m of cacheMsgs) {
                if (!m || typeof m !== 'object') continue;
                if (Utils.hasValidId(m)) cacheIds.add(String(m.id));
                const u = m.url ? Utils.normUrl(m.url) : '';
                if (u) {
                    cacheUrls.add(u);
                    if (!Utils.hasValidId(m)) cacheNoIdUrls.add(u);
                }
            }
            // v3.176：批内判重与跨运行判重（_findDedupIndex）口径对齐——曾 key=id:|url: 单维度，
            // 同一批「有 id 条目」与「无 id 同 url 条目」key 不同互不可见 → 双推（系统审查 #2）
            const batchIds = new Set();      // 已收录条目的 String(id)（有 id 条目）
            const batchUrls = new Set();     // 已收录条目的 normUrl(url)（所有有 url 条目）
            const batchNoIdUrls = new Set(); // 已收录无 id 条目的 normUrl(url)（有 id 条目经此与无 id 同 url 交叉判重）

            let badElementCount = 0; // v3.157：非对象元素单独统计（曾混入 filteredCount，诊断不清）
            let regTimePresent = 0; // v3.159：louzhuregtime 有值统计（pingbitime 有效性警告用）
            for (const item of xbkdata) {
                // 元素级校验：非对象元素跳过（v3.176：不再计入 filteredCount——「过滤屏蔽」专指规则过滤，
                // 非对象元素有独立「非对象元素」行，曾双计误导诊断）
                if (!Utils.isValidItem(item)) { badElementCount++; continue; }
                // v3.159：注册时间字段缺失统计（接口可能不提供，pingbitime 配置将不生效）
                if (item.louzhuregtime !== undefined && item.louzhuregtime !== null && item.louzhuregtime !== '') regTimePresent++;
                // 归一化：category_name/category_id 兼容映射 + 无标识数据生成合成 id（在判重前统一处理）
                if (!item.catename && item.category_name) item.catename = item.category_name;
                if (!item.cateid && item.category_id) item.cateid = item.category_id;
                if (!Utils.hasValidId(item) && (!item.url || String(item.url).trim() === '' || Utils.normUrl(item.url) === '')) {
                    // v3.176：url 归一为空（'#'/'?x=1'/'//' 等垃圾值）同样视为无 url → 合成 id
                    // （曾走 key='url:' 空键，多条不同垃圾 url 数据互判为同一资源，后者静默丢弃——系统审查 #5）
                    // v3.176：补 louzhu——同内容不同楼主曾被误合并（系统审查 #6）
                    item.id = Utils.anonKey(item.title, item.content, item.posttime, item.shijianchuo, item.pic, item.mall_name, item.price, item.brand, item.catename, item.louzhu);
                }
                // 判重（口径与 MessageStore._findDedupIndex 一致：缓存索引 + 批内索引合并）：
                //   有 id 条目：按 String(id) 判重，或「对方为无 id 条目且 url 归一相同」交叉判重
                //   无 id 条目：按 url 归一判重（不论对方有无 id）
                const batchUrl = Utils.normUrl(item.url);
                let dup = false;
                if (Utils.hasValidId(item)) {
                    dup = cacheIds.has(String(item.id)) || (batchUrl && cacheNoIdUrls.has(batchUrl))
                       || batchIds.has(String(item.id)) || (batchUrl && batchNoIdUrls.has(batchUrl));
                } else if (batchUrl) {
                    dup = cacheUrls.has(batchUrl) || batchUrls.has(batchUrl);
                }
                if (dup) { dedupCount++; continue; }
                // 收录进批内索引
                if (Utils.hasValidId(item)) batchIds.add(String(item.id));
                if (batchUrl) {
                    batchUrls.add(batchUrl);
                    if (!Utils.hasValidId(item)) batchNoIdUrls.add(batchUrl);
                }
                if (FilterEngine.listfilter(item, compiledRules)) {
                    items.push(item);
                } else {
                    filteredCount++;
                    item._f = true; // v3.159：过滤写入标记（规则变更时失效；过滤=已处理语义，改宽后重新评估）
                }
                newMessages.push(item);
            }

            // v3.159：接口未提供注册时间字段时 pingbitime 过滤不生效——运行期警告（配置无效不感知）
            const pbCfg = Config.filter && Config.filter.pingbitime;
            if (pbCfg !== undefined && pbCfg !== null && String(pbCfg).trim() !== '' && xbkdata.length > 0) {
                const missing = xbkdata.length - regTimePresent;
                if (missing / xbkdata.length > 0.5) {
                    console.warn(`⚠️ 接口返回「louzhuregtime」注册时间字段缺失 ${missing}/${xbkdata.length} 条（>50%）——配置的「pingbitime」过滤基本不会生效（接口可能不提供该字段）`);
                }
            }

            // ⑤ 只看它过滤（独立白名单函数，keyword 正则预编译一次）
            const beforeKwd = items.length;
            const kw = Config.keyword.zkt_gjc;
            // R11-1：非字符串 zkt_gjc（对象/数字脏配置）→ 警告并跳过过滤（String 化会把 '[object Object]' 当正则，静默怪行为）
            if (kw !== undefined && kw !== null && typeof kw !== 'string') {
                console.warn(`⚠️ 配置「zkt_gjc」应为字符串，当前为 ${typeof kw}，已忽略只看它过滤`);
            } else if (kw) {
                if (String(kw).trim() === '') {
                    // 空白关键词 = 误配置，忽略过滤（避免只推含空格的标题）
                    console.warn('⚠️ 配置「zkt_gjc」为空白字符，已忽略只看它过滤');
                } else {
                let kwRe = null;
                if (RuleEngine.hasNestedQuantifier(kw)) {
                    console.warn('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤');
                } else {
                    try {
                        kwRe = new RegExp(kw, 'i');
                    } catch (e) {
                        console.warn('⚠️ 配置「zkt_gjc」包含无效的正则表达式，已忽略只看它过滤');
                    }
                }
                if (kwRe) {
                    // 空标题保留（与推送占位一致，避免"只看它"把无标题数据滤掉）
                    const kept = items.filter(it => !it.title || kwRe.test(it.title));
                    for (const it of items) { if (!kept.includes(it)) it._f = true; } // v3.159：只看它滤掉的同样标记（规则变更失效）
                    items = kept;
                }
                // 非法正则时 kwRe 为 null：items 不过滤，继续正常推送（避免静默清空）
                }
            }
            filteredCount += (beforeKwd - items.length);

            // v3.129：单次推送上限（防接口异常返回海量 → 推送风暴/8 分钟运行；正常 ~20 条无影响）
            // maxPerRun 必须是正整数；小数先取整可能变成 0（如 0.5），会静默跳过全部推送，非法值统一回退默认
            const maxPerRun = (() => { const v = Utils.num(Config.push.maxPerRun, -1); return Number.isInteger(v) && v > 0 ? v : 100; })();
            let truncatedKeys = new Set();
            if (items.length > maxPerRun) {
                truncatedCount = items.length - maxPerRun;
                console.warn(`⚠️ 单次待推送 ${items.length} 条超过上限 ${maxPerRun}，只推前 ${maxPerRun} 条（防接口异常推送风暴；调整 Config.push.maxPerRun）`);
                // v3.134：截断掉的不写缓存——否则下次运行去重跳过导致静默丢失（缓存当"已处理"）；下次运行推剩余
                // keyOf 在 ⑥ 才定义，此处用同口径（id 优先 + url 归一）构造截断 key
                truncatedKeys = new Set(items.slice(maxPerRun).map(it => Utils.hasValidId(it) ? 'id:' + it.id : 'url:' + Utils.normUrl(it.url)));
                items = items.slice(0, maxPerRun);
            }

            // ⑥ 推送（sequential=顺序逐条 / parallel=并行一次推送；失败不中断、不写缓存，下次重试）
            const startTime = Date.now();
            const keyOf = (it) => Utils.hasValidId(it) ? `id:${it.id}` : `url:${Utils.normUrl(it.url)}`;
            // domain 去尾斜杠后与相对路径统一拼接（避免 'https://x.com//rel' 双斜杠）
            // R2：非字符串 domain（脏配置）→ 空串 baseUrl（相对路径不拼前缀，避免 .replace 崩溃）
            const baseUrl = (typeof Config.domain === 'string') ? Config.domain.trim().replace(/\/+$/, '') : ''; // v3.158: trim
            // url 类型防御：非字符串(null/undefined/对象/数字)视为无链接——避免 .includes 崩溃或 [object Object]
            // 与 htmlToMarkdown 的 content_html 口径一致（非字符串视为空）
            const urlOf = (it) => {
                const u = (typeof it.url === 'string') ? it.url.trim() : '';
                if (!u) return '';
                // 含协议或协议相对(//)不拼前缀；相对路径拼 domain（补斜杠）
                return (u.includes('://') || u.startsWith('//') ? u : baseUrl + (u.startsWith('/') ? u : '/' + u));
            };
            const pushedKeys = new Set();

            // 推送模板（v3.68 可配置）：非法/缺失回退默认（默认值与历史硬编码完全一致，现有测试锁定）
            const titleTpl = (typeof Config.template.title === 'string' && Config.template.title) ? Config.template.title : '【{分类名}】{标题}';
            const contentTpl = (typeof Config.template.content === 'string' && Config.template.content) ? Config.template.content : '{Markdown内容}';
            // 推送截断长度（v3.69 可配置）：非正数/非数字回退默认（负数会让 slice(0,-1) 误截尾字符）
            const titleMax = (() => { const v = Utils.num(Config.push.titleMax, 100); return v > 0 ? v : 100; })();
            const contentMax = (() => { const v = Utils.num(Config.push.contentMax, 3000); return v > 0 ? v : 3000; })();

            // 单条推送（两种模式共用）：成功返回 {ok:true} 并记录；失败警告且不写缓存(下次重试)
            const pushOne = async (item) => {
                // 推送内容截断：避免超长标题/内容被推送 API 拒绝（长度可配置，默认 100/3000）
                // 用 UTF-16 安全截断（不切断 emoji 代理对）
                // R9：title/content 非字符串（对象等脏数据）→ 空标题占位/空内容（避免 '[object Object]' 泄漏）
                const pushItem = {
                    ...item,
                    url: urlOf(item),
                    // v3.110：孤立代理清洗（encodeURIComponent 对孤立代理抛 URIError → 推送失败）
                    // R9/审查9-C 语义保留：非字符串或空串 title → (无标题) 占位；content 空串置空
                    title: Utils.truncateUtf16(Utils.sanitizeSurrogates(typeof item.title === 'string' && item.title !== '' ? item.title : '(无标题)'), titleMax),
                    content: Utils.truncateUtf16(Utils.sanitizeSurrogates(typeof item.content === 'string' ? item.content : ''), contentMax),
                };
                // 标题兜底截断（v3.70）：text 由「分类名+标题」拼接，分类名超长时整体可超 titleMax——
                // 与 desp 同口径，titleMax 语义统一为「推送标题最终长度上限」
                const text = Utils.truncateUtf16(Formatter.tuisong_replace(titleTpl, pushItem), titleMax);
                // desp 兜底截断：contentMax 统一作用于推送内容最终长度（v3.69 修复——原只截断 {内容} 字段，
                // {Markdown内容} 走 content_html 转换从不截断，超长 HTML 会撑爆推送 API）
                // v3.110：desp 也清洗孤立代理（content_html 可能含脏代理）
                const rawDesp = Formatter.tuisong_replace(contentTpl, pushItem);
                let desp = Utils.truncateUtf16(Utils.sanitizeSurrogates(rawDesp), contentMax);
                // v3.152：长内容截断曾把尾部"原文链接"截掉（用户看不到链接）——检测并保留
                const rawClean = Utils.sanitizeSurrogates(rawDesp);
                if (rawClean.includes('原文链接') && !desp.includes('原文链接') && pushItem.url) {
                    const link = `原文链接：[${pushItem.url}](<${pushItem.url}>)`;
                    // 链接本身超过 contentMax 时不保留（尊重截断配置）；否则内容截短补链接（仍 ≤ contentMax）
                    // v3.177：边界修正——link 接近 contentMax 时 contentMax-link-2 曾 ≤0，truncateUtf16 对非正
                    // max 返回原串 → desp 全量+链接显著超限（系统验证反证 #3）；改为「链接+分隔符完整容纳
                    // 才补」+ keep≥0 保证总长 ≤ contentMax
                    if (link.length + 2 <= contentMax) {
                        const keep = contentMax - link.length - 2;
                        desp = Utils.truncateUtf16(desp, keep) + '\n\n' + link;
                    }
                }
                try {
                    await Pusher.send(text, desp);
                    pushedKeys.add(keyOf(item));
                    // v3.159：推送成功 → 清除过滤写入标记（否则 _f 随对象写回缓存，下次规则变更又误清）
                    delete item._f;
                    return { item, ok: true };
                } catch (e) {
                    // 非 Error 兜底（R1）：notify 抛字符串等非 Error 时避免 e.message undefined（与 v3.31/73/81 口径一致）
                    console.log(`⚠️ 推送失败（不写入缓存，下次运行重试）: ${item.title}【${item.catename}】 ${e && e.message ? e.message : String(e)}`);
                    return { item, ok: false };
                }
            };

            let successCount = 0;
            // push.mode 非法值提示（防静默降级：用户配 'PARALLEL' 等会按顺序执行）
            if (Config.push && Config.push.mode && Config.push.mode !== 'sequential' && Config.push.mode !== 'parallel') {
                console.warn(`⚠️ 配置「push.mode」值无效：「${safeConfigText(Config.push.mode)}」（应为 sequential/parallel），已按顺序模式执行`);
            }
            if (Config.push && Config.push.mode === 'parallel') {
                // 并行推送：一次性全部发出（parallelLimit>0 时按批限并发）
                // parallelLimit 防御：小数取整（0.5 会产生空批）、0/负数回退全量、空 items 兜底 1
                const limit = (() => { const pl = Utils.num(Config.push.parallelLimit, 0); return pl > 0 ? Math.floor(pl) : items.length; })() || 1;
                const results = [];
                for (let i = 0; i < items.length; i += limit) {
                    const batch = items.slice(i, i + limit);
                    results.push(...await Promise.all(batch.map(pushOne)));
                    if (i + limit < items.length) await new Promise(r => setTimeout(r, Utils.num(Config.timing.pushInterval, 100)));
                }
                // 按原顺序输出成功日志（并发完成顺序不定，日志保持数据顺序）
                for (const r of results) {
                    if (r.ok) console.log(`发现到新数据：${r.item.title}【${r.item.catename}】${urlOf(r.item)}`);
                }
                successCount = results.filter(r => r.ok).length;
            } else {
                // 顺序推送（默认）：逐条 await + 间隔
                for (const item of items) {
                    const r = await pushOne(item);
                    if (r.ok) { successCount++; console.log(`发现到新数据：${item.title}【${item.catename}】${urlOf(item)}`); }
                    await new Promise(r2 => setTimeout(r2, Utils.num(Config.timing.pushInterval, 100)));
                }
            }

            // ⑦ 写缓存：只收录「被过滤的数据」+「推送成功的数据」
            //    推送失败的排除在外 → 下次运行重新推送（避免消息永久丢失）
            const itemsKeys = new Set(items.map(keyOf));
            // v3.134：排除截断未推的（下次运行推剩余，防静默丢失）
            const toCache = newMessages.filter(m => !truncatedKeys.has(keyOf(m)) && (!itemsKeys.has(keyOf(m)) || pushedKeys.has(keyOf(m))));
            MessageStore.saveBatch(toCache, cacheName);

            // ⑧ 统计
            const pushMs = Date.now() - startTime;
            const elapsed = (pushMs / 1000).toFixed(1);
            console.log('\n══════════ 本次运行 ══════════');
            console.log(`  获取:     ${xbkdata.length} 条`);
            console.log(`  去重跳过:  ${dedupCount} 条`);
            console.log(`  过滤屏蔽:  ${filteredCount} 条`);
            if (truncatedCount > 0) console.log(`  截断待推:  ${truncatedCount} 条（下次运行推送，防推送风暴）`);
            if (badElementCount > 0) console.log(`  非对象元素: ${badElementCount} 条（接口脏数据，已跳过）`);
            console.log(`  推送:     ${successCount} 条${successCount < items.length ? `（${items.length - successCount} 条失败，下次运行重试）` : ''}`);
            console.log(`  耗时:     ${elapsed}s`);
            if (process.env.XBK_PROFILE === '1') {
                const totalMs = Date.now() - runStart;
                console.log(`  [profile] 接口: ${fetchMs === null ? 'n/a' : (fetchMs / 1000).toFixed(3) + 's'} | 推送: ${(pushMs / 1000).toFixed(3)}s | 总计: ${(totalMs / 1000).toFixed(3)}s`);
            }
            console.log('══════════════════════════════');
            await new Promise(r => setTimeout(r, Utils.num(Config.timing.finalWait, 200)));

            // v3.163：#9 推送全部失败无告警（v3.123 声称覆盖密钥失效但只实现接口挂）——
            // 补告警推送（限频复用 alert.state，防轰炸）+ run.log ERROR 行（cron 翻日志可见）
            // v3.170：await 告警完成（与 catch 路径 v3.164 同口径）——曾 fire-and-forget，
            // run() 返回后进程退出时序不确定（虽然内部 .catch 兜底不丢，但行为不一致）
            if (items.length > 0 && successCount === 0) {
                try { await this._sendAlert(`推送全部失败（${items.length} 条）：推送通道可能失效（key/限流/API）`); } catch (e) { /* 告警失败不阻塞主流程 */ }
                this._writeRunLog(`${this._localStamp()} ERROR 推送全部失败 ${items.length} 条（通道可能失效）\n`);
            }
            // 运行摘要持久化到缓存目录 run.log（cron 场景回溯/失败趋势；写失败不影响主流程）
            this._writeRunLog(`${this._localStamp()} total=${xbkdata.length} dedup=${dedupCount} filtered=${filteredCount} truncated=${truncatedCount} pushed=${successCount} failed=${items.length - successCount} elapsed=${elapsed}s\n`);

            // v3.125：运行日报（跨天发昨日汇总 + 当天累加；静默）
            const summary = {
                total: xbkdata.length,
                dedup: dedupCount,
                filtered: filteredCount,
                truncated: truncatedCount, // v3.145：截断数（下次推送）
                pushed: successCount,
                failed: items.length - successCount,
            };
            this._updateReport(summary);

            // 返回运行摘要（供外部/测试观测，cron 可据此判断）
            return summary;

        } catch (error) {
            // 非 Error 抛出（如字符串）时兜底，避免 error.message undefined
            const errMsg = error && error.message ? error.message : String(error);
            if (error && error.response) {
                console.log('请求失败，状态码:', error.response.statusCode);
            } else if (error && error.code === 'ETIMEDOUT') {
                console.log('请求超时:', errMsg);
            } else {
                console.log('请求错误:', errMsg);
            }
            // 失败也写运行日志（cron 可回溯失败原因；错误信息去换行避免破坏日志行）
            this._writeRunLog(`${this._localStamp()} ERROR ${String(errMsg).replace(/[\r\n]+/g, ' ')}\n`);
            // v3.123：接口异常告警（限频 + 静默，不影响主流程）
            // v3.164：await 告警完成——主入口 process.exit(1) 前需确保告警 HTTP 送达（#10）
            try { await this._sendAlert(errMsg); } catch (e) { /* 告警失败不阻塞重抛 */ }
            throw error; // 重新抛出，让外层/调度感知失败（cron 场景 exit code 非 0）
        }
    },
};

if (require.main === module) {
    App.run().catch(e => {
        console.error('程序运行失败:', e && e.message ? e.message : String(e));
        process.exit(1); // 失败时非 0 退出，便于 cron/调度感知
    });
}

// ============================================================
// 📤 导出（供测试用）
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        listfilter: FilterEngine.listfilter.bind(FilterEngine),
        filterByKeyword: FilterEngine.filterByKeyword.bind(FilterEngine),
        validateConfig: RuleEngine.validateConfig.bind(RuleEngine),
        tuisong_replace: Formatter.tuisong_replace.bind(Formatter),
        htmlToMarkdown: Formatter.htmlToMarkdown.bind(Formatter),
        isMessageInFile: MessageStore.has.bind(MessageStore),
        appendMessageToFile: MessageStore.save.bind(MessageStore),
        getFileName: MessageStore.getFileName.bind(MessageStore),
        fetchData: Network.fetchData.bind(Network),
        // 主流程（集成测试用）
        run: App.run.bind(App),
        // 推送层（测试/扩展用）
        Pusher,
        // 补充导出（供更全面的测试）
        whitelistFilter: FilterEngine.whitelistFilter.bind(FilterEngine),
        compileRules: RuleEngine.compileRules.bind(RuleEngine),
        matchesCompiled: RuleEngine.matchesCompiled.bind(RuleEngine),
        checkTimeCompiled: RuleEngine.checkTimeCompiled.bind(RuleEngine),
        saveBatch: MessageStore.saveBatch.bind(MessageStore),
        init: MessageStore.init.bind(MessageStore),
        decodeHtmlEntities: Utils.decodeHtmlEntities.bind(Utils),
        anonKey: Utils.anonKey.bind(Utils),
        hasValidId: Utils.hasValidId.bind(Utils),
        normUrl: Utils.normUrl.bind(Utils),
        daysComputed: Utils.daysComputed.bind(Utils),
        // 过滤子方法
        checkRegisterTime: FilterEngine.checkRegisterTime.bind(FilterEngine),
        checkCategory: FilterEngine.checkCategory.bind(FilterEngine),
        checkFields: FilterEngine.checkFields.bind(FilterEngine),
        // 规则解析内部方法
        _splitLines: RuleEngine._splitLines.bind(RuleEngine),
        // UTF-16 安全截断（代理对感知）
        truncateUtf16: Utils.truncateUtf16.bind(Utils),
        // ReDoS 防护检测（嵌套量词）
        hasNestedQuantifier: RuleEngine.hasNestedQuantifier.bind(RuleEngine),
        // 缓存内部方法
        getFilePath: MessageStore.getFilePath.bind(MessageStore),
        _ensureFileExists: MessageStore._ensureFileExists.bind(MessageStore),
        readMessages: MessageStore.readMessages.bind(MessageStore),
        saveMessages: MessageStore.saveMessages.bind(MessageStore),
        Config,
    };
}