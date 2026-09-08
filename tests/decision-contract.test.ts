/**
 * Um contrato de decisão, não quatro.
 *
 * ## O que estava quebrado
 *
 * Na build `1650c9c` o worker terminou com exit 0, o aplicativo registrou uma
 * alteração, e na iteração 2 o Codex respondeu **duas vezes** com
 * `action=verify`, `verificationCommands=[]` e **sem `fileChecks`**. As duas
 * foram recusadas com:
 *
 * > `"verify" requires at least one entry in "verificationCommands" or "fileChecks".`
 *
 * O supervisor não estava sendo teimoso: ele **não podia** responder outra
 * coisa. `codex exec` recebe o schema em `--output-schema` e o encaminha em
 * modo estrito, onde `additionalProperties: false` é obrigatório — e o
 * `DECISION_JSON_SCHEMA` daquela versão **não tinha `fileChecks`**. O prompt
 * mandava usar um campo que o schema proibia.
 *
 * E o reparo repetia o mesmo contrato incompleto, então a segunda tentativa
 * não tinha como ser diferente da primeira.
 *
 * Estes testes prendem as quatro faces do contrato — schema, parser, prompt
 * principal e prompt de reparo — no mesmo formato.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ACTIONS,
  EMPTY_VERIFY_ERROR,
  buildRepairPrompt,
  parseDecision,
} from '../src/orchestrator/decision-parser.js';
import {
  DECISION_JSON_SCHEMA,
  DECISION_SCHEMA_VERSION,
  strictSchemaProblems,
} from '../src/orchestrator/decision-schema.js';

/* ---- the schema -------------------------------------------------------- */

test('the strict schema carries fileChecks, closed and fully required', () => {
  assert.ok(
    DECISION_JSON_SCHEMA.required.includes('fileChecks'),
    'a strict schema that omits the field forbids it: additionalProperties is false',
  );
  const checks = DECISION_JSON_SCHEMA.properties.fileChecks;
  assert.equal(checks.type, 'array');

  const item = checks.items;
  assert.equal(item.type, 'object');
  assert.equal(item.additionalProperties, false, 'an unknown field is refused, not ignored');
  assert.deepEqual(
    [...item.required].sort(),
    Object.keys(item.properties).sort(),
    'strict mode requires every property; an unasserted one is expressed as null',
  );

  // The fields are the verifier's, and only the verifier's. A field here that
  // `runFileCheck` does not implement would be a promise the application does
  // not keep.
  assert.deepEqual(
    [...item.required].sort(),
    [
      'criteria',
      'expectBytesHex',
      'expectSizeBytes',
      'expectText',
      'forbidBom',
      'forbidTrailingNewline',
      'mustExist',
      'path',
    ],
  );
  assert.equal(item.properties.path.type, 'string', 'the path is never null: there is nothing to check without one');
  for (const nullable of ['mustExist', 'forbidBom', 'forbidTrailingNewline'] as const) {
    assert.deepEqual([...item.properties[nullable].type], ['boolean', 'null']);
  }
  assert.deepEqual([...item.properties.expectSizeBytes.type], ['integer', 'null']);

  // Nothing executable reaches the verifier through this door.
  const text = JSON.stringify(item);
  for (const forbidden of ['command', 'exec', 'shell', 'script', 'args']) {
    assert.doesNotMatch(text, new RegExp(`"${forbidden}"\\s*:`), `${forbidden} is not a file check field`);
  }
});

test('the whole schema still satisfies strict mode, and the version moved', () => {
  assert.deepEqual(strictSchemaProblems(DECISION_JSON_SCHEMA), []);
  assert.deepEqual(
    [...DECISION_JSON_SCHEMA.required].sort(),
    Object.keys(DECISION_JSON_SCHEMA.properties).sort(),
  );
  assert.equal(DECISION_SCHEMA_VERSION, 6, 'the contract changed shape, so the version says so');
});

/* ---- the parser -------------------------------------------------------- */

/** The decision the request asks to be accepted, character for character. */
const EXAMPLE = {
  action: 'verify',
  task: null,
  acceptanceCriteria: [
    'hello.txt existe e contém exatamente os bytes UTF-8 70 72 6F 6E 74 6F, sem BOM e sem quebra de linha.',
  ],
  verificationCommands: [],
  fileChecks: [
    {
      path: 'hello.txt',
      expectBytesHex: '70726F6E746F',
      expectSizeBytes: 6,
      forbidBom: true,
      forbidTrailingNewline: true,
      mustExist: true,
      criteria: [
        'hello.txt existe e contém exatamente os bytes UTF-8 70 72 6F 6E 74 6F, sem BOM e sem quebra de linha.',
      ],
    },
  ],
  workerId: null,
  requiresTools: false,
  satisfiedCriteria: [],
  relevantFiles: ['hello.txt'],
  summary: 'Verificar diretamente os seis bytes de hello.txt.',
  reason: null,
  workerRequirements: {
    capability: 'fast',
    reasoning: 'low',
    rationale: 'Comparação direta dos bytes de um arquivo.',
  },
};

test('the example from the request is accepted, field for field', () => {
  const result = parseDecision(JSON.stringify(EXAMPLE));
  assert.equal(result.ok, true, result.ok === false ? result.error : '');
  if (!result.ok) return;
  const decision = result.decision;
  assert.equal(decision.action, 'verify');
  assert.equal(decision.verificationCommands.length, 0);
  assert.deepEqual(decision.fileChecks, [
    {
      path: 'hello.txt',
      mustExist: true,
      expectBytesHex: '70726F6E746F',
      expectSizeBytes: 6,
      forbidBom: true,
      forbidTrailingNewline: true,
      criteria: [EXAMPLE.acceptanceCriteria[0]],
    },
  ]);
  assert.equal(decision.requiresTools, false);
  assert.deepEqual(decision.relevantFiles, ['hello.txt']);
});

