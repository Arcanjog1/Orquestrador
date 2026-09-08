/**
 * O teto que pertence à conta.
 *
 * ## O incidente
 *
 * Uma execução escalou o worker até o topo. `CLAUDE_MODELS.MAX` lista `fable`
 * primeiro e `CLAUDE_EFFORTS.MAX` lista `max` primeiro, então o topo
 * significava **o modelo premium no esforço máximo** — e a conta respondeu:
 *
 *     You're out of usage credits.
 *
 * A assinatura não tinha acabado. Faltavam os créditos extras que aquele
 * modelo consome, e nada no aplicativo sabia que isso podia ser verdade de uma
 * conta e não de outra.
 *
 * ## A regra
 *
 * O teto é aplicado **antes** de um nome de modelo ser considerado. Tentar o
 * modelo premium e ler a recusa depois é descobrir gastando — e numa
 * assinatura essa recusa custa uma iteração.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWorkerModel } from '../src/routing/model-router.js';
import {
  applyCeiling,
  DEFAULT_ACCOUNT_POLICY,
  isPremiumModel,
  refusesModel,
  type AccountRoutingPolicy,
} from '../src/routing/account-policy.js';
import { classifyCreditFailure } from '../src/routing/credit-failure.js';
import type { WorkerRuntimeCapabilities } from '../src/routing/provider-policy.js';

/** A CLI that takes everything, so the policy is the only thing deciding. */
const CAPABLE: WorkerRuntimeCapabilities = {
  modelFlag: true,
  effortFlag: true,
  declaredModels: ['haiku', 'sonnet', 'opus', 'fable'],
  declaredEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** The ceiling this account asked for: Opus, reasoning high, no extra credits. */
const OPUS_HIGH: AccountRoutingPolicy = {
  maxCapability: 'STRONG',
  maxReasoning: 'HIGH',
  allowPremiumModels: false,
};

function route(
  capability: 'FAST' | 'BALANCED' | 'STRONG' | 'MAX',
  reasoning: 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX',
  policy: AccountRoutingPolicy = DEFAULT_ACCOUNT_POLICY,
  over: Partial<Parameters<typeof routeWorkerModel>[0]> = {},
) {
  return routeWorkerModel({
    provider: 'anthropic',
    accountId: 'acc-1',
    task: 'crie hello.txt com o texto pronto',
    requested: { capability, reasoning },
    previousAttempts: [],
    capabilities: CAPABLE,
    selection: 'auto',
    policy,
    ...over,
  });
}

/* ---- the tiers, with no ceiling ---------------------------------------- */

test('FAST/LOW picks a small model and low effort', () => {
  const out = route('FAST', 'LOW');
  assert.equal(out.resolvedModel, 'haiku');
  assert.equal(out.resolvedReasoning, 'low');
});

test('STRONG/HIGH picks opus at high, with or without the ceiling', () => {
  for (const policy of [DEFAULT_ACCOUNT_POLICY, OPUS_HIGH]) {
    const out = route('STRONG', 'HIGH', policy);
    assert.equal(out.resolvedModel, 'opus');
    assert.equal(out.resolvedReasoning, 'high');
    // Nothing was limited, so nothing claims it was.
    assert.doesNotMatch(out.selectionReason, /limitado a/);
  }
});

/* ---- the incident ------------------------------------------------------ */

test('MAX/MAX is limited to opus/high, and says so in those words', () => {
  const out = route('MAX', 'MAX', OPUS_HIGH);
  assert.equal(out.capability, 'STRONG');
  assert.equal(out.reasoning, 'HIGH');
  assert.equal(out.resolvedModel, 'opus');
  assert.equal(out.resolvedReasoning, 'high');
  assert.match(out.selectionReason, /Solicitado MAX\/MAX; limitado a STRONG\/HIGH pela política da conta/);
  assert.equal(out.fallbackUsed, true);
  assert.equal(out.policyBlocked, false);
  // And the premium model is nowhere - not first, not as a fallback.
  assert.equal(out.alternatives.includes('fable'), false);
});

test('without a ceiling, MAX still skips the premium model when credits are off', () => {
  // The other half of the fix: a person who set no tier ceiling at all is
  // still not routed to a model that draws on credits they never approved.
  const out = route('MAX', 'MAX', DEFAULT_ACCOUNT_POLICY);
  assert.equal(out.resolvedModel, 'opus');
  assert.equal(out.alternatives.includes('fable'), false);
  assert.match(out.selectionReason, /créditos extras/);
});

test('an account that does allow extra credits still reaches the premium model', () => {
  const out = route('MAX', 'MAX', {
    maxCapability: null,
    maxReasoning: null,
    allowPremiumModels: true,
  });
  assert.equal(out.resolvedModel, 'fable');
  assert.equal(out.resolvedReasoning, 'max');
});

test('two accounts hold different ceilings, and neither is global', () => {
  const capped = route('MAX', 'MAX', OPUS_HIGH);
  const open = route('MAX', 'MAX', {
    maxCapability: null,
    maxReasoning: null,
    allowPremiumModels: true,
  });
  assert.equal(capped.resolvedModel, 'opus');
  assert.equal(open.resolvedModel, 'fable');
});

test('escalation from no progress cannot climb past the ceiling', () => {
  // Three attempts that changed nothing: the router would normally promote
  // two steps. The ceiling holds.
  const attempts = [1, 2, 3].map((iteration) => ({
    iteration,
    capability: 'BALANCED' as const,
    reasoning: 'MEDIUM' as const,
    model: 'sonnet',
    outcome: 'completed' as const,
    exitCode: 0,
    progressed: false,
    mechanical: false,
    modelUnavailable: false,
  }));
  const out = route('BALANCED', 'MEDIUM', OPUS_HIGH, { previousAttempts: attempts });
  assert.equal(out.resolvedModel, 'opus');
  assert.equal(out.resolvedReasoning, 'high');
  assert.match(out.selectionReason, /escalado para/);
  assert.match(out.selectionReason, /limitado a STRONG\/HIGH pela política da conta/);
});

test('a manual choice above the ceiling is refused, not sent', () => {
  const out = route('STRONG', 'HIGH', OPUS_HIGH, {
    selection: 'manual',
    manual: { model: 'fable', reasoning: 'max' },
  });
  assert.equal(out.resolvedModel, null, 'the premium model is not sent');
  assert.match(out.selectionReason, /exige créditos extras e a política desta conta não permite/);
});

test('the run stops for a person when the policy leaves nothing to run', () => {
  // A tier whose every candidate is premium, with credits off: falling back
  // to the CLI default here would run exactly the model the policy exists to
  // keep out, so the router says so instead.
  const out = routeWorkerModel({
    provider: 'anthropic',
    accountId: 'acc-1',
    task: 'x',
    requested: { capability: 'MAX', reasoning: 'MAX' },
    previousAttempts: [],
    capabilities: CAPABLE,
    selection: 'auto',
    policy: DEFAULT_ACCOUNT_POLICY,
    // opus already refused by the CLI this run, so only the premium one is left
    unavailableModels: ['opus', 'sonnet', 'haiku'],
  });
  assert.equal(out.resolvedModel, null);
  assert.equal(out.policyBlocked, true);
  assert.match(out.selectionReason, /exigem créditos extras/);
});

/* ---- mechanical failures do not escalate -------------------------------- */

test('a credit failure never becomes a stronger model', () => {
  const attempts = [1, 2].map((iteration) => ({
    iteration,
    capability: 'STRONG' as const,
    reasoning: 'HIGH' as const,
    model: 'opus',
    outcome: 'completed' as const,
    exitCode: 1,
    progressed: false,
    // The whole point: a mechanical failure counts for nothing in the streak.
    mechanical: true,
    modelUnavailable: false,
  }));
  const out = route('BALANCED', 'MEDIUM', OPUS_HIGH, { previousAttempts: attempts });
  assert.equal(out.capability, 'BALANCED');
  assert.equal(out.reasoning, 'MEDIUM');
  assert.doesNotMatch(out.selectionReason, /escalado/);
});

/* ---- reading the provider's own words ----------------------------------- */

test('the message from the incident is read as extra credits, not as a dead subscription', () => {
  const read = classifyCreditFailure("You're out of usage credits.");
  assert.equal(read.cause, 'extra-credits');
  assert.match(read.message, /sem créditos extras/);
  assert.match(read.message, /não é o mesmo que a assinatura ter acabado/);
});

test('the other causes are told apart, and an unclear message is not guessed at', () => {
  assert.equal(classifyCreditFailure('You have hit your usage limit for this plan').cause, 'subscription-limit');
  assert.equal(classifyCreditFailure('Your account is not authorized to use the model fable').cause, 'model-not-authorised');
  assert.equal(classifyCreditFailure('invalid api key').cause, 'authentication');

  const unknown = classifyCreditFailure('request failed');
  assert.equal(unknown.cause, 'unknown');
  assert.match(unknown.message, /não vai adivinhá-la/);

  assert.equal(classifyCreditFailure(null).cause, 'unknown');
  assert.equal(classifyCreditFailure('').cause, 'unknown');
});

test('a named model is picked out of the message, and an unrelated word is not', () => {
  assert.equal(classifyCreditFailure('not authorized to use the model fable').model, 'fable');
  assert.equal(classifyCreditFailure('You are out of usage credits').model, null);
});

/* ---- the pieces on their own -------------------------------------------- */

test('the ceiling only ever clamps downward', () => {
  const up = applyCeiling('FAST', 'LOW', { maxCapability: 'MAX', maxReasoning: 'MAX', allowPremiumModels: true });
  assert.equal(up.capability, 'FAST');
  assert.equal(up.reasoning, 'LOW');
  assert.equal(up.note, null);
});

test('the premium list is by alias, and the default policy refuses it', () => {
  assert.equal(isPremiumModel('fable'), true);
  assert.equal(isPremiumModel('FABLE'), true);
  assert.equal(isPremiumModel('opus'), false);
  assert.equal(refusesModel('fable', DEFAULT_ACCOUNT_POLICY), true);
  assert.equal(refusesModel('opus', DEFAULT_ACCOUNT_POLICY), false);
  // And the default is the safe one: nothing spends extra credits unasked.
  assert.equal(DEFAULT_ACCOUNT_POLICY.allowPremiumModels, false);
  assert.equal(DEFAULT_ACCOUNT_POLICY.maxCapability, null);
});

/* ---- persisted, per account, and honoured by a real run ----------------- */

test('the ceiling is saved per account and survives reopening the application', async () => {
  const { createDesktopFixture } = await import('./helpers/desktop-fixture.js');
  const { Database } = await import('../src/database/database.js');
  const fixture = createDesktopFixture();
  try {
    const first = value<{ id: string; routing: RoutingView }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
    );
    const second = value<{ id: string; routing: RoutingView }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Pessoal', provider: 'anthropic' }),
    );

    // The default every account starts with: no ceiling, extra credits off.
    assert.equal(first.routing.maxCapability, null);
    assert.equal(first.routing.allowPremiumModels, false);
    assert.deepEqual([...first.routing.premiumModels], ['fable']);

    const saved = value<{ routing: RoutingView }>(
      await fixture.router.handle('accounts.setRoutingPolicy', {
        accountId: first.id,
        maxCapability: 'STRONG',
        maxReasoning: 'HIGH',
        allowPremiumModels: false,
      }),
    );
    assert.equal(saved.routing.maxCapability, 'STRONG');
    assert.equal(saved.routing.maxReasoning, 'HIGH');

    // The other account is untouched: this is a property of an account, not a
    // global setting.
    const listed = value<ReadonlyArray<{ id: string; routing: RoutingView }>>(
      await fixture.router.handle('accounts.list', null),
    );
    assert.equal(listed.find((a) => a.id === second.id)?.routing.maxCapability, null);

    // And it is on disk, not in memory.
    const reopened = new Database({ paths: fixture.paths });
    try {
      const row = reopened.accounts.require(first.id);
      assert.equal(row.max_capability, 'STRONG');
      assert.equal(row.max_reasoning, 'HIGH');
      assert.equal(row.allow_premium_models, 0);
    } finally {
      reopened.close();
    }

    // A tier that is not a tier is refused at the boundary, not stored.
    const refused = await fixture.router.handle('accounts.setRoutingPolicy', {
      accountId: first.id,
      maxCapability: 'ULTRA',
      maxReasoning: 'HIGH',
      allowPremiumModels: false,
    });
    assert.equal(refused.ok, false);
  } finally {
    await fixture.cleanup();
  }
});

interface RoutingView {
  maxCapability: string | null;
  maxReasoning: string | null;
  allowPremiumModels: boolean;
  premiumModels: readonly string[];
}

function value<T>(result: { ok: boolean } & Record<string, unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? String((result as { error?: { message?: string } }).error?.message) : '');
  return (result as unknown as { value: T }).value;
}
