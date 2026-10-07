## 描述

<!-- 这个 PR 做了什么（一句话） -->

## 为什么修改

<!-- 背景 / 动机 / 关联问题 -->

## 变更范围

<!-- 改了哪些文件 / 模块，大致改动量 -->
<!-- 动了哪些文档 / 为什么不需要动：README.md、SYSTEM_CONTRACT.md、CHANGELOG.md 的同步**没有门禁**（check-version.js 只校验 CHANGELOG 最新版本标题与另外三方一致，不校验内容是否描述本次改动），评审需逐条核对这一项 -->

## 类型

- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] ♻️ 重构
- [ ] 🧪 测试
- [ ] 📝 文档
- [ ] 🔧 CI/配置

## 风险

- [ ] 是否修改**核心逻辑**（规则过滤 / 去重 / 推送主链路）？如果是，说明影响面
- [ ] 是否修改**缓存 / 判重契约**（缓存 key 结构、判重窗口、缓存目录）？如果是，说明兼容性
- [ ] 是否修改**推送行为**（通道格式 / 重试 / 并发 / 限流）？如果是，说明对现有通道的影响
- [ ] 是否修改**配置兼容性**（配置项增删 / 默认值 / 语义变化）？如果是，说明迁移方式
- [ ] 是否涉及**网络请求 / 正则 / 输入清洗**（ReDoS / XSS 风险区）？如果是，说明防护措施
- [ ] 是否影响**常驻模式**（循环调度 / 失败策略 / DNS/TLS 预热 / 延迟加载）？
- [ ] 是否改动**大文件行段**（`xbk_function_v3.js` / `xbk_sendNotify_slim.js`）？如果是，已同步重拆 `mutation.yml` 行段并运行 `node scripts/check-mutation-ranges.js`
- [ ] 是否改动 `test.yml` 显式步骤、`test_suites.js` 或 `mutation.yml` matrix（`name` / `src` / `mutate`）？如果是，已同步 `SKIP_SUITES`、套件注册与 `scripts/mutation-report.js` 的段名
- [ ] 是否影响**供应链 / 安全扫描**（依赖变更、工作流改动、CodeQL / Scorecard / Dependency Review）？

## 测试

- [ ] `npm run check` 通过（lint → 版本四方一致 → 变异行段 → **静态扫描** → **文档行长** → `npm test`）
- [ ] 单元测试通过（`npm run test:unit`：35 个单元套件，v3.278 起并发池执行，默认并发 8）
- [ ] 全量套件通过（`npm test`：50 个套件**顺序**执行；集成侧另有并行调度器 `npm run test:app`，失败片自动串行重跑）
- [ ] 新增了针对本改动的测试，且已注册到 `test_suites.js`（需要时同步 `SKIP_SUITES` 与 `test.yml` 显式步骤）
- [ ] 涉及性能/安全：补充了变异测试或故障注入验证
- [ ] 改动任何 `.md`（含 `.github/` 模板）：已跑 `npm run check:doc-lines`（单行 ≤1200 字符，无例外名单，只能拆行）
- [ ] 改动 `.githooks/*` 或 `.github/workflows/*`：已跑 `npm run check:ci-static`（这两类文件默认全量被扫描，无豁免）
- [ ] 本机跑不动的判据（`test:filter`、含子进程断言的套件）已在 **CI** 上验证——未把「本机全绿」当作契约已验证

## 安全检查

- [ ] 无新增依赖（或已说明依赖变更理由）
- [ ] 无 Token / API Key / Cookie 提交
- [ ] 无调试残留（console.log 排查输出 / 临时文件）

## 回滚方式

<!-- 如果出问题，怎么回滚（revert / 配置回退 / 缓存清理） -->

## AI 辅助开发说明（可选）

<!-- 如由 Codex/AI 辅助完成，简述审查与验证过程 -->
