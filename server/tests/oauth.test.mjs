// OAuth 2.1 authorization server: discovery, registration, authorization with PKCE through the site's consent page,
// token exchange, refresh rotation, revocation, device authorization, connection management and limits.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, pkce, post, form, register, person, connect, rpc } from './helpers.mjs';

const WB = 'workbuddy://workbuddy/mcp/connector%3Axiexiubifa-writing/oauth/callback';
let env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const authorizeUrl = (params) => env.base + '/oauth/authorize?' + form(params);
async function authorizeRequest(client, extra = {}) {
  const { verifier, challenge } = pkce();
  const params = { response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra };
  const response = await fetch(authorizeUrl(params), { redirect: 'manual' });
  return { response, verifier, params, location: response.headers.get('location') };
}
const requestIdOf = (location) => new URL(location).searchParams.get('connect');
const tokenRows = () => [...(env.store._tables.get('xxb_tokens') || new Map()).values()];

test('discovery documents describe a public-client OAuth 2.1 server with PKCE S256 and this MCP resource', async () => {
  const as = await (await fetch(env.base + '/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, env.base);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.ok(as.grant_types_supported.includes('refresh_token') && as.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'));
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint', 'device_authorization_endpoint']) assert.ok(as[key].startsWith(env.base + '/oauth/'), key);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const prm = await (await fetch(env.base + path)).json();
    assert.equal(prm.resource, env.base + '/mcp');
    assert.deepEqual(prm.authorization_servers, [env.base]);
    assert.deepEqual(prm.scopes_supported, ['write', 'drafts:read', 'account:read']);
  }
});

test('registration: app schemes and loopback are accepted and echoed; unsafe or unlisted targets are refused', async () => {
  const ok = await post(env.base + '/oauth/register', { client_name: 'Work<b>Buddy</b>\u0000', redirect_uris: [WB, 'http://127.0.0.1:43210/oauth/callback'], token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.data.redirect_uris, [WB, 'http://127.0.0.1:43210/oauth/callback'], 'redirect_uris are echoed exactly (WorkBuddy needs them back)');
  assert.equal(ok.data.token_endpoint_auth_method, 'none', 'public clients only; no secret is issued');
  assert.equal(ok.data.client_secret, undefined);
  assert.equal(ok.data.client_name, 'WorkbBuddy/b', 'the name a client gives itself is stored as plain text');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/cb', 'https://evil.example/cb', WB + '#frag', 'file:///etc/passwd', 'https://user:pw@claude.ai/cb']) {
    const out = await post(env.base + '/oauth/register', { client_name: 'x', redirect_uris: [bad] });
    assert.equal(out.status, 400, bad);
    assert.equal(out.data.error, 'invalid_redirect_uri', bad);
  }
  const none = await post(env.base + '/oauth/register', { client_name: 'x' });
  assert.equal(none.data.error, 'invalid_redirect_uri', 'an authorization-code client needs a redirect URI');
});

