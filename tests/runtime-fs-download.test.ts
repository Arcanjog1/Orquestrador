/**
 * The two Windows failure modes the install pipeline now survives: a folder
 * that refuses a rename for a moment, and a download that must not be
 * capped by a wall clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { moveDirectoryWithRetry, removeTreeWithRetry } from '../src/runtime/fs-retry.js';
import { DownloadError, downloadAndVerify, IntegrityError } from '../src/runtime/downloader.js';

test('a rename refused with EPERM a few times (the antivirus holding a fresh exe) still lands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-fsretry-'));
  try {
    const from = join(home, 'staged');
    const to = join(home, 'current');
    mkdirSync(from);
    writeFileSync(join(from, 'codex.exe'), 'x');
    let refusals = 3;
    const waits: number[] = [];
    await moveDirectoryWithRetry(from, to, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      rename: (a, b) => {
        if (refusals > 0) {
          refusals -= 1;
          const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return renameSync(a, b);
      },
    });
    assert.ok(existsSync(join(to, 'codex.exe')));
    assert.ok(!existsSync(from));
    assert.deepEqual(waits, [100, 200, 400], 'backs off between attempts');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a rename across volumes (EXDEV) falls back to a copy, and the source is removed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-fsxdev-'));
  try {
    const from = join(home, 'staged');
    const to = join(home, 'current');
    mkdirSync(join(from, 'bin'), { recursive: true });
    writeFileSync(join(from, 'bin', 'codex.exe'), 'payload');
    await moveDirectoryWithRetry(from, to, {
      rename: () => {
        const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      },
    });
    assert.equal(readFileSync(join(to, 'bin', 'codex.exe'), 'utf8'), 'payload');
    assert.ok(!existsSync(from));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a refusal that never clears is reported, not looped forever; removal is best effort', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-fsgiveup-'));
  try {
    const from = join(home, 'a');
    mkdirSync(from);
    let now = 0;
    await assert.rejects(
      moveDirectoryWithRetry(from, join(home, 'b'), {
        maxWaitMs: 500,
        sleep: async (ms) => {
          now += ms;
        },
        rename: () => {
          const error = new Error('EBUSY') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        },
      }),
      /EBUSY/,
    );
    assert.equal(await removeTreeWithRetry(join(home, 'does-not-exist')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A fetch that streams `chunks` with `gapMs` between them. */
function slowFetch(chunks: Buffer[], gapMs: number, headers: Record<string, string> = {}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks.shift();
        if (!chunk) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (signal?.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    return new Response(stream, { status: 200, headers });
  }) as typeof fetch;
}

test('a slow but moving download completes regardless of how long it takes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-dl-slow-'));
  try {
    const chunks = Array.from({ length: 6 }, (_, i) => Buffer.from(`chunk-${i}-`.repeat(100)));
    const all = Buffer.concat(chunks);
    const integrity = `sha512-${createHash('sha512').update(all).digest('base64')}`;
    const progress: number[] = [];
    const outcome = await downloadAndVerify({
      url: 'https://example.invalid/slow.tgz',
      destination: join(home, 'slow.tgz'),
      fetchImpl: slowFetch([...chunks], 40, { 'content-length': String(all.length) }),
      integrity,
      // Shorter than the whole transfer (6 × 40 ms) and longer than one gap.
      inactivityTimeoutMs: 120,
      onProgress: (received) => progress.push(received),
    });
    assert.equal(outcome.bytes, all.length);
    assert.equal(outcome.integrityVerified, true);
    assert.equal(outcome.sha256, createHash('sha256').update(all).digest('hex'));
    assert.deepEqual(readFileSync(join(home, 'slow.tgz')), all, 'streamed to disk, byte for byte');
    assert.equal(progress.at(-1), all.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a download that stops moving is given up with a reason, and nothing is kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-dl-stall-'));
  try {
    const destination = join(home, 'stalled.tgz');
    await assert.rejects(
      downloadAndVerify({
        url: 'https://example.invalid/stalled.tgz',
        destination,
        fetchImpl: slowFetch([Buffer.from('first'), Buffer.from('never')], 300),
        inactivityTimeoutMs: 80,
      }),
      (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.match(error.message, /no data arrived for a while/);
        return true;
      },
    );
    assert.ok(!existsSync(destination));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a download shorter than its content-length, or with a wrong digest, is discarded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-dl-short-'));
  try {
    const bytes = Buffer.from('hello');
    await assert.rejects(
      downloadAndVerify({
        url: 'https://example.invalid/short.tgz',
        destination: join(home, 'short.tgz'),
        fetchImpl: slowFetch([bytes], 1, { 'content-length': '999' }),
      }),
      /ended after 5 of 999 bytes/,
    );
    await assert.rejects(
      downloadAndVerify({
        url: 'https://example.invalid/bad.tgz',
        destination: join(home, 'bad.tgz'),
        fetchImpl: slowFetch([bytes], 1),
        integrity: 'sha512-AAAA',
      }),
      IntegrityError,
    );
    assert.ok(!existsSync(join(home, 'bad.tgz')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
