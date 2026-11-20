const people = ['媽媽', '爸爸', '大女兒', '小女兒'];
const owners = [...people, '全家共同'];
const kinds = ['支出', '收入', '家人轉帳', '帳戶移轉', '退款'];
const methods = ['現金', 'LINE Pay', '信用卡', '銀行轉帳', '其他'];
const categories = ['餐飲', '居家', '交通', '教育', '購物', '醫療', '娛樂', '保險', '薪資', '其他'];
const $ = selector => document.querySelector(selector);
const main = $('#main');
const notice = $('#notice');
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei'}).format(new Date());
const money = cents => new Intl.NumberFormat('zh-TW', {style:'currency',currency:'TWD',maximumFractionDigits:2}).format(cents / 100);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
})[char]);
const options = (values, selected) => values.map(value =>
  `<option ${value === selected ? 'selected' : ''}>${escape(value)}</option>`).join('');
const browserMode = document.documentElement.dataset.ledgerMode === 'browser';
let browserApi;
let user, shared, entries = [], month = today().slice(0, 7), preview, refreshId = 0;
let selectedCategory;
const previousMonth = month => {
  const [year, number] = month.split('-');
  return number === '01' ? `${String(Number(year) - 1).padStart(4, '0')}-12` :
    `${year}-${String(Number(number) - 1).padStart(2, '0')}`;
};

async function api(path, input) {
  if (browserMode) return browserApi(path, input);
  const response = await fetch('/api/' + path, input === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), {status:response.status});
  return result;
}

function message(text) {
  notice.textContent = text;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => notice.textContent = '', 6500);
}

function submit(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(button => button.disabled = true);
    try { await action(Object.fromEntries(new FormData(form))); }
    catch (error) { message(error.message); }
    finally { buttons.forEach(button => button.disabled = false); }
  });
}

function auth(setup) {
  $('#identity').textContent = '';
  $('#logout').hidden = true;
  main.innerHTML = setup ? `<section class="auth"><h2>首次設定</h2><form>
    <label>首次設定代碼<input name="code" required></label>
    <p class="muted">每人請設定不同的 4 至 8 位數字密碼。</p>
    ${people.map(person => `<label>${person}的密碼<input type="password" name="${person}" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="new-password" required></label>`).join('')}
    <button>建立四個帳號</button></form></section>` :
    `<section class="auth"><h2>登入帳本</h2><form>
    <label>家庭成員<select name="name">${options(people)}</select></label>
    <label>密碼<input type="password" name="password" autocomplete="current-password" required></label>
    <button>登入</button></form></section>`;
  submit($('form'), async fields => {
    if (setup) {
      const {code, ...passwords} = fields;
      await api('setup', {code, passwords});
      return auth(false);
    }
    user = (await api('login', fields)).user;
    dashboard();
    await refresh();
  });
}

function fields(row = {}) {
  return `<div class="grid">
    <label>日期<input type="date" name="date" value="${escape(row.date ?? today())}" required></label>
    <label>項目<input name="item" value="${escape(row.item)}" maxlength="150" required></label>
    <label>金額（新台幣）<input type="number" name="amount" value="${escape(row.amount)}" min="0.01" max="1000000000" step="0.01" inputmode="decimal" required></label>
    <label>收支類型<select name="kind">${options(kinds, row.kind)}</select></label>
    <label>分類<select name="category">${options(categories, row.category || '其他')}</select></label>
    <label>支付方式<select name="method">${options(methods, row.method)}</select></label>
    <label>付款帳戶或卡片暱稱<input name="account" value="${escape(row.account)}" maxlength="50"></label>
    ${shared ? `<label>登記者<select name="creator">${options(people, row.creator || user)}</select></label>` : ''}
    ${user === '媽媽' ? `<label>收支歸屬<select name="owner">${options(owners, row.owner || user)}</select></label>` : ''}
  </div>`;
}