test('authorize: an unknown client or a mismatched redirect is shown to the person, never redirected', async () => {
  const unknown = await fetch(authorizeUrl({ response_type: 'code', client_id: 'xc_doesnotexist000000000000', redirect_uri: WB, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }), { redirect: 'manual' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('location'), null);
  assert.match(unknown.headers.get('content-type'), /text\/html/);
  assert.match(unknown.headers.get('x-frame-options'), /DENY/);
  const client = await register(env.base);
  const mismatch = await fetch(authorizeUrl({ response_type: 'code', client_id: client.client_id, redirect_uri: 'workbuddy://other/callback', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }), { redirect: 'manual' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.headers.get('location'), null);
});

test('authorize: PKCE S256 is required; errors go back to the client with state and iss', async () => {
  const client = await register(env.base);
  for (const [extra, error] of [[{ code_challenge: undefined }, 'invalid_request'], [{ code_challenge_method: 'plain' }, 'invalid_request'], [{ response_type: 'token' }, 'unsupported_response_type'], [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target']]) {
    const { response, location } = await authorizeRequest(client, extra);
    assert.equal(response.status, 302, JSON.stringify(extra));
    const back = new URL(location);
    assert.equal(back.protocol, 'workbuddy:');
    assert.equal(back.searchParams.get('error'), error);
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), env.base);
  }
});

test('authorize → the site\'s consent page → approve → code → tokens (and the WorkBuddy callback stays exact)', async () => {
  const client = await register(env.base);
  const { response, verifier, location } = await authorizeRequest(client, { scope: 'write drafts:read account:read openid', resource: env.base + '/mcp' });
  assert.equal(response.status, 302);
  assert.ok(location.startsWith(env.base + '/demo-site/?connect=ar_'), 'the browser goes to the site page where the person is logged in');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const who = await person(env, '13800001111');
  const view = await env.service.siteAction(who, 'consent_view', { request: requestIdOf(location) });
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.data.client.name, 'WorkBuddy');
  assert.equal(view.data.client.selfNamed, true);
  assert.equal(view.data.client.returnTo, 'WorkBuddy 应用（workbuddy://）');
  assert.equal(view.data.account.phoneLabel, '138 ···· 1111');
  assert.deepEqual(view.data.scopes.map((s) => s.id), ['write', 'drafts:read', 'account:read'], 'unknown scopes (openid) are left out; the page lists what is granted');
  const approved = await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
  assert.equal(approved.ok, true);
  const back = new URL(approved.data.redirectTo);
  assert.ok(approved.data.redirectTo.startsWith(WB + '?'), 'the registered callback is used exactly: ' + approved.data.redirectTo);
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(back.searchParams.get('iss'), env.base);
  const code = back.searchParams.get('code');
  const wrong = await post(env.base + '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: WB, client_id: client.client_id, code_verifier: pkce().verifier }, { asForm: true });
  assert.equal(wrong.data.error, 'invalid_grant', 'a different PKCE verifier is refused');
  // A failed check changes nothing, so the client holding the real verifier still gets its tokens.
  const token = await post(env.base + '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: WB, client_id: client.client_id, code_verifier: verifier }, { asForm: true });
  assert.equal(token.status, 200, JSON.stringify(token.data));
  assert.match(token.data.access_token, /^xxa_[\w-]{43}$/);
  assert.match(token.data.refresh_token, /^xxr_[\w-]{43}$/);
  assert.equal(token.data.token_type, 'Bearer');
  assert.equal(token.data.expires_in, 3600);
  assert.equal(token.data.scope, 'write drafts:read account:read');
  assert.equal(token.headers.get('cache-control'), 'no-store');
  const again = await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
  assert.equal(again.ok, false, 'a request is approved once');
  const stored = JSON.stringify([...env.store._tables.values()].map((t) => [...t.values()]));
  assert.ok(!stored.includes(token.data.access_token) && !stored.includes(token.data.refresh_token) && !stored.includes(code), 'tokens and codes are stored only as hashes');
});

test('a code used twice is refused and revokes what the first use produced (OAuth 2.1 §4.1.3)', async () => {
  const client = await register(env.base);
  const { verifier, location } = await authorizeRequest(client);
  const who = await person(env, '13800002222');
  const approved = await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
  const code = new URL(approved.data.redirectTo).searchParams.get('code');
  const body = { grant_type: 'authorization_code', code, redirect_uri: WB, client_id: client.client_id, code_verifier: verifier };
  const first = await post(env.base + '/oauth/token', body, { asForm: true });
  assert.equal(first.status, 200);
  assert.equal((await rpc(env, first.data.access_token, 'ping', {})).status, 200);
  const second = await post(env.base + '/oauth/token', body, { asForm: true });
  assert.equal(second.data.error, 'invalid_grant');
  assert.equal((await rpc(env, first.data.access_token, 'ping', {})).status, 401, 'the connection made with the replayed code is closed');
});

test('a used code presented again by another client, or without its PKCE verifier or redirect, is refused and the connection stays', async () => {
  const client = await register(env.base);
  const other = await register(env.base);
  const { verifier, location } = await authorizeRequest(client);
  const who = await person(env, '13800002223');
  const approved = await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
  const code = new URL(approved.data.redirectTo).searchParams.get('code');
  const body = { grant_type: 'authorization_code', code, redirect_uri: WB, client_id: client.client_id, code_verifier: verifier };
  const first = await post(env.base + '/oauth/token', body, { asForm: true });
  assert.equal(first.status, 200);
  // Someone who saw the code (in a log, a URL) but holds nothing else cannot use it to disconnect the person.
  for (const [label, replay] of [['another client', { ...body, client_id: other.client_id }], ['a wrong verifier', { ...body, code_verifier: pkce().verifier }],
    ['no verifier', { ...body, code_verifier: undefined }], ['another redirect', { ...body, redirect_uri: 'workbuddy://workbuddy/other' }]]) {
    const out = await post(env.base + '/oauth/token', replay, { asForm: true });
    assert.equal(out.data.error, 'invalid_grant', label);
    assert.equal((await rpc(env, first.data.access_token, 'ping', {})).status, 200, label + ': the rightful connection still works');
  }
  const refresh = await post(env.base + '/oauth/token', { grant_type: 'refresh_token', refresh_token: first.data.refresh_token, client_id: client.client_id }, { asForm: true });
  assert.equal(refresh.status, 200, 'and its refresh token too');
});

test('token responses say which account was connected: the masked phone and an opaque reference, the same after a refresh', async () => {
  const a = await connect(env, { phone: '13800003334' });
  assert.equal(a.tokens.account_label, '138 ···· 3334');
  assert.match(a.tokens.account_ref, /^acct_[0-9a-f]{24}$/);
  const refreshed = await post(env.base + '/oauth/token', { grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, client_id: a.client.client_id }, { asForm: true });
  assert.equal(refreshed.data.account_label, a.tokens.account_label);
  assert.equal(refreshed.data.account_ref, a.tokens.account_ref);
  const b = await connect(env, { phone: '13800003335' });
  assert.notEqual(b.tokens.account_ref, a.tokens.account_ref);
  assert.equal(a.tokens.account_ref.includes('13800003334'), false, 'the reference does not carry the phone number');
});

test('a code bound to one client, redirect URI and time', async () => {
  const client = await register(env.base);
  const other = await register(env.base);
  const { verifier, location } = await authorizeRequest(client);
  const who = await person(env, '13800003333');
  const approved = await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
  const code = new URL(approved.data.redirectTo).searchParams.get('code');
  const base = { grant_type: 'authorization_code', code, redirect_uri: WB, client_id: client.client_id, code_verifier: verifier };
  assert.equal((await post(env.base + '/oauth/token', { ...base, client_id: other.client_id }, { asForm: true })).data.error, 'invalid_grant');
  assert.equal((await post(env.base + '/oauth/token', { ...base, redirect_uri: 'workbuddy://workbuddy/other' }, { asForm: true })).data.error, 'invalid_grant');
  for (const [id, row] of env.store._tables.get('xxb_codes')) if (!row.used) env.store._tables.get('xxb_codes').set(id, { ...row, expiresAt: Date.now() - 1 });
  assert.equal((await post(env.base + '/oauth/token', base, { asForm: true })).data.error, 'invalid_grant', 'an expired code is refused');
});

test('loopback redirects match on any port (RFC 8252 §7.3) but the token request must repeat the exact URI', async () => {
  const client = await register(env.base, ['http://127.0.0.1/oauth/callback']);
  const { response, location, verifier } = await authorizeRequest(client, { redirect_uri: 'http://127.0.0.1:51234/oauth/callback' });
  assert.equal(response.status, 302);
  const who = await person(env, '13800004444');
  const view = await env.service.siteAction(who, 'consent_view', { request: requestIdOf(location) });
  assert.match(view.data.client.returnTo, /本机地址 127\.0\.0\.1/);
  const approved = await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
  assert.ok(approved.data.redirectTo.startsWith('http://127.0.0.1:51234/oauth/callback?'));
  const code = new URL(approved.data.redirectTo).searchParams.get('code');
  const token = await post(env.base + '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:51234/oauth/callback', client_id: client.client_id, code_verifier: verifier }, { asForm: true });
  assert.equal(token.status, 200);
});

test('denying sends access_denied back to the client and issues nothing', async () => {
  const client = await register(env.base);
  const { location } = await authorizeRequest(client);
  const who = await person(env, '13800005555');
  const denied = await env.service.siteAction(who, 'consent_deny', { request: requestIdOf(location) });
  assert.equal(denied.ok, true);
  const back = new URL(denied.data.redirectTo);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal((await env.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) })).ok, false, 'a refused request cannot be approved afterwards');
});

