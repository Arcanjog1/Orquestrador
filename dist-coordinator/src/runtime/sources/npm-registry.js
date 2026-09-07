/**
 * Resolving a download from the public npm registry.
 *
 * The registry is queried over plain HTTPS - the npm CLI is never required,
 * which matters because the user is not expected to have Node or npm at all.
 * The registry publishes an integrity string per artifact, so downloads from
 * here can be verified rather than merely hashed.
 */
const REGISTRY = 'https://registry.npmjs.org';
/** Reads a package's `dist` block for one version (or a dist-tag such as `latest`). */
export async function fetchNpmDist(packageName, versionOrTag, fetchImpl = fetch) {
    const url = `${REGISTRY}/${encodeURIComponent(packageName).replace('%40', '@')}/${encodeURIComponent(versionOrTag)}`;
    const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
        return null;
    const body = (await response.json());
    if (!body.version || !body.dist?.tarball)
        return null;
    return {
        version: body.version,
        tarball: body.dist.tarball,
        ...(body.dist.integrity ? { integrity: body.dist.integrity } : {}),
        ...(body.dist.unpackedSize ? { unpackedBytes: body.dist.unpackedSize } : {}),
    };
}
/** Builds a `ResolvedDownload` from a registry `dist` block. */
export function toResolvedDownload(dist, executableNames) {
    return {
        url: dist.tarball,
        version: dist.version,
        archiveKind: 'tgz',
        executableNames,
        ...(dist.integrity ? { integrity: dist.integrity } : {}),
    };
}
//# sourceMappingURL=npm-registry.js.map