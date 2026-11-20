export function createBrowserApi({people, owners, kinds, methods}) {
  const storageKey = 'family-ledger:v1:' + new URL('.', import.meta.url).pathname;
  const read = () => {
    let value;
    try {
      value = localStorage.getItem(storageKey);
    } catch {
      throw new Error('目前的瀏覽器無法存取帳本資料。請在 Safari、Chrome 或 Firefox 的一般分頁開啟。');
    }
    try {
      return JSON.parse(value ?? '[]');
    } catch {
      throw new Error('無法讀取這個瀏覽器已儲存的帳本。');
    }
  };
  const fail = (status, message) => Object.assign(new Error(message), {status});

  return async function browserApi(path, input) {
    if (path === 'status') {
      read();
      return {user: people[0], setup: false, shared: true};
    }

    const [action, query] = path.split('?');
    if (action === 'entries' && input === undefined) {
      const month = new URLSearchParams(query).get('month');
      return read().filter(row => row.date.slice(0, 7) === month)
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    }

    if (action !== 'entries' && action !== 'delete') throw fail(404, '找不到這項功能');
    return navigator.locks.request(storageKey, () => {
      const rows = read();
      const index = rows.findIndex(row => row.id === input.id);
      if (action === 'delete') {
        if (index < 0) throw fail(404, '找不到這筆紀錄');
        rows.splice(index, 1);
      } else {
        if (input.id !== undefined && index < 0) throw fail(404, '找不到這筆紀錄');
        const {date, owner, kind, method} = input;
        const item = String(input.item ?? '').trim().slice(0, 150);
        const cents = Math.round(Number(input.amount) * 100);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
            new Date(date).toISOString().slice(0, 10) !== date || !item ||
            !Number.isSafeInteger(cents) || cents < 1 || cents > 100_000_000_000 ||
            !owners.includes(owner) || !kinds.includes(kind) || !methods.includes(method)) {
          throw fail(400, '請檢查日期、項目、金額和收支類型');
        }
        const creator = people.includes(input.creator) ? input.creator : people[0];
        const duplicate = rows.some(row => row.id !== input.id && row.date === date &&
          row.cents === cents && row.kind === kind && (row.owner === owner || row.creator === creator) &&
          (row.item.toLowerCase() === item.toLowerCase() || row.creator === creator));
        if (duplicate && input.confirmDuplicate !== true) throw fail(409, '同日有相同金額的紀錄，請核對是否已入帳');

        const id = input.id ?? rows.reduce((max, row) => Math.max(max, row.id), Date.now() - 1) + 1;
        const row = {id, date, owner, kind, method, item, cents, creator, editable: true,
          category: String(input.category || '其他').slice(0, 50),
          account: String(input.account || '').slice(0, 50)};
        if (index < 0) rows.push(row);
        else rows[index] = row;
      }
      localStorage.setItem(storageKey, JSON.stringify(rows));
      return {ok: true};
    });
  };
}
