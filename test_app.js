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
let notifyFailString = false; // 抛非 Error(字符串)——R1：验证 pushOne catch 兜底
let notifyDelayMs = 0;   // sendNotify 响应延迟（v3.164 #10：模拟真实网络，验证告警 await 后 exit）
let notifyCalls = 0;
require.cache[notifyPath].exports = {
    sendNotify: async (text, desp) => {
        notifyCalls++;
        if (notifyDelayMs > 0) await new Promise(r => setTimeout(r, notifyDelayMs));
        if (notifyFailString) throw 'push boom string'; // 字符串异常（非 Error）
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

// v3.122：支持 --only=子串（并行调度用：只跑匹配测试，其余跳过不计失败）
// 支持环境变量 QUICK=1（快测模式：pushInterval/finalWait 置 0，加速非 timing 测试）
const onlyFilter = (() => {
    const idx = process.argv.indexOf('--only');
    return idx >= 0 ? process.argv[idx + 1] : null;
})();
if (process.env.QUICK === '1') {
    Config.timing.pushInterval = 0;
    Config.timing.finalWait = 0;
}

async function test(name, fn) {
    if (onlyFilter && !name.includes(onlyFilter)) { passed++; return; } // 跳过（并行调度用）
    const t0 = Date.now(); // v3.122：耗时统计（识别慢测试供并行调度）
    try {
        await fn();
        passed++;
        const ms = Date.now() - t0;
        console.log(`  ✅ ${name}${ms > 100 ? `  (${(ms / 1000).toFixed(1)}s)` : ''}`);
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
    notifyDelayMs = 0;
    notifyFail = false;
    notifyFailAt = -1;
    notifyFailString = false;
    notifyCalls = 0;
    Config.filter.pingbifenlei = '';
    Config.filter.pingbibiaoti = '';
    Config.filter.pingbilouzhu = '';
    Config.keyword.zkt_gjc = '';
    // v3.91：reset 同时恢复运行配置默认值（防未来测试忘恢复导致跨测试污染）
    Config.template.title = '【{分类名}】{标题}';
    Config.template.content = '{Markdown内容}';
    Config.push.mode = 'sequential';
    Config.push.titleMax = 100;
    Config.push.contentMax = 3000;
    Config.domain = 'https://new.ixbk.net';
    Config.cache.maxSize = 10000;
    Config.cache.dir = 'xianbaoku_cache';
    // R3-1：api 配置也恢复默认（t51 等会改 api.retry/timeout，漏恢复会污染后续测试）
    Config.api.timeout = 5000;
    Config.api.retry = 2;
    // v3.140：告警/日报默认关闭——预期失败测试(4xx/超时)触发告警、跨天时成功 run 触发日报，
    // 都会污染 pushCalls 断言（t56/t57 显式开启）
    Config.alert.enabled = false;
    Config.report.enabled = false;
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
    assert(pushCalls[0].desp.includes('**京东神券 100元**'), 'desp 应含 Markdown 粗体转换结果（v3.90 锁定 htmlToMarkdown 真实链路）');
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
    assert(headers && /^xbk-push-script\/\d+\.\d+\.\d+$/.test(headers['User-Agent']),
        `UA 应含 semver 版本号: ${headers['User-Agent']}`);
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
        parallelLimit: Config.push.parallelLimit, domain: Config.domain,
        templateTitle: Config.template.title,
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
        Config.domain = '非法域名';
        Config.template.title = 123;
        await xbk.run();
        assert(warns.some(w => w.includes('api.timeout')), 'timeout 应警告');
        assert(warns.some(w => w.includes('api.retry')), 'retry 应警告');
        assert(warns.some(w => w.includes('pushInterval')), 'pushInterval 应警告');
        assert(warns.some(w => w.includes('finalWait')), 'finalWait 应警告');
        assert(warns.some(w => w.includes('parallelLimit')), 'parallelLimit 应警告');
        assert(warns.some(w => w.includes('domain')), '非法 domain 应警告');
        assert(warns.some(w => w.includes('template')), '非法 template 应警告');
    } finally {
        Config.api.timeout = orig.timeout;
        Config.api.retry = orig.retry;
        Config.timing.pushInterval = orig.pushInterval;
        Config.timing.finalWait = orig.finalWait;
        Config.push.parallelLimit = orig.parallelLimit;
        Config.domain = orig.domain;
        Config.template.title = orig.templateTitle;
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
    assert(/total=\d+ dedup=\d+ filtered=\d+ truncated=\d+ pushed=\d+ failed=\d+ elapsed=[\d.]+s/.test(lastLine),
        `日志行应含完整摘要字段（含 elapsed/truncated），实际: ${lastLine}`);
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

await test('长 desp 截断保留原文链接（v3.152）', async () => {
    reset();
    setPushUrl('t61_linkkeep');
    // 超长 content_html → desp 超 contentMax → 截断后原文链接应保留
    fakeData = [makeItem({ id: 1, content_html: '<p>' + '很长内容'.repeat(2000) + '</p>' })];
    await xbk.run();
    assert(pushCalls.length === 1, '应推送');
    const d = pushCalls[0].desp;
    assert(d.length <= Config.push.contentMax, `desp 应 ≤ contentMax: ${d.length}`);
    assert(d.includes('原文链接'), `截断后原文链接应保留: 尾部 ${JSON.stringify(d.slice(-30))}`);
});

await test('推送截断长度可配置 + 非法回退默认（v3.69）', async () => {
    reset();
    setPushUrl('t49_trunc');
    fakeData = [makeItem({ id: 1, title: '这是一个非常长的标题用于测试截断', content: '内容内容内容内容内容内容' })];
    const origTitleMax = Config.push.titleMax;
    const origContentMax = Config.push.contentMax;
    try {
        Config.push.titleMax = 5;
        Config.push.contentMax = 4;
        await xbk.run();
        assert(pushCalls.length === 1, '应推送 1 条');
        assert(pushCalls[0].text.length <= 5, `标题最终长度应 ≤ titleMax(5)，实际: ${pushCalls[0].text}`);
        assert(!pushCalls[0].text.includes('非常长的标题用于测试截断'), '标题不应超过 5 字符');
        assert(pushCalls[0].desp.length <= 4, `内容应按 4 截断（含 Markdown 转换结果），实际: ${pushCalls[0].desp.length}`);
    } finally {
        Config.push.titleMax = origTitleMax;
        Config.push.contentMax = origContentMax;
    }
    // 非法值（负数/0/非数字）→ 回退默认，不误截
    reset();
    setPushUrl('t49b_trunc_fallback');
    fakeData = [makeItem({ id: 2, title: '正常标题', content: '正常内容' })];
    try {
        Config.push.titleMax = -1;
        Config.push.contentMax = 0;
        await xbk.run();
        assert(pushCalls.length === 1, '回退默认仍应推送');
        assert(pushCalls[0].text.includes('【分类】正常标题') || pushCalls[0].text.includes('正常标题'),
            `非法 titleMax 不应截断，实际: ${pushCalls[0].text}`);
        assert(pushCalls[0].desp.includes('原文链接'), '非法 contentMax 不应截断 Markdown 全文');
    } finally {
        Config.push.titleMax = origTitleMax;
        Config.push.contentMax = origContentMax;
    }
});

await test('并行模式 + 自定义模板/截断组合（v3.84）', async () => {
    reset();
    setPushUrl('t50_parallel_tpl');
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 })];
    const origMode = Config.push.mode;
    const origTitleMax = Config.push.titleMax;
    const origTpl = Config.template.title;
    try {
        Config.push.mode = 'parallel';
        Config.push.titleMax = 20;
        Config.template.title = '【{分类名}】{标题}|{链接}';
        await xbk.run();
        assert(pushCalls.length === 2, `应推 2 条: ${pushCalls.length}`);
        for (const c of pushCalls) {
            assert(c.text.length <= 20, `并行模式标题应 ≤ titleMax(20): ${c.text}`);
            assert(c.text.includes('|'), `模板分隔符应生效: ${c.text}`);
            assert(!c.text.includes('{'), `占位符应全部替换: ${c.text}`);
        }
    } finally {
        Config.push.mode = origMode;
        Config.push.titleMax = origTitleMax;
        Config.template.title = origTpl;
    }
});

await test('配置矩阵: 全部非法值并行模式不崩（v3.95）', async () => {
    reset();
    setPushUrl('t51_cfg_matrix');
    fakeData = [makeItem({ id: 1 })];
    try {
        Config.api.timeout = 'abc';
        Config.api.retry = 2.5; // 小数合法执行（非法值会导致 fetchData 合理失败，非本测试目标）
        Config.timing.pushInterval = 'x';
        Config.timing.finalWait = 'y';
        Config.push.mode = 'parallel';
        Config.push.parallelLimit = 'z';
        Config.push.titleMax = -1;
        Config.push.contentMax = 'abc';
        Config.cache.maxSize = 0;
        Config.cache.dir = 123;
        Config.template.title = 456;
        Config.template.content = null;
        Config.domain = '非法域名';
        await xbk.run();
        assert(pushCalls.length === 1, `全部非法配置下仍应推送成功: ${pushCalls.length}`);
        assert(pushCalls[0].desp.includes('原文链接'), '非法配置回退默认后内容应完整');
    } finally {
        reset(); // v3.91 reset 恢复全部默认
    }
});

// ==================== 7.20 R1 低风险修复：pushOne 非 Error 兜底 ====================
await test('推送抛非Error(字符串) → 不崩溃、失败计数、不写缓存（R1 防御）', async () => {
    reset();
    setPushUrl('t52_notify_string');
    fakeData = [makeItem({ id: 1 })];
    notifyFailString = true; // notify 抛字符串异常
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        const r = await xbk.run();
        assert(r.total === 1, `total=1: ${r.total}`);
        assert(r.pushed === 0 && r.failed === 1, `失败应计数: pushed=${r.pushed} failed=${r.failed}`);
        assert(pushCalls.length === 0, '字符串异常时 notify 不应有成功调用');
        assert(readCacheFile('t52_notify_string').length === 0, '失败不写缓存（下次重试）');
        // 日志断言：失败原因应显示字符串本身，而非 undefined（R1 兜底核心）
        const log = captured.join('\n');
        assert(log.includes('push boom string'), `日志应含字符串原因: ${log.slice(-120)}`);
        assert(!log.includes('undefined'), `日志不应含 undefined: ${log.slice(-120)}`);
    } finally {
        console.log = origLog;
        notifyFailString = false;
    }
});

