/**
 * Where the Codex runtime can come from, in order of preference.
 *
 * The adapter never sees any of these URLs: it asks `CodexRuntime` for an
 * executable, and this list can be reordered or replaced without touching it.
 *
 * Codex is Apache-2.0, so redistribution would be permitted; the application
 * still fetches on demand, to keep the installer small and the runtime current.
 */

import { fetchNpmDist, toResolvedDownload } from './npm-registry.js';
import type { ResolvedDownload, RuntimeSource, RuntimeTarget } from '../types.js';
import type { IntegrityStrategy } from '../integrity.js';
import type { VersionRequest } from '../compatibility.js';

const CODEX_PACKAGE = '@openai/codex';

/** Executable names to look for once an archive is unpacked. */
export function codexExecutableNames(target: RuntimeTarget): string[] {
  return target.platform === 'win32' ? ['codex.exe'] : ['codex'];
}

/**
 * The project's own release channel, used by its standalone installer.
 *
 * Preferred over the npm package because it does not depend on how that package
 * happens to be laid out internally.
 */
export class CodexOfficialReleaseSource implements RuntimeSource {
  readonly id = 'codex-official-release';
  readonly label = 'Canal oficial de release do Codex';
  readonly contract = 'DOCUMENTED' as const;
  /**
   * The channel publishes a checksum per asset. When a build turns out to be
   * Authenticode-signed as well, that is picked up automatically on Windows and
   * recorded as the stronger of the two.
   */
  readonly integrityStrategy: IntegrityStrategy = 'SHA256';

  constructor(
    private readonly baseUrl = 'https://releases.openai.com/codex',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null> {
    // The channel publishes a manifest describing a build. If it is unreachable
    // or shaped differently than expected, this source simply declines and the
    // next one is tried - it never guesses at a URL.
    const channel = request.kind === 'tested' ? request.version : 'latest';
    let manifest: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${channel}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      manifest = await response.json();
    } catch {
      return null;
    }

    const entry = pickAsset(manifest, target);
    if (!entry) return null;

    return {
      url: entry.url,
      version: entry.version,
      archiveKind: entry.url.endsWith('.zip') ? 'zip' : entry.url.endsWith('.exe') ? 'raw' : 'tgz',
      executableNames: codexExecutableNames(target),
      ...(entry.integrity ? { integrity: entry.integrity } : {}),
    };
  }
}

/**
 * The npm registry artifact for the current platform.
 *
 * Marked PACKAGE_INTERNAL: it works, and the registry publishes an integrity
 * string, but it depends on how the package vendors its binaries. Good as a
 * fallback, not as the architecture's foundation.
 */
export class CodexNpmRegistrySource implements RuntimeSource {
  readonly id = 'codex-npm-registry';
  readonly label = 'Pacote de plataforma no registry npm';
  readonly contract = 'PACKAGE_INTERNAL' as const;
  /** The registry publishes a Subresource Integrity string per artifact. */
  readonly integrityStrategy: IntegrityStrategy = 'NPM_INTEGRITY';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async resolve(target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null> {
    // A first install asks for the version this project has tested; only an
    // explicit update check asks for whatever is newest.
    const wanted = request.kind === 'tested' ? request.version : 'latest';
    const base = await fetchNpmDist(CODEX_PACKAGE, wanted, this.fetchImpl);
    if (!base) return null;

    // Platform builds are published as `<version>-<platform>-<arch>`.
    const platformVersion = `${base.version}-${target.platform}-${target.arch}`;
    const platformDist = await fetchNpmDist(CODEX_PACKAGE, platformVersion, this.fetchImpl);
    if (!platformDist) return null;

    return toResolvedDownload(platformDist, codexExecutableNames(target));
  }
}

/** Default ordering: documented channel first, package internals as fallback. */
export function defaultCodexSources(fetchImpl: typeof fetch = fetch): RuntimeSource[] {
  return [
    new CodexOfficialReleaseSource(undefined, fetchImpl),
    new CodexNpmRegistrySource(fetchImpl),
  ];
}

interface AssetEntry {
  url: string;
  version: string;
  integrity?: string;
}

/**
 * Picks the asset matching the target from a release manifest.
 *
 * Tolerant about the manifest's exact shape: an unrecognised structure makes
 * the source decline rather than produce a wrong URL.
 */
function pickAsset(manifest: unknown, target: RuntimeTarget): AssetEntry | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const root = manifest as Record<string, unknown>;

  const version = typeof root.version === 'string' ? root.version : null;
  const assets = Array.isArray(root.assets) ? root.assets : null;
  if (!version || !assets) return null;

  const archPattern =
    target.arch === 'arm64' ? /(arm64|aarch64)/i : /(x64|x86_64|amd64)/i;
  const platformPattern =
    target.platform === 'win32' ? /(win32|windows|pc-windows)/i
      : target.platform === 'darwin' ? /(darwin|macos|apple)/i
      : /(linux|unknown-linux)/i;

  for (const raw of assets) {
    if (!raw || typeof raw !== 'object') continue;
    const asset = raw as Record<string, unknown>;
    const url = typeof asset.url === 'string' ? asset.url : null;
    const name = typeof asset.name === 'string' ? asset.name : (url ?? '');
    if (!url) continue;
    if (!platformPattern.test(name) || !archPattern.test(name)) continue;
    return {
      url,
      version,
      ...(typeof asset.integrity === 'string' ? { integrity: asset.integrity } : {}),
    };
  }
  return null;
}
