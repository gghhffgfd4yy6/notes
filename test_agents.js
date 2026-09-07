'use strict'

const assert = require('assert')
const {
  profileMs,
  shouldInvalidateDns,
  baseRequestOptions,
  invalidateDnsForError,
  invalidateDns
} = require('./xbk_agents')

;(async () => {
  // ===== profileMs：有限数值四舍五入，否则 'n/a' =====
  assert.strictEqual(profileMs(123.6), 124, '有限数值应四舍五入')
  assert.strictEqual(profileMs(0), 0, '0 应保留')
  assert.strictEqual(profileMs(2.4), 2, '2.4 应四舍五入为 2')
  assert.strictEqual(profileMs(Number.NaN), 'n/a', 'NaN 应为 n/a')
  assert.strictEqual(profileMs(Infinity), 'n/a', 'Infinity 应为 n/a')
  assert.strictEqual(profileMs(-Infinity), 'n/a', '-Infinity 应为 n/a')
  assert.strictEqual(profileMs('5'), 'n/a', '字符串不应被接受')

  // ===== shouldInvalidateDns：仅 DNS/连接类错误码触发 =====
  assert.strictEqual(shouldInvalidateDns({ code: 'ENOTFOUND' }), true, 'ENOTFOUND 应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'ECONNRESET' }), true, 'ECONNRESET 应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'EAI_AGAIN' }), true, 'EAI_AGAIN 应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'HTTP_500' }), false, 'HTTP 错误不应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({ code: 'ETIMEDOUT' }), false, '超时不应失效 DNS')
  assert.strictEqual(shouldInvalidateDns({}), false, '无 code 不应失效')
  assert.strictEqual(shouldInvalidateDns(null), false, 'null 不应失效')
  assert.strictEqual(shouldInvalidateDns(undefined), false, 'undefined 不应失效')

  // ===== baseRequestOptions：组合默认请求选项 =====
  const opts = baseRequestOptions()
  assert.ok(opts.agent, '应含 agent')
  assert.strictEqual(typeof opts.lookup, 'function', '应含 lookup（dnsLookup）')
  let expectedFamily = ''
  if (process.env.XBK_DNS_FAMILY === '4') expectedFamily = 'ipv4'
  else if (process.env.XBK_DNS_FAMILY === '6') expectedFamily = 'ipv6'
  if (expectedFamily) {
    assert.strictEqual(opts.dnsLookupIpVersion, expectedFamily, 'XBK_DNS_FAMILY 应映射为对应 dnsLookupIpVersion')
  } else {
    assert.ok(!('dnsLookupIpVersion' in opts), '未设置 XBK_DNS_FAMILY 时不应带 dnsLookupIpVersion')
  }

  // ===== invalidateDnsForError：DNS 错误 + 可解析 URL → 失效并返回 true =====
  assert.strictEqual(invalidateDnsForError({ code: 'ENOTFOUND' }, 'https://example.com/api/x'), true, 'DNS 错误应触发缓存失效')
  assert.strictEqual(invalidateDnsForError({ code: 'ECONNRESET' }, 'https://example.com/'), true, '连接错误应触发缓存失效')
  assert.strictEqual(invalidateDnsForError({ code: 'HTTP_500' }, 'https://example.com'), false, '非 DNS 错误不失效')
  assert.strictEqual(invalidateDnsForError({ code: 'ENOTFOUND' }, 'not a url'), false, 'URL 解析失败应返回 false')
  assert.strictEqual(invalidateDnsForError(null, 'https://example.com'), false, 'null 错误不失效')

  // ===== invalidateDns：非法/未缓存 hostname 返回 0，不抛错 =====
  assert.strictEqual(invalidateDns(''), 0, '空串 hostname 返回 0')
  assert.strictEqual(invalidateDns(null), 0, 'null hostname 返回 0')
  assert.strictEqual(invalidateDns(123), 0, '非字符串 hostname 返回 0')
  assert.strictEqual(invalidateDns('no.such.host.in.cache.example'), 0, '未缓存 hostname 返回 0')

  console.log('test_agents OK')
})().catch((e) => { console.error(e); process.exit(1) })
