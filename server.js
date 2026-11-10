require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (process.env.RENDER ? '/data' : path.join(__dirname, 'data'));

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tina-double11.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    prize_id TEXT PRIMARY KEY,
    remaining INTEGER,
    weight INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS draws (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    prize_id TEXT NOT NULL,
    prize_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS google_drive_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    refresh_token TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS google_sheets_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    spreadsheet_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const initial = [
  ['grand', 2, 20],
  ['discount111', 5, 20],
  ['half', 10, 20],
  ['gift', -1, 40]
];

const insert = db.prepare(
  'INSERT OR IGNORE INTO inventory (prize_id, remaining, weight) VALUES (?, ?, ?)'
);
initial.forEach(item => insert.run(...item));

const PRIZES = {
  grand: {
    name: '雙11幸運大獎',
    detail: '恭喜獲得踢吶雙11限定大獎！'
  },
  discount111: {
    name: '111 WC 折扣',
    detail: '可選擇一項商品，享 111 WC 優惠'
  },
  half: {
    name: '半價優惠',
    detail: '可選擇一項商品，享半價優惠'
  },
  gift: {
    name: '限定小禮物',
    detail: '可用 11 WC 帶走限定小禮物'
  }
};

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'please-change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function googleOAuthClient(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('尚未設定 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET');
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${baseUrl(req)}/auth/google/callback`;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function requireBackupAdmin(req, res, next) {
  const adminDiscordId = process.env.BACKUP_ADMIN_DISCORD_ID;

  if (!adminDiscordId) {
    return res.status(503).send('尚未設定 BACKUP_ADMIN_DISCORD_ID。');
  }

  if (!req.session.discordUser || req.session.discordUser.id !== adminDiscordId) {
    return res.status(403).send('只有網站管理員可以設定 Google Drive 備份。');
  }

  next();
}

/* Discord 登入 */

app.get('/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(503).send('尚未設定 Discord OAuth。');
  }

  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;

  const redirect =
    process.env.DISCORD_REDIRECT_URI ||
    `${baseUrl(req)}/auth/discord/callback`;

  const url = new URL('https://discord.com/oauth2/authorize');

  url.search = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirect,
    scope: 'identify',
    state
  }).toString();

  res.redirect(url.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  try {
    if (
      !req.query.code ||
      !req.query.state ||
      req.query.state !== req.session.oauthState
    ) {
      return res.status(400).send('登入驗證失敗，請返回首頁重新登入。');
    }

    delete req.session.oauthState;

    const redirect =
      process.env.DISCORD_REDIRECT_URI ||
      `${baseUrl(req)}/auth/discord/callback`;

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: redirect
      })
    });

    const token = await tokenRes.json();

    if (!tokenRes.ok) {
      throw new Error(token.error_description || 'Discord token error');
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${token.access_token}`
      }
    });

    const user = await userRes.json();

    if (!userRes.ok) {
      throw new Error('無法取得 Discord 使用者資料');
    }

    req.session.discordUser = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : null
    };

    res.redirect('/');
  } catch (error) {
    console.error('Discord 登入錯誤：', error);
    res.status(500).send('Discord 登入發生問題，請返回首頁再試一次。');
  }
});
/* Google Drive OAuth 授權 */

app.get('/auth/google', requireBackupAdmin, (req, res) => {
  try {
    const oauth2Client = googleOAuthClient(req);
    const state = crypto.randomBytes(24).toString('hex');

    req.session.googleOAuthState = state;

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
scope: [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
],
      state
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error('Google OAuth 錯誤：', error);
    res.status(500).send('無法開始 Google Drive 授權。');
  }
});

