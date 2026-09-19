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
- CI 变异**分数门禁**：**当前为 `stryker.config.js` 的 `thresholds.break = null`**（分数已不是门禁）。停用理由：同配置同段三轮 `storage` 实测 **79.08% / 82.92% / 71.02%**，极差 **11.90pp**（`coveredBy` 285/285 三轮一致 ⇒ 抖动来自测试自身），任何阈值都会随噪声误判；且历史「最低段 `message-store` 69.38%」依据的是**含陈旧复用的虚高值**（真实全量 v3-entry 47.81%、storage 59.30%），该基线**已被证伪**，据它定的 65 从来不是可用判据。**待去 flake + TAP 迁移后按 TAP 口径的诚实基线重新标定**。分数取消后，`NaN` 假绿通道由本轮新增的 **fail-closed 守卫**堵住：位置在 `mutation.yml`「变异测试」step **之后**，读本段报告并断言 `runtimeErrors > 0` **或** `totalValid === 0`（即 `mutationScore = NaN`）**或**报告缺失 ⇒ `exit 1`。为什么必须：`calculateMetrics` 里 `mutationScore = totalValid > 0 ? … : NaN`，而 `determineExitCode` 是 `if (mutationScore < breaking)` ⇒ `NaN < 65 === false` ⇒ 一个全程 RuntimeError / 零有效变异体的段会**静默变绿**。`mutation.yml` 每个矩阵 job 各自 `npx stryker run --mutate "<段>" --concurrency 8`，stryker 按**本段**报告判定，其余段照跑（`fail-fast: false`），产物上传与 `report` job 都是 `if: always()`，日报照发；`--concurrency` 2→8 依据同 commit 的 CI 实测（2→4 = 1.88×、4→8 = 1.84×，2→8 共 **3.46×**），4 vCPU 远未饱和（C=8 时整机仅 ~37% 忙、单链只吃 ~15% CPU）。**「按测试指纹强制全量重跑」是错的解法，已判定不采用**：它拦不住真根因（污染发生在变异体运行期、基线全程是绿的，且测试没变 ⇒ 指纹不变 ⇒ 主 key 仍命中，复用照旧），且在这套 runner 上**跑不完**（真正全量 `app` 2651 个变异体 ≈ 7–11 小时、`utils` 2402、`message-store` 1692，平台 6h/job 硬上限 + 本仓 step 330min ⇒ 9 段已被杀，而 `actions/cache` 是 `post-if: success()`、**失败段不保存进度** ⇒ 那几段每轮从零开始、永久红）。真根因是**共享缓存的并发串扰**：`test_filter.js` 的缓存目录曾是共享的 `<root>/xianbaoku_cache`，多个用例（如「`init`/`save` 在目录不存在时自动创建」）会 `rmSync` 整目录，而 Stryker 一次 run 只建一个沙箱、两个 worker 在同一份副本里互删 ⇒ `ENOTEMPTY … sandbox-*/xianbaoku_cache` 把同族「持久化/墓碑」用例整族拖红 ⇒ **与该变异体无关的假 Killed**，再被 `coverageAnalysis:'off'` 下**无条件复用**的 `incremental-differ`（`if (!testCoverage.hasCoverage) return true`）冻结 11 天（43.4MB 原始 inc 里 `sandbox-yi6WZh` 出现 5021 次、`ENOTEMPTY` 86 次；78 个「旧 Killed→干净全量 Survived」翻转里 57 个带该沙箱名）；修复＝缓存目录按进程唯一（`xianbaoku_cache_p<XBK_PARALLEL_ID|pid>`，与 `Config.cache.dir` 同源），独立复现：并发 2 份时 base 各 3 失败 → fixed **0 失败、无残留**。分数门禁**不在** `scripts/mutation-report.js` 里：该脚本 `main()` 是先 `validateSegments`/`validateFreshness` 再发 Issue，加分数 throw 会在最需要看分数时把日报一起吞掉——它对「缺段/多余段/重复段/陈旧报告」的 throw（完整性真门禁）保持不变，不许放宽。将来按 TAP 口径重新标定后若恢复分数门禁，回退＝把 `break` 改回 `null`。
- 变异报告 artifact 保留期与跨 run 依赖（v3.276 起）：`mutation.yml`「上传变异报告」的 `retention-days` 为 **7 天**（原 14，经批准下调）。唯一跨 run 消费者是 `.github/workflows/analyze-artifacts.yml`——它取 `gh run list --workflow=mutation.yml --status=success --limit=1`（最近一次**成功**运行）的 run-id，再按 `pattern=mutation-report-*` 下载，故**连续 7 天无成功变异运行**即失去输入；两层都是硬失败：`download-artifact` 报 `Unable to find any artifacts for the associated workflow`，`.github/analyze-artifacts.js` 对空目录 `exit 1`（该 fail-loud 行为由 `test_analyze_artifacts.js` 的 A1/A2 锁定，**不得**改成静默降级）。该工作流无 `schedule`（仅自身变更 push 与手动 `workflow_dispatch`），且 `run_id` 输入可显式指定，故恢复成本低：先重跑 mutation 再触发。再下调保留期前必须复核这一窗口，或把选 run 逻辑改为「取仍存有 artifact 的最新成功运行」。`test.yml` 的 `coverage-report`（同为 14 天）无任何下载方，不改。
- 行为、配置或契约变化：同步更新 `README.md`、`SYSTEM_CONTRACT.md`、`CHANGELOG.md`，不让文档落后于代码。**自动化现状（不要误以为有门禁）**：只有 `CHANGELOG.md` 被间接覆盖——`check-version.js` 只校验它的最新版本标题与其余三方一致，**不校验内容是否描述了本次改动**；`README.md` / `SYSTEM_CONTRACT.md` 的同步**完全没有门禁**，靠评审与约定兜。故 PR 说明须点明「动了哪些文档 / 为什么不需要动」，评审逐条核对。

高风险区域：判重/缓存、推送结果、配置兼容、网络请求、正则防护、文件存储与符号链接防御。改动须补回归测试。完整行为约束见 [SYSTEM_CONTRACT.md](SYSTEM_CONTRACT.md)；运行方式见 [README.md](README.md)。
