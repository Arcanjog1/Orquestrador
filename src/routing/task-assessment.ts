/**
 * The router's sanity checks on a delegation.
 *
 * The orchestrator decides the tier; this module never decides *down*. What
 * it does is read the task for signals that an underestimated request would
 * be dangerous - a schema migration asked for at FAST, say - and set a floor.
 * It also classifies how a previous attempt ended, so the loop escalates on
 * genuine no-progress and not on a missing binary or an expired login.
 */

import type { CapabilityTier, ReasoningTier } from './tiers.js';
import { higherCapability, higherReasoning, promoteCapability, promoteReasoning } from './tiers.js';

export interface TaskAssessment {
  minimumCapability: CapabilityTier;
  minimumReasoning: ReasoningTier;
  /** Human-readable labels of the signals that set the floor. */
  signals: string[];
}

interface Signal {
  pattern: RegExp;
  capability: CapabilityTier;
  reasoning: ReasoningTier;
  label: string;
}

/** Signals with their floors. Two different signals raise the floor one more step. */
const SIGNALS: readonly Signal[] = [
  {
    pattern: /\b(migra[çc][aã]o|migrations?|schema|esquema|banco de dados|database|tabelas?\b.*\b(alterar|drop|apagar)|drop table|alter table)\b/i,
    capability: 'STRONG',
    reasoning: 'HIGH',
    label: 'altera esquema ou banco de dados',
  },
  {
    pattern: /\b(auth|autentica[çc][aã]o|credenc|credential|token|secret|segredo|senha|password|permiss[õo]|permission|security|seguran[çc]a|vulnerab|crypt)/i,
    capability: 'STRONG',
    reasoning: 'HIGH',
    label: 'toca autenticação, segredos ou segurança',
  },
  {
    pattern: /\b(concorr[êe]ncia|concurren|race condition|deadlock|thread|mutex|memory leak|vazamento de mem[óo]ria|intermitent|intermittent|flaky)\b/i,
    capability: 'STRONG',
    reasoning: 'HIGH',
    label: 'concorrência ou falha intermitente',
  },
  {
    pattern: /\b(m[úu]ltiplos m[óo]dulos|v[áa]rios m[óo]dulos|multi-?module|across modules|entre m[óo]dulos|root cause|causa raiz|depura[çc][aã]o|debug)\b/i,
    capability: 'STRONG',
    reasoning: 'HIGH',
    label: 'depuração entre módulos',
  },
  {
    pattern: /\b(arquitetur|architectur|redesign|redesenh|reescrever|rewrite|refatora[çc][aã]o (ampla|geral)|large refactor|core do sistema)\b/i,
    capability: 'STRONG',
    reasoning: 'HIGH',
    label: 'mudança de arquitetura',
  },
  {
    pattern: /\b(cr[íi]tic[ao]s?|critical|produ[çc][aã]o|production|pagamento|payment|billing|perda de dados|data loss|irrevers[íi]vel|irreversible|apagar tudo|delete all|rm -rf)\b/i,
    capability: 'STRONG',
    reasoning: 'HIGH',
    label: 'impacto crítico ou irreversível',
  },
];

/**
 * Lines that tell the worker what *not* to do, or describe a previous
 * failure, rather than describing the work.
 *
 * Measured, not imagined: a delegation to create one file escalated to the
 * top tier because the orchestrator's re-delegation said "diagnostique a falha
 * de permissão" and "não contorne permissões". Both mention permissions;
 * neither makes creating a file a security task. Reading a prohibition as a
 * requirement is how a trivial job ends up on the most expensive model, which
 * then cannot fix it either, because the failure was mechanical.
 */
const NOT_THE_WORK =
  /^\s*(?:[-*\d.)\s]*)?(?:n[ãa]o\b|nunca\b|evite\b|do not\b|don't\b|never\b|avoid\b)/i;

/**
 * Phrases that describe a failure being reported, not work being requested.
 *
 * "the previous attempt was denied permission" is a diagnosis handed to the
 * worker. It is context, and treating context as scope is what inflated the
 * tier.
 */
const REPORTED_FAILURE =
  /\b(?:falh(?:a|ou|as)|erro|error|failed|failure|recusad|denied|bloqueio|blocked|diagn[óo]stic|diagnos)\b/i;

/**
 * The task text with the lines that are not the work removed.
 *
 * Exported so a test can show exactly what the assessment reads, because the
 * difference between "creates a file" and "changes authentication" is the
 * whole reason a run costs cents or dollars.
 */
export function workLines(task: string): string {
  return task
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !NOT_THE_WORK.test(line))
    .join('\n');
}

