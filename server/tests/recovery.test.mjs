// Recovery without paid work done twice: overlapping continue requests, the same request sent again after its answer
// was lost (request_id), late retries after a job was deleted or expired, and answers that name the connected account
// (a person whose browser is logged into another account can tell) or say plainly when an outcome is open.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { start, connect, tool, finish } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createJobs } = require('../src/jobs.cjs');
const { createMemoryStore } = require('../src/store-memory.cjs');
const { makeConfig } = require('../src/config.cjs');
const { GRANTS } = require('../src/grants.cjs');
const { createDemoAdapter } = require('../demo/demo-adapter.cjs');

let env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const sent = (uid, step) => env.adapter.demo.calls.filter((c) => c.uid === uid && (!step || c.step === step));
const jobRow = (id) => env.store._tables.get('xxb_jobs').get(id);
async function account(phone) {
  const { tokens, who } = await connect(env, { phone });
  return { token: tokens.access_token, uid: who.uid, who };
}
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
};

// The jobs module on its own with the demo site, for interleavings the HTTP layer cannot force.
async function bench(phone) {
  const store = createMemoryStore(), config = makeConfig(), site = createDemoAdapter({ stepDelayMs: 0 });
  const uid = site.demo.createAccount(phone);
  const who = await site.identity(uid);
  const grant = await store.put(GRANTS, 'cg_bench_' + phone + '_000000000', { uid, accountKey: who.accountKey, bindingId: who.bindingId, phoneLabel: who.phoneLabel, status: 'active' });
  const jobs = createJobs({ store, site, config, limiter: { hit: async () => {} }, delays: { retry: [1, 1], stillRunning: 1 } });
  return { site, uid, caller: { grant, scope: ['write'] }, jobs };
}
const steps = (site, step) => site.demo.calls.filter((c) => c.step === step).length;

test('two overlapping continue_writing calls after a membership stop: one restart, every paid step sent once', async () => {
  const { site, uid, caller, jobs } = await bench('13700000001');
  site.demo.endTrial(uid);
  const blocked = await jobs.start(caller, 'write', { request: '帮我写一份年终工作总结' }, { waitMs: 0 });
  assert.equal(blocked.state, 'blocked');
  site.demo.activateMembership(uid);
  // The second call has read the job and waits in the site's membership check until the first call's runner has sent
  // 基础设定: the interleaving that sent (and charged) it twice in 3.0.0.
  let stepSent, runnerGoesOn;
  const firstStepSent = new Promise((r) => { stepSent = r; });
  const runnerMayGoOn = new Promise((r) => { runnerGoesOn = r; });
  const realEarly = site.earlyStop.bind(site), realAdvance = site.flow.advance.bind(site.flow);
  let clear = 0, firstAdvance = true;
  site.earlyStop = async (...args) => { const out = await realEarly(...args); if (!out && ++clear === 2) await firstStepSent; return out; };
  site.flow.advance = async (...args) => { const out = await realAdvance(...args); if (firstAdvance) { firstAdvance = false; stepSent(); await runnerMayGoOn; } return out; };
  const both = await Promise.all([jobs.resume(caller, blocked.jobId, {}, { waitMs: 0 }), jobs.resume(caller, blocked.jobId, {}, { waitMs: 0 })]);
  assert.deepEqual(both.map((v) => v.state), ['running', 'running'], 'both calls report the one running job');
  assert.ok(both.every((v) => !v.stillBlocked));
  runnerGoesOn();
  const done = await until(async () => { const v = await jobs.get(caller, blocked.jobId); return v.state === 'done' && v; });
  assert.equal(done.result.kind, 'article');
  for (const step of ['intake', 'manual', 'write']) assert.equal(steps(site, step), 1, step + ' sent once');
});

