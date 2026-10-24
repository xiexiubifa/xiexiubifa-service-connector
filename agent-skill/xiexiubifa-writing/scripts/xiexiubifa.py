#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邪修笔法写作服务 — a small client for AI agents that run scripts (Python 3.8+, standard library only).

It talks to the same service as the WorkBuddy connector: MCP over HTTPS, with the person's own xiexiubifa.cn account
connected through OAuth device authorization (RFC 8628). The person opens a link in their everyday browser, logs in on
the site as usual if needed, checks the code and presses 允许. No browser profile is used or read.

Every command prints one JSON object on stdout. "message" is the plain-language text to pass on to the person.

A request that can start paid work (write, revise, polish) gets its own request id and is saved on this computer before
it is sent; it stays saved until the service has answered. When the answer is lost, `continue` asks again with the
same id, and the service hands back the job it already started: nothing is written (or charged for) a second time.

    python3 xiexiubifa.py write --request "帮我写一份……" [--material-file f.docx] [--title …] [--words 1500] …
    python3 xiexiubifa.py continue [--job wj_…] [--resend]   after connecting, after membership, after a lost answer
    python3 xiexiubifa.py result --job wj_…          progress or the finished draft
    python3 xiexiubifa.py connect | disconnect | account | info | doctor
    python3 xiexiubifa.py revise --record ID --instruction "…" | polish --file f.txt | drafts | draft --record ID
    python3 xiexiubifa.py word --record ID [--version N] [--out file.docx] | types | cancel --job wj_… [--delete-input]
"""
import argparse
import base64
import errno
import hashlib
import json
import os
import re
import secrets
import socket
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from http.client import HTTPException

VERSION = '3.0.1'
CLIENT_ID = 'xiexiubifa-agent-skill'
DEFAULT_SERVICE = 'https://mcp.xiexiubifa.cn/mcp'
PROTOCOL = '2025-06-18'
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_MATERIAL = 120000
DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
# Tools that can start paid work on the site. Each call carries a request id fixed before it is sent.
KEYED_TOOLS = ('write_material', 'revise_draft', 'polish_text')
# Connection failures that happen before a request leaves this computer.
UNSENT_ERRNOS = {errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL}


class Stop(Exception):
    """An outcome to print as the command's result (not a crash)."""

    def __init__(self, result):
        Exception.__init__(self, result.get('message', ''))
        self.result = result


class NeedsConnection(Exception):
    """No usable connection: the service did not run the request."""


class Unreachable(Exception):
    """The service could not be reached or gave no usable answer. maybe_sent: the request may have arrived anyway."""

    def __init__(self, reason, maybe_sent):
        Exception.__init__(self, reason)
        self.reason = reason
        self.maybe_sent = maybe_sent


class Refused(Exception):
    """The service answered without running the request (no permission, too many requests, a call it did not accept)."""

    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Credentials go only to the service's own address: redirects are never followed.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, '写作服务的地址把请求转到了别处，没有跟随。', headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def out(result):
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


def progress(text):
    sys.stderr.write('· ' + text + '\n')
    sys.stderr.flush()


# ---------------------------------------------------------------------------------------------- settings and state

def package_service():
    """service.json in this skill: the service address, and whether the service is deployed yet."""
    try:
        with open(os.path.join(HERE, '..', 'service.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def service_url(args):
    """The service address, and the package's deployment status when the address is the package's own."""
    explicit = getattr(args, 'service', None) or os.environ.get('XIEXIUBIFA_SERVICE') or ''
    package = package_service()
    url = explicit or package.get('mcp_url', '') or DEFAULT_SERVICE
    parts = urllib.parse.urlsplit(url)
    loopback = parts.hostname in ('127.0.0.1', 'localhost', '::1')
    if parts.scheme != 'https' and not (parts.scheme == 'http' and loopback):
        raise Stop({'status': 'bad_input', 'message': '写作服务地址必须是 https 地址：' + url})
    return url, ('' if explicit else package.get('status', ''))


def state_dir():
    base = os.environ.get('XIEXIUBIFA_HOME')
    if not base:
        if os.name == 'nt':
            base = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'xiexiubifa-writing')
        elif sys.platform == 'darwin':
            base = os.path.expanduser('~/Library/Application Support/xiexiubifa-writing')
        else:
            base = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'xiexiubifa-writing')
    os.makedirs(base, mode=0o700, exist_ok=True)
    return base


class State(object):
    """Connection and the waiting request for one service address, in a file only this user can read."""

    def __init__(self, url):
        key = hashlib.sha256(url.encode('utf-8')).hexdigest()[:16]
        self.path = os.path.join(state_dir(), 'state-' + key + '.json')
        try:
            with open(self.path, encoding='utf-8') as f:
                self.data = json.load(f)
        except (OSError, ValueError):
            self.data = {}

    def save(self):
        temp = self.path + '.tmp'
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False)
        os.replace(temp, self.path)
        if os.name != 'nt':
            os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)


# ---------------------------------------------------------------------------------------------- HTTP

def certainly_unsent(error):
    """True when the request cannot have left this computer (no such host, refused, no route, bad certificate)."""
    reason = getattr(error, 'reason', error)
    if isinstance(reason, (ConnectionRefusedError, socket.gaierror, ssl.SSLCertVerificationError)):
        return True
    return isinstance(reason, OSError) and getattr(reason, 'errno', None) in UNSENT_ERRNOS


