// The consent page in a real (headless) browser, on the demo site: the person is not logged in, logs in on the site,
// comes back to the same request, reads what the connection does and costs, presses 允许连接, and the browser goes
// back to the client with a code the client can exchange. Then the device flow: the person types the code shown in
// their AI assistant; and a browser logged into the wrong account switches to the other one on the page. Uses a fresh
// temporary browser profile. Skipped when no Chrome/Chromium is found (set XXB_TEST_BROWSER); XXB_SCREENSHOT_DIR keeps
// screenshots of the pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { start, pkce, form, register, post } from './helpers.mjs';
import { findBrowser, launch } from './cdp.mjs';

const browserPath = findBrowser();
const shot = (browser, name) => (process.env.XXB_SCREENSHOT_DIR ? browser.screenshot(path.join(process.env.XXB_SCREENSHOT_DIR, name)) : null);

test('consent page in a browser: log in on the site, read, allow, back to the client with a code; device code entry; switching account', { skip: browserPath ? false : 'needs Node 22+ and Chrome/Chromium (set XXB_TEST_BROWSER)' }, async () => {
  const env = await start();
  const received = [];
  const client = http.createServer((req, res) => { received.push(req.url); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<p id="ok">已回到 AI 助手</p>'); });
  await new Promise((resolve) => client.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${client.address().port}/oauth/callback`;
  const browser = await launch(browserPath);
  try {
    console.log('# browser: ' + await browser.version());
    const registered = await register(env.base, [redirect]);
    const { verifier, challenge } = pkce();
    await browser.navigate(env.base + '/oauth/authorize?' + form({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, code_challenge: challenge,
      code_challenge_method: 'S256', state: 'browser-state', scope: 'write drafts:read account:read', resource: env.base + '/mcp' }));
    await browser.waitFor(`document.querySelector('[data-xc="login"]')`);
    assert.match(await browser.evaluate('document.body.innerText'), /请先用手机号登录网站，登录后会回到这一步/);
    await browser.evaluate(`document.querySelector('[data-xc="login"]').click()`);
    await browser.waitFor(`location.pathname === '/demo-site/login' && !!document.querySelector('#login') && document.documentElement.dataset.ready === 'true'`);
    await browser.evaluate(`(() => { const f = document.querySelector('#login'); f.elements.phone.value = '13800001234'; f.requestSubmit(); })()`);
    await browser.waitFor(`!!document.querySelector('[data-xc="approve"]')`);
    const text = await browser.evaluate('document.body.innerText');
    for (const phrase of ['连接 AI 助手', '「WorkBuddy」请求连接你的', '138 ···· 1234', '名称由这个程序自己提供', '本机地址 127.0.0.1', '连接后它可以', '会发送哪些内容', '保存在哪里、保存多久',
      '费用', '连接本身免费', '你现在：', '连接后不能做的事', '你的选择', '可以不允许', '允许连接', '不允许', '只有你刚刚在自己的 AI 助手里发起连接时']) {
      assert.ok(text.includes(phrase), 'the page shows: ' + phrase);
    }
    await shot(browser, 'consent-authorize.png');
    await browser.evaluate(`document.querySelector('[data-xc="approve"]').click()`);
    await browser.waitFor(`!!document.querySelector('#ok')`);
    const back = new URL(received.at(-1), redirect);
    assert.equal(back.searchParams.get('state'), 'browser-state');
    const token = await post(env.base + '/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: registered.client_id, code_verifier: verifier, resource: env.base + '/mcp' }, { asForm: true });
    assert.equal(token.status, 200, JSON.stringify(token.data));

    // Device flow: the person types the code their assistant shows (already logged in on the site now).
    const device = (await post(env.base + '/oauth/device_authorization', { client_id: 'xiexiubifa-agent-skill', client_hint: 'Claude Code' }, { asForm: true })).data;
    await browser.navigate(device.verification_uri);
    await browser.waitFor(`!!document.querySelector('[data-xc-form]')`);
    await browser.evaluate(`(() => { const f = document.querySelector('[data-xc-form]'); f.elements.code.value = 'BBBB'; f.requestSubmit(); })()`);
    await browser.waitFor(`document.querySelector('.xc-message.is-error')?.textContent.includes('8 个字母')`);
    await browser.evaluate(`(() => { const f = document.querySelector('[data-xc-form]'); f.elements.code.value = '${device.user_code.toLowerCase()}'; f.requestSubmit(); })()`);
    await browser.waitFor(`!!document.querySelector('[data-xc="approve"]')`);
    const deviceText = await browser.evaluate('document.body.innerText');
    assert.ok(deviceText.includes('请核对授权码：' + device.user_code));
    assert.ok(deviceText.includes('连接方式：授权码'));
    assert.ok(!deviceText.includes('允许后会回到'), 'no redirect is promised in the device flow');
    assert.ok(deviceText.includes('Claude Code'));
    await shot(browser, 'consent-device.png');
    await browser.evaluate(`document.querySelector('[data-xc="approve"]').click()`);
    await browser.waitFor(`document.body.innerText.includes('已允许。请回到 AI 助手里继续')`);
    await new Promise((r) => setTimeout(r, 1100));
    const poll = await post(env.base + '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'xiexiubifa-agent-skill' }, { asForm: true });
    assert.equal(poll.status, 200, JSON.stringify(poll.data));
    assert.equal(poll.data.account_label, '138 ···· 1234', 'the token response names the account that was connected');

    // 会员中心 shows the two connected assistants with 断开.
    await browser.navigate(env.base + '/demo-site/membership');
    await browser.waitFor(`document.querySelectorAll('[data-xc-revoke]').length === 2`);
    await shot(browser, 'connections.png');

    // The browser is logged into the wrong account: the page says the logged-in account is the one that gets
    // connected; 换一个账号 goes through the site's login and comes back to the same request with the other account.
    const second = (await post(env.base + '/oauth/device_authorization', { client_id: 'xiexiubifa-agent-skill' }, { asForm: true })).data;
    await browser.navigate(second.verification_uri_complete);
    await browser.waitFor(`!!document.querySelector('[data-xc="switch"]')`);
    const before = await browser.evaluate('document.body.innerText');
    assert.ok(before.includes('138 ···· 1234') && before.includes('这是这个浏览器里现在登录的账号，允许后连接的就是它'));
    await browser.evaluate(`document.querySelector('[data-xc="switch"]').click()`);
    await browser.waitFor(`location.pathname === '/demo-site/login' && !!document.querySelector('#login') && document.documentElement.dataset.ready === 'true'`);
    await browser.evaluate(`(() => { const f = document.querySelector('#login'); f.elements.phone.value = '13900005678'; f.requestSubmit(); })()`);
    await browser.waitFor(`!!document.querySelector('[data-xc="approve"]') && document.body.innerText.includes('139 ···· 5678')`);
    assert.ok((await browser.evaluate('document.body.innerText')).includes('请核对授权码：' + second.user_code), 'back on the same request');
    await shot(browser, 'consent-switched-account.png');
    await browser.evaluate(`document.querySelector('[data-xc="approve"]').click()`);
    await browser.waitFor(`document.body.innerText.includes('已允许。请回到 AI 助手里继续')`);
    await new Promise((r) => setTimeout(r, 1100));
    const switched = await post(env.base + '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: second.device_code, client_id: 'xiexiubifa-agent-skill' }, { asForm: true });
    assert.equal(switched.status, 200, JSON.stringify(switched.data));
    assert.equal(switched.data.account_label, '139 ···· 5678', 'the account chosen on the page is the one connected');
    assert.notEqual(switched.data.account_ref, poll.data.account_ref);
  } finally {
    await browser.close();
    client.closeAllConnections?.();
    client.close();
    await env.close();
  }
});
