/** Opt-in subscription test. Original profiles are never run or modified.
 * node apps/desktop/scripts/agents-accounts-live.mjs --source-home=... --output=...
 * Requires npm run build:tests. No API credentials or paid API fallback.
 */
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,copyFileSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ProcessManager} from '../../../dist-tests/src/process/process-manager.js';
import {ClaudeCodeAdapter} from '../../../dist-tests/apps/desktop/src/main/adapters/claude-adapter.js';
import {ClaudeAccountManager} from '../../../dist-tests/src/accounts/claude-account-manager.js';
import {appPaths,ensureAppPaths} from '../../../dist-tests/src/runtime/paths.js';
import {Database} from '../../../dist-tests/src/database/database.js';
import {AgentService} from '../../../dist-tests/apps/desktop/src/main/services/agent-service.js';
import {AgentExecutionPolicy} from '../../../dist-tests/apps/desktop/src/main/services/agent-execution-policy.js';
import {defaultAgentPolicy} from '../../../dist-tests/apps/desktop/src/shared/agent-policy.js';
const option=name=>process.argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
if(!option('--source-home')||!option('--output'))throw Error('source-home and output are required');
const source=resolve(option('--source-home')),output=resolve(option('--output'));mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'orchestrator-agents-live-'));
const paths=ensureAppPaths(appPaths({...process.env,AI_ORCHESTRATOR_HOME:root}));
const db=new DatabaseSync(join(source,'data','orchestrator.db'),{readOnly:true});
const accounts=db.prepare("SELECT id,profile_directory FROM accounts WHERE provider_id='anthropic' AND connection_kind='cli' AND auth_state='connected'").all().slice(0,2);db.close();
const pm=new ProcessManager();const executable=join(source,'runtimes','claude-code','current','claude.exe');
const manager=new ClaudeAccountManager({processManager:pm,runtimeManager:{},paths});
const results={sourceProfilesModified:false,paidApiUsed:false,accounts:[],actualDistinctIdentities:'NOT TESTED',concurrency:'NOT TESTED',cancelIsolation:'NOT TESTED',sessionIsolation:'NOT TESTED'};
const adapters=[];
try {
 for(const account of accounts){
  const profile=join(paths.profiles,account.id);mkdirSync(profile,{recursive:true});
  for(const name of ['.credentials.json','.claude.json'])if(existsSync(join(account.profile_directory,name)))copyFileSync(join(account.profile_directory,name),join(profile,name));
  const env=manager.buildEnvironment(account.id);
  const status=await pm.run({command:executable,args:['auth','status','--json'],cwd:paths.conversations,env,timeoutMs:30000});
  let identity=null,loggedIn=false;
  try{const data=JSON.parse(status.stdout);loggedIn=data.loggedIn===true;identity=data.email??data.accountId??data.userId??null;}catch{}
  // Persist hashes only. An auth-status result, not a count of local records, establishes identity.
  results.accounts.push({accountId:account.id,loggedIn,identityHash:identity?createHash('sha256').update(String(identity).toLowerCase()).digest('hex'):null});
  adapters.push(new ClaudeCodeAdapter({processManager:pm,resolveExecutable:async()=>executable,buildEnvironment:()=>env}));
 }
 results.actualDistinctIdentities=results.accounts.length===2&&results.accounts.every(a=>a.loggedIn&&a.identityHash)?new Set(results.accounts.map(a=>a.identityHash)).size===2?'PASS':'FAIL':'NOT TESTED';
 if(results.actualDistinctIdentities==='PASS') {
  const caps=await Promise.all(adapters.map(a=>a.describeCapabilities(paths.conversations)));
  const model=caps.every(c=>c.declaredModels?.includes('haiku'))?'haiku':caps.every(c=>c.declaredModels?.includes('sonnet'))?'sonnet':null;
  if(!model)throw Error('No shared runtime-declared economical model');
  const inputs=adapters.map((_,i)=>({prompt:`Reply exactly ACCOUNT_${i+1}_OK. Do not use tools.`,workingDirectory:paths.conversations,timeoutMs:90000,runId:'live-agents',iteration:1,routing:{model,reasoning:null},strictRouting:true,toolPolicy:[]}));
  const policyDb=new Database({paths});policyDb.providers.ensureSeeded();const agents=new AgentService(policyDb);
  const ids=accounts.map((account,i)=>{
    policyDb.accounts.create({id:account.id,providerId:'anthropic',displayName:'Live account '+(i+1),profileDirectory:join(paths.profiles,account.id)});
    policyDb.accounts.updateAuth(account.id,'connected','cli-auth-status');
    const policy={...defaultAgentPolicy('CODING_WORKER',model),tools:[],permissions:{write:false,commands:false,web:false},parallel:true};
    return agents.create({name:'Live Agent '+(i+1),role:'CODING_WORKER',provider:'anthropic',accountId:account.id,model,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy}).id;
  });
  policyDb.workspaces.create({id:'live-workspace',name:'Live policy test',localPath:paths.conversations,environment:'conversation'});
  policyDb.runs.create({id:'live-agents',workspaceId:'live-workspace',sessionId:null,objective:'Account isolation check',orchestratorAgentId:null,maxIterations:2});policyDb.runs.setStatus('live-agents','RUNNING');
  const boundary=new AgentExecutionPolicy(policyDb);
  const outputs=await Promise.all(adapters.map((runner,i)=>boundary.invoke({workspaceId:'live-workspace',agentId:ids[i],accountId:accounts[i].id,runner,args:inputs[i],capabilities:caps[i]})));
  results.policyBoundary=outputs.every(o=>o.exitCode===0&&o.applied?.model===model)?'PASS':'FAIL';
  results.policyCalls=boundary.calls('live-agents');policyDb.close();
  results.invocations=outputs.map((o,i)=>({accountId:accounts[i].id,exitCode:o.exitCode,outcome:o.outcome,sent:o.applied,observed:o.observed??null,sessionHash:o.sessionId?createHash('sha256').update(o.sessionId).digest('hex'):null,startedAt:o.startedAt,finishedAt:o.finishedAt,durationMs:o.durationMs,answer:o.stdout.slice(0,80)}));
  results.concurrency=outputs.every(o=>o.exitCode===0)&&Math.max(...outputs.map(o=>Date.parse(o.startedAt)))<Math.min(...outputs.map(o=>Date.parse(o.finishedAt)))?'PASS':'FAIL';
  results.sessionIsolation=results.invocations.every(i=>i.sessionHash)&&new Set(results.invocations.map(i=>i.sessionHash)).size===2?'PASS':'FAIL';
  const first=adapters[0].run({...inputs[0],iteration:2,prompt:'Count from 1 to 5000, one number per line. Do not use tools.'});
  const second=adapters[1].run({...inputs[1],iteration:2,prompt:'Reply exactly SECOND_ACCOUNT_UNAFFECTED. Do not use tools.'});
  await new Promise(r=>setTimeout(r,1000));
  await adapters[0].cancel();
  const [cancelled,survived]=await Promise.all([first,second]);
  results.cancelIsolation=cancelled.outcome==='cancelled'&&survived.exitCode===0&&survived.stdout.includes('SECOND_ACCOUNT_UNAFFECTED')?'PASS':'FAIL';
  results.cancelTest={firstOutcome:cancelled.outcome,secondOutcome:survived.outcome,secondExitCode:survived.exitCode};
 }
 writeFileSync(join(output,'two-accounts.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
} finally {
 await pm.cancelAll();
 // Keep the credential-free report. Temporary credential paths are recorded locally
 // for explicit, verified cleanup by the task; no recursive deletion in this harness.
 writeFileSync(join(output,'temporary-profile-path.txt'),root);
}

