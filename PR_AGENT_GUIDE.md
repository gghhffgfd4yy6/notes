# 🤖 Qodo Merge（PR-Agent）终端 AI 代码审查使用指南

> 面向本仓库（xbk-push / rikka-hub）的 **Qodo Merge（PR-Agent）CLI** 本地审查使用说明。
> 本工具已安装到本工作区环境（venv 隔离安装，不污染系统 Python）。
> 安装日期：2026-08-09。版本号以 `pr-agent --version` 实际输出为准。

---

## 1. 这是什么

Qodo Merge（原名 PR-Agent）是开源的 **AI 代码审查工具**，在终端直接对 Git 仓库做审查：

- 审查**本地 git 变更**（不需要 PR、不需要 GitHub/GitLab），因此**适配本仓库的 Gitee 远程**——云端 App 类工具（如 CodeRabbit）不支持 Gitee，CLI 是可行路径
- 由大模型（OpenAI GPT 系列，或任意 OpenAI 兼容第三方端点；本环境配置为 `deepseek-v4-flash`）生成：变更总结、潜在 Bug、改进建议、安全风险
- 输出为 Markdown 文本（`review.md`），可人工审阅

与项目已有审查手段的分层：

| 手段 | 类型 | 成本 | 用途 |
|---|---|---|---|
| `.tools/code-audit/`（osv-scanner / semgrep / eslint / knip） | 静态规则扫描 | 免费、离线 | 依赖漏洞、安全规则、死代码、风格 |
| **Qodo Merge（本工具）** | AI 语义审查 | OpenAI API 按量计费 | 逻辑缺陷、边界条件、设计问题、改进建议 |
| `npm test` 全量测试 | 行为验证 | 免费 | 回归保护 |

三者互补：静态扫描抓已知模式，AI 审查抓语义问题，测试证明行为正确。

---

## 2. 安装状态与位置

### 已安装（无需重复操作）

```text
虚拟环境：/opt/pr-agent-venv        （Python venv，隔离安装）
可执行文件：/opt/pr-agent-venv/bin/pr-agent
代码版本：v0.42.0（2026-08-09 从 GitHub The-PR-Agent/pr-agent 源码安装）
版本自报：0.41.0（官方已知坑：源码安装的版本号元数据滞后，--version 显示不代表代码版本）
配置文件：/opt/pr-agent-venv/lib/python3.12/site-packages/pr_agent/settings/
```

> ⚠️ **PyPI 已停更（重要）**：pr-agent 在 PyPI 上停在 0.39.0（2026-02 项目从 Qodo 独立后 PyPI 发布暂停，官方正在恢复中）。`pip install pr-agent` 只能装到 0.39.0；**升级到 0.40+ 必须源码安装**：
> ```bash
> /opt/pr-agent-venv/bin/pip install "git+https://github.com/The-PR-Agent/pr-agent.git@v0.42.0"
> ```
> 官方地址：`github.com/The-PR-Agent/pr-agent`（原 qodo-ai/pr-agent 已重定向；描述明确"This project is not the Qodo free tier"）。

使用前把 venv bin 加入 PATH：

```bash
export PATH="/opt/pr-agent-venv/bin:$PATH"
```

### 重新安装 / 升级（如需）

```bash
python3 -m venv /opt/pr-agent-venv                          # 首次：创建虚拟环境
/opt/pr-agent-venv/bin/pip install --upgrade pr-agent       # 安装或升级
```

**网络注意事项**（本环境实测）：
- 系统 Python 受 PEP 668 保护，**必须用 venv**，不能直接 `pip install` 系统级安装
- 安装时若默认源（pypi.org）慢/中断，换阿里云或腾讯云镜像（清华镜像在本环境不通）：
  ```bash
  /opt/pr-agent-venv/bin/pip install pr-agent -i https://mirrors.aliyun.com/pypi/simple/ --timeout 60 --retries 5
  ```

---

## 3. 配置（一次性）

### 3.1 API Key 与模型端点（官方或第三方）

