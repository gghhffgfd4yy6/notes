# 贡献

## 分支与合并

- 从 `main` 新建 `fix/*`、`feat/*`、`docs/*`、`chore/*`、`refactor/*`、`test/*` 分支（CI/工具链改动用 `ci/*` 或 `chore/*`）；不要直接修改 `main`。
- 一次提交只做一件事。CI 全绿后使用 Squash Merge。
- 提交信息首行须以 `fix: feat: refactor: docs: chore: style: test: perf: revert: build: ci:` 之一开头，且不超过 100 字符（由 `commit-msg` 钩子硬拦）。

## 改完要跑什么

- 常规代码改动跑 `npm run check`（别名 `npm run verify`），链路为：
  `npm run lint` → `node check-version.js` → `node scripts/check-mutation-ranges.js` → `npm run check:ci-static` → `npm run check:doc-lines` → `npm test`。
- 至少必须包含 `npm test`、`npm run lint`、`node check-version.js`。
- **本机能不能当判据，先看宿主**（探针与细节见 `README.md` 的「本机能不能当判据：先探宿主」）：
  - 真 node + `re2` 齐备的 Linux 容器：整条 `npm run check` 可本机跑完。若环境注入 `NODE_OPTIONS=--require=<dns-compat.cjs>`，`test_agents.js` 会因起动时 `dns.lookup` 被替换而假红（并连带 `test_run_mutation_cli.js`）⇒ 加 `DSHA_DNS_MODE=native`（该兼容层自带开关）或 `env -u NODE_OPTIONS` 再跑，别把环境噪声报成回归。
  - 本机汇总**不是固定值**：48 套件那版实测过 **48/0**、**47/1**、**46/2**；49 套件三轮为 **47/2**、**48/1**、**48/1**。唯一波动源 `test_run_mutation_cli.js` 与注入无关——`evaluate` 场景的 180s 沙箱看门狗在本机贴边（合计 10 次观测 **3 绿 7 红**：红 193–205s、绿 171.1–171.3s；当日台账，别当固定值），把文档回退到上一版内容再跑，红绿分布不变 ⇒ 非回归。另 `test_filter.js` 有一轮链内红（54.7s）、单跑 824/824 绿、另一轮链内 41.0s 绿 ⇒ 成因未归因的时序敏感。报本机结果要带轮次与耗时；这条的红写成「看门狗超时」而不是「契约失败」，判据在 CI。
  - Android/Termux 宿主：`execPath` 指向 `linker64` ⇒ 子进程断言必炸；缺 `re2` ⇒ `test:filter` 失真 ⇒ 只有 lint / 版本闸门 / 变异行段 / 静态扫描 / 文档行长这五道不 spawn 子进程的闸门可当判据。
  - 两条共同的红线：**不要把本机全绿当作契约已验证**（CI 才是跨环境判据），也**不要用「本机跑不了」免除本机验证**。

## 本地钩子

`npm run hooks:install` 注册 `.githooks`：

- **`pre-commit`** —— 五道快检：lint / 版本闸门 / 变异行段校验 / 静态扫描（v3.280 起第 4 道）/ 文档行长（v3.281 起第 5 道）。本机实测 lint 约 22s、其余各 <1s。
- **`pre-push`** —— 跑 `npm run test:filter`（约 60s，推送前拦截）。校验对象是**被推提交的内容**：工作树不干净（含未跟踪文件；被 ignore 的不算）或推的不是当前 HEAD 时，改在临时 worktree 里检出那个提交再跑；隔离环境建不起来则 fail-closed——绝不拿当前工作树的结果冒充被推提交。
- **`commit-msg`** —— 见上节的首行格式与长度限制。

npm 不会自动注册仓库钩子，克隆后**必须显式装一次**；装完跑 `npm run hooks:verify` 确认门禁真的生效（只读，未生效 exit 1 并说明是配置缺失、钩子文件缺失还是无执行位）。`hooks:install` 对「跳过/不覆盖」场景按设计仍 exit 0，不能当作「装好了」的证据。

## 静态扫描闸门（v3.280）

- `npm run check:ci-static` = `shellcheck` 扫 `.githooks/*` 全部钩子 + `zizmor` 扫 `.github/workflows/` 全部（**medium 及以上计红**；zizmor 的 JSON 解析不出来按「不可判定 = 红」fail-closed）。
- 同一条链在 `npm run check`、pre-commit 第 4 道、CI quality job 步骤**三处**接线，接线由 `test_ci_static_gates.js` 用内容断言锁死：摘掉任一处，下一次 CI 必红在该套件。
- **新增钩子或 workflow 文件后不得假定它没被扫描**——这两类文件从此只有更严、没有豁免。
- zizmor 在 CI 钉 `==1.30.1`（= 本机基线），**升级须两处同步**。本机缺工具时闸门显眼提示并跳过（绝不假装扫描过）；CI（env `CI=true`）或加 `--require-tools` 时缺工具即红。

