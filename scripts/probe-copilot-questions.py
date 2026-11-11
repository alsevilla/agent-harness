#!/usr/bin/env python3
"""S3 native TUI probe (Linux/macOS; requires pexpect).
COPILOT_CLI=/path/to/copilot python3 scripts/probe-copilot-questions.py choice /tmp/new-evidence
Modes: choice, freeform, cancel, missing. Evidence directory must not exist.
Uses terminal keystrokes on a disposable fixture and a scripted localhost provider, not model inference.
"""
import os,json,threading,time,sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import pexpect
mode=sys.argv[1]
assert mode in ('choice','freeform','cancel','missing')
root=Path(sys.argv[2]).resolve();root.mkdir()
fixture=root/'fixture';fixture.mkdir()
repo=Path(__file__).resolve().parents[1]
cli=os.environ.get('COPILOT_CLI','copilot')
requests=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"object":"list","data":[{"id":"gpt-6.1-sol","object":"model"}]}')
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(b)
  (root/'requests.json').write_text(json.dumps(requests,indent=2))
  tools=[t.get('function',{}) for t in b.get('tools',[])]
  ask=next((t for t in tools if t.get('name')=='ask_user'),None)
  results=[m for m in b.get('messages',[]) if m.get('role')=='tool']
  if ask and not results:
   assert set(ask['parameters']['required']) == {'message','requestedSchema'}, 'Unrecognized native question schema'
   field={'type':'string','title':'Fixture answer'}
   if mode not in ('freeform','missing'):field.update(enum=['Alpha','Beta'],default='Alpha')
   args={'message':'ACCEPTANCE_QUESTION: choose a fixture answer','requestedSchema':{'properties':{'answer':field}}}
   delta={'tool_calls':[{'index':0,'id':'question','type':'function','function':{'name':'ask_user','arguments':json.dumps(args)}}]};finish='tool_calls'
  else:delta={'content':'INTERACTIVE_DONE'};finish='stop'
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for d,f in [({'role':'assistant',**delta},None),({},finish)]:
   self.wfile.write(('data: '+json.dumps({'id':'probe','object':'chat.completion.chunk','created':1,'model':'gpt-6.1-sol','choices':[{'index':0,'delta':d,'finish_reason':f}]})+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
env={k:os.environ[k] for k in ['PATH','HOME'] if k in os.environ}
env.update(TERM='xterm-256color',COPILOT_HOME=str(root/'profile'),COPILOT_OFFLINE='true',COPILOT_AUTO_UPDATE='false',COPILOT_TELEMETRY_DISABLED='true',COPILOT_PROVIDER_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1',COPILOT_PROVIDER_TYPE='openai',COPILOT_PROVIDER_WIRE_API='completions',COPILOT_MODEL='gpt-6.1-sol')
p=pexpect.spawn(cli,['--plugin-dir',str(repo),'--disable-client-telemetry','-i','Ask the fixture question for the native acceptance test.'],cwd=str(fixture),env=env,encoding='utf-8',timeout=20,dimensions=(40,140))
f=open(root/'terminal.txt','w');p.logfile=f
try:
 i=p.expect(['ACCEPTANCE_QUESTION','trust this folder','Do you trust','Yes, I trust','trust the files'],timeout=30)
 if i: p.send('\r');p.expect('ACCEPTANCE_QUESTION',timeout=30)
 time.sleep(.5)
 if mode in ('choice','missing'):p.send('\r')
 elif mode=='freeform':p.send('Exact fixture text 42');p.send('\r')
 elif mode=='cancel':p.sendcontrol('c')
 p.expect('INTERACTIVE_DONE',timeout=10)
 print('completed',mode)
finally:
 p.sendcontrol('c');p.sendcontrol('c');p.close(force=True);f.close();server.shutdown()
responses=[m['content'] for b in requests for m in b.get('messages',[]) if m.get('role')=='tool']
expected={'choice':'User responded: Alpha','freeform':'User responded: Exact fixture text 42',
          'cancel':'User cancelled the request.','missing':'User accepted but provided no values.'}
assert responses == [expected[mode]], responses
assert not list(fixture.iterdir()), 'Question probe mutated the fixture'
summary={'mode':mode,'status':'PASS native offline TUI','response':responses[0],
         'requests':len(requests),'dependent_mutations':0}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
