#!/usr/bin/env bash
# 调用 img.config 里配置的 GPT 生图接口
#
# 文生图:
#   ./img.sh "提示词"                      # 1 张，自动命名到 outputs/
#   ./img.sh "提示词" out.png              # 1 张，指定文件名
#   ./img.sh -n 5 "提示词"                 # 同一提示词生成 5 张变体
#   ./img.sh -n 5 "提示词" outputs/set.png # 生成 set-1.png ... set-5.png
#
# 图生图（/images/edits，multipart 上传）:
#   ./img.sh -i 原图.png "把背景换成雪景"            # 单图编辑
#   ./img.sh -i 原图.png -n 4 "改成水彩风格"         # 出 4 个变体
#   ./img.sh -i a.png -i b.png "把两张图合成一张"    # 多图参考（接口支持时）
#   ./img.sh -i 原图.png -m 蒙版.png "把蒙版区域换成星空"
#   ./img.sh -i 原图.png "提示词" out.png            # 指定输出名
#
# 其他:
#   ./img.sh --dry-run "提示词"            # 只打印请求，不发请求
#
# 输出文件已存在时不会覆盖，会自动改名为「名字 (2).png」「名字 (3).png」…
#
# 环境变量覆盖: IMG_MODEL / IMG_SIZE / IMG_JOBS / IMG_CONFIG
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${IMG_CONFIG:-$DIR/img.config}"

die() { echo "错误: $*" >&2; exit 1; }
# 打印文件开头的注释作为帮助
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; }

# --help 要在读配置之前处理：没有 img.config 时也能看帮助
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --) break ;;
  esac
done

[[ -f "$CONF" ]] || die "找不到配置文件: $CONF"

conf_get() {
  local key="$1" val
  val="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$CONF" 2>/dev/null | tail -n1 | cut -d= -f2-)"
  val="${val#"${val%%[![:space:]]*}"}"   # 去前导空格
  val="${val%"${val##*[![:space:]]}"}"   # 去尾随空格
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

URL="$(conf_get url)"
KEY="$(conf_get token)"
MODEL="${IMG_MODEL:-$(conf_get model)}";  MODEL="${MODEL:-gpt-image-1}"
SIZE="${IMG_SIZE:-$(conf_get size)}";     SIZE="${SIZE:-1024x1024}"
QUALITY="$(conf_get quality)"
DEFAULT_COUNT="$(conf_get count)"

[[ -n "$URL" ]] || die "请先在 $CONF 中填写 url="
[[ -n "$KEY" ]] || die "请先在 $CONF 中填写 token="

# 归一化出 API 基础地址（去掉末尾的 /images/xxx，保证以 /v1 结尾）
case "$URL" in
  */images/generations|*/images/edits) URL="${URL%/images/*}" ;;
  *) URL="${URL%/}" ;;
esac
case "$URL" in
  */v1) API_BASE="$URL" ;;
  *)    API_BASE="$URL/v1" ;;
esac

# ---------- 参数解析（flag 可放在任意位置） ----------
COUNT=""
DRY=0
MASK_FILE=""
IMAGE_FILES=()
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY=1; shift ;;
    -n|--count)     [[ -n "${2:-}" ]] || die "-n 需要一个数字"; COUNT="$2"; shift 2 ;;
    -n[0-9]*)       COUNT="${1#-n}"; shift ;;
    -i|--image)     [[ -n "${2:-}" ]] || die "-i 需要一个文件路径"; IMAGE_FILES+=("$2"); shift 2 ;;
    --image=*)      IMAGE_FILES+=("${1#*=}"); shift ;;
    -m|--mask)      [[ -n "${2:-}" ]] || die "-m 需要一个文件路径"; MASK_FILE="$2"; shift 2 ;;
    --mask=*)       MASK_FILE="${1#*=}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    --)             shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done ;;
    *)              POSITIONAL+=("$1"); shift ;;
  esac
done

PROMPT="${POSITIONAL[0]:-}"
OUT="${POSITIONAL[1]:-}"
[[ -n "$PROMPT" ]] || die "用法: ./img.sh [-i 原图] [-m 蒙版] [-n 数量] \"提示词\" [输出文件]"

