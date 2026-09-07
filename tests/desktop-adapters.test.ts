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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseHelp } from '../apps/desktop/src/main/adapters/cli-capabilities.js';
import { CodexAdapter, CodexCapabilityError } from '../apps/desktop/src/main/adapters/codex-adapter.js';
import { ClaudeCodeAdapter, ClaudeCapabilityError } from '../apps/desktop/src/main/adapters/claude-adapter.js';
import type { ProcessManager, RunProcessOptions, ProcessResult } from '../src/process/process-manager.js';

/** Records every spawn the adapter asks for, and answers from a script. */
function fakeProcessManager(
  responses: Record<string, string>,
  onRun?: (options: RunProcessOptions) => void,
): {
  manager: ProcessManager;
  calls: RunProcessOptions[];
} {
  const calls: RunProcessOptions[] = [];
  const manager = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      onRun?.(options);
      const key = (options.args ?? []).join(' ');
      // Structured runs are keyed by the subcommand alone: the scratch paths
      // differ every time.
      const stdout = responses[key] ?? responses[(options.args ?? [])[0] ?? ''] ?? '';
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout,
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
  assert.deepEqual((invocation.args ?? []).slice(0, 4), [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
  ]);
  // The answer file is asked for even without a schema: a clean final message
  // beats scraping a transcript either way.
  assert.ok((invocation.args ?? []).includes('--output-last-message'));
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

/* ------------------------------------------------- structured output ----- */

test('the decision schema still describes exactly the actions the parser allows', async () => {
  const { DECISION_JSON_SCHEMA } = await import('../src/orchestrator/decision-schema.js');
  const { ALLOWED_ACTIONS } = await import('../src/orchestrator/decision-parser.js');
  assert.deepEqual([...DECISION_JSON_SCHEMA.properties.action.enum], [...ALLOWED_ACTIONS]);
  assert.equal(DECISION_JSON_SCHEMA.additionalProperties, false);
  assert.ok(DECISION_JSON_SCHEMA.required.includes('action'));
});

test('the decision schema passes the strict validation codex exec asks the API for', async () => {
  // codex-rs 0.153.4 sends `text.format.strict = true` on every exec turn;
  // the Responses API then refuses any object that does not list every
  // property in `required`. The schema must satisfy that before a real run
  // can produce a single decision.
  const { DECISION_JSON_SCHEMA, strictSchemaProblems } = await import(
    '../src/orchestrator/decision-schema.js'
  );
  assert.deepEqual(strictSchemaProblems(DECISION_JSON_SCHEMA), []);
  assert.deepEqual(
    [...DECISION_JSON_SCHEMA.required].sort(),
    Object.keys(DECISION_JSON_SCHEMA.properties).sort(),
    'strict mode: every property is required, optional ones are nullable',
  );
  // And the check itself catches the shape the previous schema had.
  const lax = { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string' }, task: { type: 'string' } } };
  assert.ok(strictSchemaProblems(lax).some((p) => p.includes('task')));
  assert.ok(strictSchemaProblems({ type: 'object', properties: {}, required: [] }).length > 0, 'additionalProperties is mandatory');
});

test('Codex is told the answer shape and asked to write it to a file', async () => {
  // Read while the run is in flight: the scratch directory is removed when it
  // ends, which is itself asserted below.
  let schemaOnDisk: Record<string, unknown> | null = null;
  const { manager, calls } = fakeProcessManager(
    { '--help': CODEX_HELP, 'exec --help': CODEX_EXEC_HELP },
    (options) => {
      const args = options.args ?? [];
      const index = args.indexOf('--output-schema');
      if (index >= 0) schemaOnDisk = JSON.parse(readFileSync(args[index + 1]!, 'utf8'));
    },
  );
  const { DECISION_JSON_SCHEMA } = await import('../src/orchestrator/decision-schema.js');

  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    outputSchema: DECISION_JSON_SCHEMA,
  });

  await adapter.run({
    prompt: 'decida',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });

  const args = calls.at(-1)!.args ?? [];
  const schemaIndex = args.indexOf('--output-schema');
  const lastIndex = args.indexOf('--output-last-message');
  assert.ok(schemaIndex >= 0, '--output-schema must be passed when the build offers it');
  assert.ok(lastIndex >= 0, '--output-last-message must be passed when the build offers it');

  // The schema is handed over as a real file, whose contents are the schema.
  assert.ok(schemaOnDisk !== null, 'a schema file must have been written');
  const properties = (schemaOnDisk as unknown as { properties: { action: { enum: string[] } } })
    .properties;
  assert.deepEqual(properties.action.enum, [...DECISION_JSON_SCHEMA.properties.action.enum]);

  // And it does not outlive the run.
  assert.equal(existsSync(args[schemaIndex + 1]!), false, 'scratch files are cleaned up');

  // Events are still not the decision.
  assert.ok(!args.includes('--json'));
});

