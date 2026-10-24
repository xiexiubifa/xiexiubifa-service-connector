'use strict';
// Writing jobs: the site's own writing flow (supplied by the site adapter as resumable steps), run for one account,
// kept in the store between calls so a tool call never has to stay open for the minutes a draft takes.
//
// - A job runs step by step in a runner (in this process, or a separate invocation the deployment dispatches). A lease
//   with a heartbeat makes sure one runner works on a job at a time; a job whose runner went away is picked up again
//   by the next look at it. Every paid step carries a task id fixed in the job, and the adapter asks the site for that
//   task's outcome before sending it, so a step run twice never runs (or is paid for) twice.
// - The site decides about membership and quota. When it says no, the job stops as "blocked" with the site's own words
//   and keeps the request; after the person has dealt with it on the site, resume() goes on from the step that was
//   refused. Steps already done are not sent again.
// - Temporary failures are retried twice by the runner, then reported; resume() tries again on request.
// - Going from a stop back to running is one compare-and-set on the job's revision: of two overlapping continue
//   requests only one restarts the job (and gives the refused step its new task id); the other reports the job as it is.
// - A client may give a request id. The job id then follows from the account and that id, so the same request sent
//   again (its answer was lost, the client retried) finds the same job instead of starting, and paying for, a second
//   one. After such a job is deleted or expires, a small record without the request or material stays for 30 days.
// - The person can cancel a job, and have its saved request and material deleted at once.
const { EventEmitter } = require('node:events');
const { randomId, sha256, ServiceError, sleep } = require('./util.cjs');
const { GRANTS } = require('./grants.cjs');

const JOBS = 'xxb_jobs';
const LEASE_MS = 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;
const STILL_RUNNING_WAIT_MS = 4000;
const STEP_RUNNING_LIMIT_MS = 17 * 60 * 1000; // the site's own task lifetime is 16 minutes
const RETRY_DELAYS_MS = [5000, 15000];
// Stops the person can deal with and then go on from: membership or quota on the site, settings the site asked for,
// the site login, and temporary failures. A disabled account or a refused input is final.
const RESUMABLE = new Set(['membership', 'settings', 'login', 'retry']);
const BLOCKING = new Set(['membership', 'settings', 'login']);
const stateFor = (stop) => (BLOCKING.has(stop.category) ? 'blocked' : 'failed');
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
// The same request id from the same account always names the same job.
const jobIdFor = (owner, requestId) => 'wj_' + sha256('request|' + owner + '|' + requestId).slice(0, 32);
// A fingerprint of what was asked, to tell a retry of the same request from a different request with a reused id.
const canonical = (value) => (Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
    : JSON.stringify(value ?? null));
const requestHash = (kind, params) => sha256(kind + '|' + canonical(params));
// What a cleared job keeps: no request, no material, no text; only where its drafts are.
const recordsOf = (result) => (!result ? [] : result.kind === 'polish'
  ? (result.variants || []).map((v) => ({ recordId: v.recordId, version: v.version, label: v.label }))
  : result.recordId ? [{ recordId: result.recordId, version: result.version }] : []);

