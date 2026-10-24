'use strict';
// node:http glue: turns an IncomingMessage into the service's request shape and writes its response.
const MAX_BODY = 2 * 1024 * 1024 + 1024;

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 'PAYLOAD_TOO_LARGE' })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toRequest(req, body, { trustProxy = false } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const query = {};
  for (const [key, value] of url.searchParams) if (!(key in query)) query[key] = value;
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return { method: req.method, path: url.pathname, query, search: url.search, headers: req.headers, body, ip: forwarded || req.socket.remoteAddress || '' };
}

function send(res, out) {
  res.writeHead(out.status, out.headers || {});
  res.end(out.body ?? '');
}

// before(request) may answer routes of its own (returns a response) or leave them to the service (returns null).
function createNodeHandler(service, { before, trustProxy } = {}) {
  return async (req, res) => {
    let body;
    try { body = await readBody(req); } catch { send(res, { status: 413, headers: { 'content-type': 'application/json' }, body: '{"error":"payload_too_large"}' }); return; }
    const request = toRequest(req, body, { trustProxy });
    try {
      const own = before ? await before(request) : null;
      send(res, own || await service.handleHttp(request));
    } catch (error) {
      console.error('[http]', error?.name || 'Error');
      send(res, { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"server_error"}' });
    }
  };
}

module.exports = { readBody, toRequest, send, createNodeHandler };