test('a continue that still saw the old refusal does not stop a job another continue already restarted', async () => {
  const { site, uid, caller, jobs } = await bench('13700000002');
  site.demo.endTrial(uid);
  const blocked = await jobs.start(caller, 'write', { request: '写一份冬季安全生产通知', mode: 'quick' }, { waitMs: 0 });
  // Call B reads the job and gets the site's (old) refusal; then the person's membership takes effect and call A
  // restarts the job. B's late answer must not put the job back to "blocked".
  const realEarly = site.earlyStop.bind(site);
  let checks = 0, letBGoOn;
  const bMayGoOn = new Promise((r) => { letBGoOn = r; });
  site.earlyStop = async (...args) => { const out = await realEarly(...args); checks += 1; if (checks === 1) await bMayGoOn; return out; };
  const b = jobs.resume(caller, blocked.jobId, {}, { waitMs: 0 });
  await until(() => checks === 1);
  site.demo.activateMembership(uid);
  const a = await jobs.resume(caller, blocked.jobId, {}, { waitMs: 0 });
  assert.equal(a.state, 'running');
  letBGoOn();
  const late = await b;
  assert.notEqual(late.stillBlocked, true, 'the stale refusal was not written over the restarted job');
  await until(async () => (await jobs.get(caller, blocked.jobId)).state === 'done');
  assert.equal(steps(site, 'quick'), 1);
});

test('the same request sent again with its request_id gets the same job: no second job, no second paid run', async () => {
  const a = await account('13700000011');
  const args = { request: '帮我写一份冬季安全生产工作方案', mode: 'quick', request_id: 'rq_test_same_request_0001' };
  const first = await finish(env, a.token, await tool(env, a.token, 'write_material', args));
  assert.equal(first.structuredContent.status, 'done');
  // The answer to the first call was lost; the client sends the same request again.
  const again = await tool(env, a.token, 'write_material', args);
  assert.equal(again.structuredContent.job_id, first.structuredContent.job_id);
  assert.equal(again.structuredContent.request_reused, true);
  assert.equal(again.structuredContent.draft.text, first.structuredContent.draft.text, 'the original request gets its draft');
  assert.match(again.content[0].text, /同一个请求.*没有重复写，也没有再使用额度/);
  assert.equal(sent(a.uid, 'quick').length, 1, 'the paid step ran once');
  const other = await tool(env, a.token, 'write_material', { ...args, request: '写一份别的通知' });
  assert.equal(other.structuredContent.code, 'REQUEST_ID_REUSED', 'a different request under a used id is refused, not run');
  assert.equal(sent(a.uid, 'quick').length, 1);
  const b = await account('13700000012');
  const theirs = await finish(env, b.token, await tool(env, b.token, 'write_material', args));
  assert.notEqual(theirs.structuredContent.job_id, first.structuredContent.job_id, 'request ids belong to the account');
  assert.equal(sent(b.uid, 'quick').length, 1);
  const malformed = await tool(env, a.token, 'write_material', { request: '写', request_id: 'short' });
  assert.equal(malformed.structuredContent.status, 'invalid_arguments');
});

test('two copies of the same request arriving together start one job', async () => {
  const a = await account('13700000013');
  const args = { request: '写一份通知', mode: 'quick', request_id: 'rq_test_parallel_copy_01' };
  const [x, y] = await Promise.all([tool(env, a.token, 'write_material', args), tool(env, a.token, 'write_material', args)]);
  assert.equal(x.structuredContent.job_id, y.structuredContent.job_id);
  await finish(env, a.token, x);
  assert.equal(sent(a.uid, 'quick').length, 1);
});

