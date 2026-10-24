'use strict';
// OAuth 2.1 authorization server for connecting a person's existing site account to an AI client.
//
// Two ways in, one consent page on the site (where the person is already logged in, in their everyday browser):
// - authorization code + PKCE (S256) with dynamic client registration (RFC 7591) and metadata discovery
//   (RFC 8414 / RFC 9728): what WorkBuddy and other MCP clients run by themselves;
// - device authorization (RFC 8628): for agents that run a script and show the person a link and a short code.
// /oauth/authorize only records the request and sends the browser to the site's consent page. The site page shows who
// is asking, what the connection can do, which data is sent where and what it costs, and calls approve or deny with the
// person's own site login (the deployment verifies that login; this module receives the verified identity as `who`).
const { sha256, randomToken, randomId, pkceMatches, plain, ServiceError, OAuthError } = require('./util.cjs');
const { SCOPES, isLoopbackHost } = require('./config.cjs');

const CLIENTS = 'xxb_clients';
const REQUESTS = 'xxb_auth_requests';
const USER_CODES = 'xxb_user_codes';
const CODES = 'xxb_codes';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const GRANT_TYPES = ['authorization_code', 'refresh_token', DEVICE_GRANT];
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // RFC 8628 §6.1: no vowels, no look-alikes
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'ftp', 'ws', 'wss', 'filesystem', 'view-source', 'http', 'https']);
const KNOWN_APPS = { workbuddy: 'WorkBuddy', cursor: 'Cursor', vscode: 'VS Code', 'vscode-insiders': 'VS Code', claude: 'Claude', windsurf: 'Windsurf', trae: 'Trae' };
const IGNORED_SCOPES = new Set(['openid', 'offline_access', 'profile', 'email']);
const CONSENT_VERSION = 'consent-2026-10-24';

const normalizeUserCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
const userCodeId = (code) => 'uc_' + sha256('user|' + normalizeUserCode(code)).slice(0, 40);
const deviceRequestId = (deviceCode) => 'dv_' + sha256('device|' + deviceCode).slice(0, 40);
const codeId = (code) => 'ac_' + sha256('code|' + code).slice(0, 48);

function newUserCode() {
  const bytes = require('node:crypto').randomBytes(8);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code.slice(0, 4) + '-' + code.slice(4);
}

// Where a redirect URI sends the code, in words the person can check on the consent page. Null when not acceptable.
function redirectTarget(uri, config) {
  let url;
  try { url = new URL(uri); } catch { return null; }
  if (url.hash || url.username || url.password || uri.length > 400) return null;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'http') {
    if (!isLoopbackHost(url.hostname)) return null;
    return { kind: 'loopback', text: '这台电脑上的 AI 助手程序（本机地址 ' + url.hostname + '）' };
  }
  if (scheme === 'https') {
    const allowed = (config.allowedHttpsRedirects || []).some((rule) => (rule.endsWith('*') ? uri.startsWith(rule.slice(0, -1)) : uri === rule));
    return allowed ? { kind: 'https', text: '网站 ' + url.origin } : null;
  }
  if (!/^[a-z][a-z0-9+.-]{1,40}$/.test(scheme) || BLOCKED_SCHEMES.has(scheme)) return null;
  const name = KNOWN_APPS[scheme];
  return { kind: 'app', text: name ? `${name} 应用（${scheme}://）` : `电脑上的应用（${scheme}://）` };
}

