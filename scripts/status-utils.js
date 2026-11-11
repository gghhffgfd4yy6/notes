'use strict'

// ============================================================
// status（控制台 / --status）侧身份语义用的轻量 Utils 实例（唯一职责，不含任何读写逻辑）。
//
// 为什么单独成模块：scripts/status.js 只读命令不加载 xbk_function_v3（否则会把整套 App 依赖拉进
// `--status`），却要用 xbk_utils 的同一份 getMessageIdentity/sameMessageIdentity 回放判重日志，
// 于是这里用 createUtils 建一个轻量实例。代价是 safeRe 退化成 `new RegExp(src, flags)`——
// Codacy/Opengrep 的 dos-non-literal-regexp 规则看到「构造函数参数是变量」就报 ReDoS，无法区分
// 这里的 src 全是 xbk_utils 内部的**模块常量正则源**（ENTITY_RE ← 冻结的 ENTITY_MAP、
// ACTIVE_TAG_ALT ← 冻结的 ACTIVE_TAGS、NAV、'%'/反斜杠/管道），而 push.json 与日志里的
// title/content/url 只作 String.prototype.replace 的 subject、从不进正则源。
// 按仓库惯例（同 scripts/filter-rules-paths.js、scripts/message-signature.js），把这类
// 单一形态的构造抽到只做这件事的模块，只排除该模块，避免整文件排除 scripts/status.js——
// 那样会把 900 多行生产读路径（安全读取/容错解析/排序/分类/缓存签名）的告警一起静默。
//
// 安全事实（与 .codacy.yml 的排除理由一一对应）：
//   · 本实例不接收外部输入：safeRe 的 src/flags 只来自 xbk_utils 的模块常量；
//   · 传进来的 fs 只用于 xbk_utils 内部的只读判断，本模块不拼路径、不读写文件；
//   · 行为与原 status.js 内的内联实例逐字等价（同一 createUtils、同一 safeRe 形态）。
// ============================================================

const fs = require('node:fs')
const { createUtils } = require('../xbk_utils')

const statusUtils = createUtils({ fs, safeRe: (src, flags) => new RegExp(src, flags) })

module.exports = { statusUtils }
