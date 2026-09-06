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

import type { ProcessManager } from '../core.js';

export interface CliCapabilities {
  /** Raw `--help` text, kept for the developer view. */
  readonly help: string;
  readonly flags: ReadonlySet<string>;
  readonly subcommands: ReadonlySet<string>;
}

const HELP_TIMEOUT_MS = 30_000;

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
  return parseHelp(help);
}

/**
 * Pulls long flags and subcommand names out of a `--help` page.
 *
 * Deliberately conservative: a token only counts as a subcommand when it is
 * indented on its own and followed by a description, which is how both CLIs (and
 * essentially every clap/commander program) lay out their command lists.
 */
export function parseHelp(help: string): CliCapabilities {
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
