/**
 * Telling a busy agent from a stuck one (spec 15).
 *
 * The user's actual complaint was not a crash. It was a window that said
 * "executando automaticamente" and never said anything else. These tests pin
 * the two halves of the fix: that a silent child is stopped and named, and
 * that a working one is describable while it works.
 *
 * The processes here are real, because the thing being tested is what happens
 * to a real child that stops talking. They are also small and bounded, so the
 * suite stays fast.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../src/process/process-manager.js';
import {
  ActivityMonitor,
  describeActivity,
  formatDuration,
  readStreamEvents,
} from '../src/agents/activity-monitor.js';
import { isMechanicalFailure } from '../src/routing/task-assessment.js';

const node = process.execPath;

test('a child that says nothing is stopped for silence, and the reason says so', async () => {
  const manager = new ProcessManager();
  const result = await manager.run({
    command: node,
    // Alive, healthy, and completely silent - the shape of the original hang.
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
    cwd: process.cwd(),
    idleTimeoutMs: 300,
    timeoutMs: 30_000,
  });

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.trace?.idleTimedOut, true, 'the stall must be distinguishable from a hard timeout');
  assert.match(result.error ?? '', /no output for/);
  // It stopped because of silence, not because 30s elapsed.
  assert.ok(result.durationMs < 10_000, `stopped after ${result.durationMs}ms`);
});

test('a child that keeps talking is left alone past the idle window', async () => {
  const manager = new ProcessManager();
  const result = await manager.run({
    command: node,
    // Slower than the idle timeout overall, but never silent for that long.
    args: [
      '-e',
      'let n = 0; const t = setInterval(() => { console.log("tick"); if (++n === 8) { clearInterval(t); } }, 100)',
    ],
    cwd: process.cwd(),
    idleTimeoutMs: 400,
    timeoutMs: 30_000,
  });

  assert.equal(result.outcome, 'completed', result.error ?? '');
  assert.equal(result.trace?.idleTimedOut, false);
  assert.equal(result.stdout.trim().split('\n').length, 8);
  assert.ok(result.durationMs >= 700, 'it really did outlive a single idle window');
});

test('a child that never starts is stopped, and the reason says it never started', async () => {
  const manager = new ProcessManager();
  const result = await manager.run({
    command: node,
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
    cwd: process.cwd(),
    idleTimeoutMs: 200,
  });
  assert.equal(result.trace?.idleTimedOut, true);
  assert.equal(result.trace?.lastActivityAt, null);
  assert.match(result.error ?? '', /never started/);
});

test('activity is reported while the child works, not only at the end', async () => {
  const manager = new ProcessManager();
  const seen: Date[] = [];
  const result = await manager.run({
    command: node,
    args: [
      '-e',
      'let n = 0; const t = setInterval(() => { console.log("x"); if (++n === 6) clearInterval(t); }, 120)',
    ],
    cwd: process.cwd(),
    idleTimeoutMs: 2_000,
    onActivity: (at) => seen.push(at),
  });

  assert.equal(result.outcome, 'completed');
  assert.ok(seen.length >= 1, 'the interface must hear about activity as it happens');
  assert.ok(result.trace?.lastActivityAt, 'and the last moment of life is recorded');
});

test('the idle timeout does not fire on a child that finishes quickly', async () => {
  const manager = new ProcessManager();
  const result = await manager.run({
    command: node,
    args: ['-e', 'console.log("done")'],
    cwd: process.cwd(),
    idleTimeoutMs: 5_000,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.trace?.idleTimedOut, false);
});

/* ------------------------------------------------------------------ *
 * The monitor
 * ------------------------------------------------------------------ */

/** A clock the test moves by hand, rather than one that counts calls. */
function movable(start: string) {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    set(at: string) {
      current = Date.parse(at);
    },
  };
}

test('a snapshot separates how long it has run from how long it has been silent', () => {
  const started = new Date('2026-01-01T00:00:00.000Z');
  const clock = movable('2026-01-01T00:00:05.000Z');
  const monitor = new ActivityMonitor(started, { idleTimeoutMs: 60_000, now: clock.now });
  monitor.note('tool', 'Write');
  clock.set('2026-01-01T00:10:00.000Z');

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.elapsedMs, 600_000, 'ten minutes of work');
  assert.equal(snapshot.idleMs, 595_000, 'but silent for almost all of it');
  assert.equal(snapshot.currentTool, 'Write');
  assert.equal(snapshot.idleTimeoutMs, 60_000);
});

test('a result clears the tool, so the screen never names one the agent has left', () => {
  const monitor = new ActivityMonitor(new Date());
  monitor.note('tool', 'Bash');
  assert.equal(monitor.snapshot().currentTool, 'Bash');
  monitor.note('result', 'ok');
  assert.equal(monitor.snapshot().currentTool, null);
});

