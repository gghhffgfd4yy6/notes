'use strict'

// 回归测试：推送模块未预加载时，接口请求必须先发出，再后台加载推送模块。
const assert = require('assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('child_process')

// 探针会真实跑一轮 xbk.run()：缓存/日志目录必须钉到临时目录，否则每跑一次测试就往仓库
// 生产 run.log 追加一条 total=0 + 「Cannot find module」的假失败轮（评审现场：手机端历史
// 里成片的 0/0 中断行就是它）。
// 缓存目录必须在仓库根内（MessageStore 的根内校验会拒绝 /tmp 绝对路径并回退生产目录），
// 所以用仓库内临时目录，跑完即删。
const probeCacheDir = path.join(__dirname, `.tmp-lazy-notify-${process.pid}`)
fs.mkdirSync(probeCacheDir, { recursive: true })

const probe = String.raw`
'use strict';
const Module = require('module');
const events = [];
const httpPath = require.resolve('./xbk_http');
const agentsPath = require.resolve('./xbk_agents');
require.cache[httpPath] = {
    id: httpPath,
    filename: httpPath,
    loaded: true,
    exports: {
        fetchJson: async () => {
            events.push('fetch-start');
            return [];
        },
    },
};
require.cache[agentsPath] = {
    id: agentsPath,
    filename: agentsPath,
    loaded: true,
    exports: {
        prewarmDns: async () => ({ ok: true }),
        prewarmTls: async () => ({ ok: true }),
    },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './xbk_sendNotify_slim' ||
        (parent && parent.filename && parent.filename.endsWith('xbk_function_v3.js') && request.includes('sendNotify'))) {
        events.push('notify-load');
    }
    return originalLoad.apply(this, arguments);
};
const xbk = require('./xbk_function_v3');
xbk.fetchData().then(() => {
    process.stdout.write(JSON.stringify(events));
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
`

const output = execFileSync(process.execPath, ['-e', probe], {
  cwd: __dirname,
  encoding: 'utf8'
})
const events = JSON.parse(output.trim().split(/\r?\n/).pop())
assert.deepStrictEqual(events.slice(0, 2), ['fetch-start', 'notify-load'])
console.log('✅ 延迟加载顺序：接口请求先发出，推送模块后加载')

// 回归测试：未配置 WxPusher 时不应启动 DNS/TLS 预热请求。
const noWarmupProbe = String.raw`
'use strict';
const Module = require('module');
const events = [];
const httpPath = require.resolve('./xbk_http');
const agentsPath = require.resolve('./xbk_agents');
const notifyPath = require.resolve('./xbk_sendNotify_slim');
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: {
    fetchJson: async () => [],
} };
require.cache[agentsPath] = { id: agentsPath, filename: agentsPath, loaded: true, exports: {
    prewarmDns: async () => { events.push('dns-warmup'); return { ok: true }; },
    prewarmTls: async () => { events.push('tls-warmup'); return { ok: true }; },
} };
require.cache[notifyPath] = { id: notifyPath, filename: notifyPath, loaded: true, exports: {
    push_config: { WX_pusher_appToken: '', WX_pusher_channels: [] },
    sendNotify: async () => {},
} };
const xbk = require('./xbk_function_v3');
if (process.env.XBK_CACHE_DIR) xbk.Config.cache.dir = process.env.XBK_CACHE_DIR;
xbk.Config.alert.enabled = false;
xbk.Config.report.enabled = false;
xbk.run().then(() => process.stdout.write(JSON.stringify(events))).catch(error => {
    console.error(error);
    process.exit(1);
});
`
const noWarmupOutput = execFileSync(process.execPath, ['-e', noWarmupProbe], {
  cwd: __dirname,
  encoding: 'utf8',
  env: { ...process.env, XBK_CACHE_DIR: probeCacheDir }
})

assert.deepStrictEqual(JSON.parse(noWarmupOutput.trim().split(/\r?\n/).pop()), ['dns-warmup'])
console.log('✅ 未配置 WxPusher 时仅启动线报接口 DNS 预热，不启动 WxPusher DNS/TLS 预热')

// 回归测试：TLS 预热必须携带与实际请求一致的 DNS 地址族，避免 Agent 连接池分裂。
function probePrewarmDnsFamily (family) {
  const probe = String.raw`
'use strict';
const gotPath = require.resolve('got');
const calls = [];
const fakeGot = function () { return { then(resolve) { resolve({ statusCode: 200 }); } }; };
fakeGot.stream = () => {};
fakeGot.head = (url, options) => {
    calls.push({ method: 'head', url, options });
    return { then(resolve) { resolve({ statusCode: 200 }); } };
};
fakeGot.get = (url, options) => {
    calls.push({ method: 'get', url, options });
    return { then(resolve) { resolve({ statusCode: 200 }); } };
};
require.cache[gotPath] = { id: gotPath, filename: gotPath, loaded: true, exports: fakeGot };
const { prewarmTls } = require('./xbk_agents');
prewarmTls('example.test', 100, 1).then(() => {
    process.stdout.write(JSON.stringify(calls.map(call => call.options.dnsLookupIpVersion)));
}).catch(error => {
    console.error(error);
    process.exit(1);
});
`
  const output = execFileSync(process.execPath, ['-e', probe], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, ...(family ? { XBK_DNS_FAMILY: family } : { XBK_DNS_FAMILY: '' }) }
  })
  return JSON.parse(output.trim().split(/\r?\n/).pop())
}

