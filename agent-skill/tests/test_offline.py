# -*- coding: utf-8 -*-
"""The agent skill's script with a fake network layer (no service, no network): what is kept on this computer, what is
sent again with the same request id, and what the person is told when a request was not sent, when its answer was lost,
when the connection ended, and when the service is not deployed yet.

    python3 -m unittest discover -s agent-skill/tests
"""
import ast
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import tempfile
import unittest
import urllib.error
from http.client import IncompleteRead

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'xiexiubifa-writing', 'scripts', 'xiexiubifa.py')
WORDING = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'server', 'tests', 'wording.mjs')
SERVICE = 'https://service.example.test/mcp'


def load_client():
    spec = importlib.util.spec_from_file_location('xiexiubifa_offline', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response(object):
    def __init__(self, status, body=None):
        self.status = status
        self.headers = {'Content-Type': 'application/json'}
        self.raw = b'' if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeService(object):
    """Answers like the writing service. `tool_answers` decides each tools/call: a callable(name, arguments) that
    returns a Response, or raises (a lost connection)."""

    def __init__(self):
        self.calls = []
        self.tool_answers = None
        self.account = ('138 ···· 1234', 'acct_' + 'a' * 24)

    def tokens(self):
        return {'access_token': 'xxa_fake', 'refresh_token': 'xxr_fake', 'expires_in': 3600, 'token_type': 'Bearer', 'scope': 'write',
                'account_label': self.account[0], 'account_ref': self.account[1]}

    def open(self, request, timeout=None):
        url = request.full_url
        if url.endswith('/.well-known/oauth-authorization-server'):
            base = 'https://service.example.test'
            return Response(200, {'issuer': base, 'token_endpoint': base + '/oauth/token', 'device_authorization_endpoint': base + '/oauth/device_authorization',
                                  'revocation_endpoint': base + '/oauth/revoke'})
        if url.endswith('/oauth/device_authorization'):
            return Response(200, {'device_code': 'd' * 43, 'user_code': 'BCDF-GHJK', 'verification_uri': 'https://site.example.test/?connect_code=',
                                  'verification_uri_complete': 'https://site.example.test/?connect_code=BCDF-GHJK', 'expires_in': 600, 'interval': 0})
        if url.endswith('/oauth/token'):
            return Response(200, self.tokens())
        if url.endswith('/oauth/revoke'):
            return Response(200, {})
        body = json.loads(request.data)
        if body['method'] == 'initialize':
            return Response(200, {'jsonrpc': '2.0', 'id': body['id'], 'result': {'protocolVersion': '2025-06-18'}})
        if body['method'].startswith('notifications/'):
            return Response(202)
        name, arguments = body['params']['name'], body['params']['arguments']
        self.calls.append((name, dict(arguments)))
        return self.tool_answers(name, arguments, body['id'])


def tool_result(rpc_id, structured, text='', content=None):
    return Response(200, {'jsonrpc': '2.0', 'id': rpc_id, 'result': {'structuredContent': structured, 'content': content or [{'type': 'text', 'text': text}], 'isError': False}})


class WordingTest(unittest.TestCase):
    def test_every_text_the_script_can_print_passes_the_service_wording_check(self):
        with open(WORDING, encoding='utf-8') as f:
            block = f.read().split('export const BANNED = [', 1)[1].split('];', 1)[0]
        banned = [m.group(2) for m in re.finditer(r'([\'"])(.+?)\1', block)]
        self.assertGreater(len(banned), 40)
        with open(SCRIPT, encoding='utf-8') as f:
            tree = ast.parse(f.read())
        texts = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        for text in texts:
            lower = text.lower()
            self.assertEqual([p for p in banned if p.lower() in lower], [], text)


class OfflineTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='xxb-offline-')
        self.client = load_client()
        self.service = FakeService()
        self.client.OPENER = self.service
        self.saved_env = dict(os.environ)
        os.environ['XIEXIUBIFA_HOME'] = self.home
        os.environ['XIEXIUBIFA_SERVICE'] = SERVICE

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved_env)
        shutil.rmtree(self.home, ignore_errors=True)

    def run_command(self, *args, package_status=None):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            if package_status is None:
                self.client.main(list(args))
            else:
                # As if the address came from the package's service.json with this deployment status.
                original = self.client.service_url
                self.client.service_url = lambda a: (SERVICE, package_status)
                try:
                    self.client.main(list(args))
                finally:
                    self.client.service_url = original
        return json.loads(stdout.getvalue())

    def state(self):
        files = [f for f in os.listdir(self.home) if f.startswith('state-') and f.endswith('.json')]
        with open(os.path.join(self.home, files[0]), encoding='utf-8') as f:
            return json.load(f)

    def connect(self):
        self.assertEqual(self.run_command('connect')['status'], 'needs_connection')
        self.assertEqual(self.run_command('continue', '--wait', '1')['status'], 'connected')

    def test_a_refused_connection_is_reported_as_not_sent_and_the_request_keeps_its_id(self):
        self.connect()

        def refused(name, arguments, rpc_id):
            raise urllib.error.URLError(ConnectionRefusedError(111, 'Connection refused'))
        self.service.tool_answers = refused
        out = self.run_command('write', '--request', '帮我写一份通知')
        self.assertEqual(out['status'], 'unavailable')
        self.assertIn('还没有交给网站处理', out['message'])
        kept = self.state()['pending']
        self.assertEqual(kept['outcome'], 'unsent')
        request_id = kept['arguments']['arguments']['request_id']
        self.service.tool_answers = lambda name, a, rpc_id: tool_result(rpc_id, {'status': 'done', 'job_id': 'wj_' + 'x' * 32}, '已写好')
        self.assertEqual(self.run_command('continue')['status'], 'done')
        self.assertEqual([a.get('request_id') for _, a in self.service.calls], [request_id, request_id], 'every attempt carries the same request id')
        self.assertNotIn('pending', self.state())

    def test_a_timeout_or_dropped_answer_leaves_the_outcome_open_and_the_retry_uses_the_same_id(self):
        self.connect()
        for failure in (urllib.error.URLError(socket.timeout('timed out')), IncompleteRead(b'{"jsonrpc"'), urllib.error.URLError('fixture: answer lost')):
            self.service.calls = []

            def lost(name, arguments, rpc_id, failure=failure):
                raise failure
            self.service.tool_answers = lost
            out = self.run_command('write', '--request', '帮我写一份通知')
            self.assertEqual(out['status'], 'outcome_unknown', failure)
            self.assertNotIn('没有发出去', out['message'])
            self.assertIn('不确定网站有没有开始写', out['message'])
            self.assertEqual(self.state()['pending']['outcome'], 'unknown')
            request_id = self.service.calls[0][1]['request_id']
            self.service.tool_answers = lambda name, a, rpc_id: tool_result(rpc_id, {'status': 'done', 'job_id': 'wj_' + 'x' * 32, 'request_reused': True}, '这是之前已经交给邪修笔法的同一个请求')
            done = self.run_command('continue')
            self.assertEqual(done['status'], 'done')
            self.assertEqual(self.service.calls[-1][1]['request_id'], request_id)
            self.assertNotIn('pending', self.state())

    def test_a_server_error_on_a_paid_request_is_open_and_on_a_read_is_just_unavailable(self):
        self.connect()
        self.service.tool_answers = lambda name, a, rpc_id: Response(502, {'error': 'bad_gateway'})
        self.assertEqual(self.run_command('polish', '--text', '为切实做好冬季安全生产工作')['status'], 'outcome_unknown')
        self.run_command('cancel', '--pending')
        read = self.run_command('drafts')
        self.assertEqual(read['status'], 'unavailable')
        self.assertNotIn('pending', self.state(), 'a read is not kept')

    def test_the_service_saying_it_could_not_tell_keeps_the_request_open(self):
        self.connect()
        self.service.tool_answers = lambda name, a, rpc_id: Response(200, {'jsonrpc': '2.0', 'id': rpc_id, 'result': {
            'structuredContent': {'status': 'error', 'code': 'ERROR', 'outcome': 'unknown'}, 'content': [{'type': 'text', 'text': '不确定'}], 'isError': True}})
        out = self.run_command('revise', '--record', 'history_1', '--instruction', '写具体些')
        self.assertEqual(out['status'], 'outcome_unknown')
        self.assertEqual(self.state()['pending']['outcome'], 'unknown')

    def test_cancel_pending_says_what_may_still_happen(self):
        self.connect()

        def lost(name, arguments, rpc_id):
            raise urllib.error.URLError('answer lost')
        self.service.tool_answers = lost
        self.run_command('write', '--request', '帮我写一份通知')
        gone = self.run_command('cancel', '--pending')
        self.assertEqual(gone['status'], 'deleted')
        self.assertIn('网站可能已经开始写', gone['message'])
        self.assertEqual(self.run_command('cancel', '--pending')['status'], 'nothing_to_delete')

    def test_disconnect_keeps_a_waiting_request_and_says_so(self):
        self.connect()

        def lost(name, arguments, rpc_id):
            raise urllib.error.URLError('answer lost')
        self.service.tool_answers = lost
        self.run_command('write', '--request', '帮我写一份通知')
        out = self.run_command('disconnect')
        self.assertEqual(out['status'], 'disconnected')
        self.assertIn('还没有确认结果', out['message'])
        state = self.state()
        self.assertNotIn('tokens', state)
        self.assertEqual(state['pending']['outcome'], 'unknown', 'the request id is not forgotten')

    def test_a_connection_that_ends_while_a_request_is_open_asks_to_reconnect_with_the_same_account(self):
        self.connect()

        def lost(name, arguments, rpc_id):
            raise urllib.error.URLError('answer lost')
        self.service.tool_answers = lost
        self.run_command('write', '--request', '帮我写一份通知')
        self.service.tool_answers = lambda name, a, rpc_id: Response(401, {'error': 'invalid_token'})
        original_open = self.service.open

        def refresh_refused(request, timeout=None):
            if request.full_url.endswith('/oauth/token') and b'refresh_token' in (request.data or b''):
                return Response(400, {'error': 'invalid_grant'})
            return original_open(request, timeout)
        self.service.open = refresh_refused
        again = self.run_command('continue')
        self.assertEqual(again['status'], 'needs_connection')
        self.assertIn('连接已经失效', again['message'])
        self.assertIn('请用同一个手机号（138 ···· 1234）登录', again['message'])
        self.assertIn('会先用同一个请求编号确认', again['message'])
        # The person approves with another account: the open request is not sent under it.
        self.service.open = original_open
        self.service.account = ('139 ···· 5678', 'acct_' + 'b' * 24)
        calls = len(self.service.calls)
        changed = self.run_command('continue', '--wait', '1')
        self.assertEqual(changed['status'], 'account_changed')
        self.assertEqual(len(self.service.calls), calls, 'nothing was sent under the other account')
        old_id = self.state()['pending']['arguments']['arguments']['request_id']
        self.service.tool_answers = lambda name, a, rpc_id: tool_result(rpc_id, {'status': 'running', 'job_id': 'wj_' + 'y' * 32}, '正在写')
        self.assertEqual(self.run_command('continue', '--resend')['status'], 'running')
        self.assertNotEqual(self.service.calls[-1][1]['request_id'], old_id, 'a resend under another account is a new request')

    def test_word_remembers_version_and_an_absolute_path_while_connecting(self):
        work = os.path.join(self.home, 'work')
        os.makedirs(work)
        previous = os.getcwd()
        os.chdir(work)
        try:
            first = self.run_command('word', '--record', 'history_1', '--version', '2', '--out', 'out/v2.docx')
        finally:
            os.chdir(previous)
        self.assertEqual(first['status'], 'needs_connection')
        kept = self.state()['pending']
        target = os.path.realpath(os.path.join(work, 'out', 'v2.docx'))
        self.assertEqual(kept['arguments']['arguments'], {'record_id': 'history_1', 'version': 2})
        self.assertEqual(os.path.realpath(kept['local']['out']), target, 'kept as an absolute path')
        blob = {'type': 'resource', 'resource': {'uri': 'xiexiubifa://drafts/history_1/2/x.docx', 'blob': 'UEsDBA==', 'mimeType': 'application/octet-stream'}}
        self.service.tool_answers = lambda name, a, rpc_id: tool_result(rpc_id, {'status': 'ok', 'file_name': 'x.docx', 'version': a.get('version')}, 'Word', [blob])
        saved = self.run_command('continue', '--wait', '1')
        self.assertEqual(os.path.realpath(saved['file']), target)
        self.assertEqual(saved['version'], 2)
        self.assertTrue(os.path.isfile(saved['file']))

    def test_a_kept_continue_or_read_whose_answer_is_lost_is_not_called_unsent(self):
        # Kept while connecting, then sent after approval: the answers get lost.
        self.assertEqual(self.run_command('continue', '--job', 'wj_' + 'k' * 32)['status'], 'needs_connection')

        def lost(name, arguments, rpc_id):
            raise urllib.error.URLError('answer lost')
        self.service.tool_answers = lost
        out = self.run_command('continue', '--wait', '1')
        self.assertEqual(out['status'], 'outcome_unknown')
        self.assertIn('不确定网站有没有接着写', out['message'])
        self.assertNotIn('没有发出去', out['message'])
        self.service.tool_answers = lambda name, a, rpc_id: tool_result(rpc_id, {'status': 'running', 'job_id': a['job_id']}, '正在写')
        self.assertEqual(self.run_command('continue')['status'], 'running', 'asking again is safe for a job')
        self.run_command('disconnect')
        self.assertEqual(self.run_command('drafts')['status'], 'needs_connection')
        self.service.tool_answers = lost
        read = self.run_command('continue', '--wait', '1')
        self.assertEqual(read['status'], 'unavailable')
        self.assertIn('还没有完成', read['message'])
        self.assertNotIn('没有发出去', read['message'])

    def test_too_many_connection_attempts_is_said_as_such_not_as_a_network_problem(self):
        original_open = self.service.open

        def limited(request, timeout=None):
            if request.full_url.endswith('/oauth/device_authorization'):
                return Response(429, {'error': 'rate_limited', 'error_description': '请求太频繁，请稍后再试。'})
            return original_open(request, timeout)
        self.service.open = limited
        out = self.run_command('write', '--request', '帮我写一份通知')
        self.assertEqual(out['status'], 'busy')
        self.assertIn('次数太多', out['message'])
        self.assertNotIn('请检查网络', out['message'])
        self.assertIn('还没有发出去', out['message'], 'the request is kept, unsent')

    def test_when_the_package_says_the_service_is_not_deployed_that_is_what_the_person_hears(self):
        def no_such_host(request, timeout=None):
            raise urllib.error.URLError(socket.gaierror(-2, 'Name or service not known'))
        self.client.OPENER = type('Opener', (), {'open': staticmethod(no_such_host)})()
        out = self.run_command('write', '--request', '帮我写一份通知', package_status='not_deployed')
        self.assertEqual(out['status'], 'unavailable')
        self.assertIn('还没有上线', out['message'])
        self.assertIn('还没有发出去', out['message'])
        self.assertNotIn('请检查网络', out['message'])
        doctor = self.run_command('doctor', package_status='not_deployed')
        self.assertEqual(doctor['service_status'], 'not_deployed')
        self.assertIn('还没有上线', doctor['message'])


if __name__ == '__main__':
    unittest.main()