async function save(values) {
  try { await api('entries', values); }
  catch (error) {
    if (error.status !== 409) throw error;
    if (!confirm(error.message + '。確定要另外新增或儲存這筆嗎？')) return false;
    await api('entries', {...values, confirmDuplicate:true});
  }
  return true;
}

function editor(row) {
  const form = $('#entry');
  $('#editorTitle').textContent = row ? '編輯收支' : '手動記帳';
  form.innerHTML = fields(row ? {...row, amount:row.cents / 100} : {}) +
    `<div class="actions"><button>${row ? '儲存修改' : '確認入帳'}</button>${row ? '<button type="button" id="cancel" class="secondary">取消</button>' : ''}</div>`;
  if (row) $('#cancel').onclick = () => editor();
  form.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      if (!await save({...values, id:row?.id})) return;
      month = values.date.slice(0, 7);
      $('#month').value = month;
      editor();
      await refresh();
      message('已儲存');
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  };
}

function dashboard() {
  $('#identity').textContent = browserMode ? '帳本僅儲存在目前的瀏覽器' : shared ? '共用帳本・免登入' : user + '的帳本';
  $('#logout').hidden = shared;
  main.innerHTML = `
    <div class="toolbar"><label>帳本月份<input id="month" type="month" value="${month}"></label>
    ${user === '媽媽' ? `<label>查看帳本<select id="owner">${options([...owners,'全家明細'], shared ? '全家明細' : user)}</select></label>` : ''}</div>
    ${user === '媽媽' ? '<section id="reportSection"><div id="report"></div><div class="actions"><button id="printReport" disabled>產出家庭損益表</button><button id="export" class="secondary" disabled>匯出本月 CSV</button></div></section>' : ''}
    <section><h2 id="editorTitle"></h2><form id="entry"></form></section>
    ${browserMode ? '' : `<section><h2>拍照辨識</h2><form id="photo">
      <div class="grid">
        <label>照片類型<select name="type">${options(people.slice(0,2).includes(user) ? ['信用卡帳單','手寫記帳'] : ['手寫記帳'])}</select></label>
        <label>拍照或選擇照片<input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label>
      </div>
      <button>辨識照片</button>
    </form><div id="review"></div></section>`}
    <section id="details"><div class="toolbar"><h2 id="detailsTitle">收支明細</h2>
    <button id="clearCategory" class="secondary" hidden>清除分類篩選</button></div><div id="entries" class="scroll"></div></section>`;
  selectedCategory = undefined;
  $('#clearCategory').onclick = () => {
    selectedCategory = undefined;
    renderEntries();
  };
  editor();
  if (user === '媽媽') {
    $('#export').onclick = exportMonth;
    $('#printReport').onclick = () => window.print();
  }
  $('#month').onchange = async event => {
    if (!event.target.value) { event.target.value = month; return; }
    month = event.target.value;
    selectedCategory = undefined;
    try { await refresh(); } catch (error) { message(error.message); }
  };
  if ($('#owner')) $('#owner').onchange = renderEntries;
  if (browserMode) return;
  submit($('#photo'), async ({type, image}) => {
    if (image.size > 6_500_000) throw new Error('請選擇小於 6.5 MB 的照片');
    const review = $('#review');
    if (review.querySelector('form') && !confirm('確定清除目前尚未確認的辨識結果嗎？')) return;
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('無法讀取圖片'));
      reader.readAsDataURL(image);
    });
    const rows = await api('ocr', {type, image:base64});
    if (!review.isConnected) return;
    if (preview) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(image);
    review.innerHTML = '<div class="review"><img alt="待核對的原始照片"><p class="muted"></p><div></div></div>';
    review.querySelector('img').src = preview;
    review.querySelector('p').textContent = rows.length ?
      '請對照照片逐筆核對。確認後才會入帳。' : '沒有辨識到交易，可用手動記帳補登。';
    for (const row of rows) {
      const form = document.createElement('form');
      form.innerHTML = (row.uncertain ? '<p class="alert">辨識內容有疑問，請核對原圖。</p>' : '') +
        fields({...row, date:row.date || '', method:type === '信用卡帳單' ? '信用卡' : '現金'}) +
        '<div class="actions"><button>確認這筆</button><button type="button" class="secondary">略過</button></div>';
      review.querySelector('.review > div').append(form);
      form.querySelector('[type=button]').onclick = () => form.remove();
      submit(form, async values => {
        if (!await save(values)) return;
        form.remove();
        await refresh();
        message('已入帳');
      });
    }
  });
}

