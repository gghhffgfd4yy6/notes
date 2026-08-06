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
