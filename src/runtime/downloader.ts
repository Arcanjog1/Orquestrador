/**
 * Downloading and integrity verification.
 *
 * Nothing is ever written straight into a runtime's install directory: a
 * download lands in staging, is verified, and only then is promoted. A failed
 * or interrupted download therefore cannot leave a half-installed runtime
 * behind that would look valid on the next launch.
 *
 * The bytes stream to disk as they arrive and are hashed on the way: a Codex
 * package for Windows is 136 MB, and holding it in memory twice - once as
 * chunks, once concatenated - is what an Electron main process does not need.
 * The timeout is on *inactivity*, not on the whole transfer: a slow link that
 * is still moving bytes is not a failure, and a fixed five-minute cap turned
 * a 4 Mbps connection into "could not prepare Codex".
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DownloadOutcome {
  bytes: number;
  sha256: string;
  /**
   * `true`/`false` when the source published an integrity string that could be
   * checked; `null` when there was nothing to compare against.
   */
  integrityVerified: boolean | null;
  url: string;
  finalUrl: string;
  durationMs: number;
}

export class IntegrityError extends Error {
  constructor(url: string) {
    super(`Integrity check failed for ${url}. The download was discarded.`);
    this.name = 'IntegrityError';
  }
}

export class DownloadError extends Error {
  constructor(url: string, reason: string) {
    super(`Could not download ${url}: ${reason}`);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  url: string;
  /** Absolute path in the staging area. */
  destination: string;
  /** npm-style `sha512-<base64>`, when the source publishes one. */
  integrity?: string | undefined;
  /** Advertised size, used to report a percentage. */
  expectedBytes?: number | undefined;
  onProgress?: ((receivedBytes: number, totalBytes: number | null) => void) | undefined;
  /** Give up when no byte arrives for this long. Default 90 s. */
  inactivityTimeoutMs?: number;
  /** @deprecated Kept for callers that still pass it; treated as the inactivity timeout. */
  timeoutMs?: number;
  /** Cancels the download. */
  signal?: AbortSignal | undefined;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Downloads a file, streaming to disk so progress can be reported and memory
 * stays flat, and verifies it.
 *
 * Throws `IntegrityError` without keeping the file when verification fails,
 * and `DownloadError` naming the reason - HTTP status, inactivity, network -
 * when the transfer does not complete.
 */
export async function downloadAndVerify(options: DownloadOptions): Promise<DownloadOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const inactivityMs = options.inactivityTimeoutMs ?? options.timeoutMs ?? 90_000;

  // One controller for both reasons to stop: the caller cancelling, and the
  // link going quiet. Which one fired is remembered for the error message.
  const controller = new AbortController();
  let quiet = false;
  let timer: NodeJS.Timeout | null = null;
  const armInactivity = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      quiet = true;
      controller.abort();
    }, inactivityMs);
    timer.unref?.();
  };
  const onCallerAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  let response: Response;
  armInactivity();
  try {
    response = await fetchImpl(options.url, { redirect: 'follow', signal: controller.signal });
  } catch (err) {
    cleanup();
    throw new DownloadError(options.url, describeNetworkError(err, quiet));
  }

  if (!response.ok) {
    cleanup();
    throw new DownloadError(options.url, `the server answered HTTP ${response.status}`);
  }

  const advertised = Number(response.headers.get('content-length') ?? 0) || null;
  const total = advertised ?? options.expectedBytes ?? null;

  mkdirSync(dirname(options.destination), { recursive: true });
  const fd = openSync(options.destination, 'w');
  const hash = createHash('sha256');
  const integrityHashes = integrityAlgorithms(options.integrity).map((algorithm) => ({
    algorithm,
    hash: createHash(algorithm),
  }));
  let received = 0;

  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        let step: { done: boolean; value?: Uint8Array };
        try {
          step = await reader.read();
        } catch (err) {
          throw new DownloadError(options.url, describeNetworkError(err, quiet));
        }
        if (step.done) break;
        if (step.value) {
          armInactivity();
          const chunk = Buffer.from(step.value);
          writeSync(fd, chunk);
          hash.update(chunk);
          for (const entry of integrityHashes) entry.hash.update(chunk);
          received += chunk.length;
          options.onProgress?.(received, total);
        }
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      writeSync(fd, buffer);
      hash.update(buffer);
      for (const entry of integrityHashes) entry.hash.update(buffer);
      received = buffer.length;
      options.onProgress?.(received, total);
    }
  } catch (err) {
    closeSync(fd);
    cleanup();
    rmSync(options.destination, { force: true });
    throw err instanceof DownloadError ? err : new DownloadError(options.url, describeNetworkError(err, quiet));
  }
  closeSync(fd);
  cleanup();

  if (total !== null && received !== total) {
    rmSync(options.destination, { force: true });
    throw new DownloadError(options.url, `the transfer ended after ${received} of ${total} bytes`);
  }

  const sha256 = hash.digest('hex');
  const integrityVerified = verifyDigests(
    integrityHashes.map((entry) => ({ algorithm: entry.algorithm, base64: entry.hash.digest('base64') })),
    options.integrity,
  );
  if (integrityVerified === false) {
    rmSync(options.destination, { force: true });
    throw new IntegrityError(options.url);
  }

  return {
    bytes: received,
    sha256,
    integrityVerified,
    url: options.url,
    finalUrl: response.url || options.url,
    durationMs: Date.now() - started,
  };

  function cleanup(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** The algorithms an npm-style integrity string asks for, deduplicated. */
function integrityAlgorithms(integrity?: string): string[] {
  if (!integrity) return [];
  const out: string[] = [];
  for (const entry of integrity.trim().split(/\s+/)) {
    const separator = entry.indexOf('-');
    if (separator < 0) continue;
    const algorithm = entry.slice(0, separator);
    if (['sha256', 'sha384', 'sha512'].includes(algorithm) && !out.includes(algorithm)) out.push(algorithm);
  }
  return out;
}

function verifyDigests(
  computed: ReadonlyArray<{ algorithm: string; base64: string }>,
  integrity?: string,
): boolean | null {
  if (!integrity) return null;
  let compared = false;
  for (const entry of integrity.trim().split(/\s+/)) {
    const separator = entry.indexOf('-');
    if (separator < 0) continue;
    const algorithm = entry.slice(0, separator);
    const expected = entry.slice(separator + 1);
    const actual = computed.find((c) => c.algorithm === algorithm);
    if (!actual) continue;
    compared = true;
    if (actual.base64 === expected) return true;
  }
  return compared ? false : null;
}

/**
 * Checks an npm-style Subresource Integrity string against bytes in memory.
 *
 * Returns `null` when there is nothing to verify, so a missing checksum is
 * never mistaken for a passing one.
 */
export function verifyIntegrity(bytes: Buffer, integrity?: string): boolean | null {
  if (!integrity) return null;
  const computed = integrityAlgorithms(integrity).map((algorithm) => ({
    algorithm,
    base64: createHash(algorithm).update(bytes).digest('base64'),
  }));
  const verdict = verifyDigests(computed, integrity);
  // An integrity string naming only unknown algorithms cannot be checked.
  return computed.length === 0 ? false : verdict;
}

function describeNetworkError(err: unknown, quiet: boolean): string {
  if (quiet) return 'no data arrived for a while (the connection stalled)';
  const e = err as { name?: string; cause?: { code?: string }; message?: string };
  if (e?.name === 'AbortError') return 'the download was cancelled';
  if (e?.name === 'TimeoutError') return 'the request timed out';
  const code = e?.cause?.code;
  if (code === 'ENOTFOUND') return 'the server could not be reached';
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  if (code === 'ECONNRESET') return 'the connection was reset';
  if (code === 'CERT_HAS_EXPIRED') return 'the server certificate is not valid';
  return e?.message ?? String(err);
}
