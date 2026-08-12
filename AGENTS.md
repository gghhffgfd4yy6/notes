# AGENTS.md — 项目操作规范

## 项目简介

线报酷推送（xbk-push）：抓取线报 → 过滤 → 去重 → 多通道推送。
Node.js 单文件主程序 + 模块化测试文件 + 双远程 Git 仓库。

## 铁律（违反 = 事故）

1. **先备份再破坏**：涉及 `.git` 内部 / 删除 / 破坏性操作前，必须先 `git bundle create <原因>-<日期>.bundle --all` 并 `git bundle verify` 验证，再执行。
2. **绝不手动删 `.git/objects` 下文件**（即使文件名像垃圾）。Git 内部清理一律用官方命令 `git gc --prune=now`。
3. **验证再声称完成**：任何"完成 / 修复 / 通过"的结论，必须先跑验证命令拿到输出证据。没有当轮证据不得声称。
4. **文档不写易过时数字**：README / 文档不写版本号、测试数量、性能耗时、配置默认值等（代码一变就过期）。版本一致性由测试自动校验。

## 开发流程

```
备份（如涉及破坏性操作）→ git status → 修改 → npm test（全量必须绿）
→ git diff --stat 确认改动范围 → 原子提交 → 推送（确认分支/远程）
```

## 测试命令

| 命令 | 用途 |
|---|---|
| `npm test` | 一键全量（单元 + 集成并行 + 通道），提交前必跑 |
| `npm run test:filter` | 单元测试（含版本一致性 101 章校验）|
| `npm run test:app` | 集成测试（并行调度，快）|
| `npm run test:app:serial` | 集成测试（串行完整版，绝对验证用）|
| `npm run test:notify` | 推送通道测试 |
| `npm run test:mutation` | 变异测试（重，只在开发机跑）|

## 提交规范（原子提交）

- 一次提交只做一件事；message 格式：`fix:` / `feat:` / `refactor:` / `docs:` / `chore:` + 一句话说明 + 必要背景
- 改版本必须三方同步：文件头 ↔ CHANGELOG ↔ package.json（101 章测试自动校验，改一处漏两处会红）

## 推送规范

- 双远程：GitHub（`origin`）+ Gitee（`gitee`），**两个都推**
- push 前确认目标分支 / 远程，不覆盖他人工作；先 `git fetch` 看差异再推
- **禁止用浅克隆（`--depth 1`）操作远程**：会截断历史，导致"unrelated histories"误判（2026-08-12 教训：差点覆盖 Gitee 完整历史）
- 需要完整历史时：`git fetch --unshallow`

## 审查流程

- 完整流程见 `.ai/README.md`（观察者 → 候选池 → 裁判 → 执行者 → 独立复核）
- 五轴审查清单见 `.ai/skills/code-review-and-quality/`：正确性 / 可读性 / 架构 / 安全 / 性能
- CI 质量门禁见 `.github/workflows/`（GitHub Actions）与 `.workflow/`（Gitee Go）
