#!/usr/bin/env bash
# xbk-push 拉取式自动部署：由本机定时器主动 `git fetch`，不把任何私钥放进 GitHub。
#
# 用法：
#   scripts/auto-deploy.sh             # 真正部署：有更新且没有任务在跑时 checkout + restart
#   scripts/auto-deploy.sh --check     # 只比对 HEAD 与 origin/main（用 ls-remote，不写本地任何 ref）
#   scripts/auto-deploy.sh --dry-run   # 打印将要执行的命令，不做任何变更
#
# 环境变量（括号内为默认值）：
#   DEPLOY_DIR       线上 git worktree（/home/ubuntu/notes-live）
#   SERVICE          systemd 单元名（xbk-console）
#   HEALTH_URL       /api/sys 探测地址（http://127.0.0.1:7777/api/sys）
#   STATUS_URL       忙碌探测地址（未设置时由 HEALTH_URL 推导：去掉末尾 /sys 再接 /status）
#   DEPLOY_ENV_FILE  取 XBK_CONSOLE_TOKEN 的环境文件（/home/ubuntu/notes/.console.env）
#   REMOTE / BRANCH  部署来源（origin / main）
#   LOCK_FILE        flock 单飞锁（~/.cache/xbk-deploy/deploy.lock）
#   HEALTH_TIMEOUT   健康检查上限秒数（30）
#   HEALTH_INTERVAL  健康检查轮询间隔秒数（2）
#   SYSTEMCTL        重启命令（默认 systemctl；非 root 且免密 sudo 可用时自动用 sudo -n systemctl）
#
# 行为约定：
#   - 已是最新 ⇒ 打印 unchanged、退出 0；有任务在跑 ⇒ 打印 busy、退出 0（等下一轮定时器）。
#   - 部署失败（restart 失败 / 30s 内版本对不上）⇒ checkout 回旧 sha、restart、再验一次，退出 1。
#     stdout 全部进 journal（systemd 收集），失败原因逐行带时间戳。
#   - 部署只动 DEPLOY_DIR 这棵 worktree（detached HEAD），不碰任何分支、不 push。
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/ubuntu/notes-live}"
SERVICE="${SERVICE:-xbk-console}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:7777/api/sys}"
STATUS_URL="${STATUS_URL:-${HEALTH_URL%/sys}/status}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-/home/ubuntu/notes/.console.env}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
LOCK_FILE="${LOCK_FILE:-${XDG_CACHE_HOME:-$HOME/.cache}/xbk-deploy/deploy.lock}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"