test('output nobody can parse still counts as being alive', () => {
  const monitor = new ActivityMonitor(new Date());
  monitor.observe('some plain text a future build printed\n');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0]!.kind, 'output');
  // Bytes arriving are the evidence of life; the label is a bonus.
  assert.match(snapshot.recent[0]!.detail, /future build/);
});

test('an empty chunk is not activity', () => {
  const monitor = new ActivityMonitor(new Date());
  monitor.observe('   \n\n');
  assert.equal(monitor.snapshot().recent.length, 0);
});

test('the stream reader names tools and nothing else about them', () => {
  const notes = readStreamEvents(
    [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              // The argument carries the person's own text. It must not reach a
              // status line, a log, or the renderer.
              input: { file_path: 'C:/Users/segredo/hello.txt', content: 'pronto' },
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', is_error: false, result: 'pronto' }),
    ].join('\n'),
  );

  assert.deepEqual(
    notes.map((note) => [note.kind, note.detail]),
    [
      ['started', 'sessão iniciada'],
      ['tool', 'Write'],
      ['result', 'execução concluída'],
    ],
  );
  const rendered = JSON.stringify(notes);
  assert.ok(!rendered.includes('segredo'), 'tool arguments must never be echoed');
  assert.ok(!rendered.includes('hello.txt'), 'tool arguments must never be echoed');
});

test('an errored result is an error note, not a completion', () => {
  const notes = readStreamEvents(JSON.stringify({ type: 'result', is_error: true }));
  assert.equal(notes[0]!.kind, 'error');
});

test('malformed lines in the stream are skipped without losing the good ones', () => {
  const notes = readStreamEvents(
    ['{not json', '', 'plain text', JSON.stringify({ type: 'result', is_error: false })].join('\n'),
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.kind, 'result');
});

test('the monitor knows when it has stalled, and does not claim so without a limit', () => {
  const started = new Date('2026-01-01T00:00:00.000Z');
  const withLimit = new ActivityMonitor(started, {
    idleTimeoutMs: 1_000,
    now: () => new Date('2026-01-01T00:00:30.000Z'),
  });
  assert.equal(withLimit.stalled, true);

  const withoutLimit = new ActivityMonitor(started, {
    now: () => new Date('2026-01-01T09:00:00.000Z'),
  });
  assert.equal(withoutLimit.stalled, false, 'no limit means no verdict, not "stuck"');
});

test('the sentence on screen says the two things a person needs', () => {
  const started = new Date('2026-01-01T00:00:00.000Z');
  const clock = movable('2026-01-01T00:00:10.000Z');
  const monitor = new ActivityMonitor(started, { now: clock.now });
  monitor.note('tool', 'Bash');
  clock.set('2026-01-01T00:05:00.000Z');

  const line = describeActivity(monitor.snapshot());
  assert.match(line, /executando há 5m00s/);
  assert.match(line, /ferramenta: Bash/);
  assert.match(line, /sem atividade há 4m50s/);
});

test('a healthy fast run is not described as suspicious', () => {
  const started = new Date('2026-01-01T00:00:00.000Z');
  const monitor = new ActivityMonitor(started, {
    now: () => new Date('2026-01-01T00:00:03.000Z'),
  });
  const line = describeActivity(monitor.snapshot());
  assert.match(line, /executando há 3s/);
  assert.ok(!line.includes('sem atividade'), 'three seconds of quiet is not a symptom');
});

test('durations read the way a person would say them', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m30s');
  assert.equal(formatDuration(3_600_000), '1h00m');
  assert.equal(formatDuration(-5), '0s');
});

test('the monitor keeps only the recent past', () => {
  const monitor = new ActivityMonitor(new Date());
  for (let index = 0; index < 50; index += 1) monitor.note('output', `n${index}`);
  const recent = monitor.snapshot().recent;
  assert.equal(recent.length, 20);
  assert.equal(recent.at(-1)!.detail, 'n49');
});

test('a watcher that throws does not break the run it is watching', () => {
  const monitor = new ActivityMonitor(new Date(), {
    onChange: () => {
      throw new Error('the window went away');
    },
  });
  assert.doesNotThrow(() => monitor.note('output', 'x'));
});

/* ------------------------------------------------------------------ *
 * What the loop does with silence
 * ------------------------------------------------------------------ */

test('silence never buys a stronger model', () => {
  // The reflex this product already removed for refused permissions is wrong
  // here for the same reason: no model unsticks a stopped process.
  assert.equal(
    isMechanicalFailure({
      outcome: 'timeout',
      exitCode: 1,
      stdout: '',
      stderr: '',
      failure: 'no-activity',
    }),
    true,
  );
});
