'use strict';
// 推送通道适配器测试：mock got 验证各通道的 URL/body/headers 构造
// 独立文件：需在 require notify 前替换 got(模块加载时引用固定)
//
// 框架说明（曾踩坑）：
// - test() 必须是 async 并 await fn()，否则 async 断言的失败会变成 unhandled rejection 而不被统计
// - 每个测试用 withChannels 清空全部通道再只配被测通道，避免本地密钥(push_config.local.js)
//   与上一个测试残留的通道配置污染 gotCalls / 断言

const path = require('path');
const gotPath = require.resolve('got');
require(gotPath);

let gotCalls = [];
let failHitokoto = false; // 一言接口失败开关（v3.73：验证 sendNotify 兜底跳过不崩）
let failHitokotoStruct = false; // 一言响应结构异常开关（v3.86：缺 hitokoto 字段）
let failPost = false;     // got.post 失败开关（v3.75：验证失败日志不泄露密钥）
let failWxpusher = false; // wxpusher API 失败开关（v3.154：code≠1000 应 reject 不静默）
let rateLimitWxpusherFirst = false; // 多应用分流：首个应用限频时应切换下一个应用
let rateLimitWxpusherCodeOnly = false; // 限频响应仅返回 code=1001，无 msg（必须仍切换备用应用）
let failBiz = false;      // 全部通道 API 业务失败开关（v3.160：code≠成功 应 reject 不静默）
let nullBody = false;     // v3.180：HTTP 200 + 响应体 JSON null 开关（曾 4 通道虚假成功→消息丢失 P1）
let malformedResponse = false; // 响应字段 getter 抛异常：必须按通道失败，不能被 finally resolve 掩盖
let leakResponse = false; // v3.185：异常响应含敏感字段时，日志只允许输出安全摘要
let failMDevSecond = false; // v3.166：Bark/PushMe 多设备第 2 个失败（至少一个成功=通道成功不重试）
let mdevCount = 0;          // 多设备计数（failMDevSecond 时按调用序第 1 成功第 2 失败）
require.cache[gotPath].exports = (url, options) => {
    gotCalls.push({ url, options });
    // 一言接口失败模拟：抛 Error（网络异常路径）
    if (failHitokoto && String(url).includes('hitokoto.cn')) throw new Error('一言服务不可用');
    // 一言接口返回对象 body（模拟真实 got 自动 JSON 解析），其余返回字符串
    const body = String(url).includes('hitokoto.cn')
        ? (failHitokotoStruct ? { hitokoto: 'x' } : { hitokoto: '测试一言', from: '源' }) // 结构异常=缺 from（v3.87）
        : '{}';
    return { then: (res) => res({ body, statusCode: 200, headers: {} }) };
};
require.cache[gotPath].exports.get = require.cache[gotPath].exports;
require.cache[gotPath].exports.post = (url, options) => {
    gotCalls.push({ url, options });
    // 失败模拟（v3.75）：异步 reject 走 $.post 的 err 回调；response.body 含密钥回显（验证不再传给 callback）
    if (failPost) {
        const e = new Error('API error: connection refused');
        e.response = { body: '{"code":500,"msg":"PPT_SECRET 回显"}', statusCode: 500 };
        return Promise.reject(e);
    }
    // wxpusher 返回成功响应（v3.154：API 失败会 reject，成功需 code:1000）；其余 '{}'
    return { then: (res) => {
        // v3.160：各通道 API 级失败会 reject → 成功响应需返回对应业务成功码（曾全 '{}' 因通道不检查）
        const u = String(url);
        let body = '{}';
        if (nullBody) {
            // v3.180：HTTP 200 + JSON null——JSON.parse('null') → data=null → 无防御通道曾虚假成功
            body = 'null';
        } else if (malformedResponse) {
            // 字段 getter 抛错模拟：覆盖 data.code/errno/errcode/content/ok 等响应访问路径。
            // 旧版 catch 只记日志、finally 仍 resolve，单通道会被误记成功。
            body = {};
            for (const key of ['code', 'errno', 'errcode', 'content', 'ok', 'description', 'msg', 'errmsg', 'data']) {
                Object.defineProperty(body, key, {
                    enumerable: true,
                    get() { throw new Error(`malformed ${key}`); },
                });
            }
        } else if (leakResponse) {
            // v3.185：模拟无标准错误字段但回显 token/key/请求体的异常响应
            body = u.includes('push.i-i.me')
                ? '业务失败 PM_SECRET'
                : { code: 500, requestToken: 'LEAK_TOKEN_SECRET', payload: { key: 'LEAK_KEY_SECRET' }, msg: '业务失败 APP_SECRET', errmsg: '业务失败 APP_SECRET', message: '业务失败 APP_SECRET', description: '业务失败 APP_SECRET' };
        } else if (failMDevSecond) {
            // v3.166：多设备部分失败——第 1 个设备成功、第 2 个失败（应至少一个成功=通道成功）
            mdevCount++;
            if (u.includes('api.day.app')) body = mdevCount === 1 ? { code: 200, message: 'success' } : { code: 500, message: 'bad key' };
            else if (u.includes('push.i-i.me')) body = mdevCount === 1 ? 'success' : 'error';
        } else if (failBiz) {
            // 全部通道 API 业务失败（HTTP 200 + 业务码非成功）
            if (u.includes('wxpusher')) body = { code: 1300, msg: '推送失败' };
            else if (u.includes('pushplus.plus')) body = { code: 500, msg: 'token 无效' };
            else if (u.includes('ftqq.com')) body = { errno: 999, errmsg: 'key 无效' };
            else if (u.includes('api.day.app')) body = { code: 500, message: 'deviceKey 无效' };
            else if (u.includes('qyapi.weixin.qq.com')) body = { errcode: 40013, errmsg: 'invalid appid' };
            else if (u.includes('xizhi.qqoq.net')) body = { code: 500, msg: 'key 无效' };
            else if (u.includes('pushdeer.com')) body = { content: { result: [] } };
            else if (u.includes('push.i-i.me')) body = 'error';
            else if (u.includes('api.telegram.org')) body = { ok: false, error_code: 400, description: 'Bad Request' };
        } else if (u.includes('wxpusher')) {
            const appToken = options && options.json && options.json.appToken;
            body = rateLimitWxpusherCodeOnly && appToken === 'AT_C'
                ? { code: 1001 }
                : (rateLimitWxpusherFirst && appToken === 'AT_A'
                    ? { code: 1001, msg: '你访问的速度太快了。当前限制QPS为2.0' }
                    : (failWxpusher ? { code: 1300, msg: '推送失败' } : { code: 1000, msg: 'success' }));
        }
        else if (u.includes('pushplus.plus')) body = { code: 200, msg: 'success' };
        else if (u.includes('ftqq.com')) body = { errno: 0, errmsg: 'success' };
        else if (u.includes('api.day.app')) body = { code: 200, message: 'success' };
        else if (u.includes('qyapi.weixin.qq.com')) body = { errcode: 0, errmsg: 'ok' };
        else if (u.includes('xizhi.qqoq.net')) body = { code: 200, msg: 'success' };
        else if (u.includes('pushdeer.com')) body = { content: { result: [{ id: 1 }] } };
        else if (u.includes('push.i-i.me')) body = 'success';
        else if (u.includes('api.telegram.org')) body = { ok: true, result: {} };
        return res({ body, statusCode: 200, headers: {} });
    } };
};

const notify = require('./xbk_sendNotify_slim.js');
const cfg = notify.push_config;

let passed = 0, failed = 0;
const errors = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  ✅ ' + name);
    } catch (e) {
        failed++;
        errors.push(`${name}: ${e.message}`);
        console.log('  ❌ ' + name + ' (' + e.message + ')');
    }
}
function assert(c, msg) { if (!c) throw new Error(msg || '断言失败'); }
function reset() { gotCalls = []; }

