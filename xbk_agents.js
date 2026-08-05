'use strict';

// 共享 Keep-Alive Agent：避免连续请求反复建立 TCP/TLS 连接；并行请求仍可同时发出。
const http = require('http');
const https = require('https');

const AGENTS = {
    http: new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, keepAliveMsecs: 1000 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, keepAliveMsecs: 1000 }),
};

module.exports = { AGENTS };
