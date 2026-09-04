/**
 * Real run data, in the shape the approved timeline draws.
 *
 * `TimelineEntry` is the prototype's discriminated union, unchanged - the
 * Timeline component still renders exactly the same cards. What changed is
 * where the entries come from: the prototype generated them on a timer; these
 * are built from the chat messages the orchestration service persisted and the
 * run's own status and iteration count.
 *
 * Two rules run through the whole file:
 *   - a number that was not measured is not shown;
 *   - a card that has no data is not emitted at all.
 */

import type { ChatMessageView, RunView } from '@shared/ipc-contract';
import type { Agent, Provider, RunState } from './orchestrator-data';

export type Check = { label: string; passed: boolean };

export type TimelineEntry =
  | { kind: 'user'; id: string; text: string; time: string }
  | {
      kind: 'agent';
      id: string;
      agent: Agent;
      duration: string;
      headline: string;
      lines: string[];
      stats?: { label: string; value: string }[];
      detail?: boolean;
      running?: boolean;
    }
  | { kind: 'verification'; id: string; checks: Check[]; testsPassed: number; testsTotal: number }
  | {
      kind: 'evidence';
      id: string;
      filesChanged: number;
      additions: number;
      deletions: number;
      head: string;
    }
  | { kind: 'iteration'; id: string; index: number }
  | {
      kind: 'humanReview';
      id: string;
      reason: string;
      reasonKind: string;
      progress: string[];
      recommendation: string;
      options: string[];
    }
  | { kind: 'doneGate'; id: string; checks: Check[] }
  | {
      kind: 'done';
      id: string;
      objective: string;
      result: string;
      iterations: number;
      time: string;
      files: string;
      diff: string;
      tests: string;
      criteria: string;
      branch: string;
    }
  | { kind: 'cancelled'; id: string; summary: string[] }
  | { kind: 'noProgress'; id: string; detail: string }
  | { kind: 'paused'; id: string; iteration: number };

// -- Run state --------------------------------------------------------------

/**
 * The design speaks fourteen states; the run record stores five.
 *
 * The missing detail is not invented - it comes from the live
 * `run:progress` stage the orchestration service already emits, which names
 * exactly which leg of the loop is executing. With no live stage, a running
 * run falls back to the honest generic.
 */
const STAGE_STATE: Record<string, RunState> = {
  analysing: 'PLANNING',
  orchestrator: 'PLANNING',
  worker: 'WORKER_RUNNING',
  evidence: 'COLLECTING_EVIDENCE',
  verification: 'VERIFYING',
  review: 'REVIEWING',
  done: 'DONE',
  failed: 'FAILED',
  blocked: 'NEEDS_HUMAN',
  cancelled: 'CANCELLED',
};

export function runStateOf(run: RunView | null, liveStage: string | null): RunState {
  if (!run) return 'IDLE';
  switch (run.status) {
    case 'DONE':
      return 'DONE';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'PENDING':
      return 'PLANNING';
    case 'RUNNING':
      return (liveStage && STAGE_STATE[liveStage]) || 'WORKER_RUNNING';
    default:
      return 'IDLE';
  }
}

// -- Formatting -------------------------------------------------------------

export function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function spanBetween(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  return formatDuration(end - start);
}

export function elapsedSeconds(startIso: string, endIso: string | null): number {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 1000);
}

// -- Message author -> agent identity ---------------------------------------

/**
 * Who each chat author is, for the agent card.
 *
 * The names and providers are the roles the orchestration service actually
 * uses; model and reasoning stay null because a chat message does not carry
 * them, and the card omits a badge it has no value for.
 */
export function agentOfAuthor(author: string, agents: AgentIdentitySource): Agent | null {
  if (author === 'orchestrator') {
    return {
      role: 'ORCHESTRATOR',
      provider: 'openai' as Provider,
      agent: agents.orchestratorName ?? 'Codex',
      account: agents.orchestratorAccount,
      model: null,
      reasoning: null,
    };
  }
  if (author === 'worker') {
    return {
      role: 'CODING WORKER',
      provider: 'anthropic' as Provider,
      agent: agents.workerName ?? 'Claude',
      account: agents.workerAccount,
      model: null,
      reasoning: null,
    };
  }
  return null;
}

