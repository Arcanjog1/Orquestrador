/**
 * Test doubles for the runtime layer.
 *
 * `makeArchiveFetch` builds a real .tgz on disk and serves it through a fake
 * `fetch`, so the installer's download -> verify -> extract -> promote path is
 * exercised end to end without touching the network.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedDownload, RuntimeSource, RuntimeTarget } from '../../src/runtime/types.js';

/** A source that returns whatever it is told, or throws on demand. */
export class StubSource implements RuntimeSource {
  calls = 0;
  constructor(
    readonly id: string,
    readonly label: string,
    readonly contract: RuntimeSource['contract'],
    private readonly behaviour: ResolvedDownload | null | Error,
  ) {}

  async resolve(_target: RuntimeTarget): Promise<ResolvedDownload | null> {
    this.calls += 1;
    if (this.behaviour instanceof Error) throw this.behaviour;
    return this.behaviour;
  }
}

export interface FakeArchive {
  url: string;
  tarballPath: string;
  bytes: Buffer;
  integrity: string;
  /** Path of the executable inside the archive, relative to its root. */
  executableRelativePath: string;
}

/**
 * Builds a .tgz laying out an executable next to a sibling resource folder -
 * the shape that makes promoting only the executable's own directory wrong.
 */
export function buildFakeArchive(
  workDir: string,
  executableName: string,
  scriptBody = '#!/bin/sh\necho "fake 1.2.3"\n',
): FakeArchive {
  const stage = join(workDir, 'archive-src');
  const binDir = join(stage, 'package', 'vendor', 'bin');
  const resourceDir = join(stage, 'package', 'vendor', 'resources');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(resourceDir, { recursive: true });

  writeFileSync(join(binDir, executableName), scriptBody, { mode: 0o755 });
  writeFileSync(join(resourceDir, 'data.txt'), 'the executable needs this sibling\n');

  const tarballPath = join(workDir, 'fake.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', stage, 'package'], { stdio: 'ignore' });

  const bytes = readFileSync(tarballPath);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

  return {
    url: 'https://example.invalid/fake.tgz',
    tarballPath,
    bytes,
    integrity,
    executableRelativePath: join('package', 'vendor', 'bin', executableName),
  };
}

/** A `fetch` that serves prepared responses by URL. */
export function makeFetch(routes: Record<string, { status?: number; body?: unknown; bytes?: Buffer }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes) {
      return new Response(route.bytes, {
        status: route.status ?? 200,
        headers: { 'content-length': String(route.bytes.length) },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
