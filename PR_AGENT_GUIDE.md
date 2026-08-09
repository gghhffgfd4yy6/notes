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
配置文件：/opt/pr-agent-venv/lib/python3.12/site-packages/pr_agent/settings/
```

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
