# 项目规则

xbk-push：个人青龙**单实例**线报推送脚本。

## 必守

- 不提交密钥、缓存或本地配置。
- 破坏性 Git 操作前：`git bundle create backup.bundle --all && git bundle verify backup.bundle`；不得手动删除 `.git/objects`，清理使用 `git gc --prune=now`。
- 修改后先验证再称完成；提交前至少运行受影响测试，常规改动跑 `npm run check`。
- 一次提交只做一件事；改版本时同步主文件头、`CHANGELOG.md`、`package.json`。
- 推送前确认分支和远程；只需推送 `origin`（2026-09-14 起 Gitee 镜像与 `.workflow/master-pipeline.yml` 已废弃移除，不再双推）。禁止浅克隆处理远程历史。

## 常用命令

```bash
npm run check                 # = lint → 版本闸门 → 变异行段校验 → npm test
npm test
npm run test:filter
npm run test:app
npm run test:notify
npm run test:mutation
npm run test:mutation-ranges  # 校验矩阵行段覆盖（改带行段的文件后必跑）
```

## 大文件与变异行段（改动前必读）

`.github/workflows/mutation.yml` 的 `mutate` 行段是硬编码的；v3.270 曾因文件增长静默漏测尾部 430 行。改动带行段的文件（当前为 `xbk_function_v3.js`、`xbk_sendNotify_slim.js`）后：

1. 同步重拆该文件在 matrix `include` 中的行段：连续、不重叠、覆盖到实际行数。
2. 运行 `node scripts/check-mutation-ranges.js`（或 `npm run test:mutation-ranges`）校验：行段全覆盖与连续性、`name`/`src`/`mutate` 三字段齐全且 `src` 与 mutate 目标一致、运行链上的生产文件全部列为 mutate 目标、段名与 `scripts/mutation-report.js` 的 `EXPECTED_SEGMENTS` 双向一致、`stryker.config.js` 与矩阵一致。

## 测试与文档门禁

- `npm run hooks:install` 注册 `.githooks`：`pre-commit` 跑 lint / 版本闸门 / 变异行段校验 / `npm run test:filter`；`commit-msg` 要求首行以 `fix: feat: refactor: docs: chore: style: test: perf: revert: build: ci:` 之一开头且不超过 100 字符。装完用 `npm run hooks:verify` 自检（只读：生效 exit 0，未生效 exit 1 并说明是配置缺失、钩子文件缺失还是无执行位）——npm 不会自动注册仓库钩子，新克隆不跑 `hooks:install` 就是**静默没有门禁**，而 `hooks:install` 对「跳过/未覆盖」场景按设计仍 exit 0，不能当作「装好了」的证据。
- 增删 `test_*.js` 或改 `.github/workflows/test.yml` 的显式步骤：同步 `test_suites.js` 与 `SKIP_SUITES`（由 `test_suite_registry.js`、`test_ci_skip_suites.js` 对账）。
- 行为、配置或契约变化：同步更新 `README.md`、`SYSTEM_CONTRACT.md`、`CHANGELOG.md`，不让文档落后于代码。

高风险区域：判重/缓存、推送结果、配置兼容、网络请求、正则防护、文件存储与符号链接防御。改动须补回归测试。完整行为约束见 [SYSTEM_CONTRACT.md](SYSTEM_CONTRACT.md)；运行方式见 [README.md](README.md)。
