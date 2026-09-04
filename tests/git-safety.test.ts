import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadOnlyGitArgs,
  CommandParseError,
  parseCommandLine,
  screenCommand,
  UnsafeGitCommandError,
} from '../src/git/git-safety.js';

test('refuses every destructive git command listed in the spec', () => {
  const forbidden = [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git push --force',
    'git push origin main',
    'git checkout -- .',
    'git restore .',
    'git branch -D feature',
    'git commit -m "wip"',
    'git merge main',
    'git rebase main',
    'git stash',
  ];
  for (const command of forbidden) {
    const screen = screenCommand(command);
    assert.equal(screen.safe, false, `should refuse: ${command}`);
    assert.ok(screen.reason, `should explain refusal of: ${command}`);
  }
});

test('allows read-only git commands and ordinary test runners', () => {
  const allowed = [
    'git status --short',
    'git diff --stat',
    'git log --oneline -5',
    'git clean -n',
    'git branch --show-current',
    'git restore --staged',
    'npm test',
    'npm run build',
    'pytest -q',
    'cargo test --all',
  ];
  for (const command of allowed) {
    assert.equal(screenCommand(command).safe, true, `should allow: ${command}`);
  }
});

test('refuses commands using shell operators, with an explanation', () => {
  for (const command of ['npm test && npm run lint', 'npm test | tail -5', 'echo hi > out.txt', 'a; b']) {
    const screen = screenCommand(command);
    assert.equal(screen.safe, false, command);
    assert.match(screen.reason ?? '', /shell operator/);
  }
});

test('recognises git regardless of how it is spelled', () => {
  assert.equal(screenCommand('git.exe reset --hard').safe, false);
  assert.equal(screenCommand('C:\\Program Files\\Git\\bin\\git.exe clean -fd').safe, false);
  assert.equal(screenCommand('/usr/bin/git push --force').safe, false);
});

test('refuses an empty command', () => {
  assert.equal(screenCommand('   ').safe, false);
});

test('the evidence collector allowlist rejects anything that could mutate', () => {
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['status', '--short']));
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['diff', '--cached']));
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['branch', '--show-current']));
  assert.throws(() => assertReadOnlyGitArgs(['reset', '--hard']), UnsafeGitCommandError);
  assert.throws(() => assertReadOnlyGitArgs(['commit', '-m', 'x']), UnsafeGitCommandError);
  assert.throws(() => assertReadOnlyGitArgs(['branch', '-D', 'x']), UnsafeGitCommandError);
  assert.throws(() => assertReadOnlyGitArgs(['config', 'user.name', 'x']), UnsafeGitCommandError);
  assert.throws(() => assertReadOnlyGitArgs([]), UnsafeGitCommandError);
});

test('parseCommandLine handles quotes without acting as a shell', () => {
  assert.deepEqual(parseCommandLine('npm test'), ['npm', 'test']);
  assert.deepEqual(parseCommandLine('npm run "test:ci"'), ['npm', 'run', 'test:ci']);
  assert.deepEqual(parseCommandLine("node -e 'a b'"), ['node', '-e', 'a b']);
  assert.deepEqual(parseCommandLine('a  \t b'), ['a', 'b']);
  // An empty quoted argument survives as an empty token.
  assert.deepEqual(parseCommandLine('cmd ""'), ['cmd', '']);
  // No expansion: a dollar sign is just a character.
  assert.deepEqual(parseCommandLine('echo "$HOME"'), ['echo', '$HOME']);
});

test('parseCommandLine reports unbalanced quotes', () => {
  assert.throws(() => parseCommandLine('npm run "broken'), CommandParseError);
});

// -- Additions made so the interface can read git context (branch, remote) ----
// Both are read-only in the forms used; the writing forms stay refused.

test('permits the reading forms of git remote', () => {
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['remote', 'get-url', 'origin']));
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['remote']));
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['remote', '-v']));
  assert.doesNotThrow(() => assertReadOnlyGitArgs(['remote', 'show', 'origin']));
});

test('still refuses every writing form of git remote', () => {
  for (const verb of ['add', 'remove', 'rm', 'rename', 'set-url', 'prune', 'update']) {
    assert.throws(
      () => assertReadOnlyGitArgs(['remote', verb, 'origin', 'https://example.invalid/x.git']),
      UnsafeGitCommandError,
      `"git remote ${verb}" must be refused`,
    );
  }
});

test('permits for-each-ref, which cannot mutate', () => {
  assert.doesNotThrow(() =>
    assertReadOnlyGitArgs(['for-each-ref', '--sort=-committerdate', 'refs/heads']),
  );
});

test('the allowlist has not quietly widened beyond those two additions', () => {
  for (const subcommand of ['push', 'commit', 'merge', 'reset', 'clean', 'checkout', 'restore']) {
    assert.throws(() => assertReadOnlyGitArgs([subcommand]), UnsafeGitCommandError);
  }
});
