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
import type { IntegrityStrategy } from '../../src/runtime/integrity.js';
import type { VersionRequest } from '../../src/runtime/compatibility.js';

/** A source that returns whatever it is told, or throws on demand. */
export class StubSource implements RuntimeSource {
  calls = 0;
  /** The version requests it was asked for, so tests can assert the policy. */
  readonly requests: VersionRequest[] = [];

  constructor(
    readonly id: string,
    readonly label: string,
    readonly contract: RuntimeSource['contract'],
    private readonly behaviour: ResolvedDownload | null | Error,
    readonly integrityStrategy: IntegrityStrategy = 'NPM_INTEGRITY',
    readonly expectedPublisher?: string,
  ) {}

  async resolve(_target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null> {
    this.calls += 1;
    this.requests.push(request);
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
  /** What a source must advertise for the pipeline to find it. */
  executableNames: string[];
}

/**
 * Builds a .tgz laying out an executable next to a sibling resource folder -
 * the shape that makes promoting only the executable's own directory wrong.
 */
/**
 * The name a fake executable has to have to be runnable on this platform.
 *
 * Windows cannot execute an extensionless shell script, and the install
 * pipeline really does run the downloaded build to check it works. So the
 * fixture ships a `.cmd` there and a shell script everywhere else - the same
 * shape a real runtime has, which is a `.exe` on Windows and a binary
 * elsewhere.
 */
export function fakeExecutableName(base: string): string {
  return process.platform === 'win32' ? `${base}.cmd` : base;
}

/** What a source should advertise so `findExecutable` locates the fixture. */
export function fakeExecutableNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.cmd`] : [`${base}.exe`, base];
}

/** A script that prints `version` and exits 0, in this platform's dialect. */
export function fakeExecutableBody(version: string): string {
  return process.platform === 'win32'
    ? `@echo off\r\necho ${version}\r\n`
    : `#!/bin/sh\necho "${version}"\n`;
}

export function buildFakeArchive(
  workDir: string,
  executableBaseName: string,
  version = 'fake 1.2.3',
  /** The executable's script, when printing `version` is not what the test needs. */
  body?: string,
): FakeArchive {
  const stage = join(workDir, 'archive-src');
  const binDir = join(stage, 'package', 'vendor', 'bin');
  const resourceDir = join(stage, 'package', 'vendor', 'resources');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(resourceDir, { recursive: true });

  const executableName = fakeExecutableName(executableBaseName);
  writeFileSync(join(binDir, executableName), body ?? fakeExecutableBody(version), { mode: 0o755 });
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
    executableNames: fakeExecutableNames(executableBaseName),
  };
}

/** A `fetch` that serves prepared responses by URL. */
export function makeFetch(
  routes: Record<string, { status?: number; body?: unknown; text?: string; bytes?: Buffer }>,
): typeof fetch {
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
    // A checksum manifest is plain text, not JSON: serving it through
    // JSON.stringify would wrap it in quotes and no parser would recognise it.
    if (route.text !== undefined) {
      return new Response(route.text, {
        status: route.status ?? 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