assert.deepStrictEqual(probePrewarmDnsFamily('4'), ['ipv4'], 'XBK_DNS_FAMILY=4 时预热应使用 ipv4')
assert.deepStrictEqual(probePrewarmDnsFamily('6'), ['ipv6'], 'XBK_DNS_FAMILY=6 时预热应使用 ipv6')
assert.deepStrictEqual(probePrewarmDnsFamily(''), [null], 'auto 模式不应强制地址族')
console.log('✅ TLS 预热与推送请求使用一致的 DNS 地址族')

// v3.235：xbk_sendNotify_slim 缺失时 getNotify 不得同步抛错（AI 审 ef1116e 发现：
// require.resolve 在 try-catch 外，模块缺失时 1529 行 .catch() 来不及接住，主流程中断）。
// 探针：接口请求必须发出（修复前 getNotify 同步抛 → fetch 从未执行 → fetched=false）。
const missingProbe = `
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...args) {
        if (String(request).includes('xbk_sendNotify_slim')) {
            const e = new Error('Cannot find module ./xbk_sendNotify_slim');
            e.code = 'MODULE_NOT_FOUND';
            throw e;
        }
        return origResolve.apply(this, [request, ...args]);
    };
    let fetched = false;
    const httpPath = require.resolve('./xbk_http');
    require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: { fetchJson: async () => { fetched = true; return []; } } };
    const xbk = require('./xbk_function_v3');
    // 应用侧的缓存目录来自 Config.cache.dir（不读 XBK_CACHE_DIR），探针必须显式改写，
    // 否则这一轮真实 run() 会写进仓库生产 run.log。
    if (process.env.XBK_CACHE_DIR) xbk.Config.cache.dir = process.env.XBK_CACHE_DIR;
    xbk.Config.alert.enabled = false;
    xbk.Config.report.enabled = false;
    xbk.run().then(() => process.stdout.write(JSON.stringify({ fetched })))
        .catch(e => process.stdout.write(JSON.stringify({ fetched, err: (e && e.code) || String(e) })));
`
const missingOut = execFileSync(process.execPath, ['-e', missingProbe], {
  cwd: __dirname,
  encoding: 'utf8',
  timeout: 20000,
  env: { ...process.env, XBK_CACHE_DIR: probeCacheDir }
}).trim().split(/\r?\n/).pop()
const missingParsed = JSON.parse(missingOut)
assert.strictEqual(missingParsed.fetched, true, '模块缺失时接口请求必须发出（getNotify 不得同步抛错）: ' + missingOut)
console.log('✅ 推送模块缺失时 getNotify 不同步崩溃（接口请求正常发出）')

// 隔离自检：探针跑的轮次必须写进临时缓存目录，绝不能落到仓库生产 run.log
// （否则每跑一次测试，手机端「逐轮运行历史」就多一条 0/0 的中断行）。
assert.ok(fs.existsSync(path.join(probeCacheDir, 'run.log')), '探针轮次必须写入临时缓存目录')
fs.rmSync(probeCacheDir, { recursive: true, force: true })
