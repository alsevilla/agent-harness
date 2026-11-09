# Native Copilot request-size experiment. Requires Python 3 and an installed Copilot CLI.
# COPILOT_CLI=/path/to/copilot python3 scripts/simulate-copilot-input.py > results.json
# All responses are scripted over localhost; no hosted inference or pricing projection.
import json,math,os,subprocess,tempfile,threading,sys
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
CLI=os.environ.get('COPILOT_CLI','copilot')
PLUGIN=str(Path(__file__).resolve().parent.parent)
SCENARIOS=[('small',4,4000),('repeated',12,8000),('large',30,20000)]
# Count only model inputs (messages and tool schemas), not HTTP/config fields. Token estimate is characters / 4.
def compact(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def tokens(x):return math.ceil(len(compact(x))/4)
def run(name,n,size,arm):
 with tempfile.TemporaryDirectory(prefix='copilot-estimate-') as root:
  base=Path(root);cwd=base/'fixture';cwd.mkdir();state=base/'state'
  paths=[]
  for i in range(n):
   p=cwd/f'file-{i%2 if name=="repeated" else i:02d}.txt';p.write_text(('fixture line\n'*math.ceil(size/13))[:size]);paths.append(str(p))
  groups=3 if arm in ['harness-three','plain-fresh-three'] else 1
  chunks=[paths[i*n//groups:(i+1)*n//groups] for i in range(groups)]
  captures=[];sent_calls=[]
  def tool(name,args,ident):
   sent_calls.append(name)
   return {'tool_calls':[{'index':0,'id':ident,'type':'function','function':{'name':name,'arguments':compact(args)}}]},'tool_calls'
  def reply(body):
   msgs=body.get('messages',[]);users=' '.join(compact(m.get('content')) for m in msgs if m.get('role')=='user')
   results=[m for m in msgs if m.get('role')=='tool']
   import re
   child=re.search(r'FIXTURE_CHILD_(\d+)',users)
   plain=re.search(r'FIXTURE_PLAIN_(\d+)',users)
   if child or plain:
    k=int((child or plain).group(1));files=chunks[k];idx=len(results)
    if idx<len(files):return tool('view',{'path':files[idx]},f'read-{k}-{idx}')
    return {'content':'STATUS: PASS\nNEXT: none\nRISKS: scripted read-only fixture\nEVIDENCE: '+files[-1]},'stop'
   # Harness main adds two scouting reads, then delegates every original read in scoped packets.
   idx=len(results)
   if idx<2:return tool('view',{'path':paths[idx]},f'main-read-{idx}')
   k=idx-2
   if k<groups:
    packet=f'FIXTURE_CHILD_{k}. Candidate: {cwd}. Read only these files, in order: '+compact(chunks[k])+f'. Expected: inspect all listed files. No mutation or helpers. Required checks: view each file. Scratch: {cwd}. Evidence/report: {chunks[k][-1]}.'
    return tool('task',{'name':f'worker-{k}','description':'Inspect bounded fixture','agent_type':'agent-harness:general-worker','prompt':packet,'mode':'sync'},f'delegate-{k}')
   return {'content':'STATUS: PASS\nNEXT: none\nRISKS: scripted read-only fixture\nEVIDENCE: '+paths[-1]},'stop'
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))));captures.append(body)
    delta,finish=reply(body)
    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
    for d,f in [(dict(role='assistant',**delta),None),({},finish)]:
     data={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'gpt-6.1-sol','choices':[{'index':0,'delta':d,'finish_reason':f}]}
     self.wfile.write(('data: '+compact(data)+'\n\n').encode())
    self.wfile.write(b'data: [DONE]\n\n')
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
  env=dict(os.environ,COPILOT_HOME=str(state),COPILOT_OFFLINE='true',COPILOT_AUTO_UPDATE='false',COPILOT_TELEMETRY_DISABLED='true',COPILOT_PROVIDER_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1',COPILOT_PROVIDER_TYPE='openai',COPILOT_MODEL='gpt-6.1-sol',COPILOT_PROVIDER_WIRE_API='completions')
  for k in ['COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','COPILOT_PROVIDER_API_KEY','COPILOT_PROVIDER_API_KEY_COMMAND','COPILOT_PROVIDER_BEARER_TOKEN','COPILOT_PROVIDER_HEADERS']:env.pop(k,None)
  try:
   for group in range(groups if arm=='plain-fresh-three' else 1):
    args=[CLI,'--trust-folder','--disable-client-telemetry','--allow-tool','view']
    if arm.startswith('harness'):args+=['--plugin-dir',PLUGIN];prompt='Inspect the fixture through the harness, using the scripted scoped workers. Read only; no mutations.'
    else:prompt=f'FIXTURE_PLAIN_{group}. Inspect these fixture files in order: '+compact(chunks[group])+'. Read only; no mutations.'
    r=subprocess.run(args+['-p',prompt],cwd=cwd,env=env,capture_output=True,text=True,timeout=90)
    if r.returncode:raise RuntimeError(r.stderr[-2000:])
  finally:server.shutdown();server.server_close()
  expected=n+(2 if arm.startswith('harness') else 0)
  assert sent_calls.count('view')==expected,(arm,sent_calls)
  # A view must have actually returned the fixture, not a denied/error result.
  viewed={m.get('tool_call_id') for b in captures for m in b['messages'] if m.get('role')=='tool' and 'fixture line' in str(m.get('content'))}
  assert len(viewed)==expected,(arm,len(viewed),expected)
  sizes=[tokens({'messages':b['messages'],'tools':b.get('tools',[])}) for b in captures]
  return {'scenario':name,'arm':arm,'readCalls':expected,'requests':len(captures),'inputTokenEstimate':sum(sizes),'peakInputTokenEstimate':max(sizes)}
version=subprocess.check_output([CLI,'--version'],text=True).splitlines()[0]
results=[]
for name,n,size in SCENARIOS:
 for arm in ['plain','harness-one','plain-fresh-three','harness-three']:
  r=run(name,n,size,arm);results.append(r);print(json.dumps(r),file=sys.stderr,flush=True)
print(json.dumps({'cli':version,'configuredModel':'gpt-6.1-sol','modelInference':False,
 'harnessCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=PLUGIN,text=True).strip(),
 'method':'actual CLI, scripted local provider; input messages+tools characters/4; no cache/billing/quality estimate',
 'scenarios':SCENARIOS,'results':results},indent=2))