MODE=deploy
usage () {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

log () {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die () {
  log "FATAL: $*"
  exit 2
}

# 环境变量里的 SYSTEMCTL 允许带参数（如 "sudo -n systemctl"），按空格拆成数组。
# 未显式设置时：root 直接 systemctl；非 root 且有免密 sudo 则用 sudo -n，否则原样尝试（失败会在部署前报清原因）。
if [ -n "${SYSTEMCTL:-}" ]; then
  # shellcheck disable=SC2206 # 允许用空格拆分自定义命令（与 systemd ExecStart 的直觉一致）
  SYSTEMCTL_CMD=(${SYSTEMCTL})
elif [ "$(id -u)" -eq 0 ]; then
  SYSTEMCTL_CMD=(systemctl)
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SYSTEMCTL_CMD=(sudo -n systemctl)
else
  SYSTEMCTL_CMD=(systemctl)
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      [ "$MODE" = deploy ] || die "--check 与 $MODE 不能同时使用"
      MODE=check
      ;;
    --dry-run)
      [ "$MODE" = deploy ] || die "--dry-run 与 $MODE 不能同时使用"
      MODE=dry-run
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（可用：--check / --dry-run / --help）"
      ;;
  esac
  shift
done

git_in () { git -C "$DEPLOY_DIR" "$@"; }

# 打印一条命令（shell 转义后），供 --dry-run 与失败日志使用。
show_cmd () {
  local out="" arg
  for arg in "$@"; do
    out+="$(printf '%q' "$arg") "
  done
  printf '  + %s\n' "${out% }"
}

# 从 DEPLOY_ENV_FILE 读取 XBK_CONSOLE_TOKEN（与 systemd EnvironmentFile 同语义：后出现的赋值覆盖先前的）。
# 在子 shell 里 source，避免污染本进程环境；文件里有语法错误则得到空串并报错退出。
read_token () {
  [ -r "$DEPLOY_ENV_FILE" ] || return 1
  (
    set -a
    # shellcheck source=/dev/null # 路径由 DEPLOY_ENV_FILE 决定，静态分析无从跟进（文件里只有 XBK_CONSOLE_* 变量）
    . "$DEPLOY_ENV_FILE" >/dev/null 2>&1 || exit 1
    printf '%s' "${XBK_CONSOLE_TOKEN:-}"
  )
}

# 从 stdin 的 JSON 里取 version 字段；解析失败返回非零（调用方据此判定「服务没起来/返回了非 JSON」）。
json_version () {
  node -e 'const fs=require("fs");try{process.stdout.write(String(JSON.parse(fs.readFileSync(0,"utf8")).version||""))}catch(e){process.exit(2)}'
}

# 从 DEPLOY_DIR/package.json 读版本号（版本四方同步的唯一真源之一，与 /api/sys 的 version 同源）。
package_version () {
  node -e 'const fs=require("fs");try{process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version||""))}catch(e){process.exit(2)}' "$DEPLOY_DIR/package.json"
}

# 忙碌判定：/api/status 里 running / activeRun / inFlight 非空，或触发锁被持有（lock.held）。
# 输出 busy / idle / unknown（unknown = 探测失败，不阻塞部署：服务已经挂了的时候更应该部署）。
probe_busy () {
  local body=""
  if ! body=$(curl -sS -m 5 -H "Authorization: Bearer ${TOKEN}" "$STATUS_URL" 2>/dev/null); then
    printf 'unknown'
    return 0
  fi
  printf '%s' "$body" | node -e '
const fs = require("fs")
let data
try { data = JSON.parse(fs.readFileSync(0, "utf8")) } catch (e) { process.exit(2) }
const filled = (v) => v !== null && v !== undefined && v !== false && v !== "" &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
const busy = filled(data.running) || filled(data.activeRun) || filled(data.inFlight) ||
  (data.lock && data.lock.held === true)
process.stdout.write(busy ? "busy" : "idle")
' 2>/dev/null || printf 'unknown'
}

# 轮询 /api/sys 直到 version == 期望值；超时返回非零。
wait_healthy () {
  local want="$1" timeout="$2" deadline got=""
  deadline=$(($(date +%s) + timeout))
  while :; do
    if got=$(curl -sS -m 5 -H "Authorization: Bearer ${TOKEN}" "$HEALTH_URL" 2>/dev/null | json_version); then
      if [ "$got" = "$want" ]; then
        log "healthy: version=$got"
        return 0
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "health check timeout after ${timeout}s (want=${want}, last=${got:-none})"
      return 1
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

# 单飞：拿不到锁直接退出 0（上一轮还没跑完 / 上一轮卡住由 systemd 的 TimeoutStartSec 收尾）。
acquire_lock () {
  mkdir -p "$(dirname "$LOCK_FILE")" || die "无法创建锁目录：$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE" || die "无法打开锁文件：$LOCK_FILE"
  if ! flock -n 9; then
    log "another deploy holds ${LOCK_FILE}; skip this round"
    exit 0
  fi
}

# 失败收尾：回滚到旧 sha、重启、再验一次；无论回滚是否成功都 exit 1。
rollback_and_exit () {
  local reason="$1" old_version=""
  log "DEPLOY FAILED: ${reason}"
  if [ -z "$OLD_SHA" ]; then
    log "no previous commit recorded; nothing to roll back"
    exit 1
  fi
  if [ "$(git_in rev-parse HEAD 2>/dev/null || true)" = "$OLD_SHA" ]; then
    log "worktree still on ${OLD_SHA:0:8}; only restarting + re-checking"
  else
    log "rollback: checkout -f ${OLD_SHA:0:8}"
    if ! git_in checkout -f "$OLD_SHA" >/dev/null 2>&1; then
      log "ROLLBACK FAILED: checkout ${OLD_SHA} 失败，线上目录停留在新提交（需要人工介入）"
      exit 1
    fi
  fi
  log "rollback: restart ${SERVICE}"
  if ! "${SYSTEMCTL_CMD[@]}" restart "$SERVICE"; then
    log "ROLLBACK FAILED: 无法重启 ${SERVICE}"
    exit 1
  fi
  old_version=$(package_version || true)
  if [ -z "$old_version" ]; then
    log "ROLLBACK INCOMPLETE: 读不到回滚后的 package.json 版本"
    exit 1
  fi
  if wait_healthy "$old_version" "$HEALTH_TIMEOUT"; then
    log "rollback OK: ${SERVICE} 回到 ${OLD_SHA:0:8}（version ${old_version}）"
  else
    log "ROLLBACK UNHEALTHY: 回滚后 ${HEALTH_TIMEOUT}s 内 /api/sys 未返回 ${old_version}（需要人工介入）"
  fi
  exit 1
}

# ── 前置检查 ────────────────────────────────────────────────────────────────
[ -d "$DEPLOY_DIR" ] || die "DEPLOY_DIR 不存在：$DEPLOY_DIR"
[ -e "$DEPLOY_DIR/.git" ] || die "DEPLOY_DIR 不是 git 仓库/worktree：$DEPLOY_DIR"
git_in rev-parse --git-dir >/dev/null 2>&1 || die "DEPLOY_DIR 的 git 元数据不可用：$DEPLOY_DIR"

acquire_lock

HEAD_SHA=$(git_in rev-parse HEAD) || die "读不到 HEAD"
log "mode=${MODE} dir=${DEPLOY_DIR} service=${SERVICE} head=${HEAD_SHA:0:8}"

# 目标 sha：真正部署时 fetch（只更新 remote-tracking ref）；--check / --dry-run 用 ls-remote，绝不写本地 ref。
if [ "$MODE" = deploy ]; then
  if ! git_in fetch --prune "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
    die "git fetch ${REMOTE} ${BRANCH} 失败（网络或凭证问题，本轮不部署）"
  fi
  TARGET_SHA=$(git_in rev-parse --verify "${REMOTE}/${BRANCH}^{commit}") || die "解析 ${REMOTE}/${BRANCH} 失败"
else
  TARGET_SHA=$(git_in ls-remote --exit-code "$REMOTE" "refs/heads/${BRANCH}" 2>/dev/null | awk 'NR==1{print $1}') || \
    die "git ls-remote ${REMOTE} ${BRANCH} 失败"
fi
[ -n "$TARGET_SHA" ] || die "解析不到 ${REMOTE}/${BRANCH} 的提交"

if [ "$HEAD_SHA" = "$TARGET_SHA" ]; then
  log "unchanged: HEAD ${HEAD_SHA:0:8} == ${REMOTE}/${BRANCH}"
  exit 0
fi
log "update available: ${HEAD_SHA:0:8} -> ${TARGET_SHA:0:8} (${REMOTE}/${BRANCH})"
git_in log --oneline -n 20 "${HEAD_SHA}..${TARGET_SHA}" 2>/dev/null || log "（无法列出提交差异，可能是历史被改写）"
if ! git_in merge-base --is-ancestor "$HEAD_SHA" "$TARGET_SHA" 2>/dev/null; then
  log "WARN: ${HEAD_SHA:0:8} 不是 ${TARGET_SHA:0:8} 的祖先（历史被改写/强推）；按新 sha 强制检出"
fi
if [ -n "$(git_in status --porcelain 2>/dev/null || true)" ]; then
  log "WARN: 工作树有未提交改动，checkout -f 会丢弃它们"
fi

if [ "$MODE" = check ]; then
  log "check: 有更新待部署（--check 不部署）"
  exit 0
fi

# ── 计划输出的收尾（--dry-run 到此为止） ─────────────────────────────────────
TOKEN=""
if [ "$MODE" = deploy ]; then
  TOKEN=$(read_token) || die "无法从 ${DEPLOY_ENV_FILE} 读取 XBK_CONSOLE_TOKEN"
  [ -n "$TOKEN" ] || die "${DEPLOY_ENV_FILE} 里没有 XBK_CONSOLE_TOKEN"
fi

if [ "$MODE" = dry-run ]; then
  log "dry-run：以下命令将按顺序执行（本次不执行任何变更）"
  show_cmd git -C "$DEPLOY_DIR" fetch --prune "$REMOTE" "$BRANCH"
  show_cmd git -C "$DEPLOY_DIR" checkout -f "$TARGET_SHA"
  printf '  + 读取 %s/package.json 的 version 作为期望版本\n' "$DEPLOY_DIR"
  show_cmd "${SYSTEMCTL_CMD[@]}" restart "$SERVICE"
  printf '  + 轮询 %s 最多 %ss（每 %ss）直到 version == 期望版本\n' "$HEALTH_URL" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"
  printf '  + 失败则：%s → restart → 复验\n' "$(printf '%q ' git -C "$DEPLOY_DIR" checkout -f "${HEAD_SHA:0:8}" | sed 's/ $//')"
  printf '  + 忙碌保护：先探 %s，running/lock.held 非空则输出 busy 并退出 0\n' "$STATUS_URL"
  exit 0
fi

# ── 忙碌探测：有任务在跑就等下一轮，避免重启打断真实推送 ──────────────────────
BUSY_STATE=$(probe_busy)
case "$BUSY_STATE" in
  busy)
    log "busy: 有任务在运行（${STATUS_URL} 的 running/lock.held 非空），等下一轮再部署"
    exit 0
    ;;
  unknown)
    log "WARN: ${STATUS_URL} 探测失败（服务可能已下线），继续部署"
    ;;
  *)
    log "idle: 无任务在运行，开始部署"
    ;;
esac

# ── 部署：记录旧 sha → checkout → restart → 健康检查 ─────────────────────────
OLD_SHA=$HEAD_SHA
log "deploy: checkout -f ${TARGET_SHA:0:8}"
if ! git_in checkout -f "$TARGET_SHA" >/dev/null 2>&1; then
  rollback_and_exit "git checkout -f ${TARGET_SHA:0:8} 失败"
fi
NEW_VERSION=$(package_version) || rollback_and_exit "读取 ${DEPLOY_DIR}/package.json 版本失败"
[ -n "$NEW_VERSION" ] || rollback_and_exit "package.json 里没有 version 字段"

log "restart: ${SERVICE}"
if ! "${SYSTEMCTL_CMD[@]}" restart "$SERVICE"; then
  rollback_and_exit "${SERVICE} 重启失败"
fi

if ! wait_healthy "$NEW_VERSION" "$HEALTH_TIMEOUT"; then
  rollback_and_exit "${HEALTH_TIMEOUT}s 内 ${HEALTH_URL} 未返回 version=${NEW_VERSION}"
fi

log "deployed OK: ${OLD_SHA:0:8} -> ${TARGET_SHA:0:8} version=${NEW_VERSION}"
exit 0
