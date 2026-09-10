import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountManager } from '../src/accounts/claude-account-manager.js';
import type { Account, AccountStatus, AuthState } from '../src/accounts/account-types.js';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import { RuntimeManager } from '../src/runtime/runtime-manager.js';
import { RuntimeNotReadyError } from '../src/runtime/types.js';
import { ProcessManager, type ProcessResult, type RunProcessOptions } from '../src/process/process-manager.js';
import { makeFetch } from './helpers/fake-runtime-source.js';
import {
  AccountModelVerifier,
  looksLikeModelRefusal,
  parseListing,
} from '../src/models/account-model-verifier.js';
import {
  AVAILABILITY_LABELS,
  statusFor,
  statusesForAccount,
  summarise,
} from '../src/models/model-availability.js';
import { resolveFixedModel, recordSubstitution } from '../src/models/model-policy.js';
import { InMemoryVerificationStore, SettingsVerificationStore } from '../src/models/verification-store.js';
import type { AccountModelVerification } from '../src/models/model-types.js';

const WORK: Account = {
  id: 'acc-work',
  providerId: 'anthropic',
  displayName: 'Claude Trabalho',
  createdAt: '2026-09-01T00:00:00.000Z',
};
const PERSONAL: Account = {
  id: 'acc-personal',
  providerId: 'anthropic',
  displayName: 'Claude Pessoal',
  createdAt: '2026-09-01T00:00:00.000Z',
};

const NOW = new Date('2026-09-10T12:00:00.000Z');

/** A process manager that answers from a script instead of spawning anything. */
class ScriptedProcessManager extends ProcessManager {
  readonly calls: RunProcessOptions[] = [];

  constructor(private readonly reply: (options: RunProcessOptions) => Partial<ProcessResult>) {
    super();
  }

  override run(options: RunProcessOptions): Promise<ProcessResult> {
    this.calls.push(options);
    const scripted = this.reply(options);
    return Promise.resolve({
      outcome: 'completed',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      truncated: false,
      ...scripted,
    });
  }
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'lao-models-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function makeVerifier(
  home: string,
  reply: (options: RunProcessOptions) => Partial<ProcessResult>,
  options: { executable?: string | null; authState?: AuthState } = {},
) {
  const paths = ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
  const runtimeManager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
  const executable = options.executable === undefined ? process.execPath : options.executable;

  Object.defineProperty(runtimeManager.get('claude-code'), 'getExecutablePath', {
    value: async () => {
      if (!executable) throw new RuntimeNotReadyError('claude-code', 'Claude Code');
      return executable;
    },
    writable: true,
  });

  const processManager = new ScriptedProcessManager(reply);
  const accounts = new ClaudeAccountManager({ runtimeManager, paths, processManager });
  const state: AuthState = options.authState ?? 'connected';
  Object.defineProperty(accounts, 'getStatus', {
    value: async (account: Account): Promise<AccountStatus> => ({
      accountId: account.id,
      displayName: account.displayName,
      state,
      checkedAt: NOW.toISOString(),
    }),
    writable: true,
  });

  const verifier = new AccountModelVerifier({ runtimeManager, accounts, processManager });
  return { verifier, processManager, accounts };
}

function verification(overrides: Partial<AccountModelVerification>): AccountModelVerification {
  return {
    accountId: WORK.id,
    checkedAt: NOW.toISOString(),
    outcome: 'verified',
    method: 'runtime-capabilities',
    confirmed: [],
    denied: [],
    completeness: 'partial',
    detail: 'listado',
    ...overrides,
  };
}

// --- the three states, told apart -------------------------------------------

test('an unchecked model reads as catalogued, not as a problem', () => {
  const status = statusFor(WORK.id, 'claude-opus-5', null, { now: NOW });

  assert.equal(status.availability, 'KNOWN_BUT_UNVERIFIED');
  assert.equal(status.label, AVAILABILITY_LABELS.knownButUnverified);
  assert.equal(status.label, 'Disponível no catálogo — ainda não verificado nesta conta');
  // The bug being fixed: this used to be painted as a warning.
  assert.equal(status.tone, 'neutral');
  assert.equal(status.usable, true);
  assert.equal(status.reason, 'never-checked');
  assert.ok(!/não confirmada/i.test(status.label));
  assert.deepEqual(
    status.actions.map((action) => action.id),
    ['verify-account-models', 'verify-with-minimal-call'],
  );
});