test('the final message wins over the transcript on stdout', async () => {
  const decision = JSON.stringify({ action: 'done', acceptanceCriteria: [], verificationCommands: [] });
  let lastMessagePath: string | null = null;

  const { manager } = fakeProcessManager(
    {
      '--help': CODEX_HELP,
      'exec --help': CODEX_EXEC_HELP,
      // The transcript contains prose and a decoy object, as a real run would.
      exec: 'thinking...\n{"action":"blocked","reason":"this is an event, not the answer"}\n',
    },
    (options) => {
      const args = options.args ?? [];
      const index = args.indexOf('--output-last-message');
      if (index >= 0) {
        lastMessagePath = args[index + 1]!;
        writeFileSync(lastMessagePath, decision, 'utf8');
      }
    },
  );

  const { DECISION_JSON_SCHEMA } = await import('../src/orchestrator/decision-schema.js');
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    outputSchema: DECISION_JSON_SCHEMA,
  });

  const result = await adapter.run({
    prompt: 'decida',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });

  assert.equal(result.stdout, decision, 'the answer file is the answer');
  assert.ok(!result.stdout.includes('this is an event'));
  // And the scratch directory does not outlive the run.
  assert.ok(lastMessagePath !== null);
  assert.equal(existsSync(lastMessagePath!), false, 'scratch files are cleaned up');
});

test('an empty or missing answer file falls back to stdout rather than losing the run', async () => {
  const { manager } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP,
    // Nothing writes the answer file: Codex produced only a transcript.
    exec: '{"action":"done","acceptanceCriteria":[],"verificationCommands":[]}',
  });

  const { DECISION_JSON_SCHEMA } = await import('../src/orchestrator/decision-schema.js');
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    outputSchema: DECISION_JSON_SCHEMA,
  });

  const result = await adapter.run({
    prompt: 'decida',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });

  assert.match(result.stdout, /"action":"done"/);
});