// ==================== 7.21 R2 低风险修复：domain 防御 + fetchData 日志兜底 ====================
await test('domain 非字符串(数字) → 不崩溃、正常推送（R2 baseUrl 防御）', async () => {
    reset();
    setPushUrl('t53_domain_num');
    fakeData = [makeItem({ id: 1 })];
    Config.domain = 123; // 脏配置：数字（v3.73 校验只警告不阻止，baseUrl 需防御）
    try {
        const r = await xbk.run();
        assert(r.total === 1 && r.pushed === 1, `domain=123 应仍能推送: pushed=${r.pushed}`);
        assert(pushCalls[0].desp.includes('原文链接'), '推送内容正常');
    } finally {
        reset();
    }
});

await test('fetchData 抛字符串 → 重试日志含原因且无 undefined（R2 日志兜底）', async () => {
    reset();
    setPushUrl('t54_fetch_string');
    fakeData = [makeItem({ id: 1 })];
    failPlainString = true; // got 抛 'plain string error'
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        let rejected = false;
        try { await xbk.run(); } catch (e) { rejected = true; }
        assert(rejected, '重试耗尽应失败');
        const log = captured.join('\n');
        assert(log.includes('plain string error'), `日志应含字符串原因: ${log.slice(-120)}`);
        assert(!log.includes('undefined'), `日志不应含 undefined: ${log.slice(-120)}`);
    } finally {
        console.log = origLog;
        failPlainString = false;
    }
});

