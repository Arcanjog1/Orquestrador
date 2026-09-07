/**
 * Proves whether a downloaded executable can be run - and when it cannot,
 * says which of the many different failures it was.
 *
 * "The executable did not report a version within 180 s" used to be the one
 * sentence for every failure: a refused start, a crash, a non-zero exit, an
 * empty answer and a real hang all read the same. Nothing could be fixed
 * from that. This module keeps the two questions apart:
 *
 *   1. static  - is the file there, whole, and an executable for this
 *                machine? (exists, stable size, SHA-256, PE header, machine,
 *                open handles, Mark-of-the-Web)
 *   2. execute - what did the operating system do when asked to run it, with
 *                exactly `--version`? (PID, start, output, exit, kill)
 *
 * On a failure it then runs the same file a few more ways, each one designed
 * to separate one suspect from the others: a second start (first-start
 * scanning), a direct `child_process` spawn (our own wrapper), a spawn with
 * no console window (Windows console creation), an empty profile directory
 * (the person's existing configuration) and a copy in a controlled folder
 * (the staging path). Those comparison runs are diagnosis only - the product
 * still installs nothing that the product's own path cannot run.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildSpawnPlan, ProcessManager, type ProcessResult, type ProcessTrace } from '../process/process-manager.js';
import { removeTreeWithRetry } from './fs-retry.js';

export type ExecutionState =
  | 'OK'
  /** The file is not there (any more). */
  | 'FILE_MISSING'
  /** Not a whole executable for this machine: truncated, wrong format, wrong architecture. */
  | 'INVALID_EXECUTABLE'
  /** Another process holds the file open (Windows sharing violation). */
  | 'FILE_LOCKED'
  /** The operating system refused to create the process. */
  | 'ACCESS_DENIED'
  /** The process could not be created for another reason. */
  | 'SPAWN_FAILED'
  /** Created, alive for the whole timeout, never wrote a byte. */
  | 'PROCESS_STARTED_NO_OUTPUT'
  /** Created, alive for the whole timeout, wrote only to stderr. */
  | 'PROCESS_STARTED_STDERR_ONLY'
  /** Wrote to stdout but never ended. */
  | 'PROCESS_HUNG'
  /** Exited 0 without a version line. */
  | 'PROCESS_EXITED_NO_VERSION'
  | 'PROCESS_EXITED_NONZERO'
  /** Died with an NTSTATUS-style code: access violation, missing DLL, ... */
  | 'PROCESS_CRASHED'
  /** Ended by a signal or by a cancel, not by our timeout. */
  | 'PROCESS_KILLED'
  /**
   * AWS-LC (the crypto library inside Codex 0.105+) aborted at start-up
   * because the `OPENSSL_ia32cap` environment variable asked for a CPU
   * capability this processor does not report. The variable, not the CPU.
   */
  | 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE';

/** States that mean "the bytes are fine; this machine could not run them". */
const LOCAL_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set<ExecutionState>([
  'FILE_LOCKED',
  'ACCESS_DENIED',
  'SPAWN_FAILED',
  'PROCESS_STARTED_NO_OUTPUT',
  'PROCESS_STARTED_STDERR_ONLY',
  'PROCESS_HUNG',
  'PROCESS_EXITED_NO_VERSION',
  'PROCESS_EXITED_NONZERO',
  'PROCESS_CRASHED',
  'PROCESS_KILLED',
  'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE',
]);

/**
 * The variables OpenSSL-family libraries read to override CPU detection.
 * AWS-LC's `OPENSSL_cpuid_setup` (crypto/fipsmodule/cpucap/cpu_intel.c)
 * returns at once when `OPENSSL_ia32cap` is unset; when it is set to a value
 * that requests a bit the CPU lacks, it prints the fatal error below and
 * calls abort() - from a static initializer, before `main`, so `--version`
 * never runs. Windows reads environment names case-insensitively, hence the
 * lower-casing here.
 */
export const CPU_OVERRIDE_ENV_NAMES = ['OPENSSL_ia32cap', 'OPENSSL_armcap'] as const;

const CAPABILITY_ABORT =
  /Fatal Error: HW capability found: (0x[0-9A-Fa-f]+) (0x[0-9A-Fa-f]+), but HW capability requested: (0x[0-9A-Fa-f]+) (0x[0-9A-Fa-f]+)/;

export interface CapabilityAbort {
  /** CPUID leaf 1 EDX and ECX as the library read them. */
  found: [string, string];
  /** What the environment variable asked for. */
  requested: [string, string];
}

/** The exact AWS-LC signature, from stderr; null when it is not there. */
export function parseCapabilityAbort(stderr: string): CapabilityAbort | null {
  const m = CAPABILITY_ABORT.exec(stderr);
  if (!m) return null;
  return { found: [m[1]!, m[2]!], requested: [m[3]!, m[4]!] };
}

/**
 * The real keys under which `names` are set in `env`, compared
 * case-insensitively (Windows does), each mapped to `undefined`: the overlay
 * `buildChildEnv` needs to drop them from a child's environment.
 */
