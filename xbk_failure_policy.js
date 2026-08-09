'use strict';

// 常驻运行失败分类：把可波动的网络/服务故障与不可恢复的配置/契约故障分开。
// 默认未知错误按可重试处理，遵守“宁可重复，不可丢失”的主流程原则。

const RETRYABLE_CODES = new Set([
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'ERR_SOCKET_CLOSED',
    'ABORT_ERR', 'HTTP_408', 'HTTP_409', 'HTTP_425', 'HTTP_429',
]);

const PERMANENT_CODES = new Set([
    'ERR_INVALID_URL', 'ERR_BODY_NOT_JSON', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_ARG_TYPE',
    'MODULE_NOT_FOUND', 'NO_CHANNEL_CONFIG', 'HTTP_400', 'HTTP_401', 'HTTP_403',
    'HTTP_404', 'HTTP_405', 'HTTP_406', 'HTTP_410', 'HTTP_411', 'HTTP_413',
    'HTTP_415', 'HTTP_422', 'HTTP_423', 'HTTP_426', 'HTTP_451',
]);

function safeString(value) {
    try { return String(value === undefined || value === null ? '' : value); }
    catch (e) { return ''; }
}

function redact(text) {
    return safeString(text)
        .replace(/((?:token|app[_-]?token|key|secret|authorization|pushkey)\s*[=:]\s*)[^\s,;]+/gi, '$1***')
        .replace(/\/bot[^/\s]+/gi, '/bot***');
}

function readProp(object, key) {
    try { return object && object[key]; } catch (e) { return undefined; }
}

function statusCodeOf(error) {
    const response = readProp(error, 'response');
    const candidates = [
        readProp(error, 'statusCode'),
        readProp(response, 'statusCode'),
        readProp(response, 'status'),
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
    }
    return null;
}

function codeOf(error) {
    if (!error || typeof error !== 'object') return '';
    const code = readProp(error, 'code');
    return typeof code === 'string' || typeof code === 'number' ? String(code).toUpperCase() : '';
}

function summarizeError(error) {
    if (readProp(error, 'failureInfo') && typeof readProp(error, 'failureInfo') === 'object') {
        return { ...readProp(error, 'failureInfo') };
    }
    const source = error && typeof error === 'object' ? error : { message: error };
    const rawProviderCode = readProp(source, 'providerCode');
    const rawChannel = readProp(source, 'channel');
    const rawName = readProp(source, 'name');
    const rawMessage = readProp(source, 'message') || readProp(source, 'reason') || source;
    const info = {
        code: codeOf(source),
        name: rawName ? safeString(rawName).toUpperCase() : '',
        statusCode: statusCodeOf(source),
        providerCode: rawProviderCode === undefined || rawProviderCode === null ? '' : safeString(rawProviderCode),
        channel: rawChannel ? redact(rawChannel).slice(0, 40) : '',
        message: redact(rawMessage).replace(/[\r\n]+/g, ' ').slice(0, 500),
    };
    const sourceKind = readProp(source, 'failureKind');
    if (sourceKind === 'retryable' || sourceKind === 'permanent') {
        info.failureKind = sourceKind;
        info.failureReason = readProp(source, 'failureReason') || '';
    }
    const failures = readProp(source, 'failures');
    if (Array.isArray(failures)) {
        info.failures = failures.map(summarizeError);
    }
    return info;
}

function codeIs(code, set) {
    return Boolean(code && set.has(String(code).toUpperCase()));
}

