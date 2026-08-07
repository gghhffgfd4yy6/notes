'use strict';
// ============================================================
// 统一测试入口：一键执行三套测试 + 汇总报告 + 退出码
// 用法：node run_tests.js   （或 npm test）
// 退出码：0 = 全部通过，非 0 = 有失败（CI/调度可感知）
// ============================================================
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
    { name: '常驻循环',   file: 'test_loop.js',          desc: '长驻调度、单轮异常隔离、停止信号' },
    { name: 'DNS失效回归', file: 'test_dns_cache.js',    desc: '连接错误后清除主机 DNS 缓存并重新解析' },
    { name: 'TLS预热回归', file: 'test_tls_prewarm.js',   desc: 'TLS 预热 aggregate ok 与连接成功数保持一致' },
    { name: '延迟加载回归', file: 'test_lazy_notify.js', desc: '验证接口请求先于推送模块加载' },
    { name: '单元测试',   file: 'test_filter.js',        desc: '主代码导出函数逐函数逻辑' },
    // v3.172：集成测试走并行调度器（worker 独立缓存目录 + 失败片串行重跑）。
    // 需要完整串行验证时直接 node test_app.js（CI 即如此）
    { name: '集成测试',   file: 'test_app_p.js',  desc: 'App.run 完整主流程(并行调度,失败自动重跑)' },
    { name: '通道测试',   file: 'test_notify.js',        desc: '推送通道请求构造+脱敏' },
];

const results = [];
console.log('══════════════════════════════════════════════');
console.log('  xbk-push 统一测试入口');
console.log('══════════════════════════════════════════════\n');

for (const s of SUITES) {
    const file = path.join(__dirname, s.file);
    const t0 = Date.now();
    try {
        // 继承 stdout/stderr（各套件自己的 ✅/❌ 输出直接透传），捕获退出码
        execFileSync(process.execPath, [file], { stdio: 'inherit' });
        const ms = Date.now() - t0;
        results.push({ ...s, ok: true, ms });
        console.log(`\n  ✅ ${s.name} 通过（${(ms / 1000).toFixed(1)}s）\n`);
    } catch (e) {
        const ms = Date.now() - t0;
        results.push({ ...s, ok: false, ms });
        console.log(`\n  ❌ ${s.name} 失败（${(ms / 1000).toFixed(1)}s）\n`);
    }
}

console.log('══════════════════════════════════════════════');
console.log('  汇总报告');
console.log('══════════════════════════════════════════════');
let allOk = true;
for (const r of results) {
    const mark = r.ok ? '✅' : '❌';
    console.log(`  ${mark} ${r.name.padEnd(6)} ${r.file.padEnd(18)} ${(r.ms / 1000).toFixed(1)}s  ${r.desc}`);
    if (!r.ok) allOk = false;
}
const totalMs = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n  总耗时: ${(totalMs / 1000).toFixed(1)}s`);
console.log(`  结果:   ${allOk ? '全部通过 🎉' : '存在失败 ⚠️'}`);
console.log('══════════════════════════════════════════════');

process.exit(allOk ? 0 : 1);