CLI 运行时需要 OpenAI 兼容的 API key。**官方 OpenAI 与第三方兼容端点都支持**（本环境实测为第三方端点 `opencode.ai` + 模型 `deepseek-v4-flash`）。

```bash
export OPENAI_API_KEY=sk-你的key                          # litellm 标准变量
export OPENAI__API_BASE="https://opencode.ai/zen/go/v1"   # 第三方端点（到 /v1，litellm 自动拼 /chat/completions）
export CONFIG__MODEL="openai/deepseek-v4-flash"             # 模型名，openai/ 前缀强制走自定义端点
export CONFIG__FALLBACK_MODELS='["openai/deepseek-v4-flash"]'  # 失败回退也指同一模型（防回退到官方 gpt）
export CONFIG__CUSTOM_MODEL_MAX_TOKENS=32000              # 非内置模型的 token 上限（不设会报 MAX_TOKENS 未定义）
export CONFIG__OUTPUT_RUN_DETAILS=true                    # 审查后输出运行明细（模型/tokens/耗时/AI 调用次数，v0.42.0 新增）
export CONFIG__REASONING_EFFORT=none                      # 关闭推理模型的思考预算（v0.42.0 包改动后生效；实测快 5.3 倍且质量不降，见 §6.7）
export LITELLM_LOCAL_MODEL_COST_MAP=True                  # 用本地模型价格表，跳过启动时拉 GitHub 的超时等待（每次省约 5s）
```

- 官方 OpenAI：只设 `OPENAI_API_KEY` 即可，其余可省
- 第三方兼容端点：**必须**设 `OPENAI__API_BASE` + `CONFIG__MODEL`；`CONFIG__FALLBACK_MODELS` 与 `CONFIG__CUSTOM_MODEL_MAX_TOKENS` 强烈建议（否则失败会回退到官方 `gpt-5.4-mini` 导致"Model not supported"）
- 以上配置已写入本环境 `~/.bashrc`（登录即生效）

**保存建议**：写入 `~/.bashrc` 免每次输入（本环境已配好）。

**安全红线**：
- key 是敏感凭证，**绝不写入仓库文件**、绝不提交 git（与 `push_config.local.js` 同等对待）
- pr-agent **不加载 `.env` 文件**（官方安全设计），请用环境变量
- 注意：GitHub Action 场景的 `OPENAI_KEY` 变量名在 CLI 下**不生效**，CLI 请用上面的名字

### 3.2 审查模式：local（本地仓库）

每次运行前设置 git provider 为 local（也可写进 `~/.bashrc`）：

```bash
export CONFIG__GIT_PROVIDER=local
```

> 原理：local provider 从**当前目录向上查找 `.git` 目录**确定仓库根，审查**当前 HEAD 与目标分支**的差异。
> 无需任何托管平台凭证，不向任何平台发布评论。

---

## 4. 日常使用

### 4.1 审查最近 N 次提交（推荐流程）

```bash
cd /workspace
export PATH="/opt/pr-agent-venv/bin:$PATH"
export CONFIG__GIT_PROVIDER=local
export OPENAI_API_KEY=sk-你的key        # 若已写入 .bashrc 可省略

git branch review-base HEAD~3           # ① 建临时基准分支（HEAD~N：N=审查最近 N 次提交）
pr-agent --pr_url=review-base review    # ② 执行 AI 审查
git branch -D review-base               # ③ 删除临时分支（可逆，安全）
```

审查结果写入 **`/workspace/review.md`**（见 §5）。

### 4.2 其他常用命令

```bash
pr-agent --pr_url=review-base describe   # 生成变更描述（写入 description.md）
pr-agent --pr_url=review-base ask "这段逻辑有什么边界问题？"   # 对变更提问
pr-agent --pr_url=review-base review --pr_reviewer.extra_instructions="重点关注判重和缓存写入逻辑"
```

### 4.3 完整工作流建议

