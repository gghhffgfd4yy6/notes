'use strict';

// ============================================================
// App.run 集成测试：mock got + notify，验证主流程完整链路
// 独立文件：因需在 require 前替换 require.cache，不与 test_filter.js 混跑
// ============================================================

// ---------- mock 注入（必须在 require 主模块之前） ----------
require('got'); // 先加载，让 require.cache 有条目
require('./xbk_sendNotify_slim');
const gotPath = require.resolve('got');
const notifyPath = require.resolve('./xbk_sendNotify_slim');

let gotCalls = [];
let fakeData = [];
let failCount = 0;     // 5xx 类失败次数（无 response，会重试）
let fail4xx = false;   // 4xx 失败（带 response，不重试）
let failTimeout = false; // 超时失败（code=ETIMEDOUT，会重试）
let fail429Once = false; // 仅第一次抛 429（限流，应重试）
let failPlainString = false; // 抛普通字符串(非 Error)
let failNonJson = false; // 仅第一次返回非 JSON 响应（.json() 抛错，应重试）

require.cache[gotPath].exports = (url, opts) => {
    gotCalls.push({ url, opts });
    if (failPlainString) { throw 'plain string error'; }
    if (fail429Once) {
        fail429Once = false;
        const e = new Error('Too Many');
        e.response = { statusCode: 429 };
        throw e;
    }
    if (failTimeout) {
        const e = new Error('timeout');
        e.code = 'ETIMEDOUT';
        throw e;
    }
    if (fail4xx) {
        const e = new Error('Not Found');
        e.response = { statusCode: 404 };
        throw e;
    }
    if (failCount > 0) {
        failCount--;
        throw new Error('boom');
    }
    return { json: async () => {
        // 非 JSON 响应（真实 got 的 .json() 会抛 "Response is not JSON" → fetchData 应重试）
        if (failNonJson) { failNonJson = false; throw new Error('Response is not JSON: <html>'); }
        return fakeData;
    } };
};

let pushCalls = [];
let notifyFail = false;
let notifyFailAt = -1; // -1=永不失败，N=第N次调用失败
let notifyCalls = 0;
require.cache[notifyPath].exports = {
    sendNotify: async (text, desp) => {
        notifyCalls++;
        if (notifyFail) throw new Error('push boom');
        if (notifyFailAt > 0 && notifyCalls === notifyFailAt) throw new Error('push boom');
        pushCalls.push({ text, desp });
    },
};

// ---------- require 主模块 ----------
const xbk = require('./xbk_function_v3.js');
const { Config } = xbk;
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'xianbaoku_cache');

// ---------- 工具 ----------
let passed = 0, failed = 0;
const errors = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        errors.push(`${name}: ${e.message}`);
        console.log(`  ❌ ${name}  (${e.message})`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
}

function setPushUrl(suffix) {
    // 覆盖 getter，让每个测试用独立缓存文件，避免 _memoryCache 状态污染
    Object.defineProperty(Config.api, 'pushUrl', {
        value: `https://test.local/plus/json/${suffix}.json`,
        configurable: true, writable: true,
    });
    // 清理该测试可能残留的旧缓存文件（持久化文件会跨进程留存）
    try { fs.unlinkSync(path.join(CACHE_DIR, `${suffix}.json`)); } catch (e) { /* 不存在则忽略 */ }
}

function reset() {
    gotCalls = [];
    pushCalls = [];
    fakeData = [];
    failCount = 0;
    fail4xx = false;
    failTimeout = false;
    fail429Once = false;
    failPlainString = false;
    failNonJson = false;
    notifyFail = false;
    notifyFailAt = -1;
    notifyCalls = 0;
    Config.filter.pingbifenlei = '';
    Config.filter.pingbibiaoti = '';
    Config.filter.pingbilouzhu = '';
    Config.keyword.zkt_gjc = '';
}

