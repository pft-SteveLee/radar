# 每月 $100 API Credits 自動化 Jobs 規劃

Nov 3, 2026 · @Steve Lee

## 總覽

用 Max 方案每月 $100 的 Claude API credits 跑四個定期 job，預估月花費 $25–45，剩餘額度留給一次性的重活。這些 credits 只能用在 Claude API / Agent SDK / Managed Agents，不能用在互動式 Claude Code，且每個計費週期歸零不累積，所以目標是「每月穩定用掉大部分」而不是省。

| Job | 頻率 | 主要模型 | 預估月費 (USD) | 輸出 |
| --- | --- | --- | --- | --- |
| 1. Reddit 摘要 | 每日 | Haiku 5.5 篩選 + Sonnet 5.5 摘要 | 3–8 | CodiMD 每日一篇 |
| 2. 開發週報 (GitHub) | 每週一 | Sonnet 5.5（diff 深讀時用 Opus 5.5） | 3–6 | CodiMD 每週一篇 |
| 3. Changelog + skills / plugins 監控 (Claude Code、Orca ADE) | 每週 | Haiku 5.5 diff 偵測 + Sonnet 5.5 摘要 | 2–4 | CodiMD 每週一篇 |
| 4. AMP workspaces 競品比較 | 每月，或手動觸發 | Opus 5.5（Fable 5.1 做深度分析） | 15–25 | CodiMD 每 workspace 一篇 |
| 緩衝 / 一次性實驗 | 不定期 | 任意 | 剩餘 | — |

限制條件：

