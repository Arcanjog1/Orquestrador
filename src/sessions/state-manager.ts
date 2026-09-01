/**
 * Run state persistence (spec 41).
 *
 * State is written after *every* transition, not at the end, so a crash, a
 * Ctrl+C, a closed terminal or a Windows restart all leave a resumable run.
 *
 * Writes are atomic (temp file + rename) so a state.json is never observed
 * half-written, and every value is redacted on the way out.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AcceptanceCriterion,
  Baseline,
  IterationRecord,
  WorkerSpec,
} from '../core/types.js';
import { assertTransition, type RunStatus } from '../core/run-state.js';
import { redactDeep } from '../security/secret-redactor.js';

/** Schema version, so a future change can migrate rather than crash. */
export const STATE_VERSION = 1;

export interface RunState {
  version: number;
  runId: string;
  status: RunStatus;
  objective: string;
  /** Path of the objective file, when the objective came from one. */
  objectiveSource: string | null;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Number of completed orchestration iterations. */
  iteration: number;
  maxIterations: number;
  /** Which agents are in use: real CLIs or mocks. */
  mode: 'mock' | 'real';
  worker: WorkerSpec;
  /** Claude Code profile in use, echoed here for `status` and the report. */
  claudeProfile: string | null;
  baseline: Baseline | null;
  criteria: AcceptanceCriterion[];
  /** Deduplicated union of every verification command seen so far. */
  verificationCommands: string[];
  iterations: IterationRecord[];
  /** Set when the run ended in BLOCKED or FAILED. */
  terminationReason: string | null;
  /**
   * True when the run was interrupted while the worker was running. The next
   * resume must not re-run that task, because there is no way to know whether
   * it completed (spec 28).
   */
  workerInterrupted: boolean;
  allowNoChanges: boolean;
}

export const STATE_FILENAME = 'state.json';

export class StateManager {
  private state: RunState;

  constructor(
    private readonly statePath: string,
    initial: RunState,
  ) {
    this.state = initial;
  }

  /** Creates a manager for a brand new run and writes the first state file. */
  static create(sessionDir: string, initial: RunState): StateManager {
    const manager = new StateManager(join(sessionDir, STATE_FILENAME), initial);
    manager.persist();
    return manager;
  }

  /** Loads an existing run. Throws when the file is missing or unreadable. */
  static load(sessionDir: string): StateManager {
    const statePath = join(sessionDir, STATE_FILENAME);
    if (!existsSync(statePath)) {
      throw new Error(`No ${STATE_FILENAME} found in ${sessionDir}.`);
    }
    let parsed: RunState;
    try {
      parsed = JSON.parse(readFileSync(statePath, 'utf8')) as RunState;
    } catch (err) {
      throw new Error(`Corrupt ${STATE_FILENAME} in ${sessionDir}: ${(err as Error).message}`);
    }
    if (parsed.version !== STATE_VERSION) {
      throw new Error(
        `Run ${parsed.runId} was written by state version ${parsed.version}; this build understands ${STATE_VERSION}.`,
      );
    }
    return new StateManager(statePath, parsed);
  }

  /** A copy, so callers cannot mutate persisted state by accident. */
  get current(): Readonly<RunState> {
    return this.state;
  }

  get status(): RunStatus {
    return this.state.status;
  }

  /** Validates the transition, applies it and persists. */
  transition(to: RunStatus, mutate?: (state: RunState) => void): void {
    assertTransition(this.state.status, to);
    this.state.status = to;
    mutate?.(this.state);
    this.persist();
  }

  /** Applies a change without a status transition, then persists. */
  update(mutate: (state: RunState) => void): void {
    mutate(this.state);
    this.persist();
  }

  /** Atomic, redacted write. */
  persist(): void {
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.statePath), { recursive: true });
    const payload = JSON.stringify(redactDeep(this.state), null, 2);
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, payload, 'utf8');
    // rename is atomic within a filesystem on both Windows and POSIX, so a
    // reader never sees a partially written state file.
    renameSync(temp, this.statePath);
  }
}

/** Builds the initial state for a new run. */
export function createInitialState(input: {
  runId: string;
  objective: string;
  objectiveSource: string | null;
  projectPath: string;
  maxIterations: number;
  mode: 'mock' | 'real';
  worker: WorkerSpec;
  claudeProfile: string | null;
  allowNoChanges: boolean;
}): RunState {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    runId: input.runId,
    status: 'CREATED',
    objective: input.objective,
    objectiveSource: input.objectiveSource,
    projectPath: input.projectPath,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    iteration: 0,
    maxIterations: input.maxIterations,
    mode: input.mode,
    worker: input.worker,
    claudeProfile: input.claudeProfile,
    baseline: null,
    criteria: [],
    verificationCommands: [],
    iterations: [],
    terminationReason: null,
    workerInterrupted: false,
    allowNoChanges: input.allowNoChanges,
  };
}