export function dropEnvKeys(env: NodeJS.ProcessEnv, names: readonly string[]): Record<string, undefined> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const overlay: Record<string, undefined> = {};
  for (const key of Object.keys(env)) {
    if (wanted.has(key.toLowerCase())) overlay[key] = undefined;
  }
  return overlay;
}

/** `NAME=value` for each override variable present, whatever its casing. */
export function cpuOverridesIn(env: NodeJS.ProcessEnv): Array<{ key: string; value: string }> {
  const wanted = new Set(CPU_OVERRIDE_ENV_NAMES.map((n) => n.toLowerCase()));
  return Object.entries(env)
    .filter(([key, value]) => wanted.has(key.toLowerCase()) && value !== undefined)
    .map(([key, value]) => ({ key, value: value as string }));
}

/** What a runtime's child processes must not inherit, and why. */
export interface EnvironmentPolicy {
  drop: string[];
  reason: string;
}

/**
 * True when downloading the same build again could not change the outcome:
 * the file was whole and this machine failed to run it. A second source
 * ships the same bytes (the npm package vendors the GitHub release binary;
 * for 0.153.4 the two `codex.exe` are byte-identical, SHA-256 444a3f00…).
 */
export function isLocalExecutionFailure(state: ExecutionState): boolean {
  return LOCAL_EXECUTION_STATES.has(state);
}

export interface PeFacts {
  machine: string;
  is64: boolean;
  subsystem: 'console' | 'gui' | 'other';
  /** An Authenticode signature is present (the certificate is not verified here). */
  signed: boolean;
}

export interface StaticInspection {
  path: string;
  exists: boolean;
  bytes: number | null;
  /** Size unchanged across two readings: the writer is done. */
  stableSize: boolean;
  sha256: string | null;
  format: 'pe' | 'elf' | 'macho' | 'script' | 'unknown' | null;
  pe: PeFacts | null;
  /** The file could be opened for writing: nothing else holds it. Null when not tried. */
  openForWrite: boolean | null;
  openError: string | null;
  /** Windows Mark-of-the-Web (`:Zone.Identifier`), first line, or null when absent. */
  zoneIdentifier: string | null;
  /** Set when the file cannot be run as it is. */
  problem: string | null;
}

export interface ExecutionRun {
  label: string;
  via: 'process-manager' | 'child_process';
  argv: string[];
  cwd: string;
  /** Names and safe values of the variables that matter. */
  env: Record<string, string>;
  state: ExecutionState;
  startedAt: string;
  durationMs: number;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutFirstLine: string | null;
  stderrFirstLine: string | null;
  versionLine: string | null;
  /** Milliseconds from spawn to the first byte on either stream. */
  firstOutputAfterMs: number | null;
  error: string | null;
  errorCode: string | null;
  termination: string | null;
  notes: string[];
  /** Set when stderr carried AWS-LC's capability abort. */
  capability: CapabilityAbort | null;
}

export interface ExecutionProbe {
  executable: string;
  static: StaticInspection;
  runs: ExecutionRun[];
  /** The verdict the product acts on: the first run through its own path. */
  state: ExecutionState;
  /** True when a later run through the product's own path succeeded. */
  recovered: boolean;
  versionLine: string | null;
  /** First start slow, next start fast: the file was being scanned. */
  antivirusDelaySuspected: boolean;
  /**
   * Proved on this machine: the executable runs once these variables are
   * left out of its environment. Recorded in the manifest and applied to
   * every run of the managed build. Null when nothing had to be dropped.
   */
  environmentPolicy: EnvironmentPolicy | null;
  conclusions: string[];
}

