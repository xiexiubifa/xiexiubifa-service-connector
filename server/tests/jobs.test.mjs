// Writing through the tools: drafts passed on as the site returned them, membership and quota decided by the site,
// the same request going on after the person has dealt with a stop, and no step ever sent (or paid for) twice.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, connect, tool, finish } from './helpers.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BEGIN, END } = require('../src/present.cjs');

let env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

const sent = (uid, step) => env.adapter.demo.calls.filter((c) => c.uid === uid && (!step || c.step === step));
const jobRow = (id) => env.store._tables.get('xxb_jobs').get(id);
async function account(phone) {
  const { tokens, who } = await connect(env, { phone });
  return { token: tokens.access_token, uid: who.uid, who };
}

test('a draft comes back exactly as the site wrote it, with its source, in the account\'s drafts, as Word too', async () => {
  const a = await account('13800000001');
  const done = await finish(env, a.token, await tool(env, a.token, 'write_material', { request: '帮我写一份街道冬季安全生产工作方案，1500字左右', audience: '各社区' }));
  assert.equal(done.structuredContent.status, 'done', JSON.stringify(done.structuredContent));
  assert.equal(done.isError, false);
  const draft = done.structuredContent.draft;
  const stored = env.adapter.demo.drafts.get(draft.record_id);
  assert.equal(draft.text, stored.versions[0].text, 'the text is the site\'s, unchanged');
  const text = done.content[0].text;
  assert.ok(text.includes(BEGIN + '\n' + stored.versions[0].text + '\n' + END), 'the draft sits verbatim between the markers');
  assert.match(text, new RegExp('来源：.*成稿记录 ' + draft.record_id + ' · 第 1 稿'));
  assert.match(text, /1 处“待补充”/, 'gaps the site left are pointed out, not filled');
  assert.deepEqual(sent(a.uid).map((c) => c.step), ['intake', 'manual', 'write']);
  const list = await tool(env, a.token, 'list_drafts');
  assert.equal(list.structuredContent.drafts[0].record_id, draft.record_id);
  const again = await tool(env, a.token, 'get_draft', { record_id: draft.record_id });
  assert.equal(again.structuredContent.draft.text, draft.text);
  const word = await tool(env, a.token, 'get_word_file', { record_id: draft.record_id });
  const blob = word.content.find((c) => c.type === 'resource').resource;
  assert.equal(blob.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(Buffer.from(blob.blob, 'base64').subarray(0, 2).toString(), 'PK');
  const result = await tool(env, a.token, 'get_writing_result', { job_id: done.structuredContent.job_id, wait_seconds: 0 });
  assert.equal(result.structuredContent.draft.text, draft.text, 'asking again gives the same draft');
  assert.equal(sent(a.uid).length, 3, 'and sends nothing again');
});

test('quick mode, revise and polish go through the site in the same way', async () => {
  const a = await account('13800000002');
  const quick = await finish(env, a.token, await tool(env, a.token, 'write_material', { request: '写一份冬季安全生产通知', mode: 'quick' }));
  assert.equal(quick.structuredContent.status, 'done');
  assert.deepEqual(sent(a.uid).map((c) => c.step), ['quick']);
  const revised = await finish(env, a.token, await tool(env, a.token, 'revise_draft', { record_id: quick.structuredContent.draft.record_id, instruction: '第二部分写具体些' }));
  assert.equal(revised.structuredContent.status, 'done');
  assert.equal(revised.structuredContent.draft.version, 2);
  const polished = await finish(env, a.token, await tool(env, a.token, 'polish_text', { text: '为切实做好冬季安全生产工作，现将有关事项通知如下。', emphasis: 'data', strength: 6 }));
  assert.equal(polished.structuredContent.status, 'done');
  assert.equal(polished.structuredContent.variants.length, 2);
  assert.ok(polished.structuredContent.variants.every((v) => v.source.includes(v.record_id)));
});

test('membership needed before starting: no paid step, the request is kept, and goes on after the person pays', async () => {
  const a = await account('13800000003');
  env.adapter.demo.endTrial(a.uid);
  const stopped = await tool(env, a.token, 'write_material', { request: '帮我写一份年终工作总结' });
  const s = stopped.structuredContent;
  assert.equal(s.status, 'needs_membership');
  assert.equal(stopped.isError, false, 'a stop with a clear next step on the site is an ordinary result');
  assert.equal(sent(a.uid).length, 0, 'nothing was sent to the site');
  const text = stopped.content[0].text;
  assert.match(text, /这次还没有稿件/);
  assert.ok(!text.includes(BEGIN), 'no draft text at all');
  assert.match(text, /（演示）免费体验已结束/, 'the site\'s own words');
  assert.ok(text.includes(' ' + env.adapter.info.membershipUrl + ' '), 'the 会员中心 link stands apart so it is clickable');
  assert.match(text, /平时用的浏览器/);
  assert.match(text, new RegExp('continue_writing（job_id=' + s.job_id + '）'));
  assert.deepEqual(s.links, [{ label: '会员中心', url: env.adapter.info.membershipUrl }]);
  assert.equal(s.membership.tier, 'none');
  assert.equal(s.account, a.who.phoneLabel, 'the result names the connected account');
  assert.ok(text.includes(`打开后先确认网站上登录的是 ${a.who.phoneLabel}`), 'and asks to check that the browser is logged into the same account');
  assert.match(text, /开通的会是那个账号/);
  // Not paid yet: asked again, the site still says no, and the request stays.
  const still = await tool(env, a.token, 'continue_writing', { job_id: s.job_id });
  assert.equal(still.structuredContent.status, 'needs_membership');
  assert.ok(still.content[0].text.includes(`网站还没有显示 ${a.who.phoneLabel} 的会员生效`), still.content[0].text);
  assert.match(still.content[0].text, /确认开通的是这个账号/);
  assert.equal(sent(a.uid).length, 0);
  env.adapter.demo.activateMembership(a.uid);
  const done = await finish(env, a.token, await tool(env, a.token, 'continue_writing', { job_id: s.job_id }));
  assert.equal(done.structuredContent.status, 'done');
  assert.deepEqual(sent(a.uid).map((c) => c.step), ['intake', 'manual', 'write'], 'the same request, each step once');
});

test('quota already used up: the site\'s status stops the request before any step is sent', async () => {
  const a = await account('13800000016');
  env.adapter.demo.setUsed(a.uid, 100);
  const stopped = await tool(env, a.token, 'write_material', { request: '帮我写一份冬季安全生产工作方案' });
  assert.equal(stopped.structuredContent.status, 'needs_membership');
  assert.equal(stopped.structuredContent.code, 'MEMBER_TRIAL_EXHAUSTED');
  assert.equal(stopped.structuredContent.membership.quota_percent ?? stopped.structuredContent.membership.quotaPercent, 0);
  assert.equal(sent(a.uid).length, 0, 'nothing was sent to the site, not even a step it would refuse');
});

test('quota running out during a step: earlier steps are not sent again; the refused step gets a new task id', async () => {
  const a = await account('13800000004');
  env.adapter.demo.setUsed(a.uid, 50); // enough for 基础设定 and 六模块提示词, not for the article
  const stopped = await finish(env, a.token, await tool(env, a.token, 'write_material', { request: '帮我写一份社区消防安全宣传稿' }));
  const s = stopped.structuredContent;
  assert.equal(s.status, 'needs_membership', JSON.stringify(s));
  assert.equal(s.code, 'MEMBER_TRIAL_EXHAUSTED');
  assert.deepEqual(s.done_steps, ['基础设定', '六模块提示词']);
  assert.match(stopped.content[0].text, /已完成的基础设定、六模块提示词不会重复扣额度/);
  const refusedAttempt = sent(a.uid, 'write')[0].attemptId;
  env.adapter.demo.activateMembership(a.uid);
  const done = await finish(env, a.token, await tool(env, a.token, 'continue_writing', { job_id: s.job_id }));
  assert.equal(done.structuredContent.status, 'done');
  assert.equal(sent(a.uid, 'intake').length, 1);
  assert.equal(sent(a.uid, 'manual').length, 1);
  const writes = sent(a.uid, 'write');
  assert.equal(writes.length, 2);
  assert.notEqual(writes[1].attemptId, refusedAttempt, 'the site keeps a refused task id refused, so the step is sent with a new one');
});

test('the site asks for more information: the person adds it and the same job goes on', async () => {
  const a = await account('13800000005');
  const stopped = await finish(env, a.token, await tool(env, a.token, 'write_material', { request: '帮我写' }));
  assert.equal(stopped.structuredContent.status, 'needs_more_info');
  assert.deepEqual(stopped.structuredContent.missing, ['标题']);
  const done = await finish(env, a.token, await tool(env, a.token, 'continue_writing', { job_id: stopped.structuredContent.job_id, title: '关于开展冬季安全检查的通知' }));
  assert.equal(done.structuredContent.status, 'done');
  assert.equal(done.structuredContent.draft.title, '关于开展冬季安全检查的通知');
  assert.equal(sent(a.uid, 'intake').length, 1, 'the paid intake is not repeated');
});

test('temporary failures: retried by the runner, then reported; continue_writing tries again', async () => {
  const a = await account('13800000006');
  env.adapter.demo.failNext('write', 'AI_SERVICE_UNAVAILABLE', 1);
  const once = await finish(env, a.token, await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick' }));
  assert.equal(once.structuredContent.status, 'done', 'one temporary failure is retried automatically');
  const b = await account('13800000007');
  env.adapter.demo.failNext('quick', 'AI_SERVICE_UNAVAILABLE', 3);
  const failed = await finish(env, b.token, await tool(env, b.token, 'write_material', { request: '写一份通知', mode: 'quick' }));
  assert.equal(failed.structuredContent.status, 'temporarily_failed');
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /continue_writing/);
  const attempts = sent(b.uid, 'quick');
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((c) => c.attemptId)).size, 1, 'a temporary failure keeps its task id (the site runs it again)');
  const done = await finish(env, b.token, await tool(env, b.token, 'continue_writing', { job_id: failed.structuredContent.job_id }));
  assert.equal(done.structuredContent.status, 'done');
});