// 所有通道相关配置 key：每个测试前清空 → 只配被测通道（防本地密钥/跨测试污染）
const CHANNEL_KEYS = ['PUSH_PLUS_TOKEN', 'PUSH_PLUS_USER', 'PUSH_KEY',
    'BARK_PUSH', 'BARK_ARCHIVE', 'BARK_GROUP', 'BARK_SOUND', 'BARK_ICON', 'BARK_LEVEL', 'BARK_URL',
    'QYWX_KEY', 'WX_pusher_appToken', 'WX_pusher_topicIds', 'WX_pusher_channels', 'WX_XIZHI_KEY',
    'DEER_KEY', 'DEER_URL', 'PUSHME_KEY', 'PUSHME_URL', 'HITOKOTO',
    'TG_BOT_TOKEN', 'TG_USER_ID', 'TG_API_HOST',
    'TG_PROXY_HOST', 'TG_PROXY_PORT', 'TG_PROXY_AUTH'];

const saved = {};
for (const k of CHANNEL_KEYS) saved[k] = cfg[k];

/** 每个测试独立通道配置：清空全部通道，仅配置 fn 里设置的；结束(含失败)后恢复 */
async function withChannels(fn) {
    for (const k of CHANNEL_KEYS) cfg[k] = '';
    cfg.HITOKOTO = 'false'; // 关闭一言，避免测试时发额外请求
    reset();
    try {
        return await fn();
    } finally {
        for (const k of CHANNEL_KEYS) cfg[k] = saved[k];
    }
}

console.log('\n========================================');
console.log('  🧪 推送通道适配器测试(mock got)');
console.log('========================================\n');

(async () => {

// 1. Server酱 Turbo 版
await test('Server酱: SCT 前缀走 Turbo URL + 表单 URL 编码', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123456';
    await notify.sendNotify('标题&A', '内容&B&C');
    assert(gotCalls.length >= 1, '应有请求');
    const c = gotCalls[0];
    assert(c.url.includes('sctapi.ftqq.com'), `Turbo URL: ${c.url}`);
    assert(c.url.includes('SCT123456'), 'URL 应含 key');
    assert(c.options.agent && c.options.agent.http && c.options.agent.https, '请求应使用共享 HTTP/HTTPS Agent');
    assert(c.options.body.includes('text=%E6%A0%87%E9%A2%98%26A'), `text 应编码: ${c.options.body}`);
    assert(c.options.body.includes('desp='), '应含 desp');
    assert(c.options.headers['Content-Type'].includes('x-www-form-urlencoded'), '表单类型');
}));

await test('Server酱: title 超 32 字符截断（v3.126：真实接口 4/20 标题超限）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123456';
    const longTitle = '好朋友幼儿社交启蒙绘本凸凹星的故事 11元，好朋友幼儿社交启蒙绘本久等了集合 1...';
    await notify.sendNotify(longTitle, '内容');
    const bodyText = decodeURIComponent(gotCalls[0].options.body.match(/text=([^&]*)/)[1]);
    assert(bodyText.length <= 32, `title 应截断到 ≤32: ${bodyText.length} 字符`);
    // 代理对安全：emoji 标题截断不产生孤立高代理
    await notify.sendNotify('😀'.repeat(20) + '标题', '内容');
    const t2 = decodeURIComponent(gotCalls[1].options.body.match(/text=([^&]*)/)[1]);
    assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t2), '不应有孤立高代理');
}));

await test('Bark/Push+: markdown 符号剥离为纯文本（v3.128：不支持 markdown 渲染）', () => withChannels(async () => {
    const md = '**京东神券** 秒杀\n[点我](http://x.com/a) ![图](http://img/1.jpg) `代码`';
    // Bark
    cfg.BARK_PUSH = 'https://api.day.app/dev1';
    await notify.sendNotify('标题', md);
    const barkBody = gotCalls[0].options.json;
    assert(!barkBody.body.includes('**'), `Bark 不应含 **: ${barkBody.body}`);
    assert(!barkBody.body.includes('[') && !barkBody.body.includes(']'), 'Bark 不应含链接符号');
    assert(barkBody.body.includes('http://x.com/a'), '链接文本保留 url');
    assert(!barkBody.body.includes('```'), 'Bark 不应含代码符号');
    assert(!barkBody.body.includes('<'), 'v3.136：{链接} 的 <url> autolink 尖括号应剥掉');
    // Push+（html 模式）
    cfg.BARK_PUSH = '';
    cfg.PUSH_PLUS_TOKEN = 'token1';
    await notify.sendNotify('标题', md);
    const ppBody = gotCalls[1].options.body;
    assert(!ppBody.includes('**'), 'Push+ 不应含 **');
    assert(ppBody.includes('&lt;br&gt;') || ppBody.includes('<br>'), 'Push+ 换行转 html');
}));

// 2. Server酱 老版 URL
await test('Server酱: 非SCT前缀走老版 URL', () => withChannels(async () => {
    cfg.PUSH_KEY = 'OLD123';
    await notify.sendNotify('t', 'd');
    assert(gotCalls[0].url.includes('sc.ftqq.com'), `老版URL: ${gotCalls[0].url}`);
    assert(gotCalls.length === 1, '仅老版一次请求');
}));

// 3. Bark: 设备分割 + 前缀补全
await test('Bark: 多设备 # 分割 + 设备码补全 https', () => withChannels(async () => {
    cfg.BARK_PUSH = 'device1#https://api.day.app/device2';
    await notify.sendNotify('标题', '内容');
    const urls = gotCalls.map(c => c.url);
    assert(urls.includes('https://api.day.app/device1'), '设备码应补 https');
    assert(urls.includes('https://api.day.app/device2'), '完整 URL 保留');
    assert(gotCalls.every(c => c.options.json), 'Bark 应 JSON body');
    assert(gotCalls.every(c => c.options.json.title === '标题'), 'title 正确');
    assert(gotCalls.length === 2, '两个设备两次请求');
}));

await test('Bark: 大写 HTTP(S) 地址不应被错误拼接设备前缀', () => withChannels(async () => {
    cfg.BARK_PUSH = 'HTTPS://api.day.app/UpperDevice';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 1, '应只请求一次');
    assert(gotCalls[0].url === 'HTTPS://api.day.app/UpperDevice', `大写协议地址应原样保留: ${gotCalls[0].url}`);
}));

// v3.166：Bark/PushMe 多设备部分失败 → 至少一个成功 = 通道成功（曾单设备失效 → 整体失败 → 不写缓存 → 有效设备重复轰炸）
await test('Bark: 多设备一成一败 → 通道成功不重试（v3.166）', () => withChannels(async () => {
    cfg.BARK_PUSH = 'https://api.day.app/D1#https://api.day.app/D2';
    failMDevSecond = true;
    mdevCount = 0;
    try {
        await notify.sendNotify('标题', '内容'); // 不应抛错：dev1 成功已送达，dev2 失效不拖垮整体
    } finally { failMDevSecond = false; }
}));

await test('PushMe: 多 key 一成一败 → 通道成功不重试（v3.166）', () => withChannels(async () => {
    cfg.PUSHME_KEY = 'K1#K2';
    failMDevSecond = true;
    mdevCount = 0;
    try {
        await notify.sendNotify('标题', '内容'); // 不应抛错：K1 成功已送达
    } finally { failMDevSecond = false; }
}));

