# 贡献指南

感谢你愿意参与贡献！

## 流程

1. **先开 Issue** 讨论（避免重复劳动）
2. Fork 仓库 → 新建分支（`fix/描述` 或 `feat/描述`）
3. 提交前必须：
   - 通过全部测试（`node run_tests.js`）
   - 通过 pre-commit 校验
   - 不添加容易过时的数字到文档
4. 提交 PR → 等待 CI checks 通过 → 等待机器人审查（CodeAnt/CodeRabbit）
5. 所有机器人评论 resolve 后才能合并

## 开发环境

- Node.js（见 package.json engines）
- 测试：`npm test`（并行调度器）

## 代码风格

- 保持已有风格（CommonJS + 中文注释）
- 新增功能必须补测试（单元 + 集成）
- 涉及性能/安全的修改优先做变异测试

## 注意

- 分支保护已开启：master 不能直接 push，必须走 PR
- PR 需要 1 个批准 + Test/CodeQL checks 通过