export interface ProbeOptions {
  executablePath: string;
  args?: string[];
  cwd: string;
  processManager: ProcessManager;
  /** Timeout of the run the product decides on. */
  timeoutMs: number;
  /** Timeout of each comparison run. */
  followUpTimeoutMs?: number;
  /** Where scratch profile and controlled-copy folders may be created. */
  scratchRoot?: string;
  /** `CODEX_HOME`, `CLAUDE_CONFIG_DIR`: the variable that names the profile directory. */
  homeEnvVar?: string | null;
  platform?: NodeJS.Platform;
  arch?: 'x64' | 'arm64';
  /** Run the comparison runs when the first run fails. */
  thorough?: boolean;
  /** Hash the file in the static check. Default true. */
  hash?: boolean;
  /** Applied to every run through the ProcessManager (a manifest's policy). */
  envOverlay?: Record<string, string | undefined>;
  /** A run slower than this triggers the second-start measurement. */
  slowStartMs?: number;
  onStep?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

const ENV_OF_INTEREST = [
  'OPENSSL_ia32cap',
  'OPENSSL_armcap',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'RUST_LOG',
  'RUST_BACKTRACE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

/** Exit codes Windows reports for a process that died rather than returned. */
const NTSTATUS_NAMES: Record<number, string> = {
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc0000017: 'STATUS_NO_MEMORY',
  0xc0000022: 'STATUS_ACCESS_DENIED',
  0xc000007b: 'STATUS_INVALID_IMAGE_FORMAT',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000135: 'STATUS_DLL_NOT_FOUND',
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  0xc0000142: 'STATUS_DLL_INIT_FAILED',
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN',
};

const PE_MACHINES: Record<number, string> = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
};

/* ----------------------------------------------------------------- static */

export async function inspectExecutable(
  path: string,
  options: {
    platform?: NodeJS.Platform;
    arch?: 'x64' | 'arm64';
    sleep?: (ms: number) => Promise<void>;
    /** Hash the file (a 295 MB read); off for routine health checks. */
    hash?: boolean;
  } = {},
): Promise<StaticInspection> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: StaticInspection = {
    path,
    exists: false,
    bytes: null,
    stableSize: false,
    sha256: null,
    format: null,
    pe: null,
    openForWrite: null,
    openError: null,
    zoneIdentifier: null,
    problem: null,
  };

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    result.problem = 'the file is not there';
    return result;
  }
  result.exists = true;
  result.bytes = size;

  // Extraction is a separate process that has exited by now; a size that
  // still moves means someone is writing, and the file is not whole.
  await sleep(250);
  let again = size;
  try {
    again = statSync(path).size;
  } catch {
    result.exists = false;
    result.problem = 'the file disappeared while being checked';
    return result;
  }
  result.stableSize = again === size;
  result.bytes = again;
  if (!result.stableSize) {
    result.problem = `the file is still being written (${size} then ${again} bytes)`;
    return result;
  }
  if (again === 0) {
    result.problem = 'the file is empty';
    return result;
  }

  const head = readHead(path, 4096);
  const format = detectFormat(head);
  result.format = format;
  const isWindowsExe = platform === 'win32' && /\.exe$/i.test(path);
  if (isWindowsExe) {
    if (format !== 'pe') {
      result.problem = `not a Windows executable: no MZ/PE header (starts with ${hex(head.subarray(0, 4))})`;
    } else {
      const pe = readPe(head);
      result.pe = pe;
      if (!pe) {
        result.problem = 'the PE header is truncated or malformed';
      } else if (pe.machine !== arch) {
        result.problem = `built for ${pe.machine}, this machine runs ${arch}`;
      }
    }
  }

  if (options.hash !== false) result.sha256 = await sha256Of(path);

  // A handle someone else still holds refuses a write open on Windows with a
  // sharing violation; the same open is harmless elsewhere.
  try {
    closeSync(openSync(path, 'r+'));
    result.openForWrite = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    result.openForWrite = false;
    result.openError = code;
    if (code === 'EBUSY' || code === 'ETXTBSY' || (platform === 'win32' && code === 'EPERM')) {
      result.problem ??= `another process holds the file open (${code})`;
    }
  }

  if (platform === 'win32') {
    result.zoneIdentifier = readZoneIdentifier(path);
  }
  return result;
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function detectFormat(head: Buffer): StaticInspection['format'] {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'elf';
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    if (magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe) return 'macho';
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return 'script';
  if (/^@echo|^@rem|^rem |^echo /i.test(head.subarray(0, 8).toString('latin1'))) return 'script';
  return 'unknown';
}

