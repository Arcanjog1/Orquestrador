/**
 * Reading and checking files that live only on GitHub.
 *
 * The two mechanisms the supervisor already has - `fileReads` to *look* and
 * `fileChecks` to *prove* - work identically here, against a commit instead of
 * a folder. The comparison itself is the same function the local checker uses
 * (`compareFileBytes`), on purpose: one rule about what "these exact bytes"
 * means, in one place, rather than a second copy that drifts.
 *
 * The distinction the request insists on is kept exactly:
 *
 *  - a **read** shows content and proves nothing;
 *  - a **check** opens the file at a named commit and compares bytes, and
 *    settles only the criteria it names;
 *  - neither is a functional test. No code ran. Nothing here may ever be
 *    reported as one.
 *
 * Nothing throws. A network failure, a missing file and a file that is too
 * large are outcomes with sentences, because a check that threw would take the
 * run down and explain nothing.
 */

import { createHash } from 'node:crypto';
import {
  MAX_CHECKED_BYTES,
  MAX_READ_BYTES,
  MAX_READ_TOTAL_BYTES,
  compareFileBytes,
  describeInvalidCheck,
  type FileCheckRequest,
  type FileCheckResult,
  type FileReadRequest,
  type FileReadResult,
} from '../verification/file-check.js';
import { GitHubError } from './github-client.js';
import type { RepositoryOperations } from './repository-operations.js';
import type { RepositoryRef } from './repository-reader.js';

export interface GitHubFileSource {
  readonly operations: RepositoryOperations;
  readonly ref: RepositoryRef;
  /** The commit or branch the files are read at. Never "latest". */
  readonly at: string;
  readonly token: string | null;
  readonly signal?: AbortSignal;
}

/** Opens one file at one commit and answers one question about it. */
export async function runGitHubFileCheck(
  source: GitHubFileSource,
  request: FileCheckRequest,
): Promise<FileCheckResult> {
  const checkedAt = new Date().toISOString();
  const base = { request, checkedAt, resolvedPath: null, sizeBytes: null, sha256: null } as const;
  const fail = (outcome: FileCheckResult['outcome'], problem: string): FileCheckResult => ({
    ...base,
    passed: false,
    outcome,
    problem,
  });

  // The same validation as the local checker: an absolute path, a null byte or
  // a traversal is refused before anything is fetched.
  const invalid = describeInvalidCheck(request);
  if (invalid) return fail('invalid-request', invalid);

  let file;
  try {
    file = await source.operations.readFile(
      source.ref,
      request.path,
      source.at,
      source.token,
      source.signal,
      MAX_CHECKED_BYTES,
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      // Absent is a real answer, and `mustExist: false` is satisfied by it.
      if (request.mustExist === false) {
        return { ...base, passed: true, outcome: 'ok', problem: null };
      }
      return fail('missing', `O arquivo "${request.path}" não existe em ${short(source.at)}.`);
    }
    // Not being able to look is not the same as looking and finding nothing.
    return fail(
      'read-error',
      `Não consegui ler "${request.path}" no GitHub: ${message(error)}. Isto não prova nada sobre o arquivo.`,
    );
  }

  if (request.mustExist === false) {
    return {
      ...fail('unexpectedly-present', `O arquivo "${request.path}" existe em ${short(source.at)}, e não deveria.`),
      sizeBytes: file.bytes,
    };
  }
  if (file.truncated) {
    return {
      ...fail(
        'too-large',
        `"${request.path}" tem ${file.bytes} bytes, acima do limite de ${MAX_CHECKED_BYTES} para ` +
          'verificação direta. Nada foi comparado.',
      ),
      sizeBytes: file.bytes,
    };
  }

  const bytes = file.text === null ? Buffer.alloc(0) : Buffer.from(file.text, 'utf8');
  // A binary file has no text to compare against `expectText`, and saying so
  // is better than comparing an empty buffer and calling it a mismatch.
  if (file.isBinary && (request.expectText !== undefined || request.forbidBom || request.forbidTrailingNewline)) {
    return {
      ...fail(
        'read-error',
        `"${request.path}" não é texto UTF-8, então uma comparação de texto não diz nada sobre ele.`,
      ),
      sizeBytes: file.bytes,
    };
  }

  const found = {
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    // There is no path on this computer: the file was never here. Saying so
    // beats inventing one that a person could try to open.
    resolvedPath: `${source.ref.owner}/${source.ref.repo}@${source.at}:${request.path}`,
  };
  const problem = compareFileBytes(request, bytes);
  if (problem) {
    return { ...base, ...found, passed: false, outcome: problem.outcome, problem: problem.text };
  }
  return { ...base, ...found, passed: true, outcome: 'ok', problem: null };
}

