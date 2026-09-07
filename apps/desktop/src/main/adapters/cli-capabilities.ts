/**
 * Capability detection for the agent CLIs.
 *
 * Both Codex and Claude Code change their flags between releases, and the
 * product pins a *tested* version rather than `latest` precisely because of
 * that. Even so, an adapter that hard-codes a flag is a time bomb: the rule
 * here is that we read `--help` from the binary we are about to run and use
 * only what it actually offers.
 *
 * When no non-interactive mode can be found we refuse with a message the user
 * can act on. We never guess a flag: a wrong flag either fails loudly or, far
 * worse, silently means something else.
 */

import type { ProcessManager, ProcessResult } from '../core.js';

/**
 * Why a help page could not be read, or that it was.
 *
 * The distinction this product paid for: a probe that never ran is not the
 * same fact as a CLI that has no headless mode. Conflating them told a person
 * whose Codex is perfectly capable that "esta versão não oferece um modo não
 * interativo" - and sent them looking for a different Codex instead of the
 * environment variable that was killing the one they had.
 */
export type ProbeState =
  | 'OK'
  /** `spawn` failed: no such file, or the OS refused to create the process. */
  | 'EXECUTABLE_NOT_FOUND'
  /** The child was still running when the probe's deadline passed. */
  | 'PROBE_TIMEOUT'
  /** The probe was cancelled from outside. */
  | 'PROCESS_ABORTED'
  /** The child died before it could print a help page (signal, or a crash code). */
  | 'EXECUTABLE_INCOMPATIBLE'
  /** The child ran and failed: a non-zero exit with output we did not expect. */
  | 'PROBE_FAILED'
  /** The child exited cleanly and printed something no help parser recognises. */
  | 'PARSER_FAILED';

/** What one `--help` invocation actually did, for the record and the message. */
export interface CliProbe {
  readonly state: ProbeState;
  /** The arguments the probe used, so a log names the exact invocation. */
  readonly args: readonly string[];
  readonly outcome: ProcessResult['outcome'];
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** First non-empty stderr line: where a start-up abort announces itself. */
  readonly stderrFirstLine: string | null;
  /** A recognised failure signature, when the output carries one. */
  readonly detail: string | null;
}

export interface CliCapabilities {
  /** Raw `--help` text, kept for the developer view. */
  readonly help: string;
  readonly flags: ReadonlySet<string>;
  readonly subcommands: ReadonlySet<string>;
  /** How the reading went. `state === 'OK'` is the only case flags can be trusted. */
  readonly probe: CliProbe;
}

const HELP_TIMEOUT_MS = 30_000;

/**
 * Windows exit codes that are a crash, not a program's own choice.
 *
 * 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) is what `abort()` produces on
 * Windows - the exact code the AWS-LC start-up abort inside Codex 0.105+
 * reports when OPENSSL_ia32cap asks for a CPU bit the processor lacks.
 */
const WINDOWS_CRASH_EXIT_CODES = new Map<number, string>([
  [0xc0000409, 'o processo foi encerrado pelo sistema (0xC0000409)'],
  [0xc0000005, 'violação de acesso (0xC0000005)'],
  [0xc000001d, 'instrução ilegal (0xC000001D)'],
  [0xc0000135, 'uma biblioteca necessária não foi encontrada (0xC0000135)'],
  [0xc0000142, 'a inicialização da aplicação falhou (0xC0000142)'],
]);

/** Failure signatures worth naming, because the remedy differs for each. */
const SIGNATURES: readonly { readonly pattern: RegExp; readonly detail: string }[] = [
  {
    pattern: /HW capability found[\s\S]*?HW capability requested/i,
    detail:
      'a biblioteca criptográfica dentro do executável abortou por causa de OPENSSL_ia32cap no ambiente',
  },
  { pattern: /is not recognized as an internal or external command/i, detail: 'o executável não foi encontrado' },
  { pattern: /Permission denied|EACCES/i, detail: 'o sistema recusou a execução do arquivo' },
];

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function signatureOf(output: string): string | null {
  for (const { pattern, detail } of SIGNATURES) {
    if (pattern.test(output)) return detail;
  }
  return null;
}

/**
 * Classifies one probe run.
 *
 * `parsed` matters only for a clean exit: a CLI that ran, exited 0 and printed
 * a page with neither a flag nor a subcommand on it did not tell us it has no
 * headless mode - it told us this parser did not understand the page.
 */