function readCacheFile(suffix) {
    const p = path.join(CACHE_DIR, `${suffix}.json`);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeItem(overrides = {}) {
    return {
        id: 1, catename: '微博线报', title: '京东神券 100元',
        content: '限时抢购内容', content_html: '<b>京东神券 100元</b>秒杀',
        url: '/weibo/1.html', ...overrides,
    };
}

console.log('\n========================================');
console.log('  🧪 App.run 集成测试（mock got/notify）');
console.log('========================================\n');

(async () => {

// ==================== 1. 正常主流程 ====================
console.log('📂 1. 正常主流程');
reset();
setPushUrl('t01_normal');

await test('拉取→推送完整链路：新数据全部推送', async () => {
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' }), makeItem({ id: 3, title: '拼多多砍价' })];
    const summary = await xbk.run();
    // run() 返回摘要契约：total/dedup/filtered/pushed/failed
    assert(summary && summary.total === 3 && summary.dedup === 0 && summary.filtered === 0
        && summary.pushed === 3 && summary.failed === 0,
        `摘要错误: ${JSON.stringify(summary)}`);
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}`);
    // text 格式：【分类名】标题
    assert(pushCalls[0].text === '【微博线报】京东神券 100元', `text格式错误: ${pushCalls[0].text}`);
    // desp 为 Markdown 内容（来自 content_html）
    assert(pushCalls[0].desp.includes('原文链接'), 'desp 应含原文链接');
    assert(pushCalls[0].desp.includes('京东神券 100元'), 'desp 应含 content_html 内容');
    // 新数据写入缓存
    const cached = readCacheFile('t01_normal');
    assert(cached.length === 3, `缓存应有3条，实际${cached.length}`);
    // 缓存保持原始顺序（变异 newMessages.unshift 会倒序写入）
    assert(cached[0].id === 1 && cached[1].id === 2 && cached[2].id === 3,
        `缓存顺序错误: ${cached.map(m => m.id).join(',')}`);
});

await test('已有缓存数据 → 去重不推送', async () => {
    reset();
    setPushUrl('t02_dedup');
    // 预置缓存（直接写文件，未经过内存缓存）
    fs.writeFileSync(path.join(CACHE_DIR, 't02_dedup.json'), JSON.stringify([makeItem({ id: 1 })]));
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '新数据' })];
    await xbk.run();
    assert(pushCalls.length === 1, `应只推新数据1条，实际${pushCalls.length}`);
    assert(pushCalls[0].text.includes('新数据'), '推送的应是新数据');
});

await test('空数据 → 不推送不崩溃', async () => {
    reset();
    setPushUrl('t03_empty');
    fakeData = [];
    await xbk.run();
    assert(pushCalls.length === 0, '空数据不应推送');
});

// ==================== 2. 字段归一化 ====================
console.log('\n📂 2. 字段归一化');

await test('category_name 自动映射为 catename（过滤/推送用同一个值）', async () => {
    reset();
    setPushUrl('t04_norm');
    fakeData = [{ id: 1, category_name: '测试分类', category_id: '42', title: '归一化测试', content: '内容', url: '/x/1.html' }];
    await xbk.run();
    assert(pushCalls.length === 1, '应推1条');
    assert(pushCalls[0].text === '【测试分类】归一化测试', `分类未归一化: ${pushCalls[0].text}`);
});

await test('category_id 自动映射为 cateid（{分类ID} 占位符生效）', async () => {
    reset();
    setPushUrl('t45_cateid');
    fakeData = [{ id: 1, category_id: '42', category_name: '测试', title: '分类ID测试', content: 'x', url: '/c/1.html' }];
    await xbk.run();
    assert(pushCalls.length === 1, '应推1条');
    // {分类ID} 只出现在自定义模板里；通过 tuisong_replace 直接验证映射
    const { tuisong_replace } = xbk;
    const r = tuisong_replace('ID:{分类ID}', { category_id: '42' });
    assert(r === 'ID:42', `category_id 应映射为 cateid: ${r}`);
});

// ==================== 3. 批内去重 ====================
console.log('\n📂 3. 批内去重');

await test('同一批数据重复 id → 只收录1条', async () => {
    reset();
    setPushUrl('t05_batch_dup');
    fakeData = [makeItem({ id: 9 }), makeItem({ id: 9, title: '重复项' })];
    await xbk.run();
    assert(pushCalls.length === 1, `同id应只推1条，实际${pushCalls.length}`);
});

await test('同一批重复 url（无id）→ 只收录1条', async () => {
    reset();
    setPushUrl('t06_url_dup');
    fakeData = [
        { url: '/u/1.html', catename: 'a', title: 'A', content: 'c' },
        { url: '/u/1.html', catename: 'a', title: 'A2', content: 'c' },
    ];
    await xbk.run();
    assert(pushCalls.length === 1, `同url应只推1条，实际${pushCalls.length}`);
});

// ==================== 4. 过滤生效 ====================
console.log('\n📂 4. 过滤生效');

await test('标题屏蔽规则 → 命中数据不推送', async () => {
    reset();
    setPushUrl('t07_filter');
    Config.filter.pingbibiaoti = '京东';
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })];
    await xbk.run();
    assert(pushCalls.length === 1, `应只推淘宝1条，实际${pushCalls.length}`);
    assert(pushCalls[0].text.includes('淘宝'), '推送的应是淘宝');
});

await test('分类屏蔽规则 → 命中分类不推送', async () => {
    reset();
    setPushUrl('t08_cat');
    Config.filter.pingbifenlei = '赚客吧';
    fakeData = [makeItem({ id: 1, catename: '赚客吧' }), makeItem({ id: 2, catename: '微博线报' })];
    await xbk.run();
    assert(pushCalls.length === 1, `应只推微博1条，实际${pushCalls.length}`);
});

// ==================== 5. 只看它过滤 ====================
console.log('\n📂 5. 只看它过滤');

await test('zkt_gjc 关键词 → 只推送标题匹配的', async () => {
    reset();
    setPushUrl('t09_kwd');
    Config.keyword.zkt_gjc = '京东';
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })];
    await xbk.run();
    assert(pushCalls.length === 1, `应只推京东1条，实际${pushCalls.length}`);
    assert(pushCalls[0].text.includes('京东'), '推送的应是京东');
});

// ==================== 6. fetchData 重试 ====================
console.log('\n📂 6. fetchData 重试');

await test('5xx 失败一次后重试成功 → 共请求2次', async () => {
    reset();
    setPushUrl('t10_retry');
    failCount = 1; // 第一次失败，第二次成功
    fakeData = [makeItem({ id: 1 })];
    await xbk.run();
    assert(gotCalls.length === 2, `应请求2次，实际${gotCalls.length}`);
    assert(pushCalls.length === 1, '重试成功后应推送');
});

await test('4xx 客户端错误 → 不重试直接失败，不崩溃', async () => {
    reset();
    setPushUrl('t11_4xx');
    fail4xx = true;
    let crashed = false;
    try {
        await xbk.run();
    } catch (e) {
        crashed = true;
    }
    // 修复后 run() 重新抛出，让 cron/调度感知失败
    assert(crashed, '4xx 应抛出异常（不再静默吞错）');
    assert(gotCalls.length === 1, `4xx 不应重试，实际请求${gotCalls.length}次`);
    assert(pushCalls.length === 0, '4xx 不应推送');
});

// ==================== 7. 组合场景 ====================
console.log('\n📂 7. 组合场景');

await test('去重+过滤+只看它 三合一完整链路', async () => {
    reset();
    setPushUrl('t12_combo');
    Config.filter.pingbibiaoti = '屏蔽词';
    Config.keyword.zkt_gjc = '京东';
    fakeData = [
        makeItem({ id: 1, title: '京东神券' }),            // 通过
        makeItem({ id: 2, title: '屏蔽词内容' }),          // 标题屏蔽
        makeItem({ id: 3, title: '淘宝特价' }),            // 只看它过滤
        makeItem({ id: 1, title: '重复京东' }),            // 批内去重
    ];
    await xbk.run();
    assert(pushCalls.length === 1, `应只推1条，实际${pushCalls.length}`);
    assert(pushCalls[0].text.includes('京东神券'), '应推 id=1');
});

// ==================== 7.5 无标识数据去重 ====================
console.log('\n📂 7.5 无标识数据去重');

await test('批内多条无id无url → 全部推送（修复前 "url:undefined" 误判重复）', async () => {
    reset();
    setPushUrl('t16_anon');
    fakeData = [
        { catename: 'a', title: '无标识1', content: 'x' },
        { catename: 'a', title: '无标识2', content: 'y' },
        { catename: 'a', title: '无标识3', content: 'z' },
    ];
    await xbk.run();
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}`);
});

await test('批内无id同url重复 → 只推1条（url fallback 生效）', async () => {
    reset();
    setPushUrl('t17_urlfb');
    fakeData = [
        { url: '/u/1.html', catename: 'a', title: 'A', content: 'x' },
        { url: '/u/1.html', catename: 'a', title: 'A2', content: 'y' },
        { url: '/u/2.html', catename: 'a', title: 'B', content: 'z' },
    ];
    await xbk.run();
    assert(pushCalls.length === 2, `应推2条(A+B)，实际${pushCalls.length}`);
});

// ==================== 7.6 keyword 非法正则 ====================
console.log('\n📂 7.6 keyword 非法正则');

await test('zkt_gjc 非法正则 → 警告并不过滤，继续推送（v3.16审查2.1）', async () => {
    reset();
    setPushUrl('t18_badkw');
    Config.keyword.zkt_gjc = '['; // 未闭合字符类 = 非法正则
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' })];
    let crashed = false;
    try { await xbk.run(); } catch (e) { crashed = true; }
    assert(!crashed, '不应崩溃');
    // 非法正则时 items 不过滤，全部推送
    assert(pushCalls.length === 2, `应推2条，实际${pushCalls.length}`);
});

await test('zkt_gjc 合法正则 → 正常过滤（行为不受影响）', async () => {
    reset();
    setPushUrl('t19_okkw');
    Config.keyword.zkt_gjc = '京东';
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })];
    await xbk.run();
    assert(pushCalls.length === 1, `应只推京东1条，实际${pushCalls.length}`);
});