test('a confirmed model says so, and only for the account that was checked', () => {
  const record = verification({ confirmed: ['claude-opus-5'], completeness: 'exhaustive' });
  const status = statusFor(WORK.id, 'claude-opus-5', record, { now: NOW });

  assert.equal(status.availability, 'CONFIRMED_FOR_ACCOUNT');
  assert.equal(status.label, AVAILABILITY_LABELS.confirmed);
  assert.equal(status.tone, 'ok');
  assert.equal(status.usable, true);
  assert.equal(status.evidence.accountId, WORK.id);
  assert.deepEqual(status.actions, []);
});

test('an account may only be described with its own evidence', () => {
  const record = verification({ accountId: PERSONAL.id, confirmed: ['claude-opus-5'] });

  assert.throws(
    () => statusFor(WORK.id, 'claude-opus-5', record, { now: NOW }),
    /never shared between accounts/,
  );

  // And what account A knows never reaches account B through the store.
  const store = new InMemoryVerificationStore();
  store.write(record);
  assert.equal(store.read(PERSONAL.id)?.confirmed.length, 1);
  assert.equal(store.read(WORK.id), null);
  assert.equal(
    statusFor(WORK.id, 'claude-opus-5', store.read(WORK.id), { now: NOW }).availability,
    'KNOWN_BUT_UNVERIFIED',
  );
});

test('absence means unavailable only when the listing claims to be complete', () => {
  const partial = verification({ confirmed: ['claude-sonnet-5'], completeness: 'partial' });
  const partialStatus = statusFor(WORK.id, 'claude-opus-5', partial, { now: NOW });
  assert.equal(partialStatus.availability, 'KNOWN_BUT_UNVERIFIED');
  assert.equal(partialStatus.reason, 'listing-not-exhaustive');
  assert.equal(partialStatus.tone, 'neutral');

  const complete = verification({ confirmed: ['claude-sonnet-5'], completeness: 'exhaustive' });
  const completeStatus = statusFor(WORK.id, 'claude-opus-5', complete, { now: NOW });
  assert.equal(completeStatus.availability, 'UNAVAILABLE');
  assert.equal(completeStatus.reason, 'not-in-account-entitlement');
  assert.equal(completeStatus.tone, 'blocked');
  assert.equal(completeStatus.usable, false);
});

test('a CLI that cannot report models leaves everything unverified, never unavailable', () => {
  const record = verification({
    outcome: 'not-supported',
    method: 'none',
    completeness: 'none',
    detail: 'o CLI não expõe modelos',
  });

  for (const status of statusesForAccount(WORK.id, record, { now: NOW })) {
    assert.equal(status.availability, 'KNOWN_BUT_UNVERIFIED');
    assert.equal(status.reason, 'cli-does-not-report-models');
    assert.equal(status.tone, 'neutral');
    assert.equal(status.usable, true);
    assert.match(status.detail, /não informa quais modelos/);
  }

  const summary = summarise(record);
  assert.equal(summary.tone, 'neutral');
  assert.match(summary.headline, /não expõe os modelos/);
  assert.equal(summary.action.id, 'verify-with-minimal-call');
  assert.equal(summary.action.consumesUsage, true);
});