await test('reset() 恢复 api.timeout/retry 默认值（R3-1 测试隔离）', async () => {
    Config.api.timeout = 9999;
    Config.api.retry = 7;
    reset();
    assert(Config.api.timeout === 5000, `timeout 恢复默认: ${Config.api.timeout}`);
    assert(Config.api.retry === 2, `retry 恢复默认: ${Config.api.retry}`);
});

// ==================== 7.22 R4 低风险修复：retry 有界 + Pusher 参数归一 ====================
await test('fetchData retry=Infinity → 有界兜底不无限重试（R4-1 防死循环）', async () => {
    reset();
    setPushUrl('t56_retry_inf');
    fakeData = [makeItem({ id: 1 })];
    failCount = 5; // mock got 持续失败
    Config.api.retry = Infinity; // 非法配置：死循环风险
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        let rejected = false;
        try { await xbk.run(); } catch (e) { rejected = true; }
        assert(rejected, '持续失败应最终抛错');
        assert(gotCalls.length <= 3, `retry=Infinity 应兜底为 2 次重试(共3次请求): 实际 ${gotCalls.length}`);
        // R5-1：日志显示兜底后次数（1/2、2/2），非 "1/Infinity"
        const log = captured.join('\n');
        assert(log.includes('1/2'), `日志应显示兜底次数 1/2: ${log.slice(-160)}`);
        assert(!log.includes('Infinity'), `日志不应含 Infinity: ${log.slice(-160)}`);
    } finally {
        console.log = origLog;
        failCount = 0;
        reset(); // R3-1 已恢复 api.retry
    }
});

await test('Pusher.send 非字符串参数 → 归一为空串（R4-2 防御）', async () => {
    reset();
    await xbk.Pusher.send(undefined, null);
    assert(pushCalls.length === 1, '应调用 sendNotify');
    assert(pushCalls[0].text === '', `text 归一为空串: ${JSON.stringify(pushCalls[0].text)}`);
    assert(pushCalls[0].desp === '', `desp 归一为空串: ${JSON.stringify(pushCalls[0].desp)}`);
});

await test('对象 title 脏数据 → (无标题) 占位、无 [object Object]（R9 防御）', async () => {
    reset();
    setPushUrl('t58_obj_title');
    fakeData = [makeItem({ id: 1, title: { a: 1 } })];
    const r = await xbk.run();
    assert(r.pushed === 1, `应推送成功: ${r.pushed}`);
    const p = pushCalls[0];
    assert(!p.text.includes('[object Object]'), `标题无泄漏: ${p.text.slice(0, 80)}`);
    assert(p.text.includes('(无标题)'), `标题应为 (无标题) 占位: ${p.text.slice(0, 80)}`);
});

await test('zkt_gjc 对象配置 → 警告并全部推送（R11-1 防御）', async () => {
    reset();
    setPushUrl('t59_zkt_obj');
    fakeData = [makeItem({ id: 1, title: '京东神券' }), makeItem({ id: 2, title: '淘宝好价' })];
    Config.keyword.zkt_gjc = { a: 1 }; // 对象脏配置（String 化会成 '[object Object]' 正则）
    const origWarn = console.warn;
    const warns = [];
    console.warn = (m) => warns.push(String(m));
    try {
        const r = await xbk.run();
        assert(r.pushed === 2, `对象 zkt_gjc 应全部推送: ${r.pushed}`);
        assert(warns.some(w => w.includes('zkt_gjc') && w.includes('应为字符串')), '应有非字符串警告');
    } finally {
        console.warn = origWarn;
        reset();
    }
});

// ================================================
console.log('\n========================================');

await test('集成 Fuzz: 随机数据流 + 随机配置 run() 不崩（v3.109）', async () => {
    // 确定性随机（固定 seed——跨运行一致）
    let seed = 20260901;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    // 随机数据生成器：id/catename/title/content/content_html/louzhu/louzhuregtime/url 全部随机脏化
    const randItem = (i) => {
        const r = rand();
        return {
            id: r < 0.2 ? null : (r < 0.4 ? String(i) : i),
            catename: rand() < 0.15 ? null : (rand() < 0.5 ? '分类' + Math.floor(rand() * 5) : ''),
            title: rand() < 0.1 ? null : ('标题' + i + (rand() < 0.5 ? ' 京东' : '')),
            content: rand() < 0.1 ? null : '内容' + i,
            content_html: rand() < 0.3 ? '<b>' + i + '</b>' + (rand() < 0.5 ? '&amp;amp;' : '') : '<p>html' + i + '</p>',
            louzhu: rand() < 0.2 ? null : '楼主' + i,
            louzhuregtime: rand() < 0.3 ? null : (rand() < 0.5 ? '2026-01-01' : String(Math.floor(rand() * 1e9))),
            url: rand() < 0.15 ? null : (rand() < 0.5 ? '/item/' + i + '.html' : 'http://x.com/' + i),
        };
    };
    for (let round = 0; round < 3; round++) {
        reset();
        setPushUrl('t52_fuzz_' + round);
        fakeData = [];
        const n = 20 + Math.floor(rand() * 30);
        for (let i = 0; i < n; i++) fakeData.push(randItem(i));
        // 随机 filter 配置（合法/非法正则混合）
        Config.filter.pingbibiaoti = rand() < 0.5 ? '京东' : (rand() < 0.8 ? '(' : '');
        Config.filter.pingbitime = String(Math.floor(rand() * 20));
        Config.keyword.zkt_gjc = rand() < 0.3 ? '' : (rand() < 0.5 ? '京东' : '[');
        try {
            const summary = await xbk.run();
            assert(typeof summary.total === 'number' && summary.total === fakeData.length,
                `第${round}轮 total 应为 ${fakeData.length}，实际 ${summary.total}`);
            assert(typeof summary.pushed === 'number' && typeof summary.failed === 'number', '摘要字段完整');
            assert(summary.pushed + summary.failed <= summary.total, 'pushed+failed 不应超 total');
        } finally {
            reset();
        }
    }
});


