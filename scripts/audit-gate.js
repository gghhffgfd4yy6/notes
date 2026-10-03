#!/usr/bin/env node
// 审计门禁：npm audit 结果审查器（fail-closed）。
// 背景：GHSA-ch52-4w7c-c8xp（http-cache-semantics <=4.2.0，CVSS 7.5）为 got@11 的传递依赖，
// 该 advisory 覆盖所有已发布版本（无修复版可升），got@11 已停止维护。经仓库所有者确认
// （PR #194）对该 advisory 显式豁免：命中时以 GitHub Actions warning 注解显形，不静默。
// 复查条件：got 官方发布含修复版的版本、或项目替换/升级 got 时，必须移除豁免并回归本门禁。
// 本脚本不豁免任何其他 advisory：凡存在非豁免的高危漏洞一律 exit 1。
'use strict'
const fs = require('fs')

// 唯一豁免条目：advisory GHSA id → 豁免理由（会打进 warning 注解，供审计追溯）
const ALLOWED_ADVISORIES = new Map([
  ['GHSA-CH52-4W7C-C8XP', 'http-cache-semantics<=4.2.0 全版本中招且无修复版；got@11 传递依赖已停更；项目用法为直连推送 API，cacheable-request 缓存路径不生效，实际暴露面趋近于零（PR #194 豁免）']
])

function main () {
  let raw
  try {
    raw = fs.readFileSync('audit-result.json', 'utf8')
  } catch (e) {
    console.error('❌ 无法读取 audit-result.json：', e.message)
    process.exit(1)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    console.error('❌ audit-result.json 不是合法 JSON：', e.message)
    process.exit(1)
  }
  const vulns = (data && data.vulnerabilities) || {}
  const entries = Object.values(vulns)
  const high = entries.filter(v => v.severity === 'high' || v.severity === 'critical')
  if (high.length === 0) {
    console.log('✅ 安全审计通过：无高危及以上漏洞')
    return
  }
  // 收集命中的 advisory：via 里的直接 advisory（source/GHSA url）+ 间接链上引用的 advisory
  const hitAllowed = []
  const hitBlocked = []
  for (const v of high) {
    const vias = Array.isArray(v.via) ? v.via : []
    const advisories = vias.filter(x => typeof x === 'object' && x.url)
    if (advisories.length === 0) {
      // via 全是依赖传递（如 got ← cacheable-request）：溯源到根 advisory，跟随其判定
      // 传递节点的 via 链最终指向直接 advisory；这里保守处理：看 vulnerabilities 里是否有被豁免的直接 advisory
      const rootAllowed = entries.some(other =>
        other !== v && (other.severity === 'high' || other.severity === 'critical') &&
        (Array.isArray(other.via) ? other.via : []).some(x => typeof x === 'object' && x.url && ALLOWED_ADVISORIES.has(urlGhsa(x.url)))
      )
      if (rootAllowed) hitAllowed.push(v.name)
      else hitBlocked.push(v.name)
      continue
    }
    const allAllowed = advisories.every(a => ALLOWED_ADVISORIES.has(urlGhsa(a.url)))
    if (allAllowed) {
      for (const a of advisories) hitAllowed.push(`${v.name}(${urlGhsa(a.url)})`)
    } else {
      hitBlocked.push(v.name)
    }
  }
  for (const item of hitAllowed) {
    const ghsa = /\(([^)]+)\)/.exec(item)
    const reason = ghsa ? (ALLOWED_ADVISORIES.get(ghsa[1]) || '') : ''
    console.log(`::warning title=安全审计豁免显形::${item} 被显式豁免：${reason}`)
    console.log(`  ⚠️ 豁免：${item}`)
  }
  if (hitBlocked.length > 0) {
    console.error(`❌ 安全审计失败：存在未豁免的高危漏洞：${hitBlocked.join(', ')}`)
    process.exit(1)
  }
  console.log('✅ 安全审计通过（豁免条目已上方显形；豁免清单见 scripts/audit-gate.js ALLOWED_ADVISORIES）')
}

function urlGhsa (url) {
  const m = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(String(url))
  return m ? m[0].toUpperCase() : ''
}

main()
