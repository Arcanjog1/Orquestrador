/**
 * Checking a file the application reads for itself.
 *
 * ## Why this exists
 *
 * A run created `hello.txt` with exactly the right six bytes and could still
 * never finish. The workspace had no registered verifications, so the loop had
 * nothing to run; with nothing run, every acceptance criterion the supervisor
 * stated was marked **failed**; and a failed criterion blocks the DoneGate for
 * ever. The supervisor was right to stop and say so.
 *
 * The gap was real: the application could observe *that* a file changed — git
 * says so — but had no way to confirm *what is in it* without a person first
 * registering a shell command. For "create a file with these six bytes", that
 * is a lot of ceremony to prove something the application can simply read.
 *
 * ## What this is, and what it is deliberately not
 *
 * It is a **typed request**, validated field by field, that the main process
 * executes by opening a file. It is **not** a command, not a string an agent
 * composes, and nothing in it is ever passed to a shell. That distinction is
 * the whole security model here: a supervisor can ask "does this path contain
 * these bytes?" and cannot ask anything else.
 *
 * | | registered verification | file check |
 * |---|---|---|
 * | who writes it | a person, once, in Settings | the supervisor, per task |
 * | what it is | a command line | a structured comparison |
 * | what runs it | a child process | `readFile` in the main process |
 * | can it execute code | yes, that is the point | **no**, by construction |
 *
 * So the rule the product already had — *only registered verifications may run
 * commands* — is untouched. This adds a second kind of proof that runs no
 * command at all.
 *
 * ## The boundary
 *
 * Every path is resolved against the workspace root and must stay inside it,
 * checked **after** resolving symlinks so a link pointing outward is refused
 * rather than followed. A path that escapes is not an error to report and move
 * past — it is a refusal, named as one.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** What a check may ask. Every field is data; none is a command. */
export interface FileCheckRequest {
  /** Relative to the workspace root. An absolute path is refused. */
  readonly path: string;
  /** Default true. `false` asserts the file must **not** be there. */
  readonly mustExist?: boolean;
  /** The exact bytes, as lowercase or uppercase hex, no separators. */
  readonly expectBytesHex?: string;
  /** The exact contents, as UTF-8 text. Mutually exclusive with the hex form. */
  readonly expectText?: string;
  /** The exact size. Checked on its own, and implied by the two above. */
  readonly expectSizeBytes?: number;
  /** Refuse a UTF-8 byte-order mark. */
  readonly forbidBom?: boolean;
  /** Refuse a trailing `\n` or `\r\n`. */
  readonly forbidTrailingNewline?: boolean;
  /**
   * The acceptance criteria this check proves, verbatim.
   *
   * What binds a result to what it actually demonstrates. A check with no
   * criteria proves nothing in particular: it is recorded, and it settles
   * nothing on the ledger.
   */
  readonly criteria?: readonly string[];
}

export type FileCheckOutcome =
  | 'ok'
  | 'missing'
  | 'unexpectedly-present'
  | 'not-a-file'
  | 'content-mismatch'
  | 'size-mismatch'
  | 'bom-present'
  | 'trailing-newline'
  | 'too-large'
  | 'read-error'
  /** The path left the workspace. A refusal, not a failure. */
  | 'outside-workspace'
  | 'invalid-request';

export interface FileCheckResult {
  readonly request: FileCheckRequest;
  readonly passed: boolean;
  readonly outcome: FileCheckOutcome;
  /** One sentence a person can act on. Null only when the check passed. */
  readonly problem: string | null;
  /** The absolute path actually opened, after resolving links. */
  readonly resolvedPath: string | null;
  readonly sizeBytes: number | null;
  /** SHA-256 of the bytes read, so a claim about content can be checked later. */
  readonly sha256: string | null;
  readonly checkedAt: string;
}

/**
 * The largest file this will read into memory.
 *
 * A check exists to confirm small, exact content. Something larger is a job
 * for a registered command, and reading it here would let a request written by
 * a model decide how much memory the application spends.
 */
