'use strict';

// 共享 Keep-Alive Agent：避免连续请求反复建立 TCP/TLS 连接；并行请求仍可同时发出。
const http = require('http');
const https = require('https');
const dns = require('dns');

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

module.exports = { AGENTS, DNS_LOOKUP_IP_VERSION, DNS_CACHE: null, dnsLookup };