def http(method, url, body=None, headers=None, form=False, timeout=45):
    data = None
    h = dict(headers or {})
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode('utf-8')
            h['Content-Type'] = 'application/x-www-form-urlencoded'
        else:
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            h['Content-Type'] = 'application/json'
    h.setdefault('User-Agent', 'xiexiubifa-agent-skill/' + VERSION)
    request = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, dict(response.headers), raw
    except urllib.error.HTTPError as error:
        try:
            raw = error.read() if error.fp else b''
        except (OSError, HTTPException):
            raw = b''
        return error.code, dict(error.headers or {}), raw
    except (urllib.error.URLError, OSError, HTTPException) as error:
        # A timeout or a dropped connection after sending leaves open whether the service received the request.
        raise Unreachable(str(getattr(error, 'reason', error)) or error.__class__.__name__, maybe_sent=not certainly_unsent(error))


def as_json(raw):
    try:
        return json.loads(raw.decode('utf-8')) if raw else {}
    except ValueError:
        return {}


class Service(object):
    def __init__(self, url, state, agent_name='', package_status=''):
        self.url = url
        self.origin = '%s://%s' % urllib.parse.urlsplit(url)[:2]
        self.state = state
        self.agent_name = agent_name
        self.package_status = package_status
        self.initialized = False

    def metadata(self):
        meta = self.state.data.get('metadata')
        if not meta or meta.get('issuer') != self.origin:
            status, _, raw = http('GET', self.origin + '/.well-known/oauth-authorization-server')
            meta = as_json(raw)
            if status != 200 or meta.get('issuer') != self.origin:
                raise Unreachable('授权信息读取失败，HTTP %d' % status, maybe_sent=False)
            self.state.data['metadata'] = meta
            self.state.save()
        return meta

    # ------------------------------------------------------------------ connecting (device authorization)

    def start_device(self):
        meta = self.metadata()
        body = {'client_id': CLIENT_ID}
        if self.agent_name:
            body['client_hint'] = self.agent_name[:40]
        status, _, raw = http('POST', meta['device_authorization_endpoint'], body, form=True)
        data = as_json(raw)
        if status == 429:
            raise Refused('busy', '最近发起连接的次数太多，写作服务这次没有给出授权码（%s）。请过一分钟再试。' % (data.get('error_description') or 'HTTP 429'))
        if status != 200:
            raise Unreachable(data.get('error_description') or ('暂时无法发起连接，HTTP %d' % status), maybe_sent=False)
        device = {'device_code': data['device_code'], 'user_code': data['user_code'], 'url': data.get('verification_uri_complete') or data['verification_uri'],
                  'interval': int(data.get('interval') or 5), 'expires_at': time.time() + int(data.get('expires_in') or 600), 'last_poll': 0}
        self.state.data['device'] = device
        self.state.save()
        return device

    def poll_device(self, wait_seconds):
        device = self.state.data.get('device')
        if not device:
            return 'none'
        meta = self.metadata()
        deadline = time.time() + max(0, wait_seconds)
        while True:
            if time.time() > device['expires_at']:
                self.state.data.pop('device', None)
                self.state.save()
                return 'expired'
            pause = device['interval'] - (time.time() - device.get('last_poll', 0))
            if pause > 0:
                if time.time() + pause > deadline:
                    return 'pending'
                time.sleep(pause)
            device['last_poll'] = time.time()
            status, _, raw = http('POST', meta['token_endpoint'], {'grant_type': DEVICE_GRANT, 'device_code': device['device_code'], 'client_id': CLIENT_ID}, form=True)
            data = as_json(raw)
            if status == 200 and data.get('access_token'):
                # A connection that replaces one that stopped working: remember which account that was, to say so
                # when the new connection is for another account.
                lost = self.state.data.pop('connection_lost', None)
                if lost:
                    self.state.data['previous_account'] = lost
                self.keep_tokens(data)
                self.state.data.pop('device', None)
                self.state.save()
                return 'approved'
            error = data.get('error')
            if error == 'slow_down':
                device['interval'] += 5
            elif error == 'authorization_pending':
                pass
            elif error == 'access_denied':
                self.state.data.pop('device', None)
                self.state.save()
                return 'denied'
            elif status >= 500 or status == 429:
                self.state.save()
                raise Unreachable('写作服务暂时没有回应，HTTP %d' % status, maybe_sent=False)
            else:
                self.state.data.pop('device', None)
                self.state.save()
                return 'expired'
            self.state.save()
            if time.time() >= deadline:
                return 'pending'

    def keep_tokens(self, data, refreshed=False):
        old = self.state.data.get('tokens') or {}
        # The service says which account the connection is for (masked phone, and an opaque reference to compare).
        label = data.get('account_label') or (old.get('account_label', '') if refreshed else '')
        ref = data.get('account_ref') or (old.get('account_ref', '') if refreshed else '')
        self.state.data['tokens'] = {'access_token': data['access_token'], 'refresh_token': data.get('refresh_token', ''),
                                     'expires_at': time.time() + int(data.get('expires_in') or 3600) - 60, 'scope': data.get('scope', ''),
                                     'account_label': label, 'account_ref': ref}
        self.state.save()

    def refresh(self):
        tokens = self.state.data.get('tokens') or {}
        if not tokens.get('refresh_token'):
            return False
        status, _, raw = http('POST', self.metadata()['token_endpoint'], {'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token'], 'client_id': CLIENT_ID}, form=True)
        data = as_json(raw)
        if status == 200 and data.get('access_token'):
            self.keep_tokens(data, refreshed=True)
            return True
        if status >= 500 or status == 429:
            # The service could not answer now; the connection itself may be fine.
            raise Unreachable('续期连接时写作服务没有正常回应，HTTP %d' % status, maybe_sent=False)
        self.lose_connection()
        return False

    def lose_connection(self):
        """The connection stopped working (expired, closed on the site): forget the tokens, keep which account it was."""
        tokens = self.state.data.pop('tokens', None) or {}
        if tokens:
            self.state.data['connection_lost'] = {'at': time.time(), 'account_label': tokens.get('account_label', ''), 'account_ref': tokens.get('account_ref', '')}
        self.state.save()

    def connected(self):
        return bool((self.state.data.get('tokens') or {}).get('refresh_token') or (self.state.data.get('tokens') or {}).get('access_token'))

    # ------------------------------------------------------------------ MCP

    def rpc(self, method, params=None, notify=False):
        for attempt in (1, 2):
            tokens = self.state.data.get('tokens') or {}
            if not tokens.get('access_token'):
                raise NeedsConnection()
            message = {'jsonrpc': '2.0', 'method': method}
            if not notify:
                message['id'] = secrets.randbelow(1 << 30)
            if params is not None:
                message['params'] = params
            headers = {'Authorization': 'Bearer ' + tokens['access_token'], 'Accept': 'application/json, text/event-stream'}
            if self.initialized:
                headers['MCP-Protocol-Version'] = PROTOCOL
            status, _, raw = http('POST', self.url, message, headers=headers)
            if status == 401:
                # Not run: the connection was not accepted. Renew it once, or give it up.
                try:
                    if attempt == 1 and self.refresh():
                        continue
                except Unreachable as error:
                    raise Unreachable(error.reason, maybe_sent=False)
                self.lose_connection()
                raise NeedsConnection()
            if status == 403:
                raise Refused('not_allowed', '这个连接没有包含这项权限，请求没有被处理。可以断开后重新连接。')
            if notify and status == 202:
                return None
            if status >= 500:
                raise Unreachable('写作服务回应 HTTP %d' % status, maybe_sent=True)
            data = as_json(raw)
            if status == 429:
                raise Refused('busy', '写作服务现在请求太多，这次没有处理（HTTP 429）。请过一会儿再试。')
            if status != 200 or 'error' in data:
                text = (data.get('error') or {}).get('message') if isinstance(data.get('error'), dict) else data.get('error_description')
                raise Refused('unavailable', '写作服务没有接受这个请求（%s）。' % (text or status))
            return data.get('result')
        raise NeedsConnection()

    def tool(self, name, arguments):
        try:
            tokens = self.state.data.get('tokens') or {}
            if tokens and time.time() > tokens.get('expires_at', 0):
                self.refresh()
            if not self.initialized:
                self.rpc('initialize', {'protocolVersion': PROTOCOL, 'capabilities': {}, 'clientInfo': {'name': 'xiexiubifa-agent-skill', 'version': VERSION}})
                self.initialized = True
                self.rpc('notifications/initialized', notify=True)
        except Unreachable as error:
            # Nothing of this call has left the computer yet.
            raise Unreachable(error.reason, maybe_sent=False)
        return self.rpc('tools/call', {'name': name, 'arguments': arguments})


