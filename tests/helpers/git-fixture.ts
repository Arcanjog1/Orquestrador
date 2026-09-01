/**
 * Builds throwaway git repositories for tests.
 *
 * Uses the real git binary: the evidence collector's whole job is parsing real
 * git output, so faking it would test nothing worth testing.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitFixture {
  dir: string;
  write(relativePath: string, contents: string): void;
  git(...args: string[]): string;
  commitAll(message: string): void;
  head(): string;
  cleanup(): void;
}

export function createGitFixture(prefix = 'lao-git-'): GitFixture {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  const write = (relativePath: string, contents: string): void => {
    const full = join(dir, relativePath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  };

  return {
    dir,
    write,
    git,
    commitAll(message: string): void {
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    head(): string {
      return git('rev-parse', 'HEAD').trim();
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A non-git directory, for the "project is not a repository" paths. */
export function createPlainDir(prefix = 'lao-plain-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