await test('Fuzz 回归: 孤立代理内容 run() 推送成功且无孤立代理（v3.110）', async () => {
    reset();
    setPushUrl('t53_surrogate');
    fakeData = [makeItem({ id: 1, title: '标题\ud800', content_html: '<p>内容\udfff</p>', content: '正文\ud800' })];
    const summary = await xbk.run();
    assert(summary.pushed === 1, `应推送成功: ${JSON.stringify(summary)}`);
    const isolatedRe = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const c of pushCalls) {
        assert(!isolatedRe.test(c.text), `text 无孤立代理: ${JSON.stringify(c.text)}`);
        assert(!isolatedRe.test(c.desp), 'desp 无孤立代理');
        try { encodeURIComponent(c.text); encodeURIComponent(c.desp); }
        catch (e) { throw new Error('推送内容 encode 崩'); }
    }
});


await test('边界: parallelLimit=1 与顺序模式等价 + pushInterval=0 快速 + retry=0 不重试', async () => {
    // parallelLimit=1：每批 1 条 = 串行效果
    reset();
    setPushUrl('t55_limit1');
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })];
    const origMode = Config.push.mode, origLimit = Config.push.parallelLimit, origPI = Config.timing.pushInterval;
    try {
        Config.push.mode = 'parallel';
        Config.push.parallelLimit = 1;
        Config.timing.pushInterval = 0;
        const summary = await xbk.run();
        assert(summary.pushed === 3, `parallelLimit=1 应推 3 条: ${JSON.stringify(summary)}`);
        assert(pushCalls.length === 3, '3 条全部推送');
        assert(summary.failed === 0, '无失败');
    } finally {
        Config.push.mode = origMode; Config.push.parallelLimit = origLimit; Config.timing.pushInterval = origPI;
    }
    // retry=0：不重试（mock 首次失败 → 直接抛错）
    reset();
    setPushUrl('t55b_retry0');
    fakeData = [];
    const origRetry = Config.api.retry;
    try {
        Config.api.retry = 0;
        failCount = 1; // 首次失败，retry=0 不重试
        let threw = false;
        try { await xbk.run(); } catch (e) { threw = true; }
        assert(threw, 'retry=0 时首次失败应直接抛错');
    } finally {
        Config.api.retry = origRetry;
    }
    // retry=1：失败 1 次后重试成功
    reset();
    setPushUrl('t55c_retry1');
    fakeData = [makeItem({ id: 1 })];
    try {
        Config.api.retry = 1;
        failCount = 1; // 失败 1 次 → 重试成功
        const summary = await xbk.run();
        assert(summary.pushed === 1, 'retry=1 失败一次后应重试成功');
    } finally {
        Config.api.retry = origRetry;
    }
});


await test('接口异常 → 发送告警 + 限频（v3.123）', async () => {
    reset();
    setPushUrl('t56_alert');
    fakeData = [];
    const origInterval = Config.alert.intervalMs;
    const origEnabled = Config.alert.enabled;
    try {
        // ① 不限频 → 接口异常发告警
        Config.alert.enabled = true; // reset() 默认关闭（v3.124），此处显式开启
        Config.alert.intervalMs = 0;
        fail4xx = true; // 404 不重试 → run 抛错
        let threw = false;
        try { await xbk.run(); } catch (e) { threw = true; }
        assert(threw, '接口异常应抛错');
        const alert = pushCalls.find(c => c.text.includes('运行异常'));
        assert(!!alert, '应发送运行异常告警');
        assert(alert.desp.includes('Not Found'), `告警内容应含原因: ${alert.desp.slice(0, 80)}`);
        assert(alert.desp.includes('\n\n时间：'), `告警 desp 应用段落分隔 \\n\\n（v3.159，wxpusher Markdown 渲染单\\n可能挤行）: ${JSON.stringify(alert.desp.slice(0, 60))}`);
        // ② 限频生效：intervalMs 大 → 第二次异常不发（状态文件记录上次）
        Config.alert.intervalMs = 3600000;
        reset();
        setPushUrl('t56_alert_2');
        fail4xx = true;
        try { await xbk.run(); } catch (e) { /* 预期抛错 */ }
        const alert2 = pushCalls.find(c => c.text.includes('运行异常'));
        assert(!alert2, '限频内不应重复发送告警');
    } finally {
        Config.alert.intervalMs = origInterval;
        Config.alert.enabled = origEnabled;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});

await test('告警 intervalMs 非法字符串 → 回退默认限频不轰炸（v3.167）', async () => {
    reset();
    setPushUrl('t72_alert_interval_abc');
    fakeData = [];
    const origInterval = Config.alert.intervalMs;
    const origEnabled = Config.alert.enabled;
    const alertStatePath = path.join(CACHE_DIR, 'alert.state'); // getFilePath 未导出（曾吞错致假清理，残留 lastAt 限频）
    try { require('fs').unlinkSync(alertStatePath); } catch (e) { /* 清残留防限频 */ }
    try {
        Config.alert.enabled = true;
        Config.alert.intervalMs = 'abc'; // 非法字符串（环境变量拼错）——曾 'abc' > 0 比较 false → 0 不限频轰炸
        // 第一次：接口异常 → 发告警（lastAt 空，'abc' 回退默认 3600000 仍发首次）
        fail4xx = true;
        try { await xbk.run(); } catch (e) { /* 预期抛错 */ }
        const alert1 = pushCalls.find(c => c.text.includes('运行异常'));
        assert(!!alert1, '第一次应发告警');
        // 第二次：限频应生效（'abc' → 默认 3600000，曾 0 不限频每次轰炸）
        reset();
        setPushUrl('t72_alert_interval_abc_2');
        Config.alert.enabled = true; // reset() 默认关闭告警（曾漏开 → 第二次不发是 disabled 而非限频，变异抓不住）
        fail4xx = true;
        try { await xbk.run(); } catch (e) { /* 预期抛错 */ }
        const alert2 = pushCalls.find(c => c.text.includes('运行异常'));
        assert(!alert2, `非法 intervalMs 应回退默认限频（曾不限频轰炸）: ${pushCalls.map(c => c.text).join('|')}`);
    } finally {
        Config.alert.intervalMs = origInterval;
        Config.alert.enabled = origEnabled;
        try { require('fs').unlinkSync(alertStatePath); } catch (e) { /* 忽略 */ }
    }
});


await test('运行日报：跨天发昨日日报 + 当天累加（v3.125）', async () => {
    reset();
    setPushUrl('t57_report');
    fakeData = [makeItem({ id: 1 })];
    const orig = Config.report.enabled;
    Config.report.enabled = true;
    const statePath = path.join(CACHE_DIR, 'report.state');
    try {
        // 写昨天状态（有数据）→ 今天首次 run 应发昨日日报
        require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, dedup: 1, filtered: 1, pushed: 3, failed: 0 }));
        await xbk.run();
        const report = pushCalls.find(c => c.text.includes('日报'));
        assert(!!report, '跨天应发昨日日报');
        assert(report.desp.includes('推送 3 条'), `日报应含昨日统计: ${report.desp}`);
        assert(report.desp.includes('条\n\n获取'), `日报 desp 应用段落分隔 \\n\\n（v3.159，与主推送口径一致）: ${JSON.stringify(report.desp.slice(0, 60))}`);
        // 同一天再跑 → 不重复发日报（累加今天；用新 id 防缓存去重）
        pushCalls.length = 0;
        fakeData = [makeItem({ id: 2 })];
        await xbk.run();
        assert(!pushCalls.some(c => c.text.includes('日报')), '同一天不重复发日报');
        const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
        assert(st.pushed >= 2, `当天应累加 pushed: ${st.pushed}`);
        assert(st.date === new Date().toISOString().slice(0, 10), '状态日期应为今天');
    } finally {
        Config.report.enabled = orig;
        try { require('fs').unlinkSync(statePath); } catch (e) { /* 忽略 */ }
    }
});


