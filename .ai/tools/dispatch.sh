#!/bin/bash
# 串行/并行派发: dispatch.sh <defs文件...>  （一次传 1 个=串行；多个=并行&wait）
cd /workspace
export NEW_API_KEY="$(cat ~/.codex/new_api_key.txt)"
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
  if [ -s ".ai/reports/fix-$n.json" ]; then echo "OK   $n ($(wc -c < .ai/reports/fix-$n.json) bytes)"; else echo "EMPTY $n"; fi
done
echo "BATCH_DONE $(date +%H:%M:%S)"