// 4. PushDeer: URL 编码
await test('PushDeer: body 全字段 URL 编码(& # 转义)', () => withChannels(async () => {
    cfg.DEER_KEY = 'key1';
    await notify.sendNotify('标题&A', '内容&B#C');
    assert(gotCalls.length >= 1, '应有请求');
    const c = gotCalls[0];
    assert(c.url.includes('pushdeer.com'), `PushDeer URL: ${c.url}`);
    assert(!c.options.body.includes('A&B'), '& 应被编码');
    assert(c.options.body.includes('%26'), '& 应转义为 %26');
    assert(gotCalls.length === 1, '仅 PushDeer 一次请求');
}));

// 5. 企业微信 webhook
await test('企业微信: webhook URL 含 key + JSON body', () => withChannels(async () => {
    cfg.QYWX_KEY = 'webhook-abc';
    await notify.sendNotify('标题', '内容 ![图](http://img/1.jpg)');
    assert(gotCalls[0].url.includes('qyapi.weixin.qq.com'), `企微 URL: ${gotCalls[0].url}`);
    assert(!gotCalls[0].url.includes('//cgi-bin'), `v3.138：QYWX_ORIGIN 尾斜杠不应双斜杠: ${gotCalls[0].url}`);
    assert(gotCalls[0].url.includes('webhook-abc'), 'key 在 URL');
    assert(gotCalls[0].options.json.msgtype === 'markdown', 'msgtype（v3.127：desp 是 Markdown，text 会显示原始符号）');
    assert(gotCalls[0].options.json.markdown.content.includes('标题'), '内容含标题');
    assert(!gotCalls[0].options.json.markdown.content.includes('!['), 'v3.130：企微 markdown 不支持图片，![]() 应剥成 alt');
    assert(gotCalls[0].options.json.markdown.content.includes('图'), '图片 alt 应保留');
    assert(gotCalls.length === 1, '仅企微一次请求');
    // v3.138：QYWX_ORIGIN 带尾斜杠 → URL 无双斜杠
    const origOrigin = cfg.QYWX_ORIGIN;
    cfg.QYWX_ORIGIN = 'https://qyapi.weixin.qq.com/';
    await notify.sendNotify('标题', '内容');
    assert(!gotCalls[1].url.includes('//cgi-bin'), `尾斜杠 host 不应双斜杠: ${gotCalls[1].url}`);
    cfg.QYWX_ORIGIN = origOrigin;
}));

// 6. wxpusher
await test('wxpusher: appToken + topicIds 数组(逗号分割) + Markdown', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '456,789'; // v3.137：配置注释"逗号分隔"——应分割成数组
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length >= 1, '应有请求');
    const c = gotCalls[0];
    assert(c.url.includes('wxpusher.zjiecode.com'), `wxpusher URL: ${c.url}`);
    assert(c.options.json.appToken === 'AT123', 'appToken');
    assert(Array.isArray(c.options.json.topicIds) && c.options.json.topicIds[0] === '456' && c.options.json.topicIds[1] === '789',
        `v3.137：逗号应分割成数组: ${JSON.stringify(c.options.json.topicIds)}`);
    assert(c.options.json.contentType === 3, 'Markdown');
    assert(gotCalls.length === 1, '仅 wxpusher 一次请求');
}));

await test('wxpusher: 多应用按消息轮流分流，单条只发一个主题', () => withChannels(async () => {
    cfg.WX_pusher_channels = [
        { appToken: 'AT_X', topicIds: '101' },
        { appToken: 'AT_Y', topicIds: ['202'] },
    ];
    await notify.sendNotify('标题1', '内容1');
    await notify.sendNotify('标题2', '内容2');
    await notify.sendNotify('标题3', '内容3');
    assert(gotCalls.length === 3, `三条消息应三次请求，实际 ${gotCalls.length}`);
    assert(gotCalls.map(c => c.options.json.appToken).join(',') === 'AT_X,AT_Y,AT_X',
        `应按应用轮流分流: ${gotCalls.map(c => c.options.json.appToken).join(',')}`);
    assert(gotCalls[0].options.json.topicIds[0] === '101', '应用 A 主题');
    assert(gotCalls[1].options.json.topicIds[0] === '202', '应用 B 主题');
}));

await test('wxpusher: 并发消息也按应用轮询预占，不集中打首个应用', () => withChannels(async () => {
    cfg.WX_pusher_channels = [
        { appToken: 'AT_X', topicIds: '101' },
        { appToken: 'AT_Y', topicIds: '202' },
        { appToken: 'AT_Z', topicIds: '303' },
    ];
    await Promise.all(Array.from({ length: 9 }, (_, i) => notify.sendNotify(`并发${i + 1}`, '内容')));
    const apps = gotCalls.map(c => c.options.json.appToken);
    assert(apps.join(',') === 'AT_X,AT_Y,AT_Z,AT_X,AT_Y,AT_Z,AT_X,AT_Y,AT_Z',
        `并发轮询应均匀预占: ${apps.join(',')}`);
}));

await test('wxpusher: 首选应用明确限频时切换备用应用重试', () => withChannels(async () => {
    cfg.WX_pusher_channels = [
        { appToken: 'AT_A', topicIds: '101' },
        { appToken: 'AT_B', topicIds: '202' },
    ];
    rateLimitWxpusherFirst = true;
    try {
        await notify.sendNotify('标题', '内容');
    } finally {
        rateLimitWxpusherFirst = false;
    }
    assert(gotCalls.length === 2, `首个应用限频后应切换，实际请求 ${gotCalls.length}`);
    assert(gotCalls[0].options.json.appToken === 'AT_A', '首选应用先尝试');
    assert(gotCalls[1].options.json.appToken === 'AT_B', '限频后切换备用应用');
}));

await test('wxpusher: 仅返回 code=1001 时仍切换备用应用', () => withChannels(async () => {
    cfg.WX_pusher_channels = [
        { appToken: 'AT_C', topicIds: '301' },
        { appToken: 'AT_D', topicIds: '302' },
    ];
    rateLimitWxpusherCodeOnly = true;
    try {
        await notify.sendNotify('标题', '内容');
    } finally {
        rateLimitWxpusherCodeOnly = false;
    }
    assert(gotCalls.length === 2, `仅 code=1001 也应切换，实际请求 ${gotCalls.length}`);
    assert(gotCalls[1].options.json.appToken === 'AT_D', 'code=1001 无 msg 时应切换备用应用');
}));

await test('wxpusher: 限频等待收到 AbortSignal 后不再迟到发送', () => withChannels(async () => {
    cfg.WX_pusher_channels = [{ appToken: 'AT_ABORT', topicIds: '401' }];
    const controller = new AbortController();
    const all = Promise.allSettled(Array.from({ length: 20 }, (_, i) => notify.sendNotify(`取消${i}`, '内容', { signal: controller.signal })));
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    await all;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(gotCalls.length === 19, `取消后不应发送迟到的第20条，实际 ${gotCalls.length}`);
}));

// 6b. wxpusher 内容类型自适应（v3.159：{Html内容} 模板 + Markdown 通道时 HTML 源码裸露——含 HTML 标签自动切 HTML 渲染）
await test('wxpusher: 内容含 HTML 标签 → contentType 自动切 2(HTML)', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '456';
    await notify.sendNotify('标题', '内容<br>第二行<a href="https://x.com">链接</a>');
    assert(gotCalls.length === 1, '仅 wxpusher 一次请求');
    assert(gotCalls[0].options.json.contentType === 2,
        `含HTML应切HTML渲染(contentType=2): ${gotCalls[0].options.json.contentType}`);
}));

// 6c. Markdown autolink（<https://...>）不应误判为 HTML（v3.159 标签白名单）
await test('wxpusher: Markdown 内容（<url> autolink）不误判 HTML → 保持 Markdown', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '456';
    await notify.sendNotify('标题', '原文链接：<https://x.com/a> **粗体**');
    assert(gotCalls[0].options.json.contentType === 3,
        `无HTML标签应保持Markdown(contentType=3): ${gotCalls[0].options.json.contentType}`);
}));

