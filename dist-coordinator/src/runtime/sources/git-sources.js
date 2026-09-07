/**
 * Where Git comes from.
 *
 * The user is not expected to have Git installed. On Windows the application
 * prepares **MinGit** - the minimal, portable build that the Git for Windows
 * project publishes specifically for embedding in other applications. It is
 * self-contained, needs no installer and no administrator rights.
 *
 * MinGit is distributed under the GPL-2.0. Its licence and notice files travel
 * with the extracted tree and are recorded in the runtime manifest, so the
 * obligation to pass them on is met rather than assumed.
 */
export function gitExecutableNames(target) {
    return target.platform === 'win32' ? ['git.exe'] : ['git'];
}
/**
 * The Git for Windows release feed.
 *
 * Release assets are named `MinGit-<version>-64-bit.zip` (and a `busybox`
 * variant). The plain build is preferred: it is the one intended for embedding.
 * Each release also publishes checksums, which is why the strategy is SHA256.
 */
export class MinGitReleaseSource {
    releasesApi;
    fetchImpl;
    id = 'mingit-official-release';
    label = 'MinGit (distribuição portátil oficial do Git for Windows)';
    contract = 'DOCUMENTED';
    integrityStrategy = 'SHA256';
    constructor(releasesApi = 'https://api.github.com/repos/git-for-windows/git/releases/latest', fetchImpl = fetch) {
        this.releasesApi = releasesApi;
        this.fetchImpl = fetchImpl;
    }
    async resolve(target, _request) {
        // MinGit exists only for Windows; elsewhere this source declines and the
        // system Git is used instead.
        if (target.platform !== 'win32')
            return null;
        let release;
        try {
            const response = await this.fetchImpl(this.releasesApi, {
                headers: { accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(20_000),
            });
            if (!response.ok)
                return null;
            release = await response.json();
        }
        catch {
            return null;
        }
        const asset = pickMinGitAsset(release, target);
        if (!asset)
            return null;
        return {
            url: asset.url,
            version: asset.version,
            archiveKind: 'zip',
            executableNames: gitExecutableNames(target),
            ...(asset.expectedBytes ? { expectedBytes: asset.expectedBytes } : {}),
        };
    }
}
export function defaultGitSources(fetchImpl = fetch) {
    return [new MinGitReleaseSource(undefined, fetchImpl)];
}
/**
 * Picks the portable MinGit archive for the target architecture.
 *
 * Declines on anything it does not recognise, rather than guessing at an asset
 * name and downloading the wrong thing (a full installer, for instance).
 */
function pickMinGitAsset(release, target) {
    if (!release || typeof release !== 'object')
        return null;
    const root = release;
    const tag = typeof root.tag_name === 'string' ? root.tag_name : null;
    const assets = Array.isArray(root.assets) ? root.assets : null;
    if (!tag || !assets)
        return null;
    // Tags look like `v2.47.0.windows.1`; the runtime version is the Git version.
    const versionMatch = /^v?(\d+\.\d+\.\d+)/.exec(tag);
    const version = versionMatch?.[1];
    if (!version)
        return null;
    const bits = target.arch === 'arm64' ? 'arm64' : '64-bit';
    let fallback = null;
    for (const raw of assets) {
        if (!raw || typeof raw !== 'object')
            continue;
        const asset = raw;
        const name = typeof asset.name === 'string' ? asset.name : null;
        const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : null;
        if (!name || !url)
            continue;
        if (!/^MinGit-/i.test(name) || !name.toLowerCase().endsWith('.zip'))
            continue;
        if (!name.includes(bits))
            continue;
        const entry = {
            url,
            version,
            ...(typeof asset.size === 'number' ? { expectedBytes: asset.size } : {}),
        };
        // The busybox variant is smaller but replaces several tools; prefer the
        // plain build, and keep busybox only as a fallback.
        if (/busybox/i.test(name)) {
            fallback ??= entry;
            continue;
        }
        return entry;
    }
    return fallback;
}
//# sourceMappingURL=git-sources.js.map