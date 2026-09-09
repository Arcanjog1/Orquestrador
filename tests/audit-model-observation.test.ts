import {test} from 'node:test';import assert from 'node:assert/strict';
import {reportedClaudeModel} from '../apps/desktop/src/main/adapters/claude-adapter.js';
test('audit: provider-reported model is separate from requested CLI flags and prose',()=>{
 assert.equal(reportedClaudeModel('model: opus\nI ran as opus'),null);
 assert.equal(reportedClaudeModel(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-4-6'})),'claude-sonnet-4-6');
 assert.equal(reportedClaudeModel(JSON.stringify({type:'result',modelUsage:{'model-a':{},'model-b':{}}})),null);
});
