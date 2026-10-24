'use strict';
// DEMO site adapter — a local stand-in for the writing site, for development and tests only.
//
// It behaves like the real adapter in every way the service relies on, so the whole connection and writing round trip
// can be run on one computer: accounts known by phone, a first-day trial with limited quota, membership tiers, quota
// spent per step (refused before a step, or during it), the site's writing flow as steps with task ids whose outcome
// is looked up before a step is sent again, drafts kept per account, Word files and a document-type list.
// Its drafts are plainly marked as demo text. It is NOT the site: the real adapter (deployment-specific, not part of
// this repository) runs the site's own writing and membership code.
const { createHash, randomUUID } = require('node:crypto');
const { ServiceError } = require('../src/util.cjs');
const { docx } = require('./docx-mini.cjs');

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const TIER_NAMES = { trial: '首日免费体验（演示）', standard: '标准版（演示）', none: '未开通会员', guest: '未登录' };
const COST = { intake: 5, manual: 10, write: 40, quick: 30, polish: 30, revise: 30 };
const STAGES = {
  intake: '基础设定：AI 正在根据你的需求预填…', manual: '六模块提示词：AI 正在生成…', write: '文章：AI 正在按六模块提示词写作…',
  quick: '文章：AI 正在一键生成（传统方式）…', polish: '智能润色：AI 正在润色…', revise: '继续改稿：AI 正在按修改要求生成新版本…'
};
const STEP_NAMES = { intake: '基础设定', manual: '六模块提示词' };
const MESSAGES = {
  MEMBER_LOGIN_REQUIRED: '（演示）请先用手机号登录。',
  MEMBER_REQUIRED: '（演示）免费体验已结束，开通会员后可以继续写。',
  MEMBER_TRIAL_EXHAUSTED: '（演示）免费体验的额度用完了。',
  MEMBER_QUOTA_EXHAUSTED: '（演示）本周期额度用完了。',
  MEMBER_ACCOUNT_DISABLED: '（演示）这个账号暂时不能使用，请联系网站。',
  AI_SERVICE_UNAVAILABLE: '（演示）写作服务暂时繁忙，输入已保留。'
};
const CATEGORY = {
  MEMBER_REQUIRED: 'membership', MEMBER_TRIAL_EXHAUSTED: 'membership', MEMBER_QUOTA_EXHAUSTED: 'membership', MEMBER_PRO_REQUIRED: 'membership',
  MEMBER_LOGIN_REQUIRED: 'login', MEMBER_ACCOUNT_DISABLED: 'disabled', SETTINGS_INCOMPLETE: 'settings',
  AI_REQUEST_TIMEOUT: 'retry', AI_NETWORK_ERROR: 'retry', AI_SERVICE_UNAVAILABLE: 'retry', MEMBER_SYNC_UNAVAILABLE: 'retry', MEMBER_BUSY: 'retry', SERVICE_UNAVAILABLE: 'retry',
  BAD_INPUT: 'input', NOT_FOUND: 'input', INPUT_TOO_LARGE: 'input'
};
const RETRYABLE = new Set(['AI_REQUEST_TIMEOUT', 'AI_NETWORK_ERROR', 'AI_SERVICE_UNAVAILABLE']);
const fail = (code, message, extra = {}) => Object.assign(new Error(message || MESSAGES[code] || code), { code }, extra);

