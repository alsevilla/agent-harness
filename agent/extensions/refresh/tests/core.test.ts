import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { parseRequest, runBounded, Singleton, assertNoHooks } from '../core.ts';
import refresh, {candidateRoot,datedBackups,defaultGraphPython,graphTarget} from '../index.ts';
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parses exact targets and rejects extra commands', () => {
 assert.deepEqual(parseRequest('graph "C:/Repo With Space"'), {kind:'graph', root:'C:/Repo With Space'});
 assert.deepEqual(parseRequest('qmd'), {kind:'qmd'});
 assert.throws(() => parseRequest('qmd embed'));
 assert.throws(() => parseRequest('graph relative/path'));
 assert.throws(() => parseRequest('serena junk'));
 assert.deepEqual(parseRequest('graph --init'), {kind:'graph', init:true});
 assert.deepEqual(parseRequest('graph --init "C:/Repo With Space"'), {kind:'graph', root:'C:/Repo With Space', init:true});
 assert.throws(() => parseRequest('graph --init relative/path'));
 assert.throws(() => parseRequest('graph --initx'));
 assert.throws(() => parseRequest('qmd --init'));
});
test('graph --init builds only where no graph exists, never in a linked worktree',()=>{
 const temp=mkdtempSync(join(tmpdir(),'pi-refresh-init-'));
 try{
  const primary=join(temp,'primary'),worktree=join(temp,'worktree');
  mkdirSync(join(primary,'.git','worktrees','w'),{recursive:true});mkdirSync(worktree);writeFileSync(join(worktree,'.git'),'gitdir: '+join(primary,'.git','worktrees','w'));
  writeFileSync(join(primary,'.git','worktrees','w','commondir'),'../..');
  assert.equal(graphTarget(primary,undefined,true),primary);
  assert.equal(existsSync(join(primary,'graphify-out')),false,'choosing the target writes nothing');
  assert.throws(()=>graphTarget(worktree,undefined,true),/linked worktree.*primary checkout/);
  mkdirSync(join(primary,'graphify-out'));writeFileSync(join(primary,'graphify-out','graph.json'),'{}');
  assert.throws(()=>graphTarget(primary,undefined,true),/already has graphify-out\/graph.json/);
  assert.equal(graphTarget(primary),primary);
 }finally{rmSync(temp,{recursive:true,force:true})}
});
test('explicit nested targets use the checkout root; separate Git directories are not linked worktrees',()=>{
 const temp=mkdtempSync(join(tmpdir(),'pi-refresh-layout-'));
 const git=(args:string[])=>execFileSync('git',args,{stdio:'pipe'});
 try{
  const primary=join(temp,'primary'),linked=join(temp,'linked'),separate=join(temp,'separate');
  git(['init',primary]);
  git(['-C',primary,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','--allow-empty','-m','fixture']);
  git(['-C',primary,'worktree','add','-b','linked',linked]);
  mkdirSync(join(primary,'src'));mkdirSync(join(linked,'src'));
  assert.equal(graphTarget(primary,join(primary,'src'),true),candidateRoot(primary));
  assert.throws(()=>graphTarget(primary,join(linked,'src'),true),/linked worktree/);
  mkdirSync(join(primary,'graphify-out'));writeFileSync(join(primary,'graphify-out','graph.json'),'{}');
  assert.throws(()=>graphTarget(primary,join(primary,'src'),true),/already has/);
  assert.throws(()=>graphTarget(primary,join(primary,'graphify-out','graph.json'),true),/must be a directory/);
  git(['init','--separate-git-dir',join(temp,'metadata'),separate]);
  assert.equal(graphTarget(separate,undefined,true),candidateRoot(separate));
  assert.equal(existsSync(join(separate,'graphify-out')),false);
  assert.equal(existsSync(join(linked,'src','graphify-out')),false);
 }finally{rmSync(temp,{recursive:true,force:true})}
});
test('rejects hooks including YAML inline objects', () => {
 assertNoHooks({collections:{notes:{path:'x'}}});
 assert.throws(() => assertNoHooks({collections:{notes:{update:'git pull'}}}));
});
test('singleton releases on failure and forbids concurrent work', async () => {
 const gate=new Singleton(); let release:any;
 const first=gate.run(()=>new Promise<void>(r=>release=r));
 await assert.rejects(gate.run(async()=>{}), /already running/); release(); await first;
 await assert.rejects(gate.run(async()=>{throw Error('broken')}));
 await gate.run(async()=>{});
});
function fakeSpawn(code:number, output:string, capture:any) {
 return (_exe:any,_args:any,options:any) => {
  capture.options=options; const child:any=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.kill=()=>{capture.killed=true; queueMicrotask(()=>child.emit('close',null)); return true};
  if(code>=0) queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(output));child.emit('close',code)});
  return child;
 };
}
test('bounded process hides Windows and reports exit/output/timeout', async()=>{
 const capture:any={}; const result=await runBounded('node',['test'],'C:/',100,fakeSpawn(0,'ok',capture));
 assert.equal(result,'ok'); assert.equal(capture.options.shell,false); assert.equal(capture.options.windowsHide,true);
 await assert.rejects(runBounded('node',[],'C:/',100,fakeSpawn(2,'bad',{})),/exited 2/);
 const timeout:any={}; await assert.rejects(runBounded('node',[],'C:/',10,fakeSpawn(-1,'',timeout)),/timed out/); assert.equal(timeout.killed,true);
 const excess:any={}; await assert.rejects(runBounded('node',[],'C:/',100,fakeSpawn(0,'x'.repeat(300000),excess)),/output limit/); assert.equal(excess.killed,true);
});
test('graph resolves candidate Git root, never initializes and rejects output junction escape',()=>{
 const temp=mkdtempSync(join(tmpdir(),'pi-refresh-test-'));const candidate=join(temp,'candidate'),other=join(temp,'other');
 try{
  mkdirSync(join(candidate,'nested'),{recursive:true});mkdirSync(join(candidate,'.git'));mkdirSync(other);
  assert.equal(candidateRoot(join(candidate,'nested')),candidate);
  assert.throws(()=>graphTarget(candidate),/no existing.*--init/);assert.equal(existsSync(join(candidate,'graphify-out')),false);
  mkdirSync(join(other,'graphify-out'));writeFileSync(join(other,'graphify-out','graph.json'),'{}');
  symlinkSync(join(other,'graphify-out'),join(candidate,'graphify-out'),'junction');
  assert.throws(()=>graphTarget(candidate),/outside/);
  assert.equal(graphTarget(candidate,other),other);
 }finally{rmSync(temp,{recursive:true,force:true})}
});
test('/refresh serena stops the serena skill server (here: none running) and never requests a model turn',async()=>{
 const saved=process.env.HARNESS_SERENA_PORT;process.env.HARNESS_SERENA_PORT='1'; // nothing listens on port 1, so no real server is touched
 try {
  let handler:any;const messages:any[]=[];const notices:any[]=[];
  refresh({registerCommand:(_name:any,options:any)=>handler=options.handler,sendUserMessage:(...args:any[])=>messages.push(args)} as any);
  await handler('serena',{cwd:process.cwd(),ui:{notify:(...args:any[])=>notices.push(args)}});
  assert.equal(messages.length,0);
  assert.deepEqual(notices,[['No Serena server is running on 127.0.0.1:1; the next query starts one.','info']]);
 } finally { if(saved===undefined)delete process.env.HARNESS_SERENA_PORT;else process.env.HARNESS_SERENA_PORT=saved; }
});
test('default Graphify interpreter is the uv tool install location on each platform',()=>{
 assert.match(defaultGraphPython('win32','D:/h'),/AppData[\\/]Roaming[\\/]uv[\\/]tools[\\/]graphifyy[\\/]Scripts[\\/]python\.exe$/);
 assert.match(defaultGraphPython('linux','/h'),/\.local[\\/]share[\\/]uv[\\/]tools[\\/]graphifyy[\\/]bin[\\/]python$/);
});
test('dated backup folders in graphify-out are counted with their size; other folders are not',()=>{
 const temp=mkdtempSync(join(tmpdir(),'pi-refresh-backups-'));
 try{
  assert.deepEqual(datedBackups(join(temp,'missing')),{count:0,names:[],bytes:0});
  for(const name of ['2026-11-06','2026-11-07','cache'])mkdirSync(join(temp,name));
  writeFileSync(join(temp,'2026-11-06','graph.json'),'x'.repeat(100));writeFileSync(join(temp,'2026-11-07','graph.json'),'y'.repeat(50));writeFileSync(join(temp,'cache','a.json'),'z'.repeat(999));
  assert.deepEqual(datedBackups(temp),{count:2,names:['2026-11-06','2026-11-07'],bytes:150});
 }finally{rmSync(temp,{recursive:true,force:true})}
});