EDIT_MODE=0
(( ${#IMAGE_FILES[@]} > 0 )) && EDIT_MODE=1
[[ -n "$MASK_FILE" ]] && (( EDIT_MODE == 0 )) && die "-m 蒙版需要配合 -i 原图使用"

if (( EDIT_MODE == 1 )); then
  for f in "${IMAGE_FILES[@]}"; do [[ -f "$f" ]] || die "原图不存在: $f"; done
  if [[ -n "$MASK_FILE" && ! -f "$MASK_FILE" ]]; then die "蒙版不存在: $MASK_FILE"; fi
fi

[[ -n "$COUNT" ]] || COUNT="${DEFAULT_COUNT:-1}"
[[ "$COUNT" =~ ^[0-9]+$ ]] || die "-n 必须是正整数: $COUNT"
COUNT=$((10#$COUNT))  # 按十进制解析，避免 08 这类写法被当成八进制
(( COUNT >= 1 )) || die "-n 必须 >= 1"
(( COUNT <= 20 )) || die "-n 一次最多 20 张"

JOBS="${IMG_JOBS:-5}"
[[ "$JOBS" =~ ^[0-9]+$ ]] || die "IMG_JOBS 必须是正整数: $JOBS"
JOBS=$((10#$JOBS))
(( JOBS >= 1 )) || die "IMG_JOBS 必须 >= 1"

# ---------- 端点 ----------
if (( EDIT_MODE == 1 )); then
  API_URL="$API_BASE/images/edits"
else
  API_URL="$API_BASE/images/generations"
fi

# ---------- 请求体 ----------
PAYLOAD="$(jq -n --arg m "$MODEL" --arg p "$PROMPT" --arg s "$SIZE" \
  '{model:$m, prompt:$p, size:$s, n:1}')" || die "生成请求体失败"
if [[ -n "$QUALITY" ]]; then
  PAYLOAD="$(jq --arg q "$QUALITY" '. + {quality:$q}' <<<"$PAYLOAD")"
fi

# 图生图的 multipart 参数（在 fork 前构建好，子进程直接复用）
FORM_ARGS=()
if (( EDIT_MODE == 1 )); then
  if (( ${#IMAGE_FILES[@]} == 1 )); then
    FORM_ARGS+=(-F "image=@${IMAGE_FILES[0]}")
  else
    for f in "${IMAGE_FILES[@]}"; do FORM_ARGS+=(-F "image[]=@$f"); done
  fi
  [[ -n "$MASK_FILE" ]] && FORM_ARGS+=(-F "mask=@$MASK_FILE")
  # 文本字段用 --form-string：-F 会把开头的 @ / < 当成要上传的本地文件
  FORM_ARGS+=(--form-string "prompt=$PROMPT" --form-string "model=$MODEL" --form-string "n=1")
  [[ -n "$SIZE" ]] && FORM_ARGS+=(--form-string "size=$SIZE")
  [[ -n "$QUALITY" ]] && FORM_ARGS+=(--form-string "quality=$QUALITY")
fi

if [[ "$DRY" == 1 ]]; then
  if (( EDIT_MODE == 1 )); then
    echo "POST $API_URL  (multipart/form-data)" >&2
    if (( ${#IMAGE_FILES[@]} == 1 )); then echo "  image=@${IMAGE_FILES[0]}" >&2
    else for f in "${IMAGE_FILES[@]}"; do echo "  image[]=@$f" >&2; done; fi
    [[ -n "$MASK_FILE" ]] && echo "  mask=@$MASK_FILE" >&2
    echo "  prompt=$PROMPT" >&2
    echo "  model=$MODEL  n=1  size=$SIZE${QUALITY:+  quality=$QUALITY}" >&2
  else
    echo "$PAYLOAD" | jq .
    echo "-> POST $API_URL   (model=$MODEL, size=$SIZE, count=$COUNT)" >&2
  fi
  exit 0
fi

# ---------- 输出命名 ----------
SAVE_DIR="$DIR/outputs"
mkdir -p "$SAVE_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -n "$OUT" ]]; then
  # 先拆出目录和文件名，只在文件名里找扩展名（目录名里的点不算，比如 assets.v1/banner）
  OUT_DIR="$(dirname -- "$OUT")"
  OUT_NAME="$(basename -- "$OUT")"
  if [[ "$OUT_NAME" == ?*.* ]]; then OUT_STEM="${OUT_NAME%.*}"; OUT_EXT="${OUT_NAME##*.}"; else OUT_STEM="$OUT_NAME"; OUT_EXT="png"; fi
  mkdir -p -- "$OUT_DIR"
  # 转成绝对路径，避免文件名以 - 开头时被当成命令行选项
  OUT_BASE="$(cd -- "$OUT_DIR" && pwd)/$OUT_STEM"
else
  OUT_BASE="$SAVE_DIR/img-$STAMP"; OUT_EXT="png"
  mkdir -p -- "$SAVE_DIR"
fi

target_for() {
  local i="$1"
  if (( COUNT == 1 )); then printf '%s.%s' "$OUT_BASE" "$OUT_EXT"
  else printf '%s-%d.%s' "$OUT_BASE" "$i" "$OUT_EXT"; fi
}

# 按文件头判断是不是 PNG / JPEG / GIF / WebP（od 在 Linux 和 macOS 上都有）
is_image() {
  local hex
  hex="$(od -An -tx1 -N12 -- "$1" 2>/dev/null | tr -d ' \n')"
  case "$hex" in
    89504e47*|ffd8ff*|47494638*|52494646????????57454250) return 0 ;;
  esac
  return 1
}

# 原子地占用一个还不存在的文件名（noclobber 下的 > 是排他创建）。
# 同名文件已存在，包括同一秒启动的另一个实例刚创建的，就依次尝试「名字 (2).ext」「名字 (3).ext」…
claim_target() {
  local want="$1" cand="$1" k=2
  until ( set -C; : > "$cand" ) 2>/dev/null; do
    [[ -e "$cand" ]] || return 1  # 不是因为重名失败（比如没有写权限）
    cand="${want%.*} ($k).${want##*.}"
    k=$((k + 1))
  done
  printf '%s' "$cand"
}

# ---------- 并发请求 ----------
WORK="$(mktemp -d)"
PIDS=()
cleanup() { (( ${#PIDS[@]} )) && kill "${PIDS[@]}" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

if (( EDIT_MODE == 1 )); then
  echo "图生图 $COUNT 张 | 模型 $MODEL | ${#IMAGE_FILES[@]} 张原图 | $SIZE" >&2
else
  echo "生成 $COUNT 张 | 模型 $MODEL | $SIZE | 并发 $JOBS" >&2
fi

START=$(date +%s)
for ((i = 1; i <= COUNT; i++)); do
  (
    if (( EDIT_MODE == 1 )); then
      BODY_ARGS=("${FORM_ARGS[@]}")
    else
      BODY_ARGS=(-H "Content-Type: application/json" -d "$PAYLOAD")
    fi
    curl -sS --max-time 600 -o "$WORK/r$i.json" -w '%{http_code}' \
      -X POST "$API_URL" \
      -H "Authorization: Bearer $KEY" \
      -H "Accept: application/json" \
      "${BODY_ARGS[@]}" > "$WORK/c$i.txt" 2> "$WORK/e$i.txt"
    echo $? > "$WORK/x$i.txt"
  ) &
  PIDS+=($!)
  if (( i % JOBS == 0 )); then wait; PIDS=(); fi
done
(( ${#PIDS[@]} )) && wait || true
PIDS=()

# ---------- 解析并保存 ----------
SAVED=0
SAVED_FILES=()
for ((i = 1; i <= COUNT; i++)); do
  RC="$(cat "$WORK/x$i.txt" 2>/dev/null || echo 1)"
  CODE="$(cat "$WORK/c$i.txt" 2>/dev/null || echo 000)"

  if [[ "$RC" != 0 ]]; then
    echo "[$i] 请求失败 (curl 退出码 $RC) $(head -c 300 "$WORK/e$i.txt" 2>/dev/null)" >&2
    continue
  fi
  if [[ "$CODE" != 2* ]]; then
    echo -n "[$i] HTTP $CODE: " >&2
    if jq -e . "$WORK/r$i.json" >/dev/null 2>&1; then
      jq -c '.error // .' "$WORK/r$i.json" 2>/dev/null | head -c 400 >&2
    else
      head -c 400 "$WORK/r$i.json" >&2
    fi
    echo >&2
    continue
  fi

  ITEM="$(jq -c '
    (if (.data|type)=="array" then .data
     elif (.images|type)=="array" then .images
     elif (.results|type)=="array" then .results
     else [.] end) | .[0] // empty' "$WORK/r$i.json" 2>/dev/null)"
  if [[ -z "$ITEM" ]]; then
    echo "[$i] 无法解析响应: $(head -c 300 "$WORK/r$i.json")" >&2
    continue
  fi

  B64="$(jq -r '.b64_json // .b64 // .image_base64 // .base64 // empty' <<<"$ITEM")"
  IMG_URL="$(jq -r '.url // .image_url // empty' <<<"$ITEM")"
  if [[ -z "$B64" && -z "$IMG_URL" ]]; then
    echo "[$i] 结果既无 b64_json 也无 url" >&2
    continue
  fi
  TARGET="$(claim_target "$(target_for "$i")")" || { echo "[$i] 无法创建文件: $(target_for "$i")" >&2; continue; }

  if [[ -n "$B64" ]]; then
    printf '%s' "$B64" | base64 -d > "$TARGET" 2>/dev/null || { rm -f -- "$TARGET"; echo "[$i] base64 解码失败" >&2; continue; }
  else
    # --fail：HTTP 4xx/5xx 时返回失败，不把错误页当成图片保存
    curl -fsSL --max-time 300 -o "$TARGET" "$IMG_URL" || { rm -f -- "$TARGET"; echo "[$i] 下载失败: $IMG_URL" >&2; continue; }
  fi
  # 接口返回 HTML 错误页、或 base64 解出来不是图片时，不算成功
  if ! is_image "$TARGET"; then
    echo "[$i] 返回的内容不是 PNG / JPEG / WebP / GIF 图片: $(head -c 60 -- "$TARGET" | LC_ALL=C tr -c '[:print:]' '.')" >&2
    rm -f -- "$TARGET"
    continue
  fi

  SAVED=$((SAVED + 1))
  SAVED_FILES+=("$TARGET")
  echo "[$i] ✔ $TARGET  ($(awk -v s="$(stat -c %s -- "$TARGET")" 'BEGIN{printf "%.1f MB", s/1048576}'), $(file -b --mime-type -- "$TARGET" 2>/dev/null))" >&2
done

ELAPSED=$(( $(date +%s) - START ))
echo "完成: $SAVED/$COUNT 张，用时 ${ELAPSED}s" >&2
(( SAVED > 0 )) || exit 1
printf '%s\n' "${SAVED_FILES[@]}"