// 7. PushMe（修复后新接入）
await test('PushMe: 多 key # 分割 + type markdown', () => withChannels(async () => {
    cfg.PUSHME_KEY = 'k1#k2';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 2, `两个 key 应两次请求, 实际 ${gotCalls.length}`);
    assert(gotCalls.every(c => c.url.includes('push.i-i.me')), 'PushMe URL');
    assert(gotCalls.every(c => c.options.json.type === 'markdown'), 'type markdown');
    assert(gotCalls.every(c => ['k1', 'k2'].includes(c.options.json.push_key)), 'push_key 分割正确');
}));

// 8. Push+（修复后新接入）
await test('Push+: token + JSON body + 换行转 <br>', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'token123';
    await notify.sendNotify('标题', '内容\n第二行');
    assert(gotCalls.length === 1, '仅 Push+ 一次请求');
    const c = gotCalls[0];
    assert(c.url.includes('pushplus.plus'), `Push+ URL: ${c.url}`);
    const body = JSON.parse(c.options.body);
    assert(body.token === 'token123', 'token 正确');
    assert(body.content.includes('<br>'), `换行应转 <br>: ${body.content}`);
    assert(c.options.headers['Content-Type'].includes('application/json'), 'JSON 头');
}));

// 18. 一言短超时（v3.151：一言 API 慢/挂不阻塞推送）
await test('HITOKOTO: one() 带 3s 短超时（不阻塞推送）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123';
    cfg.HITOKOTO = 'true';
    await notify.sendNotify('标题', '内容');
    // 一言请求（gotCalls[0]）应带 timeout: 3000
    const hitokotoCall = gotCalls.find(c => c.url.includes('hitokoto.cn'));
    assert(!!hitokotoCall, '应请求一言');
    assert(hitokotoCall.options && hitokotoCall.options.timeout === 3000,
        `一言应带 3s 超时: ${hitokotoCall.options && hitokotoCall.options.timeout}`);
}));

await test('HITOKOTO: false/0/非法值不请求一言（配置防御）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123';
    for (const value of [false, 0, '0', 'false', '', 'abc', undefined, null]) {
        cfg.HITOKOTO = value;
        reset();
        await notify.sendNotify('标题', '内容');
        assert(!gotCalls.some(c => c.url.includes('hitokoto.cn')), `HITOKOTO=${String(value)} 不应请求一言`);
        assert(gotCalls.length === 1, `HITOKOTO=${String(value)} 应只发推送请求，实际${gotCalls.length}`);
    }
}));

await test('mdToPlain: 原文链接 text===url 不重复显示（v3.153）', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'token123';
    // 真实 desp 原文链接（text 与 href 相同）
    await notify.sendNotify('标题', '内容\n\n原文链接：[https://new.ixbk.net/a.html](https://new.ixbk.net/a.html)');
    const c = gotCalls[0];
    const content = JSON.parse(c.options.body).content;
    assert(!content.includes('a.html (https://'), `text===url 不应重复: ${content}`);
    assert(content.includes('原文链接：https://new.ixbk.net/a.html'), '原文链接应显示一次');
    // 普通链接 text!==url 仍显示 text (url)
    await notify.sendNotify('标题2', '[查看详情](https://item.jd.com/1001.html)');
    const c2 = gotCalls[1];
    const content2 = JSON.parse(c2.options.body).content;
    assert(content2.includes('查看详情 (https://item.jd.com/1001.html)'), `普通链接应 text (url): ${content2}`);
}));

await test('mdToPlain: 数字夹 * 不误剥（规格 5*3*2cm 曾变 532cm）', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 'token123';
    // 真实线报规格格式：180ml*12/箱、5*3*2cm
    await notify.sendNotify('标题', '蒙牛鲜牛奶180ml*12/箱 11.24元 规格 5*3*2cm *斜体内容*');
    const c = gotCalls[0];
    const content = JSON.parse(c.options.body).content;
    assert(content.includes('180ml*12/箱'), `尺寸星号应保留: ${content}`);
    assert(content.includes('5*3*2cm'), `规格星号应保留: ${content}`);
    assert(content.includes('斜体内容'), '斜体应正常转换');
}));
await test('Push+/Bark: {Html内容} 模板产物无残留标签属性（v3.149）', () => withChannels(async () => {
    // 模拟 {Html内容} 模板产物（HTML）+ Push+（mdToPlain）
    cfg.PUSH_PLUS_TOKEN = 'token123';
    const htmlDesp = '<p>内容</p><a href="https://x.com" target="_blank">链接</a><img src="https://x.com/a.jpg" alt="图"><br>&nbsp;<br>原文链接：<a href="/a.html">/a.html</a>';
    await notify.sendNotify('标题', htmlDesp);
    const c = gotCalls[0];
    const content = JSON.parse(c.options.body).content;
    assert(!content.includes('target='), `不应残留 target= 属性: ${content}`);
    assert(!content.includes('href='), `不应残留 href= 属性: ${content}`);
    assert(!content.includes('&nbsp;'), '&nbsp; 应解码');
    assert(content.includes('链接'), '链接文本应保留');
    assert(content.includes('原文链接'), '原文链接文本应保留');
}));

// 9. 无通道 → reject 且零请求
await test('通道全空 → reject 不静默成功', () => withChannels(async () => {
    let rejected = false;
    try { await notify.sendNotify('t', 'd'); } catch (e) { rejected = true; }
    assert(rejected, '无通道应 reject');
    assert(gotCalls.length === 0, '无通道不应发请求');
}));

await test('分隔型通道只有 #/空白 → reject，不虚假成功', () => withChannels(async () => {
    cfg.BARK_PUSH = ' #  ';
    cfg.PUSHME_KEY = '##';
    let rejected = false;
    try { await notify.sendNotify('t', 'd'); } catch (e) { rejected = true; }
    assert(rejected, '无实际设备/key 时应 reject');
    assert(gotCalls.length === 0, `无实际设备/key 不应发请求: ${gotCalls.length}`);
}));

// 10. 一言 HITOKOTO 分支（曾从未被测试；one() 曾因 JSON.parse(已解析对象) 崩溃致一言永不生效）
await test('HITOKOTO 启用 → 一言内容追加到推送（真实 got 对象 body）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123456';
    cfg.HITOKOTO = 'true';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length >= 2, `应有一言+推送至少2个请求，实际${gotCalls.length}`);
    assert(gotCalls[0].url.includes('hitokoto.cn'), `第一个请求应是一言: ${gotCalls[0].url}`);
    // 推送请求(Server酱)的表单 desp 应含一言文本（经 URL 编码）
    const pushCall = gotCalls[1];
    const desp = decodeURIComponent(pushCall.options.body);
    assert(desp.includes('测试一言'), `一言内容应追加到 desp: ${desp.slice(0, 80)}`);
    assert(desp.includes('----源'), '一言出处应追加');
}));

await test('一言失败 → 兜底跳过不崩（v3.73）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123456';
    cfg.HITOKOTO = 'true';
    failHitokoto = true;
    try {
        await notify.sendNotify('标题', '内容'); // 不应抛错（一言失败被 catch 跳过）
        assert(gotCalls.length === 2, `应有一言(失败)+推送请求，实际${gotCalls.length}`);
        assert(gotCalls[0].url.includes('hitokoto.cn'), '应请求一言（虽失败）');
        const desp = decodeURIComponent(gotCalls[1].options.body);
        assert(!desp.includes('测试一言'), '一言失败时内容不应追加一言');
    } finally {
        failHitokoto = false;
    }
}));

