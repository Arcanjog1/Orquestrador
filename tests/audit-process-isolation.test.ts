import {test} from 'node:test';import assert from 'node:assert/strict';import {ProcessManager} from '../src/process/process-manager.js';
import {tmpdir} from 'node:os';import {join} from 'node:path';
test('audit: concurrent Windows child processes keep profiles, outputs and cancellation isolated (provider doubles)',async()=>{
 const manager=new ProcessManager(),cancelA=new AbortController();let startedA:()=>void=()=>{};const ready=new Promise<void>(r=>startedA=r);
 const code="console.log(JSON.stringify({pid:process.pid,profile:process.env.CLAUDE_CONFIG_DIR,label:process.env.AUDIT_LABEL}));setTimeout(()=>{console.log('DONE '+process.env.AUDIT_LABEL)}, Number(process.env.AUDIT_WAIT))";
 const first=manager.run({command:process.execPath,args:['-e',code],cwd:tmpdir(),timeoutMs:10000,signal:cancelA.signal,env:{CLAUDE_CONFIG_DIR:join(tmpdir(),'audit-profile-a'),AUDIT_LABEL:'A',AUDIT_WAIT:'5000'},onStdout:()=>startedA()});
 const second=manager.run({command:process.execPath,args:['-e',code],cwd:tmpdir(),timeoutMs:10000,env:{CLAUDE_CONFIG_DIR:join(tmpdir(),'audit-profile-b'),AUDIT_LABEL:'B',AUDIT_WAIT:'500'}});
 await ready;cancelA.abort();const [a,b]=await Promise.all([first,second]);
 assert.equal(a.outcome,'cancelled');assert.equal(b.outcome,'completed');assert.equal(b.exitCode,0);assert.match(b.stdout,/DONE B/);assert.doesNotMatch(b.stdout,/profile-a|DONE A/);assert.doesNotMatch(a.stdout,/profile-b|DONE B/);
 const pa=JSON.parse(a.stdout.split('\n')[0]!),pb=JSON.parse(b.stdout.split('\n')[0]!);assert.notEqual(pa.pid,pb.pid);assert.notEqual(pa.profile,pb.profile);
});
