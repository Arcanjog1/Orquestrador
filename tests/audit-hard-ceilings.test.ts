import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWorkerModel } from '../src/routing/model-router.js';
const base = { provider: 'anthropic' as const, accountId: 'a', task: 'read a line', requested: {capability:'MAX' as const, reasoning:'MAX' as const}, previousAttempts: [], capabilities: {modelFlag:true,effortFlag:true,declaredModels:['haiku','sonnet','opus','fable'],declaredEfforts:['low','medium','high','max']}, selection:'auto' as const, policy:{maxCapability:'BALANCED' as const,maxReasoning:'MEDIUM' as const,allowPremiumModels:false}};
test('audit P1: manual selection respects both hard ceilings',()=>{
 const out=routeWorkerModel({...base, selection:'manual',manual:{model:'opus',reasoning:'max'}});
 assert.ok(out.policyBlocked || (out.resolvedModel==='sonnet' && out.resolvedReasoning==='medium'));
});
test('audit P1: fallback candidates never exceed the model ceiling',()=>{
 const out=routeWorkerModel({...base,unavailableModels:['sonnet']});
 assert.ok(out.policyBlocked || out.resolvedModel==='haiku');
 assert.ok(!out.alternatives.includes('opus'));
});
test('audit P1: premium manual selection cannot fall through to CLI defaults',()=>{
 const out=routeWorkerModel({...base, selection:'manual',manual:{model:'fable',reasoning:'medium'}});
 assert.ok(out.policyBlocked || out.resolvedModel!==null);
});
test('audit P1: unknown manual models under a ceiling are refused',()=>{
 assert.equal(routeWorkerModel({...base,selection:'manual',manual:{model:'unknown',reasoning:'medium'}}).policyBlocked,true);
});
test('audit P1: unenforceable runtime flags block a capped call',()=>{
 assert.equal(routeWorkerModel({...base,capabilities:{...base.capabilities,modelFlag:false}}).policyBlocked,true);
});
test('audit P1: exhausting every fallback never hands control to an unknown CLI default',()=>{
 assert.equal(routeWorkerModel({...base,policy:{maxCapability:null,maxReasoning:null,allowPremiumModels:false},unavailableModels:['haiku','sonnet','opus','fable']}).policyBlocked,true);
});

test('audit P1: premium disabled cannot use an unverifiable Claude default',()=>{
 const policy={maxCapability:null,maxReasoning:null,allowPremiumModels:false};
 assert.equal(routeWorkerModel({...base,policy,capabilities:{...base.capabilities,modelFlag:false}}).policyBlocked,true);
 assert.equal(routeWorkerModel({...base,policy,selection:'manual',manual:{model:null,reasoning:null}}).policyBlocked,true);
});
