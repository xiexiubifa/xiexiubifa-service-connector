'use strict';
// Fixed-window counters for actions that are open before an account is known (client registration, authorization,
// device codes, token requests), for guessing at codes, and for runaway use of one connection. A counter row holds
// only the rule, the window and the count; keys (addresses, accounts) are stored hashed.
const { sha256, ServiceError } = require('./util.cjs');

const COLLECTION = 'xxb_limits';
const MESSAGES = {
  code_tries: '授权码输错次数过多，请一小时后再试。',
  jobs_account: '这个账号最近一小时开始的写作太多了，请稍后再试。',
  calls_grant: '请求太频繁，请稍后再试。'
};

function createLimiter(store, rules) {
  // Counts one use of `rule` for `key`; throws a RATE_LIMITED ServiceError once the window is full.
  async function hit(rule, key = 'all', now = Date.now()) {
    const { windowMs, max } = rules[rule];
    const slot = Math.floor(now / windowMs);
    const id = 'lim_' + sha256(rule + '|' + key).slice(0, 40);
    await store.transaction(async (tx) => {
      const row = await tx.get(COLLECTION, id);
      const count = row?.slot === slot ? Number(row.count) || 0 : 0;
      if (count >= max) throw new ServiceError('RATE_LIMITED', MESSAGES[rule] || '请求太频繁，请稍后再试。', { retryAfterS: Math.ceil(((slot + 1) * windowMs - now) / 1000) });
      await tx.put(COLLECTION, id, { rule, slot, count: count + 1, expiresAt: (slot + 2) * windowMs });
    });
  }
  return { hit };
}

module.exports = { createLimiter, LIMITS_COLLECTION: COLLECTION };
