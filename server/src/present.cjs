'use strict';
// Tool results: a plain-language text for the person (via the AI host) and the same facts as structured data.
//
// The texts state what happened, the site's own words, where to act on the site, and which tool continues — nothing
// that tells the host what it may or may not do. A draft is passed on exactly as the site returned it, between two
// marker lines, with its source; when there is no draft the text says so and contains none. Results name the connected
// account (masked phone), so a person whose browser is logged into another account can notice it.
const when = (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const BEGIN = '———— 稿件原文开始 ————';
const END = '———— 稿件原文结束 ————';

const STATUS = {
  running: 'running', done: 'done', cancelled: 'cancelled', deleted: 'deleted',
  membership: 'needs_membership', settings: 'needs_more_info', login: 'needs_login', retry: 'temporarily_failed',
  disabled: 'account_disabled', connection: 'connection_closed', input: 'failed', final: 'failed'
};
// Results with no draft that the person can do nothing about from here are reported as tool errors; stops with a
// clear next step on the site (membership, more information, logging in again) are ordinary results.
const ERROR_STATUSES = new Set(['temporarily_failed', 'account_disabled', 'failed', 'connection_closed']);

function statusOf(view) {
  if (view.state === 'running') return 'running';
  if (view.state === 'done') return 'done';
  if (view.state === 'deleted') return 'deleted';
  if (view.state === 'cleared') return 'cleared';
  if (view.state === 'cancelled' && view.stop?.category !== 'connection') return 'cancelled';
  return STATUS[view.stop?.category] || 'failed';
}

const memberLine = (member) => {
  if (!member) return '';
  const quota = member.unlimited ? '额度不限' : typeof member.quotaPercent === 'number' ? `剩余额度约 ${member.quotaPercent}%` : '';
  return [member.tierName, quota].filter(Boolean).join('，');
};

function draftBlock(draft, info) {
  const source = `来源：${info.name}（${info.domain}）成稿记录 ${draft.recordId} · 第 ${draft.version} 稿${draft.method ? ' · ' + draft.method : ''}`;
  const pending = (String(draft.text).match(/待补充/g) || []).length;
  return { source, text: [source, BEGIN, draft.text, END, pending ? `稿中有 ${pending} 处“待补充”，需要用真实信息补上。` : ''].filter(Boolean).join('\n') };
}

// view: a job as jobs.cjs reports it. started: the call that created the job (or sent the same request again).
function jobResult(view, { site, phoneLabel, started = false } = {}) {
  const info = site.info;
  const status = statusOf(view);
  const id = view.jobId;
  const lines = [];
  const structured = { status, job_id: id, kind: view.kind, ...(phoneLabel ? { account: phoneLabel } : {}) };
  const links = [];
  const accountNote = phoneLabel ? `（账号：${phoneLabel}）` : '';
  if (view.requestReused) {
    lines.push(`这是之前已经交给${info.name}的同一个请求（同一个 request_id）：这次没有重复写，也没有再使用额度。`);
    structured.request_reused = true;
  }
  if (status === 'done' && view.result?.kind === 'polish') {
    lines.push(`${info.name}已润色，返回 ${view.result.variants.length} 个版本（都已存进网站的成稿记录；按网站会员规则使用了账号的额度${accountNote}）：`);
    structured.variants = view.result.variants.map((v) => ({ label: v.label, text: v.text, record_id: v.recordId, version: v.version,
      source: `${info.name}（${info.domain}）成稿记录 ${v.recordId} · 第 ${v.version} 稿` }));
    for (const v of view.result.variants) {
      lines.push('', `【${v.label}】`, draftBlock({ ...v, method: '智能润色' }, info).text);
    }
    if (view.result.analysis) { lines.push('', '网站的修改说明：', view.result.analysis); structured.analysis = view.result.analysis; }
  } else if (status === 'done') {
    const r = view.result;
    const block = draftBlock(r, info);
    lines.push(`${info.name}已写好：《${r.title || '（无标题）'}》`, `（按网站会员规则使用了账号的额度${accountNote}；也能在${info.draftsWhere}看到。）`, '', block.text);
    structured.draft = { title: r.title || '', text: r.text, record_id: r.recordId, version: r.version, method: r.method || '', source: block.source };
    if (r.settings) structured.settings = r.settings;
    if (r.materialGuide) structured.material_note = r.materialGuide;
  } else if (status === 'running' && view.stalled) {
    lines.push(`这个写作任务的处理中断了（停在：${view.stage || '处理中'}）。任务编号：${id}`,
      `用 continue_writing（job_id=${id}）可以让它接着做；网站那边已完成的步骤不会重复发送、不会重复扣额度。`);
    structured.stage = view.stage || '';
    structured.stalled = true;
  } else if (status === 'running') {
    lines.push(`${info.name}正在写（${view.stage || '处理中'}）。任务编号：${id}`);
    if (started && !view.requestReused) lines.push(`这次由${info.name}网站处理，按网站会员规则使用账号的额度${accountNote}。`);
    lines.push(`写一篇通常要几分钟。可以用 get_writing_result（job_id=${id}）查看进度和结果；查看不会重复扣额度。`);
    structured.stage = view.stage || '';
    structured.poll_after_seconds = 15;
  } else if (status === 'needs_membership') {
    const s = view.stop;
    lines.push(`这次还没有稿件：网站提示“${s.message}”`);
    const who = phoneLabel || s.member?.phoneLabel || '';
    const member = memberLine(s.member);
    if (who || member) lines.push('账号：' + (who && member ? `${who}（${member}）` : who || member));
    if (view.stillBlocked) lines.push(`刚才又查了一次：网站还没有显示${who ? ` ${who} ` : '这个账号'}的会员生效。如果刚付款，网站可能需要一会儿才更新；也请确认开通的是这个账号。`);
    lines.push(`开通或续费在网站会员中心，由账号本人在平时用的浏览器里操作：`, ` ${info.membershipUrl} `, `（也可以从${info.membershipWhere}进入。）`);
    if (who) lines.push(`打开后先确认网站上登录的是 ${who}（${info.accountWhere || '网站上'}能看到）。浏览器里登录的如果是别的手机号，开通的会是那个账号，这个任务还会停着。`);
    lines.push(`开通后，用 continue_writing（job_id=${id}）接着写：会从停下的那一步继续${view.doneSteps?.length ? `，已完成的${view.doneSteps.join('、')}不会重复扣额度` : ''}。这个请求保留到 ${when(view.expiresAt)}。`);
    links.push({ label: '会员中心', url: info.membershipUrl });
    structured.site_message = s.message;
    structured.code = s.code;
    if (s.member) structured.membership = s.member;
  } else if (status === 'needs_more_info') {
    const s = view.stop;
    const missing = s.details?.missing || [];
    lines.push(`网站需要先补充信息才能继续：${s.message}`);
    if (missing.length) lines.push(`缺少：${missing.join('、')}`);
    if (s.details?.settings) lines.push('网站目前的设定：' + Object.entries(s.details.settings).map(([k, v]) => `${k}：${v || '（空）'}`).join('；'));
    lines.push(`补充后，用 continue_writing（job_id=${id}，带上补充的 title、words、level、audience、purpose 或 speaker）接着写${view.doneSteps?.length ? `；已完成的${view.doneSteps.join('、')}不会重复扣额度` : ''}。`);
    structured.site_message = s.message;
    structured.missing = missing;
    if (s.details?.settings) structured.settings = s.details.settings;
  } else if (status === 'needs_login') {
    const s = view.stop;
    lines.push(`网站没有确认这个账号的登录：“${s.message}”`,
      `需要在 AI 助手里重新连接${info.name}账号：浏览器会打开${info.name}网站，用同一个手机号${phoneLabel ? `（${phoneLabel}）` : ''}登录后点「允许」。用别的账号连接的话，这个任务接不上（任务只属于开始它的账号）。`,
      `连好后，用 continue_writing（job_id=${id}）接着写，请求还保留着。`);
    links.push({ label: info.name + '网站', url: info.siteUrl });
    structured.site_message = s.message;
  } else if (status === 'temporarily_failed') {
    const s = view.stop;
    lines.push(`这一步暂时没有完成：${s.message}`,
      `请求和已完成的步骤都还保留着，可以稍后用 continue_writing（job_id=${id}）再试；已完成的步骤不会重复扣额度。`);
    structured.site_message = s.message;
    structured.code = s.code;
  } else if (status === 'account_disabled') {
    lines.push(`网站提示：“${view.stop.message}”`, '这个账号暂时不能使用，需要联系网站处理；开通会员解决不了这个问题。');
    structured.site_message = view.stop.message;
  } else if (status === 'connection_closed') {
    lines.push(view.stop.message);
  } else if (status === 'cleared') {
    const records = view.records || [];
    lines.push(view.clearedReason === 'deleted'
      ? '这个写作任务已经结束，它保存的需求、素材和进度已按要求删除。'
      : '这个写作任务已经结束，过了保留期限，保存的需求、素材和进度已经清理。');
    if (records.length) {
      lines.push(`成稿在网站的成稿记录里（${info.draftsWhere}）：` + records.map((r) => `${r.label ? r.label + ' ' : ''}成稿记录 ${r.recordId} · 第 ${r.version} 稿`).join('；') + '。可以用 get_draft 读取。');
    } else if (view.endState && view.endState !== 'done') {
      lines.push('这个任务当时没有写成稿件。');
    }
    if (view.requestReused) lines.push('需要重新写的话，发一个新的请求（换一个 request_id，或者不带 request_id）；新的请求会再使用一次额度。');
    structured.cleared_reason = view.clearedReason;
    structured.records = records.map((r) => ({ record_id: r.recordId, version: r.version, ...(r.label ? { label: r.label } : {}) }));
  } else if (status === 'cancelled' || status === 'deleted') {
    lines.push(status === 'deleted' ? '已删除这个写作任务保存的需求、素材和进度。已经生成的成稿仍在网站的成稿记录里。' : '已取消这个写作任务。');
    if (view.wasRunning) lines.push('如果取消时那一步已经发给网站，网站可能仍会写完并存进成稿记录（照常使用额度）。');
  } else {
    const s = view.stop || {};
    lines.push(`这次没有生成稿件：${s.message || '写作没有完成。'}`);
    structured.site_message = s.message || '';
    structured.code = s.code || 'FAILED';
  }
  if (links.length) structured.links = links;
  if (view.expiresAt && !['done', 'deleted', 'cleared'].includes(status)) structured.kept_until = new Date(view.expiresAt).toISOString();
  if (view.doneSteps?.length) structured.done_steps = view.doneSteps;
  return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: structured, isError: ERROR_STATUSES.has(status) };
}