function createDemoAdapter({ baseUrl = 'http://127.0.0.1:8787', stepDelayMs = 300, trialUnits = 100, standardUnits = 1000 } = {}) {
  const accounts = new Map(); // uid → account
  const tasks = new Map();    // uid|attemptId → task
  const drafts = new Map();   // recordId → draft
  const failures = [];        // injected failures: { step, code, times }
  const calls = [];           // steps actually sent (for tests): { uid, step, attemptId }
  let paused = null;          // a promise steps wait on (tests: "the site is still working")
  const site = baseUrl.replace(/\/$/, '') + '/demo-site/';

  // ---------------------------------------------------------------- demo accounts (the demo site's own controls)
  const demo = {
    createAccount(phone) {
      const uid = 'demo_' + sha256('uid|' + phone).slice(0, 16);
      if (!accounts.has(uid)) accounts.set(uid, { phone, tier: 'trial', total: trialUnits, used: 0, trialExpiresAt: Date.now() + 24 * 3600 * 1000, expiresAt: null, disabled: false });
      return uid;
    },
    account: (uid) => accounts.get(uid) || null,
    accounts: () => [...accounts.entries()].map(([uid, a]) => ({ uid, phone: a.phone, tier: a.tier })),
    activateMembership(uid) { const a = accounts.get(uid); Object.assign(a, { tier: 'standard', total: standardUnits, used: 0, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); },
    endTrial(uid) { Object.assign(accounts.get(uid), { tier: 'none', total: 0, used: 0 }); },
    setUsed(uid, used) { accounts.get(uid).used = used; },
    disable(uid, value = true) { accounts.get(uid).disabled = value; },
    changePhone(uid, phone) { accounts.get(uid).phone = phone; },
    removePhone(uid) { accounts.get(uid).phone = ''; },
    failNext(step, code, times = 1) { failures.push({ step, code, times }); },
    pause() { let release; paused = new Promise((resolve) => { release = resolve; }); return () => { paused = null; release(); }; },
    calls, tasks, drafts
  };

  const phoneLabel = (phone) => phone.slice(0, 3) + ' ···· ' + phone.slice(-4);
  function verified(uid) {
    const a = accounts.get(uid);
    if (!a || !a.phone) throw fail('MEMBER_LOGIN_REQUIRED');
    if (a.disabled) throw fail('MEMBER_ACCOUNT_DISABLED');
    return a;
  }
  function status(uid) {
    const a = verified(uid);
    const remaining = Math.max(0, a.total - a.used);
    return { tier: a.tier, tierName: TIER_NAMES[a.tier], quotaPercent: a.total ? Math.round(remaining / a.total * 100) : 0, exhausted: a.tier !== 'none' && remaining <= 0,
      unlimited: false, expiresAt: a.expiresAt, trialExpiresAt: a.tier === 'trial' ? a.trialExpiresAt : null, phoneLabel: phoneLabel(a.phone) };
  }
  const memberStop = (s) => {
    if (s.tier === 'none') return 'MEMBER_REQUIRED';
    if (s.exhausted) return s.tier === 'trial' ? 'MEMBER_TRIAL_EXHAUSTED' : 'MEMBER_QUOTA_EXHAUSTED';
    return null;
  };

  // ---------------------------------------------------------------- one paid step, the way the site runs it
  async function runStep(uid, step, attemptId, work) {
    const key = uid + '|' + attemptId;
    const prior = tasks.get(key);
    if (prior) {
      if (prior.status === 'done') return prior.result;
      if (prior.status === 'running') throw fail('TASK_RUNNING', '（演示）这一步还在进行。');
      if (!RETRYABLE.has(prior.code)) throw fail(prior.code, prior.message);
    }
    const a = verified(uid);
    if (a.tier === 'none') throw fail('MEMBER_REQUIRED'); // refused before any work: no task is recorded
    tasks.set(key, { status: 'running', startedAt: Date.now() });
    calls.push({ uid, step, attemptId });
    if (paused) await paused;
    if (stepDelayMs) await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    const injected = failures.find((f) => f.step === step && f.times > 0);
    if (injected) {
      injected.times -= 1;
      tasks.set(key, { status: 'failed', code: injected.code, message: MESSAGES[injected.code] || injected.code });
      throw fail(injected.code);
    }
    if (a.total - a.used < COST[step]) { // refused during the step: the task keeps this outcome for its id
      const code = a.tier === 'trial' ? 'MEMBER_TRIAL_EXHAUSTED' : 'MEMBER_QUOTA_EXHAUSTED';
      tasks.set(key, { status: 'failed', code, message: MESSAGES[code] });
      throw fail(code);
    }
    a.used += COST[step];
    const result = work();
    tasks.set(key, { status: 'done', result });
    return result;
  }

  function saveDraft(uid, title, text, action) {
    const recordId = 'demo_history_' + randomUUID().replace(/-/g, '').slice(0, 20);
    drafts.set(recordId, { owner: uid, title, action, createdAt: Date.now(), versions: [{ text, createdAt: Date.now() }] });
    return recordId;
  }
  function ownDraft(uid, recordId) {
    const d = drafts.get(recordId);
    if (!d || d.owner !== uid) throw new ServiceError('NOT_FOUND', '没有找到这篇成稿。');
    return d;
  }
  const demoArticle = (title, request) => `${title}\n\n【演示稿】这篇是本地演示站生成的示例文字，不是邪修笔法网站写的。\n\n　　一、工作目标\n\n　　根据“${request.slice(0, 60)}”的要求，XX（待补充：具体数字）项任务按期完成。\n\n　　二、主要措施\n\n　　（演示正文）`;
  const titleFrom = (request) => (request.replace(/^(帮我|请|给我)?(写|起草)(一份|一篇|个)?/, '').split(/[，。,.\n]/)[0] || '').slice(0, 30);

  // ---------------------------------------------------------------- the site's flow as steps
  const flow = {
    kinds: ['write', 'revise', 'polish'],
    newJob(kind, params) {
      const text = (v, name, max, required) => {
        if (v === undefined || v === null || v === '') { if (required) throw new ServiceError('BAD_INPUT', `缺少${name}。`); return ''; }
        if (typeof v !== 'string' || v.length > max) throw new ServiceError('BAD_INPUT', `${name}不正确或过长（最多 ${max} 字）。`);
        return v;
      };
      const p = {};
      if (kind === 'write') {
        p.request = text(params.request, '写作需求', 20000, true);
        p.material = text(params.material, '素材', 120000);
        for (const k of ['title', 'words', 'level', 'audience', 'purpose', 'speaker']) p[k] = text(params[k], k, 300);
        p.mode = params.mode === 'quick' ? 'quick' : 'six';
      } else if (kind === 'revise') {
        p.recordId = text(params.recordId, '成稿记录编号', 100, true);
        p.instruction = text(params.instruction, '修改要求', 20000, true);
        p.baseVersion = params.baseVersion || null;
      } else if (kind === 'polish') {
        p.text = text(params.text, '待润色的文字', 120000, true);
        p.requirements = text(params.requirements, '润色要求', 4000);
      } else throw new ServiceError('BAD_INPUT', '不支持的操作：' + kind);
      const first = kind === 'write' ? (p.mode === 'quick' ? 'quick' : 'intake') : kind;
      const steps = kind === 'write' ? (p.mode === 'quick' ? ['quick'] : ['intake', 'manual', 'write']) : [kind];
      return { kind, params: p, step: first, attempts: Object.fromEntries(steps.map((s) => [s, 'demo_' + randomUUID()])), data: {}, done: [] };
    },
    stage: (f) => STAGES[f.step] || '',
    doneSteps: (f) => (f.done || []).map((s) => STEP_NAMES[s]).filter(Boolean),
    isStillRunning: (error) => error?.code === 'TASK_RUNNING',
    async advance(uid, f, deps) {
      try {
        return await advanceStep(uid, f, deps);
      } catch (error) {
        if (CATEGORY[error?.code] === 'membership') error.member = safeStatus(uid);
        throw error;
      }
    },
    classify(error) {
      const code = error?.code || 'FAILED';
      return { category: CATEGORY[code] || 'final', code, message: error?.message || '写作没有完成。', ...(error?.details ? { details: error.details } : {}),
        ...(error?.member ? { member: error.member } : {}) };
    },
    // Going on after a stop: a refused step gets a fresh task id (its old id keeps the refusal); a temporary failure keeps
    // its id (the site runs it again, or hands back the run that finished meanwhile); settings the person added are used.
    resume(f, stop, overrides = {}) {
      const next = { ...f, attempts: { ...f.attempts }, params: { ...f.params }, data: { ...f.data } };
      if (stop.category !== 'retry') next.attempts[f.step] = 'demo_' + randomUUID();
      for (const k of ['title', 'words', 'level', 'audience', 'purpose', 'speaker']) if (overrides[k]) next.params[k] = overrides[k];
      if (overrides.material) next.params.material = [next.params.material, overrides.material].filter(Boolean).join('\n');
      if (next.data.settings) next.data.settings = { ...next.data.settings, ...(overrides.title ? { title: overrides.title } : {}), ...(overrides.words ? { words: overrides.words } : {}) };
      return next;
    }
  };

  async function advanceStep(uid, f, { progress } = {}) {
    const step = f.step;
    progress?.(STAGES[step]);
    const p = f.params;
    const finished = (result) => ({ flow: { ...f, step: 'done', done: [...(f.done || []), step] }, done: true, result });
    const next = (data, nextStep) => ({ flow: { ...f, data: { ...f.data, ...data }, step: nextStep, done: [...(f.done || []), step] }, done: false });
    if (step === 'intake') {
      const settings = await runStep(uid, step, f.attempts.intake, () => ({ title: p.title || titleFrom(p.request), words: p.words || 'recommend', level: p.level || '通用' }));
      return next({ settings }, 'manual');
    }
    if (step === 'manual') {
      const settings = f.data.settings;
      if (!settings.title) throw fail('SETTINGS_INCOMPLETE', '（演示）请先填写标题。', { details: { missing: ['标题'], settings: { 标题: '', 总字数: settings.words } } });
      const prompt = await runStep(uid, step, f.attempts.manual, () => ({ modules: { struct: '一、目标；二、措施；三、保障' } }));
      return next({ prompt }, 'write');
    }
    if (step === 'write' || step === 'quick') {
      const title = f.data.settings?.title || p.title || titleFrom(p.request) || '演示稿';
      const out = await runStep(uid, step, f.attempts[step], () => {
        const text = demoArticle(title, p.request);
        return { title, text, recordId: saveDraft(uid, title, text, 'write'), version: 1 };
      });
      const settings = f.data.settings ? { settings: { 标题: f.data.settings.title, 总字数: f.data.settings.words, 行政层级: f.data.settings.level } } : {};
      return finished({ kind: 'article', ...out, method: step === 'quick' ? '传统方式一键生成文章（演示）' : '用六模块提示词写（演示）', ...settings });
    }
    if (step === 'revise') {
      const draft = ownDraft(uid, p.recordId);
      const out = await runStep(uid, step, f.attempts.revise, () => {
        const base = draft.versions[(p.baseVersion || draft.versions.length) - 1].text;
        const text = base + '\n\n　　（演示：已按“' + p.instruction.slice(0, 40) + '”修改）';
        draft.versions.push({ text, createdAt: Date.now() });
        return { title: draft.title, text, recordId: p.recordId, version: draft.versions.length };
      });
      return finished({ kind: 'article', ...out, method: '继续修改（演示）' });
    }
    if (step === 'polish') {
      const out = await runStep(uid, step, f.attempts.polish, () => ['版本一 · 规范表达', '版本二 · 重构全文'].map((label) => {
        const text = `【演示润色·${label}】\n${p.text}`;
        return { label, text, recordId: saveDraft(uid, '润色稿', text, 'polish'), version: 1 };
      }));
      return finished({ kind: 'polish', variants: out, analysis: '（演示）修改说明。' });
    }
    throw new ServiceError('BAD_INPUT', '任务状态不正确。');
  }
  function safeStatus(uid) { try { return uid ? status(uid) : null; } catch { return null; } }

  return {
    demo,
    info: {
      name: '邪修笔法演示站', domain: '本机演示，不是 xiexiubifa.cn', siteUrl: site, membershipUrl: site + 'membership',
      membershipWhere: '演示站首页的「会员中心」', draftsWhere: '演示站的「成稿记录」', connectionsWhere: '演示站「会员中心 → 已连接的 AI 助手」',
      accountWhere: '演示站首页和「会员中心」页面上', switchAccount: '在演示站的登录页用另一个手机号登录',
      feeNotes: ['（演示）新账号有 24 小时免费体验，额度有限；用完后需要开通会员（演示站里点一下即可，不付款）。']
    },
    async identity(uid) {
      const a = verified(uid);
      return { accountKey: sha256(uid), bindingId: 'ph_' + sha256('bind|' + a.phone).slice(0, 24), phoneLabel: phoneLabel(a.phone) };
    },
    async membership(uid) {
      try { return { ok: true, status: status(uid) }; } catch (error) { return { ok: false, code: error.code, message: error.message }; }
    },
    async plans() { return [{ name: '标准版（演示）', note: '演示站价格，不是真实价格', prices: [{ period: '月', yuan: '0（演示）' }] }]; },
    async earlyStop(uid, kind) {
      let s;
      try { s = status(uid); } catch (error) { return { category: CATEGORY[error.code] || 'login', code: error.code, message: error.message }; }
      const code = memberStop(s);
      return code ? { category: 'membership', code, message: MESSAGES[code], member: s } : null;
    },
    flow,
    async drafts(uid) {
      verified(uid);
      return [...drafts.entries()].filter(([, d]) => d.owner === uid).sort((a, b) => b[1].createdAt - a[1].createdAt)
        .map(([recordId, d]) => ({ recordId, title: d.title, versions: d.versions.length, createdAt: d.createdAt }));
    },
    async draft(uid, recordId, version) {
      const d = ownDraft(uid, recordId);
      const v = version || d.versions.length;
      if (!d.versions[v - 1]) throw new ServiceError('NOT_FOUND', '没有这一稿。');
      return { recordId, title: d.title, text: d.versions[v - 1].text, version: v, versions: d.versions.length };
    },
    async wordFile(uid, recordId, version) {
      const d = await this.draft(uid, recordId, version);
      return { name: (d.title || '成稿') + '（演示）.docx', base64: docx(d.text).toString('base64'), recordId, version: d.version };
    },
    async documentTypes(uid, subKey) {
      const types = [{ key: 'demo-notice', name: '通知（演示）' }, { key: 'demo-plan', name: '工作方案（演示）' }, { key: 'demo-speech', name: '讲话稿（演示）' }];
      if (subKey) return { text: `（演示）${subKey} 的结构方案：一、目标；二、措施；三、保障。`, structured: { doc_type: subKey, structures: [{ id: 'demo-1', name: '目标—措施—保障' }] } };
      return { text: types.map((t) => `- ${t.key}：${t.name}`).join('\n'), structured: { types } };
    }
  };
}

module.exports = { createDemoAdapter };