export function classifyProbe(
  args: readonly string[],
  result: ProcessResult,
  parsed: { flags: ReadonlySet<string>; subcommands: ReadonlySet<string> },
): CliProbe {
  const combined = `${result.stdout}\n${result.stderr}`;
  const base = {
    args: [...args],
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: (result.signal as string | null) ?? null,
    stderrFirstLine: firstNonEmptyLine(result.stderr),
    detail: signatureOf(combined),
  };

  if (result.outcome === 'spawn-error') {
    return { ...base, state: 'EXECUTABLE_NOT_FOUND', detail: base.detail ?? result.error ?? null };
  }
  if (result.outcome === 'timeout') return { ...base, state: 'PROBE_TIMEOUT' };
  if (result.outcome === 'cancelled') return { ...base, state: 'PROCESS_ABORTED' };

  if (result.signal) return { ...base, state: 'EXECUTABLE_INCOMPATIBLE' };
  if (result.exitCode !== null && result.exitCode !== 0) {
    const crash = WINDOWS_CRASH_EXIT_CODES.get(result.exitCode >>> 0);
    if (crash) return { ...base, state: 'EXECUTABLE_INCOMPATIBLE', detail: base.detail ?? crash };
    // 134 is SIGABRT seen through a shell wrapper; the same abort, one layer on.
    if (result.exitCode === 134) {
      return { ...base, state: 'EXECUTABLE_INCOMPATIBLE', detail: base.detail ?? 'o processo abortou (SIGABRT)' };
    }
    // A help page printed on a non-zero exit is still a help page: some CLIs
    // exit 1 for `--help`. Only an unreadable one is a failure.
    if (parsed.flags.size > 0 || parsed.subcommands.size > 0) return { ...base, state: 'OK' };
    return { ...base, state: 'PROBE_FAILED' };
  }

  if (parsed.flags.size === 0 && parsed.subcommands.size === 0) {
    return { ...base, state: 'PARSER_FAILED' };
  }
  return { ...base, state: 'OK' };
}

export async function readCapabilities(
  processManager: ProcessManager,
  executable: string,
  cwd: string,
  args: readonly string[] = ['--help'],
  env?: Record<string, string | undefined>,
): Promise<CliCapabilities> {
  const result = await processManager.run({
    command: executable,
    args: [...args],
    cwd,
    timeoutMs: HELP_TIMEOUT_MS,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  });
  const help = `${result.stdout}\n${result.stderr}`;
  const parsed = parseHelp(help);
  return { ...parsed, probe: classifyProbe(args, result, parsed) };
}

/** A one-line, redaction-safe summary of a probe, for logs and error messages. */
export function describeProbe(probe: CliProbe): string {
  const parts = [`estado=${probe.state}`, `argumentos=${probe.args.join(' ') || '(nenhum)'}`];
  parts.push(`saída=${probe.outcome}`);
  if (probe.exitCode !== null) parts.push(`código=${probe.exitCode}`);
  if (probe.signal) parts.push(`sinal=${probe.signal}`);
  if (probe.detail) parts.push(`causa=${probe.detail}`);
  if (probe.stderrFirstLine) parts.push(`stderr=${probe.stderrFirstLine.slice(0, 200)}`);
  return parts.join('; ');
}

/**
 * Pulls long flags and subcommand names out of a `--help` page.
 *
 * Deliberately conservative: a token only counts as a subcommand when it is
 * indented on its own and followed by a description, which is how both CLIs (and
 * essentially every clap/commander program) lay out their command lists.
 */
export function parseHelp(help: string): Omit<CliCapabilities, 'probe'> {
  const flags = new Set<string>();
  for (const match of help.matchAll(/(--[a-z0-9][a-z0-9-]*)/gi)) {
    flags.add(match[1]!.toLowerCase());
  }

  const subcommands = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    const match = /^\s{2,}([a-z][a-z0-9-]{1,30})(?:\s{2,}\S|\s*$)/.exec(line);
    if (match && !line.trimStart().startsWith('-')) subcommands.add(match[1]!.toLowerCase());
  }

  return { help, flags, subcommands };
}

/**
 * The description a help page gives one option, joined into one line.
 *
 * commander prints `  --model <x>  description...` and wraps the description
 * on deeper-indented lines; clap prints the description on its own indented
 * lines, with `[possible values: ...]` after a blank one. In both, the
 * description ends at the next line that is indented as shallowly as the
 * option itself (the next option, or a section heading).
 */
export function optionDescription(help: string, flag: string): string | null {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*(?:-\\w,\\s*)?${flag}\\b`).test(line));
  if (start < 0) return null;
  const indent = /^\s*/.exec(lines[start]!)![0].length;
  const parts = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') continue;
    if (/^\s*/.exec(line)![0].length <= indent) break;
    parts.push(line);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The values a help page lists for one option, when it lists any.
 *
 * Reads the two shapes the CLIs print: `(low, medium, high)` after the
 * description (Claude Code) and `[possible values: a, b, c]` (clap). Null
 * when the page does not enumerate values - which is not "no values".
 */
export function optionValues(help: string, flag: string): string[] | null {
  const description = optionDescription(help, flag);
  if (!description) return null;
  const possible = /\[possible values:\s*([^\]]+)\]/i.exec(description);
  const listed = possible?.[1] ?? /\(([a-z0-9_-]+(?:\s*,\s*[a-z0-9_-]+)+)\)/i.exec(description)?.[1];
  if (!listed) return null;
  const values = listed
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9_-]+$/.test(value));
  return values.length > 0 ? values : null;
}

/**
 * Model aliases a help page names for `--model`, from its quoted examples
 * (`'fable', 'opus', or 'sonnet'`). Null when the page names none.
 */
export function modelAliases(help: string): string[] | null {
  const description = optionDescription(help, '--model');
  if (!description) return null;
  const aliases = [...description.matchAll(/'([a-z][a-z0-9-]{1,30})'/g)]
    .map((match) => match[1]!)
    .filter((alias) => !alias.startsWith('claude-'));
  return aliases.length > 0 ? [...new Set(aliases)] : null;
}
