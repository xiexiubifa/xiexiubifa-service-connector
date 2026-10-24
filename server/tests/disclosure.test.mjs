// What the person and the AI host are told: the consent page's disclosure, the service description, and the wording of
// every tool result — factual, with the site's own words and next step, no draft text when there is none, and nothing
// that steers the host's own judgement or keeps options from the person.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start, connect, register, pkce, form, person, rpc } from './helpers.mjs';
import { bannedIn, gluedUrls } from './wording.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { jobResult, BEGIN } = require('../src/present.cjs');
const { TOOLS } = require('../src/tools.cjs');
const { createDemoAdapter } = require('../demo/demo-adapter.cjs');

let env;
before(async () => { env = await start(); });
after(async () => { await env.close(); });

test('the consent page tells, before anything is allowed: provider, data, storage and retention, fees, limits, choices', async () => {
  const client = await register(env.base);
  const { challenge } = pkce();
  const auth = await fetch(env.base + '/oauth/authorize?' + form({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
  const who = await person(env, '13800001234');
  const view = (await env.service.siteAction(who, 'consent_view', { request: new URL(auth.headers.get('location')).searchParams.get('connect') })).data;
  const d = view.disclosure;
  const section = (id) => d.sections.find((s) => s.id === id).items.join('\n');
  assert.match(d.provider, /邪修笔法/);
  assert.match(section('data'), /写作要求/);
  assert.match(section('data'), /素材/);
  assert.match(section('data'), /只用于按你的要求生成和修改稿件/);
  assert.match(section('storage'), /成稿记录/);
  assert.match(section('storage'), /完成后 7 天删除/);
  assert.match(section('storage'), /保留 30 天/);
  assert.match(section('storage'), /随时让 AI 助手取消任务并删除/);
  assert.match(section('storage'), /任务编号和成稿记录编号保留 30 天（不含需求、素材和稿件）/, 'what stays after deletion is disclosed');
  assert.match(section('fees'), /连接本身免费/);
  assert.match(section('fees'), /按网站会员规则使用你账号的额度/);
  assert.match(section('fees'), /AI 助手不能替你付款/);
  assert.match(section('cannot'), /付款/);
  assert.match(section('cannot'), /修改手机号/);
  assert.match(section('choices'), /可以不允许/);
  assert.match(section('choices'), /断开/);
  assert.match(section('choices'), /用别的方式/, 'the person is told they can use another way');
  assert.equal(d.plans.length, 1, 'plan prices come from the site');
  assert.equal(d.membership.tier, 'trial', 'and the person sees their current membership');
  assert.deepEqual(view.scopes.map((s) => s.id), ['write', 'drafts:read', 'account:read']);
  assert.ok(view.scopes.every((s) => s.text.length > 10));
});

test('every tool result status: factual wording, the site\'s words, clickable links, and no draft when there is none', () => {
  const site = createDemoAdapter({ baseUrl: 'http://127.0.0.1:9' });
  const member = { tier: 'trial', tierName: '首日免费体验', quotaPercent: 0, exhausted: true, phoneLabel: '138 ···· 1234' };
  const base = { jobId: 'wj_' + 'a'.repeat(32), kind: 'write', expiresAt: Date.now() + 86400000, doneSteps: ['基础设定'] };
  const views = [
    { ...base, state: 'running', stage: '文章：AI 正在写作…' },
    { ...base, state: 'running', stage: '文章：AI 正在写作…', stalled: true },
    { ...base, state: 'done', result: { kind: 'article', title: '标题', text: '标题\n\n正文（待补充：数字）', recordId: 'history_x', version: 1, method: '用六模块提示词写' } },
    { ...base, state: 'done', result: { kind: 'polish', variants: [{ label: '版本一', text: '一', recordId: 'h1', version: 1 }, { label: '版本二', text: '二', recordId: 'h2', version: 1 }], analysis: '说明' } },
    { ...base, state: 'blocked', stop: { category: 'membership', code: 'MEMBER_TRIAL_EXHAUSTED', message: '免费体验额度已用完。', member } },
    { ...base, state: 'blocked', stillBlocked: true, stop: { category: 'membership', code: 'MEMBER_REQUIRED', message: '请开通会员。', member } },
    { ...base, state: 'blocked', stop: { category: 'settings', code: 'SETTINGS_INCOMPLETE', message: '请先填写标题。', details: { missing: ['标题'], settings: { 标题: '' } } } },
    { ...base, state: 'blocked', stop: { category: 'login', code: 'MEMBER_LOGIN_REQUIRED', message: '请先用手机号登录。' } },
    { ...base, state: 'failed', stop: { category: 'retry', code: 'AI_SERVICE_UNAVAILABLE', message: '服务繁忙。' } },
    { ...base, state: 'failed', stop: { category: 'disabled', code: 'MEMBER_ACCOUNT_DISABLED', message: '账号暂不可用。' } },
    { ...base, state: 'failed', stop: { category: 'final', code: 'CONTENT_BLOCKED', message: '内容未通过检查。' } },
    { ...base, state: 'cancelled', wasRunning: true, stop: { category: 'cancelled', message: '已取消。' } },
    { ...base, state: 'cancelled', stop: { category: 'connection', code: 'CONNECTION_CLOSED', message: '账号连接已断开。' } },
    { jobId: base.jobId, state: 'deleted', wasRunning: false },
    { ...base, state: 'running', stage: '文章：AI 正在写作…', started: true },
    { ...base, state: 'done', requestReused: true, result: { kind: 'article', title: '标题', text: '正文', recordId: 'history_x', version: 1 } },
    { jobId: base.jobId, kind: 'write', state: 'cleared', clearedReason: 'expired', endState: 'done', records: [{ recordId: 'history_x', version: 2 }], requestReused: true, expiresAt: base.expiresAt },
    { jobId: base.jobId, kind: 'polish', state: 'cleared', clearedReason: 'deleted', endState: 'done', records: [{ recordId: 'h1', version: 1, label: '版本一' }], expiresAt: base.expiresAt },
    { jobId: base.jobId, kind: 'write', state: 'cleared', clearedReason: 'expired', endState: 'blocked', records: [], expiresAt: base.expiresAt }
  ];
  const seen = new Set();
  for (const view of views) {
    const out = jobResult(view, { site, phoneLabel: '138 ···· 1234', started: !!view.started });
    const text = out.content[0].text;
    seen.add(out.structuredContent.status);
    assert.deepEqual(bannedIn(text), [], out.structuredContent.status + ': ' + text);
    assert.deepEqual(gluedUrls(text), [], out.structuredContent.status);
    if (out.structuredContent.status !== 'done') assert.ok(!text.includes(BEGIN), out.structuredContent.status + ' carries no draft');
    if (view.stop?.message && !['cancelled', 'connection_closed'].includes(out.structuredContent.status)) assert.ok(text.includes(view.stop.message), 'the site\'s own words: ' + out.structuredContent.status);
    if (view.requestReused) assert.match(text, /同一个请求.*没有重复写/, 'a repeated request says nothing was written twice');
    if (view.state === 'cleared') assert.equal(out.isError, false);
    if (view.stop?.category === 'membership') {
      assert.ok(text.includes('打开后先确认网站上登录的是 138 ···· 1234'), 'the account to check in the browser is named');
      assert.match(text, /平时用的浏览器/);
    }
    if (view.stop?.category === 'login') assert.ok(text.includes('用同一个手机号（138 ···· 1234）登录'), 'reconnect with the same account');
  }
  assert.deepEqual([...seen].sort(), ['account_disabled', 'cancelled', 'cleared', 'connection_closed', 'deleted', 'done', 'failed', 'needs_login', 'needs_membership', 'needs_more_info', 'running', 'temporarily_failed']);
  const started = jobResult(views.find((v) => v.started), { site, phoneLabel: '138 ···· 1234', started: true }).content[0].text;
  assert.ok(started.includes('按网站会员规则使用账号的额度（账号：138 ···· 1234）'), 'the service and the quota are named when paid work starts');
});

test('tool descriptions and the server instructions carry no instructions about the host\'s own judgement', async () => {
  for (const t of TOOLS) {
    assert.deepEqual(bannedIn(t.description + ' ' + JSON.stringify(t.inputSchema)), [], t.name);
  }
  const { tokens } = await connect(env, { phone: '13800004321' });
  const init = await rpc(env, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.deepEqual(bannedIn(init.data.result.instructions), []);
});

test('the agent-facing skills and references in this repository pass the same wording check', () => {
  const root = path.resolve(here, '..', '..');
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.md$/.test(e.name)) files.push(p); } };
  for (const dir of ['connector/skills', 'agent-skill']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  assert.ok(files.length >= 2, 'the connector skill and the agent skill are present');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(bannedIn(text), [], path.relative(root, file));
  }
});

test('the consent page escapes what clients say about themselves and renders the disclosure', async () => {
  const ui = await import('../web/consent-ui.js');
  const site = createDemoAdapter({ baseUrl: 'http://127.0.0.1:9' });
  const { consentDisclosure } = require('../src/disclosure.cjs');
  const { makeConfig } = require('../src/config.cjs');
  const disclosure = consentDisclosure({ config: makeConfig({ issuer: 'http://127.0.0.1:9', consentPage: 'http://127.0.0.1:9/?c=', devicePage: 'http://127.0.0.1:9/?d=', termsUrl: 'https://example.org/terms' }), site, membership: await site.membership('nobody'), plans: [{ name: '标准版', prices: [{ period: '月', yuan: '29.9' }] }] });
  const html = ui.consentHtml({ kind: 'device', userCode: 'BCDF-GHJK', expiresAt: Date.now() + 600000, client: { name: '<img src=x onerror=alert(1)>', returnTo: '"><script>x</script>', selfNamed: true }, account: { phoneLabel: '138 ···· 1234' }, scopes: [{ id: 'write', text: '写<b>作</b>' }], disclosure });
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('<b>作'), 'everything is escaped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /请核对授权码：<b>BCDF-GHJK<\/b>/);
  assert.match(html, /名称由这个程序自己提供/);
  assert.match(html, /¥29\.9\/月/);
  assert.match(html, /允许连接/);
  assert.match(html, /不允许/);
  assert.match(html, /完整的数据与费用说明/);
  assert.match(html, /这是这个浏览器里现在登录的账号，允许后连接的就是它/, 'the page says which account gets connected');
  assert.match(html, /先在网站上退出登录，再用那个手机号登录/);
  assert.ok(!html.includes('data-xc="switch"'), 'no switch button without the site\'s own way to switch');
  const withSwitch = ui.consentHtml({ kind: 'code', client: { name: 'WorkBuddy', returnTo: 'WorkBuddy 应用' }, account: { phoneLabel: '138 ···· 1234', switchHint: '<b>x</b>' }, scopes: [], disclosure, canSwitch: true });
  assert.match(withSwitch, /data-xc="switch">换一个账号</);
  assert.match(withSwitch, /点「换一个账号」，退出后用那个手机号登录，会回到这一步/);
  const withHint = ui.consentHtml({ kind: 'code', client: {}, account: { phoneLabel: '138 ···· 1234', switchHint: '<b>x</b>' }, scopes: [], disclosure });
  assert.ok(withHint.includes('&lt;b&gt;x&lt;/b&gt;，登录后会回到这一步'), 'the site\'s hint is shown, escaped');
  for (const s of disclosure.sections) assert.ok(html.includes(s.title), s.title);
  assert.deepEqual(ui.connectRefFrom('?connect=ar_' + 'a'.repeat(32)), { request: 'ar_' + 'a'.repeat(32) });
  assert.deepEqual(ui.connectRefFrom('?connect_code=bcdf-ghjk'), { code: 'BCDF-GHJK' });
  assert.deepEqual(ui.connectRefFrom('?connect_code'), { code: '' });
  assert.equal(ui.connectRefFrom('?connect=../../x'), null);
  assert.ok(!ui.connectionsHtml([{ id: 'cg_1', clientName: '<x>', returnTo: 'WorkBuddy', createdAt: Date.now() }]).includes('<x>'));
});
