/**
 * "Verificar modelos desta conta".
 *
 * The action behind the button. It asks the runtime what *this* account can
 * use, with this account's configuration home, and writes down what it found.
 *
 * What it will not do:
 *
 *  - It will not answer for one account using another account's environment.
 *    Every invocation goes through `ClaudeAccountManager.buildEnvironment`, so
 *    the CLI reads exactly one profile, and the record is stamped with that
 *    account's id.
 *  - It will not turn silence into a denial. If no candidate command is
 *    understood, the outcome is `not-supported`, the detail says so in plain
 *    words, and nothing is marked unavailable.
 *  - It will not spend the user's quota on its own. The listing commands do not
 *    talk to a model. The one check that does - a minimal call - runs only when
 *    the caller passes explicit authorisation, and refuses otherwise.
 */

import { ProcessManager, type ProcessResult } from '../process/process-manager.js';
import type { ClaudeAccountManager } from '../accounts/claude-account-manager.js';
import type { Account } from '../accounts/account-types.js';
import type { RuntimeManager } from '../runtime/runtime-manager.js';
import { canonicalModelId } from './model-catalog.js';
import {
  ModelVerificationError,
  type AccountModelVerification,
  type ListingCompleteness,
} from './model-types.js';
import { InMemoryVerificationStore, type ModelVerificationStore } from './verification-store.js';

/**
 * A command that might report an account's models.
 *
 * These are *candidates*: the Claude Code CLI is not obliged to implement any
 * of them, and versions differ. Each is tried in order and a command that is
 * not understood costs one fast, harmless invocation. When none answers, that
 * is reported as a fact about the CLI, not about the account.
 */
export interface CapabilityProbe {
  id: string;
  args: string[];
  /** Shown in the evidence line, e.g. "claude models list --json". */
  label: string;
}

export const CLAUDE_MODEL_PROBES: CapabilityProbe[] = [
  { id: 'models-list', args: ['models', 'list', '--json'], label: 'claude models list --json' },
  { id: 'model-list', args: ['model', 'list', '--json'], label: 'claude model list --json' },
  {
    id: 'auth-entitlements',
    args: ['auth', 'status', '--json'],
    label: 'claude auth status --json',
  },
];

/** What a probe's payload said, once understood. */
export interface ParsedListing {
  confirmed: string[];
  denied: string[];
  completeness: ListingCompleteness;
}

export interface MinimalCallAuthorisation {
  /**
   * Must be `true`, and must come from the user having agreed to it. A minimal
   * call sends a request to the model and therefore consumes the account's
   * usage.
   */
  authorizedByUser: true;
  /** The models to check. Kept explicit so the cost is predictable. */
  modelIds: string[];
}

export interface VerifyOptions {
  minimalCall?: MinimalCallAuthorisation;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: Date;
}

export interface AccountModelVerifierOptions {
  runtimeManager: RuntimeManager;
  accounts: ClaudeAccountManager;
  processManager?: ProcessManager;
  store?: ModelVerificationStore;
  probes?: CapabilityProbe[];
}

export class AccountModelVerifier {
  private readonly runtimeManager: RuntimeManager;
  private readonly accounts: ClaudeAccountManager;
  private readonly processManager: ProcessManager;
  private readonly probes: CapabilityProbe[];
  readonly store: ModelVerificationStore;

  constructor(options: AccountModelVerifierOptions) {
    this.runtimeManager = options.runtimeManager;
    this.accounts = options.accounts;
    this.processManager = options.processManager ?? new ProcessManager();
    this.store = options.store ?? new InMemoryVerificationStore();
    this.probes = options.probes ?? CLAUDE_MODEL_PROBES;
  }

  /** The last recorded verification for an account, if any. */
  lastVerification(accountId: string): AccountModelVerification | null {
    return this.store.read(accountId);
  }

