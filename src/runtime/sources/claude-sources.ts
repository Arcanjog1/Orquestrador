/**
 * Where the Claude Code runtime comes from.
 *
 * The layout below is not invented: it is what Anthropic's own installer does.
 * `https://claude.ai/install.sh` and `install.ps1` are the documented entry
 * points; both redirect to a bootstrap script on
 * `https://downloads.claude.ai/claude-code-releases`, and that script:
 *
 *   1. reads a plain-text version from `<base>/stable` or `<base>/latest`;
 *   2. fetches `<base>/<version>/manifest.json`, which holds
 *      `platforms["<platform>"] = { checksum: "<sha256>", size: <bytes> }`;
 *   3. downloads `<base>/<version>/<platform>/claude` - `claude.exe` on
 *      Windows - and refuses it unless the SHA-256 matches.
 *
 * This source does exactly that, with the same checksum check, so the
 * application installs the same bytes a user would get by running the official
 * command - without asking anyone to open a terminal.
 *
 * Claude Code's npm licence reads "SEE LICENSE IN README.md", which is not a
 * permissive open-source licence, so the application **never** redistributes it
 * inside the installer. It only fetches it, on the user's machine, from
 * Anthropic's own host.
 */

import { existsSync } from 'node:fs';
import type { ResolvedDownload, RuntimeSource, RuntimeTarget } from '../types.js';
import type { IntegrityStrategy } from '../integrity.js';
import type { VersionRequest } from '../compatibility.js';

export const CLAUDE_RELEASES_BASE = 'https://downloads.claude.ai/claude-code-releases';

export function claudeExecutableNames(target: RuntimeTarget): string[] {
  return target.platform === 'win32' ? ['claude.exe'] : ['claude'];
}

/**
 * Platform keys to look for in the manifest, best first.
 *
 * The installer builds this string itself (`linux-x64-musl`, `darwin-arm64`,
 * and so on) and the Windows spelling is not visible from the POSIX script, so
 * rather than guess one, every plausible key is offered and the manifest
 * decides: a key that is not in `platforms` is not used. That also means a
 * future rename is a decline, never a wrong download.
 */
export function claudePlatformKeys(target: RuntimeTarget): string[] {
  const arch = target.arch === 'arm64' ? 'arm64' : 'x64';
  switch (target.platform) {
    case 'win32':
      return [`win32-${arch}`, `windows-${arch}`, `win-${arch}`];
    case 'darwin':
      return [`darwin-${arch}`, `macos-${arch}`];
    case 'linux':
      // musl first: the static build runs on both, the glibc one does not.
      return [`linux-${arch}-musl`, `linux-${arch}`];
    default:
      return [`${target.platform}-${arch}`];
  }
}

interface ManifestEntry {
  readonly key: string;
  readonly checksum: string;
  readonly size: number | undefined;
}

/**
 * The release channel the official installer uses.
 *
 * DOCUMENTED: this is the contract Anthropic publishes an installer against,
 * not a host observed inside a binary. The application follows the same steps
 * the installer takes.
 */
export class ClaudeOfficialReleaseSource implements RuntimeSource {
  readonly id = 'claude-official-releases';
  readonly label = 'Canal oficial de releases do Claude Code';
  readonly contract = 'DOCUMENTED' as const;
  /** The manifest publishes a SHA-256 per platform, and it is enforced. */
  readonly integrityStrategy: IntegrityStrategy = 'SHA256';

  constructor(
    private readonly baseUrl = CLAUDE_RELEASES_BASE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null> {
    const version = await this.resolveVersion(request);
    if (!version) return null;

    const manifest = await this.fetchJson(`${this.baseUrl}/${version}/manifest.json`);
    if (!manifest) return null;

    const entry = pickPlatform(manifest, target);
    if (!entry) return null;

    const fileName = target.platform === 'win32' ? 'claude.exe' : 'claude';
    return {
      url: `${this.baseUrl}/${version}/${entry.key}/${fileName}`,
      version,
      // A bare executable, not an archive: the installer downloads exactly this
      // file and runs it.
      archiveKind: 'raw',
      executableNames: claudeExecutableNames(target),
      integrity: entry.checksum,
      ...(entry.size !== undefined ? { expectedBytes: entry.size } : {}),
    };
  }

  /**
   * Turns the version policy into a concrete version.
   *
   * A tested version is used as-is; only an explicit update check asks the
   * channel what is newest. `stable` is the channel the installer defaults to.
   */
  private async resolveVersion(request: VersionRequest): Promise<string | null> {
    if (request.kind === 'tested') return request.version;

    const text = await this.fetchText(`${this.baseUrl}/stable`);
    const version = text?.trim();
    // The channel answers with a bare version. Anything else - an error page, a
    // redirect notice, a region block - is not a version, and is refused.
    return version && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
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
  readonly integrityStrategy: IntegrityStrategy = 'SIGNED_MANIFEST';

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
  return [new ClaudeOfficialReleaseSource(undefined, fetchImpl)];
}

/**
 * Finds the manifest entry for this machine.
 *
 * Only keys the manifest actually declares are considered, and the checksum
 * must be a real SHA-256: a platform without one is skipped rather than
 * installed unverified.
 */
export function pickPlatform(manifest: unknown, target: RuntimeTarget): ManifestEntry | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const platforms = (manifest as Record<string, unknown>)['platforms'];
  if (!platforms || typeof platforms !== 'object') return null;
  const table = platforms as Record<string, unknown>;

  for (const key of claudePlatformKeys(target)) {
    const entry = table[key];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const checksum = typeof record['checksum'] === 'string' ? record['checksum'] : null;
    if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) continue;
    return {
      key,
      checksum,
      size: typeof record['size'] === 'number' ? record['size'] : undefined,
    };
  }
  return null;
}
