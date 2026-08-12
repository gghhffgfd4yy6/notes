#!/bin/bash
# 串行修复: 一次一个 bug, 每个修完跑测试, 全部通过才下一个
# 用法: .ai/bin/serial-fix.sh <bug清单文件> <起始序号>
# 每行格式: BUG-xxx|函数|修复指令
set -e
LIST=$1
START=${2:-1}
N=0
while IFS='|' read -r id func instr; do
  [ -z "$id" ] && continue
  N=$((N+1))
  [ $N -lt $START ] && continue
  echo "════ 串行修复 [$id] $func ════"
  echo "指令: $instr"
  # 生成单 bug 修复提示词(一个子代理, 独立会话)
  cat > /tmp/serial_fix_$id.txt << PROMPT
请修复 /workspace/xbk_function_v3.js 中 $func 的以下 bug:
$instr
要求: ①查看代码 ②实施修复 ③node --check ④node run_tests.js 全量确认 ⑤报告: 已修复[YES/NO]+测试[YES/NO]+说明
PROMPT
  codex-zen exec -c 'model_provider="zenchat"' -c 'sandbox_mode="danger-full-access"' -m "deepseek-v4-flash" < /tmp/serial_fix_$id.txt
  echo "════ [$id] 完成 ════"
done < "$LIST"
echo "✅ 串行修复全部完成"
