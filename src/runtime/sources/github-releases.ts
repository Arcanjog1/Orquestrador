/**
 * A small, honest client for the GitHub Releases API.
 *
 * Shared by any runtime whose project publishes its builds as GitHub releases.
 * Three rules shape it:
 *
 *  1. **Nothing is guessed.** Asset URLs come from the release the API returns.
 *     A release without the asset we need makes the caller decline; it never
 *     produces a URL by pattern.
 *  2. **A release is identified by tag**, so the version policy stays in
 *     charge. `latest` is asked for explicitly, never assumed.
 *  3. **Checksums come from the release too.** A project that publishes a
 *     `SHA256SUMS`-style asset gets real integrity; one that does not is
 *     reported as such rather than quietly downgraded.
 */

const API_ROOT = 'https://api.github.com';
const TIMEOUT_MS = 20_000;

export interface ReleaseAsset {
  readonly name: string;
  /** Browser download URL, as published by the API. */
  readonly url: string;
  readonly bytes: number;
}

export interface Release {
  readonly tag: string;
  /** Release name when set, otherwise the tag. */
  readonly name: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly ReleaseAsset[];
}

/**
 * Headers for an API call.
 *
 * A token is used when the environment has one - CI does - purely to avoid the
 * unauthenticated rate limit. Nothing here needs the token's permissions, and
 * the value is never logged or recorded in a manifest.
 */
function headers(env: NodeJS.ProcessEnv): Record<string, string> {
  const base: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ai-orchestrator-runtime-manager',
  };
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (token) base['authorization'] = `Bearer ${token}`;
  return base;
}

/**
 * Fetches one release.
 *
 * `tag` is either a concrete tag or the string `latest`. A release that does
 * not exist (404) returns null - the caller then tries the next source. Any
 * other refusal throws, naming the HTTP status and, for the API's rate limit,
 * when it resets: "nothing available" hid every one of those from the person
 * looking at a failed install, and the rate limit is the one an
 * unauthenticated desktop hits first.
 */
export async function fetchRelease(
  repository: string,
  tag: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Release | null> {
  const path = tag === 'latest' ? 'releases/latest' : `releases/tags/${encodeURIComponent(tag)}`;
  const url = `${API_ROOT}/repos/${repository}/${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: headers(env),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GitHub API unreachable (${describeFetchError(error)}) for ${url}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const limited =
      (response.status === 403 || response.status === 429) && remaining === '0'
        ? ` - API rate limit exhausted${reset ? `, resets at ${new Date(Number(reset) * 1000).toISOString()}` : ''}`
        : '';
    throw new Error(`GitHub API answered HTTP ${response.status}${limited} for ${url}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`GitHub API answered HTTP ${response.status} without a JSON body for ${url}`);
  }
  const release = parseRelease(payload);
  if (!release) throw new Error(`GitHub API answered a release without a tag for ${url}`);
  return release;
}

function describeFetchError(error: unknown): string {
  const e = error as { name?: string; cause?: { code?: string }; message?: string };
  if (e?.name === 'TimeoutError') return 'timed out';
  return e?.cause?.code ?? e?.message ?? String(error);
}

export function parseRelease(payload: unknown): Release | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const tag = typeof root['tag_name'] === 'string' ? root['tag_name'] : null;
  if (!tag) return null;

  const rawAssets = Array.isArray(root['assets']) ? root['assets'] : [];
  const assets: ReleaseAsset[] = [];
  for (const raw of rawAssets) {
    if (!raw || typeof raw !== 'object') continue;
    const asset = raw as Record<string, unknown>;
    const name = typeof asset['name'] === 'string' ? asset['name'] : null;
    const url =
      typeof asset['browser_download_url'] === 'string' ? asset['browser_download_url'] : null;
    if (!name || !url) continue;
    assets.push({
      name,
      url,
      bytes: typeof asset['size'] === 'number' ? asset['size'] : 0,
    });
  }

  return {
    tag,
    name: typeof root['name'] === 'string' && root['name'].length > 0 ? root['name'] : tag,
    prerelease: root['prerelease'] === true,
    draft: root['draft'] === true,
    assets,
  };
}

/**
 * Reads a `sha256sum`-style manifest asset into a name → digest map.
 *
 * The format is one entry per line: the digest, whitespace, then the file name.
 * A line that does not parse is skipped rather than failing the whole manifest,
 * because a manifest that gains a comment header should not break installs.
 */
export async function fetchChecksums(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  let text: string;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return digests;
    text = await response.text();
  } catch {
    return digests;
  }
  return parseChecksums(text);
}

export function parseChecksums(text: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (!match) continue;
    // Manifests sometimes carry a path; the asset is known by its base name.
    const name = match[2]!.split('/').pop()!;
    digests.set(name, match[1]!.toLowerCase());
  }
  return digests;
}

/** Finds an asset by exact name. Never by pattern, never "the first match". */
export function findAsset(release: Release, name: string): ReleaseAsset | null {
  return release.assets.find((asset) => asset.name === name) ?? null;
}
