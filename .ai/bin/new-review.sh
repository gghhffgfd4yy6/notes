#!/bin/bash
# 新审查轮: 生成审查提示词(只读分析, 每代理写独立文件)
# 用法: .ai/bin/new-review.sh <轮次号> <函数清单(逗号分隔)> <审查重点>
set -e
ROUND=$1
FUNCS=$2
FOCUS=${3:-"边界处理/错误处理/性能/安全/数据完整性"}
mkdir -p /workspace/.ai/review/round-$ROUND
IFS=',' read -ra ARR <<< "$FUNCS"
N=${#ARR[@]}
cat > /tmp/review_round$ROUND.txt << PROMPT
请使用 spawn 派发 $N 个子代理审查（一函数一子代理, 并行, 上限6）。
【重要】每个子代理只做只读分析: 读取代码+运行 node -e 验证, **严禁修改任何源文件**。
每个子代理把报告写到自己的独立文件(用 write_file 工具, 不追加共享文件):
/tmp/review_round$ROUND/agent-{编号}.md
报告必须使用固定格式(模板见 /workspace/.ai/review/TEMPLATE.md):
## BUG
ID: BUG-$ROUND-{seq}
位置: {file}:{line}
严重程度: {P0|P1|P2|P3}
函数: {函数名}
触发条件: {如何触发}
当前行为: {现状}
预期行为: {应该怎样}
证据: {node -e 实测输出或代码引用}
修复建议: {建议方案}
是否建议修复: {是|否|仅记录}
如无问题, 写 "## PASS" 即可。
审查重点: $FOCUS
函数清单:
$(for f in "${ARR[@]}"; do echo "- $f"; done)
PROMPT
echo "✅ 审查提示词已生成: /tmp/review_round$ROUND.txt ($N 个函数, 只读分析)"
echo "运行: codex-zen exec -c 'model_provider=\"zenchat\"' -c 'sandbox_mode=\"workspace-write\"' -m 'deepseek-v4-flash' < /tmp/review_round$ROUND.txt"
