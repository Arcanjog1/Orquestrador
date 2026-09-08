/**
 * What one account is allowed to spend on, per account.
 *
 * ## The incident
 *
 * A run escalated the worker to the top tier. `CLAUDE_MODELS.MAX` lists
 * `fable` first and `CLAUDE_EFFORTS.MAX` lists `max` first, so the top tier
 * meant Fable at maximum effort - and the account answered:
 *
 *     You're out of usage credits.
 *
 * The subscription was not exhausted. The account simply had no extra credits
 * for that model, and nothing in the application knew that such a thing could
 * be true of one account and not another.
 *
 * ## What this adds
 *
 * A ceiling that belongs to the **account**, not to the application. Two
 * Claude accounts can have different ones, and neither is a global setting.
 * It is applied *before* a model is chosen, which is the whole point: trying
 * the premium model and reading the refusal afterwards is how a run finds out
 * by spending, and on a subscription that refusal costs an iteration.
 *
 * ## What "premium" means here, precisely
 *
 * `PREMIUM_MODELS` is a **policy list this application maintains**, not a
 * claim about how a vendor bills. It names the aliases that, on the account
 * this was written for, needed credits beyond ordinary subscription use. An
 * account that does have those credits turns the policy off and the list stops
 * applying to it. Nothing here reads a balance - no API reports one - so the
 * application never asserts that credits exist or do not.
 */

import {
  capabilityRank,
  reasoningRank,
  CAPABILITY_TIERS,
  REASONING_TIERS,
  type CapabilityTier,
  type ReasoningTier,
} from './tiers.js';

/**
 * Model aliases treated as needing credits beyond ordinary subscription use.
 *
 * Deliberately by alias, like the rest of the policy: an alias follows the
 * vendor's current model of that class, so this does not age with a release.
 */
export const PREMIUM_MODELS: ReadonlySet<string> = new Set(['fable']);

export function isPremiumModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && PREMIUM_MODELS.has(model.trim().toLowerCase());
}

export interface AccountRoutingPolicy {
  /** The strongest capability tier this account may use. Null: no ceiling. */
  readonly maxCapability: CapabilityTier | null;
  /** The strongest reasoning tier this account may use. Null: no ceiling. */
  readonly maxReasoning: ReasoningTier | null;
  /** Whether a model on the premium list may be chosen for this account. */
  readonly allowPremiumModels: boolean;
}

/**
 * What an account gets before anybody configures it.
 *
 * No tier ceiling - the router's own judgement is not overridden by default -
 * but premium models **off**. A default that could spend credits nobody
 * agreed to spend is not a safe default, and the person can turn it on per
 * account in one click.
 */
export const DEFAULT_ACCOUNT_POLICY: AccountRoutingPolicy = {
  maxCapability: null,
  maxReasoning: null,
  allowPremiumModels: false,
};

export interface CeilingResult {
  readonly capability: CapabilityTier;
  readonly reasoning: ReasoningTier;
  /** One line for the record when the ceiling changed something; else null. */
  readonly note: string | null;
}

/**
 * Clamps the tiers a delegation would use to what the account allows.
 *
 * Only ever downward - a ceiling is not a floor, so an account allowed MAX
 * never has a BALANCED task promoted to it.
 */
export function applyCeiling(
  capability: CapabilityTier,
  reasoning: ReasoningTier,
  policy: AccountRoutingPolicy,
): CeilingResult {
  const cappedCapability =
    policy.maxCapability && capabilityRank(capability) > capabilityRank(policy.maxCapability)
      ? policy.maxCapability
      : capability;
  const cappedReasoning =
    policy.maxReasoning && reasoningRank(reasoning) > reasoningRank(policy.maxReasoning)
      ? policy.maxReasoning
      : reasoning;

  if (cappedCapability === capability && cappedReasoning === reasoning) {
    return { capability, reasoning, note: null };
  }
  return {
    capability: cappedCapability,
    reasoning: cappedReasoning,
    note:
      `Solicitado ${capability}/${reasoning}; limitado a ${cappedCapability}/${cappedReasoning} ` +
      'pela política da conta',
  };
}

/** True when this policy would refuse this model outright. */
export function refusesModel(model: string, policy: AccountRoutingPolicy): boolean {
  return isPremiumModel(model) && !policy.allowPremiumModels;
}

/** The tiers as the interface spells them, so a screen never invents a label. */
export const CAPABILITY_LABELS: Readonly<Record<CapabilityTier, string>> = {
  FAST: 'Rápido',
  BALANCED: 'Equilibrado',
  STRONG: 'Forte',
  MAX: 'Máximo',
};

export const REASONING_LABELS: Readonly<Record<ReasoningTier, string>> = {
  LOW: 'Baixo',
  MEDIUM: 'Médio',
  HIGH: 'Alto',
  MAX: 'Máximo',
};

/** Reads a stored tier back, refusing anything that is not one. */
export function capabilityCeilingOf(value: unknown): CapabilityTier | null {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return (CAPABILITY_TIERS as readonly string[]).includes(upper) ? (upper as CapabilityTier) : null;
}

export function reasoningCeilingOf(value: unknown): ReasoningTier | null {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return (REASONING_TIERS as readonly string[]).includes(upper) ? (upper as ReasoningTier) : null;
}
