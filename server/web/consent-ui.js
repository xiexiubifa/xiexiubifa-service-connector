// 连接 AI 助手 — the consent page and the connection list, for the writing site's own pages.
//
// Framework-free and without imports, so the site can include it as it is. Every value shown comes from the service
// (`consent_view`) and is escaped. The page:
//   - asks the person to log in on the site first (the site's own login), and comes back to the same request after;
//   - shows who is asking and where the connection returns to, what it can do, which data is sent and kept where and
//     for how long, what it costs (with the site's plan prices and the person's current membership), what it cannot
//     do, and the person's choices — before anything is allowed;
//   - for a device connection, asks the person to compare the code with the one in their AI assistant;
//   - says that the account logged in on this browser is the one that gets connected, and how to switch to another;
//   - allows or refuses only on a deliberate click.
// deps: { call(action, payload) → {ok, data|code, message}, account() → {label}|null, login(), navigate(url),
//         switchAccount() (optional: the site's own way to log out and log in with another phone; comes back here) }

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const date = (ms) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '');
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/i;

// ?connect=<request id> (authorization from an MCP client such as WorkBuddy) or ?connect_code[=<user code>] (device).
export function connectRefFrom(search) {
  const params = new URLSearchParams(search || '');
  const request = params.get('connect');
  if (request && /^ar_[\w-]{30,40}$/.test(request)) return { request };
  if (params.has('connect_code')) {
    const code = (params.get('connect_code') || '').trim().toUpperCase();
    return CODE.test(code) ? { code } : { code: '' };
  }
  return null;
}

function plansHtml(plans) {
  if (!plans?.length) return '';
  return `<ul class="xc-plans">${plans.map((p) => `<li><b>${esc(p.name)}</b>${p.note ? `<span>${esc(p.note)}</span>` : ''}<span>${(p.prices || []).map((x) => `¥${esc(x.yuan)}/${esc(x.period)}`).join('　')}</span></li>`).join('')}</ul>`;
}

function memberHtml(m) {
  if (!m) return '';
  const quota = m.unlimited ? '额度不限' : typeof m.quotaPercent === 'number' ? `剩余额度约 ${m.quotaPercent}%` : '';
  const until = m.tier === 'trial' && m.trialExpiresAt ? `，体验到 ${time(m.trialExpiresAt)}` : m.expiresAt ? `，到期 ${date(m.expiresAt)}` : '';
  return `<p class="xc-member">你现在：<b>${esc(m.tierName)}</b>${quota ? '，' + esc(quota) : ''}${esc(until)}</p>`;
}

// The account that gets connected is the one logged in on this browser; switching goes through the site's own login.
function accountNoteHtml(view) {
  const how = view.canSwitch ? '点「换一个账号」，退出后用那个手机号登录，会回到这一步。'
    : view.account?.switchHint ? `${esc(view.account.switchHint)}，登录后会回到这一步。` : '先在网站上退出登录，再用那个手机号登录。';
  return `<p class="xc-account-note">这是这个浏览器里现在登录的账号，允许后连接的就是它。要连接另一个账号：${how}</p>`;
}

export function consentHtml(view) {
  const d = view.disclosure || {};
  const sections = (d.sections || []).map((s) => `<section class="xc-section" data-section="${esc(s.id)}"><h3>${esc(s.title)}</h3><ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>${s.id === 'fees' ? plansHtml(d.plans) + memberHtml(d.membership) : ''}</section>`).join('');
  return `<h2 class="xc-title">连接 AI 助手</h2>
<p class="xc-lead">「<b>${esc(view.client?.name)}</b>」请求连接你的${esc(d.provider || '')}账号 <b>${esc(view.account?.phoneLabel)}</b>。${view.client?.selfNamed ? '<small>（名称由这个程序自己提供）</small>' : ''}</p>
${accountNoteHtml(view)}
${view.kind === 'device'
    ? `<p class="xc-return">连接方式：<b>授权码</b>（允许后回到 AI 助手里继续）</p><p class="xc-code">请核对授权码：<b>${esc(view.userCode)}</b><br><small>应与 AI 助手里显示的一致；不一致就点「不允许」。</small></p>`
    : `<p class="xc-return">允许后会回到：<b>${esc(view.client?.returnTo)}</b></p>`}
<section class="xc-section" data-section="scopes"><h3>连接后它可以</h3><ul>${(view.scopes || []).map((s) => `<li>${esc(s.text)}</li>`).join('')}</ul></section>
${sections}
${d.termsUrl ? `<p class="xc-terms"><a href="${esc(d.termsUrl)}" target="_blank" rel="noopener noreferrer">完整的数据与费用说明</a></p>` : ''}
<div class="xc-actions"><button type="button" class="xc-primary" data-xc="approve">允许连接</button><button type="button" data-xc="deny">不允许</button>${view.canSwitch ? '<button type="button" data-xc="switch">换一个账号</button>' : ''}</div>
<p class="xc-note">只有你刚刚在自己的 AI 助手里发起连接时，才点「允许连接」。这个请求 ${esc(time(view.expiresAt))} 前有效。</p>
<p class="xc-message" role="status" aria-live="polite"></p>`;
}

export function loginHtml() {
  return `<h2 class="xc-title">连接 AI 助手</h2><p class="xc-lead">你的 AI 助手请求连接你的账号。请先用手机号登录网站，登录后会回到这一步。</p>
<div class="xc-actions"><button type="button" class="xc-primary" data-xc="login">手机号登录</button></div>`;
}

