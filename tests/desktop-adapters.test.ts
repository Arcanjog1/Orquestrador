/**
 * The agent adapters.
 *
 * Three properties matter enough to pin: the executable never comes from PATH,
 * the prompt never appears in argv, and the non-interactive flags are read from
 * the binary's own `--help` rather than assumed. A guessed flag either fails
 * loudly or — much worse — quietly means something else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHelp } from '../apps/desktop/src/main/adapters/cli-capabilities.js';
import { CodexAdapter } from '../apps/desktop/src/main/adapters/codex-adapter.js';
import { ClaudeCodeAdapter } from '../apps/desktop/src/main/adapters/claude-adapter.js';
import type { ProcessManager, RunProcessOptions, ProcessResult } from '../src/process/process-manager.js';

/** Records every spawn the adapter asks for, and answers from a script. */
function fakeProcessManager(responses: Record<string, string>): {
  manager: ProcessManager;
  calls: RunProcessOptions[];
} {
  const calls: RunProcessOptions[] = [];
  const manager = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      const key = (options.args ?? []).join(' ');
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: responses[key] ?? '',
        stderr: '',
        durationMs: 1,
        truncated: false,
      } as ProcessResult;
    },
    async cancelAll(): Promise<void> {},
    get liveCount(): number {
      return 0;
    },
  } as unknown as ProcessManager;
  return { manager, calls };
}

/** Top-level help, in the shape codex-cli 0.153.0 really prints. */
const CODEX_HELP = `Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND>

Commands:
  exec     Run Codex non-interactively
  login    Manage login
  resume   Resume a previous session
  help     Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>   Override a configuration value
  -m, --model <MODEL>        Model the agent should use
  -h, --help                 Print help
`;

/**
 * `codex exec --help`, abridged from the real page.
 *
 * The flags the adapter cares about live here and nowhere else, which is the
 * whole point of the test below.
 */
const CODEX_EXEC_HELP = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]
          Initial instructions for the agent. If not provided as an argument (or if \`-\` is used),
          instructions are read from stdin.

Options:
  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]

      --skip-git-repo-check
          Allow running Codex outside a Git repository

      --output-schema <FILE>
          Path to a JSON Schema file describing the model's final response shape

      --json
          Print events to stdout as JSONL

  -o, --output-last-message <FILE>
          Write the last message to a file
`;

const CLAUDE_HELP = `Usage: claude [options] [prompt]

Options:
  -p, --print                       Print response and exit
      --permission-mode <mode>      Permission mode
      --version                     Output the version number
`;

test('parseHelp finds long flags and subcommands, and is not fooled by option lines', () => {
  const capabilities = parseHelp(CODEX_HELP);
  assert.ok(capabilities.subcommands.has('exec'));
  assert.ok(capabilities.subcommands.has('login'));
  assert.ok(capabilities.flags.has('--config'));
  assert.ok(!capabilities.subcommands.has('-h'));
  // Measured: these live on `codex exec`, not on the top-level page.
  assert.ok(!capabilities.flags.has('--skip-git-repo-check'));
  assert.ok(parseHelp(CODEX_EXEC_HELP).flags.has('--skip-git-repo-check'));
  assert.ok(parseHelp(CODEX_EXEC_HELP).flags.has('--sandbox'));
});

test('Codex runs headless via `exec`, with the prompt on stdin and never in argv', async () => {
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  await adapter.run({
    prompt: 'segredo do prompt',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'run-1',
    iteration: 1,
  });

  const invocation = calls.at(-1)!;
  assert.equal(invocation.command, '/managed/codex.exe', 'the managed path, not "codex"');
  // Read-only because the orchestrator supervises and never edits; the flags
  // come from `exec --help`, which is where this build actually declares them.
  assert.deepEqual(invocation.args, [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
  ]);
  assert.equal(invocation.stdin, 'segredo do prompt');
  assert.ok(
    !(invocation.args ?? []).some((arg) => arg.includes('segredo')),
    'the prompt must never reach argv',
  );
});

test('Codex reads its flags from `exec --help`, not from the top-level page', async () => {
  // The flags exist only on the subcommand. An adapter that checked the parent
  // page would find none of them and silently drop every one.
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  await adapter.run({
    prompt: 'x',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });

  assert.ok(
    calls.some((c) => (c.args ?? []).join(' ') === 'exec --help'),
    'the subcommand help page must be read',
  );
  assert.ok((calls.at(-1)!.args ?? []).includes('--skip-git-repo-check'));
});

test('Codex does not adopt --json, which prints an event stream rather than an answer', async () => {
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  await adapter.run({
    prompt: 'x',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });

  const args = calls.at(-1)!.args ?? [];
  assert.ok(!args.includes('--json'), 'JSONL events would be parsed as the decision');
  assert.ok(!args.includes('--output-schema'), 'not adopted until a real run can validate it');
});

test('Codex refuses a build with no non-interactive mode instead of hanging in a TUI', async () => {
  const { manager } = fakeProcessManager({ '--help': 'Usage: codex\n\nOptions:\n  -h, --help\n' });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  await assert.rejects(
    () =>
      adapter.run({
        prompt: 'x',
        workingDirectory: '/work',
        timeoutMs: 1000,
        runId: 'r',
        iteration: 1,
      }),
    /não interativo/i,
  );
});

test('Claude Code runs with --print, and adds --permission-mode only when offered', async () => {
  const { manager, calls } = fakeProcessManager({ '--help': CLAUDE_HELP });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude.exe',
    buildEnvironment: () => ({ CLAUDE_CONFIG_DIR: '/profiles/acc-1' }),
  });

  await adapter.run({
    prompt: 'crie hello.txt',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'run-1',
    iteration: 1,
  });

  const invocation = calls.at(-1)!;
  assert.equal(invocation.command, '/managed/claude.exe');
  assert.deepEqual(invocation.args, ['--print', '--permission-mode', 'acceptEdits']);
  assert.equal(invocation.stdin, 'crie hello.txt');
  assert.equal(invocation.env?.['CLAUDE_CONFIG_DIR'], '/profiles/acc-1');
});

test('Claude Code without --permission-mode still runs, with just --print', async () => {
  const { manager, calls } = fakeProcessManager({
    '--help': 'Usage: claude\n\nOptions:\n  -p, --print   Print response and exit\n',
  });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude.exe',
    buildEnvironment: () => ({}),
  });

  await adapter.run({
    prompt: 'x',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });
  assert.deepEqual(calls.at(-1)!.args, ['--print']);
});

test('Claude Code refuses a build with no print mode', async () => {
  const { manager } = fakeProcessManager({ '--help': 'Usage: claude\n\nOptions:\n  -h, --help\n' });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude.exe',
    buildEnvironment: () => ({}),
  });

  await assert.rejects(
    () =>
      adapter.run({
        prompt: 'x',
        workingDirectory: '/work',
        timeoutMs: 1000,
        runId: 'r',
        iteration: 1,
      }),
    /não interativo/i,
  );
});

test('an unconfigured runtime surfaces as a message, not as ENOENT', async () => {
  const { manager } = fakeProcessManager({});
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => {
      throw Object.assign(new Error('spawn codex ENOENT'), {
        userMessage: 'O Codex ainda não está configurado.',
      });
    },
  });

  const health = await adapter.healthCheck();
  assert.equal(health.healthy, false);
  assert.match(health.problem ?? '', /não está configurado/i);
  assert.ok(!/ENOENT/.test(JSON.stringify(health)), 'no raw error text reaches the interface');
});