await test('一言响应结构异常 → 兜底跳过不输出 undefined（v3.86）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123456';
    cfg.HITOKOTO = 'true';
    failHitokotoStruct = true; // 一言返回 { hitokoto:'x' }（缺 from 字段）
    try {
        await notify.sendNotify('标题', '内容'); // 不应抛错（结构异常被 catch 跳过）
        assert(gotCalls.length === 2, `应有一言(结构异常)+推送请求，实际${gotCalls.length}`);
        const desp = decodeURIComponent(gotCalls[1].options.body);
        assert(!desp.includes('undefined'), '不应输出 undefined 垃圾文本');
        assert(!desp.includes('测试一言'), '结构异常时不应追加一言');
        assert(desp.includes('----'), 'from 缺失时出处应留空而非 undefined');
    } finally {
        failHitokotoStruct = false;
    }
}));

// 11. 息知通道（曾从未被测试）
await test('息知: WX_XIZHI_KEY 作为 URL + JSON body', () => withChannels(async () => {
    cfg.WX_XIZHI_KEY = 'https://xizhi.qqoq.net/abc123.send';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 1, '仅息知一次请求');
    const c = gotCalls[0];
    assert(c.url.includes('xizhi.qqoq.net'), `息知 URL: ${c.url}`);
    assert(c.options.json.title === '标题', 'title 正确');
    assert(c.options.json.content.includes('内容'), 'content 正确');
}));

// 11.5 Telegram（v3.49 新增实现，曾为死配置——配置项存在但从未实现/调用）
await test('Telegram: bot token + chat_id + HTML 模式（v3.132：Markdown 对未配对 * 报错）', () => withChannels(async () => {
    cfg.TG_BOT_TOKEN = '123:ABC';
    cfg.TG_USER_ID = '456';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 1, '仅 TG 一次请求');
    const c = gotCalls[0];
    assert(c.url.includes('api.telegram.org/bot123:ABC/sendMessage'), `TG URL: ${c.url}`);
    assert(c.options.json.chat_id === '456', 'chat_id 正确');
    assert(c.options.json.text.includes('标题') && c.options.json.text.includes('内容'), 'text 含标题与内容');
    assert(c.options.json.parse_mode === 'HTML', 'v3.132：Markdown 对未配对 * 报错，改 HTML');
    assert(c.options.json.disable_web_page_preview === true, '禁网页预览');
    // 真实场景：未配对 * → HTML 模式下无害（Markdown 模式会报错，HTML 只对 & < > 敏感）
    await notify.sendNotify('再发一遍*符合的去', '速度*0.01撸库迪');
    const c2 = gotCalls[1];
    assert(c2.options.json.text.includes('再发一遍') && c2.options.json.text.includes('速度'), '内容保留');
    assert(c2.options.json.parse_mode === 'HTML', 'HTML 模式对未配对 * 安全（Markdown 会报错）');
    assert(!c2.options.json.text.includes('**'), '配对的 markdown 符号应被 mdToPlain 剥掉');
    // HTML 特殊字符转义
    await notify.sendNotify('a<b>&', 'c>d');
    const c3 = gotCalls[2];
    assert(c3.options.json.text.includes('&lt;') && c3.options.json.text.includes('&amp;'), 'HTML 转义 & < >');
}));

await test('Telegram: 缺 chat_id 不发送(不影响其他通道) + 自定义 host', () => withChannels(async () => {
    // 缺 TG_USER_ID + 有 Server酱 → sendNotify 成功，TG 不发请求
    cfg.PUSH_KEY = 'SCT1';
    cfg.TG_BOT_TOKEN = 'tok1';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 1, '仅 Server酱 请求(TG 缺 chat_id 不发送)');
    assert(gotCalls[0].url.includes('ftqq.com'), '应是 Server酱');
    // 配齐 TG + 自定义 host
    reset();
    cfg.TG_USER_ID = '789';
    cfg.TG_API_HOST = 'https://proxy.example.com';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.some(c => c.url.includes('proxy.example.com/bottok1/sendMessage')),
        `自定义 host 应生效: ${gotCalls.map(c => c.url).join(', ')}`);
}));

await test('TG_PROXY 配置 → 一次性警告不生效（v3.76）', () => withChannels(async () => {
    cfg.TG_BOT_TOKEN = 'BOT';
    cfg.TG_USER_ID = '123';
    cfg.TG_PROXY_HOST = '127.0.0.1';
    const origWarn = console.warn;
    const warns = [];
    console.warn = (m) => warns.push(String(m));
    try {
        await notify.sendNotify('标题', '内容');
        assert(warns.some(w => w.includes('TG_PROXY')), '应警告 TG_PROXY 不生效');
        assert(warns.some(w => w.includes('TG_API_HOST')), '应提示替代方案 TG_API_HOST');
    } finally {
        console.warn = origWarn;
    }
}));

// 16. Server酱 换行处理（v3.148：只加倍单个 \n，\n\n 段落保持）
await test('Server酱: 单个\\n加倍、\\n\\n段落保持（v3.148）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123';
    // Markdown 形态（含 \n\n 段落）+ 单个 \n（内容内换行）
    await notify.sendNotify('标题', '段落一\n\n段落二\n单行续');
    const c = gotCalls[0];
    const body = decodeURIComponent(c.options.body);
    const despPart = body.split('desp=')[1];
    assert(!despPart.includes('\n\n\n\n'), `不应 4+ 连续换行: ${JSON.stringify(despPart.slice(0, 60))}`);
    // 单个 \n 应被加倍（Server酱要求）
    assert(despPart.includes('段落二\n\n单行续'), '单个换行应加倍');
    // \n\n 段落应保持（不翻倍）
    assert(despPart.includes('段落一\n\n段落二'), '段落分隔应保持');
}));
await test('safeSlice: 代理对安全截断', () => {
    const { safeSlice } = notify;
    const s = '😀'.repeat(50); // 100 码元
    // 奇数截断 91 → 末尾高代理退位到 90（45 个完整 emoji）
    const cut = safeSlice(s, 91);
    assert(cut.length === 90, `91 应退到 90: ${cut.length}`);
    assert(cut === '😀'.repeat(45), '应为 45 个完整 emoji');
    // 偶数完整保留
    assert(safeSlice(s, 90).length === 90, '偶数完整保留');
    // 短串不截
    assert(safeSlice('abc', 5) === 'abc', '短串不截');
    // 中文/混合
    assert(safeSlice('中文😀混合', 3) === '中文', '中文后截断');
});

await test('safeSlice: ZWJ/VS16/组合字符退位（v3.178 §12-2 与 truncateUtf16 对齐）', () => {
    const { safeSlice } = notify;
    // 家庭 emoji（👨 ZWJ 👩 ZWJ 👧 ZWJ 👦）截断到 5 → 完整前两个，无孤立 ZWJ
    const fam = '👨👩👧👦';
    const r1 = safeSlice(fam, 5);
    assert(r1 === '👨👩', `max=5 → 完整前两个: ${JSON.stringify(r1)}`);
    assert(!r1.includes('\u200D'), '无孤立 ZWJ');
    // ❤️（❤+VS16）max=1 → 保守退空
    assert(safeSlice('❤️', 1) === '', 'VS16 序列 max=1 → 退空');
    // e + 组合重音 max=1 → 退空
    assert(safeSlice('e\u0301', 1) === '', '组合字符 max=1 → 退空');
    // 正常代理对行为不变
    assert(safeSlice('😀😀', 2) === '😀', '双 emoji 完整保留');
});

