#!/usr/bin/env node
'use strict'
/*
 * 反回归闸：禁止在测试里新增「读源码文本」的断言。
 *
 * 为什么：源码文本断言会随格式化、插桩、注释调整而误红（2026-11-15 mutation 13 段集体误红即此类），
 * 且注释里出现同样字面量时又永远为真。这类断言应改成三种形态之一：
 *   ① 行为断言（跑真实逻辑看结果）  ② AST 断言（test_support/source_model.js）  ③ 配置断言（YAML/JSON/shlex 解析后比字段）
 *
 * 现存条目全部冻结在 scripts/source-text-assert.allowlist.json（只减不增）。命中 (文件, 字面量) 且在白名单里
 * 才放行；新增即红。白名单的 `count` 必须等于 `items.length`——否则 exit 2（防手删条目不改计数，
 * 那会让闸门静默放宽而输出仍然好看）。
 *
 * 退出码：0 无新增 / 1 有新增 / 2 白名单形状非法（count 漂移、条目形状错、文件不可读） / 2 扫描失败。
 * 白名单由 `node scripts/check-source-text-asserts.js --write-allowlist` 生成（改基线才用，正常不要跑）。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const ALLOW_FILE = path.join(__dirname, 'source-text-assert.allowlist.json')
const ALLOW_REL = path.relative(ROOT, ALLOW_FILE)

// 「源码文本」变量：来自 readFileSync / codeOf / 剥注释后的字符串。
// 拆成两步（先认声明，再看等号之后的同一段右值里有没有读取调用）而不是一条
// `(?:[^;\n]*readFileSync|codeOf|…)` 的大正则：后者在「整行都没有读取调用」时要对 `[^;\n]*`
// 逐位置回溯，回溯面随行宽线性增长（Sonar S8786 超线性回溯，每个 test_*.js 的每一行都要过一遍）。
const READ_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g
const READ_CALL = /(?:readFileSync|codeOf|codeOnly|stripComments?)\s*\(/
const LIT_CALL = /\.(includes|indexOf|startsWith|match)\(\s*(['"])((?:\\.|(?!\2).){1,200})\2/g
const METHODS = 'includes|indexOf|startsWith|match'

// 正则元字符的完整转义（`.` `*` `+` `?` `^` `$` `{` `}` `(` `)` `|` `[` `]` `\`）。
// 只把 `$` 转义是不完整净化：名字里出现别的元字符会改变 new RegExp 的含义（CodeQL js/incomplete-sanitization）。
// 标识符来源仍是白名单里的 `[A-Za-z_$][\w$]*`，这里只把它当数据按「任意字符串」处理。
const REGEX_META = /[.*+?^${}()|[\]\\]/g
const escapeRegExp = (s) => s.replace(REGEX_META, '\\$&')

// 等号之后的右值：同一行内直到 `;` 或换行（与旧模式 `[^;\n]*` 的扫描面一致）。
// 用显式游标而不是 `src.slice(from).search(...)`——后者每认一个声明就整段复制一次，大文件上是 O(n²)。
function rightValueAt (src, from) {
  let end = from
  while (end < src.length && src[end] !== '\n' && src[end] !== ';') end++
  return src.slice(from, end)
}

// 逐声明判定：右值里出现读取调用才算「源码文本变量」。
function sourceReadVars (src) {
  const vars = new Set()
  for (const m of src.matchAll(READ_DECL)) {
    if (READ_CALL.test(rightValueAt(src, m.index + m[0].length))) vars.add(m[1])
  }
  return vars
}

function die (code, message) {
  console.error(message)
  process.exit(code)
}

// 逐文件找「读源码文本的变量 → 对该变量调 includes/indexOf/startsWith/match(字面量)」。
// 命中记 (file, line, literal)；白名单按 (file, literal) 比对，故行号平移（加注释、插用例）不算新增。
function scanFile (file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const vars = sourceReadVars(src)
  let m
  if (!vars.size) return []
  const hits = []
  vars.forEach((v) => {
    const re = new RegExp('\\b' + escapeRegExp(v) + '\\s*\\.\\s*(' + METHODS + ')\\(\\s*([\'"])((?:\\\\.|(?!\\2).){1,200})\\2', 'g')
    while ((m = re.exec(src)) !== null) {
      hits.push({ file, line: src.slice(0, m.index).split('\n').length, literal: m[3] })
    }
  })
  // 行内直读：readFileSync(...).toString().includes('…')（不经过中间变量，上面的变量追踪抓不到）
  src.split('\n').forEach((line, i) => {
    if (!/readFileSync\([^)]*\)[^;]*\.(includes|indexOf|match)\(/.test(line)) return
    const mm = LIT_CALL.exec(line)
    LIT_CALL.lastIndex = 0
    if (mm) hits.push({ file, line: i + 1, literal: mm[3] })
  })
  return hits
}

function scanAll () {
  const files = fs.readdirSync(ROOT).filter((f) => /^test_.*\.js$/.test(f)).sort()
  const hits = []
  files.forEach((f) => {
    try {
      hits.push(...scanFile(f))
    } catch (e) {
      die(2, '扫描失败 ' + f + ': ' + e.message)
    }
  })
  return hits
}

// 按文件分组统计（降序，同数按文件名码元序）：每个包处理完后按此核对「该文件白名单条数下降了多少」。
function byFile (items) {
  const counts = new Map()
  for (const item of items) counts.set(item.file, (counts.get(item.file) || 0) + 1)
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

function printByFile (title, items) {
  console.log(title)
  const rows = byFile(items)
  if (!rows.length) {
    console.log('  （无）')
    return
  }
  rows.forEach(([file, count]) => console.log(`  ${file} ${count}`))
}

function assertAllowlistShape (raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    die(2, `❌ 白名单形状非法（${ALLOW_REL}）：缺少 items 数组`)
  }
  if (!Number.isInteger(raw.count)) {
    die(2, `❌ 白名单形状非法（${ALLOW_REL}）：count 必须是整数，实得 ${JSON.stringify(raw.count)}`)
  }
  // 核心校验：count 与 items.length 不一致说明有人手删/手改条目而没同步计数——此时闸门口径已不可信，
  // 既不按 count 也不按 items 放行，直接 exit 2（fail-closed，别让它以「全绿」的样子继续跑）。
  if (raw.count !== raw.items.length) {
    die(2, `❌ 白名单计数漂移（${ALLOW_REL}）：count=${raw.count}，items.length=${raw.items.length}。` +
      '删条目必须同时改 count（或重跑 --write-allowlist）。')
  }
  raw.items.forEach((item, i) => {
    if (!item || typeof item.file !== 'string' || typeof item.literal !== 'string') {
      die(2, `❌ 白名单第 ${i + 1} 条形状非法（${ALLOW_REL}）：需要 {file, literal} 两个字符串字段`)
    }
  })
  return raw
}

function readAllowlist () {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'))
  } catch (e) {
    die(2, `❌ 白名单不可读或不是合法 JSON（${ALLOW_REL}）：${e.message}`)
  }
  return assertAllowlistShape(raw)
}

function writeAllowlist (hits) {
  const body = JSON.stringify({
    note: '冻结清单：只减不增。新增源码文本断言一律红（scripts/check-source-text-asserts.js）。',
    count: hits.length,
    items: hits
  }, null, 2) + '\n'
  fs.writeFileSync(ALLOW_FILE, body)
  console.log(`已写入白名单 ${hits.length} 条 → ${ALLOW_REL}`)
  printByFile('按文件分布：', hits)
}

function main () {
  const hits = scanAll()
  if (process.argv.includes('--write-allowlist')) {
    writeAllowlist(hits)
    return
  }
  const allow = readAllowlist()
  const allowed = new Set(allow.items.map((x) => x.file + '\u0000' + x.literal))
  const violations = hits.filter((h) => !allowed.has(h.file + '\u0000' + h.literal))
  console.log(`源码文本断言：${hits.length} / ${allow.count}（现存命中 / 白名单冻结）`)
  if (violations.length) {
    printByFile('白名单外命中（按文件）：', violations)
    console.error(`❌ 新增 ${violations.length} 处源码文本断言（禁止）：`)
    violations.slice(0, 40).forEach((v) => console.error(`  ${v.file}:${v.line}  ${JSON.stringify(v.literal).slice(0, 80)}`))
    if (violations.length > 40) console.error(`  …还有 ${violations.length - 40} 处未列出`)
    console.error('改成行为断言 / AST 断言（test_support/source_model.js）/ 配置解析断言，见 AGENTS.md「断言形态」')
    process.exit(1)
  }
  printByFile('按文件分布（现存命中）：', hits)
  if (allow.count !== hits.length) {
    // 白名单只减不增：命中变少是**好事**（说明有包替换掉了），只是提醒同步收敛白名单，
    // 不判红——否则会把「已替换」这个正确行为判成失败。
    console.log(`ℹ️ 白名单比实测多 ${allow.count - hits.length} 条（已有断言被替换）；可以删掉多余条目并同步 count。`)
  }
  console.log('✅ 未新增源码文本断言')
}

main()
