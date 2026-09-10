/** Real Chromium input against the development or packaged Electron app.
 * Uses an isolated database, no credentials, and no provider execution.
 * --observe records the unmodified release without asserting layout stability.
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
const output = resolve(option('--output') ?? join(root, 'overflow-results'));
mkdirSync(output, {recursive:true});
const home = mkdtempSync(join(tmpdir(), 'orchestrator-overflow-'));
const load = p => import(pathToFileURL(join(root, 'dist', p)).href);
const { AppServices } = await load('apps/desktop/src/main/services/app-services.js');
const { appPaths } = await load('src/runtime/paths.js');
const services = new AppServices({paths:appPaths({...process.env, AI_ORCHESTRATOR_HOME:home})});
const workspace = services.workspaces.createConversation({name:'Overflow fixture'});
const projects = [];
for (let i = 0; i < 18; i++) projects.push(services.projects.create({name:`Overflow project ${String(i).padStart(2,'0')}`,workspaceId:workspace.id}));
const project = projects[8];
const session = services.database.chat.createSession({id:'overflow-session',workspaceId:workspace.id,projectId:project.id,title:'Overflow conversation'});
const runId = 'overflow-run';
services.database.runs.create({id:runId,sessionId:session.id,workspaceId:workspace.id,objective:'Overflow graph fixture',orchestratorAgentId:null,maxIterations:3});
services.database.runs.setStatus(runId,'RUNNING');
services.database.chat.addMessage({sessionId:session.id,runId,author:'user',body:'Overflow graph fixture'});
for(let i=0;i<3;i++) services.database.runs.recordInvocation({runId,iteration:1,agentId:null,accountId:null,role:i?'CODING_WORKER':'ORCHESTRATOR',workerId:i?`worker-${i}`:null,task:i?'Inspect UI':null,outcome:'completed',exitCode:0,durationMs:1000,startedAt:new Date(Date.now()-5000+i*1000).toISOString()});
services.database.runs.addStep({runId,iteration:1,phase:'evidence',status:'read',summary:'UI fixture only'});
services.database.runs.setStatus(runId,'DONE','No provider called.');
const account = services.accounts.create('Overflow CLI','anthropic');
services.agents.create({name:'Overflow agent',role:'CODING_WORKER',provider:'anthropic',accountId:account.id,model:'sonnet',reasoning:'medium',maxCapability:'BALANCED',maxReasoning:'MEDIUM',enabled:true});
services.database.accounts.create({id:'overflow-api',providerId:'anthropic',displayName:'Overflow API',profileDirectory:join(home,'api-profile'),connectionKind:'api'});
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
  // Change the actual graph viewport, so a reset to its initial state fails.
  await click('button[aria-label="Aumentar zoom"]');
  const canvas=await box('[data-testid=worktree-canvas]');
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...canvas,deltaX:0,deltaY:-130});await delay(250);
  await evaluate(`window.__overflow={};`);
  const installProbe = `(() => {
    const q=s=>document.querySelector(s), id=e=>e?.getAttribute?.('data-testid')||e?.id||e?.getAttribute?.('role')||e?.tagName||null;
    let serial=0;const identities=new WeakMap();const identity=e=>{if(!e)return null;if(!identities.has(e))identities.set(e,++serial);return identities.get(e);};
    const sidebarProps=()=>{const e=q('[data-testid=app-sidebar]');let f=e?.[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];while(f){if(f.memoizedProps?.projectActions)return f.memoizedProps;f=f.return;}return null;};
    const state=()=>({windowScrollY:scrollY,bodyPadding:getComputedStyle(document.body).paddingTop,rootTop:q('#root').getBoundingClientRect().top,shellTop:q('#root').firstElementChild?.getBoundingClientRect().top,sidebarTop:q('[data-testid=app-sidebar]')?.getBoundingClientRect().top,scrollContainers:[...document.querySelectorAll('#root *')].filter(e=>e.scrollHeight>e.clientHeight&&/auto|scroll/.test(getComputedStyle(e).overflowY)).map(e=>({id:id(e),top:e.scrollTop})),selectedProjectId:sidebarProps()?.activeProjectId||null,selectedConversationId:sidebarProps()?.activeSessionId||null,runId:q('.worktree-world [data-node-id]')?.getAttribute('data-node-id')||null,graphTransform:q('.worktree-world')?.style.transform||null,graphTop:q('.worktree-world')?.getBoundingClientRect().top||null,hash:location.hash,activeElement:id(document.activeElement)});
    const stableState=()=>({...state(),sidebarIdentity:identity(q('[data-testid=app-sidebar]')),worktreeIdentity:identity(q('.worktree-world'))});
    const probe=window.__overflow={events:[],states:[],menuOpen:0,state:stableState};
    const events=['pointerdown','pointerup','mousedown','mouseup','click','dblclick','focus','blur','keydown','scroll','selectionchange','hashchange'];
    for(const name of events)for(const capture of [true,false])addEventListener(name,e=>probe.events.push({type:name,phase:capture?'capture':'bubble',target:id(e.target),menuItem:!!e.target?.closest?.('[role=menuitem]'),detail:e.detail,key:e.key,defaultPrevented:e.defaultPrevented}),capture);
    const focus=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){probe.events.push({type:'focus-call',target:id(this),args});return focus.apply(this,args);};
    const siv=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){probe.events.push({type:'scrollIntoView-call',target:id(this),args});return siv.apply(this,args);};
    const tracked=new WeakSet();
    const wrap=(obj,key,operation)=>{const fn=obj?.[key];if(typeof fn!=='function'||tracked.has(fn))return;const wrapped=function(...args){probe.events.push({type:'operation',operation});return fn.apply(this,args);};tracked.add(wrapped);obj[key]=wrapped;};
    const instrument=()=>{wrap(sidebarProps()?.projectActions,'open','projectOpen');for(const e of document.querySelectorAll('[data-testid^="open-session-"],.worktree-toolbar button')){const props=e[Object.keys(e).find(k=>k.startsWith('__reactProps'))];wrap(props,'onClick',e.matches('[data-testid^="open-session-"]')?'conversationOpen':e.getAttribute('aria-label')==='Ajustar à tela'?'worktreeFitView':'worktreeControl');}};
    instrument();
    // React can replace callback props without a DOM mutation. Refresh the
    // observers before its delegated click handler reads those props.
    addEventListener('click',instrument,true);
    new MutationObserver(records=>{for(const r of records)if(r.attributeName==='data-state'&&r.target.matches('button[aria-haspopup=menu]')&&r.target.dataset.state==='open')probe.menuOpen++;instrument();probe.states.push(stableState());}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','data-state','data-scroll-locked','data-active']});
    return state();
  })()`;
  await evaluate(installProbe);
  const probe = async (name,sel,mode='click') => {
    await reveal(sel);await delay(200);
    if(mode==='Space'||mode==='Enter')await evaluate(`document.querySelector(${JSON.stringify(sel)}).focus({preventScroll:true});true`);
    const before=await evaluate('window.__overflow.state()');
    await evaluate(`window.__overflow.originalTrigger=document.querySelector(${JSON.stringify(sel)});true`);
    await evaluate('window.__overflow.events=[];window.__overflow.states=[];window.__overflow.menuOpen=0;true');
    if(mode==='Space'||mode==='Enter')await key(mode==='Space'?' ':'Enter');
    else {const p=await box(sel);await mouse('mouseMoved',p);await mouse('mousePressed',p);if(mode==='micro-drag')await mouse('mouseMoved',{x:p.x+1,y:p.y+1});await mouse('mouseReleased',p);if(mode==='double'){await mouse('mousePressed',p,2);await mouse('mouseReleased',p,2);}await delay(250);}
    const opened=await evaluate(`({state:window.__overflow.state(),visible:!!document.querySelector('[role=menu]'),count:window.__overflow.menuOpen})`);
    if(results.length===0)await saveScreenshot('menu-open');
    if(name==='project-overflow'&&mode==='Space')await saveScreenshot('keyboard-menu-open');
    await key('Escape');
    // Focus restoration runs after Radix's exit animation. In a background
    // window Chromium can throttle that animation beyond a fixed 200 ms.
    if(!process.argv.includes('--observe')) {
      await waitFor('!document.querySelector("[role=menu]")');
      await waitFor('document.activeElement===window.__overflow.originalTrigger');
    }
    const after=await evaluate('window.__overflow.state()');
    const logs=await evaluate('({events:window.__overflow.events,states:window.__overflow.states})');
    const counts={menuOpen:opened.count,projectOpen:logs.events.filter(e=>e.type==='operation'&&e.operation==='projectOpen').length,conversationOpen:logs.events.filter(e=>e.type==='operation'&&e.operation==='conversationOpen').length,navigation:logs.events.filter(e=>e.type==='hashchange'&&e.phase==='capture').length,selectionChange:logs.states.filter(s=>s.selectedProjectId!==before.selectedProjectId||s.selectedConversationId!==before.selectedConversationId).length,worktreeFitView:logs.events.filter(e=>e.type==='operation'&&e.operation==='worktreeFitView').length,menuItemClick:logs.events.filter(e=>e.type==='click'&&e.phase==='capture'&&e.menuItem).length};
    const result={name,mode,before,opened,after,counts,...logs};results.push(result);
    console.log(JSON.stringify({name,mode,counts,sidebarTops:[...new Set(logs.states.map(s=>s.sidebarTop))]}));
    if(!process.argv.includes('--observe')) {
      // Rapid clicks may toggle the trigger or be dismissed by the modal layer.
      // Neither may activate an item, navigate, or move the page.
      if(mode!=='double')assert.equal(opened.visible,true, name+' opened');
      assert.equal(opened.count,1,name+' menuOpen');
      if(mode!=='double')assert.equal(logs.events.filter(e=>e.type==='dblclick'&&e.phase==='capture').length,0,name+' no phantom double click');
      for(const operation of ['projectOpen','conversationOpen','navigation','selectionChange','worktreeFitView','menuItemClick'])assert.equal(counts[operation],0,name+' '+operation);
      for(const s of [opened.state,after,...logs.states])for(const field of ['windowScrollY','shellTop','sidebarTop','scrollContainers','selectedProjectId','selectedConversationId','runId','graphTransform','graphTop','hash','sidebarIdentity','worktreeIdentity'])assert.deepEqual(s[field],before[field],name+' '+field);
      assert.equal(await evaluate('document.activeElement===window.__overflow.originalTrigger'),true,name+' exact focus return');
      assert.equal(await evaluate('!!document.querySelector("[role=menu]")'),false,name+' Escape closes');
      assert.equal(after.activeElement,await evaluate(`document.querySelector(${JSON.stringify(sel)}).getAttribute('data-testid')||document.querySelector(${JSON.stringify(sel)}).id||'BUTTON'`),name+' focus return');
    }
  };
  const projectMenu=selector('project-menu-'+project.id);
  await reveal(projectMenu);await saveScreenshot('before');
  for(const mode of ['click','double','micro-drag','Space','Enter','click','click'])await probe('project-overflow',projectMenu,mode);
  await probe('inactive-project-overflow',selector('project-menu-'+projects[7].id));
  for(const mode of ['click','double','micro-drag','Space','Enter'])await probe('conversation-overflow',selector('session-menu-'+session.id),mode);
  if(!process.argv.includes('--observe')) {
    const graph=await evaluate('window.__overflow.state()');
    check('worktree-fixture-has-selected-project-conversation-and-run',()=>{assert.equal(graph.selectedProjectId,project.id);assert.equal(graph.selectedConversationId,session.id);assert.equal(graph.runId,'run:'+runId);assert.notEqual(graph.graphTransform,'translate(64px, 40px) scale(1)');assert.ok(graph.scrollContainers.some(c=>c.top>0));});
    const projectResults=results.filter(r=>r.name.includes('project-overflow'));
    check('project-overflow-single-action',()=>assert.ok(projectResults.every(r=>r.counts.menuOpen===1&&r.counts.menuItemClick===0)));
    check('project-overflow-does-not-open-project',()=>assert.ok(projectResults.every(r=>r.counts.projectOpen===0)));
    check('project-overflow-does-not-change-selection',()=>assert.ok(projectResults.every(r=>r.counts.selectionChange===0)));
    check('project-overflow-does-not-scroll',()=>{for(const r of projectResults)for(const s of r.states)assert.deepEqual(s.scrollContainers,r.before.scrollContainers);});
    check('project-overflow-does-not-reset-worktree-viewport',()=>{for(const r of projectResults)for(const s of r.states)assert.equal(s.graphTransform,r.before.graphTransform);});
    check('nested-button-does-not-trigger-parent',()=>assert.ok(results.every(r=>r.counts.projectOpen===0&&r.counts.conversationOpen===0)));
    for(const [name,mode] of [['overflow-keyboard-space','Space'],['overflow-keyboard-enter','Enter']])check(name,()=>assert.ok(results.filter(r=>r.mode===mode).every(r=>r.opened.visible&&r.counts.menuItemClick===0)));
    check('overflow-escape-and-focus-return',()=>assert.ok(results.every(r=>r.after.activeElement.includes('-menu-'))));
    const runMenus=await evaluate('document.querySelectorAll("[data-testid=execution-worktree] button[aria-haspopup=menu]").length');
    check('run-overflow-inventory-no-trigger',()=>assert.equal(runMenus,0));
    assert.equal(await evaluate('document.querySelectorAll("button button,button a,a button").length'),0,'valid interactive nesting');
    await click('.run-view-tabs button:nth-child(3)');
    await waitFor('!!document.querySelector("[role=dialog]")');
    const evidenceMenus=await evaluate('document.querySelectorAll("[role=dialog] button[aria-haspopup=menu]").length');
    check('evidence-overflow-inventory-no-trigger',()=>assert.equal(evidenceMenus,0));
    await key('Escape');
    await waitFor('!document.querySelector("[role=dialog]")');
  }
  await evaluate("location.hash='#/configuracoes?tab=accounts';true");
  await waitFor('document.body.innerText.includes("Overflow CLI")');
  // Account menu is the only CLI card trigger; API cards have a labelled trigger.
  for(const mode of ['click','double','micro-drag','Space','Enter'])await probe('account-overflow','button[aria-haspopup="menu"]',mode);
  for(const [name,sel] of [['cli-connection-overflow',`[data-testid="connection-${account.id}"] button[aria-haspopup="menu"]`],['api-connection-overflow','[data-testid="connection-overflow-api"] button[aria-haspopup="menu"]']])for(const mode of ['click','double','micro-drag','Space','Enter'])await probe(name,sel,mode);
  if(!process.argv.includes('--observe')) {
    await evaluate("location.hash='#/configuracoes?tab=agents';true");
    await waitFor('document.body.innerText.includes("Overflow agent")');
    const agentMenus=await evaluate('document.querySelectorAll("button[aria-haspopup=menu]").length');
    check('agent-overflow-inventory-no-trigger',()=>assert.equal(agentMenus,0));
    await evaluate("location.hash='#/';true");
    await waitFor(`!!document.querySelector('${projectMenu}')`);
    // Verify the instrumentation detects genuine operations before relying on zeroes.
    await reveal(selector('open-project-'+project.id));
    await evaluate('window.__overflow.events=[];true');
    await click(selector('open-project-'+project.id));
    const projectOp=await evaluate('window.__overflow.events.filter(e=>e.operation==="projectOpen").length');
    check('sidebar-project-opens-from-its-button',()=>assert.equal(projectOp,1));
    await reveal(selector('open-session-'+session.id));
    await evaluate('window.__overflow.events=[];true');
    await click(selector('open-session-'+session.id));
    const sessionOp=await evaluate('window.__overflow.events.filter(e=>e.operation==="conversationOpen").length');
    check('sidebar-conversation-opens-from-its-button',()=>assert.equal(sessionOp,1));
    await click(selector('toggle-project-'+project.id));
    assert.equal(await evaluate(`!!document.querySelector('${selector('open-session-'+session.id)}')`),false);
    await click(selector('toggle-project-'+project.id));
    await waitFor(`!!document.querySelector('${selector('open-session-'+session.id)}')`);
    checks.push('sidebar-expand-collapse');
    const menuAction=async action=>{await reveal(projectMenu);await click(projectMenu);await waitFor('!!document.querySelector("[role=menu]")');await click(selector(action+'-project-'+project.id));};
    await menuAction('rename');
    await waitFor('!!document.querySelector("[data-testid=project-name]")');
    await click(selector('project-name'));
    // Native text insertion after selecting the existing value.
    await evaluate('document.querySelector("[data-testid=project-name]").select();true');
    await send('Input.insertText',{text:'Overflow renamed'});
    await click(selector('project-save'));
    await waitFor('!document.querySelector("[data-testid=project-dialog]")');
    const renamed=await evaluate(`window.api.project.list().then(list=>list.find(p=>p.id===${JSON.stringify(project.id)}).name)`);
    check('sidebar-rename-persists',()=>assert.equal(renamed,'Overflow renamed'));
    for(const [action,dialog] of [['settings','project-dialog'],['context','project-context-dialog'],['prepare','prepare-project-dialog']]) {
      await menuAction(action);await waitFor(`!!document.querySelector('${selector(dialog)}')`);
      if(action==='prepare')await waitFor('!!document.querySelector("[data-testid=preflight-state]")');
      await key('Escape');await waitFor(`!document.querySelector('${selector(dialog)}')`);
      checks.push('sidebar-'+action);
    }
    await menuAction('archive');
    await waitFor(`window.api.project.list().then(list=>!!list.find(p=>p.id===${JSON.stringify(project.id)})?.archivedAt)`);
    await menuAction('archive');
    await waitFor(`window.api.project.list().then(list=>list.find(p=>p.id===${JSON.stringify(project.id)})?.archivedAt===null)`);
    checks.push('sidebar-archive-restore');
    await menuAction('delete');await waitFor('!!document.querySelector("[data-testid=confirm]")');await click(selector('confirm'));
    await waitFor(`window.api.project.list().then(list=>!list.some(p=>p.id===${JSON.stringify(project.id)}))`);
    const kept=await evaluate(`window.api.chat.listAllSessions({}).then(list=>list.find(s=>s.id===${JSON.stringify(session.id)}))`);
    check('sidebar-remove-preserves-conversation',()=>assert.equal(kept.projectId,null));
    console.log(`# pass ${results.length} overflow interactions and ${checks.length} contract/sidebar checks`);
  }
} catch(error) {console.error(error);process.exitCode=1;if(socket?.readyState===1)try{await saveScreenshot('failure');}catch{}}
finally {
  writeFileSync(join(output,'results.json'),JSON.stringify({binary,home,appInfo,ok:!process.exitCode,checks,results},null,2));
  writeFileSync(join(output,'process.log'),processLog);
  if(socket?.readyState===1){socket.send(JSON.stringify({id:++serial,method:'Browser.close'}));await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);socket.close();}
  if(child.exitCode===null)child.kill();
}
