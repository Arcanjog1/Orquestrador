import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildChildEnv,
  buildSpawnPlan,
  ProcessManager,
  quoteForCmd,
  UnsafeArgumentError,
} from '../src/process/process-manager.js';

// ---------------------------------------------------------------------------
// Windows argv construction. These run on any host: `buildSpawnPlan` takes the
// platform as a parameter precisely so the win32 path is testable from Linux.
// ---------------------------------------------------------------------------

test('spawns .exe and POSIX commands directly, without a shell wrapper', () => {
  const posix = buildSpawnPlan('claude', ['-p'], 'linux');
  assert.deepEqual(posix, { file: 'claude', args: ['-p'], windowsVerbatimArguments: false });

  const exe = buildSpawnPlan('C:\\tools\\codex.exe', ['--version'], 'win32');
  assert.equal(exe.file, 'C:\\tools\\codex.exe');
  assert.equal(exe.windowsVerbatimArguments, false);
});

test('wraps .cmd launchers in cmd.exe /d /s /c on Windows', () => {
  const plan = buildSpawnPlan('claude.cmd', ['-p', '--output-format', 'json'], 'win32', 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.args[3], '"\\"claude.cmd\\" \\"-p\\" \\"--output-format\\" \\"json\\""'.replace(/\\"/g, '"'));
});

test('wraps .bat the same way, case-insensitively', () => {
  const plan = buildSpawnPlan('runner.BAT', [], 'win32');
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
});

test('.cmd on a non-Windows platform is spawned directly', () => {
  const plan = buildSpawnPlan('thing.cmd', ['a'], 'linux');
  assert.equal(plan.file, 'thing.cmd');
  assert.equal(plan.windowsVerbatimArguments, false);
});

test('quotes paths containing spaces', () => {
  assert.equal(quoteForCmd('C:\\Program Files\\claude.cmd'), '"C:\\Program Files\\claude.cmd"');
});

test('escapes embedded double quotes', () => {
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
});

test('doubles trailing backslashes so they do not escape the closing quote', () => {
  assert.equal(quoteForCmd('C:\\dir\\'), '"C:\\dir\\\\"');
});

test('refuses arguments that cmd.exe would mangle', () => {
  assert.throws(() => quoteForCmd('%USERPROFILE%\\x'), UnsafeArgumentError);
  assert.throws(() => quoteForCmd('line1\nline2'), UnsafeArgumentError);
  assert.throws(() => quoteForCmd('nul\0byte'), UnsafeArgumentError);
  // A lone percent is fine - it is only variable references that expand.
  assert.doesNotThrow(() => quoteForCmd('100% done'));
});

// ---------------------------------------------------------------------------
// Child environment
// ---------------------------------------------------------------------------

test('buildChildEnv overlays values and deletes undefined keys', () => {
  const base = { KEEP: 'yes', DROP: 'secret' } as NodeJS.ProcessEnv;
  const env = buildChildEnv({ ADDED: 'new', DROP: undefined }, base);
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.ADDED, 'new');
  assert.equal('DROP' in env, false);
});

// ---------------------------------------------------------------------------
// Live process behaviour
// ---------------------------------------------------------------------------

test('captures stdout, stderr and exit code', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'],
    cwd: process.cwd(),
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.ok(result.durationMs >= 0);
});

test('delivers the prompt over stdin rather than the command line', async () => {
  const pm = new ProcessManager();
  const prompt = 'a prompt with "quotes", $VARS, | pipes && ampersands\nand newlines';
  const result = await pm.run({
    command: process.execPath,
    args: [
      '-e',
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d))',
    ],
    cwd: process.cwd(),
    stdin: prompt,
  });
  assert.equal(result.exitCode, 0);
  // Round-tripped verbatim: no shell ever saw it.
  assert.equal(result.stdout, prompt);
});

test('reports a missing command as a spawn error, not a crash', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({
    command: 'definitely-not-a-real-command-xyz',
    cwd: process.cwd(),
  });
  assert.equal(result.outcome, 'spawn-error');
  assert.match(result.error ?? '', /not found/i);
});

test('kills a process that exceeds its timeout', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    timeoutMs: 300,
    graceMs: 300,
  });
  assert.equal(result.outcome, 'timeout');
  assert.match(result.error ?? '', /timeout/i);
  assert.equal(pm.liveCount, 0);
});

test('an AbortSignal cancels the process', async () => {
  const pm = new ProcessManager();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const result = await pm.run({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    signal: controller.signal,
    graceMs: 300,
  });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(pm.liveCount, 0);
});

test('cancelAll stops live children and leaves nothing running', async () => {
  const pm = new ProcessManager();
  const running = pm.run({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    graceMs: 300,
  });
  // Give the child a moment to actually spawn.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pm.liveCount, 1);
  await pm.cancelAll(300);
  const result = await running;
  assert.notEqual(result.outcome, 'completed');
  assert.equal(pm.liveCount, 0);
  assert.equal(pm.isCancelled, true);
});