test('after the job is deleted or has expired, a late retry of the same request writes nothing and says where the draft is', async () => {
  const a = await account('13700000014');
  const args = { request: '写一份通知（迟到的重试）', mode: 'quick', request_id: 'rq_test_late_retry_00001' };
  const done = await finish(env, a.token, await tool(env, a.token, 'write_material', args));
  const id = done.structuredContent.job_id, record = done.structuredContent.draft.record_id;
  assert.equal((await tool(env, a.token, 'cancel_writing', { job_id: id, delete_saved_input: true })).structuredContent.status, 'deleted');
  const row = jobRow(id);
  assert.equal(row.state, 'cleared');
  assert.ok(!JSON.stringify(row).includes('迟到的重试') && !row.flow && !row.result && !row.requestHash, 'no request, material, text or fingerprint is kept');
  const late = await tool(env, a.token, 'write_material', args);
  assert.equal(late.structuredContent.status, 'cleared');
  assert.equal(late.structuredContent.request_reused, true);
  assert.equal(late.structuredContent.records[0].record_id, record);
  assert.match(late.content[0].text, /没有重复写/);
  assert.match(late.content[0].text, /按要求删除/);
  assert.equal(late.isError, false);
  assert.equal(sent(a.uid, 'quick').length, 1);
  const read = await tool(env, a.token, 'get_writing_result', { job_id: id, wait_seconds: 0 });
  assert.equal(read.structuredContent.status, 'cleared', 'reading it later says what happened instead of "not found"');
  // Expired the normal way.
  const args2 = { ...args, request_id: 'rq_test_late_retry_00002' };
  const done2 = await finish(env, a.token, await tool(env, a.token, 'write_material', args2));
  const id2 = done2.structuredContent.job_id;
  env.store._tables.get('xxb_jobs').set(id2, { ...jobRow(id2), expiresAt: Date.now() - 1 });
  await env.service.purge();
  assert.equal(jobRow(id2).clearedReason, 'expired');
  const late2 = await tool(env, a.token, 'write_material', args2);
  assert.equal(late2.structuredContent.status, 'cleared');
  assert.match(late2.content[0].text, /过了保留期限/);
  assert.equal(sent(a.uid, 'quick').length, 2, 'one paid run per distinct request');
  // The small record goes after its own 30 days.
  assert.ok(Math.abs(jobRow(id2).expiresAt - Date.now() - 30 * 24 * 3600 * 1000) < 60 * 1000);
  env.store._tables.get('xxb_jobs').set(id2, { ...jobRow(id2), expiresAt: Date.now() - 1 });
  await env.service.purge();
  assert.equal(jobRow(id2), undefined);
});

test('a job asked for from another account (for example after reconnecting with another phone): the answer names the connected account', async () => {
  const a = await account('13700000015');
  const b = await account('13700000016');
  env.adapter.demo.endTrial(a.uid);
  const stopped = await tool(env, a.token, 'write_material', { request: '写一份通知' });
  const out = await tool(env, b.token, 'continue_writing', { job_id: stopped.structuredContent.job_id });
  assert.equal(out.structuredContent.code, 'JOB_NOT_FOUND');
  assert.ok(out.content[0].text.includes(`现在连接的账号（${b.who.phoneLabel}）`), out.content[0].text);
  assert.match(out.content[0].text, /另一个手机号的账号开始的，需要用那个账号重新连接/);
  assert.ok(!out.content[0].text.includes(a.who.phoneLabel), 'nothing about the other account is revealed');
  assert.equal(sent(a.uid).length + sent(b.uid).length, 0);
});

test('the first answer to a paid request says the site writes it and whose quota it uses; polls do not repeat it', async () => {
  const a = await account('13700000018');
  const release = env.adapter.demo.pause();
  try {
    const out = await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick' });
    assert.equal(out.structuredContent.status, 'running');
    assert.ok(out.content[0].text.includes(`这次由${env.adapter.info.name}网站处理，按网站会员规则使用账号的额度（账号：${a.who.phoneLabel}）`), out.content[0].text);
    assert.equal(out.structuredContent.account, a.who.phoneLabel);
    const poll = await tool(env, a.token, 'get_writing_result', { job_id: out.structuredContent.job_id, wait_seconds: 0 });
    assert.doesNotMatch(poll.content[0].text, /按网站会员规则使用账号的额度/);
  } finally { release(); }
});

test('an unexpected failure while starting paid work says the outcome is open and how to find out, not that nothing happened', async () => {
  const a = await account('13700000017');
  const real = env.adapter.flow.newJob;
  env.adapter.flow.newJob = () => { throw new Error('simulated'); };
  try {
    const keyed = await tool(env, a.token, 'write_material', { request: '写一份通知', request_id: 'rq_test_unexpected_0001' });
    assert.equal(keyed.isError, true);
    assert.equal(keyed.structuredContent.outcome, 'unknown');
    assert.match(keyed.content[0].text, /不确定网站有没有开始写/);
    assert.match(keyed.content[0].text, /同一个 request_id（rq_test_unexpected_0001）再调用一次/);
    const plain = await tool(env, a.token, 'write_material', { request: '写一份通知' });
    assert.match(plain.content[0].text, /list_drafts/);
    assert.doesNotMatch(plain.content[0].text, /输入没有丢失/);
  } finally { env.adapter.flow.newJob = real; }
});
