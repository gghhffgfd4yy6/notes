'use strict';
// ============================================================
// test_app 并行调度器（v3.122）：70 个集成测试并行 fork
// 慢测试（重试等待类，需真实 1s/2s/3s 退避）不加 QUICK；快测加 QUICK=1（timing 置 0）
// 原理：每个测试独立进程 → 各自独立 mock/模块实例 → 无全局污染
// 效果：串行 ~46s → 并行 ~7s（总时间 = 最慢的单个测试，非累加）
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/test_app.js', 'utf8');
const names = [...src.matchAll(/await test\('([^']+)'/g)].map(m => m[1]);
if (!names.length) { console.error('未解析到测试名'); process.exit(1); }

// 慢测试（真实等待重试退避）——不加 QUICK（它们要验证真实退避）
const SLOW_SUBSTR = ['retry=Infinity', '重试耗尽', 'ETIMEDOUT', '抛字符串', '5xx 失败一次', '429限流', 'parallelLimit=1'];
const isSlow = (n) => SLOW_SUBSTR.some(s => n.includes(s));
// run.log 专属测试：操作共享文件 xianbaoku_cache/run.log（所有 run 都写）——
// 并行会互相 unlink 竞争，单独串行跑（独占）
const RUNLOG_SUBSTR = ['运行摘要持久化', '运行失败也写 ERROR'];
const isRunlog = (n) => RUNLOG_SUBSTR.some(s => n.includes(s));

// 并发进程数（v3.122b）：沙箱 overlayfs 在高并发(16/32)偶发 IO 竞态(existsSync→readFileSync 窗口)，
// 默认 8 稳定(11s)；真机资源充足可用 CONCURRENCY=32 加速(~7s)
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 8;
let queue = [...names].filter(n => !isRunlog(n)); // 并行池排除 run.log 测试
const runlogTests = names.filter(isRunlog);
const TOTAL = queue.length; // 快照（v3.122b：原 done===queue.length 在 shift 后比较出错）
let running = 0, failed = 0, done = 0;
const slowCount = queue.filter(isSlow).length;
const t0 = Date.now();
console.log(`并行调度 ${queue.length} 个测试（慢测 ${slowCount} 真实等待 + 快测 ${queue.length - slowCount} QUICK，并发 ${CONCURRENCY}；run.log 测试 ${runlogTests.length} 个单独串行）...\n`);

function next() {
    while (running < CONCURRENCY && queue.length) {
        const name = queue.shift();
        const env = isSlow(name) ? {} : { QUICK: '1' };
        const p = spawn(process.execPath, [__dirname + '/test_app.js', '--only', name], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'], // v3.122b：捕获输出，失败时打印定位
        });
        let outBuf = '';
        p.stdout.on('data', (d) => { outBuf += d; });
        p.stderr.on('data', (d) => { outBuf += d; });
        running++;
        p.on('exit', (code) => {
            running--; done++;
            if (code !== 0) {
                failed++;
                const detail = outBuf.split('\n').filter(l => l.includes('❌') || l.includes('期望') || l.includes('实际') || l.includes('Error')).slice(-3).join(' | ');
                console.log('  ❌ ' + name + (detail ? '\n     ' + detail : ''));
            }
            else if (isSlow(name)) console.log(`  ✅ ${name}`);
            if (done === TOTAL) {
                // 并行完成 → 统一清理缓存 → 串行补跑 run.log 测试（独占共享文件）
                try {
                    const fs = require('fs');
                    const dir = __dirname + '/xianbaoku_cache';
                    if (fs.existsSync(dir)) {
                        for (const f of fs.readdirSync(dir)) {
                            if (/^t\d{2}[a-z]?_|^tpush_|^tpar_fail/.test(f)) { try { fs.unlinkSync(dir + '/' + f); } catch (e) { /* 忽略 */ } }
                        }
                    }
                } catch (e) { /* 忽略 */ }
                (async () => {
                    for (const name of runlogTests) {
                        const code = await new Promise((res) => {
                            const p = spawn(process.execPath, [__dirname + '/test_app.js', '--only', name], { stdio: 'inherit' });
                            p.on('exit', res);
                        });
                        if (code !== 0) { failed++; console.log('  ❌ ' + name + '（run.log 串行）'); }
                        else console.log(`  ✅ ${name}（run.log 串行）`);
                    }
                    const ms = Date.now() - t0;
                    console.log(`\n并行完成: ${TOTAL + runlogTests.length} 测试, ${failed ? failed + ' 失败 ⚠️' : '全部通过 🎉'}, 耗时 ${(ms / 1000).toFixed(1)}s`);
                    console.log(`（串行需 ~46s → 并行 ${(ms / 1000).toFixed(1)}s，${(46000 / Math.max(ms, 1)).toFixed(0)} 倍加速）`);
                    process.exit(failed ? 1 : 0);
                })();
            }
            next();
        });
    }
}
next();
