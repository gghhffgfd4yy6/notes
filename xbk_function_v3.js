//******** 线报酷推送脚本 v3.67 — 规则预编译 + 白名单重构 + HTML实体解码 + 原子写入 + 审查加固 + 日期解析统一 + 审查项批量 + 配置校验 + 运行日志增强 + 口径统一 ********
// 按职责分层：配置 → 工具 → 格式化 → 规则 → 过滤 → 缓存 → 网络 → 推送 → 主流程

'use strict';

// ============================================================
// 📦 外部依赖
// ============================================================
const notify = require('./xbk_sendNotify_slim');
const fs = require('fs');
const got = require('got');
const path = require('path');

// ============================================================
// ⚙️ Config — 配置层
// ============================================================
const Config = {
    domain: 'https://new.ixbk.net',

    api: {
        get pushUrl() { return `${Config.domain}/plus/json/push.json`; },
        timeout: 5000,
        retry: 2,
    },

    filter: {
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

    // 推送模式：sequential=顺序逐条(默认) | parallel=并行一次推送
    // parallelLimit：并行并发上限，0=不限制(全量一次发出)，N>0=每批 N 条
    push: {
        mode: 'sequential',
        parallelLimit: 0,
    },

    cache: {
        maxSize: 100,
        dir: 'xianbaoku_cache',
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
const DEFAULT_MAX_SIZE = 100;                  // 缓存默认上限

// 实体映射与正则提升为模块级常量（避免每次调用重建）
const ENTITY_MAP = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    '&hellip;': '…', '&mdash;': '—', '&copy;': '©', '&reg;': '®', '&trade;': '™',
    '&euro;': '€', '&times;': '×', '&divide;': '÷', '&middot;': '·', '&deg;': '°',
    '&plusmn;': '±', '&laquo;': '«', '&raquo;': '»',
    '&ndash;': '–', '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”',
    '&bull;': '•', '&sect;': '§', '&para;': '¶', '&pound;': '£', '&yen;': '¥',
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
        const s = String(time);
        // 纯数字：8 位日期优先于时间戳（20260731 是日期不是时间戳）
        // 数字类型（含 -1 等负值）也走数字分支——负值/范围外在下方统一判无效，
        // 避免掉进宿主解析被 new Date('-1') 解析成 2001-01-01（审查5-2 锁定）
        if (typeof time === 'number' || /^\d+$/.test(s)) {
            const n = Number(s);
            // 8 位 YYYYMMDD：月份 1~12 / 日期 1~31 预检 + 回读校验（拒绝 20261332 这类非法日期）
            const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
            if (m8 && Number(m8[2]) >= 1 && Number(m8[2]) <= 12 && Number(m8[3]) >= 1 && Number(m8[3]) <= 31) {
                const t = new Date(+m8[1], +m8[2] - 1, +m8[3]);
                if (t.getFullYear() === +m8[1] && t.getMonth() === +m8[2] - 1 && t.getDate() === +m8[3]) return t.getTime();
                return null;
            }
            // 时间戳：0 = 1970-01-01 不应被短路；秒(1e8~TS_BOUND)/毫秒(TS_BOUND~1e14)按 TS_BOUND 分界
            if (n === 0 || (n >= 1e8 && n < 1e14)) {
                const ms = n < TS_BOUND ? n * 1000 : n;
                const t = new Date(ms);
                if (!isNaN(t.getTime())) return t.getTime();
            }
            return null;
        }
        // 严格匹配完整 YYYY-MM-DD（1~2 位月日；锚定结尾，拒绝 2026-07-31abc 脏前缀）
        const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) {
            const y = +m[1], mo = +m[2], d = +m[3];
            const t = new Date(y, mo - 1, d);
            // 回读校验：new Date 会把 2026-02-31 滚动到 03-03，回读对比即拒绝
            if (t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d) return t.getTime();
            return null;
        }
        // 其他格式（含 ISO 2026-08-01T00:00:00Z、/ 分隔等）回退宿主解析；先原生（支持 ISO），失败再试 / 替换
        let t = new Date(s);
        if (isNaN(t.getTime())) t = new Date(s.replace(/-/g, '/'));
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

    /** 距今天数：正差向下取整，非正差(今天/未来)返回 0 */
    daysFrom(ms) {
        const diff = Date.now() - ms;
        return diff > 0 ? Math.floor(diff / DAY_MS) : 0;
    },

    /** 归一化 URL 用于判重：trim + 去尾部斜杠（/foo 与 foo、foo/ 视为同一资源） */
    normUrl(u) {
        // 归一化用于判重：trim + 去首尾斜杠 + 主机名小写（/foo、foo、foo/、A.com/a vs a.com/a 视为同一资源）
        let s = String(u === undefined || u === null ? '' : u).trim();
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
        if (m.id === undefined || m.id === null) return false;
        const t = typeof m.id;
        if (t === 'string') return m.id.trim() !== '';
        if (t === 'number') return Number.isFinite(m.id); // 数字 id 有效（含 0，语义依数据源）
        return false; // 布尔/对象/数组/Symbol 等脏数据 id 一律无效
    },

    /** 无 id 无 url 数据的稳定合成 id：基于 title+content 哈希，跨运行可去重 */
    anonKey(...parts) {
        // 过滤空值：避免全空字段导致不同数据撞同一个 key
        const s = parts.filter(p => p !== undefined && p !== null && String(p).trim() !== '').map(p => String(p)).join('|');
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return 'anon:' + h.toString(16);
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
     */
    truncateUtf16(s, max) {
        s = String(s === undefined || s === null ? '' : s);
        if (s.length <= max) return s;
        let cut = s.slice(0, max);
        const last = cut.charCodeAt(cut.length - 1);
        if (last >= SURROGATE_LO && last <= SURROGATE_HI) {
            // 代理区：高代理必孤立(缺低代理)；低代理需确认前一位是高代理(配对完整)才保留
            if (!(last >= 0xDC00)) return cut.slice(0, -1); // 高代理 → 退一位
            const prev = cut.charCodeAt(cut.length - 2);
            if (!(prev >= SURROGATE_LO && prev <= 0xDBFF)) return cut.slice(0, -1); // 孤立低代理 → 退一位
        }
        return cut;
    },

    /** 解码常见 HTML 实体 */
    decodeHtmlEntities(str) {
        if (str === undefined || str === null) return '';
        str = String(str);
        if (!str) return str;
        return str
            .replace(ENTITY_RE, m => ENTITY_MAP[m] || m)
            .replace(DEC_RE, (_, code) => this._decodeNumeric(Number(code), `&#${code};`))
            .replace(HEX_RE, (_, hex) => this._decodeNumeric(parseInt(hex, 16), `&#x${hex};`));
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
        // url 文本与链接目标统一：非字符串转字符串、剥离换行（Markdown 链接文本/目标内的裸换行都会破坏链接，#65）
        const urlText = shuju.url === undefined || shuju.url === null ? '' : String(shuju.url).replace(/[\r\n]+/g, '');
        // url 含 Markdown 特殊字符(空格/括号/])时用 <> 包裹（短路与正常路径共用）
        const mdUrl = urlText && /[\s()\[\]]/.test(urlText) ? `<${urlText}>` : urlText;
        // 无标签内容短路：跳过整个替换链（性能优化）
        if (!html.includes('<')) {
            html = Utils.decodeHtmlEntities(html);
            return this._finalizeMd(mdUrl ? html + `\n\n原文链接：[${urlText}](${mdUrl})` : html);
        }
        html = html
            .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, c) => '#'.repeat(lv) + ' ' + c + '\n\n')
            .replace(/<a\s*[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
                // 空 href 不生成空链接；危险协议(javascript:/vbscript:/data:)仅保留文本，防 XSS
                const h = String(href).trim().toLowerCase();
                return (href.trim() && !/^(javascript|vbscript|data):/.test(h)) ? `[${txt}](${href})` : txt;
            })
            .replace(/<img\b[^>]*>/gi, (tag) => {
                const srcM = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
                if (!srcM) return tag; // 无 src 不转换
                const src = srcM[1].trim();
                if (!src) return tag; // 空 src（含纯空白）不生成 ![]() 空图片（#56）
                const altM = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
                return `\n\n![${altM ? altM[1] : ''}](${src})\n\n`;
            })
            .replace(/<br\s*\/?>|<\/br>\s*/gi, '\n\n')
            .replace(/<\/?p[^>]*>/gi, '\n\n')
            // 列表/粗体/斜体转 Markdown（在标签剥离前）：<li> → - 项、<b>/<strong> → **、<i>/<em> → *
            .replace(/<li[^>]*>/gi, '\n- ')
            .replace(/<\/li>/gi, '\n')
            .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
            .replace(/<\/?(?:b|strong)[^>]*>/gi, '**')
            .replace(/<\/?(?:i|em)[^>]*>/gi, '*')
            // 表格：单元格 | 分隔、行/表换行（曾全部粘连成"甲乙丙丁"）
            .replace(/<td[^>]*>/gi, ' | ')
            .replace(/<th[^>]*>/gi, ' | ')
            .replace(/<tr[^>]*>/gi, '\n')
            .replace(/<table[^>]*>/gi, '\n\n')
            .replace(/<script[\s\S]*?<\/script>/gi, '')   // 脚本内容整体移除
            .replace(/<style[\s\S]*?<\/style>/gi, '')     // 样式内容整体移除
            .replace(/<{2,}|>{2,}/g, '')   // 成对尖括号剥离
            .replace(/<[^>]+>/g, '')
            .replace(/\n{3,}/g, '\n\n');
        // 先移除 HTML 标签，再解码实体
        html = Utils.decodeHtmlEntities(html);
        let result = html + (mdUrl ? `\n\n原文链接：[${urlText}](${mdUrl})` : '');
        // 模板拼接后再次合并连续换行（内容尾部 \n\n + 模板 \n\n 会拼出 3+ 连换行）
        return this._finalizeMd(result);
    },

    tuisong_replace(text, shuju) {
        // 防御：模板缺失/非字符串时转空串或字符串化，避免 text.includes 崩溃
        text = text === undefined || text === null ? '' : String(text);
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
                data.datetime = `${dt.getFullYear()}-${Utils.add0(dt.getMonth() + 1)}-${Utils.add0(dt.getDate())}`;
                data.shorttime = `${dt.getHours()}:${Utils.add0(dt.getMinutes())}`;
            }
        }

        // 惰性计算：只有模板里真正用到 {Html内容} / {Markdown内容} 时才跑一遍替换/正则，
        // 避免像 App.run 里那样对同一条数据分别调用 tuisong_replace 生成 text/desp 时，
        // 没用到 Markdown 的那次也白白算一遍 htmlToMarkdown
        // url 做 HTML 转义，避免特殊字符破坏 <a href="..."> 结构
        const escUrl = String(data.url === undefined || data.url === null ? '' : data.url)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // 与 htmlToMarkdown 口径一致：非字符串 content_html 视为空（避免 [object Object] 泄漏）
        const rawHtml = (typeof data.content_html === 'string') ? data.content_html : '';
        const getContentHtml = () => `${rawHtml}<br>&nbsp;<br>&nbsp;<br>原文链接：<a href="${escUrl}" target="_blank">${escUrl}</a><br>&nbsp;<br>&nbsp;<br>`;

        const map = {
            '{标题}': data.title,
            '{内容}': data.content,
            '{Html内容}': text.includes('{Html内容}') ? getContentHtml() : undefined,
            '{Markdown内容}': text.includes('{Markdown内容}') ? this.htmlToMarkdown(data) : undefined,
            '{分类名}': data.catename,
            '{分类ID}': data.cateid,
            '{链接}': data.url,
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
                return typeof val === 'object' ? JSON.stringify(val) : val;
            });
        }
        return text;
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
        const s = String(pattern);
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
        const stack = [{ inf: false }]; // 栈顶=当前分组：inf=组内最后一个 token 是否以无限量词结尾
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            const cur = stack[stack.length - 1];
            if (ch === '\\') { i++; cur.inf = false; continue; } // 转义（含 \( \) \d 等）视为普通 token
            if (ch === '[') {
                let j = i + 1;
                if (s[j] === '^') j++;
                if (s[j] === ']') j++; // 空类 ] 开头
                while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++; }
                i = j; cur.inf = false; continue; // 字符类整体视为普通 token
            }
            if (ch === '(') { stack.push({ inf: false }); continue; }
            if (ch === ')') {
                if (stack.length === 1) { cur.inf = false; continue; } // 多余右括号
                const closed = stack.pop();
                const parent = stack[stack.length - 1];
                const ql = infQuantLen(i + 1);
                if (closed.inf && ql > 0) return true; // 组以无限量词结尾 + 组后无限量词 → 灾难性
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
        if (!configStr) return [];
        if (!/###/.test(configStr)) return null; // 简单模式
        return configStr.split(/<br>|\r\n|\r|\n/);
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
            const val = rawCfg[field];
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
                if (this.hasNestedQuantifier(val)) { compiled[field] = null; continue; } // ReDoS 防护
                try {
                    compiled[field] = { _type: 're', re: new RegExp(val, 'i') };
                } catch (e) {
                    compiled[field] = null; // 预期：非法正则置 null 跳过（validateConfig 已警告）
                }
            }
        }

        // 编译 pingbitime（特殊处理）
        if (rawCfg.pingbitime) {
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
                compiled.pingbitime = (Number.isFinite(value) && value >= 0) ? { _type: 'time', value } : { _type: 'time', value: 0 };
            }
        } else {
            compiled.pingbitime = null;
        }

        compiled.__compiled = true;
        return compiled;
    },

    /** 多行规则分类匹配：无 cat 限制(匹配所有)或有 cat 且 catename 匹配 */
    _catMatches(rule, catename) {
        return !rule.cat || (catename && rule.cat.test(catename));
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

        if (compiled._type === 're') {
            // 简单正则
            return compiled.re.test(fieldValue);
        }

        if (compiled._type === 'multi') {
            // 多行多分类：任意一行匹配即匹配
            return this._anyRule(compiled.rules, catename, r => r.val.test(fieldValue));
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

        // pingbifenlei 不支持 ### 多行分类语法，给明确警告
        if (cfg.pingbifenlei && /###/.test(cfg.pingbifenlei)) {
            warnings.push('⚠️ 配置「pingbifenlei」不支持 ### 多行分类语法，该规则将被忽略\n   如需按分类屏蔽，请直接写分类名正则，例如：微博|赚客吧');
        }

        for (const field of FILTER_FIELDS) {
            const val = cfg[field];
            if (!val) continue;
            // 多行模式：逐行验证
            if (/###/.test(val)) {
                const lines = val.split(/<br>|\r\n|\r|\n/); // 与 _splitLines 口径一致(含单独 \r)
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
        if (cfg.zkt_gjc && String(cfg.zkt_gjc).trim() !== '') {
            if (this.hasNestedQuantifier(cfg.zkt_gjc)) {
                warnings.push('⚠️ 配置「zkt_gjc」的正则含嵌套量词，可能导致灾难性回溯，已忽略只看它过滤');
            } else {
                try { new RegExp(cfg.zkt_gjc, 'i'); }
                catch (e) { warnings.push(`⚠️ 配置「zkt_gjc」包含无效的正则表达式：「${cfg.zkt_gjc}」`); }
            }
        }

        // 验证 pingbitime
        if (cfg.pingbitime) {
            if (/###/.test(cfg.pingbitime)) {
                const lines = cfg.pingbitime.split(/<br>|\r\n|\r|\n/); // 与 _splitLines 口径一致(含单独 \r)
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
                const tv = Number(cfg.pingbitime);
                if (!Number.isFinite(tv) || tv < 0) {
                    warnings.push(`⚠️ 配置「pingbitime」的值「${cfg.pingbitime}」不是有效数字（需 ≥0 的有限数）`);
                } else if (!Number.isInteger(tv)) {
                    warnings.push(`⚠️ 配置「pingbitime」的值「${cfg.pingbitime}」是小数，已按整数处理（建议使用整数天数）`);
                }
            }
        }
        // 校验 cache.maxSize（#7）：MessageStore 函数层已回退默认，配置层补提示。
        // 兼容传入完整 Config（cfg.cache.maxSize）或平铺（cfg.maxSize）两种形态
        const maxSizeVal = cfg.cache ? cfg.cache.maxSize : cfg.maxSize;
        if (maxSizeVal !== undefined && (!Number.isInteger(maxSizeVal) || maxSizeVal <= 0)) {
            warnings.push(`⚠️ 配置「cache.maxSize」为「${maxSizeVal}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`);
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
        if (!keyword || String(keyword).trim() === '') return true; // 空/空白关键词 = 全部通过
        if (!item) return false; // 防御：item 缺失 = 不匹配
        const value = item[field];
        if (!value) return false;
        if (RuleEngine.hasNestedQuantifier(String(keyword))) return true; // ReDoS 防护：风险关键词不执行匹配，全部放行（与非法正则口径一致）
        try {
            return new RegExp(keyword, 'i').test(value);
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
    get cacheDir() { return path.join(__dirname, Config.cache.dir); },
    _memoryCache: {},
    // 内存缓存 key 上限（防御：pushUrl 变化等场景下防止无限增长泄漏；磁盘缓存为权威可重建）
    _MEMO_MAX: 100,

    /** 带上限的内存缓存写入：超限时整体重置（磁盘不受影响），防理论无限增长 */
    _memoSet(filePath, val) {
        if (!(filePath in this._memoryCache) && Object.keys(this._memoryCache).length >= this._MEMO_MAX) {
            this._memoryCache = {};
            console.warn(`内存缓存达到上限(${this._MEMO_MAX})，已重置（磁盘缓存不受影响）`);
        }
        this._memoryCache[filePath] = val;
    },

    /** 统一更新/追加：命中则更新(含覆盖提示)，未命中追加 */
    _upsert(messages, message, filename) {
        const idx = this._findDedupIndex(messages, message);
        if (idx >= 0) {
            // 序列化比较（循环引用等失败时按"已更新"处理，不崩溃）
            let changed = false;
            try { changed = JSON.stringify(messages[idx]) !== JSON.stringify(message); } catch (e) { changed = true; }
            if (changed) {
                console.log(`更新缓存记录: ${filename}`);
            }
            messages[idx] = { ...message, timestamp: new Date().toISOString() };
        } else {
            messages.push({ ...message, timestamp: new Date().toISOString() });
        }
    },

    /** 统一判重：有效 id 优先（类型归一 + 同 url 兜底，兼容旧 url-only 缓存与 id 类型漂移），否则 url fallback */
    _findDedupIndex(messages, message) {
        return messages.findIndex(m =>
            (Utils.hasValidId(message) && (String(m.id) === String(message.id) || (!Utils.hasValidId(m) && m.url && message.url && Utils.normUrl(m.url) === Utils.normUrl(message.url)))) ||
            (!Utils.hasValidId(message) && message.url && Utils.normUrl(m.url) === Utils.normUrl(message.url))
        );
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
        let safe = path.basename(String(filename || '')).replace(/[\\/:*?"<>|]/g, '');
        if (!safe || safe === '.' || safe === '..') safe = 'default.json';
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
        if (this._memoryCache[filePath]) return this._memoryCache[filePath];
        this._ensureFileExists(filePath);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
            if (Array.isArray(data)) {
                // 过滤非对象元素（null/原始值），避免后续 has/save 访问 m.id 崩溃
                const clean = data.filter(m => m && typeof m === 'object');
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
        // 拷贝后再截断：不原地修改调用方传入的数组（外部复用场景）
        const toSave = Array.isArray(messages) ? [...messages] : [];
        // maxSize 防御：非正数回退默认（避免 0/负值导致缓存被清空）
        const maxSize = Number.isFinite(Config.cache.maxSize) && Config.cache.maxSize > 0
            ? Config.cache.maxSize : DEFAULT_MAX_SIZE;
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
            this._memoSet(filePath, toSave);
            return;
        }
        // 原子写入：先写 tmp 再 rename，避免并发/崩溃时半写文件损坏缓存
        const tmpFile = filePath + '.tmp';
        try {
            fs.writeFileSync(tmpFile, text, 'utf8');
            fs.renameSync(tmpFile, filePath);
        } catch (e) {
            // 写失败/rename 失败：清理 tmp 残留，不中断
            try { fs.unlinkSync(tmpFile); } catch (e2) { /* 忽略 */ }
            console.error(`缓存写入失败 ${filePath}:`, e.message);
        }
        this._memoSet(filePath, toSave);
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
        if (!newMessages || newMessages.length === 0) return;
        const filePath = this.getFilePath(filename);
        const messages = this.readMessages(filePath);
        for (const message of newMessages) {
            // 元素级校验：非对象元素跳过（避免访问 message.id 崩溃）
            if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
            // 统一更新/追加（helper）：判重 + upsert 一体
            this._upsert(messages, message, filename);
        }
        this.saveMessages(filePath, messages);
    },

    getFileName(url) {
        const parts = String(url || '').split('/');
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
     * got 简易模块不支持 retry，这里手动实现
     */
    async fetchData() {
        let lastErr;
        for (let attempt = 0; attempt <= Config.api.retry; attempt++) {
            try {
                // retry: { limit: 0 } 关闭 got 内置重试，完全交给外层手写逻辑
                return await got(Config.api.pushUrl, {
                    timeout: Config.api.timeout,
                    retry: { limit: 0 },
                    headers: {
                        'User-Agent': 'xbk-push-script/3.x',
                        'Accept': 'application/json',
                    },
                }).json();
            } catch (e) {
                lastErr = e;

                // 4xx 客户端错误：重试也没用，直接抛出（429 限流除外——限流可能瞬时，值得重试）
                if (e.response) {
                    const sc = e.response.statusCode;
                    if (sc !== undefined && sc < 500 && sc !== 429) throw e;
                }

                if (attempt < Config.api.retry) {
                    // 退避等待：1s、2s、3s...（加 0-500ms 随机抖动，避免多实例同时重试）
                    const wait = 1000 * (attempt + 1) + Math.floor(Math.random() * 500);
                    console.log(`请求失败（${e.code || e.message}），${wait / 1000}s 后重试（第 ${attempt + 1}/${Config.api.retry} 次）...`);
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
        // 抛异常由主流程处理：推送失败的消息不写缓存，下次运行重试（避免永久丢失）
        // 加整体超时：单通道最坏 15s，避免慢通道把整批推送拖到数分钟
        await Promise.race([
            notify.sendNotify(text, desp),
            new Promise((_, rej) => setTimeout(() => rej(new Error('推送超时(10s)')), 10000)),
        ]);
    },
};

// ============================================================
// 🚀 App — 主流程层
// ============================================================
const App = {
    // 运行日志：追加一行到缓存目录 run.log（成功摘要/失败 ERROR 共用），超过 1MB 截断保留尾部（防无限增长；写失败静默不中断）
    _writeRunLog(line) {
        try {
            const logPath = path.join(MessageStore.cacheDir, 'run.log');
            fs.appendFileSync(logPath, line, 'utf8');
            const st = fs.statSync(logPath);
            if (st.size > 1024 * 1024) {
                const all = fs.readFileSync(logPath, 'utf8');
                const trimmed = all.slice(-512 * 1024);
                const nl = trimmed.indexOf('\n');
                fs.writeFileSync(logPath, nl >= 0 ? trimmed.slice(nl + 1) : trimmed, 'utf8');
            }
        } catch (e) { /* 日志写失败静默（磁盘只读/权限等，不中断推送） */ }
    },

    async run() {
        console.debug('开始获取线报酷数据...');

        MessageStore.init();

        try {
            // ① 校验配置
            const warnings = RuleEngine.validateConfig(Config.filter);
            for (const w of warnings) console.warn(w);

            // 校验缓存 maxSize（#7）：函数层已回退默认，配置层补提示（validateConfig 只接收 filter，此处兜底完整 Config）
            if (!Number.isInteger(Config.cache.maxSize) || Config.cache.maxSize <= 0) {
                console.warn(`⚠️ 配置「cache.maxSize」为「${Config.cache.maxSize}」不是正整数，已回退默认 ${DEFAULT_MAX_SIZE}`);
            }

            // 运行时数值配置校验（函数层已有防御，配置层补提示——#7 同款精神，v3.64）
            const numConfig = [
                ['api.timeout', Config.api.timeout, (v) => Number.isFinite(v) && v > 0],
                ['api.retry', Config.api.retry, (v) => Number.isInteger(v) && v >= 0],
                ['timing.pushInterval', Config.timing.pushInterval, (v) => Number.isFinite(v) && v >= 0],
                ['timing.finalWait', Config.timing.finalWait, (v) => Number.isFinite(v) && v >= 0],
                ['push.parallelLimit', Config.push.parallelLimit, (v) => Number.isFinite(v) && v >= 0],
            ];
            for (const [name, val, ok] of numConfig) {
                if (!ok(val)) console.warn(`⚠️ 配置「${name}」为「${val}」不是有效值，已按内部防御逻辑处理（建议修正）`);
            }

            // ② 预编译规则（只执行一次）
            const compiledRules = RuleEngine.compileRules(Config.filter);

            // ③ 拉取数据
            const xbkdata = await Network.fetchData();
            if (!Array.isArray(xbkdata)) {
                // 接口返回格式异常时不盲跑 for 循环，抛错让调度感知
                throw new Error(`接口返回数据格式异常：期望数组，实际为 ${xbkdata === null ? 'null' : typeof xbkdata}`);
            }

            // ③b 字段归一化 + ④ 去重/全局过滤（合并为一次遍历，顺序保证：校验→归一化→判重）
            let items = [];
            let dedupCount = 0;
            let filteredCount = 0;
            const cacheName = MessageStore.getFileName(Config.api.pushUrl);
            const newMessages = [];
            const seenInBatch = new Set(); // 防止同一批接口数据里出现重复 id/url 时被重复收录

            for (const item of xbkdata) {
                // 元素级校验：非对象元素跳过（统计为屏蔽，不崩溃）
                if (!Utils.isValidItem(item)) { filteredCount++; continue; }
                // 归一化：category_name/category_id 兼容映射 + 无标识数据生成合成 id（在判重前统一处理）
                if (!item.catename && item.category_name) item.catename = item.category_name;
                if (!item.cateid && item.category_id) item.cateid = item.category_id;
                if (!Utils.hasValidId(item) && (!item.url || String(item.url).trim() === '')) {
                    item.id = Utils.anonKey(item.title, item.content, item.posttime, item.shijianchuo, item.pic, item.mall_name);
                }
                // key：有效 id 优先（null/'' 不算；归一化已为无标识数据生成合成 id），url 兜底
                const key = Utils.hasValidId(item) ? `id:${item.id}` : `url:${Utils.normUrl(item.url)}`;
                if (MessageStore.has(item, cacheName) || seenInBatch.has(key)) { dedupCount++; continue; }
                seenInBatch.add(key);
                newMessages.push(item);
                if (FilterEngine.listfilter(item, compiledRules)) {
                    items.push(item);
                } else {
                    filteredCount++;
                }
            }

            // ⑤ 只看它过滤（独立白名单函数，keyword 正则预编译一次）
            const beforeKwd = items.length;
            const kw = Config.keyword.zkt_gjc;
            if (kw) {
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
                    items = items.filter(it => !it.title || kwRe.test(it.title));
                }
                // 非法正则时 kwRe 为 null：items 不过滤，继续正常推送（避免静默清空）
                }
            }
            filteredCount += (beforeKwd - items.length);

            // ⑥ 推送（sequential=顺序逐条 / parallel=并行一次推送；失败不中断、不写缓存，下次重试）
            const startTime = Date.now();
            const keyOf = (it) => Utils.hasValidId(it) ? `id:${it.id}` : `url:${Utils.normUrl(it.url)}`;
            // domain 去尾斜杠后与相对路径统一拼接（避免 'https://x.com//rel' 双斜杠）
            const baseUrl = Config.domain.replace(/\/+$/, '');
            // url 类型防御：非字符串(null/undefined/对象/数字)视为无链接——避免 .includes 崩溃或 [object Object]
            // 与 htmlToMarkdown 的 content_html 口径一致（非字符串视为空）
            const urlOf = (it) => {
                const u = (typeof it.url === 'string') ? it.url.trim() : '';
                if (!u) return '';
                // 含协议或协议相对(//)不拼前缀；相对路径拼 domain（补斜杠）
                return (u.includes('://') || u.startsWith('//') ? u : baseUrl + (u.startsWith('/') ? u : '/' + u));
            };
            const pushedKeys = new Set();

            // 单条推送（两种模式共用）：成功返回 {ok:true} 并记录；失败警告且不写缓存(下次重试)
            const pushOne = async (item) => {
                // 推送内容截断：避免超长标题/内容被推送 API 拒绝（Server酱 title 限 32 字符）
                // 用 UTF-16 安全截断（不切断 emoji 代理对）
                const pushItem = {
                    ...item,
                    url: urlOf(item),
                    title: Utils.truncateUtf16(item.title || '(无标题)', 100),
                    content: Utils.truncateUtf16(item.content || '', 3000),
                };
                const text = Formatter.tuisong_replace('【{分类名}】{标题}', pushItem);
                const desp = Formatter.tuisong_replace('{Markdown内容}', pushItem);
                try {
                    await Pusher.send(text, desp);
                    pushedKeys.add(keyOf(item));
                    return { item, ok: true };
                } catch (e) {
                    console.log(`⚠️ 推送失败（不写入缓存，下次运行重试）: ${item.title}【${item.catename}】 ${e.message}`);
                    return { item, ok: false };
                }
            };

            let successCount = 0;
            // push.mode 非法值提示（防静默降级：用户配 'PARALLEL' 等会按顺序执行）
            if (Config.push && Config.push.mode && Config.push.mode !== 'sequential' && Config.push.mode !== 'parallel') {
                console.warn(`⚠️ 配置「push.mode」值无效：「${Config.push.mode}」（应为 sequential/parallel），已按顺序模式执行`);
            }
            if (Config.push && Config.push.mode === 'parallel') {
                // 并行推送：一次性全部发出（parallelLimit>0 时按批限并发）
                // parallelLimit 防御：小数取整（0.5 会产生空批）、0/负数回退全量、空 items 兜底 1
                const limit = (Number.isFinite(Config.push.parallelLimit) && Config.push.parallelLimit > 0
                    ? Math.floor(Config.push.parallelLimit) : items.length) || 1;
                const results = [];
                for (let i = 0; i < items.length; i += limit) {
                    const batch = items.slice(i, i + limit);
                    results.push(...await Promise.all(batch.map(pushOne)));
                    if (i + limit < items.length) await new Promise(r => setTimeout(r, Config.timing.pushInterval));
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
                    await new Promise(r2 => setTimeout(r2, Config.timing.pushInterval));
                }
            }

            // ⑦ 写缓存：只收录「被过滤的数据」+「推送成功的数据」
            //    推送失败的排除在外 → 下次运行重新推送（避免消息永久丢失）
            const itemsKeys = new Set(items.map(keyOf));
            const toCache = newMessages.filter(m => !itemsKeys.has(keyOf(m)) || pushedKeys.has(keyOf(m)));
            MessageStore.saveBatch(toCache, cacheName);

            // ⑧ 统计
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log('\n══════════ 本次运行 ══════════');
            console.log(`  获取:     ${xbkdata.length} 条`);
            console.log(`  去重跳过:  ${dedupCount} 条`);
            console.log(`  过滤屏蔽:  ${filteredCount} 条`);
            console.log(`  推送:     ${successCount} 条${successCount < items.length ? `（${items.length - successCount} 条失败，下次运行重试）` : ''}`);
            console.log(`  耗时:     ${elapsed}s`);
            console.log('══════════════════════════════');
            await new Promise(r => setTimeout(r, Config.timing.finalWait));

            // 运行摘要持久化到缓存目录 run.log（cron 场景回溯/失败趋势；写失败不影响主流程）
            this._writeRunLog(`${new Date().toISOString()} total=${xbkdata.length} dedup=${dedupCount} filtered=${filteredCount} pushed=${successCount} failed=${items.length - successCount}\n`);

            // 返回运行摘要（供外部/测试观测，cron 可据此判断）
            return {
                total: xbkdata.length,
                dedup: dedupCount,
                filtered: filteredCount,
                pushed: successCount,
                failed: items.length - successCount,
            };

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
            this._writeRunLog(`${new Date().toISOString()} ERROR ${String(errMsg).replace(/[\r\n]+/g, ' ')}\n`);
            throw error; // 重新抛出，让外层/调度感知失败（cron 场景 exit code 非 0）
        }
    },
};

if (require.main === module) {
    App.run().catch(e => {
        console.error('程序运行失败:', e.message);
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