test('the consent page needs the person\'s site login; an expired request cannot be approved', async () => {
  const client = await register(env.base);
  const { location } = await authorizeRequest(client);
  assert.equal((await env.service.siteAction(null, 'consent_approve', { request: requestIdOf(location) })).code, 'LOGIN_REQUIRED');
  const id = requestIdOf(location);
  const rows = env.store._tables.get('xxb_auth_requests');
  rows.set(id, { ...rows.get(id), expiresAt: Date.now() - 1 });
  const who = await person(env, '13800006666');
  const late = await env.service.siteAction(who, 'consent_approve', { request: id });
  assert.equal(late.ok, false);
  assert.match(late.message, /过期|已处理/);
});

test('refresh tokens rotate; a replay right after rotation is refused, a later replay closes the connection', async () => {
  const { client, tokens } = await connect(env, { phone: '13800007777' });
  const refresh = (token, extra = {}) => post(env.base + '/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id, ...extra }, { asForm: true });
  const next = await refresh(tokens.refresh_token);
  assert.equal(next.status, 200);
  assert.notEqual(next.data.refresh_token, tokens.refresh_token);
  assert.equal((await rpc(env, next.data.access_token, 'ping', {})).status, 200);
  const race = await refresh(tokens.refresh_token);
  assert.equal(race.data.error, 'invalid_grant');
  assert.equal((await rpc(env, next.data.access_token, 'ping', {})).status, 200, 'a near-simultaneous retry does not close the connection');
  assert.equal((await refresh(next.data.refresh_token, { scope: 'write drafts:read account:read' })).status, 200, 'the same scope may be asked again');
  const wider = await connect(env, { phone: '13800007778', scope: 'write' });
  const widen = await post(env.base + '/oauth/token', { grant_type: 'refresh_token', refresh_token: wider.tokens.refresh_token, client_id: wider.client.client_id, scope: 'write account:read' }, { asForm: true });
  assert.equal(widen.data.error, 'invalid_scope', 'a refresh cannot widen the connection');
  // A replay well after rotation (a stolen token) closes everything.
  const latest = await refresh((await refresh(wider.tokens.refresh_token)).data.refresh_token);
  for (const [id, row] of env.store._tables.get('xxb_tokens')) if (row.rotatedAt) env.store._tables.get('xxb_tokens').set(id, { ...row, rotatedAt: Date.now() - 5 * 60 * 1000 });
  assert.equal((await refresh(wider.tokens.refresh_token)).data.error, 'invalid_grant');
  assert.equal((await rpc(env, latest.data.access_token, 'ping', {})).status, 401, 'reuse of an old refresh token closed the connection');
});

test('a client id sent with HTTP Basic authentication (no secret) is accepted at the token endpoint', async () => {
  const { client, tokens } = await connect(env, { phone: '13800009999' });
  const basic = 'Basic ' + Buffer.from(encodeURIComponent(client.client_id) + ':').toString('base64');
  const out = await post(env.base + '/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, { asForm: true, headers: { authorization: basic } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const other = await register(env.base);
  const mismatch = await post(env.base + '/oauth/token', { grant_type: 'refresh_token', refresh_token: out.data.refresh_token, client_id: other.client_id }, { asForm: true, headers: { authorization: basic } });
  assert.equal(mismatch.data.error, 'invalid_grant', 'the body\'s client id wins, and must match the token');
});

test('revoking the refresh token (RFC 7009) disconnects; unknown tokens are accepted silently', async () => {
  const { client, tokens } = await connect(env, { phone: '13800008888' });
  const out = await post(env.base + '/oauth/revoke', { token: tokens.refresh_token, client_id: client.client_id }, { asForm: true });
  assert.equal(out.status, 200);
  assert.equal((await rpc(env, tokens.access_token, 'ping', {})).status, 401);
  assert.equal((await post(env.base + '/oauth/revoke', { token: 'xxr_' + 'a'.repeat(43), client_id: client.client_id }, { asForm: true })).status, 200);
});

test('device authorization: link and code, pending, slow_down, approval on the site, tokens once', async () => {
  const start = await post(env.base + '/oauth/device_authorization', { client_id: 'xiexiubifa-agent-skill', client_hint: 'Claude Code<script>' }, { asForm: true });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const d = start.data;
  assert.match(d.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(d.verification_uri_complete, env.base + '/demo-site/?connect_code=' + d.user_code);
  assert.equal(d.interval, 5);
  assert.equal(d.expires_in, 600);
  const poll = () => post(env.base + '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: 'xiexiubifa-agent-skill' }, { asForm: true });
  assert.equal((await poll()).data.error, 'authorization_pending');
  assert.equal((await poll()).data.error, 'slow_down');
  const who = await person(env, '13900001234');
  const view = await env.service.siteAction(who, 'consent_view', { code: d.user_code.toLowerCase().replace('-', ' ') });
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.data.kind, 'device');
  assert.equal(view.data.userCode, d.user_code, 'the page shows the code for the person to compare');
  assert.equal(view.data.client.name, '邪修笔法写作技能（在其他 AI 助手里使用）（Claude Codescript）');
  assert.equal(view.data.client.selfNamed, true, 'the agent name a script adds is marked as self-reported');
  const plainStart = await post(env.base + '/oauth/device_authorization', { client_id: 'xiexiubifa-agent-skill' }, { asForm: true });
  const plainView = await env.service.siteAction(who, 'consent_view', { code: plainStart.data.user_code });
  assert.equal(plainView.data.client.selfNamed, false, 'the built-in client\'s own name is the service\'s');
  assert.equal((await env.service.siteAction(who, 'consent_approve', { code: d.user_code })).ok, true);
  for (const [id, row] of env.store._tables.get('xxb_auth_requests')) if (row.kind === 'device') env.store._tables.get('xxb_auth_requests').set(id, { ...row, lastPollAt: 0 });
  const got = await poll();
  assert.equal(got.status, 200, JSON.stringify(got.data));
  assert.match(got.data.access_token, /^xxa_/);
  assert.equal((await rpc(env, got.data.access_token, 'ping', {})).status, 200);
  assert.equal((await poll()).data.error, 'invalid_grant', 'tokens are handed out once');
  const requests = [...env.store._tables.get('xxb_auth_requests').values()].filter((r) => r.kind === 'device' && r.status === 'claimed');
  assert.ok(requests.every((r) => r.approval === null), 'the claimed request no longer holds the account');
});

test('device authorization: refused, expired, wrong codes limited, unknown clients rejected', async () => {
  const begin = async () => (await post(env.base + '/oauth/device_authorization', { client_id: 'xiexiubifa-agent-skill' }, { asForm: true })).data;
  const poll = (d) => post(env.base + '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code, client_id: 'xiexiubifa-agent-skill' }, { asForm: true });
  const who = await person(env, '13900002222');
  const refused = await begin();
  await env.service.siteAction(who, 'consent_deny', { code: refused.user_code });
  assert.equal((await poll(refused)).data.error, 'access_denied');
  const late = await begin();
  for (const [id, row] of env.store._tables.get('xxb_auth_requests')) if (row.kind === 'device' && row.status === 'pending') env.store._tables.get('xxb_auth_requests').set(id, { ...row, expiresAt: Date.now() - 1 });
  assert.equal((await poll(late)).data.error, 'expired_token');
  let limited = null;
  for (let i = 0; i < 25 && !limited; i += 1) {
    const out = await env.service.siteAction(who, 'consent_view', { code: 'BBBB-BBBB' });
    if (out.code === 'RATE_LIMITED') limited = out;
  }
  assert.ok(limited, 'wrong codes are limited per account');
  const stranger = await post(env.base + '/oauth/device_authorization', { client_id: 'nobody' }, { asForm: true });
  assert.equal(stranger.status, 401);
  assert.equal(stranger.data.error, 'invalid_client');
});

test('connections: listed for the account on the site, closed by the person, not by another account', async () => {
  const { tokens, who } = await connect(env, { phone: '13700001234' });
  const listed = await env.service.siteAction(who, 'connections_list', {});
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].clientName, 'WorkBuddy');
  assert.equal(listed.data.items[0].uid, undefined, 'the list does not expose the site user id');
  const stranger = await person(env, '13700005678');
  assert.equal((await env.service.siteAction(stranger, 'connection_revoke', { id: listed.data.items[0].id })).code, 'NOT_FOUND');
  assert.equal((await rpc(env, tokens.access_token, 'ping', {})).status, 200);
  assert.equal((await env.service.siteAction(who, 'connection_revoke', { id: listed.data.items[0].id })).ok, true);
  const after = await rpc(env, tokens.access_token, 'ping', {});
  assert.equal(after.status, 401);
  assert.match(after.headers.get('www-authenticate'), /error="invalid_token"/);
});

test('reconnecting the same client replaces its older connection; the per-account limit is enforced', async () => {
  const client = await register(env.base);
  const first = await connect(env, { phone: '13600001234', client });
  const second = await connect(env, { phone: '13600001234', client });
  assert.equal((await rpc(env, first.tokens.access_token, 'ping', {})).status, 401, 'the older connection of the same client was replaced');
  assert.equal((await rpc(env, second.tokens.access_token, 'ping', {})).status, 200);
  const small = await start({ config: { maxGrantsPerAccount: 1 } });
  try {
    await connect(small, { phone: '13600009999' });
    const c2 = await register(small.base);
    const { location } = await (async () => { const { challenge } = pkce(); const r = await fetch(small.base + '/oauth/authorize?' + form({ response_type: 'code', client_id: c2.client_id, redirect_uri: WB, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' }); return { location: r.headers.get('location') }; })();
    const who = await person(small, '13600009999');
    const refused = await small.service.siteAction(who, 'consent_approve', { request: requestIdOf(location) });
    assert.equal(refused.code, 'TOO_MANY_CONNECTIONS');
    assert.match(refused.message, /已连接的 AI 助手/);
  } finally { await small.close(); }
});

test('the site no longer knowing the phone, or a changed phone, closes the connection', async () => {
  const quick = await start({ config: { identityRecheckMs: 0 } });
  try {
    const a = await connect(quick, { phone: '13500001234' });
    assert.equal((await rpc(quick, a.tokens.access_token, 'ping', {})).status, 200);
    quick.adapter.demo.changePhone(a.who.uid, '13500009999');
    const changed = await rpc(quick, a.tokens.access_token, 'ping', {});
    assert.equal(changed.status, 401);
    assert.match(changed.data.error_description, /手机号已变化/);
    const b = await connect(quick, { phone: '13500005555' });
    quick.adapter.demo.removePhone(b.who.uid);
    assert.equal((await rpc(quick, b.tokens.access_token, 'ping', {})).status, 401);
  } finally { await quick.close(); }
});

test('open endpoints are rate limited', async () => {
  const tight = await start({ limits: { register_ip: { windowMs: 60000, max: 3 } } });
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await post(tight.base + '/oauth/register', { client_name: 'x', redirect_uris: [WB] })).status);
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
  } finally { await tight.close(); }
});

test('tokens in storage: hashes only; access tokens expire', async () => {
  const { tokens } = await connect(env, { phone: '13400001234' });
  for (const [id, row] of env.store._tables.get('xxb_tokens')) if (row.type === 'access') env.store._tables.get('xxb_tokens').set(id, { ...row, expiresAt: Date.now() - 1 });
  const expired = await rpc(env, tokens.access_token, 'ping', {});
  assert.equal(expired.status, 401);
  assert.ok(tokenRows().every((row) => !JSON.stringify(row).includes('xxa_') && !JSON.stringify(row).includes('xxr_')));
});