await test('告警通道挂 → 不误报"已发送"（v3.145）', async () => {
    reset();
    setPushUrl('t59_alert_nofalse');
    fakeData = [];
    const origInterval = Config.alert.intervalMs;
    const origEnabled = Config.alert.enabled;
    const origLog = console.log;
    const logs = [];
    console.log = (...a) => logs.push(a.join(' '));
    try {
        Config.alert.enabled = true;
        Config.alert.intervalMs = 0;
        fail4xx = true; // 接口失败触发告警
        notifyFail = true; // 告警通道也挂（sendNotify reject）
        try { await xbk.run(); } catch (e) { /* 预期抛错 */ }
        assert(!logs.some(l => l.includes('已发送运行异常告警')), `通道挂不应误报已发送: ${logs.join(' | ')}`);
    } finally {
        console.log = origLog;
        Config.alert.intervalMs = origInterval;
        Config.alert.enabled = origEnabled;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});

await test('日报通道挂 → 不误报"已发送"（v3.146）', async () => {
    reset();
    setPushUrl('t60_report_nofalse');
    fakeData = [makeItem({ id: 1 })];
    const orig = Config.report.enabled;
    const statePath = path.join(CACHE_DIR, 'report.state');
    const origLog = console.log;
    const logs = [];
    console.log = (...a) => logs.push(a.join(' '));
    try {
        Config.report.enabled = true;
        notifyFail = true; // 日报通道挂
        require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, pushed: 3, failed: 0 }));
        await xbk.run();
        assert(!logs.some(l => l.includes('已发送昨日运行日报')), `通道挂不应误报已发送日报: ${logs.join(' | ')}`);
    } finally {
        console.log = origLog;
        Config.report.enabled = orig;
        try { require('fs').unlinkSync(statePath); } catch (e) { /* 忽略 */ }
    }
});

await test('告警发送失败 → alert.state 不写（v3.156 #3）', async () => {
    reset();
    setPushUrl('t62_alert_state');
    try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 清残留 */ }
    fakeData = [];
    const origInterval = Config.alert.intervalMs;
    const origEnabled = Config.alert.enabled;
    try {
        Config.alert.enabled = true;
        Config.alert.intervalMs = 60000;
        fail4xx = true; // 接口失败触发告警
        notifyFail = true; // 告警通道也挂（sendNotify reject）
        try { await xbk.run(); } catch (e) { /* 预期抛错 */ }
        await new Promise(r => setTimeout(r, 50)); // 等 sendNotify 微任务（fire-and-forget）
        const statePath = path.join(CACHE_DIR, 'alert.state');
        assert(!fs.existsSync(statePath), `发送失败不应写状态(曾写 lastAt 限频挡重试): ${fs.existsSync(statePath)}`);
    } finally {
        Config.alert.intervalMs = origInterval;
        Config.alert.enabled = origEnabled;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});

await test('日报发送失败 → report.state date 不重置（v3.156 #3）', async () => {
    reset();
    setPushUrl('t63_report_state');
    fakeData = [makeItem({ id: 1 })];
    const orig = Config.report.enabled;
    const statePath = path.join(CACHE_DIR, 'report.state');
    try {
        Config.report.enabled = true;
        notifyFail = true; // 日报通道挂
        require('fs').writeFileSync(statePath, JSON.stringify({ date: '2026-08-01', total: 5, pushed: 3, failed: 0 }));
        await xbk.run();
        await new Promise(r => setTimeout(r, 50)); // 等 sendNotify 微任务（fire-and-forget）
        const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
        assert(st.date === '2026-08-01', `发送失败不应重置 date(曾直接跨天丢日报): ${st.date}`);
        assert(st.total >= 5, '本次数据应累计进旧 state(不丢)');
    } finally {
        Config.report.enabled = orig;
        try { require('fs').unlinkSync(statePath); } catch (e) { /* 忽略 */ }
    }
});