1. 开发前：`git status` 确认工作区干净（已跟踪文件无未提交改动）
2. 开发完提交后：`git branch review-base HEAD~N` → 审查 → 删分支
3. 审完清理 `review.md`（或加入 `.gitignore`，见 §5）
4. 结合 `npm test` 全量测试 + `.tools/code-audit/` 静态扫描一起验收

---

## 5. 输出产物与清理

- `review` 命令 → 写入仓库根目录 **`review.md`**
- `describe` 命令 → 写入仓库根目录 **`description.md`**
- **不发布到任何平台**（local 模式只写本地文件）

⚠️ 这两个文件是**审查产物，不应入库**。建议加入 `.gitignore`：

```bash
echo -e "review.md\ndescription.md" >> .gitignore
```

或审查后随手删除：

```bash
rm /workspace/review.md /workspace/description.md
```

---

## 6. 注意事项与坑（重点）

### 6.1 硬性前置条件

| 条件 | 说明 | 不满足时的报错 |
|---|---|---|
| 仓库必须干净 | 已跟踪文件**无未提交变更**（untracked 文件不影响） | `The repository is not in a clean state. Please commit or stash pending changes.` |
| 目标分支必须存在 | `--pr_url` 传的分支名必须真实存在 | `Branch: xxx does not exist` |
| 必须在仓库内运行 | local provider 向上找 `.git` | `Could not find repository root` |

处理未提交改动：`git stash`（审完 `git stash pop`）或先提交。

### 6.2 local 模式的能力边界

- **不支持 inline 行内评论**（代码里明确 NotImplementedError）——只输出整份 `review.md`
- 审查的是**已提交**的差异，不是工作区未暂存内容（所以要临时分支或用已提交历史）
- 不支持发布评论到 Gitee/GitHub（local 模式设计如此；如需 PR 评论走托管平台模式）

### 6.3 费用与 token

- OpenAI API **按量计费**，审查的文件越多、越大，token 消耗越高
- 默认模型为 GPT 系列；可用 `--pr_reviewer.model=...` 切换（文档不维护模型名，以官方文档为准）
- 大仓库建议限定审查范围：临时分支只覆盖目标提交（`HEAD~N` 取小），或加 `extra_instructions` 聚焦模块

### 6.6 审查耗时：小范围才可行（实测结论，2026-08-09）

| 范围 | diff 规模 | 实测耗时 |
|---|---|---|
| 单提交 / HEAD~3（几十行） | ~2K tokens | **约 36-40s** |
| HEAD~10（3,645 行） | ~30K tokens | 3-4 分钟 |
| HEAD~50（7,300 行） | **148K tokens** | **8 分钟+ 无法完成** |

- 慢的构成：启动 ~11s（Python+litellm 加载 137 个包，固定成本）+ 模型串行调用（每次 3-6s，review 对每个文件/hunk 单独调用，**时间随 diff 线性增长**）
- **结论**：AI 审查只用于小范围/单提交/刚提交的新变更；**不要**回头审 50 次提交这种大范围（已实测不可行且边际价值低——历史已被多轮人工审查覆盖）
- `review` 命令是多步流水线（主分析+code suggestions 等 3-4 次串行调用），`ask` 命令单次调用更快（约 20s）

### 6.7 审查提速：reasoning_effort=none（2026-08-09 实测）

