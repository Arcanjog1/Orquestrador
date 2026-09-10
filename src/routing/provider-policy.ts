/**
 * Provider policy: how a capability or reasoning tier becomes a value a
 * specific CLI accepts.
 *
 * This is the one place model names and effort spellings live. It is
 * versioned so a run's record can say which policy chose its model, and it
 * is consulted last: what the CLI itself declares (`--help`) comes first,
 * this table fills what the CLI does not say, and nothing is guessed beyond
 * it. An unknown value on either side degrades to a safe choice; it never
 * throws.
 */

import { compareVersions, parseVersion } from '../runtime/version.js';
import {
  CAPABILITY_TIERS,
  capabilityRank,
  type CapabilityTier,
  type ReasoningTier,
} from './tiers.js';

export const ROUTING_POLICY_VERSION = 1;

export type RoutingProvider = 'anthropic' | 'openai';

/**
 * What the worker's CLI, as installed for one account, can take.
 *
 * Read from the binary (`--help`, `--version`) by the adapter, never assumed.
 * `null` in a "declared" field means the help page did not say - not that
 * the CLI supports nothing.
 */
export interface WorkerRuntimeCapabilities {
  /** The CLI accepts `--model`. */
  modelFlag: boolean;
  /** The CLI accepts an effort flag (`--effort`) or the equivalent config key. */
  effortFlag: boolean;
  /** Model aliases the help page names, when it names any. */
  declaredModels: readonly string[] | null;
  /** False for a partial cache/catalog: omission is not proof of lack of support. */
  declaredModelsComplete?: boolean;
  /** Effort values the help page names, when it names any. */
  declaredEfforts: readonly string[] | null;
  modelEfforts?: Readonly<Record<string, readonly string[]>>;
  version?: string | null;
}

/**
 * Model candidates per tier, best first.
 *
 * Aliases where the CLI offers them (`sonnet`, `opus`, ...): an alias follows
 * the vendor's current model of that class, so the policy does not age with
 * every release. A candidate the CLI refuses is skipped for the rest of the
 * run and the next one is tried - see the router's fallback.
 */
const CLAUDE_MODELS: Readonly<Record<CapabilityTier, readonly string[]>> = {
  FAST: ['haiku', 'sonnet'],
  BALANCED: ['sonnet'],
  STRONG: ['opus'],
  MAX: ['fable', 'opus'],
};

/**
 * Effort spellings per reasoning tier, preferred first.
 *
 * The internal `MAX` tier prefers the CLI's `max`, but only when the CLI has
 * *declared* it; otherwise the strongest declared value stands in. A value
 * the CLI never mentioned is not sent - that is the incident this policy
 * exists to prevent.
 */
const CLAUDE_EFFORTS: Readonly<Record<ReasoningTier, readonly string[]>> = {
  LOW: ['low'],
  MEDIUM: ['medium'],
  HIGH: ['high'],
  MAX: ['max', 'xhigh', 'high'],
};

/** Efforts every supported CLI takes by that name; safe when the help is silent. */
const UNIVERSAL_EFFORTS: readonly string[] = ['low', 'medium', 'high'];

/** Effort values in ascending strength, for "the strongest supported below X". */
export const EFFORT_ORDER: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface ResolvedValue {
  value: string | null;
  fallbackUsed: boolean;
  /** Why the value differs from the tier's first choice; null when it does not. */
  note: string | null;
}

/**
 * Every model the policy would try for a tier, in order: the tier's own
 * candidates, then the tiers above it (a stronger model is a safe stand-in),
 * then the tiers below. Models the run already found unavailable are left
 * out. Empty when the provider has no table or nothing is left.
 */
export function candidateSequence(
  provider: RoutingProvider,
  tier: CapabilityTier,
  unavailable: readonly string[] = [],
  /**
   * Models the account's policy refuses.
   *
   * Applied here rather than after resolution on purpose: the incident this
   * exists for is a run that chose the premium model, sent it, and learned
   * from the refusal - "You're out of usage credits" - that the account could
   * not use it. A candidate the account will not accept must never be first.
   */
  refused: (model: string) => boolean = () => false,
): Array<{ model: string; tier: CapabilityTier }> {
  const table = provider === 'anthropic' ? CLAUDE_MODELS : null;
  if (!table) return [];
  const own = capabilityRank(tier);
  const ranks = [own];
  for (let rank = own + 1; rank < CAPABILITY_TIERS.length; rank += 1) ranks.push(rank);
  for (let rank = own - 1; rank >= 0; rank -= 1) ranks.push(rank);
  const out: Array<{ model: string; tier: CapabilityTier }> = [];
  for (const rank of ranks) {
    const at = CAPABILITY_TIERS[rank]!;
    for (const model of table[at]) {
      if (unavailable.includes(model) || out.some((entry) => entry.model === model)) continue;
      if (refused(model)) continue;
      out.push({ model, tier: at });
    }
  }
  return out;
}

