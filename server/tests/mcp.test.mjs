// MCP over streamable HTTP: authentication challenge, version negotiation, JSON-RPC handling, tool listing and the
// honesty of what the tools declare about themselves.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, connect, rpc, post, tool } from './helpers.mjs';

let env, token;
before(async () => { env = await start(); token = (await connect(env, { phone: '13800001234' })).tokens.access_token; });
after(async () => { await env.close(); });

const init = (version) => ({ protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });

test('without a token: 401 with the protected-resource metadata and scopes (starts the client\'s OAuth flow)', async () => {
  const out = await rpc(env, null, 'initialize', init('2025-06-18'));
  assert.equal(out.status, 401);
  const challenge = out.headers.get('www-authenticate');
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, new RegExp(`resource_metadata="${env.base}/\\.well-known/oauth-protected-resource/mcp"`));
  assert.match(challenge, /scope="write drafts:read account:read"/);
  assert.doesNotMatch(challenge, /error=/, 'no error parameter when no token was sent (RFC 6750 §3.1)');
  const bad = await rpc(env, 'xxa_' + 'x'.repeat(43), 'initialize', init('2025-06-18'));
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.ok(/^[\x20-\x7e]*$/.test(bad.headers.get('www-authenticate')), 'header values stay ASCII');
  const get = await fetch(env.base + '/mcp');
  assert.equal(get.status, 401);
});

test('initialize negotiates 2025-11-25, 2025-06-18 and 2025-03-26; anything else gets the latest', async () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const out = await rpc(env, token, 'initialize', init(version));
    assert.equal(out.data.result.protocolVersion, version);
  }
  const old = await rpc(env, token, 'initialize', init('2024-11-05'));
  assert.equal(old.data.result.protocolVersion, '2025-11-25');
  const result = old.data.result;
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result.serverInfo.name, 'xiexiubifa-writing');
  assert.equal(result.serverInfo.version, '3.0.1');
  assert.match(result.instructions, /get_writing_result/);
  assert.equal(old.headers.get('mcp-session-id'), null, 'stateless: no session id');
});

test('transport rules: version header, notifications, methods, content type, parse errors, batches', async () => {
  const wrong = await rpc(env, token, 'ping', {}, { headers: { 'mcp-protocol-version': '1999-01-01' } });
  assert.equal(wrong.status, 400);
  const note = await post(env.base + '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(note.status, 202);
  assert.equal(note.data, null);
  const get = await fetch(env.base + '/mcp', { headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' } });
  assert.equal(get.status, 405, 'no server-initiated stream');
  const del = await fetch(env.base + '/mcp', { method: 'DELETE', headers: { authorization: 'Bearer ' + token } });
  assert.equal(del.status, 405);
  const text = await fetch(env.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(text.status, 415);
  const broken = await fetch(env.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{"jsonrpc":' });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, -32700);
  const unknown = await rpc(env, token, 'resources/list', {});
  assert.equal(unknown.data.error.code, -32601);
  const batch = await post(env.base + '/mcp', [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { headers: { authorization: 'Bearer ' + token } });
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.data.map((m) => m.id), [1, 2]);
});

test('browser origins: refused unless allowed; native clients send none', async () => {
  const refused = await rpc(env, token, 'ping', {}, { headers: { origin: 'https://evil.example' } });
  assert.equal(refused.status, 403);
  const open = await start({ config: { allowedOrigins: ['https://inspector.example'] } });
  try {
    const t = (await connect(open, { phone: '13800009876' })).tokens.access_token;
    const ok = await rpc(open, t, 'ping', {}, { headers: { origin: 'https://inspector.example' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://inspector.example');
  } finally { await open.close(); }
});

test('tools/list: stable names, input and output schemas, and annotations that say what each tool does', async () => {
  const { tools } = (await rpc(env, token, 'tools/list', {})).data.result;
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['write_material', 'get_writing_result', 'continue_writing', 'cancel_writing', 'revise_draft', 'polish_text', 'get_account_status', 'list_drafts', 'get_draft', 'get_word_file', 'list_document_types', 'get_service_info']);
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]{3,40}$/);
    assert.ok(t.title && t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(t.outputSchema.type, 'object', t.name);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    assert.equal(t.scope, undefined, 'internal fields are not listed');
  }
  const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
  for (const name of ['write_material', 'continue_writing', 'cancel_writing', 'revise_draft', 'polish_text']) assert.equal(ro[name], false, name + ' changes something and is not marked read-only');
  for (const name of ['get_writing_result', 'get_account_status', 'list_drafts', 'get_draft', 'get_word_file', 'list_document_types', 'get_service_info']) assert.equal(ro[name], true, name);
  assert.equal(tools.find((t) => t.name === 'cancel_writing').annotations.destructiveHint, true, 'deleting saved input is declared');
  for (const name of ['write_material', 'revise_draft', 'polish_text', 'continue_writing']) assert.match(tools.find((t) => t.name === name).description, /额度/, name + ' says it uses quota');
});

test('tools/call: unknown tool is a protocol error; bad arguments are a tool error the model can read', async () => {
  const unknown = await rpc(env, token, 'tools/call', { name: 'pay_membership', arguments: {} });
  assert.equal(unknown.data.error.code, -32602);
  for (const [name, args] of [['write_material', {}], ['write_material', { request: '写', words: 'many' }], ['write_material', { request: '写', extra: 1 }], ['get_writing_result', { job_id: '../etc' }], ['get_draft', { record_id: 'a b' }]]) {
    const result = await tool(env, token, name, args);
    assert.equal(result.isError, true, name + JSON.stringify(args));
    assert.equal(result.structuredContent.status, 'invalid_arguments');
  }
});

test('a connection without a scope gets 403 insufficient_scope for tools that need it', async () => {
  const narrow = (await connect(env, { phone: '13800004321', scope: 'write' })).tokens.access_token;
  const out = await rpc(env, narrow, 'tools/call', { name: 'get_account_status', arguments: {} });
  assert.equal(out.status, 403);
  assert.match(out.headers.get('www-authenticate'), /error="insufficient_scope"/);
  assert.equal((await tool(env, narrow, 'get_service_info')).isError, false, 'tools needing no scope still work');
});

test('service info and document types work without using quota', async () => {
  const info = await tool(env, token, 'get_service_info');
  assert.match(info.content[0].text, /费用/);
  assert.match(info.content[0].text, /断开/);
  const types = await tool(env, token, 'list_document_types');
  assert.equal(types.structuredContent.status, 'ok');
  assert.equal(env.adapter.demo.calls.length, 0, 'no paid step was sent');
});