  /**
   * Checks one account, and only that account.
   *
   * The returned record is also written to the store, so the interface can
   * render it without running anything.
   */
  async verify(account: Account, options: VerifyOptions = {}): Promise<AccountModelVerification> {
    const checkedAt = (options.now ?? new Date()).toISOString();
    const base = { accountId: account.id, checkedAt };

    let executable: string;
    try {
      executable = await this.runtimeManager.getExecutablePath('claude-code');
    } catch {
      return this.remember({
        ...base,
        outcome: 'runtime-missing',
        method: 'none',
        confirmed: [],
        denied: [],
        completeness: 'none',
        detail:
          'O Claude Code ainda não está configurado, então não há como perguntar os modelos desta conta.',
      });
    }

    // Entitlement follows the credential. An account signed in through an
    // ambient credential would answer with somebody else's entitlement, so it
    // is refused rather than recorded under this account's name.
    const status = await this.accounts.getStatus(account);
    if (status.state !== 'connected') {
      return this.remember({
        ...base,
        outcome: 'account-not-connected',
        method: 'none',
        confirmed: [],
        denied: [],
        completeness: 'none',
        detail:
          status.state === 'ambient-credential'
            ? `${account.displayName} está usando uma credencial do sistema, então a resposta não seria desta conta.`
            : `${account.displayName} precisa estar conectada para que os modelos dela possam ser verificados.`,
      });
    }

    let failure: string | null = null;

    for (const probe of this.probes) {
      let result: ProcessResult;
      try {
        result = await this.run(executable, probe.args, account.id, options);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (result.outcome === 'cancelled') {
        return this.remember({
          ...base,
          outcome: 'failed',
          method: 'none',
          confirmed: [],
          denied: [],
          completeness: 'none',
          detail: 'A verificação foi cancelada.',
        });
      }
      if (result.outcome !== 'completed' || result.exitCode !== 0) {
        // A command this CLI does not implement is not a failure worth
        // reporting: the next candidate gets its turn.
        if (result.outcome === 'timeout') failure = `${probe.label} não respondeu a tempo.`;
        continue;
      }

      const parsed = parseListing(result.stdout);
      if (!parsed) continue;

      const record: AccountModelVerification = {
        ...base,
        outcome: 'verified',
        method: probe.id === 'auth-entitlements' ? 'provider-entitlement' : 'runtime-capabilities',
        confirmed: parsed.confirmed,
        denied: parsed.denied,
        completeness: parsed.completeness,
        detail:
          parsed.completeness === 'exhaustive'
            ? `${account.displayName} respondeu com a lista completa de modelos da conta.`
            : `${account.displayName} respondeu com os modelos que reconhece; a lista não se declara completa.`,
        source: probe.label,
      };
      return this.remember(
        options.minimalCall
          ? await this.withMinimalCall(executable, account, record, options)
          : record,
      );
    }

    const unsupported: AccountModelVerification = {
      ...base,
      outcome: failure ? 'failed' : 'not-supported',
      method: 'none',
      confirmed: [],
      denied: [],
      completeness: 'none',
      detail:
        failure ??
        'O Claude Code instalado não expõe os modelos nem os direitos de acesso da conta. ' +
          'Nenhum modelo foi marcado como indisponível por causa disso.',
    };

    return this.remember(
      options.minimalCall
        ? await this.withMinimalCall(executable, account, unsupported, options)
        : unsupported,
    );
  }

  /**
   * The opt-in check: one minimal request per model, on this account.
   *
   * This is the only path in the module that spends the user's usage, so it
   * demands the authorisation in the type *and* checks it at runtime.
   */
  private async withMinimalCall(
    executable: string,
    account: Account,
    record: AccountModelVerification,
    options: VerifyOptions,
  ): Promise<AccountModelVerification> {
    const authorisation = options.minimalCall;
    if (!authorisation) return record;
    if (authorisation.authorizedByUser !== true) {
      throw new ModelVerificationError(
        account.id,
        'Uma chamada de verificação consome uso da sua conta.',
        'Autorizar a chamada mínima',
        'minimal call attempted without explicit user authorisation',
      );
    }

    const confirmed = new Set(record.confirmed.map(canonicalModelId));
    const denied = new Set(record.denied.map(canonicalModelId));
    let attempted = 0;
    let inconclusive = 0;

    for (const raw of authorisation.modelIds) {
      const modelId = canonicalModelId(raw);
      attempted += 1;
      let result: ProcessResult;
      try {
        // The prompt goes over stdin, like every other prompt in this project.
        result = await this.run(executable, ['-p', '--model', modelId], account.id, options, 'ok');
      } catch {
        inconclusive += 1;
        continue;
      }
      if (result.outcome === 'completed' && result.exitCode === 0) {
        confirmed.add(modelId);
        denied.delete(modelId);
        continue;
      }
      if (looksLikeModelRefusal(`${result.stdout}\n${result.stderr}`)) {
        denied.add(modelId);
        confirmed.delete(modelId);
        continue;
      }
      // Anything else - a timeout, a network error, an unrecognised failure -
      // proves nothing about entitlement and is left unverified.
      inconclusive += 1;
    }

    const detail =
      inconclusive > 0
        ? `${record.detail} Chamada mínima: ${attempted - inconclusive} de ${attempted} modelo(s) verificados; o restante ficou sem conclusão.`
        : `${record.detail} Chamada mínima concluída para ${attempted} modelo(s).`;

    const conclusive = attempted - inconclusive;

    return {
      ...record,
      // A call that concluded is evidence; a run of inconclusive ones leaves
      // the previous outcome - and its explanation - exactly as it was.
      outcome: conclusive > 0 ? 'verified' : record.outcome,
      method: conclusive > 0 ? 'minimal-call' : record.method,
      confirmed: [...confirmed],
      denied: [...denied],
      // A handful of individual calls never adds up to a complete listing.
      completeness: record.completeness === 'exhaustive' ? 'exhaustive' : 'partial',
      detail,
      source: record.source ? `${record.source} + chamada mínima` : 'chamada mínima',
    };
  }

  private run(
    executable: string,
    args: string[],
    accountId: string,
    options: VerifyOptions,
    stdin?: string,
  ): Promise<ProcessResult> {
    return this.processManager.run({
      command: executable,
      args,
      cwd: this.runtimeManager.paths.root,
      env: this.accounts.buildEnvironment(accountId),
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(stdin ? { stdin } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  private remember(record: AccountModelVerification): AccountModelVerification {
    this.store.write(record);
    return record;
  }
}

/**
 * Reads a model listing, in any of the shapes a CLI plausibly prints.
 *
 * Returns `null` when the payload is not a model listing at all - that is how a
 * command that answered something else is told apart from one that answered
 * "no models", and it is why an unrecognised output never becomes a denial.
 *
 * A listing counts as *exhaustive* only when it says so: `complete: true`, or a
 * scope of `account`. Absence of a model in a listing that makes no such claim
 * means nothing, and is treated as meaning nothing.
 */
export function parseListing(stdout: string): ParsedListing | null {
  const payload = parseJson(stdout);
  if (payload === null || typeof payload !== 'object') return null;

  const container = payload as Record<string, unknown>;
  const entries = Array.isArray(payload)
    ? payload
    : firstArray(container, ['models', 'availableModels', 'data', 'entitlements']);
  if (!entries) return null;

  const confirmed: string[] = [];
  const denied: string[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      confirmed.push(canonicalModelId(entry));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    const id = firstString(model, ['id', 'model', 'modelId', 'name']);
    if (!id) continue;
    const available = firstBoolean(model, ['available', 'entitled', 'allowed', 'enabled']);
    if (available === false) denied.push(canonicalModelId(id));
    else confirmed.push(canonicalModelId(id));
  }

  if (confirmed.length === 0 && denied.length === 0) return null;

  const scope = Array.isArray(payload) ? undefined : firstString(container, ['scope']);
  const complete = Array.isArray(payload)
    ? undefined
    : firstBoolean(container, ['complete', 'exhaustive']);
  const exhaustive = complete === true || scope?.toLowerCase() === 'account';

  return {
    confirmed,
    denied,
    completeness: exhaustive ? 'exhaustive' : 'partial',
  };
}

/**
 * Whether output means "this account cannot use that model".
 *
 * Deliberately narrow. Anything that is merely a failure - a network error, a
 * rate limit, a crash - must not be read as a denial.
 */
export function looksLikeModelRefusal(output: string): boolean {
  return [
    /model[^\n]{0,40}\b(not|isn't|is not)\b[^\n]{0,40}\b(available|allowed|enabled|permitted)\b/i,
    /\b(do(es)? not have|no)\b[^\n]{0,30}\baccess\b[^\n]{0,30}\bmodel\b/i,
    /\b(unknown|invalid|unsupported|unrecognized|unrecognised)\b[^\n]{0,20}\bmodel\b/i,
    /\bmodelo\b[^\n]{0,40}\b(indisponível|não disponível|não permitido)\b/i,
    /\bnot_?entitled\b|\bmodel_?not_?available\b/i,
  ].some((pattern) => pattern.test(output));
}

function firstArray(source: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstBoolean(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** Finds the first balanced JSON value; CLI output is often multi-line. */
function parseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const opener = text[start];
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
