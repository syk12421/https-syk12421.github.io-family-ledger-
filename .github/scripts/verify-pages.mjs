import { setTimeout as delay } from 'node:timers/promises';

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(message);
}

const [debugPort, pageUrl] = process.argv.slice(2);
let tab;
await waitFor(async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    tab = (await response.json()).find(target => target.type === 'page');
    return tab;
  } catch {
    return false;
  }
}, 'Chrome did not start');

const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let requestId = 0;
function send(method, params) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    function listener(event) {
      const response = JSON.parse(event.data);
      if (response.id !== id) return;
      socket.removeEventListener('message', listener);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    }
    socket.addEventListener('message', listener);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  const navigation = await send('Page.navigate', { url: pageUrl });
  if (navigation.errorText) throw new Error(navigation.errorText);

  const expression = `document.querySelector('#entry button')?.textContent === '確認入帳'`;
  await waitFor(async () => {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: true });
    return result.value === true;
  }, 'The public page did not render the ledger form');

  console.log(`Chrome rendered the ledger form at ${pageUrl}`);
} finally {
  socket.close();
}