// paid: the call could have started or continued paid work. An unexpected failure there leaves the outcome open, and
// the text says so instead of claiming nothing happened.
function errorResult(error, { paid = false, requestId = '', jobId = '' } = {}) {
  const code = error?.code || 'ERROR';
  let message = error?.code ? error.message : '写作服务暂时没有响应，请稍后再试。';
  if (!error?.code && paid) {
    message = '写作服务这次没有处理完，不确定网站有没有开始写。' + (jobId
      ? `用 get_writing_result（job_id=${jobId}）可以查看任务现在的状态；再调用 continue_writing 不会让已完成的步骤重复扣额度。`
      : requestId
        ? `用同一个 request_id（${requestId}）再调用一次就能知道结果：已经开始的任务会原样返回，不会重复写、不会重复使用额度。`
        : '过几分钟可以用 list_drafts 看看网站成稿记录里有没有这一篇，再决定要不要重新写（重新写会再使用一次额度）。');
  }
  return { content: [{ type: 'text', text: message }], structuredContent: { status: 'error', code, message, ...(!error?.code && paid ? { outcome: 'unknown' } : {}), ...(error?.details ? { details: error.details } : {}) }, isError: true };
}

function textResult(text, structured, isError = false) {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError };
}

module.exports = { jobResult, errorResult, textResult, draftBlock, memberLine, when, BEGIN, END };
