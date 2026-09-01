import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { ConfigError, loadConfig, minutesToMs, normalise } from '../src/config/config.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'lao-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('falls back to defaults with a warning when no config.json exists', () => {
  withTempDir((dir) => {
    const { config, sourcePath, warnings } = loadConfig({ cwd: dir });
    assert.equal(sourcePath, null);
    assert.equal(config.maxIterations, 20);
    assert.equal(config.workspace.strategy, 'current');
    assert.equal(warnings.length, 1);
  });
});

test('loads and resolves a config file', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        projectPath: 'project',
        maxIterations: 5,
        claudeProfiles: {
          personal: { name: 'Claude Pessoal', profileDirectory: 'profiles/personal' },
        },
        defaultClaudeProfile: 'personal',
      }),
    );
    const { config, sourcePath } = loadConfig({ cwd: dir });
    assert.ok(sourcePath?.endsWith('config.json'));
    assert.equal(config.maxIterations, 5);
    assert.ok(isAbsolute(config.projectPath));
    assert.ok(isAbsolute(config.claudeProfiles.personal!.profileDirectory));
    assert.equal(config.defaultClaudeProfile, 'personal');
    // Profile command falls back to the global claudeCommand.
    assert.equal(config.claudeProfiles.personal!.command, config.claudeCommand);
  });
});

test('rejects a defaultClaudeProfile that is not defined', () => {
  assert.throws(
    () => normalise({ defaultClaudeProfile: 'ghost' }, '/tmp'),
    (err: unknown) => err instanceof ConfigError && /not defined/.test((err as Error).message),
  );
});

test('rejects an unknown workspace strategy', () => {
  assert.throws(() => normalise({ workspace: { strategy: 'kubernetes' } }, '/tmp'), ConfigError);
});

test('rejects a non-positive maxIterations', () => {
  assert.throws(() => normalise({ maxIterations: 0 }, '/tmp'), ConfigError);
  assert.throws(() => normalise({ maxIterations: 2.5 }, '/tmp'), ConfigError);
});

test('rejects an empty codexArgsTemplate but accepts a populated one', () => {
  assert.throws(() => normalise({ codexArgsTemplate: [] }, '/tmp'), ConfigError);
  const cfg = normalise({ codexArgsTemplate: ['exec', '--json'] }, '/tmp');
  assert.deepEqual(cfg.codexArgsTemplate, ['exec', '--json']);
});

test('warns when more than one worker is configured', () => {
  const warnings: string[] = [];
  const cfg = normalise(
    {
      claudeProfiles: {
        personal: { name: 'P', profileDirectory: '/abs/p' },
        work: { name: 'W', profileDirectory: '/abs/w' },
      },
      workers: [
        { id: 'worker-01', agent: 'claude-code', profile: 'personal' },
        { id: 'worker-02', agent: 'claude-code', profile: 'work' },
      ],
    },
    '/tmp',
    warnings,
  );
  assert.equal(cfg.workers.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /workers\[0\]/);
});

test('rejects a worker pointing at an undefined profile', () => {
  assert.throws(
    () => normalise({ workers: [{ id: 'w', agent: 'claude-code', profile: 'ghost' }] }, '/tmp'),
    ConfigError,
  );
});

test('reports invalid JSON with the file path', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.json'), '{ not json');
    assert.throws(
      () => loadConfig({ cwd: dir }),
      (err: unknown) => err instanceof ConfigError && /Invalid JSON/.test((err as Error).message),
    );
  });
});

test('errors when an explicit --config path is missing', () => {
  withTempDir((dir) => {
    assert.throws(() => loadConfig({ cwd: dir, configPath: 'nope.json' }), ConfigError);
  });
});

test('minutesToMs converts correctly', () => {
  assert.equal(minutesToMs(1), 60_000);
  assert.equal(minutesToMs(0.5), 30_000);
});
