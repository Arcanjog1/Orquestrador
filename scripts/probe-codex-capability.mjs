/**
 * The block A4 incident, proved against a real Codex executable.
 *
 * The unit tests pin the behaviour against a scripted process manager. This
 * script pins it against the binary the product actually ships: it pollutes
 * the parent environment the way the reporting machine's is polluted, then
 * drives the real `CodexAdapter` and the real `ProcessManager` twice.
 *
 *   without the overlay -> the probe aborts before `main`, and the adapter
 *                          must say EXECUTABLE_INCOMPATIBLE (not "this Codex
 *                          has no non-interactive mode");
 *   with the overlay    -> the probe reads the help page, `codex exec` is
 *                          planned with the documented flags and is actually
 *                          launched.
 *
 * Usage:
 *   npm run build:tests
 *   node scripts/probe-codex-capability.mjs /absolute/path/to/codex
 *
 * On a machine whose CPU really lacks the requested bit the variable is not
 * needed; 0x400 is CPUID.1:EDX bit 10, reserved on every processor, so the
 * abort reproduces everywhere.
 */

import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../dist-tests/apps/desktop/src/main/adapters/codex-adapter.js';
import { ProcessManager } from '../dist-tests/src/process/process-manager.js';

const executable = process.argv[2];
if (!executable || !existsSync(executable)) {
  console.error('usage: node scripts/probe-codex-capability.mjs <path-to-codex-executable>');
  process.exit(2);
}

/** The variable the reporting machine has set, and that kills AWS-LC. */
const POISON = process.env.AI_ORCHESTRATOR_PROBE_IA32CAP ?? '0x400';

const processManager = new ProcessManager();
const cwd = await mkdtemp(join(tmpdir(), 'codex-capability-'));
const input = { prompt: 'ping', workingDirectory: cwd, timeoutMs: 60_000, runId: 'probe', iteration: 1 };

let failures = 0;
const say = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`);
const check = (ok, message) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${message}`);
  if (!ok) failures += 1;
};

process.env.OPENSSL_ia32cap = POISON;
console.log(`Codex: ${executable}`);
console.log(`Parent environment: OPENSSL_ia32cap=${POISON}\n`);

// ---------------------------------------------------------------------------
console.log('A. no environment overlay - the state before the fix');
{
  const adapter = new CodexAdapter({ processManager, resolveExecutable: async () => executable });
  try {
    await adapter.run(input);
    check(false, 'the run was expected to be refused, and was not');
  } catch (error) {
    say('name', error?.name ?? '(none)');
    say('reason', error?.reason ?? '(none)');
    say('userMessage', (error?.userMessage ?? error?.message ?? '').slice(0, 300));
    check(error?.name === 'CodexCapabilityError', 'refused with CodexCapabilityError');
    check(
      error?.reason === 'EXECUTABLE_INCOMPATIBLE',
      `classified as EXECUTABLE_INCOMPATIBLE (got ${error?.reason})`,
    );
    check(
      !/modo n[aã]o interativo/i.test(error?.userMessage ?? ''),
      'does NOT claim this Codex lacks a non-interactive mode',
    );
    check(
      /OPENSSL_ia32cap/.test(error?.userMessage ?? ''),
      'names OPENSSL_ia32cap as the cause',
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\nB. with the managed build\'s environment policy - the fix');
{
  const calls = [];
  const recording = {
    run: (options) => {
      calls.push(options);
      return processManager.run(options);
    },
    cancelAll: () => processManager.cancelAll(),
  };
  const adapter = new CodexAdapter({
    processManager: recording,
    resolveExecutable: async () => executable,
    buildEnvironment: () => ({ OPENSSL_ia32cap: undefined, OPENSSL_armcap: undefined }),
  });
  let result = null;
  let thrown = null;
  try {
    result = await adapter.run(input);
  } catch (error) {
    thrown = error;
  }

  const help = calls.find((c) => (c.args ?? []).join(' ') === '--help');
  const execHelp = calls.find((c) => (c.args ?? []).join(' ') === 'exec --help');
  const invocation = calls.find((c) => (c.args ?? [])[0] === 'exec' && (c.args ?? [])[1] !== '--help');

  check(Boolean(help), '`codex --help` was probed');
  check(Boolean(execHelp), '`codex exec --help` was probed');
  for (const call of calls) {
    check(
      call.env && 'OPENSSL_ia32cap' in call.env && call.env.OPENSSL_ia32cap === undefined,
      `\`${(call.args ?? []).join(' ').slice(0, 40)}\` ran without OPENSSL_ia32cap`,
    );
  }
  check(thrown === null, `the capability gate opened${thrown ? ` (threw ${thrown.name}: ${thrown.message})` : ''}`);
  check(Boolean(invocation), '`codex exec` was actually launched - the invocation the incident never reached');
  if (invocation) {
    say('argv', invocation.args.join(' '));
    check(invocation.args.includes('--skip-git-repo-check'), '--skip-git-repo-check sent');
    check(invocation.args.includes('--sandbox'), '--sandbox sent');
    check(
      !invocation.args.some((arg) => arg.includes('ping')),
      'the prompt never reached argv',
    );
    check(invocation.stdin === 'ping', 'the prompt went over stdin');
  }
  if (result) {
    say('outcome', result.outcome);
    say('exitCode', String(result.exitCode));
    // Not signed in here, so a non-zero exit is expected and is NOT a failure
    // of this script: the point is that the process ran at all.
    say('stderr (first line)', (result.stderr ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '(none)');
  }
}

await processManager.cancelAll();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
