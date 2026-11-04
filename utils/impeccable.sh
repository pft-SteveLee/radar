#!/usr/bin/env bash
#
# impeccable-batch.sh
# ---------------------------------------------------------------------------
# 用 Anthropic API credits 批次跑 impeccable (pbakaus/impeccable) 的
# /impeccable audit 與 /impeccable critique,把整個專案的前端 surface
# 掃過一遍,產出 Markdown 報告 + 一份實作 backlog。
# 之後你再用互動式 Claude Code 針對這些文件實作。
#
# 設計原則:
#   0. 自己認頁面 — 預設 --unit auto:先讓 Claude 掃一次 repo,判斷框架與路由
#      慣例後列出所有使用者會看到的頁面,然後直接全部排進批次跑,不用你先確認。
#      認不出來才退回 find 規則。清單會快取在 .impeccable-batch/surfaces.txt。
#   1. 全程唯讀 — 只給 Read/Grep/Glob,不會動到你的 repo。報告由本 script 收
#      stdout 寫檔,不讓模型自己寫。
#   2. 可中斷可續跑 — 已完成的 surface 預設跳過,崩潰重跑不會重複燒錢。
#   3. 花費有上限 — 單次呼叫 + 全域總預算雙重保險,超過就停。
#   4. 強制 API key 計費 — preflight 會擋下 subscription 計費的情況。
#
# 用法:
#   ./impeccable-batch.sh /path/to/project    # 偵測頁面 → 全部跑完 → 產 backlog
#
#   --unit auto|route|component|dir   切分單位,預設 auto (由 Claude 判斷)
#   --discover-only                   只偵測並印出頁面清單,先不花錢跑批次
#   --force                           忽略快取,重新偵測 + 重跑已完成的
#   --surfaces my-list.txt            跳過偵測,直接用你自己的清單
#   --dry-run                         印出會送出的指令,不實際呼叫
#   --budget-total 50                 整批花費上限 (USD),預設 20
#   --parallel 4                      併發數,預設 3
#   --detect                          額外跑免費的 npx impeccable detect
#
# 想先看它認到哪些頁面再決定:
#   ./impeccable-batch.sh ~/myapp --discover-only
#   vim ~/myapp/.impeccable-batch/surfaces.txt   # 砍掉不想花錢掃的
#   ./impeccable-batch.sh ~/myapp                # 沿用這份清單接著跑
# ---------------------------------------------------------------------------

set -uo pipefail

# ============================ 預設參數 ============================

PROJECT=""
UNIT="auto"                  # auto | route | component | dir
COMMANDS="audit critique"    # 每個 surface 要跑的 impeccable 指令
MODEL="sonnet"
PARALLEL=3                   # 併發數,官方沒公布上限,2~4 是安全起點
MAX_TURNS=20
BUDGET_PER_CALL="0.75"       # 單次呼叫上限 (USD)
BUDGET_DISCOVER="0.50"       # auto 偵測頁面那一次呼叫的上限 (USD)
BUDGET_TOTAL="20.00"         # 整批上限 (USD)
OUTDIR_NAME=".impeccable-batch"
SURFACES_FILE=""
CMD_PREFIX=""                # 留空則 preflight 自動判定 /impeccable: 或 /impeccable
DISCOVER_ONLY=0
DRY_RUN=0
FORCE=0                      # 1 = 不跳過已完成的
RUN_DETECT=0                 # npx impeccable detect,不花 API 費用
RUN_BACKLOG=1                # 最後彙整成 BACKLOG.md

