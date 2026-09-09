/** Real packaged renderer flow, enabled only by the existing smoke entry point. Catalog/provider data is a fixture. */
import type {AppServices} from '../main/services/app-services.js';
import type {BrowserWindow} from 'electron';
import {decorateAgentModels} from '../main/services/agent-model-catalog.js';
export async function agentCardsSmoke(services:AppServices,window:BrowserWindow):Promise<string> {
 const original=services.agentModels.bind(services);
 const evalJS=(code:string)=>window.webContents.executeJavaScript(code);
 const wait=async(code:string)=>{const end=Date.now()+15000;while(!await evalJS(code)){if(Date.now()>end)throw new Error('Agent cards UI: '+code);await new Promise(r=>setTimeout(r,50));}};
 const value=(id:string,value:string)=>evalJS(`(()=>{const e=document.querySelector(${JSON.stringify('[data-testid="'+id+'"]')});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 const click=(id:string)=>evalJS(`document.querySelector(${JSON.stringify('[data-testid="'+id+'"]')}).click()`);
 services.agentModels=async(accountId,role)=>decorateAgentModels(['claude-sonnet-5','claude-haiku-4-5-20251001'].map(id=>({id,provider:'anthropic',source:'runtime',reasoning:['low','medium','high'],accountAllowed:true})),services.database.accounts.require(accountId),services.agents.policies(),role);
 try {
  let id=services.database.settings.get('smoke.cards-agent');
  let accountId=services.database.settings.get('smoke.cards-account');
  if(process.env.AI_ORCHESTRATOR_SMOKE_REOPEN!=='1') {
   const account=services.accounts.create('Claude 2 · UI smoke','anthropic');accountId=account.id;
   services.database.accounts.updateAuth(account.id,'connected','fixture');services.database.settings.set('smoke.cards-account',account.id);
  }
  await evalJS("location.hash='#/configuracoes?tab=agents';true");
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Packaged renderer reload timed out')),15000);window.webContents.once('did-finish-load',()=>{clearTimeout(timer);resolve();});window.webContents.reload();});
  await wait("!!document.querySelector('[data-testid=agent-create]')");
  if(process.env.AI_ORCHESTRATOR_SMOKE_REOPEN!=='1') {
   await click('agent-create');await value('agent-name','Claude Designer · UI smoke');await value('agent-role','DESIGNER');await value('agent-provider','anthropic');await value('agent-account',accountId!);
   await wait("!!document.querySelector('[data-testid=agent-model] option[value=claude-sonnet-5]')");
   await value('agent-model','claude-sonnet-5');await click('agent-mode-CONTROLLED_AUTO');await click('agent-allow-claude-haiku-4-5-20251001');await value('agent-reasoning','medium');
   if(await evalJS("document.querySelector('[data-testid=agent-model]').tagName!=='SELECT'||!!document.querySelector('[data-testid=agent-advanced]')"))throw new Error('Manual model input or advanced options exposed.');
   await wait("!document.querySelector('[data-testid=agent-save]').disabled");await click('agent-save');
   await wait("window.api.agents.manage().then(rows=>rows.some(a=>a.name==='Claude Designer · UI smoke'))");
   id=services.agents.manage().find(a=>a.name==='Claude Designer · UI smoke')!.id;services.database.settings.set('smoke.cards-agent',id);
  }
  const agent=services.agents.manage().find(a=>a.id===id);
  if(agent?.accountId!==accountId||agent.role!=='DESIGNER'||agent.policy?.modelMode!=='CONTROLLED_AUTO'||agent.policy.primaryModel!=='claude-sonnet-5'||agent.policy.allowedModels.join(',')!=='claude-sonnet-5,claude-haiku-4-5-20251001'||agent.policy.reasoning!=='medium'||agent.policy.fallbackModels.join(',')!=='claude-haiku-4-5-20251001')throw new Error('Designer settings did not survive the real process restart.');
  await wait(`!!document.querySelector(${JSON.stringify('[data-testid="agent-edit-'+id+'"]')})`);await click('agent-edit-'+id);
  await wait("!!document.querySelector('[data-testid=agent-allow-claude-haiku-4-5-20251001]')");
  if(await evalJS("document.querySelector('[data-testid=agent-account]').value!=="+JSON.stringify(accountId)+"||document.querySelector('[data-testid=agent-reasoning]').value!=='medium'"))throw new Error('Saved selections did not reopen.');
  await evalJS("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('Cancelar'))?.click();true");
  return 'Created Designer through renderer selects: Anthropic/account 2, Sonnet+Haiku, automatic, medium; persisted across process restart and reopened for editing. Fixture catalog, no provider calls.';
 } finally {services.agentModels=original;}
}
