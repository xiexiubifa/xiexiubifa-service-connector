'use strict';
// Connections ("grants") and their tokens.
//
// A connection says: this person, logged in on the site, allowed this client to use their account for these scopes.
// It holds the site user id the writing runs as (server-side only) and a masked phone for display. Tokens are opaque
// random strings; only their SHA-256 is stored. Access tokens live an hour; refresh tokens are rotated on every use, and
// a refresh token used again after its replacement was issued closes the whole connection (OAuth 2.1 §4.3.1).
// The person can close a connection on the site at any time; it then stops working at once.
const { sha256, randomToken, randomId, ServiceError } = require('./util.cjs');

const GRANTS = 'xxb_grants';
const TOKENS = 'xxb_tokens';
const ACCESS_PREFIX = 'xxa_';
const REFRESH_PREFIX = 'xxr_';
const REUSE_GRACE_MS = 60 * 1000;
const TOUCH_EVERY_MS = 3600 * 1000;

const tokenId = (token) => (token.startsWith(REFRESH_PREFIX) ? 'rt_' : 'at_') + sha256(token).slice(0, 48);

// Which account a connection is for, as a client may keep it: the masked phone the person saw on the consent page, and
// an opaque reference to compare accounts with (a hash of the service's own account key; it reveals no phone number).
const accountRef = (accountKey) => 'acct_' + sha256('account-ref|' + accountKey).slice(0, 24);

