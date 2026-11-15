#!/usr/bin/env bash
# mutation 的 dry run 预检（2026-11-15）：在矩阵开跑前，用真实 TAP 配置跑一次「初始测试运行」。
#
# 为什么需要：dry run 里任何一个测试文件红，全部 TAP 段都会在 2–3 分钟内集体红；而
# tap-runner 只打印「<文件> # exit code 1」、不转发子进程输出 ⇒ 2026-11-15 那次 19 段齐红，
# 日志里看不出是哪条断言。预检把这件事单独跑一遍，失败时配合 XBK_TAP_LOG_DIR 打印逐文件 ❌ 行，
# 并让矩阵根本不启动。
#
# 为什么写成脚本而不是直接写在 workflow 里：`mutation.yml 必须有且仅有一行活动
# run: npx stryker run …` 是 test_ci_skip_suites.js 锁住的结构不变量（逐段 runner 的唯一消费点）。
# 预检不是矩阵消费点，因此不能占用那一行。
#
# --dryRunOnly：只做初始测试运行、不产生变异体（分钟级）。
# --mutate：只给 stryker 一个合法目标；dry run 跑的是 tap.testFiles 的**全部**文件。
# --concurrency 2：该步只跑一遍，不追吞吐；8 路并发下 watchdog 敏感的套件会互相拖慢。
set -euo pipefail

cd "$(dirname "$0")/.."
exec npx stryker run stryker.tap.config.js --mutate "xbk_state_schema.js" --dryRunOnly --concurrency 2
