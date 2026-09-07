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
export const CAPABILITY_TIERS = ['FAST', 'BALANCED', 'STRONG', 'MAX'];
export const REASONING_TIERS = ['LOW', 'MEDIUM', 'HIGH', 'MAX'];
/** A decision that says nothing about the worker gets this. */
export const DEFAULT_REQUIREMENTS = {
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
export const WORKER_SELECTIONS = ['auto', 'speed', 'quality', 'manual'];
export function isCapabilityTier(value) {
    return typeof value === 'string' && CAPABILITY_TIERS.includes(value);
}
export function isReasoningTier(value) {
    return typeof value === 'string' && REASONING_TIERS.includes(value);
}
export function isWorkerSelection(value) {
    return typeof value === 'string' && WORKER_SELECTIONS.includes(value);
}
/** The lowercase spelling used in the decision JSON (`"strong"`). */
export function capabilityFromWire(value) {
    const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return isCapabilityTier(upper) ? upper : null;
}
export function reasoningFromWire(value) {
    const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return isReasoningTier(upper) ? upper : null;
}
export function capabilityRank(tier) {
    return CAPABILITY_TIERS.indexOf(tier);
}
export function reasoningRank(tier) {
    return REASONING_TIERS.indexOf(tier);
}
/** One step up, capped at the top. */
export function promoteCapability(tier, steps = 1) {
    const index = Math.min(CAPABILITY_TIERS.length - 1, Math.max(0, capabilityRank(tier) + steps));
    return CAPABILITY_TIERS[index];
}
export function promoteReasoning(tier, steps = 1) {
    const index = Math.min(REASONING_TIERS.length - 1, Math.max(0, reasoningRank(tier) + steps));
    return REASONING_TIERS[index];
}
export function higherCapability(a, b) {
    return capabilityRank(a) >= capabilityRank(b) ? a : b;
}
export function higherReasoning(a, b) {
    return reasoningRank(a) >= reasoningRank(b) ? a : b;
}
//# sourceMappingURL=tiers.js.map