/**
 * The model router: one delegation in, one resolved model and reasoning out.
 *
 * Called once per worker invocation, never per project or per run. Its
 * inputs are the orchestrator's requirements for *this* task, what happened
 * on the previous attempts of *this* run, what the worker's CLI declared it
 * can take, and how the person asked models to be chosen. Its output is
 * recorded on the invocation, so "why this model?" is always answerable.
 *
 * Order of the decision:
 *
 *   1. manual selection → exactly what the person typed (validated)
 *   2. what the orchestrator asked, or the default when it said nothing
 *   3. sanity floor from the task text - promotion only, never demotion
 *   4. escalation from repeated no-progress attempts (not from mechanical
 *      failures); computed fresh each time, so it is not sticky
 *   5. the person's strategy: speed leans down on plainly safe tasks,
 *      quality leans up
 *   6. provider policy turns the tiers into a model and an effort the CLI
 *      declared; unavailable models are skipped; missing flags mean the
 *      value is simply not sent
 */

import {
  candidateSequence,
  resolveEffortForTier,
  resolveFixedEffort,
  type WorkerRuntimeCapabilities,
} from './provider-policy.js';
import type { RoutingProvider } from './provider-policy.js';
import { assessTask, isSensitive } from './task-assessment.js';
import {
  DEFAULT_REQUIREMENTS,
  higherCapability,
  higherReasoning,
  promoteCapability,
  promoteReasoning,
  type CapabilityTier,
  type ReasoningTier,
  type WorkerRequirements,
  type WorkerSelection,
} from './tiers.js';

/** One earlier worker attempt of the same run, as the router reads it. */
export interface PreviousAttempt {
  iteration: number;
  capability: CapabilityTier;
  reasoning: ReasoningTier;
  model: string | null;
  outcome: 'completed' | 'timeout' | 'cancelled' | 'spawn-error';
  exitCode: number | null;
  /** The working tree changed relative to the attempt before it. */
  progressed: boolean;
  /** A failure a better model would not fix (missing binary, login, quota). */
  mechanical: boolean;
  /** The CLI refused the model by name. */
  modelUnavailable: boolean;
}

export interface RouterInput {
  provider: RoutingProvider;
  accountId: string | null;
  task: string;
  /** The orchestrator's requirements for this delegation; null for a decision without them. */
  requested: WorkerRequirements | null;
  previousAttempts: readonly PreviousAttempt[];
  capabilities: WorkerRuntimeCapabilities;
  selection: WorkerSelection;
  /** The person's own choice, used only when `selection` is `manual`. */
  manual?: { model: string | null; reasoning: string | null };
  /** Models this run already found unavailable. */
  unavailableModels?: readonly string[];
}

export interface RouterOutput {
  /** What the decision asked for (or the default it fell back to). */
  requestedCapability: CapabilityTier;
  requestedReasoning: ReasoningTier;
  /** The tiers actually used, after the floor, escalation and strategy. */
  capability: CapabilityTier;
  reasoning: ReasoningTier;
  resolvedModel: string | null;
  resolvedReasoning: string | null;
  selectionMode: 'auto' | 'manual';
  /** One line a person can read. Never chain-of-thought. */
  selectionReason: string;
  fallbackUsed: boolean;
  /** Next models to try if the CLI refuses the resolved one, in order. */
  alternatives: string[];
}

