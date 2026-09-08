/**
 * The model router, case by case.
 *
 * Every case below is a delegation the orchestrator could make, with the
 * worker CLI as Claude Code 2.1.263 declares itself (`--model` with aliases,
 * `--effort (low, medium, high, xhigh, max)`), and the model the router must
 * pick for it. No model name appears in the router; they all come from the
 * provider policy, which is what these assertions pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWorkerModel, noProgressStreak, type PreviousAttempt } from '../src/routing/model-router.js';
import {
  codexSupportedEfforts,
  resolveEffortForTier,
  resolveFixedEffort,
  candidateSequence,
  type WorkerRuntimeCapabilities,
} from '../src/routing/provider-policy.js';
import { assessTask, isMechanicalFailure, modelUnavailableIn } from '../src/routing/task-assessment.js';
import { parseDecision } from '../src/orchestrator/decision-parser.js';
import { DECISION_JSON_SCHEMA, strictSchemaProblems } from '../src/orchestrator/decision-schema.js';

/** Claude Code 2.1.263, as its --help declares it. */
const CLAUDE: WorkerRuntimeCapabilities = {
  modelFlag: true,
  effortFlag: true,
  declaredModels: ['fable', 'opus', 'sonnet'],
  declaredEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  version: '2.1.263',
};

/** An older Claude Code whose --effort never mentions max. */
const CLAUDE_NO_MAX: WorkerRuntimeCapabilities = {
  ...CLAUDE,
  declaredEfforts: ['low', 'medium', 'high'],
  version: '2.0.0',
};

function attempt(partial: Partial<PreviousAttempt>): PreviousAttempt {
  return {
    iteration: 1,
    capability: 'BALANCED',
    reasoning: 'MEDIUM',
    model: 'sonnet',
    outcome: 'completed',
    exitCode: 0,
    progressed: true,
    mechanical: false,
    modelUnavailable: false,
    ...partial,
  };
}

function route(task: string, requested: { capability: string; reasoning: string } | null, extra: Partial<Parameters<typeof routeWorkerModel>[0]> = {}) {
  return routeWorkerModel({
    provider: 'anthropic',
    accountId: 'acc-1',
    task,
    requested: requested as never,
    previousAttempts: [],
    capabilities: CLAUDE,
    selection: 'auto',
    ...extra,
  });
}

test('a simple git task requested FAST runs on the fast model with low effort', () => {
  const out = route('Crie a branch feature/login a partir de main e faça o commit inicial', {
    capability: 'FAST',
    reasoning: 'LOW',
  });
  assert.equal(out.resolvedModel, 'haiku');
  assert.equal(out.resolvedReasoning, 'low');
  assert.equal(out.selectionMode, 'auto');
  assert.equal(out.fallbackUsed, false);
  assert.match(out.selectionReason, /Codex pediu FAST\/LOW/);
});

test('a trivial file task requested FAST stays FAST: nothing in it promotes', () => {
  const out = route('Crie hello.txt contendo exatamente: Olá AI Orchestrator', {
    capability: 'FAST',
    reasoning: 'LOW',
  });
  assert.equal(out.capability, 'FAST');
  assert.equal(out.resolvedModel, 'haiku');
  assert.doesNotMatch(out.selectionReason, /promovido/);
});

test('a normal code task requested BALANCED runs on the balanced model with medium effort', () => {
  const out = route('Adicione validação de e-mail no formulário de cadastro e um teste', {
    capability: 'BALANCED',
    reasoning: 'MEDIUM',
  });
  assert.equal(out.resolvedModel, 'sonnet');
  assert.equal(out.resolvedReasoning, 'medium');
});

test('a multi-module debugging task requested STRONG runs on the strong model with high effort', () => {
  const out = route('Depure a falha intermitente no checkout que envolve vários módulos', {
    capability: 'STRONG',
    reasoning: 'HIGH',
  });
  assert.equal(out.resolvedModel, 'opus');
  assert.equal(out.resolvedReasoning, 'high');
});

test('a critical architecture change requested MAX resolves to the top model; MAX is internal', () => {
  // The top model draws on credits beyond the subscription, so an account has
  // to say it may be used. Without that the router stops at opus - which is
  // the whole point of the account policy, and is asserted below.
  const out = route('Redesenhe a arquitetura crítica de pagamentos', { capability: 'MAX', reasoning: 'MAX' }, {
    policy: { maxCapability: null, maxReasoning: null, allowPremiumModels: true },
  });
  assert.equal(out.capability, 'MAX');
  assert.equal(out.resolvedModel, 'fable');
  // This CLI declared `max`, so `max` is what it gets.
  assert.equal(out.resolvedReasoning, 'max');
});