function createJobs({ store, site, config, limiter, now = () => Date.now(), runner = 'inline', dispatch, delays = {} }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const retryDelays = delays.retry || RETRY_DELAYS_MS;
  const stillRunningWait = delays.stillRunning ?? STILL_RUNNING_WAIT_MS;
  const leaseMs = delays.lease || LEASE_MS;
  const heartbeatMs = delays.heartbeat || HEARTBEAT_MS;

  const expiresFor = (state, t = now()) => t + (config.retention[state] || config.retention.done);

  function view(job) {
    if (job.state === 'cleared') {
      return { jobId: job._id, kind: job.kind, state: 'cleared', clearedReason: job.clearedReason, endState: job.endState || '', records: job.records || [],
        createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt };
    }
    return {
      jobId: job._id, kind: job.kind, state: job.state, stage: job.stage || '', createdAt: job.createdAt, updatedAt: job.updatedAt,
      doneSteps: site.flow.doneSteps ? site.flow.doneSteps(job.flow) : [],
      ...(job.state === 'done' ? { result: job.result } : {}),
      ...(job.stop ? { stop: job.stop, resumable: RESUMABLE.has(job.stop.category) } : {}),
      ...(job.state === 'running' && job.retries ? { retrying: job.retries } : {}),
      expiresAt: job.expiresAt
    };
  }

  // A job belongs to the account, like the site's own records; another account's job does not exist for this one.
  // The message names the connected account, because "not found" after reconnecting usually means another account.
  const notFound = (caller) => new ServiceError('JOB_NOT_FOUND', `现在连接的账号（${caller.grant.phoneLabel || '未知账号'}）下没有找到这个写作任务。写作任务只属于开始它的账号：如果是用另一个手机号的账号开始的，需要用那个账号重新连接才能接着做；也可能已经过了保留期限，或已经删除。`);

  async function load(caller, jobId) {
    if (typeof jobId !== 'string' || !/^wj_[\w-]{20,40}$/.test(jobId)) throw new ServiceError('BAD_INPUT', '任务编号不正确。');
    const job = await store.get(JOBS, jobId);
    if (!job || job.owner !== caller.grant.accountKey) throw notFound(caller);
    return job;
  }

  // What stays of a job with a request id after it is deleted or expires: enough to answer a late retry of the same
  // request (and to say where its drafts are) without writing it again; no request, material, title or text.
  function clearedRecord(job, reason, t = now()) {
    return { owner: job.owner, kind: job.kind, state: 'cleared', clearedReason: reason, endState: job.state, records: recordsOf(job.state === 'done' ? job.result : null),
      requestKeyed: true, createdAt: job.createdAt, updatedAt: t, endedAt: job.endedAt || t, rev: (job.rev || 0) + 1, expiresAt: t + config.retention.cleared };
  }

  async function save(id, change, { holder } = {}) {
    const saved = await store.transaction(async (tx) => {
      const current = await tx.get(JOBS, id);
      if (!current) return null;
      if (holder && current.lease?.holder !== holder) return { lost: true, job: current };
      const next = { ...current, ...change, rev: (current.rev || 0) + 1, updatedAt: now() };
      if (change.state && change.state !== 'running') { next.lease = null; next.endedAt = now(); next.expiresAt = expiresFor(change.state); }
      return { job: await tx.put(JOBS, id, next) };
    });
    if (saved?.job) events.emit(id, saved.job);
    return saved;
  }

  // Starts a runner for the job. Extra runners are harmless: only the one holding the lease works on the job, and a
  // runner that lost its lease (its process stalled) saves nothing.
  function kick(jobId) {
    if (runner === 'external') {
      Promise.resolve().then(() => dispatch(jobId)).catch(() => {}); // a missed dispatch is picked up by sweep()
      return;
    }
    setImmediate(() => { runJob(jobId).catch(() => {}); });
  }

  // Waits until the job leaves `running` or `ms` pass; then returns its current document.
  async function waitFor(jobId, ms) {
    const until = now() + Math.max(0, ms);
    let job = await store.get(JOBS, jobId);
    while (job && job.state === 'running' && now() < until) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(1500, Math.max(0, until - now())));
        function done() { clearTimeout(timer); events.off(jobId, done); resolve(); }
        events.once(jobId, done);
      });
      job = await store.get(JOBS, jobId);
    }
    return job;
  }

  const stale = (job) => job.state === 'running' && (!job.lease || job.lease.until < now());

  // The same request sent again: report the job it already started (no second job, no second paid run).
  async function repeated(caller, job, hash, waitMs) {
    if (job.owner !== caller.grant.accountKey || (job.state !== 'cleared' && job.requestHash && job.requestHash !== hash)) {
      throw new ServiceError('REQUEST_ID_REUSED', '这个 request_id 已经用在另一个写作请求上了，这次没有开始新的写作。新的请求请换一个 request_id。');
    }
    if (job.state === 'running' && stale(job)) kick(job._id);
    const current = job.state === 'running' ? (await waitFor(job._id, waitMs)) || job : job;
    return { ...view(current), requestReused: true };
  }

  async function start(caller, kind, params, { waitMs = config.toolWaitMs, requestId } = {}) {
    const { grant } = caller;
    if (!site.flow.kinds.includes(kind)) throw new ServiceError('BAD_INPUT', '不支持的写作类型：' + kind);
    let keyedId = null, hash = null;
    if (requestId !== undefined && requestId !== null) {
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new ServiceError('BAD_INPUT', 'request_id 格式不正确（8–80 位字母、数字、- 或 _）。');
      keyedId = jobIdFor(grant.accountKey, requestId);
      hash = requestHash(kind, params);
      const existing = await store.get(JOBS, keyedId);
      if (existing) return repeated(caller, existing, hash, waitMs);
    }
    await limiter.hit('jobs_account', grant.accountKey);
    const active = await store.find(JOBS, { owner: grant.accountKey, state: 'running' }, { limit: 20 });
    if (active.length >= config.maxRunningJobsPerAccount) {
      throw new ServiceError('TOO_MANY_JOBS', `这个账号已有 ${active.length} 篇正在写，等写完再开始新的（可以用 get_writing_result 查看进度）。`, { running: active.map((j) => j._id) });
    }
    const flow = site.flow.newJob(kind, params); // checks and limits the input; throws BAD_INPUT
    // The site page's own early check: a stop before any paid step, with the site's words. The request is kept.
    const stop = await site.earlyStop(grant.uid, kind);
    const t = now();
    const state = stop ? stateFor(stop) : 'running';
    const job = { owner: grant.accountKey, grantId: grant._id, kind, flow, state, stage: stop ? '' : site.flow.stage(flow),
      result: null, stop: stop ? { ...stop, at: t } : null, retries: 0, lease: null, rev: 0, createdAt: t, updatedAt: t, expiresAt: expiresFor(state, t),
      ...(keyedId ? { requestKeyed: true, requestHash: hash } : {}) };
    let saved;
    if (keyedId) {
      // Two copies of the same request arriving together: the first one creates the job, the other reports it.
      const created = await store.transaction(async (tx) => {
        const current = await tx.get(JOBS, keyedId);
        return current ? { existing: current } : { job: await tx.put(JOBS, keyedId, job) };
      });
      if (created.existing) return repeated(caller, created.existing, hash, waitMs);
      saved = created.job;
    } else {
      saved = await store.put(JOBS, randomId('wj_', 24), job);
    }
    if (!stop) kick(saved._id);
    return view(stop ? saved : await waitFor(saved._id, waitMs));
  }

  // Reading only: a job whose runner went away is reported as stalled (sweep() or continue_writing picks it up).
  async function get(caller, jobId, { waitMs = 0 } = {}) {
    let job = await load(caller, jobId);
    if (job.state === 'running' && waitMs > 0) job = (await waitFor(job._id, Math.min(waitMs, config.toolWaitMs))) || job;
    return { ...view(job), ...(stale(job) && now() - (job.updatedAt || job.createdAt) > 2 * leaseMs ? { stalled: true } : {}) };
  }

  async function resume(caller, jobId, overrides = {}, { waitMs = config.toolWaitMs } = {}) {
    const job = await load(caller, jobId);
    if (job.state === 'running' && stale(job)) kick(job._id);
    if (['done', 'running', 'cleared'].includes(job.state)) return get(caller, jobId, { waitMs });
    if (job.state === 'cancelled') throw new ServiceError('JOB_CANCELLED', '这个写作任务已经取消了。需要的话请重新开始。');
    if (!job.stop || !RESUMABLE.has(job.stop.category)) {
      throw new ServiceError('NOT_RESUMABLE', '这个任务停在了不能接着做的地方：' + (job.stop?.message || '未知原因') + '。需要的话请重新开始。');
    }
    const { grant } = caller;
    const stop = await site.earlyStop(grant.uid, job.kind);
    // One compare-and-set: only a call that still finds the job exactly as it read it changes it. A call that overlapped
    // with another continue_writing (or a cancel, or the runner) leaves the job alone and reports it as it is now, so the
    // refused step is never restarted twice with two different task ids.
    const outcome = await store.transaction(async (tx) => {
      const current = await tx.get(JOBS, job._id);
      if (!current || current.owner !== job.owner) return { missing: true };
      if ((current.rev || 0) !== (job.rev || 0) || current.state !== job.state) return { overlapped: true };
      const t = now();
      const base = { ...current, rev: (current.rev || 0) + 1, updatedAt: t };
      const next = stop
        // Still not possible on the site: say so with the site's current words, keep the request.
        ? { ...base, state: stateFor(stop), stop: { ...stop, at: t, checkedAgain: true }, lease: null, endedAt: t, expiresAt: expiresFor(stateFor(stop), t) }
        : (() => {
          const flow = site.flow.resume(current.flow, current.stop, overrides);
          return { ...base, flow, state: 'running', stop: null, retries: 0, lease: null, grantId: grant._id, stage: site.flow.stage(flow), expiresAt: expiresFor('running', t) };
        })();
      return { job: await tx.put(JOBS, job._id, next) };
    });
    if (outcome.missing) throw notFound(caller);
    if (outcome.overlapped) return get(caller, jobId, { waitMs });
    events.emit(job._id, outcome.job);
    if (stop) return { ...view(outcome.job), stillBlocked: true };
    kick(job._id);
    return view(await waitFor(job._id, waitMs));
  }

  async function cancel(caller, jobId, { forget = false } = {}) {
    const job = await load(caller, jobId);
    const wasRunning = job.state === 'running';
    if (forget) {
      // The request, material, progress and text go now. A job started with a request id keeps the small record that
      // stops a late retry of the same request from writing (and charging) it again.
      if (job.requestKeyed) await store.put(JOBS, job._id, job.state === 'cleared' ? { ...job, clearedReason: 'deleted' } : clearedRecord(job, 'deleted'));
      else await store.remove(JOBS, job._id);
      events.emit(job._id, null);
      return { jobId, state: 'deleted', wasRunning };
    }
    if (['done', 'cancelled', 'cleared'].includes(job.state)) return { ...view(job), wasRunning: false };
    const saved = await save(job._id, { state: 'cancelled', stop: { category: 'cancelled', code: 'CANCELLED', message: '已按你的要求取消。', at: now() } });
    return { ...view(saved.job), wasRunning };
  }

  // The runner: works on one job until it ends, stops, or another runner holds it.
  async function runJob(jobId) {
    const holder = randomId('rn_', 12);
    let stillRunningSince = null;
    for (let guard = 0; guard < 500; guard += 1) {
      const claimed = await store.transaction(async (tx) => {
        const job = await tx.get(JOBS, jobId);
        if (!job || job.state !== 'running') return null;
        if (job.lease && job.lease.holder !== holder && job.lease.until >= now()) return null;
        return tx.put(JOBS, jobId, { ...job, lease: { holder, until: now() + leaseMs } });
      });
      if (!claimed) return;
      const grant = await store.get(GRANTS, claimed.grantId);
      if (!grant || grant.status !== 'active') {
        await save(jobId, { state: 'cancelled', stop: { category: 'connection', code: 'CONNECTION_CLOSED', message: '账号连接已断开，任务没有继续。重新连接后可以再开始。', at: now() } }, { holder });
        return;
      }
      const beat = setInterval(() => {
        store.transaction(async (tx) => {
          const job = await tx.get(JOBS, jobId);
          if (job?.lease?.holder === holder) await tx.put(JOBS, jobId, { ...job, lease: { holder, until: now() + leaseMs } });
        }).catch(() => {});
      }, heartbeatMs);
      beat.unref?.();
      let outcome;
      try {
        const next = await site.flow.advance(grant.uid, claimed.flow, {
          progress: (stage) => { save(jobId, { stage }, { holder }).catch(() => {}); }
        });
        stillRunningSince = null;
        outcome = next.done
          ? { flow: next.flow, state: 'done', result: next.result, stage: '已完成', retries: 0 }
          : { flow: next.flow, stage: site.flow.stage(next.flow), retries: 0 };
      } catch (error) {
        // An adapter may hand back its own bookkeeping with an error (for example, how often a step was re-sent).
        const keep = error && error.flow ? { flow: error.flow } : {};
        if (site.flow.isStillRunning(error)) {
          // The site is still working on this step (a run sent earlier): wait for it, never send it again meanwhile.
          stillRunningSince ??= now();
          if (now() - stillRunningSince < STEP_RUNNING_LIMIT_MS) {
            clearInterval(beat);
            if (keep.flow) await save(jobId, keep, { holder });
            await sleep(stillRunningWait);
            continue;
          }
        }
        const stop = { ...site.flow.classify(error), at: now() };
        if (stop.category === 'retry' && (claimed.retries || 0) < retryDelays.length) {
          clearInterval(beat);
          await save(jobId, { retries: (claimed.retries || 0) + 1, ...keep }, { holder });
          await sleep(retryDelays[claimed.retries || 0]);
          continue;
        }
        outcome = { state: stateFor(stop), stop, ...keep };
      } finally {
        clearInterval(beat);
      }
      const saved = await save(jobId, outcome, { holder });
      if (!saved || saved.lost || saved.job.state !== 'running') return;
    }
  }

  // Picks up running jobs whose runner went away (after a restart, or a lost dispatch). Run at start-up and on a timer.
  async function sweep(limit = 20) {
    let kicked = 0;
    for (const job of await store.find(JOBS, { state: 'running' }, { limit: 200 })) {
      if (kicked >= limit) break;
      if (stale(job)) { kick(job._id); kicked += 1; }
    }
    return kicked;
  }

  async function purge(limit = 50) {
    let removed = 0;
    for (const job of await store.expired(JOBS, now(), limit)) {
      if (job.state === 'running' && job.lease && job.lease.until >= now()) continue;
      if (job.requestKeyed && job.state !== 'cleared') await store.put(JOBS, job._id, clearedRecord(job, 'expired'));
      else await store.remove(JOBS, job._id);
      removed += 1;
    }
    return removed;
  }

  return { start, get, resume, cancel, runJob, sweep, purge, view, kick };
}

module.exports = { createJobs, JOBS };
