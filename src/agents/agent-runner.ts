/**
 * The agent abstraction (spec 5).
 *
 * Codex- and Claude-specific command lines live behind these implementations
 * and nowhere else. The orchestration loop talks only to this interface, which
 * is what keeps spec 53 open: swapping which agent orchestrates and which one
 * works is a matter of passing different runners.
 */

import type { AgentInput, AgentKind, AgentResult, HealthStatus } from '../core/types.js';

export interface AgentRunner {
  /** Stable identifier recorded in the run state and the final report. */
  readonly kind: AgentKind;
  /** Human-readable label used in log lines. */
  readonly label: string;

  run(input: AgentInput): Promise<AgentResult>;

  /** Stops any in-flight invocation. Safe to call when nothing is running. */
  cancel(): Promise<void>;

  /** Checks the agent is installed and usable, without doing any work. */
  healthCheck(): Promise<HealthStatus>;
}

/** Convenience for building an `AgentResult` in mocks and error paths. */
export function makeAgentResult(partial: Partial<AgentResult> & { startedAt: string }): AgentResult {
  const finishedAt = partial.finishedAt ?? new Date().toISOString();
  return {
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: new Date(finishedAt).getTime() - new Date(partial.startedAt).getTime(),
    finishedAt,
    ...partial,
  };
}