function exportMonth() {
  const rows = [
    ['日期', '項目', '金額（新台幣）', '收支類型', '分類', '支付方式', '帳戶或卡片暱稱', '登記者', '歸屬'],
    ...entries.map(row => [row.date, row.item, row.cents / 100, row.kind, row.category,
      row.method, row.account, row.creator, row.owner])
  ];
  const csv = rows.map(row => row.map(value => {
    if (typeof value === 'number') return String(value);
    const text = String(value ?? '');
    const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], {type:'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `家庭記帳-${month}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refresh() {
  const id = ++refreshId;
  const exportButton = $('#export');
  const printButton = $('#printReport');
  if (exportButton) exportButton.disabled = true;
  if (printButton) printButton.disabled = true;
  const [rows, previous] = await Promise.all([
    api('entries?month=' + encodeURIComponent(month)),
    user === '媽媽' ? api('entries?month=' + encodeURIComponent(previousMonth(month))) : []
  ]);
  if (id !== refreshId || !user) return;
  entries = rows;
  if (exportButton) exportButton.disabled = !rows.length;
  renderEntries();
  if (user === '媽媽') {
    renderReport(previous);
    printButton.disabled = false;
  }
}

function renderEntries() {
  const view = $('#owner')?.value;
  const rows = entries.filter(row => {
    if (selectedCategory) return row.category === selectedCategory && ['支出', '退款'].includes(row.kind);
    return !view || view === '全家明細' || row.owner === view || (!shared && row.creator === view);
  });
  $('#detailsTitle').textContent = selectedCategory ? selectedCategory + '支出明細' : '收支明細';
  $('#clearCategory').hidden = !selectedCategory;
  const container = $('#entries');
  container.innerHTML = rows.length ? `<table><thead><tr>
    <th>日期</th><th>項目</th><th>類型／分類</th><th>支付方式</th><th>登記者</th><th>歸屬</th><th class="amount">金額</th><th>操作</th>
  </tr></thead><tbody>${rows.map(row => `<tr>
    <td>${escape(row.date)}</td><td>${escape(row.item)}${row.creator !== row.owner && row.kind === '支出' && row.owner !== '全家共同' ? `（${escape(row.creator)}代付）` : ''}</td>
    <td>${escape(row.kind)}／${escape(row.category)}</td><td>${escape(row.method)} ${escape(row.account)}</td>
    <td>${escape(row.creator)}</td><td>${escape(row.owner)}</td><td class="amount">${money(row.cents)}</td>
    <td>${row.editable ? `<button class="secondary" data-edit="${row.id}">編輯</button> <button class="secondary" data-delete="${row.id}">刪除</button>` : ''}</td>
  </tr>`).join('')}</tbody></table>` : '<p class="muted">這個月還沒有收支紀錄。</p>';
  for (const button of container.querySelectorAll('[data-edit]')) button.onclick = () => {
    editor(entries.find(row => row.id === Number(button.dataset.edit)));
    $('#editorTitle').scrollIntoView({block:'center'});
  };
  for (const button of container.querySelectorAll('[data-delete]')) button.onclick = async () => {
    if (!confirm('確定刪除這筆紀錄嗎？')) return;
    try { await api('delete', {id:Number(button.dataset.delete)}); await refresh(); }
    catch (error) { message(error.message); }
  };
}

function renderReport(previous) {
  const income = entries.reduce((sum, row) => sum + (row.kind === '收入' ? row.cents : 0), 0);
  const spending = new Map(owners.map(owner => [owner, 0]));
  const byCategory = new Map();
  let expense = 0;
  for (const row of entries) {
    if (!['支出','退款'].includes(row.kind)) continue;
    const cost = row.kind === '退款' ? -row.cents : row.cents;
    expense += cost;
    spending.set(row.owner, spending.get(row.owner) + cost);
    byCategory.set(row.category, (byCategory.get(row.category) || 0) + cost);
  }
  const percent = new Intl.NumberFormat('zh-TW', {style:'percent', maximumFractionDigits:1});
  const priorCategory = new Map();
  for (const row of previous) {
    if (!['支出','退款'].includes(row.kind)) continue;
    const cost = row.kind === '退款' ? -row.cents : row.cents;
    priorCategory.set(row.category, (priorCategory.get(row.category) || 0) + cost);
    if (!byCategory.has(row.category)) byCategory.set(row.category, 0);
  }
  const memberIcons = {'媽媽':'👩🏻', '爸爸':'👨🏻', '大女兒':'👧🏻', '小女兒':'🎀', '全家共同':'🏡'};
  const table = (label, values, showShare = false) => `<table><thead><tr>
    <th>${label}</th><th class="amount">支出淨額</th>${showShare ? `<th class="amount">占比</th><th class="amount">上月（${previousMonth(month)}）</th><th class="amount">較上月增減</th>` : ''}
    </tr></thead><tbody>${[...values].map(([key,value]) => {
      const prior = priorCategory.get(key) || 0;
      const difference = value - prior;
      const name = showShare ? `<button class="category-link" type="button" data-category="${escape(key)}">${escape(key)}</button>` :
        `<span class="member-icon" aria-hidden="true">${memberIcons[key]}</span>${escape(key)}`;
      return `<tr><td>${name}</td><td class="amount">${money(value)}</td>
        ${showShare ? `<td class="amount">${expense > 0 ? percent.format(value / expense) : '—'}</td>
        <td class="amount">${money(prior)}</td><td class="amount">${difference > 0 ? '+' : ''}${money(difference)}</td>` : ''}</tr>`;
    }).join('')}</tbody></table>`;
  $('#report').innerHTML = `<h2>${month} 家庭損益表</h2><div class="metrics">
    <div>全家收入<strong>${money(income)}</strong></div><div>支出淨額<strong>${money(expense)}</strong></div>
    <div>當月結餘<strong>${money(income-expense)}</strong></div></div>
    <h3>每人及共同支出</h3>${table('歸屬', spending)}
    <h3>分類支出</h3>${byCategory.size ? `<div class="scroll">${table('分類', [...byCategory].sort((a,b) => b[1]-a[1]), true)}</div>` : '<p class="muted">這兩個月還沒有支出。</p>'}`;
  for (const button of $('#report').querySelectorAll('[data-category]')) button.onclick = () => {
    selectedCategory = button.dataset.category;
    if ($('#owner')) $('#owner').value = '全家明細';
    renderEntries();
    $('#details').scrollIntoView({block:'start'});
  };
}

$('#logout').onclick = async () => {
  try {
    await api('logout', {});
    user = null;
    entries = [];
    if (preview) URL.revokeObjectURL(preview);
    preview = undefined;
    auth(false);
  } catch (error) { message(error.message); }
};

async function start() {
  if (browserMode) {
    const { createBrowserApi } = await import('./browser-ledger.js');
    browserApi = createBrowserApi({people, owners, kinds, methods});
  }
  const status = await api('status');
  shared = status.shared;
  user = status.user;
  if (user) { dashboard(); await refresh(); }
  else auth(status.setup);
}

start().catch(error => {
  main.innerHTML = '<section role="alert"><h2>無法載入帳本</h2><p class="alert"></p><button type="button">重新載入</button></section>';
  main.querySelector('p').textContent = error.message;
  main.querySelector('button').onclick = () => location.reload();
});
