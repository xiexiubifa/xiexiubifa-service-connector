'use strict';
// MCP over streamable HTTP (one endpoint, JSON-RPC 2.0 in a POST, one JSON answer), without sessions: every request
// carries its own bearer token, so any instance can answer it. No server-initiated stream (GET answers 405).
const { ServiceError } = require('./util.cjs');

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];
const LATEST = SUPPORTED[0];

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const isRequest = (m) => m && typeof m === 'object' && m.jsonrpc === '2.0' && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const isNotification = (m) => m && typeof m === 'object' && m.jsonrpc === '2.0' && typeof m.method === 'string' && (m.id === undefined);

function createMcp({ config, tools, site }) {
  const instructions = `${config.serviceName}：用用户自己的${site.info.name}（${site.info.domain}）账号写中文材料、改稿、润色，成稿存进用户网站账号的成稿记录，按网站会员规则使用额度。`
    + '写作一般要几分钟：write_material 等返回 job_id 时，用 get_writing_result 取结果。没有成稿时，结果会说明原因、网站的提示和接着做的办法（continue_writing）。'
    + 'write_material、revise_draft、polish_text 可以带 request_id：没收到结果要重试同一个请求时用同一个 request_id，已经开始的任务会原样返回，不会重复写、不会重复使用额度。'
    + '账号、费用和数据保存的说明见 get_service_info。';

  async function handleMessage(message, caller) {
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'xiexiubifa-writing', title: config.serviceName, version: config.serviceVersion },
        instructions
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: tools.list() });
    if (method === 'tools/call') {
      if (!params || typeof params.name !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
      try {
        return rpcResult(id, await tools.call(params.name, params.arguments, caller));
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'UNKNOWN_TOOL') return rpcError(id, -32602, 'Unknown tool: ' + String(params.name).slice(0, 60));
        throw error; // INSUFFICIENT_SCOPE → HTTP 403 in the caller
      }
    }
    return rpcError(id, -32601, 'Method not found: ' + String(method).slice(0, 60));
  }

  // body: the parsed JSON. Returns { status, json? } (status 202 without a body for notifications and responses).
  async function handle(body, headers, caller) {
    const version = headers['mcp-protocol-version'];
    if (version && !SUPPORTED.includes(version)) return { status: 400, json: rpcError(null, -32600, 'Unsupported MCP-Protocol-Version: ' + String(version).slice(0, 20)) };
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length) return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
    const out = [];
    for (const message of messages) {
      if (isRequest(message)) out.push(await handleMessage(message, caller));
      else if (isNotification(message)) continue; // notifications/initialized, notifications/cancelled: nothing to do
      else if (message && typeof message === 'object' && message.jsonrpc === '2.0' && ('result' in message || 'error' in message)) continue;
      else out.push(rpcError(message?.id, -32600, 'Invalid Request'));
    }
    if (!out.length) return { status: 202 };
    return { status: 200, json: batch ? out : out[0] };
  }

  return { handle, SUPPORTED };
}

module.exports = { createMcp, SUPPORTED, LATEST, rpcError };
