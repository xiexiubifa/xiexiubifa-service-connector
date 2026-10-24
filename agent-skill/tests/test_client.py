# -*- coding: utf-8 -*-
"""The agent skill's script against the local service (server/bin/dev-server.cjs, demo site adapter).

The person's browser is played by a cookie session on the demo site: log in with a phone number, open the consent
page's data, press 允许 (or 不允许). Everything else is the real script and the real service.

    python3 -m unittest discover -s agent-skill/tests      (needs Node 18+ for the local service)
"""
import contextlib
import http.cookiejar
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SERVER = os.path.join(ROOT, 'server', 'bin', 'dev-server.cjs')
SCRIPT = os.path.join(ROOT, 'agent-skill', 'xiexiubifa-writing', 'scripts', 'xiexiubifa.py')


def load_client():
    """The script as a module, for runs that need a different network layer (a lost answer)."""
    spec = importlib.util.spec_from_file_location('xiexiubifa_under_test', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LoseAnswerOnce(object):
    """Delivers the first call of a tool to the service, then drops the answer, as a broken connection would."""

    def __init__(self, real, tool='write_material'):
        self.real = real
        self.tool = tool
        self.dropped = 0

    def open(self, request, timeout=None):
        body = json.loads(request.data) if request.data and request.get_header('Content-type') == 'application/json' else {}
        response = self.real.open(request, timeout=timeout)
        if not self.dropped and body.get('method') == 'tools/call' and body['params']['name'] == self.tool:
            response.read()
            response.close()
            self.dropped += 1
            raise urllib.error.URLError(ConnectionResetError(104, 'Connection reset by peer'))
        return response


class LocalService(object):
    def __init__(self):
        # These tests connect many times from one address within a minute; the production limit is 10 device codes.
        self.proc = subprocess.Popen(['node', SERVER, '--port', '0', '--step-delay', '30', '--device-interval', '1', '--device-limit', '200'],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.base = None
        deadline = time.time() + 20
        while time.time() < deadline and not self.base:
            line = self.proc.stdout.readline()
            match = re.search(r'(http://127\.0\.0\.1:\d+)/mcp', line or '')
            if match:
                self.base = match.group(1)
        if not self.base:
            self.stop()
            raise RuntimeError('local service did not start')

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()


class Browser(object):
    """The person's everyday browser on the (demo) site: their own login, the consent page's calls."""

    def __init__(self, base, phone):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        assert self.api('login', {'phone': phone})['ok']

    def api(self, action, payload=None):
        request = urllib.request.Request(self.base + '/demo-site/api', data=json.dumps({'action': action, 'payload': payload or {}}).encode('utf-8'),
                                         headers={'Content-Type': 'application/json'}, method='POST')
        with self.opener.open(request, timeout=20) as response:
            return json.loads(response.read().decode('utf-8'))


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = LocalService()

    @classmethod
    def tearDownClass(cls):
        cls.service.stop()

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='xxb-skill-')
        self.outputs = []

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_script(self, *args, cwd=None, home=None):
        env = dict(os.environ, XIEXIUBIFA_HOME=home or self.home, XIEXIUBIFA_SERVICE=self.service.base + '/mcp', PYTHONIOENCODING='utf-8')
        proc = subprocess.run([sys.executable, SCRIPT] + list(args), env=env, capture_output=True, text=True, encoding='utf-8', timeout=120, cwd=cwd or self.home)
        self.outputs.append(proc.stdout + proc.stderr)
        self.assertTrue(proc.stdout.strip(), proc.stderr)
        return json.loads(proc.stdout)

    def run_in_process(self, client, *args):
        """The same command inside this process, with the client's network layer replaced (see LoseAnswerOnce)."""
        saved = dict(os.environ)
        os.environ.update(XIEXIUBIFA_HOME=self.home, XIEXIUBIFA_SERVICE=self.service.base + '/mcp')
        stdout = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                client.main(list(args))
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.outputs.append(stdout.getvalue())
        return json.loads(stdout.getvalue())

    def connected_as(self, phone):
        browser = self.connect_as(phone, self.run_script('connect'))
        self.assertEqual(self.run_script('continue', '--wait', '10')['status'], 'connected')
        return browser

    def close_connections(self, browser):
        for item in browser.api('connections_list')['data']['items']:
            self.assertTrue(browser.api('connection_revoke', {'id': item['id']})['ok'])

    def drafts_titled(self, words):
        return [d for d in self.run_script('drafts')['drafts'] if words in (d.get('title') or '')]

    def connect_as(self, phone, result):
        browser = Browser(self.service.base, phone)
        code = result['connect']['code']
        view = browser.api('consent_view', {'code': code})
        self.assertTrue(view['ok'], view)
        self.assertEqual(view['data']['userCode'], code)
        self.assertTrue(browser.api('consent_approve', {'code': code})['ok'])
        return browser

    def finish(self, result):
        for _ in range(30):
            if result.get('status') != 'running':
                return result
            result = self.run_script('result', '--job', result['job_id'], '--wait', '2')
        return result

    def assert_no_secrets(self):
        joined = '\n'.join(self.outputs)
        self.assertNotRegex(joined, r'xx[ar]_[\w-]{20,}', 'tokens never appear in the output')
        self.assertNotIn('device_code', joined)

    def test_first_write_waits_for_the_connection_then_goes_on_without_being_asked_again(self):
        first = self.run_script('write', '--request', '帮我写一份社区冬季安全生产工作方案，1500字左右', '--audience', '各小区')
        self.assertEqual(first['status'], 'needs_connection')
        self.assertIn(first['connect']['url'], first['message'])
        self.assertIn(' ' + first['connect']['url'] + ' ', first['message'], 'the link stands apart so it is clickable')
        self.assertRegex(first['connect']['code'], r'^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$')
        self.assertIn('平时用的浏览器', first['message'])
        self.assertIn('费用', first['message'])
        self.assertIn('还没有发出去', first['message'])
        self.assertIn('pending', first)
        waiting = self.run_script('continue', '--wait', '0')
        self.assertEqual(waiting['status'], 'needs_connection')
        self.assertEqual(waiting['connect']['code'], first['connect']['code'], 'the same code until it is used or expires')
        browser = self.connect_as('13800001234', first)
        done = self.finish(self.run_script('continue', '--wait', '10'))
        self.assertEqual(done['status'], 'done', done)
        self.assertIn('社区冬季安全生产工作方案', done['draft']['title'])
        self.assertIn(done['draft']['text'], done['message'])
        self.assertIn('来源：', done['message'])
        listed = browser.api('connections_list')
        self.assertEqual(len(listed['data']['items']), 1)
        self.assertIn('邪修笔法写作技能', listed['data']['items'][0]['clientName'])
        state_files = [f for f in os.listdir(self.home) if f.startswith('state-')]
        self.assertEqual(len(state_files), 1)
        if os.name != 'nt':
            mode = stat.S_IMODE(os.stat(os.path.join(self.home, state_files[0])).st_mode)
            self.assertEqual(mode, 0o600, 'the connection file is readable by its owner only')
        again = self.run_script('write', '--request', '写一份通知', '--quick')
        self.assertEqual(self.finish(again)['status'], 'done', 'connected once, used in the background after')
        self.assert_no_secrets()

    def test_membership_stop_then_the_same_request_continues(self):
        first = self.run_script('connect')
        browser = self.connect_as('13800005678', first)
        self.assertEqual(self.run_script('continue', '--wait', '10')['status'], 'connected')
        browser.api('demo_end_trial')
        stopped = self.run_script('write', '--request', '帮我写一份年终工作总结')
        self.assertEqual(stopped['status'], 'needs_membership', stopped)
        self.assertIn('membership', stopped['links'][0]['url'])
        self.assertIn('continue_writing', stopped['message'])
        browser.api('demo_activate')
        done = self.finish(self.run_script('continue', '--job', stopped['job_id']))
        self.assertEqual(done['status'], 'done', done)
        word = self.run_script('word', '--record', done['draft']['record_id'])
        self.assertTrue(os.path.isfile(word['file']))
        with zipfile.ZipFile(word['file']) as archive:
            self.assertIn('word/document.xml', archive.namelist())
        account = self.run_script('account')
        self.assertEqual(account['status'], 'ok')
        self.assertEqual(account['membership']['tier'], 'standard')
        self.assert_no_secrets()

    def test_refusing_keeps_nothing_sent_and_disconnect_forgets_the_connection(self):
        first = self.run_script('write', '--request', '写一份倡议书')
        browser = Browser(self.service.base, '13900001111')
        self.assertTrue(browser.api('consent_deny', {'code': first['connect']['code']})['ok'])
        refused = self.run_script('continue', '--wait', '5')
        self.assertEqual(refused['status'], 'connection_refused')
        self.assertIn('没有发出去', refused['message'])
        self.assertEqual(self.run_script('cancel', '--pending')['status'], 'deleted')
        second = self.run_script('connect')
        self.connect_as('13900001111', second)
        self.assertEqual(self.run_script('continue', '--wait', '10')['status'], 'connected')
        self.assertEqual(self.run_script('info')['status'], 'info')
        gone = self.run_script('disconnect')
        self.assertEqual(gone['status'], 'disconnected')
        self.assertEqual(browser.api('connections_list')['data']['items'], [], 'the service closed the connection too')
        after = self.run_script('account')
        self.assertEqual(after['status'], 'needs_connection')
        self.assert_no_secrets()

    def test_inputs_and_addresses_are_checked_before_anything_is_sent(self):
        bad = self.run_script('write', '--request', '写', '--material-file', os.path.join(self.home, 'missing.pdf'))
        self.assertEqual(bad['status'], 'bad_input')
        env = dict(os.environ, XIEXIUBIFA_HOME=self.home, XIEXIUBIFA_SERVICE='http://example.com/mcp')
        proc = subprocess.run([sys.executable, SCRIPT, 'doctor'], env=env, capture_output=True, text=True, encoding='utf-8', timeout=60)
        self.assertIn('https', json.loads(proc.stdout)['message'])
        doctor = self.run_script('doctor')
        self.assertTrue(doctor['service_reachable'])
        self.assertFalse(doctor['connected'])

    def test_lost_answer_then_continue_returns_the_same_job_without_a_second_paid_run(self):
        self.connected_as('13800002468')
        client = load_client()
        client.OPENER = LoseAnswerOnce(urllib.request.build_opener(client.NoRedirect))
        lost = self.run_in_process(client, 'write', '--request', '帮我写一份社区垃圾分类工作方案', '--quick')
        self.assertEqual(lost['status'], 'outcome_unknown', lost)
        self.assertEqual(client.OPENER.dropped, 1, 'the service received the request; only its answer was lost')
        self.assertNotIn('没有发出去', lost['message'], 'not claimed to be unsent')
        self.assertIn('不确定网站有没有开始写', lost['message'])
        self.assertIn('不会重复写', lost['message'])
        busy = self.run_script('write', '--request', '再写一份别的通知')
        self.assertEqual(busy['status'], 'pending_unresolved', 'a new paid request waits until the open one is settled')
        done = self.finish(self.run_script('continue'))
        self.assertEqual(done['status'], 'done', done)
        self.assertTrue(done.get('request_reused'), 'the service handed back the job it had already started')
        self.assertIn('没有重复写', done['message'])
        self.assertEqual(len(self.drafts_titled('社区垃圾分类工作方案')), 1, 'one draft: the paid work ran once')
        self.assertEqual(self.run_script('continue')['status'], 'connected', 'nothing is left waiting')
        self.assert_no_secrets()

    def test_lost_answer_and_an_expired_connection_reconnect_with_the_same_account_gets_the_original_request(self):
        browser = self.connected_as('13800002469')
        client = load_client()
        client.OPENER = LoseAnswerOnce(urllib.request.build_opener(client.NoRedirect))
        self.assertEqual(self.run_in_process(client, 'write', '--request', '帮我写一份节日值班安排通知', '--quick')['status'], 'outcome_unknown')
        self.close_connections(browser)  # the connection ends (closed on the site, or expired)
        again = self.run_script('continue')
        self.assertEqual(again['status'], 'needs_connection')
        self.assertIn('连接已经失效', again['message'])
        self.assertIn('138 ···· 2469', again['message'], 'the account to log in with is named')
        self.assertIn('会先用同一个请求编号确认', again['message'])
        self.assertNotIn('没有发出去', again['message'])
        self.connect_as('13800002469', again)
        done = self.finish(self.run_script('continue', '--wait', '10'))
        self.assertEqual(done['status'], 'done', done)
        self.assertTrue(done.get('request_reused'))
        self.assertEqual(len(self.drafts_titled('节日值班安排通知')), 1)

    def test_an_unconfirmed_request_is_not_sent_again_under_another_account(self):
        browser = self.connected_as('13800006802')
        client = load_client()
        client.OPENER = LoseAnswerOnce(urllib.request.build_opener(client.NoRedirect))
        self.assertEqual(self.run_in_process(client, 'write', '--request', '帮我写一份消防演练方案', '--quick')['status'], 'outcome_unknown')
        self.close_connections(browser)
        reconnect = self.run_script('continue')
        self.assertEqual(reconnect['status'], 'needs_connection')
        self.connect_as('13900006802', reconnect)  # the everyday browser was logged into another phone
        changed = self.run_script('continue', '--wait', '10')
        self.assertEqual(changed['status'], 'account_changed', changed)
        self.assertIn('138 ···· 6802', changed['message'])
        self.assertIn('139 ···· 6802', changed['message'])
        self.assertIn('continue --resend', changed['message'])
        self.assertEqual(self.run_script('drafts')['drafts'], [], 'nothing was written for the other account')
        resent = self.finish(self.run_script('continue', '--resend'))
        self.assertEqual(resent['status'], 'done', resent)
        self.assertNotIn('request_reused', resent, 'a new request, chosen by the person, for the account connected now')
        self.assertEqual(resent['account'], '139 ···· 6802')

    def test_first_word_download_keeps_version_and_path_through_connecting(self):
        self.connected_as('13800003579')
        done = self.finish(self.run_script('write', '--request', '帮我写一份冬季防火通知', '--quick'))
        record = done['draft']['record_id']
        self.assertEqual(self.finish(self.run_script('revise', '--record', record, '--instruction', '第二段写具体些'))['draft']['version'], 2)
        # Another computer, nothing connected yet: the first thing asked is version 1, into a file named relative to
        # the folder the agent works in; continuing later runs from somewhere else.
        other = tempfile.mkdtemp(prefix='xxb-skill-other-')
        work, elsewhere = os.path.join(other, 'work'), os.path.join(other, 'elsewhere')
        os.makedirs(work)
        os.makedirs(elsewhere)
        try:
            first = self.run_script('word', '--record', record, '--version', '1', '--out', os.path.join('out', '第一稿.docx'), home=other, cwd=work)
            self.assertEqual(first['status'], 'needs_connection')
            self.assertIn('下载 Word 的请求（成稿记录 %s 第 1 稿）' % record, first['message'])
            self.connect_as('13800003579', first)
            saved = self.run_script('continue', '--wait', '10', home=other, cwd=elsewhere)
            target = os.path.join(work, 'out', '第一稿.docx')
            self.assertEqual(saved.get('file'), target, saved)
            self.assertEqual(saved['version'], 1)
            with zipfile.ZipFile(target) as archive:
                text = archive.read('word/document.xml').decode('utf-8')
            self.assertIn('冬季防火通知', text)
            self.assertNotIn('已按', text, 'the first version, not the revised one')
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_connection_closed_then_the_same_account_continues_and_another_account_is_named(self):
        browser = self.connected_as('13800004680')
        browser.api('demo_end_trial')
        stopped = self.run_script('write', '--request', '帮我写一份年度述职报告')
        self.assertEqual(stopped['status'], 'needs_membership')
        self.assertIn('打开后先确认网站上登录的是 138 ···· 4680', stopped['message'])
        self.close_connections(browser)
        browser.api('demo_activate')
        again = self.run_script('continue', '--job', stopped['job_id'])
        self.assertEqual(again['status'], 'needs_connection')
        self.assertIn('连接已经失效', again['message'])
        self.assertIn('请用同一个手机号（138 ···· 4680）登录', again['message'])
        # Approving with another account: the answer says which account is connected and why the job is not there.
        self.connect_as('13900004680', again)
        other = self.run_script('continue', '--wait', '10')
        self.assertEqual(other.get('code'), 'JOB_NOT_FOUND', other)
        self.assertIn('现在连接的账号（139 ···· 4680）', other['message'])
        self.assertIn('注意：现在连接的是账号 139 ···· 4680，之前连接的是账号 138 ···· 4680', other['message'])
        # Back to the right account: the kept job goes on from where it stopped.
        self.run_script('disconnect')
        back = self.run_script('continue', '--job', stopped['job_id'])
        self.connect_as('13800004680', back)
        done = self.finish(self.run_script('continue', '--wait', '10'))
        self.assertEqual(done['status'], 'done', done)
        self.assertEqual(done['job_id'], stopped['job_id'])
        self.assert_no_secrets()


if __name__ == '__main__':
    unittest.main()