## 文档行长闸门（v3.281）

- `npm run check:doc-lines` 让任何被扫描的 markdown 出现 **>1200 字符**的单行即红；三处接线同一阈值（`npm run check` / pre-commit 第 5 道 / CI `quality-gate` 显式步骤），接线由 `test_doc_line_gates.js` 用内容断言锁死（含「阈值必须恰为 1200」「`.github` 不得进跳过名单」「扫描面不得漏掉任何一份 prose」）。
- **没有例外名单**：超了就按语义拆成子弹/表格，改完跑 `npm run check:doc-lines` 自查；把阈值调大 = 闸门形同虚设，那条断言会先红。
- 为什么值得做一道门禁：巨行的代价不是难看，而是评审放弃逐字核对 + diff 一行改动等于整行重写；AGENTS 曾长到单行 8132 字符、CHANGELOG 4788，v3.280 才重切完，没有这道闸门它就会自然长回去。

## 变异测试：分数与档位

- **分数门禁当前已停用**：`stryker.config.js` 的 `thresholds.break = null`（不再有分数阈值）。
- 停用理由：同配置同段三轮 `storage` 实测 **79.08% / 82.92% / 71.02%**，极差 **11.90pp**（`coveredBy` 285/285 三轮一致 ⇒ 抖动来自测试自身），任何阈值都会随噪声误判。
- 历史「最低段 `message-store` 69.38%」依据的是含陈旧复用的**虚高值**（旧称「真实全量」的 v3-entry 47.81%、storage 59.30%，实测出自 `06e62cc`、**修复前配置**：`--concurrency 2` + 共享 `xianbaoku_cache`，含假 Killed 风险），**不能用作 `break` 标定依据**——该基线已被证伪。
- 分数停用后由 **fail-closed 守卫**兜底（`mutation.yml` 在「变异测试」step **之后**）：本段报告 `runtimeErrors > 0`、或 `totalValid === 0`（`mutationScore = NaN`；`determineExitCode` 写的是 `if (mutationScore < breaking)`，`NaN < 65 === false` 会**假绿**）、或报告缺失 ⇒ 该段 job 红。CI 上仍按**段**判定（其余段照跑，`report` job 仍发日报）。
- **PR-1 起 CI 变异矩阵走 TAP 档**（`stryker.tap.config.js`，15 段；`v3-entry` / `storage` / `qinglong-push` / `check-deps` 四段保留 command 档 `stryker.config.js`，原因见 `AGENTS.md` 的「TAP 档已知限制」），而**本地 `npm run test:mutation` 仍走 command 档** ⇒ 两档不再是同一份配置（测试集仍由 `stryker.tap.config.js` 的加载期断言强制对齐）。阈值未设时本地也不会因分数非 0 退出，需自行按报告判读；那 4 个 command 档段的分数与其余 15 段**不同口径**，跨段比较必须排除。
- 待去 flake + 按 TAP 口径的诚实基线重新标定后，再决定是否恢复阈值；恢复后的回退＝把 `break` 改回 `null`。日报里的合计/分段分数是**观察基线**，不是门禁口径。

## 改动必须同步的地方

- 改动带行段的文件（`xbk_function_v3.js`、`xbk_sendNotify_slim.js`）：同步重拆 `.github/workflows/mutation.yml` 行段并跑 `node scripts/check-mutation-ranges.js`。
- 增删 `test_*.js` 或改 `test.yml` 显式步骤：同步 `test_suites.js` 与 `SKIP_SUITES`（由 `test_suite_registry.js`、`test_ci_skip_suites.js` 对账）。
- 高风险改动（判重、缓存、推送、配置、网络、正则、文件存储）：补针对性回归测试，并在 PR 说明影响与回滚方式。
- 行为、配置或契约变化：同步 `README.md`、`SYSTEM_CONTRACT.md`、`CHANGELOG.md`。**注意现状**——只有 `CHANGELOG.md` 被间接覆盖（`check-version.js` 只校验其最新版本标题与另外三方一致，**不校验内容是否描述了本次改动**）；`README.md` / `SYSTEM_CONTRACT.md` 的同步没有任何门禁，靠约定与评审兜。所以 PR 说明必须点明「动了哪些文档 / 为什么不需要动」，评审逐条核对。
- 发版：先把版本号同步**四处**（`xbk_function_v3.js` 文件头、`CHANGELOG.md` 新增 `## vX.Y` 段、`package.json`、`package-lock.json` 的顶层 `version` 与 `packages[""].version`），跑 `node check-version.js` 看到「版本四方一致」。CI 全绿后在 `main` 上打 tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`；无需手动建 Release。
- 破坏性 Git 操作前先备份：`git bundle create backup.bundle --all && git bundle verify backup.bundle`。
- 不提交 Token、API Key、Cookie 或 `push_config.local.js`。