export function routeWorkerModel(input: RouterInput): RouterOutput {
  const requested = input.requested ?? { ...DEFAULT_REQUIREMENTS };
  const reasons: string[] = [];
  let fallbackUsed = false;

  if (!input.requested) {
    reasons.push('decisão sem requisitos do worker; padrão BALANCED/MEDIUM');
  } else {
    reasons.push(
      `Codex pediu ${requested.capability}/${requested.reasoning}` +
        (requested.rationale ? ` (${requested.rationale.slice(0, 120)})` : ''),
    );
  }

  // 1. Manual: exactly what the person typed, checked against the CLI.
  if (input.selection === 'manual') {
    const model = input.capabilities.modelFlag ? input.manual?.model?.trim() || null : null;
    const effort = input.capabilities.effortFlag
      ? resolveFixedEffort(input.manual?.reasoning ?? null, input.capabilities.declaredEfforts)
      : { value: null, fallbackUsed: false, note: null };
    if (input.manual?.model && !input.capabilities.modelFlag) {
      fallbackUsed = true;
      reasons.push('o CLI não aceita --model; padrão do CLI');
    }
    if (effort.note) {
      fallbackUsed = true;
      reasons.push(effort.note);
    }
    reasons.unshift('seleção manual');
    return {
      requestedCapability: requested.capability,
      requestedReasoning: requested.reasoning,
      capability: requested.capability,
      reasoning: requested.reasoning,
      resolvedModel: model,
      resolvedReasoning: effort.value,
      selectionMode: 'manual',
      selectionReason: reasons.join('; '),
      fallbackUsed,
      alternatives: [],
    };
  }

  let capability = requested.capability;
  let reasoning = requested.reasoning;

  // 3. The floor: promotion only.
  const assessment = assessTask(input.task);
  const floored = higherCapability(capability, assessment.minimumCapability);
  const flooredReasoning = higherReasoning(reasoning, assessment.minimumReasoning);
  if (floored !== capability || flooredReasoning !== reasoning) {
    reasons.push(
      `promovido para ${floored}/${flooredReasoning} (${assessment.signals.join(', ')})`,
    );
  }
  capability = floored;
  reasoning = flooredReasoning;

  // 4. Escalation from the trailing streak of genuine no-progress attempts.
  const streak = noProgressStreak(input.previousAttempts);
  if (streak > 0) {
    const reasoningSteps = Math.min(streak, 2);
    const capabilitySteps = Math.min(Math.max(streak - 1, 0), 2);
    const escalated = promoteCapability(capability, capabilitySteps);
    const escalatedReasoning = promoteReasoning(reasoning, reasoningSteps);
    if (escalated !== capability || escalatedReasoning !== reasoning) {
      reasons.push(
        `escalado para ${escalated}/${escalatedReasoning} após ${streak} tentativa(s) sem progresso`,
      );
    }
    capability = escalated;
    reasoning = escalatedReasoning;
  }

  // 5. Strategy.
  if (input.selection === 'quality') {
    const up = promoteCapability(capability);
    const upReasoning = promoteReasoning(reasoning);
    if (up !== capability || upReasoning !== reasoning) reasons.push(`estratégia qualidade: ${up}/${upReasoning}`);
    capability = up;
    reasoning = upReasoning;
  } else if (input.selection === 'speed') {
    if (!isSensitive(assessment) && streak === 0) {
      const down = promoteCapability(capability, -1);
      const downReasoning = promoteReasoning(reasoning, -1);
      if (down !== capability || downReasoning !== reasoning) reasons.push(`estratégia velocidade: ${down}/${downReasoning}`);
      capability = down;
      reasoning = downReasoning;
    } else if (isSensitive(assessment)) {
      reasons.push('estratégia velocidade ignorada: tarefa sensível');
    }
  }

  // 6. Provider policy → CLI values.
  let resolvedModel: string | null = null;
  let alternatives: string[] = [];
  if (!input.capabilities.modelFlag) {
    fallbackUsed = true;
    reasons.push('o CLI não aceita --model; padrão do CLI');
  } else {
    const sequence = candidateSequence(input.provider, capability, input.unavailableModels ?? []);
    const first = sequence[0];
    if (!first) {
      fallbackUsed = true;
      reasons.push('nenhum modelo disponível na política; padrão do CLI');
    } else {
      resolvedModel = first.model;
      alternatives = sequence.slice(1).map((entry) => entry.model);
      if ((input.unavailableModels ?? []).length > 0) {
        fallbackUsed = true;
        reasons.push(`indisponível nesta execução: ${(input.unavailableModels ?? []).join(', ')}`);
      }
      if (first.tier !== capability) {
        fallbackUsed = true;
        reasons.push(`sem modelo ${capability} disponível; usando ${first.tier}`);
      }
      reasons.push(`modelo ${resolvedModel}`);
    }
  }

  let resolvedReasoning: string | null = null;
  if (!input.capabilities.effortFlag) {
    reasons.push('o CLI não aceita nível de raciocínio');
  } else {
    const effort = resolveEffortForTier(reasoning, input.capabilities.declaredEfforts);
    resolvedReasoning = effort.value;
    if (effort.fallbackUsed) fallbackUsed = true;
    reasons.push(effort.value ? `raciocínio ${effort.value}` : 'raciocínio: padrão do CLI');
    if (effort.note) reasons.push(effort.note);
  }

  return {
    requestedCapability: requested.capability,
    requestedReasoning: requested.reasoning,
    capability,
    reasoning,
    resolvedModel,
    resolvedReasoning,
    selectionMode: 'auto',
    selectionReason: reasons.join('; '),
    fallbackUsed,
    alternatives,
  };
}

/**
 * How many of the most recent attempts, counting back, ended without
 * progress for a reason a better model could fix. A mechanical failure or a
 * refused model breaks nothing and counts for nothing; progress resets it.
 */
export function noProgressStreak(attempts: readonly PreviousAttempt[]): number {
  let streak = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    if (attempt.mechanical || attempt.modelUnavailable || attempt.outcome === 'cancelled') continue;
    if (attempt.progressed) break;
    streak += 1;
  }
  return streak;
}

/** Exported for the loop's feedback line: "STRONG > BALANCED". */
export function describeTiers(capability: CapabilityTier, reasoning: ReasoningTier): string {
  return `${capability}/${reasoning}`;
}
