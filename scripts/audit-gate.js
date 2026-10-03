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
  // schema 漂移防护：vulnerabilities 缺失/非对象时判为基础设施异常，fail-closed（任务2 审查 finding）
  if (!data || typeof data.vulnerabilities !== 'object' || data.vulnerabilities === null || Array.isArray(data.vulnerabilities)) {
    console.error('❌ audit-result.json 缺少 vulnerabilities 字段（npm audit 可能异常失败/网络错误/schema 漂移），fail-closed 拒绝放行')
    process.exit(1)
  }
  const vulns = data.vulnerabilities
  const entries = Object.values(vulns)
  // severity 归一化：防御大小写变体被静默放行（任务2 审查 finding）
  const high = entries.filter(v => String(v.severity || '').toLowerCase() === 'high' || String(v.severity || '').toLowerCase() === 'critical')
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
      // via 全是依赖名字字符串（间接漏洞，如 got ← cacheable-request）：按 via 链逐跳溯源到根
      // advisory（CodeRabbit Major finding：不得用「存在任意被豁免条目」的全局启发式，
      // 否则未来新增豁免时无关的传递节点会被连带放行）。链断裂/成环/指向未豁免条目 → 一律 block。
      const byName = new Map(entries.map(e => [e.name, e]))
      const visited = new Set([v.name])
      let current = v
      let allowed = false
      let broken = false
      while (true) {
        const viaNames = (Array.isArray(current.via) ? current.via : []).filter(x => typeof x === 'string')
        if (viaNames.length === 0) { broken = true; break } // 链断：无法证明来源，保守 block
        const nextName = viaNames[0]
        if (visited.has(nextName)) { broken = true; break } // 环：保守 block
        visited.add(nextName)
        const next = byName.get(nextName)
        if (!next) { broken = true; break } // via 指向 vulnerabilities 中不存在的条目：信息不足，保守 block
        const nextAdvisories = (Array.isArray(next.via) ? next.via : []).filter(x => typeof x === 'object' && x.url)
        if (nextAdvisories.length > 0) {
          // 根 advisory 节点：仅当其全部 advisory 均在豁免清单才放行
          allowed = nextAdvisories.every(a => ALLOWED_ADVISORIES.has(urlGhsa(a.url)))
          break
        }
        current = next
      }
      if (!broken && allowed) hitAllowed.push(v.name)
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
    const open = item.indexOf('(')
    const close = item.lastIndexOf(')')
    const ghsaId = open >= 0 && close > open ? item.slice(open + 1, close) : ''
    const reason = ghsaId ? (ALLOWED_ADVISORIES.get(ghsaId) || '') : ''
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
