#!/usr/bin/env bash
# 安全清理 Rootfs / 工作区中的明显垃圾文件
#
# 默认行为：只扫描并预览，不修改任何文件。
# --apply 后：先复制候选文件到备份目录，再移动到隔离目录；不做永久删除。
# 只建议对工作区或项目目录使用，默认根目录为 /workspace。

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_NAME="$(basename "$0")"
ROOT="${ROOTFS_ROOT:-/workspace}"
MIN_AGE_DAYS=7
INCLUDE_CACHES=0
INCLUDE_BACKUPS=0
APPLY=0
YES=0
MODE="clean"
RESTORE_DIR=""
TRASH_BASE=""
BACKUP_BASE=""
TMP_LIST_FILE=""

usage() {
    cat <<'EOF'
用法：
  cleanup_rootfs_junk.sh [选项]

默认只扫描和预览，不修改文件。

选项：
  --root DIR             清理根目录，默认 /workspace
  --days N               只处理超过 N 天未修改的文件，默认 7
  --include-caches       额外处理常见开发缓存中的文件
  --include-backups      额外处理 *.bak 和 *.old 文件（默认不处理）
  --trash DIR            隔离目录，默认 ROOT/.rootfs-cleanup-trash/<时间戳>
  --backup DIR           备份目录，默认 ROOT/.rootfs-cleanup-backup/<时间戳>
  --apply                执行清理：先备份，再移动到隔离目录
  --yes                  跳过确认，仅与 --apply 配合使用
  --restore DIR          将某次清理的隔离目录恢复到 --root
  -h, --help             显示帮助

安全规则：
  1. 默认是 dry-run，不会修改文件。
  2. --apply 不永久删除文件，而是先复制备份，再移动到隔离目录。
  3. 永不扫描或修改 .git、.hg、.svn、.bzr 目录及其内容。
  4. 不跟随符号链接，不跨文件系统扫描。
  5. 拒绝直接把 / 作为清理根目录。
  6. *.bak、*.old 和开发缓存必须显式开启。

恢复示例：
  cleanup_rootfs_junk.sh --root /workspace --restore \
    /workspace/.rootfs-cleanup-trash/20260808-212730
EOF
}

die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

warn() {
    printf '警告：%s\n' "$*" >&2
}

require_integer() {
    local name="$1"
    local value="$2"
    [[ "$value" =~ ^[0-9]+$ ]] || die "$name 必须是非负整数：$value"
}

# 把用户传入的目录转换为规范绝对路径；目录不存在时不自动创建。
canonical_existing_dir() {
    local p="$1"
    [[ -d "$p" ]] || die "目录不存在：$p"
    (cd -- "$p" && pwd -P)
}

# 只允许隔离目录和备份目录位于清理根目录内部，避免跨目录误操作。
validate_inside_root() {
    local p="$1"
    case "$p/" in
        "$ROOT/"*) ;;
        *) die "路径必须位于清理根目录内部：$p" ;;
    esac
}

