import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectSheets } from './google-sheets.mjs';

const members = ['媽媽', '爸爸', '大女兒', '小女兒'];
const owners = [...members, '全家共同'];
const kinds = ['支出', '收入', '家人轉帳', '帳戶移轉', '退款'];
const methods = ['現金', 'LINE Pay', '信用卡', '銀行轉帳', '其他'];
const data = process.env.LEDGER_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
mkdirSync(data, { recursive: true });
const db = new DatabaseSync(join(data, 'ledger.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY, salt TEXT, hash TEXT);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, name TEXT, expires INTEGER);
  CREATE TABLE IF NOT EXISTS entries(
    id INTEGER PRIMARY KEY, creator TEXT NOT NULL, owner TEXT NOT NULL,
    date TEXT NOT NULL, item TEXT NOT NULL, cents INTEGER NOT NULL,
    kind TEXT NOT NULL, category TEXT NOT NULL, method TEXT NOT NULL, account TEXT NOT NULL
  );
`);
const random = () => randomBytes(32).toString('hex');
const sheets = connectSheets({
  spreadsheetId: process.env.LEDGER_SHEET_ID,
  tabId: process.env.LEDGER_SHEET_GID,
  credentialsPath: process.env.LEDGER_GOOGLE_CREDENTIALS,
  loadEntries: () => db.prepare('SELECT * FROM entries ORDER BY id').all()
});
const setup = random();
const configured = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
const digest = (password, salt) => scryptSync(password, salt, 64);
const port = Number(process.env.PORT || 8787);
const host = process.env.LEDGER_HOST || '127.0.0.1';
const shared = process.env.LEDGER_SHARED === '1';
if (shared && !['127.0.0.1', '::1'].includes(host)) {
  throw new Error('免登入共用模式請在本機執行');
}
const model = process.env.LEDGER_OCR_MODEL;
const assets = Object.fromEntries(['index.html', 'app.js', 'style.css'].map(name =>
  [name, readFileSync(new URL(name, import.meta.url))]));
const fail = (status, message) => Object.assign(new Error(message), { status });

async function body(req, limit = 32_768) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, '資料太大，請縮小圖片後再試');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { throw fail(400, '資料格式錯誤'); }
}

function entry(row, user) {
  const owner = user === members[0] ? row.owner : user;
  const cents = Math.round(Number(row.amount) * 100);
  const date = String(row.date || '');
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!validDate || !Number.isSafeInteger(cents) || cents <= 0 || cents > 100_000_000_000 ||
      !owners.includes(owner) || !kinds.includes(row.kind) || !methods.includes(row.method) ||
      typeof row.item !== 'string' || !row.item.trim()) throw fail(400, '請檢查日期、項目、金額和收支類型');
  const creator = shared && members.includes(row.creator) ? row.creator : user;
  return [creator, owner, date, row.item.trim().slice(0, 150), cents, row.kind,
    String(row.category || '其他').slice(0, 50), row.method, String(row.account || '').slice(0, 50)];
}

async function recognize(input, user) {
  if (!model) throw fail(503, '請先在伺服器設定 LEDGER_OCR_MODEL');
  if (input.type === '信用卡帳單' && !members.slice(0, 2).includes(user)) throw fail(403, '請選手寫記帳');
  if (!['信用卡帳單', '手寫記帳'].includes(input.type) ||
      typeof input.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw fail(400, '圖片格式錯誤');
  const schema = { type: 'object', required: ['rows'], properties: { rows: {
    type: 'array', items: { type: 'object', required: ['date','item','amount','kind','uncertain'],
      properties: { date: {type:'string'}, item: {type:'string'}, amount: {type:'number'},
        kind: {enum:kinds}, uncertain: {type:'boolean'} } }
  } } };
  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(240_000),
      body: JSON.stringify({ model, images: [input.image], stream: false, format: schema,
        prompt: `辨識這張${input.type}的逐筆新台幣交易。只抄圖上資料。忽略合計、前期餘額與應繳總額。只在日期完整可讀時轉成 YYYY-MM-DD，否則留空。退款用正金額與退款類型，繳卡費用帳戶移轉。項目不清留空，金額不清填 0。任何疑問設 uncertain 為 true。` })
    });
    if (!response.ok) throw new Error('Ollama error');
    const result = JSON.parse((await response.json()).response);
    if (!Array.isArray(result.rows)) throw new Error('Invalid rows');
    return result.rows.slice(0, 150);
  } catch { throw fail(502, '辨識失敗，請確認 Ollama 正在執行且已下載支援圖片的模型'); }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
      const name = path === '/' ? 'index.html' : path.slice(1);
      res.writeHead(200, { 'Content-Type': ({'index.html':'text/html','app.js':'text/javascript','style.css':'text/css'})[name] + '; charset=utf-8' });
      return res.end(assets[name]);
    }
    if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      throw fail(415, '請送出 JSON');
    }
    const token = /(?:^|;\s*)ledger=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const user = shared ? members[0] : token && db.prepare('SELECT name FROM sessions WHERE token=? AND expires>?').get(token, Date.now())?.name;
    if (req.method === 'GET' && path === '/api/status') return send({ user: user || null, setup: !shared && !configured(), shared });
    if (req.method === 'POST' && path === '/api/setup') {
      const input = await body(req);
      if (configured()) throw fail(409, '已完成首次設定，請重新整理後登入');
      if (typeof input.code !== 'string' || input.code.replace(/\s/g, '').toLowerCase() !== setup) {
        throw fail(403, '首次設定代碼不符，請貼上服務啟動時顯示的完整代碼');
      }
      const passwords = members.map(name => input.passwords?.[name]);
      if (passwords.some(p => typeof p !== 'string' || !/^[0-9]{4,8}$/.test(p)) ||
          new Set(passwords).size !== members.length) throw fail(400, '每人須設定不同的 4 至 8 位數字密碼');
      db.exec('BEGIN');
      try {
        const add = db.prepare('INSERT INTO users VALUES (?, ?, ?)');
        members.forEach((name, i) => {
          const salt = random();
          add.run(name, salt, digest(passwords[i], salt).toString('hex'));
        });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return send({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/login') {
      const input = await body(req);
      const account = members.includes(input.name) && db.prepare('SELECT * FROM users WHERE name=?').get(input.name);
      if (!account || typeof input.password !== 'string' || input.password.length > 128 ||
          !timingSafeEqual(digest(input.password, account.salt), Buffer.from(account.hash, 'hex'))) throw fail(401, '帳號或密碼錯誤');
      const session = random();
      db.prepare('DELETE FROM sessions WHERE expires<=? OR token=?').run(Date.now(), token || '');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session, account.name, Date.now() + 43_200_000);
      res.setHeader('Set-Cookie', `ledger=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${process.env.LEDGER_SECURE_COOKIE === '1' ? '; Secure' : ''}`);
      return send({ user: account.name });
    }
    if (!user) throw fail(401, '請先登入');
    if (req.method === 'GET' && path === '/api/sheets') {
      if (user !== members[0]) throw fail(403, '只有媽媽可以查看同步狀態');
      return send(sheets.status);
    }
    if (req.method === 'POST' && path === '/api/logout') {
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      res.setHeader('Set-Cookie', 'ledger=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return send({ ok: true });
    }
    if (req.method === 'GET' && path === '/api/entries') {
      const month = url.searchParams.get('month');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw fail(400, '請選擇月份');
      const all = user === members[0];
      const rows = db.prepare(`SELECT * FROM entries WHERE substr(date,1,7)=? ${all ? '' : 'AND (owner=? OR creator=?)'} ORDER BY date DESC,id DESC`)
        .all(...(all ? [month] : [month, user, user]));
      return send(rows.map(row => ({
        ...row, account: all || row.creator === user ? row.account : '', editable: shared || row.creator === user
      })));
    }
    if (req.method === 'POST' && path === '/api/entries') {
      const input = await body(req);
      const values = entry(input, user);
      const [creator, owner, date, item, cents, kind] = values;
      const editing = Number.isSafeInteger(input.id) ? input.id : 0;
      if (editing && !db.prepare('SELECT 1 FROM entries WHERE id=? AND (creator=? OR ?)').get(editing, user, Number(shared))) throw fail(404, '找不到這筆紀錄');
      const duplicate = db.prepare(`SELECT 1 FROM entries WHERE date=? AND cents=? AND kind=? AND id<>?
        AND (owner=? OR creator=?) AND (lower(item)=lower(?) OR creator=?) LIMIT 1`)
        .get(date, cents, kind, editing, owner, creator, item, creator);
      if (duplicate && input.confirmDuplicate !== true) throw fail(409, '同日有相同金額的紀錄，請核對是否已入帳');
      if (editing) db.prepare('UPDATE entries SET creator=?,owner=?,date=?,item=?,cents=?,kind=?,category=?,method=?,account=? WHERE id=?').run(...values, editing);
      else db.prepare('INSERT INTO entries(creator,owner,date,item,cents,kind,category,method,account) VALUES (?,?,?,?,?,?,?,?,?)').run(...values);
      sheets.queue();
      return send({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/delete') {
      const input = await body(req);
      if (!Number.isSafeInteger(input.id) || !db.prepare('DELETE FROM entries WHERE id=? AND (creator=? OR ?)').run(input.id, user, Number(shared)).changes) throw fail(404, '找不到這筆紀錄');
      sheets.queue();
      return send({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/ocr') return send(await recognize(await body(req, 9_000_000), user));
    throw fail(404, '找不到頁面');
  } catch (error) {
    if (!error.status) console.error(error);
    send({ error: error.status ? error.message : '伺服器發生錯誤' }, error.status || 500);
  }
});

server.listen(port, host, () => {
  console.log(`家庭記帳手冊 http://${host}:${port}`);
  if (shared) console.log('免登入共用模式');
  else if (!configured()) console.log(`首次設定代碼 ${setup}`);
});
