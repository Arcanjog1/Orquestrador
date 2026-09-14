/** Opt-in packaged two-stage loop validation using the person's existing connected accounts.
 * Credentials remain local, in a disposable copy; no source profile is run.
 * Requires --source-home, --source-chromium, --binary and --output.
 * Never runs in credential-free CI.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, cpSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeTwoStageCheck } from '../../../scripts/lib/two-stage-check.mjs';

const option = name => process.argv.find(a => a.startsWith(name+'='))?.slice(name.length+1);
for(const name of ['--source-home','--source-chromium','--binary','--output'])assert.ok(option(name),name+' is required');
const source=resolve(option('--source-home')), binary=resolve(option('--binary')), output=resolve(option('--output'));
mkdirSync(output,{recursive:true});
const home=mkdtempSync(join(tmpdir(),'orchestrator-final-live-'));
mkdirSync(join(home,'data'));
// safeStorage's encrypted key belongs to this Chromium profile. Copy only the
// key store, never cookies, browsing history or the original live directory.
mkdirSync(join(home,'chromium'));
copyFileSync(join(resolve(option('--source-chromium')),'Local State'),join(home,'chromium','Local State'));
const original=new DatabaseSync(join(source,'data','orchestrator.db'),{readOnly:true});
await backup(original,join(home,'data','orchestrator.db'));original.close();
const credentialCopies=[];
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const db=new DatabaseSync(join(home,'data','orchestrator.db'));
for(const account of db.prepare('SELECT id, profile_directory FROM accounts').all()) {
  const profile=join(home,'profiles',account.id);mkdirSync(profile,{recursive:true});
  for(const name of ['auth.json','.credentials.json','.claude.json']) {
    const file=join(account.profile_directory,name);
    if(existsSync(file)){copyFileSync(file,join(profile,name));if(['auth.json','.credentials.json'].includes(name))credentialCopies.push({source:file,copy:join(profile,name),original:digest(file)});}
  }
  db.prepare('UPDATE accounts SET profile_directory=? WHERE id=?').run(profile,account.id);
}
db.close();
cpSync(join(source,'runtimes'),join(home,'runtimes'),{recursive:true});
const scratch=mkdtempSync(join(tmpdir(),'orchestrator-final-workspace-'));
for(const args of [['init','-q'],['config','user.email','smoke@local'],['config','user.name','smoke']])execFileSync('git',args,{cwd:scratch});
writeFileSync(join(scratch,'README.md'),'# Isolated real provider validation\n');
execFileSync('git',['add','.'],{cwd:scratch});execFileSync('git',['commit','-qm','baseline'],{cwd:scratch});
const verification=writeTwoStageCheck({hello:'Olá AI Orchestrator',then:{file:'bye.txt',content:'Tchau'},prefix:'orchestrator-final-check-'});
const {AppServices}=await import('../dist/apps/desktop/src/main/services/app-services.js');
const {appPaths}=await import('../dist/src/runtime/paths.js');
const services=new AppServices({paths:appPaths({...process.env,AI_ORCHESTRATOR_HOME:home})});
const accounts=services.accounts.list();
const codex=accounts.find(a=>a.provider==='openai'&&a.state==='connected');
const claude=accounts.find(a=>a.provider==='anthropic'&&a.state==='connected'&&(!option('--worker-account')||a.id===option('--worker-account')));
assert.ok(codex&&claude,'Both real provider accounts are connected');
const workspace=services.workspaces.create({name:'Validação real · Codex e Claude',localPath:scratch});
const programmer=services.agents.create({name:'Programador · validação',role:'CODING_WORKER',provider:'anthropic',accountId:claude.id,model:null,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true});
services.workspaces.setTeam(workspace.id,{accountId:codex.id},{accountId:claude.id,agentId:programmer.id});
services.database.verifications.upsert({workspaceId:workspace.id,id:'registered-check',label:'o workspace passa na verificação registrada',command:verification.command});
const project=services.projects.create({name:'Validação final real',workspaceId:workspace.id});
const session=services.database.chat.createSession({id:'final-live-session',workspaceId:workspace.id,projectId:project.id,title:'Codex → Claude → relatório → nova tarefa → resposta final'});
await services.shutdown();
const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const env={...process.env,AI_ORCHESTRATOR_HOME:home};delete env.ELECTRON_RUN_AS_NODE;delete env.AI_ORCHESTRATOR_SMOKE;
const child=spawn(binary,[`--remote-debugging-port=${port}`,`--user-data-dir=${join(home,'chromium')}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
// Do not persist provider logs, which can contain account diagnostics.
child.stdout.resume();child.stderr.resume();
const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket,serial=0;const pending=new Map();
const send=(method,params={})=>new Promise((res,rej)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);rej(Error('CDP timeout: '+method));},30000);pending.set(id,{res,rej,timer});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const waitFor=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Not found: '+expression+' '+await evaluate('document.body.innerText.slice(0,1000)'));};
const click=async selector=>{const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});await delay(200);};
const unwrap=value=>{if(value&&value.ok===false)throw Error(JSON.stringify(value));return value?.value??value;};
let result={packaged:false,artifact:{binary,asarSha256:createHash('sha256').update(readFileSync(join(dirname(binary),'resources','app.asar'))).digest('hex'),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},scratch,objective:'Crie hello.txt com o conteúdo exato entre estes delimitadores, sem incluir os delimitadores: <conteudo>Olá AI Orchestrator</conteudo>. A verificação registrada neste workspace é o critério de aceitação completo: peça-a por id em toda iteração e, se ela falhar, delegue exatamente a correção que ela reportar. Só responda done quando ela passar.',checks:[]};
const check=(name,fn)=>{fn();result.checks.push(name);console.log('PASS '+name);};
const api=(method,args)=>evaluate('window.api.'+method+'('+JSON.stringify(args)+')').then(unwrap);
const screenshot=async name=>writeFileSync(join(output,name+'.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
try {
  let page;
  for(let i=0;i<200;i++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');if(page)break;}catch{}await delay(100);}
  assert.ok(page,'Packaged app exposes CDP');socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});
  socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.rej(Error(JSON.stringify(m.error))):p.res(m.result);}};
  await waitFor('!!window.api');
  result.app=unwrap(await evaluate('window.api.app.info()'));result.packaged=result.app.packaged;assert.equal(result.packaged,true);
  await delay(1000);
  if(await evaluate('!!document.querySelector("[data-testid=start]")'))await click('[data-testid=start]');
  if(await evaluate('!!document.querySelector("[data-testid=skip-onboarding]")'))await click('[data-testid=skip-onboarding]');
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await send('Emulation.setDeviceMetricsOverride',{width:1672,height:941,deviceScaleFactor:1,mobile:false});
  await waitFor(`!!document.querySelector('[data-testid="open-session-${session.id}"]')`);
  await click(`[data-testid="open-project-${project.id}"]`);await delay(1000);
  await click(`[data-testid="open-session-${session.id}"]`);
  await waitFor('!!document.querySelector("[data-testid=composer-input]")');
  await click('[data-testid=composer-input]');await send('Input.insertText',{text:result.objective});await click('[data-testid=composer-send]');
  let run,last='',capturedFailure=false;
  for(let i=0;i<1800;i++) {
    const runs=await api('run.list',{workspaceId:workspace.id});run=runs.find(r=>r.sessionId===session.id);
    if(run) {
      result.run=run;
      const detail=await api('run.detail',{runId:run.id});
      const state=JSON.stringify({status:run.status,iterations:run.iterations,invocations:detail.invocations.length,step:detail.steps.at(-1)?.phase});
      if(state!==last){console.log(state);last=state;writeFileSync(join(output,'progress.json'),JSON.stringify({run,steps:detail.steps,invocations:detail.invocations},null,2));}
      if(!capturedFailure&&detail.verifications.some(v=>v.passed===false||v.passed===0)){await screenshot('first-report');capturedFailure=true;}
      if(!['PENDING','RUNNING'].includes(run.status))break;
    }
    await delay(1000);
  }
  assert.ok(run,'Composer started a run');
  const detail=await api('run.detail',{runId:run.id});result.detail=detail;
  result.messages=await api('chat.listMessages',{sessionId:session.id});
  await click('button[aria-label="Ajustar à tela"]');await delay(400);await screenshot('real-worktree');
  await click('.run-view-tabs button:nth-child(2)');await delay(400);await screenshot('real-journal');
  result.ui=await evaluate('document.body.innerText');
  const workers=detail.invocations.filter(i=>i.role==='CODING_WORKER');
  const orchestrators=detail.invocations.filter(i=>i.role==='ORCHESTRATOR');
  result.bindings={orchestrator:{provider:codex.provider,name:codex.name},worker:{provider:claude.provider,name:claude.name}};
  check('packaged Electron executable',()=>assert.equal(result.packaged,true));
  check('single user message',()=>assert.equal(result.messages.filter(m=>m.author==='user').length,1));
  check('real Codex invoked',()=>assert.ok(orchestrators.length>=2));
  check('real Claude invoked at least twice',()=>assert.ok(workers.length>=2));
  check('second task derives from verification report',()=>{assert.doesNotMatch(result.objective,/bye.txt|Tchau/);assert.match(workers[1].task,/bye.txt|Tchau/);});
  check('verification initially fails then passes',()=>{assert.ok(detail.verifications.some(v=>!v.passed));assert.ok(detail.verifications.at(-1)?.passed);});
  check('both output files have expected content',()=>{assert.equal(readFileSync(join(scratch,'hello.txt'),'utf8').trim(),'Olá AI Orchestrator');assert.equal(readFileSync(join(scratch,'bye.txt'),'utf8').trim(),'Tchau');});
  check('Done Gate completes',()=>assert.equal(run.status,'DONE'));
  check('one final response event',()=>assert.equal(detail.executionEvents.filter(e=>e.type==='FINAL_RESPONSE').length,1));
  result.ok=true;
  console.log(JSON.stringify({ok:true,status:run.status,codex:orchestrators.length,claude:workers.length,checks:result.checks.length}));

} catch(error) {if(socket?.readyState===1){try{await screenshot('failure');result.workspaces=await api('workspace.list');}catch{}}result.error=String(error);console.error(String(error));process.exitCode=1;}
finally {
  if(result.run&&['PENDING','RUNNING'].includes(result.run.status)&&socket?.readyState===1){try{await api('run.cancel',{runId:result.run.id});}catch{}}
  writeFileSync(join(output,'real-loop.json'),JSON.stringify(result,null,2));
  if(socket?.readyState===1){try{await send('Browser.close');}catch{}}socket?.close();
  if(child.exitCode===null)child.kill();await delay(1500);
  // OAuth refresh can rotate a token. Preserve a refreshed credential only
  // when its source still matches the original copy (never overwrite a new login).
  for(const c of credentialCopies)if(existsSync(c.copy)&&existsSync(c.source)&&digest(c.source)===c.original&&digest(c.copy)!==c.original)copyFileSync(c.copy,c.source);
  // The exact generated directory is checked before recursive deletion.
  const rel=relative(resolve(tmpdir()),resolve(home));
  assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('orchestrator-final-live-'));
  for(let i=0;i<10;i++){try{rmSync(home,{recursive:true,force:true});break;}catch(error){if(i===9)throw error;await delay(1000);}}
}