export const MAX_CHECKED_BYTES = 1024 * 1024;

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Reads one file and answers one question about it.
 *
 * Never throws: every failure is an outcome, because a check that threw would
 * take the run down with it and tell nobody why.
 */
export async function runFileCheck(
  workspaceRoot: string,
  request: FileCheckRequest,
): Promise<FileCheckResult> {
  const checkedAt = new Date().toISOString();
  const base = { request, checkedAt, resolvedPath: null, sizeBytes: null, sha256: null } as const;
  const fail = (outcome: FileCheckOutcome, problem: string): FileCheckResult => ({
    ...base,
    passed: false,
    outcome,
    problem,
  });

  const invalid = describeInvalid(request);
  if (invalid) return fail('invalid-request', invalid);

  const target = resolveInside(workspaceRoot, request.path);
  if (!target) {
    return fail(
      'outside-workspace',
      `O caminho "${request.path}" sai da pasta do projeto. Nada foi lido.`,
    );
  }

  // Resolve links before deciding. A symlink inside the workspace that points
  // outside it is exactly the case a lexical check would wave through.
  let realTarget = target;
  try {
    realTarget = await realpath(target);
  } catch {
    // The file may simply not exist yet; that is answered below, not here.
  }
  if (realTarget !== target && !isInside(await realRoot(workspaceRoot), realTarget)) {
    return fail(
      'outside-workspace',
      `"${request.path}" é um link que aponta para fora da pasta do projeto. Nada foi lido.`,
    );
  }

  let info;
  try {
    info = await stat(realTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (request.mustExist === false) {
        return { ...base, passed: true, outcome: 'ok', problem: null, resolvedPath: realTarget };
      }
      return {
        ...fail('missing', `O arquivo "${request.path}" não existe na pasta do projeto.`),
        resolvedPath: realTarget,
      };
    }
    return {
      ...fail('read-error', `Não foi possível ler "${request.path}": ${code ?? 'erro desconhecido'}.`),
      resolvedPath: realTarget,
    };
  }

  if (request.mustExist === false) {
    return {
      ...fail('unexpectedly-present', `O arquivo "${request.path}" existe, e não deveria existir.`),
      resolvedPath: realTarget,
      sizeBytes: info.size,
    };
  }
  if (!info.isFile()) {
    return {
      ...fail('not-a-file', `"${request.path}" existe, mas não é um arquivo comum.`),
      resolvedPath: realTarget,
    };
  }
  if (info.size > MAX_CHECKED_BYTES) {
    return {
      ...fail(
        'too-large',
        `"${request.path}" tem ${info.size} bytes, acima do limite de ${MAX_CHECKED_BYTES} ` +
          'para verificação direta. Use uma verificação registrada.',
      ),
      resolvedPath: realTarget,
      sizeBytes: info.size,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(realTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...fail('read-error', `Não foi possível ler "${request.path}": ${code ?? 'erro desconhecido'}.`),
      resolvedPath: realTarget,
      sizeBytes: info.size,
    };
  }

  const found = {
    resolvedPath: realTarget,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const problem = compare(request, bytes);
  if (problem) return { ...base, ...found, passed: false, outcome: problem.outcome, problem: problem.text };
  return { ...base, ...found, passed: true, outcome: 'ok', problem: null };
}

/* ------------------------------------------------------------------ *
 * Reading a file for the supervisor
 * ------------------------------------------------------------------ */

/** What the supervisor asked to see. Data, never a command. */
export interface FileReadRequest {
  readonly path: string;
  /** Bytes to return, capped. Omitted means the default budget. */
  readonly maxBytes?: number;
}

export interface FileReadResult {
  readonly request: FileReadRequest;
  readonly ok: boolean;
  readonly outcome: FileCheckOutcome;
  readonly resolvedPath: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  /** The text, truncated to the budget. Null when nothing was read. */
  readonly text: string | null;
  /** True when the file is longer than what came back. */
  readonly truncated: boolean;
  readonly problem: string | null;
}

/** What one read may return, and what the whole round may return. */
export const MAX_READ_BYTES = 16 * 1024;
export const MAX_READ_TOTAL_BYTES = 64 * 1024;

/**
 * Reads a file so the supervisor does not have to ask the worker to copy it.
 *
 * The incident this exists for: the supervisor asked the worker, over and over,
 * for the full contents of four files it had just written. The answers came
 * back truncated, the criteria stayed pending, and the run climbed to a
 * stronger model for a problem no model could fix - the application could have
 * opened the files itself the whole time.
 *
 * Same boundary as a file check, for the same reason: resolved inside the
 * workspace, checked after following links, never a command, and bounded, so a
 * large file cannot fill a prompt. Truncation is *reported*, because a silent
 * truncation is how the supervisor came to believe it had seen a whole file.
 */
export async function runFileRead(
  workspaceRoot: string,
  request: FileReadRequest,
  budget: number = MAX_READ_BYTES,
): Promise<FileReadResult> {
  const empty = {
    request,
    resolvedPath: null,
    sizeBytes: null,
    sha256: null,
    text: null,
    truncated: false,
  } as const;
  const check = await runFileCheck(workspaceRoot, { path: request.path });
  if (!check.passed) {
    return { ...empty, ok: false, outcome: check.outcome, problem: check.problem };
  }

  const limit = Math.max(0, Math.min(request.maxBytes ?? budget, budget));
  try {
    const bytes = await readFile(check.resolvedPath!);
    const shown = bytes.subarray(0, limit);
    return {
      request,
      ok: true,
      outcome: 'ok',
      resolvedPath: check.resolvedPath,
      sizeBytes: bytes.byteLength,
      sha256: check.sha256,
      text: shown.toString('utf8'),
      truncated: bytes.byteLength > shown.byteLength,
      problem: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...empty,
      ok: false,
      outcome: 'read-error',
      resolvedPath: check.resolvedPath,
      problem: `Não foi possível ler "${request.path}": ${code ?? 'erro desconhecido'}.`,
    };
  }
}

/**
 * Reads several files under one shared budget.
 *
 * The budget is shared on purpose: five files at the per-file limit would be a
 * prompt nobody can read and a cost nobody chose. Files that do not fit are
 * reported as such rather than dropped in silence.
 */
export async function runFileReads(
  workspaceRoot: string,
  requests: readonly FileReadRequest[],
): Promise<FileReadResult[]> {
  const out: FileReadResult[] = [];
  let remaining = MAX_READ_TOTAL_BYTES;
  for (const request of requests) {
    if (remaining <= 0) {
      out.push({
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
    const result = await runFileRead(workspaceRoot, request, Math.min(MAX_READ_BYTES, remaining));
    remaining -= result.text ? Buffer.byteLength(result.text, 'utf8') : 0;
    out.push(result);
  }
  return out;
}

/** One read, as the supervisor's prompt shows it. */
export function describeFileRead(result: FileReadResult): string {
  if (!result.ok) return `FALHOU ${result.request.path} — ${result.problem ?? result.outcome}`;
  return (
    `${result.request.path} (${result.sizeBytes} bytes, sha256 ${result.sha256?.slice(0, 12)}…` +
    `${result.truncated ? ', TRUNCADO' : ''})`
  );
}

/** Runs several checks, in order, and never lets one failure hide the rest. */
export async function runFileChecks(
  workspaceRoot: string,
  requests: readonly FileCheckRequest[],
): Promise<FileCheckResult[]> {
  const results: FileCheckResult[] = [];
  for (const request of requests) results.push(await runFileCheck(workspaceRoot, request));
  return results;
}

/** A one-line description for a step summary or a prompt. */
export function describeFileCheck(result: FileCheckResult): string {
  const size = result.sizeBytes === null ? 'tamanho não lido' : `${result.sizeBytes} bytes`;
  return result.passed
    ? `PASS ${result.request.path} (${size}, sha256 ${result.sha256?.slice(0, 12) ?? '—'})`
    : `FAIL ${result.request.path} — ${result.problem ?? result.outcome}`;
}

function compare(
  request: FileCheckRequest,
  bytes: Buffer,
): { outcome: FileCheckOutcome; text: string } | null {
  if (request.forbidBom && bytes.subarray(0, 3).equals(BOM)) {
    return {
      outcome: 'bom-present',
      text: `"${request.path}" começa com BOM (EF BB BF), e não deveria.`,
    };
  }
  if (request.forbidTrailingNewline && endsWithNewline(bytes)) {
    return {
      outcome: 'trailing-newline',
      text: `"${request.path}" termina com quebra de linha, e não deveria.`,
    };
  }

  const expected = expectedBytes(request);
  if (expected) {
    if (!bytes.equals(expected)) {
      return {
        outcome: 'content-mismatch',
        text:
          `"${request.path}" não tem o conteúdo esperado. ` +
          `Esperado ${expected.byteLength} bytes (${hexOf(expected)}); ` +
          `encontrado ${bytes.byteLength} bytes (${hexOf(bytes)}).`,
      };
    }
    return null;
  }

  if (request.expectSizeBytes !== undefined && bytes.byteLength !== request.expectSizeBytes) {
    return {
      outcome: 'size-mismatch',
      text:
        `"${request.path}" tem ${bytes.byteLength} bytes; ` +
        `o esperado era ${request.expectSizeBytes}.`,
    };
  }
  return null;
}

function expectedBytes(request: FileCheckRequest): Buffer | null {
  if (request.expectBytesHex !== undefined) {
    return Buffer.from(request.expectBytesHex.replace(/\s+/g, ''), 'hex');
  }
  if (request.expectText !== undefined) return Buffer.from(request.expectText, 'utf8');
  return null;
}

function endsWithNewline(bytes: Buffer): boolean {
  return bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0a;
}

/** The first 64 bytes as hex, which is what a person compares by eye. */
function hexOf(bytes: Buffer): string {
  const head = bytes.subarray(0, 64);
  const text = [...head].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  return head.byteLength < bytes.byteLength ? `${text} …` : text || '(vazio)';
}

/**
 * Why a request cannot be run at all.
 *
 * Validated before anything is opened, so a malformed request is refused
 * rather than half-executed.
 */
function describeInvalid(request: FileCheckRequest): string | null {
  if (typeof request.path !== 'string' || request.path.trim().length === 0) {
    return 'A verificação de arquivo veio sem caminho.';
  }
  if (request.path.includes('\0')) return 'O caminho contém um byte nulo.';
  if (isAbsolute(request.path)) {
    return `O caminho "${request.path}" é absoluto. Use um caminho relativo à pasta do projeto.`;
  }
  if (request.expectBytesHex !== undefined) {
    const hex = request.expectBytesHex.replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      return 'expectBytesHex não é uma sequência hexadecimal válida.';
    }
    if (hex.length / 2 > MAX_CHECKED_BYTES) return 'expectBytesHex é grande demais.';
    if (request.expectText !== undefined) {
      return 'Use expectBytesHex ou expectText, não os dois.';
    }
  }
  if (request.expectText !== undefined && request.expectText.length > MAX_CHECKED_BYTES) {
    return 'expectText é grande demais.';
  }
  if (
    request.expectSizeBytes !== undefined &&
    (!Number.isInteger(request.expectSizeBytes) || request.expectSizeBytes < 0)
  ) {
    return 'expectSizeBytes precisa ser um inteiro não negativo.';
  }
  return null;
}

/** The absolute path inside the workspace, or null when it escapes. */
function resolveInside(workspaceRoot: string, relative: string): string | null {
  const root = resolve(workspaceRoot);
  const target = resolve(root, relative);
  return isInside(root, target) ? target : null;
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function realRoot(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(resolve(workspaceRoot));
  } catch {
    return resolve(workspaceRoot);
  }
}