test('a stale denial is dropped, a stale confirmation is only flagged', () => {
  const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const denial = verification({
    checkedAt: old,
    confirmed: ['claude-sonnet-5'],
    completeness: 'exhaustive',
  });
  const revived = statusFor(WORK.id, 'claude-opus-5', denial, { now: NOW });
  assert.equal(revived.availability, 'KNOWN_BUT_UNVERIFIED');
  assert.equal(revived.reason, 'denial-expired');
  assert.equal(revived.usable, true);

  const confirmation = verification({ checkedAt: old, confirmed: ['claude-opus-5'] });
  const aged = statusFor(WORK.id, 'claude-opus-5', confirmation, { now: NOW });
  assert.equal(aged.availability, 'CONFIRMED_FOR_ACCOUNT');
  assert.equal(aged.stale, true);
  assert.equal(aged.tone, 'ok');
  assert.deepEqual(
    aged.actions.map((action) => action.id),
    ['verify-account-models'],
  );
});

test('a model outside the catalogue is described honestly, not rejected', () => {
  const status = statusFor(WORK.id, 'algum-modelo-interno', null, { now: NOW });
  assert.equal(status.availability, 'KNOWN_BUT_UNVERIFIED');
  assert.equal(status.label, AVAILABILITY_LABELS.unknownButUnverified);
  assert.equal(status.usable, true);
  assert.equal(status.reason, 'outside-catalog');
});

// --- the verification action -------------------------------------------------

test('verifying reads the account listing through that account profile only', async () => {
  await withHome(async (home) => {
    const { verifier, processManager } = makeVerifier(home, (options) => {
      if (options.args?.[0] === 'models') {
        return {
          stdout: JSON.stringify({
            scope: 'account',
            models: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5', available: false }],
          }),
        };
      }
      return { exitCode: 1, stderr: 'unknown command' };
    });

    const record = await verifier.verify(WORK, { now: NOW });

    assert.equal(record.accountId, WORK.id);
    assert.equal(record.outcome, 'verified');
    assert.equal(record.completeness, 'exhaustive');
    assert.deepEqual(record.confirmed, ['claude-opus-5']);
    assert.deepEqual(record.denied, ['claude-sonnet-5']);

    const call = processManager.calls.at(-1);
    assert.ok(call?.env?.CLAUDE_CONFIG_DIR?.includes(WORK.id), 'must read this account profile');
    assert.equal(call?.env?.ANTHROPIC_API_KEY, undefined);

    // The result is the account's, and the other account is untouched.
    assert.equal(verifier.lastVerification(WORK.id)?.confirmed.length, 1);
    assert.equal(verifier.lastVerification(PERSONAL.id), null);
    assert.equal(
      statusFor(PERSONAL.id, 'claude-opus-5', verifier.lastVerification(PERSONAL.id), { now: NOW })
        .availability,
      'KNOWN_BUT_UNVERIFIED',
    );
  });
});

test('a CLI with no such command is reported as such, and denies nothing', async () => {
  await withHome(async (home) => {
    const { verifier } = makeVerifier(home, () => ({
      exitCode: 1,
      stderr: "error: unknown command 'models'",
    }));

    const record = await verifier.verify(WORK, { now: NOW });

    assert.equal(record.outcome, 'not-supported');
    assert.deepEqual(record.denied, []);
    assert.equal(record.completeness, 'none');
    assert.match(record.detail, /não expõe os modelos/);
    assert.equal(
      statusFor(WORK.id, 'claude-opus-5', record, { now: NOW }).availability,
      'KNOWN_BUT_UNVERIFIED',
    );
  });
});

test('an unconfigured runtime and a disconnected account are different sentences', async () => {
  await withHome(async (home) => {
    const missing = makeVerifier(home, () => ({}), { executable: null });
    const first = await missing.verifier.verify(WORK, { now: NOW });
    assert.equal(first.outcome, 'runtime-missing');
    assert.equal(statusFor(WORK.id, 'claude-opus-5', first, { now: NOW }).actions[0]?.id, 'install-runtime');

    const ambient = makeVerifier(home, () => ({}), { authState: 'ambient-credential' });
    const second = await ambient.verifier.verify(WORK, { now: NOW });
    assert.equal(second.outcome, 'account-not-connected');
    assert.match(second.detail, /credencial do sistema/);
    assert.equal(statusFor(WORK.id, 'claude-opus-5', second, { now: NOW }).actions[0]?.id, 'connect-account');
  });
});

