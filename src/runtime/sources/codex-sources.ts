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
import { fetchChecksums, fetchRelease, findAsset, type Release } from './github-releases.js';
import type { ResolvedDownload, RuntimeSource, RuntimeTarget } from '../types.js';
import type { IntegrityStrategy } from '../integrity.js';
import type { VersionRequest } from '../compatibility.js';

const CODEX_PACKAGE = '@openai/codex';
const CODEX_REPOSITORY = 'openai/codex';

/**
 * Rust target triples, by platform and architecture.
 *
 * Explicit on purpose. Codex publishes one asset per triple, and matching "the
 * first file with windows in the name" is how you end up installing an ARM64
 * build on an x64 machine, or a debug symbols archive instead of a binary.
 */
const TARGET_TRIPLES: Record<string, string> = {
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
  'darwin:x64': 'x86_64-apple-darwin',
  'darwin:arm64': 'aarch64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-musl',
  'linux:arm64': 'aarch64-unknown-linux-musl',
};

export function codexTargetTriple(target: RuntimeTarget): string | null {
  return TARGET_TRIPLES[`${target.platform}:${target.arch}`] ?? null;
}

/** The release asset that carries the published SHA-256 for every package. */
const CHECKSUM_MANIFEST = 'codex-package_SHA256SUMS';

/** Codex tags its releases `rust-v<version>`. */
export function codexReleaseTag(version: string): string {
  return `rust-v${version}`;
}

/** Strips the tag prefix back off, so the manifest records a plain version. */
export function versionFromCodexTag(tag: string): string {
  return tag.replace(/^rust-v/, '');
}

/** Executable names to look for once an archive is unpacked. */
export function codexExecutableNames(target: RuntimeTarget): string[] {
  return target.platform === 'win32' ? ['codex.exe'] : ['codex'];
}

/**
 * Codex from the project's own GitHub releases.
 *
 * This is the source that actually works. The channel the standalone installer
 * uses - `releases.openai.com/codex` - answers 404 for both `/codex` and
 * `/codex/latest` when asked from a real Windows machine, measured in CI, so it
 * was removed rather than left in the list to fail on every first run.
 *
 * Contract level is DOCUMENTED, not PACKAGE_INTERNAL: these are the project's
 * own published release artifacts, named by the release workflow, not an
 * implementation detail of somebody's package layout. Where the bytes are
 * hosted says nothing about how public the contract is.
 *
 * The asset is matched by **exact name against the target triple**. Codex
 * publishes one build per triple, so "the first asset containing windows"
 * would happily hand an ARM64 build to an x64 machine.
 */
export class CodexGitHubReleaseSource implements RuntimeSource {
  readonly id = 'codex-github-releases';
  readonly label = 'Releases oficiais do openai/codex';
  readonly contract = 'DOCUMENTED' as const;
  /** The release publishes a SHA-256 manifest covering the package archives. */
  readonly integrityStrategy: IntegrityStrategy = 'SHA256';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly repository = CODEX_REPOSITORY,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async resolve(target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null> {
    const triple = codexTargetTriple(target);
    if (!triple) return null;

    // The version policy decides which release to ask for. A tested version is
    // requested by its own tag: if that release is gone, this source declines
    // rather than quietly installing whatever happens to be newest.
    const tag = request.kind === 'tested' ? codexReleaseTag(request.version) : 'latest';
    const release = await fetchRelease(this.repository, tag, this.fetchImpl, this.env);
    if (!release || release.draft) return null;

    const digests = await this.readChecksums(release);
    const version = versionFromCodexTag(release.tag);

    for (const candidate of codexAssetCandidates(triple, target)) {
      const asset = findAsset(release, candidate.name);
      if (!asset) continue;

      // No published digest, no install. An agent binary runs arbitrary code on
      // the user's machine; "we could not check, so we proceeded" is not a
      // trade this product makes. Declining sends the run to the next source
      // and, if none can prove itself, produces a clear failure.
      const sha256 = digests.get(asset.name);
      if (!sha256) continue;

      return {
        url: asset.url,
        version,
        archiveKind: candidate.archiveKind,
        executableNames: codexExecutableNames(target),
        integrity: sha256,
        ...(asset.bytes > 0 ? { expectedBytes: asset.bytes } : {}),
      };
    }
    return null;
  }

  private async readChecksums(release: Release): Promise<Map<string, string>> {
    const manifest = findAsset(release, CHECKSUM_MANIFEST);
    if (!manifest) return new Map();
    return fetchChecksums(manifest.url, this.fetchImpl);
  }
}

interface AssetCandidate {
  readonly name: string;
  readonly archiveKind: 'tgz' | 'zip';
}

/**
 * The assets worth trying for a triple, best first.
 *
 * The package archive comes first because it is the one the release's
 * `SHA256SUMS` manifest covers, and an asset whose digest is published is worth
 * more than one whose is not. The Windows installer zip is listed after it so a
 * future release that starts publishing a digest for it is picked up without a
 * code change.
 */
export function codexAssetCandidates(
  triple: string,
  target: RuntimeTarget,
): readonly AssetCandidate[] {
  const candidates: AssetCandidate[] = [
    { name: `codex-package-${triple}.tar.gz`, archiveKind: 'tgz' },
  ];
  if (target.platform === 'win32') {
    candidates.push({ name: `codex-${triple}.exe.zip`, archiveKind: 'zip' });
  } else {
    candidates.push({ name: `codex-${triple}.tar.gz`, archiveKind: 'tgz' });
  }
  return candidates;
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

/**
 * Default ordering, revised against what the real world answers.
 *
 * GitHub releases first: measured working, digest published, official project
 * artifacts. The npm platform package stays as a fallback - it answered "no
 * tarball for this platform" on Windows x64, but it costs one request and may
 * serve platforms the releases do not.
 *
 * `releases.openai.com/codex` is deliberately absent. It 404s, and an endpoint
 * that is known not to work has no business spending a user's first run.
 */
export function defaultCodexSources(fetchImpl: typeof fetch = fetch): RuntimeSource[] {
  return [new CodexGitHubReleaseSource(fetchImpl), new CodexNpmRegistrySource(fetchImpl)];
}