await test('retry 字符串配置生效（v3.158 #21）', async () => {
    reset();
    setPushUrl('t64_retry_str');
    const orig = Config.api.retry;
    try {
        Config.api.retry = '3'; // 环境变量字符串(区分默认2)
        failCount = 99; // 一直失败直到重试耗尽
        fakeData = [makeItem({ id: 1 })];
        let crashed = false;
        try { await xbk.run(); } catch (e) { crashed = true; }
        assert(gotCalls.length === 4, `字符串 retry='3' 应重试3次(共4请求)，实际${gotCalls.length}`);
        assert(crashed, '重试耗尽应抛错');
    } finally {
        Config.api.retry = orig;
    }
});

await test('alert.enabled 字符串 "false" 关闭告警（v3.158 #28）', async () => {
    reset();
    setPushUrl('t65_alert_str');
    fakeData = [];
    const orig = Config.alert.enabled;
    try {
        Config.alert.enabled = 'false'; // 环境变量字符串
        Config.alert.intervalMs = 0;
        fail4xx = true;
        try { await xbk.run(); } catch (e) { /* 预期 */ }
        assert(!pushCalls.some(c => c.text.includes('运行异常')), `字符串 false 应关闭告警: ${pushCalls.length}`);
    } finally {
        Config.alert.enabled = orig;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});

await test('parallelLimit 字符串配置生效（v3.158 #24）', async () => {
    reset();
    setPushUrl('t66_plimit_str');
    const orig = Config.push.parallelLimit;
    try {
        Config.push.mode = 'parallel';
        Config.push.parallelLimit = '1'; // 字符串 → 每批 1 条
        fakeData = [1, 2, 3].map(i => makeItem({ id: i }));
        await xbk.run();
        assert(pushCalls.length === 3, `parallelLimit='1' 应全推 3 条`);
        assert(Config.push.parallelLimit === '1', '不应修改用户配置');
    } finally {
        Config.push.parallelLimit = orig;
        Config.push.mode = 'sequential';
    }
});

await test('单次推送上限 maxPerRun 防推送风暴（v3.129）', async () => {
    reset();
    setPushUrl('t58_maxperrun');
    const orig = Config.push.maxPerRun;
    try {
        // 150 条 → 只推 100
        Config.push.maxPerRun = 100;
        fakeData = [];
        for (let i = 0; i < 150; i++) fakeData.push(makeItem({ id: i + 1000 }));
        const summary = await xbk.run();
        assert(summary.pushed === 100, `应只推 100 条: ${JSON.stringify(summary)}`);
        assert(summary.total === 150, 'total 仍是拉取数 150');
        assert(summary.truncated === 50, `截断应计入统计: ${JSON.stringify(summary)}`); // v3.145
        // 正常 20 条不截断
        reset();
        setPushUrl('t58b_maxperrun_ok');
        Config.push.maxPerRun = 100;
        fakeData = [];
        for (let i = 0; i < 20; i++) fakeData.push(makeItem({ id: i + 2000 }));
        const s2 = await xbk.run();
        assert(s2.pushed === 20, `正常 20 条应全推: ${JSON.stringify(s2)}`);
        // v3.134：截断未推的不写缓存 → 下次运行推剩余（不丢不重复）
        reset();
        setPushUrl('t58c_trunc_retry');
        Config.push.maxPerRun = 100;
        fakeData = [];
        for (let i = 0; i < 150; i++) fakeData.push(makeItem({ id: i + 3000 }));
        const s3 = await xbk.run(); // 第一次：截断推 100
        assert(s3.pushed === 100, `首次应推 100: ${JSON.stringify(s3)}`);
        const cached1 = readCacheFile('t58c_trunc_retry');
        assert(cached1.length === 100, `首次只缓存推的 100（截断的 50 不缓存）: ${cached1.length}`);
        reset();
        setPushUrl('t58c_trunc_retry');
        fakeData = [];
        for (let i = 0; i < 150; i++) fakeData.push(makeItem({ id: i + 3000 }));
        const s4 = await xbk.run(); // 第二次：缓存去重 100 → 剩 50 → 推 50（不重复）
        assert(s4.pushed === 50, `二次应推剩余 50: ${JSON.stringify(s4)}`);
        assert(s4.dedup === 100, `二次去重 100: ${JSON.stringify(s4)}`);
    } finally {
        Config.push.maxPerRun = orig;
    }
});

await test('maxPerRun 小数配置 → truncated 整数化（v3.165，parallelLimit 同款 Math.floor）', async () => {
    reset();
    setPushUrl('t70b_maxperrun_float');
    const orig = Config.push.maxPerRun;
    try {
        Config.push.maxPerRun = '2.5'; // 环境变量字符串 + 小数（曾 truncatedCount 减出 0.5 条）
        fakeData = [];
        for (let i = 0; i < 5; i++) fakeData.push(makeItem({ id: i + 4000 }));
        const summary = await xbk.run();
        assert(Number.isInteger(summary.truncated), `truncated 应为整数: ${JSON.stringify(summary)}`);
        assert(summary.truncated === 3, `5 条 - 2 条 = 截断 3: ${JSON.stringify(summary)}`);
        assert(summary.pushed === 2, `应推 2 条: ${JSON.stringify(summary)}`);
        // 非法值仍回退默认
        Config.push.maxPerRun = 'abc';
        fakeData = [{ id: 1, title: 'T', content: 'c', catename: 'c', url: 'https://x.com/1', datetime: '2026-08-03', shijianchuo: 1785734400, content_html: '<p>c</p>' }];
        const s2 = await xbk.run();
        assert(s2.pushed === 1 && s2.truncated === 0, `非法 maxPerRun 回退默认不截断: ${JSON.stringify(s2)}`);
    } finally {
        Config.push.maxPerRun = orig;
    }
});


await test('告警/日报触发时通道失败 → 无 unhandledRejection（v3.135）', async () => {
    reset();
    setPushUrl('t59_alert_unhandled');
    fakeData = [];
    Config.alert.enabled = true;
    Config.alert.intervalMs = 0; // 不限频
    let unhandled = 0;
    const handler = () => unhandled++;
    process.on('unhandledRejection', handler);
    try {
        fail4xx = true;    // 接口 404 → run 抛错 → _sendAlert
        notifyFail = true; // 告警通道 mock reject
        let threw = false;
        try { await xbk.run(); } catch (e) { threw = true; }
        assert(threw, '接口异常应抛错');
        await new Promise(r => setTimeout(r, 100)); // 等 fire-and-forget 完成
        assert(unhandled === 0, `告警通道失败不应 unhandledRejection: ${unhandled}`);
    } finally {
        process.removeListener('unhandledRejection', handler);
        Config.alert.enabled = false;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});


await test('连续运行：report.state 累加/缓存去重/状态文件正确（v3.141）', async () => {
    reset();
    setPushUrl('t60_cron');
    fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 })];
    const orig = Config.report.enabled;
    Config.report.enabled = true;
    const statePath = path.join(CACHE_DIR, 'report.state');
    try {
        try { require('fs').unlinkSync(statePath); } catch (e) { /* 不存在则忽略 */ }
        // 第 1 次：推 2 条
        const s1 = await xbk.run();
        assert(s1.pushed === 2, `第1次应推2: ${JSON.stringify(s1)}`);
        // 第 2 次：同数据 → 缓存去重 → 推 0
        const s2 = await xbk.run();
        assert(s2.pushed === 0 && s2.dedup === 2, `第2次应全去重: ${JSON.stringify(s2)}`);
        // 第 3 次：新数据 1 条 + 旧 1 条 → 推 1 去重 1
        fakeData = [makeItem({ id: 1 }), makeItem({ id: 3 })];
        const s3 = await xbk.run();
        assert(s3.pushed === 1 && s3.dedup === 1, `第3次应推1去重1: ${JSON.stringify(s3)}`);
        // report.state：3 次累加 pushed = 2+0+1 = 3
        const st = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
        assert(st.pushed === 3, `report.state 应累加 3 条: ${JSON.stringify(st)}`);
        assert(st.total === 6, `report.state total 应 2×3 次=6: ${JSON.stringify(st)}`);
    } finally {
        Config.report.enabled = orig;
        try { require('fs').unlinkSync(statePath); } catch (e) { /* 忽略 */ }
    }
});