# ---------------------------------------------------------------------------------------------- the waiting request

def new_request_id():
    return 'rq_' + secrets.token_urlsafe(18)


def short(text, size=20):
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    return text if len(text) <= size else text[:size] + '…'


def what_of(pending):
    """The waiting request in words, for the person."""
    tool = pending['arguments']['tool']
    a = pending['arguments']['arguments']
    if tool == 'write_material':
        return '写作请求“%s”' % short(a.get('request'))
    if tool == 'revise_draft':
        return '改稿请求（成稿记录 %s）' % a.get('record_id')
    if tool == 'polish_text':
        return '润色请求“%s”' % short(a.get('text'))
    if tool == 'get_word_file':
        return '下载 Word 的请求（成稿记录 %s%s）' % (a.get('record_id'), ' 第 %s 稿' % a['version'] if a.get('version') else '')
    if tool == 'continue_writing':
        return '接着写任务 %s 的请求' % a.get('job_id')
    return '刚才的请求'


def pending_note(pending, tail='之后执行 continue 发送。'):
    """What happens to the waiting request, without claiming more than is known."""
    if not pending:
        return ''
    what = what_of(pending)
    if pending.get('outcome') == 'unknown':
        return '上次发出的%s还没有确认结果（当时没有收到回复），它和请求编号保存在这台电脑上；之后执行 continue，会用同一个编号确认，不会重复写。' % what
    if pending.get('attempts'):
        return '%s保存在这台电脑上，还没有交给网站处理；%s' % (what, tail)
    return '%s保存在这台电脑上，还没有发出去；%s' % (what, tail)