export function codeEntryHtml(message = '') {
  return `<h2 class="xc-title">连接 AI 助手</h2><p class="xc-lead">请输入 AI 助手里显示的 8 位授权码（例如 BCDF-GHJK）。</p>
<form class="xc-code-form" data-xc-form><input name="code" maxlength="9" autocomplete="off" spellcheck="false" aria-label="授权码" placeholder="XXXX-XXXX"><button type="submit" class="xc-primary">下一步</button></form>
<p class="xc-message${message ? ' is-error' : ''}" role="status" aria-live="polite">${esc(message)}</p>`;
}

function doneHtml(text, link) {
  return `<h2 class="xc-title">连接 AI 助手</h2><p class="xc-lead">${esc(text)}</p>${link ? `<p class="xc-return"><a class="xc-primary-link" href="${esc(link.url)}">${esc(link.label)}</a></p>` : ''}`;
}

function mountCodeEntry(host, deps, message = '') {
  host.innerHTML = codeEntryHtml(message);
  host.querySelector('[data-xc-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = String(event.target.elements.code.value || '').trim().toUpperCase();
    if (!CODE.test(code)) { mountCodeEntry(host, deps, '授权码是 8 个字母，例如 BCDF-GHJK。'); return; }
    mountConsent(host, { code }, deps);
  });
}

// Renders the page for `ref` into `host` and handles the two buttons.
export async function mountConsent(host, ref, deps) {
  const show = (markup) => { host.innerHTML = markup; };
  const say = (text, error = false) => { const p = host.querySelector('.xc-message'); if (p) { p.textContent = text; p.classList.toggle('is-error', error); } };
  if (!deps.account()) {
    show(loginHtml());
    host.querySelector('[data-xc="login"]').addEventListener('click', () => deps.login());
    return;
  }
  if (ref.code === '') { mountCodeEntry(host, deps); return; }
  show('<p class="xc-lead">正在读取连接请求…</p>');
  const viewed = await deps.call('consent_view', ref);
  if (!viewed?.ok) { show(doneHtml(viewed?.message || '没有找到这个连接请求。请回到 AI 助手里重新连接。')); return; }
  const view = { ...viewed.data, canSwitch: typeof deps.switchAccount === 'function' };
  show(consentHtml(view));
  const busy = (value) => { for (const b of host.querySelectorAll('[data-xc]')) b.disabled = value; };
  host.querySelector('[data-xc="switch"]')?.addEventListener('click', () => deps.switchAccount());
  host.querySelector('[data-xc="approve"]').addEventListener('click', async () => {
    busy(true); say('正在连接…');
    const answer = await deps.call('consent_approve', ref);
    if (!answer?.ok) { busy(false); say(answer?.message || '连接没有完成，请重试。', true); return; }
    if (answer.data.redirectTo) {
      show(doneHtml(`已允许。正在回到「${view.client.name}」……如果没有自动回去，点下面的按钮。`, { url: answer.data.redirectTo, label: '回到 ' + view.client.returnTo }));
      deps.navigate(answer.data.redirectTo);
    } else {
      show(doneHtml(`已允许。请回到 AI 助手里继续（例如说“好了”），它会接着处理刚才的请求。需要在 ${time(view.expiresAt)} 前回去，超过这个时间要重新连接。`));
    }
  });
  host.querySelector('[data-xc="deny"]').addEventListener('click', async () => {
    busy(true);
    const answer = await deps.call('consent_deny', ref);
    show(doneHtml('已拒绝，没有连接。这个请求不能再用了。'));
    if (answer?.ok && answer.data.redirectTo) deps.navigate(answer.data.redirectTo);
  });
}

export function connectionsHtml(items, { loading = false, error = '' } = {}) {
  const rows = (items || []).map((c) => `<li><div><b>${esc(c.clientName)}</b><small>${esc(c.returnTo || '')}</small><small>连接于 ${esc(date(c.createdAt))}${c.lastUsedAt ? ` · 最近使用 ${esc(time(c.lastUsedAt))}` : ''}</small></div><button type="button" data-xc-revoke="${esc(c.id)}">断开</button></li>`).join('');
  return `<h2>已连接的 AI 助手</h2>${loading ? '<p>正在读取…</p>' : error ? `<p class="xc-message is-error" role="alert">${esc(error)}</p>` : rows ? `<ul class="xc-connections">${rows}</ul>` : '<p>还没有连接。</p>'}
<p class="xc-note">连接的 AI 助手用你的会员权益和额度写作，不能付款或修改账号。断开后立即失效。</p>`;
}

export async function mountConnections(host, deps) {
  if (!host) return;
  host.innerHTML = connectionsHtml([], { loading: true });
  const load = async () => {
    const answer = await deps.call('connections_list', {});
    host.innerHTML = answer?.ok ? connectionsHtml(answer.data.items) : connectionsHtml([], { error: answer?.message || '暂时读不到，请稍后刷新。' });
  };
  host.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-xc-revoke]');
    if (!button || button.disabled) return;
    button.disabled = true;
    const answer = await deps.call('connection_revoke', { id: button.dataset.xcRevoke });
    if (!answer?.ok) { button.disabled = false; button.textContent = '断开失败，重试'; return; }
    await load();
  });
  await load();
}
