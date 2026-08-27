# 贡献

- 从 `main` 新建 `fix/*`、`feat/*` 或 `docs/*` 分支；不要直接修改 `main`。
- 改动后运行受影响测试；常规代码改动运行 `npm test`、`npm run lint`、`node check-version.js`。
- 高风险改动（判重、缓存、推送、配置、网络、正则）须补回归测试，并在 PR 说明影响与回滚方式。
- CI 全绿后使用 Squash Merge。
- 不提交 Token、API Key、Cookie 或 `push_config.local.js`。
