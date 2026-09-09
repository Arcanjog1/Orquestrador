import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileContext } from '../src/orchestrator/file-context.js';
import { queryProofProblems } from '../src/orchestrator/query-proof.js';
import { buildWorkerPrompt } from '../src/orchestrator/worker-prompt.js';
import type { FileReadResult } from '../src/verification/file-check.js';

const read = (path: string, text: string): FileReadResult => ({ request: { path }, text, ok: true, outcome: 'ok', resolvedPath: path, sizeBytes: Buffer.byteLength(text), sha256: 'hash', truncated: false, problem: null });

test('delivery shares a bounded UTF-8 budget and reports content omitted across rounds', () => {
  const files = Array.from({length: 5}, (_,i) => read(`${i}.py`, 'á'.repeat(16000)));
  const result = fileContext(files, 'WORKER');
  assert.ok(result.deliveries.reduce((s,d) => s+d.bytesSent,0) <= 65536);
  assert.ok(result.deliveries.some(d => d.state === 'NOT_CARRIED'));
  assert.ok(!result.text.includes('�'));
});

test('worker prompt preserves exact content, metadata alone does not count as delivery', () => {
  const files = [read('Script.py', 'import wall_modeling\n')];
  const prompt = buildWorkerPrompt({preamble:'policy',task:'analyse',criteria:[],fileReads:files});
  assert.ok(prompt.text.includes(files[0]!.text!));
  assert.equal(prompt.deliveries[0]?.state,'WORKER_CARRIED');
  const broken = buildWorkerPrompt({preamble:'policy',task:'analyse',criteria:[],fileReads:[{...files[0]!,text:null}]});
  assert.equal(broken.deliveries[0]?.state,'NOT_CARRIED');
  assert.equal(broken.deliveries[0]?.bytesSent,0);
});

test('query proof rejects invented quotes, missing citations and change objectives', () => {
  const files=[read('Script.py','import wall_modeling')];
  const proof={criteria:['localizar'],citations:[{path:'Script.py',quote:'import wall_modeling'}]};
  assert.deepEqual(queryProofProblems('onde está a lógica?', 'Em Script.py.', proof, files), []);
  assert.ok(queryProofProblems('corrija a lógica', 'Em Script.py.', proof, files).length);
  assert.ok(queryProofProblems('onde está a lógica?', 'Em outro arquivo.', proof, files).length);
  assert.ok(queryProofProblems('onde está a lógica?', 'Em Script.py.', {...proof,citations:[{path:'Script.py',quote:'invented'}]},files).length);
});
