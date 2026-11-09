# 踢吶雙11夢幻刮刮樂

Discord OAuth2 登入、每個 Discord 帳號限抽一次、所有訪客共用 SQLite 庫存。網站使用 Node.js + Express，適合部署到 Render Docker Web Service。

## 獎項與庫存
- 雙11幸運大獎：2 份，權重 20%
- 111 WC 折扣：5 份，權重 20%
- 半價優惠：10 份，權重 20%
- 限定小禮物：不限量，權重 40%

有限庫存獎項抽完後會自動排除，剩餘獎項依權重重新分配。每位 Discord 使用者的抽獎結果及庫存都保存在 SQLite。

## 部署步驟（Render）
1. 將此專案全部檔案上傳到 GitHub repository 根目錄，`public` 資料夾要整個保留。
2. 到 https://dashboard.render.com/ 登入，選 New > Blueprint，選擇此 GitHub repository，依 `render.yaml` 建立服務。
3. 在 Render 服務的 Environment 設定：`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`BASE_URL`、`DISCORD_REDIRECT_URI`、`SESSION_SECRET`、`DATA_DIR=/data`、`NODE_ENV=production`。
4. `BASE_URL` 設為 Render 提供的網站網址，例如 `https://tina-double11.onrender.com`；`DISCORD_REDIRECT_URI` 設為 `https://你的網域/auth/discord/callback`。
5. 到 Discord Developer Portal 建立 Application，在 OAuth2 > Redirects 加入完全相同的 `DISCORD_REDIRECT_URI`。複製 Client ID 與 Client Secret 到 Render 環境變數。不要把 Client Secret 放進 GitHub 或傳給任何人。
6. 儲存環境變數並重新部署，打開網站測試 Discord 登入及抽獎。

## 本機測試
```bash
npm install
cp .env.example .env
# 填入 Discord OAuth 設定後
npm start
```
打開 http://localhost:3000 。Discord OAuth Redirect URI 本機測試需另外在 Discord Portal 加入 `http://localhost:3000/auth/discord/callback`。

## 重要
- 請勿把 `.env` 或 Discord Client Secret 上傳到 GitHub。
- 抽獎紀錄與庫存存在 SQLite，Render 需要 Persistent Disk 才能在重新部署後保留資料。
- 若正式活動開始前需要重置庫存與抽獎紀錄，請先備份資料庫，再由管理者操作；不要直接刪除資料庫檔案。