test('a runner that went away: the next runner waits for the step the site is still running and never sends it twice', async () => {
  const a = await account('13800000008');
  const release = env.adapter.demo.pause();
  const running = await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick' });
  assert.equal(running.structuredContent.status, 'running');
  const id = running.structuredContent.job_id;
  // The first runner stops renewing its lease, as if its process had gone away while the site kept working on the
  // step. A second runner (another instance) takes the job over.
  const row = jobRow(id);
  env.store._tables.get('xxb_jobs').set(id, { ...row, lease: { holder: 'gone', until: Date.now() - 1 } });
  const second = env.service.runJob(id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(jobRow(id).state, 'running', 'the second runner waits while the site reports the step as running');
  release();
  await second;
  const done = await finish(env, a.token, running);
  assert.equal(done.structuredContent.status, 'done');
  assert.equal(sent(a.uid, 'quick').length, 1, 'the step was sent once; its result was taken from the site');
});

test('a stalled job is reported as such by reads, and continue_writing picks it up', async () => {
  const a = await account('13800000009');
  const release = env.adapter.demo.pause();
  const running = await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick' });
  const id = running.structuredContent.job_id;
  await new Promise((r) => setTimeout(r, 20));
  env.store._tables.get('xxb_jobs').set(id, { ...jobRow(id), lease: null, updatedAt: Date.now() - 60 * 1000 });
  const look = await tool(env, a.token, 'get_writing_result', { job_id: id, wait_seconds: 0 });
  assert.equal(look.structuredContent.stalled, true);
  assert.match(look.content[0].text, /continue_writing/);
  release();
  const done = await finish(env, a.token, await tool(env, a.token, 'continue_writing', { job_id: id }));
  assert.equal(done.structuredContent.status, 'done');
  assert.equal(sent(a.uid, 'quick').length, 1);
});

test('cancel, and cancel with the saved request and material deleted', async () => {
  const a = await account('13800000010');
  const release = env.adapter.demo.pause();
  const running = await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick', material: '素材：XX' });
  const cancelled = await tool(env, a.token, 'cancel_writing', { job_id: running.structuredContent.job_id });
  assert.equal(cancelled.structuredContent.status, 'cancelled');
  assert.match(cancelled.content[0].text, /网站可能仍会写完/, 'an already sent step is described honestly');
  release();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(jobRow(running.structuredContent.job_id).state, 'cancelled', 'the runner does not overwrite a cancellation');
  const other = await tool(env, a.token, 'write_material', { request: '写一份方案', mode: 'quick', material: '敏感素材' });
  const deleted = await tool(env, a.token, 'cancel_writing', { job_id: other.structuredContent.job_id, delete_saved_input: true });
  assert.equal(deleted.structuredContent.status, 'deleted');
  assert.equal(jobRow(other.structuredContent.job_id), undefined, 'the saved request and material are gone');
  const gone = await tool(env, a.token, 'get_writing_result', { job_id: other.structuredContent.job_id });
  assert.equal(gone.structuredContent.code, 'JOB_NOT_FOUND');
});

test('jobs belong to the account; running jobs per account are limited', async () => {
  const a = await account('13800000011');
  const b = await account('13800000012');
  const release = env.adapter.demo.pause();
  try {
    const one = await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick' });
    const peek = await tool(env, b.token, 'get_writing_result', { job_id: one.structuredContent.job_id });
    assert.equal(peek.structuredContent.code, 'JOB_NOT_FOUND');
    assert.equal((await tool(env, b.token, 'cancel_writing', { job_id: one.structuredContent.job_id, delete_saved_input: true })).structuredContent.code, 'JOB_NOT_FOUND');
    await tool(env, a.token, 'write_material', { request: '写一份方案', mode: 'quick' });
    const third = await tool(env, a.token, 'write_material', { request: '写一份讲话稿', mode: 'quick' });
    assert.equal(third.structuredContent.code, 'TOO_MANY_JOBS');
    assert.equal(third.isError, true);
  } finally { release(); }
});

test('a connection closed on the site stops its running job', async () => {
  const a = await account('13800000013');
  const release = env.adapter.demo.pause();
  const running = await tool(env, a.token, 'write_material', { request: '帮我写一份工作方案' });
  const listed = await env.service.siteAction(a.who, 'connections_list', {});
  await env.service.siteAction(a.who, 'connection_revoke', { id: listed.data.items[0].id });
  release();
  await new Promise((r) => setTimeout(r, 300));
  const row = jobRow(running.structuredContent.job_id);
  assert.equal(row.state, 'cancelled');
  assert.equal(row.stop.code, 'CONNECTION_CLOSED');
  assert.ok(sent(a.uid).length <= 1, 'no further step after the connection was closed');
});

test('a disabled account is told to contact the site, not to buy membership', async () => {
  const a = await account('13800000014');
  env.adapter.demo.disable(a.uid);
  const out = await tool(env, a.token, 'write_material', { request: '写一份通知' });
  assert.equal(out.structuredContent.status, 'account_disabled');
  assert.match(out.content[0].text, /联系网站/);
  assert.doesNotMatch(out.content[0].text, /会员中心/);
  assert.equal((await tool(env, a.token, 'continue_writing', { job_id: out.structuredContent.job_id })).structuredContent.code, 'NOT_RESUMABLE');
});

test('retention: finished jobs are kept 7 days, waiting ones 30; expired ones are deleted', async () => {
  const a = await account('13800000015');
  const done = await finish(env, a.token, await tool(env, a.token, 'write_material', { request: '写一份通知', mode: 'quick' }));
  const row = jobRow(done.structuredContent.job_id);
  const day = 24 * 3600 * 1000;
  assert.ok(Math.abs(row.expiresAt - Date.now() - 7 * day) < 60 * 1000);
  env.adapter.demo.endTrial(a.uid);
  const blocked = await tool(env, a.token, 'write_material', { request: '写一份方案', mode: 'quick' });
  assert.ok(Math.abs(jobRow(blocked.structuredContent.job_id).expiresAt - Date.now() - 30 * day) < 60 * 1000);
  env.store._tables.get('xxb_jobs').set(done.structuredContent.job_id, { ...row, expiresAt: Date.now() - 1 });
  await env.service.purge();
  assert.equal(jobRow(done.structuredContent.job_id), undefined);
  assert.ok(jobRow(blocked.structuredContent.job_id), 'unexpired ones stay');
});
