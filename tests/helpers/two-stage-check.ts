/**
 * The two-stage verification the real-provider smoke registers, loaded from
 * its own source so the deterministic test exercises the very script the
 * smoke will run against real providers - not a copy that could drift.
 *
 * Tests run from the repository root (`node --test dist-tests/...`), and the
 * script is plain ESM that is never compiled, so it is imported by path.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TwoStageSpec {
  hello: string;
  then?: { file: string; content: string } | null;
  prefix?: string;
}

export interface TwoStageCheck {
  /** The directory that holds the script - outside any workspace. */
  dir: string;
  path: string;
  /** Ready for `verifications.upsert`. */
  command: string;
}

interface TwoStageModule {
  writeTwoStageCheck(spec: TwoStageSpec): TwoStageCheck;
  renderCheckScript(spec: TwoStageSpec): string;
}

export async function loadTwoStageCheck(): Promise<TwoStageModule> {
  const source = join(process.cwd(), 'scripts', 'lib', 'two-stage-check.mjs');
  return (await import(pathToFileURL(source).href)) as TwoStageModule;
}