test('the minimal call runs only with explicit authorisation, and over stdin', async () => {
  await withHome(async (home) => {
    const { verifier, processManager } = makeVerifier(home, (options) => {
      if (options.args?.includes('--model')) {
        const model = options.args[options.args.indexOf('--model') + 1];
        return model === 'claude-opus-5'
          ? { stdout: 'ok' }
          : { exitCode: 1, stderr: 'this model is not available for your account' };
      }
      return { exitCode: 1, stderr: 'unknown command' };
    });

    const withoutConsent = await verifier.verify(WORK, { now: NOW });
    assert.equal(withoutConsent.outcome, 'not-supported');
    assert.equal(
      processManager.calls.some((call) => call.args?.includes('--model')),
      false,
      'no request may be sent to a model without the user saying yes',
    );

    const authorised = await verifier.verify(WORK, {
      now: NOW,
      minimalCall: {
        authorizedByUser: true,
        modelIds: ['claude-opus-5', 'claude-sonnet-5'],
      },
    });

    assert.equal(authorised.method, 'minimal-call');
    assert.deepEqual(authorised.confirmed, ['claude-opus-5']);
    assert.deepEqual(authorised.denied, ['claude-sonnet-5']);
    // Never an exhaustive listing: a few calls do not add up to an entitlement.
    assert.equal(authorised.completeness, 'partial');

    const probe = processManager.calls.find((call) => call.args?.includes('--model'));
    assert.equal(probe?.stdin, 'ok');
    assert.equal(
      probe?.args?.some((arg) => arg === 'ok'),
      false,
      'prompts go over stdin, never on the command line',
    );
  });
});

test('an inconclusive minimal call never becomes a denial', async () => {
  await withHome(async (home) => {
    const { verifier } = makeVerifier(home, (options) => {
      if (options.args?.includes('--model')) {
        return { outcome: 'timeout', exitCode: null, stderr: 'network unreachable' };
      }
      return { exitCode: 1, stderr: 'unknown command' };
    });

    const record = await verifier.verify(WORK, {
      now: NOW,
      minimalCall: { authorizedByUser: true, modelIds: ['claude-opus-5'] },
    });

    assert.deepEqual(record.denied, []);
    assert.deepEqual(record.confirmed, []);
    assert.equal(record.outcome, 'not-supported');
    assert.equal(
      statusFor(WORK.id, 'claude-opus-5', record, { now: NOW }).availability,
      'KNOWN_BUT_UNVERIFIED',
    );
  });
});

test('only a listing that claims completeness is treated as complete', () => {
  assert.equal(parseListing('nothing here'), null);
  assert.equal(parseListing(JSON.stringify({ loggedIn: true })), null);
  assert.equal(parseListing(JSON.stringify({ models: [] })), null);

  const partial = parseListing(JSON.stringify({ models: ['opus', 'sonnet'] }));
  assert.deepEqual(partial, {
    confirmed: ['claude-opus-5', 'claude-sonnet-5'],
    denied: [],
    completeness: 'partial',
  });

  const complete = parseListing(JSON.stringify({ complete: true, data: [{ model: 'opus' }] }));
  assert.equal(complete?.completeness, 'exhaustive');
});

test('only an explicit refusal reads as a refusal', () => {
  assert.equal(looksLikeModelRefusal('this model is not available for your account'), true);
  assert.equal(looksLikeModelRefusal('Error: unknown model claude-opus-9'), true);
  assert.equal(looksLikeModelRefusal('modelo indisponível nesta conta'), true);
  assert.equal(looksLikeModelRefusal('ECONNRESET: network unreachable'), false);
  assert.equal(looksLikeModelRefusal('rate limit exceeded, try again later'), false);
});

test('the settings-backed store keeps accounts apart', () => {
  const values = new Map<string, string>();
  const store = new SettingsVerificationStore({
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
  });

  store.write(verification({ accountId: WORK.id, confirmed: ['claude-opus-5'] }));
  assert.deepEqual(store.read(WORK.id)?.confirmed, ['claude-opus-5']);
  assert.equal(store.read(PERSONAL.id), null);

  store.clear(WORK.id);
  assert.equal(store.read(WORK.id), null);
});

