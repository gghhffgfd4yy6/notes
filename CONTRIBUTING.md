# 贡献指南

感谢你愿意参与贡献！

## 开发流程（个人 + AI 辅助）

本仓库以 **main 为主分支**，采用「并行认知、串行状态变更」原则：

```
Codex / 本地开发
  ↓
feature/fix/review 分支
  ↓
本地验证（npm run check）
  ↓
PR → main
  ↓
GitHub Actions 门禁（lint / 版本一致性 / 单元 / 集成 / 安全）
  ↓
Squash Merge → main
```

1. 新建分支（`fix/描述`、`feat/描述` 或 `review/描述`），**不要直接改 main**
2. 提交前必须：
   - 通过全部测试（`npm test`，集成走并行调度器）
   - 通过 lint（`npm run lint`）与版本一致性校验（`node check-version.js`）
   - 不添加容易过时的数字到文档
3. 提交 PR → 目标分支 **main** → 等 GitHub Actions 全绿 → Squash Merge
4. 合并由维护者确认（个人仓库不强制 reviewer，但 CI 门禁必须全绿）

## 开发环境

- Node.js：`>=22.22.2`（见 package.json engines；CI 矩阵 22.22.2/24）
- 测试：`npm test`（并行调度器）

## 代码风格

- 保持已有风格（CommonJS + 中文注释）
- 新增功能必须补测试（单元 + 集成）
- 涉及性能/安全的修改优先做变异测试

## 注意

- main 分支保护已开启：禁止 force push / 删除，必须走 PR，CI 全绿才能合并
- 高风险改动（缓存/判重契约、推送行为、配置兼容性、网络请求、ReDoS 防护）必须在 PR 描述中明确说明影响范围与回滚方式
- 不要提交任何 Token / API Key / Cookie（`push_config.local.js` 等本地配置已被 gitignore）