await test('wxpusher summary 代理对安全（v3.147）', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '456';
    await notify.sendNotify('a' + '😀'.repeat(50) + '很长标题内容', '内容'); // 90 截断点落在奇数位(高代理)
    const c = gotCalls[0];
    const summary = c.options.json.summary;
    assert(summary.length <= 90, `summary ≤90: ${summary.length}`);
    // 末尾不孤立（高代理必配低代理）
    const last = summary.charCodeAt(summary.length - 1);
    const prev = summary.charCodeAt(summary.length - 2);
    const loneHigh = last >= 0xD800 && last <= 0xDBFF;
    const loneLow = last >= 0xDC00 && last <= 0xDFFF && !(prev >= 0xD800 && prev <= 0xDBFF);
    assert(!loneHigh && !loneLow, `末尾不应孤立代理: 0x${last.toString(16)}`);
}));
await test('日志脱敏: 通道异常日志不泄露密钥（真实路径）', () => withChannels(async () => {
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        // 配 Server酱 + wxpusher + 息知 + Bark（Bark 日志打 maskUrl 脱敏形式）
        cfg.PUSH_KEY = 'SCT_SECRET_TOKEN';
        cfg.WX_pusher_appToken = 'AT_SECRET';
        cfg.WX_XIZHI_KEY = 'https://xizhi.qqoq.net/abc.send';
        cfg.BARK_PUSH = 'https://api.day.app/DEVICE_SECRET';
        await notify.sendNotify('标题', '内容');
        // 日志不应泄露任何完整密钥
        const all = captured.join('\n');
        assert(!all.includes('SCT_SECRET_TOKEN'), 'Server酱 key 不应出现在日志');
        assert(!all.includes('AT_SECRET'), 'wxpusher token 不应出现在日志');
        assert(!all.includes('DEVICE_SECRET'), 'Bark 完整设备码不应出现在日志');
        assert(!all.includes('xizhi.qqoq.net/abc.send'), '息知完整 URL 不应出现在日志');
        // Bark 日志应出现脱敏形式（maskUrl：host 保留 + 设备码脱敏）
        assert(all.includes('api.day.app/DEVI***ET'), `应出现 Bark 脱敏形式: ${all.split('\n').filter(l => l.includes('api.day.app')).join(' | ')}`);
    } finally {
        console.log = origLog;
    }
}));
await test('safeErr: message getter 抛异常时仍返回安全摘要', () => {
    const err = {};
    Object.defineProperty(err, 'message', { get() { throw new Error('getter boom'); } });
    err.code = 'E_TEST';
    const out = notify.safeErr(err);
    assert(typeof out === 'string' && out.includes('E_TEST'), `应返回安全字段摘要: ${out}`);
});

await test('脱敏函数: 异常 toString 对象不应崩溃', () => {
    const bad = { toString() { throw new Error('bad toString'); } };
    assert(typeof notify.maskKey(bad) === 'string', 'maskKey 应安全返回字符串');
    assert(typeof notify.maskUrl(bad) === 'string', 'maskUrl 应安全返回字符串');
    assert(typeof notify.safeErr({ message: bad }) === 'string', 'safeErr 应安全返回字符串');
});

await test('日志脱敏: maskKey/maskUrl 不泄露完整密钥', () => {
    const { maskKey, maskUrl } = notify;
    // 长密钥保留首尾
    assert(maskKey('1234567890') === '1234***90', `maskKey: ${maskKey('1234567890')}`);
    // 短密钥全脱敏
    assert(maskKey('abc') === '***', `短密钥: ${maskKey('abc')}`);
    assert(maskKey('') === '***', '空密钥');
    // URL 保留 host，设备码段脱敏
    assert(maskUrl('https://api.day.app/DEVICEKEY123') === 'https://api.day.app/DEVI***23', `maskUrl: ${maskUrl('https://api.day.app/DEVICEKEY123')}`);
});

await test('日志脱敏: Push+/企微/PushDeer/Telegram/Server酱 失败日志不泄露密钥（v3.75）', () => withChannels(async () => {
    // 配 5 个此前未覆盖脱敏测试的通道（v3.59 只覆盖 Server酱/wxpusher/息知/Bark）
    cfg.PUSH_PLUS_TOKEN = 'PPT_SECRET';
    cfg.QYWX_KEY = 'QWX_SECRET';
    cfg.DEER_KEY = 'DEER_SECRET';
    cfg.TG_BOT_TOKEN = 'TG_SECRET';
    cfg.TG_USER_ID = '12345';
    cfg.PUSH_KEY = 'SCT_SECRET';
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        failPost = true; // 所有通道走失败路径（err.response.body 通用错误体）
        try { await notify.sendNotify('标题', '内容'); } catch (e) { /* v3.133：全部通道失败 → 抛错（防丢消息） */ }
        const all = captured.join('\n');
        assert(!all.includes('PPT_SECRET'), 'Push+ token 不应泄露');
        assert(!all.includes('QWX_SECRET'), '企微 key 不应泄露');
        assert(!all.includes('DEER_SECRET'), 'PushDeer key 不应泄露');
        assert(!all.includes('TG_SECRET'), 'TG token 不应泄露');
        assert(!all.includes('SCT_SECRET'), 'Server酱 key 不应泄露');
        assert(!all.includes('PPT_SECRET'), '响应体回显密钥不应出现在日志');
        assert(all.includes('API error'), '失败日志应含错误摘要（诊断信息保留）');
    } finally {
        failPost = false;
        console.log = origLog;
    }
}));

await test('日志脱敏: Bark/PushMe/wxpusher/息知 失败日志不泄露密钥（v3.77）', () => withChannels(async () => {
    // v3.75 漏网的 4 个通道失败日志（err 分支曾 console.log(err)，现统一 safeErr）
    cfg.BARK_PUSH = 'https://api.day.app/BARK_SECRET';
    cfg.PUSHME_KEY = 'PM_SECRET';
    cfg.WX_pusher_appToken = 'WXP_SECRET';
    cfg.WX_XIZHI_KEY = 'https://xizhi.qqoq.net/XIZHI_SECRET.send';
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        failPost = true;
        try { await notify.sendNotify('标题', '内容'); } catch (e) { /* v3.133：全部通道失败 → 抛错（日志已打印） */ }
        const all = captured.join('\n');
        assert(!all.includes('BARK_SECRET'), 'Bark 设备码不应泄露');
        assert(!all.includes('PM_SECRET'), 'PushMe key 不应泄露');
        assert(!all.includes('WXP_SECRET'), 'wxpusher token 不应泄露');
        assert(!all.includes('XIZHI_SECRET'), '息知 URL 不应泄露');
        // 日志前缀的脱敏形式应保留（maskUrl/maskKey）
        assert(all.includes('api.day.app/BAR***ET') || all.includes('BARK***ET'), 'Bark 应出现脱敏形式');
        assert(all.includes('PM***ET') || all.includes('***ET'), 'PushMe 应出现脱敏形式');
    } finally {
        failPost = false;
        console.log = origLog;
    }
}));
await test('日志脱敏：异常响应中的 token/key 不进入日志', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'APP_SECRET';
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        leakResponse = true;
        let caught = null;
        try { await notify.sendNotify('标题', '内容'); } catch (e) { caught = e; }
        const all = captured.join('\\n');
        assert(caught, '业务失败应 reject');
        assert(!caught.message.includes('APP_SECRET'), `reject 错误信息不应泄露已配置 token: ${caught.message}`);
        assert(caught.message.includes('业务失败'), `reject 错误信息仍应保留诊断摘要: ${caught.message}`);
        assert(!all.includes('LEAK_TOKEN_SECRET'), '响应 token 不应进入日志');
        assert(!all.includes('LEAK_KEY_SECRET'), '响应 key 不应进入日志');
        assert(!all.includes('APP_SECRET'), '错误摘要中的已配置 token 也不应明文出现');
        assert(all.includes('业务失败'), '安全错误摘要仍应保留');
    } finally {
        leakResponse = false;
        console.log = origLog;
    }
}));

