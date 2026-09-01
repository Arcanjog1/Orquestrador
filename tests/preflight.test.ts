import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight, scanPath } from '../src/preflight/preflight.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'lao-preflight-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scanPath honours PATHEXT on Windows', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'codex.cmd'), '');
    const found = scanPath('codex', dir, 'win32', '.COM;.EXE;.BAT;.CMD');
    assert.equal(found, join(dir, 'codex.cmd'));
  });
});

test('scanPath does not append extensions when the command already has one', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'codex.cmd'), '');
    assert.equal(scanPath('codex.cmd', dir, 'win32', '.CMD'), join(dir, 'codex.cmd'));
    assert.equal(scanPath('codex.exe', dir, 'win32', '.CMD'), null);
  });
});

test('scanPath searches every PATH entry in order', () => {
  withTempDir((a) => {
    withTempDir((b) => {
      writeFileSync(join(b, 'tool.exe'), '');
      const found = scanPath('tool', [a, b].join(';'), 'win32', '.EXE');
      assert.equal(found, join(b, 'tool.exe'));
    });
  });
});

test('scanPath returns null when PATH is empty or the tool is absent', () => {
  assert.equal(scanPath('anything', undefined, 'linux'), null);
  withTempDir((dir) => {
    assert.equal(scanPath('missing-tool', dir, 'linux'), null);
  });
});

test('scanPath requires the executable bit on POSIX', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX-only');
  withTempDir((dir) => {
    const file = join(dir, 'tool');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    assert.equal(scanPath('tool', dir, 'linux'), null);
    chmodSync(file, 0o755);
    assert.equal(scanPath('tool', dir, 'linux'), file);
  });
});

test('preflight passes for node and git alone when agents are mocked', async () => {
  const result = await runPreflight({
    checkCodex: false,
    checkClaude: false,
    codexCommand: 'codex',
    claudeCommand: 'claude',
    cwd: process.cwd(),
  });
  assert.equal(result.checks.length, 2);
  assert.equal(result.ok, true, result.summary);
  assert.match(result.checks[0]!.version ?? '', /^v?\d+\./);
});

test('preflight fails with an actionable message when a CLI is missing', async () => {
  const result = await runPreflight({
    checkCodex: true,
    checkClaude: false,
    codexCommand: 'codex-that-does-not-exist-xyz',
    claudeCommand: 'claude',
    cwd: process.cwd(),
  });
  assert.equal(result.ok, false);
  const codex = result.checks.find((c) => c.label.startsWith('Codex'));
  assert.equal(codex?.found, false);
  assert.match(result.summary, /Preflight failed/);
  assert.match(result.summary, /not found on PATH/);
  // The hint tells the user exactly what to change.
  assert.match(result.summary, /codexCommand/);
});