test('a cancelled manager refuses to start new processes', async () => {
  const pm = new ProcessManager();
  await pm.cancelAll(100);
  const result = await pm.run({ command: process.execPath, args: ['-e', ''], cwd: process.cwd() });
  assert.equal(result.outcome, 'cancelled');
  pm.reset();
  assert.equal(pm.isCancelled, false);
});

test('kills the whole process tree, leaving no orphan still running', async () => {
  const pm = new ProcessManager();
  const dir = mkdtempSync(join(tmpdir(), 'lao-tree-'));
  const beat = join(dir, 'heartbeat');
  try {
    // The parent spawns a grandchild that touches a file every 50ms. Checking
    // the heartbeat - rather than `kill(pid, 0)` - is what actually proves the
    // grandchild stopped: an orphan reparented to init lingers as a zombie,
    // and signalling a zombie succeeds even though nothing is running.
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(beat)}, String(Date.now())); setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 50)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;

    const running = pm.run({
      command: process.execPath,
      args: ['-e', parent],
      cwd: process.cwd(),
      graceMs: 500,
    });

    await new Promise((r) => setTimeout(r, 400));
    assert.ok(existsSync(beat), 'grandchild never started beating');

    await pm.cancelAll(500);
    await running;

    // Let any in-flight beat land, then confirm the heartbeat has stopped.
    await new Promise((r) => setTimeout(r, 300));
    const afterKill = readFileSync(beat, 'utf8');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(readFileSync(beat, 'utf8'), afterKill, 'grandchild kept running after cancellation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('truncates output beyond the cap instead of growing without bound', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(50000))'],
    cwd: process.cwd(),
    maxOutputBytes: 1000,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.includes('truncated'));
});

// ---------------------------------------------------------------------------
// The lifecycle trace: what a person reads when a child "did not answer".
// ---------------------------------------------------------------------------

test('the trace records PID, start, first output, exit and close for an ordinary run', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello"); process.stderr.write("warn")'],
    cwd: process.cwd(),
  });
  const t = result.trace;
  assert.equal(t.pid, typeof t.pid === 'number' ? t.pid : null);
  assert.equal(typeof t.pid, 'number');
  assert.ok(t.startedAt, 'the spawn event was seen');
  assert.ok(t.firstStdoutAt && t.firstStderrAt);
  assert.equal(t.stdoutBytes, 5);
  assert.equal(t.stderrBytes, 4);
  assert.ok(t.exitedAt && t.closedAt, 'exit and close both arrived');
  assert.equal(t.streamsLingered, false);
  assert.equal(t.termination, null);
  assert.equal(t.errorCode, null);
});

test('a refused spawn carries the error code in the trace', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({ command: join(tmpdir(), 'no-such-program-xyz'), cwd: process.cwd() });
  assert.equal(result.outcome, 'spawn-error');
  assert.equal(result.trace.errorCode, 'ENOENT');
  assert.equal(result.trace.pid === null || typeof result.trace.pid === 'number', true);
  assert.ok(result.trace.errorAt);
});

test('a timeout records every stop attempt and whether the child was gone', async () => {
  const pm = new ProcessManager();
  const result = await pm.run({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    timeoutMs: 500,
    graceMs: 2000,
  });
  assert.equal(result.outcome, 'timeout');
  const termination = result.trace.termination;
  assert.ok(termination, 'the trace says how the child was stopped');
  assert.equal(termination.reason, 'timeout');
  assert.ok(termination.attempts.length >= 1);
  // Windows: the polite taskkill may not reach a console child; the forced
  // one does, and both are on record because `run` waits for the stop.
  assert.equal(termination.attempts[termination.attempts.length - 1]!.exited, true, 'the last attempt found the child gone');
  assert.equal(result.trace.survivedTermination, false);
});

test('a child that exits while a grandchild keeps its pipes still settles, with the output so far', async () => {
  const pm = new ProcessManager();
  // The grandchild inherits stdout and lives on, so `close` would wait for it.
  const grandchild = 'setTimeout(() => {}, 20000)';
  const parent = `process.stdout.write("codex-cli 0.153.4\\n"); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();`;
  const started = Date.now();
  const result = await pm.run({ command: process.execPath, args: ['-e', parent], cwd: process.cwd(), timeoutMs: 15_000 });
  const took = Date.now() - started;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'codex-cli 0.153.4\n');
  assert.equal(result.trace.streamsLingered, true, 'exit came, close did not');
  assert.ok(result.trace.exitedAt && !result.trace.closedAt);
  assert.ok(took >= 4500 && took < 14_000, `settled after the exit/close grace, not the timeout: ${took} ms`);
  await pm.cancelAll();
});
