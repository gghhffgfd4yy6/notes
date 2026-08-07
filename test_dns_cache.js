'use strict';

const assert = require('assert');
const dns = require('dns');
const originalLookup = dns.lookup;
let calls = 0;
dns.lookup = (hostname, options, callback) => {
    calls += 1;
    callback(null, '192.0.2.1', 4);
};

(async () => {
    try {
        delete require.cache[require.resolve('./xbk_agents')];
        const { prewarmDns, invalidateDns } = require('./xbk_agents');
        await prewarmDns('cache-probe.invalid');
        await prewarmDns('cache-probe.invalid');
        assert.strictEqual(calls, 1, 'TTL 内应命中 DNS 缓存');
        assert.strictEqual(invalidateDns('cache-probe.invalid'), 1, '应清除该主机缓存');
        await prewarmDns('cache-probe.invalid');
        assert.strictEqual(calls, 2, '清除后应重新解析');
        console.log('✅ 连接错误 DNS 失效处理：清除后下一次请求重新解析');
    } finally {
        dns.lookup = originalLookup;
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