def remember(svc, command, arguments, local=None):
    """Keeps a request on this computer: before a paid request is sent, or while a request waits for the connection.

    arguments: {'tool': name, 'arguments': {...}}. local: what only this computer needs (for example where a Word file
    goes). A paid request gets its request id here, so every later attempt carries the same one."""
    current = svc.state.data.get('pending')
    if current and current.get('outcome') == 'unknown':
        raise Stop({'status': 'pending_unresolved', 'pending': current['id'],
                    'message': '上次发出的%s还没有确认结果（当时没有收到回复）。先执行 continue 确认它（用同一个编号，不会重复写），或者执行 cancel --pending 放弃它，再发新的请求。' % what_of(current)})
    request = {'tool': arguments['tool'], 'arguments': dict(arguments['arguments'])}
    if request['tool'] in KEYED_TOOLS and not request['arguments'].get('request_id'):
        request['arguments']['request_id'] = new_request_id()
    pending = {'id': 'p_' + secrets.token_hex(6), 'command': command, 'arguments': request, 'local': dict(local or {}), 'at': time.time(), 'outcome': 'unsent', 'attempts': 0}
    if current:
        pending['replaced'] = what_of(current)
    svc.state.data['pending'] = pending
    svc.state.save()
    return pending


def save_pending(svc, pending):
    svc.state.data['pending'] = pending
    svc.state.save()


def drop_pending(svc, pending):
    if (svc.state.data.get('pending') or {}).get('id') == pending.get('id'):
        svc.state.data.pop('pending', None)
        svc.state.save()


def account_change_note(svc):
    """After reconnecting: say so when the new connection is for a different account than the one before."""
    previous = svc.state.data.pop('previous_account', None)
    if not previous:
        return ''
    svc.state.save()
    tokens = svc.state.data.get('tokens') or {}
    if previous.get('account_ref') and tokens.get('account_ref') and previous['account_ref'] != tokens['account_ref']:
        return ('注意：现在连接的是账号 %s，之前连接的是账号 %s。之前账号下的写作任务在现在的账号里看不到；要接着用它们，需要用之前的账号重新连接。'
                % (tokens.get('account_label') or '（未知）', previous.get('account_label') or '（未知）'))
    return ''


# ---------------------------------------------------------------------------------------------- results

def from_tool(result):
    """A tool result as the command's output: the structured fields plus the text to pass on."""
    structured = dict(result.get('structuredContent') or {})
    texts = [c.get('text', '') for c in result.get('content') or [] if c.get('type') == 'text']
    structured['message'] = '\n'.join(t for t in texts if t)
    if result.get('isError'):
        structured.setdefault('status', 'error')
    return structured


def save_word(result, local):
    info = from_tool(result)
    blobs = [c['resource'] for c in result.get('content') or [] if c.get('type') == 'resource' and c.get('resource', {}).get('blob')]
    if not blobs:
        return info
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', info.get('file_name') or 'xiexiubifa.docx')
    target = local.get('out') or os.path.join(local.get('out_dir') or os.path.join(os.getcwd(), 'xiexiubifa-output'), name)
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with open(target, 'wb') as f:
        f.write(base64.b64decode(blobs[0]['blob']))
    info['file'] = os.path.abspath(target)
    info['message'] = ((info.get('message') or '') + '\n已保存到：' + info['file']).strip()
    return info


def finish(svc, command, local, result):
    """The answer to a command, after the service ran it (a command finished after connecting ends the same way)."""
    output = save_word(result, local) if command == 'word' else from_tool(result)
    note = account_change_note(svc)
    if note:
        output['message'] = ((output.get('message') or '') + '\n' + note).strip()
    return output


def not_deployed_note(svc):
    if getattr(svc, 'package_status', '') == 'not_deployed':
        return '按这个技能包里的 service.json，邪修笔法写作服务还没有上线，现在连不上是预期的，不是网络或账号的问题。'
    return ''


def unsent_message(svc, reason, pending=None):
    if not_deployed_note(svc):
        return '连不上邪修笔法写作服务（%s）。%s%s' % (reason, not_deployed_note(svc), pending_note(pending, '服务上线后执行 continue 发送；不需要的话执行 cancel --pending 删除它。'))
    return '连不上邪修笔法写作服务（%s）。请检查网络后再试。%s' % (reason, pending_note(pending))


def unsure_message(pending, reason):
    if pending['arguments']['tool'] == 'continue_writing':
        return ('%s已经发给邪修笔法写作服务，但没有收到回复（%s），不确定网站有没有接着写。'
                '它保存在这台电脑上：稍后执行 continue 再问一次（同一个任务），已完成的步骤不会重复扣额度。' % (what_of(pending), reason))
    return ('%s已经发给邪修笔法写作服务，但没有收到回复（%s），不确定网站有没有开始写。'
            '请求和它的编号保存在这台电脑上：稍后执行 continue，会用同一个编号再问一次——网站已经开始或写完的话会直接取回，不会重复写、不会重复使用额度。'
            % (what_of(pending), reason))