app.get('/auth/google/callback', requireBackupAdmin, async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send('Google 授權未完成：' + req.query.error);
    }

    if (
      !req.query.code ||
      !req.query.state ||
      req.query.state !== req.session.googleOAuthState
    ) {
      return res.status(400).send('Google 授權驗證失敗。');
    }

    delete req.session.googleOAuthState;

    const oauth2Client = googleOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(req.query.code);

    const oldToken = db.prepare(
      'SELECT refresh_token FROM google_drive_auth WHERE id = 1'
    ).get();

    const refreshToken = tokens.refresh_token || oldToken?.refresh_token;

    if (!refreshToken) {
      return res.status(400).send(
        '沒有取得 Google Refresh Token，請重新授權。'
      );
    }

    db.prepare(`
      INSERT INTO google_drive_auth (id, refresh_token, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        refresh_token = excluded.refresh_token,
        updated_at = CURRENT_TIMESTAMP
    `).run(refreshToken);

    res.redirect('/?googleBackup=connected');

  } catch (error) {
    console.error('Google OAuth callback 錯誤：', error);
    res.status(500).send('Google Drive 授權失敗，請查看 Render Logs。');
  }
});

/* Google Drive SQLite 備份 */

async function backupDatabase() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error('缺少 GOOGLE_DRIVE_FOLDER_ID');
  }

  const savedAuth = db.prepare(
    'SELECT refresh_token FROM google_drive_auth WHERE id = 1'
  ).get();

  if (!savedAuth?.refresh_token) {
    throw new Error('尚未完成 Google Drive 授權');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ||
      `${process.env.BASE_URL || 'https://tina-double11.onrender.com'}/auth/google/callback`
  );

  oauth2Client.setCredentials({
    refresh_token: savedAuth.refresh_token
  });

  const drive = google.drive({
    version: 'v3',
    auth: oauth2Client
  });

  const backupPath = path.join(
    os.tmpdir(),
    `tina-double11-${Date.now()}.sqlite`
  );

  try {
    await db.backup(backupPath);

    const result = await drive.files.create({
      requestBody: {
        name: `TINA-SHOP-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
        parents: [folderId]
      },
      media: {
        mimeType: 'application/x-sqlite3',
        body: fs.createReadStream(backupPath)
      },
      fields: 'id,name'
    });

    console.log('Google Drive 備份成功：', result.data.name);

    return result.data;

  } finally {
    await fs.promises.rm(backupPath, { force: true }).catch(() => {});
  }
}

/* ---------------- Google Sheets 自動同步 ---------------- */

async function getGoogleSheetsClient() {
  const savedAuth = db.prepare(
    'SELECT refresh_token FROM google_drive_auth WHERE id = 1'
  ).get();

  if (!savedAuth?.refresh_token) {
    throw new Error('尚未完成 Google 授權');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ||
      `${process.env.BASE_URL || 'https://tina-double11.onrender.com'}/auth/google/callback`
  );

  oauth2Client.setCredentials({
    refresh_token: savedAuth.refresh_token
  });

    const sheets = google.sheets({
    version: 'v4',
    auth: oauth2Client
  });

  return { sheets, oauth2Client };

async function getOrCreateGoogleSpreadsheet() {
const { sheets, oauth2Client } = await getGoogleSheetsClient();

  const saved = db.prepare(
    'SELECT spreadsheet_id FROM google_sheets_config WHERE id = 1'
  ).get();

  if (saved?.spreadsheet_id) {
    return {
      sheets,
      spreadsheetId: saved.spreadsheet_id
    };
  }

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: 'TINA SHOP 抽獎紀錄'
      },
      sheets: [
        { properties: { title: '抽獎明細' } },
        { properties: { title: '獎項統計' } }
      ]
    }
  });

  const spreadsheetId = created.data.spreadsheetId;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error('缺少 GOOGLE_DRIVE_FOLDER_ID');
  }

const drive = google.drive({
  version: 'v3',
  auth: oauth2Client
});
  const file = await drive.files.get({
    fileId: spreadsheetId,
    fields: 'parents'
  });

  await drive.files.update({
    fileId: spreadsheetId,
    addParents: folderId,
    removeParents: (file.data.parents || []).join(','),
    fields: 'id,parents'
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: '抽獎明細!A1:D1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Discord 名稱',
        'Discord ID',
        '中獎獎項',
        '抽獎時間'
      ]]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: '獎項統計!A1:C1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        '獎項名稱',
        '中獎數量',
        '剩餘數量'
      ]]
    }
  });

  db.prepare(`
    INSERT INTO google_sheets_config
      (id, spreadsheet_id, updated_at)
    VALUES (1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      spreadsheet_id = excluded.spreadsheet_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(spreadsheetId);

  console.log('Google 試算表建立成功：', spreadsheetId);

  return {
    sheets,
    spreadsheetId
  };
}

/* ---------------- TINA SHOP Google Sheets 資料同步 ---------------- */

async function syncGoogleSheets() {
  const { sheets, spreadsheetId } =
    await getOrCreateGoogleSpreadsheet();

  // 讀取所有會員的抽獎紀錄
  const draws = db.prepare(`
    SELECT discord_id, username, prize_name, created_at
    FROM draws
    ORDER BY created_at ASC
  `).all();

  // 轉換成台灣時間
  const drawRows = draws.map(row => {
    const utcDate = new Date(
      row.created_at.replace(' ', 'T') + 'Z'
    );

    const taiwanTime = utcDate.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour12: false
    });

    return [
      row.username,
      row.discord_id,
      row.prize_name,
      taiwanTime
    ];
  });

  // 更新抽獎明細
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: '抽獎明細!A2:D'
  });

  if (drawRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: '抽獎明細!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: drawRows
      }
    });
  }

  // 讀取獎項庫存
  const inventory = db.prepare(`
    SELECT prize_id, remaining
    FROM inventory
  `).all();

  // 計算各獎項中獎數量
  const counts = db.prepare(`
    SELECT prize_id, COUNT(*) AS total
    FROM draws
    GROUP BY prize_id
  `).all();

  const countMap = {};
  counts.forEach(row => {
    countMap[row.prize_id] = row.total;
  });

  // 整理獎項統計
  const statsRows = inventory.map(item => {
    const prizeName = PRIZES[item.prize_id]?.name || item.prize_id;

    return [
      prizeName,
      countMap[item.prize_id] || 0,
      item.remaining < 0 ? '不限量' : item.remaining
    ];
  });

  // 更新獎項統計
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: '獎項統計!A2:C'
  });

  if (statsRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: '獎項統計!A2',
      valueInputOption: 'RAW',
      requestBody: {
        values: statsRows
      }
    });
  }

  console.log(
    `Google Sheets 同步成功：${drawRows.length} 筆抽獎紀錄`
  );

  return spreadsheetId;
}