# ============================ 參數解析 ============================

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)            UNIT="$2"; shift 2 ;;
    --commands)        COMMANDS="$2"; shift 2 ;;
    --model)           MODEL="$2"; shift 2 ;;
    --parallel)        PARALLEL="$2"; shift 2 ;;
    --max-turns)       MAX_TURNS="$2"; shift 2 ;;
    --budget-per-call) BUDGET_PER_CALL="$2"; shift 2 ;;
    --budget-discover) BUDGET_DISCOVER="$2"; shift 2 ;;
    --budget-total)    BUDGET_TOTAL="$2"; shift 2 ;;
    --surfaces)        SURFACES_FILE="$2"; shift 2 ;;
    --cmd-prefix)      CMD_PREFIX="$2"; shift 2 ;;
    --discover-only)   DISCOVER_ONLY=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --force)           FORCE=1; shift ;;
    --detect)          RUN_DETECT=1; shift ;;
    --no-backlog)      RUN_BACKLOG=0; shift ;;
    -h|--help)         sed -n '2,40p' "$0"; exit 0 ;;
    -*)                echo "未知參數: $1" >&2; exit 64 ;;
    *)                 PROJECT="$1"; shift ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "用法: $0 <project-dir> [options]   (--help 看完整說明)" >&2; exit 64; }
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd)" || { echo "找不到專案目錄" >&2; exit 66; }

OUT="$PROJECT/$OUTDIR_NAME"
RUNS="$OUT/runs"
REPORTS="$OUT/reports"
LOG="$OUT/batch.log"
mkdir -p "$RUNS" "$REPORTS"

log()  { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

# ============================ Phase 0: Preflight ============================

log "=== Preflight ==="

command -v claude >/dev/null || die "找不到 claude CLI"
command -v jq     >/dev/null || die "需要 jq (brew install jq / apt install jq)"

# --- 計費來源:必須是 API key,不能是 Pro/Max subscription ---
# -p 模式下 ANTHROPIC_API_KEY 一旦存在就優先於 subscription 登入。
AUTH_JSON="$(claude auth status 2>/dev/null)"
AUTH_METHOD="$(jq -r '.authMethod // "unknown"' <<<"$AUTH_JSON" 2>/dev/null)"

if [[ "$AUTH_METHOD" != "api_key" ]]; then
  warn "目前計費方式是「$AUTH_METHOD」,不是 API credits。"
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "但偵測到 ANTHROPIC_API_KEY 已設定,-p 模式會優先使用它。繼續。"
  else
    die "請先 export ANTHROPIC_API_KEY=sk-ant-... 再跑 (這樣才會從 API credits 扣款,而不是你的訂閱額度)"
  fi
else
  ok "計費來源: API key"
fi

# --- 確認 impeccable plugin 已安裝,並決定 slash command 的寫法 ---
# plugin skill 一律可用 /plugin-name:skill-name 的命名空間形式;
# 裸名 /impeccable audit 只在沒有名稱衝突時有效,所以預設用命名空間形式。
if [[ -z "$CMD_PREFIX" ]]; then
  PLUGIN_LIST="$(claude plugin list 2>/dev/null || true)"
  if grep -qi 'impeccable' <<<"$PLUGIN_LIST"; then
    CMD_PREFIX="/impeccable:"
    ok "impeccable plugin 已安裝,使用 ${CMD_PREFIX}<command>"
  else
    warn "claude plugin list 裡沒看到 impeccable。若尚未安裝,請先執行:"
    warn "    claude plugin marketplace add pbakaus/impeccable --scope user"
    warn "    claude plugin install impeccable@impeccable --scope user"
    warn "若你是用 npx impeccable install 裝成 skill (非 plugin),請加 --cmd-prefix '/impeccable '"
    CMD_PREFIX="/impeccable:"
  fi
fi

# --- 探測 JSON envelope 的欄位名 (官方文件只保證 result/session_id/total_cost_usd) ---
PROBE="$RUNS/_probe.json"
if [[ $DRY_RUN -eq 0 && ! -f "$PROBE" ]]; then
  log "探測 JSON 輸出格式 (一次極短呼叫,成本約 \$0.001)…"
  claude -p "Reply with exactly: ok" \
    --model haiku --permission-mode dontAsk --tools "" \
    --max-turns 1 --output-format json </dev/null >"$PROBE" 2>/dev/null
  if jq -e '.total_cost_usd' "$PROBE" >/dev/null 2>&1; then
    ok "JSON envelope 可用,欄位: $(jq -r 'keys | join(", ")' "$PROBE")"
  else
    warn "探測回傳異常,成本統計可能不準。內容:"; head -c 400 "$PROBE" >&2; echo
  fi
fi

# ============================ Phase 1: 探索 surfaces ============================

SURFACES="$OUT/surfaces.txt"

discover() {
  cd "$PROJECT" || return 1
  local prune='-path ./node_modules -o -path ./.git -o -path ./dist -o -path ./build -o -path ./.next -o -path ./out -o -path ./coverage -o -path ./vendor -o -path ./.impeccable-batch'
  case "$UNIT" in
    route)
      # Next.js app/pages router、SvelteKit、Nuxt、Remix、Vue Router 慣例
      eval "find . \( $prune \) -prune -o -type f \( \
        -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' -o -name 'page.js' \
        -o -name '+page.svelte' -o -name 'index.vue' \
        \) -print" 2>/dev/null
      eval "find ./pages ./src/pages ./app/routes ./src/routes ./src/views \( $prune \) -prune -o -type f \
        \( -name '*.tsx' -o -name '*.jsx' -o -name '*.vue' -o -name '*.svelte' \) -print" 2>/dev/null \
        | grep -Ev '/(_app|_document|api)/|/_(app|document)\.' || true
      ;;
    component)
      eval "find . \( $prune \) -prune -o -type d \( -name components -o -name ui -o -name widgets \) -print" 2>/dev/null \
      | while read -r d; do
          find "$d" -type f \( -name '*.tsx' -o -name '*.jsx' -o -name '*.vue' -o -name '*.svelte' \) 2>/dev/null
        done
      ;;
    dir)
      eval "find . \( $prune \) -prune -o -type d -print" 2>/dev/null \
      | while read -r d; do
          local n
          n=$(find "$d" -maxdepth 1 -type f \( -name '*.tsx' -o -name '*.jsx' -o -name '*.vue' -o -name '*.svelte' -o -name '*.css' \) 2>/dev/null | wc -l)
          [[ "$n" -ge 2 ]] && echo "$d"
        done
      ;;
    *) die "--unit 只能是 auto / route / component / dir" ;;
  esac
}