await test('推送部分失败 → 只缓存推送成功的（v3.18审查Bug1）', async () => {
    reset();
    setPushUrl('t20_partial');
    notifyFailAt = 2; // 第2次推送失败
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '失败这条' }), makeItem({ id: 3, title: '过滤掉' })];
    Config.filter.pingbibiaoti = '过滤掉';
    const summary = await xbk.run();
    // 摘要应正确区分：3 获取、1 过滤、1 成功、1 失败
    assert(summary && summary.total === 3 && summary.dedup === 0 && summary.filtered === 1
        && summary.pushed === 1 && summary.failed === 1,
        `摘要错误: ${JSON.stringify(summary)}`);
    assert(pushCalls.length === 1, `应成功推1条，实际${pushCalls.length}`);
    // 缓存: 成功推送的 id=1 + 被过滤的 id=3（id=2 失败不缓存）
    const cached = readCacheFile('t20_partial');
    const ids = cached.map(m => m.id).sort();
    assert(ids.join(',') === '1,3', `缓存应为[1,3]，实际[${ids}]`);
});

await test('匿名数据（无id无url）跨运行去重（v3.18审查Bug2：合成id）', async () => {
    reset();
    setPushUrl('t21_anon_rerun');
    fakeData = [{ title: '匿名甲', content: '内容A', catename: 'a' }];
    await xbk.run();
    assert(pushCalls.length === 1, '第一次运行应推送');
    // 第二次运行相同数据（title+content 相同 → 合成 id 相同 → 去重）
    reset();
    setPushUrl('t21_anon_rerun');
    fakeData = [{ title: '匿名甲', content: '内容A', catename: 'a' }];
    await xbk.run();
    assert(pushCalls.length === 0, '第二次运行相同匿名数据应去重');
    // 不同内容 → 不判重
    reset();
    setPushUrl('t21_anon_rerun');
    fakeData = [{ title: '匿名甲', content: '内容B', catename: 'a' }];
    await xbk.run();
    assert(pushCalls.length === 1, '内容不同应重新推送');
});

// ==================== 7.7 v3.18 第二轮审查修复 ====================
console.log('\n📂 7.7 v3.18 第二轮审查修复');

await test('接口返回非数组 → 抛异常且错误信息友好（v3.18二轮审查问题3）', async () => {
    for (const bad of [null, {}, { code: 500 }, 'oops']) {
        reset();
        setPushUrl('t22_bad' + String(Math.random()).slice(2, 8));
        fakeData = bad;
        let crashed = false;
        let msg = '';
        try { await xbk.run(); } catch (e) { crashed = true; msg = e.message || ''; }
        assert(crashed, `返回 ${JSON.stringify(bad).slice(0, 20)} 应抛出异常`);
        // 无校验时 for...of 也会抛错但信息晦涩（如 "is not iterable"），校验应给出友好提示
        assert(msg.includes('格式异常'), `错误信息应友好，实际: ${msg.slice(0, 60)}`);
    }
});