test('a null field is read as an absent one, which is what strict mode produces', () => {
  // Strict mode requires *every* property, so a check that asserts bytes has
  // to send `expectText: null`. Refusing that would be refusing the only
  // shape the schema allows - and the verifier refuses both forms at once,
  // so the null must be dropped rather than passed through.
  const withNulls = {
    ...EXAMPLE,
    fileChecks: [
      {
        path: 'hello.txt',
        mustExist: true,
        expectBytesHex: '70726F6E746F',
        expectText: null,
        expectSizeBytes: null,
        forbidBom: true,
        forbidTrailingNewline: null,
        criteria: null,
      },
    ],
  };
  const result = parseDecision(JSON.stringify(withNulls));
  assert.equal(result.ok, true, result.ok === false ? result.error : '');
  if (!result.ok) return;
  assert.deepEqual(result.decision.fileChecks, [
    { path: 'hello.txt', mustExist: true, expectBytesHex: '70726F6E746F', forbidBom: true },
  ]);
});

test('the two invalid Windows responses are reproduced, and both are still refused', () => {
  const missingField = {
    action: 'verify',
    task: null,
    acceptanceCriteria: ['hello.txt contém os bytes 70 72 6F 6E 74 6F'],
    verificationCommands: [],
    summary: 'Verificar o arquivo.',
    reason: null,
    relevantFiles: ['hello.txt'],
  };
  const emptyField = { ...missingField, fileChecks: [] };

  for (const [label, body] of [
    ['fileChecks absent', missingField],
    ['fileChecks empty', emptyField],
  ] as const) {
    const result = parseDecision(JSON.stringify(body));
    assert.equal(result.ok, false, label);
    if (result.ok) return;
    assert.equal(result.error, EMPTY_VERIFY_ERROR, label);
    // And the fix is never invented for it: an empty verify does not become a
    // check conjured out of the summary text.
    assert.doesNotMatch(result.repairPrompt, /"path":\s*"hello\.txt"/);
  }
});

test('the repair prompt carries the whole contract, not the half that caused this', () => {
  const repair = buildRepairPrompt(EMPTY_VERIFY_ERROR, '{"action":"verify"}');
  // The regression: the old prompt listed no fileChecks at all, so a repair
  // after this exact error could only produce the same refusal again.
  assert.match(repair, /"fileChecks"/);
  for (const field of [
    'expectBytesHex',
    'expectText',
    'expectSizeBytes',
    'forbidBom',
    'forbidTrailingNewline',
    'criteria',
    'workerId',
    'requiresTools',
    'satisfiedCriteria',
  ]) {
    assert.match(repair, new RegExp(field), `the repair contract omits ${field}`);
  }
  // The rules, not just the field names.
  assert.match(repair, /ids REGISTERED for this workspace, never a command line/);
  assert.match(repair, /data, not commands/);
  assert.match(repair, /expectBytesHex OR expectText, never both/);
  // And, for this error specifically, what to do about it.
  assert.match(repair, /needs at least one of/);
  assert.match(repair, /Do not repeat the same empty "verify"\. Do not invent a verification id\./);
});

test('a different error gets the contract but not the verify guidance', () => {
  const repair = buildRepairPrompt('No JSON object was found in the response.', 'oi');
  assert.match(repair, /"fileChecks"/);
  assert.doesNotMatch(repair, /Do not repeat the same empty "verify"/);
});

test('every action still parses, and each keeps its own requirement', () => {
  assert.deepEqual([...ALLOWED_ACTIONS], ['delegate', 'verify', 'done', 'blocked']);

  const delegate = parseDecision(
    JSON.stringify({ ...EXAMPLE, action: 'delegate', task: 'crie hello.txt', fileChecks: [] }),
  );
  assert.equal(delegate.ok, true);
  assert.equal(delegate.ok && delegate.decision.task, 'crie hello.txt');
  assert.equal(
    parseDecision(JSON.stringify({ ...EXAMPLE, action: 'delegate', task: null })).ok,
    false,
    'delegate without a task is not a delegation',
  );

  assert.equal(parseDecision(JSON.stringify(EXAMPLE)).ok, true, 'verify with a file check');
  assert.equal(
    parseDecision(JSON.stringify({ ...EXAMPLE, action: 'verify', fileChecks: [], verificationCommands: ['hello-exists'] })).ok,
    true,
    'verify with a registered id',
  );

  assert.equal(
    parseDecision(JSON.stringify({ ...EXAMPLE, action: 'done', fileChecks: [] })).ok,
    true,
    'done needs no proof field: the gate re-checks it anyway',
  );

  const blocked = parseDecision(
    JSON.stringify({ ...EXAMPLE, action: 'blocked', fileChecks: [], reason: 'sem conta' }),
  );
  assert.equal(blocked.ok, true);
  assert.equal(blocked.ok && blocked.decision.reason, 'sem conta');
  assert.equal(
    parseDecision(JSON.stringify({ ...EXAMPLE, action: 'blocked', fileChecks: [], reason: null })).ok,
    false,
    'blocked without a reason says nothing',
  );
});

test('nothing executable gets through the file-check door', () => {
  for (const bad of [
    { path: 'x', command: 'rm -rf /' },
    { path: 'x', exec: 'node -e "1"' },
    { path: 'x', args: ['-rf', '/'] },
    { path: 'x', expectSizeBytes: 1.5 },
    { path: 'x', mustExist: 'yes' },
    { path: '   ' },
  ]) {
    const result = parseDecision(
      JSON.stringify({ ...EXAMPLE, fileChecks: [bad], verificationCommands: [] }),
    );
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});
