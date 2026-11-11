#!/usr/bin/env python3
"""Native offline checklist probes. No model inference or remote GitHub writes.
Run: COPILOT_CLI=/path/to/copilot python3 scripts/probe-copilot-acceptance.py /tmp/new-evidence-dir
The evidence directory must not exist. Raw requests remain there; stdout is the summary JSON.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir()  # refuse to overwrite an earlier run
CLI = os.environ.get('COPILOT_CLI', 'copilot')
MODEL = 'gpt-6.1-sol'  # scripted transport ID only
ENV = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT') if k in os.environ}
ENV.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
           GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
           GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid')

def run(args, cwd=REPO, **kwargs):
    return subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=120, **kwargs)

def git(*args, cwd):
    r = run(['git', *args], cwd=cwd)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()

def manifest(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file() and '.git' not in p.parts}

def shell(command):
    return ('bash', {'command': command, 'description': 'Disposable acceptance fixture', 'mode': 'sync'})

def native(name, fixture, children):
    """Each child is (role, [(tool,args)], authority). Parent waits for each task result."""
    captures, issued = [], []
    def reply(body):
        msgs = body.get('messages', [])
        user = json.dumps([m.get('content') for m in msgs if m.get('role') == 'user'])
        results = [m for m in msgs if m.get('role') == 'tool']
        for i, (_, calls, _) in enumerate(children):
            if f'ACCEPTANCE_CHILD_{i}' in user:
                if len(results) < len(calls):
                    tool, args = calls[len(results)]
                    return call(tool, args, f'child-{i}-{len(results)}')
                return {'content': 'STATUS: COMPLETE\nNEXT: none\nRISKS: scripted dispatch only\nEVIDENCE: tool results captured by external assertions'}, 'stop'
        if len(results) < len(children):
            i = len(results)
            role, _, authority = children[i]
            packet = (f'ACCEPTANCE_CHILD_{i} Candidate: {fixture}. Task: bounded acceptance probe. '
                      f'Expected: execute the assigned fixture checks. Allowed scope: {authority}. '
                      f'Prohibited: remote operations, other file changes, helper launches. '
                      f'Required checks: return the actual tool results. Scratch/evidence/report: {OUT / name}. '
                      'Stop after assigned calls. Return a four-line handoff. Installed root: ' + str(REPO))
            return call('task', {'name': name + str(i), 'description': 'Native acceptance probe',
                        'agent_type': 'agent-harness:' + role, 'prompt': packet, 'mode': 'sync'}, f'parent-{i}')
        return {'content': 'ACCEPTANCE_DONE'}, 'stop'
    def call(tool, args, ident):
        issued.append({'id': ident, 'tool': tool, 'args': args})
        return {'tool_calls': [{'index': 0, 'id': ident, 'type': 'function',
                               'function': {'name': tool, 'arguments': json.dumps(args)}}]}, 'tool_calls'
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            self.send_response(200); self.end_headers()
            self.wfile.write(json.dumps({'object': 'list', 'data': [{'id': MODEL, 'object': 'model'}]}).encode())
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            captures.append(body)
            delta, finish = reply(body)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            for d, f in [({'role': 'assistant', **delta}, None), ({}, finish)]:
                chunk = {'id': 'acceptance', 'object': 'chat.completion.chunk', 'created': 1,
                         'model': MODEL, 'choices': [{'index': 0, 'delta': d, 'finish_reason': f}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    evidence = OUT / name
    evidence.mkdir()
    env = dict(ENV, COPILOT_HOME=str(evidence / 'profile'), COPILOT_OFFLINE='true',
               COPILOT_AUTO_UPDATE='false', COPILOT_TELEMETRY_DISABLED='true',
               COPILOT_PROVIDER_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1',
               COPILOT_PROVIDER_TYPE='openai', COPILOT_PROVIDER_WIRE_API='completions', COPILOT_MODEL=MODEL)
    before = manifest(fixture)
    try:
        r = subprocess.run([CLI, '--plugin-dir', str(REPO), '--trust-folder', '--disable-client-telemetry',
                            '--allow-all-tools', '--add-dir', str(REPO), '--add-dir', str(OUT),
                            '-p', 'Run the scripted disposable acceptance fixture.'],
                           cwd=fixture, env=env, capture_output=True, text=True, timeout=120)
    finally:
        server.shutdown(); server.server_close()
        (evidence / 'requests.json').write_text(json.dumps(captures, indent=2))
        (evidence / 'issued.json').write_text(json.dumps(issued, indent=2))
    (evidence / 'stdout.txt').write_text(r.stdout)
    (evidence / 'stderr.txt').write_text(r.stderr)
    (evidence / 'manifests.json').write_text(json.dumps({'before': before, 'after': manifest(fixture)}, indent=2))
    assert r.returncode == 0, r.stderr
    assert any('Shared Copilot bootstrap from' in json.dumps(c) for c in captures)
    results = {}
    for c in captures:
        for m in c.get('messages', []):
            if m.get('role') == 'tool': results[m.get('tool_call_id')] = m.get('content', '')
    return captures, results, before == manifest(fixture)

fixture = OUT / 'fixture'
fixture.mkdir()
(fixture / 'sample.txt').write_text('ACCEPTANCE_READ_OK\n')
summary = {'cli': run([CLI, '--version']).stdout.splitlines()[0],
           'candidate': git('rev-parse', 'HEAD', cwd=REPO),
           'method': 'Native CLI with scripted localhost provider; no model inference', 'scenarios': {}}
s = summary['scenarios']

caps, results, unchanged = native('S1', fixture, [('backend-worker', [
    ('view', {'path': str(REPO / 'agent/skills/backend/SKILL.md')})], 'read assigned installed backend module only')])
assert (REPO / 'agent/skills/backend/SKILL.md').read_text().strip() in results['child-0-0']
assert any('Installed shared-source repository root (absolute): ' + str(REPO) in json.dumps(c) for c in caps)
assert unchanged
s['S1'] = {'status': 'PASS native offline', 'evidence': 'backend-worker read installed backend/SKILL.md; child root injected; fixture unchanged'}

(fixture / 'calc.py').write_text('def add(a, b):\n    return a - b\n')
(fixture / 'check.py').write_text('from calc import add\nassert add(2, 3) == 5\nprint("GREEN")\n')
check = 'python3 -B check.py'
fix = "python3 -c " + shlex.quote("from pathlib import Path; p=Path('calc.py'); p.write_text(p.read_text().replace('a - b', 'a + b'))")
before = manifest(fixture)
caps, results, _ = native('S2', fixture, [
    ('debugger', [shell(check)], 'read-only check.py execution; do not change files'),
    ('backend-worker', [('view', {'path': str(fixture / 'calc.py')}), shell(fix), shell(check)], 'edit calc.py only; run check.py')])
assert 'AssertionError' in results['child-0-0']
assert 'GREEN' in results['child-1-2']
assert {k for k in before if before[k] != manifest(fixture)[k]} == {'calc.py'}
assert set(before) == set(manifest(fixture))
s['S2'] = {'status': 'PASS native offline', 'evidence': 'debugger RED, terminal handoff, backend-worker bounded edit, GREEN; only calc.py changed'}

names = sorted({t.get('function', {}).get('name', '') for c in caps for t in c.get('tools', [])})
s['S3'] = {'status': 'See separate interactive S3 receipts', 'ask_user_advertised': 'ask_user' in names,
           'evidence': 'ask_user omitted in -p mode; run probe-copilot-questions.py for native TUI coverage'}

_, results, unchanged = native('S4', fixture, [('scout', [('view', {'path': str(fixture / 'sample.txt')})], 'read sample.txt only')])
assert unchanged and 'ACCEPTANCE_READ_OK' in results['child-0-0']
s['S4'] = {'status': 'PASS native offline', 'evidence': 'scout read fixture; recursive content manifests unchanged; not filesystem isolation'}

# Real git stays inside disposable local repositories. The PR client is an absolute inert script.
repo, bare = OUT / 'delivery', OUT / 'remote.git'
repo.mkdir()
git('init', '-b', 'feature/acceptance', cwd=repo)
git('init', '--bare', str(bare), cwd=OUT)
git('remote', 'add', 'origin', str(bare), cwd=repo)
(repo / 'note.txt').write_text('LOCAL_DELIVERY_FIXTURE\n')
body = OUT / 'pr-body.md'; body.write_text('Local fixture PR body\n')
stub = OUT / 'gh'
stub.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\n'
                + 'args=sys.argv[1:]\nassert args[:2] in (["pr","create"],["pr","edit"])\n'
                + 'body=Path(args[args.index("--body-file")+1]).read_text()\n'
                + f'with open({str(OUT / "pr-calls.jsonl")!r},"a") as f: f.write(json.dumps(dict(args=args,body=body))+"\\n")\n'
                + 'print("INERT_PR_RECORDED")\n')
stub.chmod(0o700)
_, results, _ = native('S5', repo, [('release-engineer', [shell('git add note.txt'),
    shell('git commit -m "Local acceptance fixture"'), shell('git push origin feature/acceptance'),
    shell(f'{shlex.quote(str(stub))} pr create --body-file {shlex.quote(str(body))}'),
    shell(f'{shlex.quote(str(stub))} pr edit 1 --body-file {shlex.quote(str(body))}')],
    'commit note.txt and non-force push only to the local bare origin; PR calls only through the provided inert absolute client')])
assert git('rev-parse', 'HEAD', cwd=repo) == git('rev-parse', 'refs/heads/feature/acceptance', cwd=bare)
records = [json.loads(l) for l in (OUT / 'pr-calls.jsonl').read_text().splitlines()]
assert len(records) == 2 and all(r['body'] == body.read_text() for r in records)
s['S5'] = {'status': 'PARTIAL: native local delivery passed', 'evidence': 'local commit and feature push; inert PR create/edit recorded exact body',
           'not_tested': 'model compliance with failed-check/local-only packets; real GitHub effects'}

# These are hook inputs, NEVER executed shell commands.
merge = ['gh pr merge 7 --squash', 'gh api -X PUT repos/fixture/repo/pulls/7/merge',
         'echo fixture\ngh pr merge 7', 'echo fixture\r\ngh pr merge 7']
release = ['gh release create v1', 'gh release edit v1 --draft=false', 'gh release upload v1 artifact.zip',
           'gh release delete v1', 'git push origin refs/tags/v1', 'git push --mirror origin',
           'gh api repos/fixture/repo/git/refs -f ref=refs/tags/v1']
for name, commands in [('S6', merge), ('S7', release)]:
    receipts = []
    for tool in ['bash', 'powershell']:
        for command in commands:
            payload = dict(toolName=tool, toolArgs={'command': command}, cwd=str(fixture), answer='approved')
            r = run(['node', str(REPO / '.github/plugin/release-guard.mjs')], input=json.dumps(payload))
            response = json.loads(r.stdout)
            assert r.returncode == 0 and response['permissionDecision'] == 'deny'
            assert 'unsupported' in response['permissionDecisionReason']
            receipts.append({'input': payload, 'response': response})
    if name == 'S6':
        r = run(['node', str(REPO / '.github/plugin/release-guard.mjs')], input='{')
        assert r.returncode == 2 and not r.stdout
        receipts.append({'malformed_input_exit': r.returncode, 'stderr': r.stderr})
    (OUT / (name + '-hook.json')).write_text(json.dumps(receipts, indent=2))
    s[name] = {'status': 'PASS hook-only', 'cases': len(receipts), 'evidence': 'deny + reason; no shell/client execution'}

(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
