'use strict';

// 官方 got 的薄封装：got 负责 HTTP/TLS/重定向/超时，本文只补项目需要的响应体上限与 JSON 解析。
const got = require('got');

const DEFAULT_MAX_BODY = 20 * 1024 * 1024;

function parseJsonBody(text) {
    try { return JSON.parse(text); }
    catch (e) {
        const err = new Error('Response is not JSON: ' + text.slice(0, 100));
        err.code = 'ERR_BODY_NOT_JSON';
        throw err;
    }
}

async function fetchJson(url, options = {}, maxBody = DEFAULT_MAX_BODY) {
    // 集成测试的 got mock 只提供 promise API；生产官方 got 提供 stream API，走可限流的真实路径。
    if (!got.stream) return got(url, options).json();

    const limit = Number.isFinite(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY;
    return new Promise((resolve, reject) => {
        let response;
        let total = 0;
        const chunks = [];
        let settled = false;
        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        const stream = got.stream(url, { ...options, throwHttpErrors: false });
        stream.once('response', (res) => { response = res; });
        stream.on('data', (chunk) => {
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
                resolve(body);
            } catch (e) { finishReject(e); }
        });
    });
}

module.exports = { fetchJson, DEFAULT_MAX_BODY };
