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
import { assertTransition } from '../core/run-state.js';
import { redactDeep } from '../security/secret-redactor.js';
/** Schema version, so a future change can migrate rather than crash. */
export const STATE_VERSION = 1;
export const STATE_FILENAME = 'state.json';
export class StateManager {
    statePath;
    state;
    constructor(statePath, initial) {
        this.statePath = statePath;
        this.state = initial;
    }
    /** Creates a manager for a brand new run and writes the first state file. */
    static create(sessionDir, initial) {
        const manager = new StateManager(join(sessionDir, STATE_FILENAME), initial);
        manager.persist();
        return manager;
    }
    /** Loads an existing run. Throws when the file is missing or unreadable. */
    static load(sessionDir) {
        const statePath = join(sessionDir, STATE_FILENAME);
        if (!existsSync(statePath)) {
            throw new Error(`No ${STATE_FILENAME} found in ${sessionDir}.`);
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(statePath, 'utf8'));
        }
        catch (err) {
            throw new Error(`Corrupt ${STATE_FILENAME} in ${sessionDir}: ${err.message}`);
        }
        if (parsed.version !== STATE_VERSION) {
            throw new Error(`Run ${parsed.runId} was written by state version ${parsed.version}; this build understands ${STATE_VERSION}.`);
        }
        return new StateManager(statePath, parsed);
    }
    /** A copy, so callers cannot mutate persisted state by accident. */
    get current() {
        return this.state;
    }
    get status() {
        return this.state.status;
    }
    /** Validates the transition, applies it and persists. */
    transition(to, mutate) {
        assertTransition(this.state.status, to);
        this.state.status = to;
        mutate?.(this.state);
        this.persist();
    }
    /** Applies a change without a status transition, then persists. */
    update(mutate) {
        mutate(this.state);
        this.persist();
    }
    /** Atomic, redacted write. */
    persist() {
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
export function createInitialState(input) {
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
//# sourceMappingURL=state-manager.js.map