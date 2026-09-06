/**
 * The concrete runtimes the application manages.
 *
 * Each one only declares its identity, its executable names and its ordered
 * source list; everything else - detection, staged install, atomic promotion,
 * health check - comes from `ManagedRuntime`.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { ManagedRuntime, type ManagedRuntimeOptions } from './managed-runtime.js';
import { defaultClaudeSources } from './sources/claude-sources.js';
import { defaultCodexSources } from './sources/codex-sources.js';
import { defaultGitSources } from './sources/git-sources.js';
import type { RuntimeId, RuntimeSource } from './types.js';

export class CodexRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'codex';
  readonly displayName = 'Codex';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['codex'] as const;
  protected override readonly homeEnvVar = 'CODEX_HOME';

  constructor(options: ManagedRuntimeOptions = {}) {
    super(options);
    this.sources = defaultCodexSources(options.fetchImpl ?? fetch);
  }
}

export class ClaudeCodeRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['claude'] as const;
  protected override readonly homeEnvVar = 'CLAUDE_CONFIG_DIR';

  constructor(options: ManagedRuntimeOptions = {}) {
    super(options);
    this.sources = defaultClaudeSources(options.fetchImpl ?? fetch);
  }
}

/**
 * Git, needed for evidence collection and for cloning a workspace.
 *
 * The user is not expected to have Git installed. On Windows the application
 * prepares MinGit, the portable build Git for Windows publishes for embedding.
 *
 * MinGit is GPL-2.0: its licence files ship inside the extracted tree and are
 * recorded in the manifest, so the notices travel with the copy we install.
 */
export class GitRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'git';
  readonly displayName = 'Git';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['git'] as const;

  constructor(options: ManagedRuntimeOptions = {}) {
    super(options);
    this.sources = defaultGitSources(options.fetchImpl ?? fetch);
  }

  /**
   * Git prints `git version 2.47.0.windows.1`; the capability check only needs
   * to know the executable answers, which the base implementation covers.
   */
  protected override licenseFilesIn(root: string): string[] {
    return findLicenseFiles(root);
  }
}

/** Locates licence and notice files so they can be preserved and recorded. */
function findLicenseFiles(root: string): string[] {
  const wanted = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.[A-Za-z0-9]+)?$/i;
  const found: string[] = [];
  const stack: string[] = [root];
  let visited = 0;

  while (stack.length > 0 && visited < 5000) {
    const dir = stack.pop()!;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.test(entry.name)) found.push(relative(root, full));
    }
  }
  return found.sort();
}