# --- auto: 讓 Claude 先掃一次 repo,自己認出有哪些頁面 ---
# 比 find 規則強的地方:看得懂自訂 router、monorepo、非慣例目錄、
# 以及哪些檔案其實是 layout/api/測試而不該算一個頁面。
# 成本約 $0.05~0.20 的一次性呼叫,之後結果快取在 surfaces.txt。
discover_auto() {
  local json="$RUNS/_discover.json"
  local prompt
  prompt="$(cat <<'EOF'
Identify every distinct user-facing page or screen in this project — the surfaces a real user actually navigates to and looks at.

Method: work out the framework and routing convention first (read package.json, the router config, and the directory layout), then enumerate the routes.

Include: pages, screens, routes, standalone views, and major full-page modal or wizard flows.
Exclude: API routes and server handlers, layouts and providers, error/loading/not-found boundaries, tests, stories, build output, dependencies, and anything not rendered to an end user.

Output format — obey exactly:
- One project-relative file path per line, and nothing else.
- The path must be the file that defines that page.
- No markdown, no bullets, no numbering, no backticks, no headings, no commentary, no blank-line grouping.
- If you cannot determine the pages, output the single word: NONE
EOF
)"

  CLAUDE_CODE_RETRY_WATCHDOG=1 \
  claude -p "$prompt" \
    --model "$MODEL" \
    --permission-mode dontAsk \
    --permission-prompts none \
    --allowedTools "Read,Grep,Glob" \
    --max-turns 40 \
    --max-budget-usd "$BUDGET_DISCOVER" \
    --add-dir "$PROJECT" \
    --output-format json \
    </dev/null >"$json" 2>"$RUNS/_discover.err"

  jq -r '.result // empty' "$json" 2>/dev/null \
    | tr -d '\r' \
    | sed -e 's/^[[:space:]]*[-*][[:space:]]*//' -e 's/^[0-9]\+[.)][[:space:]]*//' \
          -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^`\(.*\)`$/\1/' \
          -e 's|^\./||' \
    | grep -v '^$' \
    | while IFS= read -r p; do
        # 只信任真的存在於專案裡的路徑,擋掉幻覺
        [[ -e "$PROJECT/$p" ]] && echo "$p"
      done
}

if [[ -n "$SURFACES_FILE" ]]; then
  cp "$SURFACES_FILE" "$SURFACES"
  ok "使用你指定的 surface 清單: $SURFACES_FILE"
