# 安全策略

## 漏洞报告

发现安全问题请**不要公开讨论**，通过以下方式报告：

- 直接联系维护者（GitHub 私信）
- 或使用 GitHub 的**私有漏洞报告**功能（Security → Report a vulnerability）

## 安全承诺

- 推送通道的密钥与 URL 经 `maskKey`/`maskUrl` 脱敏，通道异常摘要与一言获取失败经 `safeErr` 脱敏（按已配置密钥表替换 + 截断 200 字符）后再落日志；其余诊断（本地文件、依赖等）按原样记录错误 `message`，不做统一脱敏。
- 推送密钥只存放于本地 `push_config.local.js`（已被 `.gitignore` 忽略，不入库）或青龙环境变量；CI 不使用推送密钥，仅使用 Actions 自动签发的 `GITHUB_TOKEN`（最小权限）。
- 依赖更新由 Dependabot 自动开 PR（`.github/dependabot.yml`）；安全门禁由 PR 上的 Dependency Review（`fail-on-severity: high`）、CodeQL、`npm audit --audit-level=high --omit=dev` 与 `quality-gate` 负责，**人工审查后合并——当前未配置自动合并**。
- 工作流 YAML 与 Git 钩子本身也纳入扫描（v3.280）：`npm run check:ci-static` 用 `zizmor` 扫 `.github/workflows/` 全部（**medium 及以上计红**）、`shellcheck` 扫 `.githooks/*` 全部，作为 Test 工作流 `policy` job 的显式步骤跑，并由 `quality-gate` 汇总；zizmor 输出解析不出来按「不可判定 = 红」fail-closed，缺扫描器时 CI 同样判红（本机则显眼提示并跳过，绝不假装扫描过）。

## CI 安全扫描

| 扫描 | 触发 |
|---|---|
| CodeQL | PR / push main / 每周一 |
| OSSF Scorecard | 每周一 + 手动触发；push main 仅在改动 `.github/workflows/scorecard.yml` 时触发 |
| Dependency Review | PR |
| 依赖审计（`npm audit`） | Test 工作流矩阵 |
| 工作流/钩子静态扫描（`zizmor` + `shellcheck`） | Test 工作流 `policy`（并由 `quality-gate` 汇总）：PR / push main / 每日冒烟 |
| 外部静态分析（Codacy / SonarCloud） | 由 GitHub App 挂在 PR 与 main 的检查上（配置见 `.codacy.yml`、`.sonarcloud.properties`），不在本表的工作流之列 |

工作流引用的第三方 action 固定到完整 commit SHA（当前 31 处 `uses:` 全部为 40 位 SHA），checkout 一律 `persist-credentials: false`，降低供应链与凭据泄露风险。权限按各工作流声明分配：workflow-level `permissions` 是未单独设置 job-level `permissions` 时的默认权限；job-level `permissions` 可为对应 job 覆盖该设置。例如，Test 工作流在 workflow 层声明 `contents: read`，`policy` job 未单独声明 `permissions`，因此继承该设置；`quality-gate` 则显式使用 `permissions: {}`，不授予 `GITHUB_TOKEN` 权限。因此，并非每个 job 都显式声明了 job-level 最小权限。

## 支持范围

| 版本 | 支持 |
|---|---|
| main 分支 | ✅ 维护中 |
| 历史版本 | ❌ 不维护（请用最新） |