function classifyOne(error) {
    const info = summarizeError(error);

    // 结构化聚合错误优先递归：顶层可能只保留“token 无效”等永久摘要，
    // 但子通道仍可能有超时/限流。只要任一子错误可重试，就必须保留重试机会。
    if (Array.isArray(info.failures) && info.failures.length > 0) {
        const nested = info.failures.map(classifyOne);
        if (nested.some(x => x.kind === 'retryable')) {
            return { kind: 'retryable', reason: 'MIXED_CHANNEL_FAILURES', info };
        }
        if (nested.some(x => x.kind !== 'permanent')) {
            return { kind: 'retryable', reason: 'UNKNOWN_CHANNEL_FAILURE', info };
        }
        return { kind: 'permanent', reason: 'ALL_CHANNELS_PERMANENT', info };
    }

    if (info.failureKind === 'retryable' || info.failureKind === 'permanent') {
        return { kind: info.failureKind, reason: info.failureReason || 'EXPLICIT', info };
    }
    const code = String(info.code || '').toUpperCase();
    const status = Number.isInteger(info.statusCode) ? info.statusCode : null;
    const errorName = String(info.name || '').toUpperCase();
    const providerCode = String(info.providerCode || '').toUpperCase();
    const channel = String(info.channel || '').toLowerCase();
    const message = String(info.message || '').toLowerCase();
    const permanentMessage = /接口返回数据格式异常|未配置任何推送通道|invalid\s+url|module\s+not\s+found|证书.*(主机|域名)|主机名.*证书/.test(message)
        || /(?:unauthori[sz]ed|forbidden|bad request|not found|invalid\s+(?:token|key|parameter)|(?:token|key|密钥).*(?:invalid|invalidated|无效|错误|不存在|过期))/.test(message)
        || /(?:参数|配置).*(?:错误|无效|非法)/.test(message);

    if (errorName === 'SYNTAXERROR' || errorName === 'REFERENCEERROR') {
        return { kind: 'permanent', reason: errorName, info };
    }
    if (codeIs(code, RETRYABLE_CODES)) return { kind: 'retryable', reason: code, info };
    if (codeIs(code, PERMANENT_CODES)) return { kind: 'permanent', reason: code, info };
    if (channel.includes('wxpusher') && providerCode) {
        if (providerCode === '1001' || /(?:限流|限频|rate.?limit|速度太快)/.test(message)) {
            return { kind: 'retryable', reason: 'WXPUSHER_RATE_LIMIT', info };
        }
        return { kind: 'permanent', reason: `WXPUSHER_${providerCode}`, info };
    }
    if (channel.includes('企业微信') && providerCode) {
        if (providerCode === '45009') {
            return { kind: 'retryable', reason: 'QYWX_RATE_LIMIT', info };
        }
        // v3.232：仅明确配置类错误判永久（key/token 无效、缺 token、无权限、webhook 未找到）；
        // 其余（如 500 系统繁忙）落回通用分类（5xx → retryable），防瞬时错误误判永久导致常驻停止重试、消息丢失
        if (['40014', '41001', '42001', '45001', '130101'].includes(providerCode)) {
            return { kind: 'permanent', reason: `QYWX_${providerCode}`, info };
        }
    }
    if (permanentMessage) {
        return { kind: 'permanent', reason: 'CONFIG_OR_CONTRACT', info };
    }
    const numericCode = Number(code);
    if (code === '1001' || code === '429' || (Number.isInteger(numericCode) && numericCode >= 500 && numericCode <= 599)) {
        return { kind: 'retryable', reason: `PROVIDER_${code}`, info };
    }
    if (Number.isInteger(numericCode) && numericCode >= 400 && numericCode < 500) {
        return { kind: 'permanent', reason: `PROVIDER_${code}`, info };
    }
    if (providerCode === '1001' || /(?:限流|限频|rate.?limit)/.test(message)) {
        return { kind: 'retryable', reason: 'PROVIDER_RATE_LIMIT', info };
    }
    const providerNumber = Number(providerCode);
    if (Number.isInteger(providerNumber) && providerNumber >= 400 && providerNumber < 500) {
        return { kind: 'permanent', reason: `PROVIDER_${providerNumber}`, info };
    }
    if (Number.isInteger(providerNumber) && providerNumber >= 500 && providerNumber <= 599) {
        return { kind: 'retryable', reason: `PROVIDER_${providerNumber}`, info };
    }
    if (code.startsWith('HTTP_')) {
        const n = Number(code.slice(5));
        if (n === 408 || n === 409 || n === 425 || n === 429 || n >= 500) {
            return { kind: 'retryable', reason: code, info };
        }
        if (n >= 400 && n < 500) return { kind: 'permanent', reason: code, info };
    }
    if (status !== null) {
        if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
            return { kind: 'retryable', reason: `HTTP_${status}`, info };
        }
        if (status >= 400 && status < 500) return { kind: 'permanent', reason: `HTTP_${status}`, info };
    }

    if (/(?:timeout|timed out|超时|econn|eai_again|enet|ehost|epipe|socket|rate.?limit|限流|限频|暂时|服务.*(?:不可用|繁忙)|连接.*(?:失败|重置))/.test(message)) {
        return { kind: 'retryable', reason: 'TRANSIENT_TEXT', info };
    }

    // 未知错误默认可重试：重复几轮的代价低于误判后永久漏推。
    return { kind: 'retryable', reason: 'UNKNOWN', info };
}

function classifyFailure(error) {
    const explicitKind = readProp(error, 'failureKind');
    const nested = readProp(error, 'failures');
    // 聚合失败的子错误优先于父级预填标签，避免父级 permanent 覆盖子级 retryable。
    if ((explicitKind === 'retryable' || explicitKind === 'permanent') && !(Array.isArray(nested) && nested.length > 0)) {
        return { kind: explicitKind, reason: readProp(error, 'failureReason') || 'EXPLICIT', info: summarizeError(error) };
    }
    return classifyOne(error);
}

function classifySummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const total = Number(summary.total) || 0;
    const pushed = Number(summary.pushed) || 0;
    const failed = Number(summary.failed) || 0;
    // 有失败消息时进入分类；纯部分成功且剩余失败均为可重试/未知时继续，明确永久失败则停止。
    if (total <= 0 || failed <= 0) return null;
    const failures = Array.isArray(summary.failures) ? summary.failures : [];
    if (failures.length === 0) {
        return pushed > 0
            ? null
            : { kind: 'retryable', reason: 'ALL_PUSH_FAILED_UNKNOWN', info: { message: '推送全部失败（原因未结构化）' } };
    }
    // 主流程契约：一条消息至少有一个通道成功即视为该消息处理成功。
    // 因此只要本轮已有成功推送，就不能因另一个通道的永久错误让单次/常驻入口熔断；
    // 失败通道不对该条消息立即重试，避免重复轰炸。只有全失败才进入退出/重试分类。
    if (pushed > 0) return null;
    const nested = failures.map(classifyOne);
    const hasRetryable = nested.some(x => x.kind === 'retryable');
    const hasPermanent = nested.some(x => x.kind === 'permanent');
    // 全部失败时，混合原因中只要还有可恢复通道，就不能过早永久停止；
    // 只有不存在可重试原因时，永久错误才足以停止。
    if (hasRetryable) {
        return { kind: 'retryable', reason: 'PUSH_HAS_RETRYABLE_FAILURE', info: { failures: nested.map(x => x.info) } };
    }
    if (hasPermanent) {
        return { kind: 'permanent', reason: 'PUSH_HAS_ONLY_PERMANENT_FAILURES', info: { failures: nested.map(x => x.info) } };
    }
    // 全部失败且无法分类：保守重试，避免未知错误造成永久漏推。
    return { kind: 'retryable', reason: 'PUSH_HAS_UNKNOWN_FAILURE', info: { failures: nested.map(x => x.info) } };
}

module.exports = {
    RETRYABLE_CODES,
    PERMANENT_CODES,
    summarizeError,
    classifyFailure,
    classifySummary,
};
