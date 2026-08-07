'use strict';

// 青龙面板直接执行入口：不依赖当前工作目录，配置/缓存仍统一放在项目根目录。
const path = require('path');
const { spawnSync } = require('child_process');
const { runLoop } = require(path.join(__dirname, '..', 'xbk_loop'));

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'xbk_function_v3.js');

function ensureDependencies() {
    try {
        // 不只检查 require.resolve：got 的传递依赖缺失时，真正 require 才能发现。
        require(path.join(ROOT, 'node_modules', 'got'));
        return;
    } catch (e) {
        console.warn('检测到 Node.js 依赖未完整安装，正在安装 got 依赖...');
    }

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, [
        'install',
        '--production',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix', ROOT,
    ], { cwd: ROOT, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install 失败，退出码 ${result.status}`);
}

function intervalMs(num) {
    const value = num(process.env.XBK_INTERVAL_MS, 10000);
    return Number.isFinite(value) && value >= 0 ? value : 10000;
}

function refreshCount(app) {
    const limit = app.num(app.Config && app.Config.push && app.Config.push.parallelLimit, -1);
    const maxPerRun = app.num(app.Config && app.Config.push && app.Config.push.maxPerRun, -1);
    const window = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 10;
    const batch = Number.isInteger(maxPerRun) && maxPerRun > 0 ? maxPerRun : 100;
    return Math.max(1, Math.min(window, batch, 3));
}

async function refreshConnections(app, signal) {
    if (signal && signal.aborted) return;
    const agents = require(path.join(ROOT, 'xbk_agents'));
    const notify = require(path.join(ROOT, 'xbk_sendNotify_slim'));
    const hasWxPusher = Boolean(notify && typeof notify.hasWxPusherConfigured === 'function'
        && notify.hasWxPusherConfigured());
    const apiHost = (() => {
        try { return new URL(app.Config.api.pushUrl).hostname; } catch (e) { return ''; }
    })();
    const wxHost = 'wxpusher.zjiecode.com';
    const tasks = [];
    if (apiHost) tasks.push(agents.prewarmDns(apiHost));
    if (hasWxPusher) {
        tasks.push(agents.prewarmDns(wxHost));
        tasks.push(agents.prewarmTls(wxHost, 5000, refreshCount(app), signal));
    }
    const results = await Promise.all(tasks);
    if (!(signal && signal.aborted)) {
        const dnsResults = results.filter(r => r && Object.prototype.hasOwnProperty.call(r, 'hostname'));
        const tls = results.find(r => r && Object.prototype.hasOwnProperty.call(r, 'okCount'));
        console.log(`常驻连接刷新完成：DNS ${dnsResults.filter(r => r.ok).length}/${dnsResults.length}，TLS ${tls ? `${tls.okCount}/${tls.count}` : '跳过'}`);
    }
}

(async () => {
    ensureDependencies();
    const app = require(MAIN);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log(`青龙常驻模式启动，单轮完成后等待 ${intervalMs(app.num)}ms 再拉取`);
    await runLoop(
        () => app.run(),
        {
            intervalMs: intervalMs(app.num),
            refreshEvery: 10,
            signal: controller.signal,
            onInterval: ({ signal }) => refreshConnections(app, signal),
            onError: async (e) => {
                console.error('本轮运行失败，等待下一轮:', e && e.message ? e.message : String(e));
            },
        },
    );
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    console.log('青龙常驻模式已停止');
})().catch((e) => {
    console.error('青龙任务执行失败:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
});
