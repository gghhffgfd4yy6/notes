'use strict';

// 长驻运行调度器：一次进程内重复执行 run，复用主模块、got、Agent、DNS 缓存和连接池。
// 调用方负责提供 AbortSignal；停止信号会在当前 run 完成后退出，不强杀正在进行的推送。
function sleep(ms, signal) {
    if (signal && signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(done, Math.max(0, Number.isFinite(ms) ? ms : 10000));
        function done() {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', done);
            resolve();
        }
        if (signal) signal.addEventListener('abort', done, { once: true });
    });
}

async function runLoop(run, options = {}) {
    if (typeof run !== 'function') throw new TypeError('runLoop 需要函数作为 run 参数');
    const signal = options.signal || null;
    const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 0 ? options.intervalMs : 10000;
    const refreshEvery = Number.isInteger(options.refreshEvery) && options.refreshEvery > 0 ? options.refreshEvery : 10;
    const onError = typeof options.onError === 'function' ? options.onError : (() => {});
    const onIntervalError = typeof options.onIntervalError === 'function' ? options.onIntervalError : onError;
    const onInterval = typeof options.onInterval === 'function' ? options.onInterval : null;
    let cycle = 0;
    while (!(signal && signal.aborted)) {
        try {
            await run();
        } catch (error) {
            try { await onError(error); } catch (ignored) { /* 错误记录不能阻止下一轮 */ }
        }
        cycle += 1;
        if (signal && signal.aborted) break;
        const intervalTask = sleep(intervalMs, signal);
        const refreshTask = onInterval && cycle % refreshEvery === 0
            ? Promise.resolve().then(() => onInterval({ cycle, signal })).catch(async error => {
                try { await onIntervalError(error); } catch (ignored) { /* 刷新失败不能阻止下一轮 */ }
            })
            : Promise.resolve();
        await Promise.all([intervalTask, refreshTask]);
    }
}

module.exports = { runLoop, sleep };
