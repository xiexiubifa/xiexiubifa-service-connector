// The official MCP TypeScript SDK client (devDependency @modelcontextprotocol/sdk) against this server: discovery,
// dynamic registration, PKCE authorization through the site's consent page, the token exchange, tool calls, the
// silent refresh when an access token expires, and a fresh authorization after the person disconnects on the site.
// This is what an MCP host such as WorkBuddy does with its built-in OAuth client; WorkBuddy itself was not available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, person } from './helpers.mjs';

const WB = 'workbuddy://workbuddy/mcp/connector%3Axiexiubifa-writing/oauth/callback';
let sdk = null;
try {
  sdk = {
    ...(await import('@modelcontextprotocol/sdk/client/index.js')),
    ...(await import('@modelcontextprotocol/sdk/client/streamableHttp.js')),
    ...(await import('@modelcontextprotocol/sdk/client/auth.js'))
  };
} catch { /* not installed: npm install */ }

class Provider {
  constructor() { this.saved = {}; this.authorizationUrls = []; }
  get redirectUrl() { return WB; }
  get clientMetadata() { return { client_name: 'WorkBuddy', redirect_uris: [WB], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  state() { return 'sdk-state'; }
  clientInformation() { return this.saved.client; }
  saveClientInformation(info) { this.saved.client = info; }
  tokens() { return this.saved.tokens; }
  saveTokens(tokens) { this.saved.tokens = tokens; }
  redirectToAuthorization(url) { this.authorizationUrls.push(url); }
  saveCodeVerifier(verifier) { this.saved.verifier = verifier; }
  codeVerifier() { return this.saved.verifier; }
  invalidateCredentials(scope) { if (scope === 'all' || scope === 'tokens') delete this.saved.tokens; if (scope === 'all' || scope === 'client') delete this.saved.client; }
}

// The person's everyday browser: opens the authorization URL, lands on the site's consent page, presses 允许.
async function personApproves(env, url, who) {
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const consent = new URL(response.headers.get('location'));
  assert.equal(consent.pathname, '/demo-site/');
  const approved = await env.service.siteAction(who, 'consent_approve', { request: consent.searchParams.get('connect') });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const back = new URL(approved.data.redirectTo);
  assert.equal(back.searchParams.get('state'), 'sdk-state');
  return back.searchParams.get('code');
}

test('official MCP SDK client: OAuth (DCR + PKCE + consent), tools, refresh, and re-authorization after disconnect', { skip: sdk ? false : 'npm install (devDependency @modelcontextprotocol/sdk) to run' }, async () => {
  const env = await start();
  try {
    const mcpUrl = new URL(env.base + '/mcp');
    const provider = new Provider();
    const first = new sdk.Client({ name: 'sdk-conformance', version: '1.0.0' });
    await assert.rejects(first.connect(new sdk.StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })), sdk.UnauthorizedError, 'no token yet: the SDK starts authorization');
    assert.equal(provider.authorizationUrls.length, 1);
    const url = provider.authorizationUrls[0];
    assert.equal(url.origin + url.pathname, env.base + '/oauth/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), env.base + '/mcp');
    assert.equal(url.searchParams.get('scope'), 'write drafts:read account:read');
    assert.match(provider.saved.client.client_id, /^xc_/, 'registered dynamically');
    const who = await person(env, '13800001234');
    const transport = new sdk.StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await transport.finishAuth(await personApproves(env, url, who));
    assert.match(provider.saved.tokens.access_token, /^xxa_/);
    const client = new sdk.Client({ name: 'sdk-conformance', version: '1.0.0' });
    await client.connect(new sdk.StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    assert.equal(client.getServerVersion().name, 'xiexiubifa-writing');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    let result = await client.callTool({ name: 'write_material', arguments: { request: '帮我写一份街道冬季安全生产工作方案，1500字左右' } });
    for (let i = 0; i < 20 && result.structuredContent.status === 'running'; i += 1) {
      result = await client.callTool({ name: 'get_writing_result', arguments: { job_id: result.structuredContent.job_id, wait_seconds: 1 } });
    }
    assert.equal(result.structuredContent.status, 'done', JSON.stringify(result.structuredContent));
    assert.ok(result.content[0].text.includes(result.structuredContent.draft.text));
    // The access token expires: the SDK refreshes it with the refresh token, without the person.
    const oldRefresh = provider.saved.tokens.refresh_token;
    for (const [id, row] of env.store._tables.get('xxb_tokens')) if (row.type === 'access') env.store._tables.get('xxb_tokens').set(id, { ...row, expiresAt: Date.now() - 1 });
    const fresh = new sdk.Client({ name: 'sdk-conformance', version: '1.0.0' });
    await fresh.connect(new sdk.StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    const status = await fresh.callTool({ name: 'get_account_status', arguments: {} });
    assert.equal(status.structuredContent.status, 'ok');
    assert.notEqual(provider.saved.tokens.refresh_token, oldRefresh, 'refreshed and rotated');
    assert.equal(provider.authorizationUrls.length, 1, 'no new authorization was needed');
    // The person disconnects on the site: the next connection needs their approval again.
    const listed = await env.service.siteAction(who, 'connections_list', {});
    await env.service.siteAction(who, 'connection_revoke', { id: listed.data.items[0].id });
    const after = new sdk.Client({ name: 'sdk-conformance', version: '1.0.0' });
    await assert.rejects(after.connect(new sdk.StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })), sdk.UnauthorizedError);
    assert.equal(provider.authorizationUrls.length, 2, 'a new authorization (browser) was started');
  } finally {
    await env.close();
  }
});
