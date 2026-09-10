/** Real Chromium input against the development or packaged Electron app.
 * Uses an isolated database, no credentials, and no provider execution.
 * Screenshots and UI assertions use persisted fixture data, never real provider calls.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1);
const output = resolve(option('--output') ?? join(root, 'rpg-results'));
mkdirSync(output, {recursive:true});
const home = mkdtempSync(join(tmpdir(), 'orchestrator-rpg-'));
const load = p => import(pathToFileURL(join(root, 'dist', p)).href);
const { AppServices } = await load('apps/desktop/src/main/services/app-services.js');
const { appPaths } = await load('src/runtime/paths.js');
const services = new AppServices({paths:appPaths({...process.env, AI_ORCHESTRATOR_HOME:home})});
const workspace = services.workspaces.createConversation({name:'Guilda de demonstração'});
const projects = [];
for (let i = 0; i < 4; i++) projects.push(services.projects.create({name:['Portal da guilda','Biblioteca de agentes','Mapa de execução','Oficina de interfaces'][i],workspaceId:workspace.id}));
const project = projects[0];
const session = services.database.chat.createSession({id:'overflow-session',workspaceId:workspace.id,projectId:project.id,title:'Uma nova jornada'});
const runId = 'overflow-run';
services.database.runs.create({id:runId,sessionId:session.id,workspaceId:workspace.id,objective:'Revisar o mapa de execução · demonstração',orchestratorAgentId:null,maxIterations:3});
services.database.runs.setStatus(runId,'RUNNING');
services.database.chat.addMessage({sessionId:session.id,runId,author:'user',body:'Revisar o mapa de execução · demonstração'});
for(let i=0;i<3;i++) services.database.runs.recordInvocation({runId,iteration:1,agentId:null,accountId:null,role:i?'CODING_WORKER':'ORCHESTRATOR',workerId:i?`worker-${i}`:null,task:i?'Revisar interface e registrar evidências':null,outcome:'completed',exitCode:0,durationMs:1000,startedAt:new Date(Date.now()-5000+i*1000).toISOString()});
services.database.runs.addStep({runId,iteration:1,phase:'evidence',status:'read',summary:'Evidência de demonstração — sem chamada a provedores'});
services.database.chat.addMessage({sessionId:session.id,runId,author:'orchestrator',body:'Análise de demonstração concluída.\n'+ 'Os agentes verificaram a organização visual e as conexões entre as etapas. '.repeat(5)+'\nEVIDENCIA_COMPLETA_PRESERVADA'});
services.database.runs.setStatus(runId,'DONE','Jornada de demonstração concluída. Nenhum provedor foi chamado.');
const account = services.accounts.create('Overflow CLI','anthropic');
services.agents.create({name:'Overflow agent',role:'CODING_WORKER',provider:'anthropic',accountId:account.id,model:'sonnet',reasoning:'medium',maxCapability:'BALANCED',maxReasoning:'MEDIUM',enabled:true});
services.database.accounts.create({id:'overflow-api',providerId:'anthropic',displayName:'Overflow API',profileDirectory:join(home,'api-profile'),connectionKind:'api'});
// Seven real persisted agents in an isolated fixture; only three participated.
const guildAccount=services.accounts.create('Conta de demonstração','openai');
const roles=['ORCHESTRATOR','CODING_WORKER','ANALYST','DESIGNER','TESTER','RESEARCHER','IMAGE_GENERATOR'];
const names=['Mago da estratégia','Ferreiro do código','Sábio da revisão','Artista da interface','Guardião dos testes','Explorador de soluções','Ilusionista de imagens'];
const guildAgents=[];
for(let i=0;i<roles.length;i++) guildAgents.push(services.agents.create({name:names[i],role:roles[i],provider:'openai',accountId:guildAccount.id,model:null,reasoning:null,maxCapability:'BALANCED',maxReasoning:'MEDIUM',enabled:true}));
services.database.workspaces.setTeam(workspace.id, {agentId:guildAgents[0].id}, guildAgents.slice(1,4).map(a=>({agentId:a.id})));
await services.shutdown();

const port = await new Promise(resolvePort => { const server=createServer(); server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolvePort(p));}); });
const binary = option('--binary') ?? join(root,'..','..','node_modules','electron','dist',process.platform==='win32'?'electron.exe':'electron');
const args = [...(option('--binary')?[]:[root]), `--remote-debugging-port=${port}`, `--user-data-dir=${join(home,'chromium')}`, '--no-sandbox'];
const env={...process.env,AI_ORCHESTRATOR_HOME:home};
delete env.ELECTRON_RUN_AS_NODE;
delete env.AI_ORCHESTRATOR_SMOKE;
const child = spawn(binary,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let processLog='';
child.stdout.on('data',b=>processLog+=b);child.stderr.on('data',b=>processLog+=b);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let socket, serial=0, appInfo;
const pending=new Map(), results=[], checks=[];
const check=(name,fn)=>{fn();checks.push(name);console.log('ok '+name);};
const send=(method,params={})=>new Promise((res,rej)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);rej(new Error(`CDP timeout: ${method}`));},15000);pending.set(id,{res,rej,timer});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100);}throw new Error(`Not found: ${expression}; ${await evaluate('document.body.innerText.slice(0,1500)')}`);};
const selector=id=>`[data-testid="${id}"]`;
const box=sel=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e)throw Error('Missing '+${JSON.stringify(sel)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
const mouse=async (type,p,clickCount=1)=>send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount});
const click=async sel=>{const p=await box(sel);await mouse('mouseMoved',p);await mouse('mousePressed',p);await mouse('mouseReleased',p);await delay(200);};
const key=async name=>{const codes={Escape:27,Enter:13,' ':32};await send('Input.dispatchKeyEvent',{type:'keyDown',key:name,windowsVirtualKeyCode:codes[name],code:name===' '?'Space':name});await send('Input.dispatchKeyEvent',{type:'keyUp',key:name,windowsVirtualKeyCode:codes[name],code:name===' '?'Space':name});await delay(200);};
const reveal=sel=>evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'});true`);
const saveScreenshot=async name=>writeFileSync(join(output,name+'.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
try {
  let page;
  for(let i=0;i<150;i++){try{page=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');if(page)break;}catch{}await delay(100);}
  if(!page)throw new Error('App did not expose CDP: '+processLog);
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});
  socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}};
  // Keep CDP keyboard input on this page even when the user focuses another window.
  await send('Emulation.setFocusEmulationEnabled', {enabled:true});
  await waitFor('!!window.api && !!document.querySelector("[data-testid=start]")');
  appInfo=await evaluate('window.api.app.info()');
  assert.equal(appInfo.packaged,!!option('--binary'),'the intended Electron binary is running');
  await click(selector('start'));
  await waitFor('!!document.querySelector("[data-testid=skip-onboarding]")');
  await click(selector('skip-onboarding'));
  await waitFor(`!!document.querySelector('${selector('open-session-'+session.id)}')`);
  await reveal(selector('open-session-'+session.id));await click(selector('open-session-'+session.id));
  await waitFor('!!document.querySelector(".worktree-world")');

  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await delay(400);await click('button[aria-label="Ajustar à tela"]');
  await delay(400);await saveScreenshot('worktree');
  if(!process.argv.includes('--baseline')) {
    const positions = await evaluate('[...document.querySelectorAll(".execution-node")].map(e=>({id:e.dataset.nodeId,x:parseFloat(e.style.left),y:parseFloat(e.style.top)}))');
    const start = positions.find(n=>n.id==='run:'+"overflow-run");
    const end = positions.find(n=>n.id==='end:'+"overflow-run");
    assert.ok(start && end && end.x > start.x, 'mission progresses left to right');
    const workers = await evaluate('[...document.querySelectorAll(".node-worker")].map(e=>({x:parseFloat(e.style.left),y:parseFloat(e.style.top)}))');
    assert.equal(workers[0].x,workers[1].x,'parallel delegates share a column');
    assert.notEqual(workers[0].y,workers[1].y,'parallel delegates have separate tracks');
    assert.equal(await evaluate('[...document.querySelectorAll(".node-summary")].every(e=>e.textContent.length<=100)'),true,'concise graph summaries');
    checks.push('horizontal topology and separate parallel tracks with brief summaries');
    assert.equal(await evaluate('document.querySelectorAll(".guild-team-card").length'),4,'four configured project members');
    assert.equal(await evaluate('document.querySelectorAll(".mission-record").length'),3,'configured members do not imply run participation');
    const composition=await evaluate('(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {map:r(".guild-mission-board").toJSON(),team:r(".guild-team").toJSON(),chat:r(".guild-conversation").toJSON(),responses:r(".guild-activity-dock").toJSON()}})()');
    assert.ok(composition.team.x>composition.map.x && composition.chat.y>=composition.map.bottom && composition.responses.y>=composition.team.bottom,'map and team above conversation and responses');
    checks.push('reference composition separates configured team from recorded participants');
    assert.equal(await evaluate('document.querySelectorAll(".mission-record").length'),3,'exactly the three recorded invocations');
    const before=await evaluate('document.querySelector(".worktree-world").style.transform');
    await click('[aria-label="Recolher painel de atividade"]');
    await waitFor('!document.querySelector("[data-testid=mission-log]")');
    assert.equal(await evaluate('document.querySelector(".worktree-world").style.transform'),before,'closing Activity preserves graph pan/zoom');
    await click('[aria-label="Abrir painel de atividade"]');
    await waitFor('!!document.querySelector("[data-testid=mission-log]")');
    checks.push('mission log shows only actual invocations; toggling it preserves graph viewport');
    await click('.mission-record');await waitFor('!!document.querySelector("[role=dialog]")');
    await saveScreenshot('mission-result');await click('[role="dialog"] > button:last-child');await waitFor('!document.querySelector("[role=dialog]")');
    checks.push('mission result opens persisted run details');
  }
  await click('.run-view-tabs button:nth-child(2)');
  await waitFor('document.body.innerText.includes("Activity") || document.body.innerText.includes("Registro da missão")');
  await saveScreenshot('activity');
  assert.equal(await evaluate('document.body.innerText.includes("EVIDENCIA_COMPLETA_PRESERVADA")'),false,'full response starts collapsed');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Ver resposta completa").setAttribute("data-rpg-expander","true");true');
  await click('[data-rpg-expander]');
  assert.equal(await evaluate('document.body.innerText.includes("EVIDENCIA_COMPLETA_PRESERVADA")'),true,'expanding preserves full response');
  await saveScreenshot('response-expanded');await click('[data-rpg-expander]');
  assert.equal(await evaluate('document.body.innerText.includes("EVIDENCIA_COMPLETA_PRESERVADA")'),false,'response collapses again');
  checks.push('brief response expands to the complete original text and collapses again');
  await evaluate("location.hash='#/configuracoes?tab=agents';true");
  await waitFor('!!document.querySelector("[data-testid=agent-card-grid]")');
  await waitFor('[...document.querySelectorAll(".hero-portrait img")].every(i=>i.complete&&i.naturalWidth>0)');
  await delay(100);await saveScreenshot('agents');
  if(!process.argv.includes('--baseline')) {
    await waitFor('[...document.querySelectorAll(".hero-portrait img")].every(i=>i.complete&&i.naturalWidth>0)');
    assert.equal(await evaluate('document.querySelectorAll(".hero-portrait[data-placeholder]").length'),0,'all hero images loaded');
    assert.equal(await evaluate('new Set([...document.querySelectorAll(".hero-portrait")].map(e=>e.dataset.hero)).size'),7,'all seven archetypes');
    checks.push('seven hero identities load from bundled local assets');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate('[...document.querySelectorAll(".hero-portrait,.guild-lantern i")].every(e=>getComputedStyle(e).animationName==="none")'),true,'reduced motion');
    checks.push('reduced motion disables decorative animation');
    await send('Emulation.setEmulatedMedia',{features:[]});
  }
  await evaluate('document.querySelector("[data-testid=agent-card-grid]").lastElementChild.scrollIntoView({block:"end"});true');
  await delay(200);await saveScreenshot('agents-more');
  await evaluate('document.querySelector("[data-testid=agent-create]").scrollIntoView({block:"center"});true');
  await click('[data-testid=agent-create]');
  await waitFor('!!document.querySelector("[data-testid=agent-role]")');
  await saveScreenshot('agent-editor');
  assert.equal(await evaluate('document.querySelector("[data-testid=agent-role]").options.length'),7,'seven guided roles');
  checks.push('agent editor provides seven roles and existing account/model selectors');
  await click('[role="dialog"] > button:last-child');await waitFor('!document.querySelector("[role=dialog]")');
  for(const tab of ['accounts','appearance','execution','verifications','git','developer']) {
    await evaluate("location.hash='#/configuracoes?tab="+tab+"';true");await delay(350);await saveScreenshot(tab);
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'),false,tab+' no page overflow');
    checks.push(tab+' renders without page overflow');
  }
  await evaluate("location.hash='#/configuracoes?tab=agents';true");
  await waitFor('!!document.querySelector("[data-testid=agent-card-grid]")');
  await evaluate('document.documentElement.classList.remove("dark");document.documentElement.classList.add("light");true');
  await delay(200);await saveScreenshot('agents-light');
  await send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
  await delay(200);await saveScreenshot('agents-1024');
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'),false,'1024px layout');
  checks.push('light theme and 1024px layout');
  console.log('Visual evidence saved to '+output);
} catch(error) {console.error(error);process.exitCode=1;if(socket?.readyState===1)try{await saveScreenshot('failure');}catch{}}
finally {
  writeFileSync(join(output,'results.json'),JSON.stringify({binary,home,appInfo,ok:!process.exitCode,checks,results},null,2));
  writeFileSync(join(output,'process.log'),processLog);
  if(socket?.readyState===1){socket.send(JSON.stringify({id:++serial,method:'Browser.close'}));await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);socket.close();}
  if(child.exitCode===null)child.kill();
}
