/**
 * Where the Claude Code runtime can come from, in order of preference.
 *
 * Two constraints shape this list:
 *
 *  - Claude Code's npm licence reads "SEE LICENSE IN README.md", which is not a
 *    permissive open-source licence. The application therefore **never**
 *    redistributes it inside the installer; it only fetches it, on the user's
 *    machine, from a source Anthropic serves.
 *  - A host string observed inside the shipped binary is an implementation
 *    detail, not a supported interface. Such a source is marked
 *    NOT_PUBLIC_CONTRACT and sits last, behind the documented ones.
 */

import { existsSync } from 'node:fs';
import type { ResolvedDownload, RuntimeSource, RuntimeTarget } from '../types.js';

export function claudeExecutableNames(target: RuntimeTarget): string[] {
  return target.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
}

/**
 * The installer Anthropic publishes for end users.
 *
 * This is the documented path and is tried first. The application runs the
 * download itself rather than asking the user to paste a command into a shell.
 */
export class ClaudeOfficialInstallerSource implements RuntimeSource {
  readonly id = 'claude-official-installer';
  readonly label = 'Instalador oficial da Anthropic';
  readonly contract = 'DOCUMENTED' as const;

  constructor(
    private readonly manifestUrl = 'https://claude.ai/install-manifest.json',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(target: RuntimeTarget): Promise<ResolvedDownload | null> {
    let manifest: unknown;
    try {
      const response = await this.fetchImpl(this.manifestUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      manifest = await response.json();
    } catch {
      return null;
    }
    return readClaudeManifest(manifest, target, claudeExecutableNames(target));
  }
}

/**
 * The release host the official installer uses internally.
 *
 * IMPORTANT: this is an implementation detail discovered inside the shipped
 * binary, not a published API. It is kept as a controlled last resort so a user
 * is not left stranded, and it is labelled so that no one mistakes it for a
 * contract. If the documented source works, this is never reached.
 */
export class ClaudeReleaseHostSource implements RuntimeSource {
  readonly id = 'claude-release-host';
  readonly label = 'Host de release usado pelo instalador oficial';
  readonly contract = 'NOT_PUBLIC_CONTRACT' as const;

  constructor(
    private readonly baseUrl = 'https://downloads.claude.ai/claude-code-releases',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(target: RuntimeTarget): Promise<ResolvedDownload | null> {
    let manifest: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/stable`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      manifest = await response.json();
    } catch {
      return null;
    }
    return readClaudeManifest(manifest, target, claudeExecutableNames(target), this.baseUrl);
  }
}

/**
 * An existing `claude` on the machine, used to install into the app's folder.
 *
 * `claude install <version>` is documented, but it needs a `claude` to already
 * exist - so it can update a managed install, and cannot bootstrap a clean
 * machine. It is offered only when a system installation is present.
 */
export class ClaudeSelfInstallSource implements RuntimeSource {
  readonly id = 'claude-self-install';
  readonly label = 'Comando `claude install` de uma instalação existente';
  readonly contract = 'DOCUMENTED' as const;

  constructor(private readonly systemExecutable: string | null) {}

  async resolve(): Promise<ResolvedDownload | null> {
    // Reports availability only; the manager runs the subcommand itself,
    // because this source produces no downloadable URL.
    if (!this.systemExecutable || !existsSync(this.systemExecutable)) return null;
    return null;
  }

  /** True when this machine could bootstrap from an existing installation. */
  get available(): boolean {
    return Boolean(this.systemExecutable && existsSync(this.systemExecutable));
  }
}

export function defaultClaudeSources(fetchImpl: typeof fetch = fetch): RuntimeSource[] {
  return [
    new ClaudeOfficialInstallerSource(undefined, fetchImpl),
    // Deliberately last: see the class comment.
    new ClaudeReleaseHostSource(undefined, fetchImpl),
  ];
}

/**
 * Reads a release manifest into a download.
 *
 * Accepts a couple of common shapes and declines on anything else, so an
 * unexpected response can never turn into a guessed URL.
 */
function readClaudeManifest(
  manifest: unknown,
  target: RuntimeTarget,
  executableNames: string[],
  baseUrl?: string,
): ResolvedDownload | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const root = manifest as Record<string, unknown>;

  const version =
    typeof root.version === 'string'
      ? root.version
      : typeof root.latest === 'string'
        ? root.latest
        : null;
  if (!version) return null;

  const key = `${target.platform}-${target.arch}`;
  const platforms = (root.platforms ?? root.builds) as Record<string, unknown> | undefined;

  let url: string | null = null;
  let integrity: string | undefined;

  if (platforms && typeof platforms === 'object') {
    const entry = platforms[key];
    if (typeof entry === 'string') {
      url = entry;
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      if (typeof record.url === 'string') url = record.url;
      if (typeof record.checksum === 'string') integrity = record.checksum;
      if (typeof record.integrity === 'string') integrity = record.integrity;
    }
  }

  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    if (!baseUrl) return null;
    url = `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  }

  return {
    url,
    version,
    archiveKind: url.endsWith('.zip') ? 'zip' : url.endsWith('.exe') ? 'raw' : 'tgz',
    executableNames,
    ...(integrity ? { integrity } : {}),
  };
}
