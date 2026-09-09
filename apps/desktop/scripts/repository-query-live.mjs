/** Opt-in packaged regression using the person's existing connected accounts.
 * Credentials remain local, in a disposable copy; no source profile is run.
 * Requires --source-home, --source-chromium, --binary and --output.
 * Never runs in credential-free CI.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const option = name => process.argv.find(a => a.startsWith(name+'='))?.slice(name.length+1);
for(const name of ['--source-home','--source-chromium','--binary','--output'])assert.ok(option(name),name+' is required');
const source=resolve(option('--source-home')), binary=resolve(option('--binary')), output=resolve(option('--output'));
mkdirSync(output,{recursive:true});
const home=mkdtempSync(join(tmpdir(),'orchestrator-query-live-'));
mkdirSync(join(home,'data'));
// safeStorage's encrypted key belongs to this Chromium profile. Copy only the
// key store, never cookies, browsing history or the original live directory.
mkdirSync(join(home,'chromium'));
copyFileSync(join(resolve(option('--source-chromium')),'Local State'),join(home,'chromium','Local State'));
const original=new DatabaseSync(join(source,'data','orchestrator.db'),{readOnly:true});
await backup(original,join(home,'data','orchestrator.db'));original.close();
const db=new DatabaseSync(join(home,'data','orchestrator.db'));
for(const account of db.prepare('SELECT id, profile_directory FROM accounts').all()) {
  const profile=join(home,'profiles',account.id);mkdirSync(profile,{recursive:true});
  for(const name of ['auth.json','.credentials.json','.claude.json']) {
    const file=join(account.profile_directory,name);
    if(existsSync(file))copyFileSync(file,join(profile,name));
  }
  db.prepare('UPDATE accounts SET profile_directory=? WHERE id=?').run(profile,account.id);
}
db.close();
cpSync(join(source,'runtimes'),join(home,'runtimes'),{recursive:true});
const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const env={...process.env,AI_ORCHESTRATOR_HOME:home};delete env.ELECTRON_RUN_AS_NODE;delete env.AI_ORCHESTRATOR_SMOKE;
const child=spawn(binary,[`--remote-debugging-port=${port}`,`--user-data-dir=${join(home,'chromium')}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
// Do not persist provider logs, which can contain account diagnostics.
child.stdout.resume();child.stderr.resume();
const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket,serial=0;const pending=new Map();
const send=(method,params={})=>new Promise((res,rej)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);rej(Error('CDP timeout: '+method));},30000);pending.set(id,{res,rej,timer});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const waitFor=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Not found: '+expression+' '+await evaluate('document.body.innerText.slice(0,1000)'));};
const click=async selector=>{const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});await delay(200);};
const unwrap=value=>{if(value&&value.ok===false)throw Error(JSON.stringify(value));return value?.value??value;};
let result={packaged:false,objective:'consegue acessar esse repositorio?'};
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
  const workspace=unwrap(await evaluate(`window.api.workspace.createGitHub({repository:'Arcanjog1/teste',branch:'main'})`));
  const projects=unwrap(await evaluate('window.api.project.list()'));
  const project=projects.find(p=>p.workspaceId===workspace.id);
  const session=unwrap(await evaluate(`window.api.chat.createSession(${JSON.stringify({workspaceId:workspace.id,title:'Consulta read-only · regressão',projectId:project?.id??null})})`));
  // Refresh the mounted sidebar after creating a session through the real IPC.
  await evaluate('location.reload();true');await delay(1000);
  await waitFor(`!!document.querySelector('[data-testid="open-session-${session.id}"]')`);
  await click(`[data-testid="open-session-${session.id}"]`);
  await waitFor('!!document.querySelector("[data-testid=composer-input]")');
  await click('[data-testid=composer-input]');await send('Input.insertText',{text:result.objective});await click('[data-testid=composer-send]');
  let run;
  for(let i=0;i<240;i++) {
    const runs=unwrap(await evaluate(`window.api.run.list({workspaceId:${JSON.stringify(workspace.id)}})`));
    run=runs.find(r=>r.sessionId===session.id);
    if(run&&!['PENDING','RUNNING'].includes(run.status))break;
    await delay(1000);
  }
  assert.ok(run,'Composer started a run');
  const detail=unwrap(await evaluate(`window.api.run.detail({runId:${JSON.stringify(run.id)}})`));
  result.run=run;result.steps=detail.steps;result.invocations=detail.invocations;
  result.ui=await evaluate('document.body.innerText');
  await click('button[aria-label="Ajustar à tela"]');
  writeFileSync(join(output,'query-live.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  assert.equal(run.status,'DONE',JSON.stringify(run));assert.equal(run.iterations,1);
  assert.equal(detail.invocations.filter(i=>i.role==='ORCHESTRATOR').length,1);
  assert.equal(detail.invocations.filter(i=>i.role==='CODING_WORKER').length,0);
  assert.ok(detail.steps.some(s=>s.phase==='query-proof'&&s.status==='passed'));
  assert.equal(detail.steps.filter(s=>['commit','pull-request'].includes(s.phase)&&s.status==='created').length,0);
  assert.ok(!result.ui.includes('--allow-no-changes'));
  result.graph=await evaluate(`({workers:document.querySelectorAll('.node-worker').length,running:document.querySelectorAll('.node-pulse').length,nodes:[...document.querySelectorAll('[data-node-id]')].map(e=>({id:e.getAttribute('data-node-id'),status:e.getAttribute('data-status')}))})`);
  assert.equal(result.graph.workers,0);assert.equal(result.graph.running,0);
  assert.ok(result.graph.nodes.length,'Execution Worktree is rendered');
  assert.equal(result.graph.nodes.length,4,'Simple query retains only objective, Codex, proof and DONE');
  assert.ok(!result.graph.nodes.some(n=>['running','started'].includes(n.status)));
  await click('.run-view-tabs button:nth-child(2)');
  const activityButton='button[aria-label="Abrir painel de atividade"]';
  if(await evaluate('!!document.querySelector('+JSON.stringify(activityButton)+')'))await click(activityButton);
  const snapshot=()=>evaluate(`({running:document.querySelectorAll('.animate-spin,.node-pulse').length,times:[...document.querySelectorAll('div')].filter(e=>e.children.length===0&&e.textContent.trim()==='Tempo').map(e=>e.nextElementSibling?.textContent),nodes:[...document.querySelectorAll('[data-node-id]')].map(e=>({id:e.getAttribute('data-node-id'),status:e.getAttribute('data-status')}))})`);
  const before=await snapshot();await delay(2500);const after=await snapshot();
  result.activity={before,after};assert.equal(after.running,0);assert.ok(after.times.length,'Activity exposes elapsed time');assert.deepEqual(after.times,before.times);
  assert.ok(!after.nodes.some(n=>['running','started'].includes(n.status)));
  writeFileSync(join(output,'query-activity.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  const read=new DatabaseSync(join(home,'data','orchestrator.db'),{readOnly:true});
  const answers=read.prepare("SELECT body FROM messages WHERE run_id=? AND author='orchestrator'").all(run.id);read.close();
  result.answers=answers;assert.equal(answers.length,1);
  console.log(JSON.stringify({status:run.status,iterations:run.iterations,answers:answers.length,workers:0,spinners:0}));
} catch(error) {result.error=String(error);console.error(String(error));process.exitCode=1;}
finally {
  writeFileSync(join(output,'query-live.json'),JSON.stringify(result,null,2));
  if(socket?.readyState===1){try{await send('Browser.close');}catch{}}socket?.close();
  if(child.exitCode===null)child.kill();await delay(1500);
  // The exact generated directory is checked before recursive deletion.
  const rel=relative(resolve(tmpdir()),resolve(home));
  assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('orchestrator-query-live-'));
  for(let i=0;i<10;i++){try{rmSync(home,{recursive:true,force:true});break;}catch(error){if(i===9)throw error;await delay(1000);}}
}