/* 網站 API */

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  const user = req.session.discordUser;

  if (!user) {
    return res.json({ loggedIn: false });
  }

  const draw = db.prepare(
    'SELECT prize_id, prize_name, created_at FROM draws WHERE discord_id = ?'
  ).get(user.id);

  res.json({
    loggedIn: true,
    user,
    draw: draw || null
  });
});

app.get('/api/inventory', (req, res) => {
  const rows = db.prepare(
    'SELECT prize_id, remaining FROM inventory'
  ).all();

  res.json(rows.map(row => ({
    id: row.prize_id,
    remaining: row.remaining < 0 ? null : row.remaining
  })));
});

/* 抽獎交易 */

const drawTransaction = db.transaction(user => {
  const existing = db.prepare(
    'SELECT prize_id, prize_name FROM draws WHERE discord_id = ?'
  ).get(user.id);

  if (existing) {
    return {
      already: true,
      prize: existing
    };
  }

  const available = db.prepare(
    'SELECT prize_id, remaining, weight FROM inventory WHERE remaining != 0'
  ).all();

  if (!available.length) {
    throw new Error('目前獎項已全部抽完。');
  }

  const total = available.reduce(
    (sum, item) => sum + item.weight,
    0
  );

  let pick = Math.random() * total;
  let selected = available[available.length - 1];

  for (const item of available) {
    pick -= item.weight;

    if (pick < 0) {
      selected = item;
      break;
    }
  }

  if (selected.remaining > 0) {
    const changed = db.prepare(
      'UPDATE inventory SET remaining = remaining - 1 WHERE prize_id = ? AND remaining > 0'
    ).run(selected.prize_id);

    if (!changed.changes) {
      throw new Error('名額剛好被抽完，請再試一次。');
    }
  }

  const name = PRIZES[selected.prize_id].name;

  db.prepare(`
    INSERT INTO draws (
      discord_id,
      username,
      prize_id,
      prize_name
    )
    VALUES (?, ?, ?, ?)
  `).run(
    user.id,
    user.username,
    selected.prize_id,
    name
  );

  return {
    already: false,
    prize: {
      prize_id: selected.prize_id,
      prize_name: name,
      detail: PRIZES[selected.prize_id].detail
    }
  };
});
/* 抽獎 API */

