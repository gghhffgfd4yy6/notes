#!/bin/bash
# 子代理派发: dispatch.sh <defs文件...>
# 默认【串行】执行（铁律 5：共享状态修改必须串行——修复 agent 改同一工作区，并发会互相覆盖）。
# 只读类任务（verify/review/observer）可显式并行：PARALLEL=1 dispatch.sh <defs...>
cd /workspace
export NEW_API_KEY="$(cat ~/.codex/new_api_key.txt)"
if [ "${PARALLEL:-0}" = "1" ]; then
  pids=()
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
    if [ $ec -ne 0 ]; then echo "FAIL $n exit=$ec"; echo "$ec" > ".ai/reports/fix-$n.FAILED"; continue; fi
    if [ -s ".ai/reports/fix-$n.json" ]; then echo "OK   $n ($(wc -c < .ai/reports/fix-$n.json) bytes)"; else echo "EMPTY $n"; echo "EMPTY" > ".ai/reports/fix-$n.FAILED"; fi
  done
else
  # 串行：一次一个，等完成再下一个（修复 agent 必须串行）
  for d in "$@"; do
    n=$(basename "$d" .md)
    rm -f ".ai/reports/fix-$n.json" ".ai/reports/fix-$n.FAILED"
    timeout 550 codex exec -s danger-full-access -o ".ai/reports/fix-$n.json" -C /workspace "$(cat "$d")" < /dev/null >/dev/null 2>&1
    ec=$?
    if [ $ec -ne 0 ]; then echo "FAIL $n exit=$ec"; echo "$ec" > ".ai/reports/fix-$n.FAILED"; continue; fi
    if [ -s ".ai/reports/fix-$n.json" ]; then echo "OK   $n ($(wc -c < .ai/reports/fix-$n.json) bytes)"; else echo "EMPTY $n"; echo "EMPTY" > ".ai/reports/fix-$n.FAILED"; fi
  done
fi
echo "BATCH_DONE $(date +%H:%M:%S)"