/** Enough of the PE header to know what the file is, without a PE library. */
export function readPe(head: Buffer): PeFacts | null {
  if (head.length < 0x40) return null;
  const peOffset = head.readUInt32LE(0x3c);
  if (peOffset + 24 > head.length) return null;
  if (head.readUInt32BE(peOffset) !== 0x50450000) return null; // "PE\0\0"
  const machineCode = head.readUInt16LE(peOffset + 4);
  const optionalSize = head.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  if (optionalSize < 2 || optional + optionalSize > head.length) return null;
  const magic = head.readUInt16LE(optional);
  const is64 = magic === 0x20b;
  const subsystemCode = head.readUInt16LE(optional + 68);
  // Data directory 4 is the certificate table; a non-empty one is a signature.
  const directories = optional + (is64 ? 112 : 96);
  const securityEntry = directories + 4 * 8;
  const signed = securityEntry + 8 <= head.length && head.readUInt32LE(securityEntry + 4) > 0;
  return {
    machine: PE_MACHINES[machineCode] ?? `0x${machineCode.toString(16)}`,
    is64,
    subsystem: subsystemCode === 3 ? 'console' : subsystemCode === 2 ? 'gui' : 'other',
    signed,
  };
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function readZoneIdentifier(path: string): string | null {
  try {
    const text = readFileSync(`${path}:Zone.Identifier`, 'utf8');
    const zone = /ZoneId=(\d+)/.exec(text);
    return zone ? `ZoneId=${zone[1]}` : text.split(/\r?\n/)[0] ?? '';
  } catch {
    return null;
  }
}

function hex(bytes: Buffer): string {
  return bytes.length ? [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ') : '(empty)';
}

/* ---------------------------------------------------------------- execute */

/** The state of one finished run, from the ProcessManager's own record. */
export function classifyRun(result: ProcessResult, versionLine: string | null): ExecutionState {
  const trace = result.trace;
  // The library's own words beat the exit code: on Windows abort() reports
  // 0xC0000409, on Linux SIGABRT, and both mean this one thing.
  if (parseCapabilityAbort(result.stderr)) return 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE';
  if (result.outcome === 'spawn-error') {
    switch (trace.errorCode) {
      case 'EACCES':
      case 'EPERM':
        return 'ACCESS_DENIED';
      case 'EBUSY':
      case 'ETXTBSY':
        return 'FILE_LOCKED';
      case 'ENOENT':
        return 'FILE_MISSING';
      default:
        return 'SPAWN_FAILED';
    }
  }
  if (result.outcome === 'cancelled') return 'PROCESS_KILLED';
  if (result.outcome === 'timeout') {
    if (trace.stdoutBytes === 0 && trace.stderrBytes === 0) return 'PROCESS_STARTED_NO_OUTPUT';
    if (trace.stdoutBytes === 0) return 'PROCESS_STARTED_STDERR_ONLY';
    return 'PROCESS_HUNG';
  }
  if (result.signal !== null) return 'PROCESS_KILLED';
  if (result.exitCode === 0) return versionLine ? 'OK' : 'PROCESS_EXITED_NO_VERSION';
  if (result.exitCode !== null && (result.exitCode >>> 0) >= 0xc0000000) return 'PROCESS_CRASHED';
  return 'PROCESS_EXITED_NONZERO';
}

/** A version line: the first non-empty line of stdout, else of stderr. */
export function versionLineOf(stdout: string, stderr: string): string | null {
  const line = (stdout || stderr).split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  return line && line.length > 0 ? line : null;
}

/** Names and safe values: paths are fine, proxy URLs (credentials) are not. */
export function summariseEnv(env: NodeJS.ProcessEnv, extra: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const byLower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v] as const));
  for (const name of [...ENV_OF_INTEREST, ...extra]) {
    // Windows environment names are case-insensitive; `OPENSSL_IA32CAP` set
    // through the system dialog is the same variable as `OPENSSL_ia32cap`.
    const value = env[name] ?? byLower.get(name.toLowerCase());
    if (value === undefined) {
      out[name] = '(não definido)';
    } else if (/PROXY/i.test(name)) {
      out[name] = 'definido';
    } else {
      out[name] = value;
    }
  }
  const path = env.PATH ?? env.Path ?? '';
  const entries = path.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const codexEntries = entries.filter((e) => /codex/i.test(e));
  out.PATH = `${entries.length} entradas${codexEntries.length ? `, codex em: ${codexEntries.join(' ; ')}` : ''}`;
  return out;
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  return line ? line.slice(0, 200) : null;
}

function runFromResult(
  label: string,
  via: ExecutionRun['via'],
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  result: ProcessResult,
): ExecutionRun {
  const versionLine = versionLineOf(result.stdout, result.stderr);
  const state = classifyRun(result, versionLine);
  const trace = result.trace;
  const spawnMs = Date.parse(trace.spawnedAt);
  const firstAt = [trace.firstStdoutAt, trace.firstStderrAt].filter((t): t is string => t !== null).map(Date.parse);
  const notes: string[] = [];
  if (trace.streamsLingered) notes.push('o processo saiu, mas os pipes ficaram abertos: outro processo herdou os handles');
  if (trace.survivedTermination) notes.push('o processo continuou vivo depois de todas as tentativas de encerrar');
  if (trace.pid !== null && trace.startedAt === null && result.outcome !== 'spawn-error') {
    notes.push('o sistema nunca confirmou a criação do processo (sem evento spawn)');
  }
  return {
    label,
    via,
    argv,
    cwd,
    env: summariseEnv(env),
    state,
    startedAt: trace.spawnedAt,
    durationMs: result.durationMs,
    pid: trace.pid,
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutBytes: trace.stdoutBytes,
    stderrBytes: trace.stderrBytes,
    stdoutFirstLine: firstLine(result.stdout),
    stderrFirstLine: firstLine(result.stderr),
    versionLine: state === 'OK' ? versionLine : null,
    firstOutputAfterMs: firstAt.length ? Math.min(...firstAt) - spawnMs : null,
    error: result.error ?? null,
    errorCode: trace.errorCode,
    termination:
      trace.termination && trace.termination.attempts.length > 0
        ? trace.termination.attempts.map((a) => `${a.method} → ${a.exited ? 'saiu' : 'não saiu'}`).join(', ')
        : null,
    notes,
    capability: parseCapabilityAbort(result.stderr),
  };
}

/**
 * The same executable through Node's `child_process` alone, with no
 * ProcessManager in the way. Diagnosis only: if this answers and the
 * product's path does not, the difference is ours.
 */
