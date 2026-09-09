import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopFixture,fakeSecretStore} from './helpers/desktop-fixture.js';
test('audit P1: an expired GitHub credential without refresh cannot be used',async()=>{
 const f=createDesktopFixture({secrets:fakeSecretStore()});
 try{f.services.database.settings.set('github.token.enc',fakeSecretStore().encrypt('ghu_fake_audit'));
 f.services.database.settings.set('github.expiresAt',String(Date.now()-1000));
 assert.equal((await f.services.github.credential()).state,'expired');
 }finally{await f.cleanup();}
});
for (const kind of ['github-app','oauth'] as const) test(`audit: GitHub ${kind} authorization is explained without exposing secrets`,async()=>{
 const f=createDesktopFixture({secrets:fakeSecretStore(),github:{fetchImpl:async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/user')return new Response(JSON.stringify({login:'audit-owner',name:'Audit',avatar_url:''}),{status:200});
  if(path==='/user/repos')return new Response('[]',{status:200});
  if(path==='/user/installations')return new Response(JSON.stringify({installations:[{id:7,app_slug:'audit-app',account:{login:'audit-owner'},repository_selection:'selected',permissions:{contents:'read',pull_requests:'write'}}]}),{status:200});
  return new Response('{}',{status:404});
 }}});
 try{
  f.services.database.settings.set('github.token.enc',fakeSecretStore().encrypt(kind==='oauth'?'gho_private_fixture':'ghu_private_fixture'));
  f.services.database.settings.set('github.clientId','Iv1.audit');
  f.services.database.settings.set('github.scope',kind==='oauth'?'repo,read:user':'');
  const access=await f.services.github.access();assert.equal(access.login,'audit-owner');assert.equal(access.kind,kind);
  assert.ok(!JSON.stringify(access).includes('private_fixture'));
  if(kind==='github-app'){assert.equal(access.installations?.[0]?.selection,'selected');assert.equal(access.installations?.[0]?.contents,'read');await f.services.github.grantAccess(7);assert.match(f.openedUrls[0]!,/^https:\/\/github.com\/settings\/installations\/7$/);}
  else{assert.equal(access.installations,null);assert.match(access.message,/OAuth não oferece seleção/);await f.services.github.grantAccess();assert.match(f.openedUrls[0]!,/connections\/applications/);}
 }finally{await f.cleanup();}
});