validate_not_vcs_path() {
    local p="$1"
    case "$p" in
        */.git|*/.git/*|*/.hg|*/.hg/*|*/.svn|*/.svn/*|*/.bzr|*/.bzr/*)
            die "路径不能位于版本控制内部目录：$p"
            ;;
    esac
}

paths_overlap() {
    local a="$1"
    local b="$2"
    case "$a/" in "$b/"*) return 0 ;; esac
    case "$b/" in "$a/"*) return 0 ;; esac
    return 1
}

validate_destination_tree() {
    local p="$1"
    [[ -e "$p" || -L "$p" ]] || return 0
    [[ -d "$p" && ! -L "$p" ]] || die "目标路径必须是普通目录，拒绝跟随链接：$p"
    local link
    link="$(find -P "$p" -xdev -type l -print -quit 2>/dev/null || true)"
    [[ -z "$link" ]] || die "目标目录内部存在符号链接，拒绝操作：$link"
}

# 额外的路径级防线；即使 find 表达式被修改，也不允许碰版本控制目录。
is_protected_path() {
    local p="$1"
    case "$p" in
        "$ROOT/.git"|"$ROOT/.git/"*|*/.git|*/.git/*\
        |"$ROOT/.hg"|"$ROOT/.hg/"*|*/.hg|*/.hg/*\
        |"$ROOT/.svn"|"$ROOT/.svn/"*|*/.svn|*/.svn/*\
        |"$ROOT/.bzr"|"$ROOT/.bzr/"*|*/.bzr|*/.bzr/*\
        |"$ROOT/.rootfs-cleanup-trash"|"$ROOT/.rootfs-cleanup-trash/"*\
        |"$ROOT/.rootfs-cleanup-backup"|"$ROOT/.rootfs-cleanup-backup/"*\
        |"$TRASH_BASE"|"$TRASH_BASE/"*\
        |"$BACKUP_BASE"|"$BACKUP_BASE/"*)
            return 0
            ;;
    esac
    return 1
}

unique_destination() {
    local base="$1"
    local candidate="$base"
    local n=1
    while [[ -e "$candidate" || -L "$candidate" ]]; do
        candidate="${base}.duplicate-${n}"
        n=$((n + 1))
    done
    printf '%s' "$candidate"
}

parse_args() {
    while (($#)); do
        case "$1" in
            --root)
                (($# >= 2)) || die "--root 缺少参数"
                ROOT="$2"
                shift 2
                ;;
            --days)
                (($# >= 2)) || die "--days 缺少参数"
                MIN_AGE_DAYS="$2"
                shift 2
                ;;
            --include-caches)
                INCLUDE_CACHES=1
                shift
                ;;
            --include-backups)
                INCLUDE_BACKUPS=1
                shift
                ;;
            --trash)
                (($# >= 2)) || die "--trash 缺少参数"
                TRASH_BASE="$2"
                shift 2
                ;;
            --backup)
                (($# >= 2)) || die "--backup 缺少参数"
                BACKUP_BASE="$2"
                shift 2
                ;;
            --apply)
                APPLY=1
                shift
                ;;
            --yes)
                YES=1
                shift
                ;;
            --restore)
                (($# >= 2)) || die "--restore 缺少参数"
                MODE="restore"
                RESTORE_DIR="$2"
                shift 2
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "未知参数：$1；使用 --help 查看帮助"
                ;;
        esac
    done
}

prepare_paths() {
    require_integer --days "$MIN_AGE_DAYS"
    ROOT="$(canonical_existing_dir "$ROOT")"

    [[ "$ROOT" != "/" ]] || die "为避免误清理系统，拒绝把 / 作为根目录"
    validate_not_vcs_path "$ROOT"

    if [[ -n "$TRASH_BASE" ]]; then
        [[ "$TRASH_BASE" = /* ]] || die "--trash 必须是绝对路径"
    else
        TRASH_BASE="$ROOT/.rootfs-cleanup-trash/$(date +%Y%m%d-%H%M%S)"
    fi

    if [[ -n "$BACKUP_BASE" ]]; then
        [[ "$BACKUP_BASE" = /* ]] || die "--backup 必须是绝对路径"
    else
        BACKUP_BASE="$ROOT/.rootfs-cleanup-backup/$(date +%Y%m%d-%H%M%S)"
    fi

    # realpath -m 允许目标目录尚未存在，同时折叠 .. 和符号链接，避免路径穿越。
    TRASH_BASE="$(realpath -m -- "$TRASH_BASE")"
    BACKUP_BASE="$(realpath -m -- "$BACKUP_BASE")"

    validate_inside_root "$TRASH_BASE"
    validate_inside_root "$BACKUP_BASE"
    validate_not_vcs_path "$TRASH_BASE"
    validate_not_vcs_path "$BACKUP_BASE"

    [[ "$TRASH_BASE" != "$ROOT" ]] || die "隔离目录不能等于清理根目录"
    [[ "$BACKUP_BASE" != "$ROOT" ]] || die "备份目录不能等于清理根目录"
    if paths_overlap "$TRASH_BASE" "$BACKUP_BASE"; then
        die "备份目录和隔离目录不能相同或互相包含"
    fi
    validate_destination_tree "$TRASH_BASE"
    validate_destination_tree "$BACKUP_BASE"
}

find_candidates() {
    local list_file="$1"
    local age_minutes=$((MIN_AGE_DAYS * 1440))

    # 只匹配明显的临时/编辑器残留/系统缩略文件。
    # *.bak、*.old 只有 --include-backups 才加入。
    local expression=(
        \(
            -name '*.tmp'
            -o -name '*.temp'
            -o -name '*~'
            -o -name '.#*'
            -o -name '*.swp'
            -o -name '*.swo'
            -o -name '.DS_Store'
            -o -name 'Thumbs.db'
            -o -name 'desktop.ini'
            -o -name '*.crdownload'
            -o -name '*.part'
        \)
    )

    if ((INCLUDE_BACKUPS)); then
        expression+=(
            -o -name '*.bak'
            -o -name '*.old'
        )
    fi

    if ((INCLUDE_CACHES)); then
        expression+=(
            -o -path '*/node_modules/.cache/*'
            -o -path '*/.pytest_cache/*'
            -o -path '*/__pycache__/*'
            -o -path '*/.mypy_cache/*'
            -o -path '*/.ruff_cache/*'
            -o -path '*/.tox/*'
            -o -path '*/.nox/*'
        )
    fi

    # -P：不跟随符号链接；-xdev：不跨文件系统。
    if ! find -P "$ROOT" -xdev \
        \( \
            -path "$TRASH_BASE" -o \
            -path "$BACKUP_BASE" -o \
            -name .git -o \
            -name .hg -o \
            -name .svn -o \
            -name .bzr \
        \) -prune -o \
        -type f -mmin +"$age_minutes" \
        "${expression[@]}" -print0 >"$list_file"; then
        die "扫描失败；可能存在权限错误或文件系统错误，未执行任何清理"
    fi
}

print_candidates() {
    local list_file="$1"
    local count=0
    local total=0
    local shown=0
    local path size

    while IFS= read -r -d '' path; do
        is_protected_path "$path" && continue
        [[ -f "$path" && ! -L "$path" ]] || continue
        size="$(stat -c '%s' -- "$path" 2>/dev/null || printf '0')"
        [[ "$size" =~ ^[0-9]+$ ]] || size=0
        count=$((count + 1))
        total=$((total + size))
        if ((shown < 200)); then
            printf '  %q\n' "${path#"$ROOT"/}"
            shown=$((shown + 1))
        fi
    done <"$list_file"

    if ((count > shown)); then
        printf '  …… 其余 %d 个候选文件省略\n' "$((count - shown))"
    fi

    printf '\n候选文件：%d 个，约 %s\n' "$count" "$(human_size "$total")"
}

human_size() {
    local bytes="$1"
    if ((bytes < 1024)); then
        printf '%d B' "$bytes"
    elif ((bytes < 1024 * 1024)); then
        awk -v n="$bytes" 'BEGIN {printf "%.1f KiB", n/1024}'
    elif ((bytes < 1024 * 1024 * 1024)); then
        awk -v n="$bytes" 'BEGIN {printf "%.1f MiB", n/1024/1024}'
    else
        awk -v n="$bytes" 'BEGIN {printf "%.1f GiB", n/1024/1024/1024}'
    fi
}

confirm_apply() {
    ((APPLY)) || return 0
    ((YES)) && return 0

    if [[ ! -t 0 ]]; then
        die "--apply 在非交互环境中必须同时提供 --yes"
    fi

    printf '\n将执行：先复制备份，再把原文件移动到隔离目录。\n'
    printf '备份目录：%s\n' "$BACKUP_BASE"
    printf '隔离目录：%s\n' "$TRASH_BASE"
    printf '不会永久删除文件；输入 CLEANUP_CONFIRM 才继续： '
    local answer
    IFS= read -r answer
    [[ "$answer" == "CLEANUP_CONFIRM" ]] || die "未确认，已取消"
}

apply_cleanup() {
    local list_file="$1"
    local manifest="$BACKUP_BASE/manifest.tsv"
    local restore_manifest="$TRASH_BASE/manifest.nul"
    local marker="$TRASH_BASE/.rootfs-cleanup-quarantine"
    local path rel backup_path trash_path size
    local moved=0
    local skipped=0

    mkdir -p -- "$BACKUP_BASE" "$TRASH_BASE"
    : >"$manifest"
    printf 'original\tbackup\tquarantine\tsize\n' >"$manifest"
    : >"$restore_manifest"
    : >"$marker"

    while IFS= read -r -d '' path; do
        is_protected_path "$path" && continue

        # 文件可能在扫描后被其他程序删除、替换或变成符号链接；此时跳过。
        [[ -f "$path" && ! -L "$path" ]] || {
            skipped=$((skipped + 1))
            warn "文件已变化，跳过：$path"
            continue
        }

        rel="${path#"$ROOT"/}"
        backup_path="$BACKUP_BASE/$rel"
        trash_path="$TRASH_BASE/$rel"
        mkdir -p -- "$(dirname -- "$backup_path")" "$(dirname -- "$trash_path")"

        if [[ -e "$backup_path" || -L "$backup_path" ]]; then
            backup_path="$(unique_destination "$backup_path")"
        fi
        if [[ -e "$trash_path" || -L "$trash_path" ]]; then
            trash_path="$(unique_destination "$trash_path")"
        fi

        printf '备份：%q\n' "$rel"
        if ! cp -a -- "$path" "$backup_path"; then
            die "备份失败，已停止，未移动：$path"
        fi

        # 校验备份内容后才允许移动原文件。
        if ! cmp -s -- "$path" "$backup_path"; then
            die "备份校验失败，已停止，未移动：$path；备份保留在 $backup_path"
        fi

        size="$(stat -c '%s' -- "$path" 2>/dev/null || printf '0')"
        if ! mv -- "$path" "$trash_path"; then
            die "移动到隔离目录失败：$path；备份保留在 $backup_path"
        fi

        # TSV 便于人工检查；NUL 清单用于恢复，可安全处理空格、制表符和换行文件名。
        printf '%s\t%s\t%s\t%s\n' "$path" "$backup_path" "$trash_path" "$size" >>"$manifest"
        printf '%s\0%s\0%s\0%s\0' "$path" "$backup_path" "$trash_path" "$size" >>"$restore_manifest"
        moved=$((moved + 1))
    done <"$list_file"

    printf '\n完成：移动 %d 个，跳过 %d 个。\n' "$moved" "$skipped"
    printf '备份清单：%s\n' "$manifest"
    printf '隔离目录：%s\n' "$TRASH_BASE"
    printf '确认无误后，请手动删除对应隔离目录；本脚本不会永久删除文件。\n'
}

restore_cleanup() {
    local source="$RESTORE_DIR"
    local manifest="$source/manifest.nul"
    local original backup quarantine size
    local restored=0
    local skipped=0

    [[ -d "$source" ]] || die "恢复目录不存在：$source"
    [[ "$source" = /* ]] || die "--restore 必须是绝对路径"
    case "$source/" in
        "$ROOT/"*) ;;
        *) die "恢复目录必须位于清理根目录内部：$source" ;;
    esac
    [[ -f "$source/.rootfs-cleanup-quarantine" ]] || \
        die "恢复目录不是本脚本创建的隔离目录，拒绝操作：$source"
    [[ -f "$manifest" ]] || die "隔离目录缺少 manifest.nul，拒绝猜测恢复路径：$manifest"

    # 每条记录为 original、backup、quarantine、size 四个 NUL 分隔字段。
    while IFS= read -r -d '' original \
          && IFS= read -r -d '' backup \
          && IFS= read -r -d '' quarantine \
          && IFS= read -r -d '' size; do
        case "$original/" in
            "$ROOT/"*) ;;
            *) die "清单中的原路径越出清理根目录，拒绝恢复：$original" ;;
        esac
        case "$quarantine/" in
            "$source/"*) ;;
            *) die "清单中的隔离路径越出本次隔离目录，拒绝恢复：$quarantine" ;;
        esac

        [[ -f "$quarantine" && ! -L "$quarantine" ]] || {
            warn "隔离文件不存在或已变化，跳过：$quarantine"
            skipped=$((skipped + 1))
            continue
        }
        if [[ -e "$original" || -L "$original" ]]; then
            warn "原位置已有文件，跳过恢复：$original"
            skipped=$((skipped + 1))
            continue
        fi

        mkdir -p -- "$(dirname -- "$original")"
        mv -- "$quarantine" "$original"
        restored=$((restored + 1))
        printf '恢复：%q\n' "${original#"$ROOT"/}"
    done <"$manifest"

    printf '恢复完成：%d 个，跳过 %d 个。\n' "$restored" "$skipped"
}

main() {
    parse_args "$@"
    prepare_paths

    if [[ "$MODE" == "restore" ]]; then
        restore_cleanup
        return 0
    fi

    [[ "$YES" == 0 || "$APPLY" == 1 ]] || die "--yes 必须与 --apply 一起使用"

    local list_file
    list_file="$(mktemp)"
    TMP_LIST_FILE="$list_file"
    trap '[[ -n "${TMP_LIST_FILE:-}" ]] && rm -f -- "$TMP_LIST_FILE"' EXIT

    find_candidates "$list_file"
    print_candidates "$list_file"

    if [[ ! -s "$list_file" ]]; then
        printf '\n没有发现符合条件的候选文件。\n'
        return 0
    fi

    if ((APPLY == 0)); then
        printf '\n这是预览模式，没有修改任何文件。\n'
        printf '如确认清单无误，请加 --apply；自动化执行可同时加 --yes。\n'
        return 0
    fi

    confirm_apply
    apply_cleanup "$list_file"
}

main "$@"