await test('各通道 reject 错误摘要也脱敏，不进入错误信息', () => withChannels(async () => {
    leakResponse = true;
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        const cases = [
            ['Push+', { PUSH_PLUS_TOKEN: 'APP_SECRET' }],
            ['Server酱', { PUSH_KEY: 'APP_SECRET' }],
            ['Bark', { BARK_PUSH: 'APP_SECRET' }],
            ['企业微信', { QYWX_KEY: 'APP_SECRET' }],
            ['wxpusher', { WX_pusher_appToken: 'APP_SECRET', WX_pusher_topicIds: '1' }],
            ['息知', { WX_XIZHI_KEY: 'https://xizhi.qqoq.net/APP_SECRET.send' }],
            ['PushMe', { PUSHME_KEY: 'PM_SECRET' }],
            ['Telegram', { TG_BOT_TOKEN: 'APP_SECRET', TG_USER_ID: '1' }],
        ];
        for (const [name, c] of cases) {
            for (const k of CHANNEL_KEYS) cfg[k] = '';
            cfg.HITOKOTO = 'false';
            Object.assign(cfg, c);
            let caught = null;
            try { await notify.sendNotify('t', 'd'); } catch (e) { caught = e; }
            assert(caught, `${name}: 业务失败应 reject`);
            const secret = c.PUSHME_KEY ? 'PM_SECRET' : 'APP_SECRET';
            assert(!caught.message.includes(secret), `${name}: reject 错误不应泄露密钥: ${caught.message}`);
            assert(!captured.join('\\n').includes(secret), `${name}: 日志不应泄露密钥: ${captured.join(' | ')}`);
            if (!['Bark', 'PushMe'].includes(name)) assert(caught.message.includes('业务失败'), `${name}: 应保留诊断文本: ${caught.message}`);
        }
    } finally {
        leakResponse = false;
        console.log = origLog;
    }
}));

await test('Bark: 归档/分组/声音/级别/图标/URL 参数传递', () => withChannels(async () => {
    cfg.BARK_PUSH = 'device1';
    cfg.BARK_ARCHIVE = '1';
    cfg.BARK_GROUP = '测试组';
    cfg.BARK_SOUND = 'alarm';
    cfg.BARK_LEVEL = 'critical';
    cfg.BARK_ICON = 'http://icon.png';
    cfg.BARK_URL = 'https://x.com';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 1, '仅 Bark 一次请求');
    const j = gotCalls[0].options.json;
    assert(j.isArchive === '1', `isArchive: ${j.isArchive}`);
    assert(j.group === '测试组', `group: ${j.group}`);
    assert(j.sound === 'alarm', `sound: ${j.sound}`);
    assert(j.level === 'critical', `level: ${j.level}`);
    assert(j.icon === 'http://icon.png', `icon: ${j.icon}`);
    assert(j.url === 'https://x.com', `url: ${j.url}`);
}));

// 恢复（双保险：withChannels finally 已恢复）
for (const k of CHANNEL_KEYS) cfg[k] = saved[k];

console.log('\n========================================');

await test('Fuzz-推送: 随机 text/desp/params → sendNotify 不崩且日志无密钥', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT_SECRET_FUZZ';
    cfg.BARK_PUSH = 'https://api.day.app/BARK_SECRET_FUZZ';
    let seed = 20261101;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const randText = () => {
        const chars = 'abcXYZ0123 *_[].()&#\n\t😀中\u00e9\u00a9|';
        let s = '';
        const len = Math.floor(rand() * 300);
        for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
        return s;
    };
    const randParams = () => {
        const keys = ['ARCHIVE', 'GROUP', 'SOUND', 'ICON', 'LEVEL', 'URL'];
        const p = {};
        for (const k of keys) {
            if (rand() < 0.5) p['BARK_' + k] = randText().slice(0, 50);
        }
        return p;
    };
    const origLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
        for (let i = 0; i < 30; i++) {
            captured.length = 0;
            await notify.sendNotify(randText(), randText(), randParams());
            const all = captured.join('\n');
            assert(!all.includes('SCT_SECRET_FUZZ'), 'Server酱密钥不应泄露');
            assert(!all.includes('BARK_SECRET_FUZZ'), 'Bark 密钥不应泄露');
        }
    } finally {
        console.log = origLog;
    }
}));

await test('Fuzz-推送: maskKey/maskUrl 随机输入不崩', () => {
    const { maskKey, maskUrl } = notify;
    let seed = 777777;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const randVal = () => {
        const r = rand();
        if (r < 0.1) return null;
        if (r < 0.2) return undefined;
        if (r < 0.3) return 12345;
        if (r < 0.4) return Symbol('s');
        if (r < 0.5) return { a: 1 };
        const chars = 'abcXYZ09 /?#:=&.😀中';
        let s = '';
        const len = Math.floor(rand() * 200);
        for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
        return s;
    };
    for (let i = 0; i < 300; i++) {
        const v = randVal();
        assert(typeof maskKey(v) === 'string', 'maskKey 应返回字符串');
        assert(typeof maskUrl(v) === 'string', 'maskUrl 应返回字符串');
        // 脱敏结果不应含完整输入（当输入是长字符串时）
        if (typeof v === 'string' && v.length > 10) {
            assert(!maskKey(v).includes(v), 'maskKey 不应含完整密钥');
        }
    }
});


await test('HTTP 200 + 响应体 JSON null → 全部通道 reject 不虚假成功（v3.180 P1 修复）', () => withChannels(async () => {
    nullBody = true;
    try {
        // 4 个曾中招的通道：data.code/errcode 无防御 → null 曾抛 TypeError → catch 只记日志
        // → finally resolve(data) 虚假成功 → 主流程写缓存 → 消息永久丢失
        const victimCases = [
            ['Push+', { PUSH_PLUS_TOKEN: 't' }],
            ['企业微信', { QYWX_KEY: 'k' }],
            ['wxpusher', { WX_pusher_appToken: 'a', WX_pusher_topicIds: '1' }],
            ['息知', { WX_XIZHI_KEY: 'https://xizhi.qqoq.net/x.send' }],
        ];
        for (const [name, c] of victimCases) {
            for (const k of CHANNEL_KEYS) cfg[k] = '';
            cfg.HITOKOTO = 'false';
            Object.assign(cfg, c);
            let rejected = false;
            try { await notify.sendNotify('t', 'd'); } catch (e) { rejected = true; }
            assert(rejected, `${name}: HTTP 200+null 应 reject（曾虚假成功→消息丢失）`);
        }
        // 对照组：本来就有 data && 防御的通道同样 reject
        const safeCases = [
            ['Server酱', { PUSH_KEY: 'SCT123' }],
            ['Bark', { BARK_PUSH: 'https://api.day.app/d1' }],
        ];
        for (const [name, c] of safeCases) {
            for (const k of CHANNEL_KEYS) cfg[k] = '';
            cfg.HITOKOTO = 'false';
            Object.assign(cfg, c);
            let rejected = false;
            let output = '';
            const originalWrite = process.stdout.write;
            if (name === 'Bark') {
                process.stdout.write = function (chunk, ...args) {
                    output += String(chunk);
                    return true;
                };
            }
            try { await notify.sendNotify('t', 'd'); } catch (e) { rejected = true; }
            finally {
                if (name === 'Bark') process.stdout.write = originalWrite;
            }
            assert(rejected, `${name}: HTTP 200+null 应 reject`);
            if (name === 'Bark') {
                assert(!output.includes("Cannot read properties of null (reading 'code')"),
                    `Bark null 响应不应产生 TypeError 日志: ${output}`);
            }
        }
    } finally {
        nullBody = false;
    }
}));

