'use strict';

const assert = require('assert');
const { runLoop } = require('./xbk_loop');

(async () => {
    const controller = new AbortController();
    let runs = 0;
    const errors = [];
    const refreshes = [];
    await runLoop(async () => {
        runs += 1;
        if (runs === 1) throw new Error('probe');
        if (runs === 3) controller.abort();
    }, {
        intervalMs: 0,
        refreshEvery: 2,
        signal: controller.signal,
        onInterval: async ({ cycle }) => refreshes.push(cycle),
        onError: async error => errors.push(error.message),
    });
    assert.strictEqual(runs, 3);
    assert.deepStrictEqual(errors, ['probe']);
    assert.deepStrictEqual(refreshes, [2]);
    console.log('✅ 常驻循环：单轮异常不中断，停止信号在当前轮结束后生效，定期刷新与等待并行');
})();