/** Every check of one round, in order, within one shared budget. */
export async function runGitHubFileChecks(
  source: GitHubFileSource,
  requests: readonly FileCheckRequest[],
): Promise<FileCheckResult[]> {
  const results: FileCheckResult[] = [];
  for (const request of requests) {
    results.push(await runGitHubFileCheck(source, request));
  }
  return results;
}

/** Puts a file in front of the supervisor. Proves nothing; shows something. */
export async function runGitHubFileRead(
  source: GitHubFileSource,
  request: FileReadRequest,
  budget = MAX_READ_BYTES,
): Promise<FileReadResult> {
  const base = { request, resolvedPath: null, sizeBytes: null, sha256: null, text: null } as const;
  const fail = (outcome: FileReadResult['outcome'], problem: string): FileReadResult => ({
    ...base,
    ok: false,
    outcome,
    truncated: false,
    problem,
  });

  const invalid = describeInvalidCheck({ path: request.path });
  if (invalid) return fail('invalid-request', invalid);

  let file;
  try {
    file = await source.operations.readFile(
      source.ref,
      request.path,
      source.at,
      source.token,
      source.signal,
      MAX_CHECKED_BYTES,
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return fail('missing', `O arquivo "${request.path}" não existe em ${short(source.at)}.`);
    }
    return fail('read-error', `Não consegui ler "${request.path}" no GitHub: ${message(error)}.`);
  }

  if (file.text === null) {
    return {
      ...fail(
        'read-error',
        file.truncated
          ? `"${request.path}" tem ${file.bytes} bytes e não foi lido.`
          : `"${request.path}" não é texto UTF-8, então não há o que mostrar aqui.`,
      ),
      sizeBytes: file.bytes,
    };
  }

  const bytes = Buffer.from(file.text, 'utf8');
  const cap = Math.max(1, Math.min(request.maxBytes ?? budget, budget));
  const offset = Math.max(0, request.offsetBytes ?? 0);
  const slice = bytes.subarray(offset, offset + cap);
  return {
    request,
    ok: true,
    outcome: 'ok',
    resolvedPath: `${source.ref.owner}/${source.ref.repo}@${short(source.at)}:${request.path}`,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    text: slice.toString('utf8'),
    // Always reported, never silent: a supervisor deciding from half a file
    // and not knowing it is how a run concludes on something it never saw.
    truncated: slice.byteLength < bytes.byteLength,
    problem: null,
  };
}

/** Every read of one round, sharing the round's byte budget. */
export async function runGitHubFileReads(
  source: GitHubFileSource,
  requests: readonly FileReadRequest[],
): Promise<FileReadResult[]> {
  const results: FileReadResult[] = [];
  let remaining = MAX_READ_TOTAL_BYTES;
  for (const request of requests) {
    if (remaining <= 0) {
      results.push({
        request,
        ok: false,
        outcome: 'too-large',
        resolvedPath: null,
        sizeBytes: null,
        sha256: null,
        text: null,
        truncated: false,
        problem: 'O orçamento de leitura desta rodada acabou antes deste arquivo.',
      });
      continue;
    }
    const result = await runGitHubFileRead(source, request, Math.min(MAX_READ_BYTES, remaining));
    results.push(result);
    remaining -= result.text ? Buffer.byteLength(result.text, 'utf8') : 0;
  }
  return results;
}

function short(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 12) : ref;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
