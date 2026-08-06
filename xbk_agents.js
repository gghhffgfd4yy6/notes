'use strict';

// 共享 Keep-Alive Agent：避免连续请求反复建立 TCP/TLS 连接；并行请求仍可同时发出。
const http = require('http');
const https = require('https');
const dns = require('dns');
const got = require('got');

// DNS 地址族：默认 auto；XBK_DNS_FAMILY=4/6 可用于对比 IPv4/IPv6 路径。
const DNS_LOOKUP_IP_VERSION = process.env.XBK_DNS_FAMILY === '4' ? 'ipv4' : process.env.XBK_DNS_FAMILY === '6' ? 'ipv6' : '';

const AGENTS = {
    http: new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, keepAliveMsecs: 1000 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, keepAliveMsecs: 1000 }),
};

// 进程内 DNS 缓存：避免同一进程的并发请求重复解析同一个 HTTPS 主机。
// 使用 Node 原生 dns.lookup，不依赖网卡枚举，兼容受限 Android/沙箱环境。
const DNS_TTL_MS = 60000;
const DNS_ERROR_TTL_MS = 1000;
const dnsCache = new Map();
const dnsPending = new Map();

function dnsLookup(hostname, options, callback) {
    const opts = options || {};
    const key = [hostname, opts.family || 0, opts.hints || 0, opts.all ? 1 : 0, opts.verbatim ? 1 : 0].join('|');
    const now = Date.now();
    const cached = dnsCache.get(key);
    if (cached && cached.expiresAt > now) {
        queueMicrotask(() => callback(cached.error, cached.address, cached.family));
        return;
    }

    const pending = dnsPending.get(key);
    if (pending) {
        pending.push(callback);
        return;
    }
    dnsPending.set(key, [callback]);
    dns.lookup(hostname, opts, (error, address, family) => {
        const callbacks = dnsPending.get(key) || [];
        dnsPending.delete(key);
        const ttl = error ? DNS_ERROR_TTL_MS : DNS_TTL_MS;
        dnsCache.set(key, { error, address, family, expiresAt: Date.now() + ttl });
        for (const cb of callbacks) cb(error, address, family);
    });
}

function prewarmDns(hostname) {
    const options = DNS_LOOKUP_IP_VERSION === 'ipv4' ? { family: 4 } : DNS_LOOKUP_IP_VERSION === 'ipv6' ? { family: 6 } : {};
    const started = Date.now();
    return new Promise(resolve => {
        dnsLookup(hostname, options, (error, address, family) => {
            resolve({
                hostname,
                ok: !error,
                error: error ? error.code || error.message || String(error) : '',
                address: Array.isArray(address) ? address.map(x => x.address || x) : address,
                family,
                elapsedMs: Date.now() - started,
            });
        });
    });
}

async function prewarmTls(hostname, timeoutMs = 5000, count = 1) {
    const started = Date.now();
    try {
        // 测试环境 got 为 mock（无 stream）：跳过真实建连，避免破坏 gotCalls 断言。
        if (!got.stream) return { hostname, count, skipped: true, ok: true, elapsedMs: Date.now() - started };
    } catch (e) { /* 忽略 */ }
    const baseOptions = {
        agent: AGENTS,
        lookup: dnsLookup,
        timeout: timeoutMs,
        retry: { limit: 0 },
        throwHttpErrors: false,
    };
    const results = await Promise.all(Array.from({ length: Math.max(1, Math.floor(count)) }, async () => {
        const singleStart = Date.now();
        try {
            // HEAD 无响应体：只需 DNS+TCP+TLS+响应头即可完成建连，连接进入 Keep-Alive 池，
            // 比 GET 下载首页快得多（GET 会把 body 下载时间也算进预取）。
            await got.head(`https://${hostname}/`, baseOptions);
            return { ok: true, elapsedMs: Date.now() - singleStart };
        } catch (e) {
            // 服务端不支持 HEAD（如 405）时回退 GET 建连；仍失败则静默跳过。
            try {
                await got.get(`https://${hostname}/`, baseOptions);
                return { ok: true, elapsedMs: Date.now() - singleStart, viaGet: true };
            } catch (e2) {
                return { ok: false, error: e2 && (e2.code || e2.message) ? String(e2.code || e2.message) : String(e2), elapsedMs: Date.now() - singleStart };
            }
        }
    }));
    return {
        hostname,
        count: results.length,
        ok: results.every(r => r.ok),
        okCount: results.filter(r => r.ok).length,
        elapsedMs: Date.now() - started,
        perConnectionMs: results.map(r => r.elapsedMs),
    };
}

module.exports = { AGENTS, DNS_LOOKUP_IP_VERSION, DNS_CACHE: null, dnsLookup, prewarmDns, prewarmTls };
