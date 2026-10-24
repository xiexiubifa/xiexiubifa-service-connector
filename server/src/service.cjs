'use strict';
// 邪修笔法写作服务 — composition and HTTP routing.
//
//   const service = createWritingService({ config, store, site, runner, dispatch });
//   service.handleHttp(request)          → { status, headers, body }   (MCP endpoint, OAuth endpoints, metadata)
//   service.siteAction(who, action, p)   → { ok, data | code, message } (the site's consent page and connection list,
//                                           called with the person's own site login; `who` is verified by the deployment)
//   service.runJob(jobId)                → runs a writing job (for deployments that dispatch jobs to a separate run)
//   service.sweep() / service.purge()    → pick up interrupted jobs / delete expired data (start-up and a timer)
//
// `site` is the adapter to the writing site (see docs/adapter.md): identity, membership, the site's writing flow as
// resumable steps, drafts and Word files. It is the only part that knows the site; everything here is generic.
// request: { method, path, query, headers (lower-case names), body (string|Buffer), ip }.
const { makeConfig, fromEnv } = require('./config.cjs');
const { createLimiter, LIMITS_COLLECTION } = require('./limits.cjs');
const { createGrants, GRANTS, TOKENS } = require('./grants.cjs');
const { createOAuth, CLIENTS, REQUESTS, USER_CODES, CODES } = require('./oauth.cjs');
const { createJobs } = require('./jobs.cjs');
const { createTools } = require('./tools.cjs');
const { createMcp } = require('./mcp.cjs');
const { ServiceError, OAuthError } = require('./util.cjs');

const MAX_BODY = 2 * 1024 * 1024;
const PURGE_EVERY_MS = 10 * 60 * 1000;
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const OPEN_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-max-age': '600' };

const json = (status, data, headers = {}) => ({ status, headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(data) });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (status, { title, text }) => ({
  status,
  headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'x-frame-options': 'DENY' },
  body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px/1.7 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 20px;color:#222"><h1 style="font-size:1.3em">${esc(title)}</h1><p>${esc(text)}</p></body></html>`
});

function parseBody(req) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  if (raw.length > MAX_BODY) throw new ServiceError('PAYLOAD_TOO_LARGE', '请求内容过大。');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new OAuthError('invalid_request', '请求内容不是有效的 JSON 或表单。');
  }
}

// Some OAuth libraries send the client id in HTTP Basic authentication even for public clients; the body wins.
function withClientId(body, headers) {
  if (body.client_id) return body;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(headers.authorization || '');
  if (!basic) return body;
  try {
    const id = decodeURIComponent(Buffer.from(basic[1], 'base64').toString('utf8').split(':')[0]);
    return id ? { ...body, client_id: id } : body;
  } catch {
    return body;
  }
}

