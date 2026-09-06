/**
 * Capability and reasoning tiers - the vocabulary the orchestrator and the
 * router share, and the only model-related words the loop's logic knows.
 *
 * No model name appears in routing logic. The orchestrator (Codex) says what
 * a delegation *needs* in these tiers; the router turns a tier into whatever
 * the worker's CLI accepts today, through the provider policy. When a vendor
 * renames a model, the policy changes; nothing here does.
 *
 * Tier names are internal. `MAX` in particular is never sent to a CLI as the
 * string "max": a provider resolver maps it to a value the CLI has declared.
 */

export const CAPABILITY_TIERS = ['FAST', 'BALANCED', 'STRONG', 'MAX'] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export const REASONING_TIERS = ['LOW', 'MEDIUM', 'HIGH', 'MAX'] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];

/** What the orchestrator asks for on one delegation. Tiers, never names. */
export interface WorkerRequirements {
  capability: CapabilityTier;
  reasoning: ReasoningTier;
  /** One line, for the record. Never chain-of-thought. */
  rationale?: string;
}

/** A decision that says nothing about the worker gets this. */
export const DEFAULT_REQUIREMENTS: Readonly<WorkerRequirements> = {
  capability: 'BALANCED',
  reasoning: 'MEDIUM',
};

/**
 * How the person wants the worker's model chosen for a project.
 *
 *  - `auto`     the router decides per delegation (default)
 *  - `speed`    auto, leaning one tier down when the task is plainly safe
 *  - `quality`  auto, leaning one tier up
 *  - `manual`   the model and reasoning the person typed, exactly
 */
export const WORKER_SELECTIONS = ['auto', 'speed', 'quality', 'manual'] as const;
export type WorkerSelection = (typeof WORKER_SELECTIONS)[number];

export function isCapabilityTier(value: unknown): value is CapabilityTier {
  return typeof value === 'string' && (CAPABILITY_TIERS as readonly string[]).includes(value);
}

export function isReasoningTier(value: unknown): value is ReasoningTier {
  return typeof value === 'string' && (REASONING_TIERS as readonly string[]).includes(value);
}

export function isWorkerSelection(value: unknown): value is WorkerSelection {
  return typeof value === 'string' && (WORKER_SELECTIONS as readonly string[]).includes(value);
}

/** The lowercase spelling used in the decision JSON (`"strong"`). */
export function capabilityFromWire(value: unknown): CapabilityTier | null {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return isCapabilityTier(upper) ? upper : null;
}

export function reasoningFromWire(value: unknown): ReasoningTier | null {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return isReasoningTier(upper) ? upper : null;
}

export function capabilityRank(tier: CapabilityTier): number {
  return CAPABILITY_TIERS.indexOf(tier);
}

export function reasoningRank(tier: ReasoningTier): number {
  return REASONING_TIERS.indexOf(tier);
}

/** One step up, capped at the top. */
export function promoteCapability(tier: CapabilityTier, steps = 1): CapabilityTier {
  const index = Math.min(CAPABILITY_TIERS.length - 1, Math.max(0, capabilityRank(tier) + steps));
  return CAPABILITY_TIERS[index]!;
}

export function promoteReasoning(tier: ReasoningTier, steps = 1): ReasoningTier {
  const index = Math.min(REASONING_TIERS.length - 1, Math.max(0, reasoningRank(tier) + steps));
  return REASONING_TIERS[index]!;
}

export function higherCapability(a: CapabilityTier, b: CapabilityTier): CapabilityTier {
  return capabilityRank(a) >= capabilityRank(b) ? a : b;
}

export function higherReasoning(a: ReasoningTier, b: ReasoningTier): ReasoningTier {
  return reasoningRank(a) >= reasoningRank(b) ? a : b;
}