await test('匿名数据同title+content但不同时间 → 不误合并（v3.18二轮审查问题2）', async () => {
    reset();
    setPushUrl('t23_anon_time');
    fakeData = [
        { title: '活动', content: '详情', posttime: 1785346200, catename: 'a' },
        { title: '活动', content: '详情', posttime: 1785432600, catename: 'a' },
    ];
    await xbk.run();
    assert(pushCalls.length === 2, `不同posttime应推2条，实际${pushCalls.length}`);
});

await test('匿名数据同title+content+posttime → 合并去重', async () => {
    reset();
    setPushUrl('t24_anon_same');
    fakeData = [
        { title: '活动', content: '详情', posttime: 1785346200, catename: 'a' },
        { title: '活动', content: '详情', posttime: 1785346200, catename: 'a' },
    ];
    await xbk.run();
    assert(pushCalls.length === 1, `完全相同应推1条，实际${pushCalls.length}`);
});

// ==================== 7.8 v3.20 审查修复 ====================
console.log('\n📂 7.8 v3.20 审查修复');

await test('有id无url → 推送链接不含undefined（v3.20审查1）', async () => {
    reset();
    setPushUrl('t25_nourl');
    fakeData = [{ id: 1, catename: 'a', title: '无链接数据', content: 'x' }]; // 无 url
    await xbk.run();
    assert(pushCalls.length === 1, '应推送');
    assert(!pushCalls[0].text.includes('undefined'), `链接不应含undefined: ${pushCalls[0].text.slice(0, 80)}`);
    assert(!pushCalls[0].desp.includes('undefined'), 'desp 不应含 undefined');
});

await test('数组含非对象元素 → 跳过不崩溃（v3.20审查3）', async () => {
    reset();
    setPushUrl('t26_badelem');
    fakeData = [
        null,
        'oops',
        123,
        { id: 1, catename: 'a', title: '正常数据', content: 'x', url: '/n/1.html' },
    ];
    let crashed = false;
    try { await xbk.run(); } catch (e) { crashed = true; }
    assert(!crashed, '非对象元素不应导致崩溃');
    assert(pushCalls.length === 1, `应只推正常数据1条，实际${pushCalls.length}`);
});

await test('id为null的两条不同记录 → 不误合并（v3.20审查2）', async () => {
    reset();
    setPushUrl('t27_nullid');
    fakeData = [
        { id: null, catename: 'a', title: '甲', content: 'x', url: '/u/1.html' },
        { id: null, catename: 'a', title: '乙', content: 'y', url: '/u/2.html' },
    ];
    await xbk.run();
    assert(pushCalls.length === 2, `不同url应推2条，实际${pushCalls.length}`);
});

// ==================== 7.9 v3.22 审查修复 ====================
console.log('\n📂 7.9 v3.22 审查修复');

await test('绝对URL不拼前缀（v3.22审查19）', async () => {
    reset();
    setPushUrl('t28_absurl');
    fakeData = [
        makeItem({ id: 1, url: 'https://other.com/path/1.html' }),
        makeItem({ id: 2, url: '/relative/2.html' }),
    ];
    await xbk.run();
    assert(pushCalls.length === 2, '应推2条');
    // URL 在 desp(Markdown 原文链接)里：绝对 URL 原样，相对 URL 拼 domain
    assert(pushCalls[0].desp.includes('https://other.com/path/1.html'), `绝对URL不应拼前缀: ${pushCalls[0].desp.slice(0, 80)}`);
    assert(!pushCalls[0].desp.includes('new.ixbk.nethttps://'), '不应双重前缀');
    assert(pushCalls[1].desp.includes('https://new.ixbk.net/relative/2.html'), '相对URL应拼前缀');
});

// ==================== 7.10 审查2轮: 空白url与url形态 ====================
console.log('\n📂 7.10 审查2轮: 空白url与url形态');

