# radar

排程產生報告並發佈到內部 CodiMD 的 jobs，另有狀態頁。開發指令與架構見 [CLAUDE.md](CLAUDE.md)。

## 部署

```
mkdir -p state output
cp .env.example .env    # 填入金鑰
docker compose up -d --build
```

- 狀態頁：`http://<host>:8080`
- PR 趨勢：`http://<host>:8080/prs`
- 筆記索引：CodiMD 的 `<CODIMD_URL>/radar-index`，每個 job 列最近 30 篇，每次發佈後自動更新。
- 排程在 `crontab`（`pr_stats` 每天 06:30、`reddit_digest` 每天 07:15、`changelog_watch` 每週五 09:00，台北時間）。
- 改 `.env` 後要執行 `docker compose up -d jobs`；`restart` 不會重新讀取 `.env`。

## 手動執行

```
docker compose exec jobs node jobs/redditDigest.ts
docker compose exec jobs node jobs/redditDigest.ts --date 2026-11-04 --no-upload
docker compose exec jobs node jobs/prStats.ts
docker compose exec jobs node jobs/changelogWatch.ts --no-upload
docker compose logs -f jobs
```

- `reddit_digest`：`--date` 指定日期，`--no-upload` 不發佈到 CodiMD。
- `pr_stats` 不帶參數時，抓最近 7 天（本週和上週）。
- `changelog_watch`：`--no-upload` 只在 `output/changelog/<週>.md` 寫出週報，不發佈，也不更新狀態；同一個資料夾的 `<週>.triage.json` 列出本週所有篩選後的變更（`selected: true` 表示有進週報；重要度 0 的也在裡面，`selected: false`），調整篩選標準、抽查有沒有重要的更新被誤判成 0 時看這個檔案。正式發佈後這批更新就算處理過，之後調整標準不會重篩，所以請先用 `--no-upload` 試跑確認。需要 `GITHUB_TOKEN` 和 `ANTHROPIC_API_KEY`；來源在 `config/changelog.yaml`，「對我們的影響」用的背景資料在 `config/changelogContext.md`（請改成團隊實際的狀況）。第一次執行時，文件頁和目錄類的來源只建立基準，下週才會有它們的變更。同一週重跑不會蓋掉已發佈的週報。

## 批次更新 PR

```
docker compose exec jobs node jobs/prStats.ts --from 2025-11-10 --to 2026-11-04
```

- 日期格式 `YYYY-MM-DD`。範圍碰到的每個 ISO 週都會重抓，並覆寫 `output/prStats/<週>.json`。
- 每週約 2.1 秒，52 週約 2 分鐘。
- 執行結果會出現在狀態頁。
- `config/prStats.yaml` 的 `members` 只決定 `/prs` 顯示誰，改它不用重抓。

### 只跑 pr_stats 需要的設定

`pr_stats` 不呼叫 Claude，也不發佈到 CodiMD，所以 `.env` 只需要：

| 變數 | 必要 | 說明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 是 | 沒設會直接報錯 `GITHUB_TOKEN is not set` |
| `TZ` | 建議 | `Asia/Taipei`，影響排程時間 |

`ANTHROPIC_API_KEY`、`CODIMD_*` 可以留空。另外要有 `config/prStats.yaml`（`orgs` 為要統計的 org，`members` 為 `/prs` 顯示的人）。

### GITHUB_TOKEN 權限

只讀取 merged PR 的作者，不寫入任何東西。Token 必須看得到 `orgs` 裡每個 org 的私有 repo，看不到的 repo 會被當成不存在：

- classic token：勾 `repo`（只統計公開 repo 的話，`public_repo` 就夠）。其他 scope 都不用勾。
- fine-grained token：
  - Resource owner 選該 org（不是個人帳號）。
  - Repository access 選 All repositories，只選部分 repo 就只會統計那些。
  - Repository permissions：Pull requests 設 Read-only；Metadata 為 Read-only（系統自動加上）。
  - 該 org 若要求核准 fine-grained token，要等管理員核准才生效。
- org 啟用 SAML SSO 時，token 要在 GitHub 的 Tokens 頁面對該 org 按 Authorize，否則一樣回 0 筆。

看不到時，GitHub 回傳 0 筆而不是錯誤，所以每週都會是 0，但這次執行仍顯示成功。重抓前先檢查（把整段原樣貼上，不要讓終端機在字串中間斷行）：

```
docker compose exec jobs node --input-type=module -e '
const q = "org:perfect-corp is:pr is:merged merged:2026-10-26..2026-11-01";
const url = "https://api.github.com/search/issues?per_page=1&q=" + encodeURIComponent(q);
const r = await fetch(url, { headers: { authorization: "Bearer " + process.env.GITHUB_TOKEN } });
console.log(r.status, r.headers.get("x-github-sso"), (await r.json()).total_count);
'
```

印出的數字是 0 代表 token 看不到該 org；出現 `x-github-sso` 的值代表要先做 SSO 授權。