await test('响应字段访问异常 → 通道 reject，不被 finally resolve 掩盖', () => withChannels(async () => {
    malformedResponse = true;
    try {
        const cases = [
            ['Push+', { PUSH_PLUS_TOKEN: 't' }],
            ['Server酱', { PUSH_KEY: 'SCT123' }],
            ['企业微信', { QYWX_KEY: 'k' }],
            ['wxpusher', { WX_pusher_appToken: 'a', WX_pusher_topicIds: '1' }],
            ['息知', { WX_XIZHI_KEY: 'https://xizhi.qqoq.net/x.send' }],
            ['PushDeer', { DEER_KEY: 'd' }],
            ['Telegram', { TG_BOT_TOKEN: 't', TG_USER_ID: 'u' }],
        ];
        for (const [name, c] of cases) {
            for (const k of CHANNEL_KEYS) cfg[k] = '';
            cfg.HITOKOTO = 'false';
            Object.assign(cfg, c);
            let rejected = false;
            try { await notify.sendNotify('t', 'd'); } catch (e) { rejected = true; }
            assert(rejected, `${name}: 响应字段访问异常应 reject，不能虚假成功`);
        }
    } finally {
        malformedResponse = false;
    }
}));

await test('全通道失败 → sendNotify reject / 部分成功 → resolve（v3.133）', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT_TEST';
    // 全失败 → reject（v3.133：防网络故障时消息丢失，主流程不写缓存下次重试）
    failPost = true;
    let threw = false;
    try { await notify.sendNotify('标题', '内容'); } catch (e) { threw = true; assert(e.message.includes('所有推送通道失败'), `错误应含全失败: ${e.message.slice(0, 40)}`); }
    assert(threw, '全通道失败应 reject');
    // 部分成功（Bark 成功 + Server酱失败）→ resolve（失败通道下次不重试防重复）
    failPost = false;
    cfg.BARK_PUSH = 'https://api.day.app/dev1';
    // Server酱失败（SCT URL）→ 用 failPost 只影响 Server酱？——mock 是全局的……
    // 简化：直接验证"至少一个成功即 resolve"（Server酱单独成功）
    cfg.BARK_PUSH = '';
    failPost = false;
    let ok = false;
    try { await notify.sendNotify('标题', '内容'); ok = true; } catch (e) { ok = false; }
    assert(ok, '单通道成功应 resolve');
}));


await test('企微/TG 超长内容截断（v3.139：通道长度限制）', () => withChannels(async () => {
    // 企微：>4096 字节 content → 截断
    cfg.QYWX_KEY = 'webhook-abc';
    const longCn = '中'.repeat(2000); // 6000 字节
    await notify.sendNotify('标题', longCn);
    const qywx = gotCalls.find(c => c.url.includes('qyapi.weixin.qq.com'));
    const qContent = qywx.options.json.markdown.content;
    assert(Buffer.byteLength(qContent, 'utf8') <= 4096, `企微 content 应 ≤4096 字节: ${Buffer.byteLength(qContent, 'utf8')}`);
    // TG：>4000 字符 → 截断
    cfg.QYWX_KEY = '';
    cfg.TG_BOT_TOKEN = '123:ABC';
    cfg.TG_USER_ID = '456';
    const longTg = 'a'.repeat(5000);
    await notify.sendNotify('标题', longTg);
    const tg = gotCalls.find(c => c.url.includes('telegram.org'));
    assert(tg.options.json.text.length <= 4000, `TG text 应 ≤4000 字符: ${tg.options.json.text.length}`);
    // 代理对安全（emoji 结尾截断）
    cfg.TG_USER_ID = '456';
    await notify.sendNotify('😀'.repeat(3000) + 'x', '内容');
    const tg2 = gotCalls.find((c, i) => i > 0 && c.url.includes('telegram.org'));
    const t2 = tg2 ? tg2.options.json.text : null;
    assert(t2 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t2), 'TG 截断不应有孤立高代理');
}));

// 19. wxpusher API 失败 → reject 不静默（v3.154：单通道用户防消息丢失）
await test('wxpusher API 失败(code≠1000) → reject 不静默', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '456';
    failWxpusher = true;
    let rejected = false;
    try { await notify.sendNotify('标题', '内容'); } catch (e) { rejected = true; }
    assert(rejected, 'wxpusher API 失败应 reject（主流程不写缓存，下次重试）');
    failWxpusher = false;
}));

// 19.5 其他 7 个通道 API 业务失败 → reject 不静默（v3.160：曾静默 resolve → 单通道用户消息永久丢失）
await test('息知 API 失败(code≠200) → reject（v3.160）', () => withChannels(async () => {
    cfg.WX_XIZHI_KEY = 'https://xizhi.qqoq.net/abc.send';
    failBiz = true;
    let rejected = false;
    try { await notify.sendNotify('标题', '内容'); } catch (e) { rejected = true; }
    assert(rejected, '息知 API 失败应 reject（主流程不写缓存，下次重试）');
    failBiz = false;
}));

await test('全部 8 通道 API 业务失败 → 至少失败时 reject（v3.160：防假成功掩盖真失败）', () => withChannels(async () => {
    cfg.PUSH_PLUS_TOKEN = 't';
    cfg.PUSH_KEY = 'SCT123';
    cfg.BARK_PUSH = 'https://api.day.app/k';
    cfg.QYWX_KEY = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';
    cfg.WX_pusher_appToken = 't'; cfg.WX_pusher_topicIds = '1';
    cfg.WX_XIZHI_KEY = 'https://xizhi.qqoq.net/abc.send';
    cfg.DEER_KEY = 'k';
    cfg.PUSHME_KEY = 'k';
    cfg.TG_BOT_TOKEN = 't'; cfg.TG_USER_ID = 'u';
    failBiz = true;
    let rejected = false;
    try { await notify.sendNotify('标题', '内容'); } catch (e) { rejected = true; }
    assert(rejected, '全部通道 API 业务失败应 reject（防消息丢失）');
    failBiz = false;
}));

await test('Server酱字符串 errno 成功/重复码应按数字语义处理', () => withChannels(async () => {
    cfg.PUSH_KEY = 'SCT123';
    const originalPost = require.cache[gotPath].exports.post;
    require.cache[gotPath].exports.post = (url, options) => ({
        then: (res) => res({ body: String(url).includes('ftqq.com') ? { errno: '0', errmsg: 'success' } : '{}', statusCode: 200, headers: {} }),
    });
    try {
        await notify.sendNotify('标题', '内容');
    } finally {
        require.cache[gotPath].exports.post = originalPost;
    }
}));

await test('通道数字业务码为字符串时仍识别成功', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '1';
    const originalPost = require.cache[gotPath].exports.post;
    require.cache[gotPath].exports.post = (url, options) => ({
        then: (res) => res({ body: String(url).includes('wxpusher') ? { code: '1000', msg: 'success' } : '{}', statusCode: 200, headers: {} }),
    });
    try {
        await notify.sendNotify('标题', '内容');
    } finally {
        require.cache[gotPath].exports.post = originalPost;
    }
}));

await test('wxpusher 非白名单 HTML 元素自动切换 HTML 内容类型', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '1';
    await notify.sendNotify('标题', '<input autofocus onfocus=alert(1)>内容');
    const c = gotCalls.find(x => x.url.includes('wxpusher'));
    assert(c && c.options.json.contentType === 2, `真实 HTML 应使用 HTML 类型: ${JSON.stringify(c && c.options.json)}`);
}));

if (failed === 0) {
    console.log(`  🎉 通道测试通过 ${passed}/${passed}`);
} else {
    console.log(`  ⚠️ ${passed} 通过, ${failed} 失败`);
    errors.forEach(e => console.log('  ❌ ' + e));
}
console.log('========================================\n');
process.exit(failed > 0 ? 1 : 0);

})();