export async function rawSpawn(options: {
  executablePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  windowsHide?: boolean;
}): Promise<ProcessResult> {
  const startedAt = new Date();
  const trace: ProcessTrace = {
    pid: null,
    spawnedAt: startedAt.toISOString(),
    startedAt: null,
    firstStdoutAt: null,
    firstStderrAt: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    exitedAt: null,
    closedAt: null,
    errorAt: null,
    errorCode: null,
    streamsLingered: false,
    survivedTermination: false,
    idleTimedOut: false,
    lastActivityAt: null,
    termination: null,
  };
  const base = (partial: Partial<ProcessResult>): ProcessResult => ({
    outcome: 'completed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: Date.now() - startedAt.getTime(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    trace,
    ...partial,
  });

  // A real runtime is an .exe and is spawned as is. A .cmd launcher (the
  // test fixtures on Windows) has to go through cmd.exe - Node refuses it
  // otherwise - which is the one thing borrowed from the ProcessManager.
  let plan;
  try {
    plan = buildSpawnPlan(options.executablePath, options.args);
  } catch (error) {
    trace.errorAt = new Date().toISOString();
    return base({ outcome: 'spawn-error', error: (error as Error).message });
  }
  let child;
  try {
    child = spawn(plan.file, plan.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: options.windowsHide ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    trace.errorAt = new Date().toISOString();
    trace.errorCode = (error as NodeJS.ErrnoException).code ?? null;
    return base({ outcome: 'spawn-error', error: (error as Error).message });
  }
  trace.pid = child.pid ?? null;
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    trace.firstStdoutAt ??= new Date().toISOString();
    trace.stdoutBytes += Buffer.byteLength(chunk);
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    trace.firstStderrAt ??= new Date().toISOString();
    trace.stderrBytes += Buffer.byteLength(chunk);
    stderr.push(chunk);
  });
  child.stdin.on('error', () => {});
  child.stdin.end();
  child.once('spawn', () => {
    trace.startedAt = new Date().toISOString();
  });

  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let outcome: ProcessResult['outcome'] = 'completed';
    let error: string | undefined;
    let killMethod: string | null = null;
    // The one kill attempt goes on record whichever comes first: the child's
    // exit, or the wait for it running out.
    const recordKill = (): void => {
      if (!killMethod || !trace.termination || trace.termination.attempts.length > 0) return;
      trace.termination.attempts.push({
        method: killMethod,
        at: new Date().toISOString(),
        exited: child.exitCode !== null || child.signalCode !== null,
      });
    };
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recordKill();
      resolve(base({ outcome, exitCode: code, signal, stdout: stdout.join(''), stderr: stderr.join(''), ...(error ? { error } : {}) }));
    };
    const giveUp = (): void => {
      recordKill();
      if (!settled) {
        trace.survivedTermination = true;
        done(null, null);
      }
    };
    const timer = setTimeout(() => {
      outcome = 'timeout';
      error = `Process exceeded its ${Math.round(options.timeoutMs / 1000)}s timeout.`;
      trace.termination = { reason: 'timeout', attempts: [] };
      if (process.platform === 'win32' && child.pid) {
        killMethod = `taskkill /pid ${child.pid} /T /F`;
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => {});
        killer.on('close', () => setTimeout(giveUp, 2000));
      } else {
        killMethod = 'SIGKILL';
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        setTimeout(giveUp, 2000);
      }
    }, options.timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      trace.errorAt = new Date().toISOString();
      trace.errorCode = e.code ?? null;
      outcome = 'spawn-error';
      error = e.message;
      done(null, null);
    });
    child.on('exit', (code, signal) => {
      trace.exitedAt = new Date().toISOString();
      setTimeout(() => {
        if (!settled) {
          trace.streamsLingered = true;
          done(code, signal);
        }
      }, 5000);
    });
    child.on('close', (code, signal) => {
      trace.closedAt = new Date().toISOString();
      done(code, signal);
    });
  });
}

/* ------------------------------------------------------------------ probe */

/**
 * Static check, then the run the product decides on, then - on a failure -
 * the comparison runs. Every run is recorded; the conclusions name what the
 * comparisons showed.
 */