- 所有呼叫走 Messages API 或 Agent SDK，API key 來自 claude.ai Settings > Billing 連結的 Console org。
- 不用 Claude Code GitHub Action、IDE 擴充或 desktop app 啟動的執行，那些算 Claude Code 用量，credits 不會扣。
- 以上價格基準：Haiku 5.5 $0.10/$0.50、Sonnet 5.5 $2/$10、Opus 5.5 $4/$20、Fable 5.1 $10/$50（每百萬 input/output token），實際以 [Anthropic pricing](https://docs.claude.com/en/docs/about-claude/pricing) 為準。

## 共用架構

四個 job 放在同一個個人 repo `radar`，共用抓取、去重、模型呼叫、輸出四個模組，每個 job 只寫自己的 collector 和 prompt。

&#91;embedded content: 共用架構 · 4 個資料來源、1 條管線、3 種輸出\]

資料從左邊進來，每個 job 的 collector 抓完後先去重，只把新內容送給模型，結果存回 repo、全文上傳到內部 CodiMD。

**repo 結構**

```
radar/
├── jobs/
│   ├── reddit_digest.py
│   ├── dev_weekly.py
│   ├── changelog_watch.py
│   └── amp_compare.py
├── lib/
│   ├── claude.py        # Messages API 包裝、重試、token 計費記錄
│   ├── codimd.py        # 帳密登入拿 session，POST /new 建筆記，回傳網址
│   ├── state.py         # 已處理項目的 id / hash 快取
│   └── render.py        # Markdown 模板
├── prompts/             # 每個 job 的 system prompt，獨立檔案方便調
├── state/               # 快取，掛成 volume
├── output/              # 每次執行的 Markdown 報告，掛成 volume
├── crontab              # 四個 job 的排程，容器內由 supercronic 讀
├── Dockerfile
├── docker-compose.yml
└── .env.example         # 需要哪些環境變數，實際的 .env 不進 git
```

**排程**

- 一個 image，裝 Python 和四個 job；容器裡用 [supercronic](https://github.com/aptible/supercronic) 讀 `crontab` 排程（它專為容器設計，log 直接到 stdout，環境變數會傳進 job）。也可以不在容器裡跑 cron，改用主機的 cron 或 systemd timer 定時執行 `docker compose run --rm jobs python -m jobs.reddit_digest`，兩種都行，前者少一個依賴主機的點。
- 所有 key 走環境變數：`ANTHROPIC_API_KEY`（連結 Console org 的 key）、`GITHUB_TOKEN`、`CODIMD_URL`、`CODIMD_EMAIL`、`CODIMD_PASSWORD`、`TZ=Asia/Taipei`。用 `.env` 檔配 compose 的 `env_file`，`.env` 加進 `.gitignore`，repo 只放 `.env.example`。
- `state/` 和 `output/` 掛成 volume，容器重建不會丟快取；`config/` 和 `prompts/` 也掛進去，改 prompt 不用重 build。
- 手動重跑或補跑：`docker compose run --rm jobs python -m jobs.dev_weekly --week 2026-W45`，每個 job 的 CLI 都接受日期 / 週 / workspace 參數。
- 跑在能連到內部 CodiMD 的機器上（公司內的 VM 或你的工作機）。放在 GitHub Actions 的話 runner 連不到 CodiMD，Reddit 也常對雲端 IP 限流，所以不建議。
- 若主機不常開，加補跑機制：job 啟動時先看 `state/last_run.json`，漏掉的日期自動補。

**輸出通道（CodiMD）**

- 每個 job 一個頻道或一個固定標題前綴，方便之後搜尋。
- 完整報告上傳到內部 CodiMD：每次執行建一篇新筆記（CodiMD 的 `/new` 端點接受 POST 的 Markdown 內容並回傳筆記網址），標題固定格式如 `[Reddit 摘要] 2026-11-03`，方便搜尋。
- 你們的 CodiMD 沒有 API token，所以 `codimd.py` 用帳號密碼走 `/login` 表單登入（email + password 欄位）拿 session cookie，之後所有請求帶著它；cookie 快取在 `state/codimd_session.json`，失效就重登。建議開一個專用的 bot 帳號，不要用個人帳號；帳密只放在 `.env`，不要貼到聊天或文件裡。

**模型策略**

- 第一層永遠是 Haiku 5.5：分類、打分、過濾，決定哪些值得往下送。
- 第二層 Sonnet 5.5 寫摘要和報告。
- Opus 5.5 只用在需要讀大量 diff 或做比較判斷的地方；Fable 5.1 留給 Job 4 的深度分析和月底實驗。
- 所有 prompt 的固定部分（system prompt、格式範例）放在前面，利用 prompt caching。

**成本監控**

- `lib/claude.py` 每次呼叫都記錄 model、input/output token、估算 USD，寫進 `output/cost.jsonl`。
- 每篇 CodiMD 筆記尾端附上該次執行的花費。
- 在 Console 設每月 $100 上限、$70 提醒。

## Job 1：Reddit 每日摘要

每天早上 08:00（台北）把前 24 小時指定 subreddit 的新貼文整理成一篇 CodiMD 筆記，分主題列出最多 10 篇，附連結、留言數、熱門排名和留言摘要。月費估 $3–8。

**資料來源**

| 主題 | Subreddits | 抓法 |
| --- | --- | --- |
| Claude Code / AI coding | r/ClaudeAI, r/ClaudeCode, r/ChatGPTCoding, r/cursor, r/vibecoding | `https://www.reddit.com/r/<sub>/top.rss?t=day` |
| SEO | r/SEO, r/bigseo, r/TechSEO | 同上 |
| Orca ADE | 搜尋 `orca ade` 的 `search.rss`，加上 r/ClaudeAI 內的關鍵字命中 | `https://www.reddit.com/search.rss?q=...&sort=new` |

- 貼文 RSS 只有標題、作者、內文（self post 會有）和連結，沒有留言和分數；留言另外抓每篇的留言 RSS。按讚數和閱讀數拿不到。只用 RSS，不接 Reddit API。
- 設定一個自訂 User-Agent，Reddit 對預設 UA 會限流。

**流程**

1. 抓所有 feed，合併，用 `state/reddit_seen.json` 過濾已處理的 post id。
2. Haiku 5.5：對每篇給 0–5 分 + 主題標籤（claude-code / ai-coding / seo / orca / other），一次批次 50 篇送進去，回 JSON。
3. 取 ≥ 3 分的貼文，輪流從各 subreddit 依熱門排名選最多 10 篇，抓它們的留言，Sonnet 5.5 寫每篇的重點和留言摘要，按主題分組。
4. 套 Markdown 模板，上傳 CodiMD，存 `output/reddit/YYYY-MM-DD.md`。

**Prompt 重點**

- 評分標準寫清楚：新功能、實測心得、踩雷、workflow 技巧給高分；抱怨文、求助文、重複議題給低分。
- 標題、連結和指標由程式輸出，Sonnet 只寫摘要，用繁體中文。
- 給它過去 3 天的摘要當 context（約 3K token），避免重複報同一件事。

**成本估算**

- 每天 150–300 篇，標題 + 內文前 500 字，約 60–120K input token 給 Haiku：$0.01–0.02。
- 篩完 20–30 篇給 Sonnet，約 15–25K input + 2K output：$0.05–0.1。
- 每月約 $2–4；若用 Sonnet 做全部篩選，約 $8。

**完成定義**

- [ ] 連續跑 7 天不中斷，CodiMD 每天 08:00 前有當天的筆記
- [ ] 同一篇貼文不會在兩天出現
- [ ] 可用 `--date` 參數指定日期重跑

## Job 2：GitHub 每週開發週報

每週一 09:00（台北）整理上週團隊在 GitHub 的進度：每個人完成了什麼功能、哪些 PR 卡住、哪些 issue 開了很久沒動。月費估 $3–6。

**資料來源**

| 來源 | 抓什麼 | 工具 |
| --- | --- | --- |
| GitHub | 上週 merged PR（標題、描述、作者、reviewer、檔案數、+/- 行數、關聯 issue）、仍 open 的 PR 與開了幾天、上週 closed 與仍 open 的 issue | `gh` CLI 或 GitHub REST / GraphQL API，用 fine-grained PAT |

- 先列出要涵蓋的 repo 清單放在 `config/repos.yaml`，之後加 repo 只改設定。
- 大 PR（> 500 行）才額外抓 diff，其他只用 PR 描述和 commit message。

**流程**

1. 拉上週（週一 00:00 到週日 23:59）的 PR 和 issue，整理成一份 JSON。
2. Sonnet 5.5 第一輪：把 PR 按功能分組（靠 branch 名、PR 標題、描述裡的 issue 編號、標題相似度），輸出「功能 → PR 們 → issue」的對照。
3. Sonnet 5.5 第二輪：寫週報，三段：
   - 本週完成：按功能分組（不是按 PR），每個功能一到兩句說明做了什麼、誰做的。
   - 進行中 / 卡住：open 超過 3 天的 PR、review 等太久的、draft 放很久的。
   - 異常：issue 開超過兩週沒 PR、大改動的 PR 沒描述、同一功能多人同時動。
4. 上傳 CodiMD，存 `output/weekly/YYYY-WW.md`。

**Opus 用在哪**

- 只在需要判斷「這個 PR 實際做了什麼」而描述又寫得很少的時候，把 diff 給 Opus 5.5 寫一句說明。
- 用一個閾值控制：PR 描述少於 50 字且改動超過 100 行才送。一週大概 3–8 個，每個 $0.1–0.5。

**Prompt 重點**

- 給它團隊成員清單和各自負責的 workspace，讓它能按人和按子系統整理。
- 要求用功能語言寫（「購物車支援折扣碼」），不要用技術語言（「新增 DiscountService」）。
- 要求每個項目附 PR 連結和 issue 編號。

**成本估算**

- 一週 30–80 個 PR，約 50–150K input token 給 Sonnet 兩輪：$0.3–0.8。
- Opus 看 diff：$0.5–2。
- 每月約 $3–6。

**完成定義**

- [ ] 週報內容和你手動整理的版本對照，功能分組無明顯錯漏
- [ ] PR 按功能分組的正確率 > 90%
- [ ] 可指定任一週重跑

## Job 3：Claude Code / Orca ADE changelog 與 AI coding skills、plugins 監控

每週五 09:00（台北）比對各工具 changelog 和文件頁面的變化，只對「有變」的部分寫摘要，並標出對團隊 workflow 有影響的項目。月費估 $2–4。

**監控清單**（放 `config/changelog_sources.yaml`，一行一個）

| 來源 | 頁面類型 | 備註 |
| --- | --- | --- |
| Claude Code | GitHub CHANGELOG.md、官方 docs 的 release notes | 兩個都抓，GitHub 的更新快 |
| Claude API / Agent SDK | docs release notes、model deprecations 頁 | 模型價格或 deprecation 變動要特別標紅 |
| Orca ADE | [onorca.dev/changelog](https://www.onorca.dev/changelog)（每個版本有自己的頁面 `/changelog/<版本>`）、GitHub [stablyai/orca](https://github.com/stablyai/orca) 的 tags / releases、[onorca.dev/plugins](https://www.onorca.dev/plugins) | 幾乎每天出版本，一週可能 3–5 個；先用 GitHub tags API 偵測新版本號，再抓該版本的 changelog 頁面轉純文字。Haiku 的重要度篩選在這裡最關鍵，不然每週都是一長串 |
| Anthropic 官方 skills | [anthropics/skills](https://github.com/anthropics/skills) 的 `skills/` 目錄和各 SKILL.md | 用 GitHub API 列目錄，新資料夾 = 新 skill；SKILL.md 內容變了 = 更新 |
| Plugin marketplaces | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)、[anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community)、anthropics/knowledge-work-plugins 的 `.claude-plugin/marketplace.json` | 每個 marketplace 的目錄就是這個 JSON 檔，diff 它最準 |
| 社群 awesome 清單 | 例如 [awesome-claude-code-and-skills](https://github.com/GetBindu/awesome-claude-code-and-skills) 的 README | 抓 README diff，看新收錄了哪些 skills / plugins / marketplace |

**流程**

1. 抓每個來源的原始內容，轉成純文字，存 `state/changelog/<tool>.txt`。
2. 跟上一版做文字 diff，沒差異的直接跳過（這一步不花 token）。
3. 有差異的，把 diff + 前後 20 行 context 給 Haiku 5.5：分類（新功能 / 修正 / 棄用 / 價格 / 其他）並給重要度 0–3。
4. 重要度 ≥ 1 的給 Sonnet 5.5 寫摘要：每項一到兩句，加一句「對我們的影響」（例如「Claude Code 新增 X，可以取代我們現在的 Y 做法」）。
5. 上傳 CodiMD，存 `output/changelog/YYYY-WW.md`；一個月一次把四週的合併成趨勢回顧。

**Prompt 重點**

- 給它你們團隊目前的 workflow 描述（用什麼工具、哪些功能依賴），「影響」那句才寫得出來。
- Orca ADE 的變更要和 AMP 專案的 workspace 對應，所以把 workspace 清單也給它；skills / plugins 要和團隊目前已裝的清單比對，所以把那份清單也放進 prompt。
- 要求保留原始連結和版本號。

**技術注意**

- 頁面轉純文字用 `trafilatura` 或 `readability-lxml`，避免 nav、footer 的變動觸發假 diff。
- GitHub 來源一律走 API，不爬 HTML；skills 目錄和 marketplace.json 用 contents API 拿，順便記 commit SHA 當版本。
- 新 skill / plugin 出現時，把它的 SKILL.md 或 plugin 說明整段給 Sonnet，摘要寫「它做什麼、適不適合我們、跟我們現有的 skill 有沒有重疊」。
- 抓不到（403、頁面改版）要在當週筆記開頭標警告，不要靜默跳過。

**成本估算**

- 大部分週只有兩三個來源有變，diff 通常幾 K token。
- Haiku + Sonnet 一週 $0.2–0.5，每月約 $2–4。

**完成定義**

- [ ] 六個來源都能抓到並產生第一版 state
- [ ] 沒變化的週不發訊息（或只發一行「本週無重大更新」）
- [ ] 價格或 deprecation 變動有明顯標示

## Job 4：AMP workspaces 競品功能比較

每月一次（或手動對單一 workspace 觸發），為 AMP 專案的每個 workspace 產出一份「我們有的 / 競品有的 / 差距」功能矩陣和一頁分析。這是四個 job 裡最花錢、也最值得花的一個，月費估 $15–25，用剩餘額度可以加跑深度版。

**輸入**

| 輸入 | 來源 | 維護方式 |
| --- | --- | --- |
| 我方功能清單 | AMP repo 每個 workspace 的 README、docs、路由 / API 定義、feature flags | 由腳本從 repo 自動抽取，Sonnet 整理成功能清單後存 `state/amp/<workspace>_features.json`，人可以改 |
| 競品清單 | `config/competitors.yaml`：每個 workspace 對應 2–4 個競品，附功能頁 / docs / pricing 頁 URL | 手動維護，一季檢查一次 |
| 競品功能 | 抓上述 URL 轉純文字，另外用 web search 補最近三個月的 release notes | 自動 |
| 上次比較結果 | `output/amp/<workspace>/YYYY-MM.md` | 自動，給模型當 baseline |

`config/competitors.yaml` 初版先放三個 workspace，競品待填：

```yaml
workspaces:
  l10n:
    description: ""        # 一句話說明這個 workspace 做什麼，給模型當 context
    competitors:
      - name: ""
        urls: [""]           # 功能頁、docs、pricing
  edm:
    description: ""
    competitors: []
  dah:
    description: ""
    competitors: []
```

**流程**

1. 抽取我方功能：對每個 workspace，把 README、docs、API schema 給 Sonnet 5.5，輸出標準化功能清單（功能名、一句描述、成熟度：有 / 部分 / 無）。第一次跑之後人工校一次，之後只在 repo 有大變動時重抽。
2. 抓競品：每個競品的功能頁、docs 目錄、pricing 頁，轉純文字；用 Haiku 5.5 從中抽功能清單，格式同上。
3. 對齊：Opus 5.5 把我方和各競品的功能清單對齊到同一套功能分類（這步最需要判斷力，同一功能不同產品叫法不同），輸出矩陣。
4. 分析：Opus 5.5（或深度版用 Fable 5.1）針對矩陣寫一頁：我們獨有的、競品有我們沒有的、競品這個月新增的、建議優先補的 3 項和理由。
5. 存 `output/amp/<workspace>/YYYY-MM.md`，全文上傳 CodiMD，筆記開頭放三行重點。

**輸出格式**

```markdown
# <workspace> 競品比較 2026-11

## 功能矩陣
| 功能分類 | 功能 | AMP | 競品 A | 競品 B |
| --- | --- | --- | --- | --- |
| 身分驗證 | SSO (SAML) | 有 | 有 | 無 |

## 這個月的變化
- 競品 A 新增 …（連結）

## 差距分析
...

## 建議優先補的 3 項
1. ...
```

**Prompt 重點**

- 給 Opus 明確的功能分類骨架（例如：身分驗證、權限、資料匯入匯出、整合、通知、報表、API），讓不同 workspace 的輸出可以比較。
- 要求「無法確認」就寫「不確定」，不要猜；競品頁面沒寫的功能不代表沒有。
- 分析段限制 500 字，建議要能對應到具體的競品功能連結。

**成本估算**

- 假設 6 個 workspace、每個 3 個競品：
  - 我方抽取（Sonnet）：每 workspace 50–150K token，$0.1–0.3，共約 $1–2，不每月跑。
  - 競品抽取（Haiku）：每競品 30–80K token，幾乎免費。
  - 對齊 + 分析（Opus）：每 workspace 約 100–200K input + 5K output，$0.5–1；共 $3–6。
- 一般版每月約 $5–10。深度版（Fable 做分析、多抓 release notes）每 workspace 加 $2–4，全部跑約 $15–25。
- 建議月中跑一般版，月底看剩多少額度決定要不要跑深度版。

**完成定義**

- [ ] 先對 l10n 跑通，矩陣人工看過合理，再加 edm、dah
- [ ] 功能對齊的錯誤率你能接受（抽查 20 項）
- [ ] 可用 `--workspace` 和 `--deep` 參數指定 workspace 和深度

## 開發順序與里程碑

從最簡單、每天有產出的 Reddit 摘要開始，順便把共用模組建好；最花錢、最需要調 prompt 的 AMP 比較放最後。

&#91;embedded content: 開發時程 · 5 個階段，11/4 到 12/15\]

前三個 job 各一週，AMP 比較給兩週；12/15 看第一個完整月的花費和產出品質，決定模型分配要不要調。

**每個階段的交付**

1. 共用模組 + Reddit：`lib/` 四個模組、Dockerfile 和 compose 能起來、CodiMD 上傳能跑、成本記錄能跑。驗收：連跑 3 天。
2. Changelog 監控：六個來源的 collector（含 skills 目錄和 marketplace.json）、diff 邏輯。選它第二是因為它重用 Reddit 的篩選 + 摘要流程，改動最少。
3. 開發週報：GitHub collector、PR 功能分組、週報 prompt。驗收：跟你手工版對照一次。
4. AMP 競品比較：先對 l10n 跑通，再加 edm、dah，最後擴到全部。驗收：矩陣抽查 20 項。
5. 月度檢視：看 `output/cost.jsonl` 的總合、每個 job 的產出是否真的有看，決定下個月要不要把剩餘額度拿去跑深度版。

**用 Claude Code 開發時的建議**

- 把這份文件的對應段落貼進 `CLAUDE.md` 或當作第一個 prompt，讓它知道 repo 結構和模型策略。
- 每個 job 開一個 session，做完 `/clear`。
- 先讓它寫 collector 和用假資料跑通的測試，再接真的 API；這樣調 prompt 時不用一直打外部服務。
- 開發階段就把成本記錄打開，第一週就能知道估算準不準。

## 待確認事項

開始寫程式前要先定下來的幾件事，大多是你一句話就能回答的。

- [ ] **各 workspace 的競品清單**：workspace 先從 l10n、edm、dah 三個開始；每個還需要 2–4 個競品的名稱和功能頁 / docs URL，填進 `config/competitors.yaml` 後 Job 4 才能跑。
- [ ] **GitHub repo 清單**：token 由你提供，放 repo secrets；還需要一份要涵蓋的 repo 名單填進 `config/repos.yaml`。
- [ ] **`claude -p` 的計費歸屬**：有文章說用 linked org 的 API key 跑 `claude -p` 算 Agent SDK 用量、credits 會涵蓋，但官方文件表格對 Claude Code 只寫 No。本規劃全部走 Messages API，不依賴這一點；若你想在 Job 4 用 `claude -p` 讀 repo，先用 $1 以內的小任務實測，看 Console 的扣款。
- [ ] **CodiMD 的網址、版本與認證方式**：沒有 API token，改用帳密登入。還需要：CodiMD 的網址、一個 bot 帳號（你自己建並放進 `.env`，不用給我），以及確認登入後 `/new` 能用。

**Sources**

- [API credits for Max, Ultra, and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)：涵蓋範圍、不涵蓋 Claude Code、每月歸零。
- [Anthropic pricing](https://docs.claude.com/en/docs/about-claude/pricing)：模型價格。