- **根因**：deepseek-v4-flash 是推理模型，思考无上限时 review 输出随机 1.6K~10.8K tokens（耗时 18s~300s+ 波动，曾 300s 超时）
- **修复 1**（包代码）：`SUPPORT_REASONING_EFFORT_MODELS` 加 `deepseek-v4-flash` + handler 补 `allowed_openai_params`（litellm 参数门禁）——升级 pr-agent 后需重打（改 `/opt/pr-agent-venv/lib/python3.12/site-packages/pr_agent/algo/__init__.py` 和 `litellm_ai_handler.py`，备份在 /tmp/*.bak）
- **修复 2**（配置）：`CONFIG__REASONING_EFFORT=none` 关闭思考预算
- **实测对比**（完整 review 18650cb，7.7K tokens）：无限制=300s 超时 / low=74.7s / **none=14.2s**（且抓到与 low 完全相同的 2 个真 bug）——**none 比 low 再快 5.3 倍，质量不降**
- 若遇需深层推理的场景（复杂跨函数竞态分析）可临时切 low/medium

### 6.4 网络

- 运行需要能访问模型 API（本环境实测：pypi 官方源与阿里/腾讯镜像可用；第三方端点 `opencode.ai` 可直连）
- 第三方端点带 Cloudflare 防护时，**手动脚本测试需带浏览器 User-Agent**（否则 HTTP 403 error 1010）；pr-agent 的 litellm 请求实测无需特殊处理
- 安装依赖失败时重试命令见 §2

### 6.5 与项目红线的关系

- 本工具**不触碰 `.git` 内部文件**（只读 git 对象做 diff 比较；临时分支用 `git branch` 创建/删除，均为常规安全操作）
- 但仍遵守项目红线：**任何删除/破坏性操作前先备份**；临时分支删除前确认名称（`git branch -D review-base` 只删自己创建的临时分支）
- `git-bundle` 备份、`.git` 相关操作规范见 README「安全红线」与 REVIEW_DECISIONS「重大事故记录」

---

## 7. 常见问题（FAQ）

**Q：提示 `Failed to get git provider`？**
确认 `CONFIG__GIT_PROVIDER=local` 已 export；`--pr_url` 传的是**分支名**不是路径/URL。

**Q：审查结果没有出现在屏幕？**
结果写入 `review.md`（local 模式默认落盘），`cat review.md` 查看。

**Q：提示 key 相关错误 / DUMMY key？**
`OPENAI_API_KEY` 未设置或为空。检查环境变量；注意 CLI 下不要用 `OPENAI_KEY`（那是 GitHub Action 专用）。

**Q：提示 `Model gpt-5.4-mini is not supported`？**
第三方端点的模型名与默认回退模型不一致：设置 `CONFIG__MODEL` 指向你的模型，并设 `CONFIG__FALLBACK_MODELS` 指向同一模型（§3.1）。

**Q：提示 `not defined in MAX_TOKENS`？**
第三方非内置模型需要设 `CONFIG__CUSTOM_MODEL_MAX_TOKENS`（§3.1）。

**Q：手动测试 API 返回 HTTP 403 error 1010？**
Cloudflare 拦截非浏览器客户端，请求头加浏览器 User-Agent（§6.4）；pr-agent 本身实测不受影响。

**Q：pip 安装中断？**
网络问题，换阿里云/腾讯云镜像重试（§2），已下载部分会自动续装。

**Q：不想让 review.md 出现在 git status？**
加入 `.gitignore`（§5）。

**Q：遇到工具/订阅/计费问题去哪找支持？**
pr-agent 无传统客服（无工单/客服邮箱），官方渠道：
- **GitHub Issues**：`github.com/The-PR-Agent/pr-agent`（正式报 bug，响应快）
- **Discord 社区**：`opencode.ai/discord`（注意这是 OpenCode 的社区；pr-agent 的社区见 GitHub 主页链接）
- **官方文档**：`qodo-merge-docs.qodo.ai`（每页底部可提交 issue）
- 第三方端点（opencode.ai）的订阅/额度问题：登录 `zen.opencode.ai` 控制台，或走 OpenCode 的 GitHub/Discord

---

## 8. 速查卡

```bash
export PATH="/opt/pr-agent-venv/bin:$PATH"
export CONFIG__GIT_PROVIDER=local
export OPENAI_API_KEY=sk-...        # 已写 .bashrc 则省略

cd /workspace
git status                           # 确认干净（stash 未提交改动）
git branch review-base HEAD~3        # 临时基准分支
pr-agent --pr_url=review-base review # 审查
git branch -D review-base            # 清理临时分支
cat review.md                        # 看结果
```

---

> 维护说明：本文档不维护易过时的数字（版本号、模型名、费用单价），以实际运行输出与官方文档为准；环境相关事实（venv 路径、网络镜像实测）如环境变更需同步更新。
