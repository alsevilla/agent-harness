import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoHooks, parseRequest, runBounded, Singleton } from './core.ts';
import { stopServer } from '../../skills/serena/scripts/serena.mjs';

// keepLink: run the path as given. A virtualenv's python (uv tools on Linux and macOS) is a symlink to the base interpreter; resolving it
// would run outside the environment, where the installed module is missing.
function file(path:string,label:string,keepLink=false) {
 if(!isAbsolute(path)||!existsSync(path)||!statSync(path).isFile())throw Error(`${label} must name an existing absolute file.`);
 return keepLink?path:realpathSync(path);
}
export function candidateRoot(cwd:string) {
 let root=realpathSync(cwd);const original=root;
 while(true){if(existsSync(join(root,'.git')))return root;const parent=dirname(root);if(parent===root)return original;root=parent}
}
function within(root:string,path:string) {
 const rel=relative(root,realpathSync(path));
 if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('Graph output links outside the selected checkout; refresh refused.');
}
// init: build the first graph. Refused where one exists (that is a plain update) and in a linked worktree, whose graph would describe one
// branch and go with the worktree at cleanup: workers in every worktree already find the primary checkout's graph.
export function graphTarget(cwd:string,explicit?:string,init=false) {
 const root=realpathSync(explicit??candidateRoot(cwd));
 const output=join(root,'graphify-out');
 if(!statSync(root).isDirectory())throw Error('Graph target must be a directory.');
 const exists=existsSync(join(output,'graph.json'));
 if(init){
  if(exists)throw Error(`${root} already has graphify-out/graph.json; use /refresh graph to update it.`);
  const git=join(root,'.git');
  if(existsSync(git)&&statSync(git).isFile())throw Error('This is a linked worktree. Build the graph in the primary checkout (/refresh graph --init "<primary checkout>"); workers in every worktree use it.');
 }else if(!exists)throw Error('Target has no existing graphify-out/graph.json. Build one with /refresh graph --init, or name the intended absolute checkout.');
 if(!existsSync(output))return root;
 const pending=[output];let checked=0;
 while(pending.length){const path=pending.pop()!;if(++checked>10000)throw Error('Graph output has too many entries to validate.');within(root,path);if(statSync(path).isDirectory())for(const name of readdirSync(path))pending.push(join(path,name))}
 return root;
}
// Where uv tool install graphifyy puts the interpreter.
export function defaultGraphPython(platform=process.platform,home=homedir()):string {
 return platform==='win32'?join(home,'AppData','Roaming','uv','tools','graphifyy','Scripts','python.exe'):join(home,'.local','share','uv','tools','graphifyy','bin','python');
}
// Graphify's pre-overwrite snapshots: graphify-out/YYYY-MM-DD folders.
export function datedBackups(output:string):{count:number;names:string[];bytes:number} {
 if(!existsSync(output))return {count:0,names:[],bytes:0};
 const names=readdirSync(output).filter(name=>/^\d{4}-\d{2}-\d{2}$/.test(name)&&statSync(join(output,name)).isDirectory()).sort();
 let bytes=0;const pending=names.map(name=>join(output,name));
 while(pending.length){const path=pending.pop()!;const stat=statSync(path);if(stat.isDirectory())for(const name of readdirSync(path))pending.push(join(path,name));else bytes+=stat.size}
 return {count:names.length,names,bytes};
}
export function gitIgnores(root:string,path:string):boolean {
 return spawnSync('git',['check-ignore','-q',path],{cwd:root,windowsHide:true,stdio:'ignore'}).status===0;
}
export default function refresh(pi:ExtensionAPI) {
 const folder=dirname(fileURLToPath(import.meta.url)); const gate=new Singleton();
 pi.registerCommand('refresh',{
  description:'Build (--init) or refresh the code graph, refresh QMD collections, or restart the serena skill\'s Serena server without a model turn',
  handler:async(args,ctx)=>{
   try {
    const request=parseRequest(args);
    await gate.run(async()=>{
     if(request.kind==='serena') {
      // The serena skill's server (agent/skills/serena) replaces pi-serena's worker: stopping it makes the next query start fresh language servers.
      ctx.ui.notify(await stopServer(),'info'); return;
     }
     const configPath=join(folder,'config.json');
     const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
     const timeout=Math.min(600000,Math.max(1000,Number(config.timeoutMs)||120000));
     let output:string;
     if(request.kind==='graph') {
      const root=graphTarget(ctx.cwd,request.root,request.init);
      const python=file(config.graphPythonPath??defaultGraphPython(),'Graphify Python (install with uv tool install graphifyy, or set graphPythonPath in config.json)',true);
      ctx.ui.notify(`${request.init?'Building':'Updating'} code graph in ${root}`,'info');
      // graphify update re-extracts code only (no LLM); on a checkout without a graph it builds the first one. GRAPHIFY_NO_BACKUP: Graphify
      // otherwise copies the whole graph into a dated graphify-out/YYYY-MM-DD folder before each day's overwrite of an LLM-built or
      // labelled graph and never removes them. GRAPHIFY_FORCE=0 still refuses a rebuild that would shrink the graph.
      output=await runBounded(python,['-m','graphify','update',root],root,timeout,undefined,{...process.env,GRAPHIFY_OUT:join(root,'graphify-out'),GRAPHIFY_FORCE:'0',GRAPHIFY_NO_BACKUP:'1',GRAPHIFY_NO_TIPS:'1',PYTHONUTF8:'1'});
      const backups=datedBackups(join(root,'graphify-out'));
      if(backups.count)output+=`\n${backups.count} dated backup folder(s) in graphify-out (${backups.names.join(', ')}; ${backups.bytes<1048576?`${Math.ceil(backups.bytes/1024)} KB`:`${Math.ceil(backups.bytes/1048576)} MB`}) are copies Graphify made before earlier overwrites. /refresh graph makes none; delete them if you do not need them.`;
      if(request.init&&!gitIgnores(root,'graphify-out'))output+='\ngraphify-out is not ignored by Git here; add it to .gitignore so the graph is not committed.';
     }else {
      const qmd=JSON.parse(readFileSync(join(folder,'..','qmd','config.json'),'utf8'));
      const node=file(qmd.nodePath,'QMD Node'); const cli=file(qmd.cliPath,'QMD CLI');
      const name=qmd.indexName??'index';if(!/^[\w-]+$/.test(name))throw Error('QMD indexName must be a simple named global index.');
      const home=process.env.HOME||process.env.USERPROFILE||homedir();
      const configDir=process.env.QMD_CONFIG_DIR||(process.env.XDG_CONFIG_HOME?join(process.env.XDG_CONFIG_HOME,'qmd'):join(home,'.config','qmd'));
      const yamlPath=file(resolve(configDir,`${name}.yml`),'Named QMD configuration');
      const yaml=createRequire(cli)('yaml');assertNoHooks(yaml.parse(readFileSync(yamlPath,'utf8')));
      ctx.ui.notify(`Updating all QMD collections in index ${name}; no embeddings or hooks.`,'info');
      output=await runBounded(node,[cli,'--index',name,'update'],ctx.cwd,timeout);
     }
     pi.sendMessage({customType:'refresh-result',content:output.trim()||'Refresh completed.',display:true},{triggerTurn:false});
     ctx.ui.notify('Refresh completed.','info');
    });
   }catch(error){ctx.ui.notify(error instanceof Error?error.message:String(error),'error')}
  },
 });
}
