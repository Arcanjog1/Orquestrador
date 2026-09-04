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
): Promise<CliCapabilities> {
  const result = await processManager.run({
    command: executable,
    args: [...args],
    cwd,
    timeoutMs: HELP_TIMEOUT_MS,
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