/**
 * The effort value for a reasoning tier on a CLI that declared `declared`
 * (or nothing, when null).
 */
export function resolveEffortForTier(
  tier: ReasoningTier,
  declared: readonly string[] | null,
): ResolvedValue {
  const preferences = CLAUDE_EFFORTS[tier];
  const accepted = declared ?? UNIVERSAL_EFFORTS;
  const first = preferences[0]!;
  for (const candidate of preferences) {
    if (accepted.includes(candidate)) {
      return candidate === first
        ? { value: candidate, fallbackUsed: false, note: null }
        : {
            value: candidate,
            fallbackUsed: true,
            note: `"${first}" não é declarado pelo CLI; usando "${candidate}"`,
          };
    }
  }
  return { value: null, fallbackUsed: true, note: 'o CLI não declara nenhum nível compatível' };
}

/**
 * A fixed effort the person chose, validated against what the CLI supports.
 *
 * Unsupported means the strongest supported value below it, and a note the
 * interface shows verbatim: "Este nível não é suportado pela versão atual."
 */
export function resolveFixedEffort(
  saved: string | null | undefined,
  supported: readonly string[] | null,
): ResolvedValue {
  if (!saved) return { value: null, fallbackUsed: false, note: null };
  const accepted = supported ?? UNIVERSAL_EFFORTS;
  if (accepted.includes(saved)) return { value: saved, fallbackUsed: false, note: null };
  const start = EFFORT_ORDER.indexOf(saved);
  for (let index = (start >= 0 ? start : EFFORT_ORDER.length) - 1; index >= 0; index -= 1) {
    const candidate = EFFORT_ORDER[index]!;
    if (accepted.includes(candidate)) {
      return {
        value: candidate,
        fallbackUsed: true,
        note: `Este nível não é suportado pela versão atual. Usando "${candidate}" no lugar de "${saved}".`,
      };
    }
  }
  return {
    value: null,
    fallbackUsed: true,
    note: `Este nível não é suportado pela versão atual. Usando o padrão do CLI no lugar de "${saved}".`,
  };
}

/**
 * The reasoning efforts a Codex CLI of `version` deserialises.
 *
 * From `codex-rs/protocol/src/openai_models.rs`: before rust-v0.140.0 the
 * enum is closed at `xhigh`; 0.140.0 adds `max`; 0.145.0 adds a custom
 * variant that accepts any string. Unknown version → null (the universal
 * set is used).
 */
export function codexSupportedEfforts(version: string | null | undefined): readonly string[] | null {
  if (!version || !parseVersion(version)) return null;
  const base = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  return compareVersions(version, '0.140.0') >= 0 ? [...base, 'max'] : base;
}

/** Application capability classification. Unknown names require a policy update. */
export function modelCapability(provider: RoutingProvider, model: string): CapabilityTier | null {
  const name = model.trim().toLowerCase();
  if (provider === 'anthropic') {
    if (/^(?:claude-)?haiku(?:-|$)/.test(name)) return 'FAST';
    if (/^(?:claude-)?sonnet(?:-|$)/.test(name)) return 'BALANCED';
    if (/^(?:claude-)?opus(?:-|$)/.test(name)) return 'STRONG';
    if (/^(?:claude-)?fable(?:-|$)/.test(name)) return 'MAX';
  }
  if (provider === 'openai') {
    if (['gpt-5.1-codex-mini', 'gpt-5-mini'].includes(name)) return 'FAST';
    if (['gpt-5.1-codex', 'gpt-5-codex'].includes(name)) return 'BALANCED';
    if (['gpt-5.1-codex-max', 'gpt-5.2-codex', 'gpt-5.3-codex'].includes(name)) return 'STRONG';
  }
  return null;
}