export async function probeExecution(options: ProbeOptions): Promise<ExecutionProbe> {
  const args = options.args ?? ['--version'];
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const say = options.onStep ?? (() => {});
  const followUp = options.followUpTimeoutMs ?? 30_000;
  const slowStartMs = options.slowStartMs ?? 5_000;
  const probe: ExecutionProbe = {
    executable: options.executablePath,
    static: await inspectExecutable(options.executablePath, {
      platform,
      arch: options.arch,
      hash: options.hash !== false,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    }),
    runs: [],
    state: 'OK',
    recovered: false,
    versionLine: null,
    antivirusDelaySuspected: false,
    environmentPolicy: null,
    conclusions: [],
  };
  const baseOverlay = options.envOverlay ?? {};

  if (probe.static.problem) {
    probe.state = !probe.static.exists
      ? 'FILE_MISSING'
      : probe.static.openError && /EBUSY|ETXTBSY|EPERM/.test(probe.static.openError) && probe.static.format === 'pe'
        ? 'FILE_LOCKED'
        : 'INVALID_EXECUTABLE';
    return probe;
  }

  const viaManager = async (
    label: string,
    cwd: string,
    overlay: Record<string, string | undefined> | undefined,
    timeoutMs: number,
  ): Promise<ExecutionRun> => {
    const merged = { ...baseOverlay, ...(overlay ?? {}) };
    const result = await options.processManager.run({
      command: options.executablePath,
      args,
      cwd,
      ...(Object.keys(merged).length ? { env: merged } : {}),
      timeoutMs,
    });
    const seen: NodeJS.ProcessEnv = { ...env };
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined) delete seen[k];
      else seen[k] = v;
    }
    const run = runFromResult(label, 'process-manager', args, cwd, seen, result);
    probe.runs.push(run);
    return run;
  };

  say('Testando o executável...');
  const first = await viaManager('ProcessManager, primeira execução', options.cwd, undefined, options.timeoutMs);
  probe.state = first.state;
  probe.versionLine = first.versionLine;

  if (first.state === 'OK') {
    if (first.durationMs >= slowStartMs) {
      say('Medindo a segunda execução...');
      const second = await viaManager('ProcessManager, segunda execução', options.cwd, undefined, options.timeoutMs);
      if (second.state === 'OK' && second.durationMs * 4 < first.durationMs) {
        probe.antivirusDelaySuspected = true;
        probe.conclusions.push(
          `a primeira execução levou ${seconds(first.durationMs)} e a segunda ${seconds(second.durationMs)}: o primeiro início foi retido (antivírus varrendo o arquivo novo)`,
        );
      }
    }
    return probe;
  }

  if (!options.thorough) return probe;

  // 0. AWS-LC's capability abort: the environment asked for a CPU bit the
  //    processor lacks. The same file, with the override left out of the
  //    child's environment only - nothing on the machine changes - is the
  //    proof, and the policy the managed build then runs under.
  if (first.capability) {
    const overrides = cpuOverridesIn(env);
    const drop = dropEnvKeys(env, CPU_OVERRIDE_ENV_NAMES);
    say('Testando sem OPENSSL_ia32cap no processo filho...');
    const without = await viaManager('ProcessManager, sem OPENSSL_ia32cap', options.cwd, drop, followUp);
    const shown = overrides.map((o) => `${o.key}=${o.value}`).join(', ') || '(não encontrada no ambiente do aplicativo)';
    if (without.state === 'OK') {
      probe.recovered = true;
      probe.versionLine = without.versionLine;
      probe.environmentPolicy = {
        drop: [...CPU_OVERRIDE_ENV_NAMES],
        reason: `${shown} faz a AWS-LC abortar (pede ${first.capability.requested.join(' ')}, a CPU tem ${first.capability.found.join(' ')}); sem a variável o executável responde`,
      };
      probe.conclusions.push(
        `sem ${overrides.map((o) => o.key).join('/') || 'OPENSSL_ia32cap'} no ambiente do processo filho o executável respondeu (${without.versionLine}): a causa é a variável ${shown}, não o processador`,
      );
      return probe;
    }
    probe.conclusions.push(
      `mesmo sem OPENSSL_ia32cap no processo filho o executável falhou (${without.state}); ambiente visto pelo aplicativo: ${shown}`,
    );
  }

  // 1. The same path again, briefly: a first start held by a scan is fast now.
  say('Testando de novo (o primeiro início não respondeu)...');
  const second = await viaManager('ProcessManager, segunda execução', options.cwd, undefined, followUp);
  if (second.state === 'OK') {
    probe.recovered = true;
    probe.versionLine = second.versionLine;
    probe.antivirusDelaySuspected = true;
    probe.conclusions.push(
      `a segunda execução respondeu em ${seconds(second.durationMs)} depois de a primeira ficar ${seconds(first.durationMs)} sem resposta: o primeiro início do arquivo novo foi retido (antivírus)`,
    );
    return probe;
  }

  // 2. Node alone: is the wrapper the difference?
  say('Comparando com uma execução direta...');
  const rawEnv = { ...env };
  for (const [k, v] of Object.entries(baseOverlay)) {
    if (v === undefined) delete rawEnv[k];
    else rawEnv[k] = v;
  }
  const raw = await rawSpawn({ executablePath: options.executablePath, args, cwd: dirname(options.executablePath), env: rawEnv, timeoutMs: followUp });
  const rawRun = runFromResult('child_process direto (cwd = pasta do executável)', 'child_process', args, dirname(options.executablePath), rawEnv, raw);
  probe.runs.push(rawRun);
  if (rawRun.state === 'OK') {
    probe.conclusions.push('a execução direta por child_process respondeu e a do ProcessManager não: a diferença está no nosso wrapper (cwd, pipes ou encerramento)');
  }

  // 3. Windows: without a console window.
  if (platform === 'win32' && rawRun.state !== 'OK') {
    say('Comparando sem janela de console...');
    const hidden = await rawSpawn({ executablePath: options.executablePath, args, cwd: dirname(options.executablePath), env: rawEnv, timeoutMs: followUp, windowsHide: true });
    const hiddenRun = runFromResult('child_process direto, sem janela de console (windowsHide)', 'child_process', args, dirname(options.executablePath), rawEnv, hidden);
    probe.runs.push(hiddenRun);
    if (hiddenRun.state === 'OK') {
      probe.conclusions.push('sem janela de console o executável respondeu: a criação do console para o processo filho é a diferença');
    }
  }

  // 4. An empty profile directory: is the person's configuration the difference?
  if (options.homeEnvVar && options.scratchRoot) {
    const scratchHome = join(options.scratchRoot, `probe-home-${Date.now()}`);
    try {
      mkdirSync(scratchHome, { recursive: true });
      say(`Testando com ${options.homeEnvVar} vazio...`);
      const withScratch = await viaManager(`ProcessManager, ${options.homeEnvVar} vazio`, options.cwd, { [options.homeEnvVar]: scratchHome }, followUp);
      if (withScratch.state === 'OK') {
        const current = env[options.homeEnvVar] ?? '(não definido)';
        probe.conclusions.push(`com ${options.homeEnvVar} vazio o executável respondeu: o conteúdo do ${options.homeEnvVar} atual (${current}) impede o início`);
      }
    } finally {
      await removeTreeWithRetry(scratchHome, { maxWaitMs: 3000 });
    }
  }

  // 5. The same bytes in a controlled folder: is the staging path the difference?
  if (options.scratchRoot) {
    const controlledDir = join(options.scratchRoot, `probe-bin-${Date.now()}`);
    try {
      mkdirSync(controlledDir, { recursive: true });
      const copy = join(controlledDir, basename(options.executablePath));
      say('Testando uma cópia em pasta controlada...');
      copyFileSync(options.executablePath, copy);
      const copied = await inspectExecutable(copy, { platform, arch: options.arch, ...(options.sleep ? { sleep: options.sleep } : {}) });
      const result = await options.processManager.run({
        command: copy,
        args,
        cwd: controlledDir,
        ...(Object.keys(baseOverlay).length ? { env: baseOverlay } : {}),
        timeoutMs: followUp,
      });
      const copyRun = runFromResult(`ProcessManager, cópia em ${controlledDir}`, 'process-manager', args, controlledDir, env, result);
      if (copied.sha256 !== probe.static.sha256) copyRun.notes.push(`a cópia tem outro SHA-256 (${copied.sha256})`);
      probe.runs.push(copyRun);
      if (copyRun.state === 'OK') {
        probe.conclusions.push('a mesma cópia (mesmo SHA-256) respondeu em uma pasta controlada: a pasta de staging é a diferença');
      }
    } catch (error) {
      probe.conclusions.push(`a cópia em pasta controlada não pôde ser feita: ${(error as Error).message}`);
    } finally {
      await removeTreeWithRetry(controlledDir, { maxWaitMs: 3000 });
    }
  }

  if (probe.conclusions.length === 0) {
    probe.conclusions.push('nenhuma variação (segunda execução, execução direta, perfil vazio, pasta controlada) respondeu: o executável não inicia nesta máquina de forma alguma');
  }
  return probe;
}