export function assessTask(task: string): TaskAssessment {
  let capability: CapabilityTier = 'FAST';
  let reasoning: ReasoningTier = 'LOW';
  const signals: string[] = [];
  const work = workLines(task);
  for (const signal of SIGNALS) {
    if (!signal.pattern.test(work)) continue;
    // A signal that only appears where a failure is being described is
    // context about the last attempt, not the scope of this one.
    if (onlyInReportedFailure(work, signal.pattern)) continue;
    signals.push(signal.label);
    capability = higherCapability(capability, signal.capability);
    reasoning = higherReasoning(reasoning, signal.reasoning);
  }
  // Two independent reasons to be careful are more than one: a "critical
  // architecture change" is not merely an architecture change.
  if (signals.length >= 2) {
    capability = promoteCapability(capability);
    reasoning = promoteReasoning(reasoning);
  }
  return { minimumCapability: capability, minimumReasoning: reasoning, signals };
}

/**
 * True when every line carrying the signal is also describing a failure.
 *
 * One line saying "the write was denied" does not make this a security task.
 * A line saying "add authentication to the API" does, and that line contains
 * no failure vocabulary, so it still counts.
 */
function onlyInReportedFailure(work: string, pattern: RegExp): boolean {
  const carrying = work.split(/\r?\n/).filter((line) => pattern.test(line));
  if (carrying.length === 0) return false;
  return carrying.every((line) => REPORTED_FAILURE.test(line));
}

/** True when the signals say the task must not be run cheaper than asked. */
export function isSensitive(assessment: TaskAssessment): boolean {
  return assessment.signals.length > 0;
}

export interface AttemptOutcome {
  outcome: 'completed' | 'timeout' | 'cancelled' | 'spawn-error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The classified failure, when the adapter produced one. */
  failure?: string;
}

/**
 * Failures a better model cannot fix, by name.
 *
 * Each of these is about the world the agent is running in - a permission it
 * was refused, a person who must approve, a folder that cannot be written, a
 * workspace nothing can observe. Spending a stronger model on any of them
 * buys nothing and costs more.
 */
const MECHANICAL_FAILURES: ReadonlySet<string> = new Set([
  'tool-permission-denied',
  'approval-required',
  'workspace-invalid',
  'evidence-unavailable',
  'authentication',
  'permission',
  'insufficient-credit',
  'rate-limit',
  'network',
  'timeout',
]);

/**
 * A failure a stronger model would not fix: the binary is missing, the
 * login expired, the quota ran out, the network is down. Escalating on these
 * would spend a better model on the same wall.
 */
export function isMechanicalFailure(result: AttemptOutcome): boolean {
  // The agent's own classification wins when it made one: it knows a refused
  // tool for what it is, and no stronger model can be given the permission it
  // was denied. Escalating here is how a run climbs to the top tier and stops
  // anyway, which is exactly what happened before this check existed.
  if (result.failure && MECHANICAL_FAILURES.has(result.failure)) return true;
  if (result.outcome === 'spawn-error') return true;
  if (result.outcome === 'completed' && result.exitCode === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  return /\b(ENOENT|EACCES|ECONN\w*|ETIMEDOUT|EAI_AGAIN|command not found|n[ãa]o (foi )?encontrad|not logged in|please (log ?in|run \/login)|login required|authentication|unauthori[sz]ed|invalid api key|forbidden|rate.?limit|usage limit|quota|overloaded|permission denied|network|proxy|certificate)\b/i.test(
    text,
  );
}

/**
 * True when the CLI refused the model it was given, by name. The router's
 * fallback replaces the model; nothing else about the attempt is changed.
 */
export function modelUnavailableIn(result: AttemptOutcome): boolean {
  if (result.outcome === 'completed' && result.exitCode === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  return /(?:model|modelo)[^\n]{0,80}\b(?:not (?:found|available|supported)|does not exist|unknown|invalid|unavailable|n[ãa]o (?:existe|dispon[íi]vel|suportad))|\b(?:unknown|invalid|unsupported|unrecognized|no such) model\b|not_found_error[^\n]{0,120}model/i.test(
    text,
  );
}
