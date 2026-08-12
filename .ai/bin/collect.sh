#!/bin/bash
# 收集去重: 汇总一轮审查结果 → 真实 bug 清单
# 用法: .ai/bin/collect.sh <轮次号>
set -e
ROUND=$1
DIR=/workspace/.ai/review/round-$ROUND
if [ ! -d "$DIR" ]; then echo "❌ 轮次目录不存在: $DIR"; exit 1; fi
echo "=== 收集 $DIR 下的代理报告 ==="
ls $DIR/agent-*.md 2>/dev/null | wc -l
node /workspace/.ai/bin/dedupe.js $ROUND