def needs_connection(svc, device, pending=None, note='', after=''):
    lost = svc.state.data.get('connection_lost') or {}
    lines = []
    if note:
        lines.append(note)
    if pending and pending.get('replaced'):
        lines.append('（之前保存、还没发出的%s已经换成这个新请求。）' % pending['replaced'])
    if lost:
        lines.append('这台电脑和邪修笔法账号%s的连接已经失效（可能过期了，或在网站会员中心断开了），需要重新连接：'
                     % ('（%s）' % lost['account_label'] if lost.get('account_label') else ''))
    else:
        lines.append('需要先把用户自己的邪修笔法账号连接到这个 AI 助手（只需一次）：')
    lines.append('1. 在平时用的浏览器里打开： %s ' % device['url'])
    lines.append('2. 没登录的话，先用手机号登录邪修笔法网站。授权页面会显示要连接的账号（手机号前三位和后四位）：浏览器里现在登录的账号就是会被连接的账号%s；'
                 % ('，要接着用之前的写作任务，请用同一个手机号（%s）登录' % lost['account_label'] if lost.get('account_label') else ''))
    lines.append('3. 核对授权码 %s 与这里一致，看完页面上的说明（会发送哪些内容、费用），再点「允许连接」。' % device['user_code'])
    if not pending:
        tail = '就可以写了。'
    elif pending.get('outcome') == 'unknown':
        tail = '会先用同一个请求编号确认上次那个%s的结果（不会重复写、不会重复使用额度）。%s' % (what_of(pending), after)
    else:
        tail = '会接着处理刚才的%s（请求%s）。' % (what_of(pending), '还没有交给网站处理' if pending.get('attempts') else '还没有发出去')
    lines.append('授权码 %s 前有效。连接好后执行 continue，%s' % (time.strftime('%H:%M', time.localtime(device['expires_at'])), tail))
    result = {'status': 'needs_connection', 'connect': {'url': device['url'], 'code': device['user_code'], 'expires_at': int(device['expires_at'])},
              'message': '\n'.join(lines), 'links': [{'label': '连接邪修笔法账号', 'url': device['url']}]}
    if pending:
        result['pending'] = pending['id']
    return result


def connect_for(svc, pending=None, after=''):
    """Starts (or reuses) a device connection for a request that is kept on this computer."""
    device = svc.state.data.get('device')
    kept = {'pending': pending['id']} if pending else {}
    try:
        if not device or time.time() > device['expires_at']:
            device = svc.start_device()
    except Unreachable as error:
        raise Stop(dict({'status': 'unavailable', 'message': unsent_message(svc, error.reason, pending)}, **kept))
    except Refused as refused:
        raise Stop(dict({'status': refused.status, 'message': refused.message + pending_note(pending)}, **kept))
    return needs_connection(svc, device, pending, after=after)


def send_pending(svc, pending):
    """Sends the kept request and keeps it until the service has answered."""
    tool_name = pending['arguments']['tool']
    arguments = pending['arguments']['arguments']
    paid = tool_name in KEYED_TOOLS
    if paid and svc.connected():
        tokens = svc.state.data.get('tokens') or {}
        pending['account_label'] = tokens.get('account_label', '')
        pending['account_ref'] = tokens.get('account_ref', '')
        pending['sent_at'] = time.time()
        pending['attempts'] = pending.get('attempts', 0) + 1
        save_pending(svc, pending)  # on disk before the request leaves
    try:
        result = svc.tool(tool_name, arguments)
    except NeedsConnection:
        save_pending(svc, pending)
        return connect_for(svc, pending)
    except Unreachable as error:
        if error.maybe_sent and (paid or tool_name == 'continue_writing'):
            pending['outcome'] = 'unknown'
            save_pending(svc, pending)
            raise Stop({'status': 'outcome_unknown', 'pending': pending['id'], 'message': unsure_message(pending, error.reason)})
        save_pending(svc, pending)
        if error.maybe_sent:
            # A read whose answer did not arrive: nothing was paid for, it is just not done yet.
            raise Stop({'status': 'unavailable', 'pending': pending['id'],
                        'message': '写作服务这次没有回应（%s）。%s保存在这台电脑上，还没有完成；稍后执行 continue 再试。' % (error.reason, what_of(pending))})
        raise Stop({'status': 'unavailable', 'pending': pending['id'], 'message': unsent_message(svc, error.reason, pending)})
    except Refused as refused:
        save_pending(svc, pending)
        raise Stop({'status': refused.status, 'pending': pending['id'], 'message': refused.message + pending_note(pending, '可以稍后执行 continue 再试，或执行 cancel --pending 删除它。')})
    if paid and (result.get('structuredContent') or {}).get('outcome') == 'unknown':
        # The service itself could not tell whether the work started: ask again later with the same id.
        pending['outcome'] = 'unknown'
        save_pending(svc, pending)
        raise Stop({'status': 'outcome_unknown', 'pending': pending['id'], 'message': unsure_message(pending, '写作服务处理时出错')})
    drop_pending(svc, pending)
    return finish(svc, pending['command'], pending.get('local') or {}, result)


def call_or_connect(svc, command, tool_name, arguments, local=None):
    """Runs a tool. A paid request is kept (with its request id) until answered; any request is kept while connecting."""
    if tool_name in KEYED_TOOLS:
        return send_pending(svc, remember(svc, command, {'tool': tool_name, 'arguments': arguments}, local))
    try:
        result = svc.tool(tool_name, arguments)
    except NeedsConnection:
        unresolved = svc.state.data.get('pending')
        if unresolved and unresolved.get('outcome') == 'unknown':
            return connect_for(svc, unresolved, after='然后请再执行一次刚才的命令。')
        return connect_for(svc, remember(svc, command, {'tool': tool_name, 'arguments': arguments}, local))
    except Unreachable as error:
        if tool_name == 'continue_writing' and error.maybe_sent:
            job = arguments.get('job_id')
            raise Stop({'status': 'outcome_unknown', 'job_id': job,
                        'message': '接着写任务 %s 的请求已经发出，但没有收到回复（%s），不确定网站有没有接着写。稍后执行 continue --job %s 或 result --job %s 查看；再执行一次不会让已完成的步骤重复扣额度。' % (job, error.reason, job, job)})
        raise Stop({'status': 'unavailable', 'message': unsent_message(svc, error.reason, svc.state.data.get('pending'))})
    except Refused as refused:
        raise Stop({'status': refused.status, 'message': refused.message})
    return finish(svc, command, local or {}, result)


