/**
 * The concrete runtimes the application manages.
 *
 * Each one only declares its identity, its executable names and its ordered
 * source list; everything else - detection, staged install, atomic promotion,
 * health check - comes from `ManagedRuntime`.
 */

import { ManagedRuntime, type ManagedRuntimeOptions } from './managed-runtime.js';
import { defaultClaudeSources } from './sources/claude-sources.js';
import { defaultCodexSources } from './sources/codex-sources.js';
import type { RuntimeId, RuntimeSource } from './types.js';

export class CodexRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'codex';
  readonly displayName = 'Codex';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['codex'] as const;

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

  constructor(options: ManagedRuntimeOptions = {}) {
    super(options);
    this.sources = defaultClaudeSources(options.fetchImpl ?? fetch);
  }
}

/**
 * Git, needed for evidence collection and for cloning a workspace.
 *
 * The user is not expected to have Git installed. On Windows the application
 * prepares MinGit - the minimal redistributable build that Git for Windows
 * publishes for exactly this purpose.
 */
export class GitRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'git';
  readonly displayName = 'Git';
  readonly sources: readonly RuntimeSource[] = [];
  protected readonly systemExecutableNames = ['git'] as const;

  constructor(options: ManagedRuntimeOptions = {}) {
    super(options);
  }
}
