/**
 * A verification in two stages, kept outside the workspace.
 *
 * The autonomous loop is only proven when a second worker prompt arises from
 * the loop's own review of a first attempt. With real providers, a scenario
 * that relies on the model getting something *wrong* is not repeatable: a good
 * worker gets "Olá" right first time and the second iteration never happens.
 *
 * This script makes the first iteration fall short by construction instead.
 * Stage one checks what the objective asked for (hello.txt). Stage two is a
 * further requirement (bye.txt) that the objective never mentions and that is
 * reported only once stage one holds. The script lives outside the workspace,
 * and the loop shows the orchestrator only a verification's id and label -
 * never its command line - so neither agent can read the second stage ahead of
 * time. A worker that follows its first instruction perfectly therefore still
 * fails verification, for a reason that first exists in that failure's output;
 * the orchestrator has to read that output and delegate again.
 *
 * The script only observes: it reads files, prints what is missing and exits
 * non-zero. It writes nothing, calls no agent and composes no prompt.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Writes `check.mjs` into a fresh directory of its own and returns the
 * verification command that runs it, ready for `verifications.upsert`.
 *
 * @param {{ hello: string; then?: { file: string; content: string } | null; prefix?: string }} spec
 *   `hello` is the exact content stage one requires of hello.txt. `then`, when
 *   given, is the second stage: a file and its exact content, checked only
 *   after stage one passes. Omit it for a plain single-stage check.
 * @returns {{ dir: string; path: string; command: string }}
 */
export function writeTwoStageCheck(spec) {
  const dir = mkdtempSync(join(tmpdir(), spec.prefix ?? 'lao-check-'));
  const path = join(dir, 'check.mjs');
  writeFileSync(path, renderCheckScript(spec), 'utf8');
  return { dir, path, command: `node ${quoteForVerifier(path)}` };
}

/** The script text, so a test can also inspect exactly what runs. */
export function renderCheckScript(spec) {
  const lines = [
    "import { readFileSync } from 'node:fs';",
    'const read = (f) => { try { return readFileSync(f, "utf8").trim(); } catch { return null; } };',
    'const expect = (file, want) => {',
    '  const got = read(file);',
    '  if (got === want) return true;',
    '  console.error(`${file} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);',
    '  return false;',
    '};',
    `if (!expect('hello.txt', ${JSON.stringify(spec.hello)})) process.exit(1);`,
  ];
  if (spec.then) {
    lines.push(
      // Stage two is reported only once stage one holds, so the first
      // iteration learns about it from this line and nowhere else.
      `if (!expect(${JSON.stringify(spec.then.file)}, ${JSON.stringify(spec.then.content)})) process.exit(1);`,
    );
  }
  lines.push("console.log('ok');", '');
  return lines.join('\n');
}

/**
 * The verifier runs commands without a shell and tokenises them itself, with
 * single quotes taken literally. Forward slashes keep a Windows temp path
 * free of backslash handling, and Node accepts them on every platform.
 */
function quoteForVerifier(path) {
  const slashes = path.replaceAll('\\', '/');
  if (slashes.includes("'")) throw new Error(`Cannot quote a path containing a single quote: ${path}`);
  return `'${slashes}'`;
}
