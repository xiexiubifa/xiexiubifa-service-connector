#!/usr/bin/env node
'use strict';
// Local development server: the writing service with the DEMO site adapter and the demo site pages.
//
//   node bin/dev-server.cjs [--port 8787] [--data .local/dev-store.json] [--step-delay 300] [--device-interval 5]
//                           [--device-limit 10]   device codes per minute from one address (tests start many)
//
// MCP endpoint http://127.0.0.1:<port>/mcp (OAuth discovery, registration and the consent page all work locally;
// the consent page is the demo site's). Nothing here talks to xiexiubifa.cn.
const http = require('node:http');
const { createWritingService } = require('../src/service.cjs');
const { createMemoryStore } = require('../src/store-memory.cjs');
const { createFileStore } = require('../src/store-file.cjs');
const { createNodeHandler } = require('../src/node-http.cjs');
const { createDemoAdapter } = require('../demo/demo-adapter.cjs');
const { createDemoSite } = require('../demo/demo-site.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function startDevServer({ port = 0, host = '127.0.0.1', data = '', stepDelayMs = 300, quiet = false, limits, delays, config = {} } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(port, host, () => {
      const base = `http://${host}:${server.address().port}`;
      const store = data ? createFileStore(data) : createMemoryStore();
      const adapter = createDemoAdapter({ baseUrl: base, stepDelayMs });
      const service = createWritingService({ store, site: adapter, delays, config: {
        issuer: base, consentPage: base + '/demo-site/?connect=', devicePage: base + '/demo-site/?connect_code=', termsUrl: '', ...(limits ? { limits } : {}), ...config
      } });
      const site = createDemoSite({ service, adapter, baseUrl: base });
      server.on('request', createNodeHandler(service, { before: (req) => site.handle(req) }));
      service.sweep().catch(() => {});
      const timer = setInterval(() => { service.sweep().catch(() => {}); service.purge().catch(() => {}); }, 60 * 1000);
      timer.unref();
      server.on('close', () => clearInterval(timer));
      if (!quiet) {
        console.log(`邪修笔法写作服务（本地演示）已启动：
  MCP 端点      ${base}/mcp
  演示站        ${base}/demo-site/
  OAuth 元数据  ${base}/.well-known/oauth-authorization-server
这是演示适配器：账号、额度和稿件都是本地假数据，不连接 xiexiubifa.cn。`);
      }
      resolve({ server, base, service, adapter, store });
    });
  });
}

if (require.main === module) {
  const interval = arg('--device-interval', '');
  const deviceLimit = Number(arg('--device-limit', '')) || 0;
  startDevServer({ port: Number(arg('--port', 8787)), data: arg('--data', ''), stepDelayMs: Number(arg('--step-delay', 300)),
    config: interval ? { deviceIntervalS: Number(interval) } : {}, limits: deviceLimit ? { device_ip: { windowMs: 60 * 1000, max: deviceLimit } } : undefined });
}

module.exports = { startDevServer };