# ---------------------------------------------------------------------------------------------- inputs

def read_material(paths):
    parts = []
    for path in paths or []:
        if not os.path.isfile(path):
            raise Stop({'status': 'bad_input', 'message': '找不到素材文件：' + path})
        lower = path.lower()
        if lower.endswith('.docx'):
            parts.append(docx_text(path))
        elif lower.endswith(('.txt', '.md')):
            with open(path, encoding='utf-8-sig', errors='replace') as f:
                parts.append(f.read())
        else:
            raise Stop({'status': 'bad_input', 'message': '素材文件请用 .docx、.txt 或 .md（PDF、图片请先提取成文字）：' + path})
    text = '\n\n'.join(p.strip() for p in parts if p.strip())
    if len(text) > MAX_MATERIAL:
        raise Stop({'status': 'bad_input', 'message': '素材太长（%d 字，最多 %d 字）。请分开处理或删减。' % (len(text), MAX_MATERIAL)})
    return text


def docx_text(path):
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo('word/document.xml')
            if info.file_size > 50 * 1024 * 1024:
                raise Stop({'status': 'bad_input', 'message': 'Word 文件过大：' + path})
            root = ET.fromstring(archive.read(info))
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        raise Stop({'status': 'bad_input', 'message': '读不了这个 Word 文件：' + path})
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    lines = []
    for paragraph in root.iter(ns + 'p'):
        lines.append(''.join(t.text or '' for t in paragraph.iter(ns + 't')))
    return '\n'.join(lines)


def write_arguments(args):
    arguments = {'request': args.request}
    material = '\n\n'.join(x for x in [args.material or '', read_material(args.material_file)] if x)
    if material:
        arguments['material'] = material
    for key in ('title', 'words', 'level', 'audience', 'purpose', 'speaker'):
        value = getattr(args, key)
        if value:
            arguments[key] = str(value)
    if args.doc_type:
        arguments['doc_type'] = args.doc_type
    if args.quick:
        arguments['mode'] = 'quick'
    if args.deep:
        arguments['deep_thinking'] = True
    return arguments


# ---------------------------------------------------------------------------------------------- commands

def cmd_write(svc, args):
    return call_or_connect(svc, 'write', 'write_material', write_arguments(args))


def account_changed(svc, pending):
    tokens = svc.state.data.get('tokens') or {}
    old = pending.get('account_label') or '（原来的账号）'
    new = tokens.get('account_label') or '（现在的账号）'
    return {'status': 'account_changed', 'pending': pending['id'], 'account': new, 'previous_account': old,
            'message': ('上次发出的%s是用账号 %s 发的，当时没有收到回复，不确定网站有没有开始写。现在这台电脑连接的是账号 %s。'
                        '为了不在两个账号下各写一次，这个请求没有在现在的账号下重新发送。可以：'
                        '用原来的账号重新连接（执行 disconnect，再执行 connect，在浏览器里用 %s 登录后允许），然后执行 continue 取回结果；'
                        '或者执行 continue --resend，在现在的账号下重新写（会使用这个账号的额度，原来的账号那边可能也已经写好）；'
                        '或者执行 cancel --pending 放弃这个请求。') % (what_of(pending), old, new, old)}


def cmd_continue(svc, args):
    job = getattr(args, 'job', None)
    wait = getattr(args, 'wait', 25)
    resend = getattr(args, 'resend', False)
    device = svc.state.data.get('device')
    if device:
        try:
            outcome = svc.poll_device(wait)
        except Unreachable as error:
            raise Stop({'status': 'unavailable', 'message': unsent_message(svc, error.reason, svc.state.data.get('pending')) + '授权码在有效期内还可以用，稍后再执行 continue。'})
        pending = svc.state.data.get('pending')
        if outcome == 'pending':
            return needs_connection(svc, device, pending, '还没有在网站上点「允许连接」。')
        if outcome in ('denied', 'expired'):
            result = {'status': 'connection_' + ('refused' if outcome == 'denied' else 'expired'),
                      'message': ('网站上没有允许这次连接。' if outcome == 'denied' else '授权码已过期，这次连接没有完成。')
                      + pending_note(pending, '要重新连接就执行 connect；不需要了就执行 cancel --pending 删除它。')}
            if pending:
                result['pending'] = pending['id']
            return result
    if job:
        extra = {k: str(getattr(args, k)) for k in ('title', 'words', 'level', 'audience', 'purpose', 'speaker') if getattr(args, k, None)}
        return call_or_connect(svc, 'continue', 'continue_writing', dict({'job_id': job}, **extra))
    pending = svc.state.data.get('pending')
    if pending and svc.connected():
        if pending.get('outcome') == 'unknown':
            tokens = svc.state.data.get('tokens') or {}
            old, new = pending.get('account_ref'), tokens.get('account_ref')
            if old and new and old != new:
                if not resend:
                    return account_changed(svc, pending)
                # The person chose to write it under the account connected now: that is a new request with a new id.
                pending['arguments']['arguments']['request_id'] = new_request_id()
                pending['outcome'] = 'unsent'
                pending['attempts'] = 0
                save_pending(svc, pending)
            progress('正在用同一个请求编号确认上次的请求…' if pending.get('outcome') == 'unknown' else '正在发送保存的请求…')
        else:
            progress('已连接，正在发送刚才的请求…')
        return send_pending(svc, pending)
    if pending:
        return connect_for(svc, pending)
    if svc.connected():
        tokens = svc.state.data.get('tokens') or {}
        label = tokens.get('account_label', '')
        result = {'status': 'connected', 'message': ('已连接邪修笔法账号%s。' % ('（%s）' % label if label else '')) + account_change_note(svc)}
        if label:
            result['account'] = label
        return result
    return {'status': 'nothing_to_continue', 'message': '没有等待继续的请求。要连接账号请执行 connect。'}