elif [[ -s "$SURFACES" && $FORCE -eq 0 && $DISCOVER_ONLY -eq 0 ]]; then
  ok "沿用既有清單 $SURFACES ($(grep -cve '^\s*$' -e '^#' "$SURFACES") 個 surface)"
else
  log "=== 探索 surfaces (unit=$UNIT) ==="
  FOUND="$(mktemp)"; USED_UNIT="$UNIT"

  if [[ "$UNIT" == "auto" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      warn "--dry-run:跳過 auto 偵測,改用 route 規則"
      UNIT=route; USED_UNIT="route(dry-run)"; discover > "$FOUND"
    else
      log "讓 Claude 掃描專案、自行辨識頁面中…(一次性呼叫,上限 \$$BUDGET_DISCOVER)"
      discover_auto > "$FOUND"
      n=$(grep -cve '^$' "$FOUND" 2>/dev/null || echo 0)
      if [[ "$n" -gt 0 ]]; then
        ok "Claude 認出 $n 個頁面 (花費 \$$(jq -r '.total_cost_usd // 0' "$RUNS/_discover.json" 2>/dev/null))"
      else
        warn "auto 偵測沒有結果,退回 find 規則 (route)"
        UNIT=route; USED_UNIT="route(auto-fallback)"; discover > "$FOUND"
      fi
    fi
  else
    discover > "$FOUND"
  fi

  { echo "# impeccable batch surface 清單 — 一行一個路徑"
    echo "# 這份清單會被快取。想重新偵測就加 --force,想手動調整就直接編輯本檔 (# 可註解掉)"
    echo "# unit=$USED_UNIT  generated=$(date -Iseconds)"
    sed 's|^\./||' "$FOUND" | sort -u
  } > "$SURFACES"
  rm -f "$FOUND"
  ok "產出 $SURFACES ($(grep -cve '^\s*$' -e '^#' "$SURFACES") 個 surface)"
fi

mapfile -t TARGETS < <(grep -ve '^\s*$' -e '^\s*#' "$SURFACES")
[[ ${#TARGETS[@]} -gt 0 ]] || die "surface 清單是空的,請檢查 $SURFACES 或換一個 --unit"

if [[ $DISCOVER_ONLY -eq 1 ]]; then
  echo
  printf '\n偵測到的頁面:\n'; printf '  %s\n' "${TARGETS[@]}"
  echo
  ok "只偵測模式。直接重跑本 script (不加 --discover-only) 就會沿用這份清單開跑;"
  ok "想調整就先編輯 $SURFACES。"
  printf '  預估呼叫次數: %d surface × %d 指令 = %d 次\n' \
    "${#TARGETS[@]}" "$(wc -w <<<"$COMMANDS")" "$(( ${#TARGETS[@]} * $(wc -w <<<"$COMMANDS") ))"
  exit 0
fi

# ============================ 免費的規則式掃描 ============================

if [[ $RUN_DETECT -eq 1 ]]; then
  log "=== npx impeccable detect (不耗 API credits) ==="
  (cd "$PROJECT" && npx --yes impeccable detect . --json) > "$OUT/detect.json" 2>"$OUT/detect.err"
  case $? in
    0) ok "detect: 無發現" ;;
    2) ok "detect: 有發現,見 $OUT/detect.json" ;;
    *) warn "detect 執行失敗,見 $OUT/detect.err" ;;
  esac
fi

# ============================ Phase 2: 批次分析 ============================

# 給模型的輸出規格。注意:prompt 那一行整行都會被當成 skill 的參數,
# 所以額外指示必須走 --append-system-prompt,不能接在 slash command 後面。
read -r -d '' SYSTEM_APPEND <<'EOF'
You are running non-interactively as part of an automated batch. Rules:
- You have read-only access. Never attempt to create, edit, or delete any file.
- Your entire stdout result must be a single self-contained Markdown report.
- Start with an H1 naming the surface under review.
- For every finding use this exact shape so it can be parsed downstream:
    ### [SEVERITY] Short title
    - **File**: path:line
    - **Problem**: what is wrong
    - **Fix**: the concrete change to make
  SEVERITY is one of: BLOCKER, MAJOR, MINOR, NIT.
- Be specific to the code you actually read. Cite real file paths and line numbers.
- No preamble, no sign-off, no questions back to the user.
EOF

slug() { sed -e 's|[/.]|_|g' -e 's|^_||' <<<"$1"; }

# 逐檔累加,單一壞掉的 JSON 不會把整個統計歸零
tally_cost() {
  find "$RUNS" -name '*.json' ! -name '_probe.json' -print0 2>/dev/null \
    | while IFS= read -r -d '' f; do
        jq -r '.total_cost_usd // 0' "$f" 2>/dev/null || echo 0
      done \
    | awk '{s+=$1} END{printf "%.4f", s+0}'
}

over_budget() {
  local spent; spent="$(tally_cost)"
  awk -v s="$spent" -v b="$BUDGET_TOTAL" 'BEGIN{exit !(s>=b)}'
}

run_one() {
  local target="$1" cmd="$2"
  local sl; sl="$(slug "$target")"
  local json="$RUNS/${sl}.${cmd}.json"
  local md="$REPORTS/${sl}/${cmd}.md"

  if [[ $FORCE -eq 0 && -s "$md" ]]; then
    printf '  · skip   %-50s %s\n' "$target" "$cmd"
    return 0
  fi
  mkdir -p "$(dirname "$md")"

  local prompt="${CMD_PREFIX}${cmd} ${target}"

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  claude -p %q --model %s …\n' "$prompt" "$MODEL"
    return 0
  fi

  local sid; sid="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  CLAUDE_CODE_RETRY_WATCHDOG=1 \
  claude -p "$prompt" \
    --model "$MODEL" \
    --permission-mode dontAsk \
    --permission-prompts none \
    --allowedTools "Read,Grep,Glob" \
    --append-system-prompt "$SYSTEM_APPEND" \
    --max-turns "$MAX_TURNS" \
    --max-budget-usd "$BUDGET_PER_CALL" \
    --session-id "$sid" \
    --output-format json \
    </dev/null >"$json" 2>"$RUNS/${sl}.${cmd}.err"
  local rc=$?

  local subtype cost
  subtype="$(jq -r '.subtype // (if .is_error then "error" else "success" end)' "$json" 2>/dev/null || echo parse_error)"
  cost="$(jq -r '.total_cost_usd // 0' "$json" 2>/dev/null || echo 0)"

  if [[ $rc -eq 0 && "$subtype" == "success" ]]; then
    jq -r '.result' "$json" > "$md"
    printf '  ✓ %-50s %-9s $%s\n' "$target" "$cmd" "$cost"
  else
    printf '  ✗ %-50s %-9s rc=%s %s\n' "$target" "$cmd" "$rc" "$subtype"
    echo "$target|$cmd|$rc|$subtype|$sid" >> "$OUT/failures.txt"
    rm -f "$md"
  fi
}

log "=== 批次分析: ${#TARGETS[@]} surface × $(wc -w <<<"$COMMANDS") 指令, 併發 $PARALLEL ==="
log "模型=$MODEL  單次上限=\$$BUDGET_PER_CALL  總預算=\$$BUDGET_TOTAL"
: > "$OUT/failures.txt"

for target in "${TARGETS[@]}"; do
  for cmd in $COMMANDS; do
    if over_budget; then
      warn "已達總預算 \$$BUDGET_TOTAL (已花 \$$(tally_cost)),停止派送新工作。"
      warn "提高 --budget-total 後重跑即可從中斷處接續 (已完成的會自動跳過)。"
      break 2
    fi
    while [[ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]]; do wait -n; done
    run_one "$target" "$cmd" &
  done
done
wait

SPENT="$(tally_cost)"
ok "批次完成,此專案累計 API 花費約 \$$SPENT"
[[ -s "$OUT/failures.txt" ]] && warn "有 $(wc -l <"$OUT/failures.txt") 次呼叫失敗,見 $OUT/failures.txt"

# ============================ Phase 3: 彙整 ============================

log "=== 彙整 ==="

{
  echo "# Impeccable 批次分析結果"
  echo
  echo "- 專案: \`$PROJECT\`"
  echo "- 時間: $(date -Iseconds)"
  echo "- 切分單位: \`$UNIT\` · 指令: \`$COMMANDS\` · 模型: \`$MODEL\`"
  echo "- Surface 數: ${#TARGETS[@]} · API 花費: \$$SPENT"
  echo
  echo "## 報告索引"
  echo
  hdr="| Surface |"; sep="|---|"
  for c in $COMMANDS; do hdr+=" $c |"; sep+="---|"; done
  echo "$hdr BLOCKER | MAJOR |"
  echo "$sep---|---|"
  for target in "${TARGETS[@]}"; do
    sl="$(slug "$target")"
    row="| \`$target\` |"
    for cmd in $COMMANDS; do
      f="$REPORTS/$sl/$cmd.md"
      [[ -s "$f" ]] && row+=" [報告](reports/$sl/$cmd.md) |" || row+=" — |"
    done
    b=$(grep -ho '\[BLOCKER\]' "$REPORTS/$sl/"*.md 2>/dev/null | wc -l | tr -d ' ')
    m=$(grep -ho '\[MAJOR\]'   "$REPORTS/$sl/"*.md 2>/dev/null | wc -l | tr -d ' ')
    echo "$row $b | $m |"
  done
  echo
  echo "## 嚴重度總計"
  echo
  for sev in BLOCKER MAJOR MINOR NIT; do
    n=$(grep -rho "\[$sev\]" "$REPORTS" 2>/dev/null | wc -l | tr -d ' ')
    echo "- **$sev**: $n"
  done
} > "$OUT/INDEX.md"
ok "$OUT/INDEX.md"

# 把所有報告收斂成一份可直接拿去實作的 backlog
if [[ $RUN_BACKLOG -eq 1 && $DRY_RUN -eq 0 ]]; then
  log "產生實作 backlog…"
  sid="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
  CLAUDE_CODE_RETRY_WATCHDOG=1 \
  claude -p "Read every Markdown report under $REPORTS and produce a single prioritised implementation backlog in Markdown. Group findings by theme (not by file) where the same root cause repeats across surfaces. For each item give: a one-line title, severity, the concrete change, every affected file path, and a rough effort estimate (S/M/L). Put BLOCKER and cross-cutting systemic items first. Collapse duplicates aggressively — this list is what an engineer will work through top to bottom. Output only the Markdown." \
    --model "$MODEL" \
    --permission-mode dontAsk \
    --permission-prompts none \
    --allowedTools "Read,Grep,Glob" \
    --max-turns 40 \
    --max-budget-usd 2.00 \
    --session-id "$sid" \
    --output-format json \
    </dev/null >"$RUNS/_backlog.json" 2>"$RUNS/_backlog.err"

  if jq -e '.result' "$RUNS/_backlog.json" >/dev/null 2>&1; then
    jq -r '.result' "$RUNS/_backlog.json" > "$OUT/BACKLOG.md"
    ok "$OUT/BACKLOG.md"
  else
    warn "backlog 產生失敗,見 $RUNS/_backlog.err"
  fi
fi

{
  echo "# API 花費明細"
  echo
  echo "| Surface | 指令 | USD | input | output | cache read |"
  echo "|---|---|---|---|---|---|"
  find "$RUNS" -name '*.json' ! -name '_probe.json' | sort | while read -r f; do
    base="$(basename "$f" .json)"
    jq -r --arg b "$base" '"| \($b) | | \(.total_cost_usd // 0) | \(.usage.input_tokens // 0) | \(.usage.output_tokens // 0) | \(.usage.cache_read_input_tokens // 0) |"' "$f" 2>/dev/null
  done
  echo
  echo "**總計 (此專案所有批次累計): \$$(tally_cost)**"
  echo
  echo "> 這是 client 端估算值。實際帳務請看 platform.claude.com/usage。"
} > "$OUT/COST.md"
ok "$OUT/COST.md"

echo
ok "全部完成。下一步,用互動式 Claude Code 開始實作:"
echo "    cd $PROJECT && claude"
echo "    > 讀 $OUTDIR_NAME/BACKLOG.md,從第一個 BLOCKER 開始做"
