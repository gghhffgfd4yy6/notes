# 贡献

- 从 `main` 新建 `fix/*`、`feat/*` 或 `docs/*` 分支（CI/工具链改动用 `ci/*`）；不要直接修改 `main`。
- 改动后先跑受影响测试；常规代码改动跑 `npm run check`（= `npm run lint` → `node check-version.js` → `node scripts/check-mutation-ranges.js` → `npm test`；别名 `npm run verify`）。至少必须包含 `npm test`、`npm run lint`、`node check-version.js`。
- 本地钩子：`npm run hooks:install` 注册 `.githooks`（`pre-commit` 跑 lint / 版本闸门 / 变异行段校验（约 20s），`pre-push` 跑 `npm run test:filter`（约 60s，推送前拦截；校验的是**被推提交的内容**——工作树脏或推的不是当前 HEAD 时改在临时 worktree 里检出该提交再跑，建不起来则 fail-closed）；`commit-msg` 要求首行以 `fix: feat: refactor: docs: chore: style: test: perf: revert: build: ci:` 之一开头且不超过 100 字符）。npm 不会自动注册仓库钩子，克隆后**必须显式装一次**；装完跑 `npm run hooks:verify` 确认门禁真的生效（只读，未生效 exit 1）。
- 高风险改动（判重、缓存、推送、配置、网络、正则、文件存储）须补回归测试，并在 PR 说明影响与回滚方式。
- 改动带行段的文件（`xbk_function_v3.js`、`xbk_sendNotify_slim.js`）后同步重拆 `.github/workflows/mutation.yml` 行段并跑 `node scripts/check-mutation-ranges.js`；增删 `test_*.js` 或改 `test.yml` 显式步骤时同步 `test_suites.js` 与 `SKIP_SUITES`。
- 变异**分数门禁**（CI）：`stryker.config.js` 的 `thresholds.break = 65`，CI 上按**段**判定——某段 `mutationScore` 跌破 65，该矩阵 job 红（其余段照跑，`report` job 仍发日报）。本地 `npm run test:mutation` 用同一阈值、但按**全量**分数判定（合计基线 81.27%），因此本地实际只会在整体跌到 65 以下时才非 0 退出。阈值低于实测最低段（`message-store` 69.38%），CI 上某段真实退化 4 个百分点以上即会拦下；回退＝把 `break` 改回 `null`。日报里的合计/分段分数是观察基线，不是门禁口径。
- 发版：先把版本号同步四处（`xbk_function_v3.js` 文件头、`CHANGELOG.md` 新增 `## vX.Y` 段、`package.json`、`package-lock.json` 的顶层 `version` 与 `packages[""].version`），跑 `node check-version.js` 看到「版本四方一致」。CI 全绿后在 `main` 上打 tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`；无需手动建 Release。
- CI 全绿后使用 Squash Merge。
- 不提交 Token、API Key、Cookie 或 `push_config.local.js`。
