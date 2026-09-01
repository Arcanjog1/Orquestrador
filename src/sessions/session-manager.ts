/**
 * Session directory layout (spec 26).
 *
 *   .sessions/<run-id>/
 *     objective.md
 *     state.json
 *     baseline.json
 *     config.snapshot.json
 *     final-report.md
 *     logs/orchestrator.log
 *     iterations/001/
 *       codex-input.md   codex-output.json
 *       claude-input.md  claude-output.txt
 *       evidence.json    git-diff.patch  git-status.txt  tests.json
 *
 * Every artifact is redacted on the way to disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, redactDeep } from '../security/secret-redactor.js';

export const OBJECTIVE_FILENAME = 'objective.md';
export const BASELINE_FILENAME = 'baseline.json';
export const CONFIG_SNAPSHOT_FILENAME = 'config.snapshot.json';
export const FINAL_REPORT_FILENAME = 'final-report.md';
export const LOG_FILENAME = 'orchestrator.log';

export class SessionManager {
  constructor(readonly sessionsRoot: string) {}

  /**
   * Allocates the next run id for today: `YYYY-MM-DD-NNN`.
   *
   * The directory is created immediately so two runs started in the same second
   * cannot claim the same id.
   */
  createRun(now: Date = new Date()): { runId: string; dir: string } {
    mkdirSync(this.sessionsRoot, { recursive: true });
    const datePart = formatDate(now);
    const existing = this.listRunIds().filter((id) => id.startsWith(`${datePart}-`));
    let sequence = existing.length + 1;
    for (;;) {
      const runId = `${datePart}-${String(sequence).padStart(3, '0')}`;
      const dir = join(this.sessionsRoot, runId);
      if (!existsSync(dir)) {
        mkdirSync(join(dir, 'iterations'), { recursive: true });
        mkdirSync(join(dir, 'logs'), { recursive: true });
        return { runId, dir };
      }
      sequence += 1;
    }
  }

  /** Run ids present on disk, newest last. */
  listRunIds(): string[] {
    if (!existsSync(this.sessionsRoot)) return [];
    return readdirSync(this.sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  /** The most recently created run, or null when there are none. */
  latestRunId(): string | null {
    const ids = this.listRunIds();
    return ids.length ? ids[ids.length - 1]! : null;
  }

  runDir(runId: string): string {
    return join(this.sessionsRoot, runId);
  }

  exists(runId: string): boolean {
    return existsSync(join(this.sessionsRoot, runId, 'state.json'));
  }

  logPath(runId: string): string {
    return join(this.runDir(runId), 'logs', LOG_FILENAME);
  }

  /** Creates (if needed) and returns an iteration directory. */
  iterationDir(runId: string, iteration: number): string {
    const dir = join(this.runDir(runId), 'iterations', String(iteration).padStart(3, '0'));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeText(runId: string, relativePath: string, contents: string): string {
    const full = join(this.runDir(runId), relativePath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, redact(contents), 'utf8');
    return full;
  }

  writeJson(runId: string, relativePath: string, value: unknown): string {
    return this.writeText(runId, relativePath, `${JSON.stringify(redactDeep(value), null, 2)}\n`);
  }

  /** Writes a file into an iteration directory. */
  writeIterationText(
    runId: string,
    iteration: number,
    filename: string,
    contents: string,
  ): string {
    const dir = this.iterationDir(runId, iteration);
    const full = join(dir, filename);
    writeFileSync(full, redact(contents), 'utf8');
    return full;
  }

  writeIterationJson(runId: string, iteration: number, filename: string, value: unknown): string {
    return this.writeIterationText(
      runId,
      iteration,
      filename,
      `${JSON.stringify(redactDeep(value), null, 2)}\n`,
    );
  }

  readText(runId: string, relativePath: string): string | null {
    const full = join(this.runDir(runId), relativePath);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf8');
  }
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