/* ---------------------------------------------------------------- describe */

/** The block a person can copy from "Detalhes" and send back. */
export function describeProbe(probe: ExecutionProbe, platform: NodeJS.Platform = process.platform): string {
  const os = platform === 'win32' ? 'O Windows' : 'O sistema';
  const s = probe.static;
  const lines: string[] = [];
  lines.push(headline(probe, os));
  lines.push(`estado: ${probe.state}${probe.recovered ? ' (recuperado na segunda execução)' : ''}`);
  const facts: string[] = [];
  if (s.bytes !== null) facts.push(`${s.bytes.toLocaleString('pt-BR')} bytes`);
  if (s.sha256) facts.push(`sha256 ${s.sha256.slice(0, 8)}…${s.sha256.slice(-4)}`);
  if (s.pe) facts.push(`PE ${s.pe.machine} ${s.pe.subsystem}${s.pe.is64 ? '' : ' 32-bit'}`, `assinado: ${s.pe.signed ? 'sim' : 'não'}`);
  else if (s.format) facts.push(`formato: ${s.format}`);
  if (s.openForWrite !== null) facts.push(s.openForWrite ? 'sem outro handle aberto' : `abrir para escrita falhou (${s.openError})`);
  if (platform === 'win32') facts.push(`Zone.Identifier: ${s.zoneIdentifier ?? 'não'}`);
  lines.push(`executável: ${s.path}${facts.length ? ` (${facts.join(' · ')})` : ''}`);
  if (s.problem) lines.push(`problema: ${s.problem}`);
  probe.runs.forEach((run, index) => {
    lines.push(`${index + 1}) ${run.label} — argv ${JSON.stringify(run.argv)} · cwd ${run.cwd} · ${seconds(run.durationMs)}`);
    const parts = [
      `PID ${run.pid ?? 'nenhum'}`,
      `estado ${run.state}`,
      `stdout ${run.stdoutBytes ? `${run.stdoutBytes} B "${run.stdoutFirstLine ?? ''}"` : 'nada'}`,
      `stderr ${run.stderrBytes ? `${run.stderrBytes} B "${run.stderrFirstLine ?? ''}"` : 'nada'}`,
      `saída ${run.exitCode !== null ? exitLabel(run.exitCode) : run.signal ?? 'nenhuma'}`,
    ];
    if (run.firstOutputAfterMs !== null) parts.push(`primeiro byte após ${seconds(run.firstOutputAfterMs)}`);
    if (run.errorCode) parts.push(`erro ${run.errorCode}`);
    if (run.error && !run.errorCode) parts.push(`erro "${run.error}"`);
    if (run.termination) parts.push(`encerramento: ${run.termination}`);
    lines.push(`   ${parts.join(' · ')}`);
    for (const note of run.notes) lines.push(`   nota: ${note}`);
    if (index === 0) {
      lines.push(`   ambiente: ${Object.entries(run.env).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    }
  });
  for (const c of probe.conclusions) lines.push(`conclusão: ${c}`);
  if (probe.environmentPolicy) {
    lines.push(`política: o Codex gerenciado roda sem ${probe.environmentPolicy.drop.join(', ')} no seu ambiente (${probe.environmentPolicy.reason})`);
  }
  return lines.join('\n');
}

function headline(probe: ExecutionProbe, os: string): string {
  const first = probe.runs[0];
  const pid = first?.pid ?? null;
  const took = first ? seconds(first.durationMs) : '';
  switch (probe.state) {
    case 'OK':
      return probe.antivirusDelaySuspected
        ? `O executável respondeu, mas a primeira execução demorou ${took}.`
        : `O executável respondeu (${probe.versionLine ?? ''}).`;
    case 'FILE_MISSING':
      return probe.static.exists
        ? `O executável sumiu entre a verificação e o início (quarentena do antivírus?).`
        : `O executável não está mais onde foi extraído (quarentena do antivírus?).`;
    case 'INVALID_EXECUTABLE':
      return `O arquivo extraído não é um executável válido para esta máquina: ${probe.static.problem ?? ''}.`;
    case 'FILE_LOCKED':
      return `Outro processo mantém o executável aberto (${first?.errorCode ?? probe.static.openError ?? 'EBUSY'}): antivírus ou uma extração ainda em curso.`;
    case 'ACCESS_DENIED':
      return `${os} recusou iniciar o executável (${first?.errorCode ?? 'EACCES'}): antivírus, política de aplicativos (Smart App Control, AppLocker) ou permissões da pasta.`;
    case 'SPAWN_FAILED':
      return `${os} não conseguiu criar o processo: ${first?.error ?? first?.errorCode ?? ''}.`;
    case 'PROCESS_STARTED_NO_OUTPUT':
      return `Codex foi baixado e verificado. ${os} iniciou o executável (PID ${pid ?? '?'}), mas ele permaneceu ativo sem produzir saída por ${took}.`;
    case 'PROCESS_STARTED_STDERR_ONLY':
      return `${os} iniciou o executável (PID ${pid ?? '?'}); ele escreveu só em stderr e não terminou em ${took}: "${first?.stderrFirstLine ?? ''}".`;
    case 'PROCESS_HUNG':
      return `O executável escreveu "${first?.stdoutFirstLine ?? ''}" mas não terminou em ${took}: algo mantém o processo ou os pipes vivos.`;
    case 'PROCESS_EXITED_NO_VERSION':
      return `O executável saiu com código 0 sem imprimir nenhuma versão.`;
    case 'PROCESS_EXITED_NONZERO':
      return `O executável saiu com código ${first?.exitCode ?? '?'} sem informar a versão${first?.stderrFirstLine ? `: "${first.stderrFirstLine}"` : ''}.`;
    case 'PROCESS_CRASHED':
      return `O executável iniciou e morreu com ${exitLabel(first?.exitCode ?? 0)}.`;
    case 'PROCESS_KILLED':
      return `O executável foi encerrado por fora (${first?.signal ?? first?.error ?? 'sinal'}) antes de responder.`;
    case 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE': {
      const cap = first?.capability;
      const asked = cap ? `${cap.requested[0]} ${cap.requested[1]}` : '?';
      const has = cap ? `${cap.found[0]} ${cap.found[1]}` : '?';
      return (
        `Esta versão do Codex não consegue iniciar neste computador com a variável de ambiente OPENSSL_ia32cap: ` +
        `a biblioteca criptográfica (AWS-LC) aborta ao iniciar porque a variável pede a capacidade ${asked} e a CPU informa ${has}. ` +
        `Não é o processador; é a variável.` +
        (probe.recovered ? ` Sem a variável, só no processo do Codex, o executável respondeu.` : '')
      );
    }
    default:
      return `O executável não respondeu.`;
  }
}

function exitLabel(code: number): string {
  const unsigned = code >>> 0;
  if (unsigned >= 0xc0000000) {
    const name = NTSTATUS_NAMES[unsigned];
    return `código 0x${unsigned.toString(16).toUpperCase()}${name ? ` (${name})` : ''}`;
  }
  return `código ${code}`;
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

/** True when the probe's own path could not run the file in any of its runs. */
export function probeFailedLocally(probe: ExecutionProbe): boolean {
  return !probe.recovered && probe.state !== 'OK' && isLocalExecutionFailure(probe.state);
}

