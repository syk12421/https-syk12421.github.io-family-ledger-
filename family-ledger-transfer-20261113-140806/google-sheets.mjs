import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/spreadsheets';
const headers = ['紀錄編號', '登記者', '歸屬', '日期', '項目', '金額（新台幣）', '收支類型', '分類', '支付方式', '帳戶或卡片暱稱'];
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function connectSheets({ spreadsheetId, tabId, credentialsPath, loadEntries }) {
  const status = { state: spreadsheetId || credentialsPath || tabId ? 'pending' : 'disabled' };
  if (status.state === 'disabled') return { status, queue() {} };
  let credentials;
  let accessToken;
  let expires = 0;
  let revision = 0;
  let synced = -1;
  let timer;
  let running = false;

  async function token() {
    if (Date.now() < expires) return accessToken;
    credentials ||= JSON.parse(readFileSync(credentialsPath, 'utf8').replace(/^\uFEFF/, ''));
    const now = Math.floor(Date.now() / 1000);
    const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' +
      encode({ iss: credentials.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 });
    const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key, 'base64url');
    const response = await fetch(tokenUrl, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: unsigned + '.' + signature
      })
    });
    if (!response.ok) throw new Error('Google 授權 HTTP ' + response.status);
    const result = await response.json();
    accessToken = result.access_token;
    expires = Date.now() + (result.expires_in - 60) * 1000;
    return accessToken;
  }

  async function sync() {
    timer = undefined;
    running = true;
    let retry = 600;
    try {
      if (!/^[\w-]+$/.test(spreadsheetId || '') || !/^\d+$/.test(tabId || '') || !credentialsPath) {
        throw new Error('請設定試算表 ID、專用分頁 gid 與服務帳戶 JSON 路徑');
      }
      const auth = await token();
      const targetRevision = revision;
      const rows = [headers, ...loadEntries().map(row => [
        row.id, row.creator, row.owner, row.date, row.item, row.cents / 100,
        row.kind, row.category, row.method, row.account
      ])].map(row => ({ values: row.map(value => ({
        userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value }
      })) }));
      const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate';
      const response = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(25_000),
        headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ updateCells: {
          range: { sheetId: Number(tabId), startRowIndex: 0, startColumnIndex: 0, endColumnIndex: headers.length },
          rows, fields: 'userEnteredValue'
        } }] })
      });
      if (response.status === 401) expires = 0;
      if (!response.ok) throw new Error('Google 試算表寫入 HTTP ' + response.status);
      synced = targetRevision;
      status.state = synced === revision ? 'synced' : 'pending';
      status.updatedAt = new Date().toISOString();
      delete status.error;
    } catch (error) {
      retry = 60_000;
      status.state = 'error';
      status.error = error.message.startsWith('Google') || error.message.startsWith('請設定') ?
        error.message : '無法讀取憑證或連線至 Google';
    } finally {
      running = false;
      if (synced !== revision) schedule(retry);
    }
  }

  function schedule(delay) {
    if (!timer && !running) timer = setTimeout(sync, delay);
  }

  schedule(0);
  return { status, queue() {
    revision++;
    if (status.state !== 'error') status.state = 'pending';
    schedule(600);
  } };
}
