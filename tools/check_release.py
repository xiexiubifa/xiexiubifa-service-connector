#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Release check for this repository, and the packages to hand in.

    python3 tools/check_release.py                 check everything; build dist/ zips and SHA256SUMS.txt
    python3 tools/check_release.py --no-build      check only
    python3 tools/check_release.py --set-url URL   change the service's MCP address in every file, then check
    python3 tools/check_release.py --set-status deployed|not_deployed   record whether the service is live, then check

Checks:
- the WorkBuddy connector package (connector/) against the rules in WorkBuddy's connector documentation: files,
  connector-meta.json fields (kebab-case source, 2–5 examples per language, description length, minWorkbuddyVersion
  for the fields used), one remote MCP server over HTTPS without hard-coded credentials, an icon, and the connector
  skill's front matter;
- the agent skill (agent-skill/xiexiubifa-writing/) against the Agent Skills format (name, description, allowed keys),
  and its script against Python 3.8 syntax;
- one version, one service address and one deployment status everywhere (release.json), and a README that says
  plainly when the service is not deployed yet;
- no credentials in any file.
"""
import argparse
import ast
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {'node_modules', '__pycache__', '.git', 'dist', '.local', '.claude'}
STATUSES = ('not_deployed', 'deployed')
# Words the README carries while the service is not deployed (and must drop once it is).
NOT_DEPLOYED_MARKERS = ('尚未上线', 'Not deployed yet')
SECRET_PATTERNS = [
    (re.compile(r'AKID[0-9A-Za-z]{13,}'), 'a Tencent Cloud SecretId'),
    (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'), 'a private key'),
    (re.compile(r'\bsk-[A-Za-z0-9]{24,}'), 'an API key'),
    (re.compile(r'Bearer\s+[A-Za-z0-9._~+/-]{30,}'), 'a bearer token'),
    (re.compile(r'\bxx[acr]_[A-Za-z0-9_-]{43}\b'), 'a token of this service'),
    (re.compile(r'(?i)(secret[_-]?key|client_secret|password)\s*[:=]\s*["\'][^"\'\s$]{12,}["\']'), 'a hard-coded secret'),
]
problems = []


def problem(text):
    problems.append(text)


def front_matter(path):
    """A small reader for the SKILL.md front matter used here: scalars, lists of strings, one level of mapping."""
    text = path.read_text(encoding='utf-8')
    if not text.startswith('---\n'):
        problem('%s: no front matter' % path.relative_to(ROOT))
        return {}
    block = text[4:text.index('\n---', 4)]
    data, key = {}, None
    for line in block.split('\n'):
        if not line.strip():
            continue
        if line.startswith('  - ') and key:
            if not isinstance(data.get(key), list):
                data[key] = []
            data[key].append(line[4:].strip().strip('"'))
        elif line.startswith('  ') and key:
            sub, _, value = line.strip().partition(':')
            if not isinstance(data.get(key), dict):
                data[key] = {}
            data[key][sub.strip()] = value.strip().strip('"')
        else:
            key, _, value = line.partition(':')
            key = key.strip()
            value = value.strip()
            data[key] = value.strip('"') if value else None
    return data


def check_connector(release):
    base = ROOT / 'connector'
    meta = json.loads((base / 'connector-meta.json').read_text(encoding='utf-8'))
    for field in ('name', 'name_en', 'description', 'description_en', 'source'):
        if not meta.get(field):
            problem('connector-meta.json: %s is required' % field)
    if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', meta.get('source', '')):
        problem('connector-meta.json: source must be lowercase letters, digits and hyphens')
    if meta.get('type', 'mcp') not in ('mcp', 'cli', 'skill-only'):
        problem('connector-meta.json: type must be mcp, cli or skill-only')
    if meta.get('version') != release['version']:
        problem('connector-meta.json: version %s differs from release.json %s' % (meta.get('version'), release['version']))
    for field in ('description', 'description_zh', 'description_en'):
        value = meta.get(field, '')
        if value and not 20 <= len(value) <= 100:
            problem('connector-meta.json: %s has %d characters (WorkBuddy suggests 20–100)' % (field, len(value)))
    for field in ('examples_zh', 'examples_en'):
        if not isinstance(meta.get(field), list) or not 2 <= len(meta[field]) <= 5:
            problem('connector-meta.json: %s needs 2–5 examples' % field)
    uses_424 = any(k in meta for k in ('name_zh', 'examples_zh', 'examples_en'))
    if uses_424 and tuple(int(x) for x in str(meta.get('minWorkbuddyVersion', '0.0.0')).split('.')) < (4, 24, 0):
        problem('connector-meta.json: name_zh/examples_* need minWorkbuddyVersion 4.24.0 or later')
    if meta.get('auth_mode') == 'token' and not (base / 'token-schema.json').exists():
        problem('connector: auth_mode token needs token-schema.json')
    mcp = json.loads((base / 'mcp.json').read_text(encoding='utf-8'))
    servers = mcp.get('mcpServers') or {}
    if len(servers) != 1:
        problem('mcp.json: exactly one MCP server per connector')
    for name, server in servers.items():
        if server.get('type') not in ('streamableHttp', 'sse', 'stdio'):
            problem('mcp.json: %s type must be streamableHttp, sse or stdio' % name)
        if server.get('type') in ('streamableHttp', 'sse'):
            if not str(server.get('url', '')).startswith('https://'):
                problem('mcp.json: %s must use https' % name)
            if server.get('url') != release['mcp_url']:
                problem('mcp.json: url %s differs from release.json %s' % (server.get('url'), release['mcp_url']))
        for section in ('headers', 'env'):
            for key, value in (server.get(section) or {}).items():
                if not re.fullmatch(r'(Bearer )?\$\{[A-Z0-9_]+\}', str(value)):
                    problem('mcp.json: %s.%s must be a ${VAR} placeholder, not a value' % (section, key))
    icons = [p for p in ('icon.svg', 'icon.png', 'icon.jpg') if (base / p).exists()]
    if not icons:
        problem('connector: icon.svg, icon.png or icon.jpg is required')
    elif icons[0] == 'icon.svg':
        svg = (base / 'icon.svg').read_text(encoding='utf-8')
        try:
            root = ET.fromstring(svg)
            if not root.get('viewBox'):
                problem('icon.svg: needs a viewBox')
        except ET.ParseError as error:
            problem('icon.svg: not valid XML (%s)' % error)
        if re.search(r'<script|href\s*=\s*["\']https?:', svg, re.I):
            problem('icon.svg: no scripts or external references')
    skills = sorted((base / 'skills').glob('*/SKILL.md'))
    if not skills:
        problem('connector: skills/<name>/SKILL.md expected')
    for skill in skills:
        fm = front_matter(skill)
        for field in ('name', 'display_name', 'display_name_en', 'description', 'description_zh', 'description_en', 'version', 'author'):
            if not fm.get(field):
                problem('%s: %s is required by WorkBuddy' % (skill.relative_to(ROOT), field))
        if fm.get('name') != skill.parent.name:
            problem('%s: name must match its folder' % skill.relative_to(ROOT))
        if fm.get('version') != release['version']:
            problem('%s: version differs from release.json' % skill.relative_to(ROOT))
    return meta


def check_agent_skill(release):
    base = ROOT / 'agent-skill' / 'xiexiubifa-writing'
    fm = front_matter(base / 'SKILL.md')
    allowed = {'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'}
    for key in fm:
        if key not in allowed:
            problem('agent skill: front matter key %s is not part of the Agent Skills format' % key)
    if fm.get('name') != base.name or not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', fm.get('name') or '') or len(fm.get('name') or '') > 64:
        problem('agent skill: name must be lowercase-hyphenated, ≤ 64 characters and match its folder')
    if not 1 <= len(fm.get('description') or '') <= 1024:
        problem('agent skill: description must be 1–1024 characters')
    if len(fm.get('compatibility') or '') > 500:
        problem('agent skill: compatibility must be ≤ 500 characters')
    if (fm.get('metadata') or {}).get('version') != release['version']:
        problem('agent skill: metadata.version differs from release.json')
    service = json.loads((base / 'service.json').read_text(encoding='utf-8'))
    if service.get('mcp_url') != release['mcp_url']:
        problem('agent skill: service.json mcp_url differs from release.json')
    if service.get('status') != release.get('service_status'):
        problem('agent skill: service.json status differs from release.json service_status')
    script = (base / 'scripts' / 'xiexiubifa.py').read_text(encoding='utf-8')
    try:
        ast.parse(script, feature_version=(3, 8))
    except SyntaxError as error:
        problem('agent skill: script is not Python 3.8 syntax (%s)' % error)
    if "VERSION = '%s'" % release['version'] not in script:
        problem('agent skill: script VERSION differs from release.json')
    if "DEFAULT_SERVICE = '%s'" % release['mcp_url'] not in script:
        problem('agent skill: script DEFAULT_SERVICE differs from release.json')


def check_server(release):
    package = json.loads((ROOT / 'server' / 'package.json').read_text(encoding='utf-8'))
    if package.get('version') != release['version']:
        problem('server/package.json: version differs from release.json')
    config = (ROOT / 'server' / 'src' / 'config.cjs').read_text(encoding='utf-8')
    url = re.match(r'(https://[^/]+)(/.*)$', release['mcp_url'])
    if not url:
        problem('release.json: mcp_url must be https://host/path')
        return
    if "issuer: '%s'" % url.group(1) not in config or "mcpPath: '%s'" % url.group(2) not in config:
        problem('server/src/config.cjs: default issuer/mcpPath differ from release.json')
    if "serviceVersion: '%s'" % release['version'] not in config:
        problem('server/src/config.cjs: serviceVersion differs from release.json')


def check_status(release):
    status = release.get('service_status')
    if status not in STATUSES:
        problem('release.json: service_status must be one of %s' % ', '.join(STATUSES))
        return
    readme = (ROOT / 'README.md').read_text(encoding='utf-8')
    head = readme[:1500]
    for marker in NOT_DEPLOYED_MARKERS:
        if status == 'not_deployed' and marker not in head:
            problem('README.md: the service is not deployed, so the top of the README must say so (%s)' % marker)
        if status == 'deployed' and marker in readme:
            problem('README.md: still says %s although release.json says the service is deployed' % marker)


def files():
    for path in sorted(ROOT.rglob('*')):
        if path.is_file() and not (set(path.relative_to(ROOT).parts) & SKIP_DIRS):
            yield path


def check_secrets():
    for path in files():
        if path.suffix in ('.png', '.jpg', '.zip', '.docx'):
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        for pattern, what in SECRET_PATTERNS:
            if pattern.search(text):
                problem('%s: looks like %s' % (path.relative_to(ROOT), what))


def zip_folder(source, target, root_name):
    entries = sorted(p for p in source.rglob('*') if p.is_file() and not (set(p.relative_to(source).parts) & SKIP_DIRS) and p.name != '.DS_Store')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in entries:
            info = zipfile.ZipInfo(root_name + '/' + path.relative_to(source).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (0o755 if path.suffix == '.py' else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    return len(entries)


def set_url(url):
    if not re.fullmatch(r'https://[a-z0-9.-]+(:\d+)?/[\w./-]*', url):
        sys.exit('the address must look like https://host/path')
    release_file = ROOT / 'release.json'
    release = json.loads(release_file.read_text(encoding='utf-8'))
    old = release['mcp_url']
    release['mcp_url'] = url
    release_file.write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for rel in ('connector/mcp.json', 'agent-skill/xiexiubifa-writing/service.json', 'agent-skill/xiexiubifa-writing/scripts/xiexiubifa.py'):
        path = ROOT / rel
        path.write_text(path.read_text(encoding='utf-8').replace(old, url), encoding='utf-8')
    config = ROOT / 'server/src/config.cjs'
    match = re.match(r'(https://[^/]+)(/.*)$', url)
    text = re.sub(r"issuer: '[^']*'", "issuer: '%s'" % match.group(1), config.read_text(encoding='utf-8'), count=1)
    text = re.sub(r"mcpPath: '[^']*'", "mcpPath: '%s'" % match.group(2), text, count=1)
    config.write_text(text, encoding='utf-8')
    print('service address changed: %s → %s' % (old, url))


def set_status(status):
    """Records whether the service is live, in release.json and the agent skill's service.json. The README's status
    paragraph is the owner's to rewrite; the check then says whether it still matches."""
    if status not in STATUSES:
        sys.exit('the status must be one of: ' + ', '.join(STATUSES))
    for rel, key in (('release.json', 'service_status'), ('agent-skill/xiexiubifa-writing/service.json', 'status')):
        path = ROOT / rel
        data = json.loads(path.read_text(encoding='utf-8'))
        data[key] = status
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('service status set to %s' % status)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-build', action='store_true')
    parser.add_argument('--out', default=str(ROOT / 'dist'))
    parser.add_argument('--set-url')
    parser.add_argument('--set-status')
    args = parser.parse_args()
    if args.set_url:
        set_url(args.set_url)
    if args.set_status:
        set_status(args.set_status)
    release = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))
    meta = check_connector(release)
    check_agent_skill(release)
    check_server(release)
    check_status(release)
    check_secrets()
    for text in problems:
        print('PROBLEM ' + text)
    if problems:
        sys.exit(1)
    print('release %s: connector, agent skill, server, service address (%s) and status (%s) agree; no credentials found'
          % (release['version'], release['mcp_url'], release['service_status']))
    if args.no_build:
        return
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    built = [
        ('%s-connector-%s.zip' % (meta['source'], release['version']), ROOT / 'connector', meta['source']),
        ('xiexiubifa-writing-skill-%s.zip' % release['version'], ROOT / 'agent-skill' / 'xiexiubifa-writing', 'xiexiubifa-writing'),
    ]
    sums = []
    for name, source, root_name in built:
        count = zip_folder(source, out / name, root_name)
        digest = hashlib.sha256((out / name).read_bytes()).hexdigest()
        sums.append('%s  %s' % (digest, name))
        print('built %s (%d files) sha256 %s' % (out / name, count, digest))
    (out / 'SHA256SUMS.txt').write_text('\n'.join(sums) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
