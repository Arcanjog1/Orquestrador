/**
 * Downloading and integrity verification.
 *
 * Nothing is ever written straight into a runtime's install directory: a
 * download lands in staging, is verified, and only then is promoted. A failed
 * or interrupted download therefore cannot leave a half-installed runtime
 * behind that would look valid on the next launch.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  timeoutMs?: number;
  /** Aborts the transfer when the user backs out of an install. */
  signal?: AbortSignal | undefined;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Downloads a file, streaming so progress can be reported, and verifies it.
 *
 * Throws `IntegrityError` without keeping the file when verification fails.
 */
export async function downloadAndVerify(options: DownloadOptions): Promise<DownloadOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();

  let response: Response;
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
    response = await fetchImpl(options.url, {
      redirect: 'follow',
      // The transfer stops on whichever comes first: the deadline, or the
      // user pressing cancel in the interface.
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (err) {
    throw new DownloadError(options.url, describeNetworkError(err));
  }

  if (!response.ok) {
    throw new DownloadError(options.url, `the server answered HTTP ${response.status}`);
  }

  const advertised = Number(response.headers.get('content-length') ?? 0) || null;
  const total = advertised ?? options.expectedBytes ?? null;

  const chunks: Buffer[] = [];
  let received = 0;

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        received += chunk.length;
        options.onProgress?.(received, total);
      }
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    chunks.push(buffer);
    received = buffer.length;
    options.onProgress?.(received, total);
  }

  const bytes = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrityVerified = verifyIntegrity(bytes, options.integrity);

  if (integrityVerified === false) throw new IntegrityError(options.url);

  mkdirSync(dirname(options.destination), { recursive: true });
  writeFileSync(options.destination, bytes);

  return {
    bytes: bytes.length,
    sha256,
    integrityVerified,
    url: options.url,
    finalUrl: response.url || options.url,
    durationMs: Date.now() - started,
  };
}

/**
 * Checks an npm-style Subresource Integrity string.
 *
 * Returns `null` when there is nothing to verify, so a missing checksum is
 * never mistaken for a passing one.
 */
export function verifyIntegrity(bytes: Buffer, integrity?: string): boolean | null {
  if (!integrity) return null;
  // An integrity field may list several algorithms separated by whitespace.
  for (const entry of integrity.trim().split(/\s+/)) {
    const separator = entry.indexOf('-');
    if (separator < 0) continue;
    const algorithm = entry.slice(0, separator);
    const expected = entry.slice(separator + 1);
    if (!['sha256', 'sha384', 'sha512'].includes(algorithm)) continue;
    const actual = createHash(algorithm).update(bytes).digest('base64');
    if (actual === expected) return true;
  }
  return false;
}

function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string }; message?: string };
  if (e?.name === 'TimeoutError') return 'the request timed out';
  const code = e?.cause?.code;
  if (code === 'ENOTFOUND') return 'the server could not be reached';
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  if (code === 'CERT_HAS_EXPIRED') return 'the server certificate is not valid';
  return e?.message ?? String(err);
}
