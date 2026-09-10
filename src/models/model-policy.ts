/**
 * Which model an agent runs on, and what happens when it cannot.
 *
 * Three rules are load-bearing and none of them changes because availability
 * became friendlier to read:
 *
 *  1. **FIXED.** An agent is bound to exactly one model. This module never
 *     returns a different one: `modelId` is either the assigned model or
 *     `null`. There is no "closest match".
 *  2. **Ceilings.** A ceiling caps the tier an assignment may reach. A model
 *     above it is refused, and a model whose tier we cannot establish is
 *     refused too - a ceiling that cannot be proven is not a ceiling.
 *  3. **No silent fallback.** A blocked assignment produces a decision, a
 *     message and `requiresUserDecision: true`. Substitution stays a recorded,
 *     user-visible act (`agent_invocations.substituted_for_agent_id` and
 *     `substitution_reason`), never something this function does on its own.
 *
 * The only thing that *did* change: `KNOWN_BUT_UNVERIFIED` no longer blocks.
 * Not having checked an account is not a reason to refuse to run.
 */

import { TIER_ORDER, findModel, canonicalModelId, type ModelTier } from './model-catalog.js';
import type { ModelStatus } from './model-types.js';

export interface ModelCeiling {
  /** The highest tier this assignment may use. */
  maxTier: ModelTier;
  /** Why the ceiling exists; shown when it blocks something. */
  note?: string;
}

/** One agent, one account, one model. */
export interface FixedModelAssignment {
  agentId: string;
  accountId: string;
  /** The single model this agent may use. Never substituted. */
  modelId: string;
  ceiling?: ModelCeiling;
}

export type ModelDecision =
  /** Confirmed for this account and inside the ceiling. */
  | 'allowed'
  /** Usable, and honestly not verified for this account yet. */
  | 'allowed-unverified'
  /** Evidence says this account cannot use it. */
  | 'blocked-unavailable'
  /** The model is above the assignment's ceiling. */
  | 'blocked-above-ceiling'
  /** The model's tier is unknown, so the ceiling cannot be honoured. */
  | 'blocked-unknown-tier'
  /** The status offered belongs to a different account. */
  | 'blocked-account-mismatch';

export interface ModelResolution {
  decision: ModelDecision;
  /** The assigned model, or `null`. Never any other model. */
  modelId: string | null;
  usable: boolean;
  /**
   * Always `null`. Present so the absence of a substitution is explicit in the
   * type, and so a future substitution has to be added deliberately.
   */
  substitutedModelId: null;
  /** True whenever the run must stop and ask instead of choosing for the user. */
  requiresUserDecision: boolean;
  message: string;
  remedy?: string;
  status: ModelStatus;
}

/**
 * Decides whether an agent may run on its fixed model.
 *
 * `status` must be the status of the same account the assignment names. Being
 * handed another account's status is treated as a blocking error rather than
 * quietly trusted: model access in one account proves nothing in another.
 */
export function resolveFixedModel(
  assignment: FixedModelAssignment,
  status: ModelStatus,
): ModelResolution {
  const modelId = canonicalModelId(assignment.modelId);

  if (status.accountId !== assignment.accountId || !sameId(status.modelId, modelId)) {
    return {
      decision: 'blocked-account-mismatch',
      modelId: null,
      usable: false,
      substitutedModelId: null,
      requiresUserDecision: true,
      message:
        `A disponibilidade apresentada é de ${status.accountId}/${status.modelId}, ` +
        `e não de ${assignment.accountId}/${modelId}. Disponibilidade não é transferível entre contas.`,
      remedy: 'Verificar modelos desta conta',
      status,
    };
  }

  if (assignment.ceiling) {
    const entry = findModel(modelId);
    if (!entry) {
      return {
        decision: 'blocked-unknown-tier',
        modelId: null,
        usable: false,
        substitutedModelId: null,
        requiresUserDecision: true,
        message:
          `Este agente tem um teto de ${assignment.ceiling.maxTier}, e o nível de ${modelId} ` +
          'não é conhecido, então o teto não pode ser garantido.',
        remedy: 'Escolher um modelo do catálogo ou remover o teto',
        status,
      };
    }
    if (TIER_ORDER[entry.tier] > TIER_ORDER[assignment.ceiling.maxTier]) {
      return {
        decision: 'blocked-above-ceiling',
        modelId: null,
        usable: false,
        substitutedModelId: null,
        requiresUserDecision: true,
        message:
          `${entry.displayName} está acima do teto deste agente (${assignment.ceiling.maxTier}).` +
          (assignment.ceiling.note ? ` ${assignment.ceiling.note}` : ''),
        remedy: 'Ajustar o teto ou escolher outro modelo',
        status,
      };
    }
  }

  if (status.availability === 'UNAVAILABLE') {
    return {
      decision: 'blocked-unavailable',
      modelId: null,
      usable: false,
      substitutedModelId: null,
      // Nothing is chosen in the user's place: they decide what runs instead.
      requiresUserDecision: true,
      message: `${status.displayName}: ${status.detail}`,
      remedy: 'Escolher outro modelo para este agente',
      status,
    };
  }

  if (status.availability === 'CONFIRMED_FOR_ACCOUNT') {
    return {
      decision: 'allowed',
      modelId,
      usable: true,
      substitutedModelId: null,
      requiresUserDecision: false,
      message: `${status.displayName}: ${status.detail}`,
      status,
    };
  }

  return {
    decision: 'allowed-unverified',
    modelId,
    usable: true,
    substitutedModelId: null,
    requiresUserDecision: false,
    message: `${status.displayName}: ${status.detail}`,
    remedy: 'Verificar modelos desta conta',
    status,
  };
}

/**
 * The record a substitution must carry to be allowed to happen at all.
 *
 * A fallback agent may only be used when the reason is written down: this is
 * what fills `agent_invocations.substituted_for_agent_id` and
 * `substitution_reason`. An empty reason is rejected, so "silently" is not one
 * of the ways a substitution can occur.
 */
export interface RecordedSubstitution {
  substitutedForAgentId: string;
  substitutionReason: string;
}

export function recordSubstitution(
  blocked: ModelResolution,
  fromAgentId: string,
  reason: string,
): RecordedSubstitution {
  if (blocked.usable) {
    throw new Error('refusing to record a substitution for an agent that can run as assigned');
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('a substitution without a recorded reason is a silent fallback');
  }
  return { substitutedForAgentId: fromAgentId, substitutionReason: trimmed };
}

function sameId(a: string, b: string): boolean {
  return canonicalModelId(a).toLowerCase() === canonicalModelId(b).toLowerCase();
}