function createWritingService({ config: options = {}, store, site, runner = 'inline', dispatch, now = () => Date.now(), delays } = {}) {
  if (!store || !site) throw new Error('createWritingService needs a store and a site adapter');
  const config = makeConfig({ ...fromEnv(), ...options });
  const limiter = createLimiter(store, config.limits);
  const grants = createGrants({ store, config, now });
  const oauth = createOAuth({ config, store, limiter, grants, site, now });
  const jobs = createJobs({ store, site, config, limiter, now, runner, dispatch, delays });
  const tools = createTools({ config, site, jobs });
  const mcp = createMcp({ config, tools, site });
  const prmUrl = config.issuer + '/.well-known/oauth-protected-resource' + config.mcpPath;
  let lastPurge = 0;

  // ------------------------------------------------------------------ bearer authentication for /mcp

  function unauthorized(error) {
    const parts = [`resource_metadata="${prmUrl}"`, `scope="${config.scopes.join(' ')}"`];
    if (error) parts.unshift('error="invalid_token"', 'error_description="The access token is missing, expired or revoked"');
    return json(401, { error: 'invalid_token', error_description: error?.message || '需要先连接邪修笔法账号。' }, { 'www-authenticate': 'Bearer ' + parts.join(', ') });
  }

  // The site still knows this account by the same verified phone; otherwise the connection is closed.
  async function recheckIdentity(grant) {
    if (now() - (grant.verifiedAt || 0) < config.identityRecheckMs) return;
    let who;
    try {
      who = await site.identity(grant.uid);
    } catch (error) {
      if (error?.code === 'MEMBER_LOGIN_REQUIRED') {
        await grants.revoke(grant._id, 'login_lost');
        throw new ServiceError('INVALID_TOKEN', '网站不再确认这个账号的手机号登录，连接已断开，请重新连接。');
      }
      return; // could not check now; the site checks the account again on every call anyway
    }
    if (who.bindingId !== grant.bindingId) {
      await grants.revoke(grant._id, 'phone_changed');
      throw new ServiceError('INVALID_TOKEN', '账号的手机号已变化，这个连接已断开，请重新连接。');
    }
    await store.patch(GRANTS, grant._id, { verifiedAt: now() });
  }

  async function authenticate(headers) {
    const match = /^Bearer\s+(\S+)$/i.exec(headers.authorization || '');
    if (!match) return { response: unauthorized(null) };
    try {
      const caller = await grants.checkAccess(match[1]);
      await recheckIdentity(caller.grant);
      await limiter.hit('calls_grant', caller.grant._id);
      return { caller };
    } catch (error) {
      if (error.code === 'INVALID_TOKEN') return { response: unauthorized(error) };
      throw error;
    }
  }

  function originAllowed(origin) {
    if (!origin) return true;
    return config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin);
  }

  async function mcpHttp(req) {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return json(403, { error: 'origin_not_allowed', error_description: '不接受来自这个网页的请求。' });
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'www-authenticate' } : {};
    const auth = await authenticate(req.headers);
    if (auth.response) return { ...auth.response, headers: { ...auth.response.headers, ...cors } };
    if (req.method !== 'POST') return { ...json(405, { error: 'method_not_allowed', error_description: '这个端点只接受 POST。' }, { allow: 'POST', ...cors }) };
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return json(415, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Content-Type must be application/json' } }, cors);
    let body;
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      if (raw.length > MAX_BODY) return json(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }, cors);
      body = JSON.parse(raw);
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors);
    }
    try {
      const out = await mcp.handle(body, req.headers, auth.caller);
      if (out.status === 202) return { status: 202, headers: { ...BASE_HEADERS, ...cors }, body: '' };
      return json(out.status, out.json, cors);
    } catch (error) {
      if (error.code === 'INSUFFICIENT_SCOPE') {
        return json(403, { error: 'insufficient_scope', error_description: error.message },
          { 'www-authenticate': `Bearer error="insufficient_scope", scope="${config.scopes.join(' ')}", resource_metadata="${prmUrl}", error_description="The connection does not include this permission"`, ...cors });
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ routing

  async function handleHttp(req) {
    maybePurge();
    const path = (req.path || '/').replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();
    const headers = req.headers || {};
    const request = { ...req, method, path, headers, query: req.query || {} };
    try {
      if (path === config.mcpPath) {
        if (method === 'OPTIONS') return { status: 204, headers: originAllowed(headers.origin) && headers.origin ? { 'access-control-allow-origin': headers.origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id', 'access-control-expose-headers': 'www-authenticate', 'access-control-max-age': '600' } : {}, body: '' };
        return await mcpHttp(request);
      }
      if (method === 'OPTIONS') return { status: 204, headers: OPEN_CORS, body: '' };
      if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource' + config.mcpPath)) return json(200, oauth.protectedResourceMetadata(), OPEN_CORS);
      if (method === 'GET' && path === '/.well-known/oauth-authorization-server') return json(200, oauth.authorizationServerMetadata(), OPEN_CORS);
      if (method === 'POST' && path === '/oauth/register') return json(201, await oauth.register(parseBody(request), req.ip), OPEN_CORS);
      if (method === 'GET' && path === '/oauth/authorize') {
        const out = await oauth.authorize(request.query, req.ip);
        if (out.page) return html(out.page.status, out.page);
        return { status: 302, headers: { ...BASE_HEADERS, location: out.redirect }, body: '' };
      }
      if (method === 'POST' && path === '/oauth/token') return json(200, await oauth.token(withClientId(parseBody(request), headers), req.ip), { ...OPEN_CORS, pragma: 'no-cache' });
      if (method === 'POST' && path === '/oauth/device_authorization') return json(200, await oauth.deviceAuthorization(withClientId(parseBody(request), headers), req.ip), OPEN_CORS);
      if (method === 'POST' && path === '/oauth/revoke') return json(200, await oauth.revoke(withClientId(parseBody(request), headers)), OPEN_CORS);
      if (method === 'GET' && path === '/health') return json(200, { ok: true, service: 'xiexiubifa-writing', version: config.serviceVersion });
      if (method === 'GET' && path === '/') return json(200, { name: config.serviceName, version: config.serviceVersion, mcp: config.resource, ...(config.termsUrl ? { documentation: config.termsUrl } : {}) });
      return json(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof OAuthError) return json(error.status, { error: error.error, error_description: error.message }, OPEN_CORS);
      if (error instanceof ServiceError) {
        if (error.code === 'RATE_LIMITED') return json(429, { error: 'rate_limited', error_description: error.message }, { 'retry-after': String(error.details?.retryAfterS || 60), ...OPEN_CORS });
        if (error.code === 'PAYLOAD_TOO_LARGE') return json(413, { error: 'payload_too_large', error_description: error.message });
        return json(400, { error: error.code.toLowerCase(), error_description: error.message });
      }
      console.error('[service]', path, error?.name || 'Error', String(error?.code || '').slice(0, 40));
      return json(500, { error: 'server_error', error_description: '写作服务暂时没有响应，请稍后再试。' });
    }
  }

  // ------------------------------------------------------------------ the site's own pages (person's site login)

  async function siteAction(who, action, payload = {}) {
    try {
      if (!who || !who.uid || !who.accountKey) throw new ServiceError('LOGIN_REQUIRED', '请先在网站上用手机号登录。');
      const p = payload && typeof payload === 'object' ? payload : {};
      const ref = typeof p.request === 'string' ? { request: p.request } : p.code !== undefined ? { code: String(p.code) } : {};
      if (action === 'consent_view') return { ok: true, data: await oauth.consentView(who, ref) };
      if (action === 'consent_approve') return { ok: true, data: await oauth.consentApprove(who, ref) };
      if (action === 'consent_deny') return { ok: true, data: await oauth.consentDeny(who, ref) };
      if (action === 'connections_list') return { ok: true, data: { items: await grants.list(who.accountKey) } };
      if (action === 'connection_revoke') return { ok: true, data: await grants.revokeOwn(who.accountKey, p.id) };
      throw new ServiceError('BAD_INPUT', '不支持的操作。');
    } catch (error) {
      if (error instanceof ServiceError) return { ok: false, code: error.code, message: error.message };
      console.error('[site-action]', action, error?.name || 'Error');
      return { ok: false, code: 'SERVER_ERROR', message: '暂时没有完成，请稍后再试。' };
    }
  }

  // ------------------------------------------------------------------ housekeeping

  async function purge() {
    let removed = 0;
    for (const collection of [LIMITS_COLLECTION, REQUESTS, USER_CODES, CODES, TOKENS, CLIENTS, GRANTS]) {
      for (const row of await store.expired(collection, now(), 100)) {
        if (collection === GRANTS && row.status === 'active') { await grants.revoke(row._id, 'idle'); continue; }
        await store.remove(collection, row._id);
        removed += 1;
      }
    }
    return removed + await jobs.purge(100);
  }

  function maybePurge() {
    if (now() - lastPurge < PURGE_EVERY_MS) return;
    lastPurge = now();
    purge().catch(() => {});
  }

  return { config, handleHttp, siteAction, runJob: jobs.runJob, sweep: jobs.sweep, purge, _parts: { oauth, grants, jobs, tools, mcp, limiter } };
}

module.exports = { createWritingService };