export interface AgentIdentitySource {
  orchestratorName: string | null;
  orchestratorAccount: string | null;
  workerName: string | null;
  workerAccount: string | null;
}

// -- The builder ------------------------------------------------------------

/** Messages the loop emits as plain status lines rather than agent output. */
const SYSTEM_PREFIX = /^(Baseline|Evidência|Evidencia|Verificaç|Verificac|Nenhuma)/i;

export interface TimelineInput {
  messages: readonly ChatMessageView[];
  run: RunView | null;
  agents: AgentIdentitySource;
  /** Branch of the working copy, for the done card. Null when git cannot say. */
  branch: string | null;
  liveStage: string | null;
}

/**
 * Builds the timeline for one chat session.
 *
 * Order follows the persisted history, which is already the order the loop
 * produced: user objective, then each agent's turn, then the terminal card for
 * whatever the run's real status is.
 */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const { messages, run, agents, branch, liveStage } = input;
  const entries: TimelineEntry[] = [];

  for (const message of messages) {
    if (message.author === 'user') {
      entries.push({
        kind: 'user',
        id: message.id,
        text: message.text,
        time: clockTime(message.createdAt),
      });
      continue;
    }

    const agent = agentOfAuthor(message.author, agents);
    if (agent) {
      const [headline, ...rest] = message.text.split('\n');
      entries.push({
        kind: 'agent',
        id: message.id,
        agent,
        duration: '—',
        headline: headline ?? message.text,
        lines: rest.filter((l) => l.trim().length > 0),
        detail: true,
      });
      continue;
    }

    // author === 'system': the loop's own notes about evidence and checks.
    if (SYSTEM_PREFIX.test(message.text)) {
      entries.push({
        kind: 'agent',
        id: message.id,
        agent: {
          role: 'SYSTEM',
          provider: 'github' as Provider,
          agent: 'Orquestrador',
          account: null,
          model: null,
          reasoning: null,
        },
        duration: '—',
        headline: message.text.split('\n')[0] ?? message.text,
        lines: message.text.split('\n').slice(1).filter((l) => l.trim().length > 0),
      });
    }
  }

  // The real iteration count from the run, never a counter of our own.
  if (run && run.iterations > 0) {
    entries.push({ kind: 'iteration', id: `${run.id}-it`, index: run.iterations });
  }

  const terminal = terminalEntry(run, branch, liveStage);
  if (terminal) entries.push(terminal);

  return entries;
}

function terminalEntry(
  run: RunView | null,
  branch: string | null,
  liveStage: string | null,
): TimelineEntry | null {
  if (!run) return null;

  if (run.status === 'DONE') {
    return {
      kind: 'done',
      id: `${run.id}-done`,
      objective: run.summary ?? 'Tarefa concluída.',
      result: run.summary ?? 'Verificado pelo Done Gate.',
      iterations: run.iterations,
      time: spanBetween(run.startedAt, run.finishedAt),
      // The application does not surface these per-run yet; an em dash is the
      // honest answer, and the design already lays them out that way.
      files: '—',
      diff: '—',
      tests: '—',
      criteria: '—',
      branch: branch ?? '—',
    };
  }

  if (run.status === 'CANCELLED') {
    return {
      kind: 'cancelled',
      id: `${run.id}-cancelled`,
      summary: [run.summary ?? 'Execução interrompida pelo usuário.'],
    };
  }

  if (run.status === 'FAILED') {
    // `blocked` is the loop asking for a person, which the design draws as the
    // human-review card rather than as a failure.
    if (liveStage === 'blocked') {
      return {
        kind: 'humanReview',
        id: `${run.id}-human`,
        reason: run.summary ?? 'Uma decisão humana é necessária para continuar.',
        reasonKind: 'Decisão necessária',
        progress: run.iterations > 0 ? [`${run.iterations} iteração(ões) concluída(s)`] : [],
        recommendation: run.summary ?? 'Revise o que foi registrado e decida como seguir.',
        options: ['Escrever instrução'],
      };
    }
    return {
      kind: 'noProgress',
      id: `${run.id}-failed`,
      detail: run.summary ?? 'A execução falhou.',
    };
  }

  return null;
}