test('the same request on an account that has not allowed extra credits stops at opus', () => {
  const out = route('Redesenhe a arquitetura crítica de pagamentos', { capability: 'MAX', reasoning: 'MAX' });
  assert.equal(out.resolvedModel, 'opus');
  assert.match(out.selectionReason, /créditos extras/);
});

test('the incident rule: internal MAX is never sent as "max" to a CLI that did not declare it', () => {
  const out = route('Redesenhe a arquitetura crítica de pagamentos', { capability: 'MAX', reasoning: 'MAX' }, {
    capabilities: CLAUDE_NO_MAX,
  });
  assert.equal(out.reasoning, 'MAX', 'the tier is still MAX internally');
  assert.equal(out.resolvedReasoning, 'high', 'the strongest declared value stands in');
  assert.notEqual(out.resolvedReasoning, 'max');
  assert.equal(out.fallbackUsed, true);
  assert.match(out.selectionReason, /"max" não é declarado/);

  // A CLI whose help does not enumerate efforts at all gets only the
  // universal spellings - never a guess.
  const silent = route('x', { capability: 'MAX', reasoning: 'MAX' }, {
    capabilities: { ...CLAUDE, declaredEfforts: null },
  });
  assert.equal(silent.resolvedReasoning, 'high');
});

test('the same rule for Codex: a saved "max" on a CLI older than 0.140 is not sent', () => {
  const old = codexSupportedEfforts('0.130.0');
  assert.ok(old && !old.includes('max'));
  const resolved = resolveFixedEffort('max', old);
  assert.equal(resolved.value, 'xhigh');
  assert.equal(resolved.fallbackUsed, true);
  assert.match(resolved.note ?? '', /^Este nível não é suportado pela versão atual\./);

  const current = codexSupportedEfforts('0.153.4');
  assert.ok(current?.includes('max'));
  assert.deepEqual(resolveFixedEffort('max', current), { value: 'max', fallbackUsed: false, note: null });
  assert.deepEqual(resolveFixedEffort('high', null), { value: 'high', fallbackUsed: false, note: null });
  assert.equal(resolveFixedEffort('xhigh', null).value, 'high', 'unknown version: only the universal spellings');
  assert.equal(codexSupportedEfforts('garbage'), null, 'an unparsable version does not crash');
});

test('manual selection sends exactly what the person typed, validated against the CLI', () => {
  const out = route('qualquer coisa', { capability: 'FAST', reasoning: 'LOW' }, {
    selection: 'manual',
    manual: { model: 'claude-opus-5', reasoning: 'high' },
  });
  assert.equal(out.selectionMode, 'manual');
  assert.equal(out.resolvedModel, 'claude-opus-5');
  assert.equal(out.resolvedReasoning, 'high');
  assert.equal(out.fallbackUsed, false);

  // A manual level the CLI does not declare is replaced and said so.
  const unsupported = route('x', null, {
    selection: 'manual',
    manual: { model: 'claude-opus-5', reasoning: 'max' },
    capabilities: CLAUDE_NO_MAX,
  });
  assert.equal(unsupported.resolvedReasoning, 'high');
  assert.match(unsupported.selectionReason, /Este nível não é suportado pela versão atual\./);
});

test('an unavailable model falls to the next candidate - a stronger one first - and says so', () => {
  // On an account that allows the premium model, the stronger stand-in is it.
  const premium = { maxCapability: null, maxReasoning: null, allowPremiumModels: true } as const;
  const out = route('Depure a falha entre módulos', { capability: 'STRONG', reasoning: 'HIGH' }, {
    unavailableModels: ['opus'],
    policy: premium,
  });
  assert.equal(out.resolvedModel, 'fable', 'a stronger stand-in before a weaker one');
  assert.equal(out.fallbackUsed, true);
  assert.match(out.selectionReason, /indisponível nesta execução: opus/);
  // The router also hands the loop the rest of the sequence, for the retry.
  const first = route('Depure a falha entre módulos', { capability: 'STRONG', reasoning: 'HIGH' }, {
    policy: premium,
  });
  assert.deepEqual(first.alternatives, ['fable', 'sonnet', 'haiku']);
  assert.deepEqual(
    candidateSequence('anthropic', 'FAST').map((c) => c.model),
    ['haiku', 'sonnet', 'opus', 'fable'],
  );

  // And on an account that has not allowed it, the same refusal falls to a
  // weaker model rather than to one it cannot pay for.
  const capped = route('Depure a falha entre módulos', { capability: 'STRONG', reasoning: 'HIGH' }, {
    unavailableModels: ['opus'],
  });
  assert.equal(capped.resolvedModel, 'sonnet');
  assert.equal(capped.alternatives.includes('fable'), false);
});

