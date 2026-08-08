'use strict';

const assert = require('assert');
const {
    classifyFailure,
    classifySummary,
} = require('./xbk_failure_policy');
const { runResident } = require('./qinglong/xbk_push');

function error(message, code) {
    const e = new Error(message);
    if (code) e.code = code;
    return e;
}

(async () => {
    assert.strictEqual(classifyFailure(error('timeout', 'ETIMEDOUT')).kind, 'retryable');
    assert.strictEqual(classifyFailure(error('HTTP 500', 'HTTP_500')).kind, 'retryable');
    assert.strictEqual(classifyFailure(error('HTTP 401', 'HTTP_401')).kind, 'permanent');
    assert.strictEqual(classifyFailure(error('未配置任何推送通道', 'NO_CHANNEL_CONFIG')).kind, 'permanent');
    assert.strictEqual(classifyFailure(error('接口返回数据格式异常：期望数组')).kind, 'permanent');

    for (const code of ['ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH',
        'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED', 'ABORT_ERR',
        'HTTP_408', 'HTTP_409', 'HTTP_425', 'HTTP_429']) {
        assert.strictEqual(classifyFailure(error(code, code)).kind, 'retryable', `${code} 应可重试`);
    }
    for (const code of ['ERR_INVALID_URL', 'ERR_BODY_NOT_JSON', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_ARG_TYPE',
        'MODULE_NOT_FOUND', 'HTTP_400', 'HTTP_403', 'HTTP_404', 'HTTP_405', 'HTTP_406',
        'HTTP_410', 'HTTP_411', 'HTTP_413', 'HTTP_415', 'HTTP_422', 'HTTP_423', 'HTTP_426', 'HTTP_451']) {
        assert.strictEqual(classifyFailure(error(code, code)).kind, 'permanent', `${code} 应立即停止`);
    }
    assert.strictEqual(classifyFailure({ response: { statusCode: 500 }, message: 'server' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ response: { statusCode: 408 }, message: 'timeout' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ response: { statusCode: 400 }, message: 'bad request' }).kind, 'permanent');
    assert.strictEqual(classifyFailure({ response: { statusCode: 499 }, message: 'client error' }).kind, 'permanent');
    assert.strictEqual(classifyFailure({ response: { statusCode: 99 }, message: 'unknown' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ response: { statusCode: 600 }, message: 'unknown' }).kind, 'retryable');
    assert.strictEqual(classifyFailure(Object.assign(new Error('forced'), {
        failureKind: 'permanent', failureReason: 'TEST_FORCE', failureInfo: { message: 'forced-safe' },
    })).reason, 'TEST_FORCE');

    assert.strictEqual(classifyFailure(error('超时', '')).kind, 'retryable');
    assert.strictEqual(classifyFailure(error('invalid token')).kind, 'permanent');
    assert.strictEqual(classifyFailure(error('参数配置错误')).kind, 'permanent');
    assert.strictEqual(classifyFailure(error('服务暂时不可用')).kind, 'retryable');
    assert.strictEqual(classifyFailure({ providerCode: 1001, message: '速度太快' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ code: 1001, message: '速度太快' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ code: 401, message: 'unauthorized' }).kind, 'permanent');
    assert.strictEqual(classifyFailure({ providerCode: 40014, message: 'token invalid' }).kind, 'permanent');
    assert.strictEqual(classifyFailure({ providerCode: 500, message: 'provider busy' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ providerCode: 500, message: 'invalid token' }).kind, 'permanent');
    assert.strictEqual(classifyFailure({ channel: 'wxpusher', providerCode: 1300, message: 'bad app token' }).kind, 'permanent');
    assert.strictEqual(classifyFailure({ channel: 'wxpusher', providerCode: 1001, message: '速度太快' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 45009, message: '频率限制' }).kind, 'retryable');
    assert.strictEqual(classifyFailure({ channel: '企业微信', providerCode: 40014, message: '请求失败' }).kind, 'permanent');
    assert.strictEqual(classifyFailure(error('完全未知故障')).kind, 'retryable');
    assert.strictEqual(classifyFailure(Object.assign(new SyntaxError('代码解析失败'), { name: 'SyntaxError' })).kind, 'permanent');

    const summarized = require('./xbk_failure_policy').summarizeError({
        code: 'HTTP_500', providerCode: 500, channel: 'test', message: 'token=SECRET',
        failures: [{ code: 'HTTP_401', message: 'bad key' }],
    });
    assert.strictEqual(summarized.code, 'HTTP_500');
    assert.strictEqual(summarized.statusCode, null);
    assert.strictEqual(summarized.providerCode, '500');
    assert.strictEqual(summarized.channel, 'test');
    assert(!summarized.message.includes('SECRET'), '错误摘要不得保留明文 token');
    assert.strictEqual(summarized.failures.length, 1);
    assert.strictEqual(require('./xbk_failure_policy').summarizeError({ failureInfo: { message: 'kept' } }).message, 'kept');

    const getterError = {};
    Object.defineProperty(getterError, 'message', { get: () => { throw new Error('getter'); } });
    assert.doesNotThrow(() => classifyFailure(getterError));

    assert.strictEqual(classifySummary({
        total: 1, pushed: 0, failed: 1,
        failures: [{ code: 'ETIMEDOUT', message: 'timeout' }],
    }).kind, 'retryable');
    assert.strictEqual(classifySummary({
        total: 1, pushed: 0, failed: 1,
        failures: [{ code: 'HTTP_401', message: 'unauthorized' }],
    }).kind, 'permanent');
    assert.strictEqual(classifySummary({
        total: 1, pushed: 0, failed: 1,
        failures: [
            { code: 'HTTP_401', message: 'permanent failure' },
            { code: 'ETIMEDOUT', message: 'transient failure' },
        ],
    }).kind, 'retryable', '永久+临时混合失败时应保留重试机会');
    assert.strictEqual(classifySummary({
        total: 2, pushed: 1, failed: 1,
        failures: [
            { code: 'HTTP_401', message: 'permanent failure' },
            { code: 'ETIMEDOUT', message: 'transient failure' },
        ],
    }), null, '部分成功且剩余失败含临时因素时不应熔断');
    assert.strictEqual(classifySummary({
        total: 2, pushed: 1, failed: 1,
        failures: [{ code: 'HTTP_401', message: 'one channel permanent failure' }],
    }).kind, 'permanent', '部分成功但只剩永久失败时仍应停止');
    assert.strictEqual(classifySummary({
        total: 2, pushed: 1, failed: 1,
        failures: [{ code: 'ETIMEDOUT', message: 'one channel transient failure' }],
    }), null, '部分成功且仅临时失败时保持继续');

    const oldInterval = process.env.XBK_INTERVAL_MS;
    process.env.XBK_INTERVAL_MS = '0';
    try {
        let permanentRuns = 0;
        const permanentController = new AbortController();
        await runResident({
            num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
            run: async () => { permanentRuns++; throw error('HTTP 401', 'HTTP_401'); },
        }, permanentController);
        assert.strictEqual(permanentRuns, 1, '永久错误应立即停止');
        assert.strictEqual(permanentController.signal.aborted, true);

        let transientRuns = 0;
        const transientController = new AbortController();
        await runResident({
            num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
            run: async () => { transientRuns++; throw error('连接超时', 'ETIMEDOUT'); },
        }, transientController);
        assert.strictEqual(transientRuns, 3, '可重试错误应达到三轮后停止');
        assert.strictEqual(transientController.signal.aborted, true);

        let recoveryRuns = 0;
        const recoveryController = new AbortController();
        await runResident({
            num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
            run: async () => {
                recoveryRuns++;
                if (recoveryRuns === 1) throw error('连接超时', 'ETIMEDOUT');
                recoveryController.abort();
                return { total: 0, pushed: 0, failed: 0, failures: [] };
            },
        }, recoveryController);
        assert.strictEqual(recoveryRuns, 2, '恢复成功后应清零失败状态并正常停止');
        assert.strictEqual(recoveryController.signal.aborted, true);
    } finally {
        if (oldInterval === undefined) delete process.env.XBK_INTERVAL_MS;
        else process.env.XBK_INTERVAL_MS = oldInterval;
    }

    console.log('✅ 常驻失败策略：网络错误有限重试、永久错误立即停止、部分成功不熔断、成功后恢复');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