/* 抽獎 API */

app.post('/api/scratch', async (req, res) => {
  if (!req.session.discordUser) {
    return res.status(401).json({
      error: '請先使用 Discord 登入。'
    });
  }

  // 活動截止時間：2026/11/21 23:23 台灣時間
  const EVENT_END = new Date('2026-11-21T23:23:00+08:00');

  if (Date.now() >= EVENT_END.getTime()) {
    return res.status(403).json({
      error: '活動已結束，感謝參與 TINA SHOP！'
    });
  }

  try {
    const result = drawTransaction(req.session.discordUser);

   
// 只有新抽獎成功才執行備份與同步
if (!result.already) {

  // 1. 備份 SQLite 到 Google Drive
  try {
    await backupDatabase();
    console.log('Google Drive SQLite 備份成功');
  } catch (backupError) {
    console.error('Google Drive 備份失敗：', backupError);
  }

  // 2. 同步抽獎明細與獎項統計
  try {
    await syncGoogleSheets();
    console.log('Google Sheets 同步成功');
  } catch (syncError) {
    console.error('Google Sheets 同步失敗：', syncError);
  }
}


    return res.json(result);

  } catch (error) {
    console.error('抽獎失敗：', error);

    return res.status(409).json({
      error: error.message || '抽獎失敗，請稍後再試。'
    });
  }
});
/* Google Drive 備份管理頁面 */

app.get('/admin/backup', requireBackupAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-Hant">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>TINA SHOP 備份管理</title>
      <style>
        body {
          font-family: sans-serif;
          background: #fff5f8;
          color: #553344;
          text-align: center;
          padding: 40px 20px;
        }
        button {
          background: #d978a0;
          color: white;
          border: 0;
          border-radius: 12px;
          padding: 14px 24px;
          font-size: 16px;
          cursor: pointer;
        }
        a { color: #a34c75; }
      </style>
    </head>
    <body>
      <h1>TINA SHOP 備份管理</h1>
      <p>將抽獎紀錄與獎項庫存備份至 Google Drive。</p>
      <form method="POST" action="/admin/backup/run">
        <button type="submit">立即備份</button>
      </form>
            <form method="POST" action="/admin/sheets/sync">
        <button type="submit">立即同步 Google 試算表</button>
      </form>
      <p><a href="/">返回網站首頁</a></p>
    </body>
    </html>
  `);
});

app.post('/admin/backup/run', requireBackupAdmin, async (req, res) => {
  try {
    const result = await backupDatabase();

    res.send(`
      <h2>備份成功！</h2>
      <p>${result.name}</p>
      <p><a href="/admin/backup">返回備份管理</a></p>
    `);
  } catch (error) {
    console.error('手動備份失敗：', error);
    res.status(500).send(
      '備份失敗，請查看 Render Logs：' + error.message
    );
  }
});
/* Google Sheets 手動同步 */

app.post('/admin/sheets/sync', requireBackupAdmin, async (req, res) => {
  try {
    const spreadsheetId = await syncGoogleSheets();

    const spreadsheetUrl =
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    res.send(`
      <!DOCTYPE html>
      <html lang="zh-Hant">
      <head>
        <meta charset="UTF-8">
        <title>TINA SHOP 同步結果</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2>Google 試算表同步成功！♡</h2>
        <p>抽獎明細與獎項統計已更新。</p>
        <p><a href="${spreadsheetUrl}" target="_blank">開啟 TINA SHOP 抽獎試算表</a></p>
        <p><a href="/admin/backup">返回備份管理</a></p>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Google Sheets 手動同步失敗：', error);
    res.status(500).send(
      '同步失敗，請查看 Render Logs：' + error.message
    );
  }
});
/* 管理員指定帳號抽獎重置 */