test('repeated no-progress attempts escalate: first more reasoning, then a stronger model', () => {
  const stuck = [
    attempt({ iteration: 1, progressed: false }),
    attempt({ iteration: 2, progressed: false }),
  ];
  const out = route('Corrija o teste que falha', { capability: 'BALANCED', reasoning: 'MEDIUM' }, {
    previousAttempts: stuck,
  });
  assert.equal(out.capability, 'STRONG');
  assert.equal(out.resolvedModel, 'opus');
  assert.equal(out.reasoning, 'MAX');
  assert.match(out.selectionReason, /escalado .* após 2 tentativa/);

  // One attempt without progress: think harder on the same model.
  const once = route('Corrija o teste que falha', { capability: 'BALANCED', reasoning: 'MEDIUM' }, {
    previousAttempts: [attempt({ progressed: false })],
  });
  assert.equal(once.resolvedModel, 'sonnet');
  assert.equal(once.resolvedReasoning, 'high');
});

test('a mechanical failure (missing binary, login, quota) never escalates', () => {
  const out = route('Corrija o teste', { capability: 'BALANCED', reasoning: 'MEDIUM' }, {
    previousAttempts: [
      attempt({ progressed: false, mechanical: true, outcome: 'spawn-error', exitCode: null }),
      attempt({ progressed: false, mechanical: true, exitCode: 1 }),
    ],
  });
  assert.equal(out.capability, 'BALANCED');
  assert.equal(out.resolvedModel, 'sonnet');
  assert.doesNotMatch(out.selectionReason, /escalado/);
  assert.equal(noProgressStreak([attempt({ progressed: false, modelUnavailable: true })]), 0);

  assert.equal(isMechanicalFailure({ outcome: 'completed', exitCode: 1, stdout: '', stderr: 'Not logged in. Please run /login' }), true);
  assert.equal(isMechanicalFailure({ outcome: 'completed', exitCode: 1, stdout: '', stderr: 'API rate limit exceeded' }), true);
  assert.equal(isMechanicalFailure({ outcome: 'completed', exitCode: 1, stdout: '', stderr: 'TypeError: cannot read x' }), false);
  assert.equal(isMechanicalFailure({ outcome: 'completed', exitCode: 0, stdout: 'network', stderr: '' }), false);
  assert.equal(modelUnavailableIn({ outcome: 'completed', exitCode: 1, stdout: '', stderr: 'Error: model "haiku" not found' }), true);
  assert.equal(modelUnavailableIn({ outcome: 'completed', exitCode: 1, stdout: '', stderr: 'not_found_error: The requested model does not exist' }), true);
  assert.equal(modelUnavailableIn({ outcome: 'completed', exitCode: 0, stdout: 'model x not found in docs', stderr: '' }), false);
});

test('escalation is not sticky: a simple task after a hard one goes back down', () => {
  const history = [
    attempt({ iteration: 1, capability: 'STRONG', reasoning: 'HIGH', model: 'opus', progressed: true }),
  ];
  const out = route('Atualize o README com o novo comando', { capability: 'FAST', reasoning: 'LOW' }, {
    previousAttempts: history,
  });
  assert.equal(out.capability, 'FAST');
  assert.equal(out.resolvedModel, 'haiku');
  assert.equal(out.resolvedReasoning, 'low');
});

test('within one run the model follows each delegation: STRONG then FAST', () => {
  const hard = route('Depure a falha entre módulos', { capability: 'STRONG', reasoning: 'HIGH' });
  const easy = route('Renomeie a variável no README', { capability: 'FAST', reasoning: 'LOW' }, {
    previousAttempts: [attempt({ capability: 'STRONG', reasoning: 'HIGH', model: hard.resolvedModel, progressed: true })],
  });
  assert.equal(hard.resolvedModel, 'opus');
  assert.equal(easy.resolvedModel, 'haiku');
});

