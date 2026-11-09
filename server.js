require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (process.env.RENDER ? '/data' : path.join(__dirname, 'data'));
const fs = require('fs');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'tina-double11.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS inventory (prize_id TEXT PRIMARY KEY, remaining INTEGER, weight INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS draws (discord_id TEXT PRIMARY KEY, username TEXT NOT NULL, prize_id TEXT NOT NULL, prize_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
const initial = [
  ['grand', 2, 20],
  ['discount111', 5, 20],
  ['half', 10, 20],
  ['gift', -1, 40]
];
const insert = db.prepare('INSERT OR IGNORE INTO inventory (prize_id, remaining, weight) VALUES (?, ?, ?)');
initial.forEach(x => insert.run(...x));
const PRIZES = {
  grand: { name: '雙11幸運大獎', detail: '恭喜獲得踢吶雙11限定大獎！' },
  discount111: { name: '111 WC 折扣', detail: '可選擇一項商品，享 111 WC 優惠' },
  half: { name: '半價優惠', detail: '可選擇一項商品，享半價優惠' },
  gift: { name: '限定小禮物', detail: '可用 11 WC 帶走限定小禮物' }
};

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'please-change-this-session-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function baseUrl(req) { return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); }
app.get('/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return res.status(503).send('尚未設定 Discord OAuth，請先依 README 設定環境變數。');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const redirect = process.env.DISCORD_REDIRECT_URI || `${baseUrl(req)}/auth/discord/callback`;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: 'identify', state }).toString();
  res.redirect(url.toString());
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('登入驗證失敗，請返回首頁重新登入。');
    delete req.session.oauthState;
    const redirect = process.env.DISCORD_REDIRECT_URI || `${baseUrl(req)}/auth/discord/callback`;
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirect })
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(token.error_description || 'Discord token error');
    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const user = await userRes.json();
    if (!userRes.ok) throw new Error('無法取得 Discord 使用者資料');
    req.session.discordUser = { id: user.id, username: user.global_name || user.username, avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null };
    res.redirect('/');
  } catch (e) { console.error(e); res.status(500).send('Discord 登入發生問題，請返回首頁再試一次。'); }
});
app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => {
  const user = req.session.discordUser;
  if (!user) return res.json({ loggedIn: false });
  const draw = db.prepare('SELECT prize_id, prize_name, created_at FROM draws WHERE discord_id = ?').get(user.id);
  res.json({ loggedIn: true, user, draw: draw || null });
});
app.get('/api/inventory', (req, res) => {
  const rows = db.prepare('SELECT prize_id, remaining FROM inventory').all();
  res.json(rows.map(r => ({ id: r.prize_id, remaining: r.remaining < 0 ? null : r.remaining })));
});
const drawTransaction = db.transaction((user) => {
  const existing = db.prepare('SELECT prize_id, prize_name FROM draws WHERE discord_id = ?').get(user.id);
  if (existing) return { already: true, prize: existing };
  const available = db.prepare('SELECT prize_id, remaining, weight FROM inventory WHERE remaining != 0').all();
  const total = available.reduce((sum, x) => sum + x.weight, 0);
  let pick = Math.random() * total;
  let selected = available[available.length - 1];
  for (const item of available) { pick -= item.weight; if (pick < 0) { selected = item; break; } }
  if (selected.remaining > 0) {
    const changed = db.prepare('UPDATE inventory SET remaining = remaining - 1 WHERE prize_id = ? AND remaining > 0').run(selected.prize_id);
    if (!changed.changes) throw new Error('名額剛好被抽完，請再試一次');
  }
  const name = PRIZES[selected.prize_id].name;
  db.prepare('INSERT INTO draws (discord_id, username, prize_id, prize_name) VALUES (?, ?, ?, ?)').run(user.id, user.username, selected.prize_id, name);
  return { already: false, prize: { prize_id: selected.prize_id, prize_name: name, detail: PRIZES[selected.prize_id].detail } };
});
app.post('/api/scratch', (req, res) => {
  if (!req.session.discordUser) return res.status(401).json({ error: '請先使用 Discord 登入。' });
  try { const result = drawTransaction(req.session.discordUser); res.json(result); }
  catch (e) { res.status(409).json({ error: e.message || '抽獎失敗，請稍後再試。' }); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Tina Double11 listening on ${PORT}`));
