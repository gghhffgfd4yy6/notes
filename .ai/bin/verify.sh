#!/bin/bash
# 修复后并行复核: 只读验证, 每代理独立报告
# 用法: .ai/bin/verify.sh <编号清单(逗号分隔)>
set -e
ITEMS=$1
N=$(echo "$ITEMS" | tr ',' '\n' | wc -l)
mkdir -p /tmp/verify_work
cat > /tmp/verify_batch.txt << PROMPT
请使用 spawn 派发 $N 个子代理复核修复（一bug一子代理, 并行, 上限6）。
【重要】每个子代理只做只读验证: 读取代码+运行 node -e 实测, **严禁修改源文件**。
每子代理把报告写到独立文件: /tmp/verify_work/verify-{编号}.md
格式:
编号 | 修复正确[YES/NO] | 新bug[YES/NO] | 一句话理由
待验证项: $ITEMS
PROMPT
echo "复核提示词已生成(独立报告, 无共享写入)"
echo "运行: codex-zen exec -c 'model_provider=\"zenchat\"' -c 'sandbox_mode=\"workspace-write\"' -m 'deepseek-v4-flash' < /tmp/verify_batch.txt"