app.get('/admin/test-reset', requireBackupAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-Hant">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>TINA SHOP 測試帳號重置</title>
    </head>
    <body style="font-family:Arial;text-align:center;padding:40px;background:#fff5f8;">
      <h2>TINA SHOP 測試帳號重置</h2>
      <p>請輸入想清除的 Discord 使用者 ID。</p>
      <form method="POST" action="/admin/test-reset">
        <input
          type="text"
          name="targetDiscordId"
          placeholder="輸入 Discord 使用者 ID"
          required
          pattern="[0-9]{17,20}"
          style="padding:12px;width:280px;max-width:90%;"
        >
        <br><br>
        <button type="submit" style="padding:12px 24px;">
          清除指定帳號紀錄
        </button>
      </form>
      <p>只會清除指定帳號，不會影響其他會員。</p>
      <a href="/admin/backup">返回備份管理</a>
    </body>
    </html>
  `);
});

app.post('/admin/test-reset', requireBackupAdmin, (req, res) => {
  try {
    const targetId = String(req.body.targetDiscordId || '').trim();

    if (!/^[0-9]{17,20}$/.test(targetId)) {
      return res.status(400).send('Discord 使用者 ID 格式不正確。');
    }

    const reset = db.transaction(() => {
      const draw = db.prepare(
        'SELECT prize_id FROM draws WHERE discord_id = ?'
      ).get(targetId);

      if (!draw) {
        return false;
      }

      db.prepare(
        'DELETE FROM draws WHERE discord_id = ?'
      ).run(targetId);

      db.prepare(`
        UPDATE inventory
        SET remaining = remaining + 1
        WHERE prize_id = ? AND remaining >= 0
      `).run(draw.prize_id);

      return true;
    });

    const deleted = reset();

    res.send(deleted
      ? '<h2>指定帳號紀錄已清除！</h2><p>該帳號現在可以重新抽獎。</p><a href="/admin/test-reset">返回重置頁面</a>'
      : '<h2>找不到該帳號的抽獎紀錄。</h2><a href="/admin/test-reset">返回重置頁面</a>'
    );

  } catch (error) {
    console.error('指定帳號重置失敗：', error);
    res.status(500).send('重置失敗，請查看 Render Logs。');
  }
});

/* 每 24 小時自動備份一次 */

const BACKUP_INTERVAL = 24 * 60 * 60 * 1000;

setInterval(async () => {
  try {
    const savedAuth = db.prepare(
      'SELECT refresh_token FROM google_drive_auth WHERE id = 1'
    ).get();

    if (!savedAuth?.refresh_token) {
      console.log('尚未完成 Google Drive 授權，暫不執行自動備份。');
      return;
    }

    await backupDatabase();
    console.log('每日 Google Drive 自動備份完成。');

  } catch (error) {
    console.error('每日 Google Drive 自動備份失敗：', error);
  }
}, BACKUP_INTERVAL);


/* 啟動網站 */

app.listen(PORT, () => {
  console.log(`TINA SHOP 網站已啟動，Port: ${PORT}`);
});
