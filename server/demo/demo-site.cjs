'use strict';
// DEMO site pages (/demo-site/…) for local runs: a stand-in for the writing site's own pages, clearly marked as such.
// - a demo login (pick a demo phone number; no SMS) with a session cookie;
// - the consent page (web/consent-ui.js, the same module the real site would include) for ?connect= and ?connect_code;
// - a 会员中心 with a button that turns membership on (no payment), and the list of connected assistants;
// - the account's drafts.
// The consent page's actions go to service.siteAction() with the identity of the demo session, exactly as the real
// site's page calls the service with the person's own site login.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const WEB = path.join(__dirname, '..', 'web');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createDemoSite({ service, adapter, baseUrl }) {
  const sessions = new Map();
  const origin = new URL(baseUrl).origin;

  const cookieOf = (req) => /(?:^|;\s*)xxb_demo=([\w-]{20,60})/.exec(req.headers.cookie || '')?.[1] || '';
  const uidOf = (req) => sessions.get(cookieOf(req)) || null;
  async function who(req) {
    const uid = uidOf(req);
    if (!uid) return null;
    try { return { uid, ...(await adapter.identity(uid)) }; } catch { return null; }
  }

  function page(title, body, script = '') {
    const nonce = randomBytes(12).toString('base64');
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
        'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'` },
      body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/demo-site/consent-ui.css"></head>
<body><div style="background:#fff3cd;border-bottom:1px solid #e0c36a;padding:.5rem 1rem;font:14px system-ui">本地演示站 · 不是 xiexiubifa.cn · 不涉及真实账号、真实写作或付款</div>
<nav style="padding:.5rem 1rem;font:14px system-ui"><a href="/demo-site/">首页</a> · <a href="/demo-site/membership">会员中心</a> · <a href="/demo-site/drafts">成稿记录</a></nav>
<main class="xc-page" id="xc">${body}</main>${script ? `<script type="module" nonce="${nonce}">${script}</script>` : ''}</body></html>`
    };
  }
  const json = (status, data, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(data) });

  // The page's script; it marks <html data-ready="true"> once everything on the page is wired (tests wait for it).
  const CLIENT = `import { connectRefFrom, mountConsent, mountConnections } from '/demo-site/consent-ui.js';
const call = async (action, payload) => (await fetch('/demo-site/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }) })).json();
const form = document.querySelector('#login');
if (form) form.addEventListener('submit', async (event) => { event.preventDefault(); const answer = await call('login', { phone: form.elements.phone.value }); if (!answer.ok) { form.querySelector('p').textContent = answer.message; return; } const back = new URLSearchParams(location.search).get('back') || '/demo-site/'; location.assign(back.startsWith('/demo-site/') ? back : '/demo-site/'); });
const me = (await call('me', {})).data;
window.__demo = { call };
const toLogin = () => location.assign('/demo-site/login?back=' + encodeURIComponent(location.pathname + location.search));
const deps = { call, account: () => me.account, login: toLogin, switchAccount: toLogin, navigate: (url) => location.assign(url) };
const host = document.querySelector('#xc');
const ref = connectRefFrom(location.search);
if (ref) await mountConsent(host, ref, deps);
const list = document.querySelector('#connections');
if (list && me.account) await mountConnections(list, deps);
for (const button of document.querySelectorAll('[data-demo]')) button.addEventListener('click', async () => { await call(button.dataset.demo, {}); location.reload(); });
document.documentElement.dataset.ready = 'true';`;

  async function handle(req) {
    if (!req.path.startsWith('/demo-site')) return null;
    if (req.method === 'GET' && (req.path === '/demo-site/consent-ui.js' || req.path === '/demo-site/consent-ui.css')) {
      const file = path.join(WEB, path.basename(req.path));
      return { status: 200, headers: { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store' }, body: fs.readFileSync(file) };
    }
    if (req.method === 'POST' && req.path === '/demo-site/api') {
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { ok: false, code: 'CROSS_SITE', message: '不接受来自其他网站的请求。' });
      let body;
      try { body = JSON.parse(String(req.body || '{}')); } catch { return json(400, { ok: false, code: 'BAD_JSON', message: '请求格式不正确。' }); }
      const { action, payload = {} } = body;
      if (action === 'login') {
        const phone = String(payload.phone || '').replace(/\D/g, '');
        if (!/^1[3-9]\d{9}$/.test(phone)) return json(200, { ok: false, code: 'BAD_PHONE', message: '请输入 11 位手机号（演示站不发短信）。' });
        const sid = randomBytes(24).toString('base64url');
        sessions.set(sid, adapter.demo.createAccount(phone));
        return json(200, { ok: true, data: {} }, { 'set-cookie': `xxb_demo=${sid}; Path=/demo-site; HttpOnly; SameSite=Lax` });
      }
      const person = await who(req);
      if (action === 'me') return json(200, { ok: true, data: { account: person ? { label: person.phoneLabel } : null } });
      if (!person) return json(200, { ok: false, code: 'LOGIN_REQUIRED', message: '请先登录演示站。' });
      if (action === 'demo_activate') { adapter.demo.activateMembership(person.uid); return json(200, { ok: true, data: {} }); }
      if (action === 'demo_end_trial') { adapter.demo.endTrial(person.uid); return json(200, { ok: true, data: {} }); }
      if (action === 'logout') { sessions.delete(cookieOf(req)); return json(200, { ok: true, data: {} }); }
      return json(200, await service.siteAction(person, action, payload));
    }
    if (req.method !== 'GET') return json(405, { ok: false });
    const person = await who(req);
    if (req.path === '/demo-site/login') {
      const known = adapter.demo.accounts();
      return page('演示站登录', `<h2 class="xc-title">手机号登录（演示）</h2><form id="login"><input name="phone" placeholder="11 位手机号" inputmode="tel" style="font:inherit;padding:.4rem"> <button class="xc-primary" style="font:inherit;padding:.45rem 1rem">登录</button><p class="xc-message"></p></form>
${known.length ? `<p class="xc-note">演示站已有账号：${known.map((a) => esc(a.phone.slice(0, 3) + '····' + a.phone.slice(-4))).join('、')}</p>` : ''}`, CLIENT);
    }
    if (req.path === '/demo-site/membership') {
      if (!person) return page('会员中心', '<p>请先 <a href="/demo-site/login?back=/demo-site/membership">登录演示站</a>。</p>');
      const m = (await adapter.membership(person.uid)).status;
      return page('会员中心', `<h2 class="xc-title">会员中心（演示）</h2><p>账号 ${esc(person.phoneLabel)}：<b>${esc(m.tierName)}</b>，剩余额度约 ${esc(m.quotaPercent)}%</p>
<div class="xc-actions"><button type="button" class="xc-primary" data-demo="demo_activate">模拟开通标准版（演示，不付款）</button><button type="button" data-demo="demo_end_trial">模拟体验结束</button></div><section id="connections"></section>`, CLIENT);
    }
    if (req.path === '/demo-site/drafts') {
      if (!person) return page('成稿记录', '<p>请先 <a href="/demo-site/login?back=/demo-site/drafts">登录演示站</a>。</p>');
      const items = await adapter.drafts(person.uid);
      return page('成稿记录', `<h2 class="xc-title">成稿记录（演示）</h2>${items.length ? `<ul>${items.map((d) => `<li>${esc(d.recordId)}《${esc(d.title)}》共 ${d.versions} 稿</li>`).join('')}</ul>` : '<p>还没有成稿。</p>'}`);
    }
    return page('邪修笔法 · 本地演示站', person ? `<p>已登录：${esc(person.phoneLabel)}</p>` : '<p><a href="/demo-site/login">登录演示站</a></p>', CLIENT);
  }

  return { handle };
}

module.exports = { createDemoSite };
