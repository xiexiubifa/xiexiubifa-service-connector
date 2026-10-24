// A tiny Chrome DevTools Protocol driver for the browser test: launches a headless Chrome/Chromium with a fresh,
// temporary profile (never a real one), opens one page and lets the test navigate, read and click.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The driver needs the global WebSocket client (Node 22+); on older Node the browser test is skipped.
export function findBrowser() {
  if (typeof WebSocket === 'undefined') return null;
  const candidates = [process.env.XXB_TEST_BROWSER, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

export async function launch(executable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xxb-browser-'));
  const child = spawn(executable, ['--headless', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=420,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('browser did not start: ' + buffer.slice(-500))), 20000);
    child.stderr.on('data', (d) => { buffer += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('browser exited ' + code + ': ' + buffer.slice(-500))); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');
  const evaluate = async (expression) => {
    const out = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error('page error: ' + JSON.stringify(out.exceptionDetails).slice(0, 300));
    return out.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const until = Date.now() + ms;
    for (;;) {
      try { const v = await evaluate(expression); if (v) return v; } catch { /* navigating */ }
      if (Date.now() > until) {
        let seen = '';
        try { seen = await evaluate(`location.href + ' | ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)`); } catch { seen = '(page not readable)'; }
        throw new Error('timed out waiting for: ' + expression + ' — page: ' + seen);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    version: async () => (await send('Browser.getVersion')).product,
    navigate: (url) => page('Page.navigate', { url }),
    evaluate, waitFor,
    screenshot: async (file) => { const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(file, Buffer.from(data, 'base64')); },
    consoleErrors: () => [],
    close: async () => { try { await send('Browser.close'); } catch { /* closing */ } child.kill(); fs.rmSync(profile, { recursive: true, force: true }); }
  };
}