test('a build without the structured flags still runs, with neither flag invented', async () => {
  const plainExecHelp = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Options:
      --skip-git-repo-check
          Allow running Codex outside a Git repository
`;
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': plainExecHelp,
    exec: '{"action":"done","acceptanceCriteria":[],"verificationCommands":[]}',
  });

  const { DECISION_JSON_SCHEMA } = await import('../src/orchestrator/decision-schema.js');
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    outputSchema: DECISION_JSON_SCHEMA,
  });

  const result = await adapter.run({
    prompt: 'decida',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
  });

  const args = calls.at(-1)!.args ?? [];
  assert.deepEqual(args, ['exec', '--skip-git-repo-check']);
  assert.match(result.stdout, /"action":"done"/, 'stdout is still parsed when there is no file');
});

/* ------------------------------------------------------------------------ *
 * The team's model and reasoning level.
 *
 * A workspace's team names a model and a reasoning level per role. Both are
 * passed on only when the installed build advertises the flag: codex-cli
 * 0.153.0 has `-m/--model` and `-c/--config` on `exec`, Claude Code 2.1.261
 * has `--model` and `--effort`. On a build without them the choice is dropped
 * rather than guessed, and the run still happens.
 * ------------------------------------------------------------------------ */

const CODEX_EXEC_HELP_WITH_MODEL = `${CODEX_EXEC_HELP}
  -m, --model <MODEL>
          Model the agent should use

  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from config.toml
`;

const CLAUDE_HELP_WITH_MODEL = `${CLAUDE_HELP}      --model <model>                   Model for the current session
      --effort <level>                  Effort level: low, medium, high
`;

test('Codex is told the team\'s model and reasoning level, as its own exec flags', async () => {
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP_WITH_MODEL,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    model: 'gpt-5.1-codex',
    reasoningEffort: 'high',
  });
  await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });

  const exec = calls.find((c) => c.args?.[0] === 'exec' && c.args[1] !== '--help')!;
  const args = exec.args!;
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.1-codex');
  // The documented config key, quoted so Codex's TOML reader takes it as a
  // string; one argv entry, so no shell ever sees the quotes.
  assert.equal(args[args.indexOf('--config') + 1], 'model_reasoning_effort="high"');
  assert.ok(!exec.stdin?.includes('--model'), 'flags do not leak into the prompt');
});

test('Codex drops the model choice on a build whose exec has no such flag', async () => {
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    model: 'gpt-5.1-codex',
    reasoningEffort: 'high',
  });
  await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });
  const exec = calls.find((c) => c.args?.[0] === 'exec' && c.args[1] !== '--help')!;
  assert.ok(!exec.args!.includes('--model'));
  assert.ok(!exec.args!.includes('--config'));
});

test('Codex with no team choice adds neither flag, even when the build has them', async () => {
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP_WITH_MODEL,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    model: null,
    reasoningEffort: null,
  });
  await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });
  const exec = calls.find((c) => c.args?.[0] === 'exec' && c.args[1] !== '--help')!;
  assert.ok(!exec.args!.includes('--model'));
  assert.ok(!exec.args!.includes('--config'));
});

test('Claude Code is told the team\'s model and effort, only when its help offers them', async () => {
  for (const [help, expected] of [
    [CLAUDE_HELP_WITH_MODEL, true],
    [CLAUDE_HELP, false],
  ] as const) {
    const { manager, calls } = fakeProcessManager({ '--help': help });
    const adapter = new ClaudeCodeAdapter({
      processManager: manager,
      resolveExecutable: async () => '/managed/claude.exe',
      buildEnvironment: () => ({}),
      model: 'claude-opus-5',
      effort: 'medium',
    });
    await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });
    const run = calls.find((c) => c.args?.[0] === '--print')!;
    const args = run.args!;
    if (expected) {
      assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
      assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    } else {
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('--effort'));
    }
    assert.equal(run.stdin, 'p', 'the prompt still goes over stdin');
  }
});


/* ------------------------------------------------- per-invocation routing */

/** Claude Code 2.1.263: the option lines the router reads, verbatim in shape. */
const CLAUDE_HELP_ROUTED = `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                       Print response and exit (useful for pipes).
      --permission-mode <mode>      Permission mode to use for the session
      --model <model>               Model for the current session. Provide an alias for the latest
                                    model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
                                    (e.g. 'claude-fable-5').
      --effort <level>              Effort level for the session (low, medium, high, xhigh, max)
  -v, --version                     Output the version number
  -h, --help                        Display help for command
`;

test('the help parser reads the values and aliases an option lists, and nothing else', async () => {
  const { optionValues, modelAliases, optionDescription } = await import(
    '../apps/desktop/src/main/adapters/cli-capabilities.js'
  );
  assert.deepEqual(optionValues(CLAUDE_HELP_ROUTED, '--effort'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelAliases(CLAUDE_HELP_ROUTED), ['fable', 'opus', 'sonnet']);
  assert.match(optionDescription(CLAUDE_HELP_ROUTED, '--model') ?? '', /full name/);
  assert.equal(optionValues(CLAUDE_HELP_ROUTED, '--permission-mode'), null, 'no list means unknown, not empty');
  assert.equal(optionValues(CLAUDE_HELP_ROUTED, '--nope'), null);
  assert.deepEqual(optionValues(CODEX_EXEC_HELP, '--sandbox'), ['read-only', 'workspace-write', 'danger-full-access']);
  assert.equal(modelAliases(CLAUDE_HELP), null);
});

test('Claude Code takes the model and effort of each invocation, and only values its help declares', async () => {
  const { manager, calls } = fakeProcessManager({ '--help': CLAUDE_HELP_ROUTED });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude',
    buildEnvironment: () => ({ CLAUDE_CONFIG_DIR: '/profiles/a' }),
    // The team's manual choice is only a default for invocations without routing.
    model: 'claude-opus-5',
    effort: 'high',
  });

  const capabilities = await adapter.describeCapabilities('/work');
  assert.deepEqual(capabilities, {
    modelFlag: true,
    effortFlag: true,
    declaredModels: ['fable', 'opus', 'sonnet'],
    declaredEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  });
  // The help was read in the account's environment.
  assert.equal(calls[0]!.env?.CLAUDE_CONFIG_DIR, '/profiles/a');

  const routed = await adapter.run({
    prompt: 'p',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
    routing: { model: 'sonnet', reasoning: 'max' },
  });
  let args = calls.at(-1)!.args ?? [];
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'max', 'declared, so sent');
  assert.deepEqual(routed.applied, { model: 'sonnet', reasoning: 'max', fallbackUsed: false, note: null });

  // Another invocation, another model: nothing sticks from the first.
  await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 2, routing: { model: 'haiku', reasoning: 'low' } });
  args = calls.at(-1)!.args ?? [];
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');

  // No routing: the defaults.
  await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 3 });
  args = calls.at(-1)!.args ?? [];
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('Claude Code never receives an effort its help did not name - "max" on a build without it becomes "high"', async () => {
  const help = CLAUDE_HELP_ROUTED.replace('(low, medium, high, xhigh, max)', '(low, medium, high)');
  const { manager, calls } = fakeProcessManager({ '--help': help });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude',
    buildEnvironment: () => ({}),
  });
  const result = await adapter.run({
    prompt: 'p',
    workingDirectory: '/work',
    timeoutMs: 1000,
    runId: 'r',
    iteration: 1,
    routing: { model: 'opus', reasoning: 'max' },
  });
  const args = calls.at(-1)!.args ?? [];
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(!args.includes('max'));
  assert.equal(result.applied?.reasoning, 'high');
  assert.equal(result.applied?.fallbackUsed, true);
  assert.match(result.applied?.note ?? '', /^Este nível não é suportado pela versão atual\./);
});

test('Codex: a saved "max" is sent only to a build that knows it; older builds get "xhigh" and a note', async () => {
  for (const [version, expected, fallback] of [
    ['codex-cli 0.130.0', 'xhigh', true],
    ['codex-cli 0.153.4', 'max', false],
  ] as const) {
    const { manager, calls } = fakeProcessManager({
      '--help': CODEX_HELP,
      'exec --help': CODEX_EXEC_HELP_WITH_MODEL,
      '--version': version,
    });
    const adapter = new CodexAdapter({
      processManager: manager,
      resolveExecutable: async () => '/managed/codex.exe',
      model: 'gpt-5.1-codex',
      reasoningEffort: 'max',
    });
    const result = await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });
    const args = calls.at(-1)!.args ?? [];
    assert.ok(args.includes(`model_reasoning_effort="${expected}"`), `${version}: ${args.join(' ')}`);
    assert.ok(!args.includes('model_reasoning_effort="max"') || expected === 'max');
    assert.equal(result.applied?.reasoning, expected);
    assert.equal(result.applied?.model, 'gpt-5.1-codex');
    assert.equal(result.applied?.fallbackUsed, fallback);
    if (fallback) assert.match(result.applied?.note ?? '', /^Este nível não é suportado pela versão atual\./);
    else assert.equal(result.applied?.note, null);
    // The version is read once, not per invocation.
    await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 2 });
    assert.equal(calls.filter((c) => (c.args ?? [])[0] === '--version').length, 1);
    const supported = await adapter.supportedEfforts('/work');
    assert.equal(supported?.includes('max'), expected === 'max');
  }
});

/* ------------------------------------------------------------------------- *
 * Block A4 - the CodexCapabilityError incident.
 *
 * Reported from an installed Windows build: a run ended FAILED at iteration 1
 * with zero invocations and "Esta versão do Codex não oferece um modo não
 * interativo compatível." The Codex on that machine was the managed 0.153.4,
 * which does have `exec`.
 *
 * Two defects produced that sentence:
 *
 *  1. `codex exec` ran under the environment overlay (block A3: OPENSSL_ia32cap
 *     removed so AWS-LC does not abort before `main`), but the capability
 *     probe that decides whether to run it at all did not. So `codex --help`
 *     aborted at start-up, the help page came back as the abort message, and
 *     `exec` was not on it.
 *  2. That absence was reported as a fact about the CLI. A probe that never
 *     ran cannot say anything about a CLI's features.
 *
 * The tests below pin both, and pin that a genuinely incapable build is still
 * refused.
 * ------------------------------------------------------------------------- */

/** A process manager that can fail the way a real one does. */
function scriptedProcessManager(
  script: Record<string, Partial<ProcessResult>>,
): { manager: ProcessManager; calls: RunProcessOptions[] } {
  const calls: RunProcessOptions[] = [];
  const manager = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      const key = (options.args ?? []).join(' ');
      const scripted = script[key] ?? script[(options.args ?? [])[0] ?? ''] ?? {};
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        ...scripted,
      } as ProcessResult;
    },
    async cancelAll(): Promise<void> {},
    get liveCount(): number {
      return 0;
    },
  } as unknown as ProcessManager;
  return { manager, calls };
}

/** The abort AWS-LC prints before `main` when OPENSSL_ia32cap asks too much. */
const AWS_LC_ABORT =
  'Fatal Error: HW capability found: 0x178BFBFF 0x7EF8320B, but HW capability requested: 0x20000000 0x00.\n';

async function failureOf(adapter: CodexAdapter): Promise<CodexCapabilityError> {
  try {
    await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });
  } catch (error) {
    assert.ok(error instanceof CodexCapabilityError, `expected CodexCapabilityError, got ${String(error)}`);
    return error;
  }
  throw new Error('the run was expected to be refused');
}

test('the capability probe runs under the same environment as the run itself', async () => {
  // The regression, stated as the property it broke: every child this adapter
  // starts - help pages, --version, `exec` - carries the account profile and
  // the managed build's environment policy. Nothing inherits the machine's.
  const { manager, calls } = fakeProcessManager({
    '--help': CODEX_HELP,
    'exec --help': CODEX_EXEC_HELP_WITH_MODEL,
    '--version': 'codex-cli 0.153.4',
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    buildEnvironment: () => ({ OPENSSL_ia32cap: undefined, CODEX_HOME: '/profiles/conta-a' }),
    reasoningEffort: 'high',
  });

  await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });

  assert.ok(calls.length >= 3, 'help, exec help and the run itself');
  for (const call of calls) {
    assert.ok(call.env, `${(call.args ?? []).join(' ')} ran with no environment overlay`);
    assert.equal(call.env!.CODEX_HOME, '/profiles/conta-a');
    assert.ok(
      'OPENSSL_ia32cap' in call.env!,
      `${(call.args ?? []).join(' ')} did not carry the drop policy`,
    );
    assert.equal(call.env!.OPENSSL_ia32cap, undefined);
  }
});

test('a Codex that aborts at start-up is reported as incompatible, not as lacking a headless mode', async () => {
  // Exactly the reported machine, minus the fix: `--help` never reaches main.
  const { manager, calls } = scriptedProcessManager({
    '--help': { exitCode: 0xc0000409, stderr: AWS_LC_ABORT },
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  const error = await failureOf(adapter);
  assert.equal(error.reason, 'EXECUTABLE_INCOMPATIBLE');
  assert.doesNotMatch(error.userMessage, /modo não interativo/);
  assert.match(error.userMessage, /não conseguiu iniciar neste computador/);
  // The evidence a person can act on: the code, and the variable that caused it.
  assert.match(error.userMessage, /0xC0000409|EXECUTABLE_INCOMPATIBLE/i);
  assert.match(error.userMessage, /OPENSSL_ia32cap/);
  // And the second probe is never spent on a binary that could not answer the first.
  assert.equal(calls.filter((c) => (c.args ?? [])[0] === 'exec').length, 0);
});

test('a probe that timed out, was killed, or could not be spawned is never a capability verdict', async () => {
  const cases: [Partial<ProcessResult>, string][] = [
    [{ outcome: 'timeout', exitCode: null, signal: 'SIGKILL' }, 'PROBE_TIMEOUT'],
    [{ outcome: 'cancelled', exitCode: null, signal: 'SIGTERM' }, 'PROCESS_ABORTED'],
    [{ outcome: 'spawn-error', exitCode: null, error: 'spawn ENOENT' }, 'EXECUTABLE_NOT_FOUND'],
    [{ outcome: 'completed', exitCode: null, signal: 'SIGABRT' }, 'EXECUTABLE_INCOMPATIBLE'],
    [{ outcome: 'completed', exitCode: 1, stderr: 'error: something else went wrong' }, 'PROBE_FAILED'],
  ];
  for (const [result, reason] of cases) {
    const { manager } = scriptedProcessManager({ '--help': result });
    const adapter = new CodexAdapter({
      processManager: manager,
      resolveExecutable: async () => '/managed/codex.exe',
    });
    const error = await failureOf(adapter);
    assert.equal(error.reason, reason, JSON.stringify(result));
    assert.doesNotMatch(error.userMessage, /modo não interativo/, JSON.stringify(result));
  }
});

test('a failed probe is not cached: the next run asks the binary again', async () => {
  // The machine that was busy, or the antivirus that held the file for one
  // scan, must not condemn the installation for the life of the process.
  let attempt = 0;
  const manager = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      const key = (options.args ?? []).join(' ');
      if (key === '--help') {
        attempt += 1;
        if (attempt === 1) {
          return { outcome: 'timeout', exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', durationMs: 1, truncated: false } as ProcessResult;
        }
        return { outcome: 'completed', exitCode: 0, signal: null, stdout: CODEX_HELP, stderr: '', durationMs: 1, truncated: false } as ProcessResult;
      }
      const stdout = key === 'exec --help' ? CODEX_EXEC_HELP : '';
      return { outcome: 'completed', exitCode: 0, signal: null, stdout, stderr: '', durationMs: 1, truncated: false } as ProcessResult;
    },
    async cancelAll(): Promise<void> {},
    get liveCount(): number {
      return 0;
    },
  } as unknown as ProcessManager;

  const adapter = new CodexAdapter({ processManager: manager, resolveExecutable: async () => '/managed/codex.exe' });
  const error = await failureOf(adapter);
  assert.equal(error.reason, 'PROBE_TIMEOUT');
  const result = await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 2 });
  assert.equal(result.outcome, 'completed');
  assert.equal(attempt, 2);
});

test('`exec` is confirmed by the subcommand answering, not only by the parent page listing it', async () => {
  // A help layout this parser does not recognise is a parser problem, not a
  // missing feature. Asking `codex exec --help` puts the question to the CLI.
  const unfamiliarTopLevel = 'codex 0.153.4\nRun `codex <command>` for more.\n';
  const { manager, calls } = fakeProcessManager({
    '--help': unfamiliarTopLevel,
    'exec --help': CODEX_EXEC_HELP,
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  const result = await adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual((calls.at(-1)!.args ?? []).slice(0, 2), ['exec', '--skip-git-repo-check']);
});

test('a Codex that really has no `exec` is still refused, and says so', async () => {
  // The check must not have been loosened into "always run": a build whose
  // parent page lists other commands and whose `exec` is rejected outright is
  // the one case the original sentence was written for.
  const withoutExec = `Usage: codex [OPTIONS] [PROMPT]

Commands:
  login    Manage login
  help     Print this message

Options:
  -h, --help   Print help
`;
  const { manager } = scriptedProcessManager({
    '--help': { stdout: withoutExec },
    'exec --help': { exitCode: 2, stderr: "error: unrecognized subcommand 'exec'\n" },
  });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
  });

  const error = await failureOf(adapter);
  assert.equal(error.reason, 'CAPABILITY_UNSUPPORTED');
  assert.match(error.userMessage, /não oferece um modo não interativo/);
});

test('the version read and the health check run under the overlay too', async () => {
  const { manager, calls } = fakeProcessManager({ '--version': 'codex-cli 0.153.4' });
  const adapter = new CodexAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/codex.exe',
    buildEnvironment: () => ({ OPENSSL_ia32cap: undefined }),
  });

  await adapter.healthCheck();
  await adapter.supportedEfforts('/work');
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.ok(call.env && 'OPENSSL_ia32cap' in call.env, `${(call.args ?? []).join(' ')} lost the drop policy`);
  }
});

test('a Claude Code probe that failed is not reported as lacking a headless mode either', async () => {
  const { manager } = scriptedProcessManager({
    '--help': { outcome: 'spawn-error', exitCode: null, error: 'spawn ENOENT' },
  });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude.exe',
    buildEnvironment: () => ({}),
  });
  await assert.rejects(
    adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeCapabilityError);
      assert.equal(error.reason, 'EXECUTABLE_NOT_FOUND');
      assert.doesNotMatch(error.userMessage, /modo não interativo/);
      return true;
    },
  );
});

test('a Claude Code build with no --print is still refused', async () => {
  const { manager } = scriptedProcessManager({
    '--help': { stdout: 'Usage: claude [options]\n\nOptions:\n      --version   Output the version number\n' },
  });
  const adapter = new ClaudeCodeAdapter({
    processManager: manager,
    resolveExecutable: async () => '/managed/claude.exe',
    buildEnvironment: () => ({}),
  });
  await assert.rejects(
    adapter.run({ prompt: 'p', workingDirectory: '/work', timeoutMs: 1000, runId: 'r', iteration: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeCapabilityError);
      assert.equal(error.reason, 'CAPABILITY_UNSUPPORTED');
      return true;
    },
  );
});
