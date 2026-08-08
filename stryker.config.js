'use strict';

const os = require('os');

const requestedConcurrency = Number(process.env.STRYKER_CONCURRENCY || 2);
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(requestedConcurrency, Math.max(1, os.cpus().length))
    : 2;

module.exports = {
    testRunner: 'command',
    commandRunner: {
        command: 'node test_filter.js',
    },
    mutate: [
        'xbk_function_v3.js',
        'xbk_agents.js',
        'xbk_http.js',
        'xbk_sendNotify_slim.js',
        'xbk_storage.js',
        'xbk_loop.js',
        'xbk_failure_policy.js',
        'qinglong/xbk_push.js',
    ],
    coverageAnalysis: 'off',
    concurrency,
    timeoutMS: 90000,
    reporters: ['clear-text', 'html', 'json'],
    tempDirName: '.stryker-tmp',
    cleanTempDir: 'always',
};
