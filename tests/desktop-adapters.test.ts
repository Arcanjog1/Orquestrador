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

const CODEX_HELP = `Usage: codex [OPTIONS] <COMMAND>

Commands:
  exec     Run without an interactive UI
  login    Sign in
  help     Print this message

Options:
  -h, --help                   Print help
      --skip-git-repo-check    Allow running outside a git repository
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
  assert.ok(capabilities.flags.has('--skip-git-repo-check'));
  assert.ok(!capabilities.subcommands.has('-h'));
});

test('Codex runs headless via `exec`, with the prompt on stdin and never in argv', async () => {
  const { manager, calls } = fakeProcessManager({ '--help': CODEX_HELP });
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
  assert.deepEqual(invocation.args, ['exec', '--skip-git-repo-check']);
  assert.equal(invocation.stdin, 'segredo do prompt');
  assert.ok(
    !(invocation.args ?? []).some((arg) => arg.includes('segredo')),
    'the prompt must never reach argv',
  );
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
