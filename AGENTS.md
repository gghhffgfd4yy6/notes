# 项目规则

xbk-push：个人青龙**单实例**线报推送脚本。

## 必守

- 不提交密钥、缓存或本地配置。
- 破坏性 Git 操作前：`git bundle create backup.bundle --all && git bundle verify backup.bundle`；不得手动删除 `.git/objects`，清理使用 `git gc --prune=now`。
- 修改后先验证再称完成；提交前至少运行受影响测试，常规改动跑 `npm run check`。
- 一次提交只做一件事；改版本时同步**四处**：主文件头（`xbk_function_v3.js` 顶部）、`CHANGELOG.md`、`package.json`、`package-lock.json`（顶层 `version` 与 `packages[""].version` 两处都要），由 `node check-version.js` 硬门禁（pre-commit、CI、release.yml 的 `npm run check` 三处都跑，任一处漂移即红）。
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

- `npm run hooks:install` 注册 `.githooks`：`pre-commit` 跑 lint / 版本闸门 / 变异行段校验（约 20s），`pre-push` 跑 `npm run test:filter`（约 60s，推送前拦截）——但**只对被推提交的内容**跑（PR #156 返工）：`local_sha == HEAD` 且**整棵工作树干净（未跟踪文件也算脏；被 ignore 的文件不算）**时走快路径（此时工作树内容 ≡ 被推提交内容），否则（推别的分支 / 有未提交修改 / 有未跟踪文件）在 detached 临时 worktree 里检出那个 sha 后跑同一条门禁、跑完强制清理，隔离环境建不起来即 fail-closed——**绝不拿当前工作树的结果冒充被推提交的验证**（旧实现正是这样给出两类假绿灯：推 A 测 B、未提交的修复掩盖提交里的失败）；未跟踪文件同样会让快路径失效并改走隔离校验——它们虽不属于被推提交，却会被门禁扫描（`test_filter.js` 会 `readdirSync` 全部 `xbk_*.js` 做 helper 可达性断言），可能把「提交该红」变成「工作树绿」。`commit-msg` 要求首行以 `fix: feat: refactor: docs: chore: style: test: perf: revert: build: ci:` 之一开头且不超过 100 字符。装完用 `npm run hooks:verify` 自检（只读：生效 exit 0，未生效 exit 1 并说明是配置缺失、钩子文件缺失还是无执行位）——npm 不会自动注册仓库钩子，新克隆不跑 `hooks:install` 就是**静默没有门禁**，而 `hooks:install` 对「跳过/未覆盖」场景按设计仍 exit 0，不能当作「装好了」的证据。
- 增删 `test_*.js` 或改 `.github/workflows/test.yml` 的显式步骤：同步 `test_suites.js` 与 `SKIP_SUITES`（由 `test_suite_registry.js`、`test_ci_skip_suites.js` 对账）。
- CI 变异**分数门禁**：`stryker.config.js` 的 `thresholds.break = 65`。`mutation.yml` 每个矩阵 job 各自 `npx stryker run --mutate "<段>"`，stryker 按**本段**报告的 `mutationScore` 判定（`determineExitCode`，严格 `<`），跌破 65 就是**那一个段**的 job 红——其余段照跑（`fail-fast: false`），产物上传与 `report` job 都是 `if: always()`，日报照发。取值低于实测最低段（`message-store` 69.38%，合计 81.27%，2026-09-18 日报）故按当前基线不会误红；它是**会真红**的门禁——六天窗口（09-13…09-18）内 `status` 首轮报告 62.14% 就低于阈值，那是真弱（次日补测到 70.77%），完整边界证据见 `stryker.config.js` 的 thresholds 注释。回退＝把 `break` 改回 `null`。分数门禁**不在** `scripts/mutation-report.js` 里：该脚本 `main()` 是先 `validateSegments`/`validateFreshness` 再发 Issue，加分数 throw 会在最需要看分数时把日报一起吞掉——它对「缺段/多余段/重复段/陈旧报告」的 throw（完整性真门禁）保持不变，不许放宽。另注意「测试被弱化」这条边界已在 PR #156 收口：增量缓存 key 与 `restore-keys` 前缀都含**测试侧指纹**（`scripts/mutation-child.js` / `run_unit_tests.js` / `test_suites.js` / `test_suite_registry.js` / 全部 `test_*.js`），测试一变即无旧基线可复用、必须全量重跑——此前 key 有意不含测试指纹，而 `coverageAnalysis:'off'` 的增量差分会直接复用全部旧结果，于是「只删/弱化测试」会带着按旧测试算出的分数过门禁。残余边界只剩分数门禁的固有性质：**弱化测试后新跑一轮的分数仍 ≥65 就照样绿**（它拦的是分数真的掉下来，不是测试被人改过）。
- 变异报告 artifact 保留期与跨 run 依赖（v3.276 起）：`mutation.yml`「上传变异报告」的 `retention-days` 为 **7 天**（原 14，经批准下调）。唯一跨 run 消费者是 `.github/workflows/analyze-artifacts.yml`——它取 `gh run list --workflow=mutation.yml --status=success --limit=1`（最近一次**成功**运行）的 run-id，再按 `pattern=mutation-report-*` 下载，故**连续 7 天无成功变异运行**即失去输入；两层都是硬失败：`download-artifact` 报 `Unable to find any artifacts for the associated workflow`，`.github/analyze-artifacts.js` 对空目录 `exit 1`（该 fail-loud 行为由 `test_analyze_artifacts.js` 的 A1/A2 锁定，**不得**改成静默降级）。该工作流无 `schedule`（仅自身变更 push 与手动 `workflow_dispatch`），且 `run_id` 输入可显式指定，故恢复成本低：先重跑 mutation 再触发。再下调保留期前必须复核这一窗口，或把选 run 逻辑改为「取仍存有 artifact 的最新成功运行」。`test.yml` 的 `coverage-report`（同为 14 天）无任何下载方，不改。
- 行为、配置或契约变化：同步更新 `README.md`、`SYSTEM_CONTRACT.md`、`CHANGELOG.md`，不让文档落后于代码。**自动化现状（不要误以为有门禁）**：只有 `CHANGELOG.md` 被间接覆盖——`check-version.js` 只校验它的最新版本标题与其余三方一致，**不校验内容是否描述了本次改动**；`README.md` / `SYSTEM_CONTRACT.md` 的同步**完全没有门禁**，靠评审与约定兜。故 PR 说明须点明「动了哪些文档 / 为什么不需要动」，评审逐条核对。

高风险区域：判重/缓存、推送结果、配置兼容、网络请求、正则防护、文件存储与符号链接防御。改动须补回归测试。完整行为约束见 [SYSTEM_CONTRACT.md](SYSTEM_CONTRACT.md)；运行方式见 [README.md](README.md)。
