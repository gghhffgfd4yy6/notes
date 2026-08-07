'use strict';

// 回归测试：推送模块未预加载时，接口请求必须先发出，再后台加载推送模块。
const assert = require('assert');
const { execFileSync } = require('child_process');

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
`;

const output = execFileSync(process.execPath, ['-e', probe], {
    cwd: __dirname,
    encoding: 'utf8',
});
const events = JSON.parse(output.trim().split(/\r?\n/).pop());
assert.deepStrictEqual(events.slice(0, 2), ['fetch-start', 'notify-load']);
console.log('✅ 延迟加载顺序：接口请求先发出，推送模块后加载');

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
xbk.Config.alert.enabled = false;
xbk.Config.report.enabled = false;
xbk.run().then(() => process.stdout.write(JSON.stringify(events))).catch(error => {
    console.error(error);
    process.exit(1);
});
`;
const noWarmupOutput = execFileSync(process.execPath, ['-e', noWarmupProbe], {
    cwd: __dirname,
    encoding: 'utf8',
});

assert.deepStrictEqual(JSON.parse(noWarmupOutput.trim().split(/\r?\n/).pop()), ['dns-warmup']);
console.log('✅ 未配置 WxPusher 时仅启动线报接口 DNS 预热，不启动 WxPusher DNS/TLS 预热');

// 回归测试：TLS 预热必须携带与实际请求一致的 DNS 地址族，避免 Agent 连接池分裂。
function probePrewarmDnsFamily(family) {
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
`;
    const output = execFileSync(process.execPath, ['-e', probe], {
        cwd: __dirname,
        encoding: 'utf8',
        env: { ...process.env, ...(family ? { XBK_DNS_FAMILY: family } : { XBK_DNS_FAMILY: '' }) },
    });
    return JSON.parse(output.trim().split(/\r?\n/).pop());
}

assert.deepStrictEqual(probePrewarmDnsFamily('4'), ['ipv4'], 'XBK_DNS_FAMILY=4 时预热应使用 ipv4');
assert.deepStrictEqual(probePrewarmDnsFamily('6'), ['ipv6'], 'XBK_DNS_FAMILY=6 时预热应使用 ipv6');
assert.deepStrictEqual(probePrewarmDnsFamily(''), [null], 'auto 模式不应强制地址族');
console.log('✅ TLS 预热与推送请求使用一致的 DNS 地址族');