function createGrants({ store, config, now = () => Date.now() }) {
  // Token responses also say which account was connected (RFC 6749 §5.1 lets clients ignore fields they do not know).
  async function issueTokens(tx, grant, { scope }) {
    const t = now();
    const access = ACCESS_PREFIX + randomToken(32);
    const refresh = REFRESH_PREFIX + randomToken(32);
    await tx.put(TOKENS, tokenId(access), { type: 'access', grantId: grant._id, clientId: grant.clientId, scope, createdAt: t, expiresAt: t + config.accessTokenTtlMs });
    await tx.put(TOKENS, tokenId(refresh), { type: 'refresh', grantId: grant._id, clientId: grant.clientId, scope, createdAt: t, expiresAt: t + config.refreshTokenTtlMs });
    return { access_token: access, token_type: 'Bearer', expires_in: Math.round(config.accessTokenTtlMs / 1000), refresh_token: refresh, scope: scope.join(' '),
      account_label: grant.phoneLabel || '', account_ref: accountRef(grant.accountKey) };
  }

  async function activeFor(accountKey) {
    return store.find(GRANTS, { accountKey, status: 'active' }, { limit: 200 });
  }

  // A new connection from an approved request. A newer connection of the same registered client replaces the older one.
  async function create(tx, { clientId, clientName, returnTo, who, scope, consentVersion }) {
    const t = now();
    const grant = { status: 'active', clientId, clientName, returnTo, uid: who.uid, accountKey: who.accountKey, bindingId: who.bindingId,
      phoneLabel: who.phoneLabel, scope, consentVersion, createdAt: t, lastUsedAt: t, verifiedAt: t, expiresAt: t + config.grantIdleTtlMs };
    return tx.put(GRANTS, randomId('cg_'), grant);
  }

  async function replaceOlder(grant) {
    const older = (await activeFor(grant.accountKey)).filter((g) => g.clientId === grant.clientId && g._id !== grant._id);
    for (const g of older) await revoke(g._id, 'replaced');
  }

  async function revoke(grantId, by) {
    const t = now();
    const grant = await store.patch(GRANTS, grantId, { status: 'revoked', revokedAt: t, revokedBy: by, uid: '', expiresAt: t + 30 * 24 * 3600 * 1000 });
    // Its tokens go with it.
    for (const row of await store.find(TOKENS, { grantId }, { limit: 500 })) await store.remove(TOKENS, row._id);
    return grant;
  }

  // The connection an access token stands for: { grant, scope } or a ServiceError the HTTP layer turns into 401.
  async function checkAccess(token) {
    if (typeof token !== 'string' || !token.startsWith(ACCESS_PREFIX) || !/^[\w-]{40,80}$/.test(token)) throw new ServiceError('INVALID_TOKEN', '没有有效的连接凭据。');
    const row = await store.get(TOKENS, tokenId(token));
    if (!row || row.type !== 'access') throw new ServiceError('INVALID_TOKEN', '连接凭据无效或已被撤销，请重新连接邪修笔法账号。');
    if (row.expiresAt <= now()) throw new ServiceError('INVALID_TOKEN', '连接凭据已过期。');
    const grant = await store.get(GRANTS, row.grantId);
    if (!grant || grant.status !== 'active') throw new ServiceError('INVALID_TOKEN', '这个连接已断开（可能在网站会员中心断开过），请重新连接邪修笔法账号。');
    if (now() - (grant.lastUsedAt || grant.createdAt) > config.grantIdleTtlMs) {
      await revoke(grant._id, 'idle');
      throw new ServiceError('INVALID_TOKEN', '这个连接很久没有使用，已自动断开，请重新连接邪修笔法账号。');
    }
    if (now() - (grant.lastUsedAt || 0) > TOUCH_EVERY_MS) {
      await store.patch(GRANTS, grant._id, { lastUsedAt: now(), expiresAt: now() + config.grantIdleTtlMs });
    }
    return { grant, scope: row.scope };
  }

  // refresh_token grant: rotation with reuse detection.
  async function refresh({ refreshToken, clientId, scope }) {
    if (typeof refreshToken !== 'string' || !refreshToken.startsWith(REFRESH_PREFIX)) return { error: 'invalid_grant', description: 'refresh_token 无效。' };
    const id = tokenId(refreshToken);
    let reused = null;
    const out = await store.transaction(async (tx) => {
      const row = await tx.get(TOKENS, id);
      if (!row || row.type !== 'refresh') return { error: 'invalid_grant', description: 'refresh_token 无效或连接已断开。' };
      if (row.clientId !== clientId) return { error: 'invalid_grant', description: 'refresh_token 不属于这个客户端。' };
      if (row.rotatedAt) {
        if (now() - row.rotatedAt > REUSE_GRACE_MS) reused = row.grantId;
        return { error: 'invalid_grant', description: 'refresh_token 已经用过。' };
      }
      if (row.expiresAt <= now()) return { error: 'invalid_grant', description: '连接已过期，请重新连接。' };
      const grant = await tx.get(GRANTS, row.grantId);
      if (!grant || grant.status !== 'active') return { error: 'invalid_grant', description: '这个连接已断开，请重新连接。' };
      const wanted = scope ? scope.split(' ').filter(Boolean) : row.scope;
      if (wanted.some((s) => !row.scope.includes(s))) return { error: 'invalid_scope', description: '不能扩大连接的范围。' };
      await tx.patch(TOKENS, id, { rotatedAt: now() });
      await tx.patch(GRANTS, grant._id, { lastUsedAt: now(), expiresAt: now() + config.grantIdleTtlMs });
      return { tokens: await issueTokens(tx, grant, { scope: wanted }) };
    });
    if (reused) await revoke(reused, 'refresh_reuse');
    return out;
  }

  // RFC 7009: a refresh token closes the connection; an access token is removed alone. Unknown tokens are ignored.
  async function revokeToken(token, clientId) {
    if (typeof token !== 'string' || !/^xx[ar]_[\w-]{40,80}$/.test(token)) return;
    const row = await store.get(TOKENS, tokenId(token));
    if (!row || (clientId && row.clientId !== clientId)) return;
    if (row.type === 'refresh') await revoke(row.grantId, 'client');
    else await store.remove(TOKENS, tokenId(token));
  }

  async function list(accountKey) {
    return (await activeFor(accountKey)).sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ id: g._id, clientName: g.clientName, returnTo: g.returnTo, scope: g.scope, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt }));
  }

  async function revokeOwn(accountKey, grantId) {
    if (typeof grantId !== 'string' || !/^cg_[\w-]{20,40}$/.test(grantId)) throw new ServiceError('BAD_INPUT', '连接编号不正确。');
    const grant = await store.get(GRANTS, grantId);
    if (!grant || grant.accountKey !== accountKey) throw new ServiceError('NOT_FOUND', '没有找到这个连接。');
    if (grant.status === 'active') await revoke(grantId, 'person');
    return { revoked: true };
  }

  return { issueTokens, create, replaceOlder, revoke, checkAccess, refresh, revokeToken, list, revokeOwn, activeFor };
}

module.exports = { createGrants, accountRef, GRANTS, TOKENS, tokenId, ACCESS_PREFIX, REFRESH_PREFIX };
