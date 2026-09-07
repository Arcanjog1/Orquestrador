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
export class IntegrityError extends Error {
    constructor(url) {
        super(`Integrity check failed for ${url}. The download was discarded.`);
        this.name = 'IntegrityError';
    }
}
export class DownloadError extends Error {
    constructor(url, reason) {
        super(`Could not download ${url}: ${reason}`);
        this.name = 'DownloadError';
    }
}
/**
 * Downloads a file, streaming to disk so progress can be reported and memory
 * stays flat, and verifies it.
 *
 * Throws `IntegrityError` without keeping the file when verification fails,
 * and `DownloadError` naming the reason - HTTP status, inactivity, network -
 * when the transfer does not complete.
 */
export async function downloadAndVerify(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const started = Date.now();
    const inactivityMs = options.inactivityTimeoutMs ?? options.timeoutMs ?? 90_000;
    // One controller for both reasons to stop: the caller cancelling, and the
    // link going quiet. Which one fired is remembered for the error message.
    const controller = new AbortController();
    let quiet = false;
    let timer = null;
    const armInactivity = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            quiet = true;
            controller.abort();
        }, inactivityMs);
        timer.unref?.();
    };
    const onCallerAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (options.signal?.aborted)
        controller.abort();
    let response;
    armInactivity();
    try {
        response = await fetchImpl(options.url, { redirect: 'follow', signal: controller.signal });
    }
    catch (err) {
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
                let step;
                try {
                    step = await reader.read();
                }
                catch (err) {
                    throw new DownloadError(options.url, describeNetworkError(err, quiet));
                }
                if (step.done)
                    break;
                if (step.value) {
                    armInactivity();
                    const chunk = Buffer.from(step.value);
                    writeSync(fd, chunk);
                    hash.update(chunk);
                    for (const entry of integrityHashes)
                        entry.hash.update(chunk);
                    received += chunk.length;
                    options.onProgress?.(received, total);
                }
            }
        }
        else {
            const buffer = Buffer.from(await response.arrayBuffer());
            writeSync(fd, buffer);
            hash.update(buffer);
            for (const entry of integrityHashes)
                entry.hash.update(buffer);
            received = buffer.length;
            options.onProgress?.(received, total);
        }
    }
    catch (err) {
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
    const integrityVerified = verifyDigests(integrityHashes.map((entry) => ({ algorithm: entry.algorithm, base64: entry.hash.digest('base64') })), options.integrity);
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
    function cleanup() {
        if (timer)
            clearTimeout(timer);
        timer = null;
        options.signal?.removeEventListener('abort', onCallerAbort);
    }
}
/** The algorithms an npm-style integrity string asks for, deduplicated. */
function integrityAlgorithms(integrity) {
    if (!integrity)
        return [];
    const out = [];
    for (const entry of integrity.trim().split(/\s+/)) {
        const separator = entry.indexOf('-');
        if (separator < 0)
            continue;
        const algorithm = entry.slice(0, separator);
        if (['sha256', 'sha384', 'sha512'].includes(algorithm) && !out.includes(algorithm))
            out.push(algorithm);
    }
    return out;
}
function verifyDigests(computed, integrity) {
    if (!integrity)
        return null;
    let compared = false;
    for (const entry of integrity.trim().split(/\s+/)) {
        const separator = entry.indexOf('-');
        if (separator < 0)
            continue;
        const algorithm = entry.slice(0, separator);
        const expected = entry.slice(separator + 1);
        const actual = computed.find((c) => c.algorithm === algorithm);
        if (!actual)
            continue;
        compared = true;
        if (actual.base64 === expected)
            return true;
    }
    return compared ? false : null;
}
/**
 * Checks an npm-style Subresource Integrity string against bytes in memory.
 *
 * Returns `null` when there is nothing to verify, so a missing checksum is
 * never mistaken for a passing one.
 */
export function verifyIntegrity(bytes, integrity) {
    if (!integrity)
        return null;
    const computed = integrityAlgorithms(integrity).map((algorithm) => ({
        algorithm,
        base64: createHash(algorithm).update(bytes).digest('base64'),
    }));
    const verdict = verifyDigests(computed, integrity);
    // An integrity string naming only unknown algorithms cannot be checked.
    return computed.length === 0 ? false : verdict;
}
function describeNetworkError(err, quiet) {
    if (quiet)
        return 'no data arrived for a while (the connection stalled)';
    const e = err;
    if (e?.name === 'AbortError')
        return 'the download was cancelled';
    if (e?.name === 'TimeoutError')
        return 'the request timed out';
    const code = e?.cause?.code;
    if (code === 'ENOTFOUND')
        return 'the server could not be reached';
    if (code === 'ECONNREFUSED')
        return 'the connection was refused';
    if (code === 'ECONNRESET')
        return 'the connection was reset';
    if (code === 'CERT_HAS_EXPIRED')
        return 'the server certificate is not valid';
    return e?.message ?? String(err);
}
//# sourceMappingURL=downloader.js.map