// ==================== v3.159：BUG_HUNT 候选修复验证 ====================
await test('过滤规则变更 → 清除过滤写入缓存，改宽后旧条目重新推送（v3.159）', async () => {
    reset();
    setPushUrl('t67_filter_change');
    const hashPath = path.join(CACHE_DIR, 'filter.hash');
    try { require('fs').unlinkSync(hashPath); } catch (e) { /* 忽略 */ }
    try {
        // 第一次运行：屏蔽「京东」→ 京东条目被过滤写入缓存（_f 标记）
        Config.filter.pingbibiaoti = '京东';
        fakeData = [makeItem({ id: 1 }), makeItem({ id: 2, title: '淘宝特价' }), makeItem({ id: 3, title: '拼多多砍价' })];
        let s = await xbk.run();
        assert(s.pushed === 2 && s.filtered === 1, `首次应推2过滤1: ${JSON.stringify(s)}`);
        const cached1 = readCacheFile('t67_filter_change');
        const marked = cached1.filter(m => m._f === true);
        assert(marked.length === 1 && marked[0].id === 1,
            `缓存应有 1 条过滤标记(京东 id=1): ${cached1.map(m => `${m.id}:_f=${m._f}`).join(',')}`);

        // 第二次运行：改宽（不屏蔽）→ 过滤写入缓存失效 → 京东重新评估并推送
        Config.filter.pingbibiaoti = '';
        pushCalls = [];
        s = await xbk.run();
        assert(s.pushed === 1 && s.filtered === 0 && s.dedup === 2,
            `改宽后应重推 1 条(京东)，其余去重: ${JSON.stringify(s)}`);
        assert(pushCalls.length === 1 && pushCalls[0].desp.includes('京东神券'),
            `京东应重新推送: ${pushCalls.map(c => c.text).join('|')}`);
        const cached2 = readCacheFile('t67_filter_change');
        assert(cached2.length === 3 && cached2.every(m => m._f !== true),
            `过滤标记应已清除（重新推送的 id=1 以成功态写回）: ${cached2.map(m => `${m.id}:_f=${m._f}`).join(',')}`);
    } finally {
        try { require('fs').unlinkSync(hashPath); } catch (e) { /* 忽略 */ }
    }
});

await test('pingbitime 变更 → 清除过滤写入缓存并重推（#7 v3.161）', async () => {
    reset();
    setPushUrl('t68_pb_change');
    const origPb = Config.filter.pingbitime;
    const fiveDaysAgo = Date.now() - 5 * 86400000;
    try {
        Config.filter.pingbitime = '30'; // 注册5天 < 30 → 被天数过滤
        fakeData = [makeItem({ id: 1, louzhuregtime: fiveDaysAgo })];
        await xbk.run();
        const cached1 = readCacheFile('t68_pb_change');
        assert(cached1.some(m => m._f === true), '被过滤条目应写 _f 标记');
        // 放宽 pingbitime → filterHash 变化 → 清除 _f → 重推
        reset();
        setPushUrl('t68_pb_change');
        Config.filter.pingbitime = '3'; // 5天 > 3 → 应推送
        fakeData = [makeItem({ id: 1, louzhuregtime: fiveDaysAgo })];
        await xbk.run();
        const cached2 = readCacheFile('t68_pb_change');
        assert(pushCalls.length === 1, `放宽后应重推(不再被缓存判重跳过)，实际${pushCalls.length}`);
        assert(!cached2.some(m => m._f === true), '重推后 _f 标记应清除');
    } finally {
        Config.filter.pingbitime = origPb;
    }
});