// RFC 8252 §7.3: a loopback redirect URI matches whatever port the client opened this time.
function sameRedirect(registered, requested) {
  if (registered === requested) return true;
  try {
    const a = new URL(registered), b = new URL(requested);
    return a.protocol === 'http:' && b.protocol === 'http:' && isLoopbackHost(a.hostname) && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

function createOAuth({ config, store, limiter, grants, site, now = () => Date.now() }) {
  const endpoint = (path) => config.issuer + path;
  const builtIn = new Map((config.builtInClients || []).map((c) => [c.client_id, c]));

  async function client(clientId) {
    if (typeof clientId !== 'string' || clientId.length > 80) return null;
    if (builtIn.has(clientId)) return builtIn.get(clientId);
    if (!/^xc_[\w-]{20,40}$/.test(clientId)) return null;
    return store.get(CLIENTS, clientId);
  }

  // The scopes a request asks for that this service knows (others, such as OIDC's, are left out); none known → all.
  // The consent page lists exactly the result, so the person approves what is granted.
  function scopesFrom(value) {
    const asked = String(value || '').split(' ').filter((s) => s && !IGNORED_SCOPES.has(s));
    const known = config.scopes.filter((s) => asked.includes(s));
    return known.length ? known : [...config.scopes];
  }

  function resourceOk(value) {
    if (value === undefined || value === null || value === '') return true;
    return [config.resource, config.resource + '/', config.issuer, config.issuer + '/'].includes(String(value));
  }

  // ------------------------------------------------------------------ discovery

  function authorizationServerMetadata() {
    return {
      issuer: config.issuer,
      authorization_endpoint: endpoint('/oauth/authorize'),
      token_endpoint: endpoint('/oauth/token'),
      registration_endpoint: endpoint('/oauth/register'),
      revocation_endpoint: endpoint('/oauth/revoke'),
      device_authorization_endpoint: endpoint('/oauth/device_authorization'),
      scopes_supported: config.scopes,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: GRANT_TYPES,
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      ...(config.termsUrl ? { service_documentation: config.termsUrl, op_policy_uri: config.termsUrl } : {})
    };
  }

  function protectedResourceMetadata() {
    return {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: config.scopes,
      bearer_methods_supported: ['header'],
      resource_name: config.serviceName,
      ...(config.termsUrl ? { resource_documentation: config.termsUrl, resource_policy_uri: config.termsUrl } : {})
    };
  }

  // ------------------------------------------------------------------ RFC 7591 registration (public clients only)

  async function register(body, ip) {
    await limiter.hit('register_ip', ip || 'unknown');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', '注册信息格式不正确。');
    const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length ? body.grant_types.map(String) : ['authorization_code', 'refresh_token'];
    if (grantTypes.some((g) => !GRANT_TYPES.includes(g))) throw new OAuthError('invalid_client_metadata', '不支持的 grant_types。');
    if (body.response_types && (!Array.isArray(body.response_types) || body.response_types.some((r) => r !== 'code'))) throw new OAuthError('invalid_client_metadata', '只支持 response_type=code。');
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (grantTypes.includes('authorization_code')) {
      if (!redirectUris.length || redirectUris.length > 5) throw new OAuthError('invalid_redirect_uri', '需要 1 到 5 个 redirect_uris。');
      for (const uri of redirectUris) {
        if (!redirectTarget(uri, config)) throw new OAuthError('invalid_redirect_uri', '不接受这个回调地址：' + plain(uri, 120));
      }
    }
    const scope = body.scope ? scopesFrom(body.scope).join(' ') : config.scopes.join(' ');
    const record = {
      client_name: plain(body.client_name, 60) || 'AI 助手',
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
      client_id_issued_at: Math.floor(now() / 1000),
      ipHash: ip ? sha256('ip|' + ip).slice(0, 16) : '',
      // Unused registrations are cleaned up after 90 days; an authorization keeps the client in use.
      expiresAt: now() + 90 * 24 * 3600 * 1000
    };
    const clientId = randomId('xc_');
    await store.put(CLIENTS, clientId, record);
    const { ipHash, expiresAt, ...visible } = record;
    return { client_id: clientId, ...visible };
  }

  // ------------------------------------------------------------------ authorization code

  // Returns { redirect } to send the browser on, or { page } (an error the person sees; nothing is sent to the client).
  async function authorize(query, ip) {
    await limiter.hit('authorize_ip', ip || 'unknown');
    const c = await client(query.client_id);
    if (!c || !(c.grant_types || []).includes('authorization_code')) return { page: { status: 400, title: '连接没有开始', text: '这个连接请求来自未登记的程序，或登记已过期。请回到 AI 助手里重新连接。' } };
    let redirectUri = query.redirect_uri;
    if (!redirectUri && c.redirect_uris.length === 1) redirectUri = c.redirect_uris[0];
    const registered = c.redirect_uris.find((uri) => sameRedirect(uri, redirectUri));
    const target = registered && redirectTarget(redirectUri, config);
    if (!target) return { page: { status: 400, title: '连接没有开始', text: '连接请求里的返回地址和登记的不一致。请回到 AI 助手里重新连接。' } };
    const back = (error, description) => ({ redirect: withParams(redirectUri, { error, error_description: description, state: query.state, iss: config.issuer }) });
    if (query.response_type !== 'code') return back('unsupported_response_type', '只支持 response_type=code。');
    if (!query.code_challenge || query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)) return back('invalid_request', '需要 PKCE（code_challenge_method=S256）。');
    if (query.state !== undefined && String(query.state).length > 1024) return back('invalid_request', 'state 过长。');
    if (!resourceOk(query.resource)) return back('invalid_target', 'resource 不是这个服务。');
    const scope = scopesFrom(query.scope);
    const id = randomId('ar_', 24);
    await store.put(REQUESTS, id, {
      kind: 'code', status: 'pending', clientId: query.client_id, clientName: c.client_name, returnTo: target.text, redirectKind: target.kind,
      redirectUri, redirectUriGiven: !!query.redirect_uri, state: query.state === undefined ? null : String(query.state),
      codeChallenge: query.code_challenge, scope, resource: query.resource || config.resource, createdAt: now(), expiresAt: now() + config.requestTtlMs
    });
    await store.patch(CLIENTS, query.client_id, { expiresAt: now() + 90 * 24 * 3600 * 1000 }).catch(() => null);
    return { redirect: config.consentPage + encodeURIComponent(id) };
  }

  // ------------------------------------------------------------------ device authorization (RFC 8628)

  async function deviceAuthorization(body, ip) {
    await limiter.hit('device_all', 'all');
    await limiter.hit('device_ip', ip || 'unknown');
    const c = await client(body.client_id);
    if (!c || !(c.grant_types || []).includes(DEVICE_GRANT)) throw new OAuthError('invalid_client', '未登记的客户端。', 401);
    const scope = scopesFrom(body.scope);
    const deviceCode = randomToken(32);
    let userCode = '';
    for (let tries = 0; tries < 5 && !userCode; tries += 1) {
      const candidate = newUserCode();
      const existing = await store.get(USER_CODES, userCodeId(candidate));
      if (!existing || existing.expiresAt <= now()) userCode = candidate;
    }
    if (!userCode) throw new OAuthError('temporarily_unavailable', '暂时无法生成授权码，请稍后再试。', 503);
    const hint = plain(body.client_hint, 40);
    const expiresAt = now() + config.requestTtlMs;
    await store.put(REQUESTS, deviceRequestId(deviceCode), {
      kind: 'device', status: 'pending', clientId: body.client_id, clientName: c.client_name + (hint ? `（${hint}）` : ''), hinted: !!hint,
      returnTo: '用授权码连接的 AI 助手', scope, interval: config.deviceIntervalS, lastPollAt: 0, createdAt: now(), expiresAt
    });
    await store.put(USER_CODES, userCodeId(userCode), { requestId: deviceRequestId(deviceCode), expiresAt });
    const page = config.devicePage;
    return {
      device_code: deviceCode, user_code: userCode,
      verification_uri: page, verification_uri_complete: page + encodeURIComponent(userCode),
      expires_in: Math.round(config.requestTtlMs / 1000), interval: config.deviceIntervalS
    };
  }

  // ------------------------------------------------------------------ the site's consent page (person's own login)

  // The pending request a consent page refers to: { request: <authorize id> } or { code: <user code> }.
  async function pending(ref, who) {
    let id = null;
    if (ref && typeof ref.request === 'string' && /^ar_[\w-]{30,40}$/.test(ref.request)) id = ref.request;
    else if (ref && typeof ref.code === 'string' && normalizeUserCode(ref.code).length === 8) {
      const pointer = await store.get(USER_CODES, userCodeId(ref.code));
      if (pointer && pointer.expiresAt > now()) id = pointer.requestId;
    }
    const request = id ? await store.get(REQUESTS, id) : null;
    if (!request || request.status !== 'pending' || request.expiresAt <= now()) {
      if (ref?.code !== undefined) await limiter.hit('code_tries', who.accountKey);
      throw new ServiceError('REQUEST_NOT_FOUND', ref?.code !== undefined ? '授权码不正确或已过期。请回到 AI 助手里重新发起连接。' : '这个连接请求已过期或已处理。请回到 AI 助手里重新连接。');
    }
    return { id, request };
  }

  async function consentView(who, ref) {
    const { request } = await pending(ref, who);
    const membership = await site.membership(who.uid).catch(() => null);
    let plans = null;
    try { plans = site.plans ? await site.plans() : null; } catch { plans = null; }
    return {
      kind: request.kind,
      expiresAt: request.expiresAt,
      // A registered client's name, and an agent name a script adds, are what the program says about itself.
      client: { name: request.clientName, returnTo: request.returnTo, selfNamed: !(builtIn.get(request.clientId)?.builtIn) || !!request.hinted },
      // The account logged in on this browser is the one that gets connected; the page says how to switch.
      account: { phoneLabel: who.phoneLabel, switchHint: site.info?.switchAccount || '' },
      scopes: request.scope.map((id) => ({ id, text: SCOPES[id] })),
      ...(request.kind === 'device' ? { userCode: ref.code ? normalizeUserCode(ref.code).replace(/^(.{4})/, '$1-') : '' } : {}),
      disclosure: require('./disclosure.cjs').consentDisclosure({ config, site, membership, plans }),
      consentVersion: CONSENT_VERSION
    };
  }

  async function consentApprove(who, ref) {
    const { id } = await pending(ref, who);
    if ((await grants.activeFor(who.accountKey)).length >= config.maxGrantsPerAccount) {
      throw new ServiceError('TOO_MANY_CONNECTIONS', `这个账号已连接 ${config.maxGrantsPerAccount} 个 AI 助手。请先在「会员中心 → 已连接的 AI 助手」断开不用的，再回来允许。`);
    }
    return store.transaction(async (tx) => {
      const request = await tx.get(REQUESTS, id);
      if (!request || request.status !== 'pending' || request.expiresAt <= now()) throw new ServiceError('REQUEST_NOT_FOUND', '这个连接请求已过期或已处理。请回到 AI 助手里重新连接。');
      const approval = { uid: who.uid, accountKey: who.accountKey, bindingId: who.bindingId, phoneLabel: who.phoneLabel };
      if (request.kind === 'device') {
        await tx.put(REQUESTS, id, { ...request, status: 'approved', approvedAt: now(), approval });
        return { approved: true, kind: 'device', clientName: request.clientName };
      }
      const code = 'xxc_' + randomToken(32);
      await tx.put(CODES, codeId(code), { requestId: id, clientId: request.clientId, clientName: request.clientName, returnTo: request.returnTo,
        redirectUri: request.redirectUri, redirectUriGiven: request.redirectUriGiven, codeChallenge: request.codeChallenge, scope: request.scope,
        resource: request.resource, approval, used: false, createdAt: now(), expiresAt: now() + config.codeTtlMs });
      await tx.put(REQUESTS, id, { ...request, status: 'approved', approvedAt: now(), expiresAt: now() + config.codeTtlMs });
      return { approved: true, kind: 'code', clientName: request.clientName, redirectTo: withParams(request.redirectUri, { code, state: request.state, iss: config.issuer }) };
    });
  }

  async function consentDeny(who, ref) {
    let found;
    try { found = await pending(ref, who); } catch { return { denied: true }; }
    const { id, request } = found;
    await store.put(REQUESTS, id, { ...request, status: 'denied', deniedAt: now() });
    return request.kind === 'code'
      ? { denied: true, redirectTo: withParams(request.redirectUri, { error: 'access_denied', error_description: '用户没有允许连接。', state: request.state, iss: config.issuer }) }
      : { denied: true };
  }

  // ------------------------------------------------------------------ token endpoint

  async function token(body, ip) {
    await limiter.hit('token_ip', ip || 'unknown');
    const grantType = body.grant_type;
    const c = await client(body.client_id);
    if (!c) throw new OAuthError('invalid_client', '未登记的客户端。', 401);
    if (!GRANT_TYPES.includes(grantType)) throw new OAuthError('unsupported_grant_type', '不支持的 grant_type。');
    if (!(c.grant_types || []).includes(grantType)) throw new OAuthError('unauthorized_client', '这个客户端不能使用 ' + grantType + '。');
    if (!resourceOk(body.resource)) throw new OAuthError('invalid_target', 'resource 不是这个服务。');
    if (grantType === 'authorization_code') return exchangeCode(body);
    if (grantType === 'refresh_token') {
      const out = await grants.refresh({ refreshToken: body.refresh_token, clientId: body.client_id, scope: body.scope });
      if (out.error) throw new OAuthError(out.error, out.description);
      return out.tokens;
    }
    return pollDevice(body);
  }

  async function exchangeCode(body) {
    if (typeof body.code !== 'string' || !body.code.startsWith('xxc_')) throw new OAuthError('invalid_grant', '授权码无效。');
    const id = codeId(body.code);
    // Whether a token request carries everything the code is bound to: its client, redirect URI and PKCE verifier.
    const bound = (row) => row.clientId === body.client_id
      && !((row.redirectUriGiven || body.redirect_uri !== undefined) && row.redirectUri !== body.redirect_uri)
      && pkceMatches(body.code_verifier, row.codeChallenge);
    let replayed = null;
    const out = await store.transaction(async (tx) => {
      const row = await tx.get(CODES, id);
      if (!row) return { error: '授权码无效或已过期。' };
      if (row.used) {
        // OAuth 2.1 §4.1.3: a code presented twice is refused, and what it was exchanged for is revoked — but only when
        // the second request proves it holds the code's bindings. A copy of the code alone (another client, a wrong or
        // missing verifier) is refused and changes nothing, so it cannot be used to disconnect the rightful client.
        if (bound(row)) replayed = row.grantId || null;
        return { error: '授权码已经用过。' };
      }
      if (row.expiresAt <= now()) return { error: '授权码已过期，请重新连接。' };
      if (row.clientId !== body.client_id) return { error: '授权码不属于这个客户端。' };
      if ((row.redirectUriGiven || body.redirect_uri !== undefined) && row.redirectUri !== body.redirect_uri) return { error: 'redirect_uri 与授权请求不一致。' };
      if (!pkceMatches(body.code_verifier, row.codeChallenge)) return { error: 'PKCE 校验没有通过。' };
      if (body.resource && !resourceOk(body.resource)) return { error: 'resource 不一致。' };
      const grant = await grants.create(tx, { clientId: row.clientId, clientName: row.clientName, returnTo: row.returnTo, who: row.approval, scope: row.scope, consentVersion: CONSENT_VERSION });
      await tx.put(CODES, id, { ...row, used: true, approval: null, grantId: grant._id });
      return { grant, tokens: await grants.issueTokens(tx, grant, { scope: row.scope }) };
    });
    if (replayed) await grants.revoke(replayed, 'code_reuse');
    if (out.error) throw new OAuthError('invalid_grant', out.error);
    await grants.replaceOlder(out.grant);
    return out.tokens;
  }

  async function pollDevice(body) {
    if (typeof body.device_code !== 'string' || !/^[\w-]{40,64}$/.test(body.device_code)) throw new OAuthError('invalid_grant', 'device_code 无效。');
    const id = deviceRequestId(body.device_code);
    const out = await store.transaction(async (tx) => {
      const request = await tx.get(REQUESTS, id);
      if (!request || request.kind !== 'device' || request.clientId !== body.client_id) return { error: 'invalid_grant', text: 'device_code 无效。' };
      if (request.status === 'denied') return { error: 'access_denied', text: '用户没有允许连接。' };
      if (request.status === 'claimed') return { error: 'invalid_grant', text: '这个授权已经领取过。' };
      if (request.status === 'expired' || request.expiresAt <= now()) {
        await tx.put(REQUESTS, id, { ...request, status: 'expired', approval: null });
        return { error: 'expired_token', text: '授权码已过期，请重新连接。' };
      }
      if (request.status === 'pending') {
        const interval = request.interval || config.deviceIntervalS;
        if (now() - (request.lastPollAt || 0) < (interval - 1) * 1000) {
          await tx.put(REQUESTS, id, { ...request, interval: interval + 5, lastPollAt: now() });
          return { error: 'slow_down', text: '请放慢轮询。' };
        }
        await tx.put(REQUESTS, id, { ...request, lastPollAt: now() });
        return { error: 'authorization_pending', text: '等待用户在网站上允许。' };
      }
      if (request.status !== 'approved' || !request.approval) return { error: 'invalid_grant', text: 'device_code 无效。' };
      const grant = await grants.create(tx, { clientId: request.clientId, clientName: request.clientName, returnTo: request.returnTo, who: request.approval, scope: request.scope, consentVersion: CONSENT_VERSION });
      await tx.put(REQUESTS, id, { ...request, status: 'claimed', claimedAt: now(), approval: null, grantId: grant._id });
      return { tokens: await grants.issueTokens(tx, grant, { scope: request.scope }) };
    });
    if (out.error) throw new OAuthError(out.error, out.text);
    return out.tokens;
  }

  async function revoke(body) {
    await grants.revokeToken(body.token, body.client_id);
    return {};
  }

  return { authorizationServerMetadata, protectedResourceMetadata, register, authorize, deviceAuthorization, consentView, consentApprove, consentDeny, token, revoke, client };
}

function withParams(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url.href;
}

module.exports = { createOAuth, redirectTarget, sameRedirect, newUserCode, normalizeUserCode, CONSENT_VERSION, CLIENTS, REQUESTS, USER_CODES, CODES, DEVICE_GRANT };