await test('无id+空白url多条 → 全推不丢失（审查2 BugA）', async () => {
    reset();
    setPushUrl('t29_blankurl');
    fakeData = [
        { catename: 'a', title: '空白甲', content: 'x', url: ' ' },
        { catename: 'a', title: '空白乙', content: 'y', url: ' ' },
        { catename: 'a', title: '空白丙', content: 'z', url: ' ' },
    ];
    await xbk.run();
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}（修复前丢失2条）`);
});

await test('同资源不同url形态批内 → 判重推1条（审查2 BugB）', async () => {
    reset();
    setPushUrl('t30_urlshape');
    fakeData = [
        { catename: 'a', title: '形态甲', content: 'x', url: '/dup/1.html' },
        { catename: 'a', title: '形态乙', content: 'x', url: 'dup/1.html/' },
    ];
    await xbk.run();
    assert(pushCalls.length === 1, `应推1条，实际${pushCalls.length}（修复前重复推送）`);
});

// ==================== 7.11 审查3轮: 协议与空白关键词 ====================
console.log('\n📂 7.11 审查3轮: 协议与空白关键词');

await test('ftp协议URL不拼前缀（审查3 A）', async () => {
    reset();
    setPushUrl('t31_ftp');
    fakeData = [makeItem({ id: 1, url: 'ftp://files.x.com/a.zip' })];
    await xbk.run();
    assert(pushCalls.length === 1, '应推送');
    assert(pushCalls[0].desp.includes('ftp://files.x.com/a.zip'), 'ftp URL 不应拼前缀');
    assert(!pushCalls[0].desp.includes('new.ixbk.netftp'), '不应拼坏');
});

await test('空白关键词 → 忽略过滤全推（审查3 C）', async () => {
    reset();
    setPushUrl('t32_blankkw');
    Config.keyword.zkt_gjc = ' '; // 空白关键词(合法正则但误配)
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })];
    await xbk.run();
    assert(pushCalls.length === 2, `空白关键词应忽略过滤全推，实际${pushCalls.length}`);
});

// ==================== 7.12 审查4轮: 429与数组元素 ====================
console.log('\n📂 7.12 审查4轮: 429与数组元素');

await test('429限流 → 重试不直接抛（审查4-1）', async () => {
    reset();
    setPushUrl('t33_429');
    fail429Once = true; // 第一次抛 429，第二次成功
    fakeData = [makeItem({ id: 1 })];
    await xbk.run();
    assert(gotCalls.length === 2, `429 应重试，实际请求${gotCalls.length}次`);
    assert(pushCalls.length === 1, '重试成功后应推送');
});

await test('非 JSON 响应 → .json() 抛错重试成功（真实 got 行为）', async () => {
    reset();
    setPushUrl('t46_nonjson');
    failNonJson = true; // 第一次返回非 JSON，第二次成功
    fakeData = [makeItem({ id: 1 })];
    await xbk.run();
    assert(gotCalls.length === 2, `非 JSON 应重试，实际请求${gotCalls.length}次`);
    assert(pushCalls.length === 1, '重试成功后应推送');
});

await test('数组元素嵌套 → 跳过不推送（审查4-3）', async () => {
    reset();
    setPushUrl('t34_arrel');
    fakeData = [
        [1, 2], // 数组元素(嵌套)
        { id: 1, catename: 'a', title: '正常', content: 'x', url: '/n/1.html' },
    ];
    await xbk.run();
    assert(pushCalls.length === 1, `数组元素应被跳过，只推正常1条，实际${pushCalls.length}`);
});

// ==================== 7.13 审查9轮: 空标题/非Error异常 ====================
console.log('\n📂 7.13 审查9轮: 空标题/非Error异常');

await test('空标题推送 → (无标题) 占位（审查9-C）', async () => {
    reset();
    setPushUrl('t35_notitle');
    fakeData = [{ id: 1, catename: 'a', title: '', content: 'x', url: '/n/1.html' }];
    await xbk.run();
    assert(pushCalls.length === 1, '应推送');
    assert(pushCalls[0].text.includes('(无标题)'), '空标题应占位');
});

await test('接口抛非Error(字符串) → 不崩溃（审查9-D）', async () => {
    reset();
    setPushUrl('t36_strerr');
    failPlainString = true; // 每次请求抛普通字符串(非 Error)
    let crashed = false;
    try { await xbk.run(); } catch (e) { crashed = true; }
    assert(crashed, '非 Error 异常应被捕获并重抛');
});

// ==================== 7.14 审查10轮: 空标题保留/URL拼接 ====================
console.log('\n📂 7.14 审查10轮: 空标题保留/URL拼接');

await test('只看它过滤保留空标题（审查10 #181）', async () => {
    reset();
    setPushUrl('t37_kwt');
    Config.keyword.zkt_gjc = '京东';
    fakeData = [
        { id: 1, catename: 'a', title: '', content: 'x', url: '/n/1.html' },   // 空标题应保留
        { id: 2, catename: 'a', title: '京东神券', content: 'y', url: '/n/2.html' },
        { id: 3, catename: 'a', title: '淘宝特价', content: 'z', url: '/n/3.html' }, // 关键词不匹配滤掉
    ];
    await xbk.run();
    assert(pushCalls.length === 2, `空标题+京东应推2条，实际${pushCalls.length}`);
});

await test('相对URL拼接无双斜杠（审查10 #268）', async () => {
    reset();
    setPushUrl('t38_urljoin');
    fakeData = [
        makeItem({ id: 1, url: 'rel/no-slash.html' }),     // 无前导 /
        makeItem({ id: 2, url: '/with/slash.html' }),      // 有前导 /
    ];
    await xbk.run();
    assert(pushCalls.length === 2);
    assert(pushCalls[0].desp.includes('https://new.ixbk.net/rel/no-slash.html'), `相对无斜杠应补斜杠: ${pushCalls[0].desp.slice(0,80)}`);
    assert(!pushCalls[0].desp.includes('//rel/'), '不应双斜杠');
    assert(pushCalls[1].desp.includes('https://new.ixbk.net/with/slash.html'), '有斜杠正常');
});

// ==================== 7.15 审查10轮批量: 推送截断 ====================
console.log('\n📂 7.15 审查10轮批量: 推送截断');

await test('超长标题截断（审查10 #270）', async () => {
    reset();
    setPushUrl('t39_trunc');
    fakeData = [makeItem({ id: 1, title: '超'.repeat(500), content: '内容'.repeat(5000), url: '/n/1.html' })];
    await xbk.run();
    assert(pushCalls.length === 1, '应推送');
    // 标题截断到 100，内容截断到 3000
    assert(pushCalls[0].text.length <= 150, `标题应截断: ${pushCalls[0].text.length}`);
    assert(pushCalls[0].desp.length <= 3200, `内容应截断: ${pushCalls[0].desp.length}`);
});

// ==================== 7.16 审查10轮: UA请求头 ====================
console.log('\n📂 7.16 审查10轮: UA请求头');

await test('fetchData 带 User-Agent/Accept 请求头（#165/166）', async () => {
    reset();
    setPushUrl('t40_ua');
    fakeData = [makeItem({ id: 1 })];
    // 顶部 mock 已记录 gotCalls，检查 headers
    await xbk.run();
    assert(gotCalls.length >= 1, '应发请求');
    const headers = gotCalls[0].opts && gotCalls[0].opts.headers;
    assert(headers && headers['User-Agent'], '应带 User-Agent');
    assert(headers && headers['Accept'] === 'application/json', '应带 Accept');
});

// ==================== 7.17 并行推送模式 ====================
console.log('\n📂 7.17 并行推送模式');

let pushSeq = 0;

async function runWithPushMode(mode, limit, data, sendFn) {
    reset();
    // 每个测试唯一缓存文件名，避免 _memoryCache 进程内缓存导致跨测试误判
    setPushUrl('tpush_' + mode + (limit || 0) + '_' + (pushSeq++) + '.json');
    Config.push.mode = mode;
    Config.push.parallelLimit = limit || 0;
    fakeData = data;
    notifyFail = false;
    notifyFailAt = -1;
    if (sendFn) {
        require.cache[notifyPath].exports = { sendNotify: sendFn };
    }
    const summary = await xbk.run();
    const cacheName = 'tpush_' + mode + (limit || 0) + '_' + (pushSeq - 1) + '.json';
    const res = { pushed: pushCalls.length, cached: readCacheFile(cacheName).length, summary };
    // 恢复默认
    Config.push.mode = 'sequential';
    Config.push.parallelLimit = 0;
    require.cache[notifyPath].exports = {
        sendNotify: async (text, desp) => {
            notifyCalls++;
            if (notifyFail) throw new Error('push boom');
            if (notifyFailAt > 0 && notifyCalls === notifyFailAt) throw new Error('push boom');
            pushCalls.push({ text, desp });
        },
    };
    return res;
}

await test('parallel 模式: 多条全部推送+缓存（并行模式）', async () => {
    const data = [1, 2, 3, 4, 5].map(i => ({ id: i, catename: 'a', title: '并行' + i, content: 'x', url: '/p/' + i + '.html' }));
    const r = await runWithPushMode('parallel', 0, data);
    assert(r.pushed === 5, `应推5条，实际${r.pushed}`);
    assert(r.cached === 5, `缓存应5条，实际${r.cached}`);
});

await test('parallelLimit=2: 分批限并发推送', async () => {
    const data = [1, 2, 3, 4].map(i => ({ id: i, catename: 'a', title: '批' + i, content: 'x', url: '/q/' + i + '.html' }));
    const r = await runWithPushMode('parallel', 2, data);
    assert(r.pushed === 4, `应推4条，实际${r.pushed}`);
    assert(r.cached === 4, `缓存应4条，实际${r.cached}`);
});

await test('parallelLimit=2.5(小数) → 取整为2，正常推送无空批', async () => {
    const data = [1, 2, 3, 4, 5].map(i => ({ id: i, catename: 'a', title: '小' + i, content: 'x', url: '/m/' + i + '.html' }));
    const r = await runWithPushMode('parallel', 2.5, data);
    assert(r.pushed === 5, `应推5条，实际${r.pushed}`);
    assert(r.cached === 5, `缓存应5条，实际${r.cached}`);
    assert(r.summary && r.summary.pushed === 5 && r.summary.failed === 0, `摘要正确: ${JSON.stringify(r.summary)}`);
});

await test('push.mode 非法值 → 警告并按顺序模式推送（防静默降级）', async () => {
    reset();
    setPushUrl('t47_badmode');
    Config.push.mode = 'PARALLEL'; // 大写（拼写误配）
    fakeData = [1, 2].map(i => ({ id: i, catename: 'a', title: '模式' + i, content: 'x', url: '/b/' + i + '.html' }));
    await xbk.run();
    assert(pushCalls.length === 2, `非法 mode 应按顺序推送全部，实际${pushCalls.length}`);
    assert(Config.push.mode === 'PARALLEL', '不应修改用户配置');
    // 恢复
    Config.push.mode = 'sequential';
});

await test('parallel 模式部分失败 → 只缓存成功的', async () => {
    reset();
    setPushUrl('tpar_fail.json');
    Config.push.mode = 'parallel';
    notifyFailAt = 2; // 第2条推送失败
    fakeData = [1, 2, 3].map(i => ({ id: i, catename: 'a', title: '半' + i, content: 'x', url: '/r/' + i + '.html' }));
    await xbk.run();
    assert(pushCalls.length === 2, `应成功推2条，实际${pushCalls.length}`);
    const cached = readCacheFile('tpar_fail.json');
    assert(cached.length === 2, `应只缓存成功2条，实际${cached.length}`);
    Config.push.mode = 'sequential';
});

await test('parallel 与 sequential 推送结果一致', async () => {
    const data = [1, 2, 3, 4].map(i => ({ id: i, catename: 'a', title: '对' + i, content: 'x', url: '/s/' + i + '.html' }));
    const pa = await runWithPushMode('parallel', 0, data);
    const se = await runWithPushMode('sequential', 0, data);
    assert(pa.pushed === se.pushed, `推送数应一致: ${pa.pushed} vs ${se.pushed}`);
    assert(pa.cached === se.cached, `缓存应一致: ${pa.cached} vs ${se.cached}`);
    // 两种模式的 run() 返回摘要应完全一致（顺序模式统计曾恒错）
    assert(JSON.stringify(pa.summary) === JSON.stringify(se.summary),
        `summary 应一致: ${JSON.stringify(pa.summary)} vs ${JSON.stringify(se.summary)}`);
    assert(pa.summary && pa.summary.total === 4 && pa.summary.pushed === 4 && pa.summary.failed === 0,
        `摘要应正确: ${JSON.stringify(pa.summary)}`);
});

// ==================== 8. 错误分支 ====================
console.log('\n📂 8. 错误分支');

await test('重试耗尽（持续5xx）→ 抛错但 run 不崩溃', async () => {
    reset();
    setPushUrl('t13_exhaust');
    failCount = 99; // 一直失败，直到重试次数耗尽
    let crashed = false;
    try {
        await xbk.run();
    } catch (e) {
        crashed = true;
    }
    // 修复后 run() 重新抛出（不再静默吞错）
    assert(crashed, '重试耗尽应抛出异常');
    // retry=2 → 最多请求 3 次后放弃
    assert(gotCalls.length === 3, `应请求3次后放弃，实际${gotCalls.length}`);
    assert(pushCalls.length === 0, '失败不应推送');
});

await test('推送失败 → 被捕获不崩溃，且不写缓存（v3.18审查Bug1：下次可重试）', async () => {
    reset();
    setPushUrl('t14_push_fail');
    notifyFail = true;
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '第二条' })];
    let crashed = false;
    try {
        await xbk.run();
    } catch (e) {
        crashed = true;
    }
    assert(!crashed, '推送失败不应导致未捕获异常');
    // 推送失败的消息不应写入缓存 → 下次运行会重新推送（避免永久丢失）
    const cached = readCacheFile('t14_push_fail');
    assert(cached.length === 0, `推送失败不应写缓存，实际${cached.length}条`);
});

await test('ETIMEDOUT → 重试后仍失败，run 走超时分支不崩溃', async () => {
    reset();
    setPushUrl('t15_timeout');
    failTimeout = true; // 每次请求都超时（无 response 的错误会触发重试）
    let crashed = false;
    try {
        await xbk.run();
    } catch (e) {
        crashed = true;
    }
    // 修复后 run() 重新抛出（不再静默吞错）
    assert(crashed, 'ETIMEDOUT 应抛出异常');
    // retry=2 → 3 次请求后放弃（重试耗时较长，此处只验证次数）
    assert(gotCalls.length === 3, `应请求3次，实际${gotCalls.length}`);
});

// ==================== 7.18 ReDoS 防护（审查10轮 #240） ====================
console.log('\n📂 7.18 ReDoS 防护');

await test('zkt_gjc 嵌套量词正则 → 警告并忽略过滤，不卡死（#240）', async () => {
    reset();
    setPushUrl('t41_redos');
    Config.keyword.zkt_gjc = '(a+)+$'; // 灾难性回溯正则
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝特价' })];
    let crashed = false;
    const t0 = Date.now();
    try { await xbk.run(); } catch (e) { crashed = true; }
    assert(!crashed, '不应崩溃');
    assert(Date.now() - t0 < 3000, '不应被灾难性回溯卡死');
    // 风险关键词被忽略 → 不过滤，全部推送
    assert(pushCalls.length === 2, `应推2条(忽略风险过滤)，实际${pushCalls.length}`);
});

await test('filter 配置嵌套量词正则 → 规则跳过不卡死（#240）', async () => {
    reset();
    setPushUrl('t42_redos2');
    Config.filter.pingbibiaoti = '(a+)+$';
    fakeData = [makeItem({ id: 1, title: 'a'.repeat(5000) }), makeItem({ id: 2, title: '正常' })];
    let crashed = false;
    const t0 = Date.now();
    try { await xbk.run(); } catch (e) { crashed = true; }
    assert(!crashed, '不应崩溃');
    assert(Date.now() - t0 < 3000, '不应卡死');
    assert(pushCalls.length === 2, '风险屏蔽规则被跳过 → 全部推送');
});

// ==================== 7.19 url 类型防御 ====================
console.log('\n📂 7.19 url 类型防御');

await test('对象 url 脏数据 → 不崩溃，正常数据照常推送（urlOf 防御）', async () => {
    reset();
    setPushUrl('t43_objurl');
    fakeData = [
        makeItem({ id: 1, url: '/n/1.html' }),
        { id: 2, catename: 'a', title: '对象url', content: 'y', url: { a: 1 } },
        { id: 3, catename: 'a', title: 'null url', content: 'z', url: null },
    ];
    let crashed = false;
    try { await xbk.run(); } catch (e) { crashed = true; }
    assert(!crashed, '对象/空 url 不应导致崩溃');
    assert(pushCalls.length === 3, `应推3条，实际${pushCalls.length}`);
    // 正常数据链接完整；对象/空 url 无 undefined / [object Object]
    assert(pushCalls[0].desp.includes('https://new.ixbk.net/n/1.html'), '正常数据链接应完整');
    assert(!pushCalls[1].desp.includes('undefined') && !pushCalls[1].desp.includes('[object Object]'),
        '脏数据不应含垃圾文本');
});

await test('协议相对 // 开头 URL 不拼前缀（urlOf）', async () => {
    reset();
    setPushUrl('t44_protorel');
    fakeData = [makeItem({ id: 1, url: '//cdn.x.com/a.jpg' })];
    await xbk.run();
    assert(pushCalls.length === 1, '应推送');
    assert(pushCalls[0].desp.includes('//cdn.x.com/a.jpg'), '协议相对 URL 不应拼前缀');
    assert(!pushCalls[0].desp.includes('new.ixbk.net//'), '不应拼坏');
});

await test('运行时配置校验：非法数值配置警告、合法不警告（v3.64）', async () => {
    reset();
    setPushUrl('t45_cfgcheck');
    fakeData = [makeItem({ id: 1 })];
    const orig = {
        timeout: Config.api.timeout, retry: Config.api.retry,
        pushInterval: Config.timing.pushInterval, finalWait: Config.timing.finalWait,
        parallelLimit: Config.push.parallelLimit,
    };
    let warns = [];
    const origWarn = console.warn;
    console.warn = (m) => warns.push(String(m));
    try {
        Config.api.timeout = -1;
        Config.api.retry = 2.5;
        Config.timing.pushInterval = 'abc';
        Config.timing.finalWait = -5;
        Config.push.parallelLimit = -1;
        await xbk.run();
        assert(warns.some(w => w.includes('api.timeout')), 'timeout 应警告');
        assert(warns.some(w => w.includes('api.retry')), 'retry 应警告');
        assert(warns.some(w => w.includes('pushInterval')), 'pushInterval 应警告');
        assert(warns.some(w => w.includes('finalWait')), 'finalWait 应警告');
        assert(warns.some(w => w.includes('parallelLimit')), 'parallelLimit 应警告');
    } finally {
        Config.api.timeout = orig.timeout;
        Config.api.retry = orig.retry;
        Config.timing.pushInterval = orig.pushInterval;
        Config.timing.finalWait = orig.finalWait;
        Config.push.parallelLimit = orig.parallelLimit;
        console.warn = origWarn;
    }
    // 合法值不警告
    warns = [];
    console.warn = (m) => warns.push(String(m));
    try {
        await xbk.run();
        assert(!warns.some(w => w.includes('⚠️ 配置「')), '合法配置不应有运行时配置警告');
    } finally {
        console.warn = origWarn;
    }
});

await test('运行摘要持久化到 run.log（v3.65）', async () => {
    reset();
    setPushUrl('t46_runlog');
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '第二条' })];
    await xbk.run();
    const logPath = path.join(CACHE_DIR, 'run.log');
    assert(fs.existsSync(logPath), 'run.log 应已创建');
    const content = fs.readFileSync(logPath, 'utf8');
    const lastLine = content.trim().split('\n').pop();
    assert(/total=\d+ dedup=\d+ filtered=\d+ pushed=\d+ failed=\d+/.test(lastLine),
        `日志行应含完整摘要字段，实际: ${lastLine}`);
    assert(lastLine.includes('pushed=2'), `应记录推送 2 条，实际: ${lastLine}`);
    // 测试产生的日志行不污染真实运行日志（测试专用，删掉）
    try { fs.unlinkSync(logPath); } catch (e) { /* 忽略 */ }
});

await test('运行失败也写 ERROR 日志（v3.66）', async () => {
    reset();
    setPushUrl('t47_runlog_fail');
    fakeData = [];
    // 清掉可能残留的 run.log，确保断言的是本测试写入的行
    try { fs.unlinkSync(path.join(CACHE_DIR, 'run.log')); } catch (e) { /* 忽略 */ }
    fail4xx = true; // 404 不重试 → run 直接抛错（走 catch 分支）
    let threw = false;
    try { await xbk.run(); } catch (e) { threw = true; }
    assert(threw, '4xx 应使 run 抛错');
    const logPath = path.join(CACHE_DIR, 'run.log');
    assert(fs.existsSync(logPath), 'run.log 应已创建');
    const lastLine = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop();
    assert(lastLine.includes('ERROR'), `应记录 ERROR 行，实际: ${lastLine}`);
    try { fs.unlinkSync(logPath); } catch (e) { /* 忽略 */ }
});

await test('推送模板可配置 + 非法回退默认（v3.68）', async () => {
    reset();
    setPushUrl('t48_template');
    fakeData = [makeItem({ id: 1, title: '模板测试', content: '正文', posttime: Math.floor(Date.now() / 1000) })];
    const origTitle = Config.template.title;
    const origContent = Config.template.content;
    try {
        Config.template.title = '【{分类名}】{标题} | {日期} {时间}';
        Config.template.content = '{标题}\n{链接}\n{Markdown内容}';
        await xbk.run();
        assert(pushCalls.length === 1, '应推送 1 条');
        assert(pushCalls[0].text.includes(' | '), '标题模板应含自定义分隔符');
        assert(!pushCalls[0].text.includes('{日期}') && !pushCalls[0].text.includes('{时间}'),
            `日期/时间占位符应被替换，实际: ${pushCalls[0].text}`);
        assert(pushCalls[0].desp.includes('模板测试'), '内容模板应含 {标题}');
        assert(pushCalls[0].desp.includes('原文链接'), '内容模板应含 {Markdown内容} 全文');
    } finally {
        Config.template.title = origTitle;
        Config.template.content = origContent;
    }
    // 非法模板（undefined/非字符串）→ 回退默认，不影响推送
    reset();
    setPushUrl('t48b_template_fallback');
    fakeData = [makeItem({ id: 2, title: '回退测试' })];
    try {
        Config.template.title = undefined;
        Config.template.content = 123;
        await xbk.run();
        assert(pushCalls.length === 1, '回退默认仍应推送');
        assert(pushCalls[0].text.startsWith('【'), '非法模板应回退默认标题格式');
        assert(pushCalls[0].desp.includes('原文链接'), '非法模板应回退默认内容格式');
    } finally {
        Config.template.title = origTitle;
        Config.template.content = origContent;
    }
});

// ================================================
console.log('\n========================================');
if (failed === 0) {
    console.log(`  🎉 集成测试全部通过！${passed}/${passed}`);
} else {
    console.log(`  ⚠️   ${passed} 通过, ${failed} 失败`);
    errors.forEach(e => console.log(`    ${e}`));
}
console.log('========================================\n');

// 清理本套件产生的缓存测试文件（t\d{2}_/tpush_/tpar_fail，保留真实运行缓存 push.json）
try {
    const fs = require('fs');
    const dir = path.join(__dirname, 'xianbaoku_cache');
    if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
            if (/^t\d{2}_|^tpush_|^tpar_fail/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 忽略 */ } }
        }
    }
} catch (e) { /* 忽略 */ }

process.exit(failed > 0 ? 1 : 0);
})();
