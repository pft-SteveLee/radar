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
- 排程在 `crontab`（`pr_stats` 每天 06:30、`reddit_digest` 每天 07:30，台北時間）。
- 改 `.env` 後要執行 `docker compose up -d jobs`；`restart` 不會重新讀取 `.env`。

## 手動執行

```
docker compose exec jobs node jobs/redditDigest.ts
docker compose exec jobs node jobs/redditDigest.ts --date 2026-11-04 --no-upload
docker compose exec jobs node jobs/prStats.ts
docker compose logs -f jobs
```

- `reddit_digest`：`--date` 指定日期，`--no-upload` 不發佈到 CodiMD。
- `pr_stats` 不帶參數時，抓最近 7 天（本週和上週）。

## 批次更新 PR

```
docker compose exec jobs node jobs/prStats.ts --from 2025-11-10 --to 2026-11-04
```

- 日期格式 `YYYY-MM-DD`。範圍碰到的每個 ISO 週都會重抓，並覆寫 `output/prStats/<週>.json`。
- 每週約 2.1 秒，52 週約 2 分鐘。
- 執行結果會出現在狀態頁。
- `config/prStats.yaml` 的 `members` 只決定 `/prs` 顯示誰，改它不用重抓。

### GITHUB_TOKEN

Token 必須看得到 `config/prStats.yaml` 中 org 的私有 repo：

- classic token：勾 `repo`。
- fine-grained token：Resource owner 選該 org，Pull requests 與 Metadata 給唯讀。

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