test('capabilities are an input: what the CLI does not offer is not sent', () => {
  const bare: WorkerRuntimeCapabilities = { modelFlag: false, effortFlag: false, declaredModels: null, declaredEfforts: null };
  const out = route('x', { capability: 'STRONG', reasoning: 'HIGH' }, { capabilities: bare });
  assert.equal(out.resolvedModel, null);
  assert.equal(out.resolvedReasoning, null);
  assert.equal(out.fallbackUsed, true);
  assert.match(out.selectionReason, /não aceita --model/);
});

test('a decision without requirements falls back to BALANCED/MEDIUM and says so', () => {
  const out = route('Faça algo', null);
  assert.equal(out.requestedCapability, 'BALANCED');
  assert.equal(out.requestedReasoning, 'MEDIUM');
  assert.equal(out.resolvedModel, 'sonnet');
  assert.equal(out.resolvedReasoning, 'medium');
  assert.match(out.selectionReason, /sem requisitos/);

  const parsed = parseDecision('{"action":"delegate","task":"x"}');
  assert.equal(parsed.ok && parsed.decision.workerRequirements, undefined);
});

test('the sanity check promotes an underestimated request and never demotes', () => {
  const out = route(
    'Crie a migração do banco de dados que adiciona a tabela users e altere o schema',
    { capability: 'FAST', reasoning: 'LOW' },
  );
  assert.equal(out.requestedCapability, 'FAST');
  assert.equal(out.capability, 'STRONG');
  assert.match(out.selectionReason, /promovido para STRONG\/HIGH/);
  assert.match(out.selectionReason, /esquema ou banco/);

  const critical = assessTask('Mudança crítica de arquitetura no core do sistema');
  assert.equal(critical.minimumCapability, 'MAX', 'two independent signals raise the floor one more step');

  // Asked MAX for a trivial task: the floor is a floor, not a ceiling.
  const generous = route('Crie hello.txt', { capability: 'MAX', reasoning: 'MAX' });
  assert.equal(generous.capability, 'MAX');
});

test('the speed strategy leans down only on plainly safe tasks; quality leans up', () => {
  const quick = route('Atualize o README', { capability: 'BALANCED', reasoning: 'MEDIUM' }, { selection: 'speed' });
  assert.equal(quick.resolvedModel, 'haiku');
  const dangerous = route('Altere a autenticação e os tokens', { capability: 'STRONG', reasoning: 'HIGH' }, { selection: 'speed' });
  assert.equal(dangerous.resolvedModel, 'opus', 'a dangerous task is never downgraded to save cost');
  assert.match(dangerous.selectionReason, /ignorada: tarefa sensível/);
  const careful = route('Atualize o README', { capability: 'BALANCED', reasoning: 'MEDIUM' }, { selection: 'quality' });
  assert.equal(careful.resolvedModel, 'opus');
});

test('the decision contract carries the requirements, strict-mode valid, and the parser reads them', () => {
  assert.deepEqual(strictSchemaProblems(DECISION_JSON_SCHEMA), []);
  assert.ok(DECISION_JSON_SCHEMA.required.includes('workerRequirements'));
  const parsed = parseDecision(
    JSON.stringify({
      action: 'delegate',
      task: 'x',
      acceptanceCriteria: [],
      verificationCommands: [],
      summary: null,
      reason: null,
      relevantFiles: [],
      workerRequirements: { capability: 'strong', reasoning: 'high', rationale: 'multi-module' },
    }),
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.decision.workerRequirements, {
      capability: 'STRONG',
      reasoning: 'HIGH',
      rationale: 'multi-module',
    });
  }
  // An unknown tier is ignored, not fatal: the router's default takes over.
  const odd = parseDecision('{"action":"delegate","task":"x","workerRequirements":{"capability":"ultra","reasoning":"high"}}');
  assert.equal(odd.ok, true);
  if (odd.ok) assert.equal(odd.decision.workerRequirements, undefined);
});

test('effort resolution for a tier prefers the CLI\'s own spelling and degrades in order', () => {
  assert.deepEqual(resolveEffortForTier('HIGH', ['low', 'medium', 'high']), { value: 'high', fallbackUsed: false, note: null });
  assert.equal(resolveEffortForTier('MAX', ['low', 'medium', 'high', 'xhigh']).value, 'xhigh');
  assert.equal(resolveEffortForTier('MAX', ['low']).value, null);
});
