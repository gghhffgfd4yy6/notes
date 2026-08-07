'use strict';

// 官方 got 的薄封装：got 负责 HTTP/TLS/重定向/超时，本文只补项目需要的响应体大小与 JSON 解析。
const got = require('got');
const { AGENTS, DNS_LOOKUP_IP_VERSION, dnsLookup, invalidateDns, shouldInvalidateDns, profileMs } = require('./xbk_agents');

const DEFAULT_MAX_BODY = 20 * 1024 * 1024;

function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
}

function parseJsonBody(text) {
    try { return JSON.parse(text); }
    catch (e) {
        const err = new Error('Response is not JSON: ' + text.slice(0, 100));
        err.code = 'ERR_BODY_NOT_JSON';
        throw err;
    }
}

async function fetchJson(url, options = {}, maxBody = DEFAULT_MAX_BODY) {
    const requestOptions = { agent: AGENTS, lookup: dnsLookup, ...(DNS_LOOKUP_IP_VERSION ? { dnsLookupIpVersion: DNS_LOOKUP_IP_VERSION } : {}), ...options };
    const requestHost = hostOf(url);
    const detailedProfile = process.env.XBK_PROFILE === '3';
    const started = Date.now();
    if (detailedProfile) console.log(`[profile api] start url=${String(url).replace(/\/[^/]+$/, '/***')}`);
    // 集成测试的 got mock 只提供 promise API；生产官方 got 提供 stream API，走可限流的真实路径。
    if (!got.stream) {
        const body = await got(url, requestOptions).json();
        if (detailedProfile) console.log(`[profile api] complete totalMs=${Date.now() - started} transport=mock`);
        return body;
    }

    const limit = Number.isFinite(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY;
    return new Promise((resolve, reject) => {
        let response;
        let firstDataAt = 0;
        let total = 0;
        const chunks = [];
        let settled = false;
        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            if (shouldInvalidateDns(err) && requestHost) invalidateDns(requestHost);
            if (detailedProfile) console.log(`[profile api] error totalMs=${Date.now() - started} code=${err && err.code ? err.code : 'unknown'}`);
            reject(err);
        };
        const stream = got.stream(url, { ...requestOptions, throwHttpErrors: false });
        stream.once('response', (res) => {
            response = res;
            if (detailedProfile) console.log(`[profile api] responseAtMs=${Date.now() - started} status=${res.statusCode}`);
        });
        stream.on('data', (chunk) => {
            if (!firstDataAt) firstDataAt = Date.now();
            total += chunk.length;
            if (total > limit) {
                const err = new Error(`响应体过大(超过 ${limit} 字节)`);
                err.code = 'EBODYLIMIT';
                stream.destroy(err);
                finishReject(err);
                return;
            }
            chunks.push(chunk);
        });
        stream.once('error', finishReject);
        stream.once('end', () => {
            if (settled) return;
            const endedAt = Date.now();
            const text = Buffer.concat(chunks).toString('utf8');
            if (response && response.statusCode >= 400) {
                const err = new Error(`HTTP ${response.statusCode}`);
                err.code = `HTTP_${response.statusCode}`;
                err.response = { statusCode: response.statusCode, body: text, headers: response.headers };
                finishReject(err);
                return;
            }
            try {
                const body = parseJsonBody(text);
                settled = true;
                if (detailedProfile) {
                    const timings = stream.timings && stream.timings.phases ? stream.timings.phases : {};
                    console.log(`[profile api timing] wait=${profileMs(timings.wait)} dns=${profileMs(timings.dns)} tcp=${profileMs(timings.tcp)} tls=${profileMs(timings.tls)} request=${profileMs(timings.request)} firstByte=${profileMs(timings.firstByte)} download=${profileMs(timings.download)} responseAt=${response ? Date.now() - started : 'n/a'} firstDataAt=${firstDataAt ? firstDataAt - started : 'n/a'} downloadEnd=${endedAt - started} parse=${Date.now() - endedAt} total=${Date.now() - started} bytes=${total}`);
                }
                resolve(body);
            } catch (e) { finishReject(e); }
        });
    });
}

module.exports = { fetchJson, DEFAULT_MAX_BODY, AGENTS };
