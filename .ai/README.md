# AI 审查-修复流水线（v2 架构）

## 核心原则
> **并行的是"认知工作"，串行的是"共享状态变更"**

## 五阶段流程

```
① 并行审查(只读) → ② 中央裁判(去重验证) → ③ 串行修复 → ④ 全量测试 → ⑤ 并行复核(只读)
```

### 阶段 ①：并行审查（只读）
- 一函数一子代理，上限 6 并行
- 子代理**只读分析**：读代码 + node -e 验证，**严禁修改源文件**
- 每代理写**独立报告**：`.ai/review/round-N/agent-XX.md`（固定格式见 TEMPLATE.md）
- 沙箱：`workspace-write`（不需要 danger-full-access）
- 命令：`.ai/bin/new-review.sh <轮次> <函数清单>`

### 阶段 ②：中央裁判（主代理）
- 收集全部代理报告 → 去重（按 函数+位置）→ 验证 → 生成真实 bug 清单
- 输出：`.ai/patches/round-N-candidates.md` + 更新 `state.json`
- 只保留：真实 bug（排除重复/设计取舍/理论风险）
- 命令：`.ai/bin/collect.sh <轮次>`

### 阶段 ③：串行修复（一次一个）
- 一 bug 一子代理，**独立会话逐个执行**，每个修完跑全量测试
- 绝不并行修改同一源文件
- 命令：`.ai/bin/serial-fix.sh <清单>`
- 沙箱：`danger-full-access`（修复才需要）

### 阶段 ④：全量测试
- `npm test` 全部通过才算修复完成

### 阶段 ⑤：并行复核（只读）
- 修复后派新一批子代理只读验证：bug 是否真消失、有无回归、是否过度修复
- 每代理独立报告：`/tmp/verify_work/verify-XX.md`
- 沙箱：`workspace-write`
- 命令：`.ai/bin/verify.sh <编号清单>`

## 沙箱分级
| 阶段 | sandbox_mode | 理由 |
|---|---|---|
| 审查/复核 | `workspace-write` | 只读分析，无需系统权限 |
| 修复 | `danger-full-access` | 需要写文件/跑测试 |

## 状态持久化（解决 exec 无记忆）
```
.ai/
├── review/round-N/agent-*.md   # 每轮审查原始报告
├── patches/                    # 候选清单 + 决策
├── state.json                  # 轮次进度/bug 索引
└── bin/                        # 流水线脚本
```
每个新 exec 会话通过读 state.json + review 文件恢复上下文，不依赖"上一轮记得"。

## 禁止并行（共享状态变更）
- ❌ 修改同一源文件
- ❌ 修改同一配置文件
- ❌ git commit / rebase / merge
- ❌ 多个代理同时追加同一结果文件