def cmd_connect(svc, args):
    if svc.connected():
        try:
            return dict(from_tool(svc.tool('get_account_status', {})), status='connected')
        except NeedsConnection:
            pass
        except Unreachable as error:
            raise Stop({'status': 'unavailable', 'message': unsent_message(svc, error.reason)})
        except Refused as refused:
            raise Stop({'status': refused.status, 'message': refused.message})
    pending = svc.state.data.get('pending')
    result = connect_for(svc, pending)
    if getattr(args, 'open', False):
        import webbrowser
        webbrowser.open(result['connect']['url'])
    return result


def cmd_disconnect(svc, args):
    tokens = svc.state.data.get('tokens') or {}
    confirmed = True
    if tokens.get('refresh_token'):
        try:
            status, _, _ = http('POST', svc.metadata()['revocation_endpoint'], {'token': tokens['refresh_token'], 'client_id': CLIENT_ID, 'token_type_hint': 'refresh_token'}, form=True)
            confirmed = status == 200
        except Unreachable:
            confirmed = False
    pending = svc.state.data.get('pending')
    svc.state.data = {k: v for k, v in svc.state.data.items() if k in ('metadata', 'pending')}
    svc.state.save()
    message = '已断开这台电脑与邪修笔法账号的连接，并删除了保存的凭据。网站上的成稿记录不受影响。'
    if not confirmed:
        message += '写作服务这次没有确认断开（连不上或没有回应），网站「会员中心 → 已连接的 AI 助手」里可能还列着这个连接，可以在那里点「断开」。'
    if pending:
        message += pending_note(pending, '重新连接后执行 continue 发送；不需要的话执行 cancel --pending 删除它。')
    return {'status': 'disconnected', 'message': message}


def cmd_word(svc, args):
    arguments = {'record_id': args.record}
    if getattr(args, 'version', None):
        arguments['version'] = args.version
    # Where the file goes is fixed now, so a download finished after connecting still lands where it was asked for.
    target = getattr(args, 'out', None)
    local = {'out': os.path.abspath(target)} if target else {'out_dir': os.path.abspath(os.path.join(os.getcwd(), 'xiexiubifa-output'))}
    return call_or_connect(svc, 'word', 'get_word_file', arguments, local)


def simple(tool_name, build):
    def run(svc, args):
        return call_or_connect(svc, tool_name, tool_name, build(args))
    return run


def cmd_cancel(svc, args):
    if args.pending:
        pending = svc.state.data.pop('pending', None)
        svc.state.save()
        if not pending:
            return {'status': 'nothing_to_delete', 'message': '这台电脑上没有保存的请求。'}
        if pending.get('outcome') == 'unknown':
            return {'status': 'deleted', 'message': '已删除这台电脑上保存的%s。注意：它上次已经发出、但没有收到回复，网站可能已经开始写；写完的话会存进网站的成稿记录（照常使用额度）。' % what_of(pending)}
        return {'status': 'deleted', 'message': '已删除保存在这台电脑上、还没交给网站处理的%s。' % what_of(pending)}
    if not args.job:
        raise Stop({'status': 'bad_input', 'message': '请给出 --job 任务编号（或用 --pending 删除保存在这台电脑上的请求）。'})
    return call_or_connect(svc, 'cancel', 'cancel_writing', {'job_id': args.job, 'delete_saved_input': bool(args.delete_input)})


def cmd_doctor(svc, args):
    try:
        status, _, raw = http('GET', svc.origin + '/health')
        reason = ''
    except Unreachable as error:
        status, raw, reason = 0, b'', error.reason
    health = as_json(raw)
    tokens = svc.state.data.get('tokens') or {}
    pending = svc.state.data.get('pending')
    message = '写作服务%s；%s。' % ('可以访问' if status == 200 else '暂时访问不了' + ('（%s）' % reason if reason else ''),
                                 '已连接账号' + ('（%s）' % tokens['account_label'] if tokens.get('account_label') else '') if svc.connected() else '还没有连接账号')
    if status != 200:
        message += not_deployed_note(svc)
    if pending:
        message += pending_note(pending)
    return {'status': 'ok' if status == 200 else 'unavailable', 'python': sys.version.split()[0], 'skill_version': VERSION, 'service': svc.url,
            'service_status': svc.package_status or 'unknown', 'service_reachable': status == 200, 'service_version': health.get('version'),
            'connected': svc.connected(), 'account': tokens.get('account_label', ''),
            'waiting_request': (pending.get('outcome') or 'unsent') if pending else False, 'state_file': svc.state.path, 'message': message}


