'use strict';
// Service settings. A deployment passes them in (or sets the XXB_* environment variables); the defaults are the
// documented production values and the limits the service enforces.
const DAY = 24 * 3600 * 1000;

const SCOPES = Object.freeze({
  write: '用你的会员权益写材料、改稿、润色（和在网站上写一样使用额度）',
  'drafts:read': '查看你在网站上的成稿记录，读取成稿和网站版式的 Word',
  'account:read': '查看你的会员等级和剩余额度'
});

const DEFAULTS = Object.freeze({
  issuer: 'https://mcp.xiexiubifa.cn',
  mcpPath: '/mcp',
  serviceName: '邪修笔法写作服务',
  serviceVersion: '3.0.1',
  consentPage: 'https://xiexiubifa.cn/?connect=',
  devicePage: 'https://xiexiubifa.cn/?connect_code=',
  termsUrl: '',
  accessTokenTtlMs: 3600 * 1000,
  refreshTokenTtlMs: 60 * DAY,
  grantIdleTtlMs: 180 * DAY,
  codeTtlMs: 10 * 60 * 1000,
  requestTtlMs: 10 * 60 * 1000,
  deviceIntervalS: 5,
  maxGrantsPerAccount: 10,
  // Redirect targets a registered client may use besides loopback addresses and app schemes (RFC 8252). An https
  // target sends the code to a web site, so only the ones listed here are accepted ("*" at the end matches a prefix).
  allowedHttpsRedirects: [],
  // Browser origins allowed to call /mcp (native clients send no Origin header). "*" allows any.
  allowedOrigins: [],
  toolWaitMs: 20000,
  identityRecheckMs: 10 * 60 * 1000,
  // cleared: what stays of a job sent with a request id after it is deleted or expires (no request, material or text).
  retention: { done: 7 * DAY, failed: 7 * DAY, blocked: 30 * DAY, cancelled: DAY, running: 2 * DAY, cleared: 30 * DAY },
  maxRunningJobsPerAccount: 2,
  limits: {
    register_ip: { windowMs: 3600 * 1000, max: 30 },
    authorize_ip: { windowMs: 60 * 1000, max: 30 },
    device_ip: { windowMs: 60 * 1000, max: 10 },
    device_all: { windowMs: 60 * 1000, max: 120 },
    token_ip: { windowMs: 60 * 1000, max: 120 },
    code_tries: { windowMs: 3600 * 1000, max: 20 },
    jobs_account: { windowMs: 3600 * 1000, max: 30 },
    calls_grant: { windowMs: 60 * 1000, max: 120 }
  },
  builtInClients: [{
    client_id: 'xiexiubifa-agent-skill',
    client_name: '邪修笔法写作技能（在其他 AI 助手里使用）',
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    redirect_uris: [],
    builtIn: true
  }]
});

const isLoopbackHost = (host) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);

function fromEnv(env = process.env) {
  const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = {};
  if (env.XXB_ISSUER) out.issuer = env.XXB_ISSUER;
  if (env.XXB_CONSENT_PAGE) out.consentPage = env.XXB_CONSENT_PAGE;
  if (env.XXB_DEVICE_PAGE) out.devicePage = env.XXB_DEVICE_PAGE;
  if (env.XXB_TERMS_URL) out.termsUrl = env.XXB_TERMS_URL;
  if (env.XXB_ALLOWED_HTTPS_REDIRECTS) out.allowedHttpsRedirects = list(env.XXB_ALLOWED_HTTPS_REDIRECTS);
  if (env.XXB_ALLOWED_ORIGINS) out.allowedOrigins = list(env.XXB_ALLOWED_ORIGINS);
  if (Number(env.XXB_TOOL_WAIT_MS) > 0) out.toolWaitMs = Math.min(25000, Number(env.XXB_TOOL_WAIT_MS));
  return out;
}

function makeConfig(options = {}) {
  const config = { ...DEFAULTS, ...options, limits: { ...DEFAULTS.limits, ...(options.limits || {}) }, retention: { ...DEFAULTS.retention, ...(options.retention || {}) } };
  const issuer = new URL(config.issuer);
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && isLoopbackHost(issuer.hostname))) {
    throw new Error('issuer must be an https URL (http is accepted only for 127.0.0.1/localhost during development)');
  }
  if (issuer.pathname !== '/' || issuer.search || issuer.hash) throw new Error('issuer must be an origin without a path');
  config.issuer = issuer.origin;
  config.resource = config.issuer + config.mcpPath;
  for (const key of ['consentPage', 'devicePage']) {
    const url = new URL(config[key]);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) throw new Error(key + ' must be https');
  }
  config.scopes = Object.keys(SCOPES);
  return Object.freeze(config);
}

module.exports = { makeConfig, fromEnv, DEFAULTS, SCOPES, isLoopbackHost };
