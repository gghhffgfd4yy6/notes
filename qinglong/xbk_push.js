'use strict';

// 青龙面板直接执行入口：不依赖当前工作目录，配置/缓存仍统一放在项目根目录。
const path = require('path');
const { spawnSync } = require('child_process');

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

(async () => {
    ensureDependencies();
    const app = require(MAIN);
    await app.run();
})().catch((e) => {
    console.error('青龙任务执行失败:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
});