def parser():
    p = argparse.ArgumentParser(prog='xiexiubifa.py', description='邪修笔法写作服务客户端（标准库，Python 3.8+）')
    p.add_argument('--service', help='写作服务的 MCP 地址（默认读 service.json）')
    p.add_argument('--agent-name', default=os.environ.get('XIEXIUBIFA_AGENT_NAME', ''), help='连接时在网站授权页上显示的助手名称，例如 Claude Code')
    sub = p.add_subparsers(dest='command')
    w = sub.add_parser('write', help='写一篇材料')
    w.add_argument('--request', required=True)
    w.add_argument('--material', help='补充素材文字')
    w.add_argument('--material-file', action='append', help='素材文件（.docx/.txt/.md），可多次')
    for key in ('title', 'words', 'level', 'audience', 'purpose', 'speaker'):
        w.add_argument('--' + key)
    w.add_argument('--doc-type')
    w.add_argument('--quick', action='store_true', help='网站的「传统方式一键生成文章」')
    w.add_argument('--deep', action='store_true', help='网站的「深度思考」（会用掉更多额度）')
    c = sub.add_parser('continue', help='连接好之后、开通会员之后、没收到回复之后，或任务停下之后接着做')
    c.add_argument('--job')
    c.add_argument('--wait', type=int, default=25, help='等待网站上「允许」的秒数（默认 25）')
    c.add_argument('--resend', action='store_true', help='连接换了账号时，在现在的账号下重新发送保存的请求（会使用这个账号的额度）')
    for key in ('title', 'words', 'level', 'audience', 'purpose', 'speaker'):
        c.add_argument('--' + key)
    r = sub.add_parser('result', help='查看写作进度和结果')
    r.add_argument('--job', required=True)
    r.add_argument('--wait', type=int, default=20)
    x = sub.add_parser('cancel', help='取消任务')
    x.add_argument('--job')
    x.add_argument('--delete-input', action='store_true')
    x.add_argument('--pending', action='store_true', help='删除保存在这台电脑上的请求')
    v = sub.add_parser('revise', help='在成稿上改出新的一稿')
    v.add_argument('--record', required=True)
    v.add_argument('--instruction', required=True)
    v.add_argument('--version', type=int)
    o = sub.add_parser('polish', help='智能润色')
    o.add_argument('--text')
    o.add_argument('--file')
    o.add_argument('--requirements')
    o.add_argument('--emphasis', choices=['golden', 'classical', 'parallel', 'metaphor', 'data', 'plain', 'theory', 'imagery'])
    o.add_argument('--strength', type=int)
    d = sub.add_parser('draft', help='读取一篇成稿')
    d.add_argument('--record', required=True)
    d.add_argument('--version', type=int)
    wd = sub.add_parser('word', help='保存网站版式的 Word')
    wd.add_argument('--record', required=True)
    wd.add_argument('--version', type=int)
    wd.add_argument('--out')
    dr = sub.add_parser('drafts', help='成稿记录')
    dr.add_argument('--limit', type=int, default=20)
    t = sub.add_parser('types', help='文种目录')
    t.add_argument('--doc-type')
    cn = sub.add_parser('connect', help='连接账号')
    cn.add_argument('--open', action='store_true', help='同时用默认浏览器打开连接页面')
    for name in ('disconnect', 'account', 'info', 'doctor'):
        sub.add_parser(name)
    return p


def polish_arguments(args):
    text = args.text or ''
    if args.file:
        text = read_material([args.file])
    if not text:
        raise Stop({'status': 'bad_input', 'message': '请用 --text 或 --file 给出要润色的文字。'})
    arguments = {'text': text}
    if args.requirements:
        arguments['requirements'] = args.requirements
    if args.emphasis:
        arguments['emphasis'] = args.emphasis
        if args.strength:
            arguments['strength'] = args.strength
    return arguments


COMMANDS = {
    'write': cmd_write, 'continue': cmd_continue, 'connect': cmd_connect, 'disconnect': cmd_disconnect, 'word': cmd_word,
    'cancel': cmd_cancel, 'doctor': cmd_doctor,
    'result': simple('get_writing_result', lambda a: {'job_id': a.job, 'wait_seconds': max(0, min(25, a.wait))}),
    'revise': simple('revise_draft', lambda a: dict({'record_id': a.record, 'instruction': a.instruction}, **({'version': a.version} if a.version else {}))),
    'polish': simple('polish_text', polish_arguments),
    'draft': simple('get_draft', lambda a: dict({'record_id': a.record}, **({'version': a.version} if a.version else {}))),
    'drafts': simple('list_drafts', lambda a: {'limit': max(1, min(100, a.limit))}),
    'types': simple('list_document_types', lambda a: {'doc_type': a.doc_type} if a.doc_type else {}),
    'account': simple('get_account_status', lambda a: {}),
    'info': simple('get_service_info', lambda a: {})
}
FAILED = ('error', 'bad_input', 'unavailable', 'outcome_unknown', 'not_allowed', 'busy')


def main(argv=None):
    if sys.version_info < (3, 8):
        out({'status': 'bad_input', 'message': '需要 Python 3.8 或更高版本。'})
        return 2
    args = parser().parse_args(argv)
    if not args.command:
        parser().print_help(sys.stderr)
        return 2
    try:
        url, package_status = service_url(args)
        svc = Service(url, State(url), args.agent_name, package_status)
        result = COMMANDS[args.command](svc, args)
    except Stop as stop:
        result = stop.result
    out(result)
    return 1 if result.get('status') in FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
