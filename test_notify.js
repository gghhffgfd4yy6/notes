'use strict';
// 推送通道适配器测试：mock got 验证各通道的 URL/body/headers 构造
// 独立文件：需在 require notify 前替换 got(模块加载时引用固定)
//
// 框架说明（曾踩坑）：
// - test() 必须是 async 并 await fn()，否则 async 断言的失败会变成 unhandled rejection 而不被统计
// - 每个测试用 withChannels 清空全部通道再只配被测通道，避免本地密钥(push_config.local.js)
//   与上一个测试残留的通道配置污染 gotCalls / 断言

const gotPath = require.resolve('/workspace/node_modules/got/index.js');
require('/workspace/node_modules/got/index.js');

let gotCalls = [];
require.cache[gotPath].exports = (url, options) => {
    gotCalls.push({ url, options });
    // 一言接口返回对象 body（模拟真实 got 自动 JSON 解析），其余返回字符串
    const body = String(url).includes('hitokoto.cn') ? { hitokoto: '测试一言', from: '源' } : '{}';
    return { then: (res) => res({ body, statusCode: 200, headers: {} }) };
};
require.cache[gotPath].exports.get = require.cache[gotPath].exports;
require.cache[gotPath].exports.post = (url, options) => {
    gotCalls.push({ url, options });
    return { then: (res) => res({ body: '{}', statusCode: 200, headers: {} }) };
};

const notify = require('/workspace/xbk_sendNotify_slim.js');
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
    'QYWX_KEY', 'WX_pusher_appToken', 'WX_pusher_topicIds', 'WX_XIZHI_KEY',
    'DEER_KEY', 'DEER_URL', 'PUSHME_KEY', 'PUSHME_URL', 'HITOKOTO',
    'TG_BOT_TOKEN', 'TG_USER_ID', 'TG_API_HOST'];

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
    assert(c.options.body.includes('text=%E6%A0%87%E9%A2%98%26A'), `text 应编码: ${c.options.body}`);
    assert(c.options.body.includes('desp='), '应含 desp');
    assert(c.options.headers['Content-Type'].includes('x-www-form-urlencoded'), '表单类型');
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
    await notify.sendNotify('标题', '内容');
    assert(gotCalls[0].url.includes('qyapi.weixin.qq.com'), `企微 URL: ${gotCalls[0].url}`);
    assert(gotCalls[0].url.includes('webhook-abc'), 'key 在 URL');
    assert(gotCalls[0].options.json.msgtype === 'text', 'msgtype');
    assert(gotCalls[0].options.json.text.content.includes('标题'), '内容含标题');
    assert(gotCalls.length === 1, '仅企微一次请求');
}));

// 6. wxpusher
await test('wxpusher: appToken + topicIds 数组 + Markdown', () => withChannels(async () => {
    cfg.WX_pusher_appToken = 'AT123';
    cfg.WX_pusher_topicIds = '456';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length >= 1, '应有请求');
    const c = gotCalls[0];
    assert(c.url.includes('wxpusher.zjiecode.com'), `wxpusher URL: ${c.url}`);
    assert(c.options.json.appToken === 'AT123', 'appToken');
    assert(Array.isArray(c.options.json.topicIds) && c.options.json.topicIds[0] === '456', 'topicIds 数组');
    assert(c.options.json.contentType === 3, 'Markdown');
    assert(gotCalls.length === 1, '仅 wxpusher 一次请求');
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

// 9. 无通道 → reject 且零请求
await test('通道全空 → reject 不静默成功', () => withChannels(async () => {
    let rejected = false;
    try { await notify.sendNotify('t', 'd'); } catch (e) { rejected = true; }
    assert(rejected, '无通道应 reject');
    assert(gotCalls.length === 0, '无通道不应发请求');
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
await test('Telegram: bot token + chat_id + Markdown（新增实现）', () => withChannels(async () => {
    cfg.TG_BOT_TOKEN = '123:ABC';
    cfg.TG_USER_ID = '456';
    await notify.sendNotify('标题', '内容');
    assert(gotCalls.length === 1, '仅 TG 一次请求');
    const c = gotCalls[0];
    assert(c.url.includes('api.telegram.org/bot123:ABC/sendMessage'), `TG URL: ${c.url}`);
    assert(c.options.json.chat_id === '456', 'chat_id 正确');
    assert(c.options.json.text.includes('标题') && c.options.json.text.includes('内容'), 'text 含标题与内容');
    assert(c.options.json.parse_mode === 'Markdown', 'Markdown 模式');
    assert(c.options.json.disable_web_page_preview === true, '禁网页预览');
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

// 14. 日志脱敏全覆盖：走真实通道异常路径，stub 日志断言不泄露
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
await test('日志脱敏: maskKey/maskUrl 不泄露完整密钥', () => {
    const { maskKey, maskUrl } = notify;
    // 长密钥保留首尾
    assert(maskKey('1234567890') === '1234***90', `maskKey: ${maskKey('1234567890')}`);
    // 短密钥全脱敏
    assert(maskKey('abc') === '***', `短密钥: ${maskKey('abc')}`);
    assert(maskKey('') === '***', '空密钥');
    // URL 保留 host，设备码段脱敏
    assert(maskUrl('https://api.day.app/DEVICEKEY123') === 'https://api.day.app/DEVI***23', `maskUrl: ${maskUrl('https://api.day.app/DEVICEKEY123')}`);
    assert(!maskUrl('https://api.day.app/DEVICEKEY123').includes('DEVICEKEY123'), '不应泄露完整设备码');
    // 完整密钥不应出现在脱敏结果
    assert(!maskKey('SCT302780T2QQOwQyxQRT3gNS3vtJVFrZS').includes('SCT302780T2QQOwQyxQRT3gNS3vtJVFrZS'), '完整密钥不应出现在日志');
});
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
if (failed === 0) {
    console.log(`  🎉 通道测试通过 ${passed}/${passed}`);
} else {
    console.log(`  ⚠️ ${passed} 通过, ${failed} 失败`);
    errors.forEach(e => console.log('  ❌ ' + e));
}
console.log('========================================\n');
process.exit(failed > 0 ? 1 : 0);

})();