await test('api.timeout 字符串配置生效（#8 v3.162）', async () => {
    reset();
    setPushUrl('t69_timeout_str');
    const orig = Config.api.timeout;
    try {
        Config.api.timeout = '5000'; // 环境变量字符串（曾回退 15s）
        fakeData = [makeItem({ id: 1 })];
        await xbk.run();
        const call = gotCalls.find(c => c.url.includes('t69_timeout_str'));
        assert(call && call.opts && call.opts.timeout === 5000, `字符串 timeout 应生效为 5000: ${call && call.opts && call.opts.timeout}`);
    } finally {
        Config.api.timeout = orig;
    }
});

await test('推送全部失败 → 触发告警调用 + run.log ERROR（#9 v3.163）', async () => {
    reset();
    setPushUrl('t70_pushfail');
    const orig = Config.alert.enabled;
    const logPath = path.join(CACHE_DIR, 'run.log');
    try { require('fs').unlinkSync(logPath); } catch (e) { /* 忽略 */ }
    try {
        Config.alert.enabled = true;
        Config.alert.intervalMs = 0;
        // 推送全部失败（notify mock 抛错）→ pushOne 全 catch → 触发 _sendAlert + ERROR 日志
        notifyFail = true;
        fakeData = [makeItem({ id: 1 }), makeItem({ id: 2 })];
        await xbk.run();
        const log = require('fs').readFileSync(logPath, 'utf8');
        assert(log.includes('ERROR'), `推送全失败应写 ERROR 行: ${log.slice(-100)}`);
        assert(log.includes('推送全部失败'), 'ERROR 行应标明推送全部失败');
    } finally {
        Config.alert.enabled = orig;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});

await test('接口异常告警在 run 返回前完成（#10 v3.164，防 exit 杀死）', async () => {
    reset();
    setPushUrl('t71_alert_await');
    fakeData = [];
    const origInterval = Config.alert.intervalMs;
    const origEnabled = Config.alert.enabled;
    try {
        Config.alert.enabled = true;
        Config.alert.intervalMs = 0;
        fail4xx = true; // 接口失败 → 触发告警
        notifyDelayMs = 50; // 模拟真实网络往返：告警 sendNotify 延迟 50ms（fire-and-forget 会被 process.exit(1) 杀死）
        let crashed = false;
        try { await xbk.run(); } catch (e) { crashed = true; }
        assert(crashed, '接口失败应抛错');
        // v3.164：catch 里 await _sendAlert → run 返回时告警已完成（曾 fire-and-forget → exit 杀死告警 HTTP）
        const alertSent = pushCalls.some(c => c.text && String(c.text).includes('运行异常'));
        assert(alertSent, '告警应在 run 返回前完成（否则被 process.exit 杀死，cron 直接运行收不到）');
    } finally {
        fail4xx = false;
        notifyDelayMs = 0;
        Config.alert.intervalMs = origInterval;
        Config.alert.enabled = origEnabled;
        try { require('fs').unlinkSync(path.join(CACHE_DIR, 'alert.state')); } catch (e) { /* 忽略 */ }
    }
});

await test('pingbitime 配置 + 接口缺 louzhuregtime → 运行期警告（v3.159）', async () => {
    reset();
    setPushUrl('t67_pingbtime_warn');
    Config.filter.pingbitime = '5';
    fakeData = [makeItem({ id: 1, louzhuregtime: null }), makeItem({ id: 2, louzhuregtime: '' }), makeItem({ id: 3 })];
    const origWarn = console.warn;
    const warns = [];
    console.warn = (m) => warns.push(String(m));
    try {
        await xbk.run();
    } finally {
        console.warn = origWarn;
        Config.filter.pingbitime = '';
    }
    assert(warns.some(w => w.includes('louzhuregtime') && w.includes('pingbitime')),
        `应有注册时间缺失警告: ${warns.join(' | ')}`);
});

await test('模板含不支持占位符（{价格}等）→ 启动警告且推送不崩（v3.159）', async () => {
    reset();
    setPushUrl('t67_tpl_warn');
    const origT = Config.template.title, origC = Config.template.content;
    Config.template.title = '【{分类名}】{标题}';
    Config.template.content = '{价格} {商城} {品牌} {图片} {标题}';
    fakeData = [makeItem({ id: 1 })];
    const origWarn = console.warn;
    const warns = [];
    console.warn = (m) => warns.push(String(m));
    try {
        await xbk.run();
    } finally {
        console.warn = origWarn;
        Config.template.title = origT;
        Config.template.content = origC;
    }
    assert(warns.some(w => w.includes('{价格}') && w.includes('template.content')),
        `应有模板占位符警告: ${warns.join(' | ')}`);
    // {价格} 等未知占位符被 tuisong_replace 替换为空（非保留原样）；{标题} 正常替换——推送不崩
    assert(pushCalls.some(c => c.desp.includes('京东神券 100元') && !c.desp.includes('{价格}') && !c.desp.includes('{商城}')),
        `占位符应替换为空且标题正常: ${pushCalls.map(c => JSON.stringify(c.desp.slice(0, 80))).join('|')}`);
});

if (failed === 0) {
    console.log(`  🎉 集成测试全部通过！${passed}/${passed}`);
} else {
    console.log(`  ⚠️   ${passed} 通过, ${failed} 失败`);
    errors.forEach(e => console.log(`    ${e}`));
}
console.log('========================================\n');

// 清理本套件产生的缓存测试文件（t\d{2}_/t48b_/tpush_/tpar_fail，保留真实运行缓存 push.json）
// v3.122：--only 模式（并行调度）跳过清理——并行进程删除会删掉其他仍在跑的进程正在使用的缓存文件
if (!onlyFilter) {
    try {
        const fs = require('fs');
        const dir = path.join(__dirname, 'xianbaoku_cache');
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                // t\d{2}[a-z]?_ 同时匹配 t48_ 与 t48b_（v3.69 修复：原 ^t\d{2}_ 漏掉带字母后缀的测试名）
                if (/^t\d{2}[a-z]?_|^tpush_|^tpar_fail/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 忽略 */ } }
            }
        }
    } catch (e) { /* 忽略 */ }
}

process.exit(failed > 0 ? 1 : 0);
})();
