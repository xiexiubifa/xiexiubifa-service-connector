// Test helpers: a local server with the demo adapter, PKCE, and the steps a client and the site's page take.
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startDevServer } = require('../bin/dev-server.cjs');

// Short waits so tests do not sit through the production 20-second tool wait and minute-long leases.
export async function start(options = {}) {
  const env = await startDevServer({ quiet: true, stepDelayMs: 20, delays: { retry: [30, 30], stillRunning: 30, lease: 400, heartbeat: 100 }, ...options,
    config: { toolWaitMs: 1000, ...(options.config || {}) } });
  return { ...env, close: () => new Promise((resolve) => { env.server.closeAllConnections?.(); env.server.close(resolve); }) };
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const form = (data) => new URLSearchParams(Object.entries(data).filter(([, v]) => v !== undefined)).toString();

export async function post(url, body, { headers = {}, asForm = false } = {}) {
  const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': asForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: asForm ? form(body) : JSON.stringify(body) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}

export async function register(base, redirectUris = ['workbuddy://workbuddy/mcp/connector%3Axiexiubifa-writing/oauth/callback'], extra = {}) {
  const out = await post(base + '/oauth/register', { client_name: 'WorkBuddy', redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', ...extra });
  if (out.status !== 201) throw new Error('register failed: ' + JSON.stringify(out.data));
  return out.data;
}

// The person, logged in on the (demo) site: their verified identity as the site's page would pass it.
export async function person(env, phone = '13800001234') {
  const uid = env.adapter.demo.createAccount(phone);
  return { uid, ...(await env.adapter.identity(uid)) };
}

// authorize → consent page → approve → code → token, as WorkBuddy and the person would.
export async function connect(env, { phone = '13800001234', client, scope, resource } = {}) {
  const c = client || await register(env.base);
  const { verifier, challenge } = pkce();
  const redirectUri = c.redirect_uris[0];
  const params = { response_type: 'code', client_id: c.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-' + randomBytes(4).toString('hex'), scope: scope ?? 'write drafts:read account:read', resource: resource ?? env.base + '/mcp' };
  const auth = await fetch(env.base + '/oauth/authorize?' + form(params), { redirect: 'manual' });
  const location = auth.headers.get('location');
  const request = new URL(location).searchParams.get('connect');
  const who = await person(env, phone);
  const approved = await env.service.siteAction(who, 'consent_approve', { request });
  if (!approved.ok) throw new Error('approve failed: ' + JSON.stringify(approved));
  const back = new URL(approved.data.redirectTo);
  const token = await post(env.base + '/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirectUri, client_id: c.client_id, code_verifier: verifier, resource: params.resource }, { asForm: true });
  if (token.status !== 200) throw new Error('token failed: ' + JSON.stringify(token.data));
  return { client: c, tokens: token.data, who, state: params.state, back };
}

let rpcId = 0;
export async function rpc(env, token, method, params, { headers = {} } = {}) {
  const out = await post(env.base + '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) }, { headers: { accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers } });
  return out;
}

export async function tool(env, token, name, args = {}) {
  const out = await rpc(env, token, 'tools/call', { name, arguments: args }, { headers: { 'mcp-protocol-version': '2025-06-18' } });
  if (out.status !== 200) throw new Error(`tools/call ${name} → HTTP ${out.status} ${JSON.stringify(out.data)}`);
  if (out.data.error) throw new Error(`tools/call ${name} → ${JSON.stringify(out.data.error)}`);
  return out.data.result;
}

// Polls get_writing_result until the job leaves "running".
export async function finish(env, token, result, max = 40) {
  let current = result;
  for (let i = 0; i < max && current.structuredContent.status === 'running' && !current.structuredContent.stalled; i += 1) {
    current = await tool(env, token, 'get_writing_result', { job_id: current.structuredContent.job_id, wait_seconds: 2 });
  }
  return current;
}