// --- FIXED model, ceilings, no silent fallback -------------------------------

test('an unverified model still runs, and says why it is unverified', () => {
  const status = statusFor(WORK.id, 'claude-opus-5', null, { now: NOW });
  const resolution = resolveFixedModel(
    { agentId: 'agent-1', accountId: WORK.id, modelId: 'claude-opus-5' },
    status,
  );

  assert.equal(resolution.decision, 'allowed-unverified');
  assert.equal(resolution.modelId, 'claude-opus-5');
  assert.equal(resolution.usable, true);
  assert.equal(resolution.requiresUserDecision, false);
  assert.equal(resolution.substitutedModelId, null);
});

test('a blocked assignment is never quietly given another model', () => {
  const record = verification({ confirmed: ['claude-sonnet-5'], completeness: 'exhaustive' });
  const status = statusFor(WORK.id, 'claude-opus-5', record, { now: NOW });
  const resolution = resolveFixedModel(
    { agentId: 'agent-1', accountId: WORK.id, modelId: 'claude-opus-5' },
    status,
  );

  assert.equal(resolution.decision, 'blocked-unavailable');
  assert.equal(resolution.modelId, null);
  assert.equal(resolution.substitutedModelId, null);
  assert.equal(resolution.usable, false);
  assert.equal(resolution.requiresUserDecision, true);

  // A substitution exists only as a recorded, explained act.
  assert.throws(() => recordSubstitution(resolution, 'agent-1', '   '), /silent fallback/);
  assert.deepEqual(recordSubstitution(resolution, 'agent-1', 'sem acesso ao modelo fixo'), {
    substitutedForAgentId: 'agent-1',
    substitutionReason: 'sem acesso ao modelo fixo',
  });
});

test('a ceiling still holds, and an unprovable tier does not slip past it', () => {
  const confirmed = verification({ confirmed: ['claude-opus-5', 'proprio-modelo'] });

  const above = resolveFixedModel(
    {
      agentId: 'agent-1',
      accountId: WORK.id,
      modelId: 'claude-opus-5',
      ceiling: { maxTier: 'balanced', note: 'Teto definido para este agente.' },
    },
    statusFor(WORK.id, 'claude-opus-5', confirmed, { now: NOW }),
  );
  assert.equal(above.decision, 'blocked-above-ceiling');
  assert.equal(above.modelId, null);

  const unknownTier = resolveFixedModel(
    {
      agentId: 'agent-1',
      accountId: WORK.id,
      modelId: 'proprio-modelo',
      ceiling: { maxTier: 'balanced' },
    },
    statusFor(WORK.id, 'proprio-modelo', confirmed, { now: NOW }),
  );
  assert.equal(unknownTier.decision, 'blocked-unknown-tier');
  assert.equal(unknownTier.modelId, null);

  const withinCeiling = resolveFixedModel(
    { agentId: 'agent-1', accountId: WORK.id, modelId: 'claude-sonnet-5', ceiling: { maxTier: 'balanced' } },
    statusFor(WORK.id, 'claude-sonnet-5', null, { now: NOW }),
  );
  assert.equal(withinCeiling.decision, 'allowed-unverified');
  assert.equal(withinCeiling.modelId, 'claude-sonnet-5');
});

test('availability from one account cannot authorise another', () => {
  const record = verification({ accountId: PERSONAL.id, confirmed: ['claude-opus-5'] });
  const personalStatus = statusFor(PERSONAL.id, 'claude-opus-5', record, { now: NOW });

  const resolution = resolveFixedModel(
    { agentId: 'agent-1', accountId: WORK.id, modelId: 'claude-opus-5' },
    personalStatus,
  );

  assert.equal(resolution.decision, 'blocked-account-mismatch');
  assert.equal(resolution.modelId, null);
  assert.equal(resolution.requiresUserDecision, true);
});
