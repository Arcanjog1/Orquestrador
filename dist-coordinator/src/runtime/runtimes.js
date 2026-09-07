/**
 * The concrete runtimes the application manages.
 *
 * Each one only declares its identity, its executable names and its ordered
 * source list; everything else - detection, staged install, atomic promotion,
 * health check - comes from `ManagedRuntime`.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ManagedRuntime } from './managed-runtime.js';
import { defaultClaudeSources } from './sources/claude-sources.js';
import { defaultCodexSources } from './sources/codex-sources.js';
import { defaultGitSources } from './sources/git-sources.js';
export class CodexRuntime extends ManagedRuntime {
    id = 'codex';
    displayName = 'Codex';
    sources;
    systemExecutableNames = ['codex'];
    homeEnvVar = 'CODEX_HOME';
    constructor(options = {}) {
        super(options);
        this.sources = defaultCodexSources(options.fetchImpl ?? fetch);
    }
}
export class ClaudeCodeRuntime extends ManagedRuntime {
    id = 'claude-code';
    displayName = 'Claude Code';
    sources;
    systemExecutableNames = ['claude'];
    homeEnvVar = 'CLAUDE_CONFIG_DIR';
    constructor(options = {}) {
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
    id = 'git';
    displayName = 'Git';
    sources;
    systemExecutableNames = ['git'];
    constructor(options = {}) {
        super(options);
        this.sources = defaultGitSources(options.fetchImpl ?? fetch);
    }
    /**
     * Git prints `git version 2.47.0.windows.1`; the capability check only needs
     * to know the executable answers, which the base implementation covers.
     */
    licenseFilesIn(root) {
        return findLicenseFiles(root);
    }
}
/** Locates licence and notice files so they can be preserved and recorded. */
function findLicenseFiles(root) {
    const wanted = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.[A-Za-z0-9]+)?$/i;
    const found = [];
    const stack = [root];
    let visited = 0;
    while (stack.length > 0 && visited < 5000) {
        const dir = stack.pop();
        visited += 1;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory())
                stack.push(full);
            else if (wanted.test(entry.name))
                found.push(relative(root, full));
        }
    }
    return found.sort();
}
//# sourceMappingURL=runtimes.js.map