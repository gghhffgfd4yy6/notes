#!/bin/bash
# 子代理派发: dispatch.sh <defs文件...>
# 默认【串行】执行（铁律 5：共享状态修改必须串行——修复 agent 改同一工作区，并发会互相覆盖）。
# 只读类任务（verify/review/observer）可显式并行：PARALLEL=1 dispatch.sh <defs...>
# 审查类任务参考五轴清单: .ai/REVIEW_CHECKLIST.md（正确性/可读性/架构/安全/性能）
cd /workspace
export NEW_API_KEY="$(cat ~/.codex/new_api_key.txt)"

report_tail() {  # 失败时打印报告摘要，便于快速定位
  local n="$1"
  local f=".ai/reports/fix-$n.json"
  if [ -s "$f" ]; then
    echo "── $n 报告摘要 ──"
    tail -c 800 "$f" | tr -d '\0' | head -8
  fi
}

pids=(); failed=0
if [ "${PARALLEL:-0}" = "1" ]; then
  for d in "$@"; do
    n=$(basename "$d" .md)
    rm -f ".ai/reports/fix-$n.json" ".ai/reports/fix-$n.FAILED"
    timeout 550 codex exec -s danger-full-access -o ".ai/reports/fix-$n.json" -C /workspace "$(cat "$d")" < /dev/null >/dev/null 2>&1 &
    pids+=("$!")
  done
  i=0
  for d in "$@"; do
    n=$(basename "$d" .md)
    wait "${pids[$i]}"; ec=$?
    i=$((i+1))
    if [ $ec -ne 0 ]; then echo "FAIL $n exit=$ec"; echo "$ec" > ".ai/reports/fix-$n.FAILED"; failed=$((failed+1)); report_tail "$n"; continue; fi
    if [ -s ".ai/reports/fix-$n.json" ]; then echo "OK   $n ($(wc -c < .ai/reports/fix-$n.json) bytes)"; else echo "EMPTY $n"; echo "EMPTY" > ".ai/reports/fix-$n.FAILED"; failed=$((failed+1)); fi
  done
else
  for d in "$@"; do
    n=$(basename "$d" .md)
    rm -f ".ai/reports/fix-$n.json" ".ai/reports/fix-$n.FAILED"
    timeout 550 codex exec -s danger-full-access -o ".ai/reports/fix-$n.json" -C /workspace "$(cat "$d")" < /dev/null >/dev/null 2>&1
    ec=$?
    if [ $ec -ne 0 ]; then echo "FAIL $n exit=$ec"; echo "$ec" > ".ai/reports/fix-$n.FAILED"; failed=$((failed+1)); report_tail "$n"; continue; fi
    if [ -s ".ai/reports/fix-$n.json" ]; then echo "OK   $n ($(wc -c < .ai/reports/fix-$n.json) bytes)"; else echo "EMPTY $n"; echo "EMPTY" > ".ai/reports/fix-$n.FAILED"; failed=$((failed+1)); fi
  done
fi
echo "BATCH_DONE $(date +%H:%M:%S) 失败=$failed/$(($#))"
exit $([ $failed -eq 0 ] && echo 0 || echo 1